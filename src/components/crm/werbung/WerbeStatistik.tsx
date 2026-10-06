import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { AdAction, AdCatalogRow } from '../../../lib/crmTypes'
import { useWerbeKontext } from './useWerbeDaten'
import { AKTION_SICHTBAR, CHART_COLORS, aktionErledigt, aktionIcon, colorFor, useWerbeFormat } from './format'
import { berechneEmpfehlungen, lpVerlustKandidaten } from './empfehlungen'
import { useEigeneAnkuenfte } from './eigeneAnkuenfte'
import { BTN_KLEIN } from './felder'
import { dbFehlerText } from './autopilot/werbeTexte'
import KampagnenZentrale from './zentrale/KampagnenZentrale'

// ── Reiter „Statistik" des Werbemanagers ──────────────────────────────────────
// KPI-Kacheln, Budget-Wächter, Leitplanken, Empfehlungen + Aktions-Warteschlange
// und Diagramme (unverändert aus AdsManager.tsx), darunter die
// Kampagnen-Zentrale (zentrale/KampagnenZentrale.tsx) statt der alten Tabelle
// Kampagnen -> Anzeigen. Anzeigen schaltet sie über dieselbe Warteschlange
// (ad_actions), Kampagnen/Anzeigengruppen über meta-builder bulk.

