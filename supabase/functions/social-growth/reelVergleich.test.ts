import { assertEquals } from 'jsr:@std/assert@1'
import { reelVergleich, type ReelMetrik } from './reelVergleich.ts'

const jetzt = Date.parse('2026-11-16T04:00:00Z')
const metrik = (x: Partial<ReelMetrik>): ReelMetrik => ({
  post_ref: 'r', platform: 'instagram', social_post_id: null, published_at: '2026-11-12T16:30:00Z', media_type: 'REELS',
  reach: 60, views: 90, caption: 'Reel', permalink: null, ...x,
})

Deno.test('Instagram und Facebook desselben Beitrags und seine Anzeigen landen in einer Zeile', () => {
  const z = reelVergleich([
    metrik({ post_ref: 'ig1', social_post_id: 'p1', caption: 'Drei Wünsche', permalink: 'https://ig/1' }),
    metrik({ post_ref: 'fb1', social_post_id: 'p1', platform: 'facebook', reach: 20, views: 30, permalink: 'https://fb/1' }),
  ], [
    { ad_name: 'IG Reel', source_ig: 'ig1', impressions: 1000, spend: 10.5 },
    { ad_name: 'IG Reel 2', source_ig: 'ig1', impressions: 500, spend: 2 },
  ], [], jetzt)
  assertEquals(z, [{
    titel: 'Drei Wünsche', link: 'https://ig/1', at: '2026-11-12T16:30:00Z', test: false,
    ig_personen: 60, ig_aufrufe: 90, fb_personen: 20, fb_aufrufe: 30, bezahlt_aufrufe: 1500, bezahlt_usd: 12.5,
  }])
})

Deno.test('Anzeige ohne Bezug zum Beitrag bekommt eine eigene Zeile mit Anzeigennamen', () => {
  const z = reelVergleich([], [{ ad_name: 'FB · drei-wuensche', source_ig: null, impressions: 7, spend: 1 }], [], jetzt)
  assertEquals([z[0].titel, z[0].ig_personen, z[0].bezahlt_aufrufe], ['FB · drei-wuensche', null, 7])
})

Deno.test('Altes Reel ohne Anzeigen fällt weg, neues bleibt, Beworbenes steht oben', () => {
  const z = reelVergleich([
    metrik({ post_ref: 'alt', caption: 'Alt', published_at: '2026-10-01T10:00:00Z' }),
    metrik({ post_ref: 'neu', caption: 'Neu' }),
    metrik({ post_ref: 'beworben', caption: 'Beworben', published_at: '2026-10-02T10:00:00Z' }),
  ], [{ ad_name: 'A', source_ig: 'beworben', impressions: 5, spend: 1 }], [], jetzt)
  assertEquals(z.map(x => x.titel), ['Beworben', 'Neu'])
})

Deno.test('Testreel wird markiert, Nicht-Reels zählen nicht', () => {
  const z = reelVergleich([
    metrik({ post_ref: 'a', social_post_id: 'p-test', caption: 'Test' }),
    metrik({ post_ref: 'b', media_type: 'IMAGE', caption: 'Bild' }),
  ], [], ['p-test'], jetzt)
  assertEquals(z.map(x => [x.titel, x.test]), [['Test', true]])
})
