import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'

// ── KI-Antwort-Agent: Einstellungen ─────────────────────────────────────────────
// Erklärt den Entwurf-Workflow und bietet den Autopilot-Schalter.
//
// WICHTIG (Sicherheit): Der Schalter speichert nur die Präferenz in crm_settings
// (key 'ai_autopilot_enabled'). Aktuell liest KEIN Backend dieses Flag, um etwas
// automatisch zu versenden – der Auto-Versand-Loop ist bewusst noch nicht scharf.
// Solange Sven nicht ausdrücklich „jetzt live" sagt und der Backend-Teil deployt
// wird, bleibt alles im reinen Entwurf-Modus. Einschalten ist daher derzeit inert.

const AUTOPILOT_KEY = 'ai_autopilot_enabled'

export default function AiAgent() {
  const { t } = useTranslation()

  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [toast,   setToast]   = useState('')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const fetchSetting = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('crm_settings')
        .select('value')
        .eq('key', AUTOPILOT_KEY)
        .maybeSingle()
      setEnabled((data as { value?: string } | null)?.value === 'true')
    } catch (err) {
      console.error('[AiAgent] fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSetting() }, [fetchSetting])

  const toggle = async () => {
    const next = !enabled
    // Beim EINSCHALTEN ausdrücklich bestätigen lassen.
    if (next && !window.confirm(t('crm.aiAgent.confirmOn',
      'Vollautomatik als Wunsch speichern? Hinweis: Es wird dadurch NICHTS automatisch versendet. Der automatische Versand wird erst nach ausdrücklicher Freischaltung im Backend aktiv – bis dahin bleibt alles im Entwurf-Modus.'))) {
      return
    }
    setSaving(true)
    try {
      const { error } = await supabase
        .from('crm_settings')
        .upsert(
          { key: AUTOPILOT_KEY, value: next ? 'true' : 'false', updated_at: new Date().toISOString() },
          { onConflict: 'key' },
        )
      if (error) { showToast(`❌ ${error.message}`); return }
      setEnabled(next)
      showToast(next
        ? t('crm.aiAgent.savedOn',  'Vollautomatik-Wunsch gespeichert (noch nicht scharf)')
        : t('crm.aiAgent.savedOff', 'Autopilot aus – nur Entwürfe'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
          {toast}
        </div>
      )}

      <div className="p-6 space-y-5 max-w-3xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            🤖 {t('crm.aiAgent.title', 'KI-Antwort-Agent')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('crm.aiAgent.subtitle', 'Entwürfe für eingehende Kundennachrichten – du prüfst und gibst frei. Das System lernt aus deinen Freigaben und Korrekturen.')}
          </p>
        </div>

        {/* So funktioniert's */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">{t('crm.aiAgent.howTitle', 'So funktioniert’s')}</h2>
          <ol className="space-y-2 text-sm text-gray-600">
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">1.</span>
              {t('crm.aiAgent.step1', 'Im Lead unter „🤖 KI-Antwort" die eingehende Kundennachricht übernehmen und einen Entwurf erzeugen.')}
            </li>
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">2.</span>
              {t('crm.aiAgent.step2', 'Entwurf prüfen, bei Bedarf korrigieren.')}
            </li>
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">3.</span>
              {t('crm.aiAgent.step3', 'Freigeben & kopieren – den Text schickst du wie gewohnt selbst (WhatsApp/E-Mail).')}
            </li>
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">4.</span>
              {t('crm.aiAgent.step4', 'Das System merkt sich deine freigegebenen/korrigierten Antworten und wird mit der Zeit besser.')}
            </li>
          </ol>
        </div>

        {/* Autopilot-Schalter */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          {loading ? (
            <div className="flex justify-center py-6">
              <div className="w-7 h-7 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-700">{t('crm.aiAgent.autopilotTitle', 'Vollautomatik (Autopilot)')}</h2>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    {enabled
                      ? t('crm.aiAgent.autopilotOnDesc',  'Wunsch „voll automatisch" ist gespeichert. Der automatische Versand ist aber noch NICHT scharf – es wird weiterhin nichts ohne deine Freigabe gesendet.')
                      : t('crm.aiAgent.autopilotOffDesc', 'Aus: Die KI erstellt nur Entwürfe. Jede Antwort gibst du selbst frei.')}
                  </p>
                </div>
                {/* Toggle */}
                <button
                  onClick={toggle}
                  disabled={saving}
                  role="switch"
                  aria-checked={enabled}
                  className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                    enabled ? 'bg-orange-500' : 'bg-gray-300'
                  }`}
                >
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>

              {/* Sicherheits-Hinweis (immer sichtbar) */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 leading-relaxed">
                {t('crm.aiAgent.safety', 'Sicherheit: Dieser Schalter speichert nur deine Präferenz. Selbst eingeschaltet versendet das System derzeit NICHTS automatisch – der Auto-Versand wird erst nach ausdrücklicher Freischaltung im Backend aktiv. So kann nichts versehentlich an echte Kunden rausgehen.')}
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
