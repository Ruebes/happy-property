// Tests für STOPP-Erkennung und WhatsApp-Limit (Sperre vom 5.11.2026).
//
// Prüft offline: detectsStopIntent und der Weg „STOPP ohne Lead" aus
// supabase/functions/_shared/waInbound.ts (mit nachgebauter Datenbank) sowie die
// Regeln aus supabase/functions/_shared/waLimit.ts. Sendet nichts.
//
// Ausführen:
//   node scripts/verify-wa-regeln.mjs

import { execSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'hpwa-'))
const bundle = async (name) => {
  const out = join(dir, `${name}.mjs`)
  execSync(`npx --yes esbuild ${JSON.stringify(join(root, `supabase/functions/_shared/${name}.ts`))} --bundle --format=esm --platform=neutral --outfile=${JSON.stringify(out)} --log-level=warning`, { stdio: 'pipe', cwd: root })
  return import(out)
}
const I = await bundle('waInbound')
const L = await bundle('waLimit')

let fehler = 0
const ok = (bed, text) => {
  if (bed) console.log(`  ok   ${text}`)
  else { fehler++; console.log(`  FEHL ${text}`) }
}

console.log('STOPP-Erkennung')
for (const t of ['Stop', 'STOPP', 'stopp bitte', 'Dtop', 'dtop!', 'Atop', ' Xtopp. ', 'abmelden', 'Bitte austragen', 'keine Werbung mehr']) {
  ok(I.detectsStopIntent(t), `erkannt: „${t}"`)
}
for (const t of ['Top', 'Top!', 'top, danke', 'Danke', 'gestoppt', 'Laptop', 'Desktop', 'Dtop geht heute nicht', 'Etoile']) {
  ok(!I.detectsStopIntent(t), `nicht erkannt: „${t}"`)
}

// Nachgebaute Datenbank: merkt sich Schreibzugriffe, liefert die Abonnenten.
function fakeDb(abos) {
  const schreiben = []
  const from = (table) => {
    let op = 'select'
    const st = { table, payload: null, filter: {} }
    const api = {
      select: () => api, ilike: (c, v) => { st.filter[c] = v; return api }, is: () => api, eq: () => api, not: () => api, or: () => api, gte: () => api,
      in: (c, v) => { st.filter[c] = v; return api }, limit: () => api, order: () => api, maybeSingle: () => api,
      update: (p) => { op = 'update'; st.payload = p; schreiben.push({ ...st, op, filter: st.filter }); return api },
      insert: (p) => { op = 'insert'; st.payload = p; schreiben.push({ ...st, op }); return Promise.resolve({ error: null }) },
      then: (res) => res(table === 'newsletter_subscribers' && op === 'select' ? { data: abos, error: null } : { data: [], error: null }),
    }
    return api
  }
  return { from, rpc: async () => ({ data: [], error: null }), schreiben }
}
const ereignis = (text) => ({ uid: 'x', phone: '+491716152079', text, fromMe: false, viaApi: false })

console.log('STOPP ohne Lead')
{
  const db = fakeDb([{ id: 'a1' }, { id: 'a2' }])
  const r = await I.processWaEvent(db, ereignis('Stop'), 'test')
  const abo = db.schreiben.find(s => s.table === 'newsletter_subscribers' && s.op === 'update')
  const storno = db.schreiben.find(s => s.table === 'scheduled_messages' && s.op === 'update')
  ok(r.outcome === 'no-lead', 'Ergebnis no-lead')
  ok(!!abo?.payload?.optout_at && abo.filter.id?.length === 2, 'beide Abonnenten-Zeilen abgemeldet')
  ok(storno?.payload?.status === 'cancelled' && storno.filter.subscriber_id?.length === 2, 'offene Nachrichten storniert')
  ok(db.schreiben.some(s => s.table === 'wa_unknown_messages'), 'Nachricht steht im Posteingang')
}
{
  const db = fakeDb([{ id: 'a1' }])
  const r = await I.processWaEvent(db, { ...ereignis('[Sprachnachricht]'), mediaOnly: true }, 'test')
  ok(r.outcome === 'no-lead' && !db.schreiben.some(s => s.table === 'newsletter_subscribers'), 'reine Medien melden nicht ab')
}
{
  const db = fakeDb([{ id: 'a1' }])
  await I.processWaEvent(db, ereignis('Top'), 'test')
  ok(!db.schreiben.some(s => s.table === 'newsletter_subscribers' && s.op === 'update' && s.payload?.optout_at), '„Top" meldet nicht ab')
}

