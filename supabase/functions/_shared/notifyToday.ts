// Sven per WhatsApp benachrichtigen — ABER NUR, wenn es den HEUTIGEN Tag betrifft.
//
// Sven: „Wenn ein Kunde am gleichen Tag einen Termin bucht oder sich am aktuellen
// Tag etwas ändert, also auch Stornos oder Verlegungen, möchte ich darüber per
// WhatsApp informiert werden. Andere Benachrichtigungen, wenn es um folgende Tage
// geht, brauche ich nicht."
//
// Begruendung fuer die Regel: bei einer Aenderung am heutigen Tag muss er sofort
// reagieren koennen; alles Spaetere sieht er ohnehin im Kalender.
//
// „Heute" = Kalendertag in Svens Zeitzone (Zypern), nicht UTC und nicht Berlin.
// Bei einer Verlegung zaehlen BEIDE Daten: wird ein heutiger Termin weggeschoben,
// wird eine Stunde frei; wird ein Termin auf heute gezogen, kommt eine dazu.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const TZ = 'Asia/Nicosia'

/** Kalendertag in Svens Zeitzone als YYYY-MM-DD. */
export function cyDate(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  // en-CA liefert genau YYYY-MM-DD.
  return dt.toLocaleDateString('en-CA', { timeZone: TZ })
}

export function isTodayCy(iso: string): boolean {
  return cyDate(iso) === cyDate(new Date())
}

/** Uhrzeit in Svens Zeitzone, z.B. „14:30". */
export function cyTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
}

async function recipientPhone(admin: SupabaseClient): Promise<string> {
  // Erst die einstellbare Nummer, sonst das Admin-Profil. Kein hartkodierter
  // Fallback: lieber gar nicht senden als an eine falsche Nummer.
  try {
    const { data: s } = await admin.from('crm_settings').select('value').eq('key', 'notify_whatsapp').maybeSingle()
    const v = ((s as { value?: string } | null)?.value ?? '').trim()
    if (v) return v
  } catch { /* weiter zum Profil */ }
  try {
    const { data: p } = await admin.from('profiles').select('phone').eq('role', 'admin')
      .not('phone', 'is', null).limit(1).maybeSingle()
    return (((p as { phone?: string } | null)?.phone) ?? '').trim()
  } catch { return '' }
}

/**
 * Schickt die Nachricht NUR, wenn mindestens eines der betroffenen Daten heute ist.
 * `dates` sind ISO-Zeitstempel der betroffenen Termine (bei Verlegung alt UND neu).
 */
export async function notifyIfToday(admin: SupabaseClient, dates: Array<string | null | undefined>, text: string): Promise<{ sent: boolean; reason?: string }> {
  try {
    const relevant = dates.filter((d): d is string => !!d).some(isTodayCy)
    if (!relevant) return { sent: false, reason: 'nicht_heute' }

    const phone = await recipientPhone(admin)
    if (!phone) {
      console.warn('[notifyToday] keine Empfaengernummer hinterlegt — nicht gesendet')
      return { sent: false, reason: 'keine_nummer' }
    }
    const { error } = await admin.functions.invoke('send-whatsapp', { body: {
      event_type: 'sven_heute', override_text: text,
      lead_data: { lead_name: 'Sven', lead_phone: phone },
      // KEIN lead_id: sonst landet die interne Meldung in der Kundenakte.
    } })
    if (error) { console.warn('[notifyToday] Versand fehlgeschlagen:', error); return { sent: false, reason: 'versand_fehler' } }
    return { sent: true }
  } catch (e) {
    // Eine fehlgeschlagene Benachrichtigung darf niemals die Buchung kippen.
    console.warn('[notifyToday] Fehler:', e)
    return { sent: false, reason: 'fehler' }
  }
}
