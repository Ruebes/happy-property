import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import Icon, { type IconId } from '../shell/Icon'
import { useEnterPhase } from './useEntered'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  // Knopf im Hinweis (z.B. "Rückgängig"); ein Klick schließt den Hinweis
  action?: ToastAction
  // Anzeigedauer in Millisekunden (Standard: 4 s, Fehler 8 s)
  duration?: number
}

export interface ToastApi {
  success: (message: string, options?: ToastOptions) => string
  error: (message: string, options?: ToastOptions) => string
  info: (message: string, options?: ToastOptions) => string
  // Ohne Id: alle schließen
  dismiss: (id?: string) => void
}

interface ToastItem {
  id: string
  kind: ToastKind
  message: string
  action?: ToastAction
  duration: number
}

const DEFAULT_MS = 4000
const ERROR_MS = 8000
const MAX_STACK = 3

const KIND_ICON: Record<ToastKind, IconId> = { success: 'confirmation', error: 'alert', info: 'info' }
const KIND_COLOR: Record<ToastKind, string> = { success: 'text-emerald-600', error: 'text-red-600', info: 'text-hp-navy' }
const KIND_BAR: Record<ToastKind, string> = { success: 'bg-emerald-500', error: 'bg-red-500', info: 'bg-hp-navy' }

const ToastContext = createContext<ToastApi | null>(null)

// Höhe der Telefon-Leiste. Der ShellFrame setzt --hp-bottom-offset an seinem
// eigenen Rahmen; die Hinweise hängen aber direkt am body (Portal) und erben
// die Variable nicht. Darum wird ihr Wert am Shell-Inhalt gelesen und an die
// Hinweis-Fläche weitergegeben. Ohne Shell (alte Navigation, öffentliche
// Seiten) bleibt es bei 0.
function readBottomOffset(): string {
  try {
    const main = document.getElementById('hp-shell-main')
    if (!main) return ''
    return getComputedStyle(main).getPropertyValue('--hp-bottom-offset').trim()
  } catch { return '' }
}

// Stellt toast.success / toast.error / toast.info für alles darunter bereit und
// zeichnet die Hinweise: ab md oben rechts unter der oberen Leiste (72 px),
// auf dem Telefon unten in der Mitte über der Telefon-Leiste. Ebene z-[110]
// (über Dialogen, unter der Suche). Höchstens drei gleichzeitig, der älteste
// weicht. Ersetzt die lokalen Toast-Bausteine der Seiten und alert().
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<ToastItem[]>([])
  const [bottomOffset, setBottomOffset] = useState('')
  const nextId = useRef(1)

  const dismiss = useCallback((id?: string) => {
    setItems(prev => (id === undefined ? [] : prev.filter(item => item.id !== id)))
  }, [])

  const api = useMemo<ToastApi>(() => {
    const push = (kind: ToastKind, message: string, options?: ToastOptions): string => {
      const id = `toast-${nextId.current++}`
      const duration = options?.duration ?? (kind === 'error' ? ERROR_MS : DEFAULT_MS)
      setItems(prev => [...prev, { id, kind, message, action: options?.action, duration }].slice(-MAX_STACK))
      return id
    }
    return {
      success: (message, options) => push('success', message, options),
      error: (message, options) => push('error', message, options),
      info: (message, options) => push('info', message, options),
      dismiss,
    }
  }, [dismiss])

  // Abstand zur Telefon-Leiste neu lesen, sobald Hinweise da sind und wenn sich
  // die Fensterbreite ändert (ab md ist der Wert 0)
  const visible = items.length > 0
  useEffect(() => {
    if (!visible) return
    const update = () => setBottomOffset(readBottomOffset())
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [visible])

  const style = bottomOffset ? ({ '--hp-bottom-offset': bottomOffset } as CSSProperties) : undefined

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          role="region"
          aria-live="polite"
          aria-label={t('ui.toast.region')}
          style={style}
          className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--hp-bottom-offset,0px)+1rem)] z-[110] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:bottom-auto md:right-4 md:top-[72px] md:w-96 md:max-w-[calc(100vw-2rem)] md:flex-col-reverse md:items-end md:px-0"
        >
          {items.map(item => <ToastCard key={item.id} item={item} onDismiss={dismiss} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

interface ToastCardProps {
  item: ToastItem
  onDismiss: (id: string) => void
}

function ToastCard({ item, onDismiss }: ToastCardProps) {
  const { t } = useTranslation()
  const phase = useEnterPhase()
  // Solange der Zeiger darauf steht oder der Fokus darin liegt, läuft die Zeit nicht ab
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => onDismiss(item.id), item.duration)
    return () => window.clearTimeout(timer)
  }, [paused, item.id, item.duration, onDismiss])

  const runAction = () => {
    onDismiss(item.id)
    item.action?.onClick()
  }

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`pointer-events-auto relative flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-xl border border-gray-100 bg-white py-2 pl-4 pr-1 shadow-lg ${
        phase === 'done' ? 'transition-none' : 'transition duration-200 ease-out motion-reduce:transition-none'
      } ${phase === 'before' ? 'translate-y-2 opacity-0 md:-translate-y-2' : 'transform-none opacity-100'}`}
    >
      {/* Schmale Farbkante links: Art des Hinweises */}
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${KIND_BAR[item.kind]}`} />
      <Icon name={KIND_ICON[item.kind]} size={20} title={t(`ui.toast.${item.kind}`)} className={`mt-2.5 shrink-0 ${KIND_COLOR[item.kind]}`} />
      <div className="min-w-0 flex-1 py-2.5">
        <p className="break-words text-sm font-body text-hp-navy">{item.message}</p>
        {item.action && (
          <button
            type="button"
            onClick={runAction}
            className="mt-1 inline-flex min-h-[44px] items-center text-sm font-semibold font-body text-hp-navy underline underline-offset-4 hover:text-hp-navy/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 md:min-h-[32px]"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label={t('ui.toast.dismiss')}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40"
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  )
}

// Ersatz ohne ToastProvider: nichts werfen. Fehler dürfen nie lautlos
// verschwinden, sie erscheinen dann als alert(); Erfolg und Info entfallen.
// Im Dev-Server steht zusätzlich ein Hinweis in der Konsole.
const FALLBACK: ToastApi = (() => {
  const quiet = (message: string): string => {
    if (import.meta.env.DEV) console.warn('useToast ohne ToastProvider, Hinweis entfällt:', message)
    return ''
  }
  const loud = (message: string): string => {
    window.alert(message)
    return ''
  }
  return { success: quiet, error: loud, info: quiet, dismiss: () => {} }
})()

// const toast = useToast()
// toast.success('Gespeichert')
// toast.error('Speichern fehlgeschlagen', { action: { label: 'Erneut versuchen', onClick: save } })
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? FALLBACK
}
