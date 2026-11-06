import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'

// Öffentliche Seite /sign/a/:token (kein Login, nur Token): Der Kunde trägt für seinen
// Reservierungsvertrag die Angaben ein, die nicht im Ausweis stehen (Flora Panorama),
// und lädt danach seinen Ausweis hoch. Kein Google-Konto nötig, die Datei geht über den
// Server in seinen Drive-Ordner.
// Sprache = Sprache des Kunden aus dem CRM. Die Regeln prüft der Server (customerData.ts).

interface Person {
  salutation: string; street: string; postal_code: string; city: string
  country_code: string; country_other: string; phone: string; email: string
}
interface Second extends Person { first_name: string; last_name: string; same_address: boolean }
interface View {
  closed: boolean; test?: boolean; lang: 'de' | 'en'; first_name?: string; submitted?: boolean
  prefill?: Person & { second?: Second | null }
  countries?: Array<{ code: string; name: string }>
  have_main?: boolean; have_second?: boolean; uploads?: Upload[]
}
type Phase = 'loading' | 'form' | 'sending' | 'ids' | 'done' | 'closed' | 'not_found' | 'error'
type UploadPerson = 'main' | 'second'
type UploadDoc = 'id_card' | 'passport'
type UploadSide = 'front' | 'back' | 'page'
interface Upload { person: string; doc: string; side: string }

const EMPTY: Person = { salutation: '', street: '', postal_code: '', city: '', country_code: '', country_other: '', phone: '', email: '' }
const OTHER = 'OTHER'

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('reservation-agreement', { body })
  if (error) {
    const ctx = (error as { context?: Response }).context
    const j = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) as { error?: string; fields?: Record<string, string> } | null : null
    const e = new Error(j?.error || error.message) as Error & { fields?: Record<string, string> }
    e.fields = j?.fields
    throw e
  }
  return data as T
}

const SIDES: Record<UploadDoc, UploadSide[]> = { id_card: ['front', 'back'], passport: ['page'] }
const MAX_BYTES = 10 * 1024 * 1024
const SHRINK_ABOVE = 2_500_000

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
  r.onerror = () => reject(r.error)
  r.readAsDataURL(blob)
})

/** Handyfotos sind oft riesig: verkleinern, gut lesbar bleibt ein Ausweis auch so. Klappt das nicht, geht das Original. */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || (file.size <= SHRINK_ABOVE && /jpe?g|png|webp/.test(file.type))) return file
  try {
    const img = await createImageBitmap(file)
    const scale = Math.min(1, 2600 / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    const out = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.88))
    return out && out.size > 0 ? out : file
  } catch { return file }
}

function isComplete(uploads: Upload[], person: UploadPerson): boolean {
  const has = (doc: UploadDoc, side: UploadSide) => uploads.some(u => u.person === person && u.doc === doc && u.side === side)
  return has('passport', 'page') || (has('id_card', 'front') && has('id_card', 'back'))
}

