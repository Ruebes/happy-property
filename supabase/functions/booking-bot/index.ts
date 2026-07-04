// Supabase Edge Function: booking-bot
// WhatsApp-Terminbot: schlägt 2 freie Slots (deutsche Zeit) vor, versteht die
// Kundenantwort per KI, gleicht Svens Kalender ab und bucht den Termin.
//
// Actions (POST, JSON):
//   { action:'start', lead_id, deal_id?, source }   → Gespräch eröffnen (2 Slots)
//   { action:'reply', lead_id, text }               → eingehende WhatsApp verarbeiten
//
// SICHERHEIT: läuft nur, wenn crm_settings 'booking_bot_enabled'='true'.
// Verfügbarkeit: Mo–Fr 11–19, Sa+So 17–20 (Europe/Berlin), frühestens ab morgen.
// Guardrails: 1 Gespräch/Lead, Opt-Out stoppt, nach 2 unklaren Antworten Übergabe
// an Sven, Ablauf nach 3 Tagen. Terminart fragt der Bot (WhatsApp-Call oder Zoom).
//
// Deployment: supabase functions deploy booking-bot --no-verify-jwt
// Secrets: GOOGLE_SERVICE_ACCOUNT_JSON, ANTHROPIC_API_KEY, TIMELINES_API_KEY,
//          TIMELINES_WA_SENDER (+ Standard SUPABASE_*)

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const CALENDAR_ID = 'primary-fallback'  // wird aus crm_settings überschrieben
const SLOT_MIN = 30
const TZ = 'Europe/Berlin'

// ── Zeitzonen-Helfer (Berlin ↔ UTC, DST-sicher via Intl) ─────────────────────
function berlinOffsetMin(date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second)
  return (asUtc - date.getTime()) / 60000
}
function berlinToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi))
  return new Date(guess.getTime() - berlinOffsetMin(guess) * 60000)
}
// Berlin-Datumsteile eines UTC-Instants
function berlinParts(date: Date): { y: number; mo: number; d: number; wd: number; h: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { y: +m.year, mo: +m.month, d: +m.day, wd: wdMap[m.weekday] ?? 1, h: +m.hour === 24 ? 0 : +m.hour }
}
function labelDe(startUtc: Date): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(startUtc)
}
// Wochentag eines Slots (klein), um bei „geht auch nachmittags?" den Tag zu behalten.
function weekdayNameDe(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'long' }).format(new Date(iso)).toLowerCase()
}

// Verfügbarkeitsfenster je Wochentag (Berlin-Stunden). Wochenende = 17–20.
function windowFor(wd: number): [number, number] | null {
  if (wd >= 1 && wd <= 5) return [11, 19]   // Mo–Fr 11–19
  return [17, 20]                            // Sa+So 17–20
}

interface Slot { startIso: string; endIso: string; label: string }
interface Busy { start: number; end: number }

// ── Belegte Zeiten: Google-Free/Busy (falls freigegeben) + CRM-Termine ───────
async function getBusy(admin: SupabaseClient, fromUtc: Date, toUtc: Date): Promise<Busy[]> {
  const busy: Busy[] = []
  // CRM-Termine (immer verfügbar, auch vor Google-Freigabe)
  try {
    const { data } = await admin.from('crm_appointments')
      .select('start_time, end_time')
      .gte('start_time', fromUtc.toISOString()).lte('start_time', toUtc.toISOString())
    for (const a of (data ?? []) as { start_time: string; end_time: string }[]) {
      busy.push({ start: new Date(a.start_time).getTime(), end: new Date(a.end_time).getTime() })
    }
  } catch { /* ignore */ }
  // Google Free/Busy (nur wenn Kalender freigegeben)
  try {
    const calId = await getCalendarId(admin)
    const token = await getSaToken()
    const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: fromUtc.toISOString(), timeMax: toUtc.toISOString(), items: [{ id: calId }] }),
    })
    const jr = await r.json() as { calendars?: Record<string, { busy?: { start: string; end: string }[] }> }
    const cal = jr.calendars?.[calId]
    for (const b of cal?.busy ?? []) busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() })
  } catch (e) { console.warn('[booking-bot] freeBusy nicht verfügbar (Kalender evtl. nicht freigegeben):', e) }
  return busy
}

