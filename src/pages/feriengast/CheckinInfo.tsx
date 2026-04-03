import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import GuestLayout from '../../components/GuestLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

interface BookingInfo {
  checkin_time: string | null
  checkout_time: string | null
  key_handover: string | null
  wifi_name: string | null
  wifi_password: string | null
  parking_info: string | null
  emergency_contact: string | null
  property: {
    project_name: string
    street: string | null
    house_number: string | null
    zip: string | null
    city: string | null
  } | null
}

function InfoCard({ icon, title, value }: { icon: string; title: string; value: string | null }) {
  const { t } = useTranslation()
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xl">{icon}</span>
        <h3 className="font-semibold text-hp-black font-body text-sm">{title}</h3>
      </div>
      {value ? (
        <p className="text-sm text-gray-700 font-body whitespace-pre-wrap leading-relaxed">{value}</p>
      ) : (
        <p className="text-sm text-gray-400 font-body italic">{t('common.na')}</p>
      )}
    </div>
  )
}

export default function CheckinInfo() {
  const { t }       = useTranslation()
  const { profile } = useAuth()

  const [info, setInfo]     = useState<BookingInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    ;(async () => {
      const { data } = await supabase
        .from('bookings')
        .select(`
          checkin_time, checkout_time, key_handover, wifi_name, wifi_password,
          parking_info, emergency_contact,
          property:property_id(project_name, street, house_number, zip, city)
        `)
        .eq('guest_id', profile.id)
        .order('check_in', { ascending: false })
        .limit(1)
        .single()
      setInfo(data as BookingInfo | null)
      setLoading(false)
    })()
  }, [profile])

  return (
    <GuestLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-hp-black font-body">{t('guest.nav.checkin')}</h1>
        <p className="text-sm text-gray-400 font-body mt-0.5">
          {info?.property?.project_name}
          {info?.property?.city && ` · ${info.property.city}`}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : !info ? (
        <div className="text-center py-32 text-gray-400 font-body">{t('guest.noBooking.desc')}</div>
      ) : (
        <>
        {/* Großer Navigations-Button + Karte */}
        {(() => {
          const prop = info.property
          const parts = [
            [prop?.street, prop?.house_number].filter(Boolean).join(' '),
            [prop?.zip, prop?.city].filter(Boolean).join(' '),
          ].filter(Boolean)
          if (parts.length < 2) return null
          const address   = parts.join(', ')
          const encoded   = encodeURIComponent(address)
          const embedUrl  = `https://maps.google.com/maps?q=${encoded}&output=embed&z=15`
          const gmapsUrl  = `https://maps.google.com/maps?q=${encoded}`
          const gmapsNav  = `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`
          const appleMaps = `maps://maps.apple.com/?daddr=${encoded}`
          const isIOS     = /iPhone|iPad|iPod/.test(navigator.userAgent)
          return (
            <div className="mb-6">
              {/* Prominenter CTA */}
              <a href={gmapsNav} target="_blank" rel="noopener noreferrer"
                 className="flex items-center justify-center gap-3 w-full py-4 rounded-2xl
                            text-white font-semibold font-body text-base shadow-md
                            hover:opacity-90 transition-opacity mb-4"
                 style={{ backgroundColor: 'var(--color-highlight)' }}>
                🧭 {t('guest.checkin.navigateBtn')}
              </a>

              {/* Karte */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <a href={gmapsUrl} target="_blank" rel="noopener noreferrer"
                   className="block px-5 pt-4 pb-2 text-sm font-semibold font-body hover:underline"
                   style={{ color: 'var(--color-highlight)' }}>
                  📍 {address}
                </a>
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
                <div className="flex flex-wrap gap-2 px-5 py-4">
                  <a href={gmapsNav} target="_blank" rel="noopener noreferrer"
                     className="flex-1 min-w-[140px] flex items-center justify-center gap-2
                                px-4 py-2.5 rounded-xl text-sm font-semibold font-body text-white
                                hover:opacity-90 transition-opacity"
                     style={{ backgroundColor: 'var(--color-highlight)' }}>
                    🧭 {t('guest.map.navigateBtn')}
                  </a>
                  {isIOS && (
                    <a href={appleMaps}
                       className="flex-1 min-w-[140px] flex items-center justify-center gap-2
                                  px-4 py-2.5 rounded-xl text-sm font-semibold font-body
                                  bg-black text-white hover:opacity-80 transition-opacity">
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
            </div>
          )
        })()}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InfoCard icon="🕐" title={t('guest.checkin.checkinTime')}
                    value={info.checkin_time ? `ab ${info.checkin_time} Uhr` : null} />
          <InfoCard icon="🕙" title={t('guest.checkin.checkoutTime')}
                    value={info.checkout_time ? `bis ${info.checkout_time} Uhr` : null} />
          <InfoCard icon="🔑" title={t('guest.checkin.keyHandover')} value={info.key_handover} />
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-2xl">📶</span>
              <h3 className="font-semibold text-hp-black font-body text-sm">WLAN</h3>
            </div>
            {info.wifi_name ? (
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-gray-400 font-body">Netzwerk</p>
                  <p className="text-sm font-mono font-bold text-hp-black">{info.wifi_name}</p>
                </div>
                {info.wifi_password && (
                  <div>
                    <p className="text-xs text-gray-400 font-body">Passwort</p>
                    <p className="text-sm font-mono font-bold text-hp-black">{info.wifi_password}</p>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 font-body italic">{t('common.na')}</p>
            )}
          </div>
          <InfoCard icon="🚗" title={t('guest.checkin.parking')} value={info.parking_info} />
          <InfoCard icon="🆘" title={t('guest.checkin.emergency')} value={info.emergency_contact} />
        </div>
        </>
      )}
    </GuestLayout>
  )
}
