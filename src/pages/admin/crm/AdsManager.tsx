import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import AdStudio from '../../../components/crm/AdStudio'
import { supabase } from '../../../lib/supabase'
import { useAuth, hasAdSegment, AD_SEGMENTS, type AdSegment } from '../../../lib/auth'

// ── Werbemanager (/admin/crm/ads) ─────────────────────────────────────────────
// Auswertung der Werbe-Plattformen (Stufe 1: META live, YouTube/Google folgen).
// Datenquellen:
//   ad_catalog / ad_insights_daily  — Plattform-Zahlen (täglicher Sync)
//   leads (utm_campaign={{campaign.id}}, utm_content={{ad.id}})  — CRM-Zuordnung
//   crm_appointments.outcome + leads.quality_rating              — Termine & Qualität
//   deals (phase, commission_amount)                             — Sales & Umsatz
// CRM-Kennzahlen je Ad greifen erst, wenn die Anzeigen die URL-Parameter tragen
// (Meta-Anzeigen-URL-Setup) — bis dahin zählt die Plattform-Lead-Zahl.

interface AdCatalogRow {
  ad_id: string
  campaign_id: string
  campaign_name: string | null
  adset_id: string | null
  adset_name: string | null
  ad_name: string | null
  status: string | null
  thumbnail_url: string | null
}
interface InsightRow {
  day: string
  ad_id: string
  spend_eur: number
  impressions: number
  reach: number
  link_clicks: number
  platform_leads: number
  video_3s: number
}
interface AdLead {
  id: string
  utm_source: string | null
  utm_campaign: string | null
  utm_content: string | null
  quality_rating: 'gut' | 'schlecht' | null
  created_at: string
}
interface AdAppt { id: string; lead_id: string | null; start_time: string; outcome: 'completed' | 'no_show' | null }
interface AdDeal { id: string; lead_id: string; phase: string; commission_amount: number | null }

// Aktions-Warteschlange: bestätigte Aktionen führt der tägliche Sync-Lauf bei Meta aus
interface AdAction {
  id: string
  ad_id: string
  ad_name: string | null
  campaign_name: string | null
  action: 'pause' | 'activate'
  reason: string | null
  status: 'bestätigt' | 'ausgeführt' | 'fehlgeschlagen' | 'abgelehnt'
  created_at: string
  executed_at: string | null
  result: string | null
}

// Empfehlung der Regel-Engine (rein deterministisch, transparent begründet)
interface Recommendation { ad: AdCatalogRow; kind: 'no_leads' | 'high_cpl' | 'over_target' | 'fatigue'; reason: string; spend: number }

// Leitplanken (ad_settings, von Sven festgelegt): Ziel-Leadpreis + Tageslimit
interface AdSettings { target_cpl: number; max_account_daily_budget: number; system_campaign_daily_budget: number }
const DEFAULT_SETTINGS: AdSettings = { target_cpl: 60, max_account_daily_budget: 180, system_campaign_daily_budget: 50 }

// Zusammengerollte Kennzahlen (eine Ad oder eine Kampagne)
interface Agg {
  spendEur: number
  impressions: number
  reach: number
  clicks: number
  platformLeads: number
  video3s: number
  crmLeads: number
  termine: number
  stattgefunden: number
  noShows: number
  gut: number
  schlecht: number
  sales: number
  revenue: number
}
const emptyAgg = (): Agg => ({ spendEur: 0, impressions: 0, reach: 0, clicks: 0, platformLeads: 0, video3s: 0, crmLeads: 0, termine: 0, stattgefunden: 0, noShows: 0, gut: 0, schlecht: 0, sales: 0, revenue: 0 })

const SALE_PHASES = new Set(['anzahlung', 'provision_erhalten'])
const META_SOURCES = new Set(['meta', 'facebook', 'fb', 'instagram', 'ig'])

// Kategorische Chart-Farben — feste Reihenfolge, validiert (Kontrast + Farbfehlsicht)
const CHART_COLORS = ['#e8590c', '#3b5bdb', '#0ca678', '#b08800', '#9c36b5', '#0891b2']
const colorFor = (i: number) => CHART_COLORS[i % CHART_COLORS.length]