// ── KPI-Kachel ────────────────────────────────────────────────────────────────
function KpiTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-5 py-4 ${accent ? 'border-orange-200 bg-orange-50/60' : 'border-gray-200 bg-white'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Horizontales Balkendiagramm (Leads je Kampagne) ──────────────────────────
interface BarDatum { label: string; value: number; sub?: string; color: string }
function HBarChart({ data, valueFmt }: { data: BarDatum[]; valueFmt: (v: number) => string }) {
  const max = Math.max(1, ...data.map(d => d.value))
  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={i} title={`${d.label}: ${valueFmt(d.value)}${d.sub ? ` · ${d.sub}` : ''}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-gray-600 truncate">{d.label}</span>
            <span className="text-sm font-semibold text-gray-900 tabular-nums whitespace-nowrap">
              {valueFmt(d.value)}{d.sub && <span className="font-normal text-gray-500"> · {d.sub}</span>}
            </span>
          </div>
          <div className="mt-1 h-5 rounded-r bg-gray-100">
            <div className="h-full rounded-r" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color, minWidth: d.value > 0 ? 5 : 0 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Kuchendiagramm (Spend-Verteilung) ────────────────────────────────────────
function DonutChart({ data, centerLabel }: { data: BarDatum[]; centerLabel: string }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total <= 0) return null
  let acc = 0
  const R = 42, C = 2 * Math.PI * R
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 110 110" className="w-44 h-44 shrink-0">
        {data.map((d, i) => {
          const frac = d.value / total
          const dash = frac * C
          const off = -acc * C
          acc += frac
          return (
            <circle key={i} cx="55" cy="55" r={R} fill="none" stroke={d.color} strokeWidth="14"
              strokeDasharray={`${Math.max(dash - 2, 0)} ${C - Math.max(dash - 2, 0)}`} strokeDashoffset={off}
              transform="rotate(-90 55 55)">
              <title>{`${d.label}: ${Math.round(frac * 100)} %`}</title>
            </circle>
          )
        })}
        <text x="55" y="59" textAnchor="middle" className="fill-gray-700 text-[11px] font-bold">{centerLabel}</text>
      </svg>
      <div className="space-y-1.5 min-w-0">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-sm text-gray-600 min-w-0">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
            <span className="truncate">{d.label}</span>
            <span className="ml-auto font-semibold text-gray-900 tabular-nums pl-2">{Math.round((d.value / total) * 100)} %</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tages-Trend (vertikale Balken, eine Farbe = eine Größe) ──────────────────
function TrendChart({ points, fmt }: { points: { day: string; value: number }[]; fmt: (v: number) => string }) {
  const max = Math.max(1, ...points.map(p => p.value))
  return (
    <div className="flex items-end gap-[3px] h-48">
      {points.map((p, i) => (
        <div key={i} className="flex-1 min-w-0 group relative" title={`${p.day}: ${fmt(p.value)}`}>
          <div className="rounded-t-sm mx-auto w-full transition group-hover:opacity-80"
            style={{ height: `${Math.max((p.value / max) * 192, p.value > 0 ? 2 : 0)}px`, backgroundColor: CHART_COLORS[0] }} />
        </div>
      ))}
    </div>
  )
}

// Standard-Export ohne Props (lazyWithReload): Daten kommen aus dem WerbeKontext
export default function WerbeStatistik() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const istAdmin = profile?.role === 'admin'
  const fmt = useWerbeFormat()
  const { eur, int, pct, per, locale } = fmt
  const {
    segment, catalog, insights, actions, setActions, settings, setSettings, crmVisible,
    byAd, campaignsSorted, total, trend, campaignName, fetchAll, showToast,
  } = useWerbeKontext()

  const [editSettings, setEditSettings] = useState(false)
  const [settingsForm, setSettingsForm] = useState({ target_cpl: '60', max_budget: '180' })

  // Formular folgt den geladenen Leitplanken (bisher in fetchAll gesetzt)
  useEffect(() => {
    setSettingsForm({ target_cpl: String(settings.target_cpl), max_budget: String(settings.max_account_daily_budget) })
  }, [settings])

  // ── Leitplanken speichern ─────────────────────────────────────────────────
  const saveSettings = async () => {
    const target = parseFloat(settingsForm.target_cpl.replace(',', '.'))
    const maxB = parseFloat(settingsForm.max_budget.replace(',', '.'))
    if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(maxB) || maxB <= 0) {
      showToast(`❌ ${t('crm.ads.settingsInvalid', 'Bitte gültige Beträge eingeben')}`)
      return
    }
    // Erhöhen des Tageslimits darf nur ein Admin (Schutz-Trigger werbe_settings_guard, 42501)
    if (!istAdmin && maxB > settings.max_account_daily_budget + 0.001) {
      showToast(`❌ ${t('crm.ads.limitNurAdmin', 'Das Tageslimit erhöhen darf nur ein Admin. Senken geht.')}`)
      return
    }
    try {
      const { error } = await supabase.from('ad_settings')
        .update({ target_cpl: target, max_account_daily_budget: maxB, updated_at: new Date().toISOString() })
        .eq('id', 'default')
      if (error) throw error
      setSettings(s => ({ ...s, target_cpl: target, max_account_daily_budget: maxB }))
      setEditSettings(false)
      showToast(t('crm.ads.settingsSaved', '✅ Leitplanken gespeichert'))
    } catch (err) {
      console.error('[AdsManager] saveSettings:', err)
      showToast(`❌ ${dbFehlerText(t, err)}`)
    }
  }

  // ── Aktions-Queue: vormerken / stornieren ─────────────────────────────────
  // Ausführung bei Meta übernimmt meta-ads-sync: nach dem Vormerken stoßen
  // wir sie sofort an (fire-and-forget) und laden den Status kurz darauf nach.
  const pendingByAd = useMemo(() => {
    const m = new Map<string, AdAction>()
    for (const a of actions) if (a.status === 'bestätigt' && a.ad_id) m.set(a.ad_id, a)
    return m
  }, [actions])

  const queueAction = async (ad: AdCatalogRow, action: 'pause' | 'activate', reason: string) => {
    if (pendingByAd.has(ad.ad_id)) return
    try {
      const { data, error } = await supabase.from('ad_actions').insert({
        platform: segment, ad_id: ad.ad_id, ad_name: ad.ad_name,
        campaign_name: ad.campaign_name, action, reason,
        created_by: profile?.id ?? null,
      }).select('id, ad_id, ad_name, campaign_name, action, reason, status, created_at, executed_at, result').single()
      if (error) throw error
      setActions(prev => [data as unknown as AdAction, ...prev])
      showToast(action === 'pause'
        ? t('crm.ads.toastPauseQueued', '⏸ Wird bei Meta pausiert …')
        : t('crm.ads.toastActivateQueued', '▶ Wird bei Meta aktiviert …'))
      // Sofort ausführen und Status nachladen (fire-and-forget, UI blockiert nicht)
      supabase.functions.invoke('meta-ads-sync', { body: { mode: 'actions_only' } })
        .then(() => fetchAll())
        .catch(e => console.warn('[AdsManager] Sofort-Ausführung failed:', e))
    } catch (err) {
      console.error('[AdsManager] queueAction:', err)
      showToast(`❌ ${t('crm.ads.toastError', 'Fehler beim Speichern')}`)
    }
  }

  const cancelAction = async (id: string) => {
    const prev = actions
    setActions(actions.map(a => (a.id === id ? { ...a, status: 'abgelehnt' } : a)))
    try {
      const { error } = await supabase.from('ad_actions').update({ status: 'abgelehnt' }).eq('id', id).eq('status', 'bestätigt')
      if (error) throw error
      showToast(t('crm.ads.toastCancelled', 'Aktion storniert'))
    } catch (err) {
      console.error('[AdsManager] cancelAction:', err)
      setActions(prev)
    }
  }

  // ── Empfehlungen (Regel-Engine über den geladenen Zeitraum) ───────────────
  // Zielseiten-Hinweis erst nach der Gegenprobe mit den eigenen Besucherzahlen
  const lpKandidaten = useMemo(() => lpVerlustKandidaten(catalog, byAd), [catalog, byAd])
  const eigeneAnkuenfte = useEigeneAnkuenfte(lpKandidaten, insights, profile ? istAdmin : null)
  const recommendations = useMemo(
    () => berechneEmpfehlungen({ catalog, byAd, vorgemerkt: pendingByAd, targetCpl: settings.target_cpl, crmVisible, eigeneAnkuenfte, t, fmt }),
    [catalog, byAd, pendingByAd, settings, t, fmt, crmVisible, eigeneAnkuenfte],
  )

  const campaignColor = useMemo(() => {
    const m = new Map<string, string>()
    campaignsSorted.forEach(([cid], i) => m.set(cid, colorFor(i)))
    return m
  }, [campaignsSorted])

  // Gestern-Ausgaben vs. Tageslimit (Budget-Wächter)
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const yesterdaySpend = useMemo(
    () => insights.filter(r => r.day === yesterdayIso).reduce((s, r) => s + r.spend_eur, 0),
    [insights, yesterdayIso],
  )
  const overBudget = yesterdaySpend > settings.max_account_daily_budget

  const leadsShown = total.crmLeads > 0 ? total.crmLeads : total.platformLeads
  const leadBasis = total.crmLeads > 0 ? t('crm.ads.basisCrm', 'CRM-zugeordnet') : t('crm.ads.basisMeta', 'laut Meta')
  const qualityRated = total.gut + total.schlecht
  const roas = total.spendEur > 0 ? total.revenue / total.spendEur : 0

  // Aktionsliste: nur Zeilen mit bekanntem Status (Autopilot-Vorschläge mit
  // status null erscheinen im Autopilot-Reiter, nicht hier)
  const pendingActions = actions.filter(a => a.status === 'bestätigt')
  const doneActions = actions.filter(a => a.status === 'ausgeführt' || a.status === 'fehlgeschlagen').slice(0, 5)
  const hasActionRows = actions.some(a => a.status != null && AKTION_SICHTBAR.has(a.status))

  return (
    <div>
      {/* KPI-Kacheln */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <KpiTile label={t('crm.ads.kpiSpend', 'Ausgaben')} value={eur(total.spendEur)}
          sub={t('crm.ads.kpiSpendSub', 'umgerechnet aus USD')} />
        <KpiTile label={t('crm.ads.kpiCpl', 'Leadpreis')} value={per(total.spendEur, leadsShown)}
          sub={`${int(leadsShown)} Leads (${leadBasis}) · ${leadsShown > 0 && total.spendEur / leadsShown <= settings.target_cpl ? '✅' : '⚠️'} ${t('crm.ads.target', 'Ziel')}: ${eur(settings.target_cpl)}`} accent />
        <KpiTile label={t('crm.ads.kpiCostPerHeld', 'Preis / stattgef. Termin')} value={per(total.spendEur, total.stattgefunden)}
          sub={`${int(total.stattgefunden)} ${t('crm.ads.held', 'stattgefunden')} · ${int(total.noShows)} No-Shows`} />
        <KpiTile label={t('crm.ads.kpiQuality', 'Qualitätsquote')} value={qualityRated > 0 ? pct(total.gut / qualityRated) : '-'}
          sub={`${int(total.gut)} 👍 / ${int(total.schlecht)} 👎`} />
        <KpiTile label={t('crm.ads.kpiCostPerGood', 'Preis / gutem Lead')} value={per(total.spendEur, total.gut)} />
        <KpiTile label={t('crm.ads.kpiRoas', 'ROAS')} value={total.revenue > 0 ? `${roas.toLocaleString(locale, { maximumFractionDigits: 2 })}×` : '-'}
          sub={`${eur(total.revenue)} ${t('crm.ads.revenue', 'Umsatz')} · ${int(total.sales)} Sales`} />
      </div>

      {/* Budget-Wächter: gestern über dem Tageslimit? */}
      {overBudget && (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          🚨 {t('crm.ads.overBudget', 'Gestern {{spend}} ausgegeben - über deinem Tageslimit von {{limit}}.', { spend: eur(yesterdaySpend), limit: eur(settings.max_account_daily_budget) })}
        </div>
      )}

      {/* Leitplanken (Ziel-Leadpreis + Tageslimit), editierbar */}
      <div className="mb-5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="font-semibold text-gray-700">🎯 {t('crm.ads.settingsTitle', 'Leitplanken')}:</span>
        {editSettings ? (
          <>
            <label className="flex items-center gap-1.5 text-gray-600">
              {t('crm.ads.target', 'Ziel')}-{t('crm.ads.kpiCpl', 'Leadpreis')}
              <input value={settingsForm.target_cpl} onChange={e => setSettingsForm(f => ({ ...f, target_cpl: e.target.value }))}
                className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-right" inputMode="decimal" /> €
            </label>
            <label className="flex items-center gap-1.5 text-gray-600">
              {t('crm.ads.dailyLimit', 'Tageslimit')}
              <input value={settingsForm.max_budget} onChange={e => setSettingsForm(f => ({ ...f, max_budget: e.target.value }))}
                className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-right" inputMode="decimal" /> €
              {!istAdmin && <span className="text-[11px] text-gray-400">{t('crm.ads.limitNurSenken', 'nur senken (erhöhen darf nur ein Admin)')}</span>}
            </label>
            <button onClick={() => void saveSettings()} className={BTN_KLEIN}>
              {t('common.save', 'Speichern')}
            </button>
            <button onClick={() => setEditSettings(false)} className="text-xs text-gray-500 underline">{t('common.cancel', 'Abbrechen')}</button>
          </>
        ) : (
          <>
            <span className="text-gray-600">{t('crm.ads.target', 'Ziel')}-{t('crm.ads.kpiCpl', 'Leadpreis')}: <b>{eur(settings.target_cpl)}</b></span>
            <span className="text-gray-600">{t('crm.ads.dailyLimit', 'Tageslimit')}: <b>{eur(settings.max_account_daily_budget)}</b> · {t('crm.ads.yesterday', 'gestern')}: <b className={overBudget ? 'text-red-600' : 'text-green-700'}>{eur(yesterdaySpend)}</b></span>
            <span className="text-gray-500">{t('crm.ads.sysCampaign', 'System-Kampagne')}: <b>{eur(settings.system_campaign_daily_budget)}/Tag</b></span>
            <button onClick={() => setEditSettings(true)} className="ml-auto text-xs text-gray-500 underline hover:text-gray-800">
              ✏️ {t('common.edit', 'Bearbeiten')}
            </button>
          </>
        )}
      </div>

      {/* Hinweis solange die CRM-Zuordnung noch nicht greift */}
      {!crmVisible && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('crm.ads.noCrmAccess', 'CRM-Zahlen (Leads, Termine, Qualität, Sales) siehst du nur mit dem Pipeline-Recht. Die Lead-Zahl hier ist die von Meta.')}
        </div>
      )}
      {crmVisible && total.crmLeads === 0 && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('crm.ads.noAttribution', 'Noch keine CRM-Zuordnung: Sobald die Anzeigen die URL-Parameter tragen (Aufgabe liegt bei Giona), laufen Leads, Termine, Qualität und Sales hier automatisch pro Anzeige ein. Bis dahin zählt die Lead-Zahl von Meta.')}
        </div>
      )}

      {/* Empfehlungen + Aktions-Warteschlange */}
      {(recommendations.length > 0 || hasActionRows) && (
        <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-bold text-gray-700 mb-1">💡 {t('crm.ads.recTitle', 'Empfehlungen & Aktionen')}</h2>
          <p className="text-[11px] text-gray-400 mb-3">{t('crm.ads.recSub', 'Ein Klick genügt - die Aktion wird sofort direkt bei Meta ausgeführt.')}</p>
          {recommendations.length > 0 && (
            <div className="space-y-2 mb-3">
              {recommendations.map(r => (
                <div key={`${r.kind}-${r.ad.ad_id}`}
                  className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${r.advice ? 'border-sky-200 bg-sky-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
                  <span className="text-sm font-semibold text-gray-800 truncate max-w-[240px]" title={r.ad.ad_name ?? r.ad.ad_id}>{r.ad.ad_name ?? r.ad.ad_id}</span>
                  <span className="text-[11px] text-gray-500 truncate">{r.ad.campaign_name}</span>
                  <span className={`text-xs basis-full md:basis-auto md:flex-1 ${r.advice ? 'text-sky-900' : 'text-amber-800'}`}>{r.reason}</span>
                  {r.advice
                    // Hinweis: Pausieren würde das eigentliche Problem nicht lösen.
                    ? <span className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold text-sky-800 bg-sky-100 shrink-0">🔎 {r.advice}</span>
                    : <button onClick={() => void queueAction(r.ad, 'pause', r.reason)}
                        className={`ml-auto shrink-0 ${BTN_KLEIN}`}>
                        ⏸ {t('crm.ads.recPauseCta', 'Pausieren vormerken')}
                      </button>}
                </div>
              ))}
            </div>
          )}
          {pendingActions.map(a => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 mb-2">
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                {aktionIcon(a.action)} {t('crm.ads.actQueued', 'vorgemerkt')}
              </span>
              <span className="text-sm text-gray-800 truncate max-w-[260px]" title={a.ad_name ?? a.ad_id ?? undefined}>{a.ad_name ?? a.ad_id}</span>
              {a.reason && <span className="text-[11px] text-gray-400 truncate flex-1">{a.reason}</span>}
              <button onClick={() => void cancelAction(a.id)} className="ml-auto text-xs text-gray-500 hover:text-red-600 underline shrink-0">
                {t('crm.ads.actCancel', 'Stornieren')}
              </button>
            </div>
          ))}
          {doneActions.map(a => {
            const lbl = aktionErledigt(a.action)
            return (
              <div key={a.id} className="flex items-center gap-2 px-3 py-1 text-[11px] text-gray-400">
                <span>{a.status === 'ausgeführt' ? '✅' : '❌'}</span>
                <span className="truncate">{lbl.k ? t(lbl.k, lbl.d) : lbl.d}: {a.ad_name ?? a.ad_id}</span>
                {a.executed_at && <span>{new Date(a.executed_at).toLocaleDateString(locale)}</span>}
                {a.result && a.status === 'fehlgeschlagen' && <span className="truncate text-red-400">{a.result}</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* Diagramme: bewusst groß (Svens Wunsch: Statistik-Reiter mit großen Grafiken) */}
      <div className="grid lg:grid-cols-2 2xl:grid-cols-3 gap-5 mb-6">
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-700 mb-4">{t('crm.ads.chartLeads', 'Leads je Kampagne')}</h2>
          <HBarChart valueFmt={int}
            data={campaignsSorted.slice(0, 6).map(([cid, a]) => ({
              label: campaignName(cid),
              value: a.crmLeads > 0 ? a.crmLeads : a.platformLeads,
              sub: a.platformLeads > 0 || a.crmLeads > 0 ? `CPL ${per(a.spendEur, a.crmLeads > 0 ? a.crmLeads : a.platformLeads)}` : undefined,
              color: campaignColor.get(cid) ?? CHART_COLORS[0],
            }))} />
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-700 mb-4">{t('crm.ads.chartSpend', 'Budget-Verteilung')}</h2>
          <DonutChart centerLabel={eur(total.spendEur)}
            data={campaignsSorted.slice(0, 6).map(([cid, a]) => ({
              label: campaignName(cid), value: a.spendEur, color: campaignColor.get(cid) ?? CHART_COLORS[0],
            }))} />
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5 lg:col-span-2 2xl:col-span-1">
          <h2 className="text-base font-bold text-gray-700 mb-4">{t('crm.ads.chartTrend', 'Ausgaben pro Tag')}</h2>
          <TrendChart points={trend.map(p => ({ day: new Date(p.day).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }), value: p.value }))} fmt={eur} />
          <div className="flex justify-between text-[10px] text-gray-400 mt-1">
            <span>{trend[0] ? new Date(trend[0].day).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) : ''}</span>
            <span>{trend.length ? new Date(trend[trend.length - 1].day).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) : ''}</span>
          </div>
        </div>
      </div>

      {/* Kampagnen-Zentrale: Kampagne > Anzeigengruppe > Werbeanzeige (zentrale/) */}
      <KampagnenZentrale pendingByAd={pendingByAd} />

      <p className="mt-3 text-[11px] text-gray-400">
        {t('crm.ads.footnote', 'Datenstand: automatischer Sync jeden Morgen direkt aus dem Meta-Werbekonto (Sveru Marketing LLC, USD -> EUR umgerechnet) - oder sofort über „Aktualisieren". * = Lead-Zahl laut Meta, solange die CRM-Zuordnung über die Anzeigen-URL-Parameter noch nicht aktiv ist.')}
        {' '}<Link to="/admin/crm/leads" className="underline">{t('crm.ads.toLeads', 'Zu den Leads')}</Link>
      </p>
    </div>
  )
}
