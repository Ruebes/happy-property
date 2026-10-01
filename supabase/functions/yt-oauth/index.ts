// yt-oauth — Ein-Klick-Verbindung des YouTube-Kanals (Google OAuth).
// Mit ?target=drive verbindet dieselbe Function stattdessen Svens Google-Drive
// (Scope drive) für die Portal-Uploads von owner-drive: Refresh-Token landet als
// GOOGLE_DRIVE_REFRESH_TOKEN + GOOGLE_DRIVE_ACCOUNT in connector_secrets.
// Gleicher OAuth-Client, gleiche Weiterleitungs-URI — nichts in der Google-
// Konsole nötig. Sven muss mit dem Google-Konto zustimmen, das Schreibrecht auf
// „Happy Property Kunden" hat (r.u.e.b.e@gmx.de oder happypropertycyprus@gmail.com).
// Ablauf (seit Sicherheits-Fix 30.9.26):
//   1. POST { action:'start', target:'youtube'|'drive' } aus dem CRM (Einstellungen
//      → Connectoren) mit User-JWT, nur admin/verwalter wie die Route. Antwort:
//      Googles Zustimmungs-URL mit signiertem, 10 Minuten gültigem state
//      (Ziel + Ablauf + HMAC). access_type=offline + prompt=consent ⇒ refresh_token.
//   2. Google leitet zurück auf ?code=…&state=… → state prüfen, dann tauschen wir
//      serverseitig und speichern den refresh_token DIREKT in connector_secrets.
//   Ohne code (alter Direktlink, Abbruch bei Google) → Weiterleitung zur
//   Connectoren-Seite im CRM. Ohne gültigen state wird nichts gespeichert.
//
// Voraussetzung: YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET in connector_secrets
// und diese Function-URL als autorisierte Weiterleitungs-URI am OAuth-Client.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy yt-oauth --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, safeEqual } from '../_shared/callerAuth.ts'

const SELF = 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/yt-oauth'
const CONNECTORS_PAGE = 'https://portal.happy-property.com/admin/crm/settings/connectors'
const STATE_TTL_MS = 10 * 60 * 1000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

type Target = 'youtube' | 'drive'

