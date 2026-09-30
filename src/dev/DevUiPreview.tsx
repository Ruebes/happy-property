// NUR FÜR DEN DEV-SERVER (siehe devMock.ts). Route: /__dev/ui
//
// Zeigt alle Bausteine aus src/components/ui mit erfundenen Beispieldaten im
// Rahmen der neuen Navigation (Mock-Profil Admin), ohne Login und ohne Daten.
// Die Texte dieser Seite stehen bewusst nicht in den Sprachdateien: die würden
// sonst mit in den Produktions-Build wandern.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import ShellFrame from '../components/shell/ShellFrame'
import Icon from '../components/shell/Icon'
import Badge from '../components/ui/Badge'
import { ConfirmProvider, useConfirm } from '../components/ui/ConfirmDialog'
import PageHeader from '../components/ui/PageHeader'
import Tabs, { initialTabFromUrl, tabPanelProps } from '../components/ui/Tabs'
import { ToastProvider, useToast } from '../components/ui/Toast'
import { mockProfile } from './devMock'
import { SAMPLE_TABS } from './devUiSamples'
import { ConfirmToastSection, MenuSection, ModalSection, PartsSection, SECTION, TableSection } from './DevUiSections'
import RelatedSection from './DevRelatedSection'

const SAMPLE_BADGES = { tasksOpen: 3, inboxUnread: 12 }
const TAB_IDS = SAMPLE_TABS.filter(tab => !tab.hidden).map(tab => tab.id)

function PreviewBody() {
  const toast = useToast()
  const confirm = useConfirm()
  const [tab, setTab] = useState(() => initialTabFromUrl(TAB_IDS, 'overview'))
  const activeTab = SAMPLE_TABS.find(item => item.id === tab)

  const removeCustomer = async () => {
    const ok = await confirm({
      title: 'Kunde löschen?',
      message: 'Martina Hoffmann wird mit allen Aufgaben und Terminen entfernt. Das lässt sich nicht rückgängig machen.',
      confirmLabel: 'Endgültig löschen',
      tone: 'danger',
    })
    if (ok) toast.success('Kunde gelöscht (nur Beispiel)')
    else toast.info('Nichts gelöscht')
  }

  return (
    <div className="hp-shell-content mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 md:py-8">
      <p className="mb-3 text-xs font-semibold font-body uppercase tracking-wide text-gray-400">
        Nur im Dev-Server: Vorschau der UI-Bausteine
      </p>

      {/* Seitenkopf mit Zurück und fünf Aktionen (drei sichtbar, zwei im Mehr-Menü) */}
      <PageHeader
        title="Martina Hoffmann"
        subtitle="Kundin seit März 2026, zuletzt geändert heute um 09:40 Uhr"
        back={{ to: '/__dev/shell/admin', label: 'Shell-Vorschau' }}
        meta={
          <>
            <Badge tone="warning" dot>Reservierung</Badge>
            <Badge tone="info" icon="unit">Olive Garden Residences, A-204</Badge>
            <Badge tone="success" icon="check">Portal-Zugang aktiv</Badge>
            <Badge>Quelle: Website</Badge>
          </>
        }
        actions={
          <>
            <button type="button" className="hp-btn hp-btn-primary" onClick={() => toast.success('Bearbeiten geöffnet (nur Beispiel)')}>
              <Icon name="edit" size={16} />
              Bearbeiten
            </button>
            <button type="button" className="hp-btn hp-btn-ghost" onClick={() => toast.info('Aufgabe angelegt (nur Beispiel)')}>
              <Icon name="tasks" size={16} />
              Aufgabe
            </button>
            <button type="button" className="hp-btn hp-btn-ghost" onClick={() => toast.info('Termin geplant (nur Beispiel)')}>
              <Icon name="calendar" size={16} />
              Termin
            </button>
          </>
        }
        overflowActions={[
          { label: 'Archivieren', icon: 'archive', onClick: () => toast.info('Archiviert (nur Beispiel)') },
          { label: 'Kunde löschen', icon: 'trash', tone: 'danger', onClick: () => { void removeCustomer() } },
        ]}
      />

      {/* Reiter mit Zählern; der aktive Reiter steht als ?tab= in der Adresse */}
      <Tabs tabs={SAMPLE_TABS} value={tab} onChange={setTab} urlParam ariaLabel="Bereiche des Kunden" idBase="devui" />
      <div {...tabPanelProps('devui', tab)} className={`${SECTION} mt-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40`}>
        <p className="text-sm font-body text-gray-600">
          Aktiver Reiter: <strong className="text-hp-navy">{activeTab?.label ?? tab}</strong>. Pfeiltasten wechseln den Reiter,
          Neuladen behält ihn. Auf dem Telefon scrollt die Leiste waagerecht.
        </p>
      </div>

      <div className="mt-6 space-y-6">
        <TableSection />
        <ModalSection />
        <ConfirmToastSection />
        <MenuSection />
        <PartsSection />
        <RelatedSection />
        <p className="text-sm font-body text-gray-500">
          Weitere Vorschau: <Link to="/__dev/shell/admin" className="text-hp-navy underline underline-offset-4">Shell je Rolle</Link>
        </p>
      </div>
    </div>
  )
}

export default function DevUiPreview() {
  const profile = mockProfile('admin')
  return (
    <ShellFrame profile={profile} badges={SAMPLE_BADGES}>
      <ToastProvider>
        <ConfirmProvider>
          <PreviewBody />
        </ConfirmProvider>
      </ToastProvider>
    </ShellFrame>
  )
}
