import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'

// ── Tippgeber-Programm ────────────────────────────────────────────────────────
// Jeder Kunde/Newsletter-Empfaenger hat GENAU EINEN eindeutigen Empfehlungs-Link
// (angelegt von ensure_affiliate, Code aendert sich nie). Diese Seite listet alle
// Tippgeber untereinander: Name + eigener Link, aufklappbar die Leute, die er
// empfohlen hat, und die 1.000-€-Auszahlungen. Abrechnungen verschickt der Cron;
// die AUSZAHLUNG loest Sven bewusst per Klick aus - Geld verlaesst das Konto nie
// vollautomatisch.

interface ReferredLead { id: string; first_name: string | null; last_name: string | null; email: string | null; phase: string | null; created_at: string }
interface Payout {
  id: string; referred_lead_id: string | null; amount: number; status: string
  doc_no: string | null; doc_url: string | null; payout_link: string | null
  emailed_at: string | null; paid_at: string | null; created_at: string
}
interface Affiliate {
  id: string; name: string; email: string | null; whatsapp: string | null
  code: string; source: string | null; active: boolean; created_at: string; url: string
  referred: ReferredLead[]; payouts: Payout[]
  referred_count: number; payout_total: number; open_total: number
}

const fmt = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : '–'
const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' €'
const leadName = (l: ReferredLead) => `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.email || '?'

export default function Affiliates() {
  const { t } = useTranslation()
  const [affs, setAffs] = useState<Affiliate[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [onlyReferring, setOnlyReferring] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('affiliate-api', { body: { action: 'list' } })
      if (error) throw error
      setAffs(((data as { affiliates?: Affiliate[] } | null)?.affiliates) ?? [])
    } catch (e) { console.error('[Affiliates] list:', e) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const call = async (body: Record<string, unknown>, busyKey: string, okMsg?: string) => {
    setBusy(busyKey); setNotice('')
    try {
      const { data, error } = await supabase.functions.invoke('affiliate-api', { body })
      const d = data as { ok?: boolean; error?: string } | null
      if (error || !d?.ok) throw new Error(d?.error ?? String(error))
      if (okMsg) setNotice(okMsg)
      void load()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Fehler')
    } finally { setBusy(null) }
  }

  const copyLink = async (a: Affiliate) => {
    try { await navigator.clipboard.writeText(a.url) } catch { /* Link steht sichtbar daneben */ }
    setCopiedId(a.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const payoutLink = (a: Affiliate, p: Payout) => {
    if (!window.confirm(t('crm.affiliates.confirmPayout', { amount: eur(p.amount), name: a.name }))) return
    void call({ action: 'payout_link', payout_id: p.id }, `pl-${p.id}`, t('crm.affiliates.payoutLinkDone'))
  }

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return affs.filter(a => {
      if (onlyReferring && a.referred_count === 0) return false
      if (!q) return true
      return [a.name, a.email ?? '', a.code, ...a.referred.map(leadName)]
        .some(v => v.toLowerCase().includes(q))
    })
  }, [affs, search, onlyReferring, ])

  const totals = useMemo(() => ({
    tippgeber: affs.length,
    geworben: affs.reduce((s, a) => s + a.referred_count, 0),
    offen: affs.reduce((s, a) => s + a.open_total, 0),
  }), [affs])

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-4xl mx-auto">
        <h1 className="font-heading text-2xl text-hp-slate">{t('crm.affiliates.title')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('crm.affiliates.subtitle')}</p>

        <div className="flex flex-wrap items-center gap-2 mt-4 mb-5">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('crm.affiliates.search')}
            className="flex-1 min-w-[200px] px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-orange-200"
          />
          <button
            onClick={() => setOnlyReferring(v => !v)}
            className={`text-xs px-3 py-2 rounded-xl border ${onlyReferring ? 'border-hp-highlight text-hp-highlight bg-orange-50' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
            {t('crm.affiliates.onlyReferring')}
          </button>
        </div>

        {!loading && affs.length > 0 && (
          <p className="text-xs text-gray-400 mb-3">
            {t('crm.affiliates.summary', { count: totals.tippgeber, referred: totals.geworben, open: eur(totals.offen) })}
          </p>
        )}
        {notice && <p className="mb-4 text-sm text-gray-600 bg-white rounded-xl shadow-sm p-3">{notice}</p>}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-orange-300 border-t-hp-highlight rounded-full animate-spin" />
          </div>
        ) : affs.length === 0 ? (
          <p className="text-center text-gray-400 py-10 max-w-lg mx-auto">{t('crm.affiliates.empty')}</p>
        ) : shown.length === 0 ? (
          <p className="text-center text-gray-400 py-10">{t('crm.affiliates.noMatch')}</p>
        ) : (
          <div className="space-y-2">
            {shown.map(a => {
              const isOpen = !!open[a.id]
              return (
                <div key={a.id} className="bg-white rounded-2xl shadow-sm">
                  {/* Kopfzeile: Name, Kennzahlen, Link kopieren, Aufklappen */}
                  <div className="flex flex-wrap items-center gap-2 p-4">
                    <button
                      onClick={() => setOpen(o => ({ ...o, [a.id]: !isOpen }))}
                      aria-expanded={isOpen}
                      className="flex items-center gap-2 text-left min-w-0 flex-1">
                      <span className={`text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                      <span className="font-medium text-hp-slate truncate">{a.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${a.referred_count ? 'bg-orange-50 text-hp-highlight' : 'bg-gray-100 text-gray-400'}`}>
                        {t('crm.affiliates.countReferred', { count: a.referred_count })}
                      </span>
                      {a.payout_total > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700">{eur(a.payout_total)}</span>
                      )}
                      {!a.active && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">{t('crm.affiliates.inactive')}</span>}
                    </button>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{t('crm.affiliates.code')}: {a.code}</span>
                    <button onClick={() => void copyLink(a)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">
                      {copiedId === a.id ? t('crm.affiliates.copied') : t('crm.affiliates.copyLink')}
                    </button>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                      <p className="text-xs text-gray-400 break-all">{a.url}</p>
                      <div className="flex flex-wrap gap-3 mt-1 text-xs text-gray-400">
                        {a.email && <span>{a.email}</span>}
                        {a.whatsapp && <span>{a.whatsapp}</span>}
                        <span>{t('crm.affiliates.since')} {fmt(a.created_at)}</span>
                        {a.source && <span>{t(`crm.affiliates.source_${a.source}`, { defaultValue: a.source })}</span>}
                      </div>

                      <div className="mt-4">
                        <p className="text-xs font-medium text-gray-400 mb-1.5">{t('crm.affiliates.referred')}</p>
                        {a.referred.length === 0 ? (
                          <p className="text-sm text-gray-400">{t('crm.affiliates.noneReferred')}</p>
                        ) : (
                          <div className="space-y-1">
                            {a.referred.map(l => (
                              <div key={l.id} className="flex items-center gap-2 text-sm">
                                <a href={`/admin/crm/leads/${l.id}`} className="text-hp-slate hover:text-hp-highlight font-medium">
                                  {leadName(l)}
                                </a>
                                {l.phase && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{l.phase}</span>}
                                <span className="text-xs text-gray-400">{fmt(l.created_at)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {a.payouts.length > 0 && (
                        <div className="mt-4 border-t border-gray-100 pt-3">
                          <p className="text-xs font-medium text-gray-400 mb-1.5">{t('crm.affiliates.payouts')}</p>
                          <div className="space-y-2">
                            {a.payouts.map(p => (
                              <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-medium text-hp-slate">{eur(p.amount)}</span>
                                <span className={`text-xs px-2 py-0.5 rounded-full ${
                                  p.status === 'bezahlt' ? 'bg-green-50 text-green-700'
                                  : p.status === 'abgerechnet' ? 'bg-amber-50 text-amber-700'
                                  : 'bg-gray-100 text-gray-500'}`}>
                                  {t(`crm.affiliates.status_${p.status}`)}
                                </span>
                                {p.doc_url && <a href={p.doc_url} target="_blank" rel="noreferrer" className="text-xs text-hp-highlight hover:underline">{t('crm.affiliates.doc')} {p.doc_no}</a>}
                                <span className="flex-1" />
                                {p.status !== 'bezahlt' && (
                                  <>
                                    <button onClick={() => void call({ action: 'resend', payout_id: p.id }, `rs-${p.id}`)} disabled={busy === `rs-${p.id}`}
                                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                                      {t('crm.affiliates.resend')}
                                    </button>
                                    {!p.payout_link && (
                                      <button onClick={() => payoutLink(a, p)} disabled={busy === `pl-${p.id}`}
                                        className="text-xs px-3 py-1.5 rounded-lg bg-hp-highlight text-white font-medium hover:opacity-90 disabled:opacity-50">
                                        {busy === `pl-${p.id}` ? '…' : t('crm.affiliates.payoutLink')}
                                      </button>
                                    )}
                                    <button onClick={() => void call({ action: 'mark_paid', payout_id: p.id }, `mp-${p.id}`)} disabled={busy === `mp-${p.id}`}
                                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                                      {t('crm.affiliates.markPaid')}
                                    </button>
                                  </>
                                )}
                                {p.payout_link && <a href={p.payout_link} target="_blank" rel="noreferrer" className="text-xs text-hp-highlight hover:underline break-all">Payout-Link</a>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
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
