import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Termin verwalten (öffentlich, /termin/verwalten/:token) ──────────────────
// Aus Bestätigung + Erinnerungen verlinkt ({{termin_link}}). Verschieben nutzt
// denselben Slot-Bestand wie der Funnel (funnel-api action=slots); Absage löscht
// Termin + Google-Event, stoppt Erinnerungen und benachrichtigt Sven.

const CREAM = '#FAF6EC'
const CORAL = '#ff795d'
const NAVY = '#1a2332'

interface ApptInfo { first_name: string; start_iso: string; meeting_type: 'zoom' | 'whatsapp'; past: boolean }
type View = 'loading' | 'invalid' | 'overview' | 'reschedule' | 'cancel' | 'done_reschedule' | 'done_cancel'

export default function TerminVerwalten() {
  const { t } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const [view, setView] = useState<View>('loading')
  const [appt, setAppt] = useState<ApptInfo | null>(null)
  const [slots, setSlots] = useState<string[]>([])
  const [dayKey, setDayKey] = useState('')
  const [newSlot, setNewSlot] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin', [])
  const fmtFull = (iso: string) => new Date(iso).toLocaleString('de-DE', { timeZone: tz, weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit' })

  const api = useCallback(async (payload: Record<string, unknown>) => {
    const { data, error: e } = await supabase.functions.invoke('funnel-api', { body: payload })
    if (e) throw new Error(e.message)
    return data as Record<string, unknown>
  }, [])

  useEffect(() => {
    if (!token) { setView('invalid'); return }
    api({ action: 'manage_get', token })
      .then(d => {
        if (!d?.ok) { setView('invalid'); return }
        setAppt(d as unknown as ApptInfo)
        setView('overview')
      })
      .catch(() => setView('invalid'))
  }, [token, api])

  const days = useMemo(() => {
    const map = new Map<string, { label: string; slots: string[] }>()
    for (const s of slots) {
      const d = new Date(s)
      const key = d.toLocaleDateString('de-DE', { timeZone: tz })
      const label = d.toLocaleDateString('de-DE', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' })
      if (!map.has(key)) map.set(key, { label, slots: [] })
      map.get(key)!.slots.push(s)
    }
    return map
  }, [slots, tz])

  const openReschedule = async () => {
    setView('reschedule'); setError(''); setBusy(true)
    try {
      const d = await api({ action: 'slots' })
      const s = (d?.slots as string[] | undefined) ?? []
      setSlots(s)
      if (s.length) setDayKey(new Date(s[0]).toLocaleDateString('de-DE', { timeZone: tz }))
    } catch {
      setError(t('funnel.manage.errSlotsLoad', 'Termine konnten nicht geladen werden — bitte versuche es noch einmal.'))
    } finally { setBusy(false) }
  }

  const doReschedule = async (s: string) => {
    setBusy(true); setError(''); setNewSlot(s)
    try {
      const d = await api({ action: 'manage_reschedule', token, slot_start_iso: s })
      if (d?.error === 'slot_taken' || d?.error === 'slot_invalid') {
        setError(t('funnel.manage.errSlotTaken', 'Dieser Termin wurde gerade vergeben — bitte wähle einen anderen.'))
        void openReschedule(); return
      }
      if (!d?.ok) throw new Error(String(d?.error ?? 'failed'))
      setView('done_reschedule')
    } catch {
      setError(t('funnel.manage.errGeneric', 'Das hat leider nicht geklappt. Bitte versuche es noch einmal.'))
    } finally { setBusy(false) }
  }

  const doCancel = async () => {
    setBusy(true); setError('')
    try {
      const d = await api({ action: 'manage_cancel', token, reason })
      if (!d?.ok) throw new Error(String(d?.error ?? 'failed'))
      setView('done_cancel')
    } catch {
      setError(t('funnel.manage.errGeneric', 'Das hat leider nicht geklappt. Bitte versuche es noch einmal.'))
    } finally { setBusy(false) }
  }

  const card = 'bg-white rounded-2xl border border-[#e6dfd0] shadow-sm p-6'

  return (
    <div className="min-h-screen font-body flex flex-col" style={{ background: CREAM, color: '#1a1a1a' }}>
      <div className="px-5 md:px-10 py-4">
        <img src={DECK_LOGO} alt="Happy Property" className="h-8 md:h-9 w-auto" />
      </div>
      <div className="flex-1 flex items-center justify-center px-5 pb-10">
        <div className="w-full max-w-xl">

          {view === 'loading' && (
            <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
          )}

          {view === 'invalid' && (
            <div className={`${card} text-center`}>
              <div className="text-4xl">🤔</div>
              <h1 className="font-heading font-bold text-2xl mt-3" style={{ color: NAVY }}>{t('funnel.manage.invalidTitle', 'Diesen Termin gibt es nicht mehr')}</h1>
              <p className="text-sm text-gray-500 mt-2">{t('funnel.manage.invalidBody', 'Der Link ist ungültig oder der Termin wurde bereits abgesagt.')}</p>
              <a href="/termin?buchen=1" className="mt-6 inline-block px-8 py-3 rounded-full text-white font-semibold shadow" style={{ background: CORAL }}>{t('funnel.manage.bookNew', 'Neuen Termin buchen →')}</a>
            </div>
          )}

          {view === 'overview' && appt && (
            <div className={card}>
              <p className="text-xs font-bold tracking-widest uppercase" style={{ color: CORAL }}>{t('funnel.manage.yourAppt', 'Dein Termin')}</p>
              <h1 className="font-heading font-bold text-2xl md:text-3xl mt-1" style={{ color: NAVY }}>
                {appt.first_name ? t('funnel.manage.helloName', 'Hallo {{name}}!', { name: appt.first_name }) : t('funnel.manage.hello', 'Hallo!')}
              </h1>
              <div className="mt-4 rounded-xl bg-[#FAF6EC] border border-[#e6dfd0] p-4">
                <p className="font-semibold" style={{ color: NAVY }}>{t('funnel.manage.dateLine', '📅 {{date}} Uhr', { date: fmtFull(appt.start_iso) })}</p>
                <p className="text-sm text-gray-500 mt-1">{appt.meeting_type === 'zoom' ? t('funnel.manage.zoomCall', '📹 Zoom-Call mit Sven') : t('funnel.manage.whatsappCall', '💬 WhatsApp-Call mit Sven')} · {t('funnel.manage.tzNote', 'Zeiten in deiner Zeitzone')}</p>
              </div>
              {appt.past ? (
                <p className="text-sm text-gray-500 mt-4">{t('funnel.manage.pastNote', 'Dieser Termin liegt in der Vergangenheit.')} <a href="/termin?buchen=1" className="underline" style={{ color: CORAL }}>{t('funnel.manage.pastBookNew', 'Hier kannst du einen neuen buchen.')}</a></p>
              ) : (
                <div className="grid md:grid-cols-2 gap-3 mt-5">
                  <button onClick={() => void openReschedule()} className="px-5 py-3 rounded-full text-white font-semibold shadow hover:shadow-md transition" style={{ background: NAVY }}>
                    {t('funnel.manage.reschedule', '🔄 Termin verschieben')}
                  </button>
                  <button onClick={() => setView('cancel')} className="px-5 py-3 rounded-full font-semibold border-2 bg-white hover:bg-gray-50 transition" style={{ borderColor: '#e6dfd0', color: NAVY }}>
                    {t('funnel.manage.cancel', '❌ Termin absagen')}
                  </button>
                </div>
              )}
            </div>
          )}

          {view === 'reschedule' && appt && (
            <div className={card}>
              <button onClick={() => setView('overview')} className="text-sm text-gray-500 hover:text-gray-800">{t('funnel.manage.back', '← Zurück')}</button>
              <h2 className="font-heading font-bold text-2xl mt-2" style={{ color: NAVY }}>{t('funnel.manage.pickNew', 'Neuen Termin wählen')}</h2>
              <p className="text-sm text-gray-500 mt-1">{t('funnel.manage.reschedIntro', 'Aktuell: {{date}} Uhr. Ein Klick bucht verbindlich um{{zoomSuffix}}.', { date: fmtFull(appt.start_iso), zoomSuffix: appt.meeting_type === 'zoom' ? t('funnel.manage.zoomLinkStays', ' — dein Zoom-Link bleibt gleich') : '' })}</p>
              {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
              {busy ? (
                <div className="flex justify-center py-10"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
              ) : (
                <>
                  <div className="flex gap-2 mt-4 overflow-x-auto pb-2">
                    {Array.from(days.entries()).map(([key, d]) => (
                      <button key={key} onClick={() => setDayKey(key)}
                        className="px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap border-2 transition"
                        style={dayKey === key ? { background: NAVY, color: '#fff', borderColor: NAVY } : { background: '#fff', color: NAVY, borderColor: '#e6dfd0' }}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 md:grid-cols-4 gap-2.5 mt-3">
                    {(days.get(dayKey)?.slots ?? []).map(s => (
                      <button key={s} onClick={() => void doReschedule(s)}
                        className="px-3 py-2.5 rounded-xl bg-white border-2 border-[#e6dfd0] hover:border-[#ff795d] text-sm font-semibold transition"
                        style={{ color: NAVY }}>
                        {fmtTime(s)}
                      </button>
                    ))}
                  </div>
                  {!slots.length && <p className="mt-5 text-sm text-gray-500">{t('funnel.manage.noSlots', 'Gerade sind keine freien Termine verfügbar — schreib uns kurz per WhatsApp, wir finden einen.')}</p>}
                </>
              )}
            </div>
          )}

          {view === 'cancel' && appt && (
            <div className={card}>
              <button onClick={() => setView('overview')} className="text-sm text-gray-500 hover:text-gray-800">{t('funnel.manage.back', '← Zurück')}</button>
              <h2 className="font-heading font-bold text-2xl mt-2" style={{ color: NAVY }}>{t('funnel.manage.cancelConfirm', 'Termin wirklich absagen?')}</h2>
              <p className="text-sm text-gray-500 mt-1">{t('funnel.manage.cancelIntro', '{{date}} Uhr wird gelöscht. Du kannst stattdessen auch einfach ', { date: fmtFull(appt.start_iso) })}<button onClick={() => void openReschedule()} className="underline" style={{ color: CORAL }}>{t('funnel.manage.rescheduleVerb', 'verschieben')}</button>.</p>
              <label className="block text-xs font-semibold text-gray-500 mt-4 mb-1">{t('funnel.manage.reasonLabel', 'Magst du kurz sagen, warum? (optional)')}</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
                className="w-full border-2 border-[#e6dfd0] rounded-xl p-3 text-sm focus:outline-none focus:border-[#ff795d] bg-white" placeholder={t('funnel.manage.reasonPlaceholder', 'z. B. beruflich verhindert…')} />
              {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
              <button onClick={() => void doCancel()} disabled={busy}
                className="mt-4 w-full py-3 rounded-full text-white font-semibold shadow disabled:opacity-50" style={{ background: '#dc2626' }}>
                {busy ? t('funnel.manage.oneMoment', 'Einen Moment…') : t('funnel.manage.cancelYes', 'Ja, Termin absagen')}
              </button>
            </div>
          )}

          {view === 'done_reschedule' && (
            <div className={`${card} text-center`}>
              <div className="text-5xl">✅</div>
              <h2 className="font-heading font-bold text-2xl mt-3" style={{ color: NAVY }}>{t('funnel.manage.doneReschedTitle', 'Termin verschoben!')}</h2>
              <p className="text-gray-600 mt-2"><strong>{newSlot ? t('funnel.manage.dateUhr', '{{date}} Uhr', { date: fmtFull(newSlot) }) : ''}</strong></p>
              <p className="text-sm text-gray-500 mt-2">{t('funnel.manage.doneReschedBody', 'Die neue Bestätigung ist per E-Mail und WhatsApp unterwegs — inklusive Kalender-Datei.')}</p>
            </div>
          )}

          {view === 'done_cancel' && (
            <div className={`${card} text-center`}>
              <div className="text-5xl">👋</div>
              <h2 className="font-heading font-bold text-2xl mt-3" style={{ color: NAVY }}>{t('funnel.manage.doneCancelTitle', 'Termin abgesagt')}</h2>
              <p className="text-sm text-gray-500 mt-2">{t('funnel.manage.doneCancelBody', 'Schade! Wenn es später wieder passt, freut sich Sven auf dich.')}</p>
              <a href="/termin?buchen=1" className="mt-5 inline-block px-8 py-3 rounded-full text-white font-semibold shadow" style={{ background: CORAL }}>{t('funnel.manage.findNew', 'Neuen Termin finden →')}</a>
            </div>
          )}

        </div>
      </div>
      <div className="text-center text-[11px] text-gray-400 pb-5">{t('funnel.manage.footer', '© Happy Property · Paphos, Zypern')}</div>
    </div>
  )
}
