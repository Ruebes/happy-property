// Prüft die Querverweise (src/lib/entityLinks.ts) gegen die Routen-Guards in
// src/App.tsx. Exit 1 bei Fehlern.
//
//   1  jedes gelieferte Ziel trifft eine Route aus App.tsx (Pfad ohne Query),
//      und der Guard dieser Route lässt genau diese Rolle mit diesen Rechten durch;
//      externe Ziele (Token-Seiten) treffen eine öffentliche Route
//   2  die Ziele je Rolle entsprechen der Tabelle aus dem Vertrag (UI-LINKS-SPEC Teil B)
//   3  Eigentümer bekommen für jede CRM-Art null, Feriengäste für alles
//   4  ohne die nötigen Angaben (Projekt, Kunde, Token) gibt es kein Ziel statt
//      eines kaputten Links; Query-Parameter heißen open, task, unit, lead oder tab
//
// Aufruf: node scripts/verify-entity-links.mjs   oder   npm run verify:links

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { parseAppRoutes, guardAllowsRoute, matchRoute } from './lib/routes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_FILE = join(ROOT, 'src/App.tsx')

const errors = []
const passed = []
const fail = (check, msg) => errors.push({ check, msg })
const mark = (check, title) => { if (!errors.some(e => e.check === check)) passed.push(`${check}  ${title}`) }

