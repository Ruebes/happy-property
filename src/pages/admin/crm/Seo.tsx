// SEO & KI-Sichtbarkeit: Wie entwickelt sich die Hauptseite fuer Google UND
// fuer die KI-Suchen (ChatGPT, Claude, Perplexity)?
// Datenquellen: seo_bot_hits (Crawler-Besuche, gemeldet vom WP-Snippet),
// seo_snapshots (taeglicher Seiten-Check + Search Console), seo_reports
// (woechentliche KI-Auswertung). Edge Function: seo-insights.
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'

// ── Typen ────────────────────────────────────────────────────────────────────
interface HitRow { bot: string; engine: string; kind: string; path: string; ts: string }
interface EngineAgg { engine: string; crawl: number; assist: number; pages: number }
interface SnapshotRow {
  day: string
  metrics: {
    pages: number; titles_over_60: number; desc_missing: number; faq_pages: number
    faq_pairs: number; internal_links: number; alt_missing: number; old_tax_rate: number
    ttfb_avg_ms: number; llms_txt: boolean; robots_ai_ok: boolean; errors: number
  }
  gsc: {
    status: string; clicks?: number; impressions?: number; position?: number
    top_queries?: { query: string; clicks: number; impressions: number; position: number }[]
  } | null
}
interface ReportRow { id: string; token: string; week_start: string; week_end: string; created_at: string }

type Period = 7 | 30

const ENGINE_LABELS: Record<string, string> = {
  google: 'Google', bing: 'Bing (→ Copilot)', openai: 'OpenAI / ChatGPT',
  anthropic: 'Anthropic / Claude', perplexity: 'Perplexity', apple: 'Apple',
  meta: 'Meta', other: 'Sonstige',
}
const AI_ENGINES = ['openai', 'anthropic', 'perplexity']

function aggregate(rows: HitRow[]): EngineAgg[] {
  const m = new Map<string, EngineAgg & { pathSet: Set<string> }>()
  for (const r of rows) {
    const e = m.get(r.engine) ?? { engine: r.engine, crawl: 0, assist: 0, pages: 0, pathSet: new Set<string>() }
    if (r.kind === 'assist') e.assist++
    else e.crawl++
    e.pathSet.add(r.path)
    m.set(r.engine, e)
  }
  return [...m.values()]
    .map(e => ({ engine: e.engine, crawl: e.crawl, assist: e.assist, pages: e.pathSet.size }))
    .sort((a, b) => (b.crawl + b.assist) - (a.crawl + a.assist))
}

