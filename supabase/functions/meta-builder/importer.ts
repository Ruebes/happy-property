// meta-builder: import - bestehende Kampagne / Anzeigengruppe / Anzeige als
// DraftSpec (alle Knoten mit existing_id). Nur Lesen. Was der Assistent nicht
// abbilden kann, landet als Hinweis in warnings statt still zu verschwinden.

import { graphAll, graphGet } from '../_shared/metaGraph.ts'
import {
  ATTRIBUTION_SPECS, attributionFor, BID_STRATEGIES, BRAND_SAFETY_LEVELS, CREATIVE_FEATURES, CTA_TYPES,
  DESTINATION_TYPES, LOCATION_TYPES, OBJECTIVES, PAC_LABEL_STORY, POSITION_FIELD_BY_PLATFORM, PROMOTED_KEYS,
  PUBLISHER_CATEGORIES, PUBLISHER_PLATFORMS, REMOVED_POSITIONS, SPECIAL_AD_CATEGORIES, URL_TAGS_STANDARD,
  type AdDraft, type AdsetDraft, type AttributionPreset, type BidStrategy, type BrandSafety, type CampaignDraft,
  type CardDraft, type CreativeFeature, type CtaType, type Destination, type DraftSpec, type Enroll,
  type ImportRequest, type ImportResponse, type Level, type ManualPlacements, type MediaRef, type Objective,
  type OptGoal, type Placements, type PromotedObject, type PublisherCategory, type PublisherPlatform,
  type SpecialCat, type TargetingSpec,
} from '../_shared/metaSpec.ts'
import { arr, BuilderError, clone, digits, metaId, num, obj, str, type Ctx, type Raw } from './common.ts'

const CAMPAIGN_FIELDS =
  'id,account_id,name,objective,buying_type,special_ad_categories,special_ad_category_country,daily_budget,' +
  'lifetime_budget,bid_strategy,is_adset_budget_sharing_enabled,spend_cap,start_time,stop_time,status,effective_status'
const ADSET_FIELDS =
  'id,account_id,campaign_id,name,status,effective_status,destination_type,optimization_goal,billing_event,' +
  'promoted_object,attribution_spec,daily_budget,lifetime_budget,bid_strategy,bid_amount,bid_constraints,' +
  'start_time,end_time,targeting,dsa_beneficiary,dsa_payor'
const AD_FIELDS =
  'id,account_id,campaign_id,adset_id,name,status,effective_status,' +
  'creative{id,name,object_story_spec,asset_feed_spec,url_tags,degrees_of_freedom_spec,contextual_multi_ads,' +
  'instagram_user_id,object_story_id,effective_object_story_id}'

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

async function getOwn(ctx: Ctx, id: string, fields: string, label: string): Promise<Raw> {
  const j = await graphGet<Raw>(id, { fields })
  if (digits(j.account_id) !== ctx.env.account) {
    throw new BuilderError(403, 'forbidden', `${label} gehört nicht zu unserem Werbekonto.`)
  }
  return j
}

// ── Kampagne ─────────────────────────────────────────────────────────────────

