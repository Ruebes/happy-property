// meta-berichte, Modus activities: Aktivitätenverlauf wie im Werbeanzeigenmanager.
//
// Zwei Quellen, zusammengeführt und nach Zeit sortiert (neueste zuerst):
//   1. Meta: GET act_<konto>/activities (Konto, Kampagnen, Gruppen, Anzeigen,
//      Zielgruppen; wer, wann, was, alter/neuer Wert in extra). Zwischenspeicher.
//   2. CRM: meta_write_log (jeder echte Schreibzugriff aus dem CRM, ohne
//      validate_only), immer frisch.
// Ein Meta-Eintrag zum selben Objekt innerhalb von 3 Minuten nach einem
// CRM-Schreibzugriff gilt als dieselbe Änderung (quelle meta+crm, Person aus dem CRM).
// Meta nicht erreichbar oder gedrosselt: nur CRM-Einträge plus Hinweis.

import { MetaApiError, type GraphParams } from '../_shared/metaGraph.ts'
import {
  errText, FN, graphSeiten, obj, pruefeId, pruefeZeitraum, str, tabelleFehlt, uniq, enthaeltHeute,
  type Ctx, type Raw, type Seiten,
} from './common.ts'
import {
  auslastungMerken, cacheLesen, cacheSchluessel, cacheSchreiben, drosselText, drosselungLesen, drosselungMerken,
  TTL_HEUTE_S, TTL_VERGANGEN_S,
} from './cache.ts'
import {
  altNamenErkennen, CRM_MODUS_LABELS, crmKategorie, ereignisKategorie, ereignisLabel, geaendertVonMeta, isoZeit, menschlich,
  OBJEKT_LABELS, objektArt,
} from './normalize.ts'
import { spiegelKinder, spiegelLesen } from './spiegel.ts'
import type { ActivitiesResponse, AktivitaetEintrag, AktivitaetObjekt, Zeitraum } from './types.ts'

const AKT_FELDER =
  'actor_id,actor_name,application_id,application_name,date_time_in_timezone,event_time,event_type,extra_data,object_id,object_name,object_type,translated_event_type'
const MAX_SEITEN = 10
const MAX_TAGE = 400
const CRM_LIMIT = 300
/** Meta- und CRM-Eintrag zum selben Objekt innerhalb dieser Sekunden = dieselbe Änderung */
const GLEICH_S = 180
const MAX_EINTRAEGE = 1000

interface MetaTeil { rows: Raw[]; fetched_at: string; unvollstaendig: boolean }

/** Berliner Tagesgrenzen großzügig als Unix-Sekunden (Meta erwartet since/until als Zeitpunkt). */
function grenzen(z: Zeitraum): { von: number; bis: number; vonIso: string; bisIso: string } {
  const von = Math.floor(Date.parse(`${z.since}T00:00:00Z`) / 1000) - 2 * 3600
  const bis = Math.floor(Date.parse(`${z.until}T23:59:59Z`) / 1000)
  return { von, bis, vonIso: new Date(von * 1000).toISOString(), bisIso: new Date(bis * 1000).toISOString() }
}

async function metaLesen(ctx: Ctx, z: Zeitraum, objectId: string | null): Promise<Seiten<Raw>> {
  const g = grenzen(z)
  const pfad = `act_${ctx.account}/activities`
  const basis: GraphParams = { fields: AKT_FELDER, since: g.von, until: g.bis, limit: 100 }
  if (!objectId) return await graphSeiten<Raw>(pfad, basis, MAX_SEITEN)
  try {
    return await graphSeiten<Raw>(pfad, { ...basis, oid: objectId, add_children: true }, MAX_SEITEN)
  } catch (err) {
    if (!(err instanceof MetaApiError) || err.kind !== 'validation') throw err
    console.warn(`[${FN}] activities: oid/add_children abgelehnt, lokal gefiltert:`, err.message.slice(0, 200))
    // Ohne add_children fehlten sonst alle Änderungen an Anzeigengruppen und Anzeigen darunter
    const ids = new Set([objectId, ...await spiegelKinder(ctx.sb, objectId)])
    const s = await graphSeiten<Raw>(pfad, basis, MAX_SEITEN)
    ctx.hinweise.push('Meta-Aktivitäten: Untergeordnete Objekte stammen aus dem nächtlichen Sync, ganz neue können fehlen.')
    return { ...s, rows: s.rows.filter(r => ids.has(str(r.object_id) ?? '')) }
  }
}

