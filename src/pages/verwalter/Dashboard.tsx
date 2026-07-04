import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

interface VerwaltungStammdaten {
  id:                    string
  name:                  string
  address_street:        string | null
  address_zip:           string | null
  address_city:          string | null
  address_country:       string | null
  phone:                 string | null
  email:                 string | null
  website:               string | null
  ansprechpartner:       string | null
  ansprechpartner_phone: string | null
  ansprechpartner_email: string | null
}

const inputCls = `w-full rounded-xl border border-gray-200 bg-white px-3 py-2
  text-sm text-hp-black font-body placeholder-gray-400
  focus:outline-none focus:ring-2 focus:border-transparent transition`
function focusRing(): React.CSSProperties {
  return { '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties
}

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

  // Eigene Verwaltungs-Stammdaten
  const [verwaltung,      setVerwaltung]      = useState<VerwaltungStammdaten | null>(null)
  const [showVerwEdit,    setShowVerwEdit]    = useState(false)
  const [verwForm,        setVerwForm]        = useState<Omit<VerwaltungStammdaten,'id'> | null>(null)
  const [verwSaving,      setVerwSaving]      = useState(false)
  const [verwToast,       setVerwToast]       = useState<string | null>(null)

  // ── Fetch stats ───────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const [propRes, docRes] = await Promise.all([
        supabase.from('properties').select('*', { count: 'exact', head: true }),
        supabase.from('documents').select('*', { count: 'exact', head: true }),
      ])
      setStats({
        properties: propRes.count ?? 0,
        documents:  docRes.count  ?? 0,
      })
    } finally {
      setStatsLoading(false)
    }
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

  // ── Fetch eigene Verwaltungs-Stammdaten ──────────────────
  const fetchVerwaltung = useCallback(async () => {
    if (!profile?.verwaltung_id) return
    const { data } = await supabase
      .from('verwaltungen')
      .select('id, name, address_street, address_zip, address_city, address_country, phone, email, website, ansprechpartner, ansprechpartner_phone, ansprechpartner_email')
      .eq('id', profile.verwaltung_id)
      .single()
    if (data) setVerwaltung(data as VerwaltungStammdaten)
  }, [profile?.verwaltung_id])

  useEffect(() => {
    fetchStats()
    fetchNotifications()
    fetchVerwaltung()
  }, [fetchStats, fetchNotifications, fetchVerwaltung])

  useEffect(() => {
    if (!verwToast) return
    const t = setTimeout(() => setVerwToast(null), 3000)
    return () => clearTimeout(t)
  }, [verwToast])

  async function saveVerwaltung() {
    if (!verwaltung || !verwForm) return
    setVerwSaving(true)
    const { error } = await supabase.from('verwaltungen').update({
      ...verwForm,
      updated_at: new Date().toISOString(),
    }).eq('id', verwaltung.id)
    setVerwSaving(false)
    if (error) { setVerwToast(t('dashboard.saveFailed', '❌ Speichern fehlgeschlagen')); return }
    setShowVerwEdit(false)
    setVerwToast(t('dashboard.masterDataUpdated', '✅ Stammdaten aktualisiert'))
    fetchVerwaltung()
  }

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

      {/* ── Eigene Verwaltungs-Stammdaten ─────────────────── */}
      {verwaltung && (
        <section className="mt-8">
          {verwToast && (
            <div className="fixed top-4 right-4 z-50 bg-hp-black text-white text-sm font-body px-4 py-2.5 rounded-xl shadow-lg">
              {verwToast}
            </div>
          )}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body">
              {t('dashboard.myManagement', 'Meine Verwaltung')}
            </h2>
            <button
              onClick={() => {
                setVerwForm({
                  name:                  verwaltung.name,
                  address_street:        verwaltung.address_street,
                  address_zip:           verwaltung.address_zip,
                  address_city:          verwaltung.address_city,
                  address_country:       verwaltung.address_country,
                  phone:                 verwaltung.phone,
                  email:                 verwaltung.email,
                  website:               verwaltung.website,
                  ansprechpartner:       verwaltung.ansprechpartner,
                  ansprechpartner_phone: verwaltung.ansprechpartner_phone,
                  ansprechpartner_email: verwaltung.ansprechpartner_email,
                })
                setShowVerwEdit(true)
              }}
              className="text-xs font-medium font-body hover:underline transition-colors"
              style={{ color: 'var(--color-highlight)' }}>
              {t('dashboard.editMasterDataBtn', '✏️ Stammdaten bearbeiten')}
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-hp-black flex items-center justify-center text-white text-base font-bold shrink-0">
                {verwaltung.name[0].toUpperCase()}
              </div>
              <p className="font-semibold text-hp-black font-body">{verwaltung.name}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm font-body">
              {verwaltung.phone && (
                <a href={`tel:${verwaltung.phone}`}
                   className="flex items-center gap-2 text-gray-600 hover:text-hp-highlight transition-colors">
                  <span>📞</span><span>{verwaltung.phone}</span>
                </a>
              )}
              {verwaltung.email && (
                <a href={`mailto:${verwaltung.email}`}
                   className="flex items-center gap-2 text-gray-600 hover:text-hp-highlight transition-colors truncate">
                  <span>✉️</span><span className="truncate">{verwaltung.email}</span>
                </a>
              )}
              {(verwaltung.address_street || verwaltung.address_city) && (
                <span className="flex items-center gap-2 text-gray-600 col-span-full">
                  <span>📍</span>
                  <span>{[verwaltung.address_street, verwaltung.address_zip, verwaltung.address_city].filter(Boolean).join(', ')}</span>
                </span>
              )}
            </div>
            {verwaltung.ansprechpartner && (
              <div className="pt-2 border-t border-gray-100">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold font-body mb-1">{t('dashboard.contactPerson', 'Ansprechpartner')}</p>
                <p className="text-sm font-semibold text-hp-black font-body">{verwaltung.ansprechpartner}</p>
                <div className="flex flex-wrap gap-x-3 mt-0.5">
                  {verwaltung.ansprechpartner_phone && (
                    <span className="text-xs text-gray-500 font-body">📞 {verwaltung.ansprechpartner_phone}</span>
                  )}
                  {verwaltung.ansprechpartner_email && (
                    <span className="text-xs text-gray-500 font-body">✉️ {verwaltung.ansprechpartner_email}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Modal: Stammdaten bearbeiten */}
      {showVerwEdit && verwForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4 py-8 overflow-y-auto"
             onClick={e => { if (e.target === e.currentTarget) setShowVerwEdit(false) }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
                {t('dashboard.editMasterDataTitle', 'Stammdaten bearbeiten')}
              </h2>
              <button onClick={() => setShowVerwEdit(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">

              <div>
                <p className="text-xs font-semibold text-gray-500 font-body mb-2 uppercase tracking-wide">{t('dashboard.companySection', 'Firma')}</p>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-gray-500 font-body mb-1">{t('dashboard.companyNameLabel', 'Firmenname')}</label>
                    <input className={inputCls} style={focusRing()} value={verwForm.name ?? ''}
                           onChange={e => setVerwForm(f => f && ({ ...f, name: e.target.value }))} />
                  </div>
                  <input className={inputCls} style={focusRing()} placeholder={t('dashboard.streetPlaceholder', 'Straße + Hausnummer')}
                         value={verwForm.address_street ?? ''}
                         onChange={e => setVerwForm(f => f && ({ ...f, address_street: e.target.value || null }))} />
                  <div className="grid grid-cols-3 gap-2">
                    <input className={inputCls} style={focusRing()} placeholder={t('dashboard.zipPlaceholder', 'PLZ')}
                           value={verwForm.address_zip ?? ''}
                           onChange={e => setVerwForm(f => f && ({ ...f, address_zip: e.target.value || null }))} />
                    <input className={`${inputCls} col-span-2`} style={focusRing()} placeholder={t('dashboard.cityPlaceholder', 'Stadt')}
                           value={verwForm.address_city ?? ''}
                           onChange={e => setVerwForm(f => f && ({ ...f, address_city: e.target.value || null }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputCls} style={focusRing()} placeholder={t('dashboard.phonePlaceholder', 'Telefon')} type="tel"
                           value={verwForm.phone ?? ''}
                           onChange={e => setVerwForm(f => f && ({ ...f, phone: e.target.value || null }))} />
                    <input className={inputCls} style={focusRing()} placeholder={t('dashboard.emailPlaceholder', 'E-Mail')} type="email"
                           value={verwForm.email ?? ''}
                           onChange={e => setVerwForm(f => f && ({ ...f, email: e.target.value || null }))} />
                  </div>
                  <input className={inputCls} style={focusRing()} placeholder={t('dashboard.websitePlaceholder', 'Website')}
                         value={verwForm.website ?? ''}
                         onChange={e => setVerwForm(f => f && ({ ...f, website: e.target.value || null }))} />
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-gray-500 font-body mb-2 uppercase tracking-wide">{t('dashboard.contactPerson', 'Ansprechpartner')}</p>
                <div className="space-y-2">
                  <input className={inputCls} style={focusRing()} placeholder={t('dashboard.namePlaceholder', 'Name')}
                         value={verwForm.ansprechpartner ?? ''}
                         onChange={e => setVerwForm(f => f && ({ ...f, ansprechpartner: e.target.value || null }))} />
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputCls} style={focusRing()} placeholder={t('dashboard.directPhonePlaceholder', 'Direkt-Telefon')} type="tel"
                           value={verwForm.ansprechpartner_phone ?? ''}
                           onChange={e => setVerwForm(f => f && ({ ...f, ansprechpartner_phone: e.target.value || null }))} />
                    <input className={inputCls} style={focusRing()} placeholder={t('dashboard.directEmailPlaceholder', 'Direkt-E-Mail')} type="email"
                           value={verwForm.ansprechpartner_email ?? ''}
                           onChange={e => setVerwForm(f => f && ({ ...f, ansprechpartner_email: e.target.value || null }))} />
                  </div>
                </div>
              </div>

            </div>
            <div className="px-6 pb-5 flex gap-3 justify-end border-t border-gray-100 pt-4">
              <button onClick={() => setShowVerwEdit(false)}
                      className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 font-body hover:bg-gray-50">
                {t('dashboard.cancel', 'Abbrechen')}
              </button>
              <button onClick={saveVerwaltung} disabled={verwSaving}
                      className="px-5 py-2 rounded-xl text-sm font-semibold text-white font-body hover:opacity-90 transition-opacity disabled:opacity-50"
                      style={{ backgroundColor: 'var(--color-highlight)' }}>
                {verwSaving ? t('dashboard.saving', 'Speichern…') : t('dashboard.saveBtn', '✓ Speichern')}
              </button>
            </div>
          </div>
        </div>
      )}

    </DashboardLayout>
  )
}
