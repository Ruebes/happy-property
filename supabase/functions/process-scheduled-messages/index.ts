// Edge Function: process-scheduled-messages
// Wird alle 5 Minuten via pg_cron aufgerufen.
// Holt alle fälligen scheduled_messages (status='pending', scheduled_at <= now()),
// markiert sie atomar als 'processing', sendet E-Mail und/oder WhatsApp,
// und schreibt das Ergebnis (sent / failed) zurück.
//
// Deployment:
//   supabase functions deploy process-scheduled-messages --no-verify-jwt
//
// pg_cron Setup (Supabase SQL-Editor):
//   SELECT cron.schedule(
//     'process-scheduled-messages', '*/5 * * * *',
//     $$ SELECT net.http_post(
//       url := 'https://<REF>.supabase.co/functions/v1/process-scheduled-messages',
//       headers := '{"Authorization":"Bearer <SERVICE_ROLE_KEY>","Content-Type":"application/json"}'::jsonb,
//       body := '{}'::jsonb
//     ) $$
//   );

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SMTPClient }   from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── HTML → Plaintext ──────────────────────────────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// ── E-Mail via SMTP senden ────────────────────────────────────────────────────
async function sendEmail(params: {
  to:      string
  subject: string
  html:    string
  smtpUser: string
  smtpPass: string
}): Promise<void> {
  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.ionos.de',
      port:     465,
      tls:      true,
      auth: { username: params.smtpUser, password: params.smtpPass },
    },
  })
  try {
    await client.send({
      from:    `Sven Rüprich <sven@happy-property.com>`,
      to:      params.to,
      subject: params.subject,
      html:    params.html,
      content: stripHtml(params.html),
    })
    console.log(`[process-scheduled] ✓ E-Mail an ${params.to}`)
  } finally {
    await client.close()
  }
}

