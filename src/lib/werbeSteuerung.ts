// IDENTISCH zu supabase/functions/meta-steuerung/typen.ts (bzw. src/lib/werbeSteuerung.ts). Änderungen immer in beiden Dateien.
//
// Anfrage- und Antworttypen der Edge Function meta-steuerung (Werbemanager-Reiter
// „Tests & Regeln“): Metas A/B-Tests (Ad Studies) und automatisierte Regeln
// (Ad Rules). Reine Typen und Konstanten, keine Imports: die Datei wird byte-gleich
// im Frontend (src/lib) und in der Edge Function benutzt.
//
// Aufruf im Frontend:
//   supabase.functions.invoke('meta-steuerung', { body: { mode: 'rules_list' } })
// Fehler kommen als { error, hint?, code?, data?, meta? } (code aus STEUERUNG_ERROR_CODES).
//
// Regeln (Sven):
// - Nichts wird bei Meta gelöscht. Tests werden beendet (Ende = jetzt), Regeln
//   ausgeschaltet (DISABLED).
// - Neue Regeln starten ausgeschaltet (wie „alles startet pausiert“), außer aktivieren: true.
// - Regeln, die Ausgaben erhöhen können (Aktivieren, Budget erhöhen), legt nur ein Admin
//   an und schaltet nur ein Admin ein; nur für feste IDs, mit Obergrenze und
//   Leitplanken-Prüfung (ad_settings.max_account_daily_budget).
// - Ausschalten und Beenden darf jeder mit dem Recht „Werbung“.
// - Unser Autopilot bleibt die Hauptsteuerung, Meta-Regeln sind das Sicherheitsnetz.
// - Geld: Eingaben und Anzeigen in EUR; an Meta geht es in Kontowährung (Cent,
//   Kurs aus den Insights der letzten 7 Tage, sonst 1,14 USD je EUR).
// - Jeder Schreib-Modus kennt vorschau: true (zeigt den Payload, sendet nichts).

// ── Modi ────────────────────────────────────────────────────────────────────

export const STEUERUNG_MODES = [
  'studies_list', 'study_get', 'study_create', 'study_beenden',
  'rules_list', 'rule_create', 'rule_status', 'rule_history', 'vorlagen',
] as const
export type SteuerungMode = typeof STEUERUNG_MODES[number]

/** Schreiben bei Meta: Recht „Werbung“ + ad_settings.builder_enabled + META_WRITES_DISABLED != 1 (außer vorschau: true). */
export const STEUERUNG_WRITE_MODES: readonly SteuerungMode[] = ['study_create', 'study_beenden', 'rule_create', 'rule_status']

export const STEUERUNG_ERROR_CODES = [
  'builder_disabled', 'writes_disabled', 'forbidden', 'admin_required', 'not_found', 'invalid_request',
  'guardrail', 'housing_forbidden', 'unsupported', 'conflict', 'rate_limited', 'app_dev_mode', 'meta_error', 'internal',
] as const
export type SteuerungErrorCode = typeof STEUERUNG_ERROR_CODES[number]
export interface SteuerungErrorBody { error: string; hint?: string; code?: SteuerungErrorCode | string; data?: unknown; meta?: unknown }

/** Meta-Rate-Limit-Auslastung der letzten Antwort */
export interface SteuerungUsage { accUtilPct: number | null; resetSec: number | null; tier: string | null }

/** Kontowährung und Umrechnung (Meta rechnet in Cent der Kontowährung) */
export interface SteuerungGeld {
  /** z. B. 'USD' */
  waehrung: string
  /** Einheiten der Kontowährung je EUR (1 bei EUR-Konto) */
  konto_pro_eur: number
  kurs_quelle: 'insights_7d' | 'fallback' | 'eur_konto'
}

/** Jede Schreib-Antwort: vorschau true = nichts gesendet, payload zeigt, was an Meta ginge. */
export interface SteuerungSchreibBasis {
  vorschau: boolean
  /** Was an Meta geht (bzw. ginge) */
  payload: Record<string, unknown>
  hinweise: string[]
  usage?: SteuerungUsage
}

export type SteuerungEbene = 'campaign' | 'adset' | 'ad'
export const STEUERUNG_EBENE_LABEL: Readonly<Record<SteuerungEbene, string>> = {
  campaign: 'Kampagne',
  adset: 'Anzeigengruppe',
  ad: 'Werbeanzeige',
}

/** Option, die sichtbar bleibt, aber gesperrt ist (grau mit Grund) */
export interface GesperrteOption { key: string; label: string; grund: string }

