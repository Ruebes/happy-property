// ── Kampagnen-Zentrale: gemeinsame Typen ─────────────────────────────────────
// Baum Kampagne > Anzeigengruppe > Anzeige, Kennzahlen je Zeile, Spiegel-
// Zeilen (meta_campaigns, meta_adsets, ad_catalog) und die Antworten der Edge
// Function meta-berichte (normalisiert in berichteApi.ts). Nur für den Ordner
// zentrale/; Zeilentypen der Datenbank, die andere Reiter brauchen, stehen in
// werbungTypes.ts bzw. crmTypes.ts.

/** Ebene bei Meta (gleiche Werte wie in meta-builder und meta-berichte) */
export type Ebene = 'campaign' | 'adset' | 'ad'

/** Basis-Kennzahlen einer Zeile. Abgeleitete Spalten (CTR, CPM, ...) rechnet
 *  spalten.ts daraus. Geld in EUR (umgerechnet), Zählwerte als Zahl. */
export type BasisFeld =
  | 'ausgaben' | 'impressionen' | 'reichweite' | 'link_klicks' | 'klicks_alle' | 'ausgehende_klicks' | 'lpv'
  | 'meta_leads' | 'ergebnisse' | 'termine_meta'
  | 'video_3s' | 'thruplays' | 'video_25' | 'video_50' | 'video_75' | 'video_95' | 'video_100'
  | 'beitrags_interaktionen' | 'reaktionen' | 'kommentare' | 'geteilt' | 'gespeichert'
  | 'crm_leads' | 'termine' | 'stattgefunden' | 'no_shows' | 'gut' | 'schlecht' | 'sales' | 'umsatz'

export type Werte = Partial<Record<BasisFeld, number>>

/** Spiegel einer Kampagne (meta_campaigns, Auszug) */
export interface SpiegelKampagne {
  campaign_id: string
  name: string | null
  objective: string | null
  status: string | null
  effective_status: string | null
  daily_budget_cents: number | null
  lifetime_budget_cents: number | null
  bid_strategy: string | null
  special_ad_categories: string[] | null
  stop_time: string | null
  created_time: string | null
  issues: unknown
}

/** Spiegel einer Anzeigengruppe (meta_adsets, Auszug) */
export interface SpiegelGruppe {
  adset_id: string
  campaign_id: string | null
  name: string | null
  status: string | null
  effective_status: string | null
  daily_budget_cents: number | null
  lifetime_budget_cents: number | null
  bid_strategy: string | null
  bid_amount_cents: number | null
  optimization_goal: string | null
  learning_status: string | null
  learning_conversions: number | null
  last_sig_edit_ts: string | null
  end_time: string | null
  issues: unknown
}

/** Zusatzfelder einer Anzeige (ad_catalog, neue Spalten aus Runde 1) */
export interface SpiegelAnzeige {
  ad_id: string
  effective_status: string | null
  configured_status: string | null
  issues_info: unknown
  review_feedback: unknown
}

export interface Spiegel {
  kampagnen: Map<string, SpiegelKampagne>
  gruppen: Map<string, SpiegelGruppe>
  anzeigen: Map<string, SpiegelAnzeige>
  /** true, wenn mindestens eine Tabelle nicht lesbar war (Migration fehlt o. Ä.) */
  unvollstaendig: boolean
}

/** Lernphase laut Meta (learning_stage_info) */
export interface Lernphase {
  status: string | null
  conversions: number | null
  last_sig_edit_ts: string | null
}

/** Live-Status einer Kampagne/Anzeigengruppe/Anzeige (meta-berichte status) */
export interface LiveStatus {
  id: string
  effective_status: string | null
  configured_status: string | null
  learning: Lernphase | null
  issues: unknown
  review_feedback: unknown
}

/** Eine Zeile im Baum */
export interface Knoten {
  /** `${level}:${id}` */
  key: string
  level: Ebene
  id: string
  name: string
  campaignId: string
  adsetId: string | null
  /** Konfigurierter Status (An/Aus-Schalter) */
  status: string | null
  /** Tatsächliche Auslieferung (effective_status) */
  effectiveStatus: string | null
  lernphase: Lernphase | null
  probleme: unknown
  budgetTagCents: number | null
  budgetLaufzeitCents: number | null
  gebotsstrategie: string | null
  leistungsziel: string | null
  /** Kampagne mit Kampagnenbudget (Budget liegt auf der Kampagne, nicht auf den Gruppen) */
  kampagnenbudget: boolean
  /** Einstellungen (Budget, Gebote) aus dem Spiegel bekannt */
  ausSpiegel: boolean
  /** Ende laut Spiegel (Kampagne stop_time, Anzeigengruppe end_time), ISO */
  ende: string | null
  thumbnail: string | null
  /** Basiswerte für den gewählten Zeitraum (Datenbank oder Meta) */
  werte: Werte
  kinder: Knoten[]
}

