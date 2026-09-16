// ── Monatskalender Mischnutzung: Anzeige-Helfer ─────────────────────────────
// Reine Formatierung (keine Rechenlogik - die steht in rechner.ts).
import type { MonthPlan, MonthUse } from './rechner'

// Monatsname in der Sprache des Lesers ('short' = "März", 'long' = "März").
export function monthName(month: number, lang: string, style: 'short' | 'long' = 'long'): string {
  try {
    return new Intl.DateTimeFormat(lang || 'de', { month: style }).format(new Date(2026, month - 1, 1))
  } catch {
    return String(month)
  }
}

// Zusammenhaengende Monate als Bereiche: [3,4,5,9,10,11] → "März bis Mai, September bis November".
// Der Jahreswechsel (Dezember bis Februar) wird als ein Bereich erkannt.
export function formatMonthRanges(months: number[], lang: string, joiner = 'bis', style: 'short' | 'long' = 'long'): string {
  const set = new Set(months.filter(m => m >= 1 && m <= 12))
  if (!set.size) return ''
  if (set.size === 12) return monthName(1, lang, style) + ' ' + joiner + ' ' + monthName(12, lang, style)
  // Startpunkt: ein Monat, dessen Vorgaenger nicht im Set ist (haelt Dez→Jan zusammen).
  let start = 1
  for (let m = 1; m <= 12; m++) { const prev = m === 1 ? 12 : m - 1; if (set.has(m) && !set.has(prev)) { start = m; break } }
  const ranges: Array<[number, number]> = []
  let cur: [number, number] | null = null
  for (let i = 0; i < 12; i++) {
    const m = ((start - 1 + i) % 12) + 1
    if (set.has(m)) { if (cur) cur[1] = m; else cur = [m, m] }
    else if (cur) { ranges.push(cur); cur = null }
  }
  if (cur) ranges.push(cur)
  return ranges.map(([a, b]) => a === b ? monthName(a, lang, style) : `${monthName(a, lang, style)} ${joiner} ${monthName(b, lang, style)}`).join(', ')
}

export function monthsWithUse(plan: MonthPlan | null | undefined, use: MonthUse): number[] {
  if (!plan) return []
  return plan.map((u, i) => u === use ? i + 1 : 0).filter(Boolean)
}
