import { useState, useEffect, useCallback } from 'react'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import { CustomSelect } from '../../../../components/CustomSelect'
import { NumberStepper } from '../../../../components/NumberStepper'
import { eurFmt } from '../../../../lib/invoiceVat'
import type { InvoiceSettings as TSettings, InvoiceCustomer, InvoiceArticle, SubscriptionPlan, CustomerMode, PlanInterval } from '../../../../lib/crmTypes'

const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'
const labelCls = 'block text-xs font-medium text-gray-500 mb-1'
const cardCls = 'bg-white rounded-2xl border border-gray-100 shadow-sm p-5'
const PLAN_LABEL: Record<PlanInterval, string> = { monthly: 'monatlich', quarterly: 'quartalsweise', yearly: 'jährlich' }

export default function InvoiceSettingsPage() {
  const [toast, setToast] = useState('')
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-[70] bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">{toast}</div>}
      <div className="p-6 space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Rechnungs-Einstellungen</h1>
          <p className="text-sm text-gray-500 mt-0.5">Aussteller, Bank, Nummernkreis, Kunden-Stammdaten, Artikel & Abopläne.</p>
        </div>
        <IssuerSection onToast={showToast} />
        <CustomersSection onToast={showToast} />
        <ArticlesSection onToast={showToast} />
        <PlansSection onToast={showToast} />
      </div>
    </DashboardLayout>
  )
}

// ── Aussteller / Bank / Nummernkreis ─────────────────────────────────────────────
function IssuerSection({ onToast }: { onToast: (m: string) => void }) {
  const [s, setS] = useState<TSettings | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void (async () => { const { data } = await supabase.from('invoice_settings').select('*').eq('id', true).maybeSingle(); setS(data as TSettings) })() }, [])
  if (!s) return <div className={cardCls}><p className="text-sm text-gray-400">Lädt…</p></div>
  const set = (patch: Partial<TSettings>) => setS(prev => prev ? { ...prev, ...patch } : prev)
  const F = (k: keyof TSettings, label: string) => (
    <div><label className={labelCls}>{label}</label><input className={inputCls} value={(s[k] as string) ?? ''} onChange={e => set({ [k]: e.target.value } as Partial<TSettings>)} /></div>
  )
  const save = async () => {
    setBusy(true)
    const { id, updated_at, ...patch } = s; void id; void updated_at
    const { error } = await supabase.from('invoice_settings').update(patch).eq('id', true)
    setBusy(false)
    onToast(error ? `❌ ${error.message}` : '✅ Aussteller gespeichert')
  }
  return (
    <div className={cardCls}>
      <h2 className="font-heading text-lg text-gray-900 mb-4">Aussteller & Bank</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {F('brand_name', 'Marke (angezeigt)')}
        {F('legal_name', 'Rechtlicher Name')}
        {F('address_line1', 'Adresse')}
        <div className="grid grid-cols-2 gap-3">{F('postal_code', 'PLZ')}{F('city', 'Stadt')}</div>
        {F('vat_number', 'VAT-Nummer')}
        {F('reg_number', 'Reg.-Nr. (HE)')}
        {F('email', 'E-Mail')}
        {F('bank_name', 'Bank')}
        {F('iban', 'IBAN')}
        {F('bic', 'BIC')}
        {F('intermediary_bic', 'Intermediary BIC')}
        {F('logo_url', 'Logo-URL')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <div><label className={labelCls}>Rechnungs-Präfix</label><input className={inputCls} value={s.invoice_prefix} onChange={e => set({ invoice_prefix: e.target.value })} /></div>
        <div><label className={labelCls}>Nächste Nummer</label><NumberStepper value={s.next_number} onChange={v => set({ next_number: Math.round(v) })} min={1} /></div>
        <div><label className={labelCls}>Zahlungsziel (Tage)</label><NumberStepper value={s.default_due_days} onChange={v => set({ default_due_days: Math.round(v) })} min={0} /></div>
      </div>
      <label className="flex items-center gap-2.5 mt-4 cursor-pointer select-none">
        <input type="checkbox" checked={s.auto_send_deposit} onChange={e => set({ auto_send_deposit: e.target.checked })} className="w-4 h-4 accent-orange-500" />
        <span className="text-sm text-gray-700">Anzahlungs-Rechnungen ohne Bestätigung direkt senden (volle Automatik)</span>
      </label>
      <div className="flex justify-end mt-4">
        <button onClick={save} disabled={busy} className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>{busy ? 'Speichert…' : 'Speichern'}</button>
      </div>
    </div>
  )
}

