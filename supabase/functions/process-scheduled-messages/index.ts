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
import { htmlToText as stripHtml } from '../_shared/htmlToText.ts'
import { encodeMimeSubject } from '../_shared/mimeSubject.ts'
import { buildMimeContent } from '../_shared/mimeBody.ts'
import { buildIcs, toB64 } from '../_shared/ics.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── E-Mail via SMTP senden ────────────────────────────────────────────────────
async function sendEmail(params: {
  to:      string
  subject: string
  html:    string
  smtpUser: string
  smtpPass: string
  attachments?: { filename: string; content: string; contentType: string }[]
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = {
      from:    `Sven von Happy Property Cyprus <${params.smtpUser}>`,
      to:      params.to,
      subject: encodeMimeSubject(params.subject),
      // Body als Base64-mimeContent statt html/content — umgeht denomailers kaputten
      // QP-Zeilenumbruch, der UTF-8-Umlaute an der Zeilengrenze zerstört (mimeBody.ts).
      mimeContent: buildMimeContent(params.html, stripHtml(params.html)),
    }
    if (params.attachments?.length) {
      payload.attachments = params.attachments.map(a => ({
        filename: a.filename, content: a.content, contentType: a.contentType, encoding: 'base64',
      }))
    }
    await client.send(payload)
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
  lead: { email: string | null; phone: string | null; whatsapp: string | null; language: string | null },
  dealId: string | null,
): Promise<{ email: string | null; phone: string | null; language: string }> {
  // Dynamisch: Developer-Kontakt der vom Lead gewählten Unit (Reservierung etc.)
  if (recipient === 'unit_developer') {
    if (!dealId) return { email: null, phone: null, language: 'de' }
    const { data: deal } = await supabase.from('deals').select('unit_id').eq('id', dealId).maybeSingle()
    const unitId = (deal as { unit_id?: string } | null)?.unit_id
    if (!unitId) return { email: null, phone: null, language: 'de' }
    const { data: unit } = await supabase.from('crm_project_units').select('crm_projects(developer)').eq('id', unitId).maybeSingle()
    const devName = (unit as { crm_projects?: { developer?: string } } | null)?.crm_projects?.developer
    if (!devName) return { email: null, phone: null, language: 'de' }
    const { data: dev } = await supabase.from('crm_developers').select('id').ilike('name', devName).maybeSingle()
    const devId = (dev as { id?: string } | null)?.id
    if (!devId) return { email: null, phone: null, language: 'de' }
    const { data } = await supabase.from('crm_developer_contacts')
      .select('email, phone, whatsapp, language').eq('developer_id', devId).order('is_primary', { ascending: false }).limit(1).maybeSingle()
    const d = data as { email: string | null; phone: string | null; whatsapp: string | null; language: string | null } | null
    return { email: d?.email ?? null, phone: (d?.whatsapp || d?.phone) ?? null, language: d?.language ?? 'de' }
  }
  if (recipient && (recipient.startsWith('bc:') || recipient.startsWith('dc:'))) {
    const table = recipient.startsWith('bc:') ? 'crm_business_contacts' : 'crm_developer_contacts'
    const { data } = await supabase.from(table)
      .select('email, phone, whatsapp, language')
      .eq('id', recipient.slice(3))
      .maybeSingle()
    const d = data as { email: string | null; phone: string | null; whatsapp: string | null; language: string | null } | null
    return { email: d?.email ?? null, phone: (d?.whatsapp || d?.phone) ?? null, language: d?.language ?? 'de' }
  }
  return { email: lead.email, phone: lead.whatsapp || lead.phone, language: lead.language ?? 'de' }
}

// ── Ausgehende Nachricht in Empfängersprache übersetzen ───────────────────────
// Deutsch ist Autoren-/Standardsprache → bei 'de' KEIN API-Call (schnell + gratis).
// Bei 'en' (Geschäftspartner mit EN als Kontaktsprache ODER englischsprachige Leads)
// wird Betreff/HTML-Body/WhatsApp in EINEM Claude-Call übersetzt — HTML, Links,
// Namen, Zahlen, Preise bleiben unangetastet. So kommt jede Vorlage in der
// gewählten Sprache an, ohne sie doppelt pflegen zu müssen. Fehler → Original (DE).
async function translateOutbound(
  fields: { subject: string | null; body: string | null; whatsapp: string | null },
  targetLang: string,
): Promise<{ subject: string | null; body: string | null; whatsapp: string | null }> {
  if (!targetLang || targetLang === 'de') return fields
  if (!fields.subject && !fields.body && !fields.whatsapp) return fields
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) { console.warn('[translate] ANTHROPIC_API_KEY fehlt – sende Original (DE)'); return fields }
  const langName = targetLang === 'en' ? 'English' : targetLang
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: `You translate outbound real-estate CRM messages from German into ${langName}. Translate ONLY human-readable text. Preserve EXACTLY (do not translate or alter): all HTML tags/attributes/inline styles/structure, URLs and href links, email addresses, phone numbers, dates, times, amounts/prices/currencies, and proper/brand names (Happy Property, Sveru Ltd, Zoom). Do not add, drop, or reorder content. Keep the professional, concise tone. Return ONLY a raw JSON object {"subject":...,"body":...,"whatsapp":...} — each the translated value, or null where the input was null. No markdown, no code fences.`,
        messages: [{ role: 'user', content: JSON.stringify({ subject: fields.subject, body: fields.body, whatsapp: fields.whatsapp }) }],
      }),
    })
    if (!res.ok) { console.warn('[translate] API', res.status, (await res.text()).slice(0, 300)); return fields }
    const data = await res.json()
    let text = String(data?.content?.[0]?.text ?? '').trim()
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const out = JSON.parse(text)
    return {
      subject:  typeof out.subject  === 'string' ? out.subject  : fields.subject,
      body:     typeof out.body     === 'string' ? out.body     : fields.body,
      whatsapp: typeof out.whatsapp === 'string' ? out.whatsapp : fields.whatsapp,
    }
  } catch (e) {
    console.warn('[translate] fehlgeschlagen – sende Original (DE):', e instanceof Error ? e.message : String(e))
    return fields
  }
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

  // ── Sicherheitsnetz: Fertigmeldung erledigter Teilaufgaben ─────────────────
  // Muss VOR der Archivierung laufen — sonst verschluckt der Sonntagslauf alles,
  // was seit dem letzten Durchgang erledigt wurde. task-notify riegelt selbst per
  // done_notified_at ab, doppelte Meldungen sind also ausgeschlossen.
  try {
    await supabase.functions.invoke('task-notify', { body: { mode: 'subtask_sweep' } })
  } catch (e) { console.warn('[process-scheduled] Teilaufgaben-Fertigmeldung:', e) }

  // ── Aufgaben-Archivierung: erledigte Aufgaben werden SONNTAGS archiviert ─────
  // Erledigte Aufgaben bleiben die Woche über sichtbar und wandern erst am Sonntag
  // (Europe/Berlin) aus dem Board. Idempotent, läuft im 5-Min-Cron.
  try {
    const berlinWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(new Date())
    if (berlinWeekday === 'Sun') {
      await supabase.from('crm_tasks').update({ archived: true })
        .eq('status', 'erledigt').eq('archived', false)
    }
  } catch (e) { console.warn('[process-scheduled] Aufgaben-Archivierung:', e) }

  // ── Sicherheitsnetz: Terminerinnerungen für JEDEN zukünftigen Termin ─────────
  // Egal über welchen Weg gebucht wurde (Kalender manuell, Website-Funnel,
  // YouTube-/Meta-/Kanal-Link, WhatsApp-Bot, Calendly): jeder zukünftige Lead-Termin
  // muss seine 24 h-/1 h-Erinnerung bekommen. Falls ein Buchungspfad das Planen
  // vergisst oder fehlschlägt, holt dieser 5-Minuten-Lauf es zentral nach.
  // Idempotent: Leads mit bereits geplanten (pending/processing) termin_gebucht-
  // Erinnerungen werden übersprungen (keine Doppelung); schedule-message verwirft
  // selbst, was zeitlich nicht mehr planbar ist. Nur Termine ≥ 90 Min voraus, damit
  // die 1 h-Erinnerung sicher über dem 30-Min-Skip-Guard liegt (kein Endlos-Retry).
  try {
    const horizonIso = new Date(Date.now() + 90 * 60_000).toISOString()
    // internal ausgeschlossen: interne Termine (Mitarbeitende buchen bei Sven ueber
    // den persoenlichen Link) sind keine Kundentermine und duerfen keine
    // Termin-Erinnerung an einen Lead ausloesen.
    const { data: upcoming } = await supabase.from('crm_appointments')
      .select('lead_id, start_time')
      .not('lead_id', 'is', null)
      .eq('internal', false)
      .gte('start_time', horizonIso)
      .order('start_time', { ascending: true })
      .limit(300)
    const seen = new Set<string>()
    for (const a of (upcoming ?? []) as Array<{ lead_id: string }>) {
      if (!a.lead_id || seen.has(a.lead_id)) continue
      seen.add(a.lead_id)
      const { data: has } = await supabase.from('scheduled_messages')
        .select('id').eq('lead_id', a.lead_id).eq('event_type', 'termin_gebucht')
        .in('status', ['pending', 'processing']).limit(1)
      if (has && has.length) continue
      await supabase.functions.invoke('schedule-message', {
        body: { lead_id: a.lead_id, event_type: 'termin_gebucht', only_timing: 'before_appointment' },
      }).catch(e => console.warn('[process-scheduled] Erinnerungs-Nachplanung fehlgeschlagen:', e))
    }
  } catch (e) {
    console.warn('[process-scheduled] Sicherheitsnetz Erinnerungen:', e)
  }

  const processed: { id: string; result: string }[] = []
  let claimedIds: string[] = []

  try {
    // ── Schritt 1: Fällige Nachrichten ATOMAR claimen ────────────────────────
    // ACHTUNG (alter Bug): PostgREST .update().limit(n) begrenzt nur die ZURÜCK-
    // GEGEBENEN Zeilen, NICHT das UPDATE selbst — es kippten ALLE fälligen Zeilen auf
    // 'processing', die über n hinaus blieben für immer hängen; bei Überlappung zweier
    // Läufe drohte Doppelversand. Daher echter Claim via DB-Funktion mit
    // FOR UPDATE SKIP LOCKED LIMIT n (begrenzt wirklich + race-sicher).
    const { data: messages, error: fetchErr } = await supabase
      .rpc('claim_scheduled_messages', { p_limit: 20 })

    if (fetchErr) throw fetchErr
    if (!messages || messages.length === 0) {
      console.log('[process-scheduled] Keine fälligen Nachrichten')
      return new Response(
        JSON.stringify({ ok: true, processed: 0 }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    claimedIds = (messages as Array<{ id: string }>).map(m => m.id)
    console.log(`[process-scheduled] Verarbeite ${messages.length} Nachricht(en)`)

    // Vor-Termin-Regeln (Terminerinnerungen): für den Verschiebe-Guard unten.
    // Texte + scheduled_at wurden bei der PLANUNG aus der damaligen Terminzeit gerendert —
    // wurde der Termin danach verschoben, stimmt beides nicht mehr.
    const { data: beforeRulesData } = await supabase
      .from('automation_rules').select('id, delay_minutes, event_type').eq('timing_type', 'before_appointment')
    const beforeRules = new Map<string, { delay_minutes: number; event_type: string }>(
      ((beforeRulesData ?? []) as Array<{ id: string; delay_minutes: number; event_type: string }>).map(r => [r.id, r]),
    )
    const refiredLeads = new Set<string>()

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
      bot_nudge_stage:  number | null
      bot_nudge_source: string | null
      rule_id:       string | null
      scheduled_at:  string
    }[]) {
      let success = true
      const errors: string[] = []

      // ── Termin-Bot: an booking-bot delegieren (dynamische AM/PM-Slots statt statischem
      // Text). Stage 0 = Gespräch ERÖFFNEN (+20 Min nach No-Show/Erstkontakt), Stage ≥1 =
      // No-Show-Nudge. Der Bot prüft selbst Opt-Out/Termin/Engagement + sendet.
      if (msg.bot_nudge_stage != null) {
        // Stage 0 ERÖFFNET ein Gespräch (No-Show/Erstkontakt/Deck-Ansicht); bei
        // Immobilienauswahl ist auch Stage 0 ein Nudge (kein separater Start).
        const isStart = msg.bot_nudge_stage === 0 && ['no_show', 'erstkontakt', 'deck_viewed'].includes(msg.bot_nudge_source ?? '')
        const botBody = isStart
          ? { action: 'start', lead_id: msg.lead_id, deal_id: msg.deal_id, source: msg.bot_nudge_source }
          : { action: 'nudge', lead_id: msg.lead_id, stage: msg.bot_nudge_stage, source: msg.bot_nudge_source ?? 'no_show' }
        // booking-bot meldet per `skipped`, WARUM nichts rausging (no_phone, no_slots,
        // optout, has_appointment, engaged …). Diese Antwort NICHT ignorieren, sonst
        // wird ein nie gesendeter Nudge still als „sent" markiert (z.B. Lead ohne
        // Telefonnummer → Kunde bekommt nie eine WhatsApp, und niemand sieht es).
        let botSkip: string | null = null
        try {
          const br = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-bot`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(botBody),
          })
          const bj = await br.json().catch(() => ({})) as { skipped?: string }
          botSkip = br.ok ? (bj.skipped ?? null) : 'error'
        } catch (e) { console.warn('[process-scheduled] bot_nudge Fehler:', e); botSkip = 'error' }

        // no_phone/no_slots/error = echtes Problem → failed + Grund (sichtbar im Postausgang).
        // disabled/optout/has_appointment/engaged/engaged_or_closed = gewollt kein Versand → skipped.
        if (botSkip === 'no_phone' || botSkip === 'no_slots' || botSkip === 'error') {
          const reason = botSkip === 'no_phone' ? 'Keine Telefonnummer am Lead — WhatsApp konnte nicht gesendet werden'
            : botSkip === 'no_slots' ? 'Keine freien Termine für den Vorschlag verfügbar'
            : 'Termin-Bot-Aufruf fehlgeschlagen'
          await supabase.from('scheduled_messages').update({ status: 'failed', error_message: reason, sent_at: new Date().toISOString() }).eq('id', msg.id)
          processed.push({ id: msg.id, result: `bot_failed:${botSkip}` })
        } else if (botSkip) {
          await supabase.from('scheduled_messages').update({ status: 'skipped', sent_at: new Date().toISOString() }).eq('id', msg.id)
          processed.push({ id: msg.id, result: `bot_skipped:${botSkip}` })
        } else {
          await supabase.from('scheduled_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', msg.id)
          processed.push({ id: msg.id, result: `bot_${isStart ? 'start' : 'nudge'}:${msg.bot_nudge_stage}` })
        }
        continue
      }

      // Lead-E-Mail + Telefon für Versand laden
      const { data: lead } = await supabase
        .from('leads')
        .select('email, phone, whatsapp, language')
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

      // ── Terminerinnerung: Verschiebe-Guard ────────────────────────────────
      // Weicht die Soll-Sendezeit (aktuelle Terminzeit − delay) von der geplanten
      // Sendezeit ab, wurde der Termin verschoben → alte Erinnerungen (falscher Text!)
      // verwerfen und aus der neuen Terminzeit frisch planen. Ein Re-Fire pro Lead.
      const beforeRule = msg.rule_id ? beforeRules.get(msg.rule_id) : undefined
      if (beforeRule) {
        const { data: nx } = await supabase.from('crm_appointments')
          .select('start_time').eq('lead_id', msg.lead_id).gte('start_time', new Date().toISOString())
          .order('start_time', { ascending: true }).limit(1).maybeSingle()
        const nxStart = (nx as { start_time?: string } | null)?.start_time
        const expected = nxStart ? new Date(nxStart).getTime() - beforeRule.delay_minutes * 60000 : null
        if (expected !== null && Math.abs(expected - new Date(msg.scheduled_at).getTime()) > 15 * 60000) {
          await supabase.from('scheduled_messages')
            .update({ status: 'skipped', sent_at: new Date().toISOString(), error_message: 'Termin verschoben – Erinnerung neu geplant' })
            .eq('id', msg.id)
          if (!refiredLeads.has(msg.lead_id)) {
            refiredLeads.add(msg.lead_id)
            // übrige veraltete Erinnerungen des Leads mit verwerfen, dann frisch planen
            await supabase.from('scheduled_messages')
              .update({ status: 'skipped', error_message: 'Termin verschoben – Erinnerung neu geplant' })
              .eq('lead_id', msg.lead_id).eq('status', 'pending').in('rule_id', [...beforeRules.keys()])
            try {
              await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/schedule-message`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ lead_id: msg.lead_id, deal_id: msg.deal_id, event_type: beforeRule.event_type, only_timing: 'before_appointment' }),
              })
            } catch (e) { console.warn('[process-scheduled] Erinnerungs-Neuplanung fehlgeschlagen:', e) }
          }
          processed.push({ id: msg.id, result: 'skipped:rescheduled' })
          continue
        }
      }

      // ── B/D) Termin-Bedingung erneut prüfen (Zustand kann sich seit Planung geändert haben) ──
      // Newsletter-Abmeldung zwischen Planung und Versand: Mail überspringen.
      if (msg.event_type === 'newsletter' && msg.lead_id) {
        const { data: ol } = await supabase.from('leads').select('newsletter_optout_at').eq('id', msg.lead_id).maybeSingle()
        if ((ol as { newsletter_optout_at?: string | null } | null)?.newsletter_optout_at) {
          await supabase.from('scheduled_messages')
            .update({ status: 'skipped', sent_at: new Date().toISOString(), error_message: 'Newsletter abbestellt' })
            .eq('id', msg.id)
          processed.push({ id: msg.id, result: 'skipped_newsletter_optout' })
          continue
        }
      }

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
      const rcpt = await resolveRecipient(supabase, msg.recipient, lead, msg.deal_id)

      // In Empfängersprache übersetzen (nur wenn ≠ de → sonst 1:1 Original).
      const loc = await translateOutbound(
        { subject: msg.email_subject, body: msg.email_body, whatsapp: msg.whatsapp_text },
        rcpt.language,
      )
      const emailSubject = loc.subject
      const emailBody    = loc.body
      const whatsappText = loc.whatsapp

      // ── E-Mail senden ─────────────────────────────────────────────────────
      if ((msg.type === 'email' || msg.type === 'both') && msg.email_subject && msg.email_body) {
        if (!rcpt.email) {
          console.warn(`[process-scheduled] Kein Empfänger-E-Mail für ${msg.id} (recipient=${msg.recipient})`)
          errors.push('email: kein Empfänger')
          success = false
        } else if (smtpUser && smtpPass) {
          try {
            // Terminbestätigung (termin_gebucht): .ics-Kalenderdatei anhängen, damit
            // der Kunde den Termin 1-Klick in seinen Kalender übernimmt — inkl. Zoom-Link.
            let attachments: { filename: string; content: string; contentType: string }[] | undefined
            if (msg.event_type === 'termin_gebucht') {
              try {
                const { data: ap } = await supabase.from('crm_appointments')
                  .select('id, title, start_time, end_time, zoom_link')
                  .eq('lead_id', msg.lead_id).gte('start_time', new Date().toISOString())
                  .order('start_time', { ascending: true }).limit(1).maybeSingle()
                const a = ap as { id: string; title: string | null; start_time: string; end_time: string; zoom_link: string | null } | null
                if (a) {
                  const isZoom = !!a.zoom_link
                  const ics = buildIcs({
                    uid:         a.id,
                    title:       a.title || 'Beratungsgespräch mit Sven – Happy Property',
                    startIso:    new Date(a.start_time).toISOString(),
                    endIso:      new Date(a.end_time).toISOString(),
                    description: `Beratungsgespräch mit Sven · Happy Property${isZoom ? `\nZoom: ${a.zoom_link}` : '\nWir sprechen per WhatsApp / Telefon.'}`,
                    location:    isZoom ? (a.zoom_link as string) : 'WhatsApp / Telefon',
                    url:         isZoom ? (a.zoom_link as string) : undefined,
                  })
                  attachments = [{ filename: 'termin.ics', content: toB64(ics), contentType: 'text/calendar; method=PUBLISH; charset=UTF-8' }]
                }
              } catch (icsErr) { console.warn('[process-scheduled] ICS-Anhang fehlgeschlagen:', icsErr) }
            }
            await sendEmail({
              to:       rcpt.email,
              subject:  emailSubject ?? msg.email_subject,
              html:     emailBody ?? msg.email_body,
              smtpUser, smtpPass,
              attachments,
            })
            await logActivity(supabase, {
              lead_id: msg.lead_id,
              deal_id: msg.deal_id,
              type:    'email',
              subject: emailSubject ?? msg.email_subject,
              content: stripHtml(emailBody ?? msg.email_body),
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
            subject: emailSubject ?? msg.email_subject,
            content: `[Simulation] ${stripHtml(emailBody ?? msg.email_body)}`,
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
                message:     whatsappText ?? msg.whatsapp_text,
                apiKey:      waApiKey,
                senderPhone: waSender,
              })
              await logActivity(supabase, {
                lead_id: msg.lead_id,
                deal_id: msg.deal_id,
                type:    'whatsapp',
                subject: `WhatsApp: ${msg.event_type}`,
                content: whatsappText ?? msg.whatsapp_text,
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
              content: whatsappText ?? msg.whatsapp_text,
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

    // NUR die in DIESEM Lauf geclaimten, noch nicht finalisierten Nachrichten
    // zurücksetzen (nicht global — sonst würde ein parallel laufender Versand
    // mitgerissen). Beim nächsten Lauf werden sie erneut versucht.
    if (claimedIds.length) {
      await supabase
        .from('scheduled_messages')
        .update({ status: 'pending' })
        .in('id', claimedIds)
        .eq('status', 'processing')
        .catch(console.error)
    }

    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
