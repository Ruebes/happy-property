// construction-media — signierte Vorschau-URLs der Baustellenfotos SERVERSEITIG.
//
// Warum: Der private Bucket „construction-photos" braucht signierte URLs. Wurden
// die im BROWSER erzeugt (createSignedUrls mit der Nutzer-Session), war das
// fragil — je nach RLS/Session/Ablauf kamen keine URLs und die Vorschau blieb
// leer. Hier erzeugt der Server sie mit dem Service-Role-Key (umgeht RLS, immer
// verlässlich) und mit 24 h Gültigkeit.
//
//   POST { project_id }  → { photos: [{id,file_path,file_name,photo_date,description}], urls: { <file_path>: <signedUrl> } }
//   Auth: eingeloggter Staff (admin / verwalter / mitarbeiter).
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy construction-media --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const SUPA = Deno.env.get('SUPABASE_URL')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return json({ error: 'Nicht angemeldet' }, 401)
    const { data: udata } = await createClient(SUPA, Deno.env.get('SUPABASE_ANON_KEY') ?? '').auth.getUser(jwt)
    const uid = udata?.user?.id
    if (!uid) return json({ error: 'Nicht angemeldet' }, 401)

    const sb = createClient(SUPA, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: prof } = await sb.from('profiles').select('role').eq('id', uid).maybeSingle()
    const role = (prof as { role?: string } | null)?.role ?? ''
    if (!['admin', 'verwalter', 'mitarbeiter'].includes(role)) return json({ error: 'Keine Berechtigung' }, 403)

    const body = await req.json().catch(() => ({})) as { project_id?: string }
    const projectId = String(body.project_id ?? '').trim()
    if (!projectId) return json({ error: 'project_id fehlt' }, 400)

    const { data: rows } = await sb.from('construction_photos')
      .select('id, file_path, file_name, file_size, photo_date, description, created_at')
      .eq('project_id', projectId)
      .order('photo_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    const photos = (rows ?? []) as Array<{ id: string; file_path: string; file_name: string }>

    const urls: Record<string, string> = {}
    if (photos.length) {
      // Einzeln signieren: eine kaputte/fehlende Datei darf NICHT die ganze Liste
      // kippen (createSignedUrls kann sonst für den ganzen Batch scheitern).
      const paths = photos.map(p => p.file_path)
      const { data: signed } = await sb.storage.from('construction-photos').createSignedUrls(paths, 60 * 60 * 24)
      for (const s of (signed ?? []) as Array<{ path: string | null; signedUrl: string | null; error: string | null }>) {
        if (s.path && s.signedUrl) urls[s.path] = s.signedUrl.startsWith('http') ? s.signedUrl : `${SUPA}/storage/v1${s.signedUrl}`
      }
      // Für alle, die der Batch nicht geliefert hat, einzeln nachsignieren.
      for (const p of paths) {
        if (urls[p]) continue
        const { data: one } = await sb.storage.from('construction-photos').createSignedUrl(p, 60 * 60 * 24)
        const u = (one as { signedUrl?: string } | null)?.signedUrl
        if (u) urls[p] = u.startsWith('http') ? u : `${SUPA}/storage/v1${u}`
      }
    }

    return json({ photos: rows ?? [], urls })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
