// zypern-report: monatlicher „Zypern-Report" als PDF-Lead-Magnet.
//
// Ein gebrandetes, mehrseitiges PDF „Zypern-Report <Monat Jahr>: Was sich auf
// Zypern gerade tut" für (angehende) Käufer aus Deutschland. Neue Ausgabe jeden
// Monat per Cron, immer erreichbar unter der festen URL
//   <storage>/web-reports/zypern-report/aktuell.pdf   (+ Archiv YYYY-MM.pdf)
// und öffentlich verlinkt als https://portal.happy-property.com/zypern-report
// (Vercel-Rewrite → GET dieser Function → 302 auf aktuell.pdf).
//
// Aufrufe:
//   GET  ?c=<ref>            ohne Login. Zählt den Klick in social_keyword_replies
//                            (RPC zypern_report_click, Bots/HEAD zählen nicht) und
//                            leitet per 302 auf das aktuelle PDF weiter.
//   POST {action:'build', force?, month?}   Recherche (Claude + Websuche) → PDF →
//                            Upload → zypern_reports live. Antwortet sofort, die
//                            Arbeit läuft in EdgeRuntime.waitUntil. Schlägt der Bau
//                            fehl, bleibt aktuell.pdf unangetastet. Cron am 1. bis 3.
//                            um 04:00 UTC (live = überspringen), Zeitlimit 330 s,
//                            'building' älter als 15 Min. = abgebrochen. Scheitert der
//                            letzte Versuch, bekommt der Admin eine Aufgabe.
//   POST {action:'status'}   letzte Ausgaben.
//   POST {action:'preview', month?, content?}  rendert nur (liefert application/pdf),
//                            lädt nichts hoch. Für Layout-Arbeit.
//   POST {action:'rerender', month}  rendert eine Ausgabe mit gespeichertem Inhalt
//                            neu und lädt sie hoch (z.B. nach Textänderung der
//                            festen Seiten), ohne neue Recherche.
// Schutz (alles außer GET): Service-Role-Key ODER Header x-cron-secret =
// connector_secrets CRON_SECRET_SOCIAL ODER eingeloggter Nutzer mit Rolle
// admin/verwalter bzw. permissions.funnel = true.
//
// PDF: pdfmake 0.2 (Node-API, läuft in der Edge Runtime) mit eingebetteten
// CI-Schriften Playfair Display + Montserrat. Schriften kommen aus einer eigenen
// Kopie im Storage (web-reports/zypern-report/_fonts), sonst von Google; fehlt
// eine, bricht der Bau ab (nie stilles Helvetica).
//
// Deploy: supabase functions deploy zypern-report --no-verify-jwt
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { Buffer } from 'node:buffer'
import PdfPrinter from 'npm:pdfmake@0.2.23/src/printer.js'
import { CI } from '../_shared/brand.ts'

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://vjlwgajmtqlwjjreowbu.supabase.co'
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

const BUCKET = 'web-reports'
const DIR = 'zypern-report'
const PUBLIC_BASE = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${DIR}`
const CURRENT_URL = `${PUBLIC_BASE}/aktuell.pdf`
const BOOKING_URL = 'https://portal.happy-property.com/termin?src=zypern-report'
const LOGO_URL = `${SUPABASE_URL}/storage/v1/object/public/Assets/Logo/logo-schriftzug.jpeg`
const MAX_PDF_BYTES = 5 * 1024 * 1024

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-5']

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ── Typen ────────────────────────────────────────────────────────────────────
interface KeyFact { label: string; value: string; source_name: string; source_url: string }
interface NewsItem { heading: string; text: string; meaning?: string; source_name: string; source_url: string }
interface ReportContent {
  subtitle: string
  intro?: string
  key_facts: KeyFact[]
  news: NewsItem[]
  research_from?: string
  research_to?: string
  researched_at?: string
  model?: string
  research?: string
}
interface ReportRow {
  id: string; month: string; status: 'building' | 'live' | 'failed'
  content: ReportContent | null; pdf_url: string | null; error: string | null
  created_at: string; started_at: string | null; published_at: string | null
}

// ── Zeit (Zypern) ────────────────────────────────────────────────────────────
function cyOffsetMinutes(d: Date): number {
  const m: Record<string, string> = {}
  for (const pt of new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Nicosia', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d)) m[pt.type] = pt.value
  return (Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second) - d.getTime()) / 60000
}
const cyYmd = (d: Date) => new Date(d.getTime() + cyOffsetMinutes(d) * 60000).toISOString().slice(0, 10)
const cyMonth = (d = new Date()) => cyYmd(d).slice(0, 7)
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS_DE[m - 1]} ${y}`
}
const deDate = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return `${d}. ${MONTHS_DE[m - 1]} ${y}` }

// ── Textregeln ───────────────────────────────────────────────────────────────
// Kein Gedanken- oder Bis-Strich (Sven-Regel), kein Markdown, keine Doppel-Leerzeichen.
function noDash(s: string): string {
  return s
    .replace(/(\d)\s*[‒–—―]\s*(\d)/g, '$1-$2')
    .replace(/\s*[‒–—―]\s*/g, ' - ')
}
// Zeichen, die alle eingebetteten Schriften darstellen können. Wird beim Laden der
// Schriften einmal aus deren cmap-Tabellen berechnet (Schnittmenge aller Schnitte).
// Bis dahin gilt die Liste WIN1252 (Latin-1 + übliche Typografie), die jede
// Google-Latin-Schrift abdeckt.
let _glyphs: Set<number> | null = null
const WIN1252 = /[\x20-\x7e -ÿŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]/
function fitGlyphs(s: string): string {
  const ok = (ch: string) => {
    const cp = ch.codePointAt(0) ?? 0
    return cp === 0x20 || cp === 0x0a || (_glyphs ? _glyphs.has(cp) : WIN1252.test(ch))
  }
  let out = ''
  for (const ch of s) {
    if (ok(ch)) out += ch
    else for (const part of ch.normalize('NFD')) if (ok(part)) out += part // „ş" → „s", Rest fällt weg
  }
  return out
}
function clean(s: unknown, max = 2000): string {
  if (typeof s !== 'string') return ''
  const typo = s.normalize('NFC')
    .replace(/[‐‑−]/g, '-') // Viertelgeviert-Bindestrich, geschützter Bindestrich, Minus
    .replace(/[­​-‍⁠﻿]/g, '') // weiches Trennzeichen, Nullbreite
    .replace(/[  -  ]/g, ' ') // geschützte/schmale Leerzeichen
    .replace(/≈\s*/g, 'rund ')
    .replace(/→/g, '-')
  let t = fitGlyphs(noDash(typo).replace(/\r\n?/g, '\n').replace(/[\t\f\v]/g, ' '))
    .replace(/\*\*|__/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > max) {
    const cut = t.slice(0, max)
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    t = lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, '') + ' …'
  }
  return t
}
function normUrl(u: string): string {
  try {
    const x = new URL(u.trim())
    x.hash = ''
    const drop: string[] = []
    x.searchParams.forEach((_v, k) => { if (/^utm_|^fbclid$|^gclid$/i.test(k)) drop.push(k) })
    drop.forEach(k => x.searchParams.delete(k))
    return `${x.protocol}//${x.host.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`
  } catch { return '' }
}
const hostOf = (u: string) => { try { return new URL(u).host.replace(/^www\./, '') } catch { return '' } }

// ── Claude ───────────────────────────────────────────────────────────────────
async function claude(opts: { system: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Record<string, unknown> & { _model: string }> {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY fehlt')
  let lastErr = ''
  for (const model of MODELS) {
    opts.signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180000)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: opts.max_tokens ?? 4000, system: opts.system, messages: opts.messages, ...(opts.tools ? { tools: opts.tools } : {}), ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}) }),
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    })
    const d = await res.json().catch(() => ({}))
    if (res.ok) return { ...(d as Record<string, unknown>), _model: model }
    lastErr = JSON.stringify(d).slice(0, 300)
    if (!/model|not_found|overloaded|rate.?limit|529|429/i.test(lastErr) && res.status < 500) break
  }
  throw new Error(`Claude: ${lastErr}`)
}

const WRITING_RULES = `SCHREIBREGELN (verbindlich):
- Deutsch, echte Umlaute (ä, ö, ü, ß), niemals ae/oe/ue als Ersatz.
- Du-Form, freundlich, klar, sachlich. Wie ein erfahrener Makler, der einem Bekannten die Lage erklärt.
- NIEMALS Gedankenstrich oder Bis-Strich (— oder –). Nur den normalen Bindestrich "-", oder den Satz teilen. Auch bei Spannen: "2024-2025".
- Nicht nach KI klingen: keine Floskeln wie "In der heutigen Zeit", "Es ist nicht nur ..., sondern auch ...", "Fazit:", keine aufgeblasenen Adjektive, keine rhetorischen Ein-Wort-Fragen.
- Keine Zahl, die nicht wörtlich in der Recherche steht. Nichts schätzen, nichts runden, nichts hochrechnen.
- Keine Renditeversprechen, keine Renditeprognosen, keine Wertsteigerungsprognosen in Zahlen, kein "garantiert", keine Anlageempfehlung.
- Kein Markdown.`

interface Research { text: string; urls: Map<string, { url: string; title: string }>; model: string }

