// social-growth: Wachstums-Tracking Instagram + Facebook.
// Ziel: 5.000 Follower je Plattform in 12 Monaten (Start 26.09.2026: Instagram 364, Facebook 139).
//
// Aktionen (POST, JSON):
//   snapshot       {wait?, backfill?}  Cron täglich 03:30 UTC (vor dem Wochenbericht). Follower-Stand, Follows/Unfollows,
//                  Reichweite (organisch/bezahlt), Profilaufrufe, Link-Klicks je Meta-Tag
//                  (Pacific Time, so zählt Meta) + Kennzahlen je Post nach 24h/72h/7d/28d.
//                  Beim ersten Lauf (oder backfill:true) werden die letzten 30 Tage nachgeladen.
//   status         {}                  Letzte 60 Tage, letzte Post-Werte, berechnete Kennzahlen
//                  (für die Karte „Wachstum" im Social-Studio).
//   weekly_report  {dry_run?}          Cron montags 04:00 UTC (07:00 Zypern): kurze Mail an Sven.
//                  dry_run = nichts senden, HTML zurückgeben.
//
// Auth: Header x-cron-secret = connector_secrets CRON_SECRET_SOCIAL, oder Bearer =
// Service-Role-Key (alle Aktionen). Eingeloggtes Team (admin/verwalter, Rolle funnel
// oder Mitarbeiter mit Recht funnel, wie social-agent) nur für status.
//
// Meta: nur lesende GET-Aufrufe. Zugang connector_secrets META_ACCESS_TOKEN (System-User),
// Seiten-Token über /me/accounts. Tokens gehen nur im Authorization-Header raus und werden
// aus allem entfernt, was gespeichert oder zurückgegeben wird.
//
// Geprüft am 26.09.2026 (v21.0 und v23.0 liefern dasselbe):
//   IG Konto:  follower_count (Zeitreihe, nur Zugänge je Tag, 30 Tage), follows_and_unfollows
//              (total_value, breakdown follow_type: FOLLOWER = neu, NON_FOLLOWER = verloren),
//              reach (total_value, breakdown media_product_type: AD = bezahlt), profile_views,
//              website_clicks (= Link in der Bio), profile_links_taps, views.
//   IG Post:   reach, views, saved, shares, total_interactions, likes, comments; Reels zusätzlich
//              ig_reels_avg_watch_time; follows/profile_visits NUR bei Feed-Posts (bei Reels #100).
//   FB Seite:  page_follows, page_daily_follows_unique, page_daily_unfollows_unique,
//              page_total_media_view_unique (Reichweite), page_views_total, page_media_view mit
//              breakdown is_from_ads. page_impressions* und page_fan_adds* gibt es nicht mehr.
//   FB Post:   post_media_view, post_total_media_view_unique, post_clicks (period lifetime);
//              Videos/Reels über video_insights (post_video_avg_time_watched, fb_reels_total_plays,
//              post_impressions_unique, post_video_followers).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Pflicht), HEALTH_REPORT_TO (optional,
// Empfänger wie beim nächtlichen Systemcheck, Standard sven@happy-property.com).
// Deploy: supabase functions deploy social-growth --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { CI } from '../_shared/brand.ts'

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

// ── Zugangsdaten nie speichern oder zurückgeben ───────────────────────────────
const TOKEN_PARAM_RE = /access_token=[^&\s)"\\]+/g
const RAW_TOKEN_RE = /\bEAA[A-Za-z0-9]{30,}/g
export function redact(s: unknown): string {
  return String(s ?? '').replace(TOKEN_PARAM_RE, 'access_token=[entfernt]').replace(RAW_TOKEN_RE, '[entfernt]')
}
const redactReplacer = (_k: string, v: unknown) => (typeof v === 'string' ? redact(v) : v)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, redactReplacer), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const G = 'https://graph.facebook.com/v21.0'
const PAGE_ID = '556440087559971'
const IG_ID = '17841470217959724'
const PT = 'America/Los_Angeles'                 // Meta-Tage laufen in Pacific Time

// Ziel + Startwerte (26.09.2026)
const TARGET = 5000
const BASE_DATE = '2026-09-26'
const END_DATE = '2027-09-26'
const BASELINE: Record<Platform, number> = { instagram: 364, facebook: 139 }
const DAY_MS = 86400000

type Platform = 'instagram' | 'facebook'
type Snap = '24h' | '72h' | '7d' | '28d'
// Fenster je Snapshot: ab from_h fällig, bis to_h noch aussagekräftig (Cron läuft täglich).
const SNAPS: Array<{ key: Snap; from_h: number; to_h: number }> = [
  { key: '24h', from_h: 24, to_h: 72 },
  { key: '72h', from_h: 72, to_h: 168 },
  { key: '7d', from_h: 168, to_h: 336 },
  { key: '28d', from_h: 672, to_h: 744 },
]
const SNAP_ORDER: Record<string, number> = { '24h': 1, '72h': 2, '7d': 3, '28d': 4 }
const POST_WINDOW_DAYS = 31
const REEL_BACKFILL_DAYS = 120                   // erster Lauf: ältere Reels einmalig als Vergleichswert

// ── Datum (Pacific Time) ──────────────────────────────────────────────────────
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' })
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: '2-digit', hourCycle: 'h23' })
const ptYmd = (ms: number) => ymdFmt.format(new Date(ms))
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
export function ptMidnight(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  for (const h of [7, 8]) {
    const t = Date.UTC(y, m - 1, d, h)
    if (Number(hourFmt.format(new Date(t))) === 0 && ptYmd(t) === ymd) return t
  }
  return Date.UTC(y, m - 1, d, 8)
}
const unix = (ms: number) => String(Math.floor(ms / 1000))
// Zeitreihen-Wert mit end_time gehört zum Meta-Tag davor
const dayOfEnd = (endTime: string) => ptYmd(Date.parse(endTime) - 12 * 3600000)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS)

// ── Hilfen ────────────────────────────────────────────────────────────────────
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n) : null
}
async function setting(sb: SupabaseClient, key: string): Promise<Record<string, unknown>> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', key).maybeSingle()
  try { return JSON.parse((data as { value?: string } | null)?.value ?? '{}') as Record<string, unknown> } catch { return {} }
}
async function saveSetting(sb: SupabaseClient, key: string, value: unknown): Promise<void> {
  const { error } = await sb.from('crm_settings').upsert({ key, value: JSON.stringify(value, redactReplacer), updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) console.error(`[social-growth] ${key} speichern:`, error.message)
}
async function secret(sb: SupabaseClient, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return String((data as { value?: string } | null)?.value ?? Deno.env.get(key) ?? '').trim()
}
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// 'system' = Cron/Service-Role (alles), 'staff' = eingeloggtes Team (nur status)
async function whoIs(sb: SupabaseClient, req: Request): Promise<'system' | 'staff' | null> {
  const cron = (req.headers.get('x-cron-secret') ?? '').trim()
  if (cron) return sameSecret(cron, await secret(sb, 'CRON_SECRET_SOCIAL')) ? 'system' : null
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!bearer) return null
  const srk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (srk && sameSecret(bearer, srk)) return 'system'
  const { data } = await sb.auth.getUser(bearer)
  const uid = data?.user?.id
  if (!uid) return null
  const { data: prof } = await sb.from('profiles').select('role, permissions').eq('id', uid).maybeSingle()
  const p = prof as { role?: string; permissions?: Record<string, unknown> | null } | null
  // wie social-agent (Social-Studio): Admin/Verwalter, Rolle funnel, Mitarbeiter mit Recht funnel
  if (p?.role === 'admin' || p?.role === 'verwalter' || p?.role === 'funnel') return 'staff'
  return p?.role === 'mitarbeiter' && !!p.permissions?.funnel ? 'staff' : null
}

