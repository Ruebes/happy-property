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
} as const

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
] as const
export type Destination = typeof DESTINATION_TYPES[number]
export const DESTINATION_OPTIONS: readonly EnumOption<Destination>[] = [
  opt('destination', 'WEBSITE', { recommended: true }),
  opt('destination', 'ON_AD'),
  opt('destination', 'WEBSITE_AND_PHONE_CALL', { unsupported: true }),
  opt('destination', 'PHONE_CALL', { unsupported: true }),
  opt('destination', 'WHATSAPP', { unsupported: true }),
  opt('destination', 'MESSENGER', { unsupported: true }),
  opt('destination', 'INSTAGRAM_DIRECT', { unsupported: true }),
  opt('destination', 'LEAD_FROM_IG_DIRECT', { unsupported: true }),
  opt('destination', 'LEAD_FROM_MESSENGER', { deprecated: true, unsupported: true }),
  opt('destination', 'APP', { unsupported: true }),
  opt('destination', 'ON_POST'),
  opt('destination', 'ON_VIDEO'),
  opt('destination', 'ON_PAGE', { unsupported: true }),
  opt('destination', 'ON_EVENT', { unsupported: true }),
  opt('destination', 'UNDEFINED'),
]
/**
 * Ziele, für die der Assistent Anzeigen (Creatives) bauen kann.
 * WEBSITE_AND_PHONE_CALL: nur neue Website-Anzeigen in BESTEHENDEN Anzeigengruppen
 * (laufendes Plan B); neue Anzeigengruppen mit diesem Ziel bleiben „unsupported“.
 */
export const AD_SUPPORTED_DESTINATIONS: readonly Destination[] = ['WEBSITE', 'ON_AD', 'UNDEFINED', 'ON_POST', 'ON_VIDEO', 'WEBSITE_AND_PHONE_CALL']

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
    MESSENGER: ['CONVERSATIONS', 'LINK_CLICKS', 'LEAD_GENERATION'],
    WHATSAPP: ['CONVERSATIONS', 'LINK_CLICKS'],
    WEBSITE: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
  },
  OUTCOME_LEADS: {
    WEBSITE: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'],
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
] as const
export type CtaType = typeof CTA_TYPES[number]
export type AdDestinationKind = 'website' | 'lead_form'
/** Sofortformular: NUR diese sechs (Meta-Lead-Ads-Doku). */
export const CTA_LEAD_FORM: readonly CtaType[] = ['SIGN_UP', 'LEARN_MORE', 'GET_QUOTE', 'APPLY_NOW', 'DOWNLOAD', 'SUBSCRIBE']
export const CTA_WEBSITE: readonly CtaType[] = [
  'BOOK_NOW', 'LEARN_MORE', 'SIGN_UP', 'GET_QUOTE', 'APPLY_NOW', 'CONTACT_US', 'REQUEST_TIME',
  'BOOK_A_CONSULTATION', 'MAKE_AN_APPOINTMENT', 'INQUIRE_NOW', 'GET_A_QUOTE', 'ASK_ABOUT_SERVICES',
  'ASK_FOR_MORE_INFO', 'GET_DETAILS', 'FIND_OUT_MORE', 'GET_IN_TOUCH', 'VISIT_WEBSITE', 'SEE_MORE',
  'GET_OFFER', 'SUBSCRIBE', 'DOWNLOAD', 'NO_BUTTON',
]
export const CTA_BY_DESTINATION: Readonly<Record<AdDestinationKind, readonly CtaType[]>> = {
  website: CTA_WEBSITE,
  lead_form: CTA_LEAD_FORM,
}
export const CTA_OPTIONS: readonly EnumOption<CtaType>[] = CTA_TYPES.map(v =>
  opt('cta', v, v === 'BOOK_NOW' ? { recommended: true } : undefined))
