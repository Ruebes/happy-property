import type { MouseEvent, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Icon, { type IconId } from './shell/Icon'
import type { EntityKind, EntityLinkOpts } from '../lib/entityLinks'
import { useEntityPath } from '../lib/useEntityLinks'

export const ENTITY_ICONS: Record<EntityKind, IconId> = {
  lead: 'user',
  deal: 'pipeline',
  project: 'projects',
  unit: 'unit',
  property: 'properties',
  owner: 'key',
  task: 'tasks',
  appointment: 'calendar',
  invoice: 'invoices',
  deck: 'deck',
  calculation: 'calculator',
  strategy: 'strategy',
  review: 'reviews',
  affiliate: 'affiliates',
  newsletter: 'newsletter',
  document: 'documents',
  booking: 'bookings',
  inbox: 'inbox',
}

interface EntityLinkProps {
  kind: EntityKind
  // Fehlt die Id, erscheint reiner Text
  id?: string | null
  label: ReactNode
  opts?: EntityLinkOpts
  variant?: 'chip' | 'inline'
  // Internes Ziel in neuem Tab öffnen (Token-Seiten öffnen immer in neuem Tab)
  newTab?: boolean
  // Klick nicht an die umgebende Zeile oder Karte weiterreichen (Standard: ja)
  stopPropagation?: boolean
  // Anderes Icon als das der Art (nur Chip), z.B. für Zusammenfassungen
  icon?: IconId
  className?: string
}

// Gleiche Schrift für Link und reinen Text, damit nichts springt, wenn ein
// Betrachter das Ziel nicht öffnen darf.
const CHIP_BASE = 'inline-flex min-h-[36px] max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm font-body text-hp-navy'
const CHIP_LINK = 'transition-colors hover:border-hp-navy/30 hover:bg-hp-cream focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40'
const INLINE_BASE = 'font-body text-hp-navy'
const INLINE_LINK = 'rounded-sm underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40'

// Verweis auf einen Datensatz. Lädt nie selbst Daten: Art, Id und Text kommen
// vom Aufrufer, das Ziel aus entityPath (Rolle und Rechte des Betrachters).
// Ohne Ziel oder ohne Id bleibt es bei reinem Text im selben Schriftbild.
export default function EntityLink({
  kind, id, label, opts, variant = 'inline', newTab = false, stopPropagation = true, icon, className = '',
}: EntityLinkProps) {
  const location = useLocation()
  const pathFor = useEntityPath()
  const target = id ? pathFor(kind, id, opts) : null
  const chip = variant === 'chip'

  const content = chip ? (
    <>
      <Icon name={icon ?? ENTITY_ICONS[kind]} size={15} className="shrink-0 text-hp-navy/60" />
      <span className="truncate" title={typeof label === 'string' ? label : undefined}>{label}</span>
      {target?.external && <Icon name="externalLink" size={13} className="shrink-0 text-hp-navy/40" />}
    </>
  ) : label

  if (!target) {
    return <span className={`${chip ? CHIP_BASE : INLINE_BASE} ${className}`}>{content}</span>
  }

  const classes = `${chip ? `${CHIP_BASE} ${CHIP_LINK}` : `${INLINE_BASE} ${INLINE_LINK}`} ${className}`
  const onClick = stopPropagation ? (e: MouseEvent<HTMLAnchorElement>) => { e.stopPropagation() } : undefined

  if (target.external) {
    return (
      <a href={target.to} target="_blank" rel="noopener noreferrer" className={classes} onClick={onClick}>
        {content}
      </a>
    )
  }

  return (
    <Link
      to={target.to}
      state={{ from: location.pathname + location.search }}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noopener noreferrer' : undefined}
      className={classes}
      onClick={onClick}
    >
      {content}
    </Link>
  )
}
