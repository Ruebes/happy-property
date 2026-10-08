// Alle Erklaertexte der Kundenseite. Ein Fehler in einem Erklaerblock darf die
// Seite nie kaputt machen: Dann fehlt nur dieser Text.
import type { Guide, GuideCtx } from './types'
import { buildOverviewGuides } from './overview'
import { buildCashflowGuides } from './cashflow'
import { buildCreditGuides } from './credit'
import { buildExitGuides } from './exit'
import { buildScenarioGuides } from './scenarios'

const BUILDERS: Array<(ctx: GuideCtx) => Record<string, Guide | null>> = [
  buildOverviewGuides, buildCashflowGuides, buildCreditGuides, buildExitGuides, buildScenarioGuides,
]

export function buildGuides(ctx: GuideCtx): Record<string, Guide | null> {
  const out: Record<string, Guide | null> = {}
  for (const build of BUILDERS) {
    try { Object.assign(out, build(ctx)) } catch (e) { console.error('Erklärtext', e) }
  }
  return out
}
