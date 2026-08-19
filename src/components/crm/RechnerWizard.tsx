import { useState, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { createCalcOutboxDraft } from '../../lib/calcOutbox'
import { DEFAULT_PARAMS, compute, type CalcParams, type CalcItem, seasonBreakdown, applySeason } from '../../lib/rechner'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'

// ── Rendite-Rechner-Wizard ───────────────────────────────────────────────────
// Voller Funktionsumfang des Original-Rechners (1:1-Engine): Einzelkauf + Share-Deal,
// Rabatt, Einrichtung (kostenfrei), MwSt-als-Sondertilgung + Sondertilgung J1-J10,
// Hotelkonzept, CY/DE-Steuer. Projekte/Wohnungen aus dem CRM; Kaufpreis automatisch.
// Erzeugt eine property_calculations-Zeile + öffentlichen HTML-Link (Einzel/Vergleich).

interface LeadLite { id: string; first_name: string; last_name: string }
interface ProjectRow { id: string; name: string; developer: string | null; location: string | null; furniture_cost: number | null; furniture_included: boolean | null }
interface UnitRow { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; terrace_sqm: number | null; price_net: number | null; price_gross: number | null; floor: number | null; type: string | null }
interface BasketItem { project: ProjectRow; unit: UnitRow }

const num = (v: string, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n }
const eur0 = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n))

// Objektwerte: Vermietungsart, Saisonmodell, Verwaltung, Einrichtung.
interface PerObj { letType: 'short' | 'long'; occ: number; adr: number; mgmtPct: number; hotel: boolean; furnCost: number; furnFree: boolean }
const perObjFrom = (pr?: Partial<CalcParams> | null): PerObj => ({
  letType: pr?.letType === 'long' ? 'long' : 'short',
  occ: pr?.season?.totalOcc ?? 0,
  adr: pr?.season?.adrHigh ?? 0,
  mgmtPct: pr?.mgmtPct ?? 25,
  hotel: !!pr?.hotelConcept,
  furnCost: pr?.furnCost ?? 0,
  furnFree: !!pr?.furnFree,
})
const applyPerObj = (base: CalcParams, o: PerObj): CalcParams => ({
  ...base,
  letType: o.letType,
  season: o.letType === 'short' && o.occ > 0 && o.adr > 0 ? { totalOcc: o.occ, adrHigh: o.adr } : null,
  mgmtPct: o.mgmtPct,
  hotelConcept: o.letType === 'short' ? o.hotel : false,
  furnCost: o.furnCost,
  furnFree: o.furnFree,
})

