// Tests für den WhatsApp-Versand bei getrennter Nummer (Sperre vom 5.11.2026).
//
// Startet die echten Edge Functions send-whatsapp, masterclass-register, booking-bot,
// schedule-message und process-scheduled-messages offline und spielt die Fälle durch.
// Nachgebaut sind nur Deno, Datenbank, Uhr und Netz; der eigene WhatsApp-Server antwortet
// wahlweise „Connection Closed". Es geht nichts raus, jede Adresse ist erfunden und fetch
// ist ersetzt.
//
// Ausführen:
//   node scripts/verify-wa-getrennt.mjs
// Mit den Logs der Functions:
//   WA_TEST_LOG=1 node scripts/verify-wa-getrennt.mjs

import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'hpwa-getrennt-'))
const schreib = console.log.bind(console)

let fehler = 0
const ok = (bed, text) => {
  if (bed) schreib(`  ok   ${text}`)
  else { fehler++; schreib(`  FEHL ${text}`) }
}

// ── Uhr ──────────────────────────────────────────────────────────────────────
// Alles hängt am Termin der Masterclass, damit der Test nicht mit dem Kalender altert.
const quelle = readFileSync(join(root, 'supabase/functions/masterclass-register/index.ts'), 'utf8')
const [, EVENT, START] = quelle.match(/^ {2}'([^']+)': \{\n[^]*?startIso: '([^']+)'/m)
const EchtDate = Date
const MIN = 60_000
const tagUm = (versatzTage, stunde) => {
  const d = new EchtDate(EchtDate.parse(START) + versatzTage * 864e5)
  d.setUTCHours(stunde, 0, 0, 0)
  return d.getTime()
}
const TAGSUEBER = tagUm(-9, 10)  // mittags in Deutschland und auf Zypern
const NACHTS = tagUm(-9, 22)     // Mitternacht auf Zypern
let jetzt = TAGSUEBER
globalThis.Date = class extends EchtDate {
  constructor(...a) { if (a.length) super(...a); else super(jetzt) }
  static now() { return jetzt }
}
const vor = (min) => new Date(jetzt - min * MIN).toISOString()

// ── Deno ─────────────────────────────────────────────────────────────────────
const KEY = 'test-service-key'
const ENV = {
  SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: KEY, SUPABASE_ANON_KEY: 'test-anon',
  EVOLUTION_URL: 'https://evo.test', EVOLUTION_API_KEY: 'test-evo', EVOLUTION_INSTANCE: 'test',
  SMTP_USER: 'test@example.com', SMTP_PASS: 'test',
}
let geladen = null
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (f) => { geladen = f } }

// ── Datenbank ────────────────────────────────────────────────────────────────
const VORGABEN = {
  scheduled_messages: { retry_count: 0, recipient: 'client' },
  booking_conversations: { attempts: 0 },
  crm_appointments: { internal: false },
}
const kopie = (x) => JSON.parse(JSON.stringify(x))
let funktionen = {}  // Edge Functions hinter functions.invoke