async function metaTeil(ctx: Ctx, z: Zeitraum, objectId: string | null, frisch: boolean): Promise<{ teil: MetaTeil | null; cached: boolean; veraltet: boolean }> {
  const key = await cacheSchluessel({ mode: 'activities', account: ctx.account, since: z.since, until: z.until, object_id: objectId })
  const treffer = await cacheLesen<MetaTeil>(ctx.sb, key)
  const gueltig = treffer && Array.isArray(treffer.payload?.rows) ? treffer : null
  if (gueltig && gueltig.frisch && !frisch) return { teil: gueltig.payload, cached: true, veraltet: false }
  const alt = (grund: string) => {
    if (gueltig) {
      ctx.hinweise.push(`Meta-Aktivitäten: ${grund} Stand ${gueltig.payload.fetched_at.slice(0, 16).replace('T', ' ')} (UTC).`)
      return { teil: gueltig.payload, cached: true, veraltet: true }
    }
    ctx.hinweise.push(`Meta-Aktivitäten: ${grund} Gezeigt werden nur die Änderungen aus dem CRM.`)
    return { teil: null, cached: false, veraltet: true }
  }
  const drossel = await drosselungLesen(ctx.sb, ctx.account)
  if (drossel) return alt(drosselText(drossel))
  try {
    const s = await metaLesen(ctx, z, objectId)
    if (s.grund) ctx.hinweise.push(`Meta-Aktivitäten: ${s.grund}`)
    const teil: MetaTeil = { rows: s.rows, fetched_at: new Date().toISOString(), unvollstaendig: s.unvollstaendig }
    await cacheSchreiben(ctx.sb, key, teil, enthaeltHeute(z) ? TTL_HEUTE_S : TTL_VERGANGEN_S)
    await auslastungMerken(ctx.sb, ctx.account)
    return { teil, cached: false, veraltet: false }
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err
    if (err.kind === 'rate_limit') await drosselungMerken(ctx.sb, ctx.account, err)
    return alt(`nicht abrufbar (${(err.userMsg || err.message).slice(0, 160)}).`)
  }
}

interface CrmZeile {
  id: unknown; ts: string; actor: string | null; actor_kind: string | null; fn: string | null; mode: string | null
  entity_level: string | null; entity_id: string | null; method: string | null; path: string | null
  before: unknown; after: unknown; ok: boolean | null; meta_error: unknown
}

async function crmLesen(ctx: Ctx, z: Zeitraum, objectId: string | null): Promise<CrmZeile[]> {
  const g = grenzen(z)
  try {
    let q = ctx.sb.from('meta_write_log')
      .select('id, ts, actor, actor_kind, fn, mode, entity_level, entity_id, method, path, before, after, ok, meta_error')
      .eq('validate_only', false).gte('ts', g.vonIso).lte('ts', g.bisIso)
    if (objectId) q = q.eq('entity_id', objectId)
    const { data, error } = await q.order('ts', { ascending: false }).limit(CRM_LIMIT)
    if (error) {
      if (tabelleFehlt(error)) ctx.hinweise.push('Eigenes Schreibprotokoll (meta_write_log) ist noch nicht eingerichtet.')
      else console.warn(`[${FN}] meta_write_log:`, String((error as { message?: string }).message ?? error).slice(0, 200))
      return []
    }
    const rows = (Array.isArray(data) ? data : []) as CrmZeile[]
    if (rows.length >= CRM_LIMIT) ctx.hinweise.push(`Nur die letzten ${CRM_LIMIT} CRM-Änderungen im Zeitraum.`)
    return rows
  } catch (err) {
    console.warn(`[${FN}] meta_write_log:`, errText(err).slice(0, 200))
    return []
  }
}

