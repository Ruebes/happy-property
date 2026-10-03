import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../ui/Modal'
import Spinner from '../../ui/Spinner'
import TargetingEditor from '../TargetingEditor'
import { CustomSelect } from '../../CustomSelect'
import { supabase } from '../../../lib/supabase'
import { fnErrorDetail } from '../../../lib/fnError'
import type { MetaEntity } from '../../../lib/crmTypes'
import { metaLabel } from './format'
import {
  BID_STRATEGY_OPTIONS, BTN_KLEIN, Field, INPUT_CLS, LockedField, OPTIMIZATION_OPTIONS, UsdEurHinweis,
  baueMetaPatch, metaFeldWert,
} from './felder'
import { ladeUsdProEur } from './useWerbeDaten'

// ── ⚙ Voll-Einstellungen einer Kampagne (alles von Meta, wichtige Hebel änderbar)
// Lädt Kampagne, Anzeigengruppen und Anzeigen live über meta-ads-tools mode
// 'settings'. Speichern geht direkt zu Meta (update_entity / targeting_apply).
// Svens Regel (15.8.): nach „Speichern" schließt das Fenster sofort, der
// Hinweis liegt auf der Seite; Schnell-Umschalter (Pausieren/Aktivieren)
// lassen es offen und laden frisch von Meta.

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
  // edits: entity_id -> offene Änderungen (erst beim Speichern zu Meta)
  edits: Record<string, Record<string, string>>
  // targetingEdits: adset_id -> bearbeitetes Targeting-Objekt
  targetingEdits: Record<string, Record<string, unknown>>
}

const LEER: Zustand = { fuer: null, loading: true, busy: false, edits: {}, targetingEdits: {} }

// Komplettes Meta-Targeting lesbar aufbereitet (alles anzeigen, nichts verstecken)
function TargetingView({ targeting }: { targeting: Record<string, unknown> | null | undefined }) {
  if (!targeting) return <span className="text-gray-400">-</span>
  const tg = targeting as {
    age_min?: number; age_max?: number; genders?: number[]
    geo_locations?: { countries?: string[]; cities?: Array<{ name: string }>; regions?: Array<{ name: string }> }
    excluded_geo_locations?: { countries?: string[] }
    flexible_spec?: Array<Record<string, Array<{ id: string; name: string }>>>
    exclusions?: Record<string, Array<{ id: string; name: string }>>
    custom_audiences?: Array<{ id: string; name: string }>
    excluded_custom_audiences?: Array<{ id: string; name: string }>
    publisher_platforms?: string[]
    targeting_automation?: { advantage_audience?: number }
  }
  const chip = (txt: string, cls: string, key: string) => (
    <span key={key} className={`px-2 py-0.5 rounded-full border text-[11px] ${cls}`}>{txt}</span>
  )
  const chips: JSX.Element[] = []
  chips.push(chip(`🎂 ${tg.age_min ?? 18}-${tg.age_max ?? 65}`, 'bg-white border-gray-200', 'age'))
  chips.push(chip(tg.genders?.length === 1 ? (tg.genders[0] === 1 ? '♂ Männer' : '♀ Frauen') : '⚥ Alle', 'bg-white border-gray-200', 'gender'))
  const geo = [
    ...(tg.geo_locations?.countries ?? []),
    ...(tg.geo_locations?.regions?.map(r => r.name) ?? []),
    ...(tg.geo_locations?.cities?.map(c => c.name) ?? []),
  ]
  if (geo.length) chips.push(chip(`🌍 ${geo.join(', ')}`, 'bg-white border-gray-200', 'geo'))
  if (tg.excluded_geo_locations?.countries?.length) chips.push(chip(`🚫🌍 ${tg.excluded_geo_locations.countries.join(', ')}`, 'bg-red-50 border-red-200 text-red-700', 'geoex'))
  ;(tg.flexible_spec ?? []).forEach((group, gi) => {
    for (const [key, items] of Object.entries(group)) {
      if (!Array.isArray(items)) continue
      const icon = key === 'interests' ? '💡' : key === 'work_positions' ? '💼' : key === 'behaviors' ? '🧭' : key === 'work_employers' ? '🏢' : '🔖'
      items.forEach(it => chips.push(chip(`${icon} ${it.name}`, gi === 0 ? 'bg-blue-50 border-blue-200 text-blue-800' : 'bg-purple-50 border-purple-200 text-purple-800', `${gi}-${key}-${it.id}`)))
    }
  })
  for (const [key, items] of Object.entries(tg.exclusions ?? {})) {
    if (Array.isArray(items)) items.forEach(it => chips.push(chip(`🚫 ${it.name}`, 'bg-red-50 border-red-200 text-red-700', `ex-${key}-${it.id}`)))
  }
  ;(tg.custom_audiences ?? []).forEach(a => chips.push(chip(`👥 ${a.name}`, 'bg-green-50 border-green-200 text-green-800', `ca-${a.id}`)))
  ;(tg.excluded_custom_audiences ?? []).forEach(a => chips.push(chip(`🚫👥 ${a.name}`, 'bg-red-50 border-red-200 text-red-700', `cax-${a.id}`)))
  chips.push(chip(tg.publisher_platforms?.length ? `📱 ${tg.publisher_platforms.join(', ')}` : '📱 Platzierungen: Automatisch', 'bg-white border-gray-200', 'plat'))
  if (tg.targeting_automation?.advantage_audience === 1) chips.push(chip('✨ Advantage+ Audience', 'bg-amber-50 border-amber-200 text-amber-800', 'adv'))
  return <div className="flex flex-wrap gap-1.5">{chips}</div>
}