export function ctaFor(kind: AdDestinationKind): readonly CtaType[] {
  return CTA_BY_DESTINATION[kind] ?? CTA_WEBSITE
}
export const AD_DESTINATION_KIND_OPTIONS: readonly EnumOption<AdDestinationKind>[] = [
  opt('destination_kind', 'website', { recommended: true }),
  opt('destination_kind', 'lead_form'),
]

// ── Anzeigenformat ─────────────────────────────────────────────────────────
export type AdFormat = 'single_image' | 'single_video' | 'carousel'
export const AD_FORMATS: readonly AdFormat[] = ['single_image', 'single_video', 'carousel']
export const AD_FORMAT_OPTIONS: readonly EnumOption<AdFormat>[] = AD_FORMATS.map(v => opt('format', v))

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
] as const
export type PreviewFormat = typeof PREVIEW_FORMATS[number]
export const PREVIEW_FORMAT_OPTIONS: readonly EnumOption<PreviewFormat>[] = PREVIEW_FORMATS.map(v => opt('preview', v))

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
}

export interface MediaRef {
  /** meta_media.id */
  media_id: string
  image_hash?: string
  video_id?: string
  thumbnail_hash?: string
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
  media: { feed_4x5?: MediaRef; story_9x16?: MediaRef; square_1x1?: MediaRef; cards?: CardDraft[] }
  creative_features: Partial<Record<CreativeFeature, Enroll>>
  multi_advertiser: Enroll
  source?: { catalog_ad_id?: string; studio?: boolean; pool_id?: string }
}

