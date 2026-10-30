// Tests der festen Antwortregeln und der Antwortsprache für Lotte (Sven, 30.10.2026).
//
// Offline: Vorfilter, Namensschutz, Verlauf, Kandidaten und Texte aus
// supabase/functions/_shared/lotteRegeln.ts (Texte ohne Gedankenstriche, mit echten
// Umlauten, ohne Rendite-Zahlen, ohne Namen vor der Registrierung), dazu die
// Spracherkennung aus supabase/functions/_shared/kundenSprache.ts.
// Live (--live): dieselben Fälle gegen die KI über die seiteneffektfreien Actions
// booking-bot regel_test und sprache_test (kein Senden, kein DB-Write). Braucht
// SUPABASE_SERVICE_ROLE_KEY (Umgebung oder ~/Downloads/happy-property/.env).
//
// Ausführen:
//   node scripts/verify-lotte-regeln.mjs
//   node scripts/verify-lotte-regeln.mjs --live

import { execSync } from 'child_process'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'hplotte-'))
const out = join(dir, 'lotteRegeln.mjs')
execSync(`npx --yes esbuild ${JSON.stringify(join(root, 'supabase/functions/_shared/lotteRegeln.ts'))} --bundle --format=esm --platform=neutral --outfile=${JSON.stringify(out)} --log-level=warning`, { stdio: 'pipe', cwd: root })
const L = await import(out)
const outS = join(dir, 'kundenSprache.mjs')
execSync(`npx --yes esbuild ${JSON.stringify(join(root, 'supabase/functions/_shared/kundenSprache.ts'))} --bundle --format=esm --platform=neutral --outfile=${JSON.stringify(outS)} --log-level=warning`, { stdio: 'pipe', cwd: root })
const S = await import(outS)

const fails = []
let checked = 0
const check = (ok, msg) => { checked++; if (!ok) fails.push(msg) }

// ── Fälle: Text, erwartete KI-Regel, muss der Vorfilter diese Regel anbieten? ──
const FAELLE = [
  { text: 'Hallo Sven, bitte stellen Sie uns eine Liste der Investitionsmöglichkeiten zu, oder teilen Sie uns einen Link mit.', regel: 'angebot' },
  { text: 'Habt ihr noch andere Objekte im Angebot?', regel: 'angebot' },
  { text: 'Kannst du mir ein paar Exposés schicken?', regel: 'angebot' },
  { text: 'Wir suchen in Peyia, habt ihr da was?', regel: 'angebot' },
  { text: 'Wer ist der Bauträger?', regel: 'bautraeger' },
  { text: 'Hallo Sven, danke für die Infos!\nIch wohne zwar in D bin aber aus Pafos und kenne den Immobilienmarkt relativ gut. Wer ist der Bauträger?', regel: 'bautraeger' },
  { text: 'Wie heißt die Anlage eigentlich?', regel: 'bautraeger' },
  { text: 'Hallo Sven, \nIch werde doch eher in der Region Protaras suchen.\nViele Grüße \nArne', regel: 'region', region: 'protaras' },
  { text: 'Wir überlegen, doch lieber in Limassol zu kaufen.', regel: 'region', region: 'limassol' },
  { text: 'Was bekomme ich als Tippgeber, wenn ich dir jemanden empfehle?', regel: 'geld' },
  { text: 'Gibt es bei der Wohnung noch Nachlass?', regel: 'geld' },
  { text: 'Wie hoch ist eure Provision?', regel: 'geld' },
  // Englisch (Fulya, 29./30.10.): dieselben Regeln, Lotte antwortet dann auf Englisch
  { text: 'Can you send me a list of your investment opportunities?', regel: 'angebot' },
  { text: 'Do you have other properties in Peyia?', regel: 'angebot' },
  { text: 'Who is the developer of this project?', regel: 'bautraeger' },
  { text: 'We are rather looking in Protaras, prices are lower there.', regel: 'region', region: 'protaras' },
  { text: 'Is there any discount if we buy two apartments?', regel: 'geld' },
  { text: 'Is it under construction or only in planning?', regel: 'keine' },
  { text: 'Thanks, sounds good!', regel: 'keine', filter: false },
  // Normaler Weg (keine feste Regel)
  { text: 'Was kostet die Wohnung A105?', regel: 'keine' },
  { text: 'Wie weit ist es zum Meer?', regel: 'keine' },
  { text: 'Kannst du mir den Grundriss der Wohnung B305 schicken?', regel: 'keine' },
  { text: 'Mein Budget liegt bei 300.000 €.', regel: 'keine' },
  { text: 'Danke dir, bis morgen!', regel: 'keine', filter: false },
  { text: 'Super, passt!', regel: 'keine', filter: false },
  { text: 'ok', regel: 'keine', filter: false },
]

