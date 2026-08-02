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
import { lotteBild } from '../_shared/lotte.ts'

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

    // 3) Leere Eigentümer-Portale (Svens Karteileichen-Regel): Warnung nach
    //    3 + 5 Monaten (Lotte-Mail), Löschung nach 6 Monaten — aber nie, wenn
    //    der Kunde noch einen aktiven Deal hat (Wohnung kommt dann ja noch).
    let warned = 0, deletedAccounts = 0
    const { data: ownersRaw } = await sb.from('profiles')
      .select('id, full_name, email, language, created_at, portal_warned_3m_at, portal_warned_5m_at')
      .eq('role', 'eigentuemer')
    for (const o of ((ownersRaw ?? []) as Array<{ id: string; full_name: string | null; email: string | null; language: string | null; created_at: string; portal_warned_3m_at: string | null; portal_warned_5m_at: string | null }>)) {
      const { count } = await sb.from('properties').select('id', { count: 'exact', head: true }).eq('owner_id', o.id)
      if ((count ?? 0) > 0) continue
      if (o.email) {
        const { data: ld } = await sb.from('leads').select('id').ilike('email', o.email).limit(1)
        const leadId = (ld?.[0] as { id: string } | undefined)?.id
        if (leadId) {
          const { data: dl } = await sb.from('deals').select('id').eq('lead_id', leadId)
            .not('phase', 'in', '(deal_verloren,archiviert)').limit(1)
          if (dl && dl.length) continue
        }
      }
      const now = Date.now()
      const age = now - new Date(o.created_at).getTime()
      const de_ = o.language !== 'en'
      const first = (o.full_name ?? '').split(' ')[0] || (de_ ? 'Hallo' : 'Hi')
      const warnMail = async (final: boolean) => {
        if (!o.email) return
        const subj = final
          ? (de_ ? '⏳ Dein Portal-Zugang wird bald deaktiviert' : '⏳ Your portal access will be deactivated soon')
          : (de_ ? '🔑 Dein Happy-Property-Portal wartet auf dich' : '🔑 Your Happy Property portal is waiting for you')
        const bodyTxt = final
          ? (de_ ? 'dein Zugang zum Happy Property Portal ist weiterhin ohne hinterlegte Immobilie. Ungenutzte Zugänge deaktivieren wir nach 6 Monaten automatisch — dein Zugang wird also in Kürze gelöscht. Sobald eine Wohnung für dich hinterlegt ist, bleibt selbstverständlich alles bestehen. Melde dich gern, wenn wir etwas klären sollen!' : 'your Happy Property portal access still has no property linked. We automatically remove unused accounts after 6 months — your access will be deleted shortly. As soon as a property is linked, everything of course stays in place. Get in touch if we can help!')
          : (de_ ? 'in deinem Happy-Property-Portal ist bisher keine Immobilie hinterlegt. Nur damit du es weißt: Ungenutzte Zugänge räumen wir nach 6 Monaten automatisch auf. Sobald deine Wohnung hinterlegt ist, bleibt dein Zugang natürlich dauerhaft bestehen. Bei Fragen sind wir jederzeit für dich da!' : 'your Happy Property portal has no property linked yet. Just so you know: we clean up unused accounts after 6 months. As soon as your apartment is linked, your access of course remains permanently. Any questions — we are here for you!')
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
          <div style="text-align:center;margin-bottom:6px;">
            <img src="${lotteBild()}" alt="Lotte" width="80" height="80" style="width:80px;height:80px;border-radius:50%;object-fit:cover;" />
            <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · ${de_ ? 'persönliche Assistentin von Sven' : "Sven's personal assistant"} 🐾</p>
          </div>
          <p>${de_ ? `Hallo ${first},` : `Hi ${first},`}</p><p>${bodyTxt}</p>
          <p style="font-size:13px;color:#6b7280;">${de_ ? 'Liebe Grüße' : 'Best regards'}<br/>Lotte 🐾</p>
        </div>`
        await sb.functions.invoke('send-email', { body: { to: o.email, subject: subj, html, from_name: 'Lotte · Happy Property', auto: true, lang: de_ ? 'de' : 'en' } })
      }
      const D = 864e5
      if (age > 180 * D && o.portal_warned_3m_at && o.portal_warned_5m_at && now - new Date(o.portal_warned_5m_at).getTime() > 21 * D) {
        try {
          await sb.auth.admin.deleteUser(o.id)
          await sb.from('profiles').delete().eq('id', o.id)
          deletedAccounts++
          console.log('[tasks-maintenance] Leeres Portal gelöscht:', o.email)
        } catch (e) { console.warn('[tasks-maintenance] Portal-Löschung:', o.email, e) }
      } else if (age > 150 * D && o.portal_warned_3m_at && !o.portal_warned_5m_at && now - new Date(o.portal_warned_3m_at).getTime() > 14 * D) {
        try { await warnMail(true); await sb.from('profiles').update({ portal_warned_5m_at: new Date().toISOString() }).eq('id', o.id); warned++ } catch (e) { console.warn('[tasks-maintenance] 5M-Warnung:', e) }
      } else if (age > 90 * D && !o.portal_warned_3m_at) {
        try { await warnMail(false); await sb.from('profiles').update({ portal_warned_3m_at: new Date().toISOString() }).eq('id', o.id); warned++ } catch (e) { console.warn('[tasks-maintenance] 3M-Warnung:', e) }
      }
    }

    console.log(`[tasks-maintenance] Anhänge gelöscht: ${filesDeleted}, Alt-Aufgaben gelöscht: ${oldIds.length}, Portal-Warnungen: ${warned}, Portale gelöscht: ${deletedAccounts}`)
    return json({ success: true, attachments_deleted: filesDeleted, tasks_purged: oldIds.length, portals_warned: warned, portals_deleted: deletedAccounts })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tasks-maintenance]', msg)
    return json({ error: msg }, 500)
  }
})
