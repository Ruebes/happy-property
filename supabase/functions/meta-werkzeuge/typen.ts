// IDENTISCH zu supabase/functions/meta-werkzeuge/typen.ts (bzw. src/lib/werbeWerkzeuge.ts). Änderungen immer in beiden Dateien.
//
// Anfrage- und Antworttypen der Edge Function meta-werkzeuge (Werbemanager:
// Zielgruppen, Sofortformulare, benutzerdefinierte Conversions, Pixel-Diagnose).
// Reine Typen und Konstanten, keine Imports: die Datei wird byte-gleich im
// Frontend (src/lib) und in der Edge Function benutzt.
//
// Aufruf im Frontend:
//   supabase.functions.invoke('meta-werkzeuge', { body: { mode: 'audiences_list' } })
// Fehler kommen als { error, hint?, code?, data?, meta? } (code aus WERKZEUG_ERROR_CODES).
//
// Regeln (Sven): nichts wird bei Meta gelöscht oder archiviert. Lookalikes sind
// unter der Sonderkategorie Wohnen gesperrt. Kundenlisten nur nach Svens Freigabe
// (ad_settings.kundenliste_freigegeben) und nur durch einen Admin; E-Mail und
// Telefon werden serverseitig gehasht, nie protokolliert. Jeder Schreib-Modus
// kennt vorschau: true (zeigt, was an Meta ginge, ohne etwas zu senden).

// ── Modi ────────────────────────────────────────────────────────────────────

export const WERKZEUG_MODES = [
  'audiences_list', 'audience_create_website', 'audience_create_engagement', 'audience_create_lookalike',
  'audience_create_customer_list', 'leadforms_list', 'leadform_get', 'leadform_create', 'leadform_duplicate',
  'custom_conversions_list', 'custom_conversion_create', 'pixel_diagnose',
] as const
export type WerkzeugMode = typeof WERKZEUG_MODES[number]

/** Schreiben bei Meta: Recht „Werbung“ + ad_settings.builder_enabled + META_WRITES_DISABLED != 1 (außer vorschau: true). */
export const WERKZEUG_WRITE_MODES: readonly WerkzeugMode[] = [
  'audience_create_website', 'audience_create_engagement', 'audience_create_lookalike', 'audience_create_customer_list',
  'leadform_create', 'leadform_duplicate', 'custom_conversion_create',
]

export const WERKZEUG_ERROR_CODES = [
  'builder_disabled', 'writes_disabled', 'forbidden', 'not_found', 'invalid_request', 'lint_blocked',
  'housing_forbidden', 'kundenliste_gesperrt', 'limit_reached', 'unsupported', 'rate_limited', 'app_dev_mode',
  'meta_error', 'internal',
] as const
export type WerkzeugErrorCode = typeof WERKZEUG_ERROR_CODES[number]
export interface WerkzeugErrorBody { error: string; hint?: string; code?: WerkzeugErrorCode | string; data?: unknown; meta?: unknown }

/** Meta-Rate-Limit-Auslastung der letzten Antwort */
export interface WerkzeugUsage { accUtilPct: number | null; resetSec: number | null; tier: string | null }

/** Wofür eine Zielgruppe gedacht ist. 'housing' = Sonderkategorie Wohnen (HP-Standard). */
export type WerbeKontext = 'housing' | 'standard'

/** Jede Schreib-Antwort: vorschau true = nichts gesendet, payload zeigt, was an Meta ginge. */
export interface WerkzeugSchreibBasis {
  vorschau: boolean
  /** Was an Meta geht (ohne Personendaten) */
  payload: Record<string, unknown>
  hinweise: string[]
}

// ── Zielgruppen ─────────────────────────────────────────────────────────────

export type ZielgruppenArt = 'website' | 'interaktion' | 'video' | 'kundenliste' | 'lookalike' | 'sonstige'

export const ZIELGRUPPEN_ART_LABEL: Readonly<Record<ZielgruppenArt, string>> = {
  website: 'Website',
  interaktion: 'Interaktion',
  video: 'Video',
  kundenliste: 'Kundenliste',
  lookalike: 'Lookalike Audience',
  sonstige: 'Sonstige',
}

