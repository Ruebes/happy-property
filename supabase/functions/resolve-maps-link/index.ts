// Supabase Edge Function: resolve-maps-link
// Nimmt einen Google-Maps-Link (auch Kurzlink wie https://maps.app.goo.gl/…),
// folgt den Redirects serverseitig (im Browser durch CORS nicht möglich) und
// extrahiert die Koordinaten. Damit lassen sich Kurzlinks als Karten-Pin nutzen.
//
// Request:  { url: string }
// Response: { success: true, lat: number, lng: number, resolved_url: string }
//        |  { success: false, error: string }

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Nur echte Google-Maps-Hosts auflösen (verhindert Missbrauch als offener Proxy/SSRF).
const ALLOWED_HOSTS = [
  'maps.app.goo.gl', 'goo.gl', 'maps.google.com', 'www.google.com',
  'google.com', 'g.co', 'maps.googleapis.com', 'www.google.de', 'google.de',
]
function hostAllowed(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return ALLOWED_HOSTS.some(a => h === a || h.endsWith(`.${a}`))
  } catch {
    return false
  }
}

// Koordinaten aus einer aufgelösten Maps-URL ziehen — in Genauigkeits-Reihenfolge.
function extractCoords(u: string): { lat: number; lng: number } | null {
  // !3d<lat>!4d<lng> = exakter Pin-Ort (am genauesten)
  let m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }
  // @<lat>,<lng> = Kartenmittelpunkt
  m = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }
  // ?q=<lat>,<lng> oder /place/<lat>,<lng>
  m = u.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/) ?? u.match(/\/place\/(-?\d+\.\d+),(-?\d+\.\d+)/)
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { url } = await req.json()
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Ungültiger oder fehlender Link')
    }
    if (!hostAllowed(url)) {
      throw new Error('Nur Google-Maps-Links erlaubt')
    }

    // Redirects manuell verfolgen (max 6 Hops), nach jedem Hop Koordinaten prüfen.
    let current = url
    let coords = extractCoords(current)
    for (let i = 0; i < 6 && !coords; i++) {
      if (!hostAllowed(current)) break   // Redirect-Ziel außerhalb der Allowlist → stop
      const res = await fetch(current, {
        method:   'GET',
        redirect: 'manual',
        headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; HappyPropertyCRM/1.0)' },
      })
      const loc = res.headers.get('location')
      if (loc) {
        current = loc.startsWith('http') ? loc : new URL(loc, current).toString()
        coords = extractCoords(current)
      } else {
        // Kein weiterer Redirect — finale URL (res.url) prüfen, dann abbrechen
        coords = extractCoords(res.url)
        current = res.url
        break
      }
    }

    if (!coords) {
      return new Response(
        JSON.stringify({ success: false, error: 'Keine Koordinaten im Link gefunden', resolved_url: current }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    console.log(`[resolve-maps-link] ${url} → ${coords.lat},${coords.lng}`)
    return new Response(
      JSON.stringify({ success: true, lat: coords.lat, lng: coords.lng, resolved_url: current }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    console.error('[resolve-maps-link]', error)
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
