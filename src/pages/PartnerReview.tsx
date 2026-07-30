import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Partner-Rückmeldung (/partner/:token) ────────────────────────────────────
// Öffentliche, token-geschützte Seite für Partner (Christof, Burkhard, Ioulia):
// zeigt alle Leads „ihrer" Pipeline-Phase; je Lead drei Status-Buttons
// (In Bearbeitung / Nicht qualifiziert / Noch nicht erreicht → Datumsfeld) plus
// Bemerkung. Speichern schreibt sofort ins CRM (Edge partner-review) und wird
// dem Kunden zugeordnet. Lotte verlinkt diese Seite in der Wochen-Erinnerung.

const CREAM = '#FAF6EC'
const CORAL = '#ff795d'
const NAVY = '#1a2332'

interface PLead {
  lead_id: string
  name: string
  email: string | null
  phone: string | null
  review: { status: string | null; next_contact_at: string | null; note: string | null } | null
}

const STATUS_OPTS = [
  { key: 'in_bearbeitung', label: 'In Bearbeitung', cls: 'bg-green-100 text-green-800 border-green-300', active: 'bg-green-600 text-white border-green-600' },
  { key: 'nicht_qualifiziert', label: 'Nicht qualifiziert', cls: 'bg-red-50 text-red-700 border-red-200', active: 'bg-red-600 text-white border-red-600' },
  { key: 'nicht_erreicht', label: 'Noch nicht erreicht', cls: 'bg-amber-50 text-amber-700 border-amber-200', active: 'bg-amber-500 text-white border-amber-500' },
]

function LeadCard({ lead, token, onSaved }: { lead: PLead; token: string; onSaved: (leadId: string, review: PLead['review']) => void }) {
  const [status, setStatus] = useState<string>(lead.review?.status ?? '')
  const [nextAt, setNextAt] = useState<string>(lead.review?.next_contact_at ? lead.review.next_contact_at.slice(0, 10) : '')
  const [note, setNote] = useState<string>(lead.review?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  const dirty = status !== (lead.review?.status ?? '')
    || nextAt !== (lead.review?.next_contact_at ? lead.review.next_contact_at.slice(0, 10) : '')
    || note !== (lead.review?.note ?? '')

  const save = async () => {
    if (!status) { setErr('Bitte einen Status wählen.'); return }
    setBusy(true); setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('partner-review', {
        body: { action: 'save', token, lead_id: lead.lead_id, status, next_contact_at: status === 'nicht_erreicht' && nextAt ? nextAt : undefined, note: note || undefined },
      })
      const d = (data ?? {}) as { ok?: boolean; error?: string }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      onSaved(lead.lead_id, { status, next_contact_at: status === 'nicht_erreicht' && nextAt ? `${nextAt}T00:00:00Z` : null, note: note || null })
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      console.error('[PartnerReview] save:', e)
      setErr('Speichern fehlgeschlagen — bitte nochmal versuchen.')
    } finally { setBusy(false) }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold text-gray-900">{lead.name}</p>
          <p className="text-sm text-gray-500 mt-0.5">
            {lead.email && <a href={`mailto:${lead.email}`} className="hover:underline">{lead.email}</a>}
            {lead.email && lead.phone && ' · '}
            {lead.phone && <a href={`tel:${lead.phone}`} className="hover:underline">{lead.phone}</a>}
          </p>
        </div>
        {lead.review?.status && !dirty && (
          <span className="text-[11px] px-2 py-1 rounded-full bg-gray-100 text-gray-500">zuletzt gemeldet ✓</span>
        )}
      </div>

      <div className="flex gap-2 mt-4 flex-wrap">
        {STATUS_OPTS.map(o => (
          <button key={o.key} onClick={() => setStatus(o.key)}
            className={`px-3.5 py-2 rounded-xl text-sm font-medium border transition-colors ${status === o.key ? o.active : `${o.cls} hover:opacity-80`}`}>
            {o.label}
          </button>
        ))}
      </div>

      {status === 'nicht_erreicht' && (
        <div className="mt-3">
          <label className="block text-xs font-medium text-gray-500 mb-1">Wann erfolgt die nächste Kontaktaufnahme?</label>
          <input type="date" value={nextAt} onChange={e => setNextAt(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
            className="rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400" />
        </div>
      )}

      <div className="mt-3">
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Bemerkungen (optional)"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400" />
      </div>

      {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
      <div className="flex items-center gap-3 mt-3">
        <button onClick={() => void save()} disabled={busy || !status || (!dirty && !saved)}
          className="px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-40" style={{ backgroundColor: CORAL }}>
          {busy ? 'Speichert…' : 'Speichern'}
        </button>
        {saved && <span className="text-sm text-green-600 font-medium">Gespeichert ✓</span>}
      </div>
    </div>
  )
}

export default function PartnerReview() {
  const { token = '' } = useParams<{ token: string }>()
  const [state, setState] = useState<'busy' | 'ok' | 'invalid'>('busy')
  const [label, setLabel] = useState('')
  const [partner, setPartner] = useState('')
  const [leads, setLeads] = useState<PLead[]>([])

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('partner-review', { body: { action: 'list', token } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; label?: string; partner?: string; leads?: PLead[] }
      if (error || d.error || !d.ok) { setState('invalid'); return }
      setLabel(d.label ?? ''); setPartner(d.partner ?? ''); setLeads(d.leads ?? [])
      setState('ok')
    } catch { setState('invalid') }
  }, [token])
  useEffect(() => { void load() }, [load])

  const onSaved = (leadId: string, review: PLead['review']) =>
    setLeads(ls => ls.map(l => l.lead_id === leadId ? { ...l, review } : l))

  const done = leads.filter(l => l.review?.status).length

  return (
    <div className="min-h-screen py-8 px-4" style={{ background: CREAM }}>
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-6">
          <img src={DECK_LOGO} alt="Happy Property" className="h-12 w-12 rounded-xl object-cover mx-auto mb-3" />
          {state === 'ok' && (
            <>
              <h1 className="text-2xl font-bold" style={{ color: NAVY }}>Hallo {partner.split(' ')[0]} 👋</h1>
              <p className="text-sm text-gray-600 mt-1.5 max-w-md mx-auto">
                Hier ist Lotte — kurze Rückfrage zum Bearbeitungsstand deiner Kontakte
                {label ? <> in <b>„{label}"</b></> : null}. Ein Klick je Kontakt genügt, alles landet direkt in unserem System. Danke dir! 🐾
              </p>
              {leads.length > 0 && (
                <p className="text-xs text-gray-400 mt-2">{done}/{leads.length} zurückgemeldet</p>
              )}
            </>
          )}
        </div>

        {state === 'busy' && (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        )}
        {state === 'invalid' && (
          <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
            <div className="text-4xl mb-3">🤔</div>
            <p className="text-gray-700 font-medium">Dieser Link ist ungültig.</p>
            <p className="text-sm text-gray-500 mt-2">Bitte melde dich kurz bei Sven — dann bekommst du einen neuen.</p>
          </div>
        )}
        {state === 'ok' && (
          leads.length === 0 ? (
            <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
              <div className="text-4xl mb-3">🎉</div>
              <p className="text-gray-700">Aktuell liegen keine Kontakte für dich auf der Liste.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {leads.map(l => <LeadCard key={l.lead_id} lead={l} token={token} onSaved={onSaved} />)}
            </div>
          )
        )}
        <p className="text-center text-xs mt-8" style={{ color: '#b8b09a' }}>Happy Property Cyprus · Lotte 🐾</p>
      </div>
    </div>
  )
}
