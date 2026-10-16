// Persoenliche Versandzeit (Send-Time-Optimierung) fuer HTML-Newsletter.
// Reine Funktionen ohne DB-Zugriff, damit sie sich lokal testen lassen.
//
// Regel (16.10.2026):
//  - Je Empfaenger die letzten bis zu 4 HTML-Newsletter, die er bekommen hat.
//    Erste echte Oeffnung = frueheste Oeffnung mehr als 60 s nach Versand
//    (schneller = Scanner bzw. Apple-Privacy-Vorabruf, zaehlt nicht).
//  - Muster: mind. 2 echte Erstoeffnungen, ALLE spaeter als 12 h nach Versand,
//    und alle liegen innerhalb von 30 h, gemessen als "Stunden seit Montag
//    00:00 Berlin" (mit Ueberlauf Sonntag -> Montag).
//  - Wunschzeit = frueheste dieser Oeffnungen minus 2 h, aber nicht vor 07:00
//    desselben Tages.

export const TZ_BERLIN = 'Europe/Berlin'
export const WEEK_H = 168
const SCANNER_SEC = 60
const LATE_MS = 12 * 3600e3
const SPAN_H = 30
const LEAD_H = 2
const EARLIEST_H = 7
export const MAX_AHEAD_H = 72

const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
const WD_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ_BERLIN, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// Stunden seit Montag 00:00 (Berlin), mit Minutenanteil, 0 <= x < 168
export function berlinWeekHour(d: Date): number {
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]))
  return WD[p.weekday] * 24 + Number(p.hour) + Number(p.minute) / 60
}

export function weekHourLabel(wh: number): string {
  const w = ((wh % WEEK_H) + WEEK_H) % WEEK_H
  return `${WD_DE[Math.floor(w / 24)]} ${String(Math.floor(w % 24)).padStart(2, '0')}`
}

// Erste echte Oeffnung (> 60 s nach Versand) oder null
export function firstRealOpen(sentAt: number, opens: number[]): number | null {
  let best: number | null = null
  for (const o of opens) if (o > sentAt + SCANNER_SEC * 1000 && (best === null || o < best)) best = o
  return best
}

export interface SendSample { sentAt: number; opens: number[] }

// Liefert die bevorzugte Wochenstunde (0..168) oder null (kein Muster)
export function detectSendPattern(samples: SendSample[]): number | null {
  const hits: Array<{ sentAt: number; open: number }> = []
  for (const s of samples) {
    const o = firstRealOpen(s.sentAt, s.opens)
    if (o !== null) hits.push({ sentAt: s.sentAt, open: o })
  }
  if (hits.length < 2) return null
  if (hits.some(h => h.open - h.sentAt <= LATE_MS)) return null
  const w = hits.map(h => berlinWeekHour(new Date(h.open))).sort((a, b) => a - b)
  // Kleinste Spanne auf dem Wochenkreis = 168 - groesste Luecke; Start ist der
  // Punkt direkt nach der groessten Luecke.
  let maxGap = w[0] + WEEK_H - w[w.length - 1], startIdx = 0
  for (let i = 1; i < w.length; i++) {
    const g = w[i] - w[i - 1]
    if (g > maxGap) { maxGap = g; startIdx = i }
  }
  if (WEEK_H - maxGap > SPAN_H) return null
  const earliest = w[startIdx]
  const dayStart = Math.floor(earliest / 24) * 24
  return Math.max(earliest - LEAD_H, dayStart + EARLIEST_H)
}

// Naechster Zeitpunkt mit dieser Wochenstunde ab `from`, hoechstens 72 h spaeter
export function nextOccurrence(from: number, weekHour: number): Date | null {
  const diffH = ((weekHour - berlinWeekHour(new Date(from))) % WEEK_H + WEEK_H) % WEEK_H
  if (diffH > MAX_AHEAD_H) return null
  let t = from + diffH * 3600e3
  // Sommer-/Winterzeit-Wechsel dazwischen: um die Abweichung korrigieren
  let drift = berlinWeekHour(new Date(t)) - weekHour
  if (drift > WEEK_H / 2) drift -= WEEK_H
  if (drift < -WEEK_H / 2) drift += WEEK_H
  if (Math.abs(drift) > 1e-6 && Math.abs(drift) <= 1.5) t -= drift * 3600e3
  if (t < from) t = from
  if (t - from > MAX_AHEAD_H * 3600e3) return null
  return new Date(t)
}

// Deterministische 50/50-Teilung (FNV-1a) fuer den A/B-Vergleich
export function abGroup(personKey: string, campaignId: string): 'personal' | 'holdout' {
  let h = 0x811c9dc5
  const s = `${personKey}|${campaignId}`
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return (h & 1) === 0 ? 'personal' : 'holdout'
}

// Globale Slot-Buchung fuer Mails: kein Mailslot naeher als stepSec an einem
// anderen (IONOS nimmt nur ~50 Mails/Stunde).
export class SlotBook {
  private t: number[] = []
  constructor(private stepSec: number, private jitterSec: number, private clamp: (d: Date) => Date) {}
  private conflict(x: number): number | null {
    const gap = this.stepSec * 1000
    let lo = 0, hi = this.t.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[m] < x) lo = m + 1; else hi = m }
    // Kandidaten: Vorgaenger und Nachfolger(n) im Abstand < gap
    let worst: number | null = null
    if (lo > 0 && x - this.t[lo - 1] < gap) worst = this.t[lo - 1]
    for (let i = lo; i < this.t.length && this.t[i] - x < gap; i++) worst = this.t[i]
    return worst
  }
  take(target: Date): Date {
    let x = this.clamp(target).getTime()
    for (let guard = 0; guard < 100000; guard++) {
      const c = this.conflict(x)
      if (c === null) break
      x = this.clamp(new Date(c + (this.stepSec + Math.floor(Math.random() * this.jitterSec)) * 1000)).getTime()
    }
    let lo = 0, hi = this.t.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[m] < x) lo = m + 1; else hi = m }
    this.t.splice(lo, 0, x)
    return new Date(x)
  }
  // Normaler Takt, der bereits gebuchte (persoenliche) Slots ueberspringt
  pacer(base: number): () => Date {
    let cursor = base
    return () => {
      const slot = this.take(new Date(cursor))
      cursor = slot.getTime() + (this.stepSec + Math.floor(Math.random() * this.jitterSec)) * 1000
      return slot
    }
  }
}
