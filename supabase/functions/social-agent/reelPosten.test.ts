import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { reelPosten, type ReelAuftrag } from './reelPosten.ts'

// Spielt Instagram nach: Containeranlage, Statusabfrage und Veröffentlichen sind einzeln steuerbar.
function instagram(o: {
  anlage?: (test: boolean) => Record<string, unknown>
  status?: (id: string) => string
  publish?: (id: string) => Record<string, unknown>
}) {
  const anlagen: Array<Record<string, string>> = []
  const posts: string[] = []
  let nr = 0
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    const u = String(url)
    let antwort: unknown
    if (u.endsWith('/media')) {
      const felder = Object.fromEntries(new URLSearchParams(String(init?.body)))
      anlagen.push(felder)
      antwort = o.anlage?.('trial_params' in felder) ?? { id: `c${++nr}` }
    } else if (u.endsWith('/media_publish')) {
      const id = new URLSearchParams(String(init?.body)).get('creation_id') ?? ''
      posts.push(id)
      antwort = o.publish?.(id) ?? { id: `media-${id}` }
    } else {
      const id = u.split('/').pop()!.split('?')[0]
      antwort = { status_code: o.status?.(id) ?? 'FINISHED' }
    }
    return Promise.resolve(new Response(JSON.stringify(antwort)))
  }) as typeof fetch
  return { fetcher, anlagen, posts }
}

const auftrag = (ig: ReturnType<typeof instagram>, x: Partial<ReelAuftrag> = {}): ReelAuftrag => ({
  igId: '1', videoUrl: 'https://x/v.mp4', caption: 'Text', token: 't', alsTest: false, vorlauf: null,
  bereinigen: s => s, warteMs: 0, fetcher: ig.fetcher, ...x,
})

Deno.test('Normales Reel: Teilen im Feed, ohne Testkennung, Text unverändert', async () => {
  const ig = instagram({})
  assertEquals(await reelPosten(auftrag(ig)), { ok: true, id: 'media-c1' })
  assertEquals(ig.anlagen[0].share_to_feed, 'true')
  assertEquals(ig.anlagen[0].caption, 'Text')
  assertEquals('trial_params' in ig.anlagen[0], false)
})

Deno.test('Testreel: trial_params statt Teilen im Feed, Ergebnis trägt die Kennung', async () => {
  const ig = instagram({})
  assertEquals(await reelPosten(auftrag(ig, { alsTest: true })), { ok: true, id: 'media-c1', trial: true })
  assertEquals(JSON.parse(ig.anlagen[0].trial_params), { graduation_strategy: 'SS_PERFORMANCE' })
  assertEquals('share_to_feed' in ig.anlagen[0], false)
})

Deno.test('Testreel abgelehnt: geht im selben Lauf als normales Reel raus, Grund bleibt', async () => {
  const ig = instagram({ anlage: test => (test ? { error: { message: 'nicht erlaubt' } } : { id: 'n1' }) })
  assertEquals(await reelPosten(auftrag(ig, { alsTest: true })), { ok: true, id: 'media-n1', trial_fallback: 'nicht erlaubt' })
  assertEquals(ig.anlagen.length, 2)
  assertEquals(ig.anlagen[1].share_to_feed, 'true')
})

Deno.test('Testreel in der Verarbeitung gescheitert: normaler Container, Abschluss im nächsten Lauf', async () => {
  const ig = instagram({ status: () => 'ERROR' })
  const r = await reelPosten(auftrag(ig, { alsTest: true }))
  assertEquals(r.pending, true)
  assertEquals(r.container, 'c2')
  assertEquals(r.trial, undefined)
  assertEquals(r.trial_fallback, 'Testreel-Container: ERROR')
  assertEquals(ig.posts, [])

  const ig2 = instagram({})
  assertEquals(await reelPosten(auftrag(ig2, { alsTest: true, vorlauf: r })), { ok: true, id: 'media-c2', trial_fallback: 'Testreel-Container: ERROR' })
  assertEquals(ig2.anlagen.length, 0)
})

Deno.test('Testreel beim Veröffentlichen abgelehnt: normaler Container, Abschluss im nächsten Lauf', async () => {
  const ig = instagram({ publish: () => ({ error: { message: 'kein Test möglich' } }) })
  const r = await reelPosten(auftrag(ig, { alsTest: true }))
  assertEquals([r.pending, r.container, r.trial, r.trial_fallback], [true, 'c2', undefined, 'kein Test möglich'])
})

Deno.test('Testreel noch in Arbeit: wartet und bleibt beim nächsten Lauf ein Testreel', async () => {
  const ig = instagram({ status: () => 'IN_PROGRESS' })
  const r = await reelPosten(auftrag(ig, { alsTest: true }))
  assertEquals([r.pending, r.container, r.trial, r.tries], [true, 'c1', true, 1])

  const ig2 = instagram({})
  assertEquals(await reelPosten(auftrag(ig2, { alsTest: false, vorlauf: r })), { ok: true, id: 'media-c1', trial: true })
  assertEquals(ig2.anlagen.length, 0)
})

Deno.test('Bewährtes Verhalten bleibt: normales Reel scheitert mit klarer Meldung', async () => {
  await assertRejects(() => reelPosten(auftrag(instagram({ anlage: () => ({ error: { message: 'Anlage kaputt' } }) }))), Error, 'Anlage kaputt')
  await assertRejects(() => reelPosten(auftrag(instagram({ status: () => 'ERROR' }))), Error, 'nicht verarbeiten')
  await assertRejects(() => reelPosten(auftrag(instagram({ publish: () => ({ error: { message: 'Publish kaputt' } }) }))), Error, 'Publish kaputt')
  await assertRejects(() => reelPosten(auftrag(instagram({ status: () => '' }), { vorlauf: { container: 'c9', tries: 7 } })), Error, 'über 3 Stunden')
})

Deno.test('Testreel und auch das normale Reel abgelehnt: Fehler statt Stille', async () => {
  const ig = instagram({ anlage: () => ({ error: { message: 'Konto gesperrt' } }) })
  await assertRejects(() => reelPosten(auftrag(ig, { alsTest: true })), Error, 'Konto gesperrt')
})
