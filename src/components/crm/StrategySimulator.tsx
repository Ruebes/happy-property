import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'

// ── Strategie-Simulator ──────────────────────────────────────────────────────
// Langfrist-Plan fürs Kundengespräch, geöffnet aus dem Deck-Wizard (Haken
// „Strategie-Simulator"): startet mit den dort gewählten Wohnungen, weitere
// lassen sich aus dem Bestand oder frei hinzufügen. Rechnet monatsweise über
// 10 Jahre: Zahlungspläne, Mieten ab Übergabe, Beleihung, Bundlekauf-Logik
// (EK in Übergabe-Reihenfolge verteilen, offener Rest = Finanzierungsbedarf).
// Szenario wird je Lead in crm_strategy_scenarios gesichert.

export interface SimUnit {
  key: string                 // stabil für React (unit-id oder frei-N)
  name: string
  price: number               // Gesamtpreis brutto inkl. Möbel
  vat: 5 | 19
  netBase: number | null      // netto inkl. Möbel — gesetzt, solange Preis an Auswahl gekoppelt
  rent: number                // Miete/Monat netto
  buyM: number                // Kaufmonat (0 = jetzt)
  readyM: number              // Übergabe + Mietstart (Monat)
  plan: 'sofort' | 'luma'
  mortgage: boolean           // bei Übergabe beleihen
}

interface SimParams { ek: number; growth: number; ltv: number; interest: number; rentGrowth: number; bundle: boolean }
interface SimEvent { m: number; kind: 'kauf' | 'miete' | 'kredit'; text: string }
interface SimResult {
  series: { net: number[]; value: number[]; debt: number[]; cash: number[] }
  events: SimEvent[]
  alloc: Array<{ ek: number; inflow: number; loan: number }>
  rentTotal: number; interestTotal: number
  low: { m: number; v: number }
}

const MONTHS = 120
const eur = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' €'

function paymentPlan(u: SimUnit): Array<{ m: number; amount: number; label: string }> {
  if (u.plan === 'sofort') return [{ m: u.buyM, amount: u.price, label: 'Kaufpreis komplett' }]
  const span = Math.max(1, u.readyM - u.buyM)
  return [
    { m: u.buyM, amount: 10000, label: 'Reservierung' },
    { m: u.buyM, amount: u.price * 0.35 - 10000, label: '35 % bei Vertrag' },
    { m: Math.round(u.buyM + span * 0.33), amount: u.price * 0.20, label: '2. Rate 20 %' },
    { m: Math.round(u.buyM + span * 0.62), amount: u.price * 0.20, label: '3. Rate 20 %' },
    { m: Math.round(u.buyM + span * 0.85), amount: u.price * 0.15, label: '4. Rate 15 %' },
    { m: u.readyM, amount: u.price * 0.10, label: '10 % bei Übergabe · Title Deeds' },
  ]
}

