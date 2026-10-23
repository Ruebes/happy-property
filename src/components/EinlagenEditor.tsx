import { useTranslation } from 'react-i18next'
import { CustomSelect } from './CustomSelect'
import type { Einlage } from '../lib/strategy'

// ── Weitere Einlagen (Sven 23.10.26) ─────────────────────────────────────────
// Eigenkapital, das der Kunde später zuschießt: Monat, Jahr, Betrag, beliebig
// viele Zeilen. Genutzt im CRM-Simulator und im Simulator für den Kunden.
const now = new Date()
const MONTHS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1).padStart(2, '0') }))
const YEARS = Array.from({ length: 30 }, (_, i) => ({ value: String(now.getFullYear() + i), label: String(now.getFullYear() + i) }))

export function EinlagenEditor({ value, onChange, inputClass, labelClass }: {
  value: Einlage[]
  onChange: (next: Einlage[]) => void
  inputClass: string
  labelClass: string
}) {
  const { t } = useTranslation()
  const set = (i: number, patch: Partial<Einlage>) => onChange(value.map((e, k) => k === i ? { ...e, ...patch } : e))
  return (
    <div className="space-y-1.5">
      {value.map((e, i) => (
        <div key={i} className="grid grid-cols-[80px_100px_minmax(0,1fr)_24px] gap-1.5 items-end">
          <div>
            {i === 0 && <label className={labelClass}>{t('crm.sim.einMonth', 'Monat')}</label>}
            <CustomSelect value={String(e.m)} onChange={v => set(i, { m: +v })} options={MONTHS} />
          </div>
          <div>
            {i === 0 && <label className={labelClass}>{t('crm.sim.einYear', 'Jahr')}</label>}
            <CustomSelect value={String(e.y)} onChange={v => set(i, { y: +v })}
              options={YEARS.some(y => y.value === String(e.y)) ? YEARS : [{ value: String(e.y), label: String(e.y) }, ...YEARS]} />
          </div>
          <div>
            {i === 0 && <label className={labelClass}>{t('crm.sim.einAmount', 'Betrag (€)')}</label>}
            <input type="number" step={10000} min={0} className={inputClass} value={e.amount || ''}
              onChange={ev => set(i, { amount: Math.max(0, +ev.target.value || 0) })} />
          </div>
          <button type="button" onClick={() => onChange(value.filter((_, k) => k !== i))}
            title={t('crm.sim.einRemove', 'Einlage entfernen')}
            className="text-gray-300 hover:text-red-500 pb-1.5">✕</button>
        </div>
      ))}
      <button type="button"
        onClick={() => onChange([...value, { m: now.getMonth() + 1, y: now.getFullYear() + 5, amount: 100000 }])}
        className="text-[12px] font-medium text-orange-600 hover:underline">
        + {t('crm.sim.einAdd', 'Einlage hinzufügen')}
      </button>
    </div>
  )
}
