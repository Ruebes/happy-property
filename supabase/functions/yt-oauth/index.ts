// yt-oauth — Ein-Klick-Verbindung des YouTube-Kanals (Google OAuth).
// Mit ?target=drive verbindet dieselbe Function stattdessen Svens Google-Drive
// (Scope drive) für die Portal-Uploads von owner-drive: Refresh-Token landet als
// GOOGLE_DRIVE_REFRESH_TOKEN + GOOGLE_DRIVE_ACCOUNT in connector_secrets.
// Gleicher OAuth-Client, gleiche Weiterleitungs-URI — nichts in der Google-
// Konsole nötig. Sven muss mit dem Google-Konto zustimmen, das Schreibrecht auf
// „Happy Property Kunden" hat (r.u.e.b.e@gmx.de oder happypropertycyprus@gmail.com).
// Mit ?target=gads (seit 16.10.26) verbindet sie Google Ads (Scope adwords):
// Refresh-Token als GOOGLE_ADS_REFRESH_TOKEN, dazu GOOGLE_ADS_ACCOUNT und, wenn
// eindeutig, GOOGLE_ADS_CUSTOMER_ID / GOOGLE_ADS_LOGIN_CUSTOMER_ID. Im Cloud-Projekt
// des OAuth-Clients muss die Google Ads API aktiviert sein (Zugriffsstufe Explorer).
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
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, safeEqual } from '../_shared/callerAuth.ts'
import { GADS_SCOPE, gadsListAccessible, gadsSearch, gadsCustomerInfo } from '../_shared/googleAds.ts'

const SELF = 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/yt-oauth'
const CONNECTORS_PAGE = 'https://portal.happy-property.com/admin/crm/settings/connectors'
const STATE_TTL_MS = 10 * 60 * 1000
// youtube.force-ssl = Upload/Metadaten/Thumbnails; yt-analytics.readonly (seit
// 14.10.26) = Klickrate, Impressionen, Wiedergabedauer aus der YouTube Analytics API.
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'
const YT_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

type Target = 'youtube' | 'drive' | 'gads'

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
  if (target !== 'youtube' && target !== 'drive' && target !== 'gads') return null
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null
  return safeEqual(sig, await stateSig(`${target}.${exp}.${nonce}`)) ? target : null
}

