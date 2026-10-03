// meta-berichte, Modus status: Auslieferung, Lernphase, Prüfhinweise je Objekt.
//
// Ebene je ID zuerst aus dem CRM-Spiegel (spart Abrufe), sonst alle drei Ebenen.
// Je Ebene EIN Abruf act_<konto>/{campaigns|adsets|ads} mit filtering id IN [...].
// Lehnt Meta das ab: Grundfelder mit Filter, dann Grundfelder ohne Filter (lokal
// gefiltert, höchstens 3 Seiten). Die Ablehnung wird 6 h gemerkt (Modul + Zwischen-
// speicher), damit nicht jeder Aufruf erst wieder scheitert (Konto auf „Limited access“).
// Gedrosselt oder Meta-Fehler: letzter Zwischenstand oder Spiegel.

import { getLastUsage, MetaApiError } from '../_shared/metaGraph.ts'
import {
  BerichtError, errText, FN, graphSeiten, obj, pruefeIds, STOP_PCT, str, uniq, type Ctx, type Raw,
} from './common.ts'
import {
  auslastungMerken, cacheLesen, cacheSchluessel, cacheSchreiben, drosselText, drosselungLesen, drosselungMerken, TTL_KURZ_S,
} from './cache.ts'
import { auslieferung, isoZeit, issues, lernphase, reviewFeedback } from './normalize.ts'
import { spiegelLernphasen, spiegelLesen, type SpiegelObjekt } from './spiegel.ts'
import type { LernphaseInfo, StatusItem, StatusResponse } from './types.ts'

type Ebene = 'campaign' | 'adset' | 'ad'
const EBENEN: Ebene[] = ['campaign', 'adset', 'ad']
const EDGE: Record<Ebene, string> = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' }
const FELDER: Record<Ebene, string> = {
  campaign: 'id,name,effective_status,configured_status,issues_info,start_time,stop_time',
  adset: 'id,name,campaign_id,effective_status,configured_status,issues_info,learning_stage_info,review_feedback,start_time,end_time',
  ad: 'id,name,adset_id,campaign_id,effective_status,configured_status,issues_info,ad_review_feedback,adset{learning_stage_info}',
}
const FELDER_ALT: Record<Ebene, string> = {
  campaign: 'id,name,effective_status,configured_status',
  adset: 'id,name,effective_status,configured_status,learning_stage_info',
  ad: 'id,name,adset_id,effective_status,configured_status',
}

/** Ohne Filter höchstens so viele Seiten à 200 (fehlende IDs kommen aus dem Spiegel) */
const MAX_SEITEN_OHNE_FILTER = 3

// ── gemerkte Ablehnung je Ebene ──
type Rueckfall = 'grundfelder' | 'ohne_filter'
type RueckfallStand = Partial<Record<Ebene, Rueckfall>>
const RUECKFALL_S = 6 * 3600
const rueckfallKey = (account: string) => `status-rueckfall:act_${account}`
let rueckfallLokal: { account: string; stand: RueckfallStand; bis: number } | null = null

async function rueckfallLesen(ctx: Ctx): Promise<RueckfallStand> {
  if (rueckfallLokal && rueckfallLokal.account === ctx.account && Date.now() < rueckfallLokal.bis) return { ...rueckfallLokal.stand }
  const t = await cacheLesen<unknown>(ctx.sb, rueckfallKey(ctx.account))
  const roh = t && t.frisch ? obj(t.payload) : null
  const stand: RueckfallStand = {}
  for (const e of EBENEN) {
    const v = roh?.[e]
    if (v === 'grundfelder' || v === 'ohne_filter') stand[e] = v
  }
  return stand
}

async function rueckfallMerken(ctx: Ctx, stand: RueckfallStand): Promise<void> {
  rueckfallLokal = { account: ctx.account, stand: { ...stand }, bis: Date.now() + RUECKFALL_S * 1000 }
  await cacheSchreiben(ctx.sb, rueckfallKey(ctx.account), stand, RUECKFALL_S)
}

const abgelehnt = (err: unknown): boolean => err instanceof MetaApiError && err.kind === 'validation'

