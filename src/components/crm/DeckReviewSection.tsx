import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── Prüfteam eines Decks (Edge Function deck-review) ─────────────────────────
// Endscore 0-100 aus fünf Prüfern (Vollständigkeit, Bilder, Fakten, Regeln,
// Kundensicht) und einem Chef, der Fehlalarme verwirft und die wichtigsten
// Korrekturen nennt. Versandbereit ab 85. Die Prüfung ändert das Deck nicht.

export interface ReviewBefund { pruefer: string; key: string; severity: 'kritisch' | 'hoch' | 'mittel' | 'niedrig'; what: string; where?: string; evidence?: string; fix?: string }
export interface DeckReview {
  version?: number
  score?: number
  verdict?: 'versandbereit' | 'nacharbeit' | 'nicht_senden'
  schwelle?: number
  urteil?: string | null
  scores?: Record<string, number | null>
  top?: Array<{ text: string; chat?: string }>
  todo?: string[]
  checks?: Array<{ label: string; ok: boolean }>
  befunde?: ReviewBefund[]
  ausgefallen?: string[]
  fehler?: string
  reviewed_at?: string
}

const KATEGORIEN = ['vollstaendigkeit', 'bilder', 'fakten', 'regeln', 'kunde'] as const

const SEV_STYLE: Record<string, string> = {
  kritisch: 'bg-red-100 text-red-700 border-red-200',
  hoch:     'bg-orange-100 text-orange-700 border-orange-200',
  mittel:   'bg-amber-50 text-amber-700 border-amber-200',
  niedrig:  'bg-gray-100 text-gray-600 border-gray-200',
}

/** Farbe des Score-Badges: grün ab Schwelle, gelb ab 70, sonst rot. */
export function scoreFarbe(score: number | null | undefined, schwelle = 85): string {
  if (score == null) return 'bg-gray-100 text-gray-500'
  if (score >= schwelle) return 'bg-green-100 text-green-700'
  if (score >= 70) return 'bg-amber-100 text-amber-800'
  return 'bg-red-600 text-white'
}

