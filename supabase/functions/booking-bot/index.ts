// Supabase Edge Function: booking-bot
// WhatsApp-Terminbot: schlägt 2 freie Slots (deutsche Zeit) vor, versteht die
// Kundenantwort per KI, gleicht Svens Kalender ab und bucht den Termin.
//
// Actions (POST, JSON):
//   { action:'start', lead_id, deal_id?, source }   → Gespräch eröffnen (2 Slots)
//   { action:'reply', lead_id, text }               → eingehende WhatsApp verarbeiten
//   { action:'absage', lead_id, text, fallback?, still? } → Absage/Verschiebung eines
//                                                     anstehenden Termins (handleAbsage)
//
// SICHERHEIT: läuft nur, wenn crm_settings 'booking_bot_enabled'='true'.
// Verfügbarkeit: Mo–Fr 11–19, Sa+So 17–20 (Europe/Berlin), frühestens ab morgen.
// Guardrails: 1 Gespräch/Lead, Opt-Out stoppt, nach 2 unklaren Antworten Übergabe
// an Sven, Ablauf nach 3 Tagen. Terminart fragt der Bot (WhatsApp-Call oder Zoom).
//
// Deployment: supabase functions deploy booking-bot --no-verify-jwt
// Secrets: GOOGLE_SERVICE_ACCOUNT_JSON, ANTHROPIC_API_KEY, TIMELINES_API_KEY,
//          TIMELINES_WA_SENDER (+ Standard SUPABASE_*)
//
// Aufrufer (Guard am Handler-Anfang, Befund I3-1): NUR System-Aufrufe.
//   pg_cron booking-bot-sweep  → Header x-cron-secret (connector_secrets CRON_SECRET)
//   process-scheduled-messages, timelines-/evolution-webhook (_shared/waInbound)
//                              → fetch mit Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//   meta-leads-sync            → admin.functions.invoke, schickt den Service-Key nur
//                                als apikey-Header (deckt gateCaller ab)
// Kein Browser ruft den Bot auf. Manuelle Anstöße (engage force, book_now) brauchen
// seitdem ebenfalls den Service-Key.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { nextApptTitle } from '../_shared/apptTitle.ts'
import { notifyIfToday, cyTime, cyDate } from '../_shared/notifyToday.ts'
import { gateCaller } from '../_shared/callerGate.ts'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'
import { koennteAbsageSein, terminZone, terminLabel, lotteAbsageText, lotteVerschiebenIntro, lotteVerschiebenSven, bautraegerAbsageText, waMeLink, type AbsageArt } from '../_shared/terminAbsage.ts'
import {
  regelVorfilter, sendungenBauen, lotteAngebotText, angebotNotiz, kandidatenWaehlen, lotteBautraegerText, bautraegerBetreff, bautraegerNotiz,
  regionFaktenLesen, lotteRegionText, regionNotiz, geldNotiz, geldMitZahl, istRegistriert, namensTeile, bautraegerTeile, bautraegerAnzeige,
  namenErsetzen, enthaeltNamen, lageLabel, objektTyp, preisListe, betraegeIn, zahlenIn, fremdeBetraege,
  type LotteRegel, type EinheitFrei, type DeckZeile, type OutboxZeile, type SichtZeile, type VersandZeile, type ProjektFrei, type BautraegerProjekt,
} from '../_shared/lotteRegeln.ts'
import { antwortSprache, dauerhaftEnglisch, spracheErkennen, sprachNotiz, SPRACH_BETREFF, type Sprache } from '../_shared/kundenSprache.ts'
import { ruhezeitZiel } from '../_shared/ruhezeit.ts'

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
// Buchungsfenster in DEUTSCHER Zeit (der ganze Bot rechnet in Europe/Berlin).
// Sven denkt in Zypern-Zeit, die genau eine Stunde vorgeht:
//   Mo-Fr: letzter Terminbeginn 21:00 Zypern = 20:00 deutscher Zeit, Ende 20:30
//          -> Fenster-Ende 20.5 (die zweite Zahl ist das spaeteste ENDE).
//   Sa/So: unveraendert 17-20 deutscher Zeit = 18-21 Zypern.
function windowFor(wd: number): [number, number] | null {
  if (wd >= 1 && wd <= 5) return [11, 20.5]   // Mo–Fr 11:00–20:30 dt. = 12:00–21:30 Zypern
  return [17, 20]                              // Sa+So 17–20 dt. = 18–21 Zypern
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

// Ist ein früher vorgeschlagener Slot JETZT noch buchbar? (Befund I3-3)
// Vorschläge bleiben bis zu 4 Tage (No-Show 16) offen; inzwischen kann der Slot
// vorbei oder vergeben sein (anderer Lead mit demselben Vorschlag, Sven selbst,
// Tagessperre, Google-Termin). Gleiche strikte Überlappung wie isFree in
// computeSlots und KEIN Puffer, sonst würden angebotene Anschluss-Slots abgelehnt.
// getBusy liefert bei Fehlern, was es hat (wie beim Vorschlagen, also fail-open).
async function slotStillOk(admin: SupabaseClient, slot: Slot): Promise<'ok' | 'past' | 'taken'> {
  const st = new Date(slot.startIso).getTime(), en = new Date(slot.endIso).getTime()
  if (!(st > Date.now())) return 'past'
  const busy = await getBusy(admin, new Date(st), new Date(en))
  return busy.some(b => st < b.end && en > b.start) ? 'taken' : 'ok'
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

// Es gibt Faelle, in denen sich SVEN selbst meldet statt Lotte: Leute, die ihn
// noch gar nicht kennen (Meta-Fragebogen, 21.8.). Dann seine Unterschrift und
// sein Foto - eine Assistentin mit Hundefoto wirkt beim Erstkontakt zu flapsig.
const SVEN_BILD = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/sven-termin.jpg'
const SVEN_QUELLEN = ['meta_formular']

function withSignoff(text: string, asSven = false): string {
  // Vorhandene Gruesse nicht doppeln — einige Texte signieren selbst.
  if (/(liebe grüße|viele grüße|beste grüße|\blg\b|bis dann)/i.test(text)) return text
  return asSven ? `${text}\n\nViele Grüße\nSven` : `${text}\n\nLiebe Grüße\nLotte 🐾`
}

// Ein Client fuer den Versand. Bewusst modulweit und faul angelegt: sendWa hat
// 22 Aufrufstellen, die sonst alle den admin-Client durchreichen muessten.
let sbSend: SupabaseClient | null = null
const sendClient = () => (sbSend ??= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!))

// Antwortsprache je Kunde für die laufende Anfrage (Sven 30.10.: Lotte antwortet in
// der Sprache, in der der Kunde schreibt). Aus demselben Grund wie sbSend modulweit:
// mitSprache setzt sie für die Eingangs-Actions, sendWa gibt sie an send-whatsapp
// weiter (das bei 'en' übersetzt), logWa vermerkt die Übersetzung. Ohne Eintrag
// bleibt es wie bisher: send-whatsapp nimmt die Sprache aus dem Kontakt.
const sprachePerNummer = new Map<string, Sprache>()
const sprachePerLead = new Map<string, Sprache>()
const nummer9 = (p: string) => p.replace(/\D/g, '').slice(-9)
const UEBERSETZT = '(für den Kunden ins Englische übersetzt)'

/** Nachricht auf ihren Kern reduzieren, um Wiederholungen zu erkennen. */
function normText(t: string): string {
  return t.toLowerCase()
    .replace(/liebe gr[üu][ßs]e[\s\S]*$/i, '')            // Signatur weg
    .replace(/[^a-zäöüß0-9]+/g, ' ')                      // Emojis/Satzzeichen weg
    .trim()
}

async function sendWa(phone: string, text: string, asSven = false): Promise<string | null> {
  const full = withSignoff(text, asSven)
  // Ueber send-whatsapp statt direkt an Timelines: nur dort sitzen Bild-Upload,
  // Verkleinerung, JPEG-Wandlung und der 2-MB-Guard.
  const { data, error } = await sendClient().functions.invoke('send-whatsapp', {
    body: {
      event_type: 'booking_bot', override_text: full,
      lead_data: { lead_name: 'Kunde', lead_phone: phone },
      lang: sprachePerNummer.get(nummer9(phone)),
      // persona_image statt file_url: ein Deck-Titelbild oder eine YouTube-Vorschau
      // im Text hat Vorrang. Sonst schickt der Bot ein Hundefoto, wo der Kunde die
      // Immobilie sehen soll.
      persona_image: asSven ? SVEN_BILD : lotteBild(),
    },
  })
  if (error) throw new Error(`send-whatsapp: ${error.message}`)
  const r = data as { success?: boolean; attached?: boolean; results?: { ok?: boolean; data?: { id?: string | null } | null }[] } | null
  if (!r?.success) throw new Error(`send-whatsapp: ${JSON.stringify(data)}`)
  // attached=false heisst: Text kam an, Bild nicht. Kein Abbruch — aber sichtbar,
  // sonst faellt ein dauerhaft kaputtes Bild nie auf.
  if (!r.attached) console.warn('[booking-bot] Lotte-Bild fehlte bei', phone)
  // WhatsApp-ID der Nachricht (nur bei Evolution), damit eine Reaktion des Kunden
  // genau dieser Nachricht zugeordnet werden kann (cafeReaktion).
  return r.results?.find(x => x.ok)?.data?.id ?? null
}
async function logWa(admin: SupabaseClient, leadId: string, text: string, dir: 'inbound' | 'outbound', msgId: string | null = null): Promise<void> {
  const content = (dir === 'outbound' ? withSignoff(text) + (sprachePerLead.get(leadId) === 'en' ? `\n\n${UEBERSETZT}` : '') : text).slice(0, 20000)
  try { await admin.from('activities').insert({ lead_id: leadId, type: 'whatsapp', direction: dir, subject: dir === 'outbound' ? 'WhatsApp: Termin-Bot' : 'WhatsApp erhalten', content, completed_at: new Date().toISOString(), auto: dir === 'outbound', ...(msgId ? { whatsapp_message_id: msgId } : {}) }) } catch { /* egal */ }
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
Nachrichten mit dem Präfix "[Sven persönlich]" hat SVEN SELBST geschrieben, nicht du. Seine Zusagen sind verbindlich und stehen ÜBER deinen Verfügbarkeits-Vorschlägen: Sagt er einen Termin zu ("Doch Montag 19:00 passt", "den mache ich frei"), dann gilt genau dieser Termin — schlage NIE Alternativen dazu vor und frage ihn nicht erneut ab.
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
interface ApptReq { wants: boolean; onsite: boolean; casual?: boolean; day_hint: string | null; daypart: string | null; time_hint: string | null; on_date: string | null; after_date: string | null }
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
Frage 3 (casual): Nur bei onsite=true. casual=true, wenn die Person Sven einfach persönlich KENNENLERNEN oder sich locker mit ihm treffen will (z. B. "wir sind gerade in Paphos, können wir uns kurz treffen?"), OHNE eine bestimmte Wohnung/ein Objekt besichtigen zu wollen. casual=false bei Besichtigung/Viewing/Objekt anschauen. Im Zweifel false.
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
          casual: { type: 'boolean', description: 'true = lockeres Kennenlernen vor Ort, keine Besichtigung' },
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
      await admin.functions.invoke('send-email', { body: { to: lead.email, subject: `Terminbestätigung: Beratungsgespräch am ${dateStr}`, html, lead_id: conv.lead_id, auto: true, attachment: { filename: 'termin.ics', content_base64: toB64(ics), content_type: 'text/calendar' } } })
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
// Nimmt den ersten Schluessel, zu dem ein gepflegter Text existiert. So kann ein
// Sonderfall (z.B. Mail nie geoeffnet) pro Stufe verfeinert werden, muss aber nicht:
// ohne Stufen-Text greift der generische, ohne den der Standardtext der Stufe.
async function botText(admin: SupabaseClient, key: string | string[], fallback: string): Promise<string> {
  const keys = Array.isArray(key) ? key : [key]
  try {
    const { data } = await admin.from('booking_bot_messages').select('key, intro').in('key', keys)
    const rows = (data ?? []) as { key: string; intro: string | null }[]
    for (const k of keys) {
      const t = rows.find((r) => r.key === k)?.intro
      if (t && t.trim()) return t
    }
    return fallback
  } catch { return fallback }
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
// Quellenübergreifender Doppel-Schutz: hat der Lead GERADE ERST eine proaktive
// Bot-WhatsApp bekommen (egal von welcher Nudge-Quelle), fasst der Bot nicht sofort
// nochmal nach. Andreas Will bekam sonst zwei fast identische Lotte-Vorstellungen
// 5 Min auseinander (deck_viewed + immobilienauswahl feuerten überlappend).
// Marker: logWa setzt bei proaktiven Sends subject='WhatsApp: Termin-Bot'. Der
// laufende Dialog (handleReply) ist bewusst NICHT betroffen (kundeninitiiert).
async function recentlyAcqMessaged(admin: SupabaseClient, leadId: string, hours = 6): Promise<boolean> {
  try {
    const since = new Date(Date.now() - hours * 3600_000).toISOString()
    const { data } = await admin.from('activities').select('id')
      .eq('lead_id', leadId).eq('type', 'whatsapp').eq('direction', 'outbound')
      .eq('subject', 'WhatsApp: Termin-Bot').gt('created_at', since).limit(1)
    return !!(data && data.length)
  } catch { return false }
}

// Nachfass-Texte zur Immobilienauswahl UNTERSTELLEN, dass der Kunde die Vorschlaege
// gesehen hat ("Hattest du schon Zeit, dir Svens Vorschlaege anzuschauen?"). Die Kette
// haengt aber nur am Phasenwechsel (24 h / 3 / 5 / 10 / 14 / 30 Tage) und laeuft auch,
// wenn der Kunde nie geoeffnet hat (Roni Schroeter, 25.8.: Phase 24.8. 17:49 gewechselt,
// Mail erst 25.8. 04:21 raus, nie geoeffnet, WhatsApp trotzdem punkt 24 h spaeter).
// Die Kette bleibt in ihrem Takt - nur der TEXT richtet sich jetzt danach, ob der Kunde
// die Unterlagen wirklich gesehen hat. Einzige Ausnahme: liegt die Mail noch gar nicht
// beim Kunden, wird die Stufe vertagt, denn dann gibt es nichts zu fragen.
const SICHT_QUELLEN = ['immobilienauswahl', 'deck_viewed']
type SichtLage = { warten: false; gesehen: boolean } | { warten: true; grund: string }

async function unterlagenLage(admin: SupabaseClient, leadId: string): Promise<SichtLage> {
  // 1. Sind die Vorschlaege ueberhaupt raus?
  const { data: ob } = await admin.from('deck_outbox')
    .select('email_sent_at, sent_at').eq('lead_id', leadId)
    .order('created_at', { ascending: false }).limit(5)
  const raus = (ob ?? [])
    .map((r) => (r as { email_sent_at: string | null; sent_at: string | null }))
    .map((r) => r.email_sent_at ?? r.sent_at)
    .filter((d): d is string => !!d)
    .sort()
  if (!raus.length) return { warten: true, grund: 'unterlagen_nicht_raus' }
  // 2. Hat der Kunde sie nach dem Versand geoeffnet oder angesehen?
  const seit = new Date(raus[0]).getTime()
  const { data: ev } = await admin.from('engagement_events').select('id')
    .eq('lead_id', leadId).in('type', ['email_open', 'deck_view'])
    .gte('occurred_at', new Date(seit - 5 * 60000).toISOString()).limit(1)
  return { warten: false, gesehen: !!(ev && ev.length) }
}

// Vertagt eine Stufe um 24 h (im Sendefenster 9-20 Uhr deutscher Zeit), statt sie
// ersatzlos ausfallen zu lassen. Nur fuer den Fall "Unterlagen noch nicht raus" -
// die naechsten Stufen der Kette laufen unabhaengig weiter.
async function vertageNudge(admin: SupabaseClient, leadId: string, stage: number, source: string): Promise<void> {
  try {
    const { data: pend } = await admin.from('scheduled_messages').select('id')
      .eq('lead_id', leadId).eq('event_type', 'bot_nudge').eq('bot_nudge_stage', stage)
      .eq('bot_nudge_source', source).eq('status', 'pending').limit(1)
    if (pend && pend.length) return
    const ziel = new Date(Date.now() + 864e5)
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' }).format(ziel))
    if (h < 9) ziel.setUTCHours(ziel.getUTCHours() + (9 - h))
    else if (h >= 20) ziel.setUTCHours(ziel.getUTCHours() - (h - 19))
    await admin.from('scheduled_messages').insert({
      lead_id: leadId, type: 'whatsapp', event_type: 'bot_nudge',
      bot_nudge_stage: stage, bot_nudge_source: source, status: 'pending',
      scheduled_at: ziel.toISOString(),
    })
  } catch (e) { console.warn('[booking-bot] vertageNudge:', e) }
}

async function handleNudge(admin: SupabaseClient, leadId: string, stage: number, source: string, introOverride?: string): Promise<Response> {
  const { data: st } = await admin.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
  if ((st as { value?: string } | null)?.value !== 'true') return json({ ok: true, skipped: 'disabled' })
  const { data: opt } = await admin.from('communication_optouts').select('id').eq('lead_id', leadId).limit(1)
  if (opt && opt.length) return json({ ok: true, skipped: 'optout' })
  // Ein Termin mit gemeldeter Absage zählt nicht: der Kunde braucht einen neuen.
  const { data: appt } = await admin.from('crm_appointments').select('id').eq('lead_id', leadId).gte('start_time', new Date().toISOString()).is('cancel_reported_at', null).limit(1)
  if (appt && appt.length) return json({ ok: true, skipped: 'has_appointment' })
  // Café-Angebot unbeantwortet: eigene Nachfrage statt neuer Zeitvorschläge, in der
  // Sprache, in der der Kunde zuletzt geschrieben hat (wie das Angebot selbst).
  if (source === 'cafe') {
    const { data: zk } = await admin.from('activities').select('content').eq('lead_id', leadId)
      .eq('type', 'whatsapp').eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1).maybeSingle()
    return await mitSprache(admin, leadId, (zk as { content: string | null } | null)?.content ?? '', () => cafeNachfass(admin, leadId, stage))
  }
  if (await recentlyAcqMessaged(admin, leadId)) return json({ ok: true, skipped: 'recent_acquisition_wa' })
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
  // Fragt dieser Nudge nach den Unterlagen? Dann muss der Kunde sie auch gesehen haben.
  // Nicht geoeffnet -> Text, der nichts unterstellt. Stufenspezifisch, sonst generisch.
  const keys = [`${source}_${stage}`]
  if (SICHT_QUELLEN.includes(source) && !introOverride) {
    const lage = await unterlagenLage(admin, leadId)
    if (lage.warten) { await vertageNudge(admin, leadId, stage, source); return json({ ok: true, skipped: lage.grund }) }
    if (!lage.gesehen) keys.unshift(`${source}_ungeoeffnet_${stage}`, `${source}_ungeoeffnet`)
  }
  const intro = fillName((introOverride && introOverride.trim()) ? introOverride : await botText(admin, keys, 'Hi {{vorname}}, wollen wir kurz sprechen? Ich hätte zwei Zeiten frei:'), l.first_name)
  const msg = buildProposal(intro, slots, isFinal)
  const expires = new Date(Date.now() + 4 * 24 * 3600e3).toISOString()   // rollend, damit späte Antworten greifen
  if (c) await setConv(admin, c.id, { proposed_slots: slots, last_message: msg, expires_at: expires })
  else await admin.from('booking_conversations').insert({ lead_id: leadId, source, state: 'awaiting_choice', proposed_slots: slots, last_message: msg, expires_at: expires })
  await sendWa(phone, msg, SVEN_QUELLEN.includes(source)); await logWa(admin, leadId, msg, 'outbound')
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
  if (await recentlyAcqMessaged(admin, leadId)) return json({ ok: true, skipped: 'recent_acquisition_wa' })
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
  // Schon ein anstehender Termin? (gemeldete Absagen zählen nicht)
  const { data: appt } = await admin.from('crm_appointments').select('id').eq('lead_id', leadId).gte('start_time', new Date().toISOString()).is('cancel_reported_at', null).limit(1)
  if (appt && appt.length) return json({ ok: true, skipped: 'has_appointment' })
  // Lead + Nummer
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })

  const slots = await computeSlotsAmPm(admin)   // 2 Termine, 2 Tage, 1× vormittags + 1× nachmittags
  if (slots.length < 2) return json({ ok: true, skipped: 'no_slots' })

  // Eröffnungstext je Auslöser (editierbar in booking_bot_messages).
  const key = source === 'meta_formular' ? 'meta_formular_0'
    : source === 'erstkontakt' ? 'erstkontakt_0' : source === 'deck_viewed' ? 'deck_viewed_0' : 'no_show_0'
  const fallback = source === 'meta_formular'
    ? 'Hallo {{vorname}}, hier ist Sven von Happy Property.'
    : source === 'erstkontakt'
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
  await sendWa(phone, msg, SVEN_QUELLEN.includes(source)); await logWa(admin, leadId, msg, 'outbound')

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
type ReplyConv = { id: string; lead_id: string; deal_id: string | null; state: string; proposed_slots: Slot[] | null; chosen_slot: Slot | null; attempts: number; rounds_no_progress: number | null; last_sent_norm: string | null }

async function handleReply(admin: SupabaseClient, leadId: string, text: string): Promise<Response> {
  // 'snoozed' MIT ausschliessen: ein schlafendes Gespraech darf nicht erneut durch
  // den defer-Zweig laufen. Genau daran ist Patrick Dahlmann eskaliert — er
  // widersprach der Zusage ("melde dich NICHT bei mir") und bekam sie wortgleich
  // ein zweites Mal, weil das Gespraech trotz state='snoozed' wieder eingesammelt
  // wurde. Ein schlafendes Gespraech gehoert zu Sven, nicht zum Bot.
  const { data: conv } = await admin.from('booking_conversations').select('*')
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired,snoozed)').gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const c = conv as ReplyConv | null
  if (!c) return json({ ok: true, skipped: 'no_active_conversation' })

  // ANSPRUCH: nur EIN Lauf darf dieses Gespraech gerade bearbeiten.
  // Nimet Guerses schickte vier Nachrichten in fuenf Sekunden; der Webhook startete
  // pro Nachricht einen eigenen Lauf, alle lasen denselben Zustand und antworteten.
  // Ergebnis waren zwei einander widersprechende WhatsApps 240 ms auseinander.
  // Der bedingte UPDATE ist atomar: wer die Zeile bekommt, arbeitet; die anderen
  // warten. Aussteigen darf der Wartende NICHT: der laufende Durchgang liest den
  // Verlauf VOR der neuen Nachricht, sie ginge also verloren. Lothar Huemmer (4.9., 10:21) hat
  // genau so seine Zusage "11 Uhr" verloren: der vorige Lauf hatte den Anspruch nicht
  // freigegeben, 25 s spaeter stieg der neue Lauf aus, und niemand antwortete mehr.
  // Deshalb: warten, bis der andere Lauf fertig ist, und dann mit dem NEUEN Zustand
  // arbeiten. Erst wenn nach 30 s niemand loslaesst, wird ausgestiegen.
  let claimed: { id: string } | null = null
  for (let versuch = 0; versuch < 7 && !claimed; versuch++) {
    if (versuch) await new Promise(r => setTimeout(r, 5000))
    const { data } = await admin.from('booking_conversations')
      .update({ processing_until: new Date(Date.now() + 90_000).toISOString() }).eq('id', c.id)
      .or(`processing_until.is.null,processing_until.lt.${new Date().toISOString()}`)
      .select('id').maybeSingle()
    claimed = data as { id: string } | null
  }
  if (!claimed) {
    console.warn('[booking-bot] Anspruch nicht bekommen, Nachricht unbearbeitet:', leadId, text.slice(0, 120))
    return json({ ok: true, skipped: 'wird_bereits_bearbeitet' })
  }

  // Zustand nach dem Warten neu lesen: der andere Lauf hat ihn womoeglich veraendert.
  const { data: frisch } = await admin.from('booking_conversations').select('*').eq('id', c.id).maybeSingle()
  const cc = (frisch as ReplyConv | null) ?? c
  // Waehrend des Wartens gebucht/uebergeben/eingeschlafen? Dann gehoert das Gespraech
  // nicht mehr dem Bot — sonst schreibt er hinter einer Buchung oder Uebergabe her.
  if (['booked', 'handoff', 'expired', 'snoozed'].includes(cc.state)) {
    await admin.from('booking_conversations').update({ processing_until: null }).eq('id', c.id)
    return json({ ok: true, skipped: `state_${cc.state}` })
  }

  // Der Anspruch MUSS auf jedem Rueckweg fallen — auch bei Vorschlag, Uebergabe oder
  // Fehler. Blieb er stehen, war das Gespraech bis zu 90 s taub (Lothar Huemmer, 4.9.).
  try {
    return await replyRunde(admin, cc, leadId, text)
  } finally {
    try { await admin.from('booking_conversations').update({ processing_until: null }).eq('id', c.id) } catch (e) { console.warn('[booking-bot] Anspruch nicht geloest:', e) }
  }
}

