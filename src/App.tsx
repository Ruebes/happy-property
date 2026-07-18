import { Suspense } from 'react'
import { lazyWithReload as lazy } from './lib/lazyWithReload'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import ProtectedRoute from './components/ProtectedRoute'

// ── Öffentliche Seiten (eager — immer gebraucht, klein) ──────────────────────
import Login       from './pages/Login'
import Sign        from './pages/Sign'
import SetPassword from './pages/SetPassword'

// ── Alle anderen Seiten: lazy (werden erst bei Bedarf geladen) ───────────────
// → Reduziert das Initial-Bundle erheblich; CRM-Code wird z.B. für Feriengäste
//   nie geladen.

const Profile = lazy(() => import('./pages/Profile'))
const Deck    = lazy(() => import('./pages/Deck'))
const Rechnung = lazy(() => import('./pages/Rechnung'))
const TaskAction = lazy(() => import('./pages/TaskAction'))
const BookingPage = lazy(() => import('./pages/BookingPage'))
const Funnel   = lazy(() => import('./pages/Funnel'))
const TerminVerwalten = lazy(() => import('./pages/TerminVerwalten'))
const Abmelden = lazy(() => import('./pages/Abmelden'))
const Zusage = lazy(() => import('./pages/Zusage'))
const ShortLink = lazy(() => import('./pages/ShortLink'))
const RevolutCallback = lazy(() => import('./pages/RevolutCallback'))
const Invoice  = lazy(() => import('./pages/Invoice'))

// Role-Dashboards
const AdminDashboard      = lazy(() => import('./pages/admin/Dashboard'))
const VerwalterDashboard  = lazy(() => import('./pages/verwalter/Dashboard'))
const EigentuemerDashboard   = lazy(() => import('./pages/eigentuemer/Dashboard'))
const EigentuemerProperties  = lazy(() => import('./pages/eigentuemer/Properties'))

// Admin-Seiten
const AdminUsers        = lazy(() => import('./pages/admin/Users'))
const AdminVerwaltungen = lazy(() => import('./pages/admin/Verwaltungen'))

// CRM (Admin + Verwalter)
const CrmPipeline           = lazy(() => import('./pages/admin/crm/Pipeline'))
const CrmDashboard          = lazy(() => import('./pages/admin/crm/CrmDashboard'))
const CrmLeadDetail         = lazy(() => import('./pages/admin/crm/LeadDetail'))
const CrmAllLeads           = lazy(() => import('./pages/admin/crm/AllLeads'))
const CrmArchived           = lazy(() => import('./pages/admin/crm/Archived'))
const CrmProjects           = lazy(() => import('./pages/admin/crm/Projects'))
const CrmProjectDetail      = lazy(() => import('./pages/admin/crm/ProjectDetail'))
const CrmSettings           = lazy(() => import('./pages/admin/crm/Settings'))
const CrmPostausgang        = lazy(() => import('./pages/admin/crm/Postausgang'))
const CrmWhatsappTemplates  = lazy(() => import('./pages/admin/crm/settings/WhatsappTemplates'))
const CrmAutomationRules    = lazy(() => import('./pages/admin/crm/settings/AutomationRules'))
const CrmStageMessages      = lazy(() => import('./pages/admin/crm/settings/StageMessages'))
const CrmAiAgent            = lazy(() => import('./pages/admin/crm/settings/AiAgent'))
const CrmDocuments          = lazy(() => import('./pages/admin/crm/settings/Documents'))
const CrmContacts           = lazy(() => import('./pages/admin/crm/settings/Contacts'))
const CrmInvoices           = lazy(() => import('./pages/admin/crm/Invoices'))
const CrmInvoiceSettings    = lazy(() => import('./pages/admin/crm/settings/InvoiceSettings'))
const CrmCalendar           = lazy(() => import('./pages/admin/crm/Calendar'))
const Statistics            = lazy(() => import('./pages/admin/crm/Statistics'))
const FunnelStats           = lazy(() => import('./pages/admin/crm/FunnelStats'))
const FunnelEditor          = lazy(() => import('./pages/admin/crm/FunnelEditor'))
const AdsManager            = lazy(() => import('./pages/admin/crm/AdsManager'))
const Newsletter            = lazy(() => import('./pages/admin/crm/Newsletter'))
const CrmTasks              = lazy(() => import('./pages/admin/crm/Tasks'))
const StaffHome             = lazy(() => import('./pages/admin/crm/StaffHome'))

// Verwalter-Seiten
const VerwalterBookings = lazy(() => import('./pages/verwaltung/Bookings'))

