// tasks-maintenance — Speicher-Hygiene für die Aufgaben-App (Svens Vorgabe):
//   1. Aufgabe erledigt + im Archiv → Bild-Anhänge vom Server löschen
//      (Storage task-attachments + crm_task_attachments-Zeilen).
//   2. Archivierte Aufgaben nach 3 Monaten KOMPLETT löschen
//      (inkl. Zuweisungen, Kunden-Verknüpfungen, Nachrichten).
// Läuft sonntags 20:15 UTC per pg_cron — direkt nach hp_sunday_archive (20:00),
// das archived_at setzt.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy tasks-maintenance --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    // 1) Anhänge archivierter Aufgaben löschen (Storage + Zeilen)
    const { data: archived } = await sb.from('crm_tasks').select('id').eq('archived', true)
    const archIds = ((archived ?? []) as { id: string }[]).map(x => x.id)
    let filesDeleted = 0
    if (archIds.length) {
      const { data: atts } = await sb.from('crm_task_attachments').select('id, storage_path').in('task_id', archIds)
      const rows = (atts ?? []) as { id: string; storage_path: string }[]
      if (rows.length) {
        // Storage in 100er-Paketen leeren; Fehler nur loggen, Lauf nicht abbrechen
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100).map(r => r.storage_path)
          const { error } = await sb.storage.from('task-attachments').remove(batch)
          if (error) console.warn('[tasks-maintenance] storage remove:', error.message)
        }
        const { error: delErr } = await sb.from('crm_task_attachments').delete().in('id', rows.map(r => r.id))
        if (delErr) console.warn('[tasks-maintenance] rows delete:', delErr.message)
        filesDeleted = rows.length
      }
    }

    // 2) Archiv älter als 3 Monate → komplett löschen
    const cutoff = new Date(Date.now() - 90 * 864e5).toISOString()
    const { data: old } = await sb.from('crm_tasks').select('id').eq('archived', true).lt('archived_at', cutoff)
    const oldIds = ((old ?? []) as { id: string }[]).map(x => x.id)
    if (oldIds.length) {
      for (const table of ['crm_task_attachments', 'crm_task_assignees', 'crm_task_leads', 'crm_task_messages']) {
        const { error } = await sb.from(table).delete().in('task_id', oldIds)
        if (error) console.warn(`[tasks-maintenance] ${table}:`, error.message)
      }
      const { error } = await sb.from('crm_tasks').delete().in('id', oldIds)
      if (error) throw error
    }

    console.log(`[tasks-maintenance] Anhänge gelöscht: ${filesDeleted}, Alt-Aufgaben gelöscht: ${oldIds.length}`)
    return json({ success: true, attachments_deleted: filesDeleted, tasks_purged: oldIds.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tasks-maintenance]', msg)
    return json({ error: msg }, 500)
  }
})