// Ein Gespraechszug. Laeuft immer unter dem Anspruch aus handleReply.
async function replyRunde(admin: SupabaseClient, c: ReplyConv, leadId: string, text: string): Promise<Response> {
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone, email').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null; email: string | null }
  const phone = l.whatsapp || l.phone || ''
  if (c.state === 'awaiting_cafe') return await cafeReply(admin, c, l, leadId, text)
  // KEIN logWa fuer inbound: der timelines-webhook hat die Nachricht bereits
  // geschrieben, und zwar mit whatsapp_message_id. Der zweite Schreiber hier liess
  // im Kundenverlauf jede eingehende Nachricht doppelt erscheinen und verfaelschte
  // die Zaehler, die per count auf activities.direction='inbound' gehen.

  const slots = c.proposed_slots ?? []
  // Die letzten Züge als echten Dialog mitgeben, chronologisch aufsteigend.
  let verlauf: Turn[] = []
  try {
    const { data: hist } = await admin.from('activities').select('direction, content, auto')
      .eq('lead_id', leadId).eq('type', 'whatsapp')
      .order('created_at', { ascending: false }).limit(7)
    // Von Hand geschriebene Nachrichten (auto=false) sind SVEN selbst, nicht der
    // Bot. Ohne die Kennzeichnung las der Bot Svens "Den mache ich frei" als
    // eigene Zeile und schlug munter weiter Alternativen vor (Roni, 22.8.).
    verlauf = ((hist ?? []) as Array<{ direction: string; content: string | null; auto: boolean | null }>)
      .filter(h => (h.content ?? '').trim())
      .reverse()
      .map(h => ({
        role: h.direction === 'outbound' ? 'assistant' as const : 'user' as const,
        content: (h.direction === 'outbound' && h.auto === false ? '[Sven persönlich] ' : '') + (h.content ?? '').slice(0, 700),
      }))
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
    // Feste Antwortregeln zuerst (Sven 30.10.2026): Angebotsanfrage, Bauträger, andere
    // Region, Geld. Danach übernimmt Sven, das Gespräch geht auf handoff.
    if (await regelnAn(admin)) {
      const r = await lotteRegel(admin, leadId, first(l.first_name) || null, text, verlauf, true)
      if (r) {
        const m = r.antwort ?? `Danke dir${l.first_name ? `, ${l.first_name}` : ''}! Das gebe ich direkt an Sven weiter, er meldet sich gleich persönlich bei dir. 🙂`
        if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
        await regelNotiz(admin, leadId, r, m)
        await setConv(admin, c.id, { state: 'handoff', last_message: m })
        return json({ ok: true, handled: `regel_${r.regel}` })
      }
    }
    // Erst versuchen, die Sachfrage aus den CRM-Fakten zu beantworten (Sven 29.10.).
    const fa = await faktenAntwort(admin, leadId, first(l.first_name) || null, text, verlauf)
    if (fa.ok) {
      if (!await say(fa.antwort)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
      await faktenNotiz(admin, leadId, text, fa.antwort, fa.alles ? '' : fa.offen)
      await setConv(admin, c.id, fa.alles ? { attempts: 0 } : { state: 'handoff', last_message: fa.antwort })
      return json({ ok: true, handled: fa.alles ? 'fakten_beantwortet' : 'fakten_teilweise' })
    }
    const m = `Danke dir${l.first_name ? `, ${l.first_name}` : ''}! Das gebe ich direkt an Sven weiter, er meldet sich gleich persönlich bei dir. 🙂`
    if (!await say(m)) return json({ ok: true, handled: 'wiederholung_uebergeben' })
    await setConv(admin, c.id, { state: 'handoff', last_message: m })
    return json({ ok: true, handled: 'content_handoff' })
  }

  // Fachliche Fragen ZUSAMMEN mit einem Terminwunsch (z.B. „diverse Fragen … und Termin
  // am 22.7. abends"): die fachlichen Themen an Sven verweisen (Kunde + Notiz für Sven),
  // den Terminwunsch aber ganz normal weiterverarbeiten — statt alles zu blockieren.
  if ((it.intent === 'content' || it.defer_to_sven) && hasApptSignal) {
    const m = `Deine inhaltlichen Fragen gebe ich direkt an Sven weiter, er meldet sich dazu zeitnah persönlich. 🙂`
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

  // Gewählter Slot inzwischen vorbei oder vergeben (slotStillOk)? Dann NICHT buchen,
  // sondern mit dem bestehenden Wortlaut aus proposeSlots neu anbieten; ist nichts
  // frei, übernimmt Sven (handoff).
  const slotGone = async (): Promise<Response> => {
    const alt = await computeSlots(admin, 2)
    if (alt.length >= 2) return await sendChoice(admin, c.id, phone, leadId, alt, 'Da hab ich leider nichts frei. Wie wäre stattdessen:')
    await handoff(admin, c.id, phone, leadId, l.first_name)
    return json({ ok: true, handled: 'slot_weg_uebergeben' })
  }

  // ── Zustandsmaschine ──
  if (c.state === 'awaiting_choice') {
    if (it.intent === 'pick_slot' && it.pick_index != null && slots[it.pick_index]) {
      if (await slotStillOk(admin, slots[it.pick_index]) !== 'ok') return await slotGone()
      await askType(admin, c.id, phone, leadId, l.first_name, slots[it.pick_index]); return await done()
    }
    if (it.intent === 'indifferent' && slots[0]) {
      // „Egal / such du aus" → ersten Vorschlag nehmen und weiter zur Terminart
      if (await slotStillOk(admin, slots[0]) !== 'ok') return await slotGone()
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
      if (await slotStillOk(admin, c.chosen_slot) !== 'ok') return await slotGone()
      await book(admin, c, l, c.chosen_slot, it.meeting_type); return json({ ok: true, handled: 'booked' })
    }
    // Der Slot steht bereits — hier wird NIE aufgegeben (Raffi-Fall: „Egal" führte
    // zu handoff statt Buchung). Keine Präferenz oder zweite unklare Antwort →
    // unkompliziertester Standard: WhatsApp-Call.
    if (c.chosen_slot && (it.intent === 'indifferent' || (c.attempts ?? 0) >= 1)) {
      if (await slotStillOk(admin, c.chosen_slot) !== 'ok') return await slotGone()
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
      if (await slotStillOk(admin, c.chosen_slot) !== 'ok') return await slotGone()
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
  if (await recentlyAcqMessaged(admin, leadId)) return json({ ok: true, skipped: 'recent_acquisition_wa' })
  // Ist es überhaupt ein (Remote-)Terminwunsch? Vor-Ort-Termine (Viewing/Besichtigung)
  // macht Sven selbst — da klinkt sich der Bot NICHT ein. Fachliches bleibt bei Sven.
  const det = await detectApptRequest(text)
  if (!det.wants && !force) return await handleAnswer(admin, leadId, text)   // vielleicht eine Sachfrage
  if (det.onsite && det.casual && !force) return await cafeStart(admin, leadId, det, text)
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

// ── Café-Treffen ─────────────────────────────────────────────────────────────
// Sven (29.10.2026): Wer ihn einfach kennenlernen will, ohne ein bestimmtes Objekt
// zu besichtigen, kann sich montags bis freitags von 10 bis 12 Uhr im Café Cultivos
// in der Innenstadt von Paphos zu ihm setzen. Lotte bietet das an und trägt auf ein
// Ja direkt ein. Bestandskunden und Leute mitten im Kauf führt Sven selbst (Micha).
const CAFE_NAME = 'Café Cultivos'
const CAFE_LOCATION = 'Café Cultivos, Paphos'   // Kennung der Café-Termine in crm_appointments.location
const CAFE_LINK = 'maps.app.goo.gl/w6ab7dsqMx5WvZwb7'
const CAFE_MIN = 60
const CAFE_NICHT_PHASEN = ['kontakt_uebergeben', 'registrierung', 'reservierung', 'anzahlung', 'kaufvertrag', 'provision_erhalten']
const CY = 'Asia/Nicosia'

// Zypern liegt das ganze Jahr eine Stunde vor Berlin (gleiche EU-Sommerzeit-Regel),
// 10:00 Zypern ist also 09:00 Berlin.
function cafeSlotFor(y: number, mo: number, d: number): Slot {
  const start = berlinToUtc(y, mo, d, 9, 0)
  const label = new Intl.DateTimeFormat('de-DE', { timeZone: CY, weekday: 'long', day: 'numeric', month: 'numeric' }).format(start)
  return { startIso: start.toISOString(), endIso: new Date(start.getTime() + CAFE_MIN * 60000).toISOString(), label }
}

// Sitzt Sven an diesem Tag im Café? Belegt ist das Fenster 10-12 nur durch ANDERE
// Termine. Café-Termine blockieren nicht, an Svens Tisch passen mehrere.
async function cafeFrei(admin: SupabaseClient, slot: Slot): Promise<boolean> {
  const st = new Date(slot.startIso).getTime(), en = st + 2 * 3600e3
  if (st <= Date.now()) return false
  const busy = await getBusy(admin, new Date(st), new Date(en))
  const { data: cafe } = await admin.from('crm_appointments').select('start_time, end_time')
    .eq('location', CAFE_LOCATION).lt('start_time', new Date(en).toISOString()).gt('end_time', new Date(st).toISOString())
  const eigene = ((cafe ?? []) as { start_time: string; end_time: string }[])
    .map(a => ({ s: new Date(a.start_time).getTime(), e: new Date(a.end_time).getTime() }))
  return !busy.some(b => st < b.end && en > b.start && !eigene.some(x => b.start >= x.s && b.end <= x.e))
}

// Nächster Werktag ab morgen, an dem Sven im Café sitzt, optional nach Kundenwunsch.
async function naechsterCafeTag(admin: SupabaseClient, wunsch: { onDate?: string | null; dayHint?: string | null; afterDate?: string | null }): Promise<Slot | null> {
  for (let off = 1; off <= 21; off++) {
    const [y, mo, d] = new Date(Date.now() + off * 86400e3).toLocaleDateString('en-CA', { timeZone: CY }).split('-').map(Number)
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
    if (wd === 0 || wd === 6) continue
    if (wunsch.onDate && iso !== wunsch.onDate) continue
    if (wunsch.afterDate && iso < wunsch.afterDate) continue
    if (wunsch.dayHint && !matchesDayHint(wd, off, wunsch.dayHint)) continue
    const slot = cafeSlotFor(y, mo, d)
    if (await cafeFrei(admin, slot)) return slot
  }
  return null
}

const mehrere = (t: string) => /\b(wir|uns|unser|unsere)\b/i.test(t)

async function cafeStart(admin: SupabaseClient, leadId: string, det: ApptReq, text: string): Promise<Response> {
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone, profile_id').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null; profile_id: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })
  if (l.profile_id) return json({ ok: true, skipped: 'cafe_bestandskunde' })
  const { data: laufend } = await admin.from('deals').select('id').eq('lead_id', leadId).in('phase', CAFE_NICHT_PHASEN).limit(1)
  if (laufend && laufend.length) return json({ ok: true, skipped: 'cafe_laufender_kauf' })

  const hatWunsch = !!(det.on_date || det.day_hint || det.after_date)
  let slot = await naechsterCafeTag(admin, { onDate: det.on_date, dayHint: det.day_hint, afterDate: det.after_date })
  const ausweich = !slot && hatWunsch
  if (!slot && hatWunsch) slot = await naechsterCafeTag(admin, {})
  if (!slot) return json({ ok: true, skipped: 'cafe_kein_tag' })   // bleibt im Posteingang bei Sven

  const ihr = mehrere(text)
  const name = first(l.first_name)
  const msg = `Hallo${name ? ` ${name}` : ''} 🐾 Ich bin Lotte, Svens persönliche Assistentin. Schön, dass ${ihr ? 'ihr' : 'du'} Sven kennenlernen ${ihr ? 'wollt' : 'willst'}!\n\n`
    + `Sven sitzt montags bis freitags von 10 bis 12 Uhr im ${CAFE_NAME} in der Innenstadt von Paphos. Da ${ihr ? 'könnt ihr euch' : 'kannst du dich'} einfach zu ihm setzen:\n${CAFE_LINK}\n\n`
    + (ausweich ? 'Am gewünschten Tag ist Sven leider nicht dort. ' : '')
    + `Soll ich ${ihr ? 'euch' : 'dich'} für ${slot.label}, um 10 Uhr eintragen?`
  await admin.from('booking_conversations').insert({
    lead_id: leadId, source: 'cafe', state: 'awaiting_cafe', proposed_slots: [slot], last_message: msg,
    meeting_type: ihr ? 'cafe_ihr' : 'cafe_du',
    expires_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString(),
  })
  const id = await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound', id)
  await cafeNachfassPlanen(admin, leadId, null)
  return json({ ok: true, cafe: slot.label })
}

// Antwort auf das Café-Angebot verstehen. Bewusst schmal: Ja, anderer Tag, Nein,
// alles andere geht an Sven.
async function cafeIntent(text: string, angebot: string, verlauf: Turn[]): Promise<{ intent: 'ja' | 'anderer_tag' | 'nein' | 'sonst'; on_date: string | null; day_hint: string | null }> {
  const off = { intent: 'sonst' as const, on_date: null, day_hint: null }
  const key = Deno.env.get('ANTHROPIC_API_KEY'); if (!key) return off
  const heute = new Date().toLocaleDateString('en-CA', { timeZone: CY })
  const wdHeute = new Intl.DateTimeFormat('de-DE', { timeZone: CY, weekday: 'long' }).format(new Date())
  const sys = `Lotte (Svens Assistentin) hat angeboten, den Kunden für ${angebot}, 10 Uhr, im Café in Paphos einzutragen, wo Sven montags bis freitags 10-12 Uhr sitzt. HEUTE: ${wdHeute}, ${heute}.
Ordne die Antwort des Kunden ein:
- ja: Zusage zu genau diesem Tag ("ja", "klingt gut", "machen wir", "perfekt", "bis dann").
- anderer_tag: will kommen, aber an einem anderen Tag. Fülle on_date (YYYY-MM-DD) bei einem klaren Datum, sonst day_hint (z. B. "dienstag").
- nein: will nicht / kein Treffen.
- sonst: Fragen, andere Uhrzeit, Unklares, alles andere. Im Zweifel sonst.
Gib NUR das Tool emit zurück.`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 150, system: sys,
        messages: [...verlauf, { role: 'user', content: text }],
        tool_choice: { type: 'tool', name: 'emit' },
        tools: [{ name: 'emit', description: 'Antwort einordnen', input_schema: { type: 'object', properties: {
          intent: { type: 'string', enum: ['ja', 'anderer_tag', 'nein', 'sonst'] },
          on_date: { type: ['string', 'null'] }, day_hint: { type: ['string', 'null'] },
        }, required: ['intent'] } }],
      }),
    })
    const d = await res.json() as { content?: { type: string; input?: { intent: 'ja' | 'anderer_tag' | 'nein' | 'sonst'; on_date?: string | null; day_hint?: string | null } }[] }
    const t = d.content?.find(c => c.type === 'tool_use')?.input
    return t ? { intent: t.intent, on_date: t.on_date ?? null, day_hint: t.day_hint ?? null } : off
  } catch (e) { console.warn('[booking-bot] cafeIntent:', e); return off }
}

