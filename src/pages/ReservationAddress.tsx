import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'

// Öffentliche Seite /sign/a/:token (kein Login, nur Token): Der Kunde trägt für seinen
// Reservierungsvertrag die Angaben ein, die nicht im Ausweis stehen (Flora Panorama).
// Sprache = Sprache des Kunden aus dem CRM. Die Regeln prüft der Server (customerData.ts).

interface Person {
  salutation: string; street: string; postal_code: string; city: string
  country_code: string; country_other: string; phone: string; email: string
}
interface Second extends Person { first_name: string; last_name: string; same_address: boolean }
interface View {
  closed: boolean; test?: boolean; lang: 'de' | 'en'; first_name?: string; submitted?: boolean
  drive_link?: string | null; prefill?: Person & { second?: Second | null }
  countries?: Array<{ code: string; name: string }>
}
type Phase = 'loading' | 'form' | 'sending' | 'done' | 'closed' | 'not_found' | 'error'

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

export default function ReservationAddress() {
  const { token } = useParams<{ token: string }>()
  const { i18n } = useTranslation()
  const [phase, setPhase] = useState<Phase>('loading')
  const [view, setView] = useState<View | null>(null)
  const [me, setMe] = useState<Person>(EMPTY)
  const [hasSecond, setHasSecond] = useState(false)
  const [second, setSecond] = useState<Second>({ ...EMPTY, first_name: '', last_name: '', same_address: true })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const t = useMemo(() => i18n.getFixedT(view?.lang ?? 'de'), [view?.lang, i18n])

  useEffect(() => {
    call<View>({ action: 'address_view', token })
      .then(v => {
        setView(v)
        if (v.closed) { setPhase('closed'); return }
        const { second: s, ...p } = v.prefill ?? { ...EMPTY }
        setMe({ ...EMPTY, ...p, country_code: p.country_code || (p.country_other ? OTHER : '') })
        if (s) { setHasSecond(true); setSecond({ ...s, country_code: s.country_code || (s.country_other ? OTHER : '') }) }
        setPhase('form')
      })
      .catch(e => setPhase((e as Error).message === 'not_found' ? 'not_found' : 'error'))
  }, [token])

  const submit = async () => {
    setPhase('sending'); setErrors({})
    const code = (p: Person) => p.country_code === OTHER ? '' : p.country_code
    try {
      await call({ action: 'address_submit', token, ...me, country_code: code(me), second: hasSecond ? { ...second, country_code: code(second) } : null })
      setPhase('done')
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
      <p className="text-sm text-gray-700">{t('reservationAddress.doneText', 'We have your details. As soon as your ID is in your folder too, we will prepare your reservation agreement. First the developer signs, then you receive your link to sign.')}</p>
      {view?.drive_link && (
        <a href={view.drive_link} className="block text-center w-full py-3 rounded-xl border border-gray-200 text-sm font-medium text-hp-navy hover:bg-gray-50">
          {t('reservationAddress.toFolder', 'Upload your ID to your folder')}
        </a>
      )}
    </div>
  )

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
