// meta-builder: bulk - Massenbearbeitung wie im Werbeanzeigenmanager (mehrere Zeilen
// markieren > Bearbeiten): Status, Tagesbudget, Budget in Prozent, Ende, Namenszusatz
// für bis zu 50 Kampagnen/Anzeigengruppen/Anzeigen.
//   - Leitplanke EINMAL für alle Erhöhungen und Einschaltungen zusammen; darüber wird
//     nichts geschrieben (409 guardrail_exceeded).
//   - Meta erlaubt Budget-Änderungen höchstens 4x pro Stunde je Objekt (meta_write_log).
//   - Reihenfolge: Pausieren und Senken zuerst, Erhöhen danach, Einschalten zuletzt
//     (Anzeige > Gruppe > Kampagne). Nie löschen, nie archivieren.
//   - Jeder POST in meta_write_log mit Vorher-Stand; danach Spiegel aktualisieren.

import { graphGet, MetaApiError } from '../_shared/metaGraph.ts'
import {
  cleanName, LIMITS,
  type BulkRequest, type BulkResponse, type BulkResult, type GuardrailInfo, type Level,
} from '../_shared/metaSpec.ts'
import { DASH_CHARS } from '../_shared/metaLint.ts'
import { arr, BuilderError, digits, errText, metaId, metaPost, num, obj, str, uniq, type Ctx, type Raw } from './common.ts'
import {
  auslastungZuHoch, budgetAenderungen, budgetSperre, fehlerText, leitplankenFehler, leitplankePruefen,
  type LeitplankenPosten,
} from './edit.ts'
import { readback } from './readback.ts'

const RUN_CUTOFF_MS = 45_000
const FIELDS: Readonly<Record<Level, string>> = {
  campaign: 'id,account_id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,stop_time',
  adset: 'id,account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,end_time,campaign{daily_budget,lifetime_budget}',
  ad: 'id,account_id,campaign_id,adset_id,name,status,effective_status',
}
const LEVEL_TEXT: Readonly<Record<Level, string>> = { campaign: 'Kampagne', adset: 'Anzeigengruppe', ad: 'Anzeige' }

interface Posten {
  level: Level
  id: string
  live: Raw | null
  body: Raw
  before: Raw
  after: Raw
  error?: string
  hinweis?: string
  /** Sortierung: 0 pausieren, 1 senken, 2 neutral, 3 erhöhen, 4 einschalten */
  rang: number
}

const centsOf = (v: unknown): number => {
  const n = num(v)
  return n !== null && n > 0 ? Math.round(n) : 0
}

function patchPruefen(p: BulkRequest['patch']): void {
  if (!p || typeof p !== 'object') throw new BuilderError(400, 'invalid_request', 'patch fehlt.')
  const keys = ['status', 'daily_budget_cents', 'budget_prozent', 'end_time', 'name_suffix'].filter(k => (p as Raw)[k] !== undefined && (p as Raw)[k] !== null && (p as Raw)[k] !== '')
  if (!keys.length) throw new BuilderError(400, 'invalid_request', 'Nichts zu ändern: Status, Budget, Ende oder Namenszusatz angeben.')
  if (p.status !== undefined && p.status !== 'ACTIVE' && p.status !== 'PAUSED') {
    throw new BuilderError(400, 'invalid_request', 'Status nur „Aktiv“ oder „Pausiert“. Löschen und Archivieren macht der Assistent nie.')
  }
  if (p.daily_budget_cents !== undefined && p.budget_prozent !== undefined) {
    throw new BuilderError(400, 'invalid_request', 'Entweder ein neues Tagesbudget oder eine Änderung in Prozent, nicht beides.')
  }
  if (p.daily_budget_cents !== undefined) {
    const v = num(p.daily_budget_cents)
    if (v === null || v < LIMITS.dailyBudgetMinCents || v > LIMITS.dailyBudgetMaxCents) {
      throw new BuilderError(400, 'invalid_request', `Tagesbudget unplausibel (Cent, ${LIMITS.dailyBudgetMinCents} bis ${LIMITS.dailyBudgetMaxCents}).`)
    }
  }
  if (p.budget_prozent !== undefined) {
    const v = num(p.budget_prozent)
    if (v === null || v === 0 || v < -90 || v > 100) throw new BuilderError(400, 'invalid_request', 'Budget in Prozent: zwischen -90 und +100, nicht 0.')
  }
  if (p.end_time !== undefined) {
    const t = Date.parse(str(p.end_time))
    if (!Number.isFinite(t)) throw new BuilderError(400, 'invalid_request', 'Ende ist kein gültiges Datum.')
    if (t < Date.now() + 3_600_000) throw new BuilderError(400, 'invalid_request', 'Das Ende muss mindestens eine Stunde in der Zukunft liegen.')
  }
  if (p.name_suffix !== undefined) {
    const s = str(p.name_suffix).trim()
    if (!s || s.length > 100) throw new BuilderError(400, 'invalid_request', 'Namenszusatz: 1 bis 100 Zeichen.')
  }
}

