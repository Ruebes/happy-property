// Edge Function: wa-weekly-report — Woechentliche Web-/Funnel-Auswertung.
// Aggregiert die letzten 7 Tage (Web-Analytics + Termin-Funnel + Engagement +
// Termine), laesst Claude eine Analyse schreiben (warum wurde nicht gebucht,
// was verbessern), rendert einen grafischen HTML-Report und mailt den Link
// an Sven + Giona.
//
//   GET  ?t=<token>                       → gespeicherten Report als HTML ausliefern
//   POST { action:'run', force?, cron? }  → Report erzeugen + versenden
//     cron:true  → laeuft nur, wenn es in Zypern gerade 07:00 ist (der Job ist
//                  wegen Sommer-/Winterzeit zweimal in UTC geplant: 04:00 + 05:00)
//     force:true → Dedupe umgehen (manueller Neuversand)
//
// ── Secrets ──
//   SMTP_USER / SMTP_PASS   (Ionos, wie send-email)
//   ANTHROPIC_API_KEY       (wie ai-draft-reply)
//   WA_REPORT_RECIPIENTS    optional, Komma-Liste; Default Sven + Giona
//
// ── Deployment ──
//   supabase functions deploy wa-weekly-report --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'
import { CI } from '../_shared/brand.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const TZ = 'Asia/Nicosia'
const DEFAULT_RECIPIENTS = ['sven@happy-property.com', 'giona.schauf@googlemail.com']

