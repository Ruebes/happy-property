// timelines-webhook — Empfang von WhatsApp-Ereignissen aus TimelinesAI.
// Seit 17.9.2026 nur noch ein duenner Uebersetzer: bildet das Timelines-Payload
// auf WaEvent ab und gibt es an die gemeinsame Verarbeitung (_shared/waInbound.ts).
// Die Fachlogik liegt dort, gemeinsam mit dem evolution-webhook (eigener Server).
//
// Umschalter crm_settings.wa_provider: steht er auf 'evolution', wird hier NICHTS
// verarbeitet (nur bestaetigt). Beide Anbieter haengen an derselben Nummer, jede
// Kundennachricht kaeme sonst doppelt in den Verlauf und der Bot antwortete zweimal.
//
// Deploy: supabase functions deploy timelines-webhook --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { markProcessed, processWaEvent } from '../_shared/waInbound.ts'
import { getWaProvider } from '../_shared/waProvider.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const TAG = 'timelines-webhook'

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

    // ── Dedupe: Timelines schickt DIESELBE Nachricht mehrfach (verschiedene
    // event_types wie message:new + message:received:new, dazu Retries). Jede
    // message_uid nur EINMAL verarbeiten — race-sicher über den UNIQUE-Primary-Key
    // (Insert-Konflikt = bereits gesehen → still bestätigen).
    const uid = payload.message?.message_uid ?? payload.message?.id
    if (!(await markProcessed(supabase, uid ? String(uid) : null))) {
      return new Response('OK (dupe)', { headers: corsHeaders })
    }

    // ── Anbieter-Gate: verarbeitet nur der aktive Weg ───────────────────────
    if ((await getWaProvider(supabase)) !== 'timelines') {
      console.log(`[${TAG}] ignoriert (aktiver Anbieter ist Evolution)`)
      return new Response('OK (inactive provider)', { headers: corsHeaders })
    }

    // ── Richtung: Timelines nutzt message.direction ('received'|'sent'), NICHT fromMe.
    const acctPhone = payload.whatsapp_account?.phone
    const viaApi = payload.message?.origin === 'Public API'
    const fromMe = payload.message?.direction === 'sent'
      || viaApi
      || !!(payload.message?.sender?.phone && acctPhone && payload.message.sender.phone === acctPhone)

    // Kunden-Nummer: bei eingehenden Nachrichten der Absender, bei eigenen der Chat.
    const phone = fromMe
      ? (payload.chat?.phone ?? payload.contact?.phone ?? '')
      : (payload.message?.sender?.phone ?? payload.chat?.phone ?? payload.contact?.phone ?? '')
    const text = payload.message?.text ?? payload.message?.body ?? payload.text ?? ''

    const r = await processWaEvent(supabase, {
      uid: uid ? String(uid) : null, phone: String(phone ?? ''), text: String(text ?? ''), fromMe, viaApi,
    }, TAG)
    if (r.outcome === 'error') {
      return new Response(JSON.stringify({ error: r.error }), { status: 500, headers: corsHeaders })
    }
    return new Response(
      JSON.stringify({ success: true, outcome: r.outcome }),
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
