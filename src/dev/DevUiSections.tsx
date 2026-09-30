// NUR FÜR DEN DEV-SERVER (siehe devMock.ts). Abschnitte der Vorschau /__dev/ui.
import { useRef, useState, type ReactNode } from 'react'
import { CustomSelect } from '../components/CustomSelect'
import Icon from '../components/shell/Icon'
import ActionMenu, { useContextMenu, type ActionItem } from '../components/ui/ActionMenu'
import Badge from '../components/ui/Badge'
import { useConfirm } from '../components/ui/ConfirmDialog'
import DataTable, { type DataTableColumn } from '../components/ui/DataTable'
import EmptyState from '../components/ui/EmptyState'
import Modal, { type ModalSize } from '../components/ui/Modal'
import Spinner from '../components/ui/Spinner'
import { useToast } from '../components/ui/Toast'
import { SAMPLE_DEALS, SAMPLE_LANGUAGES, SAMPLE_SOURCES, formatAppointment, formatEuro, type SampleDeal } from './devUiSamples'

export const SECTION = 'hp-card p-5'
const CHIP = 'hp-btn hp-btn-ghost'

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={SECTION}>
      <h2 className="text-lg text-hp-navy">{title}</h2>
      {hint && <p className="mt-1 text-sm font-body text-gray-600">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

// Tabelle: sechs Spalten, unter md Karten
type TableMode = 'rows' | 'loading' | 'empty'

export function TableSection() {
  const toast = useToast()
  const confirm = useConfirm()
  const [mode, setMode] = useState<TableMode>('rows')
  const [rows, setRows] = useState(SAMPLE_DEALS)

  const columns: DataTableColumn<SampleDeal>[] = [
    { id: 'customer', header: 'Kunde', primary: true, cell: row => row.customer },
    { id: 'project', header: 'Projekt', cell: row => row.project },
    { id: 'unit', header: 'Wohnung', cell: row => row.unit, className: 'whitespace-nowrap' },
    { id: 'phase', header: 'Phase', cell: row => <Badge tone={row.phaseTone} dot>{row.phase}</Badge> },
    { id: 'price', header: 'Kaufpreis', align: 'right', cell: row => formatEuro(row.price), className: 'whitespace-nowrap tabular-nums' },
    { id: 'appointment', header: 'Nächster Termin', hideBelow: 'lg', cell: row => formatAppointment(row.nextAppointment), className: 'whitespace-nowrap' },
  ]

  const remove = async (row: SampleDeal) => {
    const ok = await confirm({ title: 'Vorgang löschen?', message: `${row.customer}, ${row.unit}`, confirmLabel: 'Löschen', tone: 'danger' })
    if (!ok) return
    setRows(prev => prev.filter(item => item.id !== row.id))
    toast.success('Vorgang gelöscht', { action: { label: 'Rückgängig', onClick: () => setRows(SAMPLE_DEALS) } })
  }

  const rowActions = (row: SampleDeal): ActionItem[] => [
    { id: 'open', label: 'Öffnen', icon: 'externalLink', onClick: () => toast.info(`Öffnen: ${row.customer}`) },
    { id: 'task', label: 'Aufgabe anlegen', icon: 'tasks', onClick: () => toast.info(`Aufgabe für ${row.customer}`) },
    { id: 'appointment', label: 'Termin planen', icon: 'calendar', onClick: () => toast.info(`Termin für ${row.customer}`), disabled: row.nextAppointment !== null },
    { id: 'archive', label: 'Archivieren', icon: 'archive', onClick: () => toast.info(`Archiviert: ${row.customer}`) },
    { id: 'delete', label: 'Löschen', icon: 'trash', tone: 'danger', onClick: () => { void remove(row) } },
  ]

  const shownRows = mode === 'rows' ? rows : []
  return (
    <Section
      title="Tabelle"
      hint="Sechs Spalten. Ab md eine Tabelle (die Spalte Nächster Termin erst ab lg), darunter Karten mit dem Kunden als Titel und dem Mehr-Knopf oben rechts. Ein Klick auf die Zeile öffnet, ein Klick auf den Mehr-Knopf nicht."
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" className={CHIP} onClick={() => setMode('rows')}>Zeilen</button>
        <button type="button" className={CHIP} onClick={() => setMode('loading')}>Lädt</button>
        <button type="button" className={CHIP} onClick={() => setMode('empty')}>Leer</button>
        <button type="button" className={CHIP} onClick={() => setRows(SAMPLE_DEALS)}>Beispieldaten zurücksetzen</button>
      </div>
      <DataTable
        columns={columns}
        rows={shownRows}
        rowKey={row => row.id}
        loading={mode === 'loading'}
        onRowClick={row => toast.info(`Zeile geöffnet: ${row.customer}`)}
        rowActions={rowActions}
        rowActionsLabel={row => `Aktionen für ${row.customer}`}
        empty={
          <EmptyState
            icon="pipeline"
            title="Noch keine Vorgänge"
            text="Sobald ein Kunde eine Wohnung reserviert, erscheint der Vorgang hier."
            action={<button type="button" className="hp-btn hp-btn-primary" onClick={() => setMode('rows')}><Icon name="plus" size={16} />Vorgang anlegen</button>}
          />
        }
      />
    </Section>
  )
}

// Dialog mit langem Formular
const FIELD_LABEL = 'mb-1 block text-xs font-semibold font-body uppercase tracking-wide text-gray-500'

export function ModalSection() {
  const toast = useToast()
  const confirm = useConfirm()
  const [size, setSize] = useState<ModalSize | null>(null)
  const [language, setLanguage] = useState('de')
  const [source, setSource] = useState('website')
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const close = () => setSize(null)

  const discard = async () => {
    const ok = await confirm({ title: 'Änderungen verwerfen?', message: 'Die Eingaben in diesem Formular gehen verloren.', confirmLabel: 'Verwerfen', cancelLabel: 'Weiter bearbeiten', tone: 'danger' })
    if (ok) close()
  }
  const save = () => {
    close()
    toast.success('Kunde gespeichert (nur Beispiel)')
  }

  const sizes: ModalSize[] = ['sm', 'md', 'lg', 'xl', 'full']
  return (
    <Section
      title="Dialog"
      hint="Unter sm ein Blatt von unten (volle Höhe minus kleiner Abstand, Fußzeile bleibt stehen), ab sm eine Karte in der Mitte. Escape schließt, der Fokus bleibt im Dialog und geht danach zurück auf den Knopf. Verwerfen öffnet eine Rückfrage über dem Dialog."
    >
      <div className="flex flex-wrap gap-2">
        {sizes.map(item => (
          <button key={item} type="button" className={CHIP} onClick={() => setSize(item)}>Formular in Größe {item}</button>
        ))}
      </div>

      <Modal
        open={size !== null}
        onClose={close}
        title="Kunde bearbeiten"
        size={size ?? 'md'}
        sheet="full"
        initialFocusRef={firstFieldRef}
        footer={
          <>
            <button type="button" className="hp-btn hp-btn-ghost sm:mr-auto" onClick={() => { void discard() }}>Verwerfen</button>
            <button type="button" className="hp-btn hp-btn-ghost" onClick={close}>Abbrechen</button>
            <button type="button" className="hp-btn hp-btn-primary" onClick={save}>Speichern</button>
          </>
        }
      >
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); save() }}>
          <label className="block">
            <span className={FIELD_LABEL}>Vorname</span>
            <input ref={firstFieldRef} className="hp-input" defaultValue="Martina" autoComplete="off" />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>Nachname</span>
            <input className="hp-input" defaultValue="Hoffmann" autoComplete="off" />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>E-Mail</span>
            <input className="hp-input" type="email" defaultValue="martina.hoffmann@beispiel.test" autoComplete="off" />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>Telefon</span>
            <input className="hp-input" type="tel" defaultValue="+49 170 0000000" autoComplete="off" />
          </label>
          <div>
            <span className={FIELD_LABEL}>Sprache</span>
            <CustomSelect value={language} onChange={setLanguage} options={SAMPLE_LANGUAGES} />
          </div>
          <div>
            <span className={FIELD_LABEL}>Quelle</span>
            <CustomSelect value={source} onChange={setSource} options={SAMPLE_SOURCES} />
          </div>
          <label className="block">
            <span className={FIELD_LABEL}>Eigenkapital</span>
            <input className="hp-input" inputMode="numeric" defaultValue="85.000" autoComplete="off" />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>Budget bis</span>
            <input className="hp-input" inputMode="numeric" defaultValue="300.000" autoComplete="off" />
          </label>
          <label className="block sm:col-span-2">
            <span className={FIELD_LABEL}>Straße und Hausnummer</span>
            <input className="hp-input" defaultValue="Musterweg 12" autoComplete="off" />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>Postleitzahl</span>
            <input className="hp-input" defaultValue="00000" autoComplete="off" />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>Ort</span>
            <input className="hp-input" defaultValue="Musterstadt" autoComplete="off" />
          </label>
          <label className="block sm:col-span-2">
            <span className={FIELD_LABEL}>Gesperrtes Feld</span>
            <input className="hp-input" defaultValue="Kundennummer 10482" disabled />
          </label>
          <label className="block sm:col-span-2">
            <span className={FIELD_LABEL}>Notiz</span>
            <textarea className="hp-input min-h-[8rem]" defaultValue="Sucht eine Zwei-Zimmer-Wohnung zur Langzeitvermietung. Rückruf am liebsten vormittags." />
          </label>
          <label className="block sm:col-span-2">
            <span className={FIELD_LABEL}>Interne Anmerkung</span>
            <textarea className="hp-input min-h-[8rem]" placeholder="Nur für das Team sichtbar" />
          </label>
        </form>
      </Modal>
    </Section>
  )
}

