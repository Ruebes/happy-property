// Supabase Edge Function: crm-webhook-sender
// Sendet Webhooks an n8n bei CRM-Ereignissen.
// Wird vom Frontend per supabase.functions.invoke('crm-webhook-sender', { body: {...} }) aufgerufen.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload = await req.json()
    const n8nUrl  = Deno.env.get('N8N_WEBHOOK_URL')

    // Webhook-Log in DB speichern (fire-and-forget)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    fetch(`${supabaseUrl}/rest/v1/crm_webhooks`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        source:  'n8n_outbound',
        payload: payload,
        lead_id: payload.lead_id ?? null,
        processed_at: new Date().toISOString(),
      }),
    }).catch(console.error)

    // n8n aufrufen wenn URL konfiguriert
    if (n8nUrl) {
      const res = await fetch(n8nUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!res.ok) {
        console.error('[crm-webhook-sender] n8n returned', res.status)
      }
    } else {
      console.warn('[crm-webhook-sender] N8N_WEBHOOK_URL not set')
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[crm-webhook-sender]', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
