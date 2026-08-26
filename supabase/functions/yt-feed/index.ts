// Supabase Edge Function: yt-feed
// Liefert die neuesten YouTube-Videos des Happy-Property-Kanals als JSON.
// Wird von der Seite /youtube/ auf steuervorteil-zypern-immobilien.com gelesen,
// damit dort jeden Sonntag automatisch das neue Video oben erscheint.
// Quelle: oeffentlicher RSS-Feed des Kanals (kein API-Key noetig).
// Der Browser kann den Feed nicht direkt lesen (kein CORS-Header bei YouTube),
// deshalb dieser schlanke Proxy mit CORS + Cache.

const CHANNEL_ID = 'UC7SGGkCGeiY8XQZGvdyNr9A' // Happy Property Cyprus
const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

type Video = { id: string; title: string; published: string; url: string; thumb: string }

// Kleiner In-Memory-Cache, damit YouTube nicht bei jedem Seitenaufruf angefragt wird.
let cache: { at: number; videos: Video[] } | null = null
const TTL_MS = 15 * 60 * 1000

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function parseFeed(xml: string): Video[] {
  const out: Video[] = []
  const entries = xml.split('<entry>').slice(1)
  for (const entry of entries) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]
    if (!id || !title) continue
    out.push({
      id,
      title: decode(title),
      published: published ?? '',
      url: `https://www.youtube.com/watch?v=${id}`,
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    })
  }
  // Neueste zuerst.
  out.sort((a, b) => (a.published < b.published ? 1 : -1))
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=900, s-maxage=900',
  }

  try {
    if (cache && Date.now() - cache.at < TTL_MS) {
      return new Response(JSON.stringify({ videos: cache.videos, cached: true }), { headers })
    }
    const res = await fetch(FEED, { headers: { 'User-Agent': 'happy-property-site/1.0' } })
    if (!res.ok) throw new Error(`YouTube-Feed antwortete ${res.status}`)
    const videos = parseFeed(await res.text())
    if (videos.length) cache = { at: Date.now(), videos }
    return new Response(JSON.stringify({ videos }), { headers })
  } catch (e) {
    // Lieber der alte Stand als eine leere Seite.
    if (cache) return new Response(JSON.stringify({ videos: cache.videos, stale: true }), { headers })
    return new Response(JSON.stringify({ videos: [], error: String(e) }), { status: 502, headers })
  }
})
