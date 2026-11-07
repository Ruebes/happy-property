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

// ── Soll überhaupt ein Termin gemacht werden? (Erkan, Heiko) ──
const J2 = Date.parse('2026-11-05T09:15:20Z')
const vor = (min) => new Date(J2 - min * 60000).toISOString()
const zeile = (p) => ({ direction: 'outbound', content: 'x', auto: true, subject: 'WhatsApp: newsletter', created_at: vor(10), ...p })
const zoom = (minBis, p = {}) => ({ art: 'Zoom-Call', wann: 'Donnerstag, 5.11., 10:00 Uhr', titel: 'Erstgespräch', vorOrt: false, startIso: new Date(J2 + minBis * 60000).toISOString(), ...p })
const ktx = (p) => D.terminKontext({ zeilen: [], termine: [], text: 'Bist du eher erreichbar?', botBetreff: 'WhatsApp: Termin-Bot', jetzt: J2, ...p })

// Wer hat die geprüfte Nachricht geschrieben? Sie steht schon im Verlauf und zählt dort nicht mit.
const svenZeile = zeile({ content: ' Bist du eher erreichbar? ', auto: false, subject: 'WhatsApp gesendet', created_at: vor(0) })
const kundeZeile = zeile({ direction: 'inbound', content: 'Bist du eher erreichbar?', auto: false, subject: 'WhatsApp erhalten', created_at: vor(0) })
check(ktx({ zeilen: [svenZeile] }).von === 'sven', 'Absender Sven erkannt')
check(ktx({ zeilen: [svenZeile] }).verlauf.length === 0, 'die geprüfte Nachricht steht nicht im Verlauf')
check(ktx({ zeilen: [kundeZeile] }).von === 'kunde', 'Absender Kunde erkannt')
check(ktx({ zeilen: [] }).von === null, 'nicht gefunden: Absender unbekannt')
check(ktx({ zeilen: [zeile({ content: 'Bist du eher erreichbar?' })] }).von === null, 'automatische Nachricht ist weder Kunde noch Sven')
check(ktx({ zeilen: [kundeZeile, zeile({ content: 'Bist du eher erreichbar?', auto: false, subject: 'WhatsApp gesendet', created_at: vor(60) })] }).von === 'kunde', 'gleicher Text: die neueste zählt')
check(ktx({ zeilen: [kundeZeile, zeile({ content: 'Bist du eher erreichbar?', auto: false, subject: 'WhatsApp gesendet', created_at: vor(60) })] }).verlauf.length === 1, 'gleicher Text: nur die neueste fällt aus dem Verlauf')

// Was im Verlauf steht
const v1 = ktx({ zeilen: [
  zeile({ direction: 'inbound', content: 'Danke\n\nbis  später', auto: false, created_at: vor(1) }),
  zeile({ content: 'Dann ruf gern an', auto: false, created_at: vor(45) }),
  zeile({ content: 'Sag mir 1 oder 2', subject: 'WhatsApp: Termin-Bot', created_at: vor(180) }),
] }).verlauf
check(v1.length === 3 && v1[2] === 'KUNDE, gerade eben: Danke bis später', 'neueste zuletzt, Leerraum zusammengezogen')
check(v1[1] === 'SVEN, vor 45 Min.: Dann ruf gern an', 'Sven mit Alter')
check(v1[0] === 'LOTTE, vor 3 Std.: Sag mir 1 oder 2', 'Lotte mit Alter')
check(ktx({ zeilen: [zeile({ content: 'Neue Registrierung' })] }).verlauf.length === 0, 'andere Automatik steht nicht im Verlauf')
check(ktx({ zeilen: [zeile({ auto: false, subject: 'Intern an Sven (nicht an den Kunden)' })] }).verlauf.length === 0, 'Intern an ... steht nicht im Verlauf')
check(ktx({ zeilen: [zeile({ auto: false, subject: 'Kontakt weitergeleitet an Henning' })] }).verlauf.length === 0, 'Kontakt weitergeleitet steht nicht im Verlauf')
check(ktx({ zeilen: [zeile({ auto: false, subject: 'WhatsApp → Walter Huber' })] }).verlauf.length === 1, 'Svens Nachricht aus dem CRM zählt als Sven')
check(ktx({ zeilen: [zeile({ auto: false, content: '   ' })] }).verlauf.length === 0, 'leere Nachricht fällt weg')
check(ktx({ zeilen: [zeile({ auto: false, created_at: vor(15 * 1440) })] }).verlauf.length === 0, 'älter als 14 Tage fällt weg')
check(ktx({ zeilen: [zeile({ auto: false, created_at: 'kaputt' })] }).verlauf.length === 0, 'unlesbares Datum fällt weg')
check(ktx({ zeilen: [zeile({ auto: false, content: 'y'.repeat(900) })] }).verlauf[0].length < 330, 'lange Nachricht wird gekürzt')
const zwoelf = Array.from({ length: 12 }, (_, i) => zeile({ auto: false, content: `n${i}`, created_at: vor(i + 5) }))
const acht = ktx({ zeilen: zwoelf }).verlauf
check(acht.length === 8 && acht[7].endsWith(': n0') && acht[0].endsWith(': n7'), 'nur die letzten 8, älteste zuerst')

