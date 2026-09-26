// Karte „📈 Wachstum“ im Social-Studio (Ansicht Redaktionsplan).
// Daten: Edge Function social-growth, action 'status' (Tageswerte der letzten 60 Tage,
// Kennzahlen je Plattform, Top-Reels). Ziel: 5.000 Follower je Plattform in 12 Monaten
// ab 26.09.2026. Alles defensiv gelesen: fehlende oder unbekannte Werte dürfen die
// Seite nie leeren.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

type Platform = 'instagram' | 'facebook'
const PLATFORMS: Platform[] = ['instagram', 'facebook']
const NAVY = '#1a2332'
const CORAL = '#ff795d'
const DAY_MS = 86400000

// Fallbacks, falls der Server (noch) kein target mitschickt
const DEFAULT_TARGET = { value: 5000, base_date: '2026-09-26', end_date: '2027-09-26', baseline: { instagram: 364, facebook: 139 } as Record<Platform, number> }

interface GrowthKpi {
  current?: number | null; current_day?: string | null; target_today?: number | null
  net_7d?: number | null; net_7d_source?: string | null; net_28d?: number | null; net_28d_source?: string | null
  required_per_month?: number | null; required_7d?: number | null; required_28d?: number | null
  actual_per_month?: number | null; on_track?: boolean | null; projected_end?: number | null
  reach_28d?: { organic?: number | null; paid?: number | null; total?: number | null; organic_share?: number | null; days?: number | null } | null
  profile_views_28d?: number | null; link_taps_28d?: number | null
}
interface GrowthDay { day?: string; platform?: string; followers?: number | null; estimated?: boolean }
interface GrowthReel {
  post_ref?: string; platform?: string; published_at?: string | null; snapshot?: string | null
  reach?: number | null; shares?: number | null; avg_watch_time_ms?: number | null
  caption?: string | null; permalink?: string | null; backfill?: boolean
}
interface GrowthStatus {
  today?: string
  target?: { value?: number; base_date?: string; end_date?: string; baseline?: Partial<Record<Platform, number>> } | null
  kpis?: Partial<Record<Platform, GrowthKpi>> | null
  rows?: GrowthDay[] | null
  top_reels?: { by_shares?: GrowthReel[] | null; by_watch_time?: GrowthReel[] | null } | null
  last_run?: { at?: string; finished_at?: string; errors?: string[] | null } | null
  error?: string | null
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const fmtN = (n: unknown) => (isNum(n) ? Math.round(n).toLocaleString('de-DE') : '-')
const signed = (n: unknown) => (isNum(n) ? `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString('de-DE')}` : '-')
const pct = (x: unknown) => (isNum(x) ? `${Math.round(x * 100).toLocaleString('de-DE')} %` : '-')
const secs = (ms: unknown) => (isNum(ms) ? `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s` : '-')
const ymdAdd = (ymd: string, n: number) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS)
const validYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`))
const ddmm = (ymd: string) => { const [, m, d] = ymd.split('-'); return `${d}.${m}.` }
const ddmmyyyy = (ymd: string) => { const [y, m, d] = ymd.split('-'); return `${d}.${m}.${y}` }

// ── Mini-Liniendiagramm: Follower je Tag + gestrichelter Soll-Pfad ────────────
function FollowerChart({ platform, rows, today, target }: {
  platform: Platform; rows: GrowthDay[]; today: string
  target: { value: number; base_date: string; end_date: string; baseline: number }
}) {
  const { t } = useTranslation()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  const W = 320, H = 150, PL = 38, PR = 10, PT = 10, PB = 22
  const model = useMemo(() => {
    const own = rows.filter(r => r?.platform === platform && validYmd(r?.day) && isNum(r?.followers))
      .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    const first = own[0]?.day ?? today
    const start = daysBetween(first, today) > 59 ? ymdAdd(today, -59) : first
    const end = ymdAdd(today, 28)                       // 4 Wochen Soll-Pfad voraus
    const n = Math.max(1, daysBetween(start, end))
    const span = Math.max(1, daysBetween(target.base_date, target.end_date))
    const soll = (d: string) => {
      const k = daysBetween(target.base_date, d)
      return k < 0 ? null : target.baseline + (target.value - target.baseline) * Math.min(1, k / span)
    }
    const byDay = new Map(own.filter(r => String(r.day) >= start).map(r => [String(r.day), r]))
    const pts = [...byDay.values()].map(r => ({ i: daysBetween(start, String(r.day)), v: Number(r.followers), est: r.estimated === true }))
    const sollStart = String(target.base_date) > start ? target.base_date : start
    const sollPts = sollStart <= end ? [sollStart, end].map(d => ({ i: daysBetween(start, d), v: soll(d) })).filter((p): p is { i: number; v: number } => isNum(p.v)) : []
    const vals = [...pts.map(p => p.v), ...sollPts.map(p => p.v)]
    let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 10
    const pad = Math.max(5, (hi - lo) * 0.08)
    lo = Math.max(0, Math.floor((lo - pad) / 10) * 10); hi = Math.ceil((hi + pad) / 10) * 10
    if (hi <= lo) hi = lo + 10
    return { start, end, n, pts, sollPts, lo, hi, byDay, soll }
  }, [rows, platform, today, target])

  const x = (i: number) => PL + (i / model.n) * (W - PL - PR)
  const y = (v: number) => PT + (1 - (v - model.lo) / (model.hi - model.lo)) * (H - PT - PB)
  const line = model.pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const sollLine = model.sollPts.length === 2 ? `M${x(model.sollPts[0].i).toFixed(1)},${y(model.sollPts[0].v).toFixed(1)} L${x(model.sollPts[1].i).toFixed(1)},${y(model.sollPts[1].v).toFixed(1)}` : ''
  const ticks = [model.lo, Math.round((model.lo + model.hi) / 2), model.hi]
  const todayI = daysBetween(model.start, today)
  const last = model.pts[model.pts.length - 1]

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    const sx = ((e.clientX - box.left) / box.width) * W
    const i = Math.round(((sx - PL) / (W - PL - PR)) * model.n)
    setHover(Math.max(0, Math.min(model.n, i)))
  }
  const hDay = hover != null ? ymdAdd(model.start, hover) : null
  const hRow = hDay ? model.byDay.get(hDay) : undefined
  const hSoll = hDay ? model.soll(hDay) : null
  const label = platform === 'instagram' ? t('crm.social.grInstagram', 'Instagram') : t('crm.social.grFacebook', 'Facebook')

  return (
    <div className="relative">
      <p className="text-xs font-medium text-gray-700 mb-1">{label}</p>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img"
        aria-label={`${label}: ${t('crm.social.grChartAria', 'Follower pro Tag und Soll-Pfad bis 5.000')}`}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="#eef0f3" strokeWidth={1} />
            <text x={PL - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#9ca3af">{v.toLocaleString('de-DE')}</text>
          </g>
        ))}
        {todayI >= 0 && todayI <= model.n && (
          <line x1={x(todayI)} x2={x(todayI)} y1={PT} y2={H - PB} stroke="#d1d5db" strokeWidth={1} strokeDasharray="2 3" />
        )}
        <text x={PL} y={H - 6} fontSize={9} fill="#9ca3af">{ddmm(model.start)}</text>
        {todayI > 6 && todayI < model.n - 6 && <text x={x(todayI)} y={H - 6} fontSize={9} fill="#9ca3af" textAnchor="middle">{t('crm.social.grToday', 'heute')}</text>}
        <text x={W - PR} y={H - 6} fontSize={9} fill="#9ca3af" textAnchor="end">{ddmm(model.end)}</text>
        {sollLine && <path d={sollLine} fill="none" stroke={CORAL} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" />}
        {line && <path d={line} fill="none" stroke={NAVY} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {last && <circle cx={x(last.i)} cy={y(last.v)} r={3.5} fill={NAVY} stroke="#fff" strokeWidth={2} />}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={PT} y2={H - PB} stroke="#9ca3af" strokeWidth={1} />
            {hRow && isNum(hRow.followers) && <circle cx={x(hover)} cy={y(hRow.followers)} r={4} fill={NAVY} stroke="#fff" strokeWidth={2} />}
            {isNum(hSoll) && <circle cx={x(hover)} cy={y(hSoll)} r={3.5} fill={CORAL} stroke="#fff" strokeWidth={2} />}
          </g>
        )}
        <rect x={PL} y={0} width={W - PL - PR} height={H} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover != null && hDay && (
        <div className="pointer-events-none absolute top-5 z-10 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] shadow-sm"
          style={{ left: `${Math.min(70, Math.max(0, (x(hover) / W) * 100 - 10))}%` }}>
          <p className="font-medium text-gray-900">{ddmmyyyy(hDay)}</p>
          <p className="text-gray-700">{t('crm.social.grFollowers', 'Follower')}: {hRow && isNum(hRow.followers) ? fmtN(hRow.followers) : '-'}
            {hRow?.estimated ? <span className="text-gray-400"> ({t('crm.social.grEstimated', 'geschätzt')})</span> : null}</p>
          {isNum(hSoll) && <p className="text-gray-500">{t('crm.social.grTarget', 'Soll')}: {fmtN(hSoll)}</p>}
        </div>
      )}
    </div>
  )
}

// ── Karte ─────────────────────────────────────────────────────────────────────
export default function SocialGrowthPanel() {
  const { t } = useTranslation()
  const [st, setSt] = useState<GrowthStatus | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<boolean | null>(null)       // null = automatisch (zu, wenn keine Daten)
  const [rank, setRank] = useState<'shares' | 'watch'>('shares')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('social-growth', { body: { action: 'status' } })
      const d = (data && typeof data === 'object' ? data : {}) as GrowthStatus
      if (error || d.error) throw new Error(d.error || error?.message || 'Fehler')
      setSt(d); setErr('')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fehler') } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const rows = Array.isArray(st?.rows) ? st.rows : []
  const hasData = rows.some(r => isNum(r?.followers))
  const isOpen = open ?? hasData
  const today = validYmd(st?.today) ? st.today : new Date().toISOString().slice(0, 10)
  const tgt = {
    value: isNum(st?.target?.value) ? st.target.value : DEFAULT_TARGET.value,
    base_date: validYmd(st?.target?.base_date) ? st.target.base_date : DEFAULT_TARGET.base_date,
    end_date: validYmd(st?.target?.end_date) ? st.target.end_date : DEFAULT_TARGET.end_date,
  }
  const baseline = (p: Platform) => { const b = st?.target?.baseline?.[p]; return isNum(b) ? b : DEFAULT_TARGET.baseline[p] }
  const kpi = (p: Platform): GrowthKpi => (st?.kpis?.[p] && typeof st.kpis[p] === 'object' ? st.kpis[p] as GrowthKpi : {})
  const label = (p: Platform) => (p === 'instagram' ? t('crm.social.grInstagram', 'Instagram') : t('crm.social.grFacebook', 'Facebook'))
  const reelsRaw = rank === 'shares' ? st?.top_reels?.by_shares : st?.top_reels?.by_watch_time
  const reels = (Array.isArray(reelsRaw) ? reelsRaw : []).filter(r => r && typeof r === 'object').slice(0, 3)
  const lastAt = st?.last_run?.finished_at ?? st?.last_run?.at
  const lastAtTxt = typeof lastAt === 'string' && Number.isFinite(Date.parse(lastAt))
    ? new Date(lastAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  const runErrors = Array.isArray(st?.last_run?.errors) ? st.last_run.errors.filter(x => typeof x === 'string') : []

  const planBadge = (ok: unknown) => ok !== true && ok !== false
    ? <span className="text-[11px] text-gray-400">{t('crm.social.grTooFew', 'noch zu wenig Daten')}</span>
    : ok
      ? <span className="text-[11px] font-medium text-[#1a2332]">✓ {t('crm.social.grOnTrack', 'im Plan')}</span>
      : <span className="text-[11px] font-medium text-[#ff795d]">▼ {t('crm.social.grBelow', 'unter Plan')}</span>

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-4">
      <button type="button" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}
        className="w-full flex items-start justify-between gap-3 text-left">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900">📈 {t('crm.social.grTitle', 'Wachstum')}
            {!isOpen && hasData && (
              <span className="ml-2 text-xs font-normal text-gray-500">
                {PLATFORMS.map(p => `${label(p)} ${fmtN(kpi(p).current)}`).join(' · ')}
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500 mt-0.5 max-w-2xl">
            {t('crm.social.grSub', 'Ziel: {{target}} Follower je Plattform bis {{end}}. Nötiges Tempo: Instagram {{ig}}, Facebook {{fb}} neue Follower pro Monat.', {
              target: fmtN(tgt.value), end: ddmmyyyy(tgt.end_date),
              ig: fmtN(kpi('instagram').required_per_month ?? Math.round((tgt.value - baseline('instagram')) / 12)),
              fb: fmtN(kpi('facebook').required_per_month ?? Math.round((tgt.value - baseline('facebook')) / 12)),
            })}
          </p>
        </div>
        <span className={`text-gray-400 text-sm mt-0.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden>▾</span>
      </button>

      {isOpen && (<>
        {loading && !st && <p className="text-xs text-gray-400">{t('common.loading', 'lädt …')}</p>}
        {err && <p className="text-xs text-red-600">❌ {err}</p>}
        {!loading && !err && !hasData && (
          <p className="text-xs rounded-lg px-3 py-2 bg-gray-50 text-gray-600">{t('crm.social.grNoData', 'Noch keine Wachstumsdaten. Die Zahlen werden jeden Morgen automatisch bei Meta abgerufen.')}</p>
        )}

        {hasData && (<>
          {/* Kennzahlen je Plattform */}
          <div className="grid gap-3 sm:grid-cols-2">
            {PLATFORMS.map(p => {
              const k = kpi(p)
              return (
                <div key={p} className="rounded-xl border border-gray-100 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium text-gray-500">{label(p)}</p>
                    {planBadge(k.on_track)}
                  </div>
                  <p className="mt-1 text-2xl font-semibold text-[#1a2332] tabular-nums">{fmtN(k.current)}
                    <span className="ml-1 text-xs font-normal text-gray-500">{t('crm.social.grFollowers', 'Follower')}</span></p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-gray-500">{t('crm.social.grNet7', 'Netto 7 Tage')}</p>
                      <p className="font-medium text-gray-900 tabular-nums">{signed(k.net_7d)}
                        <span className="font-normal text-gray-400"> / {t('crm.social.grTarget', 'Soll')} {signed(k.required_7d)}</span></p>
                    </div>
                    <div>
                      <p className="text-gray-500">{t('crm.social.grNet28', 'Netto 28 Tage')}</p>
                      <p className="font-medium text-gray-900 tabular-nums">{signed(k.net_28d)}
                        <span className="font-normal text-gray-400"> / {t('crm.social.grTarget', 'Soll')} {signed(k.required_28d)}</span></p>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] text-gray-500">
                    {t('crm.social.grPace', 'Tempo: {{actual}} statt {{need}} pro Monat', { actual: fmtN(k.actual_per_month), need: fmtN(k.required_per_month) })}
                    {isNum(k.projected_end) && <> · {t('crm.social.grProjected', 'so am {{date}}: {{n}}', { date: ddmmyyyy(tgt.end_date), n: fmtN(k.projected_end) })}</>}
                    {(k.net_7d_source === 'estimated' || k.net_28d_source === 'estimated') && <> · {t('crm.social.grEstimatedNote', 'ältere Tage geschätzt')}</>}
                  </p>
                </div>
              )
            })}
          </div>

          {/* Verlauf */}
          <div>
            <div className="flex items-center gap-4 text-[11px] text-gray-500 mb-1">
              <span className="inline-flex items-center gap-1.5"><svg width="18" height="6" aria-hidden><line x1="1" x2="17" y1="3" y2="3" stroke={NAVY} strokeWidth="2" strokeLinecap="round" /></svg>{t('crm.social.grLegendActual', 'Follower pro Tag')}</span>
              <span className="inline-flex items-center gap-1.5"><svg width="18" height="6" aria-hidden><line x1="1" x2="17" y1="3" y2="3" stroke={CORAL} strokeWidth="2" strokeDasharray="5 4" /></svg>{t('crm.social.grLegendTarget', 'Soll-Pfad bis {{target}}', { target: fmtN(tgt.value) })}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {PLATFORMS.map(p => (
                <FollowerChart key={p} platform={p} rows={rows} today={today} target={{ ...tgt, baseline: baseline(p) }} />
              ))}
            </div>
          </div>

          {/* Reichweite organisch vs. bezahlt */}
          <div>
            <p className="text-xs font-medium text-gray-700 mb-2">{t('crm.social.grReachTitle', 'Reichweite der letzten 28 Tage: organisch oder aus Anzeigen')}</p>
            <div className="space-y-2">
              {PLATFORMS.map(p => {
                const r = kpi(p).reach_28d ?? {}
                const org = isNum(r.organic) ? r.organic : 0, paid = isNum(r.paid) ? r.paid : 0
                const share = isNum(r.organic_share) ? Math.max(0, Math.min(1, r.organic_share)) : null
                return (
                  <div key={p} className="grid grid-cols-[72px_1fr] sm:grid-cols-[84px_1fr_auto] items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-gray-600">{label(p)}</span>
                    {share == null ? <span className="text-gray-400">{t('crm.social.grTooFew', 'noch zu wenig Daten')}</span> : (
                      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100" title={`${pct(share)} ${t('crm.social.grOrganic', 'organisch')}`}>
                        {share > 0 && <div className="h-full rounded-full bg-[#1a2332]" style={{ width: `${Math.max(2, share * 100)}%` }} />}
                        {share < 1 && <div className="h-full flex-1 rounded-full bg-gray-300 ml-0.5" />}
                      </div>
                    )}
                    <span className="col-start-2 sm:col-start-auto text-gray-500 tabular-nums">
                      {share != null && <>{pct(share)} {t('crm.social.grOrganic', 'organisch')} ({fmtN(org)}) · {pct(1 - share)} {t('crm.social.grPaid', 'bezahlt')} ({fmtN(paid)})</>}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Top-Reels */}
          <div>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <p className="text-xs font-medium text-gray-700">🎬 {t('crm.social.grTopReels', 'Top 3 Reels')}</p>
              <div className="flex gap-1 rounded-lg bg-gray-100 p-0.5">
                {(['shares', 'watch'] as const).map(k => (
                  <button key={k} type="button" onClick={() => setRank(k)}
                    className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${rank === k ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}>
                    {k === 'shares' ? t('crm.social.grByShares', 'nach Teilen') : t('crm.social.grByWatch', 'nach Wiedergabezeit')}
                  </button>
                ))}
              </div>
            </div>
            {reels.length === 0 ? <p className="text-xs text-gray-400">{t('crm.social.grNoReels', 'Noch keine Reel-Werte.')}</p> : (
              <ol className="space-y-1.5">
                {reels.map((r, i) => {
                  const cap = String(r.caption ?? '').replace(/\s+/g, ' ').trim() || t('crm.social.grReelNoText', 'Reel ohne Text')
                  const plat: Platform = r.platform === 'facebook' ? 'facebook' : 'instagram'
                  const date = typeof r.published_at === 'string' && validYmd(r.published_at.slice(0, 10)) ? ddmm(r.published_at.slice(0, 10)) : ''
                  const href = typeof r.permalink === 'string' && /^https:\/\//.test(r.permalink) ? r.permalink : null
                  return (
                    <li key={`${r.post_ref ?? i}-${i}`} className="flex items-start gap-2 text-xs">
                      <span className="mt-0.5 w-4 shrink-0 text-right font-semibold text-gray-400 tabular-nums">{i + 1}.</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-gray-900">
                          {href ? <a href={href} target="_blank" rel="noreferrer" className="hover:underline">{cap}</a> : cap}
                        </p>
                        <p className="text-gray-500 tabular-nums">
                          {label(plat)}{date ? ` ${date}` : ''} · {fmtN(r.reach)} {t('crm.social.grReached', 'erreicht')} · {fmtN(r.shares)} {t('crm.social.grShared', 'geteilt')} · Ø {secs(r.avg_watch_time_ms)}
                          {r.backfill ? <span className="text-gray-400"> · {t('crm.social.grOlder', 'älter, Stand heute')}</span> : null}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          <p className="text-[11px] text-gray-400">
            {lastAtTxt ? t('crm.social.grAsOf', 'Stand {{when}}, Abruf jeden Morgen automatisch.', { when: lastAtTxt }) : null}
            {runErrors.length > 0 && <span className="ml-1 text-amber-600" title={runErrors.join('\n')}>⚠ {t('crm.social.grRunWarnings', '{{n}} Hinweise beim letzten Abruf', { n: runErrors.length })}</span>}
          </p>
        </>)}
      </>)}
    </div>
  )
}
