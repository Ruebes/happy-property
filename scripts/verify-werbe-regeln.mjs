// Fixture-Tests der reinen Regel-Engine supabase/functions/_shared/werbeRegeln.ts
// (PLAN-B §8): Lernschutz, Änderungsfenster, Plan-B-Symmetrie, +20 % / 3 Tage,
// Summe <= Tageslimit, Monatsprognose, Hysterese S1/D1, Coverage-Gate, nie letzte
// aktive Anzeige, R4 (Gewinner), Aktionen pro Tag, 72-h-Sperre nach Handänderung,
// Cent-Grenzen, Kurs-Prüfung, dazu K0-K4, F1-F3, R1/R1b/R2, POOL_UPLOAD, D1-D3,
// Stopps, Freigabestufen und Idempotenz-Schlüssel.
//
// Ausführen:
//   node scripts/verify-werbe-regeln.mjs

import { execSync } from 'child_process'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'hpregeln-'))
const out = join(dir, 'werbeRegeln.mjs')
execSync(`npx --yes esbuild ${JSON.stringify(join(root, 'supabase/functions/_shared/werbeRegeln.ts'))} --bundle --format=esm --platform=neutral --outfile=${JSON.stringify(out)} --log-level=warning`, { stdio: 'pipe', cwd: root })
const R = await import(out)

const fails = []
let checked = 0
let aktuellerTest = ''
const check = (ok, msg) => { checked++; if (!ok) fails.push(`[${aktuellerTest}] ${msg}`) }
const test = (name, fn) => {
  aktuellerTest = name
  try { fn() } catch (e) { fails.push(`[${name}] Ausnahme: ${e && e.stack ? e.stack : e}`) }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const MO = '2026-10-05T04:30:00Z' // Montag, 06:30 Berlin (Änderungsfenster)
const DI = '2026-10-06T04:30:00Z' // Dienstag
const H = 3600000
const iso = ms => new Date(ms).toISOString()
const vor = (stunden, basis = MO) => iso(Date.parse(basis) - stunden * H)
const sek = isoText => Math.floor(Date.parse(isoText) / 1000)

const RULES = () => [
  { rule_key: 'K0', aktion: 'meldung', enabled: true, approval_level: 1, max_level: 1, params: {} },
  ...['K1', 'K2', 'K3', 'K4'].map(k => ({ rule_key: k, aktion: 'pause', enabled: true, approval_level: 1, max_level: 3, params: {}, version: 2 })),
  ...['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map(k => ({ rule_key: k, aktion: 'ersatz_aktivieren', enabled: true, approval_level: 1, max_level: 3, params: {} })),
  { rule_key: 'R1b', aktion: 'pause', enabled: true, approval_level: 1, max_level: 3, params: {} },
  { rule_key: 'R2', aktion: 'ersatz_aktivieren', enabled: true, approval_level: 1, max_level: 3, params: {} },
  { rule_key: 'POOL_UPLOAD', aktion: 'ersatz_hochladen', enabled: true, approval_level: 1, max_level: 2, params: {} },
  { rule_key: 'S1', aktion: 'budget_set', enabled: true, approval_level: 1, max_level: 3, params: { budget_gruppen: [['AS_A', 'AS_B']] } },
  { rule_key: 'D1', aktion: 'budget_set', enabled: true, approval_level: 1, max_level: 3, params: { budget_gruppen: [['AS_A', 'AS_B']] } },
  { rule_key: 'D2', aktion: 'pause', enabled: true, approval_level: 1, max_level: 1, params: {} },
  { rule_key: 'D3', aktion: 'meldung', enabled: true, approval_level: 1, max_level: 1, params: {} },
]

function snapTage(zeile) {
  // heute + 3 Tage zurück, identischer Zustand
  return ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map(d => ({ ...zeile, snap_date: d, synced_at: `${d}T04:25:00Z` }))
}

function basis(opt = {}) {
  const ADS = []
  for (const [as, suf, pre] of [['AS_A', 'lang', 'A'], ['AS_B', 'kurz', 'B']]) {
    for (let i = 1; i <= 4; i++) {
      ADS.push({
        entity_level: 'ad', entity_id: `${pre}${i}`, parent_id: as, campaign_id: 'C1', name: `a${i}_${suf}`,
        status: 'ACTIVE', effective_status: 'ACTIVE', frequency_7d: 1.8,
        created_time: '2026-08-02T10:00:00Z', updated_time: '2026-08-02T10:00:00Z',
      })
    }
  }
  const neuAd = (id, as) => ({
    entity_level: 'ad', entity_id: id, parent_id: as, campaign_id: 'C1', name: `${id}`,
    status: 'PAUSED', effective_status: 'PAUSED', created_time: '2026-10-01T10:00:00Z', updated_time: '2026-10-01T10:00:00Z',
  })
  const snaps = [
    { entity_level: 'campaign', entity_id: 'C1', name: 'Plan B', status: 'ACTIVE', effective_status: 'ACTIVE', special_ad_categories: ['HOUSING'], created_time: '2026-08-01T10:00:00Z', updated_time: '2026-08-01T10:00:00Z' },
    ...['AS_A', 'AS_B'].map(id => ({
      entity_level: 'adset', entity_id: id, parent_id: 'C1', campaign_id: 'C1', name: id, status: 'ACTIVE', effective_status: 'ACTIVE',
      daily_budget_cents: 6000, frequency_7d: 1.8, learning_stage_info: { status: 'SUCCESS', last_sig_edit_ts: sek('2026-09-20T05:00:00Z') },
      created_time: '2026-08-01T10:00:00Z', updated_time: '2026-09-20T05:00:00Z',
    })),
    ...ADS,
    neuAd('N1A', 'AS_A'), neuAd('N1B', 'AS_B'), neuAd('N3A', 'AS_A'), neuAd('N4A', 'AS_A'),
  ]
  const kennung = (i, x = {}) => ({ stichtag: '2026-10-04', fenster: 0, entity_level: 'kennung', entity_id: `C1:a${i}`, campaign_id: 'C1', spend_eur: 80, te_capped: 0.4, leads: 3, leads_kap_ja: 1, booked: 0, booked_kap_ja: 0, ...x })
  const ctx = {
    now: MO,
    settings: {
      autopilot_mode: 'vorschlag', autopilot_paused_until: null, target_cpte_eur: 145, max_account_daily_budget: 250,
      monthly_cap_eur: 7500, max_auto_actions_per_day: 5, kap_floor: 0.4, change_window_dows: [1, 4], budget_autonomie_freigegeben_at: null,
    },
    rules: RULES(),
    qualitaet: [
      { stichtag: '2026-10-04', fenster: 14, entity_level: 'account', entity_id: 'konto', spend_eur: 1400, attribution_coverage: 0.9 },
      { stichtag: '2026-10-04', fenster: 30, entity_level: 'campaign', entity_id: 'C1', spend_eur: 3000, te_capped: 20, cpte_hat: 150 },
      ...[1, 2, 3, 4].map(i => kennung(i)),
      ...['AS_A', 'AS_B'].map(id => ({ stichtag: '2026-10-04', fenster: 14, entity_level: 'adset', entity_id: id, parent_id: 'C1', campaign_id: 'C1', spend_eur: 200, te_capped: 1, booked: 1, booked_kap_ja: 1 })),
    ],
    snapshots: snaps.flatMap(snapTage),
    insights: [],
    aktionen: [],
    log: [],
    vorrat: [
      { id: 'P1', kennung: 'neu1', status: 'hochgeladen', winkel: 'miete', released_at: '2026-09-28T10:00:00Z', meta_ad_ids: { AS_A: 'N1A', AS_B: 'N1B' } },
      { id: 'P2', kennung: 'neu2', status: 'freigegeben', winkel: 'kosten', released_at: '2026-09-29T10:00:00Z' },
    ],
    freie_slots_7d: 20,
    fx: { usd_per_eur: 1.14, mittel_7d: 1.14 },
    konto: { spend_gestern_eur: 100, spend_7d_eur: 700, spend_monat_eur: 400 },
    sync: { letzter_erfolg: '2026-10-05T04:25:00Z' },
    meta_fehler: [],
    capi_laeufe: [{ ts: vor(24), ok: true }, { ts: vor(48), ok: true }],
    verwaltete_kampagnen: ['C1'],
  }
  if (opt.kennung) for (const [i, x] of Object.entries(opt.kennung)) setQ(ctx, 'kennung', 0, `C1:a${i}`, x)
  return ctx
}
function setQ(ctx, level, fenster, id, x) {
  const z = ctx.qualitaet.find(r => r.entity_level === level && r.fenster === fenster && r.entity_id === id)
  if (z) Object.assign(z, x)
  else ctx.qualitaet.push({ stichtag: '2026-10-04', fenster, entity_level: level, entity_id: id, campaign_id: 'C1', spend_eur: 0, ...x })
}
function setSnap(ctx, level, id, x, nurHeute = false) {
  for (const z of ctx.snapshots) if (z.entity_level === level && z.entity_id === id && (!nurHeute || z.snap_date === '2026-10-05')) Object.assign(z, x)
}
function rule(ctx, key, x) { Object.assign(ctx.rules.find(r => r.rule_key === key), x) }
const lauf = ctx => R.bewerteRegeln(ctx)
const vs = (e, f = {}) => e.vorschlaege.filter(v => Object.entries(f).every(([k, val]) => v[k] === val))
const hs = (e, code) => e.hinweise.filter(h => h.code === code)
const ids = list => list.map(v => v.entity_id).sort().join(',')
// gutes Budget-Signal für S1 (Gruppe gepoolt: 4 Termine, 3 Kap Ja, Kosten/TE ~ 50 €)
const s1Gut = ctx => {
  for (const id of ['AS_A', 'AS_B']) setQ(ctx, 'adset', 14, id, { spend_eur: 150, te_capped: 3, booked: 2, booked_kap_ja: 2 })
}

// ── Grundfall ───────────────────────────────────────────────────────────────
test('Grundfall: keine Regel greift', () => {
  const e = lauf(basis())
  check(e.vorschlaege.length === 0, `erwartet 0 Vorschläge, bekommen ${e.vorschlaege.map(v => v.rule_key + ':' + v.entity_id).join(' ')}`)
  check(e.stopps.length === 0, `erwartet 0 Stopps, bekommen ${e.stopps.map(s => s.code)}`)
  check(e.info.fenstertag === true && e.info.datum === '2026-10-05', 'Montag muss Fenstertag sein')
  check(Math.abs(e.info.summe_budgets_eur - 105.26) < 0.01, `Budgetsumme ${e.info.summe_budgets_eur}`)
  check(e.info.naechstes_fenster === '2026-10-08', `nächstes Fenster ${e.info.naechstes_fenster}`)
})

// ── Freigabestufen / Modus ─────────────────────────────────────────────────
test('Modus aus: nichts', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.settings.autopilot_mode = 'aus'
  const e = lauf(c)
  check(e.vorschlaege.length === 0 && hs(e, 'modus_aus').length === 1, 'aus muss leer sein')
})
test('Modus schatten: Stufe 0, freigabe schatten', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.settings.autopilot_mode = 'schatten'
  rule(c, 'K1', { approval_level: 3 })
  const v = vs(lauf(c), { rule_key: 'K1' })
  check(v.length === 2 && v.every(x => x.stufe === 0 && x.freigabe === 'schatten'), `schatten: ${JSON.stringify(v.map(x => [x.stufe, x.freigabe]))}`)
})
test('Stufe = min(Regel, Modus)', () => {
  for (const [modus, lvl, erwartet] of [['vorschlag', 3, 1], ['ein_klick', 3, 2], ['autonom', 3, 3], ['autonom', 1, 1], ['autonom', 2, 2]]) {
    const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
    c.settings.autopilot_mode = modus
    rule(c, 'K1', { approval_level: lvl })
    const v = vs(lauf(c), { rule_key: 'K1' })
    check(v.length === 2 && v.every(x => x.stufe === erwartet), `${modus}/L${lvl}: erwartet ${erwartet}, bekommen ${v.map(x => x.stufe)}`)
    if (erwartet === 3) check(v.every(x => x.freigabe === 'autonom'), 'L3 muss freigabe autonom sein')
    if (erwartet === 1 || erwartet === 2) check(v.every(x => x.freigabe === 'vorgeschlagen'), 'L1/L2 müssen vorgeschlagen sein')
  }
  check(R.effektiveStufe(3, 2, 'autonom') === 2, 'max_level deckelt')
})
test('Pause bis: höchstens Stufe 1', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.settings.autopilot_mode = 'autonom'
  c.settings.autopilot_paused_until = vor(-5)
  rule(c, 'K1', { approval_level: 3 })
  const e = lauf(c)
  check(vs(e, { rule_key: 'K1' }).every(x => x.stufe === 1) && hs(e, 'pausiert').length === 1, 'paused_until muss auf 1 deckeln')
})