async function namenLesen(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  const uuids = ids.filter(id => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100)
  if (!uuids.length) return m
  try {
    const { data, error } = await ctx.sb.from('profiles').select('id, full_name').in('id', uuids).limit(100)
    if (error) return m
    for (const p of (Array.isArray(data) ? data : []) as Array<{ id?: string; full_name?: string | null }>) {
      if (p.id && p.full_name) m.set(p.id, p.full_name)
    }
  } catch {
    // Namen sind nur Komfort
  }
  return m
}

/** extra_data von Meta (JSON-String) -> Objekt, gekürzt */
function extraAusMeta(v: unknown): Record<string, unknown> | null {
  let o: unknown = v
  if (typeof v === 'string') {
    try { o = JSON.parse(v) } catch { o = { text: v } }
  }
  const r = obj(o)
  if (!r) return null
  const s = JSON.stringify(r)
  return s.length > 4000 ? { text: `${s.slice(0, 4000)}…` } : r
}

function kurz(v: unknown): unknown {
  if (v === null || v === undefined) return null
  const s = JSON.stringify(v)
  if (s.length <= 2000) return v
  const o = obj(v)
  return o ? { gekuerzt: true, felder: Object.keys(o).slice(0, 30) } : `${s.slice(0, 2000)}…`
}

function crmObjekt(level: string | null): AktivitaetObjekt {
  switch ((level ?? '').toLowerCase()) {
    case 'campaign': return 'campaign'
    case 'adset': return 'adset'
    case 'ad': case 'creative': return 'ad'
    case 'account': return 'account'
    case 'audience': case 'audience_users': return 'audience'
    default: return 'sonstiges'
  }
}

