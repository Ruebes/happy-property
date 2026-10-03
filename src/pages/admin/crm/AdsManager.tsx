import { Suspense, useCallback, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useSearchParams } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import ContentErrorBoundary from '../../../components/shell/ContentErrorBoundary'
import Tabs, { initialTabFromUrl, tabPanelProps, type TabItem } from '../../../components/ui/Tabs'
import Spinner from '../../../components/ui/Spinner'
import { ToastProvider, useToast } from '../../../components/ui/Toast'
import { ConfirmProvider } from '../../../components/ui/ConfirmDialog'
import EinstellungenModal from '../../../components/crm/werbung/EinstellungenModal'
import VorschauModal from '../../../components/crm/werbung/VorschauModal'
import { WerbeKontext, useWerbeDaten, type WerbeKontextWert } from '../../../components/crm/werbung/useWerbeDaten'
import { supabase } from '../../../lib/supabase'
import { lazyWithReload } from '../../../lib/lazyWithReload'
import { useAuth, hasAdSegment, hasPerm, AD_SEGMENTS, type AdSegment } from '../../../lib/auth'
import type { AdCatalogRow, WerbeZeitraum } from '../../../lib/crmTypes'

// ── Werbemanager (/admin/crm/ads) ─────────────────────────────────────────────
// Rahmen der Seite: Kopf (Kanal, Zeitraum, Aktualisieren) und die Reiter.
// Auswertung der Werbe-Plattformen (Stufe 1: META live, YouTube/Google folgen).
// Daten + Aggregation: components/crm/werbung/useWerbeDaten.ts, die Reiter
// liegen als eigene Dateien daneben und laden über lazyWithReload. Sie holen
// Seitendaten und Aktionen aus dem WerbeKontext (keine Pflicht-Props).

const WerbeStatistik = lazyWithReload(() => import('../../../components/crm/werbung/WerbeStatistik'))
const KampagnenTab = lazyWithReload(() => import('../../../components/crm/werbung/KampagnenTab'))
const WerbemittelTab = lazyWithReload(() => import('../../../components/crm/werbung/WerbemittelTab'))
const QualitaetTab = lazyWithReload(() => import('../../../components/crm/werbung/QualitaetTab'))
const AutopilotTab = lazyWithReload(() => import('../../../components/crm/werbung/AutopilotTab'))

const REITER = ['stats', 'kampagnen', 'werbemittel', 'qualitaet', 'autopilot'] as const
type ReiterId = typeof REITER[number]

const REITER_KOMPONENTE: Record<ReiterId, LazyExoticComponent<ComponentType<object>>> = {
  stats: WerbeStatistik,
  kampagnen: KampagnenTab,
  werbemittel: WerbemittelTab,
  qualitaet: QualitaetTab,
  autopilot: AutopilotTab,
}

// Reiter, die die Seitendaten zeigen: während fetchAll läuft, steht wie bisher
// der Lade-Ring statt des Inhalts. Die übrigen Reiter laden selbst.
const MIT_SEITENDATEN: ReadonlySet<ReiterId> = new Set<ReiterId>(['stats', 'werbemittel'])

// Alte Adressen: ?tab=studio war das Anzeigen-Studio, heute Werbemittel
const ALT_REITER: Record<string, ReiterId> = { studio: 'werbemittel' }

const anfangsReiter = (): ReiterId => {
  try {
    const alt = ALT_REITER[new URLSearchParams(window.location.search).get('tab') ?? '']
    if (alt) return alt
  } catch { /* ohne Adresse: Standard */ }
  return initialTabFromUrl(REITER, 'stats') as ReiterId
}

const SEG_LABEL: Record<AdSegment, string> = {
  meta: 'META', youtube: 'YouTube', google: 'Google Ads',
}

function Lader() {
  return <div className="flex justify-center py-24"><Spinner size="lg" /></div>
}

