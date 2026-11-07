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

const FOLGE_PAUSE_MAX_MS = 48 * 3600e3

/**
 * Bis wann wartet die automatische Erstkontakt-Folge auf Lottes Terminfrage? null = sie geht raus.
 *
 * Rückblick über 60 Tage (7.11.2026): 39 von 393 Folge-WhatsApps kamen, während der Kunde noch
 * Lottes zwei Zeiten vor sich hatte, und warben dann mit einem Video für einen Termin. Keine
 * davon führte binnen 7 Tagen zu einem Termin. Darum wartet die Folge, solange der Stand
 * 'offen' ist: höchstens bis zum ersten vorgeschlagenen Termin (danach gilt termine_vorbei) und
 * nie länger als 48 Stunden nach Lottes Frage. Unlesbare Zeiten heißen: nicht warten.
 */
export function folgeWartetBis(p: { stand: DialogStand; lotteZuletzt: string | null; termine: TerminSlot[] | null; jetzt?: number }): string | null {
  if (p.stand !== 'offen' || !p.lotteZuletzt || !p.termine?.length) return null
  const bis = Math.min(Date.parse(p.lotteZuletzt) + FOLGE_PAUSE_MAX_MS, ...p.termine.map(t => Date.parse(t.startIso)))
  return bis > (p.jetzt ?? Date.now()) ? new Date(bis).toISOString() : null
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

// ── Soll überhaupt ein Termin gemacht werden? ──────────────────────────────────
//
// Erkan 25.9. und 28.9., Heiko 5.11.2026: Der Termin stand schon und begann in unter einer
// Stunde. Sven schrieb „Bist du evtl. schon eher erreichbar?“, der Kunde „wir können auch
// früher telefonieren“, und Lotte schlug zwei Zeiten an anderen Tagen vor. Erkan wählte eine
// davon: Sein Gespräch rückte so einmal um drei Tage und einmal um einen. Die Erkennung sah nur
// diese eine Nachricht, nicht den Termin und nicht den Chat davor.
//
// Bewusst keine Sperre für Bestandskunden oder laufende Chats. Sven, 7.11.2026: „Wenn jemand
// einen Termin machen will, soll Lotte fragen, natürlich. Der Bot soll nur den Kontext besser
// verstehen.“ Von den 10 Vorschlägen aus dem Chat in 60 Tagen gingen 6 an Bestandskunden, und
// die meisten davon hatten wirklich um ein Gespräch gebeten.

/** Ein Telefonat oder Zoom in dieser Spanne klärt Sven ohnehin selbst, Lotte schlägt nichts vor. */
const GLEICH_MS = 6 * 3600e3
const VERLAUF_MAX_ALTER_MS = 14 * 864e5
const VERLAUF_ZEILEN = 8
const ZEILE_MAX = 300

export type VerlaufRoh = { direction: string; content: string | null; auto: boolean | null; subject: string | null; created_at: string }
export type TerminRoh = { art: string; wann: string; titel: string | null; vorOrt: boolean; startIso: string }
export type TerminKontext = { von: 'kunde' | 'sven' | null; verlauf: string[]; termine: string[]; gleichTermin: boolean }

function spanne(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 90) return `${min} Min.`
  const std = Math.round(min / 60)
  return std < 36 ? `${std} Std.` : `${Math.round(std / 24)} Tagen`
}

/**
 * Was Lotte wissen muss, bevor sie Zeiten vorschlägt.
 * zeilen     WhatsApp-Aktivitäten des Kontakts, neueste zuerst. Die geprüfte Nachricht steht
 *            schon darin (waInbound schreibt sie vor dem Aufruf): Sie verrät, wer sie geschrieben
 *            hat, und zählt nicht als Verlauf.
 * termine    anstehende Termine des Kontakts, noch nicht beendet und nicht abgesagt
 *
 * Automatische Nachrichten fehlen im Verlauf absichtlich: Viele davon stehen nur am Kontakt und
 * gingen an Kollegen („Neue Registrierung“), und die Termine stehen ohnehin unten dabei.
 */