// Einen genannten Tag-Wunsch auf einen Wochentag abbilden (sonst kein Filter).
const WD_NAMES: Record<string, number> = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6 }
function matchesDayHint(wd: number, offset: number, hint?: string): boolean {
  if (!hint) return true
  const h = hint.toLowerCase()
  if (h.includes('übermorgen')) return offset === 2
  if (h.includes('morgen')) return offset === 1
  if (h.includes('wochenende')) return wd === 0 || wd === 6
  if (/(nächste|kommende)\s*woche/.test(h)) return offset >= 3
  for (const [name, num] of Object.entries(WD_NAMES)) if (h.includes(name)) return wd === num
  return true  // unklarer Hinweis → nicht streng filtern
}
// Ein GENAU EIN Tag gemeint (Wochentag/morgen/übermorgen)? Dann 2 Uhrzeiten an
// DIESEM Tag anbieten statt an verschiedenen Tagen.
function isSpecificDay(hint?: string): boolean {
  if (!hint) return false
  const h = hint.toLowerCase()
  if (/wochenende|woche/.test(h)) return false
  if (h.includes('morgen')) return true              // morgen / übermorgen
  return Object.keys(WD_NAMES).some(n => h.includes(n))
}

// Kandidaten-Slots ab morgen berechnen, gegen Busy prüfen, bis `want` gefunden.
// Ein Vorschlag pro Tag → verschiedene Tage (Abwechslung wie „Sa oder Mo").
// timeHint (HH:MM) = KONKRETE Wunschuhrzeit: nur exakt diese prüfen (je Tag).
async function computeSlots(admin: SupabaseClient, want: number, filter?: { dayHint?: string; daypart?: string; timeHint?: string }): Promise<Slot[]> {
  const now = new Date()
  const from = new Date(now.getTime() + 12 * 3600e3)          // frühestens ~ab morgen
  const to   = new Date(now.getTime() + 16 * 24 * 3600e3)     // 16 Tage Fenster
  const busy = await getBusy(admin, from, to)
  const isFree = (s: Date) => {
    const st = s.getTime(), en = st + SLOT_MIN * 60000
    return !busy.some(b => st < b.end && en > b.start)
  }
  const mk = (start: Date): Slot => ({ startIso: start.toISOString(), endIso: new Date(start.getTime() + SLOT_MIN * 60000).toISOString(), label: labelDe(start) })
  // konkrete Wunschuhrzeit parsen
  let thH = NaN, thM = 0
  if (filter?.timeHint && /^\d{1,2}:\d{2}$/.test(filter.timeHint)) { const [a, b] = filter.timeHint.split(':').map(Number); thH = a; thM = b }

  const out: Slot[] = []
  for (let off = 1; off <= 16 && out.length < want; off++) {
    const anchor = new Date(now.getTime() + off * 24 * 3600e3)
    const bp = berlinParts(anchor)
    const win = windowFor(bp.wd)
    if (!win) continue
    if (!matchesDayHint(bp.wd, off, filter?.dayHint)) continue
    const [w0, w1] = win

    // (a) Exakte Wunschuhrzeit: nur diese prüfen (muss im Fenster liegen + frei sein)
    if (!isNaN(thH)) {
      if (thH * 60 + thM < w0 * 60 || thH * 60 + thM + SLOT_MIN > w1 * 60) continue
      const start = berlinToUtc(bp.y, bp.mo, bp.d, thH, thM)
      if (start.getTime() < from.getTime()) continue
      if (!isFree(start)) continue
      out.push(mk(start))
      continue
    }

    // Fenster ggf. auf Tageszeit einschränken
    let [h0, h1] = win
    if (filter?.daypart === 'vormittags') h1 = Math.min(h1, 13)
    if (filter?.daypart === 'nachmittags') h0 = Math.max(h0, 13)
    if (filter?.daypart === 'abends') h0 = Math.max(h0, 17)

    // Alle freien Zeiten dieses Tages (30-Min-Raster)
    const dayTimes: Slot[] = []
    for (let h = h0; h + SLOT_MIN / 60 <= h1; h++) {
      for (const mi of [0, 30]) {
        if (h * 60 + mi + SLOT_MIN > h1 * 60) continue
        const start = berlinToUtc(bp.y, bp.mo, bp.d, h, mi)
        if (start.getTime() < from.getTime()) continue
        if (isFree(start)) dayTimes.push(mk(start))
      }
    }
    if (!dayTimes.length) continue

    if (isSpecificDay(filter?.dayHint)) {
      // (b1) Genau EIN gewünschter Tag → 2 gespreizte Uhrzeiten an DIESEM Tag
      out.push(dayTimes[0])
      if (dayTimes.length > 1 && out.length < want) {
        const j = dayTimes.length >= 4 ? Math.floor(dayTimes.length * 0.6) : dayTimes.length - 1
        out.push(dayTimes[j])
      }
      break  // nur dieser eine Tag
    }
    // (b2) sonst ein Vorschlag pro Tag → verschiedene Tage (Abwechslung)
    out.push(dayTimes[0])
  }
  return out
}

