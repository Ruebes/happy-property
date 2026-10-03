import type { Etikett } from './spalten'
import type { Vergleich, ZeitraumWahl } from './typen'

// ── Zeiträume der Zentrale (wie das Datums-Menü bei Meta) ────────────────────
// Tage als YYYY-MM-DD in Ortszeit des Browsers. 'kopf' = der Zeitraum oben im
// Werbemanager (7/30/90 Tage, Zahlen aus der Datenbank).

const pad = (n: number) => String(n).padStart(2, '0')
export const isoTag = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const tagMinus = (n: number, von = new Date()): string => { const d = new Date(von); d.setDate(d.getDate() - n); return isoTag(d) }

export const ZEITRAUM_VORGABEN: Array<{ id: string; label: Etikett }> = [
  { id: 'heute', label: { k: 'crm.werbung.zentrale.zeit.heute', d: 'Heute' } },
  { id: 'gestern', label: { k: 'crm.werbung.zentrale.zeit.gestern', d: 'Gestern' } },
  { id: 'letzte_7', label: { k: 'crm.werbung.zentrale.zeit.letzte7', d: 'Letzte 7 Tage' } },
  { id: 'letzte_14', label: { k: 'crm.werbung.zentrale.zeit.letzte14', d: 'Letzte 14 Tage' } },
  { id: 'letzte_30', label: { k: 'crm.werbung.zentrale.zeit.letzte30', d: 'Letzte 30 Tage' } },
  { id: 'dieser_monat', label: { k: 'crm.werbung.zentrale.zeit.dieserMonat', d: 'Dieser Monat' } },
  { id: 'letzter_monat', label: { k: 'crm.werbung.zentrale.zeit.letzterMonat', d: 'Letzter Monat' } },
  { id: 'eigen', label: { k: 'crm.werbung.zentrale.zeit.eigen', d: 'Benutzerdefiniert' } },
]

/** Von-bis einer Vorgabe ('eigen' liefert null: Eingabefelder nutzen) */
export function vorgabeZeitraum(id: string): { since: string; until: string } | null {
  const heute = new Date()
  switch (id) {
    case 'heute': return { since: isoTag(heute), until: isoTag(heute) }
    case 'gestern': return { since: tagMinus(1), until: tagMinus(1) }
    case 'letzte_7': return { since: tagMinus(7), until: tagMinus(1) }
    case 'letzte_14': return { since: tagMinus(14), until: tagMinus(1) }
    case 'letzte_30': return { since: tagMinus(30), until: tagMinus(1) }
    case 'dieser_monat': return { since: isoTag(new Date(heute.getFullYear(), heute.getMonth(), 1)), until: isoTag(heute) }
    case 'letzter_monat': {
      const start = new Date(heute.getFullYear(), heute.getMonth() - 1, 1)
      const ende = new Date(heute.getFullYear(), heute.getMonth(), 0)
      return { since: isoTag(start), until: isoTag(ende) }
    }
    default: return null
  }
}

/** Von-bis des Kopf-Zeitraums (gleich wie useWerbeDaten: seit heute minus n Tage, bis heute) */
export function kopfZeitraum(tage: number): { since: string; until: string } {
  return { since: new Date(Date.now() - tage * 86_400_000).toISOString().slice(0, 10), until: isoTag(new Date()) }
}

export function aktuellerZeitraum(z: ZeitraumWahl, tage: number): { since: string; until: string } {
  return z.art === 'kopf' ? kopfZeitraum(tage) : { since: z.since, until: z.until }
}

/** Zeitraum gleicher Länge direkt davor */
export function vorherigerZeitraum(since: string, until: string): { since: string; until: string } {
  const s = new Date(`${since}T12:00:00`)
  const u = new Date(`${until}T12:00:00`)
  const tage = Math.max(1, Math.round((u.getTime() - s.getTime()) / 86_400_000) + 1)
  const neuBis = new Date(s); neuBis.setDate(neuBis.getDate() - 1)
  const neuVon = new Date(neuBis); neuVon.setDate(neuVon.getDate() - (tage - 1))
  return { since: isoTag(neuVon), until: isoTag(neuBis) }
}

/** Gültiger Zeitraum? (von <= bis, beide gesetzt, nicht in der Zukunft) */
export function zeitraumOk(since: string, until: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return false
  return since <= until && until <= isoTag(new Date())
}

/** Tatsächlicher Vergleichszeitraum (automatisch = direkt davor, folgt dem Zeitraum) */
export function effektiverVergleich(v: Vergleich, b: { since: string; until: string }): { since: string; until: string } | null {
  if (!v.an) return null
  return v.automatisch ? vorherigerZeitraum(b.since, b.until) : { since: v.since, until: v.until }
}

export const VERGLEICH_AUS: Vergleich = { an: false, since: '', until: '', automatisch: true }

/** Kurzer Text „01.09. - 30.09." für Hinweise */
export function zeitraumText(since: string, until: string, locale: string): string {
  const f = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' })
  return since === until ? f(since) : `${f(since)} - ${f(until)}`
}