export interface Zielgruppe {
  id: string
  name: string
  art: ZielgruppenArt
  /** Metas subtype (WEBSITE, ENGAGEMENT, CUSTOM, LOOKALIKE, ...) */
  subtype: string | null
  beschreibung: string | null
  /** geschätzte Größe (Meta liefert -1 bei inaktiven Lookalikes -> null) */
  groesse_min: number | null
  groesse_max: number | null
  /** Verweildauer in Tagen (aus retention_days oder der Regel) */
  aufbewahrung_tage: number | null
  /** Regel in einfachem Deutsch, z. B. „Website: URL enthält „/termin“ (30 Tage)“ */
  regel_zusammenfassung: string
  /** Auslieferbar? delivery_status.code 200 = bereit */
  auslieferung: { code: number | null; text: string | null }
  /** operation_status (471 = von Meta gesperrt) */
  bearbeitung: { code: number | null; text: string | null }
  /** Für Sonderkategorie Wohnen im Land `sac_land` nutzbar? null = nicht geprüft/unbekannt */
  sac_eligible: boolean | null
  sac_grund?: string
  /** Lookalike oder von Meta für Wohnen abgelehnt: im Assistenten grau mit Grund */
  gesperrt_fuer_wohnen: boolean
  lookalike?: { quelle_id: string | null; quelle_name: string | null; ratio: number | null; land: string | null }
  erstellt: string | null
  aktualisiert: string | null
}

export interface AudiencesListRequest {
  /** Housing-Eignung prüfen (Standard true, höchstens 25 Zielgruppen je Aufruf, Abbruch über 75 % Auslastung) */
  sac_pruefen?: boolean
  /** Land der Sonderkategorie Wohnen, Standard 'DE' */
  sac_land?: string
}
export interface AudiencesListResponse {
  items: Zielgruppe[]
  sac: { land: string; geprueft: number; offen: number }
  warnings: string[]
  usage?: WerkzeugUsage
}

export type WebsiteRegelArt = 'url_enthaelt' | 'url_gleich' | 'event'
export const WEBSITE_REGEL_ART_LABEL: Readonly<Record<WebsiteRegelArt, string>> = {
  url_enthaelt: 'URL enthält',
  url_gleich: 'URL ist gleich',
  event: 'Ereignis',
}
export interface WebsiteRegel { art: WebsiteRegelArt; wert: string }

/** Website-Besucher: Meta erlaubt 1 bis 180 Tage */
export const WEBSITE_MAX_TAGE = 180
export const WEBSITE_MAX_REGELN = 20

export interface AudienceCreateWebsiteRequest {
  name: string
  /** Standard: ad_settings.default_pixel_id */
  pixel_id?: string
  regeln: WebsiteRegel[]
  /** 'oder' (Standard): eine der Regeln reicht; 'und': alle müssen zutreffen */
  verknuepfung?: 'oder' | 'und'
  tage: number
  ausschluss_regeln?: WebsiteRegel[]
  /** Standard: tage */
  ausschluss_tage?: number
  beschreibung?: string
  vorschau?: boolean
}

export type InteraktionsQuelle = 'page' | 'instagram' | 'video' | 'leadform'
export const INTERAKTION_QUELLE_LABEL: Readonly<Record<InteraktionsQuelle, string>> = {
  page: 'Facebook-Seite',
  instagram: 'Instagram-Konto',
  video: 'Video',
  leadform: 'Sofortformular',
}
/** Höchste Verweildauer je Quelle laut Meta */
export const INTERAKTION_MAX_TAGE: Readonly<Record<InteraktionsQuelle, number>> = { page: 730, instagram: 730, video: 365, leadform: 90 }

