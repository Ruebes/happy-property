// Zeitzonen-Helfer für Termine. start_time/end_time sind UTC; die Termin-Zone sagt nur,
// in welcher Zone Sven die Uhrzeit eingegeben hat und der Kunde sie sehen soll.
export type ApptTz = 'Europe/Berlin' | 'Asia/Nicosia'

export const APPT_TZ_BERLIN: ApptTz  = 'Europe/Berlin'
export const APPT_TZ_NICOSIA: ApptTz = 'Asia/Nicosia'

// Alte Regel (Termine ohne gespeicherte Zone): vor Ort = Zypern, sonst Deutschland.
export function defaultApptTz(type: string | null | undefined): ApptTz {
  return type === 'inperson' ? APPT_TZ_NICOSIA : APPT_TZ_BERLIN
}

export function apptTzOf(appt: { timezone?: string | null; type?: string | null } | null | undefined): ApptTz {
  const tz = appt?.timezone
  if (tz === APPT_TZ_BERLIN || tz === APPT_TZ_NICOSIA) return tz
  return defaultApptTz(appt?.type)
}

// Offset (ms) einer Zone zu UTC an einem bestimmten Zeitpunkt (DST-sicher).
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const m: Record<string, number> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value)
  const asUtc = Date.UTC(m.year, m.month - 1, m.day, m.hour % 24, m.minute, m.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

// Datum (YYYY-MM-DD) + Uhrzeit (HH:MM) in Zone → UTC-ISO. Zwei Durchläufe wegen DST-Wechsel.
export function zonedToIso(date: string, time: string, tz: string): string {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi]    = time.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  let utc = guess - tzOffsetMs(guess, tz)
  utc = guess - tzOffsetMs(utc, tz)
  return new Date(utc).toISOString()
}

// UTC-ISO → { date: 'YYYY-MM-DD', time: 'HH:MM' } in Zone (für Formular-Vorbelegung).
export function isoToZoned(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso))
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  return { date: `${m.year}-${m.month}-${m.day}`, time: `${m.hour === '24' ? '00' : m.hour}:${m.minute}` }
}

// Uhrzeit HH:MM in Zone (Anzeige).
export function fmtTimeIn(iso: string, tz: string, locale = 'de-DE'): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso))
}
