import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'

// Öffentliche Seite /sign/u/:token (kein Login, kein Google-Konto): Wer etwas hochladen soll, lädt hier
// hoch, die Datei landet im Drive-Kundenordner. Die Seite zeigt nie den Ordnerinhalt, nur was gerade
// von diesem Gerät kam. Die Regeln prüft der Server (owner-drive, uploadSeite.ts).

interface View { closed: boolean; lang: 'de' | 'en'; empfaenger?: string; first_name?: string; kunde?: string | null; max_mb?: number }
type Zeile = { key: string; name: string; state: 'wartet' | 'laeuft' | 'ok' | 'fehler'; fehler?: string }

async function fehlerCode(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context
  const j = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) as { error?: string } | null : null
  return j?.error ?? 'error'
}

export default function UploadSeite() {
  const { token } = useParams<{ token: string }>()
  const { i18n } = useTranslation()
  const [phase, setPhase] = useState<'loading' | 'open' | 'closed' | 'error'>('loading')
  const [view, setView] = useState<View | null>(null)
  const [zeilen, setZeilen] = useState<Zeile[]>([])
  const [busy, setBusy] = useState(false)
  const kamera = useRef<HTMLInputElement>(null)
  const datei = useRef<HTMLInputElement>(null)
  const t = useMemo(() => i18n.getFixedT(view?.lang ?? 'de'), [view?.lang, i18n])
  const headers = { 'x-upload-token': token ?? '' }

  useEffect(() => {
    supabase.functions.invoke('owner-drive', { body: {}, headers })
      .then(async ({ data, error }) => {
        if (error) { setPhase(await fehlerCode(error) === 'closed' ? 'closed' : 'error'); return }
        const v = data as View
        setView(v)
        setPhase(v.closed ? 'closed' : 'open')
      })
      .catch(() => setPhase('error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const hochladen = async (list: FileList | null) => {
    if (!list?.length || busy) return
    const neu = Array.from(list).map((f, i) => ({ f, key: `${Date.now()}-${i}` }))
    setZeilen(z => [...z, ...neu.map(n => ({ key: n.key, name: n.f.name, state: 'wartet' as const }))])
    setBusy(true)
    const setze = (key: string, x: Partial<Zeile>) => setZeilen(z => z.map(r => r.key === key ? { ...r, ...x } : r))
    // Eine Datei je Anfrage: Das Limit gilt je Anfrage, und jede Zeile zeigt ihren eigenen Stand
    for (const { f, key } of neu) {
      if (f.size > (view?.max_mb ?? 20) * 1024 * 1024) { setze(key, { state: 'fehler', fehler: 'too_large' }); continue }
      setze(key, { state: 'laeuft' })
      const fd = new FormData()
      fd.append('file', f, f.name)
      try {
        const { error } = await supabase.functions.invoke('owner-drive', { body: fd, headers })
        if (!error) { setze(key, { state: 'ok' }); continue }
        const code = await fehlerCode(error)
        if (code === 'closed') { setPhase('closed'); break }
        setze(key, { state: 'fehler', fehler: code })
      } catch { setze(key, { state: 'fehler', fehler: 'error' }) }
    }
    setBusy(false)
    if (kamera.current) kamera.current.value = ''
    if (datei.current) datei.current.value = ''
  }

  const fehlerText = (code?: string) =>
    code === 'too_large' ? t('uploadSeite.errTooLarge', 'This file is larger than {{mb}} MB.', { mb: view?.max_mb ?? 20 })
    : code === 'bad_type' ? t('uploadSeite.errType', 'Please use a photo, a PDF, or a Word or Excel file.')
    : code === 'too_many' ? t('uploadSeite.errTooMany', 'Too many files today. Please contact us.')
    : t('uploadSeite.errUpload', 'That did not work. Please try again in a minute.')

  const box = (children: React.ReactNode) => (
    <div className="min-h-screen bg-hp-cream py-6 px-4">
      <div className="max-w-lg mx-auto space-y-4">{children}</div>
    </div>
  )
  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4'

  if (phase === 'loading') return <div className="min-h-screen flex items-center justify-center bg-hp-cream text-gray-500">…</div>
  if (phase === 'error') return box(<div className={card}><p className="text-sm text-gray-700">{t('uploadSeite.error', 'Something went wrong. Please try again in a minute.')}</p></div>)
  if (phase === 'closed') return box(<div className={card}><p className="text-sm text-gray-700">{t('uploadSeite.closed', 'This link is no longer valid. Please contact Happy Property.')}</p></div>)

  const fertig = zeilen.filter(z => z.state === 'ok').length
  return box(
    <>
      <div className={card}>
        <div>
          <p className="text-lg font-semibold text-hp-navy">{t('uploadSeite.title', 'Upload your documents')}</p>
          <p className="text-sm text-gray-600 mt-1">
            {view?.kunde
              ? t('uploadSeite.introOther', 'Hi {{name}}, upload the documents for {{kunde}} here. No Google account needed.', { name: view?.first_name ?? '', kunde: view.kunde })
              : t('uploadSeite.introCustomer', 'Hi {{name}}, upload your ID or other documents here. No Google account needed. For a national ID card, please upload both sides.', { name: view?.first_name ?? '' })}
          </p>
        </div>
        <input ref={kamera} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => hochladen(e.target.files)} />
        <input ref={datei} type="file" multiple accept="image/*,application/pdf,.docx,.xlsx" className="hidden" onChange={e => hochladen(e.target.files)} />
        <button onClick={() => kamera.current?.click()} disabled={busy} className="w-full py-3.5 rounded-xl bg-hp-highlight text-white font-semibold disabled:opacity-50">
          {t('uploadSeite.camera', 'Take a photo')}
        </button>
        <button onClick={() => datei.current?.click()} disabled={busy} className="w-full py-3 rounded-xl border border-gray-200 text-sm font-medium text-hp-navy hover:bg-gray-50 disabled:opacity-50">
          {t('uploadSeite.file', 'Choose a file')}
        </button>
        <p className="text-xs text-gray-500">{t('uploadSeite.hint', 'Photo, PDF, Word or Excel, up to {{mb}} MB per file. Your files go directly into your secure folder at Happy Property.', { mb: view?.max_mb ?? 20 })}</p>
      </div>
      {zeilen.length > 0 && (
        <div className={card}>
          <ul className="space-y-2">
            {zeilen.map(z => (
              <li key={z.key} className="text-sm">
                <span className="text-gray-800 break-all">{z.state === 'ok' ? '✅' : z.state === 'fehler' ? '⚠️' : '⏳'} {z.name}</span>
                {z.state === 'fehler' && <span className="block text-xs text-red-600">{fehlerText(z.fehler)}</span>}
              </li>
            ))}
          </ul>
          {fertig > 0 && !busy && <p className="text-sm font-semibold text-hp-navy">{t('uploadSeite.done', 'Thank you, we have your files. You can close this page or add more.')}</p>}
        </div>
      )}
    </>
  )
}
