// social-keywords: Stichwort-Automatik „PAPHOS" für Facebook + Instagram.
//
// Wer unter einem HP-Post oder einer aktiven Anzeige das Stichwort kommentiert,
// bekommt EINE private Antwort (Meta erlaubt genau eine pro Kommentar, 7 Tage lang)
// mit dem Link zum aktuellen Zypern-Report und, wenn eingestellt, eine kurze
// öffentliche Antwort unter dem Kommentar. Keine Webhooks bei HP, daher Polling.
//
// Fehlt der App die Meta-Freigabe für private Nachrichten (Advanced Access, Business
// nicht verifiziert), geht stattdessen EINE öffentliche Antwort mit dem Report-Link
// unter den Kommentar (public_fallback_replies), damit niemand leer ausgeht. Die
// normale öffentliche Antwort („schau in deine Nachrichten") gibt es nur, wenn die
// private Nachricht wirklich raus ist.
//
// Aktionen (POST, JSON):
//   scan        {dry_run?, wait?}  Cron alle 3 Min. Kommentare der letzten 7 Tage
//               (FB + IG organisch, aktive Anzeigen FB + IG) einsammeln, Treffer
//               beantworten. dry_run = nur zählen, nichts anlegen, nichts senden.
//   status      {}                 Einstellungen, letzter Lauf, letzte 30 Anfragen.
//   test_match  {text, keywords?}  Reine Wortprüfung (für Tests).
//
// Auth: Header x-cron-secret = connector_secrets CRON_SECRET_SOCIAL, oder Bearer =
// Service-Role-Key, oder eingeloggter Nutzer (admin/verwalter oder Recht funnel).
//
// Sicherungen:
//   - Vor dem Senden wird der Link geprüft, der in die Nachricht kommt (REPORT_LINK
//     muss per 30x auf …/aktuell.pdf zeigen, das PDF muss 200 application/pdf sein).
//   - Lauf-Sperre (crm_settings social_keywords_running_since, 5 Min.) gegen
//     überlappende Läufe, Wiederholungen werden atomar beansprucht
//     (RPC social_keywords_claim, 10 Min. Sperre je Zeile über last_attempt_at).
//   - Meta-Zugangsdaten gehen nur im Authorization-Header raus und werden aus
//     allem, was gespeichert oder zurückgegeben wird, entfernt.
//
// Einstellungen: crm_settings social_keywords (JSON-Text), letzter Lauf in
// crm_settings social_keywords_last_run (auch sichtbar, wenn der Cron-Aufruf nach
// 5 s abbricht).
// Deploy: supabase functions deploy social-keywords --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

// ── Zugangsdaten nie speichern oder zurückgeben ───────────────────────────────
const TOKEN_PARAM_RE = /access_token=[^&\s)"\\]+/g
const RAW_TOKEN_RE = /\bEAA[A-Za-z0-9]{30,}/g                 // Meta-Tokens beginnen mit EAA
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
const IG_USER = 'happy_property_cyprus'
const AD_ACCOUNT = 'act_4065490590399677'
const REPORT_LINK = 'https://portal.happy-property.com/zypern-report'
const REPORT_LINK_BARE = REPORT_LINK.replace(/^https?:\/\//, '').toLowerCase()
const MAX_PER_RUN = 20
const MAX_ATTEMPTS = 3
const WINDOW_MS = 7 * 86400000 - 3600000        // Meta: 7 Tage, 1 h Sicherheit
const ADS_CACHE_MS = 30 * 60000                 // Anzeigenliste nur alle 30 Min. neu holen
const LEASE_MIN = 10                            // Zeile gilt 10 Min. als „in Arbeit"
const RUN_LOCK_S = 300                          // Lauf-Sperre verfällt nach 5 Min.
const RUN_BUDGET_MS = 180000                    // nach 3 Min. keine neuen Sendungen mehr beginnen
const TASK_ACCESS = '💬 Stichwort-Automatik: Meta-Freigabe fehlt'
const TASK_TOKEN = '💬 Stichwort-Automatik: Meta-Zugang abgelaufen'
const PUBLIC_ONLY = 'Nur öffentlich beantwortet (Meta-Freigabe für private Nachrichten fehlt)'

const DEFAULT_DM = 'Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nHier ist dein kostenloser Zypern-Report mit den aktuellen Entwicklungen auf dem Immobilienmarkt als PDF:\n{{link}}\n\nWenn du danach durchrechnen willst, was für dich drin ist: Hier kannst du dir ein kostenloses Gespräch mit Sven buchen:\nhttps://portal.happy-property.com/termin?src=zypern-report\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)'
const DEFAULT_PUBLIC = ['Ist unterwegs, schau in deine Nachrichten 📩']
const DEFAULT_FALLBACK = ['Hier ist dein Zypern-Report als PDF: {{link}} 📩', 'Gern! Den aktuellen Zypern-Report findest du hier: {{link}}']

// rules: eigene Antwort je Stichwort (z. B. RECHNER → Rechner-Links). Stichwörter
// ohne Regel bekommen dm_template / public_fallback_replies (Zypern-Report).
// report:false = Report-Link NICHT automatisch anhängen (Text bringt eigene Links).
interface KwRule { keywords: string[]; dm_template?: string; fallback_replies?: string[]; report?: boolean }
interface KwCfg {
  enabled?: boolean; keywords?: string[]; public_reply?: boolean; public_replies?: string[]; dm_template?: string; active_since?: string
  public_fallback?: boolean; public_fallback_replies?: string[]; rules?: KwRule[]
}
const kwNorm = (k: unknown) => String(k ?? '').trim().replace(/^#+/, '').normalize('NFC').toLowerCase()
export function allKeywords(cfg: KwCfg): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const k of [...strList(cfg.keywords), ...(Array.isArray(cfg.rules) ? cfg.rules : []).flatMap(r => strList(r?.keywords))]) {
    const n = kwNorm(k); if (n && !seen.has(n)) { seen.add(n); out.push(k.trim()) }
  }
  return out
}
export function ruleFor(cfg: KwCfg, kw: string | null): KwRule | null {
  const n = kwNorm(kw)
  if (!n) return null
  return (Array.isArray(cfg.rules) ? cfg.rules : []).find(r => strList(r?.keywords).some(x => kwNorm(x) === n)) ?? null
}
interface Row {
  id: string; comment_id: string; platform: 'facebook' | 'instagram'; post_id: string | null
  author_id: string | null; author_name: string | null; comment_text: string | null; keyword: string | null
  comment_at: string | null; status: string; error: string | null; attempts: number
  private_reply_at: string | null; public_reply_at: string | null; ref: string | null
  clicked_at: string | null; click_count: number; created_at: string; last_attempt_at?: string | null
}
interface Cand { comment_id: string; platform: 'facebook' | 'instagram'; post_id: string; author_id: string | null; author_name: string | null; text: string; at: number; canReply: boolean | null }
interface GErr { message?: string; code?: number; error_subcode?: number; type?: string; http?: number }
interface LinkCheck { ok: boolean; reason?: string; at: string }
interface Summary {
  at: string; dry_run?: boolean; scanned: number; found: number; sent: number; failed: number
  pending: number; skipped: number; retried: number; public_only: number; errors: string[]
  ignored?: { old: number; own: number; no_private_reply: number }
  matches?: Array<{ platform: string; comment_id: string; author: string | null; at: string; text: string; before_start: boolean }>
  ads?: { at: string; fb: string[]; ig: string[] }
  report_link?: LinkCheck
}