function neueDb(start = {}) {
  const t = kopie(start)
  let nr = 0
  const zeitwert = (x) => (typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) ? EchtDate.parse(x) : x)
  const from = (name) => {
    let op = 'select', daten, einzeln = false, nurZaehlen = false, grenze = Infinity, sortierung = null, konflikt = null
    const bedingungen = []
    const lauf = () => {
      const zeilen = (t[name] ??= [])
      const passt = (r) => bedingungen.every((b) => b(r))
      let treffer
      if (op === 'insert' || op === 'upsert') {
        treffer = [].concat(daten).map((d) => {
          const alt = konflikt && zeilen.find((r) => konflikt.every((k) => r[k] === d[k]))
          if (alt) return Object.assign(alt, d)
          const neu = { id: `${name}-${++nr}`, created_at: new Date().toISOString(), ...VORGABEN[name], ...d }
          if (name === 'booking_conversations') neu.expires_at ??= new Date(Date.now() + 4 * 864e5).toISOString()
          if (name === 'wa_sent') neu.sent_at ??= new Date().toISOString()
          zeilen.push(neu)
          return neu
        })
      } else if (op === 'update') {
        treffer = zeilen.filter(passt)
        for (const r of treffer) Object.assign(r, daten)
      } else if (op === 'delete') {
        treffer = zeilen.filter(passt)
        t[name] = zeilen.filter((r) => !treffer.includes(r))
      } else {
        treffer = zeilen.filter(passt)
        if (sortierung) {
          const { spalte, auf } = sortierung
          treffer = [...treffer].sort((a, b) => (zeitwert(a[spalte]) > zeitwert(b[spalte]) ? 1 : -1) * (auf ? 1 : -1))
        }
        treffer = treffer.slice(0, grenze)
      }
      const data = kopie(treffer)
      if (nurZaehlen) return { data: null, count: data.length, error: null }
      return { data: einzeln ? data[0] ?? null : data, count: data.length, error: null }
    }
    const vergleich = (c, v, f) => { bedingungen.push((r) => r[c] != null && f(zeitwert(r[c]), zeitwert(v))); return p }
    const muster = (c, v) => {
      const re = new RegExp(`^${String(v).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
      bedingungen.push((r) => re.test(String(r[c] ?? '')))
      return p
    }
    const q = {
      select: (_s, o) => { if (o?.head) nurZaehlen = true; return p },
      insert: (d) => { op = 'insert'; daten = d; return p },
      upsert: (d, o) => { op = 'upsert'; daten = d; konflikt = o?.onConflict?.split(',') ?? null; return p },
      update: (d) => { op = 'update'; daten = d; return p },
      delete: () => { op = 'delete'; return p },
      eq: (c, v) => { bedingungen.push((r) => (r[c] ?? null) === v); return p },
      neq: (c, v) => { bedingungen.push((r) => (r[c] ?? null) !== v); return p },
      is: (c, v) => { bedingungen.push((r) => (r[c] ?? null) === v); return p },
      in: (c, l) => { bedingungen.push((r) => l.includes(r[c])); return p },
      not: (c, o, v) => {
        bedingungen.push((r) => (o === 'in' ? !String(v).slice(1, -1).split(',').includes(String(r[c])) : (r[c] ?? null) !== v))
        return p
      },
      gt: (c, v) => vergleich(c, v, (a, b) => a > b),
      gte: (c, v) => vergleich(c, v, (a, b) => a >= b),
      lt: (c, v) => vergleich(c, v, (a, b) => a < b),
      lte: (c, v) => vergleich(c, v, (a, b) => a <= b),
      ilike: muster,
      like: muster,
      order: (c, o) => { sortierung = { spalte: c, auf: o?.ascending !== false }; return p },
      limit: (n) => { grenze = n; return p },
      single: () => { einzeln = true; return p },
      maybeSingle: () => { einzeln = true; return p },
      then: (a, b) => Promise.resolve().then(lauf).then(a, b),
      catch: (f) => Promise.resolve().then(lauf).catch(f),
    }
    // Alles Übrige (or, range, ...) schränkt hier nichts ein.
    const p = new Proxy(q, { get: (z, k) => (k in z ? z[k] : () => p) })
    return p
  }
  return {
    tabellen: t,
    from,
    rpc: async (f, a) => {
      if (f === 'find_leads_by_phone_suffix') return { data: (t.leads ?? []).filter((l) => String(l.whatsapp || l.phone).replace(/\D/g, '').endsWith(a.suffix)).map((l) => ({ id: l.id })), error: null }
      if (f !== 'claim_scheduled_messages') return { data: null, error: null }
      const faellig = (t.scheduled_messages ??= [])
        .filter((r) => r.status === 'pending' && EchtDate.parse(r.scheduled_at) <= jetzt)
        .sort((x, y) => EchtDate.parse(x.scheduled_at) - EchtDate.parse(y.scheduled_at))
        .slice(0, a.p_limit)
      for (const r of faellig) r.status = 'processing'
      return { data: kopie(faellig), error: null }
    },
  }
}
let db = neueDb()
const zeilen = (name) => db.tabellen[name] ?? []
const zeile = (name, f) => zeilen(name).find(f)

// ── Fremde Pakete ────────────────────────────────────────────────────────────
const mails = []
const client = {
  from: (...a) => db.from(...a),
  rpc: (...a) => db.rpc(...a),
  functions: { invoke: async (name, o) => (funktionen[name] ? funktionen[name](o?.body) : { data: { ok: true }, error: null }) },
  auth: { getUser: async () => ({ data: { user: null } }) },
}
globalThis.__fremd = {
  createClient: () => client,
  SMTPClient: class { async send(m) { mails.push(m) } async close() {} },
  Image: class {},
}
const fremd = {
  name: 'fremd',
  setup(b) {
    b.onResolve({ filter: /^(jsr:|npm:|https?:)|_vendor\/imagescript/ }, (a) => ({ path: a.path, namespace: 'fremd' }))
    b.onLoad({ filter: /.*/, namespace: 'fremd' }, () => ({ contents: 'module.exports = globalThis.__fremd', loader: 'js' }))
  },
}
const lade = async (pfad, name) => {
  const outfile = join(dir, `${name}.mjs`)
  await build({ entryPoints: [join(root, 'supabase/functions', pfad)], bundle: true, format: 'esm', platform: 'neutral', outfile, plugins: [fremd], logLevel: 'warning', target: 'es2022' })
  geladen = null
  const modul = await import(outfile)
  return { modul, handler: geladen }
}
const P = (await lade('_shared/waProvider.ts', 'waProvider')).modul
const hSend = (await lade('send-whatsapp/index.ts', 'send-whatsapp')).handler
const hAnmeldung = (await lade('masterclass-register/index.ts', 'masterclass-register')).handler
const hBot = (await lade('booking-bot/index.ts', 'booking-bot')).handler
const hPlaner = (await lade('process-scheduled-messages/index.ts', 'process-scheduled-messages')).handler
const hSchedule = (await lade('schedule-message/index.ts', 'schedule-message')).handler
if (!process.env.WA_TEST_LOG) console.log = console.warn = console.error = () => {}

// ── Netz ─────────────────────────────────────────────────────────────────────
const antwort = (status, json) => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
let nachrichtNr = 0
const EVO_OK = () => antwort(201, { key: { id: `WA${++nachrichtNr}` }, status: 'PENDING' })
const EVO_GETRENNT = () => antwort(400, { status: 400, error: 'Bad Request', response: { message: ['Error: Connection Closed'] } })
const EVO_KEIN_WA = () => antwort(400, { status: 400, error: 'Bad Request', response: { message: [{ exists: false, number: '0' }] } })
let evo = EVO_OK
let evoAufrufe = []
let wege = {}  // URL-Teil -> Antwort
let netzLog = []
globalThis.fetch = async (url, init = {}) => {
  const u = String(url?.url ?? url)
  netzLog.push(u)
  if (u.startsWith(ENV.EVOLUTION_URL)) {
    evoAufrufe.push(u)
    return evo(u, JSON.parse(init.body))
  }
  for (const [teil, f] of Object.entries(wege)) if (u.includes(teil)) return f(u, init)
  return new Response('nicht nachgebaut', { status: 404 })
}

const TEST_NUMMER = '+35795096409'
const LEAD = 'lead-1'
const grunddaten = () => ({
  leads: [{ id: LEAD, first_name: 'Test', last_name: 'Kunde', email: 'test@example.com', phone: TEST_NUMMER, whatsapp: TEST_NUMMER, language: 'de' }],
  crm_settings: [{ key: 'booking_bot_enabled', value: 'true' }],
})
const start = (daten = grunddaten()) => {
  db = neueDb(daten); evo = EVO_OK; evoAufrufe = []; netzLog = []; wege = {}; funktionen = {}; mails.length = 0; jetzt = TAGSUEBER
}
const aufruf = (h, body, kopf = { apikey: KEY }) => h(new Request('https://fn.test/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...kopf }, body: JSON.stringify(body) }))
// Echte Function hinter functions.invoke: wie supabase-js, Fehlerstatus kommt als error.
const echteFunktion = (h) => async (body) => {
  const r = await aufruf(h, body)
  const data = await r.json()
  return r.ok ? { data, error: null } : { data: null, error: new Error(data.error ?? `HTTP ${r.status}`) }
}
const echteSendWhatsapp = echteFunktion(hSend)

// ── Fehlertexte ──────────────────────────────────────────────────────────────
schreib('Erkennung der Trennung')
for (const t of [P.evoErrorText(400, { message: 'Connection Closed' }), 'Instanz getrennt', 'not connected', 'Whatsapp account not found']) ok(P.waGetrennt(t), `getrennt: „${t}"`)
for (const t of ['Diese Nummer hat kein WhatsApp.', P.evoErrorText(0, { error: 'timeout' }), P.evoErrorText(500, { error: 'x' }), '', null, undefined]) ok(!P.waGetrennt(t), `nicht getrennt: „${t}"`)

// ── send-whatsapp ────────────────────────────────────────────────────────────
schreib('\nsend-whatsapp: Aktivität nur bei Erfolg')
const direkt = { event_type: 'masterclass_confirmation', lead_id: LEAD, auto: true, lang: 'de', already_translated: true, lead_data: { lead_name: 'Test Kunde', lead_phone: TEST_NUMMER }, override_text: 'Du bist dabei.' }
let antwortGetrennt
{
  start()
  evo = EVO_GETRENNT
  const r = await aufruf(hSend, direkt)
  antwortGetrennt = await r.json()
  ok(r.status === 200 && antwortGetrennt.success === false, 'getrennt: Antwort success:false')
  ok(P.waGetrennt(antwortGetrennt.error), 'getrennt: Fehlertext wird als Trennung erkannt')
  ok(!zeile('activities', (a) => a.type === 'whatsapp'), 'getrennt: keine WhatsApp im Verlauf')
  const n = zeile('activities', (a) => a.type === 'note')
  ok(n?.subject === '⚠️ WhatsApp NICHT gesendet: masterclass_confirmation', 'getrennt: Notiz mit klarem Betreff')
  ok(n?.content.startsWith('NICHT gesendet') && n.content.includes('Du bist dabei.') && n.content.includes('Test Kunde: WhatsApp-Nummer'), 'getrennt: Notiz nennt Grund und geplanten Text')
  ok(n?.direction === 'outbound' && n?.auto === true && !!n?.completed_at, 'getrennt: Notiz ist ausgehend und automatisch')
  ok(zeilen('wa_sent').length === 0, 'getrennt: Doppel-Schutz merkt sich den Fehlversuch nicht')
  ok(!!zeile('crm_settings', (s) => s.key === 'wa_account_alert_sent_at')?.value, 'getrennt: Alarm an Sven läuft wie bisher')

  evo = EVO_OK
  const j = await (await aufruf(hSend, direkt)).json()
  ok(j.success === true && !j.skipped_duplicate, 'wieder verbunden: derselbe Text geht durch, kein Doppel')
  const w = zeilen('activities').filter((a) => a.type === 'whatsapp')
  ok(w.length === 1 && w[0].subject === 'WhatsApp: masterclass_confirmation' && w[0].content === 'Du bist dabei.', 'wieder verbunden: WhatsApp steht im Verlauf')
  ok(zeilen('activities').filter((a) => a.type === 'note').length === 1, 'wieder verbunden: keine zweite Notiz')
  ok(zeilen('wa_sent').length === 1, 'wieder verbunden: Doppel-Schutz merkt sich den Versand')
  const d = await (await aufruf(hSend, direkt)).json()
  ok(d.skipped_duplicate === true, 'dritter Versuch: Doppel-Schutz greift weiter')
}
{
  // Ohne lead_id (Termin-Bot, Scheduler): die protokollieren selbst nach dem Erfolg.
  start()
  evo = EVO_GETRENNT
  const { lead_id: _, ...ohne } = direkt
  await aufruf(hSend, ohne)
  ok(zeilen('activities').length === 0, 'ohne lead_id: keine Aktivität')
}
const PARTNER = '+35799000000'
const mitVorlage = () => ({
  ...grunddaten(),
  whatsapp_templates: [{ event_type: 'test_vorlage', active: true, message_template: 'Hallo', recipients: [{ name: 'Test Kunde', phone: TEST_NUMMER }, { name: 'Partner', phone: PARTNER }] }],
})
{
  start(mitVorlage())
  evo = (_u, b) => (b.number === TEST_NUMMER.slice(1) ? EVO_OK() : EVO_GETRENNT())
  const j = await (await aufruf(hSend, { event_type: 'test_vorlage', lead_id: LEAD })).json()
  ok(j.success === true, 'zwei Empfänger, einer scheitert: Erfolg')
  ok(zeile('activities', (a) => a.type === 'whatsapp')?.subject === 'WhatsApp: test_vorlage', 'zwei Empfänger: WhatsApp an den Kunden im Verlauf')
  const n = zeile('activities', (a) => a.type === 'note')
  ok(n?.content.includes('Partner: ') && !n.content.includes('Test Kunde: '), 'zwei Empfänger: Notiz nennt nur den Gescheiterten')
}
{
  start(mitVorlage())
  evo = (_u, b) => (b.number === PARTNER.slice(1) ? EVO_OK() : EVO_GETRENNT())
  await aufruf(hSend, { event_type: 'test_vorlage', lead_id: LEAD })
  ok(zeile('activities', (a) => a.type === 'whatsapp')?.subject === 'Intern an Partner (nicht an den Kunden)', 'nur der Partner erreicht: kein „an den Kunden" und nur sein Name')
  ok(zeile('activities', (a) => a.type === 'note')?.content.includes('Test Kunde: '), 'nur der Partner erreicht: Notiz nennt den Kunden')
}
{
  start()
  let n = 0
  evo = () => (++n === 1 ? EVO_OK() : EVO_GETRENNT())
  const j = await (await aufruf(hSend, { ...direkt, override_text: 'Ein langer Satz für mehrere Teile. '.repeat(120) })).json()
  ok(j.success === false, 'Teil 2 scheitert: kein Erfolg')
  ok(!zeile('activities', (a) => a.type === 'whatsapp'), 'Teil 2 scheitert: keine WhatsApp im Verlauf')
  ok(/nur 1 von \d Teilen sind raus/.test(zeile('activities', (a) => a.type === 'note')?.content ?? ''), 'Teil 2 scheitert: Notiz sagt, was schon raus ist')
  ok(zeilen('wa_sent').length === 0, 'Teil 2 scheitert: Doppel-Schutz merkt sich nichts')
}
{
  start()
  evo = (u) => (u.includes('/sendContact/') ? EVO_GETRENNT() : EVO_OK())
  const j = await (await aufruf(hSend, { ...direkt, contact_card: { name: 'Test', phone: TEST_NUMMER } })).json()
  ok(j.success === true && !!zeile('activities', (a) => a.type === 'whatsapp') && !zeile('activities', (a) => a.type === 'note'), 'nur die Kontaktkarte scheitert: gilt als gesendet, keine Notiz')
}
{
  start()
  evo = EVO_KEIN_WA
  const j = await (await aufruf(hSend, direkt)).json()
  ok(j.error === 'Diese Nummer hat kein WhatsApp.' && zeile('activities', (a) => a.type === 'note')?.content.includes('kein WhatsApp'), 'anderer Fehler: Notiz mit Grund')
}

// ── masterclass-register ─────────────────────────────────────────────────────
schreib('\nmasterclass-register: Bestätigung nachholen')
const anmeldung = { event: EVENT, first_name: 'Test', last_name: 'Kunde', email: 'test@example.com', phone: TEST_NUMMER }
let waBody = null
const anmeldeNetz = (wa) => {
  wege = {
    '/functions/v1/send-email': () => antwort(200, { ok: true }),
    '/functions/v1/send-whatsapp': (_u, init) => { waBody = JSON.parse(init.body); return wa() },
  }
}
const waZeilen = () => zeilen('scheduled_messages').filter((z) => z.type === 'whatsapp')
{
  start({})
  anmeldeNetz(() => antwort(200, antwortGetrennt))
  const r = await aufruf(hAnmeldung, anmeldung, {})
  ok(r.status === 200 && (await r.json()).ok === true, 'getrennt: Anmeldung gelingt trotzdem')
  const [z, ...rest] = waZeilen()
  ok(!!z && rest.length === 0, 'getrennt: genau eine Zeile zum Nachholen')
  ok(z?.event_type === 'newsletter' && z?.status === 'pending' && z?.wa_part === 0, 'Zeile: Newsletter-Typ (Bremse, Abmeldung) und wartet beim Limit')
  ok(z?.subscriber_id === zeilen('newsletter_subscribers')[0]?.id && z?.lead_id === zeilen('leads')[0]?.id, 'Zeile: hängt an Abonnent und Lead')
  ok(EchtDate.parse(z?.scheduled_at) === jetzt + 30 * MIN, 'Zeile: in 30 Minuten')
  ok(z?.whatsapp_text === waBody.override_text && (z?.whatsapp_image_url ?? undefined) === waBody.file_url, 'Zeile: derselbe Text und dasselbe Bild')
  ok(z?.seq_condition?.kind === 'nur_bis' && z?.seq_condition?.bis === START, 'Zeile: gilt nur bis zum Start')
  ok(!!zeile('activities', (a) => a.subject?.startsWith('🔁')), 'Akte: Hinweis, dass automatisch wiederholt wird')
  ok(zeilen('scheduled_messages').filter((m) => m.type === 'email').length === 3, 'die drei Erinnerungsmails bleiben geplant')

  await aufruf(hAnmeldung, anmeldung, {})
  ok(waZeilen().length === 1, 'doppelte Anmeldung: keine zweite Zeile')
}
{
  // Kurz vor dem Start löscht Schritt 4 offene Zeilen im Zeitfenster. Die neue muss bleiben.
  start({})
  jetzt = EchtDate.parse(START) - 150 * MIN
  anmeldeNetz(() => antwort(200, antwortGetrennt))
  await aufruf(hAnmeldung, anmeldung, {})
  await aufruf(hAnmeldung, anmeldung, {})
  ok(waZeilen().length === 1 && waZeilen()[0].status === 'pending', 'kurz vor dem Start, doppelt angemeldet: Zeile überlebt das Aufräumen')
}
{
  start({})
  jetzt = EchtDate.parse(START) - 20 * MIN
  anmeldeNetz(() => antwort(200, antwortGetrennt))
  await aufruf(hAnmeldung, anmeldung, {})
  ok(waZeilen().length === 0 && !zeile('activities', (a) => a.subject?.startsWith('🔁')), '20 Minuten vor dem Start: nicht mehr einreihen')
}
for (const [fall, wa] of [
  ['verbunden', () => antwort(200, { success: true, sent: 1, results: [{ ok: true }] })],
  ['Nummer ohne WhatsApp', () => antwort(200, { success: false, error: 'Diese Nummer hat kein WhatsApp.' })],
  ['Absturz von send-whatsapp', () => new Response('Internal Server Error', { status: 500 })],
]) {
  start({})
  anmeldeNetz(wa)
  const r = await aufruf(hAnmeldung, anmeldung, {})
  ok(r.status === 200 && waZeilen().length === 0, `${fall}: nichts einreihen, Anmeldung gelingt`)
}

// ── booking-bot ──────────────────────────────────────────────────────────────
schreib('\nbooking-bot: kein Geister-Gespräch')
const bot = (body) => aufruf(hBot, body)
const konv = () => zeilen('booking_conversations')
{
  start()
  funktionen['send-whatsapp'] = echteSendWhatsapp
  evo = EVO_GETRENNT
  const r = await bot({ action: 'start', lead_id: LEAD, source: 'no_show' })
  ok(r.status === 500 && P.waGetrennt((await r.json()).error), 'start, getrennt: Fehler mit erkennbarem Grund')
  ok(konv().length === 0, 'start, getrennt: kein Gespräch bleibt')
  ok(!zeile('activities', (a) => a.type === 'whatsapp') && zeilen('scheduled_messages').length === 0, 'start, getrennt: kein Protokoll, keine Folge-Nudges')

  evo = EVO_OK
  const r2 = await bot({ action: 'start', lead_id: LEAD, source: 'no_show' })
  ok(r2.status === 200 && !(await r2.json()).skipped, 'start, wieder verbunden: Wiederholung wird nicht als aktives Gespräch übersprungen')
  ok(konv().length === 1 && konv()[0].state === 'awaiting_choice', 'start, wieder verbunden: Gespräch steht')
  ok(zeilen('scheduled_messages').length === 5 && !!zeile('activities', (a) => a.subject === 'WhatsApp: Termin-Bot'), 'start, wieder verbunden: Protokoll und Folge-Nudges')
}
{
  start()
  funktionen['send-whatsapp'] = echteSendWhatsapp
  evo = EVO_GETRENNT
  const r = await bot({ action: 'nudge', lead_id: LEAD, stage: 1, source: 'no_show' })
  ok(r.status === 500 && konv().length === 0, 'nudge ohne Gespräch, getrennt: kein Gespräch bleibt')
  evo = EVO_OK
  const r2 = await bot({ action: 'nudge', lead_id: LEAD, stage: 1, source: 'no_show' })
  ok(r2.status === 200 && konv().length === 1 && konv()[0].proposed_slots?.length === 2, 'nudge ohne Gespräch, wieder verbunden: Gespräch mit Vorschlägen')
}
const altesGespraech = (extra) => ({
  id: 'konv-1', lead_id: LEAD, source: 'no_show', state: 'awaiting_choice', proposed_slots: [{ label: 'alt' }], last_message: 'alter Vorschlag',
  attempts: 2, snoozed_until: null, created_at: vor(60), expires_at: new Date(jetzt + 864e5).toISOString(), ...extra,
})
{
  start()
  const alt = altesGespraech()
  db = neueDb({ ...grunddaten(), booking_conversations: [alt] })
  funktionen['send-whatsapp'] = echteSendWhatsapp
  evo = EVO_GETRENNT
  const r = await bot({ action: 'nudge', lead_id: LEAD, stage: 2, source: 'no_show' })
  const k = konv()[0]
  ok(r.status === 500 && k.last_message === 'alter Vorschlag' && k.proposed_slots[0].label === 'alt' && k.expires_at === alt.expires_at, 'nudge mit Gespräch, getrennt: gilt weiter, was der Kunde zuletzt gesehen hat')
  evo = EVO_OK
  await bot({ action: 'nudge', lead_id: LEAD, stage: 2, source: 'no_show' })
  ok(konv()[0].last_message !== 'alter Vorschlag', 'nudge mit Gespräch, wieder verbunden: neuer Vorschlag steht')
}
{
  start()
  const bis = vor(5)
  db = neueDb({ ...grunddaten(), booking_conversations: [altesGespraech({ state: 'snoozed', snoozed_until: bis })] })
  funktionen['send-whatsapp'] = echteSendWhatsapp
  evo = EVO_GETRENNT
  const r = await bot({ action: 'nudge', lead_id: LEAD, stage: 1, source: 'snooze' })
  const k = konv()[0]
  ok(r.status === 500 && k.state === 'snoozed' && k.snoozed_until === bis && k.attempts === 2, 'Wiedervorlage, getrennt: Gespräch schläft weiter')
  evo = EVO_OK
  const r2 = await (await bot({ action: 'nudge', lead_id: LEAD, stage: 1, source: 'snooze' })).json()
  ok(!r2.skipped && konv()[0].state === 'awaiting_choice' && konv()[0].snoozed_until === null && konv()[0].attempts === 0, 'Wiedervorlage, wieder verbunden: wird wie vorher geweckt')
}
{
  // Antwortet der Kunde, während der Versand scheitert, bleibt seine Antwort stehen.
  start()
  db = neueDb({ ...grunddaten(), booking_conversations: [altesGespraech()] })
  funktionen['send-whatsapp'] = async () => {
    db.tabellen.booking_conversations[0].state = 'awaiting_type'
    return { data: antwortGetrennt, error: null }
  }
  await bot({ action: 'nudge', lead_id: LEAD, stage: 2, source: 'no_show' })
  ok(konv()[0].state === 'awaiting_type' && konv()[0].last_message !== 'alter Vorschlag', 'Gespräch inzwischen weiter: nicht zurückgesetzt')
}
{
  // Keine WhatsApp auf der Nummer: Merker bleibt wie bisher, sonst bei jeder Deck-Ansicht neu.
  start()
  funktionen['send-whatsapp'] = echteSendWhatsapp
  evo = EVO_KEIN_WA
  const r = await bot({ action: 'start', lead_id: LEAD, source: 'deck_viewed' })
  ok(r.status === 500 && konv().length === 1, 'Nummer ohne WhatsApp: Gespräch bleibt als Merker')
}
{
  start()
  funktionen['send-whatsapp'] = echteSendWhatsapp
  evo = EVO_GETRENNT
  const r = await bot({ action: 'nudge', lead_id: LEAD, stage: 0, source: 'zufriedenheit' })
  ok(r.status === 500 && konv().length === 0, 'Zufriedenheit, getrennt: erst senden, also kein Gespräch')
}

// ── process-scheduled-messages ───────────────────────────────────────────────
schreib('\nprocess-scheduled-messages: Wiederholung')
const planer = async () => (await aufruf(hPlaner, {}, { Authorization: `Bearer ${KEY}` })).json()
const botZeile = (extra = {}) => ({
  id: 'zeile-1', lead_id: LEAD, deal_id: null, type: 'whatsapp', event_type: 'bot_nudge', status: 'pending', recipient: 'client', retry_count: 0,
  bot_nudge_stage: 1, bot_nudge_source: 'no_show', scheduled_at: vor(1), created_at: vor(1440), ...extra,
})
const planerBot = (extra) => {
  start()
  db = neueDb({ ...grunddaten(), scheduled_messages: [botZeile(extra)] })
  funktionen['send-whatsapp'] = echteSendWhatsapp
  wege['/functions/v1/booking-bot'] = (u, init) => hBot(new Request(u, init))
}
const dieZeile = () => zeilen('scheduled_messages')[0]
{
  planerBot()
  evo = EVO_GETRENNT
  const j = await planer()
  const z = dieZeile()
  ok(j.details?.[0]?.result === 'retry:account', 'Nudge, getrennt: wird wiederholt statt failed')
  ok(z.status === 'pending' && z.retry_count === 1 && EchtDate.parse(z.scheduled_at) === jetzt + 30 * MIN, 'Nudge, getrennt: in 30 Minuten, Zähler 1')
  ok(/Wiederholung 1\/48/.test(z.error_message), 'Nudge, getrennt: Grund sichtbar')
  ok(konv().length === 0, 'Nudge, getrennt: kein Geister-Gespräch')
  ok(!zeile('activities', (a) => a.type === 'whatsapp'), 'Nudge, getrennt: nichts als gesendet protokolliert')

  jetzt += 31 * MIN
  evo = EVO_OK
  const j2 = await planer()
  const z2 = dieZeile()
  ok(j2.details?.[0]?.result === 'bot_nudge:1' && z2.status === 'sent', 'Nudge, wieder verbunden: raus')
  ok(z2.error_message === null, 'Nudge, wieder verbunden: alter Hinweis ist weg')
  ok(konv().length === 1 && !!zeile('activities', (a) => a.subject === 'WhatsApp: Termin-Bot'), 'Nudge, wieder verbunden: Gespräch und Protokoll stehen')
}
{
  planerBot({ bot_nudge_stage: 0, bot_nudge_source: 'no_show' })
  evo = EVO_GETRENNT
  await planer()
  ok(dieZeile().status === 'pending' && dieZeile().retry_count === 1 && konv().length === 0, 'Start, getrennt: wird wiederholt, kein Geister-Gespräch')
  jetzt += 31 * MIN
  evo = EVO_OK
  const j = await planer()
  ok(j.details?.[0]?.result === 'bot_start:0' && dieZeile().status === 'sent' && konv().length === 1, 'Start, wieder verbunden: raus, nicht als aktives Gespräch übersprungen')
}
{
  planerBot({ retry_count: 48 })
  evo = EVO_GETRENNT
  await planer()
  ok(dieZeile().status === 'failed' && dieZeile().error_message === 'Termin-Bot-Aufruf fehlgeschlagen', 'nach 48 Wiederholungen: failed wie bisher')
  ok(konv().length === 0, 'nach 48 Wiederholungen: kein Geister-Gespräch')
}
{
  planerBot({ bot_nudge_stage: 0, bot_nudge_source: 'deck_viewed' })
  evo = EVO_GETRENNT
  const j = await planer()
  ok(j.details?.[0]?.result === 'retry:account' && mails.length === 0, 'Deck-Nachfrage, getrennt: erst wiederholen, noch keine Ersatz-Mail')
}
{
  planerBot({ bot_nudge_stage: 0, bot_nudge_source: 'deck_viewed', retry_count: 48 })
  evo = EVO_GETRENNT
  const j = await planer()
  ok(j.details?.[0]?.result === 'bot_mail_ersatz' && mails.length === 1, 'Deck-Nachfrage nach 48 Wiederholungen: Ersatz-Mail wie bisher')
}
{
  planerBot()
  evo = EVO_KEIN_WA
  await planer()
  ok(dieZeile().status === 'failed' && dieZeile().retry_count === 0, 'Nummer ohne WhatsApp: sofort failed wie bisher')
}
{
  planerBot()
  wege['/functions/v1/booking-bot'] = () => antwort(500, { error: 'Datenbank weg' })
  await planer()
  ok(dieZeile().status === 'failed' && dieZeile().retry_count === 0, 'anderer Bot-Fehler: sofort failed wie bisher')
}
{
  planerBot({ retry_count: 1, scheduled_at: new Date(NACHTS - MIN).toISOString() })
  jetzt = NACHTS
  evo = EVO_OK
  const j = await planer()
  const z = dieZeile()
  const stunde = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', hour: '2-digit', hourCycle: 'h23' }).format(new EchtDate(z.scheduled_at)))
  ok(j.details?.[0]?.result === 'ruhezeit' && z.status === 'pending' && z.retry_count === 1, 'Nudge-Wiederholung nachts: rückt in den Morgen')
  ok(EchtDate.parse(z.scheduled_at) > NACHTS && stunde >= 8 && stunde < 21, `Nudge-Wiederholung nachts: neuer Versuch um ${stunde} Uhr auf Zypern`)
  ok(!netzLog.some((u) => u.includes('/booking-bot')), 'Nudge-Wiederholung nachts: Bot wird nicht gerufen')
}

schreib('\nprocess-scheduled-messages: nachgeholte Bestätigung')
// Die Zeile kommt aus der echten Anmeldung von oben.
const nachholZeile = async () => {
  start({})
  anmeldeNetz(() => antwort(200, antwortGetrennt))
  await aufruf(hAnmeldung, anmeldung, {})
  wege = {}
  return waZeilen()[0]
}
let gesendet = []
const waAntworten = (data) => { gesendet = []; funktionen['send-whatsapp'] = async (b) => { gesendet.push(b); return { data, error: null } } }
const WA_OK = { success: true, sent: 1, results: [{ ok: true, data: { id: 'x' } }] }
const fertig = (id) => zeile('scheduled_messages', (z) => z.id === id)
{
  const z = await nachholZeile()
  waAntworten(antwortGetrennt)
  jetzt += 31 * MIN
  const j = await planer()
  const d = fertig(z.id)
  ok(j.details?.[0]?.result === 'retry:account' && d.status === 'pending' && d.retry_count === 1, 'noch getrennt: Wiederholung wie jede andere Zeile')
  ok(gesendet[0]?.override_text === z.whatsapp_text && gesendet[0]?.lead_data?.lead_phone === TEST_NUMMER, 'noch getrennt: Versuch an die Nummer aus dem Formular')
  ok(gesendet[0]?.file_url === (z.whatsapp_image_url ?? undefined), 'noch getrennt: mit dem Bild der Bestätigung')
  ok(mails.length === 0, 'noch getrennt: keine Ersatz-Mail')
  const vorher = zeilen('activities').length

  waAntworten(WA_OK)
  jetzt += 31 * MIN
  const j2 = await planer()
  const d2 = fertig(z.id)
  ok(j2.details?.[0]?.result === 'sent' && d2.status === 'sent' && d2.error_message === null, 'wieder verbunden: raus, alter Hinweis weg')
  const neu = zeilen('activities').slice(vorher)
  ok(neu.length === 1 && neu[0].type === 'whatsapp' && neu[0].content === z.whatsapp_text && neu[0].lead_id === z.lead_id, 'wieder verbunden: WhatsApp steht in der Kundenakte')
  ok(mails.length === 0, 'wieder verbunden: keine zweite Mail')
}
{
  const z = await nachholZeile()
  waAntworten(antwortGetrennt)
  db.tabellen.scheduled_messages.find((m) => m.id === z.id).retry_count = 48
  jetzt += 31 * MIN
  await planer()
  ok(fertig(z.id).status === 'failed' && mails.length === 0, 'nach 48 Wiederholungen: failed, keine zweite Mail')
}
{
  const z = await nachholZeile()
  waAntworten(WA_OK)
  jetzt = tagUm(1, 10)
  const j = await planer()
  const d = fertig(z.id)
  ok(j.details?.find((x) => x.id === z.id)?.result === 'skipped:nur_bis' && d.status === 'skipped' && gesendet.length === 0, 'nach dem Start der Masterclass: entfällt, nichts geht raus')
}
{
  const z = await nachholZeile()
  waAntworten(WA_OK)
  jetzt = NACHTS
  db.tabellen.scheduled_messages.find((m) => m.id === z.id).scheduled_at = new Date(NACHTS - MIN).toISOString()
  db.tabellen.scheduled_messages.find((m) => m.id === z.id).created_at = new Date(NACHTS - 31 * MIN).toISOString()
  const j = await planer()
  ok(j.details?.find((x) => x.id === z.id)?.result === 'ruhezeit' && gesendet.length === 0, 'nachts: Ruhezeit greift, obwohl es die erste Wiederholung ist')
}
{
  const z = await nachholZeile()
  waAntworten(WA_OK)
  db.tabellen.newsletter_subscribers[0].optout_at = vor(1)
  jetzt += 31 * MIN
  const j = await planer()
  ok(j.details?.[0]?.result === 'skipped_newsletter_optout' && gesendet.length === 0 && fertig(z.id).status === 'skipped', 'abgemeldet: entfällt')
}
const welle = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: `welle-${i}`, subscriber_id: `abo-${i}`, lead_id: null, type: 'whatsapp', event_type: 'newsletter', status: 'pending', recipient: 'client', retry_count: 0,
  whatsapp_text: `Du bist dabei ${i}.`, wa_part: 0, seq_condition: { kind: 'nur_bis', bis: START }, scheduled_at: vor(1), created_at: vor(31), ...extra,
}))
const abos = (n) => Array.from({ length: n }, (_, i) => ({ id: `abo-${i}`, email: `abo${i}@example.com`, phone: TEST_NUMMER, properties: { lang: 'de' } }))
{
  // Viele Anmeldungen während einer Sperre: danach keine neue Welle.
  start()
  db = neueDb({ newsletter_subscribers: abos(3), scheduled_messages: welle(3) })
  waAntworten(WA_OK)
  const j = await planer()
  const e = j.details.map((x) => x.result)
  ok(e.filter((x) => x === 'sent').length === 2 && e.filter((x) => x === 'wa_limit:lauf').length === 1, 'Bremse: höchstens 2 je Lauf')
  ok(gesendet.length === 2, 'Bremse: nur 2 WhatsApps gehen raus')
  ok(fertig('welle-2').status === 'pending' && mails.length === 0, 'Bremse: die dritte wartet, statt als zweite Mail zu kommen')
}
{
  start()
  const voll = Array.from({ length: 20 }, (_, i) => ({ id: `alt-${i}`, type: 'whatsapp', event_type: 'newsletter', status: 'sent', whatsapp_text: 'x', error_message: null, wa_part: 0, sent_at: vor(300), scheduled_at: vor(300), recipient: 'client' }))
  db = neueDb({ newsletter_subscribers: abos(1), scheduled_messages: [...voll, ...welle(1)] })
  waAntworten(WA_OK)
  const j = await planer()
  ok(j.details?.[0]?.result === 'wa_limit:tag' && gesendet.length === 0 && mails.length === 0, 'Bremse: Tageslimit erreicht, Zeile wartet')
  ok(EchtDate.parse(fertig('welle-0').scheduled_at) === jetzt + 180 * MIN, 'Bremse: neuer Versuch in 3 Stunden')
}

