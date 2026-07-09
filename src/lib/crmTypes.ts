// ── CRM Shared Types ───────────────────────────────────────────
import type React from 'react'

export type LeadSource  = 'meta' | 'google' | 'empfehlung' | 'sonstiges'
export type LeadStatus  = 'new' | 'contacted' | 'qualified' | 'registered' | 'property_selection' | 'financing' | 'sold' | 'archived'
export type ActivityType = 'call' | 'email' | 'whatsapp' | 'note' | 'meeting' | 'task'

export type DealPhase =
  | 'erstkontakt'
  | 'termin_gebucht'
  | 'registrierung'
  | 'no_show'
  | 'finanzierung_de'
  | 'finanzierung_cy'
  | 'immobilienauswahl'
  | 'reservierung'
  | 'kaufvertrag'
  | 'anzahlung'
  | 'provision_erhalten'
  | 'hold'
  | 'kontakt_uebergeben'
  | 'deal_verloren'
  | 'archiviert'

export interface Lead {
  id:                string
  first_name:        string
  last_name:         string
  email:             string
  phone:             string | null
  whatsapp:          string | null
  alt_emails:        string[]        // weitere E-Mail-Adressen (Haupt = email)
  alt_phones:        string[]        // weitere Telefonnummern (Haupt = phone/whatsapp)
  country:           string | null
  language:          'de' | 'en'
  source:            LeadSource
  status:            LeadStatus
  assigned_to:       string | null
  profile_id:            string | null   // Auth-User / Eigentümer-Profil (null = noch kein Portal-Zugang)
  portal_access_sent_at: string | null   // wann wurde der Portalzugang verschickt?
  notes:             string | null
  calendly_event_id: string | null
  drive_folder_id:   string | null   // Google-Drive-Kundenordner (create-client-drive-folder)
  drive_folder_url:  string | null
  // Werbe-Tracking (UTM) — aus Calendly payload.tracking bzw. Typeform Hidden Fields
  utm_source:        string | null   // z.B. ig / fb / instagram / google
  utm_medium:        string | null   // z.B. paid / cpc
  utm_campaign:      string | null   // Kampagnenname
  utm_content:       string | null   // Anzeige / Ad
  created_at:        string
  updated_at:        string
  // joined
  assignee?: { full_name: string; email: string } | null
}

export interface Deal {
  id:                           string
  lead_id:                      string
  property_id:                  string | null
  unit_id:                      string | null   // direkte CRM-Einheit
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
  phase_changed_at:             string | null   // wann aktuelle Phase erreicht (Auto-Archiv)
  archived_from_phase:          string | null   // Ursprungsphase vor Archivierung (korrektes Restore)
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
  html_body: string | null   // optionales HTML-Template mit {{platzhalter}}
  category:  'general' | 'project' | 'followup' | 'noshow' | 'lawyer' | 'financing' | 'portal'
  language:  'de' | 'en'
  created_at: string
}

// Ordered pipeline phases (no 'archiviert' in kanban; 'deal_verloren' last = red column)
export const DEAL_PHASES: DealPhase[] = [
  'erstkontakt', 'termin_gebucht', 'registrierung', 'no_show',
  'finanzierung_de', 'finanzierung_cy',
  'immobilienauswahl', 'reservierung',
  'kaufvertrag', 'anzahlung', 'provision_erhalten',
  'hold', 'kontakt_uebergeben',
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
  reservierung:       '🔖',
  kaufvertrag:        '📝',
  anzahlung:          '✅',
  provision_erhalten: '🎉',
  hold:               '⏸️',
  kontakt_uebergeben: '🤝',
  deal_verloren:      '🚫',
  archiviert:         '📦',
}

export const SOURCE_COLORS: Record<LeadSource, string> = {
  meta:       'bg-blue-100 text-blue-700',
  google:     'bg-orange-100 text-orange-700',
  empfehlung: 'bg-green-100 text-green-700',
  sonstiges:  'bg-gray-100 text-gray-700',
}

