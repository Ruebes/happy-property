// Die Erklaertexte sind gross (je Sprache rund 270 kB). Sie werden deshalb nicht
// mit den Sprachdateien ins Haupt-Bundle geladen, sondern erst mit der
// Strategieseite (Strategie.tsx und die Vorschau im Simulator).
import type { i18n as I18n } from 'i18next'
import de from '../../locales/guides/de.json'
import en from '../../locales/guides/en.json'

const done = new WeakSet<object>()

export function ensureGuideTexts(i18n: I18n): void {
  if (done.has(i18n)) return
  i18n.addResourceBundle('de', 'translation', de, true, false)
  i18n.addResourceBundle('en', 'translation', en, true, false)
  done.add(i18n)
}
