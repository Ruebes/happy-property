// Supabase Edge Function: yt-feed
// Liefert die Videos des Happy-Property-YouTube-Kanals als JSON, getrennt nach
// ausfuehrlichen Videos und Kurzvideos (Shorts). Gelesen wird das von der Seite
// /youtube/ auf steuervorteil-zypern-immobilien.com, damit dort jeden Sonntag
// automatisch das neue Video oben erscheint, ohne dass jemand die Seite anfasst.
//
// Primaerquelle: YouTube Data API v3 ueber den OAuth-Refresh-Token aus
// connector_secrets (derselbe Zugang wie im Social Studio). Nur so bekommen wir
// Laufzeit und Abrufzahlen und koennen Shorts von langen Videos trennen.
// Faellt der Zugang aus, greift der oeffentliche RSS-Feed als Notnagel (dann
// ohne Trennung, weil der Feed keine Laufzeit kennt).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CHANNEL_ID = 'UC7SGGkCGeiY8XQZGvdyNr9A' // Happy Property Cyprus
const RSS = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`

// Ab dieser Laufzeit gilt ein Video als "ausfuehrlich"; darunter als Kurzvideo.
const LANG_AB_SEKUNDEN = 180

// Nicht auf der Website zeigen (interne Clips, Kundenfilme, Tests).
const AUSGESCHLOSSEN = new Set([
  '0tz0s9esoNE', // Dein Loft Film Sveru Ltd (Kundenfilm, gehoert nicht auf die Seite)
])

// Themen der Seite: die vier anklickbaren Kacheln auf /youtube/.
const THEMEN: Record<string, string> = {
  kaufen: 'Immobilien kaufen auf Zypern',
  rendite: 'Rendite und Kapitalanlage',
  steuern: 'Steuern und Recht',
  auswandern: 'Auswandern und Leben',
  projekte: 'Projekte vorgestellt',
}

// Feste Zuordnungen, die die KI nicht erraten kann (Titel sagt zu wenig).
const THEMA_FEST: Record<string, string> = {
  X2QMXxHqdgw: 'projekte', // Sven Mamba Vlog: Projektbesichtigung vor Ort
}

// Erster Absatz der Videobeschreibung als "Antwort" - aber nur, wenn dort
// wirklich etwas Eigenes steht. Der ueberall gleiche Kanal-Textbaustein
// ("Auf diesem Kanal geht es um ...") liefert keine Antwort und wird ignoriert.
function antwortAusBeschreibung(desc: string | undefined, titel: string): string | null {
  const d = (desc ?? '').trim()
  if (!d || d.startsWith('Auf diesem Kanal geht es um')) return null
  let absatz = d.split(/\n\s*\n/)[0].replace(/#[\p{L}\p{N}_]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (absatz.startsWith('Auf diesem Kanal geht es um')) return null
  // Nur ein Echo des Titels (plus Hashtags) ist keine Antwort.
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (norm(absatz) === norm(titel) || norm(titel).startsWith(norm(absatz))) return null
  if (absatz.length < 40) return null
  return absatz.length > 420 ? absatz.slice(0, 417).trimEnd() + '…' : absatz
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

type Video = {
  id: string
  title: string
  title_full: string
  published: string
  answer: string | null
  url: string
  thumb: string
  thumb_api: string
  duration: number
  duration_label: string
  views: number | null
  kind: 'video' | 'short'
  topic: string
  topic_label: string
}

let cache: { at: number; data: unknown } | null = null
const TTL_MS = 60 * 60 * 1000

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim()
}

// ISO-8601-Dauer (PT10M31S) in Sekunden.
function dauerInSekunden(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '')
  if (!m) return 0
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)
}

function dauerLabel(sek: number): string {
  const h = Math.floor(sek / 3600)
  const m = Math.floor((sek % 3600) / 60)
  const s = sek % 60
  const zwei = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${zwei(m)}:${zwei(s)}` : `${m}:${zwei(s)}`
}


