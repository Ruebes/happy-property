import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'

export type ConfirmTone = 'default' | 'danger'

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  // Ohne Angabe: "Bestätigen" / "Abbrechen"
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
}

interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

// Knöpfe: auf dem Telefon mindestens 44 px hoch (steckt in .hp-btn)
const CANCEL = 'hp-btn hp-btn-ghost'

// Rückfrage vor einer Aktion. Gesteuerte Komponente; im Alltag nimmt man
// useConfirm() (unten), das ersetzt window.confirm.
// Fokus beim Öffnen: bei tone 'danger' auf "Abbrechen" (Enter löscht nicht aus
// Versehen), sonst auf der Bestätigung.
export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, tone = 'default', onConfirm, onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const danger = tone === 'danger'

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      bodyClassName={message ? undefined : 'p-0'}
      initialFocusRef={danger ? cancelRef : confirmRef}
      footer={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel} className={CANCEL}>
            {cancelLabel ?? t('ui.confirm.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`hp-btn ${danger ? 'hp-btn-danger' : 'hp-btn-primary'}`}
          >
            {confirmLabel ?? t('ui.confirm.confirm')}
          </button>
        </>
      }
    >
      {message ? <div className="whitespace-pre-line text-sm font-body text-gray-600">{message}</div> : null}
    </Modal>
  )
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

interface Pending {
  id: number
  options: ConfirmOptions
  resolve: (ok: boolean) => void
}

// Stellt confirm() für alles darunter bereit. Mehrere Rückfragen kurz
// nacheinander werden der Reihe nach gezeigt, keine geht verloren.
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([])
  const nextId = useRef(1)

  const confirm = useCallback<ConfirmFn>(options => new Promise<boolean>(resolve => {
    const id = nextId.current++
    setQueue(prev => [...prev, { id, options, resolve }])
  }), [])

  // Verschwindet der Provider, während eine Rückfrage offen ist, gilt sie als
  // abgelehnt (kein Versprechen bleibt für immer offen).
  const queueRef = useRef(queue)
  queueRef.current = queue
  useEffect(() => () => { for (const item of queueRef.current) item.resolve(false) }, [])

  const current = queue[0] ?? null
  const settle = (ok: boolean) => {
    if (!current) return
    current.resolve(ok)
    setQueue(prev => prev.filter(item => item.id !== current.id))
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && (
        <ConfirmDialog
          key={current.id}
          open
          {...current.options}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

// Text einer ReactNode-Nachricht für den Ersatzweg über window.confirm
function plainText(options: ConfirmOptions): string {
  const message = typeof options.message === 'string' || typeof options.message === 'number' ? String(options.message) : ''
  return message ? `${options.title}\n\n${message}` : options.title
}

// const confirm = useConfirm()
// const ok = await confirm({ title: 'Kunde löschen?', message: '...', tone: 'danger' })
//
// Fehlt der ConfirmProvider, fällt der Hook auf window.confirm zurück: eine
// Seite, die schon umgestellt ist, funktioniert auch ohne Provider weiter.
export function useConfirm(): ConfirmFn {
  const fromContext = useContext(ConfirmContext)
  return useMemo<ConfirmFn>(
    () => fromContext ?? (options => Promise.resolve(window.confirm(plainText(options)))),
    [fromContext],
  )
}

export default ConfirmDialog