// ── Terminbestätigung ────────────────────────────────────────────────────────
schreib('\nbooking-bot: Terminbestätigung, Rückfallweg ohne Vorlagen')
const DREI_TAGE = 3 * 1440
const terminSlot = (inMin, label) => ({
  startIso: new Date(jetzt + inMin * MIN).toISOString(),
  endIso: new Date(jetzt + (inMin + 30) * MIN).toISOString(),
  label,
})
let mailAufrufe = []
// Kurz vor der Buchung: Der Slot steht, nur die Terminart ist offen. Ohne Regeln plant die
// echte schedule-message nichts, also läuft der Rückfallweg.
const vorBuchung = ({ inMin = DREI_TAGE, um = TAGSUEBER, daten = {} } = {}) => {
  start()
  jetzt = um
  const slot = terminSlot(inMin, 'Dienstag, 10.11. um 15:00')
  db = neueDb({ ...grunddaten(), ...daten, booking_conversations: [altesGespraech({ state: 'awaiting_type', chosen_slot: slot, proposed_slots: [slot], updated_at: vor(30) })] })
  funktionen['send-whatsapp'] = echteSendWhatsapp
  funktionen['schedule-message'] = echteFunktion(hSchedule)
  mailAufrufe = []
  funktionen['send-email'] = async (b) => { mailAufrufe.push(b); return { data: { ok: true }, error: null } }
  return slot
}
const buchen = () => bot({ action: 'book_now', lead_id: LEAD })
const nachhol = () => zeilen('scheduled_messages').filter((z) => z.event_type === 'termin_gebucht')
const notiz = (anfang) => zeile('activities', (a) => a.type === 'note' && a.subject?.startsWith(anfang))
const waRaus = () => zeilen('activities').filter((a) => a.type === 'whatsapp' && a.direction !== 'inbound')
const stundeZypern = (iso) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', hour: '2-digit', hourCycle: 'h23' }).format(new EchtDate(iso)))
const ergebnis = (j, id) => j.details?.find((x) => x.id === id)?.result
{
  const slot = vorBuchung()
  evo = EVO_GETRENNT
  const r = await buchen()
  ok(r.status === 200 && (await r.json()).ok === true, 'getrennt: Buchung gilt als gelungen')
  ok(zeilen('crm_appointments').length === 1 && zeilen('crm_appointments')[0].start_time === slot.startIso, 'getrennt: Termin bleibt stehen')
  ok(konv()[0].state === 'booked', 'getrennt: Gespräch ist gebucht, Buchung wird nicht zurückgenommen')
  // Neben der Kundenmail läuft hier auch Svens Alarm über send-email.
  const kundenmail = mailAufrufe.filter((m) => m.to === 'test@example.com')
  ok(kundenmail.length === 1 && kundenmail[0].attachment?.filename === 'termin.ics', 'getrennt: Mail mit Kalender-Datei geht trotzdem raus')
  ok(waRaus().length === 0, 'getrennt: nichts als gesendet protokolliert')
  const [z, ...rest] = nachhol()
  ok(!!z && rest.length === 0, 'getrennt: genau eine Zeile zum Nachholen')
  ok(z?.type === 'whatsapp' && z?.status === 'pending' && z?.recipient === 'client' && z?.lead_id === LEAD, 'Zeile: WhatsApp an den Kunden, wartet')
  ok(EchtDate.parse(z?.scheduled_at) === jetzt + 30 * MIN, 'Zeile: in 30 Minuten, also nicht als Sofort-Nachricht an der Ruhezeit vorbei')
  ok(z?.whatsapp_text === konv()[0].last_message && (z?.whatsapp_text.match(/Liebe Grüße/g) ?? []).length === 1, 'Zeile: derselbe Text mit einem Gruß')
  ok(z?.appointment_condition === 'has_appointment' && z?.seq_condition?.kind === 'nur_bis' && z?.seq_condition?.bis === slot.startIso, 'Zeile: gilt nur, solange der Termin steht und noch nicht begonnen hat')
  ok(notiz('🔁')?.content.includes(slot.label) && notiz('🔁')?.content.includes('nicht von Hand'), 'Akte: Hinweis, dass automatisch wiederholt wird')
  ok(!notiz('⚠️'), 'Akte: keine Warnung')
}
{
  // Auch hier die Zeile aus der echten Buchung.
  vorBuchung()
  evo = EVO_GETRENNT
  await buchen()
  const { id, whatsapp_text: text } = nachhol()[0]
  jetzt += 31 * MIN
  const j = await planer()
  ok(ergebnis(j, id) === 'retry:account' && fertig(id).status === 'pending' && fertig(id).retry_count === 1, 'Scheduler, noch getrennt: Wiederholung wie jede andere Zeile')
  ok(waRaus().length === 0, 'Scheduler, noch getrennt: nichts als gesendet protokolliert')
  jetzt += 31 * MIN
  evo = EVO_OK
  evoAufrufe = []
  const j2 = await planer()
  ok(ergebnis(j2, id) === 'sent' && fertig(id).status === 'sent' && fertig(id).error_message === null, 'Scheduler, wieder verbunden: raus')
  ok(evoAufrufe.length === 1, 'Scheduler, wieder verbunden: genau eine Nachricht')
  const w = waRaus()
  ok(w.length === 1 && w[0].subject === 'WhatsApp: termin_gebucht' && w[0].content === text && w[0].lead_id === LEAD, 'Scheduler, wieder verbunden: steht in der Akte')
  jetzt += 31 * MIN
  evoAufrufe = []
  await planer()
  ok(evoAufrufe.length === 0, 'Scheduler, nächster Lauf: nichts doppelt')
}
{
  vorBuchung()
  evo = EVO_GETRENNT
  await buchen()
  const { id } = nachhol()[0]
  jetzt = NACHTS
  evo = EVO_OK
  evoAufrufe = []
  const j = await planer()
  const z = fertig(id)
  ok(ergebnis(j, id) === 'ruhezeit' && z.status === 'pending' && evoAufrufe.length === 0, 'Scheduler nachts: nichts geht raus')
  ok(EchtDate.parse(z.scheduled_at) > NACHTS && stundeZypern(z.scheduled_at) >= 8 && stundeZypern(z.scheduled_at) < 10, 'Scheduler nachts: rückt auf den Morgen')
}
{
  // Die Bremse gilt für Wellen. Eine Terminbestätigung zählt nicht mit und wartet nicht.
  vorBuchung()
  evo = EVO_GETRENNT
  await buchen()
  const { id } = nachhol()[0]
  for (let i = 0; i < 20; i++) db.tabellen.scheduled_messages.push({ id: `alt-${i}`, type: 'whatsapp', event_type: 'newsletter', status: 'sent', whatsapp_text: 'x', error_message: null, wa_part: 0, sent_at: vor(300), scheduled_at: vor(300), recipient: 'client' })
  jetzt += 31 * MIN
  evo = EVO_OK
  const j = await planer()
  ok(ergebnis(j, id) === 'sent', 'Bremse: Tageslimit voll, die Bestätigung geht trotzdem raus')
}
{
  const slot = vorBuchung()
  evo = EVO_GETRENNT
  await buchen()
  const { id } = nachhol()[0]
  jetzt = EchtDate.parse(slot.startIso) + MIN
  evo = EVO_OK
  evoAufrufe = []
  const j = await planer()
  ok(/^skipped:/.test(ergebnis(j, id)) && fertig(id).status === 'skipped' && evoAufrufe.length === 0, 'Termin hat begonnen: entfällt, nichts geht raus')
}
{
  // Mit einem weiteren Termin hilft has_appointment nicht mehr, dann greift nur_bis.
  const slot = vorBuchung()
  evo = EVO_GETRENNT
  await buchen()
  const { id } = nachhol()[0]
  db.tabellen.crm_appointments.push({ id: 'folgetermin', lead_id: LEAD, internal: false, type: 'zoom', start_time: new Date(jetzt + 7 * 1440 * MIN).toISOString(), end_time: new Date(jetzt + 7 * 1440 * MIN + 30 * MIN).toISOString() })
  jetzt = EchtDate.parse(slot.startIso) + MIN
  evo = EVO_OK
  evoAufrufe = []
  const j = await planer()
  ok(ergebnis(j, id) === 'skipped:nur_bis' && evoAufrufe.length === 0, 'Termin hat begonnen, Folgetermin steht: entfällt trotzdem')
}
for (const [fall, weg] of [
  ['gelöscht', (t) => { db.tabellen.crm_appointments = db.tabellen.crm_appointments.filter((a) => a !== t) }],
  ['als Absage gemeldet', (t) => { t.cancel_reported_at = vor(1) }],
]) {
  vorBuchung()
  evo = EVO_GETRENNT
  await buchen()
  const { id } = nachhol()[0]
  weg(db.tabellen.crm_appointments[0])
  jetzt += 31 * MIN
  evo = EVO_OK
  evoAufrufe = []
  const j = await planer()
  ok(ergebnis(j, id) === 'skipped:condition' && evoAufrufe.length === 0, `Termin ${fall}: entfällt, nichts geht raus`)
}
for (const [fall, machen] of [
  ['Nummer ohne WhatsApp', () => { evo = EVO_KEIN_WA }],
  ['Absturz von send-whatsapp', () => { funktionen['send-whatsapp'] = async () => ({ data: null, error: new Error('Edge Function returned a non-2xx status code') }) }],
  ['Server nicht erreichbar', () => { funktionen['send-whatsapp'] = async () => ({ data: { success: false, error: P.evoErrorText(0, { error: 'timeout' }) }, error: null }) }],
]) {
  vorBuchung()
  machen()
  const r = await buchen()
  ok(r.status === 200 && zeilen('crm_appointments').length === 1 && konv()[0].state === 'booked', `${fall}: Buchung bleibt`)
  ok(nachhol().length === 0 && !notiz('🔁'), `${fall}: keine Wiederholung`)
  const n = notiz('⚠️ Terminbestätigung NICHT gesendet')
  ok(n?.content.startsWith('NICHT gesendet') && n.content.includes('persönlich bestätigen') && n.content.includes('Perfekt'), `${fall}: Notiz nennt Aufgabe und geplanten Text`)
}
for (const [fall, opt] of [
  ['20 Minuten vor dem Termin', { inMin: 20 }],
  ['nachts für 8:30 Uhr am Morgen', { inMin: 8.5 * 60, um: NACHTS }],
]) {
  vorBuchung(opt)
  evo = EVO_GETRENNT
  await buchen()
  ok(zeilen('crm_appointments').length === 1 && nachhol().length === 0, `${fall}: zu knapp, keine Zeile`)
  ok(!!notiz('⚠️ Terminbestätigung NICHT gesendet') && !notiz('🔁'), `${fall}: Notiz statt falschem Versprechen`)
}
{
  vorBuchung({ inMin: 15 * 60, um: NACHTS })
  evo = EVO_GETRENNT
  await buchen()
  const z = nachhol()[0]
  ok(!!z && stundeZypern(z.scheduled_at) === 9 && !!notiz('🔁'), 'nachts für den Nachmittag: Zeile für etwa 9 Uhr')
}
{
  vorBuchung()
  evo = EVO_GETRENNT
  const echt = db.from
  db.from = (n) => (n === 'scheduled_messages' ? { insert: async () => ({ data: null, error: { message: 'DB weg' } }) } : echt(n))
  const r = await buchen()
  ok(r.status === 200 && zeilen('crm_appointments').length === 1, 'Zeile lässt sich nicht anlegen: Buchung bleibt')
  ok(!!notiz('⚠️ Terminbestätigung NICHT gesendet') && !notiz('🔁'), 'Zeile lässt sich nicht anlegen: Notiz für Sven')
}
{
  vorBuchung()
  const r = await buchen()
  ok(r.status === 200 && konv()[0].state === 'booked', 'verbunden: Buchung wie bisher')
  ok(waRaus().length === 1 && waRaus()[0].subject === 'WhatsApp: Termin-Bot', 'verbunden: Bestätigung steht im Verlauf')
  ok(nachhol().length === 0 && !notiz('🔁') && !notiz('⚠️'), 'verbunden: keine Zeile, keine Notiz')
}
{
  vorBuchung()
  evo = EVO_GETRENNT
  const j = await (await bot({ action: 'sweep' })).json()
  ok(j.swept === 1 && !!j.results[0].booked && !j.results[0].error, 'Sweep, getrennt: bucht ohne Fehler')
  ok(zeilen('crm_appointments').length === 1 && nachhol().length === 1, 'Sweep, getrennt: Termin und eine Zeile')
  const j2 = await (await bot({ action: 'sweep' })).json()
  ok(j2.swept === 0 && zeilen('crm_appointments').length === 1 && nachhol().length === 1, 'Sweep, nächster Lauf: nichts doppelt')
}

