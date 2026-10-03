import { supabase } from '../../../../lib/supabase'
import type { Spiegel, SpiegelAnzeige, SpiegelGruppe, SpiegelKampagne } from './typen'

// ── Spiegeltabellen (meta_campaigns, meta_adsets, ad_catalog-Zusatzfelder) ────
// Budget, Gebotsstrategie, Auslieferung und Lernphase ohne Meta-Aufruf. Drei
// kleine Abfragen strikt nacheinander (Micro-Instanz), jede mit Limit. Fehlt
// eine Tabelle oder Spalte (Migration nicht eingespielt), bleibt die Karte leer
// und die Zentrale zeigt den Stand aus ad_catalog.

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export async function ladeSpiegel(segment: string): Promise<Spiegel> {
  const kampagnen = new Map<string, SpiegelKampagne>()
  const gruppen = new Map<string, SpiegelGruppe>()
  const anzeigen = new Map<string, SpiegelAnzeige>()
  let unvollstaendig = false

  // Nur Meta hat Spiegeltabellen
  if (segment !== 'meta') return { kampagnen, gruppen, anzeigen, unvollstaendig: true }

  const k = await supabase.from('meta_campaigns')
    .select('campaign_id, name, objective, status, effective_status, daily_budget_cents, lifetime_budget_cents, bid_strategy, special_ad_categories, stop_time, created_time, issues')
    .limit(500)
  if (k.error) { unvollstaendig = true; console.warn('[Zentrale] meta_campaigns:', k.error.message) }
  for (const r of (k.data as Array<Record<string, unknown>> | null) ?? []) {
    const id = str(r.campaign_id)
    if (!id) continue
    kampagnen.set(id, {
      campaign_id: id,
      name: str(r.name),
      objective: str(r.objective),
      status: str(r.status),
      effective_status: str(r.effective_status),
      daily_budget_cents: num(r.daily_budget_cents),
      lifetime_budget_cents: num(r.lifetime_budget_cents),
      bid_strategy: str(r.bid_strategy),
      special_ad_categories: Array.isArray(r.special_ad_categories) ? (r.special_ad_categories as unknown[]).map(String) : null,
      stop_time: str(r.stop_time),
      created_time: str(r.created_time),
      issues: r.issues ?? null,
    })
  }

  const g = await supabase.from('meta_adsets')
    .select('adset_id, campaign_id, name, status, effective_status, daily_budget_cents, lifetime_budget_cents, bid_strategy, bid_amount_cents, optimization_goal, learning_status, learning_conversions, last_sig_edit_ts, end_time, issues')
    .limit(1000)
  if (g.error) { unvollstaendig = true; console.warn('[Zentrale] meta_adsets:', g.error.message) }
  for (const r of (g.data as Array<Record<string, unknown>> | null) ?? []) {
    const id = str(r.adset_id)
    if (!id) continue
    gruppen.set(id, {
      adset_id: id,
      campaign_id: str(r.campaign_id),
      name: str(r.name),
      status: str(r.status),
      effective_status: str(r.effective_status),
      daily_budget_cents: num(r.daily_budget_cents),
      lifetime_budget_cents: num(r.lifetime_budget_cents),
      bid_strategy: str(r.bid_strategy),
      bid_amount_cents: num(r.bid_amount_cents),
      optimization_goal: str(r.optimization_goal),
      learning_status: str(r.learning_status),
      learning_conversions: num(r.learning_conversions),
      last_sig_edit_ts: str(r.last_sig_edit_ts),
      end_time: str(r.end_time),
      issues: r.issues ?? null,
    })
  }

  const a = await supabase.from('ad_catalog')
    .select('ad_id, effective_status, configured_status, issues_info, review_feedback')
    .eq('platform', segment)
    .limit(3000)
  if (a.error) { unvollstaendig = true; console.warn('[Zentrale] ad_catalog Zusatzfelder:', a.error.message) }
  for (const r of (a.data as Array<Record<string, unknown>> | null) ?? []) {
    const id = str(r.ad_id)
    if (!id) continue
    anzeigen.set(id, {
      ad_id: id,
      effective_status: str(r.effective_status),
      configured_status: str(r.configured_status),
      issues_info: r.issues_info ?? null,
      review_feedback: r.review_feedback ?? null,
    })
  }

  return { kampagnen, gruppen, anzeigen, unvollstaendig }
}
