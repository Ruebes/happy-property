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

  const { data: frueher, error: fErr } = await sb.from('ad_actions').select('id, status').eq('undo_of', o.id).limit(20)
  if (fErr) return fehler(500, `Frühere Rücknahmen lesen: ${String(fErr.message ?? fErr)}`)
  const bisher = (frueher ?? []) as Array<{ id: string; status: string | null }>
  const offen = bisher.find(r => r.status === null || r.status === 'bestätigt' || r.status === 'ausgeführt')
  if (offen) return fehler(409, 'Diese Aktion wurde bereits zurückgenommen oder die Rücknahme läuft noch', { undo_action_id: offen.id })

  const level: Level = o.entity_level === 'adset' || o.entity_level === 'campaign' ? o.entity_level : 'ad'
  const entityId = digits(o.entity_id ?? o.ad_id)
  if (!entityId) return fehler(409, 'Ziel-ID der Aktion fehlt')
  const autopilot = o.origin === 'autopilot'
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
    if (zielBudget === null) return fehler(409, 'Vorher-Budget unbekannt, Rücknahme nicht möglich')
    erwartetJetzt = { daily_budget: cents(nachher?.daily_budget ?? o.payload?.daily_budget_cents ?? o.after?.daily_budget_cents) }
  } else {
    if (autopilot && gegen === 'activate' && vorher && String(vorher.status ?? '') !== 'ACTIVE') {
      return fehler(409, 'Das Objekt war vor der Aktion nicht aktiv, Rücknahme würde etwas neu einschalten')
    }
    erwartetJetzt = { status: o.action === 'pause' ? 'PAUSED' : 'ACTIVE' }
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

  // 4 Live-Zustand
  let live: Record<string, unknown>
  try {
    live = await graphGet<Record<string, unknown>>(entityId, { fields: FELDER[level] })
  } catch (err) {
    const me = err instanceof MetaApiError ? err : null
    return fehler(502, `Zustand bei Meta lesen: ${me?.userMsg ?? errMsg(err)}`, { meta: me?.detail() ?? null })
  }
  if (digits(live.account_id) !== metaEnv().account) return fehler(403, 'Objekt gehört nicht zu unserem Werbekonto')
  if (erwartetJetzt.status && String(live.status ?? '') !== erwartetJetzt.status) {
    return fehler(409, `Zustand bei Meta hat sich seitdem geändert (jetzt ${String(live.status ?? '?')}), Rücknahme abgebrochen`)
  }
  if (gegen === 'budget_set') {
    const jetzt = cents(live.daily_budget)
    if (erwartetJetzt.daily_budget && jetzt !== erwartetJetzt.daily_budget) {
      return fehler(409, `Budget bei Meta hat sich seitdem geändert (jetzt ${jetzt ?? '?'} USD-Cent), Rücknahme abgebrochen`)
    }
    if (jetzt === zielBudget) return fehler(409, 'Das Budget steht bei Meta schon auf dem Vorher-Wert')
  }
  const hash = await preStateHash({
    status: live.status, effective_status: live.effective_status, daily_budget: live.daily_budget, updated_time: live.updated_time,
  })

  // 5 Gegenzeile
  const akteur = akteurVon(caller)
  const entityName = String(live.name ?? o.ad_name ?? (typeof o.payload?.entity_name === 'string' ? o.payload.entity_name : ''))
  const datum = (o.executed_at ?? '').slice(0, 10)
  const payload: Record<string, unknown> = { entity_name: entityName || null, rueckgaengig: true }
  if (zielBudget !== null) payload.daily_budget_cents = zielBudget
  const gruppeId = autopilot ? crypto.randomUUID() : null
  const zeile: Record<string, unknown> = {
    platform: o.platform ?? 'meta',
    ad_id: o.ad_id ?? null,
    ad_name: o.ad_name ?? null,
    campaign_name: o.campaign_name ?? null,
    action: gegen,
    reason: `Rückgängig: ${o.action}${datum ? ` vom ${datum}` : ''}${grund ? ` (${grund})` : ''}`.slice(0, 300),
    created_by: akteur,
    origin: autopilot ? 'autopilot' : 'manuell',
    entity_level: level,
    entity_id: entityId,
    gruppe_id: gruppeId,
    payload,
    before: o.after ?? null,
    after: o.before ?? null,
    rule_key: o.rule_key ?? null,
    rule_version: o.rule_version ?? null,
    approval_level: autopilot ? (o.approval_level ?? 1) : null,
    evidence: { undo_of: o.id, grund: grund || null, live_vorher: { status: live.status ?? null, daily_budget: cents(live.daily_budget) } },
    undo_of: o.id,
    idempotency_key: `undo:${o.id}:${bisher.length}`,
    pre_state_hash: hash,
    status: autopilot ? null : 'bestätigt',
    freigabe: autopilot ? 'vorgeschlagen' : null,
    expires_at: autopilot ? new Date(Date.now() + UNDO_GUELTIG_MS).toISOString() : null,
  }
  const { data: neu, error: iErr } = await sb.from('ad_actions').insert(zeile).select('id').single()
  if (iErr || !neu) {
    const msg = String(iErr?.message ?? iErr ?? 'unbekannt')
    if (/duplicate|unique/i.test(msg)) return fehler(409, 'Die Rücknahme läuft bereits (Doppelklick?)')
    return fehler(500, `Rücknahme anlegen: ${msg}`)
  }
  const undoId = String((neu as { id: string }).id)

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
        .eq('id', undoId).is('status', null)
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
  let mail: boolean | undefined
  if (erg.gestoppt) mail = await stoppMail(erg.gestoppt, `Rückgängig von Aktion ${o.id}`)
  return json({ success: true, modus: 'rueckgaengig', undo_action_id: undoId, gruppe_id: gruppeId, ...erg, ...(mail !== undefined ? { stopp_mail: mail } : {}) })
}
