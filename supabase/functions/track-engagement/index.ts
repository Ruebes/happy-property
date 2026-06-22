// Supabase Edge Function: track-engagement
// Loggt Kunden-Engagement in engagement_events:
//   - GET  ?type=email_open&token=<deck-token>   → Mail-Öffnungs-Pixel (1x1 gif)
//   - POST { type, token }                       → Deck/Berechnung-Aufruf (Beacon)
// type: 'deck_view' | 'calc_view' | 'email_open'. Lead + Label werden aus
// sales_decks / property_calculations aufgelöst. Dedupe: gleiches (lead,type,token)
// innerhalb von 2 h wird nicht doppelt gezählt.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
// 1x1 transparentes GIF (für den Mail-Öffnungs-Pixel)
const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0))
const pixelResponse = () => new Response(PIXEL, { headers: { ...CORS, 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } })

async function logEvent(type: string, token: string | null) {
  if (!type || !token) return
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let leadId: string | null = null
  let label = ''
  try {
    if (type === 'deck_view' || type === 'email_open') {
      const { data: d } = await supabase.from('sales_decks').select('lead_id, project_id, recipient_name').eq('token', token).maybeSingle()
      if (d) {
        leadId = (d.lead_id as string) ?? null
        if (d.project_id) {
          const { data: p } = await supabase.from('crm_projects').select('name').eq('id', d.project_id).maybeSingle()
          label = (p?.name as string) ?? ''
        }
      }
    } else if (type === 'calc_view') {
      const { data: c } = await supabase.from('property_calculations').select('lead_id, title').eq('token', token).maybeSingle()
      if (c) { leadId = (c.lead_id as string) ?? null; label = (c.title as string) ?? '' }
    }
  } catch { /* Auflösung best-effort */ }

  // Dedupe: gleiches Ereignis innerhalb von 2 h nicht doppelt loggen.
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    let dupQ = supabase.from('engagement_events').select('id').eq('type', type).eq('token', token).gte('occurred_at', since).limit(1)
    dupQ = leadId ? dupQ.eq('lead_id', leadId) : dupQ.is('lead_id', null)
    const { data: dup } = await dupQ
    if (dup && dup.length) return
  } catch { /* im Zweifel loggen */ }

  await supabase.from('engagement_events').insert({ type, token, lead_id: leadId, label: label || null })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    if (req.method === 'GET') {
      const u = new URL(req.url)
      const type = u.searchParams.get('type') || 'email_open'
      const token = u.searchParams.get('token')
      // Pixel: NIE blockieren, immer das gif zurückgeben (Logging best-effort).
      try { await logEvent(type, token) } catch { /* egal */ }
      return pixelResponse()
    }
    if (req.method === 'POST') {
      const { type, token } = await req.json().catch(() => ({})) as { type?: string; token?: string }
      await logEvent(type ?? '', token ?? null)
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response('Method Not Allowed', { status: 405, headers: CORS })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
