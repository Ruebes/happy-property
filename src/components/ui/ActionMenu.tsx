import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type ReactNode, type TouchEvent as ReactTouchEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import Icon, { type IconId } from '../shell/Icon'
import { useMediaQuery } from '../shell/useMediaQuery'
import Modal from './Modal'
import { isTopLayer, pushLayer, removeLayer } from '../shell/overlayStack'

export interface ActionItem {
  id: string
  label: string
  icon?: IconId
  onClick: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
  hidden?: boolean
}

// Bezugsfläche des Menüs in Fenster-Koordinaten (Knopf oder Zeigerposition)
export interface MenuAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

type MenuAlign = 'start' | 'end'

// Abstand zur Bezugsfläche und Mindestabstand zum Fensterrand
const GAP = 4
const EDGE = 8

const ITEM =
  'flex w-full items-center gap-3 text-left font-body transition-colors focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-40'
const ITEM_DEFAULT = 'text-gray-700 hover:bg-gray-50 focus-visible:bg-gray-50'
const ITEM_DANGER = 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50'

function visibleItems(items: ActionItem[]): ActionItem[] {
  return items.filter(item => !item.hidden)
}

// Klicks aus dem Menü laufen in React durch das Portal zu den Eltern des
// Aufrufers weiter (z.B. zu einer anklickbaren Zeile). Das Menü hält sie auf.
function stopClick(e: ReactMouseEvent): void {
  e.stopPropagation()
}

interface MenuSurfaceProps {
  items: ActionItem[]
  anchor: MenuAnchor
  // 'end': rechte Kante des Menüs an der rechten Kante der Bezugsfläche (Knopf),
  // 'start': linke Kante an der linken (Zeigerposition)
  align?: MenuAlign
  // Titel des Blatts auf dem Telefon und Name für Screenreader
  title?: string
  onClose: () => void
  // Element, das nach dem Schließen den Fokus bekommt (Popover)
  restoreFocus?: HTMLElement | null
}

