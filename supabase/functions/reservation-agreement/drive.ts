// Google-Drive-Zugriff für reservation-agreement. Gleiche zwei Wege wie owner-drive:
//   LESEN über den Service-Account (sieht alle Kundenordner),
//   HOCHLADEN (nur das digital unterschriebene PDF) über Svens Google-Konto
//   (connector_secrets GOOGLE_DRIVE_REFRESH_TOKEN), weil der Service-Account keinen Speicher hat.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const MAX_DEPTH = 3
const MAX_FOLDERS = 40
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,thumbnailLink,webViewLink'

export interface DriveFile {
  id: string; name: string; mimeType: string; size?: string
  createdTime?: string; thumbnailLink?: string; webViewLink?: string
}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\\n/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(b), c => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
let saCache: { token: string; exp: number } | null = null
export async function saToken(): Promise<string> {
  if (saCache && saCache.exp > Date.now() + 60_000) return saCache.token
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const key = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(new Uint8Array(sig))}` }),
  })
  const data = await res.json() as { access_token?: string; error_description?: string }
  if (!data.access_token) throw new Error(`SA-Token: ${data.error_description ?? 'unbekannt'}`)
  saCache = { token: data.access_token, exp: Date.now() + 3500_000 }
  return saCache.token
}

async function driveGet<T>(token: string, url: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const d = await r.json() as T & { error?: { message?: string } }
  if (!r.ok) throw new Error(`Drive ${r.status}: ${d.error?.message ?? 'Fehler'}`)
  return d
}

/** Alle Dateien eines Kundenordners inkl. Unterordner (bis MAX_DEPTH). */
export async function listTree(token: string, rootId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_FOLDERS) {
    const cur = queue.shift()!
    visited++
    let pageToken = ''
    do {
      const q = encodeURIComponent(`'${cur.id}' in parents and trashed=false`)
      const d = await driveGet<{ files?: DriveFile[]; nextPageToken?: string }>(token,
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`)
      for (const f of d.files ?? []) {
        if (f.mimeType === FOLDER_MIME) { if (cur.depth < MAX_DEPTH) queue.push({ id: f.id, depth: cur.depth + 1 }) }
        else files.push(f)
      }
      pageToken = d.nextPageToken ?? ''
    } while (pageToken)
  }
  return files
}

/** Dateiinhalt laden (Google-eigene Formate als PDF exportiert). */
export async function download(token: string, f: DriveFile): Promise<{ bytes: Uint8Array; mime: string }> {
  const native = f.mimeType.startsWith('application/vnd.google-apps.')
  const url = native
    ? `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=application/pdf`
    : `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`Drive-Download ${r.status}`)
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime: native ? 'application/pdf' : f.mimeType }
}

/** Vorschaubild von Google (JPEG/PNG), z. B. für HEIC-Fotos vom iPhone, die die KI nicht lesen kann. */
export async function thumbnail(token: string, f: DriveFile): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!f.thumbnailLink) return null
  const url = f.thumbnailLink.replace(/=s\d+$/, '=s2000')
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const mime = (r.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime }
}

async function secret(sb: SupabaseClient, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return ((data as { value?: string } | null)?.value ?? '').trim()
}
export async function uploadToken(sb: SupabaseClient): Promise<string | null> {
  const [cid, csec, rtok] = await Promise.all([
    secret(sb, 'YOUTUBE_CLIENT_ID'), secret(sb, 'YOUTUBE_CLIENT_SECRET'), secret(sb, 'GOOGLE_DRIVE_REFRESH_TOKEN'),
  ])
  if (!cid || !csec || !rtok) return null
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }),
  })
  const td = await tr.json() as { access_token?: string; error?: string }
  if (!td.access_token) { console.error('[reservation-agreement] Upload-Token:', td.error); return null }
  return td.access_token
}

/** Resumable-Upload in einen Ordner (mit Svens Upload-Token). */
export async function uploadFile(token: string, folderId: string, name: string, mime: string, bytes: Uint8Array): Promise<DriveFile> {
  const init = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(bytes.byteLength) },
    body: JSON.stringify({ name, parents: [folderId] }),
  })
  if (!init.ok) {
    const e = await init.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(`Upload-Start ${init.status}: ${e.error?.message ?? 'Fehler'}`)
  }
  const loc = init.headers.get('location')
  if (!loc) throw new Error('Upload-Start ohne Location-Header')
  const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes.slice() })
  const d = await put.json() as DriveFile & { error?: { message?: string } }
  if (!put.ok || !d.id) throw new Error(`Upload ${put.status}: ${d.error?.message ?? 'Fehler'}`)
  return d
}