// ── Service-Account-Token (Kalender) — Muster aus google-drive ───────────────
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
  return raw ? raw.split(',')[0].trim() : CALENDAR_ID
}
async function createCalendarEvent(admin: SupabaseClient, ev: { title: string; startIso: string; endIso: string; description: string }): Promise<{ id: string; calId: string } | null> {
  try {
    const calId = await getCalendarId(admin)
    const token = await getSaToken()
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: ev.title, description: ev.description, start: { dateTime: ev.startIso, timeZone: TZ }, end: { dateTime: ev.endIso, timeZone: TZ } }),
    })
    const d = await r.json() as { id?: string }
    return d.id ? { id: d.id, calId } : null
  } catch (e) { console.warn('[booking-bot] Kalender-Event fehlgeschlagen:', e); return null }
}

// ── WhatsApp senden (Timelines) ──────────────────────────────────────────────
async function sendWa(phone: string, text: string): Promise<void> {
  const apiKey = Deno.env.get('TIMELINES_API_KEY') ?? '', sender = Deno.env.get('TIMELINES_WA_SENDER') ?? ''
  if (!apiKey || !sender) { console.warn('[booking-bot] Timelines nicht konfiguriert – simuliert:', text.slice(0, 60)); return }
  const r = await fetch('https://app.timelines.ai/integrations/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ phone, whatsapp_account_phone: sender, text }),
  })
  if (!r.ok) throw new Error(`Timelines ${r.status}: ${await r.text()}`)
}
async function logWa(admin: SupabaseClient, leadId: string, text: string, dir: 'inbound' | 'outbound'): Promise<void> {
  try { await admin.from('activities').insert({ lead_id: leadId, type: 'whatsapp', direction: dir, subject: dir === 'outbound' ? 'WhatsApp: Termin-Bot' : 'WhatsApp erhalten', content: text.slice(0, 2000), completed_at: new Date().toISOString() }) } catch { /* egal */ }
}

