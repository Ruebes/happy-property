// meta-builder: Lese-Modi (catalog, audience_eligibility, estimate,
// creative_details, pixel_status, leadgen_lookup, usage). Nichts hier schreibt
// an Meta. Einzelne Teil-Abfragen dürfen scheitern (Warnung statt Abbruch),
// nur das Werbekonto selbst ist Pflicht.

import {
  checkUrlTags, getLastUsage, graphAll, graphGet, GRAPH_VERSION, MetaApiError, metaEnv,
  type GraphParams,
} from '../_shared/metaGraph.ts'
import {
  applyHousing, buildAdsetPayload, buildTargeting, HP_PIXEL_ID, OBJECTIVES,
  type AudienceEligibilityRequest, type AudienceEligibilityResponse, type CampaignDraft, type CatalogRequest,
  type CatalogResponse, type CreativeDetailsRequest, type CreativeDetailsResponse, type EstimateRequest,
  type EstimateResponse, type LeadgenLookupRequest, type LeadgenLookupResponse, type PixelStatusRequest,
  type PixelStatusResponse, type SpecialCat, type UsageRequest, type UsageResponse,
} from '../_shared/metaSpec.ts'
import {
  arr, BuilderError, digits, forbiddenNames, mapPool, metaId, num, obj, str, uniq, usageInfo, type Ctx, type Raw,
} from './common.ts'
import { listLeadForms } from './pages.ts'

const softMsg = (e: unknown): string =>
  e instanceof MetaApiError ? (e.userMsg || e.message).slice(0, 200) : 'unbekannter Fehler'

// ── catalog ──────────────────────────────────────────────────────────────────

/** Instagram-Konto, das an der Seite hängt (für die Standard-Identität). */
export async function pageInstagram(pageId: string): Promise<{ id: string; username?: string; name?: string } | null> {
  const j = await graphGet<Raw>(pageId, { fields: 'instagram_business_account{id,username,name}' })
  const ig = obj(j.instagram_business_account)
  return str(ig.id) ? { id: str(ig.id), ...(str(ig.username) ? { username: str(ig.username) } : {}), ...(str(ig.name) ? { name: str(ig.name) } : {}) } : null
}

/** Konto-Standards für DSA (Begünstigte / Zahlende Person). */
export async function accountDsaDefaults(): Promise<{ beneficiary: string | null; payor: string | null }> {
  const j = await graphGet<Raw>(`act_${metaEnv().account}`, { fields: 'default_dsa_beneficiary,default_dsa_payor' })
  return { beneficiary: str(j.default_dsa_beneficiary) || null, payor: str(j.default_dsa_payor) || null }
}