// ── K-Regeln ────────────────────────────────────────────────────────────────
test('K1: 150 € ohne Termin und ohne Kap-Ja, gepoolt über _lang/_kurz', () => {
  const e = lauf(basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } }))
  const v = vs(e, { rule_key: 'K1' })
  check(ids(v) === 'A1,B1', `K1 pausiert ${ids(v)}`)
  check(v.every(x => x.aktion === 'pause' && x.payload.status === 'PAUSED' && x.ad_id === x.entity_id && x.entity_level === 'ad'), 'K1 Payload')
  check(new Set(v.map(x => x.gruppe_schluessel)).size === 1 && v[0].gruppe_schluessel === 'K1:C1:a1:2026-10-05', `gruppe ${v[0] && v[0].gruppe_schluessel}`)
  check(v.find(x => x.entity_id === 'A1').idempotency_key === 'K1:A1:2026-10-05:pause', 'Idempotenz-Schlüssel rule:entity:window_date:aktion')
  check(v[0].rule_version === 2 && v[0].window_date === '2026-10-05' && v[0].nur_im_fenster === false, 'rule_version/window_date/nur_im_fenster')
  check(v[0].pre_state === 'ACTIVE|ACTIVE||2026-08-02T10:00:00Z', `pre_state ${v[0].pre_state}`)
  check(v[0].evidence.regeln.join() === 'K1' && v[0].evidence.spend_eur === 160 && v[0].evidence.coverage === 0.9 && v[0].evidence.fx === 1.14, 'Evidenz')
  const e2 = lauf(basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 1, te_capped: 0.3 } } }))
  check(vs(e2, { rule_key: 'K1' }).length === 0, 'K1 darf mit Kap-Ja-Lead nicht greifen')
  const e3 = lauf(basis({ kennung: { 1: { spend_eur: 149, leads_kap_ja: 0, te_capped: 0.3 } } }))
  check(e3.vorschlaege.length === 0, 'K1 unter 150 € darf nicht greifen')
})
test('K2: 300 € ohne Termin', () => {
  const e = lauf(basis({ kennung: { 2: { spend_eur: 310, leads_kap_ja: 2, te_capped: 0.5 } } }))
  const v = vs(e, { rule_key: 'K2' })
  check(ids(v) === 'A2,B2' && v[0].evidence.regeln.join() === 'K2', `K2 ${ids(v)} ${v[0] && v[0].evidence.regeln}`)
})
test('K3: Bayes P(CPTE > 2 x Ziel) >= 0,8', () => {
  const c = basis({ kennung: { 3: { spend_eur: 900, booked: 1, leads_kap_ja: 2, te_capped: 0.5 } } })
  setQ(c, 'campaign', 30, 'C1', { cpte_hat: 400 })
  const v = vs(lauf(c), { rule_key: 'K3' })
  check(ids(v) === 'A3,B3' && v[0].evidence.regeln.join() === 'K3' && v[0].evidence.p_bad >= 0.8, `K3 ${ids(v)} p_bad ${v[0] && v[0].evidence.p_bad}`)
  const c2 = basis({ kennung: { 3: { spend_eur: 280, booked: 1, leads_kap_ja: 2, te_capped: 0 } } })
  check(lauf(c2).vorschlaege.length === 0, 'K3 unter 2 x Ziel Spend darf nicht greifen')
})
test('K4: relativ zur Gruppe ab Tag 7', () => {
  const c = basis({ kennung: { 4: { spend_eur: 450, booked: 2, booked_kap_ja: 1, leads_kap_ja: 2, te_capped: 2 } } })
  setQ(c, 'campaign', 30, 'C1', { cpte_hat: 50 })
  const v = vs(lauf(c), { rule_key: 'K4' })
  check(ids(v) === 'A4,B4' && v[0].evidence.regeln.join() === 'K4', `K4 ${ids(v)} ${v[0] && v[0].evidence.regeln}`)
  const c2 = basis({ kennung: { 4: { spend_eur: 450, booked: 2, booked_kap_ja: 1, leads_kap_ja: 2, te_capped: 2 } } })
  setQ(c2, 'campaign', 30, 'C1', { cpte_hat: 50 })
  for (const z of c2.snapshots) if (z.entity_id === 'A4' || z.entity_id === 'B4') z.created_time = vor(4 * 24)
  check(vs(lauf(c2), { rule_key: 'K4' }).length === 0, 'K4 vor Tag 7 darf nicht greifen')
})
test('K0: Ablehnung nur melden', () => {
  const c = basis()
  setSnap(c, 'ad', 'A2', { effective_status: 'DISAPPROVED', ad_review_feedback: { global: 'Housing' } })
  const e = lauf(c)
  check(hs(e, 'K0').length === 1 && hs(e, 'K0')[0].entity_id === 'A2', 'K0 Hinweis fehlt')
  check(vs(e, { aktion: 'pause' }).length === 0, 'K0 darf nicht pausieren')
})

// ── Coverage-Gate ───────────────────────────────────────────────────────────
test('Coverage < 0,8: K-Regeln höchstens Stufe 1', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.settings.autopilot_mode = 'autonom'
  rule(c, 'K1', { approval_level: 3 })
  setQ(c, 'account', 14, 'konto', { attribution_coverage: 0.6 })
  const e = lauf(c)
  check(vs(e, { rule_key: 'K1' }).every(x => x.stufe === 1) && hs(e, 'coverage_niedrig').length === 1, 'Coverage 0,6 muss auf Stufe 1 deckeln')
  setQ(c, 'account', 14, 'konto', { attribution_coverage: 0.85 })
  check(vs(lauf(c), { rule_key: 'K1' }).every(x => x.stufe === 3), 'Coverage 0,85 erlaubt Stufe 3')
  c.qualitaet = c.qualitaet.filter(z => z.entity_level !== 'account')
  check(vs(lauf(c), { rule_key: 'K1' }).every(x => x.stufe === 1), 'unbekannte Coverage deckelt auf 1')
})