// Werbekanal aus utm_source ableiten. Meta-Anzeigen liefern via {{site_source_name}}
// z.B. fb/ig/an/msg; eigene UTM-Setups eher "facebook"/"instagram"/"google".
// Gibt ein menschenlesbares Label zurück (oder den Rohwert), null wenn leer.
export function adChannelLabel(utmSource: string | null | undefined): string | null {
  if (!utmSource) return null
  const s = utmSource.trim().toLowerCase()
  if (!s) return null
  if (s === 'ig'  || s.includes('insta'))                return 'Instagram'
  if (s === 'fb'  || s.includes('facebook'))             return 'Facebook'
  if (s === 'an'  || s.includes('audience'))             return 'Audience Network'
  if (s === 'msg' || s.includes('messenger'))            return 'Messenger'
  if (s.includes('meta'))                                return 'Meta'
  if (s.includes('google'))                              return 'Google'
  if (s.includes('tiktok'))                              return 'TikTok'
  if (s.includes('youtube') || s === 'yt')               return 'YouTube'
  return utmSource
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
  reservierung:       'deal.reservation',
  kaufvertrag:        'deal.contract',
  anzahlung:          'deal.deposit_paid',
  provision_erhalten: 'deal.commission_paid',
}

// ── Project Types ────────────────────────────────────────────────────────────

export type ProjectStatus = 'available' | 'under_construction' | 'sold_out' | 'completed'
export type UnitType      = 'villa' | 'apartment' | 'studio'
export type UnitStatus    = 'under_construction' | 'active' | 'proposal' | 'reserved' | 'sold'

export interface CrmProject {
  id:              string
  name:            string
  developer:       string | null   // Freitext
  description_de:  string | null
  description_en:  string | null
  location:        string | null
  latitude:        number | null
  longitude:       number | null
  maps_url:        string | null   // Google-Maps-Pin/Link (auch Kurzlink); Koords daraus aufgelöst
  status:          ProjectStatus
  completion_date: string | null
  images:          string[]
  video_url:       string | null
  equipment_list:  string | null
  furniture_cost:     number | null   // Preis Einrichtungspaket (netto, €) — Default für Möbel-AfA in Berechnungen
  furniture_included: boolean | null  // Möbel im Kaufpreis enthalten (kostenfrei) → keine separate AfA
  drive_folder_id: string | null   // Google-Drive-Ordner des Projekts (Quelle für Deck-Assets)
  deck_assets:     DeckAssetsCache | null  // gecachte Drive-Assets (prepare-project-assets)
  deck_token:      string | null   // generisches Projekt-Deck (/deck/<token>) für Zoom
  deck_generated_at: string | null
  created_at:      string
  updated_at:      string
  // joined
  units?:      CrmProjectUnit[]
}

// Cache der automatisch aus Drive importierten Deck-Assets (crm_projects.deck_assets).
export interface DeckAssetsCache {
  renders?:    string[]
  gallery?:    { url: string; category: string; label: string }[]
  floorplans?: { floor: number | null; label: string; url: string }[]
  map?:        string | null
  mapUrl?:     string | null
  mapMarker?:  { x: number; y: number } | null   // %-Position des echten Standort-Pins auf der Karte (Vision-erkannt)
  doc_urls?:   Record<string, string>
  spec_text?:  string
  facts?:      string
  updated_at?: string
}

// ── Rechnungstool ─────────────────────────────────────────────────────────────

export type VatTreatment =
  | 'standard_19' | 'reduced_9' | 'reduced_5' | 'reduced_3'
  | 'zero' | 'reverse_charge_eu' | 'third_country' | 'exempt'
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'canceled'
export type CustomerMode  = 'cyprus' | 'eu' | 'third'
export type PlanInterval  = 'monthly' | 'quarterly' | 'yearly'

export interface InvoiceCustomer {
  id:            string
  company_name:  string
  contact_name:  string | null
  address_line1: string | null
  address_line2: string | null
  postal_code:   string | null
  city:          string | null
  country:       string | null
  vat_number:    string | null
  email:         string | null
  country_mode:  CustomerMode
  is_default:    boolean
  notes:         string | null
  created_at:    string
  updated_at:    string
}

export interface InvoiceArticle {
  id:          string
  name:        string
  description: string | null
  unit:        string
  net_price:   number
  active:      boolean
  created_at:  string
  updated_at:  string
}

export interface SubscriptionPlan {
  id:          string
  name:        string
  description: string | null
  interval:    PlanInterval
  net_price:   number
  active:      boolean
  created_at:  string
  updated_at:  string
}

export interface InvoiceSettings {
  id:                boolean
  legal_name:        string
  brand_name:        string
  address_line1:     string | null
  address_line2:     string | null
  postal_code:       string | null
  city:              string | null
  country:           string | null
  vat_number:        string | null
  reg_number:        string | null
  email:             string | null
  phone:             string | null
  bank_name:         string | null
  iban:              string | null
  bic:               string | null
  intermediary_bic:  string | null
  logo_url:          string | null
  default_due_days:  number
  invoice_prefix:    string
  next_number:       number
  footer_note:       string | null
  auto_send_deposit: boolean
  updated_at:        string
}

