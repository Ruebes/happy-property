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
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
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
type DriveFile = { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }
const isFolder = (m: string) => m === 'application/vnd.google-apps.folder'
const isImg    = (m: string) => m.startsWith('image/')

async function listChildren(token: string, parentId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`)
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=300&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as { files?: DriveFile[] }
  return data.files ?? []
}
async function getParentId(token: string, fileId: string): Promise<string | null> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as { parents?: string[] }
  return data.parents?.[0] ?? null
}
async function driveBytes(token: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Download ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
async function uploadBytes(supabase: ReturnType<typeof createClient>, bytes: Uint8Array, mime: string, prefix: string, name: string, bucket = 'deck-assets'): Promise<string> {
  const ext  = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType: mime, upsert: false })
  if (error) throw new Error(error.message)
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

// ── Klassifizierung ──────────────────────────────────────────────────────────────
function folderCategory(name: string): 'floorplan' | 'location' | 'render' | null {
  const n = name.toLowerCase()
  if (/floor\s*plan|grundriss|drawings?/.test(n)) return 'floorplan'
  if (/location|lage|master\s*plan/.test(n))      return 'location'
  if (/picture|photo|render|3d|gallery|interior|exterior|pool|view/.test(n)) return 'render'
  return null
}
function floorFromName(name: string): number | null {
  const cn = name.match(/(-?\d+)\s*层/); if (cn) return parseInt(cn[1], 10)               // chinesisch: 3层
  const w = name.toLowerCase().match(/\b(ground|first|second|third|fourth|fifth|sixth|seventh)\b/)
  if (w) return ['ground', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'].indexOf(w[1])
  const d = name.match(/\b(\d+)\s*\.?\s*(og|floor|etage|stock)\b/i); if (d) return parseInt(d[1], 10)
  return null
}
function docType(name: string): 'brochure' | 'pricelist' | 'spec' | 'cutlery' | 'linen' | 'payment' | null {
  const n = name.toLowerCase()
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
  updated_at?: string
}
async function loadAssets(supabase: ReturnType<typeof createClient>, projectId: string): Promise<{ folderId: string | null; assets: DeckAssets; project: Record<string, unknown> }> {
  const { data } = await supabase.from('crm_projects')
    .select('drive_folder_id, deck_assets, name, developer, location, google_maps_url, maps_url, images').eq('id', projectId).maybeSingle()
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
    const { project_id, action, folder_id, sync } = await req.json() as { project_id?: string; action?: string; folder_id?: string; sync?: boolean; force?: boolean }
    if (!project_id) return json({ error: 'project_id fehlt' }, 400)
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
    const { folderId: dbFolder, assets, project } = await loadAssets(supabase, project_id)
    const token = await getReadToken()

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

    // ── images ────────────────────────────────────────────────────────────────
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
        if (cat === 'floorplan') fpFiles.push(...kids.filter(k => isImg(k.mimeType)))
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
      if (!locFile) {
        const cands = renderFiles.filter(f => MAP_RE.test(f.name))
        locFile = cands.find(small) ?? cands[0] ?? null
      }
      const renders: string[] = []
      for (const f of renderFiles.filter(f => !MAP_RE.test(f.name) && !JUNK_RE.test(f.name)).filter(small).slice(0, RENDER_CAP)) {
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

      // Grundriss je Unit (best effort) nach Etage zuordnen
      let unitsMatched = 0
      if (floorplans.length) {
        const { data: units } = await supabase.from('crm_project_units').select('id, unit_number, floor, floorplan_url').eq('project_id', project_id)
        for (const u of (units ?? []) as Array<Record<string, unknown>>) {
          if (u.floorplan_url) continue
          const floor = (u.floor as number) ?? parseInt(String(u.unit_number ?? '').charAt(0), 10)
          const match = floorplans.find(fp => fp.floor === floor)
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
      return json({ ok: true, action, renders: vetted.length, dropped: renders.length - vetted.length, gallery: gallery.length, floorplans: floorplans.length, map: !!map, unitsMatched })
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
      if (!brochure) brochure = projectFiles.filter(f => f.mimeType === 'application/pdf').sort((a, b) => (parseInt(b.size ?? '0', 10)) - (parseInt(a.size ?? '0', 10)))[0]
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
        try { doc_urls[key] = await uploadBytes(supabase, await driveBytes(token, f.id), f.mimeType, `projects/${project_id}/docs`, f.name) } catch { /* skip */ }
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