// Hinweise der Seite über den gemeinsamen Toast. Die Texte tragen bisher ein
// führendes Symbol: ✅ = Erfolg, ❌/⛔ = Fehler (Symbol entfällt, der Toast hat
// ein eigenes), alles andere als Info mit Symbol.
function useHinweis(): (msg: string) => void {
  const toast = useToast()
  return useCallback((msg: string) => {
    const m = msg.trim()
    if (m.startsWith('❌') || m.startsWith('⛔')) toast.error(m.replace(/^(❌|⛔)\s*/u, ''))
    else if (m.startsWith('✅')) toast.success(m.replace(/^✅\s*/u, ''))
    else toast.info(m)
  }, [toast])
}

export default function AdsManager() {
  return (
    <DashboardLayout basePath="/admin/crm">
      <ToastProvider>
        <ConfirmProvider>
          <Werbemanager />
        </ConfirmProvider>
      </ToastProvider>
    </DashboardLayout>
  )
}

function Werbemanager() {
  const { t } = useTranslation()
  const { profile, loading: authLoading } = useAuth()
  const showToast = useHinweis()
  const location = useLocation()
  const [search, setSearch] = useSearchParams()

  const segments = AD_SEGMENTS.filter(s => hasAdSegment(profile, s))
  const canSeeCrm = hasPerm(profile, 'pipeline')
  const [segment, setSegment] = useState<AdSegment>('meta')
  const [days, setDays] = useState<WerbeZeitraum>(30)
  const [tab, setTab] = useState<ReiterId>(anfangsReiter)
  // Einmal geöffnete Reiter bleiben eingehängt (nur versteckt): Eingaben,
  // aufgeklappte Kampagnen und Entwürfe überstehen Reiterwechsel und Neuladen.
  const [besucht, setBesucht] = useState<ReadonlySet<ReiterId>>(() => new Set([anfangsReiter()]))
  const [syncing, setSyncing] = useState(false)
  const [vorschauAd, setVorschauAd] = useState<AdCatalogRow | null>(null)
  const [einstellungen, setEinstellungen] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    if (segments.length && !segments.includes(segment)) setSegment(segments[0])
    // segments ist von profile abgeleitet, profile reicht als Abhängigkeit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  // Erst laden, wenn das Profil da ist (oder die Anmeldung ohne Profil fertig ist)
  const profileReady = !!profile || !authLoading
  const daten = useWerbeDaten(segment, days, canSeeCrm, profileReady)
  const { fetchAll, campaignName } = daten

  // Alte Adresse ?tab=studio auf den neuen Reiter umschreiben (ohne Verlaufs-Eintrag)
  const tabParam = search.get('tab')
  useEffect(() => {
    const neu = tabParam ? ALT_REITER[tabParam] : undefined
    if (!neu) return
    const next = new URLSearchParams(window.location.search)
    next.set('tab', neu)
    setSearch(next, { replace: true, state: location.state })
    // Nur wenn der Parameter wechselt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam])

  const wechsleReiter = useCallback((id: string) => {
    const r = (REITER as readonly string[]).includes(id) ? id as ReiterId : 'stats'
    setTab(r)
    setBesucht(prev => (prev.has(r) ? prev : new Set([...prev, r])))
  }, [])

  // ── Sync on demand (Edge Function meta-ads-sync, läuft sonst täglich) ─────
  const runSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-sync', { body: { days: 3 } })
      if (error) throw error
      const d = data as { insight_rows?: number } | null
      showToast(t('crm.ads.toastSynced', '✅ Aktualisiert - {{n}} Tageswerte von Meta geholt', { n: d?.insight_rows ?? 0 }))
      await fetchAll()
    } catch (err) {
      console.error('[AdsManager] runSync:', err)
      showToast(`❌ ${t('crm.ads.toastSyncError', 'Aktualisierung fehlgeschlagen')}`)
    } finally {
      setSyncing(false)
    }
  }, [syncing, fetchAll, showToast, t])

  const openPreview = useCallback((ad: AdCatalogRow) => setVorschauAd(ad), [])
  const openSettings = useCallback((cid: string) => setEinstellungen({ id: cid, name: campaignName(cid) }), [campaignName])
  const closeSettings = useCallback(() => setEinstellungen(null), [])
  const closePreview = useCallback(() => setVorschauAd(null), [])
  const onGeaendert = useCallback(() => { void fetchAll() }, [fetchAll])

  const kontext: WerbeKontextWert = {
    ...daten, segment, days, syncing, runSync, openPreview, openSettings, showToast,
  }

  const tabItems: TabItem[] = [
    { id: 'stats', label: t('crm.werbung.tabs.stats', 'Statistik') },
    { id: 'kampagnen', label: t('crm.werbung.tabs.kampagnen', 'Kampagnen') },
    { id: 'werbemittel', label: t('crm.werbung.tabs.werbemittel', 'Werbemittel') },
    { id: 'qualitaet', label: t('crm.werbung.tabs.qualitaet', 'Qualität') },
    { id: 'autopilot', label: t('crm.werbung.tabs.autopilot', 'Autopilot') },
  ]

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {/* Kopf: Titel + Plattform-Tabs + Zeitraum */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('crm.ads.title', 'Werbemanager')}</h1>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {segments.map(s => (
            <button key={s} type="button" onClick={() => setSegment(s)} aria-pressed={segment === s}
              className={`px-3 py-1.5 text-sm font-semibold ${segment === s ? 'bg-hp-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {SEG_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {([7, 30, 90] as const).map(d => (
              <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
                className={`px-3 py-1.5 text-sm font-medium ${days === d ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {t('crm.ads.days', '{{n}} Tage', { n: d })}
              </button>
            ))}
          </div>
          {segment === 'meta' && (
            <button type="button" onClick={() => void runSync()} disabled={syncing}
              className="hp-btn hp-btn-primary px-3 py-1.5 font-semibold">
              {syncing && <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              🔄 {t('crm.ads.syncNow', 'Aktualisieren')}
            </button>
          )}
        </div>
      </div>

      {segment !== 'meta' ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">
          <p className="text-3xl mb-2">🚧</p>
          <p className="font-semibold text-gray-700">{SEG_LABEL[segment]} {t('crm.ads.comingSoon', 'ist noch nicht angebunden')}</p>
          <p className="text-sm mt-1">{t('crm.ads.comingSoonSub', 'META läuft bereits - weitere Kanäle folgen hier im gleichen Format.')}</p>
        </div>
      ) : (
        <WerbeKontext.Provider value={kontext}>
          <Tabs tabs={tabItems} value={tab} onChange={wechsleReiter} urlParam="tab" idBase="werbung"
            ariaLabel={t('crm.werbung.tabs.aria', 'Bereiche des Werbemanagers')} className="mb-5" />

          {REITER.filter(id => besucht.has(id)).map(id => {
            const Reiter = REITER_KOMPONENTE[id]
            const wartet = daten.loading && MIT_SEITENDATEN.has(id)
            return (
              <div key={id} {...tabPanelProps('werbung', id)} hidden={id !== tab || wartet}>
                <ContentErrorBoundary scope={`Werbemanager/${id}`}>
                  <Suspense fallback={<Lader />}>
                    <Reiter />
                  </Suspense>
                </ContentErrorBoundary>
              </div>
            )
          })}
          {daten.loading && MIT_SEITENDATEN.has(tab) && <Lader />}
        </WerbeKontext.Provider>
      )}

      {/* ⚙ Voll-Einstellungen einer Kampagne + Anzeigen-Vorschau (aus Statistik und Werbemittel) */}
      <EinstellungenModal kampagne={einstellungen} onClose={closeSettings} onGeaendert={onGeaendert} showToast={showToast} />
      <VorschauModal ad={vorschauAd} onClose={closePreview} showToast={showToast} />
    </div>
  )
}