for (const f of FAELLE) {
  const v = L.regelVorfilter(f.text)
  if (f.regel !== 'keine') check(v.includes(f.regel), `Vorfilter verpasst ${f.regel}: "${f.text}" (hat ${JSON.stringify(v)})`)
  if (f.filter === false) check(v.length === 0, `Vorfilter schlägt an, sollte nicht: "${f.text}" (${JSON.stringify(v)})`)
}

// ── Textregeln für alles, was Lotte schreibt ──────────────────────────────────
const STRICH = /[—–]|[\p{L}\p{N}] - [\p{L}\p{N}]/u
const RENDITE = /rendite|wertsteigerung|mieteinnahm|\+\s?\d+\s?%/i
const UMSCHRIEBEN = /\b(fuer|ueber|koennen|moechte|gruesse|naechste|waehl|haelt|groess)\w*/i
const sauber = (t, wo) => {
  check(!STRICH.test(t), `Gedankenstrich in ${wo}: ${t}`)
  check(!RENDITE.test(t), `Rendite-Thema in ${wo}: ${t}`)
  check(!UMSCHRIEBEN.test(t), `Umlaut umschrieben in ${wo}: ${t}`)
  check(t.length <= 1000, `${wo} zu lang (${t.length} Zeichen)`)
}

// ── Datum, Preis ──────────────────────────────────────────────────────────────
check(L.datumLabel('2026-10-06T12:43:25Z') === '6.10.', `datumLabel: ${L.datumLabel('2026-10-06T12:43:25Z')}`)
check(L.datumLabel('2026-10-22T23:30:00Z') === '23.10.', 'datumLabel rechnet in deutscher Zeit')
check(L.datumsListe(['2026-10-06T12:00:00Z', '2026-10-22T20:00:00Z']) === 'am 6.10. und am 22.10.', `datumsListe 2: ${L.datumsListe(['2026-10-06T12:00:00Z', '2026-10-22T20:00:00Z'])}`)
check(L.datumsListe(['2026-10-06T12:00:00Z', '2026-10-15T12:00:00Z', '2026-10-22T12:00:00Z']) === 'am 6.10., am 15.10. und am 22.10.', 'datumsListe 3')
check(L.datumsListe(['2026-10-06T08:00:00Z', '2026-10-06T12:00:00Z']) === 'am 6.10.', 'datumsListe: gleicher Tag nur einmal')
check(L.preisLabel(414625) === 'ab 414.625 € netto', `preisLabel: ${L.preisLabel(414625)}`)
check(L.preisLabel(150000) === 'ab 150.000 € netto', 'preisLabel rund')

// ── Namen ─────────────────────────────────────────────────────────────────────
check(L.bautraegerAnzeige('EMMETRE LTD') === 'EMMETRE', 'bautraegerAnzeige LTD weg')
check(L.bautraegerAnzeige('Kuutio Homes') === 'Kuutio Homes', 'bautraegerAnzeige behält Homes')
check(L.istRegistriert('EMMETRE LTD', ['EMMETRE LTD']), 'registriert exakt')
check(L.istRegistriert('EMMETRE LTD', ['emmetre']), 'registriert ohne Rechtsform, klein')
check(L.istRegistriert('Kuutio Homes', ['kuutio homes']), 'registriert Kuutio')
check(!L.istRegistriert('Kuutio Homes', ['Luma', 'Mito']), 'nicht registriert')
check(!L.istRegistriert(null, ['Luma']), 'ohne Bauträger nie registriert')
const flora = L.namensTeile('Flora Panorama')
check(flora.includes('Flora Panorama') && flora.includes('Flora'), `namensTeile Flora: ${flora}`)
check(!L.namensTeile('Roble Park - Kato Paphos').some(t => /paphos/i.test(t) && t !== 'Roble Park - Kato Paphos'), 'Ortszusatz ist kein Name')
check(!L.namensTeile('The Cove').includes('The'), 'Allgemeines Wort ist kein Name')
check(L.bautraegerTeile('Kuutio Homes').includes('Kuutio'), 'bautraegerTeile Kuutio')
check(!L.bautraegerTeile('Motive Point').includes('Motive'), 'bautraegerTeile Motive Point bleibt ganz')
check(L.bautraegerTeile('EMMETRE LTD').includes('EMMETRE'), 'bautraegerTeile EMMETRE')
const geheim = [...L.namensTeile('Flora Panorama'), ...L.bautraegerTeile('EMMETRE LTD')]
check(L.enthaeltNamen('Die Wohnungen in Flora sind fast fertig.', geheim), 'enthaeltNamen Flora')
check(L.enthaeltNamen('Gebaut wird von Emmetre.', geheim), 'enthaeltNamen Bauträger klein')
check(!L.enthaeltNamen('Florales Muster, Panoramablick', geheim), 'enthaeltNamen nur ganze Wörter')
const inf = L.namensTeile('Infinity')
check(!L.enthaeltNamen('Mit Infinity-Pool auf dem Dach', inf) && !L.enthaeltNamen('mit Infinity Pool', inf), 'Infinity-Pool ist kein Projektname')
check(L.enthaeltNamen('Infinity liegt im Zentrum', inf), 'Infinity als Name erkannt')
check(L.namenErsetzen('Flora Panorama liegt in Chlorakas, Flora hat einen Pool.', geheim, 'Der Neubau') === 'Der Neubau liegt in Chlorakas, Der Neubau hat einen Pool.', 'namenErsetzen')
check(!L.enthaeltNamen('https://maps.app.goo.gl/f9ebVepVSmxK6vJu5', geheim), 'Kurzlink ohne Namen')
check(L.enthaeltNamen('https://www.google.com/maps/search/?api=1&query=Genesis%2034', L.namensTeile('Genesis')), 'Maps-Link mit Namen erkannt')

