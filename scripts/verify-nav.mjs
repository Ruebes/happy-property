// Prüft die Navigations-Registry (src/lib/navigation.ts) gegen die Routen-Guards
// in src/App.tsx, die Übersetzungen und die Icons. Exit 1 bei Fehlern.
//
//   1  jede geschützte Route hat einen Registry-Eintrag, jeder Registry-Pfad ist eine Route
//   2  roles eines Eintrags sind eine Teilmenge der vom Guard erlaubten Rollen
//   3  perm/anyPerm eines Mitarbeiter-Eintrags entsprechen exakt dem Guard
//   4  geschützte Routen (ohne Feriengast) liegen in der AppShell-Route, öffentliche nicht
//   5  Ids eindeutig, Einträge mit gleichem Pfad haben getrennte Rollen
//   6  jeder labelKey (und jeder shortLabelKey der Telefon-Leiste) existiert in
//      de.json und en.json; shell.* ohne Gedankenstrich, ohne Emoji, im Deutschen
//      ohne ae/oe/ue-Ersatzschreibung
//   7  jedes Icon existiert in src/components/shell/iconPaths.ts
//   8  Telefon-Leiste: höchstens 4 Einträge, nie ein Eintrag, den der Guard abweist
//      (dasselbe gilt für das Menü); feste Reihenfolge je Rolle; bei 4 Einträgen
//      (5 Felder mit "Mehr", je rund 67 px bei 375 px Breite) höchstens 11
//      Zeichen je Beschriftung in de und en (Kurzform, sonst voller Name)
//   9  App.tsx holt lazy ausschließlich aus lib/lazyWithReload
//  10  jedes wörtliche basePath="..." in src/pages ist ein echter Routen-Pfad
//
// Warnungen (Exit 0): Rollen, die eine Route öffnen dürfen, aber keinen Eintrag
// dafür haben; Einträge mit Modul "tbd"; nicht erreichbare Seiten-Dateien.
//
// Aufruf: node scripts/verify-nav.mjs   oder   npm run verify:nav

import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'
import { ALL_ROLES, parseAppRoutes, guardAllowsRoute } from './lib/routes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_FILE = join(ROOT, 'src/App.tsx')

const errors = []
const warnings = []
const passed = []
const fail = (check, msg) => errors.push({ check, msg })
const warn = msg => warnings.push(msg)