export interface InvoiceItem {
  id:             string
  invoice_id:     string
  description:    string
  quantity:       number
  unit_price_net: number
  line_net:       number
  sort:           number
}

export interface Invoice {
  id:                string
  invoice_number:    string
  token:             string
  customer_id:       string | null
  deal_id:           string | null
  lead_id:           string | null
  issuer_snapshot:   Record<string, unknown> | null
  customer_snapshot: Record<string, unknown> | null
  issue_date:        string
  supply_date:       string | null
  due_date:          string | null
  vat_treatment:     VatTreatment
  vat_rate:          number
  subtotal_net:      number
  vat_amount:        number
  total_gross:       number
  currency:          string
  status:            InvoiceStatus
  vat_note:          string | null
  notes:             string | null
  pdf_path:          string | null
  sent_at:           string | null
  paid_at:           string | null
  created_at:        string
  updated_at:        string
  // joined / public
  items?:            InvoiceItem[]
  customer?:         InvoiceCustomer | null
}

export type UnitRentalType = 'short' | 'long'
export type UnitDocType   = 'kaufvertrag' | 'mietvertrag' | 'zahlungsbeleg' | 'grundriss' | 'rechnung' | 'sonstiges'

export interface CrmProjectUnit {
  id:             string
  project_id:     string
  unit_number:    string
  block:          string | null
  type:           UnitType
  bedrooms:       number
  bathrooms:      number
  size_sqm:       number | null
  terrace_sqm:    number | null
  price_net:      number | null
  price_gross:    number | null
  vat_rate:       number
  status:         UnitStatus
  floor:          number | null
  notes:          string | null
  property_id:    string | null
  is_furnished:   boolean
  handover_date:  string | null
  rental_type:    UnitRentalType | null
  verwalter_id:   string | null
  is_completed:   boolean
  images:         string[]
  created_at:     string
  updated_at:     string
  // joined
  verwalter?: { id: string; full_name: string } | null
}

export interface CrmUnitDocument {
  id:          string
  unit_id:     string
  project_id:  string
  name:        string
  file_path:   string
  file_name:   string
  file_size:   number | null
  doc_type:    UnitDocType
  notes:       string | null
  uploaded_by: string | null
  created_at:  string
}

export interface ConstructionPhoto {
  id:          string
  project_id:  string
  file_path:   string
  file_name:   string
  file_size:   number | null
  photo_date:  string | null  // ISO date 'YYYY-MM-DD'
  description: string | null
  uploaded_by: string | null
  created_at:  string
}

