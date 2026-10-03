// meta-builder: Entwurfs-Modi validate, create/resume (Schritt-Läufer),
// activate_draft, preview, duplicate (mehrere Objekte, Ziel, Kopien), discard.
//
// Ablauf create/resume (Client ruft resume, solange next != null):
//   Lease (5 min) -> applyHousing + Standardwerte + validateDraft + Lint serverseitig
//   -> Kampagne -> Anzeigengruppen -> Medien -> je Anzeige Creative + Anzeige
//   -> Rücklesen in meta_campaigns/meta_adsets/ad_catalog + studio_prepared_ads.
//   Alles PAUSED. Nach JEDEM POST wird meta_ids gespeichert (wiederaufnehmbar).
//   Pro Aufruf höchstens ~50 s (neuer Schritt nur bis 40 s), dann status
//   'creating' + next, Lease frei. 1885183 (App im Entwicklungsmodus) -> partial.
//   Nichts wird bei Meta gelöscht; Aktivieren ist ein eigener Modus.

import {
  assertOwnAccount, budgetHeadroom, getLastUsage, graphAll, graphGet, GRAPH_VERSION, MetaApiError,
} from '../_shared/metaGraph.ts'
import {
  adByKey, adsetByKey, applyHousing, buildAdPayload, buildAdsetPayload, buildCampaignPayload, buildCreativePayload,
  adKindsFor, cleanName, effectiveAdvantageAudience, HEC_CATEGORIES, hasErrors, hatSprachen, isHec, isRealEstateDraft, LIMITS, PREVIEW_FORMATS,
  PREVIEW_ALLE_FORMATS, previewFormatsFor, promotedRuleFor, SPRACH_LABEL_PREFIX, SPECIAL_AD_CATEGORIES, targetsEu,
  validateDraft, type AdDestinationKind, type DuplicateZiel, type PreviewAlleRequest, type PreviewAlleResponse, type SpecialCat,
  type ActivateDraftRequest, type ActivateDraftResponse, type AdDraft, type AdsetDraft, type BuilderErrorBody,
  type CampaignDraft, type CreateRequest, type CreateResponse, type CreativeBuild, type DiscardRequest,
  type DiscardResponse, type DraftIssue, type DraftLastError, type DraftMetaIds, type DraftSpec, type DraftStatus,
  type DuplicateRequest, type DuplicateResponse, type GuardrailInfo, type Level, type MetaLevelResult,
  type MediaRef, type MetaMediaRow, type Placements, type PreviewFormat, type PreviewRequest, type PreviewResponse, type ValidateRequest,
  type ValidateResponse,
} from '../_shared/metaSpec.ts'
import { DASH_CHARS, lintDraft, type LintContext, type LintIssue, type LintMediaInfo } from '../_shared/metaLint.ts'
import {
  adMediaRefs, APP_DEV_MODE_HINT, arr, BuilderError, digits, eigeneVorschaubilder, errText, fillAdMedia, forbiddenNames, fromMetaError,
  guardrailInfo, hashSpec, isUuid, issuesFromError, leaseActive, LEASE_MS, loadDraft, loadMediaRows, metaHint,
  metaId, metaPost, nowIso, num, obj, sha256Hex, specOf, stableStringify, str, uniq, VALIDATION_MAX_AGE_MS,
  type Ctx, type DraftRow, type MediaIds, type Raw, type StoredValidation,
} from './common.ts'
import { accountDsaDefaults, pageInstagram } from './catalog.ts'
import { ensureMediaReady, retryVideoThumbnails } from './media.ts'
import { readback } from './readback.ts'

const VALIDATE_CALL_CAP = 15
const VALIDATE_MAX_UTIL_PCT = 70
const RUN_BUDGET_MS = 50_000
const STEP_START_CUTOFF_MS = 40_000
const DEAD_STATUS = ['DELETED', 'ARCHIVED']

const leaseBusy = () => new BuilderError(409, 'lease_busy', 'Dieser Entwurf wird gerade bei Meta angelegt.', 'In einer Minute erneut versuchen.')
const fmtEur = (n: number) => n.toFixed(2).replace('.', ',')

