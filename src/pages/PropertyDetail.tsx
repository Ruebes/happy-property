import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../components/DashboardLayout'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useDateFormat } from '../lib/date'
import type { CrmUnitPayment, CrmUnitDocument, ConstructionPhoto, CrmProjectUnit } from '../lib/crmTypes'

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

interface VerwaltungRecord {
  id:                   string
  name:                 string
  address_street:       string | null
  address_zip:          string | null
  address_city:         string | null
  address_country:      string | null
  phone:                string | null
  email:                string | null
  website:              string | null
  ansprechpartner:      string | null
  ansprechpartner_phone: string | null
  ansprechpartner_email: string | null
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
  // Verwaltung / Activation
  property_status:       'under_construction' | 'active' | null
  is_managed:            boolean | null
  management_rental_type: 'longterm' | 'shortterm' | null
  verwaltung_id:         string | null
  verwaltung:            VerwaltungRecord | null
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

type TabKey = 'overview' | 'verwaltung' | 'contracts' | 'invoices' | 'income' | 'images' | 'purchases'

type InvoiceSortField = 'date' | 'creditor' | 'amount'

const MAX_PDF = 50 * 1024 * 1024

function sanitize(name: string) {
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ])
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
      const filled = await withTimeout(analyzeInvoicePDF(file), 12000)
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
  const [deleteImgUrl, setDeleteImgUrl]       = useState<string | null>(null)

  // Toast
  const [toast, setToast] = useState<{ msg: string; type?: 'success' | 'error' } | null>(null)

  // Payment Plan tab
  const [linkedUnitId,      setLinkedUnitId]      = useState<string | null>(null)
  const [linkedProjectId,   setLinkedProjectId]   = useState<string | null>(null)
  const [linkedUnit,        setLinkedUnit]        = useState<CrmProjectUnit | null>(null)
  const [unitPayments,      setUnitPayments]      = useState<CrmUnitPayment[]>([])
  const [unitKaufvertraege, setUnitKaufvertraege] = useState<CrmUnitDocument[]>([])
  const [eigentuemerDocs,   setEigentuemerDocs]   = useState<CrmUnitDocument[]>([])
  const [unitPayLoading,    setUnitPayLoading]    = useState(false)
  // CRM images + project location
  const [crmProjectImages, setCrmProjectImages] = useState<string[]>([])
  const [crmUnitImages,    setCrmUnitImages]    = useState<string[]>([])
  const [constructionPhotos, setConstructionPhotos] = useState<ConstructionPhoto[]>([])
  const [crmProjectCoords, setCrmProjectCoords] = useState<{ lat: number; lng: number; name: string } | null>(null)
  // Baustellenfotos-Upload
  const [uploadingPhoto,     setUploadingPhoto]     = useState(false)
  const [photoDate,          setPhotoDate]          = useState(new Date().toISOString().slice(0, 10))
  const [photoDesc,          setPhotoDesc]          = useState('')
  const constPhotoInputRef = useRef<HTMLInputElement>(null)
  const [uploadingPayId,   setUploadingPayId]   = useState<string | null>(null)
  const [uploadingPayType, setUploadingPayType] = useState<'invoice' | 'receipt' | null>(null)
  const payInvoiceRef = useRef<Record<string, HTMLInputElement | null>>({})
  const payReceiptRef = useRef<Record<string, HTMLInputElement | null>>({})
  // Payment Plan: neue Rate hinzufügen
  const [showAddPayForm,  setShowAddPayForm]  = useState(false)
  const [addPayDesc,      setAddPayDesc]      = useState('')
  const [addPayAmount,    setAddPayAmount]    = useState('')
  const [addPayDueDate,   setAddPayDueDate]   = useState('')
  const [addPayFile,      setAddPayFile]      = useState<File | null>(null)
  const [addPayAnalyzing, setAddPayAnalyzing] = useState(false)
  const [addPaySaving,    setAddPaySaving]    = useState(false)
  const addPayFileRef = useRef<HTMLInputElement | null>(null)
  // Payment Plan: Betrag inline editieren
  const [editingPayId,    setEditingPayId]    = useState<string | null>(null)
  const [editingAmount,   setEditingAmount]   = useState('')
  // Payment Plan: als bezahlt markieren
  const [markingPaidId,    setMarkingPaidId]    = useState<string | null>(null)
  const [markingPaidDate,  setMarkingPaidDate]  = useState('')
  const [unmarkConfirmId,  setUnmarkConfirmId]  = useState<string | null>(null)

  // Verträge: Doc-Upload (crm_unit_documents)
  const [contractDocType,   setContractDocType]   = useState<'kaufvertrag' | 'mietvertrag' | 'sonstige'>('kaufvertrag')
  const [contractDocName,   setContractDocName]   = useState('')
  const [contractDocFile,   setContractDocFile]   = useState<File | null>(null)
  const [contractDocSaving, setContractDocSaving] = useState(false)
  const [showContractDoc,   setShowContractDoc]   = useState(false)
  const contractDocRef = useRef<HTMLInputElement | null>(null)

  // Verwaltung Aktivierung (Admin)
  const [showVerwaltungModal,  setShowVerwaltungModal]  = useState(false)
  const [verwaltungList,       setVerwaltungList]       = useState<VerwaltungRecord[]>([])
  const [aktivierVerwaltungId, setAktivierVerwaltungId] = useState('')
  const [aktivierRentalType,   setAktivierRentalType]   = useState<'longterm' | 'shortterm' | ''>('')
  const [aktivierSaving,       setAktivierSaving]       = useState(false)

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

  const canEdit       = profile?.role === 'admin' || profile?.role === 'verwalter'
  const isEigentuemer = profile?.role === 'eigentuemer'
  const basePath = `/${profile?.role ?? 'eigentuemer'}/dashboard`

  // Verwaltung-Liste laden wenn Modal geöffnet wird
  async function loadVerwaltungList() {
    const { data } = await supabase
      .from('verwaltungen')
      .select('id, name, address_street, address_zip, address_city, address_country, phone, email, website')
      .order('name')
    setVerwaltungList((data ?? []) as VerwaltungRecord[])
  }

  async function handleAktivieren() {
    if (!id || !aktivierVerwaltungId || !aktivierRentalType) return
    setAktivierSaving(true)
    const { error } = await supabase.from('properties').update({
      is_managed:             true,
      property_status:        'active',
      verwaltung_id:          aktivierVerwaltungId,
      management_rental_type: aktivierRentalType,
      rental_type:            aktivierRentalType,  // sync rental_type on property too
    }).eq('id', id)
    if (error) { setAktivierSaving(false); setToast({ msg: 'Fehler beim Aktivieren.', type: 'error' }); return }

    // Sync rental_type + status to linked crm_project_unit
    if (linkedUnitId) {
      const crmRentalType = aktivierRentalType === 'longterm' ? 'long' : 'short'
      // Wenn die Unit noch auf 'under_construction' steht → auf 'active' hochsetzen
      await supabase
        .from('crm_project_units')
        .update({ rental_type: crmRentalType, status: 'active' })
        .eq('id', linkedUnitId)
        .eq('status', 'under_construction')   // nur wenn noch im Bau
      // rental_type immer aktualisieren (unabhängig vom Status)
      await supabase
        .from('crm_project_units')
        .update({ rental_type: crmRentalType })
        .eq('id', linkedUnitId)
    }

    setAktivierSaving(false)
    setShowVerwaltungModal(false)
    setToast({ msg: '✅ Immobilie für Verwaltung aktiviert' })
    fetchProperty()
  }

  async function handleDeaktivieren() {
    if (!id) return
    const { error } = await supabase.from('properties').update({
      is_managed:            false,
      property_status:       'under_construction',
      verwaltung_id:         null,
      management_rental_type: null,
    }).eq('id', id)
    if (error) { setToast({ msg: 'Fehler beim Deaktivieren.', type: 'error' }); return }

    // Linked unit zurück auf 'under_construction' setzen (wenn nicht bereits verkauft)
    if (linkedUnitId) {
      await supabase
        .from('crm_project_units')
        .update({ status: 'under_construction', rental_type: null })
        .eq('id', linkedUnitId)
        .eq('status', 'active')   // nur aktive Units zurücksetzen, nicht zugewiesene
    }

    setToast({ msg: 'Immobilie deaktiviert' })
    fetchProperty()
  }

  // ── Fetch property ───────────────────────────────────────
  const fetchProperty = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const sel = '*, owner:owner_id(id, full_name, email, phone, address_street, address_zip, address_city, address_country, iban, bic, bank_account_holder, language, is_active), verwaltung:verwaltung_id(id, name, address_street, address_zip, address_city, address_country, phone, email, website, ansprechpartner, ansprechpartner_phone, ansprechpartner_email)'
    // Mit 1 Retry: ein einmaliger Aussetzer (langsame Antwort/Timing) heilt sich selbst,
    // statt die Seite leer/„nicht gefunden" zu lassen.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { data, error } = await supabase.from('properties').select(sel).eq('id', id).single()
        if (error) throw error
        setProperty((data as PropertyFull) ?? null)
        break
      } catch (err) {
        if (attempt >= 2) { console.error('[PropertyDetail] fetchProperty:', err) }
        else { await new Promise(r => setTimeout(r, 400)) }
      }
    }
    setLoading(false)
  }, [id])

  // ── Fetch documents ──────────────────────────────────────
  const fetchDocs = useCallback(async () => {
    if (!id) return
    setDocsLoading(true)
    try {
      const { data } = await supabase
        .from('documents')
        .select('id, type, title, file_url, amount_net, amount_gross, creditor, uploaded_at, invoice_number, invoice_date, due_date, paid_at, description, creditor_iban, notes, vat_rate')
        .eq('property_id', id)
        .order('uploaded_at', { ascending: false })
      setDocs((data as DocRecord[]) ?? [])
    } catch (err) {
      console.error('[PropertyDetail] fetchDocs:', err)
    } finally {
      setDocsLoading(false)
    }
  }, [id])

  // ── Fetch contracts ──────────────────────────────────────
  const fetchContracts = useCallback(async () => {
    if (!id) return
    setContractsLoading(true)
    try {
      const { data } = await supabase
        .from('contracts')
        .select('id, tenant_name, tenant_email, start_date, end_date, monthly_rent, status, signature_token, signed_at')
        .eq('property_id', id)
        .order('start_date', { ascending: false })
      setContracts((data as ContractRecord[]) ?? [])
    } catch (err) {
      console.error('[PropertyDetail] fetchContracts:', err)
    } finally {
      setContractsLoading(false)
    }
  }, [id])

  // Zwei separate Effects damit canEdit-Änderung (Profil lädt nach) nicht
  // fetchProperty + fetchDocs nochmals triggert.
  useEffect(() => {
    fetchProperty()
    fetchDocs()
  }, [fetchProperty, fetchDocs])

  // Sicherheits-Timeout (wie auth.tsx): der Lade-Spinner darf NIE ewig hängen.
  // Wenn eine Query in Safari durch navigator.locks-/Token-Refresh-Timing blockiert
  // (gleiche Klasse wie der alte CRM-Spinner-Deadlock), wird die Seite nach 12s
  // freigegeben; nachgeladene Daten erscheinen, sobald die Query doch zurückkommt.
  useEffect(() => {
    const t = setTimeout(() => setLoading(prev => prev ? false : prev), 12_000)
    return () => clearTimeout(t)
  }, [id])

  useEffect(() => {
    if (canEdit) fetchContracts()
  }, [fetchContracts, canEdit])

  // ── Fetch unit payments + Kaufvertrag-Dokumente ──────────
  const fetchUnitPayments = useCallback(async () => {
    if (!id) return
    setUnitPayLoading(true)
    try {
      // Find the CRM unit linked to this property
      const { data: unitData } = await supabase
        .from('crm_project_units')
        .select(`
          id, project_id, images,
          unit_number, block, type, bedrooms, bathrooms,
          size_sqm, terrace_sqm, floor,
          price_net, price_gross, vat_rate,
          is_furnished, rental_type, status,
          handover_date, notes,
          verwalter_id, verwalter:verwalter_id(id, full_name)
        `)
        .eq('property_id', id)
        .maybeSingle()
      if (!unitData) {
        setLinkedUnitId(null)
        setLinkedProjectId(null)
        setLinkedUnit(null)
        setUnitPayments([])
        setUnitKaufvertraege([])
        setCrmProjectImages([])
        setCrmUnitImages([])
        setConstructionPhotos([])
        return
      }
      setLinkedUnitId(unitData.id)
      setLinkedProjectId((unitData as { project_id: string }).project_id)
      setCrmUnitImages((unitData as { images?: string[] }).images ?? [])
      setLinkedUnit(unitData as unknown as CrmProjectUnit)

      const [paysRes, docsRes, ownDocsRes, projRes, constPhotosRes] = await Promise.all([
        supabase
          .from('crm_unit_payments')
          .select('*')
          .eq('unit_id', unitData.id)
          .order('due_date', { ascending: true, nullsFirst: true }),
        supabase
          .from('crm_unit_documents')
          .select('*')
          .eq('unit_id', unitData.id)
          .eq('doc_type', 'kaufvertrag')
          .order('created_at', { ascending: false }),
        supabase
          .from('crm_unit_documents')
          .select('*')
          .eq('unit_id', unitData.id)
          .neq('doc_type', 'kaufvertrag')
          .order('created_at', { ascending: false }),
        supabase
          .from('crm_projects')
          .select('images, latitude, longitude, name, location')
          .eq('id', (unitData as { project_id: string }).project_id)
          .maybeSingle(),
        supabase
          .from('construction_photos')
          .select('*')
          .eq('project_id', (unitData as { project_id: string }).project_id)
          .order('photo_date', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false }),
      ])
      setUnitPayments((paysRes.data ?? []) as CrmUnitPayment[])
      setUnitKaufvertraege((docsRes.data ?? []) as CrmUnitDocument[])
      setEigentuemerDocs((ownDocsRes.data ?? []) as CrmUnitDocument[])
      setConstructionPhotos((constPhotosRes.data ?? []) as ConstructionPhoto[])
      const proj = projRes.data as { images?: string[]; latitude?: number; longitude?: number; name?: string; location?: string } | null
      setCrmProjectImages(proj?.images ?? [])
      if (proj?.latitude && proj?.longitude) {
        setCrmProjectCoords({ lat: proj.latitude, lng: proj.longitude, name: proj.name ?? proj.location ?? '' })
      } else if (proj?.location) {
        setCrmProjectCoords({ lat: 0, lng: 0, name: proj.location })
      } else {
        setCrmProjectCoords(null)
      }
    } catch (err) {
      // Fehler beim Nachladen der CRM-/Zahlungsdaten dürfen die Seite NICHT blockieren
      console.error('[PropertyDetail] fetchUnitPayments:', err)
    } finally {
      setUnitPayLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchUnitPayments()
  }, [fetchUnitPayments])

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
      const { error } = await supabase.from('profiles').update({
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
          <div className="flex items-center gap-4 mt-4">
            <button onClick={() => fetchProperty()}
              className="text-sm font-semibold px-4 py-2 rounded-lg text-white"
              style={{ backgroundColor: 'var(--color-highlight)' }}>
              ↻ {t('common.reload', 'Neu laden')}
            </button>
            <button onClick={() => navigate('/objekte')}
              className="text-sm font-semibold underline"
              style={{ color: 'var(--color-highlight)' }}>
              {t('propertyDetail.back')}
            </button>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  // ── Kaufunterlagen: file helpers ─────────────────────
  async function openUnitPaymentFile(filePath: string) {
    const { data } = await supabase.storage
      .from('unit-documents')
      .createSignedUrl(filePath, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  async function handleUploadPaymentFile(
    payId:   string,
    type:    'invoice' | 'receipt',
    file:    File,
  ) {
    if (!linkedUnitId) return
    setUploadingPayId(payId)
    setUploadingPayType(type)
    try {
      const ext  = file.name.split('.').pop() ?? 'pdf'
      const path = `unit-documents/${linkedUnitId}/pay-${type}-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('unit-documents').upload(path, file, { upsert: false })
      if (upErr) throw upErr

      const update: Record<string, unknown> = type === 'invoice'
        ? { invoice_path: path, invoice_filename: file.name, invoice_filesize: file.size }
        : { receipt_path: path, receipt_filename: file.name, receipt_filesize: file.size }

      // Rechnung-PDF → KI liest Betrag aus und überschreibt den vordefinierten Wert
      if (type === 'invoice' && file.type === 'application/pdf') {
        try {
          const result = await withTimeout(analyzeInvoicePDF(file), 12000)
          const amount = result?.amount_gross ?? result?.amount_net
          if (amount) update.amount = parseFloat(String(amount))
        } catch { /* silent – amount stays as-is */ }
      }

      await supabase.from('crm_unit_payments').update(update).eq('id', payId)
      void notifyOwner(file.name, 'Dokument')
      await fetchUnitPayments()
    } catch (err) {
      console.error('[PropertyDetail] upload payment file:', err)
      setToast({ msg: 'Upload fehlgeschlagen.', type: 'error' })
    } finally {
      setUploadingPayId(null)
      setUploadingPayType(null)
    }
  }

  async function handleRemovePaymentFile(payId: string, type: 'invoice' | 'receipt') {
    const pay = unitPayments.find(p => p.id === payId)
    if (!pay) return
    const path = type === 'invoice' ? pay.invoice_path : pay.receipt_path
    if (path) await supabase.storage.from('unit-documents').remove([path])
    const update = type === 'invoice'
      ? { invoice_path: null, invoice_filename: null, invoice_filesize: null }
      : { receipt_path: null, receipt_filename: null, receipt_filesize: null }
    await supabase.from('crm_unit_payments').update(update).eq('id', payId)
    await fetchUnitPayments()
  }

  async function handleDownloadPaymentFile(path: string, filename: string) {
    const { data } = await supabase.storage
      .from('unit-documents').createSignedUrl(path, 60)
    if (!data?.signedUrl) { setToast({ msg: 'Download fehlgeschlagen.', type: 'error' }); return }
    const a = document.createElement('a')
    a.href = data.signedUrl
    a.download = filename
    a.click()
  }

  async function handleDeletePaymentEntry(payId: string) {
    if (!window.confirm('Rate löschen? Hochgeladene Dateien werden ebenfalls entfernt.')) return
    const pay = unitPayments.find(p => p.id === payId)
    if (!pay) return
    const paths = [pay.invoice_path, pay.receipt_path].filter(Boolean) as string[]
    if (paths.length) await supabase.storage.from('unit-documents').remove(paths)
    await supabase.from('crm_unit_payments').delete().eq('id', payId)
    await fetchUnitPayments()
  }

  async function handleSaveEditedAmount(payId: string) {
    const val = parseFloat(editingAmount.replace(',', '.'))
    if (isNaN(val) || val < 0) { setEditingPayId(null); return }
    await supabase.from('crm_unit_payments').update({ amount: val }).eq('id', payId)
    setEditingPayId(null)
    await fetchUnitPayments()
  }

  // auto-suggest next label
  function nextPaymentLabel(): string {
    const hasReservierung = unitPayments.some(p =>
      (p.description ?? '').toLowerCase().includes('reserv'))
    if (!hasReservierung) return 'Reservierung'
    const rateCount = unitPayments.filter(p =>
      !(p.description ?? '').toLowerCase().includes('reserv')).length
    return `${rateCount + 1}. Rate`
  }

  async function handleAddPayment() {
    if (!linkedUnitId || !linkedProjectId || !profile?.id) {
      setToast({ msg: 'Kein verknüpftes CRM-Objekt gefunden. Bitte erst im CRM verknüpfen.', type: 'error' })
      return
    }
    setAddPaySaving(true)
    try {
      let invoicePath: string | null = null
      let invoiceFilename: string | null = null
      let invoiceFilesize: number | null = null

      if (addPayFile) {
        const ext  = addPayFile.name.split('.').pop() ?? 'pdf'
        const path = `unit-documents/${linkedUnitId}/inv-${Date.now()}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('unit-documents').upload(path, addPayFile, { upsert: false })
        if (upErr) throw upErr
        invoicePath     = path
        invoiceFilename = addPayFile.name
        invoiceFilesize = addPayFile.size
      }

      const amount = parseFloat(addPayAmount.replace(',', '.')) || 0
      const { error: insertErr } = await supabase.from('crm_unit_payments').insert({
        unit_id:          linkedUnitId,
        project_id:       linkedProjectId,
        uploaded_by:      profile.id,
        description:      addPayDesc.trim() || nextPaymentLabel(),
        amount,
        due_date:         addPayDueDate || null,
        is_paid:          false,
        invoice_path:     invoicePath,
        invoice_filename: invoiceFilename,
        invoice_filesize: invoiceFilesize,
      })
      if (insertErr) throw new Error(insertErr.message)

      setShowAddPayForm(false)
      setAddPayDesc('')
      setAddPayAmount('')
      setAddPayDueDate('')
      setAddPayFile(null)
      if (addPayFileRef.current) addPayFileRef.current.value = ''
      await fetchUnitPayments()
      setToast({ msg: 'Rate hinzugefügt ✓' })
    } catch (err) {
      console.error('[handleAddPayment]', err)
      setToast({ msg: `Fehler beim Speichern: ${err instanceof Error ? err.message : String(err)}`, type: 'error' })
    } finally {
      setAddPaySaving(false)
    }
  }

  async function handleAddPayInvoice(file: File) {
    setAddPayFile(file)
    if (file.type !== 'application/pdf') return
    setAddPayAnalyzing(true)
    try {
      const result = await withTimeout(analyzeInvoicePDF(file), 12000)
      if (result?.amount_gross) setAddPayAmount(String(result.amount_gross))
      else if (result?.amount_net) setAddPayAmount(String(result.amount_net))
    } catch { /* silent – user enters manually */ } finally {
      setAddPayAnalyzing(false)
    }
  }

  // ── Payment Plan: bezahlt markieren / entmarkieren ───────
  async function handleMarkAsPaid(payId: string, date: string) {
    const { error } = await supabase.from('crm_unit_payments')
      .update({ is_paid: true, paid_date: date || new Date().toISOString().split('T')[0] })
      .eq('id', payId)
    if (error) {
      setToast({ msg: 'Speichern fehlgeschlagen. Bitte erneut versuchen.', type: 'error' })
      return
    }
    setMarkingPaidId(null)
    setMarkingPaidDate('')
    await fetchUnitPayments()
    setToast({ msg: 'Als bezahlt markiert ✓' })
  }

  async function handleUnmarkAsPaid(payId: string) {
    const { error } = await supabase.from('crm_unit_payments')
      .update({ is_paid: false, paid_date: null })
      .eq('id', payId)
    if (error) {
      setToast({ msg: 'Speichern fehlgeschlagen.', type: 'error' })
      return
    }
    setUnmarkConfirmId(null)
    await fetchUnitPayments()
  }

  // ── Verträge: Dokument hochladen → crm_unit_documents ────
  async function handleUploadContractDoc() {
    if (!linkedUnitId || !linkedProjectId || !profile?.id || !contractDocFile) return
    setContractDocSaving(true)
    try {
      const ext  = contractDocFile.name.split('.').pop() ?? 'pdf'
      const path = `unit-documents/${linkedUnitId}/doc-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('unit-documents').upload(path, contractDocFile, { upsert: false })
      if (upErr) throw upErr
      const docName = contractDocType === 'kaufvertrag' ? 'Kaufvertrag'
                    : contractDocType === 'mietvertrag' ? 'Mietvertrag'
                    : contractDocName.trim() || contractDocFile.name.replace(/\.[^.]+$/, '')
      const { error: dbErr } = await supabase.from('crm_unit_documents').insert({
        unit_id:     linkedUnitId,
        project_id:  linkedProjectId,
        name:        docName,
        file_path:   path,
        file_name:   contractDocFile.name,
        file_size:   contractDocFile.size,
        doc_type:    contractDocType,
        uploaded_by: profile.id,
      })
      if (dbErr) throw dbErr
      void notifyOwner(docName, 'Dokument')
      setShowContractDoc(false)
      setContractDocFile(null)
      setContractDocName('')
      setContractDocType('kaufvertrag')
      if (contractDocRef.current) contractDocRef.current.value = ''
      await fetchUnitPayments()
      setToast({ msg: 'Dokument hochgeladen ✓' })
    } catch (err) {
      console.error('[handleUploadContractDoc]', err)
      setToast({ msg: 'Upload fehlgeschlagen.', type: 'error' })
    } finally {
      setContractDocSaving(false)
    }
  }

  async function handleDeleteEigDoc(doc: CrmUnitDocument) {
    if (!window.confirm(`„${doc.name}" löschen?`)) return
    await supabase.storage.from('unit-documents').remove([doc.file_path])
    await supabase.from('crm_unit_documents').delete().eq('id', doc.id)
    await fetchUnitPayments()
  }

  // ─────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════
  // TAB CONTENT
  // ═══════════════════════════════════════════════════════

  // ── Tab 1: Übersicht ──────────────────────────────────
  function renderOverview() {
    const p = property!
    // Prefer CRM unit data for specs; fall back to properties for unlinked units
    const u = linkedUnit
    const displayType        = u?.type         ?? p.type
    const displayBedrooms    = u?.bedrooms      ?? p.bedrooms
    const displayBathrooms   = u?.bathrooms     ?? null
    const displaySizeSqm     = u?.size_sqm      ?? p.size_sqm
    const displayTerraceSqm  = u?.terrace_sqm   ?? null
    const displayFloor       = u?.floor         ?? null
    const displayIsFurnished = u?.is_furnished  ?? p.is_furnished
    const displayRentalType  = u?.rental_type === 'long'  ? 'longterm'
                             : u?.rental_type === 'short' ? 'shortterm'
                             : (p.rental_type ?? 'longterm')
    const displayPriceGross  = u?.price_gross   ?? p.purchase_price_gross
    const displayPriceNet    = u?.price_net     ?? p.purchase_price_net
    const displayVatRate     = u?.vat_rate      ?? p.vat_rate

    return (
      <div className="space-y-6">

        {/* Grunddaten */}
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
            {t('propertyDetail.overview.basicData')}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label={t('properties.type')}
                  value={t(`properties.types.${displayType}`)} />
            <Stat label={t('properties.bedrooms')}
                  value={displayBedrooms === 0 ? t('properties.bedroomsStudio') : String(displayBedrooms)} />
            <Stat label={t('properties.size')}
                  value={displaySizeSqm != null ? `${fmtNumber(displaySizeSqm, 0)} m²` : null} />
            {displayTerraceSqm != null && (
              <Stat label="Terrasse"
                    value={`${fmtNumber(displayTerraceSqm, 0)} m²`} />
            )}
            {displayFloor != null && (
              <Stat label="Etage"
                    value={String(displayFloor)} />
            )}
            {displayBathrooms != null && (
              <Stat label="Badezimmer"
                    value={String(displayBathrooms)} />
            )}
            <Stat label={t('properties.rentalType')}
                  value={t(`properties.rental.${displayRentalType}`)} />
            <Stat label={t('properties.furnished')}
                  value={displayIsFurnished ? t('properties.furnishedYes') : t('properties.furnishedNo')} />
            <Stat label={t('propertyDetail.overview.createdAt')}
                  value={fmtDate(p.created_at)} />
          </div>
        </div>

        {/* Kaufpreis */}
        {(displayPriceGross || displayPriceNet) && (
          <div>
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
              {t('propertyDetail.overview.purchaseData')}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {displayPriceGross && (
                <Stat label={t('properties.purchasePrice.gross')}
                      value={fmtCurrency(displayPriceGross)} />
              )}
              {displayPriceNet && (
                <Stat label={t('properties.purchasePrice.net')}
                      value={fmtCurrency(displayPriceNet)} />
              )}
              <Stat label={t('properties.purchasePrice.vat')}
                    value={`${displayVatRate} %`} />
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
          // 1. Vollständige Adresse aus properties
          const parts = [
            [p.street, p.house_number].filter(Boolean).join(' '),
            [p.zip, p.city].filter(Boolean).join(' '),
          ].filter(Boolean)
          const hasFullAddress = parts.length >= 2

          let embedUrl: string
          let mapsUrl:  string
          let label:    string

          if (hasFullAddress) {
            const address = parts.join(', ')
            const enc     = encodeURIComponent(address)
            embedUrl = `https://maps.google.com/maps?q=${enc}&output=embed&z=15`
            mapsUrl  = `https://maps.google.com/maps?q=${enc}`
            label    = address
          } else if (crmProjectCoords) {
            // 2. Fallback: CRM-Projektkoordinaten oder Standortname
            if (crmProjectCoords.lat !== 0) {
              embedUrl = `https://maps.google.com/maps?q=${crmProjectCoords.lat},${crmProjectCoords.lng}&output=embed&z=15`
              mapsUrl  = `https://maps.google.com/maps?q=${crmProjectCoords.lat},${crmProjectCoords.lng}`
            } else {
              const enc = encodeURIComponent(crmProjectCoords.name)
              embedUrl  = `https://maps.google.com/maps?q=${enc}&output=embed&z=13`
              mapsUrl   = `https://maps.google.com/maps?q=${enc}`
            }
            label = crmProjectCoords.name
          } else {
            return null   // Keine Standortdaten vorhanden
          }

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
                  title={label}
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

  // ── Tab: Verwaltung ───────────────────────────────────
  function renderVerwaltung() {
    const prop = p
    const subjectLine = encodeURIComponent(prop.project_name + (prop.unit_number ? ' #' + prop.unit_number : ''))

    return (
      <div className="space-y-6">

        {prop.is_managed && prop.verwaltung ? (
          <>
            {/* Firmenkarte */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">

              {/* Kopfzeile */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-full bg-hp-black flex items-center justify-center
                                  text-white text-lg font-bold shrink-0">
                    {prop.verwaltung.name[0].toUpperCase()}
                  </div>
                  <div>
                    <p className="font-semibold text-hp-black font-body">{prop.verwaltung.name}</p>
                    {prop.management_rental_type && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                        {prop.management_rental_type === 'shortterm' ? '🌴 Kurzzeitvermietung' : '🏠 Langzeitvermietung'}
                      </span>
                    )}
                  </div>
                </div>
                {canEdit && (
                  <button onClick={handleDeaktivieren}
                          className="text-xs text-gray-400 hover:text-red-500 font-body transition-colors underline">
                    Deaktivieren
                  </button>
                )}
              </div>

              {/* Firma-Kontakt */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-3 border-t border-gray-100">
                {prop.verwaltung.phone && (
                  <a href={`tel:${prop.verwaltung.phone}`}
                     className="flex items-center gap-2 text-sm font-body text-gray-700 hover:text-hp-highlight transition-colors">
                    <span className="text-base">📞</span><span>{prop.verwaltung.phone}</span>
                  </a>
                )}
                {prop.verwaltung.email && (
                  <a href={`mailto:${prop.verwaltung.email}`}
                     className="flex items-center gap-2 text-sm font-body text-gray-700 hover:text-hp-highlight transition-colors truncate">
                    <span className="text-base">✉️</span><span className="truncate">{prop.verwaltung.email}</span>
                  </a>
                )}
                {(prop.verwaltung.address_street || prop.verwaltung.address_city) && (() => {
                  const addr = [
                    prop.verwaltung!.address_street,
                    [prop.verwaltung!.address_zip, prop.verwaltung!.address_city].filter(Boolean).join(' '),
                    prop.verwaltung!.address_country !== 'Deutschland' ? prop.verwaltung!.address_country : null,
                  ].filter(Boolean).join(', ')
                  return (
                    <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`}
                       target="_blank" rel="noopener noreferrer"
                       className="flex items-center gap-2 text-sm font-body text-gray-700 hover:text-hp-highlight transition-colors col-span-full">
                      <span className="text-base">📍</span><span className="truncate">{addr}</span>
                    </a>
                  )
                })()}
                {prop.verwaltung.website && (
                  <a href={prop.verwaltung.website.startsWith('http') ? prop.verwaltung.website : `https://${prop.verwaltung.website}`}
                     target="_blank" rel="noopener noreferrer"
                     className="flex items-center gap-2 text-sm font-body text-gray-700 hover:text-hp-highlight transition-colors">
                    <span className="text-base">🌐</span><span className="truncate">{prop.verwaltung.website}</span>
                  </a>
                )}
              </div>

              {/* Ansprechpartner */}
              {prop.verwaltung.ansprechpartner && (
                <div className="pt-3 border-t border-gray-100">
                  <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-2 font-body">
                    Ansprechpartner
                  </p>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center
                                    text-gray-500 text-xs font-bold shrink-0">
                      {prop.verwaltung.ansprechpartner[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-hp-black font-body">{prop.verwaltung.ansprechpartner}</p>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
                        {prop.verwaltung.ansprechpartner_phone && (
                          <a href={`tel:${prop.verwaltung.ansprechpartner_phone}`}
                             className="text-xs text-gray-500 hover:text-hp-highlight font-body transition-colors">
                            📞 {prop.verwaltung.ansprechpartner_phone}
                          </a>
                        )}
                        {prop.verwaltung.ansprechpartner_email && (
                          <a href={`mailto:${prop.verwaltung.ansprechpartner_email}`}
                             className="text-xs text-gray-500 hover:text-hp-highlight font-body transition-colors">
                            ✉️ {prop.verwaltung.ansprechpartner_email}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Aktions-Buttons */}
            <div className="space-y-2">
              {isEigentuemer && (prop.verwaltung.ansprechpartner_email ?? prop.verwaltung.email) && (
                <a href={`mailto:${prop.verwaltung.ansprechpartner_email ?? prop.verwaltung.email}?subject=Anfrage zu ${subjectLine}`}
                   className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl text-sm font-semibold
                              text-white font-body hover:opacity-90 transition-opacity shadow-sm"
                   style={{ backgroundColor: 'var(--color-highlight)' }}>
                  ✉️ Nachricht an Verwaltung senden
                </a>
              )}
              {canEdit && prop.owner?.email && (
                <a href={`mailto:${prop.owner.email}?subject=Info zu ${subjectLine}`}
                   className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl text-sm font-semibold
                              font-body border border-gray-200 text-gray-700 hover:border-hp-highlight hover:text-hp-highlight transition-colors">
                  ✉️ E-Mail an Eigentümer senden
                </a>
              )}
            </div>
          </>
        ) : canEdit ? (
          /* Admin: noch nicht aktiviert */
          <div className="text-center py-16 space-y-4">
            <div className="text-5xl">🔑</div>
            <p className="text-sm text-gray-500 font-body">
              Diese Immobilie ist noch keiner Verwaltung zugewiesen.
            </p>
            <button
              onClick={() => { loadVerwaltungList(); setAktivierVerwaltungId(''); setAktivierRentalType(''); setShowVerwaltungModal(true) }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                         text-white font-body hover:opacity-90 transition-opacity"
              style={{ backgroundColor: 'var(--color-highlight)' }}>
              🔑 Für Verwaltung aktivieren
            </button>
          </div>
        ) : (
          /* Eigentuemer: noch keine Verwaltung */
          <div className="text-center py-16">
            <div className="text-5xl mb-4">🏢</div>
            <p className="text-sm text-gray-500 font-body">
              Für diese Immobilie ist noch keine Verwaltung eingetragen.
            </p>
          </div>
        )}

        {/* Aktivierungs-Modal (Admin) */}
        {showVerwaltungModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center
                          bg-black/40 backdrop-blur-sm px-4"
               onClick={e => { if (e.target === e.currentTarget) setShowVerwaltungModal(false) }}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <h2 className="text-base font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
                  🔑 Für Verwaltung aktivieren
                </h2>
                <button onClick={() => setShowVerwaltungModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <div>
                  <label className="block text-xs text-gray-500 font-body mb-1.5 font-semibold">
                    Verwaltungsunternehmen *
                  </label>
                  <select value={aktivierVerwaltungId} onChange={e => setAktivierVerwaltungId(e.target.value)}
                          className={`${inputCls} w-full`} style={focusRing()}>
                    <option value="">– Bitte auswählen –</option>
                    {verwaltungList.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                  {verwaltungList.length === 0 && (
                    <p className="text-xs text-amber-600 font-body mt-1">
                      Noch keine Verwaltungen angelegt.{' '}
                      <a href="/admin/verwaltungen" target="_blank" className="underline hover:text-amber-800">Jetzt anlegen →</a>
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-gray-500 font-body mb-1.5 font-semibold">
                    Vermietungsart <span className="text-red-400">*</span>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['longterm', 'shortterm'] as const).map(rt => (
                      <button key={rt} type="button" onClick={() => setAktivierRentalType(rt)}
                              className={`py-2.5 rounded-xl border-2 text-sm font-semibold font-body transition-all
                                ${aktivierRentalType === rt
                                  ? 'border-hp-highlight text-hp-highlight bg-orange-50'
                                  : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                        {rt === 'longterm' ? '🏠 Langzeit' : '🌴 Kurzzeit'}
                      </button>
                    ))}
                  </div>
                  {!aktivierRentalType && (
                    <p className="text-xs text-amber-600 font-body mt-1.5">
                      Bitte Vermietungsart auswählen.
                    </p>
                  )}
                </div>
              </div>
              <div className="px-6 pb-5 flex gap-3 justify-end">
                <button onClick={() => setShowVerwaltungModal(false)}
                        className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 font-body hover:bg-gray-50">
                  Abbrechen
                </button>
                <button onClick={handleAktivieren} disabled={!aktivierVerwaltungId || !aktivierRentalType || aktivierSaving}
                        className="px-5 py-2 rounded-xl text-sm font-semibold text-white font-body hover:opacity-90 transition-opacity disabled:opacity-50"
                        style={{ backgroundColor: 'var(--color-highlight)' }}>
                  {aktivierSaving ? 'Speichern…' : '✓ Aktivieren'}
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

    // Alle CRM-Docs: Kaufvertrag/Mietvertrag oben gepinnt, Rest darunter
    const pinnedCrmDocs  = [...unitKaufvertraege, ...eigentuemerDocs.filter(d => d.doc_type === 'mietvertrag')]
    const otherCrmDocs   = eigentuemerDocs.filter(d => d.doc_type !== 'mietvertrag')

    async function openCrmDoc(path: string) {
      const { data } = await supabase.storage.from('unit-documents').createSignedUrl(path, 300)
      if (data?.signedUrl) window.open(data.signedUrl, '_blank')
    }
    async function downloadCrmDoc(path: string, name: string) {
      const { data } = await supabase.storage.from('unit-documents').createSignedUrl(path, 60)
      if (!data?.signedUrl) return
      const a = document.createElement('a'); a.href = data.signedUrl; a.download = name; a.click()
    }

    function DocRow({ doc }: { doc: CrmUnitDocument }) {
      return (
        <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-hp-black font-body truncate">{doc.name}</p>
            <p className="text-xs text-gray-400 font-body mt-0.5">{fmtDate(doc.created_at)}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => openCrmDoc(doc.file_path)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200
                               text-gray-600 hover:border-hp-highlight hover:text-hp-highlight transition-colors">
              Öffnen
            </button>
            <button onClick={() => downloadCrmDoc(doc.file_path, doc.file_name ?? doc.name)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200
                               text-gray-500 hover:border-gray-400 transition-colors" title="Download">
              ↓
            </button>
            {(canEdit || isEigentuemer) && (
              <button onClick={() => handleDeleteEigDoc(doc)}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-red-100
                                 text-red-400 hover:border-red-300 hover:text-red-600 transition-colors">
                ✕
              </button>
            )}
          </div>
        </div>
      )
    }

    function DocRowLegacy({ doc }: { doc: DocRecord }) {
      return (
        <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-hp-black font-body truncate">{doc.title}</p>
            <p className="text-xs text-gray-400 font-body mt-0.5">{fmtDate(doc.uploaded_at)}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => openDoc(doc.file_url)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200
                               text-gray-600 hover:border-hp-highlight hover:text-hp-highlight transition-colors">
              Öffnen
            </button>
            <button onClick={() => downloadDoc(doc.file_url, doc.title)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200
                               text-gray-500 hover:border-gray-400 transition-colors" title="Download">
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
        </div>
      )
    }

    const hasPinned = pinnedCrmDocs.length > 0 || mietvertrags.length > 0
    const hasOther  = otherCrmDocs.length > 0

    return (
      <div className="space-y-6">

        {/* ── Angepinnte Verträge ──────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
            📌 Kaufvertrag & Mietvertrag
          </h3>
          {!hasPinned ? (
            <div className="text-center py-6 text-gray-400 font-body">
              <p className="text-sm">Noch keine Verträge hochgeladen.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
              {pinnedCrmDocs.map(doc => <DocRow key={doc.id} doc={doc} />)}
              {mietvertrags.map(doc => <DocRowLegacy key={doc.id} doc={doc} />)}
            </div>
          )}
        </div>

        {/* ── Weitere Unterlagen ───────────────────────────── */}
        {(hasOther || canEdit) && (
          <div>
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
              📄 Weitere Unterlagen
            </h3>
            {!hasOther ? (
              <div className="text-center py-6 text-gray-400 font-body">
                <p className="text-sm">Noch keine weiteren Dokumente.</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
                {otherCrmDocs.map(doc => <DocRow key={doc.id} doc={doc} />)}
              </div>
            )}
          </div>
        )}

        {/* ── Dokument hochladen ───────────────────────────── */}
        {(canEdit || isEigentuemer) && linkedUnitId && (
          <div>
            {!showContractDoc ? (
              <button
                onClick={() => setShowContractDoc(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border-2
                           border-dashed border-gray-200 text-sm font-medium text-gray-400
                           hover:border-orange-300 hover:text-orange-500 transition-colors font-body">
                <span className="text-lg">+</span> Dokument hochladen
              </button>
            ) : (
              <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm space-y-4">
                <p className="text-sm font-semibold text-hp-black font-body">Dokument hinzufügen</p>

                {/* Typ-Auswahl */}
                <div className="flex gap-2 flex-wrap">
                  {(['kaufvertrag', 'mietvertrag', 'sonstige'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => { setContractDocType(t); if (t !== 'sonstige') setContractDocName('') }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors
                        ${contractDocType === t
                          ? 'text-white' : 'border border-gray-200 text-gray-600 hover:border-orange-300'}`}
                      style={contractDocType === t ? { backgroundColor: 'var(--color-highlight)' } : {}}>
                      {t === 'kaufvertrag' ? '📋 Kaufvertrag' : t === 'mietvertrag' ? '🏠 Mietvertrag' : '📄 Sonstige'}
                    </button>
                  ))}
                </div>

                {/* Name (nur bei Sonstige) */}
                {contractDocType === 'sonstige' && (
                  <div>
                    <label className="text-xs text-gray-500 font-body block mb-1">Bezeichnung <span className="text-red-400">*</span></label>
                    <input
                      value={contractDocName}
                      onChange={e => setContractDocName(e.target.value)}
                      placeholder="z.B. Reservierungsbestätigung, Grundbuchauszug …"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-body
                                 focus:outline-none focus:border-orange-400"
                    />
                  </div>
                )}

                {/* Datei */}
                <div>
                  <input
                    ref={contractDocRef}
                    type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) setContractDocFile(f) }}
                  />
                  <div
                    onClick={() => contractDocRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-3 cursor-pointer transition text-center
                      ${contractDocFile ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50 hover:border-gray-300'}`}>
                    {contractDocFile ? (
                      <div className="flex items-center justify-center gap-2">
                        <span>📄</span>
                        <span className="text-xs font-semibold text-gray-700 truncate max-w-[200px]">{contractDocFile.name}</span>
                        <button type="button"
                          onClick={e => { e.stopPropagation(); setContractDocFile(null); if (contractDocRef.current) contractDocRef.current.value = '' }}
                          className="text-red-400 hover:text-red-600 text-sm">✕</button>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400 font-body">PDF / Bild wählen</p>
                    )}
                  </div>
                </div>

                <div className="flex justify-end gap-3">
                  <button onClick={() => { setShowContractDoc(false); setContractDocFile(null) }}
                          className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-body text-gray-600 hover:bg-gray-50">
                    Abbrechen
                  </button>
                  <button
                    onClick={handleUploadContractDoc}
                    disabled={contractDocSaving || !contractDocFile || (contractDocType === 'sonstige' && !contractDocName.trim())}
                    className="px-5 py-2 rounded-xl text-white text-sm font-semibold font-body
                               hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    style={{ backgroundColor: 'var(--color-highlight)' }}>
                    {contractDocSaving && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                    {contractDocSaving ? 'Hochladen…' : 'Speichern'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Aktive Mietverträge (nur Admin) ─────────────────── */}
        {canEdit && (
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
        )}
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
        {(canEdit || isEigentuemer) && (
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

  // ── Eigentümer per E-Mail benachrichtigen ─────────────
  async function notifyOwner(fileName: string, kind: 'Dokument' | 'Bild' | 'Baustellenfoto') {
    const owner = property?.owner
    if (!owner?.email) return
    const firstName = owner.full_name?.split(' ')[0] || owner.full_name || 'Eigentümer'
    try {
      await supabase.functions.invoke('send-email', {
        body: {
          to:      owner.email,
          subject: 'Neue Datei in Ihrem Happy Property Portal',
          html:    `<p>Hallo ${firstName},</p>
<p>es wurde ein neues <strong>${kind}</strong> für Ihre Immobilie hochgeladen: <em>${fileName}</em></p>
<p>Sie können es jederzeit in Ihrem persönlichen Portal einsehen.</p>
<p>Viele Grüße<br>Ihr Happy Property Team</p>`,
        },
      })
    } catch (err) {
      console.warn('[PropertyDetail] notifyOwner failed:', err)
    }
  }

  // ── Baustellenfoto hochladen ──────────────────────────
  async function handleUploadConstructionPhoto(files: FileList) {
    if (!linkedProjectId || !files.length) return
    setUploadingPhoto(true)
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const ext  = file.name.split('.').pop() ?? 'jpg'
        const path = `${linkedProjectId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('construction-photos')
          .upload(path, file, { upsert: false })
        if (upErr) { console.error('[PropertyDetail] Upload error:', upErr); continue }
        await supabase.from('construction_photos').insert({
          project_id:  linkedProjectId,
          file_path:   path,
          file_name:   file.name,
          file_size:   file.size,
          photo_date:  photoDate || null,
          description: photoDesc.trim() || null,
          uploaded_by: profile?.id ?? null,
        })
      }
      void notifyOwner(`${files.length} neues Baustellenfoto${files.length > 1 ? 's' : ''}`, 'Baustellenfoto')
      setPhotoDesc('')
      if (constPhotoInputRef.current) constPhotoInputRef.current.value = ''
      await fetchUnitPayments()
    } catch (err) {
      console.error('[PropertyDetail] Baustellenfoto:', err)
    } finally {
      setUploadingPhoto(false)
    }
  }

  // ── Tab 5: Bilder ─────────────────────────────────────
  function renderImages() {
    const ownImages = property!.images ?? []

    // Helper: image grid (read-only)
    function ImageGrid({ images, emptyText }: { images: string[]; emptyText: string }) {
      if (images.length === 0) return (
        <p className="text-sm text-gray-400 font-body text-center py-6">{emptyText}</p>
      )
      return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {images.map((url, i) => (
            <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-gray-100">
              <img src={url} alt="" className="w-full h-full object-cover transition-transform hover:scale-105 cursor-pointer"
                   onClick={() => window.open(url, '_blank')} />
            </div>
          ))}
        </div>
      )
    }

    // Reihenfolge: aktive Einheit → Wohnungsbilder zuerst; Im Bau → Projektbilder zuerst
    const isActive = linkedUnit?.status === 'active' || property!.property_status === 'active'

    const sectionUnitImages = (
      <div>
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
          🏠 Wohnungsbilder
        </h3>
        <ImageGrid images={crmUnitImages} emptyText="Noch keine Wohnungsbilder vorhanden." />
      </div>
    )

    const sectionProjectImages = (
      <div>
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
          🏗 Projektbilder
        </h3>
        <ImageGrid images={crmProjectImages} emptyText="Noch keine Projektbilder vorhanden." />
      </div>
    )

    const sectionConstructionPhotos = constructionPhotos.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
              🏗️ Baustellenbilder
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {constructionPhotos.map(photo => {
                const isVideo = /\.(mp4|mov|webm|mpeg|m4v|avi)$/i.test(photo.file_name)
                const mediaUrl = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/construction-photos/${photo.file_path}`
                return (
                  <div key={photo.id} className="rounded-xl overflow-hidden bg-gray-100 border border-gray-100">
                    {isVideo ? (
                      <video
                        src={mediaUrl}
                        className="w-full aspect-square object-cover"
                        controls
                        preload="metadata"
                      />
                    ) : (
                      <img
                        src={mediaUrl}
                        alt={photo.file_name}
                        className="w-full aspect-square object-cover cursor-pointer transition-transform hover:scale-105"
                        onClick={() => window.open(mediaUrl, '_blank')}
                      />
                    )}
                    {(photo.photo_date || photo.description) && (
                      <div className="px-3 py-2 bg-white">
                        {photo.photo_date && (
                          <p className="text-xs font-medium text-gray-600 font-body">
                            📅 {new Date(photo.photo_date).toLocaleDateString('de-DE')}
                          </p>
                        )}
                        {photo.description && (
                          <p className="text-xs text-gray-400 font-body mt-0.5">{photo.description}</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
    ) : null

    return (
      <div className="space-y-8">

        {/* Reihenfolge: Aktiv → Wohnung zuerst | Im Bau → Projekt zuerst */}
        {isActive ? (
          <>
            {sectionUnitImages}
            {sectionProjectImages}
            {sectionConstructionPhotos}
          </>
        ) : (
          <>
            {sectionProjectImages}
            {sectionConstructionPhotos}
            {sectionUnitImages}
          </>
        )}

        {/* ── Baustellenfotos hochladen (Admin/Verwalter) ── */}
        {canEdit && linkedProjectId && (
          <div className="border-t border-gray-100 pt-6">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
              📷 Baustellenfoto hochladen
            </h3>
            <div className="bg-gray-50 rounded-2xl p-4 space-y-3">
              {/* Datum + Beschreibung */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 font-body mb-1">Datum</label>
                  <input
                    type="date"
                    value={photoDate}
                    onChange={e => setPhotoDate(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2
                               text-sm text-hp-black font-body focus:outline-none
                               focus:ring-2 focus:border-transparent transition"
                    style={{ '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 font-body mb-1">Beschreibung (optional)</label>
                  <input
                    type="text"
                    value={photoDesc}
                    onChange={e => setPhotoDesc(e.target.value)}
                    placeholder="z.B. Rohbau EG"
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2
                               text-sm text-hp-black font-body placeholder-gray-400
                               focus:outline-none focus:ring-2 focus:border-transparent transition"
                    style={{ '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties}
                  />
                </div>
              </div>
              {/* Upload-Button */}
              <button
                type="button"
                disabled={uploadingPhoto}
                onClick={() => constPhotoInputRef.current?.click()}
                className="w-full py-2.5 rounded-xl text-sm font-semibold font-body
                           flex items-center justify-center gap-2 transition-opacity
                           disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-highlight)', color: '#fff' }}>
                {uploadingPhoto
                  ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />Wird hochgeladen…</>
                  : '📷 Fotos / Videos auswählen'}
              </button>
              <input
                ref={constPhotoInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                className="hidden"
                onChange={e => { if (e.target.files) handleUploadConstructionPhoto(e.target.files) }}
              />
            </div>
          </div>
        )}

        {/* Bestehende Fotos aus properties (legacy, nur wenn vorhanden) */}
        {canEdit && ownImages.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide font-body mb-3">
              📁 Sonstige Fotos
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {ownImages.map((url, i) => (
                <div key={i} className="relative aspect-square rounded-xl overflow-hidden group bg-gray-100">
                  <img src={url} alt="" className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                  <button
                    onClick={() => setDeleteImgUrl(url)}
                    className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors
                               flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <span className="bg-red-600 text-white text-xs font-semibold font-body
                                     px-3 py-1.5 rounded-lg shadow">
                      {t('common.delete')}
                    </span>
                  </button>
                </div>
              ))}
            </div>
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

  // ── Tab 6: Kaufunterlagen ─────────────────────────────
  function renderPurchases() {
    if (unitPayLoading) return (
      <div className="flex justify-center py-20">
        <span className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: 'var(--color-highlight)', borderTopColor: 'transparent' }} />
      </div>
    )
    if (!linkedUnitId) return (
      <div className="text-center py-20 text-gray-400">
        <p className="text-4xl mb-3">📋</p>
        <p className="text-sm font-medium text-gray-500">Keine CRM-Einheit verknüpft.</p>
        {canEdit ? (
          <>
            <p className="text-xs mt-1 text-gray-400">
              Diese Immobilie ist mit keiner Einheit im CRM verbunden.<br />
              Öffne das Projekt im CRM und verknüpfe die Einheit mit dieser Immobilie.
            </p>
            <a
              href="/admin/crm/projects"
              className="inline-block mt-4 px-4 py-2 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ backgroundColor: 'var(--color-highlight)' }}
            >
              Zu den CRM-Projekten →
            </a>
          </>
        ) : (
          <p className="text-xs mt-1 text-gray-300">
            Kaufdaten werden nach Vertragsunterzeichnung hier angezeigt.
          </p>
        )}
      </div>
    )

    // Progressive disclosure: show row N only when row N-1 has invoice uploaded
    const visiblePayments = unitPayments.filter((_, idx) => {
      if (idx === 0) return true
      return !!unitPayments[idx - 1].invoice_path
    })

    // Gesamtbetrag = Bruttokaufpreis der Immobilie (fix, immer sichtbar)
    const grossTotal  = linkedUnit?.price_gross ?? property!.purchase_price_gross ?? 0
    const totalPaid   = unitPayments.filter(p => p.is_paid).reduce((s, p) => s + p.amount, 0)
    const outstanding = grossTotal - totalPaid
    const pct         = grossTotal > 0 ? Math.min((totalPaid / grossTotal) * 100, 100) : 0

    // Beschreibung: Prozentzahl entfernen ("1. Rate - 20%" → "1. Rate")
    function cleanDesc(s: string | null | undefined): string {
      return (s ?? '—').replace(/\s*[-–]\s*\d+(\.\d+)?%.*$/, '').trim()
    }

    // ── Helper: Datei-Aktionen (öffnen / download / löschen) ──
    function FileActions({
      path, filename, onRemove, canRemove,
    }: { path: string; filename: string; onRemove: () => void; canRemove: boolean }) {
      return (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => openUnitPaymentFile(path)}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium font-body truncate max-w-[130px]"
            title={filename}>
            📄 <span className="truncate">{filename}</span>
          </button>
          <button
            onClick={() => handleDownloadPaymentFile(path, filename)}
            className="text-gray-400 hover:text-gray-600 text-xs" title="Download">↓</button>
          {canRemove && (
            <button
              onClick={onRemove}
              className="text-gray-300 hover:text-red-500 text-xs" title="Entfernen">✕</button>
          )}
        </div>
      )
    }

    // ── Helper: Upload-Button ──────────────────────────────────
    function UploadBtn({
      payId, type, label,
    }: { payId: string; type: 'invoice' | 'receipt'; label: string }) {
      const isUploading = uploadingPayId === payId && uploadingPayType === type
      const ref = type === 'invoice' ? payInvoiceRef : payReceiptRef
      return (
        <>
          <input
            type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden"
            ref={el => { ref.current[payId] = el }}
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) handleUploadPaymentFile(payId, type, file)
              if (e.target) e.target.value = ''
            }}
          />
          <button
            onClick={() => ref.current[payId]?.click()}
            disabled={isUploading}
            className="text-xs font-medium transition-colors disabled:opacity-50 font-body"
            style={{ color: 'var(--color-highlight)' }}>
            {isUploading ? '↑ Hochladen…' : label}
          </button>
        </>
      )
    }

    return (
      <div className="space-y-6">

        {/* KPI cards — immer sichtbar wenn CRM-Unit verknüpft */}
        {grossTotal > 0 && (
          <>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-blue-50 rounded-2xl p-4 text-center">
                <p className="text-xs text-blue-500 font-medium font-body mb-1">Gesamtbetrag</p>
                <p className="text-lg font-bold text-blue-800">{fmtCurrency(grossTotal)}</p>
              </div>
              <div className="bg-green-50 rounded-2xl p-4 text-center">
                <p className="text-xs text-green-500 font-medium font-body mb-1">Bezahlt</p>
                <p className="text-lg font-bold text-green-800">{fmtCurrency(totalPaid)}</p>
              </div>
              <div className={`rounded-2xl p-4 text-center ${outstanding > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                <p className={`text-xs font-medium font-body mb-1 ${outstanding > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                  Ausstehend
                </p>
                <p className={`text-lg font-bold ${outstanding > 0 ? 'text-red-800' : 'text-gray-600'}`}>
                  {fmtCurrency(outstanding)}
                </p>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1.5 font-body">
                <span>{Math.round(pct)}% bezahlt</span>
                <span>{fmtCurrency(totalPaid)} / {fmtCurrency(grossTotal)}</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500"
                     style={{ width: `${pct}%`, backgroundColor: '#22c55e' }} />
              </div>
            </div>
          </>
        )}

        {/* ── Zahlungsraten ──────────────────────────────────── */}
        <div className="space-y-3">
          {visiblePayments.length === 0 && (
            <div className="text-center py-10 text-gray-400 font-body">
              <p className="text-3xl mb-2">📋</p>
              <p className="text-sm">Noch keine Einträge vorhanden.</p>
              <p className="text-xs mt-1 text-gray-300">
                Admin legt Raten an; lade dann jeweils die Rechnung hoch.
              </p>
            </div>
          )}

          {visiblePayments.map(pay => (
            <div key={pay.id}
                 className={`rounded-2xl border overflow-hidden ${pay.is_paid ? 'border-green-200' : 'border-gray-100'}`}>

              {/* ── Header: Titel + Betrag ─────────────────── */}
              <div className={`flex items-center justify-between gap-3 px-4 py-3
                ${pay.is_paid ? 'bg-green-50' : 'bg-white'}`}>
                <p className="text-sm font-semibold text-hp-black font-body">{cleanDesc(pay.description)}</p>

                {/* Betrag: nur wenn Rechnung vorhanden; bei 0 direkt Eingabefeld */}
                <div className="flex items-center gap-1.5 shrink-0 group">
                  {pay.invoice_path && (
                    (editingPayId === pay.id || pay.amount === 0) ? (
                      <div className="flex items-center gap-1">
                        <div className="relative">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">€</span>
                          <input
                            type="number" min="0" step="0.01"
                            autoFocus={editingPayId === pay.id || pay.amount === 0}
                            value={editingPayId === pay.id ? editingAmount : ''}
                            placeholder="Betrag eingeben"
                            onFocus={() => { if (editingPayId !== pay.id) { setEditingPayId(pay.id); setEditingAmount('') } }}
                            onChange={e => setEditingAmount(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveEditedAmount(pay.id)
                              if (e.key === 'Escape') setEditingPayId(null)
                            }}
                            className="w-36 pl-5 pr-2 py-1 text-xs border border-orange-300 rounded-lg focus:outline-none font-body"
                          />
                        </div>
                        {editingPayId === pay.id && (
                          <>
                            <button onClick={() => handleSaveEditedAmount(pay.id)}
                                    className="text-xs text-green-600 hover:text-green-800 font-semibold px-1">✓</button>
                            <button onClick={() => setEditingPayId(null)}
                                    className="text-xs text-gray-400 hover:text-gray-600">✕</button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 group">
                        <span className={`text-base font-bold font-body ${pay.is_paid ? 'text-green-700' : 'text-red-500'}`}>
                          {fmtCurrency(pay.amount)}
                        </span>
                        <button
                          onClick={() => { setEditingPayId(pay.id); setEditingAmount(String(pay.amount)) }}
                          className="opacity-0 group-hover:opacity-100 text-gray-400 text-xs transition-opacity" title="Betrag bearbeiten">✎</button>
                      </div>
                    )
                  )}
                  {(canEdit || isEigentuemer) && (
                    <button
                      onClick={() => handleDeletePaymentEntry(pay.id)}
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 text-xs transition-opacity ml-1" title="Eintrag löschen">🗑</button>
                  )}
                </div>
              </div>

              {/* ── Dokumente: Rechnung + Zahlungsbeleg ─────── */}
              <div className="grid grid-cols-2 gap-0 border-t border-gray-100">
                <div className="px-4 py-3 border-r border-gray-100">
                  <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1.5 font-body">
                    Rechnung
                  </p>
                  {pay.invoice_path ? (
                    <FileActions
                      path={pay.invoice_path}
                      filename={pay.invoice_filename ?? 'Rechnung'}
                      canRemove={canEdit || isEigentuemer}
                      onRemove={() => handleRemovePaymentFile(pay.id, 'invoice')}
                    />
                  ) : (canEdit || isEigentuemer) ? (
                    <UploadBtn payId={pay.id} type="invoice" label="+ Rechnung hochladen" />
                  ) : (
                    <span className="text-xs text-gray-300 font-body">—</span>
                  )}
                </div>
                <div className="px-4 py-3">
                  <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1.5 font-body">
                    Zahlungsbeleg
                  </p>
                  {pay.receipt_path ? (
                    <FileActions
                      path={pay.receipt_path}
                      filename={pay.receipt_filename ?? 'Zahlungsbeleg'}
                      canRemove={canEdit || isEigentuemer}
                      onRemove={() => handleRemovePaymentFile(pay.id, 'receipt')}
                    />
                  ) : (canEdit || isEigentuemer) ? (
                    <UploadBtn payId={pay.id} type="receipt" label="↑ Beleg hochladen" />
                  ) : (
                    <span className="text-xs text-gray-300 font-body">—</span>
                  )}
                </div>
              </div>

              {/* ── Zahlungsstatus — nur wenn Rechnung vorhanden ── */}
              {pay.invoice_path && (
                <div className={`border-t px-4 py-3 ${pay.is_paid ? 'border-green-200 bg-green-50' : 'border-gray-100 bg-gray-50/60'}`}>
                  {pay.is_paid ? (
                    /* BEZAHLT */
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-base">✅</span>
                        <div>
                          <p className="text-sm font-semibold text-green-700 font-body">Bezahlt</p>
                          {pay.paid_date && (
                            <p className="text-xs text-green-600 font-body">am {fmtDate(pay.paid_date)}</p>
                          )}
                        </div>
                      </div>
                      {unmarkConfirmId === pay.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 font-body">Wirklich zurücknehmen?</span>
                          <button
                            onClick={() => handleUnmarkAsPaid(pay.id)}
                            className="text-xs font-semibold text-red-600 hover:text-red-800 font-body transition-colors">
                            Ja
                          </button>
                          <button
                            onClick={() => setUnmarkConfirmId(null)}
                            className="text-xs text-gray-400 hover:text-gray-600 font-body transition-colors">
                            Nein
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setUnmarkConfirmId(pay.id)}
                          className="text-xs text-gray-400 hover:text-red-500 font-body transition-colors underline">
                          Rückgängig
                        </button>
                      )}
                    </div>
                  ) : markingPaidId === pay.id ? (
                    /* DATUM EINGEBEN */
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-gray-600 font-body">Wann wurde die Zahlung überwiesen?</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="date" autoFocus
                          value={markingPaidDate}
                          onChange={e => setMarkingPaidDate(e.target.value)}
                          className="flex-1 text-sm border border-green-300 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-300 font-body"
                        />
                        <button
                          onClick={() => handleMarkAsPaid(pay.id, markingPaidDate)}
                          className="px-4 py-2 rounded-xl text-sm font-semibold text-white font-body
                                     hover:opacity-90 transition-opacity flex items-center gap-1.5"
                          style={{ backgroundColor: '#22c55e' }}>
                          ✓ Speichern
                        </button>
                        <button
                          onClick={() => setMarkingPaidId(null)}
                          className="px-3 py-2 rounded-xl text-sm text-gray-500 border border-gray-200 hover:bg-gray-100 font-body">
                          Abbrechen
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* NOCH NICHT BEZAHLT */
                    <button
                      onClick={() => { setMarkingPaidId(pay.id); setMarkingPaidDate(new Date().toISOString().split('T')[0]) }}
                      className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border-2
                                 border-dashed border-green-200 text-sm font-semibold text-green-600
                                 hover:bg-green-50 hover:border-green-400 transition-colors font-body">
                      ✓ Als bezahlt markieren
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Rechnung hinzufügen ────────────────────────────── */}
        {(canEdit || isEigentuemer) && (
          <div>
            {!showAddPayForm ? (
              <button
                onClick={() => {
                  setShowAddPayForm(true)
                  setAddPayDesc(nextPaymentLabel())
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border-2
                           border-dashed border-gray-200 text-sm font-medium text-gray-400
                           hover:border-orange-300 hover:text-orange-500 transition-colors font-body">
                <span className="text-lg">+</span> Rechnung hinzufügen
              </button>
            ) : (
              <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm space-y-4">
                <p className="text-sm font-semibold text-hp-black font-body">Neue Rate hinzufügen</p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 font-body block mb-1">Bezeichnung</label>
                    <input
                      value={addPayDesc}
                      onChange={e => setAddPayDesc(e.target.value)}
                      placeholder="z.B. Reservierung, 1. Rate …"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-body
                                 focus:outline-none focus:border-orange-400"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 font-body block mb-1">
                      Betrag (€)
                      {addPayAnalyzing && (
                        <span className="ml-2 text-orange-400 font-normal">KI liest…</span>
                      )}
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">€</span>
                      <input
                        type="number" min="0" step="0.01"
                        value={addPayAmount}
                        onChange={e => setAddPayAmount(e.target.value)}
                        placeholder="0,00"
                        className="w-full pl-7 border border-gray-200 rounded-xl px-3 py-2 text-sm font-body
                                   focus:outline-none focus:border-orange-400"
                      />
                    </div>
                  </div>
                </div>

                {/* PDF Upload mit KI-Erkennung */}
                <div>
                  <label className="text-xs text-gray-500 font-body block mb-1">
                    Rechnung hochladen (optional — KI liest Betrag automatisch aus)
                  </label>
                  <input
                    ref={addPayFileRef}
                    type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) handleAddPayInvoice(file)
                    }}
                  />
                  <div
                    onClick={() => addPayFileRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-3 cursor-pointer transition text-center
                      ${addPayFile ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50 hover:border-gray-300'}`}>
                    {addPayFile ? (
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-lg">📄</span>
                        <span className="text-xs font-semibold text-gray-700 truncate max-w-[200px]">{addPayFile.name}</span>
                        <button type="button"
                          onClick={e => { e.stopPropagation(); setAddPayFile(null); if (addPayFileRef.current) addPayFileRef.current.value = '' }}
                          className="text-red-400 hover:text-red-600 text-sm">✕</button>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400 font-body">PDF / Bild · max. 50 MB</p>
                    )}
                  </div>
                </div>

                <div className="flex justify-end gap-3">
                  <button onClick={() => { setShowAddPayForm(false); setAddPayFile(null) }}
                          className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-body text-gray-600 hover:bg-gray-50">
                    Abbrechen
                  </button>
                  <button
                    onClick={handleAddPayment}
                    disabled={addPaySaving || addPayAnalyzing || (!addPayAmount && !addPayFile)}
                    className="px-5 py-2 rounded-xl text-white text-sm font-semibold font-body
                               hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                    style={{ backgroundColor: 'var(--color-highlight)' }}>
                    {addPaySaving && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                    {addPaySaving ? 'Speichern…' : 'Hinzufügen'}
                  </button>
                </div>
              </div>
            )}
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
    { key: 'overview',    label: t('propertyDetail.tabs.overview') },
    { key: 'verwaltung',  label: 'Verwaltung' },
    { key: 'contracts',   label: t('propertyDetail.tabs.contracts'),
      count: (contracts.length + mietvertragCount + unitKaufvertraege.length) || undefined },
    { key: 'invoices',   label: t('propertyDetail.tabs.invoices'),
      count: rechnungCount || undefined },
    { key: 'income',     label: t('propertyDetail.tabs.income') },
    { key: 'images',     label: t('propertyDetail.tabs.images'),
      count: ((p.images?.length || 0) + crmProjectImages.length + crmUnitImages.length) || undefined },
    { key: 'purchases',  label: 'Payment Plan',
      count: unitPayments.length || undefined },
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
          <Badge color="blue">{t(`properties.types.${linkedUnit?.type ?? p.type}`)}</Badge>
          <Badge color="orange">{t(`properties.rental.${linkedUnit?.rental_type === 'long' ? 'longterm' : linkedUnit?.rental_type === 'short' ? 'shortterm' : (p.rental_type ?? 'longterm')}`)}</Badge>
          {(linkedUnit?.is_furnished ?? p.is_furnished) && <Badge color="green">🛋️ {t('properties.furnishedYes')}</Badge>}
          {p.owner && <Badge color="purple">{p.owner.full_name || p.owner.email}</Badge>}
          {(linkedUnit?.price_gross ?? p.purchase_price_gross) && (
            <Badge color="green">{fmtCurrency((linkedUnit?.price_gross ?? p.purchase_price_gross)!)}</Badge>
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
        {activeTab === 'overview'   && renderOverview()}
        {activeTab === 'verwaltung' && renderVerwaltung()}
        {activeTab === 'contracts'  && renderContracts()}
        {activeTab === 'invoices'  && renderInvoices()}
        {activeTab === 'income'    && renderIncome()}
        {activeTab === 'images'    && renderImages()}
        {activeTab === 'purchases' && renderPurchases()}
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
