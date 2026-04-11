import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import type { CrmAppointment } from '../../../lib/crmTypes'
import AppointmentModal from '../../../components/crm/AppointmentModal'
import {
  initGoogleAuth,
  signInGoogle,
  signOutGoogle,
  hasGoogleToken,
  refreshGoogleToken,
  cancelGoogleTokenRefresh,
  listGoogleEvents,
} from '../../../lib/googleCalendar'
import type { GoogleCalendarEvent } from '../../../lib/googleCalendar'

// ── Types ─────────────────────────────────────────────────────────────────────

type CalView = 'month' | 'week' | 'day'

// ── Color coding ──────────────────────────────────────────────────────────────

const APPT_COLORS = {
  zoom:     { bg: '#ede9fe', text: '#7c3aed', pill: '#8b5cf6' },
  inperson: { bg: '#dcfce7', text: '#15803d', pill: '#22c55e' },
  phone:    { bg: '#f3f4f6', text: '#4b5563', pill: '#9ca3af' },
} as const

/** Google-Event Farben: blau für normale, grün für Ganztagstermine (Feiertage) */
function gColor(gEvt: GoogleCalendarEvent) {
  const base = isAllDay(gEvt) ? '#34A853' : '#4285f4'
  return { bg: base, text: '#ffffff', pill: base }
}

/** Ist dieses Google-Event ein Ganztagstermin? */
function isAllDay(gEvt: GoogleCalendarEvent): boolean {
  return !!gEvt.start.date && !gEvt.start.dateTime
}

