import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import ProtectedRoute from './components/ProtectedRoute'

// Öffentliche Seiten
import Login       from './pages/Login'
import Sign        from './pages/Sign'
import SetPassword from './pages/SetPassword'

// Universelles Profil (alle Rollen)
import Profile from './pages/Profile'

// Role-Dashboards
import AdminDashboard       from './pages/admin/Dashboard'
import VerwalterDashboard   from './pages/verwalter/Dashboard'
import EigentuemerDashboard    from './pages/eigentuemer/Dashboard'
import EigentuemerProperties  from './pages/eigentuemer/Properties'

// Admin-Seiten
import AdminUsers from './pages/admin/Users'

// CRM (Admin + Verwalter)
import CrmPipeline   from './pages/admin/crm/Pipeline'
import CrmDashboard  from './pages/admin/crm/CrmDashboard'
import CrmLeadDetail from './pages/admin/crm/LeadDetail'
import CrmAllLeads   from './pages/admin/crm/AllLeads'
import CrmTemplates  from './pages/admin/crm/Templates'
import CrmArchived   from './pages/admin/crm/Archived'
import CrmProjects       from './pages/admin/crm/Projects'
import CrmProjectDetail  from './pages/admin/crm/ProjectDetail'
import CrmSettings          from './pages/admin/crm/Settings'
import CrmWhatsappTemplates from './pages/admin/crm/settings/WhatsappTemplates'
import CrmAutomationRules  from './pages/admin/crm/settings/AutomationRules'
import CrmDocuments        from './pages/admin/crm/settings/Documents'
import CrmCalendar          from './pages/admin/crm/Calendar'
import Statistics           from './pages/admin/crm/Statistics'

// Verwalter-Seiten
import VerwalterBookings from './pages/verwaltung/Bookings'

// Gemeinsame Seiten
import Dokumente      from './pages/Dokumente'
import Kalender       from './pages/Kalender'
import Objekte        from './pages/Objekte'
import PropertyDetail from './pages/PropertyDetail'

// Feriengast-Seiten
import FeriengastDashboard from './pages/feriengast/Dashboard'
import CheckinInfo         from './pages/feriengast/CheckinInfo'
import Hausregeln          from './pages/feriengast/Hausregeln'
import Buchung             from './pages/feriengast/Buchung'
import Nachrichten         from './pages/feriengast/Nachrichten'
import FeriengastProfil    from './pages/feriengast/Profil'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>

          {/* ── Öffentlich ── */}
          <Route path="/"            element={<Navigate to="/login" replace />} />
          <Route path="/login"       element={<Login />} />
          <Route path="/sign/:token" element={<Sign />} />
          <Route path="/set-password" element={<SetPassword />} />
          {/* Alte Eigentümer-Profil-URL → universelle Seite */}
          <Route path="/eigentuemer/profile" element={<Navigate to="/profile" replace />} />

          {/* ── Admin only ── */}
          <Route element={<ProtectedRoute allowedRoles={['admin']} />}>
            <Route path="/admin/dashboard"             element={<AdminDashboard />} />
            <Route path="/admin/users"                 element={<AdminUsers />} />
            <Route path="/admin/crm/statistics"        element={<Statistics />} />
            <Route path="/admin/crm/settings/whatsapp"    element={<CrmWhatsappTemplates />} />
            <Route path="/admin/crm/settings/automation"  element={<CrmAutomationRules />} />
            <Route path="/admin/crm/settings/documents"   element={<CrmDocuments />} />
            <Route path="/admin/properties/:id"        element={<PropertyDetail />} />
          </Route>

          {/* ── Admin + Verwalter (CRM + Verwaltung) ── */}
          <Route element={<ProtectedRoute allowedRoles={['admin', 'verwalter']} />}>
            <Route path="/admin/crm"             element={<CrmPipeline />} />
            <Route path="/admin/crm/dashboard"   element={<CrmDashboard />} />
            <Route path="/admin/crm/leads"       element={<CrmAllLeads />} />
            <Route path="/admin/crm/leads/:id"   element={<CrmLeadDetail />} />
            <Route path="/admin/crm/templates"   element={<CrmTemplates />} />
            <Route path="/admin/crm/archived"    element={<CrmArchived />} />
            <Route path="/admin/crm/projects"       element={<CrmProjects />} />
            <Route path="/admin/crm/projects/:id"  element={<CrmProjectDetail />} />
            <Route path="/admin/crm/settings"    element={<CrmSettings />} />
            <Route path="/admin/crm/calendar"    element={<CrmCalendar />} />
            <Route path="/verwaltung/bookings"   element={<VerwalterBookings />} />
            <Route path="/verwalter/properties/:id" element={<PropertyDetail />} />
          </Route>

          {/* ── Verwalter ── */}
          <Route element={<ProtectedRoute allowedRoles={['verwalter']} />}>
            <Route path="/verwalter/dashboard" element={<VerwalterDashboard />} />
          </Route>

          {/* ── Eigentümer ── */}
          <Route element={<ProtectedRoute allowedRoles={['eigentuemer']} />}>
            <Route path="/eigentuemer/dashboard"      element={<EigentuemerDashboard />} />
            <Route path="/eigentuemer/properties"     element={<EigentuemerProperties />} />
            <Route path="/eigentuemer/properties/:id" element={<PropertyDetail />} />
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
      </AuthProvider>
    </BrowserRouter>
  )
}
