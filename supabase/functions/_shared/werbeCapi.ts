// Conversions API (CAPI): Event-Bau und Versand an das Meta-Pixel.
//
// WARUM DIESE DATEI EXISTIERT:
// Der Event-Bau lag bis Oktober 2026 nur in meta-ads-sync (Schritt 1b, Tageslauf).
// Für die Echtzeit-Rückmeldung (werbe-signal aus capi_outbox) und den Tageslauf
// als Nachhol-Netz muss es GENAU EINE Implementierung geben, sonst laufen Hashing,
// Meta-Lead-Filter und Quell-URL auseinander. meta-ads-sync wird später auf
// dieses Modul umgestellt (nicht in diesem Schritt).
//
// Exporte (Signaturen zum direkten Einsetzen):
//   CAPI_EVENT_SOURCE_URL = 'https://portal.happy-property.com/termin'
//   CAPI_MAX_ALTER_SEK    = 7 Tage (älter verwirft Meta den GANZEN Sammel-POST)
//   META_UTM_SOURCES      = meta, facebook, fb, instagram, ig  (wie META_SOURCES in AdsManager.tsx)
//   interface CapiCandidate  - wie bisher in meta-ads-sync, plus optional first_name,
//                              last_name, country, meta_leadgen_id, content_category, currency
//   sha256(s)                -> hex
//   buildCapiEvent(c, nowSec?)   -> Event | null   (null: zu alt oder ohne Zuordnungsmerkmal)
//   istMetaLead(lead)        -> boolean  (utm_source Meta ODER source meta/meta_lead_form
//                              ODER fbc ODER meta_leadgen_id; fbp allein zählt NICHT)
//   kandidatAusLead(lead, basis) -> CapiCandidate   (Telefon = whatsapp ?? phone, Land aus Vorwahl)
//   CAPI_LEAD_FIELDS         Select-Liste für leads (enthält meta_leadgen_id: erst nach
//                            Migration 20261003101000_leads_meta_zuordnung.sql verwenden;
//                            davor CAPI_LEAD_FIELDS_ALT)
//   filterFrisch(events, nowSec?) -> { frisch, verworfen }
//   sendCapiEvents(events, { testEventCode?, pixelId? }) -> { events_received, verworfen, messages, fbtrace_id }
//
// Conversion-Leads (Conversions API für CRM, SPEC3 G2; Meta-Ziel „Anzahl qualifizierter
// Leads maximieren“ braucht das seit April 2026):
//   CRM_STUFEN                  lead, termin_gebucht, termin_stattgefunden, qualifiziert, kunde
//                               (event_name = Stufenname; GLEICH zu src/lib/werbeWerkzeuge.ts
//                               CRM_STUFEN und SQL werbe_capi_crm_stufe in 20261005100000)
//   CAPI_CRM_LEAD_EVENT_SOURCE  'Happy Property CRM'
//   crmStufenEventId(leadgenId, stufe) -> 'crm-<leadgen_id>-<stufe>' | null
//   istCrmStufenEventId(eventId)       -> boolean
//   crmDatensatzId()            Secret META_CRM_DATASET_ID, sonst Pixel (metaEnv().pixelId)
//   buildCrmStufenEvent(c, nowSec?) -> Event | null  (action_source system_generated,
//                               user_data.lead_id = Meta-Lead-ID, custom_data.event_source 'crm',
//                               custom_data.lead_event_source; null ohne gültige Lead-ID / zu alt)
//
// Regeln (Svens Entscheidungen, SPEC §3):
//   - Nur Meta-Leads (istMetaLead) melden; Filter macht der Aufrufer VOR buildCapiEvent.
//   - action_source 'website' nur mit Browserkennung (client_user_agent), sonst
//     'system_generated' ohne event_source_url/client_user_agent.
//   - Wert + content_category (kap_ja/kap_nein) auf Schedule nur, wenn übergeben.
//   - test_event_code nur für Tests mit Svens eigenen Daten.
//   - Versand über metaGraph.graphPost: respektiert META_WRITES_DISABLED. Der Aufrufer
//     schreibt capi_log erst NACH erfolgreichem Versand (dann geht nichts verloren).

