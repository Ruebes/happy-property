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
import { nextApptTitle } from '../_shared/apptTitle.ts'
import { notifyIfToday, cyTime } from '../_shared/notifyToday.ts'

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
// Berlin-Kalenderdatum eines Slots als 'YYYY-MM-DD' (pinnt den Kontext-Tag exakt).
function berlinDateStr(iso: string): string {
  const p = berlinParts(new Date(iso))
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
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
      // Echte Ueberlappung statt Fenster-auf-Startzeit: .gte('start_time', from) uebersieht
  // jeden Termin, der VOR dem Fenster beginnt und hineinragt. Ein 3-Stunden-Termin ab
  // 10:00 war so um 11:00 unsichtbar - ein Kunde konnte mitten hineinbuchen. Genauso
  // waere eine Tagessperre Minuten nach dem Setzen wieder wirkungslos geworden.
      .lt('start_time', toUtc.toISOString()).gt('end_time', fromUtc.toISOString())
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
async function computeSlots(admin: SupabaseClient, want: number, filter?: { dayHint?: string; daypart?: string; timeHint?: string; onDate?: string; afterDate?: string }): Promise<Slot[]> {
  const now = new Date()
  const from = new Date(now.getTime() + 12 * 3600e3)          // frühestens ~ab morgen
  // Bei konkretem Datumswunsch (onDate/afterDate = "nach dem X.") weiter in die Zukunft suchen.
  const maxOff = (filter?.onDate || filter?.afterDate) ? 45 : 16
  const to   = new Date(now.getTime() + (maxOff + 2) * 24 * 3600e3)
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
  for (let off = 1; off <= maxOff && out.length < want; off++) {
    const anchor = new Date(now.getTime() + off * 24 * 3600e3)
    const bp = berlinParts(anchor)
    const win = windowFor(bp.wd)
    if (!win) continue
    // onDate pinnt exakt EIN Datum (hat Vorrang vor dem Wochentag-Hinweis)
    const dateStr = `${bp.y}-${String(bp.mo).padStart(2, '0')}-${String(bp.d).padStart(2, '0')}`
    if (filter?.onDate) { if (dateStr !== filter.onDate) continue }
    else {
      // afterDate = frühestes akzeptables Datum ("nach dem X.") → alles davor überspringen
      if (filter?.afterDate && dateStr < filter.afterDate) continue
      if (!matchesDayHint(bp.wd, off, filter?.dayHint)) continue
    }
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

    if (isSpecificDay(filter?.dayHint) || filter?.onDate) {
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
// Verabschiedung an jede AUSGEHENDE Bot-WhatsApp anhängen (Sven-Wunsch), aber nur,
// wenn nicht schon eine Grußformel drinsteht (kein Doppel-„LG").
// ── Lotte ────────────────────────────────────────────────────────────────────
// Der Bot tritt als „Lotte, Svens persoenliche Assistentin" auf (Svens Hund).
// Jede Nachricht traegt ein zufaelliges Buero-Bild von ihr. Das macht sichtbar,
// dass hier eine Assistentin schreibt und kein Mensch — und nimmt einem Fehlgriff
// des Bots die Schaerfe.
const LOTTE_BILDER = [
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte1.jpg',
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte2.jpg',
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte3.jpg',
]
const lotteBild = () => LOTTE_BILDER[Math.floor(Math.random() * LOTTE_BILDER.length)]

function withSignoff(text: string): string {
  // Vorhandene Gruesse nicht doppeln — einige Texte signieren selbst.
  return /(liebe grüße|viele grüße|beste grüße|\blg\b|bis dann)/i.test(text) ? text : `${text}\n\nLiebe Grüße\nLotte 🐾`
}

// Ein Client fuer den Versand. Bewusst modulweit und faul angelegt: sendWa hat
// 22 Aufrufstellen, die sonst alle den admin-Client durchreichen muessten.
let sbSend: SupabaseClient | null = null
const sendClient = () => (sbSend ??= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!))

/** Nachricht auf ihren Kern reduzieren, um Wiederholungen zu erkennen. */
function normText(t: string): string {
  return t.toLowerCase()
    .replace(/liebe gr[üu][ßs]e[\s\S]*$/i, '')            // Signatur weg
    .replace(/[^a-zäöüß0-9]+/g, ' ')                      // Emojis/Satzzeichen weg
    .trim()
}

async function sendWa(phone: string, text: string): Promise<void> {
  const full = withSignoff(text)
  // Ueber send-whatsapp statt direkt an Timelines: nur dort sitzen Bild-Upload,
  // Verkleinerung, JPEG-Wandlung und der 2-MB-Guard.
  const { data, error } = await sendClient().functions.invoke('send-whatsapp', {
    body: {
      event_type: 'booking_bot', override_text: full,
      lead_data: { lead_name: 'Kunde', lead_phone: phone },
      // persona_image statt file_url: ein Deck-Titelbild oder eine YouTube-Vorschau
      // im Text hat Vorrang. Sonst schickt der Bot ein Hundefoto, wo der Kunde die
      // Immobilie sehen soll.
      persona_image: lotteBild(),
    },
  })
  if (error) throw new Error(`send-whatsapp: ${error.message}`)
  const r = data as { success?: boolean; attached?: boolean } | null
  if (!r?.success) throw new Error(`send-whatsapp: ${JSON.stringify(data)}`)
  // attached=false heisst: Text kam an, Bild nicht. Kein Abbruch — aber sichtbar,
  // sonst faellt ein dauerhaft kaputtes Bild nie auf.
  if (!r.attached) console.warn('[booking-bot] Lotte-Bild fehlte bei', phone)
}
async function logWa(admin: SupabaseClient, leadId: string, text: string, dir: 'inbound' | 'outbound'): Promise<void> {
  const content = (dir === 'outbound' ? withSignoff(text) : text).slice(0, 2000)
  try { await admin.from('activities').insert({ lead_id: leadId, type: 'whatsapp', direction: dir, subject: dir === 'outbound' ? 'WhatsApp: Termin-Bot' : 'WhatsApp erhalten', content, completed_at: new Date().toISOString() }) } catch { /* egal */ }
}

// ── KI: Kundenantwort verstehen ──────────────────────────────────────────────
interface Intent { intent: string; pick_index: number | null; day_hint: string | null; daypart: string | null; time_hint: string | null; meeting_type: string | null; on_date?: string | null; after_date?: string | null; answer?: string | null; defer_to_sven?: boolean; defer_until?: string | null }
type Turn = { role: 'user' | 'assistant'; content: string }
async function classify(state: string, slots: Slot[], text: string, verlauf: Turn[] = []): Promise<Intent> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  const fallback: Intent = { intent: 'unclear', pick_index: null, day_hint: null, daypart: null, time_hint: null, meeting_type: null }
  if (!key) return fallback
  const tp = berlinParts(new Date())
  const WDN = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
  const todayStr = `${tp.y}-${String(tp.mo).padStart(2, '0')}-${String(tp.d).padStart(2, '0')}`
  const sys = `Du interpretierst die WhatsApp-Antwort eines Kunden im Terminbuchungs-Dialog (deutsch). Zustand: ${state}. Vorgeschlagene Slots: ${slots.map((s, i) => `[${i}] ${s.label}`).join(' | ') || 'keine'}.
HEUTE ist ${WDN[tp.wd]}, der ${todayStr} (Europe/Berlin). Rechne relative/teilweise Datumsangaben in KONKRETE Kalenderdaten um.
Kontext: Es ist ein kurzes, unverbindliches Beratungsgespräch (ca. 15 Min) DIREKT mit Sven persönlich (Immobilien-Investment-Berater bei Happy Property Cyprus, Zypern).
Du siehst den bisherigen Gesprächsverlauf. Nutze ihn: Widerspricht die neue Nachricht dem, was du zuletzt geschrieben hast, hat der Kunde deine letzte Antwort NICHT akzeptiert — dann darf sie auf keinen Fall wiederholt werden. Wiederholt der Kunde seine Frage, war deine Antwort unbrauchbar → intent=content, damit Sven übernimmt.
Gib NUR das Tool emit_intent zurück. intent-Werte:
- pick_slot: Kunde wählt einen vorgeschlagenen Slot (pick_index 0 oder 1).
- reject_slots: keiner der Slots passt (evtl. mit day_hint/daypart/time_hint-Wunsch).
- give_preference: Kunde nennt Tag-/Zeit-Wunsch (day_hint z.B. "Dienstag","morgen","nächste Woche"; daypart "vormittags"|"nachmittags"|"abends"; time_hint = KONKRETE Uhrzeit als 24h "HH:MM", z.B. "15:00" aus "15 Uhr"/"um 3"/"halb 4"→"15:30"). ZEITRAUM: Nennt der Kunde ein FRÜHESTES Datum ("nach dem 9.7.", "ab nächster Woche", "erst in 2 Wochen", "erst ab dem 10."), fülle after_date = frühestes noch passendes Datum als "YYYY-MM-DD" (bei "nach dem 9.7." der 10.7. — der Tag DANACH; bei "ab dem 9.7." der 9.7.). Meint er GENAU EIN Datum ("am 10.7.", "diesen Freitag den 11."), fülle on_date = "YYYY-MM-DD". Jahr aus dem heutigen Datum ableiten (nächstes Vorkommen).
- choose_type: Kunde wählt Terminart (meeting_type "zoom" oder "whatsapp" — WhatsApp-Anruf/Telefon = whatsapp; nennt er MEHRERE ("Zoom oder WhatsApp, beides ok") → das ZUERST genannte).
- indifferent: Kunde hat KEINE Präferenz / ist mit allem einverstanden ("egal", "beides ok", "wie du willst", "such du aus", "passt alles").
- confirm_yes / confirm_no: Zustimmung/Ablehnung zu einem konkreten Vorschlag.
- question: reine ORGANISATORISCHE Rückfrage zum GESPRÄCH selbst, OHNE Terminangabe (z.B. "mit wem spreche ich?", "wie lange dauert das?", "ist das verbindlich?"). NUR Fragen zum Ablauf des Termins — NICHTS zur Immobilie.
- content: der Kunde macht eine INHALTLICHE Aussage ODER stellt eine FACHLICHE Frage — Budget ("max 500k"), Objektwünsche, Marktmeinung, persönliche Situation, Einwände, Themenwechsel, ausführliche Antworten, die KEINEN Terminwunsch enthalten. HIERHER GEHÖREN AUSDRÜCKLICH ALLE PREISFRAGEN: "was kostet es", "was kostet die Wohnung", "wie teuer", "Preis", "Nebenkosten", "Rendite", "Finanzierung". Frage nach einem Preis = IMMER content, NIEMALS question — der Kunde meint den Immobilienpreis, nicht den Gesprächspreis. Diese Zahlen kennt nur Sven. Solche Nachrichten gehören zu Sven persönlich, NICHT in den Termin-Dialog. Im Zweifel zwischen unclear und content → content.
ALLERWICHTIGSTE REGEL, sie geht dem TERMIN-VORRANG VOR: Unterscheide, WOFUER ein genanntes Datum steht. Sagt der Kunde, wann ER SICH MELDET oder wie lange er noch ueberlegen will, ist das intent = defer — NIEMALS give_preference. Nur wenn er sagt, wann das GESPRAECH stattfinden soll, ist es ein Terminwunsch. "Bis Sonntag geben wir Bescheid" = defer (defer_until = jener Sonntag). "Sonntag passt mir" = give_preference. Im Zweifel defer: einen Kunden, der um Bedenkzeit bittet, erneut nach einem Termin zu fragen, ist der schlimmste Fehler in diesem Dialog.
WICHTIG zum TERMIN-VORRANG: Nennt die Nachricht IRGENDEINEN Terminwunsch (Slot-Wahl, Tag, Datum, Uhrzeit, Tageszeit — z.B. "22.7. abends", "Freitag 15 Uhr") — auch wenn sie zusätzlich fachliche Fragen/Aussagen enthält — dann wähle intent = pick_slot bzw. give_preference (NICHT content/question) und fülle die Termin-Felder (pick_index / on_date / after_date / day_hint / daypart / time_hint). Setze in DIESEM Fall zusätzlich defer_to_sven = true, wenn die Nachricht fachliche/inhaltliche Themen enthält, die Sven persönlich beantworten sollte (Budget, Objekt-Details, Markt, Steuer, Finanzierung, Einwände). answer dann NICHT füllen — die fachlichen Punkte übernimmt Sven.
- defer: der Kunde will sich SELBST spaeter melden bzw. braucht Bedenkzeit — er nennt KEINEN Terminwunsch, sondern den Zeitpunkt seiner EIGENEN Rueckmeldung ("wir brauchen das Wochenende", "bis Sonntag geben wir Bescheid", "ich melde mich naechste Woche", "muessen erst in Ruhe schauen", "melde mich schnellstmoeglich"). Fuelle defer_until = das genannte Datum als "YYYY-MM-DD"; ohne Datumsangabe das Datum in 7 Tagen.
- self_followup: der Kunde sagt, dass ER sich melden wird, und will deshalb NICHT nachgefasst werden — "ich melde mich bei dir", "ich komme auf dich zu", "ich sag Bescheid, wenn es so weit ist", "bin noch am Überlegen, melde mich". Er sagt NICHTS Negatives, er will nur die Führung behalten. Diese Regel steht ÜBER defer: bei defer kündigt der Bot eine Wiedervorlage an ("ich melde mich am 28. nochmal") — genau das will dieser Kunde nicht hören.
- no_contact: der Kunde VERBIETET die Kontaktaufnahme ausdrücklich — "melde dich NICHT bei mir", "schreib mir nicht mehr", "hör auf zu schreiben", "du bist geblockt", "lass mich in Ruhe". Es muss eine Verneinung oder Abwehr enthalten sein. Bloßes "ich melde mich bei dir" ist NICHT no_contact, sondern self_followup.
  ENTHÄLT die Nachricht BEIDES — ein ausdrückliches Verbot UND die Ankündigung, sich selbst zu melden ("Nein, bitte melde dich nicht bei mir, ich melde mich bei dir!") — dann gewinnt das VERBOT: no_contact. Wer verneint, hat bereits einmal widersprochen; ihn nur weicher zu behandeln, ignoriert die Verschärfung.
- optout: will nicht kontaktiert werden / kein Interesse.
- unclear: kurze unverständliche Nachricht (Tippfehler, einzelnes Wort ohne Sinn).
WICHTIG:
- Nennt der Kunde eine konkrete Uhrzeit (z.B. "vielleicht 15:00?"), IMMER time_hint als "HH:MM" füllen (intent give_preference).
- answer NUR füllen, wenn die Frage sich mit diesen Fakten VOLLSTÄNDIG beantworten lässt: Gespräch direkt mit Sven persönlich, ca. 15 Min, unverbindlich & kostenlos, es geht um die offenen Fragen rund um Immobilien-Investment auf Zypern. Ton: Lotte, Svens Assistentin, Du-Form, max 1-2 Sätze. Geht die Frage darüber hinaus — Objektpreise, Kaufpreise, Nebenkosten, Rendite, Finanzierung, Steuern, Verfügbarkeit, konkrete Wohnungen — dann answer LEER LASSEN und intent=content wählen. Eine ausweichende Antwort ist schlimmer als gar keine: Wer nach dem Wohnungspreis fragt und hört, das Gespräch sei kostenlos, fühlt sich veräppelt. Erfinde NIEMALS Zahlen. Kombiniert der Kunde Frage + Terminwunsch → answer UND die Termin-Felder füllen.
Fülle nur passende Felder, sonst null.`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 300, system: sys,
        // Verlauf mitgeben statt nur der letzten Nachricht. Ohne ihn war Patricks
        // "Nein, bitte melde dich nicht bei mir" nicht als WIDERSPRUCH zur eben
        // gesendeten Bot-Nachricht erkennbar — gleiche Eingabe, gleicher Zustand,
        // also wortgleich die gleiche Ausgabe.
        messages: [...verlauf, { role: 'user', content: text }],
        tool_choice: { type: 'tool', name: 'emit_intent' },
        tools: [{ name: 'emit_intent', description: 'Intent der Kundenantwort', input_schema: {
          type: 'object', properties: {
            intent: { type: 'string', enum: ['pick_slot', 'reject_slots', 'give_preference', 'choose_type', 'confirm_yes', 'confirm_no', 'question', 'content', 'indifferent', 'defer', 'self_followup', 'no_contact', 'optout', 'unclear'] },
            pick_index: { type: ['integer', 'null'] }, day_hint: { type: ['string', 'null'] },
            daypart: { type: ['string', 'null'], enum: ['vormittags', 'nachmittags', 'abends', null] },
            time_hint: { type: ['string', 'null'], description: 'konkrete Uhrzeit 24h HH:MM' },
            after_date: { type: ['string', 'null'], description: 'YYYY-MM-DD — frühestes akzeptables Datum bei Zeitraum-Wunsch (nach dem 9.7. → 10.7.; ab nächster Woche)' },
            on_date: { type: ['string', 'null'], description: 'YYYY-MM-DD — wenn GENAU EIN konkretes Datum gemeint ist (am 10.7.)' },
            meeting_type: { type: ['string', 'null'], enum: ['zoom', 'whatsapp', null] },
            answer: { type: ['string', 'null'], description: 'kurze Antwort auf eine Zwischenfrage (Svens Du-Ton)' },
            defer_to_sven: { type: ['boolean', 'null'], description: 'true = Nachricht enthält NEBEN dem Termin fachliche Fragen, die Sven persönlich beantworten soll' },
            defer_until: { type: ['string', 'null'], description: 'YYYY-MM-DD — bei intent=defer: wann der Kunde sich selbst melden will' },
          }, required: ['intent'],
        } }],
      }),
    })
    const d = await res.json() as { content?: { type: string; name?: string; input?: Intent }[] }
    const tool = d.content?.find(c => c.type === 'tool_use')
    return tool?.input ? { ...fallback, ...tool.input } : fallback
  } catch (e) { console.warn('[booking-bot] classify Fehler:', e); return fallback }
}

