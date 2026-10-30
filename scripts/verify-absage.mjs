// Tests der Absage-Erkennung (Eva Hahn, 29.10.2026).
//
// Offline: Vorfilter und Texte aus supabase/functions/_shared/terminAbsage.ts
// (echte Absagen und Verschiebe-Wünsche muss der Vorfilter durchlassen, Smalltalk
// nicht; Lotte- und Bauträger-Texte ohne Gedankenstriche, mit echten Umlauten).
// Live (--live): dieselben Fälle gegen die KI über die seiteneffektfreie Action
// booking-bot absage_test (kein Senden, kein DB-Write). Braucht
// SUPABASE_SERVICE_ROLE_KEY (Umgebung oder ~/Downloads/happy-property/.env).
//
// Ausführen:
//   node scripts/verify-absage.mjs
//   node scripts/verify-absage.mjs --live

import { execSync } from 'child_process'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'hpabsage-'))
const out = join(dir, 'terminAbsage.mjs')
execSync(`npx --yes esbuild ${JSON.stringify(join(root, 'supabase/functions/_shared/terminAbsage.ts'))} --bundle --format=esm --platform=neutral --outfile=${JSON.stringify(out)} --log-level=warning`, { stdio: 'pipe', cwd: root })
const A = await import(out)

const fails = []
let checked = 0
const check = (ok, msg) => { checked++; if (!ok) fails.push(msg) }

// ── Fälle: Text, erwartete KI-Einordnung, muss der Vorfilter anschlagen? ──────
// art: welche Einordnung richtig ist (bei echten Grenzfällen beide Absage-Arten).
const FAELLE = [
  // Echte Absagen
  { text: 'Ich möchte den Termin absagen', art: ['absage'], filter: true },
  { text: 'Hallo Sven, leider muss ich den Termin morgen absagen, mir ist etwas dazwischengekommen.', art: ['absage'], filter: true },
  { text: 'Ich schaffe es morgen leider nicht.', art: ['absage', 'verschieben'], filter: true },
  { text: 'Wir haben uns anders entschieden und möchten den Termin stornieren.', art: ['absage'], filter: true },
  { text: 'Ich sage den Termin lieber ab, sorry!', art: ['absage'], filter: true },
  { text: 'Sorry, I have to cancel our meeting tomorrow.', art: ['absage'], filter: true },
  // Verschieben (keine Absage, aber Termin markieren und neue Zeiten anbieten)
  { text: 'Kann ich den Termin verschieben?', art: ['verschieben'], filter: true },
  { text: 'Können wir den Termin auf nächste Woche Dienstag legen?', art: ['verschieben'], filter: true },
  { text: 'Passt mir am Donnerstag doch nicht, geht auch Freitag Nachmittag?', art: ['verschieben'], filter: true },
  { text: 'Can we reschedule to next week?', art: ['verschieben'], filter: true },
  // Keine Absage: der Termin bleibt
  { text: 'Ich komme etwas später', art: ['keine'], filter: true },
  { text: 'Bin 10 Minuten später da, stehe noch im Stau', art: ['keine'], filter: true },
  { text: 'Ich kann leider nicht ganz pünktlich sein, komme 15 Minuten später.', art: ['keine'], filter: true },
  { text: 'Kann ich nicht einfach per Zoom statt Telefon?', art: ['keine'], filter: true },
  { text: 'Passt, bis morgen!', art: ['keine'], filter: false },
  { text: 'Wo genau treffen wir uns morgen?', art: ['keine'], filter: false },
  { text: 'Danke, ich freue mich schon!', art: ['keine'], filter: false },
  { text: 'ok', art: ['keine'], filter: false },
]

for (const f of FAELLE) {
  check(A.koennteAbsageSein(f.text) === f.filter, `Vorfilter "${f.text}": erwartet ${f.filter}`)
}
// Jede echte Absage oder Verschiebung MUSS den Vorfilter passieren, sonst sieht die KI sie nie.
for (const f of FAELLE.filter(x => !x.art.includes('keine'))) {
  check(A.koennteAbsageSein(f.text), `Absage verpasst der Vorfilter: "${f.text}"`)
}

