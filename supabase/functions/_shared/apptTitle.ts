// Termin-Titel mit Zaehlung: das erste Gespraech eines Kunden heisst
// „Erstgespräch", danach „1. Folgetermin", „2. Folgetermin", …
//
// Genutzt von funnel-api (/termin) und booking-bot — beide Buchungswege muessen
// gleich zaehlen, sonst haengt der Titel davon ab, wo der Kunde gebucht hat.
//
// Zaehlbasis: fruehere Kundentermine des Leads (interne Termine und Tagessperren
// zaehlen nicht). No-Shows zaehlen ebenfalls nicht — dort hat kein Gespraech
// stattgefunden, der nachgeholte Termin ist also weiterhin das Erstgespraech.
// Abgesagte Termine werden im System geloescht und fallen damit von selbst raus.

type Rows = { data: Array<Record<string, unknown>> | null }
export interface Db {
  from(table: string): { select(columns: string): {
    eq(c: string, v: string | boolean): {
      eq(c: string, v: string | boolean): {
        or(f: string): { lt(c: string, v: string): PromiseLike<Rows> }
      }
    }
  } }
}

export async function nextApptTitle(admin: Db, leadId: string, firstName: string, startIso: string): Promise<string> {
  const name = (firstName || '').trim() || 'Kunde'
  try {
    const { data } = await admin.from('crm_appointments').select('id')
      .eq('lead_id', leadId).eq('internal', false)
      // NULL beachten: outcome <> 'no_show' liesse unbewertete Termine rausfallen.
      .or('outcome.is.null,outcome.neq.no_show')
      .lt('start_time', startIso)
    const prior = (data ?? []).length
    if (prior === 0) return `Erstgespräch – ${name}`
    return `${prior}. Folgetermin – ${name}`
  } catch (err) {
    // Lieber ein generischer Titel als eine geplatzte Buchung.
    console.warn('[apptTitle] Zaehlung fehlgeschlagen:', err)
    return `Beratungsgespräch – ${name}`
  }
}
