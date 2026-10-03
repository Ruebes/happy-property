import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../ui/Modal'
import Spinner from '../../ui/Spinner'
import { supabase } from '../../../lib/supabase'
import type { AdCatalogRow } from '../../../lib/crmTypes'

// ── Anzeigen-Vorschau (Facebook / Instagram / Story) ─────────────────────────
// Lädt die Vorschau über meta-ads-tools mode 'preview' (Meta liefert fertige
// iframe-Snippets) plus Überschrift und Text. Fehler: Fenster zu + Hinweis.

type VorschauTab = 'facebook' | 'instagram' | 'story'

interface Props {
  /** Anzeige, deren Vorschau gezeigt wird; null = geschlossen */
  ad: AdCatalogRow | null
  onClose: () => void
  showToast: (msg: string) => void
}

const TABS: ReadonlyArray<readonly [VorschauTab, string]> = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['story', 'Story']]

export default function VorschauModal({ ad, onClose, showToast }: Props) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  // Anzeige, zu der der Stand gehört (verhindert Aufblitzen alter Vorschauen)
  const [fuer, setFuer] = useState<string | null>(null)
  const [tab, setTab] = useState<VorschauTab>('facebook')
  const [previews, setPreviews] = useState<Record<string, string> | undefined>(undefined)
  const [caption, setCaption] = useState<{ message: string; headline: string } | undefined>(undefined)
  // Nur die Antwort der zuletzt geöffneten Anzeige zählt
  const anfrage = useRef(0)

  const adId = ad?.ad_id ?? null
  useEffect(() => {
    if (!adId) return
    const nr = ++anfrage.current
    setLoading(true); setFuer(adId); setTab('facebook'); setPreviews(undefined); setCaption(undefined)
    void (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('meta-ads-tools', { body: { mode: 'preview', ad_id: adId } })
        if (error) throw error
        if (nr !== anfrage.current) return
        const d = data as { previews: Record<string, string>; caption: { message: string; headline: string } }
        setPreviews(d.previews); setCaption(d.caption); setLoading(false)
      } catch (err) {
        if (nr !== anfrage.current) return
        console.error('[AdsManager] openPreview:', err)
        onClose()
        showToast(`❌ ${t('crm.ads.previewError', 'Vorschau konnte nicht geladen werden')}`)
      }
    })()
    // Nur beim Öffnen einer (anderen) Anzeige laden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adId])

  // Schließen verwirft späte Antworten
  const schliessen = () => { anfrage.current++; onClose() }

  return (
    <Modal open={!!ad} onClose={schliessen} size="md" title={ad ? `👁 ${ad.ad_name ?? ad.ad_id}` : undefined}>
      <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            className={`flex-1 px-3 py-1.5 font-medium ${tab === key ? 'bg-hp-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="pt-4">
        {loading || fuer !== adId ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : previews?.[tab] ? (
          // Meta liefert die Vorschau als fertiges iframe-Snippet
          <div className="flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: previews[tab] }} />
        ) : (
          <p className="text-sm text-gray-400 text-center py-10">{t('crm.ads.previewUnavailable', 'Für dieses Format liefert Meta keine Vorschau.')}</p>
        )}
        {caption && !loading && fuer === adId && (
          <div className="mt-3 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
            <p className="text-xs font-bold text-gray-700">{caption.headline}</p>
            <p className="mt-1 text-xs text-gray-600 whitespace-pre-wrap max-h-48 overflow-y-auto">{caption.message}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
