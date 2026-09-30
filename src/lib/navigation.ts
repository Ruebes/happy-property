// Navigations-Registry der App-Shell: EINE Wahrheit über alle Seiten, ihre
// Gruppen, Rollen, Rechte und Icons. Reine Daten plus reine Helfer, ohne React
// und ohne Supabase, damit scripts/verify-nav.mjs die Datei per esbuild laden
// und gegen die Routen-Guards in src/App.tsx prüfen kann.
//
// Regeln (siehe scripts/verify-nav.mjs):
//   - roles ist immer eine TEILMENGE dessen, was der ProtectedRoute-Guard erlaubt
//   - perm/anyPerm für Mitarbeiter entsprechen exakt dem Guard
//   - jeder labelKey existiert in de.json UND en.json (shell.nav.*), ebenso
//     jeder shortLabelKey (shell.navShort.*)
//   - jedes Icon existiert in src/components/shell/iconPaths.ts
//   - hidden-Einträge erscheinen nie im Menü, dienen nur Hervorhebung und Suche

import { hasPerm, type PermissionArea, type Profile, type UserRole } from './permissions'
import type { IconId } from '../components/shell/iconPaths'

export type NavGroupId =
  | 'start' | 'verkauf' | 'kommunikation' | 'projekte' | 'eigentuemer' | 'marketing'
  | 'auswertung' | 'finanzen' | 'einstellungen' | 'portal' | 'konto'

// Modul-Zuordnung aus MODULES.md (CRM als Produkt): base = Kern, m1..m9 =
// zuschaltbare Module, rental = Ferienvermietung, tbd = noch nicht eingeordnet.
export type ModuleId = 'base' | 'm1' | 'm2' | 'm3' | 'm4' | 'm5' | 'm6' | 'm7' | 'm8' | 'm9' | 'rental' | 'tbd'

export interface NavEntry {
  id: string
  path: string
  labelKey: string
  // Kurzform nur für die Telefon-Leiste, wenn der volle Name bei 375 px Breite
  // abgeschnitten würde (shell.navShort.<id>). Menü, Suche und Seitentitel
  // zeigen immer labelKey.
  shortLabelKey?: string
  icon: IconId
  group: NavGroupId
  order: number
  roles: readonly UserRole[]
  perm?: PermissionArea
  anyPerm?: readonly PermissionArea[]
  module: ModuleId
  // Reihenfolge in der Telefon-Leiste je Rolle (kleiner = weiter vorn, max. 4 sichtbar)
  mobileRank?: Partial<Record<UserRole, number>>
  badge?: 'tasksOpen' | 'inboxUnread'
  // detail = Unterseite (z.B. /leads/:id), alias = zweiter Pfad derselben Seite,
  // legacy = alte Seite, die nur noch per Direktlink erreichbar ist
  hidden?: 'detail' | 'alias' | 'legacy'
  parent?: string
  keywords?: readonly string[]
}

export const NAV_GROUPS: { id: NavGroupId; labelKey: string; order: number }[] = [
  { id: 'start',         labelKey: 'shell.groups.start',         order: 0 },
  { id: 'verkauf',       labelKey: 'shell.groups.verkauf',       order: 1 },
  { id: 'kommunikation', labelKey: 'shell.groups.kommunikation', order: 2 },
  { id: 'projekte',      labelKey: 'shell.groups.projekte',      order: 3 },
  { id: 'eigentuemer',   labelKey: 'shell.groups.eigentuemer',   order: 4 },
  { id: 'marketing',     labelKey: 'shell.groups.marketing',     order: 5 },
  { id: 'auswertung',    labelKey: 'shell.groups.auswertung',    order: 6 },
  { id: 'finanzen',      labelKey: 'shell.groups.finanzen',      order: 7 },
  { id: 'einstellungen', labelKey: 'shell.groups.einstellungen', order: 8 },
  { id: 'portal',        labelKey: 'shell.groups.portal',        order: 9 },
  { id: 'konto',         labelKey: 'shell.groups.konto',         order: 10 },
]