// ── Stichwort-Prüfung: ganzes Wort, Groß/Klein egal, Unicode-fest ──────────────
// „#paphos", „Paphos!", „paphos bitte" treffen, „Paphosfinder" nicht. Umlaute und ß
// zählen als Buchstaben (bilden also keine Wortgrenze).
const WORD = '\\p{L}\\p{N}_'
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function matchKeyword(text: string, keywords: string[]): string | null {
  const hay = String(text ?? '').normalize('NFC').toLowerCase()
  for (const raw of keywords ?? []) {
    const k = String(raw ?? '').trim().replace(/^#+/, '').normalize('NFC').toLowerCase()
    if (!k) continue
    try {
      if (new RegExp(`(?<![${WORD}])${esc(k)}(?![${WORD}])`, 'u').test(hay)) return String(raw).trim()
    } catch {
      if (hay.includes(k)) return String(raw).trim()
    }
  }
  return null
}

// ── Eigene Kommentare erkennen, auch wenn Meta „from" verschweigt ─────────────
// Alles mit dem Report-Link oder wortgleich mit einer unserer öffentlichen Antworten
// (Links darin zählen als {{link}}) stammt von uns.
const normText = (s: string) => String(s ?? '').normalize('NFC').toLowerCase()
  .replace(/https?:\/\/\S+/g, '{{link}}').replace(/\{\{\s*(\w+)\s*\}\}/g, '{{$1}}').replace(/\s+/g, ' ').trim()
const strList = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && !!x.trim())
function ownTexts(cfg: KwCfg): Set<string> {
  return new Set([...strList(cfg.public_replies), ...DEFAULT_PUBLIC, ...strList(cfg.public_fallback_replies), ...DEFAULT_FALLBACK,
    ...(Array.isArray(cfg.rules) ? cfg.rules : []).flatMap(r => strList(r?.fallback_replies))].map(normText))
}
export function isOwnText(text: string, own: Set<string>): boolean {
  if (String(text ?? '').toLowerCase().includes(REPORT_LINK_BARE)) return true
  return own.has(normText(text))
}

// ── Hilfen ────────────────────────────────────────────────────────────────────
function newRef(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => abc[b % 36]).join('')
}
const byteLen = (s: string) => new TextEncoder().encode(s).length
const reportUrl = (ref: string | null | undefined) => (ref ? `${REPORT_LINK}?c=${ref}` : REPORT_LINK)
const codeTag = (e: GErr) => (e.code ? ` [#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}]` : '')

function greetName(platform: string, name: string | null): string {
  const n = String(name ?? '').trim()
  if (!n) return ''
  const first = platform === 'facebook' ? n.split(/\s+/)[0] : n
  return first.slice(0, 40)
}

export function buildDm(template: string | undefined, platform: string, name: string | null, ref: string | null, appendReport = true): string {
  const link = reportUrl(ref)
  const fill = (tpl: string) => {
    const who = greetName(platform, name)
    let t = who ? tpl.replace(/\{\{\s*name\s*\}\}/g, who) : tpl.replace(/[ \t]*\{\{\s*name\s*\}\}/g, '')
    if (appendReport && !/\{\{\s*link\s*\}\}/.test(t)) t = `${t.trim()}\n\n${link}`
    return t.replace(/\{\{\s*link\s*\}\}/g, link).trim()
  }
  let text = fill(template?.trim() ? template : DEFAULT_DM)
  if (byteLen(text) > 1000) text = fill(DEFAULT_DM)            // Meta-Limit 1000 Bytes
  return text
}

// Öffentliche Ersatz-Antwort mit Link (wenn die private Nachricht nicht erlaubt ist).
export function buildFallback(cfg: KwCfg, platform: string, name: string | null, ref: string | null, pick = Math.random(), rule: KwRule | null = null): string {
  const ruleList = strList(rule?.fallback_replies)
  if (ruleList.length) {                                         // Regel mit eigenen Links: kein Report-Link anhängen
    const tpl = ruleList[Math.min(ruleList.length - 1, Math.floor(pick * ruleList.length))]
    const who = greetName(platform, name)
    const t = who ? tpl.replace(/\{\{\s*name\s*\}\}/g, who) : tpl.replace(/[ \t]*\{\{\s*name\s*\}\}/g, '')
    return t.replace(/\{\{\s*link\s*\}\}/g, reportUrl(ref)).trim()
  }
  const list = strList(cfg.public_fallback_replies)
  const pool = list.length ? list : DEFAULT_FALLBACK
  const tpl = pool[Math.min(pool.length - 1, Math.floor(pick * pool.length))]
  const link = reportUrl(ref)
  const who = greetName(platform, name)
  let t = who ? tpl.replace(/\{\{\s*name\s*\}\}/g, who) : tpl.replace(/[ \t]*\{\{\s*name\s*\}\}/g, '')
  if (!/\{\{\s*link\s*\}\}/.test(t)) t = `${t.trim()} ${link}`
  return t.replace(/\{\{\s*link\s*\}\}/g, link).trim()
}