async function ebeneLesen(ctx: Ctx, ebene: Ebene, ids: string[], stand: RueckfallStand): Promise<Raw[]> {
  const pfad = `act_${ctx.account}/${EDGE[ebene]}`
  const set = new Set(ids)
  const nurIds = (rows: Raw[]) => rows.filter(r => set.has(String(r.id ?? '')))
  const filter = { filtering: [{ field: 'id', operator: 'IN', value: ids }], limit: 200 }
  if (!stand[ebene]) {
    try {
      return nurIds((await graphSeiten<Raw>(pfad, { fields: FELDER[ebene], ...filter }, 3)).rows)
    } catch (err) {
      if (!abgelehnt(err)) throw err
      console.warn(`[${FN}] status ${ebene}: Abfrage abgelehnt, Rückfall Grundfelder:`, errText(err).slice(0, 200))
      stand[ebene] = 'grundfelder'
      await rueckfallMerken(ctx, stand)
    }
  }
  if (stand[ebene] === 'grundfelder') {
    try {
      return nurIds((await graphSeiten<Raw>(pfad, { fields: FELDER_ALT[ebene], ...filter }, 3)).rows)
    } catch (err) {
      if (!abgelehnt(err)) throw err
      console.warn(`[${FN}] status ${ebene}: Filter abgelehnt, Rückfall ohne Filter:`, errText(err).slice(0, 200))
      stand[ebene] = 'ohne_filter'
      await rueckfallMerken(ctx, stand)
    }
  }
  const s = await graphSeiten<Raw>(pfad, { fields: FELDER_ALT[ebene], limit: 200 }, MAX_SEITEN_OHNE_FILTER)
  if (s.grund) ctx.hinweise.push(`Status ${ebene}: ${s.grund}`)
  return nurIds(s.rows)
}

function ausMeta(ebene: Ebene, r: Raw, gruppenLern: Map<string, LernphaseInfo>): StatusItem {
  const eff = str(r.effective_status)
  let lern: LernphaseInfo | null = null
  if (ebene === 'adset') lern = lernphase(r.learning_stage_info)
  if (ebene === 'ad') lern = lernphase(obj(r.adset)?.learning_stage_info) ?? gruppenLern.get(String(r.adset_id ?? '')) ?? null
  const start = isoZeit(r.start_time)
  const ende = ebene === 'campaign' ? isoZeit(r.stop_time) : isoZeit(r.end_time)
  return {
    id: String(r.id),
    level: ebene,
    name: str(r.name),
    effective_status: eff,
    configured_status: str(r.configured_status),
    auslieferung: auslieferung(eff, lern?.status ?? null, start, ende),
    learning: lern,
    issues: issues(r.issues_info),
    review_feedback: reviewFeedback(ebene === 'ad' ? r.ad_review_feedback : r.review_feedback),
    quelle: 'meta',
  }
}

function ausSpiegel(s: SpiegelObjekt, gruppenLern: Map<string, LernphaseInfo>): StatusItem {
  const lern = s.level === 'ad' ? (s.adset_id ? gruppenLern.get(s.adset_id) ?? null : null) : s.learning
  return {
    id: s.id,
    level: s.level,
    name: s.name,
    effective_status: s.effective_status,
    configured_status: s.configured_status,
    auslieferung: auslieferung(s.effective_status, lern?.status ?? null, s.start, s.ende),
    learning: lern,
    issues: issues(s.issues),
    review_feedback: reviewFeedback(s.review_feedback),
    quelle: 'spiegel',
  }
}

function fehlt(id: string): StatusItem {
  return {
    id, level: null, name: null, effective_status: null, configured_status: null,
    auslieferung: { key: 'unbekannt', label: 'Nicht gefunden', symbol: 'warnung' },
    learning: null, issues: [], review_feedback: [], quelle: 'fehlt',
  }
}

interface StatusPayload { items: StatusItem[]; fetched_at: string }

