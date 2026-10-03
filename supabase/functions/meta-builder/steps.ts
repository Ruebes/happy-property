// meta-builder: Entwurfs-Modi validate, create/resume (Schritt-Läufer),
// activate_draft, preview, duplicate, discard.
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
  cleanName, HEC_CATEGORIES, hasErrors, isHec, PREVIEW_FORMATS, targetsEu, validateDraft,
  type ActivateDraftRequest, type ActivateDraftResponse, type AdDraft, type AdsetDraft, type BuilderErrorBody,
  type CampaignDraft, type CreateRequest, type CreateResponse, type CreativeBuild, type DiscardRequest,
  type DiscardResponse, type DraftIssue, type DraftLastError, type DraftMetaIds, type DraftSpec, type DraftStatus,
  type DuplicateRequest, type DuplicateResponse, type GuardrailInfo, type Level, type MetaLevelResult,
  type MetaMediaRow, type PreviewFormat, type PreviewRequest, type PreviewResponse, type ValidateRequest,
  type ValidateResponse,
} from '../_shared/metaSpec.ts'
import { DASH_CHARS, lintDraft, type LintContext, type LintIssue, type LintMediaInfo } from '../_shared/metaLint.ts'
import {
  adMediaRefs, APP_DEV_MODE_HINT, arr, BuilderError, digits, errText, fillAdMedia, forbiddenNames, fromMetaError,
  guardrailInfo, hashSpec, isUuid, issuesFromError, leaseActive, LEASE_MS, loadDraft, loadMediaRows, metaHint,
  metaId, metaPost, nowIso, num, obj, specOf, stableStringify, str, uniq, VALIDATION_MAX_AGE_MS,
  type Ctx, type DraftRow, type MediaIds, type Raw, type StoredValidation,
} from './common.ts'
import { accountDsaDefaults, pageInstagram } from './catalog.ts'
import { ensureMediaReady } from './media.ts'
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
  const spec = applyHousing(raw).spec
  const refs = spec.ads.flatMap(adMediaRefs).map(r => r.media_id)
  const mediaRows = await loadMediaRows(ctx.sb, refs)
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
  interface Cand { id: string; name: string; cats: string[]; budget: boolean; status: string }
  const toCand = (r: Raw, idKey: string, dKey: string, lKey: string): Cand => ({
    id: str(r[idKey]), name: str(r.name), cats: arr<unknown>(r.special_ad_categories).map(str),
    budget: (num(r[dKey]) ?? 0) > 0 || (num(r[lKey]) ?? 0) > 0, status: str(r.effective_status) || str(r.status),
  })
  let cands: Cand[] = []
  const { data, error } = await ctx.sb.from('meta_campaigns')
    .select('campaign_id, account_id, name, objective, special_ad_categories, daily_budget_cents, lifetime_budget_cents, effective_status, status')
    .eq('objective', c.objective).limit(100)
  if (!error) {
    cands = arr<Raw>(data).filter(r => !str(r.account_id) || digits(r.account_id) === ctx.env.account)
      .map(r => toCand(r, 'campaign_id', 'daily_budget_cents', 'lifetime_budget_cents'))
  }
  if (!cands.length) {
    try {
      const list = await graphAll<Raw>(`act_${ctx.env.account}/campaigns`, {
        fields: 'id,name,objective,special_ad_categories,daily_budget,lifetime_budget,effective_status', limit: 100,
      }, { maxPages: 2 })
      cands = list.filter(r => str(r.objective) === c.objective).map(r => toCand(r, 'id', 'daily_budget', 'lifetime_budget'))
    } catch (e) { console.warn('[meta-builder] Platzhalter-Kampagne:', errText(e).slice(0, 200)) }
  }
  const want = hecKey(c.special_ad_categories ?? [])
  const cbo = c.budget_level === 'campaign'
  const score = (x: Cand) => (/pr(ü|ue)f/i.test(x.name) ? 0 : 2) + (x.status === 'ACTIVE' ? 1 : 0)
  const ok = cands
    .filter(x => x.id && DEAD_STATUS.indexOf(x.status) < 0 && hecKey(x.cats) === want && x.budget === cbo)
    .sort((a, b) => score(a) - score(b))
  return ok[0]?.id ?? null
}

