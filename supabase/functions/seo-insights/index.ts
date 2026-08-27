// Edge Function: seo-insights — SEO- und KI-Sichtbarkeit der Hauptseite.
//
// Drei Aufgaben:
//   1. Ingest der Crawler-Besuche vom WordPress-Snippet (Google, Bing,
//      GPTBot/ChatGPT, ClaudeBot, PerplexityBot, ...). Nur der Server sieht
//      diese Bots — kein Client-Tracking kann das.
//   2. Taeglicher Schnappschuss: alle Sitemap-Seiten crawlen (Titel,
//      Beschreibungen, FAQ-Markup, interne Links, Alt-Texte, veraltete
//      Steuerzahl, Antwortzeit) + Search-Console-Zahlen, sobald der
//      Service-Account freigeschaltet ist.
//   3. Woechentlicher KI-Bericht: aggregiert Bot-Besuche, Schnappschuss-
//      Trends, GSC und organische Besuche (web_sessions nach Referrer),
//      laesst Claude analysieren und mailt den Report an Sven + Giona.
//
//   POST { a:'hit', secret, bot, path, ua? }        ← WordPress-Snippet
//   POST { action:'snapshot' }                      → Tages-Schnappschuss
//   POST { action:'report', cron?, force? }         → Wochenbericht
//     cron:true → laeuft nur montags, wenn es in Zypern gerade 07:00 ist
//                 (Job in UTC zweimal geplant: 04:10 + 05:10, wie wa-weekly)
//   GET  ?t=<token>                                 → Report-HTML ausliefern
//
// ── Secrets ──
//   SEO_INGEST_SECRET            gemeinsames Geheimnis mit dem WP-Snippet
//   GOOGLE_SERVICE_ACCOUNT_JSON  (bestehend) — fuer Search Console, sobald
//                                der SA dort als Nutzer eingetragen ist
//   ANTHROPIC_API_KEY            (bestehend)
//   SMTP_USER / SMTP_PASS        (bestehend, Ionos)
//   SEO_REPORT_RECIPIENTS        optional, Komma-Liste; Default Sven + Giona
//
// ── Deployment ──
//   supabase functions deploy seo-insights --no-verify-jwt

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'
import { CI } from '../_shared/brand.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SITE = 'steuervorteil-zypern-immobilien.com'
const BASE = `https://${SITE}`
const TZ = 'Asia/Nicosia'
const DEFAULT_RECIPIENTS = ['sven@happy-property.com', 'giona.schauf@googlemail.com']

const cyHour = (d = new Date()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d)) % 24
const cyWeekday = (d = new Date()) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' }).format(d)   // 'Mon'
const cyDateStr = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const deDate = (d: Date) =>
  new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmtNum = (n: number) => new Intl.NumberFormat('de-DE').format(n)

