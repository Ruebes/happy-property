import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import Modal from '../../ui/Modal'
import Spinner from '../../ui/Spinner'
import { supabase } from '../../../lib/supabase'
import { fnErrorDetail } from '../../../lib/fnError'
import type { MetaEntity } from '../../../lib/crmTypes'
import { metaLabel, useWerbeFormat } from './format'
import { LockedField, USD_PRO_EUR_FALLBACK } from './felder'
import { ladeUsdProEur } from './useWerbeDaten'
import EinstellungenAlt, { TargetingView } from './kampagnen/EinstellungenAlt'
import { ladeBuilderEinstellungen } from './kampagnen/builderApi'

// ── ⚙ Einstellungen einer Kampagne (Überblick, alles von Meta) ───────────────
// Lädt Kampagne, Anzeigengruppen und Anzeigen live über meta-ads-tools mode
// 'settings' und zeigt sie lesbar an. Ändern geht über den Kampagnen-
// Assistenten im Bearbeiten-Modus („Bearbeiten" je Ebene: Adresse
// ?tab=kampagnen&bearbeiten=<level>:<id>); dort zeigt „Das ändert sich bei
// Meta" vorher, was geschrieben wird, mit Wohnen-Regeln und Leitplanke. Die
// Schnell-Umschalter Pausieren/Aktivieren bleiben hier (update_entity mit
// Leitplanke); sie lassen das Fenster offen und laden frisch von Meta.
// Übergang: edit_apply und bulk gehen erst mit ad_settings.builder_enabled.
// Bis zu Svens Freischaltung (oder wenn die Einstellung nicht lesbar ist)
// zeigt dieses Fenster die bisherige Bearbeitung (./kampagnen/EinstellungenAlt).

type EntityType = 'campaign' | 'adset' | 'ad'

interface Props {
  /** Kampagne, deren Einstellungen gezeigt werden; null = geschlossen */
  kampagne: { id: string; name: string } | null
  onClose: () => void
  /** Nach jeder Änderung bei Meta: Werbemanager-Daten neu laden */
  onGeaendert: () => void
  showToast: (msg: string) => void
}

interface Zustand {
  /** Kampagne, zu der dieser Stand gehört (verhindert Aufblitzen alter Daten) */
  fuer: string | null
  loading: boolean
  busy: boolean
  data?: { campaign: MetaEntity; adsets: MetaEntity[]; ads: MetaEntity[] }
}

const LEER: Zustand = { fuer: null, loading: true, busy: false }

/** Metas Wert für „kein Limit“ (922337203685478) und gerundete Varianten */
const UNBEGRENZT_AB = 900000000000000

/** Fehlermeldung von Meta durchreichen statt sie hinter „fehlgeschlagen" zu verstecken. */
const metaError = (msg: string): string => msg.slice(0, 200)

export default function EinstellungenModal(props: Props) {
  const { t } = useTranslation()
  const cid = props.kampagne?.id ?? null
  // null = noch unbekannt; Bearbeiten über den Assistenten erst mit Freischaltung (builder_enabled)
  const [builderAn, setBuilderAn] = useState<boolean | null>(null)
  useEffect(() => {
    if (!cid) { setBuilderAn(null); return }
    let abbruch = false
    void ladeBuilderEinstellungen().then(s => { if (!abbruch) setBuilderAn(s?.builder_enabled === true) })
    return () => { abbruch = true }
  }, [cid])

  if (!props.kampagne) return null
  if (builderAn === null) {
    return (
      <Modal open onClose={props.onClose} size="xl" title={`⚙ ${props.kampagne.name}`}>
        <div className="flex justify-center py-16" aria-label={t('crm.werbung.bearbeiten.laedt', 'Lädt …')}><Spinner size="lg" /></div>
      </Modal>
    )
  }
  return builderAn ? <EinstellungenNeu {...props} /> : <EinstellungenAlt {...props} />
}

