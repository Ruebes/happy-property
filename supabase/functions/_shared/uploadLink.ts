// Upload-Links für die Seite /sign/u/:token: hochladen ohne Google-Konto, siehe owner-drive.
// Ein Link gehört zu einem Kundenordner und einer Person. Gibt es schon einen gültigen,
// bleibt er bestehen und läuft ab jetzt wieder die volle Zeit, damit alte Nachrichten weiter stimmen.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type UploadEmpfaenger = 'kunde' | 'bautraeger' | 'anwalt' | 'partner' | 'team'
export const UPLOAD_EMPFAENGER: UploadEmpfaenger[] = ['kunde', 'bautraeger', 'anwalt', 'partner', 'team']
export const UPLOAD_TAGE = 30
const BASE = 'https://portal.happy-property.com/sign/u/'

export interface UploadLinkWunsch {
  lead_id: string
  empfaenger: UploadEmpfaenger
  name: string
  email?: string | null
  phone?: string | null
}

export async function uploadLinkHolen(sb: SupabaseClient, w: UploadLinkWunsch): Promise<{ id: string; url: string; expires_at: string }> {
  const expires_at = new Date(Date.now() + UPLOAD_TAGE * 86_400_000).toISOString()
  const name = w.name.trim()
  const { data: alt, error: altErr } = await sb.from('upload_links').select('id, token')
    .eq('lead_id', w.lead_id).eq('empfaenger', w.empfaenger).ilike('name', name.replace(/([\\%_])/g, '\\$1'))
    .is('revoked_at', null).gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (altErr) throw new Error(`Upload-Link lesen: ${altErr.message}`)
  if (alt) {
    const { error } = await sb.from('upload_links').update({ expires_at }).eq('id', alt.id)
    if (error) throw new Error(`Upload-Link verlängern: ${error.message}`)
    return { id: alt.id, url: BASE + alt.token, expires_at }
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), x => x.toString(16).padStart(2, '0')).join('')
  const { data: neu, error } = await sb.from('upload_links').insert({
    token, lead_id: w.lead_id, empfaenger: w.empfaenger, name,
    email: w.email?.trim().toLowerCase() || null, phone: w.phone?.trim() || null, expires_at,
  }).select('id').single()
  if (error) throw new Error(`Upload-Link anlegen: ${error.message}`)
  return { id: (neu as { id: string }).id, url: BASE + token, expires_at }
}