// Erkennt in einer FREIEN (nicht-Dialog) WhatsApp, ob der Kunde einen Termin/Anruf/
// ein Gespräch ausmachen möchte. Konservativ (nur klare Terminwünsche), damit der
// Bot nicht bei Produktfragen/Smalltalk reingrätscht. Optional Zeit-Hinweise.
interface ApptReq { wants: boolean; onsite: boolean; day_hint: string | null; daypart: string | null; time_hint: string | null; on_date: string | null; after_date: string | null }
async function detectApptRequest(text: string): Promise<ApptReq> {
  const off: ApptReq = { wants: false, onsite: false, day_hint: null, daypart: null, time_hint: null, on_date: null, after_date: null }
  const key = Deno.env.get('ANTHROPIC_API_KEY'); if (!key) return off
  const tp = berlinParts(new Date())
  const WDN = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
  const todayStr = `${tp.y}-${String(tp.mo).padStart(2, '0')}-${String(tp.d).padStart(2, '0')}`
  const sys = `Du prüfst EINE WhatsApp-Nachricht aus einem Immobilien-Chat (deutsch). Sie kann vom KUNDEN oder von SVEN (Berater) stammen. HEUTE: ${WDN[tp.wd]}, ${todayStr} (Europe/Berlin).
Frage 1 (wants): Wird gerade eine Zeit für einen TERMIN/Anruf/Videocall/Gespräch ABGESTIMMT, VORGESCHLAGEN oder ERFRAGT, sodass eine Antwort/Zusage des Gegenübers nötig ist (egal ob Kunde oder Sven anfängt)?
wants=true: "können wir telefonieren?", "hast du morgen Zeit?", "lass uns einen Termin machen", "wann passt es dir?", "sollen wir kurz sprechen?", "wollen wir einen Call machen?".
wants=false bei: reinen Produkt-/Sachfragen, Smalltalk, Dank, "schick mir den Plan", Meinungen, Objektwünschen; reiner BESTÄTIGUNG eines schon vereinbarten Termins ("Freitag 12 passt", "ok bis dann"); Verweis auf VERGANGENES ("hatten ja telefoniert"); und EINSEITIGER Sofort-/Ankündigung OHNE Abstimmungsbedarf ("ich ruf dich gleich/jetzt/später an", "ich melde mich gleich"). Nur wenn eine Zeit erst noch gemeinsam gefunden werden muss → true. Im Zweifel false.
Frage 2 (onsite): Geht es klar um einen VOR-ORT-Termin? onsite=true bei Besichtigung/Viewing, Objektbesichtigung, persönliches Treffen vor Ort, "vorbeikommen", "die Wohnung/Objekt anschauen", "vor Ort treffen". onsite=false bei Telefonat/Call/Videocall/Zoom/WhatsApp-Anruf ODER wenn die Art offen/unklar ist (Default false).
Wenn wants=true UND eine Zeitangabe genannt ist, fülle die Hint-Felder (day_hint; daypart vormittags|nachmittags|abends; time_hint "HH:MM"; on_date für GENAU EIN Datum bzw. after_date für frühestes Datum, je "YYYY-MM-DD"). Sonst null. Gib NUR das Tool emit zurück.`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 200, system: sys,
        messages: [{ role: 'user', content: text }],
        tool_choice: { type: 'tool', name: 'emit' },
        tools: [{ name: 'emit', description: 'Terminwunsch?', input_schema: { type: 'object', properties: {
          wants: { type: 'boolean' }, onsite: { type: 'boolean', description: 'true = Vor-Ort-Termin/Viewing' },
          day_hint: { type: ['string', 'null'] },
          daypart: { type: ['string', 'null'], enum: ['vormittags', 'nachmittags', 'abends', null] },
          time_hint: { type: ['string', 'null'] }, on_date: { type: ['string', 'null'] }, after_date: { type: ['string', 'null'] },
        }, required: ['wants'] } }],
      }),
    })
    const d = await res.json() as { content?: { type: string; input?: ApptReq }[] }
    const tool = d.content?.find(c => c.type === 'tool_use')
    return tool?.input ? { ...off, ...tool.input } : off
  } catch (e) { console.warn('[booking-bot] detectApptRequest:', e); return off }
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

