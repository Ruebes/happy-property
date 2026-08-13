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
import { lotteBild } from '../_shared/lotte.ts'
import { translateOutbound } from '../_shared/translate.ts'
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

// ── WhatsApp senden — ueber send-whatsapp, NICHT direkt an Timelines ──────────
// Vorher postete diese Datei selbst an die Timelines-API. Damit war der gesamte
// Pipeline-, Drip- und Termin-Verkehr strukturell bildunfaehig: die komplette
// Bild-Logik (Upload, Verkleinerung auf WebP, 2-MB-Guard, automatischer Anhang von
// Deck-Titelbild bzw. YouTube-Vorschaubild) sitzt in send-whatsapp, und die wurde
// hier nie berührt. Genau deshalb kam die Terminbestaetigung immer als nackter Text.
async function sendWhatsApp(params: {
  supabase:     SupabaseClient
  phone:        string
  message:      string
  name?:        string
  imageUrl?:    string | null
  alsLotte?:    boolean          // true = Kunde → Lotte-Bild (nachrangig hinter Vorlagen-/Deck-Bild)
}): Promise<void> {
  const { data, error } = await params.supabase.functions.invoke('send-whatsapp', {
    body: {
      event_type: 'scheduled', override_text: params.message,
      lead_data: { lead_name: params.name ?? 'Kunde', lead_phone: params.phone },
      ...(params.imageUrl ? { file_url: params.imageUrl, file_name: 'bild.jpg' } : {}),
      ...(params.alsLotte && !params.imageUrl ? { persona_image: lotteBild() } : {}),
    },
  })
  if (error) throw error
  const r = data as { success?: boolean; results?: Array<{ ok?: boolean; status?: number }> } | null
  if (!r?.success) throw new Error(`send-whatsapp: ${JSON.stringify(data)}`)
  console.log(`[process-scheduled] ✓ WhatsApp an ${params.phone}${params.imageUrl ? ' (mit Bild)' : ''}`)
}

