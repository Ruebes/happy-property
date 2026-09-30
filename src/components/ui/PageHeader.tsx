import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Icon, { type IconId } from '../shell/Icon'
import ActionMenu, { type ActionItem } from './ActionMenu'

export interface PageHeaderBack {
  // Festes Ziel (z.B. die Liste). Ohne to geht es im Verlauf einen Schritt
  // zurück, sofern es dort eine vorherige Seite der App gibt.
  to?: string
  // Beschriftung (Standard: "Zurück")
  label?: string
  // Eigene Aktion statt Navigation (z.B. ungespeicherte Änderungen prüfen)
  onClick?: () => void
  // Mit to: zuerst im Verlauf zurück (Filter und Scroll-Stand der Herkunft
  // bleiben erhalten), to nur als Ersatz bei Direktaufruf oder neuem Tab
  preferHistory?: boolean
}

export interface PageHeaderAction {
  label: string
  icon?: IconId
  onClick: () => void
  tone?: 'default' | 'danger'
}

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  back?: PageHeaderBack
  // Sichtbare Knöpfe rechts (brechen auf schmalen Bildschirmen um)
  actions?: ReactNode
  // Seltenere Aktionen hinter dem "Mehr"-Knopf
  overflowActions?: PageHeaderAction[]
  // Zeile unter dem Titel, z.B. Badges
  meta?: ReactNode
  className?: string
}

// Gibt es im Verlauf dieses Tabs eine vorherige Seite der App? react-router
// zählt die Einträge in history.state.idx mit; 0 heißt: Einstieg per Link,
// Lesezeichen oder neuem Tab.
function hasInAppHistory(): boolean {
  try {
    const state: unknown = window.history.state
    if (typeof state !== 'object' || state === null || !('idx' in state)) return false
    return typeof state.idx === 'number' && state.idx > 0
  } catch { return false }
}

const BACK =
  '-ml-1 mb-1 inline-flex min-h-[44px] items-center gap-0.5 rounded-lg pr-2 text-sm font-medium font-body text-gray-500 ' +
  'transition-colors hover:text-hp-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 sm:min-h-[32px]'

// Kopf einer Seite: Zurück, Titel, Untertitel, Badges, Aktionen.
//
// Zurück:
//   back.onClick           eigene Aktion
//   back.to                Link auf dieses Ziel (mit preferHistory zuerst im
//                          Verlauf zurück, das Ziel nur als Ersatz)
//   ohne to                im Verlauf zurück, wenn es eine vorherige Seite der
//                          App gibt; sonst erscheint kein Zurück
export default function PageHeader({ title, subtitle, back, actions, overflowActions, meta, className = '' }: PageHeaderProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const menuItems: ActionItem[] = (overflowActions ?? []).map((action, index) => ({
    id: `overflow-${index}`,
    label: action.label,
    icon: action.icon,
    onClick: action.onClick,
    tone: action.tone,
  }))

  const backLabel = back?.label ?? t('ui.pageHeader.back')
  const backContent = (
    <>
      <Icon name="chevronLeft" size={18} className="shrink-0" />
      <span>{backLabel}</span>
    </>
  )
  const onBackLink = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!back?.preferHistory) return
    // Neuer Tab (Strg, Cmd, Mitteltaste) öffnet das feste Ziel wie ein Link
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    if (!hasInAppHistory()) return
    e.preventDefault()
    navigate(-1)
  }

  let backElement: ReactNode = null
  if (back?.onClick) {
    backElement = <button type="button" onClick={back.onClick} className={BACK}>{backContent}</button>
  } else if (back?.to) {
    backElement = <Link to={back.to} onClick={onBackLink} className={BACK}>{backContent}</Link>
  } else if (back && hasInAppHistory()) {
    backElement = <button type="button" onClick={() => navigate(-1)} className={BACK}>{backContent}</button>
  }

  const hasActions = actions !== undefined && actions !== null
  const moreLabel = t('ui.pageHeader.more')
  return (
    <header className={`mb-5 ${className}`}>
      {backElement}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="break-words font-heading text-xl text-hp-navy sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-1 text-sm font-body text-gray-500">{subtitle}</p>}
            {meta && <div className="mt-2 flex flex-wrap items-center gap-1.5">{meta}</div>}
          </div>
          {/* Telefon: Mehr-Knopf oben rechts neben dem Titel (in der Knopfzeile
              darunter stünde er sonst allein in einer eigenen Zeile) */}
          <ActionMenu items={menuItems} label={moreLabel} className="-mr-2 -mt-2 sm:hidden" />
        </div>
        {(hasActions || menuItems.length > 0) && (
          <div className={`flex-wrap items-center gap-2 sm:flex sm:shrink-0 sm:justify-end ${hasActions ? 'flex' : 'hidden'}`}>
            {actions}
            <ActionMenu items={menuItems} label={moreLabel} className="hidden sm:inline-flex" />
          </div>
        )}
      </div>
    </header>
  )
}
