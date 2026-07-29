// youtube-latest — liefert die neuesten YouTube-Videos des Happy-Property-Kanals
// als JSON, damit Landingpages sie ohne API-Key und ohne CORS-Ärger anzeigen können.
//
// Warum überhaupt eine eigene Funktion?
//   YouTubes RSS-Feed ist öffentlich, schickt aber KEINE CORS-Header — ein fetch()
//   direkt aus dem Browser scheitert. Diese Funktion holt den Feed serverseitig,
//   filtert die Shorts heraus und cached das Ergebnis.
//
// GET ?limit=3&channel=UC…&shorts=1
//   limit   Anzahl Videos (Default 3, max 15 — mehr liefert der Feed nicht)
//   channel Kanal-ID (Default: Happy Property Cyprus)
//   shorts  1 = Shorts mitnehmen (Default: nur richtige Videos)
//
// Antwort: { videos: [{ id, title, url, thumbnail, published }], cached }
//
// Deploy: supabase functions deploy youtube-latest --no-verify-jwt

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const DEFAULT_CHANNEL = 'UC7SGGkCGeiY8XQZGvdyNr9A' // Happy Property Cyprus
const CACHE_MS = 6 * 60 * 60 * 1000 // 6 h — Sven lädt etwa wöchentlich hoch

type Video = { id: string; title: string; url: string; thumbnail: string; published: string }
const cache = new Map<string, { at: number; videos: Video[] }>()

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// Shorts erkennen: Sven betitelt sie durchgängig mit Hashtags (#kapitalanlage #paphos),
// die Langvideos nie. Der Feed selbst verrät die Länge nicht, deshalb dieser Marker.
const isShort = (title: string) => /#\w/.test(title)

// Das ECHTE Vorschaubild ermitteln. Falle: für nicht existierende Größen liefert
// YouTube HTTP 404 MIT einem grauen Platzhalter (exakt 1097 Bytes) im Body. Deshalb
// Status UND Mindestgröße prüfen und in der Qualität absteigend durchgehen.
async function thumbFor(id: string): Promise<string> {
  for (const v of ['maxresdefault', 'sddefault', 'hqdefault']) {
    const u = `https://i.ytimg.com/vi/${id}/${v}.jpg`
    try {
      const r = await fetch(u, { method: 'HEAD' })
      if (r.ok && Number(r.headers.get('content-length') ?? 0) > 3000) return u
    } catch { /* nächste Variante */ }
  }
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const url = new URL(req.url)
  const channel = (url.searchParams.get('channel') || DEFAULT_CHANNEL).trim()
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 3) || 3, 1), 15)
  const withShorts = url.searchParams.get('shorts') === '1'
  const key = `${channel}:${withShorts}`

  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), {
    status: s,
    // s-maxage: auch das CDN darf zwischenspeichern, damit wiederholte Seitenaufrufe
    // die Funktion gar nicht erst wecken.
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800, s-maxage=21600' },
  })

  try {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return json({ videos: hit.videos.slice(0, limit), cached: true })
    }

    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel)}`)
    if (!res.ok) throw new Error(`YouTube-Feed antwortete mit ${res.status}`)
    const xml = await res.text()

    const entries = xml.split('<entry>').slice(1)
    const parsed = entries.map(e => {
      const id = e.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] ?? ''
      const title = decode(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
      const published = e.match(/<published>(.*?)<\/published>/)?.[1] ?? ''
      return { id, title, published }
    }).filter(v => v.id && (withShorts || !isShort(v.title)))

    const wanted = parsed.slice(0, 15)
    const videos: Video[] = await Promise.all(wanted.map(async v => ({
      id: v.id,
      title: v.title,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      thumbnail: await thumbFor(v.id),
      published: v.published,
    })))

    cache.set(key, { at: Date.now(), videos })
    return json({ videos: videos.slice(0, limit), cached: false })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[youtube-latest]', msg)
    // Lieber der alte Cache-Stand als eine leere Sektion auf der Danke-Seite.
    const stale = cache.get(key)
    if (stale) return json({ videos: stale.videos.slice(0, limit), cached: true, stale: true })
    return json({ videos: [], error: msg }, 200)
  }
})
