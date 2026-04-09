// Supabase Edge Function: calendly-webhook
// Endpunkt für Calendly Webhooks.
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

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const body = await req.json()
    const event     = body.event as string
    const invitee   = body.payload?.invitee ?? {}
    const eventInfo = body.payload?.event ?? {}

    // Name aufteilen
    const fullName  = (invitee.name as string) ?? ''
    const nameParts = fullName.trim().split(/\s+/)
    const firstName = nameParts[0] ?? ''
    const lastName  = nameParts.slice(1).join(' ') || ''
    const email     = (invitee.email as string) ?? ''
    const phone     = getTextResponse(body, 'phone') ?? getTextResponse(body, 'telefon') ?? null
    const startTime = (eventInfo.start_time as string) ?? new Date().toISOString()
    const endTime   = (eventInfo.end_time as string) ?? null
    const calendlyId = (invitee.uuid as string) ?? (invitee.uri as string) ?? null
    const eventName  = (eventInfo.name as string) ?? 'Calendly Termin'
    const joinUrl    = (eventInfo.location?.join_url as string) ?? null

    if (!email) {
      return new Response(
        JSON.stringify({ error: 'No email in payload' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── invitee.canceled: Deal auf no_show setzen ────────────────────────────
    if (event === 'invitee.canceled') {
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
        status: 'contacted',
      }).eq('id', leadId)
    } else {
      const { data: newLead, error } = await supabase.from('leads').insert({
        first_name:        firstName,
        last_name:         lastName,
        email:             email,
        phone:             phone,
        source:            'calendly',
        calendly_event_id: calendlyId,
        status:            'contacted',
        language:          'de',
      }).select('id').single()

      if (error || !newLead) {
        throw new Error(`Lead-Erstellung fehlgeschlagen: ${String(error?.message)}`)
      }
      leadId = newLead.id
    }

    // Deal mit Phase termin_gebucht anlegen (nur wenn keiner existiert)
    const { data: existingDeal } = await supabase
      .from('deals')
      .select('id')
      .eq('lead_id', leadId)
      .maybeSingle()

    let dealId: string | null

    if (existingDeal) {
      dealId = existingDeal.id
      await supabase.from('deals').update({ phase: 'termin_gebucht' }).eq('id', dealId)
    } else {
      const { data: newDeal } = await supabase.from('deals').insert({
        lead_id: leadId,
        phase:   'termin_gebucht',
      }).select('id').single()
      dealId = newDeal?.id ?? null
    }

    // Termin in crm_appointments anlegen
    await supabase.from('crm_appointments').insert({
      lead_id:     leadId,
      title:       eventName,
      type:        'zoom',
      start_time:  startTime,
      end_time:    endTime,
      description: 'Automatisch via Calendly',
      zoom_link:   joinUrl,
    })

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

    console.log('[calendly-webhook] Erfolg:', { leadId, dealId })

    return new Response(
      JSON.stringify({ ok: true, lead_id: leadId, deal_id: dealId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[calendly-webhook] Fehler:', err)
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function getTextResponse(body: Record<string, unknown>, keyword: string): string | null {
  try {
    const responses = body?.payload?.questions_and_answers as Array<{ question: string; answer: string }> | undefined
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
