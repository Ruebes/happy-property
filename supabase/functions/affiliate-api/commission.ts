// Tippgeber-Provision: fester Betrag oder Prozent unserer Netto-Provision (Sven 5.11.2026).
// Reine Rechnung ohne Datenbank, geprüft mit scripts/verify-tippgeber-prozent.mjs.

export interface BaseDeal { id: string; phase: string | null; archived_from_phase: string | null; commission_amount: number | null }
export interface BaseInvoice { deal_id: string; subtotal_net: number | null }
export interface Commission { amount: number; percent: number | null; base: number | null }

const round2 = (n: number) => Math.round(n * 100) / 100

/** Prozent auf den Cent, kaufmännisch gerundet. Rechnet in ganzen Cent, damit keine Gleitkomma-Reste entstehen. */
export function percentOf(base: number, percent: number): number {
  return Math.round(Math.round(base * 100) * Math.round(percent * 100) / 10000) / 100
}

export const percentLabel = (p: number) => `${p.toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`

/** Eingabe wie „7,5“, „7.5“ oder „7,5 %“. Gültig ist nur 0,01 bis 100, sonst null. */
export function parsePercent(raw: unknown): number | null {
  const n = Number(String(raw ?? '').replace('%', '').trim().replace(',', '.'))
  if (!Number.isFinite(n)) return null
  const p = round2(n)
  return p > 0 && p <= 100 ? p : null
}

/** Deal gilt als abgeschlossen, wenn unsere Provision geflossen ist (Svens Definition von „verkauft“). */
export const isDoneDeal = (d: BaseDeal) =>
  d.phase === 'provision_erhalten' || (d.phase === 'archiviert' && d.archived_from_phase === 'provision_erhalten')

/** Unsere Netto-Provision aus den abgeschlossenen Deals des Kunden, ohne solche der laufende Deal
 *  (nur als Vorschau, ausgezahlt wird erst nach Abschluss). Wie in der Statistik: Summe der
 *  Rechnungen netto, sonst der Betrag am Deal. `invoices` enthält keine stornierten und keine Entwürfe. */
export function commissionBase(deals: BaseDeal[], invoices: BaseInvoice[]): number | null {
  const done = deals.filter(isDoneDeal)
  const pick = done.length ? done : deals.filter(d => d.phase !== 'archiviert')
  let total = 0
  for (const d of pick) {
    const invoiced = invoices.filter(i => i.deal_id === d.id).reduce((sum, i) => sum + (Number(i.subtotal_net) || 0), 0)
    total += invoiced > 0 ? invoiced : Number(d.commission_amount) || 0
  }
  return total > 0 ? round2(total) : null
}

/** Auszuzahlender Betrag. null = Prozent vereinbart, aber keine Basis bekannt: nie raten, sondern warten. */
export function resolveCommission(fixed: number | null, percent: number | null, base: number | null, standard: number): Commission | null {
  if (percent != null && Number(percent) > 0) {
    if (base == null || !(Number(base) > 0)) return null
    const amount = percentOf(Number(base), Number(percent))
    return amount > 0 ? { amount, percent: Number(percent), base: Number(base) } : null
  }
  return { amount: fixed != null && Number(fixed) > 0 ? Number(fixed) : standard, percent: null, base: null }
}
