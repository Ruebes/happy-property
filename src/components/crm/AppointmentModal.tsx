import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { checkCalendarStatus, createGoogleEvent, updateGoogleEvent } from '../../lib/googleCalendar'
import type { CrmAppointment, AppointmentType } from '../../lib/crmTypes'
import { DECK_LOGO, DECK_PHOTO } from '../../lib/deckTypes'

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

// ── Einladung im Happy-Property-Template (E-Mail-sicher, Tabellen + Inline-CSS) ──
const HP_PHOTO_SQ = DECK_PHOTO.replace('/object/public/', '/render/image/public/') + '?width=112&height=112&resize=cover&quality=80'
const HP_SANS = "Montserrat, Helvetica, Arial, sans-serif"

interface InviteParams {
  firstName: string; isEdit: boolean; title: string
  dateStr: string; von: string; bis: string
  apptType: ApptType
  zoomLink?: string; zoomPassword?: string
  location?: string; locationUrl?: string; phone?: string
  gcalHref: string
  // false = Partner/Teilnehmer: neutraler Text, keine Kunden-Telefonnummer
  isPrimary?: boolean
  // KI-personalisierter Absatz (aus Svens Beschreibung, je Empfänger)
  personalNote?: string
  // Zu-/Absage-Links (One-Click, /zusage)
  rsvpYesHref?: string
  rsvpNoHref?: string
}

