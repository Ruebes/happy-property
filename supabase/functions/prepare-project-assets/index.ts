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
import * as XLSX from 'https://esm.sh/xlsx@0.18.5'

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
type DriveFile = { id: string; name: string; mimeType: string; size?: string }
const isFolder = (m: string) => m === 'application/vnd.google-apps.folder'
const isImg    = (m: string) => m.startsWith('image/')

async function listChildren(token: string, parentId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`)
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size)&pageSize=300&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`
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
async function uploadBytes(supabase: ReturnType<typeof createClient>, bytes: Uint8Array, mime: string, prefix: string, name: string): Promise<string> {
  const ext  = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabase.storage.from('deck-assets').upload(path, bytes, { contentType: mime, upsert: false })
  if (error) throw new Error(error.message)
  return supabase.storage.from('deck-assets').getPublicUrl(path).data.publicUrl
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
function docType(name: string): 'brochure' | 'pricelist' | 'spec' | 'cutlery' | 'linen' | null {
  const n = name.toLowerCase()
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
  doc_urls?: Record<string, string>
  spec_text?: string
  facts?: string
  updated_at?: string
}
async function loadAssets(supabase: ReturnType<typeof createClient>, projectId: string): Promise<{ folderId: string | null; assets: DeckAssets; project: Record<string, unknown> }> {
  const { data } = await supabase.from('crm_projects')
    .select('drive_folder_id, deck_assets, name, developer, location, google_maps_url, maps_url').eq('id', projectId).maybeSingle()
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
const CATS = ['wohnzimmer', 'schlafzimmer', 'kueche', 'badezimmer', 'esszimmer', 'pool', 'lobby', 'gym', 'aussenbereich', 'fassade', 'aussicht', 'grundriss', 'sonstiges']
async function categorizeImages(urls: string[]): Promise<Array<{ url: string; category: string; label: string }>> {
  const fallback = urls.map(u => ({ url: u, category: 'sonstiges', label: '' }))
  if (!ANTHROPIC_API_KEY || !urls.length) return fallback
  const content: unknown[] = []
  urls.forEach((u, i) => { content.push({ type: 'text', text: `Bild ${i}:` }); content.push({ type: 'image', source: { type: 'url', url: u } }) })
  content.push({ type: 'text', text: `Das sind Renderings/Fotos eines Immobilien-Projekts auf Zypern. Ordne JEDES Bild (Index ab 0) einer Kategorie zu und gib eine kurze deutsche Bezeichnung. Kategorien: ${CATS.join(', ')}. label = kurze deutsche Bezeichnung (z.B. Wohnzimmer, Master-Schlafzimmer, Dachpool mit Blick über Paphos, Lobby, Fassade bei Nacht). Rufe label_images mit genau einem Eintrag pro Bild auf.` })
  const TOOL = {
    name: 'label_images', description: 'Kategorie + Bezeichnung je Bild.',
    input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, category: { type: 'string', enum: CATS }, label: { type: 'string' } }, required: ['index', 'category'] } } }, required: ['items'] },
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, tools: [TOOL], tool_choice: { type: 'tool', name: 'label_images' }, messages: [{ role: 'user', content }] }),
    })
    if (!res.ok) return fallback
    const data = await res.json() as { content?: Array<{ type?: string; input?: { items?: unknown } }> }
    let items = (data.content ?? []).find(c => c.type === 'tool_use')?.input?.items
    if (typeof items === 'string') { try { items = JSON.parse(items) } catch { items = [] } }
    const byIdx = new Map<number, { category: string; label: string }>()
    for (const it of (Array.isArray(items) ? items : []) as Array<Record<string, unknown>>) {
      byIdx.set(Number(it.index), { category: String(it.category ?? 'sonstiges'), label: String(it.label ?? '') })
    }
    return urls.map((u, i) => ({ url: u, category: byIdx.get(i)?.category ?? 'sonstiges', label: byIdx.get(i)?.label ?? '' }))
  } catch { return fallback }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const { project_id, action, folder_id } = await req.json() as { project_id?: string; action?: string; folder_id?: string; force?: boolean }
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
      const renders: string[] = []
      for (const f of renderFiles.filter(small).slice(0, RENDER_CAP)) {
        try { renders.push(await uploadBytes(supabase, await driveBytes(token, f.id), f.mimeType, `projects/${project_id}/renders`, f.name)) } catch { /* skip */ }
      }
      const floorplans: DeckAssets['floorplans'] = []
      for (const f of fpFiles.filter(small).slice(0, FP_CAP)) {
        try { floorplans.push({ floor: floorFromName(f.name), label: f.name, url: await uploadBytes(supabase, await driveBytes(token, f.id), f.mimeType, `projects/${project_id}/floorplan`, f.name) }) } catch { /* skip */ }
      }
      let map: string | null = assets.map ?? null
      if (locFile && small(locFile)) { try { map = await uploadBytes(supabase, await driveBytes(token, locFile.id), locFile.mimeType, `projects/${project_id}/map`, locFile.name) } catch { /* keep */ } }
      const mapUrl = (project.google_maps_url as string) || (project.maps_url as string) ||
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${project.name ?? ''} ${project.location ?? 'Paphos'}`)}`

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
      await saveAssets(supabase, project_id, { renders, floorplans, map, mapUrl })
      return json({ ok: true, action, renders: renders.length, floorplans: floorplans.length, map: !!map, unitsMatched })
    }

    // ── categorize ──────────────────────────────────────────────────────────────
    // Renders per Vision in Räume/Bereiche einsortieren → beschriftete Bildstrecken.
    if (action === 'categorize') {
      const renders = assets.renders ?? []
      if (!renders.length) return json({ error: 'Keine Renders — erst action=images ausführen' }, 400)
      const gallery = await categorizeImages(renders.slice(0, 18))
      await saveAssets(supabase, project_id, { gallery })
      const byCat: Record<string, number> = {}
      for (const g of gallery) byCat[g.category] = (byCat[g.category] ?? 0) + 1
      return json({ ok: true, action, gallery: gallery.length, categories: byCat })
    }

    // ── docs ──────────────────────────────────────────────────────────────────
    if (action === 'docs') {
      const projectFiles = (await listChildren(token, folderId)).filter(f => !isFolder(f.mimeType))
      const devFolder = await getParentId(token, folderId)
      const devFiles = devFolder ? (await listChildren(token, devFolder)).filter(f => !isFolder(f.mimeType)) : []
      const all = [...projectFiles, ...devFiles]
      const pick = (t: string) => all.find(f => docType(f.name) === t)
      // Broschüre: Namens-Treffer, sonst größtes PDF im Projektordner
      let brochure = projectFiles.find(f => docType(f.name) === 'brochure')
      if (!brochure) brochure = projectFiles.filter(f => f.mimeType === 'application/pdf').sort((a, b) => (parseInt(b.size ?? '0', 10)) - (parseInt(a.size ?? '0', 10)))[0]
      const cutlery = pick('cutlery'), linen = pick('linen'), pricelist = pick('pricelist'), spec = pick('spec')

      const doc_urls: Record<string, string> = { ...(assets.doc_urls ?? {}) }
      const importDoc = async (f: DriveFile | undefined, key: string) => {
        if (!f) return
        try { doc_urls[key] = await uploadBytes(supabase, await driveBytes(token, f.id), f.mimeType, `projects/${project_id}/docs`, f.name) } catch { /* skip */ }
      }
      await importDoc(brochure, 'brochure')
      await importDoc(cutlery, 'cutlery')
      await importDoc(linen, 'linen')
      if (pricelist && pricelist.mimeType === 'application/pdf') await importDoc(pricelist, 'pricelist')

      // Spec: xlsx → Text (für Claude in der facts-Phase); PDF → Storage
      let spec_text = assets.spec_text ?? ''
      if (spec) {
        if (/sheet|excel|xlsx/.test(spec.mimeType) || spec.name.toLowerCase().endsWith('.xlsx')) {
          try {
            const wb = XLSX.read(await driveBytes(token, spec.id), { type: 'array' })
            spec_text = wb.SheetNames.map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n').replace(/"/g, '').slice(0, 8000)
          } catch { /* xlsx parse fehlgeschlagen */ }
        } else if (spec.mimeType === 'application/pdf') {
          await importDoc(spec, 'spec')
        }
      }
      await saveAssets(supabase, project_id, { doc_urls, spec_text }, spec_text ? { equipment_list: spec_text } : undefined)
      return json({ ok: true, action, found: { brochure: !!brochure, cutlery: !!cutlery, linen: !!linen, pricelist: !!pricelist, spec: !!spec }, spec_chars: spec_text.length, doc_urls: Object.keys(doc_urls) })
    }

    // ── facts ───────────────────────────────────────────────────────────────────
    if (action === 'facts') {
      const du = assets.doc_urls ?? {}
      const docs = [
        du.brochure && { url: du.brochure, label: 'Developer-Broschüre' },
        du.cutlery  && { url: du.cutlery,  label: 'Geschirr/Besteck-Liste' },
        du.linen    && { url: du.linen,    label: 'Wäsche-Liste' },
        du.spec     && { url: du.spec,     label: 'Ausstattungs-Spezifikation' },
      ].filter(Boolean)
      if (!docs.length && !assets.spec_text) return json({ error: 'Keine Dokumente — erst action=docs ausführen' }, 400)

      const res = await fetch(`${SUPABASE_URL}/functions/v1/extract-project-facts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs, spec_text: assets.spec_text ?? '', context: `Projekt ${project.name ?? ''} (${project.developer ?? ''}), ${project.location ?? 'Paphos'}. Dies ist eine APARTMENT-Wohnanlage.` }),
      })
      const data = await res.json() as { facts?: string; error?: string }
      if (!data.facts) return json({ error: `extract-project-facts: ${data.error ?? 'leer'}` }, 502)
      const header = `=== PROJEKT ${project.name ?? ''} (${project.location ?? 'Paphos'}) ===\nBauträger: ${project.developer ?? ''}.`
      const facts = `${header}\n\n${data.facts}`.trim()
      await saveAssets(supabase, project_id, { facts })
      return json({ ok: true, action, facts_chars: facts.length })
    }

    return json({ error: `Unbekannte action: ${action}` }, 400)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
