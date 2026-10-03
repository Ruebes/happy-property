// meta-builder: import - bestehende Kampagne / Anzeigengruppe / Anzeige als
// DraftSpec (alle Knoten mit existing_id). Nur Lesen. Was der Assistent nicht
// abbilden kann, landet als Hinweis in warnings statt still zu verschwinden.
// Mit edit: true (edit_load / edit_apply) zusätzlich Status, Zeitplan nach Uhrzeit,
// Ausgabenlimits je Anzeigengruppe, Tracking, Creative-ID und Advantage+ Zielgruppe
// ausdrücklich (fehlt bei Meta = 0); fetchImportRaw liest dann die erweiterten Felder.

import { graphAll, graphGet, MetaApiError } from '../_shared/metaGraph.ts'
import {
  adKindsFor, ATTRIBUTION_SPECS, attributionFor, BID_STRATEGIES, BRAND_SAFETY_LEVELS, CREATIVE_FEATURES, CROP_KEYS, CTA_TYPES,
  DESTINATION_TYPES, LOCATION_TYPES, META_UNBEGRENZT_AB, MESSENGER_LINK, OBJECT_STATUSES, OBJECTIVES, PAC_LABEL_QUADRAT,
  PAC_LABEL_QUER, PAC_LABEL_STORY, SPRACH_LABEL_PREFIX, SPRACH_LOCALES, WHATSAPP_LINK,
  POSITION_FIELD_BY_PLATFORM, PROMOTED_KEYS, PUBLISHER_CATEGORIES, PUBLISHER_PLATFORMS, REMOVED_POSITIONS,
  SPECIAL_AD_CATEGORIES, URL_TAGS_STANDARD,
  type AdDraft, type AdsetDraft, type AdsetScheduleBlock, type AttributionPreset, type BidStrategy, type BrandSafety,
  type AdDestination, type AdDestinationKind, type CampaignDraft, type CardDraft, type CreativeFeature, type CtaType, type Destination, type DraftSpec, type ImageCrops,
  type SprachVariante,
  type EditableStatus, type Enroll, type ImportRequest, type ImportResponse, type Level, type ManualPlacements,
  type MediaRef, type Objective, type ObjectStatus, type OptGoal, type Placements, type PromotedObject,
  type PublisherCategory, type PublisherPlatform, type SpecialCat, type TargetingSpec,
} from '../_shared/metaSpec.ts'
import { arr, BuilderError, clone, digits, metaId, num, obj, str, type Ctx, type Raw } from './common.ts'

const CAMPAIGN_FIELDS =
  'id,account_id,name,objective,buying_type,special_ad_categories,special_ad_category_country,daily_budget,' +
  'lifetime_budget,bid_strategy,is_adset_budget_sharing_enabled,spend_cap,start_time,stop_time,status,effective_status'
const ADSET_FIELDS =
  'id,account_id,campaign_id,name,status,effective_status,destination_type,optimization_goal,billing_event,' +
  'promoted_object,attribution_spec,daily_budget,lifetime_budget,bid_strategy,bid_amount,bid_constraints,' +
  'start_time,end_time,targeting,dsa_beneficiary,dsa_payor'
const AD_BASE_FIELDS = 'id,account_id,campaign_id,adset_id,name,status,effective_status'
const CREATIVE_FIELDS =
  'id,name,object_story_spec,asset_feed_spec,url_tags,degrees_of_freedom_spec,contextual_multi_ads,' +
  'instagram_user_id,object_story_id,effective_object_story_id,source_instagram_media_id,call_to_action'
const AD_FIELDS = `${AD_BASE_FIELDS},creative{${CREATIVE_FIELDS}}`
// Bearbeiten: zusätzlich Restbudget (Leitplanke), Budgetplanung, Zeitplan, Gruppen-Limits, Tracking
const CAMPAIGN_FIELDS_EDIT = `${CAMPAIGN_FIELDS},budget_remaining,pacing_type`
const ADSET_FIELDS_EDIT =
  `${ADSET_FIELDS},budget_remaining,adset_schedule,pacing_type,daily_min_spend_target,daily_spend_cap,` +
  'lifetime_min_spend_target,lifetime_spend_cap'
const AD_FIELDS_EDIT = `${AD_FIELDS},tracking_specs`
// Bearbeiten: Partnerschaft am Creative (sonst ginge der Partner beim Werbemittel-Tausch verloren)
const AD_FIELDS_EDIT_PARTNER =
  `${AD_BASE_FIELDS},creative{${CREATIVE_FIELDS},facebook_branded_content,instagram_branded_content,branded_content},tracking_specs`