// ── KI: Kundenantwort verstehen ──────────────────────────────────────────────
interface Intent { intent: string; pick_index: number | null; day_hint: string | null; daypart: string | null; time_hint: string | null; meeting_type: string | null }
async function classify(state: string, slots: Slot[], text: string): Promise<Intent> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  const fallback: Intent = { intent: 'unclear', pick_index: null, day_hint: null, daypart: null, time_hint: null, meeting_type: null }
  if (!key) return fallback
  const sys = `Du interpretierst die WhatsApp-Antwort eines Kunden im Terminbuchungs-Dialog (deutsch). Zustand: ${state}. Vorgeschlagene Slots: ${slots.map((s, i) => `[${i}] ${s.label}`).join(' | ') || 'keine'}.
Gib NUR das Tool emit_intent zurück. intent-Werte:
- pick_slot: Kunde wählt einen vorgeschlagenen Slot (pick_index 0 oder 1).
- reject_slots: keiner der Slots passt (evtl. mit day_hint/daypart/time_hint-Wunsch).
- give_preference: Kunde nennt Tag-/Zeit-Wunsch (day_hint z.B. "Dienstag","morgen","nächste Woche"; daypart "vormittags"|"nachmittags"|"abends"; time_hint = KONKRETE Uhrzeit als 24h "HH:MM", z.B. "15:00" aus "15 Uhr"/"um 3"/"halb 4"→"15:30").
- choose_type: Kunde wählt Terminart (meeting_type "zoom" oder "whatsapp" — WhatsApp-Anruf/Telefon = whatsapp).
- confirm_yes / confirm_no: Zustimmung/Ablehnung zu einem konkreten Vorschlag.
- optout: will nicht kontaktiert werden / kein Interesse.
- unclear: unverständlich/themenfremd.
WICHTIG: Nennt der Kunde eine konkrete Uhrzeit (z.B. "vielleicht 15:00?", "geht 16 Uhr?"), IMMER time_hint als "HH:MM" füllen (intent give_preference). Fülle nur passende Felder, sonst null.`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 300, system: sys,
        messages: [{ role: 'user', content: text }],
        tool_choice: { type: 'tool', name: 'emit_intent' },
        tools: [{ name: 'emit_intent', description: 'Intent der Kundenantwort', input_schema: {
          type: 'object', properties: {
            intent: { type: 'string', enum: ['pick_slot', 'reject_slots', 'give_preference', 'choose_type', 'confirm_yes', 'confirm_no', 'optout', 'unclear'] },
            pick_index: { type: ['integer', 'null'] }, day_hint: { type: ['string', 'null'] },
            daypart: { type: ['string', 'null'], enum: ['vormittags', 'nachmittags', 'abends', null] },
            time_hint: { type: ['string', 'null'], description: 'konkrete Uhrzeit 24h HH:MM' },
            meeting_type: { type: ['string', 'null'], enum: ['zoom', 'whatsapp', null] },
          }, required: ['intent'],
        } }],
      }),
    })
    const d = await res.json() as { content?: { type: string; name?: string; input?: Intent }[] }
    const tool = d.content?.find(c => c.type === 'tool_use')
    return tool?.input ? { ...fallback, ...tool.input } : fallback
  } catch (e) { console.warn('[booking-bot] classify Fehler:', e); return fallback }
}

// ── Konversations-Helfer ──────────────────────────────────────────────────────
const first = (n: string | null) => (n ?? '').trim()
const greet = (n: string | null) => first(n) ? `Hey ${first(n)}` : 'Hallo'

async function setConv(admin: SupabaseClient, id: string, patch: Record<string, unknown>) {
  await admin.from('booking_conversations').update(patch).eq('id', id)
}

// Terminart erfragen (nach fixiertem Slot)
async function askType(admin: SupabaseClient, convId: string, phone: string, leadId: string, name: string | null, slot: Slot) {
  const msg = `Super, ${first(name) || 'gerne'}! Ich trage dir ${slot.label} Uhr ein. 🙂\n\nLieber ein kurzes Telefonat über WhatsApp oder einen Zoom-Call?`
  await setConv(admin, convId, { state: 'awaiting_type', chosen_slot: slot, attempts: 0, last_message: msg })
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
}

// Buchung durchführen
async function book(admin: SupabaseClient, conv: { id: string; lead_id: string; deal_id: string | null }, lead: { first_name: string | null; whatsapp: string | null; phone: string | null }, slot: Slot, type: 'zoom' | 'whatsapp') {
  const phone = lead.whatsapp || lead.phone || ''
  const name = first(lead.first_name)
  let zoomLink = ''
  if (type === 'zoom') {
    try {
      const { data } = await admin.functions.invoke('create-zoom-meeting', { body: { title: `Beratungsgespräch – ${name || 'Happy Property'}`, start_time: slot.startIso, duration_minutes: SLOT_MIN } })
      zoomLink = (data as { join_url?: string } | null)?.join_url ?? ''
    } catch (e) { console.warn('[booking-bot] Zoom-Erstellung fehlgeschlagen:', e) }
  }
  const desc = `Automatisch gebucht via WhatsApp-Terminbot.\nKunde: ${name}\nArt: ${type === 'zoom' ? 'Zoom' : 'WhatsApp-Anruf'}${zoomLink ? `\nZoom: ${zoomLink}` : ''}`
  const cal = await createCalendarEvent(admin, { title: `Beratung – ${name || 'Lead'} (${type === 'zoom' ? 'Zoom' : 'WhatsApp'})`, startIso: slot.startIso, endIso: slot.endIso, description: desc })
  // CRM-Termin (der AFTER-INSERT-Trigger schließt das Gespräch + stoppt Nudges)
  await admin.from('crm_appointments').insert({
    title: `Beratungsgespräch – ${name || 'Lead'}`, type, start_time: slot.startIso, end_time: slot.endIso,
    lead_id: conv.lead_id, deal_id: conv.deal_id, zoom_link: zoomLink || null,
    phone_number: type === 'whatsapp' ? phone : null,
    google_event_id: cal?.id ?? null, google_calendar_id: cal?.calId ?? null,
    description: 'Vom WhatsApp-Terminbot gebucht',
  })
  const confirm = type === 'zoom'
    ? `Perfekt, ${name || 'ich freu mich'}! ✅ Unser Zoom-Termin steht: ${slot.label} Uhr (deutsche Zeit).${zoomLink ? `\n\nZoom-Link: ${zoomLink}` : '\n\nDen Zoom-Link schicke ich dir rechtzeitig vorher.'}\n\nBis dann! Liebe Grüße, Sven`
    : `Perfekt, ${name || 'ich freu mich'}! ✅ Termin steht: ${slot.label} Uhr (deutsche Zeit). Ich rufe dich dann über WhatsApp an.\n\nBis dann! Liebe Grüße, Sven`
  await setConv(admin, conv.id, { state: 'booked', meeting_type: type, last_message: confirm })
  await sendWa(phone, confirm); await logWa(admin, conv.lead_id, confirm, 'outbound')
}

