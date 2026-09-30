// Antwort von public.hp_lead_related (supabase/migrations/20260930120000_hp_lead_related.sql).
// Von Hand gepflegt: bei jeder Änderung der Funktion hier nachziehen.
//
// Jede Gruppe ist { count, items } oder null, wenn der Betrachter die Tabelle
// nicht lesen darf. items enthält höchstens p_limit Einträge, count zählt alle.

export interface RelatedGroup<T> {
  count: number
  items: T[]
}

export interface RelatedDeal {
  id: string
  phase: string | null
  archived_from_phase: string | null
  // phase === 'archiviert' (die Tabelle deals hat keine eigene Spalte dafür)
  archived: boolean | null
  unit_id: string | null
  property_id: string | null
  created_at: string
}

export type RelatedUnitVia = 'deal' | 'owner' | 'co_owner'

export interface RelatedUnit {
  id: string
  unit_number: string | null
  project_id: string | null
  project_name: string | null
  property_id: string | null
  via: RelatedUnitVia[]
}

export interface RelatedProperty {
  id: string
  project_name: string | null
  unit_number: string | null
  property_status: string | null
  role: 'owner' | 'co_owner'
}

export interface RelatedTask {
  id: string
  title: string | null
  status: string | null
  due_date: string | null
  archived: boolean
}

export interface RelatedAppointment {
  id: string
  start_time: string | null
  // Titel, ersatzweise die Terminart
  title: string | null
  type: string | null
  internal: boolean
}

export interface RelatedDeck {
  id: string
  token: string | null
  status: string | null
  project_id: string | null
  project_name: string | null
  created_at: string
}

export interface RelatedCalculation {
  id: string
  token: string | null
  title: string | null
  created_at: string
}

export interface RelatedStrategy {
  id: string
  token: string | null
  title: string | null
  updated_at: string | null
}

export interface RelatedInvoice {
  id: string
  invoice_number: string | null
  status: string | null
  // crm_invoices.total_gross
  total: number | null
  currency: string | null
  token: string | null
}

export interface RelatedRegistration {
  id: string
  developer: string | null
  registered_at: string | null
  created_at: string
}

export interface RelatedSubscriber {
  id: string
  optout_at: string | null
  created_at: string
}

export interface RelatedNewsletter extends RelatedGroup<RelatedSubscriber> {
  // leads.newsletter_optout_at
  lead_optout_at: string | null
}

export interface RelatedPortal {
  has_access: boolean
  profile_id: string | null
  access_sent_at: string | null
  // Nur für Admin gefüllt (portal_logins ist sonst nicht lesbar)
  last_login_at: string | null
  login_count: number | null
}

export interface RelatedDocuments {
  count: number
  property_documents: number | null
  unit_documents: number | null
}

export interface RelatedPayments {
  count: number
  open: number
}

export interface RelatedReviews {
  count: number
  last_status: string | null
}

export interface RelatedAffiliate {
  is_affiliate: boolean
  referred_count: number
  payout_count: number
}

export interface RelatedDrive {
  count: number
}

export interface RelatedViewer {
  role: string | null
  can: {
    pipeline: boolean
    invoices: boolean
    funnel: boolean
    contacts: boolean
    decks: boolean
  }
}

export interface LeadRelated {
  lead_id: string
  viewer: RelatedViewer
  deals: RelatedGroup<RelatedDeal> | null
  units: RelatedGroup<RelatedUnit> | null
  properties: RelatedGroup<RelatedProperty> | null
  tasks: RelatedGroup<RelatedTask> | null
  appointments: RelatedGroup<RelatedAppointment> | null
  decks: RelatedGroup<RelatedDeck> | null
  calculations: RelatedGroup<RelatedCalculation> | null
  strategy: RelatedGroup<RelatedStrategy> | null
  invoices: RelatedGroup<RelatedInvoice> | null
  registrations: RelatedGroup<RelatedRegistration> | null
  newsletter: RelatedNewsletter | null
  portal: RelatedPortal
  documents: RelatedDocuments | null
  payments: RelatedPayments | null
  reviews: RelatedReviews | null
  affiliate: RelatedAffiliate | null
  drive: RelatedDrive | null
}

// Gruppen der Karte "Gehört dazu" (Reihenfolge = Anzeige-Reihenfolge)
export const RELATED_GROUPS = [
  'deals', 'units', 'properties', 'tasks', 'appointments', 'decks', 'calculations', 'strategy',
  'invoices', 'registrations', 'documents', 'payments', 'newsletter', 'portal', 'reviews', 'affiliate', 'drive',
] as const

export type RelatedGroupKey = typeof RELATED_GROUPS[number]