function levelsParam(v: unknown): Set<Level> {
  const out = new Set<Level>()
  for (const x of arr<unknown>(v)) if (x === 'campaign' || x === 'adset' || x === 'ad') out.add(x)
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// Vorbereitung: Standardwerte, Wohnen-Regeln, Medien, Lint-Kontext
// ═══════════════════════════════════════════════════════════════════════════

interface Prepared {
  spec: DraftSpec
  lintCtx: LintContext
  mediaRows: Record<string, MetaMediaRow>
}

/**
 * Sonderkategorien einer bestehenden Ziel-Kampagne: live bei Meta, sonst aus dem
 * Spiegel meta_campaigns. null = unbekannt (dann gilt, was im Entwurf steht).
 */
async function targetCategories(ctx: Ctx, campaignId: string): Promise<{ cats: string[]; countries: string[] } | null> {
  const list = (v: unknown) => arr<unknown>(v).map(str).filter(Boolean)
  try {
    const j = await graphGet<Raw>(metaId(campaignId, 'Kampagnen-ID'), { fields: 'id,special_ad_categories,special_ad_category_country' })
    return { cats: list(j.special_ad_categories), countries: list(j.special_ad_category_country) }
  } catch (e) { console.warn('[meta-builder] Sonderkategorie der Ziel-Kampagne (live):', errText(e).slice(0, 200)) }
  const { data, error } = await ctx.sb.from('meta_campaigns')
    .select('special_ad_categories, special_ad_category_country').eq('campaign_id', campaignId).maybeSingle()
  if (error || !data) return null
  const r = obj(data)
  return { cats: list(r.special_ad_categories), countries: list(r.special_ad_category_country) }
}

/** Leere Pflichtwerte NEUER Knoten aus den Einstellungen/Meta füllen (Seite, IG-Konto, DSA). */
async function fillDefaults(ctx: Ctx, spec: DraftSpec): Promise<void> {
  const st = await ctx.settings()
  const page = st.default_page_id || ctx.env.pageId
  let ig: string | null = st.default_ig_user_id
  let igLooked = !!ig
  for (const ad of spec.ads) {
    if (ad.existing_id) continue
    if (!ad.identity || typeof ad.identity !== 'object') ad.identity = { page_id: '', instagram_user_id: '' }
    if (!str(ad.identity.page_id).trim()) ad.identity.page_id = page
    // IG-Standard gehört zur Standard-Seite: nur dort automatisch ergänzen
    if (!str(ad.identity.instagram_user_id).trim() && ad.identity.page_id === page) {
      if (!igLooked) {
        igLooked = true
        try { ig = (await pageInstagram(page))?.id ?? null } catch { ig = null }
      }
      if (ig) ad.identity.instagram_user_id = ig
    }
  }
  // Seite im promoted_object (WhatsApp, Anrufe, Messenger, Sofortformular): Standard-Seite, wenn leer
  for (const a of spec.adsets) {
    if (a.existing_id) continue
    const rule = promotedRuleFor(spec.campaign.objective, a.destination, a.optimization_goal)
    if (rule && rule.anyOf.length === 1 && rule.anyOf[0].indexOf('page_id') >= 0) {
      if (!a.promoted_object || typeof a.promoted_object !== 'object') a.promoted_object = {}
      if (!str(a.promoted_object.page_id).trim()) a.promoted_object.page_id = page
    }
  }
  // Advantage+ Zielgruppe immer ausdrücklich (fehlt = 1, so wie buildTargeting sendet)
  for (const a of spec.adsets) {
    if (a.existing_id || !a.targeting || typeof a.targeting !== 'object') continue
    const ta = a.targeting.targeting_automation && typeof a.targeting.targeting_automation === 'object' ? a.targeting.targeting_automation : {}
    if (ta.advantage_audience !== 0 && ta.advantage_audience !== 1) {
      ta.advantage_audience = effectiveAdvantageAudience(ta.advantage_audience)
      a.targeting.targeting_automation = ta
    }
  }
  const needDsa = spec.adsets.filter(a => !a.existing_id && targetsEu(a.targeting) && (!str(a.dsa_beneficiary).trim() || !str(a.dsa_payor).trim()))
  if (!needDsa.length) return
  let ben = st.dsa_beneficiary
  let pay = st.dsa_payor
  if (!ben || !pay) {
    try {
      const d = await accountDsaDefaults()
      ben = ben || d.beneficiary
      pay = pay || d.payor
    } catch (e) { console.warn('[meta-builder] DSA-Standard:', errText(e).slice(0, 200)) }
  }
  for (const a of needDsa) {
    if (!str(a.dsa_beneficiary).trim() && ben) a.dsa_beneficiary = ben
    if (!str(a.dsa_payor).trim() && pay) a.dsa_payor = pay
  }
}

async function prepareSpec(ctx: Ctx, draft: DraftRow, extraMedia: Record<string, MediaIds>): Promise<Prepared> {
  const raw = specOf(draft)
  await fillDefaults(ctx, raw)
  // Bestehende Ziel-Kampagne (add_adsets/add_ads/edit): ihre echte Sonderkategorie zählt,
  // nicht der Stand beim Import. Mit HOUSING greifen die Wohnen-Regeln auch für neue Gruppen.
  const campExisting = str(raw.campaign.existing_id) || str(draft.target_campaign_id)
  if (campExisting) {
    const t = await targetCategories(ctx, campExisting)
    if (t) {
      const known = SPECIAL_AD_CATEGORIES as readonly string[]
      raw.campaign.special_ad_categories = t.cats.filter(x => known.indexOf(x) >= 0) as SpecialCat[]
      if (t.countries.length) raw.campaign.special_ad_category_country = t.countries
    }
  }
  const spec = applyHousing(raw).spec
  const refs = spec.ads.flatMap(adMediaRefs).map(r => r.media_id)
  const mediaRows = await loadMediaRows(ctx.sb, refs)
  // Fertige Videos ohne Vorschaubild: jetzt nachholen (sonst bleibt video_thumb_missing stehen)
  await retryVideoThumbnails(ctx, mediaRows, draft.id)
  spec.ads = spec.ads.map(ad => (ad.existing_id ? ad : fillAdMedia(ad, mediaRows, extraMedia)))
  const media: Record<string, LintMediaInfo> = {}
  for (const id of Object.keys(mediaRows)) {
    const r = mediaRows[id]
    media[id] = {
      storage_path: r.storage_path, public_url: r.public_url, ai_generated: r.ai_generated,
      eu_band_confirmed: r.eu_band_confirmed, ki_label_confirmed: r.ki_label_confirmed,
    }
  }
  return { spec, mediaRows, lintCtx: { forbiddenNames: await forbiddenNames(ctx.sb), media } }
}

/** Lint nur für Knoten, die neu angelegt werden (bestehende Anzeigen blockieren nichts). */
function lintNew(spec: DraftSpec, lctx: LintContext): LintIssue[] {
  return lintDraft({
    campaign: spec.campaign.existing_id ? {} : { name: spec.campaign.name },
    adsets: spec.adsets.filter(a => !a.existing_id).map(a => ({ key: a.key, name: a.name })),
    ads: spec.ads.filter(a => !a.existing_id),
  }, lctx)
}

/** Tagesbudget (USD-Cent), das dieser Entwurf neu dazubringt (Laufzeitbudget je Resttag). */
function draftDailyUsdCents(spec: DraftSpec): number {
  const now = Date.now()
  const perDay = (total: number, end?: string): number => {
    const e = end ? Date.parse(end) : NaN
    const days = Number.isFinite(e) ? Math.max(1, Math.ceil((e - now) / 86_400_000)) : 1
    return Math.round(total / days)
  }
  const c = spec.campaign
  if (c.budget_level === 'campaign') {
    if (c.existing_id) return 0
    return (c.daily_budget_cents ?? 0) > 0 ? (c.daily_budget_cents ?? 0) : perDay(c.lifetime_budget_cents ?? 0, c.stop_time)
  }
  let sum = 0
  for (const a of spec.adsets) {
    if (a.existing_id) continue
    sum += (a.daily_budget_cents ?? 0) > 0 ? (a.daily_budget_cents ?? 0) : perDay(a.lifetime_budget_cents ?? 0, a.end_time ?? c.stop_time)
  }
  return sum
}

// ═══════════════════════════════════════════════════════════════════════════
// Platzhalter-Objekte für validate_only (Anzeigengruppen brauchen eine Kampagne,
// Anzeigen eine Anzeigengruppe). validate_only verändert nichts bei Meta.
// ═══════════════════════════════════════════════════════════════════════════

const hecKey = (cats: readonly string[]): string =>
  cats.filter(x => (HEC_CATEGORIES as readonly string[]).indexOf(x) >= 0).sort().join(',')

async function findProxyCampaign(ctx: Ctx, c: CampaignDraft): Promise<string | null> {
  interface Cand { id: string; name: string; cats: string[]; budget: boolean; status: string; sharing: boolean }
  const toCand = (r: Raw, idKey: string, dKey: string, lKey: string): Cand => ({
    id: str(r[idKey]), name: str(r.name), cats: arr<unknown>(r.special_ad_categories).map(str),
    budget: (num(r[dKey]) ?? 0) > 0 || (num(r[lKey]) ?? 0) > 0, status: str(r.effective_status) || str(r.status),
    sharing: r.is_adset_budget_sharing_enabled === true,
  })
  let cands: Cand[] = []
  const { data, error } = await ctx.sb.from('meta_campaigns')
    .select('campaign_id, account_id, name, objective, special_ad_categories, daily_budget_cents, lifetime_budget_cents, effective_status, status, is_adset_budget_sharing_enabled')
    .eq('objective', c.objective).limit(100)
  if (!error) {
    cands = arr<Raw>(data).filter(r => !str(r.account_id) || digits(r.account_id) === ctx.env.account)
      .map(r => toCand(r, 'campaign_id', 'daily_budget_cents', 'lifetime_budget_cents'))
  }
  if (!cands.length) {
    try {
      const list = await graphAll<Raw>(`act_${ctx.env.account}/campaigns`, {
        fields: 'id,name,objective,special_ad_categories,daily_budget,lifetime_budget,effective_status,is_adset_budget_sharing_enabled', limit: 100,
      }, { maxPages: 2 })
      cands = list.filter(r => str(r.objective) === c.objective).map(r => toCand(r, 'id', 'daily_budget', 'lifetime_budget'))
    } catch (e) { console.warn('[meta-builder] Platzhalter-Kampagne:', errText(e).slice(0, 200)) }
  }
  const want = hecKey(c.special_ad_categories ?? [])
  const cbo = c.budget_level === 'campaign'
  const score = (x: Cand) => (/pr(ü|ue)f/i.test(x.name) ? 0 : 2) + (x.status === 'ACTIVE' ? 1 : 0)
  const ok = cands
    // Budget-Teilung muss passen: in einer Kampagne mit Teilung verlangt Meta
    // gleiche Pixel/Gebote aller Gruppen (Fehler 4834009), das verfälscht die Prüfung.
    .filter(x => x.id && DEAD_STATUS.indexOf(x.status) < 0 && hecKey(x.cats) === want && x.budget === cbo
      && (cbo || x.sharing === (c.is_adset_budget_sharing_enabled === true)))
    .sort((a, b) => score(a) - score(b))
  return ok[0]?.id ?? null
}

/** Conversion-Orte bei Meta, deren Anzeigengruppen Anzeigen dieser Ziel-Art annehmen ('' = alt, ohne Angabe). */
function proxyDestinations(kind: AdDestinationKind): string[] {
  const out: string[] = kind === 'website' ? [''] : []
  for (const d of ['WEBSITE', 'UNDEFINED', 'WEBSITE_AND_PHONE_CALL', 'ON_AD', 'WEBSITE_AND_LEAD_FORM', 'WHATSAPP', 'PHONE_CALL', 'MESSENGER'] as const) {
    if (adKindsFor(d).indexOf(kind) >= 0) out.push(d)
  }
  return out
}

async function findProxyAdset(ctx: Ctx, campaignId: string, kind: AdDestinationKind): Promise<string | null> {
  let rows: Array<{ id: string; dest: string; status: string }> = []
  const { data, error } = await ctx.sb.from('meta_adsets').select('adset_id, destination_type, effective_status').eq('campaign_id', campaignId).limit(50)
  if (!error) rows = arr<Raw>(data).map(r => ({ id: str(r.adset_id), dest: str(r.destination_type), status: str(r.effective_status) }))
  if (!rows.length) {
    try {
      const list = await graphAll<Raw>(`${campaignId}/adsets`, { fields: 'id,destination_type,effective_status', limit: 50 }, { maxPages: 1 })
      rows = list.map(r => ({ id: str(r.id), dest: str(r.destination_type), status: str(r.effective_status) }))
    } catch (e) { console.warn('[meta-builder] Platzhalter-Anzeigengruppe:', errText(e).slice(0, 200)) }
  }
  const passend = proxyDestinations(kind)
  return rows.find(r => r.id && DEAD_STATUS.indexOf(r.status) < 0 && passend.indexOf(r.dest) >= 0)?.id ?? null
}

// ═══════════════════════════════════════════════════════════════════════════
// validate
// ═══════════════════════════════════════════════════════════════════════════

async function validateAtMeta(
  ctx: Ctx, draft: DraftRow, spec: DraftSpec, ids: DraftMetaIds, local: DraftIssue[], levels: Set<Level>,
): Promise<MetaLevelResult[]> {
  const acct = ctx.env.account
  const results: MetaLevelResult[] = []
  const errNodes = new Set(local.filter(i => i.severity === 'error').map(i => `${i.level}:${i.node}`))
  let calls = 0
  let stop: string | null = null
  let adDevMode = false
  const skip = (level: Level, key: string, reason: string) => results.push({ level, key, ok: true, skipped: reason, issues: [] })
  const blocked = (): string | null => {
    if (stop) return stop
    if (calls >= VALIDATE_CALL_CAP) return 'call_cap'
    const u = getLastUsage()
    if (u && u.accUtilPct > VALIDATE_MAX_UTIL_PCT) return 'rate_limit'
    return null
  }
  const check = async (level: Level, key: string, path: string, body: Raw, syncReview = false): Promise<void> => {
    const why = blocked()
    if (why) { skip(level, key, why); return }
    calls++
    try {
      await metaPost(ctx, path, body, { level, draftId: draft.id, validateOnly: true, syncReview })
      results.push({ level, key, ok: true, issues: [] })
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err
      if (err.kind === 'dev_mode') { skip(level, key, 'app_dev_mode'); if (level === 'ad') adDevMode = true; return }
      if (err.kind === 'rate_limit') { stop = 'rate_limit'; skip(level, key, 'rate_limit'); return }
      if (err.kind === 'transient') { skip(level, key, 'meta_unreachable'); return }
      if (err.userMsg === 'META_WRITES_DISABLED') { skip(level, key, 'writes_disabled'); return }
      if (err.kind === 'auth' || err.kind === 'deprecated_version') {
        stop = 'meta_error'
        results.push({ level, key, ok: false, issues: [{ field_key: null, title: 'Meta', user_msg: `${err.userMsg || err.message} ${metaHint(err)}`, ...(err.code !== null ? { code: err.code } : {}) }] })
        return
      }
      results.push({ level, key, ok: false, issues: issuesFromError(level, err) })
    }
  }

  const c = spec.campaign
  const campExisting = c.existing_id || draft.target_campaign_id || ''
  const campaignId: string | null = campExisting || ids.campaign || null
  let proxyCampaign: string | null | undefined
  const proxy = async (): Promise<string | null> => {
    if (proxyCampaign === undefined) proxyCampaign = await findProxyCampaign(ctx, c)
    return proxyCampaign
  }

  if (levels.has('campaign')) {
    if (campExisting) skip('campaign', 'campaign', 'existing')
    else if (ids.campaign) skip('campaign', 'campaign', 'created')
    else if (errNodes.has('campaign:campaign')) skip('campaign', 'campaign', 'local_errors')
    else await check('campaign', 'campaign', `act_${acct}/campaigns`, buildCampaignPayload(c))
  }

  if (levels.has('adset')) {
    for (const a of spec.adsets) {
      if (a.existing_id) { skip('adset', a.key, 'existing'); continue }
      if (ids.adsets?.[a.key]) { skip('adset', a.key, 'created'); continue }
      if (errNodes.has(`adset:${a.key}`)) { skip('adset', a.key, 'local_errors'); continue }
      const cid = campaignId ?? await proxy()
      if (!cid) { skip('adset', a.key, 'no_proxy_campaign'); continue }
      await check('adset', a.key, `act_${acct}/adsets`, buildAdsetPayload(a, c, cid))
    }
  }

  if (levels.has('ad')) {
    const adsetCache: Record<string, string | null> = {}
    for (const ad of spec.ads) {
      if (ad.existing_id) { skip('ad', ad.key, 'existing'); continue }
      if (ids.ads?.[ad.key]) { skip('ad', ad.key, 'created'); continue }
      if (errNodes.has(`ad:${ad.key}`)) { skip('ad', ad.key, 'local_errors'); continue }
      if (adDevMode) { skip('ad', ad.key, 'app_dev_mode'); continue }
      const as = adsetByKey(spec, ad.adset_key)
      if (!as) { skip('ad', ad.key, 'local_errors'); continue }
      let adsetId: string | null = as.existing_id || ids.adsets?.[as.key] || null
      if (!adsetId) {
        const kind: AdDestinationKind = ad.destination?.kind ?? 'website'
        const ck = `${as.key}:${kind}`
        if (adsetCache[ck] === undefined) {
          let found: string | null = campaignId ? await findProxyAdset(ctx, campaignId, kind) : null
          if (!found) { const p = await proxy(); if (p && p !== campaignId) found = await findProxyAdset(ctx, p, kind) }
          adsetCache[ck] = found
        }
        adsetId = adsetCache[ck]
      }
      if (!adsetId) { skip('ad', ad.key, 'no_proxy_adset'); continue }
      let creative: CreativeBuild
      try { creative = buildCreativePayload(ad, { placements: as.placements }) } catch { skip('ad', ad.key, 'media_not_ready'); continue }
      await check('ad', ad.key, `act_${acct}/ads`, buildAdPayload(ad, adsetId, creative.payload, { draftId: draft.id }), true)
    }
  }
  return results
}

export async function modeValidate(ctx: Ctx, req: ValidateRequest): Promise<ValidateResponse> {
  const draft = await loadDraft(ctx, req.draft_id)
  if (draft.status === 'discarded') throw new BuilderError(409, 'invalid_request', 'Der Entwurf ist verworfen.')
  if (draft.status === 'creating' && leaseActive(draft)) throw leaseBusy()
  const specHash = await hashSpec(draft.spec)
  const ids: DraftMetaIds = draft.meta_ids ?? {}
  const prep = await prepareSpec(ctx, draft, ids.media ?? {})
  const local = validateDraft(prep.spec, { realEstate: isRealEstateDraft(draft.template_key), server: true })
  const lint = lintNew(prep.spec, prep.lintCtx)
  const levels = levelsParam(req.levels)
  if (!levels.size) { levels.add('campaign'); levels.add('adset'); levels.add('ad') }

  let guardrail: GuardrailInfo | null = null
  try {
    guardrail = guardrailInfo(await budgetHeadroom(ctx.sb, { addDailyUsdCents: draftDailyUsdCents(prep.spec) }))
  } catch (e) { console.warn('[meta-builder] Leitplanke:', errText(e).slice(0, 200)) }

  const meta = await validateAtMeta(ctx, draft, prep.spec, ids, local, levels)
  const v: StoredValidation = {
    ok: !hasErrors(local) && !lint.some(i => i.severity === 'blocker') && meta.every(m => m.ok),
    local, lint, meta, guardrail, validated_at: nowIso(), spec_hash: specHash, graph_version: GRAPH_VERSION,
  }
  const patch: Raw = { validation: v, lint }
  if (draft.status === 'draft' || draft.status === 'validated' || draft.status === 'failed') patch.status = v.ok ? 'validated' : 'draft'
  const { error } = await ctx.sb.from('meta_drafts').update(patch).eq('id', draft.id)
  if (error) console.warn('[meta-builder] Prüfergebnis speichern:', String(error.message ?? error).slice(0, 200))
  return v
}

// ═══════════════════════════════════════════════════════════════════════════
// create / resume
// ═══════════════════════════════════════════════════════════════════════════

interface RunState {
  ctx: Ctx
  draft: DraftRow
  lease: string
  start: number
  spec: DraftSpec
  ids: DraftMetaIds
  mediaRows: Record<string, MetaMediaRow>
  campaignExisting: string
  logExtra?: Raw
  current: { step: string; key: string }
  finished: boolean
}

const hasCreated = (ids: DraftMetaIds): boolean =>
  !!(ids.campaign || Object.keys(ids.adsets ?? {}).length || Object.keys(ids.creatives ?? {}).length || Object.keys(ids.ads ?? {}).length)

function ensureIdMaps(ids: DraftMetaIds): Required<Pick<DraftMetaIds, 'adsets' | 'creatives' | 'ads' | 'media' | 'hashes'>> & DraftMetaIds {
  ids.adsets = ids.adsets ?? {}
  ids.creatives = ids.creatives ?? {}
  ids.ads = ids.ads ?? {}
  ids.media = ids.media ?? {}
  ids.hashes = ids.hashes ?? {}
  return ids as Required<Pick<DraftMetaIds, 'adsets' | 'creatives' | 'ads' | 'media' | 'hashes'>> & DraftMetaIds
}

// ── Fingerabdrücke angelegter Knoten (Abgleich beim Fortsetzen) ──────────────

const nodeHash = async (v: unknown): Promise<string> => (await sha256Hex(stableStringify(v))).slice(0, 24)

/**
 * Anzeige/Creative: Inhalt des Knotens ohne aufgelöste Medien-Hashes (die ergänzt der Server) + Platzierungen
 * der Gruppe. Bleiben: Zuschnitt und gewähltes Video-Vorschaubild (eigenes Bild bzw. Metas Vorschlag).
 */
function adFingerprint(ad: AdDraft, spec: DraftSpec): Promise<string> {
  const a = JSON.parse(JSON.stringify(ad)) as AdDraft
  const m = a.media ?? {}
  const strip = (r: MediaRef | undefined): MediaRef | undefined => {
    if (!r || !r.media_id) return r
    const out: MediaRef = { media_id: r.media_id }
    if (r.crops && Object.keys(r.crops).length) out.crops = r.crops
    if (r.thumbnail_media_id) out.thumbnail_media_id = r.thumbnail_media_id
    if (r.thumbnail_quelle) out.thumbnail_quelle = r.thumbnail_quelle
    if (r.thumbnail_quelle === 'meta_liste' && r.thumbnail_hash) out.thumbnail_hash = r.thumbnail_hash
    return out
  }
  if (m.feed_4x5) m.feed_4x5 = strip(m.feed_4x5)
  if (m.story_9x16) m.story_9x16 = strip(m.story_9x16)
  if (m.square_1x1) m.square_1x1 = strip(m.square_1x1)
  if (m.landscape_191x1) m.landscape_191x1 = strip(m.landscape_191x1)
  if (m.cards) m.cards = m.cards.map(cd => (cd?.media ? { ...cd, media: strip(cd.media) as MediaRef } : cd))
  return nodeHash({ ad: a, placements: adsetByKey(spec, ad.adset_key)?.placements ?? null })
}

/** Präfix der Fingerabdrücke ab Runde 2 (mit Zuschnitt und Vorschaubild). */
const FP_V2 = 'v2:'

/** Fingerabdruck vor Runde 2 (nur media_id): Entwürfe, die vor dem Update angelegt wurden, laufen weiter. */
function adFingerprintAlt(ad: AdDraft, spec: DraftSpec): Promise<string> {
  const a = JSON.parse(JSON.stringify(ad)) as AdDraft
  const m = a.media ?? {}
  const strip = (r: { media_id: string } | undefined) => (r && r.media_id ? { media_id: r.media_id } : r)
  if (m.feed_4x5) m.feed_4x5 = strip(m.feed_4x5) as typeof m.feed_4x5
  if (m.story_9x16) m.story_9x16 = strip(m.story_9x16) as typeof m.story_9x16
  if (m.square_1x1) m.square_1x1 = strip(m.square_1x1) as typeof m.square_1x1
  if (m.cards) m.cards = m.cards.map(cd => (cd?.media ? { ...cd, media: strip(cd.media) as typeof cd.media } : cd))
  return nodeHash({ ad: a, placements: adsetByKey(spec, ad.adset_key)?.placements ?? null })
}

/**
 * Fortsetzen nur, wenn alles schon Angelegte noch unverändert im Entwurf steht.
 * Sonst würde resume Geändertes stillschweigend überspringen (altes Creative,
 * altes Budget) und activate_draft Entferntes einschalten.
 */
async function assertCreatedUnchanged(st: RunState): Promise<void> {
  const { spec, ids } = st
  const fresh = (list: Array<{ key: string; existing_id?: string }>, key: string) => list.some(x => x.key === key && !x.existing_id)
  const missing: string[] = []
  for (const k of Object.keys(ids.adsets ?? {})) if (!fresh(spec.adsets, k)) missing.push(`adset:${k}`)
  for (const k of Object.keys(ids.creatives ?? {})) if (!fresh(spec.ads, k)) missing.push(`creative:${k}`)
  for (const k of Object.keys(ids.ads ?? {})) if (!fresh(spec.ads, k)) missing.push(`ad:${k}`)
  const h = ids.hashes ?? {}
  const changed: string[] = []
  const c = spec.campaign
  if (ids.campaign && !st.campaignExisting && h.campaign && h.campaign !== await nodeHash(buildCampaignPayload(c))) changed.push('campaign')
  const campaignId = st.campaignExisting || ids.campaign || ''
  for (const a of spec.adsets) {
    const k = `adset:${a.key}`
    if (a.existing_id || !ids.adsets?.[a.key] || !h[k]) continue
    if (h[k] !== await nodeHash(buildAdsetPayload(a, c, campaignId))) changed.push(k)
  }
  for (const ad of spec.ads) {
    if (ad.existing_id) continue
    const hc = h[`creative:${ad.key}`], ha = h[`ad:${ad.key}`]
    if (!(ids.creatives?.[ad.key] && hc) && !(ids.ads?.[ad.key] && ha)) continue
    const fp = await adFingerprint(ad, spec)
    let alt: string | null = null
    // Neue Fingerabdrücke tragen das Präfix FP_V2 und werden nur mit dem neuen
    // Verfahren verglichen. Ohne Präfix stammen sie von vor Runde 2 (nur media_id)
    // und werden nur mit dem alten Verfahren verglichen. So kann eine nachträglich
    // geänderte Zuschnitt-/Vorschaubild-Wahl nie über den alten Abdruck durchrutschen.
    const gleich = async (h0: string): Promise<boolean> => {
      if (h0.startsWith(FP_V2)) return h0 === FP_V2 + fp
      if (alt === null) alt = await adFingerprintAlt(ad, spec)
      return h0 === alt
    }
    if (ids.creatives?.[ad.key] && hc && !(await gleich(hc))) changed.push(`creative:${ad.key}`)
    if (ids.ads?.[ad.key] && ha && !(await gleich(ha))) changed.push(`ad:${ad.key}`)
  }
  if (!missing.length && !changed.length) return
  const parts = [
    ...(missing.length ? [`entfernt: ${missing.join(', ')}`] : []),
    ...(changed.length ? [`geändert: ${changed.join(', ')}`] : []),
  ]
  throw new BuilderError(409, 'created_changed',
    `Schon bei Meta Angelegtes wurde danach im Entwurf entfernt oder geändert (${parts.join('; ')}). Fortsetzen würde etwas anderes anlegen, als der Entwurf zeigt.`,
    'Änderungen an schon angelegten Teilen zurücknehmen oder den Entwurf verwerfen und neu anlegen. Bei Meta Angelegtes bleibt pausiert.',
    { missing, changed, meta_ids: ids })
}

function doneSteps(spec: DraftSpec, ids: DraftMetaIds, campaignExisting: string): string[] {
  const out: string[] = []
  if (campaignExisting || ids.campaign) out.push('campaign')
  for (const a of spec.adsets) if (a.existing_id || ids.adsets?.[a.key]) out.push(`adset:${a.key}`)
  for (const mid of Object.keys(ids.media ?? {})) out.push(`media:${mid}`)
  for (const ad of spec.ads) {
    if (ids.creatives?.[ad.key]) out.push(`creative:${ad.key}`)
    if (ad.existing_id || ids.ads?.[ad.key]) out.push(`ad:${ad.key}`)
  }
  return out
}

function nextStep(spec: DraftSpec, ids: DraftMetaIds, campaignExisting: string): string {
  if (!(campaignExisting || ids.campaign)) return 'campaign'
  for (const a of spec.adsets) if (!(a.existing_id || ids.adsets?.[a.key])) return `adset:${a.key}`
  for (const ad of spec.ads) {
    if (ad.existing_id || ids.ads?.[ad.key]) continue
    if (!ids.creatives?.[ad.key]) {
      const mid = adMediaRefs(ad).map(r => r.media_id).find(m => isUuid(m) && !ids.media?.[m])
      return mid ? `media:${mid}` : `creative:${ad.key}`
    }
    return `ad:${ad.key}`
  }
  return 'readback'
}

async function finish(st: RunState, status: DraftStatus, lastError: Raw | null): Promise<void> {
  if (st.finished) return
  st.finished = true
  const { error } = await st.ctx.sb.from('meta_drafts')
    .update({ status, run_lease: null, run_lease_at: null, meta_ids: st.ids, last_error: lastError })
    .eq('id', st.draft.id).eq('run_lease', st.lease)
  if (error) console.error('[meta-builder] Lauf abschließen:', String(error.message ?? error).slice(0, 200))
}

/** meta_ids nach einem POST sichern (nur solange die Lease uns gehört). */
async function persistIds(st: RunState): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await st.ctx.sb.from('meta_drafts')
      .update({ meta_ids: st.ids, last_error: null, run_lease_at: nowIso() })
      .eq('id', st.draft.id).eq('run_lease', st.lease).select('id')
    if (!error) {
      if (arr(data).length) return
      st.finished = true
      throw new BuilderError(409, 'lease_busy', 'Ein anderer Lauf hat diesen Entwurf übernommen.', 'Die schon angelegten IDs stehen in data.meta_ids.', { meta_ids: st.ids })
    }
    console.error('[meta-builder] meta_ids speichern:', String(error.message ?? error).slice(0, 200))
  }
  throw new BuilderError(500, 'internal', 'Die neue Meta-ID konnte nicht gespeichert werden. Lauf angehalten, damit nichts doppelt angelegt wird.',
    'Später fortsetzen. Die IDs stehen auch im Schreibprotokoll (meta_write_log).', { meta_ids: st.ids })
}

