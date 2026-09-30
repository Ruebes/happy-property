// NUR FÜR DEN DEV-SERVER (siehe devMock.ts). Erfundene Beispieldaten für die
// Vorschau der UI-Bausteine (/__dev/ui). Keine echten Kunden, keine echten
// Projekte.
import type { BadgeTone } from '../components/ui/Badge'
import type { TabItem } from '../components/ui/Tabs'

export interface SampleDeal {
  id: string
  customer: string
  project: string
  unit: string
  phase: string
  phaseTone: BadgeTone
  price: number
  nextAppointment: string | null
}

export const SAMPLE_DEALS: SampleDeal[] = [
  { id: 'd1', customer: 'Martina Hoffmann', project: 'Olive Garden Residences', unit: 'A-204', phase: 'Reservierung', phaseTone: 'warning', price: 284000, nextAppointment: '2026-10-02T10:00:00' },
  { id: 'd2', customer: 'Dr. Jens Albrecht', project: 'Sea Breeze Paphos', unit: 'B-101', phase: 'Immobilienauswahl', phaseTone: 'info', price: 412500, nextAppointment: '2026-10-06T16:30:00' },
  { id: 'd3', customer: 'Carsten und Ute Behrens', project: 'Kings Hill Villas', unit: 'Villa 7', phase: 'Kaufvertrag', phaseTone: 'success', price: 689000, nextAppointment: null },
  { id: 'd4', customer: 'Sophie Lindner', project: 'Olive Garden Residences', unit: 'C-305', phase: 'Erstgespräch', phaseTone: 'neutral', price: 236000, nextAppointment: '2026-10-01T09:15:00' },
  { id: 'd5', customer: 'Thomas Krüger', project: 'Sea Breeze Paphos', unit: 'A-002', phase: 'Finanzierung offen', phaseTone: 'danger', price: 318900, nextAppointment: '2026-10-09T14:00:00' },
  { id: 'd6', customer: 'Familie Yilmaz-Petersen mit einem sehr langen Namen für den Umbruch', project: 'Kings Hill Villas', unit: 'Villa 12', phase: 'Reservierung', phaseTone: 'warning', price: 745000, nextAppointment: null },
]

export const SAMPLE_TABS: TabItem[] = [
  { id: 'overview', label: 'Übersicht', icon: 'overview' },
  { id: 'units', label: 'Wohnungen', icon: 'unit', count: 12 },
  { id: 'tasks', label: 'Aufgaben', icon: 'tasks', count: 3 },
  { id: 'appointments', label: 'Termine', icon: 'calendar', count: 0 },
  { id: 'documents', label: 'Dokumente', icon: 'documents', count: 28 },
  { id: 'messages', label: 'Nachrichten', icon: 'chat', count: 104 },
  { id: 'invoices', label: 'Rechnungen', icon: 'invoices' },
  { id: 'history', label: 'Verlauf', icon: 'clock' },
  { id: 'internal', label: 'Intern (versteckt)', hidden: true },
]

export const SAMPLE_LANGUAGES = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'Englisch' },
]

export const SAMPLE_SOURCES = [
  { value: 'website', label: 'Website', hint: 'Terminbuchung über die eigene Seite' },
  { value: 'meta', label: 'Meta-Anzeige', hint: 'Facebook oder Instagram' },
  { value: 'empfehlung', label: 'Empfehlung', hint: 'Tippgeber oder Bestandskunde' },
  { value: 'youtube', label: 'YouTube' },
]

const EURO = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
const DATE_TIME = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export function formatEuro(value: number): string {
  return EURO.format(value)
}

export function formatAppointment(value: string | null): string {
  return value ? DATE_TIME.format(new Date(value)) : 'kein Termin'
}
