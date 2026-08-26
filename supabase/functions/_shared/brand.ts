// Corporate Identity von Happy Property — EINE Quelle für alle Edge Functions,
// die etwas Sichtbares erzeugen (Werbemittel, Social-Grafiken, Thumbnails, Mails).
//
// Sven-Vorgabe (26.8.2026): Farben und Schriftarten müssen IMMER am CI hängen.
// Deshalb stehen sie hier zentral und werden NICHT mehr je Function neu
// erfunden. Wer ein neues Bild-/Grafik-Feature baut, importiert von hier:
//
//   import { CI, CI_FONT, loadCiFonts, CI_LOOK } from '../_shared/brand.ts'
//
// Die Werte spiegeln die Web-Tokens aus src/styles/globals.css und
// tailwind.config.js (--color-bg / --color-highlight / --font-heading /
// --font-body). Ändert sich das CI, ändert es sich HIER und im globals.css.
//
// ACHTUNG: Jede Edge Function bündelt ihre eigene Kopie der _shared-Dateien.
// Nach einer Änderung hier ALLE importierenden Functions neu deployen
// (`grep -rln "_shared/brand" supabase/functions/`).

/** Markenfarben. Namen wie in newsletter-campaign/compose-deck-mail. */
export const CI = {
  /** Grundfläche, warmes Creme — Hintergrund von Panels und Mails */
  cream: '#fffcf6',
  /** Dunkles Marineblau — Überschriften und Fließtext auf Creme */
  navy: '#1a2332',
  /** Korall-Akzent — Badges, Buttons, Hervorhebungen */
  coral: '#ff795d',
  /** Sehr helles Korall — Flächen hinter Korall-Text */
  coralSoft: '#fff0ec',
  /** Fließtext-Schwarz (weicher als reines Schwarz) */
  ink: '#2a2a2a',
  /** Trennlinien auf Creme */
  line: '#e6dfd0',
  /** Zweitakzent Gold — sparsam, für Wertigkeit */
  gold: '#C2A15E',
  /** Sekundärtext */
  mute: '#9a9aa3',
  /** Navy, noch dunkler — grossflächige Hintergründe */
  navyDeep: '#111a24',
  /** Navy, aufgehellt — Karten/Flächen auf Navy */
  navySoft: '#24303f',
  white: '#ffffff',
} as const

/** Schriftfamilien wie im Web: Überschrift Serif, Fließtext Sans. */
export const CI_FONT = {
  heading: 'Playfair Display',
  body: 'Montserrat',
} as const

// Google liefert echte TTF-Dateien (eine Datei je Schnitt) aus, wenn man die
// CSS-API mit einem alten User-Agent anfragt. Das ist wichtig, weil resvg
// Variable Fonts nur in ihrer Standardachse rendert — Fett wäre dann nicht fett.
const CI_FONT_CSS =
  'https://fonts.googleapis.com/css?family=Playfair+Display:400,700|Montserrat:400,600,700'
// Notnagel, falls Google nicht erreichbar ist: lieber Open Sans als gar kein Text.
const FALLBACK_FONTS = [
  'https://cdn.jsdelivr.net/gh/googlefonts/opensans@main/fonts/ttf/OpenSans-Bold.ttf',
  'https://cdn.jsdelivr.net/gh/googlefonts/opensans@main/fonts/ttf/OpenSans-Regular.ttf',
]

let _fonts: Uint8Array[] | null = null

/**
 * Lädt die CI-Schriften als TTF-Puffer für resvg
 * (`font: { fontBuffers, defaultFontFamily: CI_FONT.body }`).
 * Ergebnis wird pro Instanz zwischengespeichert.
 */
export async function loadCiFonts(): Promise<Uint8Array[]> {
  if (_fonts) return _fonts
  const bufs: Uint8Array[] = []
  try {
    const css = await fetch(CI_FONT_CSS, { headers: { 'User-Agent': 'Mozilla/4.0' } })
    if (css.ok) {
      const urls = [...(await css.text()).matchAll(/url\((https:\/\/[^)]+\.ttf)\)/g)].map(m => m[1])
      for (const u of urls) {
        try { const r = await fetch(u); if (r.ok) bufs.push(new Uint8Array(await r.arrayBuffer())) }
        catch { /* einzelner Schnitt fehlt — die anderen reichen */ }
      }
    }
  } catch { /* unten Fallback */ }
  if (!bufs.length) {
    for (const u of FALLBACK_FONTS) {
      try { const r = await fetch(u); if (r.ok) bufs.push(new Uint8Array(await r.arrayBuffer())) }
      catch { /* Schrift optional — resvg rendert dann mit Ersatzschrift */ }
    }
  }
  _fonts = bufs
  return bufs
}

/**
 * CI-Hinweis für Bild-KI-Prompts. Fotos bleiben fotorealistisch, aber die
 * Farbwelt soll zur Marke passen, damit gerendertes Overlay und Foto
 * zusammengehören.
 */
export const CI_LOOK =
  'Colour world: warm cream and sand tones, soft natural Mediterranean light, deep navy accents; ' +
  'a warm coral accent may appear. Avoid loud saturated colours, neon, and heavy colour filters.'
