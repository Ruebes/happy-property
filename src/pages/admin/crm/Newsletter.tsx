import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import UnitPickerModal from '../../../components/crm/UnitPickerModal'
import { NumberStepper } from '../../../components/NumberStepper'
import { DEFAULT_PARAMS, type CalcParams } from '../../../lib/rechner'
import type { CrmProjectUnit } from '../../../lib/crmTypes'

// ── Newsletter-Kampagne (individuell, KEINE Massenmail) ──────────────────────
// Jeder Empfänger (Leads ohne aktiven Pipeline-Deal) bekommt eine persönliche
// Einzel-Mail: Anrede, Svens Text, KI-Objekttexte, eigene Deck-Klone (eigener
// Token → Engagement-Tracking je Empfänger) + globale Beispielrechnung je Projekt.
// Versand gestaffelt (alle ~3 Min, 08–20 Uhr) über die newsletter-campaign Edge.

interface WizUnit {
  id: string; unit_number: string; price_net: number | null
  bedrooms: number; size_sqm: number | null
  furnCost: number; furnFree: boolean
}
interface WizProperty {
  project_id: string; project_name: string
  units: WizUnit[]
  bullets: string; ai_text: string
  master_deck_token: string | null
  calc_token: string | null
  params?: CalcParams          // Rechner-Parameter je Projekt (Default: DEFAULT_PARAMS)
}

