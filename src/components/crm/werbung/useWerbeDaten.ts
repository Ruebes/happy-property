import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { supabase } from '../../../lib/supabase'
import type { AdSegment } from '../../../lib/auth'
import {
  AD_SETTINGS_DEFAULT, emptyAdAgg,
  type AdAction, type AdAgg, type AdAppt, type AdCatalogRow, type AdDeal, type AdInsightRow, type AdLead,
  type AdPreparedRow, type AdSettings, type WerbeZeitraum,
} from '../../../lib/crmTypes'

// ── Werbemanager-Daten (/admin/crm/ads) ───────────────────────────────────────
// Laden + Aggregation, unverändert aus AdsManager.tsx übernommen (gleiche
// Abfragen, gleiche Reihenfolge, gleiche Fehlerbehandlung). Datenquellen:
//   ad_catalog / ad_insights_daily  - Plattform-Zahlen (täglicher Sync)
//   leads (utm_campaign={{campaign.id}}, utm_content={{ad.id}})  - CRM-Zuordnung
//   crm_appointments.outcome + leads.quality_rating              - Termine & Qualität
//   deals (phase, commission_amount)                             - Sales & Umsatz
//   (ohne Pipeline-Recht: dieselben drei Listen über RPC ads_crm_attribution)
// CRM-Kennzahlen je Ad greifen erst, wenn die Anzeigen die URL-Parameter tragen
// (Meta-Anzeigen-URL-Setup), bis dahin zählt die Plattform-Lead-Zahl.
//
// Micro-Instanz: höchstens zwei Abfragen gleichzeitig. Die Abfragen stehen
// einzeln in ABFRAGEN; der Zweig t2-2026-10 legt vorbereitet/leitplanken/
// aktionen mit in das erste Promise.all (gleiche Auswertung danach).

export const SALE_PHASES = new Set(['anzahlung', 'provision_erhalten'])
// Gleiche Liste steht in der SQL-Funktion ads_crm_attribution (Migration
// 20261001100000): bei Änderung beide anpassen, sonst sehen Mitarbeiter andere Zahlen.
export const META_SOURCES = new Set(['meta', 'facebook', 'fb', 'instagram', 'ig'])

// Einzelne Abfragen (PostgREST-Builder laufen erst beim await)
const ABFRAGEN = {
  katalog: (segment: AdSegment) =>
    supabase.from('ad_catalog').select('ad_id, campaign_id, campaign_name, adset_id, adset_name, ad_name, status, thumbnail_url').eq('platform', segment),
  insights: (segment: AdSegment, since: string) =>
    supabase.from('ad_insights_daily').select('day, ad_id, spend_eur, impressions, reach, link_clicks, outbound_clicks, landing_page_views, platform_leads, video_3s').eq('platform', segment).gte('day', since),
  // Vorbereitete (nicht freigegebene) Anzeigen
  vorbereitet: () =>
    supabase.from('studio_prepared_ads')
      .select('ad_id, ad_name, created_at').is('released_at', null),
  // Leitplanken (Ziel-Leadpreis, Tageslimit)
  leitplanken: () =>
    supabase.from('ad_settings')
      .select('target_cpl, max_account_daily_budget, system_campaign_daily_budget')
      .eq('id', 'default').maybeSingle(),
  // Aktions-Queue: offene + die letzten 14 Tage erledigte/fehlgeschlagene
  aktionen: (segment: AdSegment) =>
    supabase
      .from('ad_actions')
      .select('id, ad_id, ad_name, campaign_name, action, reason, status, created_at, executed_at, result')
      .eq('platform', segment)
      .or(`status.eq.bestätigt,created_at.gte.${new Date(Date.now() - 14 * 86_400_000).toISOString()}`)
      .order('created_at', { ascending: false }),
}