// Rückfrage und Hinweise
export function ConfirmToastSection() {
  const toast = useToast()
  const confirm = useConfirm()

  const ask = async (danger: boolean) => {
    const ok = await confirm(danger
      ? { title: 'Rechnung stornieren?', message: 'Die Rechnung RE-2026-0142 wird storniert und der Kunde bekommt eine Stornorechnung.', confirmLabel: 'Stornieren', tone: 'danger' }
      : { title: 'Zugang jetzt senden?', message: 'Martina Hoffmann bekommt eine E-Mail mit dem Link zum Portal.', confirmLabel: 'Senden' })
    if (ok) toast.success(danger ? 'Rechnung storniert (nur Beispiel)' : 'Zugang gesendet (nur Beispiel)')
    else toast.info('Abgebrochen')
  }

  return (
    <Section
      title="Rückfrage und Hinweise"
      hint="Rückfrage: ersetzt window.confirm, gibt true oder false zurück. Hinweise: ab md oben rechts unter der oberen Leiste, auf dem Telefon unten in der Mitte über der Telefon-Leiste. 4 Sekunden, Fehler 8 Sekunden, höchstens drei gleichzeitig."
    >
      <div className="flex flex-wrap gap-2">
        <button type="button" className={CHIP} onClick={() => { void ask(false) }}>Rückfrage</button>
        <button type="button" className={CHIP} onClick={() => { void ask(true) }}>Rückfrage (gefährlich)</button>
        <button type="button" className={CHIP} onClick={() => toast.success('Änderungen gespeichert')}>Hinweis: Erfolg</button>
        <button type="button" className={CHIP} onClick={() => toast.error('Speichern fehlgeschlagen. Bitte prüfe die Verbindung und versuche es noch einmal.')}>Hinweis: Fehler</button>
        <button type="button" className={CHIP} onClick={() => toast.info('Der Export läuft und kommt gleich per E-Mail.')}>Hinweis: Info</button>
        <button
          type="button"
          className={CHIP}
          onClick={() => toast.info('Aufgabe erledigt', { action: { label: 'Rückgängig', onClick: () => toast.success('Aufgabe wieder offen') } })}
        >
          Hinweis mit Aktion
        </button>
        <button
          type="button"
          className={CHIP}
          onClick={() => {
            toast.info('Erster Hinweis (weicht dem vierten)')
            toast.success('Zweiter Hinweis')
            toast.error('Dritter Hinweis')
            toast.info('Vierter Hinweis')
          }}
        >
          Vier auf einmal
        </button>
        <button type="button" className={CHIP} onClick={() => toast.dismiss()}>Alle schließen</button>
      </div>
    </Section>
  )
}

