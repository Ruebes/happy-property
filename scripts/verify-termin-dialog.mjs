// Tests für _shared/terminDialog.ts: Gehört eine Kundennachricht zu Lottes Terminfrage?
// Anlass: Thorsten Brendel, 6.11.2026, „Geht was“ zu den Baustellenfotos von Infinity.
//
// Ausführen: node scripts/verify-termin-dialog.mjs

import { execSync } from 'child_process'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'hpdialog-')), 'terminDialog.mjs')
execSync(`npx --yes esbuild ${JSON.stringify(join(root, 'supabase/functions/_shared/terminDialog.ts'))} --bundle --format=esm --platform=neutral --outfile=${JSON.stringify(out)} --log-level=warning`, { stdio: 'pipe', cwd: root })
const D = await import(out)

const fails = []
let checked = 0
const check = (ok, msg) => { checked++; if (!ok) fails.push(msg) }

const JETZT = Date.parse('2026-11-06T19:02:20Z')
const vorbei = { startIso: '2026-11-06T10:00:00.000Z' }
const morgen = { startIso: '2026-11-07T16:00:00.000Z' }
const spaeter = { startIso: '2026-11-09T10:00:00.000Z' }
const stand = (p) => D.dialogStand({ lotteZuletzt: '2026-11-06T10:00:00Z', svenDanach: false, andereDanach: false, termine: [morgen, spaeter], jetzt: JETZT, ...p })

// ── Thorstens Fall: Frage nie per WhatsApp bekommen, und ein Termin ist schon vorbei ──
check(stand({ lotteZuletzt: null, termine: [vorbei, morgen] }) === 'nicht_zugestellt', 'Thorsten: nie zugestellt')

// ── Stand ──
check(stand({}) === 'offen', 'Lottes Frage ist das Letzte, Termine gelten: offen')
check(stand({ svenDanach: true }) === 'sven_schreibt', 'Sven schreibt danach selbst')
check(stand({ andereDanach: true }) === 'andere_nachricht', 'Baustelle oder Newsletter danach')
check(stand({ svenDanach: true, andereDanach: true }) === 'sven_schreibt', 'Sven hat Vorrang vor Automatik')
check(stand({ termine: [vorbei, morgen] }) === 'termine_vorbei', 'ein Termin vorbei reicht')
check(stand({ termine: [] }) === 'termine_vorbei', 'keine Termine auf dem Tisch')
check(stand({ termine: null }) === 'offen', 'awaiting_daypref braucht keine Termine')

// ── Welche Termine zählen in welchem Zustand ──
check(D.termineAufDemTisch('awaiting_choice', [morgen], vorbei)[0] === morgen, 'awaiting_choice: vorgeschlagene')
check(D.termineAufDemTisch('awaiting_type', [morgen], vorbei)[0] === vorbei, 'awaiting_type: gewählter')
check(D.termineAufDemTisch('awaiting_confirm', null, spaeter)[0] === spaeter, 'awaiting_confirm: gewählter')
check(D.termineAufDemTisch('awaiting_type', [morgen], null).length === 0, 'awaiting_type ohne Wahl: leer')
check(D.termineAufDemTisch('awaiting_daypref', [morgen], null) === null, 'awaiting_daypref: keine nötig')
check(D.termineAufDemTisch('awaiting_choice', null, null).length === 0, 'awaiting_choice ohne Vorschläge: leer')

// ── termineVorbei ──
check(D.termineVorbei([vorbei], JETZT) === true, 'vorbei')
check(D.termineVorbei([morgen], JETZT) === false, 'Zukunft')
check(D.termineVorbei([morgen, vorbei], JETZT) === true, 'einer von zwei vorbei')
check(D.termineVorbei([{ startIso: 'kaputt' }], JETZT) === true, 'unlesbares Datum zählt als vorbei')
check(D.termineVorbei([], JETZT) === false, 'leer ist nicht vorbei')