async function cafeAnSven(admin: SupabaseClient, convId: string, phone: string, leadId: string, name: string | null, grund: string): Promise<Response> {
  const msg = `Danke dir${first(name) ? `, ${first(name)}` : ''}! Das gebe ich direkt an Sven weiter, er meldet sich persönlich bei dir. 🙂`
  await setConv(admin, convId, { state: 'handoff', last_message: msg })
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
  try { await admin.from('activities').insert({ lead_id: leadId, type: 'note', direction: 'inbound', subject: '⚠️ Lotte: Café-Treffen an Sven', content: grund, completed_at: new Date().toISOString() }) } catch { /* egal */ }
  return json({ ok: true, handled: 'cafe_handoff' })
}

async function cafeReply(admin: SupabaseClient, c: ReplyConv, l: { first_name: string | null; whatsapp: string | null; phone: string | null }, leadId: string, text: string): Promise<Response> {
  const phone = l.whatsapp || l.phone || ''
  const slot = (c.proposed_slots ?? [])[0]
  const { data: mt } = await admin.from('booking_conversations').select('meeting_type').eq('id', c.id).maybeSingle()
  const ihr = (mt as { meeting_type?: string } | null)?.meeting_type === 'cafe_ihr'
  if (!slot) return await cafeAnSven(admin, c.id, phone, leadId, l.first_name, 'Café-Gespräch ohne Tag. Bitte selbst klären.')
  const { data: hist } = await admin.from('activities').select('direction, content')
    .eq('lead_id', leadId).eq('type', 'whatsapp').order('created_at', { ascending: false }).limit(4)
  const verlauf: Turn[] = ((hist ?? []) as { direction: string; content: string | null }[])
    .filter(h => (h.content ?? '').trim()).reverse()
    .map(h => ({ role: h.direction === 'outbound' ? 'assistant' as const : 'user' as const, content: (h.content ?? '').slice(0, 700) }))
  while (verlauf.length && verlauf[verlauf.length - 1].role === 'user') verlauf.pop()
  while (verlauf.length && verlauf[0].role === 'assistant') verlauf.shift()
  const it = await cafeIntent(text, slot.label, verlauf)

  if (it.intent === 'ja') return await cafeJa(admin, c, l, leadId, slot, ihr)
  if (it.intent === 'anderer_tag' && (c.attempts ?? 0) < 2) {
    const neu = await naechsterCafeTag(admin, { onDate: it.on_date, dayHint: it.day_hint })
    if (!neu) return await cafeAnSven(admin, c.id, phone, leadId, l.first_name, `Kunde möchte an einem anderen Tag ins Café (${it.on_date ?? it.day_hint ?? text.slice(0, 80)}), da sitzt Sven nicht dort oder ist belegt. Bitte selbst klären.`)
    return await cafeNeuerTag(admin, c, phone, leadId, neu, ihr, '')
  }
  if (it.intent === 'nein') {
    const msg = `Alles klar, kein Problem! Wenn ${ihr ? 'ihr' : 'du'} doch noch Lust ${ihr ? 'habt' : 'hast'}: Sven sitzt montags bis freitags von 10 bis 12 Uhr im ${CAFE_NAME}. 🙂`
    await setConv(admin, c.id, { state: 'handoff', last_message: msg })
    await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
    return json({ ok: true, handled: 'cafe_nein' })
  }
  return await cafeAnSven(admin, c.id, phone, leadId, l.first_name, `Antwort auf das Café-Angebot (${slot.label}): „${text.slice(0, 300)}". Bitte persönlich antworten.`)
}

async function cafeNeuerTag(admin: SupabaseClient, c: ReplyConv, phone: string, leadId: string, slot: Slot, ihr: boolean, vorweg: string): Promise<Response> {
  const msg = `${vorweg}Dann trage ich ${ihr ? 'euch' : 'dich'} gern für ${slot.label}, um 10 Uhr im ${CAFE_NAME} ein. Passt das?`
  await setConv(admin, c.id, { proposed_slots: [slot], attempts: (c.attempts ?? 0) + 1, last_message: msg })
  const id = await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound', id)
  await cafeNachfassPlanen(admin, leadId, c.deal_id)
  return json({ ok: true, handled: 'cafe_neuer_tag', slot: slot.label })
}

// Zusage zum angebotenen Tag, per Text (cafeReply) oder Reaktion (cafeReaktion).
// Ist der Tag nicht mehr frei, bietet Lotte den nächsten an. "Belegt" schreibt sie
// nur, wenn er wirklich belegt ist. Ein spätes Ja nach 10 Uhr am selben Tag heißt
// nur: zu spät (Sven sitzt sonst noch bis 12 Uhr dort, belegt ist da nichts).
async function cafeJa(admin: SupabaseClient, c: ReplyConv, l: { first_name: string | null; whatsapp: string | null; phone: string | null }, leadId: string, slot: Slot, ihr: boolean): Promise<Response> {
  const phone = l.whatsapp || l.phone || ''
  if (await cafeFrei(admin, slot)) return await cafeBuchen(admin, c, l, leadId, slot, ihr)
  const vorbei = Date.parse(slot.startIso) <= Date.now()
  const neu = await naechsterCafeTag(admin, { afterDate: null })
  if (!neu) return await cafeAnSven(admin, c.id, phone, leadId, l.first_name, `Kunde hat zu ${slot.label} zugesagt, der Tag ist ${vorbei ? 'schon vorbei' : 'inzwischen belegt'}. Bitte selbst einen Tag ausmachen.`)
  return await cafeNeuerTag(admin, c, phone, leadId, neu, ihr, vorbei ? `Oh, für ${slot.label}, ist es jetzt leider zu spät. ` : `Oh, ${slot.label} ist leider inzwischen belegt. `)
}

// Reaktion auf Lottes Café-Nachricht. evolution-webhook reicht Reaktionen hierher,
// in den Verlauf kommen sie sonst nicht. Ein 👍 👌 ❤️ 🙏 auf Lottes LETZTE
// Café-Nachricht, nach der nichts mehr im Chat kam, ist ein Ja: eintragen und
// bestätigen. Alles andere bleibt ohne Folge, die Nachfrage läuft weiter und bittet
// um ein kurzes Ja. Nie still stornieren: Nach einem 👍 ohne Termin glaubt der
// Kunde sonst, er sei eingetragen.
const CAFE_JA_REAKTION = /^(?:\u{1F44D}|\u{1F44C}|\u{1F64F})[\u{1F3FB}-\u{1F3FF}]?$|^\u{2764}\u{FE0F}?$/u

async function cafeReaktion(admin: SupabaseClient, phone: string, emoji: string, ziel: string, uid: string | null): Promise<Response> {
  if (!ziel || !CAFE_JA_REAKTION.test(emoji.trim())) return json({ ok: true, skipped: 'reaktion_ohne_folge' })
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < 8) return json({ ok: true, skipped: 'no_phone' })
  const { data: rows } = await admin.rpc('find_leads_by_phone_suffix', { suffix: digits.slice(-8) })
  const ids = ((rows ?? []) as { id: string }[]).map(r => r.id)
  if (!ids.length) return json({ ok: true, skipped: 'kein_kontakt' })
  const { data: conv } = await admin.from('booking_conversations').select('*')
    .in('lead_id', ids).eq('state', 'awaiting_cafe').gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const c = conv as (ReplyConv & { meeting_type: string | null }) | null
  if (!c) return json({ ok: true, skipped: 'kein_cafe_angebot' })
  const { data: opt } = await admin.from('communication_optouts').select('id').eq('lead_id', c.lead_id).limit(1)
  if (opt && opt.length) return json({ ok: true, skipped: 'optout' })
  const { data: zuletzt } = await admin.from('activities').select('direction, auto, whatsapp_message_id')
    .eq('lead_id', c.lead_id).eq('type', 'whatsapp').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const z = zuletzt as { direction: string; auto: boolean | null; whatsapp_message_id: string | null } | null
  if (!z || z.direction !== 'outbound' || z.auto !== true || z.whatsapp_message_id !== ziel) return json({ ok: true, skipped: 'reaktion_nicht_auf_angebot' })
  // Anspruch wie in handleReply. Läuft gerade eine Textantwort, entscheidet die.
  const { data: claimed } = await admin.from('booking_conversations')
    .update({ processing_until: new Date(Date.now() + 90_000).toISOString() }).eq('id', c.id).eq('state', 'awaiting_cafe')
    .or(`processing_until.is.null,processing_until.lt.${new Date().toISOString()}`)
    .select('id').maybeSingle()
  if (!claimed) return json({ ok: true, skipped: 'wird_bereits_bearbeitet' })
  try {
    // In den Verlauf, damit Sven sieht, worauf Lotte gebucht hat.
    await admin.from('activities').insert({
      lead_id: c.lead_id, type: 'whatsapp', direction: 'inbound', subject: 'WhatsApp erhalten', content: `[Reaktion ${emoji.trim()}]`,
      completed_at: new Date().toISOString(), whatsapp_message_id: uid,
    })
    await admin.from('scheduled_messages').update({ status: 'cancelled', error_message: 'Kunde hat mit einer Reaktion zugesagt' })
      .eq('lead_id', c.lead_id).eq('status', 'pending').eq('event_type', 'bot_nudge').eq('bot_nudge_source', 'cafe')
    const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', c.lead_id).maybeSingle()
    const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
    const slot = (c.proposed_slots ?? [])[0]
    if (!l || !(l.whatsapp || l.phone)) return json({ ok: true, skipped: 'no_phone' })
    if (!slot) return await cafeAnSven(admin, c.id, l.whatsapp || l.phone || '', c.lead_id, l.first_name, `Kunde hat mit ${emoji.trim()} auf das Café-Angebot reagiert, im Gespräch steht aber kein Tag. Bitte selbst klären.`)
    return await mitSprache(admin, c.lead_id, '', () => cafeJa(admin, c, l, c.lead_id, slot, c.meeting_type === 'cafe_ihr'))
  } finally {
    try { await admin.from('booking_conversations').update({ processing_until: null }).eq('id', c.id) } catch (e) { console.warn('[booking-bot] Anspruch nicht geloest:', e) }
  }
}