// ── Meta Graph (nur GET) ──────────────────────────────────────────────────────
interface GErr { message?: string; code?: number; error_subcode?: number; http?: number }
async function gGet<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T & { error?: GErr }> {
  const u = new URL(`${G}/${path.replace(/^\//, '')}`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  try {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) })
    const d = await r.json().catch(() => null) as (T & { error?: GErr }) | null
    if (!d) return { error: { message: `HTTP ${r.status}`, http: r.status } } as T & { error?: GErr }
    if (d.error) { d.error.http = r.status; d.error.message = redact(d.error.message) }
    return d
  } catch (e) {
    return { error: { message: redact(e instanceof Error ? e.message : String(e)), code: 2 } } as T & { error?: GErr }
  }
}
const errText = (e: GErr | undefined) => redact(`${e?.message ?? 'unbekannt'}${e?.code ? ` [#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}]` : ''}`).slice(0, 220)

interface Meta { pageToken: string; igId: string }
async function metaAccess(sb: SupabaseClient): Promise<Meta | { error: string }> {
  const sysToken = await secret(sb, 'META_ACCESS_TOKEN')
  if (!sysToken) return { error: 'META_ACCESS_TOKEN fehlt' }
  const acc = await gGet<{ data?: Array<{ id: string; access_token: string; instagram_business_account?: { id: string } }> }>('me/accounts', sysToken, { fields: 'id,access_token,instagram_business_account' })
  if (acc.error) return { error: `Meta-Zugang: ${errText(acc.error)}` }
  const page = (acc.data ?? []).find(p => p.id === PAGE_ID)
  if (!page?.access_token) return { error: 'Facebook-Seite nicht im Meta-Zugang gefunden' }
  return { pageToken: page.access_token, igId: page.instagram_business_account?.id ?? IG_ID }
}

// Parallel, aber gedrosselt (Meta-Limits)
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

// ── Typen ─────────────────────────────────────────────────────────────────────
interface AccRow {
  day: string; platform: Platform; followers: number | null; follows: number | null; unfollows: number | null
  reach: number | null; reach_organic: number | null; reach_paid: number | null; profile_views: number | null
  link_taps: number | null; raw: Record<string, unknown>; updated_at?: string
}
interface PostRow {
  post_ref: string; platform: Platform; social_post_id: string | null; published_at: string | null; media_type: string | null
  snapshot: Snap; reach: number | null; views: number | null; avg_watch_time_ms: number | null; shares: number | null
  saves: number | null; comments: number | null; likes: number | null; follows: number | null; profile_visits: number | null
  raw: Record<string, unknown>; taken_at?: string
}
interface SnapSummary {
  at: string; finished_at?: string; backfill: boolean; days: string[]
  followers: Partial<Record<Platform, number | null>>; account_rows: number
  posts: { checked: number; saved: number; ig: number; fb: number }
  unsupported: string[]; errors: string[]
}

// ── Snapshot ──────────────────────────────────────────────────────────────────
async function snapshot(sb: SupabaseClient, forceBackfill: boolean): Promise<SnapSummary> {
  const now = Date.now()
  const today = ptYmd(now)
  const sum: SnapSummary = { at: new Date(now).toISOString(), backfill: false, days: [], followers: {}, account_rows: 0, posts: { checked: 0, saved: 0, ig: 0, fb: 0 }, unsupported: [], errors: [] }
  const err = (t: string) => { const x = redact(t).slice(0, 300); if (!sum.errors.includes(x) && sum.errors.length < 25) sum.errors.push(x) }

  const meta = await metaAccess(sb)
  if ('error' in meta) { err(meta.error); return sum }
  const tok = meta.pageToken

  // Erster Lauf: Tabelle für Instagram fast leer → 30 Tage nachladen
  const { count: igRows } = await sb.from('social_account_daily').select('day', { count: 'exact', head: true })
    .eq('platform', 'instagram').gte('day', addDays(today, -35)).not('followers', 'is', null)
  const backfill = forceBackfill || (igRows ?? 0) < 20
  sum.backfill = backfill
  const nDays = backfill ? 29 : 3                  // vollständige Meta-Tage, die (neu) abgefragt werden
  const days = Array.from({ length: nDays }, (_, i) => addDays(today, -(i + 1)))
  sum.days = [days[days.length - 1], days[0]]
  const seriesSince = ptMidnight(addDays(today, backfill ? -30 : -6))

  // Bestehende Zeilen laden (raw zusammenführen, echte Werte nicht überschreiben)
  const minDay = addDays(today, -32)
  const { data: existing } = await sb.from('social_account_daily').select('*').gte('day', minDay)
  const rows = new Map<string, AccRow>()
  for (const r of (existing ?? []) as AccRow[]) rows.set(`${r.platform}|${r.day}`, { ...r, raw: (r.raw && typeof r.raw === 'object') ? r.raw : {} })
  const touched = new Set<string>()
  const row = (platform: Platform, day: string): AccRow => {
    const k = `${platform}|${day}`
    let r = rows.get(k)
    if (!r) {
      r = { day, platform, followers: null, follows: null, unfollows: null, reach: null, reach_organic: null, reach_paid: null, profile_views: null, link_taps: null, raw: {} }
      rows.set(k, r)
    }
    touched.add(k)
    return r
  }
  // Nur echte Zahlen setzen (fehlende Meta-Werte überschreiben nichts)
  const put = (r: AccRow, f: Partial<Omit<AccRow, 'day' | 'platform' | 'raw'>>, raw: Record<string, unknown> = {}) => {
    for (const [k, v] of Object.entries(f)) if (typeof v === 'number' && Number.isFinite(v)) (r as unknown as Record<string, unknown>)[k] = v
    for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) r.raw[k] = v
  }
  const canSetFollowers = (r: AccRow) => r.followers == null || r.raw.followers_source !== 'snapshot'
  const unsupported = new Set<string>()

  // ── Instagram ───────────────────────────────────────────────────────────────
  try {
    const acc = await gGet<{ followers_count?: number; follows_count?: number; media_count?: number }>(meta.igId, tok, { fields: 'followers_count,follows_count,media_count' })
    if (acc.error) err(`Instagram Konto: ${errText(acc.error)}`)
    const igNow = num(acc.followers_count)
    sum.followers.instagram = igNow
    if (igNow != null) put(row('instagram', today), { followers: igNow }, { followers_source: 'snapshot', followers_at: new Date(now).toISOString(), followers_estimated: false, following: num(acc.follows_count), media_count: num(acc.media_count) })

    // follower_count = neue Follower je Tag. Meta erlaubt höchstens 30 Tage zwischen since und
    // until: ab Mitternacht vor 29 Tagen (Pacific Time) bis jetzt bleibt immer darunter.
    const fcSince = backfill ? ptMidnight(addDays(today, -29)) : seriesSince
    const fc = await gGet<{ data?: Array<{ name: string; values?: Array<{ value: unknown; end_time: string }> }> }>(`${meta.igId}/insights`, tok,
      { metric: 'follower_count', period: 'day', since: unix(fcSince), until: unix(now) })
    if (fc.error) err(`Instagram follower_count: ${errText(fc.error)}`)
    const gains = new Map<string, number>()
    for (const v of fc.data?.[0]?.values ?? []) {
      const d = dayOfEnd(v.end_time), n = num(v.value)
      if (n == null || d > today) continue
      gains.set(d, n)
      put(row('instagram', d), {}, { follower_gain: n })
    }

    // Tageswerte (total_value, je Meta-Tag ein Fenster)
    type TV = { data?: Array<{ name: string; total_value?: { value?: unknown; breakdowns?: Array<{ results?: Array<{ dimension_values?: string[]; value?: unknown }> }> } }> }
    const tv = async (day: string, metrics: string[], extra: Record<string, string> = {}): Promise<TV['data']> => {
      const since = ptMidnight(day), until = ptMidnight(addDays(day, 1))
      const want = metrics.filter(m => !unsupported.has(`ig:${m}`))
      if (!want.length) return []
      const r = await gGet<TV>(`${meta.igId}/insights`, tok, { metric: want.join(','), period: 'day', metric_type: 'total_value', since: unix(since), until: unix(until), ...extra })
      if (!r.error) return r.data ?? []
      if (r.error.code === 100 && want.length > 1) {        // eine Kennzahl abgekündigt → einzeln abfragen
        const out: NonNullable<TV['data']> = []
        for (const m of want) {
          const one = await gGet<TV>(`${meta.igId}/insights`, tok, { metric: m, period: 'day', metric_type: 'total_value', since: unix(since), until: unix(until), ...extra })
          if (one.error) { if (one.error.code === 100) unsupported.add(`ig:${m}`); else err(`Instagram ${m} ${day}: ${errText(one.error)}`) }
          else out.push(...(one.data ?? []))
        }
        return out
      }
      if (r.error.code === 100) unsupported.add(`ig:${want[0]}`)
      else err(`Instagram ${want.join(',')} ${day}: ${errText(r.error)}`)
      return []
    }
    const results = (d: TV['data'], name: string) => d?.find(x => x.name === name)?.total_value?.breakdowns?.[0]?.results ?? null
    await pool(days, 4, async (day) => {
      const r = row('instagram', day)
      const [reach, fu, prof] = await Promise.all([
        tv(day, ['reach'], { breakdown: 'media_product_type' }),
        tv(day, ['follows_and_unfollows'], { breakdown: 'follow_type' }),
        tv(day, ['profile_views', 'website_clicks', 'profile_links_taps', 'views']),
      ])
      const reachTotal = num(reach?.find(x => x.name === 'reach')?.total_value?.value)
      const byType = results(reach, 'reach')
      if (reachTotal != null) {
        const types: Record<string, number> = {}
        for (const b of byType ?? []) { const k = String(b.dimension_values?.[0] ?? '?'); const v = num(b.value); if (v != null) types[k] = v }
        const paid = types.AD ?? 0
        const organicSum = Object.entries(types).filter(([k]) => k !== 'AD').reduce((a, [, v]) => a + v, 0)
        const organic = Math.min(organicSum, Math.max(0, reachTotal))
        put(r, { reach: reachTotal, ...(byType ? { reach_paid: Math.min(paid, reachTotal), reach_organic: organic } : {}) }, { reach_by_type: types })
      }
      const fuRes = results(fu, 'follows_and_unfollows')
      if (fuRes && fuRes.length) {
        const get = (k: string) => num(fuRes.find(x => x.dimension_values?.[0] === k)?.value) ?? 0
        put(r, { follows: get('FOLLOWER'), unfollows: get('NON_FOLLOWER') })
      }
      const val = (n: string) => num(prof?.find(x => x.name === n)?.total_value?.value)
      put(r, { profile_views: val('profile_views') ?? undefined, link_taps: val('website_clicks') ?? undefined }, { profile_links_taps: val('profile_links_taps'), views: val('views') })
      r.raw.metrics_at = new Date().toISOString()
    })

    // Rückwirkend geschätzter Stand: heutiger Stand minus Netto-Zuwachs der Tage danach.
    // Netto = Follows minus Unfollows (follows_and_unfollows); fehlt das, nur Zugänge (follower_count).
    if (backfill && igNow != null) {
      let after = 0
      for (let i = 0; i <= 30; i++) {
        const d = addDays(today, -i)
        const r = row('instagram', d)
        if (i > 0 && canSetFollowers(r)) {
          put(r, { followers: Math.max(0, igNow - after) }, { followers_source: 'estimate', followers_estimated: true })
        }
        after += r.follows != null && r.unfollows != null ? r.follows - r.unfollows : (gains.get(d) ?? 0)
      }
    }
  } catch (e) { err(`Instagram: ${e instanceof Error ? e.message : String(e)}`) }

  // ── Facebook ────────────────────────────────────────────────────────────────
  try {
    const acc = await gGet<{ followers_count?: number; fan_count?: number }>(PAGE_ID, tok, { fields: 'followers_count,fan_count' })
    if (acc.error) err(`Facebook Seite: ${errText(acc.error)}`)
    const fbNow = num(acc.followers_count)
    sum.followers.facebook = fbNow
    if (fbNow != null) put(row('facebook', today), { followers: fbNow }, { followers_source: 'snapshot', followers_at: new Date(now).toISOString(), followers_estimated: false, fans: num(acc.fan_count) })

    type TS = { data?: Array<{ name: string; values?: Array<{ value: unknown; end_time: string; start_time?: string; is_from_ads?: string }> }> }
    const ts = async (metrics: string[], extra: Record<string, string> = {}): Promise<NonNullable<TS['data']>> => {
      const want = metrics.filter(m => !unsupported.has(`fb:${m}`))
      const base = { period: 'day', since: unix(seriesSince), until: unix(now), ...extra }
      const r = await gGet<TS>(`${PAGE_ID}/insights`, tok, { metric: want.join(','), ...base })
      if (!r.error) return r.data ?? []
      if (r.error.code === 100) {
        const out: NonNullable<TS['data']> = []
        for (const m of want) {
          const one = await gGet<TS>(`${PAGE_ID}/insights`, tok, { metric: m, ...base })
          if (one.error) { if (one.error.code === 100) unsupported.add(`fb:${m}`); else err(`Facebook ${m}: ${errText(one.error)}`) }
          else out.push(...(one.data ?? []))
        }
        return out
      }
      err(`Facebook ${want.join(',')}: ${errText(r.error)}`)
      return []
    }
    const series = await ts(['page_follows', 'page_daily_follows_unique', 'page_daily_unfollows_unique', 'page_total_media_view_unique', 'page_views_total'])
    const complete = (d: string) => d < today && d >= addDays(today, backfill ? -30 : -6)
    for (const m of series) {
      for (const v of m.values ?? []) {
        const d = v.start_time ? ptYmd(Date.parse(v.start_time) + 3600000) : dayOfEnd(v.end_time)
        const n = num(v.value)
        if (n == null || !complete(d)) continue
        const r = row('facebook', d)
        if (m.name === 'page_follows') { if (canSetFollowers(r)) put(r, { followers: n }, { followers_source: 'page_follows', followers_estimated: false }) }
        else if (m.name === 'page_daily_follows_unique') put(r, { follows: n })
        else if (m.name === 'page_daily_unfollows_unique') put(r, { unfollows: n })
        else if (m.name === 'page_total_media_view_unique') put(r, { reach: n })
        else if (m.name === 'page_views_total') put(r, { profile_views: n })
      }
    }
    // Aufrufe organisch/bezahlt → Reichweite im selben Verhältnis aufteilen
    const views = await ts(['page_media_view'], { breakdown: 'is_from_ads' })
    const split = new Map<string, { ads: number; org: number }>()
    for (const v of views.find(x => x.name === 'page_media_view')?.values ?? []) {
      const d = v.start_time ? ptYmd(Date.parse(v.start_time) + 3600000) : dayOfEnd(v.end_time)
      const n = num(v.value)
      if (n == null || !complete(d)) continue
      const s = split.get(d) ?? { ads: 0, org: 0 }
      if (String(v.is_from_ads) === '1') s.ads += n; else s.org += n
      split.set(d, s)
    }
    for (const [d, s] of split) {
      const r = row('facebook', d)
      const total = s.ads + s.org
      put(r, {}, { views: total, views_ads: s.ads, views_organic: s.org, reach_split: 'views_ratio' })
      if (r.reach != null && total > 0) {
        const paid = Math.round(r.reach * s.ads / total)
        put(r, { reach_paid: paid, reach_organic: r.reach - paid })
      }
      r.raw.metrics_at = new Date().toISOString()
    }
  } catch (e) { err(`Facebook: ${e instanceof Error ? e.message : String(e)}`) }

  // Speichern (volle Zeilen, damit nichts auf NULL fällt)
  const toSave = [...touched].map(k => rows.get(k)!).map(r => ({
    day: r.day, platform: r.platform, followers: r.followers, follows: r.follows, unfollows: r.unfollows, reach: r.reach,
    reach_organic: r.reach_organic, reach_paid: r.reach_paid, profile_views: r.profile_views, link_taps: r.link_taps,
    raw: r.raw, updated_at: new Date().toISOString(),
  }))
  if (toSave.length) {
    const { error } = await sb.from('social_account_daily').upsert(toSave, { onConflict: 'day,platform' })
    if (error) err(`Speichern Tageswerte: ${error.message}`)
    else sum.account_rows = toSave.length
  }

  // ── Posts ──────────────────────────────────────────────────────────────────
  try { await postSnapshots(sb, meta, now, backfill, sum, err) } catch (e) { err(`Posts: ${e instanceof Error ? e.message : String(e)}`) }

  sum.unsupported = [...unsupported]
  sum.finished_at = new Date().toISOString()
  return sum
}

// Welche Snapshots sind für ein Alter fällig (und noch aussagekräftig)?
export function dueSnaps(ageH: number, have: Set<string>): Snap[] {
  return SNAPS.filter(s => ageH >= s.from_h && ageH < s.to_h && !have.has(s.key)).map(s => s.key)
}

async function postSnapshots(sb: SupabaseClient, meta: Meta, now: number, backfill: boolean, sum: SnapSummary, err: (t: string) => void): Promise<void> {
  const tok = meta.pageToken
  const oldest = now - (backfill ? REEL_BACKFILL_DAYS : POST_WINDOW_DAYS) * DAY_MS

  // Zuordnung zu social_posts (post_results.instagram.id / facebook.id)
  const { data: sp } = await sb.from('social_posts').select('id, post_results').gte('posted_at', new Date(oldest - 3 * DAY_MS).toISOString()).limit(1000)
  const byRef = new Map<string, string>()
  for (const p of (sp ?? []) as Array<{ id: string; post_results: Record<string, { id?: string }> | null }>) {
    for (const k of ['instagram', 'facebook']) { const id = p.post_results?.[k]?.id; if (id) byRef.set(String(id), p.id) }
  }

  interface Cand { ref: string; platform: Platform; at: number; mediaType: string; reel: boolean; caption: string; permalink: string | null; videoId?: string | null; likes?: number | null; comments?: number | null; shares?: number | null; social_post_id: string | null }
  const cands: Cand[] = []

  const ig = await gGet<{ data?: Array<{ id: string; media_type?: string; media_product_type?: string; timestamp?: string; like_count?: number; comments_count?: number; permalink?: string; caption?: string }> }>(`${meta.igId}/media`, tok,
    { fields: 'id,media_type,media_product_type,timestamp,like_count,comments_count,permalink,caption', limit: '60' })
  if (ig.error) err(`Instagram Posts: ${errText(ig.error)}`)
  for (const m of ig.data ?? []) {
    const at = Date.parse(m.timestamp ?? '')
    if (!Number.isFinite(at) || at < oldest) continue
    const reel = m.media_product_type === 'REELS'
    if (!reel && at < now - POST_WINDOW_DAYS * DAY_MS) continue
    cands.push({ ref: m.id, platform: 'instagram', at, mediaType: reel ? 'REELS' : (m.media_type ?? 'IMAGE'), reel, caption: String(m.caption ?? '').slice(0, 160), permalink: m.permalink ?? null, likes: num(m.like_count), comments: num(m.comments_count), social_post_id: byRef.get(m.id) ?? null })
  }

  const fb = await gGet<{ data?: Array<{ id: string; created_time?: string; status_type?: string; permalink_url?: string; message?: string; shares?: { count?: number }; comments?: { summary?: { total_count?: number } }; reactions?: { summary?: { total_count?: number } }; attachments?: { data?: Array<{ media_type?: string; type?: string; target?: { id?: string; url?: string } }> } }> }>(`${PAGE_ID}/published_posts`, tok,
    { fields: 'id,created_time,status_type,permalink_url,message,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0),attachments{media_type,type,target}', since: unix(oldest), limit: '60' })
  if (fb.error) err(`Facebook Posts: ${errText(fb.error)}`)
  for (const p of fb.data ?? []) {
    const at = Date.parse(p.created_time ?? '')
    if (!Number.isFinite(at) || at < oldest) continue
    const att = p.attachments?.data?.[0]
    const isVideo = /video/.test(String(att?.type ?? '')) || /video/.test(String(att?.media_type ?? '')) || p.status_type === 'added_video'
    const reel = isVideo && /\/reel\//.test(String(att?.target?.url ?? ''))
    if (!reel && at < now - POST_WINDOW_DAYS * DAY_MS) continue
    const videoId = isVideo ? (att?.target?.id ?? null) : null
    const mediaType = reel ? 'REELS' : isVideo ? 'VIDEO' : att?.type === 'album' ? 'CAROUSEL_ALBUM' : /photo/.test(String(att?.type ?? '')) ? 'IMAGE' : 'TEXT'
    cands.push({ ref: p.id, platform: 'facebook', at, mediaType, reel, caption: String(p.message ?? '').slice(0, 160), permalink: p.permalink_url ?? null, videoId,
      likes: num(p.reactions?.summary?.total_count), comments: num(p.comments?.summary?.total_count), shares: num(p.shares?.count) ?? 0,
      social_post_id: byRef.get(p.id) ?? (videoId ? byRef.get(videoId) ?? null : null) })
  }

  const refs = cands.map(c => c.ref)
  const have = new Map<string, Set<string>>()
  if (refs.length) {
    const { data: ex } = await sb.from('social_post_metrics').select('post_ref, snapshot').in('post_ref', refs)
    for (const r of (ex ?? []) as Array<{ post_ref: string; snapshot: string }>) { const s = have.get(r.post_ref) ?? new Set(); s.add(r.snapshot); have.set(r.post_ref, s) }
  }

  const out: PostRow[] = []
  const todo = cands.map(c => {
    const ageH = (now - c.at) / 3600000
    let snaps = dueSnaps(ageH, have.get(c.ref) ?? new Set())
    // Erster Lauf: ältere Reels einmal als Vergleichswert (Stand heute, als 28d markiert)
    const late = backfill && c.reel && ageH >= 744 && !(have.get(c.ref)?.has('28d'))
    if (late) snaps = ['28d']
    return { c, ageH, snaps, late }
  }).filter(x => x.snaps.length)
  sum.posts.checked = cands.length

  type IN = { data?: Array<{ name: string; period?: string; values?: Array<{ value: unknown }> }> }
  const REEL_M = ['reach', 'views', 'saved', 'shares', 'total_interactions', 'ig_reels_avg_watch_time', 'likes', 'comments']
  const FEED_M = ['reach', 'views', 'saved', 'shares', 'total_interactions', 'likes', 'comments', 'follows', 'profile_visits']
  const BASIC_M = ['reach', 'views', 'saved', 'shares', 'likes', 'comments']

  await pool(todo, 4, async ({ c, ageH, snaps, late }) => {
    const m: Record<string, number | null> = {}
    const raw: Record<string, unknown> = { caption: c.caption, permalink: c.permalink, age_h: Math.round(ageH), ...(late ? { backfill: true } : {}) }
    if (c.platform === 'instagram') {
      let r = await gGet<IN>(`${c.ref}/insights`, tok, { metric: (c.reel ? REEL_M : FEED_M).join(',') })
      if (r.error?.code === 100) { raw.metrics_fallback = true; r = await gGet<IN>(`${c.ref}/insights`, tok, { metric: BASIC_M.join(',') }) }
      if (r.error) { err(`Instagram Post ${c.ref}: ${errText(r.error)}`); return }
      for (const d of r.data ?? []) m[d.name] = num(d.values?.[0]?.value)
      raw.total_interactions = m.total_interactions ?? null
      for (const s of snaps) out.push({
        post_ref: c.ref, platform: 'instagram', social_post_id: c.social_post_id, published_at: new Date(c.at).toISOString(), media_type: c.mediaType, snapshot: s,
        reach: m.reach ?? null, views: m.views ?? null, avg_watch_time_ms: m.ig_reels_avg_watch_time ?? null, shares: m.shares ?? null, saves: m.saved ?? null,
        comments: m.comments ?? c.comments ?? null, likes: m.likes ?? c.likes ?? null, follows: m.follows ?? null, profile_visits: m.profile_visits ?? null, raw,
      })
    } else {
      const r = await gGet<IN>(`${c.ref}/insights`, tok, { metric: 'post_media_view,post_total_media_view_unique,post_clicks', period: 'lifetime' })
      if (r.error) err(`Facebook Post ${c.ref}: ${errText(r.error)}`)
      for (const d of r.data ?? []) m[d.name] = num(d.values?.[0]?.value)
      if (c.videoId) {
        const v = await gGet<IN>(`${c.videoId}/video_insights`, tok)
        if (v.error) err(`Facebook Video ${c.videoId}: ${errText(v.error)}`)
        for (const d of v.data ?? []) if (!d.period || d.period === 'lifetime') m[`v_${d.name}`] = num(d.values?.[0]?.value)
        raw.video_id = c.videoId
      }
      if (r.error && !c.videoId) return
      raw.clicks = m.post_clicks ?? null
      for (const s of snaps) out.push({
        post_ref: c.ref, platform: 'facebook', social_post_id: c.social_post_id, published_at: new Date(c.at).toISOString(), media_type: c.mediaType, snapshot: s,
        reach: m.post_total_media_view_unique ?? m.v_post_impressions_unique ?? null,
        views: m.v_fb_reels_total_plays ?? m.post_media_view ?? null,
        avg_watch_time_ms: m.v_post_video_avg_time_watched ?? null,
        shares: c.shares ?? null, saves: null, comments: c.comments ?? null, likes: c.likes ?? null,
        follows: m.v_post_video_followers ?? null, profile_visits: null, raw,
      })
    }
  })

  if (out.length) {
    const { error } = await sb.from('social_post_metrics').upsert(out.map(r => ({ ...r, taken_at: new Date().toISOString() })), { onConflict: 'post_ref,snapshot' })
    if (error) err(`Speichern Post-Werte: ${error.message}`)
    else {
      sum.posts.saved = out.length
      sum.posts.ig = out.filter(r => r.platform === 'instagram').length
      sum.posts.fb = out.filter(r => r.platform === 'facebook').length
    }
  }
}

// ── Kennzahlen ────────────────────────────────────────────────────────────────
interface DayRow { day: string; platform: Platform; followers: number | null; follows: number | null; unfollows: number | null; reach: number | null; reach_organic: number | null; reach_paid: number | null; profile_views: number | null; link_taps: number | null; estimated: boolean }
interface MetricRow { post_ref: string; platform: Platform; social_post_id: string | null; published_at: string | null; media_type: string | null; snapshot: string; reach: number | null; views: number | null; avg_watch_time_ms: number | null; shares: number | null; saves: number | null; comments: number | null; likes: number | null; follows: number | null; profile_visits: number | null; taken_at: string; caption: string | null; permalink: string | null; backfill: boolean; share_rate: number | null }

export function required(platform: Platform) {
  const gap = TARGET - BASELINE[platform]
  const perDay = gap / daysBetween(BASE_DATE, END_DATE)
  return { per_day: perDay, per_week: perDay * 7, per_month: gap / 12, per_28d: perDay * 28 }
}

export function kpisFor(platform: Platform, rows: DayRow[], today: string) {
  const own = rows.filter(r => r.platform === platform).sort((a, b) => a.day.localeCompare(b.day))
  const withF = own.filter(r => r.followers != null)
  const last = withF[withF.length - 1] ?? null
  const at = (day: string) => { let best: DayRow | null = null; for (const r of withF) if (r.day <= day) best = r; return best }
  const net = (n: number) => {
    if (!last) return { value: null as number | null, source: null as string | null }
    const from = at(addDays(last.day, -n))
    const span0 = from ? daysBetween(from.day, last.day) : 0
    if (from && span0 >= n - 1 && span0 <= n + 3) return { value: (last.followers ?? 0) - (from.followers ?? 0), source: from.estimated || last.estimated ? 'estimated' : 'followers' }
    const span = own.filter(r => r.day > addDays(last.day, -n) && r.day <= last.day && (r.follows != null || r.unfollows != null))
    if (span.length >= Math.min(n, 3)) return { value: span.reduce((a, r) => a + (r.follows ?? 0) - (r.unfollows ?? 0), 0), source: 'follows' }
    return { value: null, source: null }
  }
  const req = required(platform)
  const n7 = net(7), n28 = net(28)
  const perDayActual = n28.value != null ? n28.value / 28 : n7.value != null ? n7.value / 7 : null
  const daysLeft = Math.max(0, daysBetween(today, END_DATE))
  const current = last?.followers ?? null
  const targetToday = Math.round(BASELINE[platform] + req.per_day * Math.max(0, daysBetween(BASE_DATE, today)))
  const r28 = own.filter(r => r.day > addDays(today, -29) && r.day < today)
  const organic = r28.reduce((a, r) => a + (r.reach_organic ?? 0), 0)
  const paid = r28.reduce((a, r) => a + (r.reach_paid ?? 0), 0)
  return {
    current, current_day: last?.day ?? null, baseline: BASELINE[platform], target: TARGET, target_today: targetToday,
    gap_to_plan: current != null ? current - targetToday : null,
    net_7d: n7.value, net_7d_source: n7.source, net_28d: n28.value, net_28d_source: n28.source,
    required_per_month: Math.round(req.per_month), required_per_week: Math.round(req.per_week), required_7d: Math.round(req.per_week), required_28d: Math.round(req.per_28d),
    actual_per_month: perDayActual != null ? Math.round(perDayActual * 30.44) : null,
    on_track: perDayActual != null ? perDayActual >= req.per_day : null,
    projected_end: current != null && perDayActual != null ? Math.round(current + perDayActual * daysLeft) : null,
    reach_28d: { organic, paid, total: r28.reduce((a, r) => a + (r.reach ?? 0), 0), organic_share: organic + paid > 0 ? organic / (organic + paid) : null, days: r28.length },
    profile_views_28d: r28.reduce((a, r) => a + (r.profile_views ?? 0), 0),
    link_taps_28d: r28.reduce((a, r) => a + (r.link_taps ?? 0), 0),
  }
}

async function buildStatus(sb: SupabaseClient) {
  const today = ptYmd(Date.now())
  const { data: acc, error: aErr } = await sb.from('social_account_daily')
    .select('day, platform, followers, follows, unfollows, reach, reach_organic, reach_paid, profile_views, link_taps, raw')
    .gte('day', addDays(today, -60)).order('day')
  const rows: DayRow[] = ((acc ?? []) as Array<DayRow & { raw?: Record<string, unknown> | null }>).map(r => ({
    day: r.day, platform: r.platform, followers: r.followers, follows: r.follows, unfollows: r.unfollows, reach: r.reach,
    reach_organic: r.reach_organic, reach_paid: r.reach_paid, profile_views: r.profile_views, link_taps: r.link_taps,
    estimated: r.raw?.followers_estimated === true,
  }))
  const { data: pm, error: pErr } = await sb.from('social_post_metrics')
    .select('post_ref, platform, social_post_id, published_at, media_type, snapshot, reach, views, avg_watch_time_ms, shares, saves, comments, likes, follows, profile_visits, taken_at, raw')
    .gte('published_at', new Date(Date.now() - (REEL_BACKFILL_DAYS + 10) * DAY_MS).toISOString()).order('taken_at', { ascending: false }).limit(1000)
  const latest = new Map<string, MetricRow>()
  for (const r of (pm ?? []) as Array<Omit<MetricRow, 'caption' | 'permalink' | 'backfill' | 'share_rate'> & { raw?: Record<string, unknown> | null }>) {
    const cur = latest.get(r.post_ref)
    if (cur && (SNAP_ORDER[cur.snapshot] ?? 0) >= (SNAP_ORDER[r.snapshot] ?? 0)) continue
    const { raw, ...rest } = r
    latest.set(r.post_ref, {
      ...rest, caption: typeof raw?.caption === 'string' ? raw.caption : null, permalink: typeof raw?.permalink === 'string' ? raw.permalink : null,
      backfill: raw?.backfill === true, share_rate: r.reach && r.shares != null ? r.shares / r.reach : null,
    })
  }
  const posts = [...latest.values()].sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')))
  const reels = posts.filter(p => p.media_type === 'REELS' && (p.reach ?? 0) > 0)
  const top_by_shares = [...reels].sort((a, b) => (b.share_rate ?? 0) - (a.share_rate ?? 0) || (b.shares ?? 0) - (a.shares ?? 0) || (b.reach ?? 0) - (a.reach ?? 0)).slice(0, 5)
  const top_by_watch = reels.filter(p => p.avg_watch_time_ms != null).sort((a, b) => (b.avg_watch_time_ms ?? 0) - (a.avg_watch_time_ms ?? 0)).slice(0, 5)
  const last_run = await setting(sb, 'social_growth_last_run')
  return {
    ok: true, today,
    target: { value: TARGET, base_date: BASE_DATE, end_date: END_DATE, baseline: BASELINE },
    kpis: { instagram: kpisFor('instagram', rows, today), facebook: kpisFor('facebook', rows, today) },
    rows, posts: posts.slice(0, 60), top_reels: { by_shares: top_by_shares, by_watch_time: top_by_watch },
    last_run: Object.keys(last_run).length ? last_run : null,
    error: aErr?.message ?? pErr?.message ?? null,
  }
}

// ── Wochenbericht ─────────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const noDash = (t: string) => t.replace(/\s*[—–]\s*/g, m => (/^\s|\s$/.test(m) ? ' - ' : '-'))
const fmtN = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '-' : Math.round(n).toLocaleString('de-DE'))
const signed = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '-' : `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString('de-DE')}`)
const pct = (x: number | null | undefined, d = 0) => (x == null || !Number.isFinite(x) ? '-' : `${(x * 100).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d })} %`)
const secs = (ms: number | null | undefined) => (ms == null ? '-' : `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`)
const shortCap = (c: string | null) => { const t = String(c ?? '').replace(/\s+/g, ' ').trim(); return t ? (t.length > 70 ? `${t.slice(0, 68)}…` : t) : 'Reel ohne Text' }
const platLabel = (p: Platform) => (p === 'instagram' ? 'Instagram' : 'Facebook')

