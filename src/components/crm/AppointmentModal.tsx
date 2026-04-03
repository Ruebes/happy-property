import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { hasGoogleToken, createGoogleEvent } from '../../lib/googleCalendar'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  leadId?:       string | null
  leadName?:     string | null
  leadPhone?:    string | null
  initialDate?:  Date | null
  onClose:       () => void
  onCreated:     () => void
}

type ApptType = 'zoom' | 'inperson' | 'phone'

interface LeadResult {
  id:         string
  first_name: string
  last_name:  string
  phone:      string | null
  email:      string
}

// ── Step progress bar ─────────────────────────────────────────────────────────

const STEP_LABELS = ['Basis', 'Details', 'Lead', 'Bestätigen']

function StepBar({ step }: { step: number }) {
  return (
    <div className="flex items-center justify-center gap-0 px-6 py-4 border-b border-gray-100">
      {STEP_LABELS.map((label, idx) => {
        const num       = idx + 1
        const isActive  = num === step
        const isDone    = num < step
        return (
          <div key={num} className="flex items-center">
            {/* connector before */}
            {idx > 0 && (
              <div
                className="h-0.5 w-10"
                style={{ backgroundColor: isDone ? '#ff795d' : '#e5e7eb' }}
              />
            )}
            <div className="flex flex-col items-center gap-1">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors"
                style={{
                  backgroundColor: isActive || isDone ? '#ff795d' : '#f3f4f6',
                  color:           isActive || isDone ? '#fff'    : '#9ca3af',
                }}
              >
                {isDone ? '✓' : num}
              </div>
              <span className="text-[10px] text-gray-500 whitespace-nowrap">{label}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AppointmentModal({
  leadId,
  leadName,
  leadPhone,
  initialDate,
  onClose,
  onCreated,
}: Props) {
  const { t }        = useTranslation()
  const { profile }  = useAuth()

  // Step
  const [step, setStep] = useState(1)

  // ── Step 1: Basis ─────────────────────────────────────────────
  const [title, setTitle]       = useState('')
  const [date, setDate]         = useState<string>(() => {
    if (initialDate) {
      const y = initialDate.getFullYear()
      const m = String(initialDate.getMonth() + 1).padStart(2, '0')
      const d = String(initialDate.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
    return ''
  })
  const [von, setVon]           = useState('10:00')
  const [bis, setBis]           = useState('11:00')
  const [apptType, setApptType] = useState<ApptType>('zoom')
  const [description, setDescription] = useState('')

  // ── Step 2: Details ───────────────────────────────────────────

  // Zoom (manual entry only)
  const [zoomLink, setZoomLink]         = useState('')
  const [zoomPassword, setZoomPassword] = useState('')

  // In-person
  const [location, setLocation]     = useState('')
  const [locationUrl, setLocationUrl] = useState('')

  // Phone
  const [phoneNumber, setPhoneNumber] = useState(leadPhone ?? '')

  // ── Step 3: Lead ──────────────────────────────────────────────
  const [searchQuery, setSearchQuery]         = useState('')
  const [searchResults, setSearchResults]     = useState<LeadResult[]>([])
  const [searchLoading, setSearchLoading]     = useState(false)
  const [selectedLeadId, setSelectedLeadId]   = useState<string | null>(leadId ?? null)
  const [selectedLeadName, setSelectedLeadName] = useState<string>(leadName ?? '')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Step 4: Confirm ───────────────────────────────────────────
  const [saveToGoogle, setSaveToGoogle]         = useState(hasGoogleToken())
  const [sendEmailInvite, setSendEmailInvite]   = useState(false)
  const [saving, setSaving]                     = useState(false)
  const [saveError, setSaveError]               = useState('')

  // Update saveToGoogle if google token changes
  useEffect(() => {
    setSaveToGoogle(hasGoogleToken())
  }, [step])

  // ── Search leads (debounced) ──────────────────────────────────
  const searchLeads = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setSearchResults([]); return }
    setSearchLoading(true)
    try {
      const { data } = await supabase
        .from('leads')
        .select('id, first_name, last_name, phone, email')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
        .limit(10)
      setSearchResults((data ?? []) as LeadResult[])
    } finally {
      setSearchLoading(false)
    }
  }, [])

  function handleSearchChange(val: string) {
    setSearchQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { void searchLeads(val) }, 300)
  }

  function selectLead(lead: LeadResult) {
    setSelectedLeadId(lead.id)
    setSelectedLeadName(`${lead.first_name} ${lead.last_name}`)
    setSearchResults([])
    setSearchQuery('')
  }

  // ── Generate Maps link ────────────────────────────────────────
  function handleGenerateMaps() {
    if (!location) return
    setLocationUrl(`https://www.google.com/maps/search/${encodeURIComponent(location)}`)
  }

  // ── handleCreate ──────────────────────────────────────────────
  async function handleCreate() {
    setSaving(true)
    setSaveError('')
    try {
      const start_time = new Date(`${date}T${von}`).toISOString()
      const end_time   = new Date(`${date}T${bis}`).toISOString()

      console.log('[AppointmentModal] Insert payload:', {
        title, type: apptType, start_time, end_time,
        lead_id: selectedLeadId, created_by: profile?.id,
      })

      const { data: appt, error } = await supabase
        .from('crm_appointments')
        .insert({
          title,
          description:     description || null,
          type:            apptType,
          start_time,
          end_time,
          lead_id:         selectedLeadId || null,
          zoom_link:       zoomLink || null,
          zoom_meeting_id: null,
          location:        location || null,
          location_url:    locationUrl || null,
          phone_number:    phoneNumber || null,
          created_by:      profile?.id || null,
        })
        .select()
        .single()

      if (error) {
        console.error('[AppointmentModal] Supabase Insert Fehler:', {
          code:    error.code,
          message: error.message,
          details: error.details,
          hint:    error.hint,
        })
        // Klaren Fehlertext anzeigen
        const msg = error.code === '42P01'
          ? 'Tabelle crm_appointments existiert nicht – Migration ausführen!'
          : error.code === '42501' || error.message?.includes('row-level security')
            ? 'Keine Berechtigung (RLS). Nur Admin/Verwalter dürfen Termine anlegen.'
            : `DB-Fehler [${error.code}]: ${error.message}`
        throw new Error(msg)
      }

      console.log('[AppointmentModal] Termin angelegt:', appt)

      // Save to Google Calendar
      console.log('[AppointmentModal] saveToGoogle:', saveToGoogle, 'tokenValid:', hasGoogleToken())
      if (saveToGoogle && hasGoogleToken()) {
        try {
          const googleResult = await createGoogleEvent({
            title,
            startIso:    start_time,
            endIso:      end_time,
            description: description || undefined,
            location:    location || undefined,
          })
          console.log('[AppointmentModal] Google Event:', googleResult)
          await supabase
            .from('crm_appointments')
            .update({ google_event_id: googleResult.id })
            .eq('id', (appt as { id: string }).id)
        } catch (gErr) {
          console.warn('[AppointmentModal] Google Calendar Fehler (nicht fatal):', gErr)
          // Google sync failed non-fatally; continue
        }
      }

      // Log activity
      if (selectedLeadId) {
        const { error: actErr } = await supabase.from('activities').insert({
          lead_id:   selectedLeadId,
          type:      'meeting',
          direction: 'outbound',
          subject:   title,
          content:   `Termin angelegt: ${apptType} am ${date} ${von}-${bis}`,
          created_by: profile?.id,
        })
        if (actErr) console.warn('[AppointmentModal] Activity-Log Fehler:', actErr)
      }

      onCreated()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('crm.appt.saveError', 'Fehler beim Speichern.')
      console.error('[AppointmentModal] handleCreate Fehler:', msg)
      setSaveError(msg)
    } finally {
      setSaving(false)
    }
  }

  // ── Validation ────────────────────────────────────────────────
  function canProceed(): boolean {
    if (step === 1) return title.trim().length > 0 && date.length > 0
    return true
  }

  // ── Duration label ────────────────────────────────────────────
  function durationLabel(): string {
    try {
      const [vonH, vonM] = von.split(':').map(Number)
      const [bisH, bisM] = bis.split(':').map(Number)
      const diff = (bisH * 60 + bisM) - (vonH * 60 + vonM)
      return diff > 0 ? `${diff} min` : ''
    } catch { return '' }
  }

  // ── Type label ────────────────────────────────────────────────
  const typeLabels: Record<ApptType, string> = {
    zoom:      '📹 Zoom',
    inperson:  '📍 Vor Ort',
    phone:     '📞 Telefon',
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <h2 className="text-lg font-semibold text-gray-900 font-body">
            {t('crm.appt.modalTitle', 'Termin anlegen')}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="Schließen"
          >
            ×
          </button>
        </div>

        {/* Step bar */}
        <StepBar step={step} />

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── STEP 1: Basis ── */}
          {step === 1 && (
            <>
              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.appt.title', 'Titel')} *
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder={t('crm.appt.titlePlaceholder', 'z.B. Erstgespräch Zoom, Objektbesichtigung...')}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                />
              </div>

              {/* Date */}
              <div>
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

              {/* Time */}
              <div className="flex gap-3">
                <div className="flex-1">
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
                <div className="flex-1">
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

              {/* Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('crm.appt.type', 'Typ')}
                </label>
                <div className="flex gap-2">
                  {(['zoom', 'inperson', 'phone'] as ApptType[]).map(tp => (
                    <button
                      key={tp}
                      type="button"
                      onClick={() => setApptType(tp)}
                      className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors"
                      style={
                        apptType === tp
                          ? { backgroundColor: '#ff795d', color: '#fff', borderColor: '#ff795d' }
                          : { backgroundColor: '#fff', color: '#374151', borderColor: '#d1d5db' }
                      }
                    >
                      {typeLabels[tp]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.appt.description', 'Beschreibung')}
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-none"
                />
              </div>
            </>
          )}

          {/* ── STEP 2: Details ── */}
          {step === 2 && (
            <>
              {apptType === 'zoom' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('crm.appt.zoomLink', 'Zoom Link')}
                    </label>
                    <input
                      type="text"
                      value={zoomLink}
                      onChange={e => setZoomLink(e.target.value)}
                      placeholder="https://zoom.us/j/..."
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      {t('crm.appt.zoomLinkHint', 'Zoom Meeting im Zoom-Portal anlegen und Link hier eintragen.')}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('crm.appt.zoomPassword', 'Passwort')}
                    </label>
                    <input
                      type="text"
                      value={zoomPassword}
                      onChange={e => setZoomPassword(e.target.value)}
                      placeholder={t('crm.appt.optional', 'optional')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                    />
                  </div>
                </>
              )}

              {apptType === 'inperson' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('crm.appt.address', 'Adresse')}
                    </label>
                    <textarea
                      value={location}
                      onChange={e => setLocation(e.target.value)}
                      rows={3}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-none"
                      placeholder={t('crm.appt.addressPlaceholder', 'Straße, Ort...')}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('crm.appt.mapsLink', 'Google Maps Link')}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={locationUrl}
                        onChange={e => setLocationUrl(e.target.value)}
                        placeholder="https://maps.google.com/..."
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                      />
                      <button
                        type="button"
                        onClick={handleGenerateMaps}
                        className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
                      >
                        {t('crm.appt.generateMaps', 'Link generieren')}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {apptType === 'phone' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('crm.appt.phone', 'Telefonnummer')}
                  </label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={e => setPhoneNumber(e.target.value)}
                    placeholder="+49 ..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                  />
                </div>
              )}
            </>
          )}

          {/* ── STEP 3: Lead ── */}
          {step === 3 && (
            <>
              {leadId ? (
                <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 flex items-center gap-2">
                  <span className="text-green-600">🔒</span>
                  <span className="text-sm text-green-700">
                    {t('crm.appt.leadLinked', 'Lead bereits verknüpft:')} <strong>{leadName}</strong>
                  </span>
                </div>
              ) : (
                <>
                  {selectedLeadId && (
                    <div className="flex items-center gap-2 mb-3">
                      <span
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium"
                        style={{ backgroundColor: '#fff0eb', color: '#ff795d' }}
                      >
                        {selectedLeadName}
                        <button
                          type="button"
                          onClick={() => { setSelectedLeadId(null); setSelectedLeadName('') }}
                          className="ml-1 text-xs opacity-70 hover:opacity-100"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('crm.appt.searchLead', 'Lead suchen')}
                    </label>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => handleSearchChange(e.target.value)}
                      placeholder={t('crm.appt.searchPlaceholder', 'Name eingeben...')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                    />
                  </div>

                  {searchLoading && (
                    <p className="text-xs text-gray-400 mt-1">
                      {t('crm.appt.searching', 'Suche...')}
                    </p>
                  )}

                  {searchResults.length > 0 && (
                    <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100 mt-1 max-h-48 overflow-y-auto">
                      {searchResults.map(lead => (
                        <li key={lead.id}>
                          <button
                            type="button"
                            onClick={() => selectLead(lead)}
                            className="w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors"
                          >
                            <span className="text-sm font-medium text-gray-800">
                              {lead.first_name} {lead.last_name}
                            </span>
                            <span className="text-xs text-gray-400 ml-2">{lead.email}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {!selectedLeadId && (
                    <p className="text-xs text-gray-400 mt-2">
                      {t('crm.appt.noLeadOptional', 'Lead-Verknüpfung ist optional.')}
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {/* ── STEP 4: Bestätigen ── */}
          {step === 4 && (
            <>
              {/* Summary card */}
              <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-base font-semibold text-gray-900 font-body">{title}</p>
                  <span
                    className="shrink-0 px-2.5 py-0.5 rounded-full text-xs font-medium"
                    style={
                      apptType === 'zoom'
                        ? { backgroundColor: '#ede9fe', color: '#7c3aed' }
                        : apptType === 'inperson'
                          ? { backgroundColor: '#dcfce7', color: '#15803d' }
                          : { backgroundColor: '#f3f4f6', color: '#4b5563' }
                    }
                  >
                    {typeLabels[apptType]}
                  </span>
                </div>

                <div className="text-sm text-gray-600">
                  📅 {date} · {von}–{bis} {durationLabel() && `(${durationLabel()})`}
                </div>

                {apptType === 'zoom' && zoomLink && (
                  <div className="text-sm text-gray-600 break-all">
                    🔗{' '}
                    <a href={zoomLink} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      {zoomLink}
                    </a>
                  </div>
                )}

                {apptType === 'inperson' && location && (
                  <div className="text-sm text-gray-600">
                    📍 {location}
                    {locationUrl && (
                      <> ·{' '}
                        <a href={locationUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline ml-1">
                          Maps
                        </a>
                      </>
                    )}
                  </div>
                )}

                {apptType === 'phone' && phoneNumber && (
                  <div className="text-sm text-gray-600">📞 {phoneNumber}</div>
                )}

                {(selectedLeadId || leadId) && (
                  <div className="text-sm text-gray-600">
                    👤 {selectedLeadName || leadName}
                  </div>
                )}
              </div>

              {/* Google Calendar checkbox */}
              {hasGoogleToken() && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={saveToGoogle}
                    onChange={e => setSaveToGoogle(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    {t('crm.appt.saveToGoogle', 'In Google Kalender speichern')}
                  </span>
                </label>
              )}

              {/* Email invite checkbox */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendEmailInvite}
                  onChange={e => setSendEmailInvite(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">
                  {t('crm.appt.sendEmailInvite', 'Einladung per E-Mail an Lead senden')}
                </span>
              </label>

              {saveError && (
                <p className="text-sm text-red-500">{saveError}</p>
              )}
            </>
          )}
        </div>

        {/* Footer navigation */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
          <button
            type="button"
            onClick={() => step > 1 ? setStep(s => s - 1) : onClose()}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg"
          >
            {step > 1 ? t('crm.appt.back', '← Zurück') : t('crm.appt.cancel', 'Abbrechen')}
          </button>

          {step < 4 ? (
            <button
              type="button"
              onClick={() => setStep(s => s + 1)}
              disabled={!canProceed()}
              className="px-5 py-2 text-sm font-medium text-white rounded-lg transition-opacity disabled:opacity-40"
              style={{ backgroundColor: '#ff795d' }}
            >
              {t('crm.appt.next', 'Weiter →')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={saving}
              className="px-5 py-2 text-sm font-medium text-white rounded-lg flex items-center gap-2 disabled:opacity-60"
              style={{ backgroundColor: '#ff795d' }}
            >
              {saving && (
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {t('crm.appt.create', 'Termin anlegen')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
