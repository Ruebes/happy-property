import { ymOf, scheduleFromProject, isLumaStandard, type SimUnit } from './strategy'
import { normalizeMonthPlan, monthPlanCounts, type MonthPlan } from './rechner'

// ── Wohnung aus dem Bestand in den Simulator übernehmen ─────────────────────
// Gemeinsam für den CRM-Simulator und den Simulator des Kunden (Sven 23.10.26:
// Fahrplan auch ohne Wohnung freigeben, der Kunde wählt selbst). Beide bauen
// eine Wohnung damit exakt gleich: Möbel, Übergabe, Zahlungsplan, Miete.

export interface StockProject {
  id: string; name: string; furniture_cost: number | null; furniture_included: boolean | null; completion_date: string | null
  calc_defaults: { furniture_by_bedrooms?: Record<string, number> } | null
  // Zahlungsplan des Bautraegers (Sven 6.10.26): fliesst in die Kaufraten ein
  developer: string | null; payment_schedule: unknown
}
export interface StockUnit {
  id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; price_net: number | null; price_net_furnished?: number | null
  handover_date?: string | null; rental_type?: string | null
}

const now = new Date()
const NOW_YM = ymOf(now.getFullYear(), now.getMonth() + 1)

// Moebelpaket des Projekts fuer diese Wohnung, dieselbe Kette wie die
// Immobilienauswahl (furnDefaultFor) und das Deck: Staffel je Zimmerzahl ->
// projektweiter Standard -> Differenz der zweiten Preisspalte -> 0.
export const furnPackageOf = (proj: StockProject | undefined, u: { bedrooms: number | null | undefined; price_net?: number | null; price_net_furnished?: number | null }) => {
  if (!proj) return 0
  const byBed = proj.calc_defaults?.furniture_by_bedrooms ?? null
  if (byBed && u.bedrooms != null && byBed[String(u.bedrooms)] != null) return Number(byBed[String(u.bedrooms)]) || 0
  const std = Number(proj.furniture_cost) || 0
  if (std > 0) return std
  const n = u.price_net, f = u.price_net_furnished
  return n != null && f != null && f > n ? f - n : 0
}

// Geteilter Selbstnutzungs-Kalender der Kurzzeit-Wohnungen (Sven 16.9.26: der
// Eigentuemer wohnt in denselben Monaten dort, egal welche Wohnung).
export const sharedPlanOf = (us: SimUnit[]): MonthPlan | null => {
  for (const x of us) if (x.letType === 'short') { const mp = normalizeMonthPlan(x.calc?.monthPlan); if (mp) return mp }
  return null
}

// Neue Wohnung aus Projekt + Bestand. existing = schon gewählte Wohnungen (für
// den geteilten Selbstnutzungs-Kalender). Ohne Projekt (Portal-Objekt):
// Möbel 0, Übergabe = jetzt.
export function simUnitFromStock(u: StockUnit, proj: StockProject | undefined, projectName: string | undefined, existing: SimUnit[]): SimUnit {
  const furnNet = !proj || proj.furniture_included ? 0 : furnPackageOf(proj, u)
  // Preis wie in der Einzelrechnung: immer der Grundpreis (price_net).
  const priceNet = u.price_net ?? 0
  // Übergabe: Datum der Wohnung, sonst Fertigstellung des Projekts
  const readyDate = u.handover_date ?? proj?.completion_date ?? null
  const done = readyDate ? new Date(readyDate) : null
  const fallbackY = proj ? now.getFullYear() + 2 : now.getFullYear()
  const fallbackM = proj ? 6 : now.getMonth() + 1
  // Liegt die Übergabe in der Vergangenheit (schon übergebene Kundenwohnung),
  // gilt der aktuelle Monat - nicht nur das Jahr hochziehen, sonst rutscht
  // z.B. 12/2025 auf 12/2026 und die Wohnung bekommt Bauraten und Leerstand.
  const readyYM = done && !isNaN(done.getTime())
    ? Math.max(NOW_YM, ymOf(done.getFullYear(), done.getMonth() + 1))
    : ymOf(fallbackY, fallbackM)
  const readyY = Math.floor(readyYM / 12)
  const readyM = readyYM % 12 + 1
  const gross = Math.round((priceNet + furnNet) * 1.19)
  // Zahlungsplan des Bautraegers aus dem Projekt (Sven 6.10.26). Ohne
  // hinterlegten Plan bleibt es beim bisherigen Standard.
  const sched = proj ? scheduleFromProject(proj.payment_schedule, proj.developer) : null
  // Luma-Standard bleibt plan 'luma' (gleiche Zahlen wie bisher).
  const devPlan = sched && !isLumaStandard(sched) ? sched : null
  const offPlan = ymOf(readyY, readyM) - NOW_YM > 2
  const letType: SimUnit['letType'] = u.rental_type === 'long' ? 'long' : 'short'
  // Neue Kurzzeit-Wohnung uebernimmt den geteilten Selbstnutzungs-Kalender.
  const shared = letType === 'short' ? sharedPlanOf(existing) : null
  return {
    key: u.id, name: `${projectName ?? proj?.name ?? ''} ${u.unit_number}`.trim(),
    priceNet, furnNet,
    furnMode: proj?.furniture_included ? 'included' : furnNet > 0 ? 'optional' : 'none',
    rent: Math.round(gross * 0.055 / 12), letType, fin: true,
    buyM: now.getMonth() + 1, buyY: now.getFullYear(), readyM, readyY,
    plan: offPlan ? (devPlan ? 'dev' : 'luma') : 'sofort',
    // Luma-Standard: plan 'luma' rechnet wie bisher, der Plan steht nur als
    // Markierung dabei (Kundenseite zeigt dann den Finanzierungsbedarf).
    ...(offPlan && sched ? { schedule: devPlan ?? sched } : {}),
    ...(shared ? { calc: { monthPlan: shared, selfUseMonths: monthPlanCounts(shared).self } } : {}),
  }
}

// Frei eingegebene Wohnung (Standardwerte wie bisher im CRM)
export function freeSimUnit(key: string, name: string): SimUnit {
  return {
    key, name,
    priceNet: 250000, furnNet: 19000, rent: 1300, letType: 'short', fin: true,
    buyM: now.getMonth() + 1, buyY: now.getFullYear(), readyM: 6, readyY: now.getFullYear() + 2, plan: 'luma',
  }
}