/** Uhrzeit eines Google-Events – leer bei Ganztagsterminen */
function gEvtTime(gEvt: GoogleCalendarEvent): string {
  if (isAllDay(gEvt)) return ''
  return formatTime(gEvt.start.dateTime ?? '')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DE_DAYS_SHORT  = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const DE_DAYS_LONG   = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']
const DE_MONTHS      = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

/** ISO date string yyyy-mm-dd */
function toDateStr(d: Date): string {
  const y  = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate()  === b.getDate()
}

function isToday(d: Date): boolean {
  return isSameDay(d, new Date())
}

/** Returns Monday of the week containing d (ISO week, Mon=start) */
function getMonday(d: Date): Date {
  const dt  = new Date(d)
  const day = dt.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day
  dt.setDate(dt.getDate() + diff)
  dt.setHours(0, 0, 0, 0)
  return dt
}

function getMonthRange(date: Date): { start: Date; end: Date } {
  const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1)
  const lastOfMonth  = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  const start        = getMonday(firstOfMonth)
  // end: complete a 6-week grid (42 days from start)
  const end = new Date(start)
  end.setDate(start.getDate() + 41)
  end.setHours(23, 59, 59, 999)
  // ensure we cover the last day of month
  if (end < lastOfMonth) end.setTime(lastOfMonth.getTime())
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function getWeekRange(date: Date): { start: Date; end: Date } {
  const start = getMonday(date)
  const end   = new Date(start)
  end.setDate(start.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function getDayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(date)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function formatTime(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return '' }
}

function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)}–${formatTime(end)}`
}

function durationMinutes(start: string, end: string): number {
  try {
    return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000)
  } catch { return 0 }
}

// ── TypeBadge ─────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const colors = APPT_COLORS[type as keyof typeof APPT_COLORS] ?? APPT_COLORS.phone
  const label  = type === 'zoom' ? '📹 Zoom'
    : type === 'inperson' ? '📍 Vor Ort'
    : '📞 Telefon'
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {label}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CrmCalendar() {
  const { t } = useTranslation()

  const [view, setView]               = useState<CalView>('month')
  const [currentDate, setCurrentDate] = useState<Date>(new Date())
  const [appointments, setAppointments] = useState<CrmAppointment[]>([])
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([])
  const [googleConnected, setGoogleConnected] = useState<boolean>(hasGoogleToken())
  const [googleInitialized, setGoogleInitialized] = useState(false)
  const [loading, setLoading]         = useState(false)
  const [showModal, setShowModal]     = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [selectedAppt, setSelectedAppt]       = useState<CrmAppointment | null>(null)
  const [selectedGoogleEvt, setSelectedGoogleEvt] = useState<GoogleCalendarEvent | null>(null)

  // ── Google init ───────────────────────────────────────────────
  // cancelled-Flag verhindert setState nach Unmount (z.B. wenn User die
  // Seite wechselt bevor die Google-Scripts geladen haben).
  useEffect(() => {
    let cancelled = false
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
    if (!clientId) return
    initGoogleAuth()
      .then(() => {
        if (cancelled) return
        setGoogleInitialized(true)
        setGoogleConnected(hasGoogleToken())
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // ── Proaktiver Token-Refresh alle 45 Minuten ──────────────────
  // Erneuert den Access Token im Hintergrund bevor er abläuft.
  // Falls der silent refresh fehlschlägt (z.B. Google-Session abgelaufen),
  // wird der "Mit Google verbinden" Button wieder angezeigt.
  // clearInterval beim Unmount verhindert Timer-Leaks auf anderen Seiten.
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!hasGoogleToken()) return
      const ok = await refreshGoogleToken()
      if (!ok) {
        setGoogleConnected(false)
        setGoogleEvents([])
      }
    }, 45 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // ── Cleanup beim Verlassen der Seite ────────────────────────
  // Verhindert dass der 45-Min-Timer auf anderen Seiten feuert
  // (der localStorage-basierte Token bleibt erhalten).
  useEffect(() => {
    return () => { cancelGoogleTokenRefresh() }
  }, [])

  // ── Range for current view ────────────────────────────────────
  function getRange(): { start: Date; end: Date } {
    if (view === 'month') return getMonthRange(currentDate)
    if (view === 'week')  return getWeekRange(currentDate)
    return getDayRange(currentDate)
  }

  // ── Fetch appointments ────────────────────────────────────────
  const fetchAppointments = useCallback(async (rangeStart: Date, rangeEnd: Date) => {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('crm_appointments')
        .select('*, lead:leads(id, first_name, last_name)')
        .gte('start_time', rangeStart.toISOString())
        .lte('start_time', rangeEnd.toISOString())
        .order('start_time', { ascending: true })
      setAppointments((data ?? []) as CrmAppointment[])
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Fetch Google events ───────────────────────────────────────
  // listGoogleEvents() versucht bei abgelaufenem Token einen silent refresh.
  // Gibt [] zurück wenn der User sich neu verbinden muss → googleConnected auf false.
  const fetchGoogleEvents = useCallback(async (rangeStart: Date, rangeEnd: Date) => {
    if (!googleConnected) return
    try {
      const events = await listGoogleEvents(rangeStart.toISOString(), rangeEnd.toISOString())
      // Leeres Ergebnis UND Token jetzt ungültig → User muss sich neu verbinden
      if (events.length === 0 && !hasGoogleToken()) {
        setGoogleConnected(false)
      }
      setGoogleEvents(events)
    } catch {
      setGoogleEvents([])
    }
  }, [googleConnected])

  // ── Reload on view / date change ──────────────────────────────
  // googleInitialized als Dependency: sobald initGoogleAuth() fertig ist
  // und ein Token im localStorage liegt, werden Google-Events sofort geladen
  // (ohne dass der User erneut auf "Verbinden" klicken muss).
  useEffect(() => {
    const { start, end } = getRange()
    void fetchAppointments(start, end)
    void fetchGoogleEvents(start, end)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentDate, googleConnected, googleInitialized, fetchAppointments, fetchGoogleEvents])

  // ── Navigation ────────────────────────────────────────────────
  function handlePrev() {
    setCurrentDate(prev => {
      const d = new Date(prev)
      if (view === 'month') { d.setMonth(d.getMonth() - 1) }
      else if (view === 'week') { d.setDate(d.getDate() - 7) }
      else { d.setDate(d.getDate() - 1) }
      return d
    })
  }

  function handleNext() {
    setCurrentDate(prev => {
      const d = new Date(prev)
      if (view === 'month') { d.setMonth(d.getMonth() + 1) }
      else if (view === 'week') { d.setDate(d.getDate() + 7) }
      else { d.setDate(d.getDate() + 1) }
      return d
    })
  }

  function handleToday() { setCurrentDate(new Date()) }

  // ── Period label ──────────────────────────────────────────────
  function periodLabel(): string {
    if (view === 'month') {
      return `${DE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`
    }
    if (view === 'week') {
      const { start, end } = getWeekRange(currentDate)
      return `${start.getDate()}. – ${end.getDate()}. ${DE_MONTHS[end.getMonth()]} ${end.getFullYear()}`
    }
    const dow = DE_DAYS_LONG[(currentDate.getDay() + 6) % 7]
    return `${dow}, ${currentDate.getDate()}. ${DE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`
  }

  // ── Events for a given day ────────────────────────────────────
  function appointmentsForDay(d: Date): CrmAppointment[] {
    const ds = toDateStr(d)
    return appointments.filter(a => a.start_time.slice(0, 10) === ds)
  }

  function googleEventsForDay(d: Date): GoogleCalendarEvent[] {
    const ds = toDateStr(d)
    // IDs der CRM-Termine die bereits in Google gespeichert wurden
    const crmGoogleIds = new Set(
      appointments.filter(a => a.google_event_id).map(a => a.google_event_id)
    )
    return googleEvents.filter(e => {
      const eDate = (e.start.dateTime ?? e.start.date ?? '').slice(0, 10)
      // Duplikate ausfiltern: Google-Events die als CRM-Termin existieren nicht nochmal zeigen
      return eDate === ds && !crmGoogleIds.has(e.id)
    })
  }

  // ── Google auth ───────────────────────────────────────────────
  async function handleConnectGoogle() {
    try {
      await signInGoogle()
      setGoogleConnected(true)
    } catch { /* ignore */ }
  }

  function handleDisconnectGoogle() {
    signOutGoogle()
    setGoogleConnected(false)
    setGoogleEvents([])
  }

  // ── Delete appointment ────────────────────────────────────────
  async function handleDelete(id: string) {
    await supabase.from('crm_appointments').delete().eq('id', id)
    setSelectedAppt(null)
    const { start, end } = getRange()
    void fetchAppointments(start, end)
  }

  // ── Reload callback ───────────────────────────────────────────
  function handleCreated() {
    setShowModal(false)
    const { start, end } = getRange()
    void fetchAppointments(start, end)
  }

  // ── MONTH VIEW ────────────────────────────────────────────────
  function renderMonthView() {
    const { start } = getMonthRange(currentDate)
    const cells: Date[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      cells.push(d)
    }
    const inCurrentMonth = (d: Date) => d.getMonth() === currentDate.getMonth()

    return (
      <div className="flex-1 overflow-auto">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-gray-200">
          {DE_DAYS_SHORT.map(d => (
            <div key={d} className="text-center text-xs font-medium text-gray-400 py-2">
              {d}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7 flex-1">
          {cells.map((cellDate, idx) => {
            const appts  = appointmentsForDay(cellDate)
            const gEvts  = googleEventsForDay(cellDate)
            const allEvts = appts.length + gEvts.length
            const visible = appts.slice(0, 3)
            const gVisible= gEvts.slice(0, Math.max(0, 3 - appts.length))
            const overflow = allEvts - visible.length - gVisible.length

            return (
              <div
                key={idx}
                className={`min-h-[90px] border-b border-r border-gray-100 p-1 cursor-pointer hover:bg-gray-50 transition-colors ${
                  !inCurrentMonth(cellDate) ? 'bg-gray-50/60' : ''
                }`}
                onClick={() => { setSelectedDate(cellDate); setShowModal(true) }}
              >
                <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                  isToday(cellDate)
                    ? 'text-white'
                    : inCurrentMonth(cellDate)
                      ? 'text-gray-700'
                      : 'text-gray-300'
                }`}
                  style={isToday(cellDate) ? { backgroundColor: '#ff795d' } : {}}
                >
                  {cellDate.getDate()}
                </div>

                <div className="space-y-0.5">
                  {visible.map(appt => {
                    const time = formatTime(appt.start_time)
                    return (
                      <div
                        key={appt.id}
                        className="truncate font-semibold cursor-pointer hover:opacity-85"
                        style={{
                          backgroundColor: '#ff795d',
                          color: '#fff',
                          fontSize: '11px',
                          padding: '2px 4px',
                          borderRadius: '3px',
                        }}
                        onClick={e => { e.stopPropagation(); setSelectedAppt(appt) }}
                      >
                        ● {time ? `${time} ` : ''}{appt.title}
                      </div>
                    )
                  })}
                  {gVisible.map(gEvt => {
                    const gc    = gColor(gEvt)
                    const time  = gEvtTime(gEvt)
                    const allDy = isAllDay(gEvt)
                    return (
                      <div
                        key={gEvt.id}
                        className="truncate font-semibold cursor-pointer hover:opacity-80"
                        style={{
                          backgroundColor: gc.bg,
                          color: gc.text,
                          fontSize: allDy ? '10px' : '11px',
                          fontWeight: allDy ? 400 : 600,
                          opacity: allDy ? 0.85 : 1,
                          padding: '2px 4px',
                          borderRadius: '3px',
                          width: allDy ? '100%' : undefined,
                        }}
                        onClick={e => { e.stopPropagation(); setSelectedGoogleEvt(gEvt) }}
                      >
                        {allDy ? '◦' : '●'} {time ? `${time} ` : ''}{gEvt.summary}
                      </div>
                    )
                  })}
                  {overflow > 0 && (
                    <div className="text-[10px] text-gray-400 pl-1">
                      +{overflow} {t('crm.calendar.more', 'mehr')}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── WEEK VIEW ─────────────────────────────────────────────────
  function renderWeekView() {
    const { start } = getWeekRange(currentDate)
    const days: Date[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      days.push(d)
    }

    return (
      <div className="flex-1 overflow-auto">
        {/* Header */}
        <div className="grid grid-cols-7 border-b border-gray-200">
          {days.map((d, i) => (
            <div key={i} className={`text-center py-3 text-sm ${isToday(d) ? 'font-bold' : ''}`}>
              <span className="text-gray-500 text-xs block">{DE_DAYS_SHORT[i]}</span>
              <span
                className="inline-flex items-center justify-center w-7 h-7 rounded-full text-sm font-semibold"
                style={isToday(d) ? { backgroundColor: '#ff795d', color: '#fff' } : { color: '#374151' }}
              >
                {d.getDate()}
              </span>
            </div>
          ))}
        </div>

        {/* Events */}
        <div className="grid grid-cols-7 gap-0">
          {days.map((d, i) => {
            const appts = appointmentsForDay(d)
            const gEvts = googleEventsForDay(d)
            return (
              <div key={i} className="border-r border-gray-100 p-2 min-h-[200px]">
                {appts.length === 0 && gEvts.length === 0 && (
                  <p className="text-xs text-gray-300 mt-2 text-center">–</p>
                )}
                {appts.map(appt => {
                  const colors = APPT_COLORS[appt.type as keyof typeof APPT_COLORS] ?? APPT_COLORS.phone
                  return (
                    <div
                      key={appt.id}
                      className="mb-1.5 p-1.5 rounded-lg cursor-pointer hover:opacity-90"
                      style={{ backgroundColor: colors.bg }}
                      onClick={() => setSelectedAppt(appt)}
                    >
                      <p className="text-[10px] font-medium" style={{ color: colors.text }}>
                        {formatTime(appt.start_time)}
                      </p>
                      <p className="text-xs font-semibold text-gray-800 truncate">{appt.title}</p>
                      <TypeBadge type={appt.type} />
                    </div>
                  )
                })}
                {gEvts.map(gEvt => {
                  const gc    = gColor(gEvt)
                  const time  = gEvtTime(gEvt)
                  const allDy = isAllDay(gEvt)
                  return (
                    <div
                      key={gEvt.id}
                      className="mb-1.5 p-1.5 rounded-lg cursor-pointer hover:opacity-80"
                      style={{ backgroundColor: gc.bg, opacity: allDy ? 0.85 : 1 }}
                      onClick={() => setSelectedGoogleEvt(gEvt)}
                    >
                      {time && (
                        <p className="text-[10px] font-medium" style={{ color: gc.text }}>
                          {time}
                        </p>
                      )}
                      <p className="text-xs font-semibold truncate" style={{ color: gc.text }}>
                        {gEvt.summary}
                      </p>
                      {allDy && (
                        <p className="text-[10px]" style={{ color: gc.text, opacity: 0.8 }}>
                          {t('crm.calendar.allDay', 'Ganztägig')}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── DAY VIEW ──────────────────────────────────────────────────
  function renderDayView() {
    const appts = appointmentsForDay(currentDate)
    const gEvts = googleEventsForDay(currentDate)
    const dow   = DE_DAYS_LONG[(currentDate.getDay() + 6) % 7]
    const dateLabel = `${dow}, ${currentDate.getDate()}. ${DE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`

    return (
      <div className="flex-1 overflow-auto p-4">
        <h2 className="text-base font-semibold text-gray-700 mb-4 font-body">{dateLabel}</h2>

        {appts.length === 0 && gEvts.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-12">
            {t('crm.calendar.noAppts', 'Keine Termine')}
          </p>
        )}

        <div className="space-y-3">
          {appts.map(appt => {
            const colors = APPT_COLORS[appt.type as keyof typeof APPT_COLORS] ?? APPT_COLORS.phone
            return (
              <div
                key={appt.id}
                className="rounded-xl border p-4 cursor-pointer hover:shadow-sm transition-shadow"
                style={{ borderColor: colors.pill, backgroundColor: colors.bg }}
                onClick={() => setSelectedAppt(appt)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-gray-900 font-body">{appt.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatTimeRange(appt.start_time, appt.end_time)}
                    </p>
                  </div>
                  <TypeBadge type={appt.type} />
                </div>
                {appt.zoom_link && (
                  <a
                    href={appt.zoom_link}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 text-xs text-blue-600 underline block truncate"
                    onClick={e => e.stopPropagation()}
                  >
                    {appt.zoom_link}
                  </a>
                )}
                {appt.location && (
                  <p className="text-xs text-gray-500 mt-1">📍 {appt.location}</p>
                )}
                {appt.lead && (
                  <p className="text-xs text-gray-500 mt-1">
                    👤 {appt.lead.first_name} {appt.lead.last_name}
                  </p>
                )}
              </div>
            )
          })}

          {gEvts.map(gEvt => {
            const gc      = gColor(gEvt)
            const allDy   = isAllDay(gEvt)
            const timeStr = allDy
              ? t('crm.calendar.allDay', 'Ganztägig')
              : `${formatTime(gEvt.start.dateTime ?? '')} – ${formatTime(gEvt.end.dateTime ?? '')}`
            return (
              <div
                key={gEvt.id}
                className="rounded-xl border p-4 cursor-pointer hover:shadow-sm transition-shadow"
                style={{ borderColor: gc.pill, backgroundColor: `${gc.bg}18`, opacity: allDy ? 0.8 : 1 }}
                onClick={() => setSelectedGoogleEvt(gEvt)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div
                      className="w-1 self-stretch rounded-full flex-shrink-0 mt-1"
                      style={{ backgroundColor: gc.pill }}
                    />
                    <div>
                      <p className="text-sm font-bold text-gray-900 font-body">{gEvt.summary}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{timeStr}</p>
                    </div>
                  </div>
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full text-white flex-shrink-0"
                    style={{ backgroundColor: gc.pill }}>
                    Google
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── CRM Detail popup ──────────────────────────────────────────
  function renderDetailPopup() {
    if (!selectedAppt) return null
    const appt = selectedAppt
    const dur  = durationMinutes(appt.start_time, appt.end_time)

    return (
      <div
        className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
        onClick={() => setSelectedAppt(null)}
      >
        <div
          className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5 relative"
          onClick={e => e.stopPropagation()}
        >
          {/* Close */}
          <button
            onClick={() => setSelectedAppt(null)}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>

          <div className="flex items-start gap-3 mb-4">
            <div className="flex-1">
              {/* CRM badge */}
              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full text-white mb-1"
                style={{ backgroundColor: '#ff795d' }}>
                ✏️ {t('crm.calendar.crmEvent', 'CRM Termin')}
              </span>
              <p className="text-base font-bold text-gray-900 font-body pr-6">{appt.title}</p>
              <div className="mt-1">
                <TypeBadge type={appt.type} />
              </div>
            </div>
          </div>

          <div className="space-y-2 text-sm text-gray-600">
            {/* Date + time */}
            <div>
              📅{' '}
              {new Date(appt.start_time).toLocaleDateString('de-DE', {
                weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
              })}
              {' · '}
              {formatTimeRange(appt.start_time, appt.end_time)}
              {dur > 0 && ` (${dur} min)`}
            </div>

            {/* Zoom */}
            {appt.type === 'zoom' && appt.zoom_link && (
              <div>
                <a
                  href={appt.zoom_link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                  style={{ backgroundColor: '#2d8cff' }}
                >
                  📹 {t('crm.appt.joinZoom', 'Zoom beitreten')}
                </a>
              </div>
            )}

            {/* In-person */}
            {appt.type === 'inperson' && appt.location && (
              <div>
                📍 {appt.location}
                {appt.location_url && (
                  <> ·{' '}
                    <a
                      href={appt.location_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline ml-1"
                    >
                      Maps
                    </a>
                  </>
                )}
              </div>
            )}

            {/* Phone */}
            {appt.type === 'phone' && appt.phone_number && (
              <div>📞 {appt.phone_number}</div>
            )}

            {/* Lead */}
            {appt.lead && (
              <div>
                👤{' '}
                <Link
                  to={`/admin/crm/leads/${appt.lead.id}`}
                  className="text-[#ff795d] underline"
                  onClick={() => setSelectedAppt(null)}
                >
                  {appt.lead.first_name} {appt.lead.last_name}
                </Link>
              </div>
            )}
          </div>

          {/* Delete */}
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t('crm.calendar.confirmDelete', 'Termin wirklich löschen?'))) {
                void handleDelete(appt.id)
              }
            }}
            className="mt-5 w-full py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
          >
            {t('crm.calendar.deleteAppt', 'Termin löschen')}
          </button>
        </div>
      </div>
    )
  }

  // ── Google Event Detail popup ─────────────────────────────────
  function renderGoogleDetailPopup() {
    if (!selectedGoogleEvt) return null
    const gEvt    = selectedGoogleEvt
    const gc      = gColor(gEvt)
    const allDy   = isAllDay(gEvt)
    const timeStr = allDy
      ? t('crm.calendar.allDay', 'Ganztägig')
      : `${formatTime(gEvt.start.dateTime ?? '')} – ${formatTime(gEvt.end.dateTime ?? '')}`
    const dateStr = new Date(
      gEvt.start.dateTime ?? gEvt.start.date ?? ''
    ).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })

    return (
      <div
        className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
        onClick={() => setSelectedGoogleEvt(null)}
      >
        <div
          className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5 relative"
          onClick={e => e.stopPropagation()}
        >
          {/* Close */}
          <button
            onClick={() => setSelectedGoogleEvt(null)}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>

          {/* Google badge */}
          <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full text-white mb-2"
            style={{ backgroundColor: gc.pill }}>
            Google {allDy ? '🌿' : '📅'}
          </span>

          <p className="text-base font-bold text-gray-900 font-body pr-6 mb-3">{gEvt.summary}</p>

          <div className="space-y-2 text-sm text-gray-600">
            <div>📅 {dateStr} · {timeStr}</div>
          </div>

          {/* "In Google öffnen" Link */}
          {gEvt.htmlLink && (
            <a
              href={gEvt.htmlLink}
              target="_blank"
              rel="noreferrer"
              className="mt-5 w-full py-2 text-sm font-medium text-white rounded-lg flex items-center justify-center gap-2"
              style={{ backgroundColor: gc.pill, display: 'flex' }}
            >
              {t('crm.calendar.openInGoogle', 'In Google Kalender öffnen')} ↗
            </a>
          )}

          {/* Hinweis: nur lesen */}
          <p className="text-center text-xs text-gray-400 mt-3">
            {t('crm.calendar.googleReadOnly', 'Google-Termine können nur in Google bearbeitet werden.')}
          </p>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="flex flex-col h-full min-h-screen bg-gray-50">

        {/* ── Row 1: Title + Google ── */}
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <h1 className="text-2xl font-bold text-gray-900 font-body">
            {t('crm.calendar.title', 'Kalender')}
          </h1>

          <div className="flex items-center gap-2">
            {googleInitialized && !googleConnected && (
              <button
                type="button"
                onClick={() => void handleConnectGoogle()}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {t('crm.calendar.connectGoogle', 'Mit Google verbinden')}
              </button>
            )}
            {googleInitialized && googleConnected && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-green-600 font-medium">
                  {t('crm.calendar.googleConnected', 'Google verbunden ✓')}
                </span>
                <button
                  type="button"
                  onClick={handleDisconnectGoogle}
                  className="text-xs text-gray-500 underline hover:text-gray-700"
                >
                  {t('crm.calendar.disconnect', 'Trennen')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Row 2: Nav + view switcher + new button ── */}
        <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-gray-200 bg-white">
          {/* Prev / Today / Next */}
          <div className="flex items-center gap-1">
            <button
              onClick={handlePrev}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              ← {t('crm.calendar.back', 'Zurück')}
            </button>
            <button
              onClick={handleToday}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              {t('crm.calendar.today', 'Heute')}
            </button>
            <button
              onClick={handleNext}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              {t('crm.calendar.forward', 'Weiter')} →
            </button>
          </div>

          {/* Period label */}
          <span className="text-sm font-semibold text-gray-700 flex-1 text-center font-body">
            {periodLabel()}
          </span>

          {/* View switcher */}
          <div className="flex gap-1">
            {(['month', 'week', 'day'] as CalView[]).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className="px-3 py-1.5 text-sm rounded-lg transition-colors"
                style={
                  view === v
                    ? { backgroundColor: '#ff795d', color: '#fff' }
                    : { backgroundColor: '#f3f4f6', color: '#374151' }
                }
              >
                {v === 'month' ? t('crm.calendar.viewMonth', 'Monat')
                  : v === 'week' ? t('crm.calendar.viewWeek', 'Woche')
                  : t('crm.calendar.viewDay', 'Tag')}
              </button>
            ))}
          </div>

          {/* New appointment */}
          <button
            type="button"
            onClick={() => { setSelectedDate(currentDate); setShowModal(true) }}
            className="px-4 py-1.5 text-sm font-medium text-white rounded-lg"
            style={{ backgroundColor: '#ff795d' }}
          >
            + {t('crm.calendar.newAppt', 'Termin anlegen')}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-4">
            <span className="inline-block w-5 h-5 border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Calendar body */}
        <div className="flex-1 flex flex-col bg-white mx-6 my-4 rounded-xl border border-gray-200 overflow-hidden">
          {view === 'month' && renderMonthView()}
          {view === 'week'  && renderWeekView()}
          {view === 'day'   && renderDayView()}
        </div>
      </div>

      {/* Appointment creation modal */}
      {showModal && (
        <AppointmentModal
          initialDate={selectedDate}
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}

      {/* CRM Detail popup */}
      {renderDetailPopup()}

      {/* Google Event Detail popup */}
      {renderGoogleDetailPopup()}
    </DashboardLayout>
  )
}
