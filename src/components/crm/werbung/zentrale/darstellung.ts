import type { TFunction } from 'i18next'
import { metaLabel, type WerbeFormat } from '../format'
import type { SpaltenFormat } from './spalten'
import { auslieferungVon, lernStatus, problemText } from './status'
import type { Ebene, Knoten } from './typen'

// ── Anzeige-Helfer der Zentrale (Zahlen, Budget, Lernphase, Texte) ───────────

export function formatWert(v: number | null | undefined, format: SpaltenFormat, fmt: WerbeFormat): string {
  if (v == null || !Number.isFinite(v)) return '-'
  switch (format) {
    case 'eur': return fmt.eur(v)
    case 'zahl': return fmt.int(Math.round(v))
    case 'dezimal': return v.toLocaleString(fmt.locale, { maximumFractionDigits: 2 })
    case 'prozent': return fmt.pct(v)
    case 'faktor': return `${v.toLocaleString(fmt.locale, { maximumFractionDigits: 2 })}×`
    default: return String(v)
  }
}

/** Veränderung gegenüber dem Vergleichszeitraum (Anteil, null wenn nicht sinnvoll) */
export function veraenderung(jetzt: number | null, vorher: number | null): number | null {
  if (jetzt == null || vorher == null || !Number.isFinite(jetzt) || !Number.isFinite(vorher)) return null
  if (vorher === 0) return jetzt === 0 ? 0 : null
  return (jetzt - vorher) / Math.abs(vorher)
}

export function ebeneLabel(level: Ebene, t: TFunction, mehrzahl = false): string {
  if (level === 'campaign') return mehrzahl ? t('crm.werbung.zentrale.ebene.kampagnen', 'Kampagnen') : t('crm.werbung.zentrale.ebene.kampagne', 'Kampagne')
  if (level === 'adset') return mehrzahl ? t('crm.werbung.zentrale.ebene.gruppen', 'Anzeigengruppen') : t('crm.werbung.zentrale.ebene.gruppe', 'Anzeigengruppe')
  return mehrzahl ? t('crm.werbung.zentrale.ebene.anzeigen', 'Werbeanzeigen') : t('crm.werbung.zentrale.ebene.anzeige', 'Werbeanzeige')
}

const usd = (cents: number, fmt: WerbeFormat) =>
  (cents / 100).toLocaleString(fmt.locale, { style: 'currency', currency: 'USD', maximumFractionDigits: cents >= 10_000 ? 0 : 2 })

/** Budget-Zelle: Haupttext (USD) + Euro-Hinweis */
export function budgetText(k: Knoten, kurs: number, t: TFunction, fmt: WerbeFormat): { haupt: string; sub: string | null } {
  if (k.level === 'ad') return { haupt: '-', sub: null }
  if (k.level === 'adset' && k.kampagnenbudget) {
    return { haupt: t('crm.werbung.zentrale.budget.kampagne', 'Budget der Kampagne'), sub: null }
  }
  const tag = k.budgetTagCents ?? 0
  const lauf = k.budgetLaufzeitCents ?? 0
  const eur = (c: number) => t('crm.werbung.zentrale.budget.eur', '≈ {{eur}}', { eur: fmt.eur(c / 100 / (kurs > 0 ? kurs : 1.14)) })
  if (tag > 0) return { haupt: t('crm.werbung.zentrale.budget.tag', '{{betrag}} / Tag', { betrag: usd(tag, fmt) }), sub: eur(tag) }
  if (lauf > 0) return { haupt: t('crm.werbung.zentrale.budget.laufzeit', '{{betrag}} Laufzeit', { betrag: usd(lauf, fmt) }), sub: eur(lauf) }
  if (k.level === 'campaign' && k.ausSpiegel) return { haupt: t('crm.werbung.zentrale.budget.gruppen', 'Budget der Anzeigengruppen'), sub: null }
  return { haupt: '-', sub: null }
}

/** Datum + „vor N Tagen" */
export function datumMitAbstand(iso: string | null | undefined, t: TFunction, fmt: WerbeFormat): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const tage = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  const datum = d.toLocaleDateString(fmt.locale, { day: '2-digit', month: '2-digit', year: '2-digit' })
  if (tage <= 0) return t('crm.werbung.zentrale.zeit.heuteAm', '{{datum}} (heute)', { datum })
  return t('crm.werbung.zentrale.zeit.vorTagen', '{{datum}} (vor {{n}} Tagen)', { datum, n: tage, count: tage })
}

/** Lernphasen-Text: „12 von 50 Ergebnissen", „Abgeschlossen", „Beeinträchtigt" */
export function lernText(k: Knoten, t: TFunction): string {
  const st = lernStatus(k.lernphase)
  if (st === 'LEARNING') {
    const n = k.lernphase?.conversions
    return typeof n === 'number'
      ? t('crm.werbung.zentrale.lern.laeuft', 'Läuft: {{n}} von 50 Ergebnissen', { n })
      : t('crm.werbung.zentrale.lern.laeuftKurz', 'Läuft')
  }
  if (st === 'SUCCESS') return t('crm.werbung.zentrale.lern.fertig', 'Abgeschlossen')
  if (st === 'FAIL') return t('crm.werbung.zentrale.lern.beeintraechtigt', 'Beeinträchtigt (zu wenige Ergebnisse)')
  return '-'
}