export const STEUERUNG_HINWEIS_AUTOPILOT =
  'Unser Autopilot bleibt die Hauptsteuerung: er kennt Termine und Lead-Qualität aus dem CRM. ' +
  'Meta-Regeln sind das Sicherheitsnetz, falls der CRM-Abgleich einmal ausfällt.'

// ── A/B-Tests (Ad Studies) ──────────────────────────────────────────────────

/** Variable des Tests (Meta: Anzeigengestaltung, Zielgruppe, Platzierungen, Selbstdefiniert) */
export type TestTyp = 'anzeigengestaltung' | 'zielgruppe' | 'platzierung' | 'frei'
export const TEST_TYPEN: readonly TestTyp[] = ['anzeigengestaltung', 'zielgruppe', 'platzierung', 'frei']
export const TEST_TYP_LABEL: Readonly<Record<TestTyp, string>> = {
  anzeigengestaltung: 'Anzeigengestaltung',
  zielgruppe: 'Zielgruppe',
  platzierung: 'Platzierungen',
  frei: 'Selbstdefiniert',
}
export const TEST_TYP_ERKLAERUNG: Readonly<Record<TestTyp, string>> = {
  anzeigengestaltung: 'Zwei bis fünf Werbeanzeigen treten gegeneinander an, jede Person sieht nur eine Variante.',
  zielgruppe: 'Gleiche Anzeigen, verschiedene Zielgruppen (je Variante eine Anzeigengruppe). Unter Wohnen nur Orte und eigene Zielgruppen, nie Alter oder Geschlecht.',
  platzierung: 'Gleiche Anzeigen, verschiedene Platzierungen (je Variante eine Anzeigengruppe), zum Beispiel nur Reels gegen alle Platzierungen.',
  frei: 'Beliebiger Unterschied zwischen Kampagnen oder Anzeigengruppen. Für ein klares Ergebnis nur eine Sache ändern.',
}
export const TEST_TYP_EMPFOHLEN: TestTyp = 'anzeigengestaltung'

/** Test-Arten, die es bei Meta gibt, hier aber gesperrt sind */
export const TEST_GESPERRTE_TYPEN: readonly GesperrteOption[] = [
  { key: 'conversion_lift', label: 'Conversion-Lift', grund: 'Nur mit Meta-Ansprechpartner und großem Budget, über die API nicht frei anlegbar.' },
  { key: 'brand_lift', label: 'Brand-Lift', grund: 'Nur mit Meta-Ansprechpartner; für Leads nicht sinnvoll.' },
  { key: 'alter_geschlecht', label: 'Zielgruppe nach Alter oder Geschlecht', grund: 'Sonderkategorie Wohnen: Alter und Geschlecht sind fest, ein solcher Test ist nicht erlaubt.' },
]

/** Gewinner-Kennzahl */
export type TestKennzahl = 'kosten_pro_lead' | 'kosten_pro_termin' | 'kosten_pro_link_klick' | 'ctr' | 'cpm'
export const TEST_KENNZAHLEN: readonly TestKennzahl[] = ['kosten_pro_lead', 'kosten_pro_termin', 'kosten_pro_link_klick', 'ctr', 'cpm']
export const TEST_KENNZAHL_LABEL: Readonly<Record<TestKennzahl, string>> = {
  kosten_pro_lead: 'Kosten pro Lead',
  kosten_pro_termin: 'Kosten pro Termin',
  kosten_pro_link_klick: 'Kosten pro Link-Klick',
  ctr: 'Link-Klickrate (CTR)',
  cpm: 'Kosten pro 1.000 Impressionen (CPM)',
}
export const TEST_KENNZAHL_ERKLAERUNG: Readonly<Record<TestKennzahl, string>> = {
  kosten_pro_lead: 'Was ein Lead in jeder Variante kostet. Liefert bei uns am schnellsten ein belastbares Ergebnis.',
  kosten_pro_termin: 'Was ein bei Meta gemeldeter Termin kostet. Am nächsten am Ziel, braucht aber viel Laufzeit.',
  kosten_pro_link_klick: 'Was ein Klick auf den Link kostet. Gut für frühe Hinweise, sagt wenig über Lead-Qualität.',
  ctr: 'Wie viele Menschen nach dem Sehen klicken. Zeigt, welches Werbemittel mehr Aufmerksamkeit holt.',
  cpm: 'Was 1.000 Einblendungen kosten. Nur für Platzierungs-Tests interessant.',
}
/** true: kleiner ist besser (Kosten), false: größer ist besser (CTR) */
export const TEST_KENNZAHL_NIEDRIGER_BESSER: Readonly<Record<TestKennzahl, boolean>> = {
  kosten_pro_lead: true, kosten_pro_termin: true, kosten_pro_link_klick: true, ctr: false, cpm: true,
}
export const TEST_KENNZAHL_EMPFOHLEN: TestKennzahl = 'kosten_pro_lead'

