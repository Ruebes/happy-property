import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── WaImageField ────────────────────────────────────────────────────────────────
// Bild einer WhatsApp-Vorlage: Upload + Vorschau + Entfernen. Das Bild wird beim
// Versand als Karte ÜBER dem Text angezeigt (Text = Bildunterschrift, Links darunter
// bleiben antippbar). Der Versand verkleinert selbst auf WhatsApp-taugliches JPEG —
// hier darf also auch ein grosses Foto hochgeladen werden.
// Ablage: Bucket 'crm-project-images' (öffentlich lesbar, Upload für Angemeldete).

const BUCKET = 'crm-project-images'

export default function WaImageField({ value, onChange }: {
  value: string | null
  onChange: (url: string | null) => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setBusy(true); setErr('')
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
      const path = `whatsapp/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from(BUCKET)
        .upload(path, file, { cacheControl: '3600', upsert: false })
      if (error) throw error
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
      onChange(data.publicUrl)
    } catch (e) {
      console.error('[WaImageField] upload:', e)
      setErr(t('crm.waImage.error', 'Upload fehlgeschlagen — bitte nochmal versuchen.'))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
        {t('crm.waImage.label', 'Bild (optional)')}
      </label>
      {value ? (
        <div className="flex items-start gap-3">
          <img src={value} alt="" className="w-28 h-20 object-cover rounded-lg border border-gray-200" />
          <div className="flex flex-col gap-1.5">
            <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
              className="text-xs font-medium text-gray-600 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50">
              {busy ? t('common.saving', 'speichert …') : t('crm.waImage.replace', 'Bild tauschen')}
            </button>
            <button type="button" onClick={() => onChange(null)} disabled={busy}
              className="text-xs font-medium text-red-500 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50 disabled:opacity-50">
              {t('crm.waImage.remove', 'Ohne Bild senden')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
          className="w-full border border-dashed border-gray-300 rounded-xl px-3 py-3 text-sm text-gray-500 hover:border-orange-300 hover:text-gray-700 disabled:opacity-50">
          {busy ? t('common.saving', 'speichert …') : `🖼️ ${t('crm.waImage.add', 'Bild hochladen — wird als Karte über dem Text angezeigt')}`}
        </button>
      )}
      {err && <p className="text-xs text-red-500 mt-1">{err}</p>}
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f) }} />
    </div>
  )
}