export const gebotText = (v: string | null, t: TFunction): string =>
  (v ? t(`crm.werbung.meta.bid.${v}`, metaLabel(v)) : '-')

export const zielText = (v: string | null, t: TFunction): string =>
  (v ? t(`crm.werbung.meta.goal.${v}`, metaLabel(v)) : '-')

/** Text einer Textspalte (für Anzeige, Sortierung und CSV) */
export function textWert(k: Knoten, key: string, kurs: number, t: TFunction, fmt: WerbeFormat): string {
  switch (key) {
    case 'auslieferung': { const a = auslieferungVon(k); return a.label.k ? t(a.label.k, a.label.d) : a.label.d }
    case 'lernphase': return k.level === 'ad' ? '-' : lernText(k, t)
    case 'letzte_aenderung': return k.level === 'ad' ? '-' : datumMitAbstand(k.lernphase?.last_sig_edit_ts, t, fmt)
    case 'budget': { const b = budgetText(k, kurs, t, fmt); return b.sub ? `${b.haupt} (${b.sub})` : b.haupt }
    case 'gebotsstrategie': return k.level === 'ad' ? '-' : gebotText(k.gebotsstrategie, t)
    case 'leistungsziel': return k.level === 'adset' ? zielText(k.leistungsziel, t) : '-'
    default: return ''
  }
}

/** Tooltip mit Problemen/Ablehnungsgründen */
export const problemeTitel = (k: Knoten): string | undefined => {
  const p = problemText(k.probleme)
  return p || undefined
}

// ── Aufschlüsselungs-Werte lesbar machen ─────────────────────────────────────

/** Deutsche Fallbacks (Keys crm.werbung.zentrale.pos.<wert>) */
export const POSITIONEN: Record<string, string> = {
  feed: 'Feed', facebook_reels: 'Reels', instagram_reels: 'Reels', facebook_stories: 'Stories', instagram_stories: 'Stories',
  story: 'Stories', marketplace: 'Marketplace', video_feeds: 'Video-Feeds', right_hand_column: 'Rechte Spalte',
  instagram_explore: 'Entdecken', instagram_explore_grid_home: 'Entdecken (Startseite)', search: 'Suchergebnisse',
  instream_video: 'In-Stream-Videos', facebook_reels_overlay: 'Reels-Overlay', profile_feed: 'Profil-Feed',
  instagram_profile_feed: 'Profil-Feed', an_classic: 'Native, Banner und Interstitial', rewarded_video: 'Rewarded Video',
  messenger_inbox: 'Messenger-Startseite', messenger_stories: 'Messenger-Stories', threads_feed: 'Threads-Feed',
  notification: 'Benachrichtigungen', biz_disco_feed: 'Business Explore', unknown: 'Unbekannt',
}

/** Deutsche Fallbacks (Keys crm.werbung.zentrale.geraet.<wert>) */
export const GERAETE: Record<string, string> = {
  iphone: 'iPhone', ipad: 'iPad', ipod: 'iPod', android_smartphone: 'Android-Smartphone', android_tablet: 'Android-Tablet',
  desktop: 'Desktop', other: 'Sonstige', unknown: 'Unbekannt',
}

export function schluesselLabel(b: string, wert: string | null, plattform: string | null, t: TFunction, locale: string): string {
  if (wert == null || wert === '') return t('crm.werbung.zentrale.auf.unbekannt', 'Unbekannt')
  switch (b) {
    case 'gender':
      if (wert === 'female') return t('crm.werbung.zentrale.auf.weiblich', 'Weiblich')
      if (wert === 'male') return t('crm.werbung.zentrale.auf.maennlich', 'Männlich')
      return t('crm.werbung.zentrale.auf.unbekannt', 'Unbekannt')
    case 'publisher_platform': return t(`crm.werbung.meta.platform.${wert}`, wert)
    case 'platform_position': {
      const pos = POSITIONEN[wert] ? t(`crm.werbung.zentrale.pos.${wert}`, POSITIONEN[wert]) : wert
      return plattform ? `${t(`crm.werbung.meta.platform.${plattform}`, plattform)} · ${pos}` : pos
    }
    case 'impression_device': return GERAETE[wert] ? t(`crm.werbung.zentrale.geraet.${wert}`, GERAETE[wert]) : wert
    case 'country': {
      try {
        const dn = new Intl.DisplayNames([locale], { type: 'region' })
        return dn.of(wert.toUpperCase()) ?? wert
      } catch {
        return wert
      }
    }
    case 'hourly_stats_aggregated_by_advertiser_time_zone': {
      const h = wert.slice(0, 2)
      const bis = String((Number(h) + 1) % 24).padStart(2, '0')
      return /^\d{2}$/.test(h) ? t('crm.werbung.zentrale.auf.stunde', '{{von}} bis {{bis}} Uhr', { von: h, bis }) : wert
    }
    default: return wert
  }
}
