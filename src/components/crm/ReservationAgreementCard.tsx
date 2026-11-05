import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReservationAgreement, ReservationBuyer } from '../../lib/crmTypes'
import { reservationCall, openPdfWindow, showPdf } from '../../lib/reservationAgreement'
import { supabase } from '../../lib/supabase'

// Reservierungsvertrag eines Deals: Status der Automatik (Ausweis erkannt,
// ausgefüllt, an den Bauträger geschickt), Käuferdaten korrigieren, Vorschau,
// von Hand senden. Erscheint nur, wenn der Bauträger der Wohnung eine Vorlage hat.

interface StatusResponse {
  row: ReservationAgreement | null
  template: { id: string; name: string } | null
  reason: string | null
  mode: 'on' | 'test' | 'off'
  reservation_notes?: string | null
  /** Nur Zwei-Parteien-Vertrag (Flora Panorama) */
  two_party?: {
    price_net: number | null
    title_deed_default: number | null
    parts: Array<{ side: 'buyer' | 'vendor'; name: string; at: string }>
    vendor_signers: Array<{ key: string; name: string }>
    buyer_count: number
  }
}

const STATUS_STYLE: Record<string, string> = {
  wartet_ausweis: 'bg-gray-100 text-gray-600',
  pruefen:        'bg-amber-100 text-amber-800',
  gesendet:       'bg-green-100 text-green-700',
  unterschrieben: 'bg-green-600 text-white',
  fehler:         'bg-red-100 text-red-700',
  abgebrochen:    'bg-gray-100 text-gray-400',
}

