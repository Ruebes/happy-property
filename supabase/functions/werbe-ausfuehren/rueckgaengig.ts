// werbe-ausfuehren, Modus 'rueckgaengig': eine ausgeführte Aktion zurücknehmen.
//
// Ablauf:
//   1 Nur admin/verwalter, Recht werbung oder System (darfSchreiben).
//   2 Original laden: status 'ausgeführt', keine Rücknahme einer Rücknahme,
//     noch keine offene/erfolgreiche Rücknahme (Idempotenz 'undo:<id>:<n>').
//   3 Gegenaktion: pause <-> activate (ersatz_aktivieren -> pause), budget_set auf
//     den exakten Vorher-Wert (readback.vorher.daily_budget, sonst before).
//   4 Live bei Meta prüfen: unser Konto, Zustand noch so wie nach der Ausführung
//     (sonst ablehnen, Mensch hat inzwischen etwas geändert). pre_state_hash aus
//     diesem Live-Zustand, damit der Ausführer Änderungen bis zur Ausführung erkennt.
//   5 Neue ad_actions-Zeile (origin wie das Original, undo_of, before/after getauscht):
//       manuell   -> status 'bestätigt' (System-Insert), Ausführung Modus 'manuell'
//       autopilot -> Vorschlag (status NULL, freigabe 'vorgeschlagen', eigene gruppe_id),
//                    sofort über werbe_vorschlag_entscheiden freigegeben (mit dem JWT des
//                    Nutzers, damit approved_by und die DB-Rechte stimmen), dann Modus
//                    'freigabe'. Ein direkter Insert mit 'bestätigt' geht nicht: der
//                    werbe_actions_guard verlangt dafür freigabe 'autonom', und autonome
//                    Zeilen führt der Ausführer nur im Modus autonom aus.
//   6 Leitplanken (Änderungsfenster für activate/budget_set, Konto, Rücklesen) macht
//     ausfuehren() wie bei jeder anderen Zeile. Außerhalb des Fensters bleibt die
//     Zeile 'bestätigt' und läuft im nächsten Fenster.
//   Plan-B-Paare (HP-Regel 4: Budgets immer gleich): ist das Original ein budget_set mit
//   gruppe_id, werden ALLE ausgeführten budget_set-Mitglieder dieser Gruppe gemeinsam
//   zurückgenommen (je Mitglied eine Gegenzeile, eine gemeinsame neue gruppe_id). So greift die
//   Symmetrie-Prüfung des Ausführers und kein Paar bleibt mit ungleichen Budgets zurück.

import type { Caller } from '../_shared/callerAuth.ts'
import { graphGet, metaEnv, metaWritesDisabled, MetaApiError } from '../_shared/metaGraph.ts'
import { ausfuehren, preStateHash, type AusfuehrenErgebnis } from '../_shared/werbeAusfuehren.ts'
import { akteurVon, darfSchreiben, digits, errMsg, fehler, json, nutzerClient, stoppMail, type Sb } from './gemeinsam.ts'

type Level = 'ad' | 'adset' | 'campaign'

const GEGEN: Record<string, string> = {
  pause: 'activate',
  activate: 'pause',
  ersatz_aktivieren: 'pause',
  budget_set: 'budget_set',
}
const FELDER: Record<Level, string> = {
  ad: 'account_id,name,status,effective_status,updated_time',
  adset: 'account_id,name,status,effective_status,daily_budget,lifetime_budget,updated_time',
  campaign: 'account_id,name,status,effective_status,daily_budget,lifetime_budget,updated_time',
}
const LAUFFAEHIG = ['vorschlag', 'ein_klick', 'autonom']
const UNDO_GUELTIG_MS = 7 * 86_400_000

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const cents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

interface Original {
  id: string
  platform?: string | null
  ad_id: string | null
  ad_name?: string | null
  campaign_name?: string | null
  action: string
  status: string | null
  executed_at?: string | null
  origin?: string | null
  entity_level?: string | null
  entity_id?: string | null
  payload?: Record<string, unknown> | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  readback?: Record<string, unknown> | null
  rule_key?: string | null
  rule_version?: number | null
  approval_level?: number | null
  undo_of?: string | null
  gruppe_id?: string | null
}

/** Geprüfte Gegenaktion zu einem Original (vor dem Anlegen der Gegenzeile). */
interface Plan {
  o: Original
  level: Level
  entityId: string
  zielBudget: number | null
  erwartetJetzt: { status?: string; daily_budget?: number | null }
  bisher: number
  live?: Record<string, unknown>
  hash?: string
}

