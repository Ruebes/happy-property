// meta-builder: Rücklesen angelegter Objekte von Meta in die Spiegel-Tabellen
// meta_campaigns, meta_adsets, ad_catalog (mit draft_id) und in die Ablage
// studio_prepared_ads („Vorbereitete Anzeigen“, bis jemand sie freigibt).
// Fehler hier sind nie fatal: der nächtliche meta-ads-sync holt alles nach.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { graphAll, graphGet, MetaApiError, metaEnv } from '../_shared/metaGraph.ts'
import { arr, digits, errText, nowIso, num, obj, str, uniq, type Raw } from './common.ts'

export const CAMPAIGN_FIELDS_FULL =
  'id,account_id,name,objective,status,effective_status,configured_status,buying_type,special_ad_categories,' +
  'special_ad_category_country,daily_budget,lifetime_budget,spend_cap,bid_strategy,is_adset_budget_sharing_enabled,' +
  'start_time,stop_time,created_time,updated_time,issues_info,advantage_state_info'
export const CAMPAIGN_FIELDS_MIN =
  'id,account_id,name,objective,status,effective_status,buying_type,special_ad_categories,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time'

export const ADSET_FIELDS_FULL =
  'id,account_id,campaign_id,name,status,effective_status,configured_status,daily_budget,lifetime_budget,bid_strategy,' +
  'bid_amount,optimization_goal,billing_event,destination_type,promoted_object,attribution_spec,targeting,' +
  'dsa_beneficiary,dsa_payor,learning_stage_info,start_time,end_time,issues_info,created_time,updated_time'
export const ADSET_FIELDS_MIN =
  'id,account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,optimization_goal,' +
  'billing_event,destination_type,promoted_object,targeting,start_time,end_time'

export const AD_FIELDS_FULL =
  'id,account_id,campaign_id,adset_id,name,status,effective_status,configured_status,issues_info,ad_review_feedback,' +
  'created_time,updated_time,creative{id,url_tags,thumbnail_url,body},adset{name},campaign{name}'
export const AD_FIELDS_MIN = 'id,account_id,campaign_id,adset_id,name,status,effective_status,creative{id}'

/** GET mit vollem Feldsatz; lehnt Meta ein Feld ab (#100), noch einmal mit dem Mindestsatz. */
export async function getWithFallback<T = Raw>(path: string, full: string, min: string): Promise<T> {
  try {
    return await graphGet<T>(path, { fields: full })
  } catch (err) {
    if (err instanceof MetaApiError && err.kind === 'validation') return await graphGet<T>(path, { fields: min })
    throw err
  }
}

