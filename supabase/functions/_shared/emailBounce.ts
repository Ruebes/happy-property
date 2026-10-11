// Unzustellbare Mailadressen merken (Tabelle email_bounces, Sven 11.10.26).
//
// Newsletter gehen nicht mehr an Adressen, die nachweislich nicht ankommen: das
// IONOS-Postfach nimmt nur rund 50 Mails pro Stunde an, jede tote Adresse frisst
// davon einen Platz. Wer eine Nummer hat, bekommt den Newsletter per WhatsApp.
//
// Eingetragen wird nur, was DAUERHAFT scheitert und an der Adresse liegt:
//   - SMTP-Ablehnung beim Versand (process-scheduled-messages), z. B.
//     „550 … invalid DNS MX" oder „556 … domain does not accept mail"
//   - Rückläufer im info@-Postfach (imap-poll/bounce.ts), Status 5.x.x
// NICHT: 450 Sendelimit, 451 vorübergehend, Spam-/Richtlinien-Ablehnungen (die
// liegen an unserem Versand, nicht an der Adresse).
// hard = Adresse gibt es nicht -> sofort gesperrt. Weiche Fehler (Postfach voll,
// nach Tagen aufgegeben) sperren erst ab der zweiten Meldung.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// Gleiche Normalisierung wie die Entdopplung im Newsletter (newsletter-campaign).
export function bounceKey(m: string | null | undefined): string {
  const e = (m ?? '').trim().toLowerCase()
  return e.includes('@') ? e.replace(/@googlemail\.com$/, '@gmail.com') : ''
}

const RECIPIENT_PROBLEM = /invalid DNS|does not accept mail|user unknown|unknown user|no such (user|mailbox|recipient)|does not exist|recipient address rejected|mailbox not found|address not found|invalid recipient|unrouteable|host not found/i
const OUR_PROBLEM = /spam|policy|blocked|blacklist|block ?list|reputation|dmarc|\bspf\b|dkim|send limit|rate limit|too many/i

// SMTP-Fehlertext von denomailer/IONOS („550: Requested action not taken: …").
export function isHardSmtpBounce(errMsg: string): boolean {
  const m = String(errMsg ?? '')
  if (!/\b5\d\d\b/.test(m)) return false
  if (OUR_PROBLEM.test(m)) return false
  return RECIPIENT_PROBLEM.test(m)
}

export async function recordBounce(
  sb: SupabaseClient, email: string, reason: string, source: 'smtp' | 'ndr' | 'manual', hard = true,
): Promise<boolean> {
  const key = bounceKey(email)
  if (!key) return false
  const now = new Date().toISOString()
  const { data: alt } = await sb.from('email_bounces').select('bounce_count, hard').eq('email', key).maybeSingle()
  if (alt) {
    const a = alt as { bounce_count?: number; hard?: boolean }
    const upd: Record<string, unknown> = { bounce_count: (a.bounce_count ?? 1) + 1, last_at: now, hard: !!a.hard || hard }
    // Den Grund der harten Meldung behalten, nicht mit einer weichen überschreiben.
    if (hard || !a.hard) { upd.reason = reason.slice(0, 300); upd.source = source }
    const { error } = await sb.from('email_bounces').update(upd).eq('email', key)
    if (error) console.warn('[emailBounce] update:', error.message)
    return !error
  }
  const { error } = await sb.from('email_bounces').insert({ email: key, reason: reason.slice(0, 300), source, hard, first_at: now, last_at: now })
  if (error) console.warn('[emailBounce] insert:', error.message)
  return !error
}

export async function loadBouncedKeys(sb: SupabaseClient): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('email_bounces').select('email').or('hard.eq.true,bounce_count.gte.2').order('email').range(from, from + 999)
    if (error) { console.warn('[emailBounce] laden:', error.message); break }
    for (const r of (data ?? []) as Array<{ email: string }>) out.add(bounceKey(r.email))
    if (!data || data.length < 1000) break
  }
  return out
}