// ── Registry, Rechte-Helfer und Icons per esbuild laden ─────────────────────
async function loadRegistry() {
  const outDir = mkdtempSync(join(tmpdir(), 'hp-verify-nav-'))
  try {
    const outfile = join(outDir, 'registry.mjs')
    const entry = [
      `export * from ${JSON.stringify(join(ROOT, 'src/lib/navigation.ts'))}`,
      `export { hasPerm, PERMISSION_AREAS } from ${JSON.stringify(join(ROOT, 'src/lib/permissions.ts'))}`,
      `export { ICON_PATHS } from ${JSON.stringify(join(ROOT, 'src/components/shell/iconPaths.ts'))}`,
    ].join('\n')
    await build({
      stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'verify-nav-entry.ts' },
      outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

// ── App.tsx lesen (gemeinsamer Leser, auch von verify-entity-links genutzt) ──
const { appText, sf, lineOf, routes, routeByPath, shellRouteCount } = parseAppRoutes(APP_FILE, fail)

const reg = await loadRegistry()
const { NAV_ENTRIES, NAV_GROUPS, groupedNav, mobileBar, canSee, matchEntry, hasPerm, ICON_PATHS } = reg
const entriesByPath = new Map()
for (const e of NAV_ENTRIES) {
  if (!entriesByPath.has(e.path)) entriesByPath.set(e.path, [])
  entriesByPath.get(e.path).push(e)
}
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x))
const mark = (check, title) => { if (!errors.some(e => e.check === check)) passed.push(`${String(check).padStart(2)}  ${title}`) }

// ── 1: Routen <-> Registry ──────────────────────────────────────────────────
for (const route of routes) {
  if (route.kind === 'guarded' && !entriesByPath.has(route.path)) {
    fail(1, `Route ${route.path} (App.tsx Zeile ${route.line}, Rollen ${route.guard.roles.join('/')}) hat keinen Registry-Eintrag`)
  }
  if (route.kind === 'guest' && !entriesByPath.has(route.path)) warn(`Feriengast-Route ${route.path} hat keinen Registry-Eintrag`)
}
for (const e of NAV_ENTRIES) {
  const route = routeByPath.get(e.path)
  if (!route) fail(1, `Registry-Eintrag "${e.id}": Pfad ${e.path} gibt es in App.tsx nicht`)
  else if (route.kind === 'public') fail(1, `Registry-Eintrag "${e.id}": ${e.path} ist in App.tsx eine öffentliche Route ohne Guard`)
}
mark(1, `Routen und Registry deckungsgleich (${routes.filter(r => r.kind === 'guarded').length} geschützte Routen, ${NAV_ENTRIES.length} Einträge)`)

// ── 2 + 3: Rollen und Rechte folgen dem Guard ───────────────────────────────
for (const e of NAV_ENTRIES) {
  const route = routeByPath.get(e.path)
  if (!route || route.kind === 'public') continue
  const g = route.guard
  for (const role of e.roles) {
    if (!ALL_ROLES.includes(role)) fail(2, `"${e.id}": unbekannte Rolle "${role}"`)
    else if (!g.roles.includes(role)) fail(2, `"${e.id}" (${e.path}): Rolle ${role} steht im Eintrag, der Guard erlaubt aber nur ${g.roles.join('/')}`)
  }
  if (e.roles.length === 0) fail(2, `"${e.id}": keine Rolle eingetragen`)
  if (e.roles.includes('mitarbeiter')) {
    if ((e.perm ?? null) !== (g.permission ?? null)) {
      fail(3, `"${e.id}" (${e.path}): perm=${e.perm ?? 'keins'}, Guard verlangt permission=${g.permission ?? 'keins'}`)
    }
    if (!sameSet([...(e.anyPerm ?? [])], [...(g.anyPermission ?? [])])) {
      fail(3, `"${e.id}" (${e.path}): anyPerm=[${(e.anyPerm ?? []).join(', ')}], Guard verlangt anyPermission=[${(g.anyPermission ?? []).join(', ')}]`)
    }
  } else if (e.perm || e.anyPerm) {
    warn(`"${e.id}": perm/anyPerm gesetzt, aber Mitarbeiter stehen nicht in roles (wirkungslos)`)
  }
}
mark(2, 'Rollen jedes Eintrags sind Teilmenge des Guards')
mark(3, 'perm/anyPerm der Mitarbeiter-Einträge entsprechen dem Guard')

// ── 4: AppShell-Route ───────────────────────────────────────────────────────
if (shellRouteCount === 0) {
  warn('Prüfung 4: In App.tsx gibt es noch keine AppShell-Route (kommt mit Schritt 3). Bis dahin gilt die Prüfung als bestanden.')
  passed.push(' 4  AppShell-Route noch nicht vorhanden, Prüfung ausgesetzt (siehe Warnung)')
} else {
  for (const route of routes) {
    if (route.kind === 'guarded' && !route.inShell) fail(4, `Route ${route.path} (Zeile ${route.line}) ist geschützt, liegt aber nicht in der AppShell-Route`)
    if (route.kind === 'public' && route.inShell) fail(4, `Öffentliche Route ${route.path} (Zeile ${route.line}) liegt in der AppShell-Route`)
    if (route.kind === 'guest' && route.inShell) fail(4, `Feriengast-Route ${route.path} (Zeile ${route.line}) liegt in der AppShell-Route`)
  }
  mark(4, 'geschützte Routen liegen in der AppShell-Route, öffentliche und Feriengast-Routen nicht')
}

// ── 5: Ids eindeutig, gleiche Pfade nur mit getrennten Rollen ───────────────
const seenIds = new Set()
for (const e of NAV_ENTRIES) {
  if (seenIds.has(e.id)) fail(5, `Id "${e.id}" ist doppelt vergeben`)
  seenIds.add(e.id)
  if (e.parent && !NAV_ENTRIES.some(p => p.id === e.parent)) fail(5, `"${e.id}": parent "${e.parent}" gibt es nicht`)
  if (e.hidden && !e.parent) fail(5, `"${e.id}": versteckter Eintrag ohne parent`)
  if (!NAV_GROUPS.some(g => g.id === e.group)) fail(5, `"${e.id}": Gruppe "${e.group}" gibt es nicht`)
}
const seenGroups = new Set()
for (const g of NAV_GROUPS) {
  if (seenGroups.has(g.id)) fail(5, `Gruppen-Id "${g.id}" ist doppelt vergeben`)
  seenGroups.add(g.id)
}
for (const [path, list] of entriesByPath) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const shared = list[i].roles.filter(r => list[j].roles.includes(r))
    if (shared.length) fail(5, `${path}: "${list[i].id}" und "${list[j].id}" teilen sich die Rolle ${shared.join('/')}`)
  }
}
mark(5, 'Ids eindeutig, gleiche Pfade mit getrennten Rollen')

