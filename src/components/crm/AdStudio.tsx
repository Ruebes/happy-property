import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── AdStudio ──────────────────────────────────────────────────────────────────
// KI-Anzeigen-Studio im Werbemanager: Sven beschreibt die gewünschte Anzeige
// („Erstelle mir ein Karussell vom Projekt Luma"), darunter entsteht der
// Entwurf (Bild/Karten + Caption). Caption ist direkt editierbar, alles Weitere
// per Chat („mach den Himmel blauer", „nur 4 Karten", …). „Anlegen" erstellt
// die Anzeige PAUSIERT in der System-Kampagne (Edge Function ad-studio).

interface Card { title: string; description: string; image_url: string }
interface Issue { severity: 'blocker' | 'hinweis'; field: string; problem: string; fix: string }
interface Review { score: number; verdict: string; issues: Issue[]; strengths: string[]; blocked: boolean }
interface Overlay { badge?: string; subheadline?: string; checks?: string[] }
interface Draft {
  format: 'single' | 'carousel'
  headline: string
  message: string
  image_url?: string
  /** rohes Hintergrundfoto ohne Text-Overlay (Server nutzt es für Änderungen) */
  bg_url?: string
  /** hochgeladene Vorlage — Bild-Änderungen per Chat setzen wieder darauf auf */
  base_image?: string
  /** benannte Textbausteine vom Server; null, sobald die Caption von Hand editiert wurde */
  copy?: unknown
  /** Restmängel aus der harten Prüfung */
  issues?: Issue[]
  overlay?: Overlay | null
  cards?: Card[]
}

interface Props {
  onPublished: () => void           // Werbemanager neu laden (neue Ad im Katalog)
  showToast: (msg: string) => void
}

/** Fehler der Edge Function inkl. Nutzdaten (z.B. die Mängelliste der Sperre). */
class CallError extends Error {
  detail?: Record<string, unknown>
  constructor(message: string, detail?: Record<string, unknown>) { super(message); this.detail = detail }
}