// ── WhatsApp via Timelines API senden ─────────────────────────────────────────
async function sendWhatsApp(params: {
  phone:        string
  message:      string
  apiKey:       string
  senderPhone:  string
}): Promise<void> {
  const res = await fetch('https://app.timelines.ai/integrations/api/messages', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      phone:                  params.phone,
      whatsapp_account_phone: params.senderPhone,
      text:                   params.message,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Timelines API ${res.status}: ${body}`)
  }
  console.log(`[process-scheduled] ✓ WhatsApp an ${params.phone}`)
}

// ── Empfänger auflösen ────────────────────────────────────────────────────────
// 'client' (Standard) → Lead. 'bc:<id>'/'dc:<id>' → fixer Kontakt.
// Fehlender Kontakt → email/phone null (Versand schlägt sauber fehl, KEINE
// versehentliche Zustellung an den Klienten).
async function resolveRecipient(
  supabase: ReturnType<typeof createClient>,
  recipient: string | null,
  lead: { email: string | null; phone: string | null; whatsapp: string | null },
): Promise<{ email: string | null; phone: string | null }> {
  if (recipient && (recipient.startsWith('bc:') || recipient.startsWith('dc:'))) {
    const table = recipient.startsWith('bc:') ? 'crm_business_contacts' : 'crm_developer_contacts'
    const { data } = await supabase.from(table)
      .select('email, phone, whatsapp')
      .eq('id', recipient.slice(3))
      .maybeSingle()
    const d = data as { email: string | null; phone: string | null; whatsapp: string | null } | null
    return { email: d?.email ?? null, phone: (d?.whatsapp || d?.phone) ?? null }
  }
  return { email: lead.email, phone: lead.whatsapp || lead.phone }
}

// ── Aktivität im CRM loggen ───────────────────────────────────────────────────
async function logActivity(supabase: ReturnType<typeof createClient>, params: {
  lead_id:   string
  deal_id:   string | null
  type:      string
  subject:   string | null
  content:   string | null
}): Promise<void> {
  await supabase.from('activities').insert({
    lead_id:      params.lead_id,
    deal_id:      params.deal_id,
    type:         params.type,
    direction:    'outbound',
    subject:      params.subject,
    content:      params.content?.slice(0, 2000) ?? null,
    completed_at: new Date().toISOString(),
  })
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const smtpUser    = Deno.env.get('SMTP_USER')          ?? ''
  const smtpPass    = Deno.env.get('SMTP_PASS')          ?? ''
  const waApiKey    = Deno.env.get('TIMELINES_API_KEY')  ?? ''
  const waSender    = Deno.env.get('TIMELINES_WA_SENDER') ?? ''

  const processed: { id: string; result: string }[] = []

  try {
    // ── Schritt 1: Fällige Nachrichten atomar auf 'processing' setzen ─────────
    // Durch direktes UPDATE ... RETURNING verhindert dies Race Conditions
    // wenn zwei Instanzen gleichzeitig laufen.
    const { data: messages, error: fetchErr } = await supabase
      .from('scheduled_messages')
      .update({ status: 'processing' })
      .eq('status', 'pending')
      .lte('scheduled_at', new Date().toISOString())
      .select('id, lead_id, deal_id, type, event_type, email_subject, email_body, whatsapp_text, recipient, appointment_condition')
      .limit(20)   // Maximal 20 pro Lauf, um Timeouts zu vermeiden

    if (fetchErr) throw fetchErr
    if (!messages || messages.length === 0) {
      console.log('[process-scheduled] Keine fälligen Nachrichten')
      return new Response(
        JSON.stringify({ ok: true, processed: 0 }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[process-scheduled] Verarbeite ${messages.length} Nachricht(en)`)

    // ── Schritt 2: Jede Nachricht senden ─────────────────────────────────────
    for (const msg of messages as {
      id:            string
      lead_id:       string
      deal_id:       string | null
      type:          string
      event_type:    string
      email_subject: string | null
      email_body:    string | null
      whatsapp_text: string | null
      recipient:     string | null
      appointment_condition: string | null
    }[]) {
      let success = true
      const errors: string[] = []

      // Lead-E-Mail + Telefon für Versand laden
      const { data: lead } = await supabase
        .from('leads')
        .select('email, phone, whatsapp')
        .eq('id', msg.lead_id)
        .single()

      if (!lead) {
        await supabase
          .from('scheduled_messages')
          .update({ status: 'failed', error_message: 'Lead nicht gefunden', sent_at: new Date().toISOString() })
          .eq('id', msg.id)
        processed.push({ id: msg.id, result: 'failed:no_lead' })
        continue
      }

      // ── B/D) Termin-Bedingung erneut prüfen (Zustand kann sich seit Planung geändert haben) ──
      const cond = msg.appointment_condition
      if (cond && cond !== 'none') {
        const { data: appt } = await supabase.from('crm_appointments')
          .select('zoom_link').eq('lead_id', msg.lead_id).gte('start_time', new Date().toISOString())
          .order('start_time', { ascending: true }).limit(1).maybeSingle()
        const hasAppt = !!appt
        const hasZoom = !!(appt as { zoom_link?: string } | null)?.zoom_link
        const shouldSend =
          cond === 'has_appointment' ? hasAppt :
          cond === 'no_appointment'  ? !hasAppt :
          cond === 'has_zoom'        ? (hasAppt && hasZoom) :
          cond === 'no_zoom'         ? (hasAppt && !hasZoom) : true
        if (!shouldSend) {
          await supabase.from('scheduled_messages')
            .update({ status: 'skipped', sent_at: new Date().toISOString(), error_message: `Bedingung ${msg.appointment_condition} nicht erfüllt` })
            .eq('id', msg.id)
          processed.push({ id: msg.id, result: 'skipped:condition' })
          continue
        }
      }

      // Empfänger auflösen: 'client' = Lead, sonst fixer Kontakt (bc:/dc:)
      const rcpt = await resolveRecipient(supabase, msg.recipient, lead)

      // ── E-Mail senden ─────────────────────────────────────────────────────
      if ((msg.type === 'email' || msg.type === 'both') && msg.email_subject && msg.email_body) {
        if (!rcpt.email) {
          console.warn(`[process-scheduled] Kein Empfänger-E-Mail für ${msg.id} (recipient=${msg.recipient})`)
          errors.push('email: kein Empfänger')
          success = false
        } else if (smtpUser && smtpPass) {
          try {
            await sendEmail({
              to:       rcpt.email,
              subject:  msg.email_subject,
              html:     msg.email_body,
              smtpUser, smtpPass,
            })
            await logActivity(supabase, {
              lead_id: msg.lead_id,
              deal_id: msg.deal_id,
              type:    'email',
              subject: msg.email_subject,
              content: stripHtml(msg.email_body),
            })
          } catch (emailErr) {
            const errMsg = emailErr instanceof Error ? emailErr.message : String(emailErr)
            console.error(`[process-scheduled] E-Mail Fehler (${msg.id}):`, errMsg)
            errors.push(`email: ${errMsg}`)
            success = false
          }
        } else {
          // SMTP nicht konfiguriert → simulieren + loggen
          console.warn(`[process-scheduled] SMTP nicht konfiguriert – simulierter Versand an ${rcpt.email}`)
          await logActivity(supabase, {
            lead_id: msg.lead_id,
            deal_id: msg.deal_id,
            type:    'email',
            subject: msg.email_subject,
            content: `[Simulation] ${stripHtml(msg.email_body)}`,
          })
        }
      }

      // ── WhatsApp senden ───────────────────────────────────────────────────
      if ((msg.type === 'whatsapp' || msg.type === 'both') && msg.whatsapp_text) {
        const phone = rcpt.phone
        if (phone) {
          if (waApiKey && waSender) {
            try {
              await sendWhatsApp({
                phone,
                message:     msg.whatsapp_text,
                apiKey:      waApiKey,
                senderPhone: waSender,
              })
              await logActivity(supabase, {
                lead_id: msg.lead_id,
                deal_id: msg.deal_id,
                type:    'whatsapp',
                subject: `WhatsApp: ${msg.event_type}`,
                content: msg.whatsapp_text,
              })
            } catch (waErr) {
              const errMsg = waErr instanceof Error ? waErr.message : String(waErr)
              console.error(`[process-scheduled] WhatsApp Fehler (${msg.id}):`, errMsg)
              errors.push(`whatsapp: ${errMsg}`)
              success = false
            }
          } else {
            console.warn(`[process-scheduled] Timelines nicht konfiguriert – simulierter WA an ${phone}`)
            await logActivity(supabase, {
              lead_id: msg.lead_id,
              deal_id: msg.deal_id,
              type:    'whatsapp',
              subject: `[Simulation] WhatsApp: ${msg.event_type}`,
              content: msg.whatsapp_text,
            })
          }
        } else {
          console.warn(`[process-scheduled] Kein Telefon für Lead ${msg.lead_id}`)
          errors.push('whatsapp: kein Telefon')
        }
      }

      // ── Status zurückschreiben ────────────────────────────────────────────
      await supabase
        .from('scheduled_messages')
        .update({
          status:        success ? 'sent' : 'failed',
          sent_at:       new Date().toISOString(),
          error_message: errors.length > 0 ? errors.join(' | ') : null,
        })
        .eq('id', msg.id)

      processed.push({ id: msg.id, result: success ? 'sent' : 'failed' })
    }

    console.log(`[process-scheduled] Fertig: ${processed.filter(p => p.result === 'sent').length} gesendet, ${processed.filter(p => p.result.startsWith('failed')).length} fehlgeschlagen`)

    return new Response(
      JSON.stringify({ ok: true, processed: processed.length, details: processed }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[process-scheduled] Kritischer Fehler:', msg)

    // Alle 'processing' Nachrichten wieder auf 'pending' zurücksetzen
    // damit sie beim nächsten Lauf erneut versucht werden
    await supabase
      .from('scheduled_messages')
      .update({ status: 'pending' })
      .eq('status', 'processing')
      .catch(console.error)

    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