const cyHour = (d = new Date()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d)) % 24
const cyDateStr = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const deDate = (d: Date) =>
  new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmtNum = (n: number) => new Intl.NumberFormat('de-DE').format(n)
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min`

// ── Datensammlung ────────────────────────────────────────────────────────────
interface Kpis {
  sessions: number; visitors: number; pageviews: number; clicks: number
  avg_duration_s: number; bounce_pct: number; avg_scroll_pct: number; with_replay: number
}
interface FunnelStats {
  sessions: number; bookings: number; direct_sessions: number; direct_bookings: number
  steps: Record<string, number>
  sources: { source: string; sessions: number; leads: number; bookings: number }[]
  variants: unknown[]
  answers: Record<string, { answer: string; n: number }[]>
}
interface ReportData {
  from: Date; to: Date; prevFrom: Date
  kpis: Kpis; kpisPrev: Kpis
  daily: { day: string; sessions: number; visitors: number; pageviews: number }[]
  sites: { site: string; sessions: number }[]
  siteKpis: { site: string; kpis: Kpis }[]
  pages: { site: string; path: string; views: number; sessions: number }[]
  sources: { source: string; sessions: number; visitors: number }[]
  devices: { device: string; browser: string; sessions: number }[]
  funnel: FunnelStats | null
  funnelPrev: FunnelStats | null
  appointments: number
  appointmentsPrev: number
  deckViews: number
  leadSessions: number
}

async function collect(supabase: ReturnType<typeof createClient>): Promise<ReportData> {
  const to = new Date()
  const from = new Date(to.getTime() - 7 * 864e5)
  const prevFrom = new Date(from.getTime() - 7 * 864e5)
  const p  = { p_from: from.toISOString(), p_to: to.toISOString(), p_site: null as string | null }
  const pp = { p_from: prevFrom.toISOString(), p_to: from.toISOString(), p_site: null as string | null }

  const [k, kp, d, pg, so, de, si] = await Promise.all([
    supabase.rpc('hp_wa_kpis', p), supabase.rpc('hp_wa_kpis', pp),
    supabase.rpc('hp_wa_daily', p),
    supabase.rpc('hp_wa_pages', { ...p, p_limit: 12 }),
    supabase.rpc('hp_wa_sources', p),
    supabase.rpc('hp_wa_devices', p),
    supabase.rpc('hp_wa_sites', { p_from: p.p_from, p_to: p.p_to }),
  ])

  const sites = (si.data as { site: string; sessions: number }[]) ?? []
  const siteKpis: { site: string; kpis: Kpis }[] = []
  for (const s of sites.slice(0, 8)) {
    const r = await supabase.rpc('hp_wa_kpis', { ...p, p_site: s.site })
    if (r.data) siteKpis.push({ site: s.site, kpis: r.data as Kpis })
  }

  const [fs, fsPrev] = await Promise.all([
    supabase.rpc('funnel_stats', { p_from: p.p_from, p_to: p.p_to }),
    supabase.rpc('funnel_stats', { p_from: pp.p_from, p_to: pp.p_to }),
  ])

  // Termine (nur Kundentermine, interne raus)
  const countAppts = async (f: string, t: string) => {
    const { data } = await supabase.from('crm_appointments')
      .select('id, internal').gte('created_at', f).lt('created_at', t)
    return ((data as { internal: boolean | null }[]) ?? []).filter(a => !a.internal).length
  }
  const appointments = await countAppts(p.p_from, p.p_to)
  const appointmentsPrev = await countAppts(pp.p_from, pp.p_to)

  const { count: deckViews } = await supabase.from('engagement_events')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'deck_view').gte('occurred_at', p.p_from).lt('occurred_at', p.p_to)

  const { count: leadSessions } = await supabase.from('web_sessions')
    .select('id', { count: 'exact', head: true })
    .not('lead_id', 'is', null).gte('started_at', p.p_from).lt('started_at', p.p_to)

  const empty: Kpis = { sessions: 0, visitors: 0, pageviews: 0, clicks: 0, avg_duration_s: 0, bounce_pct: 0, avg_scroll_pct: 0, with_replay: 0 }
  return {
    from, to, prevFrom,
    kpis: (k.data as Kpis) ?? empty,
    kpisPrev: (kp.data as Kpis) ?? empty,
    daily: (d.data as ReportData['daily']) ?? [],
    sites, siteKpis,
    pages: (pg.data as ReportData['pages']) ?? [],
    sources: (so.data as ReportData['sources']) ?? [],
    devices: (de.data as ReportData['devices']) ?? [],
    funnel: (fs.data as FunnelStats) ?? null,
    funnelPrev: (fsPrev.data as FunnelStats) ?? null,
    appointments, appointmentsPrev,
    deckViews: deckViews ?? 0,
    leadSessions: leadSessions ?? 0,
  }
}

// ── Claude-Analyse ───────────────────────────────────────────────────────────
interface Analysis { zusammenfassung: string; nicht_gebucht: string; empfehlungen: { titel: string; text: string }[] }

async function analyze(data: ReportData): Promise<Analysis> {
  const fallback: Analysis = {
    zusammenfassung: 'Die automatische KI-Analyse war diese Woche nicht verfügbar — die Zahlen oben gelten unverändert.',
    nicht_gebucht: data.funnel
      ? `${data.funnel.sessions} Funnel-Besuche führten zu ${data.funnel.bookings} Buchungen. Der größte Absprung liegt typischerweise zwischen Kontaktformular und Terminwahl.`
      : 'Keine Funnel-Daten im Zeitraum.',
    empfehlungen: [{ titel: 'Datenbasis aufbauen', text: 'Mindestens eine volle Woche Tracking-Daten sammeln, dann liefert der Report belastbare Empfehlungen.' }],
  }
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  if (!key) return fallback

  const compact = {
    zeitraum: `${deDate(data.from)}–${deDate(data.to)}`,
    web: { diese_woche: data.kpis, vorwoche: data.kpisPrev, sites: data.siteKpis, top_seiten: data.pages, quellen: data.sources, geraete: data.devices },
    termin_funnel: { diese_woche: data.funnel, vorwoche: data.funnelPrev },
    termine_gebucht: { diese_woche: data.appointments, vorwoche: data.appointmentsPrev },
    deck_ansichten: data.deckViews,
    erkannte_kunden_sessions: data.leadSessions,
  }
  const prompt =
    `Du bist Web-/Conversion-Analyst für Happy Property (Immobilien-Investments Zypern, deutschsprachige Kapitalanleger). ` +
    `Getrackte Seiten: happy-property.com (CRM-Kundenseiten + Termin-Funnel /termin), happy-property.de (Landingpages) und steuervorteil-Landingpages. ` +
    `Ziel-Conversion: gebuchter Beratungstermin über den Funnel.\n\n` +
    `Wochendaten (JSON):\n${JSON.stringify(compact)}\n\n` +
    `Funnel-Schritte in Reihenfolge: view → start → Fragen → contact_view → contact_submitted → slots_view → slot_picked → Buchung.\n\n` +
    `Antworte NUR mit validem JSON, deutsch, Du-Form, konkret und ohne Floskeln:\n` +
    `{"zusammenfassung":"3-5 Sätze: wichtigste Entwicklungen der Woche inkl. Vergleich zur Vorwoche",` +
    `"nicht_gebucht":"4-6 Sätze: Analyse, WO im Funnel die Besucher abspringen, die keinen Termin gebucht haben, und die wahrscheinlichsten Gründe (aus den Zahlen abgeleitet, keine Erfindungen)",` +
    `"empfehlungen":[{"titel":"...","text":"1-3 Sätze, konkret umsetzbar"}]} — 3 bis 5 Empfehlungen zur Verbesserung der Conversion-Rate. ` +
    `Wenn die Datenbasis noch dünn ist (Tracking neu), sag das ehrlich und leite die Analyse aus den vorhandenen Funnel-/Termin-Zahlen ab.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) { console.warn('[wa-weekly-report] Anthropic', res.status); return fallback }
    const body = await res.json() as { content?: { text?: string }[] }
    const text = body.content?.[0]?.text ?? ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const parsed = JSON.parse(m[0]) as Analysis
    if (!parsed.zusammenfassung || !Array.isArray(parsed.empfehlungen)) return fallback
    return parsed
  } catch (err) {
    console.warn('[wa-weekly-report] analyze:', err)
    return fallback
  }
}