function IdCard({ token, person, title, t, uploads, onUploaded, onClosed }: {
  token?: string; person: UploadPerson; title: string; t: (k: string, d: string) => string
  uploads: Upload[]; onUploaded: (u: Upload) => void; onClosed: () => void
}) {
  const [doc, setDoc] = useState<UploadDoc | null>(() => (uploads.find(u => u.person === person)?.doc as UploadDoc | undefined) ?? null)
  const [busy, setBusy] = useState<UploadSide | null>(null)
  const [problem, setProblem] = useState<{ side: UploadSide; code: string; file: File } | null>(null)

  const send = async (side: UploadSide, file: File, force = false) => {
    if (!doc) return
    setBusy(side); setProblem(null)
    try {
      const blob = await shrink(file)
      if (blob.size > MAX_BYTES) { setProblem({ side, code: 'too_big', file }); return }
      await call({ action: 'address_upload', token, person, doc, side, force, base64: await toBase64(blob) })
      onUploaded({ person, doc, side })
    } catch (e) {
      const code = (e as Error).message
      if (code === 'closed') { onClosed(); return }
      setProblem({ side, code, file })
    } finally { setBusy(null) }
  }

  const problemText = (code: string) => code === 'not_id' ? t('reservationAddress.errNotId', 'This does not look like an ID. Please check the photo and try again.')
    : code === 'too_big' ? t('reservationAddress.errTooBig', 'This file is too large. Please take a new photo or use a file up to 10 MB.')
    : code === 'bad_type' ? t('reservationAddress.errType', 'Please upload a photo or a PDF.')
    : t('reservationAddress.errUpload', 'The upload did not work. Please try again in a minute.')
  const sideLabel = (s: UploadSide) => s === 'front' ? t('reservationAddress.sideFront', 'Front side')
    : s === 'back' ? t('reservationAddress.sideBack', 'Back side')
    : t('reservationAddress.sidePage', 'Page with your photo')

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
      <p className="text-base font-semibold text-hp-navy">{title}</p>
      <div className="grid grid-cols-2 gap-2">
        {([['id_card', t('reservationAddress.docIdCard', 'ID card (2 sides)')], ['passport', t('reservationAddress.docPassport', 'Passport (1 page)')]] as const).map(([v, label]) => (
          <button key={v} type="button" onClick={() => { setDoc(v); setProblem(null) }} aria-pressed={doc === v}
            className={`py-3 px-2 rounded-xl border text-sm font-medium ${doc === v ? 'border-hp-highlight bg-orange-50 text-hp-navy' : 'border-gray-200 text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>
      {doc && SIDES[doc].map(side => {
        const done = uploads.some(u => u.person === person && u.doc === doc && u.side === side)
        const bad = problem?.side === side ? problem : null
        return (
          <div key={side} className="space-y-2">
            {done ? (
              <p className="py-3 px-3 rounded-xl bg-green-50 text-sm text-green-800">✅ {sideLabel(side)}: {t('reservationAddress.uploaded', 'received')}</p>
            ) : (
              <label className={`block text-center py-3 px-3 rounded-xl border border-dashed text-sm font-medium ${busy ? 'border-gray-200 text-gray-400' : 'border-gray-300 text-hp-navy cursor-pointer hover:bg-gray-50'}`}>
                {busy === side ? t('reservationAddress.uploading', 'Uploading, one moment…') : `${sideLabel(side)}: ${t('reservationAddress.pickFile', 'choose photo or file')}`}
                <input type="file" accept="image/*,application/pdf" className="sr-only" disabled={!!busy}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void send(side, f) }} />
              </label>
            )}
            {bad && !done && (
              <div className="text-xs text-red-600 space-y-1">
                <p>{problemText(bad.code)}</p>
                {bad.code === 'not_id' && <button type="button" onClick={() => void send(side, bad.file, true)} className="underline">{t('reservationAddress.useAnyway', 'It is my ID, use it anyway')}</button>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function ReservationAddress() {
  const { token } = useParams<{ token: string }>()
  const { i18n } = useTranslation()
  const [phase, setPhase] = useState<Phase>('loading')
  const [view, setView] = useState<View | null>(null)
  const [me, setMe] = useState<Person>(EMPTY)
  const [hasSecond, setHasSecond] = useState(false)
  const [second, setSecond] = useState<Second>({ ...EMPTY, first_name: '', last_name: '', same_address: true })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<Upload[]>([])
  const [have, setHave] = useState({ main: false, second: false })
  const t = useMemo(() => i18n.getFixedT(view?.lang ?? 'de'), [view?.lang, i18n])

  useEffect(() => {
    call<View>({ action: 'address_view', token })
      .then(v => {
        setView(v)
        if (v.closed) { setPhase('closed'); return }
        const { second: s, ...p } = v.prefill ?? { ...EMPTY }
        setMe({ ...EMPTY, ...p, country_code: p.country_code || (p.country_other ? OTHER : '') })
        if (s) { setHasSecond(true); setSecond({ ...s, country_code: s.country_code || (s.country_other ? OTHER : '') }) }
        const ups = v.uploads ?? [], h = { main: !!v.have_main, second: !!v.have_second }
        setUploads(ups); setHave(h)
        const allThere = (h.main || isComplete(ups, 'main')) && (!s || h.second || isComplete(ups, 'second'))
        setPhase(!v.submitted ? 'form' : allThere ? 'done' : 'ids')
      })
      .catch(e => setPhase((e as Error).message === 'not_found' ? 'not_found' : 'error'))
  }, [token])

  const submit = async () => {
    setPhase('sending'); setErrors({})
    const code = (p: Person) => p.country_code === OTHER ? '' : p.country_code
    try {
      const r = await call<{ have_main?: boolean; have_second?: boolean }>({ action: 'address_submit', token, ...me, country_code: code(me), second: hasSecond ? { ...second, country_code: code(second) } : null })
      const h = { main: !!r.have_main, second: !!r.have_second }
      setHave(h)
      setPhase((h.main || isComplete(uploads, 'main')) && (!hasSecond || h.second || isComplete(uploads, 'second')) ? 'done' : 'ids')
      window.scrollTo(0, 0)
    } catch (e) {
      const err = e as Error & { fields?: Record<string, string> }
      if (err.message === 'closed') { setPhase('closed'); return }
      if (err.fields) { setErrors(err.fields); setPhase('form'); return }
      setPhase('error')
    }
  }

  const msg = (code?: string, field?: string) => !code ? null
    : code === 'required' ? t('reservationAddress.errRequired', 'Please fill in')
    : code === 'house_number' ? t('reservationAddress.errHouseNumber', 'Please include the house number')
    : field === 'postal_code' ? t('reservationAddress.errPostal', 'Please check the postal code')
    : t('reservationAddress.errInvalid', 'Please check this entry')
  const inputCls = (bad?: string) => `w-full border rounded-xl px-3 py-2.5 text-base focus:outline-none focus:border-orange-400 ${bad ? 'border-red-400' : 'border-gray-200'}`

  const box = (children: React.ReactNode) => (
    <div className="min-h-screen bg-hp-cream py-6 px-4">
      <div className="max-w-lg mx-auto space-y-4">
        {view?.test && <p className="text-xs font-semibold text-blue-700 bg-blue-50 rounded-lg px-3 py-2">{t('reservationAddress.test', 'Test: nothing is saved in the CRM.')}</p>}
        {children}
      </div>
    </div>
  )
  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4'

  if (phase === 'loading') return <div className="min-h-screen flex items-center justify-center bg-hp-cream text-gray-500">…</div>
  if (phase === 'not_found') return box(<div className={card}><p className="text-sm text-gray-700">{t('reservationAddress.notFound', 'This link is not valid. Please contact Happy Property.')}</p></div>)
  if (phase === 'error') return box(<div className={card}><p className="text-sm text-gray-700">{t('reservationAddress.error', 'Something went wrong. Please try again in a minute.')}</p></div>)
  if (phase === 'closed') return box(<div className={card}><p className="text-sm text-gray-700">{t('reservationAddress.closed', 'Thank you, we already have everything we need for your agreement.')}</p></div>)
  if (phase === 'done') return box(
    <div className={card}>
      <p className="text-lg font-semibold text-hp-navy">✅ {t('reservationAddress.doneTitle', 'Thank you!')}</p>
      <p className="text-sm text-gray-700">{t('reservationAddress.doneText', 'We have everything. We are now preparing your reservation agreement. First the developer signs, then you receive your link to sign.')}</p>
    </div>
  )
  if (phase === 'ids') {
    const addUpload = (u: Upload) => setUploads(x => [...x, u])
    const mainOk = have.main || isComplete(uploads, 'main')
    const secondOk = !hasSecond || have.second || isComplete(uploads, 'second')
    return box(
      <>
        <div className={card}>
          <p className="text-lg font-semibold text-hp-navy">{t('reservationAddress.idTitle', 'Upload your ID')}</p>
          <p className="text-sm text-gray-600">{t('reservationAddress.idIntro', 'Please choose your document. A clear photo from your phone is enough, you do not need an account.')}</p>
        </div>
        {!have.main && <IdCard token={token} person="main" title={t('reservationAddress.idMine', 'Your ID')} t={t} uploads={uploads} onUploaded={addUpload} onClosed={() => setPhase('closed')} />}
        {hasSecond && !have.second && <IdCard token={token} person="second" title={t('reservationAddress.idOf', 'ID of {{name}}', { name: `${second.first_name} ${second.last_name}` })} t={t} uploads={uploads} onUploaded={addUpload} onClosed={() => setPhase('closed')} />}
        <button onClick={() => { setPhase('done'); window.scrollTo(0, 0) }} disabled={!mainOk || !secondOk} className="w-full py-3.5 rounded-xl bg-hp-highlight text-white font-semibold disabled:opacity-50">
          {t('reservationAddress.finish', 'Done')}
        </button>
        <p className="text-xs text-gray-500 text-center">{t('reservationAddress.later', 'Not everything at hand? You can continue any time with the same link.')}</p>
        <button onClick={() => setPhase('form')} className="block mx-auto text-xs text-gray-500 underline">{t('reservationAddress.editDetails', 'Change my address details')}</button>
      </>
    )
  }

  const countries = view?.countries ?? []
  const fields = (p: Person, set: (f: Partial<Person>) => void, prefix: string) => (
    <>
      <label className="block text-sm text-gray-700">{t('reservationAddress.street', 'Street and house number')}
        <input value={p.street} autoComplete={prefix ? 'off' : 'street-address'} onChange={e => set({ street: e.target.value })} className={`${inputCls(errors[`${prefix}street`])} mt-1`} />
        <span className="text-xs text-red-600">{msg(errors[`${prefix}street`])}</span>
      </label>
      <div className="grid grid-cols-[7rem_1fr] gap-2">
        <label className="block text-sm text-gray-700">{t('reservationAddress.postal', 'Postal code')}
          <input value={p.postal_code} autoComplete={prefix ? 'off' : 'postal-code'} onChange={e => set({ postal_code: e.target.value })} className={`${inputCls(errors[`${prefix}postal_code`])} mt-1`} />
          <span className="text-xs text-red-600">{msg(errors[`${prefix}postal_code`], 'postal_code')}</span>
        </label>
        <label className="block text-sm text-gray-700">{t('reservationAddress.city', 'City')}
          <input value={p.city} autoComplete={prefix ? 'off' : 'address-level2'} onChange={e => set({ city: e.target.value })} className={`${inputCls(errors[`${prefix}city`])} mt-1`} />
          <span className="text-xs text-red-600">{msg(errors[`${prefix}city`])}</span>
        </label>
      </div>
      <label className="block text-sm text-gray-700">{t('reservationAddress.country', 'Country')}
        <select value={p.country_code} onChange={e => set({ country_code: e.target.value })} className={`${inputCls(errors[`${prefix}country`])} mt-1 bg-white`}>
          <option value="">{t('reservationAddress.choose', 'Please choose')}</option>
          {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          <option value={OTHER}>{t('reservationAddress.otherCountry', 'Other country')}</option>
        </select>
        <span className="text-xs text-red-600">{p.country_code !== OTHER ? msg(errors[`${prefix}country`]) : null}</span>
      </label>
      {p.country_code === OTHER && (
        <label className="block text-sm text-gray-700">{t('reservationAddress.countryName', 'Country, in English please')}
          <input value={p.country_other} onChange={e => set({ country_other: e.target.value })} className={`${inputCls(errors[`${prefix}country`])} mt-1`} />
          <span className="text-xs text-red-600">{msg(errors[`${prefix}country`])}</span>
        </label>
      )}
    </>
  )
  const contact = (p: Person, set: (f: Partial<Person>) => void, prefix: string) => (
    <>
      <label className="block text-sm text-gray-700">{t('reservationAddress.phone', 'Phone')}
        <input value={p.phone} type="tel" onChange={e => set({ phone: e.target.value })} className={`${inputCls(errors[`${prefix}phone`])} mt-1`} />
        <span className="text-xs text-red-600">{msg(errors[`${prefix}phone`])}</span>
      </label>
      <label className="block text-sm text-gray-700">{t('reservationAddress.email', 'Email')}
        <input value={p.email} type="email" onChange={e => set({ email: e.target.value })} className={`${inputCls(errors[`${prefix}email`])} mt-1`} />
        <span className="text-xs text-red-600">{msg(errors[`${prefix}email`])}</span>
      </label>
    </>
  )
  const salutation = (p: Person, set: (f: Partial<Person>) => void, prefix: string) => (
    <div>
      <div className="flex gap-4 text-sm text-gray-700">
        {([['MR.', t('reservationAddress.mr', 'Mr.')], ['MRS.', t('reservationAddress.mrs', 'Mrs.')]] as const).map(([v, label]) => (
          <label key={v} className="flex items-center gap-2 py-1">
            <input type="radio" name={`${prefix}salutation`} checked={p.salutation === v} onChange={() => set({ salutation: v })} />{label}
          </label>
        ))}
      </div>
      <span className="text-xs text-red-600">{msg(errors[`${prefix}salutation`])}</span>
    </div>
  )
  const setMePart = (f: Partial<Person>) => setMe(x => ({ ...x, ...f }))
  const setSecondPart = (f: Partial<Second>) => setSecond(x => ({ ...x, ...f }))

  return box(
    <>
      <div className={card}>
        <div>
          <p className="text-lg font-semibold text-hp-navy">{t('reservationAddress.title', 'Your details for the reservation agreement')}</p>
          <p className="text-sm text-gray-600 mt-1">{t('reservationAddress.intro', 'Hi {{name}}, your name and ID number come from your ID. Your address is not on it, so we need it from you. It will appear in the agreement exactly as you enter it.', { name: view?.first_name ?? '' })}</p>
        </div>
        {salutation(me, setMePart, '')}
        {fields(me, setMePart, '')}
        {contact(me, setMePart, '')}
      </div>

      <div className={card}>
        <label className="flex items-start gap-3 text-sm text-gray-800">
          <input type="checkbox" className="mt-1" checked={hasSecond} onChange={e => setHasSecond(e.target.checked)} />
          <span>{t('reservationAddress.secondAsk', 'I am buying together with a second person')}</span>
        </label>
        {hasSecond && (
          <>
            <p className="text-xs text-gray-500">{t('reservationAddress.secondHint', 'Please also upload the ID of the second person to your folder.')}</p>
            {salutation(second, setSecondPart, 'second_')}
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm text-gray-700">{t('reservationAddress.firstName', 'First name')}
                <input value={second.first_name} onChange={e => setSecondPart({ first_name: e.target.value })} className={`${inputCls(errors.second_first_name)} mt-1`} />
                <span className="text-xs text-red-600">{msg(errors.second_first_name)}</span>
              </label>
              <label className="block text-sm text-gray-700">{t('reservationAddress.lastName', 'Last name')}
                <input value={second.last_name} onChange={e => setSecondPart({ last_name: e.target.value })} className={`${inputCls(errors.second_last_name)} mt-1`} />
                <span className="text-xs text-red-600">{msg(errors.second_last_name)}</span>
              </label>
            </div>
            <label className="flex items-start gap-3 text-sm text-gray-800">
              <input type="checkbox" className="mt-1" checked={second.same_address} onChange={e => setSecondPart({ same_address: e.target.checked })} />
              <span>{t('reservationAddress.sameAddress', 'Same address as above')}</span>
            </label>
            {!second.same_address && fields(second, setSecondPart, 'second_')}
            {contact(second, setSecondPart, 'second_')}
          </>
        )}
      </div>

      {Object.keys(errors).length > 0 && <p className="text-sm text-red-600 text-center">{t('reservationAddress.errSummary', 'Please check the marked fields.')}</p>}
      <button onClick={submit} disabled={phase === 'sending'} className="w-full py-3.5 rounded-xl bg-hp-highlight text-white font-semibold disabled:opacity-50">
        {phase === 'sending' ? '…' : t('reservationAddress.submit', 'Send details')}
      </button>
    </>
  )
}