check(L.lageLabel('Chlorakas', 'Paphos') === 'in Chlorakas bei Paphos', `lageLabel Flora: ${L.lageLabel('Chlorakas', 'Paphos')}`)
check(L.lageLabel('Paphos', 'Geroskipou') === 'in Geroskipou bei Paphos', 'lageLabel Bezirk')
check(L.lageLabel('Kato Paphos, Zypern', 'Kato Paphos') === 'in Kato Paphos', 'lageLabel Kato Paphos')
check(L.lageLabel('113 Evagora Pallikaridi Avenue, 8010 Paphos, Zypern', null) === 'in Paphos', 'lageLabel Adresse')
check(L.lageLabel('https://maps.app.goo.gl/uY6f4vwXunzfVqUC7', null) === 'in Paphos', 'lageLabel Link')
check(L.lageLabel('34.76631, 32.44856', null) === 'in Paphos', 'lageLabel Koordinaten')
check(L.lageLabel('Universitätsviertel Paphos, Zypern', null) === 'im Universitätsviertel Paphos', 'lageLabel Viertel')
check(L.objektTyp(['apartment', 'studio']) === 'Neubau mit Wohnungen', 'objektTyp Wohnungen')
check(L.objektTyp(['villa']) === 'Villenprojekt', 'objektTyp Villen')
check(L.objektTyp(['apartment', 'villa', 'townhouse']) === 'Neubau mit Wohnungen und Villen', 'objektTyp gemischt')
check(L.objektTyp([]) === 'Neubau mit Wohnungen', 'objektTyp leer')