export const TEST_GRENZEN = {
  min_zellen: 2,
  max_zellen: 5,
  /** Meta: jede Zelle mindestens 10 % */
  min_anteil: 10,
  max_objekte_je_zelle: 10,
  min_tage: 1,
  max_tage: 30,
  empfohlen_tage: 7,
  /** so viele Ereignisse (Leads, Klicks ...) braucht die beste Zelle, bevor ein Gewinner genannt wird */
  min_ereignisse_fuer_gewinner: 5,
  /** Sicherheit ab der ein Gewinner „klar“ ist */
  sicherheit_klar: 0.9,
  /** Sicherheit ab der eine „Tendenz“ gezeigt wird */
  sicherheit_tendenz: 0.75,
} as const

export type TestStatus = 'geplant' | 'laeuft' | 'beendet' | 'abgebrochen'
export const TEST_STATUS_LABEL: Readonly<Record<TestStatus, string>> = {
  geplant: 'Geplant',
  laeuft: 'Läuft',
  beendet: 'Beendet',
  abgebrochen: 'Abgebrochen',
}

export interface TestUebersicht {
  id: string
  name: string
  /** Beschreibung ohne die HP-Kennung */
  beschreibung: string | null
  /** aus der HP-Kennung in der Beschreibung; bei fremden Tests null */
  typ: TestTyp | null
  kennzahl: TestKennzahl | null
  /** Metas Typ: SPLIT_TEST, SPLIT_TEST_V2, LIFT ... */
  meta_typ: string | null
  status: TestStatus
  start: string | null
  ende: string | null
  erstellt: string | null
  abgebrochen_am: string | null
  /** ab wann Meta Ergebnisse hat */
  ergebnisse_ab: string | null
  /** im CRM angelegt (HP-Kennung vorhanden) */
  von_hp: boolean
  /** gelesen über das Werbekonto oder das Business */
  quelle: 'konto' | 'business'
}

export interface StudiesListRequest {
  /** nur im CRM angelegte Tests */
  nur_hp?: boolean
}
export interface StudiesListResponse { items: TestUebersicht[]; warnings: string[]; usage?: SteuerungUsage }

export interface TestObjekt { id: string; name: string | null; status: string | null }

export interface TestZellenWerte {
  /** Ausgaben in Kontowährung */
  ausgaben: number
  ausgaben_eur: number
  impressionen: number
  reichweite: number | null
  link_klicks: number
  leads: number
  /** bei Meta gemeldete Termine (Pixel/CAPI-Ereignis Schedule) */
  termine: number
  kosten_pro_lead_eur: number | null
  kosten_pro_termin_eur: number | null
  kosten_pro_link_klick_eur: number | null
  /** Prozent (Link-Klicks / Impressionen x 100) */
  ctr: number | null
  cpm_eur: number | null
}

export interface TestZelle {
  id: string
  name: string
  anteil: number | null
  ebene: SteuerungEbene | null
  objekte: TestObjekt[]
  werte: TestZellenWerte
  /** Wert der gewählten Kennzahl (EUR bzw. Prozent bei CTR) */
  kennzahl_wert: number | null
  /** HP-Schätzung: Wahrscheinlichkeit, bei der Kennzahl die beste Zelle zu sein (0 bis 1) */
  p_beste: number | null
  ist_gewinner: boolean
}

export type GewinnerEinstufung = 'klar' | 'tendenz' | 'offen' | 'zu_wenig_daten'
export const GEWINNER_EINSTUFUNG_LABEL: Readonly<Record<GewinnerEinstufung, string>> = {
  klar: 'Klarer Gewinner',
  tendenz: 'Tendenz',
  offen: 'Noch offen',
  zu_wenig_daten: 'Zu wenig Daten',
}

export interface TestGewinner {
  zelle_id: string | null
  zelle_name: string | null
  kennzahl: TestKennzahl
  /** 'meta' = Konfidenz von Meta, 'hp_schaetzung' = eigene Rechnung aus den Zahlen */
  quelle: 'meta' | 'hp_schaetzung' | null
  /** 0 bis 1 */
  sicherheit: number | null
  einstufung: GewinnerEinstufung
  /** ein Satz in einfachem Deutsch */
  text: string
}

/** Rohergebnisse aus Metas Test-Zielen (Format von Meta nicht dokumentiert, daher roh) */
export interface MetaTestErgebnis {
  ziel_id: string
  name: string | null
  typ: string | null
  primaer: boolean
  ergebnisse: unknown[]
  aktualisiert: string | null
}

