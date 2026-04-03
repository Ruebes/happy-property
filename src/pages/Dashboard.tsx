import { useTranslation } from 'react-i18next'

export default function Dashboard() {
  const { t } = useTranslation()
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold font-heading">{t('dashboard.title')}</h1>
      <p className="mt-2 font-body text-gray-600">{t('dashboard.welcome')}</p>
    </div>
  )
}
