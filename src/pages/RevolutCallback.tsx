import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── /revolut — OAuth-Redirect-Ziel der Revolut-Business-Anbindung ────────────
// Revolut leitet nach dem Consent hierher (?code=...). Die Seite tauscht den
// Code sofort serverseitig gegen den refresh_token (revolut-sync exchange_code)
// — der Code ist nur ~2 Minuten gültig, deshalb vollautomatisch ohne Kopieren.

export default function RevolutCallback() {
  const [state, setState] = useState<'working' | 'done' | 'error' | 'nocode'>('working')
  const [detail, setDetail] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const code = new URLSearchParams(window.location.search).get('code')
    if (!code) { setState('nocode'); return }
    supabase.functions.invoke('revolut-sync', { body: { action: 'exchange_code', code } })
      .then(async ({ data, error }) => {
        if (error) {
          const t = await (error as { context?: Response }).context?.text?.().catch(() => null)
          throw new Error(t || error.message)
        }
        if (!(data as { success?: boolean } | null)?.success) throw new Error(JSON.stringify(data))
        setState('done')
      })
      .catch((e: unknown) => {
        setState('error')
        setDetail(e instanceof Error ? e.message : String(e))
      })
  }, [])

  return (
    <div className="min-h-screen font-body flex flex-col items-center justify-center px-5" style={{ background: '#FAF6EC' }}>
      <img src={DECK_LOGO} alt="Happy Property" className="h-9 w-auto mb-8" />
      <div className="w-full max-w-md bg-white rounded-2xl border border-[#e6dfd0] shadow-sm p-8 text-center">
        {state === 'working' && (<>
          <div className="w-8 h-8 mx-auto border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          <p className="mt-4 text-sm text-gray-600">Verbinde mit Revolut…</p>
        </>)}
        {state === 'done' && (<>
          <div className="text-5xl">✅</div>
          <h1 className="font-heading font-bold text-2xl mt-3" style={{ color: '#1a2332' }}>Revolut verbunden!</h1>
          <p className="mt-2 text-sm text-gray-500">Der tägliche Zahlungsabgleich ist aktiv (jeden Morgen 4:00 Uhr). Du kannst dieses Fenster schließen.</p>
        </>)}
        {state === 'error' && (<>
          <div className="text-5xl">⚠️</div>
          <h1 className="font-heading font-bold text-2xl mt-3" style={{ color: '#1a2332' }}>Das hat nicht geklappt</h1>
          <p className="mt-2 text-sm text-gray-500">Der Code ist vermutlich abgelaufen (gilt nur ~2 Minuten). Bitte in Revolut einfach noch einmal auf „API-Zugriff aktivieren" klicken.</p>
          <p className="mt-3 text-[11px] text-gray-400 break-all">{detail.slice(0, 200)}</p>
        </>)}
        {state === 'nocode' && (<>
          <div className="text-5xl">🔌</div>
          <h1 className="font-heading font-bold text-2xl mt-3" style={{ color: '#1a2332' }}>Revolut-Anbindung</h1>
          <p className="mt-2 text-sm text-gray-500">Diese Seite wird automatisch von Revolut aufgerufen. Zum Verbinden in Revolut Business unter Einstellungen → APIs auf „API-Zugriff aktivieren" klicken.</p>
        </>)}
      </div>
    </div>
  )
}