export async function modeActivities(ctx: Ctx, body: Raw): Promise<ActivitiesResponse> {
  const z = pruefeZeitraum(body.since, body.until, 'Zeitraum', MAX_TAGE, ctx.hinweise)
  const objectId = pruefeId(body.object_id, 'object_id')

  const meta = await metaTeil(ctx, z, objectId, body.frisch === true)
  const crm = await crmLesen(ctx, z, objectId)

  const metaRows = meta.teil?.rows ?? []
  const objektIds = uniq([
    ...metaRows.map(r => str(r.object_id)).filter((x): x is string => !!x && /^[0-9]{6,25}$/.test(x)),
    ...crm.map(r => str(r.entity_id)).filter((x): x is string => !!x && /^[0-9]{6,25}$/.test(x)),
  ]).slice(0, 600)
  const spiegel = await spiegelLesen(ctx.sb, objektIds)
  const namen = await namenLesen(ctx, uniq(crm.map(r => str(r.actor)).filter((x): x is string => !!x)))

  const crmName = (c: CrmZeile): string =>
    (c.actor ? namen.get(c.actor) : undefined) ?? (c.actor_kind === 'autopilot' ? 'Autopilot' : c.actor_kind === 'system' ? 'System' : 'Unbekannt')

  // Benennung der object_type-Werte einmal je Antwort (CAMPAIGN ist sonst mehrdeutig)
  const altNamen = altNamenErkennen(metaRows.map(r => str(r.object_type)))
  const crmZeit = crm.map(c => Date.parse(c.ts))
  const benutzt = new Set<number>()
  const items: AktivitaetEintrag[] = []

  for (const r of metaRows) {
    const eventType = str(r.event_type) ?? 'unknown'
    const objId = str(r.object_id)
    const sp = objId ? spiegel.get(objId) : undefined
    const art: AktivitaetObjekt = sp?.level ?? objektArt(str(r.object_type), eventType, altNamen)
    const ts = isoZeit(r.event_time) ?? isoZeit(r.date_time_in_timezone)
    if (!ts) continue
    const von = geaendertVonMeta(str(r.actor_id), str(r.actor_name), str(r.application_id), str(r.application_name))
    const extra: Record<string, unknown> = { ...(extraAusMeta(r.extra_data) ?? {}) }
    if (str(r.application_name)) extra.application_name = str(r.application_name)
    const item: AktivitaetEintrag = {
      ts,
      actor: str(r.actor_name) ?? (von === 'Meta' ? 'Meta' : 'Unbekannt'),
      object_type: art,
      object_type_label: OBJEKT_LABELS[art],
      object_id: objId,
      object_name: str(r.object_name) ?? sp?.name ?? null,
      event: ereignisLabel(eventType, str(r.translated_event_type)),
      event_type: eventType,
      kategorie: ereignisKategorie(eventType, art),
      geaendert_von: von,
      quelle: 'meta',
      extra: Object.keys(extra).length ? extra : null,
    }
    // Dieselbe Änderung aus dem CRM? (gleiches Objekt, höchstens 3 Minuten Abstand)
    if (objId && von !== 'Person' && von !== 'Automatisierte Regel') {
      const t = Date.parse(ts)
      let best = -1
      let bestAbstand = Infinity
      crm.forEach((c, i) => {
        if (benutzt.has(i) || c.ok === false || str(c.entity_id) !== objId) return
        const abstand = Math.abs(crmZeit[i] - t)
        if (Number.isFinite(abstand) && abstand <= GLEICH_S * 1000 && abstand < bestAbstand) {
          best = i
          bestAbstand = abstand
        }
      })
      if (best >= 0) {
        const c = crm[best]
        benutzt.add(best)
        item.quelle = 'meta+crm'
        item.geaendert_von = c.actor_kind === 'autopilot' ? 'Autopilot' : 'CRM'
        item.actor = `${crmName(c)} (über CRM)`
        item.extra = { ...(item.extra ?? {}), crm: { log_id: c.id, fn: c.fn, mode: c.mode } }
      }
    }
    items.push(item)
  }

  crm.forEach((c, i) => {
    if (benutzt.has(i)) return
    const art = crmObjekt(c.entity_level)
    const objId = str(c.entity_id)
    const mode = c.mode ?? ''
    const fehler = obj(c.meta_error)
    items.push({
      ts: isoZeit(c.ts) ?? c.ts,
      actor: crmName(c),
      object_type: art,
      object_type_label: OBJEKT_LABELS[art],
      object_id: objId,
      object_name: (objId ? spiegel.get(objId)?.name : null) ?? null,
      event: `${CRM_MODUS_LABELS[mode] ?? `CRM: ${menschlich(mode || c.fn || 'Änderung')}`}${c.ok === false ? ' (fehlgeschlagen)' : ''}`,
      event_type: `crm:${c.fn ?? ''}/${mode}`,
      kategorie: crmKategorie(mode, art, c.after ?? c.before),
      geaendert_von: c.actor_kind === 'autopilot' ? 'Autopilot' : 'CRM',
      quelle: 'crm',
      extra: {
        fn: c.fn, mode: c.mode, ok: c.ok, method: c.method, path: c.path,
        before: kurz(c.before), after: kurz(c.after),
        fehler: fehler ? (str(fehler.user_msg) ?? str(fehler.message)) : null,
      },
    })
  })

  items.sort((a, b) => b.ts.localeCompare(a.ts))
  if (items.length > MAX_EINTRAEGE) ctx.hinweise.push(`Nur die neuesten ${MAX_EINTRAEGE} Einträge.`)
  return {
    items: items.slice(0, MAX_EINTRAEGE),
    cached: meta.cached,
    fetched_at: meta.teil?.fetched_at ?? new Date().toISOString(),
    veraltet: meta.veraltet,
    unvollstaendig: meta.teil?.unvollstaendig ?? false,
    hinweise: uniq(ctx.hinweise),
  }
}
