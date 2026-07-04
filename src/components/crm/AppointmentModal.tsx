import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { checkCalendarStatus, createGoogleEvent, updateGoogleEvent } from '../../lib/googleCalendar'
import type { CrmAppointment, AppointmentType } from '../../lib/crmTypes'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  leadId?:       string | null
  leadName?:     string | null
  leadPhone?:    string | null
  initialDate?:  Date | null
  /** Wenn gesetzt: Modal bearbeitet diesen Termin statt einen neuen anzulegen. */
  appointment?:  CrmAppointment | null
  onClose:       () => void
  onCreated:     () => void
}

type ApptType = AppointmentType

// ── ICS-Anhang für Einladungs-Mails (Kunde kann Termin in SEINEN Kalender legen) ──
// METHOD:REQUEST + ATTENDEE + SEQUENCE: so verarbeiten Gmail/Outlook/Apple die Mail
// als echtes Termin-Update (Terminänderung ERSETZT den alten Eintrag beim Kunden,
// statt ignoriert zu werden oder ein Duplikat anzulegen).
function buildIcs(opts: {
  uid: string; title: string; startIso: string; endIso: string
  description?: string; location?: string; sequence?: number; attendeeEmail?: string
}): string {
  const dt  = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Happy Property//CRM//DE',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${opts.uid}@happy-property.com`,
    `SEQUENCE:${opts.sequence ?? 0}`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(opts.startIso)}`,
    `DTEND:${dt(opts.endIso)}`,
    `SUMMARY:${esc(opts.title)}`,
    ...(opts.description ? [`DESCRIPTION:${esc(opts.description)}`] : []),
    ...(opts.location ? [`LOCATION:${esc(opts.location)}`] : []),
    'ORGANIZER;CN=Sven Rüprich:mailto:sven@happy-property.com',
    ...(opts.attendeeEmail ? [`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${opts.attendeeEmail}`] : []),
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
}

// HTML-Escaping für Mail-Inhalte (Titel/Links/Ort sind freie Eingaben — ein
// Anführungszeichen im gepasteten Link darf das Mail-Markup nicht zerbrechen).
const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

interface LeadResult {
  id:         string
  first_name: string
  last_name:  string
  phone:      string | null
  email:      string
}

// ── Step progress bar ─────────────────────────────────────────────────────────

function StepBar({ step }: { step: number }) {
  const { t } = useTranslation()
  const STEP_LABELS = [
    t('appointmentModal.stepBasis', 'Basis'),
    t('appointmentModal.stepDetails', 'Details'),
    t('appointmentModal.stepLead', 'Lead'),
    t('appointmentModal.stepConfirm', 'Bestätigen'),
  ]
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
  appointment,
  onClose,
  onCreated,
}: Props) {
  const { t }        = useTranslation()
  const { profile }  = useAuth()
  const isEdit       = !!appointment

  // Step
  const [step, setStep] = useState(1)

  // ── Step 1: Basis (bei Bearbeitung aus dem Termin vorbefüllt) ──
  const [title, setTitle]       = useState(appointment?.title ?? '')
  const [date, setDate]         = useState<string>(() => {
    const src = appointment ? new Date(appointment.start_time) : initialDate
    if (src) {
      const y = src.getFullYear()
      const m = String(src.getMonth() + 1).padStart(2, '0')
      const d = String(src.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
    return ''
  })
  const toTime = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const [von, setVon]           = useState(appointment ? toTime(appointment.start_time) : '10:00')
  const [bis, setBis]           = useState(appointment ? toTime(appointment.end_time) : '11:00')
  const [apptType, setApptType] = useState<ApptType>(appointment?.type ?? 'zoom')
  const [description, setDescription] = useState(appointment?.description ?? '')

  // ── Step 2: Details ───────────────────────────────────────────

  // Zoom
  const [zoomLink, setZoomLink]         = useState(appointment?.zoom_link ?? '')
  const [zoomPassword, setZoomPassword] = useState('')
  const [zoomMeetingId, setZoomMeetingId] = useState<string | null>(appointment?.zoom_meeting_id ?? null)
  const [zoomGenerating, setZoomGenerating] = useState(false)
  const [zoomGenerated, setZoomGenerated]   = useState(!!appointment?.zoom_link)
  const [zoomError, setZoomError]           = useState('')

  // In-person
  const [location, setLocation]     = useState(appointment?.location ?? '')
  const [locationUrl, setLocationUrl] = useState(appointment?.location_url ?? '')

  // Phone / WhatsApp
  const [phoneNumber, setPhoneNumber] = useState(appointment?.phone_number ?? leadPhone ?? '')

  // ── Step 3: Lead ──────────────────────────────────────────────
  const [searchQuery, setSearchQuery]         = useState('')
  const [searchResults, setSearchResults]     = useState<LeadResult[]>([])
  const [searchLoading, setSearchLoading]     = useState(false)
  const [selectedLeadId, setSelectedLeadId]   = useState<string | null>(appointment?.lead_id ?? leadId ?? null)
  const [selectedLeadName, setSelectedLeadName] = useState<string>(
    appointment?.lead ? `${appointment.lead.first_name} ${appointment.lead.last_name}` : (leadName ?? ''),
  )
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Step 4: Confirm ───────────────────────────────────────────
  // Google-Verbindung ist server-seitig (Service-Account) → einmalige Prüfung.
  const [googleAvailable, setGoogleAvailable]   = useState(false)
  const [saveToGoogle, setSaveToGoogle]         = useState(false)
  const [sendEmailInvite, setSendEmailInvite]   = useState(false)
  const [sendWhatsAppInvite, setSendWhatsAppInvite] = useState(false)
  const [saving, setSaving]                     = useState(false)
  const [saveError, setSaveError]               = useState('')
  // Termin ist gespeichert, aber Nebenwirkungen (Google-Sync/Einladung) schlugen fehl:
  // Warnung zeigen + Button wird zu „Schließen" (verhindert Doppel-Anlage durch Retry).
  const [savedWithWarnings, setSavedWithWarnings] = useState(false)

  useEffect(() => {
    let cancelled = false
    checkCalendarStatus()
      .then(s => {
        if (cancelled) return
        setGoogleAvailable(s.connected)
        // Standard: neue Termine landen automatisch im Google-Kalender
        if (s.connected && !isEdit) setSaveToGoogle(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isEdit])

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

  // ── Generate Zoom Meeting via Edge Function ───────────────────
  async function handleGenerateZoom() {
    if (!date || !von) return
    setZoomGenerating(true)
    setZoomError('')
    try {
      const start_time = new Date(`${date}T${von}`).toISOString()
      const [vonH, vonM] = von.split(':').map(Number)
      const [bisH, bisM] = bis.split(':').map(Number)
      const duration_minutes = Math.max(30, (bisH * 60 + bisM) - (vonH * 60 + vonM))

      const { data, error } = await supabase.functions.invoke('create-zoom-meeting', {
        body: { title: title || t('crm.appt.defaultZoomTitle', 'Beratungsgespräch'), start_time, duration_minutes },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)

      setZoomLink(data.join_url ?? '')
      setZoomPassword(data.password ?? '')
      setZoomMeetingId(data.meeting_id ?? null)
      setZoomGenerated(true)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setZoomError(msg)
    } finally {
      setZoomGenerating(false)
    }
  }

  // ── handleCreate (legt an ODER speichert Änderungen, inkl. Google-Sync) ─────
  async function handleCreate() {
    setSaving(true)
    setSaveError('')
    const warnings: string[] = []
    try {
      const startD = new Date(`${date}T${von}`)
      const endD   = new Date(`${date}T${bis}`)
      if (endD < startD) endD.setDate(endD.getDate() + 1)   // Termin über Mitternacht
      const start_time = startD.toISOString()
      const end_time   = endD.toISOString()

      // Nur die zum gewählten Typ gehörenden Detail-Felder speichern — beim
      // Typwechsel im Edit-Modus dürfen keine alten Zoom-Links/Adressen kleben bleiben.
      const effZoomLink      = apptType === 'zoom' ? zoomLink : ''
      const effZoomPassword  = apptType === 'zoom' ? zoomPassword : ''
      const effZoomMeetingId = apptType === 'zoom' ? zoomMeetingId : null
      const effLocation      = apptType === 'inperson' ? location : ''
      const effLocationUrl   = apptType === 'inperson' ? locationUrl : ''
      const effPhone         = (apptType === 'phone' || apptType === 'whatsapp') ? phoneNumber : ''

      const payload = {
        title,
        description:     description || null,
        type:            apptType,
        start_time,
        end_time,
        lead_id:         selectedLeadId || null,
        zoom_link:       effZoomLink || null,
        zoom_meeting_id: effZoomMeetingId,
        location:        effLocation || null,
        location_url:    effLocationUrl || null,
        phone_number:    effPhone || null,
      }

      let apptId = appointment?.id ?? ''
      if (isEdit && appointment) {
        // ── Bearbeiten: DB-Update + Google-Event mitziehen ──
        const { error } = await supabase
          .from('crm_appointments')
          .update(payload)
          .eq('id', appointment.id)
        if (error) throw new Error(t('appointmentModal.dbErrorGeneric', 'DB-Fehler [{{code}}]: {{message}}', { code: error.code, message: error.message }))

        if (appointment.google_event_id) {
          try {
            await updateGoogleEvent(appointment.google_event_id, {
              title,
              description: description || '',
              location:    effLocation || '',
              startIso:    start_time,
              endIso:      end_time,
            }, appointment.google_calendar_id ?? undefined)
          } catch (gErr) {
            console.warn('[AppointmentModal] Google-Update fehlgeschlagen:', gErr)
            warnings.push(t('crm.appt.googleSyncWarn', 'Google-Kalender wurde NICHT aktualisiert — Termin bitte erneut öffnen und speichern.'))
          }
        } else if (saveToGoogle && googleAvailable) {
          try {
            const g = await createGoogleEvent({ title, startIso: start_time, endIso: end_time, description: description || undefined, location: effLocation || undefined })
            await supabase.from('crm_appointments')
              .update({ google_event_id: g.id, google_calendar_id: g.calendar_id ?? null })
              .eq('id', appointment.id)
          } catch (gErr) {
            console.warn('[AppointmentModal] Google-Sync fehlgeschlagen:', gErr)
            warnings.push(t('crm.appt.googleSyncWarn', 'Google-Kalender wurde NICHT aktualisiert — Termin bitte erneut öffnen und speichern.'))
          }
        }
      } else {
        // ── Neu anlegen ──
        const { data: appt, error } = await supabase
          .from('crm_appointments')
          .insert({ ...payload, created_by: profile?.id || null })
          .select()
          .single()

        if (error) {
          console.error('[AppointmentModal] Supabase Insert Fehler:', {
            code: error.code, message: error.message, details: error.details, hint: error.hint,
          })
          const msg = error.code === '42P01'
            ? t('appointmentModal.tableMissingError', 'Tabelle crm_appointments existiert nicht – Migration ausführen!')
            : error.code === '42501' || error.message?.includes('row-level security')
              ? t('appointmentModal.rlsPermissionError', 'Keine Berechtigung (RLS). Nur Admin/Verwalter dürfen Termine anlegen.')
              : t('appointmentModal.dbErrorGeneric', 'DB-Fehler [{{code}}]: {{message}}', { code: error.code, message: error.message })
          throw new Error(msg)
        }
        apptId = (appt as { id: string }).id

        // In den Google-Kalender spiegeln (server-seitig, Service-Account)
        if (saveToGoogle && googleAvailable) {
          try {
            const g = await createGoogleEvent({
              title,
              startIso:    start_time,
              endIso:      end_time,
              description: description || undefined,
              location:    effLocation || undefined,
            })
            await supabase
              .from('crm_appointments')
              .update({ google_event_id: g.id, google_calendar_id: g.calendar_id ?? null })
              .eq('id', apptId)
          } catch (gErr) {
            console.warn('[AppointmentModal] Google Calendar Fehler:', gErr)
            warnings.push(t('crm.appt.googleSyncWarn', 'Google-Kalender wurde NICHT aktualisiert — Termin bitte erneut öffnen und speichern.'))
          }
        }
      }

      // Log activity
      if (selectedLeadId) {
        const { error: actErr } = await supabase.from('activities').insert({
          lead_id:   selectedLeadId,
          type:      'meeting',
          direction: 'outbound',
          subject:   title,
          content:   `${isEdit ? 'Termin aktualisiert' : 'Termin angelegt'}: ${apptType} am ${date} ${von}-${bis}`,
          created_by: profile?.id,
        })
        if (actErr) console.warn('[AppointmentModal] Activity-Log Fehler:', actErr)
      }

      // ── Wo-Zeile für Einladungen (Mail + WhatsApp) — alle Werte HTML-escaped ──
      const dateStr = new Date(start_time).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
      const whereHtml = apptType === 'zoom' && effZoomLink
        ? `<p>Zoom-Link: <a href="${escHtml(effZoomLink)}">${escHtml(effZoomLink)}</a>${effZoomPassword ? `<br>Passwort: <strong>${escHtml(effZoomPassword)}</strong>` : ''}</p>`
        : apptType === 'inperson' && (effLocation || effLocationUrl)
          ? `<p>Ort: ${escHtml(effLocation)}${effLocationUrl ? ` · <a href="${escHtml(effLocationUrl)}">In Google Maps öffnen</a>` : ''}</p>`
          : apptType === 'whatsapp' && effPhone
            ? `<p>Wir melden uns per WhatsApp unter: ${escHtml(effPhone)}</p>`
            : apptType === 'phone' && effPhone
              ? `<p>Wir rufen dich an unter: ${escHtml(effPhone)}</p>` : ''

      // Optional: Terminbestätigung per E-Mail an den Lead (mit Kalender-Anhang)
      if (sendEmailInvite && selectedLeadId) {
        try {
          const { data: ld } = await supabase.from('leads').select('email, first_name').eq('id', selectedLeadId).maybeSingle()
          const le = ld as { email?: string | null; first_name?: string | null } | null
          if (le?.email) {
            const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#2b2b2b;line-height:1.6"><p>Hallo ${escHtml(le.first_name || '')},</p><p>${isEdit ? 'unser Termin wurde aktualisiert:' : 'hiermit bestätige ich unseren Termin:'}</p><p><strong>${escHtml(title)}</strong><br>${dateStr}<br>${von}–${bis} Uhr</p>${whereHtml}<p>Im Anhang findest du den Termin für deinen Kalender.</p><p>Ich freue mich auf das Gespräch!</p><p>Bis bald,<br><strong>Sven · Happy Property Cyprus</strong></p></div>`
            const icsDesc = [description, effZoomLink ? `Zoom: ${effZoomLink}${effZoomPassword ? ` (Passwort: ${effZoomPassword})` : ''}` : '', effLocationUrl || ''].filter(Boolean).join('\n')
            const ics = buildIcs({
              uid:        apptId || crypto.randomUUID(),
              title, startIso: start_time, endIso: end_time,
              description: icsDesc || undefined,
              location:    effLocation || undefined,
              // SEQUENCE steigt bei jeder Änderungs-Mail → Kalender-Clients ERSETZEN den Eintrag
              sequence:      isEdit ? Math.floor(Date.now() / 1000) : 0,
              attendeeEmail: le.email,
            })
            const { error: mailErr } = await supabase.functions.invoke('send-email', {
              body: {
                to: le.email,
                subject: `${isEdit ? 'Terminänderung' : 'Terminbestätigung'}: ${title}`,
                html,
                lead_id: selectedLeadId,
                attachment: {
                  filename:       'termin.ics',
                  content_base64: btoa(unescape(encodeURIComponent(ics))),
                  content_type:   'text/calendar',
                },
              },
            })
            if (mailErr) {
              console.warn('[AppointmentModal] Einladungs-Mail fehlgeschlagen:', mailErr.message)
              warnings.push(t('crm.appt.mailInviteFailed', 'E-Mail-Einladung konnte NICHT gesendet werden.'))
            }
          } else {
            warnings.push(t('crm.appt.noLeadEmail', 'Lead hat keine E-Mail-Adresse — Einladung nicht gesendet.'))
          }
        } catch (mailErr) {
          console.warn('[AppointmentModal] Einladungs-Mail Fehler:', mailErr)
          warnings.push(t('crm.appt.mailInviteFailed', 'E-Mail-Einladung konnte NICHT gesendet werden.'))
        }
      }

      // Optional: Einladung per WhatsApp an den Lead (manueller Klick von Sven).
      // Nummer: DB-Nummer des Leads, sonst die im Modal eingetippte Nummer.
      if (sendWhatsAppInvite && selectedLeadId) {
        try {
          const { data: ld } = await supabase.from('leads').select('phone, first_name, last_name').eq('id', selectedLeadId).maybeSingle()
          const lw = ld as { phone?: string | null; first_name?: string | null; last_name?: string | null } | null
          const waPhone = (lw?.phone || phoneNumber || '').trim()
          if (waPhone) {
            const whereText = apptType === 'zoom' && effZoomLink
              ? `\nZoom-Link: ${effZoomLink}${effZoomPassword ? `\nPasswort: ${effZoomPassword}` : ''}`
              : apptType === 'inperson' && (effLocation || effLocationUrl)
                ? `\nOrt: ${effLocation}${effLocationUrl ? `\n${effLocationUrl}` : ''}`
                : ''
            const waText = `Hallo ${lw?.first_name || ''}, ${isEdit ? 'unser Termin wurde aktualisiert' : 'hiermit bestätige ich unseren Termin'}:\n\n${title}\n${dateStr}, ${von}–${bis} Uhr${whereText}\n\nIch freue mich auf das Gespräch!\nSven · Happy Property Cyprus`
            const { error: waErr } = await supabase.functions.invoke('send-whatsapp', {
              body: {
                event_type:   'termin_einladung',   // reines Label fürs Activity-Log (override_text braucht kein Template)
                override_text: waText,
                lead_data:    { lead_name: `${lw?.first_name ?? ''} ${lw?.last_name ?? ''}`.trim(), lead_phone: waPhone },
                lead_id:      selectedLeadId,
              },
            })
            if (waErr) {
              console.warn('[AppointmentModal] WhatsApp-Einladung fehlgeschlagen:', waErr.message)
              warnings.push(t('crm.appt.waInviteFailed', 'WhatsApp-Einladung konnte NICHT gesendet werden.'))
            }
          } else {
            warnings.push(t('crm.appt.noLeadPhone', 'Keine WhatsApp-Nummer vorhanden — Einladung nicht gesendet.'))
          }
        } catch (waErr) {
          console.warn('[AppointmentModal] WhatsApp-Einladung Fehler:', waErr)
          warnings.push(t('crm.appt.waInviteFailed', 'WhatsApp-Einladung konnte NICHT gesendet werden.'))
        }
      }

      // Nebenwirkungs-Warnungen sichtbar machen statt still zu schließen.
      // Termin selbst ist gespeichert — Button wird zu „Schließen" (kein Doppel-Anlegen).
      if (warnings.length > 0) {
        setSavedWithWarnings(true)
        setSaveError(t('crm.appt.savedWithWarnings', 'Termin gespeichert, aber:') + ' ' + warnings.join(' · '))
        return
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
    inperson:  `📍 ${t('appointmentModal.typeInPerson', 'Vor Ort')}`,
    phone:     `📞 ${t('appointmentModal.typePhone', 'Telefon')}`,
    whatsapp:  '💬 WhatsApp',
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <h2 className="text-lg font-semibold text-gray-900 font-body">
            {isEdit
              ? t('crm.appt.modalTitleEdit', 'Termin bearbeiten')
              : t('crm.appt.modalTitle', 'Termin anlegen')}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label={t('appointmentModal.closeAriaLabel', 'Schließen')}
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
                <div className="grid grid-cols-2 gap-2">
                  {(['zoom', 'inperson', 'phone', 'whatsapp'] as ApptType[]).map(tp => (
                    <button
                      key={tp}
                      type="button"
                      onClick={() => setApptType(tp)}
                      className="px-3 py-2 rounded-lg text-sm font-medium border transition-colors"
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
                  {/* ── Auto-generate button ── */}
                  {!zoomGenerated && (
                    <div>
                      <button
                        type="button"
                        onClick={() => void handleGenerateZoom()}
                        disabled={zoomGenerating || !date || !von}
                        className="w-full py-2.5 rounded-lg text-sm font-medium text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-opacity"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        {zoomGenerating && (
                          <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        )}
                        {zoomGenerating
                          ? t('crm.appt.zoomGenerating', 'Erstelle Zoom Meeting…')
                          : t('crm.appt.zoomGenerate', '📹 Zoom Meeting generieren')}
                      </button>
                      {(!date || !von) && (
                        <p className="text-xs text-gray-400 mt-1">
                          {t('crm.appt.zoomNeedsDate', 'Datum und Uhrzeit in Schritt 1 setzen.')}
                        </p>
                      )}
                    </div>
                  )}

                  {/* ── Success state ── */}
                  {zoomGenerated && (
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
                      <p className="text-sm font-semibold text-green-700">
                        ✅ {t('crm.appt.zoomCreated', 'Meeting erstellt!')}
                      </p>
                      <div>
                        <p className="text-xs text-gray-500 mb-1">🔗 {t('crm.appt.zoomJoinUrl', 'Join URL')}</p>
                        <div className="flex items-center gap-2">
                          <a
                            href={zoomLink}
                            target="_blank"
                            rel="noreferrer"
                            className="flex-1 text-xs text-blue-600 underline break-all"
                          >
                            {zoomLink}
                          </a>
                          <button
                            type="button"
                            onClick={() => void navigator.clipboard.writeText(zoomLink)}
                            className="shrink-0 text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
                          >
                            {t('common.copy', 'Kopieren')}
                          </button>
                        </div>
                      </div>
                      {zoomPassword && (
                        <div>
                          <p className="text-xs text-gray-500 mb-1">🔑 {t('crm.appt.zoomPassword', 'Passwort')}</p>
                          <div className="flex items-center gap-2">
                            <span className="flex-1 text-sm font-mono text-gray-700">{zoomPassword}</span>
                            <button
                              type="button"
                              onClick={() => void navigator.clipboard.writeText(zoomPassword)}
                              className="shrink-0 text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
                            >
                              {t('common.copy', 'Kopieren')}
                            </button>
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => { setZoomGenerated(false); setZoomLink(''); setZoomPassword(''); setZoomMeetingId(null) }}
                        className="text-xs text-gray-400 hover:text-gray-600 underline"
                      >
                        {t('crm.appt.zoomReset', 'Neues Meeting generieren')}
                      </button>
                    </div>
                  )}

                  {/* ── Error fallback → manual input ── */}
                  {zoomError && (
                    <div className="space-y-3">
                      <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        ⚠️ {t('crm.appt.zoomNotAvailable', 'Zoom nicht verfügbar – Link manuell eintragen.')}
                        <span className="block text-amber-500 mt-0.5">{zoomError}</span>
                      </p>
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
                    </div>
                  )}
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

                  {/* Live-Kartenvorschau: zeigt sofort, ob die Adresse gefunden wird */}
                  {location.trim() && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('crm.appt.mapPreview', 'Kartenvorschau')}
                      </label>
                      <iframe
                        title={t('appointmentModal.mapPreviewIframeTitle', 'Kartenvorschau')}
                        src={`https://www.google.com/maps?q=${encodeURIComponent(location)}&output=embed`}
                        className="w-full h-44 rounded-lg border border-gray-200"
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                      />
                    </div>
                  )}
                </>
              )}

              {(apptType === 'phone' || apptType === 'whatsapp') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {apptType === 'whatsapp'
                      ? t('crm.appt.whatsappNumber', 'WhatsApp-Nummer')
                      : t('crm.appt.phone', 'Telefonnummer')}
                  </label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={e => setPhoneNumber(e.target.value)}
                    placeholder="+49 ..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                  />
                  {apptType === 'whatsapp' && phoneNumber.trim() && (
                    <a
                      href={`https://wa.me/${phoneNumber.replace(/[^0-9]/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block mt-2 text-sm underline font-medium"
                      style={{ color: '#128c7e' }}
                    >
                      💬 {t('crm.appt.openWhatsApp', 'Chat in WhatsApp öffnen')}
                    </a>
                  )}
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
                          ? { backgroundColor: '#fef3c7', color: '#b45309' }
                          : apptType === 'whatsapp'
                            ? { backgroundColor: '#d9fdd3', color: '#128c7e' }
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

                {(apptType === 'phone' || apptType === 'whatsapp') && phoneNumber && (
                  <div className="text-sm text-gray-600">
                    {apptType === 'whatsapp' ? '💬' : '📞'} {phoneNumber}
                  </div>
                )}

                {(selectedLeadId || leadId) && (
                  <div className="text-sm text-gray-600">
                    👤 {selectedLeadName || leadName}
                  </div>
                )}
              </div>

              {/* Google Calendar checkbox (Verbindung ist server-seitig/dauerhaft) */}
              {googleAvailable && (!isEdit || !appointment?.google_event_id) && (
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
              {isEdit && appointment?.google_event_id && (
                <p className="text-xs text-gray-400">
                  ✓ {t('crm.appt.googleLinked', 'Mit Google Kalender verknüpft — Änderungen werden automatisch übernommen.')}
                </p>
              )}

              {/* Email invite checkbox (mit Kalender-Anhang) — nur mit verknüpftem Lead */}
              {(selectedLeadId || leadId) && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendEmailInvite}
                    onChange={e => setSendEmailInvite(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    {isEdit
                      ? t('crm.appt.sendEmailUpdate', 'Terminänderung per E-Mail an Lead senden (mit Kalender-Anhang)')
                      : t('crm.appt.sendEmailInviteIcs', 'Einladung per E-Mail an Lead senden (mit Kalender-Anhang)')}
                  </span>
                </label>
              )}

              {/* WhatsApp invite checkbox */}
              {(selectedLeadId || leadId) && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendWhatsAppInvite}
                    onChange={e => setSendWhatsAppInvite(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    {t('crm.appt.sendWhatsAppInvite', 'Einladung per WhatsApp an Lead senden')}
                  </span>
                </label>
              )}

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
          ) : savedWithWarnings ? (
            // Termin ist gespeichert (nur Nebenwirkungen schlugen fehl) → nur noch schließen,
            // ein erneuter Klick auf „Termin anlegen" würde ein Duplikat erzeugen.
            <button
              type="button"
              onClick={() => onCreated()}
              className="px-5 py-2 text-sm font-medium text-white rounded-lg"
              style={{ backgroundColor: '#ff795d' }}
            >
              {t('common.close', 'Schließen')}
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
              {isEdit
                ? t('crm.appt.saveChanges', 'Änderungen speichern')
                : t('crm.appt.create', 'Termin anlegen')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