/**
 * Nach einem Absturz: erfolgreiche Neuanlagen aus meta_write_log übernehmen, die
 * noch nicht in meta_ids stehen (z. B. wenn das Speichern nach dem POST scheiterte).
 */
async function reconcileFromLog(st: RunState): Promise<void> {
  const { data, error } = await st.ctx.sb.from('meta_write_log')
    .select('entity_level, entity_id, path, request, mode')
    .eq('draft_id', st.draft.id).eq('ok', true).eq('validate_only', false)
    .in('mode', ['create', 'resume']).order('ts', { ascending: true }).limit(500)
  if (error) { console.warn('[meta-builder] Protokoll-Abgleich:', String(error.message ?? error).slice(0, 200)); return }
  const ids = ensureIdMaps(st.ids)
  const uniqueKey = <T extends { key: string; existing_id?: string }>(list: T[], nameOf: (x: T) => string, name: string, taken: Record<string, string>): string | null => {
    const hits = list.filter(x => !x.existing_id && nameOf(x) === name)
    return hits.length === 1 && !taken[hits[0].key] ? hits[0].key : null
  }
  let changed = false
  for (const row of arr<Raw>(data)) {
    const level = str(row.entity_level)
    const eid = str(row.entity_id)
    const path = str(row.path)
    const name = str(obj(row.request).name)
    if (!/^[0-9]{6,25}$/.test(eid)) continue
    if (level === 'campaign' && path.endsWith('/campaigns') && !ids.campaign && !st.campaignExisting) { ids.campaign = eid; changed = true }
    else if (level === 'adset' && path.endsWith('/adsets')) {
      const k = uniqueKey(st.spec.adsets, a => cleanName(a.name), name, ids.adsets)
      if (k && !Object.values(ids.adsets).includes(eid)) { ids.adsets[k] = eid; changed = true }
    } else if (level === 'creative' && path.endsWith('/adcreatives')) {
      const k = uniqueKey(st.spec.ads, a => cleanName(a.name, 100), name, ids.creatives)
      if (k && !Object.values(ids.creatives).includes(eid)) { ids.creatives[k] = eid; changed = true }
    } else if (level === 'ad' && path.endsWith('/ads')) {
      const k = uniqueKey(st.spec.ads, a => cleanName(a.name), name, ids.ads)
      if (k && !Object.values(ids.ads).includes(eid)) { ids.ads[k] = eid; changed = true }
    }
  }
  if (changed) {
    console.log(`[meta-builder] ${st.draft.id}: IDs aus meta_write_log übernommen`)
    await persistIds(st)
  }
}