export interface DraftSpec {
  v: 1
  campaign: CampaignDraft
  adsets: AdsetDraft[]
  ads: AdDraft[]
  /** HP-Bedienhilfen (nicht an Meta) */
  hp?: { budgets_synchron?: boolean }
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

export type FieldKind = 'text' | 'money' | 'int' | 'enum' | 'multi' | 'bool' | 'datetime' | 'targeting' | 'media' | 'textlist'
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
    required: () => true,
    options: (d, node) => { const ad = adOf(d, node); return optionsFor(CTA_OPTIONS, ctaFor(ad ? ad.destination.kind : 'website')) },
  }),
  fld('ad.destination.kind', 'ad', 'destination', 'enum', { virtual: true, options: () => [...AD_DESTINATION_KIND_OPTIONS] }),
  fld('ad.destination.url', 'ad', 'object_story_spec.link_data.link', 'text', {
    apiAliases: [
      'asset_feed_spec.link_urls', 'object_story_spec.link_data.call_to_action.value.link',
      'object_story_spec.video_data.call_to_action.value.link', 'link_url', 'object_url', 'conversion_domain',
    ],
    maxLen: LIMITS.urlMax,
    visible: (d, node) => adOf(d, node)?.destination.kind === 'website',
    required: (d, node) => adOf(d, node)?.destination.kind === 'website',
  }),
  fld('ad.destination.display_link', 'ad', 'object_story_spec.link_data.caption', 'text', {
    apiAliases: ['asset_feed_spec.link_urls.display_url'],
    visible: (d, node) => adOf(d, node)?.destination.kind === 'website',
  }),
  fld('ad.destination.form_id', 'ad', 'object_story_spec.link_data.call_to_action.value.lead_gen_form_id', 'enum', {
    apiAliases: [
      'object_story_spec.video_data.call_to_action.value.lead_gen_form_id',
      'asset_feed_spec.call_to_actions.value.lead_gen_form_id', 'lead_gen_form_id',
    ],
    visible: (d, node) => adOf(d, node)?.destination.kind === 'lead_form',
    required: (d, node) => adOf(d, node)?.destination.kind === 'lead_form',
  }),
  fld('ad.media.feed_4x5', 'ad', 'object_story_spec.link_data.image_hash', 'media', {
    apiAliases: [
      'object_story_spec.link_data.picture', 'object_story_spec.video_data.video_id',
      'object_story_spec.video_data.image_hash', 'object_story_spec.video_data.image_url',
      'asset_feed_spec.images', 'asset_feed_spec.videos', 'asset_feed_spec.asset_customization_rules',
      'asset_feed_spec.ad_formats', 'asset_feed_spec', 'image_hash',
    ],
    visible: (d, node) => adOf(d, node)?.format !== 'carousel',
  }),
  fld('ad.media.story_9x16', 'ad', 'media.story_9x16', 'media', {
    virtual: true, visible: (d, node) => adOf(d, node)?.format !== 'carousel',
  }),
  fld('ad.media.square_1x1', 'ad', 'media.square_1x1', 'media', { virtual: true }),
  fld('ad.media.cards', 'ad', 'object_story_spec.link_data.child_attachments', 'media', {
    apiAliases: ['object_story_spec.link_data.multi_share_optimized', 'object_story_spec.link_data.multi_share_end_card'],
    visible: (d, node) => adOf(d, node)?.format === 'carousel',
    required: (d, node) => adOf(d, node)?.format === 'carousel',
  }),
  fld('ad.creative_features', 'ad', 'degrees_of_freedom_spec', 'multi', {
    helpKey: help('ad_creative_features'), options: () => [...CREATIVE_FEATURE_OPTIONS],
  }),
  fld('ad.multi_advertiser', 'ad', 'contextual_multi_ads', 'enum', {
    helpKey: help('ad_multi_advertiser'), options: () => [...ENROLL_OPTIONS],
  }),
  fld('ad.url_tags', 'ad', 'url_tags', 'text', { readOnly: true, helpKey: help('ad_url_tags') }),
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
    if (AD_FORMATS.indexOf(ad.format) < 0) add('ad.format', 'invalid_option', 'error', { value: String(ad.format) })
    if (!(ad.identity?.page_id ?? '').trim()) add('ad.identity.page_id', 'identity_page')
    if (!(ad.identity?.instagram_user_id ?? '').trim()) add('ad.identity.instagram_user_id', 'identity_ig')
    // Texte
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
      // Beschreibung: Meta kann sie nicht je Platzierung/Variante wechseln -> höchstens eine
      if (field === 'ad.descriptions') { if (ad.format !== 'carousel' && cleanTexts(arr).length > 1) add(field, 'descriptions_single') }
      else if (cleanTexts(arr).length > 1) multi = true
    }
    if (ad.format === 'carousel' && multi) add('ad.primary_texts', 'carousel_multi_text')
    else if (multi && a && placementRulesFor(a.placements, ad.format === 'single_video').length < 2) add('ad.primary_texts', 'texts_dropped', 'warn')
    // CTA + Ziel
    const kind: AdDestinationKind = ad.destination?.kind === 'lead_form' ? 'lead_form' : 'website'
    if (!isIn(CTA_TYPES, ad.cta_type)) add('ad.cta_type', 'cta_invalid', 'error', { value: String(ad.cta_type) })
    else if (ctaFor(kind).indexOf(ad.cta_type) < 0) add('ad.cta_type', kind === 'lead_form' ? 'cta_lead_form' : 'cta_invalid', 'error', { value: ad.cta_type })
    if (ad.destination?.kind === 'website') {
      const url = (ad.destination.url ?? '').trim()
      if (!URL_RE.test(url) || url.length > LIMITS.urlMax) add('ad.destination.url', 'url_invalid')
      else if (/[?&]utm_/i.test(url)) add('ad.destination.url', 'url_has_utm', 'warn')
    } else if (ad.destination?.kind === 'lead_form') {
      if (!(ad.destination.form_id ?? '').trim()) add('ad.destination.form_id', 'form_missing')
    } else add('ad.destination.kind', 'required')
    if (a) {
      if (AD_SUPPORTED_DESTINATIONS.indexOf(a.destination) < 0) add('ad.destination.kind', 'destination_unsupported', 'error', { value: a.destination })
      else if ((a.destination === 'ON_AD') !== (kind === 'lead_form')) add('ad.destination.kind', 'destination_mismatch', 'error', { adset: a.destination })
    }
    // Medien
    const m = ad.media ?? {}
    if (ad.format === 'carousel') {
      const cards = m.cards ?? []
      if (cards.length < LIMITS.carouselMin || cards.length > LIMITS.carouselMax) add('ad.media.cards', 'cards_count', 'error', { min: LIMITS.carouselMin, max: LIMITS.carouselMax })
      cards.forEach((cd, i) => {
        if (!cd?.media?.media_id) add('ad.media.cards', 'media_missing', 'error', { index: i + 1 })
        if (!(cd?.headline ?? '').trim()) add('ad.media.cards', 'text_missing', 'error', { index: i + 1 })
        if (cd?.url && !URL_RE.test(cd.url)) add('ad.media.cards', 'url_invalid', 'error', { index: i + 1 })
      })
    } else {
      const slots = [m.feed_4x5, m.story_9x16, m.square_1x1].filter((x): x is MediaRef => !!x && !!x.media_id)
      if (!slots.length) add('ad.media.feed_4x5', 'media_missing')
      if (ad.format === 'single_video') for (const s of slots) if (s.video_id && !s.thumbnail_hash) { add('ad.media.feed_4x5', 'video_thumb_missing', opts.server ? 'error' : 'warn'); break }
    }
    for (const k of Object.keys(ad.creative_features ?? {})) {
      if (!isIn(CREATIVE_FEATURES, k)) add('ad.creative_features', 'feature_unknown', 'warn', { value: k })
      else { const v = (ad.creative_features ?? {})[k]; if (v !== 'OPT_IN' && v !== 'OPT_OUT') add('ad.creative_features', 'invalid_option', 'error', { value: String(v) }) }
    }
    if (ad.multi_advertiser !== 'OPT_IN' && ad.multi_advertiser !== 'OPT_OUT') add('ad.multi_advertiser', 'invalid_option', 'error', { value: String(ad.multi_advertiser) })
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
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v
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

