// Kunden-Sperre: Wer ist gesperrt?
//
// Wahrheit ist profiles.is_active = false. Gesetzt wird das Feld nur zusammen mit
// Auth-Bann und beendeten Sitzungen (admin-user-ops, Aktion set_blocked). Alle Stellen,
// die Kunden automatisch anschreiben oder ihnen etwas freigeben, fragen hier nach.
//
// ladeGesperrte wirft bei einem Lesefehler, damit ein DB-Problem niemanden versehentlich
// wieder freischaltet. Wer den Aufruf abfängt, muss den Kunden im Fehlerfall auslassen.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export interface GesperrteKonten {
  ids: Set<string>
  mails: Set<string>
}

export interface LeadKontakt {
  profile_id?: string | null
  email?: string | null
  alt_emails?: string[] | null
}

// Google Drive zeigt googlemail.com-Adressen als gmail.com an.
export function normMail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase().replace(/@googlemail\.com$/, '@gmail.com')
}

export async function ladeGesperrte(sb: SupabaseClient): Promise<GesperrteKonten> {
  const { data, error } = await sb.from('profiles').select('id, email').eq('is_active', false).limit(1000)
  if (error) throw new Error(`Gesperrte Konten nicht lesbar: ${error.message}`)
  const zeilen = (data ?? []) as Array<{ id: string; email: string | null }>
  return {
    ids: new Set(zeilen.map(z => z.id)),
    mails: new Set(zeilen.map(z => normMail(z.email)).filter(Boolean)),
  }
}

// Gesperrt, wenn das verknüpfte Konto oder eine Adresse des Leads gesperrt ist.
export function leadGesperrt(g: GesperrteKonten, lead: LeadKontakt): boolean {
  if (lead.profile_id && g.ids.has(lead.profile_id)) return true
  return [lead.email, ...(lead.alt_emails ?? [])].some(m => g.mails.has(normMail(m)))
}

// Gesperrt, wenn die Adresse selbst gesperrt ist oder einem gesperrten Lead gehört.
// Fremde Adressen am selben Lead (Partner, Steuerberater) bleiben erlaubt.
export function mailGesperrt(g: GesperrteKonten, email: string | null | undefined, lead?: LeadKontakt): boolean {
  const mail = normMail(email)
  if (!mail) return false
  if (g.mails.has(mail)) return true
  if (!lead || !leadGesperrt(g, lead)) return false
  return [lead.email, ...(lead.alt_emails ?? [])].some(m => normMail(m) === mail)
}

// Gehört die Adresse zu einem gesperrten Konto? Prüft Adresse, Login-ID und die Leads mit
// dieser Adresse, denn ein Lead kann eine andere Adresse tragen als sein Konto. Wirft bei
// einem Lesefehler: Wer Zugänge verschickt, bricht dann ab.
export async function zugangGesperrt(sb: SupabaseClient, email: string, authId?: string | null): Promise<boolean> {
  const g = await ladeGesperrte(sb)
  if (g.ids.size === 0) return false
  if (g.mails.has(normMail(email)) || (authId && g.ids.has(authId))) return true
  const mail = email.trim().toLowerCase()
  const { data: perMail, error: mailErr } = await sb.from('leads').select('profile_id, email, alt_emails')
    .ilike('email', mail.replace(/([\\%_])/g, '\\$1')).limit(5)
  if (mailErr) throw new Error(`Leads nicht lesbar: ${mailErr.message}`)
  const { data: perAlt, error: altErr } = await sb.from('leads').select('profile_id, email, alt_emails')
    .contains('alt_emails', [mail]).limit(5)
  if (altErr) throw new Error(`Leads nicht lesbar: ${altErr.message}`)
  return ([...(perMail ?? []), ...(perAlt ?? [])] as LeadKontakt[]).some(l => leadGesperrt(g, l))
}

export const kontoGesperrtAntwort = (email: string) => ({
  error: `Das Konto zu ${email} ist gesperrt. Es wurde kein Passwort geändert und nichts verschickt. Zum Entsperren im Nutzer-Bereich auf „Aktivieren“ klicken.`,
  code: 'KONTO_GESPERRT',
})
