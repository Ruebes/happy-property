// Kaufpreise: EIN Ort, an dem aus Netto + MwSt der Bruttopreis wird.
// Deno-Zwilling von src/lib/price.ts — gleiche Regel, damit CRM-Oberfläche und
// automatische Nachrichten denselben Kaufpreis nennen.
//
// Bauträger-Preislisten sind Nettolisten; price_gross ist nur gefüllt, wenn die
// Liste den Bruttopreis ausdrücklich ausweist. Ohne diese Regel stand in der
// Reservierungsmail an den Bauträger der NETTOpreis als „Price".

export const DEFAULT_VAT_RATE = 19

export interface PricedUnit {
  price_net?:   number | null
  price_gross?: number | null
  vat_rate?:    number | null
}

/** Netto + MwSt, auf ganze Euro gerundet. */
export function withVat(net: number | null | undefined, vatRate?: number | null): number | null {
  if (net == null) return null
  const rate = vatRate ?? DEFAULT_VAT_RATE
  return Math.round(net * (1 + rate / 100))
}

/** Nettopreis einer Wohnung — der Preis, der ausgewiesen wird. Ist nur ein
 *  Bruttopreis gepflegt, wird die MwSt herausgerechnet. */
export function unitNet(u: PricedUnit | null | undefined): number | null {
  if (!u) return null
  if (u.price_net != null) return u.price_net
  if (u.price_gross == null) return null
  const rate = u.vat_rate ?? DEFAULT_VAT_RATE
  return Math.round(u.price_gross / (1 + rate / 100))
}

/** Bruttopreis einer Wohnung — gepflegter Wert, sonst aus Netto + MwSt errechnet. */
export function unitGross(u: PricedUnit | null | undefined): number | null {
  if (!u) return null
  if (u.price_gross != null) return u.price_gross
  return withVat(u.price_net, u.vat_rate)
}
