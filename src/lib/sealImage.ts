// Foto eines Firmenstempels (auf weißem Papier) freistellen: Papier wird transparent, nur die
// Stempelfarbe bleibt, auf den Stempel zugeschnitten. Läuft im Browser, damit der Bauträger
// das Ergebnis sofort sieht, bevor es gespeichert wird.

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image_unreadable'))
    img.src = url
  })
}

/** Liefert ein PNG als data-URL. Wirft 'image_unreadable' oder 'seal_not_found'. */
export async function processSealImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const scale = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale))
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('image_unreadable')
    ctx.drawImage(img, 0, 0, w, h)
    const id = ctx.getImageData(0, 0, w, h)
    const d = id.data
    // Papierhelligkeit = 90. Perzentil der Helligkeit (robust gegen Schatten und Stempelfarbe)
    const sample: number[] = []
    for (let i = 0; i < d.length; i += 4 * 7) sample.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])
    sample.sort((a, b) => a - b)
    const paper = sample[Math.floor(sample.length * 0.9)] ?? 255
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        const a = Math.max(0, Math.min(1, (paper - l - 18) / 70))
        d[i + 3] = Math.round(a * 255)
        // Farbe leicht kräftigen, damit blasse Stempel im PDF lesbar bleiben
        d[i] = Math.round(d[i] * 0.85); d[i + 1] = Math.round(d[i + 1] * 0.85); d[i + 2] = Math.round(d[i + 2] * 0.85)
        if (a > 0.2) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
      }
    }
    if (maxX - minX < 24 || maxY - minY < 24) throw new Error('seal_not_found')
    ctx.putImageData(id, 0, 0)
    const pad = 6
    const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad)
    const cw = Math.min(w - cx, maxX - minX + pad * 2), ch = Math.min(h - cy, maxY - minY + pad * 2)
    const out = document.createElement('canvas')
    const s2 = Math.min(1, 600 / Math.max(cw, ch))
    out.width = Math.round(cw * s2); out.height = Math.round(ch * s2)
    out.getContext('2d')?.drawImage(c, cx, cy, cw, ch, 0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}