// ── 6: Übersetzungen ────────────────────────────────────────────────────────
const locales = {
  de: JSON.parse(readFileSync(join(ROOT, 'src/locales/de.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(ROOT, 'src/locales/en.json'), 'utf8')),
}
const lookup = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
function flatten(obj, prefix, out = new Map()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === 'object') flatten(v, `${prefix}.${k}`, out)
    else out.set(`${prefix}.${k}`, v)
  }
  return out
}
const DASH = /[\u2013\u2014]/
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
// Ersatzschreibungen deutscher Wörter (ae/oe/ue/ss statt Umlaut), als Wortstämme
const ASCII_UMLAUT = new RegExp('(' + [
  'fuer', 'ueber', 'eigentuem', 'bautraeger', 'empfaenger', 'geschaeft', 'zurueck', 'rueck', 'oeffnen', 'loeschen',
  'aender', 'waehl', 'pruef', 'menue', 'koenn', 'moecht', 'muess', 'naechst', 'verfueg', 'gaest', 'traege',
  'fuegen', 'schluessel', 'gueltig', 'taet', 'gespraech', 'erklaer', 'taeglich', 'woechentlich', 'jaehrlich',
  'kuerz', 'laeuft', 'spaeter', 'hoehe', 'groess', 'schlaeg', 'maerz', 'buero', 'schliessen', 'strasse', 'aussen',
].join('|') + ')', 'i')

for (const lang of ['de', 'en']) {
  if (!locales[lang].shell) { fail(6, `${lang}.json: Namensraum "shell" fehlt`); continue }
  for (const e of NAV_ENTRIES) {
    if (e.labelKey !== `shell.nav.${e.id}`) fail(6, `"${e.id}": labelKey muss shell.nav.${e.id} heißen (ist ${e.labelKey})`)
    if (typeof lookup(locales[lang], e.labelKey) !== 'string') fail(6, `${lang}.json: ${e.labelKey} fehlt`)
    // Kurzform für die Telefon-Leiste: fester Schlüssel, vorhanden, kürzer als der volle Name
    if (e.shortLabelKey !== undefined) {
      const short = lookup(locales[lang], e.shortLabelKey)
      const full = lookup(locales[lang], e.labelKey)
      if (e.shortLabelKey !== `shell.navShort.${e.id}`) fail(6, `"${e.id}": shortLabelKey muss shell.navShort.${e.id} heißen (ist ${e.shortLabelKey})`)
      if (typeof short !== 'string') fail(6, `${lang}.json: ${e.shortLabelKey} fehlt`)
      else if (typeof full === 'string' && short.length >= full.length) fail(6, `${lang}.json: ${e.shortLabelKey} ("${short}") ist nicht kürzer als ${e.labelKey} ("${full}")`)
    }
  }
  for (const g of NAV_GROUPS) {
    if (g.labelKey !== `shell.groups.${g.id}`) fail(6, `Gruppe "${g.id}": labelKey muss shell.groups.${g.id} heißen`)
    if (typeof lookup(locales[lang], g.labelKey) !== 'string') fail(6, `${lang}.json: ${g.labelKey} fehlt`)
  }
  for (const [key, value] of flatten(locales[lang].shell, 'shell')) {
    if (typeof value !== 'string' || !value.trim()) { fail(6, `${lang}.json: ${key} ist kein Text`); continue }
    if (DASH.test(value)) fail(6, `${lang}.json: ${key} enthält einen Gedankenstrich`)
    if (EMOJI.test(value)) fail(6, `${lang}.json: ${key} enthält ein Emoji`)
    if (lang === 'de' && ASCII_UMLAUT.test(value)) fail(6, `de.json: ${key} nutzt eine Ersatzschreibung statt Umlaut ("${value}")`)
  }
}
if (locales.de.shell && locales.en.shell) {
  const deKeys = [...flatten(locales.de.shell, 'shell').keys()]
  const enKeys = [...flatten(locales.en.shell, 'shell').keys()]
  for (const k of deKeys) if (!enKeys.includes(k)) fail(6, `en.json: ${k} fehlt (in de.json vorhanden)`)
  for (const k of enKeys) if (!deKeys.includes(k)) fail(6, `de.json: ${k} fehlt (in en.json vorhanden)`)
  for (const k of Object.keys(locales.de.shell.nav ?? {})) {
    if (!NAV_ENTRIES.some(e => e.id === k)) warn(`shell.nav.${k} hat keinen Registry-Eintrag (ungenutzter Text)`)
  }
  for (const k of Object.keys(locales.de.shell.navShort ?? {})) {
    if (!NAV_ENTRIES.some(e => e.shortLabelKey === `shell.navShort.${k}`)) warn(`shell.navShort.${k} wird von keinem Registry-Eintrag genutzt (ungenutzter Text)`)
  }
}
mark(6, 'alle Texte in de.json und en.json vorhanden, ohne Gedankenstrich, Emoji, Ersatzschreibung')

// ── 7: Icons ────────────────────────────────────────────────────────────────
const iconIds = Object.keys(ICON_PATHS)
for (const e of NAV_ENTRIES) if (!iconIds.includes(e.icon)) fail(7, `"${e.id}": Icon "${e.icon}" gibt es in iconPaths.ts nicht`)
mark(7, `alle Icons vorhanden (${iconIds.length} in iconPaths.ts)`)

// ── 8: Telefon-Leiste und Menü je Rolle ─────────────────────────────────────
const profileOf = (role, perms = []) => ({
  id: 'verify', email: 'verify@example.invalid', full_name: 'Verify', phone: null, role, language: 'de',
  verwaltung_id: null, permissions: Object.fromEntries(perms.map(p => [p, true])),
})
// Die zwei echten Mitarbeiter-Rechtesätze plus {pipeline} und {}
const STAFF_SETS = [
  ['decks', 'funnel', 'werbung', 'contacts', 'thumbnails'],
  ['funnel', 'werbung', 'youtube', 'thumbnails'],
  ['pipeline'],
  [],
]
const CASES = [
  { name: 'admin', profile: profileOf('admin') },
  { name: 'verwalter', profile: profileOf('verwalter') },
  ...STAFF_SETS.map(set => ({ name: `mitarbeiter {${set.join(', ')}}`, profile: profileOf('mitarbeiter', set) })),
  { name: 'funnel', profile: profileOf('funnel') },
  { name: 'eigentuemer', profile: profileOf('eigentuemer') },
  { name: 'feriengast', profile: profileOf('feriengast') },
]
// Owner-Vorgabe für die Leiste (Ids in Reihenfolge); bei Mitarbeitern nur der feste Anfang
const EXPECTED_BAR = {
  'admin': ['pipeline', 'customers', 'inbox', 'tasks'],
  'verwalter': ['startVerwalter', 'portalProperties', 'occupancy', 'pipeline'],
  'funnel': ['funnel', 'funnelEditor'],
  'eigentuemer': ['startEigentuemer', 'myProperties', 'myCalendar', 'myDocuments'],
  'mitarbeiter {pipeline}': ['startStaff', 'tasks', 'pipeline', 'customers'],
  'mitarbeiter {}': ['startStaff', 'tasks'],
}
// Längste Beschriftung, die bei voller Leiste (4 Einträge plus "Mehr") in
// 10 px Montserrat noch ungekürzt in ein Feld von rund 67 px passt
const BAR_LABEL_MAX = 11
// Bildet ProtectedRoute nach: Rolle muss erlaubt sein, Rechte zählen nur für Mitarbeiter
const guardAllows = (profile, path) => guardAllowsRoute(routeByPath.get(path), profile, hasPerm)
for (const { name, profile } of CASES) {
  const bar = mobileBar(profile)
  if (bar.length > 4) fail(8, `Telefon-Leiste ${name}: ${bar.length} Einträge (höchstens 4 erlaubt)`)
  if (new Set(bar.map(e => e.path)).size !== bar.length) fail(8, `Telefon-Leiste ${name}: ein Pfad kommt doppelt vor`)
  for (const e of bar) {
    if (e.hidden) fail(8, `Telefon-Leiste ${name}: versteckter Eintrag "${e.id}"`)
    if (!guardAllows(profile, e.path)) fail(8, `Telefon-Leiste ${name}: "${e.id}" (${e.path}) würde der Guard abweisen`)
  }
  const expected = EXPECTED_BAR[name]
  const got = bar.map(e => e.id)
  if (expected && (got.length !== expected.length || got.some((id, i) => id !== expected[i]))) {
    fail(8, `Telefon-Leiste ${name}: erwartet [${expected.join(', ')}], ist [${got.join(', ')}]`)
  }
  if (profile.role === 'mitarbeiter' && (got[0] !== 'startStaff' || got[1] !== 'tasks')) {
    fail(8, `Telefon-Leiste ${name}: muss mit Start und Aufgaben beginnen, ist [${got.join(', ')}]`)
  }
  // Volle Leiste: jede Beschriftung muss in ihr Feld passen (sonst abgeschnitten)
  if (bar.length === 4) {
    for (const e of bar) {
      for (const lang of ['de', 'en']) {
        const text = lookup(locales[lang], e.shortLabelKey ?? e.labelKey)
        if (typeof text === 'string' && text.length > BAR_LABEL_MAX) {
          fail(8, `Telefon-Leiste ${name}: "${e.id}" zeigt in ${lang} "${text}" (${text.length} Zeichen, höchstens ${BAR_LABEL_MAX}); shortLabelKey ergänzen`)
        }
      }
    }
  }
  for (const { entries } of groupedNav(profile)) {
    for (const e of entries) {
      if (!guardAllows(profile, e.path)) fail(8, `Menü ${name}: "${e.id}" (${e.path}) würde der Guard abweisen`)
    }
  }
  // Umgekehrt: was der Guard durchlässt und einen Eintrag für die Rolle hat, muss sichtbar sein
  for (const e of NAV_ENTRIES) {
    if (e.roles.includes(profile.role) && guardAllows(profile, e.path) && !canSee(profile, e)) {
      fail(8, `Menü ${name}: "${e.id}" (${e.path}) lässt der Guard zu, canSee blendet ihn aber aus`)
    }
  }
}
// matchEntry: jeder Pfad findet seinen Eintrag, versteckte lösen auf den parent auf
for (const e of NAV_ENTRIES) {
  const sample = e.path.replace(/:[A-Za-z]+/g, 'abc-123')
  const profile = profileOf(e.roles[0], ['pipeline', 'funnel', 'contacts', 'invoices', 'thumbnails', 'youtube', 'werbung'])
  const hit = matchEntry(sample, profile)
  const want = e.hidden && e.parent ? e.parent : e.id
  if (!hit || hit.id !== want) fail(8, `matchEntry(${sample}) für ${e.roles[0]}: erwartet "${want}", ist "${hit?.id ?? 'null'}"`)
}
mark(8, `Telefon-Leiste und Menü für ${CASES.length} Profile: höchstens 4, nur Erreichbares, Reihenfolge wie vorgegeben, Beschriftungen passen`)

// ── 9: lazy nur aus lazyWithReload ──────────────────────────────────────────
for (const stmt of sf.statements) {
  if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
  const from = stmt.moduleSpecifier.text
  const fromLazyWithReload = /(^|\/)lib\/lazyWithReload$/.test(from)
  const bindings = stmt.importClause.namedBindings
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) {
      const local = el.name.text
      const imported = (el.propertyName ?? el.name).text
      if ((local === 'lazy' || imported === 'lazy') && !fromLazyWithReload) {
        fail(9, `App.tsx Zeile ${lineOf(stmt)}: lazy wird aus "${from}" importiert, erlaubt ist nur lib/lazyWithReload`)
      }
    }
  }
  if (stmt.importClause.name?.text === 'lazy' && !fromLazyWithReload) {
    fail(9, `App.tsx Zeile ${lineOf(stmt)}: lazy wird aus "${from}" importiert, erlaubt ist nur lib/lazyWithReload`)
  }
}
if (/\bReact\s*\.\s*lazy\b/.test(appText)) fail(9, 'App.tsx nutzt React.lazy direkt, erlaubt ist nur lazyWithReload')
if (!/import\s*\{[^}]*\blazyWithReload\b[^}]*\}\s*from\s*['"][^'"]*lib\/lazyWithReload['"]/.test(appText)) {
  fail(9, 'App.tsx importiert lazyWithReload nicht aus lib/lazyWithReload')
}
mark(9, 'App.tsx holt lazy nur aus lib/lazyWithReload')