interface Runway { queued: number | null; planned: number; until: string | null; error: string | null }
async function reelRunway(sb: SupabaseClient): Promise<Runway> {
  const out: Runway = { queued: null, planned: 0, until: null, error: null }
  const { count } = await sb.from('social_posts').select('id', { count: 'exact', head: true })
    .like('autopilot_slot', '%|reel').is('posted_at', null).gt('scheduled_for', new Date().toISOString()).in('status', ['entwurf', 'geplant'])
  out.planned = count ?? 0
  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/social-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': await secret(sb, 'CRON_SECRET_SOCIAL') },
      body: JSON.stringify({ action: 'autopilot_status' }), signal: AbortSignal.timeout(45000),
    })
    const d = await r.json().catch(() => null) as { reels?: { queued?: number; until?: string | null }; error?: string | null } | null
    out.queued = num(d?.reels?.queued)
    out.until = typeof d?.reels?.until === 'string' ? d.reels.until : null
    if (d?.error) out.error = redact(d.error).slice(0, 200)
  } catch (e) { out.error = redact(e instanceof Error ? e.message : String(e)).slice(0, 200) }
  return out
}

type Status = Awaited<ReturnType<typeof buildStatus>>
export function reelOfWeek(posts: MetricRow[], nowMs: number) {
  const week = posts.filter(p => p.media_type === 'REELS' && !p.backfill && (p.reach ?? 0) > 0 && Date.parse(p.published_at ?? '') >= nowMs - 8 * DAY_MS)
  if (!week.length) return { best: null, weak: null, count: 0 }
  const score = (p: MetricRow) => ((p.shares ?? 0) + (p.saves ?? 0)) / Math.max(1, p.reach ?? 0) * 100 + (p.avg_watch_time_ms ?? 0) / 1000 / 10 + Math.log10(Math.max(1, p.reach ?? 0)) / 10
  const sorted = [...week].sort((a, b) => score(b) - score(a))
  const avg = (f: (p: MetricRow) => number | null) => { const v = week.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
  const avgWatch = avg(p => p.avg_watch_time_ms), avgReach = avg(p => p.reach), avgShare = avg(p => p.share_rate)
  const why = (p: MetricRow, good: boolean) => {
    const parts: string[] = []
    if (good) {
      if ((p.shares ?? 0) > 0) parts.push(`${fmtN(p.shares)} mal geteilt (${pct(p.share_rate, 1)} der Erreichten${avgShare != null ? `, Wochenschnitt ${pct(avgShare, 1)}` : ''})`)
      if (p.avg_watch_time_ms != null && avgWatch != null && p.avg_watch_time_ms >= avgWatch) parts.push(`Ø ${secs(p.avg_watch_time_ms)} angesehen (Schnitt ${secs(avgWatch)})`)
      if (!parts.length) parts.push(`größte Reichweite der Woche (${fmtN(p.reach)} Konten)`)
    } else {
      if ((p.shares ?? 0) === 0) parts.push('kein einziges Mal geteilt')
      if (p.avg_watch_time_ms != null && avgWatch != null && p.avg_watch_time_ms < avgWatch) parts.push(`nur Ø ${secs(p.avg_watch_time_ms)} angesehen (Schnitt ${secs(avgWatch)}), der Einstieg hält nicht`)
      if (avgReach != null && (p.reach ?? 0) < avgReach) parts.push(`${fmtN(p.reach)} Konten erreicht (Schnitt ${fmtN(avgReach)})`)
      if (!parts.length) parts.push('schwächste Kombination aus Teilen und Wiedergabezeit')
    }
    return parts.slice(0, 2).join(', ')
  }
  const best = sorted[0]
  const weak = sorted.length > 1 ? sorted[sorted.length - 1] : null
  return { best: { post: best, reason: why(best, true) }, weak: weak ? { post: weak, reason: why(weak, false) } : null, count: week.length }
}

export function buildTodos(st: Status, runway: Runway, rw: ReturnType<typeof reelOfWeek>): string[] {
  const todos: string[] = []
  const ig = st.kpis.instagram, fb = st.kpis.facebook
  const leftReels = (runway.queued ?? 0) + runway.planned
  if (runway.queued != null && (leftReels < 6 || (runway.until && daysBetween(ptYmd(Date.now()), runway.until) < 7)))
    todos.push(`Reels nachliefern: Nur noch ${leftReels} Reels vorrätig${runway.until ? ` (reicht bis ${new Date(`${runway.until}T12:00:00Z`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })})` : ''}. Für 6 Reels pro Woche mindestens 6 neue Videos in den Reels-Ordner legen.`)
  if (rw.count === 0) todos.push('Diese Woche lief kein Reel. Reels sind der Hauptweg zu neuen Followern: den Autopilot prüfen und die Reel-Plätze füllen.')
  else if (rw.best?.post && (rw.best.post.shares ?? 0) > 0) todos.push(`Format des besten Reels wiederholen („${shortCap(rw.best.post.caption)}“): gleicher Einstieg, gleiche Länge, 2 Varianten diese Woche.`)
  if (ig.net_7d != null && ig.net_7d < ig.required_7d) todos.push(`Instagram liegt bei ${signed(ig.net_7d)} statt ${signed(ig.required_7d)} Followern pro Woche: in jedes Reel eine klare Folgen-Aufforderung mit Grund („Folge für den nächsten Rechenfall“) und 2 Trial Reels testen.`)
  if (fb.net_7d != null && fb.net_7d < fb.required_7d && todos.length < 3) todos.push(`Facebook liegt bei ${signed(fb.net_7d)} statt ${signed(fb.required_7d)} pro Woche: Reels auch als Facebook-Reel posten und die Seite in den Werbeanzeigen verlinken, damit Anzeigen-Kontakte der Seite folgen.`)
  const share = ig.reach_28d.organic_share
  if (share != null && share < 0.2 && todos.length < 3) todos.push(`Nur ${pct(share)} der Instagram-Reichweite ist organisch, der Rest kommt aus Anzeigen. Organisch wachsen heißt: mehr teilbare Reels (Checklisten, Rechenbeispiele), die Leute an Freunde schicken.`)
  if (!todos.length) todos.push('Kurs halten: 6 Reels pro Woche, bestes Format der Woche zweimal wiederholen.')
  return todos.slice(0, 3)
}