async function research(from: string, to: string, signal?: AbortSignal): Promise<Research> {
  const system = `Du bist Research-Redakteur für den monatlichen „Zypern-Report" von Happy Property Cyprus (Sven Rüprich, Paphos). Leser sind deutschsprachige Käufer und Kapitalanleger, die über eine Immobilie auf Zypern nachdenken.

Recherchiere per Websuche, was sich zwischen ${from} und ${to} auf Zypern getan hat. Themen nach Priorität:
1. Immobilienmarkt in Zahlen: Kaufverträge und Verkäufe an Ausländer (Department of Lands and Surveys), Preisindizes (Central Bank of Cyprus Residential Property Price Index, RICS/KPMG), Baugenehmigungen und Baukosten (CYSTAT). Besonders Paphos, Limassol, Larnaka.
2. Recht und Steuern: Gesetzesänderungen, Steuerreform, MwSt-Regeln für Neubauten, Title Deeds, Grundbuch, Kaufprozess, Kurzzeitvermietung.
3. Aufenthalt: Aufenthaltsgenehmigungen, Permanent Residence, Digital-Nomad-Visum, Anmeldung von EU-Bürgern.
4. Infrastruktur und Wirtschaft: Flughäfen Paphos und Larnaka (Passagierzahlen, neue Verbindungen nach Deutschland), Straßen, Marinas, Tourismuszahlen, Wirtschaftswachstum, Zinsen und Kredite, soweit für Käufer relevant.

Regeln:
- Nur Meldungen aus diesem Zeitraum. Monatsstatistiken dürfen einen Vormonat betreffen, dann den Bezugszeitraum nennen.
- Zu JEDER Aussage die konkrete Quelle mit vollständiger URL (Artikel oder Statistikseite, keine Startseite).
- Zahlen exakt wie in der Quelle, mit Bezugszeitraum. Nichts schätzen, runden oder erfinden.
- Bevorzuge Primärquellen und seriöse Medien (Regierung/Behörden, Central Bank, CYSTAT, Cyprus Mail, in-cyprus/Philenews, Kathimerini Cyprus, Stockwatch, Reuters, CNA).

Liefere am Ende 8 bis 12 Fundstücke, je: Datum, Kernaussage mit den genauen Zahlen, Quelle (Name + URL).`
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: `Bitte recherchiere jetzt den Zeitraum ${from} bis ${to} und liefere die Fundstücke.` }]
  const urls = new Map<string, { url: string; title: string }>()
  const texts: string[] = []
  let model = ''
  for (let round = 0; round < 3; round++) {
    const resp = await claude({ system, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }], max_tokens: 8000, timeoutMs: 200000, signal })
    model = resp._model
    const blocks = (resp.content ?? []) as Array<Record<string, unknown>>
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text)
        for (const c of (b.citations as Array<{ url?: string; title?: string }> | undefined) ?? []) {
          if (c.url) { const k = normUrl(c.url); if (k) urls.set(k, { url: c.url, title: c.title ?? '' }) }
        }
      }
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content as Array<{ type?: string; url?: string; title?: string }>) {
          if (r.url) { const k = normUrl(r.url); if (k) urls.set(k, { url: r.url, title: r.title ?? '' }) }
        }
      }
    }
    if (resp.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: blocks })
  }
  const text = texts.join('').trim()
  if (!text) throw new Error('Recherche lieferte keinen Text.')
  if (!urls.size) throw new Error('Recherche lieferte keine Quellen (Websuche leer).')
  return { text, urls, model }
}

// Vorausgabe: ihre Quellen und Kennzahlen dürfen im neuen Report nicht wiederkommen.
interface PrevEdition {
  month: string
  facts: Array<{ value: string; label: string; url: string }>
  news: Array<{ heading: string; url: string }>
  urls: Set<string>      // alle Quellen (normUrl)
  newsUrls: Set<string>  // Quellen der Meldungen (normUrl)
  values: Set<string>    // valueKey der Kennzahlen
}
async function prevEdition(sb: SupabaseClient, month: string): Promise<PrevEdition | null> {
  const { data } = await sb.from('zypern_reports').select('month, content').eq('status', 'live').lt('month', month)
    .order('month', { ascending: false }).limit(1).maybeSingle()
  const row = data as { month: string; content: ReportContent | null } | null
  const c = row?.content
  if (!row || !c) return null
  const facts = (Array.isArray(c.key_facts) ? c.key_facts : []).map(f => ({ value: String(f.value ?? ''), label: String(f.label ?? ''), url: String(f.source_url ?? '') }))
  const news = (Array.isArray(c.news) ? c.news : []).map(n => ({ heading: String(n.heading ?? ''), url: String(n.source_url ?? '') }))
  const norm = (xs: string[]) => new Set(xs.map(normUrl).filter(Boolean))
  return {
    month: row.month, facts, news,
    urls: norm([...facts.map(f => f.url), ...news.map(n => n.url)]),
    newsUrls: norm(news.map(n => n.url)),
    values: new Set(facts.map(f => valueKey(f.value)).filter(Boolean)),
  }
}

const DEFAULT_SUBTITLE = 'Markt, Recht und Steuern auf einen Blick'

async function structure(r: Research, month: string, prev: PrevEdition | null = null, signal?: AbortSignal): Promise<ReportContent> {
  const tool = {
    name: 'set_report',
    description: 'Liefert den fertigen Inhalt des Zypern-Reports.',
    input_schema: {
      type: 'object',
      properties: {
        subtitle: { type: 'string', description: 'Ein Satz fürs Deckblatt, max. 120 Zeichen: worum es diesen Monat geht. Echte Umlaute.' },
        intro: { type: 'string', description: '2 bis 3 kurze Sätze (max. 320 Zeichen) Einordnung von Sven in Ich-Form, Leser in Du-Form. Konkret, ohne Floskeln, keine Superlative wie "so hoch wie nie", die nicht wörtlich in der Recherche stehen. Echte Umlaute.' },
        key_facts: {
          type: 'array', description: '3 bis 5 Kennzahlen des Monats, jede mit Quelle.',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'Die Zahl, kurz, max. 14 Zeichen, z.B. "1.412" oder "+8,1 %" oder "4,9 Mio."' },
              label: { type: 'string', description: 'Was die Zahl bedeutet, mit Bezugszeitraum, max. 130 Zeichen. Echte Umlaute.' },
              source_name: { type: 'string' },
              source_url: { type: 'string', description: 'Exakt eine URL aus der Quellenliste.' },
            },
            required: ['value', 'label', 'source_name', 'source_url'],
          },
        },
        news: {
          type: 'array', description: '4 bis 6 Meldungen, wichtigste zuerst.',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: 'Überschrift, max. 70 Zeichen, sachlich, kein Clickbait. Echte Umlaute.' },
              text: { type: 'string', description: '2 bis 3 Sätze, max. 380 Zeichen: Was ist passiert. Höchstens drei Zahlen, nur die wichtigsten, exakt wie in der Quelle. Echte Umlaute.' },
              meaning: { type: 'string', description: '1 bis 2 Sätze, max. 230 Zeichen: Was heißt das für dich als Käufer oder Investor? Ehrlich, ohne Versprechen. Echte Umlaute.' },
              source_name: { type: 'string', description: 'Name der Quelle, z.B. "Cyprus Mail"' },
              source_url: { type: 'string', description: 'Exakt eine URL aus der Quellenliste.' },
            },
            required: ['heading', 'text', 'meaning', 'source_name', 'source_url'],
          },
        },
      },
      required: ['subtitle', 'intro', 'key_facts', 'news'],
    },
  }
  const urlList = [...r.urls.values()].slice(0, 80).map(u => `- ${u.url}${u.title ? `  (${u.title.slice(0, 90)})` : ''}`).join('\n')
  const prevBlock = prev ? `\n\nVORAUSGABE ${monthLabel(prev.month)} (NICHT WIEDERHOLEN): Diese Quellen und Kennzahlen standen schon im letzten Report. Verwende keine dieser URLs für eine Meldung und keine dieser Kennzahlen noch einmal. Eine Kennzahl aus derselben Statistik ist nur mit einem neuen Wert erlaubt.
Quellen:
${[...prev.news.map(n => `- ${n.url}  (Meldung: ${n.heading.slice(0, 90)})`), ...prev.facts.map(f => `- ${f.url}  (Kennzahl)`)].join('\n')}
Kennzahlen:
${prev.facts.map(f => `- ${f.value}: ${f.label.slice(0, 120)}`).join('\n')}` : ''
  const system = `Du schreibst den „Zypern-Report ${monthLabel(month)}" von Happy Property Cyprus (Sven Rüprich, Paphos) für deutschsprachige Käufer und Kapitalanleger. Grundlage ist AUSSCHLIESSLICH die Recherche unten. Jede Kennzahl und jede Meldung braucht eine source_url, die exakt aus der Quellenliste stammt. Was keine passende Quelle hat, lässt du weg.

Auswahl: Mische die Themen. Gibt es Meldungen zu Recht, Steuern, Aufenthalt oder Infrastruktur, gehören sie in die Meldungen; reine Marktstatistik höchstens in drei Meldungen, der Rest steht bei den Kennzahlen. Keine zwei Meldungen zum selben Thema.
Einordnung ("meaning"): Happy Property vermittelt vor allem Neubau-Wohnungen in Paphos an Kapitalanleger. Ordne ehrlich und lösungsorientiert ein: was du als Käufer konkret prüfen oder beachten solltest. Keine Kaufempfehlung und keine Empfehlung, auf andere Segmente oder Regionen auszuweichen.

${WRITING_RULES}

WICHTIG: Schreibe durchgehend mit echten Umlauten und ß (Käufer, Verträge, für, über, während, größer, heißt). Schreibweisen wie "Kaeufer", "fuer" oder "ueber" sind ein Fehler.

Rufe am Ende GENAU EINMAL set_report auf.`
  const resp = await claude({
    system,
    messages: [{ role: 'user', content: `RECHERCHE:\n${r.text}\n\nQUELLENLISTE (nur diese URLs sind erlaubt):\n${urlList}${prevBlock}` }],
    tools: [tool], tool_choice: { type: 'tool', name: 'set_report' }, max_tokens: 6000, timeoutMs: 150000, signal,
  })
  const tu = ((resp.content ?? []) as Array<{ type: string; name?: string; input?: Record<string, unknown> }>).find(b => b.type === 'tool_use' && b.name === 'set_report')
  const inp = tu?.input
  if (!inp) throw new Error('Strukturierung lieferte kein Ergebnis.')

  // Nur Quellen zulassen, die die Websuche wirklich geliefert hat (Suchtreffer und
  // Zitate). Eine URL, die nur im Fließtext der Recherche steht, zählt nicht.
  // Quellen der Vorausgabe: für Meldungen nie, für Kennzahlen nur, wenn sie dort
  // keine Meldung belegten (der Wert muss dann neu sein, siehe unten).
  const resolve = (u: unknown, kind: 'fact' | 'news'): string => {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u.trim())) return ''
    const k = normUrl(u)
    const hit = k ? r.urls.get(k) : undefined
    if (!hit) return ''
    if (prev && (prev.newsUrls.has(k) || (kind === 'news' && prev.urls.has(k)))) {
      console.warn('[zypern-report] Quelle aus der Vorausgabe verworfen:', u)
      return ''
    }
    return hit.url
  }
  // Jede Zahl im Text muss als eigene Zahl in der Recherche stehen (Tausendertrenner
  // und Dezimalkomma/-punkt egal, sonst exakt: keine gerundeten oder erfundenen Werte).
  const researchNums = new Set(numTokens(r.text).flat())
  const grounded = (...parts: string[]) => numTokens(parts.join(' | ')).every(vs => vs.some(v => researchNums.has(v)))
  const seen = new Set<string>()
  // Zwei Meldungen mit mindestens zwei gleichen markanten Zahlen = dasselbe Thema.
  const bigNums = (t: string) => new Set((digitStream(t).match(/\d{3,}/g) ?? []).filter(n => !/^20\d\d$/.test(n)))
  const usedNums: Array<Set<string>> = []
  const key_facts: KeyFact[] = []
  for (const f of (Array.isArray(inp.key_facts) ? inp.key_facts : []) as Array<Record<string, unknown>>) {
    const url = resolve(f.source_url, 'fact')
    const value = clean(f.value, 24), label = clean(f.label, 200)
    if (!url || !value || !label) continue
    if (!grounded(value, label)) { console.warn('[zypern-report] Kennzahl ohne Beleg verworfen:', value, label); continue }
    if (prev?.values.has(valueKey(value))) { console.warn('[zypern-report] Kennzahl aus der Vorausgabe verworfen:', value, label); continue }
    key_facts.push({ value, label, source_url: url, source_name: clean(f.source_name, 60) || hostOf(url) })
    if (key_facts.length >= 5) break
  }
  const news: NewsItem[] = []
  for (const n of (Array.isArray(inp.news) ? inp.news : []) as Array<Record<string, unknown>>) {
    const url = resolve(n.source_url, 'news')
    const heading = clean(n.heading, 110), text = clean(n.text, 700)
    if (!url || !heading || !text) continue
    const k = normUrl(url)
    if (seen.has(k)) continue
    const meaning = clean(n.meaning, 400)
    if (!grounded(heading, text, meaning)) { console.warn('[zypern-report] Meldung mit unbelegter Zahl verworfen:', heading); continue }
    const nums = bigNums(`${heading} ${text}`)
    if (usedNums.some(u => [...nums].filter(x => u.has(x)).length >= 2)) { console.warn('[zypern-report] Doppeltes Thema verworfen:', heading); continue }
    usedNums.push(nums)
    seen.add(k)
    news.push({ heading, text, meaning: meaning || undefined, source_url: url, source_name: clean(n.source_name, 60) || hostOf(url) })
    if (news.length >= 6) break
  }
  const enough = (c: { key_facts: unknown[]; news: unknown[] }) => {
    if (c.key_facts.length < 2) throw new Error(`Zu wenige belegte Kennzahlen (${c.key_facts.length}).`)
    if (c.news.length < 3) throw new Error(`Zu wenige belegte Meldungen (${c.news.length}).`)
  }
  enough({ key_facts, news })
  const subtitle = clean(inp.subtitle, 160), intro = clean(inp.intro, 600)
  const out: ReportContent = {
    subtitle: subtitle && grounded(subtitle) ? subtitle : DEFAULT_SUBTITLE,
    intro: intro && grounded(intro) ? intro : undefined,
    key_facts, news, model: resp._model,
  }
  if (umlautProblems(out).length) await fixUmlauts(out, signal)
  // Was danach noch umschrieben ist (oder durch die Korrektur eine unbelegte Zahl
  // bekam), fliegt einzeln raus. Der Bau scheitert nur, wenn zu wenig übrig bleibt.
  const bad = (...t: string[]) => t.some(x => TRANSLIT.test(x)) || !grounded(...t)
  if (bad(out.subtitle)) out.subtitle = DEFAULT_SUBTITLE
  if (out.intro && bad(out.intro)) out.intro = undefined
  out.key_facts = out.key_facts.filter(f => {
    if (!bad(f.value, f.label)) return true
    console.warn('[zypern-report] Kennzahl nach Umlaut-Prüfung verworfen:', f.label)
    return false
  })
  out.news = out.news.filter(n => {
    if (!bad(n.heading, n.text, n.meaning ?? '')) return true
    console.warn('[zypern-report] Meldung nach Umlaut-Prüfung verworfen:', n.heading)
    return false
  })
  enough(out)
  return out
}

