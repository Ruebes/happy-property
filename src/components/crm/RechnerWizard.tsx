import { useState, useEffect, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import { DEFAULT_PARAMS, compute, type CalcParams, type CalcItem } from '../../lib/rechner'

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

export default function RechnerWizard({ lead, onClose, onDone }: { lead: LeadLite; onClose: () => void; onDone: (msg: string) => void }) {
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
    if (vatIdx < 0) { setErr('Keine USt.-Erstattung berechnet — dafür Kurzzeit-Vermietung wählen.'); return }
    const pp = [...p.ppVals]; pp[vatIdx] = Math.round(preview.vatAmt)
    setP(prev => ({ ...prev, ppVals: pp })); setShowAdvanced(true); setErr('')
  }

  const generate = async () => {
    if (p.dealType === 'single' && !basket.length) { setErr('Bitte mindestens eine Wohnung wählen.'); return }
    setBusy(true); setErr('')
    try {
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
      onDone(`${items.length > 1 ? 'Vergleich' : 'Rechnung'} erstellt — Link geöffnet.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Fehler')
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
      <div className="relative">
        <input type="number" step={step} value={String(p[k] ?? '')} onChange={e => set(k, num(e.target.value))}
          className="w-full border border-gray-200 rounded-xl pl-3 pr-9 py-2.5 text-sm focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
        {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">{suffix}</span>}
      </div>
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
          <h2 className="text-lg font-bold text-gray-900">📊 Rendite-Rechnung — {lead.first_name} {lead.last_name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* ── Objekte ── */}
          <div>
            <SectionLabel>Objekt{p.dealType === 'single' ? '(e)' : ' / Portfolio'}</SectionLabel>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <span className="block text-xs font-medium text-gray-500 mb-1.5">Developer</span>
                <select value={developer} onChange={e => { setDeveloper(e.target.value); setProjectId('') }}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-400 bg-white">
                  <option value="">Alle</option>
                  {[...new Set(projects.map(pr => pr.developer).filter(Boolean))].sort().map(d => <option key={d} value={d as string}>{d}</option>)}
                </select>
              </div>
              <div>
                <span className="block text-xs font-medium text-gray-500 mb-1.5">Projekt</span>
                <select value={projectId} onChange={e => setProjectId(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-400 bg-white">
                  <option value="">— wählen —</option>
                  {projects.filter(pr => !developer || pr.developer === developer).map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                </select>
              </div>
            </div>
            {units.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3 max-h-36 overflow-y-auto">
                {units.map(u => (
                  <button key={u.id} onClick={() => toggleU(u.id)}
                    className={`text-xs px-2.5 py-1.5 rounded-xl border transition-colors ${sel.has(u.id) ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600 hover:border-orange-300'}`}>
                    {u.unit_number}{u.bedrooms != null ? ` · ${u.bedrooms} SZ` : ''}{u.price_net ? ` · ${eur0(u.price_net / 1000)}k` : ''}
                  </button>
                ))}
              </div>
            )}
            {units.length > 0 && (
              <button onClick={addToBasket} disabled={!sel.size} className="mt-2.5 px-3.5 py-1.5 rounded-xl text-white text-sm font-medium disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
                + {sel.size} zur Auswahl
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

          {/* ── Kauf ── */}
          <div>
            <SectionLabel>Kauf</SectionLabel>
            <div className="grid sm:grid-cols-3 gap-3">
              {seg('Kaufart', 'dealType', [['single', 'Einzelkauf'], ['share', 'Share-Deal']])}
              {numF('Rabatt', 'discountPct', '%', '0.5')}
              {numF('Einrichtungspaket', 'furnCost', '€', '500')}
            </div>
            {p.dealType === 'share' && (
              <div className="grid sm:grid-cols-4 gap-3 mt-3 p-3 rounded-xl bg-violet-50 border border-violet-100">
                {numF('Portfolio netto', 'sdPrice', '€', '1000')}
                {numF('Fläche gesamt', 'sdSqm', 'm²')}
                {numF('Anzahl WE', 'sdNum')}
                {numF('Flat-Tax', 'sdTaxRate', '%', '0.5')}
              </div>
            )}
            <div className="grid sm:grid-cols-3 gap-3 mt-3 items-stretch">
              {toggle('Einrichtung kostenfrei', 'furnFree', 'vom Developer geschenkt')}
              {numF('Kaufmonat', 'month', '1-12')}
              {numF('Kaufjahr', 'year')}
            </div>
          </div>

          {/* ── Finanzierung ── */}
          <div>
            <SectionLabel>Finanzierung</SectionLabel>
            <div className="grid sm:grid-cols-3 gap-3">
              {seg('Finanzierung', 'fin', [['yes', 'Kredit'], ['no', 'Barkauf']])}
              {numF('Eigenkapital', 'equity', '€', '1000')}
              {numF('Zinssatz', 'interestPct', '%', '0.1')}
            </div>
            {p.fin === 'yes' && (
              <div className="grid sm:grid-cols-3 gap-3 mt-3">
                {numF('Laufzeit', 'termYears', 'Jahre')}
                {seg('Tilgung', 'mode', [['ann', 'Annuität'], ['tilg', 'Fix %']])}
                {p.mode === 'tilg' && numF('Tilgungssatz', 'amortPct', '%', '0.1')}
              </div>
            )}
          </div>

          {/* ── Vermietung & Steuer ── */}
          <div>
            <SectionLabel>Vermietung & Steuer</SectionLabel>
            <div className="grid sm:grid-cols-3 gap-3">
              {seg('Vermietung', 'letType', [['short', 'Kurzzeit'], ['long', 'Langzeit']])}
              {seg('Steuersitz', 'res', [['de', 'Deutschland'], ['cy', 'Zypern']])}
              {p.res === 'de' ? numF('DE-Grenzsteuer', 'deTaxPct', '%') : numF('CY Bestandseinkommen', 'cyBI', '€', '500')}
            </div>
            <div className="grid sm:grid-cols-4 gap-3 mt-3">
              {numF('Bruttorendite', 'yieldPct', '%', '0.1')}
              {numF('Mietsteigerung', 'rentGrowth', '%', '0.1')}
              {numF(p.letType === 'short' ? 'Ferienverwaltung' : 'Verwaltung', 'mgmtPct', '%', '0.5')}
              {numF('Wertsteigerung', 'appreciationPct', '%', '0.1')}
            </div>
            {p.letType === 'short' && <div className="mt-3">{toggle('🏨 Hotelkonzept', 'hotelConcept', 'Verwaltung übernimmt kompletten Hotelservice')}</div>}
          </div>

          {/* ── Sondertilgung (erweitert) ── */}
          <div>
            <button onClick={() => setShowAdvanced(s => !s)} className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400 hover:text-gray-600">
              {showAdvanced ? '▾' : '▸'} Sondertilgung & MwSt-Erstattung
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <button onClick={applyVatPrepay} className="text-xs font-medium px-3 py-1.5 rounded-xl border border-green-300 text-green-700 hover:bg-green-50">
                  💰 USt.-Erstattung als Sondertilgung einsetzen
                </button>
                <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
                  {p.ppVals.map((v, i) => (
                    <div key={i}>
                      <span className="block text-[10px] text-gray-400 text-center">J{i + 1}</span>
                      <input type="number" step="500" value={v || ''} placeholder="0"
                        onChange={e => { const pp = [...p.ppVals]; pp[i] = num(e.target.value); set('ppVals', pp) }}
                        className="w-full border border-gray-200 rounded-lg px-1 py-1 text-xs text-center focus:outline-none focus:border-orange-400" />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400">Sondertilgungen je Jahr (€) senken die Restschuld und erhöhen das Eigenkapital. Bei Kurzzeit-Vermietung kann die einmalige USt.-Erstattung automatisch als Sondertilgung eingesetzt werden.</p>
              </div>
            )}
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-100 sticky bottom-0 bg-white rounded-b-2xl">
          <p className="text-xs text-gray-400">{basket.length > 1 ? 'Mehrere Wohnungen → Vergleich.' : 'Kaufpreis je Wohnung kommt automatisch aus dem CRM.'}</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">Abbrechen</button>
            <button onClick={() => void generate()} disabled={busy || (p.dealType === 'single' && !basket.length)}
              className="px-5 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
              {busy ? 'Erstellt…' : basket.length > 1 ? 'Vergleich erstellen' : 'Rechnung erstellen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
