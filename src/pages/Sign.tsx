import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { useDateFormat } from '../lib/date'
import LanguageSwitcher from '../components/LanguageSwitcher'

interface ContractPreview {
  id: string
  property_id: string
  project_name: string
  unit_number: string | null
  city: string | null
  tenant_name: string
  tenant_email: string
  start_date: string
  end_date: string | null
  monthly_rent: number
  status: 'draft' | 'sent' | 'signed'
  file_url: string | null
}

type SignState = 'loading' | 'ready' | 'signing' | 'signed' | 'already_signed' | 'not_found' | 'error'

export default function Sign() {
  const { token }            = useParams<{ token: string }>()
  const { t }                = useTranslation()
  const { fmtDateLong, fmtCurrency } = useDateFormat()

  const [state, setState]       = useState<SignState>('loading')
  const [contract, setContract] = useState<ContractPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [errMsg, setErrMsg]     = useState('')

  // ── Vertrag laden ────────────────────────────────────────────
  useEffect(() => {
    if (!token) { setState('not_found'); return }

    supabase
      .rpc('get_contract_for_signing', { p_token: token })
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) {
          setState('not_found')
          return
        }
        const c = data[0] as ContractPreview
        setContract(c)
        setState(c.status === 'signed' ? 'already_signed' : 'ready')
      })
  }, [token])

  // ── Unterschreiben ───────────────────────────────────────────
  const handleSign = async () => {
    if (!confirmed || !token) return
    setState('signing')
    const { error } = await supabase.rpc('sign_contract', { p_token: token })
    if (error) { setErrMsg(error.message); setState('error') }
    else setState('signed')
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--color-bg)' }}>

      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-6 py-3 flex items-center
                         justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center"
               style={{ backgroundColor: '#2d3748' }}>
            <span className="text-white text-sm font-bold select-none"
                  style={{ fontFamily: 'var(--font-heading)' }}>HP</span>
          </div>
          <span className="font-semibold text-hp-black hidden sm:block"
                style={{ fontFamily: 'var(--font-heading)' }}>
            {t('app.name')}
          </span>
        </div>
        <LanguageSwitcher />
      </header>

      {/* Content */}
      <main className="flex-1 flex items-start justify-center px-4 py-10">
        <div className="w-full max-w-lg">

          {/* Loading */}
          {state === 'loading' && (
            <div className="flex justify-center py-20">
              <div className="w-8 h-8 border-4 rounded-full animate-spin"
                   style={{ borderColor: '#e5e7eb', borderTopColor: 'var(--color-highlight)' }} />
            </div>
          )}

          {/* Nicht gefunden */}
          {state === 'not_found' && (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 shadow-sm text-center">
              <div className="text-5xl mb-4">🔍</div>
              <h2 className="text-xl font-bold font-heading mb-2">
                {t('sign.notFound.title')}
              </h2>
              <p className="text-sm text-gray-500 font-body">
                {t('sign.notFound.desc')}
              </p>
            </div>
          )}

          {/* Fehler */}
          {state === 'error' && (
            <div className="bg-white rounded-2xl border border-red-200 p-8 shadow-sm text-center">
              <div className="text-5xl mb-4">⚠️</div>
              <h2 className="text-xl font-bold font-heading mb-2">
                {t('sign.signError.title')}
              </h2>
              <p className="text-sm text-red-500 font-body">{errMsg}</p>
            </div>
          )}

          {/* Bereits unterzeichnet */}
          {state === 'already_signed' && contract && (
            <div className="bg-white rounded-2xl border border-green-200 p-8 shadow-sm text-center">
              <div className="text-5xl mb-4">✅</div>
              <h2 className="text-xl font-bold font-heading mb-2">
                {t('sign.alreadySigned.title')}
              </h2>
              <p className="text-sm text-gray-500 font-body">
                {contract.unit_number
                  ? t('sign.alreadySigned.descWithUnit', {
                      project: contract.project_name,
                      unit: contract.unit_number,
                    })
                  : t('sign.alreadySigned.desc', { project: contract.project_name })}
              </p>
            </div>
          )}

          {/* Erfolgreich unterzeichnet */}
          {state === 'signed' && contract && (
            <div className="bg-white rounded-2xl border border-green-200 p-8 shadow-sm text-center">
              <div className="text-5xl mb-4">🎉</div>
              <h2 className="text-xl font-bold mb-3"
                  style={{ fontFamily: 'var(--font-heading)' }}>
                {t('sign.success.title')}
              </h2>
              <p className="text-sm text-gray-600 font-body mb-2">
                {t('sign.success.desc', { project: contract.project_name })}
              </p>
              <p className="text-xs text-gray-400 font-body">
                {t('sign.success.emailNote', { email: contract.tenant_email })}
              </p>
            </div>
          )}

          {/* Bereit zum Unterschreiben */}
          {(state === 'ready' || state === 'signing') && contract && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

              {/* Kopf */}
              <div className="px-6 py-5 border-b border-gray-100"
                   style={{ backgroundColor: '#2d3748' }}>
                <p className="text-xs text-gray-400 font-body mb-0.5 uppercase tracking-wider">
                  {t('sign.header')}
                </p>
                <h2 className="text-white text-xl font-bold"
                    style={{ fontFamily: 'var(--font-heading)' }}>
                  {contract.project_name}
                  {contract.unit_number ? ` · ${contract.unit_number}` : ''}
                </h2>
                {contract.city && (
                  <p className="text-gray-400 text-sm font-body mt-0.5">{contract.city}</p>
                )}
              </div>

              {/* Details */}
              <div className="px-6 py-5 space-y-3">
                {[
                  { key: 'tenant',      label: t('sign.tenant'),      value: contract.tenant_name },
                  { key: 'email',       label: t('sign.email'),       value: contract.tenant_email },
                  { key: 'startDate',   label: t('sign.startDate'),   value: fmtDateLong(contract.start_date) },
                  { key: 'endDate',     label: t('sign.endDate'),     value: fmtDateLong(contract.end_date) },
                  { key: 'rent',        label: t('sign.monthlyRent'), value: fmtCurrency(contract.monthly_rent), highlight: true },
                ].map(({ key, label, value, highlight }) => (
                  <div key={key}
                       className="flex justify-between items-center py-1.5
                                  border-b border-gray-50 last:border-0">
                    <span className="text-xs text-gray-500 font-body">{label}</span>
                    <span className={`text-sm font-body font-medium ${
                      highlight ? 'text-hp-highlight text-base' : 'text-hp-black'
                    }`}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              {/* PDF */}
              {contract.file_url && (
                <div className="px-6 pb-4">
                  <a href={contract.file_url} target="_blank" rel="noopener noreferrer"
                     className="flex items-center gap-2 text-sm font-body text-hp-highlight
                                hover:underline">
                    <span>📄</span>
                    <span>{t('sign.viewPdf')}</span>
                  </a>
                </div>
              )}

              {/* Checkbox + Button */}
              <div className="px-6 pb-5 space-y-4">
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={e => setConfirmed(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded cursor-pointer"
                    style={{ accentColor: 'var(--color-highlight)' }}
                  />
                  <span className="text-sm text-gray-600 font-body group-hover:text-hp-black
                                   transition-colors leading-relaxed">
                    {t('sign.checkboxLabel')}
                  </span>
                </label>

                <button
                  onClick={handleSign}
                  disabled={!confirmed || state === 'signing'}
                  className="w-full py-3.5 rounded-xl text-white text-sm font-semibold
                             font-body transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: 'var(--color-highlight)' }}
                >
                  {state === 'signing' ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white
                                       rounded-full animate-spin" />
                      {t('sign.signing')}
                    </span>
                  ) : (
                    t('sign.submit')
                  )}
                </button>

                <p className="text-center text-xs text-gray-400 font-body">
                  {t('sign.legalNote')}
                </p>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  )
}