/** Mit Freischaltung: nur ansehen, Ändern über den Kampagnen-Assistenten, Pausieren/Aktivieren direkt */
function EinstellungenNeu({ kampagne, onClose, onGeaendert, showToast }: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [, setSearch] = useSearchParams()
  const [z, setZ] = useState<Zustand>(LEER)
  const [kurs, setKurs] = useState<number | null>(null)
  // Nur die Antwort der zuletzt angestoßenen Ladung zählt
  const anfrage = useRef(0)

  const cid = kampagne?.id ?? null

  const laden = useCallback(async (campaignId: string) => {
    const nr = ++anfrage.current
    setZ({ ...LEER, fuer: campaignId })
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', { body: { mode: 'settings', campaign_id: campaignId } })
      if (error) throw error
      const d = data as { campaign: MetaEntity; adsets: MetaEntity[]; ads: MetaEntity[]; error?: string }
      if (d.error) throw new Error(d.error)
      if (nr !== anfrage.current) return
      setZ(s => ({ ...s, loading: false, data: { campaign: d.campaign, adsets: d.adsets, ads: d.ads } }))
    } catch (err) {
      if (nr !== anfrage.current) return
      console.error('[AdsManager] openSettings:', err)
      onClose()
      showToast(`❌ ${t('crm.ads.settingsLoadError', 'Einstellungen konnten nicht geladen werden')}`)
    }
  }, [onClose, showToast, t])

  useEffect(() => {
    if (!cid) return
    void laden(cid)
    // Kurs für den EUR-Hinweis neben den Dollar-Beträgen (einmal je Sitzung)
    void ladeUsdProEur().then(setKurs)
    // Nur beim Öffnen einer (anderen) Kampagne laden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid])

  // Schließen verwirft späte Antworten
  const schliessen = () => { anfrage.current++; onClose() }

  /** Im Kampagnen-Assistenten bearbeiten (Reiter Kampagnen, Bearbeiten-Modus) */
  const bearbeiten = (level: EntityType, id: string) => {
    const next = new URLSearchParams(window.location.search)
    next.set('tab', 'kampagnen')
    next.set('bearbeiten', `${level}:${id}`)
    schliessen()
    setSearch(next, { replace: true })
  }

  /** Schnell-Umschalter Pausieren/Aktivieren: Fenster bleibt offen, danach frisch von Meta laden */
  const toggleStatus = async (entityId: string, entityType: EntityType, current: unknown) => {
    if (!cid || z.busy) return
    setZ(s => ({ ...s, busy: true }))
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: { mode: 'update_entity', entity_id: entityId, entity_type: entityType, patch: { status: String(current) === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' } },
      })
      // Edge-Fehler: invoke wirft bei non-2xx, die Klartext-Meldung steckt im Body
      if (error) throw new Error((await fnErrorDetail(error)).message)
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      showToast(t('crm.ads.entityUpdated', '✅ Bei Meta gespeichert'))
      await laden(cid)
      onGeaendert()
    } catch (err) {
      console.error('[AdsManager] toggleStatus:', err)
      setZ(s => ({ ...s, busy: false }))
      showToast(`❌ ${metaError(err instanceof Error ? err.message : String(err))}`)
    }
  }

  // ── Anzeige der Werte ─────────────────────────────────────────────────────
  const k = kurs && kurs > 0 ? kurs : USD_PRO_EUR_FALLBACK
  const geld = (v: unknown, limit = false): string => {
    const n = Number(v)
    if (v == null || v === '' || !Number.isFinite(n) || n <= 0) return limit ? t('crm.werbung.bearbeiten.keinLimit', 'kein Limit') : '-'
    if (limit && n >= UNBEGRENZT_AB) return t('crm.werbung.bearbeiten.keinLimit', 'kein Limit')
    const usd = n / 100
    return `$ ${usd.toLocaleString(fmt.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (≈ ${fmt.eur(usd / k)})`
  }
  const zeit = (v: unknown): string => {
    if (!v) return '-'
    const d = new Date(String(v))
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(fmt.locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const statusKnopf = (id: string, typ: EntityType, status: unknown, kurz = false) => (
    <button type="button" disabled={z.busy} onClick={() => void toggleStatus(id, typ, status)}
      className={`px-2.5 py-1 rounded-lg text-xs font-semibold border disabled:opacity-50 ${String(status) === 'ACTIVE' ? 'border-gray-300 text-gray-700 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}>
      {String(status) === 'ACTIVE'
        ? (kurz ? '⏸' : `⏸ ${t('crm.ads.actPause', 'Pausieren')}`)
        : (kurz ? '▶' : `▶ ${t('crm.ads.actActivate', 'Aktivieren')}`)}
    </button>
  )
  const bearbeitenKnopf = (typ: EntityType, id: string) => (
    <button type="button" disabled={z.busy} onClick={() => bearbeiten(typ, id)}
      className="px-2.5 py-1 rounded-lg text-xs font-semibold border border-hp-navy/30 text-hp-navy hover:bg-hp-navy/5 disabled:opacity-50">
      ✏️ {t('crm.werbung.bearbeiten.knopfBearbeiten', 'Bearbeiten')}
    </button>
  )

  return (
    <Modal open={!!kampagne} onClose={schliessen} size="xl" title={kampagne ? `⚙ ${kampagne.name}` : undefined}>
      {z.loading || !z.data || !cid || z.fuer !== cid ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-xs text-hp-navy">
            {t('crm.werbung.bearbeiten.einstellungenHinweis', 'Ändern geht über „Bearbeiten“: der Kampagnen-Assistent zeigt vorher, was sich bei Meta ändert, und achtet auf die Wohnen-Regeln. Pausieren und Aktivieren gehen hier direkt.')}
          </p>

          {/* Kampagne */}
          {(() => {
            const c = z.data.campaign
            return (
              <div className="rounded-xl border border-gray-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <p className="font-bold text-gray-800">{t('crm.ads.setCampaign', 'Kampagne')}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-gray-500">{metaLabel(c.effective_status ?? c.status)}</span>
                    {statusKnopf(cid, 'campaign', c.status)}
                    {bearbeitenKnopf('campaign', cid)}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="sm:col-span-2"><LockedField label={t('crm.ads.setName', 'Name')} value={String(c.name ?? '-')} /></div>
                  <LockedField label={t('crm.ads.setDailyBudget', 'Tagesbudget')} value={geld(c.daily_budget)} />
                  <LockedField label={t('crm.ads.setLifetimeBudget', 'Laufzeitbudget')} value={geld(c.lifetime_budget)} />
                  <LockedField label={t('crm.ads.setSpendCap', 'Ausgabenlimit gesamt')} value={geld(c.spend_cap, true)} />
                  <LockedField label={t('crm.ads.setBidStrategy', 'Gebotsstrategie')} value={metaLabel(c.bid_strategy)} />
                  <LockedField label={t('crm.ads.setStart', 'Start')} value={zeit(c.start_time)} />
                  <LockedField label={t('crm.ads.setStop', 'Ende')} value={zeit(c.stop_time)} />
                  <LockedField label={t('crm.ads.setObjective', 'Ziel')} value={metaLabel(c.objective)} />
                  <LockedField label={t('crm.werbung.bearbeiten.label.buchungsart', 'Buchungsart')} value={metaLabel(c.buying_type)} />
                </div>
              </div>
            )
          })()}

          {/* Anzeigengruppen */}
          {z.data.adsets.map(a => {
            const aid = String(a.id)
            return (
              <div key={aid} className="rounded-xl border border-gray-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <p className="font-bold text-gray-800 truncate">{t('crm.ads.setAdset', 'Anzeigengruppe')}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-gray-500">{metaLabel(a.effective_status ?? a.status)}</span>
                    {statusKnopf(aid, 'adset', a.status)}
                    {bearbeitenKnopf('adset', aid)}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="sm:col-span-2"><LockedField label={t('crm.ads.setName', 'Name')} value={String(a.name ?? '-')} /></div>
                  <LockedField label={t('crm.ads.setDailyBudget', 'Tagesbudget')} value={geld(a.daily_budget)} />
                  <LockedField label={t('crm.ads.setLifetimeBudget', 'Laufzeitbudget')} value={geld(a.lifetime_budget)} />
                  <LockedField label={t('crm.ads.setOptimization', 'Optimiert auf')} value={metaLabel(a.optimization_goal)} />
                  <LockedField label={t('crm.ads.setBidStrategy', 'Gebotsstrategie')} value={metaLabel(a.bid_strategy)} />
                  <LockedField label={t('crm.ads.setBidAmount', 'Gebot')} value={geld(a.bid_amount)} />
                  <LockedField label={t('crm.ads.setBilling', 'Abrechnung')} value={metaLabel(a.billing_event)} />
                  <LockedField label={t('crm.ads.setStart', 'Start')} value={zeit(a.start_time)} />
                  <LockedField label={t('crm.ads.setEnd', 'Ende')} value={zeit(a.end_time)} />
                </div>
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="mb-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('crm.ads.setTargeting', 'Zielgruppe')}</p>
                  <TargetingView targeting={a.targeting as Record<string, unknown>} />
                </div>
              </div>
            )
          })}

          {/* Anzeigen */}
          <div className="rounded-xl border border-gray-200 p-3">
            <p className="font-bold text-gray-800 mb-2">{t('crm.ads.setAds', 'Anzeigen')} ({z.data.ads.length})</p>
            <div className="space-y-1.5">
              {z.data.ads.map(ad => {
                const linkData = ((ad.creative as { object_story_spec?: { link_data?: { link?: string; call_to_action?: { type?: string } } } } | undefined)?.object_story_spec?.link_data)
                const adId = String(ad.id)
                return (
                  <div key={adId} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${String(ad.effective_status ?? ad.status) === 'ACTIVE' ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className="flex-1 min-w-[160px] truncate text-gray-800" title={String(ad.name ?? '')}>{String(ad.name ?? adId)}</span>
                    <span className="text-gray-400">{metaLabel(ad.effective_status ?? ad.status)}</span>
                    {linkData?.link && <span className="text-gray-400 truncate max-w-[180px]" title={linkData.link}>→ {linkData.link.replace('https://', '')}</span>}
                    {statusKnopf(adId, 'ad', ad.status, true)}
                    <button type="button" disabled={z.busy} onClick={() => bearbeiten('ad', adId)}
                      aria-label={t('crm.werbung.bearbeiten.anzeigeBearbeiten', 'Anzeige bearbeiten')}
                      className="px-2 py-0.5 rounded border border-gray-200 text-[11px] text-hp-navy hover:border-hp-navy/40 disabled:opacity-50">
                      ✏️
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
          <p className="text-[11px] text-gray-400">
            {t('crm.werbung.bearbeiten.einstellungenFuss', 'Pausieren und Aktivieren wirken sofort bei Meta (mit Leitplanke). 🔒-Werte hier sind nur Anzeige.')}
          </p>
        </div>
      )}
    </Modal>
  )
}
