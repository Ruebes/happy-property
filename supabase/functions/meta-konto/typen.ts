// IDENTISCH zu supabase/functions/meta-konto/typen.ts (bzw. src/lib/werbeKonto.ts). Änderungen immer in beiden Dateien.
//
// Anfrage- und Antworttypen der Edge Function meta-konto (Werbemanager, Reiter
// „Messung & Konto" und „Kommentare"): Werbekonto lesen, Ausgabenlimit des Kontos,
// Kommentare unter Anzeigen lesen, beantworten, ausblenden.
// Reine Typen und Konstanten, keine Imports: die Datei wird byte-gleich im
// Frontend (src/lib) und in der Edge Function benutzt.
//
// Aufruf im Frontend:
//   supabase.functions.invoke('meta-konto', { body: { mode: 'konto' } })
// Fehler kommen als { error, hint?, code?, data?, meta? } (code aus KONTO_ERROR_CODES).
//
// Regeln (Sven): nichts wird bei Meta gelöscht. Ausgabenlimit nur Admin, mit
// confirm: true, höchstens 10 Änderungen in 24 Stunden (Meta-Grenze). Antworten
// auf Kommentare nur per Klick eines Menschen (confirm: true), Text ohne
// Gedankenstriche, ohne ae/oe/ue-Ersatz, ohne Projekt- oder Bauträgernamen und
// ohne Rendite-, Finanzierungs- oder Garantieversprechen.
// Von Kommentierenden wird nur der Name gezeigt (keine IDs, keine weiteren Daten).

// ── Modi ────────────────────────────────────────────────────────────────────

export const KONTO_MODES = [
  'konto', 'konto_ausgabenlimit', 'kommentare_list', 'kommentar_antworten', 'kommentar_ausblenden',
] as const
export type KontoMode = typeof KONTO_MODES[number]

/** Schreiben bei Meta: Recht „Werbung“ + ad_settings.builder_enabled + META_WRITES_DISABLED != 1. */
export const KONTO_WRITE_MODES: readonly KontoMode[] = ['konto_ausgabenlimit', 'kommentar_antworten', 'kommentar_ausblenden']
/** Zusätzlich nur für Admins (profiles.role = 'admin'). */
export const KONTO_ADMIN_MODES: readonly KontoMode[] = ['konto_ausgabenlimit']

export const KONTO_ERROR_CODES = [
  'builder_disabled', 'writes_disabled', 'forbidden', 'not_found', 'invalid_request', 'lint_blocked',
  'limit_reached', 'doppelt', 'unveraendert', 'rate_limited', 'app_dev_mode', 'meta_error', 'internal',
] as const
export type KontoErrorCode = typeof KONTO_ERROR_CODES[number]
export interface KontoErrorBody { error: string; hint?: string; code?: KontoErrorCode | string; data?: unknown; meta?: unknown }

/** Meta-Rate-Limit-Auslastung der letzten Antwort */
export interface KontoUsage { accUtilPct: number | null; resetSec: number | null; tier: string | null }

/** Meta erlaubt höchstens so viele Änderungen am Ausgabenlimit des Kontos je Tag. */
export const AUSGABENLIMIT_MAX_AENDERUNGEN = 10

/** Ein Satz Erklärung in einfachem Deutsch je Konto-Angabe (für die Oberfläche). */
export const KONTO_ERKLAERUNG: Readonly<Record<string, string>> = {
  status: 'Ob das Werbekonto Anzeigen ausliefern darf.',
  ausgegeben: 'Ohne Ausgabenlimit alle bisherigen Ausgaben des Kontos, mit Limit die Ausgaben seit dem letzten Zurücksetzen des Limits.',
  ausgabenlimit: 'Erreicht das Konto diesen Betrag, stoppt Meta alle Anzeigen, bis du das Limit erhöhst oder entfernst.',
  saldo: 'Betrag, den Meta noch nicht abgebucht hat.',
  zahlungsquelle: 'Womit Meta die Werbekosten abbucht (verkürzt angezeigt).',
  dsa: 'Begünstigter und Zahler nach dem EU-Gesetz über digitale Dienste, Pflicht für Anzeigen in der EU.',
  platzierungen: 'Platzierungen, die für das ganze Konto ausgeschlossen sind.',
  markenschutz: 'Filter, der Anzeigen von heiklen Inhalten in Videos und Reels fernhält.',
  blocklisten: 'Listen von Apps und Websites, auf denen deine Anzeigen nie erscheinen.',
  wohnen: 'Kontoweite Einschränkungen gelten laut Meta nicht für Kampagnen der Sonderkategorie Wohnen.',
}

