import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { supabaseAdmin } from '../../lib/supabaseAdmin'

interface GuestBooking {
  id: string
  booking_number: string | null
  check_in: string
  check_out: string
  total_price: number | null
  property: { project_name: string; unit_number: string | null } | null
  guest: { full_name: string; email: string } | null
}

interface NewBookingForm {
  property_id:         string
  // Gast
  first_name:          string
  last_name:           string
  email:               string
  phone:               string
  language:            string
  nationality:         string
  // Buchung
  check_in:            string
  check_out:           string
  price_per_night:     string
  cleaning_fee:        string
  // Infos
  checkin_time:        string
  checkout_time:       string
  key_handover:        string
  wifi_name:           string
  wifi_password:       string
  parking_info:        string
  emergency_contact:   string
  house_rules:         string
  cancellation_policy: string
}

const EMPTY: NewBookingForm = {
  property_id: '', first_name: '', last_name: '', email: '', phone: '', language: 'de',
  nationality: '', check_in: '', check_out: '', price_per_night: '', cleaning_fee: '',
  checkin_time: '15:00', checkout_time: '11:00', key_handover: '', wifi_name: '',
  wifi_password: '', parking_info: '', emergency_contact: '', house_rules: '',
  cancellation_policy: '',
}

const inputCls = `w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm
  font-body text-hp-black placeholder-gray-300 focus:outline-none
  focus:ring-2 focus:ring-hp-highlight focus:border-transparent transition`

const textCls = `w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm
  font-body text-hp-black placeholder-gray-300 focus:outline-none
  focus:ring-2 focus:ring-hp-highlight focus:border-transparent transition resize-none`

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-3">
        {title}
      </h3>
      {children}
    </div>
  )
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-medium text-gray-500 font-body mb-1">
      {children}{required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  )
}

