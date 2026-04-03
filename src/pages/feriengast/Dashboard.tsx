import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import GuestLayout from '../../components/GuestLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

interface Booking {
  id: string
  booking_number: string | null
  check_in: string
  check_out: string
  checkin_time: string | null
  checkout_time: string | null
  total_price: number | null
  house_rules: string | null
  property: {
    id: string
    project_name: string
    street: string | null
    house_number: string | null
    zip: string | null
    city: string | null
    images: string[]
  } | null
  agreed?: boolean
}

function daysUntil(dateStr: string): number {
  const today = new Date(); today.setHours(0,0,0,0)
  const d = new Date(dateStr); d.setHours(0,0,0,0)
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}

function fmtDate(dateStr: string, lang: string) {
  return new Date(dateStr).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
}

function StatusBadge({ checkIn, checkOut }: { checkIn: string; checkOut: string }) {
  const { t } = useTranslation()
  const today = new Date(); today.setHours(0,0,0,0)
  const ci = new Date(checkIn); ci.setHours(0,0,0,0)
  const co = new Date(checkOut); co.setHours(0,0,0,0)
  if (today < ci) return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold
                     bg-blue-100 text-blue-700 font-body">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
      {t('guest.booking.upcoming')}
    </span>
  )
  if (today <= co) return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold
                     bg-green-100 text-green-700 font-body">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      {t('guest.booking.active')}
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold
                     bg-gray-100 text-gray-600 font-body">
      {t('guest.booking.completed')}
    </span>
  )
}

