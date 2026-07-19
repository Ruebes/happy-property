import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── AdStudio ──────────────────────────────────────────────────────────────────
// KI-Anzeigen-Studio im Werbemanager: Sven beschreibt die gewünschte Anzeige
// („Erstelle mir ein Karussell vom Projekt Luma"), darunter entsteht der
// Entwurf (Bild/Karten + Caption). Caption ist direkt editierbar, alles Weitere
// per Chat („mach den Himmel blauer", „nur 4 Karten", …). „Anlegen" erstellt
// die Anzeige PAUSIERT in der System-Kampagne (Edge Function ad-studio).

interface Card { title: string; description: string; image_url: string }
interface Draft {
  format: 'single' | 'carousel'
  headline: string
  message: string
  image_url?: string
  cards?: Card[]
}

interface Props {
  onPublished: () => void           // Werbemanager neu laden (neue Ad im Katalog)
  showToast: (msg: string) => void
}

export default function AdStudio({ onPublished, showToast }: Props) {
  const { t } = useTranslation()
  const [brief, setBrief] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [chat, setChat] = useState('')
  const [busy, setBusy] = useState<'generate' | 'refine' | 'publish' | null>(null)
  const [lastChange, setLastChange] = useState('')

  const call = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('ad-studio', { body })
    if (error) throw error
    const d = data as Record<string, unknown>
    if (d.error) throw new Error(String(d.hint ?? d.error))
    return d
  }

  const generate = async () => {
    if (!brief.trim() || busy) return
    setBusy('generate')
    setDraft(null)
    try {
      const d = await call({ mode: 'generate', brief: brief.trim() })
      setDraft(d.draft as Draft)
      setLastChange('')
    } catch (err) {
      console.error('[AdStudio] generate:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally {
      setBusy(null)
    }
  }

  const refine = async () => {
    if (!draft || !chat.trim() || busy) return
    setBusy('refine')
    try {
      const d = await call({ mode: 'refine', draft, instruction: chat.trim() })
      setDraft(d.draft as Draft)
      setLastChange(String(d.changed ?? ''))
      setChat('')
    } catch (err) {
      console.error('[AdStudio] refine:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally {
      setBusy(null)
    }
  }

  const publish = async () => {
    if (!draft || busy) return
    setBusy('publish')
    try {
      await call({ mode: 'publish', draft })
      showToast(t('crm.studio.published', '✅ Anzeige angelegt (pausiert) — per 👁 Vorschau prüfen, dann aktivieren'))
      setDraft(null)
      setBrief('')
      onPublished()
    } catch (err) {
      console.error('[AdStudio] publish:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally {
      setBusy(null)
    }
  }

  const spinner = <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />

  return (
    <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-bold text-gray-700 mb-1">🎨 {t('crm.studio.title', 'Anzeigen-Studio (KI)')}</h2>
      <p className="text-[11px] text-gray-400 mb-2">
        {t('crm.studio.sub', 'Beschreibe die Anzeige, die du willst — z.B. „Erstelle mir ein Karussell vom Projekt Luma" oder „Einzelbild: ich am Strand, Thema Steuern sparen". Danach bearbeitest du alles per Chat.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={2}
          placeholder={t('crm.studio.briefPh', 'Was soll die Anzeige zeigen und bewerben?')}
          className="flex-1 min-w-[260px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y" />
        <button onClick={() => void generate()} disabled={busy !== null || !brief.trim()}
          className="px-4 py-2 rounded-lg text-sm font-semibold text-white self-start flex items-center gap-1.5 disabled:opacity-60"
          style={{ backgroundColor: '#ff795d' }}>
          {busy === 'generate' && spinner}
          ✨ {t('crm.studio.cta', 'Anzeige erstellen')}
        </button>
      </div>
      {busy === 'generate' && (
        <p className="mt-2 text-[11px] text-gray-400">{t('crm.studio.generating', 'Erstelle Copy und Bildmaterial — bei KI-Bildern dauert das bis zu einer Minute …')}</p>
      )}

      {draft && (
        <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50/40 p-3">
          {/* Bild bzw. Karussell-Karten */}
          {draft.format === 'single' && draft.image_url && (
            <img src={draft.image_url} alt="" className="w-full max-w-sm rounded-xl mb-3" />
          )}
          {draft.format === 'carousel' && (
            <div className="flex gap-2 overflow-x-auto pb-2 mb-2">
              {(draft.cards ?? []).map((c, i) => (
                <div key={i} className="w-36 shrink-0 rounded-lg border border-gray-200 bg-white overflow-hidden">
                  <img src={c.image_url} alt="" className="w-36 h-36 object-cover" loading="lazy" />
                  <div className="p-1.5">
                    <p className="text-[11px] font-bold text-gray-800 leading-tight">{c.title}</p>
                    <p className="text-[10px] text-gray-500 leading-tight mt-0.5">{c.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Caption: komplett direkt editierbar */}
          <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('crm.studio.headline', 'Überschrift')}</label>
          <input value={draft.headline} onChange={e => setDraft(d => d ? { ...d, headline: e.target.value } : d)}
            className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-semibold mb-2 bg-white" />
          <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('crm.studio.caption', 'Caption (frei editierbar)')}</label>
          <textarea value={draft.message} onChange={e => setDraft(d => d ? { ...d, message: e.target.value } : d)} rows={8}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white resize-y" />

          {/* Chat-Bearbeitung */}
          <div className="flex flex-wrap gap-2 mt-2">
            <input value={chat} onChange={e => setChat(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void refine() }}
              placeholder={draft.format === 'single'
                ? t('crm.studio.chatPhSingle', 'z.B. „mach den Himmel blauer“, „anderes Motiv: am Pool“, „Caption kürzer“ …')
                : t('crm.studio.chatPhCarousel', 'z.B. „nur 4 Karten“, „erste Karte: anderes Foto“, „Caption emotionaler“ …')}
              className="flex-1 min-w-[220px] border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
            <button onClick={() => void refine()} disabled={busy !== null || !chat.trim()}
              className="px-3 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
              {busy === 'refine' && spinner}
              💬 {t('crm.studio.chatCta', 'Ändern')}
            </button>
          </div>
          {lastChange && <p className="mt-1 text-[11px] text-gray-400">{t('crm.studio.changed', 'Zuletzt geändert')}: {lastChange === 'caption' ? t('crm.studio.caption', 'Caption') : lastChange === 'image' ? t('crm.studio.image', 'Bild') : t('crm.studio.cards', 'Karten')}</p>}

          <div className="flex gap-2 mt-3">
            <button onClick={() => void publish()} disabled={busy !== null}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-60" style={{ backgroundColor: '#16a34a' }}>
              {busy === 'publish' && spinner}
              ✅ {t('crm.studio.publish', 'Als Anzeige anlegen (pausiert)')}
            </button>
            <button onClick={() => { setDraft(null); setLastChange('') }} disabled={busy !== null}
              className="px-3 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
              {t('crm.ads.audienceDiscard', 'Verwerfen')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