export interface InteraktionsArt { quelle: InteraktionsQuelle; wert: string; label: string }
/** Ereignisse wie im Werbeanzeigenmanager (wert = Metas event_name) */
export const INTERAKTION_ARTEN: readonly InteraktionsArt[] = [
  { quelle: 'page', wert: 'page_engaged', label: 'Alle, die mit deiner Seite interagiert haben' },
  { quelle: 'page', wert: 'page_visited', label: 'Alle, die deine Seite besucht haben' },
  { quelle: 'page', wert: 'page_post_interaction', label: 'Personen, die mit einem Beitrag oder einer Werbeanzeige interagiert haben' },
  { quelle: 'page', wert: 'page_cta_clicked', label: 'Personen, die auf einen Call-to-Action-Button geklickt haben' },
  { quelle: 'page', wert: 'page_or_post_save', label: 'Personen, die deine Seite oder einen Beitrag gespeichert haben' },
  { quelle: 'page', wert: 'page_messaged', label: 'Personen, die deiner Seite eine Nachricht gesendet haben' },
  { quelle: 'instagram', wert: 'ig_business_profile_all', label: 'Alle, die mit diesem professionellen Konto interagiert haben' },
  { quelle: 'instagram', wert: 'ig_business_profile_visit', label: 'Alle, die das Profil dieses professionellen Kontos besucht haben' },
  { quelle: 'instagram', wert: 'ig_business_profile_engaged', label: 'Personen, die mit einem Beitrag oder einer Werbeanzeige interagiert haben' },
  { quelle: 'instagram', wert: 'ig_business_profile_ad_saved', label: 'Personen, die einen Beitrag oder eine Werbeanzeige gespeichert haben' },
  { quelle: 'instagram', wert: 'ig_user_messaged_business', label: 'Personen, die diesem professionellen Konto eine Nachricht gesendet haben' },
  { quelle: 'instagram', wert: 'ig_ad_cta_click', label: 'Personen, die in einer Werbeanzeige auf den Button geklickt haben' },
  { quelle: 'video', wert: 'video_watched', label: 'Personen, die dein Video mindestens 3 Sekunden angesehen haben' },
  { quelle: 'video', wert: 'video_view_15s', label: 'Personen, die dein Video mindestens 15 Sekunden angesehen haben' },
  { quelle: 'video', wert: 'video_view_25_percent', label: 'Personen, die mindestens 25 % deines Videos angesehen haben' },
  { quelle: 'video', wert: 'video_view_50_percent', label: 'Personen, die mindestens 50 % deines Videos angesehen haben' },
  { quelle: 'video', wert: 'video_view_75_percent', label: 'Personen, die mindestens 75 % deines Videos angesehen haben' },
  { quelle: 'video', wert: 'video_completed', label: 'Personen, die mindestens 95 % deines Videos angesehen haben' },
  { quelle: 'leadform', wert: 'lead_generation_opened', label: 'Personen, die dieses Formular geöffnet haben' },
  { quelle: 'leadform', wert: 'lead_generation_dropoff', label: 'Personen, die dieses Formular geöffnet, aber nicht abgeschickt haben' },
  { quelle: 'leadform', wert: 'lead_generation_submitted', label: 'Personen, die dieses Formular geöffnet und abgeschickt haben' },
]

export interface AudienceCreateEngagementRequest {
  name: string
  quelle: InteraktionsQuelle
  /** page: Seiten-IDs (Standard: HP-Seite); instagram: IG-Konto (Standard: das der Seite); video/leadform: Pflicht */
  objekt_ids?: string[]
  /** INTERAKTION_ARTEN.wert der Quelle; Kurzformen leadform_opened/leadform_submitted/leadform_dropoff gehen auch */
  art: string
  tage: number
  beschreibung?: string
  vorschau?: boolean
}

/** Lookalike-Größe 1 % bis 10 % (Meta: Schritte von 1 %) */
export const LOOKALIKE_RATIO_MIN = 0.01
export const LOOKALIKE_RATIO_MAX = 0.10

export interface AudienceCreateLookalikeRequest {
  name: string
  /** Quell-Zielgruppe (Custom Audience des Werbekontos, mindestens 100 Personen) */
  source_id: string
  /** Seit 1.9.2026 legt Meta Lookalikes ohne Land an (Land kommt aus der Anzeigengruppe); land steht nur in der Beschreibung */
  land: string
  ratio: number
  /** Standard 'housing': dann lehnt der Server ab (Lookalikes sind unter Wohnen verboten) */
  kontext?: WerbeKontext
  beschreibung?: string
  vorschau?: boolean
}

export interface AudienceCreateResponse extends WerkzeugSchreibBasis {
  /** null bei vorschau */
  audience_id: string | null
  name: string
  /** Housing-Eignung (DE) direkt nach dem Anlegen; null = unbekannt */
  sac_eligible: boolean | null
}