const isIn = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.indexOf(v) >= 0
const pos = (v: unknown): number | undefined => {
  const n = num(v)
  return n !== null && n > 0 ? Math.round(n) : undefined
}
const time = (v: unknown): string | undefined => {
  const s = str(v)
  if (!s) return undefined
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}
/** Limit-Felder: Metas „unbegrenzt“ zählt als kein Limit. */
const limit = (v: unknown): number | undefined => {
  const n = pos(v)
  return n !== undefined && n < META_UNBEGRENZT_AB ? n : undefined
}
/** status (ACTIVE/PAUSED, editierbar) und meta_status (auch ARCHIVED/DELETED, nur lesen) */
function statusFelder(v: unknown): { status?: EditableStatus; meta_status?: ObjectStatus } {
  const s = str(v)
  const out: { status?: EditableStatus; meta_status?: ObjectStatus } = {}
  if (isIn(OBJECT_STATUSES, s)) out.meta_status = s as ObjectStatus
  if (s === 'ACTIVE' || s === 'PAUSED') out.status = s
  return out
}

async function getOwn(ctx: Ctx, id: string, fields: string, label: string): Promise<Raw> {
  const j = await graphGet<Raw>(id, { fields })
  if (digits(j.account_id) !== ctx.env.account) {
    throw new BuilderError(403, 'forbidden', `${label} gehört nicht zu unserem Werbekonto.`)
  }
  return j
}

// ── Kampagne ─────────────────────────────────────────────────────────────────

export function mapCampaign(c: Raw, warn: string[], edit = false): CampaignDraft {
  const objective = str(c.objective)
  if (!isIn(OBJECTIVES, objective)) warn.push(`Kampagnenziel ${objective || '(leer)'} ist ein altes Ziel; neue Objekte darin legt der Assistent nicht an.`)
  if (str(c.buying_type) && str(c.buying_type) !== 'AUCTION') warn.push(`Einkaufsart ${str(c.buying_type)} wird nicht unterstützt (nur Auktion).`)
  const daily = pos(c.daily_budget)
  const lifetime = pos(c.lifetime_budget)
  const cats = arr<unknown>(c.special_ad_categories).map(str).filter(x => isIn(SPECIAL_AD_CATEGORIES, x)) as SpecialCat[]
  const out: CampaignDraft = {
    existing_id: str(c.id),
    name: str(c.name),
    objective: objective as Objective,
    buying_type: 'AUCTION',
    special_ad_categories: cats,
    special_ad_category_country: arr<unknown>(c.special_ad_category_country).map(str).filter(Boolean),
    budget_level: daily || lifetime ? 'campaign' : 'adset',
  }
  if (daily) out.daily_budget_cents = daily
  if (lifetime) out.lifetime_budget_cents = lifetime
  if (isIn(BID_STRATEGIES, c.bid_strategy)) out.bid_strategy = str(c.bid_strategy) as BidStrategy
  if (typeof c.is_adset_budget_sharing_enabled === 'boolean') out.is_adset_budget_sharing_enabled = c.is_adset_budget_sharing_enabled
  const cap = limit(c.spend_cap)
  if (cap) out.spend_cap_cents = cap
  const st = time(c.start_time), sp = time(c.stop_time)
  if (st) out.start_time = st
  if (sp) out.stop_time = sp
  if (edit) Object.assign(out, statusFelder(c.status))
  return out
}

// ── Anzeigengruppe ───────────────────────────────────────────────────────────

function attributionPreset(spec: unknown, goal: OptGoal, name: string, warn: string[]): AttributionPreset {
  const sig = (list: Array<{ event_type?: unknown; window_days?: unknown }>) =>
    list.map(w => `${str(w.event_type)}:${num(w.window_days) ?? 0}`).sort().join('|')
  const raw = arr<Raw>(spec)
  const allowed = attributionFor(goal)
  if (!raw.length) return allowed[0]
  const want = sig(raw)
  for (const k of Object.keys(ATTRIBUTION_SPECS) as AttributionPreset[]) {
    if (sig(ATTRIBUTION_SPECS[k] as unknown as Raw[]) === want) return k
  }
  warn.push(`Anzeigengruppe "${name}": Attribution ${want} ist keine Standard-Einstellung, gesetzt auf ${allowed[0]}.`)
  return allowed[0]
}

