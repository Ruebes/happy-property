// Ruhezeit für automatische Kunden-Nachrichten (Sven, 30.10.2026).
//
// Zwischen 21:00 und 08:00 Uhr Empfängerzeit geht nichts automatisch raus. Was in
// diese Zeit fällt, rückt auf etwa 09:00 Uhr am nächsten Morgen. Anlass: Der
// Video-Nachfass "Deshalb lohnt sich Zypern jetzt" (Erstkontakt +1 Tag) kam am
// 30.10. um 02:55 Uhr deutscher Zeit beim Kunden an, weil die Regel stumpf
// Anlagezeit + 24 h plant.
//
// Die Empfängerzeit kommt aus der Vorwahl der Handynummer. Ohne eindeutige
// Vorwahl gilt Europe/Berlin (fast alle Leads sind aus DE, AT oder CH).

export const RUHE_AB = 21   // ab 21:00 Uhr nichts mehr
export const RUHE_BIS = 8   // vor 08:00 Uhr nichts
export const MORGENS = 9    // Verschobenes geht ab 09:00 Uhr raus

const STANDARD_ZONE = 'Europe/Berlin'

// Vorwahlen, deren Uhrzeit von Deutschland abweicht (längere Vorwahl vor kürzerer).
const VORWAHL_ZONE: Array<[string, string]> = [
  ['357', 'Asia/Nicosia'],
  ['971', 'Asia/Dubai'],
  ['974', 'Asia/Qatar'],
  ['972', 'Asia/Jerusalem'],
  ['353', 'Europe/Dublin'],
  ['351', 'Europe/Lisbon'],
  ['44', 'Europe/London'],
  ['30', 'Europe/Athens'],
  ['90', 'Europe/Istanbul'],
]

// Zeitzone des Empfängers aus seiner Nummer. Nur eindeutig internationale
// Schreibweisen (+ oder 00) zählen, "0176 ..." ist eine deutsche Nummer.
export function zeitzoneFuer(telefon?: string | null): string {
  const roh = String(telefon ?? '').replace(/[\s()./-]/g, '')
  const ziffern = roh.startsWith('+') ? roh.slice(1) : roh.startsWith('00') ? roh.slice(2) : ''
  for (const [vorwahl, zone] of VORWAHL_ZONE) if (ziffern.startsWith(vorwahl)) return zone
  return STANDARD_ZONE
}

// Wanduhr (Jahr, Monat, Tag, Stunde ...) eines Zeitpunkts in einer Zeitzone.
function wanduhr(t: Date, zone: string) {
  const p: Record<string, string> = {}
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  for (const x of fmt.formatToParts(t)) p[x.type] = x.value
  return { jahr: +p.year, monat: +p.month, tag: +p.day, stunde: +p.hour % 24, minute: +p.minute, sekunde: +p.second }
}

// Zeitpunkt zu einer Wanduhrzeit (volle Stunde) in einer Zeitzone. Zwei Runden,
// damit ein Sommerzeit-Wechsel zwischen Schätzung und Ergebnis nicht stört.
function zeitpunkt(jahr: number, monat: number, tag: number, stunde: number, zone: string): Date {
  const soll = Date.UTC(jahr, monat - 1, tag, stunde)
  let utc = soll
  for (let i = 0; i < 2; i++) {
    const w = wanduhr(new Date(utc), zone)
    utc += soll - Date.UTC(w.jahr, w.monat - 1, w.tag, w.stunde, w.minute, w.sekunde)
  }
  return new Date(utc)
}

export function inRuhezeit(t: Date, zone = STANDARD_ZONE): boolean {
  const h = wanduhr(t, zone).stunde
  return h >= RUHE_AB || h < RUHE_BIS
}

// Die Nacht (11 Stunden) wird auf 30 Minuten ab 09:00 Uhr gestaucht.
const VERSATZ_MAX_MS = 30 * 60_000
const STAUCHUNG = ((24 - RUHE_AB + RUHE_BIS) * 3600_000) / VERSATZ_MAX_MS

// Neue Sendezeit, wenn `jetzt` in der Ruhezeit liegt, sonst null. Ziel ist 09:00
// Uhr am Morgen nach dieser Nacht. Die ursprüngliche Sollzeit `soll` gibt einen
// Versatz bis 30 Minuten: Mehrteilige Nachrichten behalten so ihre Reihenfolge
// (der Versand sortiert nach scheduled_at), und nicht alles geht in derselben
// Minute raus. Beim Planen ist `jetzt` = `soll` = die geplante Zeit.
export function ruhezeitZiel(jetzt: Date, soll: Date = jetzt, zone = STANDARD_ZONE): Date | null {
  const w = wanduhr(jetzt, zone)
  if (w.stunde < RUHE_AB && w.stunde >= RUHE_BIS) return null
  // Nach 21 Uhr ist der Morgen morgen, vor 8 Uhr ist er heute.
  const morgenTag = new Date(Date.UTC(w.jahr, w.monat - 1, w.tag + (w.stunde >= RUHE_AB ? 1 : 0)))
  const vortag = new Date(morgenTag.getTime() - 86_400_000)
  const morgen = zeitpunkt(morgenTag.getUTCFullYear(), morgenTag.getUTCMonth() + 1, morgenTag.getUTCDate(), MORGENS, zone)
  const nachtBeginn = zeitpunkt(vortag.getUTCFullYear(), vortag.getUTCMonth() + 1, vortag.getUTCDate(), RUHE_AB, zone)
  const versatz = Math.max(-VERSATZ_MAX_MS, Math.min(VERSATZ_MAX_MS, (soll.getTime() - nachtBeginn.getTime()) / STAUCHUNG))
  return new Date(morgen.getTime() + Math.round(versatz))
}

// Uhrzeit in der Empfängerzone, z. B. "02:55", für Hinweise am Datensatz.
export function uhrzeit(t: Date, zone = STANDARD_ZONE): string {
  const w = wanduhr(t, zone)
  return `${String(w.stunde).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
}