// ── Kunden ───────────────────────────────────────────────────────────────────────
function CustomersSection({ onToast }: { onToast: (m: string) => void }) {
  const [items, setItems] = useState<InvoiceCustomer[]>([])
  const [editing, setEditing] = useState<InvoiceCustomer | 'new' | null>(null)
  const fetchAll = useCallback(async () => { const { data } = await supabase.from('invoice_customers').select('*').order('company_name'); setItems((data ?? []) as InvoiceCustomer[]) }, [])
  useEffect(() => { fetchAll() }, [fetchAll])
  const del = async (c: InvoiceCustomer) => { if (!window.confirm(`${c.company_name} löschen?`)) return; await supabase.from('invoice_customers').delete().eq('id', c.id); onToast('Kunde gelöscht'); fetchAll() }
  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-heading text-lg text-gray-900">Kunden (Empfänger)</h2>
        <button onClick={() => setEditing('new')} className="text-sm font-medium text-orange-600 hover:text-orange-800">+ Kunde</button>
      </div>
      <div className="space-y-2">
        {items.map(c => (
          <div key={c.id} className="flex items-center justify-between border border-gray-100 rounded-xl px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><span className="font-medium text-sm text-gray-800 truncate">{c.company_name}</span>{c.is_default && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">Standard</span>}</div>
              <p className="text-xs text-gray-400 truncate">{[c.contact_name, c.email, c.vat_number].filter(Boolean).join(' · ') || '—'}</p>
            </div>
            <div className="flex gap-2 text-xs shrink-0">
              <button onClick={() => setEditing(c)} className="text-gray-500 hover:text-gray-800 font-medium">Bearbeiten</button>
              <button onClick={() => del(c)} className="text-red-500 hover:text-red-700 font-medium">Löschen</button>
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="text-sm text-gray-400">Noch keine Kunden.</p>}
      </div>
      {editing && <CustomerModal customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); onToast(m); fetchAll() }} />}
    </div>
  )
}