// Nachfrage, wenn das Café-Angebot unbeantwortet bleibt (Sven 30.10.2026: „Wenn solche
// Leute nicht antworten, fix nachfassen.“ Sabine und Oliver sagten erst 16 Stunden
// später zu). Stufe 1 nach 3 Stunden, Stufe 2 nach einem Tag, Stufe 3 nach zwei
// Tagen. Ruhezeit in Zypern-Zeit, denn die Kunden sind in Paphos: Was zwischen 21 und
// 8 Uhr läge, rückt auf etwa 9 Uhr. Eine Kundenantwort storniert die offenen Stufen
// (waInbound).
const CAFE_NACHFASS_STUNDEN = [3, 24, 48]

async function cafeNachfassPlanen(admin: SupabaseClient, leadId: string, dealId: string | null): Promise<void> {
  try {
    await admin.from('scheduled_messages').update({ status: 'cancelled' })
      .eq('lead_id', leadId).eq('status', 'pending').eq('event_type', 'bot_nudge').eq('bot_nudge_source', 'cafe')
    const { error } = await admin.from('scheduled_messages').insert(CAFE_NACHFASS_STUNDEN.map((h, i) => {
      const t = new Date(Date.now() + h * 3600e3)
      return {
        lead_id: leadId, deal_id: dealId, type: 'whatsapp', event_type: 'bot_nudge',
        bot_nudge_stage: i + 1, bot_nudge_source: 'cafe', status: 'pending',
        scheduled_at: (ruhezeitZiel(t, t, CY) ?? t).toISOString(),
      }
    }))
    if (error) console.warn('[booking-bot] Café-Nachfrage planen:', error.message)
  } catch (e) { console.warn('[booking-bot] Café-Nachfrage planen:', e) }
}

async function cafeNachfass(admin: SupabaseClient, leadId: string, stage: number): Promise<Response> {
  const { data: conv } = await admin.from('booking_conversations').select('id, deal_id, state, proposed_slots, meeting_type')
    .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const c = conv as { id: string; deal_id: string | null; state: string; proposed_slots: Slot[] | null; meeting_type: string | null } | null
  if (!c || c.state !== 'awaiting_cafe') return json({ ok: true, skipped: 'engaged_or_closed' })
  // Nur wenn Lottes Angebot das Letzte im Chat ist. Hat der Kunde geantwortet (Text,
  // Foto, Sprach- oder Videonachricht) oder Sven selbst geschrieben, fragt sie nicht
  // nach. Reaktionen und Sticker kommen nicht in den Verlauf: Ein 👍 auf Lottes
  // Café-Nachricht bucht cafeReaktion, alles andere ändert nichts, dann fragt sie nach.
  const { data: zuletzt } = await admin.from('activities').select('direction, auto, created_at')
    .eq('lead_id', leadId).eq('type', 'whatsapp').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const z = zuletzt as { direction: string; auto: boolean | null; created_at: string } | null
  if (!z || z.direction !== 'outbound' || z.auto !== true) return json({ ok: true, skipped: 'engaged' })
  if (Date.now() - Date.parse(z.created_at) < 3600e3) return json({ ok: true, skipped: 'recent_acquisition_wa' })
  // Noch einmal die Ruhezeit in Zypern-Zeit: process-scheduled-messages rechnet nach
  // der Heimatvorwahl und ließe bei +49 bis 21:59, bei +44 bis 22:59 Ortszeit durch.
  const morgens = ruhezeitZiel(new Date(), new Date(), CY)
  if (morgens) {
    const { error } = await admin.from('scheduled_messages').insert({
      lead_id: leadId, deal_id: c.deal_id, type: 'whatsapp', event_type: 'bot_nudge',
      bot_nudge_stage: stage, bot_nudge_source: 'cafe', status: 'pending', scheduled_at: morgens.toISOString(),
    })
    if (error) console.warn('[booking-bot] Café-Nachfrage verschieben:', error.message)
    return json({ ok: true, skipped: 'ruhezeit_zypern' })
  }
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })
  // Angebotener Tag vorbei, zu knapp oder inzwischen belegt: dann der nächste freie.
  let slot: Slot | null = (c.proposed_slots ?? [])[0] ?? null
  const neuerTag = !slot || Date.parse(slot.startIso) - Date.now() < 3 * 3600e3 || !(await cafeFrei(admin, slot))
  if (neuerTag) slot = await naechsterCafeTag(admin, {})
  if (!slot) return json({ ok: true, skipped: 'cafe_kein_tag' })
  const ihr = c.meeting_type === 'cafe_ihr'
  const name = first(l.first_name)
  const hallo = `Hallo${name ? ` ${name}` : ''} 🐾`
  // Jede Stufe erkennbar anders: kurze Nachfrage, kurze Erinnerung, ein letztes Mal.
  // Auch bei einem neuen Tag bleibt der Einstieg der Stufe.
  const einstieg = stage >= 3 ? 'Ich frag ein letztes Mal nach' : stage === 2 ? 'Lotte hier, kurze Erinnerung' : 'Lotte hier, kurze Nachfrage'
  const frage = neuerTag
    ? `${ihr ? 'Habt ihr' : 'Hast du'} noch Lust auf einen Kaffee mit Sven? Am ${slot.label}, sitzt er von 10 bis 12 Uhr im ${CAFE_NAME}. Soll ich ${ihr ? 'euch' : 'dich'} dafür eintragen?`
    : `Soll ich ${ihr ? 'euch' : 'dich'} für ${slot.label}, um 10 Uhr im ${CAFE_NAME} eintragen?`
  const schluss = stage >= 3 ? 'Sven würde sich freuen!'
    : stage === 2 ? 'Ein kurzes Ja reicht.'
    : neuerTag ? '' : `Ein kurzes Ja reicht. Passt ein anderer Tag besser, ${ihr ? 'schreibt' : 'schreib'} mir einfach, welcher.`
  const msg = `${hallo} ${einstieg}: ${frage}${schluss ? ` ${schluss}` : ''}`
  // Erst senden, dann das Gespräch umstellen: Schlägt der Versand fehl, bleibt der
  // alte Tag stehen, und ein "Ja" des Kunden gilt weiter für das, was er gesehen hat.
  const id = await sendWa(phone, msg)
  await setConv(admin, c.id, { proposed_slots: [slot], last_message: msg, expires_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString() })
  await logWa(admin, leadId, msg, 'outbound', id)
  return json({ ok: true, nudged: stage, source: 'cafe', slot: slot.label })
}

async function cafeBuchen(admin: SupabaseClient, c: ReplyConv, l: { first_name: string | null; whatsapp: string | null; phone: string | null }, leadId: string, slot: Slot, ihr: boolean): Promise<Response> {
  const phone = l.whatsapp || l.phone || ''
  const name = first(l.first_name)
  const title = await nextApptTitle(admin, leadId, name || 'Lead', slot.startIso)
  const cal = await createCalendarEvent(admin, {
    title: `${title} (${CAFE_NAME})`, startIso: slot.startIso, endIso: slot.endIso,
    description: `Lockeres Kennenlernen im ${CAFE_NAME}, Innenstadt Paphos.\nVon Lotte per WhatsApp vereinbart.\nKunde: ${name}${phone ? `\nTelefon: ${phone}` : ''}\nMaps: https://${CAFE_LINK}`,
  })
  const { error } = await admin.from('crm_appointments').insert({
    title, type: 'inperson', start_time: slot.startIso, end_time: slot.endIso,
    lead_id: leadId, deal_id: c.deal_id, location: CAFE_LOCATION, timezone: CY,
    phone_number: phone || null,
    google_event_id: cal?.id ?? null, google_calendar_id: cal?.calId ?? null,
    description: 'Café-Treffen, von Lotte per WhatsApp gebucht',
  })
  if (error) {
    console.error('[booking-bot] Café-Termin fehlgeschlagen:', error.message)
    return await cafeAnSven(admin, c.id, phone, leadId, l.first_name, `Café-Termin ${slot.label} 10 Uhr konnte nicht gespeichert werden (${error.message}). Kunde hat zugesagt, bitte manuell eintragen und bestätigen.`)
  }
  void notifyIfToday(admin, [slot.startIso], `📅 Café-Treffen HEUTE um 10:00\n\n${name || 'Kunde'}${phone ? `\n${phone}` : ''}\n${CAFE_NAME}\n\n(von Lotte gebucht)`)
  const msg = `Super, ist eingetragen ✅\n\n${slot.label}, 10 Uhr (Zypern-Zeit)\n${CAFE_NAME}, Innenstadt Paphos\n${CAFE_LINK}\n\nSven freut sich auf ${ihr ? 'euch' : 'dich'}!`
  await setConv(admin, c.id, { state: 'booked', meeting_type: 'inperson', chosen_slot: slot, last_message: msg })
  await sendWa(phone, msg); await logWa(admin, leadId, msg, 'outbound')
  return json({ ok: true, handled: 'cafe_gebucht', slot: slot.label })
}

// Nachricht von einer Nummer ohne Kontakt (Sabine und Oliver, 29.10.2026). Nur bei
// einem klaren Café-Wunsch legt Lotte den Kontakt an, sonst bleibt die Nachricht
// im Posteingang bei Sven.
async function handleEngageUnknown(admin: SupabaseClient, rawPhone: string, pushName: string | null, text: string): Promise<Response> {
  const { data: sset } = await admin.from('crm_settings').select('key, value').in('key', ['booking_bot_enabled', 'booking_bot_auto_engage'])
  const sv = new Map(((sset ?? []) as { key: string; value: string }[]).map(s => [s.key, s.value]))
  if (sv.get('booking_bot_enabled') !== 'true' || sv.get('booking_bot_auto_engage') !== 'true') return json({ ok: true, skipped: 'disabled' })
  const digits = String(rawPhone).replace(/\D/g, '')
  if (digits.length < 8) return json({ ok: true, skipped: 'no_phone' })
  const det = await detectApptRequest(text)
  if (!(det.wants && det.onsite && det.casual)) return json({ ok: true, skipped: 'unknown_kein_cafe' })
  // Inzwischen doch ein Kontakt (zweite Nachricht, Sven hat angelegt)? Dann normaler Weg.
  const { data: rows } = await admin.rpc('find_leads_by_phone_suffix', { suffix: digits.slice(-8) })
  const vorhanden = ((rows ?? []) as { id: string }[])[0]
  if (vorhanden) return await handleEngage(admin, vorhanden.id, text)

  const teile = (pushName ?? '').trim().split(/\s+/).filter(Boolean)
  const { data: nl, error } = await admin.from('leads').insert({
    first_name: teile[0] ?? 'WhatsApp', last_name: teile.slice(1).join(' '), email: '',
    phone: '+' + digits, whatsapp: '+' + digits, source: 'whatsapp', language: 'de',
  }).select('id').single()
  if (error || !nl) { console.error('[booking-bot] Kontakt anlegen fehlgeschlagen:', error?.message); return json({ ok: false, error: error?.message }, 500) }
  const leadId = (nl as { id: string }).id

  // Bisherige Nachrichten dieser Nummer in den Kundenverlauf übernehmen.
  const { data: alt } = await admin.from('wa_unknown_messages').select('direction, content, created_at, whatsapp_message_id, read_at')
    .eq('phone', '+' + digits).order('created_at').limit(200)
  const altRows = (alt ?? []) as { direction: string; content: string; created_at: string; whatsapp_message_id: string | null; read_at: string | null }[]
  if (altRows.length) {
    const { error: mvErr } = await admin.from('activities').insert(altRows.map(m => ({
      lead_id: leadId, type: 'whatsapp', direction: m.direction, auto: false,
      subject: m.direction === 'inbound' ? 'WhatsApp erhalten' : 'WhatsApp gesendet', content: m.content,
      created_at: m.created_at, completed_at: m.created_at, whatsapp_message_id: m.whatsapp_message_id, read_at: m.read_at,
    })))
    if (!mvErr) await admin.from('wa_unknown_messages').delete().eq('phone', '+' + digits)
    else console.warn('[booking-bot] Verlauf übernehmen:', mvErr.message)
  }
  try { await admin.from('activities').insert({ lead_id: leadId, type: 'note', direction: 'inbound', subject: 'Kontakt von Lotte angelegt', content: `Neue Nummer per WhatsApp (${pushName ?? 'ohne Namen'}), möchte Sven persönlich kennenlernen. Lotte bietet das Café an.`, completed_at: new Date().toISOString() }) } catch { /* egal */ }
  return await cafeStart(admin, leadId, det, text)
}

// ── Fakten-Antworten ──────────────────────────────────────────────────────────
// Sven (29.10.2026): Lotte darf Sachfragen selbst beantworten, aber NUR, wenn der
// Fakt klar im CRM steht. Und nicht nüchtern: „sehr wohlwollend, wir wollen
// verkaufen". Grundlage sind die Projektdaten und das Angebot, das der Kunde
// bekommen hat (sales_decks.content), also genau das, was er schon kennt.
// Preise und freie Wohnungen nennt Lotte nur live aus dem CRM (Sven 30.10.: „Alles,
// was sicher aus dem CRM kommt, darf geschrieben werden"). Rendite, Steuer,
// Finanzierung und Recht beantwortet sie nicht selbst, das ist Svens Sache.
const FAKT_NICHT_PHASEN = CAFE_NICHT_PHASEN

// Nur die lesbaren Texte aus dem Angebot, ohne Bild-URLs und technische Felder.
function deckTexte(content: unknown, max = 7000): string {
  const out: string[] = []
  const skip = /^(image|images|img|src|url|mapUrl|video|videoUrl|poster|imageIntent|type|id|token|mapLat|mapLng)$/i
  const walk = (v: unknown, k = '') => {
    if (out.join('\n').length > max) return
    if (typeof v === 'string') {
      const s = v.trim()
      if (s && !skip.test(k) && !/^https?:\/\//.test(s) && s.length > 2) out.push(k ? `${k}: ${s}` : s)
    } else if (Array.isArray(v)) v.forEach(x => walk(x, k))
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) if (!skip.test(kk)) walk(vv, kk)
  }
  walk(content)
  return [...new Set(out)].join('\n').slice(0, max)
}

