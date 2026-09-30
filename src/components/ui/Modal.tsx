import { useEffect, useId, useMemo, useRef, type FocusEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import Icon from '../shell/Icon'
import { useOverlay } from '../shell/useOverlay'
import { isTopLayer, pushLayer, removeLayer } from './overlayStack'
import { useEnterPhase } from './useEntered'

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  size?: ModalSize
  // Fußzeile (Knöpfe). Bleibt stehen, während der Inhalt scrollt.
  footer?: ReactNode
  children: ReactNode
  // Klick auf den abgedunkelten Hintergrund schließt (Standard: ja)
  closeOnBackdrop?: boolean
  // Element, das beim Öffnen den Fokus bekommt (sonst der Dialog selbst)
  initialFocusRef?: RefObject<HTMLElement>
  // Id einer eigenen Überschrift im Inhalt, wenn kein title gesetzt ist
  labelledBy?: string
  // Name für Screenreader, wenn es weder title noch labelledBy gibt
  ariaLabel?: string
  // Telefon: 'full' nutzt immer die volle Höhe (Formulare springen dann nicht,
  // wenn die Tastatur aufgeht), 'auto' ist so hoch wie der Inhalt (Bestätigung,
  // Aktionsmenü). Standard: 'auto' bei size 'sm', sonst 'full'.
  sheet?: 'auto' | 'full'
  // Ersetzt den Innenabstand des Inhalts (z.B. 'p-2' für Menülisten)
  bodyClassName?: string
}

const WIDTHS: Record<ModalSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
  full: 'sm:h-[90vh] sm:max-w-[min(96vw,84rem)]',
}

// Telefon: Blatt von unten, volle Höhe minus kleiner Abstand oben. 100dvh, wo
// der Browser es kennt (Adressleiste von Safari), sonst 100vh.
const SHEET_MAX = 'max-sm:max-h-[calc(100vh-1.5rem)] max-sm:supports-[height:100dvh]:max-h-[calc(100dvh-1.5rem)]'
const SHEET_FULL = 'max-sm:h-[calc(100vh-1.5rem)] max-sm:supports-[height:100dvh]:h-[calc(100dvh-1.5rem)]'

// Alles, was per Tab erreichbar ist (auch Felder, die useOverlay nicht kennt)
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

// Dialog über der Seite. Ebene z-[100]: über der Shell (z-30), dem Mehr-Blatt
// (z-40) und den bisherigen Seiten-Dialogen (bis z-[80]), unter der Suche
// (z-[130]). Unter sm ein Blatt von unten, ab sm eine Karte in der Mitte.
// Escape, Fokus-Falle, Scroll-Sperre der Seite und Fokus zurück auf den
// Auslöser kommen aus useOverlay.
export default function Modal(props: ModalProps) {
  if (!props.open) return null
  return <ModalPanel {...props} />
}