export default function VerwalterBookings() {
  const { t } = useTranslation()

  const [bookings, setBookings]   = useState<GuestBooking[]>([])
  const [properties, setProperties] = useState<{ id: string; project_name: string; unit_number: string | null }[]>([])
  const [loading, setLoading]     = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm]           = useState<NewBookingForm>(EMPTY)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')
  const [toast, setToast]         = useState('')
  const [step, setStep]           = useState<1|2|3>(1)

  const setF = (k: keyof NewBookingForm, v: string) => setForm(f => ({ ...f, [k]: v }))

  const load = useCallback(async () => {
    const [{ data: bData }, { data: pData }] = await Promise.all([
      supabase
        .from('bookings')
        .select('id, booking_number, check_in, check_out, total_price, property:property_id(project_name, unit_number), guest:guest_id(full_name, email)')
        .order('check_in', { ascending: false }),
      supabase
        .from('properties')
        .select('id, project_name, unit_number')
        .order('project_name'),
    ])
    setBookings((bData ?? []) as unknown as GuestBooking[])
    setProperties(pData ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openModal() {
    setForm(EMPTY)
    setError('')
    setStep(1)
    setShowModal(true)
  }

  async function handleCreate() {
    if (!form.property_id || !form.email.trim() || !form.check_in || !form.check_out) {
      setError(t('errors.required'))
      return
    }
    setSaving(true)
    setError('')

    try {
      const full_name = `${form.first_name.trim()} ${form.last_name.trim()}`.trim()

      // 1. Prüfen ob Gast schon existiert
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', form.email.trim().toLowerCase())
        .maybeSingle()

      let guestId: string

      if (existing?.id) {
        guestId = existing.id
      } else {
        // Neuen Feriengast anlegen via Invite
        const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          form.email.trim().toLowerCase(),
          {
            data: { full_name, needs_password_setup: true },
            redirectTo: `${window.location.origin}/login`,
          }
        )
        if (authErr) throw new Error(authErr.message)
        guestId = authData.user.id

        // Profil anlegen
        await supabaseAdmin.from('profiles').upsert({
          id:          guestId,
          email:       form.email.trim().toLowerCase(),
          full_name,
          phone:       form.phone.trim() || null,
          language:    form.language,
          nationality: form.nationality.trim() || null,
          role:        'feriengast',
          is_active:   true,
        })
      }

      // 2. Buchung anlegen
      const nights = Math.round(
        (new Date(form.check_out).getTime() - new Date(form.check_in).getTime()) / 86400000
      )
      const pricePerNight = form.price_per_night ? parseFloat(form.price_per_night) : null
      const cleaningFee   = form.cleaning_fee    ? parseFloat(form.cleaning_fee)    : 0
      const totalPrice    = pricePerNight ? pricePerNight * nights + cleaningFee : null

      const { data: bookingData, error: bookingErr } = await supabase
        .from('bookings')
        .insert({
          property_id:         form.property_id,
          guest_id:            guestId,
          check_in:            form.check_in,
          check_out:           form.check_out,
          source:              'manual',
          price_per_night:     pricePerNight,
          cleaning_fee:        cleaningFee || null,
          total_price:         totalPrice,
          checkin_time:        form.checkin_time || null,
          checkout_time:       form.checkout_time || null,
          key_handover:        form.key_handover.trim() || null,
          wifi_name:           form.wifi_name.trim() || null,
          wifi_password:       form.wifi_password.trim() || null,
          parking_info:        form.parking_info.trim() || null,
          emergency_contact:   form.emergency_contact.trim() || null,
          house_rules:         form.house_rules.trim() || null,
          cancellation_policy: form.cancellation_policy.trim() || null,
        })
        .select('id, check_in, check_out')
        .single()

      if (bookingErr) throw new Error(bookingErr.message)

      // 3. Gäste-Vereinbarung anlegen (für Hausregeln-Zustimmung)
      if (form.house_rules.trim()) {
        await supabase.from('guest_agreements').insert({
          booking_id:  bookingData.id,
          guest_id:    guestId,
          property_id: form.property_id,
          check_in:    form.check_in,
          check_out:   form.check_out,
          total_price: totalPrice,
          house_rules: form.house_rules.trim(),
        })
      }

      setShowModal(false)
      setToast(t('guest.booking.created'))
      setTimeout(() => setToast(''), 3500)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function fmtDate(d: string) {
    return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  return (
    <DashboardLayout basePath="/verwaltung/dashboard">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-5 py-3 bg-hp-black text-white text-sm
                        font-body rounded-2xl shadow-xl flex items-center gap-2">
          ✓ {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-hp-black font-body"
              style={{ fontFamily: 'var(--font-heading)' }}>
            {t('bookings.title')}
          </h1>
          <p className="text-sm text-gray-400 font-body">{bookings.length} {t('common.noResults').replace('Keine ', '').replace(' vorhanden.', '')}</p>
        </div>
        <button onClick={openModal}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm
                           font-semibold font-body hover:opacity-90 transition-opacity"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
          + {t('bookings.add')}
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : bookings.length === 0 ? (
        <div className="text-center py-20 text-gray-400 font-body text-sm">{t('bookings.empty')}</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm font-body">
            <thead>
              <tr className="border-b border-gray-100">
                {['Nr.', t('bookings.columns.property'), t('guest.dashboard.subtitle').split(' ')[0], t('bookings.checkIn'), t('bookings.checkOut')].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-widest">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bookings.map(b => (
                <tr key={b.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{b.booking_number ?? '–'}</td>
                  <td className="px-4 py-3 font-medium text-hp-black">
                    {b.property?.project_name ?? '–'}
                    {b.property?.unit_number && <span className="text-gray-400 ml-1">#{b.property.unit_number}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {b.guest?.full_name ?? <span className="text-gray-400 italic">–</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{fmtDate(b.check_in)}</td>
                  <td className="px-4 py-3 text-gray-600">{fmtDate(b.check_out)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto
                        bg-black/40 backdrop-blur-sm p-4 py-8">
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-bold text-hp-black font-body">{t('bookings.add')}</h2>
                <div className="flex gap-2 mt-1">
                  {(['1','2','3'] as const).map((s, i) => (
                    <span key={s}
                          className={`text-xs px-2 py-0.5 rounded-full font-body font-medium ${
                            step === i+1 ? 'text-white' : 'bg-gray-100 text-gray-400'
                          }`}
                          style={step === i+1 ? { backgroundColor: 'var(--color-highlight)' } : {}}>
                      {['Gast', 'Buchung', 'Infos'][i]}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="px-6 py-5">

              {/* Step 1: Gast */}
              {step === 1 && (
                <>
                  <Section title={t('guest.booking.guestData')}>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <Label required>{t('users.form.firstName')}</Label>
                        <input className={inputCls} value={form.first_name}
                               onChange={e => setF('first_name', e.target.value)} placeholder="Max" />
                      </div>
                      <div>
                        <Label required>{t('users.form.lastName')}</Label>
                        <input className={inputCls} value={form.last_name}
                               onChange={e => setF('last_name', e.target.value)} placeholder="Mustermann" />
                      </div>
                    </div>
                    <div className="mb-3">
                      <Label required>{t('users.form.email')}</Label>
                      <input className={inputCls} type="email" value={form.email}
                             onChange={e => setF('email', e.target.value)} placeholder="gast@example.com" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>{t('users.form.phone')}</Label>
                        <input className={inputCls} value={form.phone}
                               onChange={e => setF('phone', e.target.value)} placeholder="+49 170 …" />
                      </div>
                      <div>
                        <Label>{t('guest.profile.nationality')}</Label>
                        <input className={inputCls} value={form.nationality}
                               onChange={e => setF('nationality', e.target.value)} placeholder="Deutsch" />
                      </div>
                    </div>
                    <div className="mt-3">
                      <Label>{t('users.form.language')}</Label>
                      <select className={inputCls} value={form.language}
                              onChange={e => setF('language', e.target.value)}>
                        <option value="de">🇩🇪 Deutsch</option>
                        <option value="en">🇬🇧 English</option>
                      </select>
                    </div>
                  </Section>

                  {/* Info: Einladungsmail */}
                  <div className="flex items-start gap-3 bg-green-50 border border-green-100 rounded-xl px-4 py-3 mb-4">
                    <span className="text-lg shrink-0">✉️</span>
                    <p className="text-xs text-green-700 font-body">{t('users.invite.emailHint')}</p>
                  </div>
                </>
              )}

              {/* Step 2: Buchung */}
              {step === 2 && (
                <>
                  <Section title={t('properties.title')}>
                    <Label required>{t('properties.title')}</Label>
                    <select className={inputCls} value={form.property_id}
                            onChange={e => setF('property_id', e.target.value)}>
                      <option value="">{t('documents.selectProperty')}</option>
                      {properties.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.project_name}{p.unit_number ? ` #${p.unit_number}` : ''}
                        </option>
                      ))}
                    </select>
                  </Section>

                  <Section title={t('guest.booking.period')}>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label required>{t('bookings.checkIn')}</Label>
                        <input type="date" className={inputCls} value={form.check_in}
                               onChange={e => setF('check_in', e.target.value)} />
                      </div>
                      <div>
                        <Label required>{t('bookings.checkOut')}</Label>
                        <input type="date" className={inputCls} value={form.check_out}
                               onChange={e => setF('check_out', e.target.value)} />
                      </div>
                    </div>
                  </Section>

                  <Section title={t('guest.confirmation.price')}>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>{t('guest.booking.pricePerNight')} (€)</Label>
                        <input type="number" min="0" step="0.01" className={inputCls}
                               value={form.price_per_night}
                               onChange={e => setF('price_per_night', e.target.value)}
                               placeholder="120.00" />
                      </div>
                      <div>
                        <Label>{t('guest.confirmation.cleaningFee')} (€)</Label>
                        <input type="number" min="0" step="0.01" className={inputCls}
                               value={form.cleaning_fee}
                               onChange={e => setF('cleaning_fee', e.target.value)}
                               placeholder="50.00" />
                      </div>
                    </div>
                  </Section>

                  <Section title={t('guest.confirmation.cancellation')}>
                    <textarea className={textCls} rows={3}
                              value={form.cancellation_policy}
                              onChange={e => setF('cancellation_policy', e.target.value)}
                              placeholder={t('guest.booking.cancellationPlaceholder')} />
                  </Section>
                </>
              )}

              {/* Step 3: Check-in Infos + Hausregeln */}
              {step === 3 && (
                <>
                  <Section title={t('guest.nav.checkin')}>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <Label>{t('guest.checkin.checkinTime')}</Label>
                        <input type="time" className={inputCls} value={form.checkin_time}
                               onChange={e => setF('checkin_time', e.target.value)} />
                      </div>
                      <div>
                        <Label>{t('guest.checkin.checkoutTime')}</Label>
                        <input type="time" className={inputCls} value={form.checkout_time}
                               onChange={e => setF('checkout_time', e.target.value)} />
                      </div>
                    </div>
                    <div className="space-y-3">
                      {[
                        { key: 'key_handover',     label: t('guest.checkin.keyHandover'),  ph: 'Schlüssel liegt im Schlüsselsafe …' },
                        { key: 'wifi_name',         label: 'WLAN-Name',                    ph: 'Netzwerkname' },
                        { key: 'wifi_password',     label: 'WLAN-Passwort',                ph: 'Passwort' },
                        { key: 'parking_info',      label: t('guest.checkin.parking'),     ph: 'Parkplatz Beschreibung …' },
                        { key: 'emergency_contact', label: t('guest.checkin.emergency'),   ph: '+49 170 … / Name' },
                      ].map(({ key, label, ph }) => (
                        <div key={key}>
                          <Label>{label}</Label>
                          <input className={inputCls}
                                 value={form[key as keyof NewBookingForm]}
                                 onChange={e => setF(key as keyof NewBookingForm, e.target.value)}
                                 placeholder={ph} />
                        </div>
                      ))}
                    </div>
                  </Section>

                  <Section title={t('guest.nav.houseRules')}>
                    <textarea className={textCls} rows={6}
                              value={form.house_rules}
                              onChange={e => setF('house_rules', e.target.value)}
                              placeholder={t('guest.booking.houseRulesPlaceholder')} />
                  </Section>
                </>
              )}

              {/* Error */}
              {error && (
                <p className="text-sm text-red-500 bg-red-50 px-4 py-2.5 rounded-xl font-body mb-4">
                  {error}
                </p>
              )}

              {/* Footer */}
              <div className="flex gap-3 pt-2 border-t border-gray-100">
                {step > 1 && (
                  <button onClick={() => setStep(s => (s - 1) as 1|2|3)}
                          className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm
                                     font-medium font-body text-gray-700 hover:bg-gray-50">
                    {t('common.back')}
                  </button>
                )}
                {step < 3 ? (
                  <button onClick={() => setStep(s => (s + 1) as 1|2|3)}
                          className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold
                                     font-body hover:opacity-90"
                          style={{ backgroundColor: 'var(--color-highlight)' }}>
                    {t('common.next')}
                  </button>
                ) : (
                  <button onClick={handleCreate} disabled={saving}
                          className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold font-body
                                     hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                          style={{ backgroundColor: 'var(--color-highlight)' }}>
                    {saving && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                    {t('bookings.add')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