import { graphPost, metaEnv } from './metaGraph.ts'

export const CAPI_EVENT_SOURCE_URL = 'https://portal.happy-property.com/termin'
export const CAPI_MAX_ALTER_SEK = 7 * 86_400
export const CAPI_MAX_EVENTS_JE_POST = 1000

export const META_UTM_SOURCES: readonly string[] = ['meta', 'facebook', 'fb', 'instagram', 'ig']
const META_LEAD_SOURCES: readonly string[] = ['meta', 'meta_lead_form']

export interface CapiCandidate {
  event_id: string
  event_name: string
  event_time: number            // Unix-Sekunden, max. 7 Tage alt
  lead_id: string | null
  email: string | null
  phone: string | null
  fbc?: string | null           // Klick-ID aus der Anzeige (im Funnel eingesammelt)
  fbp?: string | null           // Browser-ID des Pixels
  user_agent?: string | null    // nur für action_source 'website' erlaubt
  value?: number                // EUR (Purchase: Provision; Schedule: prognostizierter Wert)
  currency?: string             // Standard 'EUR'
  content_category?: string | null   // z.B. kap_ja / kap_nein (Schedule)
  first_name?: string | null
  last_name?: string | null
  country?: string | null       // ISO-3166 alpha-2, z.B. 'de'
  meta_leadgen_id?: string | null    // Sofortformular-Lead-ID -> user_data.lead_id
  // Termine entstehen auf /termin, sind also echte Website-Ereignisse. Alles
  // andere (Bewertung, Abschluss) passiert im CRM und bleibt system_generated.
  from_website?: boolean
}

export type CapiEvent = Record<string, unknown>

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Name nach Metas Vorgabe: klein, ohne Leerzeichen/Satzzeichen, UTF-8. */
export function normName(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFC').trim().toLowerCase().replace(/[^\p{L}\p{M}]/gu, '')
}

const LAENDER_VORWAHL: Array<[string, string]> = [
  ['357', 'cy'], ['49', 'de'], ['43', 'at'], ['41', 'ch'], ['352', 'lu'], ['423', 'li'],
]

/** Land aus einer Telefonnummer im internationalen Format (+49…, 0049…); sonst null. */
export function landAusTelefon(phone: string | null | undefined): string | null {
  const raw = String(phone ?? '').trim()
  if (!raw.startsWith('+') && !raw.startsWith('00')) return null
  const d = raw.replace(/[^0-9]/g, '').replace(/^00/, '')
  for (const [prefix, cc] of LAENDER_VORWAHL) if (d.startsWith(prefix)) return cc
  return null
}

const nowSec = () => Math.trunc(Date.now() / 1000)

/**
 * Baut ein Conversions-API-Event. Je mehr Zuordnungsmerkmale mitgehen, desto
 * höher bewertet Meta die Event Match Quality (0-10) und desto stärker fließt
 * das Ereignis in die Auslieferung ein. null, wenn das Event älter als 7 Tage
 * ist oder kein Merkmal (E-Mail, Telefon, Formular-Lead-ID) hat.
 */
