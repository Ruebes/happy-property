import { migrateConfig, type SimUnit, type SimParams, type StrategyConfig } from './strategy'

// ── Eigene Variante des Kunden im Simulator (Sven 23.10.26) ─────────────────
// Gespeichert in crm_strategy_scenarios.customer_config: dieselben Wohnungen und
// Annahmen wie ein Fahrplan, dazu die Wohnungen, die der Kunde herausgenommen hat.
export interface CustomerSimConfig { unitsV2: SimUnit[]; paramsV2: SimParams; off?: string[] }

export function readCustomerSim(raw: unknown): { units: SimUnit[]; params: SimParams; off: string[] } {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as StrategyConfig & { off?: unknown }
  const mig = migrateConfig(cfg)
  const off = Array.isArray(cfg.off) ? cfg.off.filter((k): k is string => typeof k === 'string') : []
  return { units: mig.units, params: mig.params, off }
}

// Wohnungen, mit denen gerechnet wird (ohne die herausgenommenen)
export const activeUnits = (units: SimUnit[], off: string[]) => units.filter(u => !off.includes(u.key))
