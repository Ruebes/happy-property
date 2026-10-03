// IDENTISCH zu src/lib/metaSpec.ts (bzw. supabase/functions/_shared/metaSpec.ts). Änderungen immer in beiden Dateien; npm run verify:meta prüft das.
//
// Meta-Werbeeinstellungen als EINE Quelle der Wahrheit für den Kampagnen-Assistenten
// (Frontend, src/components/crm/werbung/kampagnen/) und die Edge Function
// meta-builder (Server). Stand der Fakten: Meta Marketing API Oktober 2026
// (Recherche scratchpad/ads/03-meta-campaign-adset.md + 04-meta-ad-creative.md).
//
// Inhalt:
//   1. HP-Konstanten (Pixel, Seite, UTM-Schema, Plan-B-Landingpages)
//   2. Enums + Optionen je Ebene (Ziel, Sonderkategorie, Conversion-Ort,
//      Leistungsziel, Abrechnung, Ereignis, Attribution, Gebotsstrategie,
//      Platzierungen v26-bereinigt, Markensicherheit, CTA, Advantage+ Creative)
//   3. Entwurfs-Typen (DraftSpec = meta_drafts.spec, v = 1)
//   4. Abhängigkeiten: Ziel -> Conversion-Ort -> Leistungsziel -> Abrechnung ->
//      promoted_object -> Attribution; CTA je Ziel der Anzeige
//   5. FieldSpec-Register (Label = i18n-Schlüssel crm.werbung.meta.*)
//   6. validateDraft, applyHousing, build*Payload, apiPathToFieldKey
//   7. Vorlagen (TEMPLATES.plan_b)
//   8. Anfrage-/Antwort-Typen der Edge Function meta-builder
//
// Regeln: rein, KEINE Imports. Muss unter src/tsconfig (strict, lib ES2020,
// noUnusedLocals/Parameters) UND unter Deno kompilieren: kein .at(), kein
// Object.hasOwn, kein replaceAll, keine Lookbehind-Regex (alte Safari).
// Alles, was bei Meta angelegt wird, ist PAUSED. Nie löschen.

// ═══════════════════════════════════════════════════════════════════════════
// 1. HP-Konstanten
// ═══════════════════════════════════════════════════════════════════════════

export const META_SPEC_VERSION = 1 as const
export const HP_AD_ACCOUNT_ID = '4065490590399677'
/** „Sveru Marketing LLC's Pixel" - das einzige Pixel, das LPs und /termin feuern. */
export const HP_PIXEL_ID = '1083578343946189'
export const HP_PAGE_ID = '556440087559971'
export const HP_DEFAULT_LINK = 'https://portal.happy-property.com/termin'
/** Fester UTM-Standard (nicht editierbar). utm_term = Anzeigengruppe, utm_content = Anzeige. */
export const URL_TAGS_STANDARD =
  'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}'
/** Platzhalter-Link für Sofortformular-Anzeigen (Meta-Doku). */
export const LEAD_FORM_LINK = 'http://fb.me/'
export const PLAN_B_LP_LANG = 'https://steuervorteil-zypern-immobilien.com/vermoegen-absichern-zypern/'
export const PLAN_B_LP_KURZ = 'https://steuervorteil-zypern-immobilien.com/vermoegen-absichern-zypern-kompakt/'
/** Klick zu WhatsApp: fester Link laut Meta-Doku („Ads that Click to WhatsApp“, link_data.link). */
export const WHATSAPP_LINK = 'https://api.whatsapp.com/send'
/** Klick zum Messenger: Platzhalter-Link (Meta-Doku Click to Messenger; API-Pfad ungeprüft, per validate_only prüfen). */
export const MESSENGER_LINK = 'https://fb.com/messenger_doc/'
/**
 * Mehrsprachige Anzeigen (asset_feed_spec optimization_type LANGUAGE): Sprach-IDs aus
 * GET /search?type=adlocale. Deutsch = 5, Englisch (USA) = 6, Englisch (UK) = 24
 * (6 und 24 aus der Meta-Doku; 5 per /search?type=adlocale&q=de bestätigen).
 */
export const SPRACH_LOCALES: Readonly<Record<'de' | 'en', readonly number[]>> = { de: [5], en: [6, 24] }
/** Automatische Übersetzung (autotranslate): Zielsprache aus Deutsch, laut Meta-Doku nur Deutsch -> Englisch. */
export const AUTOTRANSLATE_CODE: Readonly<Record<'en', string>> = { en: 'en_XX' }
/** Telefonnummer im internationalen Format (E.164): +, Ländervorwahl, 7 bis 15 Ziffern. */
export const TELEFON_RE = /^\+[1-9][0-9]{6,14}$/
/** Telefonnummer vereinheitlichen: Leerzeichen, Striche, Klammern, Schrägstriche raus, 00 -> +. */
export function normalizeTelefon(s: string | undefined | null): string {
  const t = String(s ?? '').replace(/[\s\-().\/]/g, '')
  return t.indexOf('00') === 0 ? `+${t.slice(2)}` : t
}

export const HOUSING_AGE_MIN = 18
export const HOUSING_AGE_MAX = 65
/** Wohnen (EU): Mindestradius um Adressen/Pins (custom_locations, places). */
export const HOUSING_MIN_RADIUS_KM = 15
/**
 * Städte: Meta erlaubt einen Radius nur von 10 bis 50 Meilen bzw. 17 bis 80 km
 * (gilt immer, nicht nur unter Wohnen). Unter Wohnen also bei Städten mindestens 17 km.
 */
export const CITY_MIN_RADIUS_KM = 17
export const CITY_MAX_RADIUS_KM = 80
export const CITY_MIN_RADIUS_MI = 10
export const CITY_MAX_RADIUS_MI = 50

export const LIMITS = {
  nameMax: 400,
  adsetsPerCampaign: 200,
  adsPerAdset: 50,
  textsPerKind: 5,
  primaryTextMax: 1024,
  headlineApiMax: 255,
  descriptionApiMax: 255,
  dsaMax: 512,
  urlMax: 1000,
  /** Kampagnen-Ausgabenlimit ca. 100 USD Minimum */
  spendCapMinCents: 10000,
  /** absolutes Minimum Tagesbudget (Impressionen, DE-Konto x2) */
  dailyBudgetMinCents: 100,
  /** darunter Warnung (Klick-/Aktionsziele) */
  dailyBudgetWarnCents: 500,
  carouselMin: 2,
  carouselMax: 10,
  roasFloorMin: 100,
  roasFloorMax: 10000000,
  /** Kampagnen-Ausgabenlimit: Obergrenze gegen Tippfehler (100.000 USD) */
  spendCapMaxCents: 10000000,
  /** Plausibilität Tagesbudget beim Bearbeiten (5.000 USD pro Tag, wie meta-ads-tools) */
  dailyBudgetMaxCents: 500000,
  /** Plausibilität Laufzeitbudget beim Bearbeiten (100.000 USD) */
  lifetimeBudgetMaxCents: 10000000,
  /** Meta: Budget je Objekt höchstens 4x pro Stunde ändern (Fehler 613/1487632) */
  budgetChangesPerHour: 4,
  /** Massenbearbeitung: höchstens so viele Objekte je Aufruf */
  bulkMaxItems: 50,
  /** Duplizieren: Kopien je Objekt */
  duplicateMaxCopies: 5,
  /** Duplizieren: Kopien insgesamt je Aufruf (Objekte x Kopien) */
  duplicateMaxTotal: 25,
  /** Budgetplanung: Zeiträume je Kampagne/Anzeigengruppe */
  budgetSchedulesMax: 50,
  /** WhatsApp-Begrüßung und vorbefüllte Nachricht (eigene Obergrenze, Meta nennt keine) */
  whatsappTextMax: 500,
  /** weitere Pixel im Tracking einer Anzeige */
  trackingPixelMax: 5,
  /** Vorschau aller Platzierungen: höchstens so viele Meta-Aufrufe je Anfrage */
  previewAlleMax: 10,
} as const

/**
 * Metas Wert für „unbegrenzt“: entfernt das Kampagnen-Ausgabenlimit (spend_cap) und das
 * Gruppen-Ausgabenlimit (daily_spend_cap). Nie als echtes Limit anzeigen.
 */
export const META_UNBEGRENZT = 922337203685478
/** Ab diesem Wert gilt ein gelesenes Limit als „kein Limit“ (Meta liefert teils gerundet). */
export const META_UNBEGRENZT_AB = 900000000000000

/** EU-27 (ISO-2, Meta-Schreibweise). DSA-Pflicht bei Ausrichtung auf diese Länder. */
export const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const

// ═══════════════════════════════════════════════════════════════════════════
// 2. Enums + Optionen
// ═══════════════════════════════════════════════════════════════════════════

export type Level = 'campaign' | 'adset' | 'ad'
export const LEVELS: readonly Level[] = ['campaign', 'adset', 'ad']

export interface EnumOption<V extends string = string> {
  value: V
  labelKey: string
  hintKey?: string
  /** Bei Meta abgekündigt: nur für Import/Anzeige. */
  deprecated?: boolean
  /** Im Assistenten nicht anlegbar (nur Import/Anzeige). */
  unsupported?: boolean
  /** HP-Empfehlung, im UI hervorheben. */
  recommended?: boolean
  /** Grund, warum die Option grau/gesperrt ist (i18n-Schlüssel, ein Satz in einfachem Deutsch). */
  reasonKey?: string
}

const K = 'crm.werbung.meta'
const opt = <V extends string>(ns: string, value: V, extra?: Omit<EnumOption<V>, 'value' | 'labelKey'>): EnumOption<V> =>
  ({ value, labelKey: `${K}.${ns}.${value}`, ...(extra ?? {}) })

