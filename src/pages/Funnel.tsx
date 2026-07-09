import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { DECK_LOGO, DECK_CONTACT } from '../lib/deckTypes'
import { OptionVisual } from '../components/FunnelIcon'
import {
  loadFunnelConfig, DEFAULT_FUNNEL_CONFIG, FUNNEL_HERO_DEFAULT,
  type FunnelQuestion, type FunnelOption,
} from '../lib/funnelConfig'

// ── Termin-Funnel (/termin) — ersetzt Typeform + Calendly ────────────────────
// Reihenfolge (Sven): Fragebogen → KONTAKTDATEN (Lead sofort sichern!) → Terminart
// → Slot-Picker → Danke-Seite (Kalender speichern + Tipps/Blog/YouTube).
// Bucht der Kunde KEINEN Termin, greift automatisch die Erstkontakt-Automation
// (Mail + Termin-Bot nach 20 Min — von funnel-api beim Kontakt-Schritt geplant,
// bei Buchung storniert). Slots: 12–20 Uhr Zypern-Zeit, 4 h Vorlauf, Anzeige in
// der Zeitzone des Kunden. Jeder Schritt trackt in funnel_events (Drop-off).

const CREAM = '#FAF6EC'
const CORAL = '#ff795d'
const NAVY = '#1a2332'
const INK = '#1a1a1a'


type Phase = 'welcome' | 'questions' | 'contact' | 'meeting_type' | 'slot' | 'done'

function useUtm(): Record<string, string> {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search)
    const utm: Record<string, string> = {}
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref']) {
      const v = p.get(k); if (v) utm[k] = v.slice(0, 120)
    }
    return utm
  }, [])
}