export async function modeCatalog(ctx: Ctx, _req: CatalogRequest): Promise<CatalogResponse & { warnings: string[] }> {
  const acct = ctx.env.account
  const warnings: string[] = []
  const settings = await ctx.settings()

  // 1. Werbekonto (Pflicht)
  let account: Raw
  try {
    account = await graphGet<Raw>(`act_${acct}`, { fields: 'id,name,currency,timezone_name,account_status,default_dsa_beneficiary,default_dsa_payor' })
  } catch (err) {
    if (err instanceof MetaApiError) throw new BuilderError(502, 'meta_error', `Werbekonto nicht lesbar: ${err.userMsg || err.message}`,
      err.kind === 'auth' ? 'Secret META_ACCESS_TOKEN prüfen (System-User-Token mit ads_management, ads_read).' : 'In ein paar Minuten erneut versuchen.', undefined, err.detail())
    throw err
  }

  // 2. Pixel
  let pixels: CatalogResponse['pixels'] = []
  try {
    const list = await graphAll<Raw>(`act_${acct}/adspixels`, { fields: 'id,name,last_fired_time,is_unavailable', limit: 50 }, { maxPages: 2 })
    pixels = list.map(p => ({
      id: str(p.id), name: str(p.name),
      last_fired_time: str(p.last_fired_time) || null,
      ...(typeof p.is_unavailable === 'boolean' ? { is_unavailable: p.is_unavailable } : {}),
    })).filter(p => p.id)
  } catch (e) { warnings.push(`Pixel: ${softMsg(e)}`) }

  // 3. Benutzerdefinierte Conversions
  let customConversions: CatalogResponse['custom_conversions'] = []
  try {
    const list = await graphAll<Raw>(`act_${acct}/customconversions`, { fields: 'id,name,custom_event_type,pixel', limit: 100 }, { maxPages: 3 })
    customConversions = list.map(c => ({
      id: str(c.id), name: str(c.name),
      ...(str(c.custom_event_type) ? { custom_event_type: str(c.custom_event_type) } : {}),
      ...(str(obj(c.pixel).id) ? { pixel_id: str(obj(c.pixel).id) } : {}),
    })).filter(c => c.id)
  } catch (e) { warnings.push(`Benutzerdefinierte Conversions: ${softMsg(e)}`) }

  // 4. Custom Audiences (Housing-Eignung einzeln über audience_eligibility)
  let audiences: CatalogResponse['custom_audiences'] = []
  try {
    const list = await graphAll<Raw>(`act_${acct}/customaudiences`, {
      fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound', limit: 200,
    }, { maxPages: 3 })
    audiences = list.map(a => ({
      id: str(a.id), name: str(a.name),
      ...(str(a.subtype) ? { subtype: str(a.subtype) } : {}),
      ...(num(a.approximate_count_lower_bound) !== null ? { approximate_count_lower_bound: num(a.approximate_count_lower_bound) as number } : {}),
      ...(num(a.approximate_count_upper_bound) !== null ? { approximate_count_upper_bound: num(a.approximate_count_upper_bound) as number } : {}),
      sac_eligible: null,
    })).filter(a => a.id)
  } catch (e) { warnings.push(`Custom Audiences: ${softMsg(e)}`) }

  // 5. Seiten
  const defaultPage = settings.default_page_id || ctx.env.pageId
  let pages: CatalogResponse['pages'] = []
  try {
    const list = await graphAll<Raw>('me/accounts', { fields: 'id,name', limit: 50 }, { maxPages: 2 })
    pages = list.map(p => ({ id: str(p.id), name: str(p.name) })).filter(p => p.id)
  } catch (e) { warnings.push(`Seiten: ${softMsg(e)}`) }
  if (!pages.some(p => p.id === defaultPage)) {
    let name = ''
    try { name = str((await graphGet<Raw>(defaultPage, { fields: 'name' })).name) } catch (e) { warnings.push(`Seite ${defaultPage}: ${softMsg(e)}`) }
    pages.unshift({ id: defaultPage, name })
  }

  // 6. Instagram-Konten (Werbekonto + an der Standard-Seite)
  const ig: CatalogResponse['instagram_accounts'] = []
  const addIg = (a: { id: string; username?: string; name?: string } | null) => { if (a?.id && !ig.some(x => x.id === a.id)) ig.push(a) }
  let pageIg: { id: string; username?: string; name?: string } | null = null
  try {
    pageIg = await pageInstagram(defaultPage)
    addIg(pageIg)
  } catch (e) { warnings.push(`Instagram-Konto der Seite: ${softMsg(e)}`) }
  try {
    const list = await graphAll<Raw>(`act_${acct}/instagram_accounts`, { fields: 'id,username', limit: 25 }, { maxPages: 1 })
    for (const a of list) addIg(str(a.id) ? { id: str(a.id), ...(str(a.username) ? { username: str(a.username) } : {}) } : null)
  } catch (e) { warnings.push(`Instagram-Konten des Werbekontos: ${softMsg(e)}`) }

  // 7. Sofortformulare (Seiten-Token)
  const leadForms = await listLeadForms(defaultPage, warnings)

  // 8. DSA-Vorschläge
  let dsa: string[] = []
  try {
    const j = await graphGet<Raw>(`act_${acct}/dsa_recommendations`)
    for (const item of arr<unknown>(j.data)) {
      if (typeof item === 'string') dsa.push(item)
      else for (const r of arr<unknown>(obj(item).recommendations)) if (str(r)) dsa.push(str(r))
    }
    dsa = uniq(dsa).slice(0, 25)
  } catch (e) { warnings.push(`DSA-Vorschläge: ${softMsg(e)}`) }

  // 9. Token-Rechte. debug_token braucht den Token als input_token (Query): Fehler
  // dieses Aufrufs werden nie weitergereicht (könnten die URL enthalten).
  const token: CatalogResponse['token'] = { scopes: [] }
  try {
    const j = await graphGet<Raw>('debug_token', { input_token: ctx.env.token }, { retry: false })
    const d = obj(j.data)
    token.scopes = arr<unknown>(d.scopes).map(s => str(s)).filter(Boolean)
    token.is_valid = d.is_valid === true
    const exp = num(d.expires_at)
    token.expires_at = exp && exp > 0 ? exp : null
  } catch {
    try {
      const list = await graphAll<Raw>('me/permissions', { limit: 100 }, { maxPages: 1 })
      token.scopes = list.filter(p => str(p.status) === 'granted').map(p => str(p.permission)).filter(Boolean)
    } catch {
      warnings.push('Token-Rechte nicht lesbar.')
    }
  }

  // 10. Projekt-/Bauträgernamen für den Lint
  const names = await forbiddenNames(ctx.sb)

  const effective = {
    builder_enabled: settings.builder_enabled,
    dsa_beneficiary: settings.dsa_beneficiary,
    dsa_payor: settings.dsa_payor,
    default_page_id: defaultPage,
    default_ig_user_id: settings.default_ig_user_id ?? pageIg?.id ?? null,
    default_pixel_id: settings.default_pixel_id ?? HP_PIXEL_ID,
    default_link: settings.default_link,
    max_account_daily_budget: settings.max_account_daily_budget,
  }
  if (settings.missing) warnings.push('ad_settings ohne Assistenten-Spalten: Migration 20261003100000 fehlt, Standardwerte aktiv.')

  return {
    graph_version: GRAPH_VERSION,
    account: {
      id: digits(account.id) || acct,
      ...(str(account.name) ? { name: str(account.name) } : {}),
      currency: str(account.currency) || 'USD',
      ...(str(account.timezone_name) ? { timezone_name: str(account.timezone_name) } : {}),
      ...(num(account.account_status) !== null ? { account_status: num(account.account_status) as number } : {}),
      default_dsa_beneficiary: str(account.default_dsa_beneficiary) || null,
      default_dsa_payor: str(account.default_dsa_payor) || null,
    },
    pixels,
    custom_conversions: customConversions,
    custom_audiences: audiences,
    pages,
    instagram_accounts: ig,
    lead_forms: leadForms,
    dsa_recommendations: dsa,
    token,
    lint_context: { forbidden_names: names },
    settings: effective,
    usage: usageInfo(getLastUsage()),
    warnings,
  }
}

