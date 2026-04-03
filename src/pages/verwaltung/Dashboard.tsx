import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Types ──────────────────────────────────────────────────────
interface TodayBooking {
  id:         string
  check_in:   string
  check_out:  string
  property:   { project_name: string; unit_number: string | null } | null
  guest:      { full_name: string } | null
}

interface WeekBooking {
  id:        string
  check_in:  string
  check_out: string
  property:  { project_name: string } | null
}

interface Property {
  id:           string
  project_name: string
  unit_number:  string | null
}

// ── Helpers ────────────────────────────────────────────────────
function startOfWeek(d: Date) {
  const day = d.getDay()                         // 0=Sun, 1=Mon …
  const diff = (day === 0 ? -6 : 1 - day)        // shift to Mon
  const mon = new Date(d)
  mon.setDate(d.getDate() + diff)
  mon.setHours(0, 0, 0, 0)
  return mon
}

function addDays(d: Date, n: number) {
  const r = new Date(d)
  r.setDate(d.getDate() + n)
  return r
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
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

// ── Invoice Upload Modal ──────────────────────────────────────
interface InvoiceModalProps {
  properties: Property[]
  onClose:    () => void
  onSuccess:  () => void
}

function InvoiceModal({ properties, onClose, onSuccess }: InvoiceModalProps) {
  const { t } = useTranslation()
  const { profile } = useAuth()

  const [form, setForm] = useState({
    property_id:  '',
    title:        '',
    creditor:     '',
    amount_gross: '',
  })
  const [file,     setFile]     = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [err,      setErr]      = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function set(k: keyof typeof form, v: string) {
    setForm(f => ({ ...f, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !form.property_id || !form.title) {
      setErr(t('errors.required', { field: '' }).replace(' ist ein Pflichtfeld.', ''))
      return
    }
    setUploading(true)
    setErr(null)
    try {
      const ext  = file.name.split('.').pop() ?? 'pdf'
      const path = `documents/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

      const { error: storageErr } = await supabase.storage
        .from('documents')
        .upload(path, file, { contentType: file.type })

      if (storageErr) throw storageErr

      const { data: urlData } = supabase.storage.from('documents').getPublicUrl(path)

      const { error: dbErr } = await supabase.from('documents').insert({
        property_id:  form.property_id,
        title:        form.title,
        document_type: 'rechnung',
        creditor:     form.creditor || null,
        amount_gross: form.amount_gross ? parseFloat(form.amount_gross) : null,
        file_url:     urlData.publicUrl,
        uploaded_by:  profile?.id ?? null,
      })

      if (dbErr) throw dbErr
      onSuccess()
    } catch {
      setErr(t('errors.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  const inputCls = `w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm
    font-body text-hp-black placeholder-gray-300 focus:outline-none
    focus:ring-2 focus:ring-hp-highlight focus:border-transparent transition`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         style={{ backgroundColor: 'rgba(0,0,0,0.35)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold font-heading text-hp-black">
            {t('dashboard.verwalter.invoiceModal.title')}
          </h2>
          <button onClick={onClose}
                  className="text-gray-400 hover:text-gray-600 transition-colors text-xl leading-none">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Property */}
          <div>
            <label className="block text-xs font-medium text-gray-500 font-body mb-1">
              {t('dashboard.verwalter.invoiceModal.property')} <span className="text-red-400">*</span>
            </label>
            <select value={form.property_id} onChange={e => set('property_id', e.target.value)}
                    className={inputCls} required>
              <option value="">{t('documents.selectProperty')}</option>
              {properties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.project_name}{p.unit_number ? ` (${p.unit_number})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-gray-500 font-body mb-1">
              {t('dashboard.verwalter.invoiceModal.docTitle')} <span className="text-red-400">*</span>
            </label>
            <input type="text" value={form.title} onChange={e => set('title', e.target.value)}
                   placeholder={t('documents.titleField')} className={inputCls} required />
          </div>

          {/* Creditor */}
          <div>
            <label className="block text-xs font-medium text-gray-500 font-body mb-1">
              {t('dashboard.verwalter.invoiceModal.creditor')}
            </label>
            <input type="text" value={form.creditor} onChange={e => set('creditor', e.target.value)}
                   placeholder={t('documents.creditor')} className={inputCls} />
          </div>

          {/* Amount */}
          <div>
            <label className="block text-xs font-medium text-gray-500 font-body mb-1">
              {t('dashboard.verwalter.invoiceModal.amountGross')}
            </label>
            <input type="number" step="0.01" min="0" value={form.amount_gross}
                   onChange={e => set('amount_gross', e.target.value)}
                   placeholder="0.00" className={inputCls} />
          </div>

          {/* File */}
          <div>
            <label className="block text-xs font-medium text-gray-500 font-body mb-1">
              {t('dashboard.verwalter.invoiceModal.file')} <span className="text-red-400">*</span>
            </label>
            <input type="file" accept="application/pdf" ref={fileRef}
                   onChange={e => setFile(e.target.files?.[0] ?? null)}
                   className="hidden" />
            <button type="button" onClick={() => fileRef.current?.click()}
                    className="w-full px-3 py-2 rounded-xl border-2 border-dashed border-gray-200
                               text-sm font-body text-gray-400 hover:border-gray-300 transition-colors text-left">
              {file ? file.name : t('documents.file')}
            </button>
          </div>

          {err && (
            <p className="text-xs text-red-500 font-body">{err}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
                    className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200
                               text-sm font-semibold font-body text-gray-600 hover:bg-gray-50 transition-colors">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={uploading}
                    className="flex-1 px-4 py-2.5 rounded-xl text-white text-sm
                               font-semibold font-body disabled:opacity-50 transition-opacity"
                    style={{ backgroundColor: 'var(--color-highlight)' }}>
              {uploading
                ? t('dashboard.verwalter.invoiceModal.uploading')
                : t('dashboard.verwalter.invoiceModal.upload')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Week Calendar ─────────────────────────────────────────────
function WeekCalendar({ bookings, loading }: { bookings: WeekBooking[]; loading: boolean }) {
  const { t } = useTranslation()
  const today  = new Date()
  const mon    = startOfWeek(today)
  const days   = Array.from({ length: 7 }, (_, i) => addDays(mon, i))

  const COLORS = [
    'bg-orange-400', 'bg-blue-400', 'bg-green-400', 'bg-purple-400',
    'bg-teal-400',   'bg-pink-400', 'bg-amber-400',
  ]

  // assign stable color per booking id
  const colorOf = (id: string) => COLORS[parseInt(id.replace(/-/g, '').slice(0, 8), 16) % COLORS.length]

  const dayLabels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {loading ? (
        <div className="p-6 h-32 flex items-center justify-center">
          <div className="w-full h-8 bg-gray-100 rounded-lg animate-pulse" />
        </div>
      ) : (
        <div className="p-5">
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {days.map((d, i) => {
              const isToday = isoDate(d) === isoDate(today)
              return (
                <div key={i} className="text-center">
                  <div className={`text-xs font-body font-medium
                                   ${isToday ? 'text-orange-500' : 'text-gray-400'}`}>
                    {dayLabels[i]}
                  </div>
                  <div className={`text-sm font-bold font-body mt-0.5 w-7 h-7 rounded-full
                                   flex items-center justify-center mx-auto
                                   ${isToday
                                     ? 'text-white'
                                     : 'text-gray-600'}`}
                       style={isToday ? { backgroundColor: 'var(--color-highlight)' } : {}}>
                    {d.getDate()}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Booking bars */}
          {bookings.length === 0 ? (
            <div className="mt-4 text-center text-sm text-gray-400 font-body py-4">
              {t('bookings.empty')}
            </div>
          ) : (
            <div className="mt-3 space-y-1.5">
              {bookings.map(b => {
                const monIso = isoDate(mon)
                const sunIso = isoDate(addDays(mon, 6))
                const ciIso  = b.check_in  > monIso ? b.check_in  : monIso
                const coIso  = b.check_out < sunIso ? b.check_out : sunIso

                const ciDay  = clamp(
                  Math.floor((new Date(ciIso).getTime() - mon.getTime()) / 86400000),
                  0, 6
                )
                const coDay  = clamp(
                  Math.floor((new Date(coIso).getTime() - mon.getTime()) / 86400000),
                  0, 6
                )
                const span = coDay - ciDay + 1
                if (span < 1) return null

                return (
                  <div key={b.id} className="grid grid-cols-7 gap-1 items-center">
                    {Array.from({ length: 7 }, (_, i) => {
                      if (i === ciDay) {
                        return (
                          <div key={i}
                               className={`col-span-${span} ${colorOf(b.id)} rounded-full
                                           px-2 py-0.5 text-white text-xs font-body
                                           truncate font-medium`}
                               style={{ gridColumn: `${ciDay + 1} / span ${span}` }}>
                            {b.property?.project_name ?? '–'}
                          </div>
                        )
                      }
                      if (i < ciDay || i > coDay) {
                        return <div key={i} />
                      }
                      return null
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Verwalter Dashboard ────────────────────────────────────────
export default function VerwaltungDashboard() {
  const { t }       = useTranslation()
  const { profile } = useAuth()
  const navigate    = useNavigate()

  const [checkinsToday,  setCheckinsToday]  = useState<TodayBooking[]>([])
  const [checkoutsToday, setCheckoutsToday] = useState<TodayBooking[]>([])
  const [occupiedCount,  setOccupiedCount]  = useState(0)
  const [weekBookings,   setWeekBookings]   = useState<WeekBooking[]>([])

  const [houseRulesPending,  setHouseRulesPending]  = useState(0)
  const [expiringContracts,  setExpiringContracts]  = useState(0)
  const [unreadMessages,     setUnreadMessages]     = useState(0)

  const [properties, setProperties] = useState<Property[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const today   = new Date()
      const todayIso = isoDate(today)
      const mon     = startOfWeek(today)
      const sun     = addDays(mon, 6)
      const in30d   = isoDate(addDays(today, 30))

      const [
        ciRes, coRes, occupiedRes,
        weekRes, hrRes, contractRes, msgRes, propRes,
      ] = await Promise.all([
        // Today check-ins
        supabase.from('bookings')
          .select('id, check_in, check_out, property:property_id(project_name, unit_number), guest:guest_id(full_name)')
          .eq('check_in', todayIso)
          .limit(50),

        // Today check-outs
        supabase.from('bookings')
          .select('id, check_in, check_out, property:property_id(project_name, unit_number), guest:guest_id(full_name)')
          .eq('check_out', todayIso)
          .limit(50),

        // Occupied today (count)
        supabase.from('bookings')
          .select('*', { count: 'exact', head: true })
          .lte('check_in',  todayIso)
          .gte('check_out', todayIso),

        // Week bookings
        supabase.from('bookings')
          .select('id, check_in, check_out, property:property_id(project_name)')
          .lte('check_in',  isoDate(sun))
          .gte('check_out', isoDate(mon))
          .order('check_in', { ascending: true })
          .limit(100),

        // House rules pending
        supabase.from('guest_agreements')
          .select('*', { count: 'exact', head: true })
          .eq('agreed', false),

        // Expiring contracts (30d)
        supabase.from('contracts')
          .select('*', { count: 'exact', head: true })
          .gte('end_date', todayIso)
          .lte('end_date', in30d),

        // Unread messages
        supabase.from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('is_read', false),

        // Properties for invoice modal
        supabase.from('properties')
          .select('id, project_name, unit_number')
          .order('project_name', { ascending: true })
          .limit(500),
      ])

      setCheckinsToday((ciRes.data  ?? []) as unknown as TodayBooking[])
      setCheckoutsToday((coRes.data ?? []) as unknown as TodayBooking[])
      setOccupiedCount(occupiedRes.count ?? 0)
      setWeekBookings((weekRes.data ?? []) as unknown as WeekBooking[])
      setHouseRulesPending(hrRes.count ?? 0)
      setExpiringContracts(contractRes.count ?? 0)
      setUnreadMessages(msgRes.count ?? 0)
      setProperties((propRes.data ?? []) as Property[])
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const todayStr = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })

  const totalPendingTasks = houseRulesPending + expiringContracts + unreadMessages

  return (
    <DashboardLayout basePath="/verwaltung/dashboard">

      {/* ── Toast ───────────────────────────────────────────── */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 px-5 py-3 rounded-2xl shadow-xl
                        text-white text-sm font-body font-medium animate-fade-in"
             style={{ backgroundColor: 'var(--color-highlight)' }}>
          {toast}
        </div>
      )}

      {/* ── Invoice Modal ────────────────────────────────────── */}
      {showInvoice && (
        <InvoiceModal
          properties={properties}
          onClose={() => setShowInvoice(false)}
          onSuccess={() => {
            setShowInvoice(false)
            showToast(t('dashboard.verwalter.invoiceModal.success'))
          }}
        />
      )}

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-hp-black"
              style={{ fontFamily: 'var(--font-heading)' }}>
            {t('dashboard.greeting')}, {profile?.full_name?.split(' ')[0] ?? t('roles.verwalter')} 👋
          </h1>
          <p className="mt-1 text-sm text-gray-400 font-body capitalize">{todayStr}</p>
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

      {/* ── 1. Heute im Überblick ────────────────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t('dashboard.verwalter.todayLabel', { date: todayStr })}</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* Check-ins */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🟢</span>
              <h3 className="text-sm font-semibold font-body text-hp-black">
                {t('dashboard.verwalter.checkinsToday')}
              </h3>
              <span className="ml-auto text-lg font-bold font-body text-hp-black tabular-nums">
                {loading ? <Skeleton w="w-6" h="h-6" /> : checkinsToday.length}
              </span>
            </div>
            {loading ? (
              <div className="space-y-2">
                <div className="h-4 w-3/4 bg-gray-100 animate-pulse rounded" />
                <div className="h-4 w-1/2 bg-gray-100 animate-pulse rounded" />
              </div>
            ) : checkinsToday.length === 0 ? (
              <p className="text-xs text-gray-400 font-body">{t('dashboard.verwalter.noCheckins')}</p>
            ) : (
              <ul className="space-y-1.5">
                {checkinsToday.map(b => (
                  <li key={b.id} className="text-xs font-body text-gray-600 truncate">
                    <span className="font-medium text-hp-black">
                      {b.guest?.full_name ?? '–'}
                    </span>
                    {b.property && (
                      <span className="text-gray-400">
                        {' · '}{b.property.project_name}
                        {b.property.unit_number ? ` (${b.property.unit_number})` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Occupied */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🏡</span>
              <h3 className="text-sm font-semibold font-body text-hp-black">
                {t('dashboard.verwalter.occupied')}
              </h3>
              <span className="ml-auto text-lg font-bold font-body text-hp-black tabular-nums">
                {loading ? <Skeleton w="w-6" h="h-6" /> : occupiedCount}
              </span>
            </div>
            {loading ? (
              <div className="h-4 w-2/3 bg-gray-100 animate-pulse rounded" />
            ) : occupiedCount === 0 ? (
              <p className="text-xs text-gray-400 font-body">{t('dashboard.verwalter.noOccupied')}</p>
            ) : (
              <button
                onClick={() => navigate('/verwaltung/bookings')}
                className="text-xs font-body text-orange-500 hover:underline">
                {t('common.actions')} →
              </button>
            )}
          </div>

          {/* Check-outs */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🔴</span>
              <h3 className="text-sm font-semibold font-body text-hp-black">
                {t('dashboard.verwalter.checkoutsToday')}
              </h3>
              <span className="ml-auto text-lg font-bold font-body text-hp-black tabular-nums">
                {loading ? <Skeleton w="w-6" h="h-6" /> : checkoutsToday.length}
              </span>
            </div>
            {loading ? (
              <div className="space-y-2">
                <div className="h-4 w-3/4 bg-gray-100 animate-pulse rounded" />
                <div className="h-4 w-1/2 bg-gray-100 animate-pulse rounded" />
              </div>
            ) : checkoutsToday.length === 0 ? (
              <p className="text-xs text-gray-400 font-body">{t('dashboard.verwalter.noCheckouts')}</p>
            ) : (
              <ul className="space-y-1.5">
                {checkoutsToday.map(b => (
                  <li key={b.id} className="text-xs font-body text-gray-600 truncate">
                    <span className="font-medium text-hp-black">
                      {b.guest?.full_name ?? '–'}
                    </span>
                    {b.property && (
                      <span className="text-gray-400">
                        {' · '}{b.property.project_name}
                        {b.property.unit_number ? ` (${b.property.unit_number})` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>
      </section>

      {/* ── 2. Schnellaktionen ─────────────────────────────────── */}
      <section className="mb-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            onClick={() => navigate('/verwaltung/bookings')}
            className="flex items-center gap-4 px-6 py-5 rounded-2xl text-white shadow-sm
                       hover:shadow-md hover:-translate-y-0.5 transition-all text-left"
            style={{ backgroundColor: 'var(--color-highlight)' }}>
            <span className="text-3xl">📅</span>
            <div>
              <div className="font-bold font-heading text-base">{t('dashboard.verwalter.newBooking')}</div>
              <div className="text-xs opacity-80 font-body mt-0.5">{t('bookings.add')}</div>
            </div>
          </button>

          <button
            onClick={() => setShowInvoice(true)}
            className="flex items-center gap-4 px-6 py-5 rounded-2xl bg-white border border-gray-100
                       shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all text-left">
            <span className="text-3xl">🧾</span>
            <div>
              <div className="font-bold font-heading text-base text-hp-black">
                {t('dashboard.verwalter.newInvoice')}
              </div>
              <div className="text-xs text-gray-400 font-body mt-0.5">
                {t('documents.upload')}
              </div>
            </div>
          </button>
        </div>
      </section>

      {/* ── 3. Ausstehende Aufgaben ─────────────────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t('dashboard.verwalter.pendingTasks')}</SectionTitle>

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-16 bg-white rounded-2xl border border-gray-100 animate-pulse" />
            ))}
          </div>
        ) : totalPendingTasks === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-6 py-8
                          text-center text-sm text-gray-400 font-body">
            ✅ {t('dashboard.verwalter.noTasks')}
          </div>
        ) : (
          <div className="space-y-3">

            {/* House rules pending */}
            {houseRulesPending > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4
                              flex flex-col sm:flex-row sm:items-center gap-3">
                <span className="text-xl shrink-0">📋</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-amber-800 font-body">
                    {houseRulesPending}× {t('dashboard.verwalter.houseRulesPending')}
                  </p>
                  <p className="text-xs text-amber-600 font-body mt-0.5">
                    {t('guest.houseRules.pendingDesc')}
                  </p>
                </div>
                <button onClick={() => navigate('/verwaltung/bookings')}
                        className="shrink-0 px-4 py-2 text-xs font-semibold font-body rounded-xl
                                   bg-amber-100 text-amber-800 border border-amber-200
                                   hover:bg-amber-200 transition-colors">
                  {t('dashboard.verwalter.sendReminder')}
                </button>
              </div>
            )}

            {/* Expiring contracts */}
            {expiringContracts > 0 && (
              <div className="bg-orange-50 border border-orange-200 rounded-2xl px-5 py-4
                              flex flex-col sm:flex-row sm:items-center gap-3">
                <span className="text-xl shrink-0">📄</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-orange-800 font-body">
                    {expiringContracts}× {t('dashboard.verwalter.expiringContracts')}
                  </p>
                  <p className="text-xs text-orange-600 font-body mt-0.5">
                    {t('dashboard.admin.taskExpiresOn')} — 30 Tage
                  </p>
                </div>
                <button onClick={() => navigate('/objekte')}
                        className="shrink-0 px-4 py-2 text-xs font-semibold font-body rounded-xl
                                   bg-orange-100 text-orange-800 border border-orange-200
                                   hover:bg-orange-200 transition-colors">
                  {t('dashboard.verwalter.viewContract')}
                </button>
              </div>
            )}

            {/* Unread messages */}
            {unreadMessages > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl px-5 py-4
                              flex flex-col sm:flex-row sm:items-center gap-3">
                <span className="text-xl shrink-0">💬</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-blue-800 font-body">
                    {unreadMessages}× {t('dashboard.verwalter.unreadMessages')}
                  </p>
                  <p className="text-xs text-blue-600 font-body mt-0.5">
                    {t('guest.messages.subtitle')}
                  </p>
                </div>
                <button onClick={() => navigate('/verwaltung/bookings')}
                        className="shrink-0 px-4 py-2 text-xs font-semibold font-body rounded-xl
                                   bg-blue-100 text-blue-800 border border-blue-200
                                   hover:bg-blue-200 transition-colors">
                  {t('dashboard.verwalter.reply')}
                </button>
              </div>
            )}

          </div>
        )}
      </section>

      {/* ── 4. Wochenübersicht ──────────────────────────────────── */}
      <section>
        <SectionTitle>{t('dashboard.verwalter.weekCalendar')}</SectionTitle>
        <WeekCalendar bookings={weekBookings} loading={loading} />
      </section>

    </DashboardLayout>
  )
}