/** Patch eines Objekts aus dem Live-Stand bauen (oder Fehlertext). */
function postenBauen(level: Level, id: string, live: Raw, p: BulkRequest['patch']): Posten {
  const out: Posten = { level, id, live, body: {}, before: {}, after: {}, rang: 2 }
  const fail = (msg: string): Posten => ({ ...out, error: msg })
  const status = str(live.status)
  if (status === 'ARCHIVED' || status === 'DELETED') return fail('Archivierte oder gelöschte Objekte ändert der Assistent nicht.')

  if (p.daily_budget_cents !== undefined || p.budget_prozent !== undefined) {
    if (level === 'ad') return fail('Anzeigen haben kein eigenes Budget.')
    const camp = obj(live.campaign)
    if (level === 'adset' && (centsOf(camp.daily_budget) || centsOf(camp.lifetime_budget))) {
      return fail('Das Budget steht in der Kampagne (Advantage+ Kampagnenbudget).')
    }
    const daily = centsOf(live.daily_budget)
    const lifetime = centsOf(live.lifetime_budget)
    if (!daily && !lifetime) {
      return fail(level === 'campaign' ? 'Die Kampagne hat kein Kampagnenbudget; das Budget steht in den Anzeigengruppen.' : 'Kein eigenes Budget gefunden.')
    }
    if (p.daily_budget_cents !== undefined) {
      if (!daily) return fail('Laufzeitbudget: bitte einzeln bearbeiten (Tagesbudget geht hier nicht).')
      const neu = Math.round(num(p.daily_budget_cents) ?? 0)
      if (neu !== daily) {
        out.body.daily_budget = neu
        out.before.daily_budget_cents = daily
        out.after.daily_budget_cents = neu
        out.rang = neu > daily ? 3 : 1
        if (Math.abs(neu - daily) / daily > 0.2) out.hinweis = 'Budget ändert sich um mehr als 20 %: Die Lernphase kann neu starten.'
      }
    } else {
      const pct = num(p.budget_prozent) ?? 0
      const basis = daily || lifetime
      const neu = Math.round(basis * (1 + pct / 100))
      if (daily && neu < LIMITS.dailyBudgetMinCents) return fail(`Tagesbudget wäre unter dem Minimum (${LIMITS.dailyBudgetMinCents} Cent).`)
      if (daily && neu > LIMITS.dailyBudgetMaxCents) return fail(`Tagesbudget wäre unplausibel hoch (über ${LIMITS.dailyBudgetMaxCents} Cent).`)
      if (!daily && neu > LIMITS.lifetimeBudgetMaxCents) return fail(`Laufzeitbudget wäre unplausibel hoch (über ${LIMITS.lifetimeBudgetMaxCents} Cent).`)
      if (!daily) {
        const ausgegeben = Math.max(0, lifetime - centsOf(live.budget_remaining))
        if (neu < Math.ceil(ausgegeben * 1.1)) return fail('Meta verlangt beim Senken eines Laufzeitbudgets mindestens 10 % mehr als schon ausgegeben.')
      }
      const key = daily ? 'daily_budget' : 'lifetime_budget'
      out.body[key] = neu
      out.before[`${key}_cents`] = basis
      out.after[`${key}_cents`] = neu
      out.rang = neu > basis ? 3 : 1
      if (Math.abs(pct) > 20) out.hinweis = 'Budget ändert sich um mehr als 20 %: Die Lernphase kann neu starten.'
    }
  }
  if (p.end_time !== undefined) {
    if (level === 'ad') return fail('Anzeigen haben kein eigenes Ende; Ende der Anzeigengruppe ändern.')
    const key = level === 'campaign' ? 'stop_time' : 'end_time'
    const neu = new Date(Date.parse(str(p.end_time))).toISOString()
    out.body[key] = neu
    out.before.end_time = str(live[key]) || null
    out.after.end_time = neu
  }
  if (p.name_suffix !== undefined) {
    const suffix = str(p.name_suffix).replace(new RegExp(DASH_CHARS.source, 'g'), '-').replace(/\s+/g, ' ').trim()
    const neu = cleanName(`${str(live.name).trim()} ${suffix}`)
    if (neu !== str(live.name)) {
      out.body.name = neu
      out.before.name = str(live.name)
      out.after.name = neu
    }
  }
  if (p.status !== undefined && p.status !== status) {
    out.body.status = p.status
    out.before.status = status
    out.after.status = p.status
    out.rang = p.status === 'PAUSED' ? 0 : 4
  }
  return out
}