// Zahlen mit Wortgrenzen. Tausendertrenner (. , ' und schmale Leerzeichen) und
// Dezimalkomma/-punkt werden vereinheitlicht, führende Nullen entfernt. „1.412"
// ohne Nachkommastellen ist mehrdeutig (deutsche Tausender oder englische
// Dezimalzahl) und zählt in beiden Lesarten. URLs zählen nicht, Datumsangaben
// wie 08.09.2026 werden in Tag, Monat, Jahr zerlegt.
const NUM_RE = /(?<!\d)(?<!\d[.,])(\d{1,3}([.,'   ])\d{3}(?!\d)(?:\2\d{3}(?!\d))*|\d+)([.,]\d+)?/g
function numTokens(s: string): string[][] {
  const t = s
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?!\d)/g, '$1 . $2 . $3')
  const lead0 = (x: string) => x.replace(/^0+(?=\d)/, '')
  const out: string[][] = []
  for (const m of t.matchAll(NUM_RE)) {
    const [, int, sep, dec] = m
    const whole = lead0(int.replace(/[.,'   ]/g, ''))
    if (dec) out.push([`${whole}.${dec.slice(1)}`])
    else if ((sep === '.' || sep === ',') && int.split(sep).length === 2) {
      const [a, b] = int.split(sep)
      out.push([whole, `${lead0(a)}.${b}`])
    } else out.push([whole])
  }
  return out
}
// Vergleichsschlüssel einer Kennzahl („+8,9 %" = „8.9%").
function valueKey(v: string): string {
  return numTokens(v).map(t => t[0]).join(' ') || v.toLowerCase().replace(/\s+/g, '')
}

function digitStream(s: string): string {
  return s.replace(/(\d)[.,'\u00a0\u202f ](?=\d)/g, '$1')
}

// Umschreibungen wie "Kaeufer"/"fuer"/"Grossbritannien" erkennen. Die Wortteile
// kommen in korrekt geschriebenem Deutsch nicht vor. Ein Text ganz ohne Umlaut ist
// dagegen kein Fehler (es gibt korrekte Sätze ohne ä/ö/ü/ß).
const TRANSLIT = /fuer|ueber|waehrend|koenn|moecht|muess|hoeh|hoech|groess|naechst|kaeuf|vertraeg|uebertrag|aender|laender|staerk|waechst|zaehl|erhoeh|haelft|auslaend|jaehr|maerz|gebuehr|pruef|fuehr|wuerd|qualitaet|moeglich|naeher|angehoer|haeuser|buero|gruend|fruehe|spaet|koerper|oeffentl|ueblich|zusaetz|taetig|stueck|heisst|strasse|groesse|gewaehr|traeger|klaer|erklaer|zurueck|rueck|gross(?:e|er|en|es|britann)|grösst|grösser|gemäss|massnahm|schliessl|ausser/i
function umlautProblems(c: ReportContent): string[] {
  const texts = [c.subtitle, c.intro ?? '', ...c.key_facts.map(f => f.label), ...c.news.flatMap(n => [n.heading, n.text, n.meaning ?? ''])]
  return texts.filter(t => t && TRANSLIT.test(t))
}
async function fixUmlauts(c: ReportContent, signal?: AbortSignal): Promise<void> {
  const tool = {
    name: 'set_texts', description: 'Gibt dieselben Texte mit korrigierter Schreibweise zurück.',
    input_schema: { type: 'object', properties: {
      subtitle: { type: 'string' }, intro: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
      news: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, text: { type: 'string' }, meaning: { type: 'string' } }, required: ['heading', 'text', 'meaning'] } },
    }, required: ['subtitle', 'intro', 'labels', 'news'] },
  }
  const src = { subtitle: c.subtitle, intro: c.intro ?? '', labels: c.key_facts.map(f => f.label), news: c.news.map(n => ({ heading: n.heading, text: n.text, meaning: n.meaning ?? '' })) }
  const resp = await claude({
    system: 'Du korrigierst NUR die Schreibweise deutscher Texte: Umschreibungen wie ae, oe, ue und ss ersetzt du durch echte Umlaute und ß (Kaeufer → Käufer, fuer → für, heisst → heißt), wo das deutsche Wort es verlangt. Eigennamen, englische Begriffe, Inhalt, Zahlen, Reihenfolge und Anzahl bleiben exakt gleich. Keine Gedankenstriche. Rufe genau einmal set_texts auf.',
    messages: [{ role: 'user', content: JSON.stringify(src) }],
    tools: [tool], tool_choice: { type: 'tool', name: 'set_texts' }, max_tokens: 6000, timeoutMs: 120000, signal,
  })
  const tu = ((resp.content ?? []) as Array<{ type: string; name?: string; input?: { subtitle?: string; intro?: string; labels?: string[]; news?: Array<{ heading?: string; text?: string; meaning?: string }> } }>).find(b => b.type === 'tool_use' && b.name === 'set_texts')
  const o = tu?.input
  if (!o) return
  if (o.subtitle) c.subtitle = clean(o.subtitle, 160)
  if (o.intro && c.intro) c.intro = clean(o.intro, 600)
  if (Array.isArray(o.labels) && o.labels.length === c.key_facts.length) o.labels.forEach((l, i) => { if (l) c.key_facts[i].label = clean(l, 200) })
  if (Array.isArray(o.news) && o.news.length === c.news.length) {
    o.news.forEach((n, i) => {
      if (n.heading) c.news[i].heading = clean(n.heading, 110)
      if (n.text) c.news[i].text = clean(n.text, 700)
      if (n.meaning && c.news[i].meaning) c.news[i].meaning = clean(n.meaning, 400)
    })
  }
}

// ── Assets: Schriften + Logo ─────────────────────────────────────────────────
const FONT_KEYS = ['Montserrat-400', 'Montserrat-600', 'Montserrat-700', 'PlayfairDisplay-400', 'PlayfairDisplay-700', 'PlayfairDisplay-400i'] as const
type FontKey = typeof FONT_KEYS[number]
const GOOGLE_CSS = 'https://fonts.googleapis.com/css?family=Playfair+Display:400,700,400italic|Montserrat:400,600,700'
const isTtf = (b: Uint8Array) => b.length > 1000 && ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || String.fromCharCode(b[0], b[1], b[2], b[3]) === 'true')

let _fonts: Record<FontKey, Buffer> | null = null
async function loadFonts(sb: SupabaseClient): Promise<Record<FontKey, Buffer>> {
  if (_fonts) return _fonts
  const out: Partial<Record<FontKey, Buffer>> = {}
  // 1) eigene Kopie im Storage
  await Promise.all(FONT_KEYS.map(async k => {
    try {
      const r = await fetch(`${PUBLIC_BASE}/_fonts/${k}.ttf`, { signal: AbortSignal.timeout(15000) })
      if (!r.ok) return
      const b = new Uint8Array(await r.arrayBuffer())
      if (isTtf(b)) out[k] = Buffer.from(b)
    } catch { /* unten Google */ }
  }))
  // 2) fehlende Schnitte von Google (alter User-Agent → statische TTF) und in den Storage legen
  const missing = FONT_KEYS.filter(k => !out[k])
  if (missing.length) {
    const r = await fetch(GOOGLE_CSS, { headers: { 'User-Agent': 'Mozilla/4.0' }, signal: AbortSignal.timeout(15000) })
    const css = r.ok ? await r.text() : ''
    for (const block of css.split('@font-face').slice(1)) {
      const fam = /font-family:\s*'([^']+)'/.exec(block)?.[1]?.replace(/\s+/g, '')
      const weight = /font-weight:\s*(\d+)/.exec(block)?.[1]
      const italic = /font-style:\s*italic/.test(block)
      const url = /url\((https:[^)]+\.ttf)\)/.exec(block)?.[1]
      const key = `${fam}-${weight}${italic ? 'i' : ''}` as FontKey
      if (!url || !missing.includes(key)) continue
      const fr = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!fr.ok) continue
      const b = new Uint8Array(await fr.arrayBuffer())
      if (!isTtf(b)) continue
      out[key] = Buffer.from(b)
      await sb.storage.from(BUCKET).upload(`${DIR}/_fonts/${key}.ttf`, b, { contentType: 'font/ttf', upsert: true, cacheControl: '31536000' }).catch(() => null)
    }
  }
  const still = FONT_KEYS.filter(k => !out[k])
  if (still.length) throw new Error(`CI-Schriften konnten nicht geladen werden: ${still.join(', ')}`)
  _fonts = out as Record<FontKey, Buffer>
  // Zeichenvorrat = Schnittmenge aller Schnitte. Scheitert das Parsen, bleibt WIN1252.
  const sets = FONT_KEYS.map(k => cmapCodepoints(out[k] as Uint8Array))
  if (sets.every(Boolean)) {
    const [first, ...rest] = sets as Set<number>[]
    _glyphs = new Set([...first].filter(cp => rest.every(s => s.has(cp))))
  } else console.warn('[zypern-report] cmap nicht lesbar, Zeichenfilter nutzt Latin-1-Liste')
  return _fonts
}

