import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { showPdf } from '../lib/reservationAgreement'
import { processSealImage } from '../lib/sealImage'
import SignaturePad, { type SignaturePadHandle } from './SignaturePad'

// Unterschriftsseite beim Zwei-Parteien-Vertrag (Flora Panorama), kein Login, nur Token:
//   Bauträger /sign/r/:token: die Direktoren unterschreiben einzeln, Firmenstempel wählbar.
//   Kunde /sign/k/:token: erst nach dem Bauträger; je Käufer eine Unterschrift.
// Die Namen stehen fest und kommen vom Server, getippt wird nichts. Datum, Ablage und Versand
// übernimmt das System. Sprache = Sprache des Empfängers aus dem CRM.

interface Signer { key: string; name: string; signed: boolean; signed_at: string | null }
export interface TwoPartyView {
  two_party: true
  side: 'buyer' | 'vendor'
  test: boolean
  lang: 'de' | 'en'
  company_name: string
  title: string
  property_name: string
  unit_number: string
  type_label: string
  price_text: string
  deposit_text: string
  non_refundable_text: string
  deposit: string | null
  special_terms: string | null
  waiting_vendor: boolean
  signers: Signer[]
  own_done: boolean
  other_done: boolean
  complete: boolean
  seal: string | null
  place: string
  date: string
  bank: { account_name?: string; bank_name?: string; iban?: string; account_number?: string; swift?: string } | null
  pdf_base64: string
}

const ACTION = { buyer: 'buyer_submit', vendor: 'sign_submit' } as const

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