export async function buildCapiEvent(c: CapiCandidate, jetztSek: number = nowSec()): Promise<CapiEvent | null> {
  if (!Number.isFinite(c.event_time) || c.event_time < jetztSek - CAPI_MAX_ALTER_SEK) return null
  const eventTime = Math.min(Math.trunc(c.event_time), jetztSek)   // Zukunft lehnt Meta ab

  const user_data: Record<string, unknown> = {}
  const email = c.email?.trim().toLowerCase()
  if (email) user_data.em = [await sha256(email)]
  const phone = c.phone?.replace(/[^0-9]/g, '').replace(/^00/, '')
  if (phone && phone.length >= 8) user_data.ph = [await sha256(phone)]
  const leadgen = String(c.meta_leadgen_id ?? '').replace(/[^0-9]/g, '')
  if (leadgen) user_data.lead_id = leadgen          // Metas Lead-ID, unverschlüsselt (Doku)
  if (!user_data.em && !user_data.ph && !user_data.lead_id) return null

  const fn = normName(c.first_name)
  if (fn) user_data.fn = [await sha256(fn)]
  const ln = normName(c.last_name)
  if (ln) user_data.ln = [await sha256(ln)]
  const country = String(c.country ?? '').trim().toLowerCase()
  if (/^[a-z]{2}$/.test(country)) user_data.country = [await sha256(country)]
  if (c.fbc) user_data.fbc = c.fbc
  if (c.fbp) user_data.fbp = c.fbp
  // Eigene, über alle Ereignisse eines Kontakts gleiche Kennung. Meta zählt sie
  // als vollwertiges Merkmal und kann damit Ereignisse desselben Menschen
  // zusammenführen, auch wenn Mail oder Nummer sich später ändern.
  if (c.lead_id) user_data.external_id = [await sha256(c.lead_id)]

  // Website-Ereignis nur MIT Browserkennung: Meta verlangt client_user_agent bei
  // action_source 'website' und lehnt sonst den ganzen Sammel-POST ab.
  const web = c.from_website === true && !!c.user_agent
  const ev: CapiEvent = {
    event_name: c.event_name,
    event_time: eventTime,
    event_id: c.event_id,
    action_source: web ? 'website' : 'system_generated',
    user_data,
  }
  if (web) {
    user_data.client_user_agent = c.user_agent
    ev.event_source_url = CAPI_EVENT_SOURCE_URL
  }
  const custom: Record<string, unknown> = {}
  if (typeof c.value === 'number' && Number.isFinite(c.value) && c.value > 0) {
    custom.currency = (c.currency || 'EUR').toUpperCase()
    custom.value = Math.round(c.value * 100) / 100
  }
  if (c.content_category) custom.content_category = String(c.content_category).slice(0, 100)
  if (Object.keys(custom).length) ev.custom_data = custom
  return ev
}

export interface MetaLeadMerkmale {
  utm_source?: string | null
  source?: string | null
  fbc?: string | null
  fbp?: string | null
  meta_leadgen_id?: string | null
}

/**
 * Nur Meta-Leads gehen an die Conversions API (Compliance + saubere Optimierung).
 * Meta-Lead = utm_source Meta ODER source meta/meta_lead_form ODER fbc (Klick-ID aus
 * einer Anzeige) ODER meta_leadgen_id (Sofortformular). fbp allein reicht NICHT:
 * unser Pixel setzt fbp bei jedem Besucher, auch bei Google-, YouTube- oder
 * Direkt-Leads (Entscheidung Orchestrator, CONTRACTS.md Runde 2).
 */
export function istMetaLead(lead: MetaLeadMerkmale | null | undefined): boolean {
  if (!lead) return false
  const utm = String(lead.utm_source ?? '').trim().toLowerCase()
  if (utm && META_UTM_SOURCES.includes(utm)) return true
  const src = String(lead.source ?? '').trim().toLowerCase()
  if (src && META_LEAD_SOURCES.includes(src)) return true
  if (String(lead.fbc ?? '').trim()) return true
  return !!String(lead.meta_leadgen_id ?? '').trim()
}

/** Felder eines Leads, die buildCapiEvent/istMetaLead brauchen. */
export interface CapiLead extends MetaLeadMerkmale {
  id: string
  email: string | null
  phone: string | null
  whatsapp: string | null
  client_user_agent?: string | null
  first_name?: string | null
  last_name?: string | null
}

/** Select-Liste für leads. Enthält meta_leadgen_id (erst nach Migration 20261003101000). */
export const CAPI_LEAD_FIELDS =
  'id, email, phone, whatsapp, fbc, fbp, client_user_agent, first_name, last_name, utm_source, source, meta_leadgen_id'
/** Wie CAPI_LEAD_FIELDS, aber ohne Spalten aus den Oktober-2026-Migrationen. */
export const CAPI_LEAD_FIELDS_ALT =
  'id, email, phone, whatsapp, fbc, fbp, client_user_agent, first_name, last_name, utm_source, source'

export interface CapiBasis {
  event_id: string
  event_name: string
  event_time: number
  from_website?: boolean
  value?: number
  currency?: string
  content_category?: string | null
}

