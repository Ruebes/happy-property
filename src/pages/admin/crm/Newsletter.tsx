import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import UnitPickerModal from '../../../components/crm/UnitPickerModal'
import { NumberStepper } from '../../../components/NumberStepper'
import { DEFAULT_PARAMS, type CalcParams } from '../../../lib/rechner'
import type { CrmProjectUnit, DeckAssetsCache } from '../../../lib/crmTypes'

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
  // Empfaengerlisten (Klaviyo-Import). Standard 'all': normalerweise bekommen alle
  // den Newsletter — Sven schraenkt nur im Ausnahmefall ein.
  const [lists, setLists] = useState<Array<{ id: string; name: string; anzahl: number }>>([])
  const [listMode, setListMode] = useState<'all' | 'include' | 'exclude'>('all')
  const [listIds, setListIds] = useState<string[]>([])
  const [busyKey, setBusyKey] = useState<string>('')      // welcher Button arbeitet gerade
  const [toast, setToast] = useState('')
  const [status, setStatus] = useState<{ status: string; total: number; done: number; error?: string | null } | null>(null)
  const [startAt, setStartAt] = useState('')   // '' = sofort; sonst datetime-local
  const [progress, setProgress] = useState<Record<string, { sent: number; pending: number; next_at: string | null }>>({})
  const [pastCampaigns, setPastCampaigns] = useState<Array<{ id: string; title: string; status: string; recipients_total: number; recipients_done: number; created_at: string }>>([])

  const showToastMsg = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const fetchPast = useCallback(async () => {
    const { data } = await supabase.from('newsletter_campaigns')
      .select('id, title, status, recipients_total, recipients_done, created_at')
      .order('created_at', { ascending: false }).limit(10)
    setPastCampaigns((data as typeof pastCampaigns) ?? [])
    try {
      const { data: prog, error } = await supabase.rpc('newsletter_progress')
      if (!error && prog) setProgress(prog as typeof progress)
    } catch (err) { console.warn('[Newsletter] progress:', err) }
  }, [])

  useEffect(() => {
    void fetchPast()
    void (async () => {
      const { data } = await supabase.from('newsletter_lists')
        .select('id, name, newsletter_list_members(count)').eq('active', true).order('name')
      // deno-lint-ignore no-explicit-any
      setLists(((data ?? []) as any[]).map(l => ({
        id: l.id, name: l.name, anzahl: l.newsletter_list_members?.[0]?.count ?? 0,
      })))
    })()
  }, [fetchPast])

  // Zielgruppen-Zahl haengt an der Listenauswahl → bei Aenderung neu holen.
  useEffect(() => {
    supabase.functions.invoke('newsletter-campaign', { body: { action: 'audience', list_mode: listMode, list_ids: listIds } })
      .then(({ data }) => setAudience((data as { total?: number } | null)?.total ?? null))
      .catch(() => setAudience(null))
  }, [listMode, listIds])

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
      list_mode: listMode,
      list_ids: listIds,
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

  // ── Zwischenspeichern / Entwurf laden / Archiv ─────────────────────────────
  const saveDraft = async () => {
    setBusyKey('save')
    try {
      const id = await saveCampaign()
      if (id) { showToastMsg(t('crm.newsletter.saved', '💾 Entwurf gespeichert — du kannst jederzeit weitermachen.')); void fetchPast() }
    } finally { setBusyKey('') }
  }

  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null)
  const showPreview = async () => {
    setBusyKey('preview')
    try {
      // Erst speichern — die Vorschau rendert die Edge aus dem DB-Stand
      const id = await saveCampaign()
      if (!id) return
      const { data, error } = await supabase.functions.invoke('newsletter-campaign', { body: { action: 'preview', campaign_id: id } })
      if (error) throw new Error(error.message)
      const d = data as { ok?: boolean; subject?: string; html?: string } | null
      if (!d?.ok || !d.html) throw new Error('keine Vorschau')
      setPreview({ subject: d.subject ?? '', html: d.html })
    } catch (err) {
      console.error('[Newsletter] preview:', err)
      showToastMsg(`❌ ${t('crm.newsletter.previewError', 'Vorschau fehlgeschlagen')}`)
    } finally { setBusyKey('') }
  }

  const resetWizard = () => {
    setCampaignId(null); setTitle(''); setSubject(''); setIntro(''); setOutro('')
    setProps([]); setStatus(null)
  }

  // Gespeicherten Entwurf zurück in den Wizard laden
  const loadCampaign = async (id: string) => {
    setBusyKey(`load${id}`)
    try {
      const { data, error } = await supabase.from('newsletter_campaigns').select('*').eq('id', id).single()
      if (error) throw error
      const c = data as { id: string; title: string; subject: string; intro_text: string; outro_text: string; properties: unknown }
      setCampaignId(c.id)
      setTitle(c.title ?? ''); setSubject(c.subject ?? '')
      setIntro(c.intro_text ?? ''); setOutro(c.outro_text ?? '')
      const raw = Array.isArray(c.properties) ? c.properties as Array<Partial<WizProperty> & { units?: WizUnit[] }> : []
      setProps(raw.filter(x => x && x.project_id).map(x => ({
        project_id: x.project_id as string, project_name: x.project_name ?? '',
        units: Array.isArray(x.units) ? x.units : [],
        bullets: x.bullets ?? '', ai_text: x.ai_text ?? '',
        master_deck_token: x.master_deck_token ?? null, calc_token: x.calc_token ?? null,
        params: x.params ?? undefined,
      })))
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      console.error('[Newsletter] loadCampaign:', err)
      showToastMsg(`❌ ${t('crm.newsletter.loadError', 'Entwurf konnte nicht geladen werden')}`)
    } finally { setBusyKey('') }
  }

  const deleteDraft = async (id: string) => {
    if (!confirm(t('crm.newsletter.deleteConfirm', 'Diesen Entwurf löschen?') as string)) return
    const { error } = await supabase.from('newsletter_campaigns').delete().eq('id', id)
    if (error) { showToastMsg(`❌ ${error.message}`); return }
    if (campaignId === id) resetWizard()
    void fetchPast()
  }

  // Öffnungs-Auswertung (Archiv): Mail-Öffnungen + Deck-Ansichten je Empfänger
  interface EngRow { lead_id: string; name: string | null; email: string | null; mail_opened: string | null; decks: Array<{ project: string; views: number; last_view: string }>; last_view: string | null }
  interface EngData { recipients: number; mail_openers: number; openers: number; rows: EngRow[]; calc_views?: Array<{ project: string; views: number; last_view: string | null }> }
  const [archiveOpen, setArchiveOpen] = useState<string | null>(null)
  const [archiveData, setArchiveData] = useState<Record<string, EngData>>({})
  const toggleArchive = async (id: string) => {
    if (archiveOpen === id) { setArchiveOpen(null); return }
    setArchiveOpen(id)
    if (archiveData[id]) return
    setBusyKey(`arch${id}`)
    try {
      const { data, error } = await supabase.rpc('newsletter_engagement', { p_campaign: id })
      if (error) throw error
      setArchiveData(prev => ({ ...prev, [id]: data as EngData }))
    } catch (err) {
      console.error('[Newsletter] engagement:', err)
      showToastMsg(`❌ ${t('crm.newsletter.engError', 'Öffnungen konnten nicht geladen werden')}`)
      setArchiveOpen(null)
    } finally { setBusyKey('') }
  }

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
      // Projekt-Fakten + Bilder mitgeben (wie im Angebots-Wizard) — generate-deck
      // braucht beides und antwortet sonst mit "facts fehlt".
      const { data: pr, error: pe } = await supabase.from('crm_projects')
        .select('deck_assets, latitude, longitude').eq('id', p.project_id).single()
      if (pe) throw new Error(pe.message)
      const prj = pr as { deck_assets: DeckAssetsCache | null; latitude: number | null; longitude: number | null }
      const a = prj.deck_assets ?? ({} as DeckAssetsCache)
      if (!a.facts) throw new Error(t('crm.newsletter.noFacts', 'Keine Projekt-Fakten — erst „Aus Drive laden" im Projekt ausführen.') as string)
      const unitFacts = p.units.map(u => `\n\n=== WOHNUNG: ${u.unit_number} ===\n${u.bedrooms ?? '?'} Schlafzimmer · ${u.size_sqm ?? '?'} m² Innenfläche.`).join('')
      const fps = (a.floorplans ?? []).map(f => f.url).filter(Boolean)
      const images = {
        renders: a.renders ?? [], gallery: a.gallery ?? [],
        floorplan: fps[0], floorplans: fps,
        map: a.map ?? undefined, mapUrl: a.mapUrl ?? undefined, mapMarker: a.mapMarker ?? undefined,
        mapLat: prj.latitude ?? undefined, mapLng: prj.longitude ?? undefined,
      }
      const { data, error } = await supabase.functions.invoke('generate-deck', { body: {
        project_id: p.project_id,
        units: p.units.map(u => ({ unit_number: u.unit_number, price_net: u.price_net ?? undefined })),
        recipient_name: '{{vorname}}',
        angle: 'investment',
        facts: a.facts + unitFacts, images,
        month_label: new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
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
    const planned = startAt ? new Date(startAt) : null
    const q = planned
      ? (t('crm.newsletter.confirmLaunchAt', 'Kampagne vorbereiten und ab {{dt}} versenden? Jeder Empfänger bekommt eine persönliche Mail (gestaffelt, 08–20 Uhr).', { dt: planned.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) as string)
      : (t('crm.newsletter.confirmLaunch', 'Kampagne wirklich JETZT starten? Jeder Empfänger bekommt eine persönliche Mail (gestaffelt, 08–20 Uhr).') as string)
    if (!confirm(q)) return
    setBusyKey('launch')
    try {
      const id = await saveCampaign(); if (!id) return
      const { data, error } = await supabase.functions.invoke('newsletter-campaign', { body: { action: 'launch', campaign_id: id, start_at: planned ? planned.toISOString() : undefined } })
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

        {/* ── Empfängerlisten ── */}
        <div className={card}>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-800">{t('crm.newsletter.lists', 'Empfänger')}</h2>
            <a href="/admin/crm/settings/lists" className="text-xs font-medium hover:underline" style={{ color: '#ff795d' }}>
              {t('crm.newsletter.manageLists', 'Listen verwalten')}
            </a>
          </div>
          <select
            value={listMode}
            onChange={e => { const v = e.target.value as 'all' | 'include' | 'exclude'; setListMode(v); if (v === 'all') setListIds([]) }}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:border-orange-400"
          >
            <option value="all">{t('crm.newsletter.modeAll', 'Alle — Kunden und alle Listen (Standard)')}</option>
            <option value="include">{t('crm.newsletter.modeInclude', 'Nur bestimmte Listen (plus Kunden)')}</option>
            <option value="exclude">{t('crm.newsletter.modeExclude', 'Alle außer bestimmten Listen')}</option>
          </select>

          {listMode !== 'all' && (
            <div className="mt-3 space-y-1.5">
              {lists.length === 0 ? (
                <p className="text-xs text-gray-400">{t('crm.newsletter.noLists', 'Noch keine Listen freigeschaltet — unter „Listen verwalten" aus Klaviyo holen.')}</p>
              ) : lists.map(l => (
                <label key={l.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox" checked={listIds.includes(l.id)}
                    onChange={e => setListIds(ids => e.target.checked ? [...ids, l.id] : ids.filter(x => x !== l.id))}
                    className="rounded border-gray-300"
                  />
                  {l.name} <span className="text-xs text-gray-400">({l.anzahl})</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-[11px] text-gray-400 mt-2">
            {t('crm.newsletter.listsHint', 'Kunden aus dem CRM sind immer dabei. Doppelte Adressen werden nur einmal angeschrieben.')}
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
            <button onClick={() => void saveDraft()} disabled={busyKey === 'save'} className={btnSec}>
              {busyKey === 'save' ? t('crm.newsletter.working', 'Einen Moment…') : t('crm.newsletter.saveDraft', '💾 Entwurf speichern')}
            </button>
            {(campaignId || title || subject || props.length > 0) && (
              <button onClick={resetWizard} className={btnSec}>{t('crm.newsletter.new', '🆕 Neue Kampagne')}</button>
            )}
            <button onClick={() => void showPreview()} disabled={busyKey === 'preview' || props.length === 0} className={btnSec}>
              {busyKey === 'preview' ? t('crm.newsletter.working', 'Einen Moment…') : t('crm.newsletter.preview', '👁 Vorschau')}
            </button>
            <button onClick={() => void sendTest()} disabled={busyKey === 'test' || !subject.trim()} className={btnSec}>
              {busyKey === 'test' ? t('crm.newsletter.working', 'Einen Moment…') : t('crm.newsletter.test', '✉️ Test-Mail an mich')}
            </button>
            <label className="flex items-center gap-2 text-xs text-gray-600">
              {t('crm.newsletter.startAt', 'Versandstart:')}
              <input type="datetime-local" value={startAt} onChange={e => setStartAt(e.target.value)}
                min={new Date(Date.now() + 10 * 60000).toISOString().slice(0, 16)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 bg-white" />
              {startAt && <button onClick={() => setStartAt('')} className="text-gray-400 hover:text-gray-700" title={t('crm.newsletter.startNow', 'sofort senden') as string}>✕</button>}
              {!startAt && <span className="text-gray-400">{t('crm.newsletter.startNowLabel', '(leer = sofort)')}</span>}
            </label>
            <button onClick={() => void launch()}
              disabled={busyKey === 'launch' || !subject.trim() || props.length === 0 || props.some(p => !p.master_deck_token)}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {startAt
                ? t('crm.newsletter.launchAt', '🗓 Versand planen ({{n}} Empfänger)', { n: audience ?? '…' })
                : t('crm.newsletter.launch', '🚀 Kampagne starten ({{n}} Empfänger)', { n: audience ?? '…' })}
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

        {/* ── Entwürfe + Archiv ── */}
        {pastCampaigns.length > 0 && (
          <div className={card}>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">{t('crm.newsletter.past', 'Entwürfe & Archiv')}</h2>
            <div className="space-y-2">
              {pastCampaigns.map(c => (
                <div key={c.id} className="border border-gray-100 rounded-xl">
                  <div className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${c.status !== 'draft' ? 'cursor-pointer hover:bg-gray-50 rounded-xl' : ''}`}
                    onClick={() => { if (c.status !== 'draft') void toggleArchive(c.id) }}>
                    <span className="font-medium text-gray-800">{c.title}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${c.status === 'draft' ? 'bg-gray-100 text-gray-600' : 'bg-orange-50 text-orange-700'}`}>
                      {c.status === 'draft' ? t('crm.newsletter.stDraft', 'Entwurf') : t('crm.newsletter.stSent', 'versendet')}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(c.created_at).toLocaleDateString('de-DE')}
                      {c.status !== 'draft' && (() => {
                        const pr = progress[c.id]
                        if (!pr) return <> · {c.recipients_done}/{c.recipients_total} {t('crm.newsletter.mails', 'Mails')}</>
                        const total = pr.sent + pr.pending
                        if (pr.sent === 0 && pr.next_at && new Date(pr.next_at).getTime() > Date.now() + 10 * 60000) {
                          return <> · 🗓 {t('crm.newsletter.plannedFrom', 'geplant ab')} {new Date(pr.next_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {total} {t('crm.newsletter.mails', 'Mails')}</>
                        }
                        return <> · <strong className="text-gray-600">{pr.sent}/{total}</strong> {t('crm.newsletter.sentLabel', 'gesendet')}{pr.pending > 0 && <> · {t('crm.newsletter.running', 'läuft')}</>}</>
                      })()}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      {c.status === 'draft' ? (
                        <>
                          <button onClick={() => void loadCampaign(c.id)} disabled={busyKey === `load${c.id}`} className={btnSec}>
                            {t('crm.newsletter.edit', '✏️ Weiterbearbeiten')}
                          </button>
                          <button onClick={() => void deleteDraft(c.id)} className="text-gray-400 hover:text-red-600 text-sm">🗑</button>
                        </>
                      ) : (
                        <button onClick={e => { e.stopPropagation(); void toggleArchive(c.id) }} disabled={busyKey === `arch${c.id}`} className={btnSec}>
                          {busyKey === `arch${c.id}` ? t('crm.newsletter.working', 'Einen Moment…') : t('crm.newsletter.opens', '📈 Öffnungen')}
                        </button>
                      )}
                    </span>
                  </div>
                  {archiveOpen === c.id && archiveData[c.id] && (() => {
                    const ad = archiveData[c.id]
                    const pct = (n: number) => ad.recipients > 0 ? `${Math.round((n / ad.recipients) * 100)} %` : '–'
                    const totalCalcViews = (ad.calc_views ?? []).reduce((a, cv) => a + cv.views, 0)
                    const fmtDt = (v: string) => new Date(v).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                    return (
                      <div className="border-t border-gray-100 px-3 py-3">
                        {/* Statistik */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                          <div className="bg-gray-50 rounded-lg p-2.5">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">{t('crm.newsletter.stRecipients', 'Empfänger')}</p>
                            <p className="text-lg font-bold text-gray-900">{ad.recipients}</p>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-2.5">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">📧 {t('crm.newsletter.stOpens', 'Mail geöffnet')}</p>
                            <p className="text-lg font-bold text-gray-900">{ad.mail_openers ?? 0} <span className="text-xs font-semibold" style={{ color: '#ff795d' }}>({pct(ad.mail_openers ?? 0)})</span></p>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-2.5">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">📖 {t('crm.newsletter.stDecks', 'Deck angesehen')}</p>
                            <p className="text-lg font-bold text-gray-900">{ad.openers} <span className="text-xs font-semibold" style={{ color: '#ff795d' }}>({pct(ad.openers)})</span></p>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-2.5">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">📊 {t('crm.newsletter.stCalcs', 'Berechnung')}</p>
                            <p className="text-lg font-bold text-gray-900">{totalCalcViews} <span className="text-xs font-semibold text-gray-400">{t('crm.newsletter.stCalcViews', 'Aufrufe')} (≈{pct(totalCalcViews)})</span></p>
                          </div>
                        </div>
                        {(ad.calc_views?.length ?? 0) > 0 && totalCalcViews > 0 && (
                          <p className="text-[11px] text-gray-400 mb-2">
                            📊 {(ad.calc_views ?? []).map(cv => `${cv.project}: ${cv.views}×`).join(' · ')} — {t('crm.newsletter.calcHint', 'die Rechnung ist für alle Empfänger identisch, Aufrufe sind daher nicht einzelnen Kunden zuordenbar')}
                          </p>
                        )}
                        {ad.rows.length === 0 ? (
                          <p className="text-sm text-gray-400">{t('crm.newsletter.noOpens', 'Noch keine Öffnungen.')}</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left text-[11px] text-gray-400 uppercase">
                                  <th className="py-1 pr-3">{t('crm.newsletter.colName', 'Empfänger')}</th>
                                  <th className="py-1 pr-3">📧 {t('crm.newsletter.colMail', 'Mail geöffnet')}</th>
                                  <th className="py-1 pr-3">📖 {t('crm.newsletter.colDecks', 'Decks angesehen')}</th>
                                  <th className="py-1 text-right">{t('crm.newsletter.colLast', 'Zuletzt')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {ad.rows.map(r => (
                                  <tr key={r.lead_id} className="border-t border-gray-50">
                                    <td className="py-1.5 pr-3">
                                      <a href={`/admin/crm/leads/${r.lead_id}`} className="font-medium text-gray-800 hover:underline">
                                        {r.name || r.email || '—'}
                                      </a>
                                    </td>
                                    <td className="py-1.5 pr-3 text-gray-600 text-xs">
                                      {r.mail_opened ? <>✓ {fmtDt(r.mail_opened)}</> : <span className="text-gray-300">—</span>}
                                    </td>
                                    <td className="py-1.5 pr-3 text-gray-700">
                                      {r.decks.length ? r.decks.map(dk => `${dk.project} (${dk.views}×)`).join(' · ') : <span className="text-gray-300">—</span>}
                                    </td>
                                    <td className="py-1.5 text-right text-gray-500 text-xs">
                                      {(r.last_view || r.mail_opened) ? fmtDt((r.last_view ?? r.mail_opened) as string) : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )
                  })()}
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

        {preview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPreview(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
                <div className="min-w-0">
                  <p className="text-xs text-gray-400">{t('crm.newsletter.previewTitle', 'Vorschau — genau so kommt die Mail an')}</p>
                  <p className="text-sm font-semibold text-gray-900 truncate">{preview.subject.split('{{vorname}}').join('Vorname')}</p>
                </div>
                <button onClick={() => setPreview(null)} className="text-gray-400 hover:text-gray-700 text-xl shrink-0 ml-3">✕</button>
              </div>
              <iframe title="Mail-Vorschau" sandbox="" srcDoc={preview.html} className="w-full flex-1 min-h-[60vh] bg-white" />
            </div>
          </div>
        )}
        {toast && <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>}
      </div>
    </DashboardLayout>
  )
}
