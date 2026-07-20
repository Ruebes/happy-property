// task-notify — verschickt Aufgaben an Zuständige (intern + extern) und die
// täglichen Erinnerungen, jeweils über den gewählten Kanal (Mail/WhatsApp) mit
// dem persönlichen Erledigt-Link (/t/<token>). Interne Zuständige: Mail.
//
// Modi:
//   { mode: 'dispatch', task_id }  → einmalige Zustellung beim Anlegen
//   { mode: 'reminder' }           → Cron: alle offenen Aufgaben, 1×/Tag je Zuständigem
//   { mode: 'subtask_done', task_id } → Teilaufgabe erledigt: Rückmeldung an den,
//                                       der die Zuarbeit gestellt hat (WhatsApp, sonst Mail)
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_SITE_URL?
// Deploy: supabase functions deploy task-notify --no-verify-jwt
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const PUBLIC_BASE = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://portal.happy-property.com'
const esc = (s: string) => s.replace(/</g, '&lt;')

interface Assignee {
  id: string; task_id: string; profile_id: string | null
  ext_name: string | null; ext_email: string | null; ext_phone: string | null
  channel: string; token: string; last_reminded_at: string | null
}
interface Task { id: string; title: string; description: string | null; due_date: string | null; status: string; archived: boolean }

