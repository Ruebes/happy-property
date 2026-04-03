/**
 * Locale-aware date & currency formatters for Happy Property.
 *
 * Usage:
 *   const { fmtDate, fmtDateLong, fmtCurrency } = useDateFormat()
 *
 * fmtDate('2026-03-26')        → DE: "26.03.2026"  |  EN: "03/26/2026"
 * fmtDateLong('2026-03-26')    → DE: "26. März 2026" | EN: "March 26, 2026"
 * fmtCurrency(1250)            → DE: "1.250,00 €"  |  EN: "€1,250.00"
 */

import { useTranslation } from 'react-i18next'

// ── Statische Formatter (außerhalb von React, z. B. in Scripts) ────────────
export function createFormatters(language: string) {
  const locale: string = language.startsWith('de') ? 'de-DE' : 'en-US'

  /**
   * Kurzes Datum: DE → 26.03.2026 | EN → 03/26/2026
   */
  function fmtDate(value: string | Date | null | undefined): string {
    if (!value) return '—'
    const d = typeof value === 'string' ? new Date(value) : value
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString(locale, {
      day:   '2-digit',
      month: '2-digit',
      year:  'numeric',
    })
  }

  /**
   * Langes Datum: DE → 26. März 2026 | EN → March 26, 2026
   */
  function fmtDateLong(value: string | Date | null | undefined): string {
    if (!value) return '—'
    const d = typeof value === 'string' ? new Date(value) : value
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString(locale, {
      day:   'numeric',
      month: 'long',
      year:  'numeric',
    })
  }

  /**
   * Monat + Jahr: DE → März 2026 | EN → March 2026
   */
  function fmtMonthYear(value: string | Date | null | undefined): string {
    if (!value) return '—'
    const d = typeof value === 'string' ? new Date(value) : value
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  }

  /**
   * Währungsbetrag: DE → 1.250,00 € | EN → €1,250.00
   */
  function fmtCurrency(
    amount: number | null | undefined,
    currency = 'EUR',
  ): string {
    if (amount == null) return '—'
    return new Intl.NumberFormat(locale, {
      style:    'currency',
      currency,
    }).format(amount)
  }

  /**
   * Zahl mit Tausender-Trennzeichen: DE → 1.250,50 | EN → 1,250.50
   */
  function fmtNumber(value: number | null | undefined, decimals = 2): string {
    if (value == null) return '—'
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)
  }

  /**
   * Nächte zwischen zwei Daten
   */
  function calcNights(checkIn: string, checkOut: string): number {
    const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  }

  return { fmtDate, fmtDateLong, fmtMonthYear, fmtCurrency, fmtNumber, calcNights, locale }
}

// ── React-Hook (nutzt aktuelle i18n-Sprache) ───────────────────────────────
export function useDateFormat() {
  const { i18n } = useTranslation()
  return createFormatters(i18n.language)
}
