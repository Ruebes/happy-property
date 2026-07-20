// Edge Function: funnel-api — öffentliche API für den eigenen Termin-Funnel
// (ersetzt Typeform + Calendly). Drei Aktionen:
//   track → Session anlegen / Schritt-Event loggen (Drop-off-Analyse)
//   slots → freie Termine: 4h Vorlauf, 12:00–20:00 Zypern-Zeit (Europe/Nicosia),
//           30-Min-Raster, gegen den Google-Kalender (Service-Account, freeBusy)
//   book  → Konflikt-Check + Lead-Upsert + Termin (CRM + Google) + Zoom-Meeting +
//           Bestätigung über die „Termin gebucht"-Pipeline-Vorlagen (Mail + WhatsApp)
//
// Deployment: supabase functions deploy funnel-api --no-verify-jwt

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { isInternalContact } from '../_shared/internalContact.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const TZ_CY = 'Asia/Nicosia'          // Buchungsfenster läuft in Zypern-Zeit
const SLOT_MIN = 30                    // Termindauer
const OPEN_H = 12, CLOSE_H = 20        // 12:00–20:00 Zypern-Zeit
const LEAD_HOURS = 4                   // Vorlauf
const DAYS_AHEAD = 14                  // Buchungsfenster

// ── Google Service-Account (Muster aus booking-bot) ─────────────────────────
function b64url(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
async function importKey(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\\n/g, '').replace(/\s+/g, '')
  return crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(b), c => c.charCodeAt(0)).buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
