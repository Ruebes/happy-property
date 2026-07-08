import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'

// ── Termin-Funnel-Statistik: Wo brechen Besucher auf /termin ab? ─────────────
// Datenquelle: RPC funnel_stats (aggregiert funnel_sessions + funnel_events
// serverseitig — Trichter je Schritt, Antwort-Verteilung, Quellen-Split).

interface FunnelStatsData {
  sessions: number
  bookings: number
  steps: Record<string, number>
  answers: Record<string, Array<{ answer: string; n: number }>>
  sources: Array<{ source: string; sessions: number; leads: number; bookings: number }>
}

type Period = 'week' | 'month' | 'year' | 'all' | 'custom'

// Obergrenze ist EXKLUSIV (RPC filtert started_at < p_to) → immer Folgetag 00:00 UTC,
// sonst fehlen Sessions aus der letzten Sekunde des Tages.
function getPeriodRange(period: Period, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date()
  const nextDay = (iso: string): string => {
    const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  const tomorrow = nextDay(now.toISOString().slice(0, 10))
  if (period === 'all') return { from: '2026-01-01', to: tomorrow }
  if (period === 'custom') return {
    from: (customFrom || '2026-01-01'),
    to: (customTo ? nextDay(customTo) : tomorrow),
  }
  if (period === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7)
    return { from: d.toISOString().slice(0, 10), to: tomorrow }
  }
  if (period === 'month') {
    const d = new Date(now); d.setDate(d.getDate() - 30)
    return { from: d.toISOString().slice(0, 10), to: tomorrow }
  }
  return { from: `${now.getFullYear()}-01-01`, to: tomorrow }
}

// ── Trichter-Schritte in Funnel-Reihenfolge (Keys = question_key im Tracking) ─
const STEP_ORDER: Array<{ key: string; labelKey: string; fallback: string; milestone?: boolean }> = [
  { key: 'view',              labelKey: 'crm.funnel.step.view',      fallback: 'Seite aufgerufen' },
  { key: 'start',             labelKey: 'crm.funnel.step.start',     fallback: 'Gestartet („Los geht’s")' },
  { key: 'erfahrung',         labelKey: 'crm.funnel.step.q1',        fallback: 'Frage 1 · Erfahrung' },
  { key: 'motiv',             labelKey: 'crm.funnel.step.q2',        fallback: 'Frage 2 · Motiv' },
  { key: 'timing',            labelKey: 'crm.funnel.step.q3',        fallback: 'Frage 3 · Kaufzeitpunkt' },
  { key: 'kapitalbasis',      labelKey: 'crm.funnel.step.q4',        fallback: 'Frage 4 · Kapitalbasis' },
  { key: 'beschaeftigung',    labelKey: 'crm.funnel.step.q5',        fallback: 'Frage 5 · Beschäftigung' },
  { key: 'alter',             labelKey: 'crm.funnel.step.q6',        fallback: 'Frage 6 · Alter' },
  { key: 'contact_view',      labelKey: 'crm.funnel.step.contactView', fallback: 'Kontaktformular gesehen' },
  { key: 'contact_submitted', labelKey: 'crm.funnel.step.contact',   fallback: 'Kontaktdaten abgeschickt', milestone: true },
  { key: 'meeting_type',      labelKey: 'crm.funnel.step.type',      fallback: 'Terminart gewählt' },
  { key: 'slots_view',        labelKey: 'crm.funnel.step.slots',     fallback: 'Terminauswahl gesehen' },
  { key: 'slot_picked',       labelKey: 'crm.funnel.step.picked',    fallback: 'Termin angeklickt' },
  { key: 'booked',            labelKey: 'crm.funnel.step.booked',    fallback: 'Termin gebucht', milestone: true },
]

