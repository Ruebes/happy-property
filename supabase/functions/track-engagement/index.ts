// Supabase Edge Function: track-engagement
// Loggt Kunden-Engagement in engagement_events:
//   - GET  ?type=email_open&token=<deck-token>   → Mail-Öffnungs-Pixel (1x1 gif)
//   - POST { type, token }                       → Deck/Berechnung-Aufruf (Beacon)
// type: 'deck_view' | 'calc_view' | 'email_open'. Lead + Label werden aus
// sales_decks / property_calculations aufgelöst. Dedupe: gleiches (lead,type,token)
// innerhalb von 2 h wird nicht doppelt gezählt.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'

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
      `${greet}, hier ist Lotte, Svens persönliche Assistentin 🐾 Ich wollte kurz nachhören: Konntest du schon in Ruhe über die Objekte schauen? Welches spricht dich am meisten an?\n\n` +
      `Wenn du magst, nehmt ihr euch 15 Minuten und Sven beantwortet dir alle offenen Fragen — hier kannst du dir direkt einen Termin aussuchen: ${CALENDLY}\n\n` +
      // Lotte, nicht Sven: diese Nachricht tippt niemand, sie geht automatisch nach
      // einer Deck-Ansicht raus. Als "Sven" signiert wäre sie eine Verwechslung —
      // und ein Hundefoto unter Svens Namen erst recht.
      `Liebe Grüße, Lotte 🐾`

    const delay  = (r.delay_minutes ?? 45) * 60 * 1000
    const sendAt = toBusinessHours(new Date(Date.now() + delay))

    await supabase.from('scheduled_messages').insert({
      lead_id:               leadId,
      type:                  'whatsapp',
      event_type:            'deck_viewed_followup',
      status:                'pending',
      scheduled_at:          sendAt.toISOString(),
      whatsapp_text:         msg,
      // Lotte-Bild mitgeben, damit die Nachricht wie alle Bot-Nachrichten aussieht.
      whatsapp_image_url:    lotteBild(),
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
  let isCampaignClone = false
  try {
    if (type === 'deck_view' || type === 'email_open') {
      const { data: d } = await supabase.from('sales_decks').select('lead_id, project_id, recipient_name, batch_id').eq('token', token).maybeSingle()
      if (d) {
        leadId = (d.lead_id as string) ?? null
        isCampaignClone = !!(d as { batch_id?: string | null }).batch_id && !!leadId
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
  // Newsletter-Kampagnen-Klone (batch_id + lead_id) tragen den Öffnungs-Pixel
  // direkt in der Kampagnen-Mail — sie brauchen keinen deck_outbox-Nachweis.
  if (type === 'email_open' && !isCampaignClone) {
    try {
      const { data: sent } = await supabase.from('deck_outbox')
        .select('id').contains('deck_tokens', [token]).not('email_sent_at', 'is', null).limit(1)
      if (!sent || !sent.length) return
    } catch { return }
  }

  // Deck-Aufruf NUR als Kundenbesuch zählen, wenn das Deck den Kunden auch
  // erreicht haben KANN. Liegt zu diesem Token ein Postausgang-Eintrag, der noch
  // nicht raus ist (Entwurf), hat der Kunde den Link nachweislich nicht — jeder
  // Aufruf ist dann intern (Kontrolle im CRM, Link kopiert, anderes Gerät, andere
  // Browser-Session). Das darf weder im Dashboard als „Deck angesehen" erscheinen
  // NOCH die Follow-up-/Bot-Automatik auslösen (sonst bekommt ein Kunde „Konntest
  // du schon schauen?" für Unterlagen, die er nie erhalten hat).
  // Newsletter-Klone (batch_id) laufen nicht über die Outbox → ausgenommen.
  if (type === 'deck_view' && !isCampaignClone) {
    try {
      const { data: ob } = await supabase.from('deck_outbox')
        .select('sent_at').contains('deck_tokens', [token])
        .order('created_at', { ascending: false }).limit(1)
      const row = (ob ?? [])[0] as { sent_at: string | null } | undefined
      if (row && !row.sent_at) return
    } catch { /* Outbox nicht lesbar → im Zweifel weiter loggen */ }
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
      // Bot-Start +40 Min planen (nicht sofort — Kunde soll erst selbst buchen können).
      // DEDUP gegen Doppel-Trigger: nur wenn weder IRGENDEIN offener Bot-Nudge ansteht
      // noch ein aktives Gespräch läuft. Quellenübergreifend (nicht nur deck_viewed) —
      // sonst plant ein Deck-View einen deck_viewed-Start, obwohl schon ein
      // immobilienauswahl/no_show-Nudge pending ist (Andreas-Fall: zwei fast identische
      // Lotte-Vorstellungen 5 Min auseinander).
      const { data: pend } = await supabase.from('scheduled_messages').select('id')
        .eq('lead_id', leadId).eq('event_type', 'bot_nudge').in('status', ['pending', 'processing']).limit(1)
      const { data: activeConv } = await supabase.from('booking_conversations').select('id')
        .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').gt('expires_at', new Date().toISOString()).limit(1)
      if (!(pend && pend.length) && !(activeConv && activeConv.length)) {
        await supabase.from('scheduled_messages').insert({
          lead_id: leadId, type: 'whatsapp', event_type: 'bot_nudge',
          bot_nudge_stage: 0, bot_nudge_source: 'deck_viewed', status: 'pending',
          scheduled_at: new Date(Date.now() + 40 * 60000).toISOString(),
        })
      }
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
