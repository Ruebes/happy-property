import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Öffentliche Anmelde-Strecke (/anmelden) ──────────────────────────────────
// Ersetzt Klaviyo-Formulare: sammelt Adressen für Lead-Magnete, Webinar-/
// Newsletter-Anmeldungen selbst und schreibt sie per Double-Opt-In in unsere
// Listen (Edge: subscriber-optin). Ein Formular pro Liste über den Link steuerbar:
//   /anmelden?list=<Listenname>&title=<Überschrift>&sub=<Text>&phone=1&lang=de
// Nach Absenden: „Bitte bestätige deine E-Mail" — der Klick im Mail-Link schaltet
// den Kontakt scharf und ordnet ihn der Liste zu.

const CREAM = '#FAF6EC'
const CORAL = '#ff795d'
const NAVY = '#1a2332'
const INK = '#1a1a1a'

function useParams() {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search)
    const get = (k: string) => (p.get(k) ?? '').trim()
    return {
      list: get('list'),
      title: get('title'),
      sub: get('sub'),
      source: get('source') || get('src'),
      phone: ['1', 'true', 'required', 'yes'].includes(get('phone').toLowerCase()),
      lang: get('lang').toLowerCase() === 'en' ? 'en' : get('lang').toLowerCase() === 'de' ? 'de' : '',
    }
  }, [])
}

export default function Anmelden() {
  const { t, i18n } = useTranslation()
  const p = useParams()
  const lang = p.lang || (i18n.language.startsWith('en') ? 'en' : 'de')
  const en = lang === 'en'

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'pending' | 'already' | null>(null)
  const [err, setErr] = useState('')

  const title = p.title || (en ? 'Sign up' : 'Jetzt anmelden')
  const sub = p.sub || (en
    ? 'Enter your details and confirm your email — that’s it.'
    : 'Trag dich ein und bestätige deine E-Mail — fertig.')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (!email.includes('@')) { setErr(en ? 'Please enter a valid email.' : 'Bitte eine gültige E-Mail angeben.'); return }
    if (p.phone && phone.trim().length < 5) { setErr(en ? 'Please enter your phone number.' : 'Bitte deine Telefonnummer angeben.'); return }
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('subscriber-optin', {
        body: {
          email: email.trim(), first_name: firstName.trim() || undefined, last_name: lastName.trim() || undefined,
          phone: phone.trim() || undefined, list: p.list, source: p.source || 'signup', lang,
        },
      })
      // invoke wirft bei non-2xx nicht immer — Fehlerfeld zusätzlich prüfen.
      const res = (data ?? {}) as { ok?: boolean; already_confirmed?: boolean; error?: string }
      if (error || res.error) throw new Error(res.error || error?.message || 'Fehler')
      setDone(res.already_confirmed ? 'already' : 'pending')
    } catch (e2) {
      console.error('[Anmelden] submit:', e2)
      setErr(en ? 'Something went wrong. Please try again.' : 'Etwas ist schiefgelaufen. Bitte nochmal versuchen.')
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-xl border px-4 py-3 text-[15px] outline-none focus:ring-2'
  const fieldStyle = { borderColor: '#e6dfce', background: '#fff' } as React.CSSProperties

  return (
    <div className="min-h-screen flex items-center justify-center p-5" style={{ background: `linear-gradient(160deg, ${CREAM}, #fff)` }}>
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl p-8 sm:p-10">
        <div className="text-center mb-6">
          <img src={DECK_LOGO} alt="Happy Property" className="h-12 w-12 rounded-xl object-cover mx-auto mb-4" />
        </div>

        {done ? (
          <div className="text-center py-4">
            <div className="text-5xl mb-3">{done === 'already' ? '✅' : '📧'}</div>
            <h1 className="text-xl font-semibold mb-2" style={{ color: NAVY }}>
              {done === 'already'
                ? (en ? 'You’re on the list!' : 'Du bist dabei!')
                : (en ? 'Almost done!' : 'Fast geschafft!')}
            </h1>
            <p className="text-[15px] leading-relaxed" style={{ color: '#4b5563' }}>
              {done === 'already'
                ? (en ? 'Your email is already confirmed — we’ve added you. You’ll hear from us soon. 🐾' : 'Deine E-Mail ist schon bestätigt — wir haben dich hinzugefügt. Du hörst bald von uns. 🐾')
                : (en ? <>We’ve sent a confirmation link to <b>{email}</b>. Please click it to complete your sign-up.</> : <>Wir haben dir einen Bestätigungslink an <b>{email}</b> geschickt. Bitte klick ihn an, um die Anmeldung abzuschließen.</>)}
            </p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold mb-2" style={{ color: INK }}>{title}</h1>
              <p className="text-[15px]" style={{ color: '#6b7280' }}>{sub}</p>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input className={field} style={fieldStyle} placeholder={en ? 'First name' : 'Vorname'} value={firstName} onChange={e => setFirstName(e.target.value)} autoComplete="given-name" />
                <input className={field} style={fieldStyle} placeholder={en ? 'Last name' : 'Nachname'} value={lastName} onChange={e => setLastName(e.target.value)} autoComplete="family-name" />
              </div>
              <input className={field} style={fieldStyle} type="email" required placeholder={en ? 'Email address' : 'E-Mail-Adresse'} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
              {p.phone && (
                <input className={field} style={fieldStyle} type="tel" placeholder={en ? 'Phone (WhatsApp)' : 'Telefon (WhatsApp)'} value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" />
              )}
              {err && <p className="text-sm text-red-600">{err}</p>}
              <button type="submit" disabled={busy || !p.list} className="w-full rounded-xl py-3.5 text-white font-semibold text-[15px] transition disabled:opacity-60"
                style={{ background: CORAL }}>
                {busy ? (en ? 'Sending…' : 'Wird gesendet…') : (en ? 'Sign up' : 'Anmelden')}
              </button>
              {!p.list && <p className="text-xs text-center text-amber-600">{en ? 'No list configured (missing ?list= parameter).' : 'Keine Liste konfiguriert (Parameter ?list= fehlt).'}</p>}
              <p className="text-[11px] text-center leading-relaxed pt-1" style={{ color: '#9ca3af' }}>
                {en
                  ? 'By signing up you agree to receive emails from Happy Property. You can unsubscribe anytime.'
                  : 'Mit der Anmeldung stimmst du dem Erhalt von E-Mails von Happy Property zu. Abmeldung jederzeit möglich.'}
              </p>
            </form>
          </>
        )}
        <p className="mt-6 text-center text-xs" style={{ color: '#b8b09a' }}>{t('common.brand', 'Happy Property Cyprus')}</p>
      </div>
    </div>
  )
}
