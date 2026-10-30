import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FIN_NEUTRAL_CATS, FIN_CAT_LABEL } from '../../lib/crmTypes'

// ── Buchhaltung: Auswertung ───────────────────────────────────────────────────
// Zeitraum frei wählbar, Einnahmen/Ausgaben/Ergebnis, beide Seiten nach Kategorie,
// Monatsverlauf und größte Empfänger. Einlagen, Entnahmen und Umbuchungen sind
// kein Geschäftsvorfall (Svens Gesellschafterdarlehen) und zählen weder als
// Einnahme noch als Ausgabe, sie stehen nur nachrichtlich darunter (Sven 29.10.26).

export interface FinAuswertungTx {
  booked_at: string; amount: number; currency: string
  counterparty: string; reference: string; category: string | null
}

type Period = 'month' | 'lastmonth' | 'quarter' | 'lastquarter' | 'year' | 'lastyear' | 'all' | 'custom'

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function periodRange(p: Period, from: string, to: string): { from: string | null; to: string | null } {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth()
  const q = Math.floor(m / 3)
  switch (p) {
    case 'month':       return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) }
    case 'lastmonth':   return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) }
    case 'quarter':     return { from: ymd(new Date(y, q * 3, 1)), to: ymd(new Date(y, q * 3 + 3, 0)) }
    case 'lastquarter': return { from: ymd(new Date(y, q * 3 - 3, 1)), to: ymd(new Date(y, q * 3, 0)) }
    case 'year':        return { from: `${y}-01-01`, to: `${y}-12-31` }
    case 'lastyear':    return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }
    case 'custom':      return { from: from || null, to: to || null }
    default:            return { from: null, to: null }
  }
}