// ── nenntTermin: Was zählt, wenn der Dialog nicht offen ist ──
const nennt = (it, s = 'andere_nachricht', state = 'awaiting_choice') => D.nenntTermin(it, s, state)
for (const intent of ['unclear', 'content', 'question', 'indifferent', 'confirm_yes', 'confirm_no', 'self_followup', 'defer']) {
  check(!nennt({ intent }), `${intent} ohne Terminangabe zählt nicht`)
}
check(!nennt({ intent: 'choose_type', meeting_type: 'zoom' }), 'Terminart ohne gewählten Slot zählt nicht')
check(nennt({ intent: 'choose_type', meeting_type: 'zoom' }, 'sven_schreibt', 'awaiting_type'), 'Terminart im Zustand awaiting_type zählt')
check(nennt({ intent: 'give_preference', day_hint: 'Montag' }), 'Tag genannt')
check(nennt({ intent: 'give_preference', time_hint: '15:00' }), 'Uhrzeit genannt')
check(nennt({ intent: 'give_preference', on_date: '2026-11-09' }), 'Datum genannt')
check(nennt({ intent: 'give_preference', after_date: '2026-11-09' }), 'frühestes Datum genannt')
check(nennt({ intent: 'give_preference', daypart: 'abends' }), 'Tageszeit genannt')
check(nennt({ intent: 'give_preference' }), 'Gesprächswunsch ohne Zeit zählt')
check(nennt({ intent: 'give_preference' }, 'nicht_zugestellt'), 'Gesprächswunsch zählt auch ohne zugestellte Frage')
check(nennt({ intent: 'pick_slot', pick_index: 1 }), 'Wahl einer bekommenen Zeit')
check(nennt({ intent: 'pick_slot', pick_index: 0 }), 'Index 0 ist eine Wahl')
check(nennt({ intent: 'reject_slots' }), 'Ablehnung bekommener Zeiten')
check(!nennt({ intent: 'pick_slot', pick_index: 1 }, 'nicht_zugestellt'), 'nie bekommene Zeit kann man nicht wählen')
check(!nennt({ intent: 'reject_slots' }, 'nicht_zugestellt'), 'nie bekommene Zeit kann man nicht ablehnen')
check(nennt({ intent: 'confirm_yes' }, 'termine_vorbei'), 'Ja zu alter Frage: neue Zeiten statt Schweigen')
check(nennt({ intent: 'indifferent' }, 'termine_vorbei'), 'Egal zu alter Frage: neue Zeiten statt Schweigen')
check(!nennt({ intent: 'unclear' }, 'termine_vorbei'), 'Kommentar zu alter Frage zählt nicht')

// ── dialogEndet: echte Nachrichten aus dem Rückblick über 60 Tage ──
const endet = (it, s, state = 'awaiting_choice', bestand = false) => D.dialogEndet(it, s, state, bestand)
check(endet({ intent: 'unclear' }, 'nicht_zugestellt', 'awaiting_choice', true), 'Thorsten, 6.11.: „Geht was“ beendet den Dialog')
check(endet({ intent: 'unclear' }, 'andere_nachricht'), 'Jacqueline, 3.11.: „Dankeschön“ auf das Video beendet den Dialog')
check(endet({ intent: 'confirm_yes' }, 'sven_schreibt'), 'Erkan, 25.9.: „Ja ok“ auf Svens Anrufangebot beendet den Dialog')
check(endet({ intent: 'indifferent' }, 'andere_nachricht'), '„Passt alles“ wählt nicht den ersten Termin')
check(!endet({ intent: 'content' }, 'andere_nachricht'), 'Dana, 22.9.: Inhaltliches behält bei neuen Kontakten seinen Weg')
check(endet({ intent: 'content' }, 'andere_nachricht', 'awaiting_choice', true), 'Inhaltliches eines Bestandskunden: Lotte hält sich raus')
check(endet({ intent: 'content' }, 'sven_schreibt'), 'Walter, 4.11.: Sachfrage, während Sven schreibt: Lotte hält sich raus')
for (const intent of ['question', 'defer', 'self_followup']) {
  check(!endet({ intent }, 'andere_nachricht'), `${intent} behält bei neuen Kontakten seinen Weg`)
  check(endet({ intent }, 'sven_schreibt'), `${intent}, während Sven schreibt: Lotte hält sich raus`)
}
check(!endet({ intent: 'pick_slot', pick_index: 1 }, 'sven_schreibt'), 'Wahl einer bekommenen Zeit bleibt im Dialog')
check(!endet({ intent: 'give_preference', day_hint: 'Montag' }, 'nicht_zugestellt', 'awaiting_choice', true), 'ausdrücklicher Terminwunsch bleibt im Dialog')
check(!endet({ intent: 'choose_type', meeting_type: 'zoom' }, 'sven_schreibt', 'awaiting_type'), 'Terminart auf Lottes Frage bleibt im Dialog')
for (const intent of ['unclear', 'content', 'confirm_yes', 'indifferent', 'question']) {
  check(!endet({ intent }, 'offen', 'awaiting_choice', true), `offener Dialog bleibt wie bisher (${intent})`)
}

