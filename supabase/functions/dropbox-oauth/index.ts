// dropbox-oauth — Ein-Klick-Verbindung einer Dropbox-App (Kuutio-Ordner per Link).
// Kuutio teilt seinen Ordner nur als Link. Svens kostenloses Dropbox-Konto hat
// 2 GB, der Ordner ist größer - deshalb wird er NICHT in Svens Dropbox
// eingebunden, sondern über die API direkt am Link gelesen
// (files/list_folder + sharing/get_shared_link_file mit shared_link).
// Dafür reicht eine eigene Dropbox-App mit Lesezugriff, auch im Gratis-Konto.
//
// PKCE statt App-Secret: Sven trägt nur den App-Key im CRM ein (Einstellungen →
// Connectoren → Dropbox), klickt „Verbinden" und stimmt bei Dropbox zu. Der
// Refresh-Token landet direkt in connector_secrets (DROPBOX_REFRESH_TOKEN), kein
// Secret geht durch Chat oder Browser. Refresh ohne Secret: nur client_id.
// Ablauf:
//   1. POST { action:'start' } aus dem CRM mit User-JWT (admin/verwalter). Wir
//      erzeugen code_verifier + state, merken sie 10 Minuten in connector_secrets
//      (DROPBOX_OAUTH_PENDING) und geben die Zustimmungs-URL zurück.
//   2. Dropbox leitet zurück auf ?code=…&state=… → state prüfen, Code mit dem
//      Verifier tauschen, Refresh-Token speichern, zurück zur Connectoren-Seite.
//
// Voraussetzung in der Dropbox-App: Berechtigungen files.metadata.read,
// files.content.read, sharing.read und diese Function-URL als Redirect-URI.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy dropbox-oauth --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, safeEqual } from '../_shared/callerAuth.ts'

const SELF = 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/dropbox-oauth'
const CONNECTORS_PAGE = 'https://portal.happy-property.com/admin/crm/settings/connectors'
const TTL_MS = 10 * 60 * 1000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? ''
  const put = (key: string, value: string) => sb.from('connector_secrets').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  const back = (status: string) => Response.redirect(`${CONNECTORS_PAGE}?dropbox=${encodeURIComponent(status)}`, 302)
  const url = new URL(req.url)
  try {
    // ── 1. Start aus dem CRM ───────────────────────────────────────────────
    if (req.method === 'POST') {
      const caller = await authorizeCaller(req, { roles: ['admin', 'verwalter'] }, CORS)
      if (caller instanceof Response) return caller
      const appKey = (await cs('DROPBOX_APP_KEY')).trim()
      if (!appKey) return json({ error: 'Erst den Dropbox App-Key eintragen („Ändern").' }, 400)
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)))
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
      const state = crypto.randomUUID().replace(/-/g, '')
      await put('DROPBOX_OAUTH_PENDING', JSON.stringify({ state, verifier, exp: Date.now() + TTL_MS }))
      const auth = new URL('https://www.dropbox.com/oauth2/authorize')
      auth.searchParams.set('client_id', appKey)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('redirect_uri', SELF)
      auth.searchParams.set('token_access_type', 'offline')
      auth.searchParams.set('code_challenge', challenge)
      auth.searchParams.set('code_challenge_method', 'S256')
      auth.searchParams.set('state', state)
      return json({ ok: true, url: auth.toString() })
    }

    // ── 2. Rücksprung von Dropbox ──────────────────────────────────────────
    const code = url.searchParams.get('code')
    if (!code) return back(url.searchParams.get('error') ? 'abgebrochen' : 'ohne-code')
    let pending: { state?: string; verifier?: string; exp?: number } = {}
    try { pending = JSON.parse(await cs('DROPBOX_OAUTH_PENDING') || '{}') } catch { pending = {} }
    if (!pending.state || !pending.verifier || !safeEqual(pending.state, url.searchParams.get('state') ?? '') || (pending.exp ?? 0) < Date.now()) {
      return back('link-abgelaufen')
    }
    const appKey = (await cs('DROPBOX_APP_KEY')).trim()
    const tr = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: appKey, code_verifier: pending.verifier, redirect_uri: SELF }),
    })
    const td = await tr.json() as { refresh_token?: string; access_token?: string; error?: string; error_description?: string }
    await put('DROPBOX_OAUTH_PENDING', '')
    if (!td.refresh_token) {
      console.error('[dropbox-oauth] Tausch fehlgeschlagen:', td.error, td.error_description)
      return back(`fehler-${td.error ?? 'token'}`)
    }
    await put('DROPBOX_REFRESH_TOKEN', td.refresh_token)
    let account = ''
    if (td.access_token) {
      const me = await fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${td.access_token}` } })
        .then(r => r.json()).catch(() => ({})) as { email?: string }
      account = me.email ?? ''
      if (account) await put('DROPBOX_ACCOUNT', account)
    }
    console.log('[dropbox-oauth] verbunden:', account)
    return back('ok')
  } catch (e) {
    if (req.method === 'POST') return json({ error: (e as Error).message }, 500)
    console.error('[dropbox-oauth]', (e as Error).message)
    return back('fehler')
  }
})