// ── Kachel ───────────────────────────────────────────────────────────────────
interface TileProps { label: string; value: string; hint?: string; accent?: boolean }
function Tile({ label, value, hint, accent }: TileProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">{label}</div>
      <div className="text-3xl font-bold tabular-nums" style={accent ? { color: '#ff795d' } : undefined}>{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

// ── Report-Ansicht (Modal) ───────────────────────────────────────────────────
interface ReportModalProps { html: string; onClose: () => void }
function ReportModal({ html, onClose }: ReportModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex justify-end p-2 border-b border-gray-100">
          <button onClick={onClose} className="px-3 py-1 text-sm text-gray-500 hover:text-gray-800">✕</button>
        </div>
        <iframe title="SEO-Report" srcDoc={html} className="flex-1 w-full border-0" sandbox="" />
      </div>
    </div>
  )
}

// ── Seite ────────────────────────────────────────────────────────────────────
export default function Seo() {
  const { t } = useTranslation()
  const basePath = '/admin/crm'

  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>(7)
  const [hits, setHits] = useState<HitRow[]>([])
  const [prevHits, setPrevHits] = useState<HitRow[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([])
  const [reports, setReports] = useState<ReportRow[]>([])
  const [reportHtml, setReportHtml] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToastMsg = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const now = Date.now()
      const from = new Date(now - period * 86400_000).toISOString()
      const prevFrom = new Date(now - 2 * period * 86400_000).toISOString()
      const [cur, prev, snaps, reps] = await Promise.all([
        supabase.from('seo_bot_hits').select('bot, engine, kind, path, ts').gte('ts', from).limit(20000),
        supabase.from('seo_bot_hits').select('bot, engine, kind, path, ts').gte('ts', prevFrom).lt('ts', from).limit(20000),
        supabase.from('seo_snapshots').select('day, metrics, gsc').order('day', { ascending: false }).limit(9),
        supabase.from('seo_reports').select('id, token, week_start, week_end, created_at').order('week_start', { ascending: false }).limit(8),
      ])
      if (cur.error) throw cur.error
      setHits((cur.data as HitRow[]) ?? [])
      setPrevHits((prev.data as HitRow[]) ?? [])
      setSnapshots((snaps.data as SnapshotRow[]) ?? [])
      setReports((reps.data as ReportRow[]) ?? [])
    } catch (err) {
      console.error('[Seo] fetchAll:', err)
      setHits([]); setPrevHits([]); setSnapshots([]); setReports([])
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { fetchAll() }, [fetchAll])

  const openReport = useCallback(async (token: string) => {
    try {
      const { data, error } = await supabase.rpc('hp_seo_report_html', { p_token: token })
      if (error) throw error
      setReportHtml((data as string) ?? '')
    } catch (err) {
      console.error('[Seo] openReport:', err)
      showToastMsg(t('crm.seo.reportOpenError', 'Report konnte nicht geladen werden.'))
    }
  }, [t])

  const runAction = useCallback(async (action: 'snapshot' | 'report') => {
    setBusy(action)
    try {
      const { data, error } = await supabase.functions.invoke('seo-insights', {
        body: action === 'report' ? { action, force: true } : { action },
      })
      if (error) throw error
      const d = data as { success?: boolean; skipped?: string }
      showToastMsg(d?.skipped
        ? d.skipped
        : action === 'snapshot'
          ? t('crm.seo.snapshotDone', 'Schnappschuss erstellt.')
          : t('crm.seo.reportDone', 'Bericht erstellt und per Mail verschickt.'))
      await fetchAll()
    } catch (err) {
      console.error('[Seo] runAction:', err)
      showToastMsg(t('crm.seo.actionError', 'Aktion fehlgeschlagen — Details in der Konsole.'))
    } finally {
      setBusy(null)
    }
  }, [fetchAll, t])

  // ── Ableitungen ──
  const agg = aggregate(hits)
  const prevAgg = aggregate(prevHits)
  const sum = (rows: EngineAgg[], f: (e: EngineAgg) => number, only?: string[]) =>
    rows.filter(e => !only || only.includes(e.engine)).reduce((a, e) => a + f(e), 0)
  const kiAssist = sum(agg, e => e.assist, AI_ENGINES)
  const kiCrawl = sum(agg, e => e.crawl, AI_ENGINES)
  const searchCrawl = sum(agg, e => e.crawl, ['google', 'bing'])
  const aiPaths = new Map<string, number>()
  for (const h of hits) if (AI_ENGINES.includes(h.engine)) aiPaths.set(h.path, (aiPaths.get(h.path) ?? 0) + 1)
  const topAiPages = [...aiPaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const snapNow = snapshots[0] ?? null
  const snapPrev = snapshots.find(s => s.day <= snapshots[0]?.day && s !== snapshots[0] && snapshots.indexOf(s) >= Math.min(6, snapshots.length - 1)) ?? snapshots[snapshots.length - 1] ?? null
  const gsc = snapNow?.gsc ?? null

  const deltaTxt = (now: number, prev: number) => {
    if (!prev) return ''
    const pct = Math.round(((now - prev) / prev) * 100)
    return ` ${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`
  }
  const healthRows: { label: string; key: keyof SnapshotRow['metrics']; goodWhenZero?: boolean }[] = [
    { label: t('crm.seo.titlesLong', 'Titel über 60 Zeichen'), key: 'titles_over_60', goodWhenZero: true },
    { label: t('crm.seo.descMissing', 'Seiten ohne Beschreibung'), key: 'desc_missing', goodWhenZero: true },
    { label: t('crm.seo.faqPages', 'Artikel mit FAQ-Markup'), key: 'faq_pages' },
    { label: t('crm.seo.faqPairs', 'FAQ-Frage-Antwort-Paare'), key: 'faq_pairs' },
    { label: t('crm.seo.internalLinks', 'Interne Themen-Links'), key: 'internal_links' },
    { label: t('crm.seo.altMissing', 'Bilder ohne Alt-Text'), key: 'alt_missing', goodWhenZero: true },
    { label: t('crm.seo.oldTax', 'Seiten mit veralteter Steuerzahl'), key: 'old_tax_rate', goodWhenZero: true },
    { label: t('crm.seo.ttfb', 'Ø Server-Antwortzeit (ms)'), key: 'ttfb_avg_ms' },
  ]

  return (
    <DashboardLayout basePath={basePath}>
      <div className="p-4 md:p-6 max-w-6xl mx-auto">

        {/* ── Kopf ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold">{t('crm.seo.title', 'SEO & KI-Sichtbarkeit')}</h1>
            <p className="text-sm text-gray-500">steuervorteil-zypern-immobilien.com</p>
          </div>
          <div className="flex items-center gap-2">
            {( [7, 30] as Period[]).map(p => (
              <button key={p} onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 rounded-xl text-sm font-medium border ${period === p ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                style={period === p ? { backgroundColor: '#ff795d' } : undefined}>
                {t(`crm.seo.days${p}`, `${p} Tage`)}
              </button>
            ))}
            <button onClick={() => runAction('snapshot')} disabled={busy !== null}
              className="px-3 py-1.5 rounded-xl text-sm font-medium bg-white border border-gray-200 text-gray-600 disabled:opacity-50">
              {busy === 'snapshot' ? t('common.loading', 'Lädt…') : t('crm.seo.runSnapshot', 'Seiten-Check jetzt')}
            </button>
            <button onClick={() => runAction('report')} disabled={busy !== null}
              className="px-3 py-1.5 rounded-xl text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: '#ff795d' }}>
              {busy === 'report' ? t('common.loading', 'Lädt…') : t('crm.seo.runReport', 'Bericht jetzt erstellen')}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-24">
            <div className="w-10 h-10 rounded-full border-4 border-orange-300 border-t-orange-500 animate-spin" />
          </div>
        ) : (
          <>
            {/* ── KPI-Kacheln ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <Tile accent label={t('crm.seo.kiAssist', 'KI-Live-Abrufe')} value={String(kiAssist)}
                hint={t('crm.seo.kiAssistHint', 'ChatGPT/Claude/Perplexity haben die Seite für eine Nutzerfrage geladen')} />
              <Tile label={t('crm.seo.kiCrawl', 'KI-Crawls')} value={String(kiCrawl)}
                hint={deltaTxt(kiCrawl, sum(prevAgg, e => e.crawl, AI_ENGINES)) || t('crm.seo.indexHint', 'Index-Aufbau der KI-Suchen')} />
              <Tile label={t('crm.seo.searchCrawl', 'Google + Bing')} value={String(searchCrawl)}
                hint={deltaTxt(searchCrawl, sum(prevAgg, e => e.crawl, ['google', 'bing'])) || t('crm.seo.crawlHint', 'Crawler-Besuche')} />
              <Tile label={t('crm.seo.gscClicks', 'Google-Klicks')}
                value={gsc?.status === 'ok' ? String(gsc.clicks ?? 0) : '–'}
                hint={gsc?.status === 'ok'
                  ? t('crm.seo.gscPos', 'Ø Position {{p}}', { p: (gsc.position ?? 0).toFixed(1) })
                  : t('crm.seo.gscWaiting', 'Search Console wartet auf Freigabe')} />
            </div>

            <div className="grid md:grid-cols-2 gap-6 mb-6">
              {/* ── Suchsysteme ── */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <h2 className="font-semibold mb-3">{t('crm.seo.engines', 'Wer liest die Seite?')}</h2>
                {agg.length === 0 ? (
                  <p className="text-sm text-gray-400">{t('crm.seo.noHits', 'Noch keine Crawler-Besuche erfasst — die Sammlung ist gerade gestartet.')}</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wider text-gray-400">
                        <th className="text-left pb-2">{t('crm.seo.engine', 'Suchsystem')}</th>
                        <th className="text-right pb-2">{t('crm.seo.crawls', 'Crawls')}</th>
                        <th className="text-right pb-2">{t('crm.seo.assists', 'Live-Abrufe')}</th>
                        <th className="text-right pb-2">{t('crm.seo.pages', 'Seiten')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agg.map(e => (
                        <tr key={e.engine} className="border-t border-gray-50">
                          <td className="py-2">{ENGINE_LABELS[e.engine] ?? e.engine}</td>
                          <td className="py-2 text-right tabular-nums">{e.crawl}</td>
                          <td className="py-2 text-right tabular-nums font-semibold" style={e.assist ? { color: '#ff795d' } : undefined}>{e.assist}</td>
                          <td className="py-2 text-right tabular-nums text-gray-500">{e.pages}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* ── KI-Lieblingsseiten ── */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <h2 className="font-semibold mb-3">{t('crm.seo.aiPages', 'Diese Seiten lesen die KIs am häufigsten')}</h2>
                {topAiPages.length === 0 ? (
                  <p className="text-sm text-gray-400">{t('crm.seo.noAiHits', 'Noch keine KI-Bot-Besuche im Zeitraum.')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {topAiPages.map(([p, n]) => (
                      <div key={p} className="flex items-center gap-2 text-sm">
                        <span className="tabular-nums font-semibold w-8 text-right" style={{ color: '#ff795d' }}>{n}×</span>
                        <span className="truncate text-gray-600">{p}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6 mb-6">
              {/* ── Seiten-Gesundheit ── */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <h2 className="font-semibold mb-1">{t('crm.seo.health', 'Seiten-Gesundheit')}</h2>
                <p className="text-xs text-gray-400 mb-3">
                  {snapNow
                    ? t('crm.seo.healthStand', 'Täglicher Check, Stand {{d}}', { d: snapNow.day })
                    : t('crm.seo.healthNone', 'Noch kein Seiten-Check gelaufen.')}
                </p>
                {snapNow && (
                  <table className="w-full text-sm">
                    <tbody>
                      {healthRows.map(r => {
                        const now = Number(snapNow.metrics[r.key] ?? 0)
                        const prev = snapPrev && snapPrev !== snapNow ? Number(snapPrev.metrics[r.key] ?? 0) : 0
                        const good = r.goodWhenZero && now === 0
                        const bad = r.goodWhenZero && prev > 0 && now > prev
                        return (
                          <tr key={r.key} className="border-t border-gray-50">
                            <td className="py-1.5 text-gray-600">{r.label}</td>
                            <td className={`py-1.5 text-right tabular-nums font-semibold ${good ? 'text-green-600' : bad ? 'text-red-500' : ''}`}>
                              {now}{snapPrev && snapPrev !== snapNow ? <span className="text-xs text-gray-400 font-normal">{deltaTxt(now, prev)}</span> : null}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {snapNow && (
                  <div className="flex gap-2 mt-3 text-xs">
                    <span className={`px-2 py-0.5 rounded-full ${snapNow.metrics.llms_txt ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                      llms.txt {snapNow.metrics.llms_txt ? '✓' : t('crm.seo.missing', 'fehlt')}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full ${snapNow.metrics.robots_ai_ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      robots.txt {snapNow.metrics.robots_ai_ok ? '✓' : '!'}
                    </span>
                  </div>
                )}
              </div>

              {/* ── Search Console ── */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <h2 className="font-semibold mb-3">Google Search Console</h2>
                {gsc?.status === 'ok' ? (
                  <>
                    <div className="grid grid-cols-3 gap-3 mb-3 text-center">
                      <div><div className="text-xl font-bold tabular-nums">{gsc.clicks ?? 0}</div><div className="text-xs text-gray-400">{t('crm.seo.clicks', 'Klicks')}</div></div>
                      <div><div className="text-xl font-bold tabular-nums">{gsc.impressions ?? 0}</div><div className="text-xs text-gray-400">{t('crm.seo.impressions', 'Einblendungen')}</div></div>
                      <div><div className="text-xl font-bold tabular-nums">{(gsc.position ?? 0).toFixed(1)}</div><div className="text-xs text-gray-400">{t('crm.seo.position', 'Ø Position')}</div></div>
                    </div>
                    {(gsc.top_queries ?? []).map(q => (
                      <div key={q.query} className="flex justify-between text-sm border-t border-gray-50 py-1.5">
                        <span className="truncate text-gray-600">{q.query}</span>
                        <span className="tabular-nums text-gray-500 shrink-0 pl-2">Pos. {q.position} · {q.clicks}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="text-sm text-gray-500 leading-relaxed">
                    {t('crm.seo.gscExplain',
                      'Wartet auf Freigabe: Sobald der Service-Account in der Search Console als Nutzer eingetragen ist, stehen hier echte Positionen je Suchbegriff. Anleitung liegt bei Sven.')}
                  </p>
                )}
              </div>
            </div>

            {/* ── Wochenberichte ── */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <h2 className="font-semibold mb-3">{t('crm.seo.reports', 'Wochenberichte')}</h2>
              {reports.length === 0 ? (
                <p className="text-sm text-gray-400">
                  {t('crm.seo.noReports', 'Noch kein Bericht — der erste kommt automatisch am Montag um 07:00, oder oben per Knopf.')}
                </p>
              ) : (
                <div className="space-y-2">
                  {reports.map(r => (
                    <button key={r.id} onClick={() => openReport(r.token)}
                      className="w-full flex items-center justify-between text-left text-sm border border-gray-100 rounded-xl px-4 py-3 hover:border-orange-200">
                      <span>{t('crm.seo.reportWeek', 'Woche {{from}} – {{to}}', { from: r.week_start, to: r.week_end })}</span>
                      <span className="text-gray-400">{t('crm.seo.open', 'Öffnen')} →</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {reportHtml !== null && <ReportModal html={reportHtml} onClose={() => setReportHtml(null)} />}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}
    </DashboardLayout>
  )
}
