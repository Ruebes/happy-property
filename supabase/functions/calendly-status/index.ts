// Diagnose: listet die Calendly-Webhook-Abos (read-only). Zeigt, ob ein aktives
// Abo auf unseren calendly-webhook-Endpunkt zeigt. Nutzt CALENDLY_WEBHOOK_TOKEN.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const token = Deno.env.get('CALENDLY_WEBHOOK_TOKEN') ?? ''
    if (!token) return json({ error: 'CALENDLY_WEBHOOK_TOKEN fehlt' }, 400)
    const api = (path: string) => fetch(`https://api.calendly.com${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
    const meR = await api('/users/me')
    if (!meR.ok) return json({ step: 'users/me', status: meR.status, body: await meR.text() }, 200)
    const me = await meR.json() as { resource?: { uri?: string; current_organization?: string } }
    const org = me.resource?.current_organization
    const subsR = await api(`/webhook_subscriptions?organization=${encodeURIComponent(org ?? '')}&scope=organization&count=100`)
    const subs = await subsR.json() as { collection?: Array<Record<string, unknown>> }
    const list = (subs.collection ?? []).map(s => ({ callback_url: s.callback_url, state: s.state, events: s.events, scope: s.scope, created_at: s.created_at }))
    return json({ ok: true, organization: org, subscription_count: list.length, subscriptions: list })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
