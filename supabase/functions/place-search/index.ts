// Edge Function: place-search — Orts-/Restaurant-Suche für den Termin-Dialog.
// Proxy auf Photon (OpenStreetMap-Suggest-API, komoot): kostenlos, ohne API-Key,
// stark bei POI-/Restaurant-Namen. Bias auf Paphos/Zypern, damit lokale Treffer
// oben stehen. Der Treffer wird im Frontend zu einem GOOGLE-Maps-Link
// (query=Name lat,lng) — Kunden bekommen also weiterhin Google.
//
// Aufruf: POST { q: "bacco paphos" } → { ok, results: [{ name, display, lat, lon }] }
// Deployment: supabase functions deploy place-search --no-verify-jwt

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Google Maps OHNE API-Key: /maps/search/<q> mit echtem iPhone-UA folgen —
// bei eindeutigem Treffer landet man auf /maps/place/<NAME>/@lat,lng (gleicher
// Trick wie resolve-maps-link; generische UAs bekommen Googles /sorry-CAPTCHA).
async function scrapeMaps(q: string): Promise<{ name: string; display: string; lat: number; lon: number; maps_url: string } | null> {
  // Googles KEYLESS Embed-Endpunkt ist server-gerendert und löst freie Suchen
  // in echte Orte auf (Name, Adresse, Koordinaten) — derselbe Index wie die
  // Kartenvorschau, ganz ohne aktivierte Places-API.
  const hasRegion = /zypern|cyprus|paphos|pafos|limassol|nicosia|larnaca|deutschland|germany/i.test(q)
  const q2 = hasRegion ? q : `${q}, Cyprus`
  try {
    const r = await fetch(`https://www.google.com/maps/embed?origin=mfe&pb=!1m2!2m1!1s${encodeURIComponent(q2)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Cookie: 'CONSENT=YES+cb; SOCS=CAI',
      },
    })
    if (!r.ok) return null
    const html = await r.text()
    const m = html.match(/\["0x[0-9a-f]+:0x[0-9a-f]+","((?:[^"\\]|\\.)*)",\[(-?\d+\.\d+),(-?\d+\.\d+)\]/)
    if (!m) return null
    const display = JSON.parse(`"${m[1]}"`) as string
    const name = display.split(',')[0].trim()
    return {
      name, display, lat: Number(m[2]), lon: Number(m[3]),
      maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(display)}`,
    }
  } catch (e) { console.warn('[place-search] embed-scrape:', e); return null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  try {
    const { q } = await req.json() as { q?: string }
    const query = (q ?? '').trim()
    if (query.length < 3) return json({ ok: true, results: [] })
    // lat/lon = Prior (Paphos): sortiert nahe Treffer nach oben, ohne ferne auszuschließen
    // GOOGLE PLACES zuerst (kennt Cafés/POIs wie „Cultivos" in Paphos, die in
    // OpenStreetMap fehlen), mit Zypern-Bias. Photon/OSM nur als Fallback.
    const gkey = Deno.env.get('GOOGLE_API_KEY') ?? ''
    if (gkey) {
      try {
        const g = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gkey,
            'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location' },
          body: JSON.stringify({ textQuery: query, languageCode: 'de', pageSize: 6,
            locationBias: { circle: { center: { latitude: 34.77, longitude: 32.42 }, radius: 50000 } } }),
        })
        const gj = await g.json()
        if (g.ok && Array.isArray(gj.places) && gj.places.length) {
          const results = gj.places.map((pl: { displayName?: { text?: string }; formattedAddress?: string; location?: { latitude?: number; longitude?: number } }) => ({
            name: pl.displayName?.text ?? '', display: pl.formattedAddress ?? '',
            lat: pl.location?.latitude ?? 0, lon: pl.location?.longitude ?? 0,
          })).filter((x: { name: string; lat: number }) => x.name && x.lat)
          if (results.length) return json({ ok: true, results })
        } else if (!g.ok) console.warn('[place-search] Google Places(new):', JSON.stringify(gj).slice(0, 150))
        // Fallback: klassische Places-API (oft schon freigeschaltet)
        const lg = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=34.77,32.42&radius=50000&language=de&key=${gkey}`)
        const lj = await lg.json()
        if (Array.isArray(lj.results) && lj.results.length) {
          const results = lj.results.slice(0, 6).map((pl: { name?: string; formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }) => ({
            name: pl.name ?? '', display: pl.formatted_address ?? '',
            lat: pl.geometry?.location?.lat ?? 0, lon: pl.geometry?.location?.lng ?? 0,
          })).filter((x: { name: string; lat: number }) => x.name && x.lat)
          if (results.length) return json({ ok: true, results })
        } else if (lj.status && lj.status !== 'ZERO_RESULTS') console.warn('[place-search] Google Places(legacy):', lj.status, lj.error_message ?? '')
      } catch (e) { console.warn('[place-search] Google Places:', e) }
    }
    const hdrs = { headers: { 'User-Agent': 'HappyPropertyCRM/1.0 (info@happy-property.com)' } }
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lang=de&lat=34.77&lon=32.42`
    const r = await fetch(url, hdrs)
    if (!r.ok) return json({ error: `Suche fehlgeschlagen (${r.status})` }, 502)
    const d = await r.json() as { features?: Array<{ properties?: Record<string, string>; geometry?: { coordinates?: [number, number] } }> }
    const scraped = await scrapeMaps(query)
    const results = (d.features ?? []).map(f => {
      const p = f.properties ?? {}
      const [lon, lat] = f.geometry?.coordinates ?? [0, 0]
      const display = [p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '', p.city || p.district || '', p.country || '']
        .filter(Boolean).join(', ')
      return { name: p.name || display.split(',')[0] || '', display, lat, lon }
    }).filter(x => x.name && x.lat && x.lon)
    const merged = scraped ? [scraped, ...results.filter((r: { name: string }) => r.name.toLowerCase() !== scraped.name.toLowerCase())] : results
    return json({ ok: true, results: merged })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[place-search]', msg)
    return json({ error: msg }, 500)
  }
})