// Übergabe an Sven (Notbremse)
async function handoff(admin: SupabaseClient, convId: string, phone: string, leadId: string, name: string | null) {
  const msg = `Kein Problem, ${first(name) || 'ich'} melde das direkt an Sven weiter — er kommt gleich persönlich auf dich zu und findet mit dir einen passenden Termin. 🙂`
  await setConv(admin, convId, { state: 'handoff', last_message: msg })
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
  try { await admin.from('activities').insert({ lead_id: leadId, type: 'note', direction: 'inbound', subject: '⚠️ Termin-Bot: Übergabe', content: 'Der Terminbot kam nicht weiter — bitte persönlich einen Termin mit dem Kunden finden.', completed_at: new Date().toISOString() }) } catch { /* egal */ }
}

// ── START ─────────────────────────────────────────────────────────────────────
async function handleStart(admin: SupabaseClient, leadId: string, dealId: string | null, source: string): Promise<Response> {
  // Gate: Bot aktiv?
  const { data: st } = await admin.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
  if ((st as { value?: string } | null)?.value !== 'true') return json({ ok: true, skipped: 'disabled' })
  // Opt-Out?
  const { data: opt } = await admin.from('communication_optouts').select('id').eq('lead_id', leadId).limit(1)
  if (opt && opt.length) return json({ ok: true, skipped: 'optout' })
  // Schon ein aktives Gespräch?
  const { data: active } = await admin.from('booking_conversations').select('id')
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').gt('expires_at', new Date().toISOString()).limit(1)
  if (active && active.length) return json({ ok: true, skipped: 'active_conversation' })
  // Schon ein anstehender Termin?
  const { data: appt } = await admin.from('crm_appointments').select('id').eq('lead_id', leadId).gte('start_time', new Date().toISOString()).limit(1)
  if (appt && appt.length) return json({ ok: true, skipped: 'has_appointment' })
  // Lead + Nummer
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })

  const slots = await computeSlots(admin, 2)
  if (slots.length < 2) return json({ ok: true, skipped: 'no_slots' })

  const msg = `${greet(l.first_name)}, hier ist Sven von Happy Property 🙂 Wollen wir kurz sprechen und die offenen Fragen klären? Ich hätte zwei Termine frei:\n\n1) ${slots[0].label} Uhr\n2) ${slots[1].label} Uhr\n\n(deutsche Zeit) Was passt dir besser?`
  const { data: conv } = await admin.from('booking_conversations')
    .insert({ lead_id: leadId, deal_id: dealId, source, state: 'awaiting_choice', proposed_slots: slots, last_message: msg })
    .select('id').single()
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
  return json({ ok: true, started: (conv as { id: string }).id })
}

