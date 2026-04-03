import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import GuestLayout from '../../components/GuestLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

interface BookingDetail {
  id: string
  booking_number: string | null
  check_in: string
  check_out: string
  checkin_time: string | null
  checkout_time: string | null
  price_per_night: number | null
  cleaning_fee: number | null
  total_price: number | null
  cancellation_policy: string | null
  house_rules: string | null
  property: {
    project_name: string
    street: string | null
    house_number: string | null
    zip: string | null
    city: string | null
    images: string[]
  } | null
}

function fmtDate(dateStr: string, lang: string) {
  return new Date(dateStr).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
}

function fmtEur(amount: number, lang: string) {
  return amount.toLocaleString(lang === 'de' ? 'de-DE' : 'en-GB', {
    style: 'currency', currency: 'EUR',
  })
}

export default function Buchung() {
  const { t }       = useTranslation()
  const { profile } = useAuth()
  const lang        = profile?.language ?? 'de'
  const printRef    = useRef<HTMLDivElement>(null)

  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    ;(async () => {
      const { data } = await supabase
        .from('bookings')
        .select(`
          id, booking_number, check_in, check_out, checkin_time, checkout_time,
          price_per_night, cleaning_fee, total_price, cancellation_policy, house_rules,
          property:property_id(project_name, street, house_number, zip, city, images)
        `)
        .eq('guest_id', profile.id)
        .order('check_in', { ascending: false })
        .limit(1)
        .single()
      setBooking(data as BookingDetail | null)
      setLoading(false)
    })()
  }, [profile])

  function handlePrint() {
    window.print()
  }

  if (loading) return (
    <GuestLayout>
      <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
        <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
        {t('common.loading')}
      </div>
    </GuestLayout>
  )

  if (!booking) return (
    <GuestLayout>
      <div className="text-center py-32 text-gray-400 font-body">{t('guest.noBooking.desc')}</div>
    </GuestLayout>
  )

  const prop = booking.property
  const nights = Math.round(
    (new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86400000
  )
  const priceBreakdown = booking.price_per_night
    ? booking.price_per_night * nights
    : null

  return (
    <GuestLayout>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-hp-black font-body">{t('guest.nav.confirmation')}</h1>
          {booking.booking_number && (
            <p className="text-sm text-gray-400 font-body mt-0.5 font-mono">{booking.booking_number}</p>
          )}
        </div>
        <button onClick={handlePrint}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200
                           text-sm font-medium font-body text-gray-700 hover:border-gray-300
                           hover:bg-gray-50 transition-colors print:hidden">
          <span>⬇️</span> {t('guest.confirmation.download')}
        </button>
      </div>

      {/* Buchungsbestätigung – druckoptimiert */}
      <div ref={printRef} className="max-w-2xl bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

        {/* Header */}
        <div className="px-8 py-6 border-b border-gray-100" style={{ backgroundColor: '#2d3748' }}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-white font-body">{t('guest.confirmation.title')}</h2>
              {booking.booking_number && (
                <p className="text-sm text-white/60 font-body font-mono mt-0.5">{booking.booking_number}</p>
              )}
            </div>
            <img src="/logo.jpg" alt="Happy Property" className="w-12 h-12 rounded-xl object-cover" />
          </div>
        </div>

        <div className="p-8 space-y-6">
          {/* Gast */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-3">
              {t('guest.confirmation.guest')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-400 font-body">{t('profile.fullName')}</p>
                <p className="text-sm font-semibold text-hp-black font-body">{profile?.full_name}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-body">{t('profile.email')}</p>
                <p className="text-sm font-semibold text-hp-black font-body">{profile?.email}</p>
              </div>
            </div>
          </section>

          {/* Immobilie */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-3">
              {t('properties.title')}
            </h3>
            <p className="text-sm font-semibold text-hp-black font-body">{prop?.project_name}</p>
            {(prop?.street || prop?.city) && (
              <p className="text-sm text-gray-500 font-body">
                {prop.street}{prop.house_number ? ` ${prop.house_number}` : ''}
                {prop.street && prop.city && ', '}
                {prop.zip && `${prop.zip} `}{prop.city}
              </p>
            )}
          </section>

          {/* Zeitraum */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-3">
              {t('guest.confirmation.period')}
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 font-body">{t('bookings.checkIn')}</p>
                <p className="text-sm font-bold text-hp-black font-body">{fmtDate(booking.check_in, lang)}</p>
                {booking.checkin_time && <p className="text-xs text-gray-500 font-body">ab {booking.checkin_time} Uhr</p>}
              </div>
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 font-body">{t('bookings.checkOut')}</p>
                <p className="text-sm font-bold text-hp-black font-body">{fmtDate(booking.check_out, lang)}</p>
                {booking.checkout_time && <p className="text-xs text-gray-500 font-body">bis {booking.checkout_time} Uhr</p>}
              </div>
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 font-body">{t('bookings.nights_other', { count: nights })}</p>
                <p className="text-sm font-bold text-hp-black font-body">{nights}</p>
              </div>
            </div>
          </section>

          {/* Preis */}
          {(priceBreakdown || booking.cleaning_fee || booking.total_price) && (
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-3">
                {t('guest.confirmation.price')}
              </h3>
              <div className="space-y-2">
                {booking.price_per_night && (
                  <div className="flex justify-between text-sm font-body">
                    <span className="text-gray-600">
                      {nights} × {fmtEur(booking.price_per_night, lang)}/Nacht
                    </span>
                    <span className="font-semibold">{fmtEur(booking.price_per_night * nights, lang)}</span>
                  </div>
                )}
                {!!booking.cleaning_fee && booking.cleaning_fee > 0 && (
                  <div className="flex justify-between text-sm font-body">
                    <span className="text-gray-600">{t('guest.confirmation.cleaningFee')}</span>
                    <span className="font-semibold">{fmtEur(booking.cleaning_fee, lang)}</span>
                  </div>
                )}
                {booking.total_price && (
                  <div className="flex justify-between text-sm font-body border-t border-gray-100 pt-2 mt-2">
                    <span className="font-bold text-hp-black">{t('guest.confirmation.total')}</span>
                    <span className="font-bold text-hp-black">{fmtEur(booking.total_price, lang)}</span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Stornierungsbedingungen */}
          {booking.cancellation_policy && (
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest font-body mb-3">
                {t('guest.confirmation.cancellation')}
              </h3>
              <p className="text-sm text-gray-600 font-body whitespace-pre-wrap leading-relaxed">
                {booking.cancellation_policy}
              </p>
            </section>
          )}

          {/* Footer */}
          <div className="border-t border-gray-100 pt-5 text-xs text-gray-400 font-body">
            <p>Happy Property · {t('app.copyright', { year: new Date().getFullYear() })}</p>
            <p className="mt-0.5">{t('guest.confirmation.autoGenerated')}</p>
          </div>
        </div>
      </div>

      {/* Print CSS */}
      <style>{`
        @media print {
          body > *:not(#print-root) { display: none !important; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>
    </GuestLayout>
  )
}