function buildInviteHtml(pr: InviteParams): string {
  const e = escHtml
  const intro = pr.isEdit
    ? `unser Termin hat sich geändert — hier sind die neuen Details:`
    : `ich freue mich auf unser Treffen! Hier die Details:`
  // Remote-Termine (Zoom/Telefon/WhatsApp): Uhrzeit in KUNDENZEIT (Deutschland) — der
  // Kunde sitzt i.d.R. in DE. Vor Ort = Ortszeit (Zypern, das Venue), ohne Zusatz.
  const tzNote = pr.apptType === 'inperson' ? '' : ' (deutsche Zeit)'
  const where = pr.apptType === 'inperson'
    ? (pr.location
        ? `Wir sehen uns um <strong>${e(pr.von)} Uhr</strong> hier: <strong>${e(pr.location)}</strong>.`
        : `Wir sehen uns um <strong>${e(pr.von)} Uhr</strong>.`)
    : pr.apptType === 'zoom'
      ? `Wir sprechen um <strong>${e(pr.von)} Uhr${tzNote}</strong> per Zoom${pr.zoomPassword ? ` (Passwort: <strong>${e(pr.zoomPassword)}</strong>)` : ''}.`
      : pr.isPrimary === false
        ? `Der Termin findet um <strong>${e(pr.von)} Uhr${tzNote}</strong> ${pr.apptType === 'whatsapp' ? 'per WhatsApp-Call' : 'telefonisch'} statt.`
        : pr.apptType === 'whatsapp'
          ? `Ich rufe dich um <strong>${e(pr.von)} Uhr${tzNote}</strong> per WhatsApp an${pr.phone ? ` (${e(pr.phone)})` : ''}.`
          : `Ich rufe dich um <strong>${e(pr.von)} Uhr${tzNote}</strong> an${pr.phone ? ` (${e(pr.phone)})` : ''}.`
  const btn = (href: string, label: string, solid: boolean) =>
    `<a href="${e(href)}" target="_blank" style="display:inline-block;white-space:nowrap;font-family:${HP_SANS};font-size:13px;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:10px;margin:0 8px 8px 0;${solid ? 'background-color:#ff795d;color:#ffffff;' : 'background-color:#ffffff;color:#1a2332;border:1px solid #e6dfd0;'}">${label}</a>`
  const buttons = [
    pr.rsvpYesHref ? btn(pr.rsvpYesHref, '✅ Ich bin dabei', true) : '',
    pr.apptType === 'zoom' && pr.zoomLink ? btn(pr.zoomLink, '📹 Zoom beitreten', !pr.rsvpYesHref) : '',
    pr.apptType === 'inperson' && pr.locationUrl ? btn(pr.locationUrl, '📍 Ort auf Google Maps', false) : '',
    btn(pr.gcalHref, '🗓 In meinen Kalender', false),
  ].filter(Boolean).join('')
  const rsvpNoLine = pr.rsvpNoHref
    ? `<div style="font-family:${HP_SANS};font-size:12px;color:#9a9aa3;margin-top:10px;">Passt der Termin nicht? <a href="${e(pr.rsvpNoHref)}" style="color:#9a9aa3;text-decoration:underline;">Kurz Bescheid geben</a> — dann finden wir einen neuen.</div>`
    : ''
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#FAF6EC;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FAF6EC;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 0 20px 0;"><img src="${DECK_LOGO}" alt="Happy Property" width="120" height="37" style="display:block;border:0;"></td></tr>
  <tr><td style="background-color:#ffffff;border-radius:14px;padding:32px 36px;">
    <div style="font-family:Georgia, 'Times New Roman', serif;font-size:22px;font-weight:700;color:#1a2332;">${pr.isEdit ? 'Terminänderung' : 'Unser Termin steht'} ✔</div>
    <div style="font-family:${HP_SANS};font-size:14px;line-height:1.7;color:#1b1b22;margin-top:16px;">
      Hallo ${e(pr.firstName)},<br><br>
      ${intro}<br><br>
      <strong>${e(pr.title)}</strong><br>
      ${e(pr.dateStr)}<br>
      ${e(pr.von)}–${e(pr.bis)} Uhr<br><br>
      ${pr.personalNote ? `${e(pr.personalNote)}<br><br>` : ''}${where}
    </div>
    <div style="margin-top:22px;">${buttons}</div>
    ${rsvpNoLine}
    <div style="font-family:${HP_SANS};font-size:11px;color:#9a9aa3;margin-top:8px;">Der Termin hängt außerdem als Kalender-Datei an dieser E-Mail.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr>
      <td style="padding-right:14px;"><img src="${HP_PHOTO_SQ}" alt="Sven" width="56" height="56" style="display:block;border-radius:28px;border:0;"></td>
      <td style="font-family:${HP_SANS};font-size:13px;line-height:1.5;color:#1b1b22;">
        Bis bald!<br><strong>Sven</strong> · Happy Property<br>
        <a href="mailto:info@happy-property.com" style="color:#ff795d;text-decoration:none;">info@happy-property.com</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td align="center" style="padding:18px 10px 0 10px;font-family:${HP_SANS};font-size:10px;color:#9a9aa3;">Sveru Ltd. · Pallados 1, 8046 Paphos, Zypern</td></tr>
</table>
</td></tr></table></body></html>`
}

// Kurzlink anlegen (nur für WhatsApp — Mail versteckt URLs hinter Buttons).
// Fällt bei jedem Fehler still auf die Original-URL zurück.
async function shortenUrl(target: string): Promise<string> {
  try {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    const buf = new Uint8Array(7)
    crypto.getRandomValues(buf)
    const code = Array.from(buf, b => chars[b % chars.length]).join('')
    const { error } = await supabase.from('short_links').insert({ code, target })
    if (error) throw error
    return `https://portal.happy-property.com/s/${code}`
  } catch (err) {
    console.warn('[AppointmentModal] shortenUrl:', err)
    return target
  }
}

