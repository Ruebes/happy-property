/**
 * DepositInvoiceModal — öffnet sich, wenn ein Deal auf „Anzahlung" geschoben wird.
 * Sven gibt nur den Netto-Betrag ein, sieht direkt die fertige Rechnung als Vorschau
 * (Posten, MwSt, Brutto) und erstellt sie mit einem Klick — optional sofort an den
 * Kunden (Burkhard / Reeaals) versendet. Posten = „Leadgenerierung Vorname Name,
 * Developer, Objekt, Wohnungsnummer".
 */
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'
import {
  VAT_TREATMENTS, vatInfo, defaultTreatmentForMode, computeTotals, eurFmt,
} from '../../lib/invoiceVat'
import type { Deal, InvoiceCustomer, InvoiceSettings, VatTreatment } from '../../lib/crmTypes'

interface Props {
  deal: Deal
  onClose: () => void          // Abbruch → keine Phasenänderung
  onDone: (msg: string) => void // Erfolg → Pipeline refresht + Toast
}

export default function DepositInvoiceModal({ deal, onClose, onDone }: Props) {
  const lead = deal.lead
  const fullName = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ').trim()
  const project = deal.property?.project_name ?? ''
  const unit = deal.property?.unit_number ?? ''
  const developer = deal.developer ?? ''

  const defaultDesc = `Leadgenerierung ${[fullName, developer, project, unit].filter(Boolean).join(', ')}`.trim()

  const [customer, setCustomer] = useState<InvoiceCustomer | null>(null)
  const [settings, setSettings] = useState<InvoiceSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [net, setNet] = useState(0)
  const [desc, setDesc] = useState(defaultDesc)
  const [treatment, setTreatment] = useState<VatTreatment>('standard_19')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { void (async () => {
    const [{ data: c }, { data: s }] = await Promise.all([
      supabase.from('invoice_customers').select('*').eq('is_default', true).maybeSingle(),
      supabase.from('invoice_settings').select('*').eq('id', true).maybeSingle(),
    ])
    if (c) { setCustomer(c as InvoiceCustomer); setTreatment(defaultTreatmentForMode((c as InvoiceCustomer).country_mode)) }
    if (s) setSettings(s as InvoiceSettings)
    setLoading(false)
  })() }, [])

  const info = vatInfo(treatment)
  const totals = useMemo(() => computeTotals([{ quantity: 1, unit_price_net: net }], info.rate), [net, info.rate])

  async function submit(send: boolean) {
    if (net <= 0) { setErr('Bitte einen Netto-Betrag größer 0 eingeben.'); return }
    setBusy(true); setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('generate-invoice', {
        body: {
          deal_id: deal.id,
          lead_id: deal.lead_id,
          customer_id: customer?.id,
          vat_treatment: treatment,
          items: [{ description: desc.trim() || defaultDesc, quantity: 1, unit_price_net: net }],
          send,
        },
      })
      if (error) throw error
      const res = data as { ok?: boolean; invoice_number?: string; sent?: boolean; error?: string }
      if (!res?.ok) throw new Error(res?.error || 'Rechnung konnte nicht erstellt werden.')

      // Deal auf Anzahlung setzen + Aktivität loggen (die Pipeline hatte den Wechsel ausgesetzt)
      await supabase.from('deals').update({ phase: 'anzahlung', deposit_paid_at: new Date().toISOString() }).eq('id', deal.id)
      await supabase.from('activities').insert({
        lead_id: deal.lead_id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: `Rechnung ${res.invoice_number} erstellt`,
        content: `${res.invoice_number} über ${eurFmt(totals.total_gross)} (${desc.trim() || defaultDesc})${res.sent ? ' — an Kunden gesendet' : ' — als Entwurf'}`,
      })
      onDone(send && res.sent
        ? `Rechnung ${res.invoice_number} erstellt & gesendet`
        : `Rechnung ${res.invoice_number} als Entwurf erstellt`)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  const recipient = customer
    ? `${customer.company_name}${customer.contact_name ? ` (z. Hd. ${customer.contact_name})` : ''}`
    : '—'
  const recipientEmail = customer?.email ?? ''

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Kopf */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="font-heading text-lg text-hp-black">Anzahlungs-Rechnung</h3>
            <p className="text-xs text-gray-500 mt-0.5">{fullName || 'Lead'}{project ? ` · ${project}${unit ? ` ${unit}` : ''}` : ''}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {loading ? (
          <div className="p-10 text-center text-gray-400 text-sm">Lädt…</div>
        ) : (
          <div className="px-6 py-5 space-y-4">
            {/* Empfänger */}
            <div className="bg-gray-50 rounded-xl px-4 py-3 text-sm">
              <span className="text-gray-500">Empfänger: </span>
              <span className="font-medium text-hp-black">{recipient}</span>
              {recipientEmail && <span className="text-gray-400"> · {recipientEmail}</span>}
            </div>

            {/* Posten */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Rechnungsposten</label>
              <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2}
                className="w-full rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 resize-none" />
            </div>

            {/* Netto-Betrag */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Netto-Betrag</label>
              <NumberStepper value={net} onChange={setNet} step={100} min={0} suffix="€" />
            </div>

            {/* MwSt-Behandlung */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">MwSt-Behandlung</label>
              <CustomSelect value={treatment} onChange={v => setTreatment(v as VatTreatment)}
                options={VAT_TREATMENTS.map(o => ({ value: o.value, label: o.label }))} />
            </div>

            {/* Vorschau */}
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="bg-hp-black text-white text-[11px] font-semibold tracking-wide px-4 py-2">VORSCHAU</div>
              <div className="px-4 py-3 space-y-1.5 text-sm">
                <Row k="Zwischensumme (netto)" v={eurFmt(totals.subtotal_net)} />
                <Row k={info.rate > 0 ? `MwSt ${info.rate}%` : info.label} v={eurFmt(totals.vat_amount)} />
                <div className="flex justify-between items-center pt-2 mt-1 border-t border-gray-200">
                  <span className="font-semibold text-hp-black">Gesamtbetrag</span>
                  <span className="font-bold text-lg" style={{ color: '#ff795d' }}>{eurFmt(totals.total_gross)}</span>
                </div>
              </div>
              {info.note && <p className="px-4 pb-3 text-[11px] text-gray-400 leading-snug">{info.note}</p>}
            </div>

            {err && <p className="text-sm text-red-600">{err}</p>}

            {/* Aktionen */}
            <div className="flex gap-2 pt-1">
              <button disabled={busy || net <= 0} onClick={() => submit(false)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                Nur Entwurf
              </button>
              <button disabled={busy || net <= 0} onClick={() => submit(true)}
                className="flex-[1.6] px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: '#ff795d' }}>
                {busy ? 'Erstelle…' : recipientEmail ? `Erstellen & an ${customer?.contact_name || 'Kunde'} senden` : 'Erstellen'}
              </button>
            </div>
            <p className="text-[11px] text-gray-400 text-center">
              Rechnungsnummer wird automatisch vergeben (nächste: {settings ? `${settings.invoice_prefix}${settings.next_number}` : '—'}).
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between text-gray-600"><span>{k}</span><span className="font-medium text-hp-black">{v}</span></div>
}