export interface CrmUnitPayment {
  id:                string
  unit_id:           string
  project_id:        string
  description:       string | null
  amount:            number
  due_date:          string | null
  paid_date:         string | null
  is_paid:           boolean
  payment_reference: string | null
  // invoice file (Rechnung)
  invoice_path:      string | null
  invoice_filename:  string | null
  invoice_filesize:  number | null
  // receipt file (Zahlungsbeleg)
  receipt_path:      string | null
  receipt_filename:  string | null
  receipt_filesize:  number | null
  created_at:        string
  updated_at:        string
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

// ── Developer Types ───────────────────────────────────────────────────────────

export interface Developer {
  id:         string
  name:       string
  active:     boolean
  created_at: string
}

// Ansprechpartner pro Developer (Mail/WhatsApp aus dem CRM, Drive-Freigabe).
export interface DeveloperContact {
  id:           string
  developer_id: string
  name:         string
  email:        string | null
  phone:        string | null
  whatsapp:     string | null
  role:         string | null
  is_primary:   boolean
  notes:        string | null
  language:     'de' | 'en'    // Kontaktsprache: Mails/WhatsApp kommen hierin an
  created_at:   string
  updated_at:   string
}

// Freistehende Geschäftskontakte (Anwälte, Finanzierer, Partner, sonstige) —
// nicht an einen Developer gebunden. Wählbar als Empfänger für Mail/WhatsApp.
export interface BusinessContact {
  id:         string
  first_name: string
  last_name:  string | null
  company:    string | null
  role:       string | null   // Funktion
  email:      string | null
  phone:      string | null
  whatsapp:   string | null
  notes:      string | null
  language:   'de' | 'en'      // Kontaktsprache: Mails/WhatsApp kommen hierin an
  created_at: string
  updated_at: string
}

// ── Automation System Types ───────────────────────────────────────────────────

export interface AutomationRule {
  id:                   string
  name:                 string
  description:          string | null
  event_type:           string
  delay_minutes:        number
  message_type:         'email' | 'whatsapp' | 'both'
  email_template_id:    string | null
  whatsapp_event_type:  string | null
  is_active:            boolean
  recipient:            string   // 'client' | 'bc:<id>' | 'dc:<id>'
  appointment_condition: 'none' | 'no_appointment' | 'has_appointment' | 'has_zoom' | 'no_zoom'
  timing_type:          'after_event' | 'before_appointment'
  drive_trigger:        boolean
  drive_share:          string[] | null
  created_at:           string
  updated_at:           string
}

export type ScheduledMessageStatus = 'pending' | 'processing' | 'sent' | 'cancelled' | 'failed' | 'skipped'

export interface ScheduledMessage {
  id:             string
  lead_id:        string
  deal_id:        string | null
  type:           'email' | 'whatsapp' | 'both'
  event_type:     string
  status:         ScheduledMessageStatus
  scheduled_at:   string
  sent_at:        string | null
  email_subject:  string | null
  email_body:     string | null
  whatsapp_text:  string | null
  error_message:  string | null
  rule_id:        string | null
  recipient:      string         // 'client' | 'bc:<id>' | 'dc:<id>'
  created_at:     string
  // joined
  lead?: { first_name: string; last_name: string; email: string } | null
}

// ── CRM Appointment Types ─────────────────────────────────────────────────────

export type AppointmentType = 'zoom' | 'inperson' | 'phone' | 'whatsapp'

export interface CrmAppointment {
  id:              string
  title:           string
  description:     string | null
  type:            AppointmentType
  start_time:      string
  end_time:        string
  lead_id:         string | null
  deal_id:         string | null
  zoom_link:       string | null
  zoom_meeting_id: string | null
  location:        string | null
  location_url:    string | null
  phone_number:    string | null
  google_event_id: string | null
  google_calendar_id: string | null
  created_by:      string | null
  created_at:      string
  updated_at:      string
  // joined
  lead?: { id: string; first_name: string; last_name: string; phone?: string | null; whatsapp?: string | null; notes?: string | null } | null
}

// ── Ad-hoc / Sonstige Nachrichten ─────────────────────────────────────────────
// Einmalige WhatsApp/E-Mail-Nachrichten, NICHT an eine Pipeline-Phase gebunden.
// Reine Definition (Zweck + Inhalt + Sendezeitpunkt). Bleibt inert, bis Versand
// separat scharfgeschaltet wird — nichts hieraus sendet von selbst.
export type AdhocChannel = 'email' | 'whatsapp'
export type AdhocStatus  = 'draft' | 'scheduled' | 'sent' | 'cancelled'

export interface CrmAdhocMessage {
  id:            string
  label:         string          // Zweck / Bezeichnung
  channel:       AdhocChannel
  email_subject: string | null
  email_body:    string | null
  email_html:    string | null
  whatsapp_text: string | null
  scheduled_at:  string | null   // gewünschter Sendezeitpunkt (null = offen)
  status:        AdhocStatus
  recipient:     string          // 'client' | 'bc:<id>' | 'dc:<id>'
  created_at:    string
  updated_at:    string
}

// ── KI-Antwort-Agent ───────────────────────────────────────────────────────────
// Eingehende Nachricht → KI-Entwurf → Freigabe/Korrektur durch Sven. Freigegebene
// (ggf. korrigierte) Paare dienen als Few-Shot-Beispiele („lernen"). Auto-Versand
// nur, wenn crm_settings.ai_autopilot_enabled = 'true' (Default aus).
export type AiReplyStatus = 'pending' | 'approved' | 'edited' | 'discarded' | 'auto_sent'

export interface AiReplyExample {
  id:           string
  lead_id:      string | null
  channel:      'whatsapp' | 'email'
  inbound_text: string | null   // was der Kunde geschrieben hat
  ai_draft:     string | null   // KI-Vorschlag
  final_text:   string | null   // tatsächlich gesendeter Text (nach Korrektur)
  status:       AiReplyStatus
  is_learning:  boolean         // als Few-Shot-Beispiel nutzbar?
  created_at:   string
  updated_at:   string
}