const cents = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && n > 0 ? Math.round(n) : null
}
const iso = (v: unknown): string | null => {
  if (typeof v === 'number' && v > 0) return new Date(v * 1000).toISOString()
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const strArr = (v: unknown): string[] => arr(v).map(x => str(x)).filter(Boolean)
const orNull = (v: unknown): string | null => (str(v) ? str(v) : null)

export function campaignRow(c: Raw, draftId?: string | null): Raw {
  const adv = obj(c.advantage_state_info)
  const row: Raw = {
    campaign_id: str(c.id),
    account_id: digits(c.account_id) || metaEnv().account,
    name: orNull(c.name),
    objective: orNull(c.objective),
    status: orNull(c.status),
    effective_status: orNull(c.effective_status),
    buying_type: orNull(c.buying_type),
    special_ad_categories: strArr(c.special_ad_categories),
    special_ad_category_country: strArr(c.special_ad_category_country),
    daily_budget_cents: cents(c.daily_budget),
    lifetime_budget_cents: cents(c.lifetime_budget),
    spend_cap_cents: cents(c.spend_cap),
    bid_strategy: orNull(c.bid_strategy),
    is_adset_budget_sharing_enabled: typeof c.is_adset_budget_sharing_enabled === 'boolean' ? c.is_adset_budget_sharing_enabled : null,
    start_time: iso(c.start_time),
    stop_time: iso(c.stop_time),
    advantage_state: orNull(adv.advantage_state),
    advantage_state_info: c.advantage_state_info ?? null,
    issues: c.issues_info ?? null,
    created_time: iso(c.created_time),
    updated_time: iso(c.updated_time),
    raw: c,
    synced_at: nowIso(),
  }
  if (draftId) row.draft_id = draftId
  return row
}

export function adsetRow(a: Raw, draftId?: string | null): Raw {
  const lsi = obj(a.learning_stage_info)
  const row: Raw = {
    adset_id: str(a.id),
    campaign_id: orNull(a.campaign_id),
    account_id: digits(a.account_id) || metaEnv().account,
    name: orNull(a.name),
    status: orNull(a.status),
    effective_status: orNull(a.effective_status),
    daily_budget_cents: cents(a.daily_budget),
    lifetime_budget_cents: cents(a.lifetime_budget),
    bid_strategy: orNull(a.bid_strategy),
    bid_amount_cents: cents(a.bid_amount),
    optimization_goal: orNull(a.optimization_goal),
    billing_event: orNull(a.billing_event),
    destination_type: orNull(a.destination_type),
    promoted_object: a.promoted_object ?? null,
    attribution_spec: a.attribution_spec ?? null,
    targeting: a.targeting ?? null,
    dsa_beneficiary: orNull(a.dsa_beneficiary),
    dsa_payor: orNull(a.dsa_payor),
    learning_status: orNull(lsi.status),
    learning_conversions: num(lsi.conversions),
    last_sig_edit_ts: iso(lsi.last_sig_edit_ts),
    learning_stage_info: a.learning_stage_info ?? null,
    start_time: iso(a.start_time),
    end_time: iso(a.end_time),
    issues: a.issues_info ?? null,
    created_time: iso(a.created_time),
    updated_time: iso(a.updated_time),
    raw: a,
    synced_at: nowIso(),
  }
  if (draftId) row.draft_id = draftId
  return row
}

export function adCatalogRow(ad: Raw, draftId?: string | null): Raw {
  const cr = obj(ad.creative)
  const row: Raw = {
    ad_id: str(ad.id),
    platform: 'meta',
    account_id: digits(ad.account_id) || metaEnv().account,
    campaign_id: str(ad.campaign_id),
    adset_id: orNull(ad.adset_id),
    ad_name: orNull(ad.name),
    status: orNull(ad.status),
    effective_status: orNull(ad.effective_status),
    configured_status: orNull(ad.configured_status),
    issues_info: ad.issues_info ?? null,
    review_feedback: ad.ad_review_feedback ?? null,
    creative_id: orNull(cr.id),
    updated_at: nowIso(),
  }
  // Nur setzen, was Meta wirklich geliefert hat (Mindest-Feldsatz überschreibt sonst mit null)
  const campaignName = str(obj(ad.campaign).name)
  const adsetName = str(obj(ad.adset).name)
  if (campaignName) row.campaign_name = campaignName
  if (adsetName) row.adset_name = adsetName
  if (str(cr.url_tags)) row.url_tags = str(cr.url_tags)
  if (str(cr.thumbnail_url)) row.thumbnail_url = str(cr.thumbnail_url)
  if (str(cr.body)) row.creative_body = str(cr.body)
  if (iso(ad.created_time)) row.created_time = iso(ad.created_time)
  if (iso(ad.updated_time)) row.updated_time = iso(ad.updated_time)
  if (draftId) row.draft_id = draftId
  return row
}

export interface ReadbackInput {
  campaignId?: string | null
  /** Kampagne wurde von diesem Entwurf angelegt (dann draft_id setzen) */
  campaignCreated?: boolean
  adsetIds: string[]
  /** Teilmenge von adsetIds, die dieser Entwurf angelegt hat */
  createdAdsetIds?: string[]
  adIds: string[]
  draftId?: string | null
  /** Anzeigen in „Vorbereitete Anzeigen“ ablegen */
  prepare?: boolean
}

/** Liest Kampagne, Anzeigengruppen und Anzeigen und schreibt die Spiegel. Gibt Warnungen zurück. */
export async function readback(sb: SupabaseClient, inp: ReadbackInput): Promise<string[]> {
  const warn: string[] = []
  const w = (what: string, e: unknown) => warn.push(`${what}: ${errText(e).slice(0, 200)}`)

  if (inp.campaignId) {
    try {
      const c = await getWithFallback<Raw>(inp.campaignId, CAMPAIGN_FIELDS_FULL, CAMPAIGN_FIELDS_MIN)
      const { error } = await sb.from('meta_campaigns').upsert(campaignRow(c, inp.campaignCreated ? inp.draftId : null), { onConflict: 'campaign_id' })
      if (error) w('meta_campaigns', error.message ?? error)
    } catch (e) { w('Kampagne lesen', e) }
  }

  const created = new Set(inp.createdAdsetIds ?? [])
  for (const id of uniq(inp.adsetIds)) {
    try {
      const a = await getWithFallback<Raw>(id, ADSET_FIELDS_FULL, ADSET_FIELDS_MIN)
      const { error } = await sb.from('meta_adsets').upsert(adsetRow(a, created.has(id) ? inp.draftId : null), { onConflict: 'adset_id' })
      if (error) w('meta_adsets', error.message ?? error)
    } catch (e) { w(`Anzeigengruppe ${id} lesen`, e) }
  }

  const wanted = new Set(inp.adIds)
  if (wanted.size) {
    const found: Raw[] = []
    // Je Anzeigengruppe eine Liste statt einer Abfrage je Anzeige
    for (const adsetId of uniq(inp.adsetIds)) {
      if (found.length >= wanted.size) break
      try {
        let list: Raw[]
        try {
          list = await graphAll<Raw>(`${adsetId}/ads`, { fields: AD_FIELDS_FULL, limit: 100 }, { maxPages: 3 })
        } catch (err) {
          if (!(err instanceof MetaApiError && err.kind === 'validation')) throw err
          list = await graphAll<Raw>(`${adsetId}/ads`, { fields: AD_FIELDS_MIN, limit: 100 }, { maxPages: 3 })
        }
        for (const ad of list) if (wanted.has(str(ad.id)) && !found.some(f => f.id === ad.id)) found.push(ad)
      } catch (e) { w(`Anzeigen der Gruppe ${adsetId} lesen`, e) }
    }
    for (const id of wanted) {
      if (found.some(f => str(f.id) === id)) continue
      try { found.push(await getWithFallback<Raw>(id, AD_FIELDS_FULL, AD_FIELDS_MIN)) } catch (e) { w(`Anzeige ${id} lesen`, e) }
    }
    if (found.length) {
      const rows = found.map(ad => adCatalogRow(ad, inp.draftId))
      const { error } = await sb.from('ad_catalog').upsert(rows, { onConflict: 'ad_id' })
      if (error) w('ad_catalog', error.message ?? error)
      if (inp.prepare) {
        const prep = found.map(ad => ({ ad_id: str(ad.id), ad_name: str(ad.name).slice(0, 200) || null }))
        const r2 = await sb.from('studio_prepared_ads').upsert(prep, { onConflict: 'ad_id' })
        if (r2.error) w('studio_prepared_ads', r2.error.message ?? r2.error)
      }
    }
  }
  if (warn.length) console.warn('[meta-builder] Rücklesen:', warn.join(' | ').slice(0, 800))
  return warn
}
