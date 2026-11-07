// Je Reel Unbezahltes und Bezahltes nebeneinander für die Montagsmail (Sven 7.11.2026).
// Die Beitragswerte von Meta enthalten nichts Bezahltes, Bezahltes kommt aus den Anzeigen.

export interface ReelMetrik {
  post_ref: string
  platform: 'instagram' | 'facebook'
  social_post_id: string | null
  published_at: string | null
  media_type: string | null
  reach: number | null
  views: number | null
  caption: string | null
  permalink: string | null
}
export interface BezahltRow { ad_name: string; source_ig: string | null; impressions: number; spend: number }
export interface ReelZeile {
  titel: string
  link: string | null
  at: string | null
  test: boolean
  ig_personen: number | null
  ig_aufrufe: number | null
  fb_personen: number | null
  fb_aufrufe: number | null
  bezahlt_aufrufe: number
  bezahlt_usd: number
}

const TAG_MS = 86400000
const titelVon = (c: string | null) => {
  const t = String(c ?? '').replace(/\s+/g, ' ').trim()
  return t ? (t.length > 60 ? `${t.slice(0, 58)}…` : t) : 'Reel ohne Text'
}

// Zeigt Reels mit Anzeigen in den letzten 7 Tagen und alle Reels der letzten 8 Tage,
// das meistbeworbene zuerst, danach das neueste.
export function reelVergleich(posts: ReelMetrik[], bezahlt: BezahltRow[], testIds: string[], nowMs: number, max = 16): ReelZeile[] {
  const zeilen = new Map<string, ReelZeile>()
  const keyVonRef = new Map<string, string>()
  const leer = (titel: string, at: string | null, test: boolean): ReelZeile => ({
    titel, link: null, at, test, ig_personen: null, ig_aufrufe: null, fb_personen: null, fb_aufrufe: null, bezahlt_aufrufe: 0, bezahlt_usd: 0,
  })
  for (const p of posts) {
    if (p.media_type !== 'REELS') continue
    const key = p.social_post_id ?? p.post_ref
    const z = zeilen.get(key) ?? leer(titelVon(p.caption), p.published_at, !!p.social_post_id && testIds.includes(p.social_post_id))
    if (p.platform === 'instagram') {
      z.ig_personen = p.reach
      z.ig_aufrufe = p.views
      z.link = p.permalink ?? z.link
      if (p.caption) z.titel = titelVon(p.caption)
    } else {
      z.fb_personen = p.reach
      z.fb_aufrufe = p.views
      z.link = z.link ?? p.permalink
    }
    zeilen.set(key, z)
    keyVonRef.set(p.post_ref, key)
  }
  for (const a of bezahlt) {
    const key = (a.source_ig ? keyVonRef.get(a.source_ig) : undefined) ?? `anzeige:${a.ad_name}`
    const z = zeilen.get(key) ?? leer(a.ad_name, null, false)
    z.bezahlt_aufrufe += a.impressions
    z.bezahlt_usd += a.spend
    zeilen.set(key, z)
  }
  return [...zeilen.values()]
    .filter(z => z.bezahlt_aufrufe > 0 || z.bezahlt_usd > 0 || Date.parse(z.at ?? '') >= nowMs - 8 * TAG_MS)
    .sort((a, b) => b.bezahlt_aufrufe - a.bezahlt_aufrufe || String(b.at ?? '').localeCompare(String(a.at ?? '')))
    .slice(0, max)
}