/** Schritt 2/3 für ein Original: offene Rücknahmen, Ziel-ID, Gegenwert. */
async function planen(sb: Sb, o: Original, gegen: string, autopilot: boolean, vor: string): Promise<Plan | Response> {
  const { data: frueher, error: fErr } = await sb.from('ad_actions').select('id, status').eq('undo_of', o.id).limit(20)
  if (fErr) return fehler(500, `Frühere Rücknahmen lesen: ${String(fErr.message ?? fErr)}`)
  const bisher = (frueher ?? []) as Array<{ id: string; status: string | null }>
  const offen = bisher.find(r => r.status === null || r.status === 'bestätigt' || r.status === 'ausgeführt')
  if (offen) return fehler(409, `${vor}Diese Aktion wurde bereits zurückgenommen oder die Rücknahme läuft noch`, { undo_action_id: offen.id })

  const level: Level = o.entity_level === 'adset' || o.entity_level === 'campaign' ? o.entity_level : 'ad'
  const entityId = digits(o.entity_id ?? o.ad_id)
  if (!entityId) return fehler(409, `${vor}Ziel-ID der Aktion fehlt`)
  if (!autopilot && (level !== 'ad' || (gegen !== 'pause' && gegen !== 'activate'))) {
    return fehler(409, 'Manuelle Aktionen lassen sich nur auf Anzeigen-Ebene (Pausieren/Aktivieren) zurücknehmen')
  }

  // 3 Ziel der Gegenaktion
  const rb = obj(o.readback)
  const vorher = obj(rb?.vorher) ?? obj(o.before)
  const nachher = obj(rb?.nachher)
  let zielBudget: number | null = null
  let erwartetJetzt: { status?: string; daily_budget?: number | null } = {}
  if (gegen === 'budget_set') {
    zielBudget = cents(obj(rb?.vorher)?.daily_budget ?? o.before?.daily_budget_cents ?? o.before?.daily_budget)
    if (zielBudget === null) return fehler(409, `${vor}Vorher-Budget unbekannt, Rücknahme nicht möglich`)
    erwartetJetzt = { daily_budget: cents(nachher?.daily_budget ?? o.payload?.daily_budget_cents ?? o.after?.daily_budget_cents) }
  } else {
    if (autopilot && gegen === 'activate' && vorher && String(vorher.status ?? '') !== 'ACTIVE') {
      return fehler(409, 'Das Objekt war vor der Aktion nicht aktiv, Rücknahme würde etwas neu einschalten')
    }
    erwartetJetzt = { status: o.action === 'pause' ? 'PAUSED' : 'ACTIVE' }
  }
  return { o, level, entityId, zielBudget, erwartetJetzt, bisher: bisher.length }
}

/** Schritt 4 für einen Plan: Live-Zustand, Konto, unverändert seit der Ausführung, Hash. null = ok. */
async function livePruefen(p: Plan, gegen: string, vor: string): Promise<Response | null> {
  let live: Record<string, unknown>
  try {
    live = await graphGet<Record<string, unknown>>(p.entityId, { fields: FELDER[p.level] })
  } catch (err) {
    const me = err instanceof MetaApiError ? err : null
    return fehler(502, `${vor}Zustand bei Meta lesen: ${me?.userMsg ?? errMsg(err)}`, { meta: me?.detail() ?? null })
  }
  if (digits(live.account_id) !== metaEnv().account) return fehler(403, `${vor}Objekt gehört nicht zu unserem Werbekonto`)
  if (p.erwartetJetzt.status && String(live.status ?? '') !== p.erwartetJetzt.status) {
    return fehler(409, `${vor}Zustand bei Meta hat sich seitdem geändert (jetzt ${String(live.status ?? '?')}), Rücknahme abgebrochen`)
  }
  if (gegen === 'budget_set') {
    const jetzt = cents(live.daily_budget)
    if (p.erwartetJetzt.daily_budget && jetzt !== p.erwartetJetzt.daily_budget) {
      return fehler(409, `${vor}Budget bei Meta hat sich seitdem geändert (jetzt ${jetzt ?? '?'} USD-Cent), Rücknahme abgebrochen`)
    }
    if (jetzt === p.zielBudget) return fehler(409, `${vor}Das Budget steht bei Meta schon auf dem Vorher-Wert`)
  }
  p.live = live
  p.hash = await preStateHash({
    status: live.status, effective_status: live.effective_status, daily_budget: live.daily_budget, updated_time: live.updated_time,
  })
  return null
}