schreib('\nbooking-bot: Terminbestätigung über die Vorlagen')
const mitRegel = () => ({
  automation_rules: [{ id: 'regel-1', event_type: 'termin_gebucht', is_active: true, message_type: 'both', delay_minutes: 0, email_template_id: 'mail-1', whatsapp_event_type: 'termin_wa', recipient: 'client', appointment_condition: 'no_zoom', timing_type: 'after_event' }],
  email_templates: [{ id: 'mail-1', subject: 'Termin steht', body: 'Hallo {{vorname}}', html_body: null }],
  whatsapp_templates: [{ event_type: 'termin_wa', active: true, message_template: 'Hallo {{vorname}}, dein Termin steht.', image_url: null }],
})
const kundenMails = () => mails.filter((m) => m.subject === 'Termin steht')
const vorVorlagenBuchung = () => {
  vorBuchung({ daten: mitRegel() })
  wege['/functions/v1/process-scheduled-messages'] = (u, init) => hPlaner(new Request(u, init))
}
{
  vorVorlagenBuchung()
  evo = EVO_GETRENNT
  const r = await buchen()
  ok(r.status === 200 && konv()[0].state === 'booked' && zeilen('crm_appointments').length === 1, 'getrennt: Buchung gelingt')
  const [z, ...rest] = nachhol()
  ok(!!z && rest.length === 0 && z.rule_id === 'regel-1', 'getrennt: nur die Zeile der Vorlage, keine zweite')
  ok(kundenMails().length === 1, 'getrennt: Mail ist sofort raus')
  ok(z?.status === 'pending' && z?.type === 'whatsapp' && z?.retry_count === 1 && EchtDate.parse(z?.scheduled_at) === jetzt + 30 * MIN, 'getrennt: Scheduler wiederholt nur noch die WhatsApp')
  ok(waRaus().length === 0 && !notiz('🔁') && !notiz('⚠️'), 'getrennt: kein Direktversand, keine Bot-Notiz')
  jetzt += 31 * MIN
  evo = EVO_OK
  const j = await planer()
  ok(ergebnis(j, z.id) === 'sent' && waRaus().length === 1 && waRaus()[0].subject === 'WhatsApp: termin_gebucht', 'wieder verbunden: Bestätigung kommt nach')
  ok(kundenMails().length === 1, 'wieder verbunden: keine zweite Mail')
}
{
  vorVorlagenBuchung()
  evo = EVO_GETRENNT
  const j = await (await bot({ action: 'sweep' })).json()
  ok(j.swept === 1 && !!j.results[0].booked && nachhol().length === 1 && nachhol()[0].rule_id === 'regel-1', 'Sweep, getrennt: bucht, Scheduler wiederholt')
}

