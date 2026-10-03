import type { AdAgg, AdCatalogRow } from '../../../../lib/crmTypes'
import type { BasisFeld, Ebene, Knoten, Lernphase, LiveStatus, Spiegel, Werte } from './typen'

// ── Baum Kampagne > Anzeigengruppe > Anzeige ─────────────────────────────────
// Grundlage ist ad_catalog (alle Anzeigen); die Spiegeltabellen ergänzen
// Budget, Gebote, Auslieferung und Lernphase und bringen Kampagnen/Gruppen ohne
// Anzeigen dazu (nur laufende oder frische). Live-Status von Meta (auf
// Knopfdruck) gewinnt vor dem Spiegel. Kennzahlen: Aggregate aus dem
// WerbeKontext; sind Meta-Zahlen für einen freien Zeitraum geladen, ersetzen
// sie die Plattform-Zahlen, die CRM-Zahlen bleiben aus dem Kontext.

export const knotenKey = (level: Ebene, id: string) => `${level}:${id}`

const CRM_FELDER: BasisFeld[] = ['crm_leads', 'termine', 'stattgefunden', 'no_shows', 'gut', 'schlecht', 'sales', 'umsatz']

/** Kennzahlen aus einem Aggregat des WerbeKontexts */
export function werteAusAgg(a: AdAgg | undefined, crm: boolean): Werte {
  if (!a) return {}
  const w: Werte = {
    ausgaben: a.spendEur, impressionen: a.impressions, reichweite: a.reach, link_klicks: a.clicks,
    ausgehende_klicks: a.outboundClicks, lpv: a.landingPageViews, meta_leads: a.platformLeads, video_3s: a.video3s,
  }
  if (crm) {
    w.crm_leads = a.crmLeads; w.termine = a.termine; w.stattgefunden = a.stattgefunden; w.no_shows = a.noShows
    w.gut = a.gut; w.schlecht = a.schlecht; w.sales = a.sales; w.umsatz = a.revenue
  }
  return w
}

/** Plattform-Zahlen aus Meta, CRM-Zahlen aus dem Kontext */
function mischen(basis: Werte, meta: Werte | undefined): Werte {
  const w: Werte = { ...(meta ?? {}) }
  for (const f of CRM_FELDER) if (basis[f] !== undefined) w[f] = basis[f]
  return w
}

const AUS = new Set(['ARCHIVED', 'DELETED'])
const groesser = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b)

export interface BaumEingabe {
  catalog: AdCatalogRow[]
  /** Kampagnen-IDs in Anzeigereihenfolge (Ausgaben absteigend) */
  reihenfolge: string[]
  byCampaign: Map<string, AdAgg>
  byAdset: Map<string, AdAgg>
  byAd: Map<string, AdAgg>
  crm: boolean
  spiegel: Spiegel | null
  live: Map<string, LiveStatus>
  /** Meta-Zahlen je knotenKey (null = Datenbank-Zahlen nutzen) */
  meta: Map<string, Werte> | null
  /** Kampagnen ohne Anzeigen: nur, wenn aktiv oder seit diesem Zeitpunkt angelegt (ISO) */
  frischSeit: string
}

