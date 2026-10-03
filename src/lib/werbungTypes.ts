// ── Werbung: Autopilot, Qualität, Vorrat ─────────────────────────────────────
// Zeilentypen für ad_settings-Autopilot-Felder, ad_quality_daily,
// ad_autopilot_rules/-log/-runs, die erweiterte ad_actions, ad_creative_pool,
// ad_entity_snapshot und ad_ev_weights. Spalten wie in den Migrationen
// 20261003100000_werbung_fundament.sql und 20261003110000_werbe_autopilot.sql.
// Wird über crmTypes.ts re-exportiert (export * from './werbungTypes').
//
// Spalten mit CHECK-Liste stehen hier als Union UND werden im Code trotzdem als
// string gelesen, wo künftig mehr Werte möglich sind: unbekannte Werte immer
// neutral anzeigen (Lehre 26.9., Live-Bundle-Enum-Crash). numeric kommt von
// PostgREST meist als Zahl, im Zweifel mit Number() lesen.

/** Betriebsart des Autopiloten (ad_settings.autopilot_mode), aufsteigend */
export type WerbeAutopilotModus = 'aus' | 'schatten' | 'vorschlag' | 'ein_klick' | 'autonom'

/** Reihenfolge der Betriebsarten (Index = Stufe, höher = mehr Automatik) */
export const WERBE_AUTOPILOT_MODI: readonly WerbeAutopilotModus[] = ['aus', 'schatten', 'vorschlag', 'ein_klick', 'autonom']

/** Freigabestufe einer Regel: 0 aus, 1 Vorschlag, 2 Ein-Klick, 3 autonom */
export type WerbeFreigabeStufe = 0 | 1 | 2 | 3

/** Automatische Vorrats-Freigabe (ad_settings.pool_auto_release_level) */
export type WerbeVorratFreigabeStufe = 0 | 1 | 2 | 3

// ── ad_settings: Autopilot- und Assistenten-Felder ──────────────────────────
export interface WerbeAutopilotEinstellungen {
  id: string
  /** EUR je Tag, Summe aktiver Tagesbudgets (Leitplanke, Standard 250) */
  max_account_daily_budget: number | null
  autopilot_mode: string
  autopilot_paused_until: string | null
  autopilot_stop_grund: string | null
  /** Ziel-Kosten pro Termin-Äquivalent in EUR (Standard 145) */
  target_cpte_eur: number | null
  /** Monatsdeckel in EUR (Standard 7500) */
  monthly_cap_eur: number | null
  max_auto_actions_per_day: number | null
  kap_floor: number | null
  /** ISO-Wochentage der Änderungsfenster (1 = Montag), Standard {1,4} */
  change_window_dows: number[] | null
  builder_enabled: boolean | null
  capi_echtzeit: boolean | null
  pool_auto_release_level: number | null
  pool_auto_release_threshold: number | null
  budget_autonomie_freigegeben_at: string | null
  budget_autonomie_von: string | null
  updated_at?: string | null
}

// ── ad_quality_daily ─────────────────────────────────────────────────────────
/** Fenster in Tagen; 0 = Lebenszeit (höchstens 365 Tage) */
export type WerbeQualitaetFenster = 0 | 7 | 14 | 30 | 60
/** Ebene: Anzeige, Kennung (Anzeigenname ohne _lang/_kurz), Anzeigengruppe, Kampagne, Konto */
export type WerbeQualitaetEbene = 'ad' | 'kennung' | 'adset' | 'campaign' | 'account'

export interface WerbeQualitaetZeile {
  stichtag: string
  fenster: number
  entity_level: string
  /** Kennung: campaign_id + ':' + Basisname; Konto: Werbekonto-ID */
  entity_id: string
  parent_id: string | null
  campaign_id: string | null
  name: string | null
  spend_eur: number
  impressions: number | null
  link_clicks: number | null
  lpv: number | null
  meta_schedules: number | null
  leads: number | null
  leads_kap_ja: number | null
  leads_mit_anzeige: number | null
  booked: number | null
  booked_kap_ja: number | null
  held: number | null
  no_show: number | null
  rated_gut: number | null
  rated_schlecht: number | null
  sales: number | null
  /** Termin-Äquivalente, Sale je Lead gedeckelt (Grundlage der Entscheidungen) */
  te_capped: number | null
  te_full: number | null
  prior_cpte: number | null
  alpha: number | null
  beta: number | null
  /** Geschätzte Kosten pro TE (beta / alpha) */
  cpte_hat: number | null
  /** P(Kosten pro TE > 2 x Ziel) */
  p_bad: number | null
  /** P(Kosten pro TE < Ziel) */
  p_good: number | null
  kap_ja_share_booked: number | null
  /** Anteil der Leads mit erkannter Anzeige (0..1); < 0,8 = keine autonomen Kills */
  attribution_coverage: number | null
  ev_version: number | null
  berechnet_at: string
}