// Termin gleich: Heiko 45 Minuten vorher, Erkan 45 und 30 Minuten vorher
check(ktx({ termine: [zoom(45)] }).gleichTermin === true, 'Heiko: Zoom in 45 Minuten')
check(ktx({ termine: [zoom(30, { art: 'Telefonat' })] }).gleichTermin === true, 'Erkan: Telefonat in 30 Minuten')
check(ktx({ termine: [zoom(-10)] }).gleichTermin === true, 'läuft gerade')
check(ktx({ termine: [zoom(6 * 60)] }).gleichTermin === true, 'genau 6 Stunden zählen noch')
check(ktx({ termine: [zoom(6 * 60 + 1)] }).gleichTermin === false, 'danach urteilt die KI')
check(ktx({ termine: [zoom(45, { vorOrt: true })] }).gleichTermin === false, 'Rainer: Besichtigung sperrt keinen Anruf')
check(ktx({ termine: [zoom(45, { vorOrt: true }), zoom(120)] }).gleichTermin === true, 'neben der Besichtigung noch ein Zoom')
check(ktx({ termine: [zoom(45, { startIso: 'kaputt' })] }).gleichTermin === false, 'unlesbare Zeit sperrt nicht')
check(ktx({ termine: [] }).gleichTermin === false, 'kein Termin')

// Was die KI über den Termin liest
check(ktx({ termine: [zoom(45)] }).termine[0] === 'Zoom-Call, Donnerstag, 5.11., 10:00 Uhr (in 45 Min., „Erstgespräch“)', 'Terminzeile mit Abstand und Titel')
check(ktx({ termine: [zoom(-10, { titel: null })] }).termine[0] === 'Zoom-Call, Donnerstag, 5.11., 10:00 Uhr (läuft gerade)', 'laufender Termin ohne Titel')
check(ktx({ termine: [zoom(3 * 1440)] }).termine[0].includes('in 3 Tagen'), 'Termin in Tagen')
check(ktx({ termine: [zoom(5 * 60)] }).termine[0].includes('in 5 Std.'), 'Termin in Stunden')