// ── Bot-Katalog: UA-Muster → normalisierter Name, Suchsystem, Art ────────────
// kind 'crawl'  = Index-Aufbau (der Bot liest fuer spaeter)
// kind 'assist' = Live-Abruf, weil ein Mensch der KI gerade eine Frage stellt —
//                 das ist die direkteste Messung von "ChatGPT nutzt die Seite".
const BOTS: { re: RegExp; bot: string; engine: string; kind: 'crawl' | 'assist' }[] = [
  { re: /oai-searchbot/i,      bot: 'OAI-SearchBot',   engine: 'openai',     kind: 'crawl'  },
  { re: /chatgpt-user/i,       bot: 'ChatGPT-User',    engine: 'openai',     kind: 'assist' },
  { re: /gptbot/i,             bot: 'GPTBot',          engine: 'openai',     kind: 'crawl'  },
  { re: /claude-searchbot/i,   bot: 'Claude-SearchBot',engine: 'anthropic',  kind: 'crawl'  },
  { re: /claude-user/i,        bot: 'Claude-User',     engine: 'anthropic',  kind: 'assist' },
  { re: /claudebot/i,          bot: 'ClaudeBot',       engine: 'anthropic',  kind: 'crawl'  },
  { re: /perplexity-user/i,    bot: 'Perplexity-User', engine: 'perplexity', kind: 'assist' },
  { re: /perplexitybot/i,      bot: 'PerplexityBot',   engine: 'perplexity', kind: 'crawl'  },
  { re: /google-extended/i,    bot: 'Google-Extended', engine: 'google',     kind: 'crawl'  },
  { re: /googlebot/i,          bot: 'Googlebot',       engine: 'google',     kind: 'crawl'  },
  { re: /bingbot/i,            bot: 'Bingbot',         engine: 'bing',       kind: 'crawl'  },
  { re: /applebot/i,           bot: 'Applebot',        engine: 'apple',      kind: 'crawl'  },
  { re: /amazonbot/i,          bot: 'Amazonbot',       engine: 'other',      kind: 'crawl'  },
  { re: /meta-externalagent/i, bot: 'Meta-External',   engine: 'meta',       kind: 'crawl'  },
  { re: /bytespider/i,         bot: 'Bytespider',      engine: 'other',      kind: 'crawl'  },
  { re: /ccbot/i,              bot: 'CCBot',           engine: 'other',      kind: 'crawl'  },
  { re: /duckduckbot/i,        bot: 'DuckDuckBot',     engine: 'other',      kind: 'crawl'  },
]
function classifyUa(ua: string): { bot: string; engine: string; kind: 'crawl' | 'assist' } | null {
  for (const b of BOTS) if (b.re.test(ua)) return b
  return null
}

// ── Google-Token (Muster aus create-client-drive-folder) ─────────────────────
function b64url(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const raw = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''))
  const buf = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  return crypto.subtle.importKey('pkcs8', buf, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
async function gscToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`
  const key = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(new Uint8Array(sig))}` }),
  })
  const data = await res.json() as { access_token?: string; error_description?: string }
  if (!data.access_token) throw new Error(`SA-Token: ${data.error_description ?? 'unbekannt'}`)
  return data.access_token
}

// ── Search Console abfragen (beide Property-Formen probieren) ────────────────
interface GscData {
  status: string
  clicks?: number; impressions?: number; ctr?: number; position?: number
  top_queries?: { query: string; clicks: number; impressions: number; position: number }[]
  top_pages?: { page: string; clicks: number; impressions: number; position: number }[]
}
async function fetchGsc(): Promise<GscData> {
  let token: string
  try { token = await gscToken() } catch (err) {
    return { status: `kein_token: ${err instanceof Error ? err.message : String(err)}` }
  }
  // GSC-Daten laufen ~2 Tage nach — Fenster Tag-9 bis Tag-3.
  const end = new Date(Date.now() - 3 * 86400_000)
  const start = new Date(Date.now() - 9 * 86400_000)
  const range = { startDate: cyDateStr(start), endDate: cyDateStr(end) }
  const candidates = [`sc-domain:${SITE}`, `${BASE}/`]
  for (const siteUrl of candidates) {
    const q = async (body: unknown) => {
      const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { ok: r.ok, status: r.status, data: await r.json() as { rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] } }
    }
    const totals = await q({ ...range })
    if (!totals.ok) continue                        // 403 = (noch) kein Zugriff auf diese Form
    const t = totals.data.rows?.[0]
    const queries = await q({ ...range, dimensions: ['query'], rowLimit: 10 })
    const pages = await q({ ...range, dimensions: ['page'], rowLimit: 10 })
    return {
      status: 'ok',
      clicks: t?.clicks ?? 0, impressions: t?.impressions ?? 0,
      ctr: t?.ctr ?? 0, position: t?.position ?? 0,
      top_queries: (queries.data.rows ?? []).map(r => ({ query: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
      top_pages: (pages.data.rows ?? []).map(r => ({ page: (r.keys?.[0] ?? '').replace(BASE, ''), clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
    }
  }
  return { status: 'wartet_auf_freigabe' }          // SA ist noch nicht als GSC-Nutzer eingetragen
}

// ── Tages-Schnappschuss: Sitemap crawlen ─────────────────────────────────────
async function fetchText(url: string, timeoutMs = 20000): Promise<{ ok: boolean; status: number; text: string; ttfbMs: number }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'HP-SEO-Insights/1.0 (interner Gesundheitscheck)' }, signal: ctrl.signal })
    const ttfbMs = performance.now() - t0          // bis Header da sind
    const text = await r.text()
    return { ok: r.ok, status: r.status, text, ttfbMs }
  } catch {
    return { ok: false, status: 0, text: '', ttfbMs: performance.now() - t0 }
  } finally { clearTimeout(timer) }
}

