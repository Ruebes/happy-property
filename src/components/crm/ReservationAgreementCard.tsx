import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReservationAgreement, ReservationBuyer } from '../../lib/crmTypes'
import { reservationCall, openPdfWindow, showPdf } from '../../lib/reservationAgreement'

// Reservierungsvertrag eines Deals: Status der Automatik (Ausweis erkannt,
// ausgefüllt, an den Bauträger geschickt), Käuferdaten korrigieren, Vorschau,
// von Hand senden. Erscheint nur, wenn der Bauträger der Wohnung eine Vorlage hat.

interface StatusResponse {
  row: ReservationAgreement | null
  template: { id: string; name: string } | null
  reason: string | null
  mode: 'on' | 'test' | 'off'
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
  const [busy, setBusy] = useState<'' | 'preview' | 'send' | 'test'>('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await reservationCall<StatusResponse>({ action: 'status', deal_id: dealId })
      setSt(r)
      setBuyers(r.row?.buyers ?? [])
    } catch {
      setSt(null)
    }
  }, [dealId])
  useEffect(() => { load() }, [load])

  if (!st?.template) return null
  const row = st.row
  const statusLabel: Record<string, string> = {
    wartet_ausweis: t('reservation.status.waiting', 'Wartet auf Ausweis'),
    pruefen:        t('reservation.status.review', 'Bitte prüfen'),
    gesendet:       t('reservation.status.sent', 'An Bauträger geschickt'),
    unterschrieben: t('reservation.status.signed', 'Unterschrieben, an der Wohnung abgelegt'),
    fehler:         t('reservation.status.error', 'Fehler beim Versand'),
    abgebrochen:    t('reservation.status.cancelled', 'Abgebrochen'),
  }
  const fmtDate = (s: string) => new Date(s).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const edited = editing ? buyers.filter(b => b.full_name.trim()) : undefined

  const preview = async () => {
    const win = openPdfWindow()
    setBusy('preview'); setMsg(null)
    try {
      const r = await reservationCall<{ pdf_base64: string; buyers: ReservationBuyer[]; reasons: string[] }>({ action: 'preview', deal_id: dealId, buyers: edited })
      showPdf(win, r.pdf_base64)
      if (!editing) setBuyers(r.buyers)
      if (r.reasons.length) setMsg({ ok: false, text: r.reasons.join(' · ') })
    } catch (e) {
      win?.close()
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setBusy('') }
  }

  const send = async (test: boolean) => {
    if (!test && !window.confirm(t('reservation.confirmSend', 'Reservierungsvertrag jetzt an den Bauträger schicken?'))) return
    setBusy(test ? 'test' : 'send'); setMsg(null)
    try {
      const r = await reservationCall<{ ok: boolean; errors: string[] }>({ action: 'send', deal_id: dealId, test, buyers: edited })
      setMsg(r.errors.length
        ? { ok: false, text: r.errors.join(' · ') }
        : { ok: true, text: test ? t('reservation.testSent', 'Test ging an dich (Mail + WhatsApp).') : t('reservation.sentOk', 'Vertrag ist an den Bauträger raus.') })
      setEditing(false)
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
      {row?.status === 'gesendet' && (
        <p className="text-xs text-gray-500">
          {t('reservation.waitingSigned', 'Wartet auf die unterschriebene Fassung im Drive-Ordner, wird dann automatisch an der Wohnung unter Verträge abgelegt.')}
        </p>
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
                <div key={i} className="grid grid-cols-[1fr_9rem_auto] gap-1.5 items-center">
                  <input value={b.full_name} className={inputCls} placeholder={t('reservation.name', 'Vor- und Nachname')}
                    onChange={e => setBuyers(bs => bs.map((x, j) => j === i ? { ...x, full_name: e.target.value } : x))} />
                  <input value={b.document_number} className={`${inputCls} font-mono`} placeholder={t('reservation.number', 'Passnummer')}
                    onChange={e => setBuyers(bs => bs.map((x, j) => j === i ? { ...x, document_number: e.target.value } : x))} />
                  <button onClick={() => setBuyers(bs => bs.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500 text-sm px-1">✕</button>
                </div>
              ))}
              <button onClick={() => setBuyers(bs => [...bs, { full_name: '', document_number: '' }])}
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
          className={`${btn} border-transparent text-white bg-[#ff795d] hover:opacity-90`}>
          {busy === 'send' ? '…' : `📤 ${row?.status === 'gesendet' || row?.status === 'unterschrieben' ? t('reservation.resend', 'Erneut an Bauträger senden') : t('reservation.send', 'An Bauträger senden')}`}
        </button>
      </div>
    </div>
  )
}
