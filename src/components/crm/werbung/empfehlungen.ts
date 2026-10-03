import type { TFunction } from 'i18next'
import type { AdAgg, AdCatalogRow, AdRecommendation } from '../../../lib/crmTypes'
import type { WerbeFormat } from './format'

// ── Empfehlungen (Regel-Engine des Statistik-Reiters) ────────────────────────
// Reine Funktion über den geladenen Zeitraum, unverändert aus AdsManager.tsx
// übernommen: gleiche Regeln, gleiche Schwellen, gleiche Texte. Keine
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
  t: TFunction
  fmt: WerbeFormat
}

export function berechneEmpfehlungen({ catalog, byAd, vorgemerkt, targetCpl, crmVisible, t, fmt }: EmpfehlungEingabe): AdRecommendation[] {
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

    // Bezahlte Klicks, die nie auf der Seite ankommen. Meta zählt beides
    // getrennt: „Outbound Clicks" sind die Klicks weg von Meta, „Landing Page
    // Views" die Seiten, die wirklich geladen haben. Die Lücke ist verlorenes
    // Geld und liegt fast immer an der Ladezeit der Zielseite.
    if (a.outboundClicks >= 40) {
      const arrived = a.landingPageViews / a.outboundClicks
      if (arrived < 0.7) {
        hints.push({
          ad: c, kind: 'lp_loss', spend: a.spendEur,
          reason: t('crm.ads.recReasonLpLoss', 'Nur {{arrived}} der Klicks erreichen die Seite ({{lpv}} von {{clicks}}) - der Rest bricht beim Laden ab', {
            arrived: pct(arrived), lpv: int(a.landingPageViews), clicks: int(a.outboundClicks),
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