// ── Zeit-Label und Zone ────────────────────────────────────────────────────────
check(A.terminZone(null, 'inperson') === 'Asia/Nicosia', 'vor Ort ohne Zone = Zypern')
check(A.terminZone(null, 'zoom') === 'Europe/Berlin', 'Zoom ohne Zone = deutsche Zeit')
check(A.terminZone('Asia/Nicosia', 'phone') === 'Asia/Nicosia', 'gesetzte Zone gewinnt')
const evaStart = '2026-10-29T12:30:00Z'   // Evas Besichtigung, 14:30 Zypern
check(A.terminLabel(evaStart, 'Asia/Nicosia') === 'Donnerstag, 29.10., 14:30 Uhr', `Label Zypern: ${A.terminLabel(evaStart, 'Asia/Nicosia')}`)
check(A.terminLabel(evaStart, 'Europe/Berlin') === 'Donnerstag, 29.10., 13:30 Uhr', `Label Berlin: ${A.terminLabel(evaStart, 'Europe/Berlin')}`)
check(A.terminLabel(evaStart, 'Asia/Nicosia', 'en').includes('Thursday'), `Label englisch: ${A.terminLabel(evaStart, 'Asia/Nicosia', 'en')}`)

// ── Texte: keine Gedankenstriche, echte Umlaute, Namen drin ───────────────────
const wann = A.terminLabel(evaStart, 'Asia/Nicosia')
const texte = [
  A.lotteAbsageText('Eva', wann),
  A.lotteAbsageText('', wann),
  A.lotteVerschiebenIntro('Eva', wann),
  A.lotteVerschiebenSven('Eva', wann),
  ...['absage', 'verschieben'].flatMap(art => ['de', 'en'].map(lang =>
    A.bautraegerAbsageText({ lang, vorname: 'Aaron', kunde: 'Eva Hahn', wann: A.terminLabel(evaStart, 'Asia/Nicosia', lang), art }))),
]
for (const t of texte) {
  check(!/[—–]/.test(t), `Gedankenstrich im Text: ${t}`)
  check(!/fuer|moecht|koenn|gruess|grues|waere|naechst|umstaende|traeger|muess/i.test(t), `Umlaut-Ersatz im Text: ${t}`)
}
check(A.lotteAbsageText('Eva', wann).includes(', Eva,'), 'Absage-Text mit Namen')
check(!A.lotteAbsageText('', wann).includes(', ,'), 'Absage-Text ohne Namen sauber')
check(A.bautraegerAbsageText({ lang: 'de', vorname: 'Aaron', kunde: 'Eva Hahn', wann, art: 'absage' }).startsWith('Hallo Aaron, kurze Info: Eva Hahn hat unseren Termin am Donnerstag, 29.10., 14:30 Uhr abgesagt.'), 'Bauträger-Text DE')

// ── wa.me-Link ─────────────────────────────────────────────────────────────────
const link = A.waMeLink('+357 99 123456', 'Hallo Aaron, ä?&')
check(link === `https://wa.me/35799123456?text=${encodeURIComponent('Hallo Aaron, ä?&')}`, `wa.me-Link: ${link}`)
check(A.waMeLink('0035799123456', 'x')?.startsWith('https://wa.me/35799123456?'), 'wa.me ohne 00')
check(A.waMeLink('', 'x') === null && A.waMeLink('123', 'x') === null, 'wa.me ohne Nummer = null')

// ── Live: KI-Einordnung über booking-bot absage_test ──────────────────────────
if (process.argv.includes('--live')) {
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const envFile = join(homedir(), 'Downloads/happy-property/.env')
  if (!key && existsSync(envFile)) key = (readFileSync(envFile, 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/m)?.[1] ?? '').replace(/^"|"$/g, '').trim()
  if (!key) { console.error('SUPABASE_SERVICE_ROLE_KEY fehlt'); process.exit(2) }
  const url = 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/booking-bot'
  for (const f of FAELLE) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'absage_test', text: f.text }) })
    const j = await r.json().catch(() => null)
    const art = j?.erkennung?.art ?? `FEHLER ${r.status}`
    check(f.art.includes(art), `KI "${f.text}": ${art}, erwartet ${f.art.join(' oder ')}`)
    console.log(`${f.art.includes(art) ? 'ok  ' : 'FAIL'} ${art.padEnd(11)} ${f.text}${j?.erkennung && art === 'verschieben' ? `  ${JSON.stringify(Object.fromEntries(Object.entries(j.erkennung).filter(([k, v]) => k !== 'art' && v)))}` : ''}`)
  }
}

if (fails.length) {
  console.error(`\n${fails.length} von ${checked} Prüfungen fehlgeschlagen:`)
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`\nAlle ${checked} Prüfungen bestanden.`)
