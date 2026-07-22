import { supabase } from './supabase'

// ── Aufgabe annehmen ──────────────────────────────────────────────────────────
// Sven: „Wenn Annehmen gedrückt, schließt sich das Fenster, die Aufgabe bekommt
// die Notiz ‚angenommen' — bleibt aber im Reiter ‚gestellt'. Erst wenn sie wirklich
// in Bearbeitung steht, geht sie einen Schritt weiter."
//
// Annehmen ist also NICHT „in Arbeit". Es setzt nur:
//   • crm_task_assignees.accepted_at  (für DIESE Person)
//   • crm_tasks.accepted_at/accepted_by  (einmalig, für Karten-Badge + Ersteller)
//   • eine Notiz „angenommen" an den Ersteller
// Der Status bleibt 'offen' (= Spalte „Gestellt"). Der Wechsel nach 'in_arbeit'
// ist ein eigener, bewusster Schritt.
export async function acceptTask(taskId: string, myId: string, myName: string, creatorId?: string | null): Promise<void> {
  const now = new Date().toISOString()
  // Nur die eigene Zuständigkeits-Zeile bestätigen (eine Aufgabe kann mehrere haben).
  await supabase.from('crm_task_assignees').update({ accepted_at: now })
    .eq('task_id', taskId).eq('profile_id', myId).is('accepted_at', null)
  // Karten-Marker einmalig setzen (is null → der erste Annehmende gewinnt, kein Überschreiben).
  await supabase.from('crm_tasks').update({ accepted_at: now, accepted_by: myId })
    .eq('id', taskId).is('accepted_at', null)
  // Ersteller informieren — die Notiz „angenommen" in der Aufgaben-Chronik.
  if (creatorId && creatorId !== myId) {
    const { error } = await supabase.from('crm_task_messages').insert({
      task_id: taskId, sender_id: myId, sender_label: myName, recipient_id: creatorId,
      body: '✋ Aufgabe angenommen',
    })
    if (error) console.warn('[acceptTask] Notiz fehlgeschlagen:', error.message)
  }
}
