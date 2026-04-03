import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../components/DashboardLayout'
import { supabase } from '../lib/supabase'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { useAuth } from '../lib/auth'
import { useDateFormat } from '../lib/date'

// ── Types ──────────────────────────────────────────────────────
interface OwnerProfile {
  id: string
  full_name: string
  email: string
  phone: string | null
  address_street: string | null
  address_zip: string | null
  address_city: string | null
  address_country: string | null
  iban: string | null
  bic: string | null
  bank_account_holder: string | null
  language: string
  is_active: boolean
}

interface PropertyFull {
  id: string
  project_name: string
  unit_number: string | null
  type: 'villa' | 'apartment' | 'studio'
  bedrooms: number
  size_sqm: number | null
  is_furnished: boolean
  street: string | null
  house_number: string | null
  zip: string | null
  city: string | null
  description: string | null
  images: string[]
  rental_type: 'longterm' | 'shortterm'
  owner_id: string
  purchase_price_gross: number | null
  purchase_price_net: number | null
  vat_rate: number
  created_at: string
  owner: OwnerProfile | null
}

type DocType = 'mietvertrag' | 'rechnung' | 'sonstiges'

interface DocRecord {
  id: string
  type: DocType
  title: string
  file_url: string
  amount_net:     number | null
  amount_gross:   number | null
  creditor:       string | null
  uploaded_at:    string
  // Invoice-specific fields (added in migration 009)
  invoice_number: string | null
  invoice_date:   string | null
  due_date:       string | null
  paid_at:        string | null
  description:    string | null
  creditor_iban:  string | null
  notes:          string | null
  vat_rate:       number | null
}

interface ContractRecord {
  id: string
  tenant_name: string
  tenant_email: string
  start_date: string
  end_date: string | null
  monthly_rent: number
  status: 'draft' | 'sent' | 'signed'
  signature_token: string
  signed_at: string | null
}

type TabKey = 'overview' | 'contracts' | 'invoices' | 'income' | 'images'

type InvoiceSortField = 'date' | 'creditor' | 'amount'

interface DocUploadForm {
  type: DocType
  title: string
  file: File | null
  amount_net: string
  amount_gross: string
  creditor: string
}

const EMPTY_DOC_FORM: DocUploadForm = {
  type: 'sonstiges', title: '', file: null,
  amount_net: '', amount_gross: '', creditor: '',
}

const MAX_PDF = 50 * 1024 * 1024

function sanitize(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-')
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-')
}

// ── Toast ──────────────────────────────────────────────────────
function Toast({ msg, type = 'success', onClose }: {
  msg: string; type?: 'success' | 'error'; onClose: () => void
}) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t) }, [onClose])
  return (
    <div className={`fixed bottom-6 right-6 z-50 text-sm font-body px-5 py-3 rounded-xl shadow-lg max-w-sm
      ${type === 'error' ? 'bg-red-600 text-white' : 'bg-hp-black text-white'}`}>
      {msg}
    </div>
  )
}

// ── Stat Item ──────────────────────────────────────────────────
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-gray-50 rounded-xl px-4 py-3">
      <div className="text-xs text-gray-400 font-body mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-hp-black font-body">{value || '—'}</div>
    </div>
  )
}

// ── Badge ──────────────────────────────────────────────────────
function Badge({ children, color = 'gray' }: { children: React.ReactNode; color?: string }) {
  const cls: Record<string, string> = {
    gray:   'bg-gray-100 text-gray-600',
    blue:   'bg-blue-50 text-blue-700',
    orange: 'bg-orange-50 text-orange-700',
    green:  'bg-green-50 text-green-700',
    purple: 'bg-purple-50 text-purple-700',
    amber:  'bg-amber-50 text-amber-700',
  }
  return (
    <span className={`inline-block text-xs font-semibold font-body px-2.5 py-1 rounded-full ${cls[color] ?? cls.gray}`}>
      {children}
    </span>
  )
}