// ── Konto lesen ─────────────────────────────────────────────────────────────

export type KontoStatusKey =
  | 'aktiv' | 'deaktiviert' | 'zahlung_offen' | 'risikopruefung' | 'abrechnung_ausstehend'
  | 'kulanzzeit' | 'schliessung_beantragt' | 'geschlossen' | 'unbekannt'

/** Metas account_status -> Schlüssel */
export const KONTO_STATUS_CODE: Readonly<Record<number, KontoStatusKey>> = {
  1: 'aktiv', 2: 'deaktiviert', 3: 'zahlung_offen', 7: 'risikopruefung', 8: 'abrechnung_ausstehend',
  9: 'kulanzzeit', 100: 'schliessung_beantragt', 101: 'geschlossen', 201: 'aktiv', 202: 'geschlossen',
}
export const KONTO_STATUS_LABEL: Readonly<Record<KontoStatusKey, string>> = {
  aktiv: 'Aktiv',
  deaktiviert: 'Deaktiviert',
  zahlung_offen: 'Zahlung offen',
  risikopruefung: 'Risikoprüfung läuft',
  abrechnung_ausstehend: 'Abrechnung ausstehend',
  kulanzzeit: 'Kulanzzeitraum',
  schliessung_beantragt: 'Schließung beantragt',
  geschlossen: 'Geschlossen',
  unbekannt: 'Unbekannt',
}

/** Metas disable_reason (0 = kein Sperrgrund) */
export const KONTO_SPERRGRUND_LABEL: Readonly<Record<number, string>> = {
  1: 'Verstoß gegen die Werberichtlinien',
  2: 'Prüfung wegen geistigen Eigentums',
  3: 'Zahlungsrisiko',
  4: 'Konto stillgelegt',
  5: 'Prüfung durch Meta',
  6: 'Integritätsprüfung des Unternehmens',
  7: 'Dauerhaft geschlossen',
  8: 'Ungenutztes Reseller-Konto',
  9: 'Ungenutztes Konto',
  10: 'Sammelkonto',
  11: 'Richtlinienverstoß im Business Manager',
  12: 'Falsche Angaben zum Werbekonto',
  13: 'Rechtsträger nicht mehr geteilt',
  14: 'Prüfung eines Gesprächsverlaufs',
  15: 'Konto kompromittiert',
}

/** Metas funding_source_details.type */
export const ZAHLUNGSQUELLE_LABEL: Readonly<Record<number, string>> = {
  1: 'Kreditkarte', 2: 'Facebook-Guthaben', 3: 'Bezahltes Facebook-Guthaben', 4: 'Kreditlinie',
  5: 'Bestellung', 6: 'Rechnung', 7: 'Facebook-Token', 8: 'Externe Finanzierung', 9: 'Gebühr',
  10: 'Währungsumrechnung', 11: 'Rabatt', 12: 'PayPal', 13: 'PayPal-Abbuchung', 14: 'Keine',
  15: 'Externe Einzahlung', 16: 'Steuer', 17: 'Lastschrift', 18: 'Platzhalter', 19: 'Andere Zahlungsart',
  20: 'Guthaben',
}

