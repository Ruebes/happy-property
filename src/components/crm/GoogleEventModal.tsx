import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { updateGoogleEvent } from '../../lib/googleCalendar'
import type { GoogleCalendarEvent } from '../../lib/googleCalendar'

// ── GoogleEventModal ──────────────────────────────────────────────────────────
// Bearbeitet ein Google-Event direkt im Google-Kalender (Service-Account) —
// damit sind auch Termine editierbar, die am iPhone / in Google angelegt wurden.

interface Props {
  event:   GoogleCalendarEvent
  onClose: () => void
  onSaved: () => void
}

function isoToDateInput(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isoToTimeInput(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function GoogleEventModal({ event, onClose, onSaved }: Props) {
  const { t } = useTranslation()

  const [title, setTitle]             = useState(event.summary ?? '')
  const [date, setDate]               = useState(isoToDateInput(event.start.dateTime))
  const [von, setVon]                 = useState(isoToTimeInput(event.start.dateTime))
  const [bis, setBis]                 = useState(isoToTimeInput(event.end.dateTime))
  const [location, setLocation]       = useState(event.location ?? '')
  const [description, setDescription] = useState(event.description ?? '')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const canSave = title.trim().length > 0 && date.length > 0 && von.length > 0 && bis.length > 0

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      const start = new Date(`${date}T${von}`)
      const end   = new Date(`${date}T${bis}`)
      if (end < start) end.setDate(end.getDate() + 1)   // Termin über Mitternacht (z.B. 23:00–00:30)
      const startIso = start.toISOString()
      const endIso   = end.toISOString()
      await updateGoogleEvent(event.id, {
        title,
        description,
        location,
        startIso,
        endIso,
      }, event.calendarId)
      onSaved()
    } catch (err) {
      console.error('[GoogleEventModal] handleSave:', err)
      setError(err instanceof Error ? err.message : t('crm.appt.saveError', 'Fehler beim Speichern.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 font-body">
            📅 {t('crm.calendar.editGoogleEvent', 'Google-Termin bearbeiten')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="Schließen">
            ×
          </button>
        </div>

        {/* Titel */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('crm.appt.title', 'Titel')} *
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
          />
        </div>

        {/* Datum + Zeit */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('crm.appt.date', 'Datum')} *
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
            />
          </div>
          <div className="w-24">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('crm.appt.from', 'Von')}
            </label>
            <input
              type="time"
              value={von}
              onChange={e => setVon(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
            />
          </div>
          <div className="w-24">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('crm.appt.to', 'Bis')}
            </label>
            <input
              type="time"
              value={bis}
              onChange={e => setBis(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
            />
          </div>
        </div>

        {/* Ort */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('crm.appt.address', 'Adresse')} / {t('crm.appt.location', 'Ort')}
          </label>
          <input
            type="text"
            value={location}
            onChange={e => setLocation(e.target.value)}
            placeholder={t('crm.appt.addressPlaceholder', 'Straße, Ort...')}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
          />
          {location.trim() && (
            <iframe
              title="Karte"
              src={`https://www.google.com/maps?q=${encodeURIComponent(location)}&output=embed`}
              className="w-full h-36 rounded-lg border border-gray-200 mt-2"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          )}
        </div>

        {/* Beschreibung */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('crm.appt.description', 'Beschreibung')}
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-none"
          />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !canSave}
            className="px-5 py-2 text-sm font-medium text-white rounded-lg flex items-center gap-2 disabled:opacity-50"
            style={{ backgroundColor: '#ff795d' }}
          >
            {saving && <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {t('common.save', 'Speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}
