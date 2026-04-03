import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { sendWhatsApp } from '../lib/whatsapp'

// ── Types ──────────────────────────────────────────────────────
export interface ModalProperty {
  id:           string
  project_name: string
  unit_number:  string | null
  rental_type:  'shortterm' | 'longterm'
  owner_id:     string
}

interface ProfileSearchResult {
  id:        string
  full_name: string
  email:     string
  phone:     string | null
  role:      'feriengast' | 'eigentuemer' | 'mieter'
}

interface ExistingGuest {
  id:        string
  full_name: string
  email:     string
  phone:     string | null
  role:      string
}

interface Props {
  properties:  ModalProperty[]
  presetDate:  string | null   // YYYY-MM-DD
  isOwner:     boolean
  onClose:     () => void
  onCreated:   () => void
}

type Step = 1 | 2 | 3 | 4

interface FormState {
  // Step 1
  propertyId:          string
  checkIn:             string
  checkOut:            string
  pricePerNightGross:  string
  vatRate:             string
  cleaningFeeGross:    string
  // Step 2
  firstName:           string
  lastName:            string
  email:               string
  phone:               string
  nationality:         string
  language:            'de' | 'en'
  guestCount:          string
  // Step 3
  checkinTime:         string
  checkoutTime:        string
  keyHandover:         string
  wifiName:            string
  wifiPassword:        string
  parkingInfo:         string
  emergencyContact:    string
  houseRules:          string
  cancellationPolicy:  string
  // Step 4
  sendConfirmation:    boolean
  sendInvitation:      boolean
}

const EMPTY_FORM: FormState = {
  propertyId: '', checkIn: '', checkOut: '',
  pricePerNightGross: '', vatRate: '19', cleaningFeeGross: '',
  firstName: '', lastName: '', email: '',
  phone: '', nationality: '', language: 'de', guestCount: '2',
  checkinTime: '15:00', checkoutTime: '11:00',
  keyHandover: '', wifiName: '', wifiPassword: '',
  parkingInfo: '', emergencyContact: '', houseRules: '',
  cancellationPolicy: '',
  sendConfirmation: true, sendInvitation: true,
}

// ── Helpers ────────────────────────────────────────────────────
function nightCount(ci: string, co: string): number {
  if (!ci || !co) return 0
  return Math.max(0, Math.round(
    (new Date(co).getTime() - new Date(ci).getTime()) / 86400000
  ))
}

function fmtEur(n: number): string {
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}

