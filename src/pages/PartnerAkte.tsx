import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Partner-Akte (öffentlich, token-geschützt) ──────────────────────────────
// Kompletter Kundenverlauf für einen Partner (z.B. Burkhard): Stammdaten,
// alle Aktivitäten (Mails/WhatsApps/Notizen), Berechnungen, Decks, Termine.
// Bewusst nur Deutsch - Zielgruppe sind deutschsprachige Partner.

interface AkteLead { name: string; email: string | null; phone: string | null; country: string | null; source: string | null; status: string | null }
interface AkteActivity { type: string | null; direction: string | null; subject: string | null; content: string; at: string; auto: boolean }
interface AkteCalc { title: string; url: string; created_at: string }
interface AkteDeck { url: string; status: string | null; created_at: string }
interface AkteAppt { title: string | null; type: string | null; start_time: string; end_time: string | null; outcome: string | null }
interface AkteDeal { phase: string | null; project: string | null; created_at: string }
interface Akte { partner: string; lead: AkteLead; deals: AkteDeal[]; activities: AkteActivity[]; calculations: AkteCalc[]; decks: AkteDeck[]; appointments: AkteAppt[] }

const fmt = (iso: string) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Asia/Nicosia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr'

const ACT_ICON: Record<string, string> = { email: '✉️', mail: '✉️', whatsapp: '💬', call: '📞', phone: '📞', note: '📝', status: '🔁' }

export default function PartnerAkte() {
  const { token } = useParams<{ token: string }>()
  const [akte, setAkte] = useState<Akte | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('partner-akte', { body: { action: 'view', token } })
      if (error) throw error
      const d = data as (Akte & { ok?: boolean; error?: string }) | null
      if (!d?.ok) throw new Error(d?.error || 'Akte nicht gefunden.')
      setAkte(d)
    } catch (e) {
      console.error('[PartnerAkte] load:', e)
      setErr(e instanceof Error ? e.message : 'Akte konnte nicht geladen werden.')
    } finally { setLoading(false) }
  }, [token])
  useEffect(() => { void load() }, [load])

  if (loading) {
    return <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="w-10 h-10 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" />
    </div>
  }
  if (err || !akte) {
    return <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm p-8 text-center max-w-md">
        <p className="text-3xl mb-3">🔒</p>
        <p className="text-gray-700 font-medium">{err || 'Akte nicht gefunden.'}</p>
        <p className="text-sm text-gray-400 mt-2">Falls der Link neu ist, frag bitte kurz bei Sven nach.</p>
      </div>
    </div>
  }

  const { lead } = akte

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <div className="max-w-2xl mx-auto px-4 pt-8 space-y-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-400 font-semibold">Happy Property · Partner-Akte</p>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">👤 {lead.name}</h1>
        </div>

        {/* Stammdaten */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <h2 className="text-sm font-semibold text-gray-500 mb-3">Stammdaten</h2>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {lead.phone && <p>📞 <a className="text-gray-800" href={`tel:${lead.phone}`}>{lead.phone}</a></p>}
            {lead.email && <p>✉️ <a className="text-gray-800 break-all" href={`mailto:${lead.email}`}>{lead.email}</a></p>}
            {lead.country && <p>📍 {lead.country}</p>}
            {lead.source && <p>🔗 Quelle: {lead.source}</p>}
            {akte.deals.map((d, i) => (
              <p key={i}>📌 {d.project ? `Projekt ${d.project}` : 'Deal'}{d.phase ? ` · Phase: ${d.phase}` : ''}</p>
            ))}
          </div>
        </div>

        {/* Berechnungen */}
        {akte.calculations.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <h2 className="text-sm font-semibold text-gray-500 mb-3">📊 Berechnungen ({akte.calculations.length})</h2>
            <div className="space-y-2">
              {akte.calculations.map((c, i) => (
                <a key={i} href={c.url} target="_blank" rel="noreferrer"
                  className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 hover:bg-gray-50 px-3.5 py-2.5">
                  <span className="text-sm text-gray-800 font-medium truncate">{c.title}</span>
                  <span className="text-xs text-gray-400 shrink-0">{fmt(c.created_at)} →</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Decks */}
        {akte.decks.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <h2 className="text-sm font-semibold text-gray-500 mb-3">📑 Angebots-Decks ({akte.decks.length})</h2>
            <div className="space-y-2">
              {akte.decks.map((d, i) => (
                <a key={i} href={d.url} target="_blank" rel="noreferrer"
                  className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 hover:bg-gray-50 px-3.5 py-2.5">
                  <span className="text-sm text-gray-800 font-medium">Angebots-Deck ansehen</span>
                  <span className="text-xs text-gray-400 shrink-0">{fmt(d.created_at)} →</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Termine */}
        {akte.appointments.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <h2 className="text-sm font-semibold text-gray-500 mb-3">📅 Termine ({akte.appointments.length})</h2>
            <div className="space-y-2">
              {akte.appointments.map((a, i) => (
                <div key={i} className="rounded-xl border border-gray-200 px-3.5 py-2.5">
                  <p className="text-sm text-gray-800 font-medium">{a.title || 'Termin'}{a.type ? ` · ${a.type}` : ''}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{fmt(a.start_time)}{a.outcome ? ` · Ergebnis: ${a.outcome}` : ''}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Verlauf */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <h2 className="text-sm font-semibold text-gray-500 mb-3">🕒 Kompletter Verlauf ({akte.activities.length})</h2>
          {akte.activities.length === 0 ? (
            <p className="text-sm text-gray-400">Noch keine Vorgänge.</p>
          ) : (
            <div className="space-y-1.5">
              {akte.activities.map((a, i) => {
                const icon = ACT_ICON[(a.type ?? '').toLowerCase()] ?? '📌'
                const dir = a.direction === 'inbound' ? '⬅️ vom Kunden' : a.direction === 'outbound' ? '➡️ an den Kunden' : ''
                const open = openIdx === i
                return (
                  <div key={i} className={`rounded-xl border px-3.5 py-2.5 ${a.direction === 'inbound' ? 'border-blue-100 bg-blue-50/40' : 'border-gray-200'}`}>
                    <button className="w-full text-left" onClick={() => setOpenIdx(open ? null : i)}>
                      <p className="text-sm text-gray-800">
                        {icon} <span className="font-medium">{a.subject || (a.type === 'whatsapp' ? 'WhatsApp' : a.type === 'email' ? 'E-Mail' : 'Vorgang')}</span>
                        {a.auto && <span className="ml-1.5 text-[10px] uppercase tracking-wide bg-gray-100 text-gray-500 rounded-full px-1.5 py-0.5">Automatik</span>}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{fmt(a.at)}{dir ? ` · ${dir}` : ''}</p>
                    </button>
                    {open && a.content && (
                      <p className="text-sm text-gray-600 whitespace-pre-wrap mt-2 pt-2 border-t border-gray-100">{a.content}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 pt-2">
          Diese Akte aktualisiert sich automatisch - einfach den Link erneut öffnen.<br />Happy Property · Paphos, Zypern
        </p>
      </div>
    </div>
  )
}
