import i18n, { type BackendModule, type ResourceKey, type TFunction } from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

// Jede Sprache ist ein eigener Chunk und wird erst bei Bedarf geladen. Vorher
// steckten de.json und en.json komplett im Einstiegs-Bundle (rund 170 KB gzip),
// obwohl fast alle Nutzer nur Deutsch sehen.
const LOCALES: Record<string, () => Promise<{ default: ResourceKey }>> = {
  de: () => import('../locales/de.json'),
  en: () => import('../locales/en.json'),
}

// Kleines i18next-Backend ohne Zusatzpaket. Codes ohne eigene Datei (z.B.
// 'de-DE' aus dem Browser) liefern bewusst nichts, genau wie bisher: die Suche
// fällt dann auf 'de' bzw. 'en' zurück.
const localeBackend: BackendModule = {
  type: 'backend',
  init() { /* nichts zu konfigurieren */ },
  read(lng, _ns, callback) {
    const load = LOCALES[lng]
    if (!load) { callback(null, null); return }
    load().then(
      // Bei Chunk-Fehler kann Vites vite:preloadError-Abfang (lazyWithReload)
      // den Fehler schlucken, dann kommt undefined statt Modul an.
      mod => mod?.default ? callback(null, mod.default) : callback(new Error(`Sprachdatei ${lng} nicht geladen`), null),
      err => callback(err instanceof Error ? err : new Error(String(err)), null),
    )
  },
}

// Promise auf die Startsprache samt Fallback 'de'. main.tsx rendert erst danach,
// damit nie rohe Schlüssel aufblitzen. initImmediate: false hält die Sprache wie
// bisher sofort nach dem Import gesetzt (i18n.language), nur die Texte kommen async.
export const i18nReady: Promise<unknown> = i18n
  .use(localeBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'de',
    interpolation: {
      escapeValue: false,
    },
    initImmediate: false,
  })

// Lädt eine Sprache (samt Fallback 'de') nach, bevor fest in ihr übersetzt wird
// (getFixedT / t mit lng). Ohne das käme z.B. für 'en' still der deutsche Text.
// Eigener Promise-Cache, weil i18n.loadLanguages bei einem zweiten Aufruf sofort
// zurückkehrt, auch wenn der erste noch lädt.
const languageLoads = new Map<string, Promise<void>>()
export function loadLanguage(lng: string): Promise<void> {
  let p = languageLoads.get(lng)
  if (!p) {
    p = i18n.loadLanguages(lng)
    languageLoads.set(lng, p)
  }
  return p
}

// Übersetzer fest in der Empfängersprache, erst nachdem sie geladen ist.
export async function fixedT(lng: string): Promise<TFunction> {
  await loadLanguage(lng)
  return i18n.getFixedT(lng)
}

export default i18n