export default function ReservationAgreementCard({ dealId }: { dealId: string }) {
  const { t, i18n } = useTranslation()
  const [st, setSt] = useState<StatusResponse | null>(null)
  const [buyers, setBuyers] = useState<ReservationBuyer[]>([])
  const [editing, setEditing] = useState(false)
  // Sven hat Käuferdaten von Hand geändert: diese Liste gilt, bis gesendet wurde
  const [manual, setManualState] = useState(false)
  const manualRef = useRef(false)
  const setManual = (v: boolean) => { manualRef.current = v; setManualState(v) }
  const [busy, setBusy] = useState<'' | 'preview' | 'send' | 'test'>('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Sondervereinbarungen (deals.reservation_notes, Deutsch); kommen übersetzt in den Vertrag
  const [notes, setNotes] = useState('')
  const [notesSaved, setNotesSaved] = useState('')
  const [notesBusy, setNotesBusy] = useState(false)
  const notesDirtyRef = useRef(false)
  // Zwei-Parteien-Vertrag: Nettopreis und Betrag (g), beides je Vertrag
  const [netPrice, setNetPrice] = useState('')
  const [titleDeed, setTitleDeed] = useState('')
  const contractLoaded = useRef(false)

  const load = useCallback(async () => {
    try {
      const r = await reservationCall<StatusResponse>({ action: 'status', deal_id: dealId })
      setSt(r)
      if (!manualRef.current) setBuyers(r.row?.buyers ?? [])
      setNotesSaved(r.reservation_notes ?? '')
      if (!notesDirtyRef.current) setNotes(r.reservation_notes ?? '')
      if (r.two_party && !contractLoaded.current) {
        contractLoaded.current = true
        setNetPrice(String(r.row?.contract?.net_price ?? r.two_party.price_net ?? ''))
        setTitleDeed(String(r.row?.contract?.title_deed_amount ?? r.two_party.title_deed_default ?? ''))
      }
    } catch {
      setSt(null)
    }
  }, [dealId])
  useEffect(() => { load() }, [load])

  if (!st?.template) return null
  const row = st.row
  const two = st.two_party ?? null
  const contract = two ? { net_price: Number(netPrice.replace(',', '.')) || null, title_deed_amount: Number(titleDeed.replace(',', '.')) || null } : undefined
  const vendorParts = two?.parts.filter(p => p.side === 'vendor') ?? []
  const buyerParts = two?.parts.filter(p => p.side === 'buyer') ?? []
  const copyLink = (url: string) => {
    navigator.clipboard?.writeText(url)
      .then(() => setMsg({ ok: true, text: t('reservation.linkCopied', 'Unterschriftslink kopiert') }))
      .catch(() => setMsg({ ok: false, text: url }))
  }
  const statusLabel: Record<string, string> = {
    wartet_ausweis: two ? t('reservation.status.waitingData', 'Wartet auf Ausweis und Adresse') : t('reservation.status.waiting', 'Wartet auf Ausweis'),
    pruefen:        t('reservation.status.review', 'Bitte prüfen'),
    gesendet:       two ? t('reservation.status.twoRunning', 'Unterschriften laufen') : t('reservation.status.sent', 'An Bauträger geschickt'),
    unterschrieben: t('reservation.status.signed', 'Unterschrieben, an der Wohnung abgelegt'),
    fehler:         t('reservation.status.error', 'Fehler beim Versand'),
    abgebrochen:    t('reservation.status.cancelled', 'Abgebrochen'),
  }
  const fmtDate = (s: string) => new Date(s).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const edited = manual ? buyers.filter(b => b.full_name.trim()) : undefined
  const notesDirty = notes.trim() !== notesSaved.trim()
  const notesEn = row?.special_terms && row.special_terms.de === notesSaved.trim() ? row.special_terms.en : ''

  const saveNotes = async () => {
    setNotesBusy(true); setMsg(null)
    const value = notes.trim() || null
    const { error } = await supabase.from('deals').update({ reservation_notes: value }).eq('id', dealId)
    setNotesBusy(false)
    if (error) { setMsg({ ok: false, text: error.message }); return }
    notesDirtyRef.current = false
    setNotesSaved(value ?? '')
    setMsg({ ok: true, text: row?.status === 'gesendet' || row?.status === 'unterschrieben'
      ? t('reservation.notesSavedResend', 'Gespeichert. Der Bauträger hat den Vertrag schon, für den neuen Stand bitte erneut senden.')
      : t('reservation.notesSaved', 'Gespeichert. Kommt übersetzt in den Vertrag (Vorschau zeigt den Wortlaut).') })
  }

  const preview = async () => {
    const win = openPdfWindow()
    setBusy('preview'); setMsg(null)
    try {
      const r = await reservationCall<{ pdf_base64: string; buyers: ReservationBuyer[]; reasons: string[] }>({ action: 'preview', deal_id: dealId, buyers: edited, contract })
      showPdf(win, r.pdf_base64)
      if (!manual) setBuyers(r.buyers)
      if (r.reasons.length) setMsg({ ok: false, text: r.reasons.join(' · ') })
    } catch (e) {
      win?.close()
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setBusy('') }
  }

  const send = async (test: boolean) => {
    if (!test && !window.confirm(t('reservation.confirmSend', 'Reservierungsvertrag jetzt an den Bauträger schicken?'))) return
    // Zwei-Parteien: neu senden macht vorhandene Unterschriften ungültig
    const force = !test && !!two?.parts.length
    if (force && !window.confirm(t('reservation.confirmResign', 'Achtung: Es liegen schon Unterschriften vor ({{names}}). Neu senden macht sie ungültig, alle müssen noch einmal unterschreiben. Wirklich neu senden?', { names: two!.parts.map(p => p.name).join(', ') }))) return
    setBusy(test ? 'test' : 'send'); setMsg(null)
    try {
      const r = await reservationCall<{ ok: boolean; errors: string[] }>({ action: 'send', deal_id: dealId, test, buyers: edited, contract, force })
      setMsg(r.errors.length
        ? { ok: false, text: two ? t('reservation.sentOpen', 'Raus. Noch offen, wird automatisch wiederholt: {{list}}', { list: r.errors.join(' · ') }) : r.errors.join(' · ') }
        : { ok: true, text: test ? t('reservation.testSent', 'Test ging an dich (Mail + WhatsApp).') : t('reservation.sentOk', 'Vertrag ist an den Bauträger raus.') })
      setEditing(false)
      if (!test) setManual(false)
      await load()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setBusy('') }
  }

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-orange-400'
  const btn = 'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50'

  return (
    <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-800">📄 {t('reservation.title', 'Reservierungsvertrag')}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {t('reservation.subtitle', 'Wird automatisch ausgefüllt, sobald der Ausweis im Drive-Ordner liegt.')} · {st.template.name}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {st.mode !== 'on' && (
            <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-700">
              {st.mode === 'test' ? t('reservation.modeTest', 'Testmodus') : t('reservation.modeOff', 'Aus')}
            </span>
          )}
          <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${STATUS_STYLE[row?.status ?? 'wartet_ausweis']}`}>
            {row ? statusLabel[row.status] : t('reservation.status.notStarted', 'Startet mit Phase Reservierung')}
          </span>
        </div>
      </div>

      {(row?.status === 'gesendet' || row?.status === 'unterschrieben') && row.sent_at && (
        <p className="text-xs text-green-700">
          {t('reservation.sentAt', 'Geschickt am')} {fmtDate(row.sent_at)}{row.sent_to?.length ? ` · ${row.sent_to.join(', ')}` : ''}
        </p>
      )}
      {two && row?.address_token && (
        <div className="bg-white rounded-lg p-3 space-y-1 text-xs text-gray-700">
          <p>{row.customer_data?.at ? '✅' : '⏳'} <b>{t('reservation.customerData', 'Adresse vom Kunden')}:</b> {row.customer_data?.at
            ? `${fmtDate(row.customer_data.at)}: ${[row.customer_data.street, `${row.customer_data.postal_code ?? ''} ${row.customer_data.city ?? ''}`.trim(), row.customer_data.country_code || row.customer_data.country_other].filter(Boolean).join(', ')}${row.customer_data.second ? ` · ${t('reservation.customerSecond', 'Zweiter Käufer')}: ${row.customer_data.second.first_name} ${row.customer_data.second.last_name}` : ''}`
            : t('reservation.customerDataOpen', 'noch nicht eingetragen')}</p>
          {!row.customer_data?.at && <button onClick={() => copyLink(`${window.location.origin}/sign/a/${row.address_token}`)} className="text-orange-600 hover:underline block">🔗 {t('reservation.copyAddressLink', 'Adresslink für den Kunden kopieren')}</button>}
        </div>
      )}
      {two && !!row?.auto_check?.points?.length && (
        <details className="bg-white rounded-lg p-3 text-xs text-gray-700">
          <summary className="cursor-pointer">{row.auto_check.ok ? '✅' : '⚠️'} {t('reservation.autoCheck', 'Prüfung vor dem Versand')} · {row.auto_check.at ? fmtDate(row.auto_check.at) : ''}</summary>
          <div className="mt-2 space-y-1">
            {row.auto_check.points.map(p => <p key={p.key}>{p.ok ? '✓' : '✗'} {p.text}</p>)}
          </div>
        </details>
      )}
      {two && row?.status === 'gesendet' && (
        <div className="bg-white rounded-lg p-3 space-y-1 text-xs text-gray-700">
          <p>{vendorParts.length >= two.vendor_signers.length ? '✅' : '⏳'} <b>{t('reservation.twoVendor', 'Bauträger')}:</b> {vendorParts.length ? vendorParts.map(p => `${p.name} ${fmtDate(p.at)}`).join(' · ') : t('reservation.twoVendorOpen', 'noch nicht unterschrieben')}</p>
          <p>{row.buyer_signed_at ? '✅' : '⏳'} <b>{t('reservation.twoBuyer', 'Kunde')}:</b> {buyerParts.length ? buyerParts.map(p => `${p.name} ${fmtDate(p.at)}`).join(' · ') : (row.link_delivery?.['mail:buyer']?.at || row.link_delivery?.['wa:buyer']?.at ? t('reservation.twoBuyerSent', 'Link ist raus, noch nicht unterschrieben') : t('reservation.twoBuyerWait', 'bekommt seinen Link, sobald der Bauträger unterschrieben hat'))}</p>
          {row.sign_token && <button onClick={() => copyLink(`${window.location.origin}/sign/r/${row.sign_token}`)} className="text-orange-600 hover:underline block">🔗 {t('reservation.copyLink', 'Unterschriftslink für den Bauträger kopieren')}</button>}
          {row.buyer_sign_token && vendorParts.length >= two.vendor_signers.length && <button onClick={() => copyLink(`${window.location.origin}/sign/k/${row.buyer_sign_token}`)} className="text-orange-600 hover:underline block">🔗 {t('reservation.copyBuyerLink', 'Unterschriftslink für den Kunden kopieren')}</button>}
        </div>
      )}
      {two && row?.status === 'unterschrieben' && row.completed_at && (
        <p className="text-xs text-green-700">✍️ {t('reservation.twoDone', 'Von beiden Seiten unterschrieben')} · {fmtDate(row.completed_at)} · {two.parts.map(p => p.name).join(', ')}</p>
      )}
      {!two && row?.status === 'gesendet' && (
        <p className="text-xs text-gray-500">
          {t('reservation.waitingSigned', 'Wartet auf die digitale Unterschrift des Bauträgers (Link per WhatsApp + Mail). Danach liegt der Vertrag automatisch im Drive-Ordner und an der Wohnung unter Verträge.')}
        </p>
      )}
      {!two && row?.status === 'unterschrieben' && row.seller_signer_name && row.seller_signed_at && (
        <p className="text-xs text-green-700">
          ✍️ {t('reservation.signedBy', 'Unterschrieben von')} {row.seller_signer_name} · {fmtDate(row.seller_signed_at)}
        </p>
      )}
      {!two && row?.sign_token && row.status !== 'unterschrieben' && (
        <button onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/sign/r/${row.sign_token}`).then(() => setMsg({ ok: true, text: t('reservation.linkCopied', 'Unterschriftslink kopiert') })).catch(() => setMsg({ ok: false, text: `${window.location.origin}/sign/r/${row.sign_token}` })) }}
          className="text-xs text-orange-600 hover:underline">
          🔗 {t('reservation.copyLink', 'Unterschriftslink für den Bauträger kopieren')}
        </button>
      )}
      {row?.review_reason && row.status === 'pruefen' && (
        <p className="text-xs text-amber-800 bg-amber-100/70 rounded-lg px-3 py-2">{row.review_reason}</p>
      )}
      {row?.error && <p className="text-xs text-red-600">{row.error}</p>}

      {(buyers.length > 0 || editing) && (
        <div className="bg-white rounded-lg p-3 space-y-1.5">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('reservation.buyers', 'Käufer laut Ausweis')}</p>
          {editing ? (
            <>
              {buyers.map((b, i) => (
                <div key={i} className="space-y-1.5">
                <div className="grid grid-cols-[1fr_9rem_auto] gap-1.5 items-center">
                  <input value={b.full_name} className={inputCls} placeholder={t('reservation.name', 'Vor- und Nachname')}
                    onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, full_name: e.target.value } : x)) }} />
                  <input value={b.document_number} className={`${inputCls} font-mono`} placeholder={t('reservation.number', 'Passnummer')}
                    onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, document_number: e.target.value } : x)) }} />
                  <button onClick={() => { setManual(true); setBuyers(bs => bs.filter((_, j) => j !== i)) }} className="text-gray-400 hover:text-red-500 text-sm px-1">✕</button>
                </div>
                {/* Zwei-Parteien-Vertrag: wir füllen alles aus, der Kunde sieht den Vertrag erst nach dem Bauträger */}
                {two && (
                  <div className="grid grid-cols-2 gap-1.5 pb-2 border-b border-gray-100">
                    <select value={b.salutation ?? ''} className={inputCls} onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, salutation: e.target.value } : x)) }}>
                      <option value="">{t('reservation.salutation', 'Anrede')}</option>
                      <option value="MR.">MR.</option><option value="MRS.">MRS.</option><option value="MS.">MS.</option>
                    </select>
                    <select value={b.document_type === 'id_card' ? 'id_card' : 'passport'} className={inputCls} onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, document_type: e.target.value } : x)) }}>
                      <option value="passport">{t('reservation.docPassport', 'Reisepass')}</option>
                      <option value="id_card">{t('reservation.docIdCard', 'Personalausweis')}</option>
                    </select>
                    <input value={b.nationality ?? ''} className={inputCls} placeholder={t('reservation.nationality', 'Staatsangehörigkeit, z. B. German')}
                      onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, nationality: e.target.value } : x)) }} />
                    <input value={b.phone ?? ''} className={inputCls} placeholder={i === 0 ? t('reservation.phoneLead', 'Telefon (leer = aus dem CRM)') : t('reservation.phone', 'Telefon')}
                      onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, phone: e.target.value } : x)) }} />
                    <input value={b.address ?? ''} className={`${inputCls} col-span-2`} placeholder={t('reservation.address', 'Adresse: Straße, PLZ Ort, Land')}
                      onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, address: e.target.value } : x)) }} />
                    <input value={b.email ?? ''} className={`${inputCls} col-span-2`} placeholder={i === 0 ? t('reservation.emailLead', 'E-Mail (leer = aus dem CRM)') : t('reservation.email', 'E-Mail')}
                      onChange={e => { setManual(true); setBuyers(bs => bs.map((x, j) => j === i ? { ...x, email: e.target.value } : x)) }} />
                  </div>
                )}
                </div>
              ))}
              <button onClick={() => { setManual(true); setBuyers(bs => [...bs, { full_name: '', document_number: '' }]) }}
                className="text-xs text-orange-600 hover:underline">+ {t('reservation.addBuyer', 'Käufer hinzufügen')}</button>
            </>
          ) : buyers.map((b, i) => (
            <p key={i} className="text-sm text-gray-800">
              {b.full_name} <span className="font-mono text-gray-500">· {b.document_number || '—'}</span>
              {b.file_name && <span className="text-[11px] text-gray-400"> · {b.file_name}</span>}
            </p>
          ))}
        </div>
      )}

      {two && (
        <div className="bg-white rounded-lg p-3 space-y-1.5">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('reservation.contractTitle', 'Vertragswerte')}</p>
          <div className="grid grid-cols-2 gap-1.5">
            <label className="text-xs text-gray-600">{t('reservation.netPrice', 'Nettopreis in Euro')}
              <input value={netPrice} inputMode="decimal" onChange={e => setNetPrice(e.target.value)} className={`${inputCls} mt-0.5`} />
            </label>
            <label className="text-xs text-gray-600">{t('reservation.titleDeed', 'Betrag (g) bei Besitzurkunde, Euro netto')}
              <input value={titleDeed} inputMode="decimal" onChange={e => setTitleDeed(e.target.value)} className={`${inputCls} mt-0.5`} />
            </label>
          </div>
          <p className="text-[11px] text-gray-400">{t('reservation.contractHint', 'Alle Teilbeträge rechnet das System aus dem Nettopreis. Kontrolle über die Vorschau.')}</p>
        </div>
      )}

      <div className="bg-white rounded-lg p-3 space-y-1.5">
        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('reservation.notes', 'Sondervereinbarungen')}</p>
        <textarea value={notes} rows={2} maxLength={1500}
          onChange={e => { notesDirtyRef.current = true; setNotes(e.target.value) }}
          placeholder={t('reservation.notesPh', 'Optional, auf Deutsch. Kommt übersetzt ins Englische in den Vertrag.')}
          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-400 resize-y" />
        {notesDirty ? (
          <button onClick={saveNotes} disabled={notesBusy} className={`${btn} border-gray-200 text-gray-600 bg-white hover:bg-gray-50`}>
            {notesBusy ? '…' : `💾 ${t('common.save', 'Speichern')}`}
          </button>
        ) : notesEn ? (
          <p className="text-xs text-gray-500"><span className="font-medium">{t('reservation.notesEn', 'Im Vertrag:')}</span> {notesEn}</p>
        ) : null}
      </div>

      {msg && <p className={`text-xs ${msg.ok ? 'text-green-700' : 'text-amber-800'}`}>{msg.text}</p>}

      <div className="flex flex-wrap gap-2">
        <button onClick={preview} disabled={!!busy} className={`${btn} border-gray-200 text-gray-600 bg-white hover:bg-gray-50`}>
          {busy === 'preview' ? '…' : `👁 ${t('reservation.preview', 'Vorschau')}`}
        </button>
        <button onClick={() => { if (!editing && !buyers.length) setBuyers([{ full_name: '', document_number: '' }]); setEditing(v => !v) }}
          disabled={!!busy} className={`${btn} border-gray-200 text-gray-600 bg-white hover:bg-gray-50`}>
          ✏️ {editing ? t('reservation.editDone', 'Bearbeiten beenden') : t('reservation.edit', 'Käuferdaten bearbeiten')}
        </button>
        <button onClick={() => send(true)} disabled={!!busy} className={`${btn} border-gray-200 text-gray-600 bg-white hover:bg-gray-50`}>
          {busy === 'test' ? '…' : `🧪 ${t('reservation.test', 'Test an mich')}`}
        </button>
        <button onClick={() => send(false)} disabled={!!busy}
          className={`${btn} border-transparent text-white bg-hp-highlight hover:opacity-90`}>
          {busy === 'send' ? '…' : `📤 ${row?.status === 'gesendet' || row?.status === 'unterschrieben' ? t('reservation.resend', 'Erneut an Bauträger senden') : t('reservation.send', 'An Bauträger senden')}`}
        </button>
      </div>
    </div>
  )
}