// Aktionsmenü und langer Druck
const SAMPLE_UNITS = ['A-204', 'B-101', 'C-305']

export function MenuSection() {
  const toast = useToast()

  const menuItems: ActionItem[] = [
    { id: 'edit', label: 'Bearbeiten', icon: 'edit', onClick: () => toast.info('Bearbeiten') },
    { id: 'copy', label: 'Link zur Wohnung kopieren', icon: 'link', onClick: () => toast.success('Link kopiert') },
    { id: 'deck', label: 'Präsentation öffnen', icon: 'externalLink', onClick: () => toast.info('Präsentation') },
    { id: 'locked', label: 'Reservieren (schon vergeben)', icon: 'key', onClick: () => toast.info('Reservieren'), disabled: true },
    { id: 'hidden', label: 'Nur für Admins', onClick: () => toast.info('Versteckt'), hidden: true },
    { id: 'delete', label: 'Löschen', icon: 'trash', tone: 'danger', onClick: () => toast.error('Löschen ist in der Vorschau abgeschaltet') },
  ]

  // Ein Element mit festem Menü
  const single = useContextMenu(menuItems, { title: 'Wohnung A-204' })
  // Liste: je Zeile eigene Einträge
  const list = useContextMenu()
  const unitItems = (unit: string): ActionItem[] => [
    { id: 'open', label: `${unit} öffnen`, icon: 'unit', onClick: () => toast.info(`${unit} geöffnet`) },
    { id: 'reserve', label: `${unit} reservieren`, icon: 'key', onClick: () => toast.success(`${unit} reserviert (nur Beispiel)`) },
  ]

  return (
    <Section
      title="Aktionsmenü und langer Druck"
      hint="Der Mehr-Knopf sitzt ganz am rechten Rand: das Menü bleibt im Fenster. Auf dem Telefon öffnet sich ein Blatt von unten. Rechtsklick oder 500 ms gedrückt halten öffnet dasselbe Menü."
    >
      <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 py-1 pl-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold font-body text-hp-navy">Wohnung A-204, Olive Garden Residences</p>
          <p className="truncate text-xs font-body text-gray-500">Mehr-Knopf am rechten Rand</p>
        </div>
        <ActionMenu items={menuItems} label="Aktionen für Wohnung A-204" title="Wohnung A-204" className="-mr-1 sm:mr-0" />
      </div>

      <div
        {...single.handlers}
        tabIndex={0}
        className="mt-4 select-none rounded-xl border border-dashed border-gray-300 bg-hp-cream px-4 py-8 text-center text-sm font-body text-gray-600 [-webkit-touch-callout:none] focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70"
      >
        Hier rechts klicken oder den Finger 500 ms gedrückt halten
        {single.isOpen && <span className="ml-2 font-semibold text-hp-navy">(Menü offen)</span>}
      </div>
      {single.menu}

      <ul className="mt-4 divide-y divide-gray-100 rounded-xl border border-gray-100">
        {SAMPLE_UNITS.map(unit => (
          <li
            key={unit}
            {...list.bind(() => unitItems(unit))}
            onClick={() => toast.info(`Zeile ${unit} angeklickt`)}
            className="flex min-h-[44px] cursor-pointer select-none items-center gap-3 px-4 text-sm font-body text-gray-700 [-webkit-touch-callout:none] hover:bg-hp-cream"
          >
            <Icon name="unit" size={18} className="shrink-0 text-gray-400" />
            <span className="flex-1">Wohnung {unit}: tippen öffnet, halten zeigt das Menü</span>
          </li>
        ))}
      </ul>
      {list.menu}
    </Section>
  )
}

