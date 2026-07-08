import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { FUNNEL_HERO, FUNNEL_TILES } from '../lib/funnelImages'

// ── Termin-Funnel (/termin) — ersetzt Typeform + Calendly ────────────────────
// Öffentliche Seite: Qualifizierungs-Fragebogen (eine Frage pro Screen, Typeform-
// Stil im HP-CI) → Terminart (Zoom/WhatsApp) → Slot-Picker (freie Zeiten live aus
// dem Kalender, 12–20 Uhr Zypern-Zeit, 4 h Vorlauf, Anzeige in der Zeitzone des
// Kunden) → Kontaktdaten → Buchung. Jeder Schritt trackt in funnel_events
// (Drop-off-Analyse). Buchung läuft über die funnel-api Edge Function.

const CREAM = '#FAF6EC'
const CORAL = '#ff795d'
const NAVY = '#1a2332'
const INK = '#1a1a1a'

interface Option { key: string; label: string; image?: string }
interface Question { key: string; title: string; sub?: string; options: Option[]; tiles?: boolean }

const QUESTIONS: Question[] = [
  {
    key: 'erfahrung',
    title: 'Hast du bereits Erfahrung mit Immobilieninvestitionen?',
    sub: 'Fülle den kurzen Fragebogen aus & buche dir anschließend dein kostenloses Beratungsgespräch mit Sven. Dauer: 1 Minute.',
    options: [
      { key: 'keine', label: 'Keine Erfahrung' },
      { key: 'wenig', label: 'Wenig Erfahrung (1–2 Investitionen)' },
      { key: 'erfahren', label: 'Erfahren (3+ Projekte oder Immobilien)' },
    ],
  },
  {
    key: 'motiv',
    title: 'Warum interessierst du dich für eine Immobilie in Zypern?',
    tiles: true,
    options: [
      { key: 'steuern', label: 'Steuerliche Vorteile', image: FUNNEL_TILES.steuern },
      { key: 'kapital', label: 'Kapitalanlage', image: FUNNEL_TILES.kapital },
      { key: 'auswandern', label: 'Auswandern & Lebensqualität', image: FUNNEL_TILES.auswandern },
      { key: 'langfristig', label: 'Langfristige Immobilien-Investition', image: FUNNEL_TILES.langfristig },
      { key: 'unsicher', label: 'Noch nicht sicher', image: FUNNEL_TILES.unsicher },
    ],
  },
  {
    key: 'timing',
    title: 'Wann planst du den Kauf?',
    options: [
      { key: 'asap', label: 'So schnell wie möglich' },
      { key: '3-6m', label: 'In 3–6 Monaten' },
      { key: 'spaeter', label: 'Später' },
    ],
  },
  {
    key: 'kapitalbasis',
    title: 'Besitzt du eine abbezahlte Immobilie in Deutschland, 100.000 € Eigenkapital oder Portfolios/Sachwerte in vergleichbarer Höhe?',
    options: [
      { key: 'ja', label: 'Ja' },
      { key: 'nein', label: 'Nein' },
    ],
  },
  {
    key: 'beschaeftigung',
    title: 'Was ist dein Beschäftigungsverhältnis?',
    options: [
      { key: 'angestellt', label: 'Angestellter' },
      { key: 'privatier', label: 'Privatier' },
      { key: 'selbststaendig', label: 'Selbstständig' },
      { key: 'andere', label: 'Andere' },
    ],
  },
  {
    key: 'alter',
    title: 'Wie alt bist du?',
    options: [
      { key: 'u30', label: 'Unter 30' },
      { key: '30-45', label: '30–45 Jahre' },
      { key: 'ue45', label: 'Über 45 Jahre' },
    ],
  },
]

const QUESTION_TEXT: Record<string, string> = Object.fromEntries(QUESTIONS.map(q => [q.key, q.title]))

