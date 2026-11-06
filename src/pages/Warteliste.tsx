import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Warteliste aus dem Newsletter (/warteliste?l=<Lead-ID> bzw. ?s=<Abonnent-ID>) ──
// One-Click wie /abmelden: Beim Öffnen wird der Eintrag direkt ausgeführt. Ohne
// Kennung (Vorschau, Testmail) wird niemand eingetragen. Automatisierte Browser
// (navigator.webdriver) tragen nicht ein, sie sehen nur den Knopf.

const CREAM = '#FAF6EC'
const NAVY = '#1a2332'
const CORAL = '#ff795d'

type State = 'busy' | 'confirm' | 'done' | 'vorschau' | 'invalid'

export default function Warteliste() {
  const [state, setState] = useState<State>('busy')
  const [vorname, setVorname] = useState('')
  const [terminUrl, setTerminUrl] = useState('')
  const ran = useRef(false)

  const eintragen = async () => {
    const p = new URLSearchParams(window.location.search)
    setState('busy')
    try {
      const { data, error } = await supabase.functions.invoke('newsletter-campaign', {
        body: { action: 'warteliste', lead: (p.get('l') ?? '').trim() || undefined, subscriber: (p.get('s') ?? '').trim() || undefined },
      })
      const d = data as { ok?: boolean; first_name?: string; termin_url?: string } | null
      if (error || !d?.ok) throw new Error('failed')
      setVorname(d.first_name ?? '')
      setTerminUrl(d.termin_url ?? '')
      setState('done')
    } catch {
      setState('invalid')
    }
  }

  useEffect(() => {
    if (ran.current) return   // StrictMode-Doppelmount: nur einmal ausführen
    ran.current = true
    const p = new URLSearchParams(window.location.search)
    if (!p.get('l') && !p.get('s')) { setState('vorschau'); return }
    if (navigator.webdriver) { setState('confirm'); return }
    void eintragen()
  }, [])

  const knopf = 'inline-block mt-6 px-6 py-3 rounded-lg font-semibold text-white'
  return (
    <div className="min-h-screen flex items-center justify-center px-5" style={{ background: CREAM }}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8 text-center">
        <img src={DECK_LOGO} alt="Happy Property" className="h-9 w-auto mx-auto mb-6" />
        {state === 'busy' && (
          <div className="py-6 flex justify-center">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        )}
        {state === 'confirm' && (
          <>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>Auf die Warteliste?</h1>
            <button type="button" onClick={() => void eintragen()} className={knopf} style={{ background: CORAL }}>Ja, eintragen</button>
          </>
        )}
        {(state === 'done' || state === 'vorschau') && (
          <>
            <div className="text-4xl mb-3">✅</div>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>
              {vorname ? `${vorname}, du stehst auf der Warteliste.` : 'Du stehst auf der Warteliste.'}
            </h1>
            <p className="mt-3 text-sm text-gray-600">
              Ich verhandle gerade mit dem Bauträger über weitere Einheiten. Ob es klappt, weiß ich noch nicht.
              Wird eine frei, melde ich mich persönlich bei dir. Für dich ist das unverbindlich.
            </p>
            <p className="mt-3 text-sm text-gray-600">Sven</p>
            <a href={terminUrl || '/termin?f=none&src=newsletter'} className={knopf} style={{ background: CORAL }}>
              Lieber gleich sprechen? Termin aussuchen
            </a>
            <p className="mt-5 text-xs text-gray-400">
              Versehentlich geklickt? Schreib kurz an{' '}
              <a href="mailto:info@happy-property.com" className="underline">info@happy-property.com</a>.
            </p>
            {state === 'vorschau' && <p className="mt-3 text-xs text-gray-400">Vorschau: Es wurde niemand eingetragen.</p>}
          </>
        )}
        {state === 'invalid' && (
          <>
            <div className="text-4xl mb-3">🤔</div>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>Das hat nicht geklappt</h1>
            <p className="mt-3 text-sm text-gray-500">
              Schreib uns kurz an{' '}
              <a href="mailto:info@happy-property.com" className="underline">info@happy-property.com</a>,
              dann tragen wir dich von Hand ein.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