// Google-Kalender-Vorlagen-Link („In meinen Kalender") — funktioniert ohne Anmeldung beim Absender
function buildGcalHref(title: string, startIso: string, endIso: string, details: string, location?: string): string {
  const f = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${f(startIso)}/${f(endIso)}&details=${encodeURIComponent(details)}${location ? `&location=${encodeURIComponent(location)}` : ''}`
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

  // Weitere Teilnehmer (Partner/Geschäftskontakte) — bekommen die Einladung mit
  interface Attendee { name: string; email: string | null; phone: string | null; company?: string | null; language?: string | null }
  const [attendees, setAttendees] = useState<Attendee[]>(
    Array.isArray(appointment?.attendees) ? (appointment!.attendees as Attendee[]) : [],
  )
  const [bcQuery, setBcQuery] = useState('')
  const [bcResults, setBcResults] = useState<Array<{ id: string; first_name: string; last_name: string | null; company: string | null; email: string | null; phone: string | null; whatsapp: string | null; language?: string | null }>>([])
  const [bcLoading, setBcLoading] = useState(false)
  const bcDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Alle Kontakte EINMAL laden (Partner + alle Developer-Ansprechpartner mit
  // Developer-Namen) — beim Fokus erscheint die komplette Liste, Tippen filtert
  // auch über Firma/Developer/E-Mail.
  const allContactsRef = useRef<typeof bcResults | null>(null)
  const loadAllContacts = useCallback(async (): Promise<typeof bcResults> => {
    if (allContactsRef.current) return allContactsRef.current
    try {
      const [bc, dc] = await Promise.all([
        supabase.from('crm_business_contacts')
          .select('id, first_name, last_name, company, email, phone, whatsapp, language')
          .order('first_name'),
        supabase.from('crm_developer_contacts')
          .select('id, name, email, phone, whatsapp, language, developer:crm_developers(name)')
          .order('name'),
      ])
      if (bc.error) throw bc.error
      if (dc.error) throw dc.error
      const rows = ((bc.data ?? []) as typeof bcResults).map(r => ({ ...r }))
      for (const d of (dc.data ?? []) as Array<{ id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null; language?: string | null; developer?: { name?: string } | { name?: string }[] | null }>) {
        const [first, ...rest] = (d.name ?? '').split(' ')
        const dev = Array.isArray(d.developer) ? d.developer[0] : d.developer
        rows.push({
          id: `dev-${d.id}`, first_name: first || d.name, last_name: rest.join(' ') || null,
          company: dev?.name ? (t('crm.appt.developerSuffix', '{{name}} (Developer)', { name: dev.name }) as string) : (t('crm.appt.developerContact', 'Developer') as string),
          email: d.email, phone: d.whatsapp || d.phone, whatsapp: d.whatsapp ?? null, language: d.language ?? null,
        })
      }
      allContactsRef.current = rows
      return rows
    } catch (err) {
      console.error('[AppointmentModal] loadAllContacts:', err)
      return []
    }
  }, [t])

  const filterContacts = useCallback(async (q: string) => {
    setBcLoading(true)
    try {
      const all = await loadAllContacts()
      const needle = q.trim().toLowerCase()
      const hits = !needle ? all : all.filter(c =>
        `${c.first_name} ${c.last_name ?? ''}`.toLowerCase().includes(needle)
        || (c.company ?? '').toLowerCase().includes(needle)
        || (c.email ?? '').toLowerCase().includes(needle))
      setBcResults(hits.slice(0, 30))
    } finally { setBcLoading(false) }
  }, [loadAllContacts])

  function handleBcSearchChange(val: string) {
    setBcQuery(val)
    if (bcDebounceRef.current) clearTimeout(bcDebounceRef.current)
    bcDebounceRef.current = setTimeout(() => { void filterContacts(val) }, 200)
  }
  function addAttendee(c: { first_name: string; last_name: string | null; company?: string | null; email: string | null; phone: string | null; whatsapp: string | null; language?: string | null }) {
    const name = `${c.first_name} ${c.last_name ?? ''}`.trim()
    setAttendees(prev => prev.some(a => a.name === name) ? prev : [...prev, { name, email: c.email, phone: c.whatsapp || c.phone, company: c.company ?? null, language: c.language ?? null }])
    setBcResults([]); setBcQuery('')
  }
  const removeAttendee = (name: string) => setAttendees(prev => prev.filter(a => a.name !== name))

  // Orts-Suche (Photon/OSM via place-search) — Treffer wird zum Google-Maps-Link
  const [placeResults, setPlaceResults] = useState<Array<{ name: string; display: string; lat: number; lon: number }>>([])
  const [placeLoading, setPlaceLoading] = useState(false)
  const placeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const placeSeqRef = useRef(0)

  function handleLocationChange(val: string) {
    setLocation(val)
    if (placeDebounceRef.current) clearTimeout(placeDebounceRef.current)
    if (val.trim().length < 3) { setPlaceResults([]); return }
    placeDebounceRef.current = setTimeout(async () => {
      const seq = ++placeSeqRef.current   // ältere Antworten dürfen neuere nicht überschreiben
      setPlaceLoading(true)
      try {
        const { data, error } = await supabase.functions.invoke('place-search', { body: { q: val } })
        if (error) throw error
        if (seq !== placeSeqRef.current) return
        setPlaceResults(((data as { results?: typeof placeResults } | null)?.results) ?? [])
      } catch (err) {
        console.warn('[AppointmentModal] place-search:', err)
        if (seq === placeSeqRef.current) setPlaceResults([])
      } finally { if (seq === placeSeqRef.current) setPlaceLoading(false) }
    }, 400)
  }
  function selectPlace(pl: { name: string; display: string; lat: number; lon: number }) {
    // Kein doppeltes erstes Segment, wenn name aus display abgeleitet wurde
    const dupe = pl.display && pl.display.split(',')[0].trim() === pl.name.trim()
    setLocation(pl.display && !dupe ? `${pl.name}, ${pl.display}` : (pl.display || pl.name))
    // Google-Link mit Name + Koordinaten — landet exakt am richtigen Pin
    setLocationUrl(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${pl.name} ${pl.lat},${pl.lon}`)}`)
    setPlaceResults([])
  }

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

      const attendeeLine = attendees.length ? t('crm.appt.googleAttendeesLine', 'Teilnehmer: {{names}}', { names: attendees.map(a => a.name).join(', ') }) : ''
      const googleDesc = [description, attendeeLine].filter(Boolean).join('\n')
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
        attendees:       attendees.length ? attendees : null,
      }

      let apptId = appointment?.id ?? ''
      let manageToken: string | null = appointment?.manage_token ?? null
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
              description: googleDesc || '',
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
            const g = await createGoogleEvent({ title, startIso: start_time, endIso: end_time, description: googleDesc || undefined, location: effLocation || undefined })
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
        manageToken = (appt as { manage_token?: string | null }).manage_token ?? null

        // In den Google-Kalender spiegeln (server-seitig, Service-Account)
        if (saveToGoogle && googleAvailable) {
          try {
            const g = await createGoogleEvent({
              title,
              startIso:    start_time,
              endIso:      end_time,
              description: googleDesc || undefined,
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

      // Terminerinnerungen (24 h + 1 h vorher, Mail + WhatsApp) planen. Bei manuell
      // im Kalender angelegten Terminen fehlten sie bisher komplett — nur der
      // Website-Funnel und der WhatsApp-Bot stießen sie an. only_timing =
      // 'before_appointment' plant NUR die Vor-Termin-Erinnerungen, NICHT die
      // Sofort-Bestätigung (die verschickt dieser Dialog oben selbst als persönliche
      // Einladung). Bei einer Verschiebung erst die alten, noch offenen Erinnerungen
      // verwerfen, damit nichts doppelt rausgeht.
      if (selectedLeadId) {
        if (isEdit) {
          await supabase.from('scheduled_messages').update({ status: 'cancelled' })
            .eq('lead_id', selectedLeadId).eq('status', 'pending').eq('event_type', 'termin_gebucht')
        }
        void supabase.functions.invoke('schedule-message', {
          body: { lead_id: selectedLeadId, event_type: 'termin_gebucht', only_timing: 'before_appointment' },
        }).catch(e => console.warn('[AppointmentModal] Terminerinnerungen planen fehlgeschlagen:', e))
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

      // ── Einladungen (Mail im HP-Template + WhatsApp) an Lead + Teilnehmer ──
      // Kunden-Anzeige der Uhrzeit: Remote-Termine in KUNDENZEIT (Deutschland), vor-Ort
      // in Ortszeit (Zypern = Venue). start_time ist als UTC gespeichert (korrekt) — das
      // hier ist reine Anzeige-Umrechnung, damit der Kunde nicht 1h daneben liegt.
      const dispTz = apptType === 'inperson' ? 'Asia/Nicosia' : 'Europe/Berlin'
      const tzHint = apptType === 'inperson' ? '' : ' ' + t('crm.appt.germanTimeParen', '(deutsche Zeit)')
      const fmtHM = (iso: string) => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: dispTz }).format(new Date(iso))
      const vonDisp = fmtHM(start_time)
      const bisDisp = fmtHM(end_time)
      const dateStr = new Date(start_time).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: dispTz })
      const gcalDetails = [
        description,
        effZoomLink ? `Zoom: ${effZoomLink}${effZoomPassword ? ` (${t('crm.appt.passwordLabel', 'Passwort')}: ${effZoomPassword})` : ''}` : '',
        effLocationUrl || '',
      ].filter(Boolean).join('\n')
      const gcalHref = buildGcalHref(title, start_time, end_time, gcalDetails, effLocation || undefined)

      // Empfängerliste: verknüpfter Lead + weitere Teilnehmer (Partner)
      const mailTargets: Array<{ firstName: string; email: string; leadId?: string; pKey: string }> = []
      const waTargets: Array<{ firstName: string; fullName: string; phone: string; leadId?: string; pKey: string }> = []
      if ((sendEmailInvite || sendWhatsAppInvite) && selectedLeadId) {
        const { data: ld } = await supabase.from('leads').select('email, phone, whatsapp, first_name, last_name').eq('id', selectedLeadId).maybeSingle()
        const le = ld as { email?: string | null; phone?: string | null; whatsapp?: string | null; first_name?: string | null; last_name?: string | null } | null
        if (le?.email) mailTargets.push({ firstName: le.first_name || '', email: le.email, leadId: selectedLeadId, pKey: 'lead' })
        else if (sendEmailInvite) warnings.push(t('crm.appt.noLeadEmail', 'Lead hat keine E-Mail-Adresse — Einladung nicht gesendet.'))
        const waPhone = (le?.whatsapp || le?.phone || phoneNumber || '').trim()
        if (waPhone) waTargets.push({ firstName: le?.first_name || '', fullName: `${le?.first_name ?? ''} ${le?.last_name ?? ''}`.trim(), phone: waPhone, leadId: selectedLeadId, pKey: 'lead' })
        else if (sendWhatsAppInvite) warnings.push(t('crm.appt.noLeadPhone', 'Keine WhatsApp-Nummer vorhanden — Einladung nicht gesendet.'))
      }
      for (const a of attendees) {
        const first = a.name.split(' ')[0]
        // Dedupe: Lead kann auch als Geschäftskontakt erfasst sein — keine Doppel-Einladung
        const mailKey = (a.email ?? '').trim().toLowerCase()
        if (mailKey && !mailTargets.some(x => x.email.trim().toLowerCase() === mailKey)) {
          mailTargets.push({ firstName: first, email: a.email as string, pKey: `a:${a.name}` })
        }
        const phoneKey = (a.phone ?? '').replace(/\D/g, '')
        if (phoneKey && !waTargets.some(x => x.phone.replace(/\D/g, '') === phoneKey)) {
          waTargets.push({ firstName: first, fullName: a.name, phone: a.phone as string, pKey: `a:${a.name}` })
        }
      }

      // ── Beschreibung per KI je Empfänger personalisieren (Mail + WhatsApp) ──
      // Fallback bei KI-Fehler: Svens Rohtext für alle.
      let personalTexts: Record<string, string> = {}
      if (description.trim() && (sendEmailInvite || sendWhatsAppInvite) && (mailTargets.length || waTargets.length)) {
        const persons = new Map<string, { key: string; firstName: string; role: 'lead' | 'partner'; company?: string | null; language?: string | null }>()
        for (const tgt of [...mailTargets, ...waTargets]) {
          if (!persons.has(tgt.pKey)) {
            const att = attendees.find(x => `a:${x.name}` === tgt.pKey)
            persons.set(tgt.pKey, {
              key: tgt.pKey, firstName: tgt.firstName,
              role: tgt.pKey === 'lead' ? 'lead' : 'partner',
              company: att?.company ?? null, language: att?.language ?? null,
            })
          }
        }
        try {
          const { data: pd, error: pe } = await supabase.functions.invoke('personalize-invite', { body: {
            briefing: description,
            appointment: { title, dateStr, von: vonDisp, bis: bisDisp, type: apptType, location: effLocation || undefined },
            recipients: [...persons.values()],
          } })
          if (pe) throw new Error(pe.message)
          personalTexts = ((pd as { texts?: Record<string, string> } | null)?.texts) ?? {}
        } catch (perr) {
          console.warn('[AppointmentModal] personalize-invite fehlgeschlagen — nutze Rohtext:', perr)
        }
        // Fallback: Rohtext für alle ohne KI-Text
        for (const k of persons.keys()) if (!personalTexts[k]) personalTexts[k] = description.trim()
      }

      // Zu-/Absage-Links je Empfänger + Status am Termin initialisieren
      const rsvpHref = (pKey: string, a: 'yes' | 'no') => manageToken
        ? `https://portal.happy-property.com/zusage?t=${manageToken}&p=${encodeURIComponent(pKey)}&a=${a}`
        : ''
      if ((sendEmailInvite || sendWhatsAppInvite) && manageToken && (mailTargets.length || waTargets.length)) {
        try {
          const init: Record<string, { name: string; status: string }> = {}
          for (const tgt of [...mailTargets, ...waTargets]) {
            if (!init[tgt.pKey]) {
              const existing = (appointment?.rsvps ?? {})[tgt.pKey]
              // Terminänderung = neue Zusage nötig → zurück auf pending
              init[tgt.pKey] = { name: 'fullName' in tgt ? tgt.fullName : tgt.firstName, status: isEdit ? 'pending' : (existing?.status ?? 'pending') }
            }
          }
          const { error: re } = await supabase.from('crm_appointments')
            .update({ rsvps: { ...(appointment?.rsvps ?? {}), ...init } }).eq('id', apptId)
          if (re) console.warn('[AppointmentModal] rsvps-Init:', re.message)
        } catch (e) { console.warn('[AppointmentModal] rsvps-Init:', e) }
      }

      if (sendEmailInvite) {
        for (const tgt of mailTargets) {
          try {
            const html = buildInviteHtml({
              firstName: tgt.firstName, isEdit, title, dateStr, von: vonDisp, bis: bisDisp, apptType,
              zoomLink: effZoomLink || undefined, zoomPassword: effZoomPassword || undefined,
              location: effLocation || undefined, locationUrl: effLocationUrl || undefined,
              phone: tgt.leadId ? (effPhone || undefined) : undefined, gcalHref,
              isPrimary: !!tgt.leadId,
              personalNote: personalTexts[tgt.pKey],
              rsvpYesHref: rsvpHref(tgt.pKey, 'yes') || undefined,
              rsvpNoHref: rsvpHref(tgt.pKey, 'no') || undefined,
            })
            const icsDesc = [description, effZoomLink ? `Zoom: ${effZoomLink}${effZoomPassword ? ` (${t('crm.appt.passwordLabel', 'Passwort')}: ${effZoomPassword})` : ''}` : '', effLocationUrl || ''].filter(Boolean).join('\n')
            const ics = buildIcs({
              uid:        apptId || crypto.randomUUID(),
              title, startIso: start_time, endIso: end_time,
              description: icsDesc || undefined,
              location:    effLocation || undefined,
              // SEQUENCE steigt bei jeder Änderungs-Mail → Kalender-Clients ERSETZEN den Eintrag
              sequence:      isEdit ? Math.floor(Date.now() / 1000) : 0,
              attendeeEmail: tgt.email,
            })
            const { error: mailErr } = await supabase.functions.invoke('send-email', {
              body: {
                to: tgt.email,
                subject: `${isEdit ? t('crm.appt.mailSubjectEdit', 'Terminänderung') : t('crm.appt.mailSubjectNew', 'Terminbestätigung')}: ${title}`,
                html,
                ...(tgt.leadId ? { lead_id: tgt.leadId } : {}),
                attachment: {
                  filename:       'termin.ics',
                  content_base64: btoa(unescape(encodeURIComponent(ics))),
                  content_type:   'text/calendar',
                },
              },
            })
            if (mailErr) throw new Error(mailErr.message)
          } catch (mailErr) {
            console.warn('[AppointmentModal] Einladungs-Mail fehlgeschlagen:', mailErr)
            warnings.push(t('crm.appt.mailInviteFailedTo', 'E-Mail-Einladung an {{name}} konnte NICHT gesendet werden.', { name: tgt.firstName || tgt.email }))
          }
        }
      }

      if (sendWhatsAppInvite) {
        for (const tgt of waTargets) {
          try {
            const whereText = apptType === 'zoom' && effZoomLink
              ? `\nZoom-Link: ${effZoomLink}${effZoomPassword ? `\n${t('crm.appt.passwordLabel', 'Passwort')}: ${effZoomPassword}` : ''}`
              : apptType === 'inperson' && (effLocation || effLocationUrl)
                ? `\n📍 ${effLocation}${effLocationUrl ? `\n${effLocationUrl}` : ''}`
                : apptType === 'whatsapp'
                  ? (tgt.leadId
                      ? `\n📞 ${t('crm.appt.waCallReminderWa', 'Ich rufe dich zur vereinbarten Zeit per WhatsApp an — du musst nichts weiter tun.')}`
                      : `\n📞 ${t('crm.appt.waCallInfoWa', 'Der Termin findet als WhatsApp-Call statt.')}`)
                  : apptType === 'phone'
                    ? (tgt.leadId
                        ? `\n📞 ${t('crm.appt.waCallReminderPhone', 'Ich rufe dich zur vereinbarten Zeit an — du musst nichts weiter tun.')}`
                        : `\n📞 ${t('crm.appt.waCallInfoPhone', 'Der Termin findet telefonisch statt.')}`)
                    : ''
            const pNote = personalTexts[tgt.pKey] ? `\n\n${personalTexts[tgt.pKey]}` : ''
            // Lange URLs für WhatsApp kürzen (portal.../s/<code>)
            const yesRaw = rsvpHref(tgt.pKey, 'yes')
            const [yes, no, gcalShort] = await Promise.all([
              yesRaw ? shortenUrl(yesRaw) : Promise.resolve(''),
              yesRaw ? shortenUrl(rsvpHref(tgt.pKey, 'no')) : Promise.resolve(''),
              shortenUrl(gcalHref),
            ])
            const rsvpText = yes ? `\n\n✅ ${t('crm.appt.waRsvpAsk', 'Sagst du mir kurz zu? Ein Klick genügt:')}\n${yes}\n(${t('crm.appt.waRsvpNo', 'Falls es nicht passt: {{no}}', { no })})` : ''
            const waIntro = isEdit
              ? t('crm.appt.waIntroEdit', 'unser Termin hat sich geändert — hier die neuen Details')
              : t('crm.appt.waIntroNew', 'ich freue mich auf unser Treffen')
            const waText = `${t('crm.appt.waHello', 'Hallo {{name}}', { name: tgt.firstName })}, ${waIntro}:\n\n${title}\n${dateStr}, ${vonDisp}–${bisDisp} ${t('crm.appt.clock', 'Uhr')}${tzHint}${pNote}${whereText}${rsvpText}\n\n🗓 ${t('crm.appt.waSaveToCalendar', 'Termin in deinen Kalender speichern:')}\n${gcalShort}\n\n${t('crm.appt.waSignoff', 'Bis bald!\nSven · Happy Property')}`
            const { data: waData, error: waErr } = await supabase.functions.invoke('send-whatsapp', {
              body: {
                event_type:   'termin_einladung',   // reines Label fürs Activity-Log (override_text braucht kein Template)
                override_text: waText,
                lead_data:    { lead_name: tgt.fullName, lead_phone: tgt.phone },
                ...(tgt.leadId ? { lead_id: tgt.leadId } : {}),
              },
            })
            if (waErr) throw new Error(waErr.message)
            // send-whatsapp antwortet auch bei abgelehntem Versand mit 200 —
            // Erfolg steht NUR in results[].ok (bekanntes 200+error-Feld-Gotcha).
            const waResults = (waData as { results?: Array<{ ok?: boolean }> } | null)?.results
            if (Array.isArray(waResults) && waResults.length > 0 && !waResults.some(r => r.ok)) {
              throw new Error('Versand vom WhatsApp-Dienst abgelehnt')
            }
          } catch (waErr) {
            console.warn('[AppointmentModal] WhatsApp-Einladung fehlgeschlagen:', waErr)
            warnings.push(t('crm.appt.waInviteFailedTo', 'WhatsApp-Einladung an {{name}} konnte NICHT gesendet werden.', { name: tgt.firstName || tgt.phone }))
          }
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
                  {t('crm.appt.descriptionAi', 'Beschreibung / Briefing ✨')}
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-none"
                />
                <p className="text-xs text-gray-400 mt-1">{t('crm.appt.descriptionAiHint', 'Wird per KI für jeden Empfänger individuell formuliert — der Kunde liest, worum es für ihn geht, Partner bekommen ihren Part. Interna weglassen oder als solche markieren.')}</p>
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
                      {t('crm.appt.address', 'Ort / Restaurant')}
                    </label>
                    <input
                      type="text"
                      value={location}
                      onChange={e => handleLocationChange(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                      placeholder={t('crm.appt.addressPlaceholder', 'z. B. Bacchus Paphos, Neon Mall…')}
                    />
                    {placeLoading && <p className="text-xs text-gray-400 mt-1">{t('crm.appt.searching', 'Suche...')}</p>}
                    {placeResults.length > 0 && (
                      <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100 mt-1 max-h-48 overflow-y-auto bg-white shadow-sm">
                        {placeResults.map((pl, i) => (
                          <li key={`${pl.name}-${i}`}>
                            <button type="button" onClick={() => selectPlace(pl)}
                              className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors">
                              <span className="text-sm font-medium text-gray-800">📍 {pl.name}</span>
                              {pl.display && <span className="text-xs text-gray-400 ml-2">{pl.display}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
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

              {/* ── Weitere Teilnehmer (Partner/Geschäftskontakte) ── */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.appt.attendees', 'Weitere Teilnehmer (Partner)')}
                </label>
                {attendees.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {attendees.map(a => (
                      <span key={a.name}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-gray-100 text-gray-700">
                        {a.name}
                        <button type="button" onClick={() => removeAttendee(a.name)}
                          className="ml-1 text-xs opacity-70 hover:opacity-100">×</button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  type="text"
                  value={bcQuery}
                  onChange={e => handleBcSearchChange(e.target.value)}
                  onFocus={() => { void filterContacts(bcQuery) }}
                  placeholder={t('crm.appt.attendeesPlaceholder', 'Alle Partner & Developer-Kontakte — tippen filtert')}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40"
                />
                {bcLoading && <p className="text-xs text-gray-400 mt-1">{t('crm.appt.searching', 'Suche...')}</p>}
                {bcResults.length > 0 && (
                  <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100 mt-1 max-h-56 overflow-y-auto bg-white shadow-sm">
                    {bcResults.filter(c => !attendees.some(a => a.name === `${c.first_name} ${c.last_name ?? ''}`.trim())).map(c => (
                      <li key={c.id}>
                        <button type="button" onClick={() => addAttendee(c)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors">
                          <span className="text-sm font-medium text-gray-800">{c.first_name} {c.last_name ?? ''}</span>
                          <span className="text-xs text-gray-400 ml-2">{[c.company, c.email].filter(Boolean).join(' · ')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-gray-400 mt-2">
                  {t('crm.appt.attendeesHint', 'Teilnehmer bekommen die Einladung per E-Mail (und WhatsApp, falls Nummer hinterlegt).')}
                </p>
              </div>
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

              {/* Email invite checkbox (mit Kalender-Anhang) — Lead und/oder Teilnehmer */}
              {(selectedLeadId || leadId || attendees.length > 0) && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendEmailInvite}
                    onChange={e => setSendEmailInvite(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    {isEdit
                      ? t('crm.appt.sendEmailUpdateAll', 'Terminänderung per E-Mail senden — an Lead & Teilnehmer (mit Kalender-Anhang)')
                      : t('crm.appt.sendEmailInviteAll', 'Einladung per E-Mail senden — an Lead & Teilnehmer (mit Kalender-Anhang)')}
                  </span>
                </label>
              )}

              {/* WhatsApp invite checkbox */}
              {(selectedLeadId || leadId || attendees.length > 0) && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendWhatsAppInvite}
                    onChange={e => setSendWhatsAppInvite(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    {t('crm.appt.sendWhatsAppInviteAll', 'Einladung per WhatsApp senden — an Lead & Teilnehmer mit Nummer')}
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