function ModalPanel({
  onClose, title, size = 'md', footer, children, closeOnBackdrop = true,
  initialFocusRef, labelledBy, ariaLabel, sheet, bodyClassName,
}: ModalProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const layerId = useId()
  const titleId = useId()
  const phase = useEnterPhase()
  const entered = phase !== 'before'
  // Nach der Einblendung ohne Transition: der Zielzustand hängt dann nicht mehr
  // an der Animations-Uhr (siehe useEnterPhase)
  const settled = phase === 'done'

  // Liegen mehrere Dialoge übereinander, reagiert nur der oberste: die Ref für
  // die Fokus-Falle ist für alle darunter leer, Escape wird dort verworfen.
  const trapRef = useMemo<RefObject<HTMLElement>>(() => ({
    get current() { return isTopLayer(layerId) ? panelRef.current : null },
  }), [layerId])
  useOverlay(trapRef, () => { if (isTopLayer(layerId)) onClose() })

  useEffect(() => {
    pushLayer(layerId)
    return () => removeLayer(layerId)
  }, [layerId])

  // Fokus in den Dialog. Steht NACH useOverlay: der Hook merkt sich vorher,
  // welches Element den Dialog geöffnet hat.
  useEffect(() => {
    const target = initialFocusRef?.current ?? panelRef.current
    target?.focus({ preventScroll: true })
    // Bewusst ohne Abhängigkeiten: nur beim Öffnen, nicht bei jedem neuen
    // Ref-Objekt des Aufrufers
  }, [])

  const realTabbables = (): HTMLElement[] => {
    const panel = panelRef.current
    if (!panel) return []
    return Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE))
      .filter(el => el.offsetParent !== null && !el.hasAttribute('data-hp-focus-guard'))
  }
  // Wächter am Anfang und Ende: useOverlay kennt nur Links, Knöpfe und
  // Eingabefelder. Ein Textfeld oder Auswahlfeld am Ende des Dialogs wäre sonst
  // per Tab nicht erreichbar bzw. der Fokus liefe aus dem Dialog heraus.
  const onStartGuard = (e: FocusEvent<HTMLSpanElement>) => {
    const panel = panelRef.current
    const items = realTabbables()
    if (!panel || items.length === 0) { panel?.focus({ preventScroll: true }); return }
    const from = e.relatedTarget
    const fromInside = from instanceof Node && from !== panel && panel.contains(from)
    ;(fromInside ? items[items.length - 1] : items[0]).focus()
  }
  const onEndGuard = (e: FocusEvent<HTMLSpanElement>) => {
    const panel = panelRef.current
    const items = realTabbables()
    if (!panel || items.length === 0) { panel?.focus({ preventScroll: true }); return }
    // Vom Dialog selbst kommt der Fokus nur per Umschalt+Tab hierher (useOverlay
    // springt dann auf das letzte Element): weiter zum letzten echten Element.
    ;(e.relatedTarget === panel ? items[items.length - 1] : items[0]).focus()
  }

  const sheetMode = sheet ?? (size === 'sm' ? 'auto' : 'full')
  const label = labelledBy ?? (title ? titleId : undefined)

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      {/* Hintergrund: Klick schließt (abschaltbar) */}
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined}
        className={`absolute inset-0 bg-hp-navy/50 ${settled ? 'transition-none' : 'transition-opacity duration-200 motion-reduce:transition-none'} ${entered ? 'opacity-100' : 'opacity-0'}`}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={label}
        aria-label={label ? undefined : ariaLabel ?? t('ui.modal.dialog')}
        tabIndex={-1}
        className={`relative flex w-full flex-col rounded-t-2xl bg-white shadow-2xl ${settled ? 'transition-none' : 'transition duration-200 ease-out motion-reduce:transition-none'} focus:outline-none sm:max-h-[90vh] sm:rounded-2xl ${SHEET_MAX} ${sheetMode === 'full' ? SHEET_FULL : ''} ${WIDTHS[size]} ${
          entered ? 'transform-none opacity-100' : 'opacity-0 max-sm:translate-y-full sm:scale-95'
        }`}
      >
        <span tabIndex={0} data-hp-focus-guard="" onFocus={onStartGuard} className="sr-only" />

        {/* Griff des Blatts (nur Telefon, reine Zierde) */}
        <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-gray-200 sm:hidden" />

        {/* Kopf: Titel + Schließen */}
        <div className={`flex shrink-0 items-center gap-3 pl-5 pr-2 pt-1 sm:pt-2 ${title ? 'justify-between border-b border-gray-100 pb-1 sm:pb-2' : 'justify-end'}`}>
          {title && <h2 id={titleId} className="min-w-0 break-words font-heading text-lg text-hp-navy">{title}</h2>}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('ui.modal.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40"
          >
            <Icon name="close" size={22} />
          </button>
        </div>

        {/* Inhalt: scrollt im Dialog, die Seite dahinter ist gesperrt */}
        <div
          className={`min-h-0 flex-1 overflow-y-auto overscroll-contain font-body ${bodyClassName ?? 'px-5 py-4'} ${
            footer ? '' : 'max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))]'
          }`}
        >
          {children}
        </div>

        {/* Fußzeile: bleibt stehen. Telefon: Knöpfe untereinander, der letzte
            (die Hauptaktion) oben; ab sm nebeneinander rechts. */}
        {footer && (
          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-gray-100 bg-white px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:items-center sm:justify-end sm:rounded-b-2xl sm:pb-3">
            {footer}
          </div>
        )}

        <span tabIndex={0} data-hp-focus-guard="" onFocus={onEndGuard} className="sr-only" />
      </div>
    </div>,
    document.body,
  )
}