schreib('\nbooking-bot: Café-Termin')
// Lottes Angebot steht im Chat, der Kunde sagt per Reaktion zu.
const vorCafe = ({ inMin = DREI_TAGE, um = TAGSUEBER, nummer = TEST_NUMMER } = {}) => {
  start()
  jetzt = um
  const slot = terminSlot(inMin, 'Dienstag, 10.11.')
  const daten = grunddaten()
  daten.leads[0].phone = daten.leads[0].whatsapp = nummer
  db = neueDb({
    ...daten,
    booking_conversations: [altesGespraech({ source: 'cafe', state: 'awaiting_cafe', proposed_slots: [slot], meeting_type: 'cafe_du', attempts: 0, last_message: 'Soll ich dich eintragen?' })],
    activities: [{ id: 'angebot', lead_id: LEAD, type: 'whatsapp', direction: 'outbound', auto: true, subject: 'WhatsApp: Termin-Bot', content: 'Soll ich dich eintragen?', whatsapp_message_id: 'WA-ANGEBOT', created_at: vor(60) }],
  })
  funktionen['send-whatsapp'] = echteSendWhatsapp
  return slot
}
const cafeZusage = (nummer = TEST_NUMMER) => bot({ action: 'cafe_reaktion', phone: nummer, emoji: '👍', ziel: 'WA-ANGEBOT', uid: 'WA-REAKTION' })
{
  const slot = vorCafe()
  evo = EVO_GETRENNT
  const r = await cafeZusage()
  ok(r.status === 200 && (await r.json()).handled === 'cafe_gebucht', 'getrennt: Zusage gilt als gebucht')
  const t = zeilen('crm_appointments')
  ok(t.length === 1 && t[0].type === 'inperson' && t[0].start_time === slot.startIso, 'getrennt: Café-Termin bleibt stehen')
  ok(konv()[0].state === 'booked' && konv()[0].chosen_slot?.startIso === slot.startIso, 'getrennt: Gespräch ist gebucht')
  const [z, ...rest] = nachhol()
  ok(!!z && rest.length === 0 && z.type === 'whatsapp' && z.status === 'pending' && EchtDate.parse(z.scheduled_at) === jetzt + 30 * MIN, 'getrennt: eine Zeile in 30 Minuten')
  ok(z?.whatsapp_text.startsWith('Super, ist eingetragen') && z?.whatsapp_text.includes(slot.label) && /Lotte 🐾$/.test(z?.whatsapp_text), 'Zeile: Bestätigung mit Lottes Gruß wie beim Direktversand')
  ok(z?.appointment_condition === 'has_appointment' && z?.seq_condition?.bis === slot.startIso, 'Zeile: gilt nur, solange der Termin steht')
  ok(!!notiz('🔁') && !notiz('⚠️'), 'Akte: Hinweis, dass automatisch wiederholt wird')
  ok(waRaus().length === 1 && waRaus()[0].id === 'angebot', 'getrennt: nur das Angebot steht als gesendet im Verlauf')

  jetzt += 31 * MIN
  evo = EVO_OK
  const j = await planer()
  ok(ergebnis(j, z.id) === 'sent' && waRaus().length === 2 && waRaus()[1].content === z.whatsapp_text, 'wieder verbunden: Bestätigung raus und in der Akte')
}
{
  vorCafe({ um: NACHTS, inMin: 10 * 60 })
  evo = EVO_GETRENNT
  await cafeZusage()
  const z = nachhol()[0]
  ok(!!z && stundeZypern(z.scheduled_at) === 9 && EchtDate.parse(z.scheduled_at) < jetzt + 10 * 60 * MIN, 'nachts, Termin um 10 Uhr: Zeile für etwa 9 Uhr, vor dem Treffen')
}
{
  // Deutsche Nummer, der Kunde ist aber in Paphos. Nach Vorwahl käme 9 Uhr erst um 10 Uhr im Café.
  const nummer = '+49000000000'
  vorCafe({ um: NACHTS, inMin: 10 * 60, nummer })
  waAntworten(antwortGetrennt)
  await cafeZusage(nummer)
  const z = nachhol()[0]
  ok(!!z && stundeZypern(z.scheduled_at) === 9, 'deutsche Nummer: geplant nach Zypern-Zeit')
  if (z) {
    jetzt = EchtDate.parse(z.scheduled_at) + MIN
    waAntworten(WA_OK)
    const j = await planer()
    ok(ergebnis(j, z.id) === 'sent' && gesendet.length === 1, 'deutsche Nummer: Scheduler sendet vor dem Treffen')
  }
}
{
  vorCafe({ inMin: 20 })
  evo = EVO_GETRENNT
  await cafeZusage()
  ok(zeilen('crm_appointments').length === 1 && nachhol().length === 0 && !!notiz('⚠️ Terminbestätigung NICHT gesendet'), 'zu knapp vor dem Treffen: keine Zeile, Notiz für Sven')
}
{
  vorCafe()
  evo = EVO_KEIN_WA
  const r = await cafeZusage()
  ok(r.status === 200 && zeilen('crm_appointments').length === 1 && konv()[0].state === 'booked', 'Nummer ohne WhatsApp: Buchung bleibt')
  ok(nachhol().length === 0 && notiz('⚠️ Terminbestätigung NICHT gesendet')?.content.includes('Super, ist eingetragen'), 'Nummer ohne WhatsApp: Notiz nennt den geplanten Text')
}
{
  vorCafe()
  const r = await cafeZusage()
  ok(r.status === 200 && waRaus().length === 2 && waRaus()[1].content.startsWith('Super, ist eingetragen'), 'verbunden: Bestätigung steht im Verlauf')
  ok(nachhol().length === 0 && !notiz('🔁') && !notiz('⚠️'), 'verbunden: keine Zeile, keine Notiz')
}

