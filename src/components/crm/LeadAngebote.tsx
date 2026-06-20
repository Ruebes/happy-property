import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

// ── Gesendete Angebote ───────────────────────────────────────────────────────
// Dauerhafte Historie pro Kunde: welche Decks, Berechnungen/Vergleiche und
// Begleit-Mails wurden ihm geschickt (Links laufen NICHT ab). So sieht Sven auch
// in einem Jahr noch, was er dem Kunden gesendet hat.

interface OutboxRow { id: string; subject: string | null; status: string; created_at: string | null; deck_tokens: string[] | null; email_sent_at: string | null; whatsapp_sent_at: string | null }
interface CalcRow { id: string; token: string; title: string | null; created_at: string | null }

export default function LeadAngebote({ leadId }: { leadId: string }) {
  const [outbox, setOutbox] = useState<OutboxRow[]>([])
  const [calcs, setCalcs]   = useState<CalcRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]     = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const safety = setTimeout(() => { if (!cancelled) setLoading(false) }, 10_000)
    void (async () => {
      const [o, k] = await Promise.all([
        supabase.from('deck_outbox').select('id, subject, status, created_at, deck_tokens, email_sent_at, whatsapp_sent_at').eq('lead_id', leadId).order('created_at', { ascending: false }),
        supabase.from('property_calculations').select('id, token, title, created_at').eq('lead_id', leadId).order('created_at', { ascending: false }),
      ])
      if (cancelled) return
      setOutbox((o.data ?? []) as OutboxRow[])
      setCalcs((k.data ?? []) as CalcRow[])
      setLoading(false)
    })()
    return () => { cancelled = true; clearTimeout(safety) }
  }, [leadId])

  // Angebot löschen: Begleit-Bündel inkl. der zugehörigen Decks (Links sterben mit),
  // damit Sven misslungene Decks wieder los wird. Rechnungen löschen ihren Token.
  const delOutbox = async (o: OutboxRow) => {
    if (!window.confirm('Dieses Angebot inkl. der enthaltenen Deck-Links löschen? Die Links sind danach nicht mehr erreichbar.')) return
    setBusy(o.id)
    const tokens = o.deck_tokens ?? []
    if (tokens.length) await supabase.from('sales_decks').delete().in('token', tokens)
    await supabase.from('deck_outbox').delete().eq('id', o.id)
    setOutbox(prev => prev.filter(x => x.id !== o.id))
    setBusy(null)
  }
  const delCalc = async (c: CalcRow) => {
    if (!window.confirm('Diese Berechnung löschen? Der Link ist danach nicht mehr erreichbar.')) return
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
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">📦 Gesendete Angebote</h3>
      <div className="space-y-2">
        {outbox.map(o => (
          <div key={o.id} className="flex items-center gap-2 text-sm border border-gray-100 rounded-lg px-3 py-2">
            <span className="text-xs text-gray-400 w-24 shrink-0">{fmt(o.created_at)}</span>
            <span className="flex-1 truncate">📑 {o.subject ?? 'Angebot'}</span>
            <span className="flex gap-1 shrink-0">
              {(o.deck_tokens ?? []).map((tok, i) => (
                <a key={tok} href={`${origin}/deck/${tok}`} target="_blank" rel="noreferrer" className="text-[11px] px-2 py-0.5 rounded bg-gray-900 text-white">Deck {i + 1}</a>
              ))}
            </span>
            <span className="text-[11px] text-green-600 shrink-0 w-20 text-right">
              {o.email_sent_at ? '✅ Mail' : o.whatsapp_sent_at ? '✅ WA' : '⏳ Entwurf'}
            </span>
            <button onClick={() => void delOutbox(o)} disabled={busy === o.id} title="Angebot löschen"
              className="text-gray-300 hover:text-red-500 disabled:opacity-40 shrink-0 px-1">🗑</button>
          </div>
        ))}
        {calcs.map(c => (
          <div key={c.id} className="flex items-center gap-2 text-sm border border-gray-100 rounded-lg px-3 py-2">
            <span className="text-xs text-gray-400 w-24 shrink-0">{fmt(c.created_at)}</span>
            <span className="flex-1 truncate">📊 {c.title ?? 'Rendite-Berechnung'}</span>
            <a href={`${origin}/rechnung/${c.token}`} target="_blank" rel="noreferrer" className="text-[11px] px-2 py-0.5 rounded text-white shrink-0" style={{ backgroundColor: '#2f6b4f' }}>Ansehen</a>
            <button onClick={() => void delCalc(c)} disabled={busy === c.id} title="Berechnung löschen"
              className="text-gray-300 hover:text-red-500 disabled:opacity-40 shrink-0 px-1">🗑</button>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-400 mt-2">Diese Links bleiben dauerhaft gültig — du siehst hier jederzeit, was du dem Kunden geschickt hast.</p>
    </div>
  )
}