// ── Regel 1: Verlauf und Angebotstext ─────────────────────────────────────────
const decks = [
  { token: 'aaa', project_id: 'p1', created_at: '2026-10-06T12:40:00Z' },
  { token: 'bbb', project_id: 'p2', created_at: '2026-10-06T12:41:00Z' },
  { token: 'ccc', project_id: 'p3', created_at: '2026-10-22T20:20:00Z' },
  { token: 'ddd', project_id: 'p4', created_at: '2026-10-28T19:03:00Z' },   // nur per WhatsApp/Mail-Text verschickt
  { token: 'eee', project_id: 'p5', created_at: '2026-10-29T09:00:00Z' },   // nur erzeugt, nie verschickt
]
const outbox = [
  { status: 'sent', sent_at: '2026-10-06T12:43:25Z', email_sent_at: '2026-10-06T12:43:25Z', whatsapp_sent_at: null, deck_tokens: ['aaa', 'bbb'] },
  { status: 'sent', sent_at: '2026-10-22T20:27:29Z', email_sent_at: '2026-10-22T20:27:29Z', whatsapp_sent_at: null, deck_tokens: ['ccc'] },
  { status: 'cancelled', sent_at: null, email_sent_at: null, whatsapp_sent_at: null, deck_tokens: ['eee'] },
]
const versand = [
  { type: 'email', created_at: '2026-10-28T19:03:53Z', content: 'Hallo Arne, hier sind ... https://portal.happy-property.com/deck/ddd' },
  { type: 'whatsapp', created_at: '2026-10-28T19:03:56Z', content: 'Hallo Arne ... https://portal.happy-property.com/deck/ddd' },
]
const ungesehen = L.sendungenBauen(decks, outbox, [], versand)
check(ungesehen.length === 3, `sendungenBauen: 3 Sendungen erwartet, ${ungesehen.length}`)
check(!ungesehen.some(s => s.tokens.includes('eee')), 'nie verschicktes Deck zählt nicht')
check(ungesehen[2]?.mail && ungesehen[2]?.whatsapp, 'Kanal aus Mail und WhatsApp erkannt')
const tMarkus = L.lotteAngebotText('Markus', ungesehen.slice(0, 2))
sauber(tMarkus, 'Angebotstext')
check(tMarkus.includes('am 6.10. und am 22.10.'), `Angebotstext ohne Daten: ${tMarkus}`)
check(tMarkus.includes('per Mail'), 'Angebotstext ohne Kanal')
check(tMarkus.includes('Spam-Ordner'), 'Spam-Hinweis fehlt bei ungeöffneter Mail')
check(tMarkus.includes('über 200 Einheiten') && tMarkus.includes('taggenau'), 'Kernsatz 200 Einheiten fehlt')
check(/Budget/.test(tMarkus) && /Lage/.test(tMarkus), 'Frage nach Suchprofil und Budget fehlt')
check(tMarkus.startsWith('Gern, Markus!'), 'Anrede')
const gesehen = L.sendungenBauen(decks, outbox, [{ token: 'ccc', occurred_at: '2026-10-23T08:00:00Z' }], versand)
check(gesehen.find(s => s.tokens.includes('ccc'))?.geoeffnet === true, 'geöffnet erkannt')
check(!L.lotteAngebotText('Markus', gesehen.slice(0, 2)).includes('Spam'), 'kein Spam-Hinweis, wenn etwas geöffnet wurde')
const nurWa = L.sendungenBauen([{ token: 'w1', project_id: 'p1', created_at: '2026-10-20T10:00:00Z' }], [], [], [{ type: 'whatsapp', created_at: '2026-10-20T10:01:00Z', content: '/deck/w1' }])
check(!L.lotteAngebotText('X', nurWa).includes('Spam'), 'kein Spam-Hinweis bei reiner WhatsApp')
const ohne = L.lotteAngebotText('', [])
sauber(ohne, 'Angebotstext ohne Verlauf')
check(ohne.startsWith('Gern! 🙂') && !ohne.includes('angekommen'), `Angebotstext ohne Verlauf: ${ohne}`)

const frei = [
  { id: 'p1', name: 'Gesendet A', bautraeger: 'Luma', ort: 'in Paphos', ab: 235000, frei: 5, typen: ['apartment'] },
  { id: 'p3', name: 'Gesendet B', bautraeger: 'Mito', ort: 'in Paphos', ab: 300000, frei: 5, typen: ['apartment'] },
  { id: 'k1', name: 'Nah', bautraeger: 'Medousa', ort: 'in Geroskipou bei Paphos', ab: 260000, frei: 3, typen: ['apartment'] },
  { id: 'k2', name: 'Grato Homes 2 - Sea Caves/Pegia', bautraeger: 'Olias Homes', ort: 'in Paphos', ab: 1300000, frei: 7, typen: ['villa'] },
  { id: 'k3', name: 'Grato Homes 2 - Sea Caves-Pegia', bautraeger: 'Olias Homes', ort: 'in Paphos', ab: 1300000, frei: 3, typen: ['villa'] },
  { id: 'k4', name: 'Mittel', bautraeger: 'Kuutio Homes', ort: 'in Paphos', ab: 290000, frei: 2, typen: ['apartment'] },
  { id: 'k5', name: 'Villa nah', bautraeger: 'Pafilia', ort: 'in Paphos', ab: 280000, frei: 2, typen: ['villa'] },
]
const kand = L.kandidatenWaehlen(frei, frei.filter(p => ['p1', 'p3'].includes(p.id)))
check(kand.length === 3, `kandidatenWaehlen: 3 erwartet, ${kand.length}`)
check(!kand.some(k => ['p1', 'p3'].includes(k.id)), 'schon Verschicktes ist kein Kandidat')
check(kand[0]?.id === 'k1' || kand[0]?.id === 'k4', `nächster Preis zuerst: ${kand.map(k => k.name)}`)
check(kand.findIndex(k => k.id === 'k5') === 2, `gleicher Objekttyp bevorzugt: ${kand.map(k => k.name)}`)
const gleicherDev = [
  { id: 'o1', name: 'O1', bautraeger: 'Olias Homes', ort: 'in Paphos', ab: 300000, frei: 1, typen: ['apartment'] },
  { id: 'o2', name: 'O2', bautraeger: 'Olias Homes', ort: 'in Paphos', ab: 301000, frei: 1, typen: ['apartment'] },
  { id: 'm1', name: 'M1', bautraeger: 'Mito', ort: 'in Paphos', ab: 420000, frei: 1, typen: ['apartment'] },
  { id: 'l1', name: 'L1', bautraeger: 'Luma', ort: 'in Paphos', ab: 480000, frei: 1, typen: ['apartment'] },
]
const bezug = [{ id: 'g', name: 'G', bautraeger: 'X', ort: '', ab: 300000, frei: 1, typen: ['apartment'] }]
const vielfalt = L.kandidatenWaehlen(gleicherDev, bezug)
check(vielfalt.filter(k => k.bautraeger === 'Olias Homes').length === 1, `höchstens ein Projekt je Bauträger: ${vielfalt.map(k => k.name)}`)
check(L.kandidatenWaehlen(gleicherDev, bezug, 1, ['Mito'])[0]?.id === 'm1' || L.kandidatenWaehlen(gleicherDev, bezug, 1, ['Mito'])[0]?.id === 'o1', 'Bonus für Registrierung greift nur maßvoll')
check(L.kandidatenWaehlen(gleicherDev, [{ ...bezug[0], ab: 400000 }], 1, ['Mito'])[0]?.id === 'm1', 'registrierter Bauträger bei ähnlichem Preis bevorzugt')
const ohneBezug = L.kandidatenWaehlen(frei, [])
check(new Set(ohneBezug.map(k => k.name.replace(/[^a-z]/gi, '').toLowerCase())).size === ohneBezug.length, 'doppelte Projektnamen entfernt')
const nA = L.angebotNotiz('Bitte eine Liste', ungesehen, { aaa: 'Azure Living', bbb: 'Emerald Park', ccc: 'BAIA', ddd: 'Flora Panorama' }, kand, ['Medousa'])
check(nA.includes('Azure Living, Emerald Park') && nA.includes('nicht geöffnet') && nA.includes('ab 260.000 € netto') && nA.includes('registriert'), `angebotNotiz: ${nA}`)
check(!STRICH.test(nA), 'Gedankenstrich in angebotNotiz')