// Hashtags aus dem Titel nehmen (Anzeige auf der Website); der volle Titel
// bleibt als title_full erhalten.
function titelOhneHashtags(t: string): string {
  const sauber = t.replace(/#[\p{L}\p{N}_]+/gu, ' ').replace(/\s{2,}/g, ' ').trim().replace(/[\s.,;:-]+$/u, '')
  return sauber.length >= 12 ? sauber : t.trim()
}

async function apiVideos(): Promise<Video[] | null> {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return null
  const sb = createClient(url, key)
  const secret = async (k: string) =>
    (((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value
      ?? Deno.env.get(k) ?? '').trim()

  const [cid, csec, rtok] = await Promise.all([
    secret('YOUTUBE_CLIENT_ID'), secret('YOUTUBE_CLIENT_SECRET'), secret('YOUTUBE_REFRESH_TOKEN'),
  ])
  if (!cid || !csec || !rtok) return null

  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }),
  })
  const token = (await tr.json() as { access_token?: string }).access_token
  if (!token) return null

  const yt = async <T>(pfad: string): Promise<T> =>
    await fetch(`https://www.googleapis.com/youtube/v3/${pfad}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()) as T

  const ch = await yt<{ items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(
    'channels?part=contentDetails&mine=true')
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploads) return null

  // Alle Uploads einsammeln (Seiten a 50, Deckel bei 200).
  const ids: string[] = []
  let seite: string | undefined
  do {
    const d = await yt<{ items?: Array<{ contentDetails?: { videoId?: string } }>; nextPageToken?: string }>(
      `playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${seite ? `&pageToken=${seite}` : ''}`)
    for (const i of d.items ?? []) if (i.contentDetails?.videoId) ids.push(i.contentDetails.videoId)
    seite = d.nextPageToken
  } while (seite && ids.length < 200)

  const eindeutig = [...new Set(ids)].filter(id => !AUSGESCHLOSSEN.has(id))
  const out: Video[] = []
  for (let i = 0; i < eindeutig.length; i += 50) {
    const d = await yt<{ items?: Array<{
      id: string
      snippet?: { title?: string; publishedAt?: string; description?: string; thumbnails?: Record<string, { url?: string }> }
      contentDetails?: { duration?: string }
      statistics?: { viewCount?: string }
      status?: { privacyStatus?: string; uploadStatus?: string }
    }> }>(`videos?part=snippet,contentDetails,statistics,status&id=${eindeutig.slice(i, i + 50).join(',')}`)
    for (const v of d.items ?? []) {
      // NUR oeffentliche Videos auf die Website lassen. Der OAuth-Zugang sieht
      // auch private und nicht gelistete Uploads (z.B. Videos, die erst spaeter
      // veroeffentlicht werden) - die duerfen hier nicht auftauchen.
      if (v.status?.privacyStatus !== 'public') continue
      if (v.status?.uploadStatus && v.status.uploadStatus !== 'processed') continue
      const sek = dauerInSekunden(v.contentDetails?.duration ?? '')
      const vollerTitel = (v.snippet?.title ?? '').trim()
      out.push({
        id: v.id,
        title: titelOhneHashtags(vollerTitel),
        title_full: vollerTitel,
        published: v.snippet?.publishedAt ?? '',
        answer: antwortAusBeschreibung(v.snippet?.description, vollerTitel),
        url: `https://www.youtube.com/watch?v=${v.id}`,
        thumb: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        thumb_api: bestesBild(v.snippet?.thumbnails),
        duration: sek,
        duration_label: dauerLabel(sek),
        views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : null,
        kind: sek > LANG_AB_SEKUNDEN ? 'video' : 'short',
        topic: '',
        topic_label: '',
      })
    }
  }
  out.sort((a, b) => (a.published < b.published ? 1 : -1))
  return out
}

async function rssVideos(): Promise<Video[]> {
  const xml = await fetch(RSS, { headers: { 'User-Agent': 'happy-property-site/1.0' } }).then(r => r.text())
  const out: Video[] = []
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]
    if (!id || !title || AUSGESCHLOSSEN.has(id)) continue
    out.push({
      id,
      title: titelOhneHashtags(decode(title)),
      title_full: decode(title),
      published: published ?? '',
      answer: antwortAusBeschreibung(decode(entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ?? ''), decode(title)),
      url: `https://www.youtube.com/watch?v=${id}`,
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      thumb_api: '',
      duration: 0,
      duration_label: '',
      views: null,
      kind: 'video',
      topic: '',
      topic_label: '',
    })
  }
  out.sort((a, b) => (a.published < b.published ? 1 : -1))
  return out
}