// ── Erstkontakt-Folge wartet, solange Lottes Frage offen ist ──
const LOTTE = '2026-11-06T10:00:00Z'
const wartet = (p) => D.folgeWartetBis({ stand: 'offen', lotteZuletzt: LOTTE, termine: [morgen, spaeter], jetzt: JETZT, ...p })
check(wartet({}) === morgen.startIso, 'wartet bis zum ersten Termin')
check(wartet({ termine: [spaeter, morgen] }) === morgen.startIso, 'Reihenfolge der Termine ist egal')
check(wartet({ termine: [spaeter] }) === '2026-11-08T10:00:00.000Z', 'höchstens 48 Stunden nach Lottes Frage')
for (const s of ['nicht_zugestellt', 'sven_schreibt', 'andere_nachricht', 'termine_vorbei']) {
  check(wartet({ stand: s }) === null, `Stand ${s}: Folge geht raus`)
}
check(wartet({ lotteZuletzt: null }) === null, 'keine Frage zugestellt: Folge geht raus')
check(wartet({ termine: null }) === null, 'keine Termine nötig: Folge geht raus')
check(wartet({ termine: [] }) === null, 'keine Termine auf dem Tisch: Folge geht raus')
check(wartet({ jetzt: Date.parse(morgen.startIso) }) === null, 'erster Termin erreicht: Folge geht raus')
check(wartet({ termine: [spaeter], jetzt: Date.parse('2026-11-08T10:00:00Z') }) === null, '48 Stunden um: Folge geht raus, auch wenn die Termine noch gelten')
check(wartet({ termine: [{ startIso: 'kaputt' }] }) === null, 'unlesbarer Termin: nicht warten')
check(wartet({ lotteZuletzt: 'kaputt' }) === null, 'unlesbare Fragezeit: nicht warten')

// ── Texte: jeder Stand hat beide, keine Gedankenstriche, echte Umlaute ──
for (const s of ['nicht_zugestellt', 'sven_schreibt', 'andere_nachricht', 'termine_vorbei']) {
  const texte = [['DIALOG_NOTIZ', D.DIALOG_NOTIZ[s]]]
  if (s !== 'termine_vorbei') texte.push(['DIALOG_HINWEIS', D.DIALOG_HINWEIS[s]])
  for (const [name, t] of texte) {
    check(!!t, `${name}.${s} fehlt`)
    check(!/[—–]/.test(t ?? ''), `${name}.${s}: Gedankenstrich`)
    check(!/\b(fuer|ueber|Gespraech|naechst)/i.test(t ?? ''), `${name}.${s}: Umlaut umschrieben`)
  }
}
check(!D.DIALOG_HINWEIS.offen && !D.DIALOG_HINWEIS.termine_vorbei, 'offen und termine_vorbei: kein Hinweis an die KI, Lottes Frage ist das Letzte')

