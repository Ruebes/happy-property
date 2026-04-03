import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../components/DashboardLayout'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useDateFormat } from '../lib/date'

// ── Types ──────────────────────────────────────────────────────
type DocType = 'mietvertrag' | 'rechnung' | 'sonstiges'

interface Document {
  id: string
  property_id: string
  uploaded_by: string
  type: DocType
  title: string
  file_url: string          // storage path (relative)
  amount_net: number | null
  amount_gross: number | null
  creditor: string | null
  uploaded_at: string
  property: { project_name: string; unit_number: string | null } | null
  uploader: { full_name: string; email: string } | null
}

interface PropertyOption {
  id: string
  project_name: string
  unit_number: string | null
}

interface UploadForm {
  property_id: string
  type: DocType
  title: string
  file: File | null
  amount_net: string
  amount_gross: string
  creditor: string
}

const EMPTY_UPLOAD: UploadForm = {
  property_id: '',
  type: 'sonstiges',
  title: '',
  file: null,
  amount_net: '',
  amount_gross: '',
  creditor: '',
}

const MAX_PDF_BYTES = 50 * 1024 * 1024 // 50 MB

function sanitizeFilename(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-')
}

// ── Toast ──────────────────────────────────────────────────────
function Toast({ message, type = 'success', onClose }: {
  message: string
  type?: 'success' | 'error'
  onClose: () => void
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 4500)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className={`fixed bottom-6 right-6 z-50 text-sm font-body px-5 py-3 rounded-xl shadow-lg
                     max-w-sm ${type === 'error' ? 'bg-red-600 text-white' : 'bg-hp-black text-white'}`}>
      {message}
    </div>
  )
}