// ── Nie letzte aktive Anzeige ───────────────────────────────────────────────
test('Nie die letzte aktive Anzeige einer Gruppe pausieren', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  for (const id of ['A2', 'A3', 'A4']) setSnap(c, 'ad', id, { status: 'PAUSED', effective_status: 'PAUSED' })
  const e = lauf(c)
  check(ids(vs(e, { rule_key: 'K1' })) === 'B1', `nur B1 erwartet, bekommen ${ids(vs(e, { rule_key: 'K1' }))}`)
  check(hs(e, 'letzte_aktive_anzeige').some(h => h.entity_id === 'A1'), 'Hinweis letzte_aktive_anzeige fehlt')
})

// ── Lernschutz L1 ───────────────────────────────────────────────────────────
test('Lernschutz: 72 h nach last_sig_edit_ts keine Regel', () => {
  for (const [h, gesperrt] of [[24, true], [68, true], [70, false], [100, false]]) {
    const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
    setSnap(c, 'adset', 'AS_A', { learning_stage_info: { status: 'LEARNING', last_sig_edit_ts: sek(vor(h)) } })
    const e = lauf(c)
    const v = ids(vs(e, { rule_key: 'K1' }))
    check(v === (gesperrt ? 'B1' : 'A1,B1'), `${h} h: erwartet ${gesperrt ? 'B1' : 'A1,B1'}, bekommen ${v}`)
    if (gesperrt) check(hs(e, 'lernschutz').some(x => x.entity_id === 'A1'), `${h} h: Hinweis lernschutz fehlt`)
  }
  // eigene ausgeführte Aktivierung zählt als wesentliche Änderung
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.aktionen.push({ action: 'ersatz_aktivieren', status: 'ausgeführt', origin: 'autopilot', entity_level: 'ad', entity_id: 'N1B', executed_at: vor(30), payload: { adset_id: 'AS_B' } })
  check(ids(vs(lauf(c), { rule_key: 'K1' })) === 'A1', 'eigene Aktivierung vor 30 h muss AS_B sperren')
})

// ── 72-h-Sperre nach Handänderung ───────────────────────────────────────────
test('Handänderung: 72 h gesperrt, eigene Writes nicht', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  setSnap(c, 'ad', 'A1', { updated_time: vor(10) }, true)
  let e = lauf(c)
  check(ids(vs(e, { rule_key: 'K1' })) === 'B1', `A1 muss gesperrt sein, bekommen ${ids(vs(e, { rule_key: 'K1' }))}`)
  const h = hs(e, 'manuell_erkannt').find(x => x.entity_id === 'A1')
  check(!!h && h.details.neu === true, 'manuell_erkannt (neu) fehlt')
  // schon geloggt -> neu false
  c.log.push({ ts: vor(9), art: 'manuell_erkannt', entity_id: 'A1', evidence: { updated_time: vor(10) } })
  e = lauf(c)
  check(hs(e, 'manuell_erkannt').find(x => x.entity_id === 'A1').details.neu === false, 'bereits geloggte Handänderung muss neu=false sein')
  // eigener Write zur gleichen Zeit -> keine Sperre
  const c2 = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  setSnap(c2, 'ad', 'A1', { updated_time: vor(10) }, true)
  // (eigene Pause statt Aktivierung: eine Aktivierung wäre eine wesentliche Änderung und löst Lernschutz aus)
  c2.aktionen.push({ action: 'pause', status: 'ausgeführt', origin: 'autopilot', entity_level: 'ad', entity_id: 'A1', ad_id: 'A1', executed_at: iso(Date.parse(vor(10)) + 60000) })
  check(ids(vs(lauf(c2), { rule_key: 'K1' })) === 'A1,B1', 'eigener Write darf nicht sperren')
  // älter als 72 h -> frei
  const c3 = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  setSnap(c3, 'ad', 'A1', { updated_time: vor(80) }, true)
  check(ids(vs(lauf(c3), { rule_key: 'K1' })) === 'A1,B1', 'Handänderung vor 80 h darf nicht sperren')
})

// ── Budget S1 / Fenster / Symmetrie / Leitplanken ───────────────────────────
test('S1: +20 % im Fenster, Plan-B-Gruppe symmetrisch', () => {
  const c = basis()
  s1Gut(c)
  const e = lauf(c)
  const v = vs(e, { rule_key: 'S1' })
  check(ids(v) === 'AS_A,AS_B', `S1 ${ids(v)} ${JSON.stringify(e.hinweise.map(h => h.code))}`)
  check(v.every(x => x.aktion === 'budget_set' && x.payload.daily_budget === 7200 && x.before.daily_budget_cents === 6000), `S1 Budget ${v.map(x => x.payload.daily_budget)}`)
  check(new Set(v.map(x => x.gruppe_schluessel)).size === 1 && v[0].gruppe_schluessel === 'S1:AS_A+AS_B:2026-10-05', 'S1 Gruppe')
  check(v[0].nur_im_fenster === true && v[0].entity_level === 'adset' && v[0].ad_id === null, 'S1 Felder')
  check(v[0].evidence.details.summe_nachher_eur <= 250 && v[0].evidence.details.monatsprognose_eur <= 7500, 'S1 Leitplanken in Evidenz')
})
test('Änderungsfenster: S1 am Dienstag nur Hinweis', () => {
  const c = basis()
  s1Gut(c)
  c.now = DI
  for (const z of c.snapshots) z.synced_at = '2026-10-06T04:25:00Z'
  c.sync.letzter_erfolg = '2026-10-06T04:25:00Z'
  const e = lauf(c)
  check(vs(e, { rule_key: 'S1' }).length === 0 && hs(e, 'wartet_auf_fenster').some(h => h.rule_key === 'S1'), 'Dienstag: kein S1, Hinweis wartet_auf_fenster')
  check(e.info.fenstertag === false && e.info.naechstes_fenster === '2026-10-08', `nächstes Fenster ${e.info.naechstes_fenster}`)
  check(R.istFenstertag(4, [1, 4]) && !R.istFenstertag(2, [1, 4]) && R.istFenstertag(0, [7]), 'istFenstertag')
})
test('Plan-B-Symmetrie: ungleiche Budgets oder pausiertes Mitglied sperren', () => {
  const c = basis()
  s1Gut(c)
  setSnap(c, 'adset', 'AS_B', { daily_budget_cents: 5000 })
  const e = lauf(c)
  check(vs(e, { rule_key: 'S1' }).length === 0 && hs(e, 'gruppe_asymmetrisch').length === 1, 'asymmetrische Gruppe muss sperren')
  const c2 = basis()
  s1Gut(c2)
  setSnap(c2, 'adset', 'AS_B', { status: 'PAUSED', effective_status: 'PAUSED' })
  const e2 = lauf(c2)
  check(vs(e2, { aktion: 'budget_set' }).length === 0 && hs(e2, 'gruppe_unvollstaendig').length === 1, 'unvollständige Gruppe muss sperren')
})
test('+20 % höchstens alle 3 Tage', () => {
  for (const [tage, erlaubt] of [[2, false], [3, true]]) {
    const c = basis()
    s1Gut(c)
    c.aktionen.push({ action: 'budget_set', status: 'ausgeführt', origin: 'autopilot', entity_level: 'adset', entity_id: 'AS_A', executed_at: vor(tage * 24) })
    // Lernschutz/Abstand der Gruppe auf alt setzen, damit nur der Budgetabstand zählt
    const e = lauf(c)
    const n = vs(e, { rule_key: 'S1' }).length
    if (tage === 2) check(n === 0 && hs(e, 'lernschutz').length + hs(e, 'budget_abstand').length + hs(e, 'aenderungsabstand').length > 0, `Budgetänderung vor ${tage} Tagen muss sperren`)
    else check(n === 2, `Budgetänderung vor ${tage} Tagen muss erlauben, bekommen ${n} ${JSON.stringify(e.hinweise.map(h => h.code))}`)
    void erlaubt
  }
  // Änderung über Schnappschuss-Historie (Giona) erkannt
  const c = basis()
  s1Gut(c)
  for (const z of c.snapshots) if (z.entity_id === 'AS_A' && z.snap_date < '2026-10-04') z.daily_budget_cents = 5000
  for (const z of c.snapshots) if (z.entity_id === 'AS_B' && z.snap_date < '2026-10-04') z.daily_budget_cents = 5000
  const e = lauf(c)
  check(vs(e, { rule_key: 'S1' }).length === 0 && hs(e, 'budget_abstand').length === 1, 'Budgetsprung im Schnappschuss vor 1 Tag muss sperren')
  // nie über +20 %, auch bei viel Spielraum
  const c3 = basis()
  s1Gut(c3)
  const v = vs(lauf(c3), { rule_key: 'S1' })
  check(v.every(x => x.payload.daily_budget <= Math.floor(6000 * 1.2)), 'mehr als +20 %')
})
test('Summe aktiver Tagesbudgets <= max_account_daily_budget', () => {
  const c = basis()
  s1Gut(c)
  c.settings.max_account_daily_budget = 115
  const v = vs(lauf(c), { rule_key: 'S1' })
  const summe = v.reduce((a, x) => a + x.payload.daily_budget / 100 / 1.14, 0)
  check(v.length === 2 && v[0].payload.daily_budget < 7200 && summe <= 115 + 1e-9, `Summe nach S1 ${summe.toFixed(2)} €, Budgets ${v.map(x => x.payload.daily_budget)}`)
  check(v[0].payload.daily_budget === v[1].payload.daily_budget, 'gekappte Erhöhung muss symmetrisch bleiben')
  const c2 = basis()
  s1Gut(c2)
  c2.settings.max_account_daily_budget = 105
  const e2 = lauf(c2)
  check(vs(e2, { rule_key: 'S1' }).length === 0 && hs(e2, 'kein_spielraum').length === 1, 'ohne Spielraum kein S1')
})
test('Monatsprognose <= monthly_cap_eur', () => {
  const c = basis()
  s1Gut(c)
  c.settings.monthly_cap_eur = 3300 // (3300 - 400) / 27 Resttage = 107,41 € je Tag
  const v = vs(lauf(c), { rule_key: 'S1' })
  check(v.length === 2 && v[0].evidence.details.monatsprognose_eur <= 3300 && v[0].payload.daily_budget < 7200, `Monatsprognose ${v[0] && v[0].evidence.details.monatsprognose_eur}`)
  const c2 = basis()
  s1Gut(c2)
  c2.settings.monthly_cap_eur = 3200
  const e2 = lauf(c2)
  check(vs(e2, { rule_key: 'S1' }).length === 0 && hs(e2, 'kein_spielraum').length === 1, 'Monatsrahmen erreicht muss sperren')
  const c3 = basis()
  s1Gut(c3)
  c3.konto.spend_monat_eur = null
  const e3 = lauf(c3)
  check(vs(e3, { rule_key: 'S1' }).length === 0 && hs(e3, 'monatsprognose_unbekannt').length === 1, 'unbekannter Monats-Spend muss sperren')
})
test('S1: Frequenz, Slots, Kap-Anteil, Mindest-Termine', () => {
  const mk = f => { const c = basis(); s1Gut(c); f(c); return lauf(c) }
  check(vs(mk(c => setSnap(c, 'adset', 'AS_B', { frequency_7d: 2.6 })), { rule_key: 'S1' }).length === 0, 'Frequenz >= 2,5 muss sperren')
  check(vs(mk(c => { c.freie_slots_7d = 9 }), { rule_key: 'S1' }).length === 0, 'freie Slots < 10 müssen sperren')
  check(vs(mk(c => { c.freie_slots_7d = null }), { rule_key: 'S1' }).length === 0, 'unbekannte Slots müssen sperren')
  check(vs(mk(c => { for (const id of ['AS_A', 'AS_B']) setQ(c, 'adset', 14, id, { booked_kap_ja: 0 }) }), { rule_key: 'S1' }).length === 0, 'Kap-Ja-Anteil < 0,4 muss sperren')
  check(vs(mk(c => { setQ(c, 'adset', 14, 'AS_A', { booked: 0, booked_kap_ja: 0 }); setQ(c, 'adset', 14, 'AS_B', { booked: 2 }) }), { rule_key: 'S1' }).length === 0, '< 3 Termine muss sperren')
})
test('Budget L3 nur mit budget_autonomie_freigegeben_at', () => {
  const c = basis()
  s1Gut(c)
  c.settings.autopilot_mode = 'autonom'
  rule(c, 'S1', { approval_level: 3 })
  check(vs(lauf(c), { rule_key: 'S1' }).every(x => x.stufe === 2), 'ohne Budget-Autonomie höchstens Stufe 2')
  c.settings.budget_autonomie_freigegeben_at = '2026-09-01T00:00:00Z'
  check(vs(lauf(c), { rule_key: 'S1' }).every(x => x.stufe === 3), 'mit Budget-Autonomie Stufe 3')
})

