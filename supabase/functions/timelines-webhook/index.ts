import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Stop-Intent-Erkennung ───────────────────────────────────────────────────
// Konservativ: nur bei eindeutigen Abmelde-Signalen. Erkennt der Kunde, dass er
// nicht mehr kontaktiert werden will, wird ein communication_optouts-Eintrag
// angelegt. Der DB-Trigger trg_hp_cancel_on_optout storniert daraufhin alle noch
// offenen geplanten Nachrichten dieses Leads. Sendet NICHTS – stoppt nur.
const STOP_PATTERNS: RegExp[] = [
  /\bstop\b/i,                                        // engl./Konvention: „STOP"
  /\bstopp/i,                                         // dt.: stopp, stoppen, stoppt, …
  /abmeld/i,                                          // abmelden, abmeldung
  /austragen/i,
  /\bunsubscribe\b/i,
  /kein(e|en)?\s+interesse/i,
  /nicht\s+mehr\s+(kontakt|schreib|anschreib|melden|nachricht|anruf)/i,
  /keine\s+(nachricht|werbung|mails?|e-?mails?|whatsapp|anrufe?)/i,
  /bitte\s+nicht\s+mehr/i,
  /löscht?\s+mich/i,
  /remove\s+me/i,
  /leave\s+me\s+alone/i,
  /do\s*n('|o)?t\s+contact/i,
  /stop\s+contacting/i,
]
function detectsStopIntent(text: string): boolean {
  return STOP_PATTERNS.some((re) => re.test(text))
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

      // Eingehende Abmeldung erkennen → Opt-Out anlegen (idempotent).
      // Der DB-Trigger storniert dann offene geplante Nachrichten.
      if (!fromMe && detectsStopIntent(text)) {
        const { data: existing } = await supabase
          .from('communication_optouts')
          .select('id')
          .eq('lead_id', lead.id)
          .limit(1)

        if (!existing || existing.length === 0) {
          await supabase
            .from('communication_optouts')
            .insert({
              lead_id:      lead.id,
              reason:       `Inbound-WhatsApp (Auto-Erkennung): ${text.slice(0, 200)}`,
              opted_out_at: new Date().toISOString(),
            })
        }
      }
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
