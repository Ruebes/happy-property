import { useState, useEffect, useCallback } from 'react'
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
// Was das System automatisch verschickt hat (scheduled_messages, status='sent')
interface SysActivity {
  id: string
  type: string                 // whatsapp | email | both
  event_type: string | null    // registrierung | termin_gebucht | no_show | anzahlung | …
  sent_at: string | null
  lead: { first_name: string; last_name: string } | null
}
// Kunden-Engagement (engagement_events): Deck/Berechnung angesehen, Mail geöffnet
interface EngageEvent {
  id: string
  type: string                 // deck_view | calc_view | email_open
  label: string | null
  occurred_at: string
  lead: { first_name: string; last_name: string } | null
}

interface DashboardState {
  totalLeads: number
  newThisWeek: number
  dealsPerPhase: Record<DealPhase, number>
  commissionWeek: number
  commissionMonth: number
  commissionYear: number
  openTasksToday: TaskActivity[]
  systemActivity: SysActivity[]
  engagement: EngageEvent[]
  loading: boolean
}

export default function CrmDashboard() {
  const { t, i18n } = useTranslation()
  useAuth()
  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'de-DE'

  const [state, setState] = useState<DashboardState>({
    totalLeads: 0,
    newThisWeek: 0,
    dealsPerPhase: {} as Record<DealPhase, number>,
    commissionWeek: 0,
    commissionMonth: 0,
    commissionYear: 0,
    systemActivity: [],
    engagement: [],
    openTasksToday: [],
    loading: true,
  })

  // ── Austauschbare Widgets: Reihenfolge + an/aus pro Nutzer (localStorage) ──
  // Neue Widgets einfach hier registrieren — sie tauchen automatisch im
  // „Widgets anpassen"-Menü auf.
  const ALL_WIDGET_IDS = ['stats', 'system_activity', 'engagement', 'deals_phase', 'open_tasks'] as const
  type WidgetId = typeof ALL_WIDGET_IDS[number]
  const LS_KEY = 'crm_dashboard_widgets'
  const [layout, setLayout] = useState<WidgetId[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
      if (Array.isArray(saved)) {
        const valid = saved.filter((x: string) => (ALL_WIDGET_IDS as readonly string[]).includes(x)) as WidgetId[]
        if (valid.length) return valid
      }
    } catch { /* Default unten */ }
    return [...ALL_WIDGET_IDS]
  })
  const [managing, setManaging] = useState(false)
  const saveLayout = (next: WidgetId[]) => { setLayout(next); try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* egal */ } }
  const toggleWidget = (id: WidgetId) => saveLayout(layout.includes(id) ? layout.filter(x => x !== id) : [...layout, id])
  const moveWidget = (id: WidgetId, dir: -1 | 1) => {
    const i = layout.indexOf(id); const j = i + dir
    if (i < 0 || j < 0 || j >= layout.length) return
    const next = [...layout];[next[i], next[j]] = [next[j], next[i]]; saveLayout(next)
  }

  const fetchData = useCallback(async () => {
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
        sysActivityRes,
        engagementRes,
      ] = await Promise.all([
        supabase.from('leads').select('id', { count: 'exact', head: true }),
        supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', startOfWeek.toISOString()),
        supabase.from('deals').select('phase').neq('phase', 'archiviert').limit(2000),
        supabase
          .from('deals')
          .select('commission_amount, commission_paid_at')
          .not('commission_paid_at', 'is', null)
          // Nur dieses Jahr laden – JS-seitige Filterung auf subset statt auf allen Deals
          .gte('commission_paid_at', startOfYear.toISOString()),
        supabase
          .from('activities')
          .select('id, subject, content, scheduled_at, lead:leads(id, first_name, last_name)')
          .eq('type', 'task')
          .is('completed_at', null)
          .lte('scheduled_at', now.toISOString()),
        // Widget 1: was das System automatisch verschickt hat
        supabase
          .from('scheduled_messages')
          .select('id, type, event_type, sent_at, lead:leads(first_name, last_name)')
          .eq('status', 'sent')
          .order('sent_at', { ascending: false })
          .limit(20),
        // Widget 2: Kunden-Engagement (Deck/Berechnung angesehen, Mail geöffnet)
        supabase
          .from('engagement_events')
          .select('id, type, label, occurred_at, lead:leads(first_name, last_name)')
          .order('occurred_at', { ascending: false })
          .limit(30),
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
        systemActivity: (sysActivityRes.data ?? []) as unknown as SysActivity[],
        engagement: (engagementRes.data ?? []) as unknown as EngageEvent[],
        loading: false,
      })
    } catch (err) {
      console.error('[CrmDashboard] fetchData:', err)
      setState(prev => ({ ...prev, loading: false }))
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleCompleteTask = async (taskId: string) => {
    const { error } = await supabase
      .from('activities')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', taskId)
    if (error) { console.error('[CrmDashboard] handleCompleteTask:', error.message); return }
    await fetchData()
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(amount)

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' })

  // „vor 3 Min / 2 Std / 4 Tagen" — knapp für die Aktivitäts-Feeds
  const relTime = (iso: string | null) => {
    if (!iso) return ''
    const diff = Date.now() - new Date(iso).getTime()
    const min = Math.floor(diff / 60000)
    if (min < 1) return t('crm.dashboard.justNow', 'gerade eben')
    if (min < 60) return t('crm.dashboard.minAgo', 'vor {{n}} Min', { n: min })
    const h = Math.floor(min / 60)
    if (h < 24) return t('crm.dashboard.hAgo', 'vor {{n}} Std', { n: h })
    const d = Math.floor(h / 24)
    return t('crm.dashboard.dAgo', 'vor {{n}} Tg', { n: d })
  }
  const leadName = (l: { first_name: string; last_name: string } | null) =>
    l ? `${l.first_name} ${l.last_name}`.trim() : t('crm.dashboard.someone', 'Jemand')
  // System-Nachrichten-Anlass in Klartext
  const EVENT_LABELS: Record<string, string> = {
    registrierung: t('crm.dashboard.evReg', 'Willkommens-Nachricht'),
    termin_gebucht: t('crm.dashboard.evBooked', 'Termin-Bestätigung'),
    no_show: t('crm.dashboard.evNoShow', 'No-Show-Nachfassen'),
    anzahlung: t('crm.dashboard.evDeposit', 'Anzahlungs-Info'),
    reservierung: t('crm.dashboard.evReserv', 'Reservierungs-Info'),
  }
  const channelIcon = (type: string) => type === 'email' ? '📧' : type === 'both' ? '📨' : '💬'
  const channelName = (type: string) => type === 'email' ? t('crmDashboard.channelEmail', 'E-Mail') : type === 'both' ? t('crmDashboard.channelEmailWhatsapp', 'E-Mail + WhatsApp') : t('crmDashboard.channelWhatsapp', 'WhatsApp')
  // Engagement-Ereignis als Satz: „… hat sich das Deck Mamba angesehen"
  const engageAction = (e: EngageEvent) => {
    if (e.type === 'deck_view')  return t('crm.dashboard.engDeck', 'hat sich das Deck {{x}} angesehen', { x: e.label || 'Projekt' })
    if (e.type === 'calc_view')  return t('crm.dashboard.engCalc', 'hat sich die Berechnung {{x}} angesehen', { x: e.label || '' }).trim()
    if (e.type === 'email_open') return t('crm.dashboard.engOpen', 'hat deine E-Mail geöffnet')
    return e.type
  }
  const engageIcon = (type: string) => type === 'email_open' ? '✉️' : type === 'calc_view' ? '📊' : '🏠'

  const maxPhaseCount = Math.max(1, ...Object.values(state.dealsPerPhase))

  // Titel + Breite (full = volle Zeile) je Widget — auch fürs „anpassen"-Menü.
  const WIDGET_META: Record<WidgetId, { title: string; full?: boolean }> = {
    stats:           { title: t('crm.dashboard.wStats', 'Kennzahlen'), full: true },
    system_activity: { title: t('crm.dashboard.systemActivity', 'Was das System gemacht hat') },
    engagement:      { title: t('crm.dashboard.engagement', 'Kunden-Aktivität') },
    deals_phase:     { title: t('crm.dashboard.dealsPerPhase', 'Deals pro Phase'), full: true },
    open_tasks:      { title: t('crm.dashboard.openTasksToday', 'Offene Aufgaben heute'), full: true },
  }

  const renderWidget = (id: WidgetId) => {
    switch (id) {
      case 'stats':
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white rounded-2xl shadow-sm p-5"><p className="text-sm text-gray-500">{t('crm.dashboard.totalLeads')}</p><p className="text-3xl font-bold text-gray-900 mt-1">{state.totalLeads}</p></div>
            <div className="bg-white rounded-2xl shadow-sm p-5"><p className="text-sm text-gray-500">{t('crm.dashboard.newThisWeek')}</p><p className="text-3xl font-bold text-gray-900 mt-1">{state.newThisWeek}</p></div>
            <div className="bg-white rounded-2xl shadow-sm p-5"><p className="text-sm text-gray-500">{t('crm.dashboard.commissionThisMonth')}</p><p className="text-3xl font-bold text-gray-900 mt-1">{formatCurrency(state.commissionMonth)}</p></div>
            <div className="bg-white rounded-2xl shadow-sm p-5"><p className="text-sm text-gray-500">{t('crm.dashboard.commissionThisYear')}</p><p className="text-3xl font-bold text-gray-900 mt-1">{formatCurrency(state.commissionYear)}</p></div>
          </div>
        )
      case 'system_activity':
        return (
          <div className="bg-white rounded-2xl shadow-sm p-5 h-full">
            <h2 className="text-lg font-semibold text-gray-800">🤖 {t('crm.dashboard.systemActivity', 'Was das System gemacht hat')}</h2>
            <p className="text-xs text-gray-400 mt-0.5 mb-4">{t('crm.dashboard.systemActivityHint', 'Automatisch versendete Mails & WhatsApp-Nachrichten')}</p>
            {state.loading ? <p className="text-gray-400 text-sm">{t('common.loading')}</p>
              : state.systemActivity.length === 0 ? <p className="text-gray-400 text-sm">{t('crm.dashboard.noSystemActivity', 'Noch nichts automatisch versendet.')}</p>
              : <ul className="space-y-2.5 max-h-80 overflow-y-auto">{state.systemActivity.map(a => (
                  <li key={a.id} className="flex items-start gap-2.5 text-sm">
                    <span className="text-base shrink-0 mt-0.5">{channelIcon(a.type)}</span>
                    <span className="flex-1 min-w-0 text-gray-700"><b>{EVENT_LABELS[a.event_type ?? ''] ?? (a.event_type ?? channelName(a.type))}</b> {t('crm.dashboard.sentTo', 'an')} {leadName(a.lead)}<span className="text-gray-400"> · {channelName(a.type)}</span></span>
                    <span className="text-xs text-gray-400 shrink-0 whitespace-nowrap">{relTime(a.sent_at)}</span>
                  </li>))}</ul>}
          </div>
        )
      case 'engagement':
        return (
          <div className="bg-white rounded-2xl shadow-sm p-5 h-full">
            <h2 className="text-lg font-semibold text-gray-800">👀 {t('crm.dashboard.engagement', 'Kunden-Aktivität')}</h2>
            <p className="text-xs text-gray-400 mt-0.5 mb-4">{t('crm.dashboard.engagementHint', 'Wer sich Decks/Berechnungen angesehen oder Mails geöffnet hat')}</p>
            {state.loading ? <p className="text-gray-400 text-sm">{t('common.loading')}</p>
              : state.engagement.length === 0 ? <p className="text-gray-400 text-sm">{t('crm.dashboard.noEngagement', 'Noch keine Kunden-Aktivität erfasst.')}</p>
              : <ul className="space-y-2.5 max-h-80 overflow-y-auto">{state.engagement.map(e => (
                  <li key={e.id} className="flex items-start gap-2.5 text-sm">
                    <span className="text-base shrink-0 mt-0.5">{engageIcon(e.type)}</span>
                    <span className="flex-1 min-w-0 text-gray-700"><b>{leadName(e.lead)}</b> {engageAction(e)}</span>
                    <span className="text-xs text-gray-400 shrink-0 whitespace-nowrap">{relTime(e.occurred_at)}</span>
                  </li>))}</ul>}
          </div>
        )
      case 'deals_phase':
        return (
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">{t('crm.dashboard.dealsPerPhase')}</h2>
            {state.loading ? <p className="text-gray-400 text-sm">{t('common.loading')}</p>
              : <div className="space-y-2">{DEAL_PHASES.map(phase => {
                  const count = state.dealsPerPhase[phase] ?? 0
                  const widthPct = Math.round((count / maxPhaseCount) * 100)
                  return (
                    <div key={phase} className="flex items-center gap-3">
                      <span className="text-lg w-6 text-center">{PHASE_ICONS[phase]}</span>
                      <span className="text-sm text-gray-600 w-36 truncate capitalize">{phase.replace(/_/g, ' ')}</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden"><div className="h-4 rounded-full transition-all" style={{ width: `${widthPct}%`, backgroundColor: '#ff795d' }} /></div>
                      <span className="text-sm font-semibold text-gray-700 w-6 text-right">{count}</span>
                    </div>)
                })}</div>}
          </div>
        )
      case 'open_tasks':
        return (
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">{t('crm.dashboard.openTasksToday')}</h2>
            {state.loading ? <p className="text-gray-400 text-sm">{t('common.loading')}</p>
              : state.openTasksToday.length === 0 ? <p className="text-gray-400 text-sm">{t('crm.dashboard.noOpenTasks')}</p>
              : <ul className="space-y-3">{state.openTasksToday.map(task => (
                  <li key={task.id} className="flex items-start justify-between gap-2 border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-800 text-sm truncate">{task.subject ?? task.content ?? '–'}</p>
                      {task.lead && <p className="text-xs text-gray-500">{task.lead.first_name} {task.lead.last_name}</p>}
                      {task.scheduled_at && <p className="text-xs text-gray-400">{formatDate(task.scheduled_at)}</p>}
                    </div>
                    <button onClick={() => handleCompleteTask(task.id)} className="shrink-0 text-xs px-3 py-1 rounded-lg text-white font-medium" style={{ backgroundColor: '#ff795d' }}>{t('crm.dashboard.taskDone')}</button>
                  </li>))}</ul>}
          </div>
        )
    }
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.dashboard.title')}</h1>
          <button onClick={() => setManaging(m => !m)}
            className="text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-orange-400 hover:text-orange-600 shrink-0">
            ⚙ {t('crm.dashboard.manageWidgets', 'Widgets anpassen')}
          </button>
        </div>

        {/* Anpassen-Panel: Widgets an/aus + Reihenfolge */}
        {managing && (
          <div className="bg-white rounded-2xl shadow-sm p-5 border border-orange-100">
            <p className="text-sm font-semibold text-gray-700 mb-3">{t('crm.dashboard.manageHint', 'Widgets ein-/ausblenden und sortieren — wird pro Browser gespeichert.')}</p>
            <ul className="space-y-2">
              {(ALL_WIDGET_IDS as readonly WidgetId[]).slice().sort((a, b) => {
                const ia = layout.indexOf(a), ib = layout.indexOf(b)
                return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
              }).map(id => {
                const on = layout.includes(id)
                return (
                  <li key={id} className="flex items-center gap-3 text-sm">
                    <label className="flex items-center gap-2 flex-1 cursor-pointer">
                      <input type="checkbox" checked={on} onChange={() => toggleWidget(id)} className="w-4 h-4 accent-orange-500" />
                      <span className={on ? 'text-gray-800' : 'text-gray-400'}>{WIDGET_META[id].title}</span>
                    </label>
                    {on && (
                      <span className="flex gap-1 shrink-0">
                        <button onClick={() => moveWidget(id, -1)} disabled={layout.indexOf(id) === 0} className="px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30">↑</button>
                        <button onClick={() => moveWidget(id, 1)} disabled={layout.indexOf(id) === layout.length - 1} className="px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30">↓</button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Widgets in gewählter Reihenfolge — full = volle Zeile, sonst 2-spaltig */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {layout.map(id => (
            <div key={id} className={WIDGET_META[id].full ? 'lg:col-span-2' : ''}>
              {renderWidget(id)}
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  )
}