/** Fehlermeldung von Meta durchreichen statt sie hinter „fehlgeschlagen" zu verstecken. */
const metaError = (msg: string): string => msg.slice(0, 200)

export default function EinstellungenModal({ kampagne, onClose, onGeaendert, showToast }: Props) {
  const { t } = useTranslation()
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
    // Kurs für den EUR-Hinweis neben den Dollar-Feldern (einmal je Sitzung)
    void ladeUsdProEur().then(setKurs)
    // Nur beim Öffnen einer (anderen) Kampagne laden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid])

  // Schließen verwirft späte Antworten
  const schliessen = () => { anfrage.current++; onClose() }

  // ── Formular-Helfer: offene Änderungen je Entität ─────────────────────────
  const setEdit = (entityId: string, field: string, value: string) =>
    setZ(s => ({ ...s, edits: { ...s.edits, [entityId]: { ...(s.edits[entityId] ?? {}), [field]: value } } }))

  /** Aktueller Anzeigewert: offene Änderung, sonst der Wert von Meta. */
  const editVal = (entityId: string, field: string, metaValue: unknown): string => {
    const pending = z.edits[entityId]?.[field]
    if (pending != null) return pending
    return metaFeldWert(field, metaValue)
  }

  const hasEdits = (entityId: string) => Object.keys(z.edits[entityId] ?? {}).length > 0

  const applyUpdate = async (entityId: string, entityType: EntityType, patch: Record<string, unknown>, keepOpen = false) => {
    if (!cid || z.busy) return
    setZ(s => ({ ...s, busy: true }))
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: { mode: 'update_entity', entity_id: entityId, entity_type: entityType, patch },
      })
      // Edge-Fehler: invoke wirft bei non-2xx, die Klartext-Meldung steckt im Body
      if (error) throw new Error((await fnErrorDetail(error)).message)
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      if (keepOpen) {
        // Schnell-Umschalter (Pausieren/Aktivieren): Fenster bleibt offen, frisch von Meta laden
        showToast(t('crm.ads.entityUpdated', '✅ Bei Meta gespeichert'))
        await laden(cid)
      } else {
        // Svens Regel (15.8.): nach Speichern schließt sich das Fenster sofort,
        // der Hinweis liegt auf der Seite, Nacharbeiten laufen danach im Hintergrund.
        schliessen()
        showToast(t('crm.ads.entityUpdated', '✅ Bei Meta gespeichert'))
      }
      onGeaendert()
    } catch (err) {
      console.error('[AdsManager] applyUpdate:', err)
      setZ(s => ({ ...s, busy: false }))
      showToast(`❌ ${metaError(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /** Schnell-Aktion: Status sofort umschalten (ohne Formular, Fenster bleibt offen). */
  const toggleStatus = (entityId: string, entityType: EntityType, current: unknown) =>
    applyUpdate(entityId, entityType, { status: String(current) === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }, true)

  /** Speichert alle offenen Feld-Änderungen einer Entität bei Meta. */
  const saveEntity = (entityId: string, entityType: EntityType) => {
    const res = baueMetaPatch(z.edits[entityId] ?? {})
    if ('fehler' in res) { showToast(`❌ ${t('crm.ads.invalidAmount', 'Betrag ungültig')}`); return }
    if (!Object.keys(res.patch).length) return
    void applyUpdate(entityId, entityType, res.patch)
  }

  /** Speichert die bearbeitete Zielgruppe einer Anzeigengruppe. */
  const saveTargeting = async (adsetId: string) => {
    const targeting = z.targetingEdits[adsetId]
    if (!targeting || !cid || z.busy) return
    setZ(s => ({ ...s, busy: true }))
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: { mode: 'targeting_apply', adset_id: adsetId, targeting },
      })
      if (error) throw new Error((await fnErrorDetail(error)).message)
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      // Svens Regel (15.8.): nach Speichern schließt sich das Fenster sofort
      schliessen()
      showToast(t('crm.ads.targetingSaved', '✅ Zielgruppe bei Meta gespeichert'))
    } catch (err) {
      console.error('[AdsManager] saveTargeting:', err)
      setZ(s => ({ ...s, busy: false }))
      showToast(`❌ ${metaError(err instanceof Error ? err.message : String(err))}`)
    }
  }

  // Dollar-Feld mit EUR-Hinweis darunter
  const dollarInput = (entityId: string, field: string, metaValue: unknown) => {
    const v = editVal(entityId, field, metaValue)
    return (
      <>
        <input value={v} inputMode="decimal" disabled={z.busy}
          onChange={e => setEdit(entityId, field, e.target.value)} className={INPUT_CLS} />
        <UsdEurHinweis usd={v} kurs={kurs} />
      </>
    )
  }

  return (
    <Modal open={!!kampagne} onClose={schliessen} size="xl" title={kampagne ? `⚙ ${kampagne.name}` : undefined}>
      {z.loading || !z.data || !cid || z.fuer !== cid ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <div className="space-y-4 text-sm">
          {/* Kampagne */}
          {(() => {
            const c = z.data.campaign
            return (
              <div className="rounded-xl border border-gray-200 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="font-bold text-gray-800">{t('crm.ads.setCampaign', 'Kampagne')}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500">{metaLabel(c.effective_status ?? c.status)}</span>
                    <button disabled={z.busy} onClick={() => void toggleStatus(cid, 'campaign', c.status)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold border disabled:opacity-50 ${String(c.status) === 'ACTIVE' ? 'border-gray-300 text-gray-700 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}>
                      {String(c.status) === 'ACTIVE' ? `⏸ ${t('crm.ads.actPause', 'Pausieren')}` : `▶ ${t('crm.ads.actActivate', 'Aktivieren')}`}
                    </button>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Field label={t('crm.ads.setName', 'Name')}>
                      <input value={editVal(cid, 'name', c.name)} disabled={z.busy}
                        onChange={e => setEdit(cid, 'name', e.target.value)} className={INPUT_CLS} />
                    </Field>
                  </div>
                  <Field label={`${t('crm.ads.setDailyBudget', 'Tagesbudget')} ($)`}
                    hint={t('crm.ads.setBudgetHint', 'Nur wenn das Budget auf Kampagnen-Ebene liegt')}>
                    {dollarInput(cid, 'daily_budget', c.daily_budget)}
                  </Field>
                  <Field label={`${t('crm.ads.setLifetimeBudget', 'Laufzeitbudget')} ($)`}
                    hint={t('crm.ads.setLifetimeHint', 'Braucht ein Enddatum')}>
                    {dollarInput(cid, 'lifetime_budget', c.lifetime_budget)}
                  </Field>
                  <Field label={`${t('crm.ads.setSpendCap', 'Ausgabenlimit gesamt')} ($)`}>
                    {dollarInput(cid, 'spend_cap', c.spend_cap)}
                  </Field>
                  <Field label={t('crm.ads.setBidStrategy', 'Gebotsstrategie')}>
                    <div className="mt-0.5">
                      <CustomSelect value={editVal(cid, 'bid_strategy', c.bid_strategy)} disabled={z.busy}
                        onChange={v => setEdit(cid, 'bid_strategy', v)}
                        options={BID_STRATEGY_OPTIONS.map(o => ({ value: o, label: metaLabel(o) }))} />
                    </div>
                  </Field>
                  <Field label={t('crm.ads.setStart', 'Start')}>
                    <input type="datetime-local" value={editVal(cid, 'start_time', c.start_time)} disabled={z.busy}
                      onChange={e => setEdit(cid, 'start_time', e.target.value)} className={INPUT_CLS} />
                  </Field>
                  <Field label={t('crm.ads.setStop', 'Ende')}>
                    <input type="datetime-local" value={editVal(cid, 'stop_time', c.stop_time)} disabled={z.busy}
                      onChange={e => setEdit(cid, 'stop_time', e.target.value)} className={INPUT_CLS} />
                  </Field>
                  <LockedField label={t('crm.ads.setObjective', 'Ziel')} value={metaLabel(c.objective)} />
                  <LockedField label={t('crm.ads.setBuyingType', 'Kaufart')} value={metaLabel(c.buying_type)} />
                </div>

                <div className="mt-2 flex justify-end">
                  <button disabled={z.busy || !hasEdits(cid)} onClick={() => saveEntity(cid, 'campaign')} className={BTN_KLEIN}>
                    {t('common.save', 'Speichern')}
                  </button>
                </div>
              </div>
            )
          })()}

          {/* Anzeigengruppen */}
          {z.data.adsets.map(a => {
            const aid = String(a.id)
            const targetingDraft = z.targetingEdits[aid]
            return (
              <div key={aid} className="rounded-xl border border-gray-200 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="font-bold text-gray-800 truncate">{t('crm.ads.setAdset', 'Anzeigengruppe')}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500">{metaLabel(a.effective_status ?? a.status)}</span>
                    <button disabled={z.busy} onClick={() => void toggleStatus(aid, 'adset', a.status)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold border disabled:opacity-50 ${String(a.status) === 'ACTIVE' ? 'border-gray-300 text-gray-700 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}>
                      {String(a.status) === 'ACTIVE' ? `⏸ ${t('crm.ads.actPause', 'Pausieren')}` : `▶ ${t('crm.ads.actActivate', 'Aktivieren')}`}
                    </button>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Field label={t('crm.ads.setName', 'Name')}>
                      <input value={editVal(aid, 'name', a.name)} disabled={z.busy}
                        onChange={e => setEdit(aid, 'name', e.target.value)} className={INPUT_CLS} />
                    </Field>
                  </div>
                  <Field label={`${t('crm.ads.setDailyBudget', 'Tagesbudget')} ($)`}>
                    {dollarInput(aid, 'daily_budget', a.daily_budget)}
                  </Field>
                  <Field label={`${t('crm.ads.setLifetimeBudget', 'Laufzeitbudget')} ($)`}
                    hint={t('crm.ads.setLifetimeHint', 'Braucht ein Enddatum')}>
                    {dollarInput(aid, 'lifetime_budget', a.lifetime_budget)}
                  </Field>
                  <Field label={t('crm.ads.setOptimization', 'Optimiert auf')}>
                    <div className="mt-0.5">
                      <CustomSelect value={editVal(aid, 'optimization_goal', a.optimization_goal)} disabled={z.busy}
                        onChange={v => setEdit(aid, 'optimization_goal', v)}
                        options={OPTIMIZATION_OPTIONS.map(o => ({ value: o, label: metaLabel(o) }))} />
                    </div>
                  </Field>
                  <Field label={t('crm.ads.setBidStrategy', 'Gebotsstrategie')}>
                    <div className="mt-0.5">
                      <CustomSelect value={editVal(aid, 'bid_strategy', a.bid_strategy)} disabled={z.busy}
                        onChange={v => setEdit(aid, 'bid_strategy', v)}
                        options={BID_STRATEGY_OPTIONS.map(o => ({ value: o, label: metaLabel(o) }))} />
                    </div>
                  </Field>
                  <Field label={`${t('crm.ads.setBidAmount', 'Gebot')} ($)`}
                    hint={t('crm.ads.setBidHint', 'Nur bei Gebots-/Kostenobergrenze')}>
                    {dollarInput(aid, 'bid_amount', a.bid_amount)}
                  </Field>
                  <Field label={t('crm.ads.setStart', 'Start')}>
                    <input type="datetime-local" value={editVal(aid, 'start_time', a.start_time)} disabled={z.busy}
                      onChange={e => setEdit(aid, 'start_time', e.target.value)} className={INPUT_CLS} />
                  </Field>
                  <Field label={t('crm.ads.setEnd', 'Ende')}>
                    <input type="datetime-local" value={editVal(aid, 'end_time', a.end_time)} disabled={z.busy}
                      onChange={e => setEdit(aid, 'end_time', e.target.value)} className={INPUT_CLS} />
                  </Field>
                  <LockedField label={t('crm.ads.setBilling', 'Abrechnung')} value={metaLabel(a.billing_event)} />
                </div>

                <div className="mt-2 flex justify-end">
                  <button disabled={z.busy || !hasEdits(aid)} onClick={() => saveEntity(aid, 'adset')} className={BTN_KLEIN}>
                    {t('common.save', 'Speichern')}
                  </button>
                </div>

                {/* Zielgruppe: erst ansehen, auf Klick bearbeitbar */}
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('crm.ads.setTargeting', 'Zielgruppe')}</p>
                    {targetingDraft ? (
                      <div className="flex gap-1.5">
                        <button disabled={z.busy}
                          onClick={() => setZ(s => {
                            const next = { ...s.targetingEdits }; delete next[aid]
                            return { ...s, targetingEdits: next }
                          })}
                          className="px-2 py-0.5 rounded border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                          {t('common.cancel', 'Abbrechen')}
                        </button>
                        <button disabled={z.busy} onClick={() => void saveTargeting(aid)} className={BTN_KLEIN}>
                          {t('crm.ads.saveTargeting', 'Zielgruppe speichern')}
                        </button>
                      </div>
                    ) : (
                      <button disabled={z.busy}
                        onClick={() => setZ(s => ({
                          ...s,
                          targetingEdits: { ...s.targetingEdits, [aid]: { ...(a.targeting as Record<string, unknown> ?? {}) } },
                        }))}
                        className="px-2 py-0.5 rounded border border-gray-200 text-[11px] text-gray-600 hover:border-orange-400 disabled:opacity-50">
                        ✏️ {t('common.edit', 'Bearbeiten')}
                      </button>
                    )}
                  </div>
                  {targetingDraft ? (
                    <TargetingEditor value={targetingDraft} disabled={z.busy}
                      onChange={next => setZ(s => ({ ...s, targetingEdits: { ...s.targetingEdits, [aid]: next } }))} />
                  ) : (
                    <TargetingView targeting={a.targeting as Record<string, unknown>} />
                  )}
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
                    <input value={editVal(adId, 'name', ad.name)} disabled={z.busy}
                      onChange={e => setEdit(adId, 'name', e.target.value)}
                      className="flex-1 min-w-[160px] border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-gray-50" />
                    <span className="text-gray-400">{metaLabel(ad.effective_status ?? ad.status)}</span>
                    {linkData?.link && <span className="text-gray-400 truncate max-w-[180px]" title={linkData.link}>→ {linkData.link.replace('https://', '')}</span>}
                    {hasEdits(adId) && (
                      <button disabled={z.busy} onClick={() => saveEntity(adId, 'ad')} className={BTN_KLEIN}>
                        {t('common.save', 'Speichern')}
                      </button>
                    )}
                    <button disabled={z.busy} onClick={() => void toggleStatus(adId, 'ad', ad.status)}
                      className="px-2 py-0.5 rounded border border-gray-200 text-[11px] text-gray-600 hover:border-orange-400 disabled:opacity-50">
                      {String(ad.status) === 'ACTIVE' ? '⏸' : '▶'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
          <p className="text-[11px] text-gray-400">
            {t('crm.ads.settingsHint', 'Änderungen wirken sofort direkt bei Meta. 🔒-Felder legt Meta beim Anlegen fest und lässt sie nachträglich nicht mehr ändern.')}
          </p>
        </div>
      )}
    </Modal>
  )
}
