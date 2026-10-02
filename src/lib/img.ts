import type { SyntheticEvent } from 'react'

// Vorschaubilder über die Supabase-Bildumwandlung (render/image) statt der
// Originale (1,3 bis 3,8 MB je Foto). Umgeschrieben werden NUR öffentliche
// Storage-Adressen dieses Projekts mit Bild-Endung (jpg, jpeg, png, webp).
// Alles andere bleibt unverändert: signierte URLs (private Buckets), fremde
// Adressen, data:/blob:, Adressen mit Query, PDFs, Videos, GIFs, HEIC.
// Nur für Listen- und Vorschaukacheln verwenden; Großansicht, Lightbox und
// Download behalten die Original-URL.
//
// resize=contain ist Pflicht: mit nur `width` und dem Standard `cover` liefert
// Supabase einen Streifen in voller Originalhöhe (gemessen 2.10.26: width=400
// ergab 400x3781). contain skaliert proportional und vergrößert nie.
//
// Schalter VITE_IMG_TRANSFORM (Standard AUS): Pro-Tarif enthält nur 100
// verschiedene Ursprungsbilder je Abrechnungszeitraum. Mit aktivem Spend Cap
// ist danach JEDE Umwandlung bis zum nächsten Zeitraum gesperrt, auch die
// bestehenden (Funnel-Hero, Deck-Mails, WhatsApp-Verkleinerung). Erst
// einschalten (VITE_IMG_TRANSFORM=1 im Build), wenn Kontingent und Spend Cap
// im Supabase-Dashboard geprüft sind. Aus = Original-URL wie bisher.

export type ThumbWidth = 96 | 400 | 800 | 1600

const ENABLED     = import.meta.env.VITE_IMG_TRANSFORM === '1'
const SUPA_URL    = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
const PUBLIC_PATH = '/storage/v1/object/public/'
const RENDER_PATH = '/storage/v1/render/image/public/'
const IMAGE_EXT   = /\.(jpe?g|png|webp)$/i

export function thumb(url: string, { width }: { width: ThumbWidth }): string {
  if (!ENABLED || !SUPA_URL || !url.startsWith(SUPA_URL + PUBLIC_PATH)) return url
  if (url.includes('?') || url.includes('#') || !IMAGE_EXT.test(url)) return url
  const objectPath = url.slice(SUPA_URL.length + PUBLIC_PATH.length)
  return `${SUPA_URL}${RENDER_PATH}${objectPath}?width=${width}&quality=70&resize=contain`
}

/** Lädt die verkleinerte Fassung nicht (z. B. Datei über den Grenzen der
 *  Umwandlung), einmal auf das Original umschalten. true = umgeschaltet.
 *  Ein zweiter Fehler (Original kaputt) liefert false, also keine Schleife. */
export function retryWithOriginal(img: HTMLImageElement, original: string): boolean {
  if (!img.src.includes(RENDER_PATH)) return false
  img.src = original
  return true
}

/** onError-Handler für <img src={thumb(url, ...)}>: fällt auf `url` zurück. */
export function thumbFallback(original: string) {
  return (e: SyntheticEvent<HTMLImageElement>) => { retryWithOriginal(e.currentTarget, original) }
}