export default function AdStudio({ onPublished, showToast }: Props) {
  const { t } = useTranslation()
  const [brief, setBrief] = useState('')
  // Zweites Fenster: eigener Auftrag fuer das Bild (Motiv bzw. Aenderung am
  // hochgeladenen Basisbild). Der Server verlangt trotzdem, dass Motiv und
  // Caption thematisch zusammenpassen.
  const [imageBrief, setImageBrief] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [chat, setChat] = useState('')
  const [busy, setBusy] = useState<'generate' | 'refine' | 'publish' | null>(null)
  const [imgBusy, setImgBusy] = useState(false)   // Bild wird im Hintergrund erstellt
  const [lastChange, setLastChange] = useState('')
  const [review, setReview] = useState<Review | null>(null)   // Agentur-Review
  const [reviewBusy, setReviewBusy] = useState(false)
  const [blockers, setBlockers] = useState<Issue[] | null>(null)   // Sperre beim Anlegen
  const [baseImage, setBaseImage] = useState('')  // eigenes hochgeladenes Basisbild (URL)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Eigenes Basisbild hochladen → Bucket ad-creatives (public) → als base_image
  // an generate. Die KI verändert/ergänzt dann DIESES Bild statt neu zu erfinden.
  const uploadBase = async (file: File) => {
    setUploading(true)
    try {
      const ext = file.name.split('.').pop() || 'jpg'
      const path = `studio/base/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('ad-creatives').upload(path, file, { upsert: false })
      if (error) throw error
      const { data } = supabase.storage.from('ad-creatives').getPublicUrl(path)
      setBaseImage(data.publicUrl)
    } catch (err) {
      console.error('[AdStudio] upload:', err)
      showToast(`❌ ${t('crm.studio.uploadErr', 'Bild-Upload fehlgeschlagen')}`)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // Slug „studio" statt „ad-studio": Werbeblocker filtern „ad-"-URLs — der
  // alte Aufruf kam bei aktivem Blocker nie am Server an (22.7.).
  // Bei Netz-Wacklern (Anfrage kam gar nicht an, z.B. Gionas Verbindung 12.8.)
  // wird EINMAL automatisch neu versucht, bevor der Fehler gezeigt wird.
  const call = async (body: Record<string, unknown>, retried = false): Promise<Record<string, unknown>> => {
    const { data, error } = await supabase.functions.invoke('studio', { body })
    if (error) {
      // Netzwerk-Ebene (gar nicht angekommen) von Function-Fehlern unterscheiden:
      // die Klartext-Meldung der Function steckt bei non-2xx im Response-Body.
      const detail = await (error as { context?: Response }).context?.json?.().catch(() => null) as Record<string, unknown> | null
      if (detail && typeof detail.error === 'string') {
        // hint (verständliche Erklärung) hat Vorrang vor dem Fehlercode —
        // sonst sieht Giona kryptisches „app_dev_mode" statt der Anleitung.
        throw new CallError(typeof detail.hint === 'string' && detail.hint ? detail.hint : detail.error, detail)
      }
      if (/Failed to send/i.test(error.message ?? '')) {
        if (!retried) {
          await new Promise(r => setTimeout(r, 1500))
          return call(body, true)
        }
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
  const pollImage = async (jobId: string): Promise<{ url: string; bg: string | null }> => {
    for (let i = 0; i < 75; i++) {   // 5 Min - der Server gibt nach 240 s auf
      await new Promise(r => setTimeout(r, 4000))
      const s = await call({ mode: 'image_status', job: jobId })
      if (s.status === 'done' && s.image_url) return { url: String(s.image_url), bg: s.bg_url ? String(s.bg_url) : null }
      if (s.status === 'error') throw new Error(String(s.error ?? t('crm.studio.imgError', 'Bild konnte nicht erstellt werden')))
    }
    throw new Error(t('crm.studio.imgSlow', 'Bild dauert ungewöhnlich lange — bitte noch einmal versuchen'))
  }

  const runImageJob = async (jobId: string) => {
    setImgBusy(true)
    try {
      const { url, bg } = await pollImage(jobId)
      setDraft(prev => prev ? { ...prev, image_url: url, ...(bg ? { bg_url: bg } : {}) } : prev)
    } catch (err) {
      console.error('[AdStudio] image:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally { setImgBusy(false) }
  }

  // Agentur-Review: zweiter Blick auf den fertigen Entwurf. Läuft absichtlich
  // NEBEN dem Bild-Job — das Bild braucht ohnehin gut eine Minute, die Prüfung
  // ist in ~15 s durch und kostet damit keine wahrnehmbare Zeit.
  const runReview = async (d: Draft) => {
    setReviewBusy(true)
    try {
      const r = await call({ mode: 'review', draft: d })
      setReview({
        score: Number(r.score ?? 0), verdict: String(r.verdict ?? ''),
        issues: (r.issues as Issue[] | undefined) ?? [], strengths: (r.strengths as string[] | undefined) ?? [],
        blocked: r.blocked === true,
      })
    } catch (err) {
      console.error('[AdStudio] review:', err)   // Review ist Kür, nicht Pflicht
      setReview(null)
    } finally { setReviewBusy(false) }
  }

  const generate = async () => {
    if (!brief.trim() || busy || imgBusy || uploading) return
    setBusy('generate')
    setDraft(null)
    let jobId: string | null = null
    try {
      const d = await call({ mode: 'generate', brief: brief.trim(), ...(imageBrief.trim() ? { image_brief: imageBrief.trim() } : {}), ...(baseImage ? { base_image: baseImage } : {}) })
      setDraft(d.draft as Draft)
      setLastChange('')
      setReview(null)
      setBlockers(null)
      void runReview(d.draft as Draft)
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
      setBlockers(null)
      void runReview(d.draft as Draft)
      jobId = d.image_job ? String(d.image_job) : null
    } catch (err) {
      console.error('[AdStudio] refine:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
    } finally {
      setBusy(null)
    }
    if (jobId) await runImageJob(jobId)
  }

  const publish = async (force = false) => {
    if (!draft || busy) return
    setBusy('publish')
    try {
      await call({ mode: 'publish', draft, ...(force ? { force: true } : {}) })
      setBlockers(null)
      showToast(t('crm.studio.published', '✅ Anzeige gespeichert — liegt unter „Vorbereitete Anzeigen" und ist noch NICHT veröffentlicht'))
      setDraft(null)
      setBrief('')
      setImageBrief('')
      setBaseImage('')
      setReview(null)
      onPublished()
    } catch (err) {
      console.error('[AdStudio] publish:', err)
      // Qualitäts-Sperre: Mängel anzeigen statt nur meckern, mit der Möglichkeit
      // bewusst zu übergehen.
      const det = err instanceof CallError ? err.detail : undefined
      if (det?.error === 'quality_blocked') {
        setBlockers((det.issues as Issue[] | undefined) ?? [])
        showToast(`⛔ ${t('crm.studio.blocked', 'Die Anzeige verstößt gegen harte Regeln — siehe Prüfung unten')}`)
      } else {
        showToast(`❌ ${err instanceof Error ? err.message : t('crm.studio.error', 'Das hat nicht geklappt')}`)
      }
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
      {/* Zwei Fenster nebeneinander: links die Anzeige/Caption (mit optionalem
          Basisbild darunter), rechts der eigene Auftrag fuer das Bild. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            {t('crm.studio.briefLabel', '1. Anzeige & Text')}
          </label>
          <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={7}
            placeholder={t('crm.studio.briefPh', 'Was soll die Anzeige zeigen und bewerben?')}
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y" />
          {/* Eigenes Basisbild (optional): hochladen → die KI verändert DIESES Bild */}
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void uploadBase(f) }} />
            {baseImage ? (
              <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl pl-1.5 pr-2 py-1.5">
                <img src={baseImage} alt="" className="w-12 h-12 rounded-lg object-cover" />
                <div>
                  <p className="text-xs font-medium text-gray-700">{t('crm.studio.baseImgSet', 'Eigenes Basisbild aktiv')}</p>
                  <p className="text-[10px] text-gray-400">{t('crm.studio.baseImgHint3', 'Rechts beschreiben, was daran verändert werden soll')}</p>
                </div>
                <button onClick={() => setBaseImage('')} className="w-6 h-6 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 text-sm" title={t('crm.studio.baseImgRemove', 'Basisbild entfernen')}>×</button>
              </div>
            ) : (
              <button onClick={() => fileRef.current?.click()} disabled={uploading || busy !== null}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50">
                {uploading ? `⏳ ${t('crm.studio.uploading', 'Lädt hoch …')}` : `📷 ${t('crm.studio.baseImgBtn', 'Eigenes Bild als Basis hochladen (optional)')}`}
              </button>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            {t('crm.studio.imgBriefLabel', '2. Bild')}
          </label>
          <textarea value={imageBrief} onChange={e => setImageBrief(e.target.value)} rows={7}
            placeholder={baseImage
              ? t('crm.studio.imgBriefPhBase', 'Wie soll das hochgeladene Bild angepasst werden? z.B. „Lotte und mich dazustellen", „Umgebung: Neubau am Meer", „warmes Abendlicht"')
              : t('crm.studio.imgBriefPh', 'Was soll auf dem Bild zu sehen sein? z.B. „ich auf einer Dachterrasse über Paphos, Meer im Hintergrund"')}
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y" />
          <p className="mt-2 text-[11px] text-gray-400">
            {t('crm.studio.imgBriefHint', 'Optional. Bleibt das Feld leer, wählt die KI das Motiv passend zur Caption. Das Bild wird in jedem Fall thematisch auf die Anzeige abgestimmt.')}
          </p>
        </div>
      </div>

      <div className="mt-3">
        <button onClick={() => void generate()} disabled={busy !== null || uploading || !brief.trim()}
          className="px-6 py-3 rounded-xl text-base font-semibold text-white flex items-center gap-2 disabled:opacity-60"
          style={{ backgroundColor: '#ff795d' }}>
          {busy === 'generate' && spinner}
          ✨ {t('crm.studio.cta', 'Anzeige erstellen')}
        </button>
        {uploading && <p className="mt-1 text-[11px] text-gray-400">{t('crm.studio.waitUpload', 'Basisbild lädt noch hoch — gleich geht es los.')}</p>}
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
          <textarea value={draft.message}
            onChange={e => { setDraft(d => d ? { ...d, message: e.target.value, copy: null } : d); setReview(null) }} rows={10}
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base bg-white resize-y leading-relaxed" />

          {/* Chat-Bearbeitung */}
          <div className="flex flex-wrap gap-2 mt-3">
            <input value={chat} onChange={e => setChat(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void refine() }}
              placeholder={draft.format === 'single'
                ? t('crm.studio.chatPhSingle', 'z.B. „Badge-Text: …", „anderer Checkpunkt", „anderes Motiv: am Pool", „Caption kürzer" …')
                : t('crm.studio.chatPhCarousel', 'z.B. „nur 4 Karten“, „erste Karte: anderes Foto“, „Caption emotionaler“ …')}
              className="flex-1 min-w-[240px] border border-gray-200 rounded-xl px-4 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
            <button onClick={() => void refine()} disabled={busy !== null || imgBusy || !chat.trim()}
              className="px-5 py-3 rounded-xl text-base font-semibold text-white flex items-center gap-2 disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
              {busy === 'refine' && spinner}
              💬 {t('crm.studio.chatCta', 'Ändern')}
            </button>
          </div>
          {imgBusy && <p className="mt-1 text-[11px] text-gray-400">{t('crm.studio.chatBlocked', 'Das Bild wird gerade erstellt — Änderungen per Chat gehen gleich wieder.')}</p>}
          {draft.base_image && !imgBusy && <p className="mt-1 text-[11px] text-gray-400">{t('crm.studio.chatOnBase', 'Bild-Änderungen per Chat setzen wieder auf deiner hochgeladenen Vorlage auf.')}</p>}
          {lastChange && <p className="mt-1 text-[11px] text-gray-400">{t('crm.studio.changed', 'Zuletzt geändert')}: {lastChange === 'caption' ? t('crm.studio.caption', 'Caption') : lastChange === 'image' ? t('crm.studio.image', 'Bild') : t('crm.studio.cards', 'Karten')}</p>}

          {/* ── Agentur-Prüfung ────────────────────────────────────────── */}
          {(reviewBusy || review || blockers) && (
            <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-bold text-gray-800">🕵️ {t('crm.studio.reviewTitle', 'Agentur-Prüfung')}</span>
                {reviewBusy && <span className="text-xs text-gray-400 flex items-center gap-1.5">{spinner}{t('crm.studio.reviewBusy', 'prüft …')}</span>}
                {review && !reviewBusy && (
                  <span className="px-2.5 py-1 rounded-lg text-xs font-bold text-white"
                    style={{ backgroundColor: review.score >= 80 ? '#1a2332' : review.score >= 60 ? '#C2A15E' : '#ff795d' }}>
                    {review.score}/100 · {review.score >= 80
                      ? t('crm.studio.scoreStrong', 'stark')
                      : review.score >= 60 ? t('crm.studio.scoreOk', 'geht, Luft nach oben') : t('crm.studio.scoreWeak', 'so nicht schalten')}
                  </span>
                )}
                <button onClick={() => draft && void runReview(draft)} disabled={reviewBusy || busy !== null}
                  className="ml-auto px-2.5 py-1 rounded-lg text-xs text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
                  {t('crm.studio.reviewAgain', 'Neu prüfen')}
                </button>
              </div>
              {review?.verdict && <p className="mt-2 text-sm text-gray-700 leading-snug">{review.verdict}</p>}
              {(blockers ?? []).length > 0 && (
                <p className="mt-3 text-xs font-semibold text-[#ff795d]">
                  {t('crm.studio.blockedHint', 'Diese Punkte verhindern das Anlegen:')}
                </p>
              )}
              <ul className="mt-2 space-y-2">
                {[...(blockers ?? []), ...(review?.issues ?? [])].map((i, n) => (
                  <li key={n} className="text-xs leading-snug pl-3 border-l-2"
                    style={{ borderColor: i.severity === 'blocker' ? '#ff795d' : '#e6dfd0' }}>
                    <span className="font-semibold text-gray-700">{i.field}</span>
                    <span className="text-gray-600"> · {i.problem}</span>
                    {i.fix && <span className="block text-gray-400 mt-0.5">→ {i.fix}</span>}
                  </li>
                ))}
              </ul>
              {review?.strengths?.length ? (
                <p className="mt-3 text-[11px] text-gray-400">
                  {t('crm.studio.strengths', 'Trägt schon')}: {review.strengths.join(' · ')}
                </p>
              ) : null}
            </div>
          )}

          <div className="flex gap-2 mt-3">
            <button onClick={() => void publish()} disabled={busy !== null || imgBusy || reviewBusy || (draft.format === 'single' && !draft.image_url)}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-60" style={{ backgroundColor: '#16a34a' }}>
              {busy === 'publish' && spinner}
              ✅ {t('crm.studio.publish', 'Als Anzeige anlegen (pausiert)')}
            </button>
            {(blockers ?? []).length > 0 && (
              <button onClick={() => void publish(true)} disabled={busy !== null || imgBusy}
                className="px-3 py-2 rounded-lg text-sm font-medium border border-[#ff795d] text-[#ff795d] hover:bg-[#fff0ec] disabled:opacity-50">
                {t('crm.studio.publishAnyway', 'Trotzdem anlegen')}
              </button>
            )}
            <button onClick={() => { setDraft(null); setLastChange(''); setReview(null); setBlockers(null) }} disabled={busy !== null || imgBusy}
              className="px-3 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
              {t('crm.ads.audienceDiscard', 'Verwerfen')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
