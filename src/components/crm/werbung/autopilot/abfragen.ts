import { supabase } from '../../../../lib/supabase'
import type { WerbeAktion, WerbeAutopilotEinstellungen, WerbeRegel } from '../../../../lib/werbungTypes'

// ── Abfragen für Autopilot, Qualität und Freigabe-Seite ─────────────────────
// Micro-Instanz: immer einzeln (await nacheinander), mit Zeitfilter und Limit.
// Die Funktionen werfen den PostgREST-Fehler weiter; Aufrufer prüfen mit
// fehltSchema(), ob nur die Migration noch fehlt.

export const EINSTELLUNG_FELDER =
  'id, max_account_daily_budget, autopilot_mode, autopilot_paused_until, autopilot_stop_grund, target_cpte_eur, ' +
  'monthly_cap_eur, max_auto_actions_per_day, kap_floor, change_window_dows, builder_enabled, capi_echtzeit, ' +
  'pool_auto_release_level, pool_auto_release_threshold, budget_autonomie_freigegeben_at, budget_autonomie_von, updated_at'

export const AKTION_FELDER =
  'id, ad_id, ad_name, campaign_name, action, reason, status, created_at, executed_at, result, origin, entity_level, ' +
  'entity_id, gruppe_id, payload, before, after, readback, rule_key, rule_version, evidence, approval_level, freigabe, ' +
  'approved_by, approved_at, expires_at, window_date, idempotency_key, pre_state_hash, claimed_at, undo_of'

export const LOG_FELDER =
  'id, ts, lauf_id, art, rule_key, rule_version, modus, approval_level, entity_level, entity_id, entity_name, aktion, ' +
  'before, after, evidence, readback, meta_response, ergebnis, action_id, gruppe_id, bezug_log_id, undo_of, ' +
  'idempotency_key, akteur, akteur_art'

/** Feste Reihenfolge der Regeln in der Tabelle (unbekannte hinten, alphabetisch) */
const REGEL_REIHENFOLGE = ['SCHUTZ', 'STOPP', 'K0', 'K1', 'K2', 'K3', 'K4', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'R1b', 'R2', 'POOL_UPLOAD', 'S1', 'D1', 'D2', 'D3']

export const regelSortierung = (a: WerbeRegel, b: WerbeRegel): number => {
  const ia = REGEL_REIHENFOLGE.indexOf(a.rule_key)
  const ib = REGEL_REIHENFOLGE.indexOf(b.rule_key)
  if (ia >= 0 && ib >= 0) return ia - ib
  if (ia >= 0) return -1
  if (ib >= 0) return 1
  return a.rule_key.localeCompare(b.rule_key)
}

export async function ladeEinstellungen(): Promise<WerbeAutopilotEinstellungen | null> {
  const { data, error } = await supabase.from('ad_settings').select(EINSTELLUNG_FELDER).eq('id', 'default').maybeSingle()
  if (error) throw error
  return (data as unknown as WerbeAutopilotEinstellungen | null) ?? null
}

export async function ladeRegeln(keys?: string[]): Promise<WerbeRegel[]> {
  let q = supabase.from('ad_autopilot_rules')
    .select('rule_key, titel, aktion, enabled, approval_level, max_level, freigabe_rolle, params, version, updated_by, updated_at')
  if (keys) {
    if (!keys.length) return []
    q = q.in('rule_key', keys)
  }
  const { data, error } = await q.limit(100)
  if (error) throw error
  return ((data as unknown as WerbeRegel[] | null) ?? []).slice().sort(regelSortierung)
}

/** Offene Vorschläge (status NULL, freigabe vorgeschlagen), neueste zuerst */
export async function ladeVorschlaege(): Promise<WerbeAktion[]> {
  const { data, error } = await supabase.from('ad_actions')
    .select(AKTION_FELDER)
    .eq('freigabe', 'vorgeschlagen')
    .is('status', null)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return (data as unknown as WerbeAktion[] | null) ?? []
}

/** Alle Zeilen einer Vorschlagsgruppe (für die Freigabe-Seite, jeder Status) */
export async function ladeGruppe(gruppeId: string): Promise<WerbeAktion[]> {
  const { data, error } = await supabase.from('ad_actions')
    .select(AKTION_FELDER)
    .eq('gruppe_id', gruppeId)
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) throw error
  return (data as unknown as WerbeAktion[] | null) ?? []
}

/** Vorschläge nach gruppe_id bündeln (ohne Gruppe: je Zeile eine Gruppe), Reihenfolge bleibt */
export function nachGruppe(rows: WerbeAktion[]): WerbeAktion[][] {
  const map = new Map<string, WerbeAktion[]>()
  for (const r of rows) {
    const k = r.gruppe_id ?? `einzeln:${r.id}`
    const arr = map.get(k)
    if (arr) arr.push(r)
    else map.set(k, [r])
  }
  return [...map.values()]
}

/** Autopilot gestoppt oder pausiert: Freigaben sind gesperrt (RPC wirft 55000) */
export function freigabenGesperrt(e: WerbeAutopilotEinstellungen | null): boolean {
  if (!e) return false
  if (e.autopilot_mode === 'aus') return true
  return !!e.autopilot_paused_until && new Date(e.autopilot_paused_until).getTime() > Date.now()
}
