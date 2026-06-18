// Supabase Edge Function: scan-drive-projects
// Scannt den Projekte-Root im Google Drive (Struktur: ROOT/Developer/Projekt) und
// legt neue Projekte als crm_projects an (status under_construction, drive_folder_id,
// developer = Name des Developer-Ordners). Optional (ingest=true) stößt die Asset-/
// Deck-Pipeline je Projekt OHNE Deck im Hintergrund an (für Cron/Button).
//
// Body: { dry_run?: boolean, ingest?: boolean }
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ROOT = Deno.env.get('GOOGLE_DRIVE_PROJECTS_ROOT') || '1NZAb497G71DpHA3xa_ApeFpG_c_EKHMz'
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ── Service-Account-Lesetoken (wie prepare-project-assets / google-drive) ─────────
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

type DriveFile = { id: string; name: string; mimeType: string }
const isFolder = (m: string) => m === 'application/vnd.google-apps.folder'
async function listChildren(token: string, parentId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`)
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=300&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as { files?: DriveFile[] }
  return data.files ?? []
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

// Ordner, die KEINE Projekte sind (Asset-/Material-Unterordner direkt unter dem Developer)
const ASSET_RE = /(interior|exterior|render|floor.?plan|grundriss|picture|photo|gallery|video|brochure|brosch|price.?list|preisliste|documents?|dokumente|location|lage|cutlery|besteck|linen|w[äa]sche)/i
const isAssetFolder = (name: string) => ASSET_RE.test(name)

// Edge Function per Service-Role aufrufen
async function callFn(fn: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await res.json().catch(() => ({})) as Record<string, unknown>
}

// Volle Pipeline für EIN Projekt (Assets → Fakten → Units → allgemeines Deck)
async function ingestProject(supabase: ReturnType<typeof createClient>, projectId: string): Promise<void> {
  await callFn('prepare-project-assets', { project_id: projectId, action: 'images', sync: true })
  await callFn('prepare-project-assets', { project_id: projectId, action: 'categorize', sync: true })
  await callFn('prepare-project-assets', { project_id: projectId, action: 'docs', sync: true })
  await callFn('prepare-project-assets', { project_id: projectId, action: 'facts', sync: true })
  await callFn('parse-pricelist', { project_id: projectId, create: true, sync: true })

  const { data: fresh } = await supabase.from('crm_projects').select('deck_assets').eq('id', projectId).maybeSingle()
  const da = (fresh?.deck_assets ?? null) as { facts?: string; renders?: unknown[]; gallery?: unknown[]; floorplans?: { url?: string }[]; map?: string; mapUrl?: string } | null
  if (!da?.facts) return   // ohne Fakten kein Deck — nächster Lauf holt es nach
  const images = { renders: da.renders ?? [], gallery: da.gallery ?? [], floorplan: da.floorplans?.[0]?.url, map: da.map ?? undefined, mapUrl: da.mapUrl ?? undefined }
  const month = new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  await callFn('generate-deck', { generic: true, background: false, project_id: projectId, facts: da.facts, images, month_label: month })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const { dry_run, ingest } = await req.json().catch(() => ({})) as { dry_run?: boolean; ingest?: boolean }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
    const token = await getReadToken()

    // bestehende Projekte
    const { data: existing } = await supabase.from('crm_projects').select('id, name, drive_folder_id, deck_token')
    const byFolder = new Map<string, { id: string; deck_token: string | null; drive_folder_id: string | null }>()
    const byName   = new Map<string, { id: string; deck_token: string | null; drive_folder_id: string | null }>()
    for (const p of (existing ?? []) as Array<{ id: string; name: string; drive_folder_id: string | null; deck_token: string | null }>) {
      if (p.drive_folder_id) byFolder.set(p.drive_folder_id, p)
      byName.set(norm(p.name), p)
    }

    // ROOT → Developer-Ordner → Projekt-Ordner
    const devFolders = (await listChildren(token, ROOT)).filter(f => isFolder(f.mimeType))
    const result: Array<{ name: string; developer: string; folder_id: string; status: string; project_id?: string }> = []
    const needIngest: string[] = []

    for (const dev of devFolders) {
      const projFolders = (await listChildren(token, dev.id)).filter(f => isFolder(f.mimeType))
      for (const pf of projFolders) {
        if (isAssetFolder(pf.name)) { result.push({ name: pf.name, developer: dev.name, folder_id: pf.id, status: 'skipped (Asset-Ordner)' }); continue }
        const match = byFolder.get(pf.id) ?? byName.get(norm(pf.name))
        if (match) {
          if (!match.drive_folder_id && !dry_run) await supabase.from('crm_projects').update({ drive_folder_id: pf.id }).eq('id', match.id)
          if (!match.deck_token) needIngest.push(match.id)
          result.push({ name: pf.name, developer: dev.name, folder_id: pf.id, status: 'existing', project_id: match.id })
          continue
        }
        if (dry_run) { result.push({ name: pf.name, developer: dev.name, folder_id: pf.id, status: 'new' }); continue }
        const { data: ins, error } = await supabase.from('crm_projects')
          .insert({ name: pf.name, developer: dev.name, status: 'under_construction', drive_folder_id: pf.id })
          .select('id').single()
        if (error || !ins) { result.push({ name: pf.name, developer: dev.name, folder_id: pf.id, status: `error: ${error?.message}` }); continue }
        needIngest.push(ins.id as string)
        result.push({ name: pf.name, developer: dev.name, folder_id: pf.id, status: 'created', project_id: ins.id as string })
      }
    }

    // optionale Pipeline je Projekt ohne Deck (Hintergrund; best-effort, idempotent)
    if (ingest && !dry_run && needIngest.length) {
      const run = async () => {
        for (const pid of needIngest) {
          try { await ingestProject(supabase, pid) } catch (e) { console.error(`[scan] Ingest ${pid}:`, e) }
        }
      }
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      if (er?.waitUntil) er.waitUntil(run()); else void run()
    }

    return json({
      ok: true, root: ROOT, developers: devFolders.length, scanned: result.length,
      created: result.filter(r => r.status === 'created').length,
      ingest_queued: ingest && !dry_run ? needIngest.length : 0,
      projects: result,
    })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
