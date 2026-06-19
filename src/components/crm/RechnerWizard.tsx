import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { DEFAULT_PARAMS, type CalcParams, type CalcItem } from '../../lib/rechner'

// ── Rechner-Wizard ───────────────────────────────────────────────────────────
// Aus dem Kunden heraus: Projekt → Wohnung(en) (projektübergreifend) → mit/ohne
// Berechnung. Mit Berechnung: globale Annahmen ausfüllen, Kaufpreis je Wohnung kommt
// aus dem CRM. Erzeugt eine property_calculations-Zeile + öffentlichen HTML-Link
// (Einzel oder Vergleich, je nach Anzahl).

interface LeadLite { id: string; first_name: string; last_name: string }
interface ProjectRow { id: string; name: string; developer: string | null; location: string | null }
interface UnitRow { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; terrace_sqm: number | null; price_net: number | null; price_gross: number | null; floor: number | null; type: string | null }
interface BasketItem { project: ProjectRow; unit: UnitRow }

const num = (v: string, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n }

export default function RechnerWizard({ lead, onClose, onDone }: { lead: LeadLite; onClose: () => void; onDone: (msg: string) => void }) {
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [projectId, setProjectId] = useState('')
  const [units, setUnits] = useState<UnitRow[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [basket, setBasket] = useState<BasketItem[]>([])
  const [withCalc, setWithCalc] = useState(true)
  const [p, setP] = useState<CalcParams>({ ...DEFAULT_PARAMS, month: 6, year: new Date().getFullYear() })
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

  const project = projects.find(p => p.id === projectId)
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const addToBasket = () => {
    if (!project) return
    const adds = units.filter(u => sel.has(u.id) && !basket.some(b => b.unit.id === u.id)).map(u => ({ project, unit: u }))
    setBasket(b => [...b, ...adds]); setSel(new Set())
  }
  const removeFromBasket = (uid: string) => setBasket(b => b.filter(x => x.unit.id !== uid))

  const set = (k: keyof CalcParams, v: number | string | boolean) => setP(prev => ({ ...prev, [k]: v }) as CalcParams)

  const generate = async () => {
    if (!basket.length) { setErr('Bitte mindestens eine Wohnung wählen.'); return }
    setBusy(true); setErr('')
    try {
      const items: CalcItem[] = basket.map(b => {
        const u = b.unit
        const item: CalcItem = {
          label: `${b.project.name} · ${u.unit_number}`, project: b.project.name, unit: u.unit_number,
          bedrooms: u.bedrooms, size_sqm: u.size_sqm, terrace_sqm: u.terrace_sqm, floor: u.floor,
          price_net: u.price_net, price_gross: u.price_gross,
          location: b.project.location ?? undefined, developer: b.project.developer ?? undefined,
        }
        if (withCalc) {
          item.params = { ...p, dealType: 'single', priceNet: u.price_net ?? p.priceNet, bedrooms: u.bedrooms ?? 2 }
        }
        return item
      })
      const content = { with_calc: withCalc, recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), items }
      const { data, error } = await supabase.from('property_calculations').insert({
        lead_id: lead.id, recipient_name: content.recipient_name,
        title: basket.length > 1 ? 'Immobilienvergleich' : `Rechnung ${basket[0].project.name} ${basket[0].unit.unit_number}`,
        with_calc: withCalc, content,
      }).select('token').single()
      if (error) throw new Error(error.message)
      const token = (data as { token: string }).token
      const url = `${window.location.origin}/rechnung/${token}`
      window.open(url, '_blank')
      onDone(`${basket.length > 1 ? 'Vergleich' : 'Rechnung'} erstellt — Link geöffnet.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Fehler')
    } finally { setBusy(false) }
  }

  const inputCls = 'w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-orange-400'
  // Plain Render-Funktionen (KEINE verschachtelten Komponenten — sonst Fokus-Verlust pro Tastendruck)
  const numF = (label: string, k: keyof CalcParams, step = '1', suffix?: string) => (
    <label key={k} className="block">
      <span className="block text-xs text-gray-500 mb-1">{label}{suffix ? ` (${suffix})` : ''}</span>
      <input type="number" step={step} value={String(p[k] ?? '')} onChange={e => set(k, num(e.target.value))} className={inputCls} />
    </label>
  )
  const seg = (label: string, k: keyof CalcParams, opts: [string, string][]) => (
    <div key={k}>
      <span className="block text-xs text-gray-500 mb-1">{label}</span>
      <div className="flex rounded-lg overflow-hidden border border-gray-300">
        {opts.map(([val, lab]) => (
          <button key={val} type="button" onClick={() => set(k, val)}
            className={`flex-1 px-2 py-1.5 text-xs font-medium ${String(p[k]) === val ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-orange-50'}`}>{lab}</button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">📊 Rendite-Rechnung / Vergleich</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Projekt + Units */}
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">Projekt</span>
              <select value={projectId} onChange={e => setProjectId(e.target.value)} className={inputCls}>
                <option value="">— wählen —</option>
                {projects.map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
            </label>
            {units.length > 0 && (
              <div className="flex items-end">
                <button onClick={addToBasket} disabled={!sel.size} className="px-4 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
                  + {sel.size} zur Auswahl
                </button>
              </div>
            )}
          </div>
          {units.length > 0 && (
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
              {units.map(u => (
                <button key={u.id} onClick={() => toggle(u.id)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border ${sel.has(u.id) ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600 hover:border-orange-300'}`}>
                  {u.unit_number}{u.bedrooms != null ? ` · ${u.bedrooms} SZ` : ''}{u.price_net ? ` · ${Math.round(u.price_net / 1000)}k` : ''}
                </button>
              ))}
            </div>
          )}

          {/* Auswahl-Korb */}
          {basket.length > 0 && (
            <div className="border border-gray-200 rounded-xl p-3">
              <div className="text-xs font-semibold text-gray-500 mb-2">Auswahl ({basket.length})</div>
              <div className="flex flex-wrap gap-2">
                {basket.map(b => (
                  <span key={b.unit.id} className="inline-flex items-center gap-1.5 text-xs bg-gray-100 rounded-lg px-2.5 py-1">
                    {b.project.name} · {b.unit.unit_number}
                    <button onClick={() => removeFromBasket(b.unit.id)} className="text-gray-400 hover:text-red-500">×</button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Mit / ohne Berechnung */}
          <div className="flex rounded-lg overflow-hidden border border-gray-300 w-full max-w-sm">
            <button onClick={() => setWithCalc(true)} className={`flex-1 px-3 py-2 text-sm font-medium ${withCalc ? 'bg-orange-500 text-white' : 'bg-white text-gray-600'}`}>Mit Berechnung</button>
            <button onClick={() => setWithCalc(false)} className={`flex-1 px-3 py-2 text-sm font-medium ${!withCalc ? 'bg-orange-500 text-white' : 'bg-white text-gray-600'}`}>Ohne (nur Objekte)</button>
          </div>

          {/* Parameter */}
          {withCalc && (
            <div className="space-y-4 border-t border-gray-100 pt-4">
              <div className="grid sm:grid-cols-3 gap-3">
                {seg('Steuersitz', 'res', [['de', 'Deutschland'], ['cy', 'Zypern']])}
                {seg('Finanzierung', 'fin', [['yes', 'Ja'], ['no', 'Cash']])}
                {seg('Vermietung', 'letType', [['short', 'Kurzzeit'], ['long', 'Langzeit']])}
                {seg('Tilgung', 'mode', [['ann', 'Annuität'], ['tilg', 'Fix %']])}
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                {numF('Eigenkapital', 'equity', '1000', '€')}
                {numF('Zinssatz', 'interestPct', '0.1', '%')}
                {numF('Laufzeit', 'termYears', '1', 'Jahre')}
                {numF('Bruttomietrendite', 'yieldPct', '0.1', '%')}
                {numF('Mietsteigerung', 'rentGrowth', '0.1', '%')}
                {numF('Verwaltung', 'mgmtPct', '0.5', '%')}
                {numF('Wertsteigerung', 'appreciationPct', '0.1', '%')}
                {p.res === 'de' && numF('DE-Steuersatz', 'deTaxPct', '1', '%')}
                {p.mode === 'tilg' && numF('Tilgung', 'amortPct', '0.1', '%')}
                {numF('Kaufmonat', 'month', '1', '1-12')}
                {numF('Kaufjahr', 'year', '1')}
                {numF('Einrichtung', 'furnCost', '500', '€')}
              </div>
              <p className="text-[11px] text-gray-400">Der Kaufpreis wird je Wohnung automatisch aus dem CRM übernommen. Diese Annahmen gelten für alle gewählten Wohnungen.</p>
            </div>
          )}

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => void generate()} disabled={busy || !basket.length}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {busy ? 'Erstellt…' : basket.length > 1 ? 'Vergleich erstellen' : 'Rechnung erstellen'}
          </button>
        </div>
      </div>
    </div>
  )
}
