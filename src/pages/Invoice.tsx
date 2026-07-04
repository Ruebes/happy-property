import { useEffect, useState, type ReactNode, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'
import { eurFmt, dateFmt } from '../lib/invoiceVat'

// ── Öffentliche Rechnung (/re/:token) — Happy-Property-CI, mit PDF-Download ─────
const CORAL = '#ff795d', DARK = '#1b1b22', GOLD = '#C2A15E'
const SERIF = "'Playfair Display',Georgia,serif"
const SANS = "'Montserrat','Helvetica Neue',Arial,sans-serif"

interface Snap { [k: string]: string | null | undefined }
interface ItemRow { description: string; quantity: number; unit_price_net: number; line_net: number }
interface InvoicePayload {
  invoice_number: string
  token: string
  issuer_snapshot: Snap | null
  customer_snapshot: Snap | null
  issue_date: string
  supply_date: string | null
  due_date: string | null
  vat_rate: number
  vat_note: string | null
  subtotal_net: number
  vat_amount: number
  total_gross: number
  status: string
  items: ItemRow[]
}

export default function Invoice() {
  const { t } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const [inv, setInv] = useState<InvoicePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => { void (async () => {
    if (!token) return
    const { data, error } = await supabase.rpc('get_invoice_by_token', { p_token: token })
    const row = (Array.isArray(data) ? data[0] : data) as InvoicePayload | null
    if (error || !row) { setErr(t('invoice.notFoundError', 'Diese Rechnung wurde nicht gefunden.')); setLoading(false); return }
    setInv(row); setLoading(false)
  })() }, [token, t])

  if (loading) return <Centered>{t('invoice.loading', 'Lädt…')}</Centered>
  if (err || !inv) return <Centered>{err || t('invoice.notFound', 'Nicht gefunden.')}</Centered>

  const I = inv.issuer_snapshot ?? {}
  const C = inv.customer_snapshot ?? {}
  const pdfUrl = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/invoice-documents/${inv.token}.pdf`

  return (
    <div style={{ background: '#f4f3f1', minHeight: '100vh', fontFamily: SANS, color: '#1a1a1a' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '24px 18px 64px' }}>
        {/* Aktionsleiste (nicht im Druck) */}
        <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginBottom: 16 }}>
          <a href={pdfUrl} target="_blank" rel="noreferrer"
             style={{ background: CORAL, color: '#fff', padding: '10px 18px', borderRadius: 10, fontWeight: 600, fontSize: 13.5, textDecoration: 'none' }}>
            ⬇ {t('invoice.downloadPdf', 'PDF herunterladen')}
          </a>
        </div>

        <div style={{ background: '#fff', borderRadius: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.04),0 10px 30px rgba(0,0,0,0.06)', padding: '38px 40px 30px' }}>
          {/* Kopf */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <img src={I.logo_url ?? DECK_LOGO} alt={String(I.brand_name ?? 'Happy Property')} style={{ height: 56, width: 'auto', borderRadius: 10 }} />
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 800, color: DARK, lineHeight: 1 }}>{t('invoice.headingInvoice', 'RECHNUNG')}</div>
              <div style={{ fontSize: 10, letterSpacing: 2, color: '#999', marginTop: 3 }}>INVOICE</div>
            </div>
          </div>
          <div style={{ height: 3, background: CORAL, borderRadius: 2, margin: '18px 0 24px' }} />

          {/* Aussteller + Meta */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 220 }}>
              <div style={{ fontFamily: SERIF, fontSize: 17, color: DARK, marginBottom: 3 }}>{I.brand_name}</div>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{I.legal_name}</div>
              <div style={{ fontSize: 12, color: '#777', lineHeight: 1.5, marginTop: 2 }}>
                {I.address_line1 && <div>{I.address_line1}</div>}
                <div>{[I.postal_code, I.city].filter(Boolean).join(' ')}{I.country ? `, ${I.country}` : ''}</div>
                {I.vat_number && <div>VAT: {I.vat_number}</div>}
                {I.reg_number && <div>{t('invoice.regNumberLabel', 'Reg.-Nr.')}: {I.reg_number}</div>}
              </div>
            </div>
            <div style={{ minWidth: 210 }}>
              <MetaRow k={t('invoice.invoiceNumber', 'Rechnungsnummer')} v={inv.invoice_number} />
              <MetaRow k={t('invoice.issueDate', 'Ausstellungsdatum')} v={dateFmt(inv.issue_date)} />
              <MetaRow k={t('invoice.supplyDate', 'Leistungsdatum')} v={dateFmt(inv.supply_date)} />
              <MetaRow k={t('invoice.dueDate', 'Fällig bis')} v={dateFmt(inv.due_date)} />
            </div>
          </div>

          {/* Rechnung an */}
          <div style={{ marginTop: 26 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.5, color: GOLD, marginBottom: 6 }}>{t('invoice.billTo', 'RECHNUNG AN')}</div>
            <div style={{ fontWeight: 700, fontSize: 14.5, color: DARK }}>{C.company_name}</div>
            <div style={{ fontSize: 12, color: '#777', lineHeight: 1.5, marginTop: 2 }}>
              {C.address_line1 && <div>{C.address_line1}</div>}
              {C.address_line2 && <div>{C.address_line2}</div>}
              <div>{[C.postal_code, C.city].filter(Boolean).join(' ')}{C.country ? `, ${C.country}` : ''}</div>
              {C.vat_number && <div>VAT: {C.vat_number}</div>}
            </div>
          </div>

          {/* Posten */}
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 26 }}>
            <thead>
              <tr style={{ background: DARK, color: '#fff' }}>
                <th style={{ ...th, textAlign: 'left' }}>{t('invoice.colDescription', 'BESCHREIBUNG')}</th>
                <th style={th}>{t('invoice.colQuantity', 'MENGE')}</th>
                <th style={th}>{t('invoice.colUnitPrice', 'EINZELPREIS')}</th>
                <th style={th}>{t('invoice.colAmount', 'BETRAG')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((it, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ ...td, textAlign: 'left' }}>{it.description}</td>
                  <td style={td}>{it.quantity}</td>
                  <td style={td}>{eurFmt(it.unit_price_net)}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{eurFmt(it.line_net)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Summen */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
            <div style={{ minWidth: 280 }}>
              <SumRow k={t('invoice.subtotalNet', 'Zwischensumme (netto)')} v={eurFmt(inv.subtotal_net)} />
              <SumRow k={inv.vat_rate > 0 ? t('invoice.vatWithRate', 'MwSt {{rate}}%', { rate: inv.vat_rate }) : t('invoice.vat', 'MwSt')} v={eurFmt(inv.vat_amount)} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff5f2', borderRadius: 8, padding: '11px 12px', marginTop: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{t('invoice.totalAmount', 'Gesamtbetrag')}</span>
                <span style={{ fontWeight: 800, fontSize: 17, color: CORAL }}>{eurFmt(inv.total_gross)}</span>
              </div>
            </div>
          </div>

          {inv.vat_note && <p style={{ fontSize: 11, color: '#888', marginTop: 16, lineHeight: 1.5 }}>{inv.vat_note}</p>}

          {/* Zahlung */}
          <div style={{ background: '#fbfbfc', border: '1px solid #eee', borderRadius: 12, padding: '16px 18px', marginTop: 24 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2, color: GOLD, marginBottom: 10 }}>{t('invoice.paymentByTransfer', 'ZAHLUNG PER ÜBERWEISUNG')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 6, fontSize: 12.5 }}>
              <PayRow k="Bank" v={I.bank_name} /><PayRow k="IBAN" v={I.iban} />
              <PayRow k="BIC" v={I.bic} /><PayRow k="Intermediary BIC" v={I.intermediary_bic} />
              <PayRow k={t('invoice.paymentReference', 'Verwendungszweck')} v={inv.invoice_number} /><PayRow k={t('invoice.dueDate', 'Fällig bis')} v={dateFmt(inv.due_date)} />
            </div>
          </div>

          {/* Fuß */}
          <div style={{ textAlign: 'center', fontSize: 10, color: '#aaa', marginTop: 26, paddingTop: 14, borderTop: '1px solid #eee' }}>
            {[I.legal_name, I.address_line1, [I.postal_code, I.city].filter(Boolean).join(' '), I.vat_number ? `VAT ${I.vat_number}` : '', I.reg_number ? t('invoice.regNumberFooter', 'Reg. {{number}}', { number: I.reg_number }) : '']
              .filter(Boolean).join('  ·  ')}
          </div>
        </div>
      </div>
      <style>{`@media print { .no-print { display: none !important } body { background: #fff } }`}</style>
    </div>
  )
}

const th: CSSProperties = { padding: '9px 10px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em' }
const td: CSSProperties = { padding: '11px 10px', textAlign: 'right', fontSize: 12.5 }

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontFamily: SANS, background: '#f4f3f1' }}>{children}</div>
}
function MetaRow({ k, v }: { k: string; v: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 12.5, marginBottom: 5 }}><span style={{ color: '#888' }}>{k}</span><span style={{ fontWeight: 700 }}>{v}</span></div>
}
function SumRow({ k, v }: { k: string; v: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '5px 12px', color: '#555' }}><span>{k}</span><span style={{ fontWeight: 600, color: '#1a1a1a' }}>{v}</span></div>
}
function PayRow({ k, v }: { k: string; v: string | null | undefined }) {
  if (!v) return null
  return <><span style={{ color: '#888' }}>{k}</span><span style={{ fontWeight: 600 }}>{v}</span></>
}