export interface StudyGetRequest {
  id: string
  /** sonst die beim Anlegen gewählte Kennzahl, sonst Kosten pro Lead */
  kennzahl?: TestKennzahl
}
export interface StudyGetResponse {
  test: TestUebersicht
  kennzahl: TestKennzahl
  /** Auswertungszeitraum (Datum), null = Test hat noch nicht begonnen */
  zeitraum: { since: string; until: string } | null
  zellen: TestZelle[]
  gewinner: TestGewinner
  meta_ergebnisse: MetaTestErgebnis[]
  geld: SteuerungGeld
  warnings: string[]
  usage?: SteuerungUsage
}

/** Eine Variante. Genau eine Objektart je Zelle, in allen Zellen dieselbe. */
export interface TestZelleEingabe {
  name: string
  /** Prozent der Zielgruppe; fehlt = gleichmäßig verteilt; mindestens 10 */
  anteil?: number
  campaign_ids?: string[]
  adset_ids?: string[]
  /** Anzeigengestaltung: genau eine Werbeanzeige je Zelle (Metas Creative-Test) */
  ad_ids?: string[]
}

export interface StudyCreateRequest {
  typ: TestTyp
  name: string
  beschreibung?: string
  /** ISO-Zeitpunkt; fehlt = in 15 Minuten */
  start?: string
  /** ISO-Zeitpunkt, 1 bis 30 Tage nach dem Start */
  ende: string
  kennzahl: TestKennzahl
  zellen: TestZelleEingabe[]
  /**
   * Nur Anzeigengestaltung mit Werbeanzeigen (Metas Creative-Test): welcher Teil des
   * vorhandenen Budgets in den Test fließt. Genau eins von beiden; Standard 20 % Anteil.
   * Ein Tagesbudget zählt die Leitplanke als zusätzliche Ausgabe (ungeprüft, ob Meta es
   * aus dem vorhandenen Budget nimmt).
   */
  testbudget?: { tagesbudget_eur?: number; anteil_prozent?: number }
  vorschau?: boolean
}
export interface StudyCreateResponse extends SteuerungSchreibBasis {
  /** null bei vorschau */
  id: string | null
  meta_typ: 'SPLIT_TEST' | 'SPLIT_TEST_V2'
  start: string
  ende: string
  tage: number
  zellen: Array<{ name: string; anteil: number; ebene: SteuerungEbene; objekte: TestObjekt[] }>
}

export interface StudyBeendenRequest { id: string; vorschau?: boolean }
export interface StudyBeendenResponse extends SteuerungSchreibBasis {
  id: string
  ende_vorher: string | null
  ende_neu: string
}

// ── Automatisierte Regeln (Ad Rules) ────────────────────────────────────────

export type RegelAktion = 'pause' | 'unpause' | 'budget_aendern' | 'nur_benachrichtigen'
export const REGEL_AKTIONEN: readonly RegelAktion[] = ['pause', 'nur_benachrichtigen', 'budget_aendern', 'unpause']
export const REGEL_AKTION_LABEL: Readonly<Record<RegelAktion, string>> = {
  pause: 'Deaktivieren',
  unpause: 'Aktivieren',
  budget_aendern: 'Budget anpassen',
  nur_benachrichtigen: 'Nur Benachrichtigung senden',
}
export const REGEL_AKTION_ERKLAERUNG: Readonly<Record<RegelAktion, string>> = {
  pause: 'Meta schaltet die passenden Objekte aus. Gut als Notbremse.',
  unpause: 'Meta schaltet die Objekte wieder ein. Erhöht Ausgaben, daher nur Admin, nur feste Objekte und mit Leitplanken-Prüfung.',
  budget_aendern: 'Meta ändert das Tagesbudget der Anzeigengruppe oder Kampagne. Erhöhen nur Admin, immer mit Obergrenze.',
  nur_benachrichtigen: 'Meta ändert nichts und meldet nur. Die Meldungen stehen auch im Verlauf hier im CRM.',
}
/** Diese Aktionen können Ausgaben erhöhen (Budget nur bei positivem Wert) */
export const REGEL_AKTION_KANN_ERHOEHEN: Readonly<Record<RegelAktion, boolean>> = {
  pause: false, unpause: true, budget_aendern: true, nur_benachrichtigen: false,
}

