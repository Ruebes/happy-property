import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Deal } from '../../../lib/crmTypes'
import { PHASE_ICONS } from '../../../lib/crmTypes'

export default function Archived() {
  const { t } = useTranslation()
  useAuth()

  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const fetchDeals = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('deals')
        .select('id, lead_id, phase, commission_amount, updated_at, lead:leads(first_name, last_name, email, source), property:properties(project_name, unit_number)')
        .eq('phase', 'archiviert')
        .order('updated_at', { ascending: false })
      if (error) throw error
      setDeals((data ?? []) as unknown as Deal[])
    } catch (err) {
      console.error('[Archived] fetchDeals:', err)
      setDeals([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDeals()
  }, [])

  const handleRestore = async (dealId: string) => {
    await supabase
      .from('deals')
      .update({ phase: 'provision_erhalten' })
      .eq('id', dealId)
    await fetchDeals()
    showToast('Deal wiederhergestellt')
  }

  const formatCurrency = (amount: number | null) =>
    amount != null
      ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount)
      : '–'

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="p-6 space-y-5">
        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
            {toast}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.archived.title')}</h1>
          <Link
            to="/admin/crm"
            className="text-sm font-medium hover:underline text-gray-600"
          >
            ← Zurück zum CRM
          </Link>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {loading ? (
            <p className="p-6 text-gray-400 text-sm">Lädt…</p>
          ) : deals.length === 0 ? (
            <p className="p-6 text-gray-400 text-sm">{t('crm.archived.noArchived')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['Name', 'E-Mail', 'Immobilie', 'Provision', 'Archiviert am', 'Aktionen'].map(col => (
                      <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {deals.map(deal => {
                    const lead = deal.lead
                    const property = deal.property
                    return (
                      <tr key={deal.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                          {lead ? (
                            <Link
                              to={`/admin/crm/leads/${deal.lead_id}`}
                              className="hover:underline"
                              style={{ color: '#ff795d' }}
                            >
                              {lead.first_name} {lead.last_name}
                            </Link>
                          ) : (
                            <span className="text-gray-400">–</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{lead?.email ?? '–'}</td>
                        <td className="px-4 py-3 text-gray-600">
                          {property
                            ? `${property.project_name}${property.unit_number ? ` / ${property.unit_number}` : ''}`
                            : '–'}
                        </td>
                        <td className="px-4 py-3 text-gray-700 font-medium">
                          {formatCurrency(deal.commission_amount)}
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                          <span className="flex items-center gap-1">
                            <span>{PHASE_ICONS['archiviert']}</span>
                            {formatDate(deal.updated_at)}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <Link
                              to={`/admin/crm/leads/${deal.lead_id}`}
                              className="text-sm font-medium hover:underline"
                              style={{ color: '#ff795d' }}
                            >
                              Details
                            </Link>
                            <button
                              onClick={() => handleRestore(deal.id)}
                              className="text-sm font-medium hover:underline"
                              style={{ color: '#ff795d' }}
                            >
                              Wiederherstellen
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