export function mapAdset(a: Raw, warn: string[], edit = false): AdsetDraft {
  const name = str(a.name)
  const t = clone(obj(a.targeting)) as Raw
  // Platzierungen aus dem targeting lösen
  let placements: Placements = { mode: 'advantage' }
  const plats = arr<unknown>(t.publisher_platforms).map(str).filter(p => isIn(PUBLISHER_PLATFORMS, p)) as PublisherPlatform[]
  if (plats.length) {
    const manual: ManualPlacements = { mode: 'manual', publisher_platforms: plats }
    for (const pl of PUBLISHER_PLATFORMS) {
      const field = POSITION_FIELD_BY_PLATFORM[pl]
      const list = arr<unknown>(t[field]).map(str).filter(Boolean)
      const removed = list.filter(x => REMOVED_POSITIONS[field].indexOf(x) >= 0)
      if (removed.length) warn.push(`Anzeigengruppe "${name}": entfernte Platzierung(en) ${removed.join(', ')} weggelassen.`)
      const kept = list.filter(x => REMOVED_POSITIONS[field].indexOf(x) < 0)
      if (kept.length) (manual as unknown as Raw)[field] = kept
    }
    const dev = arr<unknown>(t.device_platforms).map(str).filter(x => x === 'mobile' || x === 'desktop')
    if (dev.length) manual.device_platforms = dev as ManualPlacements['device_platforms']
    placements = manual
  }
  for (const k of ['publisher_platforms', 'facebook_positions', 'instagram_positions', 'threads_positions', 'messenger_positions',
    'audience_network_positions', 'device_platforms', 'whatsapp_positions', 'age_range']) delete t[k]
  // Markensicherheit
  let brand: BrandSafety | undefined
  for (const lv of arr<unknown>(t.brand_safety_content_filter_levels).map(str)) {
    const m = /^FACEBOOK_(RELAXED|STANDARD|STRICT)$/.exec(lv)
    if (m && isIn(BRAND_SAFETY_LEVELS, m[1])) brand = m[1] as BrandSafety
  }
  delete t.brand_safety_content_filter_levels
  const excludedCats = arr<unknown>(t.excluded_publisher_categories).map(str).filter(x => isIn(PUBLISHER_CATEGORIES, x)) as PublisherCategory[]
  delete t.excluded_publisher_categories
  // Standort-Typen: nur home/recent kann der Assistent
  const geo = obj(t.geo_locations)
  const lt = arr<unknown>(geo.location_types).map(str)
  if (lt.length) {
    const kept = lt.filter(x => isIn(LOCATION_TYPES, x))
    if (kept.length !== lt.length) warn.push(`Anzeigengruppe "${name}": Standort-Typ(en) ${lt.filter(x => !isIn(LOCATION_TYPES, x)).join(', ')} weggelassen.`)
    geo.location_types = kept.length ? kept : ['home', 'recent']
  }
  t.geo_locations = geo

  const goal = str(a.optimization_goal) as OptGoal
  const dest = str(a.destination_type) || 'UNDEFINED'
  if (!isIn(DESTINATION_TYPES, dest)) warn.push(`Anzeigengruppe "${name}": unbekannter Conversion-Ort ${dest}.`)
  const poIn = obj(a.promoted_object)
  const po: PromotedObject = {}
  for (const k of PROMOTED_KEYS) if (str(poIn[k])) (po as Raw)[k] = str(poIn[k])

  const out: AdsetDraft = {
    key: `adset_${str(a.id)}`,
    existing_id: str(a.id),
    name,
    destination: dest as Destination,
    optimization_goal: goal,
    billing_event: (str(a.billing_event) || 'IMPRESSIONS') as AdsetDraft['billing_event'],
    promoted_object: po,
    attribution: attributionPreset(a.attribution_spec, goal, name, warn),
    targeting: t as unknown as TargetingSpec,
    placements,
    dsa_beneficiary: str(a.dsa_beneficiary),
    dsa_payor: str(a.dsa_payor),
  }
  const daily = pos(a.daily_budget), lifetime = pos(a.lifetime_budget), bid = pos(a.bid_amount)
  if (daily) out.daily_budget_cents = daily
  if (lifetime) out.lifetime_budget_cents = lifetime
  if (bid) out.bid_amount_cents = bid
  if (isIn(BID_STRATEGIES, a.bid_strategy)) out.bid_strategy = str(a.bid_strategy) as BidStrategy
  const roas = pos(obj(a.bid_constraints).roas_average_floor)
  if (roas) out.roas_average_floor = roas
  const st = time(a.start_time), en = time(a.end_time)
  if (st) out.start_time = st
  if (en) out.end_time = en
  if (brand) out.brand_safety = brand
  if (excludedCats.length) out.excluded_publisher_categories = excludedCats
  if (edit) {
    Object.assign(out, statusFelder(a.status))
    // Bestehende Gruppe: fehlt advantage_audience bei Meta, ist die Advantage+ Zielgruppe aus
    // (so liest auch meta-ads-tools). Ausdrücklich, damit der Vergleich nichts erfindet.
    const ta = obj(t.targeting_automation)
    if (ta.advantage_audience !== 0 && ta.advantage_audience !== 1) {
      ta.advantage_audience = ta.advantage_audience === true || ta.advantage_audience === '1' ? 1 : 0
      t.targeting_automation = ta
    }
    const sched = arr<Raw>(a.adset_schedule).map((b): AdsetScheduleBlock => ({
      start_minute: num(b.start_minute) ?? 0,
      end_minute: num(b.end_minute) ?? 0,
      days: arr<unknown>(b.days).map(x => num(x)).filter((x): x is number => x !== null),
      ...(str(b.timezone_type) === 'ADVERTISER' || str(b.timezone_type) === 'USER' ? { timezone_type: str(b.timezone_type) as 'USER' | 'ADVERTISER' } : {}),
    }))
    if (sched.length) out.adset_schedule = sched
    const dMin = pos(a.daily_min_spend_target), dCap = limit(a.daily_spend_cap)
    const lMin = pos(a.lifetime_min_spend_target), lCap = limit(a.lifetime_spend_cap)
    if (dMin) out.daily_min_spend_target_cents = dMin
    if (dCap) out.daily_spend_cap_cents = dCap
    if (lMin) out.lifetime_min_spend_target_cents = lMin
    if (lCap) out.lifetime_spend_cap_cents = lCap
  }
  return out
}