const QUESTION_LABELS: Array<{ key: string; labelKey: string; fallback: string }> = [
  { key: 'erfahrung',      labelKey: 'crm.funnel.q.erfahrung',      fallback: 'Erfahrung' },
  { key: 'motiv',          labelKey: 'crm.funnel.q.motiv',          fallback: 'Motiv' },
  { key: 'timing',         labelKey: 'crm.funnel.q.timing',         fallback: 'Kaufzeitpunkt' },
  { key: 'kapitalbasis',   labelKey: 'crm.funnel.q.kapitalbasis',   fallback: 'Kapitalbasis (100k+)' },
  { key: 'beschaeftigung', labelKey: 'crm.funnel.q.beschaeftigung', fallback: 'Beschäftigung' },
  { key: 'alter',          labelKey: 'crm.funnel.q.alter',          fallback: 'Alter' },
  { key: 'meeting_type',   labelKey: 'crm.funnel.q.meetingType',    fallback: 'Terminart' },
]

// ── KPI-Karte ─────────────────────────────────────────────────────────────────
interface KpiCardProps { label: string; value: string; sub?: string; accent?: boolean }
function KpiCard({ label, value, sub, accent }: KpiCardProps) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-3xl font-bold mt-1" style={accent ? { color: '#ff795d' } : { color: '#111827' }}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