/** Filter für die CRM-Kundenliste (alles optional, leer = alle nicht archivierten Leads) */
export interface KundenlisteFilter {
  /** leads.status (z. B. qualified, registered, sold) */
  status?: string[]
  /** Svens Bewertung */
  qualitaet?: Array<'gut' | 'schlecht'>
  /** nur Leads mit Deal in einer dieser Phasen (deals.phase) */
  deal_phasen?: string[]
  /** angelegt ab / bis (YYYY-MM-DD) */
  seit?: string
  bis?: string
  /** nur Leads aus Meta-Werbung (utm_source meta/facebook/fb/instagram/ig oder source meta) */
  nur_meta?: boolean
  /** auch Leads mit Status archived */
  mit_archivierten?: boolean
}

export const KUNDENLISTE_MAX = 10_000
export const KUNDENLISTE_LABELS = ['QUALIFIED_LEADS', 'DISQUALIFIED_LEADS', 'ENGAGED_USERS', 'CUSTOMERS', 'HIGH_VALUE_CUSTOMERS'] as const
export type KundenlisteLabel = typeof KUNDENLISTE_LABELS[number]

/** Pflichthinweis vor dem Hochladen (UI zeigt ihn, Server nennt ihn bei fehlendem confirm) */
export const KUNDENLISTE_DSGVO_HINWEIS =
  'Kundenlisten enthalten personenbezogene Daten. Hochladen nur, wenn eine Rechtsgrundlage (Einwilligung oder berechtigtes Interesse mit Widerspruchsmöglichkeit) besteht. ' +
  'E-Mail und Telefon werden vor dem Senden gehasht (SHA-256), Meta gleicht nur ab. Interne Kontakte und Kontakte mit Widerspruch werden nie hochgeladen.'

export interface AudienceCreateCustomerListRequest {
  name: string
  quelle: 'crm'
  filter: KundenlisteFilter
  /** Pflicht für das echte Anlegen: DSGVO-Hinweis gelesen, Sven hat freigegeben */
  confirm: true
  label?: KundenlisteLabel
  beschreibung?: string
  /** nur zählen, nichts an Meta (Admin) */
  vorschau?: boolean
}
export interface AudienceCreateCustomerListResponse extends WerkzeugSchreibBasis {
  audience_id: string | null
  name: string
  /** Kontakte nach Filter und Ausschlüssen (mit E-Mail oder Telefon) */
  kontakte: number
  mit_email: number
  mit_telefon: number
  ausgeschlossen: { intern: number; widerspruch: number; ohne_kontakt: number; doppelt: number }
  /** von Meta angenommen (num_received) */
  hochgeladen: number
  /** von Meta als ungültig gezählt (num_invalid_entries) */
  ungueltig: number | null
  sac_eligible: boolean | null
  /** gesetzt, wenn die Liste angelegt, das Hochladen aber gescheitert ist (Liste bleibt leer bei Meta) */
  fehler?: string
}

// ── Sofortformulare ─────────────────────────────────────────────────────────

/** Formulartyp wie im Werbeanzeigenmanager: Höheres Volumen (Standard bei Meta) / Höhere Absicht (Bestätigungsschritt, HP-Standard) */
export type LeadFormTyp = 'MORE_VOLUME' | 'HIGHER_INTENT'
export const LEADFORM_TYP_LABEL: Readonly<Record<LeadFormTyp, string>> = {
  MORE_VOLUME: 'Höheres Volumen',
  HIGHER_INTENT: 'Höhere Absicht',
}
export type LeadFormLocale = 'de_DE' | 'en_US' | 'en_GB'

export const LEADFORM_VORDEFINIERT = [
  'FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'WHATSAPP_NUMBER', 'COMPANY_NAME', 'JOB_TITLE',
  'WORK_EMAIL', 'WORK_PHONE_NUMBER', 'CITY', 'COUNTRY', 'ZIP', 'POST_CODE', 'STATE', 'PROVINCE', 'STREET_ADDRESS',
  'DOB', 'GENDER', 'MARITIAL_STATUS', 'RELATIONSHIP_STATUS',
] as const
export type LeadFormVordefiniert = typeof LEADFORM_VORDEFINIERT[number]
export type LeadFormFrageTyp = LeadFormVordefiniert | 'CUSTOM' | 'DATE_TIME'