// namen = Projekt- und Bauträgernamen, die Lotte nennen darf; verboten = alles, woran
// man ein Projekt ohne Registrierung erkennt (Sven 30.10.2026: Namen erst, wenn die
// Registrierung beim Bauträger raus ist). Verbotene Namen stehen gar nicht erst in den
// Fakten, und eine Antwort, die trotzdem einen nennt, geht nicht raus.
async function faktenBlock(admin: SupabaseClient, leadId: string): Promise<{ text: string; deckLink: string | null; namen: string[]; verboten: string[]; betraege: string[] } | null> {
  const { data: decks } = await admin.from('sales_decks').select('token, project_id, content, created_at')
    .eq('lead_id', leadId).order('created_at', { ascending: false }).limit(3)
  const ds = (decks ?? []) as { token: string; project_id: string | null; content: unknown }[]
  const pids = [...new Set(ds.map(d => d.project_id).filter((x): x is string => !!x))].slice(0, 2)
  if (!pids.length) return null
  const { data: projs } = await admin.from('crm_projects')
    .select('id, name, developer, location, location_district, maps_url, google_maps_url, description_de, completion_date, completion_months, payment_schedule, equipment_list, poi_distances, furniture_included')
    .in('id', pids)
  const registrierte = await registrierteBautraeger(admin, leadId)
  const { data: units } = await admin.from('crm_project_units').select('project_id, type').in('project_id', pids).limit(1000)
  const frei = await freieWohnungen(admin, pids)
  const teile: string[] = []
  const namen: string[] = [], verboten: string[] = [], betraege: string[] = []
  for (const p of (projs ?? []) as Record<string, unknown>[]) {
    const deck = ds.find(d => d.project_id === p.id)
    const dev = (p.developer as string | null) ?? null
    const offen = istRegistriert(dev, registrierte)
    const geheim = offen ? [] : [...namensTeile(p.name as string), ...bautraegerTeile(dev)]
    const typ = objektTyp(((units ?? []) as { project_id: string; type: string | null }[]).filter(u => u.project_id === p.id).map(u => u.type))
    const ersatz = `${typ} ${lageLabel(p.location as string | null, p.location_district as string | null)}`
    const neutral = (s: string) => geheim.length ? namenErsetzen(s, geheim, ersatz) : s
    const karte = (p.google_maps_url || p.maps_url || '') as string
    const liste = preisListe(frei.filter(u => u.project_id === p.id).map((u): EinheitFrei => ({
      nummer: u.unit_number, typ: u.type, schlafzimmer: u.bedrooms, flaeche: u.size_sqm == null ? null : Number(u.size_sqm), preis: Number(u.price_net),
    })))
    const plan = Array.isArray(p.payment_schedule) && p.payment_schedule.length ? JSON.stringify(p.payment_schedule) : ''
    // Nur diese Beträge darf Lotte nennen: Live-Preise und Zahlungsplan, nie der
    // Angebotstext. Aus dem Plan nur Zahlen ab 1.000, sonst ginge "1 Mio. €" als 1 durch.
    betraege.push(...betraegeIn(liste), ...zahlenIn(plan).filter(z => z.length >= 4))
    const zeilen = [
      offen ? `PROJEKT: ${p.name}${dev ? ` (Bauträger: ${bautraegerAnzeige(dev)})` : ''}` : `PROJEKT: ${ersatz} (Projekt- und Bauträgername vertraulich)`,
      p.location ? `Ort: ${neutral(`${p.location}${p.location_district ? `, ${p.location_district}` : ''}`)}` : '',
      karte && !enthaeltNamen(karte, geheim) ? `Google-Maps-Link (Lage): ${karte}` : '',
      p.description_de ? `Beschreibung: ${neutral(String(p.description_de))}` : '',
      p.completion_date ? `Fertigstellung: ${p.completion_date}` : (p.completion_months ? `Bauzeit: ca. ${p.completion_months} Monate` : ''),
      plan ? `Zahlungsplan: ${neutral(plan)}` : '',
      Array.isArray(p.poi_distances) && p.poi_distances.length ? `Entfernungen: ${neutral(JSON.stringify(p.poi_distances))}` : '',
      p.equipment_list ? `Ausstattung: ${neutral(String(p.equipment_list))}` : '',
      p.furniture_included === true ? 'Möbel: inklusive' : '',
      neutral(liste),
      deck ? `ANGEBOT DES KUNDEN (Link: portal.happy-property.com/deck/${deck.token}):\n${neutral(deckTexte(deck.content))}` : '',
    ].filter(Boolean)
    teile.push(zeilen.join('\n'))
    if (offen) namen.push(String(p.name), ...(dev ? [bautraegerAnzeige(dev)] : []))
    verboten.push(...geheim)
  }
  const link = ds[0]?.token ? `https://portal.happy-property.com/deck/${ds[0].token}` : null
  return teile.length ? { text: teile.join('\n\n---\n\n'), deckLink: link, namen, verboten, betraege } : null
}

type FaktAntwort = { ok: boolean; antwort: string; alles: boolean; offen: string }

async function faktenAntwort(admin: SupabaseClient, leadId: string, vorname: string | null, text: string, verlauf: Turn[]): Promise<FaktAntwort> {
  const nein: FaktAntwort = { ok: false, antwort: '', alles: false, offen: '' }
  const key = Deno.env.get('ANTHROPIC_API_KEY'); if (!key) return nein
  const fb = await faktenBlock(admin, leadId)
  if (!fb) return nein
  const sys = `Du bist Lotte, die persönliche Assistentin von Sven (Happy Property, Immobilien auf Zypern). Ein Interessent hat eine Frage per WhatsApp gestellt.

Beantworte NUR, was sich klar aus den FAKTEN unten ergibt. Widersprechen sich die Projekt-Angaben (oben je PROJEKT) und der Text im ANGEBOT DES KUNDEN, gilt die Projekt-Angabe: sie ist der aktuelle Stand im CRM (Beispiel: Projekt sagt "rund 800 m vom Meer", altes Angebot "rund 1 km" -> 800 m). Erfinde nichts: keine Zahl, keine Entfernung, keine Ausstattung, kein Meerblick, nichts, was dort nicht steht. Zahlen exakt so wie in den Fakten ("rund 1 km" bleibt "rund 1 km").

Ton: herzlich, begeistert, verkaufend. Hebe die Vorteile hervor und beschreibe die Fakten so positiv wie möglich ("nur rund 1 km bis zum Meer", "in wenigen Minuten am Strand", "ruhig und trotzdem nah an allem"). Positive Umschreibungen ohne neue Zahlen sind erwünscht, neue Zahlen nicht. Umschreibungen müssen zu den Zahlen passen: rund 800 m oder 1 km ist "ganz nah" oder "ein kurzer Weg", 3 bis 5 km sind "schnell erreichbar" oder "in wenigen Autominuten", nichts davon ist "direkt vor der Tür". Ortsbezeichnungen genau wie in den Fakten (ein Ort am Rand von Paphos ist kein Stadtteil). Keine Rangfolgen oder Superlative, die nicht in den Fakten stehen ("eine der begehrtesten Lagen", "die beste Anlage", "einmalig"): begeistert ja, aber nichts behaupten, was man nachprüfen könnte und was dort nicht steht.

Wenn nach der Lage gefragt wird: Google-Maps-Link aus den Fakten mitschicken und die Lage mit den schönsten Fakten beschreiben (Meer, Strand, Einkaufen, Hafen, Flughafen).

Projekt- und Bauträgernamen: ${fb.namen.length ? `Nennen darfst du nur ${[...new Set(fb.namen)].join(', ')}.` : 'Nenne keinen.'} Ein Projekt, das in den Fakten als vertraulich markiert ist, beschreibst du nur über Lage und Objekttyp (etwa "der Neubau in Chlorakas"), nie mit einem Namen.

Preise und freie Wohnungen nennst du NUR aus "PREISE UND FREIE WOHNUNGEN (live aus dem CRM)", Zahl für Zahl genau so wie dort, nie gerundet, nie ausgerechnet (keine Raten, Summen oder Quadratmeterpreise) und nie aus dem Angebot des Kunden oder der Beschreibung: die können veraltet sein. Steht eine Wohnung dort nicht, sagst du nichts zu ihrer Verfügbarkeit und gibst die Frage in "offen". Auf das Angebot verweisen (Link in den Fakten) darfst du zusätzlich.

NICHT selbst beantworten, sondern in "offen" an Sven geben: Rabatte, Rendite, Wertsteigerung, Mieteinnahmen, Steuern, Finanzierung, Recht/Verträge, Zahlungstermine eines Bestandskunden, Grundrisse/Lagepläne als Datei, persönliche Lage/Einwände, alles, was nicht in den Fakten steht.

Form: Du-Form, deutsch mit echten Umlauten, kein Gedankenstrich (weder — noch – noch ein Bindestrich mit Leerzeichen davor und danach), höchstens 5 kurze Sätze, gern 1-2 Emojis, keine Grußformel (wird angehängt), keine Vorstellung. Beginne mit "${vorname ? `Gern, ${vorname}!` : 'Gern!'}" oder ähnlich. Bleibt etwas offen, schließe mit einem Satz wie "Zu ... meldet sich Sven persönlich bei dir."

ok=false, wenn du KEINEN Teil der Frage sicher aus den Fakten beantworten kannst. alles=true nur, wenn wirklich nichts offen bleibt.

FAKTEN:
${fb.text}`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 700, system: sys,
        messages: [...verlauf, { role: 'user', content: text }],
        tool_choice: { type: 'tool', name: 'emit' },
        tools: [{ name: 'emit', description: 'Antwort an den Interessenten', input_schema: { type: 'object', properties: {
          ok: { type: 'boolean', description: 'mindestens ein Teil sicher aus den Fakten beantwortet' },
          antwort: { type: 'string', description: 'WhatsApp-Text an den Kunden' },
          alles: { type: 'boolean', description: 'nichts bleibt offen' },
          offen: { type: 'string', description: 'was Sven noch beantworten muss (leer wenn nichts)' },
        }, required: ['ok', 'antwort', 'alles', 'offen'] } }],
      }),
    })
    const d = await res.json() as { content?: { type: string; input?: FaktAntwort }[] }
    const t = d.content?.find(c => c.type === 'tool_use')?.input
    if (!t || !t.ok || !t.antwort?.trim()) return nein
    // Harte Sperren nach der KI: keine Gedankenstriche, keine Rendite-/Steuerzahlen.
    const antwort = t.antwort.replace(/\s*[—–]\s*/g, ', ').replace(/([\p{L}\p{N}])\s+-\s+(\p{Ll})/gu, '$1, $2').trim()
    if (/rendite|wertsteigerung|\+\s?\d+\s?%|steuer.{0,20}\d/i.test(antwort)) return { ...nein, offen: text }
    // Kein Name vor der Registrierung, keine Beträge zu Provision, Nachlass & Co.
    if (enthaeltNamen(antwort, fb.verboten) || geldMitZahl(antwort)) return { ...nein, offen: text }
    // Beträge nur, wenn sie sicher aus dem CRM kommen (Sven 30.10.): Live-Preisliste oder Zahlungsplan.
    if (fremdeBetraege(antwort, fb.betraege).length) return { ...nein, offen: text }
    return { ok: true, antwort, alles: !!t.alles, offen: (t.offen ?? '').trim() }
  } catch (e) { console.warn('[booking-bot] faktenAntwort:', e); return nein }
}

async function faktenNotiz(admin: SupabaseClient, leadId: string, frage: string, antwort: string, offen: string): Promise<void> {
  try {
    await admin.from('activities').insert({
      lead_id: leadId, type: 'note', direction: 'inbound',
      subject: offen ? '⚠️ Lotte hat teilweise geantwortet, Rest an Sven' : 'Lotte hat eine Sachfrage beantwortet',
      content: `Frage: ${frage.slice(0, 600)}\n\nLotte: ${antwort.slice(0, 1200)}${sprachePerLead.get(leadId) === 'en' ? ` ${UEBERSETZT}` : ''}${offen ? `\n\nOffen für Sven: ${offen.slice(0, 600)}` : ''}`,
      completed_at: new Date().toISOString(),
    })
  } catch { /* egal */ }
}

// ── Feste Antwortregeln (Sven 30.10.2026, Texte in _shared/lotteRegeln.ts) ────
// Angebotsanfrage, Bauträger-Frage, andere Region, Geld. Die KI ordnet nur ein, die
// Antworten kommen fest aus lotteRegeln.ts: keine erfundenen Zahlen, keine Namen vor
// der Registrierung. Sven bekommt zu jeder Regel eine Notiz. Eigener Schalter
// crm_settings lotte_regeln ('true' = an).
type RegelWahl = { regel: LotteRegel | 'keine'; region: string | null }
type RegelErgebnis = { regel: LotteRegel; antwort: string | null; betreff: string; notiz: string }

async function regelnAn(admin: SupabaseClient): Promise<boolean> {
  const { data } = await admin.from('crm_settings').select('value').eq('key', 'lotte_regeln').maybeSingle()
  return (data as { value: string } | null)?.value === 'true'
}

/** KI-Einordnung der Nachricht. null = KI nicht erreichbar (dann wie bisher). */
async function regelErkennen(text: string, verlauf: Turn[]): Promise<RegelWahl | null> {
  const sys = `Ein Interessent von Happy Property (Immobilien in Paphos auf Zypern; Sven berät, Lotte ist seine Assistentin) hat per WhatsApp geschrieben. Ordne seine NEUE Nachricht genau einer Regel zu. Du siehst auch den Verlauf davor; Nachrichten mit dem Präfix "[Sven persönlich]" hat Sven selbst geschrieben.
- angebot: Er möchte allgemein (weitere) Angebote, Exposés, eine Liste oder Übersicht von Projekten oder Investitionsmöglichkeiten, einen Link zu unseren Objekten, oder er fragt, was wir sonst noch haben ("Bitte stellen Sie uns eine Liste der Investitionsmöglichkeiten zu", "Habt ihr noch andere Objekte?", "Kannst du mir ein paar Exposés schicken?"). NICHT angebot: Er will Infos zu EINER bestimmten Wohnung oder zu einem Projekt, das er schon kennt (Lage, Grundriss, Preis, Ausstattung, Zahlungsplan).
- bautraeger: Er fragt, wer das Projekt baut, wie der Bauträger oder das Projekt heißt oder wer dahintersteckt ("Wer ist der Bauträger?", "Wie heißt die Anlage?", "Ist der Bauträger seriös?").
- region: Er sagt, dass er lieber oder auch in einer anderen Region als Paphos sucht oder kauft (anderer Ort auf Zypern wie Protaras, Ayia Napa, Larnaca, Limassol, Nikosia oder ein anderes Land), oder er vergleicht Paphos mit einer anderen Region ("Ich werde doch eher in der Region Protaras suchen", "Limassol gefällt uns besser"). Orte im Bezirk Paphos (Chloraka, Peyia, Coral Bay, Tala, Geroskipou, Kissonerga, Emba, Konia, Tsada, Polis, Latchi) sind KEINE andere Region. region = Name der Region oder des Landes, so wie er ihn schreibt.
- geld: Es geht um Provision, Tippgeber- oder Empfehlungsvergütung, Nachlass, Rabatt oder darum, Preis oder Zahlungskonditionen zu verhandeln ("Gibt es Nachlass?", "Was bekomme ich als Tippgeber?", "Wie hoch ist eure Provision?"). Die reine Frage nach dem Preis einer Wohnung ist NICHT geld, sondern keine.
- keine: alles andere (Sachfragen zu einem Projekt, Termine, Dank, Smalltalk, Absage, Abmeldung, Budget-Angaben ohne Wunsch nach weiteren Angeboten).
Enthält die Nachricht geld und etwas anderes, gilt geld. Im Zweifel keine, dann läuft die Nachricht ihren normalen Weg.
Die Nachricht kann auch englisch sein, die Regeln gelten genauso.
Gib NUR das Tool emit zurück.`
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-sonnet-5-5', fallbackModels: ['claude-opus-5-5', 'claude-sonnet-4-6'], max_tokens: 200, attempts: 2, label: 'lotte-regel',
    system: sys, messages: [...verlauf, { role: 'user', content: text }],
    tool_choice: { type: 'tool', name: 'emit' },
    tools: [{ name: 'emit', description: 'Welche feste Antwortregel passt', input_schema: { type: 'object', properties: {
      regel: { type: 'string', enum: ['angebot', 'bautraeger', 'region', 'geld', 'keine'] },
      region: { type: ['string', 'null'], description: 'nur bei region: die andere Region oder das Land' },
    }, required: ['regel'] } }],
  })
  const t = res.ok ? toolInput<Partial<RegelWahl>>(res) : null
  if (!t || !['angebot', 'bautraeger', 'region', 'geld', 'keine'].includes(String(t.regel))) return null
  return { regel: t.regel as RegelWahl['regel'], region: t.regel === 'region' ? (t.region ?? null) : null }
}

