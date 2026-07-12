import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Kurzlink-Weiterleitung (/s/:code) — für lange Kalender-/Zusage-URLs ──────
export default function ShortLink() {
  const { code } = useParams()
  const [invalid, setInvalid] = useState(false)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void (async () => {
      try {
        const { data, error } = await supabase.from('short_links').select('target').eq('code', code ?? '').maybeSingle()
        const target = (data as { target?: string } | null)?.target
        if (error || !target) { setInvalid(true); return }
        window.location.replace(target)
      } catch {
        setInvalid(true)
      }
    })()
  }, [code])

  return (
    <div className="min-h-screen flex items-center justify-center px-5" style={{ background: '#FAF6EC' }}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8 text-center">
        <img src={DECK_LOGO} alt="Happy Property" className="h-9 w-auto mx-auto mb-6" />
        {invalid ? (
          <p className="text-sm text-gray-500">Dieser Link ist ungültig oder abgelaufen.</p>
        ) : (
          <div className="py-4 flex justify-center">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  )
}
