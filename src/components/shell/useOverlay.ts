import { useEffect, useId, useRef, type RefObject } from 'react'
import { isTopLayer, pushLayer, removeLayer } from './overlayStack'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Gemeinsames Verhalten für Mehr-Blatt, Suche und Dialoge:
//   - Escape schließt
//   - Tab bleibt innerhalb des Overlays (Fokus-Falle)
//   - Seiten-Scroll ist gesperrt, solange das Overlay offen ist
//   - beim Schließen geht der Fokus zurück auf das auslösende Element
// Mehrere Overlays gleichzeitig: der Zähler sorgt dafür, dass der Scroll erst
// wieder frei wird, wenn das letzte zu ist. Escape und Tab bedient nur das
// oberste Overlay (overlayStack), die darunter halten still.
let lockCount = 0
let previousOverflow = ''

function lockBodyScroll(): void {
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount++
}

function unlockBodyScroll(): void {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) document.body.style.overflow = previousOverflow
}

export interface OverlayOptions {
  // Escape schon in der Capture-Phase abfangen (Standard: ja). Mit false erst in
  // der Bubble-Phase: Bausteine im Overlay (z.B. eine offene Auswahlliste)
  // bekommen die Taste dann zuerst und können sie für sich behalten, statt dass
  // gleich das ganze Overlay samt Eingaben zugeht. So arbeitet der Dialog.
  escapeCapture?: boolean
}

export function useOverlay(panelRef: RefObject<HTMLElement>, onClose: () => void, options?: OverlayOptions): void {
  // onClose in einer Ref halten: der Effekt soll nur beim Öffnen und Schließen
  // laufen, nicht bei jedem neuen Funktionsobjekt des Aufrufers.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  const layerId = useId()
  const escapeCapture = options?.escapeCapture ?? true

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    lockBodyScroll()
    pushLayer(layerId)

    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopLayer(layerId)) return
      e.stopPropagation()
      closeRef.current()
    }

    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !isTopLayer(layerId)) return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (active === panel) {
        // Fokus liegt auf dem Overlay selbst (Mehr-Blatt direkt nach dem Öffnen):
        // ohne diese Zeile liefe Umschalt+Tab aus dem Overlay heraus.
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (!panel.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onTab, true)
    document.addEventListener('keydown', onEscape, escapeCapture)

    return () => {
      document.removeEventListener('keydown', onTab, true)
      document.removeEventListener('keydown', onEscape, escapeCapture)
      removeLayer(layerId)
      unlockBodyScroll()
      // Fokus nur zurückgeben, wenn das Element noch im Dokument hängt
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [panelRef, layerId, escapeCapture])
}
