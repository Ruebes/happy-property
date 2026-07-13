import { useState } from 'react'
import { useTranslation } from 'react-i18next'

// Wiederverwendbare Datei-Anhänge für JEDEN Kunden-Mailversand (LeadQuickSend,
// LeadDetail-Composer, …). Ein Hook hält die Dateiliste + baut das send-email
// `attachments[]`-Array; die Feld-Komponente rendert Button + Liste einheitlich.

export type MailAttachment = { filename: string; content_base64: string; content_type: string }

// Gesamt-Limit, damit der Edge-Function-Body nicht platzt (Base64 bläht ~+33 %;
// 8 MB roh ≈ ~11 MB Base64 — sicher unter dem Request-Limit).
export const MAIL_ATTACH_MAX_TOTAL = 8 * 1024 * 1024

const fileToB64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '')   // data:…;base64,XXX → XXX
  r.onerror = () => reject(new Error('read failed'))
  r.readAsDataURL(file)
})

export function useMailAttachments() {
  const [files, setFiles] = useState<File[]>([])
  // Rückgabe 'too-big' → Aufrufer zeigt seine eigene Fehlermeldung; null = ok.
  const add = (list: FileList | null): 'too-big' | null => {
    if (!list?.length) return null
    const next = [...files, ...Array.from(list)]
    if (next.reduce((s, f) => s + f.size, 0) > MAIL_ATTACH_MAX_TOTAL) return 'too-big'
    setFiles(next)
    return null
  }
  const remove = (i: number) => setFiles(files.filter((_, idx) => idx !== i))
  const reset = () => setFiles([])
  const toAttachments = async (): Promise<MailAttachment[] | undefined> => files.length
    ? await Promise.all(files.map(async f => ({ filename: f.name, content_base64: await fileToB64(f), content_type: f.type || 'application/octet-stream' })))
    : undefined
  return { files, add, remove, reset, toAttachments }
}

export function MailAttachmentField({ files, onAdd, onRemove }: {
  files: File[]
  onAdd: (list: FileList | null) => void
  onRemove: (i: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
        <span className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">📎 {t('crm.quick.attach', 'Dateien anhängen')}</span>
        <input type="file" multiple className="hidden" onChange={e => { onAdd(e.target.files); e.currentTarget.value = '' }} />
      </label>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-xs bg-gray-50 rounded-lg px-2.5 py-1.5">
              <span className="truncate text-gray-700">📄 {f.name} <span className="text-gray-400">({Math.round(f.size / 1024)} KB)</span></span>
              <button type="button" onClick={() => onRemove(i)} className="shrink-0 w-5 h-5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
