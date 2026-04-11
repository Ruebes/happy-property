import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import {
  type WorkflowDocument,
  type DocumentCategory,
  uploadDocument,
  deleteDocument,
  toggleDocumentActive,
  getPreviewUrl,
  listWorkflowDocuments,
  formatFileSize,
} from '../../../../lib/workflowDocuments'

// ── Konstanten ────────────────────────────────────────────────────────────────

const CATEGORIES: { value: DocumentCategory | 'all'; labelKey: string; icon: string }[] = [
  { value: 'all',             labelKey: 'docs.cat.all',          icon: '📁' },
  { value: 'finanzierung_de', labelKey: 'docs.cat.finDE',        icon: '🏦' },
  { value: 'finanzierung_cy', labelKey: 'docs.cat.finCY',        icon: '🌍' },
  { value: 'willkommen',      labelKey: 'docs.cat.welcome',      icon: '👋' },
  { value: 'kaufvertrag',     labelKey: 'docs.cat.contract',     icon: '📝' },
  { value: 'sonstiges',       labelKey: 'docs.cat.misc',         icon: '📄' },
]

const MAX_FILE_SIZE = 10 * 1024 * 1024  // 10 MB

// ── Upload Modal ──────────────────────────────────────────────────────────────

interface UploadModalProps {
  file:        File
  onClose:     () => void
  onUploaded:  () => void
}

