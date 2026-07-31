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
    const results = (d.features ?? []).map(f => {
      const p = f.properties ?? {}
      const [lon, lat] = f.geometry?.coordinates ?? [0, 0]
      const display = [p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '', p.city || p.district || '', p.country || '']
        .filter(Boolean).join(', ')
      return { name: p.name || display.split(',')[0] || '', display, lat, lon }
    }).filter(x => x.name && x.lat && x.lon)
    return json({ ok: true, results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[place-search]', msg)
    return json({ error: msg }, 500)
  }
})
