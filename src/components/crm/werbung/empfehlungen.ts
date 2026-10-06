import type { TFunction } from 'i18next'
import type { AdAgg, AdCatalogRow, AdEigeneAnkuenfte, AdRecommendation } from '../../../lib/crmTypes'
import type { WerbeFormat } from './format'

// ── Empfehlungen (Regel-Engine des Statistik-Reiters) ────────────────────────
// Reine Funktion über den geladenen Zeitraum, aus AdsManager.tsx übernommen
// (gleiche Regeln, Schwellen und Texte; einzige Ausnahme: der Zielseiten-Hinweis
// braucht seit 10/2026 die Gegenprobe aus eigeneAnkuenfte.ts). Keine
// Seiteneffekte, kein Zugriff auf Supabase.

export interface EmpfehlungEingabe {
  catalog: AdCatalogRow[]
  byAd: Map<string, AdAgg>
  /** Anzeigen mit offener (bestätigter) Aktion: keine neue Empfehlung */
  vorgemerkt: { has: (adId: string) => boolean }
  /** Ziel-Leadpreis aus den Leitplanken (EUR) */
  targetCpl: number
  /** CRM-Zahlen sichtbar (Pipeline-Recht oder RPC) */
  crmVisible: boolean
  /** Gegenprobe Zielseite mit dem eigenen Tracker (eigeneAnkuenfte.ts) */
  eigeneAnkuenfte: AdEigeneAnkuenfte
  t: TFunction
  fmt: WerbeFormat
}

// Zielseiten-Verlust: erst ab so vielen ausgehenden Klicks, und nur wenn weniger
// als dieser Anteil auf der Seite ankommt.
export const LP_MIN_KLICKS = 40
export const LP_MIN_ANKUNFT = 0.7

/** Laut Meta kommen zu wenige der Klicks auf der Seite an (noch ohne Gegenprobe). */
const metaLpVerlust = (a: AdAgg) =>
  a.outboundClicks >= LP_MIN_KLICKS && a.landingPageViews / a.outboundClicks < LP_MIN_ANKUNFT

/** Aktive Anzeigen mit Meta-Verlust: nur für diese fragt eigeneAnkuenfte.ts die
 *  eigenen Besucherzahlen ab. */
export function lpVerlustKandidaten(catalog: AdCatalogRow[], byAd: Map<string, AdAgg>): string[] {
  return catalog
    .filter(c => { const a = byAd.get(c.ad_id); return c.status === 'ACTIVE' && !!a && metaLpVerlust(a) })
    .map(c => c.ad_id)
}

