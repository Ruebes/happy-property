import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../components/DashboardLayout'
import { useAuth } from '../../lib/auth'

const stats = [
  { label: 'Meine Immobilien',   value: '–', icon: '🏠' },
  { label: 'Rendite (Ø)',        value: '–', icon: '📈' },
  { label: 'Dokumente',          value: '–', icon: '📄' },
  { label: 'Nächster Termin',    value: '–', icon: '📅' },
]

export default function InvestorDashboard() {
  const { t } = useTranslation()
  const { profile } = useAuth()

  return (
    <DashboardLayout basePath="/investor/dashboard">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-hp-black" style={{ fontFamily: 'var(--font-heading)' }}>
          {t('dashboard.welcome')}, {profile?.full_name || 'Investor'} 👋
        </h1>
        <p className="mt-1 text-gray-500 font-body text-sm">
          Dein Investor-Portal · Nur deine Daten
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((s) => (
          <div key={s.label} className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
            <div className="text-2xl mb-2">{s.icon}</div>
            <div className="text-2xl font-bold font-body text-hp-black">{s.value}</div>
            <div className="text-xs text-gray-500 font-body mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
        <h2 className="text-lg font-semibold font-heading mb-1">Zugriffslevel: Investor</h2>
        <p className="text-sm text-gray-500 font-body">
          Du siehst ausschließlich deine eigenen Investitionen und Dokumente.
        </p>
      </div>
    </DashboardLayout>
  )
}