export function baueBaum(e: BaumEingabe): Knoten[] {
  const { catalog, spiegel, live, meta, crm } = e
  const werte = (level: Ebene, id: string, agg: AdAgg | undefined): Werte => {
    const basis = werteAusAgg(agg, crm)
    return meta ? mischen(basis, meta.get(knotenKey(level, id))) : basis
  }

  // Anzeigen je Kampagne/Gruppe
  const anzeigenJeKampagne = new Map<string, AdCatalogRow[]>()
  for (const ad of catalog) {
    if (!ad.campaign_id) continue
    const arr = anzeigenJeKampagne.get(ad.campaign_id) ?? []
    arr.push(ad)
    anzeigenJeKampagne.set(ad.campaign_id, arr)
  }

  const kampagnenIds: string[] = []
  const gesehen = new Set<string>()
  for (const id of e.reihenfolge) if (!gesehen.has(id) && anzeigenJeKampagne.has(id)) { gesehen.add(id); kampagnenIds.push(id) }
  for (const id of anzeigenJeKampagne.keys()) if (!gesehen.has(id)) { gesehen.add(id); kampagnenIds.push(id) }
  // Kampagnen nur aus dem Spiegel (noch ohne Anzeigen): laufend oder frisch angelegt
  for (const k of spiegel?.kampagnen.values() ?? []) {
    if (gesehen.has(k.campaign_id)) continue
    const eff = (k.effective_status ?? '').toUpperCase()
    if (AUS.has(eff)) continue
    if (eff === 'ACTIVE' || (k.created_time && k.created_time >= e.frischSeit)) { gesehen.add(k.campaign_id); kampagnenIds.push(k.campaign_id) }
  }

  const gruppenJeKampagne = new Map<string, string[]>()
  for (const g of spiegel?.gruppen.values() ?? []) {
    if (!g.campaign_id || AUS.has((g.effective_status ?? '').toUpperCase())) continue
    const arr = gruppenJeKampagne.get(g.campaign_id) ?? []
    arr.push(g.adset_id)
    gruppenJeKampagne.set(g.campaign_id, arr)
  }

  const spend = (m: Map<string, AdAgg>, id: string) => m.get(id)?.spendEur ?? 0

  return kampagnenIds.map(cid => {
    const ads = anzeigenJeKampagne.get(cid) ?? []
    const sk = spiegel?.kampagnen.get(cid)
    const lk = live.get(cid)
    const kampagnenbudget = (sk?.daily_budget_cents ?? 0) > 0 || (sk?.lifetime_budget_cents ?? 0) > 0

    // Anzeigengruppen: aus den Anzeigen, ergänzt um Gruppen aus dem Spiegel
    const gruppenIds: string[] = []
    const gSet = new Set<string>()
    for (const ad of ads) if (ad.adset_id && !gSet.has(ad.adset_id)) { gSet.add(ad.adset_id); gruppenIds.push(ad.adset_id) }
    for (const gid of gruppenJeKampagne.get(cid) ?? []) if (!gSet.has(gid)) { gSet.add(gid); gruppenIds.push(gid) }
    gruppenIds.sort((x, y) => spend(e.byAdset, y) - spend(e.byAdset, x))

    const anzeigeKnoten = (ad: AdCatalogRow, lern: Lernphase | null): Knoten => {
      const sa = spiegel?.anzeigen.get(ad.ad_id)
      const la = live.get(ad.ad_id)
      const probleme = [la?.issues, la?.review_feedback, sa?.issues_info, sa?.review_feedback].filter(x => x != null)
      return {
        key: knotenKey('ad', ad.ad_id), level: 'ad', id: ad.ad_id, name: ad.ad_name || ad.ad_id,
        campaignId: cid, adsetId: ad.adset_id,
        status: la?.configured_status ?? sa?.configured_status ?? ad.status,
        effectiveStatus: la?.effective_status ?? sa?.effective_status ?? ad.status,
        lernphase: lern, probleme: probleme.length ? probleme : null,
        budgetTagCents: null, budgetLaufzeitCents: null, gebotsstrategie: null, leistungsziel: null,
        kampagnenbudget: false, ausSpiegel: !!sa, ende: null, thumbnail: ad.thumbnail_url,
        werte: werte('ad', ad.ad_id, e.byAd.get(ad.ad_id)),
        kinder: [],
      }
    }

    const gruppen: Knoten[] = gruppenIds.map(gid => {
      const sg = spiegel?.gruppen.get(gid)
      const lg = live.get(gid)
      const gAds = ads.filter(a => a.adset_id === gid)
        .sort((x, y) => spend(e.byAd, y.ad_id) - spend(e.byAd, x.ad_id))
      const lern: Lernphase | null = lg?.learning ?? (sg && (sg.learning_status || sg.last_sig_edit_ts)
        ? { status: sg.learning_status, conversions: sg.learning_conversions, last_sig_edit_ts: sg.last_sig_edit_ts }
        : null)
      const abgeleitet = gAds.some(a => (a.status ?? '').toUpperCase() === 'ACTIVE') ? 'ACTIVE' : gAds.length ? 'PAUSED' : null
      const probleme = [lg?.issues, sg?.issues].filter(x => x != null)
      return {
        key: knotenKey('adset', gid), level: 'adset', id: gid,
        name: gAds.find(a => a.adset_name)?.adset_name || sg?.name || gid,
        campaignId: cid, adsetId: gid,
        status: lg?.configured_status ?? sg?.status ?? abgeleitet,
        effectiveStatus: lg?.effective_status ?? sg?.effective_status ?? abgeleitet,
        lernphase: lern, probleme: probleme.length ? probleme : null,
        budgetTagCents: sg?.daily_budget_cents ?? null, budgetLaufzeitCents: sg?.lifetime_budget_cents ?? null,
        gebotsstrategie: sg?.bid_strategy ?? sk?.bid_strategy ?? null, leistungsziel: sg?.optimization_goal ?? null,
        kampagnenbudget, ausSpiegel: !!sg, ende: sg?.end_time ?? null, thumbnail: null,
        werte: werte('adset', gid, e.byAdset.get(gid)),
        kinder: gAds.map(ad => anzeigeKnoten(ad, lern)),
      }
    })
    // Anzeigen ohne Anzeigengruppe direkt unter der Kampagne
    const lose = ads.filter(a => !a.adset_id).map(ad => anzeigeKnoten(ad, null))

    // Lernphase der Kampagne aus den aktiven Gruppen
    const aktiveG = gruppen.filter(g => (g.effectiveStatus ?? '').toUpperCase() === 'ACTIVE')
    let lernK: Lernphase | null = lk?.learning ?? null
    if (!lernK && aktiveG.length) {
      const st = aktiveG.map(g => (g.lernphase?.status ?? '').toUpperCase())
      const status = st.every(x => x === 'LEARNING') ? 'LEARNING' : st.some(x => x === 'FAIL') ? 'FAIL' : st.some(Boolean) ? 'SUCCESS' : null
      let letzte: string | null = null
      for (const g of aktiveG) letzte = groesser(letzte, g.lernphase?.last_sig_edit_ts ?? null)
      lernK = status || letzte ? { status, conversions: null, last_sig_edit_ts: letzte } : null
    }
    const abgeleitet = ads.some(a => (a.status ?? '').toUpperCase() === 'ACTIVE') ? 'ACTIVE' : ads.length ? 'PAUSED' : null
    const probleme = [lk?.issues, sk?.issues].filter(x => x != null)
    return {
      key: knotenKey('campaign', cid), level: 'campaign', id: cid,
      name: ads.find(a => a.campaign_name)?.campaign_name || sk?.name || cid,
      campaignId: cid, adsetId: null,
      status: lk?.configured_status ?? sk?.status ?? abgeleitet,
      effectiveStatus: lk?.effective_status ?? sk?.effective_status ?? abgeleitet,
      lernphase: lernK, probleme: probleme.length ? probleme : null,
      budgetTagCents: sk?.daily_budget_cents ?? null, budgetLaufzeitCents: sk?.lifetime_budget_cents ?? null,
      gebotsstrategie: sk?.bid_strategy ?? null, leistungsziel: null,
      kampagnenbudget, ausSpiegel: !!sk, ende: sk?.stop_time ?? null, thumbnail: null,
      werte: werte('campaign', cid, e.byCampaign.get(cid)),
      kinder: [...gruppen, ...lose],
    } satisfies Knoten
  })
}

/** Alle Knoten einer Ebene (flache Liste) */
export function knotenDerEbene(baum: Knoten[], level: Ebene): Knoten[] {
  const out: Knoten[] = []
  const lauf = (ks: Knoten[]) => { for (const k of ks) { if (k.level === level) out.push(k); lauf(k.kinder) } }
  lauf(baum)
  return out
}

/** Alle Knoten (Tiefensuche) */
export function alleKnoten(baum: Knoten[]): Knoten[] {
  const out: Knoten[] = []
  const lauf = (ks: Knoten[]) => { for (const k of ks) { out.push(k); lauf(k.kinder) } }
  lauf(baum)
  return out
}