async function registrierteBautraeger(admin: SupabaseClient, leadId: string): Promise<string[]> {
  const { data } = await admin.from('lead_registrations').select('developer').eq('lead_id', leadId).limit(50)
  return ((data ?? []) as { developer: string | null }[]).map(r => r.developer ?? '').filter(Boolean)
}

/** Projekte mit frei verkäuflichen Einheiten (nicht im Bestand, kein laufender Deal,
 *  nicht verkauft oder reserviert) samt günstigster freier Einheit (price_net). */
type FreieZeile = { id: string; project_id: string; unit_number: string | null; type: string | null; bedrooms: number | null; size_sqm: number | string | null; price_net: number | string; status: string | null; developer_status: string | null }

/** Freie Wohnungen live aus dem CRM: ohne Eigentümer, mit Preis, weder verkauft noch
 *  reserviert, ohne aktiven Deal. Ohne pids für alle Projekte. */
async function freieWohnungen(admin: SupabaseClient, pids?: string[]): Promise<FreieZeile[]> {
  let q = admin.from('crm_project_units').select('id, project_id, unit_number, type, bedrooms, size_sqm, price_net, status, developer_status')
    .is('property_id', null).gt('price_net', 0)
  if (pids) q = q.in('project_id', pids)
  const { data: units } = await q.limit(5000)
  const { data: deals } = await admin.from('deals').select('unit_id')
    .not('unit_id', 'is', null).is('archived_from_phase', null).neq('phase', 'deal_verloren').limit(5000)
  const belegt = new Set(((deals ?? []) as { unit_id: string }[]).map(d => d.unit_id))
  const weg = (s: string | null) => s === 'sold' || s === 'reserved'
  return ((units ?? []) as FreieZeile[]).filter(u => !weg(u.status) && !weg(u.developer_status) && !belegt.has(u.id) && Number(u.price_net) > 0)
}

async function freieProjekte(admin: SupabaseClient): Promise<ProjektFrei[]> {
  const proP = new Map<string, { ab: number; frei: number; typen: Set<string> }>()
  for (const u of await freieWohnungen(admin)) {
    const preis = Number(u.price_net)
    const e = proP.get(u.project_id) ?? { ab: Infinity, frei: 0, typen: new Set<string>() }
    e.ab = Math.min(e.ab, preis); e.frei++
    if (u.type) e.typen.add(u.type)
    proP.set(u.project_id, e)
  }
  if (!proP.size) return []
  const { data: projs } = await admin.from('crm_projects').select('id, name, developer, location, location_district').in('id', [...proP.keys()])
  return ((projs ?? []) as { id: string; name: string; developer: string | null; location: string | null; location_district: string | null }[]).map(p => {
    const e = proP.get(p.id)!
    return { id: p.id, name: p.name, bautraeger: p.developer ?? '', ort: lageLabel(p.location, p.location_district), ab: e.ab, frei: e.frei, typen: [...e.typen] }
  })
}

// Regel 1: Verlauf prüfen (was ging raus, was wurde geöffnet), nach Suchprofil und
// Budget fragen, Sven die Kandidaten nennen. Lotte schickt selbst keine Projekte.
async function regelAngebot(admin: SupabaseClient, leadId: string, vorname: string | null, text: string): Promise<RegelErgebnis> {
  const { data: d1 } = await admin.from('sales_decks').select('token, project_id, created_at').eq('lead_id', leadId).order('created_at').limit(80)
  const decks = (d1 ?? []) as DeckZeile[]
  const { data: o1 } = await admin.from('deck_outbox').select('status, sent_at, email_sent_at, whatsapp_sent_at, deck_tokens').eq('lead_id', leadId).limit(40)
  const { data: e1 } = await admin.from('engagement_events').select('token, occurred_at')
    .eq('lead_id', leadId).in('type', ['deck_view', 'email_open']).not('token', 'is', null).limit(1000)
  const { data: a1 } = await admin.from('activities').select('type, created_at, content')
    .eq('lead_id', leadId).eq('direction', 'outbound').in('type', ['email', 'whatsapp']).ilike('content', '%/deck/%').order('created_at').limit(80)
  const sendungen = sendungenBauen(decks, (o1 ?? []) as OutboxZeile[], (e1 ?? []) as SichtZeile[], (a1 ?? []) as VersandZeile[])
  const schon = new Set(decks.map(d => d.project_id).filter((x): x is string => !!x))
  const frei = await freieProjekte(admin)
  const registrierte = await registrierteBautraeger(admin, leadId)
  const kandidaten = kandidatenWaehlen(frei, frei.filter(p => schon.has(p.id)), 3, registrierte)
  let pn: { id: string; name: string }[] = []
  if (schon.size) pn = ((await admin.from('crm_projects').select('id, name').in('id', [...schon])).data ?? []) as { id: string; name: string }[]
  const nameVon = new Map(pn.map(p => [p.id, p.name]))
  const projektVonToken = Object.fromEntries(decks.map(d => [d.token, d.project_id ? nameVon.get(d.project_id) ?? '' : '']))
  return {
    regel: 'angebot', antwort: lotteAngebotText(vorname, sendungen),
    betreff: '📋 Lotte: Angebotsanfrage, bitte Projekte auswählen',
    notiz: angebotNotiz(text, sendungen, projektVonToken, kandidaten, registrierte),
  }
}

// Regel 2: Bauträger zu den Projekten der jüngsten Sendung (Decks bis 3 Tage vor dem
// neuesten, höchstens 3). Namen nur bei Registrierung. null = kein Deck, wie bisher.
async function regelBautraeger(admin: SupabaseClient, leadId: string, vorname: string | null, text: string): Promise<RegelErgebnis | null> {
  const { data: d1 } = await admin.from('sales_decks').select('project_id, created_at')
    .eq('lead_id', leadId).not('project_id', 'is', null).order('created_at', { ascending: false }).limit(20)
  const decks = (d1 ?? []) as { project_id: string; created_at: string }[]
  if (!decks.length) return null
  const grenze = Date.parse(decks[0].created_at) - 3 * 864e5
  const pids = [...new Set(decks.filter(d => Date.parse(d.created_at) >= grenze).map(d => d.project_id))].slice(0, 3)
  const { data: pj } = await admin.from('crm_projects').select('id, name, developer, location, location_district').in('id', pids)
  const { data: un } = await admin.from('crm_project_units').select('project_id, type').in('project_id', pids).limit(1000)
  const registrierte = await registrierteBautraeger(admin, leadId)
  const einheiten = (un ?? []) as { project_id: string; type: string | null }[]
  const liste: BautraegerProjekt[] = ((pj ?? []) as { id: string; name: string; developer: string | null; location: string | null; location_district: string | null }[])
    .sort((a, b) => pids.indexOf(a.id) - pids.indexOf(b.id))
    .map(p => ({
      name: p.name, bautraeger: p.developer ?? '', lage: lageLabel(p.location, p.location_district),
      typ: objektTyp(einheiten.filter(u => u.project_id === p.id).map(u => u.type)), registriert: istRegistriert(p.developer, registrierte),
    }))
  if (!liste.length) return null
  return { regel: 'bautraeger', antwort: lotteBautraegerText(vorname, liste), betreff: bautraegerBetreff(liste), notiz: bautraegerNotiz(text, liste) }
}

// Regel 3: im Kontakt halten, Zahlen aus crm_settings lotte_region_fakten.
async function regelRegion(admin: SupabaseClient, vorname: string | null, text: string, region: string | null): Promise<RegelErgebnis> {
  const { data } = await admin.from('crm_settings').select('value').eq('key', 'lotte_region_fakten').maybeSingle()
  const f = regionFaktenLesen((data as { value: string } | null)?.value)
  return { regel: 'region', antwort: lotteRegionText(vorname, region, f), betreff: `🧭 Lotte: Kunde schaut ${region ? `in ${region}` : 'in einer anderen Region'}`, notiz: regionNotiz(text, region, f) }
}

/** Regel anwenden, ohne zu senden oder zu schreiben (auch für regel_test). */
async function regelAusfuehren(admin: SupabaseClient, leadId: string, vorname: string | null, text: string, wahl: RegelWahl, imGespraech: boolean): Promise<RegelErgebnis | null> {
  if (wahl.regel === 'angebot') return await regelAngebot(admin, leadId, vorname, text)
  if (wahl.regel === 'bautraeger') return await regelBautraeger(admin, leadId, vorname, text)
  if (wahl.regel === 'region') return await regelRegion(admin, vorname, text, wahl.region)
  // Regel 4: Geld macht Sven. Ohne Gespräch schreibt Lotte nichts, im Gespräch nur,
  // dass Sven sich meldet (Aufrufer), nie einen Betrag.
  if (wahl.regel === 'geld') return { regel: 'geld', antwort: null, betreff: '💶 Geld-Thema, übernimmst du', notiz: geldNotiz(text, imGespraech) }
  return null
}

/** Vorfilter, KI, Regel. null = keine Regel, die Nachricht läuft ihren normalen Weg. */
async function lotteRegel(admin: SupabaseClient, leadId: string, vorname: string | null, text: string, verlauf: Turn[], imGespraech: boolean): Promise<RegelErgebnis | null> {
  if (!regelVorfilter(text).length) return null
  try {
    const wahl = await regelErkennen(text, verlauf)
    if (!wahl || wahl.regel === 'keine') return null
    return await regelAusfuehren(admin, leadId, vorname, text, wahl, imGespraech)
  } catch (e) { console.warn('[booking-bot] lotteRegel:', e); return null }
}

async function regelNotiz(admin: SupabaseClient, leadId: string, r: RegelErgebnis, gesendet: string | null): Promise<void> {
  try {
    await admin.from('activities').insert({
      lead_id: leadId, type: 'note', direction: 'inbound', subject: r.betreff,
      content: `${r.notiz}${gesendet ? `\n\nLotte hat geschrieben:\n${gesendet}${sprachePerLead.get(leadId) === 'en' ? `\n${UEBERSETZT}` : ''}` : ''}`.slice(0, 20000),
      completed_at: new Date().toISOString(),
    })
  } catch { /* egal */ }
}

// Sachfrage OHNE laufendes Termin-Gespräch (Dirk, 29.10.: "Lass mir gern mal einen
// Google-Maps-Link zukommen"). Aufruf aus waInbound für jede Kundennachricht ohne
// Terminbezug; Lotte antwortet nur, wenn die Fakten reichen oder eine feste Regel greift.
async function handleAnswer(admin: SupabaseClient, leadId: string, text: string): Promise<Response> {
  const { data: sset } = await admin.from('crm_settings').select('key, value').in('key', ['booking_bot_enabled', 'lotte_fakten_antworten', 'lotte_regeln'])
  const sv = new Map(((sset ?? []) as { key: string; value: string }[]).map(s => [s.key, s.value]))
  if (sv.get('booking_bot_enabled') !== 'true') return json({ ok: true, skipped: 'disabled' })
  const fakten = sv.get('lotte_fakten_antworten') !== 'false'
  // Die Regeln vor dem Frage-Filter: "Ich werde doch eher in der Region Protaras
  // suchen" (Arne, 29.10.) ist keine Frage, braucht aber eine Antwort.
  const regeln = sv.get('lotte_regeln') === 'true' && regelVorfilter(text).length > 0
  const frage = fakten && text.trim().length >= 12 && /\?|link|standort|lage|wo (genau|liegt|befind)|schick|zukommen|wie weit|entfernung|ausstattung|pool|fertig|baubeginn|übergabe|zahlungsplan|wann|location|where|send|how far|distance|amenities|completion|handover|payment plan|when/i.test(text)
  if (!regeln && !frage) return json({ ok: true, skipped: fakten ? 'keine_frage' : 'disabled' })
  const { data: opt } = await admin.from('communication_optouts').select('id').eq('lead_id', leadId).limit(1)
  if (opt && opt.length) return json({ ok: true, skipped: 'optout' })
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone, profile_id').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null; profile_id: string | null } | null
  const phone = l?.whatsapp || l?.phone
  if (!l || !phone) return json({ ok: true, skipped: 'no_phone' })
  if (l.profile_id) return json({ ok: true, skipped: 'bestandskunde' })
  const { data: laufend } = await admin.from('deals').select('id').eq('lead_id', leadId).in('phase', FAKT_NICHT_PHASEN).limit(1)
  if (laufend && laufend.length) return json({ ok: true, skipped: 'laufender_kauf' })
  // Schreibt Sven gerade selbst mit dem Kunden? Dann nicht dazwischenfunken.
  const seit = new Date(Date.now() - 3 * 3600e3).toISOString()
  const { data: svenAktiv } = await admin.from('activities').select('id').eq('lead_id', leadId).eq('type', 'whatsapp')
    .eq('direction', 'outbound').eq('auto', false).gt('created_at', seit).limit(1)
  if (svenAktiv && svenAktiv.length) return json({ ok: true, skipped: 'sven_im_gespraech' })

  const { data: hist } = await admin.from('activities').select('direction, content, auto')
    .eq('lead_id', leadId).eq('type', 'whatsapp').order('created_at', { ascending: false }).limit(6)
  const verlauf: Turn[] = ((hist ?? []) as { direction: string; content: string | null; auto: boolean | null }[])
    .filter(h => (h.content ?? '').trim()).reverse()
    .map(h => ({ role: h.direction === 'outbound' ? 'assistant' as const : 'user' as const, content: (h.direction === 'outbound' && h.auto === false ? '[Sven persönlich] ' : '') + (h.content ?? '').slice(0, 700) }))
  while (verlauf.length && verlauf[verlauf.length - 1].role === 'user') verlauf.pop()
  while (verlauf.length && verlauf[0].role === 'assistant') verlauf.shift()

  if (regeln) {
    const r = await lotteRegel(admin, leadId, first(l.first_name) || null, text, verlauf, false)
    if (r) {
      if (r.antwort) { await sendWa(phone, r.antwort); await logWa(admin, leadId, r.antwort, 'outbound') }
      await regelNotiz(admin, leadId, r, r.antwort)
      return json({ ok: true, regel: r.regel, answered: !!r.antwort })
    }
  }
  if (!frage) return json({ ok: true, skipped: fakten ? 'keine_frage' : 'disabled' })
  const fa = await faktenAntwort(admin, leadId, first(l.first_name) || null, text, verlauf)
  if (!fa.ok) return json({ ok: true, skipped: 'fakten_reichen_nicht' })
  await sendWa(phone, fa.antwort); await logWa(admin, leadId, fa.antwort, 'outbound')
  await faktenNotiz(admin, leadId, text, fa.antwort, fa.alles ? '' : fa.offen)
  return json({ ok: true, answered: true, alles: fa.alles })
}

// ── ABSAGE ── Kunde sagt einen anstehenden Termin ab oder will verschieben ─────
// Eva Hahn (29.10.2026): "Ich möchte den Termin absagen" lief ins Leere. Der Termin
// blieb aktiv, die 1-h-Erinnerung ging raus, und Aaron (Bauträger) wusste von nichts.
// waInbound ruft diese Action, wenn der Vorfilter (_shared/terminAbsage.ts) anschlägt
// und ein Termin ansteht. Der Termin wird NICHT gelöscht, sondern markiert
// (cancel_reported_*): Erinnerungen und Bauträger-Briefing lassen ihn aus, Sven bekommt
// eine Aufgabe und entscheidet. Ist es keine Absage, geht die Nachricht ihren normalen
// Weg weiter (fallback = reply | engage | answer). still = Abmeldung im selben Text:
// markieren und Sven Bescheid geben, aber Lotte schreibt nichts mehr.
type AbsageTermin = { id: string; title: string | null; type: string | null; start_time: string; end_time: string; timezone: string | null; location: string | null; zoom_link: string | null; attendees: unknown; deal_id: string | null }
type AbsageWunsch = { art: AbsageArt | 'keine'; on_date: string | null; after_date: string | null; day_hint: string | null; daypart: string | null; time_hint: string | null }
type AbsageLead = { first_name: string | null; last_name: string | null; whatsapp: string | null; phone: string | null; profile_id: string | null }
type AbsageKontakt = { name: string; firma: string; phone: string; lang: 'de' | 'en' }

