import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

// Wrapper um React.lazy, der veraltete Chunks nach einem Deploy automatisch abfängt.
//
// Problem (Spinner-Hänger im Portal): Eine lange offene Tab-Session lädt die alte
// index.html mit alten JS-Dateinamen. Nach einem neuen Deploy existieren diese Chunks
// nicht mehr (neue Hashes). Navigiert der Nutzer dann auf eine noch nicht geladene
// Lazy-Route, schlägt import() fehl → der <Suspense>-Spinner hängt ewig, und nur ein
// manueller Reload (Return in der Adressleiste) holt die frische index.html.
//
// Lösung: Bei Chunk-Ladefehler EINMALIG automatisch neu laden (sessionStorage-Guard
// gegen Endlos-Reload). Der Reload zieht die neue index.html + die neuen Chunks.

const RELOAD_FLAG = 'hp_chunk_reloaded'

function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false   // schon einmal versucht → nicht erneut
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
  } catch { /* sessionStorage evtl. blockiert → trotzdem einmal versuchen */ }
  window.location.reload()
  return true
}

export function lazyWithReload<T extends ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await factory()
      try { sessionStorage.removeItem(RELOAD_FLAG) } catch { /* egal */ }   // Erfolg → Guard zurücksetzen
      return mod
    } catch (err) {
      // Chunk konnte nicht geladen werden → einmalig hart neu laden.
      if (reloadOnce()) {
        // Reload läuft bereits → einen nie auflösenden Promise zurückgeben,
        // damit kein Fehler-Flash erscheint, bis der Reload greift.
        return await new Promise<{ default: T }>(() => { /* never resolves */ })
      }
      throw err   // bereits einmal neu geladen → echten Fehler durchreichen
    }
  })
}

// Vite meldet fehlgeschlagene dynamische Importe zusätzlich global (modulepreload).
// Auch hier einmalig neu laden, damit der Fall vor dem React-Render abgefangen wird.
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault()
    reloadOnce()
  })
}