// ── audience_eligibility ─────────────────────────────────────────────────────

export async function modeAudienceEligibility(ctx: Ctx, req: AudienceEligibilityRequest): Promise<AudienceEligibilityResponse> {
  const ids = uniq(arr<unknown>(req.ids).map(x => str(x).trim())).filter(Boolean)
  if (!ids.length) throw new BuilderError(400, 'invalid_request', 'ids fehlt (Custom-Audience-IDs).')
  if (ids.length > 10) throw new BuilderError(400, 'invalid_request', 'Höchstens 10 Zielgruppen je Abfrage.')
  const countries = arr<unknown>(req.countries).map(c => str(c).toUpperCase()).filter(c => /^[A-Z]{2}$/.test(c))
  const items: AudienceEligibilityResponse['items'] = []
  for (const raw of ids) {
    const id = metaId(raw, 'Zielgruppen-ID')
    try {
      const j = await graphGet<Raw>(id, {
        fields: 'is_eligible_for_sac_campaigns',
        ad_account_id: `act_${ctx.env.account}`,
        special_ad_categories: ['HOUSING'],
        special_ad_category_countries: countries.length ? countries : ['DE'],
      })
      const v = j.is_eligible_for_sac_campaigns
      items.push({ id, sac_eligible: typeof v === 'boolean' ? v : null })
    } catch (e) {
      items.push({ id, sac_eligible: null, reason: softMsg(e) })
    }
  }
  return { items }
}

// ── estimate ─────────────────────────────────────────────────────────────────