export function berechneEmpfehlungen({ catalog, byAd, vorgemerkt, targetCpl, crmVisible, eigeneAnkuenfte, t, fmt }: EmpfehlungEingabe): AdRecommendation[] {
  const { eur, int, pct, locale } = fmt
  const recs: AdRecommendation[] = []
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
    if (c.status !== 'ACTIVE' || vorgemerkt.has(c.ad_id)) continue
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
      if (cpl > 1.5 * targetCpl) {
        recs.push({ ad: c, kind: 'over_target', spend: a.spendEur, reason: t('crm.ads.recReasonTarget', 'Leadpreis {{cpl}} - weit über deinem Ziel von {{target}}', { cpl: eur(cpl), target: eur(targetCpl) }) })
        continue
      }
    }
    const meds = cplByCampaign.get(c.campaign_id)
    if (eff > 0 && meds && meds.length >= 3 && a.spendEur >= 100) {
      const m = median(meds), cpl = a.spendEur / eff
      if (cpl > 1.6 * m) {
        recs.push({ ad: c, kind: 'high_cpl', spend: a.spendEur, reason: t('crm.ads.recReasonCpl', 'Leadpreis {{cpl}} - {{factor}}× teurer als der Kampagnen-Schnitt ({{median}})', { cpl: eur(cpl), factor: (cpl / m).toLocaleString(locale, { maximumFractionDigits: 1 }), median: eur(m) }) })
        continue
      }
    }
    const freq = a.reach > 0 ? a.impressions / a.reach : 0
    const ctr = a.impressions > 0 ? a.clicks / a.impressions : 0
    if (freq > 2.5 && ctr < 0.01) {
      recs.push({ ad: c, kind: 'fatigue', spend: a.spendEur, reason: t('crm.ads.recReasonFatigue', 'Ermüdung: Frequenz {{freq}} bei nur {{ctr}} Klickrate - Motiv ist verbraucht', { freq: freq.toLocaleString(locale, { maximumFractionDigits: 1 }), ctr: pct(ctr) }) })
    }
  }

  // ── Hinweise: die Anzeige ist in Ordnung, das Problem liegt dahinter ──────
  const hints: AdRecommendation[] = []
  for (const c of catalog) {
    if (c.status !== 'ACTIVE') continue
    const a = byAd.get(c.ad_id)
    if (!a) continue

    // Bezahlte Klicks, die nie auf der Seite ankommen. Meta zählt „Outbound
    // Clicks" (Klicks weg von Meta) und „Landing Page Views". Ein Landing Page
    // View zählt aber nur, wenn auf der Seite das Meta-Pixel feuert: Lädt die
    // Seite, das Pixel jedoch nicht (z. B. ohne Cookie-Zustimmung), fehlt der
    // Besuch bei Meta trotzdem. Meta allein reicht deshalb nicht für die Aussage
    // „bricht beim Laden ab". Gegenprobe mit dem eigenen, cookie-losen Tracker
    // (wa-track, utm_content = Anzeigen-ID): Kommen dort genug an, lädt die
    // Seite, und es gibt keinen Hinweis. Solange die Gegenprobe läuft, auch nicht.
    if (eigeneAnkuenfte !== 'laedt' && metaLpVerlust(a)) {
      const klicks = a.outboundClicks
      const eigen = eigeneAnkuenfte === 'ohne' ? 0 : (eigeneAnkuenfte.get(c.ad_id) ?? 0)
      if (eigen / klicks < LP_MIN_ANKUNFT) {
        const arrived = Math.max(eigen, a.landingPageViews) / klicks
        hints.push({
          ad: c, kind: 'lp_loss', spend: a.spendEur,
          reason: eigen > 0
            ? t('crm.ads.recReasonLpLoss', 'Nur {{arrived}} der Klicks erreichen die Seite ({{eigen}} laut eigenem Tracker, {{lpv}} laut Meta, von {{clicks}}) - der Rest bricht beim Laden ab', {
                arrived: pct(arrived), eigen: int(eigen), lpv: int(a.landingPageViews), clicks: int(klicks),
              })
            : t('crm.ads.recReasonLpLossUngeprueft', 'Meta zählt nur {{arrived}} der Klicks auf der Seite ({{lpv}} von {{clicks}}) - ohne eigene Besucherzahlen nicht bestätigt', {
                arrived: pct(arrived), lpv: int(a.landingPageViews), clicks: int(klicks),
              }),
          advice: t('crm.ads.recAdviceLpLoss', 'Zielseite prüfen, nicht die Anzeige'),
        })
      }
    }

    // Leads, die Meta zählt, ohne dass jemals eine Seite geladen wurde: das
    // sind Sofortformulare, die direkt bei Meta ausgefüllt werden. Ohne
    // Anbindung landen sie NICHT im CRM und ruft niemand an.
    if (crmVisible && a.platformLeads >= 3 && a.crmLeads === 0 && a.landingPageViews < a.platformLeads) {
      hints.push({
        ad: c, kind: 'orphan_leads', spend: a.spendEur,
        reason: t('crm.ads.recReasonOrphan', '{{leads}} Leads bei Meta, aber keiner im CRM - sie kommen aus einem Sofortformular', { leads: int(a.platformLeads) }),
        advice: t('crm.ads.recAdviceOrphan', 'Bei Meta abholen'),
      })
    }
  }

  return [...recs.sort((x, y) => y.spend - x.spend).slice(0, 5),
          ...hints.sort((x, y) => y.spend - x.spend).slice(0, 3)]
}
