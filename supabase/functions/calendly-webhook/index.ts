// Supabase Edge Function: calendly-webhook
// Endpunkt für Calendly Webhooks.
// In Calendly eintragen unter: Integrations → Webhooks → Endpoint URL = <supabase-url>/functions/v1/calendly-webhook

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const body = await req.json()

    // Webhook-Log speichern
    await supabase.from('crm_webhooks').insert({
      source:   'calendly',
      payload:  body,
      processed_at: new Date().toISOString(),
    })

    const event      = body.event  // 'invitee.created' oder 'invitee.canceled'
    const invitee    = body.payload?.invitee ?? {}
    const eventInfo  = body.payload?.event ?? {}

    // Name aufteilen
    const fullName   = (invitee.name as string) ?? ''
    const nameParts  = fullName.trim().split(/\s+/)
    const firstName  = nameParts[0] ?? ''
    const lastName   = nameParts.slice(1).join(' ') || ''

    const email      = (invitee.email as string) ?? ''
    const phone      = getTextResponse(body, 'phone') ?? getTextResponse(body, 'telefon') ?? null
    const startTime  = (eventInfo.start_time as string) ?? new Date().toISOString()
    const calendlyId = (invitee.uuid as string) ?? (invitee.uri as string) ?? null

    if (!email) {
      return new Response(JSON.stringify({ error: 'No email in payload' }), { status: 400 })
    }

    if (event === 'invitee.canceled') {
      // Bestehenden Lead + Deal suchen → Phase auf no_show setzen
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
            lead_id:   lead.id,
            deal_id:   deal.id,
            type:      'note',
            direction: 'inbound',
            content:   `Calendly-Termin abgesagt → No Show (${startTime})`,
          })
        }
      }

      // n8n Webhook für No Show
      await sendN8nWebhook({
        event:     'deal.no_show',
        lead:      { name: fullName, email, phone },
        timestamp: new Date().toISOString(),
      })

      return new Response(JSON.stringify({ ok: true, action: 'no_show' }), { status: 200 })
    }

    // invitee.created: Lead anlegen oder updaten
    let leadId: string

    const { data: existingLead } = await supabase
      .from('leads')
      .select('id')
      .eq('email', email)
      .maybeSingle()

    if (existingLead) {
      leadId = existingLead.id
      // Calendly-ID aktualisieren
      await supabase.from('leads').update({
        calendly_event_id: calendlyId,
        phone: phone ?? undefined,
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
        return new Response(JSON.stringify({ error: String(error) }), { status: 500 })
      }
      leadId = newLead.id
    }

    // Deal mit Phase termin_gebucht anlegen
    const { data: newDeal } = await supabase.from('deals').insert({
      lead_id: leadId,
      phase:   'termin_gebucht',
    }).select('id').single()

    const dealId = newDeal?.id ?? null

    // Aktivität loggen
    await supabase.from('activities').insert({
      lead_id:   leadId,
      deal_id:   dealId,
      type:      'meeting',
      direction: 'inbound',
      content:   `Termin gebucht via Calendly: ${new Date(startTime).toLocaleString('de-DE')}`,
    })

    // n8n benachrichtigen
    await sendN8nWebhook({
      event:     'deal.appointment_booked',
      lead:      { name: fullName, email, phone },
      deal_id:   dealId,
      timestamp: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ ok: true, lead_id: leadId, deal_id: dealId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[calendly-webhook]', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})

// Hilfsfunktionen
function getTextResponse(body: Record<string, unknown>, keyword: string): string | null {
  try {
    const responses = (body as Record<string, unknown>)?.payload?.questions_and_answers as Array<{ question: string; answer: string }> | undefined
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
