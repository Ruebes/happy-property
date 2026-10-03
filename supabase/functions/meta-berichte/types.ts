// meta-berichte: Anfrage- und Antworttypen (rein, keine Imports, kein Deno).
//
// Vertrag 2 aus SPEC2 (Kampagnen-Zentrale / Berichte). Das Frontend darf diese
// Datei 1:1 spiegeln (z. B. als src/lib/metaBerichte.ts), sie kompiliert unter
// Deno und unter der src-tsconfig (strict, ES2020).
//
// Anfrage: POST { mode, ...felder }. Fehler: { error, hint?, code?, meta? }.
// Geldbeträge: Kontowährung USD (spend, cpm, ...) plus *_eur über den Wechselkurs
// aus ad_insights_daily (Fallback 1,14 USD je EUR).

export const BERICHTE_MODES = ['insights', 'activities', 'status', 'empfehlungen'] as const
export type BerichteMode = typeof BERICHTE_MODES[number]

export const BERICHT_LEVELS = ['account', 'campaign', 'adset', 'ad'] as const
export type BerichtLevel = typeof BERICHT_LEVELS[number]

export const BERICHT_LEVEL_LABELS: Record<BerichtLevel, string> = {
  account: 'Werbekonto',
  campaign: 'Kampagne',
  adset: 'Anzeigengruppe',
  ad: 'Werbeanzeige',
}

// ── Aufschlüsselungen ────────────────────────────────────────────────────────

export const BREAKDOWNS = [
  'age', 'gender', 'country', 'region',
  'publisher_platform', 'platform_position', 'impression_device',
  'body_asset', 'title_asset', 'image_asset', 'video_asset',
  'hourly_stats_aggregated_by_advertiser_time_zone',
] as const
export type Breakdown = typeof BREAKDOWNS[number]

/** Deutsche Bezeichnungen wie im Werbeanzeigenmanager (Menü „Aufschlüsselung“). */
export const BREAKDOWN_LABELS: Record<Breakdown, string> = {
  age: 'Alter',
  gender: 'Geschlecht',
  country: 'Land',
  region: 'Region',
  publisher_platform: 'Plattform',
  platform_position: 'Platzierung',
  impression_device: 'Gerät der Impression',
  body_asset: 'Text',
  title_asset: 'Überschrift',
  image_asset: 'Bild',
  video_asset: 'Video',
  hourly_stats_aggregated_by_advertiser_time_zone: 'Tageszeit (Zeitzone des Werbekontos)',
}

/**
 * Erlaubte Kombinationen (eine Gruppe je Anfrage):
 *   demografie  age und/oder gender
 *   geo         genau eins von country, region
 *   plattform   publisher_platform [+ platform_position] [+ impression_device]
 *               (platform_position ergänzt publisher_platform automatisch)
 *   element     genau eins von body_asset, title_asset, image_asset, video_asset,
 *               optional mit age und/oder gender; nur Ebene adset oder ad
 *   zeit        hourly_stats_aggregated_by_advertiser_time_zone allein (ohne Reichweite/Frequenz)
 */
export type BreakdownGruppe = 'demografie' | 'geo' | 'plattform' | 'element' | 'zeit'

export type TimeIncrement = 1 | 7 | 'monthly' | 'all_days'
export const TIME_INCREMENT_LABELS: Record<string, string> = {
  '1': 'Tag', '7': 'Woche', monthly: 'Monat', all_days: 'Gesamter Zeitraum',
}

export const FELDER_PRESETS = ['standard', 'video', 'gebote'] as const
export type FelderPreset = typeof FELDER_PRESETS[number]
export const FELDER_PRESET_LABELS: Record<FelderPreset, string> = {
  standard: 'Performance',
  video: 'Videointeraktion',
  gebote: 'Gebote und Optimierung',
}

