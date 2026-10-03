// meta-builder: Bearbeiten laufender Kampagnen (edit_load, edit_diff, edit_apply)
// und gemeinsame Bausteine für bulk (Leitplanke über mehrere Objekte,
// Budget-Änderungslimit von Meta, Zusammenführen des Targetings).
//
// Ablauf:
//   edit_load   liest Kampagne/Anzeigengruppe/Anzeige bei Meta (wie import, plus Status,
//               Zeitplan, Gruppen-Limits, Tracking) und legt einen Entwurf kind 'edit' an
//               bzw. nimmt den offenen Bearbeiten-Entwurf desselben Objekts wieder auf.
//               Ausgangsstand in meta_ids.edit (schreibt nur der Server).
//   edit_diff   vergleicht Ausgangsstand und Entwurf (editDiff aus metaSpec), gleicht mit
//               dem Live-Stand ab (inzwischen bei Meta geändert = Konflikt), prüft geänderte
//               Felder (validateDraft/validateEditFields, Lint für neue Werbemittel) und
//               rechnet die Leitplanke. Schreibt nichts.
//   edit_apply  wie edit_diff, dann nur geänderte, änderbare Felder an Meta: erst Pausieren,
//               dann Änderungen (Targeting zusammengeführt + Wohnen-Regeln), dann Werbemittel
//               (ersetzen oder neue Anzeige + alte pausieren), zuletzt Einschalten
//               (Anzeige > Gruppe > Kampagne). Leitplanke einmal vorab für alle Erhöhungen.
//               Jeder POST in meta_write_log (mit Vorher-Stand). Danach Spiegel + neuer
//               Ausgangsstand; nicht übernommene (nicht gesperrte) Änderungen bleiben im
//               Entwurf. Budgetplanung je Zeitraum über POST /{id}/budget_schedules.
//               Nichts wird gelöscht oder archiviert.

import {
  budgetHeadroom, getLastUsage, graphAll, GRAPH_VERSION, MetaApiError,
} from '../_shared/metaGraph.ts'
import {
  applyHousing, ATTRIBUTION_SPECS, BID_NEEDS_AMOUNT, buildAdPayload, buildCreativePayload, buildTargeting,
  cleanName, EDIT_TARGETING_KEYS, editDiff, editFieldValue, editLocks, editSame, effectiveBidStrategy, isHec,
  LIMITS, META_UNBEGRENZT, neueBudgetZeitraeume, promotedAllowed, promotedRuleFor, SPECIAL_AD_CATEGORIES,
  targetingRest, unixSekunden, validateDraft, validateEditFields,
  type AdDraft, type AdsetDraft, type BudgetScheduleSpec, type BuilderLintIssue, type CampaignDraft,
  type CreativeTausch, type DraftIssue, type DraftSpec, type EditableStatus, type EditApplyRequest,
  type EditApplyResponse, type EditBaseline, type EditChange, type EditDiffRequest, type EditDiffResponse,
  type EditLoadRequest, type EditLoadResponse, type GuardrailInfo, type Level, type Placements, type SpecialCat,
  type TargetingSpec,
} from '../_shared/metaSpec.ts'
import { lintDraft, type LintMediaInfo } from '../_shared/metaLint.ts'
import {
  adMediaRefs, arr, BuilderError, clone, digits, errText, fillAdMedia, forbiddenNames, fromMetaError, isUuid,
  leaseActive, LEASE_MS, loadDraft, loadMediaRows, metaId, metaPost, nowIso, num, obj, specOf, str, uniq,
  type Ctx, type DraftRow, type MediaIds, type Raw,
} from './common.ts'
import { pageInstagram } from './catalog.ts'
import { fetchImportRaw, levelParam, mapImport, type ImportRaw } from './importer.ts'
import { ensureMediaReady } from './media.ts'
import { readback } from './readback.ts'

const LEVEL_TEXT: Readonly<Record<Level, string>> = { campaign: 'Kampagne', adset: 'Anzeigengruppe', ad: 'Anzeige' }
/** Neue POSTs nur bis zu dieser Laufzeit beginnen (Edge-Function-Limit) */
const RUN_CUTOFF_MS = 45_000
/** Über dieser Meta-Auslastung keine weiteren Schreibzugriffe in diesem Lauf */
const MAX_UTIL_PCT = 85
const ZEIT_TEXT = 'Zeitlimit erreicht. Bitte noch einmal „Übernehmen“, der Rest folgt.'
const fmtEur = (n: number) => n.toFixed(2).replace('.', ',')
const round2 = (n: number) => Math.round(n * 100) / 100
const leaseBusy = () => new BuilderError(409, 'lease_busy', 'Dieser Entwurf wird gerade an Meta übertragen.', 'In einer Minute erneut versuchen.')

// ═══════════════════════════════════════════════════════════════════════════
// Leitplanke über mehrere Objekte (edit_apply, bulk)
// ═══════════════════════════════════════════════════════════════════════════

export interface LeitplankenPosten {
  level: Level
  id: string
  /** Live-Stand bei Meta (status, daily_budget, lifetime_budget, budget_remaining, stop_time/end_time) */
  live: Raw
  /** geplante Änderung (status, daily_budget, lifetime_budget, stop_time/end_time) */
  patch: Raw
  /** zeitweise Erhöhung durch neue Budgetplanung (USD-Cent je Tag, Spitze) */
  extraCents?: number
}

const cents = (v: unknown): number => {
  const n = num(v)
  return n !== null && n > 0 ? Math.round(n) : 0
}

/** USD-Cent je Tag aus eigenem Budget (Laufzeitbudget: Rest / Resttage), optional nach dem Patch. */
export function centsJeTag(o: Raw, endKey: 'stop_time' | 'end_time', patch: Raw = {}): number {
  const hasDaily = patch.daily_budget !== undefined
  const hasLifetime = patch.lifetime_budget !== undefined
  const daily = hasDaily ? cents(patch.daily_budget) : hasLifetime ? 0 : cents(o.daily_budget)
  if (daily) return daily
  const lifetimeAlt = cents(o.lifetime_budget)
  const lifetime = hasLifetime ? cents(patch.lifetime_budget) : lifetimeAlt
  if (!lifetime) return 0
  const ausgegeben = lifetimeAlt && o.budget_remaining !== undefined ? Math.max(0, lifetimeAlt - cents(o.budget_remaining)) : 0
  const rest = Math.max(0, lifetime - ausgegeben)
  const ende = patch[endKey] !== undefined ? patch[endKey] : o[endKey]
  const endMs = typeof ende === 'string' ? Date.parse(ende.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN
  const tage = Number.isFinite(endMs) ? Math.max(1, Math.ceil((endMs - Date.now()) / 86_400_000)) : 1
  return Math.round(rest / tage)
}

const endKeyOf = (level: Level): 'stop_time' | 'end_time' => (level === 'campaign' ? 'stop_time' : 'end_time')

/**
 * Prüft EINMAL für alle Posten, ob die Summe aktiver Tagesbudgets nach den Änderungen
 * unter ad_settings.max_account_daily_budget bleibt. null = nichts steigt (keine Prüfung
 * nötig). Zählt ein Objekt, das schon läuft oder eingeschaltet wird; Kampagne ohne eigenes
 * Budget, die eingeschaltet wird: ihre eingeschalteten Anzeigengruppen. Senken und Pausieren
 * blockiert nie. Wirft, wenn Meta nicht vollständig lesbar ist.
 */
export async function leitplankePruefen(ctx: Ctx, posten: LeitplankenPosten[]): Promise<GuardrailInfo | null> {
  const relevant = posten.filter(p => p.level !== 'ad')
  const steigt = relevant.some(p => {
    const ek = endKeyOf(p.level)
    return p.patch.status === 'ACTIVE' || (p.extraCents ?? 0) > 0 || centsJeTag(p.live, ek, p.patch) > centsJeTag(p.live, ek)
  })
  if (!steigt) return null
  const h0 = await budgetHeadroom(ctx.sb, { addDailyUsdCents: 0 })
  const gezaehlt = new Map(h0.eintraege.map(e => [digits(e.id), e]))
  const byId = new Map(relevant.map(p => [digits(p.id), p]))
  const erledigt = new Set<string>()
  let minusEur = 0
  let plusCents = 0
  const sortiert = relevant.slice().sort((a, b) => (a.level === b.level ? 0 : a.level === 'campaign' ? -1 : 1))
  for (const p of sortiert) {
    const id = digits(p.id)
    if (erledigt.has(id)) continue
    erledigt.add(id)
    const ek = endKeyOf(p.level)
    const war = gezaehlt.get(id)
    const endStatus = str(p.patch.status) || str(p.live.status)
    const zaehlt = endStatus === 'ACTIVE' && (!!war || p.patch.status === 'ACTIVE')
    if (war) minusEur += war.eur
    if (!zaehlt) continue
    let neu = centsJeTag(p.live, ek, p.patch)
    if (p.level === 'campaign' && !neu && p.patch.status === 'ACTIVE') {
      // Kampagne ohne Kampagnenbudget: ihre eingeschalteten Anzeigengruppen fangen an
      const gruppen = await graphAll<Raw>(`${id}/adsets`, {
        fields: 'id,status,daily_budget,lifetime_budget,budget_remaining,end_time', limit: 100,
      }, { strict: true })
      for (const g of gruppen) {
        const gid = digits(g.id)
        const gp = byId.get(gid)
        erledigt.add(gid)
        const gStatus = gp ? (str(gp.patch.status) || str(g.status)) : str(g.status)
        if (gStatus !== 'ACTIVE') continue
        const gw = gezaehlt.get(gid)
        if (gw) minusEur += gw.eur
        neu += centsJeTag(gp ? { ...g, ...gp.live } : g, 'end_time', gp ? gp.patch : {}) + (gp?.extraCents ?? 0)
      }
    }
    plusCents += neu + (p.extraCents ?? 0)
  }
  const afterEur = h0.activeEur - minusEur + plusCents / 100 / h0.usdPerEur
  return {
    limitEur: h0.limitEur,
    activeEur: h0.activeEur,
    afterEur: round2(afterEur),
    rateEurPerUsd: h0.rateEurPerUsd,
    ok: afterEur <= h0.limitEur + 0.005 || afterEur <= h0.activeEur + 0.005,
  }
}

export function leitplankenFehler(g: GuardrailInfo): BuilderError {
  return new BuilderError(409, 'guardrail_exceeded',
    `Budget-Leitplanke: heute aktiv ${fmtEur(g.activeEur)} €, nach der Änderung ${fmtEur(g.afterEur)} €, Limit ${fmtEur(g.limitEur)} € pro Tag.`,
    'Erst andere Budgets senken oder pausieren. Das Limit kann nur ein Admin in den Werbe-Einstellungen anheben.', g)
}

// ═══════════════════════════════════════════════════════════════════════════
// Budget-Änderungen je Stunde (Meta: höchstens 4x je Objekt)
// ═══════════════════════════════════════════════════════════════════════════

/** Zeitstempel (ms) erfolgreicher Budget-Änderungen der letzten Stunde je Objekt aus meta_write_log. */
export async function budgetAenderungen(ctx: Ctx, ids: string[]): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {}
  const list = uniq(ids.map(digits).filter(Boolean))
  if (!list.length) return out
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const { data, error } = await ctx.sb.from('meta_write_log')
    .select('entity_id, ts, request, ok, validate_only').in('entity_id', list).gte('ts', since).limit(1000)
  if (error) {
    console.warn('[meta-builder] meta_write_log (Budget-Limit):', String(error.message ?? error).slice(0, 200))
    return out
  }
  for (const r of arr<Raw>(data)) {
    if (r.ok !== true || r.validate_only === true) continue
    const req = obj(r.request)
    if (req.daily_budget === undefined && req.lifetime_budget === undefined) continue
    const t = Date.parse(str(r.ts))
    if (!Number.isFinite(t)) continue
    const id = str(r.entity_id)
    ;(out[id] = out[id] ?? []).push(t)
  }
  return out
}

