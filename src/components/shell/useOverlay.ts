import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Gemeinsames Verhalten für Mehr-Blatt und Suche:
//   - Escape schließt
//   - Tab bleibt innerhalb des Overlays (Fokus-Falle)
//   - Seiten-Scroll ist gesperrt, solange das Overlay offen ist
//   - beim Schließen geht der Fokus zurück auf das auslösende Element
// Mehrere Overlays gleichzeitig: der Zähler sorgt dafür, dass der Scroll erst
// wieder frei wird, wenn das letzte zu ist.
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

export function useOverlay(panelRef: RefObject<HTMLElement>, onClose: () => void): void {
  // onClose in einer Ref halten: der Effekt soll nur beim Öffnen und Schließen
  // laufen, nicht bei jedem neuen Funktionsobjekt des Aufrufers.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    lockBodyScroll()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
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
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      unlockBodyScroll()
      // Fokus nur zurückgeben, wenn das Element noch im Dokument hängt
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [panelRef])
}