async function setting(sb: SupabaseClient, key: string): Promise<Record<string, unknown>> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', key).maybeSingle()
  try { return JSON.parse((data as { value?: string } | null)?.value ?? '{}') as Record<string, unknown> } catch { return {} }
}
async function saveSetting(sb: SupabaseClient, key: string, value: unknown): Promise<void> {
  const { error } = await sb.from('crm_settings').upsert({ key, value: JSON.stringify(value, redactReplacer), updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) console.error(`[social-keywords] ${key} speichern:`, error.message)
}
async function secret(sb: SupabaseClient, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return String((data as { value?: string } | null)?.value ?? Deno.env.get(key) ?? '').trim()
}
async function cronSecret(sb: SupabaseClient): Promise<string> {
  let s = await secret(sb, 'CRON_SECRET_SOCIAL')
  if (!s) {
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const val = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => abc[b % abc.length]).join('')
    await sb.from('connector_secrets').upsert({ key: 'CRON_SECRET_SOCIAL', value: val, updated_at: new Date().toISOString() }, { onConflict: 'key', ignoreDuplicates: true })
    s = await secret(sb, 'CRON_SECRET_SOCIAL')
  }
  return s
}
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

async function authorized(sb: SupabaseClient, req: Request): Promise<boolean> {
  const cron = (req.headers.get('x-cron-secret') ?? '').trim()
  if (cron && sameSecret(cron, await cronSecret(sb))) return true
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!bearer) return false
  const srk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (srk && sameSecret(bearer, srk)) return true
  const { data } = await sb.auth.getUser(bearer)
  const uid = data?.user?.id
  if (!uid) return false
  const { data: prof } = await sb.from('profiles').select('role, permissions').eq('id', uid).maybeSingle()
  const p = prof as { role?: string; permissions?: Record<string, unknown> | null } | null
  if (p?.role === 'admin' || p?.role === 'verwalter') return true
  return String(p?.permissions?.funnel ?? '') === 'true'
}

// Einmalige Aufgabe an Sven (Admin), dedupliziert über den Titel (wie social-agent).
async function taskForSven(sb: SupabaseClient, title: string, description: string): Promise<void> {
  const { data: dup } = await sb.from('crm_tasks').select('id').eq('title', title).neq('status', 'erledigt').eq('archived', false).limit(1)
  if (dup && dup.length) return
  const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
  const adminId = (admin as { id: string } | null)?.id ?? null
  const { data: task } = await sb.from('crm_tasks').insert({ title, description, created_by: adminId, status: 'offen' }).select('id').single()
  const taskId = (task as { id: string } | null)?.id
  if (taskId && adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
}
const ACCESS_TEXT = `Die Stichwort-Automatik (Kommentar „PAPHOS" → Zypern-Report per Nachricht) konnte eine private Antwort nicht senden, weil Meta es der App noch nicht erlaubt.

Was fehlt: Die Meta-App braucht „Advanced Access" für pages_messaging (Facebook) und instagram_manage_messages (Instagram). Das gibt es über den App Review im Meta-Entwicklerportal (developers.facebook.com > App > App Review > Permissions and Features). Voraussetzung ist in der Regel ein verifiziertes Meta-Business.

Bis dahin bekommen nur Personen die private Nachricht, die in der App eine Rolle haben (Admin, Entwickler, Tester). Alle anderen bekommen stattdessen eine öffentliche Antwort unter ihrem Kommentar mit dem Link zum Report (Texte in den Einstellungen unter public_fallback_replies).

Die betroffenen Kommentare stehen im Social-Studio unter „Stichwort-Automatik" (Hinweis „Nur öffentlich beantwortet"). Bitte Claude Bescheid geben, sobald die Freigabe da ist.`
const TOKEN_TEXT = `Die Stichwort-Automatik (Kommentar „PAPHOS" → Zypern-Report per Nachricht) kommt nicht mehr an Facebook und Instagram: Der Meta-Zugang (META_ACCESS_TOKEN) ist abgelaufen oder ungültig.

Solange das so ist, werden keine Kommentare beantwortet. Bitte Claude Bescheid geben, damit der Zugang erneuert wird.`

// ── Meta Graph ────────────────────────────────────────────────────────────────
// Token nur im Authorization-Header, nie in der URL (Fehlertexte enthalten die URL).
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
async function gPost(path: string, token: string, body: Record<string, unknown>, form = false): Promise<{ id?: string; message_id?: string; error?: GErr }> {
  const u = new URL(`${G}/${path.replace(/^\//, '')}`)
  const auth = { Authorization: `Bearer ${token}` }
  try {
    const r = await fetch(u, form
      ? { method: 'POST', headers: auth, body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])), signal: AbortSignal.timeout(25000) }
      : { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) })
    const d = await r.json().catch(() => null) as { id?: string; message_id?: string; error?: GErr } | null
    if (!d) return { error: { message: `HTTP ${r.status}`, http: r.status, code: r.status >= 500 ? 2 : undefined } }
    if (d.error) { d.error.http = r.status; d.error.message = redact(d.error.message) }
    else if (!r.ok) return { error: { message: `HTTP ${r.status}`, http: r.status } }
    return d
  } catch (e) {
    // Netzwerkfehler/Timeout: ob Meta gesendet hat, ist unklar. Meta erlaubt nur eine
    // private Antwort, ein zweiter Versuch kann also nie doppelt senden.
    return { error: { message: redact(e instanceof Error ? e.message : String(e)), code: 2 } }
  }
}

