import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── Deck-Feinschliff als Chat ─────────────────────────────────────────────────
// Echtes Gesprächsfenster (wie ein Chat): Sven schreibt in eigenen Worten, was am
// Deck geändert werden soll, die KI (refine-deck) bearbeitet es IN-PLACE (gleicher
// Link) und antwortet in natürlicher Sprache, was sie getan hat. Bleibt offen für
// Rückfragen — man kann Schritt für Schritt weiter verfeinern.
//
// Ablauf: Anweisung → refine-deck (background) → Polling auf sales_decks.refining;
// sobald fertig, wird refine_summary (oder refine_error) als Antwort angezeigt und
// die Angebots-Liste (onStarted) über die neue Revision informiert. „Rückgängig"
// nimmt die letzte Änderung zurück.

type Msg = { id: number; role: 'user' | 'assistant'; text: string; state?: 'thinking' | 'done' | 'error' }

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export default function DeckChat({ token, label, onClose, onStarted }: { token: string; label?: string; onClose: () => void; onStarted?: (token: string) => void }) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [learn, setLearn] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([{
    id: 0, role: 'assistant', state: 'done',
    text: t('deckChat.greeting', 'Was soll ich am Deck ändern? Schreib’s mir einfach — z.B. „Titelbild gegen das Pool-Bild tauschen", „Einleitung kürzer und persönlicher" oder „Zahlungsplan weiter nach oben". Der Link bleibt gleich.'),
  }])
  const scrollRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(1)
  const origin = window.location.origin

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs])

  const push = (m: Omit<Msg, 'id'>) => { const id = idRef.current++; setMsgs(p => [...p, { ...m, id }]); return id }
  const patch = (id: number, p: Partial<Msg>) => setMsgs(cur => cur.map(m => m.id === id ? { ...m, ...p } : m))

  // Wartet, bis der Hintergrund-Lauf fertig ist. Liefert Summary oder Fehler.
  const pollDone = async (): Promise<{ summary?: string; error?: string }> => {
    for (let i = 0; i < 90; i++) {   // ~90 × 2s = 3 Min Sicherheitslimit
      await sleep(2000)
      const { data } = await supabase.from('sales_decks')
        .select('refining, refine_error, refine_summary').eq('token', token).maybeSingle()
      const d = data as { refining: boolean; refine_error: string | null; refine_summary: string | null } | null
      if (!d) continue
      if (d.refine_error) return { error: d.refine_error }
      if (!d.refining) return { summary: d.refine_summary ?? undefined }
    }
    return { error: t('deckChat.timeout', 'Zeitüberschreitung — bitte im Deck nachsehen.') }
  }

  const send = async () => {
    const text = input.trim()
    if (busy || !text) return
    setInput(''); setBusy(true)
    push({ role: 'user', text })
    const thinkingId = push({ role: 'assistant', text: '', state: 'thinking' })
    try {
      const { error } = await supabase.functions.invoke('refine-deck', {
        body: { token, instruction: text, learn, background: true },
      })
      if (error) throw new Error(error.message)
      const res = await pollDone()
      if (res.error) {
        patch(thinkingId, { state: 'error', text: t('deckChat.failed', 'Das hat nicht geklappt: {{e}}', { e: res.error }) })
      } else {
        patch(thinkingId, { state: 'done', text: res.summary || t('deckChat.doneGeneric', 'Erledigt ✓ Ich habe das Deck angepasst.') })
        onStarted?.(token)
      }
    } catch (e) {
      patch(thinkingId, { state: 'error', text: e instanceof Error ? e.message : t('deckChat.error', 'Fehler') })
    } finally { setBusy(false) }
  }

  const undo = async () => {
    if (busy) return
    setBusy(true)
    const thinkingId = push({ role: 'assistant', text: '', state: 'thinking' })
    try {
      const { data, error } = await supabase.functions.invoke('refine-deck', { body: { token, action: 'undo' } })
      if (error) throw new Error(error.message)
      const d = data as { error?: string } | null
      if (d?.error) throw new Error(d.error)
      patch(thinkingId, { state: 'done', text: t('deckChat.undoSuccess', '↶ Letzte Änderung rückgängig gemacht.') })
      onStarted?.(token)
    } catch (e) {
      patch(thinkingId, { state: 'error', text: e instanceof Error ? e.message : t('deckChat.error', 'Fehler') })
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col" style={{ height: 'min(80vh, 640px)' }} onClick={e => e.stopPropagation()}>
        {/* Kopf */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">✏️ {t('deckChat.title', 'Deck anpassen')}{label ? ` · ${label}` : ''}</h3>
            <a href={`${origin}/deck/${token}`} target="_blank" rel="noreferrer" className="text-xs text-gray-400 hover:text-gray-600 underline">{t('deckChat.openDeck', 'Deck in neuem Tab öffnen')}</a>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none shrink-0">✕</button>
        </div>

        {/* Verlauf */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/60">
          {msgs.map(m => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === 'user' ? 'text-white rounded-br-sm' : m.state === 'error' ? 'bg-red-50 text-red-700 rounded-bl-sm' : 'bg-white text-gray-800 border border-gray-100 rounded-bl-sm'
              }`} style={m.role === 'user' ? { backgroundColor: '#ff795d' } : undefined}>
                {m.state === 'thinking'
                  ? <span className="inline-flex gap-1 py-1" aria-label={t('deckChat.thinking', 'denkt nach')}>
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </span>
                  : m.text}
              </div>
            </div>
          ))}
        </div>

        {/* Eingabe */}
        <div className="border-t border-gray-100 p-3 shrink-0 space-y-2">
          <div className="flex items-end gap-2">
            <textarea rows={1} value={input} onChange={e => setInput(e.target.value)} disabled={busy}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              placeholder={t('deckChat.inputPlaceholder', 'Nachricht schreiben … (Enter zum Senden)')}
              className="flex-1 resize-none border border-gray-200 rounded-xl px-3 py-2 text-sm max-h-32 focus:outline-none focus:ring-2 focus:ring-orange-300" />
            <button onClick={() => void send()} disabled={busy || !input.trim()}
              className="px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-40 shrink-0" style={{ backgroundColor: '#ff795d' }}>
              {busy ? '…' : t('deckChat.send', 'Senden')}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
              <input type="checkbox" checked={learn} onChange={e => setLearn(e.target.checked)} className="accent-orange-500 w-3.5 h-3.5" />
              {t('deckChat.rememberForAll', 'Für alle künftigen Decks dieses Projekts merken')}
            </label>
            <button onClick={() => void undo()} disabled={busy} className="text-[11px] text-gray-500 hover:text-gray-800 disabled:opacity-40">↶ {t('deckChat.undo', 'Letzte Änderung rückgängig')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