// Monatsweise Simulation. Attribution je Wohnung: erst Eigenkapital-Topf, dann
// Zuflüsse (Mieten + Beleihungen); was übrig bleibt, wird im Bundle-Modus als
// Darlehen aufgenommen (endfällig, nur Zins) — ohne Bundle bleibt es als
// Konto-Lücke sichtbar.
function simulate(units: SimUnit[], p: SimParams): SimResult {
  const wMon = Math.pow(1 + p.growth / 100, 1 / 12)
  let cash = p.ek, ekPool = p.ek, inflowPool = 0
  const loans = units.map(() => 0)
  const alloc = units.map(() => ({ ek: 0, inflow: 0, loan: 0 }))
  const events: SimEvent[] = []
  const series = { net: [] as number[], value: [] as number[], debt: [] as number[], cash: [] as number[] }
  let rentTotal = 0, interestTotal = 0
  const low = { m: -1, v: Infinity }
  const plans = units.map(u => paymentPlan(u))

  const pay = (i: number, amount: number, label: string, m: number) => {
    let rest = amount
    const fromEk = Math.min(rest, Math.max(0, ekPool)); ekPool -= fromEk; alloc[i].ek += fromEk; rest -= fromEk
    const fromIn = Math.min(rest, Math.max(0, inflowPool)); inflowPool -= fromIn; alloc[i].inflow += fromIn; rest -= fromIn
    cash -= amount
    events.push({ m, kind: 'kauf', text: `${units[i].name}: ${label} · −${eur(amount)}` })
    if (rest > 0.5 && p.bundle) {
      loans[i] += rest; cash += rest; alloc[i].loan += rest
      events.push({ m, kind: 'kredit', text: `${units[i].name}: Finanzierung nötig · +${eur(rest)} als Darlehen (${p.interest.toFixed(1).replace('.', ',')} % endfällig)` })
    }
  }

  for (let m = 0; m < MONTHS; m++) {
    units.forEach((_, i) => plans[i].forEach(r => { if (r.m === m) pay(i, r.amount, r.label, m) }))
    units.forEach((u, i) => {
      if (u.readyM === m) {
        events.push({ m, kind: 'miete', text: `${u.name}: Übergabe · vermietet ab jetzt (${eur(u.rent)}/Monat)` })
        if (u.mortgage) {
          const value = u.price * Math.pow(wMon, m - u.buyM)
          const credit = value * p.ltv / 100 - loans[i]
          if (credit > 0) {
            loans[i] += credit; cash += credit; inflowPool += credit
            events.push({ m, kind: 'kredit', text: `${u.name}: Beleihung ${Math.round(p.ltv)} % · +${eur(credit)} verfügbar` })
          }
        }
      }
    })
    units.forEach((u, i) => {
      if (m > u.readyM) {
        const rent = u.rent * Math.pow(1 + p.rentGrowth / 100, (m - u.readyM) / 12)
        cash += rent; inflowPool += rent; rentTotal += rent
      }
      if (loans[i] > 0) {
        const z = loans[i] * p.interest / 100 / 12
        cash -= z; interestTotal += z; inflowPool = Math.max(0, inflowPool - z)
      }
    })
    let value = 0
    units.forEach(u => { if (m >= u.buyM) value += u.price * Math.pow(wMon, m - u.buyM) })
    const debt = loans.reduce((a, b) => a + b, 0)
    series.net.push(value - debt + cash); series.value.push(value)
    series.debt.push(debt); series.cash.push(cash)
    if (cash < low.v) { low.v = cash; low.m = m }
  }
  return { series, events, alloc, rentTotal, interestTotal, low }
}

// ── Bestands-Auswahl (Projekt → Wohnung) ─────────────────────────────────────
interface PickProject { id: string; name: string; furniture_cost: number | null; furniture_included: boolean | null; completion_date: string | null }
interface PickUnit { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; price_net: number | null }

function monthsFromNow(iso: string | null): number | null {
  if (!iso) return null
  const d = new Date(iso); if (isNaN(d.getTime())) return null
  const now = new Date()
  return Math.max(0, (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth()))
}