/** Meta-Aktionen, die hier sichtbar aber gesperrt sind */
export const REGEL_GESPERRTE_AKTIONEN: readonly GesperrteOption[] = [
  { key: 'gebot_anpassen', label: 'Manuelles Gebot anpassen', grund: 'Happy Property nutzt keine manuellen Gebote; Gebotsänderungen starten zudem die Lernphase neu.' },
  { key: 'umkreis_erweitern', label: 'Umkreis erweitern', grund: 'Ändert die Zielgruppe. Unter der Sonderkategorie Wohnen ist das nicht erlaubt.' },
  { key: 'interessen_lockern', label: 'Interessen lockern', grund: 'Ändert die Zielgruppe. Unter der Sonderkategorie Wohnen ist das nicht erlaubt.' },
  { key: 'budget_umverteilen', label: 'Budget umverteilen', grund: 'Pausiert Anzeigengruppen und verschiebt Budget ohne CRM-Leitplanke. Das übernimmt bei uns der Autopilot.' },
  { key: 'anzeigen_rotieren', label: 'Werbeanzeigen rotieren', grund: 'Meta kennt keine Termine. Der Autopilot tauscht Werbemittel nach CRM-Qualität.' },
]

/** Felder für Bedingungen (Teilmenge von Metas Filterfeldern) */
export type RegelFeld =
  | 'spent' | 'results' | 'leadgen' | 'offsite_conversion.fb_pixel_lead' | 'cost_per_lead_fb'
  | 'impressions' | 'reach' | 'frequency' | 'link_click' | 'cost_per_link_click' | 'link_ctr' | 'ctr'
  | 'cpc' | 'cpm' | 'daily_budget' | 'hours_since_creation'

/** eur = Eingabe in EUR (an Meta in Cent der Kontowährung), prozent = 1 heißt 1 % */
export type RegelEinheit = 'eur' | 'anzahl' | 'prozent' | 'faktor' | 'stunden'

export interface RegelFeldInfo {
  feld: RegelFeld
  label: string
  erklaerung: string
  einheit: RegelEinheit
  /** in „Das Wichtigste“ zeigen */
  wichtig: boolean
  /** Ebenen, auf denen Meta das Feld kennt */
  ebenen: readonly SteuerungEbene[]
  /** insights = Kennzahl im Zeitraum, metadaten = Eigenschaft des Objekts */
  art: 'insights' | 'metadaten'
  /** Kosten-Bedingung: Meta lehnt sie bei Regeln, die ausschalten, ggf. ab (Fehler 2703) */
  kosten: boolean
}

const ALLE_EBENEN: readonly SteuerungEbene[] = ['campaign', 'adset', 'ad']

export const REGEL_FELDER: readonly RegelFeldInfo[] = [
  { feld: 'spent', label: 'Ausgaben', erklaerung: 'Was im Zeitraum ausgegeben wurde.', einheit: 'eur', wichtig: true, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'results', label: 'Ergebnisse', erklaerung: 'Ergebnisse nach dem Leistungsziel der Anzeigengruppe, bei uns meist Leads.', einheit: 'anzahl', wichtig: true, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'frequency', label: 'Frequenz', erklaerung: 'Wie oft eine Person die Anzeige im Schnitt gesehen hat. Über 3 wird es oft lästig.', einheit: 'faktor', wichtig: true, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'leadgen', label: 'Leads (Sofortformular)', erklaerung: 'Leads aus Metas Sofortformularen.', einheit: 'anzahl', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'offsite_conversion.fb_pixel_lead', label: 'Leads (Website)', erklaerung: 'Leads, die der Pixel auf der Website gemeldet hat.', einheit: 'anzahl', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'cost_per_lead_fb', label: 'Kosten pro Website-Lead', erklaerung: 'Ausgaben geteilt durch Website-Leads.', einheit: 'eur', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: true },
  { feld: 'impressions', label: 'Impressionen', erklaerung: 'Wie oft die Anzeige eingeblendet wurde.', einheit: 'anzahl', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'reach', label: 'Reichweite', erklaerung: 'Wie viele verschiedene Menschen die Anzeige gesehen haben.', einheit: 'anzahl', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'link_click', label: 'Link-Klicks', erklaerung: 'Klicks auf den Link zur Website oder zum Formular.', einheit: 'anzahl', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'link_ctr', label: 'Link-Klickrate (CTR)', erklaerung: 'Anteil der Einblendungen mit Link-Klick, in Prozent.', einheit: 'prozent', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'ctr', label: 'CTR (alle Klicks)', erklaerung: 'Anteil der Einblendungen mit irgendeinem Klick, in Prozent.', einheit: 'prozent', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: false },
  { feld: 'cost_per_link_click', label: 'Kosten pro Link-Klick', erklaerung: 'Ausgaben geteilt durch Link-Klicks.', einheit: 'eur', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: true },
  { feld: 'cpc', label: 'CPC (alle Klicks)', erklaerung: 'Ausgaben geteilt durch alle Klicks.', einheit: 'eur', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: true },
  { feld: 'cpm', label: 'CPM', erklaerung: 'Kosten für 1.000 Einblendungen.', einheit: 'eur', wichtig: false, ebenen: ALLE_EBENEN, art: 'insights', kosten: true },
  { feld: 'daily_budget', label: 'Tagesbudget', erklaerung: 'Aktuelles Tagesbudget der Anzeigengruppe.', einheit: 'eur', wichtig: false, ebenen: ['adset'], art: 'metadaten', kosten: false },
  { feld: 'hours_since_creation', label: 'Stunden seit Erstellung', erklaerung: 'Schützt junge Objekte in der Lernphase, z. B. erst ab 72 Stunden.', einheit: 'stunden', wichtig: false, ebenen: ALLE_EBENEN, art: 'metadaten', kosten: false },
]

