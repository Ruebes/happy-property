// task-action — öffentliche Aktionen an einer Aufgabe über den Assignee-Token.
// Kein JWT: Der Token IST die Autorisierung (wie Deck-/Rechnungs-Links).
// Aktionen: info | accept | done | note. Nutzt Service-Role (RLS-Bypass gewollt).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy task-action --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { token, action, note } = await req.json().catch(() => ({}))
    if (!token || typeof token !== 'string') return json({ error: 'token fehlt' }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Assignee + Aufgabe über Token laden
    const { data: asg, error: aErr } = await supabase
      .from('crm_task_assignees')
      .select('id, task_id, profile_id, ext_name, accepted_at')
      .eq('token', token).maybeSingle()
    if (aErr) throw aErr
    if (!asg) return json({ error: 'ungültiger Link' }, 404)

    const { data: task, error: tErr } = await supabase
      .from('crm_tasks')
      .select('id, title, description, status, created_by, accepted_at, archived')
      .eq('id', asg.task_id).single()
    if (tErr || !task) return json({ error: 'Aufgabe nicht gefunden' }, 404)

    // Absender-Label für Bemerkungen
    let label = asg.ext_name || 'Extern'
    if (asg.profile_id) {
      const { data: p } = await supabase.from('profiles').select('full_name').eq('id', asg.profile_id).single()
      label = p?.full_name || label
    }

    const nowIso = new Date().toISOString()
    const statusLabel = (s: string) => s === 'erledigt' ? 'Erledigt' : s === 'in_arbeit' ? 'In Arbeit' : 'Offen'

    // ── info: Zustand für die Link-Seite ────────────────────────────────────
    if (!action || action === 'info') {
      return json({
        ok: true, title: task.title, description: task.description,
        status: task.status, statusLabel: statusLabel(task.status),
        assignee: label, accepted: !!asg.accepted_at, done: task.status === 'erledigt',
      })
    }

    // ── note: Bemerkung schreiben (an den Ersteller, sichtbar für alle) ──────
    const addNote = async (body: string, prefix = '') => {
      const text = (prefix + body).slice(0, 4000)
      await supabase.from('crm_task_messages').insert({
        task_id: task.id, sender_id: asg.profile_id ?? null, sender_label: label,
        recipient_id: task.created_by, body: text,
      })
    }

    if (action === 'note') {
      if (!note || !String(note).trim()) return json({ error: 'Bemerkung leer' }, 400)
      await addNote(String(note).trim())
      return json({ ok: true, status: task.status })
    }

    // ── accept: annehmen → In Arbeit ────────────────────────────────────────
    if (action === 'accept') {
      if (task.status === 'erledigt') return json({ ok: true, status: 'erledigt', already: true })
      await supabase.from('crm_task_assignees').update({ accepted_at: asg.accepted_at ?? nowIso }).eq('id', asg.id)
      const patch: Record<string, unknown> = { status: 'in_arbeit' }
      if (!task.accepted_at) { patch.accepted_at = nowIso; patch.accepted_by = asg.profile_id ?? null }
      await supabase.from('crm_tasks').update(patch).eq('id', task.id)
      if (note && String(note).trim()) await addNote(String(note).trim(), '')
      await addNote('Aufgabe angenommen.', '✅ ')
      return json({ ok: true, status: 'in_arbeit' })
    }

    // ── done: erledigt → wandert in der Pipeline weiter ─────────────────────
    if (action === 'done') {
      if (note && String(note).trim()) await addNote(String(note).trim(), '')
      await supabase.from('crm_tasks').update({
        status: 'erledigt', completed_by: asg.profile_id ?? null,
        accepted_at: task.accepted_at ?? nowIso,
      }).eq('id', task.id)
      await addNote('Als erledigt markiert.', '🏁 ')
      return json({ ok: true, status: 'erledigt' })
    }

    return json({ error: 'unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[task-action]', msg)
    return json({ error: msg }, 500)
  }
})