/** KI-Einordnung der Nachricht. null = KI nicht erreichbar. */
async function absageErkennen(text: string, termin: string, verlauf: Turn[]): Promise<AbsageWunsch | null> {
  const tp = berlinParts(new Date())
  const WDN = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
  const todayStr = `${tp.y}-${String(tp.mo).padStart(2, '0')}-${String(tp.d).padStart(2, '0')}`
  const sys = `Ein Kunde von Happy Property (Immobilien auf Zypern) hat einen festen Termin mit Sven: ${termin}. HEUTE ist ${WDN[tp.wd]}, der ${todayStr} (Europe/Berlin).
Ordne seine NEUE WhatsApp ein. Du siehst auch den Verlauf davor; Nachrichten mit dem Präfix "[Sven persönlich]" hat Sven selbst geschrieben.
- absage: Er sagt DIESEN Termin ab oder kann nicht kommen, ohne einen neuen Termin zu wollen ("ich möchte den Termin absagen", "ich schaffe es morgen leider nicht", "mir ist etwas dazwischengekommen, ich kann nicht", "wir haben uns anders entschieden").
- verschieben: Er kann zu diesem Zeitpunkt nicht oder fragt, ob man den Termin verlegen kann, und will einen ANDEREN Termin ("kann ich den Termin verschieben?", "können wir das auf nächste Woche legen?", "geht auch Donnerstag statt Mittwoch?", "passt mir doch nicht, lieber nachmittags", "geht es auch eine Stunde früher?").
- keine: alles andere. Vor allem: Er kommt nur etwas später oder früher und der Termin bleibt ("ich komme etwas später", "bin 10 Minuten zu spät", "stehe im Stau"); er bestätigt ("passt, bis morgen"); er fragt etwas zum Termin (Adresse, Link, Dauer, wer dabei ist); er will zur selben Zeit eine andere Terminart (Zoom statt Telefon); er spricht über einen vergangenen oder einen anderen Termin; er ist nur unsicher, ohne abzusagen ("ich weiß noch nicht, ob ich es schaffe").
Zwischen absage und verschieben: verschieben, sobald er einen neuen Zeitpunkt nennt oder danach fragt. Zwischen keine und den anderen im Zweifel keine: eine falsch erkannte Absage stoppt die Erinnerungen eines Termins, der stattfinden soll.
Nur bei verschieben und nur, wenn er einen Wunsch für den NEUEN Termin nennt: on_date (GENAU EIN Datum, YYYY-MM-DD), after_date (frühestes Datum, YYYY-MM-DD, z. B. bei "ab nächster Woche"), day_hint (z. B. "dienstag", "morgen", "nächste woche"), daypart (vormittags | nachmittags | abends), time_hint (24h "HH:MM"). Sonst null.
Gib NUR das Tool emit zurück.`
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-sonnet-5-5', fallbackModels: ['claude-opus-5-5', 'claude-sonnet-4-6'], max_tokens: 300, attempts: 2, label: 'absage',
    system: sys, messages: [...verlauf, { role: 'user', content: text }],
    tool_choice: { type: 'tool', name: 'emit' },
    tools: [{ name: 'emit', description: 'Absage, Verschiebung oder keins von beidem', input_schema: { type: 'object', properties: {
      art: { type: 'string', enum: ['absage', 'verschieben', 'keine'] },
      on_date: { type: ['string', 'null'] }, after_date: { type: ['string', 'null'] }, day_hint: { type: ['string', 'null'] },
      daypart: { type: ['string', 'null'], enum: ['vormittags', 'nachmittags', 'abends', null] },
      time_hint: { type: ['string', 'null'], description: 'konkrete Uhrzeit 24h HH:MM' },
    }, required: ['art'] } }],
  })
  const t = res.ok ? toolInput<Partial<AbsageWunsch>>(res) : null
  if (!t || !['absage', 'verschieben', 'keine'].includes(String(t.art))) return null
  return { art: t.art as AbsageWunsch['art'], on_date: t.on_date ?? null, after_date: t.after_date ?? null, day_hint: t.day_hint ?? null, daypart: t.daypart ?? null, time_hint: t.time_hint ?? null }
}

/** Die letzten WhatsApps als Dialog (wie handleAnswer), ohne die gerade eingegangene. */
async function absageVerlauf(admin: SupabaseClient, leadId: string): Promise<Turn[]> {
  try {
    const { data: hist } = await admin.from('activities').select('direction, content, auto')
      .eq('lead_id', leadId).eq('type', 'whatsapp').order('created_at', { ascending: false }).limit(6)
    const verlauf: Turn[] = ((hist ?? []) as { direction: string; content: string | null; auto: boolean | null }[])
      .filter(h => (h.content ?? '').trim()).reverse()
      .map(h => ({ role: h.direction === 'outbound' ? 'assistant' as const : 'user' as const, content: (h.direction === 'outbound' && h.auto === false ? '[Sven persönlich] ' : '') + (h.content ?? '').slice(0, 700) }))
    while (verlauf.length && verlauf[verlauf.length - 1].role === 'user') verlauf.pop()
    while (verlauf.length && verlauf[0].role === 'assistant') verlauf.shift()
    return verlauf
  } catch { return [] }
}

/** Bauträger-Kontakte am Termin (gleicher Abgleich wie developer-briefing). */
async function absageBautraeger(admin: SupabaseClient, attendees: unknown): Promise<AbsageKontakt[]> {
  const liste = Array.isArray(attendees) ? attendees as Record<string, unknown>[] : []
  if (!liste.length) return []
  const { data } = await admin.from('crm_developer_contacts').select('name, email, phone, whatsapp, language, developer:crm_developers(name)')
  const kontakte = (data ?? []) as Record<string, unknown>[]
  const ziffern = (v: unknown) => String(v ?? '').replace(/\D/g, '')
  const out: AbsageKontakt[] = []
  for (const a of liste) {
    const ph = ziffern(a.phone), em = String(a.email ?? '').trim().toLowerCase()
    const c = kontakte.find(k => (ph.length >= 8 && (ziffern(k.phone) === ph || ziffern(k.whatsapp) === ph)) || (!!em && String(k.email ?? '').trim().toLowerCase() === em))
    if (!c && !/\(Developer\)/i.test(String(a.company ?? ''))) continue
    const dev = c ? (Array.isArray(c.developer) ? (c.developer as Record<string, unknown>[])[0] : c.developer as Record<string, unknown> | null) : null
    out.push({
      name: String(c?.name ?? a.name ?? '').trim(),
      firma: String(dev?.name ?? String(a.company ?? '').replace(/\s*\(Developer\)\s*/i, '')).trim(),
      phone: String(c?.whatsapp || c?.phone || a.phone || ''),
      lang: (c?.language ?? a.language) === 'en' ? 'en' : 'de',
    })
  }
  return out
}

/** Darf Lotte antworten? '' = ja, sonst der Grund (steht in Svens Aufgabe). */
async function absageStumm(admin: SupabaseClient, leadId: string, l: AbsageLead | null): Promise<string> {
  const { data: sset } = await admin.from('crm_settings').select('key, value').in('key', ['booking_bot_enabled', 'lotte_absage_antworten'])
  const sv = new Map(((sset ?? []) as { key: string; value: string }[]).map(s => [s.key, s.value]))
  if (sv.get('booking_bot_enabled') !== 'true' || sv.get('lotte_absage_antworten') === 'false') return 'Lotte ist ausgeschaltet'
  if (!l || !(l.whatsapp || l.phone)) return 'keine Nummer am Kontakt'
  const { data: opt } = await admin.from('communication_optouts').select('id').eq('lead_id', leadId).limit(1)
  if (opt && opt.length) return 'der Kunde hat sich abgemeldet'
  if (l.profile_id) return 'Bestandskunde, den führst du selbst'
  const { data: laufend } = await admin.from('deals').select('id').eq('lead_id', leadId).in('phase', CAFE_NICHT_PHASEN).limit(1)
  if (laufend && laufend.length) return 'laufender Kauf, den führst du selbst'
  const seit = new Date(Date.now() - 3 * 3600e3).toISOString()
  const { data: svenAktiv } = await admin.from('activities').select('id').eq('lead_id', leadId).eq('type', 'whatsapp')
    .eq('direction', 'outbound').eq('auto', false).gt('created_at', seit).limit(1)
  if (svenAktiv && svenAktiv.length) return 'du schreibst gerade selbst mit dem Kunden'
  return ''
}

/** Termin-Gespräch für die Verschiebung eröffnen (ein offenes wird weitergeführt). */
async function absageGespraech(admin: SupabaseClient, row: Record<string, unknown> & { lead_id: string }): Promise<void> {
  const { data: offen } = await admin.from('booking_conversations').select('id').eq('lead_id', row.lead_id)
    .not('state', 'in', '(booked,handoff,expired)').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const voll = { ...row, attempts: 0, chosen_slot: null, expires_at: new Date(Date.now() + 4 * 24 * 3600e3).toISOString() }
  if (offen) await setConv(admin, (offen as { id: string }).id, voll)
  else await admin.from('booking_conversations').insert(voll)
}