export default function Funnel() {
  const { t } = useTranslation()
  const utm = useUtm()
  const [cfg, setCfg] = useState(DEFAULT_FUNNEL_CONFIG)
  useEffect(() => { void loadFunnelConfig().then(setCfg) }, [])
  const QUESTIONS = cfg.questions
  const QUESTION_TEXT: Record<string, string> = Object.fromEntries(QUESTIONS.map(q => [q.key, q.title]))
  const HERO = cfg.welcome.hero_url || FUNNEL_HERO_DEFAULT
  const [phase, setPhase] = useState<Phase>('welcome')
  const [qIdx, setQIdx] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [meetingType, setMeetingType] = useState<'zoom' | 'whatsapp' | null>(null)
  const [slots, setSlots] = useState<string[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [dayKey, setDayKey] = useState<string>('')
  const [slot, setSlot] = useState<string>('')
  const [contact, setContact] = useState({ first_name: '', last_name: '', phone: '+49 ', email: '', website: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sessionRef = useRef<string | null>(null)
  const leadRef = useRef<string | null>(null)

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin', [])

  const track = useCallback(async (step: number, key: string, answer?: string) => {
    try {
      const { data } = await supabase.functions.invoke('funnel-api', { body: {
        action: 'track', session_id: sessionRef.current, step, question_key: key, answer,
        utm: sessionRef.current ? undefined : utm, referrer: sessionRef.current ? undefined : document.referrer?.slice(0, 300),
      } })
      const sid = (data as { session_id?: string } | null)?.session_id
      if (sid) sessionRef.current = sid
    } catch { /* Tracking darf den Funnel nie blockieren */ }
  }, [utm])

  useEffect(() => { void track(0, 'view') }, [track])

  const answerQuestion = (q: FunnelQuestion, opt: FunnelOption) => {
    setAnswers(prev => ({ ...prev, [q.key]: opt.label }))
    void track(qIdx + 1, q.key, opt.label)
    if (qIdx + 1 < QUESTIONS.length) setQIdx(qIdx + 1)
    else { setPhase('contact'); void track(QUESTIONS.length + 1, 'contact_view') }
  }

  const submitContact = async () => {
    setError('')
    const email = contact.email.trim()
    const phone = contact.phone.replace(/[^\d+]/g, '')
    if (!contact.first_name.trim()) { setError('Bitte gib deinen Vornamen an.'); return }
    if (!/^\S+@\S+\.\S+$/.test(email)) { setError('Bitte prüfe deine E-Mail-Adresse.'); return }
    if (phone.length < 8) { setError('Bitte prüfe deine Telefonnummer.'); return }
    setBusy(true)
    try {
      const { data, error: e } = await supabase.functions.invoke('funnel-api', { body: {
        action: 'contact', session_id: sessionRef.current,
        contact: { ...contact, email, phone },
        answers: Object.entries(answers).map(([k, v]) => ({ question: QUESTION_TEXT[k] ?? k, answer: v })),
        utm,
      } })
      if (e) throw new Error(e.message)
      leadRef.current = (data as { lead_id?: string } | null)?.lead_id ?? null
      void track(QUESTIONS.length + 1, 'contact_submitted')
      setPhase('meeting_type')
    } catch {
      setError('Das hat leider nicht geklappt. Bitte versuche es noch einmal.')
    } finally { setBusy(false) }
  }

  const chooseType = (typ: 'zoom' | 'whatsapp') => {
    setMeetingType(typ)
    void track(QUESTIONS.length + 2, 'meeting_type', typ)
    setPhase('slot')
    void loadSlots()
  }
  const loadSlots = async () => {
    setSlotsLoading(true)
    try {
      const { data } = await supabase.functions.invoke('funnel-api', { body: { action: 'slots' } })
      const s = ((data as { slots?: string[] } | null)?.slots) ?? []
      setSlots(s)
      if (s.length) setDayKey(new Date(s[0]).toLocaleDateString('de-DE', { timeZone: tz }))
      void track(QUESTIONS.length + 3, 'slots_view', String(s.length))
    } finally { setSlotsLoading(false) }
  }

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

  const bookSlot = async (s: string) => {
    setSlot(s); setError(''); setBusy(true)
    void track(QUESTIONS.length + 3, 'slot_picked', s)
    try {
      const { data, error: e } = await supabase.functions.invoke('funnel-api', { body: {
        action: 'book', session_id: sessionRef.current, lead_id: leadRef.current,
        slot_start_iso: s, meeting_type: meetingType,
      } })
      if (e) throw new Error(e.message)
      const d = data as { ok?: boolean; error?: string } | null
      if (d?.error === 'slot_taken' || d?.error === 'slot_invalid') {
        setError('Dieser Termin wurde gerade vergeben — bitte wähle einen anderen.')
        setSlot(''); void loadSlots(); return
      }
      if (!d?.ok) throw new Error(d?.error || 'Buchung fehlgeschlagen')
      setPhase('done')
    } catch {
      setError('Das hat leider nicht geklappt. Bitte versuche es noch einmal.')
    } finally { setBusy(false) }
  }

  const back = () => {
    if (phase === 'questions' && qIdx > 0) setQIdx(qIdx - 1)
    else if (phase === 'questions') setPhase('welcome')
    else if (phase === 'contact') { setPhase('questions'); setQIdx(QUESTIONS.length - 1) }
    else if (phase === 'meeting_type') setPhase('contact')
    else if (phase === 'slot') setPhase('meeting_type')
  }

  const totalSteps = QUESTIONS.length + 3
  const stepNow = phase === 'welcome' ? 0 : phase === 'questions' ? qIdx + 1 : phase === 'contact' ? QUESTIONS.length + 1 : phase === 'meeting_type' ? QUESTIONS.length + 2 : phase === 'slot' ? QUESTIONS.length + 3 : totalSteps
  // Clamp: die Config lädt asynchron nach — hat sie weniger Fragen als der
  // Default (oder als schon beantwortet), darf qIdx nie ins Leere zeigen.
  const q = QUESTIONS[Math.min(qIdx, QUESTIONS.length - 1)]

  const fmtSlot = (s: string) => new Date(s).toLocaleTimeString('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
  const fmtSlotFull = (s: string) => new Date(s).toLocaleString('de-DE', { timeZone: tz, weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })

  // „In Kalender speichern": Google-Link + ICS-Download (client-seitig erzeugt)
  const gcalUrl = useMemo(() => {
    if (!slot) return '#'
    const s = new Date(slot), e = new Date(s.getTime() + 30 * 60000)
    const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Beratungsgespräch mit Sven – Happy Property')}&dates=${f(s)}/${f(e)}&details=${encodeURIComponent(meetingType === 'zoom' ? 'Zoom-Link kommt per E-Mail & WhatsApp.' : 'Sven ruft dich per WhatsApp an.')}`
  }, [slot, meetingType])
  const downloadIcs = () => {
    const s = new Date(slot), e = new Date(s.getTime() + 30 * 60000)
    const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Happy Property//Termin//DE', 'BEGIN:VEVENT',
      `UID:${slot}@happy-property.com`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(s)}`, `DTEND:${f(e)}`,
      'SUMMARY:Beratungsgespräch mit Sven – Happy Property',
      `DESCRIPTION:${meetingType === 'zoom' ? 'Zoom-Link kommt per E-Mail & WhatsApp.' : 'Sven ruft dich per WhatsApp an.'}`,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
    a.download = 'termin-happy-property.ics'
    a.click()
  }

  const btn = 'w-full text-left px-5 py-3.5 rounded-xl border-2 bg-white text-[15px] font-medium transition hover:-translate-y-0.5 hover:shadow-md'

  return (
    <div className="min-h-screen font-body flex flex-col" style={{ background: CREAM, color: INK }}>
      <div className="h-1.5 w-full bg-black/5">
        <div className="h-full transition-all duration-500" style={{ width: `${(stepNow / totalSteps) * 100}%`, background: CORAL }} />
      </div>
      <div className="flex items-center justify-between px-5 md:px-10 py-4">
        <img src={DECK_LOGO} alt="Happy Property" className="h-8 md:h-9 w-auto" />
        {phase !== 'welcome' && phase !== 'done' && (
          <button onClick={back} className="text-sm text-gray-500 hover:text-gray-800">← {t('funnel.back', 'Zurück')}</button>
        )}
      </div>

      <div className="flex-1 flex items-center justify-center px-5 pb-10">
        <div className="w-full max-w-2xl">

          {phase === 'welcome' && (
            <div className="text-center">
              <img src={HERO} alt="Sven – Happy Property" className="w-full h-56 md:h-72 object-cover rounded-2xl shadow-lg mb-8" />
              <h1 className="font-heading font-bold text-3xl md:text-5xl leading-tight" style={{ color: NAVY }}>
                {cfg.welcome.title}
              </h1>
              <p className="mt-4 text-gray-600 text-[15px] md:text-base max-w-xl mx-auto">
                {cfg.welcome.subtitle}
              </p>
              <button onClick={() => { setPhase('questions'); void track(0, 'start') }}
                className="mt-8 px-10 py-4 rounded-full text-white font-semibold text-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition"
                style={{ background: CORAL }}>
                {cfg.welcome.cta}
              </button>
              <p className="mt-3 text-xs text-gray-400">{cfg.welcome.footnote}</p>
            </div>
          )}

          {phase === 'questions' && q && (
            <div>
              <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: CORAL }}>Frage {qIdx + 1} von {QUESTIONS.length}</p>
              <h2 className="font-heading font-bold text-2xl md:text-3xl leading-snug" style={{ color: NAVY }}>{q.title}</h2>
              {q.sub && <p className="mt-2 text-sm text-gray-500">{q.sub}</p>}
              {q.tiles ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-6">
                  {q.options.map(o => (
                    <button key={o.key} onClick={() => answerQuestion(q, o)}
                      className="rounded-xl border-2 bg-white shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition text-center px-3 py-5 flex flex-col items-center gap-3"
                      style={{ borderColor: answers[q.key] === o.label ? CORAL : '#e6dfd0' }}>
                      <OptionVisual icon={o.icon} emoji={o.emoji} image_url={o.image_url} />
                      <span className="text-[13px] font-semibold leading-snug" style={{ color: NAVY }}>{o.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-3 mt-6">
                  {q.options.map((o, i) => (
                    <button key={o.key} onClick={() => answerQuestion(q, o)} className={btn}
                      style={{ borderColor: answers[q.key] === o.label ? CORAL : '#e6dfd0' }}>
                      <span className="inline-flex w-6 h-6 mr-3 rounded-md border text-xs font-bold items-center justify-center align-middle"
                        style={{ borderColor: CORAL, color: CORAL }}>{String.fromCharCode(65 + i)}</span>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {phase === 'contact' && (
            <div>
              <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: CORAL }}>Fast geschafft</p>
              <h2 className="font-heading font-bold text-2xl md:text-3xl" style={{ color: NAVY }}>{cfg.contact.title}</h2>
              <p className="mt-1 text-sm text-gray-600">{cfg.contact.subtitle}</p>
              <div className="mt-6 space-y-4 bg-white rounded-2xl border border-[#e6dfd0] p-6 shadow-sm">
                <input type="text" tabIndex={-1} autoComplete="off" value={contact.website} onChange={e => setContact({ ...contact, website: e.target.value })} className="hidden" aria-hidden="true" />
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">Vorname *</label>
                    <input value={contact.first_name} onChange={e => setContact({ ...contact, first_name: e.target.value })}
                      className="w-full border-b-2 border-[#e6dfd0] focus:border-[#ff795d] outline-none py-2 text-[15px] bg-transparent" placeholder="Max" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">Nachname</label>
                    <input value={contact.last_name} onChange={e => setContact({ ...contact, last_name: e.target.value })}
                      className="w-full border-b-2 border-[#e6dfd0] focus:border-[#ff795d] outline-none py-2 text-[15px] bg-transparent" placeholder="Mustermann" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Telefonnummer (WhatsApp) *</label>
                  <input value={contact.phone} onChange={e => setContact({ ...contact, phone: e.target.value })} inputMode="tel"
                    className="w-full border-b-2 border-[#e6dfd0] focus:border-[#ff795d] outline-none py-2 text-[15px] bg-transparent" placeholder="+49 151 23456789" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">E-Mail-Adresse *</label>
                  <input value={contact.email} onChange={e => setContact({ ...contact, email: e.target.value })} inputMode="email"
                    className="w-full border-b-2 border-[#e6dfd0] focus:border-[#ff795d] outline-none py-2 text-[15px] bg-transparent" placeholder="name@beispiel.de" />
                </div>
                {error && <p className="text-sm font-medium text-red-600">{error}</p>}
                <button onClick={() => void submitContact()} disabled={busy}
                  className="w-full py-3.5 rounded-full text-white font-semibold text-lg shadow-md hover:shadow-lg transition disabled:opacity-50"
                  style={{ background: CORAL }}>
                  {busy ? 'Einen Moment…' : cfg.contact.cta}
                </button>
                <p className="text-[11px] text-gray-400 text-center">{cfg.contact.privacy}</p>
              </div>
            </div>
          )}

          {phase === 'meeting_type' && (
            <div>
              <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: CORAL }}>Dein Wunschtermin</p>
              <h2 className="font-heading font-bold text-2xl md:text-3xl" style={{ color: NAVY }}>Wie möchtest du mit Sven sprechen?</h2>
              <div className="grid md:grid-cols-2 gap-4 mt-6">
                <button onClick={() => chooseType('zoom')} className="rounded-2xl bg-white border-2 border-[#e6dfd0] hover:border-[#ff795d] p-6 text-left shadow-sm hover:shadow-lg transition">
                  <div className="text-3xl">📹</div>
                  <div className="font-heading font-bold text-xl mt-2" style={{ color: NAVY }}>Zoom-Call</div>
                  <p className="text-sm text-gray-500 mt-1">Mit Bildschirm — ideal, um Objekte und Zahlen gemeinsam anzusehen.</p>
                </button>
                <button onClick={() => chooseType('whatsapp')} className="rounded-2xl bg-white border-2 border-[#e6dfd0] hover:border-[#ff795d] p-6 text-left shadow-sm hover:shadow-lg transition">
                  <div className="text-3xl">💬</div>
                  <div className="font-heading font-bold text-xl mt-2" style={{ color: NAVY }}>WhatsApp-Call</div>
                  <p className="text-sm text-gray-500 mt-1">Unkompliziert übers Handy — Sven ruft dich per WhatsApp an.</p>
                </button>
              </div>
            </div>
          )}

          {phase === 'slot' && (
            <div>
              <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: CORAL }}>Letzter Schritt</p>
              <h2 className="font-heading font-bold text-2xl md:text-3xl" style={{ color: NAVY }}>Wann passt es dir?</h2>
              <p className="mt-1 text-sm text-gray-500">Alle Zeiten in deiner Zeitzone ({tz.replace('_', ' ')}). Ein Klick bucht den Termin verbindlich.</p>
              {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
              {slotsLoading || busy ? (
                <div className="mt-10 flex justify-center"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
              ) : (
                <>
                  <div className="flex gap-2 mt-5 overflow-x-auto pb-2">
                    {Array.from(days.entries()).map(([key, d]) => (
                      <button key={key} onClick={() => setDayKey(key)}
                        className="px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap border-2 transition"
                        style={dayKey === key ? { background: NAVY, color: '#fff', borderColor: NAVY } : { background: '#fff', color: NAVY, borderColor: '#e6dfd0' }}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 md:grid-cols-4 gap-2.5 mt-4">
                    {(days.get(dayKey)?.slots ?? []).map(s => (
                      <button key={s} onClick={() => void bookSlot(s)}
                        className="px-3 py-2.5 rounded-xl bg-white border-2 border-[#e6dfd0] hover:border-[#ff795d] text-sm font-semibold transition"
                        style={{ color: NAVY }}>
                        {fmtSlot(s)}
                      </button>
                    ))}
                  </div>
                  {!slots.length && <p className="mt-6 text-sm text-gray-500">Gerade sind keine freien Termine verfügbar — Sven meldet sich in Kürze persönlich bei dir!</p>}
                </>
              )}
            </div>
          )}

          {phase === 'done' && (
            <div className="text-center">
              <div className="text-6xl">🎉</div>
              <h2 className="font-heading font-bold text-3xl md:text-4xl mt-4" style={{ color: NAVY }}>{cfg.done.title}</h2>
              <p className="mt-3 text-gray-600 text-[15px]">
                <strong>{fmtSlotFull(slot)} Uhr</strong> · {meetingType === 'zoom' ? '📹 Zoom' : '💬 WhatsApp-Call'}
              </p>
              <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
                Die Bestätigung {meetingType === 'zoom' ? 'mit deinem Zoom-Link ' : ''}ist per E-Mail und WhatsApp unterwegs — inklusive Kalender-Datei.
              </p>
              <div className="flex flex-wrap justify-center gap-3 mt-6">
                <a href={gcalUrl} target="_blank" rel="noreferrer"
                  className="px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow hover:shadow-md transition" style={{ background: NAVY }}>
                  📅 In Google Kalender
                </a>
                <button onClick={downloadIcs}
                  className="px-5 py-2.5 rounded-full text-sm font-semibold bg-white border-2 shadow-sm hover:shadow-md transition" style={{ borderColor: NAVY, color: NAVY }}>
                  📥 Kalender-Datei (Apple/Outlook)
                </button>
              </div>
              <a href={cfg.done.thanks_url}
                className="mt-8 inline-block px-8 py-3.5 rounded-full text-white font-semibold shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition" style={{ background: CORAL }}>
                Bis dahin: Tipps, Blog & Videos →
              </a>
              {/* Soziale Kanäle — gleiche Quelle wie die Sales-Decks (DECK_CONTACT) */}
              <div className="flex flex-wrap justify-center gap-2 mt-6">
                {[
                  ...DECK_CONTACT.socials.map(s => ({
                    icon: s.icon, label: s.platform,
                    url: s.platform === 'YouTube' ? (cfg.done.youtube_url || s.url) : s.url,
                  })),
                  { icon: '✍', label: 'Blog', url: 'https://steuervorteil-zypern-immobilien.com/blog/' },
                ].map(s => (
                  <a key={s.label} href={s.url} target="_blank" rel="noreferrer"
                    className="flex items-center gap-2 pl-1.5 pr-4 py-1.5 rounded-full bg-white border-2 border-[#e6dfd0] hover:border-[#ff795d] hover:-translate-y-0.5 transition text-[13px] font-semibold shadow-sm"
                    style={{ color: NAVY }}>
                    <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0" style={{ background: CORAL }}>{s.icon}</span>
                    {s.label}
                  </a>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
      <div className="text-center text-[11px] text-gray-400 pb-5">© Happy Property · Paphos, Zypern</div>
    </div>
  )
}
