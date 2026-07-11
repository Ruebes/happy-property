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
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lang=de&lat=34.77&lon=32.42`
    const r = await fetch(url, { headers: { 'User-Agent': 'HappyPropertyCRM/1.0 (info@happy-property.com)' } })
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