// ── Anzeige ──────────────────────────────────────────────────────────────────

const imgRef = (hash: string, crops?: unknown): MediaRef => {
  const r: MediaRef = { media_id: `meta:img:${hash}`, image_hash: hash }
  const c = cropsAus(crops)
  if (c) r.crops = c
  return r
}
/** image_crops von Meta -> ImageCrops (nur bekannte Schlüssel). */
function cropsAus(v: unknown): ImageCrops | undefined {
  const o = obj(v)
  const out: ImageCrops = {}
  for (const k of CROP_KEYS) {
    const box = o[k]
    if (Array.isArray(box) && box.length === 2 && Array.isArray(box[0]) && Array.isArray(box[1])) {
      const a = box[0] as unknown[], b = box[1] as unknown[]
      const n = [num(a[0]), num(a[1]), num(b[0]), num(b[1])]
      if (n.every(x => x !== null)) out[k] = [[n[0] as number, n[1] as number], [n[2] as number, n[3] as number]]
    }
  }
  return Object.keys(out).length ? out : undefined
}
const vidRef = (videoId: string, thumbHash?: string): MediaRef => ({
  media_id: `meta:vid:${videoId}`, video_id: videoId, ...(thumbHash ? { thumbnail_hash: thumbHash } : {}),
})
const texts = (...list: unknown[]): string[] => list.map(str).map(s => s.trim()).filter(Boolean)

/**
 * Ziel der Anzeige aus Button und Link (Conversion-Ort der Anzeigengruppe hat Vorrang):
 * WhatsApp / Messenger / Anruf / Sofortformular / Website und Sofortformular / Website.
 * WhatsApp, Messenger und Anruf nur, wenn der Conversion-Ort sie zulässt (oder unbekannt ist):
 * ein „Jetzt anrufen“-Button in einer Website-Gruppe (Plan B, WEBSITE_AND_PHONE_CALL) bleibt Website.
 */
function zielAus(ctaType: string, value: Raw, link: string, display: string, adsetDest: string, unpassend?: (art: string) => void): AdDestination {
  const formId = str(value.lead_gen_form_id)
  const app = str(value.app_destination).toUpperCase()
  const vlink = str(value.link)
  const kinds = adKindsFor(adsetDest as Destination)
  const darf = (k: AdDestinationKind): boolean => !adsetDest || kinds.indexOf(k) >= 0
  const pruefe = (k: AdDestinationKind, treffer: boolean): boolean => {
    if (!treffer) return false
    if (darf(k)) return true
    unpassend?.(k)
    return false
  }
  if (pruefe('whatsapp', adsetDest === 'WHATSAPP' || ctaType === 'WHATSAPP_MESSAGE' || app === 'WHATSAPP' || link === WHATSAPP_LINK)) return { kind: 'whatsapp' }
  if (pruefe('messenger', adsetDest === 'MESSENGER' || ctaType === 'MESSAGE_PAGE' || app === 'MESSENGER' || link === MESSENGER_LINK)) return { kind: 'messenger' }
  if (pruefe('phone_call', adsetDest === 'PHONE_CALL' || ctaType === 'CALL_NOW' || /^tel:/i.test(vlink))) return { kind: 'phone_call', telefon: vlink.replace(/^tel:/i, '') }
  const site = link && !/^https?:\/\/fb\.me\/?$/i.test(link) ? link : ''
  if (formId) {
    if (adsetDest !== 'ON_AD' && site && (adsetDest === 'WEBSITE_AND_LEAD_FORM' || !adsetDest)) {
      return { kind: 'website_lead_form', url: site, form_id: formId, ...(display ? { display_link: display } : {}) }
    }
    return { kind: 'lead_form', form_id: formId }
  }
  return { kind: 'website', url: link || (/^tel:/i.test(vlink) ? '' : vlink), ...(display ? { display_link: display } : {}) }
}