export const LEADFORM_FRAGE_LABEL: Readonly<Record<LeadFormFrageTyp, string>> = {
  FULL_NAME: 'Vollständiger Name', FIRST_NAME: 'Vorname', LAST_NAME: 'Nachname', EMAIL: 'E-Mail',
  PHONE: 'Telefonnummer', WHATSAPP_NUMBER: 'WhatsApp-Nummer', COMPANY_NAME: 'Unternehmensname', JOB_TITLE: 'Berufsbezeichnung',
  WORK_EMAIL: 'Geschäftliche E-Mail', WORK_PHONE_NUMBER: 'Geschäftliche Telefonnummer', CITY: 'Stadt', COUNTRY: 'Land',
  ZIP: 'Postleitzahl', POST_CODE: 'Postleitzahl', STATE: 'Bundesland', PROVINCE: 'Provinz', STREET_ADDRESS: 'Adresse',
  DOB: 'Geburtsdatum', GENDER: 'Geschlecht', MARITIAL_STATUS: 'Familienstand', RELATIONSHIP_STATUS: 'Beziehungsstatus',
  CUSTOM: 'Eigene Frage', DATE_TIME: 'Terminanfrage',
}

/** Unter Wohnen gesperrt (Alter, Geschlecht, Familienstand, Standort): im Editor grau mit Grund */
export const LEADFORM_WOHNEN_VERBOTEN: readonly LeadFormFrageTyp[] = [
  'DOB', 'GENDER', 'MARITIAL_STATUS', 'RELATIONSHIP_STATUS', 'CITY', 'COUNTRY', 'ZIP', 'POST_CODE', 'STATE', 'PROVINCE', 'STREET_ADDRESS',
]
export const LEADFORM_WOHNEN_GRUND = 'Unter der Sonderkategorie Wohnen sind Fragen nach Alter, Geschlecht, Familienstand und Standort nicht erlaubt.'

/** Bedingte Logik („Wenn Antwort A, dann Frage B“) kann Meta per API nicht anlegen: nur im Werbeanzeigenmanager */
export const LEADFORM_BEDINGTE_LOGIK_PER_API = false
export const LEADFORM_MAX_EIGENE_FRAGEN = 15
export const LEADFORM_MAX_EINWILLIGUNGEN = 5

/** Eigene Fragen: Mehrfachauswahl (mit Antworten) oder Kurze Antwort (ohne Antworten) */
export type LeadFormEigeneArt = 'MULTIPLE_CHOICE' | 'SHORT_ANSWER'

/** Strukturell ein Obertyp von metaSpec LeadFormQuestion */
export interface LeadFormFrage {
  type: LeadFormFrageTyp
  /** nur CUSTOM / DATE_TIME: eindeutiger Schlüssel (a-z, 0-9, _) */
  key?: string
  /** nur CUSTOM / DATE_TIME: Fragetext */
  label?: string
  /** nur CUSTOM: Standard MULTIPLE_CHOICE, wenn options gesetzt, sonst SHORT_ANSWER */
  custom_art?: LeadFormEigeneArt
  options?: Array<{ value: string; key?: string }>
  /** Erklärtext unter der Frage (inline_context) */
  inline_context?: string
}

export interface LeadFormEinwilligung { key?: string; text: string; /** Standard true */ pflicht?: boolean }

/** Strukturell ein Obertyp von metaSpec LeadFormSpec (meta-builder leadform_create) */
export interface LeadFormSpecErweitert {
  name: string
  locale?: LeadFormLocale
  /** Standard HIGHER_INTENT; higher_intent (alt) wird weiter verstanden */
  typ?: LeadFormTyp
  higher_intent?: boolean
  privacy_policy_url: string
  privacy_link_text?: string
  questions: LeadFormFrage[]
  /** Überschrift über den Fragen */
  fragen_ueberschrift?: string
  intro_headline?: string
  intro_text?: string
  /** PARAGRAPH (Fließtext, Standard) oder LIST (Stichpunkte aus intro_punkte) */
  intro_stil?: 'PARAGRAPH' | 'LIST'
  intro_punkte?: string[]
  /** Eigener Haftungsausschluss mit Einwilligungs-Kästchen (nie vorausgewählt) */
  einwilligungen?: { titel?: string; text?: string; checkboxen: LeadFormEinwilligung[] }
  thank_you_title?: string
  thank_you_body?: string
  /** Standard: VIEW_WEBSITE, wenn thank_you_url gesetzt, sonst NONE */
  thank_you_button?: 'VIEW_WEBSITE' | 'NONE'
  thank_you_button_text?: string
  thank_you_url?: string
  /** SMS-Bestätigung der Telefonnummer (braucht Frage PHONE) */
  sms_bestaetigung?: boolean
  /** Standard true: organische Leads (ohne Werbeanzeige) ausblenden */
  nur_beworbene_leads?: boolean
  /** werden mit jedem Lead zurückgeliefert */
  tracking_parameter?: Record<string, string>
  /** Standard true: Sonderkategorie Wohnen (sperrt LEADFORM_WOHNEN_VERBOTEN) */
  wohnen?: boolean
}