const fmtEur = (n: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
const fmtSigned = (n: number) => `${n < 0 ? '−' : ''}${fmtEur(Math.abs(n))}`
const fmtPct = (part: number, whole: number) =>
  whole > 0 ? `${(part / whole * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : '–'
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
// „To Loft Film GmbH" und „Loft Film GmbH" sind derselbe Empfänger
const payee = (s: string) => s.replace(/^(to|payment to|from|payment from)\s+/i, '').trim() || '–'

type Row = { key: string; sum: number; count: number }

export default function FinanzAuswertung({ txs, onCategorize, categorizing }: {
  txs: FinAuswertungTx[]
  onCategorize?: () => void
  categorizing?: boolean
}) {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>('year')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Nur EUR (Fremdwährung läuft immer über eine Umbuchung) und keine 0,00-Reservierungen
  const eurTxs = useMemo(() => txs.filter(x => x.currency === 'EUR' && Number(x.amount) !== 0), [txs])

  const data = useMemo(() => {
    const r = periodRange(period, from, to)
    const neutral = new Set<string>(FIN_NEUTRAL_CATS)
    const income = new Map<string, Row>(), expense = new Map<string, Row>(), payees = new Map<string, Row>()
    const months = new Map<string, { inc: number; exp: number }>()
    let deposits = 0, withdrawals = 0, transfers = 0, uncategorized = 0
    const bump = (m: Map<string, Row>, key: string, amount: number) => {
      const cur = m.get(key) ?? { key, sum: 0, count: 0 }
      cur.sum += amount; cur.count += 1; m.set(key, cur)
    }
    for (const x of eurTxs) {
      const day = x.booked_at.slice(0, 10)
      if ((r.from && day < r.from) || (r.to && day > r.to)) continue
      const amount = Number(x.amount)
      const cat = x.category ?? ''
      if (neutral.has(cat)) {
        if (cat === 'einlage') deposits += amount
        else if (cat === 'entnahme') withdrawals += Math.abs(amount)
        else transfers += Math.abs(amount)
        continue
      }
      if (!cat) uncategorized++
      const mo = months.get(day.slice(0, 7)) ?? { inc: 0, exp: 0 }
      if (amount > 0) { bump(income, cat || '__none__', amount); mo.inc += amount }
      else { bump(expense, cat || '__none__', -amount); bump(payees, payee(x.counterparty), -amount); mo.exp += -amount }
      months.set(day.slice(0, 7), mo)
    }
    const sorted = (m: Map<string, Row>) => Array.from(m.values()).sort((a, b) => b.sum - a.sum)
    const incomeRows = sorted(income), expenseRows = sorted(expense)
    const incomeSum = incomeRows.reduce((s, x) => s + x.sum, 0)
    const expenseSum = expenseRows.reduce((s, x) => s + x.sum, 0)
    const monthRows = Array.from(months.entries()).sort((a, b) => b[0].localeCompare(a[0]))
    return {
      incomeRows, expenseRows, incomeSum, expenseSum, result: incomeSum - expenseSum,
      monthRows, topPayees: sorted(payees).slice(0, 10),
      deposits, withdrawals, transfers, uncategorized,
      avgExpense: monthRows.length ? expenseSum / monthRows.length : 0,
      empty: incomeRows.length + expenseRows.length === 0 && deposits + withdrawals + transfers === 0,
    }
  }, [eurTxs, period, from, to])

  // Gesellschafterdarlehen über die ganze Zeit, unabhängig vom Zeitraum. Als
  // Rückzahlung zählt nur „Pay back Loan“: die 12 × 10.000 € „Transfer“ von 2024
  // waren Weiterleitungen der Sveru-Sport-Zahlungen, keine Tilgung (Sven 30.10.26).
  const loan = useMemo(() => {
    let inSum = 0, outSum = 0
    for (const x of eurTxs) {
      if (x.category === 'einlage') inSum += Number(x.amount)
      if (x.category === 'entnahme' && /loan/i.test(x.reference ?? '')) outSum += Math.abs(Number(x.amount))
    }
    return { inSum, outSum, balance: inSum - outSum }
  }, [eurTxs])

  const PERIODS: [Period, string][] = [
    ['month', t('crm.fin.pMonth', 'Dieser Monat')], ['lastmonth', t('crm.fin.pLastMonth', 'Letzter Monat')],
    ['quarter', t('crm.fin.pQuarter', 'Dieses Quartal')], ['lastquarter', t('crm.fin.pLastQuarter', 'Letztes Quartal')],
    ['year', t('crm.fin.pYear', 'Dieses Jahr')], ['lastyear', t('crm.fin.pLastYear', 'Letztes Jahr')],
    ['all', t('crm.fin.pAll', 'Alles')], ['custom', t('crm.fin.pCustom', 'Eigener Zeitraum')],
  ]
  const catLabel = (c: string) => c === '__none__' ? t('crm.fin.noCat', '❔ Ohne Kategorie') : (FIN_CAT_LABEL[c] ?? c)
  const maxMonth = Math.max(1, ...data.monthRows.map(([, v]) => Math.max(v.inc, v.exp)))

  const CatTable = ({ title, rows, sum, tone }: { title: string; rows: Row[]; sum: number; tone: 'in' | 'out' }) => (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">{title}</h3>
        <span className={`text-sm font-semibold ${tone === 'in' ? 'text-green-700' : 'text-gray-900'}`}>{tone === 'out' ? '−' : ''}{fmtEur(sum)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-400">{t('crm.fin.noneInPeriod', 'Nichts in diesem Zeitraum.')}</p>
      ) : (
        <table className="w-full"><tbody className="divide-y divide-gray-50">
          {rows.map(r => (
            <tr key={r.key}>
              <td className="px-5 py-2.5">
                <div className="text-sm text-gray-900">{catLabel(r.key)}</div>
                <div className="mt-1 h-1 rounded-full bg-gray-100 overflow-hidden max-w-[200px]">
                  <div className={`h-full rounded-full ${tone === 'in' ? 'bg-green-600/70' : 'bg-[#ff795d]'}`} style={{ width: `${sum > 0 ? r.sum / sum * 100 : 0}%` }} />
                </div>
              </td>
              <td className="px-3 py-2.5 text-right text-xs text-gray-400 whitespace-nowrap">{r.count}×</td>
              <td className="px-3 py-2.5 text-right text-sm text-gray-800 whitespace-nowrap">{fmtEur(r.sum)}</td>
              <td className="px-5 py-2.5 text-right text-xs text-gray-400 whitespace-nowrap">{fmtPct(r.sum, sum)}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  )

  const Kpi = ({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) => (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4">
      <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${tone ?? 'text-gray-900'}`}>{value}</p>
      {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 flex-wrap">
        {PERIODS.map(([id, label]) => (
          <button key={id} onClick={() => setPeriod(id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${period === id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'}`}>
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <div className="flex gap-3 items-center">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          <span className="text-gray-400">–</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </div>
      )}

      {data.empty ? (
        <p className="text-gray-400 text-center py-16">{t('crm.fin.noData', 'Keine Buchungen in diesem Zeitraum.')}</p>
      ) : (<>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label={t('crm.fin.in', 'Einnahmen')} value={fmtEur(data.incomeSum)} tone="text-green-700" />
          <Kpi label={t('crm.fin.out', 'Ausgaben')} value={fmtEur(data.expenseSum)} />
          <Kpi label={t('crm.fin.result', 'Ergebnis')} value={fmtSigned(data.result)}
            tone={data.result >= 0 ? 'text-green-700' : 'text-red-600'}
            hint={data.incomeSum > 0 ? t('crm.fin.margin', '{{pct}} vom Umsatz', { pct: fmtPct(data.result, data.incomeSum) }) : undefined} />
          <Kpi label={t('crm.fin.avgOut', 'Ausgaben je Monat')} value={fmtEur(data.avgExpense)}
            hint={t('crm.fin.avgHint', 'Durchschnitt über {{n}} Monate', { n: data.monthRows.length })} />
        </div>

        {data.uncategorized > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800 flex items-center justify-between gap-3 flex-wrap">
            <span>{t('crm.fin.uncatHint', '{{n}} Buchungen in diesem Zeitraum haben noch keine Kategorie.', { n: data.uncategorized })}</span>
            {onCategorize && (
              <button onClick={onCategorize} disabled={categorizing} className="px-3 py-1.5 rounded-lg text-sm border border-amber-300 bg-white hover:bg-amber-100 disabled:opacity-50">
                {categorizing ? '…' : `🤖 ${t('crm.fin.ai', 'KI-Kategorien')}`}
              </button>
            )}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <CatTable title={t('crm.fin.inByCat', 'Einnahmen nach Kategorie')} rows={data.incomeRows} sum={data.incomeSum} tone="in" />
          <CatTable title={t('crm.fin.outByCat', 'Ausgaben nach Kategorie')} rows={data.expenseRows} sum={data.expenseSum} tone="out" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">{t('crm.fin.byMonth', 'Monatsverlauf')}</h3>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="px-5 py-2">{t('crm.fin.month', 'Monat')}</th>
                <th className="px-3 py-2 text-right">{t('crm.fin.in', 'Einnahmen')}</th>
                <th className="px-3 py-2 text-right">{t('crm.fin.out', 'Ausgaben')}</th>
                <th className="px-5 py-2 text-right">{t('crm.fin.result', 'Ergebnis')}</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {data.monthRows.map(([mo, v]) => (
                  <tr key={mo}>
                    <td className="px-5 py-2">
                      <div className="text-gray-900">{monthLabel(mo)}</div>
                      <div className="mt-1 space-y-0.5 max-w-[140px]">
                        <div className="h-1 rounded-full bg-green-600/70" style={{ width: `${v.inc / maxMonth * 100}%` }} />
                        <div className="h-1 rounded-full bg-[#ff795d]" style={{ width: `${v.exp / maxMonth * 100}%` }} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-green-700 whitespace-nowrap">{v.inc ? fmtEur(v.inc) : '–'}</td>
                    <td className="px-3 py-2 text-right text-gray-800 whitespace-nowrap">{v.exp ? fmtEur(v.exp) : '–'}</td>
                    <td className={`px-5 py-2 text-right font-semibold whitespace-nowrap ${v.inc - v.exp >= 0 ? 'text-green-700' : 'text-red-600'}`}>{fmtSigned(v.inc - v.exp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">{t('crm.fin.topPayees', 'Größte Ausgaben nach Empfänger')}</h3>
            </div>
            {data.topPayees.length === 0 ? (
              <p className="px-5 py-6 text-sm text-gray-400">{t('crm.fin.noneInPeriod', 'Nichts in diesem Zeitraum.')}</p>
            ) : (
              <table className="w-full text-sm"><tbody className="divide-y divide-gray-50">
                {data.topPayees.map(r => (
                  <tr key={r.key}>
                    <td className="px-5 py-2 text-gray-900">{r.key}</td>
                    <td className="px-3 py-2 text-right text-xs text-gray-400 whitespace-nowrap">{r.count}×</td>
                    <td className="px-3 py-2 text-right text-gray-800 whitespace-nowrap">{fmtEur(r.sum)}</td>
                    <td className="px-5 py-2 text-right text-xs text-gray-400 whitespace-nowrap">{fmtPct(r.sum, data.expenseSum)}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        </div>
      </>)}

      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-sm text-gray-600 space-y-2">
        <p className="font-semibold text-gray-900">{t('crm.fin.neutralTitle', 'Nicht als Einnahme oder Ausgabe gezählt')}</p>
        {(data.deposits > 0 || data.withdrawals > 0 || data.transfers > 0) && (
          <ul className="space-y-0.5">
            {data.deposits > 0 && <li>{t('crm.fin.nDeposits', 'Deine Einlagen im Zeitraum: {{sum}} (Darlehen an die Firma, kein Umsatz)', { sum: fmtEur(data.deposits) })}</li>}
            {data.withdrawals > 0 && <li>{t('crm.fin.nWithdrawals', 'Überweisungen an dich im Zeitraum: {{sum}} (keine Betriebsausgabe)', { sum: fmtEur(data.withdrawals) })}</li>}
            {data.transfers > 0 && <li>{t('crm.fin.nTransfers', 'Umbuchungen im Zeitraum: {{sum}} (Devisentausch zwischen eigenen Konten)', { sum: fmtEur(data.transfers) })}</li>}
          </ul>
        )}
        <p>
          {t('crm.fin.loanTotal', 'Gesellschafterdarlehen gesamt: {{in}} eingelegt, {{out}} zurückgezahlt.', { in: fmtEur(loan.inSum), out: fmtEur(loan.outSum) })}{' '}
          <span className="font-semibold text-gray-900">
            {loan.balance >= 0
              ? t('crm.fin.loanOpen', 'Die Firma schuldet dir noch {{sum}}.', { sum: fmtEur(loan.balance) })
              : t('crm.fin.loanOver', 'Mehr zurückgezahlt als eingelegt: {{sum}}.', { sum: fmtEur(-loan.balance) })}
          </span>
        </p>
      </div>
    </div>
  )
}
