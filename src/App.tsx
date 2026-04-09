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
import CrmProjects     from './pages/admin/crm/Projects'
import CrmSettings          from './pages/admin/crm/Settings'
import CrmWhatsappTemplates from './pages/admin/crm/settings/WhatsappTemplates'
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

const ALL_ROLES = ['admin', 'verwalter', 'eigentuemer'] as const

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>

          {/* ── Öffentlich ── */}
          <Route path="/"            element={<Navigate to="/login" replace />} />
          <Route path="/login"       element={<Login />} />
          <Route path="/sign/:token" element={<Sign />} />

          {/* ── Passwort setzen (öffentlich – Token im URL-Hash ist die Authentifizierung) ── */}
          <Route path="/set-password" element={<SetPassword />} />

          {/* ── Profil (alle Rollen) ── */}
          <Route path="/profile" element={
            <ProtectedRoute allowedRoles={[...ALL_ROLES]}>
              <Profile />
            </ProtectedRoute>
          } />
          {/* Alte Eigentümer-Profil-URL → neue universelle Seite */}
          <Route path="/eigentuemer/profile" element={<Navigate to="/profile" replace />} />

          {/* ── Admin ── */}
          <Route path="/admin/dashboard" element={
            <ProtectedRoute allowedRoles={['admin']}>
              <AdminDashboard />
            </ProtectedRoute>
          } />
          <Route path="/admin/users" element={
            <ProtectedRoute allowedRoles={['admin']}>
              <AdminUsers />
            </ProtectedRoute>
          } />

          {/* ── CRM (Admin + Verwalter) ── */}
          <Route path="/admin/crm" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmPipeline />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/dashboard" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmDashboard />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/leads" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmAllLeads />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/leads/:id" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmLeadDetail />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/templates" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmTemplates />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/archived" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmArchived />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/projects" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmProjects />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/settings" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmSettings />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/settings/whatsapp" element={
            <ProtectedRoute allowedRoles={['admin']}>
              <CrmWhatsappTemplates />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/calendar" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <CrmCalendar />
            </ProtectedRoute>
          } />
          <Route path="/admin/crm/statistics" element={
            <ProtectedRoute allowedRoles={['admin']}>
              <Statistics />
            </ProtectedRoute>
          } />

          {/* ── Verwalter ── */}
          <Route path="/verwalter/dashboard" element={
            <ProtectedRoute allowedRoles={['verwalter']}>
              <VerwalterDashboard />
            </ProtectedRoute>
          } />
          <Route path="/verwaltung/bookings" element={
            <ProtectedRoute allowedRoles={['admin', 'verwalter']}>
              <VerwalterBookings />
            </ProtectedRoute>
          } />

          {/* ── Eigentümer ── */}
          <Route path="/eigentuemer/dashboard" element={
            <ProtectedRoute allowedRoles={['eigentuemer']}>
              <EigentuemerDashboard />
            </ProtectedRoute>
          } />
          <Route path="/eigentuemer/properties" element={
            <ProtectedRoute allowedRoles={['eigentuemer']}>
              <EigentuemerProperties />
            </ProtectedRoute>
          } />

          {/* ── Gemeinsame geschützte Seiten ── */}
          <Route path="/objekte" element={
            <ProtectedRoute allowedRoles={[...ALL_ROLES]}>
              <Objekte />
            </ProtectedRoute>
          } />
          <Route path="/admin/properties/:id" element={
            <ProtectedRoute allowedRoles={['admin']}>
              <PropertyDetail />
            </ProtectedRoute>
          } />
          <Route path="/verwalter/properties/:id" element={
            <ProtectedRoute allowedRoles={['verwalter']}>
              <PropertyDetail />
            </ProtectedRoute>
          } />
          <Route path="/eigentuemer/properties/:id" element={
            <ProtectedRoute allowedRoles={['eigentuemer']}>
              <PropertyDetail />
            </ProtectedRoute>
          } />
          <Route path="/dokumente" element={
            <ProtectedRoute allowedRoles={[...ALL_ROLES]}>
              <Dokumente />
            </ProtectedRoute>
          } />
          <Route path="/kalender" element={
            <ProtectedRoute allowedRoles={[...ALL_ROLES]}>
              <Kalender />
            </ProtectedRoute>
          } />

          {/* ── Feriengast ── */}
          <Route path="/feriengast/dashboard" element={
            <ProtectedRoute allowedRoles={['feriengast']}>
              <FeriengastDashboard />
            </ProtectedRoute>
          } />
          <Route path="/feriengast/checkin" element={
            <ProtectedRoute allowedRoles={['feriengast']}>
              <CheckinInfo />
            </ProtectedRoute>
          } />
          <Route path="/feriengast/hausregeln" element={
            <ProtectedRoute allowedRoles={['feriengast']}>
              <Hausregeln />
            </ProtectedRoute>
          } />
          <Route path="/feriengast/buchung" element={
            <ProtectedRoute allowedRoles={['feriengast']}>
              <Buchung />
            </ProtectedRoute>
          } />
          <Route path="/feriengast/nachrichten" element={
            <ProtectedRoute allowedRoles={['feriengast']}>
              <Nachrichten />
            </ProtectedRoute>
          } />
          <Route path="/feriengast/profil" element={
            <ProtectedRoute allowedRoles={['feriengast']}>
              <FeriengastProfil />
            </ProtectedRoute>
          } />

          {/* ── Fallback ── */}
          <Route path="*" element={<Navigate to="/login" replace />} />

        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
