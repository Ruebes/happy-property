import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '../../../lib/supabase'
import Spinner from '../../ui/Spinner'
import { AD_STATUS_BADGE, useWerbeFormat } from './format'
import type { WerbeZeitraum } from '../../../lib/crmTypes'

// ── YouTube- und Google-Werbung im Werbemanager ───────────────────────────────
// Daten kommen aus Google Ads über google-ads-sync (täglich 04:41 UTC und per
// „Aktualisieren") in ad_catalog / ad_insights_daily mit platform youtube|google.
// Nur Anzeige, keine Änderungen an Kampagnen.

interface Props {
  segment: 'youtube' | 'google'
  days: WerbeZeitraum
  canSync: boolean
  canConnect: boolean
  showToast: (msg: string) => void
}

interface CatRow { ad_id: string; campaign_id: string; campaign_name: string | null; adset_name: string | null; ad_name: string | null; status: string | null; effective_status: string | null; thumbnail_url: string | null }
interface InsRow { day: string; ad_id: string; campaign_id: string | null; spend_eur: number; impressions: number; link_clicks: number; thruplays: number; yt_subscribers: number; synced_at: string }
interface Agg { spend: number; impressions: number; clicks: number; views: number; subs: number }
const leer = (): Agg => ({ spend: 0, impressions: 0, clicks: 0, views: 0, subs: 0 })
const add = (a: Agg, r: InsRow) => {
  a.spend += Number(r.spend_eur) || 0
  a.impressions += Number(r.impressions) || 0
  a.clicks += Number(r.link_clicks) || 0
  a.views += Number(r.thruplays) || 0
  a.subs += Number(r.yt_subscribers) || 0
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

export default function GoogleWerbung({ segment, days, canSync, canConnect, showToast }: Props) {
  const { t } = useTranslation()
  const f = useWerbeFormat()
  const yt = segment === 'youtube'
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [conn, setConn] = useState<{ connected: boolean; customer: boolean } | null>(null)
  const [catalog, setCatalog] = useState<CatRow[]>([])
  const [insights, setInsights] = useState<InsRow[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      // Micro-Instanz: nacheinander statt parallel
      const st = await supabase.functions.invoke('google-ads-sync', { body: { action: 'status' } })
      const sd = (st.data ?? {}) as { ok?: boolean; connected?: boolean; customer?: boolean }
      setConn(sd.ok ? { connected: !!sd.connected, customer: !!sd.customer } : null)
      const cat = await supabase.from('ad_catalog')
        .select('ad_id, campaign_id, campaign_name, adset_name, ad_name, status, effective_status, thumbnail_url')
        .eq('platform', segment)
      if (cat.error) throw cat.error
      const ins = await supabase.from('ad_insights_daily')
        .select('day, ad_id, campaign_id, spend_eur, impressions, link_clicks, thruplays, yt_subscribers, synced_at')
        .eq('platform', segment).gte('day', since)
      if (ins.error) throw ins.error
      setCatalog((cat.data as CatRow[]) ?? [])
      setInsights((ins.data as InsRow[]) ?? [])
    } catch (e) {
      console.error('[GoogleWerbung] load:', e)
      showToast(`❌ ${e instanceof Error ? e.message : t('crm.gads.loadError', 'Daten konnten nicht geladen werden')}`)
    } finally { setLoading(false) }
  }, [segment, days, showToast, t])
  useEffect(() => { void load() }, [load])

  const sync = async () => {
    setSyncing(true)
    try {
      const { data, error } = await supabase.functions.invoke('google-ads-sync', { body: { days: Math.max(days, 7) } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; ads?: number; warnings?: string[] }
      if (error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      showToast(`✅ ${t('crm.gads.synced', 'Google Ads aktualisiert ({{n}} Anzeigen)', { n: d.ads ?? 0 })}`)
      if (d.warnings?.length) console.warn('[GoogleWerbung] Hinweise:', d.warnings)
      await load()
    } catch (e) {
      showToast(`❌ ${e instanceof Error ? e.message : 'Fehler'}`)
    } finally { setSyncing(false) }
  }

  const { total, kampagnen, anzeigen, stand } = useMemo(() => {
    const total = leer()
    const proKampagne = new Map<string, Agg>()
    const proAnzeige = new Map<string, Agg>()
    let stand = ''
    for (const r of insights) {
      add(total, r)
      const cid = r.campaign_id ?? catalog.find(c => c.ad_id === r.ad_id)?.campaign_id ?? ''
      if (!proKampagne.has(cid)) proKampagne.set(cid, leer())
      add(proKampagne.get(cid)!, r)
      if (!proAnzeige.has(r.ad_id)) proAnzeige.set(r.ad_id, leer())
      add(proAnzeige.get(r.ad_id)!, r)
      if (r.synced_at > stand) stand = r.synced_at
    }
    const namen = new Map<string, { name: string; aktiv: boolean }>()
    for (const c of catalog) {
      const n = namen.get(c.campaign_id)
      const aktiv = (c.effective_status ?? c.status) === 'ACTIVE'
      namen.set(c.campaign_id, { name: c.campaign_name ?? c.campaign_id, aktiv: (n?.aktiv ?? false) || aktiv })
    }
    const ids = new Set([...proKampagne.keys(), ...namen.keys()])
    const kampagnen = [...ids].filter(Boolean).map(id => ({ id, name: namen.get(id)?.name ?? id, aktiv: namen.get(id)?.aktiv ?? false, agg: proKampagne.get(id) ?? leer() }))
      .sort((a, b) => b.agg.spend - a.agg.spend || Number(b.aktiv) - Number(a.aktiv))
    const anzeigen = catalog.map(c => ({ ...c, agg: proAnzeige.get(c.ad_id) ?? leer() }))
      .sort((a, b) => b.agg.spend - a.agg.spend)
    return { total, kampagnen, anzeigen, stand }
  }, [catalog, insights])

  if (loading) return <div className="flex justify-center py-24"><Spinner size="lg" /></div>

  const label = yt ? 'YouTube' : 'Google Ads'
  const nichtVerbunden = conn && (!conn.connected || !conn.customer)

  return (
    <div className="space-y-5">
      {nichtVerbunden && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-gray-700">
          <p className="font-semibold text-gray-900">{t('crm.gads.notConnected', 'Google Ads ist noch nicht verbunden')}</p>
          <p className="mt-1">
            {conn!.connected
              ? t('crm.gads.noCustomer', 'Das Google-Konto ist verbunden, es fehlt nur noch die Kunden-ID des Werbekontos.')
              : t('crm.gads.howTo', 'YouTube-Werbung läuft über Google Ads. Unter Einstellungen → Connectoren bei „Google Ads" auf „Verbinden" klicken und mit dem Google-Konto zustimmen, das in Google Ads Administrator ist.')}
          </p>
          {canConnect && (
            <Link to="/admin/crm/settings/connectors" className="inline-block mt-3 px-3 py-1.5 rounded-lg text-xs font-semibold border border-amber-300 bg-white hover:bg-amber-100">
              🔗 {t('crm.gads.toConnectors', 'Zu den Connectoren')}
            </Link>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-gray-500">
          {stand
            ? t('crm.gads.stand', 'Stand: {{d}} · täglich automatisch', { d: new Date(stand).toLocaleString(f.locale, { dateStyle: 'short', timeStyle: 'short' }) })
            : t('crm.gads.noData', 'Noch keine Zahlen aus Google Ads für {{label}}.', { label })}
        </p>
        {canSync && conn?.connected && conn.customer && (
          <button type="button" onClick={() => void sync()} disabled={syncing} className="ml-auto hp-btn hp-btn-primary px-3 py-1.5 font-semibold">
            {syncing && <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            🔄 {t('crm.ads.syncNow', 'Aktualisieren')}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile label={t('crm.gads.kpiSpend', 'Ausgaben')} value={f.eur(total.spend)} sub={t('crm.ads.days', '{{n}} Tage', { n: days })} />
        {yt ? (
          <>
            <KpiTile label={t('crm.gads.kpiSubs', 'Neue Abos')} value={f.int(total.subs)} sub={t('crm.gads.kpiSubsSub', 'laut Google Ads')} />
            <KpiTile label={t('crm.gads.kpiPerSub', 'Kosten je Abo')} value={f.per(total.spend, total.subs)} sub={t('crm.gads.kpiPerSubSub', 'Ziel bis 1,50 €')} />
            <KpiTile label={t('crm.gads.kpiViews', 'Aufrufe')} value={f.int(total.views)} sub={t('crm.gads.kpiPerView', '{{v}} je Aufruf', { v: f.per(total.spend, total.views) })} />
          </>
        ) : (
          <>
            <KpiTile label={t('crm.gads.kpiImpr', 'Impressionen')} value={f.int(total.impressions)} />
            <KpiTile label={t('crm.gads.kpiClicks', 'Klicks')} value={f.int(total.clicks)} sub={total.impressions ? f.pct(total.clicks / total.impressions) : undefined} />
            <KpiTile label={t('crm.gads.kpiPerClick', 'Kosten je Klick')} value={f.per(total.spend, total.clicks)} />
          </>
        )}
      </div>

      {kampagnen.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left px-4 py-2.5">{t('crm.gads.colCampaign', 'Kampagne')}</th>
                <th className="text-right px-4 py-2.5">{t('crm.gads.kpiSpend', 'Ausgaben')}</th>
                <th className="text-right px-4 py-2.5">{t('crm.gads.kpiImpr', 'Impressionen')}</th>
                <th className="text-right px-4 py-2.5">{yt ? t('crm.gads.kpiViews', 'Aufrufe') : t('crm.gads.kpiClicks', 'Klicks')}</th>
                {yt && <th className="text-right px-4 py-2.5">{t('crm.gads.kpiSubs', 'Neue Abos')}</th>}
                <th className="text-right px-4 py-2.5">{yt ? t('crm.gads.kpiPerSub', 'Kosten je Abo') : t('crm.gads.kpiPerClick', 'Kosten je Klick')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {kampagnen.map(k => (
                <tr key={k.id}>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${k.aktiv ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className="font-medium text-gray-900">{k.name}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{f.eur(k.agg.spend)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{f.int(k.agg.impressions)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{f.int(yt ? k.agg.views : k.agg.clicks)}</td>
                  {yt && <td className="px-4 py-2.5 text-right tabular-nums">{f.int(k.agg.subs)}</td>}
                  <td className="px-4 py-2.5 text-right tabular-nums">{f.per(k.agg.spend, yt ? k.agg.subs : k.agg.clicks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {anzeigen.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('crm.gads.ads', 'Anzeigen')}</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {anzeigen.map(a => {
              const b = AD_STATUS_BADGE(a.effective_status ?? a.status)
              return (
                <div key={a.ad_id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                  {a.thumbnail_url && <img src={a.thumbnail_url} alt="" loading="lazy" className="w-full aspect-video object-cover bg-gray-100" />}
                  <div className="p-3">
                    <div className="flex items-start gap-2">
                      <p className="text-sm font-medium text-gray-900 flex-1 min-w-0 truncate">{a.ad_name ?? a.adset_name ?? a.ad_id}</p>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${b.cls}`}>{b.k ? t(b.k, b.d) : b.d}</span>
                    </div>
                    <p className="text-xs text-gray-500 truncate">{a.campaign_name}</p>
                    <p className="text-xs text-gray-600 mt-1.5 tabular-nums">
                      {f.eur(a.agg.spend)} · {yt
                        ? t('crm.gads.adLineYt', '{{v}} Aufrufe · {{s}} Abos', { v: f.int(a.agg.views), s: f.int(a.agg.subs) })
                        : t('crm.gads.adLineG', '{{c}} Klicks', { c: f.int(a.agg.clicks) })}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
