// Termin-Titel mit Zaehlung: das erste Gespraech eines Kunden heisst
// „Erstgespräch", danach „1. Folgetermin", „2. Folgetermin", …
//
// Genutzt von funnel-api (/termin) und booking-bot — beide Buchungswege muessen
// gleich zaehlen, sonst haengt der Titel davon ab, wo der Kunde gebucht hat.
// Beide nutzen den jsr-Client, deshalb kann hier der echte Typ stehen (anders
// als in internalContact.ts, wo esm.sh- und jsr-Clients zusammenkommen).
//
// Zaehlbasis: fruehere Kundentermine des Leads (interne Termine und Tagessperren
// zaehlen nicht — beide tragen internal=true). No-Shows zaehlen ebenfalls nicht:
// dort hat kein Gespraech stattgefunden, der nachgeholte Termin ist weiterhin
// das Erstgespraech. Abgesagte Termine werden geloescht und fallen von selbst raus.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export async function nextApptTitle(admin: SupabaseClient, leadId: string, firstName: string, startIso: string): Promise<string> {
  const name = (firstName || '').trim() || 'Kunde'
  try {
    const { data, error } = await admin.from('crm_appointments').select('id')
      .eq('lead_id', leadId).eq('internal', false)
      // NULL beachten: outcome <> 'no_show' liesse unbewertete Termine rausfallen.
      .or('outcome.is.null,outcome.neq.no_show')
      .lt('start_time', startIso)
    // error explizit pruefen: supabase-js WIRFT bei Query-/Netzwerkfehlern nicht,
    // sondern liefert { data: null, error }. Ohne diese Pruefung wuerde ein
    // Datenbank-Schluckauf als "0 fruehere Termine" gelesen — und ein Folgetermin
    // hiesse faelschlich Erstgespraech.
    if (error) {
      console.warn('[apptTitle] Zaehlung fehlgeschlagen:', error.message)
      return `Beratungsgespräch – ${name}`
    }
    const prior = (data ?? []).length
    if (prior === 0) return `Erstgespräch – ${name}`
    return `${prior}. Folgetermin – ${name}`
  } catch (err) {
    // Lieber ein generischer Titel als eine geplatzte Buchung.
    console.warn('[apptTitle] Zaehlung fehlgeschlagen:', err)
    return `Beratungsgespräch – ${name}`
  }
}
