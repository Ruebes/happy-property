// Baut eine iCalendar-Datei (.ics), damit der Kunde den Termin mit einem Klick in
// seinen eigenen Kalender übernehmen kann — inkl. Zoom-Link (URL + LOCATION), damit
// er direkt aus dem Kalendereintrag beitreten kann.

export function toB64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function buildIcs(o: {
  uid: string
  title: string
  startIso: string
  endIso: string
  description?: string
  location?: string
  url?: string
}): string {
  const dt  = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Happy Property//CRM//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${o.uid}@happy-property.com`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(o.startIso)}`,
    `DTEND:${dt(o.endIso)}`,
    `SUMMARY:${esc(o.title)}`,
  ]
  if (o.description) lines.push(`DESCRIPTION:${esc(o.description)}`)
  if (o.location)    lines.push(`LOCATION:${esc(o.location)}`)
  if (o.url)         lines.push(`URL:${esc(o.url)}`)
  lines.push('ORGANIZER;CN=Sven Rüprich:mailto:sven@happy-property.com', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}
