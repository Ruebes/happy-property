// Supabase Edge Function: prepare-project-assets
// Importiert automatisch die Deck-Assets eines Projekts aus seinem Google-Drive-Ordner
// (crm_projects.drive_folder_id) und cached sie in crm_projects.deck_assets.
//
// Vier Aktionen (getrennt wegen Edge-Zeit-/CPU-Budget; Caller ruft sie nacheinander):
//   images     → Renders + Grundrisse + Lagebild aus den Unterordnern → Storage
//   categorize → Renders per Vision in Räume/Bereiche einsortieren (gallery)
//   docs       → Broschüre/Preisliste/Spec/Besteck/Wäsche → Storage-URLs (+ xlsx-Spec als Text)
//   facts      → Claude liest Broschüre + Besteck + Wäsche (+ Spec) → apartment-sichere Fakten
//
// Body: { project_id, action: 'images'|'categorize'|'docs'|'facts', force? }
import { createClient } from 'jsr:@supabase/supabase-js@2'
// XLSX wird NUR im Spec-Zweig der docs-Aktion dynamisch geladen (memory-schwere
// Library) — sonst belastet sie jede Invocation (auch categorize/brochure) und
// trieb docs ins „Memory limit exceeded".

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ── Service-Account-Lesetoken (wie in google-drive) ──────────────────────────────
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
async function getReadToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  // Domainweite Delegierung: ist GOOGLE_IMPERSONATE_SUBJECT gesetzt, sieht der
  // Service-Account den kompletten Drive dieses Kontos, ohne Ordner-Freigaben.
  const sub = Deno.env.get('GOOGLE_IMPERSONATE_SUBJECT') || undefined
  // Bei Delegierung den in der Workspace-Verwaltung freigegebenen Bereich
  // anfragen (.../auth/drive), sonst weist Google das Token ab.
  const scope = sub ? 'https://www.googleapis.com/auth/drive' : 'https://www.googleapis.com/auth/drive.readonly'
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600, ...(sub ? { sub } : {}) })}`
  const key = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const data = await res.json() as { access_token?: string; error_description?: string }
  if (!data.access_token) throw new Error(`SA-Token: ${data.error_description ?? 'unbekannt'}`)
  return data.access_token
}

// ── Drive-Helfer ─────────────────────────────────────────────────────────────────
type DriveVideoMeta = { width?: number; height?: number; durationMillis?: string }
type DriveFile = { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; videoMediaMetadata?: DriveVideoMeta }
const isFolder = (m: string) => m === 'application/vnd.google-apps.folder'
const isImg    = (m: string) => m.startsWith('image/')
const isVid    = (m: string) => m.startsWith('video/')

async function listChildren(token: string, parentId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`)
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime,videoMediaMetadata(width,height,durationMillis))&pageSize=300&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as { files?: DriveFile[] }
  return data.files ?? []
}
async function getParentId(token: string, fileId: string): Promise<string | null> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as { parents?: string[] }
  return data.parents?.[0] ?? null
}
// Native Google-Dateien (Sheet/Doc/Slides) haben keinen Binaer-Body — alt=media
// liefert dort einen Fehler und der Import scheiterte STILL (Skala-Preisliste 14.8.:
// Luma stellte die Liste von einer xlsx-Datei auf ein natives Sheet um → der Spiegel
// blieb auf dem Stand vom 12.7. und der Preis-Sync las veraltete Preise).
// Deshalb: native Typen IMMER ueber den Export-Endpunkt holen (Sheet→xlsx, Doc/Slides→pdf).
const GAPPS_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.spreadsheet':  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.document':     { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
}
async function driveBytes(token: string, fileId: string, mimeType = ''): Promise<Uint8Array> {
  const exp = GAPPS_EXPORT[mimeType]
  const url = exp
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exp.mime)}&supportsAllDrives=true`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Download ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
// Endung IMMER aus dem MIME-Typ ableiten, wenn der Drive-Name keine hat.
// Drive-Dateien heissen oft "BLOCK A Floor plan" ohne Endung — daraus wurde bisher
// ".blockafloorplan". Folge: hp-floorplan erkannte das PDF nicht (es prueft auf
// /\.pdf$/) und der Deck-Renderer haelt es fuer ein Bild.
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}
const BEKANNTE_EXT = new Set(Object.values(MIME_TO_EXT).concat(['jpeg', 'tif', 'tiff', 'heic', 'doc', 'docx', 'xls', 'csv']))

async function uploadBytes(supabase: ReturnType<typeof createClient>, bytes: Uint8Array, mime: string, prefix: string, name: string, bucket = 'deck-assets'): Promise<string> {
  const roh = (name.split('.').length > 1 ? name.split('.').pop()! : '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const ext = (roh && BEKANNTE_EXT.has(roh)) ? roh
            : (MIME_TO_EXT[(mime || '').split(';')[0].trim().toLowerCase()] || roh || 'bin')
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType: mime, upsert: false })
  if (error) throw new Error(error.message)
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

const isGDoc = (m: string) => m === 'application/vnd.google-apps.document'

// ── Dropbox-Helfer (Kuutio Homes liefert per Dropbox statt Google Drive) ─────────
// Auth: langlebiger Refresh-Token einer Dropbox-App in connector_secrets
// (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN). Der Refresh-Token
// rotiert NICHT (anders als Higgsfield) — nur Access-Tokens (4 h) werden gemintet.
type DbxEntry = { '.tag': string; name: string; path_lower?: string; path_display?: string; server_modified?: string; size?: number }
async function dropboxToken(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const get = async (key: string) => (((await supabase.from('connector_secrets').select('value').eq('key', key).maybeSingle()).data as { value?: string } | null)?.value ?? '').trim()
  const [k, s, r] = await Promise.all([get('DROPBOX_APP_KEY'), get('DROPBOX_APP_SECRET'), get('DROPBOX_REFRESH_TOKEN')])
  if (!k || !s || !r) return null
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: r, client_id: k, client_secret: s }),
  })
  const d = await res.json() as { access_token?: string; error_description?: string }
  if (!d.access_token) throw new Error(`Dropbox-Token: ${d.error_description ?? JSON.stringify(d).slice(0, 120)}`)
  return d.access_token
}
async function dropboxList(token: string, path: string, recursive: boolean): Promise<DbxEntry[]> {
  const out: DbxEntry[] = []
  let res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive, limit: 1000 }),
  })
  let d = await res.json() as { entries?: DbxEntry[]; cursor?: string; has_more?: boolean; error_summary?: string }
  if (!res.ok) throw new Error(`Dropbox list ${path}: ${d.error_summary ?? res.status}`)
  out.push(...(d.entries ?? []))
  while (d.has_more && d.cursor) {
    res = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: d.cursor }),
    })
    d = await res.json() as typeof d
    if (!res.ok) break
    out.push(...(d.entries ?? []))
  }
  return out
}
async function dropboxBytes(token: string, path: string): Promise<Uint8Array> {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
  })
  if (!res.ok) throw new Error(`Dropbox download ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
// Google-Doc als Text exportieren (bzw. reine Textdatei direkt lesen).
async function driveText(token: string, fileId: string, mimeType: string): Promise<string> {
  const url = isGDoc(mimeType)
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  return res.ok ? await res.text() : ''
}
// Koordinaten aus einem Google-Maps-Link/Text ziehen. Bevorzugt den exakten Place-Pin
// (!3d…!4d…), dann Viewport-Center (@lat,lng), dann q=lat,lng.
function coordsFromMapsText(text: string): { lat: number; lng: number; url: string } | null {
  // \S* statt Zeichenklasse: Maps-Place-URLs enthalten literale Apostrophe (34°45'54"N).
  const urlM = text.match(/https?:\/\/\S*google\.\S*maps\S*/i)
  const raw = urlM ? urlM[0].replace(/[)"'.,]+$/, '') : ''
  let dec = ''
  try { dec = decodeURIComponent(text) } catch { dec = text }
  const match = (hay: string) =>
    hay.match(/!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/) ||   // exakter Place-Pin
    hay.match(/@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/) ||       // Viewport-Center
    hay.match(/[?&]q=(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/)  // q=lat,lng
  const m = match(raw) || match(dec)
  if (!m) return null
  return { lat: Number(m[1]), lng: Number(m[2]), url: raw }
}
// Location aus dem Drive-Ordner einlesen: sucht einen "Location"-Unterordner (bzw.
// gleichnamige Dokumente im Wurzelordner), liest deren Text, zieht Koordinaten und
// setzt latitude/longitude/maps_url am Projekt. Idempotent, best effort.
async function ingestLocation(
  token: string, folderId: string, supabase: ReturnType<typeof createClient>, projectId: string,
): Promise<{ found: boolean; lat?: number; lng?: number; source?: string; tried?: Array<{ name: string; mime: string; len: number; hit: boolean }> }> {
  const kids = await listChildren(token, folderId)
  const docs: DriveFile[] = []
  const locFolder = kids.find(f => isFolder(f.mimeType) && folderCategory(f.name) === 'location')
  if (locFolder) docs.push(...(await listChildren(token, locFolder.id)))
  docs.push(...kids.filter(f => !isFolder(f.mimeType) && /location|lage/i.test(f.name)))
  const tried: Array<{ name: string; mime: string; len: number; hit: boolean }> = []
  for (const d of docs) {
    if (isFolder(d.mimeType) || isImg(d.mimeType)) continue
    const txt = await driveText(token, d.id, d.mimeType).catch(() => '')
    const c = txt ? coordsFromMapsText(txt) : null
    tried.push({ name: d.name, mime: d.mimeType, len: txt.length, hit: !!c })
    if (c) {
      const upd: Record<string, unknown> = { latitude: c.lat, longitude: c.lng }
      if (c.url) upd.maps_url = c.url
      await supabase.from('crm_projects').update(upd).eq('id', projectId)
      return { found: true, lat: c.lat, lng: c.lng, source: d.name, tried }
    }
  }
  return { found: false, tried }
}

// Drive-Body direkt nach Storage pipen, ohne die Datei im Worker zu puffern.
// Genau dieser Weg ueberlebt auch 100-MB-Dateien; ein Buffer-Import killt den Worker.
async function streamDriveToStorage(token: string, fileId: string, mime: string, name: string, projectId: string): Promise<string> {
  const SUPABASE_URL_L = Deno.env.get('SUPABASE_URL')!
  const SERVICE_L = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const nameExt = (name || '').toLowerCase().match(/\.([a-z0-9]{2,4})$/)?.[1]
  // Endung MUSS stimmen: der Deck-Renderer erkennt ein direktes Video an der Endung.
  const ext = (nameExt && BEKANNTE_EXT.has(nameExt)) ? nameExt : (MIME_TO_EXT[mime] || 'mp4')
  const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } })
  if (!dl.ok || !dl.body) throw new Error(`Drive-Download ${dl.status}`)
  const path = `projects/${projectId}/videos/${fileId}.${ext}`
  const init: RequestInit & { duplex?: string } = {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_L}`, apikey: SERVICE_L, 'Content-Type': mime, 'x-upsert': 'true', 'cache-control': '31536000' },
    body: dl.body,
    duplex: 'half',
  }
  const up = await fetch(`${SUPABASE_URL_L}/storage/v1/object/deck-assets/${path}`, init)
  if (!up.ok) throw new Error(`Storage-Upload ${up.status}: ${(await up.text()).slice(0, 200)}`)
  return `${SUPABASE_URL_L}/storage/v1/object/public/deck-assets/${path}`
}

// YouTube-Upload (nicht gelistet) fuer Bautraeger-Filme, die sich nicht selbst
// hosten lassen: H.265-Rohmaterial (kein Browser dekodiert das) und Master ueber
// dem Storage-Limit. YouTube transkodiert beides und liefert es ausgeliefert an
// jedes Endgeraet. Der Drive-Body wird direkt in den Resumable-Upload gepipet,
// damit auch grosse Dateien den Worker nicht sprengen.
async function youtubeAccessToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  const get = async (k: string) => (((await supabase.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? '').trim()
  const [cid, csec, rtok] = await Promise.all([get('YOUTUBE_CLIENT_ID'), get('YOUTUBE_CLIENT_SECRET'), get('YOUTUBE_REFRESH_TOKEN')])
  if (!cid || !csec || !rtok) throw new Error('YouTube ist nicht verbunden (YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN in Einstellungen -> Connectoren).')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }),
  })
  const d = await r.json() as { access_token?: string; error_description?: string }
  if (!d.access_token) throw new Error(`YouTube-OAuth: ${d.error_description ?? r.status}`)
  return d.access_token
}

async function driveToYoutube(
  driveToken: string, ytToken: string, fileId: string, size: number, mime: string,
  titel: string, beschreibung: string, dryRun = false,
): Promise<string> {
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ytToken}`, 'Content-Type': 'application/json',
      'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': mime || 'video/mp4',
    },
    body: JSON.stringify({
      snippet: { title: titel.slice(0, 95), description: beschreibung.slice(0, 4800), categoryId: '26' },
      // NICHT GELISTET: das Video ist nur ueber den Link im Deck erreichbar und
      // taucht weder im Kanal noch in der YouTube-Suche auf.
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
    }),
  })
  const loc = init.headers.get('location')
  if (!init.ok || !loc) throw new Error(`YouTube-Upload-Init ${init.status}: ${(await init.text()).slice(0, 200)}`)
  // Probelauf: Anmeldung, Kontingent und Metadaten sind geprueft, es werden aber
  // KEINE Bytes uebertragen - ohne PUT entsteht auf dem Kanal kein Video.
  if (dryRun) return ''
  const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${driveToken}` } })
  if (!dl.ok || !dl.body) throw new Error(`Drive-Download ${dl.status}`)
  const put: RequestInit & { duplex?: string } = {
    method: 'PUT',
    headers: { 'Content-Length': String(size), 'Content-Type': mime || 'video/mp4' },
    body: dl.body,
    duplex: 'half',
  }
  const up = await fetch(loc, put)
  const ud = await up.json().catch(() => ({})) as { id?: string; error?: { message?: string } }
  if (!up.ok || !ud.id) throw new Error(ud.error?.message ?? `YouTube-Upload ${up.status}`)
  return `https://youtu.be/${ud.id}`
}