export async function modeEstimate(ctx: Ctx, req: EstimateRequest): Promise<EstimateResponse> {
  const objective = str(req.objective)
  if ((OBJECTIVES as readonly string[]).indexOf(objective) < 0) throw new BuilderError(400, 'invalid_request', 'objective fehlt oder ist unbekannt.')
  const adsetIn = obj(req.adset)
  if (!adsetIn.targeting) throw new BuilderError(400, 'invalid_request', 'adset.targeting fehlt.')
  const cats = arr<SpecialCat>(req.special_ad_categories)
  const campaign: CampaignDraft = {
    name: 'Schätzung', objective: objective as CampaignDraft['objective'], buying_type: 'AUCTION',
    special_ad_categories: cats.length ? cats : ['HOUSING'], special_ad_category_country: ['DE'], budget_level: 'adset',
  }
  const housed = applyHousing({ v: 1, campaign, adsets: [req.adset], ads: [] })
  const adset = housed.spec.adsets[0]
  const targeting = buildTargeting(adset, housed.spec.campaign)
  const payload = buildAdsetPayload(adset, housed.spec.campaign, '0')
  const params: GraphParams = { targeting_spec: targeting, optimization_goal: str(adset.optimization_goal) || 'OFFSITE_CONVERSIONS' }
  if (payload.promoted_object && typeof payload.promoted_object === 'object') params.promoted_object = payload.promoted_object as Record<string, unknown>
  const j = await graphGet<Raw>(`act_${ctx.env.account}/delivery_estimate`, params)
  const d = obj(arr<unknown>(j.data)[0])
  return {
    users_lower: num(d.estimate_mau_lower_bound),
    users_upper: num(d.estimate_mau_upper_bound),
    estimate_ready: d.estimate_ready === true,
    raw: d,
  }
}

// ── creative_details ─────────────────────────────────────────────────────────

const CREATIVE_SUB = 'creative{id,url_tags,object_story_spec,asset_feed_spec,link_url,call_to_action_type,effective_object_story_id}'

function creativeLinkInfo(cr: Raw): { link: string | null; cta: string | null; assetLinks: string[] } {
  const oss = obj(cr.object_story_spec)
  const ld = obj(oss.link_data)
  const vd = obj(oss.video_data)
  const afs = obj(cr.asset_feed_spec)
  const assetLinks: string[] = []
  for (const l of arr<Raw>(afs.link_urls)) if (str(l.website_url)) assetLinks.push(str(l.website_url))
  for (const ch of arr<Raw>(ld.child_attachments)) if (str(ch.link)) assetLinks.push(str(ch.link))
  const link = str(ld.link) || str(obj(obj(vd.call_to_action).value).link) || str(cr.link_url) || assetLinks[0] || null
  const cta = str(obj(ld.call_to_action).type) || str(obj(vd.call_to_action).type) || str(cr.call_to_action_type)
    || str(arr<unknown>(afs.call_to_action_types)[0]) || null
  return { link, cta, assetLinks: uniq(assetLinks) }
}

function urlTagProblems(tags: string | null, link: string | null): { ok: boolean; problems: string[] } {
  const c = checkUrlTags(tags, link)
  const problems: string[] = []
  for (const a of c.abweichend) problems.push(a.ist === null ? `${a.key} fehlt (Standard ${a.erwartet})` : `${a.key} = ${a.ist} statt ${a.erwartet}`)
  for (const k of c.doppelt) problems.push(`${k} steht im Link UND in den URL-Parametern`)
  for (const k of c.nurImLink) problems.push(`${k} steht nur fest im Link (nicht je Anzeige)`)
  return { ok: c.ok, problems }
}

