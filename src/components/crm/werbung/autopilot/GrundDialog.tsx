import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'

// ── Rückfrage mit Begründung (Autopilot stoppen, Vorschlag ablehnen) ────────
// Wie ConfirmDialog, aber mit Textfeld. pflicht = ohne Text kein Bestätigen.
interface GrundDialogProps {
  open: boolean
  title: string
  text?: string
  label: string
  placeholder?: string
  confirmLabel: string
  tone?: 'default' | 'danger'
  pflicht?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: (grund: string) => void
}

export default function GrundDialog({
  open, title, text, label, placeholder, confirmLabel, tone = 'default', pflicht = false, busy = false, onCancel, onConfirm,
}: GrundDialogProps) {
  const { t } = useTranslation()
  const [grund, setGrund] = useState('')
  const feldRef = useRef<HTMLTextAreaElement>(null)

  // Jedes Öffnen beginnt leer
  useEffect(() => { if (open) setGrund('') }, [open])

  const leer = grund.trim() === ''
  const bestaetigen = () => { if (!(pflicht && leer) && !busy) onConfirm(grund.trim()) }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      sheet="auto"
      initialFocusRef={feldRef}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="hp-btn hp-btn-ghost" onClick={onCancel} disabled={busy}>
            {t('crm.werbung.autopilot.abbrechen', 'Abbrechen')}
          </button>
          <button
            type="button"
            className={`hp-btn ${tone === 'danger' ? 'hp-btn-danger' : 'hp-btn-primary'}`}
            onClick={bestaetigen}
            disabled={busy || (pflicht && leer)}
          >
            {confirmLabel}
          </button>
        </div>
      )}
    >
      {text && <p className="mb-3 text-sm font-body text-gray-600">{text}</p>}
      <label className="block">
        <span className="text-xs font-medium text-gray-600">{label}{pflicht ? ' *' : ''}</span>
        <textarea
          ref={feldRef}
          className="hp-input mt-1 min-h-[88px]"
          value={grund}
          maxLength={500}
          placeholder={placeholder}
          onChange={e => setGrund(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) bestaetigen() }}
        />
      </label>
    </Modal>
  )
}