// ── Hysterese S1 / D1, D2, D3 ───────────────────────────────────────────────
test('Hysterese S1 vs D1', () => {
  // Zwischenzone: weder S1 noch D1
  const c = basis()
  for (const id of ['AS_A', 'AS_B']) setQ(c, 'adset', 14, id, { spend_eur: 250, te_capped: 1.5, booked: 2, booked_kap_ja: 1 })
  const e = lauf(c)
  check(vs(e, { aktion: 'budget_set' }).length === 0, `Zwischenzone darf nichts ändern: ${vs(e, { aktion: 'budget_set' }).map(v => v.rule_key)}`)
  // klar schlecht: D1 -20 %, symmetrisch
  const c2 = basis()
  for (const id of ['AS_A', 'AS_B']) setQ(c2, 'adset', 14, id, { spend_eur: 300, te_capped: 0.25, booked: 0, booked_kap_ja: 0 })
  const v2 = vs(lauf(c2), { rule_key: 'D1' })
  check(ids(v2) === 'AS_A,AS_B' && v2.every(x => x.payload.daily_budget === 4800), `D1 ${ids(v2)} ${v2.map(x => x.payload.daily_budget)}`)
  check(vs(lauf(c2), { rule_key: 'S1' }).length === 0, 'S1 und D1 nie gleichzeitig')
  // D1 kurz nach S1-Erhöhung gesperrt (3-Tage-Abstand gilt in beide Richtungen)
  const c3 = basis()
  for (const id of ['AS_A', 'AS_B']) setQ(c3, 'adset', 14, id, { spend_eur: 300, te_capped: 0.25, booked: 0, booked_kap_ja: 0 })
  for (const z of c3.snapshots) if ((z.entity_id === 'AS_A' || z.entity_id === 'AS_B') && z.snap_date < '2026-10-03') z.daily_budget_cents = 5000
  const e3 = lauf(c3)
  check(vs(e3, { rule_key: 'D1' }).length === 0 && hs(e3, 'budget_abstand').length === 1, 'D1 zwei Tage nach Budgetänderung muss sperren')
  // Untergrenze 30 €
  const c4 = basis()
  for (const id of ['AS_A', 'AS_B']) setQ(c4, 'adset', 14, id, { spend_eur: 300, te_capped: 0.25, booked: 0 })
  for (const id of ['AS_A', 'AS_B']) setSnap(c4, 'adset', id, { daily_budget_cents: 3600 })
  c4.konto = { spend_gestern_eur: 50, spend_7d_eur: 350, spend_monat_eur: 200 } // passend zum kleinen Budget, sonst Spend-Stopp
  const v4 = vs(lauf(c4), { rule_key: 'D1' })
  check(v4.length === 2 && v4.every(x => x.payload.daily_budget === Math.ceil(30 * 1.14 * 100)), `D1 Untergrenze: ${v4.map(x => x.payload.daily_budget)}`)
  const c5 = basis()
  for (const id of ['AS_A', 'AS_B']) setQ(c5, 'adset', 14, id, { spend_eur: 300, te_capped: 0.25, booked: 0 })
  for (const id of ['AS_A', 'AS_B']) setSnap(c5, 'adset', id, { daily_budget_cents: 3420 })
  c5.konto = { spend_gestern_eur: 50, spend_7d_eur: 350, spend_monat_eur: 200 }
  const e5 = lauf(c5)
  check(vs(e5, { rule_key: 'D1' }).length === 0 && hs(e5, 'untergrenze').length === 1, 'D1 an der Untergrenze nur Hinweis')
})
test('D2: Gruppe pausieren nur als Vorschlag', () => {
  const c = basis()
  c.settings.autopilot_mode = 'autonom'
  rule(c, 'D2', { approval_level: 3, max_level: 3 })
  for (const id of ['AS_A', 'AS_B']) setQ(c, 'adset', 14, id, { spend_eur: 700, te_capped: 0.05, booked: 0 })
  const v = vs(lauf(c), { rule_key: 'D2' })
  check(ids(v) === 'AS_A,AS_B' && v.every(x => x.stufe === 1 && x.aktion === 'pause' && x.entity_level === 'adset'), `D2 ${ids(v)} ${v.map(x => x.stufe)}`)
})
test('D3: keine freien Slots -> Meldung', () => {
  const c = basis()
  s1Gut(c)
  c.freie_slots_7d = 0
  const e = lauf(c)
  check(hs(e, 'D3').length === 1 && vs(e, { rule_key: 'S1' }).length === 0, 'D3 Meldung, kein S1')
})

// ── Cent-Grenzen ────────────────────────────────────────────────────────────
test('USD-Cent 100 bis 500000', () => {
  const c = basis()
  s1Gut(c)
  rule(c, 'S1', { params: { budget_gruppen: [] } })
  rule(c, 'D1', { params: { budget_gruppen: [] } })
  for (const id of ['AS_A', 'AS_B']) { setSnap(c, 'adset', id, { daily_budget_cents: 450000 }); setQ(c, 'adset', 14, id, { booked: 3, booked_kap_ja: 2 }) }
  c.settings.max_account_daily_budget = 100000
  c.settings.monthly_cap_eur = 10000000
  const e = lauf(c)
  check(vs(e, { rule_key: 'S1' }).length === 0 && hs(e, 'cent_grenze').length >= 1, `über 500000 Cent muss sperren: ${JSON.stringify(e.hinweise.map(h => h.code))}`)
  const c2 = basis()
  rule(c2, 'D1', { params: { budget_gruppen: [], adset_min_daily_eur: 0.5 } })
  rule(c2, 'S1', { params: { budget_gruppen: [] } })
  for (const id of ['AS_A', 'AS_B']) { setSnap(c2, 'adset', id, { daily_budget_cents: 110 }); setQ(c2, 'adset', 14, id, { spend_eur: 450, te_capped: 0.2, booked: 0 }) }
  c2.konto = { spend_gestern_eur: 1, spend_7d_eur: 5, spend_monat_eur: 5 }
  const e2 = lauf(c2)
  check(vs(e2, { rule_key: 'D1' }).length === 0 && hs(e2, 'cent_grenze').length >= 1, 'unter 100 Cent muss sperren')
})

