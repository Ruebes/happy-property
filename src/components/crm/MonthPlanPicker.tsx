import { useTranslation } from 'react-i18next'
import { MONTH_PLAN_ALL_LET, monthBreakdown, monthPlanCounts, type MonthPlan, type MonthUse } from '../../lib/rechner'
import { formatMonthRanges, monthName, monthsWithUse } from '../../lib/monthPlan'

// ── Monatskalender Mischnutzung ──────────────────────────────────────────────
// Zwoelf Chips, Klick wechselt: vermietet ↔ Selbstnutzung. Nur die Monate, in
// denen der Eigentuemer selbst dort wohnt, fallen raus - welche auch immer es
// sind (Sven 16.9.); alle anderen bleiben vermietet. Dazu Kurzfassung (welche
// Monate, MwSt-Anteil) und - wenn ein Saisonmodell gesetzt ist - die
// Monatstabelle. Eigenstaendige Komponente auf Modulebene (keine
// Inline-Komponente im Wizard, sonst Remount pro Render). Der Zustand 'empty'
// bleibt in der Engine erhalten, wird aber nicht mehr angeboten.

const NEXT: Record<MonthUse, MonthUse> = { let: 'self', self: 'let', empty: 'let' }

type Props = {
  value: MonthPlan | null
  onChange: (plan: MonthPlan) => void
  season?: { totalOcc: number; adrHigh: number } | null
  compact?: boolean
}