// ── Video-Erkennung ──────────────────────────────────────────────────────────────
// Bautraeger liefern drei Sorten Bewegtbild, und nur eine davon laeuft im Browser:
//  1. fertige Filme in H.264 (avc1)  -> nutzbar, wenn sie klein genug sind
//  2. dieselben Filme als Master     -> H.264, aber hunderte MB bis GB
//  3. Drohnen-Rohclips aus der DJI   -> H.265 (hvc1), Chrome kann das NICHT dekodieren
// Deshalb wird JEDE Datei geprueft, bevor irgendetwas importiert wird, und jede
// Entscheidung landet nachlesbar in deck_assets.videos.
const VIDEO_MAX_BYTES = 60 * 1024 * 1024        // was groesser ist, gehoert auf YouTube
type VideoCodecProbe = { codecs: string[]; playable: boolean }

async function probeVideoCodec(token: string, fileId: string, size: number): Promise<VideoCodecProbe> {
  const range = async (a: number, b: number) => {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}`, Range: `bytes=${a}-${b}` } })
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array()
  }
  // Der moov-Atom mit der Codec-Kennung liegt je nach Encoder vorn ODER hinten.
  const head = await range(0, 4_000_000)
  const tail = size > 8_000_000 ? await range(size - 3_000_000, size - 1) : new Uint8Array()
  const hay = new TextDecoder('latin1').decode(head) + new TextDecoder('latin1').decode(tail)
  const codecs = ['avc1', 'hvc1', 'hev1', 'mp4v', 'av01', 'vp09'].filter(c => hay.includes(c))
  return { codecs, playable: codecs.some(c => c === 'avc1' || c === 'mp4v') }
}

// In welchen Deck-Abschnitt gehoert der Clip? Ordner- UND Dateiname entscheiden,
// weil Bautraeger mal das eine, mal das andere sprechend benennen.
function videoSlot(name: string, folder = ''): 'projekt' | 'anlage' | 'innen' {
  const n = `${folder} ${name}`.toLowerCase()
  if (/sauna|\bspa\b|\bgym\b|fitness|pool|club|yoga|studio|amenit|lobby|cafe|café/.test(n)) return 'anlage'
  if (/interior|innen|apartment|wohnung|room|zimmer|kitchen|kueche|küche|tour|rundgang|show\s*house|show\s*flat|musterwohnung/.test(n)) return 'innen'
  return 'projekt'
}

// Bewertung eines Clips fuer den Deck-Einsatz. Bautraeger-Ordner sind voll mit
// Export-Dubletten ("temp_video_for_share.mp4" viermal), WhatsApp-Mitschnitten und
// kurzen Schnipseln — ohne Bewertung gewinnt der Zufall.
function videoScore(v: { name: string; duration_s?: number; width?: number; height?: number; slot: string; orientation: string; status: string }): number {
  const n = v.name.toLowerCase()
  const w = v.width ?? 0, h = v.height ?? 0
  let p = 0
  p += Math.min(v.duration_s ?? 0, 90)                                  // Laenge zaehlt, aber gedeckelt
  p += Math.min(w / 100, 40)                                            // Aufloesung
  // Seitenverhaeltnis: das Deck zeigt 16:9. Quadrat und Hochformat laufen im
  // Hauptfilm-Slot mit Balken und sehen billig aus.
  const ar = h > 0 ? w / h : 0
  if (Math.abs(ar - 16 / 9) < 0.2) p += 30
  else if (v.slot === 'projekt' && Math.abs(ar - 1) < 0.1) p -= 20
  if (/final|fertig|film|promo|tour|showreel|show\s*house|master|no\s*logo/.test(n)) p += 40
  if (/whatsapp|screen|^img[_-]|^video[_-]?\d|^\d{8}/.test(n)) p -= 40
  // Drive-Exportnamen ("temp_video_for_share.mp4") sagen nichts ueber die Qualitaet
  // aus - bei Luma steckt genau dort der beste Drohnenflug. Nur leicht abwerten.
  if (/temp|share|kopie|copy/.test(n)) p -= 12
  if (/^[0-9a-f-]{20,}\./.test(n)) p -= 15                              // reine UUID-Namen
  if (/\.mov$/.test(n)) p -= 20                                        // .mov spielt nicht ueberall
  if (v.slot === 'projekt' && v.orientation === 'hoch') p -= 25         // Hochformat als Hauptfilm passt nicht
  if ((v.duration_s ?? 0) < 5) p -= 30                                  // Schnipsel
  return Math.round(p)
}

// Dateien, die zwar Video sind, aber nie ins Deck gehoeren.
// "logo" steht hier bewusst NICHT: Bautraeger nennen die Fassung ohne Wasserzeichen
// "no logo …" — die ist die beste, nicht die schlechteste.
const VIDEO_JUNK_RE = /\b(preisliste|pricelist|entwurf|draft)\b/i

// ── Klassifizierung ──────────────────────────────────────────────────────────────
function folderCategory(name: string): 'floorplan' | 'location' | 'render' | null {
  const n = name.toLowerCase()
  if (/floor\s*plan|grundriss|drawings?/.test(n)) return 'floorplan'
  if (/location|lage|master\s*plan/.test(n))      return 'location'
  if (/picture|photo|render|3d|gallery|interior|exterior|pool|view|cgi/.test(n)) return 'render'
  return null
}
function floorFromName(name: string): number | null {
  const cn = name.match(/(-?\d+)\s*层/); if (cn) return parseInt(cn[1], 10)               // chinesisch: 3层
  const w = name.toLowerCase().match(/\b(ground|first|second|third|fourth|fifth|sixth|seventh)\b/)
  if (w) return ['ground', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'].indexOf(w[1])
  const d = name.match(/\b(\d+)\s*\.?\s*(og|floor|etage|stock)\b/i); if (d) return parseInt(d[1], 10)
  return null
}
// Renditeprognosen des Bautraegers kommen NIE ins Sales Deck (Sven 9.9.2026):
// gerechnet wird ausschliesslich mit unserem eigenen Rechner. Deshalb werden solche
// Dateien schon beim Einlesen aussortiert - nicht erst im Deck-Text. Gilt fuer
// Bilder, Dokumente, Fakten und Videos gleichermassen.
export const RENDITE_RE = /\b(roi|rendite|renditen|yield|rental.?income|mietrendite|prognose|forecast|prediction|projection)\b/i

function docType(name: string): 'brochure' | 'pricelist' | 'spec' | 'cutlery' | 'linen' | 'payment' | null {
  const n = name.toLowerCase()
  if (RENDITE_RE.test(n)) return null
  if (/zahlungsplan|payment.?plan|payment.?schedule|ratenplan|payment.?terms/.test(n)) return 'payment'
  if (/cutlery|cutler|cultery|besteck|geschirr|crockery/.test(n)) return 'cutlery'
  if (/linen|w[äa]sche|bett|towel/.test(n))                       return 'linen'
  if (/price\s*list|preisliste|pricelist|price/.test(n))          return 'pricelist'
  if (/specification|\bspec\b|einrichtung|fit.?out|finish|furnish/.test(n)) return 'spec'
  if (/brochure|brosch|presentation|booklet|en-new|catalog/.test(n)) return 'brochure'
  return null
}

type DeckAssets = {
  renders?: string[]
  gallery?: Array<{ url: string; category: string; label: string }>   // kategorisierte Renders (Vision)
  floorplans?: Array<{ floor: number | null; label: string; url: string }>
  map?: string | null
  mapUrl?: string | null
  mapMarker?: { x: number; y: number } | null   // %-Position des echten Standort-Pins (Vision)
  doc_urls?: Record<string, string>
  spec_text?: string
  facts?: string
  // Bewegtbild aus dem Drive-Ordner, inklusive der Dateien, die NICHT ins Deck
  // koennen (Codec/Groesse). Der Grund steht dabei, damit nichts still scheitert.
  videos?: Array<{
    drive_id: string; name: string; folder: string; modified?: string; size: number
    width?: number; height?: number; duration_s?: number
    slot: 'projekt' | 'anlage' | 'innen'; orientation: 'quer' | 'hoch'
    status: 'ok' | 'kandidat' | 'codec' | 'zu_gross' | 'ignoriert' | 'fehler'
    codecs?: string[]; url?: string; youtube_url?: string; reason?: string; score?: number
  }>
  updated_at?: string
}
async function loadAssets(supabase: ReturnType<typeof createClient>, projectId: string): Promise<{ folderId: string | null; assets: DeckAssets; project: Record<string, unknown> }> {
  const { data } = await supabase.from('crm_projects')
    .select('drive_folder_id, deck_assets, name, developer, location, google_maps_url, maps_url, images, latitude, longitude, video_url').eq('id', projectId).maybeSingle()
  const p = (data ?? {}) as Record<string, unknown>
  return { folderId: (p.drive_folder_id as string) ?? null, assets: (p.deck_assets as DeckAssets) ?? {}, project: p }
}
async function saveAssets(supabase: ReturnType<typeof createClient>, projectId: string, patch: DeckAssets, extra?: Record<string, unknown>) {
  const { assets } = await loadAssets(supabase, projectId)
  const merged = { ...assets, ...patch, updated_at: new Date().toISOString() }
  await supabase.from('crm_projects').update({ deck_assets: merged, ...(extra ?? {}) }).eq('id', projectId)
  return merged
}

// ── Bild-Kategorisierung via Claude-Vision ───────────────────────────────────────
// Klassifiziert jeden Render (Wohnzimmer/Schlafzimmer/Pool/Lobby/Außen …) + kurze
// deutsche Bezeichnung → beschriftete Bildstrecken im generischen Projekt-Deck.
const CATS = ['wohnzimmer', 'schlafzimmer', 'kueche', 'badezimmer', 'esszimmer', 'pool', 'lobby', 'gym', 'aussenbereich', 'fassade', 'aussicht', 'grundriss', 'karte', 'preisliste', 'dokument', 'sonstiges']
// Zeigbare Außen-/Raumbilder (kommen ins Deck, beschriftet). Alles andere wird
// umgeroutet (grundriss→Floorplans, karte→Karte) oder verworfen (preisliste/dokument).
const ROOM_EXT = new Set(['wohnzimmer', 'schlafzimmer', 'kueche', 'badezimmer', 'esszimmer', 'pool', 'lobby', 'gym', 'aussenbereich', 'fassade', 'aussicht'])
const EXTERIOR = new Set(['aussenbereich', 'fassade', 'aussicht'])
// Vision-Ergebnis sortieren: jedes Bild ist geprüft → nur Sinnvolles bleibt.
function sortCategorized(cat: Array<{ url: string; category: string; label: string }>) {
  const gallery   = cat.filter(c => ROOM_EXT.has(c.category))                 // beschriftete Strecken (Außen + Räume)
  const grundriss = cat.filter(c => c.category === 'grundriss')
  const karte     = cat.find(c => c.category === 'karte')?.url ?? null
  const sonst     = cat.filter(c => c.category === 'sonstiges').map(c => c.url) // echte, aber unklare Fotos → nur Notnagel
  // Renders (Cover/Feature) = gute beschriftete Bilder; nur wenn zu wenige, mit
  // unklaren Fotos auffüllen. Preisliste/Dokument kommen NIRGENDS rein.
  const good    = gallery.map(g => g.url)
  const renders = good.length >= 2 ? good : [...good, ...sonst]
  return { gallery, grundriss, karte, renders }
}
// Supabase-Bild-Transformation → verkleinerte Variante (Vision lehnt große Originale
// >5MB/hohe Megapixel ab; Originale waren ~4MB → immer Fallback). 1280px reicht für
// die Raum-Erkennung und ist klein/sicher.
function thumb(u: string): string {
  if (u.includes('/storage/v1/object/public/')) {
    return u.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + (u.includes('?') ? '&' : '?') + 'width=1280&quality=80'
  }
  return u
}
function toBase64(bytes: Uint8Array): string {
  let bin = ''; const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

// ── Broschüre auswerten: eingebettete JPEGs extrahieren ──────────────────────────
// Developer-Broschüren (PDF) enthalten die schönen Innen-/Außen-Renderings + teils
// Grundrisse als eingebettete JPEGs. Wir ziehen sie heraus, damit das Deck echte
// Raumbilder zeigt (Sven: „arbeite die Broschüren besser durch"). Robust ohne
// PDF-Lib: jeder DCTDecode-Stream beginnt mit FFD8FF und liegt roh im File (auch
// bei PDF 1.5+, da Bilddaten nie in komprimierten Objekt-Streams stehen).
function bytesIndexOf(hay: Uint8Array, needle: number[], from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
function jpegDims(buf: Uint8Array): [number, number] {
  let i = 2
  while (i < buf.length - 8) {
    if (buf[i] !== 0xFF) { i++; continue }
    const m = buf[i + 1]
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return [(buf[i + 7] << 8) | buf[i + 8], (buf[i + 5] << 8) | buf[i + 6]]
    }
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue }
    const len = (buf[i + 2] << 8) | buf[i + 3]
    if (len < 2) break
    i += 2 + len
  }
  return [0, 0]
}
const STREAM_KW = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]                         // "stream"
const ENDSTREAM_KW = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]    // "endstream"
function extractBrochureJpegs(pdf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  const seen = new Set<number>()   // gleiche Byte-Länge ⇒ identisches Bild (Broschüren wiederholen Renders)
  for (let i = 0; i < pdf.length - 6; i++) {
    if (pdf[i] !== 0x73) continue
    let kw = true
    for (let k = 1; k < 6; k++) if (pdf[i + k] !== STREAM_KW[k]) { kw = false; break }
    if (!kw) continue
    let s = i + 6
    if (pdf[s] === 0x0d) s++
    if (pdf[s] === 0x0a) s++
    if (!(pdf[s] === 0xFF && pdf[s + 1] === 0xD8 && pdf[s + 2] === 0xFF)) continue
    const end = bytesIndexOf(pdf, ENDSTREAM_KW, s)
    if (end < 0) break
    let e = end
    while (e > s && (pdf[e - 1] === 0x0a || pdf[e - 1] === 0x0d)) e--
    i = end                                       // hinter diesen Stream springen
    const jpg = pdf.subarray(s, e)
    if (jpg.length < 30000 || seen.has(jpg.length)) continue   // Icons/Logos + Duplikate raus
    const [w, h] = jpegDims(jpg)
    if (w < 700 || h < 700) continue              // zu klein
    const ar = w / h
    if (ar < 0.5 || ar > 2.2) continue            // dünne Deko-/Banner-Streifen raus
    seen.add(jpg.length)
    out.push(jpg.slice())
  }
  return out
}
const VISION_PROMPT = `Das sind Bilder aus den Unterlagen eines Immobilien-Projekts auf Zypern — darunter können auch Bilder sein, die NICHT ins Verkaufs-Deck gehören. Ordne JEDES Bild (Index ab 0) GENAU einer Kategorie zu und gib eine kurze deutsche Bezeichnung. Kategorien: ${CATS.join(', ')}.
- Räume/Außen (kommen ins Deck): wohnzimmer, schlafzimmer, kueche, badezimmer, esszimmer, pool, lobby, gym, aussenbereich, fassade, aussicht.
- grundriss = Grundriss/Wohnungsplan (Linienzeichnung mit Räumen/Maßen).
- karte = Landkarte, Lageplan, Standort-Karte, Masterplan-Übersicht.
- preisliste = Preisliste/Preis-Tabelle/Verfügbarkeitstabelle (Spalten mit Einheiten/Preisen).
- dokument = Text-Seite, Logo, Deckblatt mit viel Text, Diagramm, Datenblatt, Banner, Farbverlauf — alles, was KEIN echtes Foto/Rendering eines Raums oder der Anlage ist.
WICHTIG: Im Zweifel, ob ein Bild ein echtes Raum-/Außen-Rendering ist, ordne es preisliste/dokument zu (lieber aussortieren als Müll ins Deck). label = kurze deutsche Bezeichnung (z.B. Wohnzimmer, Master-Schlafzimmer, Dachpool mit Blick über Paphos, Lobby, Fassade bei Nacht). Rufe label_images mit genau einem Eintrag pro Bild auf.`
const VISION_TOOL = {
  name: 'label_images', description: 'Kategorie + Bezeichnung je Bild.',
  input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, category: { type: 'string', enum: CATS }, label: { type: 'string' } }, required: ['index', 'category'] } } }, required: ['items'] },
}
let lastVisionError = ''
async function categorizeImages(urls: string[]): Promise<Array<{ url: string; category: string; label: string }>> {
  lastVisionError = ''
  if (!ANTHROPIC_API_KEY) { lastVisionError = 'ANTHROPIC_API_KEY fehlt'; return urls.map(u => ({ url: u, category: 'sonstiges', label: '' })) }
  // In KLEINEN Batches (sonst sprengt base64 mehrerer Bilder das Anthropic-Request-Limit → 413).
  const BATCH = 6
  const result = new Map<string, { category: string; label: string }>()
  for (let start = 0; start < urls.length; start += BATCH) {
    const batch = urls.slice(start, start + BATCH)
    const content: unknown[] = []
    const local: string[] = []   // tatsächlich geladene Bilder dieses Batches (Index = Position)
    for (const u of batch) {
      try {
        const r = await fetch(thumb(u))
        if (!r.ok) continue
        let ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase()
        if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(ct)) ct = 'image/jpeg'
        content.push({ type: 'text', text: `Bild ${local.length}:` })
        content.push({ type: 'image', source: { type: 'base64', media_type: ct, data: toBase64(new Uint8Array(await r.arrayBuffer())) } })
        local.push(u)
      } catch { /* Bild überspringen */ }
    }
    if (!content.length) { lastVisionError ||= 'kein Bild ladbar'; continue }
    content.push({ type: 'text', text: VISION_PROMPT })
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, tools: [VISION_TOOL], tool_choice: { type: 'tool', name: 'label_images' }, messages: [{ role: 'user', content }] }),
      })
      if (!res.ok) { lastVisionError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`; continue }
      const data = await res.json() as { content?: Array<{ type?: string; input?: { items?: unknown } }> }
      let items = (data.content ?? []).find(c => c.type === 'tool_use')?.input?.items
      if (typeof items === 'string') { try { items = JSON.parse(items) } catch { items = [] } }
      for (const it of (Array.isArray(items) ? items : []) as Array<Record<string, unknown>>) {
        const u = local[Number(it.index)]
        if (u) result.set(u, { category: String(it.category ?? 'sonstiges'), label: String(it.label ?? '') })
      }
    } catch (e) { lastVisionError = `exception: ${(e as Error).message}` }
  }
  return urls.map(u => ({ url: u, category: result.get(u)?.category ?? 'sonstiges', label: result.get(u)?.label ?? '' }))
}

