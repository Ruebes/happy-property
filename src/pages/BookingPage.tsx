import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Öffentlicher persönlicher Buchungslink (z.B. /buchen/sven360) ────────────
// Betreff + Dauer + Art (Vor Ort mit Adress-Autocomplete / WhatsApp / Zoom) +
// Kontaktdaten → Termin in Svens Kalender, Bestätigung per Mail (.ics) + WhatsApp.
// Optional: ?g=<token> lädt eine Einladung (vorbelegte Kontaktdaten + Bild + Sprache).
// Komplett DE/EN umschaltbar.
const CORAL = '#ff795d', AMBER = '#f59e0b'
type Type = 'onsite' | 'whatsapp' | 'zoom'
type Lang = 'de' | 'en'
interface Day { date: string; times: { iso: string; label: string; preferred: boolean }[] }
interface Guest { name: string | null; email: string | null; phone: string | null; subject: string | null }

const call = async (body: Record<string, unknown>) => {
  const { data, error } = await supabase.functions.invoke('personal-booking', { body })
  if (error || data?.error) throw new Error(data?.error || 'Fehler')
  return data
}

// ── Übersetzungen ────────────────────────────────────────────────────────────
const STR = {
  de: {
    brand: 'Happy Property', notFound: 'Dieser Buchungslink ist nicht verfügbar.',
    subjectLbl: "Worum geht's? (Betreff)", subjectPh: 'z. B. Kennenlernen, Beratung, Essen …',
    durationLbl: 'Dauer', dur: { 30: '30 Min', 60: '1 Std', 90: '1,5 Std', 120: '2 Std', 180: '3 Std' } as Record<number, string>,
    typeLbl: 'Wie treffen wir uns?', whatsapp: 'WhatsApp', zoom: 'Zoom', onsite: 'Vor Ort',
    addrPh: 'Adresse eingeben (Vorschläge ab 3 Buchstaben) …',
    whenLbl: 'Wann passt es dir?', noSlots: 'Für diese Dauer sind gerade keine Zeiten frei.',
    ungern: 'ungern', hint: 'gelb = eher ungünstig, geht aber im Notfall.',
    contactHdr: 'Deine Daten', namePh: 'Dein Name', emailPh: 'E-Mail (für Bestätigung + Kalender)', phonePh: 'Telefon / WhatsApp',
    prefilled: 'bereits ausgefüllt', book: 'Termin buchen',
    errSubject: 'Bitte einen Betreff angeben.', errTime: 'Bitte einen Zeitpunkt wählen.',
    errAddr: 'Bitte eine Adresse angeben.', errName: 'Bitte deinen Namen angeben.',
    errContact: 'Bitte E-Mail oder Telefon angeben.', errFail: 'Buchung fehlgeschlagen.',
    doneTitle: 'Termin gebucht!', zoomLink: 'Zoom-Link',
    greet: (n: string) => `Hallo ${n} 👋`, greetSub: 'Such dir einfach einen passenden Zeitpunkt aus.',
    confirm: (m: boolean, w: boolean) => `Du bekommst gleich eine Bestätigung${m ? ' per E-Mail (mit Kalender-Datei)' : ''}${m && w ? ' und' : ''}${w ? ' per WhatsApp' : ''}. Bis bald!`,
    locale: 'de-DE',
  },
  en: {
    brand: 'Happy Property', notFound: 'This booking link is not available.',
    subjectLbl: "What's it about? (Subject)", subjectPh: 'e.g. Intro call, consultation, dinner …',
    durationLbl: 'Duration', dur: { 30: '30 min', 60: '1 hr', 90: '1.5 hrs', 120: '2 hrs', 180: '3 hrs' } as Record<number, string>,
    typeLbl: 'How shall we meet?', whatsapp: 'WhatsApp', zoom: 'Zoom', onsite: 'In person',
    addrPh: 'Enter an address (suggestions from 3 letters) …',
    whenLbl: 'When suits you?', noSlots: 'No times are free for this duration right now.',
    ungern: 'not ideal', hint: 'amber = less convenient, but possible if needed.',
    contactHdr: 'Your details', namePh: 'Your name', emailPh: 'Email (for confirmation + calendar)', phonePh: 'Phone / WhatsApp',
    prefilled: 'already filled in', book: 'Book appointment',
    errSubject: 'Please enter a subject.', errTime: 'Please pick a time.',
    errAddr: 'Please enter an address.', errName: 'Please enter your name.',
    errContact: 'Please enter email or phone.', errFail: 'Booking failed.',
    doneTitle: 'Appointment booked!', zoomLink: 'Zoom link',
    greet: (n: string) => `Hi ${n} 👋`, greetSub: 'Just pick a time that works for you.',
    confirm: (m: boolean, w: boolean) => `You'll get a confirmation shortly${m ? ' by email (with calendar file)' : ''}${m && w ? ' and' : ''}${w ? ' by WhatsApp' : ''}. See you soon!`,
    locale: 'en-GB',
  },
} satisfies Record<Lang, unknown>