export interface LeadFormZeile {
  id: string
  name: string
  status: string | null
  locale: string | null
  leads_count: number | null
  erstellt: string | null
  typ: LeadFormTyp | null
}
export interface LeadformsListRequest { page_id?: string }
export interface LeadformsListResponse { page_id: string; items: LeadFormZeile[]; warnings: string[] }

export interface LeadformGetRequest { id: string; page_id?: string }
export interface LeadformGetResponse {
  form: LeadFormZeile & { page_id: string | null }
  /** Für den Editor (Kopie bearbeiten); was nicht übernommen werden konnte steht in nicht_uebernommen */
  spec: LeadFormSpecErweitert
  nicht_uebernommen: string[]
  warnings: string[]
}

export interface LeadformCreateWerkzeugRequest { page_id?: string; spec: LeadFormSpecErweitert; vorschau?: boolean }
export interface LeadformCreateWerkzeugResponse extends WerkzeugSchreibBasis { form_id: string | null; page_id: string }

export interface LeadformDuplicateRequest {
  id: string
  name: string
  page_id?: string
  /** Standard true: Wohnen-Prüfung der Fragen */
  wohnen?: boolean
  vorschau?: boolean
}
export interface LeadformDuplicateResponse extends WerkzeugSchreibBasis { form_id: string | null; quelle_id: string; page_id: string }

// ── Benutzerdefinierte Conversions ──────────────────────────────────────────

/** Metas custom_event_type (Kategorie), HP-relevante zuerst */
export const CUSTOM_EVENT_TYPES = [
  'LEAD', 'SCHEDULE', 'COMPLETE_REGISTRATION', 'CONTACT', 'SUBMIT_APPLICATION', 'SUBSCRIBE', 'CONTENT_VIEW', 'SEARCH',
  'PURCHASE', 'START_TRIAL', 'FIND_LOCATION', 'CUSTOMIZE_PRODUCT', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'INITIATED_CHECKOUT',
  'ADD_PAYMENT_INFO', 'DONATE', 'LISTING_INTERACTION', 'OTHER',
] as const
export type CustomEventType = typeof CUSTOM_EVENT_TYPES[number]
export const CUSTOM_EVENT_TYPE_LABEL: Readonly<Record<CustomEventType, string>> = {
  LEAD: 'Lead', SCHEDULE: 'Termin vereinbaren', COMPLETE_REGISTRATION: 'Registrierung abschließen', CONTACT: 'Kontakt',
  SUBMIT_APPLICATION: 'Bewerbung einreichen', SUBSCRIBE: 'Abonnieren', CONTENT_VIEW: 'Inhalte ansehen', SEARCH: 'Suchen',
  PURCHASE: 'Kauf', START_TRIAL: 'Testphase starten', FIND_LOCATION: 'Standort suchen', CUSTOMIZE_PRODUCT: 'Produkt anpassen',
  ADD_TO_CART: 'In den Warenkorb', ADD_TO_WISHLIST: 'Zur Wunschliste hinzufügen', INITIATED_CHECKOUT: 'Bezahlvorgang starten',
  ADD_PAYMENT_INFO: 'Zahlungsinformationen hinzufügen', DONATE: 'Spenden', LISTING_INTERACTION: 'Interaktion mit Angebot', OTHER: 'Andere',
}
/** Pixel-Ereignisse, die HP sendet (Standard + eigene); weitere Namen sind erlaubt */
export const PIXEL_EREIGNISSE = ['Lead', 'Schedule', 'CompleteRegistration', 'Contact', 'SubmitApplication', 'ViewContent', 'PageView', 'QualifiedLead', 'AppointmentHeld', 'Purchase'] as const
/** Meta: höchstens 100 benutzerdefinierte Conversions je Werbekonto */
export const CUSTOM_CONVERSIONS_MAX = 100

