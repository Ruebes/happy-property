import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Meine Dateien (Google-Drive-Kundenordner) ─────────────────────────────────
// Jeder Kunde hat unter „Happy Property Kunden" einen Drive-Ordner (leads.
// drive_folder_id). Hier sieht er dessen Inhalt und lädt selbst Unterlagen hoch.
// Alles läuft über die Edge Function owner-drive: Lesen per Service-Account,
// Hochladen im Namen von Svens Google-Konto (der Service-Account hat keinen
// Speicherplatz). Neue Dateien meldet Lotte per WhatsApp an alle mit Zugriff.

interface DriveFile {
  id: string; name: string; mime_type: string; size: number | null; path: string
  created_time: string | null; modified_time: string | null; web_view_link: string | null; icon: string | null
  uploader: string | null
}
interface ListResponse {
  ok?: boolean; error?: string; reason?: string; can_upload?: boolean
  folder: { id: string; url: string } | null
  files: DriveFile[]
}
const MAX_MB = 20   // Grenze des Function-Requests; größere Dateien bitte direkt in Drive

const fmtSize = (n: number | null) => {
  if (!n) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
const iconFor = (mime: string) => {
  if (mime.startsWith('image/')) return '🖼️'
  if (mime.startsWith('video/')) return '🎬'
  if (mime === 'application/pdf') return '📕'
  if (mime.includes('spreadsheet') || mime.includes('excel')) return '📊'
  if (mime.includes('word') || mime.includes('document')) return '📝'
  return '📄'
}

export default function EigentuemerDrive() {
  const { t, i18n } = useTranslation()
  const { profile } = useAuth()
  const [files, setFiles] = useState<DriveFile[]>([])
  const [folder, setFolder] = useState<{ id: string; url: string } | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [canUpload, setCanUpload] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [toast, setToast] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 8000) }

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    // Sicherheits-Timeout wie im restlichen Portal: Spinner nie ewig.
    const safety = setTimeout(() => { setLoading(false); setLoadError(t('eigentuemer.drive.loadError', 'Konnte nicht geladen werden. Bitte Seite neu laden.')) }, 25_000)
    try {
      const { data, error } = await supabase.functions.invoke('owner-drive', { body: { action: 'list' } })
      const d = (data ?? {}) as ListResponse
      if (error || d.error) throw new Error(d.error || error?.message || 'Fehler')
      setFolder(d.folder ?? null)
      setReason(d.reason ?? null)
      setFiles(d.files ?? [])
      setCanUpload(!!d.can_upload)
    } catch (e) {
      console.error('[Eigentuemer/Drive] load:', e)
      setLoadError(t('eigentuemer.drive.loadError', 'Konnte nicht geladen werden. Bitte Seite neu laden.'))
    } finally { clearTimeout(safety); setLoading(false) }
  }, [t])
  useEffect(() => { if (profile?.id) void load() }, [profile?.id, load])

  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list)
    if (!picked.length || busy) return
    const ok = picked.filter(f => {
      if (f.size > MAX_MB * 1024 * 1024) { showToast(`⚠️ ${t('eigentuemer.drive.tooBig', '{{name}} ist größer als {{mb}} MB.', { name: f.name, mb: MAX_MB })}`); return false }
      return f.size > 0
    })
    if (!ok.length) return
    setBusy(true)
    try {
      let done = 0
      const failed: string[] = []
      // Eine Datei je Request: hält den Function-Request klein und zeigt Fortschritt.
      for (const f of ok) {
        setProgress(`${done + 1}/${ok.length} · ${f.name}`)
        const fd = new FormData()
        fd.append('action', 'upload')
        fd.append('file', f, f.name)
        const { data, error } = await supabase.functions.invoke('owner-drive', { body: fd })
        const d = (data ?? {}) as { ok?: boolean; error?: string; uploaded?: Array<{ id: string }>; failed?: Array<{ name: string; error: string }> }
        if (d.error === 'drive_not_connected') {
          setCanUpload(false)
          showToast(`⚠️ ${t('eigentuemer.drive.notConnected', 'Der Upload ist gerade nicht möglich. Wir sind informiert und schalten ihn frei.')}`)
          break
        }
        if (error || d.error || !d.ok) { failed.push(t('eigentuemer.drive.uploadFailed', '{{name}}: Upload fehlgeschlagen ({{error}})', { name: f.name, error: d.error || error?.message || '?' })); continue }
        for (const x of d.failed ?? []) failed.push(t('eigentuemer.drive.uploadFailed', '{{name}}: Upload fehlgeschlagen ({{error}})', { name: x.name, error: x.error }))
        done += d.uploaded?.length ?? 0
      }
      if (done) showToast(`✅ ${t('eigentuemer.drive.uploaded', '{{n}} Datei(en) hochgeladen. Lotte informiert alle Beteiligten.', { n: done })}`)
      if (failed.length) showToast(`⚠️ ${failed.join(' · ')}`)
      if (done) await load()
    } finally { setBusy(false); setProgress(''); if (inputRef.current) inputRef.current.value = '' }
  }

  // Öffnen: Datei über die Function streamen (funktioniert auch ohne Google-Konto
  // des Kunden) und als Download anstoßen — kein window.open, das Safari blockt.
  const open = async (f: DriveFile) => {
    if (opening) return
    setOpening(f.id)
    try {
      const { data, error } = await supabase.functions.invoke('owner-drive', { body: { action: 'download', file_id: f.id } })
      if (error) throw new Error(error.message)
      if (!(data instanceof Blob)) {
        const d = data as { error?: string } | null
        throw new Error(d?.error || 'Fehler')
      }
      const url = URL.createObjectURL(data)
      const a = document.createElement('a')
      a.href = url
      a.download = f.mime_type.startsWith('application/vnd.google-apps.') ? `${f.name}.pdf` : f.name
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      console.error('[Eigentuemer/Drive] open:', e)
      if (f.web_view_link) window.location.assign(f.web_view_link)
      else showToast(`⚠️ ${e instanceof Error ? e.message : 'Fehler'}`)
    } finally { setOpening(null) }
  }

  const dateFmt = (s: string | null) => s ? new Date(s).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''

  return (
    <DashboardLayout basePath="/eigentuemer/dashboard">
      {toast && <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg max-w-sm">{toast}</div>}
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold font-heading text-hp-black">📁 {t('eigentuemer.drive.title', 'Meine Dateien')}</h1>
            <p className="text-sm text-gray-500 mt-1">{t('eigentuemer.drive.subtitle', 'Dein persönlicher Google-Drive-Ordner bei Happy Property: Verträge, Unterlagen, Nachweise. Was du hier hochlädst, sehen Sven und alle, die an deinem Kauf beteiligt sind.')}</p>
          </div>
          {folder && (
            <a href={folder.url} target="_blank" rel="noreferrer"
              className="shrink-0 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">
              ↗ {t('eigentuemer.drive.openDrive', 'In Google Drive öffnen')}
            </a>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-6 text-center space-y-3">
            <p className="text-sm text-gray-500">{loadError}</p>
            <button onClick={() => void load()} className="px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
              {t('eigentuemer.drive.reload', 'Neu laden')}
            </button>
          </div>
        ) : !folder ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
            <p className="text-3xl mb-2">🐾</p>
            <p className="text-sm text-gray-500">{reason === 'no_lead'
              ? t('eigentuemer.drive.noLead', 'Für dein Konto ist noch kein Ordner eingerichtet. Melde dich kurz bei uns, dann legen wir ihn an.')
              : t('eigentuemer.drive.loadError', 'Konnte nicht geladen werden. Bitte Seite neu laden.')}</p>
          </div>
        ) : (
          <>
            {/* Upload-Zone */}
            <div
              onDragOver={e => { e.preventDefault(); if (canUpload && !busy) setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); if (canUpload && !busy) void upload(e.dataTransfer.files) }}
              className={`rounded-2xl border-2 border-dashed p-6 text-center transition-colors bg-white
                ${dragOver ? 'border-orange-400 bg-orange-50' : 'border-gray-200'} ${canUpload ? '' : 'opacity-70'}`}>
              <input ref={inputRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files) void upload(e.target.files) }} />
              <p className="text-3xl mb-2">⬆️</p>
              {canUpload ? (
                <>
                  <button onClick={() => inputRef.current?.click()} disabled={busy}
                    className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
                    {busy ? `${t('eigentuemer.drive.uploading', 'Lädt hoch…')} ${progress}` : t('eigentuemer.drive.upload', 'Datei hochladen')}
                  </button>
                  <p className="text-xs text-gray-400 mt-2">{t('eigentuemer.drive.dropHint', 'Dateien hierher ziehen oder auswählen (max. {{mb}} MB je Datei)', { mb: MAX_MB })}</p>
                </>
              ) : (
                <p className="text-sm text-gray-500">{t('eigentuemer.drive.notConnected', 'Der Upload ist gerade nicht möglich. Wir sind informiert und schalten ihn frei.')}</p>
              )}
              <p className="text-xs text-gray-400 mt-3">🐾 {t('eigentuemer.drive.notify', 'Neue Dateien melden wir automatisch per WhatsApp an alle, die Zugriff auf deinen Ordner haben.')}</p>
            </div>

            {/* Dateiliste */}
            {files.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
                <p className="text-sm text-gray-500">{t('eigentuemer.drive.empty', 'Noch keine Dateien. Lade hier deine Unterlagen hoch, zum Beispiel Ausweis, Kaufvertrag oder Nachweise.')}</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="hidden sm:grid grid-cols-[1fr_140px_90px_90px] gap-3 px-5 py-2.5 text-[11px] font-semibold text-gray-400 uppercase tracking-widest border-b border-gray-50">
                  <span>{t('eigentuemer.drive.colName', 'Datei')}</span>
                  <span>{t('eigentuemer.drive.colUploader', 'Hochgeladen von')}</span>
                  <span>{t('eigentuemer.drive.colDate', 'Datum')}</span>
                  <span />
                </div>
                {files.map(f => (
                  <div key={f.id} className="grid grid-cols-1 sm:grid-cols-[1fr_140px_90px_90px] gap-1 sm:gap-3 items-center px-5 py-3 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xl shrink-0">{iconFor(f.mime_type)}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{f.name}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {f.path ? `📂 ${f.path} · ` : ''}{fmtSize(f.size)}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 truncate sm:block">{f.uploader ?? ''}</p>
                    <p className="text-xs text-gray-500">{dateFmt(f.created_time)}</p>
                    <button onClick={() => void open(f)} disabled={opening === f.id}
                      className="justify-self-start sm:justify-self-end text-xs font-semibold px-3 py-1.5 rounded-lg text-white disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
                      {opening === f.id ? '…' : `⬇️ ${t('eigentuemer.drive.open', 'Öffnen')}`}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