// ── Kurs ────────────────────────────────────────────────────────────────────
test('Kurs-Prüfung: Abweichung > 5 % oder fehlend stoppt Budget', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  s1Gut(c)
  c.fx = { usd_per_eur: 1.2, mittel_7d: 1.1 }
  const e = lauf(c)
  const st = e.stopps.find(s => s.code === 'kurs_abweichung')
  check(!!st && st.sperrt === 'budget', 'Stopp kurs_abweichung fehlt')
  check(vs(e, { aktion: 'budget_set' }).length === 0, 'Budget trotz Kursstopp')
  check(vs(e, { rule_key: 'K1' }).length === 2 && vs(e, { rule_key: 'K1' }).every(x => x.stufe <= 1), 'Kills bleiben als Vorschlag')
  check(e.info.modus_neu === 'vorschlag', 'Modus fällt auf vorschlag')
  c.fx = { usd_per_eur: 1.16, mittel_7d: 1.14 }
  check(!lauf(c).stopps.some(s => s.code.startsWith('kurs')), '1,8 % Abweichung ist ok')
  c.fx = {}
  const e3 = lauf(c)
  check(e3.stopps.some(s => s.code === 'kurs_fehlt') && e3.info.usd_per_eur === 1.14, 'fehlender Kurs: Stopp + Fallback 1,14')
})

// ── Stopps ──────────────────────────────────────────────────────────────────
test('Stopps: Sync, Meta-Auth, CAPI, Spend', () => {
  const k1 = { kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } }
  let c = basis(k1)
  c.sync.letzter_erfolg = vor(31)
  for (const z of c.snapshots) z.synced_at = vor(31)
  let e = lauf(c)
  check(e.stopps.some(s => s.code === 'sync_alt' && s.sperrt === 'alles') && e.vorschlaege.length === 0, 'Sync > 30 h: Stopp und keine Vorschläge')
  c = basis(k1)
  c.meta_fehler = [{ kind: 'auth', code: 190, ts: vor(2) }]
  e = lauf(c)
  check(e.stopps.some(s => s.code === 'meta_auth') && e.vorschlaege.length === 0, 'Auth-Fehler: Stopp')
  c = basis(k1)
  c.meta_fehler = [{ kind: 'rate_limit', code: 17, ts: vor(2) }]
  e = lauf(c)
  check(e.stopps.some(s => s.code === 'meta_rate_limit') && vs(e, { rule_key: 'K1' }).length === 2, 'Rate-Limit: Stopp, Vorschläge bleiben')
  c = basis(k1)
  c.capi_laeufe = [{ ts: vor(24), ok: false }, { ts: vor(48), ok: false }, { ts: vor(72), ok: true }]
  check(lauf(c).stopps.some(s => s.code === 'capi_fehler'), 'CAPI 2 x fehlerhaft: Stopp')
  c.capi_laeufe = [{ ts: vor(24), ok: false }, { ts: vor(48), ok: true }]
  check(!lauf(c).stopps.some(s => s.code === 'capi_fehler'), 'CAPI 1 x fehlerhaft: kein Stopp')
  c = basis()
  s1Gut(c)
  c.konto.spend_7d_eur = 900 // > 7 x 105,26 x 1,1 = 810,5
  e = lauf(c)
  check(e.stopps.some(s => s.code === 'spend_woche') && vs(e, { rule_key: 'S1' }).length === 0, 'Wochen-Spend: Stopp, kein S1')
  c = basis()
  c.konto.spend_gestern_eur = 190 // > 1,75 x 105,26
  check(lauf(c).stopps.some(s => s.code === 'spend_tag'), 'Tages-Spend: Stopp')
  check(R.modusMin('schatten', 'vorschlag') === 'schatten' && R.modusMin('autonom', 'vorschlag') === 'vorschlag', 'Stopp hebt den Modus nie an')
})

// ── Aktionen pro Tag ────────────────────────────────────────────────────────
test('Max. autonome Aktionen pro Tag, Gruppen unteilbar', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 }, 2: { spend_eur: 170, leads_kap_ja: 0, te_capped: 0.3 }, 3: { spend_eur: 180, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.settings.autopilot_mode = 'autonom'
  rule(c, 'K1', { approval_level: 3 })
  const e = lauf(c)
  const v = vs(e, { rule_key: 'K1' })
  const l3 = v.filter(x => x.stufe === 3)
  check(v.length === 6 && l3.length === 4, `6 Kills, 4 autonom erwartet: ${v.length}/${l3.length}`)
  const gruppen = new Map()
  for (const x of v) gruppen.set(x.gruppe_schluessel, [...(gruppen.get(x.gruppe_schluessel) ?? []), x.stufe])
  check([...gruppen.values()].every(st => new Set(st).size === 1), 'Gruppe wurde geteilt')
  check(hs(e, 'aktionslimit').length === 1, 'Hinweis aktionslimit fehlt')
  // bereits 4 autonome Aktionen heute -> nur 1 frei -> keine ganze Gruppe passt
  const c2 = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c2.settings.autopilot_mode = 'autonom'
  rule(c2, 'K1', { approval_level: 3 })
  for (let i = 0; i < 4; i++) c2.aktionen.push({ action: 'pause', status: 'ausgeführt', origin: 'autopilot', freigabe: 'autonom', entity_id: `X${i}`, executed_at: vor(1) })
  check(vs(lauf(c2), { rule_key: 'K1' }).every(x => x.stufe === 1), '4 von 5 verbraucht: Zweiergruppe wird Vorschlag')
  // mehr als das Limit -> Stopp
  for (let i = 4; i < 6; i++) c2.aktionen.push({ action: 'pause', status: 'ausgeführt', origin: 'autopilot', freigabe: 'autonom', entity_id: `X${i}`, executed_at: vor(1) })
  const e3 = lauf(c2)
  check(e3.stopps.some(s => s.code === 'zu_viele_aktionen') && e3.info.heute_autonom === 6, 'über dem Limit: Stopp zu_viele_aktionen')
  // gestern zählt nicht
  const c4 = basis()
  for (let i = 0; i < 9; i++) c4.aktionen.push({ action: 'pause', status: 'ausgeführt', origin: 'autopilot', freigabe: 'autonom', entity_id: `Y${i}`, executed_at: vor(30) })
  check(lauf(c4).info.heute_autonom === 0, 'Aktionen von gestern dürfen nicht zählen')
})

// ── Idempotenz ──────────────────────────────────────────────────────────────
test('Idempotenz: vorhandener Schlüssel erzeugt keine Dublette', () => {
  check(R.idempotenzSchluessel('S1', 'AS_A', '2026-10-05', 'budget_set') === 'S1:AS_A:2026-10-05:budget_set', 'Schlüsselformat')
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.aktionen.push({ action: 'pause', status: null, origin: 'autopilot', freigabe: 'vorgeschlagen', entity_id: 'A1', ad_id: 'A1', idempotency_key: 'K1:A1:2026-10-05:pause', created_at: vor(1) })
  check(ids(vs(lauf(c), { rule_key: 'K1' })) === 'B1', 'A1 schon vorgeschlagen, nur B1 neu')
  check(R.preStateText({ status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget_cents: 6000, updated_time: 'x' }) === 'ACTIVE|ACTIVE|6000|x', 'preStateText')
})

