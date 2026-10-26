import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { showPdf } from '../lib/reservationAgreement'
import { processSealImage } from '../lib/sealImage'
import SignaturePad, { type SignaturePadHandle } from '../components/SignaturePad'

// Öffentliche Unterschriftsseite für den Bauträger (kein Login, nur Token):
//   /sign/r/:token  Reservierungsvertrag (Edge reservation-agreement sign_view / sign_submit)
//   /sign/d/:token  weiteres Dokument, z. B. Spezifikation (doc_view / doc_submit)
// Sprache = Sprache des Empfängers aus dem CRM (nicht die des Browsers). Unterschrift mit dem
// Finger + Name in Druckbuchstaben; Ort und Datum setzt das System. Firmenstempel wählbar,
// neues Stempelfoto wird für alle weiteren Dokumente dieses Bauträgers gespeichert.

interface Fields {
  date: string; property_name: string; address: string; unit_number: string
  purchasers: string[]; id_numbers: string[]; price_text: string; deposit_text: string
  special_terms?: string
}
interface View {
  test: boolean; signed: boolean; signer_name: string | null; signed_at: string | null
  company_name: string; title: string; place: string; date: string; lang: 'de' | 'en'
  seal: string | null; pdf_base64: string
  fields?: Fields          // nur Reservierung
  inputs?: InputDef[]      // Felder, die der Unterzeichner selbst ausfüllt (z. B. Genehmigungsnummern)
}
interface InputDef { key: string; label: string; hint: string | null; required: boolean }
type Phase = 'loading' | 'ready' | 'sending' | 'done' | 'not_found' | 'error'
// Druckbuchstaben wie auf dem Server: nur lateinische Schrift (die PDF-Schrift kann nichts anderes)
const NAME_RE = /^[A-ZÀ-ÖØ-ÞĀ-ſ][A-ZÀ-ÖØ-ÞĀ-ſ .'-]*[A-ZÀ-ÖØ-ÞĀ-ſ.]$/
type Mode = 'reservation' | 'document'

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

export default function ReservationSign({ mode = 'reservation' }: { mode?: Mode }) {
  const { token } = useParams<{ token: string }>()
  const { i18n } = useTranslation()
  const [phase, setPhase] = useState<Phase>('loading')
  const [view, setView] = useState<View | null>(null)
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  const [hasInk, setHasInk] = useState(false)
  const [useSeal, setUseSeal] = useState(false)
  const [newSeal, setNewSeal] = useState<string | null>(null)
  const [sealBusy, setSealBusy] = useState(false)
  const [err, setErr] = useState('')
  const [signedPdf, setSignedPdf] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  // Zweite Unterschrift (nur Reservierung, Mito 26.10.): optional per Knopf dazuholen
  const [two, setTwo] = useState(false)
  const [name2, setName2] = useState('')
  const [hasInk2, setHasInk2] = useState(false)
  const pad = useRef<SignaturePadHandle | null>(null)
  const pad2 = useRef<SignaturePadHandle | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Texte in der Sprache des Empfängers (aus dem CRM), nicht in der Browsersprache;
  // solange sie unbekannt ist (Laden, ungültiger Link): Englisch
  const t = useMemo(() => i18n.getFixedT(view?.lang ?? 'en'), [view, i18n])
  const onInk = useCallback((v: boolean) => setHasInk(v), [])
  const onInk2 = useCallback((v: boolean) => setHasInk2(v), [])
  const viewAction = mode === 'document' ? 'doc_view' : 'sign_view'
  const submitAction = mode === 'document' ? 'doc_submit' : 'sign_submit'

  useEffect(() => {
    if (!token) { setPhase('not_found'); return }
    call<View>({ action: viewAction, token })
      .then(v => { setView(v); setUseSeal(!!v.seal); setPhase(v.signed ? 'done' : 'ready') })
      .catch(e => setPhase((e as Error).message === 'not_found' ? 'not_found' : 'error'))
  }, [token, viewAction])

  const openPdf = (b64: string) => { const w = window.open('', '_blank'); showPdf(w, b64) }

  const pickSeal = async (file: File | undefined) => {
    if (!file) return
    setErr(''); setSealBusy(true)
    try {
      setNewSeal(await processSealImage(file))
      setUseSeal(true)
    } catch (e) {
      setErr((e as Error).message === 'seal_not_found'
        ? t('reservationSign.errSealNotFound', 'No seal found on the photo. Please stamp on white paper and take a sharp photo from above.')
        : t('reservationSign.errSealImage', 'The photo could not be read. Please try another one.'))
    } finally {
      setSealBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const submit = async () => {
    if (!view || !token || !pad.current) return
    setErr(''); setPhase('sending')
    try {
      const r = await call<{ pdf_base64: string }>({
        action: submitAction, token, name, signature: pad.current.toPng(), inputs: values,
        use_seal: useSeal && !!(newSeal || view.seal), seal: newSeal ?? undefined,
        ...(two && pad2.current ? { second: { name: name2, signature: pad2.current.toPng() } } : {}),
      })
      setSignedPdf(r.pdf_base64)
      setPhase('done')
    } catch (e) {
      const m = (e as Error).message
      if (m === 'not_found') { setPhase('not_found'); return }
      setErr(m === 'invalid_name' ? t('reservationSign.errName', 'Please type your full name in block letters.')
        : m === 'invalid_signature' ? t('reservationSign.errSignature', 'Please sign in the box with your finger.')
        : m === 'invalid_name_2' ? t('reservationSign.errName2', 'Second signature: please type the full name in block letters.')
        : m === 'invalid_signature_2' ? t('reservationSign.errSignature2', 'Second signature: please sign in the second box with your finger.')
        : m === 'invalid_seal' ? t('reservationSign.errSealImage', 'The photo could not be read. Please try another one.')
        : m === 'already_signed' ? t('reservationSign.errAlready', 'This document has already been signed.')
        : m === 'invalid_inputs' ? t('reservationSign.errInputs', 'Please fill in all required fields.')
        : t('reservationSign.errGeneric', 'Something went wrong. Please try again in a minute.'))
      setPhase('ready')
    }
  }

  // gleiche Regel wie der Server (cleanName): lateinische Großbuchstaben, mind. 2 am Stück
  const okName = (n: string) => NAME_RE.test(n.trim()) && /[A-ZÀ-ÖØ-ÞĀ-ſ]{2,}/.test(n) && n.trim().length >= 3
  const nameOk = okName(name)
  const name2Ok = okName(name2)
  const secondOk = !two || (hasInk2 && name2Ok)
  const inputs = view?.inputs ?? []
  const inputsOk = inputs.every(i => !i.required || (values[i.key] ?? '').trim())
  const canSubmit = phase === 'ready' && hasInk && nameOk && secondOk && agree && inputsOk && !sealBusy
  // Was fehlt noch? Steht direkt über dem Knopf, damit niemand rätseln muss
  const missing = [
    !hasInk && t('reservationSign.missSig1', 'signature 1'),
    !nameOk && t('reservationSign.missName1', 'name 1'),
    two && !hasInk2 && t('reservationSign.missSig2', 'signature 2'),
    two && !name2Ok && t('reservationSign.missName2', 'name 2'),
    !inputsOk && t('reservationSign.missInputs', 'the fields above'),
    !agree && t('reservationSign.missAgree', 'the tick box'),
  ].filter(Boolean) as string[]
  const removeSecond = () => { setTwo(false); setName2(''); setHasInk2(false) }
  const isRes = mode === 'reservation'
  const sealShown = newSeal ?? view?.seal ?? null

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
          {f ? (
            <dl className="mt-4 grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-gray-500">{t('reservationSign.property', 'Property')}</dt><dd className="text-gray-900">{f.property_name}</dd>
              <dt className="text-gray-500">{t('reservationSign.unit', 'Unit')}</dt><dd className="text-gray-900">{f.unit_number}</dd>
              <dt className="text-gray-500">{t('reservationSign.purchasers', 'Purchasers')}</dt>
              <dd className="text-gray-900">{f.purchasers.map((p, i) => <span key={i} className="block">{p} <span className="text-gray-400 font-mono text-xs">{f.id_numbers[i]}</span></span>)}</dd>
              <dt className="text-gray-500">{t('reservationSign.price', 'Purchasing price')}</dt><dd className="text-gray-900">{f.price_text}</dd>
              <dt className="text-gray-500">{t('reservationSign.deposit', 'Holding deposit')}</dt><dd className="text-gray-900">{f.deposit_text}</dd>
              {f.special_terms && <><dt className="text-gray-500">{t('reservationSign.special', 'Special agreements')}</dt><dd className="text-gray-900 whitespace-pre-line">{f.special_terms}</dd></>}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-gray-600">
              {t('reservationSign.docIntro', 'Please check the document. Your signature, your name and the date are added to every page and to the signature field automatically.')}
            </p>
          )}
          <button onClick={() => openPdf(signedPdf ?? view.pdf_base64)}
            className="mt-4 w-full py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
            📄 {f ? t('reservationSign.viewPdf', 'View the full agreement (PDF)') : t('reservationSign.viewDoc', 'View the document (PDF)')}
          </button>
        </div>

        {phase === 'done' ? (
          <div className="bg-white rounded-2xl shadow-sm border border-green-100 p-5 text-center space-y-3">
            <p className="text-3xl">✅</p>
            <p className="font-semibold text-gray-900">{t('reservationSign.doneTitle', 'Signed, thank you!')}</p>
            <p className="text-sm text-gray-500">
              {view.signed && view.signer_name
                ? `${view.signer_name} · ${new Date(view.signed_at ?? '').toLocaleDateString(view.lang === 'de' ? 'de-DE' : 'en-GB')}`
                : t('reservationSign.doneText', 'The signed document is stored in the shared Drive folder for the client and the lawyer. You will also receive a copy by email.')}
            </p>
            {(signedPdf || view.signed) && (
              <button onClick={() => openPdf(signedPdf ?? view.pdf_base64)}
                className="w-full py-2.5 rounded-xl bg-hp-navy text-white text-sm font-medium">
                {t('reservationSign.download', 'Open signed document')}
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
            {inputs.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium text-gray-800">{t('reservationSign.inputsTitle', 'Please fill in')}</p>
                {inputs.map(i => (
                  <div key={i.key}>
                    <label className="block text-sm text-gray-700 mb-1">{i.label}{i.required && <span className="text-red-500"> *</span>}</label>
                    <input value={values[i.key] ?? ''} maxLength={120} spellCheck={false}
                      onChange={e => setValues(v => ({ ...v, [i.key]: e.target.value }))}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:border-orange-400" />
                    {i.hint && <p className="text-[11px] text-gray-400 mt-1">{i.hint}</p>}
                  </div>
                ))}
                <p className="text-[11px] text-gray-400">{t('reservationSign.inputsHint', 'Your entries are written into the document when you sign.')}</p>
              </div>
            )}
            {isRes && (
              <div className="text-sm text-hp-navy bg-orange-50 border border-orange-100 rounded-xl px-3 py-2.5">
                <p className="font-semibold mb-1">{t('reservationSign.howTitle', 'How to sign')}</p>
                <ol className="list-decimal list-inside space-y-0.5 text-[13px] text-gray-700">
                  <li>{t('reservationSign.how1', 'Sign with your finger in the white box.')}</li>
                  <li>{t('reservationSign.how2', 'Type your name in capital letters.')}</li>
                  <li>{t('reservationSign.how3', 'A second person signs too? Tap "Add a second signature". If not, skip it.')}</li>
                  <li>{t('reservationSign.how4', 'Tick the box and tap the orange button at the bottom.')}</li>
                </ol>
              </div>
            )}

            {/* Unterschrift 1 */}
            <div className={isRes ? 'border border-gray-200 rounded-xl p-3 space-y-3' : 'space-y-4'}>
              {isRes && <p className="text-sm font-semibold text-hp-navy">✍️ {t('reservationSign.sig1Title', 'Signature 1')}</p>}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-sm font-medium text-gray-800">{t('reservationSign.signHere', 'Your signature')}</p>
                  <button onClick={() => pad.current?.clear()} className="text-xs text-gray-500 hover:text-gray-800">{t('reservationSign.clear', 'Clear')}</button>
                </div>
                <SignaturePad ref={pad} onInk={onInk} />
                <p className="text-[11px] text-gray-400 mt-1">{t('reservationSign.signHint', 'Sign with your finger in the box.')}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-800 mb-1.5">{t('reservationSign.nameLabel', 'Your name in block letters')}</label>
                <input value={name} onChange={e => setName(e.target.value.replace(/[’‘ʼ´`]/g, "'").toUpperCase())}
                  autoCapitalize="characters" autoComplete="name" spellCheck={false} placeholder="JOHN SMITH"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base tracking-wide focus:outline-none focus:border-orange-400" />
                {name.trim().length >= 3 && !nameOk && (
                  <p className="text-[11px] text-red-600 mt-1">{t('reservationSign.errNameLatin', 'Please use Latin block letters (A-Z).')}</p>
                )}
              </div>
            </div>

            {/* Unterschrift 2 (optional) */}
            {isRes && (two ? (
              <div className="border border-gray-200 rounded-xl p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-hp-navy">✍️ {t('reservationSign.sig2Title', 'Signature 2')}</p>
                  <button onClick={removeSecond} className="text-xs text-gray-500 hover:text-red-600">✕ {t('reservationSign.removeSecond', 'Remove second signature')}</button>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-sm font-medium text-gray-800">{t('reservationSign.signHere2', 'Second person: signature')}</p>
                    <button onClick={() => pad2.current?.clear()} className="text-xs text-gray-500 hover:text-gray-800">{t('reservationSign.clear', 'Clear')}</button>
                  </div>
                  <SignaturePad ref={pad2} onInk={onInk2} />
                  <p className="text-[11px] text-gray-400 mt-1">{t('reservationSign.signHint2', 'The second person signs with their finger in this box.')}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-800 mb-1.5">{t('reservationSign.nameLabel2', 'Second person: name in block letters')}</label>
                  <input value={name2} onChange={e => setName2(e.target.value.replace(/[’‘ʼ´`]/g, "'").toUpperCase())}
                    autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="JANE SMITH"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base tracking-wide focus:outline-none focus:border-orange-400" />
                  {name2.trim().length >= 3 && !name2Ok && (
                    <p className="text-[11px] text-red-600 mt-1">{t('reservationSign.errNameLatin', 'Please use Latin block letters (A-Z).')}</p>
                  )}
                </div>
              </div>
            ) : (
              <button onClick={() => setTwo(true)}
                className="w-full py-3 rounded-xl border-2 border-dashed border-orange-300 text-orange-700 font-medium hover:bg-orange-50">
                ➕ {t('reservationSign.addSecond', 'Add a second signature (optional)')}
                <span className="block text-[11px] font-normal text-gray-500 mt-0.5">
                  {t('reservationSign.addSecondHint', 'Only if a second person from {{company}} signs as well. Otherwise just continue below.', { company: view.company_name })}
                </span>
              </button>
            ))}

            {/* Firmenstempel: gespeicherten verwenden, neues Foto hochladen oder ohne Stempel */}
            <div className="border border-gray-100 rounded-xl p-3 space-y-2">
              <p className="text-sm font-medium text-gray-800">{t('reservationSign.sealTitle', 'Company seal')}</p>
              {sealShown ? (
                <>
                  <img src={sealShown} alt="" className="h-24 object-contain bg-gray-50 rounded-lg p-1" />
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={useSeal} onChange={e => setUseSeal(e.target.checked)} className="w-4 h-4 rounded" />
                    {t('reservationSign.useSeal', 'Sign with company seal')}
                  </label>
                  {newSeal && <p className="text-[11px] text-gray-500">{t('reservationSign.sealSaved', 'This seal is saved for your future documents.')}</p>}
                </>
              ) : (
                <p className="text-xs text-gray-500">{t('reservationSign.sealNone', 'Optional: stamp your company seal on white paper, take a photo from above and upload it. We save it for your future documents.')}</p>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => pickSeal(e.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()} disabled={sealBusy}
                className="text-xs font-medium text-orange-600 hover:underline disabled:opacity-50">
                {sealBusy ? '…' : sealShown ? t('reservationSign.sealReplace', 'Upload a new seal photo') : t('reservationSign.sealUpload', 'Upload seal photo')}
              </button>
            </div>

            <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
              {t('reservationSign.placeDate', 'Place and date are added automatically:')} <b className="text-gray-700">{view.place}, {view.date}</b>
            </p>
            <label className="flex items-start gap-2.5 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="mt-0.5 w-4 h-4 rounded" />
              <span>{f
                ? (two
                  ? t('reservationSign.agree2', 'We have checked the agreement and sign it on behalf of {{company}}.', { company: view.company_name })
                  : t('reservationSign.agree', 'I have checked the agreement and sign it on behalf of {{company}}.', { company: view.company_name }))
                : t('reservationSign.agreeDoc', 'I have checked the document and sign it on behalf of {{company}}.', { company: view.company_name })}</span>
            </label>
            {err && <p className="text-sm text-red-600">{err}</p>}
            {isRes && phase === 'ready' && missing.length > 0 && (
              <p className="text-xs text-gray-500 text-center">{t('reservationSign.stillMissing', 'Still missing: {{list}}', { list: missing.join(', ') })}</p>
            )}
            <button onClick={submit} disabled={!canSubmit}
              className="w-full py-3 rounded-xl bg-hp-highlight text-white font-semibold disabled:opacity-40">
              {phase === 'sending' ? '…' : f
                ? (two ? t('reservationSign.submit2', 'Sign agreement (2 signatures)') : t('reservationSign.submit', 'Sign agreement'))
                : t('reservationSign.submitDoc', 'Sign document')}
            </button>
          </div>
        )}
        <p className="text-center text-[11px] text-gray-400">Happy Property</p>
      </div>
    </div>
  )
}