/** Was als „Ergebnis“ zählt (Kosten pro Ergebnis). Standard leads. */
export const ERGEBNIS_ARTEN = ['leads', 'schedule', 'landing_page_view', 'link_click', 'thruplay'] as const
export type ErgebnisArt = typeof ERGEBNIS_ARTEN[number]
export const ERGEBNIS_LABELS: Record<ErgebnisArt, string> = {
  leads: 'Leads',
  schedule: 'Termine (Schedule)',
  landing_page_view: 'Zielseitenaufrufe',
  link_click: 'Link-Klicks',
  thruplay: 'ThruPlays',
}

// ── Gemeinsam ────────────────────────────────────────────────────────────────

export interface Zeitraum { since: string; until: string }

export interface BerichtUsage {
  /** höchste bekannte Meta-Auslastung in Prozent */
  accUtilPct: number
  resetSec: number
  tier: string | null
}

// ── insights ─────────────────────────────────────────────────────────────────

export interface InsightsRequest {
  mode?: 'insights'
  level: BerichtLevel
  /** IDs der gewählten Ebene (höchstens 50) */
  ids?: string[]
  /** nur Zeilen dieser Kampagne */
  campaign_id?: string
  since: string
  until: string
  compare?: Zeitraum
  breakdowns?: Breakdown[]
  /** Standard 'all_days' */
  time_increment?: TimeIncrement
  /** Standard 'standard' */
  felder?: FelderPreset
  /** Standard 'leads' */
  ergebnis?: ErgebnisArt
  /** true: Zwischenspeicher übergehen (Aktualisieren-Knopf) */
  frisch?: boolean
}

export interface AssetInfo {
  art: 'body' | 'title' | 'image' | 'video'
  id: string | null
  text: string | null
  url: string | null
  hash: string | null
  video_id: string | null
  thumbnail_url: string | null
  name: string | null
}

/** Additive Zählwerte und daraus abgeleitete Kennzahlen (gemeinsam für Zeile und Summe). */
export interface BerichtKennzahlen {
  /** Kontowährung (USD) */
  spend: number
  spend_eur: number
  impressions: number
  /** Reichweite; null bei stündlicher Aufschlüsselung oder in Summen über mehrere Zeilen */
  reach: number | null
  frequency: number | null
  /** Klicks (alle) */
  clicks: number
  link_click: number
  outbound_click: number
  landing_page_view: number
  leads: number
  schedule: number
  /** 3-Sekunden-Videoaufrufe (action_type video_view) */
  video_view: number
  thruplay: number
  /** nur Preset video, sonst null */
  video_p25: number | null
  video_p50: number | null
  video_p75: number | null
  video_p95: number | null
  video_p100: number | null
  video_play: number | null
  /** durchschnittliche Wiedergabezeit in Sekunden (nur Preset video, in Summen null) */
  video_avg_time_s: number | null
  /** nur Preset gebote, sonst null */
  unique_clicks: number | null
  unique_link_clicks: number | null
  /** Klickrate (alle) in Prozent */
  ctr: number | null
  /** Link-Klickrate in Prozent */
  ctr_link: number | null
  /** Kosten pro 1.000 Impressionen */
  cpm: number | null
  cpm_eur: number | null
  /** Kosten pro Link-Klick */
  cpc_link: number | null
  cpc_link_eur: number | null
  ergebnis_art: ErgebnisArt
  results: number
  cost_per_result: number | null
  cost_per_result_eur: number | null
  cost_per_lead: number | null
  cost_per_lead_eur: number | null
  cost_per_schedule: number | null
  cost_per_schedule_eur: number | null
  cost_per_landing_page_view: number | null
  cost_per_landing_page_view_eur: number | null
  /** Hook-Rate: 3-Sek.-Aufrufe je Impression in Prozent */
  hook_rate: number | null
  /** Zielseitenaufrufe je Link-Klick in Prozent */
  lpv_rate: number | null
  /** Leads je Link-Klick in Prozent */
  lead_rate: number | null
}

/**
 * Zusätzlich stehen die Werte der angefragten Aufschlüsselungen wie bei Meta auf
 * oberster Ebene der Zeile (z. B. age: '25-34', publisher_platform: 'instagram',
 * body_asset: AssetInfo).
 */