// Alle Codepoints, für die eine TrueType-Schrift eine Glyphe hat (cmap Format 12 oder 4).
function cmapCodepoints(buf: Uint8Array): Set<number> | null {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const numTables = dv.getUint16(4)
    let cmap = -1
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16
      if (String.fromCharCode(buf[rec], buf[rec + 1], buf[rec + 2], buf[rec + 3]) === 'cmap') { cmap = dv.getUint32(rec + 8); break }
    }
    if (cmap < 0) return null
    let sub = -1, fmt = 0
    for (let i = 0, n = dv.getUint16(cmap + 2); i < n; i++) {
      const r = cmap + 4 + i * 8
      const pid = dv.getUint16(r), eid = dv.getUint16(r + 2)
      if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue
      const off = cmap + dv.getUint32(r + 4)
      const f = dv.getUint16(off)
      if (f === 12 && fmt !== 12) { sub = off; fmt = 12 } else if (f === 4 && !fmt) { sub = off; fmt = 4 }
    }
    if (sub < 0) return null
    const set = new Set<number>()
    if (fmt === 12) {
      for (let i = 0, n = dv.getUint32(sub + 12); i < n; i++) {
        const g = sub + 16 + i * 12
        const start = dv.getUint32(g), end = Math.min(dv.getUint32(g + 4), start + 0xffff), gid = dv.getUint32(g + 8)
        for (let c = start; c <= end; c++) if (gid + (c - start) !== 0) set.add(c)
      }
    } else {
      const segX2 = dv.getUint16(sub + 6)
      const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2
      for (let i = 0; i < segX2 / 2; i++) {
        const end = dv.getUint16(endO + i * 2), start = dv.getUint16(startO + i * 2)
        const delta = dv.getInt16(deltaO + i * 2), ro = dv.getUint16(rangeO + i * 2)
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid = ro === 0 ? (c + delta) & 0xffff : dv.getUint16(rangeO + i * 2 + ro + (c - start) * 2)
          if (ro !== 0 && gid) gid = (gid + delta) & 0xffff
          if (gid) set.add(c)
        }
      }
    }
    return set.size ? set : null
  } catch { return null }
}

async function loadLogo(): Promise<string | null> {
  try {
    const r = await fetch(LOGO_URL, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    const b = new Uint8Array(await r.arrayBuffer())
    if (b[0] !== 0xff || b[1] !== 0xd8) return null
    return `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`
  } catch { return null }
}

// ── PDF-Layout ───────────────────────────────────────────────────────────────
// A4 = 595.28 x 841.89 pt. Innenränder 58 pt → Satzbreite 479 pt.
const PAGE_W = 595.28
const PAGE_H = 841.89
const M_X = 58
const CONTENT_W = PAGE_W - 2 * M_X
const LOGO_BAND_H = PAGE_W * 400 / 1300 // Logo-Datei ist 1300 x 400, Hintergrund #2b343d
const C = {
  navy: CI.navy, cream: CI.cream, coral: CI.coral, gold: CI.gold, ink: CI.ink, line: CI.line,
  mute: '#6b6f78', paper: '#f6f0e4', logoBg: '#2b343d', creamSoft: '#d9dbe0',
}

// deno-lint-ignore no-explicit-any
type Node = any

function kickerHead(no: string, kicker: string, title: string, lead?: string): Node {
  return {
    headlineLevel: 1,
    stack: [
      { text: [{ text: `${no}  `, color: C.coral }, { text: kicker.toUpperCase(), color: C.mute }], font: 'Body', bold: true, fontSize: 7.5, characterSpacing: 1.8 },
      { text: title, font: 'Serif', bold: true, fontSize: 27, color: C.navy, lineHeight: 1.08, margin: [0, 8, 0, 0] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 34, y2: 0, lineWidth: 2.2, lineColor: C.coral }], margin: [0, 12, 0, lead ? 14 : 18] },
      ...(lead ? [{ text: lead, fontSize: 11.2, lineHeight: 1.42, color: C.navy, margin: [0, 0, 0, 20] }] : []),
    ],
  }
}
const hair = (color: string = C.gold, w = 0.6, width = CONTENT_W): Node => ({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: w, lineColor: color }] })
const sourceLine = (name: string, url: string): Node => ({
  text: [{ text: 'Quelle: ', color: C.mute }, { text: name, link: url, color: C.navy, decoration: 'underline', decorationColor: C.gold }],
  fontSize: 7.6, margin: [0, 6, 0, 0],
})
const para = (text: string, extra: Node = {}): Node => ({ text, fontSize: 10, lineHeight: 1.45, color: C.ink, margin: [0, 0, 0, 9], ...extra })
const subHead = (text: string, extra: Node = {}): Node => ({ text, font: 'Serif', bold: true, fontSize: 13.5, color: C.navy, margin: [0, 6, 0, 5], ...extra })

function noteBox(content: Node[], fill = C.paper, bar = C.gold): Node {
  return {
    table: { widths: [3, '*'], body: [[{ text: '', fillColor: bar }, { stack: content, fillColor: fill }]] },
    layout: {
      hLineWidth: () => 0, vLineWidth: () => 0,
      paddingLeft: (i: number) => (i === 0 ? 0 : 16), paddingRight: (i: number) => (i === 0 ? 0 : 16),
      paddingTop: () => 12, paddingBottom: () => 12,
    },
  }
}

function bulletList(items: Array<string | Node[]>, color = C.ink, size = 10): Node {
  return {
    table: {
      widths: [12, '*'],
      body: items.map(t => [
        { text: '•', color: C.coral, fontSize: 11, bold: true, margin: [0, -1.5, 0, 0] },
        { text: t, fontSize: size, lineHeight: 1.4, color },
      ]),
    },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => (size < 10 ? 4 : 6) },
  }
}

function coverBackground(logo: string | null, label: string): Node[] {
  return [
    { canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE_W, h: PAGE_H, color: C.navy }] },
    ...(logo
      ? [{ image: 'logo', width: PAGE_W, absolutePosition: { x: 0, y: 0 } }]
      : [
        { canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE_W, h: LOGO_BAND_H, color: C.logoBg }], absolutePosition: { x: 0, y: 0 } },
        { text: 'Happy Property', font: 'Serif', fontSize: 30, color: C.cream, alignment: 'center', absolutePosition: { x: 0, y: LOGO_BAND_H / 2 - 20 } },
      ]),
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: PAGE_W, y2: 0, lineWidth: 0.8, lineColor: C.gold }], absolutePosition: { x: 0, y: LOGO_BAND_H } },
    // Fuß des Deckblatts
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 0.5, lineColor: C.gold }], absolutePosition: { x: M_X, y: PAGE_H - 96 } },
    {
      absolutePosition: { x: M_X, y: PAGE_H - 82 },
      columns: [
        { width: CONTENT_W - 200, stack: [
          { text: 'Happy Property Cyprus', font: 'Serif', bold: true, fontSize: 11, color: C.cream },
          { text: 'Sven Rüprich · Paphos, Zypern', fontSize: 8.5, color: C.creamSoft, margin: [0, 3, 0, 0] },
        ] },
        { width: 200, stack: [
          { text: 'happy-property.de', link: 'https://happy-property.de', fontSize: 8.5, color: C.cream, alignment: 'right' },
          { text: `Ausgabe ${label}`, fontSize: 8.5, color: C.gold, alignment: 'right', margin: [0, 3, 0, 0] },
        ] },
      ],
    },
  ]
}

