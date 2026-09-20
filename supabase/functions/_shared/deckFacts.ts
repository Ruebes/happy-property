// Fakt-Korrekturen am importierten Projekt-Faktentext (crm_projects.deck_assets).
//
// Der Drive-Import (extract-project-facts) liest Broschuere/Preisliste des Bautraegers.
// Ist eine Aussage darin veraltet (Mamba: "bis zu 12 Monate nach Uebergabe", gilt
// seit 20.9.26: 24 Monate), wird sie NICHT im Rohtext geloescht, sondern ueber
// deck_assets.fact_overrides ersetzt. Der Rohimport bleibt in deck_assets.facts_raw
// erhalten, ein erneuter Import wendet die Korrekturen wieder an. So ist die
// Korrektur dauerhaft, ohne dass eine KI-Regel einen Fakt tragen muss.
export interface FactOverride {
  find: string        // Suchtext (case-insensitiv, alle Vorkommen)
  replace: string
  reason?: string
  at?: string
  by?: string
}

export function applyFactOverrides(facts: string, overrides: unknown): { text: string; applied: number; missed: FactOverride[] } {
  if (!Array.isArray(overrides) || !facts) return { text: facts, applied: 0, missed: [] }
  let text = facts
  let applied = 0
  const missed: FactOverride[] = []
  for (const o of overrides as FactOverride[]) {
    if (!o || typeof o.find !== 'string' || !o.find.trim() || typeof o.replace !== 'string') continue
    const re = new RegExp(o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const n = (text.match(re) ?? []).length
    if (n === 0) { missed.push(o); continue }
    text = text.replace(re, o.replace)
    applied += n
  }
  return { text, applied, missed }
}

/** Strukturierter CRM-Zahlungsplan als harter Faktblock: schlaegt jede Prosa aus der Broschuere. */
export function paymentScheduleFacts(sched: { reservation?: number; reservationVat?: boolean; stages: Array<{ label: string; pct: number; sub?: string }> } | null | undefined): string {
  if (!sched?.stages?.length) return ''
  const lines = sched.stages.map(s => `- ${s.pct} %: ${s.label}${s.sub ? ` (${s.sub})` : ''}`)
  const res = sched.reservation != null
    ? (sched.reservationVat === false
        ? `- Reservierung: ${sched.reservation.toLocaleString('de-DE')} € pauschal (keine MwSt zusätzlich), wird angerechnet`
        : `- Reservierung: ${sched.reservation.toLocaleString('de-DE')} € netto zzgl. 19 % MwSt, wird angerechnet`)
    : ''
  return `\n\n=== ZAHLUNGSPLAN (CRM, HART - gilt vor jeder Angabe aus Broschüre oder Preisliste) ===\n${[res, ...lines].filter(Boolean).join('\n')}`
}