export type CreativeMode = 'link_data' | 'video_data' | 'carousel' | 'asset_feed'
export const CREATIVE_MODE_OPTIONS: readonly EnumOption<CreativeMode>[] = [
  opt('creative_mode', 'link_data'), opt('creative_mode', 'video_data'),
  opt('creative_mode', 'carousel'), opt('creative_mode', 'asset_feed'),
]
export const PAC_LABEL_FEED = 'hp_feed_4x5'
export const PAC_LABEL_STORY = 'hp_story_9x16'
export interface PlacementRule {
  slot: 'feed' | 'story'
  label: string
  customization_spec: { publisher_platforms: PublisherPlatform[]; facebook_positions?: string[]; instagram_positions?: string[] }
}
/**
 * Medien je Platzierung (asset_feed_spec optimization_type PLACEMENT): 9:16 für
 * Stories + Reels, 4:5 für Feeds. Bei manuellen Platzierungen auf die gewählten
 * Positionen geschnitten. Reels in customization_spec: per validate_only bestätigen.
 */
export function placementRulesFor(placements: Placements | undefined, isVideo: boolean): PlacementRule[] {
  const base: PlacementRule[] = [
    {
      slot: 'story', label: PAC_LABEL_STORY,
      customization_spec: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['story', 'facebook_reels'], instagram_positions: ['story', 'reels'] },
    },
    {
      slot: 'feed', label: PAC_LABEL_FEED,
      customization_spec: {
        publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed', 'marketplace'],
        instagram_positions: isVideo ? ['stream', 'profile_feed'] : ['stream', 'profile_feed', 'explore_home'],
      },
    },
  ]
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