// ── Happy-Property-Mail-CI (= compose-deck-mail: Logo, Playfair/Montserrat, Coral/Navy) ──
const MAIL = {
  cream: '#fffcf6', navy: '#1a2332', coral: '#ff795d', ink: '#2a2a2a', line: '#e6dfd0', mute: '#8a8578', dark: '#1b1b22', gold: '#C2A15E',
  logo: 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg',
  photoSq: 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/render/image/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg?width=112&height=112&resize=cover&quality=80',
  sans: `'Montserrat',Arial,Helvetica,sans-serif`, serif: `'Playfair Display',Georgia,serif`,
}
function escH(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
// Gebrandete Terminbestätigung (E-Mail-sicher: Tabellen-Layout, feste Bildmaße, nowrap)
function buildConfirmHtml(o: { firstName: string; dateStr: string; timeStr: string; typeLabel: string; icon: string; zoomLink: string; isZoom: boolean }): string {
  const M = MAIL
  const where = o.zoomLink
    ? `<tr><td style="padding:16px 0 0 0;"><a href="${escH(o.zoomLink)}" target="_blank" style="display:inline-block;background:${M.coral};color:#ffffff;font-family:${M.sans};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;padding:13px 26px;border-radius:6px;white-space:nowrap;">Zoom beitreten →</a></td></tr>`
    : `<tr><td style="font-family:${M.sans};font-size:13px;color:${M.mute};padding:14px 0 0 0;line-height:1.6;">${o.isZoom ? 'Den Zoom-Link bekommst du rechtzeitig vorher.' : 'Ich rufe dich zur vereinbarten Zeit über WhatsApp an.'}</td></tr>`
  return `<!doctype html><html><body style="margin:0;padding:0;background:${M.cream};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${M.cream};padding:28px 12px;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${M.line};border-radius:14px;overflow:hidden;">
    <tr><td style="padding:24px 36px 20px 36px;border-bottom:1px solid ${M.line};"><img src="${M.logo}" width="128" height="39" alt="Happy Property Cyprus" style="display:block;width:128px;height:39px;"></td></tr>
    <tr><td style="padding:32px 40px 8px 40px;">
      <div style="font-family:${M.sans};font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:${M.coral};font-weight:700;">✅ Termin bestätigt</div>
      <h1 style="margin:8px 0 0 0;font-family:${M.serif};font-size:28px;line-height:1.15;font-weight:700;color:${M.navy};">Wir sprechen uns${o.firstName ? `, ${escH(o.firstName)}` : ''}!</h1>
      <p style="margin:16px 0 0 0;font-family:${M.sans};font-size:15px;line-height:1.6;color:${M.ink};">vielen Dank — dein persönliches Beratungsgespräch mit Sven ist fest eingetragen:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;background:${M.cream};border:1px solid ${M.line};border-radius:10px;"><tr><td style="padding:20px 24px;">
        <div style="font-family:${M.sans};font-size:16px;color:${M.navy};line-height:1.9;">📅 <strong>${escH(o.dateStr)}</strong><br>🕐 <strong>${escH(o.timeStr)} Uhr</strong> <span style="color:${M.mute};font-size:13px;">(deutsche Zeit)</span><br>${o.icon} ${escH(o.typeLabel)}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">${where}</table>
      </td></tr></table>
      <p style="margin:20px 0 0 0;font-family:${M.sans};font-size:13px;line-height:1.6;color:${M.mute};">Im Anhang findest du den Termin als Kalender-Datei (.ics) — einfach hinzufügen, dann geht nichts unter. Falls dir etwas dazwischenkommt, antworte einfach auf diese Mail.</p>
    </td></tr>
    <tr><td style="padding:22px 40px 28px 40px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="60" valign="middle"><img src="${M.photoSq}" width="52" height="52" alt="Sven" style="width:52px;height:52px;border-radius:50%;display:block;"></td>
      <td valign="middle" style="padding-left:14px;font-family:${M.sans};"><div style="font-size:15px;font-weight:700;color:${M.navy};">Sven Rüprich</div><div style="font-size:12px;color:${M.mute};">Happy Property Cyprus</div></td>
    </tr></table></td></tr>
    <tr><td style="background:${M.dark};padding:20px 40px;"><div style="font-family:${M.sans};font-size:11px;color:#9a9aa3;line-height:1.6;">Sveru Ltd. &nbsp;·&nbsp; Pallados 1, 8046 Paphos, Zypern &nbsp;·&nbsp; <a href="https://happy-property.com" style="color:${M.gold};text-decoration:none;">happy-property.com</a></div></td></tr>
  </table></td></tr></table></body></html>`
}

// ICS-Kalenderanhang (Kunde bekommt den Termin in seinen Kalender)
function toB64(str: string): string { const bytes = new TextEncoder().encode(str); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin) }
function buildIcs(o: { uid: string; title: string; startIso: string; endIso: string; description?: string }): string {
  const dt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Happy Property//CRM//DE', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${o.uid}@happy-property.com`, `DTSTAMP:${dt(new Date().toISOString())}`, `DTSTART:${dt(o.startIso)}`, `DTEND:${dt(o.endIso)}`,
    `SUMMARY:${esc(o.title)}`, ...(o.description ? [`DESCRIPTION:${esc(o.description)}`] : []),
    'ORGANIZER;CN=Sven Rüprich:mailto:sven@happy-property.com', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
}