// ── ad_ev_weights (Wertleiter) ──────────────────────────────────────────────
export interface WerbeEvGewichte {
  version: number
  status: string
  /** Schlüssel wie lead_kap_ja, gebucht, gehalten, gut, te_cap */
  weights: Record<string, number>
  ev_ref_eur: number | null
  te_cap_per_lead: number
  quelle: string
  gueltig_ab: string | null
  created_at: string
}

// ── ad_autopilot_rules ──────────────────────────────────────────────────────
/** Aktion einer Regel; 'meldung' = nur Hinweis, nie ein Meta-Schreibzugriff */
export type WerbeRegelAktion = 'pause' | 'activate' | 'budget_set' | 'ersatz_hochladen' | 'ersatz_aktivieren' | 'meldung'

export interface WerbeRegel {
  rule_key: string
  titel: string
  /** WerbeRegelAktion, als string gelesen */
  aktion: string
  enabled: boolean
  approval_level: number
  max_level: number
  /** 'admin' | 'werbung': wer Vorschläge dieser Regel freigeben darf */
  freigabe_rolle: string
  params: Record<string, unknown>
  version: number
  updated_by: string | null
  updated_at: string
}

// ── ad_actions (erweitert für den Autopiloten) ──────────────────────────────
/** Lebenslauf eines Autopilot-Vorschlags (ad_actions.freigabe) */
export type WerbeFreigabe = 'vorgeschlagen' | 'freigegeben' | 'autonom' | 'verworfen' | 'abgelaufen' | 'veraltet'

/** Begründung eines Vorschlags (ad_actions.evidence, werbeRegeln.ts Evidenz) */
export interface WerbeEvidenz {
  fenster?: number
  spend_eur?: number
  te?: number
  alpha?: number
  beta?: number
  p_bad?: number
  p_good?: number
  frequency_7d?: number
  ctr_ratio?: number
  cpm_ratio?: number
  hook_ratio?: number
  coverage?: number | null
  /** USD je EUR zum Zeitpunkt des Vorschlags */
  fx?: number
  regeln?: string[]
  details?: Record<string, unknown>
  grund?: string | null
  [k: string]: unknown
}

export interface WerbeAktion {
  id: string
  platform?: string | null
  /** null bei Zeilen auf Anzeigengruppen-/Kampagnen-Ebene */
  ad_id: string | null
  ad_name: string | null
  campaign_name: string | null
  /** pause | activate | budget_set | ersatz_hochladen | ersatz_aktivieren (string: unbekannt neutral) */
  action: string
  reason: string | null
  /** null = Vorschlag; sonst bestätigt | ausgeführt | fehlgeschlagen | abgelehnt */
  status: string | null
  created_at: string
  executed_at: string | null
  result: string | null
  created_by?: string | null
  /** 'manuell' | 'autopilot' */
  origin: string
  /** 'ad' | 'adset' | 'campaign' */
  entity_level: string
  entity_id: string | null
  gruppe_id: string | null
  payload: Record<string, unknown> | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  readback: Record<string, unknown> | null
  rule_key: string | null
  rule_version: number | null
  evidence: WerbeEvidenz | null
  approval_level: number | null
  /** WerbeFreigabe, als string gelesen */
  freigabe: string | null
  approved_by: string | null
  approved_at: string | null
  expires_at: string | null
  window_date: string | null
  idempotency_key: string | null
  pre_state_hash: string | null
  claimed_at: string | null
  undo_of: string | null
}

// ── ad_autopilot_log (nur anhängen) ─────────────────────────────────────────
export type WerbeLogArt =
  | 'schatten' | 'vorschlag' | 'freigabe' | 'ablehnung' | 'ausfuehrung' | 'ruecklesen' | 'stopp'
  | 'einstellung' | 'regel_aenderung' | 'kalibrierung' | 'vorrat' | 'manuell_erkannt'
  | 'bewertung' | 'fehler' | 'replay'

export const WERBE_LOG_ARTEN: readonly WerbeLogArt[] = [
  'schatten', 'vorschlag', 'freigabe', 'ablehnung', 'ausfuehrung', 'ruecklesen', 'stopp',
  'einstellung', 'regel_aenderung', 'kalibrierung', 'vorrat', 'manuell_erkannt', 'bewertung', 'fehler', 'replay',
]

/** Urteil zu einem Schatten-/Vorschlags-Eintrag (werbe_schatten_bewerten) */
export type WerbeUrteil = 'richtig' | 'falsch' | 'unklar'

export interface WerbeLogEintrag {
  id: number
  ts: string
  lauf_id: string | null
  /** WerbeLogArt, als string gelesen */
  art: string
  rule_key: string | null
  rule_version: number | null
  modus: string | null
  approval_level: number | null
  entity_level: string | null
  entity_id: string | null
  entity_name: string | null
  aktion: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  evidence: WerbeEvidenz | null
  readback: Record<string, unknown> | null
  meta_response: Record<string, unknown> | null
  /** z.B. ok, fehler, freigegeben, verworfen, abgelaufen, richtig/falsch (bei bewertung) */
  ergebnis: string | null
  action_id: string | null
  gruppe_id: string | null
  bezug_log_id: number | null
  undo_of: string | null
  idempotency_key: string | null
  akteur: string | null
  /** 'system' | 'mensch' */
  akteur_art: string
}