export interface WerbeDaten {
  loading: boolean
  catalog: AdCatalogRow[]
  /** Vorbereitete Anzeigen (Studio, noch nicht freigegeben): bleiben aus der Übersicht draußen */
  prepared: AdPreparedRow[]
  insights: AdInsightRow[]
  leads: AdLead[]
  appts: AdAppt[]
  deals: AdDeal[]
  actions: AdAction[]
  setActions: Dispatch<SetStateAction<AdAction[]>>
  settings: AdSettings
  setSettings: Dispatch<SetStateAction<AdSettings>>
  /** CRM-Zeilen kamen über die RPC ads_crm_attribution (ohne Pipeline-Recht) */
  crmViaRpc: boolean
  /** Pipeline-Recht oder RPC: CRM-Kennzahlen sind sichtbar */
  crmVisible: boolean
  byAd: Map<string, AdAgg>
  byAdset: Map<string, AdAgg>
  byCampaign: Map<string, AdAgg>
  campaignsSorted: Array<[string, AdAgg]>
  total: AdAgg
  trend: Array<{ day: string; value: number }>
  campaignName: (cid: string) => string
  fetchAll: () => Promise<void>
}

export function useWerbeDaten(segment: AdSegment, days: WerbeZeitraum, canSeeCrm: boolean, profileReady: boolean): WerbeDaten {
  // Leads, Termine und Deals liest die Seite mit dem normalen Client. Deren RLS
  // lässt nur Admin/Verwalter oder das Pipeline-Recht durch; ohne es kommen
  // leere Listen ohne Fehler zurück. Werbe-Mitarbeiter ohne Pipeline-Recht
  // holen dieselben Zeilen deshalb über die Funktion ads_crm_attribution (nur
  // Zuordnungsfelder, keine Personendaten). Fehlt die Funktion noch, bleibt es
  // beim leeren Ergebnis, und die Seite sagt ehrlich, woran es liegt.
  const [crmViaRpc, setCrmViaRpc] = useState(false)
  const crmVisible = canSeeCrm || crmViaRpc
  const [loading, setLoading] = useState(true)
  const [catalog, setCatalog] = useState<AdCatalogRow[]>([])
  const [prepared, setPrepared] = useState<AdPreparedRow[]>([])
  const [insights, setInsights] = useState<AdInsightRow[]>([])
  const [leads, setLeads] = useState<AdLead[]>([])
  const [appts, setAppts] = useState<AdAppt[]>([])
  const [deals, setDeals] = useState<AdDeal[]>([])
  const [actions, setActions] = useState<AdAction[]>([])
  const [settings, setSettings] = useState<AdSettings>(AD_SETTINGS_DEFAULT)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      const [{ data: cat, error: e1 }, { data: ins, error: e2 }] = await Promise.all([
        ABFRAGEN.katalog(segment),
        ABFRAGEN.insights(segment, since),
      ])
      if (e1) throw e1
      if (e2) throw e2
      const catRowsAll = (cat as unknown as AdCatalogRow[]) ?? []
      // Vorbereitete (nicht freigegebene) Anzeigen aus der Übersicht heraushalten
      const { data: prep } = await ABFRAGEN.vorbereitet()
      const prepRows = (prep as Array<{ ad_id: string; ad_name: string | null; created_at: string }> | null) ?? []
      const prepIds = new Set(prepRows.map(p => p.ad_id))
      setPrepared(prepRows.map(p => {
        const c = catRowsAll.find(x => x.ad_id === p.ad_id)
        return {
          ...(c ?? { ad_id: p.ad_id, campaign_id: '', campaign_name: null, adset_id: null, adset_name: null, ad_name: p.ad_name, status: 'PAUSED', thumbnail_url: null }),
          prepared_at: p.created_at,
        }
      }))
      const catRows = catRowsAll.filter(c => !prepIds.has(c.ad_id))
      setCatalog(catRows)
      setInsights((ins as unknown as AdInsightRow[]) ?? [])

      // Leitplanken (Ziel-Leadpreis, Tageslimit), von Sven gepflegt
      const { data: st } = await ABFRAGEN.leitplanken()
      if (st) {
        const s = st as unknown as { target_cpl: string | number; max_account_daily_budget: string | number; system_campaign_daily_budget: string | number }
        setSettings({
          target_cpl: Number(s.target_cpl) || AD_SETTINGS_DEFAULT.target_cpl,
          max_account_daily_budget: Number(s.max_account_daily_budget) || AD_SETTINGS_DEFAULT.max_account_daily_budget,
          system_campaign_daily_budget: Number(s.system_campaign_daily_budget) || AD_SETTINGS_DEFAULT.system_campaign_daily_budget,
        })
      }

      // Aktions-Queue: offene + die letzten 14 Tage erledigte/fehlgeschlagene
      const { data: act, error: eAct } = await ABFRAGEN.aktionen(segment)
      if (eAct) throw eAct
      setActions((act as unknown as AdAction[]) ?? [])

      // CRM-Zuordnung: Leads über utm_campaign/{{campaign.id}} bzw. Meta-Quellen
      const campaignIds = [...new Set(catRows.map(c => c.campaign_id))]

      // Ohne Pipeline-Recht: dieselben Zeilen (gleicher Filter wie unten) über
      // die SECURITY-DEFINER-Funktion. Admin, Verwalter und Pipeline-Recht
      // lesen weiter direkt, für sie ändert sich nichts.
      if (!canSeeCrm) {
        const { data: crm, error: eRpc } = await supabase.rpc('ads_crm_attribution', {
          p_since: `${since}T00:00:00Z`,
          p_campaign_ids: campaignIds,
        })
        if (!eRpc && crm) {
          const rows = crm as { leads?: AdLead[]; appts?: AdAppt[]; deals?: AdDeal[] }
          setLeads(rows.leads ?? [])
          setAppts(rows.appts ?? [])
          setDeals(rows.deals ?? [])
          setCrmViaRpc(true)
          return
        }
        // Funktion noch nicht eingespielt: weiter wie bisher (RLS liefert leere
        // Listen), die Seite zeigt den Hinweis zum Pipeline-Recht.
        console.warn('[AdsManager] ads_crm_attribution nicht verfügbar:', eRpc)
        setCrmViaRpc(false)
      }

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
  }, [segment, days, canSeeCrm])

  // Erst laden, wenn das Profil da ist (oder die Anmeldung ohne Profil fertig
  // ist): Beim Kaltstart ohne Profil-Cache war canSeeCrm sonst kurz false, auch
  // der Admin rief dann die Funktion auf und lud danach ein zweites Mal direkt.
  // Mit Profil-Cache (Normalfall) ist profileReady sofort true, nichts ändert sich.
  useEffect(() => { if (profileReady) void fetchAll() }, [fetchAll, profileReady])

  // ── Aggregation ────────────────────────────────────────────────────────────
  const { byAd, byAdset, byCampaign, campaignsSorted, total, trend } = useMemo(() => {
    const byAd = new Map<string, AdAgg>()
    const byAdset = new Map<string, AdAgg>()
    const byCampaign = new Map<string, AdAgg>()
    const trendMap = new Map<string, number>()
    const adToCampaign = new Map(catalog.map(c => [c.ad_id, c.campaign_id]))
    const adToAdset = new Map(catalog.filter(c => c.adset_id).map(c => [c.ad_id, c.adset_id as string]))
    const get = (m: Map<string, AdAgg>, k: string) => { let a = m.get(k); if (!a) { a = emptyAdAgg(); m.set(k, a) } return a }

    // Die Anzeigen-Links übergeben teils den NAMEN statt der ID (utm_campaign =
    // "20.03.26+-+TOF+-+Leads"), URL-kodiert mit + für Leerzeichen. Ein reiner
    // ID-Vergleich traf deshalb nie, und die CRM-Spalten (Termine, 👍/👎, Sales)
    // blieben in der Tabelle auf null, obwohl die Leads korrekt bewertet waren.
    // Namen werden hier auf IDs abgebildet; mehrdeutige Namen bewusst nicht.
    const norm = (v: string) => {
      let x = v.replace(/\+/g, ' ')
      try { x = decodeURIComponent(x) } catch { /* schon dekodiert */ }
      return x.trim().toLowerCase()
    }
    const nameToId = (pairs: Array<[string, string]>) => {
      const m = new Map<string, string>()
      const ambiguous = new Set<string>()
      for (const [nm, id] of pairs) {
        const k = norm(nm)
        if (!k) continue
        const prev = m.get(k)
        if (prev && prev !== id) ambiguous.add(k)
        else m.set(k, id)
      }
      for (const k of ambiguous) m.delete(k)
      return m
    }
    const campaignNameToId = nameToId(catalog.filter(c => c.campaign_id && c.campaign_name).map(c => [c.campaign_name!, c.campaign_id!]))
    const adNameToId       = nameToId(catalog.filter(c => c.ad_id && c.ad_name).map(c => [c.ad_name!, c.ad_id]))
    const resolveAdId = (v: string | null) => {
      if (!v) return undefined
      if (byAd.has(v)) return v
      return adNameToId.get(norm(v))
    }
    const resolveCampaignId = (v: string | null, adId?: string) => {
      if (adId) { const viaAd = adToCampaign.get(adId); if (viaAd) return viaAd }
      if (!v) return undefined
      if (byCampaign.has(v)) return v
      return campaignNameToId.get(norm(v))
    }

    const addInsight = (a: AdAgg, r: AdInsightRow) => {
      a.spendEur += r.spend_eur; a.impressions += r.impressions; a.reach += r.reach
      a.clicks += r.link_clicks; a.platformLeads += r.platform_leads; a.video3s += r.video_3s
      a.outboundClicks += r.outbound_clicks ?? 0; a.landingPageViews += r.landing_page_views ?? 0
    }
    for (const r of insights) {
      addInsight(get(byAd, r.ad_id), r)
      const cid = adToCampaign.get(r.ad_id)
      if (cid) addInsight(get(byCampaign, cid), r)
      // Anzeigengruppen-Ebene (neu, für Kampagnen/Qualität; ändert keine Kampagnen-/Ad-Zahl)
      const asid = adToAdset.get(r.ad_id)
      if (asid) addInsight(get(byAdset, asid), r)
      trendMap.set(r.day, (trendMap.get(r.day) ?? 0) + r.spend_eur)
    }

    // CRM-Kette: Lead -> Termin -> Ausgang -> Qualität -> Sale, der Ad/Kampagne zugeordnet
    const apptsByLead = new Map<string, AdAppt[]>()
    for (const a of appts) { if (a.lead_id) { const arr = apptsByLead.get(a.lead_id) ?? []; arr.push(a); apptsByLead.set(a.lead_id, arr) } }
    const dealsByLead = new Map<string, AdDeal[]>()
    for (const d of deals) { const arr = dealsByLead.get(d.lead_id) ?? []; arr.push(d); dealsByLead.set(d.lead_id, arr) }

    const applyLead = (a: AdAgg, l: AdLead) => {
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
      const adId = resolveAdId(l.utm_content)
      if (adId) {
        applyLead(get(byAd, adId), l)
        const asid = adToAdset.get(adId)
        if (asid) applyLead(get(byAdset, asid), l)
      }
      const cid = resolveCampaignId(l.utm_campaign, adId)
      if (cid) applyLead(get(byCampaign, cid), l)
    }

    const total = emptyAdAgg()
    for (const a of byCampaign.values()) {
      total.spendEur += a.spendEur; total.impressions += a.impressions; total.reach += a.reach
      total.clicks += a.clicks; total.platformLeads += a.platformLeads; total.video3s += a.video3s
    }
    // CRM-Kette im Gesamt: ALLE Meta-Leads zählen, auch ohne Kampagnen-Zuordnung
    for (const l of leads) applyLead(total, l)

    // Kampagnen ganz ohne Insights (z.B. neu angelegt, pausiert) trotzdem listen,
    // sonst wären frisch erstellte System-Kampagnen im Werbemanager unsichtbar.
    for (const c of catalog) if (c.campaign_id && !byCampaign.has(c.campaign_id)) byCampaign.set(c.campaign_id, emptyAdAgg())
    for (const c of catalog) if (c.adset_id && !byAdset.has(c.adset_id)) byAdset.set(c.adset_id, emptyAdAgg())

    const campaignsSorted = [...byCampaign.entries()].sort((x, y) => y[1].spendEur - x[1].spendEur)
    const trend = [...trendMap.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([day, value]) => ({ day, value }))
    return { byAd, byAdset, byCampaign, campaignsSorted, total, trend }
  }, [catalog, insights, leads, appts, deals])

  const campaignName = useCallback((cid: string) => catalog.find(c => c.campaign_id === cid)?.campaign_name || cid, [catalog])

  return {
    loading, catalog, prepared, insights, leads, appts, deals, actions, setActions, settings, setSettings,
    crmViaRpc, crmVisible, byAd, byAdset, byCampaign, campaignsSorted, total, trend, campaignName, fetchAll,
  }
}

