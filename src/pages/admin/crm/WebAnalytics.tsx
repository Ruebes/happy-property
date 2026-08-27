// Web-Analytics: eigenes Google-Analytics + Mouseflow im CRM.
// Datenquelle: web_sessions / web_events / web_replay_chunks (Edge wa-track).
// Drei Tabs: Übersicht (KPIs, Verlauf, Seiten, Quellen, Geräte),
// Heatmap (Klick-/Bewegungs-Heatmap + Scrolltiefe je Seite),
// Besucher (einzelne Sessions mit Session-Replay wie Mouseflow).
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import 'rrweb-player/dist/style.css'

// ── Typen ────────────────────────────────────────────────────────────────────
interface Kpis {
  sessions: number; visitors: number; pageviews: number; clicks: number
  avg_duration_s: number; bounce_pct: number; avg_scroll_pct: number; with_replay: number
}
interface DailyRow { day: string; sessions: number; visitors: number; pageviews: number }
interface PageRow { site: string; path: string; views: number; sessions: number }
interface SourceRow { source: string; sessions: number; visitors: number }
interface DeviceRow { device: string; browser: string; sessions: number }
interface SiteRow { site: string; sessions: number }
interface SessionRow {
  id: string; visitor_id: string; site: string; entry_path: string | null
  referrer: string | null; utm: Record<string, string> | null
  device: string | null; browser: string | null; os: string | null
  lead_id: string | null; started_at: string; duration_s: number
  pageviews: number; clicks: number; max_scroll_pct: number; has_replay: boolean
  leads?: { first_name: string | null; last_name: string | null } | null
}
interface EventRow {
  type: string; path: string | null; ts: string
  x: number | null; y: number | null; selector: string | null; txt: string | null
  meta: Record<string, unknown> | null
}
interface HeatPoint { x: number; y: number; vw: number; dh: number }
interface ScrollDepth { sessions: number; p25: number; p50: number; p75: number; p100: number }

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'quarter' | 'custom'
type Tab = 'overview' | 'heatmap' | 'visitors'

// ── Besucher-Typen (Heuristik aus hp_wa_segments, Regeln in der Migration) ───
type Segment = 'gebucht' | 'funnel_abbruch' | 'interessent' | 'expose_jaeger' | 'kurzbesucher' | 'absprung'
const SEGMENTS: { id: Segment; icon: string; label: string; desc: string; color: string }[] = [
  { id: 'gebucht',        icon: '✅', label: 'Termin gebucht',      desc: 'Haben über den Funnel gebucht', color: '#1f9d55' },
  { id: 'funnel_abbruch', icon: '🚪', label: 'Funnel abgebrochen',  desc: 'Waren im Termin-Funnel, haben nicht gebucht', color: '#d97706' },
  { id: 'interessent',    icon: '📖', label: 'Echte Interessenten', desc: 'Über 1 Min. aktiv, mehrere Seiten oder tief gescrollt — aber kein Termin', color: '#ff795d' },
  { id: 'expose_jaeger',  icon: '🏠', label: 'Exposé-Jäger',        desc: 'Nur Objekte/Rechner/Exposés angesehen, unter 2 Min.', color: '#6366f1' },
  { id: 'kurzbesucher',   icon: '👀', label: 'Kurzbesucher',        desc: 'Kurz umgesehen, wenig gelesen', color: '#9ca3af' },
  { id: 'absprung',       icon: '💨', label: 'Sofort weg',          desc: 'Direkt wieder abgesprungen', color: '#d1d5db' },
]
const segMeta = (id: string) => SEGMENTS.find(s => s.id === id)

function periodRange(p: Period, from: string, to: string): { from: Date; to: Date } {
  const now = new Date()
  const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
  if (p === 'today') return { from: startOfDay(now), to: now }
  if (p === 'yesterday') {
    const y = startOfDay(now); y.setDate(y.getDate() - 1)
    return { from: y, to: startOfDay(now) }
  }
  if (p === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); return { from: d, to: now } }
  if (p === 'month') { const d = new Date(now); d.setDate(d.getDate() - 30); return { from: d, to: now } }
  if (p === 'quarter') { const d = new Date(now); d.setDate(d.getDate() - 90); return { from: d, to: now } }
  return {
    from: from ? new Date(from) : startOfDay(now),
    to: to ? new Date(to + 'T23:59:59') : now,
  }
}

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const fmtNum = (n: number) => new Intl.NumberFormat('de-DE').format(n)