// Gemeinsame Seiten
const Dokumente      = lazy(() => import('./pages/Dokumente'))
const Kalender       = lazy(() => import('./pages/Kalender'))
const Objekte        = lazy(() => import('./pages/Objekte'))
const PropertyDetail = lazy(() => import('./pages/PropertyDetail'))

// Feriengast-Seiten
const FeriengastDashboard = lazy(() => import('./pages/feriengast/Dashboard'))
const CheckinInfo         = lazy(() => import('./pages/feriengast/CheckinInfo'))
const Hausregeln          = lazy(() => import('./pages/feriengast/Hausregeln'))
const Buchung             = lazy(() => import('./pages/feriengast/Buchung'))
const Nachrichten         = lazy(() => import('./pages/feriengast/Nachrichten'))
const FeriengastProfil    = lazy(() => import('./pages/feriengast/Profil'))

// ── Wrapper: erzwingt Re-Mount wenn :id in der URL wechselt ──────────────────
// Ohne key würde React die Komponente beim Wechsel von z.B. Lead A → Lead B
// NICHT unmounten – alter State bleibt bis zum Fetch-Ende sichtbar (Stale UI).
function PropertyDetailRoute()   { const { id } = useParams(); return <PropertyDetail    key={id} /> }
function CrmLeadDetailRoute()    { const { id } = useParams(); return <CrmLeadDetail     key={id} /> }
function CrmProjectDetailRoute() { const { id } = useParams(); return <CrmProjectDetail  key={id} /> }