// state = <ziel>.<ablauf-ms>.<nonce>.<hmac>, HMAC-SHA256 mit dem Service-Key
// (nur serverseitig bekannt). Punkte kommen in keinem Teil vor.
async function stateSig(payload: string): Promise<string> {
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!secret) throw new Error('Service-Key fehlt')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`yt-oauth-state|${payload}`)))
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function makeState(target: Target): Promise<string> {
  const payload = `${target}.${Date.now() + STATE_TTL_MS}.${crypto.randomUUID().replace(/-/g, '')}`
  return `${payload}.${await stateSig(payload)}`
}
async function readState(state: string): Promise<Target | null> {
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [target, exp, nonce, sig] = parts
  if (target !== 'youtube' && target !== 'drive') return null
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null
  return safeEqual(sig, await stateSig(`${target}.${exp}.${nonce}`)) ? target : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? ''
  const url = new URL(req.url)
  const text = (t: string, status = 200) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  try {
    // ── 1. Start aus dem CRM: nur eingeloggte admin/verwalter bekommen die URL ──
    if (req.method === 'POST') {
      const caller = await authorizeCaller(req, { roles: ['admin', 'verwalter'] }, CORS)
      if (caller instanceof Response) return caller
      const body = await req.json().catch(() => ({})) as { target?: string }
      const startCid = (await cs('YOUTUBE_CLIENT_ID')).trim()
      const startCsec = (await cs('YOUTUBE_CLIENT_SECRET')).trim()
      if (!startCid || !startCsec) return json({ error: 'Client-ID/Secret fehlen in den Connectoren.' }, 400)
      const target: Target = body.target === 'drive' ? 'drive' : 'youtube'
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', startCid)
      auth.searchParams.set('redirect_uri', SELF)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', target === 'drive' ? 'https://www.googleapis.com/auth/drive' : 'https://www.googleapis.com/auth/youtube.force-ssl')
      auth.searchParams.set('access_type', 'offline')
      auth.searchParams.set('prompt', 'consent')
      auth.searchParams.set('state', await makeState(target))
      return json({ ok: true, url: auth.toString() })
    }

    // ── 2. Rücksprung von Google ─────────────────────────────────────────────
    const code = url.searchParams.get('code')
    if (!code) return Response.redirect(CONNECTORS_PAGE, 302)
    const target = await readState(url.searchParams.get('state') ?? '')
    if (!target) return text('Link abgelaufen oder ungültig. Bitte im CRM unter Einstellungen → Connectoren erneut auf „Verbinden" klicken.', 401)
    const drive = target === 'drive'

    const cid = (await cs('YOUTUBE_CLIENT_ID')).trim()
    const csec = (await cs('YOUTUBE_CLIENT_SECRET')).trim()
    if (!cid || !csec) return text('Client-ID/Secret fehlen in den Connectoren.', 400)

    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cid, client_secret: csec, redirect_uri: SELF, grant_type: 'authorization_code' }),
    })
    const td = await tr.json() as { refresh_token?: string; access_token?: string; error?: string; error_description?: string }
    if (!td.refresh_token) return text(`Kein refresh_token erhalten: ${td.error ?? ''} ${td.error_description ?? ''}`, 400)
    if (drive) {
      // Welches Konto hat zugestimmt? Direkt prüfen, ob es in den Kundenordner schreiben darf.
      let account = ''
      let warn = ''
      if (td.access_token) {
        const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: `Bearer ${td.access_token}` } }).then(r => r.json()).catch(() => ({})) as { user?: { emailAddress?: string }; error?: { message?: string } }
        account = about.user?.emailAddress ?? ''
        if (about.error) warn = ` — Achtung: Drive-API meldet „${about.error.message ?? 'Fehler'}"`
        const parent = Deno.env.get('GOOGLE_DRIVE_PARENT_FOLDER_ID') || '1IdozSH0SnMVSrQgaJXyQSlSJHoIWbri4'
        const cap = await fetch(`https://www.googleapis.com/drive/v3/files/${parent}?fields=capabilities(canAddChildren)&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${td.access_token}` } }).then(r => r.json()).catch(() => ({})) as { capabilities?: { canAddChildren?: boolean } }
        if (!warn && !cap.capabilities?.canAddChildren) warn = ' — Achtung: dieses Konto darf NICHT in „Happy Property Kunden" schreiben. Bitte mit r.u.e.b.e@gmx.de oder happypropertycyprus@gmail.com verbinden.'
      }
      await sb.from('connector_secrets').upsert({ key: 'GOOGLE_DRIVE_REFRESH_TOKEN', value: td.refresh_token }, { onConflict: 'key' })
      await sb.from('connector_secrets').upsert({ key: 'GOOGLE_DRIVE_ACCOUNT', value: account }, { onConflict: 'key' })
      console.log('[yt-oauth] Drive verbunden:', account, warn)
      return text(`✅ Google Drive verbunden${account ? ` (Konto: ${account})` : ''}${warn} — Token wurde automatisch gespeichert. Diesen Tab kannst du schließen.`)
    }
    await sb.from('connector_secrets').upsert({ key: 'YOUTUBE_REFRESH_TOKEN', value: td.refresh_token }, { onConflict: 'key' })
    // Kurzer Funktionstest: Kanalname holen
    let channel = ''
    if (td.access_token) {
      const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${td.access_token}` } }).then(r => r.json()) as { items?: Array<{ snippet?: { title?: string } }> }
      channel = ch.items?.[0]?.snippet?.title ?? ''
    }
    console.log('[yt-oauth] Verbunden, Kanal:', channel)
    return text(`✅ YouTube verbunden${channel ? ` (Kanal: ${channel})` : ''} — Token wurde automatisch gespeichert. Diesen Tab kannst du schließen.`)
  } catch (e) {
    if (req.method === 'POST') return json({ error: (e as Error).message }, 500)
    return text(`Fehler: ${(e as Error).message}`, 500)
  }
})