export default function FunnelStats() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [stats, setStats] = useState<FunnelStatsData | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = getPeriodRange(period, customFrom, customTo)
      const { data, error } = await supabase.rpc('funnel_stats', { p_from: from, p_to: to })
      if (error) throw error
      setStats((data as unknown as FunnelStatsData) ?? null)
    } catch (err) {
      console.error('[FunnelStats] fetchStats:', err)
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [period, customFrom, customTo])

  useEffect(() => { fetchStats() }, [fetchStats])

  const PERIODS: { id: Period; label: string }[] = [
    { id: 'week',   label: t('crm.funnel.period.week', 'Letzte 7 Tage') },
    { id: 'month',  label: t('crm.funnel.period.month', 'Letzte 30 Tage') },
    { id: 'year',   label: t('crm.funnel.period.year', 'Dieses Jahr') },
    { id: 'all',    label: t('crm.funnel.period.all', 'Alle Zeit') },
    { id: 'custom', label: t('crm.funnel.period.custom', 'Benutzerdefiniert') },
  ]

  const views = stats?.steps?.view ?? 0
  const leads = stats?.steps?.contact_submitted ?? 0
  const bookings = stats?.bookings ?? 0
  // 'booked' existiert NICHT als funnel_event — Buchungen zählt die RPC aus
  // funnel_sessions.completed_at (stats.bookings). Special-Case nicht entfernen.
  const stepCount = (key: string) => key === 'booked' ? bookings : (stats?.steps?.[key] ?? 0)
  const maxN = Math.max(views, 1)
  const pct = (n: number, base: number) => base > 0 ? `${Math.round((n / base) * 100)}%` : '–'

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.funnel.title', 'Termin-Funnel')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('crm.funnel.subtitle', 'Wo brechen Besucher auf /termin ab — vom Aufruf bis zur Buchung.')}</p>
        </div>

        {/* Zeitraum */}
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

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : !stats || stats.sessions === 0 ? (
          <p className="text-gray-400 text-center py-16">{t('crm.funnel.noData', 'Keine Funnel-Besuche in diesem Zeitraum.')}</p>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard label={t('crm.funnel.kpi.views', 'Aufrufe')} value={String(views)} />
              <KpiCard label={t('crm.funnel.kpi.leads', 'Leads (Kontaktdaten)')} value={String(leads)}
                sub={t('crm.funnel.kpi.ofViews', '{{p}} der Aufrufe', { p: pct(leads, views) }) as string} />
              <KpiCard label={t('crm.funnel.kpi.bookings', 'Termin-Buchungen')} value={String(bookings)}
                sub={t('crm.funnel.kpi.ofViews', '{{p}} der Aufrufe', { p: pct(bookings, views) }) as string} accent />
              <KpiCard label={t('crm.funnel.kpi.leadToBooking', 'Lead → Buchung')} value={pct(bookings, leads)}
                sub={t('crm.funnel.kpi.leadToBookingSub', 'Leads, die auch buchen') as string} />
            </div>

            {/* Trichter */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">{t('crm.funnel.funnelTitle', 'Trichter — wer kommt wie weit?')}</h2>
              <div className="space-y-1.5">
                {STEP_ORDER.map((step, i) => {
                  const n = stepCount(step.key)
                  const prev = i > 0 ? stepCount(STEP_ORDER[i - 1].key) : n
                  const lost = i > 0 ? Math.max(prev - n, 0) : 0
                  return (
                    <div key={step.key} className="flex items-center gap-3">
                      <div className={`w-52 shrink-0 text-[13px] leading-tight text-right ${step.milestone ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                        {t(step.labelKey, step.fallback)}
                      </div>
                      <div className="flex-1 bg-gray-100 rounded-full h-6 overflow-hidden relative">
                        <div className="h-6 rounded-full transition-all"
                          style={{ width: `${Math.max((n / maxN) * 100, n > 0 ? 3 : 0)}%`, backgroundColor: step.milestone ? '#ff795d' : '#1a2332' }} />
                        <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold"
                          style={{ color: (n / maxN) > 0.06 ? '#fff' : '#374151' }}>
                          {n}
                        </span>
                      </div>
                      <div className="w-14 shrink-0 text-right text-xs text-gray-500">{pct(n, views)}</div>
                      <div className="w-16 shrink-0 text-right text-xs font-medium" style={{ color: lost > 0 ? '#dc2626' : '#d1d5db' }}>
                        {lost > 0 ? `−${lost}` : ''}
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="text-[11px] text-gray-400 mt-3">{t('crm.funnel.funnelHint', 'Rote Zahl = Absprünge gegenüber dem vorherigen Schritt. Prozent = Anteil der Seitenaufrufe.')}</p>
            </div>

            {/* Antworten je Frage */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {QUESTION_LABELS.map(q => {
                const rows = stats.answers?.[q.key] ?? []
                if (!rows.length) return null
                const total = rows.reduce((s, r) => s + r.n, 0)
                return (
                  <div key={q.key} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">{t(q.labelKey, q.fallback)}</h3>
                    <div className="space-y-2">
                      {rows.map(r => (
                        <div key={r.answer} className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-gray-600 truncate" title={r.answer}>{r.answer}</p>
                            <div className="bg-gray-100 rounded-full h-2 mt-0.5 overflow-hidden">
                              <div className="h-2 rounded-full" style={{ width: `${(r.n / Math.max(total, 1)) * 100}%`, backgroundColor: '#ff795d' }} />
                            </div>
                          </div>
                          <span className="text-xs font-semibold text-gray-700 w-8 text-right shrink-0">{r.n}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Quellen */}
            {(stats.sources?.length ?? 0) > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <h2 className="text-sm font-semibold text-gray-700 px-5 pt-5">{t('crm.funnel.sourcesTitle', 'Quellen (utm_source)')}</h2>
                <table className="w-full mt-3">
                  <thead className="bg-gray-50 border-y border-gray-100">
                    <tr>
                      <th className="px-5 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.funnel.src.source', 'Quelle')}</th>
                      <th className="px-5 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase">{t('crm.funnel.src.sessions', 'Besuche')}</th>
                      <th className="px-5 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase">{t('crm.funnel.src.leads', 'Leads')}</th>
                      <th className="px-5 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase">{t('crm.funnel.src.bookings', 'Buchungen')}</th>
                      <th className="px-5 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase">{t('crm.funnel.src.conv', 'Conversion')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {stats.sources.map(s => (
                      <tr key={s.source} className="hover:bg-gray-50">
                        <td className="px-5 py-2.5 font-medium text-gray-900">{s.source}</td>
                        <td className="px-5 py-2.5 text-right text-gray-700">{s.sessions}</td>
                        <td className="px-5 py-2.5 text-right text-gray-700">{s.leads}</td>
                        <td className="px-5 py-2.5 text-right font-medium" style={{ color: s.bookings > 0 ? '#ff795d' : '#9ca3af' }}>{s.bookings}</td>
                        <td className="px-5 py-2.5 text-right text-gray-700">{pct(s.bookings, s.sessions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
