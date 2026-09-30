import type { ReactNode } from 'react'
import Icon, { type IconId } from '../shell/Icon'

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

interface BadgeProps {
  tone?: BadgeTone
  icon?: IconId
  // Kleiner Farbpunkt vor dem Text (Status-Anzeige)
  dot?: boolean
  children: ReactNode
  className?: string
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-gray-100 text-gray-700',
  info: 'bg-hp-navy/5 text-hp-navy',
  success: 'bg-emerald-50 text-emerald-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
}

const DOTS: Record<BadgeTone, string> = {
  neutral: 'bg-gray-400',
  info: 'bg-hp-navy',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
}

// Kleines Etikett für Status und Zähler. Farbe trägt nie allein die Bedeutung:
// der Text sagt immer, was gemeint ist.
export default function Badge({ tone = 'neutral', icon, dot = false, children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium font-body leading-5 ${TONES[tone]} ${className}`}
    >
      {dot && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOTS[tone]}`} />}
      {icon && <Icon name={icon} size={13} className="shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  )
}