export type RegelOperator = 'groesser' | 'kleiner' | 'zwischen' | 'nicht_zwischen'
export const REGEL_OPERATOR_LABEL: Readonly<Record<RegelOperator, string>> = {
  groesser: 'größer als',
  kleiner: 'kleiner als',
  zwischen: 'zwischen',
  nicht_zwischen: 'nicht zwischen',
}

/** wert in der Einheit des Felds (EUR, Anzahl, Prozent ...); [von, bis] bei zwischen/nicht_zwischen */
export interface RegelBedingung { feld: RegelFeld; operator: RegelOperator; wert: number | [number, number] }

/** Zeitrahmen der Kennzahlen (Metas time_preset; die _DAYS-Werte schließen heute ein) */
export type RegelZeitraum =
  | 'TODAY' | 'YESTERDAY' | 'LAST_2_DAYS' | 'LAST_3_DAYS' | 'LAST_7_DAYS' | 'LAST_14_DAYS' | 'LAST_30_DAYS' | 'LIFETIME'
export const REGEL_ZEITRAEUME: readonly RegelZeitraum[] = [
  'TODAY', 'YESTERDAY', 'LAST_2_DAYS', 'LAST_3_DAYS', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LIFETIME',
]
export const REGEL_ZEITRAUM_LABEL: Readonly<Record<RegelZeitraum, string>> = {
  TODAY: 'Heute',
  YESTERDAY: 'Gestern',
  LAST_2_DAYS: 'Letzte 2 Tage (mit heute)',
  LAST_3_DAYS: 'Letzte 3 Tage (mit heute)',
  LAST_7_DAYS: 'Letzte 7 Tage (mit heute)',
  LAST_14_DAYS: 'Letzte 14 Tage (mit heute)',
  LAST_30_DAYS: 'Letzte 30 Tage (mit heute)',
  LIFETIME: 'Gesamte Laufzeit',
}
export const REGEL_ZEITRAUM_EMPFOHLEN: RegelZeitraum = 'LAST_7_DAYS'

export type RegelZeitplan = 'laufend' | 'taeglich' | 'eigen'
export const REGEL_ZEITPLAN_LABEL: Readonly<Record<RegelZeitplan, string>> = {
  laufend: 'Fortlaufend',
  taeglich: 'Täglich',
  eigen: 'Benutzerdefiniert',
}
export const REGEL_ZEITPLAN_ERKLAERUNG: Readonly<Record<RegelZeitplan, string>> = {
  laufend: 'Meta prüft etwa alle 30 Minuten. Richtig für eine Notbremse.',
  taeglich: 'Meta prüft einmal am Tag um Mitternacht (Zeitzone des Werbekontos). Richtig für Hinweise.',
  eigen: 'Nur an bestimmten Wochentagen und Uhrzeiten (halbstündlich wählbar).',
}

/** Benutzerdefiniertes Zeitfenster: tage 0 = Sonntag bis 6 = Samstag; Minuten nach Mitternacht, Vielfache von 30 */
export interface RegelZeitfenster { tage: number[]; von_minute?: number; bis_minute?: number }

/**
 * Wofür die Regel gilt. Ohne Filter: alle aktiven Objekte der Ebene im Werbekonto
 * (Meta prüft nur aktive bzw. in Prüfung befindliche Objekte).
 */
export interface RegelFilter {
  /** feste Objekte der gewählten Ebene */
  ids?: string[]
  /** Name des Objekts enthält */
  name_enthaelt?: string
  /** nur unter diesen Kampagnen */
  kampagnen_ids?: string[]
  /** nur unter diesen Anzeigengruppen (Ebene Werbeanzeige) */
  anzeigengruppen_ids?: string[]
  /** Kampagnenname enthält */
  kampagnenname_enthaelt?: string
}

