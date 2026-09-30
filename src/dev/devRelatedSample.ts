// NUR FÜR DEN DEV-SERVER (siehe devMock.ts). Erfundene Antwort von
// hp_lead_related für die Karte "Gehört dazu" in der Vorschau /__dev/ui.
// Keine echten Kunden, Projekte oder Tokens; die Vorschau ruft keine Datenbank.
import type { LeadRelated, RelatedTask } from '../lib/relatedTypes'

const task = (id: string, title: string, status: string, due: string | null): RelatedTask => ({
  id, title, status, due_date: due, archived: false,
})

export const SAMPLE_RELATED: LeadRelated = {
  lead_id: 'vorschau-kunde-1',
  viewer: { role: 'admin', can: { pipeline: true, invoices: true, funnel: true, contacts: true, decks: true } },
  deals: {
    count: 2,
    items: [
      { id: 'vorschau-deal-1', phase: 'reservierung', archived_from_phase: null, archived: false, unit_id: 'vorschau-unit-1', property_id: null, created_at: '2026-08-12T09:00:00Z' },
      { id: 'vorschau-deal-2', phase: 'archiviert', archived_from_phase: 'provision_erhalten', archived: true, unit_id: 'vorschau-unit-2', property_id: 'vorschau-prop-1', created_at: '2025-11-03T09:00:00Z' },
    ],
  },
  units: {
    count: 3,
    items: [
      { id: 'vorschau-unit-1', unit_number: 'A-204', project_id: 'vorschau-proj-1', project_name: 'Olive Garden Residences', property_id: null, via: ['deal'] },
      { id: 'vorschau-unit-2', unit_number: 'B-101', project_id: 'vorschau-proj-2', project_name: 'Sea Breeze Paphos', property_id: 'vorschau-prop-1', via: ['deal', 'owner'] },
      { id: 'vorschau-unit-3', unit_number: 'Villa 7', project_id: 'vorschau-proj-3', project_name: 'Kings Hill Villas', property_id: 'vorschau-prop-2', via: ['co_owner'] },
    ],
  },
  properties: {
    count: 2,
    items: [
      { id: 'vorschau-prop-1', project_name: 'Sea Breeze Paphos', unit_number: 'B-101', property_status: 'vermietet', role: 'owner' },
      { id: 'vorschau-prop-2', project_name: 'Kings Hill Villas', unit_number: 'Villa 7', property_status: 'im_bau', role: 'co_owner' },
    ],
  },
  // Sieben Aufgaben, fünf geliefert: "alle 7 anzeigen" und danach "und 2 weitere"
  tasks: {
    count: 7,
    items: [
      task('vorschau-task-1', 'Reservierungsvertrag gegenlesen', 'offen', '2026-10-02'),
      task('vorschau-task-2', 'Finanzierungsbestätigung anfordern', 'offen', '2026-10-06'),
      task('vorschau-task-3', 'Grundriss B-101 schicken', 'in_arbeit', null),
      task('vorschau-task-4', 'Rückruf wegen Möblierung', 'offen', '2026-10-09'),
      task('vorschau-task-5', 'Willkommensmail Eigentümerportal', 'erledigt', '2026-09-20'),
    ],
  },
  appointments: {
    count: 2,
    items: [
      { id: 'vorschau-termin-1', start_time: '2026-10-02T08:00:00Z', title: 'Videocall Reservierung', type: 'zoom', internal: false },
      { id: 'vorschau-termin-2', start_time: '2026-09-18T13:30:00Z', title: 'Übergabe vorbereiten', type: 'intern', internal: true },
    ],
  },
  decks: {
    count: 1,
    items: [
      { id: 'vorschau-deck-1', token: 'vorschau-deck-token', status: 'sent', project_id: 'vorschau-proj-1', project_name: 'Olive Garden Residences', created_at: '2026-08-20T10:00:00Z' },
    ],
  },
  calculations: {
    count: 1,
    items: [{ id: 'vorschau-rechnung-1', token: 'vorschau-rechnung-token', title: 'Rendite A-204', created_at: '2026-08-21T10:00:00Z' }],
  },
  strategy: {
    count: 1,
    items: [{ id: 'vorschau-strategie-1', token: 'vorschau-strategie-token', title: 'Drei Wohnungen bis 2029', updated_at: '2026-09-01T10:00:00Z' }],
  },
  invoices: {
    count: 1,
    items: [{ id: 'vorschau-re-1', invoice_number: 'RE-2026-0042', status: 'sent', total: 11900, currency: 'EUR', token: 'vorschau-re-token' }],
  },
  registrations: {
    count: 1,
    items: [{ id: 'vorschau-reg-1', developer: 'Bauträger Beispiel Ltd', registered_at: '2026-08-10T00:00:00Z', created_at: '2026-08-10T09:00:00Z' }],
  },
  newsletter: {
    count: 1,
    items: [{ id: 'vorschau-abo-1', optout_at: null, created_at: '2026-03-02T09:00:00Z' }],
    lead_optout_at: null,
  },
  portal: {
    has_access: true,
    profile_id: 'vorschau-profil-1',
    access_sent_at: '2026-09-15T09:00:00Z',
    last_login_at: '2026-09-28T19:12:00Z',
    login_count: 14,
  },
  documents: { count: 9, property_documents: 6, unit_documents: 3 },
  payments: { count: 4, open: 1 },
  reviews: { count: 1, last_status: 'submitted' },
  affiliate: { is_affiliate: true, referred_count: 2, payout_count: 1 },
  drive: { count: 23 },
}

// Kunde ohne jede Verknüpfung: die Karte zeigt "Noch nichts verknüpft"
export const SAMPLE_RELATED_EMPTY: LeadRelated = {
  lead_id: 'vorschau-kunde-2',
  viewer: SAMPLE_RELATED.viewer,
  deals: { count: 0, items: [] },
  units: { count: 0, items: [] },
  properties: { count: 0, items: [] },
  tasks: { count: 0, items: [] },
  appointments: { count: 0, items: [] },
  decks: null,
  calculations: { count: 0, items: [] },
  strategy: null,
  invoices: { count: 0, items: [] },
  registrations: { count: 0, items: [] },
  newsletter: { count: 0, items: [], lead_optout_at: null },
  portal: { has_access: false, profile_id: null, access_sent_at: null, last_login_at: null, login_count: null },
  documents: { count: 0, property_documents: 0, unit_documents: 0 },
  payments: null,
  reviews: { count: 0, last_status: null },
  affiliate: { is_affiliate: false, referred_count: 0, payout_count: 0 },
  drive: { count: 0 },
}