export function creativeMode(ad: AdDraft, placements?: Placements): CreativeMode {
  if (ad.format === 'carousel') return 'carousel'
  const isVideo = ad.format === 'single_video'
  // Beschreibungen zählen nicht: es gibt immer nur eine (descriptions_single)
  const n = Math.max(cleanTexts(ad.primary_texts).length, cleanTexts(ad.headlines).length)
  const f = feedRef(ad), s = storyRef(ad)
  const both = !!f && !!s && f.media_id !== s.media_id
  if ((n > 1 || both) && placementRulesFor(placements, isVideo).length >= 2) return 'asset_feed'
  return isVideo ? 'video_data' : 'link_data'
}

export function creativeFeaturesSpec(sel: Partial<Record<CreativeFeature, Enroll>> | undefined): Record<string, { enroll_status: Enroll }> {
  const out: Record<string, { enroll_status: Enroll }> = {}
  for (const k of CREATIVE_FEATURES) out[k] = { enroll_status: sel?.[k] === 'OPT_IN' ? 'OPT_IN' : HP_CREATIVE_FEATURE_DEFAULT }
  return out
}

export interface CreativeBuild { mode: CreativeMode; payload: GraphParams }

/**
 * Creative-Payload für POST act_X/adcreatives (oder inline in POST act_X/ads).
 * Immer: url_tags = URL_TAGS_STANDARD, contextual_multi_ads OPT_OUT (außer bewusst an),
 * jede Advantage+ Creative-Funktion explizit, instagram_user_id, CTA mit value.link.
 * Medien müssen aufgelöst sein (image_hash / video_id), sonst Error 'media_unresolved'.
 */