function steps(items: Array<{ t: string; d: string }>): Node[] {
  return items.map((s, i) => ({
    unbreakable: true,
    margin: [0, 0, 0, 8],
    columns: [
      { width: 30, text: String(i + 1), font: 'Serif', bold: true, fontSize: 21, color: C.gold, margin: [0, -3, 0, 0] },
      { width: '*', stack: [
        { text: s.t, font: 'Serif', bold: true, fontSize: 12.5, color: C.navy },
        { text: s.d, fontSize: 9.6, lineHeight: 1.36, color: C.ink, margin: [0, 2, 0, 0] },
      ] },
    ],
  }))
}

// Feste Seiten (Evergreen). Steuerteil nur mit freigegebenen Fakten
// (Memory: zypern_steuersaetze, dba_de_zypern, afa_neubau_framing, steuer_factsheet).
function evergreen(label: string): Node[] {
  return [
    // 03 Warum Paphos
    { ...kickerHead('03', 'Standort', 'Warum Paphos', 'Paphos ist die ruhigere, grünere Seite der zyprischen Südküste. Genau deshalb entscheiden sich viele unserer Käufer dafür: Hier lässt es sich leben, nicht nur Urlaub machen.'), pageBreak: 'before' },
    ...[
      { t: 'Gut erreichbar', d: 'Der internationale Flughafen Paphos liegt etwa 20 Minuten vom Zentrum entfernt und wird aus mehreren deutschen Städten direkt angeflogen, manche Verbindungen nur in der Saison. Limassol erreichst du über die Autobahn in rund einer Stunde.' },
      { t: 'EU, Euro und englisches Recht', d: 'Zypern ist seit 2004 Mitglied der EU und hat seit 2008 den Euro. Das Rechtssystem beruht auf dem englischen Common Law. Englisch ist im Alltag, bei Behörden und Banken weit verbreitet.' },
      { t: 'Lebensqualität', d: 'Über 300 Sonnentage im Jahr, Strände, Weinberge und Berge im Hinterland und eine Altstadt, deren archäologische Stätten zum UNESCO-Welterbe gehören. 2017 war Paphos Kulturhauptstadt Europas.' },
      { t: 'Ganzjährig bewohnt', d: 'Paphos lebt nicht nur von der Saison. Einheimische, Zugezogene aus ganz Europa und Remote-Worker sorgen dafür, dass die Stadt das ganze Jahr funktioniert. Wir wählen Lagen aus, die zwölf Monate im Jahr gefragt sind, für Kurzzeit- wie für Langzeitvermietung.' },
      { t: 'Ankommen fällt leicht', d: 'Internationale Schulen und eine große europäische Community machen den Einstieg einfach, falls du selbst irgendwann ganz oder teilweise nach Zypern ziehen willst.' },
    ].map(s => ({ unbreakable: true, margin: [0, 0, 0, 14], stack: [subHead(s.t, { margin: [0, 0, 0, 4] }), para(s.d, { margin: [0, 0, 0, 0] })] })),

    // 04 Kaufablauf
    { ...kickerHead('04', 'Kaufprozess', 'So läuft ein Kauf auf Zypern ab', 'Ein Kauf auf Zypern ist klar geregelt, läuft aber anders als in Deutschland. Statt eines Notars hast du einen eigenen Anwalt, der nur deine Interessen vertritt.'), pageBreak: 'before' },
    ...steps([
      { t: 'Reservierung', d: 'Du entscheidest dich für eine Wohnung und reservierst sie mit einer Reservierungsvereinbarung. Die Gebühr dafür wird meist auf den Kaufpreis angerechnet, ab dann ist die Einheit für dich geblockt.' },
      { t: 'Eigener Anwalt und Prüfung', d: 'Ein unabhängiger zyprischer Anwalt prüft Grundbuch, Genehmigungen, Lastenfreiheit und Vertrag und besorgt deine zyprische Steuernummer. Mit Vollmacht musst du nicht jedes Mal anreisen. Kosten: rund 1 % des Kaufpreises, ab 500.000 € etwa 0,8 %, jeweils zuzüglich Mehrwertsteuer.' },
      { t: 'Kaufvertrag und Hinterlegung', d: 'Du unterschreibst den Kaufvertrag, dein Anwalt hinterlegt ihn beim Land Registry, dem zyprischen Grundbuchamt. Damit ist dein Anspruch gesichert, auch bevor die Eigentumsurkunde da ist. Die frühere Stempelsteuer auf Kaufverträge ist seit Anfang 2026 abgeschafft.' },
      { t: 'Zahlungsplan bei Off-Plan', d: 'Kaufst du vor oder während der Bauphase, zahlst du in Raten nach Baufortschritt. Die Stufen stehen im Vertrag. Auf Neubauten fällt Mehrwertsteuer an, im Regelfall 19 %. In der Happy Property App siehst du jede Rate und den Stand der Baustelle.' },
      { t: 'Übergabe', d: 'Nach der Fertigstellung gibt es eine gemeinsame Abnahme, Mängel arbeitet der Bauträger ab. Unsere Objekte werden key ready übergeben, also bezugsfertig von den Möbeln bis zur Bettwäsche.' },
      { t: 'Title Deed', d: 'Die offizielle Eigentumsurkunde stellt das Land Registry aus, wenn das gesamte Projekt behördlich abgenommen ist. Das kann dauern, bis dahin schützt dich der hinterlegte Vertrag. Wir achten darauf, dass das Grundstück frei von Hypotheken ist.' },
      { t: 'Vermieten', d: 'Du vermietest langfristig an Einheimische oder kurzfristig an Urlauber. Für die Kurzzeitvermietung muss die Wohnung beim Deputy Ministry of Tourism registriert sein. Die steuerlichen Unterschiede stehen auf der nächsten Seite.' },
    ]),

    // 05 Steuern
    { ...kickerHead('05', 'Steuern', 'Steuern kurz erklärt', `Die wichtigsten Eckpunkte für Käufer aus Deutschland, Stand ${label}. Das ersetzt keine Beratung, hilft dir aber, die richtigen Fragen zu stellen.`), pageBreak: 'before' },
    {
      unbreakable: true, stack: [
        subHead('Wer deine Mieten besteuert'),
        para('Nach dem Doppelbesteuerungsabkommen Deutschland-Zypern von 2011 darf Zypern die Mieten aus einer zyprischen Immobilie besteuern (Art. 6). Deutschland rechnet die auf Zypern gezahlte Steuer auf deine deutsche Steuer an (Art. 22 Abs. 1, Anrechnungsmethode). Die Mieten zählen also auch in Deutschland mit, doppelt zahlst du aber nicht.'),
      ],
    },
    {
      unbreakable: true, stack: [
        subHead('Woher der Vorteil kommt'),
        para('Der Vorteil entsteht nicht dadurch, dass die Mieten der deutschen Steuer entgehen. Er entsteht durch die Abschreibung (AfA), die abziehbaren Finanzierungszinsen und die vergleichsweise niedrige Steuer auf Zypern. Gerade in den ersten Jahren kann so steuerlich ein Verlust entstehen, der deine Steuerlast in Deutschland senkt. Die Verlustabzugsbeschränkung des § 2a EStG greift nicht, weil Zypern in der EU liegt.'),
      ],
    },
    {
      unbreakable: true, stack: [
        subHead('Abschreibung beim Neubau'),
        para('Für neu gebaute Wohnungen, die zu Wohnzwecken vermietet werden, gibt es die degressive AfA von 5 % (§ 7 Abs. 5a EStG, Baubeginn zwischen 1.10.2023 und 30.9.2029). Sie gilt für Neubauten in Deutschland genauso wie in anderen EU-Ländern. Der Unterschied liegt im Markt: In Deutschland ist Neubau für viele Anleger kaum bezahlbar, deshalb kaufen die meisten Bestand mit 2 % linearer AfA. Auf Zypern beginnt ein Neubau bei rund 210.000 € netto.'),
        para('Wichtig: Ferienwohnungen gelten steuerlich nicht als Wohnzweck (R 7.2 EStR). Für die Kurzzeitvermietung an Urlauber gibt es die 5 % degressive AfA deshalb nicht.'),
      ],
    },
    {
      unbreakable: true, stack: [
        subHead('Steuern auf Zypern seit 1.1.2026'),
        bulletList([
          'Mieteinnahmen als Privatperson: Freibetrag 22.000 € im Jahr, darüber 20, 25, 30 und 35 %. Der Spitzensatz greift erst ab 72.001 €.',
          'Abziehbar sind eine Pauschale von 20 % auf die Bruttomiete, 3 % Gebäude-AfA pro Jahr, 10 % pro Jahr auf die Einrichtung und die Darlehenszinsen.',
          'Die Sonderabgabe SDC auf Mieten ist gestrichen. Die Gesundheitsabgabe GESY von 2,65 % zahlen nur Personen, die auf Zypern steuerlich ansässig sind.',
          'Eine Vermögensteuer gibt es auf Zypern nicht.',
          'Kaufst du über eine zyprische Ltd, zahlt sie 15 % Körperschaftsteuer (seit 1.1.2026, vorher 12,5 %).',
        ]),
      ],
    },
    {
      unbreakable: true, stack: [
        subHead('Wenn du selbst nach Zypern ziehst'),
        para('Steuerlich ansässig wirst du ab 183 Tagen Aufenthalt im Jahr, unter bestimmten Bedingungen schon ab 60 Tagen. Mit Non-Dom-Status bist du bis zu 17 Jahre von der Special Defence Contribution auf Dividenden und Zinsen befreit.'),
      ],
    },
    {
      unbreakable: true, stack: [
        subHead('Verkauf'),
        para('In Deutschland ist der Verkauf einer privat gehaltenen Immobilie nach zehn Jahren Haltedauer steuerfrei (§ 23 EStG). Wie Zypern deinen Verkauf behandelt, lässt du vorab prüfen.', { margin: [0, 0, 0, 14] }),
      ],
    },
    noteBox([
      { text: 'Keine Steuerberatung - bitte mit deinem Steuerberater klären.', font: 'Body', bold: true, fontSize: 10, color: C.navy },
      { text: `Die Angaben geben den Stand ${label} wieder und sind bewusst vereinfacht. Deine persönliche Situation kann anders aussehen. Gern rechnen wir deinen Fall mit dir durch und bringen dich mit unserer Steuerkanzlei zusammen.`, fontSize: 9, lineHeight: 1.4, color: C.ink, margin: [0, 4, 0, 0] },
    ]),
  ]
}

