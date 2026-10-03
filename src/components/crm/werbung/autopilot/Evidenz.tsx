import { useTranslation } from 'react-i18next'
import { useWerbeFormat } from '../format'
import type { WerbeEvidenz } from '../../../../lib/werbungTypes'
import { USD_JE_EUR_ERSATZ, evidenzWerte, usdAusCents, zahl } from './werbeTexte'

// ── Begründung und Vorher -> Nachher eines Vorschlags ────────────────────────
// Gemeinsam für Vorschläge, Schatten-Log, Verlauf und die Freigabe-Seite.

/** Kleine Kennzahl: Beschriftung über dem Wert */
function Wert({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11px] text-gray-500">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-hp-navy">{value}</dd>
    </div>
  )
}

/** Fenster, Ausgaben, TE, Kosten pro TE, Chance gut / Risiko schlecht, Frequenz, Abdeckung */
export function EvidenzLeiste({ evidence, kompakt = false }: { evidence: WerbeEvidenz | null | undefined; kompakt?: boolean }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const w = evidenzWerte(evidence)
  const te = (v: number) => v.toLocaleString(fmt.locale, { maximumFractionDigits: 2 })
  const teile: Array<{ label: string; value: string; title?: string }> = []
  if (w.fenster != null) {
    teile.push({
      label: t('crm.werbung.autopilot.ev.fenster', 'Zeitraum'),
      value: w.fenster === 0
        ? t('crm.werbung.autopilot.ev.lebenszeit', 'Lebenszeit')
        : t('crm.werbung.autopilot.ev.tage', '{{n}} Tage', { n: w.fenster }),
    })
  }
  if (w.spend != null) teile.push({ label: t('crm.werbung.autopilot.ev.ausgaben', 'Ausgaben'), value: fmt.eur(w.spend) })
  if (w.te != null) teile.push({ label: t('crm.werbung.autopilot.ev.te', 'TE'), value: te(w.te), title: t('crm.werbung.autopilot.ev.teTitel', 'Termin-Äquivalente') })
  if (w.cpte != null) teile.push({ label: t('crm.werbung.autopilot.ev.cpte', 'Kosten pro TE'), value: fmt.eur(w.cpte) })
  if (w.pGood != null) teile.push({ label: t('crm.werbung.autopilot.ev.pGood', 'Chance gut'), value: fmt.pct(w.pGood), title: t('crm.werbung.autopilot.ev.pGoodTitel', 'Wahrscheinlichkeit, dass die Kosten pro TE unter dem Ziel liegen') })
  if (w.pBad != null) teile.push({ label: t('crm.werbung.autopilot.ev.pBad', 'Risiko schlecht'), value: fmt.pct(w.pBad), title: t('crm.werbung.autopilot.ev.pBadTitel', 'Wahrscheinlichkeit, dass die Kosten pro TE über dem Doppelten des Ziels liegen') })
  if (w.freq != null) teile.push({ label: t('crm.werbung.autopilot.ev.frequenz', 'Frequenz 7 Tage'), value: w.freq.toLocaleString(fmt.locale, { maximumFractionDigits: 2 }) })
  if (w.coverage != null) teile.push({ label: t('crm.werbung.autopilot.ev.abdeckung', 'Zuordnung'), value: fmt.pct(w.coverage), title: t('crm.werbung.autopilot.ev.abdeckungTitel', 'Anteil der Leads, die einer Anzeige zugeordnet sind') })
  if (!teile.length) return null
  return (
    <dl className={`grid gap-x-4 gap-y-2 ${kompakt ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-8'}`}>
      {teile.map(x => <Wert key={x.label} {...x} />)}
    </dl>
  )
}

/** Ein Zustand (before/after) als Text: Budget in $ und €, sonst Status */
function zustandText(
  z: Record<string, unknown> | null | undefined,
  usdJeEur: number,
  locale: string,
  eur: (v: number) => string,
  statusText: (s: string) => string,
): string {
  if (!z) return '-'
  const cents = zahl(z.daily_budget_cents) ?? zahl(z.daily_budget)
  if (cents != null) {
    const eurWert = zahl(z.daily_budget_eur) ?? cents / 100 / usdJeEur
    return `${usdAusCents(cents, locale)} (≈ ${eur(eurWert)})`
  }
  const status = z.status ?? z.effective_status ?? z.pool_status
  if (typeof status === 'string' && status) return statusText(status)
  const teile = Object.entries(z).filter(([, v]) => v != null && typeof v !== 'object').slice(0, 3)
  return teile.length ? teile.map(([k, v]) => `${k}: ${String(v)}`).join(', ') : '-'
}

/** Vorher -> Nachher in einer Zeile (Budget in $ und €) */
export function VorherNachher({ before, after, fx }: {
  before: Record<string, unknown> | null | undefined
  after: Record<string, unknown> | null | undefined
  fx?: number | null
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const kurs = fx && fx > 0.5 && fx < 2 ? fx : USD_JE_EUR_ERSATZ
  const statusText = (s: string) => {
    const u = s.toUpperCase()
    if (u === 'PAUSED') return t('crm.werbung.autopilot.zustand.pausiert', 'Pausiert')
    if (u === 'ACTIVE') return t('crm.werbung.autopilot.zustand.aktiv', 'Aktiv')
    return s
  }
  const vorher = zustandText(before, kurs, fmt.locale, fmt.eur, statusText)
  const nachher = zustandText(after, kurs, fmt.locale, fmt.eur, statusText)
  if (vorher === '-' && nachher === '-') return null
  return (
    <p className="text-sm font-body text-gray-800 tabular-nums">
      <span className="text-gray-500">{vorher}</span>
      <span aria-hidden="true" className="mx-1.5 text-gray-400">→</span>
      <span className="sr-only">{t('crm.werbung.autopilot.zustand.wird', 'wird zu')}</span>
      <span className="font-semibold text-hp-navy">{nachher}</span>
    </p>
  )
}
