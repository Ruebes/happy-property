import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { DeckAssetsCache } from '../../lib/crmTypes'
import { DEFAULT_PARAMS, type CalcParams, type CalcItem } from '../../lib/rechner'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'

// ── Deck-Wizard ──────────────────────────────────────────────────────────────
// Aus dem Kunden heraus: Projekt → Vorschlags-Wohnung(en) → Freitext → ins Paket;
// beliebig viele über mehrere Projekte. „Alle erstellen" generiert je Wohnung ein
// personalisiertes Deck (Hintergrund + Polling) und legt EINE Begleit-Mail in den
// Postausgang (Freigabe durch Sven).

interface LeadLite { id: string; first_name: string; last_name: string; email: string | null }
interface ProjectRow { id: string; name: string; developer: string | null; deck_assets: DeckAssetsCache | null; furniture_cost: number | null; furniture_included: boolean | null; latitude: number | null; longitude: number | null }
interface UnitRow { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; terrace_sqm: number | null; price_net: number | null; price_gross: number | null; floor: number | null }
interface BasketItem { projectId: string; projectName: string; assets: DeckAssetsCache | null; unit: UnitRow; furnitureCost: number | null; furnitureIncluded: boolean | null; lat: number | null; lng: number | null }

const eur = (n: number | null | undefined) => n != null ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n) : ''
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export default function DeckWizard({ lead, onClose, onDone }: { lead: LeadLite; onClose: () => void; onDone: (msg: string) => void }) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [developer, setDeveloper] = useState('')   // Filter: Developer-Name
  const [projectId, setProjectId] = useState('')
  const [withCalc, setWithCalc] = useState(false)
  const [calcParams, setCalcParams] = useState<CalcParams>({ ...DEFAULT_PARAMS, month: 6, year: new Date().getFullYear() })
  // Pro Wohnung eigene Rendite + Wertsteigerung (unterscheiden sich je Projekt/Lage).
  // Leer = es gilt der globale Standardwert aus calcParams.
  // Per-Wohnung-Overrides: Rendite, Wertsteigerung, Einrichtungspaket-Preis (wichtig für
  // die Möbel-AfA), Möbelpaket kostenfrei, Hotelkonzept. Leer = globaler Standard.
  const [perUnit, setPerUnit] = useState<Record<string, { yieldPct?: number; appreciationPct?: number; furnCost?: number; furnFree?: boolean; hotelConcept?: boolean }>>({})
  const setPu = (id: string, patch: Partial<{ yieldPct: number; appreciationPct: number; furnCost: number; furnFree: boolean; hotelConcept: boolean }>) =>
    setPerUnit(p => ({ ...p, [id]: { ...p[id], ...patch } }))
  const [units, setUnits]       = useState<UnitRow[]>([])
  const [filterBed, setFilterBed] = useState<'all' | '1' | '2' | '3' | '4'>('all')
  const [filterMin, setFilterMin] = useState(0)
  const [filterMax, setFilterMax] = useState(0)
  const [sel, setSel]           = useState<Set<string>>(new Set())
  const [basket, setBasket]     = useState<BasketItem[]>([])
  const [briefing, setBriefing] = useState('')
  const [angle, setAngle]       = useState<'lifestyle' | 'investment'>('lifestyle')
  const [busy, setBusy]         = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr]           = useState('')

  useEffect(() => { void (async () => {
    const { data } = await supabase.from('crm_projects').select('id, name, developer, deck_assets, furniture_cost, furniture_included, latitude, longitude').order('name')
    setProjects((data ?? []) as ProjectRow[])
  })() }, [])

  useEffect(() => { void (async () => {
    setSel(new Set())
    if (!projectId) { setUnits([]); return }
    // Alle ANBIETBAREN Wohnungen — nicht nur status='proposal'. Off-Plan-Wohnungen
    // (under_construction) UND manuell angelegte sind verkaufbar; verkauft/reserviert
    // UND an einen aktiven Deal gebundene Wohnungen werden ausgeblendet (= schon weg).
    const [{ data }, { data: dealRows }] = await Promise.all([
      supabase.from('crm_project_units')
        .select('id, unit_number, bedrooms, size_sqm, terrace_sqm, price_net, price_gross, floor')
        .eq('project_id', projectId).not('status', 'in', '(sold,reserved)').order('unit_number'),
      supabase.from('deals').select('unit_id').is('archived_from_phase', null).neq('phase', 'deal_verloren').not('unit_id', 'is', null),
    ])
    const taken = new Set((dealRows ?? []).map(d => (d as { unit_id: string }).unit_id))
    setUnits((data ?? []).filter(u => !taken.has((u as { id: string }).id)) as UnitRow[])
  })() }, [projectId])

  const project = projects.find(p => p.id === projectId)
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  // Filter: Schlafzimmer + Preis-Spanne (Preis = brutto, sonst netto — wie in der Liste).
  const matchBed = (n: number | null) =>
    filterBed === 'all' ? true : filterBed === '4' ? (n ?? 0) >= 4 : String(n ?? '') === filterBed
  const shownUnits = units.filter(u => {
    const price = u.price_gross ?? u.price_net ?? 0
    if (!matchBed(u.bedrooms)) return false
    if (filterMin > 0 && price < filterMin) return false
    if (filterMax > 0 && price > filterMax) return false
    return true
  })

  const addToBasket = () => {
    if (!project) return
    const adds = units.filter(u => sel.has(u.id) && !basket.some(b => b.unit.id === u.id))
      .map(u => ({ projectId: project.id, projectName: project.name, assets: project.deck_assets, unit: u, furnitureCost: project.furniture_cost, furnitureIncluded: project.furniture_included, lat: project.latitude, lng: project.longitude }))
    setBasket(b => [...b, ...adds])
    setSel(new Set())
  }
  const removeFromBasket = (unitId: string) => setBasket(b => b.filter(x => x.unit.id !== unitId))

  // Ein personalisiertes Deck pro Wohnung erzeugen (Hintergrund) + auf Token pollen
  const genOne = async (item: BasketItem): Promise<{ token: string; label: string; item: BasketItem } | null> => {
    const a = item.assets
    if (!a?.facts) throw new Error(`${item.projectName}: ${t('crm.wizard.noFacts', 'keine Projekt-Fakten — erst „Aus Drive laden" im Projekt')}`)
    const u = item.unit
    const unitFacts = `\n\n=== DIESE WOHNUNG: ${u.unit_number} ===\n${u.bedrooms ?? '?'} Schlafzimmer · ${u.size_sqm ?? '?'} m² Innenfläche${u.terrace_sqm ? ` + ${u.terrace_sqm} m² Außenfläche` : ''}${u.floor != null ? ` · ${u.floor}. Etage` : ''}.\nPreis: ${eur(u.price_gross ?? u.price_net)}${u.price_gross && u.price_net ? ` (netto ${eur(u.price_net)})` : ''}.`
    const fp = (a.floorplans ?? []).find(f => f.floor === u.floor)?.url ?? (a.floorplans ?? [])[0]?.url
    const images = { renders: a.renders ?? [], gallery: a.gallery ?? [], floorplan: fp, map: a.map ?? undefined, mapUrl: a.mapUrl ?? undefined, mapMarker: a.mapMarker ?? undefined, mapLat: item.lat ?? undefined, mapLng: item.lng ?? undefined }
    // letztes bestehendes Deck dieser Wohnung merken → auf NEUES Token pollen
    const { data: prev } = await supabase.from('sales_decks').select('token, created_at').eq('lead_id', lead.id).eq('unit_id', u.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const prevTok = (prev as { token?: string } | null)?.token ?? null
    const { error } = await supabase.functions.invoke('generate-deck', { body: {
      background: true, recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), angle, briefing,
      facts: a.facts + unitFacts, images, lead_id: lead.id, project_id: item.projectId, unit_id: u.id,
    } })
    if (error) throw new Error(error.message)
    for (let i = 0; i < 36; i++) {   // bis ~3 Min
      await sleep(5000)
      const { data: row } = await supabase.from('sales_decks').select('token').eq('lead_id', lead.id).eq('unit_id', u.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
      const tok = (row as { token?: string } | null)?.token ?? null
      if (tok && tok !== prevTok) return { token: tok, label: `${item.projectName} · ${u.unit_number}`, item }
    }
    return null
  }

  const generateAll = async (background = false) => {
    if (!basket.length) return
    // Hintergrund-Modus: Fenster sofort schließen, alles läuft detached weiter. Am Ende
    // meldet ein kleines Popup (onDone-Toast auf der Lead-Seite), dass Deck/Rechnung/
    // Vergleich/Mail fertig sind und im Postausgang liegen — Sven kann derweil weiterarbeiten.
    if (background) onClose()
    setBusy(true); setErr('')
    try {
      const links: { token: string; label: string; item: BasketItem }[] = []
      for (let i = 0; i < basket.length; i++) {
        setProgress(t('crm.wizard.generating', 'Erstelle Deck') + ` ${i + 1}/${basket.length} — ${basket[i].projectName} · ${basket[i].unit.unit_number}…`)
        const r = await genOne(basket[i])
        if (r) links.push(r)
      }
      if (!links.length) throw new Error(t('crm.wizard.noneDone', 'Kein Deck fertig geworden — bitte erneut versuchen.'))
      // Begleit-Mail von der KI schreiben lassen (ausführlich, locker, kein Slang) → Postausgang (Entwurf).
      // Fällt bei Fehler/fehlendem Key auf eine schlanke Vorlage zurück, damit nie ohne Mail dastehen.
      const origin = window.location.origin
      // Verfügbarkeit je Projekt (Knappheit als echtes Verkaufsargument in der Mail)
      const projIds = [...new Set(links.map(l => l.item.projectId))]
      const availByProject: Record<string, { available: number; total: number }> = {}
      for (const pid of projIds) {
        const { count: total } = await supabase.from('crm_project_units').select('id', { count: 'exact', head: true }).eq('project_id', pid)
        const { count: free }  = await supabase.from('crm_project_units').select('id', { count: 'exact', head: true }).eq('project_id', pid).not('status', 'in', '(sold,reserved)')
        availByProject[pid] = { available: free ?? 0, total: total ?? 0 }
      }
      // Pro Wohnung eine EIGENE Rendite-Berechnung — Wertentwicklung & Rendite unterscheiden
      // sich je Projekt/Standort. Jede Wohnung bekommt ihren eigenen /rechnung-Link
      // (läuft nicht ab) mit den für sie gesetzten Werten.
      const calcLinkByToken: Record<string, string> = {}
      let compareLink: string | undefined
      if (withCalc) {
        const recipientName = `${lead.first_name} ${lead.last_name}`.trim()
        const compareItems: CalcItem[] = []
        // 1) Pro Wohnung eine EIGENE Berechnung (Einzelobjekt, detaillierte Auswertung)
        for (let i = 0; i < links.length; i++) {
          const l = links[i]
          setProgress(t('crm.wizard.calcCreating', 'Erstelle Berechnung') + ` ${i + 1}/${links.length}…`)
          const pu = perUnit[l.item.unit.id] ?? {}
          // Möbel-Default-Kette: manuelle Eingabe je Wohnung → Projekt-Standard
          // (crm_projects.furniture_cost/_included) → globaler Wizard-Wert.
          const params: CalcParams = {
            ...calcParams, dealType: 'single',
            priceNet:        l.item.unit.price_net ?? calcParams.priceNet,
            bedrooms:        l.item.unit.bedrooms ?? 2,
            yieldPct:        pu.yieldPct ?? calcParams.yieldPct,
            appreciationPct: pu.appreciationPct ?? calcParams.appreciationPct,
            furnCost:        pu.furnCost ?? l.item.furnitureCost ?? calcParams.furnCost,
            furnFree:        pu.furnFree ?? l.item.furnitureIncluded ?? calcParams.furnFree,
            hotelConcept:    pu.hotelConcept ?? calcParams.hotelConcept,
          }
          const calcItem: CalcItem = {
            label: l.label, project: l.item.projectName, unit: l.item.unit.unit_number,
            bedrooms: l.item.unit.bedrooms, size_sqm: l.item.unit.size_sqm, terrace_sqm: l.item.unit.terrace_sqm, floor: l.item.unit.floor,
            price_net: l.item.unit.price_net, price_gross: l.item.unit.price_gross, params,
          }
          compareItems.push(calcItem)
          const content = { with_calc: true, recipient_name: recipientName, items: [calcItem] }
          const { data: calcRow } = await supabase.from('property_calculations').insert({
            lead_id: lead.id, recipient_name: recipientName, title: `Rechnung ${l.label}`, with_calc: true, content,
          }).select('token').single()
          const tok = (calcRow as { token?: string } | null)?.token
          if (tok) calcLinkByToken[l.token] = `${origin}/rechnung/${tok}`
        }
        // 2) Abschließend ein separater Immobilienvergleich ALLER Wohnungen (≥2 Objekte) —
        //    dieselben Per-Wohnung-Parameter, nur alle in EINER Vergleichs-Ansicht.
        if (compareItems.length >= 2) {
          setProgress(t('crm.wizard.compareCreating', 'Erstelle Immobilienvergleich…'))
          const content = { with_calc: true, recipient_name: recipientName, items: compareItems }
          const { data: cmpRow } = await supabase.from('property_calculations').insert({
            lead_id: lead.id, recipient_name: recipientName, title: 'Immobilienvergleich', with_calc: true, content,
          }).select('token').single()
          const tok = (cmpRow as { token?: string } | null)?.token
          if (tok) compareLink = `${origin}/rechnung/${tok}`
        }
      }
      const mailItems = links.map(l => ({
        label: l.label, link: `${origin}/deck/${l.token}`,
        calc_link: calcLinkByToken[l.token],   // eigene Rendite-Berechnung je Wohnung
        image: l.item.assets?.renders?.[0] ?? l.item.assets?.gallery?.[0]?.url,   // Projektbild für die Mail-Kachel
        project: l.item.projectName, unit: l.item.unit.unit_number,
        bedrooms: l.item.unit.bedrooms, size_sqm: l.item.unit.size_sqm, terrace_sqm: l.item.unit.terrace_sqm,
        floor: l.item.unit.floor, price: eur(l.item.unit.price_gross ?? l.item.unit.price_net),
        // echte Projekt-Fakten (Amenities/Lage/Bauträger) → KI zieht Verkaufsargumente daraus
        facts: (l.item.assets?.facts ?? '').slice(0, 2600),
        available_count: availByProject[l.item.projectId]?.available ?? null,
        total_count:     availByProject[l.item.projectId]?.total ?? null,
      }))
      setProgress(t('crm.wizard.composingMail', 'Schreibe Begleit-Mail…'))
      let subject = links.length > 1 ? t('crm.wizard.subjectMulti', 'Deine Wohnungs-Vorschläge von Happy Property') : `${t('crm.wizard.subjectOne', 'Dein Vorschlag')}: ${links[0].label}`
      const compareLabel = t('crm.wizard.compareLabel', 'Dein Immobilienvergleich – alle Wohnungen direkt gegenübergestellt')
      // Hochwertiger HTML-Fallback im CI (mit CTA + Buttons + Projektbild) — falls der
      // KI-Aufruf ausnahmsweise nicht durchkommt, ist die Mail trotzdem ordentlich.
      const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const CALENDLY = 'https://calendly.com/sven-happy-property/30min'
      const mbtn = (href: string, label: string, bg: string, color: string, border = 'none') =>
        `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${color};text-decoration:none;font-weight:600;font-size:15px;padding:11px 22px;border-radius:10px;border:${border};margin:0 8px 8px 0">${esc(label)}</a>`
      const fbCards = mailItems.map(m =>
        `<div style="border:1px solid #eee;border-radius:14px;padding:18px;margin:0 0 14px;background:#fafafa">`
        + (m.image ? `<img src="${esc(m.image)}" width="100%" style="width:100%;max-height:200px;object-fit:cover;border-radius:10px;margin:0 0 14px;display:block" />` : '')
        + `<div style="font-weight:700;font-size:18px;color:#1a1a1a;margin:0 0 12px">${esc(m.label)}</div>`
        + mbtn(m.link, 'Dein Sales Deck ansehen →', '#ff795d', '#ffffff')
        + (m.calc_link ? mbtn(m.calc_link, '📊 Rendite-Berechnung →', '#2f6b4f', '#ffffff') : '')
        + `</div>`).join('')
      const fbCompare = compareLink ? `<div style="margin:0 0 18px;padding:16px 18px;border-radius:12px;background:#f0f7f4;border:1px solid #d4e9df"><div style="font-weight:700;margin:0 0 10px">📊 ${esc(compareLabel)}</div>${mbtn(compareLink, 'Immobilienvergleich ansehen →', '#2f6b4f', '#ffffff')}</div>` : ''
      const fbCta = `<div style="margin:24px 0 8px;padding:22px;border-radius:14px;background:#1a1a1a"><div style="font-weight:700;font-size:17px;color:#ffffff;margin:0 0 12px">Wie geht es weiter?</div><div style="color:#d4d4d4;line-height:1.6;margin:0 0 14px">Lass uns die Optionen gemeinsam durchgehen — buch dir einfach einen neuen Termin oder gib mir kurz Feedback.</div>${mbtn(CALENDLY, '📅 Neuen Termin buchen', '#ff795d', '#ffffff')}${mbtn('mailto:sven@happy-property.com', '✉️ Per E-Mail', 'transparent', '#ffffff', '1px solid #555')}</div>`
      // Warmes Anschreiben (KEIN Roh-Briefing-Dump — das Briefing sind Svens interne Notizen).
      const fbIntro = ['vielen Dank für das sympathische Gespräch.',
        'Ich habe dir ein paar Objekte herausgesucht und hoffe, dass das ein oder andere deinen Vorstellungen entspricht.',
        'Gib mir bitte zeitnah Feedback, da der Markt hier sehr dynamisch ist und ich dir eine Immobilie nicht reservieren kann.']
        .map(p => `<p style="margin:0 0 16px">${esc(p)}</p>`).join('')
      let body = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:#2b2b2b;max-width:600px;margin:0 auto"><p style="margin:0 0 16px">Hallo ${esc(lead.first_name)},</p>${fbIntro}${fbCards}${fbCompare}${fbCta}<p style="margin:24px 0 4px">Ich freue mich von dir zu hören.</p><p style="margin:0">Liebe Grüße,<br><strong>Sven · Happy Property Cyprus</strong></p></div>`
      // KI-Mail mit Retry (lange Hintergrund-Läufe lassen den ersten Invoke gelegentlich
      // ins Leere laufen → einmal nachfassen, bevor wir auf den Fallback zurückfallen).
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data: mail, error: mErr } = await supabase.functions.invoke('compose-deck-mail', { body: {
            recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), first_name: lead.first_name,
            briefing, angle, items: mailItems,
            calc_link: compareLink, calc_label: compareLabel,   // abschließender Gesamt-Vergleich
          } })
          if (mErr) throw mErr
          const mm = mail as { subject?: string; html?: string } | null
          if (mm?.subject && mm?.html) { subject = mm.subject; body = mm.html; break }
        } catch { if (attempt === 0) await sleep(2500) }
      }
      const { error: oErr } = await supabase.from('deck_outbox').insert({
        lead_id: lead.id, recipient_email: lead.email, subject, body, deck_tokens: links.map(l => l.token), status: 'draft',
      })
      if (oErr) throw new Error(oErr.message)
      onDone(`✅ ${links.length} ${t('crm.wizard.doneToast', 'Deck(s) erstellt — liegen im Postausgang zur Freigabe.')}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Fehler'
      // Im Hintergrund-Modus ist das Fenster schon zu → Fehler als Popup melden statt inline.
      if (background) onDone(`❌ ${t('crm.wizard.bgError', 'Erstellung fehlgeschlagen')}: ${msg}`)
      else setErr(msg)
    } finally {
      setBusy(false); setProgress('')
    }
  }

  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'

  // Kompakte Rechner-Parameter (inline Render-Funktionen — keine verschachtelten Komponenten)
  const setCp = (k: keyof CalcParams, v: number | string | boolean) => setCalcParams(prev => ({ ...prev, [k]: v }) as CalcParams)
  const numF = (label: string, k: keyof CalcParams, step = '1', suffix?: string) => (
    <label key={k} className="block">
      <span className="block text-xs font-medium text-gray-500 mb-1">{label}</span>
      <NumberStepper value={Number(calcParams[k] ?? 0)} onChange={v => setCp(k, v)} step={parseFloat(step)} suffix={suffix} />
    </label>
  )
  const seg = (label: string, k: keyof CalcParams, opts: [string, string][]) => (
    <div key={k}>
      <span className="block text-[11px] text-gray-500 mb-0.5">{label}</span>
      <div className="flex rounded-lg overflow-hidden border border-gray-200">
        {opts.map(([val, lab]) => (
          <button key={val} type="button" onClick={() => setCp(k, val)}
            className={`flex-1 px-1.5 py-1 text-[11px] font-medium ${String(calcParams[k]) === val ? 'bg-orange-500 text-white' : 'bg-white text-gray-600'}`}>{lab}</button>
        ))}
      </div>
    </div>
  )
  const cpToggle = (label: string, k: keyof CalcParams) => (
    <button key={k} type="button" onClick={() => setCp(k, !calcParams[k])}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium ${calcParams[k] ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600'}`}>
      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${calcParams[k] ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300'}`}>{calcParams[k] ? '✓' : ''}</span>
      {label}
    </button>
  )

  // Backdrop hat bewusst KEINEN onClick={onClose} — sonst gehen bei versehentlichem
  // Klick neben das Fenster alle Eingaben verloren. Schließen nur über ✕ / Abbrechen.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white">
          <h2 className="text-lg font-bold text-gray-900">{t('crm.wizard.title', 'Sales Deck erstellen')} — {lead.first_name} {lead.last_name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
        </div>

        <div className="p-6 space-y-5">
          {/* Projekt + Wohnungen */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.developer', 'Developer')}</label>
              <CustomSelect
                value={developer}
                onChange={v => { setDeveloper(v); setProjectId('') }}
                options={[{ value: '', label: t('crm.wizard.allDevelopers', 'Alle') },
                  ...[...new Set(projects.map(p => p.developer).filter(Boolean))].sort().map(d => ({ value: d as string, label: d as string }))]}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.project', 'Projekt')}</label>
              <CustomSelect
                value={projectId}
                onChange={setProjectId}
                placeholder={t('crm.wizard.choose', '— wählen —')}
                options={projects.filter(p => !developer || p.developer === developer).map(p => ({ value: p.id, label: p.name }))}
              />
            </div>
          </div>

          {projectId && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.units', 'Vorschlags-Wohnungen')} ({shownUnits.length}{shownUnits.length !== units.length ? ` / ${units.length}` : ''})</label>
              {units.length === 0 && <p className="text-sm text-gray-400">{t('crm.wizard.noUnits', 'Keine Vorschlags-Wohnungen — im Projekt „Aus Drive laden" ausführen.')}</p>}
              {/* Filter: Schlafzimmer + Preis-Spanne */}
              {units.length > 0 && (
                <div className="flex flex-wrap items-end gap-3 mb-2.5">
                  <div>
                    <span className="block text-[11px] font-medium text-gray-500 mb-1">{t('crm.wizard.bedrooms', 'Schlafzimmer')}</span>
                    <div className="flex rounded-lg overflow-hidden border border-gray-200">
                      {(['all', '1', '2', '3', '4'] as const).map(b => (
                        <button key={b} type="button" onClick={() => setFilterBed(b)}
                          className={`px-2.5 py-1.5 text-xs font-medium border-l first:border-l-0 border-gray-200 ${filterBed === b ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                          {b === 'all' ? t('crm.wizard.all', 'Alle') : b === '4' ? '4+' : b}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="block text-[11px] font-medium text-gray-500 mb-1">{t('crm.wizard.priceFrom', 'Preis von')}</span>
                    <NumberStepper value={filterMin} onChange={setFilterMin} step={25000} suffix="€" className="w-36" />
                  </div>
                  <div>
                    <span className="block text-[11px] font-medium text-gray-500 mb-1">{t('crm.wizard.priceTo', 'bis')}</span>
                    <NumberStepper value={filterMax} onChange={setFilterMax} step={25000} suffix="€" className="w-36" />
                  </div>
                  {(filterBed !== 'all' || filterMin > 0 || filterMax > 0) && (
                    <button type="button" onClick={() => { setFilterBed('all'); setFilterMin(0); setFilterMax(0) }}
                      className="text-xs text-gray-400 hover:text-gray-600 underline pb-2">{t('crm.wizard.resetFilter', 'zurücksetzen')}</button>
                  )}
                </div>
              )}
              {units.length > 0 && shownUnits.length === 0 && <p className="text-sm text-gray-400 mb-2">{t('crm.wizard.noFilterMatch', 'Keine Wohnung im gewählten Filter.')}</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto">
                {shownUnits.map(u => (
                  <label key={u.id} className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm cursor-pointer ${sel.has(u.id) ? 'border-orange-400 bg-orange-50' : 'border-gray-200'}`}>
                    <input type="checkbox" checked={sel.has(u.id)} onChange={() => toggle(u.id)} />
                    <span><strong>{u.unit_number}</strong> · {u.bedrooms ?? '?'} SZ · {u.size_sqm ?? '?'} m² · {eur(u.price_gross ?? u.price_net)}</span>
                  </label>
                ))}
              </div>
              {sel.size > 0 && (
                <button onClick={addToBasket} className="mt-2 px-3 py-1.5 rounded-lg text-sm font-medium border border-orange-300 text-orange-700 hover:bg-orange-50">
                  + {sel.size} {t('crm.wizard.addToBasket', 'ins Paket')}
                </button>
              )}
            </div>
          )}

          {/* Paket */}
          {basket.length > 0 && (
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.wizard.basket', 'Paket')} ({basket.length})</p>
              <div className="space-y-1">
                {basket.map(b => (
                  <div key={b.unit.id} className="flex items-center justify-between text-sm bg-white rounded-lg px-3 py-1.5">
                    <span>{b.projectName} · <strong>{b.unit.unit_number}</strong> · {eur(b.unit.price_gross ?? b.unit.price_net)}</span>
                    <button onClick={() => removeFromBasket(b.unit.id)} className="text-gray-400 hover:text-red-500">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Freitext + Winkel */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.briefing', 'Freitext (für Deck-Anschreiben + Mail)')}</label>
              <textarea rows={3} className={inputCls} value={briefing} onChange={e => setBriefing(e.target.value)}
                placeholder={t('crm.wizard.briefingPh', 'z.B. Sucht 2 SZ mit Meerblick, Budget bis 450k, will vermieten…')} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.angle', 'Winkel')}</label>
              <CustomSelect
                value={angle}
                onChange={v => setAngle(v as 'lifestyle' | 'investment')}
                options={[{ value: 'lifestyle', label: t('crm.wizard.lifestyle', 'Lifestyle') },
                  { value: 'investment', label: t('crm.wizard.investment', 'Investment') }]}
              />
            </div>
          </div>

          {/* Mit / ohne Berechnung */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={withCalc} onChange={e => setWithCalc(e.target.checked)} className="w-4 h-4 accent-orange-500" />
              <span className="text-sm font-medium text-gray-700">📊 {t('crm.wizard.withCalc', 'Mit Rendite-Berechnung / Vergleich')}</span>
            </label>
            {withCalc && (
              <div className="mt-3 space-y-3 border border-gray-100 rounded-xl p-3 bg-gray-50">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {seg('Steuersitz', 'res', [['de', 'DE'], ['cy', 'CY']])}
                  {seg('Finanzierung', 'fin', [['yes', 'Ja'], ['no', 'Cash']])}
                  {seg('Vermietung', 'letType', [['short', 'Kurz'], ['long', 'Lang']])}
                  {seg('Tilgung', 'mode', [['ann', 'Annuität'], ['tilg', 'Fix']])}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {numF('Eigenkapital', 'equity', '1000', '€')}
                  {numF('Zins', 'interestPct', '0.1', '%')}
                  {numF('Laufzeit', 'termYears', '1', 'J')}
                  {numF('Rendite', 'yieldPct', '0.1', '%')}
                  {numF('Mietsteig.', 'rentGrowth', '0.1', '%')}
                  {numF('Verwaltung', 'mgmtPct', '0.5', '%')}
                  {numF('Wertsteig.', 'appreciationPct', '0.1', '%')}
                  {calcParams.res === 'de' && numF('DE-Steuer', 'deTaxPct', '1', '%')}
                  {calcParams.res === 'cy' && numF('CY Bestand', 'cyBI', '500', '€')}
                  {calcParams.mode === 'tilg' && numF('Tilgung', 'amortPct', '0.1', '%')}
                  {numF('Rabatt', 'discountPct', '0.5', '%')}
                  {numF('Einrichtung', 'furnCost', '500', '€')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {cpToggle('Einrichtung kostenfrei', 'furnFree')}
                  {calcParams.letType === 'short' && cpToggle('🏨 Hotelkonzept', 'hotelConcept')}
                </div>
                {/* Pro Wohnung: Rendite, Wertsteigerung, Einrichtungspaket-Preis (Möbel-AfA!),
                    Möbelpaket kostenfrei, Hotelkonzept — unterscheiden sich je Objekt.
                    Werte oben gelten als Standard; hier je Wohnung feinjustieren. */}
                {basket.length > 0 && (
                  <div className="border-t border-gray-200 pt-3 space-y-2">
                    <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('crm.wizard.perUnitTitle', 'Je Wohnung: Rendite, Wertsteigerung, Einrichtung')}</div>
                    {basket.map(b => {
                      const pu = perUnit[b.unit.id] ?? {}
                      const ff = pu.furnFree ?? b.furnitureIncluded ?? calcParams.furnFree
                      const hc = pu.hotelConcept ?? calcParams.hotelConcept
                      const miniInput = (lab: string, val: string, on: (v: number) => void, step = '0.1', suf = '%') => (
                        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                          <span>{lab}</span>
                          <NumberStepper value={parseFloat(val) || 0} onChange={on} step={parseFloat(step)} suffix={suf} className="w-32" />
                        </label>
                      )
                      return (
                        <div key={b.unit.id} className="bg-white rounded-lg border border-gray-100 px-2.5 py-2 space-y-1.5">
                          <div className="text-xs font-medium text-gray-700 truncate">{b.projectName} · {b.unit.unit_number}</div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                            {miniInput(t('crm.wizard.rendite', 'Rendite'), String(pu.yieldPct ?? calcParams.yieldPct ?? ''), v => setPu(b.unit.id, { yieldPct: v }))}
                            {miniInput(t('crm.wizard.wertsteig', 'Wertsteig.'), String(pu.appreciationPct ?? calcParams.appreciationPct ?? ''), v => setPu(b.unit.id, { appreciationPct: v }))}
                            {miniInput(t('crm.wizard.einrichtung', 'Einrichtung'), String(pu.furnCost ?? b.furnitureCost ?? calcParams.furnCost ?? ''), v => setPu(b.unit.id, { furnCost: v }), '500', '€')}
                            <button type="button" onClick={() => setPu(b.unit.id, { furnFree: !ff })}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium ${ff ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600'}`}>
                              <span className={`w-3 h-3 rounded border flex items-center justify-center text-[8px] ${ff ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300'}`}>{ff ? '✓' : ''}</span>
                              {t('crm.wizard.furnFree', 'Möbel gratis')}
                            </button>
                            {calcParams.letType === 'short' && (
                              <button type="button" onClick={() => setPu(b.unit.id, { hotelConcept: !hc })}
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium ${hc ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600'}`}>
                                <span className={`w-3 h-3 rounded border flex items-center justify-center text-[8px] ${hc ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300'}`}>{hc ? '✓' : ''}</span>
                                🏨 {t('crm.wizard.hotel', 'Hotelkonzept')}
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="text-[11px] text-gray-400">{t('crm.wizard.calcHint', 'Kaufpreis je Wohnung kommt automatisch. Jede Wohnung erhält eine EIGENE Berechnung (eigener Link). Voller Funktionsumfang (Sondertilgung, Share-Deal) im dedizierten Rechner.')}</p>
              </div>
            )}
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
          {busy && <p className="text-sm text-orange-700 bg-orange-50 rounded-lg px-3 py-2">⏳ {progress || t('crm.wizard.working', 'Arbeite…')}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-100 sticky bottom-0 bg-white">
          <p className="text-xs text-gray-400">{t('crm.wizard.hint', 'Jede Wohnung → eigenes Deck. Eine Mail in den Postausgang.')}</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200">{t('common.cancel', 'Abbrechen')}</button>
            {/* Im Hintergrund: Fenster schließt sofort, Sven kann weiterarbeiten; Popup am Ende. */}
            <button onClick={() => void generateAll(true)} disabled={busy || basket.length === 0}
              className="px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-40"
              style={{ borderColor: '#ff795d', color: '#ff795d' }}>
              {t('crm.wizard.createBg', 'Im Hintergrund erstellen')}
            </button>
            <button onClick={() => void generateAll(false)} disabled={busy || basket.length === 0}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {busy ? t('crm.wizard.creating', 'Erstelle…') : `${t('crm.wizard.createAll', 'Alle Decks erstellen')} (${basket.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
