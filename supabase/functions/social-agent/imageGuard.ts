// Pixel-Prüfung für KI-Bilder: erkennt Collagen (2-6 Felder) und gekachelte
// Ränder, wie sie Higgsfield Soul v2 seit ca. 1.10.2026 immer wieder liefert
// (Lotte-Posts 7.10. bis 21.10.). Gesucht wird ein senkrechter Schnitt, an dem
// das Bild über fast die ganze Höhe springt; echte Fotos haben so etwas kaum,
// auch Hauskanten und Masten reichen nicht über die ganze Höhe.
// Geeicht am 16.10.2026 an 10 kaputten und 6 guten echten Bildern (Vorschau
// 192 px über den Supabase-Verkleinerer): kaputte Schnitte 62-96 % der Höhe,
// gute Bilder höchstens 59 %. Deshalb: ab 70 % sicher kaputt, 60-70 % nur,
// wenn sich rechts vom Schnitt der Bildanfang wiederholt. Eine Collage aus
// versetzten Feldern (7.10.) hat keinen durchgehenden Schnitt, die findet die
// zweite Prüfung (Claude zählt die Bildfelder, index.ts).
import { Image } from '../_vendor/imagescript/ImageScript.js'

// Verkleinerte Fassung eines öffentlichen Storage-Bilds. NICHT nur width angeben:
// dann behält Supabase die Originalhöhe und schneidet einen schmalen Mittelstreifen
// aus (so sah Claude bei einer Collage nur das mittlere Feld, 16.10.2026).
export function smallUrl(url: string, max: number): string {
  if (!url.includes('/storage/v1/object/public/')) return url
  return `${url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')}?width=${max}&height=${max}&resize=contain&format=origin`
}

export interface SeamCheck { hard: boolean; soft: boolean; cov: number; x: number; w: number }

export async function seamCheck(url: string): Promise<SeamCheck> {
  const r = await fetch(smallUrl(url, 192))
  if (!r.ok) throw new Error(`Vorschau nicht ladbar (${r.status})`)
  const img = await Image.decode(new Uint8Array(await r.arrayBuffer()))
  const w = img.width, h = img.height, px = img.bitmap
  const g = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
  // S[x] = mittlerer Helligkeitssprung zwischen Spalte x-1 und x
  const S = new Float64Array(w)
  for (let x = 1; x < w; x++) {
    let s = 0
    for (let y = 0; y < h; y++) s += Math.abs(g[y * w + x] - g[y * w + x - 1])
    S[x] = s / h
  }
  const sorted = Array.from(S.subarray(1)).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const med = (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) + 1e-3
  // Mittlere Abweichung zwischen k Spalten ab x0 und k Spalten ab xa
  const diff = (x0: number, xa: number, k: number) => {
    let s = 0
    for (let y = 0; y < h; y++) for (let i = 0; i < k; i++) s += Math.abs(g[y * w + x0 + i] - g[y * w + xa + i])
    return s / (h * k)
  }
  const out: SeamCheck = { hard: false, soft: false, cov: 0, x: 0, w }
  for (let x = Math.floor(w * 0.12); x < Math.floor(w * 0.97); x++) {
    if (S[x] / med < 2.5) continue
    let n = 0
    for (let y = 0; y < h; y++) if (Math.abs(g[y * w + x] - g[y * w + x - 1]) > 2 * med) n++
    const cov = n / h
    if (cov > out.cov) { out.cov = cov; out.x = x }
    if (cov >= 0.7) out.hard = true
    else if (cov >= 0.6 && !out.soft) {
      // Wiederholt sich rechts vom Schnitt der Bildanfang (= Anfang des ersten Felds)?
      const k = Math.max(4, Math.min(w - x, x, Math.floor(w * 0.25)))
      const step = Math.max(1, Math.floor(k / 2))
      const offs: number[] = []
      for (let o = step; o <= w - k; o += step) if (Math.abs(o - x) > step) offs.push(o)
      const base = offs.length ? offs.reduce((a, o) => a + diff(x, o, k), 0) / offs.length : 255
      if (diff(x, 0, k) / (base + 1e-3) < 0.75) out.soft = true
    }
  }
  return out
}
