// Diagnose + Reparatur der Calendly-Webhook-Abos. Nutzt CALENDLY_WEBHOOK_TOKEN.
//  { }                 → listet die Abos (read-only)
//  { action:'repair' } → loescht (deaktivierte) Abos auf unseren Endpunkt und legt
//                        EIN frisches, AKTIVES Abo an (Calendly hat kein 'enable').
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const CALLBACK = 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/calendly-webhook'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const action = (await req.json().catch(() => ({})) as { action?: string }).action
    const token = Deno.env.get('CALENDLY_WEBHOOK_TOKEN') ?? ''
    if (!token) return json({ error: 'CALENDLY_WEBHOOK_TOKEN fehlt' }, 400)
    const api = (path: string) => fetch(`https://api.calendly.com${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })

    const meR = await api('/users/me')
    if (!meR.ok) return json({ step: 'users/me', status: meR.status, body: await meR.text() }, 200)
    const me = await meR.json() as { resource?: { uri?: string; current_organization?: string } }
    const org = me.resource?.current_organization

    const subsR = await api(`/webhook_subscriptions?organization=${encodeURIComponent(org ?? '')}&scope=organization&count=100`)
    const subs = await subsR.json() as { collection?: Array<Record<string, unknown>> }
    const list = (subs.collection ?? []).map(s => ({ uri: s.uri as string, callback_url: s.callback_url, state: s.state, events: s.events, scope: s.scope, created_at: s.created_at }))

    if (action === 'repair') {
      const deleted: string[] = []
      for (const s of list) {
        if (s.callback_url === CALLBACK && typeof s.uri === 'string') {
          await fetch(s.uri, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
          deleted.push(s.uri)
        }
      }
      const createR = await fetch('https://api.calendly.com/webhook_subscriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: CALLBACK, events: ['invitee.created', 'invitee.canceled'], organization: org, scope: 'organization' }),
      })
      const created = await createR.json() as { resource?: { state?: string; callback_url?: string } }
      return json({ ok: createR.ok, deleted_count: deleted.length, create_status: createR.status, new_state: created.resource?.state, created })
    }

    return json({ ok: true, organization: org, subscription_count: list.length, subscriptions: list })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