// ── HTML-Report ──────────────────────────────────────────────────────────────
function delta(now: number, prev: number): string {
  if (!prev) return ''
  const pct = Math.round(((now - prev) / prev) * 100)
  const up = pct >= 0
  return `<span style="font-size:12px;color:${up ? '#1f9d55' : '#d33'};font-weight:600">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span>`
}

function barChart(daily: ReportData['daily']): string {
  if (!daily.length) return `<p style="color:${CI.mute};font-size:14px">Noch keine Web-Tracking-Daten — die Sammlung ist gerade gestartet.</p>`
  const w = 660, h = 180, pad = 26
  const max = Math.max(1, ...daily.map(d => d.sessions))
  const bw = Math.min(60, (w - pad * 2) / daily.length - 8)
  const bars = daily.map((d, i) => {
    const x = pad + i * ((w - pad * 2) / daily.length) + 4
    const bh = Math.max(2, (d.sessions / max) * (h - 55))
    const y = h - 35 - bh
    return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="4" fill="${CI.coral}"/>` +
      `<text x="${x + bw / 2}" y="${y - 6}" text-anchor="middle" font-size="11" fill="${CI.navy}" font-weight="600">${d.sessions}</text>` +
      `<text x="${x + bw / 2}" y="${h - 16}" text-anchor="middle" font-size="10" fill="${CI.mute}">${d.day.slice(8, 10)}.${d.day.slice(5, 7)}.</text>`
  }).join('')
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`
}

function funnelChart(f: FunnelStats | null): string {
  if (!f) return `<p style="color:${CI.mute};font-size:14px">Keine Funnel-Daten im Zeitraum.</p>`
  const stepDefs: [string, string][] = [
    ['view', 'Funnel aufgerufen'], ['start', 'Gestartet'],
    ['contact_view', 'Kontaktformular gesehen'], ['contact_submitted', 'Kontakt abgeschickt'],
    ['slots_view', 'Terminauswahl gesehen'], ['slot_picked', 'Termin gewählt'],
  ]
  const rows = stepDefs.map(([k, label]) => ({ label, n: f.steps?.[k] ?? 0 }))
  rows.push({ label: 'Termin gebucht ✓', n: f.bookings })
  const max = Math.max(1, ...rows.map(r => r.n))
  return rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1].n : r.n
    const drop = i > 0 && prev > 0 ? Math.round(100 * (1 - r.n / prev)) : 0
    const wPct = Math.max(3, Math.round((r.n / max) * 100))
    const last = i === rows.length - 1
    return `<div style="margin:7px 0">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:${CI.navy};margin-bottom:3px">
        <span>${esc(r.label)}</span>
        <span><b>${fmtNum(r.n)}</b>${i > 0 && drop > 0 ? ` <span style="color:#d33;font-size:11px">−${drop}%</span>` : ''}</span>
      </div>
      <div style="background:#f1ece0;border-radius:6px;height:14px"><div style="width:${wPct}%;height:14px;border-radius:6px;background:${last ? '#1f9d55' : CI.coral}"></div></div>
    </div>`
  }).join('')
}