const isIn = <T extends string>(arr: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (arr as readonly string[]).indexOf(v) >= 0

// ── Kampagnenziel (ODAX) ────────────────────────────────────────────────────
export const OBJECTIVES = [
  'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT',
  'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES',
] as const
export type Objective = typeof OBJECTIVES[number]
/** Alte Ziele (seit v17 abgekündigt) - nur beim Import bestehender Kampagnen zu sehen. */
export const LEGACY_OBJECTIVES = [
  'APP_INSTALLS', 'BRAND_AWARENESS', 'CONVERSIONS', 'EVENT_RESPONSES', 'LEAD_GENERATION',
  'LINK_CLICKS', 'LOCAL_AWARENESS', 'MESSAGES', 'OFFER_CLAIMS', 'PAGE_LIKES', 'POST_ENGAGEMENT',
  'PRODUCT_CATALOG_SALES', 'REACH', 'STORE_VISITS', 'VIDEO_VIEWS',
] as const
export type LegacyObjective = typeof LEGACY_OBJECTIVES[number]
export const OBJECTIVE_OPTIONS: readonly EnumOption<Objective>[] = [
  opt('objective', 'OUTCOME_AWARENESS'),
  opt('objective', 'OUTCOME_TRAFFIC'),
  opt('objective', 'OUTCOME_ENGAGEMENT'),
  opt('objective', 'OUTCOME_LEADS', { recommended: true }),
  opt('objective', 'OUTCOME_APP_PROMOTION', { unsupported: true }),
  opt('objective', 'OUTCOME_SALES'),
]

// ── Spezielle Anzeigenkategorien ────────────────────────────────────────────
export const SPECIAL_AD_CATEGORIES = [
  'NONE', 'HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES',
  'ISSUES_ELECTIONS_POLITICS', 'ONLINE_GAMBLING_AND_GAMING',
] as const
export type SpecialCat = typeof SPECIAL_AD_CATEGORIES[number]
/** Housing/Employment/Financial: gleiche Targeting-Einschränkungen. */
export const HEC_CATEGORIES: readonly SpecialCat[] = ['HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES']
export const SAC_OPTIONS: readonly EnumOption<SpecialCat>[] = [
  opt('sac', 'NONE'),
  opt('sac', 'HOUSING', { recommended: true }),
  opt('sac', 'EMPLOYMENT'),
  opt('sac', 'FINANCIAL_PRODUCTS_SERVICES'),
  opt('sac', 'ISSUES_ELECTIONS_POLITICS', { unsupported: true }),
  opt('sac', 'ONLINE_GAMBLING_AND_GAMING', { unsupported: true }),
]

export type BuyingType = 'AUCTION'
export const BUYING_TYPE_OPTIONS: readonly EnumOption<BuyingType>[] = [opt('buying_type', 'AUCTION')]

export type BudgetLevel = 'campaign' | 'adset'
export const BUDGET_LEVEL_OPTIONS: readonly EnumOption<BudgetLevel>[] = [
  opt('budget_level', 'adset', { recommended: true }),
  opt('budget_level', 'campaign'),
]

// ── Conversion-Ort (destination_type) ───────────────────────────────────────
/** Vollständiges Enum laut Referenz + ODAX-Tabelle (für Import). */
export const DESTINATION_TYPES = [
  'UNDEFINED', 'WEBSITE', 'APP', 'MESSENGER', 'APPLINKS_AUTOMATIC', 'WHATSAPP', 'INSTAGRAM_DIRECT',
  'FACEBOOK', 'MESSAGING_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER',
  'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP',
  'SHOP_AUTOMATIC', 'ON_AD', 'ON_POST', 'ON_EVENT', 'ON_VIDEO', 'ON_PAGE', 'INSTAGRAM_PROFILE',
  'FACEBOOK_PAGE', 'INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE', 'INSTAGRAM_LIVE', 'FACEBOOK_LIVE', 'IMAGINE',
  'PHONE_CALL', 'LEAD_FROM_MESSENGER', 'LEAD_FROM_IG_DIRECT', 'WEBSITE_AND_PHONE_CALL',
  // „Website und Instant-Formulare“ (im Konto an Anzeigengruppen der Kampagne 120248950711350314 gelesen)
  'WEBSITE_AND_LEAD_FORM',
] as const
export type Destination = typeof DESTINATION_TYPES[number]
const destReason = (v: string): string => `${K}.destination_reason.${v}`
export const DESTINATION_OPTIONS: readonly EnumOption<Destination>[] = [
  opt('destination', 'WEBSITE', { recommended: true }),
  // API-Pfad ungeprüft (Ziel aus echten Anzeigengruppen gelesen): per validate_only prüfen
  opt('destination', 'WEBSITE_AND_LEAD_FORM'),
  opt('destination', 'ON_AD'),
  opt('destination', 'WEBSITE_AND_PHONE_CALL', { unsupported: true, reasonKey: destReason('WEBSITE_AND_PHONE_CALL') }),
  opt('destination', 'PHONE_CALL'),
  opt('destination', 'WHATSAPP'),
  opt('destination', 'MESSENGER'),
  opt('destination', 'INSTAGRAM_DIRECT', { unsupported: true, reasonKey: destReason('INSTAGRAM_DIRECT') }),
  opt('destination', 'LEAD_FROM_IG_DIRECT', { unsupported: true, reasonKey: destReason('LEAD_FROM_IG_DIRECT') }),
  // Meta hat Messenger-Lead-Anzeigen über die Schnittstelle mit v24 abgeschaltet (nur noch im Werbeanzeigenmanager)
  opt('destination', 'LEAD_FROM_MESSENGER', { deprecated: true, unsupported: true, reasonKey: destReason('LEAD_FROM_MESSENGER') }),
  opt('destination', 'APP', { unsupported: true, reasonKey: destReason('APP') }),
  opt('destination', 'ON_POST'),
  opt('destination', 'ON_VIDEO'),
  opt('destination', 'ON_PAGE', { unsupported: true, reasonKey: destReason('ON_PAGE') }),
  opt('destination', 'ON_EVENT', { unsupported: true, reasonKey: destReason('ON_EVENT') }),
  opt('destination', 'UNDEFINED'),
]
/**
 * Ziele, für die der Assistent Anzeigen (Creatives) bauen kann (= Schlüssel von AD_KINDS_BY_DESTINATION).
 * WEBSITE_AND_PHONE_CALL: nur neue Website-Anzeigen in BESTEHENDEN Anzeigengruppen
 * (laufendes Plan B); neue Anzeigengruppen mit diesem Ziel bleiben „unsupported“.
 */
export const AD_SUPPORTED_DESTINATIONS: readonly Destination[] = [
  'WEBSITE', 'ON_AD', 'UNDEFINED', 'ON_POST', 'ON_VIDEO', 'WEBSITE_AND_PHONE_CALL',
  'WEBSITE_AND_LEAD_FORM', 'WHATSAPP', 'PHONE_CALL', 'MESSENGER',
]

// ── Leistungsziel (optimization_goal) ──────────────────────────────────────
/** Vollständiges Enum laut Referenz (für Import) + TWO_SECOND_CONTINUOUS_VIDEO_VIEWS aus der ODAX-Tabelle. */
export const OPTIMIZATION_GOALS = [
  'NONE', 'APP_INSTALLS', 'AD_RECALL_LIFT', 'ENGAGED_USERS', 'EVENT_RESPONSES', 'IMPRESSIONS',
  'LEAD_GENERATION', 'QUALITY_LEAD', 'LINK_CLICKS', 'OFFSITE_CONVERSIONS', 'PAGE_LIKES',
  'POST_ENGAGEMENT', 'QUALITY_CALL', 'REACH', 'LANDING_PAGE_VIEWS', 'VISIT_INSTAGRAM_PROFILE',
  'ENGAGED_PAGE_VIEWS', 'VALUE', 'THRUPLAY', 'DERIVED_EVENTS', 'APP_INSTALLS_AND_OFFSITE_CONVERSIONS',
  'CONVERSATIONS', 'IN_APP_VALUE', 'MESSAGING_PURCHASE_CONVERSION',
  'MESSAGING_DEEP_CONVERSATION_AND_FOLLOW', 'SUBSCRIBERS', 'REMINDERS_SET',
  'MEANINGFUL_CALL_ATTEMPT', 'PROFILE_VISIT', 'PROFILE_AND_PAGE_ENGAGEMENT',
  'ADVERTISER_SILOED_VALUE', 'AUTOMATIC_OBJECTIVE', 'MESSAGING_APPOINTMENT_CONVERSION',
  'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS',
] as const
export type OptGoal = typeof OPTIMIZATION_GOALS[number]

/** ODAX-Mapping (offiziell): Ziel -> Conversion-Ort -> erlaubte Leistungsziele. Erstes = Standard. */
export const GOALS_BY_OBJ_DEST: Readonly<Record<Objective, Partial<Record<Destination, readonly OptGoal[]>>>> = {
  OUTCOME_AWARENESS: {
    UNDEFINED: ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT', 'THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'],
  },
  OUTCOME_TRAFFIC: {
    WEBSITE: ['LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
    MESSENGER: ['LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
    WHATSAPP: ['LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
    PHONE_CALL: ['QUALITY_CALL', 'LINK_CLICKS'],
    APP: ['LINK_CLICKS'],
  },
  OUTCOME_ENGAGEMENT: {
    ON_POST: ['POST_ENGAGEMENT', 'REACH'],
    ON_VIDEO: ['THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'],
    ON_PAGE: ['PAGE_LIKES'],
    ON_EVENT: ['EVENT_RESPONSES', 'POST_ENGAGEMENT', 'REACH', 'IMPRESSIONS'],
    // ODAX erlaubt hier auch LEAD_GENERATION (Messenger-Lead-Anzeige). Meta hat Messenger-Lead-Anzeigen
    // über die Schnittstelle mit v24 abgeschaltet: nicht anbieten (gesperrt mit Grund unter LEAD_FROM_MESSENGER).
    MESSENGER: ['CONVERSATIONS', 'LINK_CLICKS'],
    WHATSAPP: ['CONVERSATIONS', 'LINK_CLICKS'],
    WEBSITE: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
  },
  OUTCOME_LEADS: {
    WEBSITE: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
    // „Website und Instant-Formulare“: Meta optimiert auf das Pixel-Ereignis Lead (Werbeanzeigenmanager: nur „Lead“)
    WEBSITE_AND_LEAD_FORM: ['OFFSITE_CONVERSIONS'],
    ON_AD: ['LEAD_GENERATION', 'QUALITY_LEAD'],
    LEAD_FROM_IG_DIRECT: ['LEAD_GENERATION'],
    LEAD_FROM_MESSENGER: ['LEAD_GENERATION'],
    PHONE_CALL: ['QUALITY_CALL'],
    WHATSAPP: ['CONVERSATIONS'],
  },
  OUTCOME_SALES: {
    WEBSITE: ['OFFSITE_CONVERSIONS', 'VALUE'],
    MESSENGER: ['CONVERSATIONS'],
    PHONE_CALL: ['QUALITY_CALL'],
  },
  OUTCOME_APP_PROMOTION: {
    APP: ['APP_INSTALLS', 'OFFSITE_CONVERSIONS', 'LINK_CLICKS'],
  },
}

export const GOAL_OPTIONS: readonly EnumOption<OptGoal>[] = [
  opt('goal', 'OFFSITE_CONVERSIONS', { recommended: true }),
  opt('goal', 'LEAD_GENERATION'),
  opt('goal', 'QUALITY_LEAD'),
  opt('goal', 'VALUE'),
  opt('goal', 'LANDING_PAGE_VIEWS'),
  opt('goal', 'LINK_CLICKS'),
  opt('goal', 'QUALITY_CALL'),
  opt('goal', 'CONVERSATIONS'),
  opt('goal', 'REACH'),
  opt('goal', 'IMPRESSIONS'),
  opt('goal', 'THRUPLAY'),
  opt('goal', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'),
  opt('goal', 'AD_RECALL_LIFT'),
  opt('goal', 'POST_ENGAGEMENT'),
  opt('goal', 'PAGE_LIKES'),
  opt('goal', 'EVENT_RESPONSES'),
  opt('goal', 'APP_INSTALLS'),
]

// ── Abrechnung (billing_event) ──────────────────────────────────────────────
export const BILLING_EVENTS = [
  'IMPRESSIONS', 'LINK_CLICKS', 'THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', 'APP_INSTALLS',
  'CLICKS', 'NONE', 'OFFER_CLAIMS', 'PAGE_LIKES', 'POST_ENGAGEMENT', 'PURCHASE', 'LISTING_INTERACTION',
] as const
export type Billing = typeof BILLING_EVENTS[number]
export const BILLING_OPTIONS: readonly EnumOption<Billing>[] = [
  opt('billing', 'IMPRESSIONS', { recommended: true }),
  opt('billing', 'LINK_CLICKS'),
  opt('billing', 'THRUPLAY'),
  opt('billing', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'),
]
const BILLING_SPECIAL: Partial<Record<OptGoal, readonly Billing[]>> = {
  LINK_CLICKS: ['IMPRESSIONS', 'LINK_CLICKS'],
  THRUPLAY: ['IMPRESSIONS', 'THRUPLAY'],
  TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: ['IMPRESSIONS', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'],
}
/** Erlaubte Abrechnung je Leistungsziel; fast alle Ziele nur IMPRESSIONS. Erstes = Standard. */
export function billingFor(goal: OptGoal): readonly Billing[] {
  return BILLING_SPECIAL[goal] ?? ['IMPRESSIONS']
}

// ── Conversion-Ereignis (promoted_object.custom_event_type) ─────────────────
export const CUSTOM_EVENT_TYPES = [
  'SCHEDULE', 'LEAD', 'COMPLETE_REGISTRATION', 'CONTACT', 'SUBMIT_APPLICATION',
  'SERVICE_BOOKING_REQUEST', 'CONTENT_VIEW', 'SEARCH', 'SUBSCRIBE', 'START_TRIAL', 'FIND_LOCATION',
  'CUSTOMIZE_PRODUCT', 'DONATE', 'PURCHASE', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'INITIATED_CHECKOUT',
  'ADD_PAYMENT_INFO', 'AD_IMPRESSION', 'RATE', 'TUTORIAL_COMPLETION', 'MESSAGING_CONVERSATION_STARTED_7D',
  'LEVEL_ACHIEVED', 'ACHIEVEMENT_UNLOCKED', 'SPENT_CREDITS', 'LISTING_INTERACTION', 'D2_RETENTION',
  'D7_RETENTION', 'OTHER',
] as const
export type CustomEvent = typeof CUSTOM_EVENT_TYPES[number]
export const CUSTOM_EVENT_OPTIONS: readonly EnumOption<CustomEvent>[] = CUSTOM_EVENT_TYPES.map(v =>
  opt('event', v, v === 'SCHEDULE' ? { recommended: true } : undefined))

// ── promoted_object-Regeln ──────────────────────────────────────────────────
export const PROMOTED_KEYS = [
  'pixel_id', 'custom_event_type', 'custom_conversion_id', 'page_id',
  'application_id', 'object_store_url', 'whatsapp_phone_number',
] as const
export type PromotedKey = typeof PROMOTED_KEYS[number]
export interface PromotedObject {
  pixel_id?: string
  custom_event_type?: CustomEvent
  custom_conversion_id?: string
  page_id?: string
  application_id?: string
  object_store_url?: string
  whatsapp_phone_number?: string
}
export interface PromotedRule {
  objective: Objective
  destination: Destination
  /** undefined = gilt für alle Leistungsziele dieses Orts */
  goals?: readonly OptGoal[]
  /** erfüllt, wenn EINE Alternative vollständig gesetzt ist; [[]] = nichts nötig */
  anyOf: readonly (readonly PromotedKey[])[]
  optional: readonly PromotedKey[]
}
const NOTHING: readonly (readonly PromotedKey[])[] = [[]]
const PIXEL_EVENT: readonly (readonly PromotedKey[])[] = [['pixel_id', 'custom_event_type'], ['custom_conversion_id']]
/** Reihenfolge = Priorität (spezifische Regel mit goals vor allgemeiner). */
export const PROMOTED_OBJECT_RULES: readonly PromotedRule[] = [
  { objective: 'OUTCOME_AWARENESS', destination: 'UNDEFINED', anyOf: [['page_id']], optional: [] },
  { objective: 'OUTCOME_TRAFFIC', destination: 'WEBSITE', anyOf: NOTHING, optional: [] },
  { objective: 'OUTCOME_TRAFFIC', destination: 'MESSENGER', anyOf: NOTHING, optional: ['page_id'] },
  { objective: 'OUTCOME_TRAFFIC', destination: 'WHATSAPP', anyOf: [['page_id']], optional: ['whatsapp_phone_number'] },
  { objective: 'OUTCOME_TRAFFIC', destination: 'PHONE_CALL', anyOf: NOTHING, optional: ['page_id'] },
  { objective: 'OUTCOME_TRAFFIC', destination: 'APP', anyOf: [['application_id', 'object_store_url']], optional: [] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'ON_POST', anyOf: NOTHING, optional: [] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'ON_VIDEO', anyOf: NOTHING, optional: [] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'ON_EVENT', anyOf: NOTHING, optional: [] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'ON_PAGE', anyOf: [['page_id']], optional: [] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'MESSENGER', anyOf: [['page_id']], optional: [] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'WHATSAPP', anyOf: [['page_id']], optional: ['whatsapp_phone_number'] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'WEBSITE', goals: ['OFFSITE_CONVERSIONS'], anyOf: PIXEL_EVENT, optional: ['pixel_id'] },
  { objective: 'OUTCOME_ENGAGEMENT', destination: 'WEBSITE', anyOf: NOTHING, optional: [] },
  { objective: 'OUTCOME_LEADS', destination: 'WEBSITE', goals: ['OFFSITE_CONVERSIONS'], anyOf: PIXEL_EVENT, optional: ['pixel_id'] },
  { objective: 'OUTCOME_LEADS', destination: 'WEBSITE', anyOf: NOTHING, optional: [] },
  { objective: 'OUTCOME_LEADS', destination: 'WEBSITE_AND_LEAD_FORM', anyOf: [['pixel_id', 'custom_event_type']], optional: [] },
  { objective: 'OUTCOME_LEADS', destination: 'ON_AD', anyOf: [['page_id']], optional: ['pixel_id'] },
  { objective: 'OUTCOME_LEADS', destination: 'LEAD_FROM_IG_DIRECT', anyOf: [['page_id']], optional: [] },
  { objective: 'OUTCOME_LEADS', destination: 'LEAD_FROM_MESSENGER', anyOf: [['page_id']], optional: [] },
  { objective: 'OUTCOME_LEADS', destination: 'PHONE_CALL', anyOf: [['page_id']], optional: [] },
  { objective: 'OUTCOME_LEADS', destination: 'WHATSAPP', anyOf: [['page_id']], optional: ['whatsapp_phone_number'] },
  { objective: 'OUTCOME_SALES', destination: 'WEBSITE', anyOf: [['pixel_id', 'custom_event_type']], optional: [] },
  { objective: 'OUTCOME_SALES', destination: 'MESSENGER', anyOf: [['page_id', 'pixel_id', 'custom_event_type']], optional: [] },
  { objective: 'OUTCOME_SALES', destination: 'PHONE_CALL', anyOf: [['page_id']], optional: [] },
  { objective: 'OUTCOME_APP_PROMOTION', destination: 'APP', anyOf: [['application_id', 'object_store_url']], optional: ['custom_event_type'] },
]
export function promotedRuleFor(objective: Objective, destination: Destination, goal: OptGoal): PromotedRule | null {
  for (const r of PROMOTED_OBJECT_RULES) {
    if (r.objective !== objective || r.destination !== destination) continue
    if (r.goals && r.goals.indexOf(goal) < 0) continue
    return r
  }
  return null
}
/** Alle Felder, die für diese Kombination überhaupt gesendet werden dürfen. */
export function promotedAllowed(rule: PromotedRule): PromotedKey[] {
  const out: PromotedKey[] = []
  for (const alt of rule.anyOf) for (const k of alt) if (out.indexOf(k) < 0) out.push(k)
  for (const k of rule.optional) if (out.indexOf(k) < 0) out.push(k)
  return out
}

// ── Attribution ─────────────────────────────────────────────────────────────
export const ATTRIBUTION_PRESETS = [
  'click_1d', 'click_7d', 'click_1d_view_1d', 'click_7d_view_1d', 'click_7d_view_1d_ev_1d',
  'click_1d_ev_1d', 'click_1d_view_1d_ev_1d',
] as const
export type AttributionPreset = typeof ATTRIBUTION_PRESETS[number]
export type AttributionEventType = 'CLICK_THROUGH' | 'VIEW_THROUGH' | 'ENGAGED_VIDEO_VIEW'
export interface AttributionWindow { event_type: AttributionEventType; window_days: number }
export const ATTRIBUTION_SPECS: Readonly<Record<AttributionPreset, readonly AttributionWindow[]>> = {
  click_1d: [{ event_type: 'CLICK_THROUGH', window_days: 1 }],
  click_7d: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
  click_1d_view_1d: [{ event_type: 'CLICK_THROUGH', window_days: 1 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
  click_7d_view_1d: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
  // „Engage-Through" seit 2026: API-Name ENGAGED_VIDEO_VIEW nicht offiziell bestätigt, per validate_only prüfen
  click_7d_view_1d_ev_1d: [
    { event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 },
    { event_type: 'ENGAGED_VIDEO_VIEW', window_days: 1 },
  ],
  click_1d_ev_1d: [{ event_type: 'CLICK_THROUGH', window_days: 1 }, { event_type: 'ENGAGED_VIDEO_VIEW', window_days: 1 }],
  click_1d_view_1d_ev_1d: [
    { event_type: 'CLICK_THROUGH', window_days: 1 }, { event_type: 'VIEW_THROUGH', window_days: 1 },
    { event_type: 'ENGAGED_VIDEO_VIEW', window_days: 1 },
  ],
}
export const ATTRIBUTION_OPTIONS: readonly EnumOption<AttributionPreset>[] = [
  opt('attribution', 'click_7d_view_1d', { recommended: true }),
  opt('attribution', 'click_7d'),
  opt('attribution', 'click_1d_view_1d'),
  opt('attribution', 'click_1d'),
  opt('attribution', 'click_7d_view_1d_ev_1d'),
  opt('attribution', 'click_1d_ev_1d'),
  opt('attribution', 'click_1d_view_1d_ev_1d'),
]
const ATTR_WEBSITE: readonly AttributionPreset[] = ['click_7d_view_1d', 'click_7d', 'click_1d_view_1d', 'click_1d', 'click_7d_view_1d_ev_1d']
const ATTR_APP: readonly AttributionPreset[] = ['click_1d', 'click_1d_ev_1d', 'click_1d_view_1d_ev_1d']
/** Erlaubte Attribution je Leistungsziel; Erstes = Standard. Alle anderen Ziele: nur 1 Tag Klick. */
export function attributionFor(goal: OptGoal): readonly AttributionPreset[] {
  if (goal === 'OFFSITE_CONVERSIONS' || goal === 'VALUE') return ATTR_WEBSITE
  if (goal === 'APP_INSTALLS') return ATTR_APP
  return ['click_1d']
}

// ── Gebotsstrategie ─────────────────────────────────────────────────────────
export const BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP', 'LOWEST_COST_WITH_MIN_ROAS'] as const
export type BidStrategy = typeof BID_STRATEGIES[number]
export const BID_OPTIONS: readonly EnumOption<BidStrategy>[] = [
  opt('bid', 'LOWEST_COST_WITHOUT_CAP', { recommended: true }),
  opt('bid', 'COST_CAP'),
  opt('bid', 'LOWEST_COST_WITH_BID_CAP'),
  opt('bid', 'LOWEST_COST_WITH_MIN_ROAS'),
]
export const BID_NEEDS_AMOUNT: readonly BidStrategy[] = ['COST_CAP', 'LOWEST_COST_WITH_BID_CAP']

// ── Platzierungen (v26-bereinigt) ───────────────────────────────────────────
export const PUBLISHER_PLATFORMS = ['facebook', 'instagram', 'threads', 'messenger', 'audience_network'] as const
export type PublisherPlatform = typeof PUBLISHER_PLATFORMS[number]
export const FACEBOOK_POSITIONS = [
  'feed', 'right_hand_column', 'marketplace', 'story', 'search', 'instream_video',
  'facebook_reels', 'facebook_reels_overlay', 'profile_feed', 'notification',
] as const
export type FacebookPosition = typeof FACEBOOK_POSITIONS[number]
export const INSTAGRAM_POSITIONS = ['stream', 'story', 'reels', 'explore_home', 'profile_feed', 'ig_search', 'profile_reels'] as const
export type InstagramPosition = typeof INSTAGRAM_POSITIONS[number]
export const THREADS_POSITIONS = ['threads_stream'] as const
export type ThreadsPosition = typeof THREADS_POSITIONS[number]
export const MESSENGER_POSITIONS = ['sponsored_messages'] as const
export type MessengerPosition = typeof MESSENGER_POSITIONS[number]
export const AUDIENCE_NETWORK_POSITIONS = ['classic', 'rewarded_video'] as const
export type AudienceNetworkPosition = typeof AUDIENCE_NETWORK_POSITIONS[number]
export const DEVICE_PLATFORMS = ['mobile', 'desktop'] as const
export type DevicePlatform = typeof DEVICE_PLATFORMS[number]

export type PositionField =
  'facebook_positions' | 'instagram_positions' | 'threads_positions' | 'messenger_positions' | 'audience_network_positions'
export const POSITION_FIELD_BY_PLATFORM: Readonly<Record<PublisherPlatform, PositionField>> = {
  facebook: 'facebook_positions',
  instagram: 'instagram_positions',
  threads: 'threads_positions',
  messenger: 'messenger_positions',
  audience_network: 'audience_network_positions',
}
export const POSITIONS_BY_PLATFORM: Readonly<Record<PublisherPlatform, readonly string[]>> = {
  facebook: FACEBOOK_POSITIONS,
  instagram: INSTAGRAM_POSITIONS,
  threads: THREADS_POSITIONS,
  messenger: MESSENGER_POSITIONS,
  audience_network: AUDIENCE_NETWORK_POSITIONS,
}
/** Von Meta entfernt (Fehler bei Neuanlage); beim Import still streichen. */
export const REMOVED_POSITIONS: Readonly<Record<PositionField, readonly string[]>> = {
  facebook_positions: ['video_feeds'],
  instagram_positions: ['explore'],
  threads_positions: [],
  messenger_positions: ['messenger_home', 'story'],
  audience_network_positions: [],
}
export const PLATFORM_OPTIONS: readonly EnumOption<PublisherPlatform>[] = PUBLISHER_PLATFORMS.map(v => opt('platform', v))
export const POSITION_OPTIONS: Readonly<Record<PublisherPlatform, readonly EnumOption[]>> = {
  facebook: FACEBOOK_POSITIONS.map(v => opt('pos_facebook', v)),
  instagram: INSTAGRAM_POSITIONS.map(v => opt('pos_instagram', v)),
  threads: THREADS_POSITIONS.map(v => opt('pos_threads', v)),
  messenger: MESSENGER_POSITIONS.map(v => opt('pos_messenger', v)),
  audience_network: AUDIENCE_NETWORK_POSITIONS.map(v => opt('pos_audience_network', v)),
}
export const DEVICE_OPTIONS: readonly EnumOption<DevicePlatform>[] = DEVICE_PLATFORMS.map(v => opt('device', v))
export type PlacementMode = 'advantage' | 'manual'
export const PLACEMENT_MODE_OPTIONS: readonly EnumOption<PlacementMode>[] = [
  opt('placement_mode', 'advantage', { recommended: true }),
  opt('placement_mode', 'manual'),
]

// ── Standort-Typen ──────────────────────────────────────────────────────────
export const LOCATION_TYPES = ['home', 'recent'] as const
export type LocationType = typeof LOCATION_TYPES[number]
export const LOCATION_TYPE_OPTIONS: readonly EnumOption<LocationType>[] = LOCATION_TYPES.map(v => opt('location_type', v))

// ── Markensicherheit / Inventarfilter ──────────────────────────────────────
export const BRAND_SAFETY_LEVELS = ['RELAXED', 'STANDARD', 'STRICT'] as const
export type BrandSafety = typeof BRAND_SAFETY_LEVELS[number]
export const BRAND_SAFETY_OPTIONS: readonly EnumOption<BrandSafety>[] = BRAND_SAFETY_LEVELS.map(v => opt('brand_safety', v))
export const PUBLISHER_CATEGORIES = ['dating', 'gambling', 'debated_social_issues', 'mature_audiences', 'tragedy_and_conflict'] as const
export type PublisherCategory = typeof PUBLISHER_CATEGORIES[number]
export const PUBLISHER_CATEGORY_OPTIONS: readonly EnumOption<PublisherCategory>[] = PUBLISHER_CATEGORIES.map(v => opt('publisher_category', v))

// ── Call-to-Action ─────────────────────────────────────────────────────────
export const CTA_TYPES = [
  'BOOK_NOW', 'LEARN_MORE', 'SIGN_UP', 'GET_QUOTE', 'APPLY_NOW', 'CONTACT_US', 'REQUEST_TIME',
  'BOOK_A_CONSULTATION', 'MAKE_AN_APPOINTMENT', 'INQUIRE_NOW', 'GET_A_QUOTE', 'ASK_ABOUT_SERVICES',
  'ASK_FOR_MORE_INFO', 'GET_DETAILS', 'FIND_OUT_MORE', 'GET_IN_TOUCH', 'VISIT_WEBSITE', 'SEE_MORE',
  'GET_OFFER', 'SUBSCRIBE', 'DOWNLOAD', 'NO_BUTTON',
  'WHATSAPP_MESSAGE', 'MESSAGE_PAGE', 'CHAT_WITH_US', 'CALL_NOW',
  // „Details ansehen“ bei „Website und Instant-Formulare“ (in einer HP-Anzeige gelesen)
  'SEE_DETAILS',
] as const
export type CtaType = typeof CTA_TYPES[number]
/**
 * Ziel der Werbeanzeige (Zielort je Conversion-Ort der Anzeigengruppe):
 * website = Website-URL, lead_form = Sofortformular, website_lead_form = Website UND Sofortformular,
 * whatsapp = Klick zu WhatsApp, phone_call = Anruf (Telefonnummer), messenger = Klick zum Messenger.
 */
export type AdDestinationKind = 'website' | 'lead_form' | 'website_lead_form' | 'whatsapp' | 'phone_call' | 'messenger'
export const AD_DESTINATION_KINDS: readonly AdDestinationKind[] = ['website', 'lead_form', 'website_lead_form', 'whatsapp', 'phone_call', 'messenger']
/** Sofortformular: NUR diese sechs (Meta-Lead-Ads-Doku). */
export const CTA_LEAD_FORM: readonly CtaType[] = ['SIGN_UP', 'LEARN_MORE', 'GET_QUOTE', 'APPLY_NOW', 'DOWNLOAD', 'SUBSCRIBE']
export const CTA_WEBSITE: readonly CtaType[] = [
  'BOOK_NOW', 'LEARN_MORE', 'SIGN_UP', 'GET_QUOTE', 'APPLY_NOW', 'CONTACT_US', 'REQUEST_TIME',
  'BOOK_A_CONSULTATION', 'MAKE_AN_APPOINTMENT', 'INQUIRE_NOW', 'GET_A_QUOTE', 'ASK_ABOUT_SERVICES',
  'ASK_FOR_MORE_INFO', 'GET_DETAILS', 'FIND_OUT_MORE', 'GET_IN_TOUCH', 'VISIT_WEBSITE', 'SEE_MORE',
  'GET_OFFER', 'SUBSCRIBE', 'DOWNLOAD', 'NO_BUTTON',
]
/**
 * Website und Sofortformular: Liste der Meta-Hilfe zu Instant-Formularen (Jetzt bewerben, Jetzt buchen,
 * Herunterladen, Angebot ansehen, Angebot anfordern, Mehr dazu, Details ansehen, Registrieren, Abonnieren).
 * Per validate_only prüfen.
 */
export const CTA_WEBSITE_LEAD_FORM: readonly CtaType[] = [
  'BOOK_NOW', 'SIGN_UP', 'LEARN_MORE', 'GET_QUOTE', 'APPLY_NOW', 'DOWNLOAD', 'SUBSCRIBE', 'GET_OFFER', 'SEE_DETAILS',
]
export const CTA_BY_DESTINATION: Readonly<Record<AdDestinationKind, readonly CtaType[]>> = {
  website: CTA_WEBSITE,
  lead_form: CTA_LEAD_FORM,
  website_lead_form: CTA_WEBSITE_LEAD_FORM,
  // Meta-Doku „Ads that Click to WhatsApp“: value { app_destination: 'WHATSAPP' }
  whatsapp: ['WHATSAPP_MESSAGE'],
  // Anrufe: value { link: 'tel:+49...' } (API-Pfad ungeprüft, per validate_only prüfen)
  phone_call: ['CALL_NOW'],
  // Messenger: value { app_destination: 'MESSENGER' } (API-Pfad ungeprüft, per validate_only prüfen)
  messenger: ['MESSAGE_PAGE'],
}
export const CTA_OPTIONS: readonly EnumOption<CtaType>[] = CTA_TYPES.map(v =>
  opt('cta', v, v === 'BOOK_NOW' ? { recommended: true } : undefined))
export function ctaFor(kind: AdDestinationKind): readonly CtaType[] {
  return CTA_BY_DESTINATION[kind] ?? CTA_WEBSITE
}
export const AD_DESTINATION_KIND_OPTIONS: readonly EnumOption<AdDestinationKind>[] = [
  opt('destination_kind', 'website', { recommended: true }),
  opt('destination_kind', 'lead_form'),
  opt('destination_kind', 'website_lead_form'),
  opt('destination_kind', 'whatsapp'),
  opt('destination_kind', 'phone_call'),
  opt('destination_kind', 'messenger'),
]
/** Welche Ziel-Arten der Werbeanzeige zum Conversion-Ort der Anzeigengruppe passen (Erstes = Standard). */
export const AD_KINDS_BY_DESTINATION: Readonly<Partial<Record<Destination, readonly AdDestinationKind[]>>> = {
  WEBSITE: ['website'],
  UNDEFINED: ['website'],
  ON_POST: ['website'],
  ON_VIDEO: ['website'],
  WEBSITE_AND_PHONE_CALL: ['website'],
  ON_AD: ['lead_form'],
  WEBSITE_AND_LEAD_FORM: ['website_lead_form'],
  WHATSAPP: ['whatsapp'],
  PHONE_CALL: ['phone_call'],
  MESSENGER: ['messenger'],
}
export function adKindsFor(destination: Destination | undefined): readonly AdDestinationKind[] {
  return (destination && AD_KINDS_BY_DESTINATION[destination]) || []
}
/** Ziel-Arten mit Website-URL (Lint, Conversion-Domain, UTM). */
export const isWebsiteKind = (k: AdDestinationKind | undefined): boolean => k === 'website' || k === 'website_lead_form'
/** Ziel-Arten mit Sofortformular. */
export const isFormKind = (k: AdDestinationKind | undefined): boolean => k === 'lead_form' || k === 'website_lead_form'

// ── Anzeigenformat ─────────────────────────────────────────────────────────
/** collection = Sammlung/Instant Experience: sichtbar, aber gesperrt (folgt, Katalog/Canvas nötig). */
export type AdFormat = 'single_image' | 'single_video' | 'carousel' | 'collection'
export const AD_FORMATS: readonly AdFormat[] = ['single_image', 'single_video', 'carousel', 'collection']
export const AD_FORMAT_OPTIONS: readonly EnumOption<AdFormat>[] = AD_FORMATS.map(v =>
  opt('format', v, v === 'collection' ? { unsupported: true, reasonKey: `${K}.format_reason.collection` } : undefined))

/** Anzeigeneinrichtung: neue Werbeanzeige erstellen oder vorhandenen Beitrag verwenden. */
export type AdSetup = 'neu' | 'beitrag'
export const AD_SETUP_OPTIONS: readonly EnumOption<AdSetup>[] = [
  opt('setup', 'neu', { recommended: true }),
  opt('setup', 'beitrag'),
]
export type BeitragQuelle = 'facebook' | 'instagram'
export const BEITRAG_QUELLE_OPTIONS: readonly EnumOption<BeitragQuelle>[] = [opt('beitrag_quelle', 'facebook'), opt('beitrag_quelle', 'instagram')]

// ── Sprachen (mehrsprachige Anzeige) ───────────────────────────────────────
/** de = Standardsprache (Texte der Anzeige), weitere Sprachen als Varianten. */
export type AdSprache = 'de' | 'en'
export const AD_SPRACHEN: readonly AdSprache[] = ['de', 'en']
export const SPRACHE_OPTIONS: readonly EnumOption<AdSprache>[] = AD_SPRACHEN.map(v => opt('sprache', v))
export const SPRACH_LABEL_PREFIX = 'hp_lang_'

// ── Zuschnitt (image_crops) ────────────────────────────────────────────────
/** Metas Zuschnitt-Schlüssel (Breite x Höhe als Verhältnis), Rechteck [[x1, y1], [x2, y2]] in Pixeln. */
export const CROP_KEYS = ['191x100', '100x72', '400x150', '600x360', '100x100', '400x500', '90x160', '300x400'] as const
export type CropKey = typeof CROP_KEYS[number]
export type CropBox = [[number, number], [number, number]]
export type ImageCrops = Partial<Record<CropKey, CropBox>>
export const CROP_KEY_OPTIONS: readonly EnumOption<CropKey>[] = CROP_KEYS.map(v => opt('crop', v))
/** Passender Zuschnitt je Medien-Platz (1.91:1 / 4:5 / 9:16 / 1:1). */
export const CROP_KEY_BY_SLOT: Readonly<Record<'feed_4x5' | 'story_9x16' | 'square_1x1' | 'landscape_191x1', CropKey>> = {
  feed_4x5: '400x500', story_9x16: '90x160', square_1x1: '100x100', landscape_191x1: '191x100',
}
/** Rechteck gültig und im Seitenverhältnis des Schlüssels (1 % Toleranz, Meta verlangt das gleiche Verhältnis)? */
export function cropValid(key: string, box: unknown): boolean {
  if ((CROP_KEYS as readonly string[]).indexOf(key) < 0 || !Array.isArray(box) || box.length !== 2) return false
  const a = box[0], b = box[1]
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) return false
  const nums = [a[0], a[1], b[0], b[1]]
  if (!nums.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && Math.round(n) === n)) return false
  const w = (b[0] as number) - (a[0] as number), h = (b[1] as number) - (a[1] as number)
  if (!(w > 0) || !(h > 0)) return false
  const parts = key.split('x')
  const soll = Number(parts[0]) / Number(parts[1])
  return Math.abs(w / h - soll) / soll <= 0.01
}

// ── Advantage+ Creative (degrees_of_freedom_spec.creative_features_spec) ───
export const CREATIVE_FEATURES = [
  'adapt_to_placement', 'image_touchups', 'video_auto_crop', 'image_uncrop', 'video_uncrop',
  'video_filtering', 'image_animation', 'image_background_gen', 'image_brightness_and_contrast',
  'image_templates', 'creative_stickers', 'enhance_cta', 'text_optimizations', 'text_generation',
  'text_translation', 'image_text_translation', 'inline_comment', 'description_automation',
  'reveal_details_over_time', 'site_extensions', 'show_summary', 'show_destination_blurbs',
  'pac_relaxation', 'replace_media_text',
] as const
export type CreativeFeature = typeof CREATIVE_FEATURES[number]
export type Enroll = 'OPT_IN' | 'OPT_OUT'
export interface CreativeFeatureInfo {
  /** KI-generierte Inhalte: Anzeige PAUSED anlegen, Vorschau, dann aktivieren */
  ai: boolean
  /** Metas Standard, wenn nichts gesendet wird */
  metaDefault: Enroll | 'unbekannt'
  media: 'image' | 'video' | 'all'
  /** in Metas aktueller Doku belegt (sonst SDK-Spec/Drittquelle: per validate_only prüfen) */
  documented: boolean
}
export const CREATIVE_FEATURE_INFO: Readonly<Record<CreativeFeature, CreativeFeatureInfo>> = {
  adapt_to_placement: { ai: false, metaDefault: 'OPT_IN', media: 'image', documented: true },
  image_touchups: { ai: false, metaDefault: 'unbekannt', media: 'image', documented: true },
  video_auto_crop: { ai: false, metaDefault: 'unbekannt', media: 'video', documented: true },
  image_uncrop: { ai: true, metaDefault: 'unbekannt', media: 'image', documented: true },
  video_uncrop: { ai: true, metaDefault: 'unbekannt', media: 'video', documented: false },
  video_filtering: { ai: false, metaDefault: 'unbekannt', media: 'video', documented: false },
  image_animation: { ai: true, metaDefault: 'unbekannt', media: 'image', documented: true },
  image_background_gen: { ai: true, metaDefault: 'unbekannt', media: 'image', documented: true },
  image_brightness_and_contrast: { ai: false, metaDefault: 'unbekannt', media: 'image', documented: true },
  image_templates: { ai: true, metaDefault: 'unbekannt', media: 'image', documented: true },
  creative_stickers: { ai: true, metaDefault: 'unbekannt', media: 'all', documented: true },
  enhance_cta: { ai: true, metaDefault: 'unbekannt', media: 'all', documented: true },
  text_optimizations: { ai: true, metaDefault: 'unbekannt', media: 'all', documented: true },
  text_generation: { ai: true, metaDefault: 'unbekannt', media: 'all', documented: true },
  text_translation: { ai: true, metaDefault: 'unbekannt', media: 'all', documented: true },
  image_text_translation: { ai: true, metaDefault: 'unbekannt', media: 'image', documented: true },
  inline_comment: { ai: false, metaDefault: 'OPT_IN', media: 'all', documented: true },
  description_automation: { ai: false, metaDefault: 'OPT_IN', media: 'all', documented: true },
  reveal_details_over_time: { ai: false, metaDefault: 'unbekannt', media: 'all', documented: true },
  site_extensions: { ai: false, metaDefault: 'unbekannt', media: 'all', documented: true },
  show_summary: { ai: true, metaDefault: 'unbekannt', media: 'all', documented: true },
  show_destination_blurbs: { ai: true, metaDefault: 'unbekannt', media: 'all', documented: true },
  pac_relaxation: { ai: false, metaDefault: 'unbekannt', media: 'all', documented: true },
  replace_media_text: { ai: true, metaDefault: 'unbekannt', media: 'image', documented: false },
}
/** HP-Standard: jede Funktion ausdrücklich AUS (Fotos echt, Texte von Sven, keine Gedankenstriche). */
export const HP_CREATIVE_FEATURE_DEFAULT: Enroll = 'OPT_OUT'
export const CREATIVE_FEATURE_OPTIONS: readonly EnumOption<CreativeFeature>[] = CREATIVE_FEATURES.map(v => opt('feature', v))
export const ENROLL_OPTIONS: readonly EnumOption<Enroll>[] = [
  opt('enroll', 'OPT_OUT', { recommended: true }),
  opt('enroll', 'OPT_IN'),
]

// ── Vorschau-Formate (generatepreviews ad_format) ──────────────────────────
export const PREVIEW_FORMATS = [
  'MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_STORY', 'INSTAGRAM_REELS',
  'FACEBOOK_STORY_MOBILE', 'FACEBOOK_REELS_MOBILE', 'DESKTOP_FEED_STANDARD',
  'RIGHT_COLUMN_STANDARD', 'MARKETPLACE_MOBILE', 'AUDIENCE_NETWORK_OUTSTREAM_VIDEO',
] as const
export type PreviewFormat = typeof PREVIEW_FORMATS[number]
export const PREVIEW_FORMAT_OPTIONS: readonly EnumOption<PreviewFormat>[] = PREVIEW_FORMATS.map(v => opt('preview', v))
/** Platzierung je Vorschau-Format (für „Vorschau aller Platzierungen“: nur, was die Anzeigengruppe ausspielen kann). */
export interface PreviewPlacement {
  platform: PublisherPlatform
  position: string
  /** nur auf diesem Gerät */
  device?: DevicePlatform
  /** nur für Videos */
  nurVideo?: true
  /** zeigt kein Karussell (Facebook Stories) */
  keinKarussell?: true
}
export const PREVIEW_PLACEMENT: Readonly<Record<PreviewFormat, PreviewPlacement>> = {
  MOBILE_FEED_STANDARD: { platform: 'facebook', position: 'feed', device: 'mobile' },
  INSTAGRAM_STANDARD: { platform: 'instagram', position: 'stream' },
  INSTAGRAM_STORY: { platform: 'instagram', position: 'story' },
  INSTAGRAM_REELS: { platform: 'instagram', position: 'reels' },
  FACEBOOK_STORY_MOBILE: { platform: 'facebook', position: 'story', device: 'mobile', keinKarussell: true },
  FACEBOOK_REELS_MOBILE: { platform: 'facebook', position: 'facebook_reels', device: 'mobile' },
  DESKTOP_FEED_STANDARD: { platform: 'facebook', position: 'feed', device: 'desktop' },
  RIGHT_COLUMN_STANDARD: { platform: 'facebook', position: 'right_hand_column', device: 'desktop' },
  MARKETPLACE_MOBILE: { platform: 'facebook', position: 'marketplace', device: 'mobile' },
  AUDIENCE_NETWORK_OUTSTREAM_VIDEO: { platform: 'audience_network', position: 'classic', nurVideo: true },
}
/** Reihenfolge der „Vorschau aller Platzierungen“ (SPEC3 E); Computer-Feed nur auf Wunsch. */
export const PREVIEW_ALLE_FORMATS: readonly PreviewFormat[] = [
  'MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_STORY', 'INSTAGRAM_REELS', 'FACEBOOK_REELS_MOBILE',
  'FACEBOOK_STORY_MOBILE', 'RIGHT_COLUMN_STANDARD', 'MARKETPLACE_MOBILE', 'AUDIENCE_NETWORK_OUTSTREAM_VIDEO',
]

// ═══════════════════════════════════════════════════════════════════════════
// 3. Entwurfs-Typen (meta_drafts.spec)
// ═══════════════════════════════════════════════════════════════════════════

export interface GeoKeyed { key: string; name?: string; country?: string; [k: string]: unknown }
export interface GeoRadius extends GeoKeyed { radius?: number; distance_unit?: 'kilometer' | 'mile' }
export interface CustomLocation {
  latitude?: number; longitude?: number; address_string?: string; name?: string
  radius?: number; distance_unit?: 'kilometer' | 'mile'; country?: string
  [k: string]: unknown
}
export interface GeoLocations {
  countries?: string[]
  country_groups?: string[]
  regions?: GeoKeyed[]
  cities?: GeoRadius[]
  zips?: GeoKeyed[]
  custom_locations?: CustomLocation[]
  places?: GeoRadius[]
  geo_markets?: GeoKeyed[]
  electoral_districts?: GeoKeyed[]
  location_types?: string[]
  [k: string]: unknown
}
export interface AudienceRef { id: string; name?: string; subtype?: string }
export interface TargetingEntity { id: string; name?: string }
/** Metas targeting-Objekt; unbekannte Felder bleiben erhalten (Durchreiche). Platzierungen stehen in AdsetDraft.placements. */
export interface TargetingSpec {
  geo_locations: GeoLocations
  excluded_geo_locations?: GeoLocations
  age_min?: number
  age_max?: number
  age_range?: number[]
  genders?: number[]
  locales?: number[]
  flexible_spec?: Array<Record<string, TargetingEntity[]>>
  exclusions?: Record<string, unknown>
  custom_audiences?: AudienceRef[]
  excluded_custom_audiences?: AudienceRef[]
  targeting_automation?: { advantage_audience?: number; individual_setting?: Record<string, unknown>; [k: string]: unknown }
  targeting_relaxation_types?: { custom_audience?: number; lookalike?: number; [k: string]: unknown }
  [k: string]: unknown
}

export interface ManualPlacements {
  mode: 'manual'
  publisher_platforms: PublisherPlatform[]
  facebook_positions?: FacebookPosition[]
  instagram_positions?: InstagramPosition[]
  threads_positions?: ThreadsPosition[]
  messenger_positions?: MessengerPosition[]
  audience_network_positions?: AudienceNetworkPosition[]
  device_platforms?: DevicePlatform[]
}
export type Placements = { mode: 'advantage' } | ManualPlacements

/**
 * Status bei Meta (configured status). Der Assistent setzt nur ACTIVE/PAUSED (Feld status);
 * ARCHIVED/DELETED kommen nur beim Lesen vor (Feld meta_status, nie löschen, nie archivieren).
 * Neue Objekte legt der Assistent immer PAUSED an, beide Felder gelten nur beim Bearbeiten.
 */
export type ObjectStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED'
export const OBJECT_STATUSES: readonly ObjectStatus[] = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED']
export type EditableStatus = 'ACTIVE' | 'PAUSED'
export const STATUS_OPTIONS: readonly EnumOption<EditableStatus>[] = [opt('status', 'ACTIVE'), opt('status', 'PAUSED')]

/**
 * Budgetplanung („Budget für Zeiträume mit hoher Nachfrage planen“, budget_schedule_specs).
 * time_start/time_end als ISO-Zeit (Formular, edit_load) oder Unix-Sekunden; an Meta gehen
 * Unix-Sekunden. ABSOLUTE: Erhöhung in Cent der Kontowährung; MULTIPLIER: Erhöhung in Prozent
 * (50 = +50 %; Meta-Doku knapp, per validate_only prüfen). Nur bei Tagesbudget; Meta-UI:
 * höchstens 50 Zeiträume, mindestens 3 Stunden, höchstens 8x Budget.
 */
export interface BudgetScheduleSpec {
  /** Meta-ID eines bestehenden Zeitraums (nur lesen) */
  id?: string
  time_start: string | number
  time_end: string | number
  budget_value: number
  budget_value_type: 'ABSOLUTE' | 'MULTIPLIER'
  recurrence_type?: 'ONE_TIME' | 'WEEKLY'
  weekly_schedule?: Array<{ days: number[]; minute_start: number; minute_end: number; timezone_type?: string }>
}
/** „Anzeigen nach einem Zeitplan schalten“ (adset_schedule): volle Stunden, Tage 0 = Sonntag bis 6 = Samstag. Nur mit Laufzeitbudget. */
export interface AdsetScheduleBlock {
  start_minute: number
  end_minute: number
  days: number[]
  timezone_type?: 'USER' | 'ADVERTISER'
}
/**
 * Werbemittel einer laufenden Anzeige ändern: 'ersetzen' = neues Creative an die bestehende
 * Anzeige (gleiche ID und Statistik, Meta prüft neu), 'neue_anzeige' = neue Anzeige mit dem
 * neuen Creative, die alte wird pausiert (nie gelöscht). Beides startet die Lernphase neu.
 */
export type CreativeTausch = 'ersetzen' | 'neue_anzeige'
export const CREATIVE_TAUSCH_OPTIONS: readonly EnumOption<CreativeTausch>[] = [
  opt('creative_tausch', 'neue_anzeige', { recommended: true, hintKey: `${K}.creative_tausch_hint.neue_anzeige` }),
  opt('creative_tausch', 'ersetzen', { hintKey: `${K}.creative_tausch_hint.ersetzen` }),
]

export interface CampaignDraft {
  existing_id?: string
  name: string
  objective: Objective
  buying_type: BuyingType
  special_ad_categories: SpecialCat[]
  special_ad_category_country: string[]
  /** 'campaign' = Advantage+ Kampagnenbudget (CBO) */
  budget_level: BudgetLevel
  daily_budget_cents?: number
  lifetime_budget_cents?: number
  bid_strategy?: BidStrategy
  is_adset_budget_sharing_enabled?: boolean
  spend_cap_cents?: number
  start_time?: string
  stop_time?: string
  /** nur Bearbeiten: Ein/Aus bei Meta (gewünscht) */
  status?: EditableStatus
  /** nur Bearbeiten, nur lesen: configured status bei Meta (auch ARCHIVED/DELETED) */
  meta_status?: ObjectStatus
  /** nur Bearbeiten: Budgetplanung (nur mit Kampagnen-Tagesbudget) */
  budget_schedule_specs?: BudgetScheduleSpec[]
}

export interface AdsetDraft {
  key: string
  existing_id?: string
  name: string
  destination: Destination
  optimization_goal: OptGoal
  billing_event: Billing
  promoted_object: PromotedObject
  attribution: AttributionPreset
  /** Kontowährung (USD) in Cent */
  daily_budget_cents?: number
  lifetime_budget_cents?: number
  /** nur ohne Kampagnenbudget; sonst gilt campaign.bid_strategy */
  bid_strategy?: BidStrategy
  bid_amount_cents?: number
  /** ROAS-Ziel x10000 (15000 = 1,5) */
  roas_average_floor?: number
  start_time?: string
  end_time?: string
  targeting: TargetingSpec
  placements: Placements
  dsa_beneficiary: string
  dsa_payor: string
  brand_safety?: BrandSafety
  excluded_publisher_categories?: PublisherCategory[]
  /** nur Bearbeiten: Ein/Aus bei Meta (gewünscht) */
  status?: EditableStatus
  /** nur Bearbeiten, nur lesen: configured status bei Meta (auch ARCHIVED/DELETED) */
  meta_status?: ObjectStatus
  /** „Anzeigen nach einem Zeitplan schalten“ (nur mit Laufzeitbudget) */
  adset_schedule?: AdsetScheduleBlock[]
  /** Ausgabenlimits für Anzeigengruppen (nur mit Kampagnen-Tagesbudget), Cent */
  daily_min_spend_target_cents?: number
  daily_spend_cap_cents?: number
  /** Ausgabenlimits für Anzeigengruppen (nur mit Kampagnen-Laufzeitbudget), Cent */
  lifetime_min_spend_target_cents?: number
  lifetime_spend_cap_cents?: number
  /** nur Bearbeiten: Budgetplanung (nur mit Tagesbudget der Anzeigengruppe) */
  budget_schedule_specs?: BudgetScheduleSpec[]
}

export interface MediaRef {
  /** meta_media.id */
  media_id: string
  image_hash?: string
  video_id?: string
  thumbnail_hash?: string
  /** Seitenverhältnis (das Formular übernimmt es aus meta_media), für Karussell- und Platzierungs-Prüfung */
  aspect?: MediaAspect
  /** Zuschnitt (image_crops) je Seitenverhältnis, nur Bilder */
  crops?: ImageCrops
  /** Video: eigenes Vorschaubild = Bild aus meta_media (über media_upload hochgeladen) */
  thumbnail_media_id?: string
  /**
   * Video: Herkunft des Vorschaubilds. 'meta_liste' = aus Metas Vorschlägen gewählt (video_vorschaubild,
   * thumbnail_hash bleibt fest), 'upload' = thumbnail_media_id, sonst Metas bevorzugtes Bild.
   */
  thumbnail_quelle?: 'meta_standard' | 'meta_liste' | 'upload'
  /** Video: Adresse des Vorschaubilds nur zur Anzeige im Formular (nicht an Meta) */
  thumbnail_url?: string
}
export interface CardDraft {
  headline: string
  description?: string
  /** leer = Ziel-URL der Anzeige */
  url?: string
  media: MediaRef
}
export type AdDestination =
  | { kind: 'website'; url: string; display_link?: string }
  | { kind: 'lead_form'; form_id: string }
  /** Website und Sofortformular: Meta zeigt je Person die Website oder das Formular */
  | { kind: 'website_lead_form'; url: string; form_id: string; display_link?: string }
  /** Klick zu WhatsApp: Nummer steht in der Anzeigengruppe (promoted_object.whatsapp_phone_number) bzw. an der Seite */
  | { kind: 'whatsapp'; begruessung?: string; nachricht?: string }
  /** Anrufe: Telefonnummer im internationalen Format (+49...) */
  | { kind: 'phone_call'; telefon: string }
  | { kind: 'messenger' }

/** Vorhandener Beitrag (Facebook: object_story_id „SeitenID_BeitragsID“, Instagram: Medien-ID). */
export interface BeitragRef {
  quelle: BeitragQuelle
  id: string
  /** nur zur Anzeige im Formular */
  permalink?: string
  vorschau_url?: string
  text?: string
}
/** Karussell-Schalter: Endkarte mit Profilbild (Meta-Standard an, HP-Standard aus), Reihenfolge automatisch (an). */
export interface KarussellOptionen { endkarte?: boolean; reihenfolge_automatisch?: boolean }
/** Weitere Sprache einer mehrsprachigen Anzeige (Standard = Texte der Anzeige auf Deutsch). */
export interface SprachVariante {
  sprache: AdSprache
  primary_text: string
  headline: string
  description?: string
  /** leer = Website-URL der Anzeige */
  url?: string
}
export interface SprachenSpec {
  varianten: SprachVariante[]
  /** Meta übersetzt die deutschen Texte automatisch (gekennzeichnet „Automatisch übersetzt“) */
  automatisch_uebersetzen?: AdSprache[]
}
/**
 * Partnerschaftswerbung (Branded Content): Partner als zweite Identität. partner_ist_absender = true:
 * Partner ist die Hauptidentität (seine Seite in object_story_spec), HP die zweite.
 */
export interface PartnerschaftSpec { partner_page_id?: string; partner_ig_user_id?: string; partner_ist_absender?: boolean }
/** Tracking der Anzeige: weitere Pixel (Website-Events), CRM-Lead-Qualität, eigene Conversion-Domain. */
export interface AdTrackingSpec {
  weitere_pixel?: string[]
  /** leadgen_quality_conversion (Conversion-Leads aus dem CRM, nur Sofortformulare; API-Pfad ungeprüft) */
  lead_qualitaet?: boolean
  /** nur 1. und 2. Ebene (z. B. happy-property.com); leer = aus der Website-URL */
  conversion_domain?: string
}

export interface AdDraft {
  key: string
  adset_key: string
  existing_id?: string
  name: string
  format: AdFormat
  identity: { page_id: string; instagram_user_id: string }
  primary_texts: string[]
  headlines: string[]
  descriptions: string[]
  cta_type: CtaType
  destination: AdDestination
  media: { feed_4x5?: MediaRef; story_9x16?: MediaRef; square_1x1?: MediaRef; landscape_191x1?: MediaRef; cards?: CardDraft[] }
  /** „Vorhandenen Beitrag verwenden“: Texte und Medien kommen aus dem Beitrag */
  beitrag?: BeitragRef
  karussell?: KarussellOptionen
  /** mehrere Sprachen (asset_feed_spec optimization_type LANGUAGE) */
  sprachen?: SprachenSpec
  partnerschaft?: PartnerschaftSpec
  tracking?: AdTrackingSpec
  creative_features: Partial<Record<CreativeFeature, Enroll>>
  multi_advertiser: Enroll
  source?: {
    catalog_ad_id?: string; studio?: boolean; pool_id?: string
    /** nur Bearbeiten: Creative-ID bei Meta (Ausgangsstand) */
    creative_id?: string
    /** nur Bearbeiten: Creative aus einem bestehenden Beitrag, Texte/Medien nicht änderbar */
    aus_beitrag?: boolean
    /**
     * nur Bearbeiten, nur lesen: Feed-Typ des Creatives bei Meta (aus asset_feed_spec.optimization_type).
     * Beim Ersetzen erlaubt Meta keinen Wechsel des Feed-Typs; der Typ lässt sich aus Texten/Medien
     * allein nicht sicher ableiten (z. B. gleiches Bild in beiden Platzierungs-Labels).
     */
    creative_mode?: CreativeMode
    /** nur Bearbeiten, nur lesen: Partnerschaft bei Meta, die der Assistent nicht abbilden kann (branded_content.partners) */
    partner_unbekannt?: boolean
  }
  /** nur Bearbeiten: Ein/Aus bei Meta (gewünscht) */
  status?: EditableStatus
  /** nur Bearbeiten, nur lesen: configured status bei Meta (auch ARCHIVED/DELETED) */
  meta_status?: ObjectStatus
  /** Tracking (Website-/App-/CRM-Events), Metas tracking_specs unverändert durchgereicht */
  tracking_specs?: Array<Record<string, unknown>>
}

export interface DraftSpec {
  v: 1
  campaign: CampaignDraft
  adsets: AdsetDraft[]
  ads: AdDraft[]
  /** HP-Bedienhilfen (nicht an Meta) */
  hp?: { budgets_synchron?: boolean; creative_tausch?: CreativeTausch }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Abhängigkeiten
// ═══════════════════════════════════════════════════════════════════════════

const optionsFor = <V extends string>(all: readonly EnumOption<V>[], values: readonly V[]): EnumOption<V>[] => {
  const out: EnumOption<V>[] = []
  for (const v of values) {
    const o = all.find(x => x.value === v)
    out.push(o ?? { value: v, labelKey: `${K}.unknown` })
  }
  return out
}

export function destinationsFor(objective: Objective): Destination[] {
  const m = GOALS_BY_OBJ_DEST[objective]
  if (!m) return []
  // Reihenfolge der Optionsliste (WEBSITE zuerst)
  return DESTINATION_OPTIONS.map(o => o.value).filter(v => !!m[v])
}
export function goalsFor(objective: Objective, destination: Destination): readonly OptGoal[] {
  return GOALS_BY_OBJ_DEST[objective]?.[destination] ?? []
}
export function isHec(cats: readonly string[] | undefined): boolean {
  return (cats ?? []).some(c => (HEC_CATEGORIES as readonly string[]).indexOf(c) >= 0)
}
export function draftIsHec(d: DraftSpec): boolean {
  return isHec(d.campaign?.special_ad_categories)
}
export function effectiveBidStrategy(c: CampaignDraft, a: AdsetDraft): BidStrategy {
  if (c.budget_level === 'campaign') return c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'
  return a.bid_strategy ?? c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'
}
/** Richtet sich die Zielgruppe (möglicherweise) auf die EU? Unklare Orte zählen als EU (DSA lieber zu oft). */
export function targetsEu(t: TargetingSpec | undefined): boolean {
  const g = t?.geo_locations
  if (!g) return true
  const eu = EU_COUNTRIES as readonly string[]
  if ((g.countries ?? []).some(c => eu.indexOf(c) >= 0)) return true
  if ((g.country_groups ?? []).some(c => ['eu', 'eea', 'europe', 'worldwide', 'emea'].indexOf(c.toLowerCase()) >= 0)) return true
  const others: Array<{ country?: string }> = [
    ...(g.regions ?? []), ...(g.cities ?? []), ...(g.zips ?? []), ...(g.custom_locations ?? []),
    ...(g.places ?? []), ...(g.geo_markets ?? []), ...(g.electoral_districts ?? []),
  ]
  for (const o of others) {
    if (!o.country) return true
    if (eu.indexOf(o.country) >= 0) return true
  }
  return false
}
export function adsetByKey(d: DraftSpec, key: string): AdsetDraft | undefined {
  return (d.adsets ?? []).find(a => a.key === key)
}
export function adByKey(d: DraftSpec, key: string): AdDraft | undefined {
  return (d.ads ?? []).find(a => a.key === key)
}
export function adsetForAd(d: DraftSpec, adKey: string): AdsetDraft | undefined {
  const ad = adByKey(d, adKey)
  return ad ? adsetByKey(d, ad.adset_key) : undefined
}

const cleanTexts = (list: readonly string[] | undefined): string[] => {
  const out: string[] = []
  for (const s of list ?? []) {
    const t = (s ?? '').trim()
    if (t && out.indexOf(t) < 0) out.push(t)
  }
  return out.slice(0, LIMITS.textsPerKind)
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. FieldSpec-Register
// ═══════════════════════════════════════════════════════════════════════════

export type FieldKind = 'text' | 'money' | 'int' | 'enum' | 'multi' | 'bool' | 'datetime' | 'targeting' | 'media' | 'textlist' | 'schedule' | 'json'
export interface FieldSpec {
  key: string
  level: Level
  /** Pfad im Meta-Payload der Ebene (Anzeige: Creative-Pfade ohne 'creative.') */
  api: string
  /** weitere Meta-Pfade (blame_field_specs) für apiPathToFieldKey */
  apiAliases?: readonly string[]
  /** nur im Assistenten, kein eigenes Meta-Feld */
  virtual?: boolean
  kind: FieldKind
  labelKey: string
  helpKey?: string
  immutableAfterCreate?: boolean
  readOnly?: boolean
  maxLen?: number
  visible?(d: DraftSpec, node: string): boolean
  required?(d: DraftSpec, node: string): boolean
  options?(d: DraftSpec, node: string): EnumOption[]
  housing?: { lock?: unknown; hide?: true; min?: number; noteKey: string }
}

const HOUSING_NOTE = {
  banner: `${K}.housing.banner`,
  category: `${K}.housing.category`,
  age: `${K}.housing.age`,
  genders: `${K}.housing.genders`,
  geo: `${K}.housing.geo`,
  radius: `${K}.housing.radius`,
  exclusion: `${K}.housing.exclusion`,
  detailed: `${K}.housing.detailed`,
  lookalike: `${K}.housing.lookalike`,
  advantage_audience: `${K}.housing.advantage_audience`,
} as const
export const HOUSING_NOTE_KEYS: readonly string[] = Object.keys(HOUSING_NOTE).map(k => HOUSING_NOTE[k as keyof typeof HOUSING_NOTE])

type FieldInit = Omit<FieldSpec, 'key' | 'level' | 'api' | 'kind' | 'labelKey'>
const fld = (key: string, level: Level, api: string, kind: FieldKind, init?: FieldInit): FieldSpec =>
  ({ key, level, api, kind, labelKey: `${K}.field.${key.replace(/\./g, '_')}`, ...(init ?? {}) })
const help = (name: string): string => `${K}.help.${name}`

const isCbo = (d: DraftSpec): boolean => d.campaign?.budget_level === 'campaign'
const adsetOf = (d: DraftSpec, node: string): AdsetDraft | undefined => adsetByKey(d, node)
const adOf = (d: DraftSpec, node: string): AdDraft | undefined => adByKey(d, node)
const ruleOf = (d: DraftSpec, node: string): PromotedRule | null => {
  const a = adsetOf(d, node)
  return a && d.campaign ? promotedRuleFor(d.campaign.objective, a.destination, a.optimization_goal) : null
}
const ruleHas = (d: DraftSpec, node: string, k: PromotedKey): boolean => {
  const r = ruleOf(d, node)
  return !!r && promotedAllowed(r).indexOf(k) >= 0
}
const ruleNeeds = (d: DraftSpec, node: string, k: PromotedKey): boolean => {
  const r = ruleOf(d, node)
  return !!r && r.anyOf.length === 1 && r.anyOf[0].indexOf(k) >= 0
}
const manualOf = (d: DraftSpec, node: string): ManualPlacements | null => {
  const p = adsetOf(d, node)?.placements
  return p && p.mode === 'manual' ? p : null
}
const platformOn = (d: DraftSpec, node: string, p: PublisherPlatform): boolean => {
  const m = manualOf(d, node)
  return !!m && m.publisher_platforms.indexOf(p) >= 0
}

export const FIELD_SPECS: readonly FieldSpec[] = [
  // ── Kampagne ──
  fld('campaign.name', 'campaign', 'name', 'text', { maxLen: LIMITS.nameMax, required: () => true }),
  fld('campaign.objective', 'campaign', 'objective', 'enum', {
    immutableAfterCreate: true, required: () => true, options: () => [...OBJECTIVE_OPTIONS],
  }),
  fld('campaign.buying_type', 'campaign', 'buying_type', 'enum', {
    immutableAfterCreate: true, visible: () => false, options: () => [...BUYING_TYPE_OPTIONS],
  }),
  fld('campaign.special_ad_categories', 'campaign', 'special_ad_categories', 'multi', {
    immutableAfterCreate: true, required: () => true, options: () => [...SAC_OPTIONS],
    housing: { lock: ['HOUSING'], noteKey: HOUSING_NOTE.category },
  }),
  fld('campaign.special_ad_category_country', 'campaign', 'special_ad_category_country', 'multi', {
    required: d => (d.campaign?.special_ad_categories ?? []).some(c => c !== 'NONE'),
  }),
  fld('campaign.budget_level', 'campaign', 'budget_level', 'enum', {
    virtual: true, helpKey: help('campaign_budget_level'), options: () => [...BUDGET_LEVEL_OPTIONS],
  }),
  fld('campaign.daily_budget_cents', 'campaign', 'daily_budget', 'money', { visible: isCbo }),
  fld('campaign.lifetime_budget_cents', 'campaign', 'lifetime_budget', 'money', { visible: isCbo }),
  fld('campaign.bid_strategy', 'campaign', 'bid_strategy', 'enum', {
    apiAliases: ['adset_bid_amounts'], visible: isCbo, options: () => [...BID_OPTIONS],
  }),
  fld('campaign.is_adset_budget_sharing_enabled', 'campaign', 'is_adset_budget_sharing_enabled', 'bool', {
    helpKey: help('campaign_budget_sharing'), visible: d => !isCbo(d),
  }),
  fld('campaign.spend_cap_cents', 'campaign', 'spend_cap', 'money'),
  fld('campaign.start_time', 'campaign', 'start_time', 'datetime'),
  fld('campaign.stop_time', 'campaign', 'stop_time', 'datetime', {
    required: d => isCbo(d) && !!d.campaign?.lifetime_budget_cents,
  }),
  // nur Bearbeiten (bestehende Kampagne)
  fld('campaign.status', 'campaign', 'status', 'enum', {
    helpKey: help('status'), visible: d => !!d.campaign?.existing_id, options: () => [...STATUS_OPTIONS],
  }),
  fld('campaign.budget_schedule_specs', 'campaign', 'budget_schedule_specs', 'schedule', {
    helpKey: help('budget_schedule'), visible: d => !!d.campaign?.existing_id && isCbo(d) && !!d.campaign?.daily_budget_cents,
  }),

  // ── Anzeigengruppe ──
  fld('adset.name', 'adset', 'name', 'text', { maxLen: LIMITS.nameMax, required: () => true }),
  fld('adset.destination', 'adset', 'destination_type', 'enum', {
    immutableAfterCreate: true, required: () => true,
    options: d => d.campaign ? optionsFor(DESTINATION_OPTIONS, destinationsFor(d.campaign.objective)) : [],
  }),
  fld('adset.optimization_goal', 'adset', 'optimization_goal', 'enum', {
    immutableAfterCreate: true, required: () => true,
    options: (d, node) => {
      const a = adsetOf(d, node)
      return a && d.campaign ? optionsFor(GOAL_OPTIONS, goalsFor(d.campaign.objective, a.destination)) : []
    },
  }),
  fld('adset.billing_event', 'adset', 'billing_event', 'enum', {
    required: () => true,
    visible: (d, node) => { const a = adsetOf(d, node); return !!a && billingFor(a.optimization_goal).length > 1 },
    options: (d, node) => { const a = adsetOf(d, node); return a ? optionsFor(BILLING_OPTIONS, billingFor(a.optimization_goal)) : [] },
  }),
  fld('adset.promoted_object.pixel_id', 'adset', 'promoted_object.pixel_id', 'text', {
    apiAliases: ['promoted_object'], helpKey: help('adset_pixel'), immutableAfterCreate: false,
    visible: (d, node) => ruleHas(d, node, 'pixel_id'),
    required: (d, node) => ruleNeeds(d, node, 'pixel_id'),
  }),
  fld('adset.promoted_object.custom_event_type', 'adset', 'promoted_object.custom_event_type', 'enum', {
    apiAliases: ['promoted_object.custom_event_str'],
    visible: (d, node) => ruleHas(d, node, 'custom_event_type'),
    required: (d, node) => ruleNeeds(d, node, 'custom_event_type') || !!adsetOf(d, node)?.promoted_object?.pixel_id && !adsetOf(d, node)?.promoted_object?.custom_conversion_id,
    options: () => [...CUSTOM_EVENT_OPTIONS],
  }),
  fld('adset.promoted_object.custom_conversion_id', 'adset', 'promoted_object.custom_conversion_id', 'text', {
    immutableAfterCreate: true, visible: (d, node) => ruleHas(d, node, 'custom_conversion_id'),
  }),
  fld('adset.promoted_object.page_id', 'adset', 'promoted_object.page_id', 'text', {
    immutableAfterCreate: true, visible: (d, node) => ruleHas(d, node, 'page_id'),
    required: (d, node) => ruleNeeds(d, node, 'page_id'),
  }),
  fld('adset.promoted_object.whatsapp_phone_number', 'adset', 'promoted_object.whatsapp_phone_number', 'text', {
    helpKey: help('adset_whatsapp'), immutableAfterCreate: true, visible: (d, node) => ruleHas(d, node, 'whatsapp_phone_number'),
  }),
  fld('adset.attribution', 'adset', 'attribution_spec', 'enum', {
    helpKey: help('adset_attribution'),
    options: (d, node) => { const a = adsetOf(d, node); return a ? optionsFor(ATTRIBUTION_OPTIONS, attributionFor(a.optimization_goal)) : [] },
  }),
  fld('adset.daily_budget_cents', 'adset', 'daily_budget', 'money', { visible: d => !isCbo(d) }),
  fld('adset.lifetime_budget_cents', 'adset', 'lifetime_budget', 'money', { visible: d => !isCbo(d) }),
  fld('adset.bid_strategy', 'adset', 'bid_strategy', 'enum', { visible: d => !isCbo(d), options: () => [...BID_OPTIONS] }),
  fld('adset.bid_amount_cents', 'adset', 'bid_amount', 'money', {
    visible: (d, node) => { const a = adsetOf(d, node); return !!a && !!d.campaign && BID_NEEDS_AMOUNT.indexOf(effectiveBidStrategy(d.campaign, a)) >= 0 },
    required: (d, node) => { const a = adsetOf(d, node); return !!a && !!d.campaign && BID_NEEDS_AMOUNT.indexOf(effectiveBidStrategy(d.campaign, a)) >= 0 },
  }),
  fld('adset.roas_average_floor', 'adset', 'bid_constraints.roas_average_floor', 'int', {
    apiAliases: ['bid_constraints'],
    visible: (d, node) => { const a = adsetOf(d, node); return !!a && !!d.campaign && effectiveBidStrategy(d.campaign, a) === 'LOWEST_COST_WITH_MIN_ROAS' },
  }),
  fld('adset.start_time', 'adset', 'start_time', 'datetime'),
  fld('adset.end_time', 'adset', 'end_time', 'datetime', {
    required: (d, node) => !isCbo(d) && !!adsetOf(d, node)?.lifetime_budget_cents,
  }),
  fld('adset.targeting', 'adset', 'targeting', 'targeting'),
  fld('adset.targeting.geo_locations', 'adset', 'targeting.geo_locations', 'targeting', {
    required: () => true, housing: { min: HOUSING_MIN_RADIUS_KM, noteKey: HOUSING_NOTE.radius },
  }),
  fld('adset.targeting.location_types', 'adset', 'targeting.geo_locations.location_types', 'multi', {
    options: () => [...LOCATION_TYPE_OPTIONS],
  }),
  fld('adset.targeting.age', 'adset', 'targeting.age_min', 'targeting', {
    apiAliases: ['targeting.age_max', 'targeting.age_range'],
    housing: { lock: [HOUSING_AGE_MIN, HOUSING_AGE_MAX], noteKey: HOUSING_NOTE.age },
  }),
  fld('adset.targeting.genders', 'adset', 'targeting.genders', 'multi', { housing: { hide: true, noteKey: HOUSING_NOTE.genders } }),
  fld('adset.targeting.locales', 'adset', 'targeting.locales', 'multi'),
  fld('adset.targeting.detailed', 'adset', 'targeting.flexible_spec', 'targeting', {
    apiAliases: [
      'targeting.interests', 'targeting.behaviors', 'targeting.life_events', 'targeting.industries',
      'targeting.income', 'targeting.family_statuses', 'targeting.relationship_statuses',
      'targeting.education_statuses', 'targeting.education_schools', 'targeting.education_majors',
      'targeting.work_positions', 'targeting.work_employers', 'targeting.user_adclusters',
      'targeting.exclusions', 'targeting.targeting_optimization',
    ],
    housing: { noteKey: HOUSING_NOTE.detailed },
  }),
  fld('adset.targeting.custom_audiences', 'adset', 'targeting.custom_audiences', 'multi', {
    apiAliases: ['targeting.targeting_relaxation_types'], housing: { noteKey: HOUSING_NOTE.lookalike },
  }),
  fld('adset.targeting.excluded_custom_audiences', 'adset', 'targeting.excluded_custom_audiences', 'multi'),
  fld('adset.targeting.excluded_geo_locations', 'adset', 'targeting.excluded_geo_locations', 'targeting', {
    housing: { hide: true, noteKey: HOUSING_NOTE.exclusion },
  }),
  fld('adset.targeting.advantage_audience', 'adset', 'targeting.targeting_automation.advantage_audience', 'bool', {
    apiAliases: ['targeting.targeting_automation'], helpKey: help('adset_advantage_audience'),
    housing: { noteKey: HOUSING_NOTE.advantage_audience },
  }),
  fld('adset.placements', 'adset', 'placements', 'enum', {
    virtual: true, helpKey: help('adset_placements'), options: () => [...PLACEMENT_MODE_OPTIONS],
  }),
  fld('adset.placements.publisher_platforms', 'adset', 'targeting.publisher_platforms', 'multi', {
    visible: (d, node) => !!manualOf(d, node), required: (d, node) => !!manualOf(d, node),
    options: () => [...PLATFORM_OPTIONS],
  }),
  fld('adset.placements.facebook_positions', 'adset', 'targeting.facebook_positions', 'multi', {
    visible: (d, node) => platformOn(d, node, 'facebook'), options: () => [...POSITION_OPTIONS.facebook],
  }),
  fld('adset.placements.instagram_positions', 'adset', 'targeting.instagram_positions', 'multi', {
    visible: (d, node) => platformOn(d, node, 'instagram'), options: () => [...POSITION_OPTIONS.instagram],
  }),
  fld('adset.placements.threads_positions', 'adset', 'targeting.threads_positions', 'multi', {
    visible: (d, node) => platformOn(d, node, 'threads'), options: () => [...POSITION_OPTIONS.threads],
  }),
  fld('adset.placements.messenger_positions', 'adset', 'targeting.messenger_positions', 'multi', {
    visible: (d, node) => platformOn(d, node, 'messenger'), options: () => [...POSITION_OPTIONS.messenger],
  }),
  fld('adset.placements.audience_network_positions', 'adset', 'targeting.audience_network_positions', 'multi', {
    visible: (d, node) => platformOn(d, node, 'audience_network'), options: () => [...POSITION_OPTIONS.audience_network],
  }),
  fld('adset.placements.device_platforms', 'adset', 'targeting.device_platforms', 'multi', {
    visible: (d, node) => !!manualOf(d, node), options: () => [...DEVICE_OPTIONS],
  }),
  fld('adset.dsa_beneficiary', 'adset', 'dsa_beneficiary', 'text', {
    maxLen: LIMITS.dsaMax, helpKey: help('adset_dsa'),
    required: (d, node) => targetsEu(adsetOf(d, node)?.targeting),
  }),
  fld('adset.dsa_payor', 'adset', 'dsa_payor', 'text', {
    maxLen: LIMITS.dsaMax, helpKey: help('adset_dsa'),
    required: (d, node) => targetsEu(adsetOf(d, node)?.targeting),
  }),
  fld('adset.brand_safety', 'adset', 'targeting.brand_safety_content_filter_levels', 'enum', {
    options: () => [...BRAND_SAFETY_OPTIONS],
  }),
  fld('adset.excluded_publisher_categories', 'adset', 'targeting.excluded_publisher_categories', 'multi', {
    apiAliases: ['targeting.excluded_publisher_list_ids'], options: () => [...PUBLISHER_CATEGORY_OPTIONS],
  }),
  // nur Bearbeiten (bestehende Anzeigengruppe): Zeitplan und Gruppen-Limits sendet das Anlegen nicht
  // (validateDraft meldet sie an neuen Objekten serverseitig als 'edit_only')
  fld('adset.adset_schedule', 'adset', 'adset_schedule', 'schedule', {
    apiAliases: ['pacing_type'], helpKey: help('adset_schedule'),
    visible: (d, node) => !!adsetOf(d, node)?.existing_id
      && (isCbo(d) ? !!d.campaign?.lifetime_budget_cents : !!adsetOf(d, node)?.lifetime_budget_cents),
  }),
  fld('adset.daily_min_spend_target_cents', 'adset', 'daily_min_spend_target', 'money', {
    helpKey: help('adset_spend_limits'), visible: (d, node) => !!adsetOf(d, node)?.existing_id && isCbo(d) && !!d.campaign?.daily_budget_cents,
  }),
  fld('adset.daily_spend_cap_cents', 'adset', 'daily_spend_cap', 'money', {
    helpKey: help('adset_spend_limits'), visible: (d, node) => !!adsetOf(d, node)?.existing_id && isCbo(d) && !!d.campaign?.daily_budget_cents,
  }),
  fld('adset.lifetime_min_spend_target_cents', 'adset', 'lifetime_min_spend_target', 'money', {
    helpKey: help('adset_spend_limits'), visible: (d, node) => !!adsetOf(d, node)?.existing_id && isCbo(d) && !!d.campaign?.lifetime_budget_cents,
  }),
  fld('adset.lifetime_spend_cap_cents', 'adset', 'lifetime_spend_cap', 'money', {
    helpKey: help('adset_spend_limits'), visible: (d, node) => !!adsetOf(d, node)?.existing_id && isCbo(d) && !!d.campaign?.lifetime_budget_cents,
  }),
  fld('adset.status', 'adset', 'status', 'enum', {
    helpKey: help('status'), visible: (d, node) => !!adsetOf(d, node)?.existing_id, options: () => [...STATUS_OPTIONS],
  }),
  fld('adset.budget_schedule_specs', 'adset', 'budget_schedule_specs', 'schedule', {
    helpKey: help('budget_schedule'),
    visible: (d, node) => !!adsetOf(d, node)?.existing_id && !isCbo(d) && !!adsetOf(d, node)?.daily_budget_cents,
  }),

  // ── Anzeige (api = Pfad im Creative bzw. im Ad) ──
  fld('ad.name', 'ad', 'name', 'text', { maxLen: LIMITS.nameMax, required: () => true }),
  fld('ad.format', 'ad', 'format', 'enum', { virtual: true, immutableAfterCreate: true, options: () => [...AD_FORMAT_OPTIONS] }),
  fld('ad.identity.page_id', 'ad', 'object_story_spec.page_id', 'text', {
    apiAliases: ['actor_id'], required: () => true, immutableAfterCreate: true,
  }),
  fld('ad.identity.instagram_user_id', 'ad', 'object_story_spec.instagram_user_id', 'text', {
    apiAliases: ['instagram_user_id', 'object_story_spec.instagram_actor_id'], required: () => true, immutableAfterCreate: true,
  }),
  fld('ad.primary_texts', 'ad', 'object_story_spec.link_data.message', 'textlist', {
    apiAliases: ['object_story_spec.video_data.message', 'asset_feed_spec.bodies', 'body'],
    maxLen: LIMITS.primaryTextMax, required: () => true,
  }),
  fld('ad.headlines', 'ad', 'object_story_spec.link_data.name', 'textlist', {
    apiAliases: ['object_story_spec.video_data.title', 'asset_feed_spec.titles', 'title'],
    maxLen: LIMITS.headlineApiMax, required: () => true,
  }),
  fld('ad.descriptions', 'ad', 'object_story_spec.link_data.description', 'textlist', {
    apiAliases: ['object_story_spec.video_data.link_description', 'asset_feed_spec.descriptions'],
    maxLen: LIMITS.descriptionApiMax,
  }),
  fld('ad.cta_type', 'ad', 'object_story_spec.link_data.call_to_action', 'enum', {
    apiAliases: [
      'object_story_spec.video_data.call_to_action', 'asset_feed_spec.call_to_action_types',
      'asset_feed_spec.call_to_actions', 'call_to_action',
    ],
    required: (d, node) => adOf(d, node)?.beitrag?.quelle !== 'facebook',
    options: (d, node) => { const ad = adOf(d, node); return optionsFor(CTA_OPTIONS, ctaFor(ad ? ad.destination.kind : 'website')) },
  }),
  // Anzeigeneinrichtung (Werbeanzeige erstellen / Vorhandenen Beitrag verwenden)
  fld('ad.setup', 'ad', 'setup', 'enum', { virtual: true, helpKey: help('ad_setup'), options: () => [...AD_SETUP_OPTIONS] }),
  fld('ad.beitrag', 'ad', 'object_story_id', 'text', {
    apiAliases: ['source_instagram_media_id', 'object_id', 'instagram_permalink_url', 'source_facebook_post_id'],
    helpKey: help('ad_beitrag'), visible: (d, node) => !!adOf(d, node)?.beitrag, required: (d, node) => !!adOf(d, node)?.beitrag,
  }),
  fld('ad.destination.kind', 'ad', 'destination', 'enum', {
    virtual: true, helpKey: help('ad_destination_kind'),
    options: (d, node) => {
      const ad = adOf(d, node)
      const a = ad ? adsetByKey(d, ad.adset_key) : undefined
      const kinds = a ? adKindsFor(a.destination) : AD_DESTINATION_KINDS
      return optionsFor(AD_DESTINATION_KIND_OPTIONS, kinds.length ? kinds : ['website'])
    },
  }),
  fld('ad.destination.url', 'ad', 'object_story_spec.link_data.link', 'text', {
    apiAliases: [
      'asset_feed_spec.link_urls', 'object_story_spec.link_data.call_to_action.value.link',
      'object_story_spec.video_data.call_to_action.value.link', 'link_url', 'object_url',
    ],
    maxLen: LIMITS.urlMax,
    visible: (d, node) => isWebsiteKind(adOf(d, node)?.destination.kind),
    required: (d, node) => isWebsiteKind(adOf(d, node)?.destination.kind) && adOf(d, node)?.beitrag?.quelle !== 'facebook',
  }),
  fld('ad.destination.display_link', 'ad', 'object_story_spec.link_data.caption', 'text', {
    apiAliases: ['asset_feed_spec.link_urls.display_url'],
    visible: (d, node) => isWebsiteKind(adOf(d, node)?.destination.kind),
  }),
  fld('ad.destination.form_id', 'ad', 'object_story_spec.link_data.call_to_action.value.lead_gen_form_id', 'enum', {
    apiAliases: [
      'object_story_spec.video_data.call_to_action.value.lead_gen_form_id',
      'asset_feed_spec.call_to_actions.value.lead_gen_form_id', 'lead_gen_form_id',
    ],
    visible: (d, node) => isFormKind(adOf(d, node)?.destination.kind),
    required: (d, node) => isFormKind(adOf(d, node)?.destination.kind),
  }),
  fld('ad.destination.telefon', 'ad', 'destination.telefon', 'text', {
    virtual: true, helpKey: help('ad_telefon'),
    visible: (d, node) => adOf(d, node)?.destination.kind === 'phone_call',
    required: (d, node) => adOf(d, node)?.destination.kind === 'phone_call',
  }),
  fld('ad.destination.whatsapp_begruessung', 'ad', 'object_story_spec.link_data.page_welcome_message', 'text', {
    apiAliases: ['page_welcome_message', 'object_story_spec.video_data.page_welcome_message'],
    maxLen: LIMITS.whatsappTextMax, helpKey: help('ad_whatsapp_begruessung'),
    visible: (d, node) => adOf(d, node)?.destination.kind === 'whatsapp',
  }),
  fld('ad.destination.whatsapp_nachricht', 'ad', 'destination.whatsapp_nachricht', 'text', {
    virtual: true, maxLen: LIMITS.whatsappTextMax, helpKey: help('ad_whatsapp_nachricht'),
    visible: (d, node) => adOf(d, node)?.destination.kind === 'whatsapp',
  }),
  fld('ad.media.feed_4x5', 'ad', 'object_story_spec.link_data.image_hash', 'media', {
    apiAliases: [
      'object_story_spec.link_data.picture', 'object_story_spec.video_data.video_id',
      'asset_feed_spec.images', 'asset_feed_spec.videos', 'asset_feed_spec.asset_customization_rules',
      'asset_feed_spec.ad_formats', 'asset_feed_spec', 'image_hash',
    ],
    visible: (d, node) => { const ad = adOf(d, node); return !!ad && ad.format !== 'carousel' && !ad.beitrag },
  }),
  fld('ad.media.story_9x16', 'ad', 'media.story_9x16', 'media', {
    virtual: true, visible: (d, node) => { const ad = adOf(d, node); return !!ad && ad.format !== 'carousel' && !ad.beitrag },
  }),
  fld('ad.media.square_1x1', 'ad', 'media.square_1x1', 'media', { virtual: true, visible: (d, node) => !adOf(d, node)?.beitrag }),
  fld('ad.media.landscape_191x1', 'ad', 'media.landscape_191x1', 'media', {
    virtual: true, helpKey: help('ad_landscape'),
    visible: (d, node) => { const ad = adOf(d, node); return !!ad && ad.format !== 'carousel' && !ad.beitrag },
  }),
  fld('ad.media.crops', 'ad', 'object_story_spec.link_data.image_crops', 'json', {
    apiAliases: ['asset_feed_spec.images.image_crops', 'object_story_spec.link_data.child_attachments.image_crops', 'image_crops'],
    helpKey: help('ad_crops'), visible: (d, node) => { const ad = adOf(d, node); return !!ad && ad.format !== 'single_video' && !ad.beitrag },
  }),
  fld('ad.media.thumbnail', 'ad', 'object_story_spec.video_data.image_hash', 'media', {
    apiAliases: ['object_story_spec.video_data.image_url', 'asset_feed_spec.videos.thumbnail_hash', 'asset_feed_spec.videos.thumbnail_url', 'thumbnail_url'],
    helpKey: help('ad_thumbnail'), visible: (d, node) => adOf(d, node)?.format === 'single_video' && !adOf(d, node)?.beitrag,
  }),
  fld('ad.media.untertitel', 'ad', 'media.untertitel', 'media', {
    virtual: true, helpKey: help('ad_untertitel'), visible: (d, node) => adOf(d, node)?.format === 'single_video' && !adOf(d, node)?.beitrag,
  }),
  fld('ad.media.cards', 'ad', 'object_story_spec.link_data.child_attachments', 'media', {
    visible: (d, node) => adOf(d, node)?.format === 'carousel',
    required: (d, node) => adOf(d, node)?.format === 'carousel',
  }),
  fld('ad.karussell.endkarte', 'ad', 'object_story_spec.link_data.multi_share_end_card', 'bool', {
    helpKey: help('ad_karussell_endkarte'), visible: (d, node) => adOf(d, node)?.format === 'carousel',
  }),
  fld('ad.karussell.reihenfolge_automatisch', 'ad', 'object_story_spec.link_data.multi_share_optimized', 'bool', {
    helpKey: help('ad_karussell_reihenfolge'), visible: (d, node) => adOf(d, node)?.format === 'carousel',
  }),
  fld('ad.sprachen', 'ad', 'asset_feed_spec.autotranslate', 'json', {
    apiAliases: ['asset_feed_spec.asset_customization_rules.customization_spec.locales', 'asset_feed_spec.asset_customization_rules.is_default'],
    helpKey: help('ad_sprachen'),
    visible: (d, node) => {
      const ad = adOf(d, node)
      return !!ad && !ad.beitrag && isWebsiteKind(ad.destination.kind) && (ad.format === 'single_image' || ad.format === 'single_video')
    },
  }),
  fld('ad.partnerschaft', 'ad', 'facebook_branded_content', 'json', {
    apiAliases: ['instagram_branded_content', 'branded_content', 'branded_content_sponsor_page_id'],
    helpKey: help('ad_partnerschaft'),
  }),
  fld('ad.creative_features', 'ad', 'degrees_of_freedom_spec', 'multi', {
    helpKey: help('ad_creative_features'), options: () => [...CREATIVE_FEATURE_OPTIONS],
  }),
  fld('ad.multi_advertiser', 'ad', 'contextual_multi_ads', 'enum', {
    helpKey: help('ad_multi_advertiser'), options: () => [...ENROLL_OPTIONS],
  }),
  fld('ad.url_tags', 'ad', 'url_tags', 'text', { readOnly: true, helpKey: help('ad_url_tags') }),
  fld('ad.tracking_specs', 'ad', 'tracking_specs', 'json', { helpKey: help('ad_tracking') }),
  fld('ad.tracking.pixel', 'ad', 'tracking.pixel', 'multi', { virtual: true, helpKey: help('ad_tracking_pixel') }),
  fld('ad.tracking.lead_qualitaet', 'ad', 'tracking.lead_qualitaet', 'bool', {
    virtual: true, helpKey: help('ad_tracking_lead_qualitaet'), visible: (d, node) => isFormKind(adOf(d, node)?.destination.kind),
  }),
  fld('ad.tracking.conversion_domain', 'ad', 'conversion_domain', 'text', { helpKey: help('ad_conversion_domain') }),
  // nur Bearbeiten (bestehende Anzeige)
  fld('ad.status', 'ad', 'status', 'enum', {
    helpKey: help('status'), visible: (d, node) => !!adOf(d, node)?.existing_id, options: () => [...STATUS_OPTIONS],
  }),
]

export function fieldSpec(key: string): FieldSpec | undefined {
  return FIELD_SPECS.find(f => f.key === key)
}

// ═══════════════════════════════════════════════════════════════════════════
// 6a. validateDraft
// ═══════════════════════════════════════════════════════════════════════════

export const ISSUE_CODES = [
  'required', 'too_long', 'invalid_option', 'unsupported', 'legacy_objective', 'duplicate_key',
  'housing_missing', 'housing_existing', 'country_missing',
  'budget_missing_campaign', 'budget_missing_adset', 'budget_both', 'budget_forbidden_on_campaign',
  'budget_forbidden_on_adset', 'lifetime_needs_end', 'budget_too_low', 'budget_low', 'spend_cap_low',
  'sharing_with_cbo', 'sharing_daily_only', 'sharing_same_bid',
  'bid_amount_required', 'roas_needs_value', 'roas_floor_required', 'cost_cap_billing', 'cbo_same_goal',
  'time_order', 'no_adsets', 'too_many_adsets', 'too_many_ads', 'adset_ref_missing',
  'promoted_missing', 'pixel_needs_event', 'pixel_mismatch', 'attribution_invalid',
  'geo_missing', 'age_range', 'advantage_age', 'city_radius',
  'housing_age', 'housing_gender', 'housing_geo_type', 'housing_exclusion', 'housing_radius',
  'housing_detailed', 'housing_lookalike', 'housing_advantage_audience',
  'dsa_missing', 'placements_empty', 'an_alone', 'threads_needs_ig', 'position_removed',
  'position_platform', 'fb_story_needs_feed', 'fb_feed_required', 'lead_ig_desktop',
  'identity_page', 'identity_ig', 'text_missing', 'too_many_texts', 'texts_dropped', 'descriptions_single',
  'carousel_multi_text', 'cta_invalid', 'cta_lead_form', 'url_invalid', 'url_has_utm', 'form_missing',
  'destination_mismatch', 'destination_unsupported', 'media_missing', 'video_thumb_missing',
  'cards_count', 'feature_unknown',
  // Werbemittel komplett + Conversion-Orte (Runde 2)
  'beitrag_invalid', 'beitrag_ziel', 'phone_invalid', 'whatsapp_invalid', 'website_form_event', 'crop_invalid',
  'cards_ratio', 'card_thumb_missing', 'thumb_invalid', 'lang_invalid', 'lang_multi_text', 'lang_destination',
  'lang_format', 'lang_auto_conflict', 'lang_no_pac', 'partner_missing', 'partner_page_required', 'partner_lead_form',
  'tracking_invalid', 'domain_invalid', 'dash_char',
  // nur Bearbeiten (validateEditFields)
  'schedule_invalid', 'budget_schedule_invalid', 'spend_limits_order', 'spend_cap_high', 'budget_high',
  // nur serverseitig: Bearbeiten-Feld an einem neuen Objekt (würde beim Anlegen nicht gesendet)
  'edit_only',
] as const
export type IssueCode = typeof ISSUE_CODES[number]
export type IssueSeverity = 'error' | 'warn'
export interface DraftIssue {
  level: Level
  /** 'campaign' oder key der Anzeigengruppe/Anzeige */
  node: string
  /** FieldSpec.key */
  field: string
  severity: IssueSeverity
  code: IssueCode
  messageKey: string
  params?: Record<string, string | number>
}
export const issueMessageKey = (code: IssueCode): string => `${K}.issue.${code}`
export const hasErrors = (issues: readonly DraftIssue[]): boolean => issues.some(i => i.severity === 'error')

/** Geo-Typen, die unter Wohnen/Beschäftigung/Finanzen verboten sind. */
export const HOUSING_FORBIDDEN_GEO_KEYS = [
  'zips', 'subcities', 'neighborhoods', 'subneighborhoods', 'metro_areas', 'small_geo_areas', 'electoral_districts',
] as const
/** Detailliertes Targeting, das unter HEC verboten ist (Interessen bleiben, Meta prüft). */
export const HOUSING_FORBIDDEN_DETAILED_KEYS = [
  'behaviors', 'life_events', 'industries', 'income', 'family_statuses', 'relationship_statuses',
  'education_statuses', 'education_schools', 'education_majors', 'college_years', 'work_employers',
  'work_positions', 'user_adclusters', 'demographics', 'home_ownership', 'home_type', 'home_value',
  'household_composition', 'net_worth', 'moms', 'politics', 'generation', 'ethnic_affinity',
] as const
const GEO_SELECT_KEYS = ['countries', 'country_groups', 'regions', 'cities', 'zips', 'custom_locations', 'places', 'geo_markets', 'electoral_districts']

const radiusKm = (radius: number | undefined, unit: string | undefined): number | null =>
  typeof radius === 'number' ? (unit === 'mile' ? radius * 1.609344 : radius) : null
/** Stadt-Radius außerhalb 17-80 km bzw. 10-50 Meilen (Metas Grenzen, in der Einheit des Eintrags). */
const cityRadiusOutOfRange = (radius: number | undefined, unit: string | undefined): boolean =>
  typeof radius === 'number' && (unit === 'mile'
    ? (radius < CITY_MIN_RADIUS_MI || radius > CITY_MAX_RADIUS_MI)
    : (radius < CITY_MIN_RADIUS_KM || radius > CITY_MAX_RADIUS_KM))

/**
 * Wirksamer Wert von targeting_automation.advantage_audience: fehlt = 1 (so sendet
 * buildTargeting), 0 / false / '0' = aus. Für Prüfung, Payload und Anzeige im UI.
 */
export function effectiveAdvantageAudience(v: unknown): 0 | 1 {
  return v === 0 || v === false || v === '0' ? 0 : 1
}
const nonEmpty = (v: unknown): boolean => Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== '')
const isLookalike = (a: AudienceRef): boolean => (a.subtype ?? '').toUpperCase() === 'LOOKALIKE'
const URL_RE = /^https?:\/\/[^\s/?#]+\.[^\s/?#]+[^\s]*$/i
/** Gedankenstriche (U+2012-U+2015), Svens Regel: nie in Texten */
const DASH_RE = /[\u2012-\u2015]/
const META_ID_RE = /^[0-9]{6,25}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validatePlacements(p: Placements, add: (field: string, code: IssueCode, sev?: IssueSeverity, params?: Record<string, string | number>) => void, isLeadGoal: boolean): void {
  if (p.mode !== 'manual') return
  const plats = p.publisher_platforms ?? []
  if (!plats.length) { add('adset.placements.publisher_platforms', 'placements_empty'); return }
  for (const pl of plats) if (!isIn(PUBLISHER_PLATFORMS, pl)) add('adset.placements.publisher_platforms', 'invalid_option', 'error', { value: String(pl) })
  if (plats.length === 1 && plats[0] === 'audience_network') add('adset.placements.publisher_platforms', 'an_alone')
  if (plats.indexOf('threads') >= 0) {
    const ig = p.instagram_positions
    if (plats.indexOf('instagram') < 0 || (ig && ig.length > 0 && ig.indexOf('stream') < 0)) add('adset.placements.threads_positions', 'threads_needs_ig')
  }
  for (const pl of PUBLISHER_PLATFORMS) {
    const field = POSITION_FIELD_BY_PLATFORM[pl]
    const list = (p[field] ?? []) as readonly string[]
    if (!list.length) continue
    const fk = `adset.placements.${field}`
    if (plats.indexOf(pl) < 0) add(fk, 'position_platform', 'error', { platform: pl })
    for (const pos of list) {
      if (REMOVED_POSITIONS[field].indexOf(pos) >= 0) add(fk, 'position_removed', 'error', { value: pos })
      else if (POSITIONS_BY_PLATFORM[pl].indexOf(pos) < 0) add(fk, 'invalid_option', 'error', { value: pos })
    }
  }
  const fb = p.facebook_positions ?? []
  const ig = p.instagram_positions ?? []
  if (fb.length) {
    const hasFeed = fb.indexOf('feed') >= 0
    if (fb.indexOf('story') >= 0 && !hasFeed && !(plats.indexOf('instagram') >= 0 && (ig.length === 0 || ig.indexOf('story') >= 0)))
      add('adset.placements.facebook_positions', 'fb_story_needs_feed')
    if (!hasFeed && fb.some(x => x === 'marketplace' || x === 'search' || x === 'profile_feed' || x === 'notification'))
      add('adset.placements.facebook_positions', 'fb_feed_required')
  }
  const dev = p.device_platforms ?? []
  for (const x of dev) if (!isIn(DEVICE_PLATFORMS, x)) add('adset.placements.device_platforms', 'invalid_option', 'error', { value: String(x) })
  if (isLeadGoal && plats.indexOf('instagram') >= 0 && dev.indexOf('desktop') >= 0)
    add('adset.placements.device_platforms', 'lead_ig_desktop')
}

function validateTargeting(t: TargetingSpec | undefined, hec: boolean, add: (field: string, code: IssueCode, sev?: IssueSeverity, params?: Record<string, string | number>) => void): void {
  if (!t || !t.geo_locations) { add('adset.targeting.geo_locations', 'geo_missing'); return }
  const g = t.geo_locations
  if (!GEO_SELECT_KEYS.some(k => nonEmpty(g[k]))) add('adset.targeting.geo_locations', 'geo_missing')
  const aMin = t.age_min ?? HOUSING_AGE_MIN
  const aMax = t.age_max ?? HOUSING_AGE_MAX
  if (aMin < 18 || aMax > 65 || aMin > aMax) add('adset.targeting.age', 'age_range', 'error', { min: aMin, max: aMax })
  const adv = t.targeting_automation?.advantage_audience
  if (effectiveAdvantageAudience(adv) === 1 && aMin > 25) add('adset.targeting.age', 'advantage_age', 'error', { min: aMin })
  for (const it of g.cities ?? []) {
    if (cityRadiusOutOfRange(it.radius, it.distance_unit)) {
      const km = radiusKm(it.radius, it.distance_unit) ?? 0
      add('adset.targeting.geo_locations', 'city_radius', 'error', { km: Math.round(km), min: CITY_MIN_RADIUS_KM, max: CITY_MAX_RADIUS_KM })
      break
    }
  }
  if (!hec) return
  if (aMin !== HOUSING_AGE_MIN || aMax !== HOUSING_AGE_MAX) add('adset.targeting.age', 'housing_age')
  if ((t.genders ?? []).some(x => x !== 0)) add('adset.targeting.genders', 'housing_gender')
  for (const k of HOUSING_FORBIDDEN_GEO_KEYS) if (nonEmpty(g[k])) add('adset.targeting.geo_locations', 'housing_geo_type', 'error', { type: k })
  const ex = t.excluded_geo_locations
  if (ex && Object.keys(ex).some(k => nonEmpty(ex[k]))) add('adset.targeting.excluded_geo_locations', 'housing_exclusion')
  if (t.exclusions && Object.keys(t.exclusions).length) add('adset.targeting.detailed', 'housing_exclusion')
  // Städte prüft city_radius (17 km); hier Adressen/Pins und Orte gegen 15 km
  const radiusItems: Array<{ radius?: number; distance_unit?: string }> = [...(g.custom_locations ?? []), ...(g.places ?? [])]
  for (const it of radiusItems) {
    const km = radiusKm(it.radius, it.distance_unit)
    if (km !== null && km < HOUSING_MIN_RADIUS_KM - 0.01) { add('adset.targeting.geo_locations', 'housing_radius', 'error', { km: Math.round(km) }); break }
  }
  const forbiddenDetailed = HOUSING_FORBIDDEN_DETAILED_KEYS as readonly string[]
  const flexBad = (t.flexible_spec ?? []).some(grp => Object.keys(grp).some(k => forbiddenDetailed.indexOf(k) >= 0 && nonEmpty(grp[k])))
  const topBad = forbiddenDetailed.some(k => nonEmpty(t[k]))
  if (flexBad || topBad) add('adset.targeting.detailed', 'housing_detailed')
  if ((t.custom_audiences ?? []).some(isLookalike) || (t.excluded_custom_audiences ?? []).some(isLookalike) || t.targeting_relaxation_types?.lookalike === 1)
    add('adset.targeting.custom_audiences', 'housing_lookalike')
  if (adv !== 0 && adv !== 1) add('adset.targeting.advantage_audience', 'housing_advantage_audience')
}

export interface ValidateDraftOptions {
  /**
   * Immobilien-Entwurf (Standard true, HP wirbt nur für Immobilien): neue Anzeigengruppen
   * oder Anzeigen in einer bestehenden Kampagne ohne HOUSING sind dann ein Fehler.
   */
  realEstate?: boolean
  /**
   * Serverseitige Prüfung (meta-builder). Im Browser ist ein Video ohne Vorschaubild nur
   * eine Warnung, weil der Server das Vorschaubild beim Anlegen selbst nachholt.
   */
  server?: boolean
}

/** Lokale Prüfung des ganzen Entwurfs (sofort im UI, serverseitig vor validate/create erneut). */
export function validateDraft(d: DraftSpec, opts: ValidateDraftOptions = {}): DraftIssue[] {
  const out: DraftIssue[] = []
  const push = (level: Level, node: string, field: string, code: IssueCode, severity: IssueSeverity = 'error', params?: Record<string, string | number>) =>
    out.push({ level, node, field, severity, code, messageKey: issueMessageKey(code), ...(params ? { params } : {}) })

  const c = d?.campaign
  if (!c) { push('campaign', 'campaign', 'campaign.name', 'required'); return out }
  const cAdd = (field: string, code: IssueCode, sev: IssueSeverity = 'error', params?: Record<string, string | number>) => push('campaign', 'campaign', field, code, sev, params)
  const isNew = !c.existing_id
  const adsets = Array.isArray(d.adsets) ? d.adsets : []
  const ads = Array.isArray(d.ads) ? d.ads : []

  // ── Kampagne ──
  if (!(c.name ?? '').trim()) cAdd('campaign.name', 'required')
  else if (c.name.length > LIMITS.nameMax) cAdd('campaign.name', 'too_long', 'error', { max: LIMITS.nameMax })
  if (!isIn(OBJECTIVES, c.objective)) {
    if (isIn(LEGACY_OBJECTIVES, c.objective)) { if (isNew) cAdd('campaign.objective', 'legacy_objective', 'error', { value: c.objective }) }
    else cAdd('campaign.objective', 'invalid_option', 'error', { value: String(c.objective) })
  } else if (isNew && OBJECTIVE_OPTIONS.some(o => o.value === c.objective && o.unsupported)) {
    cAdd('campaign.objective', 'unsupported', 'error', { value: c.objective })
  }
  if (c.buying_type !== 'AUCTION') cAdd('campaign.buying_type', 'invalid_option', 'error', { value: String(c.buying_type) })
  const cats = Array.isArray(c.special_ad_categories) ? c.special_ad_categories : []
  for (const cat of cats) {
    if (!isIn(SPECIAL_AD_CATEGORIES, cat)) cAdd('campaign.special_ad_categories', 'invalid_option', 'error', { value: String(cat) })
    else if (isNew && SAC_OPTIONS.some(o => o.value === cat && o.unsupported)) cAdd('campaign.special_ad_categories', 'unsupported', 'error', { value: cat })
  }
  if (cats.indexOf('NONE') >= 0 && cats.length > 1) cAdd('campaign.special_ad_categories', 'invalid_option', 'error', { value: 'NONE' })
  if (cats.indexOf('HOUSING') < 0) {
    if (isNew) cAdd('campaign.special_ad_categories', 'housing_missing')
    else {
      // Neues in einer bestehenden Kampagne ohne Wohnen: Fehler (SPEC §3), reines Lesen/Ändern: Hinweis
      const createsNew = adsets.some(a => !a.existing_id) || ads.some(a => !a.existing_id)
      cAdd('campaign.special_ad_categories', 'housing_existing', createsNew && opts.realEstate !== false ? 'error' : 'warn')
    }
  }
  const realCats = cats.filter(x => x !== 'NONE')
  if (realCats.length) {
    const cc = Array.isArray(c.special_ad_category_country) ? c.special_ad_category_country : []
    if (!cc.length) cAdd('campaign.special_ad_category_country', 'country_missing')
    for (const x of cc) if (!/^[A-Z]{2}$/.test(x)) cAdd('campaign.special_ad_category_country', 'invalid_option', 'error', { value: x })
  }
  const cbo = c.budget_level === 'campaign'
  if (c.budget_level !== 'campaign' && c.budget_level !== 'adset') cAdd('campaign.budget_level', 'invalid_option', 'error', { value: String(c.budget_level) })
  if (isNew) {
    if (cbo) {
      const hasD = (c.daily_budget_cents ?? 0) > 0, hasL = (c.lifetime_budget_cents ?? 0) > 0
      if (hasD && hasL) cAdd('campaign.daily_budget_cents', 'budget_both')
      else if (!hasD && !hasL) cAdd('campaign.daily_budget_cents', 'budget_missing_campaign')
      if (hasD && (c.daily_budget_cents ?? 0) < LIMITS.dailyBudgetMinCents) cAdd('campaign.daily_budget_cents', 'budget_too_low', 'error', { min: LIMITS.dailyBudgetMinCents })
      if (hasL && !c.stop_time && !adsets.every(a => !!a.end_time)) cAdd('campaign.stop_time', 'lifetime_needs_end')
      if (c.bid_strategy && !isIn(BID_STRATEGIES, c.bid_strategy)) cAdd('campaign.bid_strategy', 'invalid_option', 'error', { value: String(c.bid_strategy) })
      if (c.is_adset_budget_sharing_enabled === true) cAdd('campaign.is_adset_budget_sharing_enabled', 'sharing_with_cbo')
    } else {
      if ((c.daily_budget_cents ?? 0) > 0 || (c.lifetime_budget_cents ?? 0) > 0) cAdd('campaign.budget_level', 'budget_forbidden_on_campaign')
      if (c.is_adset_budget_sharing_enabled === true) {
        if (adsets.some(a => (a.lifetime_budget_cents ?? 0) > 0)) cAdd('campaign.is_adset_budget_sharing_enabled', 'sharing_daily_only')
        const strats = adsets.map(a => effectiveBidStrategy(c, a))
        if (strats.some(s => s !== strats[0])) cAdd('campaign.is_adset_budget_sharing_enabled', 'sharing_same_bid')
      }
    }
    if (c.spend_cap_cents !== undefined && c.spend_cap_cents !== null && c.spend_cap_cents > 0 && c.spend_cap_cents < LIMITS.spendCapMinCents)
      cAdd('campaign.spend_cap_cents', 'spend_cap_low', 'error', { min: LIMITS.spendCapMinCents })
    if (c.start_time && c.stop_time && Date.parse(c.start_time) >= Date.parse(c.stop_time)) cAdd('campaign.stop_time', 'time_order')
    if (!adsets.length) cAdd('campaign.name', 'no_adsets')
    // Bearbeiten-Felder sendet das Anlegen nicht: nie still verwerfen (nur serverseitig, der Browser
    // prüft im Bearbeiten-Modus bestehende Objekte als Probelauf ohne existing_id)
    if (opts.server && (c.budget_schedule_specs ?? []).length) cAdd('campaign.budget_schedule_specs', 'edit_only')
  }
  if (adsets.length > LIMITS.adsetsPerCampaign) cAdd('campaign.name', 'too_many_adsets', 'error', { max: LIMITS.adsetsPerCampaign })
  if (cbo) {
    const autoBid = (c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP') === 'LOWEST_COST_WITHOUT_CAP'
    const goals = adsets.filter(a => !a.existing_id).map(a => a.optimization_goal)
    if (autoBid && goals.some(g => g !== goals[0])) cAdd('campaign.bid_strategy', 'cbo_same_goal')
  }

  // ── Anzeigengruppen ──
  const seenAdset: string[] = []
  for (const a of adsets) {
    const node = a.key
    const add = (field: string, code: IssueCode, sev: IssueSeverity = 'error', params?: Record<string, string | number>) => push('adset', node, field, code, sev, params)
    if (!a.key || seenAdset.indexOf(a.key) >= 0) add('adset.name', 'duplicate_key', 'error', { key: String(a.key) })
    seenAdset.push(a.key)
    if (a.existing_id) continue
    if (opts.server) {
      if ((a.adset_schedule ?? []).length) add('adset.adset_schedule', 'edit_only')
      if ((a.budget_schedule_specs ?? []).length) add('adset.budget_schedule_specs', 'edit_only')
      for (const [f, v] of [
        ['adset.daily_min_spend_target_cents', a.daily_min_spend_target_cents], ['adset.daily_spend_cap_cents', a.daily_spend_cap_cents],
        ['adset.lifetime_min_spend_target_cents', a.lifetime_min_spend_target_cents], ['adset.lifetime_spend_cap_cents', a.lifetime_spend_cap_cents],
      ] as Array<[string, number | undefined]>) if ((v ?? 0) > 0) add(f, 'edit_only')
    }
    if (!(a.name ?? '').trim()) add('adset.name', 'required')
    else if (a.name.length > LIMITS.nameMax) add('adset.name', 'too_long', 'error', { max: LIMITS.nameMax })
    const okObj = isIn(OBJECTIVES, c.objective)
    const dests = okObj ? destinationsFor(c.objective) : []
    if (dests.indexOf(a.destination) < 0) { add('adset.destination', 'invalid_option', 'error', { value: String(a.destination) }); continue }
    if (DESTINATION_OPTIONS.some(o => o.value === a.destination && o.unsupported)) add('adset.destination', 'unsupported', 'error', { value: a.destination })
    const goals = goalsFor(c.objective, a.destination)
    if (goals.indexOf(a.optimization_goal) < 0) { add('adset.optimization_goal', 'invalid_option', 'error', { value: String(a.optimization_goal) }); continue }
    if (billingFor(a.optimization_goal).indexOf(a.billing_event) < 0) add('adset.billing_event', 'invalid_option', 'error', { value: String(a.billing_event) })
    const strat = effectiveBidStrategy(c, a)
    if (strat === 'COST_CAP' && a.billing_event !== 'IMPRESSIONS') add('adset.billing_event', 'cost_cap_billing')
    // promoted_object
    const po = a.promoted_object ?? {}
    const rule = promotedRuleFor(c.objective, a.destination, a.optimization_goal)
    if (rule) {
      const ok = rule.anyOf.some(alt => alt.every(k => nonEmpty(po[k])))
      if (!ok) {
        const first = rule.anyOf[0] ?? []
        const missing = first.filter(k => !nonEmpty(po[k]))
        const fk = missing.indexOf('pixel_id') >= 0 ? 'adset.promoted_object.pixel_id'
          : missing.indexOf('custom_event_type') >= 0 ? 'adset.promoted_object.custom_event_type'
          : missing.indexOf('page_id') >= 0 ? 'adset.promoted_object.page_id' : 'adset.promoted_object.pixel_id'
        add(fk, 'promoted_missing', 'error', { fields: missing.join(', ') })
      }
    }
    if (po.pixel_id && !po.custom_event_type && !po.custom_conversion_id) add('adset.promoted_object.custom_event_type', 'pixel_needs_event')
    if (po.custom_event_type && !isIn(CUSTOM_EVENT_TYPES, po.custom_event_type)) add('adset.promoted_object.custom_event_type', 'invalid_option', 'error', { value: String(po.custom_event_type) })
    if (po.pixel_id && po.pixel_id !== HP_PIXEL_ID) add('adset.promoted_object.pixel_id', 'pixel_mismatch', 'warn', { pixel: po.pixel_id, expected: HP_PIXEL_ID })
    // „Website und Instant-Formulare“: Meta erlaubt nur das Ereignis Lead
    if (a.destination === 'WEBSITE_AND_LEAD_FORM' && po.custom_event_type && po.custom_event_type !== 'LEAD') add('adset.promoted_object.custom_event_type', 'website_form_event')
    if (po.whatsapp_phone_number && !TELEFON_RE.test(normalizeTelefon(po.whatsapp_phone_number))) add('adset.promoted_object.whatsapp_phone_number', 'whatsapp_invalid')
    if (attributionFor(a.optimization_goal).indexOf(a.attribution) < 0) add('adset.attribution', 'attribution_invalid', 'error', { value: String(a.attribution) })
    // Budget
    const hasD = (a.daily_budget_cents ?? 0) > 0, hasL = (a.lifetime_budget_cents ?? 0) > 0
    if (cbo) {
      if (hasD || hasL) add('adset.daily_budget_cents', 'budget_forbidden_on_adset')
    } else {
      if (hasD && hasL) add('adset.daily_budget_cents', 'budget_both')
      else if (!hasD && !hasL) add('adset.daily_budget_cents', 'budget_missing_adset')
      if (hasL && !a.end_time) add('adset.end_time', 'lifetime_needs_end')
      if (hasD) {
        const v = a.daily_budget_cents ?? 0
        if (v < LIMITS.dailyBudgetMinCents) add('adset.daily_budget_cents', 'budget_too_low', 'error', { min: LIMITS.dailyBudgetMinCents })
        else if (v < LIMITS.dailyBudgetWarnCents) add('adset.daily_budget_cents', 'budget_low', 'warn', { min: LIMITS.dailyBudgetWarnCents })
      }
      if (a.bid_strategy && !isIn(BID_STRATEGIES, a.bid_strategy)) add('adset.bid_strategy', 'invalid_option', 'error', { value: String(a.bid_strategy) })
    }
    if (BID_NEEDS_AMOUNT.indexOf(strat) >= 0 && !((a.bid_amount_cents ?? 0) > 0)) add('adset.bid_amount_cents', 'bid_amount_required')
    if (strat === 'LOWEST_COST_WITH_MIN_ROAS') {
      if (a.optimization_goal !== 'VALUE') add('adset.optimization_goal', 'roas_needs_value')
      const f = a.roas_average_floor ?? 0
      if (f < LIMITS.roasFloorMin || f > LIMITS.roasFloorMax) add('adset.roas_average_floor', 'roas_floor_required')
    }
    if (a.start_time && a.end_time && Date.parse(a.start_time) >= Date.parse(a.end_time)) add('adset.end_time', 'time_order')
    // Zielgruppe
    validateTargeting(a.targeting, isHec(cats), add)
    // DSA
    if (targetsEu(a.targeting)) {
      if (!(a.dsa_beneficiary ?? '').trim()) add('adset.dsa_beneficiary', 'dsa_missing')
      if (!(a.dsa_payor ?? '').trim()) add('adset.dsa_payor', 'dsa_missing')
    }
    if ((a.dsa_beneficiary ?? '').length > LIMITS.dsaMax) add('adset.dsa_beneficiary', 'too_long', 'error', { max: LIMITS.dsaMax })
    if ((a.dsa_payor ?? '').length > LIMITS.dsaMax) add('adset.dsa_payor', 'too_long', 'error', { max: LIMITS.dsaMax })
    // Platzierungen
    validatePlacements(a.placements ?? { mode: 'advantage' }, add, a.optimization_goal === 'LEAD_GENERATION' || a.optimization_goal === 'QUALITY_LEAD')
    if (a.brand_safety && !isIn(BRAND_SAFETY_LEVELS, a.brand_safety)) add('adset.brand_safety', 'invalid_option', 'error', { value: String(a.brand_safety) })
    for (const x of a.excluded_publisher_categories ?? []) if (!isIn(PUBLISHER_CATEGORIES, x)) add('adset.excluded_publisher_categories', 'invalid_option', 'error', { value: String(x) })
  }

  // ── Anzeigen ──
  const seenAd: string[] = []
  const perAdset: Record<string, number> = {}
  for (const ad of ads) {
    const node = ad.key
    const add = (field: string, code: IssueCode, sev: IssueSeverity = 'error', params?: Record<string, string | number>) => push('ad', node, field, code, sev, params)
    if (!ad.key || seenAd.indexOf(ad.key) >= 0) add('ad.name', 'duplicate_key', 'error', { key: String(ad.key) })
    seenAd.push(ad.key)
    const a = adsetByKey(d, ad.adset_key)
    if (!a) add('ad.name', 'adset_ref_missing', 'error', { key: String(ad.adset_key) })
    perAdset[ad.adset_key] = (perAdset[ad.adset_key] ?? 0) + 1
    if (ad.existing_id) continue
    if (!(ad.name ?? '').trim()) add('ad.name', 'required')
    else if (ad.name.length > LIMITS.nameMax) add('ad.name', 'too_long', 'error', { max: LIMITS.nameMax })
    const beitrag = ad.beitrag
    const fbBeitrag = !!beitrag && beitrag.quelle === 'facebook'
    if (AD_FORMATS.indexOf(ad.format) < 0) add('ad.format', 'invalid_option', 'error', { value: String(ad.format) })
    else if (!beitrag && AD_FORMAT_OPTIONS.some(o => o.value === ad.format && o.unsupported)) add('ad.format', 'unsupported', 'error', { value: ad.format })
    const partner = ad.partnerschaft
    const partnerAbsender = !!partner && partner.partner_ist_absender === true
    if (!(ad.identity?.page_id ?? '').trim()) add('ad.identity.page_id', 'identity_page')
    // Partner als Hauptidentität: das Instagram-Konto kommt von der Seite des Partners
    if (!partnerAbsender && !(ad.identity?.instagram_user_id ?? '').trim()) add('ad.identity.instagram_user_id', 'identity_ig')

    // CTA + Ziel (Zielort je Conversion-Ort der Anzeigengruppe)
    const kind = ad.destination?.kind
    const kindOk = isIn(AD_DESTINATION_KINDS, kind)
    if (!kindOk) add('ad.destination.kind', 'required')
    if (a && kindOk) {
      const kinds = adKindsFor(a.destination)
      if (!kinds.length) add('ad.destination.kind', 'destination_unsupported', 'error', { value: a.destination })
      else if (kinds.indexOf(kind) < 0) add('ad.destination.kind', 'destination_mismatch', 'error', { adset: a.destination })
    }
    // Facebook-Beitrag: Link und Button kommen aus dem Beitrag
    if (kindOk && !fbBeitrag) {
      if (!isIn(CTA_TYPES, ad.cta_type)) add('ad.cta_type', 'cta_invalid', 'error', { value: String(ad.cta_type) })
      else if (ctaFor(kind).indexOf(ad.cta_type) < 0) add('ad.cta_type', kind === 'lead_form' ? 'cta_lead_form' : 'cta_invalid', 'error', { value: ad.cta_type })
      const dst = ad.destination
      if (dst.kind === 'website' || dst.kind === 'website_lead_form') {
        const url = (dst.url ?? '').trim()
        if (!URL_RE.test(url) || url.length > LIMITS.urlMax) add('ad.destination.url', 'url_invalid')
        else if (/[?&]utm_/i.test(url)) add('ad.destination.url', 'url_has_utm', 'warn')
      }
      if ((dst.kind === 'lead_form' || dst.kind === 'website_lead_form') && !(dst.form_id ?? '').trim()) add('ad.destination.form_id', 'form_missing')
      if (dst.kind === 'phone_call' && !TELEFON_RE.test(normalizeTelefon(dst.telefon))) add('ad.destination.telefon', 'phone_invalid')
      if (dst.kind === 'whatsapp') {
        const texte: Array<[string, string | undefined]> = [['ad.destination.whatsapp_begruessung', dst.begruessung], ['ad.destination.whatsapp_nachricht', dst.nachricht]]
        for (const [f, v] of texte) {
          if ((v ?? '').length > LIMITS.whatsappTextMax) add(f, 'too_long', 'error', { max: LIMITS.whatsappTextMax })
          if (DASH_RE.test(v ?? '')) add(f, 'dash_char')
        }
      }
    }

    // Partnerschaftswerbung
    if (partner) {
      const pp = (partner.partner_page_id ?? '').trim(), pi = (partner.partner_ig_user_id ?? '').trim()
      if (!pp && !pi) add('ad.partnerschaft', 'partner_missing')
      else if ((pp && !META_ID_RE.test(pp)) || (pi && !META_ID_RE.test(pi))) add('ad.partnerschaft', 'invalid_option', 'error', { value: pp || pi })
      if (partnerAbsender && !pp) add('ad.partnerschaft', 'partner_page_required')
      if (isFormKind(kind)) add('ad.partnerschaft', 'partner_lead_form', 'warn')
    }
    // Tracking (weitere Pixel, Lead-Qualität, Conversion-Domain)
    const tr = ad.tracking
    if (tr) {
      const px = Array.isArray(tr.weitere_pixel) ? tr.weitere_pixel : []
      if (px.length > LIMITS.trackingPixelMax || px.some(x => !META_ID_RE.test(String(x ?? '').trim()))) add('ad.tracking.pixel', 'tracking_invalid', 'error', { max: LIMITS.trackingPixelMax })
      if (tr.lead_qualitaet && !isFormKind(kind)) add('ad.tracking.lead_qualitaet', 'tracking_invalid', 'warn', { max: LIMITS.trackingPixelMax })
      const dom = (tr.conversion_domain ?? '').trim().toLowerCase()
      if (dom && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom)) add('ad.tracking.conversion_domain', 'domain_invalid')
      else if (dom && dom.split('.').length > 2) add('ad.tracking.conversion_domain', 'domain_invalid', 'warn')
    }
    for (const t of ad.tracking_specs ?? []) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) { add('ad.tracking_specs', 'tracking_invalid', 'error', { max: LIMITS.trackingPixelMax }); break }
    }
    // Conversion-Domain: Pflicht, wenn die Anzeige Daten mit einem Pixel teilt (Meta-Doku). Ohne Website-URL
    // (Facebook-Beitrag, WhatsApp, Anruf, Messenger, Sofortformular) muss sie im Formular stehen.
    const pixelGeteilt = !!(a?.promoted_object?.pixel_id ?? '').trim() || (Array.isArray(tr?.weitere_pixel) && (tr?.weitere_pixel ?? []).length > 0)
    if (kindOk && pixelGeteilt && (fbBeitrag || !isWebsiteKind(kind)) && !adConversionDomain(ad)) add('ad.tracking.conversion_domain', 'required')
    const featuresPruefen = () => {
      for (const k of Object.keys(ad.creative_features ?? {})) {
        if (!isIn(CREATIVE_FEATURES, k)) add('ad.creative_features', 'feature_unknown', 'warn', { value: k })
        else { const v = (ad.creative_features ?? {})[k]; if (v !== 'OPT_IN' && v !== 'OPT_OUT') add('ad.creative_features', 'invalid_option', 'error', { value: String(v) }) }
      }
      if (ad.multi_advertiser !== 'OPT_IN' && ad.multi_advertiser !== 'OPT_OUT') add('ad.multi_advertiser', 'invalid_option', 'error', { value: String(ad.multi_advertiser) })
    }

    // Vorhandener Beitrag: Texte und Medien kommen aus dem Beitrag
    if (beitrag) {
      const id = String(beitrag.id ?? '').trim()
      const okId = beitrag.quelle === 'facebook' ? /^[0-9]{6,25}_[0-9]{6,25}$/.test(id) : beitrag.quelle === 'instagram' ? META_ID_RE.test(id) : false
      if (!okId) add('ad.beitrag', 'beitrag_invalid', 'error', { value: id })
      else if (fbBeitrag && !partnerAbsender && (ad.identity?.page_id ?? '').trim() && id.split('_')[0] !== ad.identity.page_id.trim()) {
        add('ad.beitrag', 'beitrag_invalid', 'warn', { value: id })
      }
      if (kindOk && !(fbBeitrag ? kind === 'website' : (kind === 'website' || kind === 'whatsapp'))) add('ad.beitrag', 'beitrag_ziel', 'error', { value: String(kind) })
      if (hatSprachen(ad)) add('ad.sprachen', 'lang_format')
      featuresPruefen()
      continue
    }

    // Texte (bis 5 Varianten je Art; ohne Medien je Platzierung als Textvarianten, mit: Beschreibung nur eine)
    const lists: Array<[string, string[] | undefined, number, boolean]> = [
      ['ad.primary_texts', ad.primary_texts, LIMITS.primaryTextMax, true],
      ['ad.headlines', ad.headlines, LIMITS.headlineApiMax, true],
      ['ad.descriptions', ad.descriptions, LIMITS.descriptionApiMax, false],
    ]
    let multi = false
    for (const [field, list, max, req] of lists) {
      const arr = Array.isArray(list) ? list : []
      if (req && !arr.some(s => (s ?? '').trim())) add(field, 'text_missing')
      if (arr.some(s => !(s ?? '').trim()) && arr.length > 1) add(field, 'text_missing', 'warn')
      if (arr.length > LIMITS.textsPerKind) add(field, 'too_many_texts', 'error', { max: LIMITS.textsPerKind })
      arr.forEach((s, i) => { if ((s ?? '').length > max) add(field, 'too_long', 'error', { max, index: i + 1 }) })
      if (field !== 'ad.descriptions' && cleanTexts(arr).length > 1) multi = true
    }
    if (ad.format === 'carousel' && multi) add('ad.primary_texts', 'carousel_multi_text')
    // Medien je Platzierung (Meta-PAC-Guide): genau eine Beschreibung; Textvarianten ohne Platzierungs-Medien: bis 5
    else if (ad.format !== 'carousel' && !hatSprachen(ad) && cleanTexts(ad.descriptions).length > 1 && usesPlacementFeed(ad, a?.placements)) add('ad.descriptions', 'descriptions_single')

    // Medien
    const m = ad.media ?? {}
    const cropCheck = (r: MediaRef | undefined, field: string, index?: number) => {
      if (!r || !r.crops || typeof r.crops !== 'object') return
      for (const k of Object.keys(r.crops)) {
        if (!cropValid(k, (r.crops as Record<string, unknown>)[k])) { add(field, 'crop_invalid', 'error', { value: k, ...(index ? { index } : {}) }); break }
      }
    }
    const thumbCheck = (r: MediaRef | undefined, field: string) => {
      if (r && r.thumbnail_media_id && !UUID_RE.test(r.thumbnail_media_id)) add(field, 'thumb_invalid')
    }
    if (ad.format === 'carousel') {
      const cards = m.cards ?? []
      if (cards.length < LIMITS.carouselMin || cards.length > LIMITS.carouselMax) add('ad.media.cards', 'cards_count', 'error', { min: LIMITS.carouselMin, max: LIMITS.carouselMax })
      const aspects: string[] = []
      cards.forEach((cd, i) => {
        if (!cd?.media?.media_id) add('ad.media.cards', 'media_missing', 'error', { index: i + 1 })
        if (!(cd?.headline ?? '').trim()) add('ad.media.cards', 'text_missing', 'error', { index: i + 1 })
        if (cd?.url && !URL_RE.test(cd.url)) add('ad.media.cards', 'url_invalid', 'error', { index: i + 1 })
        if ((cd?.headline ?? '').length > LIMITS.headlineApiMax) add('ad.media.cards', 'too_long', 'error', { max: LIMITS.headlineApiMax, index: i + 1 })
        if ((cd?.description ?? '').length > LIMITS.descriptionApiMax) add('ad.media.cards', 'too_long', 'error', { max: LIMITS.descriptionApiMax, index: i + 1 })
        if (cd?.media?.video_id && !cd.media.thumbnail_hash && !cd.media.thumbnail_media_id) add('ad.media.cards', 'card_thumb_missing', opts.server ? 'error' : 'warn', { index: i + 1 })
        if (cd?.media?.aspect) aspects.push(cd.media.aspect)
        cropCheck(cd?.media, 'ad.media.crops', i + 1)
        thumbCheck(cd?.media, 'ad.media.cards')
      })
      // Karussell: alle Karten im gleichen Format, 1:1 oder 4:5
      if (aspects.some(x => x !== '1:1' && x !== '4:5') || aspects.some(x => x !== aspects[0])) add('ad.media.cards', 'cards_ratio', 'warn')
    } else if (ad.format !== 'collection') {
      const slots = [m.feed_4x5, m.story_9x16, m.square_1x1, m.landscape_191x1].filter((x): x is MediaRef => !!x && !!x.media_id)
      if (!slots.length) add('ad.media.feed_4x5', 'media_missing')
      if (ad.format === 'single_video') {
        for (const s of slots) if (s.video_id && !s.thumbnail_hash && !s.thumbnail_media_id) { add('ad.media.feed_4x5', 'video_thumb_missing', opts.server ? 'error' : 'warn'); break }
      }
      for (const s of slots) { cropCheck(s, 'ad.media.crops'); thumbCheck(s, 'ad.media.thumbnail') }
    }

    // Mehrere Sprachen
    if (hatSprachen(ad)) {
      const sp = ad.sprachen as SprachenSpec
      if (!isWebsiteKind(kind)) add('ad.sprachen', 'lang_destination')
      if (ad.format !== 'single_image' && ad.format !== 'single_video') add('ad.sprachen', 'lang_format')
      if (multi || cleanTexts(ad.descriptions).length > 1) add('ad.sprachen', 'lang_multi_text')
      const seen: string[] = []
      for (const v of Array.isArray(sp.varianten) ? sp.varianten : []) {
        if (!v || !isIn(AD_SPRACHEN, v.sprache) || v.sprache === 'de' || seen.indexOf(v.sprache) >= 0) {
          add('ad.sprachen', 'lang_invalid', 'error', { value: String(v?.sprache) })
          continue
        }
        seen.push(v.sprache)
        if (!(v.primary_text ?? '').trim() || !(v.headline ?? '').trim()) add('ad.sprachen', 'text_missing', 'error', { value: v.sprache })
        if ((v.primary_text ?? '').length > LIMITS.primaryTextMax) add('ad.sprachen', 'too_long', 'error', { max: LIMITS.primaryTextMax })
        if ((v.headline ?? '').length > LIMITS.headlineApiMax || (v.description ?? '').length > LIMITS.descriptionApiMax) add('ad.sprachen', 'too_long', 'error', { max: LIMITS.headlineApiMax })
        if ((v.url ?? '').trim() && !URL_RE.test((v.url ?? '').trim())) add('ad.sprachen', 'url_invalid')
        if (DASH_RE.test(`${v.primary_text ?? ''} ${v.headline ?? ''} ${v.description ?? ''}`)) add('ad.sprachen', 'dash_char')
      }
      for (const s of Array.isArray(sp.automatisch_uebersetzen) ? sp.automatisch_uebersetzen : []) {
        if (s !== 'en') add('ad.sprachen', 'lang_invalid', 'error', { value: String(s) })
        else if (seen.indexOf('en') >= 0) add('ad.sprachen', 'lang_auto_conflict')
      }
      if (Object.keys(pacSlots(ad)).length >= 2) add('ad.sprachen', 'lang_no_pac', 'warn')
    }
    featuresPruefen()
  }
  for (const k of Object.keys(perAdset)) {
    if (perAdset[k] > LIMITS.adsPerAdset) push('adset', k, 'adset.name', 'too_many_ads', 'error', { max: LIMITS.adsPerAdset })
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 6b. applyHousing - Sonderkategorie Wohnen (und Beschäftigung/Finanzen) erzwingen
// ═══════════════════════════════════════════════════════════════════════════

export const HOUSING_CHANGE_CODES = [
  'category_added', 'country_default', 'age_set', 'age_range_removed', 'genders_removed',
  'geo_type_removed', 'radius_raised', 'excluded_geo_removed', 'detailed_removed',
  'exclusions_removed', 'lookalike_removed', 'advantage_audience_set', 'individual_setting_removed',
] as const
export type HousingChangeCode = typeof HOUSING_CHANGE_CODES[number]
export interface HousingChange { node: string; field: string; code: HousingChangeCode; messageKey: string; before?: unknown }
export interface HousingLock { node: string; field: string; noteKey: string; lock?: unknown; hide?: true; min?: number }
export interface HousingResult { spec: DraftSpec; locks: HousingLock[]; changes: HousingChange[] }
export const housingChangeKey = (code: HousingChangeCode): string => `${K}.housing_change.${code}`

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/**
 * Erzwingt Metas Regeln für Wohnen/Beschäftigung/Finanzen auf dem Entwurf
 * (Alter 18-65+, alle Geschlechter, keine PLZ/Unterstadt-Orte, keine Ortsausschlüsse,
 * Radius >= 15 km, bei Städten >= 17 km, kein Verhaltens-/Demografie-Targeting, keine Lookalikes,
 * advantage_audience explizit 0/1). Idempotent. Neue Kampagnen bekommen HOUSING
 * (HP: jede Immobilienkampagne), bestehende behalten ihre Kategorien.
 */
export function applyHousing(d: DraftSpec, opts: { forceCategory?: boolean } = {}): HousingResult {
  const spec = clone(d)
  const changes: HousingChange[] = []
  const locks: HousingLock[] = []
  const ch = (node: string, field: string, code: HousingChangeCode, before?: unknown) =>
    changes.push({ node, field, code, messageKey: housingChangeKey(code), ...(before !== undefined ? { before } : {}) })
  const c = spec.campaign
  if (!c) return { spec, locks, changes }
  if (!Array.isArray(c.special_ad_categories)) c.special_ad_categories = []
  if (!Array.isArray(c.special_ad_category_country)) c.special_ad_category_country = []
  const force = opts.forceCategory ?? !c.existing_id
  if (force && c.special_ad_categories.indexOf('HOUSING') < 0) {
    const before = c.special_ad_categories.slice()
    c.special_ad_categories = [...c.special_ad_categories.filter(x => x !== 'NONE'), 'HOUSING']
    ch('campaign', 'campaign.special_ad_categories', 'category_added', before)
  }
  if (!isHec(c.special_ad_categories)) return { spec, locks, changes }
  if (!c.special_ad_category_country.length) {
    c.special_ad_category_country = ['DE']
    ch('campaign', 'campaign.special_ad_category_country', 'country_default')
  }
  locks.push({ node: 'campaign', field: 'campaign.special_ad_categories', noteKey: HOUSING_NOTE.category, lock: ['HOUSING'] })

  for (const a of spec.adsets ?? []) {
    const node = a.key
    locks.push(
      { node, field: 'adset.targeting.age', noteKey: HOUSING_NOTE.age, lock: [HOUSING_AGE_MIN, HOUSING_AGE_MAX] },
      { node, field: 'adset.targeting.genders', noteKey: HOUSING_NOTE.genders, hide: true },
      { node, field: 'adset.targeting.excluded_geo_locations', noteKey: HOUSING_NOTE.exclusion, hide: true },
      { node, field: 'adset.targeting.geo_locations', noteKey: HOUSING_NOTE.radius, min: HOUSING_MIN_RADIUS_KM },
      { node, field: 'adset.targeting.detailed', noteKey: HOUSING_NOTE.detailed },
      { node, field: 'adset.targeting.custom_audiences', noteKey: HOUSING_NOTE.lookalike },
      { node, field: 'adset.targeting.advantage_audience', noteKey: HOUSING_NOTE.advantage_audience },
    )
    if (a.existing_id) continue
    if (!a.targeting || typeof a.targeting !== 'object') a.targeting = { geo_locations: {} }
    const t = a.targeting
    if (!t.geo_locations || typeof t.geo_locations !== 'object') t.geo_locations = {}
    const g = t.geo_locations
    if (t.age_min !== HOUSING_AGE_MIN || t.age_max !== HOUSING_AGE_MAX) {
      const before = [t.age_min, t.age_max]
      t.age_min = HOUSING_AGE_MIN
      t.age_max = HOUSING_AGE_MAX
      ch(node, 'adset.targeting.age', 'age_set', before)
    }
    if (t.age_range !== undefined) { const before = t.age_range; delete t.age_range; ch(node, 'adset.targeting.age', 'age_range_removed', before) }
    if (t.genders !== undefined) { const before = t.genders; delete t.genders; ch(node, 'adset.targeting.genders', 'genders_removed', before) }
    for (const k of HOUSING_FORBIDDEN_GEO_KEYS) {
      if (g[k] !== undefined) { const before = g[k]; delete g[k]; ch(node, 'adset.targeting.geo_locations', 'geo_type_removed', before) }
    }
    const raise = (it: { radius?: number; distance_unit?: 'kilometer' | 'mile' }, setIfMissing: boolean, minKm: number) => {
      const km = radiusKm(it.radius, it.distance_unit)
      if ((km !== null && km < minKm - 0.01) || (km === null && setIfMissing)) {
        const before = { radius: it.radius, distance_unit: it.distance_unit }
        it.radius = minKm
        it.distance_unit = 'kilometer'
        ch(node, 'adset.targeting.geo_locations', 'radius_raised', before)
      }
    }
    // Städte: Metas Stadt-Minimum 17 km liegt über dem Wohnen-Minimum 15 km
    for (const it of g.cities ?? []) raise(it, false, Math.max(CITY_MIN_RADIUS_KM, HOUSING_MIN_RADIUS_KM))
    for (const it of g.places ?? []) raise(it, false, HOUSING_MIN_RADIUS_KM)
    for (const it of g.custom_locations ?? []) raise(it, true, HOUSING_MIN_RADIUS_KM)
    if (t.excluded_geo_locations !== undefined) {
      const before = t.excluded_geo_locations
      delete t.excluded_geo_locations
      ch(node, 'adset.targeting.excluded_geo_locations', 'excluded_geo_removed', before)
    }
    if (t.exclusions !== undefined) { const before = t.exclusions; delete t.exclusions; ch(node, 'adset.targeting.detailed', 'exclusions_removed', before) }
    const forbidden = HOUSING_FORBIDDEN_DETAILED_KEYS as readonly string[]
    for (const k of forbidden) {
      if (t[k] !== undefined) { const before = t[k]; delete t[k]; ch(node, 'adset.targeting.detailed', 'detailed_removed', before) }
    }
    if (Array.isArray(t.flexible_spec)) {
      const cleaned: Array<Record<string, TargetingEntity[]>> = []
      let removed = false
      for (const grp of t.flexible_spec) {
        const ng: Record<string, TargetingEntity[]> = {}
        for (const k of Object.keys(grp ?? {})) {
          if (forbidden.indexOf(k) >= 0) { removed = true; continue }
          ng[k] = grp[k]
        }
        if (Object.keys(ng).some(k => nonEmpty(ng[k]))) cleaned.push(ng)
        else if (Object.keys(grp ?? {}).length) removed = true
      }
      if (removed) { const before = t.flexible_spec; ch(node, 'adset.targeting.detailed', 'detailed_removed', before) }
      if (cleaned.length) t.flexible_spec = cleaned
      else delete t.flexible_spec
    }
    for (const key of ['custom_audiences', 'excluded_custom_audiences'] as const) {
      const list = t[key]
      if (Array.isArray(list) && list.some(isLookalike)) {
        const kept = list.filter(x => !isLookalike(x))
        ch(node, 'adset.targeting.custom_audiences', 'lookalike_removed', list.filter(isLookalike))
        if (kept.length) t[key] = kept
        else delete t[key]
      }
    }
    if (t.targeting_relaxation_types && t.targeting_relaxation_types.lookalike !== undefined) {
      const before = t.targeting_relaxation_types.lookalike
      delete t.targeting_relaxation_types.lookalike
      if (!Object.keys(t.targeting_relaxation_types).length) delete t.targeting_relaxation_types
      ch(node, 'adset.targeting.custom_audiences', 'lookalike_removed', before)
    }
    if (!t.targeting_automation || typeof t.targeting_automation !== 'object') t.targeting_automation = {}
    const ta = t.targeting_automation
    if (ta.individual_setting !== undefined) {
      const before = ta.individual_setting
      delete ta.individual_setting
      ch(node, 'adset.targeting.advantage_audience', 'individual_setting_removed', before)
    }
    if (ta.advantage_audience !== 0 && ta.advantage_audience !== 1) {
      // fehlt = 1 (HP-Standard wie Plan B); false/'0' aus Altdaten = 0
      const before: unknown = ta.advantage_audience
      ta.advantage_audience = effectiveAdvantageAudience(before)
      ch(node, 'adset.targeting.advantage_audience', 'advantage_audience_set', before)
    }
  }
  return { spec, locks, changes }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6c. Payload-Bau (immer PAUSED)
// ═══════════════════════════════════════════════════════════════════════════

export type GraphParams = Record<string, unknown>

/** Gedankenstriche (U+2012-U+2015) raus, Länge begrenzen. */
export function cleanName(s: string | undefined, max: number = LIMITS.nameMax): string {
  return (s ?? '').replace(/[\u2012-\u2015]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function buildCampaignPayload(c: CampaignDraft): GraphParams {
  const cats = (c.special_ad_categories ?? []).filter(x => x !== 'NONE')
  const p: GraphParams = {
    name: cleanName(c.name),
    objective: c.objective,
    buying_type: 'AUCTION',
    status: 'PAUSED',
    special_ad_categories: cats,
  }
  if (cats.length) p.special_ad_category_country = (c.special_ad_category_country ?? []).length ? c.special_ad_category_country : ['DE']
  if (c.budget_level === 'campaign') {
    if ((c.daily_budget_cents ?? 0) > 0) p.daily_budget = Math.round(c.daily_budget_cents ?? 0)
    else if ((c.lifetime_budget_cents ?? 0) > 0) p.lifetime_budget = Math.round(c.lifetime_budget_cents ?? 0)
    p.bid_strategy = c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'
  } else {
    // ab v24 Pflicht, wenn kein Kampagnenbudget
    p.is_adset_budget_sharing_enabled = c.is_adset_budget_sharing_enabled === true
  }
  if ((c.spend_cap_cents ?? 0) > 0) p.spend_cap = Math.round(c.spend_cap_cents ?? 0)
  if (c.start_time) p.start_time = c.start_time
  if (c.stop_time) p.stop_time = c.stop_time
  return p
}

function buildPromotedObject(c: CampaignDraft, a: AdsetDraft): PromotedObject | null {
  const rule = promotedRuleFor(c.objective, a.destination, a.optimization_goal)
  if (!rule) return null
  const allowed = promotedAllowed(rule)
  const src = a.promoted_object ?? {}
  const out: PromotedObject = {}
  for (const k of allowed) {
    const v = src[k]
    // WhatsApp-Nummer so senden, wie validateDraft sie prüft (E.164, ohne Leerzeichen)
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = k === 'whatsapp_phone_number' ? normalizeTelefon(String(v)) : v
  }
  return Object.keys(out).length ? out : null
}

const PLACEMENT_TARGETING_KEYS = [
  'publisher_platforms', 'facebook_positions', 'instagram_positions', 'threads_positions',
  'messenger_positions', 'audience_network_positions', 'device_platforms', 'whatsapp_positions',
] as const

/** targeting fürs Ad Set: Zielgruppe + Platzierungen + Inventarfilter, advantage_audience immer explizit. */
export function buildTargeting(a: AdsetDraft, c: CampaignDraft): GraphParams {
  const t = clone(a.targeting ?? { geo_locations: {} }) as GraphParams
  for (const k of PLACEMENT_TARGETING_KEYS) delete t[k]
  delete t.brand_safety_content_filter_levels
  delete t.excluded_publisher_categories
  const p = a.placements
  let platforms: readonly string[] = PUBLISHER_PLATFORMS
  if (p && p.mode === 'manual') {
    platforms = p.publisher_platforms ?? []
    t.publisher_platforms = platforms.slice()
    for (const pl of PUBLISHER_PLATFORMS) {
      const field = POSITION_FIELD_BY_PLATFORM[pl]
      const list = ((p[field] ?? []) as readonly string[]).filter(x => REMOVED_POSITIONS[field].indexOf(x) < 0)
      if (list.length && platforms.indexOf(pl) >= 0) t[field] = list.slice()
    }
    if ((p.device_platforms ?? []).length) t.device_platforms = (p.device_platforms ?? []).slice()
  }
  if (a.brand_safety) {
    const lv: string[] = []
    if (platforms.indexOf('facebook') >= 0 || platforms.indexOf('instagram') >= 0) lv.push(`FACEBOOK_${a.brand_safety}`)
    if (platforms.indexOf('audience_network') >= 0) lv.push(`AN_${a.brand_safety}`)
    if (lv.length) t.brand_safety_content_filter_levels = lv
  }
  if ((a.excluded_publisher_categories ?? []).length) t.excluded_publisher_categories = (a.excluded_publisher_categories ?? []).slice()
  const ta = (t.targeting_automation && typeof t.targeting_automation === 'object' ? t.targeting_automation : {}) as Record<string, unknown>
  ta.advantage_audience = effectiveAdvantageAudience(ta.advantage_audience)
  if (isHec(c.special_ad_categories)) delete ta.individual_setting
  t.targeting_automation = ta
  return t
}

export function buildAdsetPayload(a: AdsetDraft, c: CampaignDraft, campaignId: string): GraphParams {
  const p: GraphParams = {
    name: cleanName(a.name),
    campaign_id: campaignId,
    status: 'PAUSED',
    optimization_goal: a.optimization_goal,
    billing_event: a.billing_event,
  }
  if (a.destination && a.destination !== 'UNDEFINED') p.destination_type = a.destination
  const po = buildPromotedObject(c, a)
  if (po) p.promoted_object = po
  // Attribution nur senden, wo Meta eine Wahl erlaubt (sonst fest 1 Tag Klick)
  if (attributionFor(a.optimization_goal).length > 1) p.attribution_spec = (ATTRIBUTION_SPECS[a.attribution] ?? ATTRIBUTION_SPECS.click_7d_view_1d).map(w => ({ ...w }))
  const strat = effectiveBidStrategy(c, a)
  if (c.budget_level !== 'campaign') {
    if ((a.daily_budget_cents ?? 0) > 0) p.daily_budget = Math.round(a.daily_budget_cents ?? 0)
    else if ((a.lifetime_budget_cents ?? 0) > 0) p.lifetime_budget = Math.round(a.lifetime_budget_cents ?? 0)
    p.bid_strategy = strat
  }
  if (BID_NEEDS_AMOUNT.indexOf(strat) >= 0 && (a.bid_amount_cents ?? 0) > 0) p.bid_amount = Math.round(a.bid_amount_cents ?? 0)
  if (strat === 'LOWEST_COST_WITH_MIN_ROAS' && (a.roas_average_floor ?? 0) > 0) p.bid_constraints = { roas_average_floor: Math.round(a.roas_average_floor ?? 0) }
  if (a.start_time) p.start_time = a.start_time
  if (a.end_time) p.end_time = a.end_time
  p.targeting = buildTargeting(a, c)
  if ((a.dsa_beneficiary ?? '').trim()) p.dsa_beneficiary = a.dsa_beneficiary.trim()
  if ((a.dsa_payor ?? '').trim()) p.dsa_payor = a.dsa_payor.trim()
  return p
}

// ── Creative ────────────────────────────────────────────────────────────────

/**
 * link_data / video_data = ein Medium, je ein Text; carousel = Karussell; asset_feed = Medien je
 * Platzierung (optimization_type PLACEMENT); asset_feed_text = Textvarianten ohne Platzierungs-Medien;
 * asset_feed_language = mehrere Sprachen (optimization_type LANGUAGE); beitrag = vorhandener Beitrag.
 */
export type CreativeMode = 'link_data' | 'video_data' | 'carousel' | 'asset_feed' | 'asset_feed_text' | 'asset_feed_language' | 'beitrag'
export const CREATIVE_MODE_OPTIONS: readonly EnumOption<CreativeMode>[] = [
  opt('creative_mode', 'link_data'), opt('creative_mode', 'video_data'),
  opt('creative_mode', 'carousel'), opt('creative_mode', 'asset_feed'),
  opt('creative_mode', 'asset_feed_text'), opt('creative_mode', 'asset_feed_language'), opt('creative_mode', 'beitrag'),
]
/** Asset-Feed-Creative? (Beim Ersetzen erlaubt Meta keinen Wechsel des Feed-Typs.) */
export function isAssetFeedMode(m: CreativeMode): boolean {
  return m === 'asset_feed' || m === 'asset_feed_text' || m === 'asset_feed_language'
}
export const PAC_LABEL_FEED = 'hp_feed_4x5'
export const PAC_LABEL_STORY = 'hp_story_9x16'
export const PAC_LABEL_QUER = 'hp_quer_191x1'
export const PAC_LABEL_QUADRAT = 'hp_quadrat_1x1'
/** Medien-Platz einer Platzierungsregel: feed 4:5, story 9:16, quer 1.91:1 (16:9), quadrat 1:1 */
export type PacSlot = 'feed' | 'story' | 'quer' | 'quadrat'
export interface PlacementRule {
  slot: PacSlot
  label: string
  customization_spec: { publisher_platforms: PublisherPlatform[]; facebook_positions?: string[]; instagram_positions?: string[] }
}
/**
 * Medien je Platzierung (asset_feed_spec optimization_type PLACEMENT): 9:16 für
 * Stories + Reels, 4:5 für Feeds. Optional quer (1.91:1: rechte Spalte und Suche, bei Video
 * In-Stream und Suche) und quadrat (1:1: Marketplace, ohne Quer-Medium auch rechte Spalte und
 * Suche). Bei manuellen Platzierungen auf die gewählten Positionen geschnitten. Reels, quer und
 * quadrat in customization_spec: per validate_only bestätigen.
 */
export function placementRulesFor(placements: Placements | undefined, isVideo: boolean, extra: { quer?: boolean; quadrat?: boolean } = {}): PlacementRule[] {
  const querPos = isVideo ? ['instream_video', 'search'] : ['right_hand_column', 'search']
  const base: PlacementRule[] = [
    {
      slot: 'story', label: PAC_LABEL_STORY,
      customization_spec: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['story', 'facebook_reels'], instagram_positions: ['story', 'reels'] },
    },
    {
      slot: 'feed', label: PAC_LABEL_FEED,
      customization_spec: {
        publisher_platforms: ['facebook', 'instagram'], facebook_positions: extra.quadrat ? ['feed'] : ['feed', 'marketplace'],
        instagram_positions: isVideo ? ['stream', 'profile_feed'] : ['stream', 'profile_feed', 'explore_home'],
      },
    },
  ]
  if (extra.quer) base.push({ slot: 'quer', label: PAC_LABEL_QUER, customization_spec: { publisher_platforms: ['facebook'], facebook_positions: querPos.slice() } })
  if (extra.quadrat) {
    const pos = ['marketplace', ...(extra.quer ? [] : (isVideo ? ['search'] : ['right_hand_column', 'search']))]
    base.push({ slot: 'quadrat', label: PAC_LABEL_QUADRAT, customization_spec: { publisher_platforms: ['facebook'], facebook_positions: pos } })
  }
  if (!placements || placements.mode !== 'manual') return base
  const out: PlacementRule[] = []
  for (const r of base) {
    const spec: PlacementRule['customization_spec'] = { publisher_platforms: [] }
    for (const pl of r.customization_spec.publisher_platforms) {
      if (placements.publisher_platforms.indexOf(pl) < 0) continue
      const field = pl === 'facebook' ? 'facebook_positions' : 'instagram_positions'
      const wanted = (r.customization_spec[field] ?? []) as string[]
      const chosen = (placements[field] ?? []) as readonly string[]
      const pos = chosen.length ? wanted.filter(x => chosen.indexOf(x) >= 0) : wanted
      if (!pos.length) continue
      spec.publisher_platforms.push(pl)
      spec[field] = pos
    }
    if (spec.publisher_platforms.length) out.push({ ...r, customization_spec: spec })
  }
  return out
}

const feedRef = (ad: AdDraft): MediaRef | undefined => ad.media?.feed_4x5 ?? ad.media?.square_1x1
const storyRef = (ad: AdDraft): MediaRef | undefined => ad.media?.story_9x16
const okRef = (r: MediaRef | undefined): r is MediaRef => !!r && !!r.media_id
/** Gleiches Medium mit gleichem Zuschnitt = ein Platz (verschiedene Zuschnitte eines Fotos = verschiedene Plätze). */
const slotKey = (r: MediaRef): string => `${r.media_id}|${editCanon(r.crops ?? null)}`

/** Verschiedene Medien-Plätze der Anzeige (gleiches Medium + gleicher Zuschnitt zählt einmal). */
export function pacSlots(ad: AdDraft): Partial<Record<PacSlot, MediaRef>> {
  const m = ad.media ?? {}
  const out: Partial<Record<PacSlot, MediaRef>> = {}
  const feed = okRef(m.feed_4x5) ? m.feed_4x5 : okRef(m.square_1x1) ? m.square_1x1 : undefined
  const taken: string[] = []
  if (feed) { out.feed = feed; taken.push(slotKey(feed)) }
  if (okRef(m.story_9x16) && taken.indexOf(slotKey(m.story_9x16)) < 0) { out.story = m.story_9x16; taken.push(slotKey(m.story_9x16)) }
  if (okRef(m.landscape_191x1) && taken.indexOf(slotKey(m.landscape_191x1)) < 0) { out.quer = m.landscape_191x1; taken.push(slotKey(m.landscape_191x1)) }
  if (okRef(m.feed_4x5) && okRef(m.square_1x1) && taken.indexOf(slotKey(m.square_1x1)) < 0) out.quadrat = m.square_1x1
  return out
}

/** Hat die Anzeige weitere Sprachen (Varianten oder automatische Übersetzung)? */
export function hatSprachen(ad: AdDraft): boolean {
  const sp = ad.sprachen
  return !!sp && ((Array.isArray(sp.varianten) && sp.varianten.length > 0) || (Array.isArray(sp.automatisch_uebersetzen) && sp.automatisch_uebersetzen.length > 0))
}

/** Medien je Platzierung (PAC): mindestens zwei verschiedene Medien-Plätze und zwei Platzierungsregeln. */
export function usesPlacementFeed(ad: AdDraft, placements?: Placements): boolean {
  if (ad.beitrag || ad.format === 'carousel' || ad.format === 'collection') return false
  const s = pacSlots(ad)
  if (Object.keys(s).length < 2) return false
  return placementRulesFor(placements, ad.format === 'single_video', { quer: !!s.quer, quadrat: !!s.quadrat }).length >= 2
}

export function creativeMode(ad: AdDraft, placements?: Placements): CreativeMode {
  if (ad.beitrag) return 'beitrag'
  if (ad.format === 'carousel') return 'carousel'
  const isVideo = ad.format === 'single_video'
  if (hatSprachen(ad)) return 'asset_feed_language'
  if (usesPlacementFeed(ad, placements)) return 'asset_feed'
  // Textvarianten mit einem Medium (bis 5 Primärtexte, Überschriften, Beschreibungen)
  const nTexte = Math.max(cleanTexts(ad.primary_texts).length, cleanTexts(ad.headlines).length)
  const nBeschr = cleanTexts(ad.descriptions).length
  if (nTexte > 1 || nBeschr > 1) {
    // Bewährter Weg (Runde 1, live): Platzierungs-Creative mit demselben Medium je Regel, solange
    // eine Beschreibung reicht und zwei Platzierungsregeln möglich sind. asset_feed_text (ohne
    // optimization_type) ist ungeprüft: erst nach validate_only für alle Textvarianten nutzen.
    if (nBeschr <= 1 && placementRulesFor(placements, isVideo).length >= 2) return 'asset_feed'
    return 'asset_feed_text'
  }
  return isVideo ? 'video_data' : 'link_data'
}

export function creativeFeaturesSpec(sel: Partial<Record<CreativeFeature, Enroll>> | undefined): Record<string, { enroll_status: Enroll }> {
  const out: Record<string, { enroll_status: Enroll }> = {}
  for (const k of CREATIVE_FEATURES) out[k] = { enroll_status: sel?.[k] === 'OPT_IN' ? 'OPT_IN' : HP_CREATIVE_FEATURE_DEFAULT }
  return out
}

export interface CreativeBuild { mode: CreativeMode; payload: GraphParams }

/** Link, Button-Wert und angezeigter Link je Ziel-Art der Werbeanzeige. */
export interface AdCtaInfo {
  /** link_data.link bzw. link_urls.website_url */
  link: string
  /** call_to_action.value */
  value: GraphParams
  /** angezeigter Link (nur Website-Ziele) */
  display: string
  /** Sofortformular im Spiel */
  form: boolean
  /** echte Website-URL (UTM, Lint, Conversion-Domain) */
  website: boolean
}
export function adCtaInfo(ad: AdDraft): AdCtaInfo {
  const d: AdDestination = ad.destination ?? { kind: 'website', url: '' }
  switch (d.kind) {
    case 'lead_form':
      return { link: LEAD_FORM_LINK, value: { link: LEAD_FORM_LINK, lead_gen_form_id: d.form_id }, display: '', form: true, website: false }
    case 'website_lead_form':
      // Website-Link + Formular am Button (Aufbau aus einer HP-Anzeige gelesen; API-Pfad per validate_only prüfen)
      return { link: (d.url ?? '').trim(), value: { lead_gen_form_id: d.form_id }, display: (d.display_link ?? '').trim(), form: true, website: true }
    case 'whatsapp':
      return { link: WHATSAPP_LINK, value: { app_destination: 'WHATSAPP' }, display: '', form: false, website: false }
    case 'phone_call':
      // Anruf-Button: value.link = tel:+49... (API-Pfad ungeprüft, per validate_only prüfen)
      return { link: `https://www.facebook.com/${(ad.identity?.page_id ?? '').trim()}`, value: { link: `tel:${normalizeTelefon(d.telefon)}` }, display: '', form: false, website: false }
    case 'messenger':
      return { link: MESSENGER_LINK, value: { app_destination: 'MESSENGER' }, display: '', form: false, website: false }
    default: {
      const url = d.kind === 'website' ? (d.url ?? '').trim() : ''
      return { link: url, value: { link: url }, display: d.kind === 'website' ? (d.display_link ?? '').trim() : '', form: false, website: true }
    }
  }
}

/**
 * WhatsApp-Begrüßung (page_welcome_message, Aufbau laut Meta-Doku „Ads that Click to WhatsApp“).
 * Als JSON-Text gesendet; API-Pfad per validate_only prüfen. null = Metas Standardtext.
 */
export function whatsappWillkommen(ad: AdDraft): string | null {
  const d = ad.destination
  if (!d || d.kind !== 'whatsapp') return null
  const text = (d.begruessung ?? '').trim(), nachricht = (d.nachricht ?? '').trim()
  if (!text && !nachricht) return null
  const message: Record<string, unknown> = {}
  if (text) message.text = text
  if (nachricht) message.autofill_message = { content: nachricht }
  return JSON.stringify({
    type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text',
    text_format: { customer_action_type: 'autofill_message', message },
  })
}

/**
 * Partnerschaftswerbung: facebook_branded_content / instagram_branded_content (Meta-Doku Partnership Ads).
 * API-Pfad ungeprüft, per validate_only prüfen: sponsor_page_id / sponsor_id bezeichnen bei Meta die
 * zahlende Marke. Mit Happy Property als Hauptidentität könnten die Rollen vertauscht sein; dann
 * stattdessen branded_content.partners mit identity_type senden (04 §1.6).
 */
function partnerFelder(ad: AdDraft, payload: GraphParams, story: GraphParams | null): void {
  const p = ad.partnerschaft
  if (!p) return
  const pp = (p.partner_page_id ?? '').trim(), pi = (p.partner_ig_user_id ?? '').trim()
  const ownPage = (ad.identity?.page_id ?? '').trim(), ownIg = (ad.identity?.instagram_user_id ?? '').trim()
  if (p.partner_ist_absender === true && pp) {
    // Partner = Hauptidentität, Happy Property = zweite Identität (Instagram-Konto kommt von der Partner-Seite)
    if (story) { story.page_id = pp; delete story.instagram_user_id }
    if (ownPage) payload.facebook_branded_content = { sponsor_page_id: ownPage }
    if (ownIg) payload.instagram_branded_content = { sponsor_id: ownIg }
    return
  }
  if (pp) payload.facebook_branded_content = { sponsor_page_id: pp }
  if (pi) payload.instagram_branded_content = { sponsor_id: pi }
}

const cropsOf = (r: MediaRef | undefined): ImageCrops | undefined =>
  (r && r.crops && typeof r.crops === 'object' && Object.keys(r.crops).length ? clone(r.crops) : undefined)

/**
 * Creative-Payload für POST act_X/adcreatives (oder inline in POST act_X/ads).
 * Immer: url_tags = URL_TAGS_STANDARD, contextual_multi_ads OPT_OUT (außer bewusst an),
 * jede Advantage+ Creative-Funktion explizit, instagram_user_id, CTA mit Wert je Ziel-Art.
 * Medien müssen aufgelöst sein (image_hash / video_id), sonst Error 'media_unresolved'.
 */
export function buildCreativePayload(ad: AdDraft, ctx: { placements?: Placements } = {}): CreativeBuild {
  const mode = creativeMode(ad, ctx.placements)
  const isVideo = ad.format === 'single_video'
  const info = adCtaInfo(ad)
  const cta = { type: ad.cta_type, value: info.value }
  const bodies = cleanTexts(ad.primary_texts)
  const titles = cleanTexts(ad.headlines)
  const descs = cleanTexts(ad.descriptions)
  const ig = (ad.identity?.instagram_user_id ?? '').trim()
  const payload: GraphParams = {
    name: cleanName(ad.name, 100),
    url_tags: URL_TAGS_STANDARD,
    contextual_multi_ads: { enroll_status: ad.multi_advertiser === 'OPT_IN' ? 'OPT_IN' : 'OPT_OUT' },
    degrees_of_freedom_spec: { creative_features_spec: creativeFeaturesSpec(ad.creative_features) },
  }
  const need = (r: MediaRef | undefined, what: 'image' | 'video'): MediaRef => {
    if (!r || (what === 'image' ? !r.image_hash : !r.video_id)) throw new Error('media_unresolved')
    return r
  }
  const imageItem = (r: MediaRef | undefined, label?: string): GraphParams => {
    const x = need(r, 'image')
    const item: GraphParams = { hash: x.image_hash }
    const c = cropsOf(x)
    if (c) item.image_crops = c
    if (label) item.adlabels = [{ name: label }]
    return item
  }
  const videoItem = (r: MediaRef | undefined, label?: string): GraphParams => {
    const x = need(r, 'video')
    const item: GraphParams = { video_id: x.video_id }
    if (x.thumbnail_hash) item.thumbnail_hash = x.thumbnail_hash
    if (label) item.adlabels = [{ name: label }]
    return item
  }

  // Vorhandener Beitrag: kein object_story_spec, Texte und Medien kommen aus dem Beitrag
  if (mode === 'beitrag') {
    const b = ad.beitrag as BeitragRef
    if (b.quelle === 'facebook') {
      payload.object_story_id = String(b.id).trim()
      // Instagram-Platzierungen mit dem HP-Konto (API-Pfad per validate_only prüfen)
      if (ig) payload.instagram_user_id = ig
    } else {
      // Meta-Doku (Instagram-Inhalte als Anzeige): source_instagram_media_id + object_id (Seite) + instagram_user_id + call_to_action
      payload.source_instagram_media_id = String(b.id).trim()
      payload.object_id = ad.identity.page_id
      if (ig) payload.instagram_user_id = ig
      payload.call_to_action = ad.destination?.kind === 'whatsapp'
        ? { type: ad.cta_type, value: { link: WHATSAPP_LINK, app_destination: 'WHATSAPP' } }
        : cta
    }
    partnerFelder(ad, payload, null)
    return { mode, payload }
  }

  const story: GraphParams = { page_id: ad.identity.page_id }
  if (ig) story.instagram_user_id = ig
  payload.object_story_spec = story
  const willkommen = whatsappWillkommen(ad)

  if (mode === 'carousel') {
    const endkarte = ad.karussell?.endkarte === true
    const automatisch = ad.karussell?.reihenfolge_automatisch !== false
    const cards = (ad.media.cards ?? []).map(cd => {
      const cardLink = info.website ? ((cd.url ?? '').trim() || info.link) : info.link
      const att: GraphParams = {
        link: cardLink,
        name: cd.headline.trim(),
        call_to_action: { type: ad.cta_type, value: info.website && !info.form ? { link: cardLink } : info.value },
      }
      if ((cd.description ?? '').trim()) att.description = (cd.description ?? '').trim()
      if (cd.media.video_id) { att.video_id = cd.media.video_id; if (cd.media.thumbnail_hash) att.image_hash = cd.media.thumbnail_hash }
      else {
        att.image_hash = need(cd.media, 'image').image_hash
        const c = cropsOf(cd.media)
        if (c) att.image_crops = c
      }
      return att
    })
    const ld: GraphParams = {
      link: info.link, message: bodies[0] ?? '', child_attachments: cards,
      multi_share_optimized: automatisch, multi_share_end_card: endkarte, call_to_action: cta,
    }
    if (titles[0]) ld.name = titles[0]
    if (info.display && info.website) ld.caption = info.display
    if (willkommen) ld.page_welcome_message = willkommen
    story.link_data = ld
    partnerFelder(ad, payload, story)
    return { mode, payload }
  }

  /** Grundgerüst eines Asset-Feeds (Format, Link, Button). */
  const feedBasis = (): GraphParams => {
    const linkUrl: GraphParams = { website_url: info.link }
    if (info.display && info.website) linkUrl.display_url = info.display
    const f: GraphParams = {
      ad_formats: [isVideo ? 'SINGLE_VIDEO' : 'SINGLE_IMAGE'],
      link_urls: [linkUrl],
      call_to_action_types: [ad.cta_type],
    }
    // Sofortformular, WhatsApp, Anruf, Messenger: Button-Wert über call_to_actions (per validate_only prüfen)
    if (!(info.website && !info.form)) f.call_to_actions = [{ type: ad.cta_type, value: info.value }]
    return f
  }
  const rulesEinzel = placementRulesFor(ctx.placements, isVideo)
  const onlyStory = rulesEinzel.length === 1 && rulesEinzel[0].slot === 'story'
  const einzelRef = onlyStory ? (storyRef(ad) ?? feedRef(ad)) : (feedRef(ad) ?? storyRef(ad) ?? ad.media?.landscape_191x1)

  if (mode === 'asset_feed_language') {
    // Mehrsprachig (Meta-Doku Multi-Language Ads): ein Medium ohne Label gilt für alle Sprachen,
    // genau eine Standardregel (Deutsch), je weitere Sprache eine Regel mit Sprach-IDs.
    // Für OUTCOME_LEADS nicht ausdrücklich dokumentiert: per validate_only prüfen.
    const sp = ad.sprachen as SprachenSpec
    const vars = (Array.isArray(sp.varianten) ? sp.varianten : []).filter(v => !!v && v.sprache !== 'de' && isIn(AD_SPRACHEN, v.sprache))
    const lbl = (s: AdSprache) => ({ name: `${SPRACH_LABEL_PREFIX}${s}` })
    const f = feedBasis()
    if (isVideo) f.videos = [videoItem(einzelRef)]
    else f.images = [imageItem(einzelRef)]
    const linkDe: GraphParams = { website_url: info.link, adlabels: [lbl('de')] }
    if (info.display) linkDe.display_url = info.display
    f.link_urls = [linkDe, ...vars.map(v => ({ website_url: (v.url ?? '').trim() || info.link, adlabels: [lbl(v.sprache)] }))]
    f.bodies = [{ text: bodies[0] ?? '', adlabels: [lbl('de')] }, ...vars.map(v => ({ text: (v.primary_text ?? '').trim(), adlabels: [lbl(v.sprache)] }))]
    f.titles = [{ text: titles[0] ?? '', adlabels: [lbl('de')] }, ...vars.map(v => ({ text: (v.headline ?? '').trim(), adlabels: [lbl(v.sprache)] }))]
    f.descriptions = [
      { text: descs[0] ?? ' ', adlabels: [lbl('de')] },
      ...vars.map(v => ({ text: (v.description ?? '').trim() || ' ', adlabels: [lbl(v.sprache)] })),
    ]
    const regel = (s: AdSprache, isDefault: boolean): GraphParams => ({
      customization_spec: { locales: SPRACH_LOCALES[s].slice() },
      body_label: lbl(s), title_label: lbl(s), description_label: lbl(s), link_url_label: lbl(s), is_default: isDefault,
    })
    f.asset_customization_rules = [regel('de', true), ...vars.map(v => regel(v.sprache, false))]
    f.optimization_type = 'LANGUAGE'
    const manuellEn = vars.some(v => v.sprache === 'en')
    const auto = (Array.isArray(sp.automatisch_uebersetzen) ? sp.automatisch_uebersetzen : []).filter(s => s === 'en' && !manuellEn)
    if (auto.length) f.autotranslate = [AUTOTRANSLATE_CODE.en]
    payload.asset_feed_spec = f
    partnerFelder(ad, payload, story)
    return { mode, payload }
  }

  if (mode === 'asset_feed_text') {
    // Textvarianten ohne Platzierungs-Medien (Meta-Doku Asset Feed Spec Options: bis 5 je Textart).
    // Ohne optimization_type; per validate_only prüfen.
    const f = feedBasis()
    if (isVideo) f.videos = [videoItem(einzelRef)]
    else f.images = [imageItem(einzelRef)]
    f.bodies = bodies.map(text => ({ text }))
    f.titles = titles.map(text => ({ text }))
    // leer = ein Leerzeichen, sonst holt Meta ungeprüften Text von der Landingpage
    f.descriptions = descs.length ? descs.map(text => ({ text })) : [{ text: ' ' }]
    // WhatsApp-Begrüßung bei Asset-Feeds unter object_story_spec (Meta-Doku); per validate_only prüfen
    if (willkommen) story.page_welcome_message = willkommen
    payload.asset_feed_spec = f
    partnerFelder(ad, payload, story)
    return { mode, payload }
  }

  if (mode === 'asset_feed') {
    const s = pacSlots(ad)
    const rules = placementRulesFor(ctx.placements, isVideo, { quer: !!s.quer, quadrat: !!s.quadrat })
    const fallback = s.feed ?? s.story ?? s.quer ?? s.quadrat
    // Ein Medium (Textvarianten): dasselbe Medium in jeder Regel
    const refFor = (slot: PacSlot): MediaRef | undefined =>
      slot === 'story' ? (s.story ?? s.feed ?? fallback) : slot === 'feed' ? (s.feed ?? s.story ?? fallback) : (s[slot] ?? fallback)
    const f = feedBasis()
    f.optimization_type = 'PLACEMENT'
    f.bodies = bodies.map(text => ({ text }))
    f.titles = titles.map(text => ({ text }))
    f.asset_customization_rules = rules.map(r => ({
      customization_spec: r.customization_spec,
      [isVideo ? 'video_label' : 'image_label']: { name: r.label },
    }))
    f[isVideo ? 'videos' : 'images'] = rules.map(r => (isVideo ? videoItem(refFor(r.slot), r.label) : imageItem(refFor(r.slot), r.label)))
    // Platzierungs-Creatives: genau eine Beschreibung (Meta-PAC-Guide). Leer = ein Leerzeichen,
    // sonst holt Meta ungeprüften Text von der Landingpage.
    f.descriptions = [{ text: descs[0] ?? ' ' }]
    if (willkommen) story.page_welcome_message = willkommen
    payload.asset_feed_spec = f
    partnerFelder(ad, payload, story)
    return { mode, payload }
  }

  // Einzelmedium: Feed-Medium bevorzugt, sonst Story bzw. quer
  if (mode === 'video_data') {
    const v = need(einzelRef, 'video')
    // Video hat kein link-Feld: Website-Link steht im Button-Wert
    const vValue = info.website && info.form ? { ...info.value, link: info.link } : info.value
    const vd: GraphParams = { video_id: v.video_id, message: bodies[0] ?? '', call_to_action: { type: ad.cta_type, value: vValue } }
    if (v.thumbnail_hash) vd.image_hash = v.thumbnail_hash
    if (titles[0]) vd.title = titles[0]
    if (descs[0]) vd.link_description = descs[0]
    if (willkommen) vd.page_welcome_message = willkommen
    story.video_data = vd
  } else {
    const ref = need(einzelRef, 'image')
    const ld: GraphParams = { link: info.link, message: bodies[0] ?? '', image_hash: ref.image_hash, call_to_action: cta }
    const c = cropsOf(ref)
    if (c) ld.image_crops = c
    if (titles[0]) ld.name = titles[0]
    if (descs[0]) ld.description = descs[0]
    if (info.display && info.website) ld.caption = info.display
    if (willkommen) ld.page_welcome_message = willkommen
    story.link_data = ld
  }
  partnerFelder(ad, payload, story)
  return { mode, payload }
}

/**
 * Vorschau-Formate, die die Anzeige in ihrer Anzeigengruppe wirklich ausspielen kann
 * (aus basis; Standard = Liste „Vorschau aller Platzierungen“, PREVIEW_FORMATS = auch Computer-Feed).
 */
export function previewFormatsFor(ad: AdDraft, placements?: Placements, basis: readonly PreviewFormat[] = PREVIEW_ALLE_FORMATS): PreviewFormat[] {
  const manual = placements && placements.mode === 'manual' ? placements : null
  return basis.filter(f => {
    const p = PREVIEW_PLACEMENT[f]
    if (p.nurVideo && ad.format !== 'single_video') return false
    if (p.keinKarussell && ad.format === 'carousel') return false
    if (!manual) return true
    if (manual.publisher_platforms.indexOf(p.platform) < 0) return false
    const list = (manual[POSITION_FIELD_BY_PLATFORM[p.platform]] ?? []) as readonly string[]
    if (list.length && list.indexOf(p.position) < 0) return false
    const dev = manual.device_platforms ?? []
    if (p.device && dev.length && dev.indexOf(p.device) < 0) return false
    return true
  })
}

/** Registrierbare Domain aus einer URL (portal.happy-property.com -> happy-property.com). */
export function registrableDomain(url: string): string | null {
  const m = /^https?:\/\/([^/?#:]+)/i.exec((url ?? '').trim())
  if (!m) return null
  const parts = m[1].toLowerCase().replace(/^www\./, '').split('.')
  return parts.length > 2 ? parts.slice(parts.length - 2).join('.') : parts.join('.')
}
export const draftAdLabel = (draftId: string): string => `hp_draft_${(draftId ?? '').replace(/-/g, '').slice(0, 8)}`

/** Conversion-Domain der Anzeige: eigene Angabe, sonst aus der Website-URL (Pflicht bei Kampagnen mit Pixel). */
export function adConversionDomain(ad: AdDraft): string | null {
  const own = (ad.tracking?.conversion_domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  if (own) return own
  const d = ad.destination
  if (ad.beitrag && ad.beitrag.quelle === 'facebook') return null
  if (d && (d.kind === 'website' || d.kind === 'website_lead_form')) return registrableDomain(d.url)
  return null
}

/**
 * tracking_specs der Anzeige: übernommene Meta-Specs + weitere Pixel (offsite_conversion) +
 * CRM-Lead-Qualität (leadgen_quality_conversion, Meta-Doku Tracking Specs; per validate_only prüfen).
 * Doppelte Einträge fallen weg.
 */
export function buildTrackingSpecs(ad: AdDraft): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const seen: string[] = []
  const push = (x: Record<string, unknown>) => { const k = editCanon(x); if (seen.indexOf(k) < 0) { seen.push(k); out.push(x) } }
  for (const t of Array.isArray(ad.tracking_specs) ? ad.tracking_specs : []) {
    if (t && typeof t === 'object' && !Array.isArray(t)) push(clone(t))
  }
  for (const px of Array.isArray(ad.tracking?.weitere_pixel) ? (ad.tracking?.weitere_pixel ?? []) : []) {
    const id = String(px ?? '').trim()
    if (META_ID_RE.test(id)) push({ 'action.type': ['offsite_conversion'], fb_pixel: [id] })
  }
  if (ad.tracking?.lead_qualitaet && isFormKind(ad.destination?.kind)) {
    push({ 'action.type': ['leadgen_quality_conversion'], fb_pixel: [HP_PIXEL_ID] })
  }
  return out
}

/** Ad-Payload für POST act_X/ads. creative = {creative_id} oder Inline-Creative (validate_only). */
export function buildAdPayload(ad: AdDraft, adsetId: string, creative: { creative_id: string } | GraphParams, opts: { draftId?: string } = {}): GraphParams {
  const p: GraphParams = {
    name: cleanName(ad.name),
    adset_id: adsetId,
    creative,
    status: 'PAUSED',
  }
  if (opts.draftId) p.adlabels = [{ name: draftAdLabel(opts.draftId) }]
  // Pflicht in Kampagnen, die Daten mit einem Pixel teilen (Meta-Doku)
  const dom = adConversionDomain(ad)
  if (dom) p.conversion_domain = dom
  const ts = buildTrackingSpecs(ad)
  if (ts.length) p.tracking_specs = ts
  return p
}

// ═══════════════════════════════════════════════════════════════════════════
// 6d. blame_field_specs -> Formularfeld
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ordnet einen Meta-Fehlerpfad (error_data.blame_field_specs, z. B. ["targeting","age_min"]
 * oder "creative.object_story_spec.link_data.message") dem FieldSpec.key zu. Längster Treffer gewinnt.
 */
export function apiPathToFieldKey(level: Level, path: string | readonly string[] | null | undefined): string | null {
  if (path === null || path === undefined) return null
  let p = Array.isArray(path) ? (path as readonly string[]).join('.') : String(path)
  p = p.replace(/\[\d+\]/g, '').replace(/\.\d+(?=\.|$)/g, '').replace(/^\.+|\.+$/g, '')
  if (level === 'ad') p = p.replace(/^creative\./, '')
  if (!p) return null
  let best: { key: string; len: number } | null = null
  for (const f of FIELD_SPECS) {
    if (f.level !== level || f.virtual) continue
    for (const api of [f.api, ...(f.apiAliases ?? [])]) {
      const hit = p === api || p.indexOf(api + '.') === 0
      if (hit && (!best || api.length > best.len)) best = { key: f.key, len: api.length }
    }
  }
  if (best) return best.key
  if (level === 'adset' && p.indexOf('targeting') === 0) return 'adset.targeting'
  if (level === 'ad' && (p.indexOf('object_story_spec') === 0 || p.indexOf('asset_feed_spec') === 0)) return 'ad.primary_texts'
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Vorlagen
// ═══════════════════════════════════════════════════════════════════════════

export type TemplateKey = 'plan_b'
export interface TemplateCtx {
  page_id?: string
  instagram_user_id?: string
  /** Standard aus dem Werbekonto (default_dsa_*), ad_settings.dsa_* überschreibt */
  dsa_beneficiary?: string
  dsa_payor?: string
  pixel_id?: string
  name?: string
  countries?: string[]
  event?: CustomEvent
}
export interface PlanBPairInput {
  /** Anzeigen-Kennung, z. B. "08_steuer-zurueck" -> 08_steuer-zurueck_lang / _kurz */
  kennung: string
  format?: AdFormat
  primary_texts: string[]
  headlines: string[]
  descriptions?: string[]
  media: AdDraft['media']
  page_id?: string
  instagram_user_id?: string
  cta_type?: CtaType
}
export interface DraftTemplate {
  key: TemplateKey
  labelKey: string
  descriptionKey: string
  /** Immobilien-Werbung: muss in einer Kampagne mit Sonderkategorie Wohnen laufen */
  realEstate: boolean
  build(ctx: TemplateCtx): DraftSpec
}

function planBAdset(key: 'lang' | 'kurz', name: string, ctx: TemplateCtx): AdsetDraft {
  return {
    key,
    name,
    destination: 'WEBSITE',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    billing_event: 'IMPRESSIONS',
    promoted_object: { pixel_id: ctx.pixel_id ?? HP_PIXEL_ID, custom_event_type: ctx.event ?? 'SCHEDULE' },
    attribution: 'click_7d_view_1d',
    daily_budget_cents: 6900,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: {
      geo_locations: { countries: (ctx.countries ?? ['DE']).slice(), location_types: ['home', 'recent'] },
      age_min: HOUSING_AGE_MIN,
      age_max: HOUSING_AGE_MAX,
      targeting_automation: { advantage_audience: 1 },
    },
    placements: { mode: 'advantage' },
    dsa_beneficiary: ctx.dsa_beneficiary ?? '',
    dsa_payor: ctx.dsa_payor ?? '',
  }
}

/** Ein Werbemittel -> je eine Anzeige in „Kalt · Lang" und „Kalt · Kurz". */
export function planBPair(input: PlanBPairInput): AdDraft[] {
  const kennung = cleanName(input.kennung, 80).replace(/\s+/g, '-')
  const mk = (suffix: 'lang' | 'kurz', url: string): AdDraft => ({
    key: `${kennung}_${suffix}`,
    adset_key: suffix,
    name: `${kennung}_${suffix}`,
    format: input.format ?? 'single_image',
    identity: { page_id: input.page_id ?? HP_PAGE_ID, instagram_user_id: input.instagram_user_id ?? '' },
    primary_texts: input.primary_texts.slice(),
    headlines: input.headlines.slice(),
    descriptions: (input.descriptions ?? []).slice(),
    cta_type: input.cta_type ?? 'BOOK_NOW',
    destination: { kind: 'website', url },
    media: clone(input.media ?? {}),
    creative_features: {},
    multi_advertiser: 'OPT_OUT',
  })
  return [mk('lang', PLAN_B_LP_LANG), mk('kurz', PLAN_B_LP_KURZ)]
}

export const TEMPLATES: { plan_b: DraftTemplate & { pair: (input: PlanBPairInput) => AdDraft[] } } = {
  plan_b: {
    key: 'plan_b',
    labelKey: `${K}.template.plan_b.name`,
    descriptionKey: `${K}.template.plan_b.description`,
    realEstate: true,
    build: (ctx: TemplateCtx): DraftSpec => ({
      v: 1,
      campaign: {
        name: cleanName(ctx.name ?? 'Plan B Kapitalanleger'),
        objective: 'OUTCOME_LEADS',
        buying_type: 'AUCTION',
        special_ad_categories: ['HOUSING'],
        special_ad_category_country: (ctx.countries ?? ['DE']).slice(),
        budget_level: 'adset',
        is_adset_budget_sharing_enabled: false,
      },
      adsets: [planBAdset('lang', 'Kalt · Lang', ctx), planBAdset('kurz', 'Kalt · Kurz', ctx)],
      ads: [],
      hp: { budgets_synchron: true },
    }),
    pair: planBPair,
  },
}

/**
 * Immobilien-Entwurf? Vorlage entscheidet (realEstate); ohne oder mit unbekannter
 * Vorlage gilt true, weil HP nur für Immobilien wirbt (SPEC §3: immer Wohnen).
 */
export function isRealEstateDraft(templateKey: string | null | undefined): boolean {
  const t = templateKey ? (TEMPLATES as Record<string, DraftTemplate | undefined>)[templateKey] : undefined
  return t ? t.realEstate !== false : true
}

/** Leere Anzeige mit HP-Standards (für „Anzeige hinzufügen"). */
export function emptyAd(key: string, adsetKey: string, ctx: { page_id?: string; instagram_user_id?: string; url?: string } = {}): AdDraft {
  return {
    key,
    adset_key: adsetKey,
    name: '',
    format: 'single_image',
    identity: { page_id: ctx.page_id ?? HP_PAGE_ID, instagram_user_id: ctx.instagram_user_id ?? '' },
    primary_texts: [''],
    headlines: [''],
    descriptions: [],
    cta_type: 'BOOK_NOW',
    destination: { kind: 'website', url: ctx.url ?? HP_DEFAULT_LINK },
    media: {},
    creative_features: {},
    multi_advertiser: 'OPT_OUT',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7b. Bearbeiten bestehender Objekte (meta-builder edit_load / edit_diff / edit_apply)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ein Bearbeiten-Entwurf (meta_drafts.kind = 'edit') hält zwei Stände: den
// Ausgangsstand bei Meta (meta_ids.edit.baseline, schreibt nur der Server) und
// den gewünschten Stand (spec, schreibt die Oberfläche). editDiff vergleicht
// beide Feld für Feld. Nur geänderte, bei Meta änderbare Felder gehen an Meta;
// Gesperrtes kommt mit blocked zurück und wird nie gesendet.
// Status des Entwurfs: 'draft' beim Bearbeiten, 'creating' während edit_apply
// (Sperre), danach wieder 'draft' mit frischem Ausgangsstand.

export type EditLearning = 'neu' | 'moeglich' | 'nein'
export const EDIT_LEARNING_OPTIONS: readonly EnumOption<EditLearning>[] = [
  opt('learning', 'neu'), opt('learning', 'moeglich'), opt('learning', 'nein'),
]

/** Felder, die Meta nach dem Anlegen nicht mehr ändert (im Formular grau, nie gesendet). */
export const EDIT_LOCKS: Readonly<Record<Level, readonly string[]>> = {
  campaign: [
    'campaign.objective', 'campaign.buying_type', 'campaign.special_ad_categories',
    'campaign.special_ad_category_country', 'campaign.budget_level',
  ],
  adset: [
    'adset.destination', 'adset.billing_event', 'adset.promoted_object.page_id', 'adset.promoted_object.custom_conversion_id',
    'adset.promoted_object.whatsapp_phone_number',
  ],
  ad: ['ad.identity.page_id'],
}

const isConversionGoal = (g: OptGoal | undefined): boolean => g === 'OFFSITE_CONVERSIONS' || g === 'VALUE'
const isArchived = (s: string | undefined): boolean => s === 'ARCHIVED' || s === 'DELETED'

/**
 * Sperrliste für einen geladenen Stand (edit_load): feste Sperren plus solche, die vom
 * Stand abhängen (Budgetart, Kampagnen- vs. Gruppenbudget, ROAS-Ziel, Conversion-Ereignis).
 * Genaue Prüfung je Objekt macht editDiff (blocked).
 */
export function editLocks(spec: DraftSpec): string[] {
  const out: string[] = []
  const add = (k: string) => { if (out.indexOf(k) < 0) out.push(k) }
  for (const l of LEVELS) for (const k of EDIT_LOCKS[l]) add(k)
  const c = spec?.campaign
  if (c) {
    if (c.budget_level !== 'campaign') { add('campaign.daily_budget_cents'); add('campaign.lifetime_budget_cents'); add('campaign.bid_strategy') }
    else if ((c.daily_budget_cents ?? 0) > 0) add('campaign.lifetime_budget_cents')
    else if ((c.lifetime_budget_cents ?? 0) > 0) add('campaign.daily_budget_cents')
    if (c.bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS') add('campaign.bid_strategy')
  }
  const adsets = spec?.adsets ?? []
  if (adsets.length) {
    if (c?.budget_level === 'campaign') { add('adset.daily_budget_cents'); add('adset.lifetime_budget_cents'); add('adset.bid_strategy') }
    else {
      if (adsets.every(a => (a.daily_budget_cents ?? 0) > 0)) add('adset.lifetime_budget_cents')
      if (adsets.every(a => (a.lifetime_budget_cents ?? 0) > 0)) add('adset.daily_budget_cents')
    }
    if (adsets.some(a => a.bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS')) add('adset.bid_strategy')
    if (adsets.every(a => !isConversionGoal(a.optimization_goal) || !!a.promoted_object?.custom_conversion_id)) {
      add('adset.promoted_object.pixel_id'); add('adset.promoted_object.custom_event_type')
    }
  }
  if ((spec?.ads ?? []).length && (spec.ads ?? []).every(a => !!a.source?.aus_beitrag)) {
    for (const k of EDIT_CREATIVE_FIELDS) add(k)
  }
  return out
}

export interface EditChange {
  level: Level
  /** Meta-ID des Objekts */
  id: string
  /** 'campaign' bzw. key der Anzeigengruppe/Anzeige im Entwurf */
  node: string
  /** FieldSpec.key */
  field: string
  /** i18n-Schlüssel des Feldnamens (crm.werbung.meta.field.*) */
  label_key: string
  before: unknown
  after: unknown
  /** true = Meta startet die Lernphase neu (nur bei Änderungen, die wirklich gesendet werden) */
  learning_reset: boolean
  /** 'moeglich' = je nach Größe (Budget/Gebot über 20 %, Einschalten nach langer Pause) */
  learning: EditLearning
  /** Teil eines Werbemittel-Tauschs (neues Creative) */
  creative?: boolean
  /** gesetzt = wird NICHT an Meta geschickt; Grund auf Deutsch */
  blocked?: string
}
export interface EditDiffResult { changes: EditChange[]; warnings: string[] }

// ── Vergleichshilfen ────────────────────────────────────────────────────────

type Rec = Record<string, unknown>
const asRec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {})
const leer = (v: unknown): boolean => {
  if (v === undefined || v === null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') { const o = v as Rec; return Object.keys(o).every(k => leer(o[k])) }
  return false
}
/** Kanonische Form für Vergleiche: Schlüssel sortiert, leere Werte = null. */
export function editCanon(v: unknown): string {
  if (leer(v)) return 'null'
  if (Array.isArray(v)) return `[${v.map(editCanon).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Rec
    return `{${Object.keys(o).filter(k => !leer(o[k])).sort().map(k => `${JSON.stringify(k)}:${editCanon(o[k])}`).join(',')}}`
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  return JSON.stringify(v)
}
const sortedCanon = (list: unknown): string[] => (Array.isArray(list) ? list.map(editCanon).sort() : [])
const centsOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null)
/** Limit-Felder: Metas „unbegrenzt“ (922337203685478) = kein Limit. */
const capOrNull = (v: unknown): number | null => { const c = centsOrNull(v); return c !== null && c >= META_UNBEGRENZT_AB ? null : c }
const timeOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(t) ? new Date(t).toISOString() : v.trim()
}
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const sortedStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => String(x)).filter(Boolean).sort() : [])
const pickKeys = (o: unknown, keys: readonly string[]): Rec => {
  const r = asRec(o)
  const out: Rec = {}
  for (const k of keys) if (r[k] !== undefined) out[k] = r[k]
  return out
}
const idsOf = (list: unknown): string[] => (Array.isArray(list)
  ? list.map(x => (x && typeof x === 'object' ? String(asRec(x).id ?? asRec(x).key ?? '') : String(x))).filter(Boolean).sort()
  : [])

const GEO_IDENT = ['key', 'radius', 'distance_unit', 'latitude', 'longitude', 'address_string', 'custom_type', 'min_population', 'max_population'] as const
const geoOhneTypen = (v: unknown): Rec | null => {
  const g = asRec(v)
  const out: Rec = {}
  for (const k of Object.keys(g)) if (k !== 'location_types') out[k] = g[k]
  return Object.keys(out).length ? out : null
}
/** Orte nur über ihre Kennung vergleichen (Meta liefert Namen/Regionen dazu, das Formular nicht immer). */
function geoNorm(v: unknown): unknown {
  const g = asRec(v)
  const out: Rec = {}
  for (const k of Object.keys(g)) {
    const val = g[k]
    out[k] = Array.isArray(val)
      ? val.map(x => (x && typeof x === 'object' ? editCanon(pickKeys(x, GEO_IDENT)) : editCanon(x))).sort()
      : val
  }
  return out
}
function detailedNorm(v: unknown): unknown {
  const t = asRec(v)
  const grp = (g: unknown): string => {
    const o: Rec = {}
    const r = asRec(g)
    for (const k of Object.keys(r)) o[k] = idsOf(r[k])
    return editCanon(o)
  }
  return {
    flexible_spec: Array.isArray(t.flexible_spec) ? t.flexible_spec.map(grp).sort() : null,
    exclusions: t.exclusions ? grp(t.exclusions) : null,
  }
}
function taNorm(v: unknown): unknown {
  const t = asRec(v)
  const rest: Rec = {}
  for (const k of Object.keys(t)) if (k !== 'advantage_audience') rest[k] = t[k]
  const aa = t.advantage_audience
  return { aa: aa === undefined || aa === null ? null : effectiveAdvantageAudience(aa), rest }
}
function placementsNorm(v: unknown): unknown {
  const p = v as Placements | undefined
  if (!p || p.mode !== 'manual') return 'advantage'
  const dev = sortedStrings(p.device_platforms)
  const out: Rec = { publisher_platforms: sortedStrings(p.publisher_platforms), device_platforms: dev.length === DEVICE_PLATFORMS.length ? [] : dev }
  for (const pl of PUBLISHER_PLATFORMS) {
    const f = POSITION_FIELD_BY_PLATFORM[pl]
    out[f] = sortedStrings(p[f])
  }
  return out
}
const SCHED_KEYS = ['time_start', 'time_end', 'budget_value', 'budget_value_type', 'recurrence_type', 'weekly_schedule'] as const
/** Zeitpunkt der Budgetplanung als Unix-Sekunden (ISO-Zeit oder Zahl), null = ungültig. */
export function unixSekunden(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v > 1e11 ? v / 1000 : v)
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+$/.test(v.trim())) return unixSekunden(Number(v.trim()))
    const t = Date.parse(v.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    return Number.isFinite(t) ? Math.round(t / 1000) : null
  }
  return null
}
const schedKey = (x: unknown): string => {
  const r = pickKeys(x, SCHED_KEYS)
  r.time_start = unixSekunden(r.time_start)
  r.time_end = unixSekunden(r.time_end)
  return editCanon(r)
}
const schedNorm = (v: unknown): unknown => (Array.isArray(v) ? v.map(schedKey).sort() : [])
/** Medium über media_id vergleichen, dazu Zuschnitt und bewusst gewähltes Video-Vorschaubild. */
const mediaNorm = (v: unknown): unknown => {
  const r = asRec(v)
  const id = strOrNull(r.media_id)
  if (!id) return null
  const thumb = strOrNull(r.thumbnail_media_id) ?? (r.thumbnail_quelle === 'meta_liste' ? strOrNull(r.thumbnail_hash) : null)
  return { id, crops: leer(r.crops) ? null : r.crops, thumb }
}
const cardsNorm = (v: unknown): unknown => (Array.isArray(v)
  ? v.map(cd => {
    const c = asRec(cd)
    return { headline: strOrNull(c.headline), description: strOrNull(c.description), url: strOrNull(c.url), media: mediaNorm(c.media) }
  })
  : [])
const sprachenNorm = (v: unknown): unknown => {
  const r = asRec(v)
  const vars = Array.isArray(r.varianten) ? r.varianten.map(x => {
    const o = asRec(x)
    return { s: strOrNull(o.sprache), p: strOrNull(o.primary_text), h: strOrNull(o.headline), d: strOrNull(o.description), u: strOrNull(o.url) }
  }) : []
  const auto = sortedStrings(r.automatisch_uebersetzen)
  return vars.length || auto.length ? { vars, auto } : null
}
const partnerNorm = (v: unknown): unknown => {
  const r = asRec(v)
  if (!Object.keys(r).length) return null
  return { page: strOrNull(r.partner_page_id), ig: strOrNull(r.partner_ig_user_id), absender: r.partner_ist_absender === true }
}
const featuresNorm = (v: unknown): unknown => {
  const r = asRec(v)
  const out: Rec = {}
  for (const k of CREATIVE_FEATURES) out[k] = r[k] === 'OPT_IN' ? 'OPT_IN' : HP_CREATIVE_FEATURE_DEFAULT
  return out
}

/** Targeting-Schlüssel, die ein Formularfeld bei Meta abdeckt (edit_apply führt nur diese zusammen). */
export const EDIT_TARGETING_KEYS: Readonly<Record<string, readonly string[]>> = {
  'adset.targeting.geo_locations': ['geo_locations'],
  'adset.targeting.location_types': ['geo_locations.location_types'],
  'adset.targeting.excluded_geo_locations': ['excluded_geo_locations'],
  'adset.targeting.age': ['age_min', 'age_max', 'age_range'],
  'adset.targeting.genders': ['genders'],
  'adset.targeting.locales': ['locales'],
  'adset.targeting.detailed': ['flexible_spec', 'exclusions'],
  'adset.targeting.custom_audiences': ['custom_audiences', 'targeting_relaxation_types'],
  'adset.targeting.excluded_custom_audiences': ['excluded_custom_audiences'],
  'adset.targeting.advantage_audience': ['targeting_automation'],
  'adset.placements': PLACEMENT_TARGETING_KEYS,
  'adset.brand_safety': ['brand_safety_content_filter_levels'],
  'adset.excluded_publisher_categories': ['excluded_publisher_categories'],
}
/** Alle oben abgedeckten Schlüssel; der Rest des targeting-Objekts ist das Feld 'adset.targeting'. */
export const EDIT_TARGETING_COVERED: readonly string[] = [
  'geo_locations', 'excluded_geo_locations', 'age_min', 'age_max', 'age_range', 'genders', 'locales',
  'flexible_spec', 'exclusions', 'custom_audiences', 'excluded_custom_audiences', 'targeting_relaxation_types',
  'targeting_automation', 'brand_safety_content_filter_levels', 'excluded_publisher_categories', ...PLACEMENT_TARGETING_KEYS,
]
/** Übrige targeting-Felder (z. B. user_os, user_device), die das Formular nicht einzeln kennt. */
export function targetingRest(t: TargetingSpec | undefined): Rec {
  const r = asRec(t)
  const out: Rec = {}
  for (const k of Object.keys(r)) if (EDIT_TARGETING_COVERED.indexOf(k) < 0) out[k] = r[k]
  return out
}

// ── Feld-Register fürs Bearbeiten ───────────────────────────────────────────

interface EditDef<N> {
  key: string
  learning: EditLearning | ((before: unknown, after: unknown) => EditLearning)
  get(n: N, d: DraftSpec): unknown
  /** Vergleichsform (ohne Anzeigenamen u. ä.); Standard = get */
  norm?(v: unknown): unknown
  creative?: true
}
/** Budget/Gebot: über 20 % Änderung kann die Lernphase neu starten (keine offizielle Schwelle). */
const sizeLearning = (b: unknown, a: unknown): EditLearning => {
  const x = typeof b === 'number' ? b : 0
  const y = typeof a === 'number' ? a : 0
  if (!x || !y) return 'nein'
  return Math.abs(y - x) / x > 0.2 ? 'moeglich' : 'nein'
}
const statusLearning = (b: unknown, a: unknown): EditLearning => (a === 'ACTIVE' && b !== 'ACTIVE' ? 'moeglich' : 'nein')

const CAMPAIGN_EDIT: readonly EditDef<CampaignDraft>[] = [
  { key: 'campaign.name', learning: 'nein', get: c => strOrNull(c.name) },
  { key: 'campaign.status', learning: statusLearning, get: c => c.status ?? null },
  { key: 'campaign.objective', learning: 'neu', get: c => c.objective ?? null },
  { key: 'campaign.buying_type', learning: 'nein', get: c => c.buying_type ?? null },
  { key: 'campaign.special_ad_categories', learning: 'neu', get: c => sortedStrings((c.special_ad_categories ?? []).filter(x => x !== 'NONE')) },
  { key: 'campaign.special_ad_category_country', learning: 'nein', get: c => sortedStrings(c.special_ad_category_country) },
  { key: 'campaign.budget_level', learning: 'neu', get: c => c.budget_level ?? null },
  { key: 'campaign.daily_budget_cents', learning: sizeLearning, get: c => centsOrNull(c.daily_budget_cents) },
  { key: 'campaign.lifetime_budget_cents', learning: sizeLearning, get: c => centsOrNull(c.lifetime_budget_cents) },
  { key: 'campaign.bid_strategy', learning: 'neu', get: c => (c.budget_level === 'campaign' ? (c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP') : (c.bid_strategy ?? null)) },
  { key: 'campaign.is_adset_budget_sharing_enabled', learning: 'nein', get: c => (c.budget_level === 'campaign' ? null : c.is_adset_budget_sharing_enabled === true) },
  { key: 'campaign.spend_cap_cents', learning: 'nein', get: c => capOrNull(c.spend_cap_cents) },
  { key: 'campaign.start_time', learning: 'nein', get: c => timeOrNull(c.start_time) },
  { key: 'campaign.stop_time', learning: 'nein', get: c => timeOrNull(c.stop_time) },
  { key: 'campaign.budget_schedule_specs', learning: 'nein', get: c => c.budget_schedule_specs ?? [], norm: schedNorm },
]

const ADSET_EDIT: readonly EditDef<AdsetDraft>[] = [
  { key: 'adset.name', learning: 'nein', get: a => strOrNull(a.name) },
  { key: 'adset.status', learning: statusLearning, get: a => a.status ?? null },
  { key: 'adset.destination', learning: 'neu', get: a => a.destination ?? null },
  { key: 'adset.optimization_goal', learning: 'neu', get: a => a.optimization_goal ?? null },
  { key: 'adset.billing_event', learning: 'neu', get: a => a.billing_event ?? null },
  { key: 'adset.promoted_object.pixel_id', learning: 'neu', get: a => strOrNull(a.promoted_object?.pixel_id) },
  { key: 'adset.promoted_object.custom_event_type', learning: 'neu', get: a => a.promoted_object?.custom_event_type ?? null },
  { key: 'adset.promoted_object.custom_conversion_id', learning: 'neu', get: a => strOrNull(a.promoted_object?.custom_conversion_id) },
  { key: 'adset.promoted_object.page_id', learning: 'neu', get: a => strOrNull(a.promoted_object?.page_id) },
  { key: 'adset.promoted_object.whatsapp_phone_number', learning: 'neu', get: a => strOrNull(a.promoted_object?.whatsapp_phone_number) },
  { key: 'adset.attribution', learning: 'neu', get: a => a.attribution ?? null },
  { key: 'adset.daily_budget_cents', learning: sizeLearning, get: a => centsOrNull(a.daily_budget_cents) },
  { key: 'adset.lifetime_budget_cents', learning: sizeLearning, get: a => centsOrNull(a.lifetime_budget_cents) },
  { key: 'adset.bid_strategy', learning: 'neu', get: (a, d) => (d.campaign?.budget_level === 'campaign' ? (a.bid_strategy ?? null) : (a.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP')) },
  { key: 'adset.bid_amount_cents', learning: sizeLearning, get: a => centsOrNull(a.bid_amount_cents) },
  { key: 'adset.roas_average_floor', learning: sizeLearning, get: a => centsOrNull(a.roas_average_floor) },
  { key: 'adset.start_time', learning: 'nein', get: a => timeOrNull(a.start_time) },
  { key: 'adset.end_time', learning: 'nein', get: a => timeOrNull(a.end_time) },
  { key: 'adset.adset_schedule', learning: 'moeglich', get: a => a.adset_schedule ?? [], norm: sortedCanon },
  { key: 'adset.daily_min_spend_target_cents', learning: 'nein', get: a => centsOrNull(a.daily_min_spend_target_cents) },
  { key: 'adset.daily_spend_cap_cents', learning: 'nein', get: a => capOrNull(a.daily_spend_cap_cents) },
  { key: 'adset.lifetime_min_spend_target_cents', learning: 'nein', get: a => centsOrNull(a.lifetime_min_spend_target_cents) },
  { key: 'adset.lifetime_spend_cap_cents', learning: 'nein', get: a => capOrNull(a.lifetime_spend_cap_cents) },
  { key: 'adset.budget_schedule_specs', learning: 'nein', get: a => a.budget_schedule_specs ?? [], norm: schedNorm },
  { key: 'adset.dsa_beneficiary', learning: 'nein', get: a => strOrNull(a.dsa_beneficiary) },
  { key: 'adset.dsa_payor', learning: 'nein', get: a => strOrNull(a.dsa_payor) },
  // Zielgruppe und Platzierungen: jede Änderung ist für Meta „wesentlich“ (Lernphase neu)
  { key: 'adset.targeting.geo_locations', learning: 'neu', get: a => geoOhneTypen(a.targeting?.geo_locations), norm: geoNorm },
  { key: 'adset.targeting.location_types', learning: 'neu', get: a => sortedStrings(a.targeting?.geo_locations?.location_types) },
  { key: 'adset.targeting.excluded_geo_locations', learning: 'neu', get: a => a.targeting?.excluded_geo_locations ?? null, norm: geoNorm },
  {
    key: 'adset.targeting.age', learning: 'neu',
    get: a => ({ age_min: a.targeting?.age_min ?? null, age_max: a.targeting?.age_max ?? null, age_range: a.targeting?.age_range ?? null }),
  },
  { key: 'adset.targeting.genders', learning: 'neu', get: a => (a.targeting?.genders ?? []).filter(g => g !== 0).slice().sort((x, y) => x - y) },
  { key: 'adset.targeting.locales', learning: 'neu', get: a => (a.targeting?.locales ?? []).slice().sort((x, y) => x - y) },
  {
    key: 'adset.targeting.detailed', learning: 'neu',
    get: a => ({ flexible_spec: a.targeting?.flexible_spec ?? null, exclusions: a.targeting?.exclusions ?? null }), norm: detailedNorm,
  },
  {
    key: 'adset.targeting.custom_audiences', learning: 'neu',
    get: a => ({ custom_audiences: a.targeting?.custom_audiences ?? null, targeting_relaxation_types: a.targeting?.targeting_relaxation_types ?? null }),
    norm: v => ({ ids: idsOf(asRec(v).custom_audiences), relax: asRec(v).targeting_relaxation_types }),
  },
  { key: 'adset.targeting.excluded_custom_audiences', learning: 'neu', get: a => a.targeting?.excluded_custom_audiences ?? null, norm: idsOf },
  { key: 'adset.targeting.advantage_audience', learning: 'neu', get: a => a.targeting?.targeting_automation ?? null, norm: taNorm },
  { key: 'adset.placements', learning: 'neu', get: a => a.placements ?? { mode: 'advantage' }, norm: placementsNorm },
  { key: 'adset.brand_safety', learning: 'neu', get: a => a.brand_safety ?? null },
  { key: 'adset.excluded_publisher_categories', learning: 'neu', get: a => (a.excluded_publisher_categories ?? []).slice().sort() },
  { key: 'adset.targeting', learning: 'neu', get: a => targetingRest(a.targeting) },
]

const destUrl = (a: AdDraft): string | null => {
  const d = a.destination
  return d && (d.kind === 'website' || d.kind === 'website_lead_form') ? strOrNull(d.url) : null
}
const AD_EDIT: readonly EditDef<AdDraft>[] = [
  { key: 'ad.name', learning: 'nein', get: a => strOrNull(a.name) },
  { key: 'ad.status', learning: 'nein', get: a => a.status ?? null },
  // Tracking: übernommene Meta-Specs + weitere Pixel + Lead-Qualität (so wie buildAdPayload sendet)
  { key: 'ad.tracking_specs', learning: 'nein', get: a => buildTrackingSpecs(a), norm: sortedCanon },
  // eigene Conversion-Domain: nur die Angabe im Formular (Meta liefert den Wert beim Laden nicht mit)
  { key: 'ad.tracking.conversion_domain', learning: 'nein', get: a => strOrNull((a.tracking?.conversion_domain ?? '').toLowerCase()) },
  // Werbemittel: Änderung = neues Creative (ersetzen oder neue Anzeige)
  { key: 'ad.format', learning: 'neu', creative: true, get: a => a.format ?? null },
  { key: 'ad.beitrag', learning: 'neu', creative: true, get: a => (a.beitrag ? { quelle: a.beitrag.quelle, id: strOrNull(a.beitrag.id) } : null) },
  { key: 'ad.identity.page_id', learning: 'neu', creative: true, get: a => strOrNull(a.identity?.page_id) },
  { key: 'ad.identity.instagram_user_id', learning: 'neu', creative: true, get: a => strOrNull(a.identity?.instagram_user_id) },
  { key: 'ad.primary_texts', learning: 'neu', creative: true, get: a => cleanTexts(a.primary_texts) },
  { key: 'ad.headlines', learning: 'neu', creative: true, get: a => cleanTexts(a.headlines) },
  { key: 'ad.descriptions', learning: 'neu', creative: true, get: a => cleanTexts(a.descriptions) },
  { key: 'ad.cta_type', learning: 'neu', creative: true, get: a => a.cta_type ?? null },
  { key: 'ad.destination.kind', learning: 'neu', creative: true, get: a => a.destination?.kind ?? null },
  { key: 'ad.destination.url', learning: 'neu', creative: true, get: destUrl },
  {
    key: 'ad.destination.display_link', learning: 'neu', creative: true,
    get: a => (a.destination?.kind === 'website' || a.destination?.kind === 'website_lead_form' ? strOrNull(a.destination.display_link) : null),
  },
  {
    key: 'ad.destination.form_id', learning: 'neu', creative: true,
    get: a => (a.destination?.kind === 'lead_form' || a.destination?.kind === 'website_lead_form' ? strOrNull(a.destination.form_id) : null),
  },
  { key: 'ad.destination.telefon', learning: 'neu', creative: true, get: a => (a.destination?.kind === 'phone_call' ? strOrNull(normalizeTelefon(a.destination.telefon)) : null) },
  { key: 'ad.destination.whatsapp_begruessung', learning: 'neu', creative: true, get: a => (a.destination?.kind === 'whatsapp' ? strOrNull(a.destination.begruessung) : null) },
  { key: 'ad.destination.whatsapp_nachricht', learning: 'neu', creative: true, get: a => (a.destination?.kind === 'whatsapp' ? strOrNull(a.destination.nachricht) : null) },
  { key: 'ad.media.feed_4x5', learning: 'neu', creative: true, get: a => a.media?.feed_4x5 ?? null, norm: mediaNorm },
  { key: 'ad.media.story_9x16', learning: 'neu', creative: true, get: a => a.media?.story_9x16 ?? null, norm: mediaNorm },
  { key: 'ad.media.square_1x1', learning: 'neu', creative: true, get: a => a.media?.square_1x1 ?? null, norm: mediaNorm },
  { key: 'ad.media.landscape_191x1', learning: 'neu', creative: true, get: a => a.media?.landscape_191x1 ?? null, norm: mediaNorm },
  { key: 'ad.media.cards', learning: 'neu', creative: true, get: a => a.media?.cards ?? [], norm: cardsNorm },
  { key: 'ad.karussell.endkarte', learning: 'neu', creative: true, get: a => (a.format === 'carousel' ? a.karussell?.endkarte === true : null) },
  { key: 'ad.karussell.reihenfolge_automatisch', learning: 'neu', creative: true, get: a => (a.format === 'carousel' ? a.karussell?.reihenfolge_automatisch !== false : null) },
  { key: 'ad.sprachen', learning: 'neu', creative: true, get: a => a.sprachen ?? null, norm: sprachenNorm },
  { key: 'ad.partnerschaft', learning: 'neu', creative: true, get: a => a.partnerschaft ?? null, norm: partnerNorm },
  { key: 'ad.creative_features', learning: 'neu', creative: true, get: a => a.creative_features ?? {}, norm: featuresNorm },
  { key: 'ad.multi_advertiser', learning: 'neu', creative: true, get: a => (a.multi_advertiser === 'OPT_IN' ? 'OPT_IN' : 'OPT_OUT') },
]

/** Alle Feld-Schlüssel, die editDiff vergleicht (jeder hat einen FieldSpec). */
export const EDIT_FIELD_KEYS: readonly string[] = [...CAMPAIGN_EDIT, ...ADSET_EDIT, ...AD_EDIT].map(d => d.key)
/** Felder des Werbemittels (Änderung = neues Creative). */
export const EDIT_CREATIVE_FIELDS: readonly string[] = AD_EDIT.filter(d => d.creative).map(d => d.key)

function editDefOf(field: string): EditDef<CampaignDraft> | EditDef<AdsetDraft> | EditDef<AdDraft> | undefined {
  return CAMPAIGN_EDIT.find(d => d.key === field) ?? ADSET_EDIT.find(d => d.key === field) ?? AD_EDIT.find(d => d.key === field)
}

/** Wert eines Feldes für das Objekt mit dieser Meta-ID (für den Abgleich mit dem Live-Stand). */
export function editFieldValue(spec: DraftSpec, level: Level, id: string, field: string): unknown {
  if (level === 'campaign') {
    const def = CAMPAIGN_EDIT.find(d => d.key === field)
    return def && spec?.campaign && spec.campaign.existing_id === id ? def.get(spec.campaign, spec) : undefined
  }
  if (level === 'adset') {
    const def = ADSET_EDIT.find(d => d.key === field)
    const n = (spec?.adsets ?? []).find(a => a.existing_id === id)
    return def && n ? def.get(n, spec) : undefined
  }
  const def = AD_EDIT.find(d => d.key === field)
  const n = (spec?.ads ?? []).find(a => a.existing_id === id)
  return def && n ? def.get(n, spec) : undefined
}
/** Gleich im Sinne von editDiff (gleiche Vergleichsform)? */
export function editSame(field: string, a: unknown, b: unknown): boolean {
  const def = editDefOf(field)
  const n = (v: unknown) => (def && def.norm ? def.norm(v) : v)
  return editCanon(n(a)) === editCanon(n(b))
}
/** Neue Zeiträume der Budgetplanung (in after, nicht in before). */
export function neueBudgetZeitraeume(before: readonly BudgetScheduleSpec[] | undefined, after: readonly BudgetScheduleSpec[] | undefined): BudgetScheduleSpec[] {
  const alt = (before ?? []).map(schedKey)
  return (after ?? []).filter(x => alt.indexOf(schedKey(x)) < 0)
}
/** Zeiträume, die aus der Liste entfernt wurden (geht hier nicht). */
export function entfernteBudgetZeitraeume(before: readonly BudgetScheduleSpec[] | undefined, after: readonly BudgetScheduleSpec[] | undefined): BudgetScheduleSpec[] {
  const neu = (after ?? []).map(schedKey)
  return (before ?? []).filter(x => neu.indexOf(schedKey(x)) < 0)
}

// ── Gründe (deutsch, an der Oberfläche angezeigt) ───────────────────────────

export const EDIT_BLOCK_TEXT = {
  lock: 'Bei Meta nach dem Anlegen nicht mehr änderbar.',
  archiviert: 'Archivierte oder gelöschte Objekte ändert der Assistent nicht.',
  nieLoeschen: 'Löschen und Archivieren macht der Assistent nie. Zum Stoppen auf „Pausiert“ stellen.',
  keinKampagnenbudget: 'Diese Kampagne hat kein Kampagnenbudget; das Budget steht in den Anzeigengruppen.',
  budgetAufKampagne: 'Das Budget steht in der Kampagne (Advantage+ Kampagnenbudget).',
  budgetEntfernen: 'Ein Budget lässt sich nicht entfernen, nur ändern.',
  budgetart: 'Tages- und Laufzeitbudget lassen sich nach dem Anlegen nicht tauschen.',
  roasFest: 'Die Gebotsstrategie „ROAS-Ziel“ lässt sich nach dem Anlegen nicht wechseln.',
  gebotAufKampagne: 'Die Gebotsstrategie steht bei Kampagnenbudget in der Kampagne.',
  teilenEin: 'Das Teilen des Anzeigengruppenbudgets lässt sich laufend nur ausschalten, nicht einschalten.',
  conversionNurWebsite: 'Datensatz und Conversion-Event lassen sich nur bei Website-Conversions ändern.',
  customConversion: 'Die Anzeigengruppe optimiert auf eine benutzerdefinierte Conversion, die bleibt fest.',
  zielPasstNicht: 'Dieses Performance-Ziel passt nicht zu Kampagnenziel und Conversion-Ort.',
  abrechnungPasstNicht: 'Dieses Performance-Ziel passt nicht zur Abrechnung der Anzeigengruppe.',
  zeitplanLaufzeit: 'Anzeigen nach Zeitplan gehen nur mit Laufzeitbudget.',
  gruppenLimitsCbo: 'Ausgabenlimits für Anzeigengruppen gibt es nur mit Kampagnen-Tagesbudget.',
  gruppenLimitsCboLaufzeit: 'Laufzeit-Ausgabenlimits für Anzeigengruppen gibt es nur mit Kampagnen-Laufzeitbudget.',
  laufzeitLimitEntfernen: 'Das maximale Laufzeit-Ausgabenlimit lässt sich hier noch nicht entfernen (bei Meta noch nicht geprüft), nur ändern.',
  verschieben: 'Anzeigen lassen sich nicht in eine andere Anzeigengruppe verschieben. Anzeigengruppe zurückstellen oder „Duplizieren“ in die gewünschte Anzeigengruppe nutzen.',
  budgetplanungTages: 'Budgetplanung geht nur mit Tagesbudget.',
  budgetplanungEntfernen: 'Bestehende Zeiträume der Budgetplanung lassen sich hier nicht entfernen.',
  beitrag: 'Diese Anzeige nutzt einen bestehenden Beitrag; Texte und Medien lassen sich hier nicht ändern.',
  ersetzenModus: 'Beim Ersetzen erlaubt Meta keinen Wechsel zwischen Medien je Platzierung und Einzelmedium. Bitte „Neue Anzeige“ wählen.',
  partnerUnbekannt: 'Diese Partnerschaftswerbung kann der Assistent nicht nachbauen; ein neues Werbemittel würde den Partner verlieren. Bitte im Werbeanzeigenmanager ändern.',
} as const

// ── Vergleich ───────────────────────────────────────────────────────────────

const LEVEL_TEXT: Readonly<Record<Level, string>> = { campaign: 'Kampagne', adset: 'Anzeigengruppe', ad: 'Anzeige' }
/** Felder je Ebene, die editDiff kennt; alles andere meldet es als „wird nicht gesendet“ (nie still verwerfen). */
const EDIT_KNOWN_KEYS: Readonly<Record<Level, readonly string[]>> = {
  campaign: [
    'existing_id', 'name', 'objective', 'buying_type', 'special_ad_categories', 'special_ad_category_country', 'budget_level',
    'daily_budget_cents', 'lifetime_budget_cents', 'bid_strategy', 'is_adset_budget_sharing_enabled', 'spend_cap_cents',
    'start_time', 'stop_time', 'status', 'meta_status', 'budget_schedule_specs',
  ],
  adset: [
    'key', 'existing_id', 'name', 'destination', 'optimization_goal', 'billing_event', 'promoted_object', 'attribution',
    'daily_budget_cents', 'lifetime_budget_cents', 'bid_strategy', 'bid_amount_cents', 'roas_average_floor', 'start_time',
    'end_time', 'targeting', 'placements', 'dsa_beneficiary', 'dsa_payor', 'brand_safety', 'excluded_publisher_categories',
    'status', 'meta_status', 'adset_schedule', 'daily_min_spend_target_cents', 'daily_spend_cap_cents',
    'lifetime_min_spend_target_cents', 'lifetime_spend_cap_cents', 'budget_schedule_specs',
  ],
  ad: [
    'key', 'adset_key', 'existing_id', 'name', 'format', 'identity', 'primary_texts', 'headlines', 'descriptions', 'cta_type',
    'destination', 'media', 'creative_features', 'multi_advertiser', 'source', 'status', 'meta_status', 'tracking_specs',
    'beitrag', 'karussell', 'sprachen', 'partnerschaft', 'tracking',
  ],
}

/**
 * Vergleicht Ausgangsstand (baseline, so wie bei Meta geladen) mit dem gewünschten Stand.
 * Objekte werden über existing_id zugeordnet. Rein, ohne Meta-Aufruf: Oberfläche
 * („Das ändert sich bei Meta“) und Server (edit_diff/edit_apply) rechnen gleich.
 */
export function editDiff(baseline: DraftSpec, spec: DraftSpec): EditDiffResult {
  const changes: EditChange[] = []
  const warnings: string[] = []
  const bc = baseline?.campaign
  const sc = spec?.campaign
  if (!bc || !sc || !bc.existing_id) return { changes, warnings: ['Kein Ausgangsstand von Meta. Bitte neu laden.'] }
  const tausch: CreativeTausch = spec.hp?.creative_tausch === 'ersetzen' ? 'ersetzen' : 'neue_anzeige'
  const block = (ch: EditChange, why: string) => { if (!ch.blocked) { ch.blocked = why; ch.learning_reset = false } }
  const name = (lvl: Level, n: { name?: string; existing_id?: string } | undefined, fallback: string) =>
    `${LEVEL_TEXT[lvl]} „${(n?.name ?? '').trim() || n?.existing_id || fallback}“`

  function compare<N>(level: Level, node: string, id: string, b: N, s: N, defs: readonly EditDef<N>[]): EditChange[] {
    const out: EditChange[] = []
    const sr = asRec(s), br = asRec(b)
    for (const k of Object.keys(sr)) {
      if (EDIT_KNOWN_KEYS[level].indexOf(k) >= 0 || editCanon(sr[k]) === editCanon(br[k])) continue
      warnings.push(`${name(level, s as { name?: string; existing_id?: string }, node)}: „${k}“ kennt das Bearbeiten nicht, das wird nicht an Meta gesendet.`)
    }
    for (const def of defs) {
      const before = def.get(b, baseline)
      const after = def.get(s, spec)
      const nb = def.norm ? def.norm(before) : before
      const na = def.norm ? def.norm(after) : after
      if (editCanon(nb) === editCanon(na)) continue
      const learning = typeof def.learning === 'function' ? def.learning(before, after) : def.learning
      const fs = fieldSpec(def.key)
      out.push({
        level, id, node, field: def.key, label_key: fs ? fs.labelKey : `${K}.field.${def.key.replace(/\./g, '_')}`,
        before, after, learning, learning_reset: learning === 'neu', ...(def.creative ? { creative: true } : {}),
      })
    }
    return out
  }
  const lockOrArchive = (level: Level, ch: EditChange, status: string | undefined): boolean => {
    if (EDIT_LOCKS[level].indexOf(ch.field) >= 0) { block(ch, EDIT_BLOCK_TEXT.lock); return true }
    if (isArchived(status)) { block(ch, EDIT_BLOCK_TEXT.archiviert); return true }
    if (ch.field.slice(-'.status'.length) === '.status' && ch.after !== 'ACTIVE' && ch.after !== 'PAUSED') { block(ch, EDIT_BLOCK_TEXT.nieLoeschen); return true }
    return false
  }
  const cbo = bc.budget_level === 'campaign'
  const summary = (label: string, list: EditChange[]) => {
    const live = list.filter(c => !c.blocked)
    if (live.some(c => c.learning_reset)) warnings.push(`${label}: Die Lernphase startet neu.`)
    else if (live.some(c => c.learning === 'moeglich' && /budget|bid_amount|roas/.test(c.field))) warnings.push(`${label}: Budget oder Gebot ändert sich um mehr als 20 %. Die Lernphase kann neu starten.`)
    if (live.some(c => c.field.slice(-'.status'.length) === '.status' && c.after === 'ACTIVE')) warnings.push(`${label} wird eingeschaltet. War es 7 Tage oder länger pausiert, startet die Lernphase neu.`)
  }

  // ── Kampagne ──
  if (sc.existing_id !== bc.existing_id) warnings.push('Der Entwurf gehört zu einer anderen Kampagne als der Ausgangsstand. Bitte neu laden.')
  else {
    const list = compare<CampaignDraft>('campaign', 'campaign', bc.existing_id, bc, sc, CAMPAIGN_EDIT)
    for (const ch of list) {
      if (lockOrArchive('campaign', ch, bc.meta_status)) continue
      if (ch.field === 'campaign.daily_budget_cents' || ch.field === 'campaign.lifetime_budget_cents') {
        const other = ch.field === 'campaign.daily_budget_cents' ? bc.lifetime_budget_cents : bc.daily_budget_cents
        if (!cbo) block(ch, EDIT_BLOCK_TEXT.keinKampagnenbudget)
        else if (ch.after === null) block(ch, EDIT_BLOCK_TEXT.budgetEntfernen)
        else if ((other ?? 0) > 0) block(ch, EDIT_BLOCK_TEXT.budgetart)
      } else if (ch.field === 'campaign.bid_strategy') {
        if (!cbo) block(ch, EDIT_BLOCK_TEXT.keinKampagnenbudget)
        else if (bc.bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS') block(ch, EDIT_BLOCK_TEXT.roasFest)
      } else if (ch.field === 'campaign.is_adset_budget_sharing_enabled') {
        if (ch.after === true) block(ch, EDIT_BLOCK_TEXT.teilenEin)
      } else if (ch.field === 'campaign.budget_schedule_specs') {
        if (entfernteBudgetZeitraeume(bc.budget_schedule_specs, sc.budget_schedule_specs).length) block(ch, EDIT_BLOCK_TEXT.budgetplanungEntfernen)
        else if (!(cbo && (bc.daily_budget_cents ?? 0) > 0)) block(ch, EDIT_BLOCK_TEXT.budgetplanungTages)
      }
    }
    changes.push(...list)
    summary(name('campaign', sc, bc.existing_id), list)
  }

  // ── Anzeigengruppen ──
  const bAdsets = baseline.adsets ?? []
  const sAdsets = spec.adsets ?? []
  for (const s of sAdsets) {
    if (!s.existing_id) { warnings.push(`Neue ${name('adset', s, s.key)} wird beim Bearbeiten nicht angelegt. Neues über „Hinzufügen“ im Assistenten anlegen.`); continue }
    const b = bAdsets.find(x => x.existing_id === s.existing_id)
    if (!b) { warnings.push(`${name('adset', s, s.key)} ist nicht im Ausgangsstand. Bitte neu laden.`); continue }
    const list = compare<AdsetDraft>('adset', s.key, s.existing_id, b, s, ADSET_EDIT)
    for (const ch of list) {
      if (lockOrArchive('adset', ch, b.meta_status)) continue
      switch (ch.field) {
        case 'adset.daily_budget_cents':
        case 'adset.lifetime_budget_cents': {
          const other = ch.field === 'adset.daily_budget_cents' ? b.lifetime_budget_cents : b.daily_budget_cents
          if (cbo) block(ch, EDIT_BLOCK_TEXT.budgetAufKampagne)
          else if (ch.after === null) block(ch, EDIT_BLOCK_TEXT.budgetEntfernen)
          else if ((other ?? 0) > 0) block(ch, EDIT_BLOCK_TEXT.budgetart)
          break
        }
        case 'adset.bid_strategy':
          if (cbo) block(ch, EDIT_BLOCK_TEXT.gebotAufKampagne)
          else if (b.bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS') block(ch, EDIT_BLOCK_TEXT.roasFest)
          break
        case 'adset.promoted_object.pixel_id':
        case 'adset.promoted_object.custom_event_type':
          if (b.promoted_object?.custom_conversion_id) block(ch, EDIT_BLOCK_TEXT.customConversion)
          else if (!isConversionGoal(s.optimization_goal)) block(ch, EDIT_BLOCK_TEXT.conversionNurWebsite)
          break
        case 'adset.optimization_goal': {
          const goal = ch.after as OptGoal
          if (goalsFor(sc.objective, b.destination).indexOf(goal) < 0) block(ch, EDIT_BLOCK_TEXT.zielPasstNicht)
          else if (billingFor(goal).indexOf(b.billing_event) < 0) block(ch, EDIT_BLOCK_TEXT.abrechnungPasstNicht)
          else warnings.push(`${name('adset', s, s.key)}: Das Performance-Ziel lässt Meta nach der ersten Auslieferung oft nicht mehr ändern.`)
          break
        }
        case 'adset.adset_schedule':
          if ((s.adset_schedule ?? []).length && !(cbo ? (bc.lifetime_budget_cents ?? 0) > 0 : (s.lifetime_budget_cents ?? 0) > 0)) block(ch, EDIT_BLOCK_TEXT.zeitplanLaufzeit)
          break
        case 'adset.daily_min_spend_target_cents':
        case 'adset.daily_spend_cap_cents':
          if (ch.after !== null && !(cbo && (bc.daily_budget_cents ?? 0) > 0)) block(ch, EDIT_BLOCK_TEXT.gruppenLimitsCbo)
          break
        case 'adset.lifetime_min_spend_target_cents':
        case 'adset.lifetime_spend_cap_cents':
          if (ch.after !== null && !(cbo && (bc.lifetime_budget_cents ?? 0) > 0)) block(ch, EDIT_BLOCK_TEXT.gruppenLimitsCboLaufzeit)
          // Entfernen (Metas „unbegrenzt“) ist nur für das Tageslimit dokumentiert
          else if (ch.after === null && ch.field === 'adset.lifetime_spend_cap_cents') block(ch, EDIT_BLOCK_TEXT.laufzeitLimitEntfernen)
          break
        case 'adset.budget_schedule_specs':
          if (entfernteBudgetZeitraeume(b.budget_schedule_specs, s.budget_schedule_specs).length) block(ch, EDIT_BLOCK_TEXT.budgetplanungEntfernen)
          else if (cbo || !((b.daily_budget_cents ?? 0) > 0)) block(ch, EDIT_BLOCK_TEXT.budgetplanungTages)
          break
      }
    }
    changes.push(...list)
    summary(name('adset', s, s.key), list)
  }
  for (const b of bAdsets) {
    if (!sAdsets.some(x => x.existing_id === b.existing_id)) {
      warnings.push(`${name('adset', b, b.key)} fehlt im Entwurf. Bei Meta bleibt sie unverändert (nie löschen); zum Stoppen auf „Pausiert“ stellen.`)
    }
  }

  // ── Anzeigen ──
  const bAds = baseline.ads ?? []
  const sAds = spec.ads ?? []
  for (const s of sAds) {
    if (!s.existing_id) { warnings.push(`Neue ${name('ad', s, s.key)} wird beim Bearbeiten nicht angelegt. Neue Anzeigen über „Anzeigen hinzufügen“ anlegen.`); continue }
    const b = bAds.find(x => x.existing_id === s.existing_id)
    if (!b) { warnings.push(`${name('ad', s, s.key)} ist nicht im Ausgangsstand. Bitte neu laden.`); continue }
    const bSet = adsetByKey(baseline, b.adset_key)
    const sSet = adsetByKey(spec, s.adset_key)
    // Verschieben geht bei Meta nicht: dann nichts an dieser Anzeige senden (nicht in der alten Gruppe ändern)
    const verschoben = !!bSet && (!sSet || bSet.existing_id !== sSet.existing_id)
    if (verschoben) {
      warnings.push(`${name('ad', s, s.key)}: Anzeigen lassen sich nicht in eine andere Anzeigengruppe verschieben. Dafür „Duplizieren“ in eine vorhandene Anzeigengruppe nutzen.`)
    }
    const list = compare<AdDraft>('ad', s.key, s.existing_id, b, s, AD_EDIT)
    const creative = list.filter(c => c.creative)
    for (const ch of list) {
      if (verschoben) { block(ch, EDIT_BLOCK_TEXT.verschieben); continue }
      if (lockOrArchive('ad', ch, b.meta_status)) continue
      if (!ch.creative) continue
      if (b.source?.aus_beitrag) block(ch, EDIT_BLOCK_TEXT.beitrag)
      else if (b.source?.partner_unbekannt) block(ch, EDIT_BLOCK_TEXT.partnerUnbekannt)
    }
    if (tausch === 'ersetzen' && creative.some(c => !c.blocked)) {
      // Meta: Asset-Feed-Creatives lassen sich beim Ersetzen nicht in einen anderen Typ wechseln.
      // Ausgangstyp wie bei Meta gelesen (Import), sonst aus Texten/Medien abgeleitet.
      const mb = b.source?.creative_mode ?? creativeMode(b, bSet?.placements)
      const ms = creativeMode(s, sSet?.placements ?? bSet?.placements)
      if (mb !== ms && (isAssetFeedMode(mb) || isAssetFeedMode(ms))) for (const ch of creative) block(ch, EDIT_BLOCK_TEXT.ersetzenModus)
    }
    changes.push(...list)
    const label = name('ad', s, s.key)
    if (creative.some(c => !c.blocked)) {
      warnings.push(tausch === 'ersetzen'
        ? `${label}: Das Werbemittel wird in der bestehenden Anzeige ersetzt. Meta prüft die Anzeige neu, die Lernphase der Anzeigengruppe startet neu.`
        : `${label}: Es entsteht eine neue Anzeige mit dem geänderten Werbemittel, die alte wird pausiert (nie gelöscht). Die Lernphase der Anzeigengruppe startet neu.`)
    } else summary(label, list)
  }
  for (const b of bAds) {
    if (!sAds.some(x => x.existing_id === b.existing_id)) {
      warnings.push(`${name('ad', b, b.key)} fehlt im Entwurf. Bei Meta bleibt sie unverändert (nie löschen); zum Stoppen auf „Pausiert“ stellen.`)
    }
  }
  return { changes, warnings }
}

/** Zusätzliche Prüfungen der Bearbeiten-Felder, die validateDraft (nur neue Knoten) nicht kennt. */
export function validateEditFields(spec: DraftSpec): DraftIssue[] {
  const out: DraftIssue[] = []
  const push = (level: Level, node: string, field: string, code: IssueCode, params?: Record<string, string | number>) =>
    out.push({ level, node, field, severity: 'error', code, messageKey: issueMessageKey(code), ...(params ? { params } : {}) })
  const c = spec?.campaign
  if (!c) return out
  const schedCheck = (level: Level, node: string, field: string, list: BudgetScheduleSpec[] | undefined) => {
    if ((list ?? []).length > LIMITS.budgetSchedulesMax) { push(level, node, field, 'budget_schedule_invalid', { max: LIMITS.budgetSchedulesMax }); return }
    for (const z of list ?? []) {
      const ts = unixSekunden(z?.time_start), te = unixSekunden(z?.time_end)
      const ok = ts !== null && te !== null && te - ts >= 3 * 3600
        && (z.budget_value_type === 'ABSOLUTE' || z.budget_value_type === 'MULTIPLIER') && typeof z.budget_value === 'number' && z.budget_value > 0
      if (!ok) { push(level, node, field, 'budget_schedule_invalid', { max: LIMITS.budgetSchedulesMax }); return }
    }
  }
  const money = (level: Level, node: string, field: string, v: number | undefined, max: number) => {
    if (typeof v === 'number' && v > max && v < META_UNBEGRENZT_AB) push(level, node, field, 'budget_high', { max })
  }
  money('campaign', 'campaign', 'campaign.daily_budget_cents', c.daily_budget_cents, LIMITS.dailyBudgetMaxCents)
  money('campaign', 'campaign', 'campaign.lifetime_budget_cents', c.lifetime_budget_cents, LIMITS.lifetimeBudgetMaxCents)
  const cap = c.spend_cap_cents
  if (typeof cap === 'number' && cap > 0 && cap < META_UNBEGRENZT_AB) {
    if (cap < LIMITS.spendCapMinCents) push('campaign', 'campaign', 'campaign.spend_cap_cents', 'spend_cap_low', { min: LIMITS.spendCapMinCents })
    else if (cap > LIMITS.spendCapMaxCents) push('campaign', 'campaign', 'campaign.spend_cap_cents', 'spend_cap_high', { max: LIMITS.spendCapMaxCents })
  }
  schedCheck('campaign', 'campaign', 'campaign.budget_schedule_specs', c.budget_schedule_specs)
  for (const a of spec.adsets ?? []) {
    money('adset', a.key, 'adset.daily_budget_cents', a.daily_budget_cents, LIMITS.dailyBudgetMaxCents)
    money('adset', a.key, 'adset.lifetime_budget_cents', a.lifetime_budget_cents, LIMITS.lifetimeBudgetMaxCents)
    for (const blk of a.adset_schedule ?? []) {
      const s = blk?.start_minute, e = blk?.end_minute
      const ok = typeof s === 'number' && typeof e === 'number' && s >= 0 && e <= 1440 && s % 60 === 0 && e % 60 === 0 && e - s >= 60
        && Array.isArray(blk.days) && blk.days.length > 0 && blk.days.every(d => d >= 0 && d <= 6)
      if (!ok) { push('adset', a.key, 'adset.adset_schedule', 'schedule_invalid'); break }
    }
    const order = (min: number | undefined, max: number | undefined, field: string) => {
      if (typeof min === 'number' && typeof max === 'number' && min > 0 && max > 0 && max < META_UNBEGRENZT_AB && min > max) push('adset', a.key, field, 'spend_limits_order')
    }
    order(a.daily_min_spend_target_cents, a.daily_spend_cap_cents, 'adset.daily_spend_cap_cents')
    order(a.lifetime_min_spend_target_cents, a.lifetime_spend_cap_cents, 'adset.lifetime_spend_cap_cents')
    schedCheck('adset', a.key, 'adset.budget_schedule_specs', a.budget_schedule_specs)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. meta-builder: Anfrage-/Antwort-Typen
// ═══════════════════════════════════════════════════════════════════════════

export const DRAFT_STATUSES = ['draft', 'validated', 'creating', 'partial', 'created', 'failed', 'discarded'] as const
export type DraftStatus = typeof DRAFT_STATUSES[number]
export const DRAFT_KINDS = ['new_campaign', 'add_adsets', 'add_ads', 'edit'] as const
export type DraftKind = typeof DRAFT_KINDS[number]

export interface DraftMetaIds {
  campaign?: string
  adsets?: Record<string, string>
  creatives?: Record<string, string>
  ads?: Record<string, string>
  media?: Record<string, { image_hash?: string; video_id?: string; thumbnail_hash?: string }>
  /**
   * Fingerabdruck je angelegtem Knoten beim POST ('campaign', 'adset:<key>',
   * 'creative:<key>', 'ad:<key>'). resume lehnt ab, wenn sich ein schon angelegter
   * Knoten im Entwurf seitdem geändert hat.
   */
  hashes?: Record<string, string>
  /** Bearbeiten-Entwurf (kind 'edit'): Ausgangsstand bei Meta, schreibt nur meta-builder */
  edit?: EditBaseline
}
/** Ausgangsstand eines Bearbeiten-Entwurfs (edit_load; nach edit_apply frisch von Meta). */
export interface EditBaseline {
  /** geladen über diese Ebene/ID (Anzeigengruppe/Anzeige: Kampagne und Gruppe kommen mit) */
  level: Level
  id: string
  baseline: DraftSpec
  loaded_at: string
  graph_version?: string
  applied_at?: string
}
export interface DraftLastError { step: string; key?: string; code?: number | string; subcode?: number; user_msg?: string }

/** Struktur wie metaLint.ts LintIssue (bewusst ohne Import gespiegelt). */
export interface BuilderLintIssue {
  severity: 'blocker' | 'warn' | 'manual'
  rule: string
  node?: string
  field: string
  messageKey: string
  match?: string
  params?: Record<string, string | number>
}
export interface GuardrailInfo {
  limitEur: number
  activeEur: number
  afterEur: number
  rateEurPerUsd: number
  ok: boolean
}
export interface MetaFieldIssue {
  /** FieldSpec.key aus apiPathToFieldKey, null = keinem Feld zuordenbar */
  field_key: string | null
  title: string
  user_msg: string
  code?: number
  subcode?: number
}
export interface MetaLevelResult {
  level: Level
  /** 'campaign' oder key */
  key: string
  ok: boolean
  /** Grund, wenn nicht geprüft (z. B. 'app_dev_mode', 'no_proxy_campaign', 'call_cap') */
  skipped?: string
  issues: MetaFieldIssue[]
}
export interface DraftValidation {
  ok: boolean
  local: DraftIssue[]
  lint: BuilderLintIssue[]
  meta: MetaLevelResult[]
  guardrail: GuardrailInfo | null
  validated_at: string
}

export interface MetaDraftRow {
  id: string
  name: string
  kind: DraftKind
  template_key: string | null
  spec: DraftSpec
  status: DraftStatus
  validation: DraftValidation | null
  lint: BuilderLintIssue[] | null
  meta_ids: DraftMetaIds
  target_campaign_id: string | null
  target_adset_id: string | null
  last_error: DraftLastError | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type MediaKind = 'image' | 'video'
export type MediaAspect = '4:5' | '9:16' | '1:1' | '1.91:1' | 'other'
export type MediaMetaStatus = 'pending' | 'uploading' | 'processing' | 'ready' | 'error'
export const MEDIA_ASPECT_RATIOS: Readonly<Record<Exclude<MediaAspect, 'other'>, number>> = {
  '4:5': 0.8, '9:16': 0.5625, '1:1': 1, '1.91:1': 1.91,
}
/** Toleranz der Seitenverhältnisse (Ads Guide: Feed 3 %, Stories 1 %) */
export const MEDIA_ASPECT_TOLERANCE: Readonly<Record<Exclude<MediaAspect, 'other'>, number>> = {
  '4:5': 0.03, '9:16': 0.01, '1:1': 0.03, '1.91:1': 0.03,
}
export function aspectOf(width: number, height: number): MediaAspect {
  if (!(width > 0) || !(height > 0)) return 'other'
  const r = width / height
  for (const k of Object.keys(MEDIA_ASPECT_RATIOS) as Array<Exclude<MediaAspect, 'other'>>) {
    if (Math.abs(r - MEDIA_ASPECT_RATIOS[k]) / MEDIA_ASPECT_RATIOS[k] <= MEDIA_ASPECT_TOLERANCE[k]) return k
  }
  return 'other'
}
export interface MetaMediaRow {
  id: string
  kind: MediaKind
  storage_path: string
  public_url: string | null
  aspect: MediaAspect
  width: number | null
  height: number | null
  bytes: number | null
  sha256: string
  meta_image_hash: string | null
  meta_video_id: string | null
  thumbnail_hash: string | null
  meta_status: MediaMetaStatus
  meta_error: string | null
  ai_generated: boolean
  eu_band_confirmed: boolean
  ki_label_confirmed: boolean
  source: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface BuilderSettings {
  builder_enabled: boolean
  dsa_beneficiary: string | null
  dsa_payor: string | null
  default_page_id: string | null
  default_ig_user_id: string | null
  default_pixel_id: string | null
  default_link: string | null
  max_account_daily_budget: number | null
}
export interface MetaUsageInfo {
  accUtilPct: number | null
  resetSec: number | null
  tier: string | null
  buc?: unknown
}

export const BUILDER_MODES = [
  'catalog', 'audience_eligibility', 'estimate', 'creative_details', 'pixel_status', 'leadgen_lookup',
  'usage', 'validate', 'import', 'media_status', 'discard',
  'preview', 'media_upload', 'create', 'resume', 'activate_draft', 'duplicate', 'leadform_create',
  'edit_load', 'edit_diff', 'edit_apply', 'bulk',
  // Runde 2: Werbemittel komplett
  'posts_list', 'preview_alle', 'ad_vorschau_link', 'video_vorschaubilder', 'video_vorschaubild', 'video_untertitel',
] as const
export type BuilderMode = typeof BUILDER_MODES[number]
/**
 * Brauchen ad_settings.builder_enabled + META_WRITES_DISABLED != '1' (+ Schreibrecht).
 * preview_alle wie preview (lädt fehlende Medien hoch), video_vorschaubild (Bild-Upload), video_untertitel (SRT-Upload).
 */
export const BUILDER_WRITE_MODES: readonly BuilderMode[] = [
  'preview', 'media_upload', 'create', 'resume', 'activate_draft', 'duplicate', 'leadform_create', 'edit_apply', 'bulk',
  'preview_alle', 'video_vorschaubild', 'video_untertitel',
]
export const BUILDER_ERROR_CODES = [
  'builder_disabled', 'writes_disabled', 'forbidden', 'not_found', 'invalid_request', 'validation_failed',
  'lint_blocked', 'guardrail_exceeded', 'app_dev_mode', 'rate_limited', 'meta_error', 'stale_validation',
  'lease_busy', 'unsupported', 'media_not_ready', 'housing_required', 'created_changed', 'edit_conflict',
] as const
export type BuilderErrorCode = typeof BUILDER_ERROR_CODES[number]
export interface BuilderErrorBody { error: string; hint?: string; code?: BuilderErrorCode | string; data?: unknown }

export interface LeadFormQuestion {
  type: 'FULL_NAME' | 'FIRST_NAME' | 'LAST_NAME' | 'EMAIL' | 'PHONE' | 'CITY' | 'COUNTRY' | 'CUSTOM'
  key?: string
  label?: string
  options?: Array<{ value: string; key: string }>
}
export interface LeadFormSpec {
  name: string
  locale?: 'de_DE' | 'en_US'
  privacy_policy_url: string
  privacy_link_text?: string
  questions: LeadFormQuestion[]
  intro_headline?: string
  intro_text?: string
  thank_you_title?: string
  thank_you_body?: string
  thank_you_url?: string
  /** „Höhere Absicht" (Überprüfungsschritt vor dem Absenden) */
  higher_intent?: boolean
}

export interface CatalogRequest { refresh?: boolean }
export interface CatalogResponse {
  graph_version: string
  account: {
    id: string; name?: string; currency: string; timezone_name?: string; account_status?: number
    default_dsa_beneficiary?: string | null; default_dsa_payor?: string | null
  }
  pixels: Array<{ id: string; name: string; last_fired_time?: string | null; is_unavailable?: boolean }>
  custom_conversions: Array<{ id: string; name: string; custom_event_type?: string; pixel_id?: string }>
  custom_audiences: Array<{ id: string; name: string; subtype?: string; approximate_count_lower_bound?: number; approximate_count_upper_bound?: number; sac_eligible?: boolean | null }>
  pages: Array<{ id: string; name: string }>
  instagram_accounts: Array<{ id: string; username?: string; name?: string }>
  lead_forms: Array<{ id: string; name: string; status?: string; locale?: string; page_id?: string }>
  dsa_recommendations: string[]
  token: { scopes: string[]; expires_at?: number | null; is_valid?: boolean }
  lint_context: { forbidden_names: string[] }
  settings: BuilderSettings
  usage?: MetaUsageInfo
}
export interface AudienceEligibilityRequest { ids: string[]; countries?: string[] }
export interface AudienceEligibilityResponse { items: Array<{ id: string; sac_eligible: boolean | null; reason?: string }> }
export interface EstimateRequest { objective: Objective; special_ad_categories?: SpecialCat[]; adset: AdsetDraft }
export interface EstimateResponse { users_lower?: number | null; users_upper?: number | null; estimate_ready?: boolean; raw?: unknown }
export interface CreativeDetailsRequest { ad_ids: string[] }
export interface CreativeDetailsResponse {
  items: Array<{
    ad_id: string; creative_id?: string; url_tags: string | null; link: string | null; cta_type: string | null
    asset_link_urls: string[]; url_tags_check: { ok: boolean; problems: string[] }
  }>
}
export interface PixelStatusRequest { pixel_id: string }
export interface PixelStatusResponse { id: string; name?: string; last_fired_time?: string | null; is_unavailable?: boolean; matches_hp_pixel: boolean }
export interface LeadgenLookupRequest { ids: string[] }
export interface LeadgenLookupResponse {
  items: Array<{ id: string; ad_id?: string; adset_id?: string; campaign_id?: string; form_id?: string; created_time?: string }>
  missing: string[]
}
export interface UsageRequest { verbose?: boolean }
export type UsageResponse = MetaUsageInfo
export interface ValidateRequest { draft_id: string; levels?: Level[] }
export type ValidateResponse = DraftValidation
export interface ImportRequest { level: Level; id: string }
export interface ImportResponse { spec: DraftSpec; warnings: string[]; source: { level: Level; id: string } }
export interface PreviewRequest { draft_id: string; ad_key: string; formats: PreviewFormat[] }
export interface PreviewResponse { previews: Array<{ format: PreviewFormat; body: string | null; error?: string }> }
export interface MediaUploadRequest {
  storage_path: string
  kind: MediaKind
  aspect: MediaAspect
  ai_generated: boolean
  eu_band_confirmed: boolean
  ki_label_confirmed: boolean
  name?: string
}
export interface MediaUploadResponse { media: MetaMediaRow; deduplicated?: boolean }
export interface MediaStatusRequest { id: string }
export interface MediaStatusResponse { media: MetaMediaRow }
export interface CreateRequest {
  draft_id: string
  force_lint_reason?: string
  /** Nur Admin, mindestens 10 Zeichen: Neues bewusst in einer Kampagne ohne Sonderkategorie Wohnen anlegen */
  housing_override_reason?: string
}
export interface CreateResponse {
  status: DraftStatus
  done_steps: string[]
  /** nächster Schritt; null = fertig. Client ruft resume, solange next != null */
  next: string | null
  meta_ids: DraftMetaIds
  error?: BuilderErrorBody
}
export type ResumeRequest = CreateRequest
export type ResumeResponse = CreateResponse
export interface ActivateDraftRequest { draft_id: string; levels: Level[]; confirm: true }
export interface ActivateDraftResponse {
  activated: Array<{ level: Level; id: string }>
  guardrail: GuardrailInfo
  /** Von diesem Entwurf angelegt, aber nicht mehr im Entwurf: bleibt pausiert */
  skipped?: Array<{ level: Level; key: string; id: string }>
}
/**
 * Duplizieren wie im Werbeanzeigenmanager: in die ursprüngliche, eine vorhandene oder eine neue
 * Kampagne (Anzeigengruppen) bzw. Anzeigengruppe (Anzeigen). Kopien immer PAUSED, Name + " - Kopie".
 * Kampagne: art 'original' oder 'neu' (beides = neue Kampagne). Anzeigengruppe: 'vorhanden' braucht
 * campaign_id, 'neu' legt eine Kopie der Kampagne ohne Inhalt an. Anzeige: 'vorhanden' braucht
 * adset_id, 'neu' legt eine leere Kopie der Anzeigengruppe an (in campaign_id oder der eigenen Kampagne).
 * 'neu' bei Anzeigengruppen/Anzeigen: alle Objekte aus derselben Kampagne bzw. Anzeigengruppe (sonst 400).
 * Kopie, die in einer Kampagne ohne Sonderkategorie Wohnen landet: 409 housing_required (Admin mit Begründung).
 */
export type DuplicateZielArt = 'original' | 'vorhanden' | 'neu'
export interface DuplicateZiel { art: DuplicateZielArt; campaign_id?: string; adset_id?: string }
export interface DuplicateRequest {
  level: Level
  ids?: string[]
  ziel?: DuplicateZiel
  /** 1 bis 5 Kopien je Objekt (Standard 1) */
  kopien?: number
  /** Kampagne/Anzeigengruppe mit Inhalt kopieren (Standard true) */
  deep?: boolean
  rename_suffix?: string
  /** Nur Admin, mindestens 10 Zeichen: bewusst in bzw. aus einer Kampagne ohne Sonderkategorie Wohnen kopieren */
  housing_override_reason?: string
  /** alt: ein Objekt */
  id?: string
  /** alt: Anzeige in diese Anzeigengruppe */
  target_adset_id?: string
}
export interface DuplicateResponse {
  level: Level
  copies: Array<{ source_id: string; copied_id: string; kopie: number }>
  failed: Array<{ source_id: string; kopie: number; error: string }>
  /** erste Kopie (alt) */
  copied_id?: string
  /** bei ziel.art 'neu': neu angelegte Kampagne bzw. Anzeigengruppe */
  neue_kampagne_id?: string
  neue_anzeigengruppe_id?: string
  warnings?: string[]
}

// ── Bearbeiten (edit_load / edit_diff / edit_apply) ─────────────────────────
export interface EditLoadRequest {
  level: Level
  id: string
  /** true = offene Änderungen verwerfen und frisch von Meta laden */
  neu_laden?: boolean
}
export interface EditLoadResponse {
  draft_id: string
  /** Entwurf (kind 'edit'): alle Knoten mit existing_id, hp.creative_tausch gesetzt */
  spec: DraftSpec
  /** Feld-Schlüssel, die Meta nach dem Anlegen nicht mehr ändert (editLocks) */
  locks: string[]
  warnings: string[]
  /** Zeitpunkt des Ausgangsstands */
  baseline_at: string
  /** true = bestehender Bearbeiten-Entwurf wiederverwendet */
  reused: boolean
}
export interface EditDiffRequest { draft_id: string }
export interface EditDiffResponse {
  changes: EditChange[]
  warnings: string[]
  /** Budget-Leitplanke nach allen Änderungen (null = keine Budget-Erhöhung/Aktivierung oder nicht lesbar) */
  guardrail: GuardrailInfo | null
  creative_tausch: CreativeTausch
  /** Fehler in geänderten Feldern (validateDraft/validateEditFields), blockieren edit_apply */
  issues: DraftIssue[]
  /** Text-Regeln für geänderte Werbemittel */
  lint: BuilderLintIssue[]
  /** Felder, die bei Meta seit dem Laden geändert wurden (edit_apply überspringt sie) */
  conflicts: Array<{ level: Level; id: string; field: string; live: unknown }>
}
export interface EditApplyRequest {
  draft_id: string
  confirm: true
  /** nur Admin, mindestens 10 Zeichen: Lint-Blocker im neuen Werbemittel bewusst übergehen */
  force_lint_reason?: string
  /** nur Admin, mindestens 10 Zeichen: neue Anzeige in Kampagne ohne Sonderkategorie Wohnen */
  housing_override_reason?: string
}
export interface EditApplyResponse {
  applied: EditChange[]
  failed: Array<EditChange & { error: string }>
  readback: {
    /** frischer Stand von Meta (neuer Ausgangsstand des Entwurfs) */
    spec: DraftSpec
    warnings: string[]
    guardrail: GuardrailInfo | null
    /** Werbemittel-Tausch „neue Anzeige“: alt -> neu */
    neue_anzeigen: Array<{ alt_id: string; neu_id: string; aktiv: boolean }>
  }
}

// ── Massenbearbeitung (bulk) ────────────────────────────────────────────────
export interface BulkItem { level: Level; id: string }
export interface BulkPatch {
  status?: EditableStatus
  /** neues Tagesbudget (nur Objekte mit eigenem Tagesbudget) */
  daily_budget_cents?: number
  /** Budget um Prozent ändern, z. B. 10 oder -20 (Tages- oder Laufzeitbudget) */
  budget_prozent?: number
  /** Ende (Anzeigengruppe end_time, Kampagne stop_time), ISO */
  end_time?: string
  /** an den Namen anhängen */
  name_suffix?: string
}
export interface BulkRequest { items: BulkItem[]; patch: BulkPatch; confirm: true }
export interface BulkResult {
  level: Level
  id: string
  ok: boolean
  error?: string
  /** Hinweis, z. B. Lernphase bei Budget über 20 % */
  hinweis?: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}
export interface BulkResponse { results: BulkResult[]; guardrail: GuardrailInfo | null }
// ── Werbemittel komplett (Runde 2) ──────────────────────────────────────────
/** Beiträge der Seite bzw. des Instagram-Kontos für „Vorhandenen Beitrag verwenden“ (nur Lesen). */
export interface PostsListRequest {
  quelle: BeitragQuelle
  /** 1 bis 50, Standard 25 */
  limit?: number
  /** Standard: Seite aus den Werbe-Einstellungen */
  page_id?: string
  /** Standard: Instagram-Konto aus den Werbe-Einstellungen bzw. der Seite */
  instagram_user_id?: string
  /** Blättern: next aus der vorigen Antwort */
  after?: string
}
export interface PostsListItem {
  /** Facebook: „SeitenID_BeitragsID“ (object_story_id), Instagram: Medien-ID (source_instagram_media_id) */
  id: string
  quelle: BeitragQuelle
  text: string
  erstellt: string | null
  permalink: string | null
  bild_url: string | null
  /** z. B. added_photos, IMAGE, VIDEO, REELS, CAROUSEL_ALBUM */
  typ: string | null
  /** Meta: als Anzeige nutzbar (null = unbekannt) */
  bewerbbar: boolean | null
}
export interface PostsListResponse {
  quelle: BeitragQuelle
  page_id: string
  instagram_user_id: string | null
  items: PostsListItem[]
  /** Cursor für die nächste Seite (null = Ende) */
  next: string | null
  warnings: string[]
}
/**
 * Vorschau aller Platzierungen: Anzeige im Entwurf (draft_id + ad_key, generatepreviews bzw.
 * /{ad_id}/previews, wenn schon angelegt) oder laufende Anzeige ohne Entwurf (ad_id).
 */
export interface PreviewAlleRequest {
  draft_id?: string
  ad_key?: string
  ad_id?: string
  /** mehrsprachige Anzeige: Vorschau dieser Sprache (dynamic_asset_label) */
  sprache?: AdSprache
  /** nur diese Formate (Standard: previewFormatsFor) */
  formats?: PreviewFormat[]
}
export interface PreviewAlleItem { format: PreviewFormat; label_key: string; body: string | null; error?: string }
export interface PreviewAlleResponse {
  previews: PreviewAlleItem[]
  /** nicht passende Platzierungen (Anzeigengruppe spielt dort nicht aus, Format passt nicht) */
  uebersprungen: Array<{ format: PreviewFormat; label_key: string; grund: string }>
  /** Vorschau-iframes gelten bei Meta 24 Stunden */
  gueltig_bis: string
}
/** Teilbarer Vorschaulink einer bestehenden Anzeige (Feld preview_shareable_link). */
export interface AdVorschauLinkRequest { ad_id: string }
export interface AdVorschauLinkResponse { ad_id: string; name: string | null; link: string | null; hinweis: string }
/** Metas Vorschaubild-Vorschläge eines Videos (GET /{video_id}/thumbnails, nur Lesen). */
export interface VideoVorschaubilderRequest { media_id: string }
export interface VideoThumbnail { uri: string; width: number | null; height: number | null; is_preferred: boolean }
export interface VideoVorschaubilderResponse { media_id: string; video_id: string | null; vorschaubilder: VideoThumbnail[] }
/** Vorschaubild eines Videos aus Metas Vorschlägen wählen (Bild wird in die Bildbibliothek geladen). */
export interface VideoVorschaubildRequest {
  /** meta_media.id des Videos */
  media_id: string
  /** uri aus media_status vorschaubilder */
  uri: string
  /** true = auch als Standard-Vorschaubild des Videos speichern (meta_media.thumbnail_hash) */
  als_standard?: boolean
}
export interface VideoVorschaubildResponse { media_id: string; thumbnail_hash: string; uri: string; als_standard: boolean }
/** Untertitel (SRT) zu einem Video hochladen (POST /{video_id}/captions; API-Pfad für Werbekonto-Videos ungeprüft). */
export type UntertitelSprache = 'de_DE' | 'en_US' | 'en_GB'
export const UNTERTITEL_SPRACHEN: readonly UntertitelSprache[] = ['de_DE', 'en_US', 'en_GB']
export interface VideoUntertitelRequest {
  /** meta_media.id des Videos */
  media_id: string
  /** SRT-Datei im Bucket ad-creatives */
  storage_path: string
  sprache: UntertitelSprache
  /** als Standard-Untertitel setzen (default_locale) */
  standard?: boolean
}
export interface VideoUntertitelResponse { media_id: string; video_id: string; sprache: UntertitelSprache; ok: boolean; hinweis?: string }

export interface LeadformCreateRequest { page_id?: string; spec: LeadFormSpec }
export interface LeadformCreateResponse { form_id: string }
export interface DiscardRequest { draft_id: string }
export interface DiscardResponse { status: 'discarded' }

export interface BuilderRequestMap {
  catalog: CatalogRequest
  audience_eligibility: AudienceEligibilityRequest
  estimate: EstimateRequest
  creative_details: CreativeDetailsRequest
  pixel_status: PixelStatusRequest
  leadgen_lookup: LeadgenLookupRequest
  usage: UsageRequest
  validate: ValidateRequest
  import: ImportRequest
  media_status: MediaStatusRequest
  discard: DiscardRequest
  preview: PreviewRequest
  media_upload: MediaUploadRequest
  create: CreateRequest
  resume: ResumeRequest
  activate_draft: ActivateDraftRequest
  duplicate: DuplicateRequest
  leadform_create: LeadformCreateRequest
  edit_load: EditLoadRequest
  edit_diff: EditDiffRequest
  edit_apply: EditApplyRequest
  bulk: BulkRequest
  posts_list: PostsListRequest
  preview_alle: PreviewAlleRequest
  ad_vorschau_link: AdVorschauLinkRequest
  video_vorschaubilder: VideoVorschaubilderRequest
  video_vorschaubild: VideoVorschaubildRequest
  video_untertitel: VideoUntertitelRequest
}
export interface BuilderResponseMap {
  catalog: CatalogResponse
  audience_eligibility: AudienceEligibilityResponse
  estimate: EstimateResponse
  creative_details: CreativeDetailsResponse
  pixel_status: PixelStatusResponse
  leadgen_lookup: LeadgenLookupResponse
  usage: UsageResponse
  validate: ValidateResponse
  import: ImportResponse
  media_status: MediaStatusResponse
  discard: DiscardResponse
  preview: PreviewResponse
  media_upload: MediaUploadResponse
  create: CreateResponse
  resume: ResumeResponse
  activate_draft: ActivateDraftResponse
  duplicate: DuplicateResponse
  leadform_create: LeadformCreateResponse
  edit_load: EditLoadResponse
  edit_diff: EditDiffResponse
  edit_apply: EditApplyResponse
  bulk: BulkResponse
  posts_list: PostsListResponse
  preview_alle: PreviewAlleResponse
  ad_vorschau_link: AdVorschauLinkResponse
  video_vorschaubilder: VideoVorschaubilderResponse
  video_vorschaubild: VideoVorschaubildResponse
  video_untertitel: VideoUntertitelResponse
}
export type BuilderRequest<M extends BuilderMode = BuilderMode> = M extends BuilderMode ? { mode: M } & BuilderRequestMap[M] : never
export type BuilderResponse<M extends BuilderMode> = BuilderResponseMap[M]

// ═══════════════════════════════════════════════════════════════════════════
// 9. Alle i18n-Schlüssel (für npm run verify:meta)
// ═══════════════════════════════════════════════════════════════════════════

export function allLabelKeys(): string[] {
  const keys: string[] = []
  const add = (k: string | undefined) => { if (k && keys.indexOf(k) < 0) keys.push(k) }
  const addOpts = (list: readonly EnumOption[]) => { for (const o of list) { add(o.labelKey); add(o.hintKey); add(o.reasonKey) } }
  for (const l of LEVELS) add(`${K}.level.${l}`)
  addOpts(OBJECTIVE_OPTIONS); addOpts(SAC_OPTIONS); addOpts(BUYING_TYPE_OPTIONS); addOpts(BUDGET_LEVEL_OPTIONS)
  addOpts(DESTINATION_OPTIONS); addOpts(GOAL_OPTIONS); addOpts(BILLING_OPTIONS); addOpts(CUSTOM_EVENT_OPTIONS)
  addOpts(ATTRIBUTION_OPTIONS); addOpts(BID_OPTIONS); addOpts(PLATFORM_OPTIONS)
  for (const pl of PUBLISHER_PLATFORMS) addOpts(POSITION_OPTIONS[pl])
  addOpts(DEVICE_OPTIONS); addOpts(PLACEMENT_MODE_OPTIONS); addOpts(LOCATION_TYPE_OPTIONS)
  addOpts(BRAND_SAFETY_OPTIONS); addOpts(PUBLISHER_CATEGORY_OPTIONS); addOpts(CTA_OPTIONS)
  addOpts(AD_DESTINATION_KIND_OPTIONS); addOpts(AD_FORMAT_OPTIONS); addOpts(CREATIVE_FEATURE_OPTIONS)
  addOpts(ENROLL_OPTIONS); addOpts(PREVIEW_FORMAT_OPTIONS); addOpts(CREATIVE_MODE_OPTIONS)
  addOpts(STATUS_OPTIONS); addOpts(CREATIVE_TAUSCH_OPTIONS); addOpts(EDIT_LEARNING_OPTIONS)
  addOpts(AD_SETUP_OPTIONS); addOpts(BEITRAG_QUELLE_OPTIONS); addOpts(SPRACHE_OPTIONS); addOpts(CROP_KEY_OPTIONS)
  for (const f of FIELD_SPECS) { add(f.labelKey); add(f.helpKey); add(f.housing?.noteKey) }
  for (const c of ISSUE_CODES) add(issueMessageKey(c))
  for (const c of HOUSING_CHANGE_CODES) add(housingChangeKey(c))
  for (const k of HOUSING_NOTE_KEYS) add(k)
  add(TEMPLATES.plan_b.labelKey); add(TEMPLATES.plan_b.descriptionKey)
  add(`${K}.unknown`)
  return keys
}
