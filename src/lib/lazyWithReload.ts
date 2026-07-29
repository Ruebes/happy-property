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

// Service-Worker (PWA) + alle Caches löschen, DANN neu laden. Nötig, weil ein
// simpler reload() sonst wieder die ALTE, vom Service-Worker gecachte index.html
// samt toter Chunks bekommt → Endlos-Hänger, den selbst „harter Reload" (v.a. in
// Safari) nicht bricht. Session (localStorage) bleibt bewusst erhalten — nur der
// Code-Cache wird geleert, der Nutzer bleibt eingeloggt.
async function purgeAndReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    }
  } catch { /* im Zweifel trotzdem neu laden */ }
  // Cache-Buster in der URL erzwingt frische index.html vom Netz.
  const u = new URL(window.location.href)
  u.searchParams.set('v', String(Date.now()))
  window.location.replace(u.toString())
}

function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false   // schon einmal versucht → nicht erneut
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
  } catch { /* sessionStorage evtl. blockiert → trotzdem einmal versuchen */ }
  void purgeAndReload()
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