/** WhatsApp-Begrüßung (page_welcome_message, Text oder JSON) -> begruessung / nachricht. */
function willkommenAus(dest: AdDestination, raw: unknown): AdDestination {
  if (dest.kind !== 'whatsapp' || raw === undefined || raw === null || raw === '') return dest
  let o: Raw = {}
  if (typeof raw === 'string') { try { o = obj(JSON.parse(raw)) } catch { o = {} } } else o = obj(raw)
  const msg = obj(obj(o.text_format).message)
  const text = str(msg.text).trim(), nachricht = str(obj(msg.autofill_message).content).trim()
  return { kind: 'whatsapp', ...(text ? { begruessung: text } : {}), ...(nachricht ? { nachricht } : {}) }
}

/**
 * Partnerschaftswerbung am Creative -> PartnerschaftSpec (Umkehrung von partnerFelder in metaSpec).
 * Nur branded_content.partners ohne die beiden Einzelfelder kann der Assistent nicht nachbauen.
 */
function partnerAus(cr: Raw, out: AdDraft, hpPage: string): void {
  const fb = str(obj(cr.facebook_branded_content).sponsor_page_id)
  const ig = str(obj(cr.instagram_branded_content).sponsor_id)
  if (!fb && !ig) {
    if (arr<unknown>(obj(cr.branded_content).partners).length) out.source = { ...(out.source ?? {}), partner_unbekannt: true }
    return
  }
  const page = out.identity.page_id
  if (fb && hpPage && fb === hpPage && page && page !== hpPage) {
    // Partner ist Hauptidentität (seine Seite im Creative), Happy Property die zweite Identität
    out.partnerschaft = { partner_page_id: page, partner_ist_absender: true }
    out.identity = { page_id: hpPage, instagram_user_id: ig || out.identity.instagram_user_id }
    return
  }
  out.partnerschaft = { ...(fb ? { partner_page_id: fb } : {}), ...(ig ? { partner_ig_user_id: ig } : {}) }
}