// ── meta-berichte ────────────────────────────────────────────────────────────

/** Aufschlüsselungen, die meta-berichte annimmt (SPEC2) */
export type Aufschluesselung =
  | 'age' | 'gender' | 'country' | 'region' | 'publisher_platform' | 'platform_position' | 'impression_device'
  | 'body_asset' | 'title_asset' | 'image_asset' | 'video_asset' | 'hourly_stats_aggregated_by_advertiser_time_zone'

export type Zeitschritt = 1 | 7 | 'monthly' | 'all_days'
export type BerichtFelder = 'standard' | 'video' | 'gebote'

export interface InsightsAnfrage {
  level: Ebene
  ids?: string[]
  campaign_id?: string
  since: string
  until: string
  compare?: { since: string; until: string }
  breakdowns?: Aufschluesselung[]
  time_increment?: Zeitschritt
  felder?: BerichtFelder
  /** true: Zwischenspeicher des Servers übergehen */
  frisch?: boolean
}

/** Eine normalisierte Zeile aus insights */
export interface BerichtZeile {
  /** ID auf der angefragten Ebene ('' wenn unbekannt) */
  id: string
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  name: string | null
  date_start: string | null
  date_stop: string | null
  /** Wert der Aufschlüsselung (Alter, Plattform, Text der Variante ...) */
  schluessel: string | null
  /** Plattform (publisher_platform), falls mitgeliefert (z. B. bei Platzierung) */
  plattform: string | null
  /** Lesbare Beschriftung vom Server (breakdown_label, deutsch), Ersatz für eigene Etiketten */
  beschriftung: string | null
  /** Vorschaubild einer Bild-/Video-Variante */
  bild: string | null
  werte: Werte
}

export interface InsightsAntwort {
  rows: BerichtZeile[]
  compare_rows: BerichtZeile[] | null
  cached: boolean
  fetched_at: string | null
  /** Meta-Daten unvollständig (Auslastung über 75 % oder Seitenlimit) */
  unvollstaendig: boolean
  /** älterer Zwischenspeicher, weil Meta gerade drosselt */
  veraltet: boolean
  hinweise: string[]
}

export interface Aktivitaet {
  ts: string
  actor: string
  object_type: string
  object_id: string
  object_name: string
  event: string
  extra: unknown
  /** 'meta', 'crm' oder 'meta+crm' (Meta-Eintrag einer CRM-Änderung), wenn bekannt */
  quelle: string | null
  /** Rohwert (Meta event_type bzw. crm:<function>/<modus>) */
  event_type: string | null
  /** Kategorie vom Server (Konto, Budget, Status ...), deutsch */
  kategorie: string | null
  /** Person, Automatisierte Regel, Business-Identität, Meta, CRM, Autopilot */
  geaendert_von: string | null
}

/** Eine Empfehlung von Meta (meta-berichte empfehlungen, Texte vom Server deutsch) */
export interface Empfehlung {
  signatur: string | null
  typ: string
  titel: string
  /** Kategorie der Potenzialbewertung (Zielgruppe, Budget und Gebote ...) */
  kategorie: string
  object_ids: string[]
  lift_estimate: string | null
  text: string | null
  /** erwartete Punkte für die Potenzialbewertung */
  punkte: number | null
  /** Direktlink in den Werbeanzeigenmanager (nur https facebook/meta) */
  url: string | null
  /** Einordnung nach Happy-Property-Regeln */
  hp_hinweis: string | null
}

export interface EmpfehlungenAntwort {
  /** Potenzialbewertung 0-100, null wenn Meta keine liefert */
  opportunity_score: number | null
  items: Empfehlung[]
  cached: boolean
  fetched_at: string | null
  veraltet: boolean
  hinweise: string[]
}

/** Zeitraum der Zentrale: 'kopf' = Zeitraum oben im Werbemanager (Datenbank) */
export type ZeitraumWahl =
  | { art: 'kopf' }
  | { art: 'frei'; vorgabe: string; since: string; until: string }

export interface Vergleich {
  an: boolean
  since: string
  until: string
  /** true = automatisch der Zeitraum direkt davor */
  automatisch: boolean
}