/** Kandidat aus einer Lead-Zeile (Telefon = whatsapp ?? phone, Land aus der Vorwahl). */
export function kandidatAusLead(lead: CapiLead, basis: CapiBasis): CapiCandidate {
  const phone = lead.whatsapp ?? lead.phone ?? null
  return {
    ...basis,
    lead_id: lead.id,
    email: lead.email,
    phone,
    fbc: lead.fbc ?? null,
    fbp: lead.fbp ?? null,
    user_agent: lead.client_user_agent ?? null,
    first_name: lead.first_name ?? null,
    last_name: lead.last_name ?? null,
    country: landAusTelefon(phone),
    meta_leadgen_id: lead.meta_leadgen_id ?? null,
  }
}

/** Trennt zu alte Events ab (Meta verwirft sonst den ganzen POST). */
export function filterFrisch(events: CapiEvent[], jetztSek: number = nowSec()): { frisch: CapiEvent[]; verworfen: CapiEvent[] } {
  const frisch: CapiEvent[] = []
  const verworfen: CapiEvent[] = []
  for (const ev of events) {
    const t = Number(ev.event_time)
    if (Number.isFinite(t) && t >= jetztSek - CAPI_MAX_ALTER_SEK) frisch.push(ev)
    else verworfen.push(ev)
  }
  return { frisch, verworfen }
}

export interface CapiSendOptions {
  /** Test-Code aus dem Events Manager (ad_settings.capi_test_event_code); nur Svens Daten */
  testEventCode?: string | null
  /** Standard metaEnv().pixelId */
  pixelId?: string
}

export interface CapiSendResult {
  events_received: number
  /** event_ids, die wegen Alter > 7 Tage nicht gesendet wurden */
  verworfen: string[]
  messages: unknown[]
  fbtrace_id: string | null
}

/**
 * Sendet Events in EINEM POST an /{pixel}/events (max. 1000). Wirft MetaApiError
 * bei Fehlern (dann nichts in capi_log schreiben). Leere Liste -> kein Aufruf.
 */
export async function sendCapiEvents(events: CapiEvent[], opts: CapiSendOptions = {}): Promise<CapiSendResult> {
  const { frisch, verworfen } = filterFrisch(events)
  const verworfenIds = verworfen.map(e => String(e.event_id ?? ''))
  if (!frisch.length) return { events_received: 0, verworfen: verworfenIds, messages: [], fbtrace_id: null }
  if (frisch.length > CAPI_MAX_EVENTS_JE_POST) {
    throw new Error(`CAPI: höchstens ${CAPI_MAX_EVENTS_JE_POST} Events je Aufruf (übergeben: ${frisch.length})`)
  }
  const pixelId = String(opts.pixelId ?? metaEnv().pixelId).replace(/[^0-9]/g, '')
  if (!pixelId) throw new Error('CAPI: Pixel-ID fehlt')
  const body: Record<string, unknown> = { data: frisch }
  const code = String(opts.testEventCode ?? '').trim()
  if (code) body.test_event_code = code
  // Wiederholen ist gefahrlos: Meta entdoppelt über event_name + event_id.
  const j = await graphPost<{ events_received?: number; messages?: unknown[]; fbtrace_id?: string }>(
    `${pixelId}/events`, body, { idempotent: true },
  )
  return {
    events_received: typeof j?.events_received === 'number' ? j.events_received : frisch.length,
    verworfen: verworfenIds,
    messages: Array.isArray(j?.messages) ? j.messages : [],
    fbtrace_id: typeof j?.fbtrace_id === 'string' ? j.fbtrace_id : null,
  }
}

// ── Conversion-Leads: CRM-Stufen ────────────────────────────────────────────
// Payload laut Meta (Conversion Leads Integration, Payload Specification):
//   event_name frei = Stufe im CRM, ALLE Stufen ab dem Rohlead senden; event_time höchstens
//   7 Tage alt und NACH der Lead-Zeit; action_source 'system_generated';
//   custom_data { event_source: 'crm', lead_event_source: <CRM-Name> };
//   user_data.lead_id = 15-17-stellige leadgen_id (höchste Priorität), dazu gehashte E-Mail/Telefon.
// NICHT VERIFIZIERT gegen das echte Konto: lead_id geht als Ziffern-String (JS-Zahlen verlieren
// ab 16 Stellen Genauigkeit; Meta dokumentiert eine Zahl). Erst mit einem Testereignis
// (werbe-signal aktion 'test', interner Kontakt) prüfen, bevor capi_echtzeit eingeschaltet wird.
// Dafür reiht die DB Stufen interner Kontakte auch bei Echtzeit aus ein.
// Die Einstiegsstufe heißt NICHT „Lead“: das ist ein Standard-Ereignis im selben Pixel
// (Website-Lead); Meta würde Sofortformular-Leads sonst zusätzlich als Pixel-Lead zählen.