const A = 'admin', V = 'verwalter', M = 'mitarbeiter', F = 'funnel', E = 'eigentuemer', G = 'feriengast'
const AV:   readonly UserRole[] = [A, V]
const AVM:  readonly UserRole[] = [A, V, M]
const AVMF: readonly UserRole[] = [A, V, M, F]

export const NAV_ENTRIES: NavEntry[] = [
  // ── Start ──────────────────────────────────────────────────────────────────
  { id: 'startStaff',       path: '/admin/crm/home',       labelKey: 'shell.nav.startStaff',       icon: 'home', group: 'start', order: 0, roles: [M], module: 'base',
    mobileRank: { mitarbeiter: 1 }, keywords: ['home', 'startseite', 'widgets'] },
  { id: 'startVerwalter',   path: '/verwalter/dashboard',  labelKey: 'shell.nav.startVerwalter',   icon: 'home', group: 'start', order: 1, roles: [V], module: 'rental',
    mobileRank: { verwalter: 1 }, keywords: ['home', 'dashboard'] },
  { id: 'startEigentuemer', path: '/eigentuemer/dashboard', labelKey: 'shell.nav.startEigentuemer', icon: 'home', group: 'start', order: 2, roles: [E], module: 'm9',
    mobileRank: { eigentuemer: 1 }, keywords: ['home', 'dashboard'] },

  // ── Verkauf ────────────────────────────────────────────────────────────────
  { id: 'crmOverview', path: '/admin/crm',          labelKey: 'shell.nav.crmOverview', icon: 'overview',  group: 'verkauf', order: 0, roles: AVM, perm: 'pipeline', module: 'base',
    keywords: ['dashboard', 'crm', 'kennzahlen'] },
  { id: 'pipeline',    path: '/admin/crm/pipeline', labelKey: 'shell.nav.pipeline',    icon: 'pipeline',  group: 'verkauf', order: 1, roles: AVM, perm: 'pipeline', module: 'base',
    mobileRank: { admin: 1, verwalter: 4, mitarbeiter: 3 }, keywords: ['leads', 'deals', 'phasen', 'kanban'] },
  { id: 'customers',   path: '/admin/crm/leads',    labelKey: 'shell.nav.customers',   icon: 'customers', group: 'verkauf', order: 2, roles: AVM, anyPerm: ['pipeline', 'contacts'], module: 'base',
    mobileRank: { admin: 2, mitarbeiter: 4 }, keywords: ['leads', 'kontakte', 'kundenliste', 'interessenten'] },
  { id: 'tasks',       path: '/admin/crm/tasks',    labelKey: 'shell.nav.tasks',       icon: 'tasks',     group: 'verkauf', order: 3, roles: AVM, module: 'base', badge: 'tasksOpen',
    mobileRank: { admin: 4, mitarbeiter: 2 }, keywords: ['todo', 'to-do', 'erledigen'] },
  { id: 'calendar',    path: '/admin/crm/calendar', labelKey: 'shell.nav.calendar',    icon: 'calendar',  group: 'verkauf', order: 4, roles: AVM, perm: 'pipeline', module: 'base',
    mobileRank: { mitarbeiter: 6 }, keywords: ['termine', 'appointments', 'zoom'] },
  { id: 'archive',     path: '/admin/crm/archived', labelKey: 'shell.nav.archive',     icon: 'archive',   group: 'verkauf', order: 5, roles: AVM, perm: 'pipeline', module: 'base',
    keywords: ['archiviert', 'verloren', 'alte leads'] },

  // ── Kommunikation ──────────────────────────────────────────────────────────
  { id: 'inbox',      path: '/admin/crm/inbox',          labelKey: 'shell.nav.inbox',      icon: 'inbox',      group: 'kommunikation', order: 0, roles: AVM,  perm: 'pipeline', module: 'm7', badge: 'inboxUnread',
    mobileRank: { admin: 3, mitarbeiter: 5 }, keywords: ['mail', 'whatsapp', 'nachrichten', 'eingang'] },
  { id: 'outbox',     path: '/admin/crm/postausgang',    labelKey: 'shell.nav.outbox',     icon: 'outbox',     group: 'kommunikation', order: 1, roles: AVM,  perm: 'pipeline', module: 'base',
    keywords: ['gesendet', 'geplant', 'ausgang', 'versand'] },
  { id: 'newsletter', path: '/admin/crm/newsletter',     labelKey: 'shell.nav.newsletter', icon: 'newsletter', group: 'kommunikation', order: 2, roles: AVMF, perm: 'funnel',   module: 'm5',
    mobileRank: { mitarbeiter: 8 }, keywords: ['kampagne', 'mailing', 'rundmail'] },
  { id: 'lists',      path: '/admin/crm/settings/lists', labelKey: 'shell.nav.lists',      icon: 'lists',      group: 'kommunikation', order: 3, roles: AVMF, perm: 'funnel',   module: 'm5',
    keywords: ['verteiler', 'klaviyo', 'listen', 'segmente'] },
  { id: 'workflows',  path: '/admin/crm/workflows',      labelKey: 'shell.nav.workflows',  icon: 'workflow',   group: 'kommunikation', order: 4, roles: AVMF, perm: 'funnel',   module: 'm5',
    keywords: ['automatik', 'flow', 'ablauf', 'automation'] },

  // ── Projekte ───────────────────────────────────────────────────────────────
  { id: 'projects',   path: '/admin/crm/projects',          labelKey: 'shell.nav.projects',   icon: 'projects',   group: 'projekte', order: 0, roles: AVM, perm: 'pipeline', module: 'm1',
    keywords: ['bauprojekte', 'wohnungen', 'units', 'preisliste'] },
  { id: 'developers', path: '/admin/crm/settings',          labelKey: 'shell.nav.developers', icon: 'developers', group: 'projekte', order: 1, roles: AV,  module: 'm1',
    keywords: ['developer', 'bautraeger', 'bauträger', 'partner'] },
  { id: 'contacts',   path: '/admin/crm/settings/contacts', labelKey: 'shell.nav.contacts',   icon: 'contacts',   group: 'projekte', order: 2, roles: AVM, perm: 'contacts', module: 'base',
    mobileRank: { mitarbeiter: 13 }, keywords: ['anwalt', 'steuerberater', 'notar', 'kontakte'] },

  // ── Eigentümer (Verwaltungssicht) ──────────────────────────────────────────
  { id: 'portalOverview',   path: '/admin/dashboard',       labelKey: 'shell.nav.portalOverview',   icon: 'portal',       group: 'eigentuemer', order: 0, roles: [A], module: 'm9',
    keywords: ['verwaltung', 'portal', 'eigentümer'] },
  { id: 'portalProperties', path: '/objekte',               labelKey: 'shell.nav.portalProperties', icon: 'properties',   group: 'eigentuemer', order: 1, roles: AV,  module: 'm9',
    shortLabelKey: 'shell.navShort.portalProperties', mobileRank: { verwalter: 2 }, keywords: ['immobilien', 'wohnungen', 'objekte'] },
  { id: 'occupancy',        path: '/kalender',              labelKey: 'shell.nav.occupancy',        icon: 'occupancy',    group: 'eigentuemer', order: 2, roles: AV,  module: 'rental',
    shortLabelKey: 'shell.navShort.occupancy', mobileRank: { verwalter: 3 }, keywords: ['belegung', 'kalender', 'vermietung'] },
  { id: 'bookings',         path: '/verwaltung/bookings',   labelKey: 'shell.nav.bookings',         icon: 'bookings',     group: 'eigentuemer', order: 3, roles: AV,  module: 'rental',
    keywords: ['gäste', 'aufenthalte', 'buchung'] },
  { id: 'documents',        path: '/dokumente',             labelKey: 'shell.nav.documents',        icon: 'documents',    group: 'eigentuemer', order: 4, roles: AV,  module: 'm9',
    keywords: ['verträge', 'unterlagen', 'pdf'] },
  { id: 'ownerContent',     path: '/admin/crm/owner-content', labelKey: 'shell.nav.ownerContent',   icon: 'ownerContent', group: 'eigentuemer', order: 5, roles: AV,  module: 'm9',
    keywords: ['upload', 'baustellenfotos', 'downloads', 'inhalte'] },
  { id: 'verwaltungen',     path: '/admin/verwaltungen',    labelKey: 'shell.nav.verwaltungen',     icon: 'companies',    group: 'eigentuemer', order: 6, roles: [A], module: 'rental',
    keywords: ['hausverwaltung', 'firmen'] },

  // ── Marketing ──────────────────────────────────────────────────────────────
  { id: 'ads',          path: '/admin/crm/ads',           labelKey: 'shell.nav.ads',          icon: 'ads',          group: 'marketing', order: 0, roles: AVM,  perm: 'werbung',    module: 'm4',
    mobileRank: { mitarbeiter: 10 }, keywords: ['meta', 'facebook', 'instagram', 'anzeigen', 'kampagnen'] },
  { id: 'funnel',       path: '/admin/crm/funnel',        labelKey: 'shell.nav.funnel',       icon: 'funnel',       group: 'marketing', order: 1, roles: AVMF, perm: 'funnel',     module: 'm3',
    shortLabelKey: 'shell.navShort.funnel', mobileRank: { mitarbeiter: 7, funnel: 1 }, keywords: ['termin', 'statistik', 'buchungen', 'conversion'] },
  { id: 'funnelEditor', path: '/admin/crm/funnel-editor', labelKey: 'shell.nav.funnelEditor', icon: 'funnelEditor', group: 'marketing', order: 2, roles: AVMF, perm: 'funnel',     module: 'm3',
    mobileRank: { funnel: 2 }, keywords: ['varianten', 'fragen', 'editor'] },
  { id: 'social',       path: '/admin/crm/social',        labelKey: 'shell.nav.social',       icon: 'social',       group: 'marketing', order: 3, roles: AVMF, perm: 'funnel',     module: 'm6',
    mobileRank: { mitarbeiter: 14 }, keywords: ['instagram', 'linkedin', 'facebook', 'posts', 'reels'] },
  { id: 'thumbnails',   path: '/admin/crm/thumbnails',    labelKey: 'shell.nav.thumbnails',   icon: 'thumbnail',    group: 'marketing', order: 4, roles: AVM,  perm: 'thumbnails', module: 'm6',
    mobileRank: { mitarbeiter: 11 }, keywords: ['bilder', 'vorschaubild', 'youtube'] },
  { id: 'youtube',      path: '/admin/crm/youtube',       labelKey: 'shell.nav.youtube',      icon: 'youtube',      group: 'marketing', order: 5, roles: AVM,  perm: 'youtube',    module: 'm6',
    mobileRank: { mitarbeiter: 12 }, keywords: ['videos', 'upload', 'kanal'] },
  { id: 'reviews',      path: '/admin/crm/reviews',       labelKey: 'shell.nav.reviews',      icon: 'reviews',      group: 'marketing', order: 6, roles: [A], module: 'tbd',
    keywords: ['sterne', 'fragebogen', 'feedback'] },
  { id: 'affiliates',   path: '/admin/crm/affiliates',    labelKey: 'shell.nav.affiliates',   icon: 'affiliates',   group: 'marketing', order: 7, roles: [A], module: 'tbd',
    keywords: ['empfehlung', 'affiliate', 'provision'] },

  // ── Auswertung ─────────────────────────────────────────────────────────────
  { id: 'statistics',   path: '/admin/crm/statistics',   labelKey: 'shell.nav.statistics',   icon: 'statistics',   group: 'auswertung', order: 0, roles: [A], module: 'base',
    keywords: ['zahlen', 'auswertung', 'report'] },
  { id: 'webAnalytics', path: '/admin/crm/webanalytics', labelKey: 'shell.nav.webAnalytics', icon: 'webAnalytics', group: 'auswertung', order: 1, roles: [A], module: 'tbd',
    keywords: ['website', 'besucher', 'heatmap', 'replays'] },
  { id: 'seo',          path: '/admin/crm/seo',          labelKey: 'shell.nav.seo',          icon: 'seo',          group: 'auswertung', order: 2, roles: [A], module: 'tbd',
    keywords: ['google', 'suche', 'ranking', 'sichtbarkeit'] },

  // ── Finanzen ───────────────────────────────────────────────────────────────
  { id: 'invoices', path: '/admin/crm/invoices', labelKey: 'shell.nav.invoices', icon: 'invoices', group: 'finanzen', order: 0, roles: AVM, perm: 'invoices', module: 'm8',
    mobileRank: { mitarbeiter: 9 }, keywords: ['rechnung', 'mwst', 'zahlung'] },
  { id: 'finance',  path: '/admin/crm/finance',  labelKey: 'shell.nav.finance',  icon: 'finance',  group: 'finanzen', order: 1, roles: AV, module: 'm8',
    keywords: ['revolut', 'konto', 'belege', 'buchungen'] },

  // ── Einstellungen ──────────────────────────────────────────────────────────
  { id: 'stageMessages',     path: '/admin/crm/settings/stages',        labelKey: 'shell.nav.stageMessages',     icon: 'messages',   group: 'einstellungen', order: 0, roles: AV,  module: 'base',
    keywords: ['vorlagen', 'templates', 'whatsapp', 'e-mail', 'automatik'] },
  { id: 'aiAgent',           path: '/admin/crm/settings/ai',            labelKey: 'shell.nav.aiAgent',           icon: 'ai',         group: 'einstellungen', order: 1, roles: AV,  module: 'base',
    keywords: ['ki', 'lotte', 'antworten', 'agent'] },
  { id: 'workflowDocuments', path: '/admin/crm/settings/documents',     labelKey: 'shell.nav.workflowDocuments', icon: 'rules',      group: 'einstellungen', order: 2, roles: AV,  module: 'base',
    keywords: ['dokumente', 'unterschrift', 'vertrag'] },
  { id: 'bookingLinks',      path: '/admin/crm/settings/booking-links', labelKey: 'shell.nav.bookingLinks',      icon: 'link',       group: 'einstellungen', order: 3, roles: AVM, perm: 'contacts', module: 'm3',
    keywords: ['buchen', 'link', 'kalender', 'termin'] },
  { id: 'invoiceSettings',   path: '/admin/crm/settings/invoices',      labelKey: 'shell.nav.invoiceSettings',   icon: 'settings',   group: 'einstellungen', order: 4, roles: AVM, perm: 'invoices', module: 'm8',
    keywords: ['rechnung', 'absender', 'nummernkreis'] },
  { id: 'connectors',        path: '/admin/crm/settings/connectors',    labelKey: 'shell.nav.connectors',        icon: 'connectors', group: 'einstellungen', order: 5, roles: AV,  module: 'base',
    keywords: ['api', 'schnittstellen', 'google', 'meta', 'zugang'] },
  { id: 'users',             path: '/admin/users',                      labelKey: 'shell.nav.users',             icon: 'users',      group: 'einstellungen', order: 6, roles: [A], module: 'base',
    keywords: ['mitarbeiter', 'rechte', 'nutzer', 'zugang'] },

  // ── Portal (Eigentümer) ────────────────────────────────────────────────────
  { id: 'myProperties', path: '/objekte',               labelKey: 'shell.nav.myProperties', icon: 'properties', group: 'portal', order: 0, roles: [E], module: 'm9',
    shortLabelKey: 'shell.navShort.myProperties', mobileRank: { eigentuemer: 2 }, keywords: ['wohnung', 'immobilie'] },
  { id: 'myCalendar',   path: '/kalender',              labelKey: 'shell.nav.myCalendar',   icon: 'calendar',   group: 'portal', order: 1, roles: [E], module: 'm9',
    mobileRank: { eigentuemer: 3 }, keywords: ['belegung', 'termine'] },
  { id: 'myDocuments',  path: '/dokumente',             labelKey: 'shell.nav.myDocuments',  icon: 'documents',  group: 'portal', order: 2, roles: [E], module: 'm9',
    mobileRank: { eigentuemer: 4 }, keywords: ['verträge', 'unterlagen'] },
  { id: 'downloads',    path: '/eigentuemer/downloads', labelKey: 'shell.nav.downloads',    icon: 'downloads',  group: 'portal', order: 3, roles: [E], module: 'm9',
    keywords: ['guides', 'videos', 'material'] },
  { id: 'drive',        path: '/eigentuemer/drive',     labelKey: 'shell.nav.drive',        icon: 'drive',      group: 'portal', order: 4, roles: [E], module: 'm9',
    keywords: ['dateien', 'ordner', 'upload', 'google drive'] },

  // ── Portal (Feriengast): eigene Route-Gruppe, wird von der Shell noch nicht gerendert ──
  { id: 'guestDashboard',  path: '/feriengast/dashboard',   labelKey: 'shell.nav.guestDashboard',  icon: 'home',         group: 'portal', order: 10, roles: [G], module: 'rental' },
  { id: 'guestCheckin',    path: '/feriengast/checkin',     labelKey: 'shell.nav.guestCheckin',    icon: 'key',          group: 'portal', order: 11, roles: [G], module: 'rental' },
  { id: 'guestHouseRules', path: '/feriengast/hausregeln',  labelKey: 'shell.nav.guestHouseRules', icon: 'rules',        group: 'portal', order: 12, roles: [G], module: 'rental' },
  { id: 'guestBooking',    path: '/feriengast/buchung',     labelKey: 'shell.nav.guestBooking',    icon: 'confirmation', group: 'portal', order: 13, roles: [G], module: 'rental' },
  { id: 'guestMessages',   path: '/feriengast/nachrichten', labelKey: 'shell.nav.guestMessages',   icon: 'chat',         group: 'portal', order: 14, roles: [G], module: 'rental' },
  { id: 'guestProfile',    path: '/feriengast/profil',      labelKey: 'shell.nav.guestProfile',    icon: 'user',         group: 'portal', order: 15, roles: [G], module: 'rental' },

  // ── Konto ──────────────────────────────────────────────────────────────────
  { id: 'profile', path: '/profile', labelKey: 'shell.nav.profile', icon: 'user', group: 'konto', order: 0, roles: [A, V, E, M, F], module: 'base',
    keywords: ['passwort', 'sprache', 'konto', 'account'] },

  // ── Versteckt: Aliasse, Detailseiten, Altlasten (Hervorhebung + Suche) ────
  { id: 'crmDashboardAlias',           path: '/admin/crm/dashboard',        labelKey: 'shell.nav.crmDashboardAlias',           icon: 'overview',   group: 'verkauf',     order: 90, roles: AVM, perm: 'pipeline', module: 'base', hidden: 'alias',  parent: 'crmOverview' },
  { id: 'customerDetail',              path: '/admin/crm/leads/:id',        labelKey: 'shell.nav.customerDetail',              icon: 'customers',  group: 'verkauf',     order: 91, roles: AVM, anyPerm: ['pipeline', 'contacts'], module: 'base', hidden: 'detail', parent: 'customers' },
  { id: 'projectDetail',               path: '/admin/crm/projects/:id',     labelKey: 'shell.nav.projectDetail',               icon: 'projects',   group: 'projekte',    order: 90, roles: AVM, perm: 'pipeline', module: 'm1',   hidden: 'detail', parent: 'projects' },
  { id: 'portalPropertyDetail',        path: '/admin/properties/:id',       labelKey: 'shell.nav.portalPropertyDetail',        icon: 'properties', group: 'eigentuemer', order: 90, roles: AV,  module: 'm9',   hidden: 'detail', parent: 'portalProperties' },
  { id: 'portalPropertyDetailVerwalter', path: '/verwalter/properties/:id', labelKey: 'shell.nav.portalPropertyDetailVerwalter', icon: 'properties', group: 'eigentuemer', order: 91, roles: AV, module: 'm9', hidden: 'detail', parent: 'portalProperties' },
  { id: 'myPropertyDetail',            path: '/eigentuemer/properties/:id', labelKey: 'shell.nav.myPropertyDetail',            icon: 'properties', group: 'portal',      order: 90, roles: [E], module: 'm9',   hidden: 'detail', parent: 'myProperties' },
  { id: 'myPropertiesList',            path: '/eigentuemer/properties',     labelKey: 'shell.nav.myPropertiesList',            icon: 'properties', group: 'portal',      order: 91, roles: [E], module: 'm9',   hidden: 'alias',  parent: 'myProperties' },
  { id: 'whatsappTemplates',           path: '/admin/crm/settings/whatsapp',   labelKey: 'shell.nav.whatsappTemplates',        icon: 'chat',       group: 'einstellungen', order: 90, roles: AV, module: 'base', hidden: 'legacy', parent: 'stageMessages' },
  { id: 'automationRules',             path: '/admin/crm/settings/automation', labelKey: 'shell.nav.automationRules',          icon: 'rules',      group: 'einstellungen', order: 91, roles: AV, module: 'base', hidden: 'legacy', parent: 'stageMessages' },
]

