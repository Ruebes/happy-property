import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Recipient = { name: string; phone: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const {
      event_type,    // z.B. 'registration', 'no_show', 'commission', 'booking'
      lead_data,     // { lead_name, lead_phone, lead_email, lead_whatsapp, … }
      extra_data,    // { developers, notes, project_name, commission_amount, … }
      lead_id,       // für Aktivitäts-Log (optional)
      override_text, // wenn gesetzt: überschreibt Template-Substitution (no_show preview)
    } = await req.json()

    const apiKey      = Deno.env.get('TIMELINES_API_KEY')     ?? ''
    const senderPhone = Deno.env.get('TIMELINES_WA_SENDER')   ?? ''

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── Template aus DB laden ──────────────────────────────────────
    const { data: template, error: tplErr } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('event_type', event_type)
      .eq('active', true)
      .single()

    if (tplErr || !template) {
      throw new Error(`Kein aktives Template für event_type="${event_type}" gefunden`)
    }

    // ── Nachricht zusammenbauen ───────────────────────────────────
    let message: string
    if (override_text) {
      message = override_text
    } else {
      message = template.message_template as string
      const allData: Record<string, string> = {
        ...(lead_data  ?? {}),
        ...(extra_data ?? {}),
      }
      for (const [key, value] of Object.entries(allData)) {
        message = message.replaceAll(`{{${key}}}`, String(value ?? '–'))
      }
      // Übrige Platzhalter entfernen
      message = message.replace(/\{\{[^}]+\}\}/g, '–')
    }

    // ── Empfänger bestimmen ───────────────────────────────────────
    let recipients: Recipient[] = (template.recipients as Recipient[]) ?? []

    if (recipients.length === 0) {
      // Kein fester Empfänger → direkt an Lead-Nummer
      const phone =
        (lead_data?.lead_whatsapp as string | undefined) ??
        (lead_data?.lead_phone   as string | undefined) ??
        null
      if (phone) {
        recipients = [{ name: (lead_data?.lead_name as string) ?? 'Lead', phone }]
      }
    }

    if (recipients.length === 0) {
      throw new Error('Keine Empfänger konfiguriert und keine Lead-Nummer vorhanden')
    }

    console.log(`[send-whatsapp] event_type="${event_type}" recipients=${recipients.length} sender="${senderPhone}"`)

    // ── An alle Empfänger senden ──────────────────────────────────
    const results = []
    for (const recipient of recipients) {
      const payload = {
        phone:                  recipient.phone,
        whatsapp_account_phone: senderPhone,
        text:                   message,
      }
      console.log(`[send-whatsapp] Sende an ${recipient.phone}`, JSON.stringify(payload))

      const res = await fetch('https://app.timelines.ai/integrations/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      console.log(`[send-whatsapp] Antwort ${res.status} für ${recipient.phone}:`, JSON.stringify(json))
      if (!res.ok) console.error(`[send-whatsapp] FEHLER ${res.status} für ${recipient.phone}:`, JSON.stringify(json))
      results.push({ phone: recipient.phone, ok: res.ok, status: res.status, data: json })
    }

    // ── Aktivität in CRM loggen ───────────────────────────────────
    if (lead_id) {
      await supabase.from('activities').insert({
        lead_id,
        type:         'whatsapp',
        direction:    'outbound',
        subject:      `WhatsApp: ${event_type}`,
        content:      message,
        completed_at: new Date().toISOString(),
      })
    }

    return new Response(
      JSON.stringify({ success: true, sent: results.length, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    console.error('[send-whatsapp]', error)
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
