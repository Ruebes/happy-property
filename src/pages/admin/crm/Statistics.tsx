import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'

interface DeveloperStat {
  developer: string
  deals: number
  totalCommission: number
  paidCommission: number
}

type Period = 'week' | 'month' | 'year' | 'lastyear' | 'all' | 'custom'

function getPeriodRange(period: Period, customFrom: string, customTo: string): { from: string | null; to: string | null } {
  const now = new Date()
  if (period === 'all') return { from: null, to: null }
  if (period === 'custom') return { from: customFrom || null, to: customTo || null }

  const to = now.toISOString().slice(0, 10)

  if (period === 'week') {
    const d = new Date(now)
    d.setDate(d.getDate() - 7)
    return { from: d.toISOString().slice(0, 10), to }
  }
  if (period === 'month') {
    return { from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, to }
  }
  if (period === 'year') {
    return { from: `${now.getFullYear()}-01-01`, to }
  }
  if (period === 'lastyear') {
    const y = now.getFullYear() - 1
    return { from: `${y}-01-01`, to: `${y}-12-31` }
  }
  return { from: null, to: null }
}

export default function Statistics() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>('year')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [stats, setStats] = useState<DeveloperStat[]>([])
  const [loading, setLoading] = useState(true)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = getPeriodRange(period, customFrom, customTo)

      let query = supabase
        .from('deals')
        .select('developer, commission_amount, commission_paid_at, created_at')
        .neq('phase', 'archiviert')

      if (from) query = query.gte('created_at', from)
      if (to)   query = query.lte('created_at', to + 'T23:59:59')

      const { data } = await query
      const rows = data ?? []

      // Group by developer
      const map = new Map<string, DeveloperStat>()
      rows.forEach((row: { developer: string | null; commission_amount: number | null; commission_paid_at: string | null }) => {
        const dev = row.developer ?? '(Kein Developer)'
        const stat = map.get(dev) ?? { developer: dev, deals: 0, totalCommission: 0, paidCommission: 0 }
        stat.deals++
        stat.totalCommission += row.commission_amount ?? 0
        if (row.commission_paid_at) stat.paidCommission += row.commission_amount ?? 0
        map.set(dev, stat)
      })

      setStats(Array.from(map.values()).sort((a, b) => b.totalCommission - a.totalCommission))
    } finally {
      setLoading(false)
    }
  }, [period, customFrom, customTo])

  useEffect(() => { fetchStats() }, [fetchStats])

  const fmt = (n: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)

  const totals = stats.reduce((acc, s) => ({
    deals: acc.deals + s.deals,
    totalCommission: acc.totalCommission + s.totalCommission,
    paidCommission: acc.paidCommission + s.paidCommission,
  }), { deals: 0, totalCommission: 0, paidCommission: 0 })

  const PERIODS: { id: Period; label: string }[] = [
    { id: 'week',     label: t('stats.period.week', 'Diese Woche') },
    { id: 'month',    label: t('stats.period.month', 'Dieser Monat') },
    { id: 'year',     label: t('stats.period.year', 'Dieses Jahr') },
    { id: 'lastyear', label: t('stats.period.lastyear', 'Letztes Jahr') },
    { id: 'all',      label: t('stats.period.all', 'Alle Zeit') },
    { id: 'custom',   label: t('stats.period.custom', 'Benutzerdefiniert') },
  ]

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('stats.title', 'Statistiken')}</h1>

        {/* Period selector */}
        <div className="flex gap-2 flex-wrap">
          {PERIODS.map(p => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors"
              style={period === p.id
                ? { backgroundColor: '#ff795d', color: '#fff', borderColor: '#ff795d' }
                : { backgroundColor: '#fff', color: '#374151', borderColor: '#d1d5db' }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {period === 'custom' && (
          <div className="flex gap-3 items-center">
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
            <span className="text-gray-400">–</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : stats.length === 0 ? (
          <p className="text-gray-400 text-center py-16">{t('stats.noData', 'Keine Daten für diesen Zeitraum.')}</p>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('stats.developer', 'Developer')}</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{t('stats.deals', 'Deals')}</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{t('stats.totalCommission', 'Provision gesamt')}</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{t('stats.paidCommission', 'Provision erhalten')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {stats.map(s => (
                  <tr key={s.developer} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-gray-900">{s.developer}</td>
                    <td className="px-5 py-3 text-right text-gray-700">{s.deals}</td>
                    <td className="px-5 py-3 text-right text-gray-700">{s.totalCommission > 0 ? fmt(s.totalCommission) : '–'}</td>
                    <td className="px-5 py-3 text-right">
                      <span className={s.paidCommission > 0 ? 'text-green-600 font-medium' : 'text-gray-400'}>
                        {s.paidCommission > 0 ? fmt(s.paidCommission) : '–'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                <tr>
                  <td className="px-5 py-3 font-semibold text-gray-900">{t('stats.total', 'Gesamt')}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-900">{totals.deals}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-900">{totals.totalCommission > 0 ? fmt(totals.totalCommission) : '–'}</td>
                  <td className="px-5 py-3 text-right font-semibold text-green-600">{totals.paidCommission > 0 ? fmt(totals.paidCommission) : '–'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