function ctaPage(label: string): Node[] {
  const usps: Array<[string, string]> = [
    ['Geprüfte Bauträger.', 'Eigenkapitalfinanziert, mit fertigen Referenzprojekten auf Zypern, deren Qualität wir kennen.'],
    ['Lastenfreie Grundstücke.', 'Keine Hypotheken auf dem Boden, alle Genehmigungen liegen vor.'],
    ['Key ready.', 'Bezugsfertig übergeben, von den Möbeln bis zur Bettwäsche.'],
    ['Lage für 12 Monate im Jahr.', 'Gefragt in der Kurzzeitvermietung, Langzeitvermietung jederzeit möglich.'],
    ['Happy Property App.', 'Zahlungsplan, Baufortschritt, Einnahmen und Verträge an einem Ort.'],
  ]
  return [
    { ...kickerHead('06', 'Nächster Schritt', 'Lass uns deine Zahlen durchrechnen'), pageBreak: 'before' },
    {
      table: {
        widths: ['*'],
        body: [[{
          fillColor: C.navy,
          stack: [
            { text: 'Ob sich eine Immobilie auf Zypern für dich lohnt, hängt an deinen Zahlen: Einkommen, Eigenkapital, Finanzierung und was du vorhast. Genau das rechnen wir in einem unverbindlichen Gespräch mit dir durch, inklusive der steuerlichen Seite in Deutschland.', fontSize: 10.4, lineHeight: 1.42, color: C.cream },
            { text: 'Du bekommst von uns eine kleine, passende Auswahl. Im Portfolio haben wir immer gut 200 Objekte, durch die du dich nicht allein kämpfen musst.', fontSize: 10.4, lineHeight: 1.42, color: C.cream, margin: [0, 8, 0, 16] },
            {
              table: { widths: ['auto'], body: [[{ text: 'Gespräch vereinbaren', link: BOOKING_URL, font: 'Body', bold: true, fontSize: 11, color: C.navy, fillColor: C.coral, margin: [18, 9, 18, 9] }]] },
              layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
            },
            { text: 'portal.happy-property.com/termin', link: BOOKING_URL, fontSize: 8.5, color: C.creamSoft, margin: [0, 8, 0, 0] },
          ],
        }]],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 24, paddingRight: () => 24, paddingTop: () => 20, paddingBottom: () => 20 },
      margin: [0, 0, 0, 20],
    },
    {
      columns: [
        { width: '*', stack: [
          { text: 'WARUM HAPPY PROPERTY', font: 'Body', bold: true, fontSize: 7.5, characterSpacing: 1.8, color: C.coral, margin: [0, 0, 0, 6] },
          { text: '„Ich biete nur Objekte an, in die ich selbst investieren würde.\u201c', font: 'Serif', italics: true, fontSize: 13, lineHeight: 1.25, color: C.navy },
          { text: 'Sven Rüprich, Gründer', fontSize: 8.5, color: C.mute, margin: [0, 4, 0, 10] },
          bulletList(usps.map(([k, t]) => [{ text: `${k} `, bold: true, color: C.navy }, { text: t }] as unknown as Node[]), C.ink, 9.2),
        ] },
        { width: 165, stack: [
          { text: 'KONTAKT', font: 'Body', bold: true, fontSize: 7.5, characterSpacing: 1.8, color: C.coral, margin: [0, 0, 0, 6] },
          { text: 'Happy Property Cyprus', font: 'Serif', bold: true, fontSize: 11.5, color: C.navy },
          { text: 'Sven Rüprich', fontSize: 9, color: C.ink, margin: [0, 4, 0, 0] },
          { text: 'Pallados 1, 8046 Paphos, Zypern', fontSize: 9, color: C.ink, lineHeight: 1.3, margin: [0, 2, 0, 0] },
          { text: 'info@happy-property.com', link: 'mailto:info@happy-property.com', fontSize: 9, color: C.navy, margin: [0, 8, 0, 0] },
          { text: 'happy-property.de', link: 'https://happy-property.de', fontSize: 9, color: C.navy, margin: [0, 2, 0, 0] },
          { text: [{ text: 'Instagram ', color: C.mute }, { text: '@happy_property_cyprus', link: 'https://www.instagram.com/happy_property_cyprus' }], fontSize: 8.6, color: C.navy, margin: [0, 8, 0, 0] },
          { text: [{ text: 'YouTube ', color: C.mute }, { text: '@HappyPropertyCyprus', link: 'https://www.youtube.com/@HappyPropertyCyprus' }], fontSize: 8.6, color: C.navy, margin: [0, 2, 0, 0] },
        ] },
      ],
      columnGap: 24,
      margin: [0, 0, 0, 18],
    },
    hair(C.line, 0.6),
    { text: `Hinweis: Dieser Report dient der allgemeinen Information und ist keine Steuer-, Rechts- oder Anlageberatung. Die Nachrichten stammen aus öffentlich zugänglichen Quellen, die jeweils verlinkt sind. Alle Angaben ohne Gewähr, Stand ${label}.`, fontSize: 7.6, lineHeight: 1.4, color: C.mute, margin: [0, 10, 0, 0] },
  ]
}

const TOC: Array<[string, string]> = [
  ['01', 'Das Wichtigste in 60 Sekunden'], ['02', 'Was sich getan hat'], ['03', 'Warum Paphos'],
  ['04', 'So läuft ein Kauf ab'], ['05', 'Steuern kurz erklärt'], ['06', 'Deine Zahlen durchrechnen'],
]

