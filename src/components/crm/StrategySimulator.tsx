import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'
import { createStrategyOutboxDraft } from '../../lib/calcOutbox'
import { runReinvest } from '../../lib/reinvest'
import {
  roeMeaningful, migrateConfig, ymOf, rentFromSeason, runScenarios, assessRisk,
  breakEvenGrowth, defaultDivTaxPct, DEFAULT_SIM_PARAMS, SCENARIO_KEYS,
  type SimUnit, type SimParams, type ScenarioKey, type ScenarioResult,
} from '../../lib/strategy'
import { defaultMgmtPct, type CalcParams, type CalcItem } from '../../lib/rechner'

// ── Strategie-Simulator ──────────────────────────────────────────────────────
// Zusatz ÜBER den Einzelrechnungen (Sven 15.8.26): rechnet je Wohnung mit der
// verifizierten Rechner-Engine (lib/strategy → lib/rechner - dieselbe wie die
// Kundenrechnungen: Annuität, Kurz-/Langzeit inkl. MwSt-Erstattung, Steuern) und
// legt die Ergebnisse auf eine echte Zeitachse (Kauf-/Übergabe-Monat + Jahr).
// „Für Kunden freigeben" veröffentlicht den Plan unter /strategie/<token> und
// legt einen Begleit-Entwurf in den Postausgang (wie bei Berechnungen/Decks).

export type { SimUnit } from '../../lib/strategy'

const eur = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' €'
const pct = (n: number) => (isFinite(n) ? n.toFixed(1).replace('.', ',') : '0') + ' %'
const now = new Date()
const NOW_YM = ymOf(now.getFullYear(), now.getMonth() + 1)
const MONTH_OPTS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1).padStart(2, '0') }))
const YEAR_OPTS = Array.from({ length: 12 }, (_, i) => ({ value: String(now.getFullYear() + i), label: String(now.getFullYear() + i) }))

interface PickProject { id: string; name: string; furniture_cost: number | null; furniture_included: boolean | null; completion_date: string | null; calc_defaults: { furniture_by_bedrooms?: Record<string, number> } | null }
interface PickUnit { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; price_net: number | null }