const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-hp-black text-sm font-body focus:outline-none focus:ring-2 focus:border-transparent transition'
const focusRing = () => ({ '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties)

// ── Invoice types & helpers ────────────────────────────────────
interface InvoiceFullForm {
  creditor:       string
  invoice_number: string
  invoice_date:   string
  due_date:       string
  paid_at:        string
  amount_gross:   string
  vat_rate:       string
  amount_net:     string
  description:    string
  creditor_iban:  string
  notes:          string
  file:           File | null
}

const EMPTY_INVOICE: InvoiceFullForm = {
  creditor: '', invoice_number: '', invoice_date: '', due_date: '', paid_at: '',
  amount_gross: '', vat_rate: '19', amount_net: '', description: '',
  creditor_iban: '', notes: '', file: null,
}

function invoiceStatus(doc: DocRecord): 'paid' | 'overdue' | 'open' {
  if (doc.paid_at) return 'paid'
  if (doc.due_date && new Date(doc.due_date) < new Date()) return 'overdue'
  return 'open'
}

function docToInvoiceForm(doc: DocRecord): InvoiceFullForm {
  return {
    creditor:       doc.creditor       ?? '',
    invoice_number: doc.invoice_number ?? '',
    invoice_date:   doc.invoice_date   ?? '',
    due_date:       doc.due_date       ?? '',
    paid_at:        doc.paid_at        ?? '',
    amount_gross:   doc.amount_gross   != null ? String(doc.amount_gross)  : '',
    vat_rate:       doc.vat_rate       != null ? String(doc.vat_rate)      : '19',
    amount_net:     doc.amount_net     != null ? String(doc.amount_net)    : '',
    description:    doc.description    ?? '',
    creditor_iban:  doc.creditor_iban  ?? '',
    notes:          doc.notes          ?? '',
    file:           null,
  }
}

function buildInvoiceTitle(form: Pick<InvoiceFullForm, 'creditor' | 'invoice_number'>): string {
  if (form.creditor && form.invoice_number) return `${form.creditor} – ${form.invoice_number}`
  return form.creditor || form.invoice_number || 'Rechnung'
}

function calcNet(gross: string, vat: string): string {
  const g = parseFloat(gross.replace(',', '.'))
  const r = parseFloat(vat.replace(',', '.'))
  if (!isNaN(g) && !isNaN(r) && r >= 0) return (g / (1 + r / 100)).toFixed(2)
  return ''
}

async function analyzeInvoicePDF(file: File): Promise<Partial<InvoiceFullForm> | null> {
  // PDF → base64 (data-URL-Präfix abschneiden)
  const pdfBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve((e.target!.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

  // Supabase Edge Function als Proxy (kein CORS, API-Key serverseitig)
  const { data, error } = await supabase.functions.invoke('analyze-invoice', {
    body: { pdfBase64 },
  })

  if (error) throw new Error(error.message)

  const parsed = data as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object') return null

  const s = (v: unknown) => (v != null && v !== '' && v !== 'null' ? String(v) : undefined)
  const result: Partial<InvoiceFullForm> = {}
  if (s(parsed.kreditor))            result.creditor       = s(parsed.kreditor)!
  if (s(parsed.rechnungsnummer))     result.invoice_number = s(parsed.rechnungsnummer)!
  if (s(parsed.rechnungsdatum))      result.invoice_date   = s(parsed.rechnungsdatum)!
  if (s(parsed.faelligkeitsdatum))   result.due_date       = s(parsed.faelligkeitsdatum)!
  if (parsed.betrag_brutto  != null) result.amount_gross   = String(parsed.betrag_brutto)
  if (parsed.betrag_netto   != null) result.amount_net     = String(parsed.betrag_netto)
  if (parsed.mwst_satz      != null) result.vat_rate       = String(parsed.mwst_satz)
  if (s(parsed.beschreibung))        result.description    = s(parsed.beschreibung)!
  if (s(parsed.kreditor_iban))       result.creditor_iban  = s(parsed.kreditor_iban)!

  return Object.keys(result).length > 0 ? result : null
}

// ── InvoiceModal ───────────────────────────────────────────────
interface InvoiceModalProps {
  doc:        DocRecord | null   // null = new invoice
  propertyId: string
  uploadedBy: string
  onClose:    () => void
  onSaved:    (msg: string) => void
}

function InvoiceModal({ doc, propertyId, uploadedBy, onClose, onSaved }: InvoiceModalProps) {
  const { t }   = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)

  const [form, setForm]               = useState<InvoiceFullForm>(doc ? docToInvoiceForm(doc) : { ...EMPTY_INVOICE })
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [aiFilledFields, setAiFilledFields] = useState<Set<keyof InvoiceFullForm>>(new Set())
  const [aiError, setAiError]         = useState(false)
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const isEditing = doc != null

  function setField(k: keyof InvoiceFullForm, v: string) {
    setForm(f => ({ ...f, [k]: v }))
    setAiFilledFields(s => { const n = new Set(s); n.delete(k); return n })
  }

  function onGrossChange(v: string) {
    setField('amount_gross', v)
    const net = calcNet(v, form.vat_rate)
    if (net) setField('amount_net', net)
  }

  function onVatChange(v: string) {
    setField('vat_rate', v)
    const net = calcNet(form.amount_gross, v)
    if (net) setField('amount_net', net)
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || file.type !== 'application/pdf' || file.size > MAX_PDF) return

    setForm(f => ({ ...f, file }))
    setAiError(false)
    setAiAnalyzing(true)
    setAiFilledFields(new Set())

    try {
      const filled = await analyzeInvoicePDF(file)
      if (filled && Object.keys(filled).length > 0) {
        // Recalculate net if gross and vat were both found
        const newGross = filled.amount_gross ?? form.amount_gross
        const newVat   = filled.vat_rate    ?? form.vat_rate
        if (filled.amount_gross && !filled.amount_net) {
          filled.amount_net = calcNet(newGross, newVat) || filled.amount_net
        }
        setForm(f => ({ ...f, file, ...filled }))
        setAiFilledFields(new Set(Object.keys(filled) as Array<keyof InvoiceFullForm>))
      } else {
        setAiError(true)
      }
    } catch {
      setAiError(true)
    } finally {
      setAiAnalyzing(false)
    }
  }

  async function handleSave() {
    if (!form.creditor.trim()) {
      setError(t('errors.required', { field: t('documents.creditor') }))
      return
    }
    if (!form.amount_gross) {
      setError(t('errors.required', { field: t('documents.amountGross') }))
      return
    }
    if (!isEditing && !form.file) {
      setError(t('errors.required', { field: t('documents.file') }))
      return
    }

    setSaving(true)
    setError('')
    try {
      let fileUrl = doc?.file_url ?? ''

      if (form.file) {
        const rand = Math.random().toString(36).slice(2, 8)
        const path = `${propertyId}/${Date.now()}-${rand}-${sanitize(form.file.name)}`
        const { error: sErr } = await supabase.storage.from('documents').upload(path, form.file, { upsert: true })
        if (sErr) throw new Error(sErr.message)
        if (doc?.file_url) await supabase.storage.from('documents').remove([doc.file_url])
        fileUrl = path
      }

      const payload = {
        title:          buildInvoiceTitle(form),
        creditor:       form.creditor.trim()       || null,
        invoice_number: form.invoice_number.trim() || null,
        invoice_date:   form.invoice_date          || null,
        due_date:       form.due_date              || null,
        paid_at:        form.paid_at               || null,
        amount_gross:   form.amount_gross ? parseFloat(form.amount_gross.replace(',', '.'))  : null,
        vat_rate:       form.vat_rate     ? parseFloat(form.vat_rate.replace(',', '.'))      : null,
        amount_net:     form.amount_net   ? parseFloat(form.amount_net.replace(',', '.'))    : null,
        description:    form.description.trim()    || null,
        creditor_iban:  form.creditor_iban.trim()  || null,
        notes:          form.notes.trim()          || null,
        file_url:       fileUrl,
      }

      if (isEditing) {
        const { error: uErr } = await supabase.from('documents').update(payload).eq('id', doc!.id)
        if (uErr) throw new Error(uErr.message)
      } else {
        const { error: iErr } = await supabase.from('documents').insert({
          ...payload,
          property_id: propertyId,
          uploaded_by: uploadedBy,
          type: 'rechnung',
        })
        if (iErr) throw new Error(iErr.message)
      }

      onSaved(t(isEditing ? 'propertyDetail.invoices.saved' : 'success.uploaded'))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function inputClsAI(k: keyof InvoiceFullForm): string {
    return `${inputCls} ${aiFilledFields.has(k) ? '!bg-green-50 !border-green-300' : ''}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center
                    bg-black/40 backdrop-blur-sm px-4 py-8 overflow-y-auto"
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
            {isEditing ? t('propertyDetail.invoices.editTitle') : t('propertyDetail.invoices.uploadTitle')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[78vh] overflow-y-auto">

          {/* ── PDF Upload ─────────────────────────────────── */}
          <div>
            <label className="block text-sm font-medium text-hp-black font-body mb-1.5">
              {t('documents.file')}
              {!isEditing && <span className="text-red-500 ml-0.5"> *</span>}
              {isEditing && (
                <span className="text-gray-400 text-xs ml-2">({t('propertyDetail.invoices.replacePdf')})</span>
              )}
            </label>

            <div onClick={() => !aiAnalyzing && fileRef.current?.click()}
                 className={`border-2 border-dashed rounded-xl p-4 transition
                   ${aiAnalyzing ? 'cursor-wait' : 'cursor-pointer'}
                   ${form.file
                     ? 'border-green-300 bg-green-50'
                     : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white'}`}>
              <input ref={fileRef} type="file" accept="application/pdf"
                     className="hidden" onChange={handleFileChange} />
              {aiAnalyzing ? (
                <div className="flex items-center gap-3">
                  <span className="w-5 h-5 border-2 border-gray-200 border-t-orange-500 rounded-full animate-spin shrink-0" />
                  <p className="text-sm font-body text-gray-600">🤖 {t('propertyDetail.invoices.aiAnalyzing')}</p>
                </div>
              ) : form.file ? (
                <div className="flex items-center gap-3">
                  <span className="text-xl">📄</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold font-body text-gray-700 truncate">{form.file.name}</p>
                    <p className="text-xs text-gray-400 font-body">{(form.file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                  <button type="button"
                    onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, file: null })); if (fileRef.current) fileRef.current.value = '' }}
                    className="text-red-400 hover:text-red-600 text-lg shrink-0">✕</button>
                </div>
              ) : (
                <p className="text-sm text-gray-400 font-body text-center">PDF · max. 50 MB</p>
              )}
            </div>

            {aiFilledFields.size > 0 && !aiAnalyzing && (
              <p className="mt-1.5 text-xs text-green-600 font-body flex items-center gap-1.5">
                🤖 {t('propertyDetail.invoices.aiFilled')}
              </p>
            )}
            {aiError && (
              <p className="mt-1.5 text-xs text-amber-600 font-body flex items-center gap-1.5">
                ⚠️ {t('propertyDetail.invoices.aiError')}
              </p>
            )}
          </div>

          {/* ── Kreditor + Rechnungsnummer ─────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('documents.creditor')} <span className="text-red-400">*</span>
              </label>
              <input className={inputClsAI('creditor')} style={focusRing()}
                     value={form.creditor} onChange={e => setField('creditor', e.target.value)}
                     placeholder="Stadtwerke München" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('propertyDetail.invoices.invoiceNumber')}
              </label>
              <input className={inputClsAI('invoice_number')} style={focusRing()}
                     value={form.invoice_number} onChange={e => setField('invoice_number', e.target.value)}
                     placeholder="2024-0123" />
            </div>
          </div>

          {/* ── Rechnungsdatum + Fälligkeitsdatum ─────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('propertyDetail.invoices.invoiceDate')}
              </label>
              <input type="date" className={inputClsAI('invoice_date')} style={focusRing()}
                     value={form.invoice_date} onChange={e => setField('invoice_date', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('propertyDetail.invoices.dueDate')}
              </label>
              <input type="date" className={inputClsAI('due_date')} style={focusRing()}
                     value={form.due_date} onChange={e => setField('due_date', e.target.value)} />
            </div>
          </div>

          {/* ── Bezahlt am ────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('propertyDetail.invoices.paidAt')}
              </label>
              <input type="date" className={inputCls} style={focusRing()}
                     value={form.paid_at} onChange={e => setField('paid_at', e.target.value)} />
            </div>
          </div>

          {/* ── Betrag Brutto + MwSt + Netto ──────────────── */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('documents.amountGross')} <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">€</span>
                <input type="number" min="0" step="0.01"
                       className={`${inputClsAI('amount_gross')} pl-7`} style={focusRing()}
                       value={form.amount_gross} onChange={e => onGrossChange(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('propertyDetail.invoices.vatRate')}
              </label>
              <div className="relative">
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
                <input type="number" min="0" max="100" step="0.1"
                       className={`${inputClsAI('vat_rate')} pr-7`} style={focusRing()}
                       value={form.vat_rate} onChange={e => onVatChange(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('documents.amountNet')}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">€</span>
                <input type="number" min="0" step="0.01"
                       className={`${inputCls} pl-7 bg-gray-50`} style={focusRing()}
                       value={form.amount_net} onChange={e => setField('amount_net', e.target.value)}
                       placeholder="auto" />
              </div>
            </div>
          </div>

          {/* ── Beschreibung ──────────────────────────────── */}
          <div>
            <label className="block text-xs font-medium text-gray-500 font-body mb-1">
              {t('propertyDetail.invoices.description')}
            </label>
            <textarea rows={2}
                      className={`${inputClsAI('description')} resize-none`} style={focusRing()}
                      value={form.description} onChange={e => setField('description', e.target.value)}
                      placeholder={t('propertyDetail.invoices.descriptionPlaceholder')} />
          </div>

          {/* ── IBAN + Notizen ────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('propertyDetail.invoices.creditorIban')}
              </label>
              <input className={inputClsAI('creditor_iban')} style={focusRing()}
                     value={form.creditor_iban} onChange={e => setField('creditor_iban', e.target.value)}
                     placeholder="DE89 …" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('propertyDetail.invoices.notes')}
              </label>
              <input className={inputCls} style={focusRing()}
                     value={form.notes} onChange={e => setField('notes', e.target.value)}
                     placeholder={t('propertyDetail.invoices.notesPlaceholder')} />
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-500 bg-red-50 px-4 py-2 rounded-lg font-body">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-body text-gray-600
                             hover:border-gray-300 transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={handleSave} disabled={saving || aiAnalyzing}
                  className="px-5 py-2 rounded-xl text-white text-sm font-semibold font-body
                             hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-2"
                  style={{ backgroundColor: 'var(--color-highlight)' }}>
            {saving && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {saving ? `${t('common.save')} …` : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// PropertyDetail
// ══════════════════════════════════════════════════════════════
export default function PropertyDetail() {
  const { id }          = useParams<{ id: string }>()
  const navigate        = useNavigate()
  const { t }           = useTranslation()
  const { profile }     = useAuth()
  const { fmtDate, fmtCurrency, fmtNumber } = useDateFormat()

  const [property, setProperty]   = useState<PropertyFull | null>(null)
  const [loading, setLoading]     = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('overview')

  // All docs (mietvertrag + rechnung filtered in each tab)
  const [docs, setDocs]               = useState<DocRecord[]>([])
  const [docsLoading, setDocsLoading] = useState(false)

  // Contract tab: upload PDF as mietvertrag document
  const [showContractForm, setShowContractForm]     = useState(false)
  const [contractForm, setContractForm]             = useState<DocUploadForm>({ ...EMPTY_DOC_FORM, type: 'mietvertrag' })
  const [contractUploading, setContractUploading]   = useState(false)
  const [contractError, setContractError]           = useState('')
  const contractFileRef = useRef<HTMLInputElement>(null)

  // Invoice tab: modal state + sort + accordion
  const [invoiceModalOpen,   setInvoiceModalOpen]   = useState(false)
  const [invoiceModalDoc,    setInvoiceModalDoc]     = useState<DocRecord | null>(null)
  const [invoiceSortField,   setInvoiceSortField]   = useState<InvoiceSortField>('date')
  const [invoiceSortDir,     setInvoiceSortDir]     = useState<'asc' | 'desc'>('desc')
  const [expandedInvoiceId,  setExpandedInvoiceId]  = useState<string | null>(null)
  const [invoiceSignedUrls,  setInvoiceSignedUrls]  = useState<Record<string, string>>({})

  // Contracts
  const [contracts, setContracts]               = useState<ContractRecord[]>([])
  const [contractsLoading, setContractsLoading] = useState(false)
  const [linkCopied, setLinkCopied]             = useState<string | null>(null)

  // Images tab
  const [imgDragOver, setImgDragOver]         = useState(false)
  const [imgPendingFiles, setImgPendingFiles] = useState<File[]>([])
  const [imgPreviews, setImgPreviews]         = useState<string[]>([])
  const [imgUploading, setImgUploading]       = useState(false)
  const [deleteImgUrl, setDeleteImgUrl]       = useState<string | null>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)

  // Toast
  const [toast, setToast] = useState<{ msg: string; type?: 'success' | 'error' } | null>(null)

  // Owner accordion
  const [ownerOpen, setOwnerOpen]       = useState(false)
  const [showIban, setShowIban]         = useState(false)
  const [ownerEditOpen, setOwnerEditOpen] = useState(false)
  const [ownerForm, setOwnerForm]       = useState<{
    firstName: string; lastName: string; phone: string
    language: string
    address_street: string; address_zip: string; address_city: string; address_country: string
    iban: string; bic: string; bank_account_holder: string
  } | null>(null)
  const [ownerSaving, setOwnerSaving]   = useState(false)
  const [ownerError, setOwnerError]     = useState('')

  const canEdit = profile?.role === 'admin' || profile?.role === 'verwalter'
  const basePath = `/${profile?.role ?? 'eigentuemer'}/dashboard`

  // ── Fetch property ───────────────────────────────────────
  const fetchProperty = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const { data } = await supabase
        .from('properties')
        .select('*, owner:owner_id(id, full_name, email, phone, address_street, address_zip, address_city, address_country, iban, bic, bank_account_holder, language, is_active)')
        .eq('id', id)
        .single()
      setProperty(data as PropertyFull ?? null)
    } catch (err) {
      console.error('[PropertyDetail] fetchProperty:', err)
    } finally {
      setLoading(false)
    }
  }, [id])

  // ── Fetch documents ──────────────────────────────────────
  const fetchDocs = useCallback(async () => {
    if (!id) return
    setDocsLoading(true)
    const { data } = await supabase
      .from('documents')
      .select('id, type, title, file_url, amount_net, amount_gross, creditor, uploaded_at, invoice_number, invoice_date, due_date, paid_at, description, creditor_iban, notes, vat_rate')
      .eq('property_id', id)
      .order('uploaded_at', { ascending: false })
    setDocs((data as DocRecord[]) ?? [])
    setDocsLoading(false)
  }, [id])

  // ── Fetch contracts ──────────────────────────────────────
  const fetchContracts = useCallback(async () => {
    if (!id) return
    setContractsLoading(true)
    const { data } = await supabase
      .from('contracts')
      .select('id, tenant_name, tenant_email, start_date, end_date, monthly_rent, status, signature_token, signed_at')
      .eq('property_id', id)
      .order('start_date', { ascending: false })
    setContracts((data as ContractRecord[]) ?? [])
    setContractsLoading(false)
  }, [id])

  useEffect(() => {
    fetchProperty()
    fetchDocs()
    fetchContracts()
  }, [fetchProperty, fetchDocs, fetchContracts])

  // ── Generic doc upload ───────────────────────────────────
  async function uploadDoc(
    form: DocUploadForm,
    setUploading: (v: boolean) => void,
    setError: (v: string) => void,
    resetForm: () => void,
  ) {
    if (!profile || !id || !form.title || !form.file) return
    setUploading(true)
    setError('')
    const rand = Math.random().toString(36).slice(2, 8)
    const path = `${id}/${Date.now()}-${rand}-${sanitize(form.file.name)}`
    try {
      const { error: sErr } = await supabase.storage
        .from('documents').upload(path, form.file, { upsert: true })
      if (sErr) throw new Error(sErr.message)
      const { error: dErr } = await supabase.from('documents').insert({
        property_id:  id,
        uploaded_by:  profile.id,
        type:         form.type,
        title:        form.title.trim(),
        file_url:     path,
        amount_net:   form.amount_net   ? parseFloat(form.amount_net.replace(',', '.'))   : null,
        amount_gross: form.amount_gross ? parseFloat(form.amount_gross.replace(',', '.'))  : null,
        creditor:     form.creditor.trim() || null,
      })
      if (dErr) {
        await supabase.storage.from('documents').remove([path])
        throw new Error(dErr.message)
      }
      resetForm()
      setToast({ msg: t('success.uploaded') })
      fetchDocs()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  async function openDoc(filePath: string) {
    const { data, error } = await supabase.storage
      .from('documents').createSignedUrl(filePath, 3600)
    if (error || !data?.signedUrl) { setToast({ msg: t('errors.serverError'), type: 'error' }); return }
    window.open(data.signedUrl, '_blank')
  }

  async function downloadDoc(filePath: string, title: string) {
    const { data, error } = await supabase.storage
      .from('documents').createSignedUrl(filePath, 60)
    if (error || !data?.signedUrl) { setToast({ msg: t('errors.serverError'), type: 'error' }); return }
    const a = document.createElement('a'); a.href = data.signedUrl; a.download = `${title}.pdf`; a.click()
  }

  async function deleteDoc(doc: DocRecord) {
    if (!window.confirm(t('documents.deleteConfirm'))) return
    await supabase.storage.from('documents').remove([doc.file_url])
    await supabase.from('documents').delete().eq('id', doc.id)
    setToast({ msg: t('success.deleted') })
    fetchDocs()
  }

  // ── Contract sign-link helper ─────────────────────────────
  async function copySignLink(token: string) {
    const url = `${window.location.origin}/sign/${token}`
    try {
      await navigator.clipboard.writeText(url)
      setLinkCopied(token)
      setTimeout(() => setLinkCopied(null), 2000)
    } catch { setToast({ msg: t('errors.serverError'), type: 'error' }) }
  }

  function contractStatusColor(status: string): string {
    return status === 'signed' ? 'green' : status === 'sent' ? 'blue' : 'gray'
  }

  // ── Invoice sort helper ───────────────────────────────────
  function toggleSort(field: InvoiceSortField) {
    if (invoiceSortField === field) {
      setInvoiceSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setInvoiceSortField(field)
      setInvoiceSortDir('desc')
    }
  }

  function sortedInvoices(list: DocRecord[]): DocRecord[] {
    return [...list].sort((a, b) => {
      let cmp = 0
      if (invoiceSortField === 'date') {
        const aDate = a.invoice_date ?? a.uploaded_at
        const bDate = b.invoice_date ?? b.uploaded_at
        cmp = aDate.localeCompare(bDate)
      } else if (invoiceSortField === 'creditor') {
        cmp = (a.creditor ?? '').localeCompare(b.creditor ?? '')
      } else {
        const av = a.amount_gross ?? a.amount_net ?? 0
        const bv = b.amount_gross ?? b.amount_net ?? 0
        cmp = av - bv
      }
      return invoiceSortDir === 'asc' ? cmp : -cmp
    })
  }

  // ── Image upload helpers ──────────────────────────────────
  function addImageFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (!arr.length) return
    setImgPendingFiles(p => [...p, ...arr])
    arr.forEach(f => {
      const reader = new FileReader()
      reader.onload = e => {
        if (e.target?.result) setImgPreviews(p => [...p, e.target!.result as string])
      }
      reader.readAsDataURL(f)
    })
  }

  async function uploadPendingImages() {
    if (!id || !imgPendingFiles.length) return
    setImgUploading(true)
    try {
      const urls = (await Promise.all(
        imgPendingFiles.map(async file => {
          const rand = Math.random().toString(36).slice(2, 8)
          const path = `${id}/${Date.now()}-${rand}-${sanitizeFilename(file.name)}`
          const { error } = await supabase.storage
            .from('property-images').upload(path, file, { upsert: true })
          if (error) return null
          const { data: pub } = supabase.storage.from('property-images').getPublicUrl(path)
          return pub.publicUrl
        })
      )).filter((u): u is string => u !== null)

      const finalImages = [...(property?.images ?? []), ...urls]
      const { error } = await supabase.from('properties')
        .update({ images: finalImages }).eq('id', id)
      if (error) throw error
      setImgPendingFiles([])
      setImgPreviews([])
      setToast({ msg: t('success.saved') })
      fetchProperty()
    } catch {
      setToast({ msg: t('errors.saveFailed'), type: 'error' })
    } finally {
      setImgUploading(false)
    }
  }

  async function confirmDeleteImage() {
    if (!deleteImgUrl || !id || !property) return
    const url = deleteImgUrl
    setDeleteImgUrl(null)
    // Extract storage path from public URL
    const pathPart = url.split('/property-images/')[1]
    if (pathPart) {
      await supabase.storage.from('property-images').remove([pathPart])
    }
    const newImages = property.images.filter(u => u !== url)
    await supabase.from('properties').update({ images: newImages }).eq('id', id)
    setToast({ msg: t('success.deleted') })
    fetchProperty()
  }

  // ── Helpers ───────────────────────────────────────────────
  function addressStr(p: PropertyFull) {
    const street = [p.street, p.house_number].filter(Boolean).join(' ')
    const city   = [p.zip, p.city].filter(Boolean).join(' ')
    return [street, city].filter(Boolean).join(', ')
  }

  // ── IBAN mask ─────────────────────────────────────────────
  function maskIban(iban: string): string {
    const clean = iban.replace(/\s/g, '')
    if (clean.length < 6) return iban
    const start = clean.slice(0, 4)
    const end   = clean.slice(-2)
    const stars = '*'.repeat(Math.max(0, clean.length - 6))
    // group into 4s
    const raw = `${start}${stars}${end}`
    return raw.match(/.{1,4}/g)?.join(' ') ?? raw
  }

  function openOwnerEdit(owner: OwnerProfile) {
    const parts = owner.full_name.split(' ')
    setOwnerForm({
      firstName:           parts[0] ?? '',
      lastName:            parts.slice(1).join(' '),
      phone:               owner.phone ?? '',
      language:            owner.language ?? 'de',
      address_street:      owner.address_street ?? '',
      address_zip:         owner.address_zip ?? '',
      address_city:        owner.address_city ?? '',
      address_country:     owner.address_country ?? 'Deutschland',
      iban:                owner.iban ?? '',
      bic:                 owner.bic ?? '',
      bank_account_holder: owner.bank_account_holder ?? '',
    })
    setOwnerError('')
    setOwnerEditOpen(true)
  }

  async function saveOwner(owner: OwnerProfile) {
    if (!ownerForm) return
    setOwnerSaving(true)
    setOwnerError('')
    try {
      const full_name = `${ownerForm.firstName.trim()} ${ownerForm.lastName.trim()}`
      const { error } = await supabaseAdmin.from('profiles').update({
        full_name,
        phone:               ownerForm.phone.trim() || null,
        language:            ownerForm.language,
        address_street:      ownerForm.address_street.trim() || null,
        address_zip:         ownerForm.address_zip.trim() || null,
        address_city:        ownerForm.address_city.trim() || null,
        address_country:     ownerForm.address_country.trim() || null,
        iban:                ownerForm.iban.trim() || null,
        bic:                 ownerForm.bic.trim() || null,
        bank_account_holder: ownerForm.bank_account_holder.trim() || null,
      }).eq('id', owner.id)
      if (error) throw new Error(error.message)
      setOwnerEditOpen(false)
      setToast({ msg: t('success.saved') })
      fetchProperty()
    } catch (e) {
      setOwnerError(e instanceof Error ? e.message : t('errors.saveFailed'))
    } finally {
      setOwnerSaving(false)
    }
  }

  function sortIcon(field: InvoiceSortField) {
    if (invoiceSortField !== field) return <span className="text-gray-300 ml-1">↕</span>
    return <span className="ml-1" style={{ color: 'var(--color-highlight)' }}>{invoiceSortDir === 'asc' ? '↑' : '↓'}</span>
  }

  // ── PDF upload sub-form ───────────────────────────────────
  function renderDocUploadForm({
    form, setForm, uploading, error, fileRef, onSubmit, onCancel, titleKey,
  }: {
    form: DocUploadForm
    setForm: React.Dispatch<React.SetStateAction<DocUploadForm>>
    uploading: boolean
    error: string
    fileRef: React.RefObject<HTMLInputElement>
    onSubmit: () => void
    onCancel: () => void
    titleKey: string
  }) {
    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0]
      if (!file) return
      if (file.type !== 'application/pdf') {
        setForm(f => ({ ...f, file: null }))
        e.target.value = ''
        return
      }
      if (file.size > MAX_PDF) {
        e.target.value = ''
        return
      }
      setForm(f => ({ ...f, file, title: f.title || file.name.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ') }))
    }

    return (
      <div className="mt-3 bg-white border border-gray-100 rounded-2xl p-5 shadow-sm space-y-4">
        <p className="text-sm font-semibold text-hp-black font-body">{t(titleKey)}</p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-hp-black font-body mb-1.5">
              {t('documents.titleField')} <span className="text-red-500">*</span>
            </label>
            <input className={inputCls} style={focusRing()}
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder={t('documents.titleField')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-hp-black font-body mb-1.5">
              {t('documents.creditor')}
            </label>
            <input className={inputCls} style={focusRing()}
              value={form.creditor}
              onChange={e => setForm(f => ({ ...f, creditor: e.target.value }))}
              placeholder={form.type === 'mietvertrag' ? t('propertyDetail.contracts.tenantPlaceholder') : 'Stadtwerke …'} />
          </div>
        </div>

        {form.type === 'rechnung' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('documents.amountGross')}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">€</span>
                <input type="number" min="0" step="0.01"
                  className={`${inputCls} pl-7`} style={focusRing()}
                  value={form.amount_gross}
                  onChange={e => setForm(f => ({ ...f, amount_gross: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 font-body mb-1">
                {t('documents.amountNet')}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">€</span>
                <input type="number" min="0" step="0.01"
                  className={`${inputCls} pl-7`} style={focusRing()}
                  value={form.amount_net}
                  onChange={e => setForm(f => ({ ...f, amount_net: e.target.value }))} />
              </div>
            </div>
          </div>
        )}

        {/* PDF drop zone */}
        <div>
          <label className="block text-sm font-medium text-hp-black font-body mb-1.5">
            {t('documents.file')} <span className="text-red-500">*</span>
          </label>
          <div
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-4 cursor-pointer transition
                        ${form.file
                          ? 'border-green-300 bg-green-50'
                          : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white'}`}>
            <input ref={fileRef} type="file" accept="application/pdf"
              className="hidden" onChange={handleFileChange} />
            {form.file ? (
              <div className="flex items-center gap-3">
                <span className="text-xl">📄</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold font-body text-gray-700 truncate">{form.file.name}</p>
                  <p className="text-xs text-gray-400 font-body">{(form.file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                <button type="button"
                  onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, file: null })); if (fileRef.current) fileRef.current.value = '' }}
                  className="text-red-400 hover:text-red-600 text-lg shrink-0">✕</button>
              </div>
            ) : (
              <p className="text-sm text-gray-400 font-body text-center">PDF · max. 50 MB</p>
            )}
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-500 bg-red-50 px-4 py-2 rounded-lg font-body">{error}</p>
        )}

        <div className="flex justify-end gap-3">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold
                       font-body text-gray-600 hover:border-gray-300 transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={onSubmit}
            disabled={uploading || !form.title || !form.file}
            className="px-5 py-2 rounded-xl text-white text-sm font-semibold font-body
                       hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-2"
            style={{ backgroundColor: 'var(--color-highlight)' }}>
            {uploading && (
              <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            )}
            {uploading ? t('documents.uploading') : t('documents.upload')}
          </button>
        </div>
      </div>
    )
  }

  // ── Loading / not found ───────────────────────────────────
  if (loading) {
    return (
      <DashboardLayout basePath={basePath}>
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      </DashboardLayout>
    )
  }

  if (!property) {
    return (
      <DashboardLayout basePath={basePath}>
        <div className="flex flex-col items-center justify-center py-32 text-gray-400 font-body">
          <div className="text-5xl mb-4">🏚️</div>
          <p className="text-sm">{t('propertyDetail.notFound')}</p>
          <button onClick={() => navigate('/objekte')}
            className="mt-4 text-sm font-semibold underline"
            style={{ color: 'var(--color-highlight)' }}>
            {t('propertyDetail.back')}
          </button>
        </div>
      </DashboardLayout>
    )
  }

  // ═══════════════════════════════════════════════════════
  // TAB CONTENT
  // ═══════════════════════════════════════════════════════

  // ── Tab 1: Übersicht ──────────────────────────────────
  function renderOverview() {
    const p = property!
    return (
      <div className="space-y-6">

        {/* Grunddaten */}
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
            {t('propertyDetail.overview.basicData')}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label={t('properties.type')}
                  value={t(`properties.types.${p.type}`)} />
            <Stat label={t('properties.bedrooms')}
                  value={p.bedrooms === 0 ? t('properties.bedroomsStudio') : String(p.bedrooms)} />
            <Stat label={t('properties.size')}
                  value={p.size_sqm != null ? `${fmtNumber(p.size_sqm, 0)} m²` : null} />
            <Stat label={t('properties.rentalType')}
                  value={t(`properties.rental.${p.rental_type}`)} />
            <Stat label={t('properties.furnished')}
                  value={p.is_furnished ? t('properties.furnishedYes') : t('properties.furnishedNo')} />
            <Stat label={t('propertyDetail.overview.createdAt')}
                  value={fmtDate(p.created_at)} />
          </div>
        </div>

        {/* Kaufpreis */}
        {(p.purchase_price_gross || p.purchase_price_net) && (
          <div>
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
              {t('propertyDetail.overview.purchaseData')}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {p.purchase_price_gross && (
                <Stat label={t('properties.purchasePrice.gross')}
                      value={fmtCurrency(p.purchase_price_gross)} />
              )}
              {p.purchase_price_net && (
                <Stat label={t('properties.purchasePrice.net')}
                      value={fmtCurrency(p.purchase_price_net)} />
              )}
              <Stat label={t('properties.purchasePrice.vat')}
                    value={`${p.vat_rate} %`} />
            </div>
          </div>
        )}

        {/* Adresse */}
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
            {t('propertyDetail.overview.address')}
          </h3>
          {addressStr(p) ? (
            <div className="bg-gray-50 rounded-xl px-4 py-3 text-sm font-body text-hp-black">
              {p.street && <div>{p.street} {p.house_number}</div>}
              {(p.zip || p.city) && <div>{[p.zip, p.city].filter(Boolean).join(' ')}</div>}
            </div>
          ) : (
            <p className="text-sm text-gray-400 font-body">{t('propertyDetail.overview.noAddress')}</p>
          )}
        </div>

        {/* ── Lage (Google Maps) ────────────────────────── */}
        {(() => {
          const parts = [
            [p.street, p.house_number].filter(Boolean).join(' '),
            [p.zip, p.city].filter(Boolean).join(' '),
          ].filter(Boolean)
          if (parts.length < 2) return null        // Adresse unvollständig → ausblenden
          const address  = parts.join(', ')
          const encoded  = encodeURIComponent(address)
          const embedUrl = `https://maps.google.com/maps?q=${encoded}&output=embed&z=15`
          const mapsUrl  = `https://maps.google.com/maps?q=${encoded}`
          return (
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
                {t('propertyDetail.overview.location')}
              </h3>
              <div className="overflow-hidden rounded-xl" style={{ height: '300px' }}>
                <iframe
                  src={embedUrl}
                  width="100%"
                  height="300"
                  style={{ border: 0, display: 'block' }}
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  title={address}
                />
              </div>
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-2 text-xs font-medium font-body transition-colors"
                style={{ color: 'var(--color-highlight)' }}>
                {t('propertyDetail.overview.openInMaps')}
              </a>
            </div>
          )
        })()}

        {/* Beschreibung */}
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
            {t('propertyDetail.overview.description')}
          </h3>
          {p.description ? (
            <p className="text-sm font-body text-gray-700 leading-relaxed whitespace-pre-wrap bg-gray-50 rounded-xl px-4 py-3">
              {p.description}
            </p>
          ) : (
            <p className="text-sm text-gray-400 font-body">{t('propertyDetail.overview.noDescription')}</p>
          )}
        </div>

        {/* Eigentümer – Accordion */}
        {p.owner && (
          <div>
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
              {t('propertyDetail.overview.ownerInfo')}
            </h3>

            {/* Accordion trigger */}
            <button
              onClick={() => setOwnerOpen(o => !o)}
              className="w-full bg-gray-50 hover:bg-gray-100 rounded-xl px-4 py-3.5
                         flex items-center gap-3 transition-colors text-left">
              <div className="w-9 h-9 rounded-full bg-hp-black flex items-center justify-center
                              text-white text-sm font-bold font-body shrink-0">
                {(p.owner.full_name?.[0] ?? p.owner.email[0]).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-hp-black font-body text-sm">
                  {p.owner.full_name || '—'}
                </div>
                <div className="text-xs text-gray-400 font-body">{p.owner.email}</div>
              </div>
              <span className={`text-gray-400 text-sm transition-transform duration-200
                                ${ownerOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>

            {/* Accordion body */}
            {ownerOpen && (
              <div className="mt-2 bg-white border border-gray-100 rounded-xl shadow-sm p-5 space-y-5">

                {/* Stammdaten Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <div className="text-xs text-gray-400 font-body mb-0.5">{t('users.form.firstName')}</div>
                    <div className="text-sm font-semibold text-hp-black font-body">
                      {p.owner.full_name.split(' ')[0] || '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 font-body mb-0.5">{t('users.form.lastName')}</div>
                    <div className="text-sm font-semibold text-hp-black font-body">
                      {p.owner.full_name.split(' ').slice(1).join(' ') || '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 font-body mb-0.5">{t('users.form.phone')}</div>
                    <div className="text-sm font-semibold text-hp-black font-body">{p.owner.phone || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 font-body mb-0.5">{t('users.form.email')}</div>
                    <div className="text-sm font-semibold text-hp-black font-body break-all">{p.owner.email}</div>
                  </div>
                </div>

                {/* Adresse */}
                {(p.owner.address_street || p.owner.address_city) && (
                  <div>
                    <div className="text-xs text-gray-400 font-body uppercase tracking-wider mb-2">
                      {t('users.sections.address')}
                    </div>
                    <div className="text-sm text-hp-black font-body space-y-0.5">
                      {p.owner.address_street && <div>{p.owner.address_street}</div>}
                      {(p.owner.address_zip || p.owner.address_city) && (
                        <div>{[p.owner.address_zip, p.owner.address_city].filter(Boolean).join(' ')}</div>
                      )}
                      {p.owner.address_country && <div>{p.owner.address_country}</div>}
                    </div>
                  </div>
                )}

                {/* Bankverbindung – nur Admin/Verwalter */}
                {canEdit && (p.owner.iban || p.owner.bic || p.owner.bank_account_holder) && (
                  <div>
                    <div className="text-xs text-gray-400 font-body uppercase tracking-wider mb-2">
                      {t('owner.bank.title')}
                    </div>
                    <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-1.5">
                      {p.owner.bank_account_holder && (
                        <div className="flex justify-between text-sm font-body">
                          <span className="text-gray-500">{t('owner.bank.holder')}</span>
                          <span className="font-semibold text-hp-black">{p.owner.bank_account_holder}</span>
                        </div>
                      )}
                      {p.owner.iban && (
                        <div className="flex items-center justify-between text-sm font-body gap-3">
                          <span className="text-gray-500 shrink-0">{t('owner.bank.iban')}</span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold text-hp-black">
                              {showIban ? p.owner.iban.replace(/(.{4})/g, '$1 ').trim() : maskIban(p.owner.iban)}
                            </span>
                            <button onClick={() => setShowIban(s => !s)}
                                    className="text-gray-400 hover:text-gray-600 text-base">
                              {showIban ? '🙈' : '👁'}
                            </button>
                          </div>
                        </div>
                      )}
                      {p.owner.bic && (
                        <div className="flex justify-between text-sm font-body">
                          <span className="text-gray-500">{t('owner.bank.bic')}</span>
                          <span className="font-mono font-semibold text-hp-black">{p.owner.bic}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Bearbeiten Button – nur Admin/Verwalter */}
                {canEdit && (
                  <div className="pt-1 border-t border-gray-100 flex justify-end">
                    <button
                      onClick={() => openOwnerEdit(p.owner!)}
                      className="px-4 py-2 rounded-xl text-white text-sm font-semibold font-body
                                 hover:opacity-90 transition-opacity"
                      style={{ backgroundColor: 'var(--color-highlight)' }}>
                      {t('common.edit')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Owner Edit Modal */}
        {ownerEditOpen && p.owner && ownerForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center
                          bg-black/40 backdrop-blur-sm px-4 py-8 overflow-y-auto"
               onClick={e => { if (e.target === e.currentTarget) setOwnerEditOpen(false) }}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-auto">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <h2 className="text-base font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
                  {t('propertyDetail.overview.editOwner')}
                </h2>
                <button onClick={() => setOwnerEditOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
              </div>

              <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
                {/* Name */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 font-body mb-1">{t('users.form.firstName')}</label>
                    <input className={inputCls} style={focusRing()} value={ownerForm.firstName}
                           onChange={e => setOwnerForm(f => f && ({ ...f, firstName: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 font-body mb-1">{t('users.form.lastName')}</label>
                    <input className={inputCls} style={focusRing()} value={ownerForm.lastName}
                           onChange={e => setOwnerForm(f => f && ({ ...f, lastName: e.target.value }))} />
                  </div>
                </div>
                {/* Kontakt */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 font-body mb-1">{t('users.form.phone')}</label>
                    <input className={inputCls} style={focusRing()} value={ownerForm.phone}
                           onChange={e => setOwnerForm(f => f && ({ ...f, phone: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 font-body mb-1">{t('users.form.language')}</label>
                    <select className={inputCls} style={focusRing()} value={ownerForm.language}
                            onChange={e => setOwnerForm(f => f && ({ ...f, language: e.target.value }))}>
                      <option value="de">🇩🇪 Deutsch</option>
                      <option value="en">🇬🇧 English</option>
                    </select>
                  </div>
                </div>
                {/* Adresse */}
                <div className="pt-1">
                  <p className="text-xs text-gray-400 uppercase tracking-wider font-body mb-2">{t('users.sections.address')}</p>
                  <div className="space-y-2">
                    <input className={inputCls} style={focusRing()}
                           placeholder={t('users.form.street')} value={ownerForm.address_street}
                           onChange={e => setOwnerForm(f => f && ({ ...f, address_street: e.target.value }))} />
                    <div className="grid grid-cols-3 gap-2">
                      <input className={inputCls} style={focusRing()}
                             placeholder={t('users.form.zip')} value={ownerForm.address_zip}
                             onChange={e => setOwnerForm(f => f && ({ ...f, address_zip: e.target.value }))} />
                      <div className="col-span-2">
                        <input className={inputCls} style={focusRing()}
                               placeholder={t('users.form.city')} value={ownerForm.address_city}
                               onChange={e => setOwnerForm(f => f && ({ ...f, address_city: e.target.value }))} />
                      </div>
                    </div>
                    <input className={inputCls} style={focusRing()}
                           placeholder={t('users.form.country')} value={ownerForm.address_country}
                           onChange={e => setOwnerForm(f => f && ({ ...f, address_country: e.target.value }))} />
                  </div>
                </div>
                {/* Bankverbindung */}
                <div className="pt-1">
                  <p className="text-xs text-gray-400 uppercase tracking-wider font-body mb-2">{t('owner.bank.title')}</p>
                  <div className="space-y-2">
                    <input className={inputCls} style={focusRing()} placeholder="DE89 …"
                           value={ownerForm.iban}
                           onChange={e => setOwnerForm(f => f && ({ ...f, iban: e.target.value }))} />
                    <div className="grid grid-cols-2 gap-2">
                      <input className={inputCls} style={focusRing()} placeholder="BIC"
                             value={ownerForm.bic}
                             onChange={e => setOwnerForm(f => f && ({ ...f, bic: e.target.value }))} />
                      <input className={inputCls} style={focusRing()}
                             placeholder={t('owner.bank.holder')}
                             value={ownerForm.bank_account_holder}
                             onChange={e => setOwnerForm(f => f && ({ ...f, bank_account_holder: e.target.value }))} />
                    </div>
                  </div>
                </div>

                {ownerError && (
                  <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg font-body">{ownerError}</p>
                )}
              </div>

              <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
                <button onClick={() => setOwnerEditOpen(false)}
                        className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-body text-gray-600
                                   hover:border-gray-300 transition-colors">
                  {t('common.cancel')}
                </button>
                <button onClick={() => saveOwner(p.owner!)} disabled={ownerSaving}
                        className="px-5 py-2 rounded-xl text-white text-sm font-semibold font-body
                                   hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                        style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {ownerSaving && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                  {t('common.save')}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    )
  }

  // ── Tab 2: Verträge ───────────────────────────────────
  function renderContracts() {
    const mietvertrags = docs.filter(d => d.type === 'mietvertrag')

    return (
      <div className="space-y-6">

        {/* Contracts table */}
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
            {t('propertyDetail.contracts.activeContracts')}
          </h3>
          {contractsLoading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm font-body py-8 justify-center">
              <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
              {t('common.loading')}
            </div>
          ) : contracts.length === 0 ? (
            <div className="text-center py-8 text-gray-400 font-body">
              <div className="text-3xl mb-2">📝</div>
              <p className="text-sm">{t('propertyDetail.contracts.noContracts')}</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm font-body">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['tenant', 'period', 'rent', 'status', 'actions'].map(c => (
                      <th key={c} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">
                        {t(`contracts.columns.${c}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c, i) => (
                    <tr key={c.id}
                        className={`hover:bg-gray-50 transition-colors ${i < contracts.length - 1 ? 'border-b border-gray-50' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-hp-black">{c.tenant_name}</div>
                        <div className="text-xs text-gray-400">{c.tenant_email}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <div>{fmtDate(c.start_date)}</div>
                        {c.end_date && <div className="text-xs text-gray-400">– {fmtDate(c.end_date)}</div>}
                      </td>
                      <td className="px-4 py-3 text-gray-600 tabular-nums">
                        {fmtCurrency(c.monthly_rent)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge color={contractStatusColor(c.status)}>
                          {t(`contracts.statuses.${c.status}`)}
                        </Badge>
                        {c.signed_at && (
                          <div className="text-xs text-gray-400 mt-0.5">{fmtDate(c.signed_at)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {c.status !== 'signed' && (
                          <button
                            onClick={() => copySignLink(c.signature_token)}
                            className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors
                              ${linkCopied === c.signature_token
                                ? 'bg-green-50 border-green-200 text-green-700'
                                : 'border-gray-200 text-gray-600 hover:border-hp-highlight hover:text-hp-highlight'}`}>
                            {linkCopied === c.signature_token
                              ? t('propertyDetail.contracts.linkCopied')
                              : t('propertyDetail.contracts.copyLink')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Mietvertrag documents */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body">
              {t('propertyDetail.contracts.documents')}
            </h3>
            {canEdit && (
              <button
                onClick={() => { setShowContractForm(f => !f); setContractError('') }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold
                           font-body transition-colors
                           ${showContractForm
                             ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                             : 'text-white hover:opacity-90'}`}
                style={!showContractForm ? { backgroundColor: 'var(--color-highlight)' } : {}}>
                {showContractForm ? <>✕ {t('common.cancel')}</> : <><span className="text-sm">+</span> {t('propertyDetail.contracts.uploadBtn')}</>}
              </button>
            )}
          </div>

          {showContractForm && canEdit && renderDocUploadForm({
            form: contractForm,
            setForm: setContractForm,
            uploading: contractUploading,
            error: contractError,
            fileRef: contractFileRef,
            onSubmit: () => uploadDoc(
              contractForm,
              setContractUploading,
              setContractError,
              () => { setContractForm({ ...EMPTY_DOC_FORM, type: 'mietvertrag' }); setShowContractForm(false) },
            ),
            onCancel: () => { setContractForm({ ...EMPTY_DOC_FORM, type: 'mietvertrag' }); setShowContractForm(false) },
            titleKey: 'propertyDetail.contracts.uploadTitle',
          })}

          {docsLoading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm font-body py-6 justify-center">
              <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
              {t('common.loading')}
            </div>
          ) : mietvertrags.length === 0 ? (
            <div className="text-center py-8 text-gray-400 font-body">
              <div className="text-3xl mb-2">📄</div>
              <p className="text-sm">{t('propertyDetail.contracts.noDocs')}</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm font-body">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">{t('documents.columns.title')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">{t('documents.columns.date')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">{t('propertyDetail.contracts.tenant')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">{t('documents.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mietvertrags.map((doc, i) => (
                    <tr key={doc.id}
                        className={`hover:bg-gray-50 transition-colors ${i < mietvertrags.length - 1 ? 'border-b border-gray-50' : ''}`}>
                      <td className="px-4 py-3 font-medium text-hp-black">{doc.title}</td>
                      <td className="px-4 py-3 text-gray-500">{fmtDate(doc.uploaded_at)}</td>
                      <td className="px-4 py-3 text-gray-500">{doc.creditor || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => openDoc(doc.file_url)}
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200
                                       text-gray-600 hover:border-hp-highlight hover:text-hp-highlight transition-colors">
                            PDF
                          </button>
                          <button onClick={() => downloadDoc(doc.file_url, doc.title)}
                            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200
                                       text-gray-500 hover:border-gray-400 transition-colors">
                            ↓
                          </button>
                          {canEdit && (
                            <button onClick={() => deleteDoc(doc)}
                              className="text-xs px-2.5 py-1.5 rounded-lg border border-red-100
                                         text-red-400 hover:border-red-300 hover:text-red-600 transition-colors">
                              ✕
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Invoice accordion toggle ──────────────────────────
  async function toggleInvoice(doc: DocRecord) {
    if (expandedInvoiceId === doc.id) {
      setExpandedInvoiceId(null)
      return
    }
    setExpandedInvoiceId(doc.id)
    // Signed URL nur laden wenn noch nicht gecacht
    if (!invoiceSignedUrls[doc.id] && doc.file_url) {
      const { data } = await supabase.storage
        .from('documents')
        .createSignedUrl(doc.file_url, 3600)
      if (data?.signedUrl) {
        setInvoiceSignedUrls(prev => ({ ...prev, [doc.id]: data.signedUrl }))
      }
    }
  }

  // ── Tab 3: Rechnungen ─────────────────────────────────
  function renderInvoices() {
    const invoices   = docs.filter(d => d.type === 'rechnung')
    const sorted     = sortedInvoices(invoices)
    const totalGross = invoices.reduce((s, r) => s + (r.amount_gross ?? 0), 0)
    const totalNet   = invoices.reduce((s, r) => s + (r.amount_net   ?? 0), 0)

    const STATUS_CFG = {
      paid:    { label: t('propertyDetail.invoices.status.paid'),    icon: '🟢', cls: 'text-green-700 bg-green-50  border-green-200'  },
      overdue: { label: t('propertyDetail.invoices.status.overdue'), icon: '🔴', cls: 'text-red-700   bg-red-50    border-red-200'    },
      open:    { label: t('propertyDetail.invoices.status.open'),    icon: '🟡', cls: 'text-amber-700 bg-amber-50  border-amber-200'  },
    }

    return (
      <div className="space-y-4">

        {/* Upload button */}
        {canEdit && (
          <button
            onClick={() => { setInvoiceModalDoc(null); setInvoiceModalOpen(true) }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
                       font-body text-white hover:opacity-90 transition-opacity"
            style={{ backgroundColor: 'var(--color-highlight)' }}>
            <span className="text-lg leading-none">+</span>
            {t('propertyDetail.invoices.uploadBtn')}
          </button>
        )}

        {/* Table */}
        {docsLoading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm font-body py-12 justify-center">
            <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
            {t('common.loading')}
          </div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-12 text-gray-400 font-body">
            <div className="text-3xl mb-2">🧾</div>
            <p className="text-sm">{t('propertyDetail.invoices.empty')}</p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-x-auto">
              <table className="w-full text-sm font-body min-w-[750px]">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      {t('propertyDetail.invoices.statusCol')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide
                                   cursor-pointer hover:text-gray-600 select-none"
                        onClick={() => toggleSort('date')}>
                      {t('documents.columns.date')}{sortIcon('date')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide
                                   cursor-pointer hover:text-gray-600 select-none"
                        onClick={() => toggleSort('creditor')}>
                      {t('documents.creditor')}{sortIcon('creditor')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      {t('propertyDetail.invoices.invoiceNumber')}
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wide
                                   cursor-pointer hover:text-gray-600 select-none"
                        onClick={() => toggleSort('amount')}>
                      {t('documents.amountGross')}{sortIcon('amount')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      {t('propertyDetail.invoices.dueDate')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      {t('documents.columns.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((doc, i) => {
                    const st       = invoiceStatus(doc)
                    const cfg      = STATUS_CFG[st]
                    const date     = doc.invoice_date ?? doc.uploaded_at
                    const expanded = expandedInvoiceId === doc.id
                    const signedUrl = invoiceSignedUrls[doc.id]
                    return (
                      <>
                        {/* ── Haupt-Zeile (klickbar zum Aufklappen) ── */}
                        <tr key={doc.id}
                            onClick={() => toggleInvoice(doc)}
                            className={`cursor-pointer transition-colors select-none
                              ${expanded ? 'bg-blue-50/40' : 'hover:bg-gray-50'}
                              ${i < sorted.length - 1 && !expanded ? 'border-b border-gray-50' : ''}`}>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1 text-xs font-semibold
                                              px-2.5 py-1 rounded-full border ${cfg.cls}`}>
                              {cfg.icon} {cfg.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(date)}</td>
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-1.5 font-medium text-hp-black">
                              {doc.creditor || '—'}
                              <span className="text-gray-400 text-xs">{expanded ? '▲' : '▼'}</span>
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 font-mono text-xs">{doc.invoice_number || '—'}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold text-hp-black">
                            {doc.amount_gross != null ? fmtCurrency(doc.amount_gross) : '—'}
                          </td>
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                            {doc.due_date ? fmtDate(doc.due_date) : '—'}
                          </td>
                          {/* Aktionen: Klick nicht weiter propagieren */}
                          <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center gap-1.5">
                              <button onClick={() => openDoc(doc.file_url)}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200
                                           text-gray-600 hover:border-hp-highlight hover:text-hp-highlight transition-colors"
                                title={t('propertyDetail.invoices.openPdf')}>
                                PDF
                              </button>
                              <button onClick={() => downloadDoc(doc.file_url, doc.title)}
                                className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200
                                           text-gray-500 hover:border-gray-400 transition-colors"
                                title={t('propertyDetail.invoices.downloadPdf')}>
                                ↓
                              </button>
                              {canEdit && (
                                <button onClick={() => { setInvoiceModalDoc(doc); setInvoiceModalOpen(true) }}
                                  className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200
                                             text-gray-600 hover:border-gray-400 transition-colors"
                                  title={t('common.edit')}>
                                  ✏️
                                </button>
                              )}
                              {canEdit && (
                                <button onClick={() => deleteDoc(doc)}
                                  className="text-xs px-2.5 py-1.5 rounded-lg border border-red-100
                                             text-red-400 hover:border-red-300 hover:text-red-600 transition-colors">
                                  ✕
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>

                        {/* ── Aufgeklappte Detailansicht ── */}
                        {expanded && (
                          <tr key={doc.id + '-expand'} className="border-b border-gray-100">
                            <td colSpan={7} className="p-0">
                              <div className="px-5 py-5 bg-blue-50/30 border-t border-blue-100/60">

                                {/* Detail-Grid */}
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3 mb-5 font-body text-sm">

                                  {/* Rechnungsnummer */}
                                  {doc.invoice_number && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.invoiceNumber')}</p>
                                      <p className="font-medium text-hp-black font-mono text-xs">{doc.invoice_number}</p>
                                    </div>
                                  )}

                                  {/* Rechnungsdatum */}
                                  {doc.invoice_date && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.invoiceDate')}</p>
                                      <p className="font-medium text-hp-black">{fmtDate(doc.invoice_date)}</p>
                                    </div>
                                  )}

                                  {/* Fälligkeitsdatum */}
                                  {doc.due_date && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.dueDate')}</p>
                                      <p className="font-medium text-hp-black">{fmtDate(doc.due_date)}</p>
                                    </div>
                                  )}

                                  {/* Bezahlt am */}
                                  {doc.paid_at && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.paidAt')}</p>
                                      <p className="font-medium text-green-700">{fmtDate(doc.paid_at)}</p>
                                    </div>
                                  )}

                                  {/* Betrag Brutto */}
                                  {doc.amount_gross != null && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.grossAmount')}</p>
                                      <p className="font-semibold text-hp-black tabular-nums">{fmtCurrency(doc.amount_gross)}</p>
                                    </div>
                                  )}

                                  {/* Betrag Netto */}
                                  {doc.amount_net != null && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.netAmount')}</p>
                                      <p className="font-medium text-hp-black tabular-nums">{fmtCurrency(doc.amount_net)}</p>
                                    </div>
                                  )}

                                  {/* MwSt.-Satz */}
                                  {doc.vat_rate != null && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.vatRate')}</p>
                                      <p className="font-medium text-hp-black">{fmtNumber(doc.vat_rate)} %</p>
                                    </div>
                                  )}

                                  {/* IBAN */}
                                  {doc.creditor_iban && (
                                    <div>
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.creditorIban')}</p>
                                      <p className="font-medium text-hp-black font-mono text-xs">{doc.creditor_iban}</p>
                                    </div>
                                  )}

                                  {/* Beschreibung */}
                                  {doc.description && (
                                    <div className="col-span-2 sm:col-span-3 lg:col-span-4">
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.description')}</p>
                                      <p className="font-medium text-hp-black">{doc.description}</p>
                                    </div>
                                  )}

                                  {/* Notizen */}
                                  {doc.notes && (
                                    <div className="col-span-2 sm:col-span-3 lg:col-span-4">
                                      <p className="text-xs text-gray-400 mb-0.5">{t('propertyDetail.invoices.notes')}</p>
                                      <p className="text-gray-600 text-sm">{doc.notes}</p>
                                    </div>
                                  )}
                                </div>

                                {/* PDF Vorschau */}
                                <div>
                                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 font-body">
                                    {t('propertyDetail.invoices.pdfPreview')}
                                  </p>

                                  {!doc.file_url ? (
                                    <p className="text-sm text-gray-400 font-body">{t('propertyDetail.invoices.noFile')}</p>
                                  ) : !signedUrl ? (
                                    <div className="flex items-center gap-2 text-sm text-gray-400 font-body py-4">
                                      <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
                                      {t('common.loading')}
                                    </div>
                                  ) : (
                                    <>
                                      <iframe
                                        src={signedUrl}
                                        className="w-full rounded-xl border border-gray-200 bg-gray-50"
                                        style={{ height: '420px' }}
                                        title={doc.title} />

                                      {/* Download-Bereich */}
                                      <div className="flex items-center gap-2 mt-3">
                                        <button
                                          onClick={() => window.open(signedUrl, '_blank')}
                                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2
                                                     rounded-xl border border-gray-200 text-gray-600
                                                     hover:border-hp-highlight hover:text-hp-highlight transition-colors font-body">
                                          🔍 {t('propertyDetail.invoices.openPdf')}
                                        </button>
                                        <button
                                          onClick={() => downloadDoc(doc.file_url, doc.title)}
                                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2
                                                     rounded-xl border border-gray-200 text-gray-600
                                                     hover:border-gray-400 transition-colors font-body">
                                          ↓ {t('propertyDetail.invoices.downloadPdf')}
                                        </button>

                                        {/* Edit + Delete nur für Admin/Verwalter */}
                                        {canEdit && (
                                          <>
                                            <button
                                              onClick={() => { setInvoiceModalDoc(doc); setInvoiceModalOpen(true) }}
                                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2
                                                         rounded-xl border border-gray-200 text-gray-600
                                                         hover:border-gray-400 transition-colors font-body">
                                              ✏️ {t('common.edit')}
                                            </button>
                                            <button
                                              onClick={() => { setExpandedInvoiceId(null); deleteDoc(doc) }}
                                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2
                                                         rounded-xl border border-red-100 text-red-400
                                                         hover:border-red-300 hover:text-red-600 transition-colors font-body">
                                              ✕ {t('common.delete')}
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </div>

                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Sum row */}
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4 flex items-center justify-between">
              <span className="text-sm font-body text-gray-500">{t('propertyDetail.invoices.total')}</span>
              <div className="flex items-center gap-6">
                {totalNet > 0 && (
                  <span className="text-sm font-body text-gray-400 tabular-nums">
                    {t('documents.amountNet')}: {fmtCurrency(totalNet)}
                  </span>
                )}
                <span className="text-lg font-bold text-hp-black font-body tabular-nums">
                  {fmtCurrency(totalGross)}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Tab 4: Einnahmen (Platzhalter) ────────────────────
  function renderIncome() {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-400 font-body">
        <div className="text-5xl mb-4">💰</div>
        <p className="text-base font-semibold text-gray-500 mb-1">{t('propertyDetail.income.comingSoon')}</p>
        <p className="text-sm">{t('propertyDetail.income.comingSoonHint')}</p>
      </div>
    )
  }

  // ── Tab 5: Bilder ─────────────────────────────────────
  function renderImages() {
    const allImages = property!.images ?? []

    return (
      <div className="space-y-5">

        {/* Upload zone (canEdit only) */}
        {canEdit && (
          <div>
            <div
              onDragOver={e => { e.preventDefault(); setImgDragOver(true) }}
              onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setImgDragOver(false)
              }}
              onDrop={e => {
                e.preventDefault()
                setImgDragOver(false)
                addImageFiles(e.dataTransfer.files)
              }}
              onClick={() => imgInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors
                ${imgDragOver
                  ? 'border-orange-400 bg-orange-50'
                  : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white'}`}>
              <input ref={imgInputRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => { if (e.target.files) addImageFiles(e.target.files) }} />
              <div className="text-3xl mb-2">{imgDragOver ? '📸' : '🖼️'}</div>
              <p className="text-sm font-body text-gray-400">{t('propertyDetail.images.dropHint')}</p>
              <p className="text-xs text-gray-300 font-body mt-1">{t('properties.imageUpload.hint')}</p>
            </div>

            {/* Pending previews */}
            {imgPreviews.length > 0 && (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                  {imgPreviews.map((src, i) => (
                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden group ring-2 ring-orange-400">
                      <img src={src} alt="" className="w-full h-full object-cover" />
                      <span className="absolute top-1 left-1 text-[10px] bg-orange-500 text-white font-body
                                       px-1.5 py-0.5 rounded-full">neu</span>
                      <button
                        type="button"
                        onClick={() => {
                          setImgPendingFiles(p => p.filter((_, j) => j !== i))
                          setImgPreviews(p => p.filter((_, j) => j !== i))
                        }}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-red-500 text-white
                                   text-xs font-bold flex items-center justify-center
                                   opacity-0 group-hover:opacity-100 transition-opacity shadow">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={uploadPendingImages}
                    disabled={imgUploading}
                    className="px-4 py-2 rounded-xl text-white text-sm font-semibold font-body
                               hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-2"
                    style={{ backgroundColor: 'var(--color-highlight)' }}>
                    {imgUploading && (
                      <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    )}
                    {imgUploading ? t('properties.imageUpload.uploading') : t('propertyDetail.images.uploadBtn')}
                  </button>
                  <button
                    onClick={() => { setImgPendingFiles([]); setImgPreviews([]) }}
                    className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold
                               font-body text-gray-600 hover:border-gray-300 transition-colors">
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Existing images grid */}
        {allImages.length === 0 ? (
          <div className="text-center py-12 text-gray-400 font-body">
            <div className="text-4xl mb-2">🖼️</div>
            <p className="text-sm">{t('propertyDetail.gallery.noImages')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {allImages.map((url, i) => (
              <div key={i} className="relative aspect-square rounded-xl overflow-hidden group bg-gray-100">
                <img src={url} alt="" className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                {canEdit && (
                  <button
                    onClick={() => setDeleteImgUrl(url)}
                    className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors
                               flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <span className="bg-red-600 text-white text-xs font-semibold font-body
                                     px-3 py-1.5 rounded-lg shadow">
                      {t('common.delete')}
                    </span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Delete confirm dialog */}
        {deleteImgUrl && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
               style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 text-center">
              <div className="text-4xl mb-3">🗑️</div>
              <p className="text-sm font-body text-gray-700 mb-5">
                {t('propertyDetail.images.deleteConfirm')}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteImgUrl(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold
                             font-body text-gray-600 hover:border-gray-300 transition-colors">
                  {t('common.cancel')}
                </button>
                <button
                  onClick={confirmDeleteImage}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold
                             font-body hover:bg-red-700 transition-colors">
                  {t('common.delete')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ═══════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════
  const p = property
  const mietvertragCount = docs.filter(d => d.type === 'mietvertrag').length
  const rechnungCount    = docs.filter(d => d.type === 'rechnung').length

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: 'overview',   label: t('propertyDetail.tabs.overview') },
    { key: 'contracts',  label: t('propertyDetail.tabs.contracts'),
      count: (contracts.length + mietvertragCount) || undefined },
    { key: 'invoices',   label: t('propertyDetail.tabs.invoices'),
      count: rechnungCount || undefined },
    { key: 'income',     label: t('propertyDetail.tabs.income') },
    { key: 'images',     label: t('propertyDetail.tabs.images'),
      count: (p.images?.length || 0) || undefined },
  ]

  return (
    <DashboardLayout basePath={basePath}>

      {/* Back + Edit */}
      <div className="flex items-center justify-between mb-5">
        <button
          onClick={() => navigate('/objekte')}
          className="flex items-center gap-1.5 text-sm font-body text-gray-500
                     hover:text-hp-black transition-colors"
        >
          <span className="text-base">←</span>
          {t('propertyDetail.back')}
        </button>

        {canEdit && (
          <button
            onClick={() => navigate(`/objekte?edit=${p.id}`)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200
                       text-sm font-semibold font-body text-gray-600
                       hover:border-hp-highlight hover:text-hp-highlight transition-colors"
          >
            ✎ {t('propertyDetail.edit')}
          </button>
        )}
      </div>

      {/* Hero: title + badges */}
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-hp-black mb-2"
            style={{ fontFamily: 'var(--font-heading)' }}>
          {p.project_name}
          {p.unit_number && (
            <span className="ml-2 text-base font-medium text-gray-400 font-body">#{p.unit_number}</span>
          )}
        </h1>
        <div className="flex flex-wrap gap-2">
          <Badge color="blue">{t(`properties.types.${p.type}`)}</Badge>
          <Badge color="orange">{t(`properties.rental.${p.rental_type}`)}</Badge>
          {p.is_furnished && <Badge color="green">🛋️ {t('properties.furnishedYes')}</Badge>}
          {p.owner && <Badge color="purple">{p.owner.full_name || p.owner.email}</Badge>}
          {p.purchase_price_gross && (
            <Badge color="green">{fmtCurrency(p.purchase_price_gross)}</Badge>
          )}
          {addressStr(p) && (
            <span className="text-xs font-body text-gray-400 self-center">📍 {addressStr(p)}</span>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-100 mb-6 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium font-body
                       border-b-2 transition-colors whitespace-nowrap shrink-0
                       ${activeTab === tab.key
                         ? 'border-hp-highlight text-hp-black'
                         : 'border-transparent text-gray-400 hover:text-gray-600 hover:border-gray-200'}`}
            style={activeTab === tab.key ? { borderColor: 'var(--color-highlight)' } : {}}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full
                ${activeTab === tab.key ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-400'}`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="pb-12">
        {activeTab === 'overview'  && renderOverview()}
        {activeTab === 'contracts' && renderContracts()}
        {activeTab === 'invoices'  && renderInvoices()}
        {activeTab === 'income'    && renderIncome()}
        {activeTab === 'images'    && renderImages()}
      </div>

      {/* Invoice Modal */}
      {invoiceModalOpen && profile && id && (
        <InvoiceModal
          doc={invoiceModalDoc}
          propertyId={id}
          uploadedBy={profile.id}
          onClose={() => setInvoiceModalOpen(false)}
          onSaved={msg => {
            setInvoiceModalOpen(false)
            setToast({ msg })
            fetchDocs()
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />
      )}
    </DashboardLayout>
  )
}