console.log('WhatsApp-Limit')
const stand = (lauf, stunde, tag, limitTag = L.WA_LIMIT_TAG) => ({ lauf, stunde, tag, limitTag })
ok(L.waLimitGrund(stand(0, 0, 0)) === null, 'frei, solange nichts gesendet ist')
ok(L.waLimitGrund(stand(1, 11, 19)) === null, 'frei knapp unter allen Grenzen')
ok(L.waLimitGrund(stand(L.WA_LIMIT_LAUF, 0, 0)) === 'lauf', 'Grenze je Lauf')
ok(L.waLimitGrund(stand(0, L.WA_LIMIT_STUNDE, 0)) === 'stunde', 'Grenze je Stunde')
ok(L.waLimitGrund(stand(0, 0, L.WA_LIMIT_TAG)) === 'tag', 'Grenze je Tag')
ok(L.waLimitGrund(stand(0, 0, 0, 0)) === 'tag', 'Not-Aus: Tageslimit 0 sperrt alles')
ok(L.waLimitGrund(stand(0, 0, Infinity)) === 'tag', 'Lesefehler gilt als Limit erreicht')

const t0 = Date.parse('2026-11-05T08:00:00Z')
ok(L.waLimitNochmal('lauf', null, t0).getTime() === t0 + 4 * 60_000, 'je Lauf: nach 4 Minuten wieder dran')
ok(L.waLimitNochmal('stunde', null, t0).getTime() === t0 + 15 * 60_000, 'je Stunde: nach 15 Minuten wieder dran')
ok(L.waLimitNochmal('tag', 2, t0).getTime() === t0 + 180 * 60_000 + 2000, 'je Tag: nach 3 Stunden, Teil 2 zwei Sekunden später')

ok(L.limitTagAus(null) === L.WA_LIMIT_TAG && L.limitTagAus('') === L.WA_LIMIT_TAG, 'kein Wert: Standard')
ok(L.limitTagAus('0') === 0, 'Wert 0 bleibt 0')
ok(L.limitTagAus('40') === 40, 'Wert 40 gilt')
ok(L.limitTagAus('x') === L.WA_LIMIT_TAG && L.limitTagAus(-1) === L.WA_LIMIT_TAG, 'Unsinn: Standard')

// Nachgestellt: 55 Einladungen wie am 5.11., alle 90 Sekunden fällig, Lauf alle 5 Minuten.
{
  const gesendet = []
  let faellig = 0, gesamt = 0
  for (let min = 0; gesamt < 55 || faellig > 0; min += 5) {
    const neu = Math.min(55 - gesamt, Math.round(5 * 60 / 90))
    gesamt += neu
    faellig += neu
    const s = {
      lauf: 0,
      stunde: gesendet.filter(m => m > min - 60).length,
      tag: gesendet.filter(m => m > min - 1440).length,
      limitTag: L.WA_LIMIT_TAG,
    }
    while (faellig > 0) {
      faellig--
      if (L.waLimitGrund(s)) continue // ging als Mail raus
      s.lauf++; s.stunde++; s.tag++
      gesendet.push(min)
    }
  }
  const spitze = Math.max(...gesendet.map(m => gesendet.filter(x => x > m - 60 && x <= m).length))
  ok(gesendet.length === L.WA_LIMIT_TAG, `Welle wie am 5.11.: ${gesendet.length} WhatsApps statt 49, der Rest per Mail`)
  ok(spitze <= L.WA_LIMIT_STUNDE, `Welle wie am 5.11.: höchstens ${spitze} in 60 Minuten`)
}

// Nachgestellt: Newsletter-Ersatz, 10 Empfänger im Takt von 3,5 Minuten, geht komplett durch.
{
  const gesendet = []
  let warten = 0, gesamt = 0
  for (let min = 0; gesamt < 10 || warten > 0; min += 5) {
    const neu = Math.min(10 - gesamt, Math.floor((min + 5) / 3.5) - gesamt)
    gesamt += neu
    warten += neu
    const s = { lauf: 0, stunde: gesendet.filter(m => m > min - 60).length, tag: gesendet.length, limitTag: L.WA_LIMIT_TAG }
    while (warten > 0 && !L.waLimitGrund(s)) { warten--; s.lauf++; s.stunde++; s.tag++; gesendet.push(min) }
  }
  ok(gesendet.length === 10, `Samstags-Newsletter: alle ${gesendet.length} Empfänger per WhatsApp, bis Minute ${gesendet.at(-1)}`)
}

if (fehler) { console.log(`\n${fehler} Fehler`); process.exit(1) }
console.log('\nAlles ok')
