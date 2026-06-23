// Supabase Edge Function: calendly-webhook
// Endpunkt für Calendly Webhooks (v2 Payload-Format).
// In Calendly eintragen unter: Integrations → Webhooks → Endpoint URL = <supabase-url>/functions/v1/calendly-webhook

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  let rawForErr: unknown = null
  try {
    const body = await req.json()
    rawForErr = body
    const event = body.event as string

    // ── Calendly v2 Payload-Struktur ─────────────────────────────────────────
    // body.payload = das Invitee-Objekt direkt (name, email, etc.)
    // body.payload.scheduled_event = Event-Details (start_time, end_time, name, location)
    // body.payload.event = URI-String (nicht das Event-Objekt!)
    const p          = body.payload ?? {}
    const eventInfo  = p.scheduled_event ?? {}

    // Name aufteilen
    const fullName   = (p.name as string) ?? ''
    const nameParts  = fullName.trim().split(/\s+/)
    const firstName  = nameParts[0] ?? ''
    const lastName   = nameParts.slice(1).join(' ') || ''
    const email      = (p.email as string) ?? ''
    // Telefon aus allen plausiblen Calendly-Feldern: SMS-Reminder-Nummer + Q&A-Keywords.
    // (Liegt die Nummer nur im Typeform, kommt sie hier nicht an → Typeform-Webhook aktivieren.)
    const phone =
      (typeof p.text_reminder_number === 'string' && p.text_reminder_number.trim() ? p.text_reminder_number.trim() : null) ??
      getTextResponse(p, 'phone') ?? getTextResponse(p, 'telefon') ?? getTextResponse(p, 'handy') ??
      getTextResponse(p, 'mobil') ?? getTextResponse(p, 'whatsapp') ?? getTextResponse(p, 'nummer') ?? null

    // ── Werbe-Tracking (UTM) ─────────────────────────────────────────────────
    // Calendly liefert UTM unter payload.tracking, GEFÜLLT wenn die Buchungsseite
    // mit ?utm_source=…&utm_campaign=… aufgerufen wurde (z.B. aus der Meta-Anzeige).
    // Komplett additiv & fehlertolerant — darf die Lead-Erstellung nie blockieren.
    const tr = (p.tracking ?? {}) as Record<string, unknown>
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const utmSource   = str(tr.utm_source)
    const utmMedium   = str(tr.utm_medium)
    const utmCampaign = str(tr.utm_campaign)
    const utmContent  = str(tr.utm_content)
    // Quelle aus utm_source ableiten; unbekannt → bleibt 'calendly'
    const mappedSource = mapSource(utmSource)

    // Terminzeiten — end_time NOT NULL in DB, daher Fallback auf start_time + 1h
    const startTime  = (eventInfo.start_time as string) ?? new Date().toISOString()
    const endTimeRaw = (eventInfo.end_time as string) ?? null
    const endTime    = endTimeRaw ?? new Date(new Date(startTime).getTime() + 60 * 60 * 1000).toISOString()

    // Invitee-UUID aus URI extrahieren: ".../invitees/<uuid>"
    const inviteeUri  = (p.uri as string) ?? ''
    const calendlyId  = inviteeUri.split('/').pop() ?? inviteeUri ?? null

    const eventName   = (eventInfo.name as string) ?? 'Calendly Termin'
    const joinUrl     = (eventInfo.location?.join_url as string) ?? null

    console.log('[calendly-webhook] Event:', event, '| Email:', email, '| Start:', startTime)

    if (!email) {
      console.error('[calendly-webhook] Kein E-Mail im Payload:', JSON.stringify(p).slice(0, 200))
      return new Response(
        JSON.stringify({ error: 'No email in payload' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── invitee.canceled: Deal auf no_show setzen ────────────────────────────
    if (event === 'invitee.canceled' || event === 'invitee.cancelled') {
      const { data: lead } = await supabase
        .from('leads')
        .select('id')
        .eq('email', email)
        .maybeSingle()

      if (lead) {
        const { data: deal } = await supabase
          .from('deals')
          .select('id')
          .eq('lead_id', lead.id)
          .eq('phase', 'termin_gebucht')
          .maybeSingle()

        if (deal) {
          await supabase.from('deals').update({ phase: 'no_show' }).eq('id', deal.id)
          await supabase.from('activities').insert({
            lead_id:      lead.id,
            deal_id:      deal.id,
            type:         'note',
            direction:    'inbound',
            subject:      'Calendly-Termin abgesagt',
            content:      `Termin abgesagt → No Show (${new Date(startTime).toLocaleString('de-DE')})`,
            completed_at: new Date().toISOString(),
          })
        }
      }

      await sendN8nWebhook({
        event:     'deal.no_show',
        lead:      { name: fullName, email, phone },
        timestamp: new Date().toISOString(),
      })

      return new Response(
        JSON.stringify({ ok: true, action: 'no_show' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── invitee.created: Lead anlegen oder updaten ───────────────────────────
    let leadId: string

    const { data: existingLead } = await supabase
      .from('leads')
      .select('id')
      .eq('email', email)
      .maybeSingle()

    if (existingLead) {
      leadId = existingLead.id
      await supabase.from('leads').update({
        calendly_event_id: calendlyId,
        ...(phone ? { phone } : {}),
        // UTM nur setzen wenn vorhanden — bestehende Werte nicht mit null überschreiben
        ...(utmSource   ? { utm_source: utmSource }     : {}),
        ...(utmMedium   ? { utm_medium: utmMedium }     : {}),
        ...(utmCampaign ? { utm_campaign: utmCampaign } : {}),
        ...(utmContent  ? { utm_content: utmContent }   : {}),
        status: 'contacted',
      }).eq('id', leadId)
    } else {
      const { data: newLead, error } = await supabase.from('leads').insert({
        first_name:        firstName,
        last_name:         lastName,
        email:             email,
        phone:             phone,
        source:            mappedSource ?? 'calendly',
        calendly_event_id: calendlyId,
        status:            'contacted',
        language:          'de',
        utm_source:        utmSource,
        utm_medium:        utmMedium,
        utm_campaign:      utmCampaign,
        utm_content:       utmContent,
      }).select('id').single()

      if (error || !newLead) {
        throw new Error(`Lead-Erstellung fehlgeschlagen: ${String(error?.message)}`)
      }
      leadId = newLead.id
    }

    // Deal mit Phase termin_gebucht anlegen (nur wenn keiner existiert).
    // NICHT maybeSingle() — wirft, sobald der Lead mehr als einen Deal hat
    // (dann ginge der ganze Webhook in den 500er und die Buchung würde nicht verarbeitet).
    const { data: existingDeals } = await supabase
      .from('deals')
      .select('id')
      .eq('lead_id', leadId)
      .limit(1)
    const existingDeal = existingDeals?.[0] ?? null

    let dealId: string | null

    if (existingDeal) {
      dealId = existingDeal.id
      await supabase.from('deals').update({ phase: 'termin_gebucht' }).eq('id', dealId)
    } else {
      const { data: newDeal, error: dealErr } = await supabase.from('deals').insert({
        lead_id: leadId,
        phase:   'termin_gebucht',
      }).select('id').single()
      // Insert-Fehler NICHT verschlucken — sonst Aktivität + n8n-„Buchung" ohne echten Deal.
      if (dealErr) throw new Error(`Deal-Erstellung fehlgeschlagen: ${dealErr.message}`)
      dealId = newDeal?.id ?? null
    }

    // KEIN crm_appointments-Eintrag — Kalender wird extern (Google) synchronisiert,
    // Doppeleinträge würden entstehen. Nur Aktivität loggen.

    // Aktivität loggen
    await supabase.from('activities').insert({
      lead_id:      leadId,
      deal_id:      dealId,
      type:         'meeting',
      direction:    'inbound',
      subject:      'Calendly Termin gebucht',
      content:      `Termin: ${eventName} am ${new Date(startTime).toLocaleString('de-DE')}`,
      completed_at: new Date().toISOString(),
    })

    await sendN8nWebhook({
      event:     'deal.appointment_booked',
      lead:      { name: fullName, email, phone },
      deal_id:   dealId,
      timestamp: new Date().toISOString(),
    })

    console.log('[calendly-webhook] Erfolg:', { leadId, dealId, startTime })

    return new Response(
      JSON.stringify({ ok: true, lead_id: leadId, deal_id: dealId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[calendly-webhook] Fehler:', err)
    try { await supabase.from('webhook_errors').insert({ source: 'calendly', error: String(err), payload: rawForErr }) } catch { /* best effort */ }
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

// utm_source → CRM-Quelle (muss mit leads_source_check übereinstimmen).
// Unbekannt → null, damit die Quelle 'calendly' erhalten bleibt.
function mapSource(raw: string | null): 'meta' | 'google' | 'empfehlung' | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.includes('meta') || s.includes('facebook') || s.includes('instagram') || s === 'fb' || s === 'ig' || s === 'an' || s === 'msg') return 'meta'
  if (s.includes('google'))                                                    return 'google'
  if (s.includes('empfehlung') || s.includes('referral') || s.includes('ref')) return 'empfehlung'
  return null
}

function getTextResponse(payload: Record<string, unknown>, keyword: string): string | null {
  try {
    const responses = payload?.questions_and_answers as Array<{ question: string; answer: string }> | undefined
    if (!responses) return null
    const match = responses.find(r => r.question.toLowerCase().includes(keyword.toLowerCase()))
    return match?.answer ?? null
  } catch {
    return null
  }
}

async function sendN8nWebhook(payload: Record<string, unknown>) {
  const n8nUrl = Deno.env.get('N8N_WEBHOOK_URL')
  if (!n8nUrl) return
  try {
    await fetch(n8nUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
  } catch (e) {
    console.warn('[calendly-webhook] n8n error:', e)
  }
}