// Buchung durchführen: Zoom (optional) → Google-Event → CRM-Termin → Pipeline
// „Termin gebucht" → Bestätigungs-Mail (mit Kalender-Anhang) → WhatsApp-Bestätigung.
async function book(admin: SupabaseClient, conv: { id: string; lead_id: string; deal_id: string | null }, lead: { first_name: string | null; whatsapp: string | null; phone: string | null; email: string | null }, slot: Slot, type: 'zoom' | 'whatsapp') {
  const phone = lead.whatsapp || lead.phone || ''
  const name = first(lead.first_name)
  const typeLabel = type === 'zoom' ? 'Zoom-Call' : 'Telefonat über WhatsApp'
  // Titel VOR dem Zoom-Aufruf berechnen — sonst traegt das Zoom-Meeting einen
  // anderen Namen als CRM und Google-Kalender (so war es bis eben).
  const apptTitle = await nextApptTitle(admin, conv.lead_id, name || 'Lead', slot.startIso)
  let zoomLink = ''
  if (type === 'zoom') {
    try {
      const { data } = await admin.functions.invoke('create-zoom-meeting', { body: { title: apptTitle, start_time: slot.startIso, duration_minutes: SLOT_MIN } })
      zoomLink = (data as { join_url?: string } | null)?.join_url ?? ''
    } catch (e) { console.warn('[booking-bot] Zoom-Erstellung fehlgeschlagen:', e) }
  }
  const desc = `Automatisch gebucht via WhatsApp-Terminbot.\nKunde: ${name}\nArt: ${typeLabel}${zoomLink ? `\nZoom: ${zoomLink}` : ''}`
  const cal = await createCalendarEvent(admin, { title: `${apptTitle} (${type === 'zoom' ? 'Zoom' : 'WhatsApp'})`, startIso: slot.startIso, endIso: slot.endIso, description: desc })

  // Deal ermitteln: der am Gespräch (no_show/erstkontakt) — sonst der aktive Deal
  // des Leads (z.B. bei Deck-Buchung), damit die Pipeline korrekt wandert.
  let dealId = conv.deal_id
  if (!dealId) {
    const { data: d } = await admin.from('deals').select('id').eq('lead_id', conv.lead_id).neq('phase', 'archiviert').order('created_at', { ascending: false }).limit(1).maybeSingle()
    dealId = (d as { id?: string } | null)?.id ?? null
  }

  // CRM-Termin (AFTER-INSERT-Trigger schließt Gespräch + stoppt Nudges). Fehler
  // NICHT verschlucken — sonst bestätigt der Bot fälschlich einen ungebuchten Termin.
  const { data: apptRow, error: apptErr } = await admin.from('crm_appointments').insert({
    title: apptTitle, type, start_time: slot.startIso, end_time: slot.endIso,
    lead_id: conv.lead_id, deal_id: dealId, zoom_link: zoomLink || null,
    phone_number: type === 'whatsapp' ? phone : null,
    google_event_id: cal?.id ?? null, google_calendar_id: cal?.calId ?? null,
    description: 'Vom WhatsApp-Terminbot gebucht',
  }).select('id').single()

  if (apptErr || !apptRow) {
    console.error('[booking-bot] Termin-Insert fehlgeschlagen:', apptErr?.message)
    const m = `Ups — beim Eintragen ist mir gerade ein technischer Fehler passiert 😕 Ich gebe das direkt an Sven, er bestätigt dir ${slot.label} Uhr gleich persönlich.`
    await setConv(admin, conv.id, { state: 'handoff', chosen_slot: slot, meeting_type: type, last_message: m })
    await sendWa(phone, m); await logWa(admin, conv.lead_id, m, 'outbound')
    try { await admin.from('activities').insert({ lead_id: conv.lead_id, type: 'note', direction: 'inbound', subject: '⚠️ Termin-Bot: Buchung fehlgeschlagen', content: `Termin ${slot.label} (${typeLabel}) konnte nicht gespeichert werden: ${apptErr?.message}. Bitte manuell eintragen.`, completed_at: new Date().toISOString() }) } catch { /* egal */ }
    return
  }

  // Betrifft die Buchung den HEUTIGEN Tag? Dann Sven sofort Bescheid geben.
  void notifyIfToday(admin, [slot.startIso],
    `📅 Neuer Termin HEUTE um ${cyTime(slot.startIso)}\n\n${name || 'Kunde'}\n${typeLabel}${phone ? `\n${phone}` : ''}\n\n(vom Termin-Bot gebucht)`)

  // Pipeline → „Termin gebucht" (wenn ein Deal existiert)
  if (dealId) {
    try { await admin.from('deals').update({ phase: 'termin_gebucht', phase_changed_at: new Date().toISOString() }).eq('id', dealId) }
    catch (e) { console.warn('[booking-bot] Pipeline-Update fehlgeschlagen:', e) }
  }

  // Bestätigung bevorzugt über die editierbaren „Termin gebucht"-Pipeline-Nachrichten
  // (Mail + WhatsApp; Zoom-/Telefon-Variante via has_zoom/no_zoom). schedule-message
  // plant sie, process-scheduled-messages sendet die passende Variante sofort (delay 0).
  let viaTemplates = false
  try {
    const { data: sm } = await admin.functions.invoke('schedule-message', { body: { lead_id: conv.lead_id, deal_id: dealId, event_type: 'termin_gebucht' } })
    viaTemplates = (((sm as { scheduled?: number } | null)?.scheduled) ?? 0) > 0
  } catch (e) { console.warn('[booking-bot] termin_gebucht-Trigger fehlgeschlagen:', e) }

  if (viaTemplates) {
    // Die Pipeline-Vorlagen übernehmen die Bestätigung (Mail + WhatsApp) → Gespräch nur schließen.
    await setConv(admin, conv.id, { state: 'booked', meeting_type: type, last_message: `Termin gebucht (${slot.label} Uhr) — Bestätigung via „Termin gebucht"-Vorlagen.` })
    return
  }

  // ── Fallback (keine aktive „Termin gebucht"-Regel): eigene gebrandete Bestätigung ──
  // Bestätigungs-Mail mit Kalender-Anhang
  if (lead.email) {
    try {
      const dateStr = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(slot.startIso))
      const timeStr = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(slot.startIso))
      const html = buildConfirmHtml({ firstName: name, dateStr, timeStr, typeLabel, icon: type === 'zoom' ? '📹' : '💬', zoomLink, isZoom: type === 'zoom' })
      const ics = buildIcs({ uid: apptRow.id, title: 'Beratungsgespräch mit Sven – Happy Property', startIso: slot.startIso, endIso: slot.endIso, description: (type === 'zoom' && zoomLink) ? `Zoom: ${zoomLink}` : 'Beratungsgespräch mit Sven · Happy Property' })
      await admin.functions.invoke('send-email', { body: { to: lead.email, subject: `Terminbestätigung: Beratungsgespräch am ${dateStr}`, html, lead_id: conv.lead_id, attachment: { filename: 'termin.ics', content_base64: toB64(ics), content_type: 'text/calendar' } } })
    } catch (e) { console.warn('[booking-bot] Bestätigungs-Mail fehlgeschlagen:', e) }
  }

  const confirm = type === 'zoom'
    ? `Perfekt${name ? `, ${name}` : ''}! ✅ Dein Zoom-Termin mit Sven steht: ${slot.label} Uhr (deutsche Zeit).${zoomLink ? `\n\nZoom-Link: ${zoomLink}` : '\n\nDen Zoom-Link schicke ich dir rechtzeitig vorher.'}${lead.email ? '\n\nEine Bestätigung mit Kalender-Eintrag ist auch per Mail unterwegs.' : ''}\n\nBis dann! Liebe Grüße, Lotte 🐾`
    : `Perfekt${name ? `, ${name}` : ''}! ✅ Dein Termin mit Sven steht: ${slot.label} Uhr (deutsche Zeit). Er ruft dich dann über WhatsApp an.${lead.email ? '\n\nEine Bestätigung mit Kalender-Eintrag ist auch per Mail unterwegs.' : ''}\n\nBis dann! Liebe Grüße, Lotte 🐾`
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

// ── Proaktive Vorschläge: 2 Slots, 2 VERSCHIEDENE Tage, 1× vormittags + 1× nachmittags ──
const mkSlot = (start: Date): Slot => ({ startIso: start.toISOString(), endIso: new Date(start.getTime() + SLOT_MIN * 60000).toISOString(), label: labelDe(start) })
async function computeSlotsAmPm(admin: SupabaseClient): Promise<Slot[]> {
  const now = new Date()
  const from = new Date(now.getTime() + 12 * 3600e3)
  const to   = new Date(now.getTime() + 20 * 24 * 3600e3)
  const busy = await getBusy(admin, from, to)
  const isFree = (s: Date) => { const st = s.getTime(), en = st + SLOT_MIN * 60000; return s > from && !busy.some(b => st < b.end && en > b.start) }
  let am: Slot | null = null, pm: Slot | null = null
  for (let off = 1; off <= 18 && !(am && pm); off++) {
    const bp = berlinParts(new Date(now.getTime() + off * 24 * 3600e3))
    if (!windowFor(bp.wd)) continue
    const weekday = bp.wd >= 1 && bp.wd <= 5
    if (!am && weekday) { const s = berlinToUtc(bp.y, bp.mo, bp.d, 11, 0); if (isFree(s)) am = mkSlot(s) }           // Vormittag nur Mo–Fr 11:00
    if (!pm) { const s = berlinToUtc(bp.y, bp.mo, bp.d, weekday ? 16 : 17, 0)                                        // Nachmittag Mo–Fr 16:00 / WE 17:00
      if (isFree(s) && (!am || berlinDateStr(s.toISOString()) !== berlinDateStr(am.startIso))) pm = mkSlot(s) }
  }
  const out: Slot[] = []
  if (am) out.push(am); if (pm) out.push(pm)
  if (out.length < 2) { const extra = await computeSlots(admin, 3)                                                   // Fallback: verschiedene Tage
    for (const s of extra) { if (!out.some(o => berlinDateStr(o.startIso) === berlinDateStr(s.startIso))) { out.push(s); if (out.length >= 2) break } } }
  return out.slice(0, 2)
}
// Editierbaren Bot-Text laden (booking_bot_messages, Fallback = mitgegebener Default).
async function botText(admin: SupabaseClient, key: string, fallback: string): Promise<string> {
  try { const { data } = await admin.from('booking_bot_messages').select('intro').eq('key', key).maybeSingle()
    const t = (data as { intro?: string } | null)?.intro; return (t && t.trim()) ? t : fallback } catch { return fallback }
}
const fillName = (t: string, first: string | null) => t.replace(/\{\{\s*vorname\s*\}\}/gi, first || 'du')
function buildProposal(intro: string, slots: Slot[], isFinal: boolean): string {
  const opts  = slots.map((s, i) => `${i + 1}) ${s.label} Uhr`).join('\n')
  const close = isFinal
    ? '(deutsche Zeit) — sag mir einfach kurz Bescheid, oder schlag mir gern einen anderen Termin vor, der dir besser passt. 🙂'
    : '(deutsche Zeit) Was passt dir besser? Oder schlag mir gern einen anderen Termin vor, der dir besser passt.'
  return `${intro}\n\n${opts}\n\n${close}`
}

