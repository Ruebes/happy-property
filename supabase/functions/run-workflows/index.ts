// run-workflows — Ausfuehrungs-Engine fuer die visuellen Funnel-Workflows (Flows).
//
// Ein Workflow ist ein Graph (nodes + edges) in funnel_workflows.graph. Jeder Lead,
// der im Flow laeuft, hat eine Zeile in funnel_workflow_runs mit current_node_id +
// next_due_at. Dieser Cron holt faellige Laeufe (claim_workflow_runs, 15-Min-Lease),
// fuehrt die Kette ab dem aktuellen Knoten aus, bis ein Delay (Timer setzen, warten)
// oder das Ende (completed) erreicht ist. Splits (Wenn/Dann) werden gegen echte
// engagement_events (E-Mail geoeffnet / Deck gesehen) ausgewertet.
//
// Knotentypen (node.type + node.data):
//   trigger       {}                                   -> Einstieg
//   delay         { amount, unit: minutes|hours|days } -> warten
//   email         { subject, html }                    -> E-Mail an den Lead
//   whatsapp      { text }                              -> WhatsApp an den Lead
//   list_update   { op: add|remove, list_id }          -> Empfaengerliste
//   split         { condition: email_opened|deck_viewed|calc_viewed } -> Kanten yes/no
//
// Nur Laeufe von Workflows mit status='active' werden verarbeitet (Draft = nichts).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Cron:    */5 * * * *  ->  net.http_post(.../functions/v1/run-workflows)
// Deploy:  supabase functions deploy run-workflows --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

interface GNode { id: string; type: string; data?: Record<string, unknown> }
interface GEdge { id: string; source: string; target: string; sourceHandle?: string | null }
interface Graph { nodes: GNode[]; edges: GEdge[] }
interface Run {
  id: string; workflow_id: string; lead_id: string | null; subscriber_id: string | null
  status: string; current_node_id: string | null; next_due_at: string; context: Record<string, unknown>; entered_at: string
}