function tableRows(rows: string[][], right = [1]): string {
  return rows.map(r =>
    `<tr>${r.map((c, i) =>
      `<td style="padding:7px 10px;border-bottom:1px solid ${CI.line};font-size:13px;color:${CI.ink};${right.includes(i) ? 'text-align:right' : ''}">${c}</td>`
    ).join('')}</tr>`
  ).join('')
}

function card(title: string, inner: string): string {
  return `<div style="background:#fff;border:1px solid ${CI.line};border-radius:16px;padding:20px 22px;margin:16px 0">
    <h2 style="font-family:'Playfair Display',Georgia,serif;font-size:19px;color:${CI.navy};margin:0 0 12px">${title}</h2>${inner}</div>`
}

function buildHtml(data: ReportData, a: Analysis, kw: number): string {
  const k = data.kpis, kp = data.kpisPrev
  const kpi = (label: string, val: string, d: string) =>
    `<td style="padding:6px"><div style="background:#fff;border:1px solid ${CI.line};border-radius:14px;padding:14px 16px;text-align:center">
      <div style="font-size:11px;color:${CI.mute};text-transform:uppercase;letter-spacing:.4px">${label}</div>
      <div style="font-size:24px;font-weight:700;color:${CI.navy};margin-top:3px">${val}</div><div>${d}</div></div></td>`

  const siteRows = data.siteKpis.map(s => [
    esc(s.site), fmtNum(s.kpis.visitors), fmtNum(s.kpis.sessions), fmtNum(s.kpis.pageviews),
    fmtDur(s.kpis.avg_duration_s), `${s.kpis.bounce_pct}%`,
  ])
  const pageRows = data.pages.map(pg => [`${esc(pg.site)}<span style="color:${CI.mute}">${esc(pg.path)}</span>`, fmtNum(pg.views)])
  const srcRows = data.sources.slice(0, 10).map(s => [esc(s.source), fmtNum(s.sessions)])
  const devAgg = new Map<string, number>()
  for (const d of data.devices) devAgg.set(d.device, (devAgg.get(d.device) ?? 0) + d.sessions)
  const devRows = [...devAgg.entries()].sort((x, y) => y[1] - x[1]).map(([d, n]) => [esc(d), fmtNum(n)])

  const emp = a.empfehlungen.map((e, i) =>
    `<div style="display:flex;gap:12px;margin:12px 0">
      <div style="min-width:28px;height:28px;border-radius:50%;background:${CI.coral};color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:14px">${i + 1}</div>
      <div><div style="font-weight:700;color:${CI.navy};font-size:14px">${esc(e.titel)}</div>
      <div style="font-size:13px;color:${CI.ink};margin-top:2px;line-height:1.5">${esc(e.text)}</div></div></div>`).join('')

  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Wochenreport KW ${kw} — Happy Property</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>body{margin:0;background:${CI.cream};font-family:Montserrat,Arial,sans-serif}</style></head>
<body><div style="max-width:760px;margin:0 auto;padding:28px 16px 60px">
  <div style="background:${CI.navy};border-radius:18px;padding:28px 26px;color:#fff">
    <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${CI.gold}">Happy Property · Web-Analytics</div>
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:28px;margin:8px 0 4px">Wochenreport KW ${kw}</h1>
    <div style="font-size:14px;color:#cdd6e0">${deDate(data.from)} – ${deDate(data.to)} · Websites, Landingpages &amp; Termin-Funnel</div>
  </div>

  ${card('Zusammenfassung', `<p style="font-size:14px;line-height:1.65;color:${CI.ink};margin:0">${esc(a.zusammenfassung)}</p>`)}

  <table style="width:100%;border-collapse:collapse"><tr>
    ${kpi('Besucher', fmtNum(k.visitors), delta(k.visitors, kp.visitors))}
    ${kpi('Sitzungen', fmtNum(k.sessions), delta(k.sessions, kp.sessions))}
    ${kpi('Seitenaufrufe', fmtNum(k.pageviews), delta(k.pageviews, kp.pageviews))}
  </tr><tr>
    ${kpi('Ø Besuchsdauer', fmtDur(k.avg_duration_s), delta(k.avg_duration_s, kp.avg_duration_s))}
    ${kpi('Absprungrate', `${k.bounce_pct}%`, '')}
    ${kpi('Termine gebucht', fmtNum(data.appointments), delta(data.appointments, data.appointmentsPrev))}
  </tr></table>

  ${card('Sitzungen pro Tag', barChart(data.daily))}

  ${data.siteKpis.length ? card('Websites im Vergleich',
    `<table style="width:100%;border-collapse:collapse"><tr>
      ${['Website', 'Besucher', 'Sitzungen', 'Aufrufe', 'Ø Dauer', 'Absprung'].map((h, i) => `<th style="padding:7px 10px;font-size:11px;color:${CI.mute};text-transform:uppercase;text-align:${i ? 'right' : 'left'};border-bottom:2px solid ${CI.line}">${h}</th>`).join('')}
    </tr>${tableRows(siteRows, [1, 2, 3, 4, 5])}</table>`) : ''}

  ${card('Termin-Funnel', funnelChart(data.funnel) +
    (data.funnel ? `<p style="font-size:12px;color:${CI.mute};margin:10px 0 0">Zusätzlich ${fmtNum(data.funnel.direct_sessions)} Direkteinstiege (Newsletter/Links) mit ${fmtNum(data.funnel.direct_bookings)} Buchungen · ${fmtNum(data.deckViews)} Exposé-Ansichten · ${fmtNum(data.leadSessions)} Website-Besuche erkannter Kunden</p>` : ''))}

  ${card('Warum wurde nicht gebucht?', `<p style="font-size:14px;line-height:1.65;color:${CI.ink};margin:0">${esc(a.nicht_gebucht)}</p>`)}

  ${card('Empfehlungen zur Conversion-Verbesserung', emp)}

  <table style="width:100%"><tr><td style="width:50%;vertical-align:top;padding-right:8px">
    ${card('Top-Seiten', `<table style="width:100%;border-collapse:collapse">${tableRows(pageRows)}</table>`)}
  </td><td style="width:50%;vertical-align:top;padding-left:8px">
    ${card('Quellen', `<table style="width:100%;border-collapse:collapse">${tableRows(srcRows)}</table>`)}
    ${card('Geräte', `<table style="width:100%;border-collapse:collapse">${tableRows(devRows)}</table>`)}
  </td></tr></table>

  <p style="font-size:12px;color:${CI.mute};text-align:center;margin-top:24px">
    Automatisch erstellt · Details, Heatmaps &amp; Session-Replays im CRM unter
    <a href="https://portal.happy-property.com/admin/crm/webanalytics" style="color:${CI.coral}">Web-Analytics</a>
  </p>
</div></body></html>`
}

// ── Versand ──────────────────────────────────────────────────────────────────
async function sendMail(recipients: string[], subject: string, link: string, data: ReportData, a: Analysis): Promise<string[]> {
  const user = Deno.env.get('SMTP_USER') ?? ''
  const pass = Deno.env.get('SMTP_PASS') ?? ''
  if (!user || !pass) { console.warn('[wa-weekly-report] SMTP fehlt'); return [] }
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:${CI.ink}">
      <h2 style="color:${CI.navy}">📊 ${esc(subject)}</h2>
      <p style="line-height:1.6">${esc(a.zusammenfassung)}</p>
      <p style="line-height:1.6"><b>${fmtNum(data.kpis.visitors)}</b> Besucher · <b>${fmtNum(data.kpis.sessions)}</b> Sitzungen · <b>${fmtNum(data.appointments)}</b> Termine gebucht</p>
      <p style="margin:26px 0"><a href="${link}" style="background:${CI.coral};color:#fff;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700">Kompletten Report öffnen</a></p>
      <p style="font-size:12px;color:${CI.mute}">Mit Grafiken, Funnel-Analyse und Empfehlungen. Der Link bleibt dauerhaft gültig.</p>
    </div>`
  const sent: string[] = []
  const client = new SMTPClient({
    connection: { hostname: 'smtp.ionos.de', port: 465, tls: true, auth: { username: user, password: pass } },
  })
  try {
    for (const to of recipients) {
      try {
        await client.send({ from: `Happy Property Analytics <${user}>`, to, subject, content: 'Report: ' + link, html })
        sent.push(to)
        console.log(`[wa-weekly-report] Mail an ${to}`)
      } catch (err) {
        console.error(`[wa-weekly-report] Mail an ${to} fehlgeschlagen:`, err)
      }
    }
  } finally {
    try { await client.close() } catch { /* egal */ }
  }
  return sent
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    if (req.method === 'GET') {
      const t = new URL(req.url).searchParams.get('t')
      if (!t) return json({ ok: true, service: 'wa-weekly-report' })
      const { data } = await supabase.from('web_reports').select('html').eq('token', t).maybeSingle()
      if (!data) return new Response('Report nicht gefunden', { status: 404, headers: CORS })
      return new Response((data as { html: string }).html, {
        headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=300' },
      })
    }

    if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
    const body = await req.json().catch(() => ({})) as { action?: string; force?: boolean; cron?: boolean; skipMail?: boolean }
    if (body.action !== 'run') return json({ error: 'unknown action' }, 400)

    // Cron feuert 04:00 UTC UND 05:00 UTC (Sommer-/Winterzeit) — nur der Lauf,
    // bei dem es in Zypern wirklich 07:00 ist, geht durch.
    if (body.cron && cyHour() !== 7) {
      return json({ success: true, skipped: 'not 07:00 Cyprus time' })
    }

    const now = new Date()
    const weekEnd = cyDateStr(now)
    if (!body.force) {
      const { data: dup } = await supabase.from('web_reports').select('id').eq('week_end', weekEnd).limit(1)
      if (dup && dup.length) return json({ success: true, skipped: 'report exists for ' + weekEnd })
    }

    console.log('[wa-weekly-report] sammle Daten …')
    const data = await collect(supabase)
    console.log('[wa-weekly-report] Claude-Analyse …')
    const a = await analyze(data)

    // ISO-Kalenderwoche
    const d0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    d0.setUTCDate(d0.getUTCDate() + 4 - (d0.getUTCDay() || 7))
    const kw = Math.ceil((((d0.getTime() - Date.UTC(d0.getUTCFullYear(), 0, 1)) / 864e5) + 1) / 7)

    const html = buildHtml(data, a, kw)
    const { data: report, error: insErr } = await supabase.from('web_reports')
      .insert({ week_start: cyDateStr(data.from), week_end: weekEnd, html, stats: { kpis: data.kpis, funnel: data.funnel, appointments: data.appointments, analyse: a } })
      .select('token').single()
    if (insErr) throw new Error('Report speichern: ' + insErr.message)
    const token = (report as { token: string }).token
    // Ausgeliefert wird ueber die WP-Seite happy-property.de/wochenreport/
    // (Viewer laedt das HTML per RPC hp_wa_report_html) — die Supabase-Domains
    // (functions UND storage) erzwingen text/plain fuer HTML-Antworten.
    // Alternativ funktioniert auch portal.happy-property.com/report/<token>.
    const link = `https://happy-property.de/wochenreport/?t=${token}`

    const recipients = (Deno.env.get('WA_REPORT_RECIPIENTS') ?? DEFAULT_RECIPIENTS.join(','))
      .split(',').map(s => s.trim()).filter(Boolean)
    const subject = `Wochenreport Website & Termin-Funnel — KW ${kw}`
    const sent = body.skipMail ? [] : await sendMail(recipients, subject, link, data, a)
    if (sent.length) await supabase.from('web_reports').update({ sent_to: sent }).eq('token', token)

    return json({ success: true, link, sent, kw })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[wa-weekly-report]', msg)
    return json({ error: msg }, 500)
  }
})