/** Kontoweite Platzierungseinschränkungen (account_controls.placement_controls.placement_exclusions) */
export const PLATZIERUNG_AUSSCHLUSS_LABEL: Readonly<Record<string, string>> = {
  audience_network_classic: 'Audience Network Native, Banner und Interstitial',
  audience_network_rewarded_video: 'Rewarded Videos im Audience Network',
  facebook_marketplace: 'Facebook Marketplace',
  facebook_rhc: 'Rechte Spalte auf Facebook',
}

/** konto: keine Felder */
export type KontoAbrufRequest = Record<never, never>

export interface KontoZahlungsquelle {
  /** Metas Typ-Nummer (null = unbekannt) */
  art: number | null
  art_text: string
  /** verkürzt, Ziffernfolgen bis auf die letzten 4 Stellen und E-Mail-Adressen verborgen */
  anzeige: string | null
}

export interface KontoMarkenschutz {
  /** Metas Wert, z. B. FACEBOOK_STANDARD */
  key: string
  /** z. B. „Facebook-Videos und Reels: Moderates Inventar" */
  text: string
}

export interface KontoBlockliste { id: string; name: string; aktualisiert: string | null }

export interface KontoResponse {
  id: string
  name: string | null
  status: KontoStatusKey
  status_code: number | null
  status_text: string
  /** z. B. USD (das HP-Konto rechnet in USD ab) */
  waehrung: string | null
  zeitzone: string | null
  zeitzone_offset_h: number | null
  /** Beträge in Cent der Kontowährung, dazu der Euro-Wert (null, wenn nicht umrechenbar).
   *  ausgegeben: ohne Limit alle bisherigen Ausgaben, mit Limit seit dem letzten Zurücksetzen (Meta amount_spent) */
  ausgegeben_cents: number | null
  ausgegeben_eur: number | null
  /** null = kein Ausgabenlimit gesetzt */
  limit_cents: number | null
  limit_eur: number | null
  /** Rest bis zum Limit (null ohne Limit) */
  rest_cents: number | null
  rest_eur: number | null
  /** ausgegeben / Limit in Prozent (null ohne Limit) */
  limit_auslastung_pct: number | null
  saldo_cents: number | null
  saldo_eur: number | null
  usd_pro_eur: number
  kurs_quelle: 'insights_7d' | 'fallback'
  zahlungsquelle: KontoZahlungsquelle | null
  vorauszahlung: boolean | null
  sperrgrund_code: number | null
  sperrgrund_text: string | null
  unternehmen: { id: string; name: string | null } | null
  dsa_beguenstigter: string | null
  dsa_zahler: string | null
  mindest_tagesbudget_cents: number | null
  /** kontoweit ausgeschlossene Platzierungen (Texte) und Metas Schlüssel */
  platzierungs_ausschluesse: string[]
  platzierungs_ausschluesse_keys: string[]
  /** Zielgruppeneinschränkungen des Kontos in Sätzen (Mindestalter, Länder) */
  zielgruppen_einschraenkungen: string[]
  /** false = account_controls nicht lesbar (Rechte, Rate-Limit oder Meta liefert nichts) */
  einschraenkungen_lesbar: boolean
  markenschutz: KontoMarkenschutz[]
  blocklisten: KontoBlockliste[]
  blocklisten_lesbar: boolean
  /** Hinweis Sonderkategorie Wohnen (kontoweite Einschränkungen greifen dort nicht) */
  wohnen_hinweis: string
  /** erfolgreiche Änderungen am Ausgabenlimit über das CRM in den letzten 24 Stunden (null = Protokoll nicht lesbar) */
  limit_aenderungen_24h: number | null
  limit_aenderungen_max: number
  /** darf der Aufrufer das Ausgabenlimit ändern? Sonst steht der Grund in limit_sperrgrund (grau anzeigen) */
  darf_limit_aendern: boolean
  limit_sperrgrund: string | null
  /** darf der Aufrufer Kommentare beantworten/ausblenden? Sonst Grund in kommentare_sperrgrund */
  darf_kommentare: boolean
  kommentare_sperrgrund: string | null
  hinweise: string[]
  geladen: string
  usage: KontoUsage
}

