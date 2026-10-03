import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useWerbeFormat } from './format'

// ── Formularbausteine für Meta-Einstellungen (Werbemanager) ──────────────────
// Felder, Geld-/Zeit-Umrechnung und der EUR-Hinweis neben Dollar-Eingaben.
// Gemeinsam für die Einstellungen-Maske und den Kampagnen-Assistenten.

export const INPUT_CLS = 'mt-0.5 w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-gray-50'

/** Kleiner Haupt-Knopf (Navy) für Zeilen und Karten, z.B. „Speichern" */
export const BTN_KLEIN = 'hp-btn hp-btn-primary min-h-0 sm:min-h-0 px-3 py-1 text-xs font-semibold'
/** Wie BTN_KLEIN, etwas größer (Freigeben, Anwenden) */
export const BTN_KLEIN_BREIT = 'hp-btn hp-btn-primary min-h-0 sm:min-h-0 px-4 py-1.5 text-xs font-semibold'

// Bewusst div statt label: einige Felder enthalten CustomSelect (ein <button>),
// und ein <label> um ein klickbares Element herum leitet Klicks weiter, das
// führt beim Aufklappen zu Doppel-Toggles.
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="block">
      <span className="text-[11px] text-gray-500">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-gray-400 mt-0.5">{hint}</span>}
    </div>
  )
}

/** Von Meta nach dem Anlegen gesperrte Felder: anzeigen, aber klar als fix markieren. */
export function LockedField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[11px] text-gray-500">🔒 {label}</span>
      <p className="mt-0.5 text-xs text-gray-700 px-2 py-1 rounded-lg bg-gray-50 border border-gray-100 truncate" title={value}>{value}</p>
    </div>
  )
}

// Geldfelder kommen von Meta in Cent, werden aber in Dollar bearbeitet.
export const MONEY_FIELDS = new Set(['daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount'])
export const TIME_FIELDS = new Set(['start_time', 'stop_time', 'end_time'])

// Auswahllisten für die bearbeitbaren Meta-Enums
export const BID_STRATEGY_OPTIONS = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP']
export const OPTIMIZATION_OPTIONS = ['OFFSITE_CONVERSIONS', 'LEAD_GENERATION', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'REACH', 'IMPRESSIONS']

/** ISO-Zeitstempel -> Wert für <input type="datetime-local"> (lokale Zeit). */
export const toLocalInput = (iso: unknown): string => {
  if (!iso) return ''
  const d = new Date(String(iso))
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Anzeigewert eines Meta-Feldes: Geld in Dollar (statt Cent), Zeit lokal. */
export const metaFeldWert = (field: string, metaValue: unknown): string => {
  if (metaValue == null) return ''
  if (MONEY_FIELDS.has(field)) return String(Number(metaValue) / 100)
  if (TIME_FIELDS.has(field)) return toLocalInput(metaValue)
  return String(metaValue)
}

/** Dollar-Eingabe ("12,50") -> Zahl, null wenn leer oder ungültig */
export const parseDollar = (value: string): number | null => {
  const v = parseFloat(value.replace(',', '.'))
  return Number.isFinite(v) ? v : null
}

/** Offene Eingaben einer Entität -> Meta-Patch. Leere Felder werden
 *  übersprungen, Geld Dollar -> Cent, Zeit -> ISO. 'invalidAmount' bei
 *  ungültigem oder nicht positivem Betrag. */
export function baueMetaPatch(raw: Record<string, string>): { patch: Record<string, unknown> } | { fehler: 'invalidAmount' } {
  const patch: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(raw)) {
    if (value === '') continue
    if (MONEY_FIELDS.has(field)) {
      const v = parseFloat(value.replace(',', '.'))
      if (!Number.isFinite(v) || v <= 0) return { fehler: 'invalidAmount' }
      patch[field] = Math.round(v * 100)          // Dollar -> Cent
    } else if (TIME_FIELDS.has(field)) {
      patch[field] = new Date(value).toISOString()
    } else {
      patch[field] = value
    }
  }
  return { patch }
}

/** Ersatzkurs, wenn aus den Tageswerten keiner ermittelt werden kann (USD je EUR) */
export const USD_PRO_EUR_FALLBACK = 1.14

/** Euro-Gegenwert neben einer Dollar-Eingabe. Das Werbekonto rechnet in USD,
 *  Kennzahlen und Leitplanken stehen in EUR: der Hinweis macht das sichtbar.
 *  kurs = USD je EUR (Schnitt der letzten 7 Tage), null = Ersatzkurs. */
export function UsdEurHinweis({ usd, kurs }: { usd: string; kurs: number | null }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const v = parseDollar(usd)
  if (v == null || v <= 0) return null
  const gemessen = kurs != null && kurs > 0
  const k = gemessen ? kurs : USD_PRO_EUR_FALLBACK
  const kursTxt = k.toLocaleString(fmt.locale, { maximumFractionDigits: 3 })
  return (
    <span className="block text-[10px] text-gray-500 mt-0.5 tabular-nums"
      title={gemessen
        ? t('crm.werbung.common.usdEurKurs', 'Umgerechnet mit 1 € = {{kurs}} $ (Schnitt der letzten 7 Tage)', { kurs: kursTxt })
        : t('crm.werbung.common.usdEurErsatz', 'Umgerechnet mit dem Ersatzkurs 1 € = {{kurs}} $', { kurs: kursTxt })}>
      {t('crm.werbung.common.usdEurHinweis', '≈ {{eur}}', { eur: fmt.eur(v / k) })}
    </span>
  )
}