// ── KPI-Kachel ────────────────────────────────────────────────────────────────
function KpiTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-5 py-4 ${accent ? 'border-orange-200 bg-orange-50/60' : 'border-gray-200 bg-white'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Horizontales Balkendiagramm (Leads je Kampagne) ──────────────────────────
interface BarDatum { label: string; value: number; sub?: string; color: string }
function HBarChart({ data, valueFmt }: { data: BarDatum[]; valueFmt: (v: number) => string }) {
  const max = Math.max(1, ...data.map(d => d.value))
  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={i} title={`${d.label}: ${valueFmt(d.value)}${d.sub ? ` · ${d.sub}` : ''}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-gray-600 truncate">{d.label}</span>
            <span className="text-sm font-semibold text-gray-900 tabular-nums whitespace-nowrap">
              {valueFmt(d.value)}{d.sub && <span className="font-normal text-gray-500"> · {d.sub}</span>}
            </span>
          </div>
          <div className="mt-1 h-5 rounded-r bg-gray-100">
            <div className="h-full rounded-r" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color, minWidth: d.value > 0 ? 5 : 0 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Kuchendiagramm (Spend-Verteilung) ────────────────────────────────────────
function DonutChart({ data, centerLabel }: { data: BarDatum[]; centerLabel: string }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total <= 0) return null
  let acc = 0
  const R = 42, C = 2 * Math.PI * R
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 110 110" className="w-44 h-44 shrink-0">
        {data.map((d, i) => {
          const frac = d.value / total
          const dash = frac * C
          const off = -acc * C
          acc += frac
          return (
            <circle key={i} cx="55" cy="55" r={R} fill="none" stroke={d.color} strokeWidth="14"
              strokeDasharray={`${Math.max(dash - 2, 0)} ${C - Math.max(dash - 2, 0)}`} strokeDashoffset={off}
              transform="rotate(-90 55 55)">
              <title>{`${d.label}: ${Math.round(frac * 100)} %`}</title>
            </circle>
          )
        })}
        <text x="55" y="59" textAnchor="middle" className="fill-gray-700" style={{ fontSize: 11, fontWeight: 700 }}>{centerLabel}</text>
      </svg>
      <div className="space-y-1.5 min-w-0">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-sm text-gray-600 min-w-0">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
            <span className="truncate">{d.label}</span>
            <span className="ml-auto font-semibold text-gray-900 tabular-nums pl-2">{Math.round((d.value / total) * 100)} %</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tages-Trend (vertikale Balken, eine Farbe = eine Größe) ──────────────────
function TrendChart({ points, fmt }: { points: { day: string; value: number }[]; fmt: (v: number) => string }) {
  const max = Math.max(1, ...points.map(p => p.value))
  return (
    <div className="flex items-end gap-[3px] h-48">
      {points.map((p, i) => (
        <div key={i} className="flex-1 min-w-0 group relative" title={`${p.day}: ${fmt(p.value)}`}>
          <div className="rounded-t-sm mx-auto w-full transition group-hover:opacity-80"
            style={{ height: `${Math.max((p.value / max) * 192, p.value > 0 ? 2 : 0)}px`, backgroundColor: '#e8590c' }} />
        </div>
      ))}
    </div>
  )
}

// ── Meta-Enums → lesbare deutsche Labels (unbekannte Werte werden roh gezeigt) ─
const META_LABELS: Record<string, string> = {
  OUTCOME_LEADS: 'Leads', OUTCOME_SALES: 'Umsatz', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_AWARENESS: 'Bekanntheit', OUTCOME_ENGAGEMENT: 'Interaktionen',
  ACTIVE: 'Aktiv', PAUSED: 'Pausiert', CAMPAIGN_PAUSED: 'Pausiert (Kampagne)', ADSET_PAUSED: 'Pausiert (Anzeigengruppe)', IN_PROCESS: 'In Prüfung', WITH_ISSUES: 'Mit Problemen', PENDING_REVIEW: 'In Prüfung', DISAPPROVED: 'Abgelehnt',
  LOWEST_COST_WITHOUT_CAP: 'Niedrigste Kosten (automatisch)', LOWEST_COST_WITH_BID_CAP: 'Gebotsobergrenze', COST_CAP: 'Kostenobergrenze',
  OFFSITE_CONVERSIONS: 'Conversions (Website)', LINK_CLICKS: 'Link-Klicks', LEAD_GENERATION: 'Lead-Formulare', REACH: 'Reichweite', LANDING_PAGE_VIEWS: 'Landingpage-Aufrufe',
  IMPRESSIONS: 'Impressionen', AUCTION: 'Auktion',
  LEAD: 'Lead', SCHEDULE: 'Termin (Schedule)', PURCHASE: 'Kauf',
}
const metaLabel = (v: unknown): string => (v == null ? '–' : META_LABELS[String(v)] ?? String(v))

// Komplettes Meta-Targeting lesbar aufbereitet (alles anzeigen, nichts verstecken)
function TargetingView({ targeting }: { targeting: Record<string, unknown> | null | undefined }) {
  if (!targeting) return <span className="text-gray-400">–</span>
  const tg = targeting as {
    age_min?: number; age_max?: number; genders?: number[]
    geo_locations?: { countries?: string[]; cities?: Array<{ name: string }>; regions?: Array<{ name: string }> }
    excluded_geo_locations?: { countries?: string[] }
    flexible_spec?: Array<Record<string, Array<{ id: string; name: string }>>>
    exclusions?: Record<string, Array<{ id: string; name: string }>>
    custom_audiences?: Array<{ id: string; name: string }>
    excluded_custom_audiences?: Array<{ id: string; name: string }>
    publisher_platforms?: string[]
    targeting_automation?: { advantage_audience?: number }
  }
  const chip = (txt: string, cls: string, key: string) => (
    <span key={key} className={`px-2 py-0.5 rounded-full border text-[11px] ${cls}`}>{txt}</span>
  )
  const chips: JSX.Element[] = []
  chips.push(chip(`🎂 ${tg.age_min ?? 18}–${tg.age_max ?? 65}`, 'bg-white border-gray-200', 'age'))
  chips.push(chip(tg.genders?.length === 1 ? (tg.genders[0] === 1 ? '♂ Männer' : '♀ Frauen') : '⚥ Alle', 'bg-white border-gray-200', 'gender'))
  const geo = [
    ...(tg.geo_locations?.countries ?? []),
    ...(tg.geo_locations?.regions?.map(r => r.name) ?? []),
    ...(tg.geo_locations?.cities?.map(c => c.name) ?? []),
  ]
  if (geo.length) chips.push(chip(`🌍 ${geo.join(', ')}`, 'bg-white border-gray-200', 'geo'))
  if (tg.excluded_geo_locations?.countries?.length) chips.push(chip(`🚫🌍 ${tg.excluded_geo_locations.countries.join(', ')}`, 'bg-red-50 border-red-200 text-red-700', 'geoex'))
  ;(tg.flexible_spec ?? []).forEach((group, gi) => {
    for (const [key, items] of Object.entries(group)) {
      if (!Array.isArray(items)) continue
      const icon = key === 'interests' ? '💡' : key === 'work_positions' ? '💼' : key === 'behaviors' ? '🧭' : key === 'work_employers' ? '🏢' : '🔖'
      items.forEach(it => chips.push(chip(`${icon} ${it.name}`, gi === 0 ? 'bg-blue-50 border-blue-200 text-blue-800' : 'bg-purple-50 border-purple-200 text-purple-800', `${gi}-${key}-${it.id}`)))
    }
  })
  for (const [key, items] of Object.entries(tg.exclusions ?? {})) {
    if (Array.isArray(items)) items.forEach(it => chips.push(chip(`🚫 ${it.name}`, 'bg-red-50 border-red-200 text-red-700', `ex-${key}-${it.id}`)))
  }
  ;(tg.custom_audiences ?? []).forEach(a => chips.push(chip(`👥 ${a.name}`, 'bg-green-50 border-green-200 text-green-800', `ca-${a.id}`)))
  ;(tg.excluded_custom_audiences ?? []).forEach(a => chips.push(chip(`🚫👥 ${a.name}`, 'bg-red-50 border-red-200 text-red-700', `cax-${a.id}`)))
  chips.push(chip(tg.publisher_platforms?.length ? `📱 ${tg.publisher_platforms.join(', ')}` : '📱 Platzierungen: Automatisch', 'bg-white border-gray-200', 'plat'))
  if (tg.targeting_automation?.advantage_audience === 1) chips.push(chip('✨ Advantage+ Audience', 'bg-amber-50 border-amber-200 text-amber-800', 'adv'))
  return <div className="flex flex-wrap gap-1.5">{chips}</div>
}

// ── Seite ─────────────────────────────────────────────────────────────────────
export default function AdsManager() {
  const { t, i18n } = useTranslation()
  const { profile } = useAuth()
  const basePath = '/admin/crm'
  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'de-DE'

  const segments = AD_SEGMENTS.filter(s => hasAdSegment(profile, s))
  const [segment, setSegment] = useState<AdSegment>('meta')
  const [view, setView] = useState<'stats' | 'studio'>('stats')
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [loading, setLoading] = useState(true)
  const [catalog, setCatalog] = useState<AdCatalogRow[]>([])
  const [insights, setInsights] = useState<InsightRow[]>([])
  const [leads, setLeads] = useState<AdLead[]>([])
  const [appts, setAppts] = useState<AdAppt[]>([])
  const [deals, setDeals] = useState<AdDeal[]>([])
  const [actions, setActions] = useState<AdAction[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [settings, setSettings] = useState<AdSettings>(DEFAULT_SETTINGS)
  const [editSettings, setEditSettings] = useState(false)
  const [settingsForm, setSettingsForm] = useState({ target_cpl: '60', max_budget: '180' })
  // Anzeigen-Vorschau (FB/IG/Story) + Zielgruppen-Assistent
  const [preview, setPreview] = useState<{ adName: string; loading: boolean; tab: 'facebook' | 'instagram' | 'story'; previews?: Record<string, string>; caption?: { message: string; headline: string } } | null>(null)
  const [audienceText, setAudienceText] = useState('')
  const [audienceFeedback, setAudienceFeedback] = useState('')
  const [audienceBusy, setAudienceBusy] = useState(false)
  const [audienceDraft, setAudienceDraft] = useState<{ age_min: number; age_max: number; genders: string; countries: string[]; interests: Array<{ id: string; name: string; audience?: number }>; jobs: Array<{ id: string; name: string }>; summary: string } | null>(null)
  // ⚙ Voll-Einstellungen einer Kampagne (Meta-Rohdaten, lesbar aufbereitet)
  interface MetaEntity { [k: string]: unknown }
  const [settingsView, setSettingsView] = useState<{ campaignId: string; campaignName: string; loading: boolean; busy: boolean; data?: { campaign: MetaEntity; adsets: MetaEntity[]; ads: MetaEntity[] }; budgetEdits: Record<string, string> } | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  useEffect(() => {
    if (segments.length && !segments.includes(segment)) setSegment(segments[0])
    // segments ist von profile abgeleitet — profile reicht als Abhängigkeit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      const [{ data: cat, error: e1 }, { data: ins, error: e2 }] = await Promise.all([
        supabase.from('ad_catalog').select('ad_id, campaign_id, campaign_name, adset_id, adset_name, ad_name, status, thumbnail_url').eq('platform', segment),
        supabase.from('ad_insights_daily').select('day, ad_id, spend_eur, impressions, reach, link_clicks, platform_leads, video_3s').eq('platform', segment).gte('day', since),
      ])
      if (e1) throw e1
      if (e2) throw e2
      const catRows = (cat as unknown as AdCatalogRow[]) ?? []
      setCatalog(catRows)
      setInsights((ins as unknown as InsightRow[]) ?? [])

      // Leitplanken (Ziel-Leadpreis, Tageslimit) — von Sven gepflegt
      const { data: st } = await supabase.from('ad_settings')
        .select('target_cpl, max_account_daily_budget, system_campaign_daily_budget')
        .eq('id', 'default').maybeSingle()
      if (st) {
        const s = st as unknown as { target_cpl: string | number; max_account_daily_budget: string | number; system_campaign_daily_budget: string | number }
        const parsed = {
          target_cpl: Number(s.target_cpl) || DEFAULT_SETTINGS.target_cpl,
          max_account_daily_budget: Number(s.max_account_daily_budget) || DEFAULT_SETTINGS.max_account_daily_budget,
          system_campaign_daily_budget: Number(s.system_campaign_daily_budget) || DEFAULT_SETTINGS.system_campaign_daily_budget,
        }
        setSettings(parsed)
        setSettingsForm({ target_cpl: String(parsed.target_cpl), max_budget: String(parsed.max_account_daily_budget) })
      }

      // Aktions-Queue: offene + die letzten 14 Tage erledigte/fehlgeschlagene
      const { data: act, error: eAct } = await supabase
        .from('ad_actions')
        .select('id, ad_id, ad_name, campaign_name, action, reason, status, created_at, executed_at, result')
        .eq('platform', segment)
        .or(`status.eq.bestätigt,created_at.gte.${new Date(Date.now() - 14 * 86_400_000).toISOString()}`)
        .order('created_at', { ascending: false })
      if (eAct) throw eAct
      setActions((act as unknown as AdAction[]) ?? [])

      // CRM-Zuordnung: Leads über utm_campaign/{{campaign.id}} bzw. Meta-Quellen
      const campaignIds = [...new Set(catRows.map(c => c.campaign_id))]
      const orParts = [`utm_source.in.(${[...META_SOURCES].join(',')})`]
      if (campaignIds.length) orParts.push(`utm_campaign.in.(${campaignIds.join(',')})`)
      const { data: ld, error: e3 } = await supabase
        .from('leads')
        .select('id, utm_source, utm_campaign, utm_content, quality_rating, created_at')
        .gte('created_at', `${since}T00:00:00Z`)
        .or(orParts.join(','))
      if (e3) throw e3
      const leadRows = (ld as unknown as AdLead[]) ?? []
      setLeads(leadRows)

      const leadIds = leadRows.map(l => l.id)
      if (leadIds.length) {
        const [{ data: ap, error: e4 }, { data: dl, error: e5 }] = await Promise.all([
          supabase.from('crm_appointments').select('id, lead_id, start_time, outcome').in('lead_id', leadIds),
          supabase.from('deals').select('id, lead_id, phase, commission_amount').in('lead_id', leadIds),
        ])
        if (e4) throw e4
        if (e5) throw e5
        setAppts((ap as unknown as AdAppt[]) ?? [])
        setDeals((dl as unknown as AdDeal[]) ?? [])
      } else {
        setAppts([]); setDeals([])
      }
    } catch (err) {
      console.error('[AdsManager] fetchAll:', err)
      setCatalog([]); setInsights([]); setLeads([]); setAppts([]); setDeals([]); setActions([])
    } finally {
      setLoading(false)
    }
  }, [segment, days])

  useEffect(() => { void fetchAll() }, [fetchAll])

  // ── Aggregation ────────────────────────────────────────────────────────────
  const { byAd, campaignsSorted, total, trend } = useMemo(() => {
    const byAd = new Map<string, Agg>()
    const byCampaign = new Map<string, Agg>()
    const trendMap = new Map<string, number>()
    const adToCampaign = new Map(catalog.map(c => [c.ad_id, c.campaign_id]))
    const get = (m: Map<string, Agg>, k: string) => { let a = m.get(k); if (!a) { a = emptyAgg(); m.set(k, a) } return a }

    for (const r of insights) {
      const a = get(byAd, r.ad_id)
      a.spendEur += r.spend_eur; a.impressions += r.impressions; a.reach += r.reach
      a.clicks += r.link_clicks; a.platformLeads += r.platform_leads; a.video3s += r.video_3s
      const cid = adToCampaign.get(r.ad_id)
      if (cid) {
        const c = get(byCampaign, cid)
        c.spendEur += r.spend_eur; c.impressions += r.impressions; c.reach += r.reach
        c.clicks += r.link_clicks; c.platformLeads += r.platform_leads; c.video3s += r.video_3s
      }
      trendMap.set(r.day, (trendMap.get(r.day) ?? 0) + r.spend_eur)
    }

    // CRM-Kette: Lead → Termin → Ausgang → Qualität → Sale, der Ad/Kampagne zugeordnet
    const apptsByLead = new Map<string, AdAppt[]>()
    for (const a of appts) { if (a.lead_id) { const arr = apptsByLead.get(a.lead_id) ?? []; arr.push(a); apptsByLead.set(a.lead_id, arr) } }
    const dealsByLead = new Map<string, AdDeal[]>()
    for (const d of deals) { const arr = dealsByLead.get(d.lead_id) ?? []; arr.push(d); dealsByLead.set(d.lead_id, arr) }

    const applyLead = (a: Agg, l: AdLead) => {
      a.crmLeads += 1
      if (l.quality_rating === 'gut') a.gut += 1
      if (l.quality_rating === 'schlecht') a.schlecht += 1
      const la = apptsByLead.get(l.id) ?? []
      if (la.length) a.termine += 1
      if (la.some(x => x.outcome === 'completed')) a.stattgefunden += 1
      if (la.some(x => x.outcome === 'no_show')) a.noShows += 1
      for (const d of dealsByLead.get(l.id) ?? []) {
        if (SALE_PHASES.has(d.phase)) { a.sales += 1; a.revenue += d.commission_amount ?? 0 }
      }
    }
    for (const l of leads) {
      if (l.utm_content && byAd.has(l.utm_content)) applyLead(get(byAd, l.utm_content), l)
      const cid = l.utm_campaign && byCampaign.has(l.utm_campaign) ? l.utm_campaign
        : (l.utm_content ? adToCampaign.get(l.utm_content) : undefined)
      if (cid) applyLead(get(byCampaign, cid), l)
    }

    const total = emptyAgg()
    for (const a of byCampaign.values()) {
      total.spendEur += a.spendEur; total.impressions += a.impressions; total.reach += a.reach
      total.clicks += a.clicks; total.platformLeads += a.platformLeads; total.video3s += a.video3s
    }
    // CRM-Kette im Gesamt: ALLE Meta-Leads zählen, auch ohne Kampagnen-Zuordnung
    for (const l of leads) applyLead(total, l)

    // Kampagnen ganz ohne Insights (z.B. neu angelegt, pausiert) trotzdem listen —
    // sonst wären frisch erstellte System-Kampagnen im Werbemanager unsichtbar.
    for (const c of catalog) if (c.campaign_id && !byCampaign.has(c.campaign_id)) byCampaign.set(c.campaign_id, emptyAgg())

    const campaignsSorted = [...byCampaign.entries()].sort((x, y) => y[1].spendEur - x[1].spendEur)
    const trend = [...trendMap.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([day, value]) => ({ day, value }))
    return { byAd, byCampaign, campaignsSorted, total, trend }
  }, [catalog, insights, leads, appts, deals])

  // ── Formatierung ───────────────────────────────────────────────────────────
  const eur = (v: number) => v.toLocaleString(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: v >= 100 ? 0 : 2 })
  const int = (v: number) => v.toLocaleString(locale)
  const pct = (v: number) => `${(v * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`
  const per = (spend: number, n: number) => (n > 0 ? eur(spend / n) : '–')

  // ── Sync on demand (Edge Function meta-ads-sync, läuft sonst täglich 07:00) ─
  const runSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-sync', { body: { days: 3 } })
      if (error) throw error
      const d = data as { insight_rows?: number } | null
      showToast(t('crm.ads.toastSynced', '✅ Aktualisiert — {{n}} Tageswerte von Meta geholt', { n: d?.insight_rows ?? 0 }))
      await fetchAll()
    } catch (err) {
      console.error('[AdsManager] runSync:', err)
      showToast(`❌ ${t('crm.ads.toastSyncError', 'Aktualisierung fehlgeschlagen')}`)
    } finally {
      setSyncing(false)
    }
  }

  // ── Leitplanken speichern ─────────────────────────────────────────────────
  const saveSettings = async () => {
    const target = parseFloat(settingsForm.target_cpl.replace(',', '.'))
    const maxB = parseFloat(settingsForm.max_budget.replace(',', '.'))
    if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(maxB) || maxB <= 0) {
      showToast(`❌ ${t('crm.ads.settingsInvalid', 'Bitte gültige Beträge eingeben')}`)
      return
    }
    try {
      const { error } = await supabase.from('ad_settings')
        .update({ target_cpl: target, max_account_daily_budget: maxB, updated_at: new Date().toISOString() })
        .eq('id', 'default')
      if (error) throw error
      setSettings(s => ({ ...s, target_cpl: target, max_account_daily_budget: maxB }))
      setEditSettings(false)
      showToast(t('crm.ads.settingsSaved', '✅ Leitplanken gespeichert'))
    } catch (err) {
      console.error('[AdsManager] saveSettings:', err)
      showToast(`❌ ${t('crm.ads.toastError', 'Fehler beim Speichern')}`)
    }
  }

  // ── Anzeigen-Vorschau (Edge Function meta-ads-tools) ──────────────────────
  const openPreview = async (ad: AdCatalogRow) => {
    setPreview({ adName: ad.ad_name ?? ad.ad_id, loading: true, tab: 'facebook' })
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', { body: { mode: 'preview', ad_id: ad.ad_id } })
      if (error) throw error
      const d = data as { previews: Record<string, string>; caption: { message: string; headline: string } }
      setPreview(p => p ? { ...p, loading: false, previews: d.previews, caption: d.caption } : p)
    } catch (err) {
      console.error('[AdsManager] openPreview:', err)
      setPreview(null)
      showToast(`❌ ${t('crm.ads.previewError', 'Vorschau konnte nicht geladen werden')}`)
    }
  }

  // ── Zielgruppen-Assistent (lernend: Feedback wird dauerhafte Regel) ───────
  const suggestAudience = async (withFeedback?: string) => {
    if (!audienceText.trim() || audienceBusy) return
    setAudienceBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: {
          mode: 'audience_suggest', description: audienceText.trim(),
          ...(withFeedback ? { feedback: withFeedback, previous_draft: audienceDraft } : {}),
        },
      })
      if (error) throw error
      setAudienceDraft((data as { draft: typeof audienceDraft }).draft)
      if (withFeedback) {
        setAudienceFeedback('')
        showToast(t('crm.ads.ruleLearned', '🧠 Korrektur gespeichert — gilt ab jetzt für alle Vorschläge'))
      }
    } catch (err) {
      console.error('[AdsManager] suggestAudience:', err)
      showToast(`❌ ${t('crm.ads.audienceError', 'Vorschlag fehlgeschlagen — bitte nochmal versuchen')}`)
    } finally {
      setAudienceBusy(false)
    }
  }

  const applyAudience = async () => {
    if (!audienceDraft || audienceBusy) return
    setAudienceBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: { mode: 'audience_apply', targeting_draft: audienceDraft, description: audienceText.trim() },
      })
      if (error) throw error
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      showToast(t('crm.ads.audienceApplied', '✅ Zielgruppe auf die System-Kampagne angewendet'))
      setAudienceDraft(null)
      setAudienceText('')
    } catch (err) {
      console.error('[AdsManager] applyAudience:', err)
      showToast(`❌ ${t('crm.ads.audienceError', 'Vorschlag fehlgeschlagen — bitte nochmal versuchen')}`)
    } finally {
      setAudienceBusy(false)
    }
  }

  // ── ⚙ Voll-Einstellungen laden / ändern ───────────────────────────────────
  const openSettings = async (cid: string) => {
    setSettingsView({ campaignId: cid, campaignName: campaignName(cid), loading: true, busy: false, budgetEdits: {} })
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', { body: { mode: 'settings', campaign_id: cid } })
      if (error) throw error
      const d = data as { campaign: MetaEntity; adsets: MetaEntity[]; ads: MetaEntity[]; error?: string }
      if (d.error) throw new Error(d.error)
      const budgetEdits: Record<string, string> = {}
      for (const a of d.adsets) if (a.daily_budget) budgetEdits[String(a.id)] = String(Number(a.daily_budget) / 100)
      setSettingsView(s => s ? { ...s, loading: false, data: { campaign: d.campaign, adsets: d.adsets, ads: d.ads }, budgetEdits } : s)
    } catch (err) {
      console.error('[AdsManager] openSettings:', err)
      setSettingsView(null)
      showToast(`❌ ${t('crm.ads.settingsLoadError', 'Einstellungen konnten nicht geladen werden')}`)
    }
  }

  const updateEntity = async (entityId: string, patch: { daily_budget?: number; status?: 'ACTIVE' | 'PAUSED' }) => {
    if (!settingsView || settingsView.busy) return
    setSettingsView(s => s ? { ...s, busy: true } : s)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', { body: { mode: 'update_entity', entity_id: entityId, ...patch } })
      if (error) throw error
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      showToast(t('crm.ads.entityUpdated', '✅ Bei Meta gespeichert'))
      await openSettings(settingsView.campaignId)   // frisch laden
      void fetchAll()
    } catch (err) {
      console.error('[AdsManager] updateEntity:', err)
      setSettingsView(s => s ? { ...s, busy: false } : s)
      showToast(`❌ ${t('crm.ads.entityUpdateError', 'Änderung fehlgeschlagen')}`)
    }
  }

  // ── Aktions-Queue: vormerken / stornieren ─────────────────────────────────
  // Ausführung bei Meta übernimmt meta-ads-sync — nach dem Vormerken stoßen
  // wir sie sofort an (fire-and-forget) und laden den Status kurz darauf nach.
  const pendingByAd = useMemo(() => {
    const m = new Map<string, AdAction>()
    for (const a of actions) if (a.status === 'bestätigt') m.set(a.ad_id, a)
    return m
  }, [actions])

  const queueAction = async (ad: AdCatalogRow, action: 'pause' | 'activate', reason: string) => {
    if (pendingByAd.has(ad.ad_id)) return
    try {
      const { data, error } = await supabase.from('ad_actions').insert({
        platform: segment, ad_id: ad.ad_id, ad_name: ad.ad_name,
        campaign_name: ad.campaign_name, action, reason,
        created_by: profile?.id ?? null,
      }).select('id, ad_id, ad_name, campaign_name, action, reason, status, created_at, executed_at, result').single()
      if (error) throw error
      setActions(prev => [data as unknown as AdAction, ...prev])
      showToast(action === 'pause'
        ? t('crm.ads.toastPauseQueued', '⏸ Wird bei Meta pausiert …')
        : t('crm.ads.toastActivateQueued', '▶ Wird bei Meta aktiviert …'))
      // Sofort ausführen und Status nachladen (fire-and-forget, UI blockiert nicht)
      supabase.functions.invoke('meta-ads-sync', { body: { mode: 'actions_only' } })
        .then(() => fetchAll())
        .catch(e => console.warn('[AdsManager] Sofort-Ausführung failed:', e))
    } catch (err) {
      console.error('[AdsManager] queueAction:', err)
      showToast(`❌ ${t('crm.ads.toastError', 'Fehler beim Speichern')}`)
    }
  }

  const cancelAction = async (id: string) => {
    const prev = actions
    setActions(actions.map(a => (a.id === id ? { ...a, status: 'abgelehnt' as const } : a)))
    try {
      const { error } = await supabase.from('ad_actions').update({ status: 'abgelehnt' }).eq('id', id).eq('status', 'bestätigt')
      if (error) throw error
      showToast(t('crm.ads.toastCancelled', 'Aktion storniert'))
    } catch (err) {
      console.error('[AdsManager] cancelAction:', err)
      setActions(prev)
    }
  }

  // ── Empfehlungen (Regel-Engine über den geladenen Zeitraum) ───────────────
  const recommendations = useMemo<Recommendation[]>(() => {
    const recs: Recommendation[] = []
    // Median-CPL je Kampagne (nur Ads mit Leads)
    const cplByCampaign = new Map<string, number[]>()
    for (const c of catalog) {
      const a = byAd.get(c.ad_id)
      if (!a) continue
      const eff = a.crmLeads > 0 ? a.crmLeads : a.platformLeads
      if (eff > 0) {
        const arr = cplByCampaign.get(c.campaign_id) ?? []
        arr.push(a.spendEur / eff)
        cplByCampaign.set(c.campaign_id, arr)
      }
    }
    const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
    for (const c of catalog) {
      if (c.status !== 'ACTIVE' || pendingByAd.has(c.ad_id)) continue
      const a = byAd.get(c.ad_id)
      if (!a || a.spendEur < 50) continue
      const eff = a.crmLeads > 0 ? a.crmLeads : a.platformLeads
      if (eff === 0 && a.spendEur >= 100) {
        recs.push({ ad: c, kind: 'no_leads', spend: a.spendEur, reason: t('crm.ads.recReasonNoLeads', '{{spend}} ausgegeben, kein einziger Lead im Zeitraum', { spend: eur(a.spendEur) }) })
        continue
      }
      // Ziel-Leadpreis (Svens Leitplanke): deutlich drüber = Empfehlung
      if (eff > 0 && a.spendEur >= 100) {
        const cpl = a.spendEur / eff
        if (cpl > 1.5 * settings.target_cpl) {
          recs.push({ ad: c, kind: 'over_target', spend: a.spendEur, reason: t('crm.ads.recReasonTarget', 'Leadpreis {{cpl}} — weit über deinem Ziel von {{target}}', { cpl: eur(cpl), target: eur(settings.target_cpl) }) })
          continue
        }
      }
      const meds = cplByCampaign.get(c.campaign_id)
      if (eff > 0 && meds && meds.length >= 3 && a.spendEur >= 100) {
        const m = median(meds), cpl = a.spendEur / eff
        if (cpl > 1.6 * m) {
          recs.push({ ad: c, kind: 'high_cpl', spend: a.spendEur, reason: t('crm.ads.recReasonCpl', 'Leadpreis {{cpl}} — {{factor}}× teurer als der Kampagnen-Schnitt ({{median}})', { cpl: eur(cpl), factor: (cpl / m).toLocaleString(locale, { maximumFractionDigits: 1 }), median: eur(m) }) })
          continue
        }
      }
      const freq = a.reach > 0 ? a.impressions / a.reach : 0
      const ctr = a.impressions > 0 ? a.clicks / a.impressions : 0
      if (freq > 2.5 && ctr < 0.01) {
        recs.push({ ad: c, kind: 'fatigue', spend: a.spendEur, reason: t('crm.ads.recReasonFatigue', 'Ermüdung: Frequenz {{freq}} bei nur {{ctr}} Klickrate — Motiv ist verbraucht', { freq: freq.toLocaleString(locale, { maximumFractionDigits: 1 }), ctr: pct(ctr) }) })
      }
    }
    return recs.sort((x, y) => y.spend - x.spend).slice(0, 5)
    // eur/pct sind stabile Formatter — bewusst nicht in den Deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, byAd, pendingByAd, settings, t, locale])

  const campaignName = useCallback((cid: string) => catalog.find(c => c.campaign_id === cid)?.campaign_name || cid, [catalog])
  const campaignColor = useMemo(() => {
    const m = new Map<string, string>()
    campaignsSorted.forEach(([cid], i) => m.set(cid, colorFor(i)))
    return m
  }, [campaignsSorted])

  // Gestern-Ausgaben vs. Tageslimit (Budget-Wächter)
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const yesterdaySpend = useMemo(
    () => insights.filter(r => r.day === yesterdayIso).reduce((s, r) => s + r.spend_eur, 0),
    [insights, yesterdayIso],
  )
  const overBudget = yesterdaySpend > settings.max_account_daily_budget

  const leadsShown = total.crmLeads > 0 ? total.crmLeads : total.platformLeads
  const leadBasis = total.crmLeads > 0 ? t('crm.ads.basisCrm', 'CRM-zugeordnet') : t('crm.ads.basisMeta', 'laut Meta')
  const qualityRated = total.gut + total.schlecht
  const roas = total.spendEur > 0 ? total.revenue / total.spendEur : 0

  const toggleExpand = (cid: string) => setExpanded(prev => {
    const s = new Set(prev); if (s.has(cid)) s.delete(cid); else s.add(cid); return s
  })

  const segLabel: Record<AdSegment, string> = {
    meta: 'META', youtube: 'YouTube', google: 'Google Ads',
  }

  return (
    <DashboardLayout basePath={basePath}>
      <div className="p-4 md:p-6 max-w-7xl mx-auto">
        {/* Kopf: Titel + Plattform-Tabs + Zeitraum */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.ads.title', 'Werbemanager')}</h1>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {segments.map(s => (
              <button key={s} onClick={() => setSegment(s)}
                className={`px-3 py-1.5 text-sm font-semibold ${segment === s ? 'text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                style={segment === s ? { backgroundColor: '#ff795d' } : undefined}>
                {segLabel[s]}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-lg border border-gray-200 overflow-hidden">
              {([7, 30, 90] as const).map(d => (
                <button key={d} onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-sm font-medium ${days === d ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {t('crm.ads.days', '{{n}} Tage', { n: d })}
                </button>
              ))}
            </div>
            {segment === 'meta' && (
              <button onClick={() => void runSync()} disabled={syncing}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-60"
                style={{ backgroundColor: '#ff795d' }}>
                {syncing && <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                🔄 {t('crm.ads.syncNow', 'Aktualisieren')}
              </button>
            )}
          </div>
        </div>

        {segment !== 'meta' ? (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">
            <p className="text-3xl mb-2">🚧</p>
            <p className="font-semibold text-gray-700">{segLabel[segment]} {t('crm.ads.comingSoon', 'ist noch nicht angebunden')}</p>
            <p className="text-sm mt-1">{t('crm.ads.comingSoonSub', 'META läuft bereits — weitere Kanäle folgen hier im gleichen Format.')}</p>
          </div>
        ) : loading ? (
          <div className="flex justify-center py-24">
            <div className="w-10 h-10 rounded-full border-4 border-orange-300 border-t-orange-500 animate-spin" />
          </div>
        ) : (
          <>
            {/* Reiter: Statistik | Anzeigen-Studio */}
            <div className="flex gap-2 mb-5 border-b border-gray-200">
              <button onClick={() => setView('stats')}
                className={`px-5 py-2.5 text-base font-bold rounded-t-xl border-b-2 -mb-px ${view === 'stats' ? 'border-[#ff795d] text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                📊 {t('crm.ads.tabStats', 'Statistik')}
              </button>
              <button onClick={() => setView('studio')}
                className={`px-5 py-2.5 text-base font-bold rounded-t-xl border-b-2 -mb-px ${view === 'studio' ? 'border-[#ff795d] text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                🎨 {t('crm.ads.tabStudio', 'Anzeigen-Studio')}
              </button>
            </div>

            {view === 'stats' && (<div>
            {/* KPI-Kacheln */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
              <KpiTile label={t('crm.ads.kpiSpend', 'Ausgaben')} value={eur(total.spendEur)}
                sub={t('crm.ads.kpiSpendSub', 'umgerechnet aus USD')} />
              <KpiTile label={t('crm.ads.kpiCpl', 'Leadpreis')} value={per(total.spendEur, leadsShown)}
                sub={`${int(leadsShown)} Leads (${leadBasis}) · ${leadsShown > 0 && total.spendEur / leadsShown <= settings.target_cpl ? '✅' : '⚠️'} ${t('crm.ads.target', 'Ziel')}: ${eur(settings.target_cpl)}`} accent />
              <KpiTile label={t('crm.ads.kpiCostPerHeld', 'Preis / stattgef. Termin')} value={per(total.spendEur, total.stattgefunden)}
                sub={`${int(total.stattgefunden)} ${t('crm.ads.held', 'stattgefunden')} · ${int(total.noShows)} No-Shows`} />
              <KpiTile label={t('crm.ads.kpiQuality', 'Qualitätsquote')} value={qualityRated > 0 ? pct(total.gut / qualityRated) : '–'}
                sub={`${int(total.gut)} 👍 / ${int(total.schlecht)} 👎`} />
              <KpiTile label={t('crm.ads.kpiCostPerGood', 'Preis / gutem Lead')} value={per(total.spendEur, total.gut)} />
              <KpiTile label={t('crm.ads.kpiRoas', 'ROAS')} value={total.revenue > 0 ? `${roas.toLocaleString(locale, { maximumFractionDigits: 2 })}×` : '–'}
                sub={`${eur(total.revenue)} ${t('crm.ads.revenue', 'Umsatz')} · ${int(total.sales)} Sales`} />
            </div>

            {/* Budget-Wächter: gestern über dem Tageslimit? */}
            {overBudget && (
              <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                🚨 {t('crm.ads.overBudget', 'Gestern {{spend}} ausgegeben — über deinem Tageslimit von {{limit}}.', { spend: eur(yesterdaySpend), limit: eur(settings.max_account_daily_budget) })}
              </div>
            )}

            {/* Leitplanken (Ziel-Leadpreis + Tageslimit) — editierbar */}
            <div className="mb-5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="font-semibold text-gray-700">🎯 {t('crm.ads.settingsTitle', 'Leitplanken')}:</span>
              {editSettings ? (
                <>
                  <label className="flex items-center gap-1.5 text-gray-600">
                    {t('crm.ads.target', 'Ziel')}-{t('crm.ads.kpiCpl', 'Leadpreis')}
                    <input value={settingsForm.target_cpl} onChange={e => setSettingsForm(f => ({ ...f, target_cpl: e.target.value }))}
                      className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-right" inputMode="decimal" /> €
                  </label>
                  <label className="flex items-center gap-1.5 text-gray-600">
                    {t('crm.ads.dailyLimit', 'Tageslimit')}
                    <input value={settingsForm.max_budget} onChange={e => setSettingsForm(f => ({ ...f, max_budget: e.target.value }))}
                      className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-right" inputMode="decimal" /> €
                  </label>
                  <button onClick={() => void saveSettings()} className="px-3 py-1 rounded-lg text-xs font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
                    {t('common.save', 'Speichern')}
                  </button>
                  <button onClick={() => setEditSettings(false)} className="text-xs text-gray-500 underline">{t('common.cancel', 'Abbrechen')}</button>
                </>
              ) : (
                <>
                  <span className="text-gray-600">{t('crm.ads.target', 'Ziel')}-{t('crm.ads.kpiCpl', 'Leadpreis')}: <b>{eur(settings.target_cpl)}</b></span>
                  <span className="text-gray-600">{t('crm.ads.dailyLimit', 'Tageslimit')}: <b>{eur(settings.max_account_daily_budget)}</b> · {t('crm.ads.yesterday', 'gestern')}: <b className={overBudget ? 'text-red-600' : 'text-green-700'}>{eur(yesterdaySpend)}</b></span>
                  <span className="text-gray-500">{t('crm.ads.sysCampaign', 'System-Kampagne')}: <b>{eur(settings.system_campaign_daily_budget)}/Tag</b></span>
                  <button onClick={() => setEditSettings(true)} className="ml-auto text-xs text-gray-500 underline hover:text-gray-800">
                    ✏️ {t('common.edit', 'Bearbeiten')}
                  </button>
                </>
              )}
            </div>

            </div>)}

            {view === 'studio' && (<div>
            {/* KI-Anzeigen-Studio: Brief → Anzeige (Bild/Karussell + Caption) → Chat-Bearbeitung */}
            <AdStudio showToast={showToast} onPublished={() => { void runSync() }} />

            {/* Zielgruppen-Assistent: Beschreibung → Meta-Targeting (System-Kampagne) */}
            <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-1">🧲 {t('crm.ads.audienceTitle', 'Zielgruppen-Assistent (System-Kampagne)')}</h2>
              <p className="text-sm text-gray-400 mb-3">{t('crm.ads.audienceSub', 'Beschreibe in normalen Worten, wen die Werbung erreichen soll — das System übersetzt das in Meta-Targeting und zeigt dir den Vorschlag, bevor er übernommen wird.')}</p>
              <div className="flex flex-wrap gap-2">
                <textarea value={audienceText} onChange={e => setAudienceText(e.target.value)} rows={3}
                  placeholder={t('crm.ads.audiencePh', 'z.B. „Deutsche Ärzte und Apotheker ab 40, die schon Immobilien besitzen und Steuern sparen wollen“')}
                  className="flex-1 min-w-[280px] border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y" />
                <button onClick={() => void suggestAudience()} disabled={audienceBusy || !audienceText.trim()}
                  className="px-6 py-3 rounded-xl text-base font-semibold text-white self-start flex items-center gap-2 disabled:opacity-60"
                  style={{ backgroundColor: '#ff795d' }}>
                  {audienceBusy && <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                  🪄 {t('crm.ads.audienceCta', 'Vorschlag erarbeiten')}
                </button>
              </div>
              {audienceDraft && (
                <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50/50 p-3 text-sm">
                  <p className="text-gray-800 mb-2">{audienceDraft.summary}</p>
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <span className="px-2 py-0.5 rounded-full bg-white border border-gray-200">🎂 {audienceDraft.age_min}–{audienceDraft.age_max}</span>
                    <span className="px-2 py-0.5 rounded-full bg-white border border-gray-200">🌍 {audienceDraft.countries.join(', ')}</span>
                    <span className="px-2 py-0.5 rounded-full bg-white border border-gray-200">
                      {audienceDraft.genders === 'maenner' ? `♂ ${t('crm.ads.men', 'Männer')}` : audienceDraft.genders === 'frauen' ? `♀ ${t('crm.ads.women', 'Frauen')}` : `⚥ ${t('crm.ads.all', 'Alle')}`}
                    </span>
                    {audienceDraft.interests.map(i => (
                      <span key={i.id} className="px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-800" title={i.audience ? `${t('crm.ads.reach', 'Reichweite')}: ${i.audience.toLocaleString(locale)}` : undefined}>
                        💡 {i.name}
                      </span>
                    ))}
                    {audienceDraft.jobs.map(j => (
                      <span key={j.id} className="px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-800">💼 {j.name}</span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <button onClick={() => void applyAudience()} disabled={audienceBusy}
                      className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-60" style={{ backgroundColor: '#16a34a' }}>
                      ✅ {t('crm.ads.audienceApply', 'Auf System-Kampagne anwenden')}
                    </button>
                    <button onClick={() => setAudienceDraft(null)} className="px-3 py-1.5 rounded-lg text-xs text-gray-600 border border-gray-200 hover:bg-gray-50">
                      {t('crm.ads.audienceDiscard', 'Verwerfen')}
                    </button>
                    {/* Lern-Schleife: Korrektur → dauerhafte Regel + neuer Vorschlag */}
                    <input value={audienceFeedback} onChange={e => setAudienceFeedback(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && audienceFeedback.trim()) void suggestAudience(audienceFeedback.trim()) }}
                      placeholder={t('crm.ads.feedbackPh', 'Korrektur, z.B. „nur Männer“ oder „ohne Österreich“ …')}
                      className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                    <button onClick={() => void suggestAudience(audienceFeedback.trim())} disabled={audienceBusy || !audienceFeedback.trim()}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      🧠 {t('crm.ads.feedbackCta', 'Anpassen (wird gelernt)')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            </div>)}

            {view === 'stats' && (<div>
            {/* Hinweis solange die CRM-Zuordnung noch nicht greift */}
            {total.crmLeads === 0 && (
              <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {t('crm.ads.noAttribution', 'Noch keine CRM-Zuordnung: Sobald die Anzeigen die URL-Parameter tragen (Aufgabe liegt bei Giona), laufen Leads, Termine, Qualität und Sales hier automatisch pro Anzeige ein. Bis dahin zählt die Lead-Zahl von Meta.')}
              </div>
            )}

            {/* Empfehlungen + Aktions-Warteschlange */}
            {(recommendations.length > 0 || actions.some(a => a.status !== 'abgelehnt')) && (
              <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4">
                <h2 className="text-sm font-bold text-gray-700 mb-1">💡 {t('crm.ads.recTitle', 'Empfehlungen & Aktionen')}</h2>
                <p className="text-[11px] text-gray-400 mb-3">{t('crm.ads.recSub', 'Ein Klick genügt — die Aktion wird sofort direkt bei Meta ausgeführt.')}</p>
                {recommendations.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {recommendations.map(r => (
                      <div key={r.ad.ad_id} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
                        <span className="text-sm font-semibold text-gray-800 truncate max-w-[240px]" title={r.ad.ad_name ?? r.ad.ad_id}>{r.ad.ad_name ?? r.ad.ad_id}</span>
                        <span className="text-[11px] text-gray-500 truncate">{r.ad.campaign_name}</span>
                        <span className="text-xs text-amber-800 basis-full md:basis-auto md:flex-1">{r.reason}</span>
                        <button onClick={() => void queueAction(r.ad, 'pause', r.reason)}
                          className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold text-white shrink-0"
                          style={{ backgroundColor: '#ff795d' }}>
                          ⏸ {t('crm.ads.recPauseCta', 'Pausieren vormerken')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {actions.filter(a => a.status === 'bestätigt').map(a => (
                  <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 mb-2">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                      {a.action === 'pause' ? '⏸' : '▶'} {t('crm.ads.actQueued', 'vorgemerkt')}
                    </span>
                    <span className="text-sm text-gray-800 truncate max-w-[260px]" title={a.ad_name ?? a.ad_id}>{a.ad_name ?? a.ad_id}</span>
                    {a.reason && <span className="text-[11px] text-gray-400 truncate flex-1">{a.reason}</span>}
                    <button onClick={() => void cancelAction(a.id)} className="ml-auto text-xs text-gray-500 hover:text-red-600 underline shrink-0">
                      {t('crm.ads.actCancel', 'Stornieren')}
                    </button>
                  </div>
                ))}
                {actions.filter(a => a.status === 'ausgeführt' || a.status === 'fehlgeschlagen').slice(0, 5).map(a => (
                  <div key={a.id} className="flex items-center gap-2 px-3 py-1 text-[11px] text-gray-400">
                    <span>{a.status === 'ausgeführt' ? '✅' : '❌'}</span>
                    <span className="truncate">{a.action === 'pause' ? t('crm.ads.actPaused', 'Pausiert') : t('crm.ads.actActivated', 'Aktiviert')}: {a.ad_name ?? a.ad_id}</span>
                    {a.executed_at && <span>{new Date(a.executed_at).toLocaleDateString(locale)}</span>}
                    {a.result && a.status === 'fehlgeschlagen' && <span className="truncate text-red-400">{a.result}</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Diagramme — bewusst groß (Svens Wunsch: Statistik-Reiter mit großen Grafiken) */}
            <div className="grid lg:grid-cols-2 2xl:grid-cols-3 gap-5 mb-6">
              <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-bold text-gray-700 mb-4">{t('crm.ads.chartLeads', 'Leads je Kampagne')}</h2>
                <HBarChart valueFmt={int}
                  data={campaignsSorted.slice(0, 6).map(([cid, a]) => ({
                    label: campaignName(cid),
                    value: a.crmLeads > 0 ? a.crmLeads : a.platformLeads,
                    sub: a.platformLeads > 0 || a.crmLeads > 0 ? `CPL ${per(a.spendEur, a.crmLeads > 0 ? a.crmLeads : a.platformLeads)}` : undefined,
                    color: campaignColor.get(cid) ?? CHART_COLORS[0],
                  }))} />
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-bold text-gray-700 mb-4">{t('crm.ads.chartSpend', 'Budget-Verteilung')}</h2>
                <DonutChart centerLabel={eur(total.spendEur)}
                  data={campaignsSorted.slice(0, 6).map(([cid, a]) => ({
                    label: campaignName(cid), value: a.spendEur, color: campaignColor.get(cid) ?? CHART_COLORS[0],
                  }))} />
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-5 lg:col-span-2 2xl:col-span-1">
                <h2 className="text-base font-bold text-gray-700 mb-4">{t('crm.ads.chartTrend', 'Ausgaben pro Tag')}</h2>
                <TrendChart points={trend.map(p => ({ day: new Date(p.day).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }), value: p.value }))} fmt={eur} />
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>{trend[0] ? new Date(trend[0].day).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) : ''}</span>
                  <span>{trend.length ? new Date(trend[trend.length - 1].day).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) : ''}</span>
                </div>
              </div>
            </div>

            {/* Kampagnen → Anzeigen */}
            <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-gray-700">{t('crm.ads.tableTitle', 'Kampagnen & Anzeigen')}</h2>
                <span className="text-[11px] text-gray-400">
                  <span className="font-semibold text-orange-500">{t('crm.ads.clickHint', '👆 Kampagne anklicken = einzelne Anzeigen (Bildchen) aufklappen')}</span>
                  {' · '}{t('crm.ads.tableHint', 'Frequenz = wie oft dieselbe Person die Werbung im Zeitraum gesehen hat (Ø)')}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                      <th className="px-4 py-2 font-semibold">{t('crm.ads.colName', 'Kampagne / Anzeige')}</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.kpiSpend', 'Ausgaben')}</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.colImpressions', 'Impressionen')}</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.colFrequency', 'Frequenz')}</th>
                      <th className="px-2 py-2 font-semibold text-right">CTR</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.colLeads', 'Leads')}</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.kpiCpl', 'Leadpreis')}</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.colTermine', 'Termine')}</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.colHeld', 'Stattgef.')}</th>
                      <th className="px-2 py-2 font-semibold text-right">No-Show</th>
                      <th className="px-2 py-2 font-semibold text-right">👍/👎</th>
                      <th className="px-2 py-2 font-semibold text-right">Sales</th>
                      <th className="px-2 py-2 font-semibold text-right">{t('crm.ads.revenue', 'Umsatz')}</th>
                      <th className="px-4 py-2 font-semibold text-right">{t('crm.ads.colAction', 'Aktion')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaignsSorted.map(([cid, a]) => {
                      const isOpen = expanded.has(cid)
                      const adsOfCampaign = catalog.filter(c => c.campaign_id === cid)
                        .sort((x, y) => (byAd.get(y.ad_id)?.spendEur ?? 0) - (byAd.get(x.ad_id)?.spendEur ?? 0))
                      const leadsC = a.crmLeads > 0 ? a.crmLeads : a.platformLeads
                      return (
                        <FragmentRows key={cid}>
                          <tr className="border-b border-gray-50 hover:bg-orange-50/40 cursor-pointer" onClick={() => toggleExpand(cid)}>
                            <td className="px-4 py-2.5 font-semibold text-gray-900">
                              <span className="inline-flex items-center gap-2">
                                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: campaignColor.get(cid) }} />
                                <span className="text-gray-400">{isOpen ? '▾' : '▸'}</span>
                                <span className="truncate max-w-[260px]" title={campaignName(cid)}>{campaignName(cid)}</span>
                                <span className="text-[10px] font-normal text-gray-400">({adsOfCampaign.length} Ads)</span>
                                <button onClick={e => { e.stopPropagation(); void openSettings(cid) }}
                                  title={t('crm.ads.settingsBtnTitle', 'Alle Meta-Einstellungen ansehen & ändern')}
                                  className="px-1.5 py-0.5 rounded border border-gray-200 text-[11px] font-normal text-gray-500 hover:border-orange-400 hover:text-orange-600 shrink-0">
                                  ⚙ {t('crm.ads.settingsBtn', 'Einstellungen')}
                                </button>
                              </span>
                            </td>
                            <td className="px-2 py-2.5 text-right tabular-nums font-semibold">{eur(a.spendEur)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{int(a.impressions)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{a.reach > 0 ? (a.impressions / a.reach).toLocaleString(locale, { maximumFractionDigits: 1 }) : '–'}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{a.impressions > 0 ? pct(a.clicks / a.impressions) : '–'}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{int(leadsC)}{a.crmLeads === 0 && a.platformLeads > 0 && <span className="text-gray-400" title={t('crm.ads.basisMeta', 'laut Meta')}>*</span>}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{per(a.spendEur, leadsC)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{int(a.termine)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{int(a.stattgefunden)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{int(a.noShows)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{a.gut + a.schlecht > 0 ? `${a.gut}/${a.schlecht}` : '–'}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{int(a.sales)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{a.revenue > 0 ? eur(a.revenue) : '–'}</td>
                            <td className="px-4 py-2.5" />
                          </tr>
                          {isOpen && adsOfCampaign.map(ad => {
                            const x = byAd.get(ad.ad_id) ?? emptyAgg()
                            const leadsA = x.crmLeads > 0 ? x.crmLeads : x.platformLeads
                            return (
                              <tr key={ad.ad_id} className="border-b border-gray-50 bg-gray-50/50 text-gray-700">
                                <td className="pl-12 pr-4 py-2">
                                  <span className="inline-flex items-center gap-2 min-w-0">
                                    {ad.thumbnail_url
                                      ? <img src={ad.thumbnail_url} alt="" className="w-7 h-7 rounded object-cover shrink-0" loading="lazy" />
                                      : <span className="w-7 h-7 rounded bg-gray-200 text-gray-500 text-[10px] flex items-center justify-center shrink-0">Ad</span>}
                                    <span className="truncate max-w-[240px]" title={ad.ad_name ?? ad.ad_id}>{ad.ad_name ?? ad.ad_id}</span>
                                    <button onClick={e => { e.stopPropagation(); void openPreview(ad) }}
                                      title={t('crm.ads.previewTitle', 'Vorschau ansehen (Facebook & Instagram)')}
                                      className="px-1.5 py-0.5 rounded border border-gray-200 text-[11px] text-gray-500 hover:border-blue-400 hover:text-blue-600 shrink-0">
                                      👁 {t('crm.ads.previewBtn', 'Vorschau')}
                                    </button>
                                    {ad.status !== 'ACTIVE' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500">{t('crm.ads.paused', 'pausiert')}</span>}
                                  </span>
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums">{eur(x.spendEur)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{int(x.impressions)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{x.reach > 0 ? (x.impressions / x.reach).toLocaleString(locale, { maximumFractionDigits: 1 }) : '–'}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{x.impressions > 0 ? pct(x.clicks / x.impressions) : '–'}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{int(leadsA)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{per(x.spendEur, leadsA)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{int(x.termine)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{int(x.stattgefunden)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{int(x.noShows)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{x.gut + x.schlecht > 0 ? `${x.gut}/${x.schlecht}` : '–'}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{int(x.sales)}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{x.revenue > 0 ? eur(x.revenue) : '–'}</td>
                                <td className="px-4 py-2 text-right">
                                  {pendingByAd.has(ad.ad_id) ? (
                                    <span className="text-[10px] px-2 py-1 rounded-full bg-orange-100 text-orange-700 whitespace-nowrap">
                                      {pendingByAd.get(ad.ad_id)?.action === 'pause' ? '⏸' : '▶'} {t('crm.ads.actQueued', 'vorgemerkt')}
                                    </span>
                                  ) : ad.status === 'ACTIVE' ? (
                                    <button onClick={e => { e.stopPropagation(); void queueAction(ad, 'pause', t('crm.ads.reasonManual', 'Manuell im Werbemanager')) }}
                                      title={t('crm.ads.actPauseTitle', 'Anzeige sofort bei Meta pausieren')}
                                      className="px-2 py-1 rounded-lg text-xs font-semibold border border-gray-200 text-gray-600 hover:border-orange-400 hover:text-orange-600 whitespace-nowrap">
                                      ⏸ {t('crm.ads.actPause', 'Pausieren')}
                                    </button>
                                  ) : (
                                    <button onClick={e => { e.stopPropagation(); void queueAction(ad, 'activate', t('crm.ads.reasonManual', 'Manuell im Werbemanager')) }}
                                      title={t('crm.ads.actActivateTitle', 'Anzeige sofort bei Meta aktivieren')}
                                      className="px-2 py-1 rounded-lg text-xs font-semibold border border-gray-200 text-gray-600 hover:border-green-400 hover:text-green-600 whitespace-nowrap">
                                      ▶ {t('crm.ads.actActivate', 'Aktivieren')}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </FragmentRows>
                      )
                    })}
                    {campaignsSorted.length === 0 && (
                      <tr><td colSpan={14} className="px-4 py-10 text-center text-gray-400">{t('crm.ads.empty', 'Keine Werbedaten im gewählten Zeitraum.')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="mt-3 text-[11px] text-gray-400">
              {t('crm.ads.footnote', 'Datenstand: automatischer Sync jeden Morgen direkt aus dem Meta-Werbekonto (Sveru Marketing LLC, USD → EUR umgerechnet) — oder sofort über „Aktualisieren". * = Lead-Zahl laut Meta, solange die CRM-Zuordnung über die Anzeigen-URL-Parameter noch nicht aktiv ist.')}
              {' '}<Link to="/admin/crm/leads" className="underline">{t('crm.ads.toLeads', 'Zu den Leads')}</Link>
            </p>
            </div>)}
          </>
        )}

        {/* ⚙ Voll-Einstellungen einer Kampagne (alles von Meta, wichtige Hebel änderbar) */}
        {settingsView && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSettingsView(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3 sticky top-0 bg-white z-10">
                <h3 className="font-bold text-gray-900 text-sm truncate">⚙ {settingsView.campaignName}</h3>
                <button onClick={() => setSettingsView(null)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
              </div>
              {settingsView.loading || !settingsView.data ? (
                <div className="flex justify-center py-16">
                  <div className="w-8 h-8 rounded-full border-4 border-orange-300 border-t-orange-500 animate-spin" />
                </div>
              ) : (
                <div className="px-5 py-4 space-y-4 text-sm">
                  {/* Kampagne */}
                  <div className="rounded-xl border border-gray-200 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="font-bold text-gray-800">{t('crm.ads.setCampaign', 'Kampagne')}</p>
                      <button disabled={settingsView.busy}
                        onClick={() => void updateEntity(settingsView.campaignId, { status: String(settingsView.data?.campaign.status) === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border disabled:opacity-50 ${String(settingsView.data.campaign.status) === 'ACTIVE' ? 'border-gray-300 text-gray-700 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}>
                        {String(settingsView.data.campaign.status) === 'ACTIVE' ? `⏸ ${t('crm.ads.actPause', 'Pausieren')}` : `▶ ${t('crm.ads.actActivate', 'Aktivieren')}`}
                      </button>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <dt className="text-gray-500">{t('crm.ads.setObjective', 'Ziel')}</dt><dd className="text-gray-800">{metaLabel(settingsView.data.campaign.objective)}</dd>
                      <dt className="text-gray-500">Status</dt><dd className="text-gray-800">{metaLabel(settingsView.data.campaign.effective_status ?? settingsView.data.campaign.status)}</dd>
                      <dt className="text-gray-500">{t('crm.ads.setBidStrategy', 'Gebotsstrategie')}</dt><dd className="text-gray-800">{metaLabel(settingsView.data.campaign.bid_strategy)}</dd>
                      <dt className="text-gray-500">{t('crm.ads.setCreated', 'Erstellt')}</dt><dd className="text-gray-800">{settingsView.data.campaign.created_time ? new Date(String(settingsView.data.campaign.created_time)).toLocaleDateString(locale) : '–'}</dd>
                    </dl>
                  </div>

                  {/* Anzeigengruppen */}
                  {settingsView.data.adsets.map(a => (
                    <div key={String(a.id)} className="rounded-xl border border-gray-200 p-3">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="font-bold text-gray-800 truncate">{t('crm.ads.setAdset', 'Anzeigengruppe')}: {String(a.name)}</p>
                        <button disabled={settingsView.busy}
                          onClick={() => void updateEntity(String(a.id), { status: String(a.status) === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold border disabled:opacity-50 ${String(a.status) === 'ACTIVE' ? 'border-gray-300 text-gray-700 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}>
                          {String(a.status) === 'ACTIVE' ? `⏸ ${t('crm.ads.actPause', 'Pausieren')}` : `▶ ${t('crm.ads.actActivate', 'Aktivieren')}`}
                        </button>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-2">
                        <dt className="text-gray-500">{t('crm.ads.setOptimization', 'Optimiert auf')}</dt>
                        <dd className="text-gray-800">{metaLabel(a.optimization_goal)}{(a.promoted_object as { custom_event_type?: string } | undefined)?.custom_event_type ? ` · ${metaLabel((a.promoted_object as { custom_event_type?: string }).custom_event_type)}` : ''}</dd>
                        <dt className="text-gray-500">{t('crm.ads.setBilling', 'Abrechnung')}</dt><dd className="text-gray-800">{metaLabel(a.billing_event)}</dd>
                        <dt className="text-gray-500">{t('crm.ads.setBidStrategy', 'Gebotsstrategie')}</dt><dd className="text-gray-800">{metaLabel(a.bid_strategy)}</dd>
                        <dt className="text-gray-500">{t('crm.ads.setSchedule', 'Laufzeit')}</dt>
                        <dd className="text-gray-800">{a.start_time ? new Date(String(a.start_time)).toLocaleDateString(locale) : '–'} – {a.end_time ? new Date(String(a.end_time)).toLocaleDateString(locale) : t('crm.ads.setOpenEnd', 'offen')}</dd>
                      </dl>
                      {/* Tagesbudget direkt änderbar */}
                      <div className="flex items-center gap-2 mb-2">
                        <label className="text-xs text-gray-500">{t('crm.ads.setDailyBudget', 'Tagesbudget')} ($)</label>
                        <input value={settingsView.budgetEdits[String(a.id)] ?? ''} inputMode="decimal"
                          onChange={e => setSettingsView(s => s ? { ...s, budgetEdits: { ...s.budgetEdits, [String(a.id)]: e.target.value } } : s)}
                          className="w-24 border border-gray-200 rounded-lg px-2 py-1 text-xs text-right" />
                        <button disabled={settingsView.busy}
                          onClick={() => {
                            const v = parseFloat((settingsView.budgetEdits[String(a.id)] ?? '').replace(',', '.'))
                            if (Number.isFinite(v) && v > 0) void updateEntity(String(a.id), { daily_budget: Math.round(v * 100) })
                          }}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold text-white disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
                          {t('common.save', 'Speichern')}
                        </button>
                      </div>
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('crm.ads.setTargeting', 'Zielgruppe')}</p>
                      <TargetingView targeting={a.targeting as Record<string, unknown>} />
                    </div>
                  ))}

                  {/* Anzeigen */}
                  <div className="rounded-xl border border-gray-200 p-3">
                    <p className="font-bold text-gray-800 mb-2">{t('crm.ads.setAds', 'Anzeigen')} ({settingsView.data.ads.length})</p>
                    <div className="space-y-1.5">
                      {settingsView.data.ads.map(ad => {
                        const linkData = ((ad.creative as { object_story_spec?: { link_data?: { link?: string; call_to_action?: { type?: string } } } } | undefined)?.object_story_spec?.link_data)
                        return (
                          <div key={String(ad.id)} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${String(ad.effective_status ?? ad.status) === 'ACTIVE' ? 'bg-green-500' : 'bg-gray-300'}`} />
                            <span className="text-gray-800 truncate max-w-[220px]" title={String(ad.name)}>{String(ad.name)}</span>
                            <span className="text-gray-400">{metaLabel(ad.effective_status ?? ad.status)}</span>
                            {linkData?.link && <span className="text-gray-400 truncate max-w-[200px]" title={linkData.link}>→ {linkData.link.replace('https://', '')}</span>}
                            <button disabled={settingsView.busy}
                              onClick={() => void updateEntity(String(ad.id), { status: String(ad.status) === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                              className="ml-auto px-2 py-0.5 rounded border border-gray-200 text-[11px] text-gray-600 hover:border-orange-400 disabled:opacity-50">
                              {String(ad.status) === 'ACTIVE' ? '⏸' : '▶'}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400">{t('crm.ads.settingsHint', 'Änderungen wirken sofort direkt bei Meta. Zielgruppe der System-Kampagne änderst du über den Zielgruppen-Assistenten.')}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Anzeigen-Vorschau (Facebook / Instagram / Story) */}
        {preview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreview(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
                <h3 className="font-bold text-gray-900 text-sm truncate">👁 {preview.adName}</h3>
                <button onClick={() => setPreview(null)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
              </div>
              <div className="px-5 pt-3">
                <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                  {([['facebook', 'Facebook'], ['instagram', 'Instagram'], ['story', 'Story']] as const).map(([key, label]) => (
                    <button key={key} onClick={() => setPreview(p => p ? { ...p, tab: key } : p)}
                      className={`flex-1 px-3 py-1.5 font-medium ${preview.tab === key ? 'text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      style={preview.tab === key ? { backgroundColor: '#ff795d' } : undefined}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="px-5 py-4">
                {preview.loading ? (
                  <div className="flex justify-center py-16">
                    <div className="w-8 h-8 rounded-full border-4 border-orange-300 border-t-orange-500 animate-spin" />
                  </div>
                ) : preview.previews?.[preview.tab] ? (
                  // Meta liefert die Vorschau als fertiges iframe-Snippet
                  <div className="flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: preview.previews[preview.tab] }} />
                ) : (
                  <p className="text-sm text-gray-400 text-center py-10">{t('crm.ads.previewUnavailable', 'Für dieses Format liefert Meta keine Vorschau.')}</p>
                )}
                {preview.caption && !preview.loading && (
                  <div className="mt-3 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
                    <p className="text-xs font-bold text-gray-700">{preview.caption.headline}</p>
                    <p className="mt-1 text-xs text-gray-600 whitespace-pre-wrap max-h-48 overflow-y-auto">{preview.caption.message}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl bg-gray-900 text-white text-sm shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

// React.Fragment mit key-Unterstützung für Tabellen-Zeilengruppen
function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>
}