// ── NUDGE ── Nachfass-Stufen (No-Show 1-5 · Immobilienauswahl 0-5): frische
// Vorschläge, nur solange der Kunde NIE geantwortet hat. Für Immobilienauswahl wird ein
// Gespräch bei Bedarf NEU angelegt (der Kunde hat evtl. gar nicht geöffnet → noch keins).
async function handleNudge(admin: SupabaseClient, leadId: string, stage: number, source: string, introOverride?: string): Promise<Response> {
  const { data: st } = await admin.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
  if ((st as { value?: string } | null)?.value !== 'true') return json({ ok: true, skipped: 'disabled' })
  const { data: opt } = await admin.from('communication_optouts').select('id').eq('lead_id', leadId).limit(1)
  if (opt && opt.length) return json({ ok: true, skipped: 'optout' })
  const { data: appt } = await admin.from('crm_appointments').select('id').eq('lead_id', leadId).gte('start_time', new Date().toISOString()).limit(1)
  if (appt && appt.length) return json({ ok: true, skipped: 'has_appointment' })
  // Irgendein aktives Gespräch des Leads (egal welche Quelle) → kein Doppel-Messaging.
  const { data: conv } = await admin.from('booking_conversations').select('id, state, created_at')
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const c = conv as null | { id: string; state: string; created_at: string }
  // Wiedervorlage nach einer Bedenkzeit: das Gespraech schlaeft und muss GEWECKT
  // werden. Ohne diesen Zweig faellt es durch beide Filter darunter (state ist nicht
  // awaiting_choice, und der Kunde HAT ja geantwortet) und der Bot meldet sich nie
  // wieder — die Bedenkzeit waere ein stilles Ende statt einer Pause.
  if (c && source === 'snooze') {
    if (c.state !== 'snoozed') return json({ ok: true, skipped: 'nicht_mehr_pausiert' })
    await setConv(admin, c.id, { state: 'awaiting_choice', snoozed_until: null, attempts: 0 })
  } else if (c) {
    if (c.state !== 'awaiting_choice') return json({ ok: true, skipped: 'engaged_or_closed' })
    const { data: inb } = await admin.from('activities').select('id').eq('lead_id', leadId).eq('type', 'whatsapp').eq('direction', 'inbound').gt('created_at', c.created_at).limit(1)
    if (inb && inb.length) return json({ ok: true, skipped: 'engaged' })
  }
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })
  const slots = await computeSlotsAmPm(admin)
  if (slots.length < 2) return json({ ok: true, skipped: 'no_slots' })
  const isFinal = stage >= 5
  const intro = fillName((introOverride && introOverride.trim()) ? introOverride : await botText(admin, `${source}_${stage}`, 'Hi {{vorname}}, wollen wir kurz sprechen? Ich hätte zwei Zeiten frei:'), l.first_name)
  const msg = buildProposal(intro, slots, isFinal)
  const expires = new Date(Date.now() + 4 * 24 * 3600e3).toISOString()   // rollend, damit späte Antworten greifen
  if (c) await setConv(admin, c.id, { proposed_slots: slots, last_message: msg, expires_at: expires })
  else await admin.from('booking_conversations').insert({ lead_id: leadId, source, state: 'awaiting_choice', proposed_slots: slots, last_message: msg, expires_at: expires })
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
  return json({ ok: true, nudged: stage, source })
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
    // snoozed bleibt bewusst „aktiv": meldet der Kunde sich frueher als angekuendigt,
    // soll seine Antwort ganz normal im Dialog landen statt ins Leere zu laufen.
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').gt('expires_at', new Date().toISOString()).limit(1)
  if (active && active.length) return json({ ok: true, skipped: 'active_conversation' })
  // Kürzlich an Sven übergeben oder gebucht? Dann grätscht der Bot NICHT wieder rein
  // (Rainer-Fall: neuer Deck-View startete den Bot mitten in Svens Gespräch).
  const since7d = new Date(Date.now() - 7 * 864e5).toISOString()
  const { data: recent } = await admin.from('booking_conversations').select('id')
    .eq('lead_id', leadId).in('state', ['handoff', 'booked']).gt('updated_at', since7d).limit(1)
  if (recent && recent.length) return json({ ok: true, skipped: 'recent_handoff_or_booked' })
  // Kunde hat in den letzten 48h selbst geschrieben? Dann läuft ein echter Dialog —
  // kein automatischer Bot-Einstieg.
  const since48h = new Date(Date.now() - 48 * 3600e3).toISOString()
  const { data: inb } = await admin.from('activities').select('id')
    .eq('lead_id', leadId).eq('type', 'whatsapp').eq('direction', 'inbound').gt('created_at', since48h).limit(1)
  if (inb && inb.length) return json({ ok: true, skipped: 'customer_recently_replied' })
  // Schon ein anstehender Termin?
  const { data: appt } = await admin.from('crm_appointments').select('id').eq('lead_id', leadId).gte('start_time', new Date().toISOString()).limit(1)
  if (appt && appt.length) return json({ ok: true, skipped: 'has_appointment' })
  // Lead + Nummer
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })

  const slots = await computeSlotsAmPm(admin)   // 2 Termine, 2 Tage, 1× vormittags + 1× nachmittags
  if (slots.length < 2) return json({ ok: true, skipped: 'no_slots' })

  // Eröffnungstext je Auslöser (editierbar in booking_bot_messages).
  const key = source === 'erstkontakt' ? 'erstkontakt_0' : source === 'deck_viewed' ? 'deck_viewed_0' : 'no_show_0'
  const fallback = source === 'erstkontakt'
    ? 'Hey {{vorname}}, danke für deine Anfrage! Leider ist keine Terminbuchung angekommen — lass es uns direkt lösen, ich hätte zwei Zeiten frei:'
    : source === 'deck_viewed'
    ? 'Hey {{vorname}}, schön, dass du dir die Objekte angeschaut hast! Was ist dein Favorit — wollen wir gemeinsam draufschauen? Ich hätte zwei Zeiten frei:'
    : 'Hey {{vorname}}, schade — wir haben uns gerade verpasst. Lass es uns direkt nachholen, ich hätte zwei Zeiten frei:'
  const intro = fillName(await botText(admin, key, fallback), l.first_name)
  const msg = buildProposal(intro, slots, false)
  const { data: conv } = await admin.from('booking_conversations')
    // No-Show läuft über 14 Tage (Nudge-Sequenz) → längeres Ablauffenster, damit späte Antworten greifen.
    .insert({ lead_id: leadId, deal_id: dealId, source, state: 'awaiting_choice', proposed_slots: slots, last_message: msg,
              ...(source === 'no_show' ? { expires_at: new Date(Date.now() + 16 * 24 * 3600e3).toISOString() } : {}) })
    .select('id').single()
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')

  // No-Show: 5 weitere Nudge-Stufen planen (Tag 1/2/3/5/14). process-scheduled-messages
  // ruft dafür booking-bot nudge; buchen/Opt-Out storniert sie automatisch (Trigger).
  if (source === 'no_show') {
    const base = Date.now()
    const delays = [1440, 2880, 4320, 7200, 20160]   // Minuten = 1/2/3/5/14 Tage
    const rows = delays.map((d, i) => ({
      lead_id: leadId, deal_id: dealId, type: 'whatsapp', event_type: 'bot_nudge',
      bot_nudge_stage: i + 1, bot_nudge_source: 'no_show', status: 'pending',
      scheduled_at: new Date(base + d * 60000).toISOString(),
    }))
    try { await admin.from('scheduled_messages').insert(rows) } catch (e) { console.warn('[booking-bot] Nudge-Planung fehlgeschlagen:', e) }
  }
  return json({ ok: true, started: (conv as { id: string }).id })
}