// ── Ausgabenlimit des Kontos (nur Admin) ────────────────────────────────────

export interface KontoAusgabenlimitRequest {
  /** neues Limit in Cent der Kontowährung (ganze Zahl > 0); alternativ entfernen: true */
  spend_cap_cents?: number
  /** true = Limit entfernen (Meta: spend_cap 0) */
  entfernen?: boolean
  /** Pflicht (true) außer bei vorschau: true */
  confirm?: boolean
  /** true = nur zeigen, was an Meta ginge, nichts senden */
  vorschau?: boolean
}

export type AusgabenlimitPruefung = 'ok' | 'abweichung' | 'nicht_gelesen' | 'vorschau'

export interface KontoAusgabenlimitResponse {
  ok: true
  vorschau: boolean
  waehrung: string | null
  vorher_cents: number | null
  /** null = Limit entfernt */
  nachher_cents: number | null
  nachher_eur: number | null
  /** was an Meta ging bzw. ginge (spend_cap in ganzen Einheiten der Kontowährung) */
  payload: Record<string, unknown>
  /** Kontrolle nach dem Schreiben: Meta liest das Limit so zurück, wie gewollt? */
  pruefung: AusgabenlimitPruefung
  gelesen_cents: number | null
  limit_aenderungen_24h: number | null
  hinweise: string[]
}

// ── Kommentare ──────────────────────────────────────────────────────────────

export type KommentarPlattform = 'facebook' | 'instagram'
export const KOMMENTAR_PLATTFORMEN: readonly KommentarPlattform[] = ['facebook', 'instagram']
export const KOMMENTAR_PLATTFORM_LABEL: Readonly<Record<KommentarPlattform, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
}

/** Höchstlänge einer Antwort (Instagram erlaubt 2.200, Facebook mehr) */
export const KOMMENTAR_TEXT_MAX = 2000
/** Diese Lint-Regeln (metaLint) blockieren eine Antwort; alle anderen Treffer (z. B. persoenlich, de_bashing) sind nur Hinweise. */
export const KOMMENTAR_LINT_BLOCKER: readonly string[] = [
  'gedankenstrich', 'umlaut', 'projektname', 'rendite_prozent', 'finanzierung', 'garantie',
]

export interface KommentareListRequest {
  /** nur diese Anzeigen (höchstens 25); sonst die Anzeigen des Kontos (aktive zuerst) */
  ad_ids?: string[]
  /** nur Kommentare ab diesem Zeitpunkt (ISO) */
  since?: string
  /** nur Kommentare ohne Antwort von uns (auch die mit unbekanntem Stand, beantwortet: null) */
  nur_unbeantwortet?: boolean
  /** nur eine Plattform */
  plattform?: KommentarPlattform
  /** höchstens so viele Beiträge abfragen (Standard 30, höchstens 60; je Beitrag ein Meta-Aufruf) */
  max_beitraege?: number
}

export interface KommentarAntwort {
  id: string
  text: string
  zeit: string | null
  /** von unserer Seite bzw. unserem Instagram-Konto */
  von_uns: boolean
  /** Name bzw. Instagram-Name (keine weiteren Daten) */
  autor: string | null
}

export interface KommentarAnzeigeRef { id: string; name: string; status: string | null }

export interface Kommentar {
  id: string
  plattform: KommentarPlattform
  /** Anzeige, unter deren Beitrag der Kommentar steht (bei geteilten Beiträgen die erste, aktive zuerst) */
  ad_id: string
  ad_name: string
  /** weitere Anzeigen mit demselben Beitrag */
  weitere_anzeigen: KommentarAnzeigeRef[]
  /** Facebook: effective_object_story_id; Instagram: effective_instagram_media_id */
  beitrag_id: string
  beitrag_link: string | null
  /** Link zum Kommentar (Facebook) bzw. zum Beitrag (Instagram) */
  link: string | null
  autor: string | null
  text: string
  zeit: string | null
  ausgeblendet: boolean
  /** mindestens eine Antwort von uns; null = unbekannt (Meta lieferte die Antworten nicht vollständig) */
  beantwortet: boolean | null
  antworten: KommentarAntwort[]
  antworten_anzahl: number
  likes: number | null
  /** Meta erlaubt Ausblenden (null = unbekannt) */
  kann_ausblenden: boolean | null
  /** Meta erlaubt Antworten (null = unbekannt) */
  kann_antworten: boolean | null
}

