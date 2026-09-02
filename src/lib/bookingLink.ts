// Persönlicher Terminlink eines Leads (Frontend-Pendant zu
// supabase/functions/_shared/bookingLink.ts).
//
// /termin?direkt=1&b=<leads.booking_token> überspringt Fragebogen UND
// Kontaktformular — der Kunde ist über den Token bereits bekannt und landet
// direkt bei Terminart → Kalender. Ersetzt die alten Calendly-Links.
export const PORTAL_URL = 'https://portal.happy-property.com'

export function bookingUrl(token?: string | null): string {
  const t = (token ?? '').trim()
  return t ? `${PORTAL_URL}/termin?direkt=1&b=${t}` : `${PORTAL_URL}/termin?f=none`
}