const CONTENT_LINK_RE = new RegExp(
  `<a href="${BASE}/(?:steuerliche-vorteile|non-dom-status-zypern|zypern-limited|steuern-optimieren-mit-dem-dba|` +
  `rendite-rechner|kaufprozess|immobilieninvestor-zypern|auswandern-nach-zypern|steuern-auf-zypern|` +
  `immobilien-auf-zypern-kaufen-als-deutscher)/"`, 'g')

async function buildSnapshot(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const urls: string[] = []
  for (const part of ['post-sitemap.xml', 'page-sitemap.xml']) {
    const sm = await fetchText(`${BASE}/${part}`)
    urls.push(...(sm.text.match(/<loc>([^<]+)<\/loc>/g) ?? []).map(m => m.replace(/<\/?loc>/g, '')))
  }
  const metrics = {
    pages: urls.length, titles_over_60: 0, desc_missing: 0, faq_pages: 0, faq_pairs: 0,
    internal_links: 0, alt_missing: 0, old_tax_rate: 0, errors: 0, ttfb_avg_ms: 0,
    llms_txt: false, robots_ai_ok: false,
  }
  let ttfbSum = 0, ttfbN = 0
  // Sechs gleichzeitig — schont den Shared-Hoster.
  const queue = [...urls]
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const r = await fetchText(`${u}?hp_seo_check=1`)
      if (!r.ok) { metrics.errors++; continue }
      ttfbSum += r.ttfbMs; ttfbN++
      const title = /<title>(.*?)<\/title>/s.exec(r.text)?.[1]?.trim() ?? ''
      if (title.length > 60) metrics.titles_over_60++
      if (!/name="description"/.test(r.text)) metrics.desc_missing++
      if (r.text.includes('FAQPage')) {
        metrics.faq_pages++
        metrics.faq_pairs += (r.text.match(/"@type":\s*"Question"/g) ?? []).length
      }
      metrics.internal_links += (r.text.match(CONTENT_LINK_RE) ?? []).length
      metrics.alt_missing += (r.text.match(/<img\b(?![^>]*\balt="[^"]+")[^>]*>/g) ?? []).length
      if (/12[,.]5\s*(%|Prozent)/.test(r.text)) metrics.old_tax_rate++
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()])
  metrics.ttfb_avg_ms = ttfbN ? Math.round(ttfbSum / ttfbN) : 0
  metrics.llms_txt = (await fetchText(`${BASE}/llms.txt`)).ok
  const robots = await fetchText(`${BASE}/robots.txt`)
  metrics.robots_ai_ok = robots.ok && !/disallow:\s*\/\s*$/im.test(robots.text)
  const gsc = await fetchGsc()
  const day = cyDateStr(new Date())
  const { error } = await sb.from('seo_snapshots')
    .upsert({ day, site: SITE, metrics, gsc }, { onConflict: 'day' })
  if (error) throw new Error(`Snapshot speichern: ${error.message}`)
  console.log(`[seo-insights] Snapshot ${day}: ${metrics.pages} Seiten, GSC ${gsc.status}`)
  return { day, metrics, gsc }
}

// ── Wochenbericht ────────────────────────────────────────────────────────────
interface EngineAgg { engine: string; crawl: number; assist: number; pages: number }
interface Analysis { zusammenfassung: string; ki_sicht: string; empfehlungen: { titel: string; text: string }[] }

