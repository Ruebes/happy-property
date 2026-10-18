// yt-snapshot: schreibt einmal täglich die Kanalzahlen des YouTube-Kanals in yt_channel_daily
// (Abonnenten, Aufrufe, Videos). YouTube Analytics ist für unseren Zugang gesperrt, deshalb
// der tägliche Stand statt Tageszugewinnen; die Differenz ergibt den Zugewinn.
// Aufruf: Cron yt-snapshot-daily (x-cron-secret = connector_secrets CRON_SECRET) oder Service-Role.
// Deploy: supabase functions deploy yt-snapshot --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const sec = async (k: string) => String(((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? '')
  const cron = req.headers.get('x-cron-secret') ?? ''
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const ok = (cron && cron === await sec('CRON_SECRET')) || (bearer && bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
  if (!ok) return json({ error: 'Keine Berechtigung.' }, 401)
  try {
    const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      client_id: await sec('YOUTUBE_CLIENT_ID'), client_secret: await sec('YOUTUBE_CLIENT_SECRET'),
      refresh_token: await sec('YOUTUBE_REFRESH_TOKEN'), grant_type: 'refresh_token' }) }).then(r => r.json()) as { access_token?: string; error?: string }
    if (!t.access_token) return json({ error: `YouTube-Zugang: ${t.error ?? 'kein Token'}` }, 502)
    const c = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: { Authorization: `Bearer ${t.access_token}` } }).then(r => r.json()) as { items?: Array<{ statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string } }> }
    const s = c.items?.[0]?.statistics
    if (!s) return json({ error: 'Keine Kanaldaten' }, 502)
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Nicosia' })
    const row = { day, subscribers: Number(s.subscriberCount ?? 0), views: Number(s.viewCount ?? 0), videos: Number(s.videoCount ?? 0) }
    const { error } = await sb.from('yt_channel_daily').upsert(row, { onConflict: 'day' })
    if (error) return json({ error: error.message }, 500)
    return json({ ok: true, ...row })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
