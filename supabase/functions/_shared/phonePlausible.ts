// Telefonnummern für den WhatsApp-Ersatz des Newsletters und die Kontakt-
// Bereinigung (Sven 11./12.10.26).
//
// Test-/Fake-Einträge („Test Test", „John Doe", +491234, +4915123456789) haben
// oft auch eine erfundene Nummer, und die gehört womöglich einem Fremden. Dorthin
// geht nie eine WhatsApp, und für die Bereinigung zählt sie als „keine Nummer".
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export function phoneKey(tel: string | null | undefined): string {
  let d = (tel ?? '').replace(/\D/g, '').replace(/^00/, '')
  if (d.startsWith('0')) d = '49' + d.slice(1)
  return d
}

export function echteNummer(tel: string | null | undefined, vor: string | null, nach: string | null): boolean {
  const d = (tel ?? '').replace(/\D/g, '')
  if (d.length < 10 || d.length > 14) return false
  if (/1234567|2345678|3456789|(\d)\1{4}/.test(d)) return false
  const name = `${vor ?? ''} ${nach ?? ''}`.trim().toLowerCase()
  return !/^(test( test)?|john doe|max mustermann)$/.test(name)
}

// Nummern, unter denen es nachweislich kein WhatsApp gibt (Tabelle wa_unreachable,
// befüllt von process-scheduled-messages bei „Diese Nummer hat kein WhatsApp").
export const NO_WHATSAPP_RE = /kein WhatsApp|\\?"exists\\?":\s*false/i

export async function markWaUnreachable(sb: SupabaseClient, tel: string, reason: string): Promise<void> {
  const k = phoneKey(tel)
  if (k.length < 8) return
  const { error } = await sb.from('wa_unreachable').upsert({ phone: k, reason: reason.slice(0, 300), last_at: new Date().toISOString() }, { onConflict: 'phone' })
  if (error) console.warn('[phonePlausible] wa_unreachable:', error.message)
}

export async function clearWaUnreachable(sb: SupabaseClient, tel: string): Promise<void> {
  const k = phoneKey(tel)
  if (k.length >= 8) await sb.from('wa_unreachable').delete().eq('phone', k)
}