/** Sperrtext, wenn das Objekt in der letzten Stunde schon 4 Budget-Änderungen hatte. */
export function budgetSperre(zeiten: number[] | undefined): string | null {
  const z = (zeiten ?? []).slice().sort((a, b) => a - b)
  if (z.length < LIMITS.budgetChangesPerHour) return null
  const frei = new Date(z[z.length - LIMITS.budgetChangesPerHour] + 3_600_000)
  const uhr = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(frei)
  return `Meta erlaubt höchstens ${LIMITS.budgetChangesPerHour} Budgetänderungen pro Stunde. Wieder möglich ab ${uhr} Uhr.`
}

export function fehlerText(err: unknown): string {
  if (err instanceof MetaApiError) {
    const be = fromMetaError(err)
    return be.message
  }
  if (err instanceof BuilderError) return err.message
  return errText(err).slice(0, 300)
}

/** Meta-Rate-Limit fast erreicht? Dann keine weiteren Schreibzugriffe in diesem Lauf. */
export function auslastungZuHoch(): string | null {
  const u = getLastUsage()
  if (u && u.present && u.accUtilPct > MAX_UTIL_PCT) {
    return `Meta drosselt gerade (Auslastung ${Math.round(u.accUtilPct)} %). Den Rest bitte später übernehmen.`
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// Live-Stand laden
// ═══════════════════════════════════════════════════════════════════════════

export interface EditState { spec: DraftSpec; raw: ImportRaw; warnings: string[] }

const isoAus = (v: unknown): string => {
  const sek = unixSekunden(v)
  return sek === null ? str(v) : new Date(sek * 1000).toISOString()
}

/** Bestehendes Objekt samt Kampagne/Gruppe(n)/Anzeige(n) als Bearbeiten-Stand von Meta. */
export async function loadEditState(ctx: Ctx, level: Level, id: string): Promise<EditState> {
  const warn: string[] = []
  const raw = await fetchImportRaw(ctx, level, id, warn, true)
  const st = await ctx.settings()
  const spec = mapImport(raw, { page_id: st.default_page_id || ctx.env.pageId }, warn, true)
  // Budgetplanung der Kampagne (nur mit Kampagnen-Tagesbudget). Lesen ist tolerant:
  // ohne Ergebnis bleibt die Liste leer, neue Zeiträume lassen sich trotzdem anlegen.
  if ((spec.campaign.daily_budget_cents ?? 0) > 0 && spec.campaign.existing_id) {
    try {
      const list = await graphAll<Raw>(`${spec.campaign.existing_id}/budget_schedules`, {
        fields: 'id,time_start,time_end,budget_value,budget_value_type,recurrence_type,weekly_schedule,status', limit: 50,
      }, { maxPages: 1 })
      const zeitraeume: BudgetScheduleSpec[] = list
        .filter(z => ['DELETED', 'INACTIVE', 'CANCELLED'].indexOf(str(z.status).toUpperCase()) < 0)
        .map(z => ({
          id: str(z.id),
          time_start: isoAus(z.time_start),
          time_end: isoAus(z.time_end),
          budget_value: num(z.budget_value) ?? 0,
          budget_value_type: str(z.budget_value_type) === 'MULTIPLIER' ? 'MULTIPLIER' : 'ABSOLUTE',
          ...(str(z.recurrence_type) === 'WEEKLY' || str(z.recurrence_type) === 'ONE_TIME' ? { recurrence_type: str(z.recurrence_type) as 'WEEKLY' | 'ONE_TIME' } : {}),
          ...(arr(z.weekly_schedule).length ? { weekly_schedule: clone(arr(z.weekly_schedule)) as BudgetScheduleSpec['weekly_schedule'] } : {}),
        }))
      if (zeitraeume.length) spec.campaign.budget_schedule_specs = zeitraeume
    } catch (e) {
      warn.push(`Budgetplanung der Kampagne nicht lesbar (${errText(e).slice(0, 120)}). Bestehende Zeiträume werden nicht angezeigt.`)
    }
  }
  spec.hp = { creative_tausch: 'neue_anzeige' }
  return { spec, raw, warnings: warn }
}

function objektName(spec: DraftSpec, level: Level, id: string): string {
  if (level === 'campaign') return spec.campaign.name || id
  if (level === 'adset') return spec.adsets.find(a => a.existing_id === id)?.name || id
  return spec.ads.find(a => a.existing_id === id)?.name || id
}

// ═══════════════════════════════════════════════════════════════════════════
// edit_load
// ═══════════════════════════════════════════════════════════════════════════

function editInfo(d: DraftRow): EditBaseline | null {
  const e = obj(obj(d.meta_ids).edit)
  if (!e.baseline || typeof e.baseline !== 'object') return null
  return e as unknown as EditBaseline
}

export async function modeEditLoad(ctx: Ctx, req: EditLoadRequest): Promise<EditLoadResponse> {
  const level = levelParam(req.level)
  const id = metaId(req.id, 'id')
  const { data: found, error: fErr } = await ctx.sb.from('meta_drafts').select('*')
    .eq('kind', 'edit').neq('status', 'discarded')
    .eq('meta_ids->edit->>level', level).eq('meta_ids->edit->>id', id)
    .order('updated_at', { ascending: false }).limit(1)
  if (fErr) throw new BuilderError(500, 'internal', `Bearbeiten-Entwurf suchen: ${String(fErr.message ?? fErr).slice(0, 200)}`)
  const existing = (arr<DraftRow>(found)[0] ?? null)
  let freigegeben = false
  if (existing) {
    existing.meta_ids = (existing.meta_ids && typeof existing.meta_ids === 'object') ? existing.meta_ids : {}
    if (existing.status === 'creating' && leaseActive(existing)) throw leaseBusy()
    if (existing.status === 'creating') {
      // Abgebrochener Lauf (Sperre abgelaufen): wieder freigeben, sonst blockt meta_drafts_guard jedes Speichern im Browser
      const cutoff = new Date(Date.now() - LEASE_MS).toISOString()
      const { data: frei, error: frErr } = await ctx.sb.from('meta_drafts')
        .update({ status: 'draft', run_lease: null, run_lease_at: null })
        .eq('id', existing.id).eq('status', 'creating')
        .or(`run_lease.is.null,run_lease_at.lt."${cutoff}"`)
        .select('id')
      if (frErr) throw new BuilderError(500, 'internal', `Bearbeiten-Entwurf freigeben: ${String(frErr.message ?? frErr).slice(0, 200)}`)
      if (!arr(frei).length) throw leaseBusy()
      existing.status = 'draft'
      existing.run_lease = null
      existing.run_lease_at = null
      freigegeben = true
    }
  }

  const live = await loadEditState(ctx, level, id)
  const warnings = [...live.warnings]
  if (freigegeben) warnings.push('Ein abgebrochenes „Übernehmen“ wurde freigegeben. Bitte prüfen, was davon bei Meta schon geändert ist.')

  // Offene Änderungen wieder aufnehmen (außer „Neu laden“)
  const eb = existing ? editInfo(existing) : null
  if (existing && eb && req.neu_laden !== true) {
    let offen = false
    try { offen = editDiff(eb.baseline, specOf(existing)).changes.length > 0 } catch { offen = false }
    if (offen) {
      const drift = editDiff(eb.baseline, { ...live.spec, hp: { creative_tausch: 'ersetzen' } }).changes
      if (drift.length) {
        warnings.push(`Bei Meta wurden seit dem Laden ${drift.length} Einstellung${drift.length === 1 ? '' : 'en'} geändert. „Übernehmen“ überspringt diese Felder; „Neu laden“ holt den aktuellen Stand (offene Änderungen gehen dabei verloren).`)
      }
      warnings.push('Offene, noch nicht übernommene Änderungen wieder geladen.')
      return {
        draft_id: existing.id, spec: specOf(existing), locks: editLocks(eb.baseline), warnings,
        baseline_at: eb.loaded_at, reused: true,
      }
    }
  }

  const baseline = live.spec
  const info: EditBaseline = { level, id, baseline, loaded_at: nowIso(), graph_version: GRAPH_VERSION }
  const campaignId = baseline.campaign.existing_id ?? null
  const adsetId = level === 'adset' ? id : level === 'ad' ? (baseline.adsets[0]?.existing_id ?? null) : null
  const name = cleanName(`Bearbeiten: ${objektName(baseline, level, id)}`, 200) || 'Bearbeiten'
  const row: Raw = {
    name, kind: 'edit', spec: baseline, status: 'draft', validation: null, lint: null, last_error: null,
    meta_ids: { ...(existing ? obj(existing.meta_ids) : {}), edit: info },
    target_campaign_id: campaignId, target_adset_id: adsetId, updated_by: ctx.caller.userId,
  }
  let draftId: string
  if (existing) {
    const { error } = await ctx.sb.from('meta_drafts').update(row).eq('id', existing.id)
    if (error) throw new BuilderError(500, 'internal', `Bearbeiten-Entwurf speichern: ${String(error.message ?? error).slice(0, 200)}`)
    draftId = existing.id
  } else {
    const { data, error } = await ctx.sb.from('meta_drafts').insert({ ...row, created_by: ctx.caller.userId }).select('id').single()
    if (error || !data) throw new BuilderError(500, 'internal', `Bearbeiten-Entwurf anlegen: ${String(error?.message ?? error ?? 'ohne ID').slice(0, 200)}`)
    draftId = str(obj(data).id)
  }
  return { draft_id: draftId, spec: baseline, locks: editLocks(baseline), warnings, baseline_at: info.loaded_at, reused: !!existing }
}

// ═══════════════════════════════════════════════════════════════════════════
// Plan: Änderungen, Konflikte, Prüfung, Schritte
// ═══════════════════════════════════════════════════════════════════════════

type OpArt = 'pause' | 'patch' | 'creative' | 'aktivieren'
interface CreativeOp {
  ad: AdDraft
  adsetId: string
  placements?: Placements
  tausch: CreativeTausch
  /** gewünschter Endstatus der Anzeige (neue Anzeige: wird so geschaltet) */
  endStatus: EditableStatus
  /** Status der alten Anzeige bei Meta */
  altStatus: string
  name: string
  tracking?: Array<Record<string, unknown>>
  conversionDomain?: string
}
interface EditOp {
  art: OpArt
  level: Level
  id: string
  node: string
  body: Raw
  before: Raw
  changes: EditChange[]
  creative?: CreativeOp
  /** Kampagnen-Patch erst nach den Anzeigengruppen senden (Zeitplan der Kampagne zurücksetzen) */
  spaeter?: true
}

interface EditPlan {
  draft: DraftRow
  info: EditBaseline
  baseline: DraftSpec
  spec: DraftSpec
  live: EditState
  changes: EditChange[]
  warnings: string[]
  conflicts: EditDiffResponse['conflicts']
  /** bei Meta schon so wie gewünscht */
  erledigt: EditChange[]
  issues: DraftIssue[]
  lint: BuilderLintIssue[]
  ops: EditOp[]
  posten: LeitplankenPosten[]
  /** neue Werbemittel (neue Anzeige oder Ersetzen) in einer Kampagne ohne Sonderkategorie Wohnen */
  housingFehlt: boolean
  housingHinweise: string[]
}

const RELATED: Readonly<Record<string, readonly string[]>> = {
  'campaign.daily_budget_cents': ['campaign.lifetime_budget_cents', 'campaign.stop_time'],
  'campaign.lifetime_budget_cents': ['campaign.daily_budget_cents', 'campaign.stop_time'],
  'campaign.stop_time': ['campaign.lifetime_budget_cents', 'campaign.start_time'],
  'campaign.start_time': ['campaign.stop_time'],
  'adset.bid_strategy': ['adset.bid_amount_cents', 'adset.roas_average_floor', 'adset.optimization_goal', 'adset.billing_event'],
  'adset.bid_amount_cents': ['adset.bid_strategy'],
  'adset.roas_average_floor': ['adset.bid_strategy', 'adset.optimization_goal'],
  'adset.optimization_goal': [
    'adset.attribution', 'adset.billing_event', 'adset.promoted_object.pixel_id', 'adset.promoted_object.custom_event_type',
    'adset.roas_average_floor', 'adset.bid_amount_cents',
  ],
  'adset.promoted_object.pixel_id': ['adset.promoted_object.custom_event_type'],
  'adset.promoted_object.custom_event_type': ['adset.promoted_object.pixel_id'],
  'adset.attribution': ['adset.optimization_goal'],
  'adset.daily_budget_cents': ['adset.lifetime_budget_cents', 'adset.end_time'],
  'adset.lifetime_budget_cents': ['adset.daily_budget_cents', 'adset.end_time'],
  'adset.start_time': ['adset.end_time'],
  'adset.end_time': ['adset.lifetime_budget_cents'],
  'adset.targeting.geo_locations': ['adset.targeting.advantage_audience', 'adset.dsa_beneficiary', 'adset.dsa_payor'],
  'adset.targeting.age': ['adset.targeting.advantage_audience'],
  'adset.targeting.advantage_audience': ['adset.targeting.age'],
  'adset.daily_min_spend_target_cents': ['adset.daily_spend_cap_cents'],
  'adset.lifetime_min_spend_target_cents': ['adset.lifetime_spend_cap_cents'],
  'adset.dsa_beneficiary': ['adset.dsa_payor'],
  'adset.dsa_payor': ['adset.dsa_beneficiary'],
}

function issueRelevant(i: { level: Level; node: string; field: string }, active: EditChange[]): boolean {
  for (const c of active) {
    if (c.level !== i.level || c.node !== i.node) continue
    if (c.creative && i.level === 'ad') return true
    if (i.field === c.field || i.field.indexOf(`${c.field}.`) === 0 || c.field.indexOf(`${i.field}.`) === 0) return true
    if ((RELATED[c.field] ?? []).indexOf(i.field) >= 0) return true
  }
  return false
}

const liveObjekt = (raw: ImportRaw, level: Level, id: string): Raw | null => {
  if (level === 'campaign') return str(raw.campaign.id) === id ? raw.campaign : null
  if (level === 'adset') return raw.adsets.find(a => str(a.id) === id) ?? null
  return raw.ads.find(a => str(a.id) === id) ?? null
}

/** Merged Targeting: Live-Stand bei Meta + nur die geänderten Teile aus dem Entwurf. */
export function targetingZusammenfuehren(liveT: Raw, s: AdsetDraft, sc: CampaignDraft, fields: string[]): Raw {
  const built = buildTargeting(s, sc) as Raw
  const out = clone(liveT)
  for (const k of Object.keys(out)) if (k.indexOf('effective_') === 0 || k === 'targeting_optimization_types') delete out[k]
  for (const f of fields) {
    if (f === 'adset.targeting') {
      const restSpec = targetingRest(s.targeting)
      const restLive = targetingRest(liveT as unknown as TargetingSpec)
      for (const k of Object.keys(restLive)) if (!(k in restSpec)) delete out[k]
      for (const k of Object.keys(restSpec)) out[k] = clone(restSpec[k])
      continue
    }
    for (const k of EDIT_TARGETING_KEYS[f] ?? []) {
      if (k === 'geo_locations.location_types') {
        const g = obj(out.geo_locations)
        const lt = obj(built.geo_locations).location_types
        if (lt === undefined) delete g.location_types
        else g.location_types = clone(lt)
        out.geo_locations = g
        continue
      }
      if (k === 'geo_locations') {
        const altTypen = obj(out.geo_locations).location_types
        const g = clone(obj(built.geo_locations))
        if (fields.indexOf('adset.targeting.location_types') < 0) {
          if (altTypen !== undefined) g.location_types = clone(altTypen)
          else delete g.location_types
        }
        out.geo_locations = g
        continue
      }
      if (built[k] === undefined) delete out[k]
      else out[k] = clone(built[k])
    }
  }
  return out
}

/** Felder des Werbemittels einer Anzeige (ein Tausch geht immer als Ganzes). */
const WERBEMITTEL_KEYS = ['format', 'identity', 'primary_texts', 'headlines', 'descriptions', 'cta_type', 'destination', 'media', 'creative_features', 'multi_advertiser'] as const

/**
 * Schreibt den gewünschten Wert einer Änderung (aus wunsch) in ziel (frischer Stand von Meta),
 * Knoten über existing_id. So bleiben nicht übernommene Änderungen nach edit_apply im Entwurf.
 * false = Knoten fehlt oder Feld ist keins des Formulars (z. B. Zeitplan der Kampagne).
 */
export function wunschUebernehmen(ziel: DraftSpec, wunsch: DraftSpec, c: EditChange): boolean {
  const knoten = (d: DraftSpec): Raw | undefined => {
    if (c.level === 'campaign') return d.campaign?.existing_id === c.id ? d.campaign as unknown as Raw : undefined
    const list = (c.level === 'adset' ? d.adsets : d.ads) as unknown as Raw[] | undefined
    return (list ?? []).find(n => str(n.existing_id) === c.id)
  }
  const z = knoten(ziel), w = knoten(wunsch)
  if (!z || !w || c.field === 'campaign.pacing_type') return false
  const setze = (o: Raw, k: string, v: unknown) => { if (v === undefined) delete o[k]; else o[k] = clone(v) }
  if (c.creative) { for (const k of WERBEMITTEL_KEYS) setze(z, k, w[k]); return true }
  const pfad = c.field.slice(c.level.length + 1)
  if (c.field === 'adset.targeting' || pfad.indexOf('targeting.') === 0) {
    const zt = obj(z.targeting), wt = obj(w.targeting)
    if (c.field === 'adset.targeting') {
      for (const k of Object.keys(targetingRest(zt as unknown as TargetingSpec))) delete zt[k]
      const rest = targetingRest(wt as unknown as TargetingSpec)
      for (const k of Object.keys(rest)) zt[k] = clone(rest[k])
    } else if (c.field === 'adset.targeting.geo_locations') {
      const typen = obj(zt.geo_locations).location_types
      const g = clone(obj(wt.geo_locations))
      if (typen === undefined) delete g.location_types
      else g.location_types = clone(typen)
      zt.geo_locations = g
    } else if (c.field === 'adset.targeting.location_types') {
      const g = obj(zt.geo_locations)
      setze(g, 'location_types', obj(wt.geo_locations).location_types)
      zt.geo_locations = g
    } else for (const k of EDIT_TARGETING_KEYS[c.field] ?? []) setze(zt, k, wt[k])
    z.targeting = zt
    return true
  }
  const teile = pfad.split('.')
  if (teile.length === 2) {
    const zo = obj(z[teile[0]])
    setze(zo, teile[1], obj(w[teile[0]])[teile[1]])
    z[teile[0]] = zo
    return true
  }
  setze(z, pfad, w[pfad])
  return true
}

/**
 * Wohnen-/Beschäftigung-/Finanz-Regeln auf ein Targeting einer BESTEHENDEN Gruppe
 * (applyHousing über einen Mini-Entwurf, wie meta-ads-tools). Fehlt advantage_audience,
 * gilt 0 (bestehende Gruppe), nicht der Assistenten-Standard 1.
 */
export function housingAufTargeting(t: Raw, cats: string[], countries: string[]): { targeting: Raw; changes: string[] } {
  const sac = SPECIAL_AD_CATEGORIES.filter(c => cats.indexOf(c) >= 0) as SpecialCat[]
  if (!isHec(sac)) return { targeting: t, changes: [] }
  const vorher = clone(t)
  const ta = obj(vorher.targeting_automation)
  if (ta.advantage_audience !== 0 && ta.advantage_audience !== 1) ta.advantage_audience = ta.advantage_audience === true || ta.advantage_audience === '1' ? 1 : 0
  vorher.targeting_automation = ta
  const draft: DraftSpec = {
    v: 1,
    campaign: {
      existing_id: 'bestand', name: 'bestand', objective: 'OUTCOME_LEADS', buying_type: 'AUCTION',
      special_ad_categories: sac, special_ad_category_country: countries, budget_level: 'adset',
    },
    adsets: [{
      key: 'gruppe', name: 'gruppe', destination: 'WEBSITE', optimization_goal: 'OFFSITE_CONVERSIONS',
      billing_event: 'IMPRESSIONS', promoted_object: {}, attribution: 'click_7d_view_1d',
      targeting: vorher as unknown as TargetingSpec, placements: { mode: 'advantage' }, dsa_beneficiary: '', dsa_payor: '',
    }],
    ads: [],
  }
  const res = applyHousing(draft, { forceCategory: false })
  const after = (res.spec.adsets[0]?.targeting ?? vorher) as unknown as Raw
  return { targeting: after, changes: uniq(res.changes.filter(c => c.node !== 'campaign').map(c => c.code)) }
}

/** Wohnen-Korrekturen in Klartext (Hinweis an der Oberfläche). */
const HOUSING_TEXT: Readonly<Record<string, string>> = {
  category_added: 'Sonderkategorie Wohnen ergänzt',
  country_default: 'Land DE gesetzt',
  age_set: 'Alter auf 18 bis 65+ gesetzt',
  age_range_removed: 'Altersvorschlag entfernt',
  genders_removed: 'Geschlecht auf alle gesetzt',
  geo_type_removed: 'Postleitzahlen bzw. kleinräumige Orte entfernt',
  radius_raised: 'Radius auf das Minimum angehoben',
  excluded_geo_removed: 'Ortsausschlüsse entfernt',
  detailed_removed: 'Verhaltens-/Demografie-Targeting entfernt',
  exclusions_removed: 'Ausschlüsse entfernt',
  lookalike_removed: 'Lookalikes entfernt',
  advantage_audience_set: 'Advantage+ Zielgruppe ausdrücklich gesetzt',
  individual_setting_removed: 'Einzelvorschläge der Advantage+ Zielgruppe entfernt',
}
const WOHNEN_VERBOTEN = 'Unter der Sonderkategorie Wohnen nicht erlaubt (Meta-Regel), wird nicht gesendet.'

const zeitraumFuerMeta = (z: BudgetScheduleSpec): Raw => ({
  time_start: unixSekunden(z.time_start),
  time_end: unixSekunden(z.time_end),
  budget_value: Math.round(z.budget_value),
  budget_value_type: z.budget_value_type,
  ...(z.recurrence_type ? { recurrence_type: z.recurrence_type } : {}),
  ...(z.weekly_schedule && z.weekly_schedule.length ? { weekly_schedule: z.weekly_schedule } : {}),
})
/**
 * Neue Zeiträume der Budgetplanung als eigener Schritt: edit_apply sendet je Zeitraum
 * POST /{id}/budget_schedules (budget_schedule_specs dokumentiert Meta nur beim Anlegen).
 */
const zeitraumOp = (level: Level, id: string, node: string, neu: BudgetScheduleSpec[], c: EditChange): EditOp => ({
  art: 'patch', level, id, node, body: { budget_schedule_specs: neu.map(zeitraumFuerMeta) }, changes: [c], before: {},
})
/** Zeitplan der Kampagne (pacing_type) ist kein Formularfeld, sondern Folge des Gruppen-Zeitplans */
const PACING_LABEL_KEY = 'crm.werbung.meta.field.campaign_pacing_type'
/** Spitzen-Erhöhung neuer Budgetzeiträume (USD-Cent je Tag) für die Leitplanke. */
const zeitraumSpitze = (neu: BudgetScheduleSpec[], basisCents: number): number =>
  neu.reduce((m, z) => Math.max(m, z.budget_value_type === 'ABSOLUTE' ? Math.round(z.budget_value) : Math.round(basisCents * z.budget_value / 100)), 0)

/** Nächster Name für die Ersatz-Anzeige: 08_x_lang -> 08_x-v2_lang (Kennung bleibt eindeutig). */
export function naechsterAnzeigenName(name: string): string {
  const m = /^(.*?)(_(?:lang|kurz))?$/i.exec(name.trim()) ?? ['', name.trim(), '']
  const basis = m[1] || name.trim()
  const suffix = m[2] ?? ''
  const v = /-v(\d+)$/.exec(basis)
  const neu = v ? `${basis.slice(0, basis.length - v[0].length)}-v${Number(v[1]) + 1}` : `${basis}-v2`
  return cleanName(`${neu}${suffix}`)
}

const domainOf = (url: string): string | undefined => {
  const m = /^https?:\/\/([^/?#:]+)/i.exec((url ?? '').trim())
  if (!m) return undefined
  const parts = m[1].toLowerCase().replace(/^www\./, '').split('.')
  return parts.length > 2 ? parts.slice(parts.length - 2).join('.') : parts.join('.')
}

async function planEdit(ctx: Ctx, draft: DraftRow): Promise<EditPlan> {
  if (draft.kind !== 'edit') throw new BuilderError(400, 'unsupported', 'Das ist kein Bearbeiten-Entwurf.', 'Bestehende Objekte über „Bearbeiten“ öffnen (edit_load).')
  if (draft.status === 'discarded') throw new BuilderError(409, 'invalid_request', 'Der Entwurf ist verworfen.')
  const info = editInfo(draft)
  if (!info) throw new BuilderError(409, 'edit_conflict', 'Zu diesem Entwurf fehlt der Ausgangsstand von Meta.', 'Objekt neu laden (Bearbeiten öffnen).')
  const baseline = clone(info.baseline)
  const spec = specOf(draft)
  const diff = editDiff(baseline, spec)
  const live = await loadEditState(ctx, info.level, info.id)
  const warnings = [...diff.warnings, ...live.warnings.filter(w => diff.warnings.indexOf(w) < 0)]
  const conflicts: EditPlan['conflicts'] = []
  const liveCats = arr<unknown>(live.raw.campaign.special_ad_categories).map(str)
  const liveCountries = arr<unknown>(live.raw.campaign.special_ad_category_country).map(str)
  const erledigt: EditChange[] = []

  // Abgleich mit dem Live-Stand: inzwischen bei Meta geändert = Konflikt (nicht überschreiben)
  for (const ch of diff.changes) {
    if (ch.blocked) continue
    const liveVal = editFieldValue(live.spec, ch.level, ch.id, ch.field)
    if (liveVal === undefined) {
      ch.blocked = `${LEVEL_TEXT[ch.level]} ist bei Meta nicht mehr lesbar. Bitte neu laden.`
      ch.learning_reset = false
      conflicts.push({ level: ch.level, id: ch.id, field: ch.field, live: null })
      continue
    }
    if (editSame(ch.field, liveVal, ch.before)) continue
    if (editSame(ch.field, liveVal, ch.after)) { erledigt.push(ch); continue }
    ch.blocked = 'Bei Meta seit dem Laden geändert. Bitte neu laden, dann erneut ändern.'
    ch.learning_reset = false
    conflicts.push({ level: ch.level, id: ch.id, field: ch.field, live: liveVal })
  }
  if (conflicts.length) warnings.push(`${conflicts.length} Einstellung${conflicts.length === 1 ? ' wurde' : 'en wurden'} bei Meta seit dem Laden geändert und ${conflicts.length === 1 ? 'wird' : 'werden'} nicht überschrieben.`)
  let active = diff.changes.filter(c => !c.blocked && erledigt.indexOf(c) < 0)

  // Identität neuer Werbemittel ergänzen (Seite/IG wie beim Anlegen)
  const st = await ctx.settings()
  const creativeAds = uniq(active.filter(c => c.creative).map(c => c.node))
  let igStandard: string | null | undefined
  for (const key of creativeAds) {
    const ad = spec.ads.find(a => a.key === key)
    if (!ad) continue
    if (!ad.identity || typeof ad.identity !== 'object') ad.identity = { page_id: '', instagram_user_id: '' }
    const page = st.default_page_id || ctx.env.pageId
    if (!str(ad.identity.page_id).trim()) ad.identity.page_id = page
    if (!str(ad.identity.instagram_user_id).trim() && ad.identity.page_id === page) {
      if (igStandard === undefined) {
        igStandard = st.default_ig_user_id
        if (!igStandard) { try { igStandard = (await pageInstagram(page))?.id ?? null } catch { igStandard = null } }
      }
      if (igStandard) ad.identity.instagram_user_id = igStandard
    }
  }

  // Prüfung: geänderte Knoten wie neue prüfen (Wohnen-Regeln vorher angewandt), nur relevante Felder melden
  const vClone = clone(spec)
  const geaendert = new Set(active.map(c => `${c.level}:${c.node}`))
  if (geaendert.has('campaign:campaign')) delete vClone.campaign.existing_id
  for (const a of vClone.adsets) if (geaendert.has(`adset:${a.key}`)) delete a.existing_id
  for (const ad of vClone.ads) if (active.some(c => c.creative && c.node === ad.key)) delete ad.existing_id
  const housed = applyHousing(vClone, { forceCategory: false }).spec
  // edit_only: Bearbeiten-Felder an „neuen“ Knoten (hier nur Probelauf ohne existing_id), gehört nicht hierher
  const issues = [...validateDraft(housed, { realEstate: true, server: true }), ...validateEditFields(spec)]
    .filter(i => i.code !== 'housing_existing' && i.code !== 'edit_only' && issueRelevant(i, active))
  // Zielgruppen-Änderungen, die die Wohnen-Regeln wieder aufheben (z. B. Geschlecht), nicht als „übernommen“ melden
  if (isHec(liveCats)) {
    const hl = clone(housed)
    for (const a of hl.adsets) { const orig = spec.adsets.find(x => x.key === a.key); if (orig?.existing_id) a.existing_id = orig.existing_id }
    for (const c of active) {
      if (c.level !== 'adset' || c.field.indexOf('adset.targeting') !== 0) continue
      const v = editFieldValue(hl, 'adset', c.id, c.field)
      if (v !== undefined && editSame(c.field, v, c.before)) { c.blocked = WOHNEN_VERBOTEN; c.learning_reset = false }
    }
    active = active.filter(c => !c.blocked)
  }
  // Kampagnenbudget + Gebot mit Betrag: jede Gruppe braucht einen Betrag (adset_bid_amounts)
  const cbo = spec.campaign.budget_level === 'campaign'
  if (cbo && active.some(c => c.field === 'campaign.bid_strategy') && BID_NEEDS_AMOUNT.indexOf(spec.campaign.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP') >= 0) {
    for (const a of spec.adsets) {
      if (a.existing_id && !((a.bid_amount_cents ?? 0) > 0)) {
        issues.push({ level: 'adset', node: a.key, field: 'adset.bid_amount_cents', severity: 'error', code: 'bid_amount_required', messageKey: 'crm.werbung.meta.issue.bid_amount_required' })
      }
    }
  }

  // Lint für neue Werbemittel
  let lint: BuilderLintIssue[] = []
  if (creativeAds.length) {
    const ads = spec.ads.filter(a => creativeAds.indexOf(a.key) >= 0)
    const rows = await loadMediaRows(ctx.sb, ads.flatMap(adMediaRefs).map(r => r.media_id))
    const media: Record<string, LintMediaInfo> = {}
    for (const k of Object.keys(rows)) {
      const r = rows[k]
      media[k] = { storage_path: r.storage_path, public_url: r.public_url, ai_generated: r.ai_generated, eu_band_confirmed: r.eu_band_confirmed, ki_label_confirmed: r.ki_label_confirmed }
    }
    lint = lintDraft({ campaign: {}, adsets: [], ads }, { forbiddenNames: await forbiddenNames(ctx.sb), media })
  }

  // Schritte bauen
  const raw = live.raw
  const sc = spec.campaign
  const ops: EditOp[] = []
  const housingHinweise: string[] = []
  const tausch: CreativeTausch = spec.hp?.creative_tausch === 'ersetzen' ? 'ersetzen' : 'neue_anzeige'
  const byNode = new Map<string, EditChange[]>()
  for (const c of active) {
    const k = `${c.level}:${c.node}`
    byNode.set(k, [...(byNode.get(k) ?? []), c])
  }
  const op = (art: OpArt, level: Level, id: string, node: string, body: Raw, changes: EditChange[], before: Raw, creative?: CreativeOp) =>
    ops.push({ art, level, id, node, body, changes, before, ...(creative ? { creative } : {}) })
  const beforeOf = (live0: Raw | null, keys: string[]): Raw => {
    const out: Raw = {}
    if (!live0) return out
    for (const k of keys) if (live0[k] !== undefined) out[k] = live0[k]
    return out
  }
  const statusOps = (level: Level, id: string, node: string, list: EditChange[], live0: Raw | null) => {
    const s = list.find(c => c.field === `${level}.status`)
    if (!s) return
    op(s.after === 'PAUSED' ? 'pause' : 'aktivieren', level, id, node, { status: s.after }, [s], beforeOf(live0, ['status', 'effective_status']))
  }
  // Zeitplan nach Uhrzeit unter Kampagnenbudget: Meta schaltet ihn an der Kampagne (pacing_type), das wirkt auf alle Gruppen
  const zeitplanAn: string[] = []
  const zeitplanAus: string[] = []

  // Anzeigengruppen zuerst sammeln (Zeitplan bei Kampagnenbudget braucht pacing_type an der Kampagne)
  const adsetOps: EditOp[] = []
  for (const s of spec.adsets) {
    if (!s.existing_id) continue
    const list = byNode.get(`adset:${s.key}`) ?? []
    if (!list.length) continue
    const live0 = liveObjekt(raw, 'adset', s.existing_id)
    const b = baseline.adsets.find(x => x.existing_id === s.existing_id)
    const body: Raw = {}
    const used: EditChange[] = []
    const zeitraumOps: EditOp[] = []
    for (const c of list) {
      switch (c.field) {
        case 'adset.name': body.name = cleanName(str(c.after)); used.push(c); break
        case 'adset.daily_budget_cents': body.daily_budget = c.after; used.push(c); break
        case 'adset.lifetime_budget_cents': body.lifetime_budget = c.after; used.push(c); break
        case 'adset.start_time':
          if (c.after === null) { c.blocked = 'Der Start lässt sich nicht entfernen, nur verschieben.'; c.learning_reset = false } else { body.start_time = c.after; used.push(c) }
          break
        case 'adset.end_time':
          if (c.after === null) {
            if ((s.lifetime_budget_cents ?? 0) > 0) { c.blocked = 'Ein Laufzeitbudget braucht ein Enddatum.'; c.learning_reset = false } else { body.end_time = 0; used.push(c) }
          } else { body.end_time = c.after; used.push(c) }
          break
        case 'adset.bid_strategy': case 'adset.bid_amount_cents': case 'adset.roas_average_floor': {
          const strat = effectiveBidStrategy(sc, s)
          if (!cbo) body.bid_strategy = strat
          if (BID_NEEDS_AMOUNT.indexOf(strat) >= 0 && (s.bid_amount_cents ?? 0) > 0) body.bid_amount = Math.round(s.bid_amount_cents ?? 0)
          if (strat === 'LOWEST_COST_WITH_MIN_ROAS' && (s.roas_average_floor ?? 0) > 0) body.bid_constraints = { roas_average_floor: Math.round(s.roas_average_floor ?? 0) }
          used.push(c)
          break
        }
        case 'adset.optimization_goal': {
          body.optimization_goal = c.after
          const rule = promotedRuleFor(sc.objective, s.destination, s.optimization_goal)
          if (rule && !(rule.anyOf.length === 1 && rule.anyOf[0].length === 0)) {
            const po: Raw = { ...obj(live0?.promoted_object) }
            for (const k of promotedAllowed(rule)) { const v = (s.promoted_object as Raw)[k]; if (v !== undefined && v !== null && v !== '') po[k] = v }
            body.promoted_object = po
          }
          used.push(c)
          break
        }
        case 'adset.promoted_object.pixel_id': case 'adset.promoted_object.custom_event_type': {
          const po: Raw = { ...obj(live0?.promoted_object) }
          if (s.promoted_object?.pixel_id) po.pixel_id = s.promoted_object.pixel_id
          if (s.promoted_object?.custom_event_type) po.custom_event_type = s.promoted_object.custom_event_type
          body.promoted_object = po
          used.push(c)
          break
        }
        case 'adset.attribution':
          body.attribution_spec = (ATTRIBUTION_SPECS[s.attribution] ?? ATTRIBUTION_SPECS.click_7d_view_1d).map(w => ({ ...w }))
          used.push(c)
          break
        case 'adset.adset_schedule': {
          const blocks = s.adset_schedule ?? []
          body.adset_schedule = blocks.map(x => ({ start_minute: x.start_minute, end_minute: x.end_minute, days: x.days, ...(x.timezone_type ? { timezone_type: x.timezone_type } : {}) }))
          if (!cbo) body.pacing_type = [blocks.length ? 'day_parting' : 'standard']
          else (blocks.length ? zeitplanAn : zeitplanAus).push(s.existing_id)
          used.push(c)
          break
        }
        case 'adset.daily_min_spend_target_cents': body.daily_min_spend_target = c.after ?? 0; used.push(c); break
        case 'adset.daily_spend_cap_cents': body.daily_spend_cap = c.after ?? META_UNBEGRENZT; used.push(c); break
        case 'adset.lifetime_min_spend_target_cents': body.lifetime_min_spend_target = c.after ?? 0; used.push(c); break
        // Entfernen (null) sperrt editDiff: Metas „unbegrenzt“ ist nur für das Tageslimit dokumentiert
        case 'adset.lifetime_spend_cap_cents': body.lifetime_spend_cap = c.after; used.push(c); break
        case 'adset.budget_schedule_specs': {
          const neu = neueBudgetZeitraeume(b?.budget_schedule_specs, s.budget_schedule_specs)
          if (neu.length) zeitraumOps.push(zeitraumOp('adset', s.existing_id, s.key, neu, c))
          else erledigt.push(c)
          break
        }
        case 'adset.dsa_beneficiary': case 'adset.dsa_payor':
          body.dsa_beneficiary = str(s.dsa_beneficiary).trim()
          body.dsa_payor = str(s.dsa_payor).trim()
          used.push(c)
          break
        case 'adset.status': break
        default:
          if (c.field === 'adset.targeting' || c.field.indexOf('adset.targeting.') === 0 || c.field === 'adset.placements'
            || c.field === 'adset.brand_safety' || c.field === 'adset.excluded_publisher_categories') used.push(c)
      }
    }
    const tFields = used.filter(c => c.field === 'adset.targeting' || c.field.indexOf('adset.targeting.') === 0 || c.field === 'adset.placements'
      || c.field === 'adset.brand_safety' || c.field === 'adset.excluded_publisher_categories').map(c => c.field)
    if (tFields.length) {
      let t = targetingZusammenfuehren(obj(live0?.targeting), s, sc, tFields)
      const h = housingAufTargeting(t, liveCats, liveCountries)
      t = h.targeting
      if (h.changes.length) housingHinweise.push(`${LEVEL_TEXT.adset} „${s.name}“: Wohnen-Regeln angewendet (${h.changes.map(c => HOUSING_TEXT[c] ?? c).join(', ')}).`)
      body.targeting = t
    }
    if (Object.keys(body).length) {
      adsetOps.push({ art: 'patch', level: 'adset', id: s.existing_id, node: s.key, body, changes: used, before: beforeOf(live0, Object.keys(body).map(k => k)) })
    }
    adsetOps.push(...zeitraumOps)
    statusOps('adset', s.existing_id, s.key, list, live0)
  }

  // Zeitplan der Kampagne (nur Kampagnenbudget) als eigene, sichtbare Änderung
  const cLive = raw.campaign
  const livePacing = arr<unknown>(cLive.pacing_type).map(str).filter(Boolean)
  let pacingAn: EditChange | null = null
  let pacingAus: EditChange | null = null
  if (cbo && sc.existing_id) {
    const pacingChange = (after: string[]): EditChange => ({
      level: 'campaign', id: str(sc.existing_id), node: 'campaign', field: 'campaign.pacing_type', label_key: PACING_LABEL_KEY,
      before: livePacing.length ? livePacing : null, after, learning: 'moeglich', learning_reset: false,
    })
    const kampagne = `${LEVEL_TEXT.campaign} „${sc.name || sc.existing_id}“`
    if (zeitplanAn.length && livePacing.indexOf('day_parting') < 0) {
      pacingAn = pacingChange(['day_parting'])
      warnings.push(`${kampagne}: Für Anzeigen nach Zeitplan stellt Meta die ganze Kampagne auf Zeitplan um. Das gilt für alle Anzeigengruppen dieser Kampagne.`)
    } else if (!zeitplanAn.length && zeitplanAus.length && livePacing.indexOf('day_parting') >= 0) {
      // nur zurücksetzen, wenn danach keine Anzeigengruppe der Kampagne mehr einen Zeitplan hat
      const hatZeitplan = (g: Raw): boolean => {
        const d = spec.adsets.find(a => a.existing_id === str(g.id))
        return d ? (d.adset_schedule ?? []).length > 0 : arr(g.adset_schedule).length > 0
      }
      let rest: boolean | null = null
      if (info.level === 'campaign') rest = raw.adsets.some(hatZeitplan)
      else {
        try {
          const gruppen = await graphAll<Raw>(`${sc.existing_id}/adsets`, { fields: 'id,adset_schedule,effective_status', limit: 100 }, { maxPages: 3, strict: true })
          rest = gruppen.filter(g => ['DELETED', 'ARCHIVED'].indexOf(str(g.effective_status)) < 0).some(hatZeitplan)
        } catch (e) {
          warnings.push(`${kampagne}: Andere Anzeigengruppen nicht lesbar (${errText(e).slice(0, 120)}). Der Zeitplan der Kampagne bleibt an.`)
        }
      }
      if (rest === false) {
        pacingAus = pacingChange(['standard'])
        warnings.push(`${kampagne}: Keine Anzeigengruppe hat danach noch einen Zeitplan. Die Kampagne läuft wieder ohne Zeitplan.`)
      }
    }
    if (pacingAn) diff.changes.push(pacingAn)
    if (pacingAus) diff.changes.push(pacingAus)
  }

  // Kampagne
  const cList = byNode.get('campaign:campaign') ?? []
  if (sc.existing_id && (cList.length || pacingAn)) {
    const body: Raw = pacingAn ? { pacing_type: pacingAn.after } : {}
    const used: EditChange[] = pacingAn ? [pacingAn] : []
    const zeitraumOps: EditOp[] = []
    for (const c of cList) {
      switch (c.field) {
        case 'campaign.name': body.name = cleanName(str(c.after)); used.push(c); break
        case 'campaign.daily_budget_cents': body.daily_budget = c.after; used.push(c); break
        case 'campaign.lifetime_budget_cents': body.lifetime_budget = c.after; used.push(c); break
        case 'campaign.bid_strategy': {
          const strat = sc.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'
          body.bid_strategy = strat
          if (BID_NEEDS_AMOUNT.indexOf(strat) >= 0) {
            const map: Raw = {}
            for (const a of spec.adsets) if (a.existing_id && (a.bid_amount_cents ?? 0) > 0) map[a.existing_id] = Math.round(a.bid_amount_cents ?? 0)
            body.adset_bid_amounts = map
          }
          used.push(c)
          break
        }
        case 'campaign.is_adset_budget_sharing_enabled': body.is_adset_budget_sharing_enabled = false; used.push(c); break
        case 'campaign.spend_cap_cents': body.spend_cap = c.after ?? META_UNBEGRENZT; used.push(c); break
        case 'campaign.start_time':
          if (c.after === null) { c.blocked = 'Der Start lässt sich nicht entfernen, nur verschieben.'; c.learning_reset = false } else { body.start_time = c.after; used.push(c) }
          break
        case 'campaign.stop_time':
          if (c.after === null) { c.blocked = 'Das Kampagnenende lässt sich hier nicht entfernen, nur verschieben.'; c.learning_reset = false } else { body.stop_time = c.after; used.push(c) }
          break
        case 'campaign.budget_schedule_specs': {
          const neu = neueBudgetZeitraeume(baseline.campaign.budget_schedule_specs, sc.budget_schedule_specs)
          if (neu.length) zeitraumOps.push(zeitraumOp('campaign', sc.existing_id, 'campaign', neu, c))
          else erledigt.push(c)
          break
        }
      }
    }
    if (Object.keys(body).length) op('patch', 'campaign', sc.existing_id, 'campaign', body, used, beforeOf(cLive, Object.keys(body)))
    ops.push(...zeitraumOps)
    statusOps('campaign', sc.existing_id, 'campaign', cList, cLive)
  }
  // Zurücksetzen erst nach den Anzeigengruppen (sonst hätte eine Gruppe kurz einen Zeitplan ohne Kampagnen-Zeitplan)
  if (pacingAus && sc.existing_id) {
    ops.push({ art: 'patch', level: 'campaign', id: sc.existing_id, node: 'campaign', body: { pacing_type: pacingAus.after }, changes: [pacingAus], before: beforeOf(cLive, ['pacing_type']), spaeter: true })
  }
  ops.push(...adsetOps)

  // Anzeigen
  let housingFehlt = false
  for (const s of spec.ads) {
    if (!s.existing_id) continue
    const list = byNode.get(`ad:${s.key}`) ?? []
    if (!list.length) continue
    const live0 = liveObjekt(raw, 'ad', s.existing_id)
    const b = baseline.ads.find(x => x.existing_id === s.existing_id)
    const cre = list.filter(c => c.creative)
    const statusCh = list.find(c => c.field === 'ad.status')
    const nameCh = list.find(c => c.field === 'ad.name')
    const trackCh = list.find(c => c.field === 'ad.tracking_specs')
    // Immer die Anzeigengruppe bei Meta (Verschieben geht nicht; editDiff sperrt verschobene Anzeigen)
    const adsetId = str(live0?.adset_id) || str(baseline.adsets.find(a => a.key === b?.adset_key)?.existing_id)
    const set = spec.adsets.find(a => !!adsetId && a.existing_id === adsetId)
    if (cre.length) {
      if (!adsetId) { for (const c of cre) { c.blocked = 'Anzeigengruppe der Anzeige nicht gefunden. Bitte neu laden.'; c.learning_reset = false } continue }
      const altStatus = str(live0?.status) || str(b?.status)
      const endStatus: EditableStatus = (s.status === 'ACTIVE' || s.status === 'PAUSED') ? s.status : (altStatus === 'ACTIVE' ? 'ACTIVE' : 'PAUSED')
      const changes = [...cre]
      // Jedes neue Werbemittel ist neue Immobilien-Werbung, auch beim Ersetzen: nur in Wohnen-Kampagnen
      if (liveCats.indexOf('HOUSING') < 0) housingFehlt = true
      if (tausch === 'neue_anzeige') {
        // Name, Tracking und Status gehen an die neue Anzeige; die alte endet pausiert
        if (nameCh) changes.push(nameCh)
        if (trackCh) changes.push(trackCh)
        if (statusCh) changes.push(statusCh)
      } else {
        if (nameCh) changes.push(nameCh)
        if (trackCh) changes.push(trackCh)
      }
      const name = tausch === 'neue_anzeige'
        ? (nameCh ? cleanName(str(nameCh.after)) : naechsterAnzeigenName(b?.name || s.name))
        : cleanName(s.name)
      op('creative', 'ad', s.existing_id, s.key, {}, changes, beforeOf(live0, ['name', 'status', 'creative', 'tracking_specs']), {
        ad: s, adsetId, placements: set?.placements, tausch, endStatus, altStatus, name,
        ...(s.tracking_specs ? { tracking: s.tracking_specs } : {}),
        ...(s.destination?.kind === 'website' && domainOf(s.destination.url) ? { conversionDomain: domainOf(s.destination.url) } : {}),
      })
      if (tausch === 'ersetzen' && statusCh) statusOps('ad', s.existing_id, s.key, [statusCh], live0)
      continue
    }
    const body: Raw = {}
    const used: EditChange[] = []
    if (nameCh) { body.name = cleanName(str(nameCh.after)); used.push(nameCh) }
    if (trackCh) { body.tracking_specs = s.tracking_specs ?? []; used.push(trackCh) }
    if (Object.keys(body).length) op('patch', 'ad', s.existing_id, s.key, body, used, beforeOf(live0, Object.keys(body)))
    statusOps('ad', s.existing_id, s.key, list, live0)
  }

  // Leitplanke: Posten je Kampagne/Gruppe (Pausieren, Budget, Ende, Einschalten, Budgetplanung)
  const posten: LeitplankenPosten[] = []
  const postenMap = new Map<string, LeitplankenPosten>()
  for (const o of ops) {
    if (o.level === 'ad') continue
    const live0 = liveObjekt(raw, o.level, o.id)
    if (!live0) continue
    const relevant: Raw = {}
    for (const k of ['status', 'daily_budget', 'lifetime_budget', 'stop_time', 'end_time']) if (o.body[k] !== undefined) relevant[k] = o.body[k]
    let extra = 0
    const neueZeitraeume = arr<Raw>(o.body.budget_schedule_specs)
    if (neueZeitraeume.length) {
      // Basis = Tagesbudget nach allen Änderungen dieses Objekts (Budgetplanung ist ein eigener Schritt)
      const basis = centsJeTag(live0, endKeyOf(o.level), { ...(postenMap.get(o.id)?.patch ?? {}), ...relevant })
      extra = zeitraumSpitze(neueZeitraeume.map(z => ({ time_start: num(z.time_start) ?? 0, time_end: num(z.time_end) ?? 0, budget_value: num(z.budget_value) ?? 0, budget_value_type: str(z.budget_value_type) === 'MULTIPLIER' ? 'MULTIPLIER' : 'ABSOLUTE' })), basis)
    }
    if (!Object.keys(relevant).length && !extra) continue
    const prev = postenMap.get(o.id)
    if (prev) { Object.assign(prev.patch, relevant); prev.extraCents = Math.max(prev.extraCents ?? 0, extra) } else {
      const p: LeitplankenPosten = { level: o.level, id: o.id, live: live0, patch: relevant, ...(extra ? { extraCents: extra } : {}) }
      postenMap.set(o.id, p)
      posten.push(p)
    }
  }

  return {
    draft, info, baseline, spec, live, changes: diff.changes, warnings: [...warnings, ...housingHinweise],
    conflicts, erledigt, issues, lint, ops, posten, housingFehlt, housingHinweise,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// edit_diff
// ═══════════════════════════════════════════════════════════════════════════

export async function modeEditDiff(ctx: Ctx, req: EditDiffRequest): Promise<EditDiffResponse> {
  const draft = await loadDraft(ctx, req.draft_id)
  const plan = await planEdit(ctx, draft)
  const warnings = [...plan.warnings]
  let guardrail: GuardrailInfo | null = null
  try {
    guardrail = await leitplankePruefen(ctx, plan.posten)
    if (guardrail && !guardrail.ok) {
      warnings.push(`Budget-Leitplanke: nach der Änderung ${fmtEur(guardrail.afterEur)} € pro Tag aktiv, erlaubt sind ${fmtEur(guardrail.limitEur)} €. „Übernehmen“ wird abgelehnt.`)
    }
  } catch (e) {
    warnings.push(`Budget-Leitplanke gerade nicht prüfbar (${errText(e).slice(0, 120)}). „Übernehmen“ prüft erneut.`)
  }
  if (plan.housingFehlt) warnings.push('Die Kampagne hat die Sonderkategorie Wohnen nicht: neue Werbemittel (neue Anzeige oder Ersetzen) übernimmt der Assistent dort nur mit Admin-Begründung.')
  const tausch: CreativeTausch = plan.spec.hp?.creative_tausch === 'ersetzen' ? 'ersetzen' : 'neue_anzeige'
  return {
    changes: plan.changes, warnings: uniq(warnings), guardrail, creative_tausch: tausch,
    issues: plan.issues, lint: plan.lint, conflicts: plan.conflicts,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// edit_apply
// ═══════════════════════════════════════════════════════════════════════════

async function sperreHolen(ctx: Ctx, draft: DraftRow): Promise<string> {
  const lease = crypto.randomUUID()
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString()
  const { data, error } = await ctx.sb.from('meta_drafts')
    .update({ run_lease: lease, run_lease_at: nowIso(), status: 'creating' })
    .eq('id', draft.id)
    .in('status', ['draft', 'validated', 'failed', 'partial', 'creating'])
    .or(`run_lease.is.null,run_lease_at.lt."${cutoff}"`)
    .select('id')
  if (error) throw new BuilderError(500, 'internal', `Sperre setzen: ${String(error.message ?? error).slice(0, 200)}`)
  if (!arr(data).length) throw leaseBusy()
  return lease
}

async function sperreLoesen(ctx: Ctx, draftId: string, lease: string, patch: Raw = {}): Promise<void> {
  const { error } = await ctx.sb.from('meta_drafts')
    .update({ ...patch, status: 'draft', run_lease: null, run_lease_at: null })
    .eq('id', draftId).eq('run_lease', lease)
  if (error) console.warn('[meta-builder] Sperre lösen:', String(error.message ?? error).slice(0, 200))
}

const ORDER: Readonly<Record<OpArt, number>> = { pause: 0, patch: 1, creative: 2, aktivieren: 3 }
const LEVEL_ORDER_PATCH: Readonly<Record<Level, number>> = { campaign: 0, adset: 1, ad: 2 }
const LEVEL_ORDER_AKTIV: Readonly<Record<Level, number>> = { ad: 0, adset: 1, campaign: 2 }

export async function modeEditApply(ctx: Ctx, req: EditApplyRequest): Promise<EditApplyResponse> {
  if (req.confirm !== true) throw new BuilderError(400, 'invalid_request', 'Übernehmen braucht eine ausdrückliche Bestätigung (confirm: true).')
  if (ctx.caller.system || !ctx.caller.userId) throw new BuilderError(403, 'forbidden', 'Änderungen an Meta gehen nur per Klick einer Person, nicht als System-Aufruf.')
  const draft = await loadDraft(ctx, req.draft_id)
  if (draft.kind !== 'edit') throw new BuilderError(400, 'unsupported', 'Das ist kein Bearbeiten-Entwurf.')
  if (draft.status === 'creating' && leaseActive(draft)) throw leaseBusy()
  const lease = await sperreHolen(ctx, draft)
  const start = Date.now()
  let lastError: Raw | null = null
  try {
    const plan = await planEdit(ctx, draft)
    const isAdmin = ctx.caller.role === 'admin'
    const logExtra: Raw = {}

    const fehler = plan.issues.filter(i => i.severity === 'error')
    if (fehler.length) {
      throw new BuilderError(422, 'validation_failed', `Die Änderungen haben noch ${fehler.length} Fehler.`, 'Im Assistenten die rot markierten Felder korrigieren.', fehler)
    }
    const blocker = plan.lint.filter(i => i.severity === 'blocker')
    if (blocker.length) {
      const reason = str(req.force_lint_reason).trim()
      if (!isAdmin || reason.length < 10) {
        throw new BuilderError(422, 'lint_blocked', `${blocker.length} harte Text-Regel${blocker.length === 1 ? '' : 'n'} im neuen Werbemittel verletzt.`,
          isAdmin ? 'Korrigieren oder mit Begründung (mindestens 10 Zeichen) bewusst übergehen.' : 'Korrigieren. Übergehen kann nur ein Admin mit Begründung.', blocker)
      }
      logExtra.lint_override = { reason: reason.slice(0, 500), by: ctx.caller.userId, at: nowIso(), blockers: blocker.map(b => `${b.rule}:${b.node ?? ''}:${b.field}`) }
    }
    if (plan.housingFehlt) {
      const reason = str(req.housing_override_reason).trim()
      if (!isAdmin || reason.length < 10) {
        throw new BuilderError(409, 'housing_required', 'Die Kampagne hat die Sonderkategorie Wohnen (HOUSING) nicht. Neue Immobilien-Werbemittel (neue Anzeige oder Ersetzen) übernimmt der Assistent nur in Wohnen-Kampagnen.',
          isAdmin ? 'Werbemittel unverändert lassen oder als Admin mit Begründung (mindestens 10 Zeichen) bewusst übergehen.' : 'Werbemittel unverändert lassen. Übergehen kann nur ein Admin mit Begründung.')
      }
      logExtra.housing_override = { reason: reason.slice(0, 500), by: ctx.caller.userId, at: nowIso() }
    }

    const guardrail = await leitplankePruefen(ctx, plan.posten)
    if (guardrail && !guardrail.ok) throw leitplankenFehler(guardrail)

    // Budget-Limit je Objekt (4x pro Stunde)
    const budgetIds = plan.ops.filter(o => o.body.daily_budget !== undefined || o.body.lifetime_budget !== undefined).map(o => o.id)
    const zeiten = await budgetAenderungen(ctx, budgetIds)

    const applied: EditChange[] = [...plan.erledigt]
    const failed: EditApplyResponse['failed'] = plan.changes.filter(c => !!c.blocked).map(c => ({ ...c, error: c.blocked ?? '' }))
    const neueAnzeigen: EditApplyResponse['readback']['neue_anzeigen'] = []
    /** nicht übernommen, aber erneut sendbar: bleibt im Entwurf (nicht gesperrte, ohne halb angelegte neue Anzeige) */
    const nochmal: EditChange[] = []
    const extra = Object.keys(logExtra).length ? logExtra : undefined
    const post = (path: string, body: Raw, level: string, entityId: string | null, before?: Raw, idempotent = true) =>
      metaPost<Raw>(ctx, path, body, { level, entityId, draftId: draft.id, idempotent, logExtra: extra, ...(before ? { before } : {}) })

    const rang = (o: EditOp): number => (o.art === 'aktivieren' ? LEVEL_ORDER_AKTIV : LEVEL_ORDER_PATCH)[o.level] + (o.spaeter ? 1.5 : 0)
    const ops = plan.ops.slice().sort((a, b) => (ORDER[a.art] !== ORDER[b.art] ? ORDER[a.art] - ORDER[b.art] : rang(a) - rang(b)))
    let stopp: string | null = null
    let gesendet = 0
    for (const o of ops) {
      if (!stopp && Date.now() - start > RUN_CUTOFF_MS) stopp = ZEIT_TEXT
      if (!stopp) stopp = auslastungZuHoch()
      if (stopp) { failed.push(...o.changes.map(c => ({ ...c, error: stopp ?? '' }))); nochmal.push(...o.changes); continue }
      if (o.spaeter && failed.some(f => f.field === 'adset.adset_schedule')) {
        // Kampagnen-Zeitplan nur zurücksetzen, wenn die Gruppen ihren Zeitplan wirklich los sind
        failed.push(...o.changes.map(c => ({ ...c, error: 'Übersprungen: Der Zeitplan der Anzeigengruppe wurde nicht übernommen.' })))
        continue
      }
      if (o.body.daily_budget !== undefined || o.body.lifetime_budget !== undefined) {
        const sperre = budgetSperre(zeiten[o.id])
        if (sperre) { failed.push(...o.changes.map(c => ({ ...c, error: sperre }))); nochmal.push(...o.changes); continue }
      }
      try {
        gesendet++
        if (o.art !== 'creative' || !o.creative) {
          const zeitraeume = arr<Raw>(o.body.budget_schedule_specs)
          if (zeitraeume.length) {
            // Budgetplanung: je Zeitraum POST /{id}/budget_schedules (nicht idempotent, legt je Aufruf einen an)
            for (const z of zeitraeume) await post(`${o.id}/budget_schedules`, z, o.level, o.id, undefined, false)
          } else {
            await post(o.id, o.body, o.level, o.id, o.before)
            if (o.body.daily_budget !== undefined || o.body.lifetime_budget !== undefined) (zeiten[o.id] = zeiten[o.id] ?? []).push(Date.now())
          }
          applied.push(...o.changes)
          continue
        }
        const r = await werbemittelTauschen(ctx, draft, o, post)
        if (r.neuId) neueAnzeigen.push({ alt_id: o.id, neu_id: r.neuId, aktiv: r.aktiv })
        if (r.fehler) {
          failed.push(...o.changes.map(c => ({ ...c, error: r.fehler ?? '' })))
          // Neue Anzeige schon angelegt: nicht noch einmal anlegen (Meldung sagt „Status beider Anzeigen prüfen“)
          if (!r.neuId) nochmal.push(...o.changes)
        } else applied.push(...o.changes)
      } catch (err) {
        if (err instanceof BuilderError && err.code === 'writes_disabled') throw err
        if (err instanceof MetaApiError && err.userMsg === 'META_WRITES_DISABLED') throw err
        const msg = fehlerText(err)
        failed.push(...o.changes.map(c => ({ ...c, error: msg })))
        nochmal.push(...o.changes)
        if (err instanceof MetaApiError && err.kind === 'rate_limit') stopp = 'Meta drosselt gerade (Rate-Limit). Den Rest bitte später übernehmen.'
      }
    }

    // Spiegel + neuer Ausgangsstand (ohne gesendete Änderung: der eben gelesene Live-Stand)
    const warnings: string[] = [...plan.housingHinweise]
    const raw = plan.live.raw
    const tauschWahl: CreativeTausch = plan.spec.hp?.creative_tausch === 'ersetzen' ? 'ersetzen' : 'neue_anzeige'
    let frisch: DraftSpec = { ...plan.live.spec, hp: { ...(plan.live.spec.hp ?? {}), creative_tausch: tauschWahl } }
    // Anzeigen-Entwurf mit neuer Anzeige: ab jetzt die neue Anzeige bearbeiten (die alte ist pausiert)
    let editId = plan.info.id
    let draftName: string | undefined
    if (gesendet > 0) {
      const adsetIds = uniq(raw.adsets.map(a => str(a.id)).filter(Boolean))
      const adIds = uniq([...raw.ads.map(a => str(a.id)), ...neueAnzeigen.map(n => n.neu_id)].filter(Boolean))
      try {
        warnings.push(...await readback(ctx.sb, { campaignId: str(raw.campaign.id) || null, adsetIds, adIds }))
      } catch (e) { warnings.push(`Spiegel nicht aktualisiert: ${errText(e).slice(0, 160)}`) }
      const folge = plan.info.level === 'ad' ? neueAnzeigen.find(n => n.alt_id === plan.info.id) : undefined
      try {
        const neu = await loadEditState(ctx, plan.info.level, folge ? folge.neu_id : plan.info.id)
        frisch = { ...neu.spec, hp: { ...(neu.spec.hp ?? {}), creative_tausch: tauschWahl } }
        if (folge) {
          editId = folge.neu_id
          draftName = cleanName(`Bearbeiten: ${objektName(frisch, 'ad', editId)}`, 200) || undefined
          warnings.push(`Der Entwurf zeigt jetzt die neue Anzeige ${editId}; die alte (${plan.info.id}) bleibt pausiert.`)
        }
      } catch (e) {
        warnings.push(`Neuer Stand von Meta nicht lesbar (${errText(e).slice(0, 120)}). Vor weiteren Änderungen bitte neu laden.`)
      }
    }
    // Nicht übernommene Änderungen bleiben im Entwurf: Ausgangsstand = frischer Meta-Stand,
    // Entwurf = frisch + diese Änderungen. Erneutes „Übernehmen“ sendet genau den Rest.
    const entwurf: DraftSpec = { ...clone(frisch), hp: { ...(plan.spec.hp ?? {}), creative_tausch: tauschWahl } }
    let offen = 0
    for (const c of uniq(nochmal)) if (wunschUebernehmen(entwurf, plan.spec, c)) offen++
    if (offen) warnings.push(`${offen} nicht übernommene Änderung${offen === 1 ? ' bleibt' : 'en bleiben'} im Entwurf. Noch einmal „Übernehmen“ sendet den Rest.`)
    const info: EditBaseline = { ...plan.info, id: editId, baseline: frisch, loaded_at: nowIso(), graph_version: GRAPH_VERSION, applied_at: nowIso() }
    if (failed.length) {
      lastError = { step: 'edit_apply', code: 'teilweise', user_msg: `${failed.length} Änderung${failed.length === 1 ? '' : 'en'} nicht übernommen`, at: nowIso() }
    }
    await sperreLoesen(ctx, draft.id, lease, {
      spec: entwurf, meta_ids: { ...obj(draft.meta_ids), edit: info }, last_error: lastError, validation: null, lint: null,
      updated_by: ctx.caller.userId, ...(draftName ? { name: draftName } : {}),
    })
    console.log(`[meta-builder] edit_apply ${draft.id}: ${applied.length} übernommen, ${failed.length} nicht, ${neueAnzeigen.length} neue Anzeige(n)`)
    return { applied, failed, readback: { spec: frisch, warnings: uniq(warnings), guardrail, neue_anzeigen: neueAnzeigen } }
  } catch (err) {
    await sperreLoesen(ctx, draft.id, lease)
    throw err
  }
}

/** Neues Creative bauen und an die Anzeige hängen (ersetzen) oder als neue Anzeige schalten. */
async function werbemittelTauschen(
  ctx: Ctx, draft: DraftRow, o: EditOp,
  post: (path: string, body: Raw, level: string, entityId: string | null, before?: Raw, idempotent?: boolean) => Promise<Raw>,
): Promise<{ neuId?: string; aktiv: boolean; fehler?: string }> {
  const c = o.creative as CreativeOp
  const acct = ctx.env.account
  // Medien: neue Uploads (meta_media) müssen bei Meta fertig sein; geladene Medien tragen Hash/Video-ID
  const ids = adMediaRefs(c.ad).map(r => r.media_id).filter(isUuid)
  const rows = await loadMediaRows(ctx.sb, ids)
  const extra: Record<string, MediaIds> = {}
  for (const mid of ids) {
    const row = rows[mid]
    const fertig = row && ((row.kind === 'image' && !!row.meta_image_hash) || (row.kind === 'video' && !!row.meta_video_id && row.meta_status === 'ready' && !!row.thumbnail_hash))
    if (fertig) continue
    const r = await ensureMediaReady(ctx, mid, draft.id)
    rows[mid] = r.row
    if (!r.ready) {
      return { aktiv: false, fehler: r.reason === 'error' ? 'Meta konnte ein Video nicht verarbeiten. Bitte neu exportieren (H.264, MP4) und hochladen.' : 'Ein Video wird bei Meta noch verarbeitet. In ein bis zwei Minuten erneut „Übernehmen“.' }
    }
  }
  let build
  try { build = buildCreativePayload(fillAdMedia(c.ad, rows, extra), { placements: c.placements }) } catch {
    return { aktiv: false, fehler: 'Ein Bild oder Video ist noch nicht bei Meta. Bitte das Medium neu hochladen.' }
  }
  const creativeId = str((await post(`act_${acct}/adcreatives`, build.payload, 'creative', null, undefined, false)).id)
  if (!creativeId) return { aktiv: false, fehler: 'Meta hat keine Creative-ID zurückgegeben.' }

  if (c.tausch === 'ersetzen') {
    const body: Raw = { creative: { creative_id: creativeId } }
    if (cleanName(c.ad.name) && o.changes.some(x => x.field === 'ad.name')) body.name = cleanName(c.ad.name)
    if (o.changes.some(x => x.field === 'ad.tracking_specs')) body.tracking_specs = c.tracking ?? []
    if (c.conversionDomain) body.conversion_domain = c.conversionDomain
    await post(o.id, body, 'ad', o.id, o.before)
    return { aktiv: c.altStatus === 'ACTIVE' }
  }

  // Neue Anzeige (PAUSED angelegt), dann einschalten, dann die alte pausieren
  const payload = buildAdPayload({ ...c.ad, name: c.name }, c.adsetId, { creative_id: creativeId }, { draftId: draft.id })
  if (c.tracking && c.tracking.length) payload.tracking_specs = c.tracking
  const neuId = str((await post(`act_${acct}/ads`, payload, 'ad', null, undefined, false)).id)
  if (!neuId) return { aktiv: false, fehler: 'Meta hat keine Anzeigen-ID zurückgegeben.' }
  let aktiv = false
  try {
    if (c.endStatus === 'ACTIVE') {
      await post(neuId, { status: 'ACTIVE' }, 'ad', neuId, { status: 'PAUSED' })
      aktiv = true
    }
    if (c.altStatus !== 'PAUSED') await post(o.id, { status: 'PAUSED' }, 'ad', o.id, { status: c.altStatus })
  } catch (err) {
    return {
      neuId, aktiv,
      fehler: `Neue Anzeige ${neuId} ist angelegt${aktiv ? ' und eingeschaltet' : ' (pausiert)'}, aber: ${fehlerText(err)} Bitte Status beider Anzeigen prüfen.`,
    }
  }
  return { neuId, aktiv }
}