export async function rueckgaengig(
  sb: Sb,
  req: Request,
  caller: Caller,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!darfSchreiben(caller)) return fehler(403, 'Rückgängig machen dürfen nur Admin oder Nutzer mit dem Recht Werbung')
  const actionId = String(body.action_id ?? '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(actionId)) return fehler(400, 'action_id fehlt oder ist ungültig')
  if (metaWritesDisabled()) {
    return fehler(503, 'Schreibzugriffe an Meta sind gesperrt (META_WRITES_DISABLED)', { code: 'META_WRITES_DISABLED' })
  }
  const grund = String(body.grund ?? '').trim().slice(0, 300)

  // 2 Original
  const { data: o0, error: oErr } = await sb.from('ad_actions').select('*').eq('id', actionId).maybeSingle()
  if (oErr) return fehler(500, `Aktion lesen: ${String(oErr.message ?? oErr)}`)
  const o = o0 as Original | null
  if (!o) return fehler(404, 'Aktion nicht gefunden')
  if (o.status !== 'ausgeführt') return fehler(409, `Nur ausgeführte Aktionen lassen sich zurücknehmen (Status: ${o.status ?? 'Vorschlag'})`)
  if (o.undo_of) return fehler(409, 'Eine Rücknahme lässt sich nicht selbst zurücknehmen')
  const gegen = GEGEN[o.action]
  if (!gegen) return fehler(409, `Für die Aktion "${o.action}" gibt es kein Rückgängig`)

  const autopilot = o.origin === 'autopilot'

  // Plan-B-Paar: Budget-Rücknahme immer für alle ausgeführten Mitglieder der Gruppe
  let originale: Original[] = [o]
  if (autopilot && o.action === 'budget_set' && o.gruppe_id) {
    const { data: mg, error: mErr } = await sb.from('ad_actions').select('*')
      .eq('gruppe_id', o.gruppe_id).eq('action', 'budget_set').eq('status', 'ausgeführt').limit(20)
    if (mErr) return fehler(500, `Gruppe der Aktion lesen: ${String(mErr.message ?? mErr)}`)
    const weitere = ((mg ?? []) as Original[]).filter(m => m.id !== o.id && !m.undo_of)
    originale = [o, ...weitere]
  }
  const vorText = (m: Original) => (m.id === o.id ? '' : `Partner ${digits(m.entity_id ?? m.ad_id) || m.id}: `)

  const plaene: Plan[] = []
  for (const m of originale) {
    const p = await planen(sb, m, gegen, autopilot, vorText(m))
    if (p instanceof Response) return p
    plaene.push(p)
  }

  // Autopilot muss laufen (sonst führt der Ausführer die Zeile nie aus)
  if (autopilot) {
    const { data: st, error: sErr } = await sb.from('ad_settings')
      .select('autopilot_mode, autopilot_paused_until').eq('id', 'default').maybeSingle()
    if (sErr) return fehler(500, `ad_settings lesen: ${String(sErr.message ?? sErr)}`)
    const s = (st ?? {}) as { autopilot_mode?: string | null; autopilot_paused_until?: string | null }
    const pausiert = !!s.autopilot_paused_until && Date.parse(s.autopilot_paused_until) > Date.now()
    if (!LAUFFAEHIG.includes(String(s.autopilot_mode ?? '')) || pausiert) {
      return fehler(409, 'Der Autopilot ist aus oder pausiert. Bitte die Anzeige im Werbemanager von Hand zurückstellen oder den Autopiloten erst wieder auf Vorschlag stellen.', {
        code: 'autopilot_aus', autopilot_mode: s.autopilot_mode ?? null,
      })
    }
  }

  // 4 Live-Zustand je Mitglied
  for (const p of plaene) {
    const r = await livePruefen(p, gegen, vorText(p.o))
    if (r) return r
  }

  // 5 Gegenzeilen (eine gemeinsame gruppe_id)
  const akteur = akteurVon(caller)
  const gruppeId = autopilot ? crypto.randomUUID() : null
  const zeilen = plaene.map(p => {
    const m = p.o
    const live = p.live ?? {}
    const entityName = String(live.name ?? m.ad_name ?? (typeof m.payload?.entity_name === 'string' ? m.payload.entity_name : ''))
    const datum = (m.executed_at ?? '').slice(0, 10)
    const payload: Record<string, unknown> = { entity_name: entityName || null, rueckgaengig: true }
    if (p.zielBudget !== null) payload.daily_budget_cents = p.zielBudget
    const zeile: Record<string, unknown> = {
      platform: m.platform ?? 'meta',
      ad_id: m.ad_id ?? null,
      ad_name: m.ad_name ?? null,
      campaign_name: m.campaign_name ?? null,
      action: gegen,
      reason: `Rückgängig: ${m.action}${datum ? ` vom ${datum}` : ''}${grund ? ` (${grund})` : ''}`.slice(0, 300),
      created_by: akteur,
      origin: autopilot ? 'autopilot' : 'manuell',
      entity_level: p.level,
      entity_id: p.entityId,
      gruppe_id: gruppeId,
      payload,
      before: m.after ?? null,
      after: m.before ?? null,
      rule_key: m.rule_key ?? null,
      rule_version: m.rule_version ?? null,
      approval_level: autopilot ? (m.approval_level ?? 1) : null,
      evidence: {
        undo_of: m.id, grund: grund || null, live_vorher: { status: live.status ?? null, daily_budget: cents(live.daily_budget) },
        ...(plaene.length > 1 ? { gruppe_von: o.gruppe_id ?? null, ausgeloest_von: o.id } : {}),
      },
      undo_of: m.id,
      idempotency_key: `undo:${m.id}:${p.bisher}`,
      pre_state_hash: p.hash ?? null,
      status: autopilot ? null : 'bestätigt',
      freigabe: autopilot ? 'vorgeschlagen' : null,
      expires_at: autopilot ? new Date(Date.now() + UNDO_GUELTIG_MS).toISOString() : null,
    }
    return zeile
  })
  // Ein Insert für alle Mitglieder (atomar: alle oder keine)
  const { data: neu, error: iErr } = await sb.from('ad_actions').insert(zeilen).select('id, undo_of')
  const neuZeilen = (neu ?? []) as Array<{ id: string; undo_of: string | null }>
  if (iErr || !neuZeilen.length) {
    const msg = String(iErr?.message ?? iErr ?? 'unbekannt')
    if (/duplicate|unique/i.test(msg)) return fehler(409, 'Die Rücknahme läuft bereits (Doppelklick?)')
    return fehler(500, `Rücknahme anlegen: ${msg}`)
  }
  const undoIds = neuZeilen.map(r => String(r.id))
  const undoId = String(neuZeilen.find(r => r.undo_of === o.id)?.id ?? undoIds[0])

  // Autopilot: über die Freigabe-RPC bestätigen (wie ein Vorschlag)
  if (autopilot && gruppeId) {
    const client = caller.kind === 'user' ? nutzerClient(req) : sb
    const { data: ent, error: rErr } = await client.rpc('werbe_vorschlag_entscheiden', {
      p_gruppe: gruppeId, p_entscheidung: 'freigeben', p_grund: `Rückgängig${grund ? `: ${grund}` : ''}`,
    })
    const ok = !rErr && (ent as { success?: boolean } | null)?.success === true
    if (!ok) {
      // aufräumen: Vorschlag verwerfen, damit er nicht in der Liste hängen bleibt
      const { error: cErr } = await sb.from('ad_actions')
        .update({ status: 'abgelehnt', freigabe: 'verworfen', result: 'Rücknahme nicht freigegeben' })
        .in('id', undoIds).is('status', null)
      if (cErr) console.warn('[werbe-ausfuehren] Rücknahme aufräumen:', String(cErr.message ?? cErr).slice(0, 200))
      const grundRpc = rErr ? String(rErr.message ?? rErr) : String((ent as { grund?: string } | null)?.grund ?? 'unbekannt')
      return fehler(rErr && /berechtigung|42501/i.test(grundRpc) ? 403 : 409, `Freigabe der Rücknahme fehlgeschlagen: ${grundRpc}`)
    }
  }

  // 6 Ausführen
  let erg: AusfuehrenErgebnis
  try {
    erg = autopilot && gruppeId
      ? await ausfuehren(sb, { modus: 'freigabe', gruppeId, akteur, fn: 'werbe-ausfuehren' })
      : await ausfuehren(sb, { modus: 'manuell', ids: [undoId], akteur, fn: 'werbe-ausfuehren' })
  } catch (err) {
    return fehler(500, `Ausführen: ${errMsg(err)}`, { undo_action_id: undoId })
  }
  delete erg.delegiert // Gegenzeilen sind nie ersatz_hochladen; interne Zeilen nie an die Oberfläche
  let mail: boolean | undefined
  if (erg.gestoppt) mail = await stoppMail(erg.gestoppt, `Rückgängig von Aktion ${o.id}`)
  return json({
    success: true, modus: 'rueckgaengig', undo_action_id: undoId, ...(undoIds.length > 1 ? { undo_action_ids: undoIds } : {}),
    gruppe_id: gruppeId, ...erg, ...(mail !== undefined ? { stopp_mail: mail } : {}),
  })
}