function UploadModal({ file, onClose, onUploaded }: UploadModalProps) {
  const { t } = useTranslation()
  const [name,        setName]        = useState(file.name.replace(/\.[^.]+$/, ''))
  const [description, setDescription] = useState('')
  const [category,    setCategory]    = useState<DocumentCategory>('sonstiges')
  const [uploading,   setUploading]   = useState(false)
  const [error,       setError]       = useState('')

  const handleUpload = async () => {
    if (!name.trim()) { setError(t('docs.upload.nameRequired', 'Name ist Pflicht')); return }
    setUploading(true)
    setError('')
    const result = await uploadDocument({ file, name, description, category })
    if (!result.success) {
      setError(result.error ?? t('docs.upload.failed', 'Upload fehlgeschlagen'))
      setUploading(false)
      return
    }
    onUploaded()
    onClose()
  }

  const inputCls = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            📄 {t('docs.upload.title', 'Dokument hochladen')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">

          {/* Datei-Info */}
          <div className="flex items-center gap-3 bg-orange-50 border border-orange-100 rounded-xl px-4 py-3">
            <span className="text-2xl">📄</span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
              <p className="text-xs text-gray-400">{formatFileSize(file.size)}</p>
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              {t('docs.upload.name', 'Name')} *
            </label>
            <input
              className={inputCls}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('docs.upload.namePlaceholder', 'z.B. Finanzierungsantrag DE')}
              autoFocus
            />
          </div>

          {/* Beschreibung */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              {t('docs.upload.description', 'Beschreibung')} ({t('common.optional', 'optional')})
            </label>
            <input
              className={inputCls}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('docs.upload.descPlaceholder', 'Kurze Beschreibung des Dokuments')}
            />
          </div>

          {/* Kategorie */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              {t('docs.upload.category', 'Kategorie')} *
            </label>
            <select
              className={inputCls}
              value={category}
              onChange={e => setCategory(e.target.value as DocumentCategory)}
            >
              {CATEGORIES.filter(c => c.value !== 'all').map(c => (
                <option key={c.value} value={c.value}>
                  {c.icon} {t(c.labelKey, c.value)}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-1">
              {t('docs.upload.categoryHint', 'Das Dokument wird automatisch bei passenden E-Mails angehängt.')}
            </p>
          </div>

          {/* Fehler */}
          {error && (
            <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-xl">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            disabled={uploading}
            className="px-4 py-2 rounded-xl text-sm text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button
            onClick={handleUpload}
            disabled={uploading || !name.trim()}
            className="px-5 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            style={{ backgroundColor: '#ff795d' }}
          >
            {uploading && (
              <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            )}
            {uploading
              ? t('docs.upload.uploading', 'Wird hochgeladen…')
              : t('docs.upload.submit', 'Hochladen')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Dokument-Karte ────────────────────────────────────────────────────────────

interface DocCardProps {
  doc:        WorkflowDocument
  onDeleted:  () => void
  onToggled:  (id: string, active: boolean) => void
  onPreview:  (doc: WorkflowDocument) => void
  onReplace:  (doc: WorkflowDocument) => void
}

function DocCard({ doc, onDeleted, onToggled, onPreview, onReplace }: DocCardProps) {
  const { t }           = useTranslation()
  const [deleting,  setDeleting]  = useState(false)
  const [toggling,  setToggling]  = useState(false)
  const [previewing, setPreviewing] = useState(false)

  const catItem = CATEGORIES.find(c => c.value === doc.category)

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const handleDelete = async () => {
    if (!window.confirm(t('docs.deleteConfirm', 'Dokument wirklich löschen?'))) return
    setDeleting(true)
    const result = await deleteDocument(doc)
    if (!result.success) {
      alert(result.error)
      setDeleting(false)
      return
    }
    onDeleted()
  }

  const handleToggle = async () => {
    setToggling(true)
    await toggleDocumentActive(doc.id, !doc.active)
    onToggled(doc.id, !doc.active)
    setToggling(false)
  }

  const handlePreview = async () => {
    setPreviewing(true)
    onPreview(doc)
    setPreviewing(false)
  }

  return (
    <div className={`bg-white rounded-2xl border shadow-sm p-5 flex flex-col gap-3 transition-opacity ${
      doc.active ? 'border-gray-100' : 'border-gray-100 opacity-60'
    }`}>

      {/* Icon + Name */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-50 flex items-center justify-center text-xl flex-shrink-0">
          📄
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm text-gray-900 leading-tight truncate">{doc.name}</p>
          <p className="text-xs text-gray-400 truncate mt-0.5">{doc.file_name}</p>
          {doc.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{doc.description}</p>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="flex items-center gap-2 flex-wrap">
        {catItem && (
          <span className="text-xs bg-orange-50 text-orange-700 border border-orange-100 px-2 py-0.5 rounded-full">
            {catItem.icon} {t(catItem.labelKey, catItem.value)}
          </span>
        )}
        <span className="text-xs text-gray-400">
          {formatFileSize(doc.file_size)} · {fmtDate(doc.created_at)}
        </span>
      </div>

      {/* Aktionen */}
      <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-50">
        <button
          onClick={handlePreview}
          disabled={previewing}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600 transition-colors disabled:opacity-50"
        >
          {previewing
            ? <span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
            : '👁'}
          {t('docs.preview', 'Vorschau')}
        </button>

        <button
          onClick={() => onReplace(doc)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600 transition-colors"
        >
          🔄 {t('docs.replace', 'Ersetzen')}
        </button>

        <button
          onClick={handleDelete}
          disabled={deleting}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-red-400 hover:border-red-300 hover:bg-red-50 transition-colors disabled:opacity-50 ml-auto"
        >
          {deleting
            ? <span className="w-3 h-3 border-2 border-red-300 border-t-red-500 rounded-full animate-spin" />
            : '🗑'}
          {t('common.delete', 'Löschen')}
        </button>
      </div>

      {/* Aktiv Toggle */}
      <div className="flex items-center gap-2.5 pt-1">
        <button
          onClick={handleToggle}
          disabled={toggling}
          className={`relative w-9 h-5 rounded-full transition-colors disabled:opacity-50 ${
            doc.active ? 'bg-green-500' : 'bg-gray-200'
          }`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            doc.active ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </button>
        <span className={`text-xs font-medium ${doc.active ? 'text-green-600' : 'text-gray-400'}`}>
          {doc.active
            ? t('docs.active', 'Aktiv – wird mitgesendet')
            : t('docs.inactive', 'Inaktiv')}
        </span>
      </div>
    </div>
  )
}

// ── Drag & Drop Zone ──────────────────────────────────────────────────────────

interface DropZoneProps {
  onFile: (file: File) => void
}

function DropZone({ onFile }: DropZoneProps) {
  const { t }        = useTranslation()
  const inputRef     = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error,    setError]    = useState('')

  const validateAndAccept = (file: File) => {
    setError('')
    if (file.type !== 'application/pdf') {
      setError(t('docs.onlyPdf', 'Nur PDF-Dateien sind erlaubt.'))
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(t('docs.tooLarge', 'Datei zu groß. Maximum: 10 MB'))
      return
    }
    onFile(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) validateAndAccept(file)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) validateAndAccept(file)
    e.target.value = ''
  }

  return (
    <div className="mb-6">
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl px-8 py-10 flex flex-col items-center gap-3
                    cursor-pointer transition-all select-none ${
          dragging
            ? 'border-orange-400 bg-orange-50 scale-[1.01]'
            : 'border-orange-300 hover:border-orange-400 hover:bg-orange-50/50 bg-white'
        }`}
        style={{ borderColor: dragging ? '#ff795d' : '#ffb39e' }}
      >
        <span className="text-4xl">{dragging ? '📥' : '📄'}</span>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-700">
            {dragging
              ? t('docs.dropNow', 'Loslassen zum Hochladen')
              : t('docs.dropHint', 'PDF hierher ziehen oder klicken')}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {t('docs.dropSub', 'Nur PDF · Max. 10 MB')}
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleChange}
      />
      {error && (
        <p className="text-sm text-red-500 mt-2 text-center">{error}</p>
      )}
    </div>
  )
}

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function Documents() {
  const { t } = useTranslation()

  const [docs,          setDocs]          = useState<WorkflowDocument[]>([])
  const [loading,       setLoading]       = useState(true)
  const [activeTab,     setActiveTab]     = useState<DocumentCategory | 'all'>('all')
  const [pendingFile,   setPendingFile]   = useState<File | null>(null)
  const [replaceDoc,    setReplaceDoc]    = useState<WorkflowDocument | null>(null)
  const [toast,         setToast]         = useState('')

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  // ── Dokumente laden ───────────────────────────────────────────────────────
  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listWorkflowDocuments()
      setDocs(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  // ── Gefilterte Liste ──────────────────────────────────────────────────────
  const filtered = activeTab === 'all'
    ? docs
    : docs.filter(d => d.category === activeTab)

  // ── Vorschau in neuem Tab ─────────────────────────────────────────────────
  const handlePreview = async (doc: WorkflowDocument) => {
    const url = await getPreviewUrl(doc.file_path)
    if (url) {
      window.open(url, '_blank')
    } else {
      showToast('❌ ' + t('docs.previewError', 'Vorschau konnte nicht geladen werden'))
    }
  }

  // ── Ersetzen: altes aktiv→inaktiv, dann Upload-Modal öffnen ──────────────
  const handleReplace = (doc: WorkflowDocument) => {
    setReplaceDoc(doc)
    // Zeige Upload-Modal ohne vorhandene Datei – daher erst nach Dateiauswahl
    document.getElementById('replace-input')?.click()
  }

  const handleReplaceFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type !== 'application/pdf') {
      showToast('❌ ' + t('docs.onlyPdf', 'Nur PDF-Dateien sind erlaubt.'))
      e.target.value = ''
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      showToast('❌ ' + t('docs.tooLarge', 'Datei zu groß. Maximum: 10 MB'))
      e.target.value = ''
      return
    }
    setPendingFile(file)
    e.target.value = ''
  }

  // ── Nach Upload: altes Dokument deaktivieren ──────────────────────────────
  const handleUploaded = async () => {
    if (replaceDoc) {
      await toggleDocumentActive(replaceDoc.id, false)
      setReplaceDoc(null)
    }
    showToast('✅ ' + t('docs.upload.success', 'Dokument erfolgreich hochgeladen'))
    fetchDocs()
  }

  // ── Active toggle (lokal + remote) ───────────────────────────────────────
  const handleToggled = (id: string, active: boolean) => {
    setDocs(prev => prev.map(d => d.id === id ? { ...d, active } : d))
  }

  // ── Zähler pro Kategorie ──────────────────────────────────────────────────
  const countFor = (cat: DocumentCategory | 'all') =>
    cat === 'all' ? docs.length : docs.filter(d => d.category === cat).length

  return (
    <DashboardLayout basePath="/admin/crm">

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2.5 rounded-xl shadow-lg text-sm font-body">
          {toast}
        </div>
      )}

      {/* Hidden replace-input */}
      <input
        id="replace-input"
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleReplaceFileChosen}
      />

      <div className="max-w-4xl space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'var(--font-heading)' }}>
            📎 {t('docs.title', 'Workflow Dokumente')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5 font-body">
            {t('docs.subtitle', 'Diese Dokumente werden automatisch in E-Mails mitgesendet')}
          </p>
        </div>

        {/* Info-Banner */}
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-700 font-body">
          <p className="font-medium mb-1">
            {t('docs.infoTitle', 'Wie funktioniert die automatische Anhang-Funktion?')}
          </p>
          <p className="text-blue-600 text-xs leading-relaxed">
            {t('docs.infoText',
              'Wenn du eine E-Mail mit der passenden Kategorie sendest, wird das neueste aktive Dokument dieser Kategorie automatisch angehängt. ' +
              'Stelle sicher, dass pro Kategorie genau ein Dokument aktiv ist.')}
          </p>
        </div>

        {/* Upload Drag & Drop Zone */}
        <DropZone onFile={file => setPendingFile(file)} />

        {/* Kategorie Tabs */}
        <div className="flex gap-1 overflow-x-auto pb-1 flex-wrap">
          {CATEGORIES.map(cat => {
            const count = countFor(cat.value)
            return (
              <button
                key={cat.value}
                onClick={() => setActiveTab(cat.value)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium font-body whitespace-nowrap transition-all ${
                  activeTab === cat.value
                    ? 'text-white shadow-sm'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                style={activeTab === cat.value ? { backgroundColor: '#ff795d' } : undefined}
              >
                <span>{cat.icon}</span>
                {t(cat.labelKey, cat.value)}
                {count > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${
                    activeTab === cat.value
                      ? 'bg-white/25 text-white'
                      : 'bg-white text-gray-500'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Dokument-Grid */}
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400 font-body">
            <span className="text-5xl block mb-3">📭</span>
            <p className="text-sm">
              {activeTab === 'all'
                ? t('docs.empty', 'Noch keine Dokumente. Ziehe eine PDF in die Upload-Zone.')
                : t('docs.emptyCategory', 'Keine Dokumente in dieser Kategorie.')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(doc => (
              <DocCard
                key={doc.id}
                doc={doc}
                onDeleted={() => {
                  setDocs(prev => prev.filter(d => d.id !== doc.id))
                  showToast('🗑 ' + t('docs.deleted', 'Dokument gelöscht'))
                }}
                onToggled={handleToggled}
                onPreview={handlePreview}
                onReplace={handleReplace}
              />
            ))}
          </div>
        )}

        {/* Hinweis: aktive Dokumente pro Kategorie */}
        {docs.length > 0 && (
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 font-body">
            <p className="text-xs font-semibold text-amber-700 mb-2">
              {t('docs.statusTitle', 'Status pro Kategorie')}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CATEGORIES.filter(c => c.value !== 'all').map(cat => {
                const active = docs.filter(d => d.category === cat.value && d.active)
                return (
                  <div key={cat.value} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      active.length === 1 ? 'bg-green-400' :
                      active.length === 0 ? 'bg-gray-300'  : 'bg-amber-400'
                    }`} />
                    <span className="text-xs text-gray-600">
                      {cat.icon} {t(cat.labelKey, cat.value)}
                      {active.length === 0 && (
                        <span className="text-gray-400"> – {t('docs.none', 'kein')}</span>
                      )}
                      {active.length > 1 && (
                        <span className="text-amber-600"> ({active.length} {t('docs.multipleActive', 'aktiv!')})</span>
                      )}
                      {active.length === 1 && (
                        <span className="text-green-600"> ✓</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Upload Modal */}
      {pendingFile && (
        <UploadModal
          file={pendingFile}
          onClose={() => { setPendingFile(null); setReplaceDoc(null) }}
          onUploaded={handleUploaded}
        />
      )}
    </DashboardLayout>
  )
}