// ── Suspense-Fallback ─────────────────────────────────────────────────────────
function PageLoader() {
  return (
    <div className="flex items-center justify-center h-screen"
         style={{ backgroundColor: 'var(--color-bg)' }}>
      <div className="animate-spin rounded-full h-8 w-8
                      border-b-2 border-orange-500" />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<PageLoader />}>
          <Routes>

            {/* ── Öffentlich ── */}
            <Route path="/"            element={<Navigate to="/login" replace />} />
            <Route path="/login"       element={<Login />} />
            <Route path="/sign/:token" element={<Sign />} />
            <Route path="/set-password" element={<SetPassword />} />
            {/* Öffentliches Sales-Deck (per Token, kein Login) */}
            <Route path="/termin" element={<Funnel />} />
            <Route path="/termin/verwalten/:token" element={<TerminVerwalten />} />
            {/* Öffentliche Newsletter-Abmeldung (per Token, kein Login) */}
            <Route path="/abmelden" element={<Abmelden />} />
            {/* Öffentliche Termin-Zu-/Absage (per Token, kein Login) */}
            <Route path="/zusage" element={<Zusage />} />
            {/* Kurzlink-Weiterleitung (WhatsApp-taugliche kurze URLs) */}
            <Route path="/s/:code" element={<ShortLink />} />
            <Route path="/revolut" element={<RevolutCallback />} />
            <Route path="/deck/:token" element={<Deck />} />
            <Route path="/deck/:token/print" element={<Deck />} />
            {/* Öffentliche Rendite-Rechnung / Immobilienvergleich (per Token, kein Login) */}
            <Route path="/rechnung/:token" element={<Rechnung />} />
            {/* Öffentliche Rechnung (per Token, kein Login) */}
            <Route path="/re/:token" element={<Invoice />} />
            {/* Öffentliche Aufgaben-Aktion (per Token, kein Login) */}
            <Route path="/t/:token" element={<TaskAction />} />
            {/* Persönlicher Buchungslink (öffentlich, z.B. /buchen/sven360) */}
            <Route path="/buchen/:slug" element={<BookingPage />} />
            {/* Alte Eigentümer-Profil-URL → universelle Seite */}
            <Route path="/eigentuemer/profile" element={<Navigate to="/profile" replace />} />

            {/* ── Admin only ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin']} />}>
              <Route path="/admin/dashboard"             element={<AdminDashboard />} />
              <Route path="/admin/users"                 element={<AdminUsers />} />
              <Route path="/admin/verwaltungen"          element={<AdminVerwaltungen />} />
              <Route path="/admin/crm/statistics"        element={<Statistics />} />
            </Route>

            {/* ── Funnel & Newsletter (Recht 'funnel') ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter', 'mitarbeiter', 'funnel']} permission="funnel" />}>
              <Route path="/admin/crm/funnel"            element={<FunnelStats />} />
              <Route path="/admin/crm/funnel-editor"     element={<FunnelEditor />} />
              <Route path="/admin/crm/newsletter"        element={<Newsletter />} />
            </Route>

            {/* ── CRM-Einstellungen (nur Admin/Verwalter) ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter']} />}>
              <Route path="/admin/crm/settings"             element={<CrmSettings />} />
              <Route path="/admin/crm/settings/stages"      element={<CrmStageMessages />} />
              <Route path="/admin/crm/settings/ai"          element={<CrmAiAgent />} />
              <Route path="/admin/crm/settings/whatsapp"    element={<CrmWhatsappTemplates />} />
              <Route path="/admin/crm/settings/automation"  element={<CrmAutomationRules />} />
              <Route path="/admin/crm/settings/documents"   element={<CrmDocuments />} />
              <Route path="/admin/properties/:id"           element={<PropertyDetailRoute />} />
              <Route path="/verwaltung/bookings"            element={<VerwalterBookings />} />
              <Route path="/verwalter/properties/:id"       element={<PropertyDetailRoute />} />
            </Route>

            {/* ── Startseite + Aufgaben (alle Mitarbeitenden, kein Bereichs-Recht nötig) ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter', 'mitarbeiter']} />}>
              <Route path="/admin/crm/home"                 element={<StaffHome />} />
              <Route path="/admin/crm/tasks"                element={<CrmTasks />} />
            </Route>

            {/* ── Kontakte (Recht 'contacts') — Geschäftskontakte, Developer & Mitarbeiter ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter', 'mitarbeiter']} permission="contacts" />}>
              <Route path="/admin/crm/settings/contacts"    element={<CrmContacts />} />
            </Route>

            {/* ── Rechnungen (Recht 'invoices') ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter', 'mitarbeiter']} permission="invoices" />}>
              <Route path="/admin/crm/invoices"             element={<CrmInvoices />} />
              <Route path="/admin/crm/settings/invoices"    element={<CrmInvoiceSettings />} />
            </Route>

            {/* ── Werbemanager (Recht 'werbung' oder ein Segment-Recht) ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter', 'mitarbeiter']} permission="werbung" />}>
              <Route path="/admin/crm/ads"                  element={<AdsManager />} />
            </Route>

            {/* ── Pipeline & Leads (Recht 'pipeline') — inkl. Projekte für Deck-Erstellung ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter', 'mitarbeiter']} permission="pipeline" />}>
              <Route path="/admin/crm"             element={<CrmDashboard />} />
              <Route path="/admin/crm/pipeline"    element={<CrmPipeline />} />
              <Route path="/admin/crm/dashboard"   element={<CrmDashboard />} />
              <Route path="/admin/crm/leads"       element={<CrmAllLeads />} />
              <Route path="/admin/crm/leads/:id"   element={<CrmLeadDetailRoute />} />
              <Route path="/admin/crm/archived"    element={<CrmArchived />} />
              <Route path="/admin/crm/projects"       element={<CrmProjects />} />
              <Route path="/admin/crm/projects/:id"  element={<CrmProjectDetailRoute />} />
              <Route path="/admin/crm/postausgang" element={<CrmPostausgang />} />
              <Route path="/admin/crm/calendar"    element={<CrmCalendar />} />
            </Route>

            {/* ── Verwalter ── */}
            <Route element={<ProtectedRoute allowedRoles={['verwalter']} />}>
              <Route path="/verwalter/dashboard" element={<VerwalterDashboard />} />
            </Route>

            {/* ── Eigentümer ── */}
            <Route element={<ProtectedRoute allowedRoles={['eigentuemer']} />}>
              <Route path="/eigentuemer/dashboard"      element={<EigentuemerDashboard />} />
              <Route path="/eigentuemer/properties"     element={<EigentuemerProperties />} />
              <Route path="/eigentuemer/properties/:id" element={<PropertyDetailRoute />} />
            </Route>

            {/* ── Admin + Verwalter + Eigentümer (gemeinsame Seiten) ── */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter', 'eigentuemer']} />}>
              <Route path="/profile"    element={<Profile />} />
              <Route path="/objekte"    element={<Objekte />} />
              <Route path="/dokumente"  element={<Dokumente />} />
              <Route path="/kalender"   element={<Kalender />} />
            </Route>

            {/* ── Feriengast ── */}
            <Route element={<ProtectedRoute allowedRoles={['feriengast']} />}>
              <Route path="/feriengast/dashboard"  element={<FeriengastDashboard />} />
              <Route path="/feriengast/checkin"    element={<CheckinInfo />} />
              <Route path="/feriengast/hausregeln" element={<Hausregeln />} />
              <Route path="/feriengast/buchung"    element={<Buchung />} />
              <Route path="/feriengast/nachrichten" element={<Nachrichten />} />
              <Route path="/feriengast/profil"     element={<FeriengastProfil />} />
            </Route>

            {/* ── Fallback ── */}
            <Route path="*" element={<Navigate to="/login" replace />} />

          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  )
}
