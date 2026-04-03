import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import GuestLayout from '../../components/GuestLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

interface Agreement {
  id: string
  booking_id: string
  house_rules: string | null
  agreed_at: string | null
  ip_address: string | null
}

export default function Hausregeln() {
  const { t }       = useTranslation()
  const { profile } = useAuth()

  const [agreement, setAgreement] = useState<Agreement | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [houseRules, setHouseRules] = useState<string | null>(null)
  const [loading, setLoading]     = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [checked, setChecked]     = useState(false)
  const [toast, setToast]         = useState('')
  const [toastType, setToastType] = useState<'success' | 'error'>('success')

  useEffect(() => {
    if (!profile) return
    ;(async () => {
      // Neueste Buchung laden
      const { data: bData } = await supabase
        .from('bookings')
        .select('id, house_rules')
        .eq('guest_id', profile.id)
        .order('check_in', { ascending: false })
        .limit(1)
        .single()

      if (bData) {
        setBookingId(bData.id)
        setHouseRules(bData.house_rules)

        // Zustimmung laden
        const { data: ag } = await supabase
          .from('guest_agreements')
          .select('id, booking_id, house_rules, agreed_at, ip_address')
          .eq('booking_id', bData.id)
          .single()
        setAgreement(ag as Agreement | null)
      }
      setLoading(false)
    })()
  }, [profile])

  async function handleAgree() {
    if (!checked || !bookingId || !profile) return
    setAccepting(true)
    try {
      // Öffentliche IP ermitteln (best-effort)
      let ip = ''
      try {
        const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) })
        const d = await r.json()
        ip = d.ip ?? ''
      } catch { /* ignore */ }

      const now = new Date().toISOString()

      let opError
      if (agreement?.id) {
        // Update existing
        const { error } = await supabase
          .from('guest_agreements')
          .update({ agreed_at: now, ip_address: ip, house_rules: houseRules })
          .eq('id', agreement.id)
        opError = error
      } else {
        // Insert new (check_in/check_out nullable seit Migration 007)
        const { error } = await supabase
          .from('guest_agreements')
          .insert({
            booking_id:  bookingId,
            guest_id:    profile.id,
            house_rules: houseRules,
            agreed_at:   now,
            ip_address:  ip,
          })
        opError = error
      }

      if (opError) {
        setToastType('error')
        setToast(t('errors.saveFailed'))
        setTimeout(() => setToast(''), 4000)
        return
      }

      // Reload
      const { data: ag } = await supabase
        .from('guest_agreements')
        .select('id, booking_id, house_rules, agreed_at, ip_address')
        .eq('booking_id', bookingId)
        .single()
      setAgreement(ag as Agreement | null)
      setToastType('success')
      setToast(t('guest.houseRules.acceptedToast'))
      setTimeout(() => setToast(''), 3500)
    } finally {
      setAccepting(false)
    }
  }

  function fmtDt(iso: string) {
    return new Date(iso).toLocaleString(profile?.language === 'de' ? 'de-DE' : 'en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const agreed = !!agreement?.agreed_at

  return (
    <GuestLayout>
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-5 py-3 text-white text-sm
                        font-body rounded-2xl shadow-xl flex items-center gap-2
                        ${toastType === 'error' ? 'bg-red-600' : 'bg-green-600'}`}>
          {toastType === 'error' ? '✗' : '✓'} {toast}
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-hp-black font-body">{t('guest.nav.houseRules')}</h1>
        <p className="text-sm text-gray-400 font-body mt-0.5">{t('guest.houseRules.subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="max-w-2xl space-y-5">

          {/* Status Banner */}
          {agreed ? (
            <div className="bg-green-50 border border-green-200 rounded-2xl px-5 py-4 flex items-start gap-3">
              <span className="text-2xl shrink-0">✅</span>
              <div>
                <p className="font-semibold text-green-800 font-body text-sm">
                  {t('guest.houseRules.agreedTitle')}
                </p>
                <p className="text-xs text-green-700 font-body mt-0.5">
                  {t('guest.houseRules.agreedAt')}: {fmtDt(agreement!.agreed_at!)}
                  {agreement?.ip_address && ` · IP: ${agreement.ip_address}`}
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 flex items-start gap-3">
              <span className="text-2xl shrink-0">⚠️</span>
              <div>
                <p className="font-semibold text-amber-800 font-body text-sm">
                  {t('guest.houseRules.pendingTitle')}
                </p>
                <p className="text-xs text-amber-700 font-body mt-0.5">
                  {t('guest.houseRules.pendingDesc')}
                </p>
              </div>
            </div>
          )}

          {/* Hausregeln Text */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest font-body mb-4">
              {t('guest.houseRules.rules')}
            </h2>
            {houseRules ? (
              <div className="text-sm text-gray-700 font-body whitespace-pre-wrap leading-relaxed">
                {houseRules}
              </div>
            ) : (
              <p className="text-sm text-gray-400 font-body italic">
                {t('guest.houseRules.noRules')}
              </p>
            )}
          </div>

          {/* Zustimmung */}
          {!agreed && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <label className="flex items-start gap-3 cursor-pointer mb-4">
                <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}
                       className="mt-0.5 w-4 h-4 rounded accent-orange-500 shrink-0" />
                <span className="text-sm text-gray-700 font-body leading-relaxed">
                  {t('guest.houseRules.checkboxLabel')}
                </span>
              </label>

              <p className="text-xs text-gray-400 font-body mb-4">
                {t('guest.houseRules.legalNote')}
              </p>

              <button
                onClick={handleAgree}
                disabled={!checked || accepting}
                className="w-full py-3 rounded-xl text-white text-sm font-semibold font-body
                           hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-2"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
                {accepting && (
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                )}
                {t('guest.houseRules.submitBtn')}
              </button>
            </div>
          )}
        </div>
      )}
    </GuestLayout>
  )
}
