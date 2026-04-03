import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useAuth } from '../lib/auth'

// ── Ansichten ────────────────────────────────────────────────
type View = 'login' | 'forgot' | 'forgot-sent'

export default function Login() {
  const { t }      = useTranslation()
  const navigate   = useNavigate()
  const { signIn, resetPasswordEmail, session, dashboardPath, loading, needsPasswordSetup } = useAuth()

  const [view, setView]             = useState<View>('login')
  const [email, setEmail]           = useState('')
  const [password, setPassword]     = useState('')
  const [resetEmail, setResetEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState('')

  // Wenn eingeloggt → weiterleiten.
  // Passwort-Setup (Einladung oder Reset-Link) → /set-password statt Dashboard.
  useEffect(() => {
    if (!loading && session) {
      if (needsPasswordSetup) {
        navigate('/set-password', { replace: true })
      } else {
        navigate(dashboardPath, { replace: true })
      }
    }
  }, [session, loading, navigate, dashboardPath, needsPasswordSetup])

  // ── Login ────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    const { error: err } = await signIn(email, password)
    if (err) {
      setError(t('login.error'))
      setSubmitting(false)
    }
    // Bei Erfolg übernimmt useEffect die Weiterleitung
  }

  // ── Passwort vergessen ────────────────────────────────────
  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    const { error: err } = await resetPasswordEmail(resetEmail)
    setSubmitting(false)
    if (err) {
      setError(t('login.forgotError'))
    } else {
      setView('forgot-sent')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center"
           style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="w-8 h-8 border-4 rounded-full animate-spin"
             style={{ borderColor: '#e5e7eb', borderTopColor: 'var(--color-highlight)' }} />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--color-bg)' }}>
      {/* Top bar */}
      <header className="flex justify-end px-6 py-4">
        <LanguageSwitcher />
      </header>

      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md">

          {/* Logo */}
          <div className="flex justify-center mb-8">
            <img
              src="/logo.jpg"
              alt={t('app.name')}
              style={{ height: '80px', width: '80px', objectFit: 'cover' }}
              className="rounded-2xl shadow-lg"
            />
          </div>

          {/* Heading */}
          <div className="text-center mb-8">
            <h1
              className="text-4xl font-bold text-hp-black mb-2"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              {view === 'login' ? t('login.title') : t('login.forgotTitle')}
            </h1>
            <p className="text-gray-500 text-sm font-body">
              {view === 'login'
                ? t('login.subtitle')
                : view === 'forgot-sent'
                  ? t('login.forgotSentSubtitle')
                  : t('login.forgotSubtitle')}
            </p>
          </div>

          {/* ══ Karte ══ */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">

            {/* ── Login-Formular ── */}
            {view === 'login' && (
              <form onSubmit={handleLogin} className="space-y-5">
                <div>
                  <label htmlFor="email"
                         className="block text-sm font-medium text-hp-black mb-1.5 font-body">
                    {t('login.email')}
                  </label>
                  <input
                    id="email" type="email" autoComplete="email" required
                    value={email} onChange={e => setEmail(e.target.value)}
                    placeholder={t('login.emailPlaceholder')}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-hp-bg
                               text-hp-black placeholder-gray-400 text-sm font-body
                               focus:outline-none focus:ring-2 focus:ring-hp-highlight
                               focus:border-transparent transition"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="password"
                           className="block text-sm font-medium text-hp-black font-body">
                      {t('login.password')}
                    </label>
                    <button
                      type="button"
                      onClick={() => { setError(''); setResetEmail(email); setView('forgot') }}
                      className="text-xs font-body text-hp-highlight hover:underline">
                      {t('login.forgotPassword')}
                    </button>
                  </div>
                  <input
                    id="password" type="password" autoComplete="current-password" required
                    value={password} onChange={e => setPassword(e.target.value)}
                    placeholder={t('login.passwordPlaceholder')}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-hp-bg
                               text-hp-black placeholder-gray-400 text-sm font-body
                               focus:outline-none focus:ring-2 focus:ring-hp-highlight
                               focus:border-transparent transition"
                  />
                </div>

                {error && (
                  <p className="text-sm text-red-500 font-body bg-red-50 px-4 py-2 rounded-lg">
                    {error}
                  </p>
                )}

                <button
                  type="submit" disabled={submitting}
                  className="w-full py-3 rounded-xl text-white text-sm font-semibold font-body
                             transition-opacity hover:opacity-90 disabled:opacity-60
                             flex items-center justify-center gap-2"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {submitting && (
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  )}
                  {submitting ? t('login.loading') : t('login.submit')}
                </button>
              </form>
            )}

            {/* ── Passwort-vergessen-Formular ── */}
            {view === 'forgot' && (
              <form onSubmit={handleForgot} className="space-y-5">
                <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                  <p className="text-sm text-blue-700 font-body">
                    {t('login.forgotHint')}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-hp-black mb-1.5 font-body">
                    {t('login.email')}
                  </label>
                  <input
                    type="email" required autoFocus
                    value={resetEmail} onChange={e => setResetEmail(e.target.value)}
                    placeholder={t('login.emailPlaceholder')}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-hp-bg
                               text-hp-black placeholder-gray-400 text-sm font-body
                               focus:outline-none focus:ring-2 focus:ring-hp-highlight
                               focus:border-transparent transition"
                  />
                </div>

                {error && (
                  <p className="text-sm text-red-500 font-body bg-red-50 px-4 py-2 rounded-lg">
                    {error}
                  </p>
                )}

                <button
                  type="submit" disabled={submitting}
                  className="w-full py-3 rounded-xl text-white text-sm font-semibold font-body
                             transition-opacity hover:opacity-90 disabled:opacity-60
                             flex items-center justify-center gap-2"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {submitting && (
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  )}
                  {submitting ? t('login.loading') : t('login.forgotSend')}
                </button>

                <button
                  type="button"
                  onClick={() => { setError(''); setView('login') }}
                  className="w-full py-2 text-sm font-body text-gray-500 hover:text-hp-black transition-colors">
                  ← {t('login.backToLogin')}
                </button>
              </form>
            )}

            {/* ── E-Mail versendet ── */}
            {view === 'forgot-sent' && (
              <div className="text-center py-2 space-y-4">
                <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto"
                     style={{ backgroundColor: 'var(--color-highlight)' }}>
                  <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24"
                       stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0
                             002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-hp-black font-body text-lg mb-1">
                    {t('login.forgotSentTitle')}
                  </p>
                  <p className="text-sm text-gray-500 font-body">
                    {t('login.forgotSentDesc', { email: resetEmail })}
                  </p>
                </div>
                <p className="text-xs text-gray-400 font-body bg-gray-50 rounded-xl px-4 py-2.5">
                  {t('login.forgotSentSpam')}
                </p>
                <button
                  type="button"
                  onClick={() => { setError(''); setView('login') }}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold font-body
                             border border-gray-200 text-gray-600
                             hover:border-hp-highlight hover:text-hp-highlight transition-colors">
                  {t('login.backToLogin')}
                </button>
              </div>
            )}
          </div>

          <p className="text-center text-xs text-gray-400 font-body mt-6">
            {t('app.copyright', { year: new Date().getFullYear() })}
          </p>
        </div>
      </main>
    </div>
  )
}
