import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── Deck-Feinschliff per Chat ─────────────────────────────────────────────────
// Freitext-Anweisung an die KI (refine-deck) → bearbeitet das bestehende Deck
// IN-PLACE (gleicher Link). Für die individuellen Kunden-Decks aus dem Wizard,
// damit man sie nach dem Erstellen noch anpassen kann (wie beim Projekt-Deck).
// „Für alle Decks merken" speichert die Anweisung als gelernte Vorgabe.
//
// Standard: Hintergrund-Lauf — „Anwenden" feuert die KI ab und SCHLIESST sofort,
// damit Sven das nächste Deck prüfen/bearbeiten kann. Der Status (läuft / fertig /
// Farbe) erscheint in der Angebots-Liste (onStarted → Polling dort). Undo bleibt
// synchron (schnell, kein Claude-Call).

export default function DeckChat({ token, label, onClose, onStarted }: { token: string; label?: string; onClose: () => void; onStarted?: (token: string) => void }) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [busy, setBusy]   = useState(false)
  const [learn, setLearn] = useState(false)
  const [msg, setMsg]     = useState<{ ok: boolean; text: string } | null>(null)
  const origin = window.location.origin

  // Anwenden → Hintergrund. Feuert ab, meldet dem Eltern-Element den Start und schließt.
  const apply = async () => {
    if (busy || !input.trim()) return
    setBusy(true); setMsg(null)
    try {
      const { error } = await supabase.functions.invoke('refine-deck', {
        body: { token, instruction: input.trim(), learn, background: true },
      })
      if (error) throw new Error(error.message)
      onStarted?.(token)
      onClose()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : t('deckChat.error', 'Fehler') })
      setBusy(false)
    }
  }

  const undo = async () => {
    if (busy) return
    setBusy(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('refine-deck', { body: { token, action: 'undo' } })
      if (error) throw new Error(error.message)
      const d = data as { error?: string } | null
      if (d?.error) throw new Error(d.error)
      setMsg({ ok: true, text: t('deckChat.undoSuccess', 'Rückgängig gemacht — Deck-Link neu laden zum Ansehen.') })
      onStarted?.(token)
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : t('deckChat.error', 'Fehler') })
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900 truncate">✏️ {t('deckChat.title', 'Deck anpassen')}{label ? ` · ${label}` : ''}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none shrink-0">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-gray-500 leading-relaxed">{t('deckChat.instructions', 'Sag der KI in eigenen Worten, was geändert werden soll — z.B. „Titelbild gegen das Pool-Bild tauschen", „Einleitung kürzer und persönlicher", „Zahlungsplan weiter nach oben", „den Absatz zur 5-Jahres-Garantie betonen". Der Link bleibt gleich.')}</p>
          <textarea rows={3} value={input} onChange={e => setInput(e.target.value)} disabled={busy}
            placeholder={t('deckChat.inputPlaceholder', 'Was soll am Deck geändert werden?')}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={learn} onChange={e => setLearn(e.target.checked)} className="accent-orange-500 w-4 h-4" />
            {t('deckChat.rememberForAll', 'Für alle künftigen Decks merken')}
          </label>
          <p className="text-[11px] text-gray-400 leading-relaxed">{t('deckChat.backgroundHint', 'Läuft im Hintergrund — du kannst direkt das nächste Deck prüfen. Sobald fertig, wechselt die Farbe des Deck-Buttons in der Angebots-Liste.')}</p>
          {msg && <p className={`text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>{msg.text}</p>}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-3">
              <a href={`${origin}/deck/${token}`} target="_blank" rel="noreferrer" className="text-xs text-gray-500 underline">{t('deckChat.openDeck', 'Deck öffnen')}</a>
              <button onClick={() => void undo()} disabled={busy} className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40">↶ {t('deckChat.undo', 'Rückgängig')}</button>
            </div>
            <button onClick={() => void apply()} disabled={busy || !input.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {busy ? t('deckChat.starting', 'Wird gestartet…') : t('deckChat.apply', 'Anwenden')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