const AKTIV_ORDER: Readonly<Record<Level, number>> = { ad: 0, adset: 1, campaign: 2 }

export async function modeBulk(ctx: Ctx, req: BulkRequest): Promise<BulkResponse> {
  if (req.confirm !== true) throw new BuilderError(400, 'invalid_request', 'Massenbearbeitung braucht eine ausdrückliche Bestätigung (confirm: true).')
  if (ctx.caller.system || !ctx.caller.userId) throw new BuilderError(403, 'forbidden', 'Änderungen an Meta gehen nur per Klick einer Person, nicht als System-Aufruf.')
  const items = arr<Raw>(req.items)
  if (!items.length) throw new BuilderError(400, 'invalid_request', 'Keine Objekte ausgewählt.')
  if (items.length > LIMITS.bulkMaxItems) throw new BuilderError(400, 'invalid_request', `Höchstens ${LIMITS.bulkMaxItems} Objekte auf einmal.`)
  patchPruefen(req.patch)
  const seen = new Set<string>()
  const liste: Array<{ level: Level; id: string }> = []
  for (const it of items) {
    const level = str(it.level) as Level
    if (level !== 'campaign' && level !== 'adset' && level !== 'ad') throw new BuilderError(400, 'invalid_request', 'level muss campaign, adset oder ad sein.')
    const id = metaId(it.id, 'id')
    if (seen.has(`${level}:${id}`)) continue
    seen.add(`${level}:${id}`)
    liste.push({ level, id })
  }
  const start = Date.now()

  // Live-Stand lesen (Konto-Prüfung je Objekt)
  const posten: Posten[] = []
  let lesenStopp: string | null = null
  for (const it of liste) {
    if (!lesenStopp) lesenStopp = auslastungZuHoch()
    if (lesenStopp) { posten.push({ ...it, live: null, body: {}, before: {}, after: {}, error: lesenStopp, rang: 2 }); continue }
    try {
      const live = await graphGet<Raw>(it.id, { fields: FIELDS[it.level] })
      if (digits(live.account_id) !== ctx.env.account) {
        posten.push({ ...it, live: null, body: {}, before: {}, after: {}, error: `${LEVEL_TEXT[it.level]} gehört nicht zu unserem Werbekonto.`, rang: 2 })
        continue
      }
      posten.push(postenBauen(it.level, it.id, live, req.patch))
    } catch (err) {
      posten.push({ ...it, live: null, body: {}, before: {}, after: {}, error: fehlerText(err), rang: 2 })
    }
  }

  // Leitplanke einmal für alles, was steigt (nichts schreiben, wenn darüber)
  const lp: LeitplankenPosten[] = posten
    .filter(p => !p.error && p.live && p.level !== 'ad' && Object.keys(p.body).length)
    .map(p => ({ level: p.level, id: p.id, live: p.live as Raw, patch: p.body }))
  const guardrail: GuardrailInfo | null = await leitplankePruefen(ctx, lp)
  if (guardrail && !guardrail.ok) throw leitplankenFehler(guardrail)

  const budgetIds = posten.filter(p => p.body.daily_budget !== undefined || p.body.lifetime_budget !== undefined).map(p => p.id)
  const zeiten = await budgetAenderungen(ctx, budgetIds)

  const order = posten.map((p, i) => ({ p, i })).sort((a, b) => {
    if (a.p.rang !== b.p.rang) return a.p.rang - b.p.rang
    if (a.p.rang === 4) return AKTIV_ORDER[a.p.level] - AKTIV_ORDER[b.p.level]
    return a.i - b.i
  })
  let stopp: string | null = null
  const results: BulkResult[] = new Array(posten.length)
  for (const { p, i } of order) {
    const base = { level: p.level, id: p.id, before: p.before, after: p.after, ...(p.hinweis ? { hinweis: p.hinweis } : {}) }
    if (p.error) { results[i] = { ...base, ok: false, error: p.error, after: {} }; continue }
    if (!Object.keys(p.body).length) { results[i] = { ...base, ok: true, hinweis: 'Schon so eingestellt, nichts geändert.' }; continue }
    if (!stopp && Date.now() - start > RUN_CUTOFF_MS) stopp = 'Zeitlimit erreicht. Die übrigen Objekte bitte noch einmal bearbeiten.'
    if (!stopp) stopp = auslastungZuHoch()
    if (stopp) { results[i] = { ...base, ok: false, error: stopp, after: {} }; continue }
    if (p.body.daily_budget !== undefined || p.body.lifetime_budget !== undefined) {
      const sperre = budgetSperre(zeiten[p.id])
      if (sperre) { results[i] = { ...base, ok: false, error: sperre, after: {} }; continue }
    }
    try {
      await metaPost(ctx, p.id, p.body, { level: p.level, entityId: p.id, idempotent: true, before: p.before })
      if (p.body.daily_budget !== undefined || p.body.lifetime_budget !== undefined) (zeiten[p.id] = zeiten[p.id] ?? []).push(Date.now())
      results[i] = { ...base, ok: true }
    } catch (err) {
      if (err instanceof MetaApiError && err.userMsg === 'META_WRITES_DISABLED') throw err
      results[i] = { ...base, ok: false, error: fehlerText(err), after: {} }
      if (err instanceof MetaApiError && err.kind === 'rate_limit') stopp = 'Meta drosselt gerade (Rate-Limit). Die übrigen Objekte bitte später bearbeiten.'
    }
  }

  // Spiegel nachziehen (Fehler hier nie fatal, der nächtliche Sync holt alles nach)
  const ok = posten.filter((p, i) => results[i]?.ok && Object.keys(p.body).length && p.live)
  try {
    for (const cid of uniq(ok.filter(p => p.level === 'campaign').map(p => p.id))) {
      await readback(ctx.sb, { campaignId: cid, adsetIds: [], adIds: [] })
    }
    const adsetIds = uniq(ok.filter(p => p.level === 'adset').map(p => p.id))
    const ads = ok.filter(p => p.level === 'ad')
    if (adsetIds.length || ads.length) {
      await readback(ctx.sb, {
        adsetIds: uniq([...adsetIds, ...ads.map(p => str((p.live as Raw).adset_id)).filter(Boolean)]),
        adIds: ads.map(p => p.id),
      })
    }
  } catch (e) { console.warn('[meta-builder] bulk Rücklesen:', errText(e).slice(0, 200)) }

  console.log(`[meta-builder] bulk: ${results.filter(r => r.ok).length}/${results.length} ok`)
  return { results, guardrail }
}