// ── REPLY ─────────────────────────────────────────────────────────────────────
async function handleReply(admin: SupabaseClient, leadId: string, text: string): Promise<Response> {
  // 'snoozed' MIT ausschliessen: ein schlafendes Gespraech darf nicht erneut durch
  // den defer-Zweig laufen. Genau daran ist Patrick Dahlmann eskaliert — er
  // widersprach der Zusage ("melde dich NICHT bei mir") und bekam sie wortgleich
  // ein zweites Mal, weil das Gespraech trotz state='snoozed' wieder eingesammelt
  // wurde. Ein schlafendes Gespraech gehoert zu Sven, nicht zum Bot.
  const { data: conv } = await admin.from('booking_conversations').select('*')
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired,snoozed)').gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const c = conv as null | { id: string; lead_id: string; deal_id: string | null; state: string; proposed_slots: Slot[] | null; chosen_slot: Slot | null; attempts: number; rounds_no_progress: number | null; last_sent_norm: string | null }
  if (!c) return json({ ok: true, skipped: 'no_active_conversation' })

  // ANSPRUCH: nur EIN Lauf darf dieses Gespraech gerade bearbeiten.
  // Nimet Guerses schickte vier Nachrichten in fuenf Sekunden; der Webhook startete
  // pro Nachricht einen eigenen Lauf, alle lasen denselben Zustand und antworteten.
  // Ergebnis waren zwei einander widersprechende WhatsApps 240 ms auseinander.
  // Der bedingte UPDATE ist atomar: wer die Zeile bekommt, arbeitet; die anderen
  // steigen aus. Ihre Nachricht geht nicht verloren — sie steht im Verlauf, den
  // der laufende Durchgang ohnehin liest.
  const claimBis = new Date(Date.now() + 90_000).toISOString()
  const { data: claimed } = await admin.from('booking_conversations')
    .update({ processing_until: claimBis }).eq('id', c.id)
    .or(`processing_until.is.null,processing_until.lt.${new Date().toISOString()}`)
    .select('id').maybeSingle()
  if (!claimed) return json({ ok: true, skipped: 'wird_bereits_bearbeitet' })

  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone, email').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null; email: string | null }
  const phone = l.whatsapp || l.phone || ''
  // KEIN logWa fuer inbound: der timelines-webhook hat die Nachricht bereits
  // geschrieben, und zwar mit whatsapp_message_id. Der zweite Schreiber hier liess
  // im Kundenverlauf jede eingehende Nachricht doppelt erscheinen und verfaelschte
  // die Zaehler, die per count auf activities.direction='inbound' gehen.

  const slots = c.proposed_slots ?? []
  // Die letzten Züge als echten Dialog mitgeben, chronologisch aufsteigend.
  let verlauf: Turn[] = []
  try {
    const { data: hist } = await admin.from('activities').select('direction, content')
      .eq('lead_id', leadId).eq('type', 'whatsapp')
      .order('created_at', { ascending: false }).limit(7)
    verlauf = ((hist ?? []) as Array<{ direction: string; content: string | null }>)
      .filter(h => (h.content ?? '').trim())
      .reverse()
      .map(h => ({ role: h.direction === 'outbound' ? 'assistant' as const : 'user' as const, content: (h.content ?? '').slice(0, 700) }))
    // Endende user-Züge abschneiden: das ist die gerade eingegangene Nachricht,
    // die classify selbst anhängt — sie stünde sonst zweimal im Prompt.
    while (verlauf.length && verlauf[verlauf.length - 1].role === 'user') verlauf.pop()
  } catch (e) { console.warn('[booking-bot] Verlauf nicht ladbar:', e) }
  const it = await classify(c.state, c.state === 'awaiting_daypref' ? [] : slots, text, verlauf)

  // Tag-Kontext EXAKT behalten: nennt der Kunde nur Tageszeit/Uhrzeit (keinen Tag),
  // während schon konkrete Slots auf dem Tisch lagen → deren Datum pinnen, damit die
  // gewünschte Uhrzeit am RICHTIGEN Tag landet (nicht am nächsten passenden).
  let ctxDate: string | null = c.chosen_slot?.startIso ? berlinDateStr(c.chosen_slot.startIso) : null
  if (!ctxDate && c.proposed_slots?.length) {
    const ds = c.proposed_slots.map(s => berlinDateStr(s.startIso))
    if (ds.every(d => d === ds[0])) ctxDate = ds[0]   // alle Vorschläge am selben Tag
  }
  // Nur pinnen, wenn der Kunde KEINEN eigenen Tag/Zeitraum genannt hat (expliziter
  // after_date/on_date-Wunsch hat Vorrang vor dem Kontext-Tag der alten Vorschläge).
  if (!it.day_hint && !it.after_date && !it.on_date && (it.daypart || it.time_hint) && ctxDate) {
    it.on_date = ctxDate
  }

  // Sendet — aber niemals dasselbe zweimal. Der wortgleiche Doppelversand an
  // Patrick Dahlmann (13:56:12 und 13:56:38) war der Ausloeser fuer sein "ok du
  // bist geblockt!". Wiederholt sich der Bot, hat er den Kunden nicht verstanden;
  // dann uebernimmt Sven, statt es ein drittes Mal zu versuchen.
  // Anspruch loesen, sobald dieser Durchgang fertig ist — sonst wartet die
  // naechste Kundennachricht bis zu 90 s, obwohl niemand mehr arbeitet.
  const done = async () => { await setConv(admin, c.id, { processing_until: null }); return json({ ok: true }) }

  const say = async (m: string): Promise<boolean> => {
    const norm = normText(m)
    if (norm && norm === (c.last_sent_norm ?? '')) {
      console.warn('[booking-bot] Wiederholung unterdrueckt, Uebergabe an Sven:', leadId)
      await handoff(admin, c.id, phone, leadId, l.first_name)
      return false
    }
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound')
    await setConv(admin, c.id, { last_message: m, last_sent_norm: norm })
    c.last_sent_norm = norm
    return true
  }

  // Kontaktverbot und Opt-Out zuerst — vor allem anderen.
  // "Nein, bitte melde dich nicht bei mir, ich melde mich bei dir!" wurde bisher
  // als defer gelesen und mit "ich melde mich nochmal" beantwortet: die woertliche
  // Missachtung dessen, worum der Kunde gebeten hat.
  if (it.intent === 'optout' || it.intent === 'no_contact') {
    // NUR beim ausdruecklichen Verbot ein dauerhafter Opt-Out. Er sperrt den Lead
    // fuer JEDE Automatik, auch kuenftige Kampagnen — das ist richtig, wenn jemand
    // "schreib mir nicht mehr" sagt, und falsch bei allem Weicheren.
    try { await admin.from('communication_optouts').insert({ lead_id: leadId }) } catch { /* Trigger schliesst Gespraech */ }
    await setConv(admin, c.id, { state: 'handoff', processing_until: null })
    const m = it.intent === 'no_contact'
      ? 'Alles klar — ich melde mich nicht mehr. Du weißt ja, wo du uns findest. 🙂'
      : 'Alles klar, ich lasse dich in Ruhe. Melde dich jederzeit, wenn es doch passt. 🙂'
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound')
    try { await admin.from('activities').insert({ lead_id: leadId, type: 'note', direction: 'inbound', subject: '🚫 Kunde möchte nicht kontaktiert werden', content: `Der Kunde hat die Kontaktaufnahme untersagt:\n\n„${text}"\n\nAlle Automatiken sind gestoppt.`, completed_at: new Date().toISOString() }) } catch { /* egal */ }
    return json({ ok: true, handled: it.intent })
  }

  // "Ich melde mich bei dir" — der Kunde will die Führung behalten.
  // KEIN Opt-Out: Patrick Dahlmann hat genau so angefangen, und ein Lead, der nur
  // in Ruhe prüfen will, darf nicht dauerhaft gesperrt werden. Sven kann ihn
  // jederzeit persönlich anschreiben. Der Bot hört hier nur auf zu drängen —
  // und kündigt vor allem KEINE Wiedervorlage an, denn genau die Ankündigung
  // ("ich melde mich am 28. nochmal") hat Patrick zum Blockieren gebracht.
  if (it.intent === 'self_followup') {
    await setConv(admin, c.id, { state: 'handoff', processing_until: null })
    try {
      await admin.from('scheduled_messages').update({ status: 'cancelled' })
        .eq('lead_id', leadId).eq('status', 'pending').eq('event_type', 'bot_nudge')
    } catch { /* egal */ }
    const m = `Alles klar${l.first_name ? `, ${l.first_name}` : ''} — dann warte ich auf dich. 🙂 Melde dich einfach, wenn du so weit bist.`
    await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound')
    try { await admin.from('activities').insert({ lead_id: leadId, type: 'note', direction: 'inbound', subject: '✋ Kunde meldet sich selbst — Nachfassen gestoppt', content: `Der Kunde will von sich aus auf uns zukommen:\n\n„${text}"\n\nDer Bot fasst nicht mehr nach. Du kannst ihn jederzeit persönlich anschreiben — es liegt KEINE Kontaktsperre vor.`, completed_at: new Date().toISOString() }) } catch { /* egal */ }
    return json({ ok: true, handled: 'self_followup' })
  }

  // Kunde will sich SELBST melden / braucht Bedenkzeit → nicht weiter nach einem
  // Termin fragen. Genau das ist am 20.7. schiefgegangen: „wir brauchen das
  // Wochenende" und „bis Sonntag geben wir Bescheid" enthielten Wochentage, die
  // Termin-Vorrang-Regel machte daraus einen Terminwunsch, und der Bot schlug
  // zweimal hintereinander neue Slots vor. Das Gespraech schlaeft jetzt bis zum
  // genannten Tag und meldet sich dann von selbst wieder.
  if (it.intent === 'defer') {
    const today = new Date()
    let until = it.defer_until ? new Date(`${it.defer_until}T09:00:00Z`) : null
    if (!until || isNaN(until.getTime()) || until.getTime() < today.getTime()) {
      until = new Date(today.getTime() + 7 * 864e5)   // ohne brauchbares Datum: in einer Woche
    }
    // Einen Tag NACH der angekuendigten Rueckmeldung nachfassen — nicht am selben Tag,
    // sonst faellt die Nachricht mit seiner eigenen zusammen.
    const wake = new Date(until.getTime() + 864e5)
    const dLbl = until.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' })
    // Anrede bewusst Singular: der Chat ist 1:1, auch wenn der Kunde von „wir" spricht.
    const m = `Alles klar${l.first_name ? `, ${l.first_name}` : ''} — nimm dir in Ruhe die Zeit. 🙂\n\nIch melde mich nach ${dLbl} nochmal, falls ich bis dahin nichts von dir gehört habe. Bis dahin eine schöne Zeit!\n\nLiebe Grüße\nLotte 🐾`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
    await setConv(admin, c.id, {
      state: 'snoozed', snoozed_until: wake.toISOString(), attempts: 0, last_message: m,
      // Ablauf mitziehen, sonst ist das Gespraech tot, bevor es wieder aufwacht.
      expires_at: new Date(wake.getTime() + 14 * 864e5).toISOString(),
    })
    // Offene Nachfass-Nachrichten stoppen und EINE Wiedervorlage setzen.
    try {
      await admin.from('scheduled_messages').update({ status: 'cancelled' })
        .eq('lead_id', leadId).eq('status', 'pending').eq('event_type', 'bot_nudge')
      await admin.from('scheduled_messages').insert({
        lead_id: leadId, deal_id: c.deal_id, type: 'whatsapp', event_type: 'bot_nudge',
        bot_nudge_stage: 1, bot_nudge_source: 'snooze', status: 'pending',
        scheduled_at: wake.toISOString(),
      })
    } catch (e) { console.warn('[booking-bot] Wiedervorlage:', e) }
    try {
      await admin.from('activities').insert({
        lead_id: leadId, type: 'note', direction: 'inbound',
        subject: '⏸️ Termin-Bot: Kunde meldet sich selbst',
        content: `Der Kunde bat um Bedenkzeit bis ${dLbl}. Der Bot fragt bis dahin nicht mehr nach und meldet sich am ${wake.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} wieder.`,
        completed_at: new Date().toISOString(),
      })
    } catch { /* egal */ }
    return json({ ok: true, handled: 'defer', wake: wake.toISOString() })
  }

  // Enthält die Nachricht einen Terminwunsch (auch wenn zusätzlich fachliche Fragen dabei sind)?
  const hasApptSignal = it.pick_index != null || !!it.on_date || !!it.after_date || !!it.day_hint || !!it.daypart || !!it.time_hint

  // REIN inhaltliche Nachricht (Budget, Objekte, Situation, Einwand) OHNE Terminbezug:
  // gehört zu Sven, nicht in den Termin-Dialog → sofort übergeben, KEIN Slot-Push.
  if (it.intent === 'content' && !hasApptSignal) {
    const m = `Danke dir${l.first_name ? `, ${l.first_name}` : ''}! Das gebe ich direkt an Sven weiter — er meldet sich gleich persönlich bei dir. 🙂`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
    await setConv(admin, c.id, { state: 'handoff', last_message: m })
    return json({ ok: true, handled: 'content_handoff' })
  }

  // Fachliche Fragen ZUSAMMEN mit einem Terminwunsch (z.B. „diverse Fragen … und Termin
  // am 22.7. abends"): die fachlichen Themen an Sven verweisen (Kunde + Notiz für Sven),
  // den Terminwunsch aber ganz normal weiterverarbeiten — statt alles zu blockieren.
  if ((it.intent === 'content' || it.defer_to_sven) && hasApptSignal) {
    const m = `Deine inhaltlichen Fragen gebe ich direkt an Sven weiter — er meldet sich dazu zeitnah persönlich. 🙂`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
    try { await admin.from('activities').insert({ lead_id: leadId, type: 'note', direction: 'inbound', subject: '⚠️ Termin-Bot: fachliche Frage — bitte persönlich melden', content: `Der Kunde hat neben dem Termin fachliche Fragen gestellt:\n\n${text}`, completed_at: new Date().toISOString() }) } catch { /* egal */ }
    if (it.intent === 'content') it.intent = 'give_preference'   // ab hier übernimmt der Terminfluss
    it.answer = null                                             // fachliches macht Sven, kein Bot-Halbwissen
  }

  // Zwischenfrage beantworten (z.B. „Mit wem spreche ich?") — ohne den Faden zu
  // verlieren. Eine Rückfrage ist Interesse, kein Missverstehen → Zähler zurück.
  if (it.answer) {
    if (!await say(it.answer)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
    await setConv(admin, c.id, { attempts: 0, processing_until: null }); c.attempts = 0
    // NACH einer Antwort ist Schluss. Vorher lief die Zustandsmaschine weiter und
    // schickte eine ZWEITE Nachricht: Nimet Guerses bekam 240 ms nach der Antwort
    // auf ihre Preisfrage noch die Slot-Wiederholung "Sag mir einfach 1 oder 2".
    // Zwei Nachrichten gleichzeitig wirken wie zwei Absender, die aneinander
    // vorbeireden. Der Ball liegt jetzt beim Kunden.
    return json({ ok: true, handled: 'answered' })
  }
  if (it.intent === 'question') {
    // Ohne brauchbare Antwort nicht raten, sondern uebergeben.
    await handoff(admin, c.id, phone, leadId, l.first_name)
    return json({ ok: true, handled: 'question_handoff' })
  }

  // bump() laeuft genau dann, wenn der Bot NICHT weitergekommen ist — er hat die
  // Antwort nicht verwerten koennen und fragt nach.
  //
  // attempts allein reichte dafuer nicht: der Zaehler wird bei jedem Zustands-
  // wechsel und jeder beantworteten Zwischenfrage auf 0 gesetzt. Nimet Guerses
  // lief genau in diese Luecke — "Hab ich leider nicht" setzte den Zustand neu
  // (attempts 0), "Kein Problem ??" zaehlte auf 1, und sie bekam dieselbe Frage
  // ein zweites Mal in anderen Worten statt einer Uebergabe.
  //
  // rounds_no_progress ueberlebt Zustandswechsel und zaehlt ueber das ganze
  // Gespraech. Zwei erfolglose Runden reichen: wer zweimal nicht verstanden
  // wurde, will einen Menschen.
  const bump = async () => {
    const rnp = (c.rounds_no_progress ?? 0) + 1
    const n = (c.attempts ?? 0) + 1
    c.rounds_no_progress = rnp
    if (n >= 2 || rnp >= 2) {
      console.warn(`[booking-bot] kein Fortschritt (attempts ${n}, Runden ${rnp}) → Uebergabe:`, leadId)
      await handoff(admin, c.id, phone, leadId, l.first_name); return true
    }
    await setConv(admin, c.id, { attempts: n, rounds_no_progress: rnp }); return false
  }

  // ── Zustandsmaschine ──
  if (c.state === 'awaiting_choice') {
    if (it.intent === 'pick_slot' && it.pick_index != null && slots[it.pick_index]) {
      await askType(admin, c.id, phone, leadId, l.first_name, slots[it.pick_index]); return await done()
    }
    if (it.intent === 'indifferent' && slots[0]) {
      // „Egal / such du aus" → ersten Vorschlag nehmen und weiter zur Terminart
      await askType(admin, c.id, phone, leadId, l.first_name, slots[0]); return await done()
    }
    if (it.intent === 'give_preference' || it.intent === 'reject_slots') {
      // Direkt mit Präferenz Slots rechnen, sonst nach Tag/Tageszeit fragen
      if (it.day_hint || it.daypart || it.time_hint || it.after_date || it.on_date) return await proposeSlots(admin, c.id, phone, leadId, l.first_name, it)
      const m = `Kein Problem! An welchem Tag passt es dir besser — und eher vormittags oder nachmittags?`
      await setConv(admin, c.id, { state: 'awaiting_daypref', attempts: 0, last_message: m })
      if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' }); return await done()
    }
    if (await bump()) return json({ ok: true, handled: 'handoff' })
    const m = `Sag mir einfach 1 oder 2 — oder wann es dir sonst besser passt. 🙂\n\n1) ${slots[0]?.label} Uhr\n2) ${slots[1]?.label} Uhr`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' }); return await done()
  }

  if (c.state === 'awaiting_type') {
    if (it.intent === 'choose_type' && (it.meeting_type === 'zoom' || it.meeting_type === 'whatsapp') && c.chosen_slot) {
      await book(admin, c, l, c.chosen_slot, it.meeting_type); return json({ ok: true, handled: 'booked' })
    }
    // Der Slot steht bereits — hier wird NIE aufgegeben (Raffi-Fall: „Egal" führte
    // zu handoff statt Buchung). Keine Präferenz oder zweite unklare Antwort →
    // unkompliziertester Standard: WhatsApp-Call.
    if (c.chosen_slot && (it.intent === 'indifferent' || (c.attempts ?? 0) >= 1)) {
      const m = `Alles klar — dann machen wir es ganz unkompliziert per WhatsApp-Call. 🙂`
      if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
      await book(admin, c, l, c.chosen_slot, 'whatsapp'); return json({ ok: true, handled: 'booked_default' })
    }
    await setConv(admin, c.id, { attempts: (c.attempts ?? 0) + 1 })
    const m = `Kurze Rückfrage: lieber telefonieren wir über WhatsApp, oder machen wir einen Zoom-Call?`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' }); return await done()
  }

  if (c.state === 'awaiting_daypref') {
    if (it.day_hint || it.daypart || it.time_hint || it.intent === 'give_preference') {
      return await proposeSlots(admin, c.id, phone, leadId, l.first_name, it)
    }
    if (await bump()) return json({ ok: true, handled: 'handoff' })
    const m = `An welchem Wochentag passt es dir am besten — und eher vormittags oder nachmittags?`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' }); return await done()
  }

  if (c.state === 'awaiting_confirm') {
    if (it.intent === 'confirm_yes' && c.chosen_slot) {
      await askType(admin, c.id, phone, leadId, l.first_name, c.chosen_slot); return await done()
    }
    if (it.intent === 'confirm_no' || it.intent === 'give_preference' || it.intent === 'reject_slots') {
      if (it.day_hint || it.daypart || it.time_hint || it.after_date || it.on_date) return await proposeSlots(admin, c.id, phone, leadId, l.first_name, it)
      const m = `Kein Problem — welcher Tag und eher vormittags oder nachmittags?`
      await setConv(admin, c.id, { state: 'awaiting_daypref', attempts: 0, last_message: m })
      if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' }); return await done()
    }
    if (await bump()) return json({ ok: true, handled: 'handoff' })
    const m = `Passt dir ${c.chosen_slot?.label} Uhr? Ein kurzes „ja" genügt. 🙂`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' }); return await done()
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
  const onDate = it.on_date ?? undefined, afterDate = it.after_date ?? undefined

  // (1) Konkrete Wunschuhrzeit → frei? Dann DIREKT annehmen (gleich Terminart fragen)
  if (it.time_hint) {
    const exact = await computeSlots(admin, 1, { dayHint, onDate, afterDate, timeHint: it.time_hint })
    if (exact.length) return await askType(admin, convId, phone, leadId, name, exact[0])
    // gewünschte Uhrzeit belegt/außerhalb → 2 Alternativen am selben Tag anbieten
    const alt = await computeSlots(admin, 2, { dayHint, onDate, afterDate, daypart })
    if (alt.length >= 2) return await sendChoice(admin, convId, phone, leadId, alt, `Um ${it.time_hint} Uhr habe ich da leider nichts frei. Wie wäre stattdessen:`)
    if (alt.length === 1) return await sendConfirm(admin, convId, phone, leadId, alt[0], `Um ${it.time_hint} Uhr ist leider belegt — wie wäre `)
  }

  // (2) Tag/Tageszeit/Zeitraum → immer 2 Vorschläge
  const slots = await computeSlots(admin, 2, { dayHint, onDate, afterDate, daypart })
  if (slots.length >= 2) return await sendChoice(admin, convId, phone, leadId, slots, 'Klar! Wie wäre:')
  if (slots.length === 1) return await sendConfirm(admin, convId, phone, leadId, slots[0], 'Ich hätte da nur einen Slot frei — wie wäre ')

  // (3) am Wunschtag nichts frei → 2 allgemeine Alternativen (Zeitraum-Wunsch bleibt gewahrt)
  const any = await computeSlots(admin, 2, afterDate || onDate ? { afterDate, onDate } : undefined)
  if (any.length >= 2) return await sendChoice(admin, convId, phone, leadId, any, 'Da hab ich leider nichts frei. Wie wäre stattdessen:')
  return json({ ok: true, skipped: 'no_slots' })
}

// ── ENGAGE ── Kunde fragt MITTEN im freien Chat nach einem Termin → Bot klinkt
// sich ein (auch während ein persönliches Gespräch läuft). Eigener Schalter
// booking_bot_auto_engage (zusätzlich zu booking_bot_enabled), Standard AUS.
async function handleEngage(admin: SupabaseClient, leadId: string, text: string, force = false): Promise<Response> {
  // force=true = manueller Anstoß durch Sven ("mach den Termin fertig"): umgeht den
  // Auto-Schalter, den vorhandenen-Termin-Guard und die Wunsch-Erkennung. Opt-Out
  // und laufendes Gespräch werden IMMER respektiert (kein Doppel-Messaging).
  if (!force) {
    const { data: sset } = await admin.from('crm_settings').select('key, value').in('key', ['booking_bot_enabled', 'booking_bot_auto_engage'])
    const sv = new Map(((sset ?? []) as { key: string; value: string }[]).map(s => [s.key, s.value]))
    if (sv.get('booking_bot_enabled') !== 'true' || sv.get('booking_bot_auto_engage') !== 'true') return json({ ok: true, skipped: 'disabled' })
  }
  const { data: opt } = await admin.from('communication_optouts').select('id').eq('lead_id', leadId).limit(1)
  if (opt && opt.length) return json({ ok: true, skipped: 'optout' })
  const { data: active } = await admin.from('booking_conversations').select('id')
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').gt('expires_at', new Date().toISOString()).limit(1)
  if (active && active.length) return json({ ok: true, skipped: 'active_conversation' })
  // Ist es überhaupt ein (Remote-)Terminwunsch? Vor-Ort-Termine (Viewing/Besichtigung)
  // macht Sven selbst — da klinkt sich der Bot NICHT ein. Fachliches bleibt bei Sven.
  const det = await detectApptRequest(text)
  if (!det.wants && !force) return json({ ok: true, skipped: 'no_appt_intent' })
  if (det.onsite && !force) return json({ ok: true, skipped: 'onsite_termin' })
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })
  const hasHint = det.day_hint || det.daypart || det.time_hint || det.on_date || det.after_date
  const slots = hasHint
    ? await computeSlots(admin, 2, { dayHint: det.day_hint ?? undefined, daypart: det.daypart ?? undefined, timeHint: det.time_hint ?? undefined, onDate: det.on_date ?? undefined, afterDate: det.after_date ?? undefined })
    : await computeSlotsAmPm(admin)
  if (slots.length < 1) return json({ ok: true, skipped: 'no_slots' })
  // Lotte stellt sich vor (editierbar: booking_bot_messages key 'chat_request_0').
  const fallback = 'Hallo {{vorname}} 🐾 Ich bin Lotte, Svens persönliche Assistentin — ich helfe dir schnell zu einem Termin mit Sven. Was hältst du von:'
  const intro = fillName(await botText(admin, 'chat_request_0', fallback), l.first_name)
  const msg = buildProposal(intro, slots, false)
  await admin.from('booking_conversations').insert({ lead_id: leadId, source: 'chat_request', state: 'awaiting_choice', proposed_slots: slots, last_message: msg, expires_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString() })
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
  return json({ ok: true, engaged: true, slots: slots.length })
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json() as { action?: string; lead_id?: string; deal_id?: string | null; source?: string; text?: string; stage?: number; intro?: string; state?: string; slots?: Slot[]; meeting_type?: string; force?: boolean }
    // classify: seiteneffektfreier Test des Intent-Parsers (kein Senden, kein DB-Write).
    if (body.action === 'classify') return json({ ok: true, intent: await classify(body.state ?? 'awaiting_choice', body.slots ?? [], body.text ?? '') })
    // detect: seiteneffektfreier Test des Terminwunsch-Erkenners (kein Senden).
    if (body.action === 'detect') return json({ ok: true, detect: await detectApptRequest(body.text ?? '') })
    // book_now: den in der aktiven Konversation vorgeschlagenen/bestätigten Slot direkt
    // buchen (Kalender + CRM-Termin + Bestätigung) — für den Fall, dass eine Bestätigung
    // den Bot nie erreicht hat (z.B. verworfene Inbound-Nachricht). meeting_type default whatsapp.
    if (body.action === 'book_now') {
      if (!body.lead_id) return json({ error: 'lead_id fehlt' }, 400)
      const { data: conv } = await admin.from('booking_conversations').select('id, lead_id, deal_id, chosen_slot, proposed_slots')
        .eq('lead_id', body.lead_id).not('state', 'in', '(booked,handoff,expired)').order('created_at', { ascending: false }).limit(1).maybeSingle()
      const cc = conv as { id: string; lead_id: string; deal_id: string | null; chosen_slot: Slot | null; proposed_slots: Slot[] | null } | null
      const slot = cc?.chosen_slot ?? cc?.proposed_slots?.[0] ?? null
      if (!cc || !slot) return json({ ok: false, error: 'keine aktive Konversation mit Slot' }, 400)
      const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone, email').eq('id', body.lead_id).maybeSingle()
      const type = body.meeting_type === 'zoom' ? 'zoom' : 'whatsapp'
      await book(admin, cc, lead as { first_name: string | null; whatsapp: string | null; phone: string | null; email: string | null }, slot, type)
      return json({ ok: true, booked: slot.label, type })
    }
    if (!body.lead_id) return json({ error: 'lead_id fehlt' }, 400)
    if (body.action === 'start') return await handleStart(admin, body.lead_id, body.deal_id ?? null, body.source ?? 'unknown')
    if (body.action === 'engage') return await handleEngage(admin, body.lead_id, body.text ?? '', body.force === true)
    if (body.action === 'reply') return await handleReply(admin, body.lead_id, body.text ?? '')
    if (body.action === 'nudge') return await handleNudge(admin, body.lead_id, Number(body.stage) || 0, body.source ?? 'no_show', body.intro)
    return json({ error: `Unbekannte action: ${body.action}` }, 400)
  } catch (err) {
    console.error('[booking-bot] Fehler:', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