type ErrKind = 'temporary' | 'access' | 'token' | 'final' | 'retry'
function classify(e: GErr): { kind: ErrKind; text: string } {
  const code = Number(e.code ?? 0), sub = Number(e.error_subcode ?? 0)
  const raw = redact(e.message).slice(0, 160)
  const msg = raw.toLowerCase()
  if ([4, 17, 32, 613].includes(code) || (e.http ?? 0) >= 500 || code === 1 || code === 2)
    return { kind: 'temporary', text: 'Meta lässt gerade keine weiteren Anfragen zu oder war nicht erreichbar. Nächster Versuch in ein paar Minuten.' }
  if (code === 368) return { kind: 'temporary', text: 'Meta hat die Aktion vorübergehend gesperrt. Nächster Versuch später.' }
  if (code === 190) return { kind: 'token', text: 'Der Meta-Zugang ist abgelaufen oder ungültig.' }
  if (sub === 10900 || /already (been )?(replied|sent)|only.*one.*private/i.test(msg))
    return { kind: 'final', text: 'Auf diesen Kommentar ging schon eine private Antwort raus. Meta erlaubt nur eine.' }
  if (code === 551) return { kind: 'final', text: 'Diese Person nimmt gerade keine Nachrichten an.' }
  if (code === 10 && sub === 2018278) return { kind: 'access', text: 'Meta hat die private Antwort abgelehnt (außerhalb des erlaubten Zeitfensters oder fehlende Meta-Freigabe für Nachrichten).' }
  if ([10, 200, 230, 3].includes(code) || sub === 2534001 || /permission|advanced access|not authorized|capability/i.test(msg))
    return { kind: 'access', text: 'Meta erlaubt der App noch keine private Nachricht an diese Person. Dafür fehlt die Meta-Freigabe (Advanced Access für Nachrichten).' }
  if (code === 100) return { kind: 'final', text: 'Den Kommentar gibt es nicht mehr (gelöscht oder ausgeblendet), oder er lässt keine Antwort zu.' }
  return { kind: 'retry', text: `Meta-Fehler: ${raw || 'unbekannt'}` }
}
const pushErr = (sum: Summary, text: string) => { const t = redact(text); if (!sum.errors.some(e => e.startsWith(t.slice(0, 40)))) sum.errors.push(t) }

interface Meta { pageId: string; pageToken: string; igId: string; sysToken: string }
async function metaAccess(sb: SupabaseClient): Promise<Meta | { error: GErr }> {
  const sysToken = await secret(sb, 'META_ACCESS_TOKEN')
  if (!sysToken) return { error: { message: 'META_ACCESS_TOKEN fehlt', code: 190 } }
  const acc = await gGet<{ data?: Array<{ id: string; access_token: string; instagram_business_account?: { id: string } }> }>('me/accounts', sysToken, { fields: 'id,access_token,instagram_business_account' })
  if (acc.error) return { error: acc.error }
  const page = (acc.data ?? []).find(p => p.id === PAGE_ID) ?? acc.data?.[0]
  if (!page?.access_token) return { error: { message: 'Keine Facebook-Seite im Meta-Zugang gefunden' } }
  return { pageId: page.id, pageToken: page.access_token, igId: page.instagram_business_account?.id ?? IG_ID, sysToken }
}

// ── Link-Prüfung: genau der Link, der in die Nachricht kommt ──────────────────
// REPORT_LINK (Vercel-Rewrite → Function zypern-report) muss per 30x auf …/aktuell.pdf
// weiterleiten und dort ein PDF liefern. HEAD zählt in zypern-report keinen Klick.
async function checkReportLink(): Promise<LinkCheck> {
  const at = new Date().toISOString()
  const fail = (reason: string): LinkCheck => ({ ok: false, reason, at })
  let loc = ''
  try {
    const r = await fetch(REPORT_LINK, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) })
    await r.body?.cancel().catch(() => {})
    const ct = (r.headers.get('content-type') ?? '').split(';')[0].trim()
    if (![301, 302, 307, 308].includes(r.status))
      return fail(`Der Report-Link ${REPORT_LINK} leitet nicht auf das PDF weiter (HTTP ${r.status}${ct ? `, ${ct}` : ''} statt Weiterleitung).`)
    loc = r.headers.get('location') ?? ''
  } catch (e) {
    return fail(`Der Report-Link ${REPORT_LINK} ist nicht erreichbar (${redact(e instanceof Error ? e.message : String(e)).slice(0, 120)}).`)
  }
  let target: URL
  try { target = new URL(loc, REPORT_LINK) } catch { return fail(`Der Report-Link ${REPORT_LINK} leitet auf ein ungültiges Ziel weiter.`) }
  if (!target.pathname.endsWith('/aktuell.pdf'))
    return fail(`Der Report-Link ${REPORT_LINK} leitet nicht auf aktuell.pdf weiter (Ziel: ${redact(target.href).slice(0, 160)}).`)
  try {
    const p = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    await p.body?.cancel().catch(() => {})
    const pct = (p.headers.get('content-type') ?? '').toLowerCase()
    if (p.status !== 200) return fail(`Das PDF hinter dem Report-Link ist nicht abrufbar (HTTP ${p.status}).`)
    if (!pct.includes('application/pdf')) return fail(`Hinter dem Report-Link liegt kein PDF (Typ ${pct.split(';')[0] || 'unbekannt'}).`)
  } catch (e) {
    return fail(`Das PDF hinter dem Report-Link ist nicht erreichbar (${redact(e instanceof Error ? e.message : String(e)).slice(0, 120)}).`)
  }
  return { ok: true, at }
}

const FB_C = 'comments.order(reverse_chronological).limit(50){id,created_time,from,message,can_reply_privately}'
const IG_C = 'comments.limit(50){id,timestamp,from,username,text}'
type FbComment = { id: string; created_time?: string; from?: { id?: string; name?: string }; message?: string; can_reply_privately?: boolean }
type IgComment = { id: string; timestamp?: string; from?: { id?: string; username?: string }; username?: string; text?: string }

