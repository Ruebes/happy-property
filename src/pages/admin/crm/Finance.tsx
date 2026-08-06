import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { CustomSelect } from '../../../components/CustomSelect'

// ── Buchhaltung ───────────────────────────────────────────────────────────────
// Revolut-Kontobewegungen (täglicher Sync + Backfill), Kategorien (Regeln + KI),
// Beleg-Zuordnung, Ausgangskorb (Rechnungen, die Sven zahlen muss) und
// Monats-Auswertung mit CSV-Export für den Steuerberater.

interface FinTx {
  id: string; booked_at: string; amount: number; currency: string
  counterparty: string; reference: string; category: string | null
  category_source: string | null; doc_url: string | null; doc_name: string | null
  doc_status: string | null
}
interface Payable {
  id: string; vendor: string; title: string; amount: number | null; currency: string
  due_at: string | null; doc_url: string | null; status: string; created_at: string
}
const CATS = ['kundenzahlung', 'developer', 'werbung', 'software', 'gebuehren', 'buero', 'reise', 'steuern_abgaben', 'gehalt_privat', 'sonstiges']
const CAT_LABEL: Record<string, string> = {
  kundenzahlung: '💶 Kundenzahlung', developer: '🏗 Developer', werbung: '📣 Werbung', software: '💻 Software',
  gebuehren: '🏦 Gebühren', buero: '🏢 Büro', reise: '✈️ Reise', steuern_abgaben: '🧾 Steuern & Abgaben',
  gehalt_privat: '👤 Gehalt/Privat', sonstiges: '📦 Sonstiges',
}
const eur = (n: number) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })

export default function Finance() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'tx' | 'payables' | 'report'>('tx')
  const [txs, setTxs] = useState<FinTx[]>([])
  const [payables, setPayables] = useState<Payable[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState('')      // '' = alle, sonst YYYY-MM
  const [catFilter, setCatFilter] = useState('')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 5000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: a, error: e1 }, { data: b }] = await Promise.all([
        supabase.from('fin_transactions').select('*').order('booked_at', { ascending: false }).limit(1500),
        supabase.from('fin_payables').select('*').order('created_at', { ascending: false }).limit(200),
      ])
      if (e1) throw e1
      setTxs((a as unknown as FinTx[]) ?? [])
      setPayables((b as unknown as Payable[]) ?? [])
    } catch (err) { console.error('[Finance] fetchAll:', err) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void fetchAll() }, [fetchAll])

  const months = useMemo(() => Array.from(new Set(txs.map(x => x.booked_at.slice(0, 7)))).sort().reverse(), [txs])
  const [onlyNoDoc, setOnlyNoDoc] = useState(false)
  const noDocCount = useMemo(() => txs.filter(x => !x.doc_url && x.doc_status !== 'nicht_noetig').length, [txs])
  const filtered = useMemo(() => txs.filter(x =>
    (!month || x.booked_at.startsWith(month)) && (!catFilter || x.category === catFilter)
    && (!onlyNoDoc || (!x.doc_url && x.doc_status !== 'nicht_noetig'))), [txs, month, catFilter, onlyNoDoc])

  // Beleg-Status („kein Beleg nötig" bei Dauerzahlungen/Kredit-Rückzahlung etc.)
  const setDocStatus = async (tx: FinTx, v: string) => {
    setTxs(arr => arr.map(x => x.id === tx.id ? { ...x, doc_status: v || null } : x))
    const { error } = await supabase.from('fin_transactions').update({ doc_status: v || null }).eq('id', tx.id)
    if (error) showToast(`❌ ${error.message}`)
  }
  // Beleg manuell an eine Buchung hängen (PDF oder Bild, max 15 MB)
  const uploadDoc = async (tx: FinTx, file: File) => {
    if (file.size > 15 * 1048576) { showToast(`❌ ${t('crm.fin.docTooBig', 'Datei zu groß (max. 15 MB)')}`); return }
    const ext = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : (file.name.split('.').pop() ?? 'jpg').toLowerCase().slice(0, 4)
    const path = `manual/${tx.id}.${ext}`
    const { error } = await supabase.storage.from('fin-receipts').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: true })
    if (error) { showToast(`❌ ${error.message}`); return }
    const url = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/fin-receipts/${path}`
    const { error: e2 } = await supabase.from('fin_transactions').update({ doc_url: url, doc_name: file.name, doc_status: null }).eq('id', tx.id)
    if (e2) { showToast(`❌ ${e2.message}`); return }
    setTxs(arr => arr.map(x => x.id === tx.id ? { ...x, doc_url: url, doc_name: file.name, doc_status: null } : x))
    showToast(`📎 ${t('crm.fin.docAdded', 'Beleg angehängt')}`)
  }

  // Kategorie setzen + still lernen: Gegenpartei → Regel für die Zukunft
  const setCategory = async (tx: FinTx, cat: string) => {
    setTxs(arr => arr.map(x => x.id === tx.id ? { ...x, category: cat, category_source: 'manuell' } : x))
    const { error } = await supabase.from('fin_transactions').update({ category: cat, category_source: 'manuell' }).eq('id', tx.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    const key = tx.counterparty.trim().toLowerCase()
    if (key.length >= 4) {
      const { data: ex } = await supabase.from('fin_rules').select('id').eq('match', key).limit(1)
      if (!ex?.length) await supabase.from('fin_rules').insert({ match: key, category: cat })
    }
  }

  const runSync = async (action: 'tx_sync' | 'tx_backfill' | 'categorize_ai') => {
    setBusy(action)
    try {
      const { data, error } = await supabase.functions.invoke('revolut-sync', { body: { action, ...(action === 'tx_backfill' ? { days: 365 } : {}) } })
      const d = (data ?? {}) as { success?: boolean; error?: string; imported?: number; categorized?: number; payables_matched?: number }
      if (error || d.error || !d.success) throw new Error(d.error || error?.message || 'Fehler')
      showToast(action === 'categorize_ai'
        ? `🤖 ${t('crm.fin.aiDone', '{{n}} Buchungen kategorisiert', { n: d.categorized ?? 0 })}`
        : `✓ ${t('crm.fin.syncDone', '{{n}} neue Buchungen', { n: d.imported ?? 0 })}${d.payables_matched ? ` · ${d.payables_matched} ${t('crm.fin.paidMatched', 'Rechnung(en) als bezahlt erkannt')}` : ''}`)
      await fetchAll()
    } catch (e) { showToast(`❌ ${e instanceof Error ? e.message : 'Fehler'}`) } finally { setBusy('') }
  }

  // ── Steuerberater-Export (CSV + Belege-ZIP per Mail) ───────────────────────
  const [taxOpen, setTaxOpen] = useState(false)
  const [taxFrom, setTaxFrom] = useState(`${new Date().getFullYear()}-01-01`)
  const [taxTo, setTaxTo] = useState(new Date().toISOString().slice(0, 10))
  const [taxEmail, setTaxEmail] = useState('')
  const [taxBusy, setTaxBusy] = useState(false)
  const openTax = async () => {
    setTaxOpen(true)
    if (!taxEmail) {
      try {
        const { data } = await supabase.from('crm_business_contacts').select('email').ilike('role', '%steuerberater%').limit(1).maybeSingle()
        setTaxEmail(((data as { email?: string } | null)?.email ?? '').trim())
      } catch (e) { console.warn('[Finance] Steuerberater-Mail:', e) }
    }
  }
  const sendTax = async () => {
    setTaxBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('revolut-sync', { body: { action: 'tax_export', from: taxFrom, to: taxTo, email: taxEmail } })
      const d = (data ?? {}) as { success?: boolean; error?: string; transactions?: number; receipts?: number; invoices?: number; sent_to?: string | null }
      if (error || d.error || !d.success) throw new Error(d.error || error?.message || 'Fehler')
      showToast(`📤 ${t('crm.fin.taxDone', 'Export an {{mail}} gesendet: {{tx}} Buchungen, {{r}} Belege, {{i}} Rechnungen', { mail: d.sent_to ?? taxEmail, tx: d.transactions ?? 0, r: d.receipts ?? 0, i: d.invoices ?? 0 })}`)
      setTaxOpen(false)
    } catch (e) { showToast(`❌ ${e instanceof Error ? e.message : 'Fehler'}`) } finally { setTaxBusy(false) }
  }

  const deletePayable = async (p: Payable) => {
    if (!window.confirm(t('crm.fin.delPayConfirm', '„{{title}}" endgültig aus dem Ausgangskorb löschen?', { title: p.title }))) return
    const { error } = await supabase.from('fin_payables').delete().eq('id', p.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    setPayables(arr => arr.filter(x => x.id !== p.id))
    showToast(`🗑 ${t('crm.fin.delPayDone', 'Eintrag gelöscht')}`)
  }

  const setPayableStatus = async (p: Payable, status: string) => {
    const { error } = await supabase.from('fin_payables').update({ status, ...(status === 'bezahlt' ? { paid_at: new Date().toISOString() } : {}) }).eq('id', p.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    setPayables(arr => arr.map(x => x.id === p.id ? { ...x, status } : x))
  }

  // Auswertung: Monat × Kategorie
  const report = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    for (const x of txs) {
      const mo = x.booked_at.slice(0, 7)
      const cat = x.category ?? 'offen'
      if (!map.has(mo)) map.set(mo, new Map())
      const inner = map.get(mo)!
      inner.set(cat, (inner.get(cat) ?? 0) + x.amount)
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [txs])

  const exportCsv = () => {
    const rows = [['Datum', 'Gegenpartei', 'Verwendungszweck', 'Betrag', 'Währung', 'Kategorie', 'Beleg']]
    for (const x of filtered) rows.push([x.booked_at.slice(0, 10), x.counterparty, x.reference, String(x.amount).replace('.', ','), x.currency, x.category ?? '', x.doc_url ?? ''])
    const csv = rows.map(r => r.map(c => `"${(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `buchhaltung${month ? `-${month}` : ''}.csv`; a.click()
    URL.revokeObjectURL(a.href)
  }

  const openPayables = payables.filter(p => p.status === 'offen')
  const btn = 'px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50'
  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">📒 {t('crm.fin.title', 'Buchhaltung')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{t('crm.fin.subtitle', 'Revolut-Konto · tägliche Synchronisierung · Rechnungen aus info@ landen automatisch hier')}</p>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => void runSync('tx_sync')} disabled={!!busy} className={btn}>{busy === 'tx_sync' ? '…' : `🔄 ${t('crm.fin.sync', 'Sync')}`}</button>
            <button onClick={() => void runSync('categorize_ai')} disabled={!!busy} className={btn}>{busy === 'categorize_ai' ? '…' : `🤖 ${t('crm.fin.ai', 'KI-Kategorien')}`}</button>
            <button onClick={exportCsv} className={btn}>⬇️ CSV</button>
            <button onClick={() => void openTax()} className={btn}>📤 {t('crm.fin.taxBtn', 'An Steuerberater')}</button>
          </div>
        </div>

        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
          {([['tx', `💳 ${t('crm.fin.tabTx', 'Transaktionen')}`], ['payables', `📥 ${t('crm.fin.tabPay', 'Ausgangskorb')}${openPayables.length ? ` (${openPayables.length})` : ''}`], ['report', `📊 ${t('crm.fin.tabReport', 'Auswertung')}`]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab === k ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}>{l}</button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : tab === 'tx' ? (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex gap-2 p-3 border-b border-gray-50 flex-wrap">
              <div className="w-40"><CustomSelect value={month} onChange={setMonth} options={[{ value: '', label: t('crm.fin.allMonths', 'Alle Monate') }, ...months.map(m => ({ value: m, label: m }))]} /></div>
              <div className="w-56"><CustomSelect value={catFilter} onChange={setCatFilter} options={[{ value: '', label: t('crm.fin.allCats', 'Alle Kategorien') }, ...CATS.map(c => ({ value: c, label: CAT_LABEL[c] }))]} /></div>
              <button onClick={() => setOnlyNoDoc(v => !v)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${onlyNoDoc ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                🧾 {t('crm.fin.noDocFilter', 'Ohne Beleg')} ({noDocCount})
              </button>
              <p className="ml-auto text-sm text-gray-400 self-center">{filtered.length} · {eur(filtered.reduce((s, x) => s + x.amount, 0))}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {filtered.map(x => (
                    <tr key={x.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{new Date(x.booked_at).toLocaleDateString('de-DE')}</td>
                      <td className="px-3 py-2 max-w-[220px]"><p className="font-medium text-gray-900 truncate">{x.counterparty || '—'}</p><p className="text-xs text-gray-400 truncate">{x.reference}</p></td>
                      <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${x.amount >= 0 ? 'text-green-600' : 'text-gray-900'}`}>{eur(x.amount)}</td>
                      <td className="px-3 py-2 w-52">
                        <CustomSelect value={x.category ?? ''} onChange={v => { if (v) void setCategory(x, v) }}
                          options={[{ value: '', label: t('crm.fin.pick', '— wählen —') }, ...CATS.map(c => ({ value: c, label: CAT_LABEL[c] }))]} />
                        {x.category_source === 'ki' && <p className="text-[10px] text-gray-400 mt-0.5">🤖 {t('crm.fin.bySrcKi', 'KI-Vorschlag')}</p>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {x.doc_url ? (
                          <a href={x.doc_url} target="_blank" rel="noreferrer" title={x.doc_name ?? ''} className="text-lg">📎</a>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <label className="cursor-pointer text-gray-400 hover:text-orange-500 text-lg" title={t('crm.fin.docUpload', 'Beleg hochladen (PDF/Bild)') as string}>
                              📎+<input type="file" accept="application/pdf,image/*" className="hidden"
                                onChange={e => { const f = e.target.files?.[0]; if (f) void uploadDoc(x, f); e.target.value = '' }} />
                            </label>
                            <select value={x.doc_status ?? ''} onChange={e => void setDocStatus(x, e.target.value)}
                              className={`text-[11px] bg-transparent border-0 outline-none cursor-pointer ${x.doc_status === 'nicht_noetig' ? 'text-green-600' : x.doc_status === 'fehlt' ? 'text-red-500' : 'text-gray-400'}`}>
                              <option value="">{t('crm.fin.docOpen', 'offen')}</option>
                              <option value="nicht_noetig">{t('crm.fin.docNotNeeded', 'kein Beleg nötig')}</option>
                              <option value="fehlt">{t('crm.fin.docMissing', 'Beleg fehlt')}</option>
                            </select>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : tab === 'payables' ? (
          <div className="space-y-2">
            {payables.length === 0 && <p className="text-sm text-gray-400 text-center py-8">{t('crm.fin.noPay', 'Keine offenen Rechnungen — Partner-Rechnungen an info@ landen automatisch hier.')}</p>}
            {payables.map(p => (
              <div key={p.id} className={`bg-white rounded-2xl border shadow-sm p-4 flex items-center gap-3 flex-wrap ${p.status === 'offen' ? 'border-amber-200' : 'border-gray-100 opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 text-sm">{p.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{p.vendor}{p.due_at ? ` · ${t('crm.fin.due', 'fällig')} ${new Date(p.due_at).toLocaleDateString('de-DE')}` : ''} · {new Date(p.created_at).toLocaleDateString('de-DE')}</p>
                </div>
                {p.amount != null && <p className="font-bold text-gray-900">{p.amount.toLocaleString('de-DE', { style: 'currency', currency: p.currency || 'EUR' })}</p>}
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${p.status === 'offen' ? 'bg-amber-100 text-amber-700' : p.status === 'bezahlt' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{p.status}</span>
                {p.doc_url && <a href={p.doc_url} target="_blank" rel="noreferrer" className={btn}>📎 PDF</a>}
                {p.status === 'offen' && (<>
                  <button onClick={() => void setPayableStatus(p, 'bezahlt')} className="px-3 py-1.5 rounded-lg text-sm text-white font-medium" style={{ backgroundColor: '#ff795d' }}>✓ {t('crm.fin.markPaid', 'Bezahlt')}</button>
                  <button onClick={() => void setPayableStatus(p, 'ignoriert')} className={btn}>{t('crm.fin.ignore', 'Ignorieren')}</button>
                </>)}
                <button onClick={() => void deletePayable(p)} className="w-8 h-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50" title={t('crm.fin.delPay', 'Endgültig löschen')}>🗑</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="px-3 py-2">{t('crm.fin.month', 'Monat')}</th>
                <th className="px-3 py-2 text-right text-green-600">{t('crm.fin.in', 'Einnahmen')}</th>
                <th className="px-3 py-2 text-right">{t('crm.fin.out', 'Ausgaben')}</th>
                <th className="px-3 py-2 text-right">{t('crm.fin.net', 'Saldo')}</th>
                <th className="px-3 py-2">{t('crm.fin.topCats', 'Größte Ausgaben-Kategorien')}</th>
              </tr></thead>
              <tbody>
                {report.map(([mo, cats]) => {
                  const entries = Array.from(cats.entries())
                  const inSum = entries.filter(([, v]) => v > 0).reduce((s, [, v]) => s + v, 0)
                  const outSum = entries.filter(([, v]) => v < 0).reduce((s, [, v]) => s + v, 0)
                  const top = entries.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 3)
                  return (
                    <tr key={mo} className="border-b border-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-900">{mo}</td>
                      <td className="px-3 py-2 text-right text-green-600 font-semibold">{eur(inSum)}</td>
                      <td className="px-3 py-2 text-right text-gray-900 font-semibold">{eur(outSum)}</td>
                      <td className={`px-3 py-2 text-right font-bold ${inSum + outSum >= 0 ? 'text-green-600' : 'text-red-600'}`}>{eur(inSum + outSum)}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{top.map(([c, v]) => `${CAT_LABEL[c] ?? c} ${eur(v)}`).join(' · ')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {taxOpen && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setTaxOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900">📤 {t('crm.fin.taxTitle', 'Unterlagen an den Steuerberater senden')}</h2>
            <p className="text-xs text-gray-500">{t('crm.fin.taxHint', 'Er bekommt eine E-Mail mit der Buchungsliste (CSV) und einem Download-Link: alle Belege + Ausgangsrechnungen des Zeitraums als ZIP - ein Klick, keine Technik nötig.')}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('common.from', 'Von')}</label>
                <input type="date" value={taxFrom} onChange={e => setTaxFrom(e.target.value)} className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('common.to', 'Bis')}</label>
                <input type="date" value={taxTo} onChange={e => setTaxTo(e.target.value)} className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.fin.taxEmail', 'E-Mail des Steuerberaters')}</label>
              <input type="email" value={taxEmail} onChange={e => setTaxEmail(e.target.value)} className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setTaxOpen(false)} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
              <button onClick={() => void sendTax()} disabled={taxBusy || !taxEmail}
                className="px-5 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
                {taxBusy ? t('crm.fin.taxSending', 'packt & sendet …') : t('crm.fin.taxSend', 'Jetzt senden')}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="fixed bottom-6 right-6 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 max-w-sm">{toast}</div>}
    </DashboardLayout>
  )
}