// ── Regel 2: Bauträger ────────────────────────────────────────────────────────
const fp = { name: 'Flora Panorama', bautraeger: 'EMMETRE LTD', lage: 'in Chlorakas bei Paphos', typ: 'Neubau mit Wohnungen' }
const tHelen = L.lotteBautraegerText('Helen', [{ ...fp, registriert: true }])
sauber(tHelen, 'Bauträgertext registriert')
check(tHelen.includes('EMMETRE') && !tHelen.includes('LTD'), `Bauträger EMMETRE fehlt: ${tHelen}`)
check(tHelen.includes('Aaron') && tHelen.includes('Zoom') && tHelen.includes('Deutscher'), 'Aaron und Zoom fehlen')
check(L.bautraegerBetreff([{ ...fp, registriert: true }]).includes('Zoom mit Aaron'), 'Betreff mit Zoom')
const tZu = L.lotteBautraegerText('Helen', [{ ...fp, registriert: false }])
sauber(tZu, 'Bauträgertext nicht registriert')
check(!L.enthaeltNamen(tZu, [...L.namensTeile(fp.name), ...L.bautraegerTeile(fp.bautraeger)]) && !tZu.includes('Aaron'), `Name vor der Registrierung: ${tZu}`)
check(tZu.includes('Neubau mit Wohnungen in Chlorakas bei Paphos'), `Lage und Typ fehlen: ${tZu}`)
const nZu = L.bautraegerNotiz('Wer ist der Bauträger?', [{ ...fp, registriert: false }])
check(nZu.includes('Erst registrieren'), 'Notiz ohne Registrierungs-Hinweis')
const lofos = { name: 'Lofos', bautraeger: 'Pafilia', lage: 'in Paphos', typ: 'Neubau mit Wohnungen und Villen', registriert: true }
const tPaf = L.lotteBautraegerText('Markus', [lofos])
sauber(tPaf, 'Bauträgertext Pafilia')
check(tPaf.includes('Pafilia') && !tPaf.includes('Aaron'), `Pafilia: ${tPaf}`)
const tMix = L.lotteBautraegerText('Markus', [lofos, { ...fp, registriert: false }])
sauber(tMix, 'Bauträgertext gemischt')
check(tMix.includes('Pafilia') && !/flora|emmetre|aaron/i.test(tMix) && tMix.includes('Chlorakas'), `gemischt: ${tMix}`)
const tMehr = L.lotteBautraegerText('', [{ ...fp, registriert: false }, { ...lofos, registriert: false }])
sauber(tMehr, 'Bauträgertext zwei ohne Registrierung')
check(!/lofos|pafilia|flora|emmetre/i.test(tMehr), `zwei ohne Registrierung: ${tMehr}`)
const tZwei = L.lotteBautraegerText('Markus', [lofos, { ...fp, registriert: true }])
check(tZwei.includes('bei Flora Panorama ist es EMMETRE') && tZwei.includes('Aaron'), `zwei registriert: ${tZwei}`)