export interface BerichtZeile extends BerichtKennzahlen, Partial<Record<Breakdown, string | AssetInfo | null>> {
  date_start: string | null
  date_stop: string | null
  account_id: string | null
  campaign_id: string | null
  campaign_name: string | null
  adset_id: string | null
  adset_name: string | null
  ad_id: string | null
  ad_name: string | null
  /** Rohwerte der Aufschlüsselung (Assets: ID) */
  breakdown: Partial<Record<Breakdown, string | null>>
  /** lesbar, z. B. "25-34, Weiblich" oder "Instagram, Reels" */
  breakdown_label: string | null
  asset: AssetInfo | null
  currency: string
  /** Attributionseinstellung laut Meta (nur Preset gebote) */
  attribution_setting: string | null
  /** alle action_type-Werte roh (für eigene Kennzahlen/Formeln) */
  actions: Record<string, number>
}

export type BerichtSumme = BerichtKennzahlen & { zeilen: number }

export interface VergleichWert { aktuell: number | null; vorher: number | null; absolut: number | null; prozent: number | null }

export interface InsightsResponse {
  rows: BerichtZeile[]
  compare_rows?: BerichtZeile[]
  totals: BerichtSumme
  compare_totals?: BerichtSumme
  /** Veränderung Vergleichszeitraum -> Zeitraum je Kennzahl */
  vergleich?: Record<string, VergleichWert>
  /** true, wenn alles aus dem Zwischenspeicher kam */
  cached: boolean
  fetched_at: string
  compare_fetched_at?: string
  currency: string
  usd_per_eur: number
  kurs_quelle: 'insights_7d' | 'fallback'
  /** Meta-Daten unvollständig (Auslastung > 75 % oder Seitenlimit) */
  unvollstaendig: boolean
  /** älterer Zwischenspeicher, weil Meta gerade gedrosselt ist */
  veraltet: boolean
  hinweise: string[]
  usage: BerichtUsage | null
}

// ── activities ───────────────────────────────────────────────────────────────

export interface ActivitiesRequest {
  mode?: 'activities'
  since: string
  until: string
  /** nur dieses Objekt (Kampagne, Anzeigengruppe oder Anzeige) */
  object_id?: string
  frisch?: boolean
}

export type AktivitaetObjekt = 'account' | 'campaign' | 'adset' | 'ad' | 'audience' | 'sonstiges'

/** Filter „Aktivitäten-Arten“ im Aktivitätenverlauf */
export const AKTIVITAET_KATEGORIEN = [
  'Konto', 'Werbeanzeigen', 'Anzeigengruppen', 'Zielgruppe', 'Gebot', 'Budget',
  'Kampagnen', 'Status', 'Zeitplan', 'Targeting', 'Sonstiges',
] as const
export type AktivitaetKategorie = typeof AKTIVITAET_KATEGORIEN[number]

/** Filter „Geändert von“ (plus CRM und Autopilot aus dem eigenen Schreibprotokoll) */
export type GeaendertVon = 'Person' | 'Automatisierte Regel' | 'Business-Identität' | 'Meta' | 'CRM' | 'Autopilot'

export interface AktivitaetEintrag {
  ts: string
  actor: string
  object_type: AktivitaetObjekt
  object_type_label: string
  object_id: string | null
  object_name: string | null
  /** deutsche Bezeichnung des Ereignisses */
  event: string
  /** Rohwert: Meta event_type bzw. crm:<function>/<modus> */
  event_type: string
  kategorie: AktivitaetKategorie
  geaendert_von: GeaendertVon
  /** meta = nur Meta, crm = nur Schreibprotokoll, meta+crm = Meta-Eintrag einer CRM-Änderung */
  quelle: 'meta' | 'crm' | 'meta+crm'
  extra: Record<string, unknown> | null
}

export interface ActivitiesResponse {
  items: AktivitaetEintrag[]
  cached: boolean
  fetched_at: string
  veraltet: boolean
  unvollstaendig: boolean
  hinweise: string[]
}

// ── status ───────────────────────────────────────────────────────────────────