export function mapAd(ad: Raw, adsetKey: string, defaults: { page_id: string }, warn: string[], edit = false, adsetDest = ''): AdDraft {
  const name = str(ad.name)
  const cr = obj(ad.creative)
  const oss = obj(cr.object_story_spec)
  const ld = obj(oss.link_data)
  const vd = obj(oss.video_data)
  const afs = obj(cr.asset_feed_spec)
  const out: AdDraft = {
    key: `ad_${str(ad.id)}`,
    adset_key: adsetKey,
    existing_id: str(ad.id),
    name,
    format: 'single_image',
    identity: {
      page_id: str(oss.page_id) || defaults.page_id,
      instagram_user_id: str(oss.instagram_user_id) || str(cr.instagram_user_id),
    },
    primary_texts: [],
    headlines: [],
    descriptions: [],
    cta_type: 'LEARN_MORE',
    destination: { kind: 'website', url: '' },
    media: {},
    creative_features: {},
    multi_advertiser: 'OPT_IN',
    source: { catalog_ad_id: str(ad.id) },
  }
  let cta = ''
  const unpassend = (art: string) => {
    warn.push(`Anzeige "${name}": Button ${cta || '?'} (${art}) passt nicht zum Conversion-Ort der Anzeigengruppe (${adsetDest}); als Website-Ziel übernommen.`)
  }

  if (Object.keys(ld).length) {
    const c = obj(ld.call_to_action)
    cta = str(c.type)
    out.primary_texts = texts(ld.message)
    out.headlines = texts(ld.name)
    out.descriptions = texts(ld.description)
    const children = arr<Raw>(ld.child_attachments)
    if (children.length) {
      out.format = 'carousel'
      out.media.cards = children.map((ch): CardDraft => ({
        headline: str(ch.name),
        ...(str(ch.description) ? { description: str(ch.description) } : {}),
        ...(str(ch.link) && str(ch.link) !== str(ld.link) ? { url: str(ch.link) } : {}),
        media: str(ch.video_id) ? vidRef(str(ch.video_id), str(ch.image_hash) || undefined) : imgRef(str(ch.image_hash), ch.image_crops),
      }))
      // Metas Standard ohne Angabe: beides an
      out.karussell = { endkarte: ld.multi_share_end_card !== false, reihenfolge_automatisch: ld.multi_share_optimized !== false }
    } else if (str(ld.image_hash)) {
      out.media.feed_4x5 = imgRef(str(ld.image_hash), ld.image_crops)
    }
    out.destination = willkommenAus(zielAus(cta, obj(c.value), str(ld.link), str(ld.caption), adsetDest, unpassend), ld.page_welcome_message ?? oss.page_welcome_message)
  } else if (Object.keys(vd).length) {
    const c = obj(vd.call_to_action)
    cta = str(c.type)
    out.format = 'single_video'
    out.primary_texts = texts(vd.message)
    out.headlines = texts(vd.title)
    out.descriptions = texts(vd.link_description)
    if (str(vd.video_id)) out.media.feed_4x5 = vidRef(str(vd.video_id), str(vd.image_hash) || undefined)
    const v = obj(c.value)
    out.destination = willkommenAus(zielAus(cta, v, str(v.link), '', adsetDest, unpassend), vd.page_welcome_message ?? oss.page_welcome_message)
  } else if (Object.keys(afs).length) {
    cta = str(arr<unknown>(afs.call_to_action_types)[0])
    const value = obj(obj(arr<unknown>(afs.call_to_actions)[0]).value)
    const istSprachen = str(afs.optimization_type) === 'LANGUAGE'
    const labelOf = (item: Raw): string[] => arr<Raw>(item.adlabels).map(l => str(l.name).toLowerCase())
    const deLabel = `${SPRACH_LABEL_PREFIX}de`, enLabel = `${SPRACH_LABEL_PREFIX}en`
    // Mehrsprachig: Standardregel = Deutsch (Texte der Anzeige), weitere Regeln = Varianten
    const nachLabel = (list: unknown, label: string): Raw[] => arr<Raw>(list).filter(x => labelOf(x).indexOf(label) >= 0)
    const textListe = (list: unknown, label: string | null): string[] => (label ? nachLabel(list, label) : arr<Raw>(list)).map(b => str(b.text)).filter(t => !!t.trim()).slice(0, 5)
    if (istSprachen) {
      const rules = arr<Raw>(afs.asset_customization_rules)
      const def = rules.find(r => r.is_default === true) ?? rules[0]
      const dl = def ? str(obj(def.body_label).name).toLowerCase() || deLabel : deLabel
      out.primary_texts = textListe(afs.bodies, dl)
      out.headlines = textListe(afs.titles, dl)
      out.descriptions = textListe(afs.descriptions, dl).filter(t => t.trim())
      const varianten: SprachVariante[] = []
      for (const r of rules) {
        if (r === def) continue
        const lb = str(obj(r.body_label).name).toLowerCase()
        const locs = arr<unknown>(obj(r.customization_spec).locales).map(x => num(x))
        const istEn = lb === enLabel || locs.some(x => x !== null && SPRACH_LOCALES.en.indexOf(x) >= 0)
        if (!istEn) { warn.push(`Anzeige "${name}": Sprachversion ${lb || '?'} wird nicht unterstützt (nur Deutsch und Englisch).`); continue }
        const body = textListe(afs.bodies, lb)[0] ?? ''
        const title = textListe(afs.titles, lb)[0] ?? ''
        const desc = textListe(afs.descriptions, lb)[0] ?? ''
        const urlL = str(obj(nachLabel(afs.link_urls, str(obj(r.link_url_label).name).toLowerCase())[0]).website_url)
        varianten.push({ sprache: 'en', primary_text: body, headline: title, ...(desc.trim() ? { description: desc } : {}), ...(urlL ? { url: urlL } : {}) })
      }
      const auto = arr<unknown>(afs.autotranslate).map(str).some(x => x.toLowerCase().indexOf('en') === 0)
      if (varianten.length || auto) out.sprachen = { varianten, ...(auto && !varianten.length ? { automatisch_uebersetzen: ['en'] } : {}) }
    } else {
      out.primary_texts = textListe(afs.bodies, null)
      out.headlines = textListe(afs.titles, null)
      out.descriptions = textListe(afs.descriptions, null)
    }
    const linkItem = istSprachen ? (nachLabel(afs.link_urls, deLabel)[0] ?? obj(arr<unknown>(afs.link_urls)[0])) : obj(arr<unknown>(afs.link_urls)[0])
    out.destination = zielAus(cta, value, str(linkItem.website_url), str(linkItem.display_url), adsetDest, unpassend)
    const isStory = (item: Raw): boolean => labelOf(item).some(n => n === PAC_LABEL_STORY || n.includes('story') || n.includes('9x16') || n.includes('reel'))
    const isQuer = (item: Raw): boolean => labelOf(item).some(n => n === PAC_LABEL_QUER || n.includes('191') || n.includes('16x9'))
    const isQuadrat = (item: Raw): boolean => labelOf(item).some(n => n === PAC_LABEL_QUADRAT || n.includes('1x1'))
    const isFeed = (item: Raw): boolean => !isStory(item) && !isQuer(item) && !isQuadrat(item)
    const videos = arr<Raw>(afs.videos)
    const images = arr<Raw>(afs.images)
    if (videos.length) {
      out.format = 'single_video'
      const vr = (v: Raw | undefined): MediaRef | undefined => (v && str(v.video_id) ? vidRef(str(v.video_id), str(v.thumbnail_hash) || undefined) : undefined)
      const story = videos.find(isStory)
      const feed = videos.find(isFeed) ?? (story ? undefined : videos[0])
      const f = vr(feed), st = vr(story), q = vr(videos.find(isQuer)), qu = vr(videos.find(isQuadrat))
      if (f) out.media.feed_4x5 = f
      if (st) out.media.story_9x16 = st
      if (q) out.media.landscape_191x1 = q
      if (qu) out.media.square_1x1 = qu
    } else if (images.length) {
      const ir = (i: Raw | undefined): MediaRef | undefined => (i && str(i.hash) ? imgRef(str(i.hash), i.image_crops) : undefined)
      const story = images.find(isStory)
      const feed = images.find(isFeed) ?? (story ? undefined : images[0])
      const f = ir(feed), st = ir(story), q = ir(images.find(isQuer)), qu = ir(images.find(isQuadrat))
      if (f) out.media.feed_4x5 = f
      if (st) out.media.story_9x16 = st
      if (q) out.media.landscape_191x1 = q
      if (qu) out.media.square_1x1 = qu
    }
    if (arr<unknown>(afs.bodies).length > 5 && !istSprachen) warn.push(`Anzeige "${name}": mehr als 5 Textvarianten, nur die ersten 5 übernommen.`)
  } else if (str(cr.object_story_id) || str(cr.source_instagram_media_id)) {
    // Vorhandener Beitrag: Texte und Medien bleiben beim Beitrag
    const ig = str(cr.source_instagram_media_id)
    out.beitrag = ig ? { quelle: 'instagram', id: ig } : { quelle: 'facebook', id: str(cr.object_story_id) }
    const c = obj(cr.call_to_action)
    cta = str(c.type)
    if (cta) out.destination = zielAus(cta, obj(c.value), str(obj(c.value).link), '', adsetDest, unpassend)
    warn.push(`Anzeige "${name}": nutzt einen vorhandenen Beitrag. Texte und Medien kommen aus dem Beitrag.`)
    if (edit) out.source = { ...(out.source ?? {}), aus_beitrag: true }
  } else {
    warn.push(`Anzeige "${name}": Creative aus einem bestehenden Beitrag, Texte und Medien sind nicht übernehmbar.`)
    if (edit) out.source = { ...(out.source ?? {}), aus_beitrag: true }
  }

  if (isIn(CTA_TYPES, cta)) out.cta_type = cta as CtaType
  else if (cta) warn.push(`Anzeige "${name}": Call-to-Action ${cta} wird nicht unterstützt, gesetzt auf LEARN_MORE.`)

  const feats = obj(obj(cr.degrees_of_freedom_spec).creative_features_spec)
  const cf: Partial<Record<CreativeFeature, Enroll>> = {}
  for (const k of CREATIVE_FEATURES) {
    const v = str(obj(feats[k]).enroll_status)
    if (v === 'OPT_IN' || v === 'OPT_OUT') cf[k] = v
  }
  out.creative_features = cf
  const multi = str(obj(cr.contextual_multi_ads).enroll_status)
  out.multi_advertiser = multi === 'OPT_OUT' ? 'OPT_OUT' : 'OPT_IN'
  if (out.multi_advertiser === 'OPT_IN') warn.push(`Anzeige "${name}": „Mehrere Werbetreibende“ ist an (Meta-Standard). HP-Standard ist aus.`)
  const tags = str(cr.url_tags)
  if (tags !== URL_TAGS_STANDARD) warn.push(`Anzeige "${name}": URL-Parameter weichen vom Standard ab${tags ? '' : ' (keine gesetzt)'}.`)
  partnerAus(cr, out, defaults.page_id)
  if (out.source?.partner_unbekannt) warn.push(`Anzeige "${name}": Partnerschaftswerbung, die der Assistent nicht nachbauen kann. Werbemittel bitte im Werbeanzeigenmanager ändern.`)
  if (edit) {
    Object.assign(out, statusFelder(ad.status))
    if (str(cr.id)) out.source = { ...(out.source ?? {}), creative_id: str(cr.id) }
    // Feed-Typ wie bei Meta: beim Ersetzen darf er nicht wechseln (editDiff)
    if (Object.keys(afs).length) {
      const ot = str(afs.optimization_type).toUpperCase()
      out.source = { ...(out.source ?? {}), creative_mode: ot === 'PLACEMENT' ? 'asset_feed' : ot === 'LANGUAGE' ? 'asset_feed_language' : 'asset_feed_text' }
    }
    const ts = arr<Raw>(ad.tracking_specs)
    if (ts.length) out.tracking_specs = clone(ts)
  }
  return out
}

