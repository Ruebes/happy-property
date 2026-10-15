// Firmenstempel je Bauträger (Sven 15.10.2026): ein Foto des Stempels, auf der Unterschrifts-
// seite (oder im CRM) freigestellt, liegt im privaten Bucket developer-seals und gilt für alle
// Dokumente dieses Bauträgers. Beim Unterschreiben wählbar: mit oder ohne Stempel.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const BUCKET = 'developer-seals'
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const MAX_SEAL_BYTES = 1_500_000

/** data:image/png;base64,... oder reines Base64 → PNG-Bytes (geprüft), sonst null. */
export function pngFromInput(raw: unknown, maxBytes: number, minBytes = 200): Uint8Array | null {
  const s = String(raw ?? '').replace(/^data:image\/png;base64,/, '')
  if (!s || s.length > maxBytes * 1.4 || !/^[A-Za-z0-9+/=]+$/.test(s)) return null
  let bin: string
  try { bin = atob(s) } catch { return null }
  if (bin.length < minBytes || bin.length > maxBytes) return null
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  if (!PNG_MAGIC.every((v, i) => bytes[i] === v)) return null
  // Breite/Höhe aus dem IHDR-Block: ein kleines PNG kann sich als 30000x30000 ausgeben und
  // würde beim Einbetten Gigabytes belegen
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const w = dv.getUint32(16), h = dv.getUint32(20)
  if (!w || !h || w > 4000 || h > 4000 || w * h > 6_000_000) return null
  return bytes
}

/** Echte Client-IP für den Prüfvermerk (Cloudflare-Header, sonst letzter X-Forwarded-For-Eintrag). */
export function clientIp(req: Request): string | null {
  const cf = req.headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map(x => x.trim()).filter(Boolean)
  return xff.length ? xff[xff.length - 1] : null
}

/** Sperre gilt 10 Minuten: stirbt die Function mitten im Unterschreiben, ist der Link danach wieder nutzbar. */
export const LOCK_MINUTES = 10

export async function loadSeal(sb: SupabaseClient, developerId: string): Promise<Uint8Array | null> {
  const { data: dev } = await sb.from('crm_developers').select('seal_path').eq('id', developerId).maybeSingle()
  const path = (dev as { seal_path?: string | null } | null)?.seal_path
  if (!path) return null
  const { data, error } = await sb.storage.from(BUCKET).download(path)
  if (error || !data) return null
  return new Uint8Array(await data.arrayBuffer())
}

export async function saveSeal(sb: SupabaseClient, developerId: string, png: Uint8Array, uploadedBy: string): Promise<void> {
  const path = `${developerId}/${Date.now()}.png`
  const { error } = await sb.storage.from(BUCKET).upload(path, png, { contentType: 'image/png', upsert: false })
  if (error) throw new Error(`Stempel speichern: ${error.message}`)
  const { data: old } = await sb.from('crm_developers').select('seal_path').eq('id', developerId).maybeSingle()
  const { error: upErr } = await sb.from('crm_developers')
    .update({ seal_path: path, seal_updated_at: new Date().toISOString(), seal_uploaded_by: uploadedBy.slice(0, 120) }).eq('id', developerId)
  if (upErr) { await sb.storage.from(BUCKET).remove([path]); throw new Error(`Stempel zuordnen: ${upErr.message}`) }
  const oldPath = (old as { seal_path?: string | null } | null)?.seal_path
  if (oldPath && oldPath !== path) await sb.storage.from(BUCKET).remove([oldPath])
}

export async function removeSeal(sb: SupabaseClient, developerId: string): Promise<void> {
  const { data: old } = await sb.from('crm_developers').select('seal_path').eq('id', developerId).maybeSingle()
  const { error } = await sb.from('crm_developers').update({ seal_path: null, seal_updated_at: new Date().toISOString() }).eq('id', developerId)
  if (error) throw new Error(error.message)
  const oldPath = (old as { seal_path?: string | null } | null)?.seal_path
  if (oldPath) await sb.storage.from(BUCKET).remove([oldPath])
}

export function sealDataUrl(png: Uint8Array | null): string | null {
  if (!png) return null
  let bin = ''
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000))
  return `data:image/png;base64,${btoa(bin)}`
}