schreib('\nbooking-bot: Café-Treffen verschieben')
// Der Kunde will ein Café-Treffen verlegen, Lotte bietet den nächsten Tag an. Nur für
// diesen Abschnitt gibt es eine KI, sie ordnet jede Nachricht als Verschiebung ein.
const vorVerschieben = ({ offen = false } = {}) => {
  start()
  ENV.ANTHROPIC_API_KEY = 'test-ki'
  wege['api.anthropic.com'] = () => antwort(200, { content: [{ type: 'tool_use', name: 'emit', input: { art: 'verschieben' } }] })
  const slot = terminSlot(DREI_TAGE, 'Dienstag, 10.11.')
  db = neueDb({
    ...grunddaten(),
    booking_conversations: offen ? [altesGespraech()] : [],
    crm_appointments: [{ id: 'cafe-termin', lead_id: LEAD, title: 'Kaffee', type: 'inperson', internal: false, location: 'Café Cultivos, Paphos', timezone: 'Asia/Nicosia', start_time: slot.startIso, end_time: slot.endIso }],
  })
  funktionen['send-whatsapp'] = echteSendWhatsapp
}
const verschieben = async () => (await bot({ action: 'absage', lead_id: LEAD, text: 'Können wir das Treffen verschieben?' })).json()
const cafeNachfragen = () => zeilen('scheduled_messages').filter((z) => z.bot_nudge_source === 'cafe' && z.status === 'pending')
{
  vorVerschieben()
  let gespraecheBeimVersand = null
  evo = () => { gespraecheBeimVersand ??= konv().length; return EVO_OK() }
  const j = await verschieben()
  ok(j.handled === 'verschieben' && gespraecheBeimVersand === 0, 'verbunden: Gespräch entsteht erst nach dem Versand')
  ok(konv().length === 1 && konv()[0].state === 'awaiting_cafe' && konv()[0].source === 'cafe' && konv()[0].proposed_slots.length === 1, 'verbunden: Gespräch wartet auf die Zusage zum neuen Tag')
  ok(waRaus().length === 1 && waRaus()[0].content.startsWith('Kein Problem') && !!waRaus()[0].whatsapp_message_id, 'verbunden: Angebot im Verlauf, mit ID für eine Reaktion')
  ok(cafeNachfragen().length === 3, 'verbunden: Nachfragen sind geplant')
  ok(notiz('🔁 Termin soll')?.content.includes('Lotte hat das nächste Café-Treffen angeboten'), 'verbunden: Akte nennt das Angebot')
}
{
  vorVerschieben()
  evo = EVO_GETRENNT
  const j = await verschieben()
  ok(j.handled === 'verschieben' && j.lotte.includes('fehlgeschlagen'), 'getrennt: Sven erfährt, dass Lottes Antwort nicht rausging')
  ok(konv().length === 0, 'getrennt: kein Gespräch, das auf eine Antwort wartet')
  ok(waRaus().length === 0 && cafeNachfragen().length === 0, 'getrennt: nichts im Verlauf, keine Nachfragen')
  ok(zeile('crm_appointments', (t) => t.id === 'cafe-termin')?.cancel_reported_kind === 'verschieben', 'getrennt: Wunsch bleibt am Termin vermerkt')
}
{
  vorVerschieben({ offen: true })
  const vorher = JSON.stringify(konv())
  evo = EVO_GETRENNT
  await verschieben()
  ok(JSON.stringify(konv()) === vorher, 'getrennt, offenes Gespräch: bleibt, wie es war')
}
{
  vorVerschieben({ offen: true })
  await verschieben()
  const k = konv()
  ok(k.length === 1 && k[0].id === 'konv-1' && k[0].state === 'awaiting_cafe' && k[0].source === 'cafe' && k[0].attempts === 0, 'verbunden, offenes Gespräch: wird weitergeführt')
}
delete ENV.ANTHROPIC_API_KEY