export function buildCreativePayload(ad: AdDraft, ctx: { placements?: Placements } = {}): CreativeBuild {
  const mode = creativeMode(ad, ctx.placements)
  const isVideo = ad.format === 'single_video'
  const isLead = ad.destination.kind === 'lead_form'
  const link = ad.destination.kind === 'website' ? ad.destination.url.trim() : LEAD_FORM_LINK
  const display = ad.destination.kind === 'website' ? (ad.destination.display_link ?? '').trim() : ''
  const ctaValue: GraphParams = ad.destination.kind === 'lead_form'
    ? { link: LEAD_FORM_LINK, lead_gen_form_id: ad.destination.form_id }
    : { link }
  const cta = { type: ad.cta_type, value: ctaValue }
  const bodies = cleanTexts(ad.primary_texts)
  const titles = cleanTexts(ad.headlines)
  const descs = cleanTexts(ad.descriptions)
  const story: GraphParams = { page_id: ad.identity.page_id }
  if ((ad.identity.instagram_user_id ?? '').trim()) story.instagram_user_id = ad.identity.instagram_user_id.trim()
  const payload: GraphParams = {
    name: cleanName(ad.name, 100),
    url_tags: URL_TAGS_STANDARD,
    contextual_multi_ads: { enroll_status: ad.multi_advertiser === 'OPT_IN' ? 'OPT_IN' : 'OPT_OUT' },
    degrees_of_freedom_spec: { creative_features_spec: creativeFeaturesSpec(ad.creative_features) },
    object_story_spec: story,
  }
  const need = (r: MediaRef | undefined, what: 'image' | 'video'): MediaRef => {
    if (!r || (what === 'image' ? !r.image_hash : !r.video_id)) throw new Error('media_unresolved')
    return r
  }

  if (mode === 'carousel') {
    const cards = (ad.media.cards ?? []).map(cd => {
      const cardLink = isLead ? LEAD_FORM_LINK : ((cd.url ?? '').trim() || link)
      const att: GraphParams = {
        link: cardLink,
        name: cd.headline.trim(),
        call_to_action: { type: ad.cta_type, value: isLead ? ctaValue : { link: cardLink } },
      }
      if ((cd.description ?? '').trim()) att.description = (cd.description ?? '').trim()
      if (cd.media.video_id) { att.video_id = cd.media.video_id; if (cd.media.thumbnail_hash) att.image_hash = cd.media.thumbnail_hash }
      else att.image_hash = need(cd.media, 'image').image_hash
      return att
    })
    const ld: GraphParams = { link, message: bodies[0] ?? '', child_attachments: cards, multi_share_optimized: true, multi_share_end_card: false, call_to_action: cta }
    if (titles[0]) ld.name = titles[0]
    if (display && !isLead) ld.caption = display
    story.link_data = ld
    return { mode, payload }
  }

  if (mode === 'asset_feed') {
    const rules = placementRulesFor(ctx.placements, isVideo)
    const f = feedRef(ad) ?? storyRef(ad)
    const s = storyRef(ad) ?? feedRef(ad)
    const assets: GraphParams[] = []
    for (const r of rules) {
      const ref = r.slot === 'story' ? s : f
      if (isVideo) {
        const v = need(ref, 'video')
        const item: GraphParams = { video_id: v.video_id, adlabels: [{ name: r.label }] }
        if (v.thumbnail_hash) item.thumbnail_hash = v.thumbnail_hash
        assets.push(item)
      } else {
        assets.push({ hash: need(ref, 'image').image_hash, adlabels: [{ name: r.label }] })
      }
    }
    const linkUrl: GraphParams = { website_url: link }
    if (display && !isLead) linkUrl.display_url = display
    const feed: GraphParams = {
      ad_formats: [isVideo ? 'SINGLE_VIDEO' : 'SINGLE_IMAGE'],
      optimization_type: 'PLACEMENT',
      bodies: bodies.map(text => ({ text })),
      titles: titles.map(text => ({ text })),
      link_urls: [linkUrl],
      call_to_action_types: [ad.cta_type],
      asset_customization_rules: rules.map(r => ({
        customization_spec: r.customization_spec,
        [isVideo ? 'video_label' : 'image_label']: { name: r.label },
      })),
    }
    feed[isVideo ? 'videos' : 'images'] = assets
    // Platzierungs-Creatives: genau eine Beschreibung (Meta-PAC-Guide). Leer = ein Leerzeichen,
    // sonst holt Meta ungeprüften Text von der Landingpage.
    feed.descriptions = [{ text: descs[0] ?? ' ' }]
    // Sofortformular im Asset-Feed: call_to_actions (nur Sonderkategorien sichtbar) - per validate_only prüfen
    if (isLead) feed.call_to_actions = [{ type: ad.cta_type, value: ctaValue }]
    payload.asset_feed_spec = feed
    return { mode, payload }
  }

  // Einzelmedium: Feed-Medium bevorzugt, sonst Story
  const rules = placementRulesFor(ctx.placements, isVideo)
  const onlyStory = rules.length === 1 && rules[0].slot === 'story'
  const ref = onlyStory ? (storyRef(ad) ?? feedRef(ad)) : (feedRef(ad) ?? storyRef(ad))
  if (mode === 'video_data') {
    const v = need(ref, 'video')
    const vd: GraphParams = { video_id: v.video_id, message: bodies[0] ?? '', call_to_action: cta }
    if (v.thumbnail_hash) vd.image_hash = v.thumbnail_hash
    if (titles[0]) vd.title = titles[0]
    if (descs[0]) vd.link_description = descs[0]
    story.video_data = vd
  } else {
    const ld: GraphParams = { link, message: bodies[0] ?? '', image_hash: need(ref, 'image').image_hash, call_to_action: cta }
    if (titles[0]) ld.name = titles[0]
    if (descs[0]) ld.description = descs[0]
    if (display && !isLead) ld.caption = display
    story.link_data = ld
  }
  return { mode, payload }
}