async function loadModules() {
  const outDir = mkdtempSync(join(tmpdir(), 'hp-verify-links-'))
  try {
    const outfile = join(outDir, 'links.mjs')
    const entry = [
      `export * from ${JSON.stringify(join(ROOT, 'src/lib/entityLinks.ts'))}`,
      `export { hasPerm } from ${JSON.stringify(join(ROOT, 'src/lib/permissions.ts'))}`,
    ].join('\n')
    await build({
      stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'verify-links-entry.ts' },
      outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

const { routes } = parseAppRoutes(APP_FILE, (check, msg) => fail(1, `Routen-Leser [${check}]: ${msg}`))
const { entityPath, ENTITY_KINDS, hasPerm } = await loadModules()

const profileOf = (role, perms = []) => ({
  id: 'verify', email: 'verify@example.invalid', full_name: 'Verify', phone: null, role, language: 'de',
  verwaltung_id: null, permissions: Object.fromEntries(perms.map(p => [p, true])),
})
const CASES = [
  { name: 'admin', profile: profileOf('admin') },
  { name: 'verwalter', profile: profileOf('verwalter') },
  { name: 'mitarbeiter {pipeline}', profile: profileOf('mitarbeiter', ['pipeline']) },
  { name: 'mitarbeiter {contacts}', profile: profileOf('mitarbeiter', ['contacts']) },
  { name: 'mitarbeiter {funnel, werbung, thumbnails}', profile: profileOf('mitarbeiter', ['funnel', 'werbung', 'thumbnails']) },
  { name: 'mitarbeiter {invoices}', profile: profileOf('mitarbeiter', ['invoices']) },
  { name: 'mitarbeiter {}', profile: profileOf('mitarbeiter') },
  { name: 'funnel', profile: profileOf('funnel') },
  { name: 'eigentuemer', profile: profileOf('eigentuemer') },
  { name: 'feriengast', profile: profileOf('feriengast') },
]

const ID = 'id-1'
const FULL = { leadId: 'lead-1', projectId: 'proj-1', unitId: 'unit-1', token: 'tok-1' }
// Angaben, mit denen jede Art einmal durchgespielt wird (Prüfung 1 und 4)
const OPT_VARIANTS = [
  { label: 'ohne Angaben', opts: undefined },
  { label: 'alle Angaben', opts: FULL },
  { label: 'archiviert', opts: { ...FULL, archived: true } },
  { label: 'nur Kunde', opts: { leadId: 'lead-1' } },
  { label: 'nur Projekt', opts: { projectId: 'proj-1' } },
  { label: 'nur Token', opts: { token: 'tok-1' } },
  { label: 'mit Reiter', opts: { ...FULL, tab: 'tasks' } },
]
const ALLOWED_QUERY = ['open', 'task', 'unit', 'lead', 'tab']
const TOKEN_KINDS = ['deck', 'calculation', 'strategy']

// ── 1 + 4: jedes Ziel trifft eine Route, deren Guard die Rolle durchlässt ────
let targetCount = 0
for (const { name, profile } of CASES) {
  for (const kind of ENTITY_KINDS) {
    for (const { label, opts } of OPT_VARIANTS) {
      for (const id of [ID, '']) {
        const where = `${name}, ${kind} (${label}${id ? '' : ', ohne Id'})`
        let target
        try { target = entityPath(kind, id, opts, profile) } catch (err) {
          fail(1, `${where}: entityPath wirft ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        if (target === null) continue
        targetCount++
        if (typeof target.to !== 'string' || !target.to.startsWith('/')) { fail(1, `${where}: Ziel "${target.to}" ist kein absoluter Pfad`); continue }
        const [pathname, query = ''] = target.to.split('?')
        if (/(undefined|null)/.test(target.to) || pathname.includes('//') || pathname.endsWith('/')) fail(4, `${where}: Ziel ${target.to} sieht unvollständig aus`)
        for (const pair of query.split('&').filter(Boolean)) {
          const [key, value] = pair.split('=')
          if (!ALLOWED_QUERY.includes(key)) fail(4, `${where}: unbekannter Query-Parameter "${key}" in ${target.to}`)
          if (!value) fail(4, `${where}: leerer Query-Parameter "${key}" in ${target.to}`)
        }
        const route = matchRoute(routes, pathname)
        if (!route) { fail(1, `${where}: ${pathname} ist keine Route in App.tsx`); continue }
        if (target.external) {
          if (route.kind !== 'public') fail(1, `${where}: externes Ziel ${pathname} trifft die geschützte Route ${route.path}`)
          if (!TOKEN_KINDS.includes(kind)) fail(1, `${where}: nur Token-Seiten dürfen extern sein`)
        } else if (route.kind === 'public') {
          fail(1, `${where}: ${pathname} trifft die öffentliche Route ${route.path}, ist aber nicht als extern markiert`)
        } else if (!guardAllowsRoute(route, profile, hasPerm)) {
          fail(1, `${where}: ${target.to} würde der Guard von ${route.path} (App.tsx Zeile ${route.line}) abweisen`)
        }
      }
    }
  }
}
mark(1, `${targetCount} Ziele für ${CASES.length} Profile treffen eine Route, die der Guard durchlässt`)

// ── 2: Ziele je Rolle wie im Vertrag ────────────────────────────────────────
// Schreibweise: 'pfad' = Ziel der eigenen Art, ['pfad', 'art'] = Ausweichziel
// über eine andere Art, null = kein Link. Aufruf je Art mit allen Angaben (FULL);
// 'deal:archived' zusätzlich mit archived: true.
const LEAD = ['/admin/crm/leads/lead-1', 'lead']
const UNIT = ['/admin/crm/projects/proj-1?unit=id-1', 'project']
const TOKENS = { deck: '/deck/tok-1', calculation: '/rechnung/tok-1', strategy: '/strategie/tok-1' }
const NOTHING = Object.fromEntries([...ENTITY_KINDS, 'deal:archived'].map(kind => [kind, null]))
const PIPELINE = {
  lead: '/admin/crm/leads/id-1', deal: LEAD, 'deal:archived': '/admin/crm/archived?open=id-1',
  project: '/admin/crm/projects/id-1', unit: UNIT, task: '/admin/crm/tasks?task=id-1',
  appointment: '/admin/crm/calendar?open=id-1', inbox: '/admin/crm/inbox?lead=id-1', ...TOKENS,
}
const EXPECTED = {
  'admin': {
    ...NOTHING, ...PIPELINE,
    property: '/admin/properties/id-1', owner: '/admin/users?open=id-1', invoice: '/admin/crm/invoices?open=id-1',
    review: '/admin/crm/reviews?open=id-1', affiliate: '/admin/crm/affiliates?open=id-1', newsletter: '/admin/crm/newsletter',
  },
  'verwalter': {
    ...NOTHING, ...PIPELINE,
    property: '/verwalter/properties/id-1', owner: LEAD, invoice: '/admin/crm/invoices?open=id-1',
    review: LEAD, affiliate: LEAD, newsletter: '/admin/crm/newsletter',
  },
  'mitarbeiter {pipeline}': {
    ...NOTHING, ...PIPELINE,
    property: ['/admin/crm/projects/proj-1?unit=unit-1', 'unit'], owner: LEAD, review: LEAD, affiliate: LEAD,
  },
  // 'contacts' allein reicht nicht für die Kundenseite (leads-RLS verlangt 'pipeline')
  'mitarbeiter {contacts}': { ...NOTHING, task: '/admin/crm/tasks?task=id-1', ...TOKENS },
  'mitarbeiter {funnel, werbung, thumbnails}': { ...NOTHING, task: '/admin/crm/tasks?task=id-1', newsletter: '/admin/crm/newsletter', ...TOKENS },
  'mitarbeiter {invoices}': { ...NOTHING, task: '/admin/crm/tasks?task=id-1', invoice: '/admin/crm/invoices?open=id-1', ...TOKENS },
  'mitarbeiter {}': { ...NOTHING, task: '/admin/crm/tasks?task=id-1', ...TOKENS },
  'funnel': { ...NOTHING, newsletter: '/admin/crm/newsletter' },
  'eigentuemer': { ...NOTHING, property: '/eigentuemer/properties/id-1' },
  'feriengast': { ...NOTHING },
}
const show = target => (target ? `${target.to}${target.via ? ` (über ${target.via})` : ''}${target.external ? ' (extern)' : ''}` : 'null')
for (const { name, profile } of CASES) {
  const table = EXPECTED[name]
  if (!table) { fail(2, `${name}: keine Erwartung hinterlegt`); continue }
  for (const key of Object.keys(NOTHING)) {
    const [kind, flag] = key.split(':')
    const got = entityPath(kind, ID, flag === 'archived' ? { ...FULL, archived: true } : FULL, profile)
    const want = table[key]
    const wantTo = Array.isArray(want) ? want[0] : want
    const wantVia = Array.isArray(want) ? want[1] : undefined
    const wantExternal = TOKEN_KINDS.includes(kind) && want !== null
    const same = want === null
      ? got === null
      : got !== null && got.to === wantTo && (got.via ?? undefined) === wantVia && Boolean(got.external) === wantExternal
    if (!same) fail(2, `${name}, ${key}: erwartet ${want === null ? 'null' : `${wantTo}${wantVia ? ` (über ${wantVia})` : ''}`}, ist ${show(got)}`)
  }
}
mark(2, `Ziele je Rolle wie im Vertrag (${Object.keys(NOTHING).length} Arten, ${CASES.length} Profile)`)

// ── 3: Eigentümer ohne CRM-Ziele, Feriengast ohne jedes Ziel ────────────────
const byName = Object.fromEntries(CASES.map(c => [c.name, c.profile]))
for (const kind of ENTITY_KINDS) {
  for (const { label, opts } of OPT_VARIANTS) {
    if (kind !== 'property' && entityPath(kind, ID, opts, byName.eigentuemer) !== null) fail(3, `eigentuemer, ${kind} (${label}): CRM-Ziel geliefert`)
    if (entityPath(kind, ID, opts, byName.feriengast) !== null) fail(3, `feriengast, ${kind} (${label}): Ziel geliefert`)
    if (entityPath(kind, ID, opts, null) !== null) fail(3, `ohne Profil, ${kind} (${label}): Ziel geliefert`)
  }
}
mark(3, 'Eigentümer nur mit Objekt-Ziel, Feriengast und fehlendes Profil ohne Ziel')

// ── 4: fehlende Angaben ergeben kein Ziel ───────────────────────────────────
const admin = byName.admin
const expectNull = (what, target) => { if (target !== null) fail(4, `${what}: erwartet null, ist ${show(target)}`) }
expectNull('Wohnung ohne Projekt', entityPath('unit', ID, undefined, admin))
expectNull('aktiver Vorgang ohne Kunde', entityPath('deal', ID, undefined, admin))
for (const kind of TOKEN_KINDS) expectNull(`${kind} ohne Token`, entityPath(kind, ID, { leadId: 'lead-1' }, admin))
for (const kind of ['lead', 'project', 'task', 'invoice', 'inbox']) expectNull(`${kind} ohne Id`, entityPath(kind, '', FULL, admin))
expectNull('Objekt für Mitarbeiter ohne Wohnung und Kunde', entityPath('property', ID, undefined, byName['mitarbeiter {pipeline}']))
const encoded = entityPath('lead', 'a/b c', undefined, admin)
if (encoded?.to !== '/admin/crm/leads/a%2Fb%20c') fail(4, `Ids werden nicht kodiert: ${show(encoded)}`)
const tabbed = entityPath('lead', ID, { tab: 'tasks' }, admin)
if (tabbed?.to !== '/admin/crm/leads/id-1?tab=tasks') fail(4, `Reiter fehlt im Ziel: ${show(tabbed)}`)
mark(4, 'fehlende Angaben ergeben kein Ziel, Ids sind kodiert, Query-Parameter bekannt')

// ── Ausgabe ─────────────────────────────────────────────────────────────────
console.log('Ziele je Rolle (alle Angaben vorhanden)')
for (const { name, profile } of CASES) {
  console.log(`\n  ${name}`)
  for (const kind of ENTITY_KINDS) {
    const target = entityPath(kind, ID, FULL, profile)
    if (target) console.log(`    ${kind.padEnd(12)} ${show(target)}`)
  }
  const none = ENTITY_KINDS.filter(kind => entityPath(kind, ID, FULL, profile) === null)
  console.log(`    ohne Link: ${none.length ? none.join(', ') : '(keine)'}`)
}
console.log('')
for (const line of passed) console.log('  OK ' + line)
if (errors.length) {
  console.error(`\nverify-entity-links: ${errors.length} Fehler`)
  for (const e of errors.sort((a, b) => a.check - b.check)) console.error(`  FEHLER [${e.check}] ${e.msg}`)
  process.exit(1)
}
console.log(`\nverify-entity-links: OK (${routes.length} Routen, ${ENTITY_KINDS.length} Arten, ${CASES.length} Profile, 4 Prüfungen)`)
