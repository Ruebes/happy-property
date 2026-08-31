// Kaufpreise: EIN Ort, an dem aus Netto + MwSt der Bruttopreis wird.
//
// Bauträger-Preislisten sind Nettolisten ("prices do not include VAT"), und
// price_gross ist nur gefüllt, wenn die Liste den Bruttopreis ausdrücklich
// ausweist. Vorher zeigten Deck, Rechner, Wohnungs-Popup, Reservierungsmail und
// Portal deshalb den NETTOpreis als Kaufpreis. Kunden zahlen aber brutto.
//
// Regel: gepflegter Bruttopreis gewinnt (verhandelt/aus der Liste), sonst
// Netto + MwSt-Satz der Wohnung (Standard 19 %, ermäßigt 5 % bei Erstwohnsitz).

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

/** MwSt-Betrag der Wohnung (Brutto − Netto), null wenn kein Preis hinterlegt. */
export function unitVatAmount(u: PricedUnit | null | undefined): number | null {
  const gross = unitGross(u), net = unitNet(u)
  if (gross == null || net == null) return null
  return Math.round(gross - net)
}