// ── Ermüdung + Rotation ─────────────────────────────────────────────────────
test('F1 -> R1: Ersatz aus hochgeladenem Vorrat im Fenster', () => {
  const c = basis()
  setSnap(c, 'ad', 'A2', { frequency_7d: 3.4 })
  const e = lauf(c)
  const v = vs(e, { aktion: 'ersatz_aktivieren' })
  check(v.length === 1 && v[0].entity_id === 'N1A' && v[0].rule_key === 'F1', `R1 ${JSON.stringify(v.map(x => [x.rule_key, x.entity_id]))} ${JSON.stringify(e.hinweise.map(h => h.code))}`)
  check(v[0] && v[0].payload.pool_id === 'P1' && v[0].payload.ersetzt_kennung === 'a2' && v[0].payload.adset_id === 'AS_A' && v[0].nur_im_fenster === true, 'R1 Payload')
  check(vs(e, { aktion: 'pause' }).length === 0, 'R1 pausiert die ermüdete Anzeige nicht sofort')
  // Dienstag: nur Hinweis
  const c2 = basis()
  setSnap(c2, 'ad', 'A2', { frequency_7d: 3.4 })
  c2.now = DI
  c2.sync.letzter_erfolg = '2026-10-06T04:25:00Z'
  const e2 = lauf(c2)
  check(vs(e2, { aktion: 'ersatz_aktivieren' }).length === 0 && hs(e2, 'wartet_auf_fenster').some(h => h.entity_id === 'A2'), 'Dienstag: Ersatz wartet')
  // Ersatz in Prüfung oder abgelehnt (R3) zählt nicht -> Upload aus freigegebenem Vorrat
  const c3 = basis()
  setSnap(c3, 'ad', 'A2', { frequency_7d: 3.4 })
  setSnap(c3, 'ad', 'N1A', { effective_status: 'DISAPPROVED' })
  const e3 = lauf(c3)
  const up = vs(e3, { aktion: 'ersatz_hochladen' })
  check(vs(e3, { aktion: 'ersatz_aktivieren' }).length === 0 && up.length === 1 && up[0].payload.pool_id === 'P2' && up[0].entity_id === 'AS_A' && up[0].rule_key === 'POOL_UPLOAD', `R3/Upload ${JSON.stringify(up.map(x => [x.entity_id, x.payload.pool_id]))}`)
})
test('L3: neue Anzeigen erst ab Tag 8 der Kampagne', () => {
  const c = basis()
  setSnap(c, 'ad', 'A2', { frequency_7d: 3.4 })
  setSnap(c, 'campaign', 'C1', { created_time: vor(5 * 24) })
  const e = lauf(c)
  check(vs(e, { aktion: 'ersatz_aktivieren' }).length === 0 && hs(e, 'kampagne_zu_jung').length === 1, 'Kampagne Tag 6: kein Ersatz')
})
test('L2: höchstens 2 neue Anzeigen je Fenster', () => {
  const c = basis()
  for (const id of ['A1', 'A2', 'A3']) setSnap(c, 'ad', id, { frequency_7d: 3.5 })
  c.vorrat.push({ id: 'P3', kennung: 'neu3', status: 'hochgeladen', winkel: 'x', released_at: '2026-09-30T10:00:00Z', meta_ad_ids: { AS_A: 'N3A' } })
  c.vorrat.push({ id: 'P4', kennung: 'neu4', status: 'hochgeladen', winkel: 'x', released_at: '2026-09-30T11:00:00Z', meta_ad_ids: { AS_A: 'N4A' } })
  const e = lauf(c)
  check(vs(e, { aktion: 'ersatz_aktivieren' }).length === 2 && hs(e, 'max_neu').length === 1, `max 2: ${vs(e, { aktion: 'ersatz_aktivieren' }).length} ${JSON.stringify(e.hinweise.map(h => h.code))}`)
  // schon eine Aktivierung in diesem Fenster -> nur noch 1
  c.aktionen.push({ action: 'ersatz_aktivieren', status: 'bestätigt', origin: 'autopilot', freigabe: 'freigegeben', entity_id: 'X9', window_date: '2026-10-05', payload: { adset_id: 'AS_A' } })
  check(vs(lauf(c), { aktion: 'ersatz_aktivieren' }).length === 1, 'bereits 1 im Fenster: nur 1 weitere')
})
test('F2 + F3 aus Insights (Baseline Tage 2-8 gegen letzte 7 Tage)', () => {
  const c = basis()
  c.insights_ab = '2026-08-25'
  const tage = []
  for (let d = Date.parse('2026-09-02T00:00:00Z'); d <= Date.parse('2026-10-04T00:00:00Z'); d += 86400000) tage.push(new Date(d).toISOString().slice(0, 10))
  for (const day of tage) {
    const spät = day >= '2026-09-28'
    c.insights.push({ day, ad_id: 'A3', spend_eur: spät ? 15 : 10, impressions: 1000, link_clicks: spät ? 8 : 15, video_3s_true: 0 })
    for (const ad of ['A4', 'B3', 'B4']) c.insights.push({ day, ad_id: ad, spend_eur: 10, impressions: 1000, link_clicks: 15, video_3s_true: 0 })
  }
  const e = lauf(c)
  const v = vs(e, { aktion: 'ersatz_aktivieren' })
  check(v.length === 1 && v[0].rule_key === 'F2' && v[0].evidence.regeln.join() === 'F2,F3' && v[0].payload.ersetzt_kennung === 'a3', `F2+F3 ${JSON.stringify(v.map(x => [x.rule_key, x.evidence.regeln]))}`)
  check(v[0] && Math.abs(v[0].evidence.ctr_ratio - 8 / 15) < 1e-3 && Math.abs(v[0].evidence.cpm_ratio - 1.5) < 1e-3, `Verhältnisse ${v[0] && [v[0].evidence.ctr_ratio, v[0].evidence.cpm_ratio]}`)
  // nur ein Signal (F2) reicht nicht
  const c2 = basis()
  c2.insights_ab = '2026-08-25'
  for (const day of tage) {
    const spät = day >= '2026-09-28'
    c2.insights.push({ day, ad_id: 'A3', spend_eur: 10, impressions: 1000, link_clicks: spät ? 8 : 15 })
    for (const ad of ['A4', 'B3', 'B4']) c2.insights.push({ day, ad_id: ad, spend_eur: 10, impressions: 1000, link_clicks: 15 })
  }
  check(vs(lauf(c2), { aktion: 'ersatz_aktivieren' }).length === 0, 'F2 allein darf nicht rotieren')
})
test('R1b: alte Anzeige nach 24 h ACTIVE des Ersatzes pausieren, Gewinner nie (R4)', () => {
  const mk = (kenn, seitH, now = MO) => {
    const c = basis({ kennung: { 1: kenn } })
    c.now = now
    if (now !== MO) c.sync.letzter_erfolg = iso(Date.parse(now) - 5 * 60000)
    c.vorrat[0] = { id: 'P1', kennung: 'neu1', status: 'aktiv', winkel: 'miete', ersetzt_kennung: 'a1', aktiv_seit: vor(seitH, now), meta_ad_ids: { AS_A: 'N1A' } }
    setSnap(c, 'ad', 'N1A', { status: 'ACTIVE', effective_status: 'ACTIVE' })
    return c
  }
  const schwach = { spend_eur: 100, leads_kap_ja: 1, te_capped: 0.2, booked: 0 }
  let e = lauf(mk(schwach, 30))
  let v = vs(e, { rule_key: 'R1b' })
  check(ids(v) === 'A1' && v[0].aktion === 'pause', `R1b ${ids(v)}`)
  e = lauf(mk(schwach, 10))
  check(vs(e, { rule_key: 'R1b' }).length === 0, 'Ersatz erst 10 h aktiv: noch nicht pausieren')
  e = lauf(mk({ spend_eur: 200, te_capped: 4, booked: 3, booked_kap_ja: 2, leads_kap_ja: 3 }, 30))
  check(vs(e, { rule_key: 'R1b' }).length === 0 && hs(e, 'gewinner_bleibt').length === 1, 'Gewinner darf nicht pausiert werden (R4)')
  e = lauf(mk(schwach, 30, DI))
  check(vs(e, { rule_key: 'R1b' }).length === 0 && hs(e, 'wartet_auf_fenster').some(h => h.rule_key === 'R1b'), 'R1b nur im Fenster')
  // laufender Ersatz verhindert zweiten Ersatz für dieselbe Kennung
  const c = mk(schwach, 30)
  setSnap(c, 'ad', 'A1', { frequency_7d: 3.6 })
  c.vorrat.push({ id: 'P5', kennung: 'neu5', status: 'hochgeladen', meta_ad_ids: { AS_A: 'N3A' } })
  check(vs(lauf(c), { aktion: 'ersatz_aktivieren' }).length === 0, 'kein zweiter Ersatz für dieselbe Kennung')
})
test('R2: nach Kills unter min_active_ads Ersatz, Upload für Plan-B-Paar', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 }, 2: { spend_eur: 170, leads_kap_ja: 0, te_capped: 0.3 } } })
  const e = lauf(c)
  check(ids(vs(e, { aktion: 'pause' })) === 'A1,A2,B1,B2', 'vier Kills erwartet')
  const r2 = vs(e, { rule_key: 'R2' })
  check(ids(r2) === 'N1A,N1B' && r2.every(x => x.aktion === 'ersatz_aktivieren' && x.payload.pool_id === 'P1'), `R2 ${ids(r2)}`)
  const up = vs(e, { rule_key: 'POOL_UPLOAD' })
  check(ids(up) === 'AS_A,AS_B' && up.every(x => x.payload.pool_id === 'P2') && new Set(up.map(x => x.gruppe_schluessel)).size === 1, `Upload ${JSON.stringify(up.map(x => [x.entity_id, x.payload.pool_id]))}`)
  check(up.every(x => x.stufe <= 2), 'POOL_UPLOAD max Stufe 2')
  // ohne HOUSING kein Upload
  const c2 = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 }, 2: { spend_eur: 170, leads_kap_ja: 0, te_capped: 0.3 } } })
  setSnap(c2, 'campaign', 'C1', { special_ad_categories: [] })
  const e2 = lauf(c2)
  check(vs(e2, { rule_key: 'POOL_UPLOAD' }).length === 0 && hs(e2, 'kein_housing').length >= 1, 'ohne HOUSING kein Upload')
  // Kampagnen-Assistent aus: kein Upload-Vorschlag, nur Hinweis; Kills/R2 laufen weiter
  const c3 = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 }, 2: { spend_eur: 170, leads_kap_ja: 0, te_capped: 0.3 } } })
  c3.settings.builder_enabled = false
  const e3 = lauf(c3)
  check(vs(e3, { rule_key: 'POOL_UPLOAD' }).length === 0 && hs(e3, 'assistent_aus').length >= 1 && hs(e3, 'assistent_aus').every(h => h.rule_key === 'POOL_UPLOAD'), 'builder_enabled false: kein Upload, Hinweis assistent_aus')
  check(ids(vs(e3, { aktion: 'pause' })) === 'A1,A2,B1,B2' && ids(vs(e3, { rule_key: 'R2' })) === 'N1A,N1B', 'builder_enabled false: Kills und R2 unverändert')
  const c4 = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 }, 2: { spend_eur: 170, leads_kap_ja: 0, te_capped: 0.3 } } })
  c4.settings.builder_enabled = true
  check(ids(vs(lauf(c4), { rule_key: 'POOL_UPLOAD' })) === 'AS_A,AS_B', 'builder_enabled true: Upload wie bisher')
})
test('Nicht verwaltete Kampagnen bleiben unberührt', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c.verwaltete_kampagnen = ['ANDERE']
  check(lauf(c).vorschlaege.length === 0, 'Agentur-Altbestand darf nicht angefasst werden')
})
// ── Kennung wie SQL (btrim, Suffix ohne Groß-/Kleinschreibung, Rückfall Anzeigen-ID) ──
test('Kennung: _Kurz, Leerzeichen am Ende und leerer Name finden die SQL-Kennung', () => {
  const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  setSnap(c, 'ad', 'A1', { name: 'a1_LANG' })
  setSnap(c, 'ad', 'B1', { name: 'a1_Kurz ' })
  const v = vs(lauf(c), { rule_key: 'K1' })
  check(ids(v) === 'A1,B1', `K1 über a1_LANG / 'a1_Kurz ' gepoolt: ${ids(v)}`)
  // leerer Name: SQL-Kennung = campaign_id:ad_id
  const c2 = basis()
  setSnap(c2, 'ad', 'A2', { name: '' })
  setQ(c2, 'kennung', 0, 'C1:A2', { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3, booked: 0 })
  const v2 = vs(lauf(c2), { rule_key: 'K1' })
  check(ids(v2) === 'A2', `K1 für leeren Namen über C1:A2: ${ids(v2)}`)
  // ermüdete Anzeige mit _Kurz + Leerzeichen: ersatz_aktivieren trägt pool_id und ersetzt_kennung (Basisname)
  const c3 = basis()
  setSnap(c3, 'ad', 'A2', { name: 'a2_Kurz ', frequency_7d: 3.4 })
  const r = vs(lauf(c3), { aktion: 'ersatz_aktivieren' })
  check(r.length === 1 && r[0].payload.pool_id === 'P1' && r[0].payload.ersetzt_kennung === 'a2' && r[0].payload.ersetzt_ad_id === 'A2', `ersatz_aktivieren Payload ${JSON.stringify(r.map(x => x.payload))}`)
})