export default function RechnerWizard({ lead, onClose, onDone, editCalc }: { lead: LeadLite; onClose: () => void; onDone: (msg: string) => void; editCalc?: { token: string; content: { items: CalcItem[]; recipient_name?: string } } }) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [developer, setDeveloper] = useState('')
  const [projectId, setProjectId] = useState('')
  const [units, setUnits] = useState<UnitRow[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [basket, setBasket] = useState<BasketItem[]>([])
  // Bearbeiten: die schon enthaltenen Objekte. Frueher waren sie fest verdrahtet -
  // Sven 18.8.: "ich wuerde gern noch eine weitere Immobilie nur als Rechnung
  // hinzufuegen ... so dass auch im Postausgang weitere Objekte hinzugefuegt werden
  // koennen". Jetzt sind sie eine Liste, die waechst und schrumpft.
  const [keptItems, setKeptItems] = useState<CalcItem[]>([])
  // Werte, die AM OBJEKT haengen und nicht global gelten duerfen. Vorher stuelpte
  // das Speichern die Wizard-Werte ueber jedes Objekt - Sven trug fuer Kuutio 55 %
  // Auslastung ein und Mamba verlor damit seine 70 % (18.8.). Ergebnis: beide
  // Wohnungen hatten dieselbe Miete und die billigere gewann scheinbar die Rendite.
  const [perObj, setPerObj] = useState<Record<string, PerObj>>({})
  const [p, setP] = useState<CalcParams>({ ...DEFAULT_PARAMS, month: 6, year: new Date().getFullYear() })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { void (async () => {
    const { data } = await supabase.from('crm_projects').select('id, name, developer, location, furniture_cost, furniture_included').order('name')
    setProjects((data ?? []) as ProjectRow[])
  })() }, [])

  // Bearbeiten: bestehende Berechnung laden → geteilte Parameter (Eigenkapital, Zins …)
  // aus dem ersten Objekt vorbefüllen. Die Objekte selbst bleiben unverändert.
  useEffect(() => {
    const it0 = editCalc?.content?.items?.[0]
    if (it0?.params) setP({ ...DEFAULT_PARAMS, ...it0.params })
    const its = editCalc?.content?.items ?? []
    setKeptItems(its)
    setPerObj(Object.fromEntries(its.map((it, i) => [`k${i}`, perObjFrom(it.params)])))
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
    // Einrichtung kommt aus dem PROJEKT, nicht aus dem globalen Feld: bei Mamba ist
    // sie im Kaufpreis enthalten (600.000 netto inkl. Möbel), bei BAIA kostet sie
    // 25.000 extra. Vorher stülpte der Wizard denselben Wert über jede Wohnung -
    // Mamba trug dadurch 25.000 netto (29.750 brutto) zu Unrecht mit (Sven 18.8.).
    setPerObj(prev => {
      const n = { ...prev }
      for (const a of adds) {
        if (n[`b${a.unit.id}`]) continue
        const pr = a.project
        n[`b${a.unit.id}`] = {
          ...perObjFrom(p),
          // NIE auf das globale Feld zurückfallen: ein dort stehengebliebener Wert
          // landete sonst bei jeder Wohnung, auch wenn im Projekt nie einer
          // hinterlegt war (Sven 18.8.: "es kann nicht sein, dass plötzlich ein
          // Preis für Möbel auftaucht, den wir vorher nie definiert haben").
          furnCost: pr.furniture_included ? 0 : (pr.furniture_cost ?? 0),
          furnFree: !!pr.furniture_included,
        }
      }
      return n
    })
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
        // Bestehende Objekte: Preis/Schlafzimmer je Objekt bewahren, geteilte Werte neu.
        // Lage/Bautraeger haengen als Kopie am Objekt. Wurde das Projekt erst NACH
        // dem Erstellen der Berechnung gepflegt (Fall Mamba, Sven 18.8.), blieb die
        // Kopie leer und der Kunde sah einen Strich. Beim Speichern deshalb immer
        // aus dem Projekt nachziehen.
        const enrich = (it: CalcItem): CalcItem => {
          const pr = projects.find(x => x.name === it.project)
          return { ...it, location: it.location ?? pr?.location ?? undefined, developer: it.developer ?? pr?.developer ?? undefined }
        }
        const kept = keptItems.map((it, i) => ({
          ...enrich(it),
          params: applyPerObj(
            { ...p, priceNet: it.params?.priceNet ?? p.priceNet, bedrooms: it.params?.bedrooms ?? p.bedrooms, dealType: it.params?.dealType ?? p.dealType },
            perObj[`k${i}`] ?? perObjFrom(it.params),
          ),
        }))
        // Neu dazugewaehlte Objekte wie beim Ersterstellen aufbauen.
        const added: CalcItem[] = basket.map(b => {
          const u = b.unit
          return {
            label: `${b.project.name} · ${u.unit_number}`, project: b.project.name, unit: u.unit_number,
            bedrooms: u.bedrooms, size_sqm: u.size_sqm, terrace_sqm: u.terrace_sqm, floor: u.floor,
            price_net: u.price_net, price_gross: u.price_gross,
            location: b.project.location ?? undefined, developer: b.project.developer ?? undefined,
            params: applyPerObj({ ...p, dealType: 'single', priceNet: u.price_net ?? p.priceNet, bedrooms: u.bedrooms ?? 2 },
              perObj[`b${u.id}`] ?? perObjFrom(p)),
          }
        })
        if (!kept.length && !added.length) { setErr(t('rechnerWizard.selectAtLeastOneUnit', 'Bitte mindestens eine Wohnung wählen.')); setBusy(false); return }
        const recipient = editCalc.content.recipient_name ?? `${lead.first_name} ${lead.last_name}`.trim()
        const madeCalcs: Array<{ token: string; title: string }> = []

        // 1) Die bestehende Berechnung bleibt, was sie ist - nur Werte neu, Objekte
        //    ggf. entfernt. Ihr Link ist beim Kunden und darf nie den Inhalt tauschen.
        if (kept.length) {
          const keptTitle = kept.length > 1 ? 'Immobilienvergleich' : `Rechnung ${kept[0].label}`
          const { error } = await supabase.from('property_calculations')
            .update({ content: { with_calc: true, recipient_name: recipient, items: kept }, title: keptTitle })
            .eq('token', editCalc.token)
          if (error) throw new Error(error.message)
          madeCalcs.push({ token: editCalc.token, title: keptTitle })
        }

        // 2) Jedes neu gewählte Objekt bekommt eine EIGENE Einzelrechnung -
        //    genau wie beim Sales-Deck-Weg (Sven 18.8.: "eine weitere Immobilie
        //    nur als Rechnung hinzufügen").
        for (const it of added) {
          const { data, error } = await supabase.from('property_calculations').insert({
            lead_id: lead.id, recipient_name: recipient, title: `Rechnung ${it.label}`, with_calc: true,
            content: { with_calc: true, recipient_name: recipient, items: [it] },
          }).select('token').single()
          if (error) throw new Error(error.message)
          madeCalcs.push({ token: (data as { token: string }).token, title: `Rechnung ${it.label}` })
        }

        // 3) Ab zwei Objekten IMMER zusätzlich der Vergleich - Sven 18.8.: bei
        //    mehreren Objekten soll der Immobilienvergleich Standard in der Mail sein.
        const allItems = [...kept, ...added]
        let cmpToken: string | null = null
        if (allItems.length > 1) {
          const { data, error } = await supabase.from('property_calculations').insert({
            lead_id: lead.id, recipient_name: recipient, title: 'Immobilienvergleich', with_calc: true,
            content: { with_calc: true, recipient_name: recipient, items: allItems },
          }).select('token').single()
          if (error) throw new Error(error.message)
          cmpToken = (data as { token: string }).token
          madeCalcs.push({ token: cmpToken, title: 'Immobilienvergleich' })
        }

        // Neue Objekte oder neuer Vergleich → frischer Mail-Entwurf im Postausgang.
        if (added.length || cmpToken) {
          await createCalcOutboxDraft({
            leadId: lead.id, firstName: lead.first_name, calcs: madeCalcs,
            replacesTokens: [editCalc.token],   // alten Entwurf ersetzen statt danebenlegen
          })
        }
        window.open(`${window.location.origin}/rechnung/${cmpToken ?? editCalc.token}`, '_blank')
        onDone(added.length
          ? t('rechnerWizard.calcExtended', '{{n}} Objekt(e) ergänzt - Vergleich und Mail-Entwurf liegen im Postausgang.', { n: added.length })
          : t('rechnerWizard.calculationUpdated', 'Berechnung aktualisiert.'))
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
            params: applyPerObj({ ...p, dealType: 'single', priceNet: u.price_net ?? p.priceNet, bedrooms: u.bedrooms ?? 2 },
              perObj[`b${u.id}`] ?? perObjFrom(p)),
          }
        })
      }
      const recipient = `${lead.first_name} ${lead.last_name}`.trim()
      const madeCalcs: Array<{ token: string; title: string }> = []
      // Je Objekt eine eigene Rechnung - der Kunde kann jede Wohnung fuer sich
      // ansehen. Bei Share-Deals bleibt es bei der einen Gesamtrechnung.
      const singles = p.dealType === 'share' ? [items] : items.map(it => [it])
      for (const group of singles) {
        const title = group.length > 1 ? 'Immobilienvergleich' : `Rechnung ${group[0].label}`
        const { data, error } = await supabase.from('property_calculations').insert({
          lead_id: lead.id, recipient_name: recipient, title, with_calc: true,
          content: { with_calc: true, recipient_name: recipient, items: group },
        }).select('token').single()
        if (error) throw new Error(error.message)
        madeCalcs.push({ token: (data as { token: string }).token, title })
      }
      // Ab zwei Objekten IMMER zusaetzlich der Vergleich (Sven 18.8.: Standard in der Mail).
      let token = madeCalcs[0].token
      if (items.length > 1 && p.dealType !== 'share') {
        const { data, error } = await supabase.from('property_calculations').insert({
          lead_id: lead.id, recipient_name: recipient, title: 'Immobilienvergleich', with_calc: true,
          content: { with_calc: true, recipient_name: recipient, items },
        }).select('token').single()
        if (error) throw new Error(error.message)
        token = (data as { token: string }).token
        madeCalcs.push({ token, title: 'Immobilienvergleich' })
      }
      // Wie bei Sales-Decks: fertigen Mail-Entwurf in den Postausgang legen (Sven 9.8.26)
      await createCalcOutboxDraft({ leadId: lead.id, firstName: lead.first_name, calcs: madeCalcs })
      const url = `${window.location.origin}/rechnung/${token}`
      window.open(url, '_blank')
      onDone(items.length > 1
        ? t('rechnerWizard.comparisonCreated', 'Vergleich erstellt — liegt im Postausgang zur Freigabe.')
        : t('rechnerWizard.invoiceCreated', 'Rechnung erstellt — liegt im Postausgang zur Freigabe.'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('rechnerWizard.genericError', 'Fehler'))
    } finally { setBusy(false) }
  }

  // Objektzeile: die Werte, die je Wohnung unterschiedlich sind. Ohne sie zog der
  // Wizard seine globalen Werte ueber alle Objekte - der Vergleich zeigte dann
  // fuer beide Wohnungen dieselbe Miete.
  const objRow = (key: string, label: string, src?: { furniture_cost: number | null; furniture_included: boolean | null }) => {
    const o = perObj[key] ?? perObjFrom(p)
    // Woher der Möbelwert kommt - damit nie unklar ist, ob eine Zahl aus dem
    // Projekt stammt oder von Hand gesetzt wurde.
    const furnSrc = !src ? null
      : src.furniture_included ? t('rechnerWizard.furnIncluded', 'laut Projekt im Kaufpreis enthalten')
      : src.furniture_cost != null ? t('rechnerWizard.furnFromProject', 'aus Projekt: {{v}} € netto', { v: src.furniture_cost.toLocaleString('de-DE') })
      : t('rechnerWizard.furnMissing', '⚠ im Projekt nicht hinterlegt - bitte dort pflegen')
    const upd = (patch: Partial<PerObj>) => setPerObj(prev => ({ ...prev, [key]: { ...o, ...patch } }))
    const cell = 'w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-orange-400'
    return (
      <div key={key} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium text-gray-800">{label}</span>
          <div className="flex gap-1">
            {(['short', 'long'] as const).map(lt => (
              <button key={lt} type="button" onClick={() => upd({ letType: lt })}
                className={`text-xs px-2.5 py-1 rounded-lg border ${o.letType === lt ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                style={o.letType === lt ? { backgroundColor: '#ff795d' } : undefined}>
                {lt === 'short' ? t('rechnerWizard.shortTerm', 'Kurzzeit') : t('rechnerWizard.longTerm', 'Langzeit')}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {o.letType === 'short' && (<>
            <label className="block"><span className="block text-[11px] text-gray-500 mb-0.5">{t('rechnerWizard.occLabel', 'Auslastung %')}</span>
              <input type="number" value={o.occ || ''} onChange={e => upd({ occ: Number(e.target.value) })} className={cell} placeholder="70" /></label>
            <label className="block"><span className="block text-[11px] text-gray-500 mb-0.5">{t('rechnerWizard.adrLabel', '€ / Nacht Hochsaison')}</span>
              <input type="number" value={o.adr || ''} onChange={e => upd({ adr: Number(e.target.value) })} className={cell} placeholder="400" /></label>
          </>)}
          <label className="block"><span className="block text-[11px] text-gray-500 mb-0.5">{t('rechnerWizard.mgmtLabel', 'Verwaltung % der Miete')}</span>
            <input type="number" value={o.mgmtPct} onChange={e => upd({ mgmtPct: Number(e.target.value) })} className={cell} /></label>
          <label className="block"><span className="block text-[11px] text-gray-500 mb-0.5">{t('rechnerWizard.furnLabel', 'Einrichtung € netto')}</span>
            <input type="number" value={o.furnCost} onChange={e => upd({ furnCost: Number(e.target.value) })} className={cell} /></label>
        </div>
        {furnSrc && <p className="text-[11px] text-gray-400 mt-1">{furnSrc}</p>}
        <div className="flex flex-wrap gap-4 mt-2">
          {o.letType === 'short' && (
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={o.hotel} onChange={e => upd({ hotel: e.target.checked })} className="accent-orange-500" />
              {t('rechnerWizard.hotelConcept', 'Hotelkonzept (Betreiber übernimmt)')}
            </label>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input type="checkbox" checked={o.furnFree} onChange={e => upd({ furnFree: e.target.checked })} className="accent-orange-500" />
            {t('rechnerWizard.furnFree', 'Einrichtung kostenfrei')}
          </label>
        </div>
      </div>
    )
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
          {editCalc && (
            <div>
              <SectionLabel>{t('rechnerWizard.objectsInCalc', 'Bereits in dieser Berechnung')}</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {keptItems.map((it, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 text-xs bg-gray-100 rounded-xl px-2.5 py-1.5">
                    {it.label}
                    <button onClick={() => setKeptItems(list => list.filter((_, j) => j !== i))}
                      title={t('rechnerWizard.removeObject', 'Objekt entfernen')} className="text-gray-400 hover:text-red-500">×</button>
                  </span>
                ))}
                {keptItems.length === 0 && (
                  <span className="text-xs text-gray-400">{t('rechnerWizard.noObjectsLeft', 'Kein Objekt mehr drin - unten mindestens eines wählen.')}</span>
                )}
              </div>
              <p className="text-[11px] text-gray-400 mt-2">{t('rechnerWizard.addMoreHint', 'Unten kannst du weitere Objekte dazunehmen. Aus einer Einzelrechnung wird dadurch automatisch ein Vergleich - der Link zum Kunden bleibt derselbe.')}</p>
              {keptItems.length > 0 && (
                <div className="space-y-2 mt-3">
                  {keptItems.map((it, i) => objRow(`k${i}`, it.label))}
                </div>
              )}
            </div>
          )}
          <div>
            <SectionLabel>{editCalc ? t('rechnerWizard.addObjectLabel', 'Weiteres Objekt hinzufügen') : `${t('rechnerWizard.objectLabel', 'Objekt')}${p.dealType === 'single' ? t('rechnerWizard.objectSuffixSingle', '(e)') : t('rechnerWizard.objectSuffixPortfolio', ' / Portfolio')}`}</SectionLabel>
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
              <div className="space-y-2 mt-3">
                {basket.map(b => objRow(`b${b.unit.id}`, `${b.project.name} · ${b.unit.unit_number}`,
                  { furniture_cost: b.project.furniture_cost, furniture_included: b.project.furniture_included }))}
              </div>
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
            <SectionLabel>{t('rechnerWizard.purchaseSection', 'Kauf')}</SectionLabel>
            <div className="grid sm:grid-cols-3 gap-3">
              {seg(t('rechnerWizard.dealTypeLabel', 'Kaufart'), 'dealType', [['single', t('rechnerWizard.dealTypeSingle', 'Einzelkauf')], ['share', t('rechnerWizard.dealTypeShare', 'Share-Deal')]])}
              {numF(t('rechnerWizard.discountLabel', 'Rabatt'), 'discountPct', '%', '0.5')}
              {/* Einrichtung steht je Objekt oben - ein globales Feld hat den Wert
                  frueher ueber alle Wohnungen gestuelpt. */}
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
            {p.letType === 'short' && p.dealType === 'single' && (
              <div className="mt-3 space-y-3">
                <button type="button" onClick={() => setP(prev => ({ ...prev, season: prev.season ? null : { totalOcc: 56, adrHigh: 120 } }))}
                  className={`flex items-center justify-between w-full px-3.5 py-2.5 rounded-xl border text-sm transition-all ${p.season ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}>
                  <span className="text-left"><span className="font-medium text-gray-700">🏖 {t('rechnerWizard.seasonLabel', 'Saisonmodell (4 Saisons)')}</span>
                    <span className="block text-[11px] text-gray-400">{t('rechnerWizard.seasonHint', 'Auslastung + Preis/Nacht statt pauschaler Bruttorendite')}</span></span>
                  <span className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${p.season ? 'bg-orange-500' : 'bg-gray-300'}`}>
                    <span className="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all" style={{ left: p.season ? 18 : 2 }} />
                  </span>
                </button>
                {p.season && (() => {
                  const sb = seasonBreakdown(p.season)
                  const effY = applySeason(p).yieldPct
                  return (
                    <div className="rounded-xl border border-orange-100 bg-orange-50/40 p-3 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <span className="block text-xs font-medium text-gray-500 mb-1.5">{t('rechnerWizard.seasonOcc', 'Gesamtauslastung (Jahr)')}</span>
                          <NumberStepper value={p.season.totalOcc} min={5} max={90} onChange={v => setP(prev => ({ ...prev, season: { totalOcc: v, adrHigh: prev.season?.adrHigh ?? 120 } }))} suffix="%" />
                        </div>
                        <div>
                          <span className="block text-xs font-medium text-gray-500 mb-1.5">{t('rechnerWizard.seasonAdr', 'Preis/Nacht Hochsaison')}</span>
                          <NumberStepper value={p.season.adrHigh} min={20} step={5} onChange={v => setP(prev => ({ ...prev, season: { totalOcc: prev.season?.totalOcc ?? 56, adrHigh: v } }))} suffix="€" />
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead><tr className="text-left text-gray-400">
                            <th className="py-1 pr-2 font-medium">{t('rechnerWizard.seasonCol', 'Saison')}</th>
                            <th className="py-1 pr-2 font-medium">{t('rechnerWizard.seasonPeriod', 'Zeitraum')}</th>
                            <th className="py-1 pr-2 font-medium text-right">{t('rechnerWizard.seasonOccCol', 'Auslastung')}</th>
                            <th className="py-1 pr-2 font-medium text-right">{t('rechnerWizard.seasonDays', 'Tage')}</th>
                            <th className="py-1 pr-2 font-medium text-right">€/{t('rechnerWizard.seasonNight', 'Nacht')}</th>
                            <th className="py-1 font-medium text-right">{t('rechnerWizard.seasonRevenue', 'Einnahmen')}</th>
                          </tr></thead>
                          <tbody>
                            {sb.rows.map(x => (
                              <tr key={x.key} className="border-t border-orange-100">
                                <td className="py-1 pr-2 font-medium text-gray-700">{x.label}</td>
                                <td className="py-1 pr-2 text-gray-500">{x.period}</td>
                                <td className="py-1 pr-2 text-right">{x.occPct.toLocaleString('de-DE')} %</td>
                                <td className="py-1 pr-2 text-right">{x.occDays} / {x.days}</td>
                                <td className="py-1 pr-2 text-right">{x.adr} €</td>
                                <td className="py-1 text-right font-medium">{x.revenue.toLocaleString('de-DE')} €</td>
                              </tr>
                            ))}
                            <tr className="border-t-2 border-orange-200 font-semibold text-gray-800">
                              <td className="py-1 pr-2">{t('rechnerWizard.seasonTotal', 'Gesamt')}</td>
                              <td className="py-1 pr-2" />
                              <td className="py-1 pr-2 text-right">{sb.occPct.toLocaleString('de-DE')} %</td>
                              <td className="py-1 pr-2 text-right">{sb.occDays} / {sb.totalDays}</td>
                              <td className="py-1 pr-2" />
                              <td className="py-1 text-right">{sb.rent.toLocaleString('de-DE')} €</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[11px] text-gray-500">→ {t('rechnerWizard.seasonYield', 'Ergibt Jahresmiete {{rent}} € = Bruttorendite {{y}} % (ersetzt das Feld oben)', { rent: sb.rent.toLocaleString('de-DE'), y: effY.toLocaleString('de-DE') })}</p>
                    </div>
                  )
                })()}
              </div>
            )}
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
          <p className="text-xs text-gray-400">{editCalc ? t('rechnerWizard.editHint2', 'Werte ändern oder Objekte ergänzen - Speichern aktualisiert dieselbe Berechnung unter demselben Link.') : basket.length > 1 ? t('rechnerWizard.multipleUnitsHint', 'Mehrere Wohnungen → Vergleich.') : t('rechnerWizard.autoPriceHint', 'Kaufpreis je Wohnung kommt automatisch aus dem CRM.')}</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('rechnerWizard.cancelButton', 'Abbrechen')}</button>
            <button onClick={() => void generate()} disabled={busy || (p.dealType === 'single' && !basket.length && (editCalc ? !keptItems.length : true))}
              className="px-5 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
              {busy ? (editCalc ? t('rechnerWizard.savingButton', 'Speichert…') : t('rechnerWizard.creatingButton', 'Erstellt…')) : editCalc ? t('rechnerWizard.saveButton', 'Speichern') : basket.length > 1 ? t('rechnerWizard.createComparisonButton', 'Vergleich erstellen') : t('rechnerWizard.createInvoiceButton', 'Rechnung erstellen')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