// Kleinteile: Knöpfe, Felder, Badges, Lade-Ring, leerer Zustand
export function PartsSection() {
  return (
    <Section title="Knöpfe, Felder, Badges, Lade-Ring, leerer Zustand">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="hp-btn hp-btn-primary">Speichern</button>
        <button type="button" className="hp-btn hp-btn-accent">Termin buchen</button>
        <button type="button" className="hp-btn hp-btn-ghost">Abbrechen</button>
        <button type="button" className="hp-btn hp-btn-danger"><Icon name="trash" size={16} />Löschen</button>
        <button type="button" className="hp-btn hp-btn-primary" disabled>Gesperrt</button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <input className="hp-input" placeholder="Suche nach Name oder E-Mail" aria-label="Beispiel-Suchfeld" />
        <input className="hp-input" defaultValue="Nicht änderbar" disabled aria-label="Gesperrtes Beispielfeld" />
        <textarea className="hp-input" rows={1} placeholder="Mehrzeiliges Feld" aria-label="Beispiel-Textfeld" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge>Neutral</Badge>
        <Badge tone="info" icon="info">Info</Badge>
        <Badge tone="success" icon="check">Bezahlt</Badge>
        <Badge tone="warning" dot>Reserviert</Badge>
        <Badge tone="danger" icon="alert">Überfällig</Badge>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-6">
        <Spinner size="sm" />
        <Spinner size="md" />
        <Spinner size="lg" label="Wohnungen werden geladen" />
        <span className="inline-flex items-center gap-2 text-sm font-body text-gray-600"><Spinner size="sm" />Speichert</span>
      </div>

      <div className="mt-4 rounded-xl border border-gray-100">
        <EmptyState
          icon="calendar"
          title="Keine Termine in dieser Woche"
          text="Plane einen Termin oder sieh in der nächsten Woche nach."
          action={
            <>
              <button type="button" className="hp-btn hp-btn-primary"><Icon name="plus" size={16} />Termin planen</button>
              <button type="button" className="hp-btn hp-btn-ghost">Nächste Woche</button>
            </>
          }
        />
      </div>
    </Section>
  )
}