// Das Menü selbst: unter sm ein Blatt von unten (Modal), ab sm ein Popover an
// der Bezugsfläche. Ein Klick auf einen Eintrag schließt zuerst das Menü und
// führt dann die Aktion aus (öffnet die Aktion einen Dialog, ist der Fokus
// vorher schon zurück beim Auslöser).
export function MenuSurface({ items, anchor, align = 'end', title, onClose, restoreFocus }: MenuSurfaceProps) {
  const { t } = useTranslation()
  const isWide = useMediaQuery('(min-width: 640px)')
  const shown = visibleItems(items)
  const label = title ?? t('ui.actionMenu.title')

  const run = (item: ActionItem) => {
    if (item.disabled) return
    onClose()
    item.onClick()
  }

  if (!isWide) {
    return (
      <Modal open onClose={onClose} title={label} size="sm" bodyClassName="p-2">
        <ul role="menu" aria-label={label}>
          {shown.map(item => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => run(item)}
                className={`${ITEM} min-h-[48px] rounded-lg px-3 text-base focus-visible:ring-2 focus-visible:ring-hp-navy/70 ${item.tone === 'danger' ? ITEM_DANGER : ITEM_DEFAULT}`}
              >
                {item.icon && <Icon name={item.icon} size={20} className={`shrink-0 ${item.tone === 'danger' ? '' : 'text-gray-400'}`} />}
                <span className="min-w-0 flex-1 break-words">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    )
  }

  return <MenuPopover items={shown} anchor={anchor} align={align} label={label} onClose={onClose} onRun={run} restoreFocus={restoreFocus} />
}

interface MenuPopoverProps {
  items: ActionItem[]
  anchor: MenuAnchor
  align: MenuAlign
  label: string
  onClose: () => void
  onRun: (item: ActionItem) => void
  restoreFocus?: HTMLElement | null
}

// Popover ab sm: hängt am body (Portal), Ebene z-[105] (über Dialogen, unter
// den Hinweisen). Die Position wird nach dem ersten Zeichnen gemessen und ins
// Fenster geklemmt: nie rechts oder unten abgeschnitten; passt es unten nicht,
// klappt es nach oben.
function MenuPopover({ items, anchor, align, label, onClose, onRun, restoreFocus }: MenuPopoverProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const layerId = useId()
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  // Nach jedem Zeichnen messen (Einträge oder Bezugsfläche können sich ändern).
  // Gleiche Werte lösen kein neues Zeichnen aus.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const viewW = document.documentElement.clientWidth
    const viewH = window.innerHeight
    const wanted = align === 'end' ? anchor.right - width : anchor.left
    const left = Math.max(EDGE, Math.min(wanted, viewW - width - EDGE))
    let top = anchor.bottom + GAP
    if (top + height > viewH - EDGE) {
      const above = anchor.top - GAP - height
      top = above >= EDGE ? above : Math.max(EDGE, viewH - height - EDGE)
    }
    setPos(prev => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  })

  // Oberste Ebene: ein Dialog darunter ignoriert solange Escape und Tab
  useEffect(() => {
    pushLayer(layerId)
    return () => removeLayer(layerId)
  }, [layerId])

  const enabledButtons = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? [])

  // Fokus auf den ersten Eintrag, sobald das Menü an seinem Platz sichtbar ist
  const placed = pos !== null
  useEffect(() => {
    if (!placed) return
    const first = enabledButtons()[0]
    ;(first ?? menuRef.current)?.focus({ preventScroll: true })
  }, [placed])

  // Schließen: Klick daneben, Escape, Scrollen der Seite, Fenstergröße.
  // Escape hängt (wie in useOverlay) in der Capture-Phase am Dokument, weil ein
  // offener Dialog darunter die Taste sonst abfängt.
  useEffect(() => {
    const opener = restoreFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const inside = (target: EventTarget | null) => target instanceof Node && menuRef.current?.contains(target) === true
    // Ein Druck auf den Auslöser selbst schließt nicht hier: dessen Klick
    // schaltet um (sonst ginge das Menü zu und sofort wieder auf).
    const onOpener = (target: EventTarget | null) => target instanceof Node && restoreFocus?.contains(target) === true
    const onPointerDown = (e: PointerEvent) => { if (!inside(e.target) && !onOpener(e.target)) closeRef.current() }
    const onKeyDown = (e: KeyboardEvent) => {
      // Liegt etwas darüber (z.B. die Suche per Strg K), schließt das zuerst
      if (e.key !== 'Escape' || !isTopLayer(layerId)) return
      e.stopPropagation()
      closeRef.current()
    }
    const onScroll = (e: Event) => { if (!inside(e.target)) closeRef.current() }
    const onResize = () => closeRef.current()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [restoreFocus, layerId])

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') { closeRef.current(); return }
    const buttons = enabledButtons()
    if (buttons.length === 0) return
    const current = buttons.findIndex(button => button === document.activeElement)
    let next = -1
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % buttons.length
    else if (e.key === 'ArrowUp') next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttons.length - 1
    if (next < 0) return
    e.preventDefault()
    buttons[next].focus()
  }

  const style: CSSProperties = pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
      onClick={stopClick}
      style={style}
      className="fixed z-[105] max-h-[calc(100vh-16px)] min-w-[12rem] max-w-[min(20rem,calc(100vw-16px))] overflow-y-auto overscroll-contain rounded-xl border border-gray-100 bg-white py-1 shadow-xl shadow-black/10 focus:outline-none"
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => onRun(item)}
          className={`${ITEM} min-h-[36px] px-3 py-1.5 text-sm ${item.tone === 'danger' ? ITEM_DANGER : ITEM_DEFAULT}`}
        >
          {item.icon && <Icon name={item.icon} size={16} className={`shrink-0 ${item.tone === 'danger' ? '' : 'text-gray-400'}`} />}
          <span className="min-w-0 flex-1 break-words">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

interface ActionMenuProps {
  items: ActionItem[]
  // Name des Knopfs für Screenreader (z.B. "Aktionen für Wohnung A-12")
  label?: string
  // Titel des Blatts auf dem Telefon (Standard: "Aktionen")
  title?: string
  className?: string
}

// Sichtbarer "Mehr"-Knopf (drei Punkte) mit Menü. Auf dem Telefon 44 px groß,
// ab sm 36 px. Ohne sichtbare Einträge erscheint nichts.
export default function ActionMenu({ items, label, title, className = '' }: ActionMenuProps) {
  const { t } = useTranslation()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const close = useCallback(() => setAnchor(null), [])

  if (visibleItems(items).length === 0) return null

  const toggle = () => {
    if (anchor) { setAnchor(null); return }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
  }
  const name = label ?? t('ui.actionMenu.open')

  return (
    <span className={`inline-flex shrink-0 ${className}`} onClick={stopClick}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={name}
        title={name}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-hp-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70 sm:h-9 sm:w-9"
      >
        <Icon name="more" size={20} />
      </button>
      {anchor && (
        <MenuSurface items={items} anchor={anchor} align="end" title={title} onClose={close} restoreFocus={buttonRef.current} />
      )}
    </span>
  )
}

// Einträge fest oder als Funktion (wird erst beim Öffnen ausgewertet)
export type MenuItemsInput = ActionItem[] | (() => ActionItem[])

