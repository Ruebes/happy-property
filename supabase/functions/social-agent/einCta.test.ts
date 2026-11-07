import { assertEquals } from 'jsr:@std/assert@1'
import { einCta } from './einCta.ts'

const stichwort = (z: string) => /Kommentiere [A-ZÄÖÜ]{2,}/.test(z)
const vorher = Date.parse('2026-11-10T12:00:00Z')
const danach = Date.parse('2026-11-15T10:00:00Z')

const TERMIN = '👉 Kostenloses Erstgespräch mit Sven und Lotte: portal.happy-property.com/termin?src=instagram'
const GUIDE = 'Kommentiere GUIDE und du bekommst unseren Immobilienguide Paphos per Nachricht. 📩'
const MC = '📅 Kostenlose Live-Masterclass: Sonntag, 15.11., 11 Uhr (deutsche Zeit). Anmeldung: portal.happy-property.com/s/masterclass'
const alle = ['Text oben.', '', TERMIN, '', GUIDE, '', MC, '', '#zypern'].join('\n')

Deno.test('Vor der Masterclass bleibt auf beiden Plattformen nur ihre Zeile', () => {
  const soll = ['Text oben.', '', MC, '', '#zypern'].join('\n')
  assertEquals(einCta(alle, 'instagram', stichwort, vorher), soll)
  assertEquals(einCta(alle, 'facebook', stichwort, vorher), soll)
})

Deno.test('Ab Beginn der Masterclass: Instagram Stichwort, Facebook Termin, alte Zeile weg', () => {
  assertEquals(einCta(alle, 'instagram', stichwort, danach), ['Text oben.', '', GUIDE, '', '#zypern'].join('\n'))
  assertEquals(einCta(alle, 'facebook', stichwort, danach), ['Text oben.', '', TERMIN, '', '#zypern'].join('\n'))
})

Deno.test('Text mit nur einer Handlungsaufforderung bleibt zeichengenau gleich', () => {
  const t = `Text.\n\n${TERMIN}\n\n\n#zypern\n`
  assertEquals(einCta(t, 'instagram', stichwort, vorher), t)
  assertEquals(einCta(t, 'facebook', stichwort, vorher), t)
  assertEquals(einCta('Nur Text ohne Aufruf.', 'instagram', stichwort, vorher), 'Nur Text ohne Aufruf.')
})

Deno.test('Frage an die Leser: Aufruf und Frage gehen, der Satz davor bleibt', () => {
  const zeile = 'Das ist eine kleine Auswahl aus gut 200 Objekten. Lieber Stadtnähe oder Hügel? Schreib\'s in die Kommentare.'
  assertEquals(
    einCta(`${zeile}\n\n${TERMIN}`, 'facebook', stichwort, danach),
    `Das ist eine kleine Auswahl aus gut 200 Objekten.\n\n${TERMIN}`,
  )
  // Steht keine andere Handlung im Text, bleibt die Frage die eine Handlung
  assertEquals(einCta(zeile, 'instagram', stichwort, danach), zeile)
})

Deno.test('Zwei Zeilen derselben Art: nur die erste bleibt', () => {
  const t = `${GUIDE}\nKommentiere PAPHOS für die Karte.`
  assertEquals(einCta(t, 'instagram', stichwort, danach), GUIDE)
})

Deno.test('Facebook hat keine Bio: Bio-Satz zählt dort nicht und verdrängt das Stichwort nicht', () => {
  const t = `Link in der Bio.\n${GUIDE}`
  // Bleibt für fbCaption stehen, das den Bio-Satz entfernt und das Stichwort ersetzt
  assertEquals(einCta(t, 'facebook', stichwort, danach), t)
  assertEquals(einCta(t, 'instagram', stichwort, danach), GUIDE)
})

Deno.test('Text in derselben Zeile wie der Aufruf bleibt stehen', () => {
  const t = `Mehr dazu im Video. Link in der Bio.\n${GUIDE}`
  assertEquals(einCta(t, 'instagram', stichwort, danach), `Mehr dazu im Video.\n${GUIDE}`)
})

Deno.test('Wort „Biografie" oder „Bio-Kaffee" zählt nicht als Bio-Link', () => {
  const t = `Bio-Kaffee auf dem Balkon und eine lange Biografie.\n${GUIDE}`
  assertEquals(einCta(t, 'instagram', stichwort, danach), t)
})

Deno.test('Leerer Text bricht nicht', () => {
  assertEquals(einCta('', 'instagram', stichwort, vorher), '')
})