function SignerBox({ token, signer, view, sealOn, newSeal, onSigned }: {
  token: string; signer: Signer; view: TwoPartyView; sealOn: boolean; newSeal: string | null; onSigned: (v: TwoPartyView) => void
}) {
  const { i18n } = useTranslation()
  const t = useMemo(() => i18n.getFixedT(view.lang), [view.lang, i18n])
  const pad = useRef<SignaturePadHandle | null>(null)
  const [hasInk, setHasInk] = useState(false)
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const onInk = useCallback((v: boolean) => setHasInk(v), [])

  const submit = async () => {
    if (!pad.current) return
    setBusy(true); setErr('')
    try {
      onSigned(await call<TwoPartyView>({
        action: ACTION[view.side], token, signer_key: signer.key, signature: pad.current.toPng(),
        ...(view.side === 'vendor' ? { use_seal: sealOn, seal: newSeal ?? undefined } : {}),
      }))
    } catch (e) {
      const m = (e as Error).message
      setErr(m === 'invalid_signature' ? t('reservationSign.errSignature', 'Please sign in the box with your finger.')
        : m === 'already_signed' ? t('reservationSign.errAlready', 'This document has already been signed.')
        : m === 'vendor_first' ? t('twoPartySign.vendorFirst', 'The developer has to sign first.')
        : m === 'not_found' ? t('reservationSign.notFound', 'This signing link is not valid (anymore). Please contact Happy Property.')
        : t('reservationSign.errGeneric', 'Something went wrong. Please try again in a minute.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="border border-gray-200 rounded-xl p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-hp-navy">✍️ {t('twoPartySign.signAs', 'Signature of {{name}}', { name: signer.name })}</p>
        <button onClick={() => pad.current?.clear()} className="text-xs text-gray-500 hover:text-gray-800">{t('reservationSign.clear', 'Clear')}</button>
      </div>
      <SignaturePad ref={pad} onInk={onInk} />
      <label className="flex items-start gap-2.5 text-sm text-gray-700 cursor-pointer">
        <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="mt-0.5 w-4 h-4 rounded" />
        <span>{view.side === 'buyer'
          ? t('twoPartySign.agreeBuyer', 'I have read the agreement and I sign it.')
          : t('twoPartySign.agreeVendor', 'I have checked the agreement and sign it on behalf of {{company}}.', { company: view.company_name })}</span>
      </label>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button onClick={submit} disabled={!hasInk || !agree || busy}
        className="w-full py-3 rounded-xl bg-hp-highlight text-white font-semibold disabled:opacity-40">
        {busy ? '…' : t('twoPartySign.submit', '{{name}} signs', { name: signer.name })}
      </button>
    </div>
  )
}

export default function TwoPartySign({ token, initial }: { token: string; initial: TwoPartyView }) {
  const { i18n } = useTranslation()
  const [view, setView] = useState<TwoPartyView>(initial)
  const t = useMemo(() => i18n.getFixedT(view.lang), [view.lang, i18n])
  const [useSeal, setUseSeal] = useState(!!initial.seal)
  const [newSeal, setNewSeal] = useState<string | null>(null)
  const [sealBusy, setSealBusy] = useState(false)
  const [sealErr, setSealErr] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const openPdf = () => { const w = window.open('', '_blank'); showPdf(w, view.pdf_base64) }
  const pickSeal = async (file: File | undefined) => {
    if (!file) return
    setSealErr(''); setSealBusy(true)
    try {
      setNewSeal(await processSealImage(file))
      setUseSeal(true)
    } catch (e) {
      setSealErr((e as Error).message === 'seal_not_found'
        ? t('reservationSign.errSealNotFound', 'No seal found on the photo. Please stamp on white paper and take a sharp photo from above.')
        : t('reservationSign.errSealImage', 'The photo could not be read. Please try another one.'))
    } finally {
      setSealBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const open = view.signers.filter(s => !s.signed)
  const openNames = open.map(s => s.name).join(', ')
  const isBuyer = view.side === 'buyer'
  const sealShown = newSeal ?? view.seal
  const bank = view.bank

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
            <dt className="text-gray-500">{t('reservationSign.property', 'Property')}</dt><dd className="text-gray-900">{view.property_name}</dd>
            <dt className="text-gray-500">{t('reservationSign.unit', 'Unit')}</dt><dd className="text-gray-900">{view.unit_number} · {view.type_label}</dd>
            <dt className="text-gray-500">{t('twoPartySign.pointPrice', 'Purchase price')}</dt><dd className="text-gray-900">{view.price_text}</dd>
            {view.special_terms && <><dt className="text-gray-500">{t('reservationSign.special', 'Special agreements')}</dt><dd className="text-gray-900 whitespace-pre-line">{view.special_terms}</dd></>}
          </dl>
          {!view.waiting_vendor && (
            <button onClick={openPdf} className="mt-4 w-full py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
              📄 {t('reservationSign.viewPdf', 'View the full agreement (PDF)')}
            </button>
          )}
        </div>

        {view.complete ? (
          <div className="bg-white rounded-2xl shadow-sm border border-green-100 p-5 text-center space-y-3">
            <p className="text-3xl">✅</p>
            <p className="font-semibold text-gray-900">{t('twoPartySign.completeTitle', 'Signed by both sides')}</p>
            <p className="text-sm text-gray-500">{isBuyer
              ? t('twoPartySign.completeBuyer', 'You will receive the final agreement by email and WhatsApp. Next step: transfer the deposit of {{deposit}}.', { deposit: view.deposit_text })
              : t('twoPartySign.completeVendor', 'The final agreement comes by email and WhatsApp.')}</p>
            {isBuyer && bank && (
              <div className="text-left text-sm bg-gray-50 rounded-xl px-3 py-2.5">
                <p className="font-medium text-gray-800 mb-1">{t('twoPartySign.bankTitle', 'Bank details for the deposit')}</p>
                {bank.account_name && <p>{bank.account_name}</p>}
                {bank.bank_name && <p>{bank.bank_name}</p>}
                {bank.iban ? <p className="font-mono text-xs">IBAN {bank.iban}</p> : bank.account_number && <p className="font-mono text-xs">{bank.account_number}</p>}
                {bank.swift && <p className="font-mono text-xs">SWIFT {bank.swift}</p>}
              </div>
            )}
          </div>
        ) : view.waiting_vendor ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-center">
            <p className="text-3xl mb-2">⏳</p>
            <p className="text-sm text-gray-600">{t('twoPartySign.waiting', 'The developer signs first. You will receive your link by email and WhatsApp as soon as the agreement is ready for you.')}</p>
          </div>
        ) : view.own_done ? (
          <div className="bg-white rounded-2xl shadow-sm border border-green-100 p-5 text-center space-y-2">
            <p className="text-3xl">✅</p>
            <p className="font-semibold text-gray-900">{t('reservationSign.doneTitle', 'Signed, thank you!')}</p>
            <p className="text-sm text-gray-500">{t('twoPartySign.ownDoneVendor', 'Thank you! The agreement now goes to the client for signature. As soon as they have signed, you will receive the final PDF by email and WhatsApp.')}</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
            {isBuyer && (
              <div className="text-sm bg-orange-50 border border-orange-100 rounded-xl px-3 py-2.5 space-y-1.5">
                <p className="font-semibold text-hp-navy">{t('twoPartySign.buyerPoints', 'The key points before you sign')}</p>
                <p className="text-gray-700"><b>{t('twoPartySign.pointDeposit', 'Deposit (40% of the price)')}:</b> {view.deposit_text}, {t('twoPartySign.pointDue', 'due within 5 days of signing. If it is not received in time, the agreement ends automatically.')}</p>
                <p className="text-gray-700"><b>{t('twoPartySign.pointNonRefund', 'Of this, non-refundable if you do not sign the contract of sale')}:</b> {view.non_refundable_text}</p>
                {view.other_done && <p className="text-green-700">✓ {t('twoPartySign.vendorDoneNote', 'The developer has already signed.')}</p>}
              </div>
            )}
            <p className="text-sm text-gray-600">{isBuyer
              ? t('twoPartySign.howBuyer', 'Please read the PDF, then sign with your finger in the white box and tick the box.')
              : t('twoPartySign.howVendor', 'Please check the PDF. Each person signs in their own box, which also works one after the other through the same link.')}</p>
            {view.signers.filter(s => s.signed).map(s => (
              <p key={s.key} className="text-sm text-green-700">✅ {s.name} · {t('twoPartySign.signerDone', 'Signed')}</p>
            ))}
            {open.length > 0 && view.signers.some(s => s.signed) && (
              <p className="text-xs text-gray-500">{t(isBuyer ? 'twoPartySign.partialBuyer' : 'twoPartySign.partialVendor', 'Still missing: {{names}}. This also works later through the same link.', { names: openNames })}</p>
            )}

            {!isBuyer && (
              <div className="border border-gray-100 rounded-xl p-3 space-y-2">
                <p className="text-sm font-medium text-gray-800">{t('reservationSign.sealTitle', 'Company seal')}</p>
                {sealShown ? (
                  <>
                    <img src={sealShown} alt="" className="h-24 object-contain bg-gray-50 rounded-lg p-1" />
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={useSeal} onChange={e => setUseSeal(e.target.checked)} className="w-4 h-4 rounded" />
                      {t('reservationSign.useSeal', 'Sign with company seal')}
                    </label>
                  </>
                ) : (
                  <p className="text-xs text-gray-500">{t('reservationSign.sealNone', 'Optional: stamp your company seal on white paper, take a photo from above and upload it. We save it for your future documents.')}</p>
                )}
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => pickSeal(e.target.files?.[0])} />
                <button onClick={() => fileRef.current?.click()} disabled={sealBusy} className="text-xs font-medium text-orange-600 hover:underline disabled:opacity-50">
                  {sealBusy ? '…' : sealShown ? t('reservationSign.sealReplace', 'Upload a new seal photo') : t('reservationSign.sealUpload', 'Upload seal photo')}
                </button>
                {sealErr && <p className="text-xs text-red-600">{sealErr}</p>}
              </div>
            )}

            {open.map(s => (
              <SignerBox key={s.key} token={token} signer={s} view={view} sealOn={useSeal && !!sealShown} newSeal={newSeal} onSigned={setView} />
            ))}
          </div>
        )}
        <p className="text-center text-[11px] text-gray-400">Happy Property</p>
      </div>
    </div>
  )
}