// ── Regel 3: Region ───────────────────────────────────────────────────────────
const F = L.REGION_FAKTEN_START
check(L.regionFaktenLesen('kaputt') === F && L.regionFaktenLesen(null) === F, 'regionFaktenLesen fällt auf Startwerte zurück')
const eigene = { ...F, stand: '27.11.2026', paphos: { auslastung: 70, saison: 70 } }
check(L.regionFaktenLesen(JSON.stringify(eigene)).stand === '27.11.2026', 'regionFaktenLesen liest crm_settings')
const tArne = L.lotteRegionText('Arne', 'Protaras', F)
sauber(tArne, 'Regionstext Protaras')
check(tArne.includes('Protaras ist beim Kaufpreis oft günstiger') && tArne.includes('69 %') && tArne.includes('61 %') && tArne.includes('AirDNA') && tArne.includes('27.10.2026'), `Protaras-Zahlen fehlen: ${tArne}`)
check(tArne.includes('eigenen Flughafen') && /\?$/.test(tArne.trim()), 'Flughafen oder offene Frage fehlt')
check(!/viel erfolg|alles gute|schade/i.test(tArne), 'Regionstext verabschiedet sich')
check(L.lotteRegionText('Arne', 'Region Protaras', F).includes('61 %'), 'Region aus längerem Text erkannt')
const tLim = L.lotteRegionText('', 'Limassol', F)
sauber(tLim, 'Regionstext Limassol')
check(tLim.includes('Limassol hat natürlich auch seinen Reiz') && !tLim.includes('günstiger') && tLim.includes('69 %'), `Limassol: ${tLim}`)
const tNull = L.lotteRegionText('Eva', null, F)
sauber(tNull, 'Regionstext ohne Region')
check(!tNull.includes('null') && !tNull.includes('undefined'), `ohne Region: ${tNull}`)
check(L.regionNotiz('x', 'Protaras', F).includes('Protaras'), 'regionNotiz')

// ── Regel 4: Geld ─────────────────────────────────────────────────────────────
check(L.geldMitZahl('Als Tippgeber bekommst du 1.000 €.'), 'geldMitZahl Tippgeber Betrag')
check(L.geldMitZahl('Es gibt 5 % Nachlass.'), 'geldMitZahl Nachlass Prozent')
check(!L.geldMitZahl('Zu Rabatten meldet sich Sven persönlich bei dir.'), 'geldMitZahl ohne Zahl ok')
check(!L.geldMitZahl('Die Wohnung hat 2 Schlafzimmer.'), 'geldMitZahl ohne Geldwort ok')
check(L.geldNotiz('Gibt es Nachlass?', false).includes('nichts geschrieben'), 'geldNotiz')

// ── Preise aus dem CRM (Sven 30.10.: nur, was sicher aus dem CRM kommt) ───────
const EINH = [
  { nummer: 'B305', typ: 'apartment', schlafzimmer: 2, flaeche: 88.5, preis: 245000 },
  { nummer: 'A105', typ: 'apartment', schlafzimmer: 1, flaeche: 52, preis: 150000 },
  { nummer: 'V2', typ: 'villa', schlafzimmer: 0, flaeche: null, preis: 590000.4 },
]
const liste = L.preisListe(EINH)
sauber(liste, 'Preisliste')
check(liste.split('\n')[0].includes('ab 150.000 € netto') && liste.includes('3 Wohnungen frei'), `Preisliste Kopf: ${liste}`)
check(liste.indexOf('A105') < liste.indexOf('B305') && liste.indexOf('B305') < liste.indexOf('V2'), 'Preisliste günstigste zuerst')
check(liste.includes('A105: Wohnung, 1 Schlafzimmer, 52 m², 150.000 € netto'), `Preiszeile A105: ${liste}`)
check(liste.includes('B305: Wohnung, 2 Schlafzimmer, 88,5 m², 245.000 € netto'), `Preiszeile B305: ${liste}`)
check(liste.includes('V2: Villa, 590.000 € netto'), `Villa ohne Schlafzimmerangabe: ${liste}`)
check(L.preisListe([]).includes('keine Wohnung als frei'), 'Preisliste leer')
check(L.preisListe(EINH, 2).includes('(und 1 weitere, alle teurer)') && !L.preisListe(EINH, 2).includes('V2'), 'Preisliste gekürzt')