// Der Block für die KI
const block = D.kontextBlock(ktx({ zeilen: [svenZeile, zeile({ direction: 'inbound', content: 'Moin', auto: false, created_at: vor(9) })], termine: [zoom(45)] }))
check(block.includes('stammt von SVEN'), 'Block nennt den Absender')
check(block.includes('Anstehende Termine im Kalender: Zoom-Call'), 'Block nennt den Termin')
check(block.includes('KUNDE, vor 9 Min.: Moin'), 'Block enthält den Chat')
check(/wants=false/.test(block) && /wants=true/.test(block), 'Block sagt beides')
check(block.includes('auch bei langjährigen Kunden'), 'keine Sperre für Bestandskunden')
check(block.includes('Sven selbst ein privates Treffen vorschlägt'), 'Svens Einladung zum Essen ist kein Termin für Lotte')
const leer = D.kontextBlock(ktx({}))
check(leer.includes('Termine im Kalender: keine') && leer.includes('keine Nachrichten in den letzten 14 Tagen') && leer.includes('nicht bekannt'), 'Block ohne Daten bleibt lesbar')
check(/—|–/.test(block.replace(zoom(45).titel, '')) === false, 'Block ohne Gedankenstriche')
check(/"[^"]*steht das\?"/.test(D.ABMACHUNG_REGEL) && D.ABMACHUNG_REGEL.includes('intent = content'), 'Abmachung geht an Sven')

// Eingebaut an der richtigen Stelle
const engage = bot.slice(bot.indexOf('async function handleEngage('), bot.indexOf('// ── Café-Treffen'))
check(engage.includes('!force && await terminKontextAn(admin)'), 'manueller Anstoß durch Sven braucht keinen Kontext')
check(engage.indexOf('kontext?.gleichTermin') < engage.indexOf('terminWunsch(text, kontext)'), 'Termin gleich: ohne KI raus')
const wunsch = bot.slice(bot.indexOf('async function terminWunsch('), bot.indexOf('// ── Konversations-Helfer'))
check(wunsch.includes('const nachricht = await detectApptRequest(text)\n  if (!nachricht.wants || !kontext) return nachricht\n  return await detectApptRequest(text, kontext)'), 'Der Verlauf bremst nur: ohne Ja aus der Nachricht allein bleibt es beim Nein')
check(!engage.includes('detectApptRequest(text, kontext)'), 'handleEngage fragt nur über terminWunsch')
check(bot.includes("detect: await terminWunsch(body.text ?? '', body.kontext ?? null)"), 'Der Test nimmt denselben Weg wie der Betrieb')
check(bot.includes("await terminKontextLesen(admin, body.lead_id, body.text ?? '')"), 'kontext_test liest die Lage wie der Betrieb')
check(engage.indexOf("skipped: 'active_conversation'") < engage.indexOf('terminKontextAn(admin)'), 'Kontext erst nach den Sperren lesen')
check(/kontext\?\.gleichTermin\) \{[\s\S]{0,140}return await handleAnswer\(admin, leadId, text\)/.test(engage), 'Termin gleich: Nachricht läuft wie jede andere ohne Terminwunsch weiter')
const schalter = bot.slice(bot.indexOf('async function terminKontextAn('), bot.indexOf('// Chat und anstehende Termine'))
check(schalter.includes("=== 'true'"), 'Schalter nur mit true an, das Einspielen allein ändert nichts')
const lesen = bot.slice(bot.indexOf('async function terminKontextLesen('), bot.indexOf('// ── ENGAGE ──'))
check(lesen.includes(".eq('internal', false)") && lesen.includes(".is('cancel_reported_at', null)") && lesen.includes(".gt('end_time'"), 'nur echte, offene, nicht abgesagte Termine')
check(/catch \(e\)[^\n]*return null/.test(lesen), 'Lesefehler: KI urteilt wie bisher')
check(bot.includes('await detectApptRequest(text)\n  if (!(det.wants && det.onsite && det.casual))'), 'unbekannte Nummer bleibt ohne Kontext')
check(bot.includes("DIALOG_HINWEIS[stand], await terminKontextAn(admin))"), 'Termin-Dialog liest die Abmachungs-Regel nur mit Schalter')
check(bot.includes('${abmachung ? `\n${ABMACHUNG_REGEL}` : \'\'}\nWICHTIG zum TERMIN-VORRANG'), 'Abmachung steht vor dem Termin-Vorrang')

if (fails.length) {
  console.error(`verify-termin-dialog: ${fails.length} von ${checked} Prüfungen rot`)
  for (const f of fails) console.error('  -', f)
  process.exit(1)
}
console.log(`verify-termin-dialog: ${checked} Prüfungen grün`)