// ── Kontext für die Reiter ────────────────────────────────────────────────────
// lazyWithReload nimmt nur Komponenten ohne Pflicht-Props: die Reiter holen
// Daten und Aktionen der Seite deshalb über diesen Kontext (wie die
// CommandPalette über PaletteBridgeContext).
export interface WerbeKontextWert extends WerbeDaten {
  segment: AdSegment
  days: WerbeZeitraum
  syncing: boolean
  /** Sofort-Sync bei Meta (meta-ads-sync {days: 3}), danach neu laden */
  runSync: () => Promise<void>
  /** Vorschau-Fenster einer Anzeige öffnen */
  openPreview: (ad: AdCatalogRow) => void
  /** Einstellungen-Fenster einer Kampagne öffnen */
  openSettings: (campaignId: string) => void
  /** Hinweis zeigen; führendes ✅ = Erfolg, ❌/⛔ = Fehler, sonst Info */
  showToast: (msg: string) => void
}

export const WerbeKontext = createContext<WerbeKontextWert | null>(null)

export function useWerbeKontext(): WerbeKontextWert {
  const ctx = useContext(WerbeKontext)
  if (!ctx) throw new Error('useWerbeKontext außerhalb des Werbemanagers')
  return ctx
}

// ── Kurs USD je EUR (Hinweis neben Dollar-Eingaben) ──────────────────────────
// Schnitt der letzten 7 Tage: Summe spend (USD) / Summe spend_eur. Eine kleine
// Abfrage, erst beim Öffnen der Einstellungen, danach aus dem Zwischenspeicher.
// null = kein brauchbarer Wert (Aufrufer nimmt den Ersatzkurs).
let kursCache: Promise<number | null> | null = null

export function ladeUsdProEur(): Promise<number | null> {
  if (!kursCache) {
    kursCache = (async () => {
      try {
        const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
        const { data, error } = await supabase.from('ad_insights_daily')
          .select('spend, spend_eur').eq('platform', 'meta').gte('day', since).limit(1000)
        if (error) throw error
        let usd = 0, eur = 0
        for (const r of (data as Array<{ spend: number | string | null; spend_eur: number | string | null }> | null) ?? []) {
          usd += Number(r.spend) || 0
          eur += Number(r.spend_eur) || 0
        }
        const kurs = eur > 0 ? usd / eur : NaN
        // Nur plausible Kurse übernehmen, sonst Ersatzkurs
        return Number.isFinite(kurs) && kurs > 0.8 && kurs < 1.6 ? kurs : null
      } catch (err) {
        console.warn('[AdsManager] Kurs USD/EUR nicht ermittelbar:', err)
        kursCache = null   // beim nächsten Öffnen erneut versuchen
        return null
      }
    })()
  }
  return kursCache
}
