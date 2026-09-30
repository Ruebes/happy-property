// NUR FÜR DEN DEV-SERVER (siehe devMock.ts). Vorschau der Karte "Gehört dazu"
// (src/components/crm/RelatedPanel.tsx) mit erfundenen Daten: kein Aufruf der
// Datenbank. Der Rollen-Umschalter zeigt, welche Chips je Rolle zum Link werden
// und welche reiner Text bleiben (EntityLink liest das Profil aus dem
// AuthContext, der hier nur für die Karte ersetzt wird).
import { useMemo, useState } from 'react'
import RelatedPanel from '../components/crm/RelatedPanel'
import { useToast } from '../components/ui/Toast'
import { AuthContext, type AuthContextValue } from '../lib/auth'
import { landingFor, type PermissionArea, type UserRole } from '../lib/permissions'
import type { RelatedGroupKey } from '../lib/relatedTypes'
import { mockProfile } from './devMock'
import { SAMPLE_RELATED, SAMPLE_RELATED_EMPTY } from './devRelatedSample'
import { SECTION } from './DevUiSections'

interface Viewer {
  id: string
  label: string
  role: UserRole
  perms?: PermissionArea[]
}

const VIEWERS: Viewer[] = [
  { id: 'admin', label: 'Admin', role: 'admin' },
  { id: 'verwalter', label: 'Verwalter', role: 'verwalter' },
  { id: 'staff-pipeline', label: 'Mitarbeiter (Pipeline)', role: 'mitarbeiter', perms: ['pipeline'] },
  { id: 'staff-contacts', label: 'Mitarbeiter (nur Kontakte)', role: 'mitarbeiter', perms: ['contacts'] },
  { id: 'eigentuemer', label: 'Eigentümer', role: 'eigentuemer' },
]

const NOT_AVAILABLE = 'In der Vorschau nicht verfügbar'
const TOGGLE = 'hp-btn hp-btn-ghost aria-pressed:border-hp-navy aria-pressed:bg-hp-cream'

function mockAuth(viewer: Viewer): AuthContextValue {
  const profile = mockProfile(viewer.role, viewer.perms ?? null)
  return {
    user: null,
    session: null,
    profile,
    loading: false,
    needsPasswordSetup: false,
    signIn: async () => ({ error: NOT_AVAILABLE }),
    signOut: async () => {},
    updatePassword: async () => ({ error: NOT_AVAILABLE }),
    resetPasswordEmail: async () => ({ error: NOT_AVAILABLE }),
    clearPasswordSetup: () => {},
    dashboardPath: landingFor(profile),
  }
}

export default function RelatedSection() {
  const toast = useToast()
  const [viewerId, setViewerId] = useState('admin')
  const [empty, setEmpty] = useState(false)
  const [tabsOnPage, setTabsOnPage] = useState(false)
  const viewer = VIEWERS.find(item => item.id === viewerId) ?? VIEWERS[0]
  const auth = useMemo(() => mockAuth(viewer), [viewer])

  // Wie eine Kundenseite mit Reitern: "alle N anzeigen" wechselt dann den Reiter
  const openTab = (kind: RelatedGroupKey): boolean => {
    if (!tabsOnPage) return false
    toast.info(`Seite wechselt zum Reiter "${kind}" (nur Beispiel)`)
    return true
  }

  return (
    <section className={SECTION}>
      <h2 className="text-lg text-hp-navy">Gehört dazu (Querverweise)</h2>
      <p className="mt-1 text-sm font-body text-gray-600">
        Erfundene Antwort von hp_lead_related, keine Datenbank. Auf dem Telefon zugeklappt mit Gesamtzahl, ab lg zweispaltig.
        Chips ohne Ziel für die gewählte Rolle bleiben reiner Text; Deck, Rechnung und Strategie öffnen in neuem Tab.
      </p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Rolle der Vorschau">
        {VIEWERS.map(item => (
          <button
            key={item.id}
            type="button"
            className={TOGGLE}
            aria-pressed={item.id === viewerId}
            onClick={() => setViewerId(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={TOGGLE} aria-pressed={empty} onClick={() => setEmpty(value => !value)}>
          Kunde ohne Verknüpfungen
        </button>
        <button type="button" className={TOGGLE} aria-pressed={tabsOnPage} onClick={() => setTabsOnPage(value => !value)}>
          Seite hat eigene Reiter
        </button>
      </div>
      <div className="mt-4">
        <AuthContext.Provider value={auth}>
          <RelatedPanel
            key={empty ? 'empty' : 'full'}
            leadId={empty ? SAMPLE_RELATED_EMPTY.lead_id : SAMPLE_RELATED.lead_id}
            mockData={empty ? SAMPLE_RELATED_EMPTY : SAMPLE_RELATED}
            onOpenTab={openTab}
          />
        </AuthContext.Provider>
      </div>
    </section>
  )
}
