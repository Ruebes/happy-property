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

// Gleiche Größe für Link und reinen Text, damit nichts springt, wenn ein
// Betrachter das Ziel nicht öffnen darf. Der Chip als Link hat einen Rahmen
// auf Weiß, der reine Text-Chip keinen Rahmen und grauen Grund: so sieht auch
// auf dem Telefon (ohne Hover) niemand einen Knopf, der nichts tut.
const CHIP_SHAPE = 'inline-flex min-h-[36px] max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-body'
const CHIP_LINK = 'border-gray-200 bg-white text-hp-navy transition-colors hover:border-hp-navy/30 hover:bg-hp-cream focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70'
const CHIP_TEXT = 'cursor-default border-transparent bg-gray-50 text-gray-700'
const INLINE_BASE = 'font-body text-hp-navy'
const INLINE_LINK = 'rounded-sm underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70'

// Führt das Ziel auf die Seite, auf der man gerade steht (z.B. ein aktiver
// Vorgang, der auf der Kundenseite lebt)? Dann kein Link: ein Klick legte nur
// einen doppelten Verlaufseintrag an, sichtbar passierte nichts. Parameter der
// aktuellen Adresse, die das Ziel nicht nennt (?tab=), zählen nicht.
function isCurrentPage(to: string, pathname: string, search: string): boolean {
  const cut = to.indexOf('?')
  const path = cut < 0 ? to : to.slice(0, cut)
  if (path !== pathname) return false
  const have = new URLSearchParams(search)
  for (const [key, value] of new URLSearchParams(cut < 0 ? '' : to.slice(cut + 1))) {
    if (have.get(key) !== value) return false
  }
  return true
}

// Verweis auf einen Datensatz. Lädt nie selbst Daten: Art, Id und Text kommen
// vom Aufrufer, das Ziel aus entityPath (Rolle und Rechte des Betrachters).
// Ohne Ziel oder ohne Id bleibt es bei reinem Text im selben Schriftbild.
export default function EntityLink({
  kind, id, label, opts, variant = 'inline', newTab = false, stopPropagation = true, icon, className = '',
}: EntityLinkProps) {
  const location = useLocation()
  const pathFor = useEntityPath()
  const found = id ? pathFor(kind, id, opts) : null
  const target = found && !found.external && !newTab && isCurrentPage(found.to, location.pathname, location.search) ? null : found
  const chip = variant === 'chip'

  const content = chip ? (
    <>
      <Icon name={icon ?? ENTITY_ICONS[kind]} size={15} className={`shrink-0 ${target ? 'text-hp-navy/60' : 'text-gray-500'}`} />
      <span className="truncate" title={typeof label === 'string' ? label : undefined}>{label}</span>
      {target?.external && <Icon name="externalLink" size={13} className="shrink-0 text-hp-navy/40" />}
    </>
  ) : label

  if (!target) {
    return <span className={`${chip ? `${CHIP_SHAPE} ${CHIP_TEXT}` : INLINE_BASE} ${className}`}>{content}</span>
  }

  const classes = `${chip ? `${CHIP_SHAPE} ${CHIP_LINK}` : `${INLINE_BASE} ${INLINE_LINK}`} ${className}`
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
