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
  const [imgBusy, setImgBusy] = useState(false)   // Bild wird im Hintergrund erstellt
  const [lastChange, setLastChange] = useState('')

  // Slug „studio" statt „ad-studio": Werbeblocker filtern „ad-"-URLs — der
  // alte Aufruf kam bei aktivem Blocker nie am Server an (22.7.).
  const call = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('studio', { body })
    if (error) {
      // Netzwerk-Ebene (gar nicht angekommen) von Function-Fehlern unterscheiden:
      // die Klartext-Meldung der Function steckt bei non-2xx im Response-Body.
      const detail = await (error as { context?: Response }).context?.json?.().catch(() => null)
      if (detail && typeof (detail as { error?: unknown }).error === 'string') {
        throw new Error((detail as { error: string }).error)
      }
      if (/Failed to send/i.test(error.message ?? '')) {
        throw new Error(t('crm.studio.networkError', 'Der Aufruf kam nicht am Server an — Internet prüfen und ggf. Werbeblocker für diese Seite ausschalten.'))
      }
      throw error
    }
    const d = data as Record<string, unknown>
    if (d.error) throw new Error(String(d.hint ?? d.error))
    return d
  }

  // Bild-Job pollen: der Text kommt sofort, das KI-Bild entsteht im Hintergrund
  // (verhindert Gateway-Timeouts bei langsameren Verbindungen).
  const pollImage = async (jobId: string): Promise<string> => {
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 4000))
      const s = await call({ mode: 'image_status', job: jobId })
      if (s.status === 'done' && s.image_url) return String(s.image_url)
      if (s.status === 'error') throw new Error(String(s.error ?? t('crm.studio.imgError', 'Bild konnte nicht erstellt werden')))
    }
    throw new Error(t('crm.studio.imgSlow', 'Bild dauert ungewöhnlich lange — bitte noch einmal versuchen'))
  }

  const runImageJob = async (jobId: string) => {
    setImgBusy(true)
    try {
      const url = await pollImage(jobId)
      setDraft(prev => prev ? { ...prev, image_url: url } : prev)
    } catch (err) {
      console.error('[AdStudio] image:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally { setImgBusy(false) }
  }

  const generate = async () => {
    if (!brief.trim() || busy || imgBusy) return
    setBusy('generate')
    setDraft(null)
    let jobId: string | null = null
    try {
      const d = await call({ mode: 'generate', brief: brief.trim() })
      setDraft(d.draft as Draft)
      setLastChange('')
      jobId = d.image_job ? String(d.image_job) : null
    } catch (err) {
      console.error('[AdStudio] generate:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally {
      setBusy(null)
    }
    if (jobId) await runImageJob(jobId)
  }

  const refine = async () => {
    if (!draft || !chat.trim() || busy || imgBusy) return
    setBusy('refine')
    let jobId: string | null = null
    try {
      const d = await call({ mode: 'refine', draft, instruction: chat.trim() })
      setDraft(d.draft as Draft)
      setLastChange(String(d.changed ?? ''))
      setChat('')
      jobId = d.image_job ? String(d.image_job) : null
    } catch (err) {
      console.error('[AdStudio] refine:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally {
      setBusy(null)
    }
    if (jobId) await runImageJob(jobId)
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
    <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-bold text-gray-800 mb-1">🎨 {t('crm.studio.title', 'Anzeigen-Studio (KI)')}</h2>
      <p className="text-sm text-gray-400 mb-3">
        {t('crm.studio.sub', 'Beschreibe die Anzeige, die du willst — z.B. „Erstelle mir ein Karussell vom Projekt Luma" oder „Einzelbild: ich am Strand, Thema Steuern sparen". Danach bearbeitest du alles per Chat.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={3}
          placeholder={t('crm.studio.briefPh', 'Was soll die Anzeige zeigen und bewerben?')}
          className="flex-1 min-w-[280px] border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y" />
        <button onClick={() => void generate()} disabled={busy !== null || !brief.trim()}
          className="px-6 py-3 rounded-xl text-base font-semibold text-white self-start flex items-center gap-2 disabled:opacity-60"
          style={{ backgroundColor: '#ff795d' }}>
          {busy === 'generate' && spinner}
          ✨ {t('crm.studio.cta', 'Anzeige erstellen')}
        </button>
      </div>
      {busy === 'generate' && (
        <p className="mt-2 text-[11px] text-gray-400">{t('crm.studio.generating', 'Erstelle Copy und Bildmaterial — bei KI-Bildern dauert das bis zu einer Minute …')}</p>
      )}

      {draft && (
        <div className="mt-4 rounded-2xl border border-orange-200 bg-orange-50/40 p-5">
          {/* Bild bzw. Karussell-Karten */}
          {draft.format === 'single' && draft.image_url && (
            <div className="relative w-full max-w-xl mb-4">
              <img src={draft.image_url} alt="" className={`w-full rounded-2xl shadow-sm ${imgBusy ? 'opacity-50' : ''}`} />
              {imgBusy && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-700 bg-white/40 rounded-2xl gap-2">{spinner}{t('crm.studio.imgWorking', 'Neues Bild wird erstellt …')}</div>}
            </div>
          )}
          {draft.format === 'single' && !draft.image_url && imgBusy && (
            <div className="w-full max-w-xl aspect-square rounded-2xl mb-4 bg-gray-100 border border-dashed border-gray-300 flex items-center justify-center text-sm text-gray-500 gap-2">
              {spinner}{t('crm.studio.imgWorking', 'Bild wird erstellt … (bis zu einer Minute)')}
            </div>
          )}
          {draft.format === 'carousel' && (
            <div className="flex gap-3 overflow-x-auto pb-2 mb-3">
              {(draft.cards ?? []).map((c, i) => (
                <div key={i} className="w-52 shrink-0 rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
                  <img src={c.image_url} alt="" className="w-52 h-52 object-cover" loading="lazy" />
                  <div className="p-2.5">
                    <p className="text-sm font-bold text-gray-800 leading-tight">{c.title}</p>
                    <p className="text-xs text-gray-500 leading-tight mt-1">{c.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Caption: komplett direkt editierbar */}
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('crm.studio.headline', 'Überschrift')}</label>
          <input value={draft.headline} onChange={e => setDraft(d => d ? { ...d, headline: e.target.value } : d)}
            className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-base font-semibold mb-3 bg-white" />
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('crm.studio.caption', 'Caption (frei editierbar)')}</label>
          <textarea value={draft.message} onChange={e => setDraft(d => d ? { ...d, message: e.target.value } : d)} rows={10}
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base bg-white resize-y leading-relaxed" />

          {/* Chat-Bearbeitung */}
          <div className="flex flex-wrap gap-2 mt-3">
            <input value={chat} onChange={e => setChat(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void refine() }}
              placeholder={draft.format === 'single'
                ? t('crm.studio.chatPhSingle', 'z.B. „mach den Himmel blauer“, „anderes Motiv: am Pool“, „Caption kürzer“ …')
                : t('crm.studio.chatPhCarousel', 'z.B. „nur 4 Karten“, „erste Karte: anderes Foto“, „Caption emotionaler“ …')}
              className="flex-1 min-w-[240px] border border-gray-200 rounded-xl px-4 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
            <button onClick={() => void refine()} disabled={busy !== null || imgBusy || !chat.trim()}
              className="px-5 py-3 rounded-xl text-base font-semibold text-white flex items-center gap-2 disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
              {busy === 'refine' && spinner}
              💬 {t('crm.studio.chatCta', 'Ändern')}
            </button>
          </div>
          {lastChange && <p className="mt-1 text-[11px] text-gray-400">{t('crm.studio.changed', 'Zuletzt geändert')}: {lastChange === 'caption' ? t('crm.studio.caption', 'Caption') : lastChange === 'image' ? t('crm.studio.image', 'Bild') : t('crm.studio.cards', 'Karten')}</p>}

          <div className="flex gap-2 mt-3">
            <button onClick={() => void publish()} disabled={busy !== null || imgBusy || (draft.format === 'single' && !draft.image_url)}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-60" style={{ backgroundColor: '#16a34a' }}>
              {busy === 'publish' && spinner}
              ✅ {t('crm.studio.publish', 'Als Anzeige anlegen (pausiert)')}
            </button>
            <button onClick={() => { setDraft(null); setLastChange('') }} disabled={busy !== null || imgBusy}
              className="px-3 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
              {t('crm.ads.audienceDiscard', 'Verwerfen')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
