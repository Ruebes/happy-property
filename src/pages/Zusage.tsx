import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Termin-Zu-/Absage (/zusage?t=<manage_token>&p=<pKey>&a=yes|no) ───────────
// One-Click aus der Einladungs-Mail/WhatsApp. Verbucht die Antwort am Termin
// (crm_appointments.rsvps) und als Aktivität am Lead.

const CREAM = '#FAF6EC'
const NAVY = '#1a2332'

export default function Zusage() {
  const [state, setState] = useState<'busy' | 'yes' | 'no' | 'invalid'>('busy')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const q = new URLSearchParams(window.location.search)
    const token = (q.get('t') ?? '').trim()
    const p = (q.get('p') ?? '').trim()
    const answer = q.get('a') === 'no' ? 'no' : 'yes'
    if (!token || !p) { setState('invalid'); return }
    void (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('funnel-api', {
          body: { action: 'rsvp', token, p, answer },
        })
        if (error || !(data as { ok?: boolean } | null)?.ok) throw new Error('failed')
        setState(answer as 'yes' | 'no')
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
        {state === 'yes' && (
          <>
            <div className="text-4xl mb-3">🎉</div>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>Danke — du bist dabei!</h1>
            <p className="mt-3 text-sm text-gray-500">
              Deine Zusage ist angekommen. Sven freut sich auf den Termin — bis bald!
            </p>
          </>
        )}
        {state === 'no' && (
          <>
            <div className="text-4xl mb-3">📅</div>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>Schade — danke für die Info!</h1>
            <p className="mt-3 text-sm text-gray-500">
              Deine Absage ist angekommen. Sven meldet sich bei dir, um einen neuen Termin zu finden.
            </p>
          </>
        )}
        {state === 'invalid' && (
          <>
            <div className="text-4xl mb-3">🤔</div>
            <h1 className="font-heading font-bold text-2xl" style={{ color: NAVY }}>Link ungültig</h1>
            <p className="mt-3 text-sm text-gray-500">
              Diese Antwort konnte keinem Termin zugeordnet werden. Antworte einfach direkt auf die Einladung —
              oder schreib an <a href="mailto:info@happy-property.com" className="underline">info@happy-property.com</a>.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