async function collect(m: Meta, prevAds: Summary['ads'] | undefined, errors: string[]): Promise<{ cands: Cand[]; ads: Summary['ads'] }> {
  const cands: Cand[] = []
  const fbPost = (postId: string, cs: FbComment[] | undefined) => {
    for (const c of cs ?? []) cands.push({
      comment_id: c.id, platform: 'facebook', post_id: postId, author_id: c.from?.id ?? null, author_name: c.from?.name ?? null,
      text: c.message ?? '', at: Date.parse(c.created_time ?? '') || 0, canReply: typeof c.can_reply_privately === 'boolean' ? c.can_reply_privately : null,
    })
  }
  const igMedia = (mediaId: string, cs: IgComment[] | undefined) => {
    for (const c of cs ?? []) cands.push({
      comment_id: c.id, platform: 'instagram', post_id: mediaId, author_id: c.from?.id ?? null, author_name: c.username ?? c.from?.username ?? null,
      text: c.text ?? '', at: Date.parse(c.timestamp ?? '') || 0, canReply: null,
    })
  }
  const seenFb = new Set<string>(), seenIg = new Set<string>()

  // 1) Facebook organisch: letzte 25 Beiträge mit ihren neuesten Kommentaren (1 Aufruf)
  const fb = await gGet<{ data?: Array<{ id: string; comments?: { data?: FbComment[] } }> }>(`${m.pageId}/published_posts`, m.pageToken, { fields: `id,${FB_C}`, limit: '25' })
  if (fb.error) errors.push(redact(`Facebook-Beiträge: ${fb.error.message ?? 'Fehler'}${fb.error.code ? ` (#${fb.error.code})` : ''}`))
  for (const p of fb.data ?? []) { seenFb.add(p.id); fbPost(p.id, p.comments?.data) }

  // 2) Instagram organisch: letzte 25 Medien (1 Aufruf)
  if (m.igId) {
    const ig = await gGet<{ data?: Array<{ id: string; comments?: { data?: IgComment[] } }> }>(`${m.igId}/media`, m.pageToken, { fields: `id,${IG_C}`, limit: '25' })
    if (ig.error) errors.push(redact(`Instagram-Beiträge: ${ig.error.message ?? 'Fehler'}${ig.error.code ? ` (#${ig.error.code})` : ''}`))
    for (const p of ig.data ?? []) { seenIg.add(p.id); igMedia(p.id, p.comments?.data) }
  }

  // 3) Aktive Anzeigen: Kommentare hängen an unveröffentlichten Beiträgen. Liste wird
  //    30 Minuten zwischengespeichert, damit der 3-Minuten-Takt die Ads-API schont.
  let ads = prevAds
  if (!ads || Date.now() - Date.parse(ads.at) > ADS_CACHE_MS) {
    const r = await gGet<{ data?: Array<{ creative?: { effective_object_story_id?: string; effective_instagram_media_id?: string } }> }>(`${AD_ACCOUNT}/ads`, m.sysToken, {
      fields: 'creative{effective_object_story_id,effective_instagram_media_id}', effective_status: '["ACTIVE"]', limit: '50',
    })
    if (r.error) { errors.push(redact(`Anzeigen: ${r.error.message ?? 'Fehler'}${r.error.code ? ` (#${r.error.code})` : ''}`)); ads = prevAds }
    else ads = {
      at: new Date().toISOString(),
      fb: [...new Set((r.data ?? []).map(a => a.creative?.effective_object_story_id).filter((x): x is string => !!x))].slice(0, 50),
      ig: [...new Set((r.data ?? []).map(a => a.creative?.effective_instagram_media_id).filter((x): x is string => !!x))].slice(0, 50),
    }
  }
  const fbAds = (ads?.fb ?? []).filter(id => !seenFb.has(id))
  const igAds = (ads?.ig ?? []).filter(id => !seenIg.has(id))
  if (fbAds.length) {
    const r = await gGet<Record<string, { comments?: { data?: FbComment[] } }>>('', m.pageToken, { ids: fbAds.join(','), fields: FB_C })
    if (r.error) errors.push(redact(`Anzeigen-Kommentare Facebook: ${r.error.message ?? 'Fehler'}`))
    else for (const [id, v] of Object.entries(r)) if (id !== 'error') fbPost(id, (v as { comments?: { data?: FbComment[] } })?.comments?.data)
  }
  if (igAds.length) {
    const r = await gGet<Record<string, { comments?: { data?: IgComment[] } }>>('', m.pageToken, { ids: igAds.join(','), fields: IG_C })
    if (r.error) errors.push(redact(`Anzeigen-Kommentare Instagram: ${r.error.message ?? 'Fehler'}`))
    else for (const [id, v] of Object.entries(r)) if (id !== 'error') igMedia(id, (v as { comments?: { data?: IgComment[] } })?.comments?.data)
  }
  // Doppelte (Beitrag organisch UND als Anzeige) entfernen
  const uniq = new Map<string, Cand>()
  for (const c of cands) if (!uniq.has(c.comment_id)) uniq.set(c.comment_id, c)
  return { cands: [...uniq.values()], ads }
}

// ── Senden: private Antwort, dann (optional) öffentliche Antwort ──────────────
interface SendCtx { sb: SupabaseClient; m: Meta; cfg: KwCfg; sum: Summary; flags: { access: boolean; token: boolean; stop: boolean } }
const commentReplyPath = (row: Row) => (row.platform === 'instagram' ? `${row.comment_id}/replies` : `${row.comment_id}/comments`)

async function sendOne(ctx: SendCtx, row: Row): Promise<void> {
  const { sb, m, cfg, sum, flags } = ctx
  const stamp = () => new Date().toISOString()
  const upd: Partial<Row> = {}
  if (!row.private_reply_at) {
    const rule = ruleFor(cfg, row.keyword)
    const text = buildDm(rule?.dm_template ?? cfg.dm_template, row.platform, row.author_name, row.ref, rule ? rule.report !== false : true)
    const r = await gPost(`${m.pageId}/messages`, m.pageToken, { recipient: { comment_id: row.comment_id }, message: { text } })
    if (r.error) {
      const c = classify(r.error)
      if (c.kind === 'access') { flags.access = true; await publicFallback(ctx, row, c.text, r.error); return }
      const retryable = c.kind === 'temporary' || c.kind === 'token' || c.kind === 'retry'
      const status = retryable && row.attempts < MAX_ATTEMPTS ? 'pending' : 'failed'
      await sb.from('social_keyword_replies').update({ status, error: redact(`${c.text}${codeTag(r.error)}`) }).eq('id', row.id)
      if (status === 'pending') sum.pending++; else sum.failed++
      pushErr(sum, c.text)
      if (c.kind === 'token') { flags.token = true; flags.stop = true }
      if (c.kind === 'temporary') flags.stop = true                  // Meta bremst: Rest im nächsten Lauf
      return
    }
    upd.private_reply_at = stamp()
  }
  // Öffentliche Antwort („schau in deine Nachrichten") nur, wenn die private Nachricht wirklich raus ist
  if (cfg.public_reply !== false && !row.public_reply_at) {
    const list = strList(cfg.public_replies)
    const pool = list.length ? list : DEFAULT_PUBLIC
    const message = pool[Math.floor(Math.random() * pool.length)]
    const r = await gPost(commentReplyPath(row), m.pageToken, { message }, true)
    if (r.error) upd.error = redact(`Nachricht ist raus, die öffentliche Antwort nicht: ${classify(r.error).text}`)
    else { upd.public_reply_at = stamp(); upd.error = null }
  } else upd.error = null
  await sb.from('social_keyword_replies').update({ ...upd, status: 'sent' }).eq('id', row.id)
  sum.sent++
}

// Private Nachricht ohne Meta-Freigabe nicht möglich: EINE öffentliche Antwort mit
// dem Report-Link, damit die Person trotzdem ans PDF kommt.
async function publicFallback(ctx: SendCtx, row: Row, accessText: string, accessErr: GErr): Promise<void> {
  const { sb, m, cfg, sum, flags } = ctx
  const save = (patch: Record<string, unknown>) => sb.from('social_keyword_replies').update(patch).eq('id', row.id)
  pushErr(sum, 'Meta-Freigabe für private Nachrichten fehlt: Anfragen werden stattdessen öffentlich unter dem Kommentar mit dem Report-Link beantwortet.')
  if (row.public_reply_at) {                                           // schon in einem früheren Versuch öffentlich beantwortet
    await save({ status: 'sent', error: PUBLIC_ONLY })
    sum.sent++; sum.public_only++; return
  }
  if (cfg.public_fallback === false) {
    await save({ status: 'failed', error: redact(`${accessText}${codeTag(accessErr)} Öffentliche Ersatz-Antwort ist ausgeschaltet.`) })
    sum.failed++; return
  }
  const message = buildFallback(cfg, row.platform, row.author_name, row.ref, Math.random(), ruleFor(cfg, row.keyword))
  const r = await gPost(commentReplyPath(row), m.pageToken, { message }, true)
  if (!r.error) {
    await save({ status: 'sent', error: PUBLIC_ONLY, public_reply_at: new Date().toISOString() })
    sum.sent++; sum.public_only++; return
  }
  const pc = classify(r.error)
  // Nur wiederholen, wenn Meta sicher nichts gepostet hat (Drossel/Sperre/Token). Bei
  // Zeitüberschreitung oder 5xx ist unklar, ob die Antwort steht: dann lieber keine
  // zweite öffentliche Antwort riskieren.
  const safeRetry = [4, 17, 32, 613, 368].includes(Number(r.error.code ?? 0)) || pc.kind === 'token'
  const status = safeRetry && row.attempts < MAX_ATTEMPTS ? 'pending' : 'failed'
  await save({ status, error: redact(`${accessText}${codeTag(accessErr)} Die öffentliche Antwort mit dem Link ging auch nicht raus: ${pc.text}${codeTag(r.error)}`) })
  if (status === 'pending') sum.pending++; else sum.failed++
  pushErr(sum, `Öffentliche Ersatz-Antwort: ${pc.text}`)
  if (pc.kind === 'token') { flags.token = true; flags.stop = true }
  if (pc.kind === 'temporary') flags.stop = true
}

// ── Scan ──────────────────────────────────────────────────────────────────────
// test (nur mit dry_run): andere Stichwörter / 7-Tage-Fenster ignorieren, um die
// Auswertung an echten, älteren Kommentaren zu prüfen, ohne etwas zu senden.
type ScanResult = Summary | { skipped: string }
async function scan(sb: SupabaseClient, dryRun: boolean, test: { keywords?: string[]; ignoreWindow?: boolean } = {}): Promise<ScanResult> {
  const cfg = await setting(sb, 'social_keywords') as KwCfg
  if (!cfg.enabled && !dryRun) return { skipped: 'Stichwort-Automatik ist ausgeschaltet.' }
  if (dryRun) return await scanRun(sb, cfg, true, test)
  // Lauf-Sperre: überlappende Läufe (Cron + Handstart) überspringen. Kann die Sperre
  // nicht gesetzt werden, lieber nichts senden.
  const run = `${newRef()}${newRef()}`
  const { data: locked, error: lockErr } = await sb.rpc('social_keywords_run_lock', { p_run: run, p_ttl_seconds: RUN_LOCK_S })
  if (lockErr) return { skipped: redact(`Lauf-Sperre nicht möglich: ${lockErr.message}`) }
  if (locked !== true) return { skipped: 'Ein anderer Lauf ist noch aktiv.' }
  try {
    return await scanRun(sb, cfg, false, {})
  } finally {
    const { error } = await sb.rpc('social_keywords_run_unlock', { p_run: run })
    if (error) console.error('[social-keywords] Sperre lösen:', redact(error.message))
  }
}

async function scanRun(sb: SupabaseClient, cfg: KwCfg, dryRun: boolean, test: { keywords?: string[]; ignoreWindow?: boolean }): Promise<Summary> {
  const started = Date.now()
  const keywords = (test.keywords?.length ? test.keywords : allKeywords(cfg)).filter(k => typeof k === 'string' && k.trim())
  const prev = await setting(sb, 'social_keywords_last_run') as Partial<Summary>
  const sum: Summary = { at: new Date().toISOString(), scanned: 0, found: 0, sent: 0, failed: 0, pending: 0, skipped: 0, retried: 0, public_only: 0, errors: [], ignored: { old: 0, own: 0, no_private_reply: 0 }, ...(dryRun ? { dry_run: true, matches: [] } : {}) }
  const persist = async () => { if (!dryRun) await saveSetting(sb, 'social_keywords_last_run', sum) }
  // Link-Prüfung einmal je Lauf
  let linkCheck: Promise<LinkCheck> | null = null
  const reportLink = () => (linkCheck ??= checkReportLink())
  try {
    if (!keywords.length) { sum.errors.push('Keine Stichwörter eingestellt.'); await persist(); return sum }
    const m = await metaAccess(sb)
    if ('error' in m) {
      const c = classify(m.error)
      sum.errors.push(redact(c.kind === 'token' ? c.text : `Meta: ${m.error.message ?? 'nicht erreichbar'}`))
      if (c.kind === 'token' && !dryRun) await taskForSven(sb, TASK_TOKEN, TOKEN_TEXT)
      sum.ads = prev.ads
      await persist(); return sum
    }
    const { cands, ads } = await collect(m, prev.ads, sum.errors)
    sum.ads = ads
    if (sum.errors.some(e => /#190\)/.test(e)) && !dryRun) await taskForSven(sb, TASK_TOKEN, TOKEN_TEXT)
    sum.scanned = cands.length

    const now = Date.now()
    const activeSince = Date.parse(cfg.active_since ?? '') || 0
    const own = ownTexts(cfg)
    const hits: Array<Cand & { keyword: string }> = []
    for (const c of cands) {
      if (!c.text.trim()) continue
      const ign = sum.ignored!
      if (c.platform === 'facebook' && c.author_id && c.author_id === m.pageId) { ign.own++; continue }
      if (c.platform === 'instagram' && ((c.author_id && c.author_id === m.igId) || (c.author_name ?? '').toLowerCase() === IG_USER)) { ign.own++; continue }
      if (isOwnText(c.text, own)) { ign.own++; continue }             // eigene Antwort, auch ohne „from"
      if (!test.ignoreWindow && (!c.at || now - c.at > WINDOW_MS)) { ign.old++; continue }
      if (c.canReply === false && !test.ignoreWindow) { ign.no_private_reply++; continue }
      const kw = matchKeyword(c.text, keywords)
      if (kw) hits.push({ ...c, keyword: kw })
    }
    // Schon bekannte Kommentare raus
    const known = new Set<string>()
    for (let i = 0; i < hits.length; i += 100) {
      const { data } = await sb.from('social_keyword_replies').select('comment_id').in('comment_id', hits.slice(i, i + 100).map(h => h.comment_id))
      for (const r of (data ?? []) as Array<{ comment_id: string }>) known.add(r.comment_id)
    }
    const fresh = hits.filter(h => !known.has(h.comment_id)).sort((a, b) => a.at - b.at)
    sum.found = fresh.length
    if (dryRun) {
      sum.matches = fresh.map(h => ({ platform: h.platform, comment_id: h.comment_id, author: h.author_name, at: new Date(h.at).toISOString(), text: h.text.slice(0, 120), before_start: h.at < activeSince }))
      sum.report_link = await reportLink()                            // nur lesend (HEAD)
      return sum
    }

    // Offene Wiederholungen (vorübergehende Meta-Fehler), noch im 7-Tage-Fenster und
    // nicht gerade von einem anderen Lauf in Arbeit (last_attempt_at älter als 10 Min.)
    const windowCut = new Date(now - WINDOW_MS).toISOString()
    const leaseCut = new Date(now - LEASE_MIN * 60000).toISOString()
    const { data: retryRaw } = await sb.from('social_keyword_replies').select('*').eq('status', 'pending').lt('attempts', MAX_ATTEMPTS)
      .gt('comment_at', windowCut).or(`last_attempt_at.is.null,last_attempt_at.lt."${leaseCut}"`).order('comment_at').limit(MAX_PER_RUN)
    const retries = (retryRaw ?? []) as Row[]
    // Hängende Zeilen außerhalb des Fensters abschließen
    await sb.from('social_keyword_replies').update({ status: 'failed', error: 'Das 7-Tage-Fenster von Meta ist abgelaufen, bevor die Nachricht raus konnte.' })
      .eq('status', 'pending').lte('comment_at', windowCut)
    // Zeilen, deren letzter Versuch abgebrochen ist und die keinen Versuch mehr haben
    await sb.from('social_keyword_replies').update({ status: 'failed', error: 'Der letzte Versuch ist abgebrochen, weitere Versuche gibt es nicht. Bitte im Studio prüfen.' })
      .eq('status', 'pending').gte('attempts', MAX_ATTEMPTS).lt('last_attempt_at', leaseCut)

    // Kommentare von vor dem Start nie anschreiben, nur vermerken
    const before = fresh.filter(h => h.at < activeSince)
    const todo = fresh.filter(h => h.at >= activeSince)
    for (const h of before) {
      const { error } = await sb.from('social_keyword_replies').insert({
        comment_id: h.comment_id, platform: h.platform, post_id: h.post_id, author_id: h.author_id, author_name: h.author_name,
        comment_text: h.text.slice(0, 2000), keyword: h.keyword, comment_at: new Date(h.at).toISOString(), status: 'skipped', error: 'vor Start der Automatik',
      })
      if (!error) sum.skipped++
    }
    if (!todo.length && !retries.length) { await persist(); return sum }

    // Den Link prüfen, der wirklich in die Nachricht kommt. Stimmt er nicht, in diesem
    // Lauf nichts senden: neue Treffer bleiben unberührt, Wiederholungen unbeansprucht.
    sum.report_link = await reportLink()
    if (!sum.report_link.ok) {
      sum.errors.push(`Nichts gesendet: ${sum.report_link.reason} Die Anfragen werden beantwortet, sobald der Link stimmt.`)
      await persist(); return sum
    }

    const ctx: SendCtx = { sb, m, cfg, sum, flags: { access: false, token: false, stop: false } }
    const outOfTime = () => Date.now() - started > RUN_BUDGET_MS
    let budget = MAX_PER_RUN
    for (const r of retries) {
      if (budget <= 0 || ctx.flags.stop || outOfTime()) break
      // Atomar beanspruchen: nur wenn noch pending und nicht in den letzten 10 Min. versucht
      const { data: cl, error: ce } = await sb.rpc('social_keywords_claim', { p_id: r.id, p_lease_minutes: LEASE_MIN })
      if (ce) { pushErr(sum, `Wiederholung beanspruchen: ${ce.message}`); break }
      const claimed = (Array.isArray(cl) ? cl[0] : cl) as Row | null | undefined
      if (!claimed?.id) continue
      budget--; sum.retried++
      await sendOne(ctx, claimed)
    }
    for (const h of todo) {
      if (budget <= 0 || ctx.flags.stop || outOfTime()) break
      let row: Row | null = null
      for (let i = 0; i < 3 && !row; i++) {
        const { data, error } = await sb.from('social_keyword_replies').insert({
          comment_id: h.comment_id, platform: h.platform, post_id: h.post_id, author_id: h.author_id, author_name: h.author_name,
          comment_text: h.text.slice(0, 2000), keyword: h.keyword, comment_at: new Date(h.at).toISOString(),
          status: 'pending', attempts: 1, ref: newRef(), last_attempt_at: new Date().toISOString(),
        }).select('*').maybeSingle()
        if (!error) { row = data as Row; break }
        if (/comment_id/.test(`${error.message} ${error.details ?? ''}`)) break   // schon von einem anderen Lauf angelegt
        if (!/ref/.test(`${error.message} ${error.details ?? ''}`)) { sum.errors.push(redact(`Speichern: ${error.message}`)); break }
      }
      if (!row) continue
      budget--
      await sendOne(ctx, row)
    }
    if (ctx.flags.access) await taskForSven(sb, TASK_ACCESS, ACCESS_TEXT)
    if (ctx.flags.token) await taskForSven(sb, TASK_TOKEN, TOKEN_TEXT)
  } catch (e) {
    sum.errors.push(redact(`Unerwarteter Fehler: ${e instanceof Error ? e.message : String(e)}`).slice(0, 300))
  }
  await persist()
  return sum
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    if (!(await authorized(sb, req))) return json({ error: 'Keine Berechtigung.' }, 401)
    const body = await req.json().catch(() => ({})) as { action?: string; text?: string; keywords?: string[]; dry_run?: boolean; wait?: boolean; test_keywords?: string[]; test_ignore_window?: boolean }

    if (body.action === 'test_match') {
      const cfg = await setting(sb, 'social_keywords') as KwCfg
      const kws = Array.isArray(body.keywords) && body.keywords.length ? body.keywords : allKeywords(cfg)
      return json({ ok: true, text: body.text ?? '', keywords: kws, match: matchKeyword(String(body.text ?? ''), kws), own: isOwnText(String(body.text ?? ''), ownTexts(cfg)) })
    }

    if (body.action === 'status') {
      const cfg = await setting(sb, 'social_keywords') as KwCfg
      const last = await setting(sb, 'social_keywords_last_run') as Partial<Summary>
      delete last.ads
      const { data: rows, error } = await sb.from('social_keyword_replies')
        .select('id, comment_id, platform, author_name, comment_text, keyword, comment_at, status, error, attempts, private_reply_at, public_reply_at, clicked_at, click_count, created_at')
        .order('created_at', { ascending: false }).limit(30)
      const { count: sentTotal } = await sb.from('social_keyword_replies').select('id', { count: 'exact', head: true }).eq('status', 'sent')
      const { count: clickedTotal } = await sb.from('social_keyword_replies').select('id', { count: 'exact', head: true }).not('clicked_at', 'is', null)
      return json({
        ok: true,
        config: {
          enabled: !!cfg.enabled, keywords: allKeywords(cfg), rules: Array.isArray(cfg.rules) ? cfg.rules : [], public_reply: cfg.public_reply !== false, public_replies: cfg.public_replies ?? [],
          public_fallback: cfg.public_fallback !== false, public_fallback_replies: strList(cfg.public_fallback_replies).length ? strList(cfg.public_fallback_replies) : DEFAULT_FALLBACK,
          dm_template: cfg.dm_template ?? DEFAULT_DM, active_since: cfg.active_since ?? null,
        },
        last_run: Object.keys(last).length ? last : null,
        totals: { sent: sentTotal ?? 0, clicked: clickedTotal ?? 0 },
        rows: rows ?? [], error: error?.message ?? null,
      })
    }

    if (body.action === 'scan') {
      const job = scan(sb, !!body.dry_run, { keywords: Array.isArray(body.test_keywords) ? body.test_keywords : undefined, ignoreWindow: !!body.test_ignore_window })
        .catch((e): ScanResult => ({ skipped: redact(`Fehler: ${e instanceof Error ? e.message : String(e)}`) }))
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job)
      // Cron bricht nach 5 s ab: kurz warten, sonst im Hintergrund weiterlaufen lassen.
      // Das Ergebnis steht dann in crm_settings social_keywords_last_run.
      const res = await Promise.race([job, new Promise<null>(r => setTimeout(() => r(null), body.wait || body.dry_run ? 55000 : 4000))])
      if (!res) return json({ ok: true, running: true })
      const out = { ...(res as Record<string, unknown>) }
      delete out.ads
      return json({ ok: true, ...out })
    }

    return json({ error: `Unbekannte Aktion: ${body.action ?? '(leer)'}` }, 400)
  } catch (e) {
    console.error('[social-keywords]', redact(e instanceof Error ? e.message : String(e)))
    return json({ error: redact(e instanceof Error ? e.message : String(e)) }, 500)
  }
})
