// Erzeugt die Migration "RLS-Helfer einmal pro Abfrage" (Audit P4-1, Advisor auth_rls_initplan)
// aus einem live gelesenen pg_policies-Stand. Es wird NICHTS in die Datenbank geschrieben.
//
// Was die Migration macht: in USING / WITH CHECK jeder Policy wird jeder Aufruf von
//   auth.uid(), current_user_role(), current_user_has_perm('<feste Zeichenkette>'::text)
// in ( SELECT <aufruf> AS <name>) eingepackt. Postgres wertet ihn dann einmal pro Abfrage aus
// (InitPlan) statt einmal pro Zeile. Der Rest jedes Ausdrucks bleibt Zeichen für Zeichen gleich.
// Nicht eingepackt werden: schon eingepackte Aufrufe und Aufrufe mit Spaltenbezug
// (z. B. current_user_has_perm(('werbung_'::text || platform)) hängt von der Zeile ab).
// Keine Policy wird gelöscht oder neu angelegt, Rollen und Befehl bleiben (nur ALTER POLICY).
//
// Eingabe: JSON-Array mit Zeilen aus
//   select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies
//   where schemaname in ('public','acquisition') and (qual ~ '...' or with_check ~ '...')
//
// Aufruf:
//   node scripts/gen-rls-initplan.mjs <policies.json>            schreibt Migration + Rückweg
//   node scripts/gen-rls-initplan.mjs <policies.json> --check    prüft nur, ob die Dateien aktuell sind
//   node scripts/gen-rls-initplan.mjs <policies.json> --only=activities,leads --out=a.sql --down=a.down.sql
//        (Teilmenge für ein schrittweises Ausrollen; --out und --down sind dann Pflicht)
// Optional: --date=2026-10-02 (Stand-Datum im Kopf, sonst aus dem Dateinamen JJJJMMTT oder mtime)
//           --parse-check=probe.sql schreibt zusätzlich eine rein lesende EXPLAIN-Abfrage, die jeden neuen
//           Ausdruck im Kontext seiner Tabelle gegen das Live-Schema parst (Namen, Typen), ohne ihn
//           auszuführen. Läuft mit dem Nur-Lese-Zugang; Fehler dort = Migration würde scheitern.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION = 'supabase/migrations/20261002100000_rls_initplan.sql'
const ROLLBACK = 'supabase/migrations/rollback/20261002100000_rls_initplan.down.sql'
const FORBIDDEN_TAGS = ['$MIG$', '$MATRIX$'] // reserviert vom Trockenlauf-Werkzeug (Sichtbarkeitsmatrix)
const GUARD_TAG = '$guard$'
const VERIFY_TAG = '$verify$'

// ── Argumente ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = name => {
  const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`))
  if (!a) return undefined
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true
}
const input = args.find(a => !a.startsWith('--'))
if (!input) {
  console.error('Aufruf: node scripts/gen-rls-initplan.mjs <policies.json> [--check] [--only=t1,t2 --out=x.sql --down=y.sql] [--date=JJJJ-MM-TT]')
  process.exit(2)
}
const only = typeof flag('only') === 'string' ? flag('only').split(',').map(s => s.trim()).filter(Boolean) : null
const outPath = resolve(ROOT, typeof flag('out') === 'string' ? flag('out') : MIGRATION)
const downPath = resolve(ROOT, typeof flag('down') === 'string' ? flag('down') : ROLLBACK)
if (only && (typeof flag('out') !== 'string' || typeof flag('down') !== 'string')) {
  console.error('--only braucht --out und --down (die volle Migration wird nicht überschrieben).')
  process.exit(2)
}
const checkOnly = flag('check') === true

// ── Eingabe lesen ────────────────────────────────────────────────────────────
const rows = JSON.parse(readFileSync(input, 'utf8'))
if (!Array.isArray(rows)) throw new Error('Eingabe ist kein JSON-Array')
for (const r of rows) {
  for (const k of ['schemaname', 'tablename', 'policyname', 'cmd']) {
    if (typeof r[k] !== 'string' || !r[k]) throw new Error(`Zeile ohne ${k}: ${JSON.stringify(r).slice(0, 200)}`)
  }
  for (const k of ['qual', 'with_check']) {
    if (r[k] !== null && r[k] !== undefined && typeof r[k] !== 'string') throw new Error(`${k} ist kein Text bei ${r.policyname}`)
  }
}
const seen = new Set()
for (const r of rows) {
  const key = `${r.schemaname}.${r.tablename}.${r.policyname}`
  if (seen.has(key)) throw new Error(`Policy doppelt in der Eingabe: ${key}`)
  seen.add(key)
}

const snapshotDate = (() => {
  const given = flag('date')
  const m = typeof given === 'string' ? given.match(/^(\d{4})-(\d{2})-(\d{2})$/) : basename(input).match(/(20\d{2})(\d{2})(\d{2})/)
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : statSync(input).mtime
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`
})()

