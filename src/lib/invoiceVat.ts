// Geteilte MwSt-Logik fürs Rechnungstool (Spiegel der Edge-Funktion generate-invoice).
// Zypern: Standard 19%, ermäßigt 9/5/3%, Nullsatz, Reverse-Charge (innergemeinschaftlich),
// Drittland (Export), steuerbefreit.

import type { VatTreatment, CustomerMode } from './crmTypes'

export interface VatTreatmentDef {
  value: VatTreatment
  label: string
  rate:  number
  note:  string
  group: 'cy' | 'cross'
}

export const VAT_TREATMENTS: VatTreatmentDef[] = [
  { value: 'standard_19',       label: '19% MwSt (Zypern, Standard)', rate: 19, note: '', group: 'cy' },
  { value: 'reduced_9',         label: '9% MwSt (Zypern, ermäßigt)',  rate: 9,  note: '', group: 'cy' },
  { value: 'reduced_5',         label: '5% MwSt (Zypern, ermäßigt)',  rate: 5,  note: '', group: 'cy' },
  { value: 'reduced_3',         label: '3% MwSt (Zypern, ermäßigt)',  rate: 3,  note: '', group: 'cy' },
  { value: 'zero',              label: '0% (Nullsatz)',               rate: 0,  note: 'Zero-rated supply (0% VAT).', group: 'cy' },
  { value: 'reverse_charge_eu', label: 'Innergemeinschaftlich – Reverse Charge (0%)', rate: 0,
    note: 'Reverse charge — VAT to be accounted for by the recipient (Art. 196 Directive 2006/112/EC). Steuerschuldnerschaft des Leistungsempfängers.', group: 'cross' },
  { value: 'third_country',     label: 'Drittland / Export (0%)',     rate: 0,
    note: 'Supply of services outside the scope of EU VAT (place of supply outside the EU, Art. 44 Directive 2006/112/EC).', group: 'cross' },
  { value: 'exempt',            label: 'Steuerbefreit',               rate: 0, note: 'VAT exempt.', group: 'cy' },
]

export function vatInfo(t: VatTreatment): VatTreatmentDef {
  return VAT_TREATMENTS.find(v => v.value === t) ?? VAT_TREATMENTS[0]
}

export function defaultTreatmentForMode(mode: CustomerMode | null | undefined): VatTreatment {
  if (mode === 'eu')    return 'reverse_charge_eu'
  if (mode === 'third') return 'third_country'
  return 'standard_19'
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface LineLike { quantity: number; unit_price_net: number }

export function computeTotals(items: LineLike[], rate: number): { subtotal_net: number; vat_amount: number; total_gross: number } {
  const subtotal_net = round2(items.reduce((s, it) => s + round2((it.quantity || 0) * (it.unit_price_net || 0)), 0))
  const vat_amount   = round2(subtotal_net * rate / 100)
  return { subtotal_net, vat_amount, total_gross: round2(subtotal_net + vat_amount) }
}

export const eurFmt = (n: number | null | undefined) =>
  n == null || isNaN(n) ? '–'
    : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

export const dateFmt = (d: string | Date | null | undefined) =>
  !d ? '–' : new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: 'Entwurf', sent: 'Versendet', paid: 'Bezahlt', canceled: 'Storniert',
}