// ── REPLY ─────────────────────────────────────────────────────────────────────
async function handleReply(admin: SupabaseClient, leadId: string, text: string): Promise<Response> {
  const { data: conv } = await admin.from('booking_conversations').select('*')
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const c = conv as null | { id: string; lead_id: string; deal_id: string | null; state: string; proposed_slots: Slot[] | null; chosen_slot: Slot | null; attempts: number }
  if (!c) return json({ ok: true, skipped: 'no_active_conversation' })

  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null }
  const phone = l.whatsapp || l.phone || ''
  await logWa(admin, leadId, text, 'inbound')

  const slots = c.proposed_slots ?? []
  const it = await classify(c.state, c.state === 'awaiting_daypref' ? [] : slots, text)

  // Tag-Kontext behalten: nennt der Kunde nur Tageszeit ODER eine konkrete Uhrzeit
  // (aber keinen Tag), während schon ein konkreter Slot auf dem Tisch lag → dessen
  // Wochentag übernehmen, statt versehentlich einen anderen Tag vorzuschlagen.
  const refSlot = c.chosen_slot ?? (c.proposed_slots && c.proposed_slots.length === 1 ? c.proposed_slots[0] : null)
  if (!it.day_hint && (it.daypart || it.time_hint) && refSlot?.startIso) {
    it.day_hint = weekdayNameDe(refSlot.startIso)
  }

  // Opt-Out zuerst
  if (it.intent === 'optout') {
    try { await admin.from('communication_optouts').insert({ lead_id: leadId }) } catch { /* Trigger schließt Gespräch */ }
    const m = 'Alles klar, ich lasse dich in Ruhe. Melde dich jederzeit, wenn es doch passt. 🙂'
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound')
    return json({ ok: true, handled: 'optout' })
  }

  const bump = async () => {
    const n = (c.attempts ?? 0) + 1
    if (n >= 2) { await handoff(admin, c.id, phone, leadId, l.first_name); return true }
    await setConv(admin, c.id, { attempts: n }); return false
  }

  // ── Zustandsmaschine ──
  if (c.state === 'awaiting_choice') {
    if (it.intent === 'pick_slot' && it.pick_index != null && slots[it.pick_index]) {
      await askType(admin, c.id, phone, leadId, l.first_name, slots[it.pick_index]); return json({ ok: true })
    }
    if (it.intent === 'give_preference' || it.intent === 'reject_slots') {
      // Direkt mit Präferenz Slots rechnen, sonst nach Tag/Tageszeit fragen
      if (it.day_hint || it.daypart || it.time_hint) return await proposeSlots(admin, c.id, phone, leadId, l.first_name, it)
      const m = `Kein Problem! An welchem Tag passt es dir besser — und eher vormittags oder nachmittags?`
      await setConv(admin, c.id, { state: 'awaiting_daypref', attempts: 0, last_message: m })
      await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
    }
    if (await bump()) return json({ ok: true, handled: 'handoff' })
    const m = `Sag mir einfach 1 oder 2 — oder wann es dir sonst besser passt. 🙂\n\n1) ${slots[0]?.label} Uhr\n2) ${slots[1]?.label} Uhr`
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
  }

  if (c.state === 'awaiting_type') {
    if (it.intent === 'choose_type' && (it.meeting_type === 'zoom' || it.meeting_type === 'whatsapp') && c.chosen_slot) {
      await book(admin, c, l, c.chosen_slot, it.meeting_type); return json({ ok: true, handled: 'booked' })
    }
    if (await bump()) return json({ ok: true, handled: 'handoff' })
    const m = `Kurze Rückfrage: lieber telefonieren wir über WhatsApp, oder machen wir einen Zoom-Call?`
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
  }

  if (c.state === 'awaiting_daypref') {
    if (it.day_hint || it.daypart || it.time_hint || it.intent === 'give_preference') {
      return await proposeSlots(admin, c.id, phone, leadId, l.first_name, it)
    }
    if (await bump()) return json({ ok: true, handled: 'handoff' })
    const m = `An welchem Wochentag passt es dir am besten — und eher vormittags oder nachmittags?`
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
  }

  if (c.state === 'awaiting_confirm') {
    if (it.intent === 'confirm_yes' && c.chosen_slot) {
      await askType(admin, c.id, phone, leadId, l.first_name, c.chosen_slot); return json({ ok: true })
    }
    if (it.intent === 'confirm_no' || it.intent === 'give_preference' || it.intent === 'reject_slots') {
      if (it.day_hint || it.daypart || it.time_hint) return await proposeSlots(admin, c.id, phone, leadId, l.first_name, it)
      const m = `Kein Problem — welcher Tag und eher vormittags oder nachmittags?`
      await setConv(admin, c.id, { state: 'awaiting_daypref', attempts: 0, last_message: m })
      await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
    }
    if (await bump()) return json({ ok: true, handled: 'handoff' })
    const m = `Passt dir ${c.chosen_slot?.label} Uhr? Ein kurzes „ja" genügt. 🙂`
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
  }

  return json({ ok: true, skipped: 'unknown_state' })
}

