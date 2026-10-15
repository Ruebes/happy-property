import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { Developer, ReservationTemplate, ReservationTemplateBank } from '../../lib/crmTypes'
import { reservationCall, openPdfWindow, showPdf } from '../../lib/reservationAgreement'

// Reservierungsvertrag-Vorlage eines Bauträgers bearbeiten („Reservierung Mito").
// Die Edge Function reservation-agreement füllt sie aus, sobald der Kunde seinen
// Ausweis in den Drive-Ordner lädt.

type Form = Omit<ReservationTemplate, 'id' | 'created_at' | 'updated_at'>

const emptyForm = (dev: Developer): Form => ({
  developer_id: dev.id, name: `Reservierung ${dev.name}`, is_active: true, auto_send: true,
  logo_text: dev.name.toUpperCase(), company_name: dev.name.toUpperCase(), title: 'Reservation agreement',
  accent_color: '#e3874a', company_address: '', company_tel: '', property_prefix: dev.name.toUpperCase(),
  project_addresses: {}, bank: {}, notes: '',
})

export default function ReservationTemplateModal({ developer, onClose }: { developer: Developer; onClose: () => void }) {
  const { t } = useTranslation()
  const [id, setId] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(emptyForm(developer))
  const [projects, setProjects] = useState<Array<{ id: string; name: string; location: string | null }>>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [{ data: tpl, error: e1 }, { data: proj, error: e2 }] = await Promise.all([
        supabase.from('reservation_templates').select('*').eq('developer_id', developer.id)
          .order('is_active', { ascending: false }).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('crm_projects').select('id, name, location').ilike('developer', developer.name).order('name'),
      ])
      if (!alive) return
      if (e1 || e2) setMsg({ ok: false, text: (e1 ?? e2)!.message })
      if (tpl) {
        // created_at/updated_at gehören nicht ins Formular (Rest-Destrukturierung)
        const { id: tid, created_at, updated_at, ...rest } = tpl as ReservationTemplate
        setId(tid)
        setForm({ ...rest, bank: rest.bank ?? {}, project_addresses: rest.project_addresses ?? {} })
      }
      setProjects((proj ?? []) as Array<{ id: string; name: string; location: string | null }>)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [developer])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }))
  const setBank = (k: keyof ReservationTemplateBank, v: string) => setForm(f => ({ ...f, bank: { ...f.bank, [k]: v } }))
  const setAddr = (pid: string, v: string) => setForm(f => ({ ...f, project_addresses: { ...f.project_addresses, [pid]: v } }))

  const save = async () => {
    if (!form.company_name.trim()) { setMsg({ ok: false, text: t('reservationTpl.companyRequired', 'Firmenname fehlt') }); return }
    setSaving(true); setMsg(null)
    const payload = { ...form, updated_at: new Date().toISOString() }
    const res = id
      ? await supabase.from('reservation_templates').update(payload).eq('id', id).select('id')
      : await supabase.from('reservation_templates').insert(payload).select('id')
    setSaving(false)
    if (res.error || !res.data?.length) { setMsg({ ok: false, text: res.error?.message ?? t('reservationTpl.notSaved', 'Nicht gespeichert (keine Berechtigung?)') }); return }
    setId((res.data[0] as { id: string }).id)
    setMsg({ ok: true, text: t('reservationTpl.saved', 'Vorlage gespeichert') })
  }

  const preview = async () => {
    const win = openPdfWindow()
    setPreviewing(true); setMsg(null)
    try {
      const first = projects[0]
      const r = await reservationCall<{ pdf_base64: string }>({
        action: 'preview_template', template: form,
        sample: first ? {
          property_name: [form.property_prefix, first.name].filter(Boolean).join(' ').toUpperCase(),
          address: form.project_addresses[first.id] || first.location || '',
        } : undefined,
      })
      showPdf(win, r.pdf_base64)
    } catch (e) {
      win?.close()
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setPreviewing(false) }
  }

  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'
  const label = 'block text-xs font-medium text-gray-600 mb-1'
  const field = (k: 'name' | 'company_name' | 'logo_text' | 'title' | 'property_prefix' | 'company_address' | 'company_tel', text: string, span = false) => (
    <div className={span ? 'col-span-2' : ''}>
      <label className={label}>{text}</label>
      <input value={form[k] ?? ''} onChange={e => set(k, e.target.value)} className={inputCls} />
    </div>
  )
  const bankFields: Array<[keyof ReservationTemplateBank, string]> = [
    ['account_name', t('reservationTpl.accountName', 'Kontoinhaber')], ['account_number', t('reservationTpl.accountNumber', 'Kontonummer')],
    ['iban', 'IBAN'], ['swift', 'SWIFT'], ['bank_name', t('reservationTpl.bankName', 'Bank')],
  ]

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{t('reservationTpl.title', 'Reservierungsvorlage')} · {developer.name}</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('reservationTpl.subtitle', 'Wird automatisch mit Name und Passnummer aus dem Ausweis ausgefüllt und an den Bauträger geschickt.')}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-4 overflow-y-auto space-y-5">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)}
                    className="mt-0.5 rounded border-gray-300 text-orange-500 focus:ring-orange-400" />
                  {t('reservationTpl.active', 'Vorlage aktiv (Automatik läuft für alle Wohnungen dieses Bauträgers)')}
                </label>
                <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={form.auto_send} onChange={e => set('auto_send', e.target.checked)}
                    className="mt-0.5 rounded border-gray-300 text-orange-500 focus:ring-orange-400" />
                  <span>
                    {t('reservationTpl.autoSend', 'Automatisch an den Bauträger senden')}
                    <span className="block text-[11px] text-gray-400">
                      {t('reservationTpl.autoSendHint', 'Aus = jeder Vertrag kommt erst zu dir zur Prüfung. Passt der Ausweis nicht zum Kunden oder ist etwas unlesbar, kommt er immer erst zu dir.')}
                    </span>
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {field('name', t('reservationTpl.name', 'Name der Vorlage'), true)}
                {field('company_name', t('reservationTpl.companyName', 'Firmenname (Kopfzeile)'))}
                {field('logo_text', t('reservationTpl.logoText', 'Logo-Text'))}
                {field('title', t('reservationTpl.docTitle', 'Titel'))}
                {field('property_prefix', t('reservationTpl.prefix', 'Vorsatz Objektname (z. B. MITO)'))}
                {field('company_address', t('reservationTpl.address', 'Firmenadresse'), true)}
                {field('company_tel', t('reservationTpl.tel', 'Firmentelefon'))}
                <div>
                  <label className={label}>{t('reservationTpl.color', 'Akzentfarbe')}</label>
                  <input type="color" value={form.accent_color} onChange={e => set('accent_color', e.target.value)}
                    className="h-9 w-16 border border-gray-200 rounded-lg" />
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('reservationTpl.bank', 'Bankverbindung für die Anzahlung')}</p>
                <div className="grid grid-cols-2 gap-3">
                  {bankFields.map(([k, txt]) => (
                    <div key={k} className={k === 'iban' || k === 'bank_name' ? 'col-span-2' : ''}>
                      <label className={label}>{txt}</label>
                      <input value={form.bank[k] ?? ''} onChange={e => setBank(k, e.target.value)} className={inputCls} />
                    </div>
                  ))}
                </div>
              </div>

              {projects.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('reservationTpl.addresses', 'Adresse je Projekt (steht im Vertrag)')}</p>
                  <div className="space-y-2">
                    {projects.map(p => (
                      <div key={p.id} className="grid grid-cols-[8rem_1fr] gap-2 items-center">
                        <span className="text-sm text-gray-700 truncate">{p.name}</span>
                        <input value={form.project_addresses[p.id] ?? ''} placeholder={p.location ?? ''}
                          onChange={e => setAddr(p.id, e.target.value)} className={inputCls} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className={label}>{t('reservationTpl.notes', 'Bedingungen (Notes), Absätze mit Leerzeile trennen')}</label>
                <textarea value={form.notes ?? ''} rows={7} onChange={e => set('notes', e.target.value)} className={`${inputCls} resize-y`} />
              </div>
            </>
          )}
          {msg && <p className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-between gap-2">
          <button onClick={preview} disabled={loading || previewing}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            {previewing ? '…' : `👁 ${t('reservationTpl.preview', 'Vorschau mit Beispieldaten')}`}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
              {t('common.close', 'Schließen')}
            </button>
            <button onClick={save} disabled={loading || saving}
              className="px-4 py-2 text-sm font-medium rounded-lg text-white bg-[#ff795d] hover:opacity-90 disabled:opacity-50">
              {saving ? '…' : t('common.save', 'Speichern')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