/**
 * Lief der letzte POST in eine Zeitüberschreitung (last_error.uncertain), kann das
 * Objekt trotzdem entstanden sein. Vor dem erneuten Anlegen bei Meta nachsehen.
 */
async function recoverUncertain(st: RunState, step: 'campaign' | 'adset' | 'ad', key: string, name: string, parentId: string | null): Promise<string | null> {
  const le = obj(st.draft.last_error)
  if (le.uncertain !== true || str(le.step) !== step || str(le.key) !== key) return null
  st.draft.last_error = null
  const since = Date.parse(str(le.at)) - 10 * 60_000
  const fresh = (r: Raw) => {
    const t = Date.parse(str(r.created_time).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    return !Number.isFinite(since) || (Number.isFinite(t) && t >= since)
  }
  try {
    let list: Raw[] = []
    if (step === 'campaign') {
      list = await graphAll<Raw>(`act_${st.ctx.env.account}/campaigns`, {
        fields: 'id,name,created_time', filtering: [{ field: 'name', operator: 'EQUAL', value: name }], limit: 25,
      }, { maxPages: 1 })
    } else if (parentId) {
      list = await graphAll<Raw>(`${parentId}/${step === 'adset' ? 'adsets' : 'ads'}`, { fields: 'id,name,created_time', limit: 100 }, { maxPages: 2 })
    }
    const hits = list.filter(r => str(r.name) === name && fresh(r))
    return hits.length === 1 ? str(hits[0].id) : null
  } catch (e) {
    console.warn('[meta-builder] Nachsehen nach Zeitüberschreitung:', errText(e).slice(0, 200))
    return null
  }
}

function stepLabel(st: RunState): string {
  const { step, key } = st.current
  const adset = st.spec.adsets.find(a => a.key === key)
  const ad = st.spec.ads.find(a => a.key === key)
  switch (step) {
    case 'campaign': return 'Kampagne'
    case 'adset': return `Anzeigengruppe „${adset?.name ?? key}“`
    case 'media': return 'Medium'
    case 'creative': return `Werbemittel für „${ad?.name ?? key}“`
    case 'ad': return `Anzeige „${ad?.name ?? key}“`
    case 'readback': return 'Rücklesen'
    default: return 'Vorbereitung'
  }
}

const levelOfStep = (step: string): Level => (step === 'campaign' ? 'campaign' : step === 'adset' ? 'adset' : 'ad')

function response(st: RunState, status: DraftStatus, error?: BuilderErrorBody, extra: Raw = {}): CreateResponse & Raw {
  return {
    status,
    done_steps: doneSteps(st.spec, st.ids, st.campaignExisting),
    next: status === 'created' ? null : nextStep(st.spec, st.ids, st.campaignExisting),
    meta_ids: st.ids,
    ...(error ? { error } : {}),
    ...extra,
  }
}

async function pause(st: RunState, error?: BuilderErrorBody, extra: Raw = {}): Promise<CreateResponse> {
  await finish(st, 'creating', null)
  return response(st, 'creating', error, extra)
}

async function failRun(st: RunState, err: unknown): Promise<CreateResponse> {
  if (err instanceof BuilderError && err.code === 'lease_busy') throw err
  const { step, key } = st.current
  const label = stepLabel(st)
  let status: DraftStatus = hasCreated(st.ids) ? 'partial' : 'failed'
  let lastError: DraftLastError & Raw
  let body: BuilderErrorBody
  if (err instanceof MetaApiError) {
    const msg = err.userMsg || err.message
    if (err.kind === 'dev_mode') {
      status = 'partial'
      lastError = { step, key, code: 'app_dev_mode', subcode: 1885183, user_msg: msg, at: nowIso() }
      body = {
        error: 'Meta blockiert das Anlegen von Werbemitteln, solange die App im Entwicklungsmodus ist. Bereits Angelegtes bleibt pausiert bestehen.',
        code: 'app_dev_mode', hint: APP_DEV_MODE_HINT,
      }
    } else if (err.userMsg === 'META_WRITES_DISABLED') {
      lastError = { step, key, code: 'writes_disabled', user_msg: msg, at: nowIso() }
      body = { error: 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).', code: 'writes_disabled' }
    } else {
      lastError = {
        step, key, code: err.code ?? err.kind, ...(err.subcode !== null ? { subcode: err.subcode } : {}),
        user_msg: msg, kind: err.kind, uncertain: err.kind === 'transient', at: nowIso(),
        ...(err.fbtraceId ? { fbtrace_id: err.fbtraceId } : {}),
      }
      body = {
        error: `${label}: ${msg}`,
        code: err.kind === 'rate_limit' ? 'rate_limited' : 'meta_error',
        hint: err.kind === 'transient'
          ? 'Meta hat nicht rechtzeitig geantwortet. „Fortsetzen“ prüft vorher, ob das Objekt doch angelegt wurde.'
          : metaHint(err),
        data: { step, key, issues: issuesFromError(levelOfStep(step), err) },
      }
    }
  } else if (err instanceof Error && err.message === 'media_unresolved') {
    lastError = { step, key, code: 'media_not_ready', user_msg: 'Medium ohne Meta-Hash bzw. Video-ID', at: nowIso() }
    body = { error: `${label}: Ein Bild oder Video ist noch nicht bei Meta.`, code: 'media_not_ready', hint: 'Medium im Assistenten neu hochladen und fortsetzen.' }
  } else if (err instanceof BuilderError) {
    lastError = { step, key, code: String(err.code), user_msg: err.message, at: nowIso() }
    body = { error: `${label}: ${err.message}`, code: String(err.code), ...(err.hint ? { hint: err.hint } : {}), ...(err.data !== undefined ? { data: err.data } : {}) }
  } else {
    lastError = { step, key, code: 'internal', user_msg: errText(err).slice(0, 300), at: nowIso() }
    body = { error: `${label}: ${errText(err).slice(0, 300)}`, code: 'internal' }
  }
  console.error(`[meta-builder] Lauf ${st.draft.id} ${step}${key ? `:${key}` : ''} -> ${status}: ${body.error}`)
  await finish(st, status, lastError)
  return response(st, status, body)
}

async function runSteps(st: RunState): Promise<CreateResponse> {
  const { ctx, spec } = st
  const acct = ctx.env.account
  const draftId = st.draft.id
  const ids = ensureIdMaps(st.ids)
  const timeUp = () => Date.now() - st.start > STEP_START_CUTOFF_MS
  const setStep = (step: string, key = '') => { st.current = { step, key } }
  const post = <T = Raw>(path: string, body: Raw, level: string) =>
    metaPost<T>(ctx, path, body, { level, draftId, logExtra: st.logExtra })
  try {
    // 1. Kampagne
    const c = spec.campaign
    let campaignId: string
    if (st.campaignExisting) {
      setStep('campaign')
      const j = await graphGet<Raw>(st.campaignExisting, { fields: 'id,account_id,objective,special_ad_categories' })
      if (digits(j.account_id) !== acct) throw new BuilderError(403, 'forbidden', 'Die Ziel-Kampagne gehört nicht zu unserem Werbekonto.')
      // Rückhalt zur Prüfung in modeCreateOrResume: Neues nur in Wohnen-Kampagnen (außer Admin-Begründung)
      const createsNew = spec.adsets.some(a => !a.existing_id && !ids.adsets[a.key]) || spec.ads.some(a => !a.existing_id && !ids.ads[a.key])
      const override = !!obj(st.logExtra).housing_override
      if (createsNew && !override && arr<unknown>(j.special_ad_categories).map(str).indexOf('HOUSING') < 0
        && (isHec(c.special_ad_categories) || isRealEstateDraft(st.draft.template_key))) {
        throw new BuilderError(409, 'housing_required', 'Die Ziel-Kampagne hat die Sonderkategorie Wohnen (HOUSING) nicht.', 'Immobilien-Anzeigen nur in Wohnen-Kampagnen anlegen.')
      }
      campaignId = st.campaignExisting
    } else if (ids.campaign) {
      campaignId = ids.campaign
    } else {
      if (timeUp()) return await pause(st)
      setStep('campaign')
      const payload = buildCampaignPayload(c)
      const found = await recoverUncertain(st, 'campaign', '', str(payload.name), null)
      campaignId = found ?? str((await post<Raw>(`act_${acct}/campaigns`, payload, 'campaign')).id)
      if (!campaignId) throw new BuilderError(502, 'meta_error', 'Meta hat keine Kampagnen-ID zurückgegeben.')
      ids.campaign = campaignId
      ids.hashes.campaign = await nodeHash(payload)
      await persistIds(st)
    }

    // 2. Anzeigengruppen
    for (const a of spec.adsets) {
      if (ids.adsets[a.key]) continue
      if (a.existing_id) {
        setStep('adset', a.key)
        await assertOwnAccount(a.existing_id)
        continue
      }
      if (timeUp()) return await pause(st)
      setStep('adset', a.key)
      const payload = buildAdsetPayload(a, c, campaignId)
      const found = await recoverUncertain(st, 'adset', a.key, str(payload.name), campaignId)
      const id = found ?? str((await post<Raw>(`act_${acct}/adsets`, payload, 'adset')).id)
      if (!id) throw new BuilderError(502, 'meta_error', 'Meta hat keine Anzeigengruppen-ID zurückgegeben.')
      ids.adsets[a.key] = id
      ids.hashes[`adset:${a.key}`] = await nodeHash(payload)
      await persistIds(st)
    }

    // 3. Medien der Anzeigen, die noch ein Creative brauchen
    const needCreative = spec.ads.filter(ad => !ad.existing_id && !ids.ads[ad.key] && !ids.creatives[ad.key])
    const eigeneThumbs = eigeneVorschaubilder(needCreative)
    for (const mid of uniq(needCreative.flatMap(adMediaRefs).map(r => r.media_id).filter(isUuid))) {
      const row = st.mediaRows[mid]
      // Video erst mit Vorschaubild fertig (sonst ensureMediaReady: Thumbnail nachholen bzw. warten);
      // mit eigenem Vorschaubild in jeder Verwendung reicht das fertige Video
      const readyRow = row && ((row.kind === 'image' && !!row.meta_image_hash) ||
        (row.kind === 'video' && !!row.meta_video_id && row.meta_status === 'ready' && (!!row.thumbnail_hash || eigeneThumbs.has(mid))))
      if (readyRow && row) {
        ids.media[mid] = {
          ...(row.meta_image_hash ? { image_hash: row.meta_image_hash } : {}),
          ...(row.meta_video_id ? { video_id: row.meta_video_id } : {}),
          ...(row.thumbnail_hash ? { thumbnail_hash: row.thumbnail_hash } : {}),
        }
        continue
      }
      if (timeUp()) return await pause(st)
      setStep('media', mid)
      const r = await ensureMediaReady(ctx, mid, draftId, eigeneThumbs.has(mid))
      st.mediaRows[mid] = r.row
      ids.media[mid] = {
        ...(r.row.meta_image_hash ? { image_hash: r.row.meta_image_hash } : {}),
        ...(r.row.meta_video_id ? { video_id: r.row.meta_video_id } : {}),
        ...(r.row.thumbnail_hash ? { thumbnail_hash: r.row.thumbnail_hash } : {}),
      }
      if (!r.ready) {
        delete ids.media[mid]
        if (r.reason === 'error') {
          throw new BuilderError(409, 'media_not_ready', `Meta konnte ein Video nicht verarbeiten${r.row.meta_error ? ` (${r.row.meta_error})` : ''}.`, 'Video neu exportieren (H.264, MP4) und erneut hochladen.')
        }
        if (r.reason === 'thumbnail') {
          throw new BuilderError(409, 'media_not_ready', 'Meta liefert für ein Video kein Vorschaubild.', 'Später erneut prüfen und fortsetzen. Hilft das nicht: Video neu exportieren (H.264, MP4) und erneut hochladen.')
        }
        await persistIds(st)
        return await pause(st, {
          error: r.row.meta_status === 'ready' ? 'Meta erstellt noch das Vorschaubild des Videos.' : 'Das Video wird bei Meta noch verarbeitet.',
          code: 'media_not_ready',
          hint: 'In ein bis zwei Minuten „Fortsetzen“. Angelegtes bleibt erhalten.',
        }, { retry_after_sec: 30 })
      }
      await persistIds(st)
    }

    // 4. Je Anzeige: Creative, dann Anzeige
    for (const ad of spec.ads) {
      if (ad.existing_id || ids.ads[ad.key]) continue
      const as = adsetByKey(spec, ad.adset_key) as AdsetDraft
      const adsetId = as.existing_id || ids.adsets[as.key]
      if (!adsetId) throw new BuilderError(500, 'internal', `Anzeigengruppe ${as.key} fehlt.`)
      if (!ids.creatives[ad.key]) {
        if (timeUp()) return await pause(st)
        setStep('creative', ad.key)
        const resolved: AdDraft = fillAdMedia(ad, st.mediaRows, ids.media)
        const build = buildCreativePayload(resolved, { placements: as.placements })
        const cid = str((await post<Raw>(`act_${acct}/adcreatives`, build.payload, 'creative')).id)
        if (!cid) throw new BuilderError(502, 'meta_error', 'Meta hat keine Creative-ID zurückgegeben.')
        ids.creatives[ad.key] = cid
        ids.hashes[`creative:${ad.key}`] = FP_V2 + await adFingerprint(ad, spec)
        await persistIds(st)
      }
      if (timeUp()) return await pause(st)
      setStep('ad', ad.key)
      const payload = buildAdPayload(ad, adsetId, { creative_id: ids.creatives[ad.key] }, { draftId })
      const found = await recoverUncertain(st, 'ad', ad.key, str(payload.name), adsetId)
      const id = found ?? str((await post<Raw>(`act_${acct}/ads`, payload, 'ad')).id)
      if (!id) throw new BuilderError(502, 'meta_error', 'Meta hat keine Anzeigen-ID zurückgegeben.')
      ids.ads[ad.key] = id
      ids.hashes[`ad:${ad.key}`] = FP_V2 + await adFingerprint(ad, spec)
      await persistIds(st)
    }

    // 5. Rücklesen in die Spiegel + „Vorbereitete Anzeigen“
    if (Date.now() - st.start > RUN_BUDGET_MS - 8_000) return await pause(st)
    setStep('readback')
    const adsetIds = uniq(spec.adsets.map(a => a.existing_id || ids.adsets[a.key]).filter((x): x is string => !!x))
    const warnings = await readback(ctx.sb, {
      campaignId, campaignCreated: !!ids.campaign, adsetIds, createdAdsetIds: Object.values(ids.adsets),
      adIds: Object.values(ids.ads), draftId, prepare: true,
    })
    await finish(st, 'created', null)
    return response(st, 'created', undefined, warnings.length ? { warnings } : {})
  } catch (err) {
    return await failRun(st, err)
  }
}

async function modeCreateOrResume(ctx: Ctx, req: CreateRequest): Promise<CreateResponse> {
  const draft = await loadDraft(ctx, req.draft_id)
  if (draft.status === 'discarded') throw new BuilderError(409, 'invalid_request', 'Der Entwurf ist verworfen.')
  if (draft.kind === 'edit') {
    throw new BuilderError(400, 'unsupported', 'Ein Bearbeiten-Entwurf wird nicht angelegt, sondern übernommen.', 'Änderungen an laufenden Kampagnen mit „Das ändert sich bei Meta“ prüfen (edit_diff) und übernehmen (edit_apply).')
  }
  const ids: DraftMetaIds = draft.meta_ids ?? {}
  const campaignExisting = draft.spec?.campaign?.existing_id || draft.target_campaign_id || ''
  if (draft.status === 'created') {
    const spec = specOf(draft)
    return { status: 'created', done_steps: doneSteps(spec, ids, campaignExisting), next: null, meta_ids: ids }
  }
  if (draft.status === 'creating' && leaseActive(draft)) throw leaseBusy()

  // Prüfung frisch und unverändert? (mitten im Lauf ist der Inhalt per Trigger eingefroren)
  if (draft.status !== 'creating') {
    const v = draft.validation as StoredValidation | null
    const at = v?.validated_at ? Date.parse(v.validated_at) : NaN
    if (!v || !Number.isFinite(at) || Date.now() - at > VALIDATION_MAX_AGE_MS) {
      throw new BuilderError(409, 'stale_validation', 'Bitte zuerst „Prüfen bei Meta“ ausführen. Die letzte Prüfung fehlt oder ist älter als 30 Minuten.')
    }
    if (v.spec_hash !== await hashSpec(draft.spec)) {
      throw new BuilderError(409, 'stale_validation', 'Der Entwurf wurde nach der letzten Prüfung geändert. Bitte erneut „Prüfen bei Meta“.')
    }
    const bad = arr<MetaLevelResult>(v.meta).filter(m => !m.ok)
    if (bad.length) {
      throw new BuilderError(422, 'validation_failed', 'Meta hat bei der letzten Prüfung Fehler gemeldet. Bitte beheben und erneut prüfen.', undefined, bad)
    }
  }

  const baseSpec = specOf(draft)
  // Lease holen (atomar: nur wenn keine fremde, frische Lease besteht)
  const lease = crypto.randomUUID()
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString()
  const { data: got, error: leaseErr } = await ctx.sb.from('meta_drafts')
    .update({ run_lease: lease, run_lease_at: nowIso(), status: 'creating' })
    .eq('id', draft.id)
    .in('status', ['draft', 'validated', 'failed', 'partial', 'creating'])
    .or(`run_lease.is.null,run_lease_at.lt."${cutoff}"`)
    .select('id')
  if (leaseErr) throw new BuilderError(500, 'internal', `Sperre setzen: ${String(leaseErr.message ?? leaseErr).slice(0, 200)}`)
  if (!arr(got).length) throw leaseBusy()

  const st: RunState = {
    ctx, draft, lease, start: Date.now(), spec: baseSpec, ids: JSON.parse(JSON.stringify(ids)) as DraftMetaIds,
    mediaRows: {}, campaignExisting, current: { step: 'prepare', key: '' }, finished: false,
  }
  const restStatus = (): DraftStatus => (hasCreated(st.ids) ? 'partial' : 'draft')
  try {
    const prep = await prepareSpec(ctx, draft, st.ids.media ?? {})
    // Beim Fortsetzen wartet der Medien-Schritt selbst auf das Video-Vorschaubild
    const resuming = hasCreated(st.ids)
    let errors = validateDraft(prep.spec, { realEstate: isRealEstateDraft(draft.template_key), server: true })
      .filter(i => i.severity === 'error' && !(resuming && i.code === 'video_thumb_missing'))
    const housing = errors.filter(i => i.code === 'housing_existing')
    if (housing.length) {
      const reason = str(req.housing_override_reason).trim()
      const isAdmin = ctx.caller.role === 'admin'
      if (!isAdmin || reason.length < 10) {
        await finish(st, restStatus(), null)
        throw new BuilderError(409, 'housing_required',
          'Die Ziel-Kampagne hat die Sonderkategorie Wohnen (HOUSING) nicht. Neue Immobilien-Anzeigengruppen und -Anzeigen legt der Assistent nur in Wohnen-Kampagnen an.',
          isAdmin
            ? 'Eine neue Kampagne mit Sonderkategorie Wohnen anlegen oder als Admin mit Begründung (mindestens 10 Zeichen) bewusst übergehen.'
            : 'Eine neue Kampagne mit Sonderkategorie Wohnen anlegen. Übergehen kann nur ein Admin mit Begründung.',
          housing)
      }
      errors = errors.filter(i => i.code !== 'housing_existing')
      st.logExtra = { ...(st.logExtra ?? {}), housing_override: { reason: reason.slice(0, 500), by: ctx.caller.userId, at: nowIso() } }
      console.warn(`[meta-builder] Wohnen-Pflicht bewusst übergangen (${draft.id}) von ${ctx.caller.userId}: ${reason.slice(0, 200)}`)
    }
    if (errors.length) {
      await finish(st, restStatus(), null)
      throw new BuilderError(422, 'validation_failed', `Der Entwurf hat noch ${errors.length} Fehler.`, 'Im Assistenten die rot markierten Felder korrigieren.', errors)
    }
    const blockers = lintNew(prep.spec, prep.lintCtx).filter(i => i.severity === 'blocker')
    if (blockers.length) {
      const reason = str(req.force_lint_reason).trim()
      const isAdmin = ctx.caller.role === 'admin'
      if (!isAdmin || reason.length < 10) {
        await finish(st, restStatus(), null)
        throw new BuilderError(422, 'lint_blocked', `${blockers.length} harte Text-Regel${blockers.length === 1 ? '' : 'n'} verletzt.`,
          isAdmin ? 'Korrigieren oder mit Begründung (mindestens 10 Zeichen) bewusst übergehen.' : 'Korrigieren. Übergehen kann nur ein Admin mit Begründung.',
          blockers)
      }
      st.logExtra = {
        ...(st.logExtra ?? {}),
        lint_override: { reason: reason.slice(0, 500), by: ctx.caller.userId, at: nowIso(), blockers: blockers.map(b => `${b.rule}:${b.node ?? ''}:${b.field}`) },
      }
      console.warn(`[meta-builder] Lint bewusst übergangen (${draft.id}) von ${ctx.caller.userId}: ${reason.slice(0, 200)}`)
    }
    // Serverseitig angepassten Inhalt (Wohnen-Regeln, Standardwerte, Medien-Hashes) festhalten
    st.spec = prep.spec
    st.mediaRows = prep.mediaRows
    if (stableStringify(prep.spec) !== stableStringify(draft.spec)) {
      const { error } = await ctx.sb.from('meta_drafts').update({ spec: prep.spec }).eq('id', draft.id).eq('run_lease', lease)
      if (error) console.warn('[meta-builder] Inhalt speichern:', String(error.message ?? error).slice(0, 200))
    }
    if (draft.status === 'creating' || draft.status === 'partial' || draft.status === 'failed') await reconcileFromLog(st)
    if (hasCreated(st.ids)) await assertCreatedUnchanged(st)
  } catch (err) {
    if (!st.finished) await finish(st, restStatus(), null)
    throw err
  }
  return await runSteps(st)
}

export const modeCreate = (ctx: Ctx, req: CreateRequest) => modeCreateOrResume(ctx, req)
export const modeResume = (ctx: Ctx, req: CreateRequest) => modeCreateOrResume(ctx, req)

// ═══════════════════════════════════════════════════════════════════════════
// activate_draft
// ═══════════════════════════════════════════════════════════════════════════

async function dailyCentsOf(id: string, endField: 'stop_time' | 'end_time'): Promise<number> {
  const j = await graphGet<Raw>(id, { fields: `daily_budget,lifetime_budget,budget_remaining,${endField}` })
  const daily = num(j.daily_budget) ?? 0
  if (daily > 0) return Math.round(daily)
  const life = num(j.lifetime_budget) ?? 0
  if (life <= 0) return 0
  const remaining = num(j.budget_remaining) ?? life
  const end = Date.parse(str(j[endField]).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  const days = Number.isFinite(end) ? Math.max(1, Math.ceil((end - Date.now()) / 86_400_000)) : 1
  return Math.round(remaining / days)
}

export async function modeActivateDraft(ctx: Ctx, req: ActivateDraftRequest): Promise<ActivateDraftResponse> {
  if (req.confirm !== true) throw new BuilderError(400, 'invalid_request', 'Aktivieren braucht eine ausdrückliche Bestätigung (confirm: true).')
  if (ctx.caller.system || !ctx.caller.userId) throw new BuilderError(403, 'forbidden', 'Aktivieren geht nur per Klick einer Person, nicht als System-Aufruf.')
  const draft = await loadDraft(ctx, req.draft_id)
  if (draft.status !== 'created') {
    throw new BuilderError(409, 'invalid_request', 'Aktivieren geht erst, wenn der Entwurf vollständig bei Meta angelegt ist.')
  }
  const levels = levelsParam(req.levels)
  if (!levels.size) throw new BuilderError(400, 'invalid_request', 'levels fehlt (campaign, adset, ad).')
  const ids: DraftMetaIds = draft.meta_ids ?? {}
  // Nur, was noch im Entwurf steht: Entferntes (z. B. in einem Teil-Entwurf gelöscht) bleibt pausiert
  const spec = specOf(draft)
  const adsetKeys = spec.adsets.filter(a => !a.existing_id && ids.adsets?.[a.key]).map(a => a.key)
  const adKeys = spec.ads.filter(a => !a.existing_id && ids.ads?.[a.key]).map(a => a.key)
  const specAdsetIds = uniq(adsetKeys.map(k => (ids.adsets ?? {})[k]))
  const specAdIds = uniq(adKeys.map(k => (ids.ads ?? {})[k]))
  const skipped: NonNullable<ActivateDraftResponse['skipped']> = [
    ...Object.keys(ids.adsets ?? {}).filter(k => adsetKeys.indexOf(k) < 0).map(k => ({ level: 'adset' as Level, key: k, id: (ids.adsets ?? {})[k] })),
    ...Object.keys(ids.ads ?? {}).filter(k => adKeys.indexOf(k) < 0).map(k => ({ level: 'ad' as Level, key: k, id: (ids.ads ?? {})[k] })),
  ]
  if (skipped.length) console.warn(`[meta-builder] activate_draft ${draft.id}: nicht mehr im Entwurf, bleibt pausiert: ${skipped.map(x => `${x.level}:${x.key}=${x.id}`).join(', ')}`)
  const adIds = levels.has('ad') ? specAdIds : []
  const adsetIds = levels.has('adset') ? specAdsetIds : []
  const campaignId = levels.has('campaign') && ids.campaign ? ids.campaign : null
  if (!adIds.length && !adsetIds.length && !campaignId) {
    throw new BuilderError(400, 'invalid_request', 'Nichts zu aktivieren: auf diesen Ebenen hat der Entwurf nichts selbst angelegt.')
  }

  // Leitplanke: alle Budgets dieses Entwurfs zählen als aktiv (vorsichtig)
  const budgetIds: string[] = []
  let addCents = 0
  if (ids.campaign) {
    const v = await dailyCentsOf(ids.campaign, 'stop_time')
    if (v > 0) { addCents += v; budgetIds.push(ids.campaign) }
  }
  if (!budgetIds.length) {
    for (const id of specAdsetIds) {
      const v = await dailyCentsOf(id, 'end_time')
      if (v > 0) { addCents += v; budgetIds.push(id) }
    }
  }
  const head = await budgetHeadroom(ctx.sb, { addDailyUsdCents: addCents, replaceEntityIds: budgetIds })
  const guardrail = guardrailInfo(head)
  if (!head.ok) {
    throw new BuilderError(409, 'guardrail_exceeded',
      `Budget-Leitplanke: heute aktiv ${fmtEur(head.activeEur)} €, mit diesem Entwurf ${fmtEur(head.afterEur)} €, Limit ${fmtEur(head.limitEur)} € pro Tag.`,
      'Erst andere Budgets senken. Das Limit kann nur ein Admin in den Werbe-Einstellungen anheben.', guardrail)
  }

  const order: Array<{ level: Level; id: string }> = [
    ...adIds.map(id => ({ level: 'ad' as Level, id })),
    ...adsetIds.map(id => ({ level: 'adset' as Level, id })),
    ...(campaignId ? [{ level: 'campaign' as Level, id: campaignId }] : []),
  ]
  const activated: ActivateDraftResponse['activated'] = []
  for (const o of order) {
    try {
      await metaPost(ctx, o.id, { status: 'ACTIVE' }, { level: o.level, entityId: o.id, draftId: draft.id, idempotent: true })
      activated.push(o)
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err
      const be = fromMetaError(err, `Aktivieren ${o.level === 'ad' ? 'der Anzeige' : o.level === 'adset' ? 'der Anzeigengruppe' : 'der Kampagne'} ${o.id}`)
      be.data = { activated, guardrail }
      throw be
    }
  }

  await readback(ctx.sb, {
    campaignId: ids.campaign ?? null, campaignCreated: !!ids.campaign, adsetIds: specAdsetIds, createdAdsetIds: specAdsetIds,
    adIds: specAdIds, draftId: draft.id,
  })
  if (adIds.length) {
    const { error } = await ctx.sb.from('studio_prepared_ads').update({ released_at: nowIso() }).in('ad_id', adIds).is('released_at', null)
    if (error) console.warn('[meta-builder] Freigabe in studio_prepared_ads:', String(error.message ?? error).slice(0, 200))
  }
  return { activated, guardrail, ...(skipped.length ? { skipped } : {}) }
}

// ═══════════════════════════════════════════════════════════════════════════
// preview
// ═══════════════════════════════════════════════════════════════════════════

type VorschauQuelle =
  | { art: 'live'; adId: string; ad: AdDraft; placements?: Placements }
  | { art: 'entwurf'; payload: Raw; ad: AdDraft; placements?: Placements }

const vorschauFehler = (e: unknown): string =>
  (e instanceof MetaApiError ? (e.kind === 'dev_mode' ? 'Meta-App im Entwicklungsmodus' : (e.userMsg || e.message)) : errText(e)).slice(0, 300)

/**
 * Woraus die Vorschau entsteht: schon bei Meta angelegte Anzeige (/{ad_id}/previews) oder
 * Creative aus dem Entwurf (generatepreviews; fehlende Medien werden hochgeladen = Schreibzugriff).
 */
async function vorschauQuelle(ctx: Ctx, draft: DraftRow, key: string): Promise<VorschauQuelle> {
  const ids: DraftMetaIds = draft.meta_ids ?? {}
  const prep = await prepareSpec(ctx, draft, ids.media ?? {})
  const ad = adByKey(prep.spec, key)
  if (!ad) throw new BuilderError(404, 'not_found', `Anzeige ${key || '(ohne key)'} nicht im Entwurf.`)
  const as = adsetByKey(prep.spec, ad.adset_key)
  const liveId = ad.existing_id || ids.ads?.[ad.key]
  if (liveId) return { art: 'live', adId: metaId(liveId, 'Anzeigen-ID'), ad, placements: as?.placements }
  const eigeneThumbs = eigeneVorschaubilder([ad])
  for (const ref of adMediaRefs(ad)) {
    if (!isUuid(ref.media_id)) continue
    const row = prep.mediaRows[ref.media_id]
    const ready = row && ((row.kind === 'image' && !!row.meta_image_hash) ||
      (row.kind === 'video' && !!row.meta_video_id && row.meta_status === 'ready' && (!!row.thumbnail_hash || eigeneThumbs.has(ref.media_id))))
    if (ready) continue
    const r = await ensureMediaReady(ctx, ref.media_id, draft.id, eigeneThumbs.has(ref.media_id))
    prep.mediaRows[ref.media_id] = r.row
    if (!r.ready) {
      throw new BuilderError(409, 'media_not_ready',
        r.reason === 'error' ? 'Meta konnte das Video nicht verarbeiten.'
          : r.reason === 'thumbnail' ? 'Meta liefert für das Video kein Vorschaubild.'
            : r.row.meta_status === 'ready' ? 'Meta erstellt noch das Vorschaubild des Videos.' : 'Das Video wird bei Meta noch verarbeitet.',
        'In ein bis zwei Minuten erneut versuchen.')
    }
  }
  let build: CreativeBuild
  try {
    build = buildCreativePayload(fillAdMedia(ad, prep.mediaRows, ids.media ?? {}), { placements: as?.placements })
  } catch {
    throw new BuilderError(409, 'media_not_ready', 'Für die Vorschau fehlt noch ein Bild oder Video.', 'Im Assistenten Medien für 4:5 und 9:16 hochladen.')
  }
  return { art: 'entwurf', payload: build.payload, ad, placements: as?.placements }
}

/** Ein Vorschau-iframe von Meta (GET, 24 h gültig). */
async function vorschauHolen(ctx: Ctx, q: { adId?: string; payload?: Raw }, format: PreviewFormat, label?: string): Promise<{ body: string | null; error?: string }> {
  const extra: Raw = label ? { dynamic_asset_label: label } : {}
  try {
    const j = q.adId
      ? await graphGet<Raw>(`${q.adId}/previews`, { ad_format: format, ...extra })
      : await graphGet<Raw>(`act_${ctx.env.account}/generatepreviews`, { creative: q.payload, ad_format: format, ...extra })
    return { body: str(obj(arr<unknown>(j.data)[0]).body) || null }
  } catch (e) { return { body: null, error: vorschauFehler(e) } }
}

export async function modePreview(ctx: Ctx, req: PreviewRequest): Promise<PreviewResponse> {
  const draft = await loadDraft(ctx, req.draft_id)
  const key = str(req.ad_key)
  const all = PREVIEW_FORMATS as readonly string[]
  let formats = uniq(arr<unknown>(req.formats).map(str).filter(f => all.indexOf(f) >= 0)) as PreviewFormat[]
  if (!formats.length) formats = ['MOBILE_FEED_STANDARD', 'INSTAGRAM_STORY']
  const q = await vorschauQuelle(ctx, draft, key)
  const previews: PreviewResponse['previews'] = []
  for (const f of formats) previews.push({ format: f, ...(await vorschauHolen(ctx, q.art === 'live' ? { adId: q.adId } : { payload: q.payload }, f)) })
  return { previews }
}

/** Ab dieser Konto-Auslastung (%) holt preview_alle keine weiteren Vorschauen (Limited access). */
const VORSCHAU_MAX_AUSLASTUNG = 75

/**
 * Vorschau aller Platzierungen: nur Formate, die die Anzeigengruppe ausspielen kann (previewFormatsFor),
 * höchstens LIMITS.previewAlleMax Aufrufe, Stopp über 75 % Konto-Auslastung. Mehrsprachig: sprache
 * wählt die Sprachversion (dynamic_asset_label). Ohne Entwurf: laufende Anzeige über ad_id.
 */
export async function modePreviewAlle(ctx: Ctx, req: PreviewAlleRequest): Promise<PreviewAlleResponse> {
  const all = PREVIEW_FORMATS as readonly string[]
  const wunsch = uniq(arr<unknown>(req.formats).map(str).filter(f => all.indexOf(f) >= 0)) as PreviewFormat[]
  let quelle: { adId?: string; payload?: Raw }
  let passend: PreviewFormat[]
  let ad: AdDraft | null = null
  if (req.draft_id) {
    const draft = await loadDraft(ctx, req.draft_id)
    const q = await vorschauQuelle(ctx, draft, str(req.ad_key))
    ad = q.ad
    quelle = q.art === 'live' ? { adId: q.adId } : { payload: q.payload }
    // alle Formate prüfen (auch Computer-Feed, der nur auf Wunsch kommt)
    passend = previewFormatsFor(q.ad, q.placements, PREVIEW_FORMATS)
  } else {
    const adId = metaId(req.ad_id, 'ad_id')
    const j = await graphGet<Raw>(adId, { fields: 'id,account_id' })
    if (digits(j.account_id) !== ctx.env.account) throw new BuilderError(403, 'forbidden', 'Die Anzeige gehört nicht zu unserem Werbekonto.')
    quelle = { adId }
    passend = PREVIEW_FORMATS.slice()
  }
  const formats = (wunsch.length ? wunsch : PREVIEW_ALLE_FORMATS.slice()).slice(0, LIMITS.previewAlleMax)
  const labelKey = (f: PreviewFormat) => `crm.werbung.meta.preview.${f}`
  // Sprach-Label nur, wenn der Feed eine englische Regel hat (manuelle Variante; automatische Übersetzung hat kein Label)
  const enManuell = !!ad && hatSprachen(ad) && (ad.sprachen?.varianten ?? []).some(v => v?.sprache === 'en')
  const sprache = req.sprache === 'en' && enManuell ? `${SPRACH_LABEL_PREFIX}en` : undefined
  const previews: PreviewAlleResponse['previews'] = []
  const uebersprungen: PreviewAlleResponse['uebersprungen'] = []
  for (const f of formats) {
    if (passend.indexOf(f) < 0) {
      uebersprungen.push({ format: f, label_key: labelKey(f), grund: 'Die Anzeigengruppe spielt hier nicht aus oder das Format passt nicht zur Platzierung.' })
      continue
    }
    const u = getLastUsage()
    if (u && u.accUtilPct > VORSCHAU_MAX_AUSLASTUNG) {
      previews.push({ format: f, label_key: labelKey(f), body: null, error: `Meta-Auslastung bei ${Math.round(u.accUtilPct)} %. Diese Vorschau bitte später laden.` })
      continue
    }
    previews.push({ format: f, label_key: labelKey(f), ...(await vorschauHolen(ctx, quelle, f, sprache)) })
  }
  return { previews, uebersprungen, gueltig_bis: new Date(Date.now() + 24 * 3600_000).toISOString() }
}

// ═══════════════════════════════════════════════════════════════════════════
// duplicate
// ═══════════════════════════════════════════════════════════════════════════

const DUP_CUTOFF_MS = 45_000
/** Höchstens so viele Kopier-POSTs je Aufruf (Rate-Limit „Limited access“) */
const DUP_MAX_POSTS = 40
/** Meta kopiert synchron mit deep_copy höchstens 3 Anzeigen; darüber einzeln kopieren */
const DUP_SYNC_MAX_ADS = 3
/**
 * Ab hier verlangt Meta (alle API-Versionen) bei Wohnen/Beschäftigung/Finanzen mit eingeschränkter
 * Zielgruppe (Custom Audience, detailliertes Targeting) ein ausdrückliches advantage_audience, auch auf /copies.
 */
const AA_PFLICHT_AB = Date.parse('2026-10-27T00:00:00Z')

interface DupQuelle { id: string; name: string; campaignId: string; adsetId: string; cats: string[]; objective: string; targeting: Raw | null }

/** Eingeschränkte Zielgruppe ohne ausdrücklich gesetzte Advantage+ Zielgruppe (Meta-Regel ab 27.10.2026)? */
function advantageAudienceFehlt(t: unknown): boolean {
  const tt = obj(t)
  const aa = obj(tt.targeting_automation).advantage_audience
  const eingeschraenkt = arr(tt.custom_audiences).length > 0 || arr(tt.flexible_spec).length > 0
  return eingeschraenkt && (aa === undefined || aa === null || aa === '')
}

/**
 * Duplizieren wie im Werbeanzeigenmanager: Kampagne (immer als neue Kampagne), Anzeigengruppe
 * (ursprüngliche / vorhandene / neue Kampagne) oder Anzeige (ursprüngliche / vorhandene / neue
 * Anzeigengruppe), 1 bis 5 Kopien je Objekt. Kopien immer PAUSED, Name + " - Kopie" (ab der
 * zweiten " - Kopie 2" ...), Unterobjekte behalten ihre Namen. Meta kopiert synchron nur bis
 * 3 Anzeigen mit; größere Gruppen/Kampagnen werden Ebene für Ebene kopiert (gedeckelt).
 * Kopie in einer Kampagne ohne Sonderkategorie Wohnen (Ziel oder Kampagne der Quelle): 409
 * housing_required, außer Admin mit Begründung (wie beim Anlegen). Ziel „neu“: nur Objekte aus
 * derselben Kampagne bzw. Anzeigengruppe.
 */
export async function modeDuplicate(ctx: Ctx, req: DuplicateRequest): Promise<DuplicateResponse> {
  const level = str(req.level) as Level
  if (level !== 'campaign' && level !== 'adset' && level !== 'ad') throw new BuilderError(400, 'invalid_request', 'level muss campaign, adset oder ad sein.')
  const rawIds = arr<unknown>(req.ids).length ? arr<unknown>(req.ids) : (req.id !== undefined ? [req.id] : [])
  const ids = uniq(rawIds.map(x => metaId(x, 'id')))
  if (!ids.length) throw new BuilderError(400, 'invalid_request', 'Keine Objekte zum Duplizieren angegeben.')
  const kopienRoh = req.kopien === undefined ? 1 : num(req.kopien)
  if (kopienRoh === null || !Number.isInteger(kopienRoh) || kopienRoh < 1 || kopienRoh > LIMITS.duplicateMaxCopies) {
    throw new BuilderError(400, 'invalid_request', `Anzahl Kopien: 1 bis ${LIMITS.duplicateMaxCopies}.`)
  }
  const kopien = kopienRoh
  if (ids.length * kopien > LIMITS.duplicateMaxTotal) {
    throw new BuilderError(400, 'invalid_request', `Höchstens ${LIMITS.duplicateMaxTotal} Kopien auf einmal (Objekte x Kopien).`)
  }
  const zielIn: DuplicateZiel = req.ziel && typeof req.ziel === 'object'
    ? req.ziel
    : req.target_adset_id ? { art: 'vorhanden', adset_id: str(req.target_adset_id) } : { art: 'original' }
  const art = zielIn.art
  if (art !== 'original' && art !== 'vorhanden' && art !== 'neu') throw new BuilderError(400, 'invalid_request', 'ziel.art muss original, vorhanden oder neu sein.')
  if (level === 'campaign' && art === 'vorhanden') throw new BuilderError(400, 'invalid_request', 'Eine Kampagne lässt sich nur als neue Kampagne duplizieren.')
  const deep = req.deep !== false
  let wort = str(req.rename_suffix).replace(new RegExp(DASH_CHARS.source, 'g'), '-').replace(/^[\s-]+/, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!wort) wort = 'Kopie'
  const suffix = (k: number) => ` - ${wort}${k > 1 ? ` ${k}` : ''}`
  const start = Date.now()
  let posts = 0
  const warnings: string[] = []
  const isAdmin = ctx.caller.role === 'admin'
  const overrideGrund = str(req.housing_override_reason).trim()
  let housingOverride: Raw | null = null
  /** Kopie landet in einer Kampagne ohne Wohnen: wie beim Anlegen nur ein Admin mit Begründung */
  const wohnenPflicht = (text: string): void => {
    if (isAdmin && overrideGrund.length >= 10) {
      if (!housingOverride) console.warn(`[meta-builder] Wohnen-Pflicht beim Duplizieren bewusst übergangen von ${ctx.caller.userId}: ${overrideGrund.slice(0, 200)}`)
      housingOverride = { reason: overrideGrund.slice(0, 500), by: ctx.caller.userId, at: nowIso() }
      warnings.push(`${text} Bewusst übergangen (Admin-Begründung).`)
      return
    }
    throw new BuilderError(409, 'housing_required', text,
      isAdmin
        ? 'Immobilien-Anzeigen nur in Wohnen-Kampagnen kopieren oder als Admin mit Begründung (mindestens 10 Zeichen) bewusst übergehen.'
        : 'Immobilien-Anzeigen nur in Wohnen-Kampagnen kopieren. Übergehen kann nur ein Admin mit Begründung.')
  }

  const copy = async (srcId: string, lvl: Level, body: Raw): Promise<string> => {
    if (posts >= DUP_MAX_POSTS) throw new BuilderError(429, 'rate_limited', 'Zu viele Kopien auf einmal. Den Rest bitte in einem zweiten Schritt duplizieren.')
    posts++
    const res = await metaPost<Raw>(ctx, `${srcId}/copies`, { status_option: 'PAUSED', ...body }, {
      level: lvl, entityId: srcId, ...(housingOverride ? { logExtra: { housing_override: housingOverride } } : {}),
    })
    const id = str(res.copied_ad_id) || str(res.copied_adset_id) || str(res.copied_campaign_id) || str(res.id)
    if (!id) throw new BuilderError(502, 'meta_error', 'Meta hat keine ID der Kopie zurückgegeben.', undefined, res)
    return id
  }
  const rename = (k: number) => ({ rename_options: { rename_suffix: suffix(k), rename_strategy: 'ONLY_TOP_LEVEL_RENAME' } })
  const quelle = async (id: string): Promise<DupQuelle> => {
    const fields = level === 'campaign' ? 'account_id,name,objective,special_ad_categories'
      : level === 'adset' ? 'account_id,name,campaign_id,targeting,campaign{objective,special_ad_categories}'
        : 'account_id,name,adset_id,campaign_id,campaign{objective,special_ad_categories}'
    const j = await graphGet<Raw>(id, { fields })
    if (digits(j.account_id) !== ctx.env.account) throw new BuilderError(403, 'forbidden', 'Das Objekt gehört nicht zu unserem Werbekonto.')
    const camp = level === 'campaign' ? j : obj(j.campaign)
    return {
      id, name: str(j.name), campaignId: level === 'campaign' ? id : str(j.campaign_id), adsetId: level === 'ad' ? str(j.adset_id) : level === 'adset' ? id : '',
      cats: arr<unknown>(camp.special_ad_categories).map(str), objective: str(camp.objective),
      targeting: level === 'adset' ? obj(j.targeting) : null,
    }
  }
  const wohnenKampagne = async (campaignId: string, label: string, objective?: string): Promise<void> => {
    const t = await graphGet<Raw>(campaignId, { fields: 'account_id,objective,special_ad_categories' })
    if (digits(t.account_id) !== ctx.env.account) throw new BuilderError(403, 'forbidden', `${label} gehört nicht zu unserem Werbekonto.`)
    if (arr<unknown>(t.special_ad_categories).map(str).indexOf('HOUSING') < 0) wohnenPflicht(`${label} hat die Sonderkategorie Wohnen nicht.`)
    if (objective && str(t.objective) && str(t.objective) !== objective) {
      throw new BuilderError(409, 'invalid_request', `${label} hat ein anderes Kampagnenziel (${str(t.objective)}). Meta kopiert nur in Kampagnen mit gleichem Ziel.`)
    }
  }
  /** Anzeigengruppe samt Anzeigen kopieren; über 3 Anzeigen Ebene für Ebene. */
  const adsetTief = async (srcId: string, k: number, campaignId?: string, renameTop = true): Promise<string> => {
    const base: Raw = { ...(campaignId ? { campaign_id: campaignId } : {}), ...(renameTop ? rename(k) : { rename_options: { rename_strategy: 'NO_RENAME' } }) }
    if (!deep) return await copy(srcId, 'adset', { ...base, deep_copy: false })
    const ads = await graphAll<Raw>(`${srcId}/ads`, { fields: 'id,effective_status', limit: 100 }, { maxPages: 1 })
    const lebend = ads.filter(a => DEAD_STATUS.indexOf(str(a.effective_status)) < 0)
    if (lebend.length <= DUP_SYNC_MAX_ADS) return await copy(srcId, 'adset', { ...base, deep_copy: true })
    if (posts + 1 + lebend.length > DUP_MAX_POSTS) {
      throw new BuilderError(429, 'rate_limited', `Die Anzeigengruppe hat ${lebend.length} Anzeigen, zu viele für ein sofortiges Kopieren.`, 'Weniger Kopien wählen oder im Werbeanzeigenmanager duplizieren.')
    }
    const neu = await copy(srcId, 'adset', { ...base, deep_copy: false })
    for (const a of lebend) await copy(str(a.id), 'ad', { adset_id: neu, rename_options: { rename_strategy: 'NO_RENAME' } })
    return neu
  }

  const quellen: DupQuelle[] = []
  const failed: DuplicateResponse['failed'] = []
  for (const id of ids) {
    try { quellen.push(await quelle(id)) } catch (err) {
      failed.push({ source_id: id, kopie: 0, error: err instanceof MetaApiError ? fromMetaError(err).message : err instanceof BuilderError ? err.message : errText(err) })
    }
  }
  if (!quellen.length) throw new BuilderError(400, 'invalid_request', failed[0]?.error ?? 'Keine kopierbaren Objekte.', undefined, failed)

  // Ziel „neu“: Meta kopiert das Elternobjekt der ERSTEN Quelle, also nur Objekte mit demselben Elternobjekt
  if (art === 'neu' && level !== 'campaign') {
    const eltern = uniq(quellen.map(q => (level === 'adset' ? q.campaignId : q.adsetId)))
    if (eltern.length > 1) {
      throw new BuilderError(400, 'invalid_request',
        level === 'adset' ? 'Für „Neue Kampagne“ bitte nur Anzeigengruppen aus derselben Kampagne wählen.' : 'Für „Neue Anzeigengruppe“ bitte nur Anzeigen aus derselben Anzeigengruppe wählen.',
        'Sonst landen alle Kopien in der Kopie der ersten. Je Kampagne bzw. Anzeigengruppe einzeln duplizieren.')
    }
  }
  // Wohnen: Kopien, die in der Kampagne der Quelle (bzw. ihrer Kopie) landen, brauchen dort HOUSING
  const inQuellKampagne = level === 'campaign' || art === 'original' || (level === 'adset' && art === 'neu') || (level === 'ad' && art === 'neu' && !zielIn.campaign_id)
  if (inQuellKampagne) {
    const ohne = quellen.filter(q => q.cats.indexOf('HOUSING') < 0)
    if (ohne.length) {
      wohnenPflicht(ohne.length === 1
        ? `„${ohne[0].name}“ liegt in einer Kampagne ohne Sonderkategorie Wohnen; die Kopie hätte sie auch nicht.`
        : `${ohne.length} Objekte (z. B. „${ohne[0].name}“) liegen in Kampagnen ohne Sonderkategorie Wohnen; die Kopien hätten sie auch nicht.`)
    }
  }
  // Advantage+ Zielgruppe ausdrücklich (Meta-Pflicht ab 27.10.2026 bei Wohnen mit Custom Audience/Detail-Targeting)
  const aaPflicht = Date.now() >= AA_PFLICHT_AB
  const aaGesperrt = new Set<string>()
  const aaLuecken = async (q: DupQuelle, i: number): Promise<string[]> => {
    if (level === 'adset') return (isHec(q.cats) || art === 'vorhanden') && advantageAudienceFehlt(q.targeting) ? [q.name || q.id] : []
    if (level === 'campaign') {
      if (!deep || !isHec(q.cats)) return []
      const gruppen = await graphAll<Raw>(`${q.id}/adsets`, { fields: 'id,name,effective_status,targeting', limit: 100 }, { maxPages: 2 })
      return gruppen.filter(g => DEAD_STATUS.indexOf(str(g.effective_status)) < 0 && advantageAudienceFehlt(g.targeting)).map(g => str(g.name) || str(g.id))
    }
    // Anzeige in neue Anzeigengruppe: kopiert wird die Gruppe der ersten Quelle (einmal prüfen)
    if (art !== 'neu' || i > 0 || !(isHec(q.cats) || zielIn.campaign_id)) return []
    const g = await graphGet<Raw>(q.adsetId, { fields: 'name,targeting' })
    return advantageAudienceFehlt(g.targeting) ? [str(g.name) || q.adsetId] : []
  }
  for (let i = 0; i < quellen.length; i++) {
    const q = quellen[i]
    let luecken: string[] = []
    try { luecken = await aaLuecken(q, i) } catch (e) { console.warn('[meta-builder] duplicate Advantage-Prüfung:', errText(e).slice(0, 200)) }
    if (!luecken.length) continue
    const text = `„${luecken.slice(0, 3).join('“, „')}“${luecken.length > 3 ? ` und ${luecken.length - 3} weitere` : ''}: Wohnen-Anzeigengruppe mit Custom Audience oder detailliertem Targeting ohne ausdrücklich gesetzte Advantage+ Zielgruppe. `
      + `Meta lehnt das Kopieren ${aaPflicht ? 'seit' : 'ab'} 27.10.2026 ab. Vorher die Advantage+ Zielgruppe der Anzeigengruppe ausdrücklich setzen (über „Bearbeiten“ ändern oder im Werbeanzeigenmanager speichern).`
    if (!aaPflicht) { warnings.push(text); continue }
    // Anzeigen in eine neue Gruppe: alle hängen an derselben Gruppe
    for (const x of level === 'ad' ? quellen : [q]) { aaGesperrt.add(x.id); failed.push({ source_id: x.id, kopie: 0, error: text }) }
  }
  const kopierbar = quellen.filter(q => !aaGesperrt.has(q.id))
  if (!kopierbar.length) throw new BuilderError(409, 'invalid_request', failed[0]?.error ?? 'Keine kopierbaren Objekte.', undefined, failed)

  // Ziel auflösen (einmal je Aufruf)
  let zielCampaign: string | undefined
  let zielAdset: string | undefined
  let neueKampagne: string | undefined
  let neueGruppe: string | undefined
  if (level === 'adset' && art === 'vorhanden') {
    zielCampaign = metaId(zielIn.campaign_id, 'ziel.campaign_id')
    await wohnenKampagne(zielCampaign, 'Die Ziel-Kampagne', quellen[0].objective)
  } else if (level === 'adset' && art === 'neu') {
    neueKampagne = await copy(quellen[0].campaignId, 'campaign', { deep_copy: false, ...rename(1) })
    zielCampaign = neueKampagne
  } else if (level === 'ad' && art === 'vorhanden') {
    zielAdset = metaId(zielIn.adset_id, 'ziel.adset_id')
    const t = await graphGet<Raw>(zielAdset, { fields: 'account_id,campaign_id' })
    if (digits(t.account_id) !== ctx.env.account) throw new BuilderError(403, 'forbidden', 'Die Ziel-Anzeigengruppe gehört nicht zu unserem Werbekonto.')
    await wohnenKampagne(metaId(t.campaign_id, 'campaign_id'), 'Die Kampagne der Ziel-Anzeigengruppe')
  } else if (level === 'ad' && art === 'neu') {
    const inKampagne = zielIn.campaign_id ? metaId(zielIn.campaign_id, 'ziel.campaign_id') : undefined
    if (inKampagne) await wohnenKampagne(inKampagne, 'Die Ziel-Kampagne', quellen[0].objective)
    neueGruppe = await copy(quellen[0].adsetId, 'adset', { deep_copy: false, ...(inKampagne ? { campaign_id: inKampagne } : {}), ...rename(1) })
    zielAdset = neueGruppe
  }

  const copies: DuplicateResponse['copies'] = []
  for (const q of kopierbar) {
    for (let k = 1; k <= kopien; k++) {
      if (Date.now() - start > DUP_CUTOFF_MS) { failed.push({ source_id: q.id, kopie: k, error: 'Zeitlimit erreicht. Diese Kopie bitte noch einmal anstoßen.' }); continue }
      try {
        let copied: string
        if (level === 'campaign') {
          if (!deep) copied = await copy(q.id, 'campaign', { deep_copy: false, ...rename(k) })
          else {
            const ads = await graphAll<Raw>(`${q.id}/ads`, { fields: 'id,effective_status', limit: 100 }, { maxPages: 2 })
            const lebend = ads.filter(a => DEAD_STATUS.indexOf(str(a.effective_status)) < 0)
            if (lebend.length <= DUP_SYNC_MAX_ADS) copied = await copy(q.id, 'campaign', { deep_copy: true, ...rename(k) })
            else {
              const gruppen = (await graphAll<Raw>(`${q.id}/adsets`, { fields: 'id,effective_status', limit: 100 }, { maxPages: 2 }))
                .filter(a => DEAD_STATUS.indexOf(str(a.effective_status)) < 0)
              if (posts + 1 + gruppen.length + lebend.length > DUP_MAX_POSTS) {
                throw new BuilderError(429, 'rate_limited', `Die Kampagne hat ${gruppen.length} Anzeigengruppen und ${lebend.length} Anzeigen, zu viele für ein sofortiges Kopieren.`, 'Im Werbeanzeigenmanager duplizieren oder einzelne Anzeigengruppen kopieren.')
              }
              copied = await copy(q.id, 'campaign', { deep_copy: false, ...rename(k) })
              for (const g of gruppen) await adsetTief(str(g.id), k, copied, false)
            }
          }
        } else if (level === 'adset') {
          copied = await adsetTief(q.id, k, zielCampaign)
        } else {
          copied = await copy(q.id, 'ad', { ...(zielAdset ? { adset_id: zielAdset } : {}), ...rename(k) })
        }
        copies.push({ source_id: q.id, copied_id: copied, kopie: k })
      } catch (err) {
        if (err instanceof MetaApiError && err.userMsg === 'META_WRITES_DISABLED') throw err
        if (err instanceof BuilderError && err.code === 'writes_disabled') throw err
        failed.push({ source_id: q.id, kopie: k, error: err instanceof MetaApiError ? fromMetaError(err).message : err instanceof BuilderError ? err.message : errText(err) })
        if (err instanceof MetaApiError && err.kind === 'rate_limit') break
      }
    }
  }

  // Spiegel (nie fatal)
  try {
    const neu = copies.map(c => c.copied_id)
    if (level === 'campaign') {
      for (const c of neu) await readback(ctx.sb, { campaignId: c, adsetIds: [], adIds: [] })
    } else if (level === 'adset') {
      await readback(ctx.sb, { campaignId: neueKampagne ?? null, campaignCreated: false, adsetIds: neu, adIds: [] })
    } else if (neu.length) {
      const adsets = uniq([zielAdset ?? '', ...quellen.map(q => q.adsetId)].filter(Boolean))
      await readback(ctx.sb, { adsetIds: adsets, adIds: neu, prepare: true })
    }
  } catch (e) { console.warn('[meta-builder] duplicate Rücklesen:', errText(e).slice(0, 200)) }

  if (!copies.length) throw new BuilderError(502, 'meta_error', failed[0]?.error ?? 'Keine Kopie angelegt.', undefined, { failed })
  return {
    level, copies, failed, copied_id: copies[0]?.copied_id,
    ...(neueKampagne ? { neue_kampagne_id: neueKampagne } : {}),
    ...(neueGruppe ? { neue_anzeigengruppe_id: neueGruppe } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// discard
// ═══════════════════════════════════════════════════════════════════════════

export async function modeDiscard(ctx: Ctx, req: DiscardRequest): Promise<DiscardResponse> {
  const draft = await loadDraft(ctx, req.draft_id)
  if (draft.status === 'discarded') return { status: 'discarded' }
  if (draft.status === 'creating' && leaseActive(draft)) throw leaseBusy()
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString()
  const { data, error } = await ctx.sb.from('meta_drafts')
    .update({ status: 'discarded', run_lease: null, run_lease_at: null })
    .eq('id', draft.id).or(`run_lease.is.null,run_lease_at.lt."${cutoff}"`).select('id')
  if (error) throw new BuilderError(500, 'internal', `Verwerfen: ${String(error.message ?? error).slice(0, 200)}`)
  if (!arr(data).length) throw leaseBusy()
  return { status: 'discarded' }
}
