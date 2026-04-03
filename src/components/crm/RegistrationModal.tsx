import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

interface Developer {
  id:     string
  name:   string
  active: boolean
}

interface RegistrationModalProps {
  leadName: string
  onConfirm: (selectedDevelopers: string[], notes: string) => void
  onCancel:  () => void
  saving?:   boolean
}

export default function RegistrationModal({
  leadName, onConfirm, onCancel, saving,
}: RegistrationModalProps) {
  const { t } = useTranslation()
  const [developers, setDevelopers] = useState<Developer[]>([])
  const [selected, setSelected]     = useState<string[]>([])
  const [notes, setNotes]           = useState('')
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    supabase
      .from('crm_developers')
      .select('id, name, active')
      .eq('active', true)
      .order('name')
      .then(({ data }) => {
        setDevelopers((data ?? []) as Developer[])
        setLoading(false)
      })
  }, [])

  const toggle = (name: string) =>
    setSelected(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col">

        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">
            {t('crm.registration.title', '{{name}} registrieren', { name: leadName })}
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('crm.registration.subtitle', 'Bei welchem Developer registrieren?')}
          </p>
        </div>

        {/* Developer list */}
        <div className="px-6 py-4 space-y-2 max-h-72 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-6">
              <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : developers.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">
              {t('crm.registration.noDevelopers',
                'Keine aktiven Developer vorhanden. Bitte unter Einstellungen anlegen.')}
            </p>
          ) : (
            developers.map(dev => {
              const isSelected = selected.includes(dev.name)
              return (
                <button
                  key={dev.id}
                  onClick={() => toggle(dev.name)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left
                              transition-colors ${
                    isSelected
                      ? 'border-orange-400 bg-orange-50 text-gray-900'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-orange-200 hover:bg-orange-50/40'
                  }`}
                >
                  <span className={`w-5 h-5 rounded-md border-2 flex items-center justify-center
                                   shrink-0 transition-colors ${
                    isSelected ? 'border-orange-500 bg-orange-500' : 'border-gray-300'
                  }`}>
                    {isSelected && <span className="text-white text-xs font-bold leading-none">✓</span>}
                  </span>
                  <span className="font-medium text-sm">{dev.name}</span>
                </button>
              )
            })
          )}
        </div>

        {/* Notes */}
        <div className="px-6 pb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('crm.registration.notes', 'Bemerkungen zur Registrierung')}
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder={t('crm.registration.notesPlaceholder',
              'z.B. Bevorzugte Unit, besondere Wünsche, Payment Plan…')}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm
                       focus:outline-none focus:border-orange-400 resize-none"
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50"
          >
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button
            onClick={() => onConfirm(selected, notes)}
            disabled={saving || selected.length === 0}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50
                       flex items-center gap-2"
            style={{ backgroundColor: '#ff795d' }}
          >
            {saving && (
              <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            )}
            {saving
              ? t('crm.registration.sending', 'Wird gesendet…')
              : t('crm.registration.send', 'Registrierung senden')}
          </button>
        </div>
      </div>
    </div>
  )
}