// ── Modus ────────────────────────────────────────────────────────────────────

/** Rohdaten von Meta (für edit_apply: Live-Stand, Ziel des Zusammenführens). */
export interface ImportRaw { campaign: Raw; adsets: Raw[]; ads: Raw[] }

export function levelParam(v: unknown): Level {
  const level = str(v) as Level
  if (level !== 'campaign' && level !== 'adset' && level !== 'ad') throw new BuilderError(400, 'invalid_request', 'level muss campaign, adset oder ad sein.')
  return level
}

/**
 * Liest Kampagne, Anzeigengruppe(n) und Anzeige(n) zu einem Objekt (Konto-Prüfung über das
 * Einstiegsobjekt). edit: erweiterte Felder; lehnt Meta eines davon ab (#100), noch einmal
 * mit dem Grundsatz und Hinweis in warn.
 */
export async function fetchImportRaw(ctx: Ctx, level: Level, id: string, warn: string[], edit = false): Promise<ImportRaw> {
  let f = edit
    ? { c: CAMPAIGN_FIELDS_EDIT, a: ADSET_FIELDS_EDIT, ad: AD_FIELDS_EDIT_PARTNER }
    : { c: CAMPAIGN_FIELDS, a: ADSET_FIELDS, ad: AD_FIELDS }
  const run = async (): Promise<ImportRaw> => {
    if (level === 'campaign') {
      const campaign = await getOwn(ctx, id, f.c, 'Die Kampagne')
      const adsets = await graphAll<Raw>(`${id}/adsets`, { fields: f.a, limit: 100 }, { maxPages: 3 })
      const ads = await graphAll<Raw>(`${id}/ads`, { fields: f.ad, limit: 100 }, { maxPages: 3 })
      return { campaign, adsets, ads }
    }
    if (level === 'adset') {
      const a = await getOwn(ctx, id, f.a, 'Die Anzeigengruppe')
      const campaign = await graphGet<Raw>(metaId(a.campaign_id, 'campaign_id'), { fields: f.c })
      const ads = await graphAll<Raw>(`${id}/ads`, { fields: f.ad, limit: 100 }, { maxPages: 3 })
      return { campaign, adsets: [a], ads }
    }
    const ad = await getOwn(ctx, id, f.ad, 'Die Anzeige')
    const a = await graphGet<Raw>(metaId(ad.adset_id, 'adset_id'), { fields: f.a })
    const campaign = await graphGet<Raw>(metaId(ad.campaign_id, 'campaign_id'), { fields: f.c })
    return { campaign, adsets: [a], ads: [ad] }
  }
  try {
    return await run()
  } catch (err) {
    // Partnerschafts-Felder können auch an einer fehlenden Berechtigung scheitern
    if (!edit || !(err instanceof MetaApiError) || (err.kind !== 'validation' && err.kind !== 'permission')) throw err
  }
  // Erst nur ohne Partnerschafts-Felder, dann ganz ohne Zusatzfelder
  try {
    f = { c: CAMPAIGN_FIELDS_EDIT, a: ADSET_FIELDS_EDIT, ad: AD_FIELDS_EDIT }
    const raw = await run()
    warn.push('Partnerschaftswerbung konnte nicht gelesen werden. Vor dem Tausch eines Werbemittels den Partner im Werbeanzeigenmanager prüfen.')
    return raw
  } catch (err) {
    if (!(err instanceof MetaApiError) || err.kind !== 'validation') throw err
    warn.push('Meta kennt nicht alle Zusatzfelder (Zeitplan, Gruppen-Limits, Tracking, Partnerschaft); diese sind nicht geladen.')
    f = { c: CAMPAIGN_FIELDS, a: ADSET_FIELDS, ad: AD_FIELDS }
    return await run()
  }
}

