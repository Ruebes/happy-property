import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { purgeAndReload } from '../lib/lazyWithReload'

// Hinweis „Neue Version verfügbar" im CRM (Sven 23.10.26).
//
// Problem: Safari liefert nach einem Deploy oft weiter die alte, vom Service-Worker
// gespeicherte App aus, auch nach Neu laden. Darum fragt die App selbst nach: Sie
// holt die aktuelle index.html am Service-Worker vorbei (Query-Parameter, no-store)
// und vergleicht deren Bau-Kennung (<meta name="hp-build">) mit der laufenden.
// Bei Abweichung erscheint oben ein Hinweis. Kein automatischer Reload, damit
// nichts Getipptes verloren geht. Nur im Team-Bereich (/admin), nie auf Kundenseiten.

const PRUEF_INTERVALL_MS = 5 * 60 * 1000

function laufendeKennung(): string {
  return document.querySelector('meta[name="hp-build"]')?.getAttribute('content') ?? __BUILD_ID__
}

async function serverKennung(): Promise<string | null> {
  try {
    const res = await fetch(`/index.html?hpv=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const html = await res.text()
    return html.match(/<meta name="hp-build" content="([^"]+)"/)?.[1] ?? null
  } catch {
    return null
  }
}

export default function UpdateBanner() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [neu, setNeu] = useState(false)
  const imTeamBereich = pathname.startsWith('/admin')

  useEffect(() => {
    if (import.meta.env.DEV || !imTeamBereich || neu) return
    const pruefen = async () => {
      if (document.visibilityState !== 'visible') return
      const server = await serverKennung()
      if (server && server !== laufendeKennung()) setNeu(true)
    }
    void pruefen()
    const id = window.setInterval(() => void pruefen(), PRUEF_INTERVALL_MS)
    const beiSichtbar = () => { if (document.visibilityState === 'visible') void pruefen() }
    document.addEventListener('visibilitychange', beiSichtbar)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', beiSichtbar) }
  }, [imTeamBereich, neu])

  if (!neu || !imTeamBereich) return null
  return (
    <div className="fixed top-3 inset-x-0 z-[1000] flex justify-center px-3 pointer-events-none">
      <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-[#1a2332] text-white shadow-2xl px-4 py-2.5 text-sm max-w-full">
        <span className="font-semibold">{t('update.title', 'Neue Version verfügbar')}</span>
        <button
          onClick={() => void purgeAndReload()}
          className="rounded-xl px-3 py-1.5 font-semibold text-white"
          style={{ backgroundColor: '#ff795d' }}
        >
          {t('update.reload', 'Jetzt laden')}
        </button>
      </div>
    </div>
  )
}
