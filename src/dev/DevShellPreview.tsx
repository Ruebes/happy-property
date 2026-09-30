// NUR FÜR DEN DEV-SERVER (siehe devMock.ts). Route: /__dev/shell/:role
//
// Zeigt den Rahmen der neuen Navigation (ShellFrame) mit einem erfundenen
// Profil und Platzhalter-Inhalt, ohne Login und ohne Daten:
//   /__dev/shell/admin
//   /__dev/shell/mitarbeiter                          Rechte pipeline + contacts
//   /__dev/shell/mitarbeiter?perms=funnel,werbung,thumbnails
// Die Texte dieser Seite stehen bewusst nicht in den Sprachdateien: die würden
// sonst mit in den Produktions-Build wandern.
import { Link, useParams, useSearchParams } from 'react-router-dom'
import ShellFrame from '../components/shell/ShellFrame'
import { groupedNav, mobileBar } from '../lib/navigation'
import { landingFor, type PermissionArea, type UserRole } from '../lib/permissions'
import { ALT_STAFF_PERMS, DEFAULT_STAFF_PERMS, MOCK_ROLES, mockProfile, parsePerms, parseRole, readMock, startMock, stopMock } from './devMock'

const SAMPLE_BADGES = { tasksOpen: 3, inboxUnread: 12 }

const CARD = 'rounded-2xl border border-gray-100 bg-white p-5 shadow-sm'
const CHIP =
  'inline-flex items-center rounded-lg border px-3 py-1.5 text-sm font-medium font-body transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40'
const CHIP_IDLE = 'border-gray-200 text-gray-700 hover:border-hp-navy hover:text-hp-navy'
const CHIP_ACTIVE = 'border-hp-navy bg-hp-navy text-hp-cream'

function previewPath(role: UserRole, perms?: readonly PermissionArea[]): string {
  return `/__dev/shell/${role}${perms ? `?perms=${perms.join(',')}` : ''}`
}

export default function DevShellPreview() {
  const params = useParams()
  const [search] = useSearchParams()
  const role = parseRole(params.role) ?? 'admin'
  const unknownRole = parseRole(params.role) === null
  const perms = role === 'mitarbeiter' ? parsePerms(search.get('perms')) : null
  const profile = mockProfile(role, perms)
  const activeMock = readMock()

  const groups = groupedNav(profile)
  const entryCount = groups.reduce((sum, item) => sum + item.entries.length, 0)
  const bar = mobileBar(profile)
  const permList = Object.keys(profile.permissions)
  const isAltPerms = perms !== null && perms.join(',') === ALT_STAFF_PERMS.join(',')

  // Mock-Anmeldung: Rolle merken und mit vollem Neuladen auf die echte
  // Startseite der Rolle wechseln (App.tsx liest den Schlüssel beim Start).
  const openRealPages = () => {
    startMock(role, role === 'mitarbeiter' ? perms : null)
    window.location.assign(landingFor(profile))
  }
  const endMock = () => {
    stopMock()
    window.location.reload()
  }

  return (
    <ShellFrame profile={profile} badges={SAMPLE_BADGES}>
      <div className="hp-shell-content mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 md:py-8">
        <div className={CARD}>
          <p className="text-xs font-semibold font-body uppercase tracking-wide text-gray-400">Nur im Dev-Server</p>
          <h1 className="mt-1 text-2xl text-hp-navy">Shell-Vorschau: {profile.full_name}</h1>
          <p className="mt-2 text-sm font-body text-gray-600">
            Rahmen der neuen Navigation mit erfundenem Profil. {entryCount} Menüeinträge in {groups.length} Gruppen,
            Telefon-Leiste: {bar.length} Einträge plus Mehr. Die Zähler an Aufgaben und Posteingang sind Beispielwerte.
          </p>
          {unknownRole && (
            <p className="mt-2 text-sm font-body text-gray-600">
              Die Rolle in der Adresse ist unbekannt, angezeigt wird Admin.
            </p>
          )}
          {role === 'mitarbeiter' && (
            <p className="mt-2 text-sm font-body text-gray-600">
              Rechte: {permList.length > 0 ? permList.join(', ') : 'keine'}
            </p>
          )}
        </div>

        <div className={CARD}>
          <h2 className="text-lg text-hp-navy">Rolle wechseln</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {MOCK_ROLES.map(item => (
              <Link
                key={item}
                to={previewPath(item)}
                className={`${CHIP} ${item === role && !isAltPerms ? CHIP_ACTIVE : CHIP_IDLE}`}
              >
                {item}
                {item === 'mitarbeiter' && ` (${DEFAULT_STAFF_PERMS.join(', ')})`}
              </Link>
            ))}
            <Link
              to={previewPath('mitarbeiter', ALT_STAFF_PERMS)}
              className={`${CHIP} ${role === 'mitarbeiter' && isAltPerms ? CHIP_ACTIVE : CHIP_IDLE}`}
            >
              mitarbeiter ({ALT_STAFF_PERMS.join(', ')})
            </Link>
          </div>
        </div>

        <div className={CARD}>
          <h2 className="text-lg text-hp-navy">Echte Seiten ohne Login ansehen</h2>
          <p className="mt-2 text-sm font-body text-gray-600">
            Die Mock-Anmeldung setzt sessionStorage.hp_mock_role und öffnet die Startseite dieser Rolle mit der neuen
            Navigation. Es gibt keine echte Sitzung: Daten bleiben leer oder melden Fehler. Abmelden im Profil-Menü
            oder der Knopf unten beendet sie.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={openRealPages} className={`${CHIP} ${CHIP_IDLE}`}>
              Als {role} öffnen: {landingFor(profile)}
            </button>
            {activeMock && (
              <button type="button" onClick={endMock} className={`${CHIP} ${CHIP_IDLE}`}>
                Mock-Anmeldung beenden (aktiv: {activeMock.role})
              </button>
            )}
          </div>
        </div>

        {/* Füllmaterial: Scrollen des Dokuments, stehende Kopfzeile, Abstand zur Telefon-Leiste */}
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className={`${CARD} h-40`}>
            <p className="text-sm font-body text-gray-400">Platzhalter {index + 1}</p>
          </div>
        ))}

        {/* Beispiel-Hinweis wie auf den Seiten: muss auf dem Telefon über der unteren Leiste stehen */}
        <div className="fixed bottom-6 right-6 z-50 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-body text-white shadow-lg">
          Beispiel-Hinweis
        </div>
      </div>
    </ShellFrame>
  )
}
