import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

// ── Bild-Lightbox ────────────────────────────────────────────────────────────
// Vollbild-Bildbetrachter mit Blättern: Pfeile, Tastatur (←/→/Esc), Touch-Swipe,
// Zähler. Klick auf den Hintergrund schließt. Wiederverwendbar — bekommt die Bilder
// einer Einheit + den Startindex, sodass man nach dem Öffnen durch ALLE blättert.

export default function ImageLightbox({ images, startIndex = 0, onClose }: { images: string[]; startIndex?: number; onClose: () => void }) {
  const { t } = useTranslation()
  const n = images.length
  const [i, setI] = useState(startIndex)
  const [touchX, setTouchX] = useState<number | null>(null)
  const go = useCallback((d: number) => setI(p => (p + d + n) % n), [n])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose])

  if (!n) return null

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/90 flex items-center justify-center select-none"
      onClick={onClose}
      onTouchStart={e => setTouchX(e.touches[0]?.clientX ?? null)}
      onTouchEnd={e => {
        if (touchX != null) {
          const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1)
          setTouchX(null)
        }
      }}
    >
      <button onClick={e => { e.stopPropagation(); onClose() }} aria-label={t('imageLightbox.close', 'Schließen')}
        className="absolute top-4 right-4 z-10 text-white/80 hover:text-white text-3xl leading-none">✕</button>

      {n > 1 && (
        <span className="absolute top-5 left-1/2 -translate-x-1/2 text-white/70 text-sm font-body">{i + 1} / {n}</span>
      )}

      {n > 1 && (
        <button onClick={e => { e.stopPropagation(); go(-1) }} aria-label={t('imageLightbox.previousImage', 'Vorheriges Bild')}
          className="absolute left-3 md:left-6 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-4xl leading-none">‹</button>
      )}

      <img src={images[i]} alt="" onClick={e => e.stopPropagation()}
        className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl" />

      {n > 1 && (
        <button onClick={e => { e.stopPropagation(); go(1) }} aria-label={t('imageLightbox.nextImage', 'Nächstes Bild')}
          className="absolute right-3 md:right-6 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-4xl leading-none">›</button>
      )}
    </div>
  )
}
