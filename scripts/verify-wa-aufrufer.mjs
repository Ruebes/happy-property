// Tests für die Aufrufer von send-whatsapp: Ein Fehlversand darf nirgends als Erfolg zählen.
//
// send-whatsapp antwortet beim Fehlversand mit HTTP 200 und success:false. functions.invoke
// meldet das nicht als error, ein fetch sieht res.ok. Der Test startet die echten Edge
// Functions offline und spielt je Stelle Erfolg und Fehlversand durch. Nachgebaut sind nur
// Deno, Datenbank, Uhr und Netz. Es geht nichts raus, fetch und functions.invoke sind ersetzt.
//
// Ausführen:
//   node scripts/verify-wa-aufrufer.mjs
// Mit den Logs der Functions:
//   WA_TEST_LOG=1 node scripts/verify-wa-aufrufer.mjs

import { build } from 'esbuild'
import { generateKeyPairSync } from 'crypto'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'hpwa-aufrufer-'))

// ── Protokoll ────────────────────────────────────────────────────────────────
const konsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) }
const schreib = konsole.log
let protokoll = []
for (const stufe of ['log', 'warn', 'error']) {
  console[stufe] = (...a) => {
    protokoll.push({ stufe, text: a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ') })
    if (process.env.WA_TEST_LOG) konsole[stufe](...a)
  }
}
const gewarnt = (muster) => protokoll.some((z) => z.stufe === 'warn' && muster.test(z.text))
const geloggt = (muster) => protokoll.some((z) => z.stufe === 'log' && muster.test(z.text))

let fehler = 0
const ok = (bed, text) => {
  if (bed) schreib(`  ok   ${text}`)
  else { fehler++; schreib(`  FEHL ${text}`) }
}

// ── Uhr ──────────────────────────────────────────────────────────────────────
const EchtDate = Date
const jetzt = EchtDate.parse('2026-06-16T10:00:00Z')  // mittags auf Zypern und in Deutschland
globalThis.Date = class extends EchtDate {
  constructor(...a) { if (a.length) super(...a); else super(jetzt) }
  static now() { return jetzt }
}
const vor = (stunden) => new Date(jetzt - stunden * 3_600_000).toISOString()

// ── Deno ─────────────────────────────────────────────────────────────────────
const KEY = 'test-service-key'
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const ENV = {
  SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: KEY, SUPABASE_ANON_KEY: 'test-anon',
  EVOLUTION_URL: 'https://evo.test', EVOLUTION_API_KEY: 'test-evo', EVOLUTION_INSTANCE: 'test',
  REVOLUT_CLIENT_ID: 'test-client', REVOLUT_PRIVATE_KEY: privateKey,
}
let geladen = null
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (f) => { geladen = f } }

// ── Datenbank ────────────────────────────────────────────────────────────────
const VORGABEN = {
  lead_partner_shares: { token: 'akte-token', active: true },
  crm_invoices: { token: 'rechnung-token' },
}
const kopie = (x) => JSON.parse(JSON.stringify(x))
const wert = (r, c) => c.split('.').reduce((x, k) => x?.[k], r)  // 'task.status' bei eingebetteten Zeilen

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
    const vergleich = (c, v, f) => { bedingungen.push((r) => wert(r, c) != null && f(zeitwert(wert(r, c)), zeitwert(v))); return p }
    const muster = (c, v) => {
      const re = new RegExp(`^${String(v).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
      bedingungen.push((r) => re.test(String(wert(r, c) ?? '')))
      return p
    }
    const q = {
      select: (_s, o) => { if (o?.head) nurZaehlen = true; return p },
      insert: (d) => { op = 'insert'; daten = d; return p },
      upsert: (d, o) => { op = 'upsert'; daten = d; konflikt = o?.onConflict?.split(',') ?? null; return p },
      update: (d) => { op = 'update'; daten = d; return p },
      delete: () => { op = 'delete'; return p },
      eq: (c, v) => { bedingungen.push((r) => (wert(r, c) ?? null) === v); return p },
      neq: (c, v) => { bedingungen.push((r) => (wert(r, c) ?? null) !== v); return p },
      is: (c, v) => { bedingungen.push((r) => (wert(r, c) ?? null) === v); return p },
      in: (c, l) => { bedingungen.push((r) => l.includes(wert(r, c))); return p },
      not: (c, o, v) => {
        bedingungen.push((r) => (o === 'in' ? !String(v).slice(1, -1).split(',').includes(String(wert(r, c))) : (wert(r, c) ?? null) !== v))
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
  return { tabellen: t, from }
}
let db = neueDb()
const zeilen = (name) => db.tabellen[name] ?? []
const zeile = (name, f) => zeilen(name).find(f)

// ── Fremde Pakete ────────────────────────────────────────────────────────────
const ADMIN = 'profil-admin'
const ADMIN_JWT = 'admin-jwt'
let funktionen = {}  // Edge Functions hinter functions.invoke
let rpcs = {}
let aufrufe = []
const aufrufeVon = (name) => aufrufe.filter((a) => a.name === name)
const client = {
  from: (...a) => db.from(...a),
  rpc: async (f, a) => (rpcs[f] ? rpcs[f](a) : { data: null, error: null }),
  functions: {
    invoke: async (name, o) => {
      aufrufe.push({ name, body: o?.body })
      return funktionen[name] ? funktionen[name](o?.body) : { data: { ok: true }, error: null }
    },
  },
  auth: { getUser: async (jwt) => ({ data: { user: jwt === ADMIN_JWT ? { id: ADMIN } : null } }) },
  storage: {
    from: () => ({
      upload: async () => ({ data: {}, error: null }),
      remove: async () => ({ data: [], error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: `${ENV.SUPABASE_URL}/storage/v1/object/public/${p}` } }),
    }),
  },
}
// pdf-lib und fontkit: Hier zählt nur, was nach dem PDF passiert.
const alles = () => new Proxy(function () {}, {
  get: (_z, k) => {
    if (k === 'then') return undefined
    if (k === Symbol.toPrimitive) return () => 1
    if (k === Symbol.iterator) return function* () {}
    if (k === 'save') return async () => new Uint8Array(3)
    return alles()
  },
  apply: () => alles(),
  construct: () => alles(),
})
globalThis.__fremd = {
  createClient: () => client,
  PDFDocument: alles(),
  StandardFonts: alles(),
  rgb: () => alles(),
  default: alles(),
  Image: class {},
}
const fremd = {
  name: 'fremd',
  setup(b) {
    b.onResolve({ filter: /^(jsr:|npm:|https?:)|_vendor\/imagescript/ }, (a) => ({ path: a.path, namespace: 'fremd' }))
    b.onLoad({ filter: /.*/, namespace: 'fremd' }, () => ({ contents: 'module.exports = globalThis.__fremd', loader: 'js' }))
  },
}
const lade = async (pfad) => {
  const outfile = join(dir, `${pfad.replace(/[/.]/g, '_')}.mjs`)
  await build({ entryPoints: [join(root, 'supabase/functions', pfad)], bundle: true, format: 'esm', platform: 'neutral', outfile, plugins: [fremd], logLevel: 'warning', target: 'es2022' })
  geladen = null
  const modul = await import(outfile)
  return { modul, handler: geladen }
}

// ── Netz ─────────────────────────────────────────────────────────────────────
const antwort = (status, json) => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
let wege = {}  // URL-Teil -> Antwort
let netz = []
const netzAn = (teil) => netz.filter((u) => u.url.includes(teil))
globalThis.fetch = async (url, init = {}) => {
  const u = String(url?.url ?? url)
  netz.push({ url: u, body: typeof init.body === 'string' ? init.body : null })
  for (const [teil, f] of Object.entries(wege)) if (u.includes(teil)) return f(u, init)
  return new Response('nicht nachgebaut', { status: 404 })
}

// ── Antworten von send-whatsapp ──────────────────────────────────────────────
// Der Abschnitt „Vertrag" prüft diese Form gegen die echte Function.
const TEST_NUMMER = '+35795096409'
const GRUND = 'WhatsApp nicht verbunden'
const WA_OK = { success: true, sent: 1, results: [{ phone: TEST_NUMMER, ok: true, status: 201 }], attached: false }
const WA_DOPPELT = { success: true, sent: 1, results: [{ phone: TEST_NUMMER, ok: true, status: 200, data: { skipped: 'duplicate' } }], skipped_duplicate: true, attached: false }
const WA_FEHLVERSAND = { success: false, sent: 0, results: [{ phone: TEST_NUMMER, ok: false, status: 400 }], error: GRUND, attached: false }
// Für die Aufrufer über functions.invoke:
const wa = {
  ok: () => ({ data: WA_OK, error: null }),
  doppelt: () => ({ data: WA_DOPPELT, error: null }),
  fehlversand: () => ({ data: WA_FEHLVERSAND, error: null }),
  http: () => ({ data: null, error: new Error('Edge Function returned a non-2xx status code') }),
}
// Für die Aufrufer über fetch:
const waFetch = {
  ok: () => antwort(200, WA_OK),
  fehlversand: () => antwort(200, WA_FEHLVERSAND),
  http: () => antwort(500, { success: false, error: 'Exception' }),
}
const mailOk = () => ({ data: { success: true }, error: null })
const mailKaputt = () => ({ data: null, error: new Error('Edge Function returned a non-2xx status code') })

// ── Grundlagen ───────────────────────────────────────────────────────────────
const LEAD = 'lead-1'
const leadZeile = (extra = {}) => ({
  id: LEAD, first_name: 'Test', last_name: 'Kunde', email: 'test@example.com', phone: TEST_NUMMER, whatsapp: TEST_NUMMER,
  language: 'de', newsletter_optout_at: null, booking_token: 'buchung', ...extra,
})
const start = (daten = {}, waFn = wa.ok) => {
  db = neueDb(daten); funktionen = { 'send-whatsapp': waFn }; rpcs = {}; wege = {}; netz = []; aufrufe = []; protokoll = []
}
const aufruf = (h, body, kopf = { apikey: KEY }) => h(new Request('https://fn.test/', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...kopf }, body: JSON.stringify(body),
}))
const SERVICE_BEARER = { Authorization: `Bearer ${KEY}` }

// ── Vertrag ──────────────────────────────────────────────────────────────────
schreib('Vertrag: Antwort der echten send-whatsapp')
{
  const h = (await lade('send-whatsapp/index.ts')).handler
  const senden = async (evo) => {
    start({ leads: [leadZeile()], crm_settings: [] })
    wege[ENV.EVOLUTION_URL] = evo
    const r = await aufruf(h, { event_type: 'vertrag', already_translated: true, lang: 'de', lead_data: { lead_name: 'Test Kunde', lead_phone: TEST_NUMMER }, override_text: 'Testnachricht' })
    return { status: r.status, d: await r.json() }
  }
  let r = await senden(() => antwort(201, { key: { id: 'WA1' }, status: 'PENDING' }))
  ok(r.status === 200 && r.d.success === true && r.d.results[0].ok === true && r.d.error === undefined, 'Zugestellt: HTTP 200, success:true')
  r = await senden(() => antwort(400, { status: 400, error: 'Bad Request', response: { message: ['Error: Connection Closed'] } }))
  ok(r.status === 200, 'Fehlversand: trotzdem HTTP 200')
  ok(r.d.success === false && r.d.sent === 0 && r.d.results[0].ok === false, 'Fehlversand: success:false, results[0].ok:false')
  ok(typeof r.d.error === 'string' && r.d.error.length > 0, 'Fehlversand: error nennt den Grund')
}

// ── run-workflows ────────────────────────────────────────────────────────────
schreib('\nrun-workflows: WhatsApp-Knoten')
{
  const h = (await lade('run-workflows/index.ts')).handler
  const daten = () => ({
    funnel_workflows: [{
      id: 'wf', status: 'active', trigger_type: 'manual',
      graph: {
        nodes: [
          { id: 'start', type: 'trigger' },
          { id: 'wa', type: 'whatsapp', data: { text: 'Hallo {{vorname}}' } },
          { id: 'mail', type: 'email', data: { subject: 'Betreff', html: '<p>Text</p>' } },
        ],
        edges: [{ id: 'e1', source: 'start', target: 'wa' }, { id: 'e2', source: 'wa', target: 'mail' }],
      },
    }],
    funnel_workflow_runs: [{ id: 'lauf', workflow_id: 'wf', lead_id: LEAD, subscriber_id: null, status: 'running', current_node_id: null, next_due_at: vor(1), context: {}, entered_at: vor(1), last_error: null }],
    leads: [leadZeile()],
  })
  const lauf = async (waFn) => {
    start(daten(), waFn)
    rpcs.claim_workflow_runs = () => ({ data: kopie(zeilen('funnel_workflow_runs')), error: null })
    return (await aufruf(h, {})).json()
  }
  const dieserLauf = () => zeile('funnel_workflow_runs', (x) => x.id === 'lauf')

  let r = await lauf(wa.ok)
  ok(r.sent_wa === 1 && r.errors.length === 0 && dieserLauf().last_error == null, 'Erfolg: zählt als gesendet, kein Fehler')
  r = await lauf(wa.doppelt)
  ok(r.sent_wa === 1 && r.errors.length === 0, 'Doppelschutz: zählt als gesendet, nicht als Fehler')
  r = await lauf(wa.fehlversand)
  ok(r.sent_wa === 0, 'Fehlversand: zählt nicht als gesendet')
  ok(r.errors.length === 1 && r.errors[0].includes('WhatsApp-Knoten wa') && r.errors[0].includes(GRUND), 'Fehlversand: steht in errors, mit Knoten und Grund')
  ok(dieserLauf().last_error?.includes(GRUND), 'Fehlversand: last_error am Lauf gesetzt')
  ok(dieserLauf().status === 'completed' && r.sent_email === 1, 'Fehlversand: Lauf geht weiter, der Mail-Knoten danach sendet')
  ok(aufrufeVon('send-whatsapp').length === 1, 'Fehlversand: kein zweiter Versuch im selben Lauf')
  r = await lauf(wa.http)
  ok(r.sent_wa === 0 && r.errors.length === 1, 'HTTP-Fehler: ebenfalls gemeldet')
}

// ── review-api ───────────────────────────────────────────────────────────────
schreib('\nreview-api: Empfehlungs-Link')
{
  const h = (await lade('review-api/index.ts')).handler
  const abgabe = async (waFn) => {
    start({
      review_requests: [{ id: 'rv', lead_id: LEAD, token: 'tok', recipient_name: 'Test Kunde', language: 'de', status: 'sent', answers: {}, question_ratings: {}, rating: null, review_text: null, photo_path: null, consent_given_at: null, consent_revoked_at: null, published: false, recommend: null, affiliate_id: null }],
      leads: [leadZeile()],
      profiles: [{ id: ADMIN, role: 'admin', created_at: vor(999) }],
    }, waFn)
    rpcs.ensure_affiliate = () => ({ data: { id: 'aff', code: 'CODE' }, error: null })
    wege['/storage/v1/object/public/'] = () => new Response(null, { status: 200 })
    return (await aufruf(h, { action: 'submit', token: 'tok', recommend: true, rating: 4, answers: { q1: 'gut' } }, {})).json()
  }
  let r = await abgabe(wa.ok)
  ok(r.ok === true && r.affiliate_url?.includes('CODE') && !gewarnt(/Empfehlungs-WhatsApp/), 'Erfolg: Link zurück, keine Warnung')
  r = await abgabe(wa.fehlversand)
  ok(gewarnt(/Empfehlungs-WhatsApp nicht zugestellt.*WhatsApp nicht verbunden/), 'Fehlversand: Warnung mit Grund')
  ok(r.ok === true && r.affiliate_url?.includes('CODE'), 'Fehlversand: Abgabe gelingt, der Link steht auf der Danke-Seite')
  ok(zeile('review_requests', (x) => x.id === 'rv').status === 'submitted', 'Fehlversand: Bewertung bleibt gespeichert')
  await abgabe(wa.http)
  ok(gewarnt(/Empfehlungs-WhatsApp nicht zugestellt/), 'HTTP-Fehler: ebenfalls gewarnt')
}

// ── waMailUpdate ─────────────────────────────────────────────────────────────
schreib('\nwaMailUpdate: Danke-WhatsApp')
{
  const M = (await lade('_shared/waMailUpdate.ts')).modul
  const fall = async (danke) => {
    start({
      scheduled_messages: [{ id: 'nl', event_type: 'newsletter', type: 'whatsapp', status: 'sent', sent_at: vor(24), lead_id: LEAD }],
      leads: [leadZeile({ email: null })],
      email_bounces: [],
    })
    wege['/functions/v1/send-whatsapp'] = danke
    return M.maybeUpdateEmailFromWa(client, { lead_id: LEAD }, TEST_NUMMER, 'Meine neue Adresse ist neu@example.com', 'test')
  }
  const gespeichert = () => zeile('leads', (x) => x.id === LEAD).email === 'neu@example.com'
  let r = await fall(waFetch.ok)
  ok(r === true && gespeichert() && !gewarnt(/Danke-WhatsApp/), 'Erfolg: Adresse gespeichert, keine Warnung')
  r = await fall(waFetch.fehlversand)
  ok(gewarnt(/Danke-WhatsApp.*WhatsApp nicht verbunden/), 'Fehlversand: Warnung mit Grund')
  ok(r === true && gespeichert(), 'Fehlversand: Adresse bleibt gespeichert, das Danke ist nur Höflichkeit')
  r = await fall(waFetch.http)
  ok(r === true && gespeichert() && gewarnt(/Danke-WhatsApp/), 'HTTP-Fehler: ebenfalls gewarnt, Adresse gespeichert')
}

// ── notifyToday ──────────────────────────────────────────────────────────────
schreib('\nnotifyToday: Meldung an Sven')
{
  const N = (await lade('_shared/notifyToday.ts')).modul
  const melden = async (waFn) => {
    start({ crm_settings: [{ key: 'notify_whatsapp', value: TEST_NUMMER }] }, waFn)
    return N.notifyIfToday(client, [new Date().toISOString()], 'Termin heute')
  }
  let r = await melden(wa.ok)
  ok(r.sent === true, 'Erfolg: sent:true')
  r = await melden(wa.fehlversand)
  ok(r.sent === false && r.reason === 'versand_fehler' && gewarnt(/Versand fehlgeschlagen.*WhatsApp nicht verbunden/), 'Fehlversand: sent:false, Warnung mit Grund')
  r = await melden(wa.http)
  ok(r.sent === false && r.reason === 'versand_fehler', 'HTTP-Fehler: sent:false')
}

// ── task-notify ──────────────────────────────────────────────────────────────
{
  const h = (await lade('task-notify/index.ts')).handler
  const GEBER = 'profil-geber', MACHER = 'profil-macher'
  const profile = (geber = {}) => [
    { id: GEBER, full_name: 'Geber Test', email: 'geber@example.com', phone: TEST_NUMMER, role: 'admin', language: 'de', ...geber },
    { id: MACHER, full_name: 'Macher Test', email: 'macher@example.com', phone: null, role: 'mitarbeiter', language: 'de' },
  ]
  const modus = async (body) => (await aufruf(h, body)).json()
  const riegel = (id) => zeile('crm_tasks', (x) => x.id === id).done_notified_at
  const mail = () => aufrufeVon('send-email')[0]?.body

  schreib('\ntask-notify: Fertigmeldung einer Teilaufgabe')
  const teilaufgabe = ({ alter = 1, geber = {} } = {}) => ({
    crm_tasks: [
      { id: 'haupt', title: 'Hauptaufgabe', description: null, created_by: GEBER, status: 'offen' },
      { id: 'teil', title: 'Zuarbeit', description: null, parent_task_id: 'haupt', created_by: GEBER, completed_by: MACHER, status: 'erledigt', done_notified_at: null, ext_creator: null, completed_at: vor(alter) },
    ],
    profiles: profile(geber),
  })
  const melden = async (daten, waFn, mailFn = mailOk) => {
    start(daten, waFn)
    funktionen['send-email'] = mailFn
    return modus({ mode: 'subtask_done', task_id: 'teil' })
  }
  let r = await melden(teilaufgabe(), wa.ok)
  ok(r.via === 'whatsapp' && aufrufeVon('send-email').length === 0 && riegel('teil'), 'Erfolg: per WhatsApp, keine Mail, Riegel zu')
  r = await melden(teilaufgabe(), wa.fehlversand)
  ok(r.via === 'mail' && mail()?.to === 'geber@example.com' && riegel('teil'), 'Fehlversand: Mail als Ersatz, Riegel zu')
  ok(!mail()?.html.includes('Trage im Profil'), 'Fehlversand: kein Hinweis auf eine fehlende Nummer, die Nummer ist ja da')
  r = await melden(teilaufgabe(), wa.http)
  ok(r.via === 'mail' && riegel('teil'), 'HTTP-Fehler: Mail als Ersatz, Riegel zu')
  r = await melden(teilaufgabe({ geber: { phone: null } }), wa.ok)
  ok(r.via === 'mail' && mail()?.html.includes('Trage im Profil') && aufrufeVon('send-whatsapp').length === 0, 'Ohne Nummer: Mail mit Hinweis, wie bisher')
  r = await melden(teilaufgabe({ geber: { email: null } }), wa.fehlversand)
  ok(r.skipped === 'versand_fehlgeschlagen' && riegel('teil') === null, 'Fehlversand ohne Mail, frisch: Riegel offen für den Sweep')
  r = await melden(teilaufgabe(), wa.fehlversand, mailKaputt)
  ok(r.skipped === 'versand_fehlgeschlagen' && riegel('teil') === null, 'Fehlversand und Mail kaputt: Riegel offen für den Sweep')
  r = await melden(teilaufgabe({ alter: 25, geber: { email: null } }), wa.fehlversand)
  ok(r.skipped === 'versand_fehlgeschlagen' && riegel('teil') && gewarnt(/aufgegeben/), 'Fehlversand ohne Mail, älter als 24 Stunden: aufgegeben, Riegel bleibt zu')

  schreib('\ntask-notify: Sweep hört auf')
  start(teilaufgabe({ alter: 25, geber: { email: null } }), wa.fehlversand)
  r = await modus({ mode: 'subtask_sweep' })
  const zweiter = await modus({ mode: 'subtask_sweep' })
  ok(r.swept === 1 && zweiter.swept === 0, 'Älter als 24 Stunden: genau ein Versuch, dann nicht mehr')
  start(teilaufgabe({ geber: { email: null } }), wa.fehlversand)
  await modus({ mode: 'subtask_sweep' })
  funktionen['send-whatsapp'] = wa.ok
  r = await modus({ mode: 'subtask_sweep' })
  ok(r.swept === 1 && r.out[0].via === 'whatsapp' && riegel('teil'), 'Frisch: nächster Sweep stellt zu, sobald WhatsApp wieder geht')

  schreib('\ntask-notify: Fertigmeldung an externe Aufgabengeber')
  const extern = ({ alter = 1, email = null, phone = TEST_NUMMER } = {}) => ({
    crm_tasks: [{ id: 'ext', title: 'Von außen', parent_task_id: null, created_by: GEBER, completed_by: GEBER, status: 'erledigt', done_notified_at: null, ext_creator: { name: 'Gast Test', email, phone, lang: 'de' }, completed_at: vor(alter) }],
    profiles: profile(),
  })
  const meldenExtern = async (daten, waFn) => {
    start(daten, waFn)
    funktionen['send-email'] = mailOk
    return modus({ mode: 'subtask_done', task_id: 'ext' })
  }
  r = await meldenExtern(extern({ email: 'gast@example.com' }), wa.ok)
  ok(r.via === 'whatsapp' && r.external === true && aufrufeVon('send-email').length === 0, 'Erfolg: per WhatsApp, keine Mail')
  r = await meldenExtern(extern({ email: 'gast@example.com' }), wa.fehlversand)
  ok(r.via === 'mail' && mail()?.to === 'gast@example.com' && riegel('ext'), 'Fehlversand: Mail als Ersatz, Riegel zu')
  r = await meldenExtern(extern(), wa.fehlversand)
  ok(r.skipped === 'versand_fehlgeschlagen' && riegel('ext') === null, 'Fehlversand ohne Mail, frisch: Riegel offen für den Sweep')
  r = await meldenExtern(extern({ alter: 25 }), wa.fehlversand)
  ok(r.skipped === 'versand_fehlgeschlagen' && riegel('ext') && gewarnt(/aufgegeben/), 'Fehlversand ohne Mail, älter als 24 Stunden: aufgegeben, Riegel bleibt zu')

  schreib('\ntask-notify: Aufgaben-Nachricht')
  const nachricht = (geber = {}) => ({
    crm_task_messages: [{ id: 'msg', task_id: 't', sender_id: MACHER, sender_label: null, recipient_id: GEBER, body: 'Kurze Rückfrage', created_at: vor(1), ext_notified_at: null }],
    crm_tasks: [{ id: 't', title: 'Aufgabe', parent_task_id: null, archived: false }],
    profiles: profile(geber),
  })
  const melde = async (daten, waFn) => {
    start(daten, waFn)
    funktionen['send-email'] = mailOk
    return modus({ mode: 'message', message_id: 'msg' })
  }
  r = await melde(nachricht(), wa.ok)
  ok(r.targets[GEBER] === 'whatsapp' && aufrufeVon('send-email').length === 0, 'Erfolg: per WhatsApp, keine Mail')
  r = await melde(nachricht(), wa.fehlversand)
  ok(r.targets[GEBER] === 'mail' && mail()?.to === 'geber@example.com', 'Fehlversand: Mail als Ersatz')
  r = await melde(nachricht(), wa.http)
  ok(r.targets[GEBER] === 'mail', 'HTTP-Fehler: Mail als Ersatz')
  r = await melde(nachricht({ email: null }), wa.fehlversand)
  ok(r.targets[GEBER] === 'kein_kanal', 'Fehlversand ohne Mail: als kein_kanal gemeldet, nicht als whatsapp')

  schreib('\ntask-notify: Zustellung und Erinnerung an Zuständige')
  const AUFGABE = { id: 't', title: 'Aufgabe', description: null, due_date: null, status: 'offen', archived: false, parent_task_id: null, ext_creator: null }
  const zustaendig = (extra = {}) => ({ id: 'z', task_id: 't', profile_id: null, ext_name: 'Partner Test', ext_email: null, ext_phone: TEST_NUMMER, ext_lang: 'de', channel: 'whatsapp', token: 'tok', last_reminded_at: null, ...extra })
  const stempel = () => zeile('crm_task_assignees', (x) => x.id === 'z').last_reminded_at
  start({ crm_tasks: [AUFGABE], crm_task_assignees: [zustaendig()], profiles: profile() }, wa.ok)
  r = await modus({ mode: 'dispatch', task_id: 't' })
  ok(r.delivered[0].whatsapp === true && stempel(), 'Nur WhatsApp, Erfolg: whatsapp:true, Stempel gesetzt')
  start({ crm_tasks: [AUFGABE], crm_task_assignees: [zustaendig()], profiles: profile() }, wa.fehlversand)
  r = await modus({ mode: 'dispatch', task_id: 't' })
  ok(r.delivered[0].whatsapp === false && stempel() == null, 'Nur WhatsApp, Fehlversand: whatsapp:false, Stempel bleibt leer')
  funktionen['send-whatsapp'] = wa.ok
  r = await modus({ mode: 'dispatch', task_id: 't' })
  ok(r.delivered.length === 1 && r.delivered[0].whatsapp === true && stempel(), 'Nur WhatsApp, Fehlversand: neue Zustellung holt es nach')
  start({ crm_tasks: [AUFGABE], crm_task_assignees: [zustaendig({ profile_id: GEBER })], profiles: profile() }, wa.fehlversand)
  r = await modus({ mode: 'dispatch', task_id: 't' })
  ok(r.delivered[0].mail === true && r.delivered[0].whatsapp === false && stempel(), 'Mail und WhatsApp, Fehlversand: Mail ging raus, Stempel gesetzt, whatsapp:false')
  start({ crm_task_assignees: [zustaendig({ task: AUFGABE })], crm_tasks: [AUFGABE], profiles: profile() }, wa.fehlversand)
  await modus({ mode: 'reminder' })
  ok(stempel() == null, 'Erinnerung, nur WhatsApp, Fehlversand: Stempel bleibt leer')
  funktionen['send-whatsapp'] = wa.ok
  await modus({ mode: 'reminder' })
  ok(stempel(), 'Erinnerung, nur WhatsApp: nächster Lauf stellt zu und stempelt')
}

// ── affiliate-api ────────────────────────────────────────────────────────────
schreib('\naffiliate-api: Auszahlungslink und Abrechnung')
{
  const h = (await lade('affiliate-api/index.ts')).handler
  const daten = ({ aff = {}, payout = {} } = {}) => ({
    affiliate_payouts: [{ id: 'pay', affiliate_id: 'aff', status: 'abgerechnet', amount: 1000, doc_no: 'TG-2026-001', payout_link_id: null, payout_link_state: null, payout_link: null, payout_link_attempt: 0, payout_link_sent_at: null, payout_link_expires_at: null, referred_lead_id: null, service_date: '2026-06-01', created_at: vor(24), ...payout }],
    affiliates: [{ id: 'aff', name: 'Tipp Geber', email: 'tipp@example.com', whatsapp: TEST_NUMMER, ...aff }],
    invoice_settings: [{ id: true, legal_name: 'Testfirma', brand_name: 'Happy Property' }],
    connector_secrets: [{ key: 'CRON_SECRET', value: 'cron-test' }],
    leads: [],
  })
  const LINK = { success: true, id: 'link', url: 'https://revolut.test/link', state: 'active', expiry_date: '2026-07-01T00:00:00Z' }
  const einrichten = (d, waFn) => {
    start(d, waFn)
    funktionen['revolut-sync'] = () => ({ data: LINK, error: null })
    wege['/functions/v1/send-email'] = () => antwort(200, { success: true })
  }
  const stempel = () => zeile('affiliate_payouts', (x) => x.id === 'pay').payout_link_sent_at
  const link = async (d, waFn) => {
    einrichten(d, waFn)
    return (await aufruf(h, { action: 'payout_link', payout_id: 'pay' }, SERVICE_BEARER)).json()
  }
  let r = await link(daten(), wa.ok)
  ok(r.sent === true && stempel() && netzAn('send-email').length === 0, 'Link, Erfolg: per WhatsApp, keine Mail, Stempel gesetzt')
  r = await link(daten(), wa.fehlversand)
  ok(r.sent === true && stempel() && netzAn('send-email').length === 1, 'Link, Fehlversand: Mail als Ersatz, Stempel gesetzt')
  r = await link(daten({ aff: { email: null } }), wa.fehlversand)
  ok(r.sent === false && stempel() == null, 'Link, Fehlversand ohne Mail: sent:false, Stempel bleibt leer')
  r = await link(daten(), wa.http)
  ok(r.sent === true && netzAn('send-email').length === 1, 'Link, HTTP-Fehler: Mail als Ersatz')

  const scan = async (d, waFn) => {
    einrichten(d, waFn)
    return (await aufruf(h, { action: 'commission_scan', wait: true }, { 'x-cron-secret': 'cron-test' })).json()
  }
  const offen = { payout: { payout_link_id: 'link', payout_link_state: 'active', payout_link: LINK.url, payout_link_attempt: 1 } }
  r = await scan(daten({ ...offen, aff: { email: null } }), wa.fehlversand)
  ok(r.links?.[0]?.sent === false && stempel() == null, 'Scan, Fehlversand ohne Mail: Stempel bleibt leer, nächster Scan schickt erneut')
  r = await scan(daten({ ...offen, aff: { email: null } }), wa.ok)
  ok(r.links?.[0]?.sent === true && stempel(), 'Scan, Erfolg: Link raus, Stempel gesetzt')

  const abrechnung = async (d, waFn) => {
    einrichten(d, waFn)
    return (await aufruf(h, { action: 'resend', payout_id: 'pay' }, SERVICE_BEARER)).json()
  }
  r = await abrechnung(daten({ ...offen, aff: { email: null } }), wa.fehlversand)
  ok(stempel() == null, 'Abrechnung, Fehlversand ohne Mail: Link gilt nicht als gesendet')
  ok(r.error === 'Weder Mail noch WhatsApp zugestellt', 'Abrechnung, Fehlversand ohne Mail: Fehler an den Aufrufer')
  r = await abrechnung(daten({ ...offen, aff: { email: null } }), wa.ok)
  ok(stempel() && !r.error, 'Abrechnung, Erfolg: Link gilt als gesendet')
}

// ── revolut-sync ─────────────────────────────────────────────────────────────
schreib('\nrevolut-sync: Info-WhatsApp nach Überweisung')
{
  const h = (await lade('revolut-sync/index.ts')).handler
  const IBAN = 'DE89370400440532013000'
  const zahlen = async (waFn) => {
    start({
      integration_secrets: [{ key: 'revolut_refresh_token', value: 'refresh' }],
      fin_payables: [{ id: 'rechnung', vendor: 'Testfirma', title: 'Rechnung 1', amount: 100, currency: 'EUR', status: 'offen', beneficiary: 'Testfirma GmbH', iban: IBAN, bic: null, revolut_payment_id: null, partner_mail_id: null }],
      crm_business_contacts: [{ first_name: 'Partner', whatsapp: TEST_NUMMER, phone: null, language: 'de' }],
    }, waFn)
    wege['/auth/token'] = () => antwort(200, { access_token: 'token' })
    wege['/accounts'] = () => antwort(200, [{ id: 'konto', currency: 'EUR', balance: 100000, state: 'active' }])
    wege['/counterparties'] = () => antwort(200, [{ id: 'empfaenger', accounts: [{ iban: IBAN }] }])
    wege['/pay'] = () => antwort(200, { id: 'zahlung', state: 'pending' })
    return (await aufruf(h, { action: 'pay_payable', payable_id: 'rechnung' })).json()
  }
  const bezahlt = () => zeile('fin_payables', (x) => x.id === 'rechnung').status === 'bezahlt'
  let r = await zahlen(wa.ok)
  ok(r.success === true && r.wa_notified === true && r.wa_info === 'ok', 'Erfolg: wa_notified:true')
  r = await zahlen(wa.fehlversand)
  ok(r.success === true && bezahlt(), 'Fehlversand: Zahlung bleibt beauftragt')
  ok(r.wa_notified === false && r.wa_info === 'Fehler beim WhatsApp-Versand', 'Fehlversand: wa_notified:false, Finance zeigt den Hinweis')
  ok(!geloggt(/Zahlungs-WhatsApp an .* gesendet/), 'Fehlversand: Protokoll behauptet keinen Versand')
  r = await zahlen(wa.http)
  ok(r.wa_notified === false, 'HTTP-Fehler: wa_notified:false')
}

// ── generate-invoice ─────────────────────────────────────────────────────────
schreib('\ngenerate-invoice: Rechnungs-WhatsApp')
{
  const h = (await lade('generate-invoice/index.ts')).handler
  const rechnung = async (waFn) => {
    start({
      invoice_settings: [{ id: true, legal_name: 'Testfirma', brand_name: 'Happy Property', default_due_days: 7, logo_url: '' }],
      invoice_customers: [{ id: 'kunde', is_default: true, company_name: 'Partner GmbH', contact_name: 'Partner', email: 'partner@example.com', whatsapp: TEST_NUMMER, country_mode: 'cyprus' }],
    })
    rpcs.claim_invoice_number = () => ({ data: 'HP-TEST-1', error: null })
    wege['/functions/v1/send-email'] = () => antwort(200, { success: true })
    wege['/functions/v1/send-whatsapp'] = waFn
    return (await aufruf(h, { items: [{ description: 'Lead-Generierung und Marketing', quantity: 1, unit_price_net: 100 }], send: true }, SERVICE_BEARER)).json()
  }
  let r = await rechnung(waFetch.ok)
  ok(r.ok === true && r.sent === true && geloggt(/Rechnungs-WhatsApp an .* gesendet/) && !gewarnt(/Rechnungs-WhatsApp/), 'Erfolg: als gesendet protokolliert')
  r = await rechnung(waFetch.fehlversand)
  ok(!geloggt(/Rechnungs-WhatsApp an .* gesendet/) && gewarnt(/Rechnungs-WhatsApp an .* nicht zugestellt.*WhatsApp nicht verbunden/), 'Fehlversand: Warnung mit Grund, kein „gesendet"')
  ok(r.ok === true && r.sent === true, 'Fehlversand: sent hängt weiter an der Mail')
  r = await rechnung(waFetch.http)
  ok(!geloggt(/Rechnungs-WhatsApp an .* gesendet/) && gewarnt(/nicht zugestellt/), 'HTTP-Fehler: ebenfalls gewarnt')
}

// ── recurring-followups ──────────────────────────────────────────────────────
schreib('\nrecurring-followups: Takt nur bei echtem Versand')
{
  const h = (await lade('recurring-followups/index.ts')).handler
  const quelle = readFileSync(join(root, 'supabase/functions/recurring-followups/index.ts'), 'utf8')
  const HOLD_MAIL = quelle.match(/HOLD_EMAIL_ID = '([^']+)'/)[1]
  const BURKHARD = quelle.match(/BURKHARD_ID\s*= '([^']+)'/)[1]
  const lauf = async ({ lead = {}, deals, whatsapp = waFetch.ok, email = () => antwort(200, { success: true }) }) => {
    start({
      deals,
      leads: [leadZeile(lead)],
      email_templates: [{ id: HOLD_MAIL, subject: 'Betreff', body: 'Text', html_body: null }],
      whatsapp_templates: [{ event_type: 'hold_reengagement', active: true, message_template: 'Hallo {{vorname}}' }],
      crm_business_contacts: [{ id: BURKHARD, whatsapp: TEST_NUMMER, phone: null }],
    })
    wege['/functions/v1/send-whatsapp'] = whatsapp
    wege['/functions/v1/send-email'] = email
    return (await aufruf(h, {})).json()
  }
  const hold = () => [{ id: 'hold', lead_id: LEAD, phase: 'hold', hold_contact: true, last_hold_msg_at: null }]
  const uebergeben = () => [{ id: 'ping', lead_id: LEAD, phase: 'kontakt_uebergeben', handover_at: vor(24), last_handover_ping_at: null }]
  const takt = () => zeile('deals', (x) => x.id === 'hold').last_hold_msg_at
  const ping = () => zeile('deals', (x) => x.id === 'ping').last_handover_ping_at

  let r = await lauf({ deals: hold() })
  ok(r.holdSent === 1 && takt(), 'Hold, beides raus: Takt läuft weiter')
  r = await lauf({ deals: hold(), whatsapp: waFetch.fehlversand })
  ok(r.holdSent === 1 && takt() && gewarnt(/send-whatsapp nicht zugestellt/), 'Hold, nur Mail raus: Takt läuft weiter, Warnung zum Fehlversand')
  r = await lauf({ deals: hold(), lead: { email: null }, whatsapp: waFetch.fehlversand })
  ok(r.holdSent === 0 && takt() == null, 'Hold, nur WhatsApp, Fehlversand: Takt bleibt stehen')
  r = await lauf({ deals: hold(), whatsapp: waFetch.fehlversand, email: () => antwort(500, { error: 'SMTP kaputt' }) })
  ok(r.holdSent === 0 && takt() == null, 'Hold, beides gescheitert: Takt bleibt stehen')
  r = await lauf({ deals: hold(), lead: { email: null }, whatsapp: waFetch.http })
  ok(r.holdSent === 0 && takt() == null, 'Hold, nur WhatsApp, HTTP-Fehler: Takt bleibt stehen')
  r = await lauf({ deals: uebergeben() })
  ok(r.pingSent === 1 && ping(), 'Übergabe-Nachfrage, Erfolg: Takt läuft weiter')
  r = await lauf({ deals: uebergeben(), whatsapp: waFetch.fehlversand })
  ok(r.pingSent === 0 && ping() == null, 'Übergabe-Nachfrage, Fehlversand: Takt bleibt stehen')
}

// ── partner-akte ─────────────────────────────────────────────────────────────
schreib('\npartner-akte: Notiz zum Akten-Link')
{
  const h = (await lade('partner-akte/index.ts')).handler
  const anlegen = async (waFn) => {
    start({ leads: [leadZeile()], profiles: [{ id: ADMIN, role: 'admin' }], lead_partner_shares: [], activities: [] }, waFn)
    return (await aufruf(h, { action: 'create', lead_id: LEAD, whatsapp: TEST_NUMMER, partner_name: 'Partner' }, { Authorization: `Bearer ${ADMIN_JWT}` })).json()
  }
  const notiz = () => zeile('activities', (x) => x.lead_id === LEAD)?.content ?? ''
  let r = await anlegen(wa.ok)
  ok(r.wa_sent === true && notiz().includes('geschickt') && !notiz().includes('NICHT'), 'Erfolg: wa_sent:true, Notiz sagt geschickt')
  r = await anlegen(wa.fehlversand)
  ok(r.wa_sent === false && notiz().includes('NICHT zugestellt') && !notiz().includes('geschickt'), 'Fehlversand: wa_sent:false, Notiz sagt NICHT zugestellt')
  ok(notiz().includes(r.url), 'Fehlversand: Notiz enthält den Link zum Weitergeben')
}

schreib(fehler ? `\n${fehler} FEHLER` : '\nAlles grün')
process.exit(fehler ? 1 : 0)
