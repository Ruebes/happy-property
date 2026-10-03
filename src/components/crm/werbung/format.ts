import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

// ── Werbemanager: Zahlen, Farben, Meta-Labels ────────────────────────────────
// Formatierer und Etiketten, die Statistik, Einstellungen und die neuen Reiter
// gemeinsam nutzen (vorher lokal in AdsManager.tsx).

export type WerbeLocale = 'en-US' | 'de-DE'

/** Zahlen-/Datumsformat zur UI-Sprache (wie bisher im Werbemanager) */
export const werbeLocale = (lang: string | undefined): WerbeLocale => (lang?.startsWith('en') ? 'en-US' : 'de-DE')

export interface WerbeFormat {
  locale: WerbeLocale
  /** Euro, ab 100 ohne Nachkommastellen */
  eur: (v: number) => string
  int: (v: number) => string
  /** Anteil 0..1 als Prozent mit einer Nachkommastelle */
  pct: (v: number) => string
  /** Kosten je Stück (spend / n), '-' wenn n = 0 */
  per: (spend: number, n: number) => string
}

export function werbeFormat(locale: WerbeLocale): WerbeFormat {
  const eur = (v: number) => v.toLocaleString(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: v >= 100 ? 0 : 2 })
  const int = (v: number) => v.toLocaleString(locale)
  const pct = (v: number) => `${(v * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`
  const per = (spend: number, n: number) => (n > 0 ? eur(spend / n) : '-')
  return { locale, eur, int, pct, per }
}

/** Formatierer zur aktuellen UI-Sprache (stabil, solange die Sprache gleich bleibt) */
export function useWerbeFormat(): WerbeFormat {
  const { i18n } = useTranslation()
  const locale = werbeLocale(i18n.language)
  return useMemo(() => werbeFormat(locale), [locale])
}

// Kategorische Chart-Farben: feste Reihenfolge, validiert (Kontrast + Farbfehlsicht)
export const CHART_COLORS = ['#e8590c', '#3b5bdb', '#0ca678', '#b08800', '#9c36b5', '#0891b2']
export const colorFor = (i: number) => CHART_COLORS[i % CHART_COLORS.length]

// ── Meta-Enums -> lesbare deutsche Labels (unbekannte Werte werden roh gezeigt)
export const META_LABELS: Record<string, string> = {
  OUTCOME_LEADS: 'Leads', OUTCOME_SALES: 'Umsatz', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_AWARENESS: 'Bekanntheit', OUTCOME_ENGAGEMENT: 'Interaktionen',
  ACTIVE: 'Aktiv', PAUSED: 'Pausiert', CAMPAIGN_PAUSED: 'Pausiert (Kampagne)', ADSET_PAUSED: 'Pausiert (Anzeigengruppe)', IN_PROCESS: 'In Prüfung', WITH_ISSUES: 'Mit Problemen', PENDING_REVIEW: 'In Prüfung', DISAPPROVED: 'Abgelehnt',
  LOWEST_COST_WITHOUT_CAP: 'Niedrigste Kosten (automatisch)', LOWEST_COST_WITH_BID_CAP: 'Gebotsobergrenze', COST_CAP: 'Kostenobergrenze',
  OFFSITE_CONVERSIONS: 'Conversions (Website)', LINK_CLICKS: 'Link-Klicks', LEAD_GENERATION: 'Lead-Formulare', REACH: 'Reichweite', LANDING_PAGE_VIEWS: 'Landingpage-Aufrufe',
  IMPRESSIONS: 'Impressionen', AUCTION: 'Auktion',
  LEAD: 'Lead', SCHEDULE: 'Termin (Schedule)', PURCHASE: 'Kauf',
}
export const metaLabel = (v: unknown): string => (v == null ? '-' : META_LABELS[String(v)] ?? String(v))

// Status-Badge je Anzeige: Meta-Status auf Svens Kategorien (Aktiv / Offline /
// Entwurf …) abbilden. Rückgabe: i18n-Key (k) + Fallback (d) + Tailwind-Klassen.
// Unbekannte Werte: neutral grau mit dem Rohwert.
export const AD_STATUS_BADGE = (status: string | null | undefined): { k: string; d: string; cls: string } => {
  const s = (status ?? '').toUpperCase()
  if (s === 'ACTIVE') return { k: 'crm.ads.stActive', d: 'Aktiv', cls: 'bg-green-100 text-green-700' }
  if (['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(s)) return { k: 'crm.ads.stOffline', d: 'Offline', cls: 'bg-gray-200 text-gray-600' }
  if (['IN_PROCESS', 'PENDING_REVIEW', 'PENDING_BILLING_INFO'].includes(s)) return { k: 'crm.ads.stReview', d: 'In Prüfung', cls: 'bg-amber-100 text-amber-700' }
  if (['DISAPPROVED', 'WITH_ISSUES'].includes(s)) return { k: 'crm.ads.stRejected', d: 'Abgelehnt', cls: 'bg-red-100 text-red-700' }
  if (['DRAFT', 'PREAPPROVED'].includes(s)) return { k: 'crm.ads.stDraft', d: 'Entwurf', cls: 'bg-blue-100 text-blue-700' }
  if (s === 'ARCHIVED') return { k: 'crm.ads.stArchived', d: 'Archiviert', cls: 'bg-gray-100 text-gray-500' }
  return { k: '', d: s || '-', cls: 'bg-gray-100 text-gray-500' }
}

// ── Aktionen aus ad_actions (Warteschlange und Verlauf) ──────────────────────
// Nur pause/activate haben eigene Symbole; alles andere (Autopilot-Aktionen,
// künftige Werte) erscheint neutral und nie als „Aktiviert".

/** Symbol einer Aktion */
export const aktionIcon = (action: string | null | undefined): string =>
  action === 'pause' ? '⏸' : action === 'activate' ? '▶' : action === 'budget_set' ? '💶' : '•'

/** Etikett einer ausgeführten Aktion: i18n-Key (k) + Fallback (d); unbekannt = Rohwert ohne Key */
export const aktionErledigt = (action: string | null | undefined): { k: string; d: string } => {
  switch (action) {
    case 'pause': return { k: 'crm.ads.actPaused', d: 'Pausiert' }
    case 'activate': return { k: 'crm.ads.actActivated', d: 'Aktiviert' }
    case 'budget_set': return { k: 'crm.werbung.common.aktionBudget', d: 'Budget geändert' }
    case 'ersatz_hochladen': return { k: 'crm.werbung.common.aktionErsatzHochladen', d: 'Ersatz hochgeladen' }
    case 'ersatz_aktivieren': return { k: 'crm.werbung.common.aktionErsatzAktivieren', d: 'Ersatz aktiviert' }
    default: return { k: '', d: action || '-' }
  }
}

/** Statuswerte, die die Aktions-Liste zeigt (null = Autopilot-Vorschlag, gehört nicht hierher) */
export const AKTION_SICHTBAR = new Set(['bestätigt', 'ausgeführt', 'fehlgeschlagen'])