test('R1b nutzt ersetzt_kennung aus dem Vorrat (normalisiert), nur bei eingeschaltetem Ersatz', () => {
  const schwach = { spend_eur: 100, leads_kap_ja: 1, te_capped: 0.2, booked: 0 }
  const mk = (ersetzt, altName) => {
    const c = basis({ kennung: { 1: schwach } })
    if (altName != null) setSnap(c, 'ad', 'A1', { name: altName })
    c.vorrat[0] = { id: 'P1', kennung: 'neu1', status: 'aktiv', winkel: 'miete', ersetzt_kennung: ersetzt, aktiv_seit: vor(30), meta_ad_ids: { AS_A: 'N1A' } }
    setSnap(c, 'ad', 'N1A', { status: 'ACTIVE', effective_status: 'ACTIVE' })
    return c
  }
  check(ids(vs(lauf(mk('a1', 'a1_LANG ')), { rule_key: 'R1b' })) === 'A1', 'R1b muss a1_LANG über ersetzt_kennung a1 finden')
  check(vs(lauf(mk('a9', null)), { rule_key: 'R1b' }).length === 0, 'andere ersetzt_kennung: kein R1b')
  check(vs(lauf(mk(null, null)), { rule_key: 'R1b' }).length === 0, 'ohne ersetzt_kennung: kein R1b')
  // Plan B: Ersatz nur in AS_A eingeschaltet -> müde B2 in AS_B bekommt trotzdem einen Ersatz (R1)
  const c = basis()
  c.vorrat[0] = { id: 'P1', kennung: 'neu1', status: 'aktiv', winkel: 'miete', ersetzt_kennung: 'a2', aktiv_seit: vor(30), meta_ad_ids: { AS_A: 'N1A', AS_B: 'N1B' } }
  setSnap(c, 'ad', 'N1A', { status: 'ACTIVE', effective_status: 'ACTIVE' })
  setSnap(c, 'ad', 'B2', { frequency_7d: 3.4 })
  c.snapshots.push(...snapTage({ entity_level: 'ad', entity_id: 'N5B', parent_id: 'AS_B', campaign_id: 'C1', name: 'N5B', status: 'PAUSED', effective_status: 'PAUSED', created_time: '2026-10-01T10:00:00Z', updated_time: '2026-10-01T10:00:00Z' }))
  c.vorrat.push({ id: 'P5', kennung: 'neu5', status: 'hochgeladen', winkel: 'x', released_at: '2026-09-30T10:00:00Z', meta_ad_ids: { AS_B: 'N5B' } })
  const r = vs(lauf(c), { aktion: 'ersatz_aktivieren' })
  check(ids(r) === 'N5B' && r[0].payload.pool_id === 'P5' && r[0].payload.ersetzt_kennung === 'a2', `R1 in AS_B trotz laufendem Ersatz in AS_A: ${JSON.stringify(r.map(x => [x.entity_id, x.payload.pool_id]))}`)
})