async function collectWeek(sb: SupabaseClient) {
  const to = new Date(); const from = new Date(to.getTime() - 7 * 86400_000)
  const prevFrom = new Date(to.getTime() - 14 * 86400_000)
  const hits = async (a: Date, b: Date) => {
    const { data } = await sb.from('seo_bot_hits').select('bot, engine, kind, path, ts')
      .gte('ts', a.toISOString()).lt('ts', b.toISOString()).limit(50000)
    return data ?? []
  }
  const cur = await hits(from, to); const prev = await hits(prevFrom, from)
  const agg = (rows: { engine: string; kind: string; path: string }[]): EngineAgg[] => {
    const m = new Map<string, EngineAgg & { pathSet: Set<string> }>()
    for (const r of rows) {
      const e = m.get(r.engine) ?? { engine: r.engine, crawl: 0, assist: 0, pages: 0, pathSet: new Set<string>() }
      if (r.kind === 'assist') e.assist++; else e.crawl++
      e.pathSet.add(r.path); m.set(r.engine, e)
    }
    return [...m.values()].map(e => ({ engine: e.engine, crawl: e.crawl, assist: e.assist, pages: e.pathSet.size }))
      .sort((a, b) => (b.crawl + b.assist) - (a.crawl + a.assist))
  }
  // Meistbesuchte Seiten der KI-Bots (openai/anthropic/perplexity)
  const aiPaths = new Map<string, number>()
  for (const r of cur as { engine: string; path: string }[])
    if (['openai', 'anthropic', 'perplexity'].includes(r.engine))
      aiPaths.set(r.path, (aiPaths.get(r.path) ?? 0) + 1)
  const topAiPages = [...aiPaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)

  // Tagesverlauf fuer das Balkendiagramm
  const daily = new Map<string, { google: number; ai: number }>()
  for (const r of cur as { engine: string; ts: string }[]) {
    const day = r.ts.slice(0, 10)
    const d = daily.get(day) ?? { google: 0, ai: 0 }
    if (['openai', 'anthropic', 'perplexity'].includes(r.engine)) d.ai++
    else if (['google', 'bing'].includes(r.engine)) d.google++
    daily.set(day, d)
  }

  const { data: snaps } = await sb.from('seo_snapshots').select('day, metrics, gsc').order('day', { ascending: false }).limit(8)
  const snapNow = snaps?.[0] ?? null
  const snapWeekAgo = snaps?.find(s => s.day <= cyDateStr(from)) ?? snaps?.[snaps.length - 1] ?? null

  // Organische Besuche aus dem Eigenbau-Analytics, nach Suchsystem
  const organic = { google: 0, bing: 0, ki: 0 }
  const { data: sess } = await sb.from('web_sessions').select('referrer')
    .eq('site', SITE).gte('started_at', from.toISOString()).limit(20000)
  for (const s of (sess ?? []) as { referrer: string | null }[]) {
    const ref = (s.referrer ?? '').toLowerCase()
    if (/google\./.test(ref)) organic.google++
    else if (/bing\./.test(ref)) organic.bing++
    else if (/chatgpt|openai|perplexity|claude|copilot/.test(ref)) organic.ki++
  }
  return { from, to, cur: agg(cur), prev: agg(prev), topAiPages, daily: [...daily.entries()].sort(), snapNow, snapWeekAgo, organic }
}

type WeekData = Awaited<ReturnType<typeof collectWeek>>

