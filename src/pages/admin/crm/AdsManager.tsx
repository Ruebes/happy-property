import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
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
    <div className={`rounded-xl border px-4 py-3 ${accent ? 'border-orange-200 bg-orange-50/60' : 'border-gray-200 bg-white'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-gray-900 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
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
            <span className="text-xs text-gray-600 truncate">{d.label}</span>
            <span className="text-xs font-semibold text-gray-900 tabular-nums whitespace-nowrap">
              {valueFmt(d.value)}{d.sub && <span className="font-normal text-gray-500"> · {d.sub}</span>}
            </span>
          </div>
          <div className="mt-0.5 h-3 rounded-r bg-gray-100">
            <div className="h-full rounded-r" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color, minWidth: d.value > 0 ? 4 : 0 }} />
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
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 110 110" className="w-32 h-32 shrink-0">
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
      <div className="space-y-1 min-w-0">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs text-gray-600 min-w-0">
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
    <div className="flex items-end gap-[2px] h-28">
      {points.map((p, i) => (
        <div key={i} className="flex-1 min-w-0 group relative" title={`${p.day}: ${fmt(p.value)}`}>
          <div className="rounded-t-sm mx-auto w-full transition group-hover:opacity-80"
            style={{ height: `${Math.max((p.value / max) * 112, p.value > 0 ? 2 : 0)}px`, backgroundColor: '#e8590c' }} />
        </div>
      ))}
    </div>
  )
}

// ── Seite ─────────────────────────────────────────────────────────────────────
export default function AdsManager() {
  const { t, i18n } = useTranslation()
  const { profile } = useAuth()
  const basePath = '/admin/crm'
  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'de-DE'

  const segments = AD_SEGMENTS.filter(s => hasAdSegment(profile, s))
  const [segment, setSegment] = useState<AdSegment>('meta')
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [loading, setLoading] = useState(true)
  const [catalog, setCatalog] = useState<AdCatalogRow[]>([])
  const [insights, setInsights] = useState<InsightRow[]>([])
  const [leads, setLeads] = useState<AdLead[]>([])
  const [appts, setAppts] = useState<AdAppt[]>([])
  const [deals, setDeals] = useState<AdDeal[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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
      setCatalog([]); setInsights([]); setLeads([]); setAppts([]); setDeals([])
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

    const campaignsSorted = [...byCampaign.entries()].sort((x, y) => y[1].spendEur - x[1].spendEur)
    const trend = [...trendMap.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([day, value]) => ({ day, value }))
    return { byAd, byCampaign, campaignsSorted, total, trend }
  }, [catalog, insights, leads, appts, deals])

  const campaignName = useCallback((cid: string) => catalog.find(c => c.campaign_id === cid)?.campaign_name || cid, [catalog])
  const campaignColor = useMemo(() => {
    const m = new Map<string, string>()
    campaignsSorted.forEach(([cid], i) => m.set(cid, colorFor(i)))
    return m
  }, [campaignsSorted])

  // ── Formatierung ───────────────────────────────────────────────────────────
  const eur = (v: number) => v.toLocaleString(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: v >= 100 ? 0 : 2 })
  const int = (v: number) => v.toLocaleString(locale)
  const pct = (v: number) => `${(v * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`
  const per = (spend: number, n: number) => (n > 0 ? eur(spend / n) : '–')

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
          <div className="ml-auto flex rounded-lg border border-gray-200 overflow-hidden">
            {([7, 30, 90] as const).map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-3 py-1.5 text-sm font-medium ${days === d ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {t('crm.ads.days', '{{n}} Tage', { n: d })}
              </button>
            ))}
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
            {/* KPI-Kacheln */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
              <KpiTile label={t('crm.ads.kpiSpend', 'Ausgaben')} value={eur(total.spendEur)}
                sub={t('crm.ads.kpiSpendSub', 'umgerechnet aus USD')} />
              <KpiTile label={t('crm.ads.kpiCpl', 'Leadpreis')} value={per(total.spendEur, leadsShown)}
                sub={`${int(leadsShown)} Leads (${leadBasis})`} accent />
              <KpiTile label={t('crm.ads.kpiCostPerHeld', 'Preis / stattgef. Termin')} value={per(total.spendEur, total.stattgefunden)}
                sub={`${int(total.stattgefunden)} ${t('crm.ads.held', 'stattgefunden')} · ${int(total.noShows)} No-Shows`} />
              <KpiTile label={t('crm.ads.kpiQuality', 'Qualitätsquote')} value={qualityRated > 0 ? pct(total.gut / qualityRated) : '–'}
                sub={`${int(total.gut)} 👍 / ${int(total.schlecht)} 👎`} />
              <KpiTile label={t('crm.ads.kpiCostPerGood', 'Preis / gutem Lead')} value={per(total.spendEur, total.gut)} />
              <KpiTile label={t('crm.ads.kpiRoas', 'ROAS')} value={total.revenue > 0 ? `${roas.toLocaleString(locale, { maximumFractionDigits: 2 })}×` : '–'}
                sub={`${eur(total.revenue)} ${t('crm.ads.revenue', 'Umsatz')} · ${int(total.sales)} Sales`} />
            </div>

            {/* Hinweis solange die CRM-Zuordnung noch nicht greift */}
            {total.crmLeads === 0 && (
              <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {t('crm.ads.noAttribution', 'Noch keine CRM-Zuordnung: Sobald die Anzeigen die URL-Parameter tragen (Aufgabe liegt bei Giona), laufen Leads, Termine, Qualität und Sales hier automatisch pro Anzeige ein. Bis dahin zählt die Lead-Zahl von Meta.')}
              </div>
            )}

            {/* Diagramme */}
            <div className="grid lg:grid-cols-3 gap-4 mb-6">
              <div className="rounded-2xl border border-gray-200 bg-white p-4 lg:col-span-1">
                <h2 className="text-sm font-bold text-gray-700 mb-3">{t('crm.ads.chartLeads', 'Leads je Kampagne')}</h2>
                <HBarChart valueFmt={int}
                  data={campaignsSorted.slice(0, 6).map(([cid, a]) => ({
                    label: campaignName(cid),
                    value: a.crmLeads > 0 ? a.crmLeads : a.platformLeads,
                    sub: a.platformLeads > 0 || a.crmLeads > 0 ? `CPL ${per(a.spendEur, a.crmLeads > 0 ? a.crmLeads : a.platformLeads)}` : undefined,
                    color: campaignColor.get(cid) ?? CHART_COLORS[0],
                  }))} />
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-4 lg:col-span-1">
                <h2 className="text-sm font-bold text-gray-700 mb-3">{t('crm.ads.chartSpend', 'Budget-Verteilung')}</h2>
                <DonutChart centerLabel={eur(total.spendEur)}
                  data={campaignsSorted.slice(0, 6).map(([cid, a]) => ({
                    label: campaignName(cid), value: a.spendEur, color: campaignColor.get(cid) ?? CHART_COLORS[0],
                  }))} />
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-4 lg:col-span-1">
                <h2 className="text-sm font-bold text-gray-700 mb-3">{t('crm.ads.chartTrend', 'Ausgaben pro Tag')}</h2>
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
                      <th className="px-4 py-2 font-semibold text-right">{t('crm.ads.revenue', 'Umsatz')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaignsSorted.map(([cid, a]) => {
                      const isOpen = expanded.has(cid)
                      const adsOfCampaign = catalog.filter(c => c.campaign_id === cid && byAd.has(c.ad_id))
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
                            <td className="px-4 py-2.5 text-right tabular-nums">{a.revenue > 0 ? eur(a.revenue) : '–'}</td>
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
                                <td className="px-4 py-2 text-right tabular-nums">{x.revenue > 0 ? eur(x.revenue) : '–'}</td>
                              </tr>
                            )
                          })}
                        </FragmentRows>
                      )
                    })}
                    {campaignsSorted.length === 0 && (
                      <tr><td colSpan={13} className="px-4 py-10 text-center text-gray-400">{t('crm.ads.empty', 'Keine Werbedaten im gewählten Zeitraum.')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="mt-3 text-[11px] text-gray-400">
              {t('crm.ads.footnote', 'Datenstand: täglicher Sync aus dem Meta-Werbekonto (Sveru Marketing LLC, USD → EUR umgerechnet). * = Lead-Zahl laut Meta, solange die CRM-Zuordnung über die Anzeigen-URL-Parameter noch nicht aktiv ist.')}
              {' '}<Link to="/admin/crm/leads" className="underline">{t('crm.ads.toLeads', 'Zu den Leads')}</Link>
            </p>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}

// React.Fragment mit key-Unterstützung für Tabellen-Zeilengruppen
function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>
}
