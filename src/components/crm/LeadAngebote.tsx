import { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import DeckChat from './DeckChat'

// ── Gesendete Angebote ───────────────────────────────────────────────────────
// Dauerhafte Historie pro Kunde: welche Decks, Berechnungen/Vergleiche und
// Begleit-Mails wurden ihm geschickt (Links laufen NICHT ab). So sieht Sven auch
// in einem Jahr noch, was er dem Kunden gesendet hat.
//
// Review-Workflow: Decks per Chat anpassen (läuft im Hintergrund) → Button-Farbe
// wechselt nach jeder fertigen Bearbeitung (revision) → Deck/Berechnung als
// „fertig" bestätigen (approved_at). Während eine Bearbeitung läuft: Spinner.

interface OutboxRow { id: string; subject: string | null; status: string; created_at: string | null; deck_tokens: string[] | null; email_sent_at: string | null; whatsapp_sent_at: string | null }
interface CalcRow { id: string; token: string; title: string | null; created_at: string | null; approved_at: string | null }
interface DeckMeta { revision: number; refining: boolean; refine_error: string | null; approved_at: string | null }

// Basisfarbe (unbearbeitet) + Zyklus: nach jeder fertigen Bearbeitung die nächste
// Farbe → Sven sieht auf einen Blick, dass eine neue Version fertig ist.
const DECK_BASE = '#111827'
const DECK_CYCLE = ['#7c3aed', '#0ea5e9', '#e11d48', '#d97706', '#0d9488', '#9333ea']
const deckColor = (rev: number, approved: boolean) =>
  approved ? '#16a34a' : rev <= 0 ? DECK_BASE : DECK_CYCLE[(rev - 1) % DECK_CYCLE.length]

export default function LeadAngebote({ leadId }: { leadId: string }) {
  const { t } = useTranslation()
  const [outbox, setOutbox] = useState<OutboxRow[]>([])
  const [calcs, setCalcs]   = useState<CalcRow[]>([])
  const [deckMeta, setDeckMeta] = useState<Record<string, DeckMeta>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]     = useState<string | null>(null)
  const [chat, setChat]     = useState<{ token: string; label: string } | null>(null)

  const allTokens = useMemo(() => Array.from(new Set(outbox.flatMap(o => o.deck_tokens ?? []))), [outbox])

  const fetchDeckMeta = useCallback(async (tokens: string[]) => {
    if (!tokens.length) return
    const { data } = await supabase.from('sales_decks')
      .select('token, revision, refining, refine_error, approved_at').in('token', tokens)
    setDeckMeta(prev => {
      const next = { ...prev }
      for (const r of (data ?? []) as Array<{ token: string } & DeckMeta>) {
        next[r.token] = { revision: r.revision ?? 0, refining: !!r.refining, refine_error: r.refine_error ?? null, approved_at: r.approved_at ?? null }
      }
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const safety = setTimeout(() => { if (!cancelled) setLoading(false) }, 10_000)
    void (async () => {
      const [o, k] = await Promise.all([
        supabase.from('deck_outbox').select('id, subject, status, created_at, deck_tokens, email_sent_at, whatsapp_sent_at').eq('lead_id', leadId).order('created_at', { ascending: false }),
        supabase.from('property_calculations').select('id, token, title, created_at, approved_at').eq('lead_id', leadId).order('created_at', { ascending: false }),
      ])
      if (cancelled) return
      setOutbox((o.data ?? []) as OutboxRow[])
      setCalcs((k.data ?? []) as CalcRow[])
      setLoading(false)
    })()
    return () => { cancelled = true; clearTimeout(safety) }
  }, [leadId])

  // Deck-Status laden, sobald die Tokens bekannt sind.
  useEffect(() => { if (allTokens.length) void fetchDeckMeta(allTokens) }, [allTokens, fetchDeckMeta])

  // Solange irgendein Deck im Hintergrund bearbeitet wird: alle 4s nachfragen,
  // bis refining=false (dann ist die neue revision/Farbe da).
  const anyRefining = Object.values(deckMeta).some(m => m?.refining)
  useEffect(() => {
    if (!anyRefining) return
    const id = setInterval(() => { void fetchDeckMeta(allTokens) }, 4000)
    return () => clearInterval(id)
  }, [anyRefining, allTokens, fetchDeckMeta])

  // Vom Deck-Chat: Hintergrund-Bearbeitung gestartet → sofort als „läuft" markieren.
  const onRefineStarted = (token: string) => {
    setDeckMeta(prev => ({ ...prev, [token]: { revision: prev[token]?.revision ?? 0, refine_error: null, approved_at: prev[token]?.approved_at ?? null, refining: true } }))
  }

  const toggleDeckApprove = async (token: string) => {
    const cur = deckMeta[token]?.approved_at
    const val = cur ? null : new Date().toISOString()
    setDeckMeta(prev => ({ ...prev, [token]: { revision: prev[token]?.revision ?? 0, refining: prev[token]?.refining ?? false, refine_error: prev[token]?.refine_error ?? null, approved_at: val } }))
    await supabase.from('sales_decks').update({ approved_at: val }).eq('token', token)
  }
  const toggleCalcApprove = async (c: CalcRow) => {
    const val = c.approved_at ? null : new Date().toISOString()
    setCalcs(prev => prev.map(x => x.id === c.id ? { ...x, approved_at: val } : x))
    await supabase.from('property_calculations').update({ approved_at: val }).eq('id', c.id)
  }

  // Angebot löschen: Begleit-Bündel inkl. der zugehörigen Decks (Links sterben mit).
  const delOutbox = async (o: OutboxRow) => {
    if (!window.confirm(t('leadAngebote.confirmDeleteOutbox', 'Dieses Angebot inkl. der enthaltenen Deck-Links löschen? Die Links sind danach nicht mehr erreichbar.'))) return
    setBusy(o.id)
    const tokens = o.deck_tokens ?? []
    if (tokens.length) await supabase.from('sales_decks').delete().in('token', tokens)
    await supabase.from('deck_outbox').delete().eq('id', o.id)
    setOutbox(prev => prev.filter(x => x.id !== o.id))
    setBusy(null)
  }
  const delCalc = async (c: CalcRow) => {
    if (!window.confirm(t('leadAngebote.confirmDeleteCalc', 'Diese Berechnung löschen? Der Link ist danach nicht mehr erreichbar.'))) return
    setBusy(c.id)
    await supabase.from('property_calculations').delete().eq('id', c.id)
    setCalcs(prev => prev.filter(x => x.id !== c.id))
    setBusy(null)
  }

  const origin = window.location.origin
  const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

  if (loading) return null
  if (!outbox.length && !calcs.length) return null

  return (
    <div className="bg-white rounded-2xl shadow p-5">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">📦 {t('leadAngebote.sentOffers', 'Gesendete Angebote')}</h3>
      <div className="space-y-2">
        {outbox.map(o => (
          <div key={o.id} className="flex items-start gap-2 text-sm border border-gray-100 rounded-lg px-3 py-2">
            <span className="text-xs text-gray-400 w-24 shrink-0 mt-1">{fmt(o.created_at)}</span>
            <span className="flex-1 min-w-0 truncate mt-1">📑 {o.subject ?? t('leadAngebote.offerFallback', 'Angebot')}</span>
            <span className="flex flex-wrap gap-1 justify-end shrink-0 max-w-[55%]">
              {(o.deck_tokens ?? []).map((tok, i) => {
                const m = deckMeta[tok]
                const approved = !!m?.approved_at
                const rev = m?.revision ?? 0
                const refining = !!m?.refining
                const err = m?.refine_error
                return (
                  <span key={tok} className="inline-flex items-center rounded overflow-hidden ring-1 ring-black/5">
                    <a href={`${origin}/deck/${tok}?preview=1`} target="_blank" rel="noreferrer"
                      title={approved ? t('leadAngebote.deckApprovedTitle', 'Als fertig bestätigt') : rev > 0 ? t('leadAngebote.deckVersionTitle', 'Version {{rev}}', { rev }) : t('leadAngebote.deckOpenTitle', 'Deck öffnen')}
                      className="text-[11px] px-2 py-0.5 text-white font-medium" style={{ backgroundColor: deckColor(rev, approved) }}>
                      {approved ? '✓ ' : ''}{t('leadAngebote.deckLabel', 'Deck {{num}}', { num: i + 1 })}{rev > 0 && !approved ? ` ·v${rev}` : ''}
                    </a>
                    {refining ? (
                      <span className="px-1.5 py-0.5 bg-gray-200 flex items-center" title={t('leadAngebote.refiningTitle', 'Wird im Hintergrund bearbeitet…')}>
                        <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                      </span>
                    ) : (
                      <button onClick={() => setChat({ token: tok, label: `Deck ${i + 1}` })} title={t('leadAngebote.editViaChatTitle', 'Deck per Chat anpassen (läuft im Hintergrund)')}
                        className="text-[11px] px-1.5 py-0.5 bg-gray-700 text-white hover:bg-orange-500">✏️</button>
                    )}
                    {err && !refining && (
                      <span className="px-1 py-0.5 bg-red-100 text-red-600 text-[11px]" title={t('leadAngebote.refineFailedTitle', 'Bearbeitung fehlgeschlagen: {{err}}', { err })}>⚠</span>
                    )}
                    <button onClick={() => void toggleDeckApprove(tok)} title={approved ? t('leadAngebote.unapproveTitle', 'Bestätigung aufheben') : t('leadAngebote.approveTitle', 'Als fertig bestätigen')}
                      className={`text-[11px] px-1.5 py-0.5 ${approved ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700'}`}>✓</button>
                  </span>
                )
              })}
            </span>
            <span className="text-[11px] text-green-600 shrink-0 w-16 text-right mt-1">
              {o.email_sent_at ? t('leadAngebote.statusMail', '✅ Mail') : o.whatsapp_sent_at ? t('leadAngebote.statusWa', '✅ WA') : t('leadAngebote.statusDraft', '⏳ Entwurf')}
            </span>
            <button onClick={() => void delOutbox(o)} disabled={busy === o.id} title={t('leadAngebote.deleteOfferTitle', 'Angebot löschen')}
              className="text-gray-300 hover:text-red-500 disabled:opacity-40 shrink-0 px-1 mt-1">🗑</button>
          </div>
        ))}
        {calcs.map(c => {
          const approved = !!c.approved_at
          return (
            <div key={c.id} className="flex items-center gap-2 text-sm border border-gray-100 rounded-lg px-3 py-2">
              <span className="text-xs text-gray-400 w-24 shrink-0">{fmt(c.created_at)}</span>
              <span className="flex-1 truncate">📊 {c.title ?? t('leadAngebote.calcFallback', 'Rendite-Berechnung')}{approved && <span className="ml-1 text-[11px] text-green-600 font-medium">· {t('leadAngebote.calcDoneBadge', '✓ fertig')}</span>}</span>
              <a href={`${origin}/rechnung/${c.token}?preview=1`} target="_blank" rel="noreferrer" className="text-[11px] px-2 py-0.5 rounded text-white shrink-0" style={{ backgroundColor: approved ? '#16a34a' : '#2f6b4f' }}>{t('leadAngebote.viewLink', 'Ansehen')}</a>
              <button onClick={() => void toggleCalcApprove(c)} title={approved ? t('leadAngebote.unapproveTitle', 'Bestätigung aufheben') : t('leadAngebote.approveTitle', 'Als fertig bestätigen')}
                className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${approved ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700'}`}>✓</button>
              <button onClick={() => void delCalc(c)} disabled={busy === c.id} title={t('leadAngebote.deleteCalcTitle', 'Berechnung löschen')}
                className="text-gray-300 hover:text-red-500 disabled:opacity-40 shrink-0 px-1">🗑</button>
            </div>
          )
        })}
      </div>
      <p className="text-[11px] text-gray-400 mt-2">{t('leadAngebote.footerHint', 'Links bleiben dauerhaft gültig. ✏️ = Deck per Chat anpassen (läuft im Hintergrund, Farbe wechselt bei fertig). ✓ = als fertig bestätigen.')}</p>
      {chat && <DeckChat token={chat.token} label={chat.label} onClose={() => setChat(null)} onStarted={onRefineStarted} />}
    </div>
  )
}