// ── Type badge ─────────────────────────────────────────────────
function TypeBadge({ type, label }: { type: DocType; label: string }) {
  const cls: Record<DocType, string> = {
    mietvertrag: 'bg-blue-50 text-blue-700',
    rechnung:    'bg-amber-50 text-amber-700',
    sonstiges:   'bg-gray-100 text-gray-600',
  }
  return (
    <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full font-body ${cls[type]}`}>
      {label}
    </span>
  )
}

const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-hp-black text-sm font-body focus:outline-none focus:ring-2 focus:border-transparent transition'
const focusRing = () => ({ '--tw-ring-color': 'var(--color-highlight)' } as React.CSSProperties)

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-hp-black font-body mb-1.5">
      {children}{required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  )
}

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════
export default function Dokumente() {
  const { t }             = useTranslation()
  const { profile }       = useAuth()
  const { fmtDate, fmtCurrency } = useDateFormat()

  // List state
  const [documents, setDocuments]     = useState<Document[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [filterType, setFilterType]   = useState<'all' | DocType>('all')
  const [search, setSearch]           = useState('')

  // Properties for dropdown
  const [propOptions, setPropOptions]     = useState<PropertyOption[]>([])
  const [loadingProps, setLoadingProps]   = useState(false)

  // Upload modal
  const [showUpload, setShowUpload]   = useState(false)
  const [uploadForm, setUploadForm]   = useState<UploadForm>(EMPTY_UPLOAD)
  const [uploading, setUploading]     = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Toast
  const [toast, setToast] = useState<{ msg: string; type?: 'success' | 'error' } | null>(null)

  const canEdit = profile?.role === 'admin' || profile?.role === 'verwalter'

  // ── Fetch documents ────────────────────────────────────────
  const fetchDocuments = useCallback(async () => {
    setLoadingList(true)
    const query = supabase
      .from('documents')
      .select(`
        *,
        property:property_id(project_name, unit_number),
        uploader:uploaded_by(full_name, email)
      `)
      .order('uploaded_at', { ascending: false })
      .limit(500)

    const { data } = await query
    setDocuments((data as Document[]) ?? [])
    setLoadingList(false)
  }, [])

  useEffect(() => { fetchDocuments() }, [fetchDocuments])

  // ── Fetch properties for upload form ──────────────────────
  const fetchProperties = useCallback(async () => {
    setLoadingProps(true)
    const { data } = await supabase
      .from('properties')
      .select('id, project_name, unit_number')
      .order('project_name')
    setPropOptions((data as PropertyOption[]) ?? [])
    setLoadingProps(false)
  }, [])

  // ── Filtered + searched list ──────────────────────────────
  const filtered = documents.filter(d => {
    const matchType   = filterType === 'all' || d.type === filterType
    const matchSearch = !search ||
      d.title.toLowerCase().includes(search.toLowerCase()) ||
      (d.property?.project_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (d.creditor ?? '').toLowerCase().includes(search.toLowerCase())
    return matchType && matchSearch
  })

  // ── Open upload modal ─────────────────────────────────────
  function openUpload() {
    setUploadForm(EMPTY_UPLOAD)
    setUploadError('')
    fetchProperties()
    setShowUpload(true)
  }

  function closeUpload() {
    setShowUpload(false)
    setUploadForm(EMPTY_UPLOAD)
    setUploadError('')
  }

  function setField<K extends keyof UploadForm>(k: K, v: UploadForm[K]) {
    setUploadForm(prev => ({ ...prev, [k]: v }))
  }

  // ── File validation ───────────────────────────────────────
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type !== 'application/pdf') {
      setUploadError(t('documents.wrongType'))
      e.target.value = ''
      return
    }
    if (file.size > MAX_PDF_BYTES) {
      setUploadError(t('documents.fileTooLarge'))
      e.target.value = ''
      return
    }
    setUploadError('')
    setField('file', file)
    if (!uploadForm.title) {
      setField('title', file.name.replace(/\.pdf$/i, '').replace(/[-_]/g, ' '))
    }
  }

  // ── Upload ────────────────────────────────────────────────
  async function handleUpload() {
    if (!profile || !uploadForm.property_id || !uploadForm.title || !uploadForm.file) return
    setUploading(true)
    setUploadError('')

    // Random suffix prevents duplicate-path errors on re-upload of same file
    const rand        = Math.random().toString(36).slice(2, 8)
    const safeName    = sanitizeFilename(uploadForm.file.name)
    const storagePath = `${uploadForm.property_id}/${Date.now()}-${rand}-${safeName}`

    try {
      // 1. Upload file to storage
      const { error: storageErr } = await supabase.storage
        .from('documents')
        .upload(storagePath, uploadForm.file, { upsert: true })

      if (storageErr) throw new Error(storageErr.message)

      // 2. Insert document record (store storage path, not full URL)
      const { error: dbErr } = await supabase.from('documents').insert({
        property_id:  uploadForm.property_id,
        uploaded_by:  profile.id,
        type:         uploadForm.type,
        title:        uploadForm.title.trim(),
        file_url:     storagePath,
        amount_net:   uploadForm.amount_net   ? parseFloat(uploadForm.amount_net.replace(',', '.'))   : null,
        amount_gross: uploadForm.amount_gross ? parseFloat(uploadForm.amount_gross.replace(',', '.'))  : null,
        creditor:     uploadForm.creditor.trim() || null,
      })

      if (dbErr) {
        // Roll back the storage upload on DB failure
        await supabase.storage.from('documents').remove([storagePath])
        throw new Error(dbErr.message)
      }

      closeUpload()
      setToast({ msg: t('success.uploaded') })
      fetchDocuments()

    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('errors.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  // ── View / Download PDF ───────────────────────────────────
  async function openPdf(filePath: string) {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(filePath, 3600) // 1-hour URL
    if (error || !data?.signedUrl) {
      setToast({ msg: t('errors.serverError'), type: 'error' })
      return
    }
    window.open(data.signedUrl, '_blank')
  }

  async function downloadPdf(filePath: string, title: string) {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(filePath, 60)
    if (error || !data?.signedUrl) {
      setToast({ msg: t('errors.serverError'), type: 'error' })
      return
    }
    const a = document.createElement('a')
    a.href = data.signedUrl
    a.download = `${title}.pdf`
    a.click()
  }

  // ── Delete ────────────────────────────────────────────────
  async function handleDelete(doc: Document) {
    if (!window.confirm(t('documents.deleteConfirm'))) return

    // Remove file from storage
    await supabase.storage.from('documents').remove([doc.file_url])

    // Remove DB record
    await supabase.from('documents').delete().eq('id', doc.id)

    setToast({ msg: t('success.deleted') })
    fetchDocuments()
  }

  // ── Prop label helper ─────────────────────────────────────
  function propLabel(d: Document) {
    if (!d.property) return t('common.na')
    const { project_name, unit_number } = d.property
    return unit_number ? `${project_name} · ${unit_number}` : project_name
  }

  function propOptionLabel(p: PropertyOption) {
    return p.unit_number ? `${p.project_name} – ${p.unit_number}` : p.project_name
  }

  // ── Amount display ────────────────────────────────────────
  function amountDisplay(d: Document) {
    if (d.amount_gross != null) return fmtCurrency(d.amount_gross)
    if (d.amount_net != null)   return fmtCurrency(d.amount_net)
    return t('common.na')
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <DashboardLayout basePath={`/${profile?.role ?? 'eigentuemer'}/dashboard`}>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
        <h1 className="text-3xl font-bold text-hp-black flex-1"
            style={{ fontFamily: 'var(--font-heading)' }}>
          {t('documents.title')}
        </h1>

        {/* Search */}
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">🔍</span>
          <input
            className="pl-8 pr-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-body
                       focus:outline-none focus:ring-2 transition w-56"
            style={focusRing()}
            placeholder={t('common.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {canEdit && (
          <button onClick={openUpload}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white
                       text-sm font-semibold font-body hover:opacity-90 transition-opacity shrink-0"
            style={{ backgroundColor: 'var(--color-highlight)' }}>
            <span className="text-lg leading-none">+</span>
            {t('documents.upload')}
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {(['all', 'mietvertrag', 'rechnung', 'sonstiges'] as const).map(f => (
          <button key={f}
            onClick={() => setFilterType(f)}
            className={`px-4 py-1.5 rounded-full text-xs font-semibold font-body transition-colors
              ${filterType === f
                ? 'text-white'
                : 'bg-white border border-gray-200 text-gray-500 hover:border-gray-300'}`}
            style={filterType === f ? { backgroundColor: 'var(--color-highlight)' } : {}}>
            {f === 'all'
              ? t('documents.filterAll')
              : t(`documents.types.${f}`)}
          </button>
        ))}
        {filtered.length > 0 && (
          <span className="ml-auto text-xs text-gray-400 font-body self-center">
            {filtered.length} {filtered.length === 1
              ? t('documents.columns.title')
              : t('documents.title').toLowerCase()}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {loadingList ? (
          <div className="flex items-center justify-center py-16 text-gray-400 font-body text-sm gap-2">
            <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
            {t('common.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 font-body">
            <div className="text-4xl mb-3">📄</div>
            <p className="text-sm">
              {search || filterType !== 'all'
                ? t('common.noResults')
                : t('documents.empty')}
            </p>
            {canEdit && !search && filterType === 'all' && (
              <button onClick={openUpload}
                className="mt-4 text-sm font-semibold underline"
                style={{ color: 'var(--color-highlight)' }}>
                {t('documents.upload')}
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('documents.columns.title')}
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('documents.columns.type')}
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('documents.columns.property')}
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('documents.columns.date')}
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('documents.columns.amount')}
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('documents.columns.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((doc, i) => (
                  <tr key={doc.id}
                      className={`hover:bg-gray-50 transition-colors
                        ${i < filtered.length - 1 ? 'border-b border-gray-50' : ''}`}>
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-hp-black">{doc.title}</div>
                      {doc.creditor && (
                        <div className="text-xs text-gray-400 mt-0.5">{doc.creditor}</div>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <TypeBadge type={doc.type} label={t(`documents.types.${doc.type}`)} />
                    </td>
                    <td className="px-5 py-3.5 text-gray-600 max-w-[160px] truncate">
                      {propLabel(doc)}
                    </td>
                    <td className="px-5 py-3.5 text-gray-500">
                      {fmtDate(doc.uploaded_at)}
                    </td>
                    <td className="px-5 py-3.5 text-gray-600 tabular-nums">
                      {amountDisplay(doc)}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        {/* View PDF */}
                        <button
                          onClick={() => openPdf(doc.file_url)}
                          title={t('documents.viewPdf')}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg
                                     border border-gray-200 text-gray-600
                                     hover:border-hp-highlight hover:text-hp-highlight transition-colors">
                          PDF
                        </button>
                        {/* Download PDF */}
                        <button
                          onClick={() => downloadPdf(doc.file_url, doc.title)}
                          title={t('documents.downloadPdf')}
                          className="text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                     border border-gray-200 text-gray-600
                                     hover:border-gray-400 hover:text-gray-800 transition-colors">
                          ↓
                        </button>
                        {/* Delete (admin/verwalter only) */}
                        {canEdit && (
                          <button
                            onClick={() => handleDelete(doc)}
                            title={t('common.delete')}
                            className="text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                       border border-red-100 text-red-400
                                       hover:border-red-300 hover:text-red-600 transition-colors">
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

      {/* ── Upload Modal ── */}
      {showUpload && (
        <div className="fixed inset-0 z-40 flex items-start justify-center p-4 pt-12 overflow-y-auto"
             style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
             onClick={closeUpload}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-7 my-4 space-y-4"
               onClick={e => e.stopPropagation()}>

            {/* Modal header */}
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-hp-black"
                  style={{ fontFamily: 'var(--font-heading)' }}>
                {t('documents.upload')}
              </h2>
              <button onClick={closeUpload} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            {/* Property */}
            <div>
              <Label required>{t('documents.property')}</Label>
              {loadingProps ? (
                <div className={`${inputCls} text-gray-400 flex items-center gap-2`}>
                  <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
                  {t('common.loading')}
                </div>
              ) : (
                <select className={inputCls} style={focusRing()}
                  value={uploadForm.property_id}
                  onChange={e => setField('property_id', e.target.value)}>
                  <option value="">{t('documents.selectProperty')}</option>
                  {propOptions.map(p => (
                    <option key={p.id} value={p.id}>{propOptionLabel(p)}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Doc type */}
            <div>
              <Label required>{t('documents.type')}</Label>
              <select className={inputCls} style={focusRing()}
                value={uploadForm.type}
                onChange={e => setField('type', e.target.value as DocType)}>
                {(['mietvertrag', 'rechnung', 'sonstiges'] as const).map(v => (
                  <option key={v} value={v}>{t(`documents.types.${v}`)}</option>
                ))}
              </select>
            </div>

            {/* Title */}
            <div>
              <Label required>{t('documents.titleField')}</Label>
              <input className={inputCls} style={focusRing()}
                value={uploadForm.title}
                onChange={e => setField('title', e.target.value)}
                placeholder={t('documents.titleField')} />
            </div>

            {/* File drop zone */}
            <div>
              <Label required>{t('documents.file')}</Label>
              <div
                onClick={() => fileRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer
                            transition-all
                            ${uploadForm.file
                              ? 'border-green-300 bg-green-50'
                              : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white'}`}>
                <input ref={fileRef} type="file" accept="application/pdf"
                  className="hidden" onChange={handleFileChange} />
                {uploadForm.file ? (
                  <div className="flex items-center justify-center gap-3">
                    <span className="text-2xl">📄</span>
                    <div className="text-left">
                      <p className="text-sm font-semibold text-gray-700 font-body">
                        {uploadForm.file.name}
                      </p>
                      <p className="text-xs text-gray-400 font-body">
                        {(uploadForm.file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                    <button type="button"
                      onClick={e => { e.stopPropagation(); setField('file', null); if (fileRef.current) fileRef.current.value = '' }}
                      className="ml-auto text-red-400 hover:text-red-600 text-lg">✕</button>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-body text-gray-500">
                      PDF {t('common.upload').toLowerCase()} · klicken oder hierhin ziehen
                    </p>
                    <p className="text-xs text-gray-400 font-body mt-0.5">
                      max. 50 MB
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Amount fields (always visible but highlighted for Rechnung) */}
            {(uploadForm.type === 'rechnung' || uploadForm.amount_gross || uploadForm.amount_net) && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t('documents.amountNet')}</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">€</span>
                    <input type="number" min="0" step="0.01"
                      className={`${inputCls} pl-7`} style={focusRing()}
                      value={uploadForm.amount_net}
                      onChange={e => setField('amount_net', e.target.value)}
                      placeholder="0.00" />
                  </div>
                </div>
                <div>
                  <Label>{t('documents.amountGross')}</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">€</span>
                    <input type="number" min="0" step="0.01"
                      className={`${inputCls} pl-7`} style={focusRing()}
                      value={uploadForm.amount_gross}
                      onChange={e => setField('amount_gross', e.target.value)}
                      placeholder="0.00" />
                  </div>
                </div>
              </div>
            )}

            {/* Creditor */}
            <div>
              <Label>{t('documents.creditor')}</Label>
              <input className={inputCls} style={focusRing()}
                value={uploadForm.creditor}
                onChange={e => setField('creditor', e.target.value)}
                placeholder="z. B. Stadtwerke München GmbH" />
            </div>

            {/* Show amount fields toggle for non-rechnung */}
            {uploadForm.type !== 'rechnung' && !uploadForm.amount_gross && !uploadForm.amount_net && (
              <button type="button"
                onClick={() => setField('amount_gross', '0')}
                className="text-xs font-body text-gray-400 hover:text-gray-600 underline transition-colors">
                + {t('documents.amountGross')} / {t('documents.amountNet')} hinzufügen
              </button>
            )}

            {uploadError && (
              <p className="text-sm text-red-500 font-body bg-red-50 px-4 py-2 rounded-lg">
                {uploadError}
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={closeUpload}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm
                           font-semibold font-body text-gray-600 hover:border-gray-300 transition-colors">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={handleUpload}
                disabled={uploading || !uploadForm.property_id || !uploadForm.title || !uploadForm.file}
                className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold
                           font-body hover:opacity-90 disabled:opacity-50 transition-opacity
                           flex items-center justify-center gap-2"
                style={{ backgroundColor: 'var(--color-highlight)' }}>
                {uploading && (
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                )}
                {uploading ? t('documents.uploading') : t('documents.upload')}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

    </DashboardLayout>
  )
}