function mailHtml(first: string, intro: string, task: Task, link: string) {
  const due = task.due_date ? new Date(task.due_date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
    <p>Hallo ${esc(first)},</p>
    <p>${intro}</p>
    <div style="background:#faf7f4;border-radius:14px;padding:16px 18px;margin:14px 0;">
      <p style="font-size:16px;font-weight:600;color:#111827;margin:0 0 6px;">${esc(task.title)}</p>
      ${task.description ? `<p style="color:#374151;white-space:pre-wrap;margin:0;">${esc(task.description)}</p>` : ''}
      ${due ? `<p style="color:#6b7280;font-size:13px;margin:8px 0 0;">Frist: ${due}</p>` : ''}
    </div>
    <p style="text-align:center;margin:22px 0;">
      <a href="${link}" style="background:#ff795d;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;display:inline-block;">Öffnen &amp; erledigen</a>
    </p>
    <p style="font-size:13px;color:#6b7280;">Du kannst auch direkt auf diese Mail antworten — deine Nachricht landet als Bemerkung in der Aufgabe.</p>
  </div>`
}

function waText(intro: string, task: Task, link: string) {
  return `${intro}\n\n*${task.title}*${task.description ? `\n${task.description}` : ''}\n\nÖffnen & erledigen:\n${link}\n\n(Du kannst auch einfach hier antworten.)`
}

// Eine Aufgabe an einen Zuständigen zustellen (Kanal-abhängig).
async function deliver(supabase: SupabaseClient, a: Assignee, task: Task, kind: 'dispatch' | 'reminder') {
  const link = `${PUBLIC_BASE}/t/${a.token}`
  const introMail = kind === 'dispatch' ? 'dir wurde eine neue Aufgabe zugewiesen:' : 'kurze Erinnerung — ist diese Aufgabe schon erledigt?'
  const introWa   = kind === 'dispatch' ? '📋 Neue Aufgabe von Happy Property:' : '⏰ Erinnerung — ist diese Aufgabe erledigt?'
  const subject   = `${kind === 'dispatch' ? 'Neue Aufgabe' : 'Erinnerung'}: ${task.title} [#${a.token}]`

  // Empfänger + Kanäle bestimmen
  let email: string | null = null, phone: string | null = null, name = ''
  let wantMail = false, wantWa = false
  if (a.profile_id) {
    const { data: p } = await supabase.from('profiles').select('full_name, email, phone').eq('id', a.profile_id).single()
    name = p?.full_name ?? ''; email = p?.email ?? null
    wantMail = true                        // interne Zuständige: Mail
  } else {
    name = a.ext_name ?? ''; email = a.ext_email; phone = a.ext_phone
    wantMail = (a.channel === 'mail' || a.channel === 'both') && !!email
    wantWa   = (a.channel === 'whatsapp' || a.channel === 'both') && !!phone
  }
  const first = (name || '').split(' ')[0] || name

  if (wantMail && email) {
    await supabase.functions.invoke('send-email', { body: { to: email, subject, html: mailHtml(first, introMail, task, link) } })
      .catch((e: unknown) => console.warn('[task-notify] mail:', e))
  }
  if (wantWa && phone) {
    await supabase.functions.invoke('send-whatsapp', { body: {
      event_type: `task_${kind}`, override_text: waText(introWa, task, link),
      lead_data: { lead_name: name || 'Empfänger', lead_phone: phone },
    } }).catch((e: unknown) => console.warn('[task-notify] whatsapp:', e))
  }
  await supabase.from('crm_task_assignees').update({ last_reminded_at: new Date().toISOString() }).eq('id', a.id)
  return { assignee: a.id, mail: wantMail, whatsapp: wantWa }
}

// ── Fertigmeldung einer Teilaufgabe an den Aufgabengeber ────────────────────
// Aufrufbar von allen drei Erledigt-Wegen (In-App-Button, Drag & Drop, Token-Link)
// und zusätzlich vom 5-Minuten-Sweep. Damit daraus trotzdem GENAU EINE Nachricht
// wird, ist done_notified_at der Riegel: nur wer den Übergang null → jetzt selbst
// gewinnt, verschickt. Zwei gleichzeitige Aufrufe → einer bekommt keine Zeile
// zurück und hört auf.
async function notifySubtaskDone(supabase: SupabaseClient, taskId: string) {
  const { data: t } = await supabase.from('crm_tasks')
    .select('id, title, description, parent_task_id, created_by, completed_by, status, done_notified_at')
    .eq('id', taskId).maybeSingle()
  const task = t as { id: string; title: string; parent_task_id: string | null; created_by: string; completed_by: string | null; status: string; done_notified_at: string | null } | null
  if (!task) return { skipped: 'not_found' }
  if (!task.parent_task_id) return { skipped: 'keine_teilaufgabe' }
  if (task.status !== 'erledigt') return { skipped: 'nicht_erledigt' }
  // Wer sich selbst zuarbeitet, braucht keine Rückmeldung.
  if (task.completed_by && task.completed_by === task.created_by) {
    await supabase.from('crm_tasks').update({ done_notified_at: new Date().toISOString() }).eq('id', task.id).is('done_notified_at', null)
    return { skipped: 'selbst_erledigt' }
  }

  // Compare-and-swap: nur EIN Aufruf gewinnt.
  const { data: claimed } = await supabase.from('crm_tasks')
    .update({ done_notified_at: new Date().toISOString() })
    .eq('id', task.id).is('done_notified_at', null).select('id')
  if (!claimed || claimed.length === 0) return { skipped: 'bereits_gemeldet' }

  const { data: giver } = await supabase.from('profiles').select('full_name, email, phone').eq('id', task.created_by).maybeSingle()
  const g = giver as { full_name: string | null; email: string | null; phone: string | null } | null
  const { data: doer } = task.completed_by
    ? await supabase.from('profiles').select('full_name').eq('id', task.completed_by).maybeSingle()
    : { data: null }
  const { data: parent } = await supabase.from('crm_tasks').select('title').eq('id', task.parent_task_id).maybeSingle()

  const first     = (g?.full_name ?? '').split(' ')[0] || 'Hallo'
  const doerName  = (doer as { full_name: string | null } | null)?.full_name ?? 'Jemand aus dem Team'
  const parentTtl = (parent as { title: string } | null)?.title ?? ''

  // Bewusst OHNE freien Text aus Bemerkungen: send-whatsapp durchsucht den Body nach
  // /deck/<token> und YouTube-Links und haengt dann eigenstaendig Bilder an.
  const waText = `✅ Zuarbeit erledigt\n\n*${task.title}*${parentTtl ? `\nzu: ${parentTtl}` : ''}\n\n${doerName} hat die Teilaufgabe als erledigt markiert.`
  const phone  = (g?.phone ?? '').trim()

  let via = 'keiner'
  if (phone) {
    // Nummer VOR dem Aufruf pruefen: send-whatsapp nutzt ??, ein Leerstring wuerde
    // die Empfaengeraufloesung kippen statt sauber abzubrechen.
    await supabase.functions.invoke('send-whatsapp', { body: {
      event_type: 'subtask_done', override_text: waText,
      lead_data: { lead_name: g?.full_name ?? 'Team', lead_phone: phone },
      // KEIN lead_id: sonst landet die interne Meldung in einer Kundenakte.
    } }).catch((e: unknown) => console.warn('[task-notify] subtask wa:', e))
    via = 'whatsapp'
  } else if (g?.email) {
    // Rueckfallebene, damit die Meldung nicht still verschwindet, wenn im Profil
    // keine Telefonnummer hinterlegt ist.
    await supabase.functions.invoke('send-email', { body: {
      to: g.email, subject: `Zuarbeit erledigt: ${task.title}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
        <p>Hallo ${esc(first)},</p>
        <p>${esc(doerName)} hat deine Teilaufgabe als erledigt markiert:</p>
        <div style="background:#faf7f4;border-radius:14px;padding:16px 18px;margin:14px 0;">
          <p style="font-size:16px;font-weight:600;color:#111827;margin:0;">${esc(task.title)}</p>
          ${parentTtl ? `<p style="color:#6b7280;font-size:13px;margin:6px 0 0;">zu: ${esc(parentTtl)}</p>` : ''}
        </div>
        <p style="font-size:13px;color:#6b7280;">Trage im Profil eine Telefonnummer ein, dann kommt diese Meldung künftig per WhatsApp.</p>
      </div>`,
    } }).catch((e: unknown) => console.warn('[task-notify] subtask mail:', e))
    via = 'mail'
  }
  console.log(`[task-notify] Teilaufgabe ${task.id} erledigt → Meldung an ${task.created_by} via ${via}`)
  return { notified: true, via }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { mode, task_id } = await req.json().catch(() => ({}))
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (mode === 'dispatch') {
      if (!task_id) return json({ error: 'task_id fehlt' }, 400)
      const { data: task } = await supabase.from('crm_tasks').select('id,title,description,due_date,status,archived').eq('id', task_id).single()
      if (!task) return json({ error: 'Aufgabe nicht gefunden' }, 404)
      const { data: asg } = await supabase.from('crm_task_assignees').select('*').eq('task_id', task_id)
      const out = []
      // Nur noch nicht benachrichtigte Zuständige zustellen — so benachrichtigt ein
      // erneuter Dispatch (nachträglich hinzugefügte Person) nur die Neuen.
      for (const a of (asg ?? []) as Assignee[]) {
        if (a.last_reminded_at) continue
        out.push(await deliver(supabase, a, task as Task, 'dispatch'))
      }
      return json({ ok: true, delivered: out })
    }

    if (mode === 'subtask_done') {
      if (!task_id) return json({ error: 'task_id fehlt' }, 400)
      return json({ ok: true, ...(await notifySubtaskDone(supabase, task_id)) })
    }

    // Sicherheitsnetz: erledigte Teilaufgaben, deren Meldung noch aussteht — faengt
    // jeden Erledigt-Weg ab, auch einen, den es heute noch nicht gibt.
    if (mode === 'subtask_sweep') {
      const { data: due } = await supabase.from('crm_tasks').select('id')
        .eq('status', 'erledigt').is('done_notified_at', null).not('parent_task_id', 'is', null).limit(50)
      const out = []
      for (const r of (due ?? []) as { id: string }[]) out.push(await notifySubtaskDone(supabase, r.id))
      return json({ ok: true, swept: out.length, out })
    }

    if (mode === 'reminder') {
      // Alle offenen (nicht erledigten, nicht archivierten) Aufgaben mit Zuständigen
      const cutoff = new Date(Date.now() - 20 * 3600_000).toISOString()   // max. 1×/Tag
      const { data: asg } = await supabase
        .from('crm_task_assignees')
        .select('*, task:crm_tasks!inner(id,title,description,due_date,status,archived)')
        .neq('task.status', 'erledigt').eq('task.archived', false)
      let sent = 0
      for (const row of (asg ?? []) as (Assignee & { task: Task })[]) {
        if (row.last_reminded_at && row.last_reminded_at > cutoff) continue
        await deliver(supabase, row, row.task, 'reminder'); sent++
      }
      return json({ ok: true, reminded: sent })
    }

    return json({ error: 'unbekannter Modus' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[task-notify]', msg)
    return json({ error: msg }, 500)
  }
})