function docDefinition(month: string, c: ReportContent, logo: string | null): Node {
  const label = monthLabel(month)
  const stand = c.researched_at ? deDate(c.researched_at.slice(0, 10)) : deDate(cyYmd(new Date()))
  const factRows = c.key_facts.map(f => {
    const vs = f.value.length <= 8 ? 26 : f.value.length <= 12 ? 21 : 17
    return [
      { text: f.value, font: 'Serif', bold: true, fontSize: vs, color: C.navy, lineHeight: 1.0, margin: [0, 12, 0, 12] },
      { stack: [
        { text: f.label, fontSize: 10.2, lineHeight: 1.38, color: C.ink },
        sourceLine(f.source_name, f.source_url),
      ], margin: [0, 13, 0, 12] },
    ]
  })
  // Jede Meldung = zwei untrennbare Blöcke (Kopf + Text, dann Einordnung + Quelle),
  // damit Meldungen über den Seitenrand laufen dürfen, ohne große Lücken zu reißen.
  const news = c.news.flatMap((n, i) => [
    {
      unbreakable: true,
      stack: [
        ...(i > 0 ? [hair(C.line, 0.6)] : []),
        {
          margin: [0, i > 0 ? 13 : 0, 0, 0],
          columns: [
            { width: 36, text: String(i + 1).padStart(2, '0'), font: 'Serif', italics: true, fontSize: 17, color: C.gold },
            { width: '*', stack: [
              { text: n.heading, font: 'Serif', bold: true, fontSize: 13.5, lineHeight: 1.12, color: C.navy },
              { text: n.text, fontSize: 9.6, lineHeight: 1.38, color: C.ink, margin: [0, 5, 0, 0] },
            ] },
          ],
        },
      ],
    },
    {
      unbreakable: true,
      margin: [36, 4, 0, 13],
      stack: [
        ...(n.meaning ? [{ text: [{ text: 'Für dich heißt das: ', font: 'Body', bold: true, color: C.navy }, { text: n.meaning }], fontSize: 9.6, lineHeight: 1.38, color: C.ink }] : []),
        sourceLine(n.source_name, n.source_url),
      ],
    },
  ])

  const content: Node[] = [
    // Deckblatt (Hintergrund + Logo kommen aus background())
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 34, y2: 0, lineWidth: 2.4, lineColor: C.coral }], margin: [0, LOGO_BAND_H + 70 - 72, 0, 18] },
    { text: 'MONATLICHER MARKTBERICHT', font: 'Body', bold: true, fontSize: 8, characterSpacing: 2.2, color: C.gold },
    { text: 'Zypern-Report', font: 'Serif', bold: true, fontSize: 54, color: C.cream, lineHeight: 1.0, margin: [0, 14, 0, 0] },
    { text: label, font: 'Serif', italics: true, fontSize: 26, color: C.gold, margin: [0, 6, 0, 0] },
    { text: 'Was sich auf Zypern gerade tut', fontSize: 14, color: C.cream, margin: [0, 26, 0, 0] },
    { text: c.subtitle, fontSize: 10.5, lineHeight: 1.45, color: C.creamSoft, margin: [0, 8, 90, 0] },
    { text: 'Für Käufer und Kapitalanleger aus Deutschland, Österreich und der Schweiz. Markt, Recht und Steuern, verständlich eingeordnet und mit Quellen belegt.', fontSize: 8.8, lineHeight: 1.45, color: C.creamSoft, margin: [0, 22, 150, 0] },
    { text: 'IN DIESER AUSGABE', font: 'Body', bold: true, fontSize: 7, characterSpacing: 2, color: C.gold, margin: [0, 34, 0, 8] },
    {
      columns: [0, 1].map(col => ({
        width: '*',
        stack: TOC.slice(col * 3, col * 3 + 3).map(([no, t]) => ({ text: [{ text: `${no}   `, color: C.coral, bold: true }, { text: t, color: C.cream }], fontSize: 8.8, margin: [0, 0, 0, 6] })),
      })),
      columnGap: 20,
    },

    // 01 Überblick
    { ...kickerHead('01', 'Überblick', 'Das Wichtigste in 60 Sekunden'), pageBreak: 'before' },
    ...(c.intro ? [{
      columns: [
        { width: '*', text: c.intro, font: 'Serif', italics: true, fontSize: 12.5, lineHeight: 1.35, color: C.navy },
      ],
      margin: [0, 0, 0, 6],
    }, { text: 'Sven Rüprich, Happy Property Cyprus', fontSize: 8.5, color: C.mute, margin: [0, 0, 0, 22] }] : []),
    {
      table: { widths: [150, '*'], body: factRows },
      layout: {
        hLineWidth: () => 0.6, vLineWidth: () => 0, hLineColor: () => C.gold,
        paddingLeft: (i: number) => (i === 0 ? 0 : 14), paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
      },
    },
    { text: `Recherche-Stand: ${stand}. Alle Zahlen mit Bezugszeitraum laut Quelle.`, fontSize: 7.6, color: C.mute, margin: [0, 10, 0, 0] },

    // 02 Nachrichten
    { ...kickerHead('02', 'Nachrichten', 'Was sich getan hat', 'Die wichtigsten Entwicklungen der letzten Wochen, eingeordnet für Käufer und Investoren. Jede Meldung mit Quelle zum Nachlesen.'), pageBreak: 'before' },
    ...news,

    ...evergreen(label),
    ...ctaPage(label),
  ]

  return {
    pageSize: 'A4',
    pageMargins: [M_X, 72, M_X, 70],
    info: {
      title: `Zypern-Report ${label}`,
      author: 'Happy Property Cyprus',
      subject: 'Was sich auf Zypern gerade tut: Markt, Recht und Steuern für Käufer aus Deutschland',
      keywords: 'Zypern, Immobilien, Paphos, Kapitalanlage, Steuern, Marktbericht',
      creator: 'Happy Property Cyprus',
      producer: 'Happy Property Cyprus',
    },
    images: logo ? { logo } : {},
    defaultStyle: { font: 'Body', fontSize: 10, color: C.ink },
    background: (page: number) => page === 1
      ? coverBackground(logo, label)
      : [{ canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE_W, h: PAGE_H, color: C.cream }] }],
    header: (page: number) => page === 1 ? null : {
      margin: [M_X, 34, M_X, 0],
      columns: [
        { text: 'HAPPY PROPERTY CYPRUS', font: 'Body', bold: true, fontSize: 6.8, characterSpacing: 2, color: C.navy },
        { text: 'ZYPERN-REPORT', font: 'Body', bold: true, fontSize: 6.8, characterSpacing: 2, color: C.gold, alignment: 'right' },
      ],
    },
    footer: (page: number, pages: number) => page === 1 ? null : {
      margin: [M_X, 26, M_X, 0],
      stack: [
        hair(C.gold, 0.5),
        {
          margin: [0, 8, 0, 0],
          columns: [
            { text: [{ text: `Zypern-Report ${label} · ` }, { text: 'happy-property.de', link: 'https://happy-property.de' }], fontSize: 7.6, color: C.mute },
            { text: `${page} / ${pages}`, fontSize: 7.6, color: C.mute, alignment: 'right' },
          ],
        },
      ],
    },
    pageBreakBefore: (node: Node, following: Node[]) => node.headlineLevel === 1 && node.pageBreak !== 'before' && following.length < 3,
    content,
  }
}

// Zahl und Einheit nie trennen („12,5 %", „22.000 €", „§ 23", „Art. 6").
function nbsp(s: string): string {
  return s
    .replace(/(\d) (%|€|Prozent|Mio\.|Mrd\.|Euro|m²)/g, '$1\u00a0$2')
    .replace(/(§|Art\.|Abs\.|Nr\.) (\d)/g, '$1\u00a0$2')
}
function glueUnits(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(glueUnits)
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    for (const k of Object.keys(o)) {
      if (k === 'text' && typeof o[k] === 'string') o[k] = nbsp(o[k] as string)
      else if (k === 'text' || k === 'stack' || k === 'columns' || k === 'content' || k === 'body' || k === 'table' || k === 'ul' || k === 'ol') o[k] = glueUnits(o[k])
    }
  }
  return node
}

async function renderPdf(sb: SupabaseClient, month: string, content: ReportContent): Promise<Uint8Array<ArrayBuffer>> {
  const [f, logo] = await Promise.all([loadFonts(sb), loadLogo()])
  const printer = new PdfPrinter({
    Body: { normal: f['Montserrat-400'], bold: f['Montserrat-600'], italics: f['Montserrat-400'], bolditalics: f['Montserrat-600'] },
    BodyBold: { normal: f['Montserrat-700'], bold: f['Montserrat-700'], italics: f['Montserrat-700'], bolditalics: f['Montserrat-700'] },
    Serif: { normal: f['PlayfairDisplay-400'], bold: f['PlayfairDisplay-700'], italics: f['PlayfairDisplay-400i'], bolditalics: f['PlayfairDisplay-400i'] },
  })
  // Gespeicherte oder per preview übergebene Inhalte laufen auch durch clean()
  // (jetzt mit dem echten Zeichenvorrat der Schriften): nie Kästchen im PDF.
  const fit = (v: unknown, max: number) => clean(v, max)
  const safe: ReportContent = {
    ...content,
    subtitle: fit(content.subtitle, 160) || DEFAULT_SUBTITLE,
    intro: fit(content.intro, 600) || undefined,
    key_facts: content.key_facts.map(k => ({ ...k, value: fit(k.value, 24), label: fit(k.label, 200), source_name: fit(k.source_name, 60) || hostOf(k.source_url) })),
    news: content.news.map(n => ({ ...n, heading: fit(n.heading, 110), text: fit(n.text, 700), meaning: fit(n.meaning, 400) || undefined, source_name: fit(n.source_name, 60) || hostOf(n.source_url) })),
  }
  const dd = docDefinition(month, safe, logo)
  dd.content = glueUnits(dd.content)
  const doc = printer.createPdfKitDocument(dd)
  const chunks: Uint8Array[] = []
  const bytes: Uint8Array<ArrayBuffer> = await new Promise((resolve, reject) => {
    doc.on('data', (c: Uint8Array) => chunks.push(c))
    doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    doc.on('error', reject)
    doc.end()
  })
  if (bytes.length > MAX_PDF_BYTES) throw new Error(`PDF zu groß (${Math.round(bytes.length / 1024)} KB).`)
  return bytes
}

// ── Speichern ────────────────────────────────────────────────────────────────
async function upload(sb: SupabaseClient, path: string, bytes: Uint8Array) {
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true, cacheControl: '300' })
  if (error) throw new Error(`Upload ${path}: ${error.message}`)
}
// aktuell.pdf nur ersetzen, wenn keine neuere Ausgabe live ist.
async function isNewestMonth(sb: SupabaseClient, month: string): Promise<boolean> {
  const { data } = await sb.from('zypern_reports').select('month').eq('status', 'live').gt('month', month).limit(1)
  return !(data ?? []).length
}
async function publishFiles(sb: SupabaseClient, month: string, pdf: Uint8Array): Promise<string> {
  await upload(sb, `${DIR}/${month}.pdf`, pdf)
  if (await isNewestMonth(sb, month)) await upload(sb, `${DIR}/aktuell.pdf`, pdf)
  return `${PUBLIC_BASE}/${month}.pdf`
}

// Bau-Absicherung: Der Cron ruft am 1., 2. und 3. um 04:00 UTC auf (live = überspringen).
// Ein Bau hat höchstens BUILD_DEADLINE_MS (unter dem Wall-Clock-Limit der Edge
// Runtime von 400 s), damit das Scheitern noch gespeichert wird. Eine Zeile, die
// länger als STALE_BUILD_MS auf 'building' steht, gilt als abgebrochen.
const BUILD_DEADLINE_MS = 330_000
const STALE_BUILD_MS = 15 * 60_000
const CRON_LAST_DAY = 3
const FAIL_TASK_TITLE = '📄 Zypern-Report konnte nicht erstellt werden'
const isStale = (r: Pick<ReportRow, 'status' | 'started_at'>) =>
  r.status === 'building' && (!r.started_at || Date.now() - Date.parse(r.started_at) >= STALE_BUILD_MS)

async function buildEdition(sb: SupabaseClient, month: string, signal: AbortSignal, log: (m: string) => void) {
  await loadFonts(sb) // früh: fehlende Schriften brechen vor der Recherche ab, und clean() kennt den Zeichenvorrat
  const now = new Date()
  const [y, m] = month.split('-').map(Number)
  const monthEnd = new Date(Date.UTC(y, m, 0, 21, 0))
  const end = monthEnd < now ? monthEnd : now
  const to = cyYmd(end)
  const from = cyYmd(new Date(end.getTime() - 31 * 86400000))
  const prev = await prevEdition(sb, month)
  log(`Recherche ${from} bis ${to}${prev ? `, Vorausgabe ${prev.month} ausgeschlossen` : ''}`)
  const r = await research(from, to, signal)
  log(`Recherche fertig: ${r.text.length} Zeichen, ${r.urls.size} Quellen (${r.model})`)
  const content = await structure(r, month, prev, signal)
  content.research_from = from
  content.research_to = to
  content.researched_at = now.toISOString()
  content.model = `${r.model} / ${content.model}`
  content.research = r.text.slice(0, 20000)
  log(`Struktur: ${content.key_facts.length} Kennzahlen, ${content.news.length} Meldungen`)
  const pdf = await renderPdf(sb, month, content)
  log(`PDF ${Math.round(pdf.length / 1024)} KB`)
  signal.throwIfAborted() // nach dem Zeitlimit nichts mehr veröffentlichen
  const pdf_url = await publishFiles(sb, month, pdf)
  signal.throwIfAborted()
  const { error } = await sb.from('zypern_reports').update({ status: 'live', content, pdf_url, error: null, published_at: new Date().toISOString() }).eq('month', month)
  if (error) throw new Error(`DB: ${error.message}`)
}

