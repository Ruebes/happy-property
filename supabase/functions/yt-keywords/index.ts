// yt-keywords: Stichwort-Automatik für YouTube-Kommentare.
//
// YouTube hat keine Direktnachrichten. Wer unter einem Video oder Short ein Stichwort
// kommentiert (z. B. FINANZAMT), bekommt deshalb eine ÖFFENTLICHE Antwort vom Kanal.
// Es greifen nur Regeln aus crm_settings social_keywords mit `youtube: true`, der Text
// kommt aus `youtube_replies` (Zufallsauswahl, {{name}} = Anzeigename). Facebook und
// Instagram bleiben bei der Function social-keywords.
//
// Aktionen (POST JSON):
//   scan {dry_run?}  Cron alle 10 Min. Neueste 25 Uploads, Kommentare nur von Videos,
//                    deren Kommentarzahl sich seit dem letzten Lauf geändert hat
//                    (spart YouTube-Kontingent). Beantwortet werden nur Kommentare der
//                    letzten 7 Tage (und nach active_since), die der Kanal noch nicht
//                    selbst beantwortet hat.
//                    dry_run = nur zählen, nichts anlegen, nichts posten.
//
// Auth: Header x-cron-secret = connector_secrets CRON_SECRET_SOCIAL, oder Bearer =
// Service-Role-Key. Protokoll: social_keyword_replies (platform 'youtube'), sichtbar
// im Social Studio. comment_id unique verhindert doppelte Antworten.
// Letzter Lauf: crm_settings yt_keywords_last_run, Kommentarzahlen: yt_keywords_state.
// Deploy: supabase functions deploy yt-keywords --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const YT = 'https://www.googleapis.com/youtube/v3'
const UPLOADS_TO_CHECK = 25
const MAX_AGE_MS = 7 * 24 * 3600 * 1000

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

interface KwRule { keywords?: string[]; youtube?: boolean; youtube_replies?: string[] }
interface KwCfg { enabled?: boolean; active_since?: string; rules?: KwRule[] }
interface Thread {
  id: string
  snippet?: { topLevelComment?: { snippet?: { textOriginal?: string; textDisplay?: string; authorDisplayName?: string; authorChannelId?: { value?: string }; publishedAt?: string } } }
  replies?: { comments?: Array<{ snippet?: { authorChannelId?: { value?: string } } }> }
}
interface Summary {
  at: string; dry_run?: boolean; videos: number; scanned_videos: number; comments: number
  found: number; sent: number; failed: number; skipped: number; errors: string[]
  matches?: Array<{ video: string; comment_id: string; author: string; text: string; keyword: string; action: string }>
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && !!x.trim())

// ── Stichwort-Prüfung wie in social-keywords: ganzes Wort, Groß/Klein egal ─────
const WORD = '\\p{L}\\p{N}_'
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function matchKeyword(text: string, keywords: string[]): string | null {
  const hay = String(text ?? '').normalize('NFC').toLowerCase()
  for (const raw of keywords) {
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

// ── Einstellungen und Geheimnisse ─────────────────────────────────────────────
async function setting(sb: SupabaseClient, key: string): Promise<Record<string, unknown>> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', key).maybeSingle()
  try { return JSON.parse((data as { value?: string } | null)?.value ?? '{}') as Record<string, unknown> } catch { return {} }
}
async function saveSetting(sb: SupabaseClient, key: string, value: unknown): Promise<void> {
  const { error } = await sb.from('crm_settings').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) console.error(`[yt-keywords] ${key} speichern:`, error.message)
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
async function authorized(sb: SupabaseClient, req: Request): Promise<boolean> {
  const cron = (req.headers.get('x-cron-secret') ?? '').trim()
  if (cron && sameSecret(cron, await secret(sb, 'CRON_SECRET_SOCIAL'))) return true
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const srk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  return !!bearer && !!srk && sameSecret(bearer, srk)
}

// ── YouTube-Zugang (wie yt-center) ────────────────────────────────────────────
async function ytToken(sb: SupabaseClient): Promise<string> {
  const [cid, csec, rtok] = await Promise.all([secret(sb, 'YOUTUBE_CLIENT_ID'), secret(sb, 'YOUTUBE_CLIENT_SECRET'), secret(sb, 'YOUTUBE_REFRESH_TOKEN')])
  if (!cid || !csec || !rtok) throw new Error('YouTube ist nicht verbunden (Einstellungen → Connectoren → YouTube verbinden).')
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }) })
  const d = await r.json() as { access_token?: string; error_description?: string; error?: string }
  if (!d.access_token) throw new Error(`YouTube-OAuth: ${d.error_description ?? d.error ?? r.status}`)
  return d.access_token
}
async function yt<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${YT}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000) })
  const d = await r.json().catch(() => ({})) as T & { error?: { message?: string; errors?: Array<{ reason?: string }> } }
  if (!r.ok) throw new Error(`YouTube ${r.status}: ${d.error?.message ?? 'Fehler'}${d.error?.errors?.[0]?.reason ? ` (${d.error.errors[0].reason})` : ''}`)
  return d
}

