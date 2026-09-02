// Persönlicher Terminlink eines Leads — ersetzt die früheren Calendly-Links
// in den WhatsApp-/Mail-Automationen ({{termin_buchen}} / {{buchungs_link}}).
//
// /termin?direkt=1&b=<leads.booking_token> überspringt Fragebogen UND
// Kontaktformular: funnel-api löst den Lead über den Token auf, der Kunde
// landet direkt bei Terminart → Kalender. Ohne Token (sollte nicht vorkommen)
// der neutrale Weg ohne Fragebogen, bei dem der Kunde seine Daten selbst eingibt.
export const PORTAL_URL = 'https://portal.happy-property.com'

export function bookingUrl(token?: string | null): string {
  const t = (token ?? '').trim()
  return t ? `${PORTAL_URL}/termin?direkt=1&b=${t}` : `${PORTAL_URL}/termin?f=none`
}