// ── Heatmap-Canvas: Punkte → Dichte → Farbpalette (wie Mouseflow) ────────────
function drawHeatmap(canvas: HTMLCanvasElement, points: HeatPoint[], frameW: number, frameH: number) {
  canvas.width = frameW
  canvas.height = frameH
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, frameW, frameH)
  if (!points.length) return

  // 1) Dichte als Graustufen-Alpha
  const r = 22
  for (const p of points) {
    const s = frameW / p.vw
    const cx = p.x * s
    const cy = p.y * s
    if (cy > frameH + r) continue
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0, 'rgba(0,0,0,0.22)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  }
  // 2) Alpha → Farbverlauf blau→grün→gelb→rot
  const img = ctx.getImageData(0, 0, frameW, frameH)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    if (!a) continue
    const t = Math.min(1, a / 200)
    let cr = 0, cg = 0, cb = 0
    if (t < 0.33) { const k = t / 0.33; cr = 0; cg = Math.round(120 + 135 * k); cb = Math.round(255 * (1 - k)) }
    else if (t < 0.66) { const k = (t - 0.33) / 0.33; cr = Math.round(255 * k); cg = 255; cb = 0 }
    else { const k = (t - 0.66) / 0.34; cr = 255; cg = Math.round(255 * (1 - k)); cb = 0 }
    d[i] = cr; d[i + 1] = cg; d[i + 2] = cb
    d[i + 3] = Math.min(215, Math.round(a * 1.35))
  }
  ctx.putImageData(img, 0, 0)
}

// ── Session-Detail-Modal mit Replay ──────────────────────────────────────────
interface SessionModalProps { session: SessionRow; onClose: () => void }