export default function FeriengastDashboard() {
  const { t }       = useTranslation()
  const { profile } = useAuth()
  const lang        = profile?.language ?? 'de'

  const [booking, setBooking]   = useState<Booking | null>(null)
  const [loading, setLoading]   = useState(true)
  const [unread, setUnread]     = useState(0)

  useEffect(() => {
    if (!profile) return
    ;(async () => {
      const [{ data: bData }, { count }] = await Promise.all([
        supabase
          .from('bookings')
          .select(`
            id, booking_number, check_in, check_out, checkin_time, checkout_time,
            total_price, house_rules,
            property:property_id(id, project_name, street, house_number, zip, city, images)
          `)
          .eq('guest_id', profile.id)
          .order('check_in', { ascending: false })
          .limit(1)
          .single(),
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('is_read', false)
          .neq('sender_id', profile.id),
      ])

      // Check if agreed to house rules
      let agreed = false
      if (bData?.id) {
        const { data: ag } = await supabase
          .from('guest_agreements')
          .select('agreed_at')
          .eq('booking_id', bData.id)
          .single()
        agreed = !!(ag?.agreed_at)
      }

      setBooking(bData ? { ...(bData as unknown as Booking), agreed } : null)
      setUnread(count ?? 0)
      setLoading(false)
    })()
  }, [profile])

  if (loading) {
    return (
      <GuestLayout>
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      </GuestLayout>
    )
  }

  if (!booking) {
    return (
      <GuestLayout>
        <div className="max-w-lg mx-auto text-center py-32">
          <div className="text-6xl mb-4">🏖️</div>
          <h1 className="text-2xl font-bold text-hp-black font-body mb-2">
            {t('guest.noBooking.title')}
          </h1>
          <p className="text-gray-400 font-body text-sm">{t('guest.noBooking.desc')}</p>
        </div>
      </GuestLayout>
    )
  }

  const daysToCheckin = daysUntil(booking.check_in)
  const nights = Math.round(
    (new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86400000
  )
  const prop = booking.property
  const coverImg = prop?.images?.[0] ?? null

  return (
    <GuestLayout unreadCount={unread}>
      {/* Greeting */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-hp-black font-body">
          {t('dashboard.greeting')}, {profile?.full_name?.split(' ')[0]} 👋
        </h1>
        <p className="text-sm text-gray-400 font-body mt-0.5">
          {t('guest.dashboard.subtitle')}
        </p>
      </div>

      {/* Hero: aktuelle/nächste Buchung */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
        {/* Cover image */}
        <div className="relative h-48 bg-gray-100">
          {coverImg ? (
            <img src={coverImg} alt={prop?.project_name}
                 className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-6xl">🏡</div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between">
            <div>
              <h2 className="text-xl font-bold text-white font-body">{prop?.project_name}</h2>
              {prop?.city && (
                <p className="text-sm text-white/80 font-body">
                  {prop.street && `${prop.street}, `}{prop.zip} {prop.city}
                </p>
              )}
            </div>
            <StatusBadge checkIn={booking.check_in} checkOut={booking.check_out} />
          </div>
        </div>

        {/* Buchungsdetails */}
        <div className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-xs text-gray-400 font-body mb-0.5">{t('bookings.checkIn')}</p>
              <p className="text-sm font-bold text-hp-black font-body">{fmtDate(booking.check_in, lang)}</p>
              {booking.checkin_time && (
                <p className="text-xs text-gray-500 font-body">ab {booking.checkin_time} Uhr</p>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400 font-body mb-0.5">{t('bookings.checkOut')}</p>
              <p className="text-sm font-bold text-hp-black font-body">{fmtDate(booking.check_out, lang)}</p>
              {booking.checkout_time && (
                <p className="text-xs text-gray-500 font-body">bis {booking.checkout_time} Uhr</p>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400 font-body mb-0.5">{t('bookings.nights_other', { count: nights })}</p>
              <p className="text-sm font-bold text-hp-black font-body">{nights}</p>
            </div>
            {booking.total_price && (
              <div>
                <p className="text-xs text-gray-400 font-body mb-0.5">{t('guest.booking.total')}</p>
                <p className="text-sm font-bold text-hp-black font-body">
                  {booking.total_price.toLocaleString(lang === 'de' ? 'de-DE' : 'en-GB', {
                    style: 'currency', currency: 'EUR',
                  })}
                </p>
              </div>
            )}
          </div>

          {/* Countdown */}
          {daysToCheckin > 0 && (
            <div className="rounded-xl px-4 py-3 flex items-center gap-3"
                 style={{ backgroundColor: '#fff7f5', border: '1px solid #ffe4dd' }}>
              <span className="text-2xl">⏳</span>
              <p className="text-sm font-semibold font-body" style={{ color: 'var(--color-highlight)' }}>
                {t('guest.booking.countdown', { count: daysToCheckin })}
              </p>
            </div>
          )}
          {daysToCheckin === 0 && (
            <div className="rounded-xl px-4 py-3 flex items-center gap-3 bg-green-50 border border-green-100">
              <span className="text-2xl">🎉</span>
              <p className="text-sm font-semibold text-green-700 font-body">
                {t('guest.booking.todayCheckin')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Karte + Navigation */}
      {prop && (() => {
        const parts = [
          [prop.street, prop.house_number].filter(Boolean).join(' '),
          [prop.zip, prop.city].filter(Boolean).join(' '),
        ].filter(Boolean)
        if (parts.length < 2) return null
        const address    = parts.join(', ')
        const encoded    = encodeURIComponent(address)
        const embedUrl   = `https://maps.google.com/maps?q=${encoded}&output=embed&z=15`
        const gmapsUrl   = `https://maps.google.com/maps?q=${encoded}`
        const gmapsNav   = `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`
        const appleMaps  = `maps://maps.apple.com/?daddr=${encoded}`
        const isIOS      = /iPhone|iPad|iPod/.test(navigator.userAgent)
        return (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
            {/* Adresse klickbar */}
            <a href={gmapsUrl} target="_blank" rel="noopener noreferrer"
               className="block px-5 pt-4 pb-2 text-sm font-semibold text-hp-black font-body
                          hover:underline decoration-hp-highlight"
               style={{ color: 'var(--color-highlight)' }}>
              📍 {address}
            </a>
            {/* Karte */}
            <div style={{ height: '250px' }} className="overflow-hidden">
              <iframe
                src={embedUrl}
                width="100%" height="250"
                style={{ border: 0, display: 'block' }}
                allowFullScreen loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                title={address}
              />
            </div>
            {/* Navigation Buttons */}
            <div className="flex flex-wrap gap-2 px-5 py-4">
              <a href={gmapsNav} target="_blank" rel="noopener noreferrer"
                 className="flex-1 min-w-[140px] flex items-center justify-center gap-2
                            px-4 py-2.5 rounded-xl text-sm font-semibold font-body text-white
                            transition-opacity hover:opacity-90"
                 style={{ backgroundColor: 'var(--color-highlight)' }}>
                🧭 {t('guest.map.navigateBtn')}
              </a>
              {isIOS && (
                <a href={appleMaps}
                   className="flex-1 min-w-[140px] flex items-center justify-center gap-2
                              px-4 py-2.5 rounded-xl text-sm font-semibold font-body
                              bg-black text-white transition-opacity hover:opacity-80">
                   {t('guest.map.appleMaps')}
                </a>
              )}
              <a href={gmapsUrl} target="_blank" rel="noopener noreferrer"
                 className="flex-1 min-w-[120px] flex items-center justify-center gap-2
                            px-4 py-2.5 rounded-xl text-sm font-semibold font-body
                            bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
                🗺️ {t('guest.map.openInMaps')}
              </a>
            </div>
          </div>
        )
      })()}

      {/* 4 Karten */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Buchungsbestätigung */}
        <Link to="/feriengast/buchung"
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5
                         hover:border-hp-highlight/40 transition-colors group">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                 style={{ backgroundColor: '#fff7f5' }}>📄</div>
            <h3 className="font-semibold text-hp-black font-body text-sm">
              {t('guest.nav.confirmation')}
            </h3>
          </div>
          <p className="text-xs text-gray-500 font-body mb-3">{t('guest.confirmation.hint')}</p>
          {booking.booking_number && (
            <p className="text-xs font-mono text-gray-400">{booking.booking_number}</p>
          )}
          <span className="text-xs font-semibold font-body mt-2 inline-block"
                style={{ color: 'var(--color-highlight)' }}>
            {t('guest.confirmation.download')} →
          </span>
        </Link>

        {/* Check-in Infos */}
        <Link to="/feriengast/checkin"
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5
                         hover:border-hp-highlight/40 transition-colors group">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                 style={{ backgroundColor: '#f0f9ff' }}>🔑</div>
            <h3 className="font-semibold text-hp-black font-body text-sm">
              {t('guest.nav.checkin')}
            </h3>
          </div>
          <p className="text-xs text-gray-500 font-body mb-3">{t('guest.checkin.hint')}</p>
          <span className="text-xs font-semibold font-body mt-2 inline-block text-blue-600">
            {t('guest.checkin.view')} →
          </span>
        </Link>

        {/* Hausregeln */}
        <Link to="/feriengast/hausregeln"
              className={`bg-white rounded-2xl border shadow-sm p-5
                          hover:border-hp-highlight/40 transition-colors
                          ${booking.agreed
                            ? 'border-green-200'
                            : 'border-amber-200'}`}>
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl
                             ${booking.agreed ? 'bg-green-50' : 'bg-amber-50'}`}>
              {booking.agreed ? '✅' : '📋'}
            </div>
            <div>
              <h3 className="font-semibold text-hp-black font-body text-sm">
                {t('guest.nav.houseRules')}
              </h3>
              {booking.agreed ? (
                <span className="text-xs text-green-600 font-body">{t('guest.houseRules.agreed')}</span>
              ) : (
                <span className="text-xs text-amber-600 font-body font-semibold">
                  {t('guest.houseRules.pendingShort')}
                </span>
              )}
            </div>
          </div>
          <span className="text-xs font-semibold font-body mt-2 inline-block text-amber-600">
            {booking.agreed ? t('guest.houseRules.view') : t('guest.houseRules.confirm')} →
          </span>
        </Link>

        {/* Nachrichten */}
        <Link to="/feriengast/nachrichten"
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5
                         hover:border-hp-highlight/40 transition-colors relative">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-purple-50">
              💬
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-hp-black font-body text-sm">
                {t('guest.nav.messages')}
              </h3>
            </div>
            {unread > 0 && (
              <span className="bg-red-500 text-white text-xs font-bold rounded-full
                               w-6 h-6 flex items-center justify-center">
                {unread}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 font-body">{t('guest.messages.hint')}</p>
          <span className="text-xs font-semibold font-body mt-2 inline-block text-purple-600">
            {t('guest.messages.open')} →
          </span>
        </Link>
      </div>
    </GuestLayout>
  )
}
