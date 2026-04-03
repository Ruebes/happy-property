import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

interface BankNotification {
  id: string
  owner_id: string
  old_iban_masked: string | null
  new_iban_masked: string | null
  changed_at: string
  status: 'pending' | 'confirmed'
  owner: { full_name: string; email: string } | null
}

interface Stats {
  properties: number
  documents: number
}

function Skeleton() {
  return <div className="w-12 h-6 rounded-lg bg-gray-100 animate-pulse" />
}

export default function VerwalterDashboard() {
  const { t }       = useTranslation()
  const { profile } = useAuth()
  const navigate    = useNavigate()

  const [stats, setStats]           = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [notifications, setNotifications] = useState<BankNotification[]>([])
  const [confirming, setConfirming] = useState<string | null>(null)

  // ── Fetch stats ───────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    const [propRes, docRes] = await Promise.all([
      supabase.from('properties').select('*', { count: 'exact', head: true }),
      supabase.from('documents').select('*', { count: 'exact', head: true }),
    ])
    setStats({
      properties: propRes.count ?? 0,
      documents:  docRes.count  ?? 0,
    })
    setStatsLoading(false)
  }, [])

  // ── Fetch pending bank change notifications ───────────────
  const fetchNotifications = useCallback(async () => {
    const { data } = await supabase
      .from('bank_change_notifications')
      .select('*, owner:owner_id(full_name, email)')
      .eq('status', 'pending')
      .order('changed_at', { ascending: false })
      .limit(100)
    setNotifications((data as BankNotification[]) ?? [])
  }, [])

  useEffect(() => {
    fetchStats()
    fetchNotifications()
  }, [fetchStats, fetchNotifications])

  // ── Confirm notification ──────────────────────────────────
  async function confirmNotification(id: string) {
    if (!profile) return
    setConfirming(id)
    await supabase
      .from('bank_change_notifications')
      .update({
        status:       'confirmed',
        confirmed_by: profile.id,
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', id)
    setNotifications(n => n.filter(x => x.id !== id))
    setConfirming(null)
  }

  // ── Quick actions ─────────────────────────────────────────
  const quickActions = [
    { icon: '🏠', label: t('dashboard.verwalter.actions.properties'), onClick: () => navigate('/objekte') },
    { icon: '📅', label: t('dashboard.verwalter.actions.calendar'),   onClick: () => navigate('/kalender') },
    { icon: '👥', label: t('dashboard.verwalter.actions.users'),      onClick: () => navigate('/admin/users') },
  ]

  return (
    <DashboardLayout basePath="/verwalter/dashboard">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-hp-black"
            style={{ fontFamily: 'var(--font-heading)' }}>
          {t('dashboard.greeting')}, {profile?.full_name?.split(' ')[0] || t('roles.verwalter')} 👋
        </h1>
        <p className="mt-1 text-sm text-gray-400 font-body">
          {t('dashboard.verwalter.subtitle')}
        </p>
      </div>

      {/* ── Benachrichtigungen: Bankdaten-Änderungen ──────── */}
      {notifications.length > 0 && (
        <section className="mb-7 space-y-3">
          {notifications.map(n => (
            <div key={n.id}
                 className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4
                            flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">⚠️</span>
                  <span className="text-sm font-semibold text-amber-800 font-body">
                    {t('notifications.bankChanged', { name: n.owner?.full_name ?? n.owner_id })}
                  </span>
                </div>
                <div className="text-xs text-amber-700 font-body space-y-0.5">
                  {n.old_iban_masked && (
                    <div>{t('notifications.oldIban')}: <span className="font-mono">{n.old_iban_masked}</span></div>
                  )}
                  {n.new_iban_masked && (
                    <div>{t('notifications.newIban')}: <span className="font-mono font-semibold">{n.new_iban_masked}</span></div>
                  )}
                  <div>{t('notifications.changedAt')}: {new Date(n.changed_at).toLocaleString('de-DE')}</div>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => navigate(`/verwalter/properties/${n.owner_id}`)}
                  className="px-3 py-1.5 text-xs font-medium font-body rounded-xl border
                             border-amber-300 text-amber-700 hover:bg-amber-100 transition-colors">
                  {t('notifications.details')}
                </button>
                <button
                  onClick={() => confirmNotification(n.id)}
                  disabled={confirming === n.id}
                  className="px-3 py-1.5 text-xs font-semibold font-body rounded-xl text-white
                             disabled:opacity-60 transition-opacity"
                  style={{ backgroundColor: '#d97706' }}>
                  {confirming === n.id ? '…' : t('notifications.confirm')}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* ── Stats ─────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-4">
          {t('dashboard.admin.statsTitle')}
        </h2>
        <div className="grid grid-cols-2 gap-4">
          {[
            { icon: '🏢', label: t('stats.properties'), value: stats?.properties, onClick: () => navigate('/objekte') },
            { icon: '📄', label: t('stats.documents'),  value: stats?.documents,  onClick: () => navigate('/objekte') },
          ].map(({ icon, label, value, onClick }) => (
            <div key={label}
                 onClick={onClick}
                 className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm
                            cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all">
              <div className="text-2xl mb-2">{icon}</div>
              <div className="text-2xl font-bold font-body text-hp-black tabular-nums">
                {statsLoading ? <Skeleton /> : value ?? 0}
              </div>
              <div className="text-xs text-gray-400 font-body mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Schnellaktionen ───────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-4">
          {t('dashboard.verwalter.quickActions')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {quickActions.map(({ icon, label, onClick }) => (
            <button key={label} onClick={onClick}
                    className="bg-white rounded-2xl border border-gray-100 px-4 py-4 shadow-sm
                               text-left hover:shadow-md hover:border-gray-200 hover:-translate-y-0.5
                               transition-all flex items-center gap-3">
              <span className="text-xl">{icon}</span>
              <span className="text-sm font-medium font-body text-gray-700">{label}</span>
            </button>
          ))}
        </div>
      </section>

    </DashboardLayout>
  )
}