export function MonthPlanPicker({ value, onChange, season, compact }: Props) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const plan = value ?? MONTH_PLAN_ALL_LET
  const counts = monthPlanCounts(plan)
  const selfMonths = monthsWithUse(plan, 'self')
  const emptyMonths = monthsWithUse(plan, 'empty')
  const joiner = t('monthPlan.rangeJoiner', 'bis')
  const vatShare = Math.round((12 - counts.self) / 12 * 1000) / 10
  const setMonth = (m: number, use: MonthUse) => { const n = [...plan] as MonthPlan; n[m - 1] = use; onChange(n) }
  const chip = (use: MonthUse) => use === 'self'
    ? 'bg-orange-500 border-orange-500 text-white'
    : use === 'empty'
      ? 'bg-gray-100 border-gray-200 text-gray-400 line-through'
      : 'bg-white border-gray-200 text-gray-700 hover:border-orange-300'
  const seasonOn = !!season && season.totalOcc > 0 && season.adrHigh > 0
  const sz = compact ? 'text-[11px] px-2 py-1' : 'text-xs px-2.5 py-1.5'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {plan.map((use, i) => (
          <button key={i} type="button" title={t('monthPlan.clickHint2', 'Klick wechselt: vermietet / Selbstnutzung')}
            onClick={() => setMonth(i + 1, NEXT[use])}
            className={`${sz} rounded-lg border font-medium transition-colors ${chip(use)}`}>
            {monthName(i + 1, lang, 'short')}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-white border border-gray-300" /> {t('monthPlan.legendLet', 'vermietet')}</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-orange-500" /> {t('monthPlan.legendSelf', 'Selbstnutzung')}</span>
        {counts.empty > 0 && <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-200" /> {t('monthPlan.legendEmpty', 'nicht vermietet')}</span>}
        {(counts.self > 0 || counts.empty > 0) && (
          <button type="button" onClick={() => onChange([...MONTH_PLAN_ALL_LET] as MonthPlan)} className="px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:border-orange-300">
            {t('monthPlan.reset', 'Alle vermieten')}
          </button>
        )}
      </div>
      <p className="text-[11px] text-gray-600">
        {counts.self > 0
          ? t('monthPlan.summarySelf', 'Selbstnutzung {{n}} Mon. ({{months}})', { n: counts.self, months: formatMonthRanges(selfMonths, lang, joiner, 'short') })
          : t('monthPlan.summaryNoSelf', 'Keine Selbstnutzung markiert - bitte die Monate anklicken, in denen der Käufer selbst dort wohnt.')}
        {counts.empty > 0 && ' · ' + t('monthPlan.summaryEmpty', 'nicht vermietet {{n}} Mon. ({{months}})', { n: counts.empty, months: formatMonthRanges(emptyMonths, lang, joiner, 'short') })}
        {' · ' + t('monthPlan.summaryLet', 'vermietet {{n}} Mon.', { n: counts.let })}
        {' · ' + t('monthPlan.summaryVat', 'MwSt-Erstattung {{share}} %', { share: vatShare.toLocaleString(lang) })}
      </p>
      {counts.empty > 0 && (
        <p className="text-[11px] text-gray-400">{t('monthPlan.emptyHint', 'Nicht vermietete Monate bringen keine Miete, mindern die MwSt-Erstattung aber nicht (die Wohnung bleibt der Vermietung gewidmet).')}</p>
      )}
      {seasonOn && <MonthPlanTable plan={plan} season={season!} />}
    </div>
  )
}

// Monatstabelle des Saisonmodells fuer EINEN Kalender + EIN Objekt (Auslastung,
// Preis/Nacht): zeigt, welche Naechte und Einnahmen die Engine je Monat rechnet.
export function MonthPlanTable({ plan, season }: { plan: MonthPlan | null; season: { totalOcc: number; adrHigh: number } }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const rows = monthBreakdown(season, plan ?? MONTH_PLAN_ALL_LET)
  const totalRent = rows.reduce((a, r) => a + r.revenue, 0)
  const totalNights = rows.reduce((a, r) => a + r.nights, 0)
  const fullRent = monthBreakdown(season, null).reduce((a, r) => a + r.revenue, 0)
  return (
    <div className="overflow-x-auto rounded-lg border border-orange-100 bg-white">
      <table className="w-full text-[11px]">
        <thead className="text-gray-500">
          <tr className="border-b border-gray-100">
            <th className="py-1 px-2 text-left font-medium">{t('monthPlan.colMonth', 'Monat')}</th>
            <th className="py-1 px-2 text-left font-medium">{t('monthPlan.colUse', 'Nutzung')}</th>
            <th className="py-1 px-2 text-right font-medium">{t('monthPlan.colOcc', 'Auslastung')}</th>
            <th className="py-1 px-2 text-right font-medium">{t('monthPlan.colNights', 'Nächte')}</th>
            <th className="py-1 px-2 text-right font-medium">€/{t('monthPlan.colNight', 'Nacht')}</th>
            <th className="py-1 px-2 text-right font-medium">{t('monthPlan.colRevenue', 'Einnahmen')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.month} className={`border-b border-gray-50 ${r.use === 'self' ? 'bg-orange-50/60' : r.use === 'empty' ? 'text-gray-400' : ''}`}>
              <td className="py-1 px-2 font-medium">{monthName(r.month, lang, 'short')}</td>
              <td className="py-1 px-2">{r.use === 'self' ? t('monthPlan.legendSelf', 'Selbstnutzung') : r.use === 'empty' ? t('monthPlan.legendEmpty', 'nicht vermietet') : t('monthPlan.legendLet', 'vermietet')}</td>
              <td className="py-1 px-2 text-right">{r.use === 'let' ? `${r.occPct.toLocaleString(lang)} %` : '-'}</td>
              <td className="py-1 px-2 text-right">{r.use === 'let' ? r.nights : '-'}</td>
              <td className="py-1 px-2 text-right">{r.use === 'let' ? r.adr.toLocaleString(lang) : '-'}</td>
              <td className="py-1 px-2 text-right">{r.use === 'let' ? r.revenue.toLocaleString(lang) + ' €' : '-'}</td>
            </tr>
          ))}
          <tr className="font-semibold bg-gray-50">
            <td className="py-1 px-2" colSpan={3}>{t('monthPlan.total', 'Gesamt (Jahr 1)')}</td>
            <td className="py-1 px-2 text-right">{totalNights}</td>
            <td className="py-1 px-2" />
            <td className="py-1 px-2 text-right">{totalRent.toLocaleString(lang)} €</td>
          </tr>
        </tbody>
      </table>
      {fullRent > totalRent && (
        <p className="px-2 py-1 text-[11px] text-gray-400">{t('monthPlan.vsFull', 'Ohne Selbstnutzung bei gleicher Auslastung: {{rent}} €', { rent: fullRent.toLocaleString(lang) })}</p>
      )}
    </div>
  )
}
