import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { BusinessContact, DeveloperContact } from '../../lib/crmTypes'

// ── RecipientPicker ─────────────────────────────────────────────────────────────
// Empfängerauswahl für Nachrichten: Haken „An den Klienten" (Standard) ODER ein
// fixer Kontakt (Geschäftskontakt / Developer-Ansprechpartner).
// Wert: 'client' | 'bc:<id>' | 'dc:<id>'. Wiederverwendbar in allen Nachrichten-Editoren.

interface Props {
  value:    string
  onChange: (v: string) => void
  channel?: 'email' | 'whatsapp' | 'both'   // filtert Kontakte nach nutzbarem Feld
}

type DevC = DeveloperContact & { developer_name: string | null }

export default function RecipientPicker({ value, onChange, channel = 'both' }: Props) {
  const { t } = useTranslation()
  const [business, setBusiness] = useState<BusinessContact[]>([])
  const [dev,      setDev]      = useState<DevC[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [bc, dc, dv] = await Promise.all([
          supabase.from('crm_business_contacts').select('*').order('first_name'),
          supabase.from('crm_developer_contacts').select('*').order('name'),
          supabase.from('crm_developers').select('id, name'),
        ])
        if (cancelled) return
        if (bc.data) setBusiness(bc.data as BusinessContact[])
        if (dc.data) {
          const m = new Map(((dv.data ?? []) as { id: string; name: string }[]).map(d => [d.id, d.name]))
          setDev((dc.data as DeveloperContact[]).map(c => ({ ...c, developer_name: m.get(c.developer_id) ?? null })))
        }
      } catch (e) {
        console.error('[RecipientPicker]', e)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const usable = (c: { email: string | null; phone: string | null; whatsapp: string | null }) =>
    channel === 'email'    ? !!c.email
  : channel === 'whatsapp' ? !!(c.whatsapp || c.phone)
  :                          !!(c.email || c.whatsapp || c.phone)

  const options = [
    // Dynamisch zur Laufzeit aufgelöst: der Developer-Kontakt der vom Lead gewählten Unit
    { value: 'unit_developer', label: t('crm.recipient.unitDeveloper', '🏗 Developer der gewählten Wohnung (automatisch)') },
    ...business.filter(usable).map(c => ({
      value: `bc:${c.id}`,
      label: `📇 ${`${c.first_name} ${c.last_name ?? ''}`.trim()}${c.company ? ` · ${c.company}` : ''}${c.role ? ` (${c.role})` : ''}`,
    })),
    ...dev.filter(usable).map(c => ({
      value: `dc:${c.id}`,
      label: `🏗 ${c.name}${c.developer_name ? ` · ${c.developer_name}` : ''}${c.role ? ` (${c.role})` : ''}`,
    })),
  ]

  const isClient = value === 'client'

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isClient}
          onChange={e => onChange(e.target.checked ? 'client' : (options[0]?.value ?? ''))}
          className="w-4 h-4 accent-orange-500"
        />
        <span className="text-sm text-gray-700">{t('crm.recipient.toClient', 'An den Klienten')}</span>
      </label>

      {!isClient && (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
        >
          {options.length === 0 && (
            <option value="">{t('crm.recipient.noContacts', '– keine Kontakte angelegt –')}</option>
          )}
          {/* aktuell gewählter Kontakt, falls durch Kanalfilter nicht in der Liste */}
          {value && !options.some(o => o.value === value) && (
            <option value={value}>{t('crm.recipient.selected', 'Gewählter Kontakt')}</option>
          )}
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  )
}
