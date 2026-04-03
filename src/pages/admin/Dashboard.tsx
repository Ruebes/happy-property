import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Types ──────────────────────────────────────────────────────
interface AdminStats {
  propTotal:       number
  propShortterm:   number
  propLongterm:    number
  eigentuemer:     number
  eigentuemerActive: number
  eigentuemerNewThisWeek: number
  usersTotal:      number
  roleAdmin:       number
  roleVerwalter:   number
  roleEigentuemer: number
  roleFeriengast:  number
  bankPending:     number
  contractsExpiring: number
  unreadMessages:  number
}

interface ActivityEntry {
  id:          string
  action_type: string
  description: string
  created_at:  string
  user?:       { full_name: string } | null
  property?:   { project_name: string } | null
}

interface BankTask {
  id:           string
  owner_id:     string
  changed_at:   string
  old_iban_masked: string | null
  new_iban_masked: string | null
  owner:        { full_name: string } | null
}

interface ContractTask {
  id:          string
  end_date:    string
  tenant_name: string
  property:    { project_name: string; unit_number: string | null } | null
}

interface NewUserTask {
  id:         string
  full_name:  string
  role:       string
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────
function timeAgo(iso: string, lang: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (lang === 'en') {
    if (mins < 1)   return 'just now'
    if (mins < 60)  return `${mins}m ago`
    if (hours < 24) return `${hours}h ago`
    return `${days}d ago`
  }
  if (mins < 1)   return 'gerade eben'
  if (mins < 60)  return `vor ${mins} Min.`
  if (hours < 24) return `vor ${hours} Std.`
  return `vor ${days} Tag${days === 1 ? '' : 'en'}`
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const ACTION_ICON: Record<string, string> = {
  user_created:       '👤',
  document_uploaded:  '📄',
  booking_created:    '📅',
  contract_signed:    '✍️',
  bank_changed:       '🏦',
}

// ── Sub-components ────────────────────────────────────────────
function Skeleton({ w = 'w-16', h = 'h-8' }: { w?: string; h?: string }) {
  return <div className={`${w} ${h} rounded-lg bg-gray-100 animate-pulse`} />
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-4">
      {children}
    </h2>
  )
}

// ── Admin Dashboard ────────────────────────────────────────────
export default function AdminDashboard() {
  const { t }       = useTranslation()
  const { profile } = useAuth()
  const navigate    = useNavigate()
  const lang        = profile?.language ?? 'de'

  const [stats,    setStats]    = useState<AdminStats | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [bankTasks,     setBankTasks]     = useState<BankTask[]>([])
  const [contractTasks, setContractTasks] = useState<ContractTask[]>([])
  const [newUsers,      setNewUsers]      = useState<NewUserTask[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const today    = new Date().toISOString().slice(0, 10)
      const in30Days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
      const weekAgo  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)

      const [
        propTotalRes, propShortRes, propLongRes,
        eigRes, eigActiveRes, eigNewRes,
        userTotalRes, roleAdminRes, roleVerwalterRes, roleFeriengastRes,
        bankRes, contractRes, msgRes,
        activityRes, bankTaskRes, contractTaskRes, newUserRes,
      ] = await Promise.all([
        supabase.from('properties').select('*', { count: 'exact', head: true }),
        supabase.from('properties').select('*', { count: 'exact', head: true }).eq('rental_type', 'shortterm'),
        supabase.from('properties').select('*', { count: 'exact', head: true }).eq('rental_type', 'longterm'),

        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'eigentuemer'),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'eigentuemer').eq('is_active', true),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'eigentuemer').gte('created_at', weekAgo),

        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'admin'),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'verwalter'),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'feriengast'),

        supabase.from('bank_change_notifications').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('contracts').select('*', { count: 'exact', head: true }).gte('end_date', today).lte('end_date', in30Days),
        supabase.from('messages').select('*', { count: 'exact', head: true }).eq('is_read', false),

        supabase.from('activity_log')
          .select('id, action_type, description, created_at, user:user_id(full_name), property:property_id(project_name)')
          .order('created_at', { ascending: false })
          .limit(10),

        supabase.from('bank_change_notifications')
          .select('id, owner_id, changed_at, old_iban_masked, new_iban_masked, owner:owner_id(full_name)')
          .eq('status', 'pending')
          .order('changed_at', { ascending: false })
          .limit(20),

        supabase.from('contracts')
          .select('id, end_date, tenant_name, property:property_id(project_name, unit_number)')
          .gte('end_date', today)
          .lte('end_date', in30Days)
          .order('end_date', { ascending: true })
          .limit(20),

        supabase.from('profiles')
          .select('id, full_name, role, created_at')
          .gte('created_at', weekAgo)
          .order('created_at', { ascending: false })
          .limit(10),
      ])

      setStats({
        propTotal:       propTotalRes.count    ?? 0,
        propShortterm:   propShortRes.count    ?? 0,
        propLongterm:    propLongRes.count     ?? 0,
        eigentuemer:     eigRes.count          ?? 0,
        eigentuemerActive: eigActiveRes.count  ?? 0,
        eigentuemerNewThisWeek: eigNewRes.count ?? 0,
        usersTotal:      userTotalRes.count    ?? 0,
        roleAdmin:       roleAdminRes.count    ?? 0,
        roleVerwalter:   roleVerwalterRes.count ?? 0,
        roleEigentuemer: eigRes.count          ?? 0,
        roleFeriengast:  roleFeriengastRes.count ?? 0,
        bankPending:     bankRes.count         ?? 0,
        contractsExpiring: contractRes.count   ?? 0,
        unreadMessages:  msgRes.count          ?? 0,
      })
      setActivity((activityRes.data ?? []) as unknown as ActivityEntry[])
      setBankTasks((bankTaskRes.data ?? []) as unknown as BankTask[])
      setContractTasks((contractTaskRes.data ?? []) as unknown as ContractTask[])
      setNewUsers((newUserRes.data ?? []) as NewUserTask[])
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function confirmBank(id: string) {
    if (!profile) return
    setConfirming(id)
    await supabase.from('bank_change_notifications').update({
      status:       'confirmed',
      confirmed_by: profile.id,
      confirmed_at: new Date().toISOString(),
    }).eq('id', id)
    setBankTasks(t => t.filter(x => x.id !== id))
    setStats(s => s ? { ...s, bankPending: Math.max(0, s.bankPending - 1) } : s)
    setConfirming(null)
  }

  const openTasks = (stats?.bankPending ?? 0) + (stats?.contractsExpiring ?? 0) + (stats?.unreadMessages ?? 0)

  const roleColors: Record<string, string> = {
    admin:       'bg-purple-50  border-purple-200  text-purple-800',
    verwalter:   'bg-blue-50    border-blue-200    text-blue-800',
    eigentuemer: 'bg-green-50   border-green-200   text-green-800',
    feriengast:  'bg-orange-50  border-orange-200  text-orange-800',
  }

  return (
    <DashboardLayout basePath="/admin/dashboard">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-hp-black"
              style={{ fontFamily: 'var(--font-heading)' }}>
            {t('dashboard.greeting')}, {profile?.full_name?.split(' ')[0] ?? t('roles.admin')} 👋
          </h1>
          <p className="mt-1 text-sm text-gray-400 font-body">
            {t('dashboard.admin.subtitle')}
          </p>
        </div>
        <button onClick={fetchAll} disabled={loading}
                className="mt-1 p-2 rounded-xl border border-gray-200 text-gray-400
                           hover:border-gray-300 hover:text-gray-600 transition-colors disabled:opacity-40">
          <span className={`text-base block ${loading ? 'animate-spin' : ''}`}>↻</span>
        </button>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 bg-red-50 border border-red-100 rounded-xl text-sm font-body text-red-600">
          {t('errors.serverError')} —{' '}
          <button onClick={fetchAll} className="underline font-semibold">{t('common.retry')}</button>
        </div>
      )}

      {/* ── 1. KPI-Karten ──────────────────────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t('dashboard.admin.statsTitle')}</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">

          {/* Objekte */}
          <div onClick={() => navigate('/objekte')}
               className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm
                          cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all">
            <div className="flex items-center justify-between mb-3">
              <span className="text-2xl">🏢</span>
              <span className="text-xs text-gray-300 font-body">›</span>
            </div>
            <div className="text-2xl font-bold text-hp-black font-body tabular-nums leading-none mb-1">
              {loading ? <Skeleton /> : stats?.propTotal ?? 0}
            </div>
            <div className="text-xs text-gray-400 font-body mb-2">{t('dashboard.admin.propertiesTitle')}</div>
            {!loading && (
              <div className="flex gap-1.5 flex-wrap">
                <span className="text-xs bg-orange-50 text-orange-600 border border-orange-100 px-2 py-0.5 rounded-full font-body">
                  {stats?.propShortterm ?? 0} {t('dashboard.admin.shortterm')}
                </span>
                <span className="text-xs bg-blue-50 text-blue-600 border border-blue-100 px-2 py-0.5 rounded-full font-body">
                  {stats?.propLongterm ?? 0} {t('dashboard.admin.longterm')}
                </span>
              </div>
            )}
          </div>

          {/* Kunden */}
          <div onClick={() => navigate('/admin/users?role=eigentuemer')}
               className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm
                          cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all">
            <div className="flex items-center justify-between mb-3">
              <span className="text-2xl">🤝</span>
              <span className="text-xs text-gray-300 font-body">›</span>
            </div>
            <div className="text-2xl font-bold text-hp-black font-body tabular-nums leading-none mb-1">
              {loading ? <Skeleton /> : stats?.eigentuemer ?? 0}
            </div>
            <div className="text-xs text-gray-400 font-body mb-2">{t('dashboard.admin.customers')}</div>
            {!loading && (
              <div className="flex gap-1.5 flex-wrap">
                <span className="text-xs bg-green-50 text-green-600 border border-green-100 px-2 py-0.5 rounded-full font-body">
                  {stats?.eigentuemerActive ?? 0} {t('dashboard.admin.active')}
                </span>
                {(stats?.eigentuemerNewThisWeek ?? 0) > 0 && (
                  <span className="text-xs bg-amber-50 text-amber-600 border border-amber-100 px-2 py-0.5 rounded-full font-body">
                    +{stats?.eigentuemerNewThisWeek} {t('dashboard.admin.newThisWeek')}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Alle Nutzer */}
          <div onClick={() => navigate('/admin/users')}
               className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm
                          cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all">
            <div className="flex items-center justify-between mb-3">
              <span className="text-2xl">👥</span>
              <span className="text-xs text-gray-300 font-body">›</span>
            </div>
            <div className="text-2xl font-bold text-hp-black font-body tabular-nums leading-none mb-1">
              {loading ? <Skeleton /> : stats?.usersTotal ?? 0}
            </div>
            <div className="text-xs text-gray-400 font-body mb-2">{t('dashboard.admin.allUsers')}</div>
            {!loading && (
              <div className="flex gap-1.5 flex-wrap">
                <span className="text-xs bg-purple-50 text-purple-600 border border-purple-100 px-2 py-0.5 rounded-full font-body">
                  {stats?.roleAdmin ?? 0} Admin
                </span>
                <span className="text-xs bg-blue-50 text-blue-600 border border-blue-100 px-2 py-0.5 rounded-full font-body">
                  {stats?.roleVerwalter ?? 0} {t('roles.verwalter')}
                </span>
                {(stats?.roleFeriengast ?? 0) > 0 && (
                  <span className="text-xs bg-amber-50 text-amber-600 border border-amber-100 px-2 py-0.5 rounded-full font-body">
                    {stats?.roleFeriengast} {t('roles.feriengast')}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Offene Aufgaben */}
          <div onClick={() => document.getElementById('tasks-section')?.scrollIntoView({ behavior: 'smooth' })}
               className={`rounded-2xl border p-5 shadow-sm cursor-pointer
                           hover:shadow-md hover:-translate-y-0.5 transition-all
                           ${openTasks > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'}`}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-2xl">{openTasks > 0 ? '🔔' : '✅'}</span>
              <span className={`text-xs font-body ${openTasks > 0 ? 'text-red-300' : 'text-gray-300'}`}>›</span>
            </div>
            <div className={`text-2xl font-bold font-body tabular-nums leading-none mb-1
                             ${openTasks > 0 ? 'text-red-700' : 'text-hp-black'}`}>
              {loading ? <Skeleton /> : openTasks}
            </div>
            <div className={`text-xs font-body mb-2 ${openTasks > 0 ? 'text-red-500' : 'text-gray-400'}`}>
              {t('dashboard.admin.openTasks')}
            </div>
            {!loading && (
              <div className="flex gap-1.5 flex-wrap">
                {(stats?.bankPending ?? 0) > 0 && (
                  <span className="text-xs bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-full font-body">
                    🏦 {stats?.bankPending}
                  </span>
                )}
                {(stats?.contractsExpiring ?? 0) > 0 && (
                  <span className="text-xs bg-amber-100 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-body">
                    📋 {stats?.contractsExpiring}
                  </span>
                )}
                {(stats?.unreadMessages ?? 0) > 0 && (
                  <span className="text-xs bg-blue-100 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-body">
                    💬 {stats?.unreadMessages}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── 2. Schnellaktionen ─────────────────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t('dashboard.admin.quickActions')}</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { icon: '👤', label: t('dashboard.admin.actionNewUser'),       onClick: () => navigate('/admin/users'),    primary: true  },
            { icon: '🏢', label: t('dashboard.admin.actionNewProperty'),   onClick: () => navigate('/objekte'),        primary: true  },
            { icon: '👥', label: t('dashboard.admin.actionAllUsers'),      onClick: () => navigate('/admin/users'),    primary: false },
            { icon: '🏠', label: t('dashboard.admin.actionAllProperties'), onClick: () => navigate('/objekte'),        primary: false },
          ].map(({ icon, label, onClick, primary }) => (
            <button key={label} onClick={onClick}
                    className={`rounded-2xl border px-4 py-4 shadow-sm text-left
                                hover:shadow-md hover:-translate-y-0.5 transition-all
                                flex items-center gap-3 font-body text-sm font-medium
                                ${primary
                                  ? 'text-white border-transparent'
                                  : 'bg-white border-gray-100 text-gray-700 hover:border-gray-200'}`}
                    style={primary ? { backgroundColor: 'var(--color-highlight)' } : {}}>
              <span className="text-xl">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── 3. Letzte Aktivitäten ─────────────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t('dashboard.admin.recentActivity')}</SectionTitle>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gray-100 animate-pulse shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="w-2/3 h-3.5 rounded bg-gray-100 animate-pulse" />
                    <div className="w-1/3 h-3 rounded bg-gray-100 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : activity.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-gray-400 font-body">
              {t('dashboard.admin.noActivity')}
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {activity.map(a => (
                <li key={a.id} className="px-5 py-3 flex items-start gap-3">
                  <span className="text-lg shrink-0 mt-0.5">
                    {ACTION_ICON[a.action_type] ?? '📌'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-body text-hp-black leading-snug">{a.description}</p>
                    {(a.user || a.property) && (
                      <p className="text-xs text-gray-400 font-body mt-0.5">
                        {a.user?.full_name}{a.user && a.property ? ' · ' : ''}{a.property?.project_name}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-gray-300 font-body shrink-0 mt-0.5">
                    {timeAgo(a.created_at, lang)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── 4. Offene Aufgaben ─────────────────────────────── */}
      <section id="tasks-section" className="mb-8">
        <SectionTitle>{t('dashboard.admin.tasksTitle')}</SectionTitle>

        {loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-16 bg-white rounded-2xl border border-gray-100 animate-pulse" />
            ))}
          </div>
        ) : bankTasks.length === 0 && contractTasks.length === 0 && newUsers.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-6 py-10
                          text-center text-sm text-gray-400 font-body">
            ✅ {t('dashboard.admin.noTasks')}
          </div>
        ) : (
          <div className="space-y-3">

            {/* 🔴 Bankdaten-Änderungen */}
            {bankTasks.map(n => (
              <div key={n.id}
                   className="bg-red-50 border border-red-200 rounded-2xl px-5 py-4
                              flex flex-col sm:flex-row sm:items-center gap-3">
                <span className="text-xl shrink-0">🔴</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-red-800 font-body">
                    {n.owner?.full_name ?? n.owner_id} — {t('dashboard.admin.taskBankChange')}
                  </p>
                  <p className="text-xs text-red-600 font-body mt-0.5">
                    {n.old_iban_masked && <span>{t('notifications.oldIban')}: <span className="font-mono">{n.old_iban_masked}</span> → </span>}
                    {n.new_iban_masked && <span className="font-mono font-semibold">{n.new_iban_masked}</span>}
                    {' · '}{fmtDate(n.changed_at)}
                  </p>
                </div>
                <button onClick={() => confirmBank(n.id)} disabled={confirming === n.id}
                        className="shrink-0 px-4 py-2 text-xs font-semibold font-body rounded-xl
                                   text-white disabled:opacity-50 transition-opacity"
                        style={{ backgroundColor: '#dc2626' }}>
                  {confirming === n.id ? '…' : t('dashboard.admin.btnConfirm')}
                </button>
              </div>
            ))}

            {/* 🟡 Ablaufende Verträge */}
            {contractTasks.map(c => (
              <div key={c.id}
                   className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4
                              flex flex-col sm:flex-row sm:items-center gap-3">
                <span className="text-xl shrink-0">🟡</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-amber-800 font-body">
                    {c.property?.project_name ?? '–'}
                    {c.property?.unit_number && ` (${c.property.unit_number})`}
                  </p>
                  <p className="text-xs text-amber-700 font-body mt-0.5">
                    {c.tenant_name} · {t('dashboard.admin.taskExpiresOn')} {fmtDate(c.end_date)}
                  </p>
                </div>
                <button onClick={() => navigate('/objekte')}
                        className="shrink-0 px-4 py-2 text-xs font-semibold font-body rounded-xl
                                   bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200 transition-colors">
                  {t('dashboard.admin.btnView')}
                </button>
              </div>
            ))}

            {/* 🟢 Neue Nutzer diese Woche */}
            {newUsers.map(u => (
              <div key={u.id}
                   className="bg-green-50 border border-green-200 rounded-2xl px-5 py-4
                              flex flex-col sm:flex-row sm:items-center gap-3">
                <span className="text-xl shrink-0">🟢</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-green-800 font-body">
                    {u.full_name}
                  </p>
                  <p className="text-xs text-green-700 font-body mt-0.5">
                    {t(`roles.${u.role}`)} · {t('dashboard.admin.taskCreatedAt')} {fmtDate(u.created_at)}
                  </p>
                </div>
                <button onClick={() => navigate('/admin/users')}
                        className="shrink-0 px-4 py-2 text-xs font-semibold font-body rounded-xl
                                   bg-green-100 text-green-800 border border-green-200 hover:bg-green-200 transition-colors">
                  {t('dashboard.admin.btnView')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 5. Rollen-Übersicht ─────────────────────────────── */}
      <section>
        <SectionTitle>{t('dashboard.admin.rolesOverview')}</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {(['admin', 'verwalter', 'eigentuemer', 'feriengast'] as const).map(role => (
            <div key={role}
                 onClick={() => navigate(`/admin/users?role=${role}`)}
                 className={`rounded-2xl border p-5 cursor-pointer hover:shadow-md
                             hover:-translate-y-0.5 transition-all ${roleColors[role]}`}>
              <h3 className="font-bold font-body text-sm mb-1">
                {t(`roles.${role}`)}
              </h3>
              <p className="text-xs font-body leading-relaxed opacity-80">
                {t(`roles.${role}_desc`)}
              </p>
            </div>
          ))}
        </div>
      </section>

    </DashboardLayout>
  )
}