/** Registrierbare Domain aus einer URL (portal.happy-property.com -> happy-property.com). */
export function registrableDomain(url: string): string | null {
  const m = /^https?:\/\/([^/?#:]+)/i.exec((url ?? '').trim())
  if (!m) return null
  const parts = m[1].toLowerCase().replace(/^www\./, '').split('.')
  return parts.length > 2 ? parts.slice(parts.length - 2).join('.') : parts.join('.')
}
export const draftAdLabel = (draftId: string): string => `hp_draft_${(draftId ?? '').replace(/-/g, '').slice(0, 8)}`

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
  if (ad.destination.kind === 'website') {
    const dom = registrableDomain(ad.destination.url)
    if (dom) p.conversion_domain = dom
  }
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
] as const
export type BuilderMode = typeof BUILDER_MODES[number]
/** Brauchen ad_settings.builder_enabled + META_WRITES_DISABLED != '1' (+ Schreibrecht). */
export const BUILDER_WRITE_MODES: readonly BuilderMode[] = ['preview', 'media_upload', 'create', 'resume', 'activate_draft', 'duplicate', 'leadform_create']
export const BUILDER_ERROR_CODES = [
  'builder_disabled', 'writes_disabled', 'forbidden', 'not_found', 'invalid_request', 'validation_failed',
  'lint_blocked', 'guardrail_exceeded', 'app_dev_mode', 'rate_limited', 'meta_error', 'stale_validation',
  'lease_busy', 'unsupported', 'media_not_ready', 'housing_required', 'created_changed',
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
export interface DuplicateRequest { level: Level; id: string; target_adset_id?: string; deep?: boolean; rename_suffix?: string }
export interface DuplicateResponse { copied_id: string; level: Level }
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
}
export type BuilderRequest<M extends BuilderMode = BuilderMode> = M extends BuilderMode ? { mode: M } & BuilderRequestMap[M] : never
export type BuilderResponse<M extends BuilderMode> = BuilderResponseMap[M]

// ═══════════════════════════════════════════════════════════════════════════
// 9. Alle i18n-Schlüssel (für npm run verify:meta)
// ═══════════════════════════════════════════════════════════════════════════

export function allLabelKeys(): string[] {
  const keys: string[] = []
  const add = (k: string | undefined) => { if (k && keys.indexOf(k) < 0) keys.push(k) }
  const addOpts = (list: readonly EnumOption[]) => { for (const o of list) { add(o.labelKey); add(o.hintKey) } }
  for (const l of LEVELS) add(`${K}.level.${l}`)
  addOpts(OBJECTIVE_OPTIONS); addOpts(SAC_OPTIONS); addOpts(BUYING_TYPE_OPTIONS); addOpts(BUDGET_LEVEL_OPTIONS)
  addOpts(DESTINATION_OPTIONS); addOpts(GOAL_OPTIONS); addOpts(BILLING_OPTIONS); addOpts(CUSTOM_EVENT_OPTIONS)
  addOpts(ATTRIBUTION_OPTIONS); addOpts(BID_OPTIONS); addOpts(PLATFORM_OPTIONS)
  for (const pl of PUBLISHER_PLATFORMS) addOpts(POSITION_OPTIONS[pl])
  addOpts(DEVICE_OPTIONS); addOpts(PLACEMENT_MODE_OPTIONS); addOpts(LOCATION_TYPE_OPTIONS)
  addOpts(BRAND_SAFETY_OPTIONS); addOpts(PUBLISHER_CATEGORY_OPTIONS); addOpts(CTA_OPTIONS)
  addOpts(AD_DESTINATION_KIND_OPTIONS); addOpts(AD_FORMAT_OPTIONS); addOpts(CREATIVE_FEATURE_OPTIONS)
  addOpts(ENROLL_OPTIONS); addOpts(PREVIEW_FORMAT_OPTIONS); addOpts(CREATIVE_MODE_OPTIONS)
  for (const f of FIELD_SPECS) { add(f.labelKey); add(f.helpKey); add(f.housing?.noteKey) }
  for (const c of ISSUE_CODES) add(issueMessageKey(c))
  for (const c of HOUSING_CHANGE_CODES) add(housingChangeKey(c))
  for (const k of HOUSING_NOTE_KEYS) add(k)
  add(TEMPLATES.plan_b.labelKey); add(TEMPLATES.plan_b.descriptionKey)
  add(`${K}.unknown`)
  return keys
}