function replyText(rule: KwRule, author: string): string {
  const list = strList(rule.youtube_replies)
  const tpl = list[Math.floor(Math.random() * list.length)]
  const who = author.replace(/^@/, '').trim().slice(0, 40)
  return (who ? tpl.replace(/\{\{\s*name\s*\}\}/g, who) : tpl.replace(/[ \t]*\{\{\s*name\s*\}\}/g, '')).trim()
}

// ── Lauf ──────────────────────────────────────────────────────────────────────
async function scan(sb: SupabaseClient, dryRun: boolean): Promise<Summary> {
  const sum: Summary = { at: new Date().toISOString(), videos: 0, scanned_videos: 0, comments: 0, found: 0, sent: 0, failed: 0, skipped: 0, errors: [] }
  if (dryRun) { sum.dry_run = true; sum.matches = [] }

  const cfg = await setting(sb, 'social_keywords') as KwCfg
  const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).filter(r => r?.youtube === true && strList(r.keywords).length && strList(r.youtube_replies).length)
  if (cfg.enabled === false || !rules.length) { sum.errors.push('Keine YouTube-Regel aktiv.'); return sum }
  const keywords = rules.flatMap(r => strList(r.keywords))
  const ruleFor = (kw: string) => rules.find(r => strList(r.keywords).some(k => k.trim().toLowerCase() === kw.trim().toLowerCase()))!

  const token = await ytToken(sb)
  const ch = await yt<{ items?: Array<{ id?: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(token, 'channels?part=id,contentDetails&mine=true')
  const channelId = ch.items?.[0]?.id ?? ''
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!channelId || !uploads) throw new Error('YouTube-Kanal nicht gefunden.')

  const pl = await yt<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>(token, `playlistItems?part=contentDetails&playlistId=${uploads}&maxResults=${UPLOADS_TO_CHECK}`)
  const ids = (pl.items ?? []).map(i => i.contentDetails?.videoId).filter((x): x is string => !!x)
  sum.videos = ids.length
  if (!ids.length) return sum
  const st = await yt<{ items?: Array<{ id: string; statistics?: { commentCount?: string } }> }>(token, `videos?part=statistics&id=${ids.join(',')}`)
  const counts: Record<string, number> = Object.fromEntries((st.items ?? []).map(v => [v.id, Number(v.statistics?.commentCount ?? 0)]))

  const state = await setting(sb, 'yt_keywords_state') as { counts?: Record<string, number> }
  const known = state.counts ?? {}
  const nextCounts: Record<string, number> = { ...known }
  // Wie bei Facebook/Instagram: nichts aus der Zeit vor dem (Wieder-)Einschalten beantworten
  const since = Date.parse(String(cfg.active_since ?? ''))
  const minAt = Math.max(Date.now() - MAX_AGE_MS, Number.isFinite(since) ? since : 0)

  for (const vid of ids) {
    const n = counts[vid] ?? 0
    if (known[vid] === n) continue
    if (n === 0) { nextCounts[vid] = 0; continue }
    sum.scanned_videos++
    let threads: Thread[]
    try {
      const r = await yt<{ items?: Thread[] }>(token, `commentThreads?part=snippet,replies&videoId=${vid}&maxResults=50&order=time&textFormat=plainText`)
      threads = r.items ?? []
    } catch (e) {
      sum.errors.push(`Kommentare ${vid}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200))
      continue                                                   // Zahl nicht merken, nächster Lauf versucht es erneut
    }
    let videoOk = true
    for (const t of threads) {
      const c = t.snippet?.topLevelComment?.snippet
      if (!c) continue
      sum.comments++
      const at = Date.parse(c.publishedAt ?? '')
      if (!Number.isFinite(at) || at < minAt) continue
      if ((c.authorChannelId?.value ?? '') === channelId) continue
      const text = c.textOriginal ?? c.textDisplay ?? ''
      const kw = matchKeyword(text, keywords)
      if (!kw) continue
      sum.found++
      const author = c.authorDisplayName ?? ''
      const answered = (t.replies?.comments ?? []).some(r => r.snippet?.authorChannelId?.value === channelId)

      if (dryRun) {
        const { data: ex } = await sb.from('social_keyword_replies').select('id').eq('comment_id', t.id).maybeSingle()
        sum.matches!.push({ video: vid, comment_id: t.id, author, text: text.slice(0, 120), keyword: kw, action: ex ? 'schon im Protokoll' : answered ? 'schon beantwortet' : 'würde antworten' })
        continue
      }

      const { data: ins, error: insErr } = await sb.from('social_keyword_replies').upsert({
        comment_id: t.id, platform: 'youtube', post_id: vid, author_id: c.authorChannelId?.value ?? null, author_name: author,
        comment_text: text.slice(0, 2000), keyword: kw, comment_at: new Date(at).toISOString(),
        status: answered ? 'skipped' : 'pending', error: answered ? 'Kanal hatte schon geantwortet' : null,
      }, { onConflict: 'comment_id', ignoreDuplicates: true }).select('id')
      if (insErr) { sum.errors.push(`Protokoll: ${insErr.message}`); videoOk = false; continue }
      const row = ins?.[0] as { id: string } | undefined
      if (!row) continue                                          // schon bearbeitet
      if (answered) { sum.skipped++; continue }

      const message = replyText(ruleFor(kw), author)
      try {
        await yt(token, 'comments?part=snippet', { method: 'POST', body: JSON.stringify({ snippet: { parentId: t.id, textOriginal: message } }) })
        const now = new Date().toISOString()
        await sb.from('social_keyword_replies').update({ status: 'sent', public_reply_at: now, attempts: 1, last_attempt_at: now }).eq('id', row.id)
        sum.sent++
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300)
        await sb.from('social_keyword_replies').update({ status: 'failed', error: msg, attempts: 1, last_attempt_at: new Date().toISOString() }).eq('id', row.id)
        sum.failed++
        sum.errors.push(`Antwort ${t.id}: ${msg}`)
      }
    }
    if (videoOk) nextCounts[vid] = n
  }

  if (!dryRun) {
    // Nur die aktuell geprüften Uploads merken, ältere fallen heraus.
    const keep: Record<string, number> = {}
    for (const vid of ids) if (vid in nextCounts) keep[vid] = nextCounts[vid]
    await saveSetting(sb, 'yt_keywords_state', { counts: keep, at: sum.at })
    await saveSetting(sb, 'yt_keywords_last_run', sum)
  }
  return sum
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    if (!(await authorized(sb, req))) return json({ error: 'Keine Berechtigung.' }, 401)
    const body = await req.json().catch(() => ({})) as { action?: string; dry_run?: boolean }
    if (body.action === 'scan') return json({ ok: true, ...(await scan(sb, body.dry_run === true)) })
    return json({ error: 'Unbekannte Aktion.' }, 400)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[yt-keywords]', msg)
    await saveSetting(sb, 'yt_keywords_last_run', { at: new Date().toISOString(), error: msg.slice(0, 300) })
    return json({ ok: false, error: msg }, 500)
  }
})
