import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { checkCalendarStatus } from '../../../lib/googleCalendar'
import type { CalendarStatus } from '../../../lib/googleCalendar'
import type { Developer } from '../../../lib/crmTypes'
import DeveloperContactsModal from '../../../components/crm/DeveloperContactsModal'

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
  const [contactsDev, setContactsDev] = useState<Developer | null>(null)

  // ── Google Calendar integration state (server-seitig via Service-Account) ──
  const [calStatus, setCalStatus]         = useState<CalendarStatus | null>(null)
  const [calChecking, setCalChecking]     = useState(false)

  // ── Zoom integration state ────────────────────────────────────────────────
  const [zoomConfigured, setZoomConfigured] = useState<boolean | null>(null)

  const refreshCalStatus = useCallback(async () => {
    setCalChecking(true)
    try { setCalStatus(await checkCalendarStatus()) }
    finally { setCalChecking(false) }
  }, [])

  useEffect(() => { void refreshCalStatus() }, [refreshCalStatus])

  useEffect(() => {
    supabase.functions.invoke('create-zoom-meeting', { body: { check: true } })
      .then(({ data, error }) => {
        setZoomConfigured(!error && data?.configured === true)
      })
      .catch(() => setZoomConfigured(false))
  }, [])

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
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setContactsDev(dev)}
                            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500
                                       hover:border-orange-200 hover:text-orange-600 hover:bg-orange-50 transition-colors"
                          >
                            {t('crm.settings.contacts', 'Ansprechpartner')}
                          </button>
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

          {/* Google Calendar — server-seitig (Service-Account, wie Drive) */}
          <div className="py-4 border-t border-gray-50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center text-lg">📅</div>
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {t('crm.settings.googleCalendar', 'Google Kalender')}
                  </p>
                  <p className="text-xs mt-0.5">
                    {calChecking || calStatus === null ? (
                      <span className="text-gray-400">{t('crm.settings.calChecking', 'Prüfe Verbindung…')}</span>
                    ) : calStatus.connected ? (
                      <span className="text-green-600 font-medium">
                        ✓ {t('crm.settings.calConnectedPermanent', 'Dauerhaft verbunden')} · {calStatus.calendar_id}
                      </span>
                    ) : (
                      <span className="text-amber-600 font-medium">
                        {t('crm.settings.calNotShared', 'Freigabe fehlt noch')}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <button
                onClick={() => void refreshCalStatus()}
                disabled={calChecking}
                className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500
                           hover:border-blue-200 hover:text-blue-500 transition-colors disabled:opacity-50"
              >
                {t('crm.settings.calRecheck', 'Neu prüfen')}
              </button>
            </div>

            {/* Freigabe-Anleitung, solange nicht verbunden */}
            {calStatus && !calStatus.connected && (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800 space-y-2">
                {calStatus.reason === 'api_disabled' ? (
                  <p>
                    {t('crm.settings.calApiDisabled', 'Die Google Calendar API ist im Google-Cloud-Projekt noch nicht aktiviert. Einmal aktivieren unter:')}{' '}
                    <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noreferrer" className="underline font-medium">console.cloud.google.com</a>
                  </p>
                ) : calStatus.reason === 'read_only' ? (
                  <p>
                    {t('crm.settings.calReadOnly', 'Der Kalender ist nur LESEND freigegeben. Bitte in den Google-Kalender-Einstellungen die Freigabestufe für die Service-Adresse auf „Änderungen an Terminen vornehmen" ändern — dann hier „Neu prüfen".')}
                  </p>
                ) : (
                  <>
                    <p className="font-semibold">
                      {t('crm.settings.calShareTitle', 'Einmalige Freigabe (danach läuft die Verbindung dauerhaft, wie beim Drive):')}
                    </p>
                    <ol className="list-decimal ml-4 space-y-1">
                      <li>{t('crm.settings.calShare1', 'calendar.google.com öffnen (als happypropertycyprus@gmail.com)')}</li>
                      <li>{t('crm.settings.calShare2', 'Links bei „Meine Kalender" → drei Punkte neben deinem Kalender → „Einstellungen und Freigabe"')}</li>
                      <li>{t('crm.settings.calShare3', '„Für bestimmte Personen freigeben" → „Personen hinzufügen" → diese Adresse einfügen:')}</li>
                    </ol>
                    <div className="flex items-center gap-2 bg-white border border-amber-200 rounded-lg px-3 py-2">
                      <code className="flex-1 break-all text-[11px] text-gray-700">{calStatus.sa_email}</code>
                      <button
                        type="button"
                        onClick={() => { void navigator.clipboard.writeText(calStatus.sa_email); showToast(t('crm.settings.calCopied', 'Adresse kopiert ✓')) }}
                        className="shrink-0 px-2 py-1 text-[11px] border border-gray-200 rounded hover:bg-gray-50"
                      >
                        {t('common.copy', 'Kopieren')}
                      </button>
                    </div>
                    <p>{t('crm.settings.calShare4', 'Berechtigung: „Änderungen an Terminen vornehmen" → Senden. Danach hier „Neu prüfen" klicken.')}</p>
                  </>
                )}
              </div>
            )}

            {calStatus?.connected && (
              <p className="mt-2 text-[11px] text-gray-400">
                {t('crm.settings.calConnectedHint', 'Die Verbindung ist server-seitig (Service-Account) und läuft nie ab — unabhängig von Browser, Cache oder Gerät. Termine vom iPhone erscheinen im CRM und sind dort bearbeitbar.')}
              </p>
            )}
          </div>

          {/* Zoom */}
          <div className="flex items-center justify-between py-4 border-t border-gray-50">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center text-lg">📹</div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-gray-900">Zoom</p>
                  {zoomConfigured === null && (
                    <span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                  )}
                  {zoomConfigured === true && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-100 text-green-700">
                      {t('crm.settings.connected', 'Verbunden')}
                    </span>
                  )}
                  {zoomConfigured === false && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-gray-100 text-gray-500">
                      {t('crm.settings.notConnected', 'Nicht verbunden')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {zoomConfigured
                    ? t('crm.settings.zoomConfigured', 'ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET gesetzt.')
                    : t('crm.settings.zoomHint', 'ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID und ZOOM_CLIENT_SECRET als Supabase Secrets setzen.')}
                </p>
              </div>
            </div>
            <a
              href="https://marketplace.zoom.us/develop/create"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500
                         hover:border-blue-200 hover:text-blue-500 transition-colors"
            >
              {t('crm.settings.zoomSetup', 'Zoom App →')}
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

      {/* Developer Contacts Modal */}
      {contactsDev && (
        <DeveloperContactsModal
          developer={contactsDev}
          onClose={() => setContactsDev(null)}
        />
      )}
    </DashboardLayout>
  )
}
