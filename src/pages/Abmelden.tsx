import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Newsletter-Abmeldung ─────────────────────────────────────────────────────
// One-Click: Beim Öffnen wird die Abmeldung direkt ausgeführt (Standard bei
// Newsletter-Abmeldelinks — keine weitere Hürde). Setzt NUR das Newsletter-
// Opt-out; Termin-/Kundenkommunikation läuft normal weiter.
// Drei Link-Formen: ?d=<Deck-Token> (Objekt-Newsletter, Lead) · ?l=<Lead-ID> und
// ?s=<Abonnent-ID> (HTML-Newsletter, direkt).

const CREAM = '#FAF6EC'
const NAVY = '#1a2332'

export default function Abmelden() {
  const [state, setState] = useState<'busy' | 'done' | 'invalid'>('busy')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return   // StrictMode-Doppelmount: nur einmal ausführen
    ran.current = true
    const p = new URLSearchParams(window.location.search)
    const token = (p.get('d') ?? '').trim()
    const lead = (p.get('l') ?? '').trim()
    const subscriber = (p.get('s') ?? '').trim()
    if (!token && !lead && !subscriber) { setState('invalid'); return }
    void (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('newsletter-campaign', {
          body: { action: 'unsubscribe', deck_token: token || undefined, lead: lead || undefined, subscriber: subscriber || undefined },
        })
        if (error || !(data as { ok?: boolean } | null)?.ok) throw new Error('failed')
        setState('done')
      } catch {
        setState('invalid')
      }
    })()
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center px-5" style={{ background: CREAM }}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8 text-center">
        <img src={DECK_LOGO} alt="Happy Property" className="h-9 w-auto mx-auto mb-6" />
        {state === 'busy' && (
          <div className="py-6 flex justify-center">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        )}
        {state === 'done' && (
          <>
            <div className="text-4xl mb-3">✅</div>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>Du bist abgemeldet.</h1>
            <p className="mt-3 text-sm text-gray-500">
              Du bekommst ab sofort keine Objekt-Empfehlungen mehr per E-Mail von uns.
              Persönliche Nachrichten zu deinen laufenden Anfragen und Terminen sind davon nicht betroffen.
            </p>
            <p className="mt-4 text-xs text-gray-400">
              Falls du es dir anders überlegst, schreib uns einfach an{' '}
              <a href="mailto:info@happy-property.com" className="underline">info@happy-property.com</a>.
            </p>
          </>
        )}
        {state === 'invalid' && (
          <>
            <div className="text-4xl mb-3">🤔</div>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>Link ungültig</h1>
            <p className="mt-3 text-sm text-gray-500">
              Dieser Abmelde-Link konnte keinem Kontakt zugeordnet werden. Schreib uns kurz an{' '}
              <a href="mailto:info@happy-property.com" className="underline">info@happy-property.com</a>{' '}
              — dann nehmen wir dich manuell heraus.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