/** Rohdaten -> DraftSpec (alle Knoten mit existing_id). */
export function mapImport(raw: ImportRaw, defaults: { page_id: string }, warn: string[], edit = false): DraftSpec {
  const spec: DraftSpec = { v: 1, campaign: mapCampaign(raw.campaign, warn, edit), adsets: [], ads: [] }
  const keyById: Record<string, string> = {}
  const destById: Record<string, string> = {}
  for (const a of raw.adsets) {
    const as = mapAdset(a, warn, edit)
    keyById[str(a.id)] = as.key
    destById[str(a.id)] = str(a.destination_type)
    spec.adsets.push(as)
  }
  for (const ad of raw.ads) {
    const key = keyById[str(ad.adset_id)]
    if (!key) { warn.push(`Anzeige "${str(ad.name)}": Anzeigengruppe ${str(ad.adset_id)} nicht im Import, übersprungen.`); continue }
    spec.ads.push(mapAd(ad, key, defaults, warn, edit, destById[str(ad.adset_id)] ?? ''))
  }
  if (raw.ads.length >= 300) warn.push('Sehr viele Anzeigen: Liste eventuell unvollständig.')
  return spec
}

export async function modeImport(ctx: Ctx, req: ImportRequest): Promise<ImportResponse> {
  const level = levelParam(req.level)
  const id = metaId(req.id, 'id')
  const warn: string[] = []
  const settings = await ctx.settings()
  const defaults = { page_id: settings.default_page_id || ctx.env.pageId }
  const raw = await fetchImportRaw(ctx, level, id, warn)
  const spec = mapImport(raw, defaults, warn)
  return { spec, warnings: warn, source: { level, id } }
}