// ── Startwerte der Migration: deutsche Parameternamen wirken ────────────────
const SEED = (() => {
  const sql = readFileSync(join(root, 'supabase/migrations/20261003110000_werbe_autopilot.sql'), 'utf8')
  const block = sql.slice(sql.indexOf('insert into public.ad_autopilot_rules'), sql.indexOf('on conflict (rule_key) do nothing'))
  const re = /\(\s*'([A-Za-z0-9_]+)',\s*'[^']*',\s*'[a-z_]+',\s*(?:true|false),\s*\d+,\s*\d+,\s*'[a-z_]+',\s*'(\{[^']*\})'::jsonb\)/g
  const out = {}
  let m
  while ((m = re.exec(block))) out[m[1]] = JSON.parse(m[2])
  return out
})()
const seedRules = (extra = {}) => [
  { rule_key: 'SCHUTZ', aktion: 'meldung', enabled: true, approval_level: 1, max_level: 1, params: SEED.SCHUTZ },
  { rule_key: 'STOPP', aktion: 'meldung', enabled: true, approval_level: 1, max_level: 1, params: SEED.STOPP },
  ...RULES().map(r => ({ ...r, params: { ...(SEED[r.rule_key] ?? {}), ...(r.params?.budget_gruppen ? { budget_gruppen: r.params.budget_gruppen } : {}), ...(extra[r.rule_key] ?? {}) } })),
]
test('Startwerte: jeder Parameter der Migration hat einen Leser', () => {
  check(Object.keys(SEED).length === 20, `20 Regeln erwartet, gelesen ${Object.keys(SEED).length}`)
  const anderswo = new Set(['budget_gruppen', 'kap_floor', 'min_pool_ready', 'nur_im_fenster'])
  for (const [key, params] of Object.entries(SEED)) {
    for (const p of Object.keys(params)) {
      const ziel = R.PARAM_ALIAS[key]?.[p]
      if (ziel) check(ziel in R.REGEL_STANDARD, `${key}.${p} -> ${ziel} fehlt in REGEL_STANDARD`)
      else check(p in R.REGEL_STANDARD || anderswo.has(p), `${key}.${p} wird von keiner Stelle gelesen`)
    }
  }
  const n = R.paramsMitAlias('D1', SEED.D1)
  check(n.d1_step === 0.2 && n.min_days_between_sig_edits === 3 && n.d1_p === 0.8, `D1-Alias ${JSON.stringify(n)}`)
  check(R.paramsMitAlias('F5', SEED.F5).f5_min_age_days === 10 && R.paramsMitAlias('F1', SEED.F1).fatigue_min_age_days === 10, 'F-Alias min_alter_tage')
  // Grundfall mit allen Startwerten: nichts, kein Stopp; K1 greift mit spend_eur 150
  const c = basis()
  c.rules = seedRules()
  const e = lauf(c)
  check(e.vorschlaege.length === 0 && e.stopps.length === 0, `Startwerte Grundfall: ${e.vorschlaege.map(v => v.rule_key)} / ${e.stopps.map(s => s.code)}`)
  const c2 = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 } } })
  c2.rules = seedRules()
  check(ids(vs(lauf(c2), { rule_key: 'K1' })) === 'A1,B1', 'K1 mit Startwerten')
})
test('Startwerte: F min_alter_tage und min_impressions je Regel, F5 ab Tag 10', () => {
  // A3 lebt seit 2026-09-15 (20 Tage): CTR fällt (F2), Kosten/TE der letzten 14 Tage 3 x der ersten 14 (F5)
  const mk = (extra = {}) => {
    const c = basis()
    c.rules = seedRules(extra)
    c.insights_ab = '2026-09-10'
    for (let d = Date.parse('2026-09-15T00:00:00Z'); d <= Date.parse('2026-10-04T00:00:00Z'); d += 86400000) {
      const day = new Date(d).toISOString().slice(0, 10)
      c.insights.push({ day, ad_id: 'A3', spend_eur: 10, impressions: 1000, link_clicks: day >= '2026-09-28' ? 8 : 15 })
    }
    setQ(c, 'ad', 14, 'A3', { spend_eur: 300, te_capped: 2 })
    c.fruehphase = { A3: { spend_eur: 100, te: 2 } }
    return c
  }
  const v = vs(lauf(mk()), { aktion: 'ersatz_aktivieren' })
  check(v.length === 1 && v[0].evidence.regeln.join() === 'F2,F5' && v[0].payload.ersetzt_kennung === 'a3', `Startwert F5 min_alter_tage 10: ${JSON.stringify(v.map(x => x.evidence.regeln))}`)
  check(vs(lauf(mk({ F5: { min_alter_tage: 28 } })), { aktion: 'ersatz_aktivieren' }).length === 0, 'F5 min_alter_tage 28: nur F2, nicht müde')
  check(vs(lauf(mk({ F2: { min_impressions: 8000 } })), { aktion: 'ersatz_aktivieren' }).length === 0, 'F2 min_impressions 8000: F2 greift nicht')
  check(vs(lauf(mk({ F2: { min_alter_tage: 21 } })), { aktion: 'ersatz_aktivieren' }).length === 0, 'F2 min_alter_tage 21: F2 greift nicht')
  // F1: min_alter_tage und min_impressions (7-Tage-Impressionen aus dem Schnappschuss)
  const f1 = (extra, impr) => {
    const c = basis()
    c.rules = seedRules(extra)
    setSnap(c, 'ad', 'A2', { frequency_7d: 3.4, ...(impr != null ? { impressions_7d: impr } : {}) })
    return vs(lauf(c), { aktion: 'ersatz_aktivieren' }).length
  }
  check(f1({}, 5000) === 1 && f1({}, 2000) === 0 && f1({ F1: { min_impressions: 1000 } }, 2000) === 1, 'F1 min_impressions')
  check(f1({ F1: { min_alter_tage: 90 } }, 5000) === 0, 'F1 min_alter_tage 90')
})
test('Startwerte: S1 min_tage_seit_aenderung, kap_floor, K3 prior_strength_te, R2, D3', () => {
  // Budgetsprung im Schnappschuss vor 1 Tag: Standard 3 Tage sperrt, S1-Startwert 1 erlaubt
  const sprung = extra => {
    const c = basis()
    c.rules = seedRules(extra)
    s1Gut(c)
    for (const z of c.snapshots) if ((z.entity_id === 'AS_A' || z.entity_id === 'AS_B') && z.snap_date < '2026-10-04') z.daily_budget_cents = 5000
    return lauf(c)
  }
  let e = sprung({})
  check(vs(e, { rule_key: 'S1' }).length === 0 && hs(e, 'budget_abstand').length === 1, 'S1 min_tage_seit_aenderung 3 sperrt')
  e = sprung({ S1: { min_tage_seit_aenderung: 1 } })
  check(vs(e, { rule_key: 'S1' }).length === 2, `S1 min_tage_seit_aenderung 1 erlaubt: ${JSON.stringify(e.hinweise.map(h => h.code))}`)
  // kap_floor: der strengere Wert aus ad_settings und S1 gilt
  const kap = (setting, regelWert) => {
    const c = basis()
    c.rules = seedRules({ S1: { kap_floor: regelWert } })
    c.settings.kap_floor = setting
    for (const id of ['AS_A', 'AS_B']) setQ(c, 'adset', 14, id, { spend_eur: 150, te_capped: 3, booked: 2, booked_kap_ja: 1 })
    return vs(lauf(c), { rule_key: 'S1' }).length
  }
  check(kap(0.4, 0.4) === 2 && kap(0.6, 0.4) === 0 && kap(0.4, 0.6) === 0, `kap_floor max(Einstellung, S1): ${kap(0.4, 0.4)} ${kap(0.6, 0.4)} ${kap(0.4, 0.6)}`)
  // K3 prior_strength_te (wie die SQL-Qualitätsrechnung): starker Prior verhindert den Kill
  const k3 = extra => {
    const c = basis({ kennung: { 3: { spend_eur: 900, booked: 1, leads_kap_ja: 2, te_capped: 0.5 } } })
    c.rules = seedRules(extra)
    setQ(c, 'campaign', 30, 'C1', { cpte_hat: 400 })
    return vs(lauf(c), { rule_key: 'K3' }).length
  }
  check(k3({}) === 2 && k3({ K3: { prior_strength_te: 50 } }) === 0, 'K3 prior_strength_te wirkt')
  // R2 max_new_ads_per_window aus der Regel
  const r2 = extra => {
    const c = basis({ kennung: { 1: { spend_eur: 160, leads_kap_ja: 0, te_capped: 0.3 }, 2: { spend_eur: 170, leads_kap_ja: 0, te_capped: 0.3 } } })
    c.rules = seedRules(extra)
    return lauf(c)
  }
  check(vs(r2({}), { rule_key: 'R2' }).length === 2, 'R2 mit Startwert 2')
  e = r2({ R2: { max_new_ads_per_window: 0 } })
  check(vs(e, { rule_key: 'R2' }).length === 0 && hs(e, 'max_neu').some(h => h.rule_key === 'R2' && /schon 0 neue/.test(h.text)), 'R2 max_new_ads_per_window 0')
  // D3 min_free_slots_7d
  const d3 = (extra, slots) => {
    const c = basis()
    c.rules = seedRules(extra)
    c.freie_slots_7d = slots
    return hs(lauf(c), 'D3').length
  }
  check(d3({}, 0) === 1 && d3({}, 3) === 0 && d3({ D3: { min_free_slots_7d: 5 } }, 3) === 1, 'D3 min_free_slots_7d')
  // gleiche Lesart wie S1: slots < min_free_slots_7d ist „zu wenig“ (genau der Wert ist genug)
  check(d3({ D3: { min_free_slots_7d: 5 } }, 5) === 0 && d3({ D3: { min_free_slots_7d: 5 } }, 4) === 1, 'D3: slots == Wert meldet nicht, slots < Wert meldet')
  const s1SlotSperre = slots => {
    const c = basis(); s1Gut(c); c.freie_slots_7d = slots
    return lauf(c).hinweise.some(h => h.rule_key === 'S1' && (h.details?.sperren ?? []).includes('slots'))
  }
  check(!s1SlotSperre(10) && s1SlotSperre(9), 'S1: slots == min_free_slots_7d (10) sperrt nicht, 9 sperrt')
})
test('Startwerte: STOPP/SCHUTZ global (Rückfallkurs, Tracking-Wächter, Kampagnentag)', () => {
  // kurs_fallback_usd_je_eur aus der STOPP-Zeile bzw. aus RegelKontext.parameter
  const c = basis()
  c.rules = seedRules()
  c.rules.find(r => r.rule_key === 'STOPP').params = { ...SEED.STOPP, kurs_fallback_usd_je_eur: 1.25 }
  c.fx = { usd_per_eur: null, mittel_7d: null }
  let e = lauf(c)
  check(e.info.usd_per_eur === 1.25 && e.stopps.some(s => s.code === 'kurs_fehlt'), `Rückfallkurs ${e.info.usd_per_eur}`)
  const c1 = basis()
  c1.fx = { usd_per_eur: null, mittel_7d: null }
  c1.parameter = { kurs_fallback_usd_je_eur: 1.2 }
  check(lauf(c1).info.usd_per_eur === 1.2, 'Rückfallkurs über parameter')
  // Tracking-Wächter: Hinweis, nie Stopp
  const tr = (stundenSeit, param) => {
    const x = basis()
    x.rules = seedRules()
    if (param != null) x.rules.find(r => r.rule_key === 'STOPP').params = { ...SEED.STOPP, tracking_stunden_ohne_termin: param }
    x.tracking = { letzter_meta_termin: stundenSeit == null ? null : vor(stundenSeit), geprueft_ab: vor(14 * 24) }
    return lauf(x)
  }
  e = tr(50)
  check(hs(e, 'tracking_luecke').length === 1 && e.stopps.length === 0, 'Tracking 50 h > 48 h: Hinweis, kein Stopp')
  check(hs(tr(50, 72), 'tracking_luecke').length === 0, 'tracking_stunden_ohne_termin 72 wirkt')
  check(hs(tr(10), 'tracking_luecke').length === 0 && hs(tr(null), 'tracking_luecke').length === 1, 'Tracking frisch / ohne Termin')
  check(hs(lauf(basis()), 'tracking_luecke').length === 0, 'ohne Tracking-Eingabe keine Prüfung')
  // SCHUTZ neue_anzeigen_ab_kampagnentag über parameter (deutscher Name)
  const k = basis()
  setSnap(k, 'ad', 'A2', { frequency_7d: 3.4 })
  setSnap(k, 'campaign', 'C1', { created_time: vor(5 * 24) })
  check(vs(lauf(k), { aktion: 'ersatz_aktivieren' }).length === 0, 'Kampagne Tag 6 < 8: kein Ersatz')
  k.parameter = { neue_anzeigen_ab_kampagnentag: 5 }
  check(vs(lauf(k), { aktion: 'ersatz_aktivieren' }).length === 1, 'neue_anzeigen_ab_kampagnentag 5 wirkt')
})

test('now wird nie aus der Uhr genommen', () => {
  const c = basis()
  delete c.now
  let fehler = false
  try { lauf(c) } catch { fehler = true }
  check(fehler, 'ohne now muss die Engine abbrechen')
})

if (fails.length) {
  console.error(`verify-werbe-regeln: ${fails.length} von ${checked} Prüfungen FEHLGESCHLAGEN`)
  for (const f of fails.slice(0, 60)) console.error('  - ' + f)
  process.exit(1)
}
console.log(`verify-werbe-regeln: ${checked} Prüfungen ok`)