export default function DeckReviewSection({ token, onFixInChat }: {
  token: string
  onFixInChat?: (instruction: string) => void
}) {
  const { t } = useTranslation()
  const [review, setReview] = useState<DeckReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [laeuft, setLaeuft] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [alleZeigen, setAlleZeigen] = useState(false)

  const laden = async (): Promise<DeckReview | null> => {
    const { data } = await supabase.from('sales_decks').select('review').eq('token', token).maybeSingle()
    const r = (data as { review: DeckReview | null } | null)?.review ?? null
    setReview(r)
    return r
  }

  useEffect(() => {
    let cancelled = false
    void laden().then(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // Prüfung läuft im Hintergrund (ca. 1-2 Minuten), danach reviewed_at abfragen.
  const neuPruefen = async () => {
    setLaeuft(true); setFehler(null)
    const vorher = review?.reviewed_at ?? null
    const { error } = await supabase.functions.invoke('deck-review', { body: { token } })
    if (error) { setFehler(error.message); setLaeuft(false); return }
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 5000))
      const r = await laden()
      if (r?.reviewed_at && r.reviewed_at !== vorher) { setLaeuft(false); return }
    }
    setLaeuft(false)
    setFehler(t('deckReview.timeout', 'Die Prüfung dauert ungewöhnlich lange. Schau in ein paar Minuten noch einmal rein.'))
  }

  const katLabel = (k: string) => ({
    vollstaendigkeit: t('deckReview.cat.vollstaendigkeit', 'Vollständigkeit'),
    bilder: t('deckReview.cat.bilder', 'Bilder'),
    fakten: t('deckReview.cat.fakten', 'Fakten'),
    regeln: t('deckReview.cat.regeln', 'Regeln'),
    kunde: t('deckReview.cat.kunde', 'Kundensicht'),
    gate: t('deckReview.cat.gate', 'Quality-Gate'),
  } as Record<string, string>)[k] ?? k
  const verdictLabel = (v?: string) => v === 'versandbereit'
    ? t('deckReview.verdict.ok', 'Versandbereit')
    : v === 'nicht_senden' ? t('deckReview.verdict.stop', 'Nicht senden') : t('deckReview.verdict.work', 'Nacharbeit')

  const befunde = review?.befunde ?? []
  const wichtig = befunde.filter(b => b.severity === 'kritisch' || b.severity === 'hoch')
  const sichtbar = alleZeigen ? befunde : wichtig
  const offeneChecks = (review?.checks ?? []).filter(c => !c.ok)
  const chatTexte = (review?.top ?? []).map(x => x.chat?.trim()).filter((x): x is string => !!x)

  return (
    <section className="border border-gray-200 rounded-lg px-3 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">🧑‍⚖️ {t('deckReview.title', 'Prüfteam')}</h4>
        {review?.score != null && (
          <span className={`text-sm font-bold px-2 py-0.5 rounded-full ${scoreFarbe(review.score, review.schwelle)}`}>
            {review.score}/100 · {verdictLabel(review.verdict)}
          </span>
        )}
        <button onClick={() => void neuPruefen()} disabled={laeuft}
          className="ml-auto text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          {laeuft ? t('deckReview.running', 'Prüft… (1-2 Min.)') : review ? t('deckReview.recheck', 'Neu prüfen') : t('deckReview.check', 'Jetzt prüfen')}
        </button>
      </div>
      {review?.reviewed_at && <p className="text-[11px] text-gray-400 mt-0.5">{new Date(review.reviewed_at).toLocaleString('de-DE')}</p>}
      {fehler && <p className="text-xs text-red-600 mt-1">{fehler}</p>}
      {loading && <p className="text-sm text-gray-400 mt-2">{t('deckQuality.loading', 'Lade Bericht…')}</p>}
      {!loading && !review && !laeuft && (
        <p className="text-sm text-gray-500 mt-2">{t('deckReview.none', 'Noch nicht vom Prüfteam geprüft. Neue Decks mit Kunde prüft es automatisch innerhalb von 10 Minuten.')}</p>
      )}
      {review?.fehler && <p className="text-xs text-red-600 mt-2">{t('deckReview.failed', 'Prüfung fehlgeschlagen: {{e}}', { e: review.fehler })}</p>}

      {review?.score != null && (
        <div className="mt-3 space-y-3">
          {review.urteil && <p className="text-sm text-gray-700">{review.urteil}</p>}

          <div className="grid grid-cols-5 gap-2">
            {KATEGORIEN.map(k => {
              const s = review.scores?.[k]
              return (
                <div key={k} className="text-center">
                  <p className="text-[10px] text-gray-500 truncate">{katLabel(k)}</p>
                  <p className={`text-sm font-semibold rounded mt-0.5 ${scoreFarbe(s, review.schwelle)}`}>{s ?? '-'}</p>
                </div>
              )
            })}
          </div>
          {!!review.ausgefallen?.length && (
            <p className="text-[11px] text-amber-700">{t('deckReview.partial', 'Ausgefallen: {{list}}. Endscore höchstens 84.', { list: review.ausgefallen.map(katLabel).join(', ') })}</p>
          )}

          {!!review.todo?.length && (
            <div className="bg-amber-50 border border-amber-100 rounded px-2 py-2">
              <p className="text-[11px] font-semibold text-amber-800">{t('deckReview.todo', 'Das musst du selbst erledigen')}</p>
              <ul className="text-[12px] text-amber-900 list-disc pl-4 mt-1">{review.todo.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}

          {!!review.top?.length && (
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold text-gray-600">{t('deckReview.top', 'Wichtigste Korrekturen')}</p>
                {onFixInChat && chatTexte.length > 0 && (
                  <button onClick={() => onFixInChat(chatTexte.map((x, i) => `${i + 1}. ${x}`).join('\n'))}
                    title={t('deckQuality.fixInChatTitle', 'Öffnet den Deck-Chat mit einer vorbereiteten Anweisung. Gesendet wird erst, wenn du auf Senden klickst.')}
                    className="text-[11px] font-medium px-2 py-0.5 rounded text-white bg-hp-highlight hover:opacity-90">
                    ✏️ {t('deckReview.fixInChat', 'Im Deck-Chat beheben ({{n}})', { n: chatTexte.length })}
                  </button>
                )}
              </div>
              <ol className="text-[12px] text-gray-700 list-decimal pl-4 mt-1 space-y-0.5">{review.top.map((x, i) => <li key={i}>{x.text}</li>)}</ol>
            </div>
          )}

          {offeneChecks.length > 0 && (
            <p className="text-[11px] text-gray-500">{t('deckReview.missing', 'Fehlt')}: {offeneChecks.map(c => c.label).join(' · ')}</p>
          )}

          {befunde.length > 0 && (
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold text-gray-600">{t('deckReview.findings', 'Befunde')} ({sichtbar.length}/{befunde.length})</p>
                {befunde.length > wichtig.length && (
                  <button onClick={() => setAlleZeigen(v => !v)} className="text-[11px] text-gray-500 underline">
                    {alleZeigen ? t('deckReview.onlyImportant', 'nur wichtige') : t('deckReview.showAll', 'alle zeigen')}
                  </button>
                )}
              </div>
              <ul className="space-y-1.5 mt-1">
                {sichtbar.map((b, i) => (
                  <li key={i} className="text-[12px] bg-white border border-gray-100 rounded px-2 py-1.5">
                    <p className="flex items-center gap-1.5 flex-wrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${SEV_STYLE[b.severity] ?? SEV_STYLE.niedrig}`}>{b.severity}</span>
                      <span className="text-[10px] text-gray-400">{katLabel(b.pruefer)}{b.where ? ` · ${b.where}` : ''}</span>
                    </p>
                    <p className="text-gray-700 mt-0.5 break-words">{b.what}</p>
                    {b.evidence && <p className="text-gray-400 mt-0.5 break-words italic">„{b.evidence}"</p>}
                    {b.fix && <p className="text-gray-600 mt-0.5 break-words">→ {b.fix}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