async function analyze(data: WeekData): Promise<Analysis> {
  const fallback: Analysis = {
    zusammenfassung: 'Automatische Analyse nicht verfügbar — die Zahlen unten gelten trotzdem.',
    ki_sicht: '', empfehlungen: [],
  }
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  if (!key) return fallback
  const compact = {
    zeitraum: `${deDate(data.from)}–${deDate(data.to)}`,
    crawler_diese_woche: data.cur, crawler_vorwoche: data.prev,
    meistbesuchte_seiten_der_ki_bots: data.topAiPages,
    seiten_gesundheit_aktuell: data.snapNow?.metrics ?? null,
    seiten_gesundheit_vorwoche: data.snapWeekAgo?.metrics ?? null,
    google_search_console: data.snapNow?.gsc ?? { status: 'wartet_auf_freigabe' },
    organische_besuche_nach_quelle: data.organic,
  }
  const prompt =
    `Du bist SEO- und KI-Sichtbarkeits-Analyst für Happy Property (Immobilien-Investments Zypern, ` +
    `deutschsprachige Kapitalanleger). Analysierte Seite: steuervorteil-zypern-immobilien.com (Hauptseite). ` +
    `"assist"-Zugriffe bedeuten: eine KI (ChatGPT/Claude/Perplexity) hat die Seite LIVE abgerufen, weil ein ` +
    `Mensch gerade eine Frage gestellt hat — das ist das direkteste Signal für KI-Sichtbarkeit. ` +
    `"crawl" = Index-Aufbau für später.\n\n` +
    `Wochendaten (JSON):\n${JSON.stringify(compact)}\n\n` +
    `Antworte NUR mit validem JSON, deutsch, Du-Form, konkret, ohne Floskeln:\n` +
    `{"zusammenfassung":"3-5 Sätze: wichtigste SEO-Entwicklung der Woche inkl. Vergleich zur Vorwoche",` +
    `"ki_sicht":"3-5 Sätze: Wie sichtbar ist die Seite gerade für ChatGPT, Claude und Perplexity? Aus den crawl/assist-Zahlen abgeleitet, keine Erfindungen",` +
    `"empfehlungen":[{"titel":"...","text":"1-3 Sätze, konkret umsetzbar"}]} — 3 bis 5 Empfehlungen. ` +
    `Wenn die Search Console noch auf Freigabe wartet, nenne das als eine Empfehlung. ` +
    `Wenn die Datenbasis noch dünn ist (Sammlung neu), sag das ehrlich.`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) { console.warn('[seo-insights] Anthropic', res.status); return fallback }
    const body = await res.json() as { content?: { text?: string }[] }
    const m = (body.content?.[0]?.text ?? '').match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const parsed = JSON.parse(m[0]) as Analysis
    if (!parsed.zusammenfassung || !Array.isArray(parsed.empfehlungen)) return fallback
    return parsed
  } catch (err) { console.warn('[seo-insights] analyze:', err); return fallback }
}

// ── HTML-Report ──────────────────────────────────────────────────────────────
const ENGINE_LABELS: Record<string, string> = {
  google: 'Google', bing: 'Bing (→ Copilot)', openai: 'OpenAI / ChatGPT',
  anthropic: 'Anthropic / Claude', perplexity: 'Perplexity', apple: 'Apple',
  meta: 'Meta', other: 'Sonstige',
}
function deltaBadge(now: number, prev: number): string {
  if (!prev) return ''
  const pct = Math.round(((now - prev) / prev) * 100)
  const up = pct >= 0
  return ` <span style="font-size:12px;color:${up ? '#1f9d55' : '#d33'};font-weight:600">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span>`
}
function dailyChart(daily: WeekData['daily']): string {
  if (!daily.length) return `<p style="color:${CI.mute};font-size:14px">Noch keine Crawler-Daten — die Sammlung ist gerade gestartet.</p>`
  const w = 660, h = 190, pad = 26
  const max = Math.max(1, ...daily.map(([, d]) => d.google + d.ai))
  const cw = (w - pad * 2) / daily.length
  const bw = Math.min(46, cw - 10)
  const bars = daily.map(([day, d], i) => {
    const x = pad + i * cw + (cw - bw) / 2
    const hg = (d.google / max) * (h - 60), ha = (d.ai / max) * (h - 60)
    const yA = h - 35 - ha, yG = yA - hg
    return `<rect x="${x}" y="${yG}" width="${bw}" height="${Math.max(1, hg)}" fill="${CI.navy}"/>` +
      `<rect x="${x}" y="${yA}" width="${bw}" height="${Math.max(1, ha)}" rx="2" fill="${CI.coral}"/>` +
      `<text x="${x + bw / 2}" y="${yG - 5}" text-anchor="middle" font-size="11" fill="${CI.navy}" font-weight="600">${d.google + d.ai}</text>` +
      `<text x="${x + bw / 2}" y="${h - 18}" text-anchor="middle" font-size="10" fill="${CI.mute}">${day.slice(8, 10)}.${day.slice(5, 7)}.</text>`
  }).join('')
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px" xmlns="http://www.w3.org/2000/svg">${bars}` +
    `<rect x="${pad}" y="6" width="10" height="10" fill="${CI.navy}"/><text x="${pad + 15}" y="15" font-size="11" fill="${CI.mute}">Google + Bing</text>` +
    `<rect x="${pad + 110}" y="6" width="10" height="10" rx="2" fill="${CI.coral}"/><text x="${pad + 125}" y="15" font-size="11" fill="${CI.mute}">KI (ChatGPT, Claude, Perplexity)</text></svg>`
}

