import type { AdAgg, AdCatalogRow } from '../../../../lib/crmTypes'
import type { SteuerungEbene } from '../../../../lib/werbeSteuerung'

// ── Kampagnen, Anzeigengruppen und Anzeigen zur Auswahl ─────────────────────
// Aus dem Anzeigen-Katalog der Seite (ad_catalog, schon geladen): keine
// zusätzliche Datenbank-Abfrage. Aktiv = mindestens eine Anzeige darunter
// ist aktiv. Ausgaben aus den Seitendaten (gewählter Zeitraum).

export interface WahlObjekt {
  id: string
  ebene: SteuerungEbene
  name: string
  /** Kampagne bzw. Anzeigengruppe darüber (für die Anzeige) */
  oben: string | null
  campaignId: string
  adsetId: string | null
  aktiv: boolean
  ausgabenEur: number
}

const istAktiv = (s: string | null) => (s ?? '').toUpperCase() === 'ACTIVE'

export function wahlObjekte(
  catalog: AdCatalogRow[],
  ebene: SteuerungEbene,
  agg: { byAd: Map<string, AdAgg>; byAdset: Map<string, AdAgg>; byCampaign: Map<string, AdAgg> },
): WahlObjekt[] {
  const m = new Map<string, WahlObjekt>()
  for (const a of catalog) {
    if (ebene === 'ad') {
      m.set(a.ad_id, {
        id: a.ad_id, ebene, name: a.ad_name || a.ad_id,
        oben: [a.campaign_name, a.adset_name].filter(Boolean).join(' › ') || null,
        campaignId: a.campaign_id, adsetId: a.adset_id, aktiv: istAktiv(a.status),
        ausgabenEur: agg.byAd.get(a.ad_id)?.spendEur ?? 0,
      })
      continue
    }
    const id = ebene === 'adset' ? a.adset_id : a.campaign_id
    if (!id) continue
    const alt = m.get(id)
    if (alt) {
      alt.aktiv = alt.aktiv || istAktiv(a.status)
      continue
    }
    m.set(id, {
      id, ebene,
      name: (ebene === 'adset' ? a.adset_name : a.campaign_name) || id,
      oben: ebene === 'adset' ? a.campaign_name : null,
      campaignId: a.campaign_id, adsetId: a.adset_id, aktiv: istAktiv(a.status),
      ausgabenEur: (ebene === 'adset' ? agg.byAdset.get(id) : agg.byCampaign.get(id))?.spendEur ?? 0,
    })
  }
  return [...m.values()].sort((x, y) => Number(y.aktiv) - Number(x.aktiv) || y.ausgabenEur - x.ausgabenEur || x.name.localeCompare(y.name))
}