// ── Standort-Pin auf der Karte lokalisieren (Vision) ─────────────────────────
// Der orangene Deck-Marker soll auf dem ECHTEN Pin sitzen (nicht in Bildmitte).
// Liefert %-Koordinaten (x von links, y von oben, an der Pin-Spitze) oder null.
async function detectMapMarker(mapUrl: string): Promise<{ x: number; y: number } | null> {
  if (!ANTHROPIC_API_KEY) return null
  try {
    const r = await fetch(thumb(mapUrl))   // width=1280, Seitenverhältnis bleibt → %-Koords gültig
    if (!r.ok) return null
    let ct = (r.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(ct)) ct = 'image/png'
    const b64 = toBase64(new Uint8Array(await r.arrayBuffer()))
    const tool = {
      name: 'emit_marker', description: 'Position des Standort-Pins als Prozent.',
      input_schema: { type: 'object', properties: {
        found: { type: 'boolean' },
        x: { type: 'number', description: '0-100, horizontal von links (Pin-Spitze)' },
        y: { type: 'number', description: '0-100, vertikal von oben (Pin-Spitze)' },
      }, required: ['found'] },
    }
    const prompt = 'Das ist ein Karten-Ausschnitt (z.B. Google-Maps-Screenshot) zu einem Immobilien-Projekt. Finde den EINEN Standort-Marker/Pin des Projekts — meist ein roter/farbiger Tropfen-Pin, oft mit Beschriftung (Projektname). Gib seine Position als Prozent zurück: x = Abstand vom linken Rand (0-100), y = Abstand vom oberen Rand (0-100), gemessen an der SPITZE des Pins (dem exakt markierten Punkt, NICHT der Mitte der Beschriftung). Gibt es keinen eindeutigen Pin, found=false.'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, tools: [tool], tool_choice: { type: 'tool', name: 'emit_marker' },
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: ct, data: b64 } }, { type: 'text', text: prompt }] }] }),
    })
    if (!res.ok) return null
    const data = await res.json() as { content?: Array<{ type?: string; input?: { found?: boolean; x?: number; y?: number } }> }
    const inp = (data.content ?? []).find(c => c.type === 'tool_use')?.input
    if (!inp?.found || typeof inp.x !== 'number' || typeof inp.y !== 'number') return null
    const clamp = (n: number) => Math.max(2, Math.min(98, Math.round(n)))
    return { x: clamp(inp.x), y: clamp(inp.y) }
  } catch { return null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const body = await req.json() as { project_id?: string; action?: string; folder_id?: string; sync?: boolean; force?: boolean; quiet?: boolean; file_id?: string; data_base64?: string; name?: string; mime?: string; pass?: number; max_bytes?: number; set_hero?: boolean; dry_run?: boolean }
    const { project_id, action, folder_id, sync } = body

    // ── nightly: alle angebundenen Drive-Ordner durchsuchen (Cron ~04:00 CY) ─────
    // Sven 14.8.: jede Nacht alle Ordner durchsuchen — unsere UND die der Developer.
    // Je Projekt mit drive_folder_id: neueste Preisliste ueber alle Quellen suchen
    // (Projektordner, Doc-Unterordner, Developer-Elternordner, drive_external_sources).
    // Geaendert seit letztem Lauf → docs-Spiegel erneuern + parse-pricelist-Sync
    // (Preise + Verfuegbarkeit). Zusaetzlich neue Dateien im "Floor plans"-Ordner
    // melden (Grundriss-Garantie). Mail an Sven NUR wenn sich etwas geaendert hat.
    // Ausloeser der Regel: Luma stellte die Skala-Liste still auf 350k um (14.8.) —
    // Deck an Tobias waere fast mit 330k-Basis rausgegangen.
    if (action === 'nightly') {
      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
      const token = await getReadToken()
      const runNightly = async () => {
      const { data: projs } = await supabase.from('crm_projects')
        .select('id, name, developer, drive_folder_id, deck_assets')
        .not('drive_folder_id', 'is', null)
      const callFn = async (fn: string, b: Record<string, unknown>) => {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
          body: JSON.stringify(b),
        })
        return await r.json().catch(() => ({})) as Record<string, unknown>
      }
      const report: string[] = []
      const errors: string[] = []
      let synced = 0
      let deferred = 0
      // Wall-Time-Schutz der Edge-Runtime: pro DURCHLAUF max. 6 volle Preislisten-
      // Syncs (je ~40s). Frueher hiess das „Rest naechste Nacht" — bei 20 geaenderten
      // Projekten hinkte der Bestand tagelang hinterher (Report 28.8.: 20 changed,
      // 6 synced). Jetzt VERKETTUNG: nach dem Durchlauf ruft sich die Funktion selbst
      // erneut auf (frischer Worker, frisches Zeitbudget), bis alles synchron ist
      // (Deckel 6 Durchlaeufe = 36 Syncs/Nacht). Mail erst am Ende, gesammelt.
      const MAX_SYNCS = 6
      const pass = Math.max(1, Number(body.pass) || 1)
      const MAX_PASSES = 6
      type NightlyState = { pricelist_id?: string; pricelist_mtime?: string; floorplans_newest?: string; last_run?: string; videos_last?: string; dbx_pricelist_path?: string; dbx_pricelist_mtime?: string; dbx_floorplans_newest?: string }
      // Video-Suche laeuft je Projekt hoechstens woechentlich und hoechstens
      // VID_PRO_LAUF mal pro Nacht: sie durchsucht zwei Ordnerebenen und laedt beim
      // Codec-Test Megabytes. Ueber eine Woche ist trotzdem jedes Projekt dran.
      const VID_INTERVALL_MS = 7 * 24 * 60 * 60 * 1000
      const VID_PRO_LAUF = 3
      let vidLaeufe = 0
      for (const pr of (projs ?? []) as Array<{ id: string; name: string; developer?: string | null; drive_folder_id: string; deck_assets?: { drive_sync?: NightlyState } | null }>) {
        try {
          const kids = await listChildren(token, pr.drive_folder_id)
          const files: DriveFile[] = kids.filter(f => !isFolder(f.mimeType))
          for (const sf of kids.filter(f => isFolder(f.mimeType) && /price|preis|payment|zahlung|document|dokument/i.test(f.name)).slice(0, 4)) {
            try { files.push(...(await listChildren(token, sf.id)).filter(f => !isFolder(f.mimeType))) } catch { /* Unterordner optional */ }
          }
          try {
            const dev = await getParentId(token, pr.drive_folder_id)
            if (dev) files.push(...(await listChildren(token, dev)).filter(f => !isFolder(f.mimeType)))
          } catch { /* Developer-Ordner optional */ }
          try {
            const devName = String(pr.developer ?? '').trim()
            if (devName) {
              const { data: src } = await supabase.from('drive_external_sources').select('folder_id').eq('developer_name', devName).eq('active', true).maybeSingle()
              const ext = (src as { folder_id?: string } | null)?.folder_id
              if (ext) files.push(...(await listChildren(token, ext)).filter(f => !isFolder(f.mimeType)))
            }
          } catch { /* externe Quelle optional */ }

          const newest = files.filter(f => docType(f.name) === 'pricelist')
            .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''))[0]
          const fpFolder = kids.find(f => isFolder(f.mimeType) && /floor\s*plan|grundriss|drawings?/i.test(f.name))
          let fpNewest = ''
          let fpCount = 0
          if (fpFolder) {
            try {
              const fps = (await listChildren(token, fpFolder.id)).filter(f => !isFolder(f.mimeType))
              fpCount = fps.length
              fpNewest = fps.map(f => f.modifiedTime ?? '').sort().pop() ?? ''
            } catch { /* Grundriss-Ordner optional */ }
          }

          const state: NightlyState = pr.deck_assets?.drive_sync ?? {}
          const plChanged = !!newest && (newest.id !== state.pricelist_id || (newest.modifiedTime ?? '') !== (state.pricelist_mtime ?? ''))
          const fpChanged = !!fpNewest && fpNewest !== (state.floorplans_newest ?? '')

          let syncNote = ''
          let syncOk = false
          if (plChanged && synced < MAX_SYNCS) {
            synced++
            await callFn('prepare-project-assets', { project_id: pr.id, action: 'docs', force: true })
            const ps = await callFn('parse-pricelist', { project_id: pr.id, create: true })
            if (ps.ok === true) {
              syncOk = true
              syncNote = `Preisliste synchronisiert: ${ps.updated ?? 0} Preise aktualisiert, ${ps.deleted ?? 0} aus dem Angebot genommen, ${ps.created ?? 0} neu`
            } else {
              syncNote = `Preislisten-Sync FEHLER: ${JSON.stringify(ps).slice(0, 160)}`
            }
          } else if (plChanged) {
            deferred++
            // Nur melden, wenn die Verkettung am Deckel ist — sonst kommt fuer das
            // Projekt im selben Lauf ohnehin noch die „synchronisiert"-Zeile.
            if (pass >= MAX_PASSES) syncNote = 'Preisliste geaendert · Sync folgt naechste Nacht'
          }
          // Bewegtbild einsammeln (Projektfilm, Anlage- und Innen-Clip). Das Ergebnis
          // steht in deck_assets.videos, inklusive der Dateien, die aus Codec- oder
          // Groessengruenden NICHT ins Deck koennen.
          let vidNote = ''
          let vidGelaufen = false
          const vidFaellig = !state.videos_last || (Date.now() - Date.parse(state.videos_last)) > VID_INTERVALL_MS
          if (vidFaellig && vidLaeufe < VID_PRO_LAUF) {
            vidLaeufe++
            vidGelaufen = true
            const vs = await callFn('prepare-project-assets', { project_id: pr.id, action: 'videos' })
            if (vs.ok === true) {
              const imDeck = Number(vs.im_deck ?? 0), zuGross = Number(vs.zu_gross ?? 0), codec = Number(vs.codec ?? 0)
              if (imDeck || zuGross || codec) {
                vidNote = `Videos: ${imDeck} im Deck` + (zuGross ? `, ${zuGross} zu gross fuer Selbsthosting (YouTube noetig)` : '') + (codec ? `, ${codec} in H.265 (nicht abspielbar)` : '')
              }
            } else {
              vidNote = `Video-Suche FEHLER: ${JSON.stringify(vs).slice(0, 160)}`
            }
          }

          if (syncNote || fpChanged || vidNote) {
            report.push(`${pr.name}: ${[syncNote || null, fpChanged ? `neue/geaenderte Dateien im Grundriss-Ordner (${fpCount} Dateien)` : null, vidNote || null].filter(Boolean).join(' · ')}`)
          }

          // Zustand fortschreiben. Preislisten-Stand NUR nach erfolgreichem Sync (bzw.
          // wenn nichts zu tun war) — sonst wuerde ein Fehler den Diff verschlucken
          // und die Aenderung nie wieder auffallen.
          const advancePl = !plChanged || syncOk
          const nextState: NightlyState = {
            pricelist_id:      advancePl ? (newest?.id ?? state.pricelist_id) : state.pricelist_id,
            pricelist_mtime:   advancePl ? (newest?.modifiedTime ?? state.pricelist_mtime) : state.pricelist_mtime,
            floorplans_newest: fpNewest || state.floorplans_newest,
            videos_last:       vidGelaufen ? new Date().toISOString() : state.videos_last,
            last_run:          new Date().toISOString(),
          }
          const { data: fresh } = await supabase.from('crm_projects').select('deck_assets').eq('id', pr.id).maybeSingle()
          const da = ((fresh as { deck_assets?: Record<string, unknown> } | null)?.deck_assets ?? {}) as Record<string, unknown>
          await supabase.from('crm_projects').update({ deck_assets: { ...da, drive_sync: nextState } }).eq('id', pr.id)
        } catch (e) {
          errors.push(`${pr.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // ── Dropbox-Quellen (z.B. Kuutio Homes) — crm_projects.dropbox_path ────────
      // Gleiches Prinzip wie Drive: neueste Preisliste im Projektpfad (rekursiv)
      // + im Eltern-Ordner (Developer-Masterliste) suchen, bei Aenderung spiegeln
      // und parse-pricelist create:true (= Verkaufte raus, Preise aktuell).
      const { data: dbxProjsRaw } = await supabase.from('crm_projects')
        .select('id, name, dropbox_path, deck_assets')
        .not('dropbox_path', 'is', null)
      const dbxProjs = (dbxProjsRaw ?? []) as Array<{ id: string; name: string; dropbox_path: string; deck_assets?: { drive_sync?: NightlyState; doc_urls?: Record<string, string> } | null }>
      if (dbxProjs.length) {
        let dbx: string | null = null
        try { dbx = await dropboxToken(supabase) } catch (e) { if (pass === 1) errors.push(`Dropbox: ${e instanceof Error ? e.message : String(e)}`) }
        if (!dbx) {
          if (pass === 1) errors.push(`Dropbox nicht verbunden (connector_secrets DROPBOX_APP_KEY/APP_SECRET/REFRESH_TOKEN fehlen) — ${dbxProjs.length} Projekt(e) mit Dropbox-Quelle werden NICHT ueberwacht.`)
        } else {
          // Eltern-Ordner nur EINMAL je Pfad listen (viele Projekte teilen sich die
          // Developer-Masterliste im selben Root-Ordner).
          const parentCache = new Map<string, DbxEntry[]>()
          for (const pr of dbxProjs) {
            try {
              const base = pr.dropbox_path.replace(/\/+$/, '')
              const own = (await dropboxList(dbx, base, true)).filter(e => e['.tag'] === 'file')
              const parent = base.split('/').slice(0, -1).join('/')
              let parentFiles: DbxEntry[] = []
              if (parent && parent !== '') {
                if (!parentCache.has(parent)) {
                  try { parentCache.set(parent, (await dropboxList(dbx, parent, false)).filter(e => e['.tag'] === 'file')) } catch { parentCache.set(parent, []) }
                }
                parentFiles = parentCache.get(parent) ?? []
              }
              const all = [...own, ...parentFiles]
              // Mehrere Projekte koennen auf DENSELBEN Ordner zeigen (Kuutio: Master-
              // Preisliste im Root fuer Projekte ohne eigenen Ordner). Damit dann nicht
              // die Preisliste eines FREMDEN Projekts gewinnt: Kandidat muss den
              // Projektnamen im Pfad tragen, direkt im Basis-/Elternordner liegen
              // oder eine Master-/Gesamtliste sein.
              const baseDepth = base.split('/').length
              const passtZumProjekt = (f: DbxEntry) => {
                const p = (f.path_display ?? f.path_lower ?? '').toLowerCase()
                const depth = p.split('/').length
                return p.includes(pr.name.toLowerCase()) || depth <= baseDepth + 1 || /master|gesamt|all\s*projects/i.test(f.name)
              }
              const newest = all
                .filter(f => docType(f.name) === 'pricelist' && /\.(pdf|xlsx?|csv)$/i.test(f.name) && passtZumProjekt(f))
                .sort((a, b) => (b.server_modified ?? '').localeCompare(a.server_modified ?? ''))[0]
              const fpFiles = own.filter(f => /floor\s*plan|grundriss/i.test(f.path_display ?? f.name))
              const fpNewest = fpFiles.map(f => f.server_modified ?? '').sort().pop() ?? ''

              const state: NightlyState = pr.deck_assets?.drive_sync ?? {}
              const plChanged = !!newest && ((newest.path_lower ?? '') !== (state.dbx_pricelist_path ?? '') || (newest.server_modified ?? '') !== (state.dbx_pricelist_mtime ?? ''))
              const fpChanged = !!fpNewest && fpNewest !== (state.dbx_floorplans_newest ?? '')

              let syncNote = ''
              let syncOk = false
              if (plChanged && synced < MAX_SYNCS) {
                synced++
                const bytes = await dropboxBytes(dbx, newest!.path_lower ?? '')
                const mime = /\.pdf$/i.test(newest!.name) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                const url = await uploadBytes(supabase, bytes, mime, `projects/${pr.id}/docs`, newest!.name)
                const { data: fr } = await supabase.from('crm_projects').select('deck_assets').eq('id', pr.id).maybeSingle()
                const daNow = ((fr as { deck_assets?: Record<string, unknown> } | null)?.deck_assets ?? {}) as Record<string, unknown>
                const docUrls = { ...((daNow.doc_urls ?? {}) as Record<string, string>), pricelist: url }
                await supabase.from('crm_projects').update({ deck_assets: { ...daNow, doc_urls: docUrls } }).eq('id', pr.id)
                const ps = await callFn('parse-pricelist', { project_id: pr.id, create: true })
                if (ps.ok === true) {
                  syncOk = true
                  syncNote = `Dropbox-Preisliste synchronisiert (${newest!.name}): ${ps.updated ?? 0} Preise aktualisiert, ${ps.deleted ?? 0} aus dem Angebot genommen, ${ps.created ?? 0} neu`
                } else {
                  syncNote = `Dropbox-Preislisten-Sync FEHLER: ${JSON.stringify(ps).slice(0, 160)}`
                }
              } else if (plChanged) {
                deferred++
                if (pass >= MAX_PASSES) syncNote = 'Dropbox-Preisliste geaendert · Sync folgt naechste Nacht'
              }
              if (syncNote || fpChanged) {
                report.push(`${pr.name}: ${[syncNote || null, fpChanged ? `neue/geaenderte Grundriss-Dateien in Dropbox (${fpFiles.length} Dateien)` : null].filter(Boolean).join(' · ')}`)
              }
              const advancePl = !plChanged || syncOk
              const nextState: NightlyState = {
                ...state,
                dbx_pricelist_path:   advancePl ? (newest?.path_lower ?? state.dbx_pricelist_path) : state.dbx_pricelist_path,
                dbx_pricelist_mtime:  advancePl ? (newest?.server_modified ?? state.dbx_pricelist_mtime) : state.dbx_pricelist_mtime,
                dbx_floorplans_newest: fpNewest || state.dbx_floorplans_newest,
                last_run: new Date().toISOString(),
              }
              const { data: fresh } = await supabase.from('crm_projects').select('deck_assets').eq('id', pr.id).maybeSingle()
              const da = ((fresh as { deck_assets?: Record<string, unknown> } | null)?.deck_assets ?? {}) as Record<string, unknown>
              await supabase.from('crm_projects').update({ deck_assets: { ...da, drive_sync: nextState } }).eq('id', pr.id)
            } catch (e) {
              errors.push(`${pr.name} (Dropbox): ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
      }

      // ── Verkettung + gesammelter Abschluss ─────────────────────────────────────
      // Report/Fehler ueber alle Durchlaeufe in crm_settings sammeln; Mail und
      // End-Report erst, wenn nichts mehr offen ist (oder der Durchlauf-Deckel greift).
      type Accum = { report: string[]; errors: string[]; synced: number }
      let acc: Accum = { report: [], errors: [], synced: 0 }
      if (pass > 1) {
        try {
          const { data: a } = await supabase.from('crm_settings').select('value').eq('key', 'drive_sync_accum').maybeSingle()
          const v = (a as { value?: string } | null)?.value
          if (v) acc = JSON.parse(v) as Accum
        } catch { /* dann eben frisch */ }
      }
      const allReport = [...acc.report, ...report]
      const allErrors = [...acc.errors, ...errors]
      const allSynced = acc.synced + synced
      if (deferred > 0 && pass < MAX_PASSES) {
        try {
          await supabase.from('crm_settings').upsert({
            key: 'drive_sync_accum',
            value: JSON.stringify({ report: allReport, errors: allErrors, synced: allSynced }),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'key' })
        } catch (e) { console.warn('[prepare-project-assets] nightly-Accum speichern fehlgeschlagen:', e) }
        console.log(`[prepare-project-assets] nightly Durchlauf ${pass}: ${synced} Syncs, ${deferred} offen → verkette Durchlauf ${pass + 1}`)
        // Frischer Worker = frisches Zeitbudget; der Aufruf antwortet sofort (background).
        try { await callFn('prepare-project-assets', { action: 'nightly', pass: pass + 1, quiet: body.quiet }) }
        catch (e) { console.error('[prepare-project-assets] nightly-Verkettung fehlgeschlagen:', e) }
        return { projects: (projs ?? []).length, changed: report.length, synced, deferred, chained: true, pass }
      }
      try { await supabase.from('crm_settings').delete().eq('key', 'drive_sync_accum') } catch { /* unkritisch */ }
      // quiet=true (manueller Backfill): keine Mail, Report nur in DB/Antwort.
      if ((allReport.length || allErrors.length) && body.quiet !== true) {
        try {
          await callFn('send-email', {
            to: 'sven@happy-property.com',
            subject: `Drive-Sync: ${allReport.length} Projekt(e) mit Aenderungen`,
            html: `<p>Naechtlicher Ordner-Sync (Google Drive + Dropbox — Preislisten, Verfuegbarkeit, Grundriss-Ordner):</p><p>${allReport.map(r => `• ${r}`).join('<br/>')}</p>${allErrors.length ? `<p><b>Fehler:</b><br/>${allErrors.map(r => `• ${r}`).join('<br/>')}</p>` : ''}`,
            auto: true,
            from_name: 'System · Happy Property',
          })
        } catch (e) { console.warn('[prepare-project-assets] nightly-Mail fehlgeschlagen:', e) }
      }
      console.log(`[prepare-project-assets] nightly: ${(projs ?? []).length + dbxProjs.length} Projekte, ${allReport.length} Aenderungen, ${allSynced} Syncs (Durchlaeufe: ${pass}), ${allErrors.length} Fehler`)
      // Ergebnis DB-sichtbar ablegen — der Lauf selbst antwortet dem Aufrufer sofort
      // (Hintergrund), also braucht es eine nachlesbare Spur jenseits der Logs.
      try {
        await supabase.from('crm_settings').upsert({
          key: 'drive_sync_last_report',
          value: JSON.stringify({ at: new Date().toISOString(), projects: (projs ?? []).length + dbxProjs.length, changed: allReport.length, synced: allSynced, passes: pass, report: allReport.slice(0, 40), errors: allErrors.slice(0, 20) }),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'key' })
      } catch (e) { console.warn('[prepare-project-assets] nightly-Report speichern fehlgeschlagen:', e) }
      return { projects: (projs ?? []).length + dbxProjs.length, changed: allReport.length, synced: allSynced, report: allReport, errors: allErrors }
      }   // ── Ende runNightly ──

      // Der volle Lauf dauert laenger als das Gateway-Fenster (~150s) → im Hintergrund
      // ausfuehren und sofort antworten (gleiches Muster wie parse-pricelist background).
      // body.sync=true erzwingt Vordergrund (nur fuer kleine Bestaende/Tests sinnvoll).
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      if (body.sync !== true && er?.waitUntil) {
        er.waitUntil(runNightly().catch(e => console.error('[prepare-project-assets] nightly:', e)))
        return json({ ok: true, action, background: true })
      }
      const out = await runNightly()
      return json({ ok: true, action, ...out })
    }

    if (!project_id) return json({ error: 'project_id fehlt' }, 400)
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
    const { folderId: dbFolder, assets, project } = await loadAssets(supabase, project_id)
    const token = await getReadToken()

    // ── importfile (Debug/Spezialfall): EINE Drive-Datei per ID in Storage holen ──
    // stream:true → Drive-Body direkt in Storage pipen (für große Videos, kein OOM).
    if (action === 'importfile') {
      const fid = body.file_id
      if (!fid) return json({ error: 'file_id fehlt' }, 400)
      const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?fields=name,mimeType,size&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()) as { name?: string; mimeType?: string; size?: string }
      const mime = meta.mimeType ?? 'application/octet-stream'
      // Endung aus Name, sonst aus MIME ableiten — endungslose Drive-Dateien (z.B. „Skala")
      // würden sonst als .bin landen und die Video-Erkennung im Deck aushebeln.
      const MIME_EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png' }
      const nameExt = (meta.name ?? '').toLowerCase().match(/\.([a-z0-9]{2,4})$/)?.[1]
      const ext = nameExt || MIME_EXT[mime] || 'bin'
      // probe:true → nur Codec prüfen (Anfang+Ende per Range laden, moov kann vorn oder
      // hinten liegen). avc1=H.264 (Chrome ok), hvc1/hev1=H.265 (Chrome KANN NICHT).
      if (body.probe) {
        const size = meta.size ? Number(meta.size) : 0
        const range = async (a: number, b: number) => {
          const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}`, Range: `bytes=${a}-${b}` } })
          return r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array()
        }
        const head = await range(0, 8_000_000)
        const tail = size > 12_000_000 ? await range(size - 6_000_000, size - 1) : new Uint8Array()
        const hay = new TextDecoder('latin1').decode(head) + new TextDecoder('latin1').decode(tail)
        const codecs = ['avc1', 'hvc1', 'hev1', 'mp4v', 'av01', 'vp09'].filter(c => hay.includes(c))
        const playable = codecs.some(c => c === 'avc1' || c === 'mp4v')
        return json({ ok: true, probe: true, codecs, playableInChrome: playable, size, mime, name: meta.name })
      }
      if (body.stream) {
        const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
        if (!dl.ok || !dl.body) return json({ error: `Drive-Download ${dl.status}` }, 502)
        const path = `projects/${project_id}/import/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const upInit: RequestInit & { duplex?: string } = {
          method: 'POST',
          headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': mime, 'x-upsert': 'true', ...(meta.size ? { 'Content-Length': meta.size } : {}) },
          body: dl.body,
          duplex: 'half',
        }
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/deck-assets/${path}`, upInit)
        if (!up.ok) return json({ error: `Storage-Upload ${up.status}: ${(await up.text()).slice(0, 300)}` }, 502)
        const url = `${SUPABASE_URL}/storage/v1/object/public/deck-assets/${path}`
        return json({ ok: true, url, name: meta.name, mimeType: mime, size: meta.size ? Number(meta.size) : undefined, streamed: true })
      }
      const expG = GAPPS_EXPORT[mime]
      const url = await uploadBytes(supabase, await driveBytes(token, fid, mime), expG?.mime ?? mime, `projects/${project_id}/import`, expG ? `${meta.name ?? fid}.${expG.ext}` : (meta.name ?? `${fid}.${ext}`))
      return json({ ok: true, url, name: meta.name, mimeType: expG?.mime ?? mime })
    }

    // ── uploadimage: ein fertig aufbereitetes Bild (base64) in Storage ablegen ────
    if (action === 'uploadimage') {
      if (!body.data_base64) return json({ error: 'data_base64 fehlt' }, 400)
      const bytes = Uint8Array.from(atob(body.data_base64), c => c.charCodeAt(0))
      const url = await uploadBytes(supabase, bytes, body.mime ?? 'image/png', `projects/${project_id}/floorplans`, body.name ?? 'floorplan.png')
      return json({ ok: true, url })
    }

    // ── resolve ── Drive-Ordner zum Projekt automatisch finden (Projekte/Developer/Projekt).
    // Braucht KEINEN bestehenden Ordner. Match per Developer + Projektname (enthält-Logik).
    if (action === 'resolve') {
      const ROOT = Deno.env.get('GOOGLE_DRIVE_PROJECTS_ROOT') || '1NZAb497G71DpHA3xa_ApeFpG_c_EKHMz'
      const name = String(project.name ?? '').trim()
      const dev  = String(project.developer ?? '').trim()
      if (!name) return json({ error: 'Projekt hat keinen Namen' }, 400)
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
      const hit = (folderName: string, target: string) => { const a = norm(folderName), b = norm(target); return !!b && (a.includes(b) || b.includes(a)) }
      const devFolders = (await listChildren(token, ROOT)).filter(f => isFolder(f.mimeType))
      const devFolder = dev ? devFolders.find(f => hit(f.name, dev)) : undefined
      let found: DriveFile | undefined
      for (const df of (devFolder ? [devFolder] : devFolders)) {
        const subs = (await listChildren(token, df.id)).filter(f => isFolder(f.mimeType))
        found = subs.find(f => hit(f.name, name)) ?? (hit(df.name, name) ? df : undefined)
        if (found) break
      }
      if (!found) {
        const avail = (devFolder ? (await listChildren(token, devFolder.id)).filter(f => isFolder(f.mimeType)) : devFolders).map(f => f.name)
        return json({ ok: true, found: false, hint: avail.join(', ') })
      }
      await supabase.from('crm_projects').update({ drive_folder_id: found.id }).eq('id', project_id)
      return json({ ok: true, found: true, folder_id: found.id, folder_name: found.name })
    }

    // ── brochure ── eingebettete Renders/Grundrisse aus der Broschüre (PDF) ziehen,
    // kategorisieren und in Gallery/Renders/Grundrisse einspeisen. Braucht KEINEN
    // Drive-Ordner — nutzt die bereits gespeicherte doc_urls.brochure (docs zuvor).
    if (action === 'brochure') {
      const brochureUrl = assets.doc_urls?.brochure
      if (!brochureUrl) return json({ ok: true, action, skipped: true, note: 'keine Broschüre (docs zuerst laufen lassen)' })
      const pdf = new Uint8Array(await (await fetch(brochureUrl)).arrayBuffer())
      const jpegs = extractBrochureJpegs(pdf).slice(0, 16)
      if (!jpegs.length) return json({ ok: true, action, extracted: 0, note: 'keine extrahierbaren Bilder' })
      const urls: string[] = []
      for (const j of jpegs) {
        try { urls.push(await uploadBytes(supabase, j, 'image/jpeg', `projects/${project_id}/brochure`, 'b.jpg', 'crm-project-images')) } catch { /* skip */ }
      }
      // Vision-Gate (gleiches Sieb wie bei Drive-Bildern): nur echte Außen-/Raumbilder,
      // Preislisten/Dokumente raus, Grundrisse/Karten umrouten.
      const cat = await categorizeImages(urls)
      const s = sortCategorized(cat)
      const exteriors  = s.gallery.filter(g => EXTERIOR.has(g.category)).map(g => g.url)
      // Idempotent: frühere Broschüren-Beiträge (Pfad /brochure/) erst entfernen,
      // dann frisch mergen — Mehrfach-Läufe stapeln keine Duplikate.
      const keep = (u: string) => !u.includes('/brochure/')
      // Außenbilder dürfen ins Cover/Feature wandern (sicher), Innenräume nur in die
      // beschriftete Gallery; Grundrisse zu den Floorplans; Lagekarte als Karte.
      const renders = Array.from(new Set([...(assets.renders ?? []).filter(keep), ...exteriors]))
      const gallery = [...(assets.gallery ?? []).filter(g => keep(g.url)), ...s.gallery]
      const floorplans = [...(assets.floorplans ?? []).filter(f => keep(f.url)), ...s.grundriss.map((g, i) => ({ floor: null, label: g.label || `Grundriss ${i + 1}`, url: g.url }))]
      const map = assets.map ?? s.karte ?? null
      await saveAssets(supabase, project_id, { renders, gallery, floorplans, map })
      const byCat: Record<string, number> = {}
      for (const c of cat) byCat[c.category] = (byCat[c.category] ?? 0) + 1
      return json({ ok: true, action, extracted: jpegs.length, uploaded: urls.length, categories: byCat, gallery: gallery.length, floorplans: floorplans.length, debug: lastVisionError })
    }

    const folderId = folder_id?.trim() || dbFolder
    if (!folderId) return json({ error: 'Kein Drive-Ordner — drive_folder_id setzen oder folder_id übergeben' }, 400)

    // ── listfiles (Debug): rohe Dateiliste des Ordners + Unterordner (SA) ────────
    if (action === 'listfiles') {
      const top = await listChildren(token, folderId)
      const out: Array<{ name: string; id: string; mimeType: string; size?: string; folder: string }> = []
      for (const f of top) out.push({ name: f.name, id: f.id, mimeType: f.mimeType, size: f.size, folder: '/' })
      for (const sub of top.filter(f => isFolder(f.mimeType))) {
        try { for (const k of await listChildren(token, sub.id)) out.push({ name: k.name, id: k.id, mimeType: k.mimeType, size: k.size, folder: `/${sub.name}` }) } catch { /* skip */ }
      }
      return json({ ok: true, action, folderId, count: out.length, files: out })
    }

    // ── location: Koordinaten aus dem Location-Doc im Drive-Ordner einlesen ──────
    if (action === 'location') {
      const r = await ingestLocation(token, folderId, supabase, project_id)
      return json({ ok: true, action, ...r })
    }

    // ── images ────────────────────────────────────────────────────────────────
    // ── videoupload ────────────────────────────────────────────────────────────
    // Laedt EINE Drive-Datei nicht gelistet zu YouTube und haengt den Link an den
    // Eintrag in deck_assets.videos. Nur so kommen H.265-Drohnenflüge und die
    // grossen Master-Filme ins Deck. Bewusst kein Automatismus: das Video landet
    // auf Svens Kanal, das loest er selbst aus.
    if (action === 'videoupload') {
      const fid = String(body.file_id ?? '').trim()
      if (!fid) return json({ error: 'file_id fehlt' }, 400)
      const liste = ((assets.videos ?? []) as Array<Record<string, unknown>>)
      const eintrag = liste.find(v => String(v.drive_id) === fid)
      if (!eintrag) return json({ error: 'Video steht nicht in deck_assets.videos - erst die Video-Suche laufen lassen.' }, 400)
      if (eintrag.youtube_url) return json({ ok: true, action, url: eintrag.youtube_url, schon_da: true })
      try {
        const ytToken = await youtubeAccessToken(supabase)
        const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?fields=name,mimeType,size&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()) as { name?: string; mimeType?: string; size?: string }
        const size = Number(meta.size ?? eintrag.size ?? 0)
        if (!size) return json({ error: 'Dateigroesse unbekannt - YouTube braucht sie fuer den Upload.' }, 400)
        const projName = String(project.name ?? '').trim() || 'Projekt'
        const sauber = String(meta.name ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_-]+/g, ' ').trim()
        // Heisst die Datei wie das Projekt ("Mamba .mov"), waere der Titel doppelt.
        const gleich = sauber.toLowerCase().replace(/\s+/g, '') === projName.toLowerCase().replace(/\s+/g, '')
        const titel = (gleich || !sauber ? projName : `${projName} - ${sauber}`).slice(0, 95)
        const url = await driveToYoutube(
          token, ytToken, fid, size, String(meta.mimeType ?? 'video/mp4'), titel,
          `${projName}. Aufnahme des Bautraegers, nicht gelistet - nur ueber den Link in den Unterlagen von Happy Property erreichbar.`,
          body.dry_run === true,
        )
        if (body.dry_run === true) return json({ ok: true, action, dry_run: true, titel, size, mime: meta.mimeType })
        eintrag.youtube_url = url
        eintrag.status = 'ok'
        eintrag.reason = 'nicht gelistet auf YouTube geladen'
        await saveAssets(supabase, project_id, { videos: liste as DeckAssets['videos'] })
        // Fehlt am Projekt noch ein Hauptfilm, uebernimmt ihn der Projekt-Clip.
        if (eintrag.slot === 'projekt' && !String(project.video_url ?? '').trim()) {
          await supabase.from('crm_projects').update({ video_url: url }).eq('id', project_id)
        }
        return json({ ok: true, action, url, titel })
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 502)
      }
    }

    // ── videos ──────────────────────────────────────────────────────────────────
    // Holt Bewegtbild aus dem Drive-Ordner des Projekts in die Decks. Standardisiert:
    // jede gefundene Datei wird geprueft, klassifiziert und mit Begruendung in
    // deck_assets.videos protokolliert — auch die, die NICHT ins Deck kommen. So
    // scheitert nichts still, und Sven sieht, welche Datei auf YouTube gehoert.
    if (action === 'videos') {
      const MAX = Number(body.max_bytes) || VIDEO_MAX_BYTES
      const force = body.force === true

      // 1) Kandidaten einsammeln (Wurzel + zwei Ordnerebenen; Luma legt die
      //    Drohnenclips unter "Drone shots / Roof gardens" ab).
      const found: Array<{ f: DriveFile; folder: string }> = []
      const root = await listChildren(token, folderId)
      for (const f of root.filter(x => isVid(x.mimeType))) found.push({ f, folder: '' })
      for (const sub of root.filter(x => isFolder(x.mimeType)).slice(0, 14)) {
        let kids: DriveFile[] = []
        try { kids = await listChildren(token, sub.id) } catch { continue }
        for (const f of kids.filter(x => isVid(x.mimeType))) found.push({ f, folder: sub.name })
        for (const sub2 of kids.filter(x => isFolder(x.mimeType)).slice(0, 8)) {
          try {
            const kids2 = await listChildren(token, sub2.id)
            for (const f of kids2.filter(x => isVid(x.mimeType))) found.push({ f, folder: `${sub.name} / ${sub2.name}` })
          } catch { /* Unterordner optional */ }
        }
      }

      // 2) Bekannter Stand: unveraenderte Dateien nicht erneut pruefen. Das Proben
      //    laedt je Datei bis zu 7 MB per Range — ohne diesen Cache waere der
      //    naechtliche Lauf teuer und langsam.
      type VideoEntry = {
        drive_id: string; name: string; folder: string; modified?: string; size: number
        width?: number; height?: number; duration_s?: number
        slot: 'projekt' | 'anlage' | 'innen'; orientation: 'quer' | 'hoch'
        // ok        = im Storage, wird im Deck gezeigt
        // kandidat  = spielbar und klein genug, aber nicht ausgewaehlt
        // codec     = H.265 o.ae., kein Browser spielt das
        // zu_gross  = spielbar, aber zu gross fuer Selbsthosting -> YouTube
        // ignoriert = Dateiname sagt: gehoert nicht ins Deck
        status: 'ok' | 'kandidat' | 'codec' | 'zu_gross' | 'ignoriert' | 'fehler'
        codecs?: string[]; url?: string; youtube_url?: string; reason?: string; score?: number
      }
      const prev = new Map<string, VideoEntry>(((assets.videos ?? []) as VideoEntry[]).map(v => [v.drive_id, v]))
      const geprueft: VideoEntry[] = []

      for (const { f, folder } of found.slice(0, 30)) {
        const size = Number(f.size ?? 0)
        const vm = f.videoMediaMetadata ?? {}
        const w = Number(vm.width ?? 0), h = Number(vm.height ?? 0)
        const e: VideoEntry = {
          drive_id: f.id, name: f.name, folder, modified: f.modifiedTime, size,
          width: w || undefined, height: h || undefined,
          duration_s: vm.durationMillis ? Math.round(Number(vm.durationMillis) / 1000) : undefined,
          slot: videoSlot(f.name, folder),
          orientation: h > w && h > 0 ? 'hoch' : 'quer',
          status: 'kandidat',
        }
        const alt = prev.get(f.id)
        // Unveraendert und schon einmal geprueft -> Codec-Ergebnis uebernehmen,
        // statt erneut Megabytes zu laden.
        if (alt && alt.modified === f.modifiedTime && !force && alt.codecs) {
          e.codecs = alt.codecs
          if (alt.status === 'ok' && alt.url) { e.status = 'ok'; e.url = alt.url }
        }
        // Ein einmal zu YouTube geladenes Video bleibt nutzbar - auch wenn es in
        // H.265 vorliegt oder zu gross fuer den Storage ist. Sonst faende der
        // naechste Lauf es wieder als 'codec' vor und das Deck verloere den Film.
        if (alt?.youtube_url) e.youtube_url = alt.youtube_url
        try {
          if (VIDEO_JUNK_RE.test(f.name) || VIDEO_JUNK_RE.test(folder) || RENDITE_RE.test(f.name) || RENDITE_RE.test(folder)) {
            e.status = 'ignoriert'; e.reason = 'Dateiname deutet auf Rohmaterial oder Unterlagen hin, die nicht ins Deck gehoeren'
          } else {
            if (!e.codecs) e.codecs = (await probeVideoCodec(token, f.id, size)).codecs
            const spielbar = e.codecs.some(c => c === 'avc1' || c === 'mp4v')
            if (!spielbar) {
              e.status = 'codec'
              e.reason = `${e.codecs.join(', ') || 'unbekannter Codec'} - Browser koennen das nicht abspielen (H.264/avc1 noetig)`
            } else if (size > MAX) {
              e.status = 'zu_gross'
              e.reason = `${Math.round(size / 1024 / 1024)} MB - zu gross fuer Selbsthosting, gehoert als nicht gelistetes YouTube-Video verlinkt`
            }
          }
        } catch (err) {
          e.status = 'fehler'
          e.reason = err instanceof Error ? err.message : String(err)
        }
        if (e.youtube_url) { e.status = 'kandidat'; e.reason = 'nicht gelistet auf YouTube geladen' }
        e.score = videoScore(e) + (e.youtube_url ? 60 : 0)   // YouTube laeuft ueberall
        geprueft.push(e)
      }

      // 3) Auswahl: je Abschnitt der beste Clip, hoechstens einer. Bautraeger laden
      //    dieselbe Datei mehrfach hoch (Emerald: vier "temp_video_for_share.mp4");
      //    ohne Auswahl landet alles im Storage und das Deck zeigt Dubletten.
      const SLOTS: Array<'projekt' | 'anlage' | 'innen'> = ['projekt', 'anlage', 'innen']
      const gewaehlt = new Set<string>()
      for (const slot of SLOTS) {
        const best = geprueft
          .filter(v => v.slot === slot && (v.status === 'kandidat' || v.status === 'ok'))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
        if (best) gewaehlt.add(best.drive_id)
      }
      for (const e of geprueft) {
        if (e.status !== 'kandidat' && e.status !== 'ok') continue
        if (!gewaehlt.has(e.drive_id)) {
          // Bereits importierte, aber nicht mehr gewaehlte Clips behalten ihre URL
          // (Storage wird nie geleert), verschwinden aber aus dem Deck.
          e.status = 'kandidat'
          e.reason = 'spielbar, aber ein anderer Clip passt besser in diesen Abschnitt'
          continue
        }
        if (e.youtube_url) { e.status = 'ok'; e.reason = 'nicht gelistet auf YouTube'; continue }
        if (e.status === 'ok' && e.url) continue          // schon im Storage
        try {
          const f = found.find(x => x.f.id === e.drive_id)!.f
          e.url = await streamDriveToStorage(token, f.id, f.mimeType, f.name, project_id)
          e.status = 'ok'
          e.reason = undefined
        } catch (err) {
          e.status = 'fehler'
          e.reason = err instanceof Error ? err.message : String(err)
        }
      }

      // 4) Hauptfilm: der gewaehlte Projekt-Clip. Ein von Hand gesetztes video_url
      //    (z.B. ein nicht gelistetes YouTube-Video) wird NIE ueberschrieben.
      const hero = geprueft.find(v => v.status === 'ok' && v.slot === 'projekt')
      const hatHero = !!String(project.video_url ?? '').trim()
      const heroSetzen = !!((hero?.youtube_url || hero?.url) && (!hatHero || body.set_hero === true))
      if (heroSetzen) await supabase.from('crm_projects').update({ video_url: hero!.youtube_url || hero!.url }).eq('id', project_id)

      await saveAssets(supabase, project_id, { videos: geprueft })
      const zaehl = (st: string) => geprueft.filter(v => v.status === st).length
      return json({
        ok: true, action, gefunden: found.length, geprueft: geprueft.length,
        im_deck: zaehl('ok'), kandidaten: zaehl('kandidat'), codec: zaehl('codec'),
        zu_gross: zaehl('zu_gross'), ignoriert: zaehl('ignoriert'), fehler: zaehl('fehler'),
        hero: hero?.url ?? null, hero_gesetzt: heroSetzen,
        videos: geprueft.map(v => ({ name: v.name, folder: v.folder, slot: v.slot, orientation: v.orientation, status: v.status, mb: Math.round(v.size / 1024 / 1024), s: v.duration_s, reason: v.reason })),
      })
    }

    if (action === 'images') {
      const MAX = 12_000_000, RENDER_CAP = 18, FP_CAP = 5
      const children = await listChildren(token, folderId)
      const renderFiles: DriveFile[] = children.filter(f => isImg(f.mimeType))     // Bilder im Wurzelordner
      const fpFiles: DriveFile[] = []
      let locFile: DriveFile | null = null
      for (const sub of children.filter(f => isFolder(f.mimeType))) {
        const cat = folderCategory(sub.name)
        if (!cat) continue
        const kids = await listChildren(token, sub.id)
        // Grundrisse liegen bei manchen Bautraegern NUR als PDF im Ordner (Mamba:
        // 'Drawings'). Ohne PDF kommt fuer solche Projekte nie ein Grundriss an.
        if (cat === 'floorplan') fpFiles.push(...kids.filter(k => isImg(k.mimeType) || k.mimeType === 'application/pdf'))
        else if (cat === 'location') { if (!locFile) locFile = kids.find(k => isImg(k.mimeType)) ?? null }
        else renderFiles.push(...kids.filter(k => isImg(k.mimeType)))
      }
      const small = (f: DriveFile) => !f.size || parseInt(f.size, 10) <= MAX
      // Lose Kartenbilder im Ordner (z.B. "Google Maps Azure.png", "Lageplan.png") als KARTE erkennen,
      // nicht als Render — sonst landet die Karte in der Galerie und der Karten-Slot bleibt leer.
      const MAP_RE = /(google.?maps|karte|lageplan|standort|\bmaps?\b)/i
      // Offensichtlicher Nicht-Render-Müll schon am Dateinamen aussieben (spart Vision +
      // schützt das 18er-Limit für echte Bilder). Das Vision-Gate fängt den Rest ab.
      const JUNK_RE = /(preisliste|pricelist|price.?list|\bprice\b|zahlungsplan|payment|\blogo\b|datasheet|fact.?sheet|spec(ification)?s?|brosch|brochure)/i
      // Renditeprognosen des Bautraegers gehoeren nie ins Deck.
      if (!locFile) {
        const cands = renderFiles.filter(f => MAP_RE.test(f.name))
        locFile = cands.find(small) ?? cands[0] ?? null
      }
      const renders: string[] = []
      for (const f of renderFiles.filter(f => !MAP_RE.test(f.name) && !JUNK_RE.test(f.name) && !RENDITE_RE.test(f.name)).filter(small).slice(0, RENDER_CAP)) {
        try { renders.push(await uploadBytes(supabase, await driveBytes(token, f.id), f.mimeType, `projects/${project_id}/renders`, f.name)) } catch { /* skip */ }
      }
      // Fallback: keine Bilder im Drive-Ordner → bereits im CRM hinterlegte Projektbilder nutzen.
      if (!renders.length && Array.isArray(project.images)) {
        renders.push(...(project.images as string[]).filter(u => typeof u === 'string' && u.startsWith('http')).slice(0, RENDER_CAP))
      }
      const floorplans: DeckAssets['floorplans'] = []
      for (const f of fpFiles.filter(small).slice(0, FP_CAP)) {
        try { floorplans.push({ floor: floorFromName(f.name), label: f.name, url: await uploadBytes(supabase, await driveBytes(token, f.id), f.mimeType, `projects/${project_id}/floorplan`, f.name) }) } catch { /* skip */ }
      }
      let map: string | null = assets.map ?? null
      if (locFile && small(locFile)) { try { map = await uploadBytes(supabase, await driveBytes(token, locFile.id), locFile.mimeType, `projects/${project_id}/map`, locFile.name) } catch { /* keep */ } }
      const mapUrl = (project.google_maps_url as string) || (project.maps_url as string) ||
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${project.name ?? ''} ${project.location ?? 'Paphos'}`)}`

      // ── Vision-Gate: JEDES Kandidatenbild prüfen → nur sinnvolle Außen-/Raumbilder
      // behalten + beschriften, Preislisten/Dokumente/Logos verwerfen, versteckte
      // Grundrisse/Karten umrouten. So landet nie Müll (z.B. eine Preisliste) im Deck.
      let gallery: DeckAssets['gallery'] = []
      let vetted = renders
      if (renders.length) {
        try {
          const s = sortCategorized(await categorizeImages(renders.slice(0, 18)))
          if (s.renders.length) vetted = s.renders
          gallery = s.gallery
          for (const g of s.grundriss) floorplans.push({ floor: null, label: g.label || `Grundriss ${floorplans.length + 1}`, url: g.url })
          if (!map && s.karte) map = s.karte
        } catch { /* Vision optional — Kandidaten bleiben */ }
      }

      // Grundriss je Unit zuordnen. Reihenfolge: ZUERST die Wohnungsnummer im
      // Label oder Dateinamen (eindeutig), erst danach die Etage (grob).
      // Teil-Wohnungen eines Doppelapartments (parent_unit_id) bekommen NUR bei
      // exaktem Nummern-Treffer einen Plan — ein Etagen-Treffer wuerde sonst den
      // Plan der Nachbarwohnung an A2a haengen.
      let unitsMatched = 0
      if (floorplans.length) {
        const { data: units } = await supabase.from('crm_project_units')
          .select('id, unit_number, floor, floorplan_url, parent_unit_id').eq('project_id', project_id)
        // Nummern normalisieren und LAENGSTE zuerst pruefen, damit 'A2' nicht auf
        // 'A2a' oder 'A20' passt. Treffer nur an Token-Grenzen.
        const normU = (v: unknown) => String(v ?? '').toLowerCase().replace(/[\s_-]+/g, '')
        const nummerTrifft = (text: string, nummer: string): boolean => {
          const t = normU(text), n = normU(nummer)
          if (!n) return false
          let i = t.indexOf(n)
          while (i !== -1) {
            const davor = t[i - 1], danach = t[i + n.length]
            const grenze = (c: string | undefined) => c === undefined || !/[a-z0-9]/.test(c)
            if (grenze(davor) && grenze(danach)) return true
            i = t.indexOf(n, i + 1)
          }
          return false
        }
        const sortiert = [...(units ?? []) as Array<Record<string, unknown>>]
          .sort((a, b) => String(b.unit_number ?? '').length - String(a.unit_number ?? '').length)
        for (const u of sortiert) {
          if (u.floorplan_url) continue
          const nummer = String(u.unit_number ?? '')
          const perNummer = floorplans.find(fp => nummerTrifft(`${fp.label ?? ''} ${fp.url ?? ''}`, nummer))
          const match = perNummer ?? (u.parent_unit_id
            ? undefined
            : floorplans.find(fp => fp.floor === ((u.floor as number) ?? parseInt(nummer.charAt(0), 10))))
          if (match) { await supabase.from('crm_project_units').update({ floorplan_url: match.url }).eq('id', u.id as string); unitsMatched++ }
        }
      }
      // Echten Standort-Pin auf der Karte lokalisieren (Vision) → Deck-Marker sitzt
      // genau dort statt in der Bildmitte. Nur neu rechnen, wenn Karte neu/ungeprüft.
      let mapMarker = assets.mapMarker ?? null
      if (map && (map !== assets.map || !mapMarker)) { const mm = await detectMapMarker(map); if (mm) mapMarker = mm }
      await saveAssets(supabase, project_id, { renders: vetted, gallery, floorplans, map, mapUrl, mapMarker })
      // Titelbild + 2 weitere fürs Projekt-Screen (crm_projects.images) — nur GEPRÜFTE Bilder
      const curImgs = Array.isArray(project.images) ? (project.images as string[]).filter(u => typeof u === 'string' && u.startsWith('http')) : []
      if (vetted.length && curImgs.length === 0) {
        await supabase.from('crm_projects').update({ images: vetted.slice(0, 3) }).eq('id', project_id)
      }
      // Koordinaten aus dem Location-Doc mitziehen, wenn das Projekt noch keine hat
      // (macht die Standort-Karte im Deck künftig automatisch korrekt).
      let locResult: Awaited<ReturnType<typeof ingestLocation>> = { found: false }
      if (project.latitude == null || project.longitude == null) {
        try { locResult = await ingestLocation(token, folderId, supabase, project_id) } catch { /* best effort */ }
      }
      return json({ ok: true, action, renders: vetted.length, dropped: renders.length - vetted.length, gallery: gallery.length, floorplans: floorplans.length, map: !!map, unitsMatched, location: locResult })
    }

    // ── categorize ──────────────────────────────────────────────────────────────
    // Vision-Gate: Renders prüfen → beschriftete Bildstrecken (Außen + je Raum),
    // Müll (Preisliste/Dokument) raus, Grundrisse/Karten umrouten.
    if (action === 'categorize') {
      const renders = assets.renders ?? []
      if (!renders.length) return json({ ok: true, action, gallery: 0, skipped: true, note: 'keine Renders' })
      const cat = await categorizeImages(renders.slice(0, 18))
      const s = sortCategorized(cat)
      const floorplans = [...(assets.floorplans ?? [])]
      const seenFp = new Set(floorplans.map(f => f.url))
      for (const g of s.grundriss) if (!seenFp.has(g.url)) floorplans.push({ floor: null, label: g.label || `Grundriss ${floorplans.length + 1}`, url: g.url })
      const map = assets.map ?? s.karte ?? null
      let mapMarker = assets.mapMarker ?? null
      if (map && (map !== assets.map || !mapMarker)) { const mm = await detectMapMarker(map); if (mm) mapMarker = mm }
      await saveAssets(supabase, project_id, { renders: s.renders.length ? s.renders : renders, gallery: s.gallery, floorplans, map, mapMarker })
      const byCat: Record<string, number> = {}
      for (const c of cat) byCat[c.category] = (byCat[c.category] ?? 0) + 1
      return json({ ok: true, action, gallery: s.gallery.length, kept: s.renders.length, dropped: renders.length - s.renders.length, categories: byCat, debug: lastVisionError })
    }

    // ── docs ──────────────────────────────────────────────────────────────────
    if (action === 'docs') {
      const children = await listChildren(token, folderId)
      const projectFiles = children.filter(f => !isFolder(f.mimeType))
      // Doc-Unterordner (Price List, Payment Plan, Documents …) eine Ebene tief
      // mitnehmen — viele Developer legen Preisliste/Zahlungsplan in einen Unterordner
      // (z.B. Arca: Preisliste in „ Price List"). Render-/Bilder-Ordner bleiben außen vor.
      const docSubfolders = children.filter(f => isFolder(f.mimeType) && /price|preis|payment|zahlung|ratenplan|plan|document|dokument|broch|catalog/i.test(f.name))
      const subFiles: DriveFile[] = []
      for (const sf of docSubfolders.slice(0, 6)) {
        try { subFiles.push(...(await listChildren(token, sf.id)).filter(f => !isFolder(f.mimeType))) } catch { /* Unterordner überspringen */ }
      }
      const devFolder = await getParentId(token, folderId)
      const devFiles = devFolder ? (await listChildren(token, devFolder)).filter(f => !isFolder(f.mimeType)) : []
      // Externe Developer-Quelle (z.B. Olias-Drive): getParentId scheitert bei
      // geteilten Ordnern oft → entwicklerweite Preisliste/Zahlungsplan zusätzlich
      // über drive_external_sources (per Developer-Name) holen.
      let extFiles: DriveFile[] = []
      try {
        const devName = String(project.developer ?? '').trim()
        if (devName) {
          const { data: src } = await supabase.from('drive_external_sources').select('folder_id').eq('developer_name', devName).eq('active', true).maybeSingle()
          const extFolderId = (src as { folder_id?: string } | null)?.folder_id
          if (extFolderId && extFolderId !== devFolder) extFiles = (await listChildren(token, extFolderId)).filter(f => !isFolder(f.mimeType))
        }
      } catch { /* externe Quelle optional */ }
      const all = [...projectFiles, ...subFiles, ...devFiles, ...extFiles]
      const pick = (t: string) => all.find(f => docType(f.name) === t)
      // Preisliste: bei mehreren Versionen die NEUESTE nehmen (Developer laden regelmäßig
      // aktualisierte Gesamtlisten hoch — sonst zeigt das CRM veraltete Verfügbarkeiten).
      const newestPricelist = all.filter(f => docType(f.name) === 'pricelist')
        .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''))[0]
      // Broschüre: Namens-Treffer (auch Unterordner), sonst größtes PDF im Projektordner
      let brochure = all.find(f => docType(f.name) === 'brochure')
      if (!brochure) brochure = projectFiles.filter(f => f.mimeType === 'application/pdf' && !RENDITE_RE.test(f.name)).sort((a, b) => (parseInt(b.size ?? '0', 10)) - (parseInt(a.size ?? '0', 10)))[0]
      const cutlery = pick('cutlery'), linen = pick('linen'), pricelist = newestPricelist, spec = pick('spec'), payment = pick('payment')

      const doc_urls: Record<string, string> = { ...(assets.doc_urls ?? {}) }
      const skippedLarge: string[] = []
      // Edge-Memory-Schutz: sehr große Dateien (z.B. Mamba-Broschüre 157 MB) NICHT in den
      // Speicher laden — das killte den Worker („Memory limit exceeded"). 50 MB reicht für
      // normale Broschüren/Preislisten; Riesen-PDFs werden übersprungen statt alles abzubrechen.
      const MAX_DOC_BYTES = 50 * 1024 * 1024
      const importDoc = async (f: DriveFile | undefined, key: string) => {
        if (!f) return
        if (f.size && parseInt(f.size, 10) > MAX_DOC_BYTES) { skippedLarge.push(`${key} (${Math.round(parseInt(f.size, 10) / 1024 / 1024)} MB)`); return }
        try {
          // Bei nativen Google-Dateien Export-MIME + Endung verwenden, sonst landet
          // z.B. ein Sheet ohne .xlsx-Endung im Storage und parse-pricelist erkennt
          // das Format nicht.
          const exp = GAPPS_EXPORT[f.mimeType]
          doc_urls[key] = await uploadBytes(supabase, await driveBytes(token, f.id, f.mimeType), exp?.mime ?? f.mimeType, `projects/${project_id}/docs`, exp ? `${f.name}.${exp.ext}` : f.name)
        } catch (e) { console.warn(`[prepare-project-assets] docs-Import ${key} fehlgeschlagen:`, e) }
      }
      // WICHTIG — Reihenfolge nach Speicher-Risiko + sofortiges Zwischenspeichern:
      // Die Preisliste (kritisch für die Wohnungen) zuerst importieren UND sichern,
      // damit sie einen späteren Memory-Spike (große Broschüre / xlsx) überlebt.
      // Beobachtet: docs lief bei Mamba ins „Memory limit exceeded" — die inkrementelle
      // Sicherung stellt sicher, dass die Preisliste trotzdem ankommt.
      // Preisliste hochladen: PDF, Bild ODER xlsx/xls (Olias u.a. führen die Gesamtliste
      // als Excel — parse-pricelist wandelt xlsx selbst per SheetJS in Text).
      const plIsXlsx = !!pricelist && (/sheet|excel|xlsx/.test(pricelist.mimeType) || /\.xls[x]?$/i.test(pricelist.name))
      if (pricelist && (pricelist.mimeType === 'application/pdf' || pricelist.mimeType.startsWith('image/') || plIsXlsx)) {
        await importDoc(pricelist, 'pricelist')
        await saveAssets(supabase, project_id, { doc_urls })
      }
      await importDoc(cutlery, 'cutlery')
      await importDoc(linen, 'linen')
      if (payment && payment.mimeType === 'application/pdf') await importDoc(payment, 'payment')   // Zahlungsplan (i.d.R. im Developer-Ordner)
      await saveAssets(supabase, project_id, { doc_urls })
      // Broschüre kann groß sein (Arca: 27 MB) → erst nach dem Sichern der Kerndokumente;
      // Riesen-PDFs (>50 MB) überspringt importDoc selbst.
      await importDoc(brochure, 'brochure')

      // Spec-PDF direkt sichern (Claude liest es in der facts-Phase). xlsx wird NUR als
      // Datei abgelegt — die Text-Extraktion (memory-schwere XLSX-Lib, trieb docs bei
      // Mamba ins „Memory limit exceeded") macht die schlanke Funktion parse-spec-xlsx.
      const specXlsx = spec && (/sheet|excel|xlsx/.test(spec.mimeType) || spec.name.toLowerCase().endsWith('.xlsx')) ? spec : null
      if (spec && spec.mimeType === 'application/pdf') await importDoc(spec, 'spec')
      else if (specXlsx) await importDoc(specXlsx, 'spec_xlsx')
      await saveAssets(supabase, project_id, { doc_urls })

      return json({ ok: true, action, found: { brochure: !!doc_urls.brochure, cutlery: !!cutlery, linen: !!linen, pricelist: !!pricelist, spec: !!spec, payment: !!payment }, spec_xlsx: !!specXlsx, skippedLarge, doc_urls: Object.keys(doc_urls) })
    }

    // ── facts ───────────────────────────────────────────────────────────────────
    if (action === 'facts') {
      const du = assets.doc_urls ?? {}
      const docs = [
        du.brochure && { url: du.brochure, label: 'Developer-Broschüre' },
        du.cutlery  && { url: du.cutlery,  label: 'Geschirr/Besteck-Liste' },
        du.linen    && { url: du.linen,    label: 'Wäsche-Liste' },
        du.spec     && { url: du.spec,     label: 'Ausstattungs-Spezifikation' },
        du.payment  && { url: du.payment,  label: 'Zahlungsplan (Payment Plan) — exakte Raten/Prozente übernehmen' },
        // Die Preisliste stand bisher NICHT in dieser Liste - genau dort steht aber,
        // was der Preis enthaelt (z.B. woertlich "Furniture package at 30.000 EUR +
        // 19% VAT" bei Arbeo Park, oder die zweite All-inclusive-Preisspalte bei
        // MITO). Ohne sie hat das Deck Moebel als inklusive behauptet (Sven 26.8.).
        du.pricelist && { url: du.pricelist, label: 'Preisliste — Fuss-/Kopfnoten, Sternchen-Hinweise, Legenden mehrerer Preisspalten und Zusatzkosten WÖRTLICH übernehmen' },
      ].filter(Boolean)
      if (!docs.length && !assets.spec_text) return json({ ok: true, action, facts_chars: 0, skipped: true, note: 'keine Dokumente' })

      const runFacts = async () => {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/extract-project-facts`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ docs, spec_text: assets.spec_text ?? '', context: `Projekt ${project.name ?? ''} (${project.developer ?? ''}), ${project.location ?? 'Paphos'}. Dies ist eine APARTMENT-Wohnanlage.` }),
        })
        const data = await res.json() as { facts?: string }
        if (data.facts) {
          const header = `=== PROJEKT ${project.name ?? ''} (${project.location ?? 'Paphos'}) ===\nBauträger: ${project.developer ?? ''}.`
          await saveAssets(supabase, project_id, { facts: `${header}\n\n${data.facts}`.trim() })
        }
      }
      // Claude liest die Broschüre (~60s). Im Browser-Fall im HINTERGRUND laufen lassen
      // (EdgeRuntime.waitUntil) → sofortige Antwort, kein Verbindungs-Timeout. Server-
      // Aufrufer (Scan) nutzen sync:true und warten das Ergebnis ab.
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      if (!sync && er?.waitUntil) { er.waitUntil(runFacts().catch(() => {})); return json({ ok: true, action, background: true }) }
      await runFacts()
      return json({ ok: true, action, background: false })
    }

    return json({ error: `Unbekannte action: ${action}` }, 400)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