async function findProxyAdset(ctx: Ctx, campaignId: string, wantLeadForm: boolean): Promise<string | null> {
  let rows: Array<{ id: string; dest: string; status: string }> = []
  const { data, error } = await ctx.sb.from('meta_adsets').select('adset_id, destination_type, effective_status').eq('campaign_id', campaignId).limit(50)
  if (!error) rows = arr<Raw>(data).map(r => ({ id: str(r.adset_id), dest: str(r.destination_type), status: str(r.effective_status) }))
  if (!rows.length) {
    try {
      const list = await graphAll<Raw>(`${campaignId}/adsets`, { fields: 'id,destination_type,effective_status', limit: 50 }, { maxPages: 1 })
      rows = list.map(r => ({ id: str(r.id), dest: str(r.destination_type), status: str(r.effective_status) }))
    } catch (e) { console.warn('[meta-builder] Platzhalter-Anzeigengruppe:', errText(e).slice(0, 200)) }
  }
  const match = (d: string) => (wantLeadForm ? d === 'ON_AD' : (d === 'WEBSITE' || d === 'WEBSITE_AND_PHONE_CALL' || d === '' || d === 'UNDEFINED'))
  return rows.find(r => r.id && DEAD_STATUS.indexOf(r.status) < 0 && match(r.dest))?.id ?? null
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
        const lead = ad.destination?.kind === 'lead_form'
        const ck = `${as.key}:${lead}`
        if (adsetCache[ck] === undefined) {
          let found: string | null = campaignId ? await findProxyAdset(ctx, campaignId, lead) : null
          if (!found) { const p = await proxy(); if (p && p !== campaignId) found = await findProxyAdset(ctx, p, lead) }
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
  const local = validateDraft(prep.spec)
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

function ensureIdMaps(ids: DraftMetaIds): Required<Pick<DraftMetaIds, 'adsets' | 'creatives' | 'ads' | 'media'>> & DraftMetaIds {
  ids.adsets = ids.adsets ?? {}
  ids.creatives = ids.creatives ?? {}
  ids.ads = ids.ads ?? {}
  ids.media = ids.media ?? {}
  return ids as Required<Pick<DraftMetaIds, 'adsets' | 'creatives' | 'ads' | 'media'>> & DraftMetaIds
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
      if (isHec(c.special_ad_categories) && arr<unknown>(j.special_ad_categories).map(str).indexOf('HOUSING') < 0) {
        throw new BuilderError(409, 'invalid_request', 'Die Ziel-Kampagne hat die Sonderkategorie Wohnen nicht.', 'Immobilien-Anzeigen nur in Wohnen-Kampagnen anlegen.')
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
      await persistIds(st)
    }

    // 3. Medien der Anzeigen, die noch ein Creative brauchen
    const needCreative = spec.ads.filter(ad => !ad.existing_id && !ids.ads[ad.key] && !ids.creatives[ad.key])
    for (const mid of uniq(needCreative.flatMap(adMediaRefs).map(r => r.media_id).filter(isUuid))) {
      const row = st.mediaRows[mid]
      const readyRow = row && ((row.kind === 'image' && !!row.meta_image_hash) || (row.kind === 'video' && !!row.meta_video_id && row.meta_status === 'ready'))
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
      const r = await ensureMediaReady(ctx, mid, draftId)
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
        await persistIds(st)
        return await pause(st, {
          error: 'Das Video wird bei Meta noch verarbeitet.', code: 'media_not_ready',
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
        await persistIds(st)
      }
      if (timeUp()) return await pause(st)
      setStep('ad', ad.key)
      const payload = buildAdPayload(ad, adsetId, { creative_id: ids.creatives[ad.key] }, { draftId })
      const found = await recoverUncertain(st, 'ad', ad.key, str(payload.name), adsetId)
      const id = found ?? str((await post<Raw>(`act_${acct}/ads`, payload, 'ad')).id)
      if (!id) throw new BuilderError(502, 'meta_error', 'Meta hat keine Anzeigen-ID zurückgegeben.')
      ids.ads[ad.key] = id
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
    throw new BuilderError(400, 'unsupported', 'Bestehende Objekte ändert der Assistent nicht.', 'Änderungen an laufenden Kampagnen über die Einstellungen in der Statistik.')
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
    const errors = validateDraft(prep.spec).filter(i => i.severity === 'error')
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
  const adIds = levels.has('ad') ? Object.values(ids.ads ?? {}) : []
  const adsetIds = levels.has('adset') ? Object.values(ids.adsets ?? {}) : []
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
    for (const id of Object.values(ids.adsets ?? {})) {
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

  const allAdsets = uniq(Object.values(ids.adsets ?? {}))
  await readback(ctx.sb, {
    campaignId: ids.campaign ?? null, campaignCreated: !!ids.campaign, adsetIds: allAdsets, createdAdsetIds: allAdsets,
    adIds: Object.values(ids.ads ?? {}), draftId: draft.id,
  })
  if (adIds.length) {
    const { error } = await ctx.sb.from('studio_prepared_ads').update({ released_at: nowIso() }).in('ad_id', adIds).is('released_at', null)
    if (error) console.warn('[meta-builder] Freigabe in studio_prepared_ads:', String(error.message ?? error).slice(0, 200))
  }
  return { activated, guardrail }
}

// ═══════════════════════════════════════════════════════════════════════════
// preview
// ═══════════════════════════════════════════════════════════════════════════

export async function modePreview(ctx: Ctx, req: PreviewRequest): Promise<PreviewResponse> {
  const draft = await loadDraft(ctx, req.draft_id)
  const key = str(req.ad_key)
  const all = PREVIEW_FORMATS as readonly string[]
  let formats = uniq(arr<unknown>(req.formats).map(str).filter(f => all.indexOf(f) >= 0)) as PreviewFormat[]
  if (!formats.length) formats = ['MOBILE_FEED_STANDARD', 'INSTAGRAM_STORY']
  const ids: DraftMetaIds = draft.meta_ids ?? {}
  const prep = await prepareSpec(ctx, draft, ids.media ?? {})
  const ad = adByKey(prep.spec, key)
  if (!ad) throw new BuilderError(404, 'not_found', `Anzeige ${key || '(ohne key)'} nicht im Entwurf.`)
  const acct = ctx.env.account
  const previews: PreviewResponse['previews'] = []
  const soft = (e: unknown) => (e instanceof MetaApiError ? (e.kind === 'dev_mode' ? 'Meta-App im Entwicklungsmodus' : (e.userMsg || e.message)) : errText(e)).slice(0, 300)

  // Schon bei Meta: Vorschau der echten Anzeige
  const liveId = ad.existing_id || ids.ads?.[ad.key]
  if (liveId) {
    for (const f of formats) {
      try {
        const j = await graphGet<Raw>(`${metaId(liveId, 'Anzeigen-ID')}/previews`, { ad_format: f })
        previews.push({ format: f, body: str(obj(arr<unknown>(j.data)[0]).body) || null })
      } catch (e) { previews.push({ format: f, body: null, error: soft(e) }) }
    }
    return { previews }
  }

  for (const ref of adMediaRefs(ad)) {
    if (!isUuid(ref.media_id)) continue
    const row = prep.mediaRows[ref.media_id]
    const ready = row && ((row.kind === 'image' && !!row.meta_image_hash) || (row.kind === 'video' && !!row.meta_video_id && row.meta_status === 'ready'))
    if (ready) continue
    const r = await ensureMediaReady(ctx, ref.media_id, draft.id)
    prep.mediaRows[ref.media_id] = r.row
    if (!r.ready) {
      throw new BuilderError(409, 'media_not_ready',
        r.reason === 'error' ? 'Meta konnte das Video nicht verarbeiten.' : 'Das Video wird bei Meta noch verarbeitet.',
        'In ein bis zwei Minuten erneut versuchen.')
    }
  }
  const as = adsetByKey(prep.spec, ad.adset_key)
  let build: CreativeBuild
  try {
    build = buildCreativePayload(fillAdMedia(ad, prep.mediaRows, ids.media ?? {}), { placements: as?.placements })
  } catch {
    throw new BuilderError(409, 'media_not_ready', 'Für die Vorschau fehlt noch ein Bild oder Video.', 'Im Assistenten Medien für 4:5 und 9:16 hochladen.')
  }
  for (const f of formats) {
    try {
      const j = await graphGet<Raw>(`act_${acct}/generatepreviews`, { creative: build.payload, ad_format: f })
      previews.push({ format: f, body: str(obj(arr<unknown>(j.data)[0]).body) || null })
    } catch (e) { previews.push({ format: f, body: null, error: soft(e) }) }
  }
  return { previews }
}

// ═══════════════════════════════════════════════════════════════════════════
// duplicate
// ═══════════════════════════════════════════════════════════════════════════

export async function modeDuplicate(ctx: Ctx, req: DuplicateRequest): Promise<DuplicateResponse> {
  const level = str(req.level) as Level
  if (level !== 'campaign' && level !== 'adset' && level !== 'ad') throw new BuilderError(400, 'invalid_request', 'level muss campaign, adset oder ad sein.')
  const id = metaId(req.id, 'id')
  try { await assertOwnAccount(id) } catch (err) {
    if (err instanceof MetaApiError && err.kind === 'permission') throw new BuilderError(403, 'forbidden', 'Das Objekt gehört nicht zu unserem Werbekonto.')
    throw err
  }
  let suffix = str(req.rename_suffix).replace(new RegExp(DASH_CHARS.source, 'g'), '-').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!suffix) suffix = 'Kopie'
  const body: Raw = { status_option: 'PAUSED' }
  if (level === 'ad') body.rename_options = { rename_suffix: ` ${suffix}` }
  else {
    body.rename_options = { rename_suffix: ` ${suffix}`, rename_strategy: 'ONLY_TOP_LEVEL_RENAME' }
    body.deep_copy = req.deep === true
  }
  let targetAdset: string | null = null
  if (req.target_adset_id) {
    if (level !== 'ad') throw new BuilderError(400, 'invalid_request', 'Eine Ziel-Anzeigengruppe gibt es nur beim Kopieren einer Anzeige.')
    targetAdset = metaId(req.target_adset_id, 'target_adset_id')
    const t = await graphGet<Raw>(targetAdset, { fields: 'account_id,campaign{special_ad_categories}' })
    if (digits(t.account_id) !== ctx.env.account) throw new BuilderError(403, 'forbidden', 'Die Ziel-Anzeigengruppe gehört nicht zu unserem Werbekonto.')
    if (arr<unknown>(obj(t.campaign).special_ad_categories).map(str).indexOf('HOUSING') < 0) {
      throw new BuilderError(409, 'invalid_request', 'Die Ziel-Anzeigengruppe liegt in einer Kampagne ohne Sonderkategorie Wohnen.', 'Immobilien-Anzeigen nur in Wohnen-Kampagnen kopieren.')
    }
    body.adset_id = targetAdset
  }
  const res = await metaPost<Raw>(ctx, `${id}/copies`, body, { level, entityId: id })
  const copied = str(res.copied_ad_id) || str(res.copied_adset_id) || str(res.copied_campaign_id) || str(res.id)
  if (!copied) throw new BuilderError(502, 'meta_error', 'Meta hat keine ID der Kopie zurückgegeben.', undefined, res)
  await readback(ctx.sb, level === 'campaign'
    ? { campaignId: copied, adsetIds: [], adIds: [] }
    : level === 'adset'
      ? { adsetIds: [copied], adIds: [] }
      : { adsetIds: targetAdset ? [targetAdset] : [], adIds: [copied], prepare: true })
  return { copied_id: copied, level }
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
