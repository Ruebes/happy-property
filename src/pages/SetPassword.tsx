import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useAuth, roleToPath } from '../lib/auth'
import LanguageSwitcher from '../components/LanguageSwitcher'

// Erkennt ob es sich um einen Passwort-Reset oder eine Einladung handelt
function getSetupMode(): 'recovery' | 'invite' {
  try {
    const hash   = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const search = new URLSearchParams(window.location.search)
    const type   = hash.get('type') ?? search.get('type')
    return type === 'recovery' ? 'recovery' : 'invite'
  } catch {
    return 'invite'
  }
}

export default function SetPassword() {
  const { t }                                                 = useTranslation()
  const navigate                                              = useNavigate()
  const { loading, session, needsPasswordSetup, updatePassword, dashboardPath } = useAuth()

  const mode                              = useMemo(getSetupMode, [])
  const [pw, setPw]                       = useState('')
  const [pwConfirm, setPwConfirm]         = useState('')
  const [showPw, setShowPw]               = useState(false)
  const [showConfirm, setShowConfirm]     = useState(false)
  const [submitting, setSubmitting]       = useState(false)
  const [error, setError]                 = useState('')
  const [done, setDone]                   = useState(false)

  // Weiterleitung falls eingeloggt aber kein Setup nötig.
  // Nur wenn NICHT bereits im Submit-Flow (done=true), um doppelte
  // Navigation durch setTimeout vs. useEffect zu vermeiden.
  useEffect(() => {
    if (!loading && session && !needsPasswordSetup && !done) {
      navigate(dashboardPath, { replace: true })
    }
  }, [loading, session, needsPasswordSetup, done, navigate, dashboardPath])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (pw.length < 8) {
      setError(t('setPassword.error.tooShort'))
      return
    }
    if (pw !== pwConfirm) {
      setError(t('setPassword.error.mismatch'))
      return
    }

    setSubmitting(true)
    const { error: err, role } = await updatePassword(pw)
    if (err) {
      setError(t('setPassword.error.failed'))
      setSubmitting(false)
      return
    }

    // Zieldashboard aus frisch zurückgegebener Rolle berechnen –
    // NICHT aus möglicherweise veraltetem dashboardPath aus dem Hook.
    const target = roleToPath(role)
    setDone(true)
    setTimeout(() => navigate(target, { replace: true }), 1500)
  }

  const title    = mode === 'recovery' ? t('setPassword.titleReset')    : t('setPassword.title')
  const subtitle = mode === 'recovery' ? t('setPassword.subtitleReset') : t('setPassword.subtitle')
  const info     = mode === 'recovery' ? t('setPassword.infoReset')     : t('setPassword.info')

  // ── Ladeanimation (Auth initialisiert sich noch) ──────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center"
           style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="w-8 h-8 border-4 rounded-full animate-spin"
             style={{ borderColor: '#e5e7eb', borderTopColor: 'var(--color-highlight)' }} />
      </div>
    )
  }

  // ── Kein gültiger Token / Link abgelaufen ─────────────────
  if (!session) {
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--color-bg)' }}>
        <header className="flex justify-end px-6 py-4">
          <LanguageSwitcher />
        </header>
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="w-full max-w-md">
            <div className="flex justify-center mb-8">
              <img src="/logo.jpg" alt="Happy Property"
                   style={{ height: '80px', width: '80px', objectFit: 'cover' }}
                   className="rounded-2xl shadow-lg" />
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0
                           001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <p className="font-semibold text-hp-black font-body mb-1">
                {t('setPassword.expiredTitle')}
              </p>
              <p className="text-sm text-gray-500 font-body mb-6">
                {t('setPassword.expiredDesc')}
              </p>
              <button
                onClick={() => navigate('/login', { replace: true })}
                className="w-full py-2.5 rounded-xl text-white text-sm font-semibold font-body
                           hover:opacity-90 transition-opacity"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
                {t('login.backToLogin')}
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  // ── Hauptformular ─────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--color-bg)' }}>
      <header className="flex justify-end px-6 py-4">
        <LanguageSwitcher />
      </header>

      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md">

          <div className="flex justify-center mb-8">
            <img src="/logo.jpg" alt="Happy Property"
                 style={{ height: '80px', width: '80px', objectFit: 'cover' }}
                 className="rounded-2xl shadow-lg" />
          </div>

          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-hp-black mb-2"
                style={{ fontFamily: 'var(--font-heading)' }}>
              {title}
            </h1>
            <p className="text-gray-500 text-sm font-body">{subtitle}</p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">

            {done ? (
              /* ── Erfolgsmeldung ── */
              <div className="text-center py-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
                     style={{ backgroundColor: 'var(--color-highlight)' }}>
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24"
                       stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                          d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="font-semibold text-hp-black font-body">{t('setPassword.success')}</p>
                <p className="text-sm text-gray-400 font-body mt-1">{t('setPassword.redirecting')}</p>
              </div>
            ) : (
              /* ── Formular ── */
              <form onSubmit={handleSubmit} className="space-y-5">

                <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 flex gap-3">
                  <span className="text-blue-400 text-lg shrink-0">
                    {mode === 'recovery' ? '🔑' : '🔐'}
                  </span>
                  <p className="text-sm text-blue-700 font-body">{info}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-hp-black mb-1.5 font-body">
                    {t('setPassword.newPassword')}
                  </label>
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      required autoFocus
                      value={pw}
                      onChange={e => setPw(e.target.value)}
                      placeholder="••••••••"
                      className="w-full px-4 py-3 pr-11 rounded-xl border border-gray-200 bg-hp-bg
                                 text-hp-black placeholder-gray-400 text-sm font-body
                                 focus:outline-none focus:ring-2 focus:ring-hp-highlight
                                 focus:border-transparent transition"
                    />
                    <button type="button" onClick={() => setShowPw(s => !s)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400
                                       hover:text-gray-600 text-base">
                      {showPw ? '🙈' : '👁'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 font-body mt-1">{t('setPassword.minLength')}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-hp-black mb-1.5 font-body">
                    {t('setPassword.confirmPassword')}
                  </label>
                  <div className="relative">
                    <input
                      type={showConfirm ? 'text' : 'password'}
                      required
                      value={pwConfirm}
                      onChange={e => setPwConfirm(e.target.value)}
                      placeholder="••••••••"
                      className="w-full px-4 py-3 pr-11 rounded-xl border border-gray-200 bg-hp-bg
                                 text-hp-black placeholder-gray-400 text-sm font-body
                                 focus:outline-none focus:ring-2 focus:ring-hp-highlight
                                 focus:border-transparent transition"
                    />
                    <button type="button" onClick={() => setShowConfirm(s => !s)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400
                                       hover:text-gray-600 text-base">
                      {showConfirm ? '🙈' : '👁'}
                    </button>
                  </div>
                </div>

                {error && (
                  <p className="text-sm text-red-500 font-body bg-red-50 px-4 py-2 rounded-lg">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-3 rounded-xl text-white text-sm font-semibold font-body
                             transition-opacity hover:opacity-90 disabled:opacity-60
                             flex items-center justify-center gap-2"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {submitting && (
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white
                                     rounded-full animate-spin" />
                  )}
                  {submitting ? t('setPassword.submitting') : t('setPassword.submit')}
                </button>
              </form>
            )}
          </div>

          <p className="text-center text-xs text-gray-400 font-body mt-6">
            © {new Date().getFullYear()} Happy Property
          </p>
        </div>
      </main>
    </div>
  )
}