export interface StatusRequest {
  mode?: 'status'
  /** höchstens 100 IDs (Kampagnen, Anzeigengruppen, Anzeigen gemischt) */
  ids: string[]
  /** optional, spart Meta-Aufrufe */
  level?: 'campaign' | 'adset' | 'ad'
  frisch?: boolean
}

export type AuslieferungSymbol = 'aktiv' | 'inaktiv' | 'fehler' | 'warnung' | 'ausstehend'

export interface Auslieferung {
  /** Schlüssel, z. B. aktiv, lernphase, lernphase_beeintraechtigt, abgelehnt */
  key: string
  /** Bezeichnung wie in der Spalte „Auslieferung“ */
  label: string
  symbol: AuslieferungSymbol
}

export interface LernphaseInfo {
  /** LEARNING | SUCCESS | FAIL (Meta) */
  status: string | null
  status_label: string | null
  conversions: number | null
  /** letzte wesentliche Änderung (ISO) */
  last_sig_edit_ts: string | null
}

export interface MetaIssue { code: string | null; summary: string | null; message: string | null; level: string | null; type: string | null }

export interface StatusItem {
  id: string
  level: 'campaign' | 'adset' | 'ad' | null
  name: string | null
  effective_status: string | null
  configured_status: string | null
  auslieferung: Auslieferung
  learning: LernphaseInfo | null
  issues: MetaIssue[]
  review_feedback: Array<{ bereich: string; text: string }>
  /** meta = live gelesen, spiegel = aus dem CRM-Spiegel (letzter Sync), fehlt = nicht gefunden */
  quelle: 'meta' | 'spiegel' | 'fehlt'
}

export interface StatusResponse {
  items: StatusItem[]
  cached: boolean
  fetched_at: string
  veraltet: boolean
  hinweise: string[]
}

// ── empfehlungen ─────────────────────────────────────────────────────────────

export interface EmpfehlungenRequest {
  mode?: 'empfehlungen'
  /** nur Empfehlungen, die eines dieser Objekte betreffen */
  object_ids?: string[]
  frisch?: boolean
}

/** Kategorien der Potenzialbewertung im Werbeanzeigenmanager */
export type EmpfehlungKategorie =
  | 'Automatisierte Kampagnen' | 'Zielsetzung und Ziele' | 'Zielgruppe'
  | 'Anzeigengestaltung und Platzierungen' | 'Signale' | 'Budget und Gebote' | 'Sonstiges'

export interface Empfehlung {
  signatur: string | null
  /** Meta type bzw. recommendation_name */
  typ: string
  titel: string
  kategorie: EmpfehlungKategorie
  stufe: string | null
  ebene: string | null
  object_ids: string[]
  lift_estimate: string | null
  text: string | null
  /** erwartete Punkte für die Potenzialbewertung */
  punkte: number | null
  zeit: string | null
  /** Direktlink in den Werbeanzeigenmanager (nur lesen, das CRM wendet nichts an) */
  url: string | null
  /** Einordnung nach Happy-Property-Regeln, z. B. KI-Funktionen standardmäßig aus */
  hp_hinweis: string | null
}

export interface EmpfehlungenResponse {
  /** Potenzialbewertung 0-100, null wenn Meta keine liefert */
  opportunity_score: number | null
  items: Empfehlung[]
  cached: boolean
  fetched_at: string
  veraltet: boolean
  hinweise: string[]
}

export interface BerichteRequestMap {
  insights: InsightsRequest
  activities: ActivitiesRequest
  status: StatusRequest
  empfehlungen: EmpfehlungenRequest
}
export interface BerichteResponseMap {
  insights: InsightsResponse
  activities: ActivitiesResponse
  status: StatusResponse
  empfehlungen: EmpfehlungenResponse
}

export const BERICHTE_ERROR_CODES = [
  'invalid_request', 'rate_limited', 'meta_error', 'meta_auth', 'unauthorized', 'forbidden', 'internal',
] as const
export type BerichteErrorCode = typeof BERICHTE_ERROR_CODES[number]