// ── Helfer ───────────────────────────────────────────────────────────────────

// Darf dieses Profil den Eintrag sehen? Rolle muss passen. perm/anyPerm gelten
// wie im ProtectedRoute-Guard nur für Mitarbeiter und laufen über hasPerm
// (Admin/Verwalter bestehen jede Rechteprüfung; die Rollen funnel, eigentuemer
// und feriengast haben keine Einzelrechte, für sie zählt allein die Rolle).
export function canSee(profile: Profile | null | undefined, entry: NavEntry): boolean {
  if (!profile) return false
  if (!entry.roles.includes(profile.role)) return false
  if (profile.role === 'mitarbeiter') {
    if (entry.perm && !hasPerm(profile, entry.perm)) return false
    if (entry.anyPerm && !entry.anyPerm.some(p => hasPerm(profile, p))) return false
  }
  return true
}

const byOrder = (a: NavEntry, b: NavEntry) => a.order - b.order

// Sichtbare Menüeinträge, gruppiert und sortiert; leere Gruppen fallen weg.
export function groupedNav(profile: Profile | null | undefined): { group: typeof NAV_GROUPS[number]; entries: NavEntry[] }[] {
  const result: { group: typeof NAV_GROUPS[number]; entries: NavEntry[] }[] = []
  for (const group of [...NAV_GROUPS].sort((a, b) => a.order - b.order)) {
    const entries = NAV_ENTRIES
      .filter(e => e.group === group.id && !e.hidden && canSee(profile, e))
      .sort(byOrder)
    if (entries.length) result.push({ group, entries })
  }
  return result
}