/**
 * Budget anpassen. art 'prozent': wert = Prozent (z. B. -20), 'betrag': wert = EUR (z. B. -10).
 * grenze_eur: beim Erhöhen die Obergrenze (Pflicht), beim Senken die Untergrenze (Standard 30 EUR;
 *   ohne feste IDs höchstens 30 EUR, mit festen IDs höchstens das kleinste aktuelle Tagesbudget).
 * max_ausfuehrungen: wie oft je Objekt höchstens (Pflicht beim Erhöhen).
 * mindestabstand_stunden: Mindestabstand je Objekt (Standard 72, Lernphasen-Schutz; beim
 *   Erhöhen mindestens 24, beim Senken mindestens 1).
 */
export interface RegelBudgetAenderung {
  art: 'prozent' | 'betrag'
  wert: number
  grenze_eur?: number
  max_ausfuehrungen?: number
  mindestabstand_stunden?: number
}

export const REGEL_GRENZEN = {
  max_bedingungen: 8,
  max_ids: 50,
  /** Budget senken: Untergrenze, wenn nichts angegeben ist (Autopilot D1) */
  budget_untergrenze_eur: 30,
  /** Budget erhöhen: höchstens so viel Prozent je Schritt */
  max_erhoehung_prozent: 50,
  /** ab hier Hinweis zur Lernphase */
  lernphase_prozent: 20,
  max_erhoehung_eur: 100,
  max_senkung_prozent: 90,
  standard_mindestabstand_stunden: 72,
  min_mindestabstand_erhoehen_stunden: 24,
  max_ausfuehrungen: 30,
} as const

export interface RuleCreateRequest {
  name: string
  ebene: SteuerungEbene
  filter?: RegelFilter
  /** alle müssen zutreffen (UND) */
  bedingungen: RegelBedingung[]
  zeitraum: RegelZeitraum
  aktion: RegelAktion
  /** Pflicht bei budget_aendern */
  aktion_wert?: RegelBudgetAenderung
  zeitplan: RegelZeitplan
  /** Pflicht bei zeitplan 'eigen' */
  zeitplan_eigen?: RegelZeitfenster[]
  /**
   * Facebook-Nutzer-IDs für Benachrichtigungen und Metas Tages-Mail (aus vorlagen.empfaenger).
   * Ohne Empfänger meldet Meta nur dem Ersteller, also dem System-Nutzer des CRM.
   */
  empfaenger_ids?: string[]
  /** Standard false: Regel startet ausgeschaltet */
  aktivieren?: boolean
  /** Schlüssel der Vorlage (nur fürs Protokoll) */
  vorlage?: string
  vorschau?: boolean
}
export interface RuleCreateResponse extends SteuerungSchreibBasis {
  /** null bei vorschau */
  id: string | null
  status: 'ENABLED' | 'DISABLED'
  /** kann Ausgaben erhöhen (nur Admin) */
  riskant: boolean
  /** Regel in einfachem Deutsch, Zeile für Zeile */
  zusammenfassung: string[]
}

export type RegelStatus = 'ENABLED' | 'DISABLED' | 'HAS_ISSUES' | 'DELETED'
export const REGEL_STATUS_LABEL: Readonly<Record<RegelStatus, string>> = {
  ENABLED: 'Aktiv',
  DISABLED: 'Aus',
  HAS_ISSUES: 'Fehler',
  DELETED: 'Gelöscht',
}

export interface RegelUebersicht {
  id: string
  name: string
  status: string
  status_label: string
  aktiv: boolean
  ebene: SteuerungEbene | null
  /** null = Meta-Aktion, die das CRM nicht anlegt (z. B. Gebot, Rotation) */
  aktion: RegelAktion | null
  /** Metas execution_type */
  aktion_meta: string | null
  /** SCHEDULE = nach Zeitplan, TRIGGER = sofort bei Änderung (nur per API) */
  bewertung: 'SCHEDULE' | 'TRIGGER' | null
  zeitraum: RegelZeitraum | null
  geltung_text: string
  bedingungen_text: string[]
  aktion_text: string
  zeitplan_text: string
  /** kann Ausgaben erhöhen: Einschalten nur Admin */
  riskant: boolean
  /** im CRM angelegt (laut Schreibprotokoll) */
  von_hp: boolean
  /** als neue Regel kopierbar (null = nicht abbildbar) */
  eingabe: RuleCreateRequest | null
  /** HAS_ISSUES bzw. disable_error_code */
  fehler: { code: number | null; text: string | null } | null
  erstellt: string | null
  aktualisiert: string | null
  ersteller: string | null
}

export type RulesListRequest = Record<string, never>
export interface RulesListResponse { items: RegelUebersicht[]; geld: SteuerungGeld; warnings: string[]; usage?: SteuerungUsage }