// ── Ausdruck umschreiben ─────────────────────────────────────────────────────
// Ein kleiner Scanner statt globalem Ersetzen: Zeichenketten ('...', E'...') und
// Bezeichner in "..." werden übersprungen, damit nichts in Literalen angefasst wird.
const CALLS = [
  { kind: 'auth.uid()', re: /auth\.uid\(\)/y, alias: 'uid' },
  { kind: 'current_user_role()', re: /(?:public\.)?current_user_role\(\)/y, alias: 'current_user_role' },
  { kind: "current_user_has_perm('…')", re: /(?:public\.)?current_user_has_perm\('(?:[^']|'')*'::text\)/y, alias: 'current_user_has_perm' },
]
const PERM_ANY = /(?:public\.)?current_user_has_perm\(/y
const IDENT_CHAR = /[A-Za-z0-9_$.]/
const WRAP_OPEN = '( SELECT '
const WRAPPED_TAIL = /^ AS [a-z_][a-z0-9_]*\)/

function rewrite(text) {
  const res = { text, wrapped: [], kept: [] }
  if (text == null) return res
  let out = ''
  let i = 0
  const parens = [] // je offene Klammer: true, wenn sie eine Unterabfrage ( SELECT ...) öffnet
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") { // Zeichenkette überspringen ('' ist ein escaptes Hochkomma, bei E'' auch \')
      const isE = i > 0 && /[Ee]/.test(text[i - 1]) && !(i > 1 && IDENT_CHAR.test(text[i - 2]))
      let j = i + 1
      for (;;) {
        if (j >= text.length) throw new Error(`Zeichenkette nicht geschlossen in: ${text}`)
        if (isE && text[j] === '\\') { j += 2; continue }
        if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      out += text.slice(i, j + 1); i = j + 1; continue
    }
    if (ch === '"') {
      let j = i + 1
      for (;;) {
        if (j >= text.length) throw new Error(`Bezeichner nicht geschlossen in: ${text}`)
        if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue } break }
        j++
      }
      out += text.slice(i, j + 1); i = j + 1; continue
    }
    if (ch === '(') { parens.push(text.startsWith(' SELECT', i + 1)); out += ch; i++; continue }
    if (ch === ')') { parens.pop(); out += ch; i++; continue }
    if (/[a-z]/.test(ch) && !(i > 0 && IDENT_CHAR.test(text[i - 1]))) {
      let hit = null
      for (const c of CALLS) {
        c.re.lastIndex = i
        const m = c.re.exec(text)
        if (m) { hit = { ...c, call: m[0] }; break }
      }
      if (hit) {
        const before = text.slice(Math.max(0, i - WRAP_OPEN.length), i)
        const after = text.slice(i + hit.call.length)
        const inSubselect = parens.includes(true)
        if (before === WRAP_OPEN && WRAPPED_TAIL.test(after)) {
          res.kept.push({ call: hit.call, reason: 'schon eingepackt' })
        } else if (before === WRAP_OPEN) {
          res.kept.push({ call: hit.call, reason: 'ist Ausgabespalte einer Unterabfrage mit FROM, bleibt wie es ist' })
        } else {
          out += `${WRAP_OPEN}${hit.call} AS ${hit.alias})`
          res.wrapped.push({ kind: hit.kind, call: hit.call, inSubselect })
          i += hit.call.length
          continue
        }
        out += hit.call; i += hit.call.length; continue
      }
      PERM_ANY.lastIndex = i
      const p = PERM_ANY.exec(text)
      if (p) {
        // Argument ist keine feste Zeichenkette: hängt von der Zeile ab, bleibt pro Zeile
        let depth = 0, j = i + p[0].length - 1
        for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break }
        res.kept.push({ call: text.slice(i, j + 1), reason: 'Argument mit Spaltenbezug (zeilenabhängig)' })
        out += text.slice(i, j + 1); i = j + 1; continue
      }
    }
    out += ch; i++
  }
  if (parens.length) throw new Error(`Klammern nicht ausgeglichen in: ${text}`)
  res.text = out
  return res
}

