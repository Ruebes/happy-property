// Edge Function: schedule-message
// Wird aufgerufen wenn ein CRM-Ereignis eintritt (Lead erstellt, Phase wechselt).
// Liest aktive Automationsregeln für den event_type, prüft Opt-Out,
// rendert Templates mit Lead-Daten und schreibt scheduled_messages.
//
// Aufruf vom Frontend:
//   supabase.functions.invoke('schedule-message', {
//     body: { lead_id, deal_id?, event_type }
//   })

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Platzhalter in Template-Texten ersetzen ───────────────────────────────────
function substitute(template: string, data: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(data)) {
    result = result.split(`{{${key}}}`).join(value || '–')
    // E-Mail-Templates nutzen {{vorname}} etc. – ebenfalls abdecken
    result = result.split(`{{${key.replace('lead_', '')}}}`).join(value || '–')
  }
  // Übrige Platzhalter entfernen
  return result.replace(/\{\{[^}]+\}\}/g, '–')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  try {
    const { lead_id, deal_id, event_type } = await req.json() as {
      lead_id:    string
      deal_id?:   string | null
      event_type: string
    }

    if (!lead_id || !event_type) {
      return new Response(
        JSON.stringify({ error: 'lead_id und event_type sind Pflichtfelder' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── 1. Opt-Out prüfen ─────────────────────────────────────────────────────
    const { data: optOut } = await supabase
      .from('communication_optouts')
      .select('id')
      .eq('lead_id', lead_id)
      .maybeSingle()

    if (optOut) {
      console.log(`[schedule-message] Lead ${lead_id} hat Opt-Out – übersprungen`)
      return new Response(
        JSON.stringify({ ok: true, skipped: 'opted_out', scheduled: 0 }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // ── 2. Aktive Regeln für diesen event_type laden ───────────────────────────
    const { data: rules, error: rulesErr } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('event_type', event_type)
      .eq('is_active', true)

    if (rulesErr) throw rulesErr
    if (!rules || rules.length === 0) {
      console.log(`[schedule-message] Keine aktiven Regeln für event_type="${event_type}"`)
      return new Response(
        JSON.stringify({ ok: true, scheduled: 0 }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // ── 3. Lead-Daten laden ───────────────────────────────────────────────────
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('id, first_name, last_name, email, phone, whatsapp, language')
      .eq('id', lead_id)
      .single()

    if (leadErr || !lead) {
      throw new Error(`Lead ${lead_id} nicht gefunden: ${leadErr?.message}`)
    }

    // Deal-Daten für Platzhalter (optional)
    let dealData: { developer: string | null; commission_amount: number | null } | null = null
    const resolvedDealId = deal_id ?? null
    if (resolvedDealId) {
      const { data } = await supabase
        .from('deals')
        .select('developer, commission_amount')
        .eq('id', resolvedDealId)
        .maybeSingle()
      dealData = data
    }

    // Platzhalter-Daten (WA-Format und E-Mail-Format)
    const placeholders: Record<string, string> = {
      // WhatsApp-Format (WA_FIELDS keys)
      lead_name:         `${lead.first_name} ${lead.last_name}`.trim(),
      lead_phone:        lead.phone        ?? '',
      lead_email:        lead.email        ?? '',
      lead_whatsapp:     lead.whatsapp     ?? '',
      // E-Mail-Format ({{vorname}} etc.)
      vorname:           lead.first_name,
      nachname:          lead.last_name,
      email:             lead.email,
      phone:             lead.phone        ?? '',
      // Deal-Daten
      developers:        dealData?.developer     ?? '',
      commission_amount: dealData?.commission_amount != null
        ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
            .format(dealData.commission_amount)
        : '',
    }

    // ── 4. Für jede Regel eine scheduled_message anlegen ──────────────────────
    let scheduled = 0

    for (const rule of rules as {
      id: string
      message_type: string
      delay_minutes: number
      email_template_id: string | null
      whatsapp_event_type: string | null
    }[]) {
      const scheduledAt = new Date(Date.now() + rule.delay_minutes * 60 * 1000)

      let emailSubject: string | null = null
      let emailBody:    string | null = null
      let waText:       string | null = null

      // ── E-Mail-Template laden und rendern ────────────────────────────────
      if ((rule.message_type === 'email' || rule.message_type === 'both') && rule.email_template_id) {
        const { data: tpl } = await supabase
          .from('email_templates')
          .select('subject, body')
          .eq('id', rule.email_template_id)
          .single()

        if (tpl) {
          emailSubject = substitute(tpl.subject, placeholders)
          emailBody    = substitute(tpl.body,    placeholders)
        } else {
          console.warn(`[schedule-message] E-Mail-Template ${rule.email_template_id} nicht gefunden – Regel ${rule.id} übersprungen`)
          continue
        }
      }

      // ── WhatsApp-Template laden und rendern ──────────────────────────────
      if ((rule.message_type === 'whatsapp' || rule.message_type === 'both') && rule.whatsapp_event_type) {
        const { data: tpl } = await supabase
          .from('whatsapp_templates')
          .select('message_template')
          .eq('event_type', rule.whatsapp_event_type)
          .eq('active', true)
          .single()

        if (tpl) {
          waText = substitute(tpl.message_template as string, placeholders)
        } else {
          console.warn(`[schedule-message] WA-Template "${rule.whatsapp_event_type}" nicht gefunden – Regel ${rule.id} übersprungen`)
          // Bei 'both' WA-Teil überspringen, E-Mail trotzdem planen
          if (rule.message_type === 'both') {
            // Nur E-Mail einplanen
          }
        }
      }

      // Planen: mindestens eine Nachricht muss gerendert sein
      const hasEmail = emailSubject && emailBody
      const hasWa    = waText

      if (!hasEmail && !hasWa) {
        console.warn(`[schedule-message] Regel ${rule.id}: Kein Template vorhanden – übersprungen`)
        continue
      }

      const effectiveType =
        hasEmail && hasWa ? 'both' :
        hasEmail           ? 'email' : 'whatsapp'

      const { error: insertErr } = await supabase
        .from('scheduled_messages')
        .insert({
          lead_id:       lead_id,
          deal_id:       resolvedDealId,
          type:          effectiveType,
          event_type:    event_type,
          status:        'pending',
          scheduled_at:  scheduledAt.toISOString(),
          email_subject: emailSubject,
          email_body:    emailBody,
          whatsapp_text: waText,
          rule_id:       rule.id,
        })

      if (insertErr) {
        console.error(`[schedule-message] Insert Fehler Regel ${rule.id}:`, insertErr.message)
      } else {
        scheduled++
        console.log(`[schedule-message] Geplant: event="${event_type}" type="${effectiveType}" at="${scheduledAt.toISOString()}" delay=${rule.delay_minutes}min`)
      }
    }

    return new Response(
      JSON.stringify({ ok: true, scheduled }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[schedule-message] Fehler:', msg)
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