// Telefon-Leiste: höchstens 4 Einträge, nach mobileRank der Rolle.
export function mobileBar(profile: Profile | null | undefined): NavEntry[] {
  if (!profile) return []
  const role = profile.role
  return NAV_ENTRIES
    .filter(e => !e.hidden && e.mobileRank?.[role] !== undefined && canSee(profile, e))
    .sort((a, b) => (a.mobileRank?.[role] ?? 0) - (b.mobileRank?.[role] ?? 0))
    .slice(0, 4)
}

function splitPath(p: string): string[] {
  return p.split('/').filter(Boolean)
}

// Welcher Eintrag gehört zu diesem Pfad? Längster Segment-Treffer gewinnt,
// ':id'-Segmente passen auf alles. Versteckte Einträge lösen auf ihren parent
// auf (Hervorhebung im Menü). Mit Profil werden Einträge bevorzugt, die das
// Profil sehen darf (z.B. /objekte: Portal-Objekte vs. Meine Objekte).
export function matchEntry(pathname: string, profile?: Profile | null): NavEntry | null {
  const segs = splitPath(pathname)
  let best: NavEntry | null = null
  let bestLen = -1
  let bestVisible = false
  let bestWild = Number.MAX_SAFE_INTEGER
  for (const entry of NAV_ENTRIES) {
    const es = splitPath(entry.path)
    if (es.length > segs.length) continue
    let ok = true, wild = 0
    for (let i = 0; i < es.length; i++) {
      if (es[i].startsWith(':')) { wild++; continue }
      if (es[i] !== segs[i]) { ok = false; break }
    }
    if (!ok) continue
    const visible = profile ? canSee(profile, entry) : false
    const better =
      es.length > bestLen ||
      (es.length === bestLen && visible && !bestVisible) ||
      (es.length === bestLen && visible === bestVisible && wild < bestWild)
    if (better) { best = entry; bestLen = es.length; bestVisible = visible; bestWild = wild }
  }
  if (best?.hidden && best.parent) {
    const parent = NAV_ENTRIES.find(e => e.id === best!.parent)
    if (parent) return parent
  }
  return best
}
