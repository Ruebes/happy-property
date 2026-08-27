import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'

// ── Bewertungen ───────────────────────────────────────────────────────────────
// Fragebogen-Links per Lotte-WhatsApp an Investoren schicken, eingegangene
// Antworten lesen und einzelne Bewertungen fuer das Website-Widget freigeben.
// Alle Daten-Zugriffe laufen ueber die Edge Function review-api.

interface ReviewReq {
  id: string; lead_id: string | null; token: string; recipient_name: string
  language: string; status: string; answers: Record<string, string>
  question_ratings: Record<string, number>
  rating: number | null; review_text: string | null; photo_url: string | null
  consent_given_at: string | null; consent_revoked_at: string | null
  published: boolean; sent_at: string | null; submitted_at: string | null
  created_at: string; url: string
}
interface LeadOpt { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null }

const QUESTION_LABELS: Record<string, string> = {
  q1: 'Zooms & Treffen: alles verständlich beantwortet?',
  q2: 'Exposés verständlich & vollständig?',
  q3: 'Kaufprozess eindeutig erklärt?',
  q4: 'Immer gut beraten & aufgehoben gefühlt?',
  q5: 'Was können Lotte & Sven verbessern?',
}

const fmt = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : '–'

export default function Reviews() {
  const { t } = useTranslation()
  const [reqs, setReqs] = useState<ReviewReq[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [leads, setLeads] = useState<LeadOpt[]>([])
  const [sending, setSending] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('review-api', { body: { action: 'list' } })
      if (error) throw error
      setReqs(((data as { requests?: ReviewReq[] } | null)?.requests) ?? [])
    } catch (e) { console.error('[Reviews] list:', e) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  // Lead-Suche fuer neue Anfragen
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setLeads([]); return }
    const h = setTimeout(async () => {
      const { data } = await supabase.from('leads')
        .select('id, first_name, last_name, email, phone, whatsapp')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(8)
      setLeads((data as LeadOpt[]) ?? [])
    }, 300)
    return () => clearTimeout(h)
  }, [query])

  const send = async (lead: LeadOpt) => {
    const name = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || lead.email || '?'
    setSending(lead.id); setNotice('')
    try {
      const { data, error } = await supabase.functions.invoke('review-api', { body: { action: 'create', lead_id: lead.id } })
      if (error) throw error
      const d = data as { ok?: boolean; error?: string } | null
      if (!d?.ok) throw new Error(d?.error)
      setNotice(t('crm.reviews.sent', { name }))
      setQuery(''); setLeads([])
      void load()
    } catch (e) {
      console.error('[Reviews] send:', e)
      setNotice(`${t('crm.reviews.sendError')}: ${e instanceof Error ? e.message : ''}`)
    } finally { setSending(null) }
  }

  const togglePublish = async (r: ReviewReq) => {
    const { data, error } = await supabase.functions.invoke('review-api', { body: { action: 'publish', id: r.id, published: !r.published } })
    const d = data as { ok?: boolean; error?: string } | null
    if (error || !d?.ok) { setNotice(d?.error ?? String(error)); return }
    void load()
  }

  const remove = async (r: ReviewReq) => {
    if (!window.confirm(t('crm.reviews.deleteConfirm'))) return
    await supabase.functions.invoke('review-api', { body: { action: 'delete', id: r.id } })
    void load()
  }

  const copyLink = async (r: ReviewReq) => {
    try { await navigator.clipboard.writeText(r.url) } catch { /* Safari-Fallback unnoetig, Link steht im Popup */ }
    setCopiedId(r.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-4xl mx-auto">
        <h1 className="font-heading text-2xl text-hp-slate">{t('crm.reviews.title')}</h1>
        <p className="text-sm text-gray-500 mt-1 mb-6">{t('crm.reviews.subtitle')}</p>

        {/* Neue Anfrage */}
        <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
          <h2 className="text-sm font-semibold text-hp-slate mb-3">{t('crm.reviews.send')}</h2>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('crm.reviews.searchLead')}
            className="w-full border border-gray-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-hp-highlight/40"
          />
          {leads.length > 0 && (
            <div className="mt-2 divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
              {leads.map(l => {
                const name = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.email || '?'
                const phone = l.whatsapp || l.phone
                return (
                  <button key={l.id} onClick={() => void send(l)} disabled={!phone || sending === l.id}
                    className="w-full flex items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-gray-50 disabled:opacity-50">
                    <span>{name} <span className="text-gray-400">{phone ?? 'keine Nummer'}</span></span>
                    <span className="text-hp-highlight font-medium">
                      {sending === l.id ? '…' : t('crm.reviews.sendTo', { name: l.first_name ?? name })}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {notice && <p className="mt-3 text-sm text-gray-600">{notice}</p>}
        </div>

        {/* Liste */}
        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-orange-300 border-t-hp-highlight rounded-full animate-spin" />
          </div>
        ) : reqs.length === 0 ? (
          <p className="text-center text-gray-400 py-10">{t('crm.reviews.empty')}</p>
        ) : (
          <div className="space-y-3">
            {reqs.map(r => {
              const consentOk = !!r.consent_given_at && !r.consent_revoked_at
              const open = openId === r.id
              return (
                <div key={r.id} className="bg-white rounded-2xl shadow-sm p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    {r.photo_url && <img src={r.photo_url} alt="" className="w-9 h-9 rounded-full object-cover" />}
                    <button onClick={() => setOpenId(open ? null : r.id)} className="font-medium text-hp-slate hover:text-hp-highlight">
                      {r.recipient_name}
                    </button>
                    {r.rating && <span className="text-sm" title={`${r.rating}/5`}>{'🦴'.repeat(r.rating)}</span>}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${r.status === 'submitted' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {r.status === 'submitted'
                        ? `${t('crm.reviews.status_submitted')} · ${fmt(r.submitted_at)}`
                        : `${t('crm.reviews.status_sent')} · ${fmt(r.sent_at)}`}
                    </span>
                    {r.consent_revoked_at
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600">{t('crm.reviews.revokedBadge')}</span>
                      : r.consent_given_at
                        ? <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{t('crm.reviews.consentBadge')}</span>
                        : r.status === 'submitted'
                          ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{t('crm.reviews.noConsent')}</span>
                          : null}
                    {r.published && <span className="text-xs px-2 py-0.5 rounded-full bg-hp-highlight/10 text-hp-highlight font-medium">{t('crm.reviews.published')}</span>}
                    <span className="flex-1" />
                    {r.review_text && consentOk && (
                      <button onClick={() => void togglePublish(r)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium ${r.published ? 'border border-gray-300 text-gray-600 hover:bg-gray-50' : 'bg-hp-highlight text-white hover:opacity-90'}`}>
                        {r.published ? t('crm.reviews.unpublish') : t('crm.reviews.publish')}
                      </button>
                    )}
                    <button onClick={() => void copyLink(r)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">
                      {copiedId === r.id ? t('crm.reviews.copied') : t('crm.reviews.copyLink')}
                    </button>
                    {r.status !== 'submitted' && (
                      <button onClick={() => void remove(r)} className="text-xs px-2 py-1.5 text-gray-400 hover:text-red-500">✕</button>
                    )}
                  </div>

                  {open && (
                    <div className="mt-4 border-t border-gray-100 pt-4 space-y-3 text-sm">
                      {Object.entries(QUESTION_LABELS).map(([k, label]) => (
                        <div key={k}>
                          <p className="text-xs font-medium text-gray-400">
                            {label}
                            {r.question_ratings?.[k] ? <span className="ml-2" title={`${r.question_ratings[k]}/5`}>{'🦴'.repeat(r.question_ratings[k])}</span> : null}
                          </p>
                          <p className="text-gray-700 whitespace-pre-wrap">{r.answers?.[k] || t('crm.reviews.noAnswer')}</p>
                        </div>
                      ))}
                      <div>
                        <p className="text-xs font-medium text-gray-400">{t('crm.reviews.review')}</p>
                        <p className="text-gray-700 whitespace-pre-wrap">{r.review_text || t('crm.reviews.noAnswer')}</p>
                      </div>
                      <p className="text-xs text-gray-400 break-all">{r.url}</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