// Gegenprobe: jede eingepackte Form wieder auspacken. Original und Ergebnis müssen dann gleich sein,
// d. h. außer den Einschüben hat sich kein Zeichen geändert.
const UNWRAP = /\( SELECT ((?:auth\.uid\(\)|(?:public\.)?current_user_role\(\)|(?:public\.)?current_user_has_perm\('(?:[^']|'')*'::text\))) AS [a-z_][a-z0-9_]*\)/g
const unwrapAll = s => (s == null ? s : s.replace(UNWRAP, '$1'))

// ── SQL-Hilfen ───────────────────────────────────────────────────────────────
const RESERVED = new Set(('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create '
  + 'current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end '
  + 'except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp '
  + 'not null offset on only or order placing primary references returning select session_user some symmetric system_user table then '
  + 'to trailing true union unique user using variadic when where window with authorization binary collation concurrently cross '
  + 'current_schema freeze full ilike inner is isnull join left like natural notnull outer overlaps right similar tablesample verbose').split(' '))
const ident = s => (/^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : `"${s.replace(/"/g, '""')}"`)
const lit = s => `'${s.replace(/'/g, "''")}'`
const md5 = (q, w) => createHash('md5').update(`${q ?? '<null>'}\n${w ?? '<null>'}`, 'utf8').digest('hex')

function alterStmt(p, q, w) {
  let s = `ALTER POLICY ${ident(p.policyname)} ON ${ident(p.schemaname)}.${ident(p.tablename)}`
  if (q != null) s += `\n  USING (${q})`
  if (w != null) s += `\n  WITH CHECK (${w})`
  return s + ';'
}

// Prüfblock: alle Policies müssen live exakt den erwarteten Text haben, sonst Abbruch (nichts geändert).
function checkBlock(tag, list, hashOf, message, hint) {
  const values = list.map(p => `    (${lit(p.schemaname)}, ${lit(p.tablename)}, ${lit(p.policyname)}, ${lit(hashOf(p))})`).join(',\n')
  return `do ${tag}
declare
  v_abweichend text;
begin
  select string_agg(format('%s.%s/%s', e.s, e.t, e.p), ', ' order by e.s, e.t, e.p)
    into v_abweichend
  from (values
${values}
  ) as e(s, t, p, h)
  left join pg_catalog.pg_policies x
    on x.schemaname = e.s and x.tablename = e.t and x.policyname = e.p
  where x.policyname is null
     or md5(coalesce(x.qual, '<null>') || chr(10) || coalesce(x.with_check, '<null>')) <> e.h;
  if v_abweichend is not null then
    raise exception '${message.replace(/'/g, "''")}: %', v_abweichend
      using hint = '${hint.replace(/'/g, "''")}';
  end if;
end ${tag};`
}

// ── Erzeugen ─────────────────────────────────────────────────────────────────
const sortKey = p => `${p.schemaname}\u0000${p.tablename}\u0000${p.policyname}`
const sorted = [...rows].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
const selected = only
  ? sorted.filter(p => only.includes(p.tablename) || only.includes(`${p.schemaname}.${p.tablename}`))
  : sorted
if (only) {
  for (const t of only) if (!sorted.some(p => p.tablename === t || `${p.schemaname}.${p.tablename}` === t)) throw new Error(`--only: Tabelle ${t} nicht in der Eingabe`)
}

const changed = []
const keptReport = []
const stats = { calls: {}, topLevel: 0, inSubselect: 0 }
for (const p of selected) {
  const q = rewrite(p.qual)
  const w = rewrite(p.with_check)
  for (const k of [...q.kept, ...w.kept]) keptReport.push({ policy: `${p.schemaname}.${p.tablename}/${p.policyname}`, ...k })
  if (q.text === p.qual && w.text === p.with_check) continue
  // Gegenproben
  if (unwrapAll(q.text) !== unwrapAll(p.qual) || unwrapAll(w.text) !== unwrapAll(p.with_check)) throw new Error(`Gegenprobe (Auspacken) fehlgeschlagen: ${p.policyname}`)
  if (rewrite(q.text).text !== q.text || rewrite(w.text).text !== w.text) throw new Error(`Nicht idempotent: ${p.policyname}`)
  for (const c of [...q.wrapped, ...w.wrapped]) {
    stats.calls[c.kind] = (stats.calls[c.kind] ?? 0) + 1
    if (c.inSubselect) stats.inSubselect++; else stats.topLevel++
  }
  changed.push({ ...p, newQual: q.text, newCheck: w.text, perRow: [...q.wrapped, ...w.wrapped].some(c => !c.inSubselect) })
}
if (!changed.length) { console.log('Keine Policy zu ändern.'); process.exit(0) }

const tables = [...new Set(changed.map(p => `${p.schemaname}.${p.tablename}`))]
const perRowPolicies = changed.filter(p => p.perRow).length
const allText = changed.map(p => [p.qual, p.with_check, p.newQual, p.newCheck].join('\n')).join('\n')
for (const t of [...FORBIDDEN_TAGS, GUARD_TAG, VERIFY_TAG]) {
  if (allText.includes(t)) throw new Error(`Policy-Text enthält die Marke ${t}`)
}

const migName = basename(outPath)
const downRel = relative(ROOT, downPath)
const scope = only ? `Teilmenge (--only=${only.join(',')})` : 'alle betroffenen Policies in public und acquisition'
const header = (title, lines) => [
  '-- -----------------------------------------------------------------------------',
  `-- ${title}`,
  ...lines.map(l => (l ? `-- ${l}` : '--')),
  '-- -----------------------------------------------------------------------------',
  '',
].join('\n')

const commonSetup = [
  "set local lock_timeout = '3s';",
  '-- gleicher Suchpfad wie beim Lesen von pg_policies: Namen werden genauso aufgelöst und',
  '-- der Prüfblock vergleicht denselben Text, den pg_policies beim Lesen geliefert hat',
  'set local search_path = public;',
  '',
].join('\n')

const up = header(`RLS-Helfer einmal pro Abfrage statt pro Zeile (Audit P4-1, Advisor auth_rls_initplan)`, [
  `Erzeugt von scripts/gen-rls-initplan.mjs aus pg_policies, live gelesen am ${snapshotDate}. Nicht von Hand ändern,`,
  'sondern den Generator mit einem frischen Stand neu laufen lassen.',
  `Umfang: ${scope}: ${changed.length} Policies auf ${tables.length} Tabellen,`,
  `davon ${perRowPolicies} mit mindestens einem Aufruf außerhalb jeder Unterabfrage (dort wirkt es am stärksten).`,
  '',
  'Was passiert: in USING und WITH CHECK wird jeder Aufruf von auth.uid(), current_user_role() und',
  "current_user_has_perm('<feste Zeichenkette>') in ( SELECT ... AS ...) eingepackt. Postgres rechnet ihn",
  'dann einmal pro Abfrage aus (InitPlan) statt für jede gelesene Zeile neu. Sonst bleibt jeder Ausdruck',
  'Zeichen für Zeichen der Live-Stand.',
  '',
  'Ändert kein Zugriffsergebnis: die drei Funktionen hängen nur vom eingeloggten Nutzer ab und liefern',
  'innerhalb einer Abfrage für jede Zeile denselben Wert. Nur ALTER POLICY: keine Policy wird gelöscht',
  'oder neu angelegt (auch die doppelten Policies aus P4-6 bleiben), Rollen, Befehl und permissive/',
  'restrictive bleiben unverändert. Nicht eingepackt: schon eingepackte Aufrufe und Aufrufe mit',
  "Spaltenbezug wie current_user_has_perm(('werbung_'::text || platform)) (zeilenabhängig).",
  '',
  'Schutz: der erste Block bricht ab, ohne etwas zu ändern, wenn eine dieser Policies live nicht mehr',
  `exakt dem Stand vom ${snapshotDate} entspricht (dann Generator mit frischem pg_policies-Stand neu laufen`,
  'lassen). Der letzte Block bricht ab, wenn das Ergebnis nicht exakt dem erwarteten Text entspricht.',
  '',
  'VOR DEM EINSPIELEN PFLICHT: Sichtbarkeitsmatrix als Trockenlauf (rls-matrix.mjs: Schnappschuss',
  'vorher, Schnappschuss mit --with <diese Datei>, dann diff) muss 0 Unterschiede zeigen.',
  'Einspielen als Ganzes in EINER Transaktion zu einer ruhigen Zeit (SQL-Editor oder',
  'psql --single-transaction -f): ALTER POLICY sperrt jede Tabelle kurz exklusiv, lock_timeout 3 s.',
  '',
  `Rückweg: ${downRel} stellt die Originaltexte exakt wieder her.`,
]) + commonSetup + '\n'
  + checkBlock(GUARD_TAG, changed, p => md5(p.qual, p.with_check),
    'RLS-Initplan abgebrochen, nichts geändert. Diese Policies weichen vom gelesenen Stand ab oder fehlen',
    'Generator scripts/gen-rls-initplan.mjs mit frischem pg_policies-Stand neu laufen lassen.') + '\n\n'
  + changed.map(p => alterStmt(p, p.newQual, p.newCheck)).join('\n\n') + '\n\n'
  + checkBlock(VERIFY_TAG, changed, p => md5(p.newQual, p.newCheck),
    'RLS-Initplan: Ergebnis entspricht nicht dem erwarteten Text, alles wird zurückgerollt',
    'Generator prüfen, Ausdruck nach ALTER POLICY anders formatiert als erwartet.') + '\n'

const down = header(`Rückweg zu ${migName} (Audit P4-1)`, [
  `Erzeugt von scripts/gen-rls-initplan.mjs aus demselben pg_policies-Stand (${snapshotDate}).`,
  `Stellt für ${changed.length} Policies auf ${tables.length} Tabellen den Original-Text von USING und WITH CHECK`,
  'exakt wieder her (nur ALTER POLICY, nichts gelöscht oder neu angelegt). Liegt bewusst in rollback/,',
  'damit die Supabase-CLI die Datei nicht als Migration einspielt. Von Hand ausführen, als Ganzes in',
  'EINER Transaktion (SQL-Editor oder psql --single-transaction -f).',
  '',
  'Schutz: bricht ab, ohne etwas zu ändern, wenn eine dieser Policies live nicht mehr exakt dem Stand',
  'nach der Migration entspricht (jemand hat sie inzwischen geändert). Dann diese Policy von Hand prüfen,',
  'statt ihre neue Fassung blind zu überschreiben.',
]) + commonSetup + '\n'
  + checkBlock(GUARD_TAG, changed, p => md5(p.newQual, p.newCheck),
    'Rückweg RLS-Initplan abgebrochen, nichts geändert. Diese Policies weichen vom Stand nach der Migration ab oder fehlen',
    'Betroffene Policies von Hand prüfen, die Migration wurde danach geändert.') + '\n\n'
  + changed.map(p => alterStmt(p, p.qual, p.with_check)).join('\n\n') + '\n\n'
  + checkBlock(VERIFY_TAG, changed, p => md5(p.qual, p.with_check),
    'Rückweg RLS-Initplan: Ergebnis entspricht nicht dem Original-Text, alles wird zurückgerollt',
    'Original-Text aus dem pg_policies-Stand von Hand vergleichen.') + '\n'

for (const [name, sql] of [['Migration', up], ['Rückweg', down]]) {
  for (const t of FORBIDDEN_TAGS) if (sql.includes(t)) throw new Error(`${name} enthält ${t}`)
  if (/\b(drop|create)\s+policy\b/i.test(sql)) throw new Error(`${name} enthält DROP/CREATE POLICY`)
  if (/[–—]/.test(sql)) throw new Error(`${name} enthält einen langen Gedankenstrich`)
}

// ── Ausgabe ──────────────────────────────────────────────────────────────────
const parseCheck = typeof flag('parse-check') === 'string' ? resolve(ROOT, flag('parse-check')) : null
if (parseCheck) {
  // CASE WHEN false: der Planer entfernt die Unterabfragen vor der Planung, sie werden also nur
  // geparst und geprüft (wie ALTER POLICY es tut), nie geplant oder ausgeführt.
  const cols = []
  for (const p of changed) {
    for (const e of [p.newQual, p.newCheck]) {
      if (e != null) cols.push(`case when false then (select 1 from ${ident(p.schemaname)}.${ident(p.tablename)} where (${e}) limit 1) end`)
    }
  }
  writeFileSync(parseCheck, `explain (costs off) select\n  ${cols.join(',\n  ')}\n`)
  console.log(`Parse-Probe mit ${cols.length} Ausdrücken: ${parseCheck}`)
}
if (checkOnly) {
  const same = (p, s) => existsSync(p) && readFileSync(p, 'utf8') === s
  const ok = same(outPath, up) && same(downPath, down)
  console.log(ok ? 'OK: Migration und Rückweg sind aktuell.' : 'VERALTET: Migration oder Rückweg weichen vom Generator ab.')
  process.exit(ok ? 0 : 1)
}
writeFileSync(outPath, up)
writeFileSync(downPath, down)

console.log(`Eingabe: ${rows.length} Policies, ausgewählt: ${selected.length}`)
console.log(`Geändert: ${changed.length} Policies auf ${tables.length} Tabellen (${perRowPolicies} mit Aufruf außerhalb jeder Unterabfrage)`)
console.log(`Eingepackte Aufrufe: ${JSON.stringify(stats.calls)} (außerhalb Unterabfrage ${stats.topLevel}, in Unterabfrage ${stats.inSubselect})`)
const unchangedPolicies = selected.filter(p => !changed.some(c => c.schemaname === p.schemaname && c.tablename === p.tablename && c.policyname === p.policyname))
console.log(`Unverändert gelassen: ${unchangedPolicies.length} Policies`)
const byReason = {}
for (const k of keptReport) (byReason[k.reason] ??= []).push(`${k.policy}: ${k.call}`)
for (const [reason, list] of Object.entries(byReason)) {
  console.log(`\nNicht eingepackt (${reason}): ${list.length}`)
  for (const l of [...new Set(list)]) console.log(`  ${l}`)
}
console.log(`\nGeschrieben: ${outPath.replace(ROOT + '/', '')}\n             ${downPath.replace(ROOT + '/', '')}`)