export interface CustomConversionZeile {
  id: string
  name: string
  kategorie: string | null
  pixel_id: string | null
  regel_zusammenfassung: string
  letzte_aktivitaet: string | null
  archiviert: boolean
  nicht_verfuegbar: boolean
  erstellt: string | null
}
export interface CustomConversionsListRequest { mit_archivierten?: boolean }
export interface CustomConversionsListResponse { items: CustomConversionZeile[]; anzahl_aktiv: number; max: number; warnings: string[] }

export interface CustomConversionCreateRequest {
  name: string
  /** Standard: ad_settings.default_pixel_id */
  pixel_id?: string
  /** Pixel-Ereignis (z. B. Lead, Schedule, QualifiedLead); mindestens ereignis ODER url_regeln */
  ereignis?: string
  /** Alias für ereignis (Vertrag SPEC2: event); ereignis hat Vorrang */
  event?: string
  /** zusätzlich (oder allein): URL-Bedingungen, eine davon reicht */
  url_regeln?: Array<{ art: 'url_enthaelt' | 'url_gleich'; wert: string }>
  kategorie: CustomEventType
  beschreibung?: string
  /** Standardwert je Conversion in Kontowährung */
  standardwert?: number
  vorschau?: boolean
}
export interface CustomConversionCreateResponse extends WerkzeugSchreibBasis { conversion_id: string | null }

// ── Pixel-Diagnose ──────────────────────────────────────────────────────────

export interface PixelDiagnoseRequest { pixel_id?: string }
export interface PixelEmq {
  ereignis: string
  /** Event Match Quality 0 bis 10 */
  score: number | null
  merkmale: Array<{ merkmal: string; abdeckung_pct: number | null }>
  diagnosen: Array<{ name: string; beschreibung: string | null; loesung: string | null; anteil_pct: number | null }>
}
export interface PixelDiagnoseResponse {
  id: string
  name: string | null
  /** gehört zum Werbekonto (act_X/adspixels); null = nicht prüfbar */
  im_konto: boolean | null
  ist_hp_pixel: boolean
  letzter_empfang: string | null
  stunden_seit_empfang: number | null
  nicht_verfuegbar: boolean
  /** Ereignisse der letzten 24 Stunden (Pixel-Statistik) */
  ereignisse_24h: Array<{ ereignis: string; anzahl: number }>
  /** Datensatzqualität (Dataset Quality API), leer wenn Meta nichts liefert */
  emq: PixelEmq[]
  ampel: 'gruen' | 'gelb' | 'rot'
  hinweise: string[]
  warnings: string[]
}

// ── Typ-Zuordnung ───────────────────────────────────────────────────────────

export interface WerkzeugRequestMap {
  audiences_list: AudiencesListRequest
  audience_create_website: AudienceCreateWebsiteRequest
  audience_create_engagement: AudienceCreateEngagementRequest
  audience_create_lookalike: AudienceCreateLookalikeRequest
  audience_create_customer_list: AudienceCreateCustomerListRequest
  leadforms_list: LeadformsListRequest
  leadform_get: LeadformGetRequest
  leadform_create: LeadformCreateWerkzeugRequest
  leadform_duplicate: LeadformDuplicateRequest
  custom_conversions_list: CustomConversionsListRequest
  custom_conversion_create: CustomConversionCreateRequest
  pixel_diagnose: PixelDiagnoseRequest
}
export interface WerkzeugResponseMap {
  audiences_list: AudiencesListResponse
  audience_create_website: AudienceCreateResponse
  audience_create_engagement: AudienceCreateResponse
  audience_create_lookalike: AudienceCreateResponse
  audience_create_customer_list: AudienceCreateCustomerListResponse
  leadforms_list: LeadformsListResponse
  leadform_get: LeadformGetResponse
  leadform_create: LeadformCreateWerkzeugResponse
  leadform_duplicate: LeadformDuplicateResponse
  custom_conversions_list: CustomConversionsListResponse
  custom_conversion_create: CustomConversionCreateResponse
  pixel_diagnose: PixelDiagnoseResponse
}
export type WerkzeugRequest<M extends WerkzeugMode = WerkzeugMode> = M extends WerkzeugMode ? { mode: M } & WerkzeugRequestMap[M] : never
export type WerkzeugResponse<M extends WerkzeugMode> = WerkzeugResponseMap[M]