export default function StrategySimulator({ lead, initialUnits, onClose }: {
  lead: { id: string; first_name: string; last_name: string } | null
  initialUnits: SimUnit[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [units, setUnits] = useState<SimUnit[]>(initialUnits)
  const [params, setParams] = useState<SimParams>({ ...DEFAULT_SIM_PARAMS })
  const [loaded, setLoaded] = useState(initialUnits.length > 0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [projects, setProjects] = useState<PickProject[]>([])
  const [pickProject, setPickProject] = useState('')
  const [pickUnits, setPickUnits] = useState<PickUnit[]>([])
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const freeCounter = useRef(0)
  // Freigabe an den Kunden
  const [calcApplied, setCalcApplied] = useState(false)
  const [calcNote, setCalcNote] = useState('')
  const [sharing, setSharing] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [shareErr, setShareErr] = useState('')

  // Gespeichertes Szenario laden, wenn der Wizard nichts mitgibt
  useEffect(() => { void (async () => {
    if (initialUnits.length > 0 || !lead) { setLoaded(true); return }
    try {
      const { data } = await supabase.from('crm_strategy_scenarios').select('config').eq('lead_id', lead.id).maybeSingle()
      const mig = migrateConfig((data as { config?: unknown } | null)?.config as never)
      if (mig.units.length) { setUnits(mig.units); setParams(mig.params) }
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
          // Teil-Wohnungen (parent_unit_id) nie einzeln: verkauft wird die Gesamteinheit.
          .eq('project_id', pickProject).not('status', 'in', '(sold,reserved)').is('property_id', null).is('parent_unit_id', null).gt('price_net', 0).order('unit_number'),
        supabase.from('deals').select('unit_id').is('archived_from_phase', null).neq('phase', 'deal_verloren').not('unit_id', 'is', null),
      ])
      const taken = new Set((dealRows ?? []).map(d => (d as { unit_id: string }).unit_id))
      setPickUnits((data ?? []).filter(u => !taken.has((u as { id: string }).id)) as PickUnit[])
    } catch (err) { console.error('[StrategySimulator] units:', err) }
  })() }, [pickProject])

  // ── Werte aus den Einzelberechnungen des Kunden übernehmen ────────────────
  // Sven 15.8.: der Simulator soll mit denselben Zahlen rechnen wie die vorher
  // erstellten Berechnungen (v.a. Verwaltung: 25-40 % Kurzzeit statt Standard).
  // Zuordnung über „Projekt Wohnungsnummer" im Namen; jüngste Berechnung gewinnt.
  useEffect(() => { void (async () => {
    if (!lead || !units.length || calcApplied) return
    try {
      const { data, error } = await supabase.from('property_calculations')
        .select('content, created_at').eq('lead_id', lead.id)
        .order('created_at', { ascending: false }).limit(12)
      if (error) throw error
      const byUnit = new Map<string, Partial<CalcParams>>()
      for (const row of (data ?? []) as Array<{ content: { items?: CalcItem[] } }>) {
        for (const it of (row.content?.items ?? [])) {
          if (!it.params) continue
          const k = `${it.project ?? ''} ${it.unit ?? ''}`.trim().toLowerCase()
          if (k && !byUnit.has(k)) byUnit.set(k, it.params)
        }
      }
      if (!byUnit.size) { setCalcApplied(true); return }
      let hits = 0
      setUnits(us => us.map(u => {
        if (u.calc) return u
        const p = byUnit.get(u.name.trim().toLowerCase())
        if (!p) return u
        hits++
        const letType = p.letType === 'long' ? 'long' : 'short'
        const season = letType === 'short' ? (p.season ?? null) : null
        // Bei Saisonmodell rechnet die Engine daraus - Miete entsprechend angleichen,
        // sonst zeigt der Simulator eine andere Miete als er rechnet.
        const seasonRent = rentFromSeason(season)
        return {
          ...u,
          letType,
          rent: seasonRent ?? u.rent,
          calc: {
            mgmtPct: p.mgmtPct, hotelConcept: p.hotelConcept, season,
            yieldPct: p.yieldPct, bedrooms: p.bedrooms, deTaxPct: p.deTaxPct, res: p.res,
            // MwSt-Regelung der Einzelberechnung mitnehmen - sonst rechnet die
            // Strategie 19 %, waehrend die Einzelrechnung 5/19 gemischt zeigt.
            vatMode: p.vatMode, livingSqm: p.livingSqm,
          },
        }
      }))
      if (hits) setCalcNote(t('crm.sim.fromCalc', '{{n}} Wohnung(en) übernehmen die Werte aus der Einzelberechnung.', { n: hits }))
    } catch (err) {
      console.error('[StrategySimulator] Einzelberechnungen:', err)
    }
    setCalcApplied(true)
  })() }, [lead, units.length, calcApplied, t])

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

  // Drei Szenarien aus EINER Berechnung: Basis sind Svens Einstellungen, die
  // anderen beiden werden daraus abgeleitet. Angezeigt wird das gewählte.
  const [scKey, setScKey] = useState<ScenarioKey>('basis')
  const scenarios = useMemo(() => units.length ? runScenarios(units, params) : null, [units, params])
  const active = scenarios?.[scKey] ?? null
  const outcomes = active?.outcomes ?? []
  const agg = useMemo(() => active
    ? { rows: active.rows, firstYear: active.firstYear, lastYear: active.lastYear, bridgeNeeded: active.bridgeNeeded, bridgePeak: active.bridgePeak }
    : { rows: [], firstYear: now.getFullYear(), lastYear: now.getFullYear(), bridgeNeeded: false, bridgePeak: 0 }, [active])
  const exit = active?.exit ?? null
  const totals = active?.totals ?? null
  // Break-even rechnet die ganze Strategie mehrfach durch - nur bei Bedarf.
  const [beOpen, setBeOpen] = useState(false)
  const breakEven = useMemo(() => beOpen && units.length ? breakEvenGrowth(units, params) : NaN, [beOpen, units, params])
  const risks = useMemo(() => scenarios ? assessRisk(scenarios, breakEven) : [], [scenarios, breakEven])
  // Kapital-Recycling laeuft ueber einen eigenen Motor auf derselben Schicht.
  const reinvest = useMemo(
    () => params.reinvestEnabled && units.length ? runReinvest(units, params) : null,
    [params, units],
  )

  // ── Für den Kunden freigeben ───────────────────────────────────────────────
  // Speichert den aktuellen Stand SOFORT (nicht entprellt), schaltet den
  // öffentlichen Link frei (/strategie/<token>) und legt einen Begleit-Entwurf
  // in den Postausgang - genau wie bei Berechnungen und Decks.
  const share = async () => {
    if (!lead || !units.length || sharing) return
    setSharing(true); setShareErr('')
    try {
      const title = units.length === 1
        ? `Investitions-Fahrplan · ${units[0].name}`
        : `Investitions-Fahrplan · ${units.length} Wohnungen`
      const recipient = `${lead.first_name} ${lead.last_name}`.trim()
      const { data, error } = await supabase.from('crm_strategy_scenarios')
        .upsert({
          lead_id: lead.id, config: { unitsV2: units, paramsV2: params },
          title, recipient_name: recipient,
          shared_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }, { onConflict: 'lead_id' })
        .select('token').single()
      if (error) throw error
      const token = (data as { token: string }).token
      await createStrategyOutboxDraft({
        leadId: lead.id, firstName: lead.first_name, token, title, unitCount: units.length,
      })
      setShareUrl(`${window.location.origin}/strategie/${token}`)
    } catch (err) {
      console.error('[StrategySimulator] share:', err)
      setShareErr(err instanceof Error ? err.message : String(err))
    } finally { setSharing(false) }
  }

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
              ] as Array<[keyof SimParams, string, number]>).map(([k, label, step]) => (
                <div key={k}>
                  <label className={lbl}>{label}</label>
                  <input type="number" step={step} className={inputCls} value={params[k] as number}
                    onChange={e => setParams(p => ({ ...p, [k]: +e.target.value }))} />
                </div>
              ))}
            </div>

            {/* ── Laufende Kosten der Wohnungen ───────────────────────────────
                Verwaltung deckt die Vermietung ab. Gemeinschaftskosten (Pool,
                Garten, Beleuchtung, Versicherung der Anlage) und die
                Instandhaltungsruecklage kommen zusaetzlich und fehlten bisher
                komplett. */}
            <div className="mt-3 pt-3 border-t border-gray-200">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                {t('crm.sim.costSection', 'Laufende Kosten')}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className={lbl}>{t('crm.sim.opexDefault', 'Gemeinschaftskosten €/Monat')}</label>
                  <input type="number" step={10} className={inputCls} value={params.opexMonthly}
                    onChange={e => setParams(p => ({ ...p, opexMonthly: +e.target.value }))} />
                </div>
                <div className="col-span-2 sm:col-span-2">
                  <label className={lbl}>
                    {t('crm.sim.maint', 'Instandhaltungsrücklage % p.a. vom Kaufpreis')}
                    <strong className="text-gray-700 ml-1">{String(params.maintPct).replace('.', ',')} %</strong>
                  </label>
                  <input type="range" min={0} max={2} step={0.05} className="w-full accent-orange-500"
                    value={params.maintPct}
                    onChange={e => setParams(p => ({ ...p, maintPct: +e.target.value }))} />
                </div>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                {t('crm.sim.costHint', 'Die Rücklage rechnet auf den ursprünglichen Kaufpreis, nicht auf den gestiegenen Marktwert. Gemeinschaftskosten gelten je Wohnung und können unten je Wohnung überschrieben werden; beide steigen mit 2 % pro Jahr.')}
              </p>
            </div>

            {/* ── Verkauf ─────────────────────────────────────────────────────
                Ohne Verkauf fehlt die halbe Entscheidung: Wertsteigerung ist bis
                dahin nur Papier, und beim Verkauf greifen drei Steuern auf
                einmal. Ein gemeinsames Verkaufsjahr fuer die ganze Strategie. */}
            <div className="mt-3 pt-3 border-t border-gray-200">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                {t('crm.sim.exitSection', 'Verkauf')}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                <div className="col-span-2">
                  <label className={lbl}>
                    {t('crm.sim.exitAfter', 'Verkauf nach')}
                    <strong className="text-gray-700 ml-1">
                      {params.exitAfterYears
                        ? t('crm.sim.exitYears', '{{n}} Jahren ({{y}})', { n: params.exitAfterYears, y: agg.firstYear + params.exitAfterYears - 1 })
                        : t('crm.sim.exitNone', 'kein Verkauf, nur Haltephase')}
                    </strong>
                  </label>
                  <input type="range" min={0} max={10} step={1} className="w-full accent-orange-500"
                    value={params.exitAfterYears}
                    onChange={e => setParams(p => ({ ...p, exitAfterYears: +e.target.value }))} />
                </div>
                <div>
                  <label className={lbl}>
                    {t('crm.sim.sellCost', 'Maklerprovision %')}
                    <strong className="text-gray-700 ml-1">{String(params.sellCostPct).replace('.', ',')} %</strong>
                  </label>
                  <input type="range" min={0} max={8} step={0.5} className="w-full accent-orange-500"
                    value={params.sellCostPct}
                    onChange={e => setParams(p => ({ ...p, sellCostPct: +e.target.value }))} />
                </div>
                <div>
                  <label className={lbl}>
                    {t('crm.sim.lawyer', 'Anwalt %')}
                    <strong className="text-gray-700 ml-1">{String(params.lawyerPct).replace('.', ',')} %</strong>
                  </label>
                  <input type="range" min={0} max={3} step={0.25} className="w-full accent-orange-500"
                    value={params.lawyerPct}
                    onChange={e => setParams(p => ({ ...p, lawyerPct: +e.target.value }))} />
                </div>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                {t('crm.sim.exitHint2', 'Der Zeitraum endet im Verkaufsjahr. Auf Makler und Anwalt kommen 19 % MwSt, dazu 0,4 % Übertragungsabgabe. Wohnungen, die beim Verkauf noch nicht übergeben sind, gehen zum eingezahlten Betrag ab.')}
              </p>
            </div>

            {/* ── Besteuerung: Steuersitz + privat/Firma ──────────────────────
                Sven 4.9.26: „Versteuerung in Zypern kann ich gar nicht eingeben."
                Steuersitz und Halte-Struktur gelten fuer den ganzen Plan; die
                Engine rechnet damit die zyprische Steuer (Freibetrag, 20 %
                Pauschale, 3 % AfA) bzw. die Ltd (15 %, kein Freibetrag,
                Verlustvortrag) und die Ausschuettung an den Gesellschafter. */}
            <div className="mt-3 pt-3 border-t border-gray-200">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                {t('crm.sim.taxSection', 'Besteuerung')}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className={lbl}>{t('crm.sim.taxRes', 'Steuersitz des Kunden')}</label>
                  <CustomSelect value={params.res}
                    onChange={v => setParams(p => ({
                      ...p, res: v as 'de' | 'cy', divTaxPct: defaultDivTaxPct(v as 'de' | 'cy'),
                    }))}
                    options={[{ value: 'de', label: t('crm.sim.resDe', 'Deutschland') },
                      { value: 'cy', label: t('crm.sim.resCy', 'Zypern') }]} />
                </div>
                <div>
                  <label className={lbl}>{t('crm.sim.holder', 'Halten')}</label>
                  <CustomSelect value={params.holder}
                    onChange={v => setParams(p => ({ ...p, holder: v as 'privat' | 'firma' }))}
                    options={[{ value: 'privat', label: t('crm.sim.holderPrivat', 'Privat') },
                      { value: 'firma', label: t('crm.sim.holderFirma', 'Zyprische Ltd (Firma)') }]} />
                </div>
                {params.holder === 'privat' ? (<>
                  {params.res === 'de' ? (
                    <div>
                      <label className={lbl}>{t('crm.sim.deTax', 'DE-Steuersatz %')}</label>
                      <input type="number" step={1} className={inputCls} value={params.deTaxPct}
                        onChange={e => setParams(p => ({ ...p, deTaxPct: +e.target.value }))} />
                    </div>
                  ) : (<>
                    <div>
                      <label className={lbl}>{t('crm.sim.cyBI', 'CY Bestandseinkommen (€)')}</label>
                      <input type="number" step={500} className={inputCls} value={params.cyBI}
                        onChange={e => setParams(p => ({ ...p, cyBI: +e.target.value }))} />
                    </div>
                    <div className="flex flex-col justify-end pb-1 gap-1">
                      <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-700">
                        <input type="checkbox" checked={params.gesy} className="w-4 h-4 accent-orange-500"
                          onChange={e => setParams(p => ({ ...p, gesy: e.target.checked }))} />
                        {t('crm.sim.gesy2', 'GESY (Gesundheitsbeitrag)')}
                      </label>
                      {/* Sozialversicherung nur fuer in Zypern Ansaessige - bei
                          Steuersitz Deutschland faellt sie nicht an. */}
                      <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-700">
                        <input type="checkbox" checked={params.socialIns} className="w-4 h-4 accent-orange-500"
                          onChange={e => setParams(p => ({ ...p, socialIns: e.target.checked }))} />
                        {t('crm.sim.socialIns', 'Sozialversicherung 16,6 %')}
                      </label>
                    </div>
                  </>)}
                </>) : (<>
                  <div>
                    <label className={lbl}>{t('crm.sim.corpTax', 'Körperschaftsteuer CY %')}</label>
                    <input type="number" step={0.5} className={inputCls} value={params.corpTaxPct}
                      onChange={e => setParams(p => ({ ...p, corpTaxPct: +e.target.value }))} />
                  </div>
                  <div>
                    <label className={lbl}>{t('crm.sim.divPayout', 'Ausschüttung % vom Gewinn')}</label>
                    <input type="number" step={5} className={inputCls} value={params.divPayoutPct}
                      onChange={e => setParams(p => ({ ...p, divPayoutPct: +e.target.value }))} />
                  </div>
                  <div>
                    <label className={lbl}>{t('crm.sim.divTax', 'Steuer auf Ausschüttung %')}</label>
                    <input type="number" step={0.125} className={inputCls} value={params.divTaxPct}
                      onChange={e => setParams(p => ({ ...p, divTaxPct: +e.target.value }))} />
                  </div>
                </>)}
              </div>
              <p className="text-[11px] text-gray-700 mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {t('crm.sim.taxJoint', 'Die Steuer wird über ALLE Wohnungen zusammen gerechnet: Freibetrag, Progression, Bestandseinkommen, GESY-Deckel und der Verlustvortrag der Firma gelten pro Kunde, nicht pro Wohnung. Die Einzelberechnung einer Wohnung zeigt deshalb eine andere Steuer als dieser Plan - das ist richtig so, weil eine Wohnung allein tatsächlich anders besteuert wird als drei zusammen.')}
              </p>
              <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
                {params.holder === 'privat'
                  ? (params.res === 'cy'
                    ? t('crm.sim.taxHintCyPrivat2', 'Zypern privat: 22.000 € steuerfrei, dann 20/25/30/35 % (35 % erst ab 72.001 €). Abziehbar: bei Kurzzeit die echten Kosten, bei Langzeit 20 % Pauschale, dazu 3 % Gebäude-Abschreibung p.a. (80 % des Kaufpreises), 10 % auf die Einrichtung und die Darlehenszinsen. SDC auf Mieten ist seit 1.1.2026 gestrichen. Wer kurzzeitvermietet, gilt als selbstständig: 16,6 % Sozialversicherung auf mindestens 20.318 € fiktives Einkommen (Deckel 68.904 €) und GESY mit 4 % auf den Gewinn statt 2,65 % auf die Miete.')
                    : t('crm.sim.taxHintDePrivat2', 'Steuersitz Deutschland: Zypern besteuert zuerst, Deutschland rechnet mit eigener AfA nach und rechnet die zyprische Steuer an (DBA Art. 22, nur Anrechnung, keine Freistellung). Die Gesamtlast ist die zyprische Steuer plus der nicht angerechnete deutsche Rest. GESY und Sozialversicherung fallen nicht an.'))
                  : t('crm.sim.taxHintFirma', 'Zyprische Ltd: kein Freibetrag und keine 20-%-Pauschale - nur echte Kosten (Verwaltung, Zinsen, 3 % Gebäude-AfA, 10 % Einrichtung). 15 % Körperschaftsteuer seit 1.1.2026, Verluste 5 Jahre vortragbar. Zypern behält auf die Ausschüttung nichts ein; beim deutschen Gesellschafter fallen 26,375 % (Abgeltungsteuer + Soli) an, beim zyprischen Non-Dom nur 2,65 % GESY.')}
              </p>
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

          {calcNote && (
            <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              ✓ {calcNote}
            </p>
          )}

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
                      <label className={lbl}>
                        {t('crm.sim.rent', 'Miete/Monat (€)')}
                        {u.calc?.season && <span className="text-orange-600"> · {t('crm.sim.fromSeason', 'aus Saisonmodell')}</span>}
                      </label>
                      {/* Eigene Miete eintippen hebt ein Saisonmodell auf - sonst
                          würde die Engine weiter mit dem Modell rechnen. */}
                      <input type="number" step={50} className={inputCls} value={Math.round(u.rent)}
                        onChange={e => patchUnit(u.key, { rent: +e.target.value, calc: { ...(u.calc ?? {}), season: null } })} />
                    </div>
                    <div>
                      <label className={lbl}>{t('crm.sim.letType', 'Vermietung')}</label>
                      <CustomSelect value={u.letType}
                        onChange={v => {
                          const lt = v as 'short' | 'long'
                          const cur = u.calc?.mgmtPct
                          const wasDefault = cur == null || cur === defaultMgmtPct(u.letType, u.calc?.hotelConcept)
                          patchUnit(u.key, {
                            letType: lt,
                            calc: { ...(u.calc ?? {}), ...(wasDefault ? { mgmtPct: defaultMgmtPct(lt, u.calc?.hotelConcept) } : {}) },
                          })
                        }}
                        options={[{ value: 'short', label: t('crm.sim.letShort', 'Kurzzeit (MwSt-Erstattung)') },
                          { value: 'long', label: t('crm.sim.letLong', 'Langzeit') }]} />
                    </div>
                    {/* Verwaltung: Schieberegler statt festem Wert (Sven 5.9.26).
                        Kurzzeit rechnet in Prozent der Miete, Langzeit wahlweise
                        in Prozent oder als fester Monatsbetrag. */}
                    <div className="col-span-2 sm:col-span-1">
                      <label className={lbl}>
                        {u.calc?.mgmtMode === 'fix'
                          ? t('crm.sim.mgmtFix', 'Verwaltung €/Monat')
                          : t('crm.sim.mgmt', 'Verwaltung % der Miete')}
                        <strong className="text-gray-700 ml-1">
                          {u.calc?.mgmtMode === 'fix'
                            ? `${Math.round(u.calc?.mgmtFix ?? 100)} €`
                            : `${Math.round(u.calc?.mgmtPct ?? defaultMgmtPct(u.letType, u.calc?.hotelConcept))} %`}
                        </strong>
                      </label>
                      {u.calc?.mgmtMode === 'fix' ? (
                        <input type="range" min={0} max={500} step={10} className="w-full accent-orange-500"
                          value={Math.round(u.calc?.mgmtFix ?? 100)}
                          onChange={e => patchUnit(u.key, { calc: { ...(u.calc ?? {}), mgmtFix: +e.target.value } })} />
                      ) : (
                        <input type="range" min={0} max={50} step={1} className="w-full accent-orange-500"
                          value={Math.round(u.calc?.mgmtPct ?? defaultMgmtPct(u.letType, u.calc?.hotelConcept))}
                          onChange={e => patchUnit(u.key, { calc: { ...(u.calc ?? {}), mgmtPct: +e.target.value } })} />
                      )}
                      {u.letType === 'long' && (
                        <button type="button"
                          onClick={() => patchUnit(u.key, { calc: { ...(u.calc ?? {}), mgmtMode: u.calc?.mgmtMode === 'fix' ? 'pct' : 'fix', mgmtFix: u.calc?.mgmtFix ?? 100 } })}
                          className="text-[11px] text-orange-600 hover:underline mt-0.5">
                          {u.calc?.mgmtMode === 'fix'
                            ? t('crm.sim.mgmtToPct', '→ als Prozent der Miete')
                            : t('crm.sim.mgmtToFix', '→ als fester Betrag pro Monat')}
                        </button>
                      )}
                    </div>
                    <div>
                      <label className={lbl}>{t('crm.sim.opex', 'Gemeinschaftskosten €/Monat')}</label>
                      <input type="number" step={10} className={inputCls}
                        value={Math.round(u.opex ?? params.opexMonthly)}
                        onChange={e => patchUnit(u.key, { opex: +e.target.value })} />
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
                      {roeMeaningful(o) ? `${' · '}${t('crm.sim.roe', 'EK-Rendite 10 J.')} ${pct(o.res.roe10)}` : ` · ${t('crm.sim.mostlyFinanced', 'überwiegend fremdfinanziert')}`}
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

          {outcomes.length > 0 && totals && scenarios && (<>
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
                        <td className="px-3 py-2">{roeMeaningful(o) ? pct(o.res.roe10) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {agg.bridgeNeeded && (
              <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-900">
                ⚠️ <strong>{t('crm.sim.bridgeTitle', 'Zwischenfinanzierung nötig')}:</strong>{' '}
                {t('crm.sim.bridgeText', 'Die Kaufraten übersteigen das Eigenkapital in der Spitze um {{peak}}. Die Bauzeitzinsen darauf sind in den Zinsen enthalten.', { peak: eur(agg.bridgePeak) })}
              </div>
            )}

            {/* ── Szenarien ─────────────────────────────────────────────────
                Drei Blickwinkel auf dieselbe Strategie. Basis sind die
                Einstellungen oben, die anderen beiden werden daraus abgeleitet.
                Farben bewusst zurückhaltend: die Ampel unten trägt die Aussage. */}
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">
                  {t('crm.sim.scenarios', 'Szenarien')}
                </p>
                {SCENARIO_KEYS.map(k => {
                  const on = k === scKey
                  const label = k === 'basis' ? t('crm.sim.scBasis', 'Basis')
                    : k === 'konservativ' ? t('crm.sim.scCons', 'Konservativ')
                      : t('crm.sim.scOpt', 'Optimistisch')
                  return (
                    <button key={k} onClick={() => setScKey(k)}
                      className={`px-3 py-1 rounded-lg text-sm border ${on ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                      {label}
                    </button>
                  )
                })}
                <span className="text-[11px] text-gray-400">
                  {t('crm.sim.scHint', 'Wertsteigerung {{g}} % · Mietsteigerung {{r}} % · Zins {{i}} %', {
                    g: String(active?.params.growth ?? params.growth).replace('.', ','),
                    r: String(active?.params.rentGrowth ?? params.rentGrowth).replace('.', ','),
                    i: String(active?.params.interest ?? params.interest).replace('.', ','),
                  })}
                </span>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                    <th className="px-3 py-2">{t('crm.sim.scMetric', 'Kennzahl')}</th>
                    <th className="px-3 py-2 text-right">{t('crm.sim.scBasis', 'Basis')}</th>
                    <th className="px-3 py-2 text-right">{t('crm.sim.scCons', 'Konservativ')}</th>
                    <th className="px-3 py-2 text-right">{t('crm.sim.scOpt', 'Optimistisch')}</th>
                  </tr></thead>
                  <tbody>
                    {([
                      [t('crm.sim.scValue', 'Immobilienwert am Ende'), (r: ScenarioResult) => eur(r.totals.valueEnd)],
                      [t('crm.sim.scDebt', 'Restschuld'), (r: ScenarioResult) => eur(r.totals.debtEnd)],
                      [t('crm.sim.scWorth', 'Netto-Vermögen'), (r: ScenarioResult) => eur(r.totals.netWorth)],
                      [t('crm.sim.scCf', 'Cashflow kumuliert'), (r: ScenarioResult) => eur(r.totals.cashflow)],
                      [t('crm.sim.scIrr', 'Interner Zinsfuß'), (r: ScenarioResult) => isFinite(r.totals.irr) ? pct(r.totals.irr * 100) : '–'],
                      [t('crm.sim.scNet', 'Nettoerlös bei Verkauf'), (r: ScenarioResult) => r.exit ? eur(r.exit.net) : '–'],
                    ] as Array<[string, (r: ScenarioResult) => string]>).map(([label, get]) => (
                      <tr key={label} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-1.5 text-gray-600">{label}</td>
                        <td className="px-3 py-1.5 text-right font-semibold">{get(scenarios.basis)}</td>
                        <td className="px-3 py-1.5 text-right text-amber-800">{get(scenarios.konservativ)}</td>
                        <td className="px-3 py-1.5 text-right text-green-800">{get(scenarios.optimistisch)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Risiko ────────────────────────────────────────────────────
                Jede Ampel liest ein konkretes Ergebnis aus den Szenarien ab,
                die Schwelle steht im Klartext daneben. Keine Fantasiewerte. */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {t('crm.sim.riskTitle', 'Risiko')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {risks.map(r => {
                  const dot = r.level === 'gruen' ? 'bg-green-500' : r.level === 'gelb' ? 'bg-amber-400' : 'bg-red-500'
                  const label = t(`crm.sim.risk_${r.key}`, {
                    wert: 'Wertentwicklung', breakeven: 'Sicherheitsabstand', cashflow: 'Cashflow',
                    finanzierung: 'Finanzierung', vermietung: 'Vermietung', exit: 'Verkauf',
                  }[r.key] ?? r.key)
                  return (
                    <div key={r.key} className="flex items-start gap-2 border border-gray-200 rounded-lg px-3 py-2">
                      <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${dot}`} />
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900">
                          <strong>{label}</strong> · <span className="tabular-nums">{r.value}</span>
                        </p>
                        <p className="text-[11px] text-gray-500 leading-snug">{r.note}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── Reinvestment und Kapital-Recycling ────────────────────────
                Zeigt, wie weit das vorhandene Kapital traegt, wenn Wertzuwachs
                und Tilgung neue Beleihungsspielraeume schaffen. Bewusst als
                Modellrechnung beschriftet, nicht als Finanzierungszusage. */}
            <div className="border border-gray-200 rounded-xl p-4">
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={params.reinvestEnabled} className="w-4 h-4 accent-orange-500 mt-0.5"
                  onChange={e => setParams(p => ({ ...p, reinvestEnabled: e.target.checked }))} />
                <span className="text-sm text-gray-700">
                  <strong>{t('crm.sim.reinvest', 'Reinvestment und Kapital-Recycling')}</strong>
                  <span className="block text-xs text-gray-400">
                    {t('crm.sim.reinvestHint', 'Rechnet über einen längeren Zeitraum und prüft Jahr für Jahr, ob aus Wertzuwachs und Tilgung eine weitere Immobilie finanzierbar wäre.')}
                  </span>
                </span>
              </label>

              {params.reinvestEnabled && (<>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                  {([
                    ['horizonYears', t('crm.sim.horizon', 'Zeitraum (Jahre)'), 1, 10, 30],
                    ['reinvestAppreciationPct', t('crm.sim.reAppr', 'Wertsteigerung % p.a.'), 0.5, 0, 10],
                    ['refinanceLtv', t('crm.sim.reLtv', 'Angenommene max. Beleihung %'), 5, 30, 80],
                    ['bankValuationFactor', t('crm.sim.reBank', 'Bankbewertung % vom Marktwert'), 5, 70, 100],
                    ['refinanceUtilizationPct', t('crm.sim.reUse', 'Genutzte Kapazität %'), 5, 50, 100],
                    ['minimumCashReserve', t('crm.sim.reReserve', 'Mindestliquidität (€)'), 5000, 0, 200000],
                    ['maxAdditionalPurchases', t('crm.sim.reMax', 'Max. zusätzliche Käufe'), 1, 0, 10],
                  ] as Array<[keyof SimParams, string, number, number, number]>).map(([k, label, step, min, max]) => (
                    <div key={k}>
                      <label className={lbl}>
                        {label}
                        <strong className="text-gray-700 ml-1">{String(params[k]).replace('.', ',')}</strong>
                      </label>
                      <input type="range" min={min} max={max} step={step} className="w-full accent-orange-500"
                        value={params[k] as number}
                        onChange={e => setParams(p => ({ ...p, [k]: +e.target.value }))} />
                    </div>
                  ))}
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-700">
                      <input type="checkbox" checked={params.autoReinvest} className="w-4 h-4 accent-orange-500"
                        onChange={e => setParams(p => ({ ...p, autoReinvest: e.target.checked }))} />
                      {t('crm.sim.reAuto', 'Modellobjekte automatisch kaufen')}
                    </label>
                  </div>
                </div>

                {reinvest && (<>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
                    {[
                      { l: t('crm.sim.reCapacity', 'Beleihungskapazität heute'), v: eur(reinvest.years[0]?.refinancingCapacity ?? 0) },
                      { l: t('crm.sim.reNext', 'Frühester weiterer Kauf'), v: reinvest.kpis.earliestNextPurchaseYear ? String(reinvest.kpis.earliestNextPurchaseYear) : '–' },
                      { l: t('crm.sim.reModelPrice', 'Modellkaufpreis'), v: eur(reinvest.modelUnit?.priceNet ?? 0) },
                      { l: t('crm.sim.reMaxPrice', 'Maximal finanzierbar'), v: eur(reinvest.kpis.maximumAdditionalPurchasePrice) },
                      { l: t('crm.sim.reBuys', 'Zusätzliche Immobilien'), v: String(reinvest.kpis.additionalPurchases) },
                      { l: t('crm.sim.reRefis', 'Refinanzierungen'), v: `${reinvest.kpis.refinancings} · ${eur(reinvest.kpis.totalRefinancingProceeds)}` },
                      { l: t('crm.sim.rePortfolio', 'Portfolio am Ende'), v: `${reinvest.kpis.activeUnitsEnd} · ${eur(reinvest.kpis.portfolioValueEnd)}` },
                      { l: t('crm.sim.reMultiple', 'Kapital-Recycling'), v: `${String(reinvest.kpis.capitalRecyclingMultiple).replace('.', ',')}×`, hero: true },
                    ].map(k => (
                      <div key={k.l} className={`rounded-xl border p-3 ${k.hero ? 'border-orange-300' : 'border-gray-200'}`}>
                        <p className="text-[10px] uppercase tracking-wide text-gray-400">{k.l}</p>
                        <p className={`text-base font-bold ${k.hero ? 'text-orange-600' : 'text-gray-900'}`}>{k.v}</p>
                      </div>
                    ))}
                  </div>

                  {reinvest.events.length > 0 && (
                    <div className="mt-4 border border-gray-200 rounded-xl overflow-x-auto">
                      <table className="w-full text-xs tabular-nums">
                        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                          <th className="px-2 py-2">{t('crm.sim.tlYear', 'Jahr')}</th>
                          <th className="px-2 py-2">{t('crm.sim.tlEvent', 'Ereignis')}</th>
                          <th className="px-2 py-2">{t('crm.sim.tlObject', 'Objekt')}</th>
                          <th className="px-2 py-2 text-right">{t('crm.sim.tlIn', 'Kapitalzufluss')}</th>
                          <th className="px-2 py-2 text-right">{t('crm.sim.tlOut', 'Kapitalabfluss')}</th>
                          <th className="px-2 py-2 text-right">{t('crm.sim.tlUnits', 'Portfolio')}</th>
                        </tr></thead>
                        <tbody>
                          {reinvest.events.map((e, i) => {
                            const label = e.kind === 'purchase' ? t('crm.sim.tlBuy', 'Kauf')
                              : e.kind === 'refinance' ? t('crm.sim.tlRefi', 'Refinanzierung')
                                : t('crm.sim.tlSale', 'Verkauf')
                            const name = e.kind === 'refinance' ? e.propertyNames.join(', ') : e.name
                            const zufluss = e.kind === 'refinance' ? e.newLoanAmount : e.kind === 'sale' ? e.netProceeds : 0
                            const abfluss = e.kind === 'purchase' ? e.equity : 0
                            const units = reinvest.years.find(y => y.year === e.year)?.activeUnits ?? 0
                            return (
                              <tr key={`${e.kind}-${e.year}-${i}`} className="border-b border-gray-50 last:border-0">
                                <td className="px-2 py-1.5 font-semibold">{e.year}</td>
                                <td className="px-2 py-1.5">{label}</td>
                                <td className="px-2 py-1.5 text-gray-600">{name}</td>
                                <td className="px-2 py-1.5 text-right text-green-700">{zufluss ? eur(zufluss) : ''}</td>
                                <td className="px-2 py-1.5 text-right text-orange-600">{abfluss ? `−${eur(abfluss)}` : ''}</td>
                                <td className="px-2 py-1.5 text-right">{units}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {reinvest.kpis.lowestCash < 0 && (
                    <p className="text-[11px] text-orange-900 mt-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                      ⚠️ {t('crm.sim.reNegative', 'Die Liquidität rutscht im Jahr {{y}} auf {{v}}. So weit gerechnet müsste der Kunde zwischendurch Geld nachschießen.', { y: reinvest.kpis.lowestCashYear, v: eur(reinvest.kpis.lowestCash) })}
                    </p>
                  )}
                  <p className="text-[11px] text-gray-700 mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    {t('crm.sim.reDisclaimer', 'Das ist eine Modellrechnung unter den oben gewählten Annahmen, keine Finanzierungszusage. Ob eine Bank tatsächlich finanziert, hängt von Einkommen, bestehenden Verpflichtungen, Bonität, Bewertung und den Richtlinien der Bank ab. Die weiteren Käufe rechnen mit einem Modellobjekt, das aus dem Durchschnitt der gewählten Wohnungen abgeleitet ist.')}
                  </p>
                </>)}
              </>)}
            </div>

            {/* Gesamt-KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                { l: t('crm.sim.ekTotal', 'Eigenkapital gesamt'), v: eur(totals.ekTotal), d: t('crm.sim.inclCosts', 'inkl. Kaufnebenkosten') },
                { l: t('crm.sim.netWorthEnd', 'Netto-Vermögen am Ende'), v: eur(totals.netWorth), d: t('crm.sim.valueMinusDebt', 'Wert abzgl. Restschuld'), hero: true },
                { l: t('crm.sim.rents', 'Mieten kumuliert'), v: eur(totals.rents), d: `${t('crm.sim.interestPaid', 'Zinsen')} −${eur(totals.interest)}` },
                { l: t('crm.sim.taxesTotal', 'Steuern gesamt'),
                  v: `${totals.taxes >= 0 ? '−' : '+'}${eur(Math.abs(totals.taxes))}`,
                  d: params.holder === 'firma'
                    ? t('crm.sim.taxSplitFirma', 'KSt {{k}} · Ausschüttung {{d}}', { k: eur(totals.taxCY), d: eur(totals.taxDE) })
                    : params.res === 'cy'
                      ? t('crm.sim.taxSplitCy2', 'GESY {{g}} · Sozialvers. {{s}} · MwSt +{{v}}', { g: eur(totals.gesy), s: eur(totals.si), v: eur(totals.vat) })
                      : t('crm.sim.taxSplitDe', 'CY {{c}} · DE {{d}} · MwSt-Erstattung +{{v}}', { c: eur(totals.taxCY), d: eur(totals.taxDE), v: eur(totals.vat) }) },
                { l: t('crm.sim.debtEnd', 'Kredit offen am Ende'), v: eur(totals.debtEnd), d: t('crm.sim.debtHint', 'Restschuld aller Darlehen') },
                { l: t('crm.sim.roe5', 'EK-Rendite nach 5 J.'), v: pct(totals.roe5), d: t('crm.sim.roeHint2', 'gesamt über den Zeitraum, nicht p.a.') },
                { l: t('crm.sim.roe10', 'EK-Rendite nach 10 J.'), v: pct(totals.roe10), d: t('crm.sim.roeHint2', 'gesamt über den Zeitraum, nicht p.a.') },
                { l: t('crm.sim.irr', 'Interner Zinsfuß'), v: isFinite(totals.irr) ? pct(totals.irr * 100) : '–',
                  d: t('crm.sim.irrHint', 'auf den echten Zahlungsströmen, p.a.'), hero: true },
                { l: t('crm.sim.cfLast', 'Cashflow letztes Jahr'), v: eur(totals.cashflowLastYear), d: t('crm.sim.cfLastHint', 'im laufenden Betrieb') },
                { l: t('crm.sim.valueEnd', 'Immobilienwert am Ende'), v: eur(totals.valueEnd), d: t('crm.sim.equityIn', 'davon eigen {{v}}', { v: eur(totals.equityInProperty) }) },
                { l: t('crm.sim.interestTotal', 'Zinsen gesamt'), v: `−${eur(totals.interest)}`, d: t('crm.sim.principalTotal', 'getilgt {{v}}', { v: eur(totals.principal) }) },
                { l: t('crm.sim.costTotal', 'Kosten gesamt'), v: `−${eur(totals.mgmt + totals.opex)}`, d: t('crm.sim.costSplit', 'Verwaltung {{m}} · Wohnung {{o}}', { m: eur(totals.mgmt), o: eur(totals.opex) }) },
              ].map(k => (
                <div key={k.l} className={`rounded-xl border p-3 ${k.hero ? 'border-orange-300' : 'border-gray-200'}`}>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">{k.l}</p>
                  <p className={`text-lg font-bold ${k.hero ? 'text-orange-600' : 'text-gray-900'}`}>{k.v}</p>
                  <p className="text-[11px] text-gray-400">{k.d}</p>
                </div>
              ))}
            </div>

            {/* ── Verkaufsrechnung ─────────────────────────────────────────── */}
            {exit && (
              <div className="border border-gray-200 rounded-xl p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('crm.sim.exitTitle', 'Verkauf {{y}}', { y: exit.year })}
                  </p>
                  <button onClick={() => setBeOpen(true)} className="text-[11px] text-orange-600 hover:underline">
                    {beOpen && isFinite(breakEven)
                      ? t('crm.sim.beResult', 'Break-even bei {{v}} % Wertsteigerung p.a.', { v: String(breakEven).replace('.', ',') })
                      : t('crm.sim.beCalc', 'Welche Wertsteigerung braucht die Strategie mindestens?')}
                  </button>
                </div>
                <table className="w-full text-sm tabular-nums">
                  <tbody>
                    {([
                      [t('crm.sim.exValue', 'Verkaufswert der Wohnungen'), exit.value, false],
                      [t('crm.sim.exDebt', 'Restschuld ablösen'), -exit.debt, true],
                      [t('crm.sim.exSell', 'Makler und Anwalt inkl. MwSt'), -exit.sellCost, true],
                      [t('crm.sim.exLevy', 'Übertragungsabgabe 0,4 %'), -exit.levy, true],
                      [t('crm.sim.exVat', 'MwSt-Rückzahlung (Restjahre)'), -exit.vatClawback, true],
                      [t('crm.sim.exCgt', 'Veräußerungsgewinnsteuer Zypern'), -exit.cgt, true],
                      ...(exit.taxDE ? [[t('crm.sim.exDe', 'Steuer Deutschland nach Anrechnung'), -exit.taxDE, true]] : []),
                      ...(exit.divTax ? [[t('crm.sim.exDiv', 'Steuer auf die Ausschüttung'), -exit.divTax, true]] : []),
                    ] as Array<[string, number, boolean]>).map(([label, val, minus]) => (
                      <tr key={label} className="border-b border-gray-50">
                        <td className="py-1.5 text-gray-600">{label}</td>
                        <td className={`py-1.5 text-right ${minus ? 'text-gray-900' : 'font-semibold'}`}>
                          {val === 0 ? '–' : `${val < 0 ? '−' : ''}${eur(Math.abs(val))}`}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="pt-2 font-semibold text-gray-900">{t('crm.sim.exNet', 'Nettoerlös')}</td>
                      <td className="pt-2 text-right text-lg font-bold text-orange-600">{eur(exit.net)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-[11px] text-gray-500 mt-2">
                  {t('crm.sim.exHint', 'Steuerpflichtiger Gewinn nach zyprischer Indexierung: {{g}}. Der lebenslange Freibetrag von 30.000 € je Person ist einmal berücksichtigt, nicht je Wohnung.', { g: eur(exit.gain) })}
                </p>
              </div>
            )}

            {/* Jahres-Tabelle: die komplette Rechnung auf der Zeitachse */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('crm.sim.yearTable', 'Verlauf je Jahr (alle Wohnungen zusammen)')}
              <span className="ml-2 normal-case tracking-normal font-normal text-gray-400">
                {t('crm.sim.period', '{{from}} bis {{to}} · 10 Jahre ab der ersten Übergabe', { from: agg.firstYear, to: agg.lastYear })}
              </span>
            </p>
              <div className="border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                    <th className="px-2 py-2">{t('crm.sim.year', 'Jahr')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colInvest', 'Kaufraten')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colRents', 'Mieten')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colMgmt', 'Verwaltung')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colOpex', 'Kosten')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colInterest', 'Zinsen')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colPrincipal', 'Tilgung')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colTaxes', 'Steuern')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colVat', 'MwSt-Erst.')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colCashflow', 'Cashflow')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colDebt', 'Restschuld')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colCommitted', 'gebunden')}</th>
                    <th className="px-2 py-2 text-right">{t('crm.sim.colWorth', 'Netto-Vermögen')}</th>
                  </tr></thead>
                  <tbody>
                    {agg.rows.map(r => (
                      <tr key={r.year} className="border-b border-gray-50 last:border-0">
                        <td className="px-2 py-1.5 font-semibold">{r.year}</td>
                        <td className="px-2 py-1.5 text-right text-orange-600">{r.invest ? `−${eur(r.invest)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right text-green-700">{r.rents ? eur(r.rents) : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.mgmt ? `−${eur(r.mgmt)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.opex ? `−${eur(r.opex)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.interest ? `−${eur(r.interest)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.principal ? `−${eur(r.principal)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.taxes ? `−${eur(r.taxes)}` : ''}</td>
                        <td className="px-2 py-1.5 text-right text-green-700">{r.vat ? `+${eur(r.vat)}` : ''}</td>
                        <td className={`px-2 py-1.5 text-right font-semibold ${r.cashflow >= 0 ? 'text-green-700' : 'text-amber-700'}`}>{r.rents || r.cashflow ? eur(r.cashflow) : ''}</td>
                        <td className="px-2 py-1.5 text-right">{r.debt ? eur(r.debt) : ''}</td>
                        <td className="px-2 py-1.5 text-right text-gray-500">{r.committed ? eur(r.committed) : ''}</td>
                        <td className="px-2 py-1.5 text-right font-semibold">{(r.value + r.committed) ? eur(r.value + r.committed - r.debt) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Für den Kunden freigeben */}
            <div className="border border-orange-200 bg-orange-50/50 rounded-xl p-4">
              {shareUrl ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-gray-900">
                    ✓ {t('crm.sim.shared', 'Für den Kunden freigegeben - der Begleit-Entwurf liegt im Postausgang.')}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input readOnly value={shareUrl} onFocus={e => e.currentTarget.select()}
                      className="flex-1 min-w-[240px] border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs bg-white" />
                    <button onClick={() => void navigator.clipboard?.writeText(shareUrl)}
                      className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 text-gray-600 hover:bg-white">
                      {t('crm.sim.copy', 'Link kopieren')}
                    </button>
                    <a href={shareUrl} target="_blank" rel="noreferrer"
                      className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
                      {t('crm.sim.openPlan', 'Ansehen')}
                    </a>
                  </div>
                  <p className="text-[11px] text-gray-500">
                    {t('crm.sim.sharedHint', 'Änderungen hier wirken sofort auf der Kundenseite - der Link bleibt derselbe. Versendet wird über den Postausgang (Mail oder WhatsApp).')}
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{t('crm.sim.shareTitle', 'Fahrplan an den Kunden schicken')}</p>
                    <p className="text-xs text-gray-500">
                      {t('crm.sim.shareHint', 'Legt eine Kundenseite mit eigenem Link an und einen fertigen Begleit-Entwurf in den Postausgang.')}
                    </p>
                    {shareErr && <p className="text-xs text-red-600 mt-1">{shareErr}</p>}
                  </div>
                  <button onClick={() => void share()} disabled={sharing || !lead}
                    className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 shrink-0"
                    style={{ backgroundColor: '#ff795d' }}>
                    {sharing ? t('crm.sim.sharing', 'Wird vorbereitet…') : `📤 ${t('crm.sim.shareBtn', 'Für Kunden freigeben')}`}
                  </button>
                </div>
              )}
            </div>

            <p className="text-[11px] text-gray-400">
              {t('crm.sim.engineNote2', 'Gerechnet mit der Engine der Einzelrechnungen: Annuitätendarlehen ab Übergabe, Miete und Steuern nach der oben gewählten Struktur ab Übergabe, MwSt-Erstattung bei Kurzzeitvermietung nach 24 Monaten. Kaufraten laufen vor der Übergabe aus dem Eigenkapital. Die Einzelrechnungen für den Kunden erstellst du wie gewohnt über den Haken "Mit Rendite-Berechnung" - gleiche Zahlen, gleiche Engine.')}
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
