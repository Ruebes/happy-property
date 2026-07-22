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
interface ProjectRow { id: string; name: string; developer: string | null; deck_assets: DeckAssetsCache | null; furniture_cost: number | null; furniture_included: boolean | null; latitude: number | null; longitude: number | null; completion_date: string | null }
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
  // Per-Wohnung-Overrides: ALLE relevanten Parameter je Wohnung einzeln (sinnvoll, wenn
  // mehrere Immos zugleich angeboten werden — z.B. eine Kurz-, eine Langzeit-Vermietung,
  // unterschiedliche Finanzierung). Leer = globaler Standard oben.
  type PerUnit = {
    yieldPct?: number; appreciationPct?: number; furnCost?: number; furnFree?: boolean; hotelConcept?: boolean
    letType?: 'short' | 'long'; fin?: 'yes' | 'no'; equity?: number; amortPct?: number; deTaxPct?: number
  }
  const [perUnit, setPerUnit] = useState<Record<string, PerUnit>>({})
  const setPu = (id: string, patch: Partial<PerUnit>) =>
    setPerUnit(p => ({ ...p, [id]: { ...p[id], ...patch } }))
  const [units, setUnits]       = useState<UnitRow[]>([])
  const [filterBed, setFilterBed] = useState<'all' | '1' | '2' | '3' | '4'>('all')
  const [filterMin, setFilterMin] = useState(0)
  const [filterMax, setFilterMax] = useState(0)
  const [sel, setSel]           = useState<Set<string>>(new Set())
  const [basket, setBasket]     = useState<BasketItem[]>([])
  const [briefing, setBriefing] = useState('')
  const [angle, setAngle]       = useState<'eigennutz' | 'investment'>('eigennutz')
  const [handoverDate, setHandoverDate] = useState('')   // Zeitpunkt der Übergabe (= crm_projects.completion_date)
  const [busy, setBusy]         = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr]           = useState('')

  useEffect(() => { void (async () => {
    const { data } = await supabase.from('crm_projects').select('id, name, developer, deck_assets, furniture_cost, furniture_included, latitude, longitude, completion_date').order('name')
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
  // Übergabe-Datum aus dem gewählten Projekt vorbelegen (YYYY-MM-DD fürs date-Input).
  useEffect(() => { setHandoverDate((project?.completion_date ?? '').slice(0, 10)) }, [projectId, project?.completion_date])
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

  // EIN Deck pro PROJEKT erzeugen — mit allen gewählten Wohnungen des Projekts (je
  // eigener unit-Block + Preis). Hintergrund + auf neues Token pollen (per Projekt).
  const genProject = async (items: BasketItem[]): Promise<{ token: string; label: string; items: BasketItem[] } | null> => {
    const first = items[0]
    const a = first.assets
    if (!a?.facts) throw new Error(`${first.projectName}: ${t('crm.wizard.noFacts', 'keine Projekt-Fakten — erst „Aus Drive laden" im Projekt')}`)
    const unitFacts = items.map(it => {
      const u = it.unit
      return `\n\n=== WOHNUNG: ${u.unit_number} ===\n${u.bedrooms ?? '?'} Schlafzimmer · ${u.size_sqm ?? '?'} m² Innenfläche${u.terrace_sqm ? ` + ${u.terrace_sqm} m² Außenfläche` : ''}${u.floor != null ? ` · ${u.floor}. Etage` : ''}.`
    }).join('')
    // Grundrisse je Wohnung (nach Etage), Dubletten raus
    const floorplans = [...new Set(items.map(it => (a.floorplans ?? []).find(f => f.floor === it.unit.floor)?.url).filter(Boolean) as string[])]
    const images = { renders: a.renders ?? [], gallery: a.gallery ?? [], floorplan: floorplans[0] ?? (a.floorplans ?? [])[0]?.url, floorplans, map: a.map ?? undefined, mapUrl: a.mapUrl ?? undefined, mapMarker: a.mapMarker ?? undefined, mapLat: first.lat ?? undefined, mapLng: first.lng ?? undefined }
    const units = items.map(it => ({ unit_number: it.unit.unit_number, price_net: it.unit.price_net }))
    const label = items.length > 1 ? `${first.projectName} (${items.length} ${t('crm.wizard.apartments', 'Wohnungen')})` : `${first.projectName} · ${first.unit.unit_number}`
    // letztes Deck dieses Projekts für den Lead merken → auf NEUES Token pollen
    const { data: prev } = await supabase.from('sales_decks').select('token').eq('lead_id', lead.id).eq('project_id', first.projectId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const prevTok = (prev as { token?: string } | null)?.token ?? null
    // Übergabe-Datum am Projekt sichern, bevor das Deck generiert wird — generate-deck
    // liest die geplante Fertigstellung aus crm_projects.completion_date.
    if (handoverDate && handoverDate !== (project?.completion_date ?? '').slice(0, 10)) {
      await supabase.from('crm_projects').update({ completion_date: handoverDate }).eq('id', first.projectId)
    }
    const { error } = await supabase.functions.invoke('generate-deck', { body: {
      background: true, recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), angle, briefing,
      facts: a.facts + unitFacts, images, lead_id: lead.id, project_id: first.projectId,
      unit_id: items.length === 1 ? first.unit.id : null, units,
      month_label: new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
    } })
    if (error) throw new Error(error.message)
    for (let i = 0; i < 36; i++) {   // bis ~3 Min
      await sleep(5000)
      const { data: row } = await supabase.from('sales_decks').select('token').eq('lead_id', lead.id).eq('project_id', first.projectId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      const tok = (row as { token?: string } | null)?.token ?? null
      if (tok && tok !== prevTok) return { token: tok, label, items }
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
      // Korb nach PROJEKT gruppieren → pro Projekt EIN Deck + EINE Berechnung (mit allen
      // gewählten Wohnungen des Projekts). Reihenfolge = erste Auswahl-Reihenfolge.
      const groupsMap = new Map<string, BasketItem[]>()
      for (const b of basket) { const g = groupsMap.get(b.projectId); if (g) g.push(b); else groupsMap.set(b.projectId, [b]) }
      const groups = [...groupsMap.values()]
      const links: { token: string; label: string; items: BasketItem[] }[] = []
      for (let i = 0; i < groups.length; i++) {
        setProgress(t('crm.wizard.generating', 'Erstelle Deck') + ` ${i + 1}/${groups.length} — ${groups[i][0].projectName}…`)
        const r = await genProject(groups[i])
        if (r) links.push(r)
      }
      if (!links.length) throw new Error(t('crm.wizard.noneDone', 'Kein Deck fertig geworden — bitte erneut versuchen.'))
      // Begleit-Mail von der KI schreiben lassen → Postausgang (Entwurf). Fällt bei Fehler
      // auf eine schlanke CI-Vorlage zurück, damit nie ohne Mail dastehen.
      const origin = window.location.origin
      // Verfügbarkeit je Projekt (Knappheit als Verkaufsargument in der Mail)
      const projIds = [...new Set(links.map(l => l.items[0].projectId))]
      const availByProject: Record<string, { available: number; total: number }> = {}
      for (const pid of projIds) {
        const { count: total } = await supabase.from('crm_project_units').select('id', { count: 'exact', head: true }).eq('project_id', pid)
        const { count: free }  = await supabase.from('crm_project_units').select('id', { count: 'exact', head: true }).eq('project_id', pid).not('status', 'in', '(sold,reserved)')
        availByProject[pid] = { available: free ?? 0, total: total ?? 0 }
      }
      // Möbel-Default-Kette: manuelle Eingabe je Wohnung → Projekt-Standard → globaler Wizard-Wert.
      const buildCalcItem = (it: BasketItem): CalcItem => {
        const pu = perUnit[it.unit.id] ?? {}
        const params: CalcParams = {
          ...calcParams, dealType: 'single',
          priceNet:        it.unit.price_net ?? calcParams.priceNet,
          bedrooms:        it.unit.bedrooms ?? 2,
          letType:         pu.letType ?? calcParams.letType,
          fin:             pu.fin ?? calcParams.fin,
          equity:          pu.equity ?? calcParams.equity,
          amortPct:        pu.amortPct ?? calcParams.amortPct,
          deTaxPct:        pu.deTaxPct ?? calcParams.deTaxPct,
          yieldPct:        pu.yieldPct ?? calcParams.yieldPct,
          appreciationPct: pu.appreciationPct ?? calcParams.appreciationPct,
          furnCost:        pu.furnCost ?? it.furnitureCost ?? calcParams.furnCost,
          furnFree:        pu.furnFree ?? it.furnitureIncluded ?? calcParams.furnFree,
          // Hotelkonzept nur bei Kurzzeit dieser Wohnung
          hotelConcept:    (pu.letType ?? calcParams.letType) === 'short' ? (pu.hotelConcept ?? calcParams.hotelConcept) : false,
        }
        return {
          label: `${it.projectName} · ${it.unit.unit_number}`, project: it.projectName, unit: it.unit.unit_number,
          bedrooms: it.unit.bedrooms, size_sqm: it.unit.size_sqm, terrace_sqm: it.unit.terrace_sqm, floor: it.unit.floor,
          price_net: it.unit.price_net, price_gross: it.unit.price_gross, params,
        }
      }
      const calcLinkByToken: Record<string, string> = {}
      let compareLink: string | undefined
      if (withCalc) {
        const recipientName = `${lead.first_name} ${lead.last_name}`.trim()
        const allItems: CalcItem[] = []
        // EINE Berechnung PRO PROJEKT — alle Wohnungen des Projekts als Items (Zahlen je
        // Wohnung unterscheiden sich). Ein /rechnung-Link je Projekt-Deck.
        for (let i = 0; i < links.length; i++) {
          const l = links[i]
          setProgress(t('crm.wizard.calcCreating', 'Erstelle Berechnung') + ` ${i + 1}/${links.length}…`)
          const items = l.items.map(buildCalcItem)
          allItems.push(...items)
          const title = items.length > 1
            ? `Berechnung ${l.items[0].projectName} (${items.length} ${t('crm.wizard.apartments', 'Wohnungen')})`
            : `Rechnung ${items[0].label}`
          const content = { with_calc: true, recipient_name: recipientName, items }
          const { data: calcRow } = await supabase.from('property_calculations').insert({
            lead_id: lead.id, recipient_name: recipientName, title, with_calc: true, content,
          }).select('token').single()
          const tok = (calcRow as { token?: string } | null)?.token
          if (tok) calcLinkByToken[l.token] = `${origin}/rechnung/${tok}`
        }
        // Projektübergreifender Gesamt-Vergleich NUR bei ≥2 PROJEKTEN (vergleicht die Projekte).
        if (links.length >= 2) {
          setProgress(t('crm.wizard.compareCreating', 'Erstelle Immobilienvergleich…'))
          const content = { with_calc: true, recipient_name: recipientName, items: allItems }
          const { data: cmpRow } = await supabase.from('property_calculations').insert({
            lead_id: lead.id, recipient_name: recipientName, title: 'Immobilienvergleich', with_calc: true, content,
          }).select('token').single()
          const tok = (cmpRow as { token?: string } | null)?.token
          if (tok) compareLink = `${origin}/rechnung/${tok}`
        }
      }
      const mailItems = links.map(l => {
        const f = l.items[0]
        return {
          label: l.label, link: `${origin}/deck/${l.token}`,
          calc_link: calcLinkByToken[l.token],   // Rendite-Berechnung des Projekts (alle Wohnungen)
          image: f.assets?.renders?.[0] ?? f.assets?.gallery?.[0]?.url,   // Projektbild für die Mail-Kachel
          project: f.projectName, unit: l.items.map(it => it.unit.unit_number).join(', '),
          bedrooms: f.unit.bedrooms, size_sqm: f.unit.size_sqm, terrace_sqm: f.unit.terrace_sqm,
          floor: f.unit.floor,
          price: l.items.length > 1 ? `${l.items.length} ${t('crm.wizard.apartments', 'Wohnungen')}` : eur(f.unit.price_gross ?? f.unit.price_net),
          facts: (f.assets?.facts ?? '').slice(0, 2600),
          available_count: availByProject[f.projectId]?.available ?? null,
          total_count:     availByProject[f.projectId]?.total ?? null,
        }
      })
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
      // Postausgang-Eintrag SOFORT mit dem Fallback-Text anlegen (id merken) — so geht der
      // Eintrag NIE verloren, auch wenn die KI-Mail oder der Browser-Tab danach abbricht
      // (Decks + Berechnungen sind zu diesem Zeitpunkt schon erstellt). Anschließend wird
      // er mit der hochwertigen KI-Mail aktualisiert.
      const { data: oboxRow, error: oErr } = await supabase.from('deck_outbox').insert({
        lead_id: lead.id, recipient_email: lead.email, subject, body, deck_tokens: links.map(l => l.token), status: 'draft',
      }).select('id').single()
      if (oErr) throw new Error(oErr.message)
      const oboxId = (oboxRow as { id?: string } | null)?.id
      // KI-Mail mit Retry (lange Hintergrund-Läufe lassen den ersten Invoke gelegentlich ins
      // Leere laufen → einmal nachfassen). Bei Erfolg den bereits angelegten Eintrag updaten.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data: mail, error: mErr } = await supabase.functions.invoke('compose-deck-mail', { body: {
            recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), first_name: lead.first_name,
            briefing, angle, items: mailItems,
            calc_link: compareLink, calc_label: compareLabel,   // abschließender Gesamt-Vergleich
          } })
          if (mErr) throw mErr
          const mm = mail as { subject?: string; html?: string } | null
          if (mm?.subject && mm?.html && oboxId) {
            await supabase.from('deck_outbox').update({ subject: mm.subject, body: mm.html }).eq('id', oboxId)
            break
          }
        } catch { if (attempt === 0) await sleep(2500) }
      }
      onDone(`✅ ${links.length} ${t('crm.wizard.doneToast', 'Deck(s) erstellt — liegen im Postausgang zur Freigabe.')}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('deckWizard.genericError', 'Fehler')
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
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.handover', 'Zeitpunkt der Übergabe')}</label>
              <input
                type="date"
                value={handoverDate}
                onChange={e => setHandoverDate(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
              />
              <p className="text-[11px] text-gray-400 mt-1">{t('crm.wizard.handoverHint', 'Erscheint im Deck als geplante Fertigstellung. Auch im Projekt änderbar.')}</p>
            </div>
          )}
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
                onChange={v => setAngle(v as 'eigennutz' | 'investment')}
                options={[{ value: 'eigennutz', label: t('crm.wizard.eigennutz', 'Eigennutz (5 % MwSt)') },
                  { value: 'investment', label: t('crm.wizard.investment', 'Investment (19 %)') }]}
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
                  {seg(t('deckWizard.taxResidence', 'Steuersitz'), 'res', [['de', 'DE'], ['cy', 'CY']])}
                  {seg(t('deckWizard.financing', 'Finanzierung'), 'fin', [['yes', t('deckWizard.yes', 'Ja')], ['no', t('deckWizard.cash', 'Cash')]])}
                  {seg(t('deckWizard.rentalType', 'Vermietung'), 'letType', [['short', t('deckWizard.shortTerm', 'Kurz')], ['long', t('deckWizard.longTerm', 'Lang')]])}
                  {seg(t('deckWizard.amortization', 'Tilgung'), 'mode', [['ann', t('deckWizard.annuity', 'Annuität')], ['tilg', t('deckWizard.fixed', 'Fix')]])}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {numF(t('deckWizard.equity', 'Eigenkapital'), 'equity', '1000', '€')}
                  {numF(t('deckWizard.interestRate', 'Zins'), 'interestPct', '0.1', '%')}
                  {numF(t('deckWizard.termYears', 'Laufzeit'), 'termYears', '1', 'J')}
                  {numF(t('deckWizard.yieldLabel', 'Rendite'), 'yieldPct', '0.1', '%')}
                  {numF(t('deckWizard.rentGrowth', 'Mietsteig.'), 'rentGrowth', '0.1', '%')}
                  {numF(t('deckWizard.management', 'Verwaltung'), 'mgmtPct', '0.5', '%')}
                  {numF(t('deckWizard.appreciation', 'Wertsteig.'), 'appreciationPct', '0.1', '%')}
                  {calcParams.res === 'de' && numF(t('deckWizard.deTax', 'DE-Steuer'), 'deTaxPct', '1', '%')}
                  {calcParams.res === 'cy' && numF(t('deckWizard.cyStock', 'CY Bestand'), 'cyBI', '500', '€')}
                  {calcParams.mode === 'tilg' && numF(t('deckWizard.amortization', 'Tilgung'), 'amortPct', '0.1', '%')}
                  {numF(t('deckWizard.discount', 'Rabatt'), 'discountPct', '0.5', '%')}
                  {numF(t('deckWizard.furnishing', 'Einrichtung'), 'furnCost', '500', '€')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {cpToggle(t('deckWizard.furnishingFree', 'Einrichtung kostenfrei'), 'furnFree')}
                  {calcParams.letType === 'short' && cpToggle('🏨 ' + t('deckWizard.hotelConceptToggle', 'Hotelkonzept'), 'hotelConcept')}
                </div>
                {/* Je Wohnung ALLE Parameter einzeln: Vermietung (Kurz/Lang), Finanzierung,
                    Eigenkapital, Rendite, Wertsteigerung, Einrichtung, Hotelkonzept. Sinnvoll,
                    wenn mehrere Immos zugleich angeboten werden. Werte oben = Standard für alle. */}
                {basket.length > 0 && (
                  <div className="border-t border-gray-200 pt-3 space-y-2">
                    <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('crm.wizard.perUnitTitle', 'Je Wohnung einzeln (überschreibt die Standardwerte oben)')}</div>
                    {basket.map(b => {
                      const pu = perUnit[b.unit.id] ?? {}
                      const ff  = pu.furnFree ?? b.furnitureIncluded ?? calcParams.furnFree
                      const hc  = pu.hotelConcept ?? calcParams.hotelConcept
                      const let_ = pu.letType ?? calcParams.letType
                      const fin_ = pu.fin ?? calcParams.fin
                      const miniInput = (lab: string, val: string, on: (v: number) => void, step = '0.1', suf = '%') => (
                        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                          <span>{lab}</span>
                          <NumberStepper value={parseFloat(val) || 0} onChange={on} step={parseFloat(step)} suffix={suf} className="w-full" />
                        </label>
                      )
                      const puSeg = (lab: string, cur: string, opts: [string, string][], on: (v: string) => void) => (
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-gray-500">{lab}</span>
                          <div className="flex rounded-lg overflow-hidden border border-gray-200">
                            {opts.map(([val, labl]) => (
                              <button key={val} type="button" onClick={() => on(val)}
                                className={`px-2.5 py-1.5 text-[11px] font-medium ${cur === val ? 'bg-orange-500 text-white' : 'bg-white text-gray-600'}`}>{labl}</button>
                            ))}
                          </div>
                        </div>
                      )
                      return (
                        <div key={b.unit.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3.5 space-y-3">
                          <div className="text-[13px] font-semibold text-gray-800 truncate">{b.projectName} · {b.unit.unit_number}</div>
                          <div className="flex flex-wrap gap-3">
                            {puSeg(t('crm.wizard.letType', 'Vermietung'), let_, [['short', t('crm.wizard.short', 'Kurz')], ['long', t('crm.wizard.long', 'Lang')]], v => setPu(b.unit.id, { letType: v as 'short' | 'long' }))}
                            {puSeg(t('crm.wizard.fin', 'Finanzierung'), fin_, [['yes', t('crm.wizard.finYes', 'Ja')], ['no', t('crm.wizard.finNo', 'Cash')]], v => setPu(b.unit.id, { fin: v as 'yes' | 'no' }))}
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-3">
                            {fin_ === 'yes' && miniInput(t('crm.wizard.equity', 'Eigenkapital'), String(pu.equity ?? calcParams.equity ?? ''), v => setPu(b.unit.id, { equity: v }), '1000', '€')}
                            {miniInput(t('crm.wizard.rendite', 'Rendite'), String(pu.yieldPct ?? calcParams.yieldPct ?? ''), v => setPu(b.unit.id, { yieldPct: v }))}
                            {miniInput(t('crm.wizard.wertsteig', 'Wertsteig.'), String(pu.appreciationPct ?? calcParams.appreciationPct ?? ''), v => setPu(b.unit.id, { appreciationPct: v }))}
                            {fin_ === 'yes' && calcParams.mode === 'tilg' && miniInput(t('crm.wizard.amort', 'Tilgung'), String(pu.amortPct ?? calcParams.amortPct ?? ''), v => setPu(b.unit.id, { amortPct: v }))}
                            {calcParams.res === 'de' && miniInput(t('crm.wizard.deTax', 'DE-Steuer'), String(pu.deTaxPct ?? calcParams.deTaxPct ?? ''), v => setPu(b.unit.id, { deTaxPct: v }), '1')}
                            {miniInput(t('crm.wizard.einrichtung', 'Einrichtung'), String(pu.furnCost ?? b.furnitureCost ?? calcParams.furnCost ?? ''), v => setPu(b.unit.id, { furnCost: v }), '500', '€')}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button type="button" onClick={() => setPu(b.unit.id, { furnFree: !ff })}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium ${ff ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600'}`}>
                              <span className={`w-3 h-3 rounded border flex items-center justify-center text-[8px] ${ff ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300'}`}>{ff ? '✓' : ''}</span>
                              {t('crm.wizard.furnFree', 'Möbel gratis')}
                            </button>
                            {let_ === 'short' && (
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