// ── Themen-Zuordnung ────────────────────────────────────────────────────────
// Jedes Video bekommt genau eines der vier Themen. Einmal bestimmt, liegt das
// Ergebnis in yt_video_topics; neue Videos (z.B. das Sonntagsvideo) werden beim
// naechsten Abruf automatisch nachklassifiziert.
function themaAusText(titel: string): string {
  const t = titel.toLowerCase()
  const treffer = (woerter: string[]) => woerter.filter(w => t.includes(w)).length
  const punkte: Record<string, number> = {
    steuern: treffer(['steuer', 'versteuer', 'abschreib', 'absetzen', 'non-dom', 'firma', 'gesellschaft', 'ltd', 'recht', 'notar', 'vertrag', 'grunderwerb', 'mehrwertsteuer']),
    rendite: treffer(['rendite', 'kapitalanlage', 'investment', 'investier', 'wertsteigerung', 'miete', 'mieteinnahm', 'cashflow', 'eigenkapital', 'ertrag', 'airbnb', 'vermieten', 'boom', 'markt', 'preis', 'kostet', 'rente', 'verm\u00f6gen', 'risiko', 'risiken']),
    kaufen: treffer(['kauf', 'kaufen', 'immobilie kaufen', 'neubau', 'altbau', 'bautr\u00e4ger', 'prozess', 'ablauf', 'besichtig', 'reisen', 'fehler beim immobilienkauf', 'wohnung', 'villa', 'apartment', 'objekt']),
    auswandern: treffer(['auswander', 'ausgewandert', 'leben', 'lebensmittelpunkt', 'umzug', 'community', 'alltag', 'wohnsitz', 'insel', 'urlaub', 'stadtteil', 'region', 'paphos', 'limassol', 'nordzypern'])
  }
  let best = 'kaufen', hoch = -1
  for (const [k, v] of Object.entries(punkte)) if (v > hoch) { best = k; hoch = v }
  return hoch > 0 ? best : 'kaufen'
}


// Bestes von YouTube geliefertes Vorschaubild (die API-URLs sind signiert und
// funktionieren auch dort, wo i.ytimg.com/vi/<id>/hqdefault.jpg 404 liefert).
function bestesBild(t?: Record<string, { url?: string }>): string {
  if (!t) return ''
  for (const k of ['maxres', 'standard', 'high', 'medium', 'default']) {
    if (t[k]?.url) return t[k]!.url as string
  }
  return ''
}

// Manche Videos haben kein oeffentliches Vorschaubild unter der normalen
// i.ytimg.com-Adresse (404 -> graues Platzhalterbild auf der Website). Fuer die
// spiegeln wir das Bild einmalig in unseren eigenen Bucket; das Ergebnis steht
// danach dauerhaft in yt_video_thumbs.
async function thumbsAufloesen(sb: ReturnType<typeof createClient> | null, videos: Video[]): Promise<void> {
  const bekannt = new Map<string, string>()
  if (sb) {
    const { data } = await sb.from('yt_video_thumbs').select('video_id, url')
    for (const r of (data ?? []) as Array<{ video_id: string; url: string }>) bekannt.set(r.video_id, r.url)
  }

  const offen = videos.filter(v => !bekannt.has(v.id))
  const neu: Array<{ video_id: string; url: string; mirrored: boolean }> = []

  for (let i = 0; i < offen.length; i += 10) {
    await Promise.all(offen.slice(i, i + 10).map(async (v) => {
      const standard = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
      let url = standard
      let gespiegelt = false
      try {
        const kopf = await fetch(standard, { method: 'HEAD' })
        if (!kopf.ok && v.thumb_api && sb) {
          const bild = await fetch(v.thumb_api)
          if (bild.ok) {
            const bytes = new Uint8Array(await bild.arrayBuffer())
            const pfad = `youtube/${v.id}.jpg`
            const { error } = await sb.storage.from('ad-creatives')
              .upload(pfad, bytes, { contentType: 'image/jpeg', upsert: true })
            if (!error) {
              url = sb.storage.from('ad-creatives').getPublicUrl(pfad).data.publicUrl
              gespiegelt = true
            } else {
              url = v.thumb_api
            }
          }
        } else if (!kopf.ok && v.thumb_api) {
          url = v.thumb_api
        }
      } catch { /* im Zweifel die Standard-Adresse */ }
      bekannt.set(v.id, url)
      neu.push({ video_id: v.id, url, mirrored: gespiegelt })
    }))
  }
  if (sb && neu.length) await sb.from('yt_video_thumbs').upsert(neu, { onConflict: 'video_id' })
  for (const v of videos) v.thumb = bekannt.get(v.id) ?? v.thumb
}

let letzterKiFehler = ''

