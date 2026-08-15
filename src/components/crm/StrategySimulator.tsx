import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'
import { DEFAULT_PARAMS, compute, type CalcParams, type CalcResult } from '../../lib/rechner'

// ── Strategie-Simulator ──────────────────────────────────────────────────────
// Zusatz ÜBER den Einzelrechnungen (Sven 15.8.26): rechnet je Wohnung mit der
// verifizierten Rechner-Engine (rechner.ts - dieselbe wie die Kundenrechnungen,
// Annuitätendarlehen, Kurz-/Langzeit inkl. MwSt-Erstattung, Steuern CY/DE) und
// legt die Ergebnisse auf eine echte Zeitachse (Kauf- und Übergabe-Monat/Jahr).
// Kaufphase (Zahlungsplan, EK-Verteilung beim Bundlekauf) simuliert die
// Strategie-Schicht; ab Übergabe übernimmt die Engine. Szenario wird je Lead
// in crm_strategy_scenarios gesichert.

export interface SimUnit {
  key: string
  name: string
  priceNet: number            // Listenpreis netto (Engine rechnet MwSt/brutto)
  furnNet: number             // Möbelpaket netto
  rent: number                // Miete/Monat (brutto-Basis) → Engine-Rendite
  letType: 'short' | 'long'   // Kurzzeit (MwSt-Erstattung) / Langzeit
  fin: boolean                // Annuitätendarlehen ja/nein
  buyM: number; buyY: number      // Kauf Monat/Jahr
  readyM: number; readyY: number  // Übergabe Monat/Jahr (= Mietstart)
  plan: 'sofort' | 'luma'
}

interface SimParams {
  ek: number; growth: number; interest: number; termYears: number
  rentGrowth: number; deTaxPct: number; bundle: boolean
}
interface UnitOutcome {
  unit: SimUnit; res: CalcResult; ekUsed: number; loan: number
  gross: number; payments: Array<{ ym: number; amount: number; label: string }>
}

const eur = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' €'
const pct = (n: number) => (isFinite(n) ? n.toFixed(1).replace('.', ',') : '0') + ' %'
const ymOf = (y: number, m: number) => y * 12 + (m - 1)
const now = new Date()
const NOW_YM = ymOf(now.getFullYear(), now.getMonth() + 1)
const MONTH_OPTS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1).padStart(2, '0') }))
const YEAR_OPTS = Array.from({ length: 12 }, (_, i) => ({ value: String(now.getFullYear() + i), label: String(now.getFullYear() + i) }))

function paymentPlan(u: SimUnit, gross: number): Array<{ ym: number; amount: number; label: string }> {
  const buy = ymOf(u.buyY, u.buyM), ready = Math.max(buy, ymOf(u.readyY, u.readyM))
  if (u.plan === 'sofort') return [{ ym: buy, amount: gross, label: 'Kaufpreis komplett' }]
  const span = Math.max(1, ready - buy)
  return [
    { ym: buy, amount: 10000, label: 'Reservierung' },
    { ym: buy, amount: gross * 0.35 - 10000, label: '35 % bei Vertrag' },
    { ym: Math.round(buy + span * 0.33), amount: gross * 0.20, label: '2. Rate 20 %' },
    { ym: Math.round(buy + span * 0.62), amount: gross * 0.20, label: '3. Rate 20 %' },
    { ym: Math.round(buy + span * 0.85), amount: gross * 0.15, label: '4. Rate 15 %' },
    { ym: ready, amount: gross * 0.10, label: '10 % bei Übergabe' },
  ]
}

