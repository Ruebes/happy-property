import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Öffentlicher persönlicher Buchungslink (z.B. /buchen/sven360) ────────────
// Betreff + Dauer + Art (Vor Ort mit Adress-Autocomplete / WhatsApp / Zoom) +
// Kontaktdaten → Termin in Svens Kalender, Bestätigung per Mail (.ics) + WhatsApp.
const CORAL = '#ff795d', AMBER = '#f59e0b'
type Type = 'onsite' | 'whatsapp' | 'zoom'
interface Day { date: string; label: string; times: { iso: string; label: string; preferred: boolean }[] }
const DURATIONS = [{ v: 30, l: '30 Min' }, { v: 60, l: '1 Std' }, { v: 90, l: '1,5 Std' }, { v: 120, l: '2 Std' }, { v: 180, l: '3 Std' }]
const call = async (body: Record<string, unknown>) => {
  const { data, error } = await supabase.functions.invoke('personal-booking', { body })
  if (error || data?.error) throw new Error(data?.error || 'Fehler')
  return data
}

export default function BookingPage() {
  const { slug } = useParams<{ slug: string }>()
  const [title, setTitle] = useState('Termin'); const [owner, setOwner] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [subject, setSubject] = useState(''); const [duration, setDuration] = useState(30)
  const [type, setType] = useState<Type>('whatsapp')
  const [address, setAddress] = useState(''); const [suggests, setSuggests] = useState<string[]>([])
  const [days, setDays] = useState<Day[]>([]); const [loadingSlots, setLoadingSlots] = useState(true)
  const [dayIdx, setDayIdx] = useState(0); const [pick, setPick] = useState<string | null>(null)
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState<null | { dateStr: string; typeLabel: string; zoomLink: string | null }>(null)

  useEffect(() => { call({ action: 'config', slug }).then(d => { setTitle(d.title); setOwner(d.owner) }).catch(() => setNotFound(true)) }, [slug])

  const loadSlots = useCallback(async (dur: number) => {
    setLoadingSlots(true); setPick(null)
    try { const d = await call({ action: 'slots', slug, duration: dur }); setDays(d.days ?? []); setDayIdx(0) }
    catch { setDays([]) } finally { setLoadingSlots(false) }
  }, [slug])
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

  const book = async () => {
    setErr('')
    if (!subject.trim()) return setErr('Bitte einen Betreff angeben.')
    if (!pick) return setErr('Bitte einen Zeitpunkt wählen.')
    if (type === 'onsite' && !address.trim()) return setErr('Bitte eine Adresse angeben.')
    if (!name.trim()) return setErr('Bitte deinen Namen angeben.')
    if (!email.trim() && !phone.trim()) return setErr('Bitte E-Mail oder Telefon angeben.')
    setBusy(true)
    try {
      const d = await call({ action: 'book', slug, startIso: pick, duration, subject: subject.trim(), type, address: address.trim() || undefined, name: name.trim(), email: email.trim() || undefined, phone: phone.trim() || undefined })
      setDone({ dateStr: d.dateStr, typeLabel: d.typeLabel, zoomLink: d.zoomLink })
    } catch (e) { setErr(e instanceof Error ? e.message : 'Buchung fehlgeschlagen.') } finally { setBusy(false) }
  }

  const input = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-400'
  const day = days[dayIdx]

  return (
    <div className="min-h-screen py-6 px-4" style={{ background: 'linear-gradient(160deg,#fff5f2,#faf7f4)' }}>
      <div className="w-full max-w-md mx-auto bg-white rounded-3xl shadow-xl border border-gray-100 overflow-hidden">
        <div className="px-6 py-5" style={{ backgroundColor: CORAL }}>
          <p className="text-white/80 text-xs font-semibold tracking-wide uppercase">Happy Property</p>
          <h1 className="text-white text-lg font-bold mt-0.5">{title}{owner ? ` · ${owner}` : ''}</h1>
        </div>

        {notFound ? (
          <div className="p-8 text-center text-sm text-gray-500">Dieser Buchungslink ist nicht verfügbar.</div>
        ) : done ? (
          <div className="p-6 text-center space-y-3">
            <p className="text-3xl">🎉</p>
            <p className="text-base font-semibold text-gray-900">Termin gebucht!</p>
            <div className="bg-green-50 border border-green-100 rounded-2xl p-4 text-sm text-gray-700">
              <p className="font-medium">{subject}</p>
              <p className="mt-1">📅 {done.dateStr}</p>
              <p className="mt-0.5">📍 {done.typeLabel}</p>
              {done.zoomLink && <p className="mt-1"><a href={done.zoomLink} className="text-orange-600 underline">Zoom-Link</a></p>}
            </div>
            <p className="text-xs text-gray-500">Du bekommst gleich eine Bestätigung{email ? ' per E-Mail (mit Kalender-Datei)' : ''}{email && phone ? ' und' : ''}{phone ? ' per WhatsApp' : ''}. Bis bald!</p>
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Betreff */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Worum geht's? (Betreff)</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} className={input} placeholder="z. B. Kennenlernen, Beratung, Essen …" />
            </div>
            {/* Dauer */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Dauer</label>
              <div className="flex flex-wrap gap-1.5">
                {DURATIONS.map(d => (
                  <button key={d.v} onClick={() => setDuration(d.v)}
                    className={`text-xs px-3 py-1.5 rounded-full border ${duration === d.v ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                    style={duration === d.v ? { backgroundColor: CORAL } : undefined}>{d.l}</button>
                ))}
              </div>
            </div>
            {/* Art */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Wie treffen wir uns?</label>
              <div className="grid grid-cols-3 gap-1.5">
                {([['whatsapp', 'WhatsApp'], ['zoom', 'Zoom'], ['onsite', 'Vor Ort']] as [Type, string][]).map(([v, l]) => (
                  <button key={v} onClick={() => setType(v)}
                    className={`text-sm py-2 rounded-xl border ${type === v ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                    style={type === v ? { backgroundColor: CORAL } : undefined}>{l}</button>
                ))}
              </div>
              {type === 'onsite' && (
                <div className="relative mt-2">
                  <input value={address} onChange={e => onAddr(e.target.value)} className={input} placeholder="Adresse eingeben (Vorschläge ab 3 Buchstaben) …" />
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
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Wann passt es dir?</label>
              {loadingSlots ? (
                <div className="flex justify-center py-6"><div className="w-6 h-6 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
              ) : days.length === 0 ? (
                <p className="text-xs text-gray-400 py-4 text-center">Für diese Dauer sind gerade keine Zeiten frei.</p>
              ) : (<>
                <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                  {days.map((d, i) => (
                    <button key={d.date} onClick={() => { setDayIdx(i); setPick(null) }}
                      className={`shrink-0 text-xs px-3 py-1.5 rounded-full border whitespace-nowrap ${i === dayIdx ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                      style={i === dayIdx ? { backgroundColor: '#0f172a' } : undefined}>{d.label}</button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-1.5 mt-2.5 max-h-52 overflow-y-auto">
                  {day?.times.map(t => {
                    const sel = pick === t.iso
                    return (
                      <button key={t.iso} onClick={() => setPick(t.iso)} title={t.preferred ? '' : 'Für Sven eher ungünstig'}
                        className="text-sm py-2 rounded-lg border relative"
                        style={sel ? { backgroundColor: CORAL, color: '#fff', borderColor: 'transparent' }
                          : t.preferred ? { backgroundColor: '#fff', color: '#374151', borderColor: '#e5e7eb' }
                          : { backgroundColor: '#fffbeb', color: '#92400e', borderColor: '#fde68a' }}>
                        {t.label}{!t.preferred && !sel && <span className="block text-[9px] leading-none mt-0.5">ungern</span>}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-gray-400 mt-2"><span style={{ color: AMBER }}>■</span> gelb = für Sven eher ungünstig, geht aber im Notfall.</p>
              </>)}
            </div>
            {/* Kontakt */}
            <div className="space-y-2 pt-1 border-t border-gray-100">
              <input value={name} onChange={e => setName(e.target.value)} className={input} placeholder="Dein Name" />
              <input value={email} onChange={e => setEmail(e.target.value)} type="email" className={input} placeholder="E-Mail (für Bestätigung + Kalender)" />
              <input value={phone} onChange={e => setPhone(e.target.value)} className={input} placeholder="Telefon / WhatsApp" />
            </div>
            {err && <p className="text-xs text-red-500">{err}</p>}
            <button onClick={book} disabled={busy} className="w-full py-3 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: CORAL }}>
              {busy ? '…' : 'Termin buchen'}
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