function SessionModal({ session, onClose }: SessionModalProps) {
  const { t } = useTranslation()
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [replayState, setReplayState] = useState<'none' | 'loading' | 'ready' | 'error'>(session.has_replay ? 'loading' : 'none')
  const playerRef = useRef<HTMLDivElement>(null)
  const playerInstance = useRef<{ $destroy: () => void } | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const { data, error } = await supabase.from('web_events')
          .select('type, path, ts, x, y, selector, txt, meta')
          .eq('session_id', session.id)
          .neq('type', 'move')
          .order('ts', { ascending: true })
          .limit(500)
        if (error) throw error
        if (!cancelled) setEvents((data as unknown as EventRow[]) ?? [])
      } catch (err) {
        console.error('[WebAnalytics] session events:', err)
        if (!cancelled) setEvents([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [session.id])

  useEffect(() => {
    if (!session.has_replay) return
    let cancelled = false
    const loadReplay = async () => {
      try {
        const { data, error } = await supabase.from('web_replay_chunks')
          .select('seq, events')
          .eq('session_id', session.id)
          .order('seq', { ascending: true })
        if (error) throw error
        const chunks = (data as unknown as { seq: number; events: unknown[] }[]) ?? []
        const all = chunks.flatMap(c => c.events)
        if (cancelled || !playerRef.current) return
        // Ohne Full-Snapshot (rrweb-Eventtyp 2) kann der Player nichts rendern —
        // passiert bei alten/unvollstaendigen Aufzeichnungen.
        const hasSnapshot = all.some(e => (e as { type?: number }).type === 2)
        if (all.length < 2 || !hasSnapshot) { setReplayState('error'); return }
        // Meta-Events mit kaputten Massen reparieren (width 0 = Aufnahme aus
        // verstecktem/prerendertem Tab) — sonst rendert der Player 0px breit.
        for (const e of all) {
          const ev = e as { type?: number; data?: { width?: number; height?: number } }
          if (ev.type === 4 && ev.data) {
            if (!ev.data.width || ev.data.width < 50) ev.data.width = 1280
            if (!ev.data.height || ev.data.height < 50 || ev.data.height > 5000) ev.data.height = 800
          }
        }
        const { default: rrwebPlayer } = await import('rrweb-player')
        if (cancelled || !playerRef.current) return
        playerInstance.current = new rrwebPlayer({
          target: playerRef.current,
          props: {
            events: all,
            width: Math.min(900, playerRef.current.clientWidth || 900),
            height: 480,
            autoPlay: false,
            skipInactive: true,
            speedOption: [1, 2, 4, 8],
          },
        }) as unknown as { $destroy: () => void }
        setReplayState('ready')
      } catch (err) {
        console.error('[WebAnalytics] replay:', err)
        if (!cancelled) setReplayState('error')
      }
    }
    void loadReplay()
    return () => {
      cancelled = true
      try { playerInstance.current?.$destroy() } catch { /* egal */ }
      playerInstance.current = null
      // Svelte-eigenen Container leeren — React rendert hier NIE Kinder rein
      // (sonst crasht Reacts removeChild beim naechsten Re-Render).
      if (playerRef.current) playerRef.current.innerHTML = ''
    }
  }, [session.id, session.has_replay])

  const start = new Date(session.started_at).getTime()
  const leadName = session.leads ? `${session.leads.first_name ?? ''} ${session.leads.last_name ?? ''}`.trim() : ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[92vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">
              {leadName || t('crm.webstats.visitor', 'Besucher')} · {session.site}
            </h2>
            <p className="text-sm text-gray-500">
              {new Date(session.started_at).toLocaleString('de-DE')} · {session.device} / {session.browser} / {session.os}
              {' · '}{t('crm.webstats.duration', 'Dauer')} {fmtDur(session.duration_s)}
              {' · '}{session.pageviews} {t('crm.webstats.pages', 'Seiten')} · {session.clicks} {t('crm.webstats.clicks', 'Klicks')}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        {session.has_replay && (
          <div className="mb-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">🎬 {t('crm.webstats.replay', 'Session-Replay')}</h3>
            {/* Wrapper ist React-Territorium; das ref-Div gehoert exklusiv dem
                rrweb-Player (Svelte). Beide mischen = removeChild-Crash. */}
            <div className="rounded-xl overflow-hidden border border-gray-200 bg-gray-50 min-h-[100px]">
              {replayState === 'loading' && (
                <div className="flex justify-center py-10">
                  <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
                </div>
              )}
              {replayState === 'error' && (
                <p className="text-sm text-gray-400 py-8 text-center">{t('crm.webstats.replayError', 'Diese Aufzeichnung ist unvollständig und kann nicht abgespielt werden.')}</p>
              )}
              <div ref={playerRef} />
            </div>
          </div>
        )}

        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('crm.webstats.timeline', 'Verlauf')}</h3>
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-1.5">
            {events.map((e, i) => {
              const off = Math.max(0, Math.round((new Date(e.ts).getTime() - start) / 1000))
              const isCustom = e.type.startsWith('c:')
              const icon = e.type === 'pageview' ? '📄' : e.type === 'click' ? '👆' : e.type === 'scroll' ? '↕️' : isCustom ? '⭐' : '·'
              return (
                <div key={i} className="flex items-baseline gap-3 text-sm">
                  <span className="text-xs text-gray-400 w-12 text-right shrink-0 font-mono">{fmtDur(off)}</span>
                  <span className="shrink-0">{icon}</span>
                  <span className="text-gray-700 break-all">
                    {e.type === 'pageview' && <>{e.path}</>}
                    {e.type === 'click' && <>{t('crm.webstats.clickOn', 'Klick auf')} <span className="font-medium">{e.txt || e.selector || '?'}</span> <span className="text-gray-400">({e.path})</span></>}
                    {e.type === 'scroll' && <>{t('crm.webstats.scrolledTo', 'Gescrollt bis')} {(e.meta as { pct?: number } | null)?.pct ?? '?'}%</>}
                    {isCustom && <span className="font-medium text-orange-600">{e.type.slice(2)}</span>}
                  </span>
                </div>
              )
            })}
            {events.length === 0 && <p className="text-sm text-gray-400">{t('crm.webstats.noEvents', 'Keine Ereignisse.')}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Seite ────────────────────────────────────────────────────────────────────
export default function WebAnalytics() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('overview')
  const [period, setPeriod] = useState<Period>('week')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [site, setSite] = useState<string>('')          // '' = alle Sites
  const [sites, setSites] = useState<SiteRow[]>([])
  const [loading, setLoading] = useState(true)

  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [pages, setPages] = useState<PageRow[]>([])
  const [sources, setSources] = useState<SourceRow[]>([])
  const [devices, setDevices] = useState<DeviceRow[]>([])

  // Heatmap
  const [heatSite, setHeatSite] = useState('')
  const [heatPath, setHeatPath] = useState('')
  const [heatType, setHeatType] = useState<'click' | 'move'>('click')
  const [heatDevice, setHeatDevice] = useState<'' | 'Desktop' | 'Mobil'>('')
  const [heatPoints, setHeatPoints] = useState<HeatPoint[]>([])
  const [scrollDepth, setScrollDepth] = useState<ScrollDepth | null>(null)
  const [heatLoading, setHeatLoading] = useState(false)
  const heatCanvasRef = useRef<HTMLCanvasElement>(null)

  // Besucher
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [onlyLeads, setOnlyLeads] = useState(false)
  const [onlyReplay, setOnlyReplay] = useState(false)
  const [selected, setSelected] = useState<SessionRow | null>(null)
  // Besucher-Typen: session_id → Segment (gleicher Zeitraum/Site-Filter)
  const [segments, setSegments] = useState<Record<string, Segment>>({})
  const [segFilter, setSegFilter] = useState<Segment | ''>('')

  // ── Übersicht laden ────────────────────────────────────────────────────────
  const fetchOverview = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = periodRange(period, customFrom, customTo)
      const p = { p_from: from.toISOString(), p_to: to.toISOString(), p_site: site || null }
      const [k, d, pg, so, de, si, sg] = await Promise.all([
        supabase.rpc('hp_wa_kpis', p),
        supabase.rpc('hp_wa_daily', p),
        supabase.rpc('hp_wa_pages', { ...p, p_limit: 20 }),
        supabase.rpc('hp_wa_sources', p),
        supabase.rpc('hp_wa_devices', p),
        supabase.rpc('hp_wa_sites', { p_from: from.toISOString(), p_to: to.toISOString() }),
        supabase.rpc('hp_wa_segments', p),
      ])
      setKpis((k.data as Kpis) ?? null)
      setDaily((d.data as DailyRow[]) ?? [])
      setPages((pg.data as PageRow[]) ?? [])
      setSources((so.data as SourceRow[]) ?? [])
      setDevices((de.data as DeviceRow[]) ?? [])
      setSites((si.data as SiteRow[]) ?? [])
      const segMap: Record<string, Segment> = {}
      for (const row of ((sg.data as { session_id: string; segment: Segment }[]) ?? [])) segMap[row.session_id] = row.segment
      setSegments(segMap)
    } catch (err) {
      console.error('[WebAnalytics] fetchOverview:', err)
      setKpis(null); setDaily([]); setPages([]); setSources([]); setDevices([])
    } finally {
      setLoading(false)
    }
  }, [period, customFrom, customTo, site])

  useEffect(() => { void fetchOverview() }, [fetchOverview])

  // ── Heatmap laden ──────────────────────────────────────────────────────────
  const fetchHeatmap = useCallback(async () => {
    if (!heatSite || !heatPath) return
    setHeatLoading(true)
    try {
      const { from, to } = periodRange(period, customFrom, customTo)
      const [h, sd] = await Promise.all([
        supabase.rpc('hp_wa_heatmap', {
          p_site: heatSite, p_path: heatPath, p_type: heatType,
          p_from: from.toISOString(), p_to: to.toISOString(),
          p_device: heatDevice || null, p_limit: 20000,
        }),
        supabase.rpc('hp_wa_scrolldepth', {
          p_site: heatSite, p_path: heatPath,
          p_from: from.toISOString(), p_to: to.toISOString(),
        }),
      ])
      setHeatPoints((h.data as HeatPoint[]) ?? [])
      setScrollDepth((sd.data as ScrollDepth) ?? null)
    } catch (err) {
      console.error('[WebAnalytics] fetchHeatmap:', err)
      setHeatPoints([]); setScrollDepth(null)
    } finally {
      setHeatLoading(false)
    }
  }, [heatSite, heatPath, heatType, heatDevice, period, customFrom, customTo])

  useEffect(() => { if (tab === 'heatmap') void fetchHeatmap() }, [tab, fetchHeatmap])

  // Heatmap-Vorauswahl: erste Site + meistbesuchte Seite
  useEffect(() => {
    if (!heatSite && sites.length) setHeatSite(sites[0].site)
  }, [sites, heatSite])
  useEffect(() => {
    if (heatSite && !heatPath) {
      const first = pages.find(p => p.site === heatSite)
      if (first?.path) setHeatPath(first.path)
    }
  }, [heatSite, heatPath, pages])

  // Canvas neu zeichnen
  const isMobile = heatDevice === 'Mobil'
  const frameW = isMobile ? 390 : 1280
  const medianRatio = (() => {
    const rs = heatPoints.filter(p => p.dh > 0 && p.vw > 0).map(p => p.dh / p.vw).sort((a, b) => a - b)
    return rs.length ? rs[Math.floor(rs.length / 2)] : 3
  })()
  const frameH = Math.min(9000, Math.max(800, Math.round(frameW * medianRatio)))
  useEffect(() => {
    if (tab === 'heatmap' && heatCanvasRef.current) drawHeatmap(heatCanvasRef.current, heatPoints, frameW, frameH)
  }, [tab, heatPoints, frameW, frameH])

  // ── Besucher laden ─────────────────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = periodRange(period, customFrom, customTo)
      let q = supabase.from('web_sessions')
        .select('id, visitor_id, site, entry_path, referrer, utm, device, browser, os, lead_id, started_at, duration_s, pageviews, clicks, max_scroll_pct, has_replay, leads(first_name, last_name)')
        .gte('started_at', from.toISOString())
        .lt('started_at', to.toISOString())
        .order('started_at', { ascending: false })
        .limit(200)
      if (site) q = q.eq('site', site)
      if (onlyLeads) q = q.not('lead_id', 'is', null)
      if (onlyReplay) q = q.eq('has_replay', true)
      const { data, error } = await q
      if (error) throw error
      setSessions((data as unknown as SessionRow[]) ?? [])
    } catch (err) {
      console.error('[WebAnalytics] fetchSessions:', err)
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [period, customFrom, customTo, site, onlyLeads, onlyReplay])

  useEffect(() => { if (tab === 'visitors') void fetchSessions() }, [tab, fetchSessions])

  // ── UI-Bausteine ───────────────────────────────────────────────────────────
  const PERIODS: { id: Period; label: string }[] = [
    { id: 'today',     label: t('crm.webstats.period.today', 'Heute') },
    { id: 'yesterday', label: t('crm.webstats.period.yesterday', 'Gestern') },
    { id: 'week',      label: t('crm.webstats.period.week', '7 Tage') },
    { id: 'month',     label: t('crm.webstats.period.month', '30 Tage') },
    { id: 'quarter',   label: t('crm.webstats.period.quarter', '90 Tage') },
    { id: 'custom',    label: t('crm.webstats.period.custom', 'Benutzerdefiniert') },
  ]
  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('crm.webstats.tab.overview', 'Übersicht') },
    { id: 'heatmap',  label: t('crm.webstats.tab.heatmap', 'Heatmap') },
    { id: 'visitors', label: t('crm.webstats.tab.visitors', 'Besucher & Replays') },
  ]

  const maxDaily = Math.max(1, ...daily.map(d => d.sessions))
  const visibleSessions = segFilter ? sessions.filter(s => segments[s.id] === segFilter) : sessions
  const sourceOf = (s: SessionRow) => {
    if (s.utm?.utm_source || s.utm?.src) return s.utm.utm_source || s.utm.src
    try { if (s.referrer) return new URL(s.referrer).hostname.replace('www.', '') } catch { /* kaputter Referrer */ }
    return t('crm.webstats.direct', 'direkt')
  }

  const kpiCards: { label: string; value: string }[] = kpis ? [
    { label: t('crm.webstats.kpi.visitors', 'Besucher'),      value: fmtNum(kpis.visitors) },
    { label: t('crm.webstats.kpi.sessions', 'Sitzungen'),     value: fmtNum(kpis.sessions) },
    { label: t('crm.webstats.kpi.pageviews', 'Seitenaufrufe'), value: fmtNum(kpis.pageviews) },
    { label: t('crm.webstats.kpi.avgDuration', 'Ø Dauer'),    value: fmtDur(kpis.avg_duration_s) },
    { label: t('crm.webstats.kpi.bounce', 'Absprungrate'),    value: `${kpis.bounce_pct}%` },
    { label: t('crm.webstats.kpi.scroll', 'Ø Scrolltiefe'),   value: `${kpis.avg_scroll_pct}%` },
    { label: t('crm.webstats.kpi.clicks', 'Klicks'),          value: fmtNum(kpis.clicks) },
    { label: t('crm.webstats.kpi.replays', 'Replays'),        value: fmtNum(kpis.with_replay) },
  ] : []

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.webstats.title', 'Web-Analytics')}</h1>
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {TABS.map(tb => (
              <button key={tb.id} onClick={() => setTab(tb.id)}
                className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={tab === tb.id ? { backgroundColor: '#fff', color: '#1a2332', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' } : { color: '#6b7280' }}>
                {tb.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filter: Zeitraum + Site */}
        <div className="flex gap-2 flex-wrap items-center">
          {PERIODS.map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors"
              style={period === p.id
                ? { backgroundColor: '#ff795d', color: '#fff', borderColor: '#ff795d' }
                : { backgroundColor: '#fff', color: '#374151', borderColor: '#d1d5db' }}>
              {p.label}
            </button>
          ))}
          <select value={site} onChange={e => setSite(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
            <option value="">{t('crm.webstats.allSites', 'Alle Websites')}</option>
            {sites.map(s => <option key={s.site} value={s.site}>{s.site} ({s.sessions})</option>)}
          </select>
        </div>
        {period === 'custom' && (
          <div className="flex gap-3 items-center">
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
            <span className="text-gray-400">–</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
          </div>
        )}

        {/* ── Tab: Übersicht ── */}
        {tab === 'overview' && (loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {kpiCards.map(c => (
                <div key={c.label} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                  <p className="text-xs text-gray-500">{c.label}</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{c.value}</p>
                </div>
              ))}
            </div>

            {/* Besucher-Typen: wer waren die Leute — und wer haette buchen koennen? */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-1">{t('crm.webstats.segments', 'Besucher-Typen')}</h3>
              <p className="text-xs text-gray-400 mb-3">{t('crm.webstats.segmentsHint', 'Automatisch nach Verhalten eingeordnet (Lesezeit, Scrolltiefe, Seiten, Funnel). Klick auf eine Kachel zeigt die einzelnen Besucher.')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {SEGMENTS.map(sg => {
                  const n = Object.values(segments).filter(v => v === sg.id).length
                  const total = Object.keys(segments).length || 1
                  return (
                    <button key={sg.id} title={sg.desc}
                      onClick={() => { setSegFilter(sg.id); setTab('visitors') }}
                      className="text-left rounded-xl border p-3 hover:shadow-md transition-shadow"
                      style={{ borderColor: n ? sg.color : '#e5e7eb', backgroundColor: n ? `${sg.color}12` : '#fafafa' }}>
                      <div className="text-lg">{sg.icon}</div>
                      <div className="text-xl font-bold text-gray-900">{n}</div>
                      <div className="text-[11px] leading-tight text-gray-600">{sg.label}</div>
                      <div className="text-[10px] text-gray-400">{Math.round((n / total) * 100)}%</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Verlauf */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('crm.webstats.trend', 'Sitzungen pro Tag')}</h3>
              {daily.length === 0 ? (
                <p className="text-sm text-gray-400">{t('crm.webstats.noData', 'Noch keine Daten — das Tracking sammelt ab jetzt.')}</p>
              ) : (
                <div className="flex items-end gap-1 h-36">
                  {daily.map(d => (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0 group relative">
                      <div className="absolute -top-8 hidden group-hover:block bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                        {d.day}: {d.sessions} / {d.visitors} / {d.pageviews}
                      </div>
                      <div className="w-full rounded-t" style={{ backgroundColor: '#ff795d', height: `${Math.max(3, (d.sessions / maxDaily) * 120)}px` }} />
                      <span className="text-[10px] text-gray-400 truncate">{d.day.slice(8, 10)}.{d.day.slice(5, 7)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              {/* Top-Seiten */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <h3 className="text-sm font-semibold text-gray-700 px-5 pt-4 pb-2">{t('crm.webstats.topPages', 'Top-Seiten')}</h3>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-50">
                    {pages.map((p, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-5 py-2 text-gray-700 break-all">
                          {!site && <span className="text-gray-400 text-xs">{p.site}</span>}<br className={site ? 'hidden' : ''} />{p.path}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500 whitespace-nowrap">{fmtNum(p.views)} <span className="text-xs text-gray-400">{t('crm.webstats.views', 'Aufrufe')}</span></td>
                      </tr>
                    ))}
                    {pages.length === 0 && <tr><td className="px-5 py-4 text-gray-400">{t('crm.webstats.noData', 'Noch keine Daten — das Tracking sammelt ab jetzt.')}</td></tr>}
                  </tbody>
                </table>
              </div>
              {/* Quellen */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <h3 className="text-sm font-semibold text-gray-700 px-5 pt-4 pb-2">{t('crm.webstats.sources', 'Quellen')}</h3>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-50">
                    {sources.map((s, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-5 py-2 text-gray-700">{s.source}</td>
                        <td className="px-3 py-2 text-right text-gray-500 whitespace-nowrap">{fmtNum(s.sessions)} <span className="text-xs text-gray-400">{t('crm.webstats.sessionsShort', 'Sitzungen')}</span></td>
                      </tr>
                    ))}
                    {sources.length === 0 && <tr><td className="px-5 py-4 text-gray-400">{t('crm.webstats.noData', 'Noch keine Daten — das Tracking sammelt ab jetzt.')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Geräte */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <h3 className="text-sm font-semibold text-gray-700 px-5 pt-4 pb-2">{t('crm.webstats.devices', 'Geräte & Browser')}</h3>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-50">
                  {devices.map((d, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-5 py-2 text-gray-700">{d.device}</td>
                      <td className="px-3 py-2 text-gray-500">{d.browser}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{fmtNum(d.sessions)}</td>
                    </tr>
                  ))}
                  {devices.length === 0 && <tr><td className="px-5 py-4 text-gray-400">{t('crm.webstats.noData', 'Noch keine Daten — das Tracking sammelt ab jetzt.')}</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        ))}

        {/* ── Tab: Heatmap ── */}
        {tab === 'heatmap' && (
          <>
            <div className="flex gap-2 flex-wrap items-center">
              <select value={heatSite} onChange={e => { setHeatSite(e.target.value); setHeatPath('') }}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white">
                {sites.map(s => <option key={s.site} value={s.site}>{s.site}</option>)}
                {sites.length === 0 && <option value="">{t('crm.webstats.noData', 'Noch keine Daten — das Tracking sammelt ab jetzt.')}</option>}
              </select>
              <select value={heatPath} onChange={e => setHeatPath(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white max-w-xs">
                {pages.filter(p => p.site === heatSite).map(p => <option key={p.path} value={p.path}>{p.path} ({p.views})</option>)}
              </select>
              <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                {(['click', 'move'] as const).map(ty => (
                  <button key={ty} onClick={() => setHeatType(ty)}
                    className="px-3 py-1 rounded-md text-sm font-medium"
                    style={heatType === ty ? { backgroundColor: '#fff', color: '#1a2332' } : { color: '#6b7280' }}>
                    {ty === 'click' ? t('crm.webstats.heatClicks', 'Klicks') : t('crm.webstats.heatMoves', 'Bewegung')}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                {([['', t('crm.webstats.all', 'Alle')], ['Desktop', 'Desktop'], ['Mobil', 'Mobil']] as const).map(([v, l]) => (
                  <button key={v} onClick={() => setHeatDevice(v as '' | 'Desktop' | 'Mobil')}
                    className="px-3 py-1 rounded-md text-sm font-medium"
                    style={heatDevice === v ? { backgroundColor: '#fff', color: '#1a2332' } : { color: '#6b7280' }}>
                    {l}
                  </button>
                ))}
              </div>
              <span className="text-sm text-gray-500">{fmtNum(heatPoints.length)} {t('crm.webstats.points', 'Punkte')}</span>
            </div>

            {scrollDepth && scrollDepth.sessions > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('crm.webstats.scrollDepth', 'Scrolltiefe')} ({scrollDepth.sessions} {t('crm.webstats.sessionsShort', 'Sitzungen')})</h3>
                <div className="flex gap-2">
                  {[['25%', scrollDepth.p25], ['50%', scrollDepth.p50], ['75%', scrollDepth.p75], ['100%', scrollDepth.p100]].map(([l, v]) => (
                    <div key={l as string} className="flex-1">
                      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${v}%`, backgroundColor: '#ff795d' }} />
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{l}: {v}% {t('crm.webstats.reach', 'erreichen')}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 overflow-auto">
              {heatLoading ? (
                <div className="flex justify-center py-16">
                  <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
                </div>
              ) : heatPoints.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">{t('crm.webstats.noHeatData', 'Für diese Seite liegen im Zeitraum keine Daten vor.')}</p>
              ) : (
                <div className="relative mx-auto" style={{ width: frameW, height: frameH }}>
                  <iframe src={`https://${heatSite}${heatPath}`} title="Heatmap"
                    width={frameW} height={frameH}
                    className="absolute inset-0 border-0 rounded-lg bg-gray-50"
                    sandbox="allow-same-origin" scrolling="no" />
                  <canvas ref={heatCanvasRef} className="absolute inset-0 pointer-events-none" style={{ opacity: 0.9 }} />
                </div>
              )}
              <p className="text-xs text-gray-400 mt-2">{t('crm.webstats.heatHint', 'Seiten-Vorschau live von der Website; Punkte werden auf die Seitenbreite skaliert.')}</p>
            </div>
          </>
        )}

        {/* ── Tab: Besucher ── */}
        {tab === 'visitors' && (
          <>
            <div className="flex gap-3 items-center text-sm flex-wrap">
              <select value={segFilter} onChange={e => setSegFilter(e.target.value as Segment | '')}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                <option value="">{t('crm.webstats.allSegments', 'Alle Besucher-Typen')}</option>
                {SEGMENTS.map(sg => <option key={sg.id} value={sg.id}>{sg.icon} {sg.label}</option>)}
              </select>
              <label className="flex items-center gap-2 text-gray-600">
                <input type="checkbox" checked={onlyLeads} onChange={e => setOnlyLeads(e.target.checked)} className="rounded" />
                {t('crm.webstats.onlyLeads', 'Nur erkannte Kunden')}
              </label>
              <label className="flex items-center gap-2 text-gray-600">
                <input type="checkbox" checked={onlyReplay} onChange={e => setOnlyReplay(e.target.checked)} className="rounded" />
                {t('crm.webstats.onlyReplay', 'Nur mit Replay')}
              </label>
            </div>
            {loading ? (
              <div className="flex justify-center py-16">
                <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
              </div>
            ) : visibleSessions.length === 0 ? (
              <p className="text-gray-400 text-center py-16">{segFilter
                ? t('crm.webstats.noSegmentData', 'Keine Besucher dieses Typs im Zeitraum.')
                : t('crm.webstats.noData', 'Noch keine Daten — das Tracking sammelt ab jetzt.')}</p>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.time', 'Zeit')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.visitor', 'Besucher')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.type', 'Typ')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.site', 'Website')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.source', 'Quelle')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.device', 'Gerät')}</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.pages', 'Seiten')}</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{t('crm.webstats.duration', 'Dauer')}</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {visibleSessions.map(s => {
                      const leadName = s.leads ? `${s.leads.first_name ?? ''} ${s.leads.last_name ?? ''}`.trim() : ''
                      const sm = segMeta(segments[s.id] ?? '')
                      return (
                        <tr key={s.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(s)}>
                          <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{new Date(s.started_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                          <td className="px-4 py-2.5">
                            {leadName
                              ? <span className="font-medium text-gray-900">👤 {leadName}</span>
                              : <span className="text-gray-500 font-mono text-xs">{s.visitor_id.slice(0, 8)}</span>}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            {sm && <span title={sm.desc} className="inline-block px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: `${sm.color}1a`, color: sm.color }}>{sm.icon} {sm.label}</span>}
                          </td>
                          <td className="px-4 py-2.5 text-gray-700">{s.site}<span className="text-gray-400 text-xs block truncate max-w-[160px]">{s.entry_path}</span></td>
                          <td className="px-4 py-2.5 text-gray-600">{sourceOf(s)}</td>
                          <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{s.device} · {s.browser}</td>
                          <td className="px-4 py-2.5 text-right text-gray-700">{s.pageviews}</td>
                          <td className="px-4 py-2.5 text-right text-gray-700 font-mono">{fmtDur(s.duration_s)}</td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            {s.has_replay && <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: '#fff0ec', color: '#ff795d' }}>🎬 Replay</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {selected && <SessionModal session={selected} onClose={() => setSelected(null)} />}
      </div>
    </DashboardLayout>
  )
}
