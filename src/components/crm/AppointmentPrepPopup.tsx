import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import type { CrmAppointment } from '../../lib/crmTypes'

// ── AppointmentPrepPopup ──────────────────────────────────────────────────────
// Poppt ~2 Minuten VOR einem Termin automatisch im CRM auf, damit Sven sich
// vorbereiten kann: Name, Kontaktweg (WhatsApp-Anruf / Zoom-Link), die
// Typeform-Antworten aus den Lead-Notizen — und ein Feld für Gesprächsnotizen,
// die als Aktivität „Erstgespräch" (mit System-Zeitstempel) am Kunden gespeichert
// werden. Läuft global in der CRM-Hülle (nur für Admins).

const SHOWN_KEY = 'apptPrepShown'          // localStorage: bereits gezeigte Termin-IDs
const LEAD_WINDOW_MIN = 2                    // wie viele Minuten vorher aufpoppen
const POLL_MS = 30_000

function getShown(): string[] {
  try { return JSON.parse(localStorage.getItem(SHOWN_KEY) || '[]') as string[] } catch { return [] }
}
function addShown(id: string): void {
  const s = getShown()
  if (!s.includes(id)) { s.push(id); localStorage.setItem(SHOWN_KEY, JSON.stringify(s.slice(-300))) }
}