// ── booking-bot: Die Prüfung steht an der richtigen Stelle ──
const bot = readFileSync(join(root, 'supabase/functions/booking-bot/index.ts'), 'utf8')
const reply = bot.slice(bot.indexOf('async function replyRunde('), bot.indexOf('// Kleine Sende-Helfer'))
const pos = (s) => reply.indexOf(s)
check(pos("it.intent === 'optout'") > 0 && pos("it.intent === 'optout'") < pos('dialogEndet('), 'Abmeldung geht vor der Prüfung')
check(pos('dialogEndet(') < pos("it.intent === 'self_followup'"), 'Prüfung vor self_followup')
check(pos('dialogEndet(') < pos("it.intent === 'defer'"), 'Prüfung vor defer')
check(pos('dialogEndet(') < pos('// ── Zustandsmaschine'), 'Prüfung vor der Zustandsmaschine')
const ausstieg = reply.slice(pos('dialogEndet('), pos("it.intent === 'self_followup'"))
check(/handleAnswer\(/.test(ausstieg), 'Ausstieg führt in den Weg ohne Gespräch')
check(pos('termineVorbei(slots)') > 0 && pos('termineVorbei(slots)') < pos('const m = `Sag mir einfach 1 oder 2'), 'kein vergangener Termin in der Nachfrage')
check(!/Kein Problem, \$\{first\(name\)/.test(bot), 'Übergabetext: Name darf nicht „ich“ ersetzen')

// ── Die Pause der Folge: nur lesend im Bot, vor jedem Versand im Sendelauf, Fehler heißt senden ──
const pauseBot = bot.slice(bot.indexOf('async function folgePauseBis('), bot.indexOf('async function handleReply('))
check(pauseBot.length > 0 && !/\.(insert|update|delete|upsert)\(/.test(pauseBot), 'folgePauseBis schreibt nichts')
check(/body\.action === 'folge_pause'/.test(bot), 'booking-bot kennt die Aktion folge_pause')
check(pauseBot.includes("booking_bot_enabled"), 'Bot aus: Folge wartet nicht')
const lauf = readFileSync(join(root, 'supabase/functions/process-scheduled-messages/index.ts'), 'utf8')
const fragen = lauf.slice(lauf.indexOf('async function folgePauseBis('), lauf.indexOf('async function logActivity('))
check(/catch \(e\)[\s\S]*return null/.test(fragen) && /AbortSignal\.timeout/.test(fragen), 'Fehler oder Hänger beim Nachfragen: nicht warten')
const lp = (s) => lauf.indexOf(s)
const pauseStelle = lp("msg.event_type === 'erstkontakt' && anKundeAuto")
check(pauseStelle > lp('if (msg.bot_nudge_stage != null) {') && lp('if (msg.bot_nudge_stage != null) {') > 0, 'Pause nach dem Bot-Zweig: Lottes eigene Nachrichten warten nicht')
check(pauseStelle > lp('const anKundeAuto ='), 'Pause nach der Ruhezeit')
check(pauseStelle < lp('await translateOutbound('), 'Pause vor Übersetzung und Versand')
const pauseBlock = lauf.slice(pauseStelle, lp('// Lead-E-Mail + Telefon für Versand laden.'))
check(/status: 'pending', scheduled_at: bis/.test(pauseBlock), 'wartende Zeile bleibt stornierbar (pending)')
check(pauseBlock.includes("msg.type !== 'email'"), 'reine Mail wartet nicht, sie stört den WhatsApp-Dialog nicht')
check(/\.eq\('id', z\.id\)\.eq\('status', 'pending'\)/.test(pauseBlock), 'spätere Stufen rücken nur mit, solange sie pending sind')

if (fails.length) {
  console.error(`verify-termin-dialog: ${fails.length} von ${checked} Prüfungen rot`)
  for (const f of fails) console.error('  -', f)
  process.exit(1)
}
console.log(`verify-termin-dialog: ${checked} Prüfungen grün`)