function mapCampaign(c: Raw, warn: string[]): CampaignDraft {
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
  const cap = pos(c.spend_cap)
  if (cap) out.spend_cap_cents = cap
  const st = time(c.start_time), sp = time(c.stop_time)
  if (st) out.start_time = st
  if (sp) out.stop_time = sp
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

function mapAdset(a: Raw, warn: string[]): AdsetDraft {
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
  return out
}

// ── Anzeige ──────────────────────────────────────────────────────────────────

const imgRef = (hash: string): MediaRef => ({ media_id: `meta:img:${hash}`, image_hash: hash })
const vidRef = (videoId: string, thumbHash?: string): MediaRef => ({
  media_id: `meta:vid:${videoId}`, video_id: videoId, ...(thumbHash ? { thumbnail_hash: thumbHash } : {}),
})
const texts = (...list: unknown[]): string[] => list.map(str).map(s => s.trim()).filter(Boolean)

function mapAd(ad: Raw, adsetKey: string, defaults: { page_id: string }, warn: string[]): AdDraft {
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
  let formId = ''

  if (Object.keys(ld).length) {
    const c = obj(ld.call_to_action)
    cta = str(c.type)
    formId = str(obj(c.value).lead_gen_form_id)
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
        media: str(ch.video_id) ? vidRef(str(ch.video_id), str(ch.image_hash) || undefined) : imgRef(str(ch.image_hash)),
      }))
    } else if (str(ld.image_hash)) {
      out.media.feed_4x5 = imgRef(str(ld.image_hash))
    }
    if (!formId) out.destination = { kind: 'website', url: str(ld.link), ...(str(ld.caption) ? { display_link: str(ld.caption) } : {}) }
  } else if (Object.keys(vd).length) {
    const c = obj(vd.call_to_action)
    cta = str(c.type)
    formId = str(obj(c.value).lead_gen_form_id)
    out.format = 'single_video'
    out.primary_texts = texts(vd.message)
    out.headlines = texts(vd.title)
    out.descriptions = texts(vd.link_description)
    if (str(vd.video_id)) out.media.feed_4x5 = vidRef(str(vd.video_id), str(vd.image_hash) || undefined)
    if (!formId) out.destination = { kind: 'website', url: str(obj(c.value).link) }
  } else if (Object.keys(afs).length) {
    out.primary_texts = arr<Raw>(afs.bodies).map(b => str(b.text)).filter(Boolean).slice(0, 5)
    out.headlines = arr<Raw>(afs.titles).map(b => str(b.text)).filter(Boolean).slice(0, 5)
    out.descriptions = arr<Raw>(afs.descriptions).map(b => str(b.text)).filter(Boolean).slice(0, 5)
    cta = str(arr<unknown>(afs.call_to_action_types)[0])
    formId = str(obj(obj(arr<unknown>(afs.call_to_actions)[0]).value).lead_gen_form_id)
    const link = obj(arr<unknown>(afs.link_urls)[0])
    if (!formId) out.destination = { kind: 'website', url: str(link.website_url), ...(str(link.display_url) ? { display_link: str(link.display_url) } : {}) }
    const isStory = (item: Raw): boolean => arr<Raw>(item.adlabels).some(l => {
      const n = str(l.name).toLowerCase()
      return n === PAC_LABEL_STORY || n.includes('story') || n.includes('9x16') || n.includes('reel')
    })
    const videos = arr<Raw>(afs.videos)
    const images = arr<Raw>(afs.images)
    if (videos.length) {
      out.format = 'single_video'
      const story = videos.find(isStory)
      const feed = videos.find(v => !isStory(v)) ?? (story ? undefined : videos[0])
      if (feed && str(feed.video_id)) out.media.feed_4x5 = vidRef(str(feed.video_id), str(feed.thumbnail_hash) || undefined)
      if (story && str(story.video_id)) out.media.story_9x16 = vidRef(str(story.video_id), str(story.thumbnail_hash) || undefined)
    } else if (images.length) {
      const story = images.find(isStory)
      const feed = images.find(i => !isStory(i)) ?? (story ? undefined : images[0])
      if (feed && str(feed.hash)) out.media.feed_4x5 = imgRef(str(feed.hash))
      if (story && str(story.hash)) out.media.story_9x16 = imgRef(str(story.hash))
    }
    if (arr<unknown>(afs.bodies).length > 5 || arr<unknown>(afs.titles).length > 5) warn.push(`Anzeige "${name}": mehr als 5 Textvarianten, nur die ersten 5 übernommen.`)
  } else {
    warn.push(`Anzeige "${name}": Creative aus einem bestehenden Beitrag, Texte und Medien sind nicht übernehmbar.`)
  }

  if (formId) out.destination = { kind: 'lead_form', form_id: formId }
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
  return out
}

// ── Modus ────────────────────────────────────────────────────────────────────

export async function modeImport(ctx: Ctx, req: ImportRequest): Promise<ImportResponse> {
  const level = str(req.level) as Level
  if (level !== 'campaign' && level !== 'adset' && level !== 'ad') throw new BuilderError(400, 'invalid_request', 'level muss campaign, adset oder ad sein.')
  const id = metaId(req.id, 'id')
  const warn: string[] = []
  const settings = await ctx.settings()
  const defaults = { page_id: settings.default_page_id || ctx.env.pageId }

  let campaign: Raw
  let adsets: Raw[]
  let ads: Raw[]
  if (level === 'campaign') {
    campaign = await getOwn(ctx, id, CAMPAIGN_FIELDS, 'Die Kampagne')
    adsets = await graphAll<Raw>(`${id}/adsets`, { fields: ADSET_FIELDS, limit: 100 }, { maxPages: 3 })
    ads = await graphAll<Raw>(`${id}/ads`, { fields: AD_FIELDS, limit: 100 }, { maxPages: 3 })
  } else if (level === 'adset') {
    const a = await getOwn(ctx, id, ADSET_FIELDS, 'Die Anzeigengruppe')
    campaign = await graphGet<Raw>(metaId(a.campaign_id, 'campaign_id'), { fields: CAMPAIGN_FIELDS })
    adsets = [a]
    ads = await graphAll<Raw>(`${id}/ads`, { fields: AD_FIELDS, limit: 100 }, { maxPages: 3 })
  } else {
    const ad = await getOwn(ctx, id, AD_FIELDS, 'Die Anzeige')
    const a = await graphGet<Raw>(metaId(ad.adset_id, 'adset_id'), { fields: ADSET_FIELDS })
    campaign = await graphGet<Raw>(metaId(ad.campaign_id, 'campaign_id'), { fields: CAMPAIGN_FIELDS })
    adsets = [a]
    ads = [ad]
  }

  const spec: DraftSpec = { v: 1, campaign: mapCampaign(campaign, warn), adsets: [], ads: [] }
  const keyById: Record<string, string> = {}
  for (const a of adsets) {
    const as = mapAdset(a, warn)
    keyById[str(a.id)] = as.key
    spec.adsets.push(as)
  }
  for (const ad of ads) {
    const key = keyById[str(ad.adset_id)]
    if (!key) { warn.push(`Anzeige "${str(ad.name)}": Anzeigengruppe ${str(ad.adset_id)} nicht im Import, übersprungen.`); continue }
    spec.ads.push(mapAd(ad, key, defaults, warn))
  }
  if (ads.length >= 300) warn.push('Sehr viele Anzeigen: Liste eventuell unvollständig.')
  return { spec, warnings: warn, source: { level, id } }
}