function CustomerModal({ customer, onClose, onSaved }: { customer: InvoiceCustomer | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [f, setF] = useState({
    company_name: customer?.company_name ?? '', contact_name: customer?.contact_name ?? '',
    address_line1: customer?.address_line1 ?? '', address_line2: customer?.address_line2 ?? '',
    postal_code: customer?.postal_code ?? '', city: customer?.city ?? '', country: customer?.country ?? 'Cyprus',
    vat_number: customer?.vat_number ?? '', email: customer?.email ?? '',
    country_mode: (customer?.country_mode ?? 'cyprus') as CustomerMode, is_default: customer?.is_default ?? false,
  })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const set = (patch: Partial<typeof f>) => setF(prev => ({ ...prev, ...patch }))
  const save = async () => {
    if (!f.company_name.trim()) { setErr('Firmenname ist Pflicht.'); return }
    setBusy(true); setErr('')
    const payload = { ...f, company_name: f.company_name.trim(), updated_at: new Date().toISOString() }
    const { error } = customer
      ? await supabase.from('invoice_customers').update(payload).eq('id', customer.id)
      : await supabase.from('invoice_customers').insert(payload)
    if (error) { setErr(error.message); setBusy(false); return }
    onSaved(customer ? 'Kunde gespeichert' : 'Kunde angelegt')
  }
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-6" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{customer ? 'Kunde bearbeiten' : 'Neuer Kunde'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="px-6 py-5 space-y-3">
          <div><label className={labelCls}>Firmenname *</label><input className={inputCls} value={f.company_name} onChange={e => set({ company_name: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>Ansprechpartner</label><input className={inputCls} value={f.contact_name} onChange={e => set({ contact_name: e.target.value })} /></div>
            <div><label className={labelCls}>E-Mail</label><input className={inputCls} value={f.email} onChange={e => set({ email: e.target.value })} /></div>
          </div>
          <div><label className={labelCls}>Adresse</label><input className={inputCls} value={f.address_line1} onChange={e => set({ address_line1: e.target.value })} /></div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className={labelCls}>PLZ</label><input className={inputCls} value={f.postal_code} onChange={e => set({ postal_code: e.target.value })} /></div>
            <div><label className={labelCls}>Stadt</label><input className={inputCls} value={f.city} onChange={e => set({ city: e.target.value })} /></div>
            <div><label className={labelCls}>Land</label><input className={inputCls} value={f.country} onChange={e => set({ country: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>VAT-Nummer</label><input className={inputCls} value={f.vat_number} onChange={e => set({ vat_number: e.target.value })} /></div>
            <div>
              <label className={labelCls}>Steuer-Region (MwSt-Standard)</label>
              <CustomSelect value={f.country_mode} onChange={v => set({ country_mode: v as CustomerMode })}
                options={[{ value: 'cyprus', label: 'Zypern (19%)' }, { value: 'eu', label: 'EU (Reverse Charge)' }, { value: 'third', label: 'Drittland (0%)' }]} />
            </div>
          </div>
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={f.is_default} onChange={e => set({ is_default: e.target.checked })} className="w-4 h-4 accent-orange-500" />
            <span className="text-sm text-gray-700">Standard-Empfänger (z.B. Burkhard / Reeaals)</span>
          </label>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">Abbrechen</button>
          <button onClick={save} disabled={busy} className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>{busy ? 'Speichert…' : 'Speichern'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Artikel ──────────────────────────────────────────────────────────────────────
function ArticlesSection({ onToast }: { onToast: (m: string) => void }) {
  const [items, setItems] = useState<InvoiceArticle[]>([])
  const [name, setName] = useState(''); const [unit, setUnit] = useState('Pauschal'); const [price, setPrice] = useState(0)
  const fetchAll = useCallback(async () => { const { data } = await supabase.from('invoice_articles').select('*').order('name'); setItems((data ?? []) as InvoiceArticle[]) }, [])
  useEffect(() => { fetchAll() }, [fetchAll])
  const add = async () => { if (!name.trim()) return; const { error } = await supabase.from('invoice_articles').insert({ name: name.trim(), unit, net_price: price }); if (error) { onToast(`❌ ${error.message}`); return } setName(''); setPrice(0); onToast('Artikel angelegt'); fetchAll() }
  const del = async (a: InvoiceArticle) => { await supabase.from('invoice_articles').delete().eq('id', a.id); onToast('Artikel gelöscht'); fetchAll() }
  return (
    <div className={cardCls}>
      <h2 className="font-heading text-lg text-gray-900 mb-3">Artikel</h2>
      <div className="space-y-2 mb-3">
        {items.map(a => (
          <div key={a.id} className="flex items-center justify-between border border-gray-100 rounded-xl px-3 py-2.5">
            <div><span className="font-medium text-sm text-gray-800">{a.name}</span><span className="text-xs text-gray-400 ml-2">{eurFmt(a.net_price)} · {a.unit}</span></div>
            <button onClick={() => del(a)} className="text-xs text-red-500 hover:text-red-700 font-medium">Löschen</button>
          </div>
        ))}
        {items.length === 0 && <p className="text-sm text-gray-400">Noch keine Artikel.</p>}
      </div>
      <div className="flex gap-2 items-end">
        <div className="flex-1"><label className={labelCls}>Name</label><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="z.B. Beratung" /></div>
        <div className="w-32"><label className={labelCls}>Einheit</label><input className={inputCls} value={unit} onChange={e => setUnit(e.target.value)} /></div>
        <div className="w-32"><label className={labelCls}>Netto</label><NumberStepper value={price} onChange={setPrice} step={100} min={0} suffix="€" /></div>
        <button onClick={add} className="px-4 py-2.5 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: '#ff795d' }}>+</button>
      </div>
    </div>
  )
}

// ── Abopläne ─────────────────────────────────────────────────────────────────────
function PlansSection({ onToast }: { onToast: (m: string) => void }) {
  const [items, setItems] = useState<SubscriptionPlan[]>([])
  const [name, setName] = useState(''); const [interval, setInterval] = useState<PlanInterval>('monthly'); const [price, setPrice] = useState(0)
  const fetchAll = useCallback(async () => { const { data } = await supabase.from('subscription_plans').select('*').order('name'); setItems((data ?? []) as SubscriptionPlan[]) }, [])
  useEffect(() => { fetchAll() }, [fetchAll])
  const add = async () => { if (!name.trim()) return; const { error } = await supabase.from('subscription_plans').insert({ name: name.trim(), interval, net_price: price }); if (error) { onToast(`❌ ${error.message}`); return } setName(''); setPrice(0); onToast('Aboplan angelegt'); fetchAll() }
  const del = async (p: SubscriptionPlan) => { await supabase.from('subscription_plans').delete().eq('id', p.id); onToast('Aboplan gelöscht'); fetchAll() }
  return (
    <div className={cardCls}>
      <h2 className="font-heading text-lg text-gray-900 mb-3">Abopläne</h2>
      <div className="space-y-2 mb-3">
        {items.map(p => (
          <div key={p.id} className="flex items-center justify-between border border-gray-100 rounded-xl px-3 py-2.5">
            <div><span className="font-medium text-sm text-gray-800">{p.name}</span><span className="text-xs text-gray-400 ml-2">{eurFmt(p.net_price)} · {PLAN_LABEL[p.interval]}</span></div>
            <button onClick={() => del(p)} className="text-xs text-red-500 hover:text-red-700 font-medium">Löschen</button>
          </div>
        ))}
        {items.length === 0 && <p className="text-sm text-gray-400">Noch keine Abopläne.</p>}
      </div>
      <div className="flex gap-2 items-end">
        <div className="flex-1"><label className={labelCls}>Name</label><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="z.B. CRM-Wartung" /></div>
        <div className="w-40"><label className={labelCls}>Intervall</label>
          <CustomSelect value={interval} onChange={v => setInterval(v as PlanInterval)}
            options={[{ value: 'monthly', label: 'monatlich' }, { value: 'quarterly', label: 'quartalsweise' }, { value: 'yearly', label: 'jährlich' }]} />
        </div>
        <div className="w-32"><label className={labelCls}>Netto</label><NumberStepper value={price} onChange={setPrice} step={50} min={0} suffix="€" /></div>
        <button onClick={add} className="px-4 py-2.5 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: '#ff795d' }}>+</button>
      </div>
    </div>
  )
}
