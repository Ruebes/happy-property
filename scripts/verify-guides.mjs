// Erklaertexte unter den Tabellen der Kundenseite (Sven 8.10.26) pruefen.
// Rechnet zufaellige Portfolios (Bautraeger-Plaene, Barkauf, Verkauf, Reinvestment,
// Firma, Wohnsitz Zypern ...) in Deutsch und Englisch und prueft:
//   - jede Rechnung und Zahl in den Texten gegen die angezeigten Werte (checkGuides je Gruppe)
//   - keine fehlenden Uebersetzungen, keine {{Platzhalter}}, kein undefined/NaN
//   - keine Gedankenstriche, keine Projekt- oder Bautraegernamen
// Ausfuehren: node scripts/verify-guides.mjs   (optional N=400 SEED=7)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(REPO + '/package.json')
const esbuild = require('esbuild'), i18next = require('i18next')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'))
const load = async (entry, name) => {
  await esbuild.build({ entryPoints: [`${REPO}/${entry}`], bundle: true, format: 'esm', outfile: `${OUT}/${name}.mjs`, logLevel: 'error', platform: 'node' })
  return import(`${OUT}/${name}.mjs`)
}
const st = await load('src/lib/strategy.ts', 'strategy')
const an = await load('src/lib/analytics.ts', 'analytics')
const GROUPS = ['overview', 'cashflow', 'credit', 'exit', 'scenarios']
const mods = {}
for (const g of [...GROUPS, 'index']) mods[g] = await load(`src/lib/guides/${g}.ts`, `g_${g}`)
const ts = {}
for (const lang of ['de', 'en']) {
  const i = i18next.createInstance()
  const loc = JSON.parse(fs.readFileSync(`${REPO}/src/locales/${lang}.json`))
  loc.strategie.guide = JSON.parse(fs.readFileSync(`${REPO}/src/locales/guides/${lang}.json`)).strategie.guide
  await i.init({ lng: lang, resources: { [lang]: { translation: loc } }, interpolation: { escapeValue: false } })
  ts[lang] = i.t.bind(i)
}
let seed = Number(process.env.SEED || 5); const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const pick = a => a[Math.floor(rnd() * a.length)]
const BAD = [/–/, /—/, /\{\{/, /\bundefined\b/, /\bNaN\b/, /strategie\.guide\./, /\[object Object\]/, /Mito|Kuutio|Luma|Mamba|BAIA|Emerald|Genesis|Skala/, /Infinity/]
const N = Number(process.env.N || 150)
let problems = 0, cases = 0
for (let i = 0; i < N; i++) {
  const units = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => {
    const buyY = 2026 + Math.floor(rnd() * 2), buyM = 1 + Math.floor(rnd() * 12), rym = buyY * 12 + buyM - 1 + Math.floor(rnd() * 36)
    const dev = pick(['mito', 'kuutio', 'luma', 'sofort', 'mito'])
    return { key: 'u' + k, name: 'Wohnung ' + k, priceNet: 150000 + Math.round(rnd() * 650000), furnNet: pick([0, 25000]), rent: 800 + Math.round(rnd() * 5000),
      letType: pick(['short', 'short', 'long']), fin: rnd() > 0.25, buyM, buyY, readyM: rym % 12 + 1, readyY: Math.floor(rym / 12),
      plan: dev === 'luma' || dev === 'sofort' ? dev : 'dev', schedule: dev === 'mito' ? st.scheduleFromProject(null, 'Mito') : dev === 'kuutio' ? st.scheduleFromProject([], 'Kuutio Homes') : null,
      vatReturn: rnd() > 0.8, calc: pick([{}, { mgmtPct: 25, season: { totalOcc: 65, adrHigh: 250 } }, { mgmtPct: 20, hotelConcept: true, season: { totalOcc: 70, adrHigh: 300 } }]) }
  })
  const p = { ...st.DEFAULT_SIM_PARAMS, ek: 60000 + Math.round(rnd() * 1200000), interest: 2.5 + rnd() * 3, exitAfterYears: pick([0, 1, 2, 3, 5, 7, 10]),
    growth: pick([0, 2, 3, 5]), rentGrowth: pick([0, 2, 3]), bundle: rnd() > 0.3, buyerStructure: pick(['single', 'couple']), holder: pick(['privat', 'privat', 'privat', 'firma']),
    res: pick(['de', 'de', 'cy']), reinvestEnabled: rnd() > 0.8 }
  const a = an.buildCustomerAnalytics(units, p)
  if (!a) continue
  cases++
  for (const lang of ['de', 'en']) {
    const ctx = { a, params: p, t: ts[lang] }
    const fail = m => { problems++; if (problems <= 30) console.log(`FAIL  Fall ${i} (${lang}) ${m}`) }
    for (const g of GROUPS) {
      const build = Object.entries(mods[g]).find(([k, v]) => typeof v === 'function' && k.startsWith('build'))[1]
      let res
      try { res = build(ctx) } catch (e) { fail(`${g}: ${e.message}`); continue }
      for (const m of (mods[g].checkGuides?.(ctx, res) ?? [])) fail(`${g}: ${m}`)
      for (const [id, gd] of Object.entries(res)) {
        if (!gd) continue
        const txt = [gd.heading, gd.intro, ...gd.items.flatMap(x => [x.label, x.text]), gd.example ?? '', ...gd.meaning, ...gd.pitfalls].join('\n')
        for (const re of BAD) if (re.test(txt)) fail(`${id}: verboten ${re}`)
        if (!gd.heading || !gd.intro) fail(`${id}: leer`)
      }
    }
    try { mods.index.buildGuides(ctx) } catch (e) { fail(`index: ${e.message}`) }
  }
}
fs.rmSync(OUT, { recursive: true, force: true })
console.log(`\n${problems ? '❌' : '🎉'}  ${cases} Portfolios x 2 Sprachen, ${problems} Probleme`)
process.exit(problems ? 1 : 0)