const crm = L.betraegeIn(liste)
check(JSON.stringify(crm) === '["150000","150000","245000","590000"]', `Beträge der Preisliste: ${JSON.stringify(crm)}`)
check(JSON.stringify(L.zahlenIn('Reservierung 5.000, Rest 30 %').filter(z => z.length >= 4)) === '["5000"]', 'Zahlungsplan-Beträge ab 1.000')
const FULYA_DE = 'Die kleineren Wohnungen im Sonderkontingent haben 1 Schlafzimmer und starten ab 150.000 € netto, alle Details findest du hier: portal.happy-property.com/deck/6479598e72558d8c67 😊'
check(JSON.stringify(L.betraegeIn(FULYA_DE)) === '["150000"]', `betraegeIn Fulya: ${JSON.stringify(L.betraegeIn(FULYA_DE))}`)
check(L.fremdeBetraege(FULYA_DE, crm).length === 0, 'Fulyas Preis steht im CRM: erlaubt')
check(JSON.stringify(L.fremdeBetraege(FULYA_DE, L.betraegeIn(L.preisListe(EINH.slice(0, 1))))) === '["150000"]', 'Preis nicht in der Live-Liste: gesperrt')
check(JSON.stringify(L.fremdeBetraege('Die Wohnung kostet 149.000 € netto.', crm)) === '["149000"]', 'falscher Preis gesperrt')
check(L.fremdeBetraege('B305 gibt es für 245.000 € netto, A105 ab € 150.000.', crm).length === 0, 'zwei richtige Preise erlaubt')
check(L.fremdeBetraege('A105 kostet 150.000,00 €.', crm).length === 0, 'Preis mit Cent erlaubt')
check(L.fremdeBetraege('Etwa 1,2 Mio. € für die Villa.', crm).length === 1, 'Mio-Angabe gesperrt')
check(L.fremdeBetraege('Rund 150k netto.', crm).length === 1, 'k-Angabe gesperrt')
check(L.fremdeBetraege('Die Rate liegt bei 75.000 € netto.', crm).length === 1, 'ausgerechnete Rate gesperrt')
check(L.fremdeBetraege('1 Schlafzimmer, 52 m², rund 800 m zum Meer, 3 Min. mit dem Auto.', crm).length === 0, 'Zahlen ohne Geld sind kein Betrag')
check(L.betraegeIn('portal.happy-property.com/deck/6479598e72558d8c67').length === 0, 'Deck-Link ist kein Betrag')

// ── Antwortsprache ────────────────────────────────────────────────────────────
// Fulyas echte Nachrichten vom 29. und 30.10., neueste zuerst.
const FULYA = [
  'Good morning \n\nA small apartment \n\nIs it under construction or only in planning?',
  'Because our daughter lives in paphos',
  'We live in Germany and stay in paphos again and again 2 or 3 weeks',
  'Good afternoon,\n\nIs it possible to manage and rent out the apartment exclusively by myself, or can I also live in it myself?\n\nThank you very much for the information.',
]
const SPRACHE = [
  ...FULYA.map(t => [t, 'en']),
  ['Is it possible?', 'en'], ['Thank you', 'en'], ['Who is the developer?', 'en'],
  ['Can you send me a list of investment opportunities?', 'en'], ["I'm interested in the apartment, what's the price?", 'en'],
  ['Hallo Sven, \nIch werde doch eher in der Region Protaras suchen.\nViele Grüße \nArne', 'de'],
  ['Hallo Sven, bitte stellen Sie uns eine Liste der Investitionsmöglichkeiten zu, oder teilen Sie uns einen Link mit.', 'de'],
  ['Hallo Sven, danke für die Infos!\nIch wohne zwar in D bin aber aus Pafos und kenne den Immobilienmarkt relativ gut. Wer ist der Bauträger?', 'de'],
  ['Wie weit ist es zum Meer?', 'de'], ['Danke dir, bis morgen!', 'de'], ['Ja gerne', 'de'],
  ['Hello Sven, danke für die Infos', 'de'], ['Können wir ein Meeting machen?', 'de'], ['Hi Sven, perfekt, danke dir', 'de'],
  // Zu kurz oder nicht eindeutig: dann entscheidet der Verlauf, sonst Deutsch
  ['ok', null], ['👍', null], ['Super, passt!', null], ['Perfekt', null], ['Hallo', null], ['Okay thanks', null],
  ['Ok, danke', null], ['A105', null], ['Flora Panorama', null], ['Goedemorgen, is het appartement nog beschikbaar?', null],
  ['<a href="https://www.google.com/maps/search/?api=1&query=34.82,32.38" target="_blank">Standort</a>', null],
]
for (const [t, soll] of SPRACHE) check(S.spracheErkennen(t) === soll, `Sprache von "${t.replace(/\s+/g, ' ')}" ist ${S.spracheErkennen(t)}, erwartet ${soll}`)