export default function AppointmentPrepPopup() {
  const { t, i18n } = useTranslation()
  const [appt, setAppt]   = useState<CrmAppointment | null>(null)
  const [note, setNote]   = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [rating, setRating] = useState<'gut' | 'schlecht' | 'no_show' | null>(null)
  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'de-DE'

  const check = useCallback(async () => {
    if (appt) return   // ein Popup reicht — nicht überlagern
    const now = new Date()
    const until = new Date(now.getTime() + LEAD_WINDOW_MIN * 60_000)
    const { data, error } = await supabase
      .from('crm_appointments')
      .select('*, lead:leads(id, first_name, last_name, phone, whatsapp, notes)')
      // internal raus: das Popup ist die Kunden-Gespraechsvorbereitung (Badge
      // "Erstgespraech", Lead-Bewertung 👍/👎/No-Show). Bei einem internen Termin
      // mit einer Mitarbeiterin ergibt das nichts davon Sinn.
      .eq('internal', false)
      .gt('start_time', now.toISOString())
      .lte('start_time', until.toISOString())
      .order('start_time', { ascending: true })
    if (error) return
    const shown = getShown()
    const next = ((data ?? []) as CrmAppointment[]).find(a => !shown.includes(a.id))
    if (next) { setAppt(next); setNote(''); setSaved(false); setRating(null); addShown(next.id) }
  }, [appt])

  // Lead-Bewertung (gut/schlecht) + Termin-Ausgang — fließt in den Werbemanager
  // (Qualitätsquote, Preis pro gutem Lead, No-Show-Quote je Anzeige).
  const rate = useCallback(async (value: 'gut' | 'schlecht' | 'no_show') => {
    if (!appt) return
    const prev = rating
    setRating(value)
    try {
      if (value === 'no_show') {
        const { error } = await supabase.from('crm_appointments').update({ outcome: 'no_show' }).eq('id', appt.id)
        if (error) throw error
      } else {
        if (appt.lead_id) {
          const { error } = await supabase.from('leads')
            .update({ quality_rating: value, quality_rated_at: new Date().toISOString() })
            .eq('id', appt.lead_id)
          if (error) throw error
        }
        // Bewertet = Gespräch hat stattgefunden
        const { error: e2 } = await supabase.from('crm_appointments').update({ outcome: 'completed', updated_at: new Date().toISOString() }).eq('id', appt.id)
        if (e2) throw e2
      }
      if (appt.lead_id) {
        supabase.from('activities').insert({
          lead_id: appt.lead_id, deal_id: appt.deal_id ?? null,
          type: 'note', direction: 'outbound',
          subject: value === 'no_show' ? '🚫 No-Show' : value === 'gut' ? '👍 Guter Lead' : '👎 Schlechter Lead',
          content: t('crm.prep.ratedVia', 'Bewertet über das Termin-Popup'),
          completed_at: new Date().toISOString(),
        }).then(({ error }) => { if (error) console.warn('[AppointmentPrepPopup] activity:', error) })
      }
    } catch (e) {
      console.error('[AppointmentPrepPopup] rate:', e)
      setRating(prev)
    }
  }, [appt, rating, t])

  useEffect(() => {
    void check()
    const iv = setInterval(() => { void check() }, POLL_MS)
    return () => clearInterval(iv)
  }, [check])

  if (!appt) return null

  const lead    = appt.lead
  // Ohne Lead (persoenlicher Buchungslink) steht der Name des Gastes in attendees —
  // vorher wurde stattdessen der Betreff als Name angezeigt.
  const name    = lead
    ? `${lead.first_name} ${lead.last_name ?? ''}`.trim()
    : (appt.attendees?.[0]?.name || appt.title || t('crm.prep.noName', 'Ohne Namen'))
  const rawNum  = appt.phone_number || lead?.whatsapp || lead?.phone || ''
  const waDigits = rawNum.replace(/[^0-9]/g, '')
  const isWa    = appt.type === 'whatsapp' || appt.type === 'phone'
  const when    = new Date(appt.start_time).toLocaleString(locale, {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  })
  const notes   = lead?.notes?.trim() || ''

  async function saveNote() {
    if (!note.trim() || !appt) return
    setSaving(true)
    try {
      const { error } = await supabase.from('activities').insert({
        lead_id:      appt.lead_id,
        deal_id:      appt.deal_id ?? null,
        type:         'note',
        direction:    'outbound',
        subject:      t('crm.prep.classification', 'Erstgespräch'),
        content:      note.trim(),
        completed_at: new Date().toISOString(),
      })
      if (error) throw error
      setSaved(true)
    } catch (e) {
      console.error('[AppointmentPrepPopup] saveNote:', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] overflow-y-auto">
        {/* Kopf */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-100" style={{ background: 'linear-gradient(180deg,#fff5f2,#ffffff)' }}>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-2 py-1 rounded-full text-white"
              style={{ backgroundColor: '#ff795d' }}>
              ⏰ {t('crm.prep.startingSoon', 'Termin in Kürze')}
            </span>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
              {t('crm.prep.classification', 'Erstgespräch')}
            </span>
          </div>
          <h2 className="mt-3 text-xl font-bold text-gray-900 font-body">{name}</h2>
          <p className="text-sm text-gray-500 mt-0.5">📅 {when}</p>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Kontaktweg */}
          <div className="flex flex-wrap items-center gap-2">
            {appt.type === 'zoom' && appt.zoom_link && (
              <a href={appt.zoom_link} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white"
                style={{ backgroundColor: '#2d8cff' }}>
                📹 {t('crm.appt.joinZoom', 'Zoom beitreten')}
              </a>
            )}
            {isWa && waDigits && (
              <a href={`https://wa.me/${waDigits}`} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white"
                style={{ backgroundColor: '#25d366' }}>
                💬 {t('crm.appt.callWhatsApp', 'Per WhatsApp anrufen')}
              </a>
            )}
            {appt.type === 'inperson' && appt.location && (
              <span className="text-sm text-gray-600">📍 {appt.location}</span>
            )}
            {rawNum && <span className="text-sm text-gray-500">{rawNum}</span>}
          </div>

          {/* Typeform-Antworten / Notizen aus dem Lead */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              {t('crm.prep.leadInfo', 'Infos aus der Anfrage')}
            </p>
            <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {notes || <span className="text-gray-400">{t('crm.prep.noLeadInfo', 'Keine Angaben aus dem Formular hinterlegt.')}</span>}
            </div>
          </div>

          {/* Lead-Bewertung: ein Klick — gut / schlecht / No-Show */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              {t('crm.prep.rateTitle', 'Lead bewerten')}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => void rate('gut')}
                className={`py-2 rounded-lg text-sm font-semibold border transition ${rating === 'gut' ? 'bg-green-600 border-green-600 text-white' : 'bg-white border-gray-200 text-gray-700 hover:border-green-400'}`}>
                👍 {t('crm.prep.rateGood', 'Gut')}
              </button>
              <button type="button" onClick={() => void rate('schlecht')}
                className={`py-2 rounded-lg text-sm font-semibold border transition ${rating === 'schlecht' ? 'bg-red-600 border-red-600 text-white' : 'bg-white border-gray-200 text-gray-700 hover:border-red-400'}`}>
                👎 {t('crm.prep.rateBad', 'Nicht gut')}
              </button>
              <button type="button" onClick={() => void rate('no_show')}
                className={`py-2 rounded-lg text-sm font-semibold border transition ${rating === 'no_show' ? 'bg-gray-800 border-gray-800 text-white' : 'bg-white border-gray-200 text-gray-700 hover:border-gray-400'}`}>
                🚫 No-Show
              </button>
            </div>
            {rating && (
              <p className="mt-1 text-[11px] text-gray-400">
                {t('crm.prep.rateSaved', 'Gespeichert — fließt in die Werbe-Auswertung ein.')}
              </p>
            )}
          </div>

          {/* Gesprächsnotizen */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              {t('crm.prep.callNotes', 'Gesprächsnotizen')}
            </label>
            <textarea
              value={note}
              onChange={e => { setNote(e.target.value); setSaved(false) }}
              rows={4}
              placeholder={t('crm.prep.callNotesPh', 'Notizen während des Gesprächs…')}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y"
            />
            <button
              type="button"
              onClick={() => void saveNote()}
              disabled={saving || !note.trim()}
              className="mt-2 w-full py-2 text-sm font-semibold text-white rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ backgroundColor: '#ff795d' }}
            >
              {saving && <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {saved ? t('crm.prep.saved', '✓ Als Notiz gespeichert') : t('crm.prep.saveNote', 'Als Notiz speichern')}
            </button>
          </div>
        </div>

        {/* Fuß */}
        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between">
          {lead
            ? <Link to={`/admin/crm/leads/${lead.id}`} onClick={() => setAppt(null)}
                className="text-sm font-medium text-[#ff795d] hover:underline">
                {t('crm.prep.openLead', 'Zum Kunden →')}
              </Link>
            : <span />}
          <button type="button" onClick={() => setAppt(null)}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
            {t('common.close', 'Schließen')}
          </button>
        </div>
      </div>
    </div>
  )
}