async function weeklyReport(sb: SupabaseClient, dryRun: boolean): Promise<{ subject: string; html: string; sent: boolean; to: string; error?: string }> {
  const st = await buildStatus(sb)
  const runway = await reelRunway(sb)
  const rw = reelOfWeek(st.posts as MetricRow[], Date.now())
  const todos = buildTodos(st, runway, rw)
  const kw = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return Math.ceil(((d.getTime() - y.getTime()) / DAY_MS + 1) / 7) })()
  const ig = st.kpis.instagram, fb = st.kpis.facebook
  const subject = noDash(`📈 Wachstum KW ${kw}: Instagram ${fmtN(ig.current)} (${signed(ig.net_7d)}), Facebook ${fmtN(fb.current)} (${signed(fb.net_7d)})`)

  // Farben nur aus dem CI (Korall nur als Akzent)
  const NAVY = CI.navy, CORAL = CI.coral, MUTED = CI.mute, LINE = CI.line
  const td = `padding:8px 10px;border-bottom:1px solid ${LINE};font-size:14px;`
  const badge = (ok: boolean | null) => ok == null ? `<span style="color:${MUTED}">noch zu wenig Daten</span>` : ok ? `<span style="color:${NAVY};font-weight:600">✓ im Plan</span>` : `<span style="color:${CORAL};font-weight:600">▼ unter Plan</span>`
  const platRow = (p: Platform) => {
    const k = st.kpis[p]
    return `<tr><td style="${td}font-weight:600;color:${NAVY}">${platLabel(p)}</td>
      <td style="${td}text-align:right">${fmtN(k.current)}</td>
      <td style="${td}text-align:right">${signed(k.net_7d)} <span style="color:${MUTED}">/ Soll ${signed(k.required_7d)}</span></td>
      <td style="${td}text-align:right">${signed(k.net_28d)} <span style="color:${MUTED}">/ Soll ${signed(k.required_28d)}</span></td>
      <td style="${td}text-align:right">${pct(k.reach_28d.organic_share)}</td>
      <td style="${td}">${badge(k.on_track)}</td></tr>`
  }
  const reelLine = (label: string, x: { post: MetricRow; reason: string } | null) => x ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.5"><b>${label}:</b> ${x.post.permalink ? `<a href="${esc(x.post.permalink)}" style="color:${NAVY}">${esc(shortCap(x.post.caption))}</a>` : esc(shortCap(x.post.caption))} <span style="color:${MUTED}">(${platLabel(x.post.platform)}, ${fmtN(x.post.reach)} erreicht, ${fmtN(x.post.shares)} geteilt, Ø ${secs(x.post.avg_watch_time_ms)})</span><br>${esc(x.reason)}.</p>` : ''
  const untilTxt = runway.until ? new Date(`${runway.until}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).replace(/\.$/, '') : null
  const runwayTxt = runway.queued == null
    ? `Reel-Vorrat konnte nicht gelesen werden${runway.error ? ` (${esc(runway.error)})` : ''}. Schon eingeplant: ${runway.planned}.`
    : `${runway.queued} Reels im Ordner, ${runway.planned} schon eingeplant${untilTxt ? `, reicht bis ${untilTxt}` : ''}.`

  const html = noDash(`<div style="font-family:Montserrat,Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:${CI.ink}">
  <div style="border-top:4px solid ${CORAL};padding:18px 0 6px"><h2 style="margin:0;color:${NAVY};font-size:20px">📈 Wachstum Instagram und Facebook, KW ${kw}</h2>
  <p style="margin:6px 0 0;color:${MUTED};font-size:13px">Ziel: ${fmtN(TARGET)} Follower je Plattform bis 26.09.2027. Soll-Tempo Instagram ${fmtN(ig.required_per_month)} und Facebook ${fmtN(fb.required_per_month)} neue Follower pro Monat.</p></div>
  <table style="width:100%;border-collapse:collapse;margin:14px 0 6px"><tr style="background:${CI.cream}">
    <th style="${td}text-align:left;color:${MUTED};font-weight:600">Kanal</th><th style="${td}text-align:right;color:${MUTED};font-weight:600">Follower</th>
    <th style="${td}text-align:right;color:${MUTED};font-weight:600">7 Tage</th><th style="${td}text-align:right;color:${MUTED};font-weight:600">28 Tage</th>
    <th style="${td}text-align:right;color:${MUTED};font-weight:600">organisch</th><th style="${td}text-align:left;color:${MUTED};font-weight:600">Stand</th></tr>
    ${platRow('instagram')}${platRow('facebook')}</table>
  <p style="margin:0 0 16px;color:${MUTED};font-size:12px">„organisch“ = Anteil der Reichweite der letzten 28 Tage, der nicht aus Anzeigen kommt. Hochgerechnet auf den 26.09.2027: Instagram ${fmtN(ig.projected_end)}, Facebook ${fmtN(fb.projected_end)} Follower.</p>
  <h3 style="margin:18px 0 8px;color:${NAVY};font-size:16px">🎬 Reels der Woche</h3>
  ${rw.count ? `${reelLine('Bestes Reel', rw.best)}${reelLine('Schwächstes Reel', rw.weak)}` : '<p style="margin:0 0 10px;font-size:14px">Diese Woche wurde kein Reel gemessen.</p>'}
  <p style="margin:0 0 16px;font-size:14px"><b>Reel-Vorrat:</b> ${runwayTxt}</p>
  <h3 style="margin:18px 0 8px;color:${NAVY};font-size:16px">✅ To-dos</h3>
  <ol style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.55">${todos.map(t => `<li style="margin-bottom:6px">${esc(t)}</li>`).join('')}</ol>
  <p style="margin:18px 0 0;font-size:13px"><a href="https://portal.happy-property.com/admin/crm/social" style="color:${NAVY}">Social-Studio öffnen</a> <span style="color:${MUTED}">(Karte „Wachstum“ im Redaktionsplan)</span></p>
  <p style="margin:8px 0 0;color:${MUTED};font-size:11px">Automatischer Bericht, jeden Montag 07:00 Uhr. Zahlen von Meta, Tageswerte nach Meta-Zeit (Pacific Time).</p></div>`)

  const to = Deno.env.get('HEALTH_REPORT_TO') ?? 'sven@happy-property.com'
  if (dryRun) return { subject, html, sent: false, to }
  let sendErr: string | undefined
  try {
    // Gleiches Muster und derselbe Empfänger wie die Morgenmail des nächtlichen Systemchecks
    const { error } = await sb.functions.invoke('send-email', { body: { to, subject, html } })
    if (error) sendErr = error.message
  } catch (e) { sendErr = e instanceof Error ? e.message : String(e) }
  await saveSetting(sb, 'social_growth_last_report', { at: new Date().toISOString(), subject, sent: !sendErr, error: sendErr ?? null })
  if (sendErr) console.warn('[social-growth] Mail:', sendErr)
  return { subject, html: '', sent: !sendErr, to, ...(sendErr ? { error: sendErr } : {}) }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const who = await whoIs(sb, req)
    if (!who) return json({ error: 'Keine Berechtigung.' }, 401)
    const body = await req.json().catch(() => ({})) as { action?: string; wait?: boolean; backfill?: boolean; dry_run?: boolean }

    if (body.action === 'status') return json(await buildStatus(sb))

    if (who !== 'system') return json({ error: 'Keine Berechtigung.' }, 403)

    if (body.action === 'snapshot') {
      const job = snapshot(sb, body.backfill === true)
        .then(async (s) => { await saveSetting(sb, 'social_growth_last_run', s); console.log('[social-growth] snapshot', JSON.stringify({ rows: s.account_rows, posts: s.posts, errors: s.errors.length })); return s })
        .catch(async (e) => { const s = { at: new Date().toISOString(), errors: [redact(e instanceof Error ? e.message : String(e))] }; await saveSetting(sb, 'social_growth_last_run', s); return s })
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job)
      // Cron bricht nach 5 s ab: kurz warten, sonst im Hintergrund weiterlaufen lassen.
      const res = await Promise.race([job, new Promise<null>(r => setTimeout(() => r(null), body.wait ? 140000 : 4000))])
      return json(res ? { success: true, ...res } : { success: true, running: true })
    }

    if (body.action === 'weekly_report') {
      if (body.dry_run) return json({ success: true, dry_run: true, ...(await weeklyReport(sb, true)) })
      const job = weeklyReport(sb, false).catch((e) => ({ subject: '', html: '', sent: false, to: '', error: redact(e instanceof Error ? e.message : String(e)) }))
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job)
      const res = await Promise.race([job, new Promise<null>(r => setTimeout(() => r(null), body.wait ? 120000 : 4000))])
      return json(res ? { success: true, ...res } : { success: true, running: true })
    }

    return json({ error: `Unbekannte Aktion: ${body.action ?? '(leer)'}` }, 400)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[social-growth]', redact(msg))
    return json({ error: redact(msg) }, 500)
  }
})