/** Lottes Antwort auf einen Verschiebe-Wunsch. Gibt zurück, was sie getan hat (für Sven). */
async function absageVerschieben(admin: SupabaseClient, t: AbsageTermin, leadId: string, phone: string, vorname: string, wann: string, w: AbsageWunsch, mitBautraeger: boolean, text: string): Promise<string> {
  const senden = async (m: string) => { const id = await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound', id) }
  if (t.location === CAFE_LOCATION) {
    // Café: nächster Tag, an dem Sven dort sitzt (Wunsch zuerst). Die Zusage bucht cafeReply.
    const slot = await naechsterCafeTag(admin, { onDate: w.on_date, dayHint: w.day_hint, afterDate: w.after_date }) ?? await naechsterCafeTag(admin, {})
    if (slot) {
      const ihr = mehrere(text)
      const m = `Kein Problem${vorname ? `, ${vorname}` : ''}! Dann verschieben wir das Treffen im ${CAFE_NAME}. Soll ich ${ihr ? 'euch' : 'dich'} für ${slot.label}, um 10 Uhr eintragen?`
      await absageGespraech(admin, { lead_id: leadId, deal_id: t.deal_id, source: 'cafe', state: 'awaiting_cafe', proposed_slots: [slot], last_message: m, meeting_type: ihr ? 'cafe_ihr' : 'cafe_du' })
      await senden(m)
      await cafeNachfassPlanen(admin, leadId, t.deal_id)
      return `Lotte hat das nächste Café-Treffen angeboten: ${slot.label}, 10 Uhr.`
    }
  } else if (t.type !== 'inperson' && !mitBautraeger) {
    // Telefon/Zoom: wie im normalen Termin-Dialog freie Zeiten anbieten. Die Auswahl
    // läuft dann über replyRunde und bucht einen NEUEN Termin.
    const hatWunsch = !!(w.on_date || w.after_date || w.day_hint || w.daypart || w.time_hint)
    let slots = hatWunsch ? await computeSlots(admin, 2, { dayHint: w.day_hint ?? undefined, daypart: w.daypart ?? undefined, timeHint: w.time_hint ?? undefined, onDate: w.on_date ?? undefined, afterDate: w.after_date ?? undefined }) : []
    if (!slots.length) slots = await computeSlotsAmPm(admin)
    if (slots.length) {
      const m = buildProposal(lotteVerschiebenIntro(vorname, wann), slots, false)
      await absageGespraech(admin, { lead_id: leadId, deal_id: t.deal_id, source: 'verschieben', state: 'awaiting_choice', proposed_slots: slots, last_message: m })
      await senden(m)
      return `Lotte hat neue Zeiten angeboten: ${slots.map(s => `${s.label} Uhr`).join(' oder ')} (deutsche Zeit). Wählt der Kunde eine, bucht Lotte einen NEUEN Termin, den alten bitte löschen.`
    }
  }
  // Besichtigung (der Bauträger muss mitziehen) oder nichts frei: Sven stimmt ab.
  await senden(lotteVerschiebenSven(vorname, wann))
  return 'Lotte hat dem Kunden gesagt, dass du einen neuen Termin abstimmst und dich meldest.'
}

/** Aufgabe für Sven (Muster anfrage-paket): Mail + WhatsApp über task-notify. */
async function absageAufgabe(admin: SupabaseClient, leadId: string, titel: string, beschreibung: string): Promise<string | null> {
  try {
    const { data: adm } = await admin.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
    const adminId = (adm as { id: string } | null)?.id ?? null
    const { data: task, error } = await admin.from('crm_tasks').insert({
      title: titel.slice(0, 200), description: beschreibung, created_by: adminId, assigned_to: adminId,
      status: 'offen', due_date: cyDate(new Date()), assigned_notified_at: new Date().toISOString(),
    }).select('id').single()
    if (error || !task) { console.error('[booking-bot] Absage-Aufgabe:', error?.message); return null }
    const taskId = (task as { id: string }).id
    if (adminId) await admin.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
    await admin.from('crm_task_leads').insert({ task_id: taskId, lead_id: leadId })
    await admin.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: taskId }, headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` } })
      .catch((e: unknown) => console.warn('[booking-bot] Absage-Aufgabe dispatch:', e))
    return taskId
  } catch (e) { console.error('[booking-bot] Absage-Aufgabe:', e); return null }
}

async function handleAbsage(admin: SupabaseClient, leadId: string, text: string, fallback: string | undefined, still: boolean): Promise<Response> {
  // Keine Absage (oder kein Termin mehr): die Nachricht nimmt ihren normalen Weg.
  const weiter = async (): Promise<Response> => {
    if (still) return json({ ok: true, skipped: 'keine_absage' })
    if (fallback === 'reply') return await handleReply(admin, leadId, text)
    if (fallback === 'engage') return await handleEngage(admin, leadId, text)
    return await handleAnswer(admin, leadId, text)
  }
  // Der Termin, um den es geht: der nächste, der noch nicht vorbei ist (auch ein
  // gerade laufender: "ich schaffe es heute doch nicht" zehn Minuten nach Beginn).
  const { data: ta } = await admin.from('crm_appointments')
    .select('id, title, type, start_time, end_time, timezone, location, zoom_link, attendees, deal_id')
    .eq('lead_id', leadId).eq('internal', false).is('cancel_reported_at', null).gt('end_time', new Date().toISOString())
    .order('start_time', { ascending: true }).limit(1).maybeSingle()
  const t = ta as AbsageTermin | null
  if (!t) return await weiter()

  const { data: lead } = await admin.from('leads').select('first_name, last_name, whatsapp, phone, profile_id').eq('id', leadId).maybeSingle()
  const l = lead as AbsageLead | null
  const vorname = first(l?.first_name ?? null)
  const kunde = `${vorname} ${(l?.last_name ?? '').trim()}`.trim() || 'Kunde'
  const wann = terminLabel(t.start_time, terminZone(t.timezone, t.type))
  const cafe = t.location === CAFE_LOCATION
  const artLabel = cafe ? `Café-Treffen im ${CAFE_NAME}` : t.type === 'inperson' ? 'Vor-Ort-Termin' : (t.type === 'zoom' || t.zoom_link) ? 'Zoom-Call' : 'Telefonat'

  const erk = await absageErkennen(text, `${wann}, ${artLabel}${t.title ? ` („${t.title}“)` : ''}`, await absageVerlauf(admin, leadId))
  if (!erk) {
    // KI nicht erreichbar: nichts markieren, aber Sven soll die Nachricht nicht übersehen.
    await absageAufgabe(admin, leadId, `⚠️ Bitte prüfen: sagt ${kunde} den Termin ab?`, [
      `${kunde} hat zum Termin am ${wann} (${artLabel}) geschrieben:`, `„${text.replace(/\s+/g, ' ').slice(0, 600)}“`, '',
      'Lotte konnte die Nachricht nicht einordnen (KI nicht erreichbar). Der Termin ist unverändert, die Erinnerungen laufen weiter.',
    ].join('\n'))
    return await weiter()
  }
  if (erk.art === 'keine') return await weiter()
  const art: AbsageArt = erk.art

  // Markieren statt löschen. Bedingt, damit zwei Nachrichten kurz hintereinander
  // ("Muss leider absagen" + "Sorry!") nur EINE Aufgabe und EINE Antwort auslösen.
  const { data: mark, error: markErr } = await admin.from('crm_appointments')
    .update({ cancel_reported_at: new Date().toISOString(), cancel_reported_kind: art, cancel_reported_text: text.slice(0, 2000) })
    .eq('id', t.id).is('cancel_reported_at', null).select('id').maybeSingle()
  if (markErr) { console.error('[booking-bot] Absage markieren:', markErr.message); return await weiter() }
  if (!mark) return json({ ok: true, skipped: 'schon_gemeldet' })

  // Erinnerungen zu diesem Termin stoppen. Das Sicherheitsnetz in
  // process-scheduled-messages plant für markierte Termine nichts nach.
  const { data: gestoppt } = await admin.from('scheduled_messages')
    .update({ status: 'cancelled', error_message: art === 'absage' ? 'Kunde hat abgesagt, Erinnerung gestoppt' : 'Kunde will verschieben, Erinnerung gestoppt' })
    .eq('lead_id', leadId).eq('status', 'pending').eq('event_type', 'termin_gebucht').lte('scheduled_at', t.start_time).select('id')
  const nGestoppt = (gestoppt ?? []).length

  const kontakte = await absageBautraeger(admin, t.attendees)
  const stumm = still ? 'der Kunde hat sich im selben Text abgemeldet' : await absageStumm(admin, leadId, l)
  const phone = l?.whatsapp || l?.phone || ''
  let lotte: string
  try {
    if (stumm) lotte = `Lotte hat NICHT geantwortet (${stumm}). Bitte selbst antworten.`
    else if (art === 'absage') {
      const m = lotteAbsageText(vorname, wann)
      await sendWa(phone, m); await logWa(admin, leadId, m, 'outbound')
      lotte = 'Lotte hat sich bedankt und gesagt, dass du Bescheid weißt.'
    } else lotte = await absageVerschieben(admin, t, leadId, phone, vorname, wann, erk, kontakte.length > 0, text)
  } catch (e) {
    console.error('[booking-bot] Absage-Antwort:', e)
    lotte = 'Lottes Antwort ist fehlgeschlagen. Bitte selbst antworten.'
  }

  const zeilen = [
    `${kunde} ${art === 'absage' ? 'sagt den Termin ab' : 'möchte den Termin verschieben'}:`,
    `„${text.replace(/\s+/g, ' ').slice(0, 600)}“`,
    '',
    `Termin: ${t.title || artLabel}, ${wann}${t.location && !cafe ? `, ${t.location}` : ''}`,
    `Der Termin ist NICHT gelöscht, nur markiert („${art === 'absage' ? 'Absage gemeldet' : 'Verschiebung gewünscht'}“). ${nGestoppt ? 'Die Erinnerungen an den Kunden sind gestoppt.' : 'Es war keine Erinnerung mehr offen.'}`,
    lotte,
  ]
  for (const k of kontakte) {
    const link = waMeLink(k.phone, bautraegerAbsageText({ lang: k.lang, vorname: k.name.split(' ')[0] || k.name, kunde, wann: terminLabel(t.start_time, 'Asia/Nicosia', k.lang), art }))
    zeilen.push('', `Bauträger am Termin: ${k.name || 'ohne Namen'}${k.firma ? ` (${k.firma})` : ''}. Automatisch hat er nichts bekommen.`,
      link ? `Ihm Bescheid geben (WhatsApp mit fertigem Text, 1 Klick): ${link}` : 'Keine Nummer hinterlegt, bitte anrufen oder mailen.')
  }
  zeilen.push('', 'Bitte: Termin im Kalender löschen oder auf die neue Zeit legen. Findet er doch statt, im Termin „Absage zurücknehmen“ klicken.')
  const taskId = await absageAufgabe(admin, leadId, `${art === 'absage' ? '🚫 Absage' : '🔁 Verschieben'}: ${kunde}, Termin ${wann}`, zeilen.join('\n'))

  try {
    await admin.from('activities').insert({
      lead_id: leadId, type: 'note', direction: 'inbound',
      subject: art === 'absage' ? '🚫 Termin-Absage gemeldet' : '🔁 Termin soll verschoben werden',
      content: zeilen.join('\n').slice(0, 20000), completed_at: new Date().toISOString(),
    })
  } catch { /* egal */ }
  return json({ ok: true, handled: art, appointment_id: t.id, erinnerungen_gestoppt: nGestoppt, task_id: taskId, bautraeger: kontakte.length, lotte })
}

// ── Antwortsprache (Sven 30.10.2026) ─────────────────────────────────────────
// Lotte antwortet in der Sprache der letzten Kundennachricht (Regeln in
// _shared/kundenSprache.ts). Schreibt ein Kunde dauerhaft Englisch, stellt Lotte
// die Sprache im Kontakt einmal auf Englisch, damit auch Drip, Reaktivierung und
// Svens Entwürfe folgen. Schalter: crm_settings lotte_sprache = 'false' (fehlt = an).
type SprachLage = { sprache: Sprache; erkannt: Sprache | null; dauerhaft: boolean; kontakt: string | null; nummer: string | null; verlauf: string[] }

async function spracheAn(admin: SupabaseClient): Promise<boolean> {
  const { data } = await admin.from('crm_settings').select('value').eq('key', 'lotte_sprache').maybeSingle()
  return (data as { value?: string } | null)?.value !== 'false'
}

async function sprachLage(admin: SupabaseClient, leadId: string, text: string): Promise<SprachLage | null> {
  const { data: lead } = await admin.from('leads').select('language, whatsapp, phone').eq('id', leadId).maybeSingle()
  const l = lead as { language: string | null; whatsapp: string | null; phone: string | null } | null
  if (!l) return null
  // Die gerade eingegangene Nachricht hat der Webhook meist schon geschrieben. Für
  // die Umstellung zählen nur die geschriebenen Nachrichten, sonst würde eine
  // einzige lange Nachricht doppelt gezählt.
  const { data: inb } = await admin.from('activities').select('content')
    .eq('lead_id', leadId).eq('type', 'whatsapp').eq('direction', 'inbound')
    .gt('created_at', new Date(Date.now() - 30 * 86400e3).toISOString())
    .order('created_at', { ascending: false }).limit(6)
  const verlauf = ((inb ?? []) as { content: string | null }[]).map(a => (a.content ?? '').trim()).filter(Boolean)
  const phone = l.whatsapp || l.phone
  return {
    sprache: antwortSprache(text, verlauf.slice(0, 4), l.language),
    erkannt: spracheErkennen(text),
    dauerhaft: (l.language ?? 'de') === 'de' && dauerhaftEnglisch(verlauf),
    kontakt: l.language,
    nummer: phone ? nummer9(phone) : null,
    verlauf,
  }
}

async function aufEnglischStellen(admin: SupabaseClient, leadId: string, verlauf: string[]): Promise<void> {
  // Nur einmal je Kontakt: hat Sven danach wieder Deutsch eingestellt, bleibt es dabei.
  const { data: schon } = await admin.from('activities').select('id').eq('lead_id', leadId).eq('type', 'note').eq('subject', SPRACH_BETREFF).limit(1)
  if (schon && schon.length) return
  const { data: geaendert, error } = await admin.from('leads').update({ language: 'en' })
    .eq('id', leadId).or('language.is.null,language.eq.de').select('first_name')
  if (error) { console.warn('[booking-bot] Sprache umstellen:', error.message); return }
  if (!geaendert || !geaendert.length) return
  try {
    await admin.from('activities').insert({
      lead_id: leadId, type: 'note', direction: 'inbound', subject: SPRACH_BETREFF,
      content: sprachNotiz(first((geaendert[0] as { first_name: string | null }).first_name) || null, verlauf),
      completed_at: new Date().toISOString(),
    })
  } catch { /* egal */ }
}

/** Action mit fester Antwortsprache für diese Nummer ausführen (siehe sprachePerNummer). */
async function inSprache(nummer: string, leadId: string | null, sprache: Sprache, lauf: () => Promise<Response>): Promise<Response> {
  sprachePerNummer.set(nummer, sprache)
  if (leadId) sprachePerLead.set(leadId, sprache)
  try { return await lauf() } finally {
    sprachePerNummer.delete(nummer)
    if (leadId) sprachePerLead.delete(leadId)
  }
}

/** Eingangs-Action in der Sprache der letzten Kundennachricht ausführen. */
async function mitSprache(admin: SupabaseClient, leadId: string, text: string, lauf: () => Promise<Response>): Promise<Response> {
  let lage: SprachLage | null = null
  try {
    if (await spracheAn(admin)) lage = await sprachLage(admin, leadId, text)
    if (lage?.dauerhaft) await aufEnglischStellen(admin, leadId, lage.verlauf)
  } catch (e) { console.warn('[booking-bot] Antwortsprache:', e) }
  return lage?.nummer ? await inSprache(lage.nummer, leadId, lage.sprache, lauf) : await lauf()
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  // Nur System-Aufrufer (Befund I3-1): pg_cron mit x-cron-secret, andere Functions
  // mit dem Service-Role-Key. Vorher konnte jeder mit einer lead_id WhatsApps mit
  // eigenem Text auslösen, Termine erzwingen oder KI-Aufrufe verbrauchen.
  const denied = await gateCaller(req, 'booking-bot', { cron: true, service: true }, CORS)
  if (denied) return denied
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json() as { action?: string; lead_id?: string; deal_id?: string | null; source?: string; text?: string; stage?: number; intro?: string; state?: string; slots?: Slot[]; meeting_type?: string; force?: boolean; phone?: string; push_name?: string | null; fallback?: string; still?: boolean; termin?: string; emoji?: string; ziel?: string; uid?: string | null }
    // classify: seiteneffektfreier Test des Intent-Parsers (kein Senden, kein DB-Write).
    if (body.action === 'classify') return json({ ok: true, intent: await classify(body.state ?? 'awaiting_choice', body.slots ?? [], body.text ?? '') })
    // detect: seiteneffektfreier Test des Terminwunsch-Erkenners (kein Senden).
    if (body.action === 'detect') return json({ ok: true, detect: await detectApptRequest(body.text ?? '') })
    // absage_test: seiteneffektfreier Test der Absage-Erkennung (kein Senden, kein DB-Write).
    if (body.action === 'absage_test') return json({ ok: true, vorfilter: koennteAbsageSein(body.text ?? ''), erkennung: await absageErkennen(body.text ?? '', body.termin ?? 'Donnerstag, 5.11., 15:00 Uhr, Zoom-Call', []) })
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
    // sweep: haengende Terminart-Fragen aufloesen. Slot steht fest, Lotte hat
    // "WhatsApp oder Zoom?" gefragt, der Kunde antwortet nicht mehr - vorher
    // entstand dann NIE ein Termin (Rainer, 19.8.). Neue Regel (Sven): nach
    // 20 Minuten ohne Antwort automatisch als WhatsApp-Telefonat buchen.
    // Laeuft alle 5 Minuten ueber pg_cron (Job booking-bot-sweep).
    if (body.action === 'sweep') {
      const cutoff = new Date(Date.now() - 20 * 60_000).toISOString()
      const { data: stale } = await admin.from('booking_conversations')
        .select('id, lead_id, deal_id, chosen_slot, updated_at')
        .eq('state', 'awaiting_type').not('chosen_slot', 'is', null).lt('updated_at', cutoff)
      const results: Array<{ lead_id: string; booked?: string; error?: string }> = []
      for (const c of (stale ?? []) as Array<{ id: string; lead_id: string; deal_id: string | null; chosen_slot: Slot }>) {
        try {
          // Slot in der Vergangenheit? Dann nicht stumpf buchen, sondern an Sven melden.
          if (new Date(c.chosen_slot.startIso).getTime() < Date.now()) {
            await setConv(admin, c.id, { state: 'handoff', last_message: 'Terminart nie beantwortet, Slot inzwischen vorbei - bitte manuell klaeren.' })
            results.push({ lead_id: c.lead_id, error: 'slot_vergangen' })
            continue
          }
          // Slot inzwischen anderweitig belegt (Befund I3-3)? Nicht doppelt buchen,
          // sondern wie oben an Sven geben: ohne Kundennachricht, mit interner Notiz.
          if (await slotStillOk(admin, c.chosen_slot) !== 'ok') {
            await setConv(admin, c.id, { state: 'handoff', last_message: 'Terminart nie beantwortet, Slot inzwischen belegt - bitte manuell klaeren.' })
            try { await admin.from('activities').insert({ lead_id: c.lead_id, type: 'note', direction: 'inbound', subject: '⚠️ Termin-Bot: Slot inzwischen belegt', content: `Der Kunde hatte ${c.chosen_slot.label} Uhr gewählt, die Terminart aber nicht beantwortet. Der Slot ist inzwischen belegt, der Bot hat NICHT gebucht. Bitte persönlich einen Termin finden.`, completed_at: new Date().toISOString() }) } catch { /* egal */ }
            results.push({ lead_id: c.lead_id, error: 'slot_belegt' })
            continue
          }
          const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone, email').eq('id', c.lead_id).maybeSingle()
          await book(admin, c, lead as { first_name: string | null; whatsapp: string | null; phone: string | null; email: string | null }, c.chosen_slot, 'whatsapp')
          results.push({ lead_id: c.lead_id, booked: c.chosen_slot.label })
          console.log(`[booking-bot] sweep: ${c.chosen_slot.label} als WhatsApp gebucht (Lead ${c.lead_id})`)
        } catch (e) {
          console.error('[booking-bot] sweep:', e)
          results.push({ lead_id: c.lead_id, error: e instanceof Error ? e.message : String(e) })
        }
      }
      return json({ ok: true, swept: results.length, results })
    }
    // regel_test: seiteneffektfreier Test der festen Antwortregeln (kein Senden, kein
    // DB-Write). Mit lead_id auch der fertige Text samt Notiz für Sven.
    if (body.action === 'regel_test') {
      const text = body.text ?? ''
      const erkennung = await regelErkennen(text, [])
      const ergebnis = erkennung && body.lead_id ? await regelAusfuehren(admin, body.lead_id, null, text, erkennung, false) : null
      return json({ ok: true, vorfilter: regelVorfilter(text), erkennung, ergebnis })
    }
    // sprache_test: seiteneffektfreier Test der Antwortsprache (kein Senden, kein DB-Write).
    if (body.action === 'sprache_test') {
      const text = body.text ?? ''
      return json({ ok: true, erkannt: spracheErkennen(text), lage: body.lead_id ? await sprachLage(admin, body.lead_id, text) : null })
    }
    // engage_unknown kommt ohne lead_id: der Kontakt entsteht erst dort. Deshalb
    // zählt nur die Nachricht selbst, und Englisch nur, wenn sie eindeutig ist.
    if (body.action === 'engage_unknown') {
      const lauf = () => handleEngageUnknown(admin, body.phone ?? '', body.push_name ?? null, body.text ?? '')
      const nummer = nummer9(body.phone ?? '')
      return nummer && spracheErkennen(body.text ?? '') === 'en' && await spracheAn(admin) ? await inSprache(nummer, null, 'en', lauf) : await lauf()
    }
    // cafe_reaktion kommt von evolution-webhook ohne lead_id (nur Nummer und Ziel-ID).
    if (body.action === 'cafe_reaktion') return await cafeReaktion(admin, body.phone ?? '', body.emoji ?? '', body.ziel ?? '', body.uid ?? null)
    if (!body.lead_id) return json({ error: 'lead_id fehlt' }, 400)
    if (body.action === 'start') return await handleStart(admin, body.lead_id, body.deal_id ?? null, body.source ?? 'unknown')
    // fakten: seiteneffektfreier Test der Fakten-Antwort (kein Senden, kein DB-Write).
    if (body.action === 'fakten') return json({ ok: true, fakten: await faktenAntwort(admin, body.lead_id, null, body.text ?? '', []) })
    // Antworten auf eine Kundennachricht gehen in deren Sprache raus (mitSprache).
    const leadId = body.lead_id, text = body.text ?? ''
    if (body.action === 'answer') return await mitSprache(admin, leadId, text, () => handleAnswer(admin, leadId, text))
    if (body.action === 'engage') return await mitSprache(admin, leadId, text, () => handleEngage(admin, leadId, text, body.force === true))
    if (body.action === 'reply') return await mitSprache(admin, leadId, text, () => handleReply(admin, leadId, text))
    if (body.action === 'absage') return await mitSprache(admin, leadId, text, () => handleAbsage(admin, leadId, text, body.fallback, body.still === true))
    if (body.action === 'nudge') return await handleNudge(admin, body.lead_id, Number(body.stage) || 0, body.source ?? 'no_show', body.intro)
    return json({ error: `Unbekannte action: ${body.action}` }, 400)
  } catch (err) {
    console.error('[booking-bot] Fehler:', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