export function terminKontext(p: { zeilen: VerlaufRoh[]; termine: TerminRoh[]; text: string; botBetreff: string; jetzt?: number }): TerminKontext {
  const jetzt = p.jetzt ?? Date.now()
  const gesucht = p.text.trim()
  const eigene = p.zeilen.find(z => (z.content ?? '').trim() === gesucht)
  const von = !eigene ? null : eigene.direction === 'inbound' ? 'kunde' : eigene.auto === false ? 'sven' : null
  const rolle = (z: VerlaufRoh): string | null => {
    if (/^(Intern an|Kontakt )/.test(z.subject ?? '')) return null
    if (z.direction === 'inbound') return 'KUNDE'
    if (z.auto === false) return 'SVEN'
    return z.subject === p.botBetreff ? 'LOTTE' : null
  }
  const verlauf: string[] = []
  for (const z of p.zeilen) {
    if (z === eigene || verlauf.length >= VERLAUF_ZEILEN) continue
    const wer = rolle(z)
    const inhalt = (z.content ?? '').replace(/\s+/g, ' ').trim().slice(0, ZEILE_MAX)
    const alter = jetzt - Date.parse(z.created_at)
    if (!wer || !inhalt || !(alter <= VERLAUF_MAX_ALTER_MS)) continue
    verlauf.unshift(`${wer}, ${alter < 120000 ? 'gerade eben' : `vor ${spanne(alter)}`}: ${inhalt}`)
  }
  const termine = p.termine.map(t => {
    const bis = Date.parse(t.startIso) - jetzt
    const wann = !(bis > 0) ? 'läuft gerade' : `in ${spanne(bis)}`
    return `${t.art}, ${t.wann} (${wann}${t.titel ? `, „${t.titel}“` : ''})`
  })
  return { von, verlauf, termine, gleichTermin: p.termine.some(t => !t.vorOrt && Date.parse(t.startIso) - jetzt <= GLEICH_MS) }
}

/** Für die KI: die Lage und die Frage, ob Lotte jetzt wirklich neue Zeiten vorschlagen soll. */
export function kontextBlock(k: TerminKontext): string {
  const von = k.von === 'sven' ? 'SVEN' : k.von === 'kunde' ? 'dem KUNDEN' : 'dem Kunden oder von Sven (nicht bekannt)'
  return `LAGE: Die Nachricht stammt von ${von}.
Anstehende Termine im Kalender: ${k.termine.length ? k.termine.join(' | ') : 'keine'}.
Chat davor, älteste zuerst:
${k.verlauf.length ? k.verlauf.join('\n') : '(keine Nachrichten in den letzten 14 Tagen)'}

Bei wants=true schlägt Lotte, Svens Assistentin, SOFORT zwei neue Zeiten vor, frühestens ab morgen. Entscheide aus dieser Lage, ob das gewollt ist.
wants=false, auch wenn ein Terminwort fällt, wenn:
- es um einen Termin geht, der schon steht, im Kalender oder im Chat abgemacht: vorziehen, etwas später, „wir haben gleich unseren Zoom“, „bist du schon eher erreichbar?“, „wir können auch früher“, „dann ruf mich gern an“, Rückfragen dazu.
- Sven ein Gespräch für jetzt, gleich oder heute anbietet oder danach fragt („kannst du in 5 Minuten?“, „soll ich anrufen?“, „heute gegen 12?“), oder der Kunde auf so ein Angebot antwortet. Das klären die beiden direkt.
- das Terminwort zu etwas anderem gehört („ich brauche noch Zeit“, „wann ist die Übergabe?“).
wants=true, wenn noch keine Zeit feststeht und jemand ein Gespräch möchte: auch mitten im Chat, auch während Sven mitschreibt, auch bei langjährigen Kunden, auch zusätzlich zu einem anderen Termin („können wir vor der Besichtigung noch telefonieren?“) und auch, wenn Sven es offen vorschlägt („wollen wir mal telefonieren?“, „wann passt es dir?“). Bittet der Kunde klar um ein Gespräch, gilt das vor „im Zweifel false“.`
}

/**
 * Für den Termin-Dialog. Grit, 27.10.2026: „eigentlich habe ich einen Termin, Samstag 13.00 Uhr …
 * steht das?“ Die Abmachung kam aus einem Telefonat und stand nirgends. Lotte las einen Zeitwunsch
 * und schrieb zweimal, da sei nichts frei, bis Sven dazwischenging.
 */
export const ABMACHUNG_REGEL = 'ABMACHUNG: Beruft sich der Kunde auf einen Termin, der aus seiner Sicht schon abgemacht ist ("eigentlich habe ich einen Termin, Samstag 13 Uhr, steht das?", "wir hatten doch Freitag ausgemacht"), dann kennst du diese Abmachung nicht und darfst ihr nicht widersprechen: intent = content, damit Sven das klärt. Das geht dem TERMIN-VORRANG vor.'
