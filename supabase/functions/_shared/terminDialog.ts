// Gehört eine Kundennachricht überhaupt zu Lottes Terminfrage?
//
// Thorsten Brendel, 6.11.2026: Um 18:48 UTC gingen ihm automatisch die Baustellenfotos
// von Infinity zu, 14 Minuten später schrieb er „Geht was“. Weil ein altes Termin-Gespräch
// offen stand, galt das als Antwort darauf, und Lotte schrieb „Sag mir einfach 1 oder 2“,
// mit einem Termin, der schon vorbei war. Die Frage selbst hatte er nie gesehen: Sie fiel
// am 5.11. in die WhatsApp-Sperre und ging nur als Ersatz-Mail raus.
//
// Regel: Eine Nachricht ist nur dann eine Antwort auf den Dialog, wenn Lottes Terminfrage
// wirklich das Letzte ist, was der Kunde von uns bekommen hat, und ihre Termine noch gelten.
// Sonst zählt sie nur, wenn der Kunde selbst ausdrücklich einen Termin anspricht.
//
// Reine Funktionen, Tests: scripts/verify-termin-dialog.mjs

export type DialogStand = 'offen' | 'nicht_zugestellt' | 'sven_schreibt' | 'andere_nachricht' | 'termine_vorbei'
export type TerminSlot = { startIso: string }

/** Die Termine, die in diesem Zustand gerade auf dem Tisch liegen. null = keine nötig. */
export function termineAufDemTisch(state: string, vorgeschlagen: TerminSlot[] | null, gewaehlt: TerminSlot | null): TerminSlot[] | null {
  if (state === 'awaiting_choice') return vorgeschlagen ?? []
  if (state === 'awaiting_type' || state === 'awaiting_confirm') return gewaehlt ? [gewaehlt] : []
  return null
}

/** Ist mindestens einer der Termine schon vorbei (oder hat kein lesbares Datum)? */
export function termineVorbei(termine: TerminSlot[], jetzt = Date.now()): boolean {
  return termine.some(t => !(Date.parse(t.startIso) > jetzt))
}

/**
 * lotteZuletzt   Zeit der letzten Termin-WhatsApp dieses Gesprächs, null = keine ging raus
 * svenDanach     Sven hat danach selbst geschrieben
 * andereDanach   danach ging etwas anderes an diese Nummer (Baustelle, Newsletter, Bericht ...)
 */
export function dialogStand(p: { lotteZuletzt: string | null; svenDanach: boolean; andereDanach: boolean; termine: TerminSlot[] | null; jetzt?: number }): DialogStand {
  if (!p.lotteZuletzt) return 'nicht_zugestellt'
  if (p.svenDanach) return 'sven_schreibt'
  if (p.andereDanach) return 'andere_nachricht'
  if (p.termine && (!p.termine.length || termineVorbei(p.termine, p.jetzt))) return 'termine_vorbei'
  return 'offen'
}

export type TerminFelder = {
  intent: string
  pick_index?: number | null
  on_date?: string | null
  after_date?: string | null
  day_hint?: string | null
  daypart?: string | null
  time_hint?: string | null
  meeting_type?: string | null
}

/**
 * Spricht der Kunde selbst einen Termin an? Nur das zählt, wenn der Dialog nicht offen ist.
 * Bewusst nicht dabei: indifferent und confirm_yes. „Passt alles“ zu Baustellenfotos
 * würde sonst den ersten Termin auswählen.
 */
export function nenntTermin(it: TerminFelder, stand: DialogStand, state: string): boolean {
  if (it.on_date || it.after_date || it.day_hint || it.daypart || it.time_hint) return true
  if (it.intent === 'give_preference') return true
  if (state === 'awaiting_type' && it.intent === 'choose_type' && it.meeting_type) return true
  // Zeiten wählen oder ablehnen kann nur, wer sie auch bekommen hat.
  if (stand !== 'nicht_zugestellt' && (it.pick_index != null || it.intent === 'reject_slots')) return true
  // Termine vorbei, aber sonst kam nichts dazwischen: Ein „Ja“ meint Lottes Frage. Der Dialog
  // läuft weiter und bietet neue Zeiten an, weil die alten nicht mehr gelten.
  return stand === 'termine_vorbei' && (it.intent === 'indifferent' || it.intent === 'confirm_yes')
}

// Diese Absichten haben im Bot eigene Wege, und keiner davon schlägt Termine vor.
const EIGENER_WEG = ['content', 'question', 'defer', 'self_followup']

/**
 * Steigt Lotte bei dieser Nachricht aus dem Termin-Dialog aus?
 * Inhaltliches behält bei neuen Kontakten seinen Weg (Dana, 22.9.: „Das gebe ich direkt an
 * Sven weiter“). Schreibt Sven selbst oder ist es ein Bestandskunde, hält Lotte sich auch
 * da raus, wie in handleAnswer und absageStumm.
 */
export function dialogEndet(it: TerminFelder, stand: DialogStand, state: string, bestandskunde: boolean): boolean {
  if (stand === 'offen' || nenntTermin(it, stand, state)) return false
  return stand === 'sven_schreibt' || bestandskunde || !EIGENER_WEG.includes(it.intent)
}

/**
 * Für die KI: warum die Nachricht vermutlich nicht zum Termin-Dialog gehört. termine_vorbei
 * fehlt bewusst, denn da ist Lottes Frage noch das Letzte, was der Kunde bekommen hat.
 */
export const DIALOG_HINWEIS: Partial<Record<DialogStand, string>> = {
  nicht_zugestellt: 'Der Kunde hat in diesem Gespräch noch nie eine Terminfrage von Lotte per WhatsApp bekommen.',
  sven_schreibt: 'Nach Lottes letzter Terminfrage hat Sven selbst mit dem Kunden geschrieben.',
  andere_nachricht: 'Nach Lottes letzter Terminfrage ging eine andere automatische Nachricht an den Kunden (zum Beispiel Baustellenfotos, Newsletter oder ein Bericht).',
}

/** Für Svens Notiz am Kontakt. */
export const DIALOG_NOTIZ: Record<DialogStand, string> = {
  offen: '',
  nicht_zugestellt: 'Die Terminfrage hat er nie per WhatsApp bekommen.',
  sven_schreibt: 'Du hast nach Lottes Terminfrage selbst mit ihm geschrieben.',
  andere_nachricht: 'Nach Lottes Terminfrage ging ihm eine andere automatische Nachricht zu, die Antwort gehört vermutlich dazu.',
  termine_vorbei: 'Die vorgeschlagenen Termine sind schon vorbei.',
}