function monthLabel(m: number): string {
  const d = new Date(); d.setMonth(d.getMonth() + m)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

export default function StrategySimulator({ lead, initialUnits, onClose }: {
  lead: { id: string; first_name: string; last_name: string } | null
  initialUnits: SimUnit[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [units, setUnits] = useState<SimUnit[]>(initialUnits)
  const [params, setParams] = useState<SimParams>({ ek: 350000, growth: 5, ltv: 60, interest: 4.5, rentGrowth: 2, bundle: true })
  const [loaded, setLoaded] = useState(initialUnits.length > 0)
  // Hinzufügen aus dem Bestand
  const [pickerOpen, setPickerOpen] = useState(false)
  const [projects, setProjects] = useState<PickProject[]>([])
  const [pickProject, setPickProject] = useState('')
  const [pickUnits, setPickUnits] = useState<PickUnit[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const freeCounter = useRef(0)

  // Gespeichertes Szenario laden, wenn der Wizard keine Wohnungen mitgibt.
  useEffect(() => { void (async () => {
    if (initialUnits.length > 0 || !lead) { setLoaded(true); return }
    try {
      const { data } = await supabase.from('crm_strategy_scenarios').select('config').eq('lead_id', lead.id).maybeSingle()
      const cfg = (data as { config?: { units?: SimUnit[]; params?: SimParams } } | null)?.config
      if (cfg?.units?.length) { setUnits(cfg.units); if (cfg.params) setParams(cfg.params) }
    } catch (err) { console.error('[StrategySimulator] load:', err) }
    setLoaded(true)
  })() }, [initialUnits.length, lead])

  // Szenario je Lead sichern (entprellt) — damit es im Gespräch wieder da ist.
  useEffect(() => {
    if (!loaded || !lead) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void supabase.from('crm_strategy_scenarios')
        .upsert({ lead_id: lead.id, config: { units, params }, updated_at: new Date().toISOString() }, { onConflict: 'lead_id' })
        .then(({ error }) => { if (error) console.warn('[StrategySimulator] save:', error.message) })
    }, 800)
    return () => clearTimeout(saveTimer.current)
  }, [units, params, loaded, lead])

  useEffect(() => { void (async () => {
    if (!pickerOpen || projects.length) return
    const { data } = await supabase.from('crm_projects').select('id, name, furniture_cost, furniture_included, completion_date').order('name')
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
    const netBase = (u.price_net ?? 0) + (proj.furniture_included ? 0 : (proj.furniture_cost ?? 0))
    const vat: 5 | 19 = 5
    const price = Math.round(netBase * (1 + vat / 100))
    const readyM = monthsFromNow(proj.completion_date) ?? 24
    setUnits(us => [...us, {
      key: u.id, name: `${proj.name} ${u.unit_number}`, price, vat, netBase,
      rent: Math.round(price * 0.055 / 12), buyM: 0, readyM,
      plan: readyM > 2 ? 'luma' : 'sofort', mortgage: false,
    }])
    setPickerOpen(false); setPickProject('')
  }

  const addFree = () => {
    freeCounter.current += 1
    setUnits(us => [...us, {
      key: `frei-${Date.now()}-${freeCounter.current}`, name: `${t('crm.sim.unit', 'Wohnung')} ${us.length + 1}`,
      price: 250000, vat: 5, netBase: null, rent: 1150, buyM: 0, readyM: 24, plan: 'luma', mortgage: false,
    }])
    setPickerOpen(false)
  }

  const result = useMemo(() => units.length ? simulate(units, params) : null, [units, params])

  // Verlaufs-Chart (Canvas, wie Statistik-Seiten: schlicht, vier Linien)
  const drawChart = useCallback(() => {
    const c = canvasRef.current; if (!c || !result) return
    const ctx = c.getContext('2d'); if (!ctx) return
    const W = c.width, H = c.height, padL = 74, padR = 14, padT = 14, padB = 32
    ctx.clearRect(0, 0, W, H)
    const s = result.series
    const all = [...s.net, ...s.value, ...s.cash, ...s.debt]
    const min = Math.min(0, ...all), max = Math.max(...all) * 1.06 || 1
    const x = (m: number) => padL + (W - padL - padR) * m / (MONTHS - 1)
    const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / (max - min))
    ctx.strokeStyle = '#e5e7eb'; ctx.fillStyle = '#9ca3af'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1
    for (let j = 0; j <= 10; j++) {
      const xx = x(j * 12)
      ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, H - padB); ctx.stroke()
      if (j % 2 === 0) ctx.fillText(`${t('crm.sim.year', 'Jahr')} ${j}`, xx - 14, H - 10)
    }
    ctx.textAlign = 'right'
    for (let i = 0; i <= 4; i++) {
      const v = min + (max - min) * i / 4, yy = y(v)
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke()
      ctx.fillText(new Intl.NumberFormat('de-DE', { notation: 'compact' }).format(v) + ' €', padL - 8, yy + 4)
    }
    ctx.textAlign = 'left'
    const line = (arr: number[], color: string, width: number, dash?: number[]) => {
      ctx.beginPath(); ctx.setLineDash(dash ?? [])
      arr.forEach((v, m) => { const xx = x(m), yy = y(v); m ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy) })
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([])
    }
    line(s.value, '#ff795d', 1.6)
    line(s.debt, '#b45309', 1.6)
    line(s.cash, '#2f9e6e', 1.6, [6, 4])
    line(s.net, '#1a2332', 3)
  }, [result, t])
  useEffect(() => { drawChart() }, [drawChart])

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300'
  const t5 = result?.series.net[59] ?? 0, t10 = result?.series.net[119] ?? 0
  const mortgageable = result ? Math.max(0, result.series.value[119] * params.ltv / 100 - result.series.debt[119]) : 0

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl my-4">
        {/* Kopf */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">📈 {t('crm.sim.title', 'Strategie-Simulator')}</h2>
            <p className="text-xs text-gray-400">
              {lead ? `${lead.first_name} ${lead.last_name} · ` : ''}{t('crm.sim.subtitle', '10-Jahres-Plan: Zahlungspläne, Mieten, Beleihung, Bundlekauf')}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Annahmen */}
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {([
                ['ek', t('crm.sim.equity', 'Eigenkapital (€)'), 10000],
                ['growth', t('crm.sim.growth', 'Wertsteigerung % p.a.'), 0.5],
                ['ltv', t('crm.sim.ltv', 'Beleihungsquote %'), 5],
                ['interest', t('crm.sim.interest', 'Darlehenszins % p.a.'), 0.1],
                ['rentGrowth', t('crm.sim.rentGrowth', 'Mietsteigerung % p.a.'), 0.5],
              ] as Array<[keyof SimParams, string, number]>).map(([k, label, step]) => (
                <div key={k}>
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>
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
                  {t('crm.sim.bundleHint', 'EK fließt in Übergabe-Reihenfolge; was offen bleibt, wird als Finanzierungsbedarf ausgewiesen und eingerechnet.')}
                </span>
              </span>
            </label>
          </div>

          {/* Wohnungen */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {units.map(u => (
              <div key={u.key} className="border border-gray-200 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <input className="font-semibold text-sm text-gray-900 bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-orange-300 rounded px-1 -mx-1 flex-1"
                    value={u.name} onChange={e => patchUnit(u.key, { name: e.target.value })} />
                  <button onClick={() => setUnits(us => us.filter(x => x.key !== u.key))}
                    className="text-gray-300 hover:text-red-500 ml-2">✕</button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-0.5">{t('crm.sim.price', 'Preis brutto inkl. Möbel')}</label>
                    <input type="number" step={5000} className={inputCls} value={Math.round(u.price)}
                      onChange={e => patchUnit(u.key, { price: +e.target.value, netBase: null })} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-0.5">{t('crm.sim.vat', 'MwSt')}</label>
                    <CustomSelect value={String(u.vat)}
                      onChange={v => {
                        const vat = (Number(v) === 19 ? 19 : 5) as 5 | 19
                        patchUnit(u.key, { vat, ...(u.netBase ? { price: Math.round(u.netBase * (1 + vat / 100)) } : {}) })
                      }}
                      options={[{ value: '5', label: '5 %' }, { value: '19', label: '19 %' }]} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-0.5">{t('crm.sim.rent', 'Miete/Monat (€)')}</label>
                    <input type="number" step={50} className={inputCls} value={Math.round(u.rent)}
                      onChange={e => patchUnit(u.key, { rent: +e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-0.5">{t('crm.sim.buyM', 'Kauf (Monat)')}</label>
                    <input type="number" min={0} max={100} className={inputCls} value={u.buyM}
                      onChange={e => patchUnit(u.key, { buyM: Math.max(0, +e.target.value) })} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-0.5">{t('crm.sim.readyM', 'Übergabe (Monat)')}</label>
                    <input type="number" min={0} max={119} className={inputCls} value={u.readyM}
                      onChange={e => patchUnit(u.key, { readyM: Math.max(0, +e.target.value) })} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-0.5">{t('crm.sim.plan', 'Zahlungsplan')}</label>
                    <CustomSelect value={u.plan}
                      onChange={v => patchUnit(u.key, { plan: v as 'sofort' | 'luma' })}
                      options={[{ value: 'sofort', label: t('crm.sim.planNow', 'Alles bei Kauf') },
                        { value: 'luma', label: t('crm.sim.planLuma', '10k → 35/20/20/15/10') }]} />
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer mt-2 text-xs text-gray-600">
                  <input type="checkbox" checked={u.mortgage} onChange={e => patchUnit(u.key, { mortgage: e.target.checked })}
                    className="w-3.5 h-3.5 accent-orange-500" />
                  {t('crm.sim.mortgage', 'bei Übergabe beleihen (endfällig)')}
                </label>
              </div>
            ))}
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

          {result && (<>
            {/* Warnung ohne Bundle */}
            {!params.bundle && result.low.v < -0.5 && (
              <div className="bg-orange-50 border border-orange-300 rounded-xl px-4 py-3 text-sm text-orange-900">
                ⚠️ {t('crm.sim.gap', 'Finanzierungslücke')}: {monthLabel(result.low.m)} {t('crm.sim.gapMissing', 'fehlen')} {eur(-result.low.v)}.
                {' '}{t('crm.sim.gapHint', 'Bundlekauf aktivieren, Kauf später ansetzen oder früher beleihen.')}
              </div>
            )}

            {/* EK-Verteilung */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('crm.sim.ekTitle', 'Eigenkapital-Verteilung')}</p>
              <div className="border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                    <th className="px-3 py-2">{t('crm.sim.unit', 'Wohnung')}</th>
                    <th className="px-3 py-2">{t('crm.sim.fromEk', 'aus Eigenkapital')}</th>
                    <th className="px-3 py-2">{t('crm.sim.fromInflow', 'aus Mieten & Beleihung')}</th>
                    <th className="px-3 py-2">{t('crm.sim.toFinance', 'zu finanzieren')}</th>
                  </tr></thead>
                  <tbody>
                    {units.map((u, i) => (
                      <tr key={u.key} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-2"><strong>{u.name}</strong><span className="block text-xs text-gray-400">{eur(u.price)} {t('crm.sim.total', 'gesamt')}</span></td>
                        <td className="px-3 py-2 text-green-700 font-semibold">{eur(result.alloc[i]?.ek ?? 0)}</td>
                        <td className="px-3 py-2">{eur(result.alloc[i]?.inflow ?? 0)}</td>
                        <td className="px-3 py-2 text-amber-700 font-semibold">{(result.alloc[i]?.loan ?? 0) > 0.5 ? eur(result.alloc[i].loan) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                { l: t('crm.sim.net5', 'Vermögen nach 5 J.'), v: eur(t5), d: `+${eur(t5 - params.ek)}` },
                { l: t('crm.sim.net10', 'Vermögen nach 10 J.'), v: eur(t10), d: `+${eur(t10 - params.ek)}`, hero: true },
                { l: t('crm.sim.rents', 'Mieten kumuliert'), v: eur(result.rentTotal), d: `${t('crm.sim.interestPaid', 'Zinsen')} −${eur(result.interestTotal)}` },
                { l: t('crm.sim.mortgageable', 'Beleihbar nach 10 J.'), v: eur(mortgageable), d: t('crm.sim.forNext', 'für den nächsten Kauf') },
                { l: t('crm.sim.cash10', 'Konto nach 10 J.'), v: eur(result.series.cash[119]), d: t('crm.sim.liquidity', 'Liquidität') },
              ].map(k => (
                <div key={k.l} className={`rounded-xl border p-3 ${k.hero ? 'border-orange-300' : 'border-gray-200'}`}>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">{k.l}</p>
                  <p className={`text-lg font-bold ${k.hero ? 'text-orange-600' : 'text-gray-900'}`}>{k.v}</p>
                  <p className="text-[11px] text-gray-400">{k.d}</p>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="border border-gray-200 rounded-xl p-3">
              <canvas ref={canvasRef} width={980} height={340} className="w-full h-auto" />
              <div className="flex flex-wrap gap-4 mt-2 text-[11px] text-gray-500">
                <span>⬛ {t('crm.sim.legendNet', 'Netto-Vermögen')}</span>
                <span className="text-orange-500">▬ {t('crm.sim.legendValue', 'Immobilienwert')}</span>
                <span className="text-amber-700">▬ {t('crm.sim.legendDebt', 'Schulden')}</span>
                <span className="text-green-700">▭ {t('crm.sim.legendCash', 'Konto')}</span>
              </div>
            </div>

            {/* Ereignisse */}
            <details className="border border-gray-200 rounded-xl p-3">
              <summary className="text-sm font-medium text-gray-700 cursor-pointer">
                {t('crm.sim.events', 'Ereignisse')} ({result.events.length})
              </summary>
              <ul className="mt-2 space-y-1 max-h-56 overflow-y-auto">
                {result.events.map((e, i) => (
                  <li key={i} className="text-xs grid grid-cols-[64px_1fr] gap-2">
                    <span className="text-gray-400 tabular-nums">{monthLabel(e.m)}</span>
                    <span className={e.kind === 'kauf' ? 'text-orange-600' : e.kind === 'miete' ? 'text-green-700' : 'text-amber-700'}>{e.text}</span>
                  </li>
                ))}
              </ul>
            </details>

            <p className="text-[11px] text-gray-400">
              {t('crm.sim.assumptions', 'Annahmen: Marktwert = Kaufpreis ab Kaufmonat mit monatlicher Wertsteigerung; Mieten ab Übergabe; Darlehen endfällig (nur Zins); ohne Steuern/Nebenkosten. Szenario wird automatisch am Kunden gespeichert.')}
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
