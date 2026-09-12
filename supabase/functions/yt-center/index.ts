// yt-center — Motor des YouTube-Centers (/admin/crm/youtube).
//
// Videos werden im Portal vorbereitet (Titel, Beschreibung, Tags, Playlist,
// Thumbnail, Sichtbarkeit, Veröffentlichungszeit) und DIREKT aus dem Browser zu
// YouTube hochgeladen: der Server eröffnet die Resumable-Session mit dem
// Origin-Header des Portals (dann erlaubt Google die PUT-Chunks aus dem Browser),
// die Videodaten laufen nie über Supabase. Damit gibt es kein 80-MB-Limit mehr.
//
// Aktionen (alle POST, JSON):
//   status            → OAuth-Stand + Kanal (Name, Abonnenten, Videos)
//   videos            → lokale Zeilen (yt_videos) + Kanal-Uploads zusammengeführt
//   playlists         → Playlists des Kanals
//   adopt {video_id}  → vorhandenes Kanal-Video ins Center holen (Metadaten bearbeiten)
//   upload_init {id, size, mime, name}  → Resumable-Session (Browser lädt Chunks)
//   upload_status {id}                  → Offset für Fortsetzung nach Abbruch
//   upload_done {id, video_id}          → Video-ID sichern, Thumbnail + Playlist setzen
//   update_video {id}                   → Metadaten auf YouTube schreiben
//   set_thumbnail {id, url}             → Bild (eigener Bucket) auf 1280×720 → YouTube
//   request_approval {id}               → Aufgabe an Sven (Freigabe)
//   approve {id, mode: now|at, publish_at?} → nur Admin: öffentlich / geplant
//   ai_texts {id, brief?}               → Claude im Hintergrund: Titel/Beschreibung/Tags
//   social_posts {id}                   → Social-Post-Entwürfe (FB/IG + LinkedIn) zum Video
//   delete_video {id}                   → nur Admin, nie öffentliche Videos (Upload-Leichen)
//   settings_get / settings_set {footer, default_tags}
//
// Rechte: Admin/Verwalter immer; Mitarbeiter mit permissions.youtube. Mitarbeiter
// können NICHT auf „öffentlich" stellen und keine Veröffentlichung planen — das
// bleibt Svens Freigabe (Muster wie im Social Studio).
//
// Secrets: connector_secrets YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN (Connectoren-
// Seite), ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Deploy: supabase functions deploy yt-center --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { Image } from '../_vendor/imagescript/ImageScript.js'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

type Client = SupabaseClient
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const YT = 'https://www.googleapis.com/youtube/v3'
const PUBLIC_BASE = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://portal.happy-property.com'

interface Profile { id: string; role: string | null; full_name: string | null; permissions: Record<string, boolean> | null }
interface Row {
  id: string; video_id: string | null; title: string; description: string; tags: string[]; category_id: string
  language: string; privacy: string; publish_at: string | null; playlist_id: string | null; playlist_title: string | null
  thumbnail_url: string | null; yt_thumbnail: string | null; duration_sec: number | null; notify_subscribers: boolean
  made_for_kids: boolean; status: string; brief: string | null; ai: Record<string, unknown> | null; ai_pending: boolean
  ai_error: string | null; upload_session: string | null; upload_size: number | null; upload_name: string | null
  upload_mime: string | null; uploaded_by: string | null; approved_by: string | null; approved_at: string | null
  approval_task_id: string | null; published_at: string | null; stats: Record<string, unknown> | null; last_error: string | null
  created_at: string; updated_at: string
}
interface YtVideo {
  id: string
  snippet?: { title?: string; description?: string; tags?: string[]; categoryId?: string; defaultLanguage?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }> }
  status?: { privacyStatus?: string; publishAt?: string; uploadStatus?: string; selfDeclaredMadeForKids?: boolean }
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }
  contentDetails?: { duration?: string }
}

