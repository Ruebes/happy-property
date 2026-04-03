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
    const payload = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const phone   = payload.chat?.phone
    const text    = payload.message?.text
    const fromMe  = payload.message?.fromMe ?? false

    if (!phone || !text) {
      return new Response('OK', { headers: corsHeaders })
    }

    // Lead anhand Telefonnummer suchen
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .or(`phone.eq.${phone},whatsapp.eq.${phone}`)
      .maybeSingle()

    if (lead) {
      await supabase
        .from('activities')
        .insert({
          lead_id:              lead.id,
          type:                 'whatsapp',
          direction:            fromMe ? 'outbound' : 'inbound',
          subject:              fromMe ? 'WhatsApp gesendet' : 'WhatsApp erhalten',
          content:              text,
          completed_at:         new Date().toISOString(),
          whatsapp_message_id:  payload.message?.id,
        })

      // KI-Zusammenfassung löschen damit sie neu generiert wird
      await supabase
        .from('lead_ai_summaries')
        .delete()
        .eq('lead_id', lead.id)
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    console.error(error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: corsHeaders },
    )
  }
})