// Google Ads: Token speichern, dann Werbekonto ermitteln. Der Token wird auch
// gespeichert, wenn Google den API-Zugriff (noch) verweigert - dann steht in der
// Antwort, was im Cloud-Projekt fehlt; nach der Freischaltung genügt „Testen".
async function saveGads(
  sb: SupabaseClient,
  td: { refresh_token?: string; access_token?: string; scope?: string },
): Promise<string> {
  const granted = (td.scope ?? '').split(' ')
  console.log('[yt-oauth] gads Scopes erteilt:', td.scope ?? '(keine Angabe)')
  if (td.scope && !granted.includes(GADS_SCOPE)) return 'Nicht gespeichert: Google hat den Zugriff auf Google Ads nicht erteilt. Bitte im CRM erneut auf „Verbinden" klicken und auf der Google-Seite das Kästchen bei „Google Ads-Kampagnen ansehen und verwalten" anhaken, bevor du auf „Weiter" klickst.'
  const put = (key: string, value: string) => sb.from('connector_secrets').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  await put('GOOGLE_ADS_REFRESH_TOKEN', td.refresh_token!)
  const at = td.access_token ?? ''
  let account = ''
  if (at) {
    const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(at)}`).then(r => r.json()).catch(() => ({})) as { email?: string }
    account = info.email ?? ''
  }
  await put('GOOGLE_ADS_ACCOUNT', account)
  const head = `✅ Google Ads verbunden${account ? ` (Konto: ${account})` : ''} - Token wurde gespeichert.`
  if (!at) return `${head} Diesen Tab kannst du schließen.`
  try {
    const ids = await gadsListAccessible(at)
    if (!ids.length) return `${head} Achtung: Dieses Google-Konto hat Zugriff auf KEIN Google-Ads-Konto. Bitte mit dem Konto verbinden, das in Google Ads Administrator ist.`
    const infos = await Promise.all(ids.slice(0, 10).map(id =>
      gadsCustomerInfo({ accessToken: at, loginCustomerId: id, developerToken: '', customerId: id }).catch(() => null)))
    const found = infos.filter((x): x is NonNullable<typeof x> => !!x)
    const fmt = (id: string) => id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')
    const list = found.map(c => `${c.name || 'ohne Name'} ${fmt(c.id)}${c.manager ? ' (Verwaltungskonto)' : ''}`).join(', ')
    let pick: { cust: string; login: string } | null = null
    const direct = found.filter(c => !c.manager && !c.testAccount)
    if (direct.length === 1) pick = { cust: direct[0].id, login: '' }
    else if (!direct.length) {
      // Nur Verwaltungskonto(en): einziges Unterkonto darunter nehmen
      const mgr = found.filter(c => c.manager)
      if (mgr.length === 1) {
        const subs = await gadsSearch<{ customerClient?: { id?: string; manager?: boolean; testAccount?: boolean } }>(
          { accessToken: at, loginCustomerId: mgr[0].id, developerToken: '', customerId: mgr[0].id },
          'SELECT customer_client.id, customer_client.manager, customer_client.test_account FROM customer_client WHERE customer_client.level = 1',
        ).catch(() => [])
        const clients = subs.map(s => s.customerClient).filter(c => c && !c.manager && !c.testAccount && c.id)
        if (clients.length === 1) pick = { cust: String(clients[0]!.id), login: mgr[0].id }
      }
    }
    if (pick) {
      await put('GOOGLE_ADS_CUSTOMER_ID', pick.cust)
      await put('GOOGLE_ADS_LOGIN_CUSTOMER_ID', pick.login)
      return `${head} Werbekonto ${fmt(pick.cust)} ist eingestellt${pick.login ? ` (über Verwaltungskonto ${fmt(pick.login)})` : ''}. Diesen Tab kannst du schließen.`
    }
    return `${head} Gefundene Konten: ${list || ids.map(fmt).join(', ')}. Bitte im CRM unter Connectoren bei „Google Ads, Kunden-ID" das richtige Werbekonto eintragen. Diesen Tab kannst du schließen.`
  } catch (e) {
    return `${head} Google erlaubt den API-Zugriff aber noch nicht: ${(e as Error).message}. Prüfen: Im Google-Cloud-Projekt des OAuth-Clients die „Google Ads API" aktivieren und Zugriffsstufe „Explorer" beantragen. Danach im CRM auf „Testen" klicken, neu verbinden ist nicht nötig.`
  }
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
      const target: Target = body.target === 'drive' ? 'drive' : body.target === 'gads' ? 'gads' : 'youtube'
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', startCid)
      auth.searchParams.set('redirect_uri', SELF)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', target === 'drive' ? 'https://www.googleapis.com/auth/drive'
        // Nur EIN Scope: Bei mehreren zeigt Google Einzel-Kästchen, die nicht
        // vorausgewählt sind; Sven klickte am 16.10. durch, ohne anzuhaken.
        : target === 'gads' ? GADS_SCOPE
        : `${YT_SCOPE} ${YT_ANALYTICS_SCOPE}`)
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
    const td = await tr.json() as { refresh_token?: string; access_token?: string; scope?: string; error?: string; error_description?: string }
    if (!td.refresh_token) return text(`Kein refresh_token erhalten: ${td.error ?? ''} ${td.error_description ?? ''}`, 400)
    if (target === 'gads') return text(await saveGads(sb, td))
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
    // Google laesst einzelne Haken abwaehlen. Ohne force-ssl wuerden Upload und
    // Thumbnails brechen: dann den alten, funktionierenden Token behalten.
    const granted = (td.scope ?? '').split(' ')
    if (td.scope && !granted.includes(YT_SCOPE)) return text('Nicht gespeichert: Der Haken für „YouTube-Konto verwalten" fehlte. Bitte erneut verbinden und alle Haken gesetzt lassen.', 400)
    const analyticsWarn = td.scope && !granted.includes(YT_ANALYTICS_SCOPE) ? ' Hinweis: Statistik-Zugriff (Klickrate) wurde nicht erteilt.' : ''
    await sb.from('connector_secrets').upsert({ key: 'YOUTUBE_REFRESH_TOKEN', value: td.refresh_token }, { onConflict: 'key' })
    // Kurzer Funktionstest: Kanalname holen
    let channel = ''
    if (td.access_token) {
      const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${td.access_token}` } }).then(r => r.json()) as { items?: Array<{ snippet?: { title?: string } }> }
      channel = ch.items?.[0]?.snippet?.title ?? ''
    }
    console.log('[yt-oauth] Verbunden, Kanal:', channel)
    return text(`✅ YouTube verbunden${channel ? ` (Kanal: ${channel})` : ''} — Token wurde automatisch gespeichert.${analyticsWarn} Diesen Tab kannst du schließen.`)
  } catch (e) {
    if (req.method === 'POST') return json({ error: (e as Error).message }, 500)
    return text(`Fehler: ${(e as Error).message}`, 500)
  }
})
