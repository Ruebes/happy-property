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

const CALENDLY = 'https://calendly.com/sven-happy-property/30min'

// Sendezeit in Bürozeiten (8–21 Uhr Asia/Nicosia) schieben — nie nachts.
function toBusinessHours(d: Date): Date {
  const hourIn = (dt: Date) =>
    Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', hour: '2-digit', hour12: false }).format(dt)) % 24
  let out = new Date(d)
  for (let i = 0; i < 48; i++) {
    const h = hourIn(out)
    if (h >= 8 && h < 21) break
    out = new Date(out.getTime() + 60 * 60 * 1000)  // +1 h bis im Fenster
  }
  return out
}

// Deck-Follow-up planen: EINE WhatsApp X Min nach dem ERSTEN Deck-Aufruf.
// Gated auf die aktive Regel (deck_viewed_followup, Standard AUS). Einmal pro Lead,
// nicht bei Opt-Out, nur mit Telefonnummer. Gesendet wird später vom 5-Min-Cron.
async function scheduleDeckFollowup(
  supabase: ReturnType<typeof createClient>,
  leadId: string,
): Promise<void> {
  try {
    // 1) Regel aktiv? (Standard AUS → nichts planen)
    const { data: rule } = await supabase.from('automation_rules')
      .select('id, is_active, delay_minutes, appointment_condition')
      .eq('event_type', 'deck_viewed_followup').maybeSingle()
    const r = rule as { id: string; is_active: boolean; delay_minutes: number; appointment_condition: string | null } | null
    if (!r || !r.is_active) return

    // 2) Einmal pro Lead — schon geplant/gesendet?
    const { data: existing } = await supabase.from('scheduled_messages')
      .select('id').eq('lead_id', leadId).eq('event_type', 'deck_viewed_followup').limit(1)
    if (existing && existing.length) return

    // 3) Opt-Out? → nicht planen
    const { data: opt } = await supabase.from('communication_optouts')
      .select('id').eq('lead_id', leadId).limit(1)
    if (opt && opt.length) return

    // 4) Lead + Nummer laden (WhatsApp braucht eine Nummer)
    const { data: lead } = await supabase.from('leads')
      .select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
    const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
    if (!l || !(l.whatsapp || l.phone)) return

    const first = (l.first_name ?? '').trim()
    const greet = first ? `Hey ${first}` : 'Hallo'
    const msg =
      `${greet}, ich wollte kurz nachhören 🙂 Konntest du schon in Ruhe über die Objekte schauen? Welches spricht dich am meisten an?\n\n` +
      `Wenn du magst, nehmen wir uns 15 Minuten und ich beantworte dir alle offenen Fragen — hier kannst du dir direkt einen Termin aussuchen: ${CALENDLY}\n\n` +
      `Liebe Grüße, Sven`

    const delay  = (r.delay_minutes ?? 45) * 60 * 1000
    const sendAt = toBusinessHours(new Date(Date.now() + delay))

    await supabase.from('scheduled_messages').insert({
      lead_id:               leadId,
      type:                  'whatsapp',
      event_type:            'deck_viewed_followup',
      status:                'pending',
      scheduled_at:          sendAt.toISOString(),
      whatsapp_text:         msg,
      recipient:             'client',
      rule_id:               r.id,
      appointment_condition: r.appointment_condition ?? 'no_appointment',
    })
    console.log(`[track-engagement] Deck-Follow-up geplant für Lead ${leadId} um ${sendAt.toISOString()}`)
  } catch (err) {
    console.warn('[track-engagement] scheduleDeckFollowup fehlgeschlagen:', err)
  }
}

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

  // Mail-Öffnung NUR loggen, wenn die Mail mit diesem Deck-Token auch WIRKLICH an
  // den Kunden gesendet wurde (deck_outbox.email_sent_at). Sonst stammt die Öffnung
  // aus einer Vorschau/internen Mail (z.B. Test an die eigene Adresse) → kein echtes
  // Kundenverhalten, nicht zählen.
  if (type === 'email_open') {
    try {
      const { data: sent } = await supabase.from('deck_outbox')
        .select('id').contains('deck_tokens', [token]).not('email_sent_at', 'is', null).limit(1)
      if (!sent || !sent.length) return
    } catch { return }
  }

  // Dedupe: gleiches Ereignis innerhalb von 2 h nicht doppelt loggen.
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    let dupQ = supabase.from('engagement_events').select('id').eq('type', type).eq('token', token).gte('occurred_at', since).limit(1)
    dupQ = leadId ? dupQ.eq('lead_id', leadId) : dupQ.is('lead_id', null)
    const { data: dup } = await dupQ
    if (dup && dup.length) return
  } catch { /* im Zweifel loggen */ }

  await supabase.from('engagement_events').insert({ type, token, lead_id: leadId, label: label || null })

  // Nach dem ERSTEN Deck-Aufruf: Follow-up auslösen. Wenn der Termin-Bot aktiv ist,
  // startet er den Buchungs-Dialog (schlägt Termine vor + bucht) — das ist die
  // stärkere Variante und hat Vorrang. Sonst greift das statische WhatsApp-Follow-up.
  // Läuft nur hier, wenn das Event NICHT dedupliziert wurde (= erster Aufruf im 2-h-Fenster).
  if (type === 'deck_view' && leadId) {
    const { data: bot } = await supabase.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
    if ((bot as { value?: string } | null)?.value === 'true') {
      try {
        await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-bot`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action: 'start', lead_id: leadId, source: 'deck_viewed' }),
        })
      } catch (e) { console.warn('[track-engagement] booking-bot start fehlgeschlagen:', e) }
    } else {
      await scheduleDeckFollowup(supabase, leadId)
    }
  }
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