// ── Aufrufer ──────────────────────────────────────────────────────────────────
async function caller(req: Request, sb: Client): Promise<{ service: boolean; profile: Profile | null; admin: boolean; allowed: boolean }> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return { service: false, profile: null, admin: false, allowed: false }
  if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return { service: true, profile: null, admin: true, allowed: true }
  const { data } = await createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!).auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return { service: false, profile: null, admin: false, allowed: false }
  const { data: prof } = await sb.from('profiles').select('id, role, full_name, permissions').eq('id', uid).maybeSingle()
  const p = prof as Profile | null
  const admin = p?.role === 'admin' || p?.role === 'verwalter'
  const allowed = admin || (p?.role === 'mitarbeiter' && !!p.permissions?.youtube)
  return { service: false, profile: p, admin, allowed }
}

// ── YouTube-Zugang ────────────────────────────────────────────────────────────
async function secret(sb: Client, k: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()
  return (data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? ''
}
async function ytToken(sb: Client): Promise<string> {
  const [cid, csec, rtok] = await Promise.all([secret(sb, 'YOUTUBE_CLIENT_ID'), secret(sb, 'YOUTUBE_CLIENT_SECRET'), secret(sb, 'YOUTUBE_REFRESH_TOKEN')])
  if (!cid || !csec || !rtok) throw new Error('YouTube ist nicht verbunden (Einstellungen → Connectoren → YouTube verbinden).')
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }) })
  const d = await r.json() as { access_token?: string; error_description?: string; error?: string }
  if (!d.access_token) throw new Error(`YouTube-OAuth: ${d.error_description ?? d.error ?? r.status}`)
  return d.access_token
}
async function yt<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path.startsWith('http') ? path : `${YT}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const d = await r.json().catch(() => ({})) as T & { error?: { message?: string; errors?: Array<{ reason?: string }> } }
  if (!r.ok) throw new Error(`YouTube ${r.status}: ${d.error?.message ?? 'Fehler'}${d.error?.errors?.[0]?.reason ? ` (${d.error.errors[0].reason})` : ''}`)
  return d
}
const isoDur = (s?: string): number | null => {
  const m = s?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  return m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : null
}
const bestThumb = (v: YtVideo) => v.snippet?.thumbnails?.maxres?.url ?? v.snippet?.thumbnails?.high?.url ?? v.snippet?.thumbnails?.medium?.url ?? v.snippet?.thumbnails?.default?.url ?? null

/** Kanal-Uploads (max. 50) inkl. Status/Statistik. */
async function channelVideos(token: string): Promise<YtVideo[]> {
  const ch = await yt<{ items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(token, 'channels?part=contentDetails&mine=true')
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploads) return []
  const pl = await yt<{ items?: Array<{ snippet?: { resourceId?: { videoId?: string } } }> }>(token, `playlistItems?part=snippet&playlistId=${uploads}&maxResults=50`)
  const ids = (pl.items ?? []).map(i => i.snippet?.resourceId?.videoId).filter((x): x is string => !!x)
  if (!ids.length) return []
  const v = await yt<{ items?: YtVideo[] }>(token, `videos?part=snippet,status,statistics,contentDetails&id=${ids.join(',')}&maxResults=50`)
  return v.items ?? []
}

/** Bild aus dem eigenen Bucket → 1280×720 JPEG → YouTube-Thumbnail. */
async function pushThumbnail(token: string, videoId: string, imgUrl: string) {
  if (!imgUrl.startsWith(`${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/`)) throw new Error('Nur Bilder aus dem Portal (eigener Speicher) können gesetzt werden.')
  const src = await fetch(imgUrl)
  if (!src.ok) throw new Error('Thumbnail-Bild nicht ladbar.')
  const img = await Image.decode(new Uint8Array(await src.arrayBuffer()))
  const W = 1280, H = 720
  let cw = img.width, chh = img.height
  if (cw / chh > W / H) cw = Math.round(chh * (W / H)); else chh = Math.round(cw / (W / H))
  const jpg = await img.clone().crop(Math.round((img.width - cw) / 2), Math.round((img.height - chh) / 2), cw, chh).resize(W, H).encodeJPEG(88)
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: jpg,
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(`Thumbnail: ${d.error?.message ?? r.status}`)
  }
}

const cleanTags = (tags: unknown): string[] => {
  const out: string[] = []
  let len = 0
  for (const t of (Array.isArray(tags) ? tags : []).map(x => String(x).trim()).filter(Boolean)) {
    // YouTube: max. 500 Zeichen gesamt (Tags mit Leerzeichen zählen +2 für Anführungszeichen)
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1
    if (len + cost > 490 || t.length > 100) continue
    if (!out.some(x => x.toLowerCase() === t.toLowerCase())) { out.push(t); len += cost }
  }
  return out
}
const snippetOf = (row: Row) => ({
  title: (row.title || row.upload_name || 'Happy Property Cyprus').replace(/[<>]/g, '').slice(0, 100),
  description: (row.description ?? '').replace(/[<>]/g, '').slice(0, 5000),
  tags: cleanTags(row.tags),
  categoryId: row.category_id || '26',
  defaultLanguage: row.language || 'de',
  defaultAudioLanguage: row.language || 'de',
})

const BRAND = `Du arbeitest für Happy Property Cyprus (Sven Rüprich, Paphos/Zypern):
Vermittlung von Neubau-Kapitalanlagen auf Zypern an deutschsprachige Investoren.
Kernbotschaft: 11-14 % Gesamtertrag p.a. (Miete + Wertsteigerung), freier Markt statt
deutscher Regulierung (Mietendeckel), EU-Rechtsraum, Title Deeds, keine Grunderwerbsteuer
wie in DE. YouTube-Kanal „Happy Property Cyprus" (@HappyPropertyCyprus): Sven erklärt
Kaufen, Rendite, Steuern, Auswandern und stellt Projekte vor.
Ton: locker, direkt, DU-Form, deutsch, seriös in den Zahlen. Keine erfundenen Fakten.
Schreibe echte Umlaute (ä/ö/ü/ß), keine Gedankenstriche, normaler Bindestrich.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const who = await caller(req, sb)
    if (!who.allowed) return json({ error: who.profile ? 'Keine Berechtigung für das YouTube-Center.' : 'Nicht angemeldet.' }, who.profile ? 403 : 401)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action ?? '')
    const rowById = async (id: unknown): Promise<Row> => {
      const { data } = await sb.from('yt_videos').select('*').eq('id', String(id ?? '')).maybeSingle()
      if (!data) throw new Error('Video-Eintrag nicht gefunden.')
      return data as Row
    }
    const touch = (patch: Partial<Row> & Record<string, unknown>, id: string) => sb.from('yt_videos').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)

    // ── Stand + Kanal ────────────────────────────────────────────────────────
    if (action === 'status') {
      try {
        const token = await ytToken(sb)
        const ch = await yt<{ items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> }; statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string } }> }>(token, 'channels?part=snippet,statistics&mine=true')
        const c = ch.items?.[0]
        if (!c) return json({ ok: false, error: 'Kein Kanal am verbundenen Google-Konto.' })
        return json({ ok: true, channel: { id: c.id, title: c.snippet?.title, url: c.snippet?.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}`, avatar: c.snippet?.thumbnails?.default?.url ?? null, subscribers: Number(c.statistics?.subscriberCount ?? 0), videos: Number(c.statistics?.videoCount ?? 0), views: Number(c.statistics?.viewCount ?? 0) }, admin: who.admin })
      } catch (e) { return json({ ok: false, error: (e as Error).message, admin: who.admin }) }
    }

    // ── Videoliste: lokal + Kanal ────────────────────────────────────────────
    if (action === 'videos') {
      const { data: rows } = await sb.from('yt_videos').select('*').order('created_at', { ascending: false })
      const local = (rows ?? []) as Row[]
      let remote: YtVideo[] = []
      let ytError: string | null = null
      try { remote = await channelVideos(await ytToken(sb)) } catch (e) { ytError = (e as Error).message }
      const byId = new Map(remote.map(v => [v.id, v]))
      const mapRemote = (v: YtVideo) => ({
        video_id: v.id, yt_title: v.snippet?.title ?? '', yt_privacy: v.status?.privacyStatus ?? null, yt_publish_at: v.status?.publishAt ?? null,
        yt_published_at: v.snippet?.publishedAt ?? null, yt_upload_status: v.status?.uploadStatus ?? null, yt_thumbnail: bestThumb(v),
        duration_sec: isoDur(v.contentDetails?.duration), views: Number(v.statistics?.viewCount ?? 0), likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0),
      })
      const items = local.map(r => ({ ...r, remote: r.video_id && byId.has(r.video_id) ? mapRemote(byId.get(r.video_id)!) : null }))
      const known = new Set(local.map(r => r.video_id).filter(Boolean))
      const external = remote.filter(v => !known.has(v.id)).map(v => ({ ...mapRemote(v), description: v.snippet?.description ?? '', tags: v.snippet?.tags ?? [], category_id: v.snippet?.categoryId ?? '26', language: v.snippet?.defaultLanguage ?? 'de' }))
      return json({ ok: true, items, external, yt_error: ytError, admin: who.admin })
    }

    if (action === 'playlists') {
      const token = await ytToken(sb)
      const pl = await yt<{ items?: Array<{ id: string; snippet?: { title?: string }; contentDetails?: { itemCount?: number } }> }>(token, 'playlists?part=snippet,contentDetails&mine=true&maxResults=50')
      return json({ ok: true, items: (pl.items ?? []).map(p => ({ id: p.id, title: p.snippet?.title ?? '', count: p.contentDetails?.itemCount ?? 0 })) })
    }

    // ── Bestehendes Kanal-Video ins Center holen ─────────────────────────────
    if (action === 'adopt') {
      const videoId = String(body.video_id ?? '')
      const { data: ex } = await sb.from('yt_videos').select('id').eq('video_id', videoId).maybeSingle()
      if (ex) return json({ ok: true, id: (ex as { id: string }).id })
      const token = await ytToken(sb)
      const v = (await yt<{ items?: YtVideo[] }>(token, `videos?part=snippet,status,contentDetails&id=${encodeURIComponent(videoId)}`)).items?.[0]
      if (!v) return json({ error: 'Video nicht gefunden.' }, 404)
      const pub = v.status?.privacyStatus === 'public'
      const { data: ins, error } = await sb.from('yt_videos').insert({
        video_id: v.id, title: v.snippet?.title ?? '', description: v.snippet?.description ?? '', tags: v.snippet?.tags ?? [],
        category_id: v.snippet?.categoryId ?? '26', language: v.snippet?.defaultLanguage ?? 'de', privacy: v.status?.privacyStatus ?? 'private',
        publish_at: v.status?.publishAt ?? null, yt_thumbnail: bestThumb(v), duration_sec: isoDur(v.contentDetails?.duration),
        status: pub ? 'veroeffentlicht' : v.status?.publishAt ? 'freigegeben' : 'hochgeladen', published_at: pub ? v.snippet?.publishedAt ?? null : null,
        uploaded_by: who.profile?.id ?? null,
      }).select('id').single()
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true, id: (ins as { id: string }).id })
    }

    // ── Upload: Session eröffnen (Browser lädt die Chunks selbst) ────────────
    if (action === 'upload_init') {
      const row = await rowById(body.id)
      if (row.video_id) return json({ error: 'Dieses Video ist schon hochgeladen.' }, 400)
      const size = Number(body.size ?? 0)
      const mime = String(body.mime || 'video/mp4')
      const name = String(body.name ?? '')
      if (!size || size < 1024) return json({ error: 'Datei ist leer.' }, 400)
      const origin = req.headers.get('origin') ?? PUBLIC_BASE
      const token = await ytToken(sb)
      // Mitarbeiter: nie direkt öffentlich, keine geplante Veröffentlichung.
      const privacy = who.admin ? row.privacy : (row.privacy === 'unlisted' ? 'unlisted' : 'private')
      const publishAt = who.admin && privacy === 'private' && row.publish_at && new Date(row.publish_at).getTime() > Date.now() ? new Date(row.publish_at).toISOString() : undefined
      const meta = { snippet: snippetOf({ ...row, upload_name: name }), status: { privacyStatus: privacy, selfDeclaredMadeForKids: !!row.made_for_kids, ...(publishAt ? { publishAt } : {}) } }
      const init = await fetch(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${row.notify_subscribers ? 'true' : 'false'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': mime, Origin: origin },
        body: JSON.stringify(meta),
      })
      const loc = init.headers.get('location')
      if (!init.ok || !loc) return json({ error: `Upload-Start fehlgeschlagen (${init.status}): ${(await init.text()).slice(0, 300)}` }, 502)
      const corsOk = init.headers.get('access-control-allow-origin') === origin
      await touch({ upload_session: loc, upload_size: size, upload_name: name, upload_mime: mime, status: 'laedt', privacy, last_error: null, uploaded_by: row.uploaded_by ?? who.profile?.id ?? null }, row.id)
      return json({ ok: true, session_uri: loc, cors_ok: corsOk, origin })
    }

    if (action === 'upload_status') {
      const row = await rowById(body.id)
      if (!row.upload_session || !row.upload_size) return json({ error: 'Keine laufende Upload-Session.' }, 400)
      const r = await fetch(row.upload_session, { method: 'PUT', headers: { 'Content-Range': `bytes */${row.upload_size}` } })
      if (r.status === 308) {
        const m = (r.headers.get('range') ?? '').match(/bytes=0-(\d+)/)
        return json({ ok: true, offset: m ? Number(m[1]) + 1 : 0 })
      }
      if (r.ok) {
        const d = await r.json().catch(() => ({})) as { id?: string }
        return json({ ok: true, done: true, video_id: d.id ?? null })
      }
      return json({ ok: false, lost: true, error: `Session verloren (${r.status}) - bitte Upload neu starten.` })
    }

    // ── Upload fertig: Video-ID sichern, Thumbnail + Playlist nachziehen ─────
    if (action === 'upload_done') {
      const row = await rowById(body.id)
      const videoId = String(body.video_id ?? '')
      if (!videoId) return json({ error: 'video_id fehlt.' }, 400)
      const token = await ytToken(sb)
      const v = (await yt<{ items?: YtVideo[] }>(token, `videos?part=snippet,status,contentDetails&id=${encodeURIComponent(videoId)}`)).items?.[0]
      if (!v) return json({ error: 'YouTube kennt das Video (noch) nicht.' }, 502)
      const notes: string[] = []
      if (row.thumbnail_url) { try { await pushThumbnail(token, videoId, row.thumbnail_url) } catch (e) { notes.push((e as Error).message) } }
      if (row.playlist_id) {
        try { await yt(token, 'playlistItems?part=snippet', { method: 'POST', body: JSON.stringify({ snippet: { playlistId: row.playlist_id, resourceId: { kind: 'youtube#video', videoId } } }) }) }
        catch (e) { notes.push(`Playlist: ${(e as Error).message}`) }
      }
      const pub = v.status?.privacyStatus === 'public'
      await touch({
        video_id: videoId, status: pub ? 'veroeffentlicht' : v.status?.publishAt ? 'freigegeben' : 'hochgeladen', upload_session: null,
        yt_thumbnail: bestThumb(v), duration_sec: isoDur(v.contentDetails?.duration), published_at: pub ? new Date().toISOString() : null,
        privacy: v.status?.privacyStatus ?? row.privacy, last_error: notes.length ? notes.join(' · ') : null,
      }, row.id)
      return json({ ok: true, video_id: videoId, url: `https://youtu.be/${videoId}`, notes })
    }

    // ── Metadaten auf YouTube schreiben ──────────────────────────────────────
    if (action === 'update_video') {
      const row = await rowById(body.id)
      if (!row.video_id) return json({ error: 'Noch kein Video hochgeladen - Metadaten sind lokal gespeichert.' }, 400)
      const token = await ytToken(sb)
      const cur = (await yt<{ items?: YtVideo[] }>(token, `videos?part=status&id=${encodeURIComponent(row.video_id)}`)).items?.[0]
      if (!cur) return json({ error: 'Video auf YouTube nicht gefunden.' }, 404)
      const curPrivacy = cur.status?.privacyStatus ?? 'private'
      let privacy = row.privacy
      let publishAt: string | undefined = row.publish_at && new Date(row.publish_at).getTime() > Date.now() ? new Date(row.publish_at).toISOString() : undefined
      if (!who.admin) {
        // Mitarbeiter: bestehende Öffentlichkeit bleibt, aber kein Hochstufen und kein Planen.
        if (privacy === 'public' && curPrivacy !== 'public') privacy = curPrivacy === 'unlisted' ? 'unlisted' : 'private'
        if (cur.status?.publishAt) publishAt = cur.status.publishAt; else publishAt = undefined
      }
      if (privacy !== 'private') publishAt = undefined
      const status: Record<string, unknown> = { privacyStatus: privacy, selfDeclaredMadeForKids: !!row.made_for_kids }
      if (publishAt) status.publishAt = publishAt
      await yt(token, 'videos?part=snippet,status', { method: 'PUT', body: JSON.stringify({ id: row.video_id, snippet: snippetOf(row), status }) })
      const notes: string[] = []
      if (row.playlist_id) {
        try {
          const inPl = await yt<{ items?: unknown[] }>(token, `playlistItems?part=id&playlistId=${row.playlist_id}&videoId=${row.video_id}`)
          if (!(inPl.items ?? []).length) await yt(token, 'playlistItems?part=snippet', { method: 'POST', body: JSON.stringify({ snippet: { playlistId: row.playlist_id, resourceId: { kind: 'youtube#video', videoId: row.video_id } } }) })
        } catch (e) { notes.push(`Playlist: ${(e as Error).message}`) }
      }
      const pub = privacy === 'public'
      await touch({ privacy, publish_at: publishAt ?? (privacy === 'private' ? row.publish_at : null), status: pub ? 'veroeffentlicht' : publishAt ? 'freigegeben' : (row.status === 'freigabe' ? 'freigabe' : 'hochgeladen'), published_at: pub ? (row.published_at ?? new Date().toISOString()) : row.published_at, last_error: notes.length ? notes.join(' · ') : null }, row.id)
      return json({ ok: true, privacy, publish_at: publishAt ?? null, notes })
    }

    if (action === 'set_thumbnail') {
      const row = await rowById(body.id)
      const url = String(body.url ?? '')
      if (!url) return json({ error: 'Bild-URL fehlt.' }, 400)
      if (row.video_id) await pushThumbnail(await ytToken(sb), row.video_id, url)
      await touch({ thumbnail_url: url }, row.id)
      return json({ ok: true, pushed: !!row.video_id })
    }

    // ── Freigabe anfragen: Aufgabe an den Admin ──────────────────────────────
    if (action === 'request_approval') {
      const row = await rowById(body.id)
      if (!row.video_id) return json({ error: 'Erst hochladen, dann zur Freigabe schicken.' }, 400)
      const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
      const adminId = (admin as { id: string } | null)?.id ?? null
      const link = `${PUBLIC_BASE}/admin/crm/youtube?v=${row.id}`
      const by = who.profile?.full_name ?? 'Team'
      const when = row.publish_at ? new Date(row.publish_at).toLocaleString('de-DE', { timeZone: 'Asia/Nicosia', dateStyle: 'medium', timeStyle: 'short' }) : null
      const { data: task, error } = await sb.from('crm_tasks').insert({
        title: `▶️ YouTube-Freigabe: ${row.title || row.upload_name || 'Video'}`.slice(0, 200),
        description: `${by} hat ein Video vorbereitet und bittet um Freigabe.\n\nTitel: ${row.title}\nVorschau (privat): https://youtu.be/${row.video_id}\n${when ? `Wunschtermin: ${when} (Zypern-Zeit)\n` : ''}\nFreigeben im YouTube-Center: ${link}`,
        created_by: who.profile?.id ?? adminId, status: 'offen',
      }).select('id').single()
      if (error) return json({ error: error.message }, 500)
      const taskId = (task as { id: string }).id
      if (adminId) {
        await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
        sb.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: taskId } }).catch(e => console.warn('[yt-center] dispatch:', e))
      }
      await touch({ status: 'freigabe', approval_task_id: taskId }, row.id)
      return json({ ok: true, task_id: taskId })
    }

    // ── Freigabe (nur Admin): sofort öffentlich oder geplant ─────────────────
    if (action === 'approve') {
      if (!who.admin) return json({ error: 'Nur Sven/Admin kann Videos freigeben.' }, 403)
      const row = await rowById(body.id)
      if (!row.video_id) return json({ error: 'Kein hochgeladenes Video.' }, 400)
      const mode = String(body.mode ?? 'now')
      const at = mode === 'at' ? new Date(String(body.publish_at ?? row.publish_at ?? '')) : null
      if (mode === 'at' && (!at || isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000)) return json({ error: 'Bitte einen Zeitpunkt in der Zukunft wählen.' }, 400)
      const token = await ytToken(sb)
      const status = mode === 'at' ? { privacyStatus: 'private', publishAt: at!.toISOString(), selfDeclaredMadeForKids: !!row.made_for_kids } : { privacyStatus: 'public', selfDeclaredMadeForKids: !!row.made_for_kids }
      await yt(token, 'videos?part=snippet,status', { method: 'PUT', body: JSON.stringify({ id: row.video_id, snippet: snippetOf(row), status }) })
      const now = new Date().toISOString()
      await touch({ privacy: mode === 'at' ? 'private' : 'public', publish_at: mode === 'at' ? at!.toISOString() : null, status: mode === 'at' ? 'freigegeben' : 'veroeffentlicht', approved_by: who.profile?.id ?? null, approved_at: now, published_at: mode === 'at' ? null : now, last_error: null }, row.id)
      if (row.approval_task_id) await sb.from('crm_tasks').update({ status: 'erledigt' }).eq('id', row.approval_task_id).neq('status', 'erledigt')
      return json({ ok: true, mode, publish_at: mode === 'at' ? at!.toISOString() : null })
    }

    // ── KI-Texte im Hintergrund (Titel, Beschreibung, Tags) ──────────────────
    if (action === 'ai_texts') {
      const row = await rowById(body.id)
      const brief = String(body.brief ?? row.brief ?? '').trim()
      if (!brief && !row.title) return json({ error: 'Bitte kurz beschreiben, worum es im Video geht.' }, 400)
      await touch({ brief: brief || row.brief, ai_pending: true, ai_error: null }, row.id)
      const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
      const { data: fr } = await sb.from('crm_settings').select('key, value').in('key', ['yt_default_tags'])
      const defTags = ((fr ?? []) as Array<{ key: string; value: string }>).find(x => x.key === 'yt_default_tags')?.value ?? ''
      const job = (async () => {
        try {
          const res = await callAnthropic(apiKey, {
            model: 'claude-opus-5', fallbackModels: ['claude-sonnet-5', 'claude-sonnet-4-5'], max_tokens: 3000, label: 'yt-texts',
            system: `${BRAND}\n\nDu bist YouTube-Redakteur und SEO-Profi. Du bekommst ein Briefing zu einem Video und lieferst fertige Metadaten. Rufe GENAU EINMAL set_texts auf.`,
            messages: [{ role: 'user', content: `BRIEFING:\n${brief || '(kein Briefing)'}\n\nAKTUELLER TITEL: ${row.title || '-'}\nAKTUELLE BESCHREIBUNG: ${(row.description || '-').slice(0, 1500)}\n\nSTANDARD-TAGS (immer sinnvoll ergänzen): ${defTags}\n\nERSTELLE:\n- titles: 5 Titelvarianten (max. 65 Zeichen, klick-stark aber ehrlich, Keyword vorne, keine Clickbait-Lügen)\n- description: Beschreibung (250-500 Wörter): Zeile 1-2 = Hook mit Haupt-Keyword (wird in der Suche angezeigt), dann was der Zuschauer lernt (Stichpunkte), dann Kapitel-Vorlage mit Platzhalter-Zeitstempeln (00:00 Intro …) passend zum Briefing, ohne Footer/Links (der Standard-Footer wird automatisch angehängt)\n- tags: 15-25 Tags (kurz, Suchbegriffe, deutsch, inkl. der Standard-Tags)\n- hashtags: 3 Hashtags für die Beschreibung\n- pinned_comment: ein angepinnter Kommentar mit Frage an die Zuschauer + Hinweis auf das kostenlose Erstgespräch\n- social_hook: 1 Satz Hook für den Social-Post zum Video` }],
            tools: [{ name: 'set_texts', description: 'Fertige YouTube-Metadaten.', input_schema: { type: 'object', properties: {
              titles: { type: 'array', items: { type: 'string' } }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
              hashtags: { type: 'array', items: { type: 'string' } }, pinned_comment: { type: 'string' }, social_hook: { type: 'string' },
            }, required: ['titles', 'description', 'tags', 'hashtags', 'pinned_comment'] } }],
            tool_choice: { type: 'tool', name: 'set_texts' },
          })
          const out = toolInput<Record<string, unknown>>(res)
          if (!res.ok || !out) throw new Error(res.error ?? 'Keine Antwort vom Modell.')
          await touch({ ai: { ...out, tags: cleanTags(out.tags), created_at: new Date().toISOString() }, ai_pending: false }, row.id)
        } catch (e) {
          await touch({ ai_pending: false, ai_error: (e as Error).message }, row.id)
        }
      })()
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job); else await job
      return json({ ok: true, pending: true })
    }

    // ── Social-Post-Entwürfe zum Video (über social-agent youtube_post) ──────
    if (action === 'social_posts') {
      const row = await rowById(body.id)
      if (!row.video_id) return json({ error: 'Erst hochladen.' }, 400)
      const { data, error } = await sb.functions.invoke('social-agent', { body: { action: 'youtube_post', video_id: row.video_id, title: row.title, description: row.description, not_before: row.publish_at, as_draft: true, thumb_url: row.thumbnail_url ?? row.yt_thumbnail ?? null } })
      if (error) return json({ error: error.message }, 502)
      return json({ ok: true, ...(data as Record<string, unknown>) })
    }

    // ── Video löschen (nur Admin, nie öffentliche Videos) ────────────────────
    // Für abgebrochene Uploads: YouTube legt schon beim Session-Start einen
    // privaten Eintrag an, der sonst als Leiche auf dem Kanal bleibt.
    if (action === 'delete_video') {
      if (!who.admin) return json({ error: 'Nur Sven/Admin kann Videos löschen.' }, 403)
      const row = await rowById(body.id)
      if (row.video_id) {
        const token = await ytToken(sb)
        const cur = (await yt<{ items?: YtVideo[] }>(token, `videos?part=status,statistics&id=${encodeURIComponent(row.video_id)}`)).items?.[0]
        if (cur?.status?.privacyStatus === 'public') return json({ error: 'Öffentliche Videos werden hier nicht gelöscht - bitte direkt in YouTube.' }, 400)
        if (cur) {
          const r = await fetch(`${YT}/videos?id=${encodeURIComponent(row.video_id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
          if (!r.ok && r.status !== 404) return json({ error: `YouTube ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502)
        }
      }
      await sb.from('yt_videos').delete().eq('id', row.id)
      if (row.approval_task_id) await sb.from('crm_tasks').update({ status: 'erledigt' }).eq('id', row.approval_task_id).neq('status', 'erledigt')
      return json({ ok: true })
    }

    if (action === 'settings_get') {
      const { data } = await sb.from('crm_settings').select('key, value').in('key', ['yt_description_footer', 'yt_default_tags'])
      const m = Object.fromEntries(((data ?? []) as Array<{ key: string; value: string }>).map(x => [x.key, x.value]))
      return json({ ok: true, footer: m.yt_description_footer ?? '', default_tags: m.yt_default_tags ?? '' })
    }
    if (action === 'settings_set') {
      if (!who.admin) return json({ error: 'Nur Admin.' }, 403)
      const ups: Array<{ key: string; value: string; updated_at: string }> = []
      if (typeof body.footer === 'string') ups.push({ key: 'yt_description_footer', value: body.footer, updated_at: new Date().toISOString() })
      if (typeof body.default_tags === 'string') ups.push({ key: 'yt_default_tags', value: body.default_tags, updated_at: new Date().toISOString() })
      if (ups.length) { const { error } = await sb.from('crm_settings').upsert(ups, { onConflict: 'key' }); if (error) return json({ error: error.message }, 500) }
      return json({ ok: true })
    }

    return json({ error: `Unbekannte Aktion: ${action}` }, 400)
  } catch (e) {
    console.error('[yt-center]', e)
    return json({ error: (e as Error).message }, 500)
  }
})