// wasLive: Die Ausgabe war schon veröffentlicht, ihr PDF bleibt bei einem Fehler online.
// finalAttempt: Kein weiterer Cron-Versuch folgt, ein Fehler wird zur Aufgabe für den Admin.
async function runBuild(sb: SupabaseClient, month: string, wasLive: boolean, finalAttempt: boolean) {
  const t0 = Date.now()
  const log = (m: string) => console.log(`[zypern-report ${month}] ${m} (+${Math.round((Date.now() - t0) / 1000)}s)`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`Zeitlimit von ${BUILD_DEADLINE_MS / 1000} s überschritten.`)), BUILD_DEADLINE_MS)
  const deadline = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true }))
  deadline.catch(() => {})
  try {
    const work = buildEdition(sb, month, ac.signal, log)
    work.catch(() => {}) // verliert sie das Rennen, darf ihr späterer Fehler nicht unbehandelt bleiben
    await Promise.race([work, deadline])
    log('live')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[zypern-report ${month}] fehlgeschlagen:`, msg)
    ac.abort(e) // laufende Anfragen beenden
    if (wasLive) {
      // Eine schon veröffentlichte Ausgabe bleibt live; aktuell.pdf wurde nicht angefasst.
      await sb.from('zypern_reports').update({ status: 'live', error: `Neuaufbau fehlgeschlagen (${cyYmd(new Date())}): ${msg}`.slice(0, 1000) }).eq('month', month)
    } else {
      await sb.from('zypern_reports').update({ status: 'failed', error: msg.slice(0, 1000) }).eq('month', month)
      if (finalAttempt) await failTask(sb, month, msg)
      else log('nächster Versuch beim nächsten Cron-Lauf')
    }
  } finally {
    clearTimeout(timer)
  }
}

// Eine Aufgabe für den Admin (Muster taskForSven in social-agent), dedupliziert über
// den Titel: solange eine offen ist, kommt keine zweite dazu.
async function failTask(sb: SupabaseClient, month: string, msg: string): Promise<void> {
  try {
    const { data: dup } = await sb.from('crm_tasks').select('id').ilike('title', '%Zypern-Report konnte nicht erstellt werden%').neq('status', 'erledigt').eq('archived', false).limit(1)
    if (dup && dup.length) return
    const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
    const adminId = (admin as { id: string } | null)?.id ?? null
    const description = `Die Ausgabe ${monthLabel(month)} konnte nicht erstellt werden. Der Link zum Report funktioniert weiter, er zeigt die letzte fertige Ausgabe.\n\nFehler: ${msg.slice(0, 500)}\n\nNeuer Versuch: Social Studio, Bereich Zypern-Report, „Neu erstellen" klicken. Klappt es wieder nicht, bitte an den Entwickler weitergeben.`
    const { data: task, error } = await sb.from('crm_tasks').insert({ title: FAIL_TASK_TITLE, description, created_by: adminId, status: 'offen' }).select('id').single()
    if (error) { console.error('[zypern-report] Aufgabe:', error.message); return }
    const taskId = (task as { id: string } | null)?.id
    if (taskId && adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
  } catch (e) {
    console.error('[zypern-report] Aufgabe:', e instanceof Error ? e.message : String(e))
  }
}

async function startBuild(sb: SupabaseClient, month: string, force: boolean, viaCron: boolean): Promise<Record<string, unknown>> {
  const { data: prevData } = await sb.from('zypern_reports').select('*').eq('month', month).maybeSingle()
  const prev = prevData as ReportRow | null
  const stale = !!prev && isStale(prev)
  if (prev?.status === 'building' && !stale) return { ok: true, started: false, reason: 'already_building', month }
  // Ein abgebrochener Neuaufbau einer veröffentlichten Ausgabe: die Ausgabe ist weiter live.
  const wasLive = prev?.status === 'live' || (stale && !!prev?.published_at && !!prev?.pdf_url)
  if (wasLive && !force) {
    if (stale) await sb.from('zypern_reports').update({ status: 'live', error: `Neuaufbau abgebrochen (${cyYmd(new Date())}).` }).eq('month', month).eq('status', 'building')
    return { ok: true, started: false, reason: 'already_live', month, pdf_url: prev?.pdf_url }
  }
  if (stale) console.warn(`[zypern-report ${month}] Bau steht seit ${prev?.started_at} auf building, gilt als abgebrochen, starte neu`)
  const started_at = new Date().toISOString()
  if (prev) {
    // Nur übernehmen, wenn die Zeile noch so aussieht wie gelesen (zwei gleichzeitige Starts).
    let q = sb.from('zypern_reports').update({ status: 'building', error: null, started_at }).eq('month', month).eq('status', prev.status)
    q = prev.started_at ? q.eq('started_at', prev.started_at) : q.is('started_at', null)
    const { data: upd, error } = await q.select('id')
    if (error) return { ok: false, error: error.message }
    if (!(upd ?? []).length) return { ok: true, started: false, reason: 'already_building', month }
  } else {
    const { error } = await sb.from('zypern_reports').insert({ month, status: 'building', started_at })
    if (error) return error.code === '23505' ? { ok: true, started: false, reason: 'already_building', month } : { ok: false, error: error.message }
  }
  const finalAttempt = !viaCron || new Date().getUTCDate() >= CRON_LAST_DAY
  const job = runBuild(sb, month, wasLive, finalAttempt)
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job)
  else await job
  return { ok: true, started: true, month }
}

// ── Zugriff ──────────────────────────────────────────────────────────────────
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
async function authorized(req: Request, sb: SupabaseClient): Promise<'service' | 'cron' | 'user' | null> {
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (bearer && SERVICE_KEY && safeEq(bearer, SERVICE_KEY)) return 'service'
  const cron = (req.headers.get('x-cron-secret') ?? '').trim()
  if (cron) {
    const { data } = await sb.from('connector_secrets').select('value').eq('key', 'CRON_SECRET_SOCIAL').maybeSingle()
    const v = ((data as { value?: string } | null)?.value ?? '').trim()
    if (v && safeEq(cron, v)) return 'cron'
  }
  if (bearer && bearer.split('.').length === 3) {
    const { data: u } = await sb.auth.getUser(bearer)
    if (u?.user) {
      const { data: p } = await sb.from('profiles').select('role, permissions').eq('id', u.user.id).maybeSingle()
      const prof = p as { role?: string; permissions?: Record<string, unknown> | null } | null
      const funnel = prof?.permissions?.funnel
      if (prof && (prof.role === 'admin' || prof.role === 'verwalter' || funnel === true || funnel === 'true')) return 'user'
    }
  }
  return null
}

const BOT_UA = /bot|crawler|spider|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|telegram|slack|discord|skype|preview|linkedin|embedly|quora link|pinterest|vkshare|w3c_validator/i

// ── HTTP ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // Öffentlicher Link: Klick zählen (nur echte Aufrufe) und aufs aktuelle PDF leiten.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const ref = (new URL(req.url).searchParams.get('c') ?? '').trim()
    const ua = req.headers.get('user-agent') ?? ''
    if (ref && req.method === 'GET' && /^[A-Za-z0-9_-]{1,64}$/.test(ref) && !BOT_UA.test(ua)) {
      const p = Promise.resolve(sb.rpc('zypern_report_click', { p_ref: ref }))
        .then(({ error }) => { if (error) console.warn('[zypern-report] Klick:', error.message) })
        .catch(e => console.warn('[zypern-report] Klick:', e instanceof Error ? e.message : String(e)))
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p)
      else await p
    }
    return new Response(null, { status: 302, headers: { ...CORS, Location: CURRENT_URL, 'Cache-Control': 'no-store' } })
  }
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405)

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* leer */ }
  const action = String(body.action ?? '')
  const via = await authorized(req, sb)
  if (!via) return json({ ok: false, error: 'unauthorized' }, 401)

  const monthArg = typeof body.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) ? body.month : null
  try {
    if (action === 'build') {
      const month = monthArg ?? cyMonth()
      return json(await startBuild(sb, month, body.force === true, via === 'cron'))
    }
    if (action === 'status') {
      const { data, error } = await sb.from('zypern_reports').select('id, month, status, pdf_url, error, created_at, started_at, published_at').order('month', { ascending: false }).limit(12)
      if (error) return json({ ok: false, error: error.message }, 500)
      // Hängender Bau (Worker beendet) zählt als gescheitert.
      const reports = ((data ?? []) as ReportRow[]).map(r => isStale(r)
        ? { ...r, status: r.published_at ? 'live' : 'failed', error: r.error ?? 'Bau abgebrochen (länger als 15 Minuten ohne Ergebnis).' }
        : r)
      return json({ ok: true, current_url: CURRENT_URL, reports })
    }
    if (action === 'preview' || action === 'rerender') {
      const month = monthArg ?? cyMonth()
      let content = (action === 'preview' && body.content && typeof body.content === 'object') ? body.content as ReportContent : null
      if (!content) {
        const { data } = await sb.from('zypern_reports').select('content').eq('month', month).maybeSingle()
        content = (data as { content?: ReportContent } | null)?.content ?? null
      }
      if (!content || !Array.isArray(content.key_facts) || !Array.isArray(content.news)) return json({ ok: false, error: 'Kein Inhalt für diesen Monat.' }, 404)
      const pdf = await renderPdf(sb, month, content)
      if (action === 'preview') return new Response(pdf, { headers: { ...CORS, 'Content-Type': 'application/pdf' } })
      const { data: row } = await sb.from('zypern_reports').select('status').eq('month', month).maybeSingle()
      if ((row as { status?: string } | null)?.status !== 'live') return json({ ok: false, error: 'Ausgabe ist nicht live.' }, 409)
      const pdf_url = await publishFiles(sb, month, pdf)
      await sb.from('zypern_reports').update({ pdf_url }).eq('month', month)
      return json({ ok: true, month, pdf_url, bytes: pdf.length })
    }
    return json({ ok: false, error: `Unbekannte Aktion: ${action}` }, 400)
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
