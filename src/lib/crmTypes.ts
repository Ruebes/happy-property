// ── CRM Shared Types ───────────────────────────────────────────
import type React from 'react'

export type LeadSource  = 'meta' | 'google' | 'empfehlung' | 'sonstiges'
export type LeadStatus  = 'new' | 'contacted' | 'qualified' | 'registered' | 'property_selection' | 'financing' | 'sold' | 'archived'
export type ActivityType = 'call' | 'email' | 'whatsapp' | 'note' | 'meeting' | 'task'

export type DealPhase =
  | 'erstkontakt'
  | 'termin_gebucht'
  | 'no_show'
  | 'finanzierung_de'
  | 'finanzierung_cy'
  | 'registrierung'
  | 'immobilienauswahl'
  | 'kaufvertrag'
  | 'anzahlung'
  | 'provision_erhalten'
  | 'deal_verloren'
  | 'archiviert'

export interface Lead {
  id:                string
  first_name:        string
  last_name:         string
  email:             string
  phone:             string | null
  whatsapp:          string | null
  country:           string | null
  language:          'de' | 'en'
  source:            LeadSource
  status:            LeadStatus
  assigned_to:       string | null
  notes:             string | null
  calendly_event_id: string | null
  created_at:        string
  updated_at:        string
  // joined
  assignee?: { full_name: string; email: string } | null
}

export interface Deal {
  id:                           string
  lead_id:                      string
  property_id:                  string | null
  phase:                        DealPhase
  developer:                    string | null
  registration_sent_at:         string | null
  financing_required:           boolean
  financing_partner_notified_at: string | null
  google_drive_url:              string | null
  lawyer_notified_at:            string | null
  deposit_paid_at:               string | null
  commission_paid_at:            string | null
  commission_amount:             number | null
  // phase-specific notes
  registration_notes:           string | null
  finanzierung_de_notes:        string | null
  finanzierung_cy_notes:        string | null
  immobilien_notes:             string | null
  kaufvertrag_notes:            string | null
  provision_notes:              string | null
  created_at:                   string
  updated_at:                   string
  // joined
  lead?:     Lead | null
  property?: { id: string; project_name: string; unit_number: string | null } | null
}

export interface Activity {
  id:           string
  lead_id:      string
  deal_id:      string | null
  type:         ActivityType
  direction:    'inbound' | 'outbound'
  subject:      string | null
  content:      string | null
  scheduled_at: string | null
  completed_at: string | null
  created_by:   string | null
  created_at:   string
  creator?:     { full_name: string } | null
}

export interface EmailTemplate {
  id:        string
  name:      string
  subject:   string
  body:      string
  category:  'general' | 'project' | 'followup' | 'noshow' | 'lawyer' | 'financing'
  language:  'de' | 'en'
  created_at: string
}

// Ordered pipeline phases (no 'archiviert' in kanban; 'deal_verloren' last = red column)
export const DEAL_PHASES: DealPhase[] = [
  'erstkontakt', 'termin_gebucht', 'no_show',
  'finanzierung_de', 'finanzierung_cy',
  'registrierung', 'immobilienauswahl',
  'kaufvertrag', 'anzahlung', 'provision_erhalten',
  'deal_verloren',
]

export const PHASE_ICONS: Record<DealPhase, string> = {
  erstkontakt:        '📥',
  termin_gebucht:     '📅',
  no_show:            '❌',
  finanzierung_de:    '🏦',
  finanzierung_cy:    '🌍',
  registrierung:      '📋',
  immobilienauswahl:  '🏠',
  kaufvertrag:        '📝',
  anzahlung:          '✅',
  provision_erhalten: '🎉',
  deal_verloren:      '🚫',
  archiviert:         '📦',
}

export const SOURCE_COLORS: Record<LeadSource, string> = {
  meta:       'bg-blue-100 text-blue-700',
  google:     'bg-orange-100 text-orange-700',
  empfehlung: 'bg-green-100 text-green-700',
  sonstiges:  'bg-gray-100 text-gray-700',
}

// Inline styles for exact brand colors
export const SOURCE_BADGE_STYLE: Record<LeadSource, React.CSSProperties> = {
  meta:       { backgroundColor: '#e8f0fe', color: '#1877F2' },
  google:     { backgroundColor: '#fff0eb', color: '#ff795d' },
  empfehlung: { backgroundColor: '#dcfce7', color: '#16a34a' },
  sonstiges:  { backgroundColor: '#f3f4f6', color: '#6b7280' },
}

// Phase → n8n webhook event mapping
export const PHASE_WEBHOOK_EVENTS: Partial<Record<DealPhase, string>> = {
  no_show:            'deal.no_show',
  registrierung:      'deal.registration',
  finanzierung_de:    'deal.financing',
  finanzierung_cy:    'deal.financing',
  kaufvertrag:        'deal.contract',
  anzahlung:          'deal.deposit_paid',
  provision_erhalten: 'deal.commission_paid',
}

// ── Project Types ────────────────────────────────────────────────────────────

export type ProjectStatus = 'available' | 'under_construction' | 'sold_out' | 'completed'
export type UnitType      = 'villa' | 'apartment' | 'studio'
export type UnitStatus    = 'available' | 'reserved' | 'sold' | 'under_construction'

export interface CrmProject {
  id:              string
  name:            string
  developer:       string | null   // Freitext
  description_de:  string | null
  description_en:  string | null
  location:        string | null
  latitude:        number | null
  longitude:       number | null
  status:          ProjectStatus
  completion_date: string | null
  images:          string[]
  video_url:       string | null
  equipment_list:  string | null
  created_at:      string
  updated_at:      string
  // joined
  units?:      CrmProjectUnit[]
}

export interface CrmProjectUnit {
  id:          string
  project_id:  string
  unit_number: string
  type:        UnitType
  bedrooms:    number
  size_sqm:    number | null
  price_net:   number | null
  status:      UnitStatus
  floor:       number | null
  notes:       string | null
  property_id: string | null
  created_at:  string
  updated_at:  string
}

export interface DealProject {
  id:           string
  deal_id:      string
  project_id:   string
  unit_numbers: string | null
  price_net:    number | null
  notes:        string | null
  created_at:   string
  updated_at:   string
  // joined
  project?: Pick<CrmProject, 'id' | 'name' | 'images' | 'location'> | null
}

export const PROJECT_STATUS_COLORS: Record<ProjectStatus, string> = {
  available:          'bg-green-100 text-green-700',
  under_construction: 'bg-yellow-100 text-yellow-700',
  sold_out:           'bg-red-100 text-red-700',
  completed:          'bg-blue-100 text-blue-700',
}

// ── CRM Appointment Types ─────────────────────────────────────────────────────

export type AppointmentType = 'zoom' | 'inperson' | 'phone'

export interface CrmAppointment {
  id:              string
  title:           string
  description:     string | null
  type:            AppointmentType
  start_time:      string
  end_time:        string
  lead_id:         string | null
  zoom_link:       string | null
  zoom_meeting_id: string | null
  location:        string | null
  location_url:    string | null
  phone_number:    string | null
  google_event_id: string | null
  created_by:      string | null
  created_at:      string
  updated_at:      string
  // joined
  lead?: { id: string; first_name: string; last_name: string } | null
}