export async function modeStatus(ctx: Ctx, body: Raw): Promise<StatusResponse> {
  const ids = pruefeIds(body.ids, 'ids', 100, true)
  const lv = body.level
  if (lv !== undefined && lv !== null && lv !== '' && EBENEN.indexOf(lv as Ebene) < 0) {
    throw new BerichtError(400, 'invalid_request', 'level muss campaign, adset oder ad sein.')
  }
  const level = (lv || null) as Ebene | null
  const key = await cacheSchluessel({ mode: 'status', account: ctx.account, ids: [...ids].sort(), level })
  const treffer = await cacheLesen<StatusPayload>(ctx.sb, key)
  const gueltig = treffer && Array.isArray(treffer.payload?.items) ? treffer : null
  if (gueltig && gueltig.frisch && body.frisch !== true) {
    return { items: gueltig.payload.items, cached: true, fetched_at: gueltig.payload.fetched_at, veraltet: false, hinweise: [] }
  }

  // Spiegel: Ebenen-Erkennung und Rückfall
  const spiegel = await spiegelLesen(ctx.sb, ids)
  const adsetIdsAusSpiegel = uniq([...spiegel.values()].filter(s => s.level === 'ad' && s.adset_id).map(s => String(s.adset_id)))

  const rueckfall = async (grund: string): Promise<StatusResponse> => {
    if (gueltig) {
      ctx.hinweise.push(`${grund} Angezeigt wird der Stand von ${gueltig.payload.fetched_at.slice(0, 16).replace('T', ' ')} (UTC).`)
      return { items: gueltig.payload.items, cached: true, fetched_at: gueltig.payload.fetched_at, veraltet: true, hinweise: uniq(ctx.hinweise) }
    }
    ctx.hinweise.push(`${grund} Angezeigt wird der letzte Stand aus dem nächtlichen Sync.`)
    const lern = await spiegelLernphasen(ctx.sb, adsetIdsAusSpiegel)
    const items = ids.map(id => (spiegel.has(id) ? ausSpiegel(spiegel.get(id)!, lern) : fehlt(id)))
    return { items, cached: false, fetched_at: new Date().toISOString(), veraltet: true, hinweise: uniq(ctx.hinweise) }
  }

  const drossel = await drosselungLesen(ctx.sb, ctx.account)
  if (drossel) return await rueckfall(drosselText(drossel))

  const jeEbene: Record<Ebene, string[]> = { campaign: [], adset: [], ad: [] }
  for (const id of ids) {
    const bekannt = level ?? spiegel.get(id)?.level ?? null
    if (bekannt) jeEbene[bekannt].push(id)
    else for (const e of EBENEN) jeEbene[e].push(id)
  }

  const gefunden = new Map<string, { ebene: Ebene; raw: Raw }>()
  let abgebrochen = false
  let abrufe = 0
  const stand = await rueckfallLesen(ctx)
  try {
    for (const e of EBENEN) {
      const offen = jeEbene[e].filter(id => !gefunden.has(id))
      if (!offen.length) continue
      // Auslastung erst nach dem ersten eigenen Abruf prüfen (getLastUsage gilt je Isolate)
      const u = abrufe > 0 ? getLastUsage() : null
      if (u && u.accUtilPct > STOP_PCT) {
        abgebrochen = true
        ctx.hinweise.push(`Meta-Auslastung ${Math.round(u.accUtilPct)} %: Teile aus dem nächtlichen Sync.`)
        break
      }
      abrufe++
      for (const r of await ebeneLesen(ctx, e, offen, stand)) gefunden.set(String(r.id), { ebene: e, raw: r })
    }
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.kind === 'rate_limit') await drosselungMerken(ctx.sb, ctx.account, err)
      return await rueckfall(`Live-Status von Meta nicht abrufbar (${(err.userMsg || err.message).slice(0, 160)}).`)
    }
    throw err
  }

  // Lernphase für Anzeigen ohne adset{learning_stage_info}: aus dem Spiegel der Gruppe
  const ohneLern = uniq([...gefunden.values()]
    .filter(g => g.ebene === 'ad' && !lernphase(obj(g.raw.adset)?.learning_stage_info) && g.raw.adset_id)
    .map(g => String(g.raw.adset_id)))
  const lern = await spiegelLernphasen(ctx.sb, uniq([...ohneLern, ...adsetIdsAusSpiegel]))

  const items = ids.map(id => {
    const g = gefunden.get(id)
    if (g) return ausMeta(g.ebene, g.raw, lern)
    const s = spiegel.get(id)
    return s ? ausSpiegel(s, lern) : fehlt(id)
  })
  const fetched_at = new Date().toISOString()
  if (!abgebrochen) await cacheSchreiben(ctx.sb, key, { items, fetched_at } satisfies StatusPayload, TTL_KURZ_S)
  if (abrufe > 0) await auslastungMerken(ctx.sb, ctx.account)
  const nichtLive = items.filter(i => i.quelle !== 'meta').length
  if (nichtLive && !abgebrochen) ctx.hinweise.push(`${nichtLive} von ${items.length} Objekten nicht live bei Meta gefunden.`)
  return { items, cached: false, fetched_at, veraltet: false, hinweise: uniq(ctx.hinweise) }
}