export async function modeCreativeDetails(ctx: Ctx, req: CreativeDetailsRequest): Promise<CreativeDetailsResponse> {
  const ids = uniq(arr<unknown>(req.ad_ids).map(x => str(x).trim())).filter(Boolean)
  if (!ids.length) throw new BuilderError(400, 'invalid_request', 'ad_ids fehlt.')
  if (ids.length > 50) throw new BuilderError(400, 'invalid_request', 'Höchstens 50 Anzeigen je Abfrage.')
  for (const id of ids) metaId(id, 'Anzeigen-ID')
  let ads: Raw[] = []
  try {
    ads = await graphAll<Raw>(`act_${ctx.env.account}/ads`, {
      fields: `id,${CREATIVE_SUB}`, filtering: [{ field: 'id', operator: 'IN', value: ids }], limit: 50,
    }, { maxPages: 2 })
  } catch (e) {
    console.warn('[meta-builder] creative_details Filter:', softMsg(e))
    ads = []
  }
  // Rückfall: einzeln (nur fremde Konten fallen hier raus, weil act_X/ads sie nicht liefert)
  const missing = ids.filter(id => !ads.some(a => str(a.id) === id))
  if (missing.length) {
    const more = await mapPool(missing, 4, async id => {
      try {
        const a = await graphGet<Raw>(id, { fields: `id,account_id,${CREATIVE_SUB}` })
        return digits(a.account_id) === ctx.env.account ? a : null
      } catch { return null }
    })
    for (const a of more) if (a) ads.push(a)
  }
  const items: CreativeDetailsResponse['items'] = []
  for (const id of ids) {
    const ad = ads.find(a => str(a.id) === id)
    if (!ad) continue
    const cr = obj(ad.creative)
    const info = creativeLinkInfo(cr)
    const tags = str(cr.url_tags) || null
    items.push({
      ad_id: id,
      ...(str(cr.id) ? { creative_id: str(cr.id) } : {}),
      url_tags: tags,
      link: info.link,
      cta_type: info.cta,
      asset_link_urls: info.assetLinks,
      url_tags_check: urlTagProblems(tags, info.link),
    })
  }
  return { items }
}

// ── pixel_status ─────────────────────────────────────────────────────────────

export async function modePixelStatus(ctx: Ctx, req: PixelStatusRequest): Promise<PixelStatusResponse> {
  const id = metaId(req.pixel_id, 'pixel_id')
  const j = await graphGet<Raw>(id, { fields: 'id,name,last_fired_time,is_unavailable' })
  const st = await ctx.settings()
  return {
    id,
    ...(str(j.name) ? { name: str(j.name) } : {}),
    last_fired_time: str(j.last_fired_time) || null,
    ...(typeof j.is_unavailable === 'boolean' ? { is_unavailable: j.is_unavailable } : {}),
    matches_hp_pixel: id === (st.default_pixel_id || HP_PIXEL_ID),
  }
}

// ── leadgen_lookup ───────────────────────────────────────────────────────────

export async function modeLeadgenLookup(_ctx: Ctx, req: LeadgenLookupRequest): Promise<LeadgenLookupResponse> {
  const ids = uniq(arr<unknown>(req.ids).map(x => str(x).trim())).filter(Boolean)
  if (!ids.length) throw new BuilderError(400, 'invalid_request', 'ids fehlt (Meta-Lead-IDs).')
  if (ids.length > 100) throw new BuilderError(400, 'invalid_request', 'Höchstens 100 Lead-IDs je Abfrage.')
  for (const id of ids) metaId(id, 'Lead-ID')
  const items: LeadgenLookupResponse['items'] = []
  const missing: string[] = []
  let stopped = false
  await mapPool(ids, 4, async id => {
    if (stopped) { missing.push(id); return }
    try {
      // bewusst ohne field_data (keine personenbezogenen Daten)
      const j = await graphGet<Raw>(id, { fields: 'id,ad_id,adset_id,campaign_id,form_id,created_time' })
      items.push({
        id,
        ...(str(j.ad_id) ? { ad_id: str(j.ad_id) } : {}),
        ...(str(j.adset_id) ? { adset_id: str(j.adset_id) } : {}),
        ...(str(j.campaign_id) ? { campaign_id: str(j.campaign_id) } : {}),
        ...(str(j.form_id) ? { form_id: str(j.form_id) } : {}),
        ...(str(j.created_time) ? { created_time: str(j.created_time) } : {}),
      })
    } catch (e) {
      missing.push(id)
      if (e instanceof MetaApiError && (e.kind === 'rate_limit' || e.kind === 'auth')) stopped = true
    }
    if ((getLastUsage()?.accUtilPct ?? 0) > 80) stopped = true
  })
  items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
  return { items, missing }
}

// ── usage ────────────────────────────────────────────────────────────────────

export async function modeUsage(ctx: Ctx, req: UsageRequest): Promise<UsageResponse> {
  await graphGet<Raw>(`act_${ctx.env.account}`, { fields: 'id' })
  return usageInfo(getLastUsage(), req.verbose === true)
}