// ── 10: basePath-Literale in src/pages ──────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
const srcFiles = walk(join(ROOT, 'src'))
// Erreichbarkeit ab main.tsx: toter Code (nirgends importierte Seiten) wird nur gewarnt
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
const reachable = new Set()
const queue = [join(ROOT, 'src/main.tsx')]
while (queue.length) {
  const file = queue.pop()
  if (reachable.has(file) || !existsSync(file)) continue
  reachable.add(file)
  for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
    const target = resolveImport(file, m[1])
    if (target && !reachable.has(target)) queue.push(target)
  }
}
const BASEPATH_RE = /basePath=(?:"([^"]*)"|\{\s*'([^']*)'\s*\}|\{\s*"([^"]*)"\s*\}|\{\s*`([^`$]*)`\s*\})/g
let basePathCount = 0
for (const file of srcFiles.filter(f => f.startsWith(join(ROOT, 'src/pages')))) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(BASEPATH_RE)) {
    const value = m[1] ?? m[2] ?? m[3] ?? m[4]
    const line = text.slice(0, m.index).split('\n').length
    const where = `${relative(ROOT, file)}:${line}`
    if (routeByPath.has(value)) { basePathCount++; continue }
    if (reachable.has(file)) fail(10, `${where}: basePath="${value}" ist keine Route in App.tsx`)
    else warn(`${where}: basePath="${value}" ist keine Route; die Datei wird nirgends importiert (toter Code)`)
  }
}
mark(10, `${basePathCount} basePath-Literale in src/pages zeigen auf echte Routen`)

// ── Warnungen ───────────────────────────────────────────────────────────────
for (const route of routes) {
  if (route.kind !== 'guarded') continue
  const entries = entriesByPath.get(route.path) ?? []
  const missing = route.guard.roles.filter(role => !entries.some(e => e.roles.includes(role)))
  if (missing.length && entries.length) warn(`${route.path}: Guard erlaubt ${missing.join('/')}, dafür gibt es keinen Menü-Eintrag`)
}
const tbd = NAV_ENTRIES.filter(e => e.module === 'tbd').map(e => e.id)
if (tbd.length) warn(`Modul noch offen (tbd): ${tbd.join(', ')}`)

// ── Ausgabe ─────────────────────────────────────────────────────────────────
const label = key => lookup(locales.de, key) ?? key
console.log('Menü je Rolle (deutsche Texte)')
for (const { name, profile } of CASES) {
  console.log(`\n  ${name}`)
  for (const { group, entries } of groupedNav(profile)) {
    console.log(`    ${label(group.labelKey)}: ${entries.map(e => label(e.labelKey)).join(', ')}`)
  }
  const bar = mobileBar(profile)
  console.log(`    Telefon-Leiste: ${bar.length ? bar.map(e => label(e.labelKey)).join(', ') : '(keine)'}`)
}
console.log('')
for (const line of passed) console.log('  OK ' + line)
if (warnings.length) {
  console.log(`\n${warnings.length} Warnung(en)`)
  for (const w of warnings) console.log('  WARNUNG ' + w)
}
if (errors.length) {
  console.error(`\nverify-nav: ${errors.length} Fehler`)
  for (const e of errors.sort((a, b) => a.check - b.check)) console.error(`  FEHLER [${e.check}] ${e.msg}`)
  process.exit(1)
}
console.log(`\nverify-nav: OK (${routes.length} Routen, ${NAV_ENTRIES.length} Registry-Einträge, 10 Prüfungen)`)