// Engine-Lauf je Wohnung: verankert an der ÜBERGABE (ab da Miete/Annuität/
// Steuern/MwSt-Erstattung) - identische Semantik wie die Einzelrechnung.
function runUnit(u: SimUnit, ekForUnit: number, p: SimParams): UnitOutcome {
  const params: CalcParams = {
    ...DEFAULT_PARAMS,
    month: u.readyM, year: u.readyY, dealType: 'single',
    priceNet: u.priceNet, discountPct: 0, bedrooms: 2,
    fin: u.fin ? 'yes' : 'no', letType: u.letType, mode: 'ann', res: 'de',
    hotelConcept: false,
    equity: ekForUnit,
    yieldPct: u.priceNet > 0 ? (u.rent * 12) / Math.round(u.priceNet * 1.19) * 100 : 0,
    rentGrowth: p.rentGrowth, interestPct: p.interest, termYears: p.termYears,
    appreciationPct: p.growth, deTaxPct: p.deTaxPct,
    furnCost: u.furnNet, furnFree: false, season: null,
  }
  const res = compute(params)
  const gross = res.pGross + res.furnGross
  return { unit: u, res, ekUsed: res.ekStart, loan: res.loan, gross, payments: paymentPlan(u, gross) }
}

// Bundlekauf: EK in ÜBERGABE-Reihenfolge verteilen. Erste Wohnung bekommt EK
// bis zu ihrem Gesamtpreis, die nächste den Rest usw.; was fehlt, finanziert
// die Engine als Annuitätendarlehen ab Übergabe.
function allocate(units: SimUnit[], p: SimParams): UnitOutcome[] {
  const order = [...units].sort((a, b) => ymOf(a.readyY, a.readyM) - ymOf(b.readyY, b.readyM))
  let pool = p.ek
  const out = new Map<string, UnitOutcome>()
  for (const u of order) {
    const probe = runUnit(u, 0, p)                     // Gesamtpreis brutto ermitteln
    const ekForUnit = p.bundle ? Math.min(pool, probe.gross) : Math.min(p.ek / Math.max(1, units.length), probe.gross)
    pool -= ekForUnit
    out.set(u.key, u.fin ? runUnit(u, ekForUnit, p) : runUnit(u, probe.gross, p))
  }
  return units.map(u => out.get(u.key)!)
}

// Kalender-Aggregation: Engine-Jahresreihen (ab Übergabejahr) + Kaufphase.
interface YearRow {
  year: number; rents: number; mgmt: number; interest: number; principal: number
  taxes: number; vat: number; cashflow: number; invest: number; debt: number; value: number
}
function aggregate(outcomes: UnitOutcome[]): { rows: YearRow[]; firstYear: number } {
  if (!outcomes.length) return { rows: [], firstYear: now.getFullYear() }
  const firstYear = Math.min(...outcomes.map(o => o.unit.buyY))
  const lastYear = Math.max(...outcomes.map(o => o.unit.readyY + 9))
  const rows: YearRow[] = []
  for (let y = firstYear; y <= lastYear; y++) {
    const row: YearRow = { year: y, rents: 0, mgmt: 0, interest: 0, principal: 0, taxes: 0, vat: 0, cashflow: 0, invest: 0, debt: 0, value: 0 }
    for (const o of outcomes) {
      const i = y - o.unit.readyY
      if (i >= 0 && i < 10) {
        row.rents += o.res.rents[i]; row.mgmt += o.res.mgmt[i]
        row.interest += o.res.intC[i]; row.principal += o.res.princC[i]
        row.taxes += o.res.taxU[i]; row.vat += o.res.vatA[i]; row.cashflow += o.res.cfA[i]
        row.debt += o.res.restL[i]; row.value += o.res.propV[i]
      } else if (i >= 10) {
        row.debt += o.res.restL[9]; row.value += o.res.propV[9]
      }
      for (const pay of o.payments) if (Math.floor(pay.ym / 12) === y) row.invest += pay.amount
    }
    rows.push(row)
  }
  return { rows, firstYear }
}

interface PickProject { id: string; name: string; furniture_cost: number | null; furniture_included: boolean | null; completion_date: string | null; calc_defaults: { furniture_by_bedrooms?: Record<string, number> } | null }
interface PickUnit { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; price_net: number | null }

