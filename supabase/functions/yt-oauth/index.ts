// yt-oauth — Ein-Klick-Verbindung des YouTube-Kanals (Google OAuth).
// Aufruf ohne Parameter → Weiterleitung zu Googles Zustimmungsseite
// (access_type=offline + prompt=consent ⇒ garantiert ein refresh_token).
// Google leitet zurück auf ?code=… → wir tauschen serverseitig und speichern
// den refresh_token DIREKT in connector_secrets — kein Kopieren, kein Playground.
//
// Voraussetzung: YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET in connector_secrets
// und diese Function-URL als autorisierte Weiterleitungs-URI am OAuth-Client.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy yt-oauth --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'

const SELF = 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/yt-oauth'

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? ''
  const url = new URL(req.url)
  const text = (t: string, status = 200) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  try {
    const cid = (await cs('YOUTUBE_CLIENT_ID')).trim()
    const csec = (await cs('YOUTUBE_CLIENT_SECRET')).trim()
    if (!cid || !csec) return text('Client-ID/Secret fehlen in den Connectoren.', 400)

    const code = url.searchParams.get('code')
    if (!code) {
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', cid)
      auth.searchParams.set('redirect_uri', SELF)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.force-ssl')
      auth.searchParams.set('access_type', 'offline')
      auth.searchParams.set('prompt', 'consent')
      return Response.redirect(auth.toString(), 302)
    }

    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cid, client_secret: csec, redirect_uri: SELF, grant_type: 'authorization_code' }),
    })
    const td = await tr.json() as { refresh_token?: string; access_token?: string; error?: string; error_description?: string }
    if (!td.refresh_token) return text(`Kein refresh_token erhalten: ${td.error ?? ''} ${td.error_description ?? ''}`, 400)
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
    return text(`Fehler: ${(e as Error).message}`, 500)
  }
})