export interface KommentarBeitrag {
  beitrag_id: string
  plattform: KommentarPlattform
  link: string | null
  anzeigen: KommentarAnzeigeRef[]
  /** Kommentare nach Filter */
  anzahl: number
  /** sicher unbeantwortet (beantwortet === false) und nicht ausgeblendet */
  offen: number
  /** Meta hatte mehr Kommentare als abgefragt */
  gekuerzt: boolean
  fehler: string | null
}

export interface KommentareListResponse {
  /** neueste zuerst */
  kommentare: Kommentar[]
  beitraege: KommentarBeitrag[]
  anzahl: number
  /** sicher unbeantwortet (beantwortet === false) und nicht ausgeblendet */
  offen: number
  anzeigen_geprueft: number
  /** Anzeigen ohne veröffentlichten Beitrag (noch nie ausgeliefert) */
  anzeigen_ohne_beitrag: number
  /** nicht alle Beiträge abgefragt (Obergrenze oder Meta-Auslastung) */
  gekuerzt: boolean
  instagram_konto: { id: string; name: string | null } | null
  hinweise: string[]
  geladen: string
  usage: KontoUsage
}

export interface KommentarAntwortenRequest {
  comment_id: string
  plattform: KommentarPlattform
  text: string
  /** Pflicht: true (nur per Klick eines Menschen) */
  confirm?: boolean
  /** optional zur Kontrolle: Beitrag aus kommentare_list */
  beitrag_id?: string
}

export interface KommentarLintTreffer {
  regel: string
  schwere: 'blocker' | 'warn' | 'manual'
  fundstelle: string | null
  /** i18n-Schlüssel aus metaLint (crm.werbung.lint.<regel>) */
  meldung_key: string
}

export interface KommentarAntwortenResponse {
  ok: true
  comment_id: string
  plattform: KommentarPlattform
  antwort_id: string
  text: string
  /** nicht blockierende Lint-Treffer */
  hinweise: KommentarLintTreffer[]
}

export interface KommentarAusblendenRequest {
  comment_id: string
  plattform: KommentarPlattform
  /** true = ausblenden, false = wieder einblenden */
  hide: boolean
  beitrag_id?: string
}

export interface KommentarAusblendenResponse {
  ok: true
  comment_id: string
  plattform: KommentarPlattform
  /** Zustand nach dem Schreiben (gelesen, sonst wie angefordert) */
  ausgeblendet: boolean
  geprueft: boolean
}

// ── Zuordnung Modus -> Anfrage/Antwort ──────────────────────────────────────

export interface KontoRequestMap {
  konto: KontoAbrufRequest
  konto_ausgabenlimit: KontoAusgabenlimitRequest
  kommentare_list: KommentareListRequest
  kommentar_antworten: KommentarAntwortenRequest
  kommentar_ausblenden: KommentarAusblendenRequest
}
export interface KontoResponseMap {
  konto: KontoResponse
  konto_ausgabenlimit: KontoAusgabenlimitResponse
  kommentare_list: KommentareListResponse
  kommentar_antworten: KommentarAntwortenResponse
  kommentar_ausblenden: KommentarAusblendenResponse
}
export type KontoRequest<M extends KontoMode = KontoMode> = M extends KontoMode ? { mode: M } & KontoRequestMap[M] : never
export type KontoAntwort<M extends KontoMode> = KontoResponseMap[M]