const DUR_VALUES = [30, 60, 90, 120, 180]

export default function BookingPage() {
  const { slug } = useParams<{ slug: string }>()
  const [sp] = useSearchParams()
  const invite = sp.get('g') || undefined

  const [lang, setLang] = useState<Lang>('de')
  const [title, setTitle] = useState('Termin'); const [owner, setOwner] = useState('')
  const [image, setImage] = useState<string | null>(null); const [guest, setGuest] = useState<Guest | null>(null)
  // Bildausschnitt des Kopfbilds, je Einladung gepflegt (CSS object-position).
  // Ein fester Wert reicht nicht: Bei Gionas Portrait liegt das Gesicht oben,
  // bei Burkhards Selfie vor Mito Infinity in der unteren Bildhaelfte.
  const [imageFocus, setImageFocus] = useState('center 25%')
  const [notFound, setNotFound] = useState(false)
  const [subject, setSubject] = useState(''); const [duration, setDuration] = useState(30)
  const [type, setType] = useState<Type>('whatsapp')
  const [address, setAddress] = useState(''); const [suggests, setSuggests] = useState<string[]>([])
  const [days, setDays] = useState<Day[]>([]); const [loadingSlots, setLoadingSlots] = useState(true)
  const [dayIdx, setDayIdx] = useState(0); const [pick, setPick] = useState<string | null>(null)
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState<null | { dateStr: string; typeLabel: string; zoomLink: string | null }>(null)

  const T = STR[lang]

  // Config + evtl. Einladung laden
  useEffect(() => {
    call({ action: 'config', slug, invite }).then(d => {
      setTitle(d.title); setOwner(d.owner)
      if (d.image_url) setImage(d.image_url)
      if (d.image_focus) setImageFocus(String(d.image_focus))
      if (d.lang === 'de' || d.lang === 'en') setLang(d.lang)
      if (d.guest) {
        const g = d.guest as Guest; setGuest(g)
        if (g.name) setName(g.name)
        if (g.email) setEmail(g.email)
        if (g.phone) setPhone(g.phone)
        if (g.subject) setSubject(g.subject)
      }
    }).catch(() => setNotFound(true))
  }, [slug, invite])

  const loadSlots = useCallback(async (dur: number) => {
    setLoadingSlots(true); setPick(null)
    try { const d = await call({ action: 'slots', slug, invite, duration: dur }); setDays(d.days ?? []); setDayIdx(0) }
    catch { setDays([]) } finally { setLoadingSlots(false) }
  }, [slug, invite])
  useEffect(() => { loadSlots(duration) }, [duration, loadSlots])

  // Adress-Autocomplete (debounced)
  const tRef = useRef<number | undefined>(undefined)
  const onAddr = (v: string) => {
    setAddress(v); window.clearTimeout(tRef.current)
    if (v.trim().length < 3) { setSuggests([]); return }
    tRef.current = window.setTimeout(async () => {
      try { const d = await call({ action: 'places', q: v }); setSuggests(d.predictions ?? []) } catch { setSuggests([]) }
    }, 300)
  }

  const dayLabel = (dateStr: string) => {
    try { return new Date(`${dateStr}T12:00:00`).toLocaleDateString(T.locale, { weekday: 'long', day: '2-digit', month: 'long' }) }
    catch { return dateStr }
  }

  const book = async () => {
    setErr('')
    if (!subject.trim()) return setErr(T.errSubject)
    if (!pick) return setErr(T.errTime)
    if (type === 'onsite' && !address.trim()) return setErr(T.errAddr)
    if (!name.trim()) return setErr(T.errName)
    if (!email.trim() && !phone.trim()) return setErr(T.errContact)
    setBusy(true)
    try {
      const d = await call({ action: 'book', slug, invite, lang, startIso: pick, duration, subject: subject.trim(), type, address: address.trim() || undefined, name: name.trim(), email: email.trim() || undefined, phone: phone.trim() || undefined })
      setDone({ dateStr: d.dateStr, typeLabel: d.typeLabel, zoomLink: d.zoomLink })
    } catch (e) { setErr(e instanceof Error ? e.message : T.errFail) } finally { setBusy(false) }
  }

  const input = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-400'
  const day = days[dayIdx]
  const pageStyle = image
    // Abdunkelung bewusst moderat (.28/.42 statt vorher .62/.72): Der dunkle Schleier
    // soll nur den Kartenrand absetzen. Bei kontrastarmen Motiven — etwa einem weich
    // ausgeleuchteten Porträt — wurde das Bild bei .62+ zu einer grauen Fläche und war
    // nicht mehr erkennbar. Die Lesbarkeit hängt ohnehin an der Karte selbst (weiss,
    // milchig), nicht am Hintergrund.
    ? { backgroundImage: `linear-gradient(rgba(20,12,8,.28),rgba(20,12,8,.42)), url(${image})`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: 'fixed' as const }
    : { background: 'linear-gradient(160deg,#fff5f2,#faf7f4)' }
  const cardCls = image
    // bg-white/95, NICHT /92: Tailwind kennt nur seine Opacity-Stufen (…/90, /95, /100).
    // Ein Zwischenwert wie /92 erzeugt keine Klasse — die Karte hatte dadurch gar keinen
    // Hintergrund, das Formular stand direkt auf dem Foto.
    ? 'w-full max-w-md mx-auto bg-white/95 backdrop-blur-md rounded-3xl shadow-2xl border border-white/40 overflow-hidden'
    : 'w-full max-w-md mx-auto bg-white rounded-3xl shadow-xl border border-gray-100 overflow-hidden'

  const LangToggle = (
    <div className="flex gap-1 text-[11px] font-semibold">
      {(['de', 'en'] as Lang[]).map(l => (
        <button key={l} onClick={() => setLang(l)}
          className={`px-2 py-0.5 rounded-md transition ${lang === l ? 'bg-white text-gray-900' : 'bg-white/20 text-white'}`}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )

  return (
    <div className="min-h-screen py-6 px-4" style={pageStyle}>
      <div className={cardCls}>
        {/* Kopfbild. Der Vollflächen-Hintergrund allein reicht nicht: Auf dem Handy
            füllt die Karte die ganze Breite, auf dem Desktop bleiben nur schmale
            Streifen neben der Karte sichtbar — bei einem Portrait also genau der
            Rand, nicht die Person. Hier ist das Motiv auf jedem Gerät zu sehen.
            Der Anschnitt liegt bewusst im oberen Drittel (Gesichtshöhe). */}
        {image && (
          <img src={image} alt={guest?.name ?? owner ?? ''}
            className="w-full h-56 object-cover" style={{ objectPosition: imageFocus }} />
        )}
        <div className="px-6 py-5 relative" style={{ backgroundColor: CORAL }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-white/80 text-xs font-semibold tracking-wide uppercase">{T.brand}</p>
              <h1 className="text-white text-lg font-bold mt-0.5">{title}{owner ? ` · ${owner}` : ''}</h1>
            </div>
            {LangToggle}
          </div>
        </div>

        {notFound ? (
          <div className="p-8 text-center text-sm text-gray-500">{T.notFound}</div>
        ) : done ? (
          <div className="p-6 text-center space-y-3">
            <p className="text-3xl">🎉</p>
            <p className="text-base font-semibold text-gray-900">{T.doneTitle}</p>
            <div className="bg-green-50 border border-green-100 rounded-2xl p-4 text-sm text-gray-700">
              <p className="font-medium">{subject}</p>
              <p className="mt-1">📅 {done.dateStr}</p>
              <p className="mt-0.5">📍 {done.typeLabel}</p>
              {done.zoomLink && <p className="mt-1"><a href={done.zoomLink} className="text-orange-600 underline">{T.zoomLink}</a></p>}
            </div>
            <p className="text-xs text-gray-500">{T.confirm(!!email, !!phone)}</p>
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {guest && (
              <div className="rounded-2xl bg-orange-50 border border-orange-100 px-4 py-3">
                <p className="text-sm font-semibold text-gray-900">{T.greet((guest.name || '').split(' ')[0] || guest.name || '')}</p>
                <p className="text-xs text-gray-600 mt-0.5">{T.greetSub}</p>
              </div>
            )}
            {/* Betreff */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{T.subjectLbl}</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} className={input} placeholder={T.subjectPh} />
            </div>
            {/* Dauer */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{T.durationLbl}</label>
              <div className="flex flex-wrap gap-1.5">
                {DUR_VALUES.map(v => (
                  <button key={v} onClick={() => setDuration(v)}
                    className={`text-xs px-3 py-1.5 rounded-full border ${duration === v ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                    style={duration === v ? { backgroundColor: CORAL } : undefined}>{T.dur[v]}</button>
                ))}
              </div>
            </div>
            {/* Art */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{T.typeLbl}</label>
              <div className="grid grid-cols-3 gap-1.5">
                {([['whatsapp', T.whatsapp], ['zoom', T.zoom], ['onsite', T.onsite]] as [Type, string][]).map(([v, l]) => (
                  <button key={v} onClick={() => setType(v)}
                    className={`text-sm py-2 rounded-xl border ${type === v ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                    style={type === v ? { backgroundColor: CORAL } : undefined}>{l}</button>
                ))}
              </div>
              {type === 'onsite' && (
                <div className="relative mt-2">
                  <input value={address} onChange={e => onAddr(e.target.value)} className={input} placeholder={T.addrPh} />
                  {suggests.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
                      {suggests.map((s, i) => (
                        <button key={i} onClick={() => { setAddress(s); setSuggests([]) }} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">{s}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* Tag + Zeit */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{T.whenLbl}</label>
              {loadingSlots ? (
                <div className="flex justify-center py-6"><div className="w-6 h-6 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
              ) : days.length === 0 ? (
                <p className="text-xs text-gray-400 py-4 text-center">{T.noSlots}</p>
              ) : (<>
                <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                  {days.map((d, i) => (
                    <button key={d.date} onClick={() => { setDayIdx(i); setPick(null) }}
                      className={`shrink-0 text-xs px-3 py-1.5 rounded-full border whitespace-nowrap ${i === dayIdx ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                      style={i === dayIdx ? { backgroundColor: '#0f172a' } : undefined}>{dayLabel(d.date)}</button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-1.5 mt-2.5 max-h-52 overflow-y-auto">
                  {day?.times.map(t => {
                    const sel = pick === t.iso
                    return (
                      <button key={t.iso} onClick={() => setPick(t.iso)} title={t.preferred ? '' : T.hint}
                        className="text-sm py-2 rounded-lg border relative"
                        style={sel ? { backgroundColor: CORAL, color: '#fff', borderColor: 'transparent' }
                          : t.preferred ? { backgroundColor: '#fff', color: '#374151', borderColor: '#e5e7eb' }
                          : { backgroundColor: '#fffbeb', color: '#92400e', borderColor: '#fde68a' }}>
                        {t.label}{!t.preferred && !sel && <span className="block text-[9px] leading-none mt-0.5">{T.ungern}</span>}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-gray-400 mt-2"><span style={{ color: AMBER }}>■</span> {T.hint}</p>
              </>)}
            </div>
            {/* Kontakt */}
            <div className="space-y-2 pt-1 border-t border-gray-100">
              {guest && <p className="text-[11px] text-gray-400">{T.contactHdr} · {T.prefilled}</p>}
              <input value={name} onChange={e => setName(e.target.value)} className={input} placeholder={T.namePh} />
              <input value={email} onChange={e => setEmail(e.target.value)} type="email" className={input} placeholder={T.emailPh} />
              <input value={phone} onChange={e => setPhone(e.target.value)} className={input} placeholder={T.phonePh} />
            </div>
            {err && <p className="text-xs text-red-500">{err}</p>}
            <button onClick={book} disabled={busy} className="w-full py-3 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: CORAL }}>
              {busy ? '…' : T.book}
            </button>
          </div>
        )}
        <div className="px-6 py-3 border-t border-gray-50 text-center">
          <a href="https://happy-property.com" className="text-[11px] text-gray-400">happy-property.com</a>
        </div>
      </div>
    </div>
  )
}