function renderHtml(data: WeekData, analysis: Analysis): string {
  const card = (inner: string) =>
    `<div style="background:#fff;border:1px solid #e8e4dc;border-radius:14px;padding:22px 24px;margin-bottom:18px">${inner}</div>`
  const h2 = (t: string) => `<h2 style="margin:0 0 12px;font-size:19px;color:${CI.navy}">${t}</h2>`
  const engineRows = data.cur.map(e => {
    const p = data.prev.find(x => x.engine === e.engine)
    return `<tr><td style="padding:7px 10px 7px 0">${esc(ENGINE_LABELS[e.engine] ?? e.engine)}</td>` +
      `<td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtNum(e.crawl)}${deltaBadge(e.crawl, p?.crawl ?? 0)}</td>` +
      `<td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:${e.assist ? 700 : 400};color:${e.assist ? CI.coral : 'inherit'}">${fmtNum(e.assist)}</td>` +
      `<td style="padding:7px 0 7px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtNum(e.pages)}</td></tr>`
  }).join('')
  const m = (data.snapNow?.metrics ?? {}) as Record<string, number | boolean>
  const mPrev = (data.snapWeekAgo?.metrics ?? {}) as Record<string, number | boolean>
  const healthRow = (label: string, key: string, gutWennNull = true) => {
    const now = Number(m[key] ?? 0), prev = Number(mPrev[key] ?? 0)
    const farbe = gutWennNull ? (now === 0 ? '#1f9d55' : (now > prev ? '#d33' : CI.navy)) : CI.navy
    return `<tr><td style="padding:6px 10px 6px 0">${label}</td>` +
      `<td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;color:${farbe};font-weight:600">${fmtNum(now)}</td></tr>`
  }
  const gsc = (data.snapNow?.gsc ?? { status: 'wartet_auf_freigabe' }) as GscData
  const gscBlock = gsc.status === 'ok'
    ? `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
      `<tr><td>Klicks</td><td style="text-align:right;font-weight:700">${fmtNum(gsc.clicks ?? 0)}</td></tr>` +
      `<tr><td>Einblendungen</td><td style="text-align:right">${fmtNum(gsc.impressions ?? 0)}</td></tr>` +
      `<tr><td>Ø Position</td><td style="text-align:right">${(gsc.position ?? 0).toFixed(1)}</td></tr></table>` +
      ((gsc.top_queries?.length ?? 0) > 0
        ? `<p style="margin:12px 0 4px;font-size:13px;color:${CI.mute}">Top-Suchbegriffe:</p>` +
          gsc.top_queries!.map(q => `<div style="font-size:13px;padding:2px 0">${esc(q.query)} — Pos. ${q.position}, ${q.clicks} Klicks</div>`).join('')
        : '')
    : `<p style="font-size:14px;color:${CI.mute}">Die Search Console wartet noch auf die Freigabe des Service-Accounts — ` +
      `sobald sie da ist, stehen hier echte Positionen je Suchbegriff.</p>`
  const empfehlungen = analysis.empfehlungen.map((e, i) =>
    `<div style="margin-bottom:12px"><div style="font-weight:700;color:${CI.navy}">${i + 1}. ${esc(e.titel)}</div>` +
    `<div style="font-size:14px;color:#444">${esc(e.text)}</div></div>`).join('')
  const aiPages = data.topAiPages.length
    ? data.topAiPages.map(([p, n]) => `<div style="font-size:13px;padding:2px 0;font-variant-numeric:tabular-nums">${fmtNum(n)} × ${esc(p)}</div>`).join('')
    : `<p style="font-size:14px;color:${CI.mute}">Noch keine KI-Bot-Besuche erfasst.</p>`
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>SEO-Wochenbericht</title></head>` +
    `<body style="margin:0;background:${CI.cream};font-family:'Montserrat',system-ui,sans-serif;color:#222">` +
    `<div style="max-width:720px;margin:0 auto;padding:34px 18px 60px">` +
    `<p style="letter-spacing:2px;text-transform:uppercase;font-size:12px;color:${CI.coral};font-weight:700;margin:0 0 8px">Happy Property · SEO & KI-Sichtbarkeit</p>` +
    `<h1 style="font-family:'Playfair Display',Georgia,serif;font-size:30px;margin:0 0 6px;color:${CI.navy}">Wochenbericht ${deDate(data.from)} – ${deDate(data.to)}</h1>` +
    `<p style="margin:0 0 24px;color:${CI.mute};font-size:14px">steuervorteil-zypern-immobilien.com</p>` +
    card(h2('Zusammenfassung') + `<p style="margin:0;font-size:15px;line-height:1.6">${esc(analysis.zusammenfassung)}</p>` +
      (analysis.ki_sicht ? `<p style="margin:12px 0 0;font-size:15px;line-height:1.6"><b>KI-Sicht:</b> ${esc(analysis.ki_sicht)}</p>` : '')) +
    card(h2('Crawler-Besuche pro Tag') + dailyChart(data.daily)) +
    card(h2('Wer liest die Seite?') +
      `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
      `<tr style="color:${CI.mute};font-size:12px;text-transform:uppercase;letter-spacing:1px">` +
      `<td style="padding-bottom:6px">Suchsystem</td><td style="text-align:right">Crawls</td>` +
      `<td style="text-align:right">Live-Abrufe*</td><td style="text-align:right">Seiten</td></tr>${engineRows}</table>` +
      `<p style="margin:12px 0 0;font-size:12px;color:${CI.mute}">* Live-Abrufe = eine KI hat die Seite in dem Moment geladen, ` +
      `in dem ein Mensch ihr eine Frage gestellt hat — das direkteste Signal für KI-Sichtbarkeit.</p>`) +
    card(h2('Diese Seiten lesen die KIs am häufigsten') + aiPages) +
    card(h2('Google Search Console') + gscBlock) +
    card(h2('Seiten-Gesundheit') +
      `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
      healthRow('Titel über 60 Zeichen', 'titles_over_60') +
      healthRow('Seiten ohne Beschreibung', 'desc_missing') +
      healthRow('Artikel mit FAQ-Markup', 'faq_pages', false) +
      healthRow('Interne Themen-Links', 'internal_links', false) +
      healthRow('Bilder ohne Alt-Text', 'alt_missing') +
      healthRow('Seiten mit veralteter Steuerzahl (12,5 %)', 'old_tax_rate') +
      healthRow('Ø Server-Antwortzeit (ms)', 'ttfb_avg_ms', false) +
      `</table>` +
      `<p style="margin:12px 0 0;font-size:13px;color:${CI.mute}">llms.txt: ${m.llms_txt ? 'vorhanden ✓' : 'fehlt (liegt bei Giona)'} · ` +
      `Organische Besuche der Woche: Google ${fmtNum(data.organic.google)}, Bing ${fmtNum(data.organic.bing)}, aus KI-Chats ${fmtNum(data.organic.ki)}</p>`) +
    (empfehlungen ? card(h2('Empfehlungen') + empfehlungen) : '') +
    `<p style="font-size:12px;color:${CI.mute};margin-top:26px">Automatisch erstellt aus Crawler-Protokoll, täglichem Seiten-Check, ` +
    `Search Console und dem eigenen Web-Analytics. Fragen an Sven.</p>` +
    `</div></body></html>`
}