async function themenZuordnen(sb: ReturnType<typeof createClient> | null, videos: Video[]): Promise<void> {
  const bekannt = new Map<string, string>()
  if (sb) {
    const { data } = await sb.from('yt_video_topics').select('video_id, topic')
    for (const r of (data ?? []) as Array<{ video_id: string; topic: string }>) bekannt.set(r.video_id, r.topic)
  }

  const offen = videos.filter(v => !bekannt.has(v.id))
  if (offen.length) {
    let zugeordnet: Record<string, string> = {}
    const key = Deno.env.get('ANTHROPIC_API_KEY')
    if (key) {
      try {
        const liste = offen.map(v => `${v.id} :: ${v.title}`).join('\n')
        const prompt = `Ordne jedes YouTube-Video genau einem dieser vier Themen zu:\n`
          + Object.entries(THEMEN).map(([k, l]) => `- ${k}: ${l}`).join('\n')
          + `\n\nVideos:\n${liste}\n\n`
          + `\nHinweise: "projekte" NUR, wenn im Video ein konkretes Bauprojekt, eine konkrete Wohnanlage oder eine bestimmte Immobilie gezeigt, besichtigt oder vorgestellt wird (z.B. Vlog vor Ort, Projektname im Titel). Allgemeine Markt-, Rendite- oder Ratgebervideos gehoeren NICHT dorthin.\n\n`
          + `Antworte AUSSCHLIESSLICH mit einem JSON-Objekt: {"<videoId>":"<themenschluessel>", ...}. `
          + `Nur diese Schluessel verwenden: kaufen, rendite, steuern, auswandern, projekte.`
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
        })
        const d = await r.json() as { content?: Array<{ text?: string }>; error?: { message?: string } }
        if (d.error) letzterKiFehler = `API: ${d.error.message}`
        const text = d.content?.map(c => c.text ?? '').join('') ?? ''
        const roh = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
        zugeordnet = JSON.parse(roh) as Record<string, string>
      } catch (e) { letzterKiFehler = `${letzterKiFehler} || ${String(e)}`; zugeordnet = {} }
    }
    const neu = offen.map(v => {
      const k = zugeordnet[v.id]
      const topic = k && THEMEN[k] ? k : themaAusText(v.title)
      bekannt.set(v.id, topic)
      return { video_id: v.id, title: v.title, topic, source: zugeordnet[v.id] ? 'ai' : 'regel' }
    })
    if (sb && neu.length) await sb.from('yt_video_topics').upsert(neu, { onConflict: 'video_id' })
  }

  for (const v of videos) {
    v.topic = THEMA_FEST[v.id] ?? bekannt.get(v.id) ?? 'kaufen'
    v.topic_label = THEMEN[v.topic] ?? THEMEN.kaufen
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60, s-maxage=60',
  }

  try {
    if (cache && Date.now() - cache.at < TTL_MS && !new URL(req.url).searchParams.get('frisch')) {
      return new Response(JSON.stringify({ ...cache.data as object, cached: true }), { headers })
    }
    let alle: Video[] | null = null
    let quelle = 'api'
    try { alle = await apiVideos() } catch { alle = null }
    if (!alle || !alle.length) { alle = await rssVideos(); quelle = 'rss' }

    const sUrl = Deno.env.get('SUPABASE_URL'), sKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const sb = sUrl && sKey ? createClient(sUrl, sKey) : null
    try { await themenZuordnen(sb, alle) } catch { /* ohne Thema lieber ausliefern als gar nicht */ }
    try { await thumbsAufloesen(sb, alle) } catch { /* Standardbild bleibt stehen */ }

    const data = {
      source: quelle,
      topics: Object.entries(THEMEN).map(([key, label]) => ({
        key, label,
        count: alle!.filter(v => v.topic === key).length,
      })),
      channel: 'https://www.youtube.com/@HappyPropertyCyprus',
      videos: alle.filter(v => v.kind === 'video'),
      shorts: alle.filter(v => v.kind === 'short'),
      alle,
    }
    if (alle.length) cache = { at: Date.now(), data }
    const url = new URL(req.url)
    if (url.searchParams.get('debug')) return new Response(JSON.stringify({ ...data, ki_fehler: letzterKiFehler || null }), { headers })
    return new Response(JSON.stringify(data), { headers })
  } catch (e) {
    if (cache) return new Response(JSON.stringify({ ...cache.data as object, stale: true }), { headers })
    return new Response(JSON.stringify({ videos: [], shorts: [], error: String(e) }), { status: 502, headers })
  }
})