const DELAY_MS = (d: Record<string, unknown>): number => {
  const amt = Math.max(0, Number(d.amount) || 0)
  const unit = String(d.unit ?? 'minutes')
  const mult = unit === 'days' ? 86400000 : unit === 'hours' ? 3600000 : 60000
  return amt * mult
}
const sub = (tpl: string, vars: Record<string, string>): string =>
  (tpl ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')

// Nachfolge-Knoten fuer eine Kante (bei Split ueber handle 'yes'/'no').
function nextId(graph: Graph, nodeId: string, handle?: string): string | null {
  const edges = graph.edges.filter(e => e.source === nodeId)
  const e = handle ? edges.find(x => (x.sourceHandle ?? '') === handle) : edges[0]
  return e?.target ?? null
}
const nodeById = (graph: Graph, id: string | null): GNode | undefined => id ? graph.nodes.find(n => n.id === id) : undefined

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const { data: claimed } = await sb.rpc('claim_workflow_runs', { p_limit: 50 })
    const runs = (claimed ?? []) as Run[]
    const out = { claimed: runs.length, completed: 0, waiting: 0, sent_email: 0, sent_wa: 0, stopped: 0, errors: [] as string[] }

    // Workflows cachen (mehrere Laeufe teilen einen Workflow)
    const wfCache = new Map<string, { status: string; graph: Graph } | null>()
    const loadWf = async (id: string) => {
      if (wfCache.has(id)) return wfCache.get(id)!
      const { data } = await sb.from('funnel_workflows').select('status, graph').eq('id', id).maybeSingle()
      const wf = data ? { status: (data as { status: string }).status, graph: ((data as { graph: Graph }).graph ?? { nodes: [], edges: [] }) } : null
      wfCache.set(id, wf); return wf
    }

    for (const run of runs) {
      try {
        const wf = await loadWf(run.workflow_id)
        if (!wf || wf.status !== 'active') {
          await sb.from('funnel_workflow_runs').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', run.id)
          out.stopped++; continue
        }
        const graph = wf.graph
        // Startpunkt: aktueller Knoten, sonst der erste Knoten nach dem Trigger.
        let curId = run.current_node_id
        if (!curId) {
          const trigger = graph.nodes.find(n => n.type === 'trigger') ?? graph.nodes[0]
          curId = trigger ? nextId(graph, trigger.id) : null
        }
        const ctx = run.context ?? {}
        let waited = false, done = false

        for (let i = 0; i < 30 && curId; i++) {
          const node = nodeById(graph, curId)
          if (!node) { done = true; break }
          const d = node.data ?? {}

          if (node.type === 'delay') {
            const due = new Date(Date.now() + DELAY_MS(d)).toISOString()
            const tgt = nextId(graph, node.id)
            if (!tgt) { done = true; break }
            await sb.from('funnel_workflow_runs').update({ current_node_id: tgt, next_due_at: due, context: ctx, updated_at: new Date().toISOString() }).eq('id', run.id)
            waited = true; break
          }

          if (node.type === 'email' || node.type === 'whatsapp') {
            const okSend = await sendNode(sb, run, node, ctx)
            if (node.type === 'email' && okSend) out.sent_email++
            if (node.type === 'whatsapp' && okSend) out.sent_wa++
            curId = nextId(graph, node.id)
            continue
          }

          if (node.type === 'list_update') {
            await listUpdate(sb, run, d)
            curId = nextId(graph, node.id)
            continue
          }

          if (node.type === 'split') {
            const yes = await evalCondition(sb, run, String(d.condition ?? 'email_opened'))
            curId = nextId(graph, node.id, yes ? 'yes' : 'no')
            continue
          }

          // trigger oder unbekannt -> einfach weiter
          curId = nextId(graph, node.id)
        }

        if (!waited) {
          await sb.from('funnel_workflow_runs').update({ status: 'completed', current_node_id: curId, next_due_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', run.id)
          out.completed++
        } else out.waiting++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        out.errors.push(`${run.id}: ${msg}`)
        await sb.from('funnel_workflow_runs').update({ status: 'failed', last_error: msg.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', run.id).catch(() => {})
      }
    }
    return json({ ok: true, ...out })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// ── Empfänger laden (Lead ODER Newsletter-Abonnent) ─────────────────────────
interface Person { leadId: string | null; first: string; last: string; email: string | null; phone: string | null; lang: 'de' | 'en'; optout: boolean }
async function loadLead(sb: SupabaseClient, run: Run) {
  if (!run.lead_id) return null
  const { data } = await sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp, language, newsletter_optout_at').eq('id', run.lead_id).maybeSingle()
  return data as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null; language: string | null; newsletter_optout_at: string | null } | null
}
async function loadPerson(sb: SupabaseClient, run: Run): Promise<Person | null> {
  if (run.lead_id) {
    const l = await loadLead(sb, run)
    if (!l) return null
    return { leadId: l.id, first: l.first_name ?? '', last: l.last_name ?? '', email: l.email, phone: (l.whatsapp || l.phone || '').trim() || null, lang: l.language === 'en' ? 'en' : 'de', optout: !!l.newsletter_optout_at }
  }
  if (run.subscriber_id) {
    const { data } = await sb.from('newsletter_subscribers').select('id, email, first_name, last_name, phone, optout_at, properties').eq('id', run.subscriber_id).maybeSingle()
    const s = data as { email: string; first_name: string | null; last_name: string | null; phone: string | null; optout_at: string | null; properties: { lang?: string } | null } | null
    if (!s) return null
    return { leadId: null, first: s.first_name ?? '', last: s.last_name ?? '', email: s.email, phone: (s.phone ?? '').trim() || null, lang: s.properties?.lang === 'en' ? 'en' : 'de', optout: !!s.optout_at }
  }
  return null
}

// ── Sende-Knoten (E-Mail / WhatsApp) ────────────────────────────────────────
async function sendNode(sb: SupabaseClient, run: Run, node: GNode, _ctx: Record<string, unknown>): Promise<boolean> {
  const p = await loadPerson(sb, run)
  if (!p) return false
  if (p.optout) return false   // Opt-out respektieren
  const vars = { vorname: p.first, nachname: p.last, name: `${p.first} ${p.last}`.trim() }
  const d = node.data ?? {}
  if (node.type === 'email') {
    if (!p.email) return false
    const subject = sub(String(d.subject ?? ''), vars) || 'Happy Property'
    const html = sub(String(d.html ?? ''), vars)
    if (!html.trim()) return false
    const { error } = await sb.functions.invoke('send-email', { body: {
      to: p.email, subject, html, from_name: 'Happy Property', auto: true,
      lang: p.lang, ...(p.leadId ? { lead_id: p.leadId } : {}),
    } })
    return !error
  }
  // whatsapp
  if (!p.phone) return false
  const text = sub(String(d.text ?? ''), vars)
  if (!text.trim()) return false
  const { error } = await sb.functions.invoke('send-whatsapp', { body: {
    event_type: 'workflow', override_text: text,
    lead_data: { lead_name: vars.name || vars.vorname, lead_phone: p.phone }, ...(p.leadId ? { lead_id: p.leadId } : {}),
  } })
  return !error
}

// ── Listen-Update-Knoten ────────────────────────────────────────────────────
async function listUpdate(sb: SupabaseClient, run: Run, d: Record<string, unknown>) {
  const listId = String(d.list_id ?? '')
  const op = String(d.op ?? 'add')
  if (!listId) return
  // Subscriber ermitteln: direkter subscriber_id oder ueber die Lead-E-Mail.
  let subId = run.subscriber_id
  if (!subId && run.lead_id) {
    const lead = await loadLead(sb, run)
    if (lead?.email) {
      const { data: s } = await sb.from('newsletter_subscribers').select('id').ilike('email', lead.email).limit(1).maybeSingle()
      subId = (s as { id?: string } | null)?.id ?? null
      // Nicht vorhanden + add -> anlegen
      if (!subId && op === 'add') {
        const { data: ns } = await sb.from('newsletter_subscribers').insert({ email: lead.email, first_name: lead.first_name, last_name: lead.last_name, source: 'workflow' }).select('id').maybeSingle()
        subId = (ns as { id?: string } | null)?.id ?? null
      }
    }
  }
  if (!subId) return
  if (op === 'remove') await sb.from('newsletter_list_members').delete().eq('list_id', listId).eq('subscriber_id', subId)
  else await sb.from('newsletter_list_members').upsert({ list_id: listId, subscriber_id: subId }, { onConflict: 'list_id,subscriber_id' })
}

// ── Split-Bedingung gegen engagement_events auswerten ───────────────────────
async function evalCondition(sb: SupabaseClient, run: Run, condition: string): Promise<boolean> {
  const typ = condition === 'deck_viewed' ? 'deck_view' : condition === 'calc_viewed' ? 'calc_view' : 'email_open'
  let q = sb.from('engagement_events').select('id').eq('type', typ).gte('occurred_at', run.entered_at).limit(1)
  if (run.lead_id) q = q.eq('lead_id', run.lead_id)
  else if (run.subscriber_id) q = q.eq('subscriber_id', run.subscriber_id)
  else return false
  const { data } = await q
  return Array.isArray(data) && data.length > 0
}
