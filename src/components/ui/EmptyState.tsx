import type { ReactNode } from 'react'
import Icon, { type IconId } from '../shell/Icon'

interface EmptyStateProps {
  icon?: IconId
  title: string
  text?: ReactNode
  // Knopf oder Link unter dem Text (z.B. <button className="hp-btn hp-btn-primary">)
  action?: ReactNode
  // Kompakt: für Tabellen und schmale Karten
  compact?: boolean
  className?: string
}

// Leerer Zustand einer Liste oder Seite: Icon, Überschrift, ein Satz, ein Knopf.
export default function EmptyState({ icon = 'inbox', title, text, action, compact = false, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'px-4 py-8' : 'px-6 py-14'} ${className}`}>
      <span
        aria-hidden="true"
        className={`flex items-center justify-center rounded-full bg-hp-cream text-hp-navy/60 ring-1 ring-hp-navy/10 ${compact ? 'h-11 w-11' : 'h-14 w-14'}`}
      >
        <Icon name={icon} size={compact ? 20 : 26} />
      </span>
      <p className={`mt-4 font-heading text-hp-navy ${compact ? 'text-base' : 'text-lg'}`}>{title}</p>
      {text && <div className="mt-1.5 max-w-md text-sm font-body text-gray-600">{text}</div>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}
