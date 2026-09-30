import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { mobileBar } from '../../lib/navigation'
import type { Profile } from '../../lib/permissions'
import Icon from './Icon'
import { badgeCount, type NavBadges } from './ShellContext'

interface BottomBarProps {
  profile: Profile
  badges: NavBadges
  // Id des aktiven Menüeintrags (aus matchEntry), null wenn keiner passt
  activeId: string | null
  moreOpen: boolean
  onMore: () => void
}

// Höhe h-14 = 56 px (BOTTOM_BAR_PX im ShellContext), Tippfläche je Eintrag
// damit deutlich über 44 px.
const ITEM_BASE =
  'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 ' +
  'text-[10px] font-medium font-body transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-hp-navy/40'

// Dünner Korall-Strich über dem aktiven Eintrag (Akzent, keine Fläche)
function ActiveBar() {
  return <span aria-hidden="true" className="absolute inset-x-4 top-0 h-0.5 rounded-b-full bg-hp-highlight" />
}

// Telefon-Leiste (nur unter md): bis zu 4 Haupteinträge der Rolle plus "Mehr".
export default function BottomBar({ profile, badges, activeId, moreOpen, onMore }: BottomBarProps) {
  const { t } = useTranslation()
  const entries = mobileBar(profile)
  // "Mehr" gilt als aktiv, wenn das Blatt offen ist oder die aktuelle Seite
  // keinen Platz in der Leiste hat.
  const moreActive = moreOpen || (activeId !== null && !entries.some(e => e.id === activeId))

  return (
    <nav
      aria-label={t('shell.a11y.bottomNav')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex items-stretch">
        {entries.map(entry => {
          const active = !moreOpen && entry.id === activeId
          const label = t(entry.labelKey)
          const count = badgeCount(entry, badges)
          const badgeText = entry.badge && count > 0 ? t(`shell.badges.${entry.badge}`, { count }) : ''
          return (
            <li key={entry.id} className="flex min-w-0 flex-1">
              <Link
                to={entry.path}
                aria-current={active ? 'page' : undefined}
                aria-label={badgeText ? `${label}, ${badgeText}` : undefined}
                className={`${ITEM_BASE} ${active ? 'text-hp-highlight' : 'text-gray-500 hover:text-hp-navy'}`}
              >
                {active && <ActiveBar />}
                <span className="relative">
                  <Icon name={entry.icon} size={22} />
                  {count > 0 && (
                    <span aria-hidden="true" className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-hp-navy ring-2 ring-white" />
                  )}
                </span>
                <span className="max-w-full truncate">{label}</span>
              </Link>
            </li>
          )
        })}
        <li className="flex min-w-0 flex-1">
          <button
            type="button"
            onClick={onMore}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={`${ITEM_BASE} ${moreActive ? 'text-hp-highlight' : 'text-gray-500 hover:text-hp-navy'}`}
          >
            {moreActive && <ActiveBar />}
            <Icon name="more" size={22} />
            <span className="max-w-full truncate">{t('shell.more')}</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}