check(S.antwortSprache('ok', FULYA, 'de') === 'en', 'kurze Nachricht nach englischem Verlauf: en')
check(S.antwortSprache('Thanks!', [], 'en') === 'en', 'kurze Nachricht, Kontakt en: en')
check(S.antwortSprache('ok', [], null) === 'de', 'ohne alles: de')
check(S.antwortSprache('ok', [], 'de') === 'de', 'Kontakt de: de')
check(S.antwortSprache(FULYA[0], [], 'de') === 'en', 'englische Frage bei Kontakt de: en')
check(S.antwortSprache('Wie weit ist es zum Meer?', FULYA, 'en') === 'de', 'deutsche Frage bei Kontakt en: de')
check(S.antwortSprache('👍', ['Danke dir, bis morgen!'], 'en') === 'de', 'jüngste deutsche Nachricht schlägt Kontakt en')

check(S.dauerhaftEnglisch(FULYA), 'Fulya schreibt dauerhaft Englisch')
check(S.dauerhaftEnglisch([FULYA[0], FULYA[2]]), 'zwei längere englische Nachrichten reichen')
check(!S.dauerhaftEnglisch([FULYA[0]]), 'eine Nachricht reicht nicht')
check(!S.dauerhaftEnglisch([FULYA[0], FULYA[0]]), 'dieselbe Nachricht doppelt zählt einmal')
check(!S.dauerhaftEnglisch([FULYA[0], 'Thank you']), 'kurze Nachricht zählt nicht als längere')
check(!S.dauerhaftEnglisch([FULYA[0], 'Danke dir, bis morgen!', FULYA[2]]), 'eine deutsche Nachricht dazwischen: keine Umstellung')
check(!S.dauerhaftEnglisch([]), 'ohne Nachrichten keine Umstellung')

const sn = S.sprachNotiz('Fulya', FULYA)
sauber(sn, 'Sprach-Notiz')
sauber(S.SPRACH_BETREFF, 'Sprach-Betreff')
check(sn.startsWith('Fulya schreibt dauerhaft Englisch') && sn.includes('„Good morning') && sn.includes('Bearbeiten'), `Sprach-Notiz: ${sn}`)
check(S.sprachNotiz(null, FULYA).startsWith('Der Kunde '), 'Sprach-Notiz ohne Vorname')

// ── Live: KI-Einordnung über booking-bot regel_test ──────────────────────────
if (process.argv.includes('--live')) {
  const env = join(homedir(), 'Downloads/happy-property/.env')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    || (existsSync(env) ? (readFileSync(env, 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY="?([^"\n]+)"?/m) ?? [])[1] : '')
  if (!key) { console.error('SUPABASE_SERVICE_ROLE_KEY fehlt'); process.exit(2) }
  const url = 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/booking-bot'
  for (const f of FAELLE) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'regel_test', text: f.text }) })
    const j = await r.json().catch(() => ({}))
    const e = j?.erkennung
    checked++
    if (!e) { fails.push(`live: keine Antwort für "${f.text}" (${r.status} ${JSON.stringify(j).slice(0, 200)})`); continue }
    if (e.regel !== f.regel) fails.push(`live: "${f.text}" ist ${e.regel}, erwartet ${f.regel}`)
    if (f.region && !String(e.region ?? '').toLowerCase().includes(f.region)) fails.push(`live: Region "${e.region}" statt ${f.region}`)
    console.log(`${e.regel === f.regel ? 'ok  ' : 'FEHL'} ${f.regel.padEnd(10)} ${e.regel.padEnd(10)} ${e.region ?? ''} ${f.text.replace(/\s+/g, ' ').slice(0, 70)}`)
  }
  // Läuft live dieselbe Spracherkennung wie hier?
  for (const [t, soll] of SPRACHE) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sprache_test', text: t }) })
    const j = await r.json().catch(() => ({}))
    checked++
    if (j?.erkannt !== soll) fails.push(`live sprache_test: "${t.replace(/\s+/g, ' ').slice(0, 60)}" ist ${j?.erkannt}, erwartet ${soll} (${r.status})`)
  }
}

if (fails.length) {
  console.error(`${fails.length} von ${checked} Prüfungen fehlgeschlagen:`)
  for (const f of fails) console.error(' - ' + f)
  process.exit(1)
}
console.log(`Alle ${checked} Prüfungen bestanden.`)