// ── Step indicator ─────────────────────────────────────────────
function StepDot({ n, active, done }: { n: number; active: boolean; done: boolean }) {
  return (
    <div
      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold font-body
        transition-colors ${done ? 'bg-green-500 text-white' : active
          ? 'text-white' : 'bg-gray-100 text-gray-400'}`}
      style={active ? { backgroundColor: 'var(--color-highlight)' } : {}}>
      {done ? '✓' : n}
    </div>
  )
}

const inputCls = `w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-white text-sm
  font-body text-hp-black placeholder-gray-300 focus:outline-none
  focus:ring-2 focus:ring-hp-highlight focus:border-transparent transition`

const inputClsDisabled = `w-full px-3 py-2.5 rounded-xl border border-gray-100 bg-gray-50 text-sm
  font-body text-gray-400 cursor-not-allowed`

const textCls = `w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-white text-sm
  font-body text-hp-black placeholder-gray-300 focus:outline-none
  focus:ring-2 focus:ring-hp-highlight focus:border-transparent transition resize-none`

// ── Main component ─────────────────────────────────────────────
export default function BookingModal({ properties, presetDate, isOwner: _isOwner, onClose, onCreated }: Props) {
  const { t } = useTranslation()

  const [step, setStep] = useState<Step>(1)
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM, checkIn: presetDate ?? '' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const [avail,  setAvail]  = useState<'idle' | 'checking' | 'ok' | 'no'>('idle')

  // ── Guest mode ─────────────────────────────────────────────
  const [guestMode,       setGuestMode]       = useState<'search' | 'new'>('search')
  const [guestSearch,     setGuestSearch]     = useState('')
  const [guestResults,    setGuestResults]    = useState<ProfileSearchResult[]>([])
  const [guestSearching,  setGuestSearching]  = useState(false)
  const [selectedProfile, setSelectedProfile] = useState<ProfileSearchResult | null>(null)

  // ── New-guest mode lookup ──────────────────────────────────
  const [existing,     setExisting]     = useState<ExistingGuest | null>(null)
  const [emailChecked, setEmailChecked] = useState(false)

  // ── Tax warning ────────────────────────────────────────────
  const [showTaxWarning,  setShowTaxWarning]  = useState(false)
  const [ownerUsedNights, setOwnerUsedNights] = useState(0)
  const taxWarningResolveRef = useRef<((proceed: boolean) => void) | null>(null)

  const setF = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  // ── Owner guest detection ──────────────────────────────────
  const isOwnerGuest =
    guestMode === 'search'
      ? selectedProfile?.role === 'eigentuemer'
      : existing?.role === 'eigentuemer'

  // ── Auto-zero prices when owner guest is detected ──────────
  useEffect(() => {
    if (isOwnerGuest) {
      setForm(f => ({ ...f, pricePerNightGross: '0', cleaningFeeGross: '0' }))
    }
  }, [isOwnerGuest])

  // ── Pricing calculations ────────────────────────────────────
  const nights     = nightCount(form.checkIn, form.checkOut)
  const vatPct     = parseFloat(form.vatRate) || 19
  const vatMul     = 1 + vatPct / 100
  const ppnGross   = isOwnerGuest ? 0 : (parseFloat(form.pricePerNightGross) || 0)
  const ppnNet     = ppnGross / vatMul
  const cfGross    = isOwnerGuest ? 0 : (parseFloat(form.cleaningFeeGross) || 0)
  const cfNet      = cfGross / vatMul
  const totalGross = isOwnerGuest ? 0 : (nights * ppnGross + cfGross)
  const totalNet   = isOwnerGuest ? 0 : (nights * ppnNet + cfNet)
  const vatAmount  = totalGross - totalNet

  const selectedProp = properties.find(p => p.id === form.propertyId)

  // ── Availability check ─────────────────────────────────────
  const checkAvail = useCallback(async (pid: string, ci: string, co: string) => {
    if (!pid || !ci || !co || ci >= co) { setAvail('idle'); return }
    setAvail('checking')
    const { data } = await supabase
      .from('bookings')
      .select('id')
      .eq('property_id', pid)
      .neq('status', 'cancelled')
      .lt('check_in', co)
      .gt('check_out', ci)
    setAvail((data ?? []).length === 0 ? 'ok' : 'no')
  }, [])

  useEffect(() => {
    if (form.propertyId && form.checkIn && form.checkOut) {
      const timer = setTimeout(() => checkAvail(form.propertyId, form.checkIn, form.checkOut), 400)
      return () => clearTimeout(timer)
    } else {
      setAvail('idle')
    }
  }, [form.propertyId, form.checkIn, form.checkOut, checkAvail])

  // ── Guest search (search mode) ─────────────────────────────
  const searchGuests = useCallback(async (query: string) => {
    if (query.trim().length < 2) { setGuestResults([]); return }
    setGuestSearching(true)
    try {
      const q = query.trim()
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, role')
        .in('role', ['feriengast', 'eigentuemer', 'mieter'])
        .or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
        .order('full_name')
        .limit(20)
      setGuestResults((data ?? []) as ProfileSearchResult[])
    } finally {
      setGuestSearching(false)
    }
  }, [])

  useEffect(() => {
    if (guestMode !== 'search' || selectedProfile) return
    const timer = setTimeout(() => searchGuests(guestSearch), 400)
    return () => clearTimeout(timer)
  }, [guestSearch, guestMode, selectedProfile, searchGuests])

  // ── Email lookup (new mode) ────────────────────────────────
  const lookupEmail = useCallback(async (email: string) => {
    if (!email.includes('@')) { setExisting(null); setEmailChecked(false); return }
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone, role')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle()
    setExisting(data as ExistingGuest | null)
    setEmailChecked(true)
    if (data) {
      const parts = (data as ExistingGuest).full_name.split(/\s+/)
      setForm(f => ({
        ...f,
        firstName: parts[0] ?? '',
        lastName:  parts.slice(1).join(' '),
        phone:     (data as ExistingGuest).phone ?? f.phone,
      }))
    }
  }, [])

  useEffect(() => {
    if (guestMode !== 'new' || !form.email) return
    const timer = setTimeout(() => lookupEmail(form.email), 600)
    return () => clearTimeout(timer)
  }, [form.email, guestMode, lookupEmail])

  // ── Profile selection helpers ──────────────────────────────
  function selectProfile(p: ProfileSearchResult) {
    setSelectedProfile(p)
    setGuestResults([])
    const parts = p.full_name.trim().split(/\s+/)
    setForm(f => ({
      ...f,
      firstName: parts[0] ?? '',
      lastName:  parts.slice(1).join(' '),
      email:     p.email,
      phone:     p.phone ?? '',
    }))
  }

  function clearSelectedProfile() {
    setSelectedProfile(null)
    setGuestSearch('')
    setForm(f => ({ ...f, firstName: '', lastName: '', email: '', phone: '' }))
  }

  function switchGuestMode(mode: 'search' | 'new') {
    setGuestMode(mode)
    setSelectedProfile(null)
    setGuestSearch('')
    setGuestResults([])
    setExisting(null)
    setEmailChecked(false)
    setForm(f => ({ ...f, firstName: '', lastName: '', email: '', phone: '' }))
  }

  // ── Check owner 14-night limit ─────────────────────────────
  async function checkOwnerNights(): Promise<{ used: number; total: number }> {
    const ownerId     = (guestMode === 'search' ? selectedProfile?.id : existing?.id) ?? ''
    const bookingYear = new Date(form.checkIn).getFullYear()
    const yearStart   = `${bookingYear}-01-01`
    const yearEnd     = `${bookingYear + 1}-01-01`
    const { data } = await supabase
      .from('bookings')
      .select('check_in, check_out')
      .eq('property_id', form.propertyId)
      .eq('guest_id', ownerId)
      .eq('is_owner_stay', true)
      .neq('status', 'cancelled')
      .gte('check_in', yearStart)
      .lt('check_in', yearEnd)
    const used = (data ?? []).reduce(
      (sum, b) => sum + nightCount(b.check_in, b.check_out), 0
    )
    return { used, total: used + nights }
  }

  // ── Validation ─────────────────────────────────────────────
  function validateStep(s: Step): string {
    if (s === 1) {
      if (!form.propertyId) return t('calendar.modal.errorMissing')
      if (!form.checkIn || !form.checkOut) return t('calendar.modal.errorMissing')
      if (form.checkIn >= form.checkOut) return t('calendar.modal.errorDates')
      if (avail === 'no') return t('calendar.modal.errorOverlap')
      if (avail !== 'ok') return t('calendar.modal.checking')
    }
    if (s === 2) {
      if (guestMode === 'search') {
        if (!selectedProfile) return t('calendar.modal.errorMissing')
      } else {
        if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim())
          return t('calendar.modal.errorMissing')
      }
    }
    if (s === 3) {
      if (!form.houseRules.trim()) return t('calendar.modal.errorMissing')
    }
    return ''
  }

  function nextStep() {
    const err = validateStep(step)
    if (err) { setError(err); return }
    setError('')
    setStep(s => (s < 4 ? (s + 1) as Step : s))
  }

  // ── Create booking ─────────────────────────────────────────
  async function handleCreate() {
    const err = validateStep(4)
    if (err) { setError(err); return }
    setSaving(true)
    setError('')
    try {
      // Owner 14-night check
      if (isOwnerGuest) {
        const { used, total } = await checkOwnerNights()
        if (total > 14) {
          setOwnerUsedNights(used)
          setSaving(false)
          setShowTaxWarning(true)
          const proceed = await new Promise<boolean>(resolve => {
            taxWarningResolveRef.current = resolve
          })
          setShowTaxWarning(false)
          if (!proceed) return
          setSaving(true)
        }
      }

      const email    = form.email.trim().toLowerCase()
      const fullName = `${form.firstName.trim()} ${form.lastName.trim()}`.trim()

      // 1. Resolve guest ID
      const knownId = guestMode === 'search' ? selectedProfile?.id : existing?.id
      let guestId: string

      if (knownId) {
        guestId = knownId
      } else {
        // Invite new guest
        const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          email,
          {
            data: { full_name: fullName, needs_password_setup: true },
            redirectTo: `${window.location.origin}/set-password`,
          }
        )
        if (authErr) throw new Error(authErr.message)
        guestId = authData.user.id
        await supabaseAdmin.from('profiles').upsert({
          id:          guestId,
          email,
          full_name:   fullName,
          phone:       form.phone.trim() || null,
          language:    form.language,
          nationality: form.nationality.trim() || null,
          role:        'feriengast',
          is_active:   true,
        })
      }

      // 2. Booking number
      const bNum = `B-${form.checkIn.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

      // 3. Insert booking
      // Base fields: Spalten die sicher in der DB existieren
      const basePayload: Record<string, unknown> = {
        booking_number:      bNum,
        property_id:         form.propertyId,
        guest_id:            guestId,
        check_in:            form.checkIn,
        check_out:           form.checkOut,
        source:              'manual',
        status:              'confirmed',
        price_per_night:     isOwnerGuest ? null : (ppnGross || null),
        cleaning_fee:        isOwnerGuest ? null : (cfGross  || null),
        total_price:         isOwnerGuest ? 0    : (totalGross || null),
        checkin_time:        form.checkinTime  || null,
        checkout_time:       form.checkoutTime || null,
        key_handover:        form.keyHandover.trim()        || null,
        wifi_name:           form.wifiName.trim()           || null,
        wifi_password:       form.wifiPassword.trim()       || null,
        parking_info:        form.parkingInfo.trim()        || null,
        emergency_contact:   form.emergencyContact.trim()   || null,
        house_rules:         form.houseRules.trim()         || null,
        cancellation_policy: form.cancellationPolicy.trim() || null,
      }

      // Extended fields: nur wenn Migration gelaufen ist (Schema-Cache hat die Spalten)
      const extendedFields: Record<string, unknown> = {
        is_owner_stay:         isOwnerGuest,
        price_per_night_gross: isOwnerGuest ? 0 : (ppnGross    || null),
        price_per_night_net:   isOwnerGuest ? 0 : (ppnNet      || null),
        cleaning_fee_gross:    isOwnerGuest ? 0 : (cfGross     || null),
        cleaning_fee_net:      isOwnerGuest ? 0 : (cfNet       || null),
        total_price_gross:     isOwnerGuest ? 0 : (totalGross  || null),
        total_price_net:       isOwnerGuest ? 0 : (totalNet    || null),
        vat_rate:              vatPct,
      }

      // Erst mit allen Feldern versuchen; bei Schema-Cache-Fehler Fallback auf Base-Felder
      let attempt = await supabase
        .from('bookings')
        .insert({ ...basePayload, ...extendedFields })
        .select('id')
        .single()

      if (attempt.error?.message?.includes('column') || attempt.error?.message?.includes('schema cache')) {
        // Neue Spalten noch nicht in DB → Buchung mit Legacy-Feldern anlegen
        console.warn('[BookingModal] Extended columns not in schema yet, using base fields:', attempt.error.message)
        attempt = await supabase
          .from('bookings')
          .insert(basePayload)
          .select('id')
          .single()
      }

      if (attempt.error) throw new Error(attempt.error.message)
      const bookingData = attempt.data

      // 4. Buchungsbestätigung per E-Mail (fire-and-forget – Fehler blockieren nicht)
      supabase.functions.invoke('send-booking-confirmation', {
        body: { booking_id: bookingData.id },
      }).catch(e => console.warn('[BookingModal] confirmation email failed:', e))

      // 5. Guest agreement stub
      if (form.houseRules.trim()) {
        await supabase.from('guest_agreements').insert({
          booking_id:  bookingData.id,
          guest_id:    guestId,
          property_id: form.propertyId,
          check_in:    form.checkIn,
          check_out:   form.checkOut,
          total_price: isOwnerGuest ? 0 : (totalGross || null),
          house_rules: form.houseRules.trim(),
        })
      }

      // WhatsApp Buchungsbestätigung an Gast (fire-and-forget)
      if (form.phone) {
        const property = properties.find(p => p.id === form.propertyId)
        const fmtDate  = (d: string) =>
          new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
        sendWhatsApp({
          event_type: 'booking',
          lead_data: {
            lead_name:    `${form.firstName} ${form.lastName}`,
            lead_phone:   form.phone  ?? '',
            lead_email:   form.email  ?? '',
            lead_whatsapp: form.phone ?? '',
          },
          extra_data: {
            project_name: property?.project_name ?? '',
            checkin:      fmtDate(form.checkIn),
            checkout:     fmtDate(form.checkOut),
          },
        }).catch(e => console.warn('[BookingModal] WhatsApp confirmation failed:', e))
      }

      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'))
    } finally {
      setSaving(false)
    }
  }

  const steps = [
    t('calendar.modal.step1'),
    t('calendar.modal.step2'),
    t('calendar.modal.step3'),
    t('calendar.modal.step4'),
  ]

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-hp-black font-body"
                style={{ fontFamily: 'var(--font-heading)' }}>
              {t('calendar.modal.title')}
            </h2>
            <button onClick={onClose}
                    className="w-8 h-8 rounded-full flex items-center justify-center
                               text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
              ✕
            </button>
          </div>

          {/* Step indicator */}
          <div className="flex items-center gap-0">
            {steps.map((label, idx) => (
              <div key={idx} className="flex items-center flex-1">
                <div className="flex flex-col items-center gap-1">
                  <StepDot n={idx + 1} active={step === idx + 1} done={step > idx + 1} />
                  <span className={`text-xs font-body hidden sm:block
                    ${step === idx + 1 ? 'font-semibold text-hp-black' : 'text-gray-400'}`}>
                    {label}
                  </span>
                </div>
                {idx < 3 && (
                  <div className={`flex-1 h-px mx-1 mb-4
                    ${step > idx + 1 ? 'bg-green-400' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── STEP 1: Immobilie & Zeitraum & Preise ── */}
          {step === 1 && (
            <>
              {/* Property */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                  {t('calendar.modal.property')} *
                  <span className="ml-1 font-normal text-gray-400">({t('calendar.modal.propertyHint')})</span>
                </label>
                {properties.length === 0 ? (
                  <p className="text-sm text-gray-400 font-body italic">{t('calendar.modal.noProperties')}</p>
                ) : (
                  <select value={form.propertyId} onChange={e => setF('propertyId', e.target.value)}
                          className={inputCls}>
                    <option value="">— {t('calendar.modal.property')} —</option>
                    {properties.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.project_name}{p.unit_number ? ` · ${p.unit_number}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                    {t('calendar.modal.checkIn')} *
                  </label>
                  <input type="date" value={form.checkIn}
                         onChange={e => setF('checkIn', e.target.value)}
                         className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                    {t('calendar.modal.checkOut')} *
                  </label>
                  <input type="date" value={form.checkOut}
                         min={form.checkIn || undefined}
                         onChange={e => setF('checkOut', e.target.value)}
                         className={inputCls} />
                </div>
              </div>

              {/* Availability indicator */}
              {avail !== 'idle' && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-body
                  ${avail === 'ok'   ? 'bg-green-50 text-green-700'
                    : avail === 'no' ? 'bg-red-50 text-red-600'
                    : 'bg-gray-50 text-gray-500'}`}>
                  {avail === 'checking' && (
                    <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-gray-500
                                     rounded-full animate-spin shrink-0" />
                  )}
                  {avail === 'ok' && <span>✓</span>}
                  {avail === 'no' && <span>✗</span>}
                  <span>
                    {avail === 'ok'     ? t('calendar.modal.available')
                      : avail === 'no' ? t('calendar.modal.unavailable')
                      : t('calendar.modal.checking')}
                  </span>
                  {nights > 0 && avail === 'ok' && (
                    <span className="ml-auto text-xs text-gray-400">
                      {nights} {t('calendar.modal.nights')}
                    </span>
                  )}
                </div>
              )}

              {/* Pricing section */}
              <div className="pt-1 space-y-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide font-body">
                  {t('calendar.modal.pricingSection')}
                </p>

                {/* Owner stay badge */}
                {isOwnerGuest && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-purple-50 border
                                  border-purple-200 rounded-xl text-sm font-body font-semibold
                                  text-purple-700">
                    {t('calendar.modal.ownerStayBadge')}
                  </div>
                )}

                {/* Row: Price/night gross | VAT % | Net */}
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                      {t('calendar.modal.pricePerNightGross')}
                    </label>
                    <input type="number" min="0" step="0.01" placeholder="0.00"
                           value={isOwnerGuest ? '0' : form.pricePerNightGross}
                           onChange={e => setF('pricePerNightGross', e.target.value)}
                           disabled={isOwnerGuest}
                           className={isOwnerGuest ? inputClsDisabled : inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                      {t('calendar.modal.vatRate')}
                    </label>
                    <input type="number" min="0" max="100" step="1"
                           value={form.vatRate}
                           onChange={e => setF('vatRate', e.target.value)}
                           disabled={isOwnerGuest}
                           className={isOwnerGuest ? inputClsDisabled : inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                      {t('calendar.modal.pricePerNightNet')}
                    </label>
                    <input type="text" readOnly disabled
                           value={ppnGross > 0 ? ppnNet.toFixed(2) : ''}
                           placeholder="0.00"
                           className={inputClsDisabled} />
                  </div>
                </div>

                {/* Row: Cleaning gross | Cleaning net */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                      {t('calendar.modal.cleaningFeeGross')}
                    </label>
                    <input type="number" min="0" step="0.01"
                           value={isOwnerGuest ? '0' : form.cleaningFeeGross}
                           onChange={e => setF('cleaningFeeGross', e.target.value)}
                           disabled={isOwnerGuest}
                           placeholder={t('calendar.modal.cleaningFeePh')}
                           className={isOwnerGuest ? inputClsDisabled : inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                      {t('calendar.modal.cleaningFeeNet')}
                    </label>
                    <input type="text" readOnly disabled
                           value={cfGross > 0 ? cfNet.toFixed(2) : ''}
                           placeholder="0.00"
                           className={inputClsDisabled} />
                  </div>
                </div>

                {/* Totals row */}
                {nights > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-50 rounded-xl px-3 py-2.5">
                      <p className="text-xs text-gray-400 font-body mb-0.5">{t('calendar.modal.totalGross')}</p>
                      <p className="font-bold text-hp-black text-sm font-body">{fmtEur(totalGross)}</p>
                    </div>
                    <div className="bg-gray-50 rounded-xl px-3 py-2.5">
                      <p className="text-xs text-gray-400 font-body mb-0.5">{t('calendar.modal.totalNet')}</p>
                      <p className="font-bold text-hp-black text-sm font-body">{fmtEur(totalNet)}</p>
                      {vatAmount > 0.005 && (
                        <p className="text-xs text-gray-400 font-body">
                          {t('calendar.modal.vatLabel')} {fmtEur(vatAmount)}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── STEP 2: Gast-Daten ── */}
          {step === 2 && (
            <>
              {/* Mode toggle */}
              <div className="flex gap-1 p-1 bg-gray-100 rounded-xl">
                {(['search', 'new'] as const).map(mode => (
                  <button key={mode}
                          type="button"
                          onClick={() => switchGuestMode(mode)}
                          className={`flex-1 py-1.5 rounded-lg text-sm font-semibold font-body
                            transition-all ${guestMode === mode
                              ? 'bg-white shadow-sm text-hp-black'
                              : 'text-gray-500 hover:text-gray-700'}`}>
                    {mode === 'search'
                      ? t('calendar.modal.guestToggleFromData')
                      : t('calendar.modal.guestToggleNew')}
                  </button>
                ))}
              </div>

              {/* ── SEARCH MODE ── */}
              {guestMode === 'search' && (
                <>
                  {!selectedProfile ? (
                    <div className="relative">
                      <input
                        type="text"
                        value={guestSearch}
                        onChange={e => setGuestSearch(e.target.value)}
                        placeholder={t('calendar.modal.guestSearch')}
                        className={inputCls}
                        autoFocus
                      />
                      {guestSearching && (
                        <div className="absolute right-3 top-1/2 -translate-y-1/2">
                          <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400
                                           rounded-full animate-spin block" />
                        </div>
                      )}
                      {guestResults.length > 0 && (
                        <div className="absolute top-full left-0 right-0 z-10 bg-white border
                                        border-gray-200 rounded-xl shadow-lg mt-1
                                        max-h-52 overflow-y-auto">
                          {guestResults.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => selectProfile(p)}
                              className="w-full text-left px-3 py-2.5 hover:bg-gray-50 font-body
                                         border-b border-gray-100 last:border-0 transition-colors
                                         flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-semibold text-hp-black">{p.full_name}</span>
                                <span className="text-xs text-gray-400 ml-2 truncate">{p.email}</span>
                              </div>
                              <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded font-medium
                                ${p.role === 'eigentuemer' ? 'bg-purple-100 text-purple-700'
                                  : p.role === 'feriengast' ? 'bg-orange-100 text-orange-700'
                                  : 'bg-blue-50 text-blue-600'}`}>
                                {t(`roles.${p.role}`)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Selected profile card */
                    <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide font-body">
                          {t('calendar.modal.guestFromData')}
                        </p>
                        <button type="button" onClick={clearSelectedProfile}
                                className="text-xs text-gray-400 hover:text-gray-600 font-body
                                           transition-colors flex items-center gap-1">
                          {t('calendar.modal.clearSelection')} ✕
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                            {t('calendar.modal.firstName')}
                          </label>
                          <input value={form.firstName} disabled className={inputClsDisabled} />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                            {t('calendar.modal.lastName')}
                          </label>
                          <input value={form.lastName} disabled className={inputClsDisabled} />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                          {t('calendar.modal.email')}
                        </label>
                        <input value={form.email} disabled className={inputClsDisabled} />
                      </div>

                      {form.phone && (
                        <div>
                          <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                            {t('calendar.modal.phone')}
                          </label>
                          <input value={form.phone} disabled className={inputClsDisabled} />
                        </div>
                      )}

                      {isOwnerGuest && (
                        <div className="flex items-center gap-2 px-3 py-2 bg-purple-50 border
                                        border-purple-200 rounded-xl text-sm font-body font-semibold
                                        text-purple-700">
                          {t('calendar.modal.ownerStayBadge')}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Guest count (only once profile selected) */}
                  {selectedProfile && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                        {t('calendar.modal.guestCount')}
                      </label>
                      <input type="number" min="1" max="30"
                             value={form.guestCount}
                             onChange={e => setF('guestCount', e.target.value)}
                             className={inputCls} />
                    </div>
                  )}
                </>
              )}

              {/* ── NEW GUEST MODE ── */}
              {guestMode === 'new' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                        {t('calendar.modal.firstName')} *
                      </label>
                      <input type="text" value={form.firstName}
                             onChange={e => setF('firstName', e.target.value)}
                             className={existing ? inputClsDisabled : inputCls}
                             disabled={!!existing} />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                        {t('calendar.modal.lastName')} *
                      </label>
                      <input type="text" value={form.lastName}
                             onChange={e => setF('lastName', e.target.value)}
                             className={existing ? inputClsDisabled : inputCls}
                             disabled={!!existing} />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                      {t('calendar.modal.email')} *
                    </label>
                    <input type="email" value={form.email}
                           onChange={e => {
                             setF('email', e.target.value)
                             setExisting(null)
                             setEmailChecked(false)
                           }}
                           className={inputCls} />
                    {emailChecked && (
                      <p className={`text-xs font-body mt-1
                        ${existing ? 'text-blue-600' : 'text-green-600'}`}>
                        {existing
                          ? `${t('calendar.modal.existingGuest')}: ${existing.full_name}`
                          : t('calendar.modal.newGuest')}
                      </p>
                    )}
                    {isOwnerGuest && (
                      <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-purple-50 border
                                      border-purple-200 rounded-xl text-sm font-body font-semibold
                                      text-purple-700">
                        {t('calendar.modal.ownerStayBadge')}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                        {t('calendar.modal.phone')}
                      </label>
                      <input type="tel" value={form.phone}
                             onChange={e => setF('phone', e.target.value)}
                             className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                        {t('calendar.modal.guestCount')}
                      </label>
                      <input type="number" min="1" max="30"
                             value={form.guestCount}
                             onChange={e => setF('guestCount', e.target.value)}
                             className={inputCls} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                        {t('calendar.modal.nationality')}
                      </label>
                      <input type="text" value={form.nationality}
                             onChange={e => setF('nationality', e.target.value)}
                             className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                        {t('calendar.modal.language')}
                      </label>
                      <select value={form.language}
                              onChange={e => setF('language', e.target.value as 'de' | 'en')}
                              className={inputCls}>
                        <option value="de">Deutsch</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── STEP 3: Check-in Infos ── */}
          {step === 3 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                    {t('calendar.modal.checkinTime')}
                  </label>
                  <input type="time" value={form.checkinTime}
                         onChange={e => setF('checkinTime', e.target.value)}
                         className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                    {t('calendar.modal.checkoutTime')}
                  </label>
                  <input type="time" value={form.checkoutTime}
                         onChange={e => setF('checkoutTime', e.target.value)}
                         className={inputCls} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                  {t('calendar.modal.keyHandover')}
                </label>
                <textarea rows={2} value={form.keyHandover}
                          onChange={e => setF('keyHandover', e.target.value)}
                          placeholder={t('calendar.modal.keyHandoverPh')}
                          className={textCls} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                    {t('calendar.modal.wifiName')}
                  </label>
                  <input type="text" value={form.wifiName}
                         onChange={e => setF('wifiName', e.target.value)}
                         className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                    {t('calendar.modal.wifiPassword')}
                  </label>
                  <input type="text" value={form.wifiPassword}
                         onChange={e => setF('wifiPassword', e.target.value)}
                         className={inputCls} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                  {t('calendar.modal.parkingInfo')}
                </label>
                <textarea rows={2} value={form.parkingInfo}
                          onChange={e => setF('parkingInfo', e.target.value)}
                          placeholder={t('calendar.modal.parkingPh')}
                          className={textCls} />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                  {t('calendar.modal.emergencyContact')}
                </label>
                <input type="text" value={form.emergencyContact}
                       onChange={e => setF('emergencyContact', e.target.value)}
                       className={inputCls} />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 font-body mb-1.5">
                  {t('calendar.modal.houseRules')} *
                </label>
                <textarea rows={4} value={form.houseRules}
                          onChange={e => setF('houseRules', e.target.value)}
                          placeholder={t('calendar.modal.houseRulesPh')}
                          className={textCls} />
              </div>
            </>
          )}

          {/* ── STEP 4: Bestätigung ── */}
          {step === 4 && (
            <>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide font-body">
                {t('calendar.modal.confirmSection')}
              </p>

              {/* Summary card */}
              <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm font-body">
                <div className="flex justify-between">
                  <span className="text-gray-500">{t('calendar.modal.property')}</span>
                  <span className="font-semibold text-hp-black">
                    {selectedProp?.project_name}
                    {selectedProp?.unit_number ? ` · ${selectedProp.unit_number}` : ''}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">{t('bookings.checkIn')}</span>
                  <span className="font-semibold text-hp-black">
                    {form.checkIn} — {form.checkOut}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">{t('calendar.modal.nights')}</span>
                  <span className="font-semibold text-hp-black">{nights}</span>
                </div>

                {/* Owner badge or price breakdown */}
                {isOwnerGuest ? (
                  <div className="border-t border-gray-200 pt-2 mt-2">
                    <div className="flex items-center gap-2 px-3 py-2 bg-purple-50 border
                                    border-purple-200 rounded-xl text-sm font-body font-semibold
                                    text-purple-700">
                      {t('calendar.modal.ownerStayBadge')}
                    </div>
                  </div>
                ) : totalGross > 0 ? (
                  <div className="border-t border-gray-200 pt-2 mt-2 space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">{t('calendar.modal.totalGross')}</span>
                      <span className="font-bold text-hp-black">{fmtEur(totalGross)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">{t('calendar.modal.totalNet')}</span>
                      <span className="text-gray-500">{fmtEur(totalNet)}</span>
                    </div>
                    {vatAmount > 0.005 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">{t('calendar.modal.vatLabel')} {vatPct}%</span>
                        <span className="text-gray-500">{fmtEur(vatAmount)}</span>
                      </div>
                    )}
                  </div>
                ) : null}

                <div className="border-t border-gray-200 pt-2 mt-2">
                  <span className="text-gray-500">{t('bookings.guest')}</span>
                  <p className="font-semibold text-hp-black mt-0.5">
                    {form.firstName} {form.lastName}
                    {(guestMode === 'search' ? selectedProfile : existing) && (
                      <span className="ml-2 text-xs text-blue-500 font-normal">
                        ({t('calendar.modal.existingGuest')})
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400">{form.email}</p>
                </div>
              </div>

              {/* Send options */}
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={form.sendConfirmation}
                         onChange={e => setF('sendConfirmation', e.target.checked)}
                         className="w-4 h-4 rounded accent-hp-highlight" />
                  <span className="text-sm font-body text-hp-black">
                    {t('calendar.modal.sendConfirmation')}
                  </span>
                </label>
                {guestMode === 'new' && !existing && (
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={form.sendInvitation}
                           onChange={e => setF('sendInvitation', e.target.checked)}
                           className="w-4 h-4 rounded accent-hp-highlight" />
                    <span className="text-sm font-body text-hp-black">
                      {t('calendar.modal.sendInvitation')}
                    </span>
                  </label>
                )}
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <p className="text-sm text-red-500 font-body bg-red-50 px-4 py-2 rounded-xl">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-3 border-t border-gray-100 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={step === 1 ? onClose : () => { setError(''); setStep(s => (s - 1) as Step) }}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold font-body
                       border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
            {step === 1 ? t('common.cancel') : t('common.back')}
          </button>

          {step < 4 ? (
            <button type="button" onClick={nextStep}
                    className="px-6 py-2.5 rounded-xl text-white text-sm font-semibold font-body
                               hover:opacity-90 transition-opacity"
                    style={{ backgroundColor: 'var(--color-highlight)' }}>
              {t('common.next')} →
            </button>
          ) : (
            <button type="button" onClick={handleCreate} disabled={saving}
                    className="px-6 py-2.5 rounded-xl text-white text-sm font-semibold font-body
                               hover:opacity-90 disabled:opacity-60 transition-opacity
                               flex items-center gap-2"
                    style={{ backgroundColor: 'var(--color-highlight)' }}>
              {saving && (
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              {saving ? t('calendar.modal.creating') : t('calendar.modal.create')}
            </button>
          )}
        </div>
      </div>

      {/* ── Tax Warning Modal ── */}
      {showTaxWarning && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60"
             onClick={() => taxWarningResolveRef.current?.(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
               onClick={e => e.stopPropagation()}>
            <div className="text-center mb-5">
              <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center
                              mx-auto mb-3 text-2xl">
                ⚠️
              </div>
              <h3 className="font-bold text-hp-black font-body mb-3"
                  style={{ fontFamily: 'var(--font-heading)' }}>
                {t('calendar.modal.ownerTaxTitle')}
              </h3>
              <p className="text-sm text-gray-700 font-body mb-3 leading-relaxed">
                {t('calendar.modal.ownerTaxBody', {
                  name:  `${form.firstName} ${form.lastName}`.trim(),
                  year:  new Date(form.checkIn || new Date()).getFullYear(),
                  used:  ownerUsedNights,
                  new:   nights,
                  total: ownerUsedNights + nights,
                })}
              </p>
              <p className="text-sm text-gray-600 font-body mb-2 leading-relaxed">
                {t('calendar.modal.ownerTaxHint')}
              </p>
              <p className="text-xs text-gray-400 font-body italic">
                {t('calendar.modal.ownerTaxAdvice')}
              </p>
            </div>
            <div className="flex gap-3">
              {/* Trotzdem buchen = grau */}
              <button
                type="button"
                onClick={() => taxWarningResolveRef.current?.(true)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-body
                           border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
                {t('calendar.modal.ownerTaxProceed')}
              </button>
              {/* Abbrechen = #ff795d */}
              <button
                type="button"
                onClick={() => taxWarningResolveRef.current?.(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-body text-white
                           hover:opacity-90 transition-opacity"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
                {t('calendar.modal.ownerTaxAbort')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