// ── Rechner-Parameter (gleiches Formular wie im Deck-/Angebots-Wizard) ────────
// Gilt für alle Wohnungen des Projekts; Möbelpaket bleibt pro Wohnung einstellbar.
function CalcParamsPanel({ value, onChange }: { value: CalcParams; onChange: (p: CalcParams) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const set = (k: keyof CalcParams, v: number | string | boolean) => onChange({ ...value, [k]: v } as CalcParams)
  const numF = (label: string, k: keyof CalcParams, step = '1', suffix?: string) => (
    <label key={k} className="block">
      <span className="block text-xs font-medium text-gray-500 mb-1">{label}</span>
      <NumberStepper value={Number(value[k] ?? 0)} onChange={v => set(k, v)} step={parseFloat(step)} suffix={suffix} />
    </label>
  )
  const seg = (label: string, k: keyof CalcParams, opts: [string, string][]) => (
    <div key={k}>
      <span className="block text-[11px] text-gray-500 mb-0.5">{label}</span>
      <div className="flex rounded-lg overflow-hidden border border-gray-200">
        {opts.map(([val, lab]) => (
          <button key={val} type="button" onClick={() => set(k, val)}
            className={`flex-1 px-1.5 py-1 text-[11px] font-medium ${String(value[k]) === val ? 'bg-orange-500 text-white' : 'bg-white text-gray-600'}`}>{lab}</button>
        ))}
      </div>
    </div>
  )
  const tog = (label: string, k: keyof CalcParams) => (
    <button key={k} type="button" onClick={() => set(k, !value[k])}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium ${value[k] ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600'}`}>
      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${value[k] ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300'}`}>{value[k] ? '✓' : ''}</span>
      {label}
    </button>
  )
  const fmt = (n: number) => n.toLocaleString('de-DE')
  return (
    <div className="border border-gray-100 rounded-lg bg-gray-50/60">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-600">
        <span className="font-semibold">⚙️ {t('crm.newsletter.calcParams', 'Rechner-Parameter')}</span>
        <span className="text-gray-400">
          {t('crm.newsletter.calcSummary', 'EK {{ek}} € · Zins {{zins}} % · Rendite {{rend}} % · Wertsteig. {{wert}} %', {
            ek: fmt(value.equity), zins: String(value.interestPct), rend: String(value.yieldPct), wert: String(value.appreciationPct),
          })} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {seg(t('deckWizard.taxResidence', 'Steuersitz'), 'res', [['de', 'DE'], ['cy', 'CY']])}
            {seg(t('deckWizard.financing', 'Finanzierung'), 'fin', [['yes', t('deckWizard.yes', 'Ja')], ['no', t('deckWizard.cash', 'Cash')]])}
            {seg(t('deckWizard.rentalType', 'Vermietung'), 'letType', [['short', t('deckWizard.shortTerm', 'Kurz')], ['long', t('deckWizard.longTerm', 'Lang')]])}
            {seg(t('deckWizard.amortization', 'Tilgung'), 'mode', [['ann', t('deckWizard.annuity', 'Annuität')], ['tilg', t('deckWizard.fixed', 'Fix')]])}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {numF(t('deckWizard.equity', 'Eigenkapital'), 'equity', '1000', '€')}
            {numF(t('deckWizard.interestRate', 'Zins'), 'interestPct', '0.1', '%')}
            {numF(t('deckWizard.termYears', 'Laufzeit'), 'termYears', '1', 'J')}
            {numF(t('deckWizard.yieldLabel', 'Rendite'), 'yieldPct', '0.1', '%')}
            {numF(t('deckWizard.rentGrowth', 'Mietsteig.'), 'rentGrowth', '0.1', '%')}
            {numF(t('deckWizard.management', 'Verwaltung'), 'mgmtPct', '0.5', '%')}
            {numF(t('deckWizard.appreciation', 'Wertsteig.'), 'appreciationPct', '0.1', '%')}
            {value.res === 'de' && numF(t('deckWizard.deTax', 'DE-Steuer'), 'deTaxPct', '1', '%')}
            {value.res === 'cy' && numF(t('deckWizard.cyStock', 'CY Bestand'), 'cyBI', '500', '€')}
            {value.mode === 'tilg' && numF(t('deckWizard.amortization', 'Tilgung'), 'amortPct', '0.1', '%')}
            {numF(t('deckWizard.discount', 'Rabatt'), 'discountPct', '0.5', '%')}
          </div>
          <div className="flex flex-wrap gap-2">
            {value.letType === 'short' && tog('🏨 ' + t('deckWizard.hotelConceptToggle', 'Hotelkonzept'), 'hotelConcept')}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Newsletter() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [intro, setIntro] = useState('')
  const [outro, setOutro] = useState('')
  const [props, setProps] = useState<WizProperty[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [audience, setAudience] = useState<number | null>(null)
  const [busyKey, setBusyKey] = useState<string>('')      // welcher Button arbeitet gerade
  const [toast, setToast] = useState('')
  const [status, setStatus] = useState<{ status: string; total: number; done: number; error?: string | null } | null>(null)
  const [pastCampaigns, setPastCampaigns] = useState<Array<{ id: string; title: string; status: string; recipients_total: number; recipients_done: number; created_at: string }>>([])

  const showToastMsg = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const fetchPast = useCallback(async () => {
    const { data } = await supabase.from('newsletter_campaigns')
      .select('id, title, status, recipients_total, recipients_done, created_at')
      .order('created_at', { ascending: false }).limit(10)
    setPastCampaigns((data as typeof pastCampaigns) ?? [])
  }, [])

  useEffect(() => {
    void fetchPast()
    supabase.functions.invoke('newsletter-campaign', { body: { action: 'audience' } })
      .then(({ data }) => setAudience((data as { total?: number } | null)?.total ?? null))
      .catch(() => setAudience(null))
  }, [fetchPast])

  // Kampagne in DB speichern (upsert) — Edge liest daraus
  const saveCampaign = useCallback(async (): Promise<string | null> => {
    const payload = {
      title: title.trim() || 'Newsletter',
      subject: subject.trim(),
      intro_text: intro,
      outro_text: outro,
      properties: props.map(p => ({
        project_id: p.project_id, project_name: p.project_name,
        unit_numbers: p.units.map(u => u.unit_number),
        units: p.units,
        bullets: p.bullets, ai_text: p.ai_text,
        master_deck_token: p.master_deck_token, calc_token: p.calc_token,
        params: p.params ?? null,
      })),
      created_by: profile?.id ?? null,
      updated_at: new Date().toISOString(),
    }
    if (campaignId) {
      const { error } = await supabase.from('newsletter_campaigns').update(payload).eq('id', campaignId)
      if (error) { showToastMsg(`❌ ${error.message}`); return null }
      return campaignId
    }
    const { data, error } = await supabase.from('newsletter_campaigns').insert(payload).select('id').single()
    if (error) { showToastMsg(`❌ ${error.message}`); return null }
    const id = (data as { id: string }).id
    setCampaignId(id)
    return id
  }, [campaignId, title, subject, intro, outro, props, profile])

  // Wohnung aus dem Picker in einen Projekt-Slot einsortieren
  const addUnit = (unit: CrmProjectUnit, project: { id: string; name: string }) => {
    setShowPicker(false)
    setProps(prev => {
      const next = [...prev]
      let slot = next.find(p => p.project_id === project.id)
      if (!slot) {
        slot = { project_id: project.id, project_name: project.name, units: [], bullets: '', ai_text: '', master_deck_token: null, calc_token: null }
        next.push(slot)
      }
      if (!slot.units.some(u => u.id === unit.id)) {
        slot.units.push({
          id: unit.id, unit_number: unit.unit_number, price_net: unit.price_net ?? null,
          bedrooms: unit.bedrooms ?? 2, size_sqm: unit.size_sqm ?? null,
          furnCost: 0, furnFree: true,
        })
        // Deck/Rechnung sind damit veraltet
        slot.master_deck_token = null; slot.calc_token = null
      }
      return next
    })
  }

  const updateProp = (i: number, patch: Partial<WizProperty>) =>
    setProps(prev => prev.map((p, x) => x === i ? { ...p, ...patch } : p))

  // ── Aktionen je Projekt ─────────────────────────────────────────────────────
  const generateText = async (i: number) => {
    const p = props[i]
    setBusyKey(`text${i}`)
    try {
      const { data, error } = await supabase.functions.invoke('newsletter-campaign', { body: {
        action: 'draft_text', project_name: p.project_name,
        units: p.units.map(u => ({ unit_number: u.unit_number, price_net: u.price_net ?? undefined, extras: u.furnCost > 0 ? `Möbelpaket ${u.furnCost.toLocaleString('de-DE')} € ${u.furnFree ? 'GRATIS' : ''}` : '' })),
        bullets: p.bullets,
      } })
      if (error) throw new Error(error.message)
      updateProp(i, { ai_text: (data as { text?: string } | null)?.text ?? '' })
    } catch (err) {
      console.error('[Newsletter] draft_text:', err)
      showToastMsg(`❌ ${t('crm.newsletter.errText', 'Text-Erstellung fehlgeschlagen')}`)
    } finally { setBusyKey('') }
  }

  const createCalc = async (i: number) => {
    const p = props[i]
    setBusyKey(`calc${i}`)
    try {
      const items = p.units.map(u => ({
        label: `${p.project_name} · ${u.unit_number}`,
        project: p.project_name, unit: u.unit_number,
        bedrooms: u.bedrooms, size_sqm: u.size_sqm, price_net: u.price_net,
        params: {
          ...(p.params ?? DEFAULT_PARAMS),
          dealType: 'single' as const,
          priceNet: u.price_net ?? 0,
          bedrooms: u.bedrooms,
          furnCost: u.furnCost, furnFree: u.furnFree,
          // Hotelkonzept nur bei Kurzzeitvermietung zulassen
          hotelConcept: (p.params ?? DEFAULT_PARAMS).letType === 'short' ? (p.params ?? DEFAULT_PARAMS).hotelConcept : false,
          month: new Date().getMonth() + 1, year: new Date().getFullYear(),
        },
      }))
      const { data, error } = await supabase.from('property_calculations').insert({
        lead_id: null, recipient_name: '', title: `${p.project_name} – Beispielrechnung`,
        with_calc: true, created_by: profile?.id ?? null,
        content: { with_calc: true, items },
      }).select('token').single()
      if (error) throw error
      updateProp(i, { calc_token: (data as { token: string }).token })
      showToastMsg(t('crm.newsletter.calcDone', '✅ Berechnung erstellt'))
    } catch (err) {
      console.error('[Newsletter] calc:', err)
      showToastMsg(`❌ ${t('crm.newsletter.errCalc', 'Berechnung fehlgeschlagen')}`)
    } finally { setBusyKey('') }
  }

  const createDeck = async (i: number) => {
    const p = props[i]
    setBusyKey(`deck${i}`)
    try {
      const { data, error } = await supabase.functions.invoke('generate-deck', { body: {
        project_id: p.project_id,
        units: p.units.map(u => ({ unit_number: u.unit_number, price_net: u.price_net ?? undefined })),
        recipient_name: '{{vorname}}',
        angle: 'investment',
        briefing: `${p.bullets}\n\nWICHTIG: Dieses Exposé geht an viele Empfänger. Verwende im Anschreiben wörtlich die Anrede "Hallo {{vorname}}," und den Platzhalter {{vorname}} überall dort, wo der Vorname stehen soll. Keinen anderen Namen erfinden.`,
        created_by: profile?.id ?? null,
      } })
      if (error) throw new Error(error.message)
      const tok = (data as { token?: string } | null)?.token
      if (!tok) throw new Error('kein Token')
      updateProp(i, { master_deck_token: tok })
      showToastMsg(t('crm.newsletter.deckDone', '✅ Master-Deck erstellt — bitte prüfen'))
    } catch (err) {
      console.error('[Newsletter] deck:', err)
      showToastMsg(`❌ ${t('crm.newsletter.errDeck', 'Deck-Erstellung fehlgeschlagen')}`)
    } finally { setBusyKey('') }
  }

  // ── Test / Start ────────────────────────────────────────────────────────────
  const sendTest = async () => {
    setBusyKey('test')
    try {
      const id = await saveCampaign(); if (!id) return
      const { data, error } = await supabase.functions.invoke('newsletter-campaign', { body: { action: 'test_mail', campaign_id: id } })
      if (error || !(data as { ok?: boolean } | null)?.ok) throw new Error(error?.message ?? JSON.stringify(data))
      showToastMsg(t('crm.newsletter.testSent', '✅ Test-Mail an dich unterwegs'))
    } catch (err) {
      console.error('[Newsletter] test:', err)
      showToastMsg(`❌ ${t('crm.newsletter.errTest', 'Test-Mail fehlgeschlagen')}`)
    } finally { setBusyKey('') }
  }

  const launch = async () => {
    if (!confirm(t('crm.newsletter.confirmLaunch', 'Kampagne wirklich starten? Jeder Empfänger bekommt eine persönliche Mail (gestaffelt, 08–20 Uhr).') as string)) return
    setBusyKey('launch')
    try {
      const id = await saveCampaign(); if (!id) return
      const { data, error } = await supabase.functions.invoke('newsletter-campaign', { body: { action: 'launch', campaign_id: id } })
      const d = data as { ok?: boolean; total?: number; error?: string } | null
      if (error || !d?.ok) throw new Error(error?.message ?? d?.error ?? 'Launch fehlgeschlagen')
      setStatus({ status: 'launching', total: d.total ?? 0, done: 0 })
      const poll = setInterval(async () => {
        const { data: st } = await supabase.functions.invoke('newsletter-campaign', { body: { action: 'status', campaign_id: id } })
        const s = st as { status?: string; total?: number; done?: number; error?: string | null } | null
        if (s?.status) setStatus({ status: s.status, total: s.total ?? 0, done: s.done ?? 0, error: s.error })
        if (s?.status === 'sending' || s?.status === 'done') { clearInterval(poll); void fetchPast() }
      }, 4000)
    } catch (err) {
      console.error('[Newsletter] launch:', err)
      showToastMsg(`❌ ${err instanceof Error ? err.message : 'Start fehlgeschlagen'}`)
    } finally { setBusyKey('') }
  }

  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-5'
  const input = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40'
  const btnSec = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50'

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.newsletter.title', 'Newsletter (individuell)')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('crm.newsletter.subtitle', 'Persönliche Einzel-Mails an alle Kontakte ohne aktiven Deal — mit eigenem Deck je Empfänger, zeitversetzt (08–20 Uhr, ~alle 3 Min).')}
            {audience != null && <> · <strong>{t('crm.newsletter.audience', '{{n}} Empfänger', { n: audience })}</strong></>}
          </p>
        </div>

        {/* ── 1 · Objekte ── */}
        <div className={card}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">{t('crm.newsletter.s1', '1 · Objekte')}</h2>
            <button onClick={() => setShowPicker(true)} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ backgroundColor: '#1a2332' }}>
              {t('crm.newsletter.addUnit', '+ Wohnung hinzufügen')}
            </button>
          </div>
          {props.length === 0 && <p className="text-sm text-gray-400">{t('crm.newsletter.noUnits', 'Noch keine Objekte gewählt.')}</p>}
          <div className="space-y-4">
            {props.map((p, i) => (
              <div key={p.project_id} className="border border-gray-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-gray-900">{p.project_name} <span className="text-gray-400 font-normal">· {p.units.map(u => u.unit_number).join(', ')}</span></p>
                  <button onClick={() => setProps(prev => prev.filter((_, x) => x !== i))} className="text-gray-400 hover:text-red-600 text-sm">✕</button>
                </div>
                <div className="grid gap-2">
                  {p.units.map((u, ui) => (
                    <div key={u.id} className="flex flex-wrap items-center gap-2 bg-gray-50 rounded-lg p-2 text-sm">
                      <span className="font-medium w-20">{u.unit_number}</span>
                      <span className="text-gray-500">{u.price_net != null ? `${u.price_net.toLocaleString('de-DE')} € netto` : '—'}</span>
                      <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-600">
                        {t('crm.newsletter.furniture', 'Möbelpaket €')}
                        <input type="number" value={u.furnCost} onChange={e => {
                          const v = Number(e.target.value) || 0
                          updateProp(i, { units: p.units.map((x, xi) => xi === ui ? { ...x, furnCost: v } : x), calc_token: null })
                        }} className="w-24 border border-gray-200 rounded px-2 py-1 bg-white" />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        <input type="checkbox" checked={u.furnFree} onChange={e =>
                          updateProp(i, { units: p.units.map((x, xi) => xi === ui ? { ...x, furnFree: e.target.checked } : x), calc_token: null })
                        } />
                        {t('crm.newsletter.free', 'gratis')}
                      </label>
                      <button onClick={() => updateProp(i, { units: p.units.filter((_, xi) => xi !== ui), master_deck_token: null, calc_token: null })}
                        className="text-gray-400 hover:text-red-600">✕</button>
                    </div>
                  ))}
                </div>

                {/* Stichpunkte → KI-Text */}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.newsletter.bullets', 'Deine Stichpunkte zu diesem Objekt')}</label>
                  <textarea value={p.bullets} onChange={e => updateProp(i, { bullets: e.target.value })} rows={3} className={input}
                    placeholder={t('crm.newsletter.bulletsPh', '- Möbelpaket geschenkt\n- fertig Q4 2026\n- 5% MwSt bei Eigennutzung möglich') as string} />
                  <button onClick={() => void generateText(i)} disabled={busyKey === `text${i}` || !p.bullets.trim()} className={`${btnSec} mt-2`}>
                    {busyKey === `text${i}` ? t('crm.newsletter.working', 'Einen Moment…') : t('crm.newsletter.genText', '✨ Text erstellen')}
                  </button>
                </div>
                {p.ai_text && (
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.newsletter.aiText', 'Text in der Mail (anpassbar)')}</label>
                    <textarea value={p.ai_text} onChange={e => updateProp(i, { ai_text: e.target.value })} rows={5} className={input} />
                  </div>
                )}

                {/* Rechner-Parameter — wie im Angebots-Wizard, gilt für die Berechnung unten */}
                <CalcParamsPanel value={p.params ?? DEFAULT_PARAMS}
                  onChange={np => updateProp(i, { params: np, calc_token: null })} />

                {/* Berechnung + Master-Deck */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button onClick={() => void createCalc(i)} disabled={busyKey === `calc${i}`} className={btnSec}>
                    {busyKey === `calc${i}` ? t('crm.newsletter.working', 'Einen Moment…') : p.calc_token ? t('crm.newsletter.recalc', '📊 Berechnung neu erstellen') : t('crm.newsletter.calc', '📊 Berechnung erstellen')}
                  </button>
                  {p.calc_token && <a href={`/rechnung/${p.calc_token}`} target="_blank" rel="noreferrer" className="text-xs underline" style={{ color: '#ff795d' }}>{t('crm.newsletter.view', 'ansehen')}</a>}
                  <button onClick={() => void createDeck(i)} disabled={busyKey === `deck${i}`} className={btnSec}>
                    {busyKey === `deck${i}` ? t('crm.newsletter.deckWorking', 'Deck wird erstellt (~90 s)…') : p.master_deck_token ? t('crm.newsletter.redeck', '📖 Master-Deck neu erstellen') : t('crm.newsletter.deck', '📖 Master-Deck erstellen')}
                  </button>
                  {p.master_deck_token && <a href={`/deck/${p.master_deck_token}`} target="_blank" rel="noreferrer" className="text-xs underline" style={{ color: '#ff795d' }}>{t('crm.newsletter.view', 'ansehen')}</a>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── 2 · Mail ── */}
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">{t('crm.newsletter.s2', '2 · Deine Mail')}</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.newsletter.internalTitle', 'Interner Kampagnen-Name')}</label>
              <input value={title} onChange={e => setTitle(e.target.value)} className={input} placeholder="Juli-Newsletter Genesis + Adonidos" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.newsletter.subject', 'Betreff')} <span className="text-gray-400 font-normal">({'{{vorname}}'} {t('crm.newsletter.possible', 'möglich')})</span></label>
              <input value={subject} onChange={e => setSubject(e.target.value)} className={input} placeholder="Drei Gelegenheiten in Zypern — mit geschenktem Möbelpaket" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.newsletter.intro', 'Einleitung (nach „Hallo Vorname,")')}</label>
              <textarea value={intro} onChange={e => setIntro(e.target.value)} rows={4} className={input} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.newsletter.outro', 'Optionaler Zusatz nach den Objekten')}</label>
              <textarea value={outro} onChange={e => setOutro(e.target.value)} rows={3} className={input} placeholder={t('crm.newsletter.outroPh', 'z. B. eine persönliche Anmerkung — kann auch leer bleiben')} />
              <p className="mt-1 text-[11px] text-gray-400">{t('crm.newsletter.outroHint', 'Der Abschluss wird automatisch ergänzt: Einladung zum Gespräch + „Termin aussuchen"-Button (direkt zum Kalender, ohne Fragebogen) + „Liebe Grüße, Sven".')}</p>
            </div>
          </div>
        </div>

        {/* ── 3 · Test + Start ── */}
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">{t('crm.newsletter.s3', '3 · Testen & Starten')}</h2>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => void sendTest()} disabled={busyKey === 'test' || !subject.trim()} className={btnSec}>
              {busyKey === 'test' ? t('crm.newsletter.working', 'Einen Moment…') : t('crm.newsletter.test', '✉️ Test-Mail an mich')}
            </button>
            <button onClick={() => void launch()}
              disabled={busyKey === 'launch' || !subject.trim() || props.length === 0 || props.some(p => !p.master_deck_token)}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {t('crm.newsletter.launch', '🚀 Kampagne starten ({{n}} Empfänger)', { n: audience ?? '…' })}
            </button>
            {props.some(p => !p.master_deck_token) && props.length > 0 && (
              <span className="text-xs text-gray-400">{t('crm.newsletter.needDecks', 'Erst alle Master-Decks erstellen.')}</span>
            )}
          </div>
          {status && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>{status.status === 'launching' ? t('crm.newsletter.preparing', 'Decks werden erstellt & Mails geplant…') : t('crm.newsletter.sendingNow', 'Geplant — Versand läuft gestaffelt.')}</span>
                <span>{status.done}/{status.total}{status.error ? ` · ⚠️ ${status.error}` : ''}</span>
              </div>
              <div className="bg-gray-100 rounded-full h-3 overflow-hidden">
                <div className="h-3 rounded-full transition-all" style={{ width: `${status.total ? (status.done / status.total) * 100 : 0}%`, backgroundColor: '#ff795d' }} />
              </div>
            </div>
          )}
        </div>

        {/* ── Bisherige Kampagnen ── */}
        {pastCampaigns.length > 0 && (
          <div className={card}>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">{t('crm.newsletter.past', 'Bisherige Kampagnen')}</h2>
            <div className="space-y-1.5">
              {pastCampaigns.map(c => (
                <div key={c.id} className="flex items-center justify-between text-sm">
                  <span className="text-gray-800">{c.title}</span>
                  <span className="text-xs text-gray-400">
                    {new Date(c.created_at).toLocaleDateString('de-DE')} · {c.recipients_done}/{c.recipients_total} · {c.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {showPicker && (
          <UnitPickerModal
            leadName={t('crm.newsletter.pickerFor', 'Newsletter-Kampagne') as string}
            confirmLabel={t('crm.newsletter.pickerConfirm', 'Übernehmen') as string}
            onClose={() => setShowPicker(false)}
            onSelect={(unit, project) => addUnit(unit, { id: project.id, name: project.name })}
          />
        )}

        {toast && <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>}
      </div>
    </DashboardLayout>
  )
}