export const CAPI_CRM_LEAD_EVENT_SOURCE = 'Happy Property CRM'
export const CRM_EVENT_PREFIX = 'crm-'

/** Funnel-Reihenfolge. GLEICH zu src/lib/werbeWerkzeuge.ts (CRM_STUFEN) und SQL werbe_capi_crm_stufe. */
export const CRM_STUFEN: ReadonlyArray<{ key: string; event_name: string }> = [
  { key: 'lead', event_name: 'Lead aus Sofortformular' },
  { key: 'termin_gebucht', event_name: 'Termin gebucht' },
  { key: 'termin_stattgefunden', event_name: 'Termin stattgefunden' },
  { key: 'qualifiziert', event_name: 'Qualifiziert' },
  { key: 'kunde', event_name: 'Kunde' },
]

const LEADGEN_RE = /^[0-9]{15,17}$/

/** Meta-Lead-ID (nur Ziffern, 15-17 Stellen) oder null. */
export function leadgenIdOderNull(v: unknown): string | null {
  const d = String(v ?? '').trim().replace(/^l:/i, '').replace(/[^0-9]/g, '')
  return LEADGEN_RE.test(d) ? d : null
}

/** event_id einer CRM-Stufe: crm-<leadgen_id>-<stufe> (eine je Lead und Stufe). */
export function crmStufenEventId(leadgenId: unknown, stufe: string): string | null {
  const lg = leadgenIdOderNull(leadgenId)
  if (!lg || !CRM_STUFEN.some(s => s.key === stufe)) return null
  return `${CRM_EVENT_PREFIX}${lg}-${stufe}`
}

export function istCrmStufenEventId(eventId: unknown): boolean {
  return /^crm-[0-9]{15,17}-[a-z_]+$/.test(String(eventId ?? ''))
}

/** Datensatz für die CRM-Stufen: Secret META_CRM_DATASET_ID (falls Meta einen eigenen CRM-Datensatz verlangt), sonst das Pixel. */
export function crmDatensatzId(): string {
  const eigen = String(Deno.env.get('META_CRM_DATASET_ID') ?? '').replace(/[^0-9]/g, '')
  return eigen || metaEnv().pixelId
}

/**
 * Baut ein Conversion-Leads-Ereignis (CRM-Stufe). Nutzt buildCapiEvent für Hashing und
 * Altersgrenze, erzwingt dann die Pflichtfelder: system_generated, user_data.lead_id,
 * custom_data nur event_source + lead_event_source (kein Wert, keine Kategorie).
 * null: keine gültige Meta-Lead-ID, unbekannte Stufe oder älter als 7 Tage.
 */
export async function buildCrmStufenEvent(c: CapiCandidate, jetztSek: number = nowSec()): Promise<CapiEvent | null> {
  const leadgen = leadgenIdOderNull(c.meta_leadgen_id)
  if (!leadgen) return null
  if (!CRM_STUFEN.some(s => s.event_name === c.event_name)) return null
  const ev = await buildCapiEvent({
    ...c,
    meta_leadgen_id: leadgen,
    from_website: false,
    user_agent: null,
    value: undefined,
    currency: undefined,
    content_category: null,
  }, jetztSek)
  if (!ev) return null
  const user_data = (ev.user_data ?? {}) as Record<string, unknown>
  user_data.lead_id = leadgen
  delete user_data.client_user_agent
  ev.user_data = user_data
  ev.action_source = 'system_generated'
  delete ev.event_source_url
  ev.custom_data = { event_source: 'crm', lead_event_source: CAPI_CRM_LEAD_EVENT_SOURCE }
  return ev
}
