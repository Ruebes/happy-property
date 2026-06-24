import { useState, useEffect, useCallback, useMemo } from 'react'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { CustomSelect } from '../../../components/CustomSelect'
import { NumberStepper } from '../../../components/NumberStepper'
import {
  VAT_TREATMENTS, vatInfo, defaultTreatmentForMode, computeTotals,
  eurFmt, dateFmt, INVOICE_STATUS_LABEL,
} from '../../../lib/invoiceVat'
import type {
  Invoice, InvoiceCustomer, InvoiceArticle, SubscriptionPlan, VatTreatment,
} from '../../../lib/crmTypes'

const SUPA = import.meta.env.VITE_SUPABASE_URL
const pdfUrlFor = (token: string) => `${SUPA}/storage/v1/object/public/invoice-documents/${token}.pdf`
const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', sent: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700', canceled: 'bg-red-50 text-red-600',
}

type Row = Invoice & { customer?: { company_name: string; contact_name: string | null } | null }

export default function Invoices() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [creating, setCreating] = useState(false)

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('crm_invoices')
      .select('*, customer:invoice_customers(company_name, contact_name)')
      .order('created_at', { ascending: false })
    if (!error) setRows((data ?? []) as Row[])
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const setStatus = async (inv: Row, status: 'paid' | 'canceled' | 'sent') => {
    const patch: Record<string, unknown> = { status }
    if (status === 'paid') patch.paid_at = new Date().toISOString()
    const { error } = await supabase.from('crm_invoices').update(patch).eq('id', inv.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    showToast(`${inv.invoice_number}: ${INVOICE_STATUS_LABEL[status]}`)
    fetchAll()
  }

  const copyLink = (inv: Row) => {
    void navigator.clipboard.writeText(`${window.location.origin}/re/${inv.token}`)
    showToast(`Link zu ${inv.invoice_number} kopiert`)
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-[70] bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">{toast}</div>}

      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Rechnungen</h1>
            <p className="text-sm text-gray-500 mt-0.5">Rechnungen erstellen, herunterladen und versenden. Aussteller: sveru ltd (Happy Property).</p>
          </div>
          <button onClick={() => setCreating(true)}
            className="px-3 py-1.5 rounded-xl text-white text-sm font-medium whitespace-nowrap" style={{ backgroundColor: '#ff795d' }}>
            + Neue Rechnung
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-12 bg-white rounded-2xl border border-dashed border-gray-200">Noch keine Rechnungen.</p>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="px-4 py-3 font-medium">Nummer</th>
                <th className="px-4 py-3 font-medium">Datum</th>
                <th className="px-4 py-3 font-medium">Empfänger</th>
                <th className="px-4 py-3 font-medium text-right">Betrag</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Aktionen</th>
              </tr></thead>
              <tbody>
                {rows.map(inv => (
                  <tr key={inv.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-semibold text-gray-800">{inv.invoice_number}</td>
                    <td className="px-4 py-3 text-gray-500">{dateFmt(inv.issue_date)}</td>
                    <td className="px-4 py-3 text-gray-700">{inv.customer?.company_name ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-800">{eurFmt(inv.total_gross)}</td>
                    <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[inv.status] ?? ''}`}>{INVOICE_STATUS_LABEL[inv.status] ?? inv.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2.5 text-xs">
                        <a href={pdfUrlFor(inv.token)} target="_blank" rel="noreferrer" className="text-gray-500 hover:text-orange-600 font-medium">PDF</a>
                        <button onClick={() => copyLink(inv)} className="text-gray-500 hover:text-orange-600 font-medium">Link</button>
                        {inv.status !== 'paid' && <button onClick={() => setStatus(inv, 'paid')} className="text-green-600 hover:text-green-800 font-medium">Bezahlt</button>}
                        {inv.status === 'draft' && <button onClick={() => setStatus(inv, 'sent')} className="text-blue-600 hover:text-blue-800 font-medium">Versendet</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && <ManualInvoiceModal onClose={() => setCreating(false)} onCreated={(m) => { setCreating(false); showToast(m); fetchAll() }} />}
    </DashboardLayout>
  )
}

// ── Manuelle Rechnung ────────────────────────────────────────────────────────────
interface Line { description: string; quantity: number; unit_price_net: number }

function ManualInvoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (m: string) => void }) {
  const [customers, setCustomers] = useState<InvoiceCustomer[]>([])
  const [articles, setArticles] = useState<InvoiceArticle[]>([])
  const [plans, setPlans] = useState<SubscriptionPlan[]>([])
  const [customerId, setCustomerId] = useState('')
  const [treatment, setTreatment] = useState<VatTreatment>('standard_19')
  const [lines, setLines] = useState<Line[]>([{ description: '', quantity: 1, unit_price_net: 0 }])
  const [send, setSend] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { void (async () => {
    const [{ data: c }, { data: a }, { data: p }] = await Promise.all([
      supabase.from('invoice_customers').select('*').order('company_name'),
      supabase.from('invoice_articles').select('*').eq('active', true).order('name'),
      supabase.from('subscription_plans').select('*').eq('active', true).order('name'),
    ])
    const cs = (c ?? []) as InvoiceCustomer[]
    setCustomers(cs); setArticles((a ?? []) as InvoiceArticle[]); setPlans((p ?? []) as SubscriptionPlan[])
    const def = cs.find(x => x.is_default) ?? cs[0]
    if (def) { setCustomerId(def.id); setTreatment(defaultTreatmentForMode(def.country_mode)) }
  })() }, [])

  const customer = customers.find(c => c.id === customerId) ?? null
  const info = vatInfo(treatment)
  const totals = useMemo(() => computeTotals(lines, info.rate), [lines, info.rate])

  const setLine = (i: number, patch: Partial<Line>) => setLines(prev => prev.map((l, j) => j === i ? { ...l, ...patch } : l))
  const addLine = () => setLines(prev => [...prev, { description: '', quantity: 1, unit_price_net: 0 }])
  const rmLine = (i: number) => setLines(prev => prev.filter((_, j) => j !== i))

  const catalogOptions = [
    ...articles.map(a => ({ value: `a:${a.id}`, label: `${a.name} (${eurFmt(a.net_price)})` })),
    ...plans.map(p => ({ value: `p:${p.id}`, label: `Abo: ${p.name} (${eurFmt(p.net_price)})` })),
  ]
  const addFromCatalog = (val: string) => {
    if (val.startsWith('a:')) { const a = articles.find(x => x.id === val.slice(2)); if (a) setLines(prev => [...prev, { description: a.name, quantity: 1, unit_price_net: a.net_price }]) }
    if (val.startsWith('p:')) { const p = plans.find(x => x.id === val.slice(2)); if (p) setLines(prev => [...prev, { description: `${p.name} (Abo)`, quantity: 1, unit_price_net: p.net_price }]) }
  }

  const create = async () => {
    const valid = lines.filter(l => l.description.trim() && l.unit_price_net > 0)
    if (!customerId) { setErr('Bitte einen Empfänger wählen.'); return }
    if (!valid.length) { setErr('Mindestens ein Posten mit Beschreibung + Betrag.'); return }
    setBusy(true); setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('generate-invoice', {
        body: { customer_id: customerId, vat_treatment: treatment, items: valid, send },
      })
      if (error) throw error
      const res = data as { ok?: boolean; invoice_number?: string; sent?: boolean; error?: string }
      if (!res?.ok) throw new Error(res?.error || 'Fehler')
      onCreated(`Rechnung ${res.invoice_number} erstellt${res.sent ? ' & gesendet' : ''}`)
    } catch (e) { setErr((e as Error).message); setBusy(false) }
  }

  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-6 max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Neue Rechnung</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Empfänger</label>
              <CustomSelect value={customerId}
                onChange={v => { setCustomerId(v); const c = customers.find(x => x.id === v); if (c) setTreatment(defaultTreatmentForMode(c.country_mode)) }}
                options={customers.map(c => ({ value: c.id, label: c.company_name, hint: c.vat_number ?? undefined }))} placeholder="– Kunde wählen –" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">MwSt-Behandlung</label>
              <CustomSelect value={treatment} onChange={v => setTreatment(v as VatTreatment)}
                options={VAT_TREATMENTS.map(o => ({ value: o.value, label: o.label }))} />
            </div>
          </div>

          {/* Posten */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-gray-500">Posten</label>
              {catalogOptions.length > 0 && (
                <div className="w-56"><CustomSelect value="" onChange={addFromCatalog} options={catalogOptions} placeholder="+ aus Katalog" /></div>
              )}
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <input className={`${inputCls} flex-1`} placeholder="Beschreibung" value={l.description} onChange={e => setLine(i, { description: e.target.value })} />
                  <div className="w-20"><NumberStepper value={l.quantity} onChange={v => setLine(i, { quantity: v })} min={1} /></div>
                  <div className="w-32"><NumberStepper value={l.unit_price_net} onChange={v => setLine(i, { unit_price_net: v })} step={100} min={0} suffix="€" /></div>
                  <button onClick={() => rmLine(i)} disabled={lines.length === 1} className="px-2 py-2.5 text-gray-300 hover:text-red-500 disabled:opacity-30">✕</button>
                </div>
              ))}
            </div>
            <button onClick={addLine} className="mt-2 text-xs text-orange-600 font-medium hover:text-orange-800">+ Posten hinzufügen</button>
          </div>

          {/* Summen */}
          <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm space-y-1">
            <div className="flex justify-between text-gray-600"><span>Zwischensumme (netto)</span><span className="font-medium text-gray-800">{eurFmt(totals.subtotal_net)}</span></div>
            <div className="flex justify-between text-gray-600"><span>{info.rate > 0 ? `MwSt ${info.rate}%` : info.label}</span><span className="font-medium text-gray-800">{eurFmt(totals.vat_amount)}</span></div>
            <div className="flex justify-between pt-1.5 mt-1 border-t border-gray-200"><span className="font-semibold">Gesamt</span><span className="font-bold" style={{ color: '#ff795d' }}>{eurFmt(totals.total_gross)}</span></div>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={send} onChange={e => setSend(e.target.checked)} className="w-4 h-4 accent-orange-500" />
            <span className="text-sm text-gray-700">Direkt per E-Mail senden{customer?.email ? ` an ${customer.email}` : ''}</span>
          </label>

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">Abbrechen</button>
          <button onClick={create} disabled={busy} className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {busy ? 'Erstelle…' : send ? 'Erstellen & senden' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  )
}