type Phase = 'welcome' | 'questions' | 'meeting_type' | 'slot' | 'contact' | 'done'

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

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin', [])

  const track = useCallback(async (step: number, key: string, answer?: string) => {
    try {
      const { data } = await supabase.functions.invoke('funnel-api', { body: {
        action: 'track', session_id: sessionRef.current, step, question_key: key, answer,
        utm: sessionRef.current ? undefined : utm, referrer: sessionRef.current ? undefined : document.referrer?.slice(0, 300),
      } })
      const sid = (data as { session_id?: string } | null)?.session_id
      if (sid) sessionRef.current = sid
    } catch { /* Tracking darf nie den Funnel blockieren */ }
  }, [utm])

  useEffect(() => { void track(0, 'view') }, [track])

  const startQuestions = () => { setPhase('questions'); void track(0, 'start') }

  const answerQuestion = (q: Question, opt: Option) => {
    setAnswers(prev => ({ ...prev, [q.key]: opt.label }))
    void track(qIdx + 1, q.key, opt.label)
    if (qIdx + 1 < QUESTIONS.length) setQIdx(qIdx + 1)
    else { setPhase('meeting_type'); void track(QUESTIONS.length + 1, 'meeting_type_view') }
  }

  const chooseType = (typ: 'zoom' | 'whatsapp') => {
    setMeetingType(typ)
    void track(QUESTIONS.length + 1, 'meeting_type', typ)
    setPhase('slot')
    setSlotsLoading(true)
    supabase.functions.invoke('funnel-api', { body: { action: 'slots' } }).then(({ data }) => {
      const s = ((data as { slots?: string[] } | null)?.slots) ?? []
      setSlots(s)
      if (s.length) setDayKey(new Date(s[0]).toLocaleDateString('de-DE', { timeZone: tz }))
      setSlotsLoading(false)
      void track(QUESTIONS.length + 2, 'slots_view', String(s.length))
    }).catch(() => setSlotsLoading(false))
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

  const pickSlot = (s: string) => {
    setSlot(s)
    void track(QUESTIONS.length + 2, 'slot_picked', s)
    setPhase('contact')
  }

  const submit = async () => {
    setError('')
    const email = contact.email.trim()
    const phone = contact.phone.replace(/[^\d+]/g, '')
    if (!contact.first_name.trim()) { setError('Bitte gib deinen Vornamen an.'); return }
    if (!/^\S+@\S+\.\S+$/.test(email)) { setError('Bitte prüfe deine E-Mail-Adresse.'); return }
    if (phone.length < 8) { setError('Bitte prüfe deine Telefonnummer.'); return }
    setBusy(true)
    try {
      const { data, error: e } = await supabase.functions.invoke('funnel-api', { body: {
        action: 'book', session_id: sessionRef.current, slot_start_iso: slot, meeting_type: meetingType,
        contact: { ...contact, email, phone },
        answers: Object.entries(answers).map(([k, v]) => ({ question: QUESTION_TEXT[k] ?? k, answer: v })),
        utm,
      } })
      if (e) throw new Error(e.message)
      const d = data as { ok?: boolean; error?: string } | null
      if (d?.error === 'slot_taken' || d?.error === 'slot_invalid') {
        setError('Dieser Termin wurde gerade vergeben — bitte wähle einen anderen.')
        setPhase('slot'); setSlot(''); setBusy(false)
        void chooseTypeRefresh()
        return
      }
      if (!d?.ok) throw new Error(d?.error || 'Buchung fehlgeschlagen')
      setPhase('done')
    } catch {
      setError('Das hat leider nicht geklappt. Bitte versuche es noch einmal.')
    } finally { setBusy(false) }
  }
  const chooseTypeRefresh = async () => {
    const { data } = await supabase.functions.invoke('funnel-api', { body: { action: 'slots' } })
    setSlots(((data as { slots?: string[] } | null)?.slots) ?? [])
  }

  const back = () => {
    if (phase === 'questions' && qIdx > 0) setQIdx(qIdx - 1)
    else if (phase === 'questions') setPhase('welcome')
    else if (phase === 'meeting_type') { setPhase('questions'); setQIdx(QUESTIONS.length - 1) }
    else if (phase === 'slot') setPhase('meeting_type')
    else if (phase === 'contact') setPhase('slot')
  }

  const totalSteps = QUESTIONS.length + 3
  const stepNow = phase === 'welcome' ? 0 : phase === 'questions' ? qIdx + 1 : phase === 'meeting_type' ? QUESTIONS.length + 1 : phase === 'slot' ? QUESTIONS.length + 2 : totalSteps
  const q = QUESTIONS[qIdx]

  const fmtSlot = (s: string) => new Date(s).toLocaleTimeString('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
  const fmtSlotFull = (s: string) => new Date(s).toLocaleString('de-DE', { timeZone: tz, weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })

  const btn = 'w-full text-left px-5 py-3.5 rounded-xl border-2 bg-white text-[15px] font-medium transition hover:-translate-y-0.5 hover:shadow-md'

  return (
    <div className="min-h-screen font-body flex flex-col" style={{ background: CREAM, color: INK }}>
      {/* Fortschritt */}
      <div className="h-1.5 w-full bg-black/5">
        <div className="h-full transition-all duration-500" style={{ width: `${(stepNow / totalSteps) * 100}%`, background: CORAL }} />
      </div>
      <div className="flex items-center justify-between px-5 md:px-10 py-4">
        <span className="font-heading font-bold text-lg" style={{ color: NAVY }}>Happy Property <span style={{ color: CORAL }}>·</span> Zypern</span>
        {phase !== 'welcome' && phase !== 'done' && (
          <button onClick={back} className="text-sm text-gray-500 hover:text-gray-800">← {t('funnel.back', 'Zurück')}</button>
        )}
      </div>

      <div className="flex-1 flex items-center justify-center px-5 pb-10">
        <div className="w-full max-w-2xl">

          {phase === 'welcome' && (
            <div className="text-center">
              <img src={FUNNEL_HERO} alt="Zypern" className="w-full h-56 md:h-72 object-cover rounded-2xl shadow-lg mb-8" />
              <h1 className="font-heading font-bold text-3xl md:text-5xl leading-tight" style={{ color: NAVY }}>
                Dein kostenloses Beratungsgespräch mit Sven
              </h1>
              <p className="mt-4 text-gray-600 text-[15px] md:text-base max-w-xl mx-auto">
                Beantworte 6 kurze Fragen und such dir direkt deinen Wunschtermin aus — per Zoom oder WhatsApp-Call. Dauer: 1 Minute.
              </p>
              <button onClick={startQuestions}
                className="mt-8 px-10 py-4 rounded-full text-white font-semibold text-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition"
                style={{ background: CORAL }}>
                Los geht's →
              </button>
              <p className="mt-3 text-xs text-gray-400">Kostenlos & unverbindlich · ca. 15–30 Minuten Gespräch</p>
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
                      className="rounded-xl overflow-hidden border-2 border-transparent bg-white shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition text-left"
                      style={{ borderColor: answers[q.key] === o.label ? CORAL : 'transparent' }}>
                      {o.image && <img src={o.image} alt="" className="w-full h-24 md:h-28 object-cover" />}
                      <div className="px-3 py-2.5 text-[13px] font-semibold" style={{ color: NAVY }}>{o.label}</div>
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

          {phase === 'meeting_type' && (
            <div>
              <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: CORAL }}>Fast geschafft</p>
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
              <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: CORAL }}>Dein Wunschtermin</p>
              <h2 className="font-heading font-bold text-2xl md:text-3xl" style={{ color: NAVY }}>Wann passt es dir?</h2>
              <p className="mt-1 text-sm text-gray-500">Alle Zeiten in deiner Zeitzone ({tz.replace('_', ' ')}).</p>
              {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
              {slotsLoading ? (
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
                      <button key={s} onClick={() => pickSlot(s)}
                        className="px-3 py-2.5 rounded-xl bg-white border-2 border-[#e6dfd0] hover:border-[#ff795d] text-sm font-semibold transition"
                        style={{ color: NAVY }}>
                        {fmtSlot(s)}
                      </button>
                    ))}
                  </div>
                  {!slots.length && <p className="mt-6 text-sm text-gray-500">Gerade sind keine freien Termine verfügbar — bitte schau später noch einmal vorbei.</p>}
                </>
              )}
            </div>
          )}

          {phase === 'contact' && (
            <div>
              <p className="text-xs font-bold tracking-widest uppercase mb-2" style={{ color: CORAL }}>Letzter Schritt</p>
              <h2 className="font-heading font-bold text-2xl md:text-3xl" style={{ color: NAVY }}>Wie dürfen wir dich erreichen?</h2>
              <p className="mt-1 text-sm text-gray-600">
                Dein Termin: <strong>{fmtSlotFull(slot)} Uhr</strong> · {meetingType === 'zoom' ? '📹 Zoom' : '💬 WhatsApp-Call'}
              </p>
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
                <button onClick={() => void submit()} disabled={busy}
                  className="w-full py-3.5 rounded-full text-white font-semibold text-lg shadow-md hover:shadow-lg transition disabled:opacity-50"
                  style={{ background: CORAL }}>
                  {busy ? 'Wird gebucht…' : 'Termin verbindlich buchen ✓'}
                </button>
                <p className="text-[11px] text-gray-400 text-center">
                  Mit dem Absenden stimmst du zu, dass wir dich zur Terminabstimmung per E-Mail und WhatsApp kontaktieren. Kostenlos & unverbindlich.
                </p>
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="text-center">
              <div className="text-6xl">🎉</div>
              <h2 className="font-heading font-bold text-3xl md:text-4xl mt-4" style={{ color: NAVY }}>Dein Termin steht!</h2>
              <p className="mt-3 text-gray-600 text-[15px]">
                <strong>{fmtSlotFull(slot)} Uhr</strong> · {meetingType === 'zoom' ? '📹 Zoom' : '💬 WhatsApp-Call'}
              </p>
              <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
                Die Bestätigung mit allen Details {meetingType === 'zoom' ? 'und deinem Zoom-Link ' : ''}ist per E-Mail und WhatsApp unterwegs. Sven freut sich auf dich!
              </p>
              <img src={FUNNEL_HERO} alt="" className="w-full h-48 object-cover rounded-2xl shadow mt-8" />
            </div>
          )}

        </div>
      </div>
      <div className="text-center text-[11px] text-gray-400 pb-5">© Happy Property · Paphos, Zypern</div>
    </div>
  )
}