// Newsletter-Abonnent (Klaviyo-Liste): kein Lead, nur eine Mailadresse. Bewusst
// getrennt gehalten — eine Webinar-Anmeldung ist kein Vertriebs-Lead und darf
// weder Pipeline noch Auswertungen verschmutzen.
async function resolveSubscriber(
  supabase: ReturnType<typeof createClient>,
  subscriberId: string,
): Promise<{ email: string | null; phone: string | null; language: string }> {
  const { data } = await supabase.from('newsletter_subscribers')
    .select('email, phone, optout_at, properties').eq('id', subscriberId).maybeSingle()
  const s = data as { email: string | null; phone: string | null; optout_at: string | null; properties: Record<string, unknown> | null } | null
  // Abmeldung nach dem Einplanen: hier nochmal pruefen, sonst geht die Mail raus.
  if (!s || s.optout_at) return { email: null, phone: null, language: 'de' }
  // Sprache aus properties (Anmelde-Strecke schreibt sie dort), sonst DE.
  const lang = s.properties?.lang === 'en' ? 'en' : 'de'
  // Telefon ermöglicht Listen-WhatsApp (früher hart null → WhatsApp an Abonnenten blockiert).
  return { email: s.email, phone: s.phone ?? null, language: lang }
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
  // 'vw:<id>' → Verwaltung (Ansprechpartner-Kontaktdaten, sonst Firmen-Daten)
  if (recipient && recipient.startsWith('vw:')) {
    const { data } = await supabase.from('verwaltungen')
      .select('email, phone, ansprechpartner_email, ansprechpartner_phone, language')
      .eq('id', recipient.slice(3)).maybeSingle()
    const v = data as { email: string | null; phone: string | null; ansprechpartner_email: string | null; ansprechpartner_phone: string | null; language: string | null } | null
    return { email: (v?.ansprechpartner_email || v?.email) ?? null, phone: (v?.ansprechpartner_phone || v?.phone) ?? null, language: v?.language ?? 'de' }
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
// translateOutbound liegt jetzt in _shared/translate.ts (von allen Sendewegen genutzt).
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
    auto:         true,   // Drip/Stage/Automatik → im Posteingang ausgeblendet
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

  // ── Bug-Meldungen aus dem Eigentümerportal: erledigt → Melder informieren ──
  // owner-content riegelt selbst per bug_done_notified_at (CAS) ab.
  try {
    const { data: bugs } = await supabase.from('crm_tasks').select('id')
      .eq('source', 'bug_report').eq('status', 'erledigt').is('bug_done_notified_at', null).limit(10)
    for (const b of ((bugs ?? []) as { id: string }[])) {
      await supabase.functions.invoke('owner-content', { body: { action: 'bug_done', task_id: b.id } })
    }
  } catch (e) { console.warn('[process-scheduled] Bug-Fertigmeldung:', e) }

  // ── Pipeline „Immobilienauswahl" → Portal-Zugang von Lotte (nur NEUE Wechsel) ─
  // FLOW_START schützt die 22 Bestands-Deals vor einem Massen-Versand; Marker
  // leads.portal_invited_at (CAS) verhindert Doppel-Einladungen.
  try {
    const FLOW_START = '2026-08-02T05:00:00Z'
    const PORTAL = 'https://portal.happy-property.com'
    const { data: cand } = await supabase.from('deals')
      .select('id, phase_changed_at, lead:leads!inner(id, first_name, last_name, email, phone, language, portal_invited_at)')
      .eq('phase', 'immobilienauswahl').gte('phase_changed_at', FLOW_START).limit(20)
    for (const dd of ((cand ?? []) as Array<{ lead: { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; language: string | null; portal_invited_at: string | null } | null }>)) {
      const l = dd.lead
      if (!l?.email || l.portal_invited_at) continue
      const { data: claimed } = await supabase.from('leads').update({ portal_invited_at: new Date().toISOString() })
        .eq('id', l.id).is('portal_invited_at', null).select('id')
      if (!claimed || !claimed.length) continue
      const { data: existing } = await supabase.from('profiles').select('id').ilike('email', l.email).limit(1)
      if (existing && existing.length) { console.log('[process-scheduled] Portal-Zugang existiert schon:', l.email); continue }
      const fullName = [l.first_name, l.last_name].filter(Boolean).join(' ') || 'Kunde'
      const { data: acc, error: accErr } = await supabase.functions.invoke('create-eigentuemer-access', {
        body: { email: l.email, full_name: fullName, suppress_mail: true },
        // functions.invoke setzt hier KEINEN eigenen Authorization-Header —
        // der Guard drüben erwartet den Service-Role-Key explizit.
        headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      })
      const a = (acc ?? {}) as { success?: boolean; password?: string; error?: string }
      if (accErr || a.error || !a.success || !a.password) {
        console.warn('[process-scheduled] Portal-Zugang fehlgeschlagen:', l.email, a.error ?? accErr?.message)
        await supabase.from('leads').update({ portal_invited_at: null }).eq('id', l.id)
        continue
      }
      const de_ = l.language !== 'en'
      const first = (l.first_name ?? '').trim() || (de_ ? 'Hallo' : 'Hi')
      const feats = de_
        ? '<li>🏠 alle deine Immobilien an einem Ort verwalten</li><li>🏗 den Baufortschritt live verfolgen</li><li>📈 deine Renditen einsehen</li><li>📄 Unterlagen für deinen Steuerberater herunterladen</li><li>💬 direkter Draht zu unserer Verwaltung</li>'
        : '<li>🏠 manage all your properties in one place</li><li>🏗 follow the construction progress</li><li>📈 view your returns</li><li>📄 download documents for your tax advisor</li><li>💬 direct line to our property management</li>'
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
        <div style="text-align:center;margin-bottom:6px;">
          <img src="${lotteBild()}" alt="Lotte" width="80" height="80" style="width:80px;height:80px;border-radius:50%;object-fit:cover;" />
          <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · ${de_ ? 'persönliche Assistentin von Sven' : "Sven's personal assistant"} 🐾</p>
        </div>
        <p>${de_ ? `Hallo ${first},` : `Hi ${first},`}</p>
        <p>${de_ ? 'schön, dass es bei dir losgeht! 🎉 Hier ist dein persönlicher Zugang zum <b>Happy Property Portal</b> — deinem Zuhause für alles rund um deine Immobilie auf Zypern:' : 'great that things are moving! 🎉 Here is your personal access to the <b>Happy Property Portal</b> — your home for everything around your property in Cyprus:'}</p>
        <ul style="line-height:1.9;padding-left:18px;">${feats}</ul>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin:16px 0;">
          <p style="margin:0;font-size:14px;"><b>${de_ ? 'Deine Zugangsdaten' : 'Your login'}</b><br/>E-Mail: ${l.email}<br/>${de_ ? 'Passwort' : 'Password'}: <b>${a.password}</b></p>
          <p style="margin:6px 0 0;font-size:12px;color:#6b7280;">${de_ ? 'Beim ersten Login legst du dein eigenes Passwort fest.' : 'You will set your own password on first login.'}</p>
        </div>
        <p style="text-align:center;margin:24px 0;">
          <a href="${PORTAL}/login" style="background:#ff795d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block;">${de_ ? 'Zum Portal →' : 'Open portal →'}</a>
        </p>
        <p style="font-size:13px;color:#6b7280;">${de_ ? 'Liebe Grüße' : 'Best regards'}<br/>Lotte 🐾</p>
      </div>`
      await supabase.functions.invoke('send-email', { body: {
        to: l.email, subject: de_ ? '🔑 Dein Zugang zum Happy Property Portal' : '🔑 Your access to the Happy Property portal',
        html, from_name: 'Lotte · Happy Property', auto: true, lang: de_ ? 'de' : 'en', lead_id: l.id,
      } }).catch(e => console.warn('[process-scheduled] Portal-Mail:', e))
      if (l.phone) {
        const waText = de_
          ? `Hallo ${first} 🐾\n\nhier ist Lotte von Happy Property! Dein persönlicher Zugang zum *Happy Property Portal* ist bereit 🎉\n\nDort verwaltest du künftig deine Immobilien, verfolgst den Baufortschritt, siehst deine Renditen, lädst Unterlagen für den Steuerberater herunter und erreichst direkt unsere Verwaltung.\n\nDeine Zugangsdaten kommen gerade separat per E-Mail. 📬\n\n${PORTAL}/login\n\nLiebe Grüße, Lotte`
          : `Hi ${first} 🐾\n\nLotte from Happy Property here! Your personal access to the *Happy Property portal* is ready 🎉\n\nManage your properties, follow the construction progress, view your returns, download documents for your tax advisor and reach our property management directly.\n\nYour login details are arriving by email right now. 📬\n\n${PORTAL}/login\n\nBest, Lotte`
        await supabase.functions.invoke('send-whatsapp', { body: {
          event_type: 'portal_zugang', override_text: waText,
          lead_data: { lead_name: first, lead_phone: l.phone }, persona_image: lotteBild(),
        } }).catch(e => console.warn('[process-scheduled] Portal-WA:', e))
      }
      console.log('[process-scheduled] Portal-Zugang angelegt + Lotte-Einladung:', l.email)
    }
  } catch (e) { console.warn('[process-scheduled] Portal-Invite:', e) }

  // ── Aufgaben-Archivierung: erledigte Aufgaben werden SONNTAGS archiviert ─────
  // Erledigte Aufgaben bleiben die Woche über sichtbar und wandern erst am Sonntag
  // (Europe/Berlin) aus dem Board. Idempotent, läuft im 5-Min-Cron.
  try {
    const berlinWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(new Date())
    if (berlinWeekday === 'Sun') {
      // Hauptaufgaben mit noch offener Zuarbeit bleiben stehen — sonst verschwindet
      // die Hauptaufgabe vom Board und mit ihr der einzige Ort, an dem die offene
      // Teilaufgabe fuer den Aufgabengeber sichtbar ist.
      const { data: withOpen } = await supabase.from('crm_tasks')
        .select('parent_task_id').not('parent_task_id', 'is', null).neq('status', 'erledigt')
      const blocked = [...new Set(((withOpen ?? []) as { parent_task_id: string }[]).map(r => r.parent_task_id))]
      let qy = supabase.from('crm_tasks').update({ archived: true, archived_at: new Date().toISOString() }).eq('status', 'erledigt').eq('archived', false)
      if (blocked.length) qy = qy.not('id', 'in', `(${blocked.join(',')})`)
      await qy
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
      // Gesetzt bei Newsletter-Empfaengern aus einer Liste (kein CRM-Lead).
      subscriber_id: string | null
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

      // Lead-E-Mail + Telefon für Versand laden. Newsletter-Abonnenten haben
      // KEINEN Lead — dort wird der Empfaenger unten aus newsletter_subscribers
      // aufgeloest, der Lead-Schritt wird uebersprungen.
      const { data: lead } = msg.subscriber_id
        ? { data: { email: null, phone: null, whatsapp: null, language: 'de' } }
        : await supabase
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
          .select('zoom_link, type').eq('lead_id', msg.lead_id).gte('start_time', new Date().toISOString())
          .order('start_time', { ascending: true }).limit(1).maybeSingle()
        const hasAppt = !!appt
        const hasZoom = !!(appt as { zoom_link?: string } | null)?.zoom_link
        // Vor-Ort-Termine dürfen NIE in die Telefon-Erinnerung („ich rufe dich an")
        // laufen — dafür gibt es eigene is_inperson-Regeln.
        const isInperson = (appt as { type?: string } | null)?.type === 'inperson'
        const shouldSend =
          cond === 'has_appointment' ? hasAppt :
          cond === 'no_appointment'  ? !hasAppt :
          cond === 'has_zoom'        ? (hasAppt && hasZoom) :
          cond === 'is_inperson'     ? (hasAppt && isInperson) :
          cond === 'no_zoom'         ? (hasAppt && !hasZoom && !isInperson) : true
        if (!shouldSend) {
          await supabase.from('scheduled_messages')
            .update({ status: 'skipped', sent_at: new Date().toISOString(), error_message: `Bedingung ${msg.appointment_condition} nicht erfüllt` })
            .eq('id', msg.id)
          processed.push({ id: msg.id, result: 'skipped:condition' })
          continue
        }
      }

      // ── Flow-Builder: Wenn/Dann-Bedingung (E-Mail geöffnet?) zur SENDEZEIT ──
      const seqCond = (msg as { seq_condition?: { kind?: string; negate?: boolean } | null }).seq_condition
      if (seqCond?.kind === 'email_opened') {
        let opened = false
        if (msg.subscriber_id) {
          const { data: ev } = await supabase.from('engagement_events').select('id').eq('subscriber_id', msg.subscriber_id).eq('type', 'email_open').limit(1)
          opened = !!(ev && ev.length)
        } else if (msg.lead_id) {
          const { data: ev } = await supabase.from('engagement_events').select('id').eq('lead_id', msg.lead_id).eq('type', 'email_open').limit(1)
          opened = !!(ev && ev.length)
        }
        const ok = seqCond.negate ? !opened : opened
        if (!ok) {
          await supabase.from('scheduled_messages').update({ status: 'skipped', sent_at: new Date().toISOString(), error_message: `Flow-Bedingung nicht erfüllt (email_opened${seqCond.negate ? '=nein' : '=ja'})` }).eq('id', msg.id)
          processed.push({ id: msg.id, result: 'skipped:flow_condition' })
          continue
        }
      }

      // ── Flow-Builder: Empfängerlisten-Update (kein Versand) ─────────────────
      if (msg.type === 'list_update') {
        const mu = msg as { seq_list_op?: string | null; seq_list_target?: string | null }
        try {
          if (mu.seq_list_target && msg.subscriber_id) {
            if (mu.seq_list_op === 'remove') {
              await supabase.from('newsletter_list_members').delete().eq('list_id', mu.seq_list_target).eq('subscriber_id', msg.subscriber_id)
            } else {
              await supabase.from('newsletter_list_members').upsert({ list_id: mu.seq_list_target, subscriber_id: msg.subscriber_id }, { onConflict: 'list_id,subscriber_id' })
            }
          }
          await supabase.from('scheduled_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', msg.id)
          processed.push({ id: msg.id, result: 'list_update' })
        } catch (e) {
          await supabase.from('scheduled_messages').update({ status: 'failed', error_message: String(e).slice(0, 300) }).eq('id', msg.id)
          processed.push({ id: msg.id, result: 'list_update:failed' })
        }
        continue
      }

      // Empfänger auflösen: Abonnent (Newsletter-Liste) hat Vorrang, sonst
      // 'client' = Lead bzw. fixer Kontakt (bc:/dc:).
      const rcpt = msg.subscriber_id
        ? await resolveSubscriber(supabase, msg.subscriber_id)
        : await resolveRecipient(supabase, msg.recipient, lead, msg.deal_id)

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
                  .select('id, title, start_time, end_time, zoom_link, type, location, location_url')
                  .eq('lead_id', msg.lead_id).gte('start_time', new Date().toISOString())
                  .order('start_time', { ascending: true }).limit(1).maybeSingle()
                const a = ap as { id: string; title: string | null; start_time: string; end_time: string; zoom_link: string | null; type: string | null; location: string | null; location_url: string | null } | null
                if (a) {
                  const isZoom = !!a.zoom_link
                  const isVorOrt = a.type === 'inperson'
                  const ics = buildIcs({
                    uid:         a.id,
                    title:       a.title || 'Beratungsgespräch mit Sven – Happy Property',
                    startIso:    new Date(a.start_time).toISOString(),
                    endIso:      new Date(a.end_time).toISOString(),
                    description: `Beratungsgespräch mit Sven · Happy Property${isVorOrt ? `\nWir treffen uns vor Ort${a.location ? `: ${a.location}` : ''}${a.location_url ? `\n${a.location_url}` : ''}` : isZoom ? `\nZoom: ${a.zoom_link}` : '\nWir sprechen per WhatsApp / Telefon.'}`,
                    location:    isVorOrt ? (a.location || 'Vor Ort') : isZoom ? (a.zoom_link as string) : 'WhatsApp / Telefon',
                    url:         isVorOrt ? (a.location_url ?? undefined) : isZoom ? (a.zoom_link as string) : undefined,
                  })
                  attachments = [{ filename: 'termin.ics', content: toB64(ics), contentType: 'text/calendar; method=PUBLISH; charset=UTF-8' }]
                }
              } catch (icsErr) { console.warn('[process-scheduled] ICS-Anhang fehlgeschlagen:', icsErr) }
            }
            // Abonnenten-Mails: Öffnungs-Pixel für den Flow-Split „E-Mail geöffnet?"
            const htmlOut = (emailBody ?? msg.email_body) + (msg.subscriber_id
              ? `<img src="${Deno.env.get('SUPABASE_URL')}/functions/v1/subscriber-optin?open=${msg.subscriber_id}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;">`
              : '')
            await sendEmail({
              to:       rcpt.email,
              subject:  emailSubject ?? msg.email_subject,
              html:     htmlOut,
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
                supabase,
                phone,
                message:  whatsappText ?? msg.whatsapp_text,
                name:     rcpt.name,
                imageUrl: msg.whatsapp_image_url ?? null,
                // Kunden-WhatsApps tragen ein Lotte-Bild (wie die Bot-Nachrichten),
                // damit ALLE automatischen Kunden-WhatsApps eine Bildkarte haben.
                // Partner/Developer (bc:/dc:/unit_developer) bekommen keins.
                alsLotte: !msg.recipient || msg.recipient === 'client',
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
