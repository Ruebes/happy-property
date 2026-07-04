import { useState, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { DEFAULT_PARAMS, compute, type CalcParams, type CalcItem } from '../../lib/rechner'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'

// ── Rendite-Rechner-Wizard ───────────────────────────────────────────────────
// Voller Funktionsumfang des Original-Rechners (1:1-Engine): Einzelkauf + Share-Deal,
// Rabatt, Einrichtung (kostenfrei), MwSt-als-Sondertilgung + Sondertilgung J1-J10,
// Hotelkonzept, CY/DE-Steuer. Projekte/Wohnungen aus dem CRM; Kaufpreis automatisch.
// Erzeugt eine property_calculations-Zeile + öffentlichen HTML-Link (Einzel/Vergleich).

interface LeadLite { id: string; first_name: string; last_name: string }
interface ProjectRow { id: string; name: string; developer: string | null; location: string | null }
interface UnitRow { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; terrace_sqm: number | null; price_net: number | null; price_gross: number | null; floor: number | null; type: string | null }
interface BasketItem { project: ProjectRow; unit: UnitRow }

const num = (v: string, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n }
const eur0 = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n))

export default function RechnerWizard({ lead, onClose, onDone, editCalc }: { lead: LeadLite; onClose: () => void; onDone: (msg: string) => void; editCalc?: { token: string; content: { items: CalcItem[]; recipient_name?: string } } }) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [developer, setDeveloper] = useState('')
  const [projectId, setProjectId] = useState('')
  const [units, setUnits] = useState<UnitRow[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [basket, setBasket] = useState<BasketItem[]>([])
  const [p, setP] = useState<CalcParams>({ ...DEFAULT_PARAMS, month: 6, year: new Date().getFullYear() })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { void (async () => {
    const { data } = await supabase.from('crm_projects').select('id, name, developer, location').order('name')
    setProjects((data ?? []) as ProjectRow[])
  })() }, [])

  // Bearbeiten: bestehende Berechnung laden → geteilte Parameter (Eigenkapital, Zins …)
  // aus dem ersten Objekt vorbefüllen. Die Objekte selbst bleiben unverändert.
  useEffect(() => {
    const it0 = editCalc?.content?.items?.[0]
    if (it0?.params) setP({ ...DEFAULT_PARAMS, ...it0.params })
  }, [editCalc])

  useEffect(() => { void (async () => {
    setSel(new Set())
    if (!projectId) { setUnits([]); return }
    const { data } = await supabase.from('crm_project_units')
      .select('id, unit_number, bedrooms, size_sqm, terrace_sqm, price_net, price_gross, floor, type')
      .eq('project_id', projectId).order('unit_number')
    setUnits((data ?? []) as UnitRow[])
  })() }, [projectId])

  const project = projects.find(pr => pr.id === projectId)
  const toggleU = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const addToBasket = () => {
    if (!project) return
    const adds = units.filter(u => sel.has(u.id) && !basket.some(b => b.unit.id === u.id)).map(u => ({ project, unit: u }))
    const nb = [...basket, ...adds]; setBasket(nb); setSel(new Set())
    // Share-Deal-Felder aus dem Korb vorbefüllen
    if (p.dealType === 'share') {
      const totNet = nb.reduce((a, b) => a + (b.unit.price_net ?? 0), 0)
      const totSqm = nb.reduce((a, b) => a + (b.unit.size_sqm ?? 0), 0)
      setP(prev => ({ ...prev, sdPrice: totNet || prev.sdPrice, sdSqm: totSqm || prev.sdSqm, sdNum: nb.length || prev.sdNum }))
    }
  }
  const removeFromBasket = (uid: string) => setBasket(b => b.filter(x => x.unit.id !== uid))
  const set = (k: keyof CalcParams, v: number | string | boolean | number[]) => setP(prev => ({ ...prev, [k]: v }) as CalcParams)

  // „MwSt-Erstattung als Sondertilgung“: USt.-Betrag im Erstattungsjahr als Sondertilgung setzen
  const applyVatPrepay = () => {
    const refUnit = basket[0]?.unit
    const preview = compute({ ...p, dealType: p.dealType, priceNet: refUnit?.price_net ?? p.priceNet, bedrooms: refUnit?.bedrooms ?? p.bedrooms })
    const vatIdx = preview.vatA.findIndex(v => v > 0)
    if (vatIdx < 0) { setErr(t('rechnerWizard.noVatRefundCalculated', 'Keine USt.-Erstattung berechnet — dafür Kurzzeit-Vermietung wählen.')); return }
    const pp = [...p.ppVals]; pp[vatIdx] = Math.round(preview.vatAmt)
    setP(prev => ({ ...prev, ppVals: pp })); setShowAdvanced(true); setErr('')
  }

  const generate = async () => {
    if (!editCalc && p.dealType === 'single' && !basket.length) { setErr(t('rechnerWizard.selectAtLeastOneUnit', 'Bitte mindestens eine Wohnung wählen.')); return }
    setBusy(true); setErr('')
    try {
      // ── Bearbeiten: gleiche Objekte behalten, nur (geteilte) Parameter neu anwenden,
      //    Preis/Schlafzimmer je Objekt bewahren → bestehenden Token aktualisieren. ──
      if (editCalc) {
        const items = editCalc.content.items.map(it => ({
          ...it,
          params: { ...p, priceNet: it.params?.priceNet ?? p.priceNet, bedrooms: it.params?.bedrooms ?? p.bedrooms, dealType: it.params?.dealType ?? p.dealType },
        }))
        const content = { with_calc: true, recipient_name: editCalc.content.recipient_name ?? `${lead.first_name} ${lead.last_name}`.trim(), items }
        const { error } = await supabase.from('property_calculations').update({ content }).eq('token', editCalc.token)
        if (error) throw new Error(error.message)
        window.open(`${window.location.origin}/rechnung/${editCalc.token}`, '_blank')
        onDone(t('rechnerWizard.calculationUpdated', 'Berechnung aktualisiert.'))
        setBusy(false)
        return
      }
      let items: CalcItem[]
      if (p.dealType === 'share') {
        items = [{
          label: `Share-Deal · ${p.sdNum} Einheiten`, project: basket[0]?.project.name ?? 'Portfolio', unit: `${p.sdNum} WE`,
          size_sqm: p.sdSqm, price_net: p.sdPrice,
          location: basket[0]?.project.location ?? undefined, developer: basket[0]?.project.developer ?? undefined,
          params: { ...p, dealType: 'share' },
        }]
      } else {
        items = basket.map(b => {
          const u = b.unit
          return {
            label: `${b.project.name} · ${u.unit_number}`, project: b.project.name, unit: u.unit_number,
            bedrooms: u.bedrooms, size_sqm: u.size_sqm, terrace_sqm: u.terrace_sqm, floor: u.floor,
            price_net: u.price_net, price_gross: u.price_gross,
            location: b.project.location ?? undefined, developer: b.project.developer ?? undefined,
            params: { ...p, dealType: 'single', priceNet: u.price_net ?? p.priceNet, bedrooms: u.bedrooms ?? 2 },
          }
        })
      }
      const content = { with_calc: true, recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), items }
      const { data, error } = await supabase.from('property_calculations').insert({
        lead_id: lead.id, recipient_name: content.recipient_name,
        title: items.length > 1 ? 'Immobilienvergleich' : `Rechnung ${items[0].label}`,
        with_calc: true, content,
      }).select('token').single()
      if (error) throw new Error(error.message)
      const url = `${window.location.origin}/rechnung/${(data as { token: string }).token}`
      window.open(url, '_blank')
      onDone(items.length > 1
        ? t('rechnerWizard.comparisonCreated', 'Vergleich erstellt — Link geöffnet.')
        : t('rechnerWizard.invoiceCreated', 'Rechnung erstellt — Link geöffnet.'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('rechnerWizard.genericError', 'Fehler'))
    } finally { setBusy(false) }
  }

  // ── UI-Bausteine (inline → kein Fokus-Verlust) ──────────────────────────────
  const seg = (label: string, k: keyof CalcParams, opts: [string, string][]) => (
    <div>
      <span className="block text-xs font-medium text-gray-500 mb-1.5">{label}</span>
      <div className="inline-flex w-full rounded-xl bg-gray-100 p-1 gap-1">
        {opts.map(([val, lab]) => (
          <button key={val} type="button" onClick={() => set(k, val)}
            className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded-lg transition-all ${String(p[k]) === val ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{lab}</button>
        ))}
      </div>
    </div>
  )
  const numF = (label: string, k: keyof CalcParams, suffix?: string, step = '1') => (
    <div key={k}>
      <span className="block text-xs font-medium text-gray-500 mb-1.5">{label}</span>
      <NumberStepper value={Number(p[k] ?? 0)} onChange={v => set(k, v)} step={parseFloat(step)} suffix={suffix} />
    </div>
  )
  const toggle = (label: string, k: keyof CalcParams, hint?: string) => (
    <button type="button" onClick={() => set(k, !p[k])}
      className={`flex items-center justify-between w-full px-3.5 py-2.5 rounded-xl border text-sm transition-all ${p[k] ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}>
      <span className="text-left"><span className="font-medium text-gray-700">{label}</span>{hint && <span className="block text-[11px] text-gray-400">{hint}</span>}</span>
      <span className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${p[k] ? 'bg-orange-500' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${p[k] ? 'left-4.5' : 'left-0.5'}`} style={{ left: p[k] ? 18 : 2 }} />
      </span>
    </button>
  )
  const SectionLabel = ({ children }: { children: ReactNode }) => (
    <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2.5 mt-1">{children}</div>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-6">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <h2 className="text-lg font-bold text-gray-900">📊 {editCalc ? t('rechnerWizard.editCalculation', 'Berechnung bearbeiten') : t('rechnerWizard.yieldCalculation', 'Rendite-Rechnung')} — {lead.first_name} {lead.last_name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* ── Objekte ── */}
          {editCalc ? (
            <div>
              <SectionLabel>{t('rechnerWizard.objectsLabel', 'Objekt(e)')}</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {editCalc.content.items.map((it, i) => (
                  <span key={i} className="inline-flex items-center text-xs bg-gray-100 rounded-xl px-2.5 py-1.5">{it.label}</span>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-2">{t('rechnerWizard.objectsUnchangedHint', 'Objekte bleiben gleich — du änderst nur die Werte unten und speicherst.')}</p>
            </div>
          ) : (
          <div>
            <SectionLabel>{t('rechnerWizard.objectLabel', 'Objekt')}{p.dealType === 'single' ? t('rechnerWizard.objectSuffixSingle', '(e)') : t('rechnerWizard.objectSuffixPortfolio', ' / Portfolio')}</SectionLabel>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <span className="block text-xs font-medium text-gray-500 mb-1.5">{t('rechnerWizard.developerLabel', 'Developer')}</span>
                <CustomSelect
                  value={developer}
                  onChange={v => { setDeveloper(v); setProjectId('') }}
                  options={[{ value: '', label: t('rechnerWizard.allOption', 'Alle') },
                    ...[...new Set(projects.map(pr => pr.developer).filter(Boolean))].sort().map(d => ({ value: d as string, label: d as string }))]}
                />
              </div>
              <div>
                <span className="block text-xs font-medium text-gray-500 mb-1.5">{t('rechnerWizard.projectLabel', 'Projekt')}</span>
                <CustomSelect
                  value={projectId}
                  onChange={setProjectId}
                  placeholder={t('rechnerWizard.selectPlaceholder', '— wählen —')}
                  options={projects.filter(pr => !developer || pr.developer === developer).map(pr => ({ value: pr.id, label: pr.name }))}
                />
              </div>
            </div>
            {units.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3 max-h-36 overflow-y-auto">
                {units.map(u => (
                  <button key={u.id} onClick={() => toggleU(u.id)}
                    className={`text-xs px-2.5 py-1.5 rounded-xl border transition-colors ${sel.has(u.id) ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600 hover:border-orange-300'}`}>
                    {u.unit_number}{u.bedrooms != null ? ` · ${t('rechnerWizard.bedroomsAbbrev', '{{count}} SZ', { count: u.bedrooms })}` : ''}{u.price_net ? ` · ${eur0(u.price_net / 1000)}k` : ''}
                  </button>
                ))}
              </div>
            )}
            {units.length > 0 && (
              <button onClick={addToBasket} disabled={!sel.size} className="mt-2.5 px-3.5 py-1.5 rounded-xl text-white text-sm font-medium disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
                {t('rechnerWizard.addToSelection', '+ {{count}} zur Auswahl', { count: sel.size })}
              </button>
            )}
            {basket.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {basket.map(b => (
                  <span key={b.unit.id} className="inline-flex items-center gap-1.5 text-xs bg-gray-100 rounded-xl px-2.5 py-1.5">
                    {b.project.name} · {b.unit.unit_number}
                    <button onClick={() => removeFromBasket(b.unit.id)} className="text-gray-400 hover:text-red-500">×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          )}

          {/* ── Kauf ── */}
          <div>
            <SectionLabel>{t('rechnerWizard.purchaseSection', 'Kauf')}</SectionLabel>
            <div className="grid sm:grid-cols-3 gap-3">
              {seg(t('rechnerWizard.dealTypeLabel', 'Kaufart'), 'dealType', [['single', t('rechnerWizard.dealTypeSingle', 'Einzelkauf')], ['share', t('rechnerWizard.dealTypeShare', 'Share-Deal')]])}
              {numF(t('rechnerWizard.discountLabel', 'Rabatt'), 'discountPct', '%', '0.5')}
              {numF(t('rechnerWizard.furnitureCostLabel', 'Einrichtungspaket'), 'furnCost', '€', '500')}
            </div>
            {p.dealType === 'share' && (
              <div className="grid sm:grid-cols-4 gap-3 mt-3 p-3 rounded-xl bg-violet-50 border border-violet-100">
                {numF(t('rechnerWizard.portfolioNetLabel', 'Portfolio netto'), 'sdPrice', '€', '1000')}
                {numF(t('rechnerWizard.totalAreaLabel', 'Fläche gesamt'), 'sdSqm', 'm²')}
                {numF(t('rechnerWizard.unitCountLabel', 'Anzahl WE'), 'sdNum')}
                {numF(t('rechnerWizard.flatTaxLabel', 'Flat-Tax'), 'sdTaxRate', '%', '0.5')}
              </div>
            )}
            <div className="grid sm:grid-cols-3 gap-3 mt-3 items-stretch">
              {toggle(t('rechnerWizard.freeFurnitureLabel', 'Einrichtung kostenfrei'), 'furnFree', t('rechnerWizard.freeFurnitureHint', 'vom Developer geschenkt'))}
              {numF(t('rechnerWizard.purchaseMonthLabel', 'Kaufmonat'), 'month', '1-12')}
              {numF(t('rechnerWizard.purchaseYearLabel', 'Kaufjahr'), 'year')}
            </div>
          </div>

          {/* ── Finanzierung ── */}
          <div>
            <SectionLabel>{t('rechnerWizard.financingSection', 'Finanzierung')}</SectionLabel>
            <div className="grid sm:grid-cols-3 gap-3">
              {seg(t('rechnerWizard.financingLabel', 'Finanzierung'), 'fin', [['yes', t('rechnerWizard.financingCredit', 'Kredit')], ['no', t('rechnerWizard.financingCash', 'Barkauf')]])}
              {numF(t('rechnerWizard.equityLabel', 'Eigenkapital'), 'equity', '€', '1000')}
              {numF(t('rechnerWizard.interestRateLabel', 'Zinssatz'), 'interestPct', '%', '0.1')}
            </div>
            {p.fin === 'yes' && (
              <div className="grid sm:grid-cols-3 gap-3 mt-3">
                {numF(t('rechnerWizard.termLabel', 'Laufzeit'), 'termYears', t('rechnerWizard.yearsSuffix', 'Jahre'))}
                {seg(t('rechnerWizard.amortizationLabel', 'Tilgung'), 'mode', [['ann', t('rechnerWizard.amortizationAnnuity', 'Annuität')], ['tilg', t('rechnerWizard.amortizationFixedPct', 'Fix %')]])}
                {p.mode === 'tilg' && numF(t('rechnerWizard.amortizationRateLabel', 'Tilgungssatz'), 'amortPct', '%', '0.1')}
              </div>
            )}
          </div>

          {/* ── Vermietung & Steuer ── */}
          <div>
            <SectionLabel>{t('rechnerWizard.rentalTaxSection', 'Vermietung & Steuer')}</SectionLabel>
            <div className="grid sm:grid-cols-3 gap-3">
              {seg(t('rechnerWizard.rentalLabel', 'Vermietung'), 'letType', [['short', t('rechnerWizard.rentalShortTerm', 'Kurzzeit')], ['long', t('rechnerWizard.rentalLongTerm', 'Langzeit')]])}
              {seg(t('rechnerWizard.taxResidenceLabel', 'Steuersitz'), 'res', [['de', t('rechnerWizard.taxResidenceDe', 'Deutschland')], ['cy', t('rechnerWizard.taxResidenceCy', 'Zypern')]])}
              {p.res === 'de' ? numF(t('rechnerWizard.deMarginalTaxLabel', 'DE-Grenzsteuer'), 'deTaxPct', '%') : numF(t('rechnerWizard.cyExistingIncomeLabel', 'CY Bestandseinkommen'), 'cyBI', '€', '500')}
            </div>
            <div className="grid sm:grid-cols-4 gap-3 mt-3">
              {numF(t('rechnerWizard.grossYieldLabel', 'Bruttorendite'), 'yieldPct', '%', '0.1')}
              {numF(t('rechnerWizard.rentGrowthLabel', 'Mietsteigerung'), 'rentGrowth', '%', '0.1')}
              {numF(p.letType === 'short' ? t('rechnerWizard.holidayManagementLabel', 'Ferienverwaltung') : t('rechnerWizard.managementLabel', 'Verwaltung'), 'mgmtPct', '%', '0.5')}
              {numF(t('rechnerWizard.appreciationLabel', 'Wertsteigerung'), 'appreciationPct', '%', '0.1')}
            </div>
            {p.letType === 'short' && <div className="mt-3">{toggle(`🏨 ${t('rechnerWizard.hotelConceptLabel', 'Hotelkonzept')}`, 'hotelConcept', t('rechnerWizard.hotelConceptHint', 'Verwaltung übernimmt kompletten Hotelservice'))}</div>}
          </div>

          {/* ── Sondertilgung (erweitert) ── */}
          <div>
            <button onClick={() => setShowAdvanced(s => !s)} className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400 hover:text-gray-600">
              {showAdvanced ? '▾' : '▸'} {t('rechnerWizard.specialAmortizationSection', 'Sondertilgung & MwSt-Erstattung')}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <button onClick={applyVatPrepay} className="text-xs font-medium px-3 py-1.5 rounded-xl border border-green-300 text-green-700 hover:bg-green-50">
                  💰 {t('rechnerWizard.applyVatPrepayButton', 'USt.-Erstattung als Sondertilgung einsetzen')}
                </button>
                <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
                  {p.ppVals.map((v, i) => (
                    <div key={i}>
                      <span className="block text-[10px] text-gray-400 text-center">{t('rechnerWizard.yearAbbrev', 'J{{num}}', { num: i + 1 })}</span>
                      <input type="text" inputMode="decimal" value={v || ''} placeholder="0"
                        onChange={e => { const pp = [...p.ppVals]; pp[i] = num(e.target.value); set('ppVals', pp) }}
                        className="w-full border border-gray-200 rounded-lg px-1 py-1.5 text-xs text-center focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400">{t('rechnerWizard.specialAmortizationHint', 'Sondertilgungen je Jahr (€) senken die Restschuld und erhöhen das Eigenkapital. Bei Kurzzeit-Vermietung kann die einmalige USt.-Erstattung automatisch als Sondertilgung eingesetzt werden.')}</p>
              </div>
            )}
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-100 sticky bottom-0 bg-white rounded-b-2xl">
          <p className="text-xs text-gray-400">{editCalc ? t('rechnerWizard.editHint', 'Werte ändern → Speichern aktualisiert dieselbe Berechnung.') : basket.length > 1 ? t('rechnerWizard.multipleUnitsHint', 'Mehrere Wohnungen → Vergleich.') : t('rechnerWizard.autoPriceHint', 'Kaufpreis je Wohnung kommt automatisch aus dem CRM.')}</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('rechnerWizard.cancelButton', 'Abbrechen')}</button>
            <button onClick={() => void generate()} disabled={busy || (!editCalc && p.dealType === 'single' && !basket.length)}
              className="px-5 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
              {busy ? (editCalc ? t('rechnerWizard.savingButton', 'Speichert…') : t('rechnerWizard.creatingButton', 'Erstellt…')) : editCalc ? t('rechnerWizard.saveButton', 'Speichern') : basket.length > 1 ? t('rechnerWizard.createComparisonButton', 'Vergleich erstellen') : t('rechnerWizard.createInvoiceButton', 'Rechnung erstellen')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