export default function StrategySimulator({ lead, initialUnits, onClose }: {
  lead: { id: string; first_name: string; last_name: string } | null
  initialUnits: SimUnit[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [units, setUnits] = useState<SimUnit[]>(initialUnits)
  const [params, setParams] = useState<SimParams>({ ek: 350000, growth: 5, interest: 4.1, termYears: 20, rentGrowth: 2, deTaxPct: 42, bundle: true })
  const [loaded, setLoaded] = useState(initialUnits.length > 0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [projects, setProjects] = useState<PickProject[]>([])
  const [pickProject, setPickProject] = useState('')
  const [pickUnits, setPickUnits] = useState<PickUnit[]>([])
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const freeCounter = useRef(0)

  // Gespeichertes Szenario laden, wenn der Wizard nichts mitgibt
  useEffect(() => { void (async () => {
    if (initialUnits.length > 0 || !lead) { setLoaded(true); return }
    try {
      const { data } = await supabase.from('crm_strategy_scenarios').select('config').eq('lead_id', lead.id).maybeSingle()
      const cfg = (data as { config?: { unitsV2?: SimUnit[]; paramsV2?: SimParams } } | null)?.config
      if (cfg?.unitsV2?.length) { setUnits(cfg.unitsV2); if (cfg.paramsV2) setParams(cfg.paramsV2) }
    } catch (err) { console.error('[StrategySimulator] load:', err) }
    setLoaded(true)
  })() }, [initialUnits.length, lead])

  // Szenario je Lead sichern (entprellt)
  useEffect(() => {
    if (!loaded || !lead) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void supabase.from('crm_strategy_scenarios')
        .upsert({ lead_id: lead.id, config: { unitsV2: units, paramsV2: params }, updated_at: new Date().toISOString() }, { onConflict: 'lead_id' })
        .then(({ error }) => { if (error) console.warn('[StrategySimulator] save:', error.message) })
    }, 800)
    return () => clearTimeout(saveTimer.current)
  }, [units, params, loaded, lead])

  useEffect(() => { void (async () => {
    if (!pickerOpen || projects.length) return
    const { data } = await supabase.from('crm_projects').select('id, name, furniture_cost, furniture_included, completion_date, calc_defaults').order('name')
    setProjects((data ?? []) as PickProject[])
  })() }, [pickerOpen, projects.length])

  useEffect(() => { void (async () => {
    setPickUnits([])
    if (!pickProject) return
    try {
      const [{ data }, { data: dealRows }] = await Promise.all([
        supabase.from('crm_project_units').select('id, unit_number, bedrooms, size_sqm, price_net')
          .eq('project_id', pickProject).not('status', 'in', '(sold,reserved)').is('property_id', null).gt('price_net', 0).order('unit_number'),
        supabase.from('deals').select('unit_id').is('archived_from_phase', null).neq('phase', 'deal_verloren').not('unit_id', 'is', null),
      ])
      const taken = new Set((dealRows ?? []).map(d => (d as { unit_id: string }).unit_id))
      setPickUnits((data ?? []).filter(u => !taken.has((u as { id: string }).id)) as PickUnit[])
    } catch (err) { console.error('[StrategySimulator] units:', err) }
  })() }, [pickProject])

  const patchUnit = (key: string, patch: Partial<SimUnit>) =>
    setUnits(us => us.map(u => u.key === key ? { ...u, ...patch } : u))

  const addFromStock = (u: PickUnit) => {
    const proj = projects.find(p => p.id === pickProject)
    if (!proj || units.some(x => x.key === u.id)) return
    const furnByBed = proj.calc_defaults?.furniture_by_bedrooms ?? null
    const furnNet = proj.furniture_included ? 0
      : (furnByBed && u.bedrooms != null && furnByBed[String(u.bedrooms)] != null
        ? Number(furnByBed[String(u.bedrooms)]) : (proj.furniture_cost ?? 0))
    const done = proj.completion_date ? new Date(proj.completion_date) : null
    const readyY = done && !isNaN(done.getTime()) ? Math.max(now.getFullYear(), done.getFullYear()) : now.getFullYear() + 2
    const readyM = done && !isNaN(done.getTime()) ? done.getMonth() + 1 : 6
    const gross = Math.round(((u.price_net ?? 0) + furnNet) * 1.19)
    setUnits(us => [...us, {
      key: u.id, name: `${proj.name} ${u.unit_number}`,
      priceNet: u.price_net ?? 0, furnNet,
      rent: Math.round(gross * 0.055 / 12), letType: 'short', fin: true,
      buyM: now.getMonth() + 1, buyY: now.getFullYear(), readyM, readyY,
      plan: ymOf(readyY, readyM) - NOW_YM > 2 ? 'luma' : 'sofort',
    }])
    setPickerOpen(false); setPickProject('')
  }

  const addFree = () => {
    freeCounter.current += 1
    setUnits(us => [...us, {
      key: `frei-${Date.now()}-${freeCounter.current}`, name: `${t('crm.sim.unit', 'Wohnung')} ${us.length + 1}`,
      priceNet: 250000, furnNet: 19000, rent: 1300, letType: 'short', fin: true,
      buyM: now.getMonth() + 1, buyY: now.getFullYear(), readyM: 6, readyY: now.getFullYear() + 2, plan: 'luma',
    }])
    setPickerOpen(false)
  }

  const outcomes = useMemo(() => units.length ? allocate(units, params) : [], [units, params])
  const agg = useMemo(() => aggregate(outcomes), [outcomes])

  // Gesamt-Kennzahlen über den Horizont
  const totals = useMemo(() => {
    const sum = (f: (r: YearRow) => number) => agg.rows.reduce((a, r) => a + f(r), 0)
    const ekTotal = outcomes.reduce((a, o) => a + o.ekUsed, 0)
    const last = agg.rows[agg.rows.length - 1]
    const netWorth = last ? last.value - last.debt : 0
    const rents = sum(r => r.rents), taxes = sum(r => r.taxes), vat = sum(r => r.vat)
    const interest = sum(r => r.interest), cashflow = sum(r => r.cashflow)
    const totalReturn = netWorth - ekTotal + cashflow
    const roe = ekTotal > 0 ? (totalReturn / ekTotal) * 100 : 0
    return { ekTotal, netWorth, rents, taxes, vat, interest, cashflow, totalReturn, roe }
  }, [agg, outcomes])

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300'
  const lbl = 'block text-[11px] text-gray-500 mb-0.5'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl my-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">📈 {t('crm.sim.title', 'Strategie-Simulator')}</h2>
            <p className="text-xs text-gray-400">
              {lead ? `${lead.first_name} ${lead.last_name} · ` : ''}
              {t('crm.sim.subtitle2', 'Zeitachse über mehrere Käufe - gerechnet mit derselben Engine wie die Einzelrechnungen (Annuität, Kurz-/Langzeit, Steuern, MwSt).')}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Annahmen */}
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
              {([
                ['ek', t('crm.sim.equity', 'Eigenkapital (€)'), 10000],
                ['growth', t('crm.sim.growth', 'Wertsteigerung % p.a.'), 0.5],
                ['interest', t('crm.sim.interest2', 'Darlehenszins % p.a.'), 0.1],
                ['termYears', t('crm.sim.term', 'Laufzeit Annuität (J.)'), 1],
                ['rentGrowth', t('crm.sim.rentGrowth', 'Mietsteigerung % p.a.'), 0.5],
                ['deTaxPct', t('crm.sim.deTax', 'DE-Steuersatz %'), 1],
              ] as Array<[keyof SimParams, string, number]>).map(([k, label, step]) => (
                <div key={k}>
                  <label className={lbl}>{label}</label>
                  <input type="number" step={step} className={inputCls} value={params[k] as number}
                    onChange={e => setParams(p => ({ ...p, [k]: +e.target.value }))} />
                </div>
              ))}
            </div>
            <label className="flex items-start gap-2 cursor-pointer mt-3">
              <input type="checkbox" checked={params.bundle} onChange={e => setParams(p => ({ ...p, bundle: e.target.checked }))}
                className="w-4 h-4 accent-orange-500 mt-0.5" />
              <span className="text-sm text-gray-700">
                <strong>{t('crm.sim.bundle', 'Bundlekauf: Eigenkapital automatisch verteilen')}</strong>
                <span className="block text-xs text-gray-400">
                  {t('crm.sim.bundleHint2', 'EK fließt in Übergabe-Reihenfolge; was fehlt, läuft je Wohnung als Annuitätendarlehen ab Übergabe.')}
                </span>
              </span>
            </label>
          </div>

          {/* Wohnungen */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {units.map(u => {
              const o = outcomes.find(x => x.unit.key === u.key)
              return (
                <div key={u.key} className="border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <input className="font-semibold text-sm text-gray-900 bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-orange-300 rounded px-1 -mx-1 flex-1"
                      value={u.name} onChange={e => patchUnit(u.key, { name: e.target.value })} />
                    <button onClick={() => setUnits(us => us.filter(x => x.key !== u.key))}
                      className="text-gray-300 hover:text-red-500 ml-2">✕</button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <div>
                      <label className={lbl}>{t('crm.sim.priceNet', 'Preis netto (€)')}</label>
                      <input type="number" step={5000} className={inputCls} value={Math.round(u.priceNet)}
                        onChange={e => patchUnit(u.key, { priceNet: +e.target.value })} />
                    </div>
                    <div>
                      <label className={lbl}>{t('crm.sim.furnNet', 'Möbel netto (€)')}</label>
                      <input type="number" step={1000} className={inputCls} value={Math.round(u.furnNet)}
                        onChange={e => patchUnit(u.key, { furnNet: +e.target.value })} />
                    </div>
                    <div>
                      <label className={lbl}>{t('crm.sim.rent', 'Miete/Monat (€)')}</label>
                      <input type="number" step={50} className={inputCls} value={Math.round(u.rent)}
                        onChange={e => patchUnit(u.key, { rent: +e.target.value })} />
                    </div>
                    <div>
                      <label className={lbl}>{t('crm.sim.letType', 'Vermietung')}</label>
                      <CustomSelect value={u.letType}
                        onChange={v => patchUnit(u.key, { letType: v as 'short' | 'long' })}
                        options={[{ value: 'short', label: t('crm.sim.letShort', 'Kurzzeit (MwSt-Erstattung)') },
                          { value: 'long', label: t('crm.sim.letLong', 'Langzeit') }]} />
                    </div>
                    <div>
                      <label className={lbl}>{t('crm.sim.finance', 'Finanzierung')}</label>
                      <CustomSelect value={u.fin ? 'yes' : 'no'}
                        onChange={v => patchUnit(u.key, { fin: v === 'yes' })}
                        options={[{ value: 'yes', label: t('crm.sim.finYes', 'Annuitätendarlehen') },
                          { value: 'no', label: t('crm.sim.finNo', 'ohne (nur EK)') }]} />
                    </div>
                    <div>
                      <label className={lbl}>{t('crm.sim.plan', 'Zahlungsplan')}</label>
                      <CustomSelect value={u.plan}
                        onChange={v => patchUnit(u.key, { plan: v as 'sofort' | 'luma' })}
                        options={[{ value: 'sofort', label: t('crm.sim.planNow', 'Alles bei Kauf') },
                          { value: 'luma', label: t('crm.sim.planLuma', '10k → 35/20/20/15/10') }]} />
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <label className={lbl}>{t('crm.sim.buyDate', 'Kauf (Monat/Jahr)')}</label>
                      <div className="flex gap-1">
                        <CustomSelect value={String(u.buyM)} onChange={v => patchUnit(u.key, { buyM: +v })} options={MONTH_OPTS} className="w-1/2" />
                        <CustomSelect value={String(u.buyY)} onChange={v => patchUnit(u.key, { buyY: +v })} options={YEAR_OPTS} className="w-1/2" />
                      </div>
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <label className={lbl}>{t('crm.sim.readyDate', 'Übergabe + Mietstart (Monat/Jahr)')}</label>
                      <div className="flex gap-1">
                        <CustomSelect value={String(u.readyM)} onChange={v => patchUnit(u.key, { readyM: +v })} options={MONTH_OPTS} className="w-1/2" />
                        <CustomSelect value={String(u.readyY)} onChange={v => patchUnit(u.key, { readyY: +v })} options={YEAR_OPTS} className="w-1/2" />
                      </div>
                    </div>
                  </div>
                  {o && (
                    <p className="text-[11px] text-gray-400 mt-2">
                      {t('crm.sim.unitLine', 'Gesamt brutto')} {eur(o.gross)} · EK {eur(o.ekUsed)}
                      {o.loan > 0 ? ` · ${t('crm.sim.loan', 'Darlehen')} ${eur(o.loan)} (${t('crm.sim.annuity', 'Annuität')} ${eur(o.res.mRate)}/M.)` : ''}
                      {' · '}{t('crm.sim.roe', 'EK-Rendite 10 J.')} {pct(o.res.roe10)}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Hinzufügen */}
          {pickerOpen ? (
            <div className="border border-dashed border-gray-300 rounded-xl p-3 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <CustomSelect value={pickProject} onChange={setPickProject}
                  options={[{ value: '', label: t('crm.sim.pickProject', 'Projekt wählen…') },
                    ...projects.map(p => ({ value: p.id, label: p.name }))]} />
                <div className="flex gap-2">
                  <button onClick={addFree} className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 text-gray-600 hover:bg-gray-50">
                    {t('crm.sim.addFree', 'frei eingeben')}
                  </button>
                  <button onClick={() => { setPickerOpen(false); setPickProject('') }}
                    className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-600">
                    {t('common.cancel', 'Abbrechen')}
                  </button>
                </div>
              </div>
              {pickUnits.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-44 overflow-y-auto">
                  {pickUnits.map(u => (
                    <button key={u.id} onClick={() => addFromStock(u)} disabled={units.some(x => x.key === u.id)}
                      className="text-left border border-gray-200 rounded-lg px-3 py-1.5 text-sm hover:border-orange-300 hover:bg-orange-50 disabled:opacity-40">
                      <strong>{u.unit_number}</strong> · {u.bedrooms ?? '?'} SZ · {u.size_sqm ?? '?'} m² · {eur(u.price_net ?? 0)} netto
                    </button>
                  ))}
                </div>
              )}
              {pickProject && pickUnits.length === 0 && (
                <p className="text-xs text-gray-400">{t('crm.sim.noUnits', 'Keine anbietbaren Wohnungen in diesem Projekt.')}</p>
              )}
            </div>
          ) : (
            <button onClick={() => setPickerOpen(true)}
              className="px-4 py-2 rounded-xl text-sm border border-dashed border-gray-300 text-gray-600 hover:bg-gray-50">
              + {t('crm.sim.addUnit', 'Wohnung hinzufügen')}
            </button>
          )}

          {outcomes.length > 0 && (<>
            {/* EK-Verteilung */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('crm.sim.ekTitle', 'Eigenkapital-Verteilung')}</p>
              <div className="border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                    <th className="px-3 py-2">{t('crm.sim.unit', 'Wohnung')}</th>
                    <th className="px-3 py-2">{t('crm.sim.readyShort', 'Übergabe')}</th>
                    <th className="px-3 py-2">{t('crm.sim.fromEk', 'aus Eigenkapital')}</th>
                    <th className="px-3 py-2">{t('crm.sim.financed', 'Annuitätendarlehen')}</th>
                    <th className="px-3 py-2">{t('crm.sim.roeShort', 'EK-Rendite 10 J.')}</th>
                  </tr></thead>
                  <tbody>
                    {outcomes.map(o => (
                      <tr key={o.unit.key} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-2"><strong>{o.unit.name}</strong><span className="block text-xs text-gray-400">{eur(o.gross)} {t('crm.sim.total', 'gesamt')}</span></td>
                        <td className="px-3 py-2 tabular-nums">{String(o.unit.readyM).padStart(2, '0')}/{o.unit.readyY}</td>
                        <td className="px-3 py-2 text-green-700 font-semibold">{eur(o.ekUsed)}</td>
                        <td className="px-3 py-2 text-amber-700 font-semibold">{o.loan > 0 ? eur(o.loan) : '–'}</td>
                        <td className="px-3 py-2">{pct(o.res.roe10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Gesamt-KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                { l: t('crm.sim.ekTotal', 'Eigenkapital gesamt'), v: eur(totals.ekTotal), d: t('crm.sim.overAll', 'über alle Käufe') },
                { l: t('crm.sim.netWorthEnd', 'Netto-Vermögen am Ende'), v: eur(totals.netWorth), d: t('crm.sim.valueMinusDebt', 'Wert abzgl. Restschuld'), hero: true },
                { l: t('crm.sim.rents', 'Mieten kumuliert'), v: eur(totals.rents), d: `${t('crm.sim.interestPaid', 'Zinsen')} −${eur(totals.interest)}` },
                { l: t('crm.sim.taxesTotal', 'Steuern gesamt'), v: `${totals.taxes >= 0 ? '−' : '+'}${eur(Math.abs(totals.taxes))}`, d: `${t('crm.sim.vatBack', 'MwSt-Erstattung')} +${eur(totals.vat)}` },
                { l: t('crm.sim.roeTotal', 'EK-Rendite gesamt'), v: pct(totals.roe), d: t('crm.sim.roeHint', 'Gesamtertrag auf eingesetztes EK') },
              ].map(k => (
                <div key={k.l} className={`rounded-xl border p-3 ${k.hero ? 'border-orange-300' : 'border-gray-200'}`}>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">{k.l}</p>
                  <p className={`text-lg font-bold ${k.hero ? 'text-orange-600' : 'text-gray-900'}`}>{k.v}</p>
                  <p className="text-[11px] text-gray-400">{k.d}</p>
                </div>
              ))}
            </div>

            {/* Jahres-Tabelle: die komplette Rechnung auf der Zeitachse */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('crm.sim.yearTable', 'Verlauf je Jahr (alle Wohnungen zusammen)')}</p>
              <div className="border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                    <th className="px-2 py-2">{t('crm.sim.year', 'Jahr')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colInvest', 'Kaufraten')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colRents', 'Mieten')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colMgmt', 'Verwaltung')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colInterest', 'Zinsen')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colPrincipal', 'Tilgung')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colTaxes', 'Steuern')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colVat', 'MwSt-Erst.')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colCashflow', 'Cashflow')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colDebt', 'Restschuld')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colWorth', 'Netto-Vermögen')}</th>
                  </tr></thead>
                  <tbody>
                    {agg.rows.map(r => (
                      <tr key={r.year} className="border-b border-gray-50 last:border-0">
                        <td className="px-2 py-1.5 font-semibold">{r.year}</td>
                        <td className="px-2 py-1.5 text-right text-orange-600">{r.invest ? `−${eur(r.invest)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right text-green-700">{r.rents ? eur(r.rents) : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.mgmt ? `−${eur(r.mgmt)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.interest ? `−${eur(r.interest)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.principal ? `−${eur(r.principal)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.taxes ? `−${eur(r.taxes)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right text-green-700">{r.vat ? `+${eur(r.vat)}` : ''}</td>
                        <td className={`px-2 py-1.5 text-right font-semibold ${r.cashflow >= 0 ? 'text-green-700' : 'text-amber-700'}`}>{r.rents || r.cashflow ? eur(r.cashflow) : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.debt ? eur(r.debt) : ''}</td>
                        <td className="px-2 py-1.5 text-right font-semibold">{r.value ? eur(r.value - r.debt) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[11px] text-gray-400">
              {t('crm.sim.engineNote', 'Gerechnet mit der Engine der Einzelrechnungen: Annuitätendarlehen ab Übergabe, Miete/Steuern (Steuersitz DE) ab Übergabe, MwSt-Erstattung bei Kurzzeitvermietung nach 24 Monaten. Kaufraten laufen vor der Übergabe aus dem Eigenkapital. Die Einzelrechnungen für den Kunden erstellst du wie gewohnt über den Haken "Mit Rendite-Berechnung" - gleiche Zahlen, gleiche Engine.')}
            </p>
          </>)}
          {units.length === 0 && (
            <p className="text-sm text-gray-400">{t('crm.sim.empty', 'Noch keine Wohnungen im Szenario - oben hinzufügen.')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