// ── ad_autopilot_runs (Ablauf-Ledger der Nachtkette) ────────────────────────
export type WerbeLaufSchritt = 'sync' | 'qualitaet' | 'regeln' | 'fenster' | 'kalibrieren' | 'woche'
export type WerbeLaufStatus = 'laeuft' | 'fertig' | 'fehler' | 'uebersprungen'

export interface WerbeLauf {
  id: string
  lauf_datum: string
  /** WerbeLaufSchritt, als string gelesen */
  schritt: string
  /** WerbeLaufStatus, als string gelesen */
  status: string
  started_at: string
  finished_at: string | null
  summary: Record<string, unknown> | null
  fehler: string | null
}

// ── ad_creative_pool (Werbemittel-Vorrat) ───────────────────────────────────
export type WerbeVorratStatus =
  | 'entwurf' | 'geprueft' | 'freigegeben' | 'hochgeladen' | 'aktiv'
  | 'ermuedet' | 'gekillt' | 'pausiert' | 'verworfen'

export interface WerbeVorratEintrag {
  id: string
  /** ASCII-Slug = Anzeigenname ohne _lang/_kurz */
  kennung: string
  /** WerbeVorratStatus, als string gelesen */
  status: string
  winkel: string | null
  hook_typ: string | null
  /** 'bild' | 'video' | 'karussell' */
  format: string | null
  visual_typ: string | null
  cta: string | null
  lp_url: string | null
  laender: string[] | null
  texte: Record<string, unknown>
  asset_feed_url: string | null
  asset_story_url: string | null
  video_feed_id: string | null
  video_story_id: string | null
  ki_generiert: boolean
  ki_label: boolean
  eu_band: boolean
  fakten_pruefung: boolean
  qa: Record<string, unknown> | null
  review_score: number | null
  housing_ok: boolean | null
  brief: Record<string, unknown> | null
  quelle: string | null
  kosten_credits: number | null
  /** 'freigegeben' | 'abgelehnt' */
  entscheidung: string | null
  entscheidung_grund: string | null
  entschieden_von: string | null
  entschieden_at: string | null
  /** Wahrscheinlichkeit, dass Sven freigibt (0..1) */
  prognose: number | null
  merkmale: Record<string, unknown> | null
  released_by: string | null
  released_at: string | null
  ziel_adset_ids: string[] | null
  meta_image_hashes: Record<string, unknown> | null
  meta_creative_id: string | null
  meta_ad_ids: Record<string, string> | null
  hochgeladen_at: string | null
  aktiv_seit: string | null
  beendet_at: string | null
  ersetzt_kennung: string | null
  created_at: string
  updated_at: string
}

// ── ad_entity_snapshot (Tagesstand je Kampagne/Anzeigengruppe/Anzeige) ──────
export interface WerbeEntitySnapshot {
  snap_date: string
  /** 'campaign' | 'adset' | 'ad' */
  entity_level: string
  entity_id: string
  parent_id: string | null
  campaign_id: string | null
  name: string | null
  status: string | null
  effective_status: string | null
  /** USD-Cent */
  daily_budget_cents: number | null
  lifetime_budget_cents: number | null
  spend_cap_cents: number | null
  optimization_goal: string | null
  promoted_object: Record<string, unknown> | null
  special_ad_categories: string[] | null
  learning_stage_info: Record<string, unknown> | null
  issues_info: unknown
  ad_review_feedback: Record<string, unknown> | null
  creative_id: string | null
  updated_time: string | null
  reach_7d: number | null
  impressions_7d: number | null
  frequency_7d: number | null
  video_3s_7d: number | null
  link_clicks_7d: number | null
  spend_7d_usd: number | null
  quality_ranking: string | null
  engagement_rate_ranking: string | null
  conversion_rate_ranking: string | null
  usd_per_eur: number | null
  synced_at: string
}

// ── Antworten der RPCs und von werbe-ausfuehren ─────────────────────────────
/** werbe_vorschlag_entscheiden */
export interface WerbeEntscheidAntwort {
  success: boolean
  /** bei success=false: keine_offenen_vorschlaege | abgelaufen */
  grund?: string
  entscheidung?: 'freigegeben' | 'verworfen'
  anzahl?: number
  gruppe_id?: string
}

/** werbe_autopilot_stopp */
export interface WerbeStoppAntwort { success: boolean; vorher?: string | null; storniert?: number }

/** werbe-ausfuehren (freigabe, rueckgaengig, fenster, validieren) */
export interface WerbeAusfuehrAntwort {
  success?: boolean
  ausgefuehrt?: number
  fehlgeschlagen?: number
  uebersprungen?: Array<{ id: string; grund: string }>
  gestoppt?: string
  abgebrochen?: string
  error?: string
}
