import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { showPdf } from '../lib/reservationAgreement'

// Öffentliche Unterschriftsseite für den Bauträger (/sign/r/:token, kein Login).
// Valery unterschreibt den ausgefüllten Reservierungsvertrag am Handy: Finger-Unterschrift
// + Name in Druckbuchstaben. Ort und Datum setzt das System (Edge reservation-agreement).

interface Fields {
  date: string; property_name: string; address: string; unit_number: string
  purchasers: string[]; id_numbers: string[]; price_text: string; deposit_text: string
}
interface View {
  test: boolean; signed: boolean; signer_name: string | null; signed_at: string | null
  company_name: string; title: string; fields: Fields; place: string; date: string; pdf_base64: string
}
type Phase = 'loading' | 'ready' | 'sending' | 'done' | 'not_found' | 'error'
// Kugelschreiber-Blau für die Unterschrift (keine Markenfarbe, wirkt wie echte Tinte)
const INK = '#1b2a6b'

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('reservation-agreement', { body })
  if (error) {
    const ctx = (error as { context?: Response }).context
    const j = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) as { error?: string } | null : null
    throw new Error(j?.error || error.message)
  }
  const d = data as T & { error?: string }
  if (d?.error) throw new Error(d.error)
  return d
}

export default function ReservationSign() {
  const { token } = useParams<{ token: string }>()
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('loading')
  const [view, setView] = useState<View | null>(null)
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  const [hasInk, setHasInk] = useState(false)
  const [err, setErr] = useState('')
  const [signedPdf, setSignedPdf] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!token) { setPhase('not_found'); return }
    call<View>({ action: 'sign_view', token })
      .then(v => { setView(v); setPhase(v.signed ? 'done' : 'ready') })
      .catch(e => setPhase((e as Error).message === 'not_found' ? 'not_found' : 'error'))
  }, [token])

  // Zeichenfläche an die Breite und Pixeldichte des Handys anpassen
  const setupCanvas = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = c.clientWidth, h = c.clientHeight
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr)
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = INK
    setHasInk(false)
  }, [])
  useEffect(() => { if (phase === 'ready') setupCanvas() }, [phase, setupCanvas])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = pos(e)
    const ctx = e.currentTarget.getContext('2d')
    if (ctx && last.current) { ctx.beginPath(); ctx.arc(last.current.x, last.current.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill() }
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return
    const ctx = e.currentTarget.getContext('2d')
    if (!ctx) return
    const p = pos(e)
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke()
    last.current = p
    setHasInk(true)
  }
  const up = () => { drawing.current = false; last.current = null }

  const openPdf = (b64: string) => { const w = window.open('', '_blank'); showPdf(w, b64) }

  const submit = async () => {
    if (!view || !token || !canvasRef.current) return
    setErr(''); setPhase('sending')
    try {
      const r = await call<{ pdf_base64: string }>({
        action: 'sign_submit', token, name, signature: canvasRef.current.toDataURL('image/png'),
      })
      setSignedPdf(r.pdf_base64)
      setPhase('done')
    } catch (e) {
      const m = (e as Error).message
      setErr(m === 'invalid_name' ? t('reservationSign.errName', 'Please type your full name in block letters.')
        : m === 'invalid_signature' ? t('reservationSign.errSignature', 'Please sign in the box with your finger.')
        : m === 'already_signed' ? t('reservationSign.errAlready', 'This agreement has already been signed.')
        : t('reservationSign.errGeneric', 'Something went wrong. Please try again in a minute.'))
      setPhase('ready')
    }
  }

  const nameOk = /^[\p{Lu}][\p{Lu} .'-]*[\p{Lu}.]$/u.test(name.trim()) && name.trim().length >= 3
  const canSubmit = phase === 'ready' && hasInk && nameOk && agree

  if (phase === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-hp-cream">
      <div className="w-7 h-7 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
    </div>
  )
  if (phase === 'not_found' || phase === 'error' || !view) return (
    <div className="min-h-screen flex items-center justify-center bg-hp-cream p-6 text-center">
      <p className="text-gray-600 max-w-sm">
        {phase === 'error'
          ? t('reservationSign.errGeneric', 'Something went wrong. Please try again in a minute.')
          : t('reservationSign.notFound', 'This signing link is not valid (anymore). Please contact Happy Property.')}
      </p>
    </div>
  )

  const f = view.fields
  return (
    <div className="min-h-screen bg-hp-cream py-6 px-4">
      <div className="max-w-lg mx-auto space-y-4">
        {view.test && (
          <p className="text-xs font-semibold text-blue-700 bg-blue-50 rounded-lg px-3 py-2">
            {t('reservationSign.testBanner', 'TEST: nothing is stored or sent to the client.')}
          </p>
        )}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs uppercase tracking-wide text-gray-400">{view.company_name}</p>
          <h1 className="text-xl font-semibold text-hp-navy mt-1">{view.title}</h1>
          <dl className="mt-4 grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-gray-500">{t('reservationSign.property', 'Property')}</dt><dd className="text-gray-900">{f.property_name}</dd>
            <dt className="text-gray-500">{t('reservationSign.unit', 'Unit')}</dt><dd className="text-gray-900">{f.unit_number}</dd>
            <dt className="text-gray-500">{t('reservationSign.purchasers', 'Purchasers')}</dt>
            <dd className="text-gray-900">{f.purchasers.map((p, i) => <span key={i} className="block">{p} <span className="text-gray-400 font-mono text-xs">{f.id_numbers[i]}</span></span>)}</dd>
            <dt className="text-gray-500">{t('reservationSign.price', 'Purchasing price')}</dt><dd className="text-gray-900">{f.price_text}</dd>
            <dt className="text-gray-500">{t('reservationSign.deposit', 'Holding deposit')}</dt><dd className="text-gray-900">{f.deposit_text}</dd>
          </dl>
          <button onClick={() => openPdf(signedPdf ?? view.pdf_base64)}
            className="mt-4 w-full py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
            📄 {t('reservationSign.viewPdf', 'View the full agreement (PDF)')}
          </button>
        </div>

        {phase === 'done' ? (
          <div className="bg-white rounded-2xl shadow-sm border border-green-100 p-5 text-center space-y-3">
            <p className="text-3xl">✅</p>
            <p className="font-semibold text-gray-900">{t('reservationSign.doneTitle', 'Signed, thank you!')}</p>
            <p className="text-sm text-gray-500">
              {view.signed && view.signer_name
                ? `${view.signer_name} · ${new Date(view.signed_at ?? '').toLocaleDateString('en-GB')}`
                : t('reservationSign.doneText', 'The signed agreement is stored in the shared Drive folder for the client and the lawyer. You will also receive a copy by email.')}
            </p>
            {(signedPdf || view.signed) && (
              <button onClick={() => openPdf(signedPdf ?? view.pdf_base64)}
                className="w-full py-2.5 rounded-xl bg-hp-navy text-white text-sm font-medium">
                {t('reservationSign.download', 'Open signed agreement')}
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-sm font-medium text-gray-800">{t('reservationSign.signHere', 'Your signature')}</p>
                <button onClick={setupCanvas} className="text-xs text-gray-500 hover:text-gray-800">{t('reservationSign.clear', 'Clear')}</button>
              </div>
              <canvas ref={canvasRef}
                onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
                className="w-full h-44 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 touch-none cursor-crosshair" />
              <p className="text-[11px] text-gray-400 mt-1">{t('reservationSign.signHint', 'Sign with your finger in the box.')}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-800 mb-1.5">{t('reservationSign.nameLabel', 'Your name in block letters')}</label>
              <input value={name} onChange={e => setName(e.target.value.toUpperCase())}
                autoCapitalize="characters" autoComplete="name" spellCheck={false} placeholder="JOHN SMITH"
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base tracking-wide focus:outline-none focus:border-orange-400" />
            </div>
            <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
              {t('reservationSign.placeDate', 'Place and date are added automatically:')} <b className="text-gray-700">{view.place}, {view.date}</b>
            </p>
            <label className="flex items-start gap-2.5 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="mt-0.5 w-4 h-4 rounded" />
              <span>{t('reservationSign.agree', 'I have checked the agreement and sign it on behalf of {{company}}.', { company: view.company_name })}</span>
            </label>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <button onClick={submit} disabled={!canSubmit}
              className="w-full py-3 rounded-xl bg-hp-highlight text-white font-semibold disabled:opacity-40">
              {phase === 'sending' ? '…' : t('reservationSign.submit', 'Sign agreement')}
            </button>
          </div>
        )}
        <p className="text-center text-[11px] text-gray-400">Happy Property</p>
      </div>
    </div>
  )
}
