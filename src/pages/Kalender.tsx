import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../components/DashboardLayout'
import BookingModal, { type ModalProperty } from '../components/BookingModal'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

// ── Types ──────────────────────────────────────────────────────
interface CalBook {
  id:              string
  booking_number:  string | null
  check_in:        string
  check_out:       string
  status:          'confirmed' | 'cancelled' | 'pending'
  source:          'manual' | 'airbnb' | 'booking_com' | null
  is_owner_stay:   boolean
  total_price:     number | null
  price_per_night: number | null
  cleaning_fee:    number | null
  checkin_time:    string | null
  checkout_time:   string | null
  key_handover:    string | null
  wifi_name:       string | null
  wifi_password:   string | null
  parking_info:    string | null
  emergency_contact: string | null
  house_rules:     string | null
  property: {
    id:           string
    project_name: string
    unit_number:  string | null
    rental_type:  'shortterm' | 'longterm'
  } | null
  guest: {
    id:        string
    full_name: string
    email:     string
    phone:     string | null
  } | null
  _rulesAgreed?: boolean
}

// ── Date helpers ───────────────────────────────────────────────
function ds(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

// Build 6-week grid starting Monday before the 1st of month
function buildMonthGrid(year: number, month: number): Date[][] {
  const first  = new Date(year, month, 1)
  const startOfGrid = new Date(first)
  const dow = startOfGrid.getDay() // 0=Sun
  startOfGrid.setDate(startOfGrid.getDate() - (dow === 0 ? 6 : dow - 1))
  const weeks: Date[][] = []
  let cur = new Date(startOfGrid)
  for (let w = 0; w < 6; w++) {
    const week: Date[] = []
    for (let d = 0; d < 7; d++) { week.push(new Date(cur)); cur = addDays(cur, 1) }
    weeks.push(week)
  }
  return weeks
}

// ── Booking color ──────────────────────────────────────────────
function bookingStyle(b: CalBook): React.CSSProperties {
  if (b.status === 'cancelled')              return { backgroundColor: '#9ca3af' }
  if (b.is_owner_stay)                       return { backgroundColor: '#7c3aed' }
  if (b.property?.rental_type === 'longterm') return { backgroundColor: '#16a34a' }
  switch (b.source) {
    case 'airbnb':      return { backgroundColor: '#ff385c' }
    case 'booking_com': return { backgroundColor: '#003580' }
    default:            return { backgroundColor: '#ff795d' }
  }
}

// ── Lane assignment for week row ───────────────────────────────
interface LanedBook { booking: CalBook; lane: number; col: number; span: number }

function assignLanes(bookings: CalBook[], wStart: Date, wEnd: Date): LanedBook[] {
  const wStartStr = ds(wStart)
  const wEndStr   = ds(addDays(wEnd, 1))
  const sorted    = [...bookings].sort((a, b) => a.check_in.localeCompare(b.check_in))

  const result: LanedBook[] = []
  const laneEndAt: string[] = []

  for (const b of sorted) {
    const effStart = b.check_in  > wStartStr ? b.check_in  : wStartStr
    const effEnd   = b.check_out < wEndStr   ? b.check_out : wEndStr
    const startDate = new Date(effStart)
    const endDate   = new Date(effEnd)
    const col  = Math.round((startDate.getTime() - wStart.getTime()) / 86400000)
    const span = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000))

    let lane = 0
    while (lane < laneEndAt.length && laneEndAt[lane] > b.check_in) lane++
    laneEndAt[lane] = b.check_out
    result.push({ booking: b, lane, col, span })
  }
  return result
}

// ── Constants ─────────────────────────────────────────────────
const DAY_H   = 30  // px — day number header
const LANE_H  = 22  // px — each booking bar
const MAX_VIS = 3   // max lanes before "+N more"

