// Sprache des EMPFÄNGERS bestimmen — eine Quelle für alle Sendewege.
//
// Sven schreibt immer deutsch; ob der Empfänger die Nachricht auf Englisch
// bekommt, entscheidet sich hier (Sven 26.8.).
//
// REIHENFOLGE IST ABSICHT: zuerst die konkrete Adresse/Nummer, erst danach der
// Lead. Grund: Eine Weiterleitung an einen Partner trägt die lead_id des Kunden
// mit sich — würde man danach auflösen, bekäme ein deutscher Anwalt Englisch,
// nur weil der Kunde Englisch spricht. Über die Zieladresse trifft es den
// Partner-Kontakt korrekt. Umgekehrt setzen der Kunden-Composer und die Inbox
// bewusst lead_id: null (gegen Doppel-Protokollierung) — dort ist die Adresse
// der einzige Anker.
//
// Im Zweifel Deutsch: lieber die Muttersprache des Hauses als eine falsche
// Übersetzung.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type Lang = 'de' | 'en'

const norm = (l: unknown): Lang | null => (l === 'en' ? 'en' : l === 'de' ? 'de' : null)
/** Telefonnummern kommen mit uneinheitlichen Vorwahlen — die letzten 9 Ziffern vergleichen. */
const tail = (p: string) => p.replace(/\D/g, '').slice(-9)

export async function resolveLang(
  sb: SupabaseClient,
  who: { email?: string | null; phone?: string | null; lead_id?: string | null },
): Promise<Lang> {
  const email = who.email?.trim().toLowerCase() || null
  const phone = who.phone?.trim() || null
  const ph = phone ? tail(phone) : null

  try {
    // 1. Lead über die Zieladresse (E-Mail, Zweitadresse, Telefon, WhatsApp)
    if (email) {
      const { data } = await sb.from('leads').select('language, email, alt_emails')
        .or(`email.ilike.${email},alt_emails.cs.{"${email}"}`).limit(5)
      for (const r of (data ?? []) as Array<{ language?: string }>) {
        const l = norm(r.language); if (l) return l
      }
    }
    if (ph) {
      const { data } = await sb.from('leads').select('language, phone, whatsapp').limit(2000)
      for (const r of (data ?? []) as Array<{ language?: string; phone?: string; whatsapp?: string }>) {
        if ((r.phone && tail(r.phone) === ph) || (r.whatsapp && tail(r.whatsapp) === ph)) {
          const l = norm(r.language); if (l) return l
        }
      }
    }
    // 2. Portal-Nutzer (Eigentümer, Mitarbeiter) über das Profil
    if (email) {
      const { data } = await sb.from('profiles').select('language').ilike('email', email).limit(1)
      const l = norm((data ?? [])[0]?.language); if (l) return l
    }
    // 3. Geschäftskontakte und Bauträger-Ansprechpartner
    for (const tbl of ['crm_business_contacts', 'crm_developer_contacts', 'verwaltungen'] as const) {
      if (email) {
        const { data } = await sb.from(tbl).select('language').ilike('email', email).limit(1)
        const l = norm((data ?? [])[0]?.language); if (l) return l
      }
    }
    // 4. Newsletter-Empfänger ohne Lead
    if (email) {
      const { data } = await sb.from('newsletter_subscribers').select('language').ilike('email', email).limit(1)
      const l = norm((data ?? [])[0]?.language); if (l) return l
    }
    // 5. Erst jetzt der Lead aus dem Aufruf — er kann zu einer Weiterleitung gehören.
    if (who.lead_id) {
      const { data } = await sb.from('leads').select('language').eq('id', who.lead_id).maybeSingle()
      const l = norm((data as { language?: string } | null)?.language); if (l) return l
    }
  } catch (err) {
    console.warn('[recipientLang] Auflösung fehlgeschlagen, sende Deutsch:', err instanceof Error ? err.message : String(err))
  }
  return 'de'
}