async function sendReportMail(recipients: string[], subject: string, link: string, summary: string) {
  const user = Deno.env.get('SMTP_USER') ?? ''
  const pass = Deno.env.get('SMTP_PASS') ?? ''
  if (!user || !pass) { console.warn('[seo-insights] SMTP fehlt — Mailversand übersprungen'); return false }
  const client = new SMTPClient({
    connection: { hostname: 'smtp.ionos.de', port: 465, tls: true, auth: { username: user, password: pass } },
  })
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">` +
    `<h2 style="color:${CI.navy}">SEO-Wochenbericht ist da</h2>` +
    `<p style="line-height:1.6">${esc(summary)}</p>` +
    `<p><a href="${link}" style="display:inline-block;background:${CI.coral};color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Bericht öffnen</a></p></div>`
  try {
    for (const to of recipients) {
      await client.send({ from: `Happy Property <${user}>`, to, subject, content: 'auto', html })
    }
    return true
  } catch (err) { console.warn('[seo-insights] Mail:', err); return false }
  finally { try { await client.close() } catch { /* egal */ } }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    if (req.method === 'GET') {
      const token = new URL(req.url).searchParams.get('t') ?? ''
      if (!token) return json({ error: 'Token fehlt' }, 400)
      const { data } = await sb.from('seo_reports').select('html').eq('token', token).maybeSingle()
      if (!data) return json({ error: 'Report nicht gefunden' }, 404)
      return new Response(data.html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } })
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>

    // ── Bot-Hit vom WordPress-Snippet ──
    if (body.a === 'hit') {
      const secret = Deno.env.get('SEO_INGEST_SECRET') ?? ''
      if (!secret || body.secret !== secret) return json({ error: 'ungültig' }, 401)
      const ua = String(body.ua ?? '')
      const cls = classifyUa(ua) ?? { bot: String(body.bot ?? 'unbekannt'), engine: 'other', kind: 'crawl' as const }
      const path = String(body.path ?? '/').slice(0, 500)
      const { error } = await sb.from('seo_bot_hits')
        .insert({ bot: cls.bot, engine: cls.engine, kind: cls.kind, path, status: 200, site: SITE })
      if (error) throw error
      return json({ success: true })
    }

    // ── Tages-Schnappschuss ──
    if (body.action === 'snapshot') {
      const result = await buildSnapshot(sb)
      return json({ success: true, ...result })
    }

    // ── Wochenbericht ──
    if (body.action === 'report') {
      if (body.cron === true && !(cyWeekday() === 'Mon' && cyHour() === 7)) {
        return json({ success: true, skipped: 'nicht Montag 07:00 Zypern-Zeit' })
      }
      const data = await collectWeek(sb)
      const weekStart = cyDateStr(data.from), weekEnd = cyDateStr(data.to)
      if (body.force !== true) {
        const { data: existing } = await sb.from('seo_reports').select('id').eq('week_start', weekStart).maybeSingle()
        if (existing) return json({ success: true, skipped: 'Report für diese Woche existiert schon' })
      }
      const analysis = await analyze(data)
      const html = renderHtml(data, analysis)
      const recipients = (Deno.env.get('SEO_REPORT_RECIPIENTS') ?? '').split(',').map(s => s.trim()).filter(Boolean)
      const to = recipients.length ? recipients : DEFAULT_RECIPIENTS
      const { data: saved, error } = await sb.from('seo_reports')
        .insert({ week_start: weekStart, week_end: weekEnd, html, stats: { cur: data.cur, organic: data.organic, analysis }, sent_to: to })
        .select('token').single()
      if (error) throw error
      const link = `${Deno.env.get('SUPABASE_URL')}/functions/v1/seo-insights?t=${saved.token}`
      const mailed = await sendReportMail(to, `SEO-Wochenbericht ${deDate(data.from)}–${deDate(data.to)}`, link, analysis.zusammenfassung)
      console.log(`[seo-insights] Report ${weekStart}: gespeichert, Mail=${mailed}`)
      return json({ success: true, token: saved.token, mailed })
    }

    return json({ error: 'unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[seo-insights]', msg)
    return json({ error: msg }, 500)
  }
})
