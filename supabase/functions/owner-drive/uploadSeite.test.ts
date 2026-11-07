import { assertEquals } from 'jsr:@std/assert@1'
import { dateiName, dateiTyp, linkOffen } from './uploadSeite.ts'

const jetzt = Date.parse('2026-11-07T12:00:00Z')
const offen = { expires_at: '2026-12-01T00:00:00Z', revoked_at: null, phasen: ['reservierung'], gesperrt: false, jetzt }

Deno.test('Link: offen nur bei gültig, ungesperrt und ohne ausschließlich tote Deals', () => {
  assertEquals(linkOffen(offen), true)
  assertEquals(linkOffen({ ...offen, phasen: [] }), true)
  assertEquals(linkOffen({ ...offen, phasen: ['deal_verloren', 'reservierung'] }), true)
  assertEquals(linkOffen({ ...offen, phasen: ['deal_verloren', 'archiviert'] }), false)
  assertEquals(linkOffen({ ...offen, gesperrt: true }), false)
  assertEquals(linkOffen({ ...offen, revoked_at: '2026-11-01T00:00:00Z' }), false)
  assertEquals(linkOffen({ ...offen, expires_at: '2026-11-07T12:00:00Z' }), false)
})

const bytes = (s: string) => new TextEncoder().encode(s)

Deno.test('Dateityp kommt aus dem Inhalt', () => {
  assertEquals(dateiTyp(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'x.pdf'), 'image/jpeg')
  assertEquals(dateiTyp(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'x'), 'image/png')
  assertEquals(dateiTyp(bytes('%PDF-1.7'), 'pass'), 'application/pdf')
  assertEquals(dateiTyp(bytes('RIFF1234WEBP'), 'x'), 'image/webp')
  assertEquals(dateiTyp(bytes('0000ftypheic'), 'x'), 'image/heic')
  assertEquals(dateiTyp(bytes('0000ftypmif1'), 'x'), 'image/heif')
  assertEquals(dateiTyp(bytes('0000ftypisom'), 'x.heic'), null)
  assertEquals(dateiTyp(bytes('<html><script>'), 'pass.pdf'), null)
  assertEquals(dateiTyp(bytes('MZ'), 'pass.jpg'), null)
  assertEquals(dateiTyp(new Uint8Array([0x50, 0x4b, 3, 4]), 'a.DOCX')?.includes('wordprocessingml'), true)
  assertEquals(dateiTyp(new Uint8Array([0x50, 0x4b, 3, 4]), 'a.zip'), null)
  assertEquals(dateiTyp(new Uint8Array(0), 'a.pdf'), null)
})

Deno.test('Dateiname ohne Pfad und Steuerzeichen, Endung bleibt', () => {
  assertEquals(dateiName('../../geheim.pdf'), 'geheim.pdf')
  assertEquals(dateiName('C:\\Users\\a\\pass foto.jpg'), 'pass foto.jpg')
  assertEquals(dateiName('a\u0000b\n.pdf'), 'ab.pdf')
  assertEquals(dateiName('   '), 'Datei')
  const lang = dateiName('x'.repeat(300) + '.pdf')
  assertEquals(lang.length, 150)
  assertEquals(lang.endsWith('.pdf'), true)
})
