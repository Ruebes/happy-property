import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import AdStudio from '../AdStudio'
import { supabase } from '../../../lib/supabase'
import type { AudienceDraft } from '../../../lib/crmTypes'
import { useWerbeKontext } from './useWerbeDaten'
import { useWerbeFormat } from './format'
import { BTN_KLEIN_BREIT } from './felder'

// ── Reiter „Werbemittel" des Werbemanagers ────────────────────────────────────
// Bisher „Anzeigen-Studio": KI-Studio, Vorbereitete Anzeigen und der
// Zielgruppen-Assistent (System-Kampagne). Unverändert aus AdsManager.tsx
// übernommen; der Vorrat (Creative-Pool) kommt als eigener Abschnitt dazu.

const spinnerWeiss = <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />

// Standard-Export ohne Props (lazyWithReload): Daten kommen aus dem WerbeKontext
export default function WerbemittelTab() {
  const { t } = useTranslation()
  const { locale } = useWerbeFormat()
  const { prepared, fetchAll, runSync, openPreview, showToast } = useWerbeKontext()

  // Zielgruppen-Assistent (lernend: Feedback wird dauerhafte Regel)
  const [audienceText, setAudienceText] = useState('')
  const [audienceFeedback, setAudienceFeedback] = useState('')
  const [audienceBusy, setAudienceBusy] = useState(false)
  const [audienceDraft, setAudienceDraft] = useState<AudienceDraft | null>(null)

  // ── Vorbereitete Anzeige freigeben: erscheint danach (weiterhin pausiert)
  // in der normalen Anzeigen-Übersicht und wird DORT wie gewohnt aktiviert. ──
  const releasePrepared = async (adId: string) => {
    try {
      const { error } = await supabase.from('studio_prepared_ads')
        .update({ released_at: new Date().toISOString() }).eq('ad_id', adId)
      if (error) throw error
      showToast(t('crm.ads.prepReleased', '✅ Freigegeben - die Anzeige steht jetzt (pausiert) bei den anderen Anzeigen'))
      void fetchAll()
    } catch (err) {
      console.error('[AdsManager] releasePrepared:', err)
      showToast(`❌ ${t('crm.ads.toastError', 'Fehler beim Speichern')}`)
    }
  }

  // ── Zielgruppen-Assistent ─────────────────────────────────────────────────
  const suggestAudience = async (withFeedback?: string) => {
    if (!audienceText.trim() || audienceBusy) return
    setAudienceBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: {
          mode: 'audience_suggest', description: audienceText.trim(),
          ...(withFeedback ? { feedback: withFeedback, previous_draft: audienceDraft } : {}),
        },
      })
      if (error) throw error
      setAudienceDraft((data as { draft: AudienceDraft | null }).draft)
      if (withFeedback) {
        setAudienceFeedback('')
        showToast(t('crm.ads.ruleLearned', '🧠 Korrektur gespeichert - gilt ab jetzt für alle Vorschläge'))
      }
    } catch (err) {
      console.error('[AdsManager] suggestAudience:', err)
      showToast(`❌ ${t('crm.ads.audienceError', 'Vorschlag fehlgeschlagen - bitte nochmal versuchen')}`)
    } finally {
      setAudienceBusy(false)
    }
  }

  const applyAudience = async () => {
    if (!audienceDraft || audienceBusy) return
    setAudienceBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: { mode: 'audience_apply', targeting_draft: audienceDraft, description: audienceText.trim() },
      })
      if (error) throw error
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      showToast(t('crm.ads.audienceApplied', '✅ Zielgruppe auf die System-Kampagne angewendet'))
      setAudienceDraft(null)
      setAudienceText('')
    } catch (err) {
      console.error('[AdsManager] applyAudience:', err)
      showToast(`❌ ${t('crm.ads.audienceError', 'Vorschlag fehlgeschlagen - bitte nochmal versuchen')}`)
    } finally {
      setAudienceBusy(false)
    }
  }

  return (
    <div>
      {/* KI-Anzeigen-Studio: Brief -> Anzeige (Bild/Karussell + Caption) -> Chat-Bearbeitung */}
      <AdStudio showToast={showToast} onPublished={() => { void runSync() }} />

      {/* Vorbereitete Anzeigen: erstellt, aber noch nicht in der Übersicht.
          „Freigeben" nimmt sie (weiterhin pausiert) zu den anderen Anzeigen dazu. */}
      <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-bold text-gray-800 mb-1">📦 {t('crm.ads.prepTitle', 'Vorbereitete Anzeigen')}</h2>
        <p className="text-sm text-gray-400 mb-3">{t('crm.ads.prepSub', 'Hier gespeicherte Anzeigen sind noch NICHT in der Übersicht und noch nicht aktiv. „Freigeben" nimmt sie (pausiert) zu den anderen Anzeigen dazu - aktiviert werden sie dann dort.')}</p>
        {prepared.length === 0 ? (
          <p className="text-sm text-gray-400 border-2 border-dashed border-gray-200 rounded-xl py-6 text-center">{t('crm.ads.prepEmpty', 'Keine vorbereiteten Anzeigen - neu erstellte landen automatisch hier.')}</p>
        ) : (
          <div className="space-y-2">
            {prepared.map(p => (
              <div key={p.ad_id} className="flex flex-wrap items-center gap-3 border border-gray-100 rounded-xl px-3 py-2.5">
                {p.thumbnail_url
                  ? <img src={p.thumbnail_url} alt="" className="w-12 h-12 rounded-lg object-cover" />
                  : <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-lg">🖼</div>}
                <div className="flex-1 min-w-[160px]">
                  <p className="text-sm font-semibold text-gray-800">{p.ad_name ?? p.ad_id}</p>
                  <p className="text-[11px] text-gray-400">
                    {t('crm.ads.prepSince', 'vorbereitet seit')} {new Date(p.prepared_at).toLocaleDateString(locale)}
                    {p.campaign_name ? ` · ${p.campaign_name}` : ''}
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500">{t('crm.ads.prepBadge', 'Nicht veröffentlicht')}</span>
                <button onClick={() => openPreview(p)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50">
                  👁 {t('crm.ads.preview', 'Vorschau')}
                </button>
                <button onClick={() => void releasePrepared(p.ad_id)} className={BTN_KLEIN_BREIT}>
                  ✅ {t('crm.ads.prepRelease', 'Freigeben')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Zielgruppen-Assistent: Beschreibung -> Meta-Targeting (System-Kampagne) */}
      <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-bold text-gray-800 mb-1">🧲 {t('crm.ads.audienceTitle', 'Zielgruppen-Assistent (System-Kampagne)')}</h2>
        <p className="text-sm text-gray-400 mb-3">{t('crm.ads.audienceSub', 'Beschreibe in normalen Worten, wen die Werbung erreichen soll - das System übersetzt das in Meta-Targeting und zeigt dir den Vorschlag, bevor er übernommen wird.')}</p>
        <div className="flex flex-wrap gap-2">
          <textarea value={audienceText} onChange={e => setAudienceText(e.target.value)} rows={3}
            placeholder={t('crm.ads.audiencePh', 'z.B. „Deutsche Ärzte und Apotheker ab 40, die schon Immobilien besitzen und Steuern sparen wollen“')}
            className="flex-1 min-w-[280px] border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-hp-navy/20 resize-y" />
          <button onClick={() => void suggestAudience()} disabled={audienceBusy || !audienceText.trim()}
            className="hp-btn hp-btn-primary self-start px-6 py-3 text-base font-semibold rounded-xl">
            {audienceBusy && spinnerWeiss}
            🪄 {t('crm.ads.audienceCta', 'Vorschlag erarbeiten')}
          </button>
        </div>
        {audienceDraft && (
          <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50/50 p-3 text-sm">
            <p className="text-gray-800 mb-2">{audienceDraft.summary}</p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="px-2 py-0.5 rounded-full bg-white border border-gray-200">🎂 {audienceDraft.age_min}-{audienceDraft.age_max}</span>
              <span className="px-2 py-0.5 rounded-full bg-white border border-gray-200">🌍 {audienceDraft.countries.join(', ')}</span>
              <span className="px-2 py-0.5 rounded-full bg-white border border-gray-200">
                {audienceDraft.genders === 'maenner' ? `♂ ${t('crm.ads.men', 'Männer')}` : audienceDraft.genders === 'frauen' ? `♀ ${t('crm.ads.women', 'Frauen')}` : `⚥ ${t('crm.ads.all', 'Alle')}`}
              </span>
              {audienceDraft.interests.map(i => (
                <span key={i.id} className="px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-800" title={i.audience ? `${t('crm.ads.reach', 'Reichweite')}: ${i.audience.toLocaleString(locale)}` : undefined}>
                  💡 {i.name}
                </span>
              ))}
              {audienceDraft.jobs.map(j => (
                <span key={j.id} className="px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-800">💼 {j.name}</span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button onClick={() => void applyAudience()} disabled={audienceBusy} className={BTN_KLEIN_BREIT}>
                ✅ {t('crm.ads.audienceApply', 'Auf System-Kampagne anwenden')}
              </button>
              <button onClick={() => setAudienceDraft(null)} className="px-3 py-1.5 rounded-lg text-xs text-gray-600 border border-gray-200 hover:bg-gray-50">
                {t('crm.ads.audienceDiscard', 'Verwerfen')}
              </button>
              {/* Lern-Schleife: Korrektur -> dauerhafte Regel + neuer Vorschlag */}
              <input value={audienceFeedback} onChange={e => setAudienceFeedback(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && audienceFeedback.trim()) void suggestAudience(audienceFeedback.trim()) }}
                placeholder={t('crm.ads.feedbackPh', 'Korrektur, z.B. „nur Männer“ oder „ohne Österreich“ …')}
                className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-hp-navy/20" />
              <button onClick={() => void suggestAudience(audienceFeedback.trim())} disabled={audienceBusy || !audienceFeedback.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                🧠 {t('crm.ads.feedbackCta', 'Anpassen (wird gelernt)')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
