import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import {
  initGoogleAuth,
  signInGoogle,
  signOutGoogle,
  hasGoogleToken,
} from '../../../lib/googleCalendar'

interface Developer {
  id:         string
  name:       string
  active:     boolean
  created_at: string
}

// ── Add Developer Modal ───────────────────────────────────────────────────────

function AddDeveloperModal({
  onClose, onSaved,
}: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const [name, setName]     = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    setError('')
    try {
      const { error: err } = await supabase
        .from('crm_developers')
        .insert({ name: trimmed, active: true })
      if (err) {
        if (err.code === '23505') {
          setError(t('crm.settings.developerExists', 'Dieser Developer existiert bereits.'))
        } else {
          setError(err.message)
        }
        return
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            {t('crm.settings.addDeveloper', '+ Developer hinzufügen')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('crm.settings.developerName', 'Name')} *
          </label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder="z.B. Mito, Pafilia…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:border-orange-400"
          />
          {error && (
            <p className="text-xs text-red-500 mt-1">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#ff795d' }}
          >
            {saving ? t('common.saving', 'Speichert…') : t('common.save', 'Speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Settings Page ────────────────────────────────────────────────────────

export default function Settings() {
  const { t } = useTranslation()
  const [developers, setDevelopers]   = useState<Developer[]>([])
  const [loading, setLoading]         = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [toggling, setToggling]       = useState<string | null>(null)
  const [toast, setToast]             = useState('')

  // ── Google Calendar integration state ─────────────────────────────────────
  const [googleConnected, setGoogleConnected]   = useState(false)
  const [googleInit, setGoogleInit]             = useState(false)
  const [googleLoading, setGoogleLoading]       = useState(false)

  useEffect(() => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
    if (!clientId) { setGoogleInit(true); return }
    initGoogleAuth()
      .then(() => {
        setGoogleInit(true)
        setGoogleConnected(hasGoogleToken())
      })
      .catch(() => setGoogleInit(true))
  }, [])

  const handleGoogleConnect = async () => {
    setGoogleLoading(true)
    try {
      await signInGoogle()
      setGoogleConnected(true)
      showToast(t('crm.settings.googleConnectedToast', '✅ Google Kalender verbunden'))
    } catch {
      showToast('❌ ' + t('crm.settings.googleConnectError', 'Verbindung fehlgeschlagen'))
    } finally {
      setGoogleLoading(false)
    }
  }

  const handleGoogleDisconnect = () => {
    signOutGoogle()
    setGoogleConnected(false)
    showToast(t('crm.settings.googleDisconnectedToast', 'Google Kalender getrennt'))
  }

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const fetchDevelopers = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('crm_developers')
        .select('*')
        .order('name')
      if (error) throw error
      setDevelopers((data ?? []) as Developer[])
    } catch (err) {
      console.error('[Settings] fetchDevelopers:', err)
      setDevelopers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDevelopers() }, [fetchDevelopers])

  const handleToggleActive = async (dev: Developer) => {
    setToggling(dev.id)
    try {
      await supabase
        .from('crm_developers')
        .update({ active: !dev.active })
        .eq('id', dev.id)
      setDevelopers(prev =>
        prev.map(d => d.id === dev.id ? { ...d, active: !dev.active } : d)
      )
      showToast(
        dev.active
          ? t('crm.settings.developerDeactivated', '{{name}} deaktiviert', { name: dev.name })
          : t('crm.settings.developerActivated',   '{{name}} aktiviert',   { name: dev.name })
      )
    } catch (err) {
      console.error('[Settings] toggleActive:', err)
      showToast('❌ Fehler')
    } finally {
      setToggling(null)
    }
  }

  const activeDevelopers   = developers.filter(d => d.active)
  const inactiveDevelopers = developers.filter(d => !d.active)

  return (
    <DashboardLayout basePath="/admin/crm">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl shadow-lg text-sm">
          {toast}
        </div>
      )}

      <div className="max-w-2xl space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {t('crm.settings.title', 'Einstellungen')}
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('crm.settings.subtitle', 'Developer und CRM-Konfiguration')}
            </p>
          </div>
        </div>

        {/* Developer Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {t('crm.settings.developers', 'Developer')}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('crm.settings.developersHint',
                  'Erscheinen in der Registrierungs-Auswahl. Deaktivierte Developer werden ausgeblendet.')}
              </p>
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-opacity"
              style={{ backgroundColor: '#ff795d' }}
            >
              + {t('crm.settings.addDeveloper', 'Developer hinzufügen')}
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : developers.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              {t('crm.settings.noDevelopers',
                'Noch keine Developer angelegt. Klicke "+ Developer hinzufügen".')}
            </p>
          ) : (
            <div className="space-y-4">
              {/* Active */}
              {activeDevelopers.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    {t('crm.settings.active', 'Aktiv')} ({activeDevelopers.length})
                  </p>
                  <div className="divide-y divide-gray-50">
                    {activeDevelopers.map(dev => (
                      <div
                        key={dev.id}
                        className="flex items-center justify-between py-3"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                          <span className="font-medium text-gray-900 text-sm">{dev.name}</span>
                        </div>
                        <button
                          onClick={() => handleToggleActive(dev)}
                          disabled={toggling === dev.id}
                          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500
                                     hover:border-red-200 hover:text-red-500 hover:bg-red-50 transition-colors
                                     disabled:opacity-50"
                        >
                          {toggling === dev.id
                            ? '…'
                            : t('crm.settings.deactivate', 'Deaktivieren')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Inactive */}
              {inactiveDevelopers.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 mt-2">
                    {t('crm.settings.inactive', 'Deaktiviert')} ({inactiveDevelopers.length})
                  </p>
                  <div className="divide-y divide-gray-50">
                    {inactiveDevelopers.map(dev => (
                      <div
                        key={dev.id}
                        className="flex items-center justify-between py-3 opacity-50"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-2 h-2 rounded-full bg-gray-300 flex-shrink-0" />
                          <span className="text-gray-500 text-sm line-through">{dev.name}</span>
                        </div>
                        <button
                          onClick={() => handleToggleActive(dev)}
                          disabled={toggling === dev.id}
                          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500
                                     hover:border-green-200 hover:text-green-600 hover:bg-green-50 transition-colors
                                     disabled:opacity-50 opacity-100"
                        >
                          {toggling === dev.id
                            ? '…'
                            : t('crm.settings.activate', 'Aktivieren')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Integrations ─────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {t('crm.settings.integrations', 'Integrationen')}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('crm.settings.integrationsHint', 'Google Kalender und Zoom mit dem CRM verbinden.')}
            </p>
          </div>

          {/* Google Calendar */}
          <div className="flex items-center justify-between py-4 border-t border-gray-50">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center text-lg">📅</div>
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {t('crm.settings.googleCalendar', 'Google Kalender')}
                </p>
                <p className="text-xs mt-0.5">
                  {!import.meta.env.VITE_GOOGLE_CLIENT_ID ? (
                    <span className="text-amber-600">
                      {t('crm.settings.googleNotConfigured', 'VITE_GOOGLE_CLIENT_ID nicht gesetzt')}
                    </span>
                  ) : googleConnected ? (
                    <span className="text-green-600 font-medium">
                      ✓ {t('crm.settings.googleConnected', 'Verbunden')}
                    </span>
                  ) : (
                    <span className="text-gray-400">
                      {t('crm.settings.googleNotConnected', 'Nicht verbunden')}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {googleConnected ? (
                <button
                  onClick={handleGoogleDisconnect}
                  className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500
                             hover:border-red-200 hover:text-red-500 transition-colors"
                >
                  {t('crm.settings.disconnectGoogle', 'Trennen')}
                </button>
              ) : (
                <button
                  onClick={handleGoogleConnect}
                  disabled={!googleInit || googleLoading || !import.meta.env.VITE_GOOGLE_CLIENT_ID}
                  className="px-3 py-1.5 text-xs rounded-lg text-white font-medium
                             disabled:opacity-50 hover:opacity-90 transition-opacity"
                  style={{ backgroundColor: '#4285f4' }}
                >
                  {googleLoading
                    ? t('common.loading', 'Wird geladen …')
                    : t('crm.settings.connectGoogle', 'Verbinden')}
                </button>
              )}
            </div>
          </div>

          {/* Zoom */}
          <div className="flex items-center justify-between py-4 border-t border-gray-50">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center text-lg">📹</div>
              <div>
                <p className="text-sm font-medium text-gray-900">Zoom</p>
                <p className="text-xs mt-0.5">
                  <span className="text-gray-400">
                    {t('crm.settings.zoomHint', 'Zoom API Keys als Supabase Secrets konfigurieren.')}
                  </span>
                </p>
              </div>
            </div>
            <a
              href="https://developers.zoom.us/docs/api/"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500
                         hover:border-blue-200 hover:text-blue-500 transition-colors"
            >
              {t('crm.settings.zoomDocs', 'API Docs →')}
            </a>
          </div>
        </div>


      </div>

      {/* Add Developer Modal */}
      {showAddModal && (
        <AddDeveloperModal
          onClose={() => setShowAddModal(false)}
          onSaved={fetchDevelopers}
        />
      )}
    </DashboardLayout>
  )
}