// ── Detail popup ───────────────────────────────────────────────
function BookingDetail({
  booking, canEdit, onClose, onCancel,
}: { booking: CalBook; canEdit: boolean; onClose: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const nights = Math.max(0, Math.round(
    (new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86400000
  ))
  const bStyle = bookingStyle(booking)

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>

        {/* Header bar */}
        <div className="rounded-t-2xl px-5 py-4 text-white flex items-center justify-between"
             style={bStyle}>
          <div>
            <p className="text-xs font-body opacity-80">
              {booking.source === 'airbnb'      ? 'Airbnb'
                : booking.source === 'booking_com' ? 'Booking.com'
                : booking.property?.rental_type === 'longterm'
                  ? t('calendar.source.longterm')
                  : t('calendar.source.manual')}
            </p>
            <h3 className="font-bold text-lg font-body">
              {booking.guest?.full_name ?? '—'}
            </h3>
          </div>
          <button onClick={onClose}
                  className="w-8 h-8 rounded-full bg-white/20 flex items-center
                             justify-center hover:bg-white/30 transition-colors">
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Dates */}
          <div className="grid grid-cols-3 gap-3 text-sm font-body">
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-400 mb-0.5">{t('bookings.checkIn')}</p>
              <p className="font-bold text-hp-black">
                {new Date(booking.check_in).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })}
              </p>
              {booking.checkin_time && (
                <p className="text-xs text-gray-400">ab {booking.checkin_time}</p>
              )}
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-400 mb-0.5">{t('calendar.modal.nights')}</p>
              <p className="font-bold text-hp-black">{nights}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-400 mb-0.5">{t('bookings.checkOut')}</p>
              <p className="font-bold text-hp-black">
                {new Date(booking.check_out).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })}
              </p>
              {booking.checkout_time && (
                <p className="text-xs text-gray-400">bis {booking.checkout_time}</p>
              )}
            </div>
          </div>

          {/* Property */}
          {booking.property && (
            <div className="flex items-center gap-2 text-sm font-body">
              <span className="text-gray-400">🏠</span>
              <span className="text-hp-black">
                {booking.property.project_name}
                {booking.property.unit_number ? ` · ${booking.property.unit_number}` : ''}
              </span>
            </div>
          )}

          {/* Price */}
          {booking.total_price != null && (
            <div className="flex items-center justify-between text-sm font-body">
              <span className="text-gray-400">{t('calendar.modal.totalPrice')}</span>
              <span className="font-bold text-hp-black">
                {booking.total_price.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}
              </span>
            </div>
          )}

          {/* Guest contact */}
          {booking.guest && (
            <div className="border border-gray-100 rounded-xl p-3 space-y-1 text-sm font-body">
              <p className="font-semibold text-hp-black">{booking.guest.full_name}</p>
              <p className="text-gray-400">{booking.guest.email}</p>
              {booking.guest.phone && <p className="text-gray-400">{booking.guest.phone}</p>}
            </div>
          )}

          {/* Check-in info */}
          {(booking.key_handover || booking.wifi_name || booking.parking_info) && (
            <div className="space-y-1.5">
              {booking.key_handover && (
                <div className="text-xs font-body">
                  <span className="text-gray-400">🔑 </span>
                  <span className="text-hp-black">{booking.key_handover}</span>
                </div>
              )}
              {booking.wifi_name && (
                <div className="text-xs font-body">
                  <span className="text-gray-400">📶 </span>
                  <span className="text-hp-black">{booking.wifi_name}</span>
                  {booking.wifi_password && <span className="text-gray-400"> · {booking.wifi_password}</span>}
                </div>
              )}
              {booking.parking_info && (
                <div className="text-xs font-body">
                  <span className="text-gray-400">🚗 </span>
                  <span className="text-hp-black">{booking.parking_info}</span>
                </div>
              )}
            </div>
          )}

          {/* House rules status */}
          <div className={`text-xs font-body px-3 py-2 rounded-xl
            ${booking._rulesAgreed ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
            {booking._rulesAgreed ? t('calendar.detail.rulesAgreed') : t('calendar.detail.rulesPending')}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            {canEdit && booking.status !== 'cancelled' && (
              <button onClick={onCancel}
                      className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-body
                                 border border-red-200 text-red-500 hover:bg-red-50 transition-colors">
                {t('calendar.detail.cancel')}
              </button>
            )}
            <button onClick={onClose}
                    className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-body
                               bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Cancel dialog ──────────────────────────────────────────────
function CancelDialog({
  booking, cancelling, onConfirm, onClose,
}: { booking: CalBook; cancelling: boolean; onConfirm: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60"
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
           onClick={e => e.stopPropagation()}>
        <div className="text-center mb-5">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
            <span className="text-red-500 text-xl">⚠</span>
          </div>
          <h3 className="font-bold text-hp-black font-body mb-1">
            {t('calendar.detail.cancelConfirm')}
          </h3>
          <p className="text-sm text-gray-500 font-body">
            {booking.guest?.full_name},&nbsp;
            {new Date(booking.check_in).toLocaleDateString('de-DE', { day: '2-digit', month: 'long' })}
          </p>
          <p className="text-xs text-gray-400 font-body mt-2">{t('calendar.detail.cancelDesc')}</p>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-body
                             border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={onConfirm} disabled={cancelling}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-body text-white
                             hover:opacity-90 disabled:opacity-60 transition-opacity flex items-center
                             justify-center gap-2 bg-red-500">
            {cancelling && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {t('calendar.detail.cancelYes')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// Main Calendar
// ══════════════════════════════════════════════════════════════
export default function Kalender() {
  const { t }       = useTranslation()
  const { profile, dashboardPath } = useAuth()

  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d }, [])
  const todayStr = ds(today)

  const [year,  setYear]  = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())

  const [bookings,        setBookings]        = useState<CalBook[]>([])
  const [properties,      setProperties]      = useState<ModalProperty[]>([])
  const [propFilter,      setPropFilter]      = useState<string>('all')
  const [loading,         setLoading]         = useState(true)
  const [toastMsg,        setToastMsg]        = useState('')
  const [ownerNightsMap,  setOwnerNightsMap]  = useState<Map<string, number>>(new Map())

  const [showModal,    setShowModal]    = useState(false)
  const [presetDate,   setPresetDate]   = useState<string | null>(null)
  const [detailBook,   setDetailBook]   = useState<CalBook | null>(null)
  const [cancelTarget, setCancelTarget] = useState<CalBook | null>(null)
  const [cancelling,   setCancelling]   = useState(false)

  const isAdmin = profile?.role === 'admin' || profile?.role === 'verwalter'
  const isOwner = profile?.role === 'eigentuemer'

  // Grid
  const grid      = useMemo(() => buildMonthGrid(year, month), [year, month])
  const gridStart = grid[0][0]
  const gridEnd   = grid[grid.length - 1][6]

  // ── Properties ──────────────────────────────────────────────
  useEffect(() => {
    if (!profile) return
    ;(async () => {
      let q = supabase
        .from('properties')
        .select('id, project_name, unit_number, rental_type, owner_id')
        .order('project_name')
      if (isOwner) q = (q as typeof q).eq('owner_id', profile.id)
      const { data } = await q
      setProperties((data ?? []) as ModalProperty[])
    })()
  }, [profile, isOwner])

  // ── Bookings ─────────────────────────────────────────────────
  const fetchBookings = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    try {
      const startStr = ds(gridStart)
      const endStr   = ds(addDays(gridEnd, 1))

      let q = supabase
        .from('bookings')
        .select(`
          id, booking_number, check_in, check_out, status, source, is_owner_stay,
          total_price, price_per_night, cleaning_fee,
          checkin_time, checkout_time, key_handover,
          wifi_name, wifi_password, parking_info, emergency_contact, house_rules,
          property:property_id(id, project_name, unit_number, rental_type),
          guest:guest_id(id, full_name, email, phone)
        `)
        .lt('check_in', endStr)
        .gt('check_out', startStr)
        .order('check_in')

      if (propFilter !== 'all') q = (q as typeof q).eq('property_id', propFilter)

      if (isOwner) {
        const ids = properties.map(p => p.id)
        if (ids.length === 0) { setBookings([]); return }
        q = (q as typeof q).in('property_id', ids)
      }

      const { data } = await q
      if (!data) { setBookings([]); return }

      // Load house rules agreement status
      const bookingIds = data.map((b: Record<string, unknown>) => b.id as string)
      const { data: agreements } = await supabase
        .from('guest_agreements')
        .select('booking_id, agreed_at')
        .in('booking_id', bookingIds)

      const agreedSet = new Set(
        (agreements ?? [])
          .filter((a: Record<string, unknown>) => a.agreed_at)
          .map((a: Record<string, unknown>) => a.booking_id as string)
      )

      setBookings((data as unknown as CalBook[]).map(b => ({
        ...b, _rulesAgreed: agreedSet.has(b.id),
      })))

      // Owner nights per property for the current calendar year (tooltip)
      const calYear   = gridStart.getFullYear()
      const yearStart = `${calYear}-01-01`
      const yearEnd   = `${calYear + 1}-01-01`
      let ownerQ = supabase
        .from('bookings')
        .select('property_id, check_in, check_out')
        .eq('is_owner_stay', true)
        .neq('status', 'cancelled')
        .gte('check_in', yearStart)
        .lt('check_in', yearEnd)
      if (isOwner) {
        const ids = properties.map(p => p.id)
        if (ids.length > 0) ownerQ = (ownerQ as typeof ownerQ).in('property_id', ids)
      }
      const { data: ownerData } = await ownerQ
      const newMap = new Map<string, number>()
      for (const stay of ownerData ?? []) {
        const n = Math.max(0, Math.round(
          (new Date(stay.check_out as string).getTime() -
           new Date(stay.check_in  as string).getTime()) / 86400000
        ))
        const pid = stay.property_id as string
        newMap.set(pid, (newMap.get(pid) ?? 0) + n)
      }
      setOwnerNightsMap(newMap)
    } finally {
      setLoading(false)
    }
  }, [profile, gridStart, gridEnd, propFilter, isOwner, properties])

  useEffect(() => { fetchBookings() }, [fetchBookings])

  // ── Navigation ───────────────────────────────────────────────
  function prevMonth() { month === 0 ? (setYear(y => y-1), setMonth(11)) : setMonth(m => m-1) }
  function nextMonth() { month === 11 ? (setYear(y => y+1), setMonth(0))  : setMonth(m => m+1) }
  function goToday()  { setYear(today.getFullYear()); setMonth(today.getMonth()) }

  // ── Cancel ───────────────────────────────────────────────────
  async function handleCancelConfirm() {
    if (!cancelTarget) return
    setCancelling(true)
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', cancelTarget.id)
    setCancelling(false)
    setCancelTarget(null)
    setDetailBook(null)
    showToast(t('calendar.detail.cancelled'))
    fetchBookings()
  }

  function showToast(msg: string) {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(''), 3500)
  }

  // ── Labels ───────────────────────────────────────────────────
  const monthName     = t(`dates.months.${month + 1}`)
  const weekdayShorts = [1,2,3,4,5,6,7].map(d => t(`dates.weekdaysShort.${d}`))

  // ── Render ───────────────────────────────────────────────────
  return (
    <DashboardLayout basePath={dashboardPath}>

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
          {t('calendar.title')}
        </h1>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Property filter */}
          <select
            value={propFilter}
            onChange={e => setPropFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-200 rounded-xl font-body
                       focus:outline-none focus:border-hp-highlight bg-white text-hp-black">
            <option value="all">{t('calendar.allProperties')}</option>
            {properties.map(p => (
              <option key={p.id} value={p.id}>
                {p.project_name}{p.unit_number ? ` · ${p.unit_number}` : ''}
              </option>
            ))}
          </select>

          {/* New booking button */}
          <button
            onClick={() => { setPresetDate(null); setShowModal(true) }}
            className="px-4 py-2 rounded-xl text-white text-sm font-semibold font-body
                       hover:opacity-90 transition-opacity whitespace-nowrap"
            style={{ backgroundColor: 'var(--color-highlight)' }}>
            {t('calendar.newBooking')}
          </button>
        </div>
      </div>

      {/* Calendar card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

        {/* Month navigation */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <button onClick={prevMonth}
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-gray-500
                             hover:bg-gray-100 transition-colors text-lg font-bold">
            ‹
          </button>
          <div className="flex items-center gap-4">
            <button onClick={goToday}
                    className="px-3 py-1.5 text-xs font-semibold font-body rounded-lg
                               border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors">
              {t('calendar.today')}
            </button>
            <h2 className="text-base font-bold text-hp-black font-body min-w-[140px] text-center">
              {monthName} {year}
            </h2>
          </div>
          <button onClick={nextMonth}
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-gray-500
                             hover:bg-gray-100 transition-colors text-lg font-bold">
            ›
          </button>
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 border-b border-gray-100">
          {weekdayShorts.map(wd => (
            <div key={wd} className="py-2 text-center text-xs font-semibold text-gray-400 font-body">
              {wd}
            </div>
          ))}
        </div>

        {/* Loading overlay */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-gray-300 gap-2 text-sm font-body">
            <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          </div>
        )}

        {/* Week rows */}
        {!loading && grid.map((week, weekIdx) => {
          const wStart    = week[0]
          const wEnd      = week[6]
          const wStartStr = ds(wStart)
          const wEndStr   = ds(addDays(wEnd, 1))

          // Bookings overlapping this week
          const wBookings = bookings.filter(b =>
            b.check_in < wEndStr && b.check_out > wStartStr
          )
          const assigned = assignLanes(wBookings, wStart, wEnd)
          const maxLane  = assigned.reduce((m, a) => Math.max(m, a.lane), -1)

          // Overflow count per column
          const overflow = Array(7).fill(0)
          assigned.filter(a => a.lane >= MAX_VIS).forEach(({ col, span }) => {
            for (let c = col; c < Math.min(col + span, 7); c++) overflow[c]++
          })

          const hasOverflow = overflow.some(n => n > 0)
          const rowH = DAY_H + Math.min(maxLane + 1, MAX_VIS) * LANE_H
                     + (hasOverflow ? LANE_H : 4)

          return (
            <div
              key={weekIdx}
              className={`relative border-b border-gray-100 ${weekIdx === grid.length - 1 ? 'border-b-0' : ''}`}
              style={{ height: rowH }}>

              {/* Day cells */}
              <div className="grid grid-cols-7 h-full">
                {week.map((day, dayIdx) => {
                  const dayStr         = ds(day)
                  const isCurMonth     = day.getMonth() === month
                  const isToday        = dayStr === todayStr
                  return (
                    <div
                      key={dayIdx}
                      className={`${dayIdx < 6 ? 'border-r' : ''} border-gray-100 cursor-pointer
                        transition-colors select-none
                        ${isCurMonth ? 'bg-white hover:bg-orange-50/40' : 'bg-gray-50/60'}`}
                      onClick={() => { setPresetDate(dayStr); setShowModal(true) }}>
                      <div className="px-2 pt-1.5">
                        <span className={`
                          text-xs font-body inline-flex items-center justify-center w-5 h-5
                          ${isToday
                            ? 'rounded-full text-white font-bold'
                            : isCurMonth ? 'text-gray-700' : 'text-gray-300'}
                        `} style={isToday ? { backgroundColor: 'var(--color-highlight)' } : {}}>
                          {day.getDate()}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Booking bars */}
              {assigned.filter(a => a.lane < MAX_VIS).map(({ booking, lane, col, span }) => {
                const isStart  = booking.check_in  >= wStartStr
                const isEnd    = booking.check_out <= wEndStr
                const bStyle   = bookingStyle(booking)
                const showName = isStart || col === 0
                const propId   = booking.property?.id ?? ''
                const ownerNights = ownerNightsMap.get(propId) ?? 0
                const tooltipTitle = booking.is_owner_stay
                  ? `Eigennutzung ${gridStart.getFullYear()} – ${ownerNights} / 14 Nächte`
                  : booking.guest?.full_name ?? undefined
                return (
                  <div
                    key={booking.id}
                    title={tooltipTitle}
                    className="absolute overflow-hidden text-white font-body font-medium
                               cursor-pointer hover:brightness-110 transition-all select-none
                               flex items-center"
                    style={{
                      ...bStyle,
                      top:    DAY_H + lane * LANE_H + 1,
                      left:   `calc(${col / 7 * 100}% + 2px)`,
                      width:  `calc(${span / 7 * 100}% - 4px)`,
                      height: LANE_H - 3,
                      fontSize: 11,
                      borderRadius: `${isStart ? 4 : 0}px ${isEnd ? 4 : 0}px ${isEnd ? 4 : 0}px ${isStart ? 4 : 0}px`,
                      paddingLeft: isStart ? 6 : 2,
                      paddingRight: 4,
                      opacity: booking.status === 'cancelled' ? 0.5 : 1,
                    }}
                    onClick={e => { e.stopPropagation(); setDetailBook(booking) }}>
                    {showName && (
                      <span className="truncate leading-none">
                        {booking.is_owner_stay
                          ? `🏠 ${booking.guest?.full_name ?? '—'}`
                          : (booking.guest?.full_name ?? (booking.property?.project_name ?? '—'))}
                      </span>
                    )}
                  </div>
                )
              })}

              {/* Overflow indicators */}
              {overflow.map((count, colIdx) => count > 0 ? (
                <div
                  key={colIdx}
                  className="absolute text-xs text-gray-400 font-body cursor-pointer
                             hover:text-hp-highlight transition-colors flex items-center"
                  style={{
                    top:         DAY_H + MAX_VIS * LANE_H + 2,
                    left:        `calc(${colIdx / 7 * 100}% + 4px)`,
                    width:       `calc(${1/7 * 100}% - 8px)`,
                    height:      LANE_H - 4,
                    fontSize:    10,
                  }}
                  onClick={e => { e.stopPropagation(); /* could open day view */ }}>
                  +{count}
                </div>
              ) : null)}
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
        {([
          ['#ff795d', 'calendar.source.manual'],
          ['#ff385c', 'calendar.source.airbnb'],
          ['#003580', 'calendar.source.booking_com'],
          ['#16a34a', 'calendar.source.longterm'],
          ['#7c3aed', 'calendar.source.ownerStay'],
          ['#9ca3af', 'calendar.status.cancelled'],
        ] as [string, string][]).map(([color, key]) => (
          <div key={color} className="flex items-center gap-1.5">
            <div className="w-3 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
            <span className="text-xs text-gray-400 font-body">{t(key)}</span>
          </div>
        ))}
      </div>

      {/* Booking detail popup */}
      {detailBook && (
        <BookingDetail
          booking={detailBook}
          canEdit={isAdmin}
          onClose={() => setDetailBook(null)}
          onCancel={() => { setCancelTarget(detailBook); setDetailBook(null) }}
        />
      )}

      {/* Cancel confirmation */}
      {cancelTarget && (
        <CancelDialog
          booking={cancelTarget}
          cancelling={cancelling}
          onConfirm={handleCancelConfirm}
          onClose={() => setCancelTarget(null)}
        />
      )}

      {/* New booking modal */}
      {showModal && (
        <BookingModal
          properties={properties.filter(p => p.rental_type === 'shortterm')}
          presetDate={presetDate}
          isOwner={isOwner}
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false)
            showToast(t('calendar.modal.created'))
            fetchBookings()
          }}
        />
      )}

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-6 right-6 z-50 px-5 py-3 bg-hp-black text-white text-sm
                        font-body rounded-2xl shadow-xl flex items-center gap-3 animate-slide-up">
          <span>✓</span> {toastMsg}
        </div>
      )}
    </DashboardLayout>
  )
}
