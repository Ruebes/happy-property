import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { DealPhase } from '../../../lib/crmTypes'
import { DEAL_PHASES, PHASE_ICONS } from '../../../lib/crmTypes'


interface TaskActivity {
  id: string
  subject: string | null
  content: string | null
  scheduled_at: string | null
  lead: { id: string; first_name: string; last_name: string } | null
}

interface DashboardState {
  totalLeads: number
  newThisWeek: number
  dealsPerPhase: Record<DealPhase, number>
  commissionWeek: number
  commissionMonth: number
  commissionYear: number
  openTasksToday: TaskActivity[]
  loading: boolean
}

export default function CrmDashboard() {
  const { t } = useTranslation()
  useAuth()

  const [state, setState] = useState<DashboardState>({
    totalLeads: 0,
    newThisWeek: 0,
    dealsPerPhase: {} as Record<DealPhase, number>,
    commissionWeek: 0,
    commissionMonth: 0,
    commissionYear: 0,
    openTasksToday: [],
    loading: true,
  })

  const fetchData = async () => {
    setState(prev => ({ ...prev, loading: true }))

    // Calculate time boundaries
    const now = new Date()
    const dayOfWeek = now.getDay()
    const diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek)
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() + diffToMonday)
    startOfWeek.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfYear = new Date(now.getFullYear(), 0, 1)

    try {
      const [
        totalLeadsRes,
        newThisWeekRes,
        dealsPhaseRes,
        commissionsRes,
        openTasksRes,
      ] = await Promise.all([
        supabase.from('leads').select('id', { count: 'exact', head: true }),
        supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', startOfWeek.toISOString()),
        supabase.from('deals').select('phase').neq('phase', 'archiviert'),
        supabase
          .from('deals')
          .select('commission_amount, commission_paid_at')
          .not('commission_paid_at', 'is', null),
        supabase
          .from('activities')
          .select('id, subject, content, scheduled_at, lead:leads(id, first_name, last_name)')
          .eq('type', 'task')
          .is('completed_at', null)
          .lte('scheduled_at', now.toISOString()),
      ])

      // Group deals per phase
      const dealsPerPhase = {} as Record<DealPhase, number>
      DEAL_PHASES.forEach(p => { dealsPerPhase[p] = 0 })
      ;(dealsPhaseRes.data ?? []).forEach((d: { phase: DealPhase }) => {
        if (d.phase in dealsPerPhase) dealsPerPhase[d.phase]++
      })

      // Sum commissions
      let commissionWeek = 0
      let commissionMonth = 0
      let commissionYear = 0
      ;(commissionsRes.data ?? []).forEach((d: { commission_amount: number | null; commission_paid_at: string | null }) => {
        const amount = d.commission_amount ?? 0
        const paidAt = d.commission_paid_at ? new Date(d.commission_paid_at) : null
        if (!paidAt) return
        if (paidAt >= startOfYear) commissionYear += amount
        if (paidAt >= startOfMonth) commissionMonth += amount
        if (paidAt >= startOfWeek) commissionWeek += amount
      })

      setState({
        totalLeads: totalLeadsRes.count ?? 0,
        newThisWeek: newThisWeekRes.count ?? 0,
        dealsPerPhase,
        commissionWeek,
        commissionMonth,
        commissionYear,
        openTasksToday: (openTasksRes.data ?? []) as unknown as TaskActivity[],
        loading: false,
      })
    } catch (err) {
      console.error('[CrmDashboard] fetchData:', err)
      setState(prev => ({ ...prev, loading: false }))
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const handleCompleteTask = async (taskId: string) => {
    await supabase
      .from('activities')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', taskId)
    fetchData()
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount)

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })

  const maxPhaseCount = Math.max(1, ...Object.values(state.dealsPerPhase))

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('crm.dashboard.title')}</h1>

        {/* Top stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <p className="text-sm text-gray-500">Leads gesamt</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{state.totalLeads}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <p className="text-sm text-gray-500">Neue diese Woche</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{state.newThisWeek}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <p className="text-sm text-gray-500">Provision diesen Monat</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{formatCurrency(state.commissionMonth)}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <p className="text-sm text-gray-500">Provision dieses Jahr</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{formatCurrency(state.commissionYear)}</p>
          </div>
        </div>

        {/* Deals per phase */}
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Deals pro Phase</h2>
          {state.loading ? (
            <p className="text-gray-400 text-sm">Lädt…</p>
          ) : (
            <div className="space-y-2">
              {DEAL_PHASES.map(phase => {
                const count = state.dealsPerPhase[phase] ?? 0
                const widthPct = Math.round((count / maxPhaseCount) * 100)
                return (
                  <div key={phase} className="flex items-center gap-3">
                    <span className="text-lg w-6 text-center">{PHASE_ICONS[phase]}</span>
                    <span className="text-sm text-gray-600 w-36 truncate capitalize">{phase.replace(/_/g, ' ')}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                      <div
                        className="h-4 rounded-full transition-all"
                        style={{ width: `${widthPct}%`, backgroundColor: '#ff795d' }}
                      />
                    </div>
                    <span className="text-sm font-semibold text-gray-700 w-6 text-right">{count}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Bottom two columns */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Open tasks today */}
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">Offene Aufgaben heute</h2>
            {state.loading ? (
              <p className="text-gray-400 text-sm">Lädt…</p>
            ) : state.openTasksToday.length === 0 ? (
              <p className="text-gray-400 text-sm">Keine offenen Aufgaben</p>
            ) : (
              <ul className="space-y-3">
                {state.openTasksToday.map(task => (
                  <li key={task.id} className="flex items-start justify-between gap-2 border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-800 text-sm truncate">{task.subject ?? task.content ?? '–'}</p>
                      {task.lead && (
                        <p className="text-xs text-gray-500">
                          {task.lead.first_name} {task.lead.last_name}
                        </p>
                      )}
                      {task.scheduled_at && (
                        <p className="text-xs text-gray-400">{formatDate(task.scheduled_at)}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleCompleteTask(task.id)}
                      className="shrink-0 text-xs px-3 py-1 rounded-lg text-white font-medium"
                      style={{ backgroundColor: '#ff795d' }}
                    >
                      Erledigt
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>
      </div>
    </DashboardLayout>
  )
}