/** Ausschalten darf jeder mit Recht „Werbung“; Einschalten einer riskanten Regel nur Admin. */
export interface RuleStatusRequest { id: string; status: 'ENABLED' | 'DISABLED'; vorschau?: boolean }
export interface RuleStatusResponse extends SteuerungSchreibBasis {
  id: string
  status_vorher: string | null
  status_neu: 'ENABLED' | 'DISABLED'
}

/** Ohne id: Verlauf aller Regeln des Werbekontos */
export interface RuleHistoryRequest {
  id?: string
  objekt_id?: string
  /** Standard true: Läufe ohne Änderung ausblenden */
  nur_mit_aenderungen?: boolean
  /** Standard 50, höchstens 100 */
  limit?: number
}

export const REGEL_VERLAUF_AKTION_LABEL: Readonly<Record<string, string>> = {
  PAUSED: 'Ausgeschaltet',
  UNPAUSED: 'Eingeschaltet',
  CHANGED_BUDGET: 'Budget geändert',
  CHANGED_BID: 'Gebot geändert',
  FACEBOOK_NOTIFICATION_SENT: 'Benachrichtigung gesendet',
  EMAIL: 'E-Mail gesendet',
  MESSAGE_SENT: 'Nachricht gesendet',
  ENDPOINT_PINGED: 'Webhook ausgelöst',
  NOT_CHANGED: 'Keine Änderung',
  BUDGET_NOT_REDISTRIBUTED: 'Budget nicht umverteilt',
  ERROR: 'Fehler',
}

export interface RegelVerlaufAktion { aktion: string; aktion_label: string; feld: string | null; alt: string | null; neu: string | null }
export interface RegelVerlaufObjekt { objekt_id: string; objekt_typ: SteuerungEbene | null; objekt_name: string | null; aktionen: RegelVerlaufAktion[] }
export interface RegelVerlaufEintrag {
  zeit: string | null
  regel_id: string | null
  regel_name: string | null
  /** von Hand ausgelöst */
  manuell: boolean
  fehler: { code: number | null; text: string | null } | null
  objekte: RegelVerlaufObjekt[]
}
export interface RuleHistoryResponse { items: RegelVerlaufEintrag[]; warnings: string[]; usage?: SteuerungUsage }

export interface RegelVorlage {
  key: string
  /** deutscher Text (Rückfall); übersetzbar über titel_key */
  titel: string
  /** ein Satz in einfachem Deutsch (Rückfall); übersetzbar über erklaerung_key + text_params */
  erklaerung: string
  /** i18n-Schlüssel, z. B. t(v.titel_key, v.titel) */
  titel_key: string
  /** i18n-Schlüssel, z. B. t(v.erklaerung_key, v.erklaerung, v.text_params) */
  erklaerung_key: string
  wohnen_grund_key: string
  /** Platzhalter der Texte (Geld in EUR, ganze Zahlen) */
  text_params: Record<string, number>
  /** Badge „Empfohlen für Happy Property“ */
  empfohlen: boolean
  wohnen_sicher: boolean
  wohnen_grund: string
  /** fertig ausgefüllte Anfrage für rule_create (Geld in EUR) */
  anfrage: RuleCreateRequest
}

export type VorlagenRequest = Record<string, never>
export interface VorlagenResponse {
  vorlagen: RegelVorlage[]
  gesperrte_aktionen: readonly GesperrteOption[]
  felder: readonly RegelFeldInfo[]
  /** Nutzer des Werbekontos als Empfänger für Benachrichtigungen (leer, wenn nicht lesbar) */
  empfaenger: Array<{ id: string; name: string }>
  hinweis_autopilot: string
  /** null, wenn die Kontowährung nicht lesbar war */
  geld: SteuerungGeld | null
  warnings: string[]
  usage?: SteuerungUsage
}

// ── Zuordnung Modus -> Anfrage/Antwort ───────────────────────────────────────

export interface SteuerungRequestMap {
  studies_list: StudiesListRequest
  study_get: StudyGetRequest
  study_create: StudyCreateRequest
  study_beenden: StudyBeendenRequest
  rules_list: RulesListRequest
  rule_create: RuleCreateRequest
  rule_status: RuleStatusRequest
  rule_history: RuleHistoryRequest
  vorlagen: VorlagenRequest
}
export interface SteuerungResponseMap {
  studies_list: StudiesListResponse
  study_get: StudyGetResponse
  study_create: StudyCreateResponse
  study_beenden: StudyBeendenResponse
  rules_list: RulesListResponse
  rule_create: RuleCreateResponse
  rule_status: RuleStatusResponse
  rule_history: RuleHistoryResponse
  vorlagen: VorlagenResponse
}