async function getSaToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON'); if (!raw) throw new Error('SA JSON fehlt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(sa.private_key), new TextEncoder().encode(unsigned))
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(new Uint8Array(sig))}` }) })
  const d = await res.json() as { access_token?: string }
  if (!d.access_token) throw new Error('SA-Token fehlgeschlagen')
  return d.access_token
}
async function getCalendarId(admin: SupabaseClient): Promise<string> {
  const { data } = await admin.from('crm_settings').select('value').eq('key', 'google_calendar_ids').maybeSingle()
  const raw = (data as { value?: string } | null)?.value
  return raw ? raw.split(',')[0].trim() : 'primary'
}
async function getBusy(admin: SupabaseClient, from: Date, to: Date): Promise<Array<{ start: number; end: number }>> {
  try {
    const calId = await getCalendarId(admin)
    const token = await getSaToken()
    const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calId }] }),
    })
    const d = await r.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }
    const busy = Object.values(d.calendars ?? {}).flatMap(c => c.busy ?? [])
    return busy.map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
  } catch (e) { console.warn('[funnel-api] freeBusy fehlgeschlagen:', e); return [] }
}
// CRM-Termine zusätzlich blocken (falls Google mal hakt)
async function getCrmBusy(admin: SupabaseClient, from: Date, to: Date): Promise<Array<{ start: number; end: number }>> {
  const { data } = await admin.from('crm_appointments').select('start_time, end_time')
    .gte('start_time', from.toISOString()).lte('start_time', to.toISOString())
  return ((data ?? []) as Array<{ start_time: string; end_time: string | null }>).map(a => ({
    start: new Date(a.start_time).getTime(),
    end: a.end_time ? new Date(a.end_time).getTime() : new Date(a.start_time).getTime() + SLOT_MIN * 60000,
  }))
}

// Zypern-Lokalzeit einer UTC-Instanz (Stunden/Minuten/Datumsteile)
function cyParts(d: Date): { y: number; mo: number; day: number; h: number; mi: number } {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_CY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0)
  return { y: g('year'), mo: g('month'), day: g('day'), h: g('hour'), mi: g('minute') }
}
// UTC-Zeitpunkt für eine Zypern-Lokalzeit (Offset-Probe, DST-sicher)
function cyToUtc(y: number, mo: number, day: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, day, h, mi)
  for (const offH of [3, 2]) {   // EEST +3 (Sommer) / EET +2 (Winter)
    const d = new Date(guess - offH * 3600e3)
    const p = cyParts(d)
    if (p.h === h && p.mi === mi && p.day === day) return d
  }
  return new Date(guess - 3 * 3600e3)
}

// Freie Slots: 30-Min-Raster 12:00–19:30 (Start) Zypern-Zeit, nächste 14 Tage, 4h Vorlauf
async function computeSlots(admin: SupabaseClient): Promise<string[]> {
  const now = new Date()
  const earliest = now.getTime() + LEAD_HOURS * 3600e3
  const to = new Date(now.getTime() + (DAYS_AHEAD + 1) * 24 * 3600e3)
  const busy = [...await getBusy(admin, now, to), ...await getCrmBusy(admin, now, to)]
  const isFree = (t: number) => t >= earliest && !busy.some(b => t < b.end && t + SLOT_MIN * 60000 > b.start)
  const out: string[] = []
  for (let dOff = 0; dOff <= DAYS_AHEAD; dOff++) {
    const anchor = new Date(now.getTime() + dOff * 24 * 3600e3)
    const p = cyParts(anchor)
    for (let h = OPEN_H; h < CLOSE_H; h++) {
      for (const mi of [0, 30]) {
        if (h * 60 + mi + SLOT_MIN > CLOSE_H * 60) continue
        const start = cyToUtc(p.y, p.mo, p.day, h, mi)
        if (isFree(start.getTime())) out.push(start.toISOString())
      }
    }
  }
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json() as {
      action: 'track' | 'slots' | 'contact' | 'book' | 'manage_get' | 'manage_cancel' | 'manage_reschedule' | 'lead_prefill' | 'rsvp'
      p?: string
      session_id?: string
      lead_id?: string
      token?: string
      deck_token?: string
      reason?: string
      step?: number; question_key?: string; answer?: string
      utm?: Record<string, string>; referrer?: string
      slot_start_iso?: string
      meeting_type?: 'zoom' | 'whatsapp'
      source?: string
      contact?: { first_name?: string; last_name?: string; phone?: string; email?: string; website?: string }
      answers?: Array<{ question: string; answer: string }>
    }

    // ── rsvp: Zu-/Absage zu einer Termin-Einladung (öffentlich, manage_token) ──
    if (body.action === 'rsvp') {
      const tok = (body.token ?? '').trim()
      const pKey = (body.p ?? '').trim()
      const answer = body.answer === 'yes' ? 'yes' : body.answer === 'no' ? 'no' : null
      if (!tok || !pKey || !answer) return json({ error: 'Pflichtfelder fehlen' }, 400)
      const { data: appt } = await admin.from('crm_appointments')
        .select('id, lead_id, title, start_time, rsvps').eq('manage_token', tok).maybeSingle()
      const a = appt as { id: string; lead_id: string | null; title: string; start_time: string; rsvps: Record<string, { name?: string; status?: string; at?: string }> | null } | null
      if (!a) return json({ error: 'not_found' }, 404)
      const rsvps = a.rsvps ?? {}
      const entry = rsvps[pKey] ?? {}
      rsvps[pKey] = { ...entry, status: answer, at: new Date().toISOString() }
      const { error: ue } = await admin.from('crm_appointments').update({ rsvps }).eq('id', a.id)
      if (ue) return json({ error: ue.message }, 500)
      if (a.lead_id) {
        try {
          const who = entry.name || (pKey === 'lead' ? 'Der Kunde' : pKey.replace(/^a:/, ''))
          await admin.from('activities').insert({
            lead_id: a.lead_id, type: 'note', direction: 'inbound',
            subject: answer === 'yes' ? `✅ Zusage: ${a.title}` : `❌ Absage: ${a.title}`,
            content: `${who} hat für den Termin am ${new Date(a.start_time).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${answer === 'yes' ? 'zugesagt' : 'abgesagt'}.`,
            completed_at: new Date().toISOString(),
          })
        } catch (e) { console.warn('[funnel-api] rsvp activity:', e) }
      }
      return json({ ok: true, answer, title: a.title })
    }

    // ── lead_prefill ─────────────────────────────────────────────────────────
    // Direkteinstieg aus Newsletter/Mails: Deck-Token → Lead. Der Funnel überspringt
    // damit Fragebogen + Kontaktformular und geht direkt zur Terminwahl. Es wird
    // bewusst NUR der Vorname zurückgegeben (Begrüßung) — keine weiteren Daten.
    if (body.action === 'lead_prefill') {
      const tok = (body.deck_token ?? '').trim()
      if (!tok) return json({ error: 'deck_token fehlt' }, 400)
      const { data: deck } = await admin.from('sales_decks').select('lead_id').eq('token', tok).maybeSingle()
      const leadId = (deck as { lead_id?: string | null } | null)?.lead_id ?? null
      if (!leadId) return json({ error: 'not_found' }, 404)
      const { data: lead } = await admin.from('leads').select('first_name').eq('id', leadId).maybeSingle()
      return json({ ok: true, lead_id: leadId, first_name: ((lead as { first_name?: string | null } | null)?.first_name ?? '').trim() })
    }

    // ── track ────────────────────────────────────────────────────────────────
    if (body.action === 'track') {
      let sid = body.session_id ?? null
      if (!sid) {
        const { data } = await admin.from('funnel_sessions').insert({
          utm: body.utm ?? null, referrer: body.referrer ?? null,
          user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
        }).select('id').single()
        sid = (data as { id: string } | null)?.id ?? null
      }
      if (sid && body.question_key) {
        await admin.from('funnel_events').insert({
          session_id: sid, step: body.step ?? 0,
          question_key: body.question_key.slice(0, 80), answer: (body.answer ?? '').slice(0, 500) || null,
        })
      }
      return json({ ok: true, session_id: sid })
    }

    // ── slots ────────────────────────────────────────────────────────────────
    if (body.action === 'slots') {
      const slots = await computeSlots(admin)
      return json({ ok: true, slots, duration_min: SLOT_MIN })
    }

    // ── contact ──────────────────────────────────────────────────────────────
    // Kontaktdaten kommen VOR der Terminwahl (Sven: „Sinn des Fragebogens ist,
    // die Kontaktdaten zu bekommen"). Lead sofort sichern + erstkontakt-Automation
    // planen (Mail +20 Min & Termin-Bot +20 Min) — bucht der Kunde danach doch
    // einen Termin, storniert `book` die geplanten Nachrichten und der Bot-Start
    // wird zusätzlich durch seinen Termin-Guard übersprungen.
    if (body.action === 'contact') {
      const c = body.contact ?? {}
      if (c.website) return json({ ok: true, lead_id: null })   // Honeypot: still schlucken
      if (!c.first_name || !c.email || !c.phone) return json({ error: 'Pflichtfelder fehlen' }, 400)
      const phone = (c.phone ?? '').replace(/[^\d+]/g, '')
      const email = (c.email ?? '').trim().toLowerCase()

      let leadId: string | null = null
      const { data: byMail } = await admin.from('leads').select('id').ilike('email', email).limit(1)
      if (byMail?.length) leadId = (byMail[0] as { id: string }).id
      if (!leadId) {
        // Zweit-Adressen (alt_emails) mitprüfen — verhindert Dubletten bei Kunden mit mehreren Mails
        const { data: byAlt } = await admin.from('leads').select('id').contains('alt_emails', [email]).limit(1)
        if (byAlt?.length) leadId = (byAlt[0] as { id: string }).id
      }
      if (!leadId && phone) {
        const { data: byPhone } = await admin.from('leads').select('id').or(`phone.eq.${phone},whatsapp.eq.${phone}`).limit(1)
        if (byPhone?.length) leadId = (byPhone[0] as { id: string }).id
        if (!leadId) {
          const { data: byAltP } = await admin.from('leads').select('id').contains('alt_phones', [phone]).limit(1)
          if (byAltP?.length) leadId = (byAltP[0] as { id: string }).id
        }
      }
      const utmNote = body.utm && Object.keys(body.utm).length ? `\nKanal: ${JSON.stringify(body.utm)}` : ''
      const answersText = (body.answers ?? []).map(a => `• ${a.question}: ${a.answer}`).join('\n')
      const utm = body.utm ?? {}
      if (!leadId) {
        const { data: nl, error: nlErr } = await admin.from('leads').insert({
          first_name: c.first_name?.trim(), last_name: (c.last_name ?? '').trim(),
          email, phone, whatsapp: phone, source: 'website',
          utm_source: utm.utm_source ?? null, utm_medium: utm.utm_medium ?? null,
          utm_campaign: utm.utm_campaign ?? null, utm_content: utm.utm_content ?? null,
          utm_term: utm.utm_term ?? null,
          notes: `Fragebogen (eigener Funnel):\n${answersText}${utmNote}`,
        }).select('id').single()
        if (nlErr) console.error('[funnel-api] Lead-Insert fehlgeschlagen:', nlErr.message)
        leadId = (nl as { id: string } | null)?.id ?? null
      } else {
        const { data: old } = await admin.from('leads').select('notes, utm_source').eq('id', leadId).single()
        const prev = (old as { notes?: string } | null)?.notes ?? ''
        const patch: Record<string, unknown> = { notes: `${prev ? prev + '\n\n' : ''}Fragebogen (eigener Funnel, ${new Date().toLocaleDateString('de-DE')}):\n${answersText}${utmNote}` }
        if (!(old as { utm_source?: string } | null)?.utm_source && utm.utm_source) {
          patch.utm_source = utm.utm_source; patch.utm_medium = utm.utm_medium ?? null
          patch.utm_campaign = utm.utm_campaign ?? null; patch.utm_content = utm.utm_content ?? null
          patch.utm_term = utm.utm_term ?? null
        }
        await admin.from('leads').update(patch).eq('id', leadId)
      }
      if (!leadId) return json({ error: 'lead_failed' }, 500)
      try {
        await admin.from('activities').insert({
          lead_id: leadId, type: 'note', direction: 'inbound',
          subject: '📋 Fragebogen (Website-Funnel)', content: `${answersText}${utmNote}`,
          completed_at: new Date().toISOString(),
        })
      } catch { /* egal */ }
      if (body.session_id) await admin.from('funnel_sessions').update({ lead_id: leadId }).eq('id', body.session_id)
      // Pipeline: Deal in Phase „Erstkontakt" anlegen (nur wenn noch keiner existiert) —
      // gleiche Semantik wie typeform-webhook. Bestands-Deals behalten ihre Phase.
      let dealId: string | null = null
      const { data: exDeals } = await admin.from('deals').select('id').eq('lead_id', leadId).limit(1)
      if (exDeals?.length) dealId = (exDeals[0] as { id: string }).id
      else {
        const { data: nd } = await admin.from('deals').insert({ lead_id: leadId, phase: 'erstkontakt' }).select('id').single()
        dealId = (nd as { id: string } | null)?.id ?? null
      }
      // Fallback-Automation: greift nur, wenn KEIN Termin gebucht wird (book storniert)
      try { await admin.functions.invoke('schedule-message', { body: { lead_id: leadId, deal_id: dealId, event_type: 'erstkontakt' } }) }
      catch (e) { console.warn('[funnel-api] erstkontakt-Trigger fehlgeschlagen:', e) }
      return json({ ok: true, lead_id: leadId })
    }

    // ── book ─────────────────────────────────────────────────────────────────
    if (body.action === 'book') {
      if (!body.slot_start_iso || !body.lead_id) return json({ error: 'Pflichtfelder fehlen' }, 400)
      const start = new Date(body.slot_start_iso)
      if (isNaN(start.getTime()) || start.getTime() < Date.now() + (LEAD_HOURS - 0.25) * 3600e3) return json({ error: 'slot_invalid' })
      const end = new Date(start.getTime() + SLOT_MIN * 60000)
      // Konflikt-Check direkt vor der Buchung
      const busy = [...await getBusy(admin, start, end), ...await getCrmBusy(admin, new Date(start.getTime() - 3600e3), end)]
      if (busy.some(b => start.getTime() < b.end && end.getTime() > b.start)) return json({ error: 'slot_taken' })

      const type = body.meeting_type === 'whatsapp' ? 'whatsapp' : 'zoom'
      // Herkunft der Buchung (Pipeline-/Kalender-Kennzeichnung). Kanäle kommen aus
      // veröffentlichten Links (/termin?src=<kanal>). Frei im Funnel-Editor angelegte
      // Quellen werden akzeptiert, wenn sie das Slug-Format erfüllen (a–z, 0–9, -, _).
      const SOURCE_LABELS: Record<string, string> = { newsletter: 'Newsletter', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', google: 'Google' }
      const srcClean = typeof body.source === 'string' ? body.source.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) : ''
      const source = srcClean.length >= 2 ? srcClean : null
      // Kalender-Präfix: interner Marker 'direktlink' bleibt unbeschriftet, sonst
      // fester Label oder aus dem Slug kapitalisiert.
      const sourceLabel = source && source !== 'direktlink'
        ? (SOURCE_LABELS[source] ?? (source.charAt(0).toUpperCase() + source.slice(1)))
        : undefined
      const leadId = body.lead_id
      const { data: leadRow } = await admin.from('leads').select('first_name, last_name, email, phone, whatsapp').eq('id', leadId).maybeSingle()
      if (!leadRow) return json({ error: 'lead_not_found' }, 404)
      const c = { first_name: (leadRow as { first_name?: string }).first_name ?? '', last_name: (leadRow as { last_name?: string }).last_name ?? '' }
      const phone = ((leadRow as { whatsapp?: string; phone?: string }).whatsapp || (leadRow as { phone?: string }).phone || '').replace(/[^\d+]/g, '')
      const email = ((leadRow as { email?: string }).email ?? '').trim().toLowerCase()

      // Erstkontakt-Fallback stornieren — der Kunde HAT ja jetzt einen Termin
      try { await admin.from('scheduled_messages').update({ status: 'cancelled' }).eq('lead_id', leadId).eq('status', 'pending').in('event_type', ['erstkontakt', 'no_show', 'immobilienauswahl', 'newsletter', 'bot_nudge', 'deck_viewed_followup']) } catch { /* egal */ }

      // Bucht hier jemand Internes (Mitarbeitende, Verwaltung), darf daraus KEIN
      // Kundenvorgang werden: kein Deal in der Pipeline, keine Bestaetigungsautomatik,
      // keine Lead-Verknuepfung am Termin. Der Funnel ist der gefaehrlichere der beiden
      // Wege, weil er - anders als /buchen - tatsaechlich einen Deal anlegt.
      const isInternal = await isInternalContact(admin, { email, phone })

      // Pipeline: Deal auf „Termin gebucht" (bestehenden updaten, sonst anlegen) —
      // gleiche Semantik wie calendly-webhook.
      let dealId: string | null = null
      if (!isInternal) {
        const { data: exDeals } = await admin.from('deals').select('id').eq('lead_id', leadId).limit(1)
        if (exDeals?.length) {
          dealId = (exDeals[0] as { id: string }).id
          await admin.from('deals').update({ phase: 'termin_gebucht', archived_from_phase: null, ...(source ? { source } : {}) }).eq('id', dealId)
        } else {
          const { data: nd } = await admin.from('deals').insert({ lead_id: leadId, phase: 'termin_gebucht', ...(source ? { source } : {}) }).select('id').single()
          dealId = (nd as { id: string } | null)?.id ?? null
        }
      }

      // Zoom-Meeting (nur bei Zoom-Terminart)
      let zoomLink: string | null = null
      if (type === 'zoom') {
        try {
          const { data: z } = await admin.functions.invoke('create-zoom-meeting', { body: { title: `Beratungsgespräch – ${c.first_name}`, start_time: start.toISOString(), duration_minutes: SLOT_MIN } })
          zoomLink = (z as { join_url?: string } | null)?.join_url ?? null
        } catch (e) { console.warn('[funnel-api] Zoom fehlgeschlagen:', e) }
      }

      // Google-Kalender-Event
      let gcal: { id: string; calId: string } | null = null
      try {
        const calId = await getCalendarId(admin)
        const token = await getSaToken()
        const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: `${sourceLabel ? `[${sourceLabel}] ` : ''}Beratungsgespräch – ${c.first_name} ${c.last_name ?? ''}`.trim(),
            description: `${sourceLabel ? `Über ${sourceLabel.toUpperCase()} gebucht` : 'Über den Website-Funnel gebucht'} (${type === 'zoom' ? 'Zoom' : 'WhatsApp-Call'})${zoomLink ? `\nZoom: ${zoomLink}` : ''}\nTel: ${phone}\nMail: ${email}`,
            start: { dateTime: start.toISOString(), timeZone: TZ_CY }, end: { dateTime: end.toISOString(), timeZone: TZ_CY },
          }),
        })
        const d = await r.json() as { id?: string }
        if (d.id) gcal = { id: d.id, calId }
      } catch (e) { console.warn('[funnel-api] Kalender fehlgeschlagen:', e) }

      // CRM-Termin
      const { data: appt } = await admin.from('crm_appointments').insert({
        lead_id: isInternal ? null : leadId, deal_id: dealId, internal: isInternal,
        title: `Beratungsgespräch – ${c.first_name}`,
        description: 'Über den Website-Funnel gebucht', type,
        start_time: start.toISOString(), end_time: end.toISOString(),
        zoom_link: zoomLink, phone_number: type === 'whatsapp' ? phone : null,
        google_event_id: gcal?.id ?? null, google_calendar_id: gcal?.calId ?? null,
        source,
      }).select('id').single()

      // Bestätigung über die editierbaren „Termin gebucht"-Vorlagen (Mail + WhatsApp).
      // Bei internen Buchungen bewusst nicht: das sind Kundenvorlagen.
      if (!isInternal) {
        try { await admin.functions.invoke('schedule-message', { body: { lead_id: leadId, deal_id: dealId, event_type: 'termin_gebucht' } }) }
        catch (e) { console.warn('[funnel-api] termin_gebucht-Trigger fehlgeschlagen:', e) }
      }

      // Session abschließen
      if (body.session_id) {
        await admin.from('funnel_sessions').update({ lead_id: leadId, completed_at: new Date().toISOString() }).eq('id', body.session_id)
      }
      return json({ ok: true, appointment_id: (appt as { id: string } | null)?.id ?? null, zoom: !!zoomLink })
    }

    // ── Termin verwalten (öffentlich, Token-gebunden): ansehen / absagen / verschieben ──
    if (body.action === 'manage_get' || body.action === 'manage_cancel' || body.action === 'manage_reschedule') {
      if (!body.token) return json({ error: 'token fehlt' }, 400)
      const { data: ap } = await admin.from('crm_appointments')
        .select('id, lead_id, title, type, start_time, end_time, zoom_link, google_event_id, google_calendar_id, leads(first_name, last_name)')
        .eq('manage_token', body.token).maybeSingle()
      const a = ap as {
        id: string; lead_id: string; title: string | null; type: string | null
        start_time: string; end_time: string | null; zoom_link: string | null
        google_event_id: string | null; google_calendar_id: string | null
        leads: { first_name: string | null; last_name: string | null } | null
      } | null
      if (!a) return json({ error: 'not_found' }, 404)
      const isPast = new Date(a.start_time).getTime() < Date.now()

      if (body.action === 'manage_get') {
        return json({
          ok: true,
          first_name: a.leads?.first_name ?? '',
          start_iso: a.start_time,
          meeting_type: a.zoom_link ? 'zoom' : 'whatsapp',
          past: isPast,
        })
      }
      if (isPast) return json({ error: 'past' })

      const leadName = `${a.leads?.first_name ?? ''} ${a.leads?.last_name ?? ''}`.trim() || 'Kunde'
      const fmtDe = (iso: string) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' }) + ' Uhr (DE)'
      const notifySven = async (subject: string, text: string) => {
        try {
          await admin.functions.invoke('send-email', { body: {
            to: 'sven@happy-property.com', lead_id: a.lead_id, subject,
            html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#374151;white-space:pre-wrap">${text.replace(/</g, '&lt;')}</div>`,
          } })
        } catch (e) { console.warn('[funnel-api] Sven-Benachrichtigung fehlgeschlagen:', e) }
      }

      if (body.action === 'manage_cancel') {
        const reason = (body.reason ?? '').trim().slice(0, 500)
        if (a.google_event_id) {
          try {
            const token = await getSaToken()
            await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(a.google_calendar_id || await getCalendarId(admin))}/events/${encodeURIComponent(a.google_event_id)}`, {
              method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
            })
          } catch (e) { console.warn('[funnel-api] Google-Event löschen fehlgeschlagen:', e) }
        }
        // Erinnerungen + noch offene Termin-Nachrichten stoppen
        await admin.from('scheduled_messages').update({ status: 'cancelled' })
          .eq('lead_id', a.lead_id).eq('status', 'pending').eq('event_type', 'termin_gebucht')
        await admin.from('crm_appointments').delete().eq('id', a.id)
        // Pipeline: „Termin gebucht" stimmt nicht mehr → zurück auf Erstkontakt.
        // Spätere Phasen (Beratung, Registrierung, …) bleiben unangetastet.
        await admin.from('deals').update({ phase: 'erstkontakt' })
          .eq('lead_id', a.lead_id).eq('phase', 'termin_gebucht')
        try {
          await admin.from('activities').insert({
            lead_id: a.lead_id, type: 'note', direction: 'inbound',
            subject: '❌ Termin vom Kunden abgesagt',
            content: `Termin ${fmtDe(a.start_time)} wurde über den Verwalten-Link abgesagt.${reason ? `\nGrund: ${reason}` : ''}`,
            completed_at: new Date().toISOString(),
          })
        } catch { /* egal */ }
        await notifySven(`❌ Terminabsage: ${leadName}`,
          `${leadName} hat den Termin am ${fmtDe(a.start_time)} abgesagt.${reason ? `\n\nGrund: ${reason}` : ''}`)
        return json({ ok: true, cancelled: true })
      }

      // manage_reschedule
      if (!body.slot_start_iso) return json({ error: 'slot_start_iso fehlt' }, 400)
      const start = new Date(body.slot_start_iso)
      if (isNaN(start.getTime()) || start.getTime() < Date.now() + (LEAD_HOURS - 0.25) * 3600e3) return json({ error: 'slot_invalid' })
      const end = new Date(start.getTime() + SLOT_MIN * 60000)
      // Eigenen alten Termin nicht als Konflikt werten (CRM-Quelle filtern; Google-freeBusy
      // enthält ihn nur, wenn der neue Slot den alten überlappt — dann greift der Filter unten)
      const oldStartMs = new Date(a.start_time).getTime()
      const busy = [...await getBusy(admin, start, end), ...await getCrmBusy(admin, new Date(start.getTime() - 3600e3), end)]
        .filter(b => b.start !== oldStartMs)
      if (busy.some(b => start.getTime() < b.end && end.getTime() > b.start)) return json({ error: 'slot_taken' })

      const oldStart = a.start_time
      await admin.from('crm_appointments').update({ start_time: start.toISOString(), end_time: end.toISOString() }).eq('id', a.id)
      if (a.google_event_id) {
        try {
          const token = await getSaToken()
          await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(a.google_calendar_id || await getCalendarId(admin))}/events/${encodeURIComponent(a.google_event_id)}`, {
            method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ start: { dateTime: start.toISOString(), timeZone: TZ_CY }, end: { dateTime: end.toISOString(), timeZone: TZ_CY } }),
          })
        } catch (e) { console.warn('[funnel-api] Google-Event verschieben fehlgeschlagen:', e) }
      }
      // Alte Erinnerungen/offene Nachrichten verwerfen, neue Bestätigung (inkl. ICS) + Erinnerungen planen
      await admin.from('scheduled_messages').update({ status: 'cancelled' })
        .eq('lead_id', a.lead_id).eq('status', 'pending').eq('event_type', 'termin_gebucht')
      try { await admin.functions.invoke('schedule-message', { body: { lead_id: a.lead_id, event_type: 'termin_gebucht' } }) }
      catch (e) { console.warn('[funnel-api] termin_gebucht-Trigger fehlgeschlagen:', e) }
      try {
        await admin.from('activities').insert({
          lead_id: a.lead_id, type: 'note', direction: 'inbound',
          subject: '🔄 Termin vom Kunden verschoben',
          content: `Von ${fmtDe(oldStart)} auf ${fmtDe(start.toISOString())} (über den Verwalten-Link).`,
          completed_at: new Date().toISOString(),
        })
      } catch { /* egal */ }
      await notifySven(`🔄 Termin verschoben: ${leadName}`,
        `${leadName} hat den Termin verschoben:\nAlt: ${fmtDe(oldStart)}\nNeu: ${fmtDe(start.toISOString())}${a.zoom_link ? '\n\nZoom-Link bleibt unverändert.' : ''}`)
      return json({ ok: true, rescheduled: true, start_iso: start.toISOString() })
    }

    return json({ error: `Unbekannte action` }, 400)
  } catch (err) {
    console.error('[funnel-api] Fehler:', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