export interface ContextMenuHandlers {
  onContextMenu: (e: ReactMouseEvent) => void
  onTouchStart: (e: ReactTouchEvent) => void
  onTouchMove: (e: ReactTouchEvent) => void
  onTouchEnd: (e: ReactTouchEvent) => void
  onTouchCancel: (e: ReactTouchEvent) => void
}

export interface ContextMenu {
  // Für genau ein Element: <div {...ctx.handlers}>
  handlers: ContextMenuHandlers
  // Für Listen, je Zeile eigene Einträge: <li {...ctx.bind(() => actionsFor(row))}>
  bind: (items: MenuItemsInput) => ContextMenuHandlers
  // Einmal rendern, am besten neben der Liste (nicht in <tr> oder <ul>)
  menu: ReactNode
  isOpen: boolean
  close: () => void
}

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10

function resolveItems(input: MenuItemsInput): ActionItem[] {
  return typeof input === 'function' ? input() : input
}

// Rechtsklick-Menü mit Entsprechung für den Finger: 500 ms gedrückt halten
// öffnet dasselbe Menü (Bewegung bricht ab). Auf dem Telefon als Blatt von
// unten, sonst als Popover an der Zeigerposition.
//
//   const ctx = useContextMenu(items)
//   <div {...ctx.handlers} className="select-none [-webkit-touch-callout:none]">...</div>
//   {ctx.menu}
//
// Die beiden Klassen verhindern, dass iOS beim Halten Text markiert oder die
// Link-Vorschau zeigt.
export function useContextMenu(items: MenuItemsInput = [], options?: { title?: string }): ContextMenu {
  const [state, setState] = useState<{ anchor: MenuAnchor; items: ActionItem[] } | null>(null)
  const timer = useRef<number | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  // Der lange Druck hat in dieser Berührung schon ausgelöst
  const fired = useRef(false)
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  const close = useCallback(() => setState(null), [])

  const openAt = useCallback((x: number, y: number, list: ActionItem[]) => {
    setState({ anchor: { left: x, top: y, right: x, bottom: y }, items: list })
  }, [])

  // Einträge zuerst auswerten: gibt es keinen sichtbaren (z.B. Rolle ohne
  // Aktionen), bleibt alles wie ohne Menü. Das Browser-Menü (Kopieren, Link in
  // neuem Tab) erscheint dann weiter, und das Antippen öffnet die Zeile.
  const bind = useCallback((input: MenuItemsInput): ContextMenuHandlers => ({
    onContextMenu: e => {
      // Android meldet den langen Druck zusätzlich als contextmenu: das eigene
      // Menü ist dann schon offen, das des Browsers bleibt weg
      if (fired.current) { e.preventDefault(); return }
      const list = resolveItems(input)
      if (visibleItems(list).length === 0) return
      e.preventDefault()
      clearTimer()
      let x = e.clientX
      let y = e.clientY
      if (x === 0 && y === 0) {
        // Menütaste der Tastatur: Mitte des Elements
        const rect = e.currentTarget.getBoundingClientRect()
        x = rect.left + rect.width / 2
        y = rect.top + rect.height / 2
      }
      openAt(x, y, list)
    },
    onTouchStart: e => {
      clearTimer()
      fired.current = false
      if (e.touches.length !== 1) { start.current = null; return }
      const x = e.touches[0].clientX
      const y = e.touches[0].clientY
      start.current = { x, y }
      timer.current = window.setTimeout(() => {
        timer.current = null
        const list = resolveItems(input)
        if (visibleItems(list).length === 0) return
        fired.current = true
        openAt(x, y, list)
      }, LONG_PRESS_MS)
    },
    onTouchMove: e => {
      const from = start.current
      const touch = e.touches[0]
      if (!from || !touch) return
      if (Math.abs(touch.clientX - from.x) > MOVE_TOLERANCE_PX || Math.abs(touch.clientY - from.y) > MOVE_TOLERANCE_PX) clearTimer()
    },
    onTouchEnd: e => {
      clearTimer()
      start.current = null
      // Nach einem ausgelösten langen Druck den Klick unterdrücken, der dem
      // Loslassen sonst folgt (die Zeile würde sich zusätzlich öffnen)
      const wasFired = fired.current
      fired.current = false
      if (wasFired && e.cancelable) e.preventDefault()
    },
    onTouchCancel: () => {
      clearTimer()
      start.current = null
      fired.current = false
    },
  }), [clearTimer, openAt])

  const handlers = useMemo(() => bind(() => resolveItems(itemsRef.current)), [bind])

  const menu = state ? (
    <span className="hidden" onClick={stopClick}>
      <MenuSurface items={state.items} anchor={state.anchor} align="start" title={options?.title} onClose={close} />
    </span>
  ) : null

  return { handlers, bind, menu, isOpen: state !== null, close }
}