schreib('\nbooking-bot: Übergabe an Sven')
const notizNachWa = (betreff) => {
  const alle = zeilen('activities')
  const n = alle.findIndex((a) => a.subject?.startsWith(betreff))
  return n > 0 && alle[n - 1].type === 'whatsapp' && alle[n - 1].direction !== 'inbound'
}
// Lässt nur das Anlegen des Termins scheitern.
const terminKaputt = () => {
  const echt = db.from
  const fehlt = { data: null, error: { message: 'DB weg' }, select: () => ({ single: async () => ({ data: null, error: { message: 'DB weg' } }) }) }
  db.from = (n) => {
    const q = echt(n)
    return n === 'crm_appointments' ? new Proxy(q, { get: (z, k) => (k === 'insert' ? () => fehlt : z[k]) }) : q
  }
}
// attempts 2: Der Bot versteht ohne KI-Schlüssel nichts mehr und gibt ab.
const vorUebergabe = () => {
  start()
  const a = terminSlot(DREI_TAGE, 'A'), b = terminSlot(DREI_TAGE + 1440, 'B')
  db = neueDb({ ...grunddaten(), booking_conversations: [altesGespraech({ proposed_slots: [a, b] })] })
  funktionen['send-whatsapp'] = echteSendWhatsapp
}
const unklareAntwort = () => bot({ action: 'reply', lead_id: LEAD, text: 'Hmm' })
{
  vorUebergabe()
  evo = EVO_GETRENNT
  const r = await unklareAntwort()
  ok(r.status === 500 && konv()[0].state === 'handoff', 'Terminbot gibt ab, getrennt: Fehler und Übergabe wie bisher')
  ok(!!notiz('⚠️ Termin-Bot: Übergabe') && waRaus().length === 0, 'Terminbot gibt ab, getrennt: Notiz für Sven bleibt, nichts als gesendet protokolliert')
}
{
  vorUebergabe()
  const r = await unklareAntwort()
  ok(r.status === 200 && konv()[0].state === 'handoff' && notizNachWa('⚠️ Termin-Bot: Übergabe'), 'Terminbot gibt ab, verbunden: Reihenfolge im Verlauf wie bisher')
}
{
  vorCafe()
  evo = EVO_GETRENNT
  const r = await bot({ action: 'reply', lead_id: LEAD, text: 'Gibt es dort Parkplätze?' })
  ok(r.status === 500 && konv()[0].state === 'handoff', 'Café-Frage, getrennt: Fehler und Übergabe wie bisher')
  ok(notiz('⚠️ Lotte: Café-Treffen')?.content.includes('Parkplätze') && waRaus().length === 1, 'Café-Frage, getrennt: Notiz für Sven bleibt')
}
{
  vorCafe()
  const r = await bot({ action: 'reply', lead_id: LEAD, text: 'Gibt es dort Parkplätze?' })
  ok(r.status === 200 && konv()[0].state === 'handoff' && notizNachWa('⚠️ Lotte: Café-Treffen'), 'Café-Frage, verbunden: Reihenfolge im Verlauf wie bisher')
}
{
  vorBuchung()
  terminKaputt()
  evo = EVO_GETRENNT
  const r = await buchen()
  ok(r.status === 500 && konv()[0].state === 'handoff', 'Termin lässt sich nicht speichern, getrennt: Fehler und Übergabe wie bisher')
  ok(!!notiz('⚠️ Termin-Bot: Buchung fehlgeschlagen') && nachhol().length === 0, 'Termin lässt sich nicht speichern, getrennt: Notiz für Sven bleibt, nichts wird bestätigt')
}
{
  vorCafe()
  terminKaputt()
  evo = EVO_GETRENNT
  const r = await cafeZusage()
  ok(r.status === 500 && konv()[0].state === 'handoff', 'Café-Termin lässt sich nicht speichern, getrennt: Fehler und Übergabe wie bisher')
  ok(notiz('⚠️ Lotte: Café-Treffen')?.content.includes('konnte nicht gespeichert') && nachhol().length === 0, 'Café-Termin lässt sich nicht speichern, getrennt: Notiz für Sven bleibt')
}

if (fehler) { schreib(`\n${fehler} Fehler`); process.exit(1) }
schreib('\nAlles ok')
process.exit(0)