// Kleine Sende-Helfer (halten die Zustandsübergänge kurz)
async function sendChoice(admin: SupabaseClient, convId: string, phone: string, leadId: string, s: Slot[], intro: string): Promise<Response> {
  const m = `${intro}\n\n1) ${s[0].label} Uhr\n2) ${s[1].label} Uhr\n\n(deutsche Zeit) Was passt dir?`
  await setConv(admin, convId, { state: 'awaiting_choice', proposed_slots: s, chosen_slot: null, attempts: 0, last_message: m })
  await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
}
async function sendConfirm(admin: SupabaseClient, convId: string, phone: string, leadId: string, s: Slot, lead: string): Promise<Response> {
  const m = `${lead}${s.label} Uhr (deutsche Zeit)? Wenn's passt, trage ich das direkt ein — ein kurzes „ja" genügt. 🙂`
  await setConv(admin, convId, { state: 'awaiting_confirm', chosen_slot: s, attempts: 0, last_message: m })
  await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound'); return json({ ok: true })
}

// Aus Tag-/Zeit-Wunsch Termine vorschlagen. Regeln (Sven): (1) IMMER 2 Termine
// anbieten, wenn der Bot auswählt; (2) nennt der Kunde eine konkrete freie Uhrzeit,
// diese direkt annehmen (nicht gegenanbieten).
async function proposeSlots(admin: SupabaseClient, convId: string, phone: string, leadId: string, name: string | null, it: Intent): Promise<Response> {
  const dayHint = it.day_hint ?? undefined, daypart = it.daypart ?? undefined

  // (1) Konkrete Wunschuhrzeit → frei? Dann DIREKT annehmen (gleich Terminart fragen)
  if (it.time_hint) {
    const exact = await computeSlots(admin, 1, { dayHint, timeHint: it.time_hint })
    if (exact.length) return await askType(admin, convId, phone, leadId, name, exact[0])
    // gewünschte Uhrzeit belegt/außerhalb → 2 Alternativen am selben Tag anbieten
    const alt = await computeSlots(admin, 2, { dayHint, daypart })
    if (alt.length >= 2) return await sendChoice(admin, convId, phone, leadId, alt, `Um ${it.time_hint} Uhr habe ich da leider nichts frei. Wie wäre stattdessen:`)
    if (alt.length === 1) return await sendConfirm(admin, convId, phone, leadId, alt[0], `Um ${it.time_hint} Uhr ist leider belegt — wie wäre `)
  }

  // (2) Tag/Tageszeit → immer 2 Vorschläge
  const slots = await computeSlots(admin, 2, { dayHint, daypart })
  if (slots.length >= 2) return await sendChoice(admin, convId, phone, leadId, slots, 'Klar! Wie wäre:')
  if (slots.length === 1) return await sendConfirm(admin, convId, phone, leadId, slots[0], 'Ich hätte da nur einen Slot frei — wie wäre ')

  // (3) am Wunschtag nichts frei → 2 allgemeine Alternativen
  const any = await computeSlots(admin, 2)
  if (any.length >= 2) return await sendChoice(admin, convId, phone, leadId, any, 'Da hab ich leider nichts frei. Wie wäre stattdessen:')
  return json({ ok: true, skipped: 'no_slots' })
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json() as { action?: string; lead_id?: string; deal_id?: string | null; source?: string; text?: string }
    if (!body.lead_id) return json({ error: 'lead_id fehlt' }, 400)
    if (body.action === 'start') return await handleStart(admin, body.lead_id, body.deal_id ?? null, body.source ?? 'unknown')
    if (body.action === 'reply') return await handleReply(admin, body.lead_id, body.text ?? '')
    return json({ error: `Unbekannte action: ${body.action}` }, 400)
  } catch (err) {
    console.error('[booking-bot] Fehler:', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
