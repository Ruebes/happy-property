import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { migrateConfig, defaultDivTaxPct, type SimUnit, type SimParams, type StrategyConfig } from '../lib/strategy'
import { readCustomerSim, activeUnits } from '../lib/customerSim'
import { EinlagenEditor } from '../components/EinlagenEditor'
import { CustomSelect } from '../components/CustomSelect'
import { StrategieView } from './Strategie'

// ── Strategie-Simulator für den Kunden (Sven 23.10.26) ──────────────────────
// /simulator/:token - freigeschaltet über „Simulator freischalten" im CRM.
// Oben die Stellschrauben, darunter dieselbe Auswertung wie auf der
// Fahrplan-Seite, live neu gerechnet. Was der Kunde einstellt, wird gespeichert
// (customer_config) und ist für Sven im Kundenprofil sichtbar. Sven's Fahrplan
// bleibt unverändert; ohne eigene Änderungen sieht der Kunde immer dessen Stand.

const now = new Date()
const MONTHS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1).padStart(2, '0') }))
const YEARS = Array.from({ length: 12 }, (_, i) => ({ value: String(now.getFullYear() + i), label: String(now.getFullYear() + i) }))
const eur = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' €'
const num = (n: number) => String(n).replace('.', ',')

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export default function KundenSimulator() {
  const { t } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const [base, setBase] = useState<{ units: SimUnit[]; params: SimParams } | null>(null)
  const [units, setUnits] = useState<SimUnit[]>([])
  const [params, setParams] = useState<SimParams | null>(null)
  const [off, setOff] = useState<string[]>([])
  const [recipient, setRecipient] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [save, setSave] = useState<SaveState>('idle')
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => { void (async () => {
    if (!token) return
    const { data, error } = await supabase.rpc('get_strategy_sim', { p_token: token })
    const row = (Array.isArray(data) ? data[0] : data) as { config?: unknown; customer_config?: unknown; recipient_name?: string | null } | null
    if (error || !row) { setErr(t('strategie.ksNotFound', 'Dieser Simulator ist nicht (mehr) freigeschaltet.')); setLoading(false); return }
    const b = migrateConfig((row.config ?? {}) as StrategyConfig)
    setBase(b)
    if (row.customer_config) {
      const c = readCustomerSim(row.customer_config)
      setUnits(c.units); setParams(c.params); setOff(c.off)
    } else {
      setUnits(b.units); setParams(b.params); setOff([])
    }
    setRecipient(row.recipient_name ?? null)
    setLoading(false)
  })() }, [token, t])

  // Speichern, sobald der Kunde etwas verändert hat (entprellt)
  useEffect(() => {
    if (!dirty.current || !token || !params) return
    clearTimeout(timer.current)
    setSave('saving')
    timer.current = setTimeout(() => {
      void supabase.rpc('save_strategy_sim', { p_token: token, p_config: { unitsV2: units, paramsV2: params, off } })
        .then(({ error }) => setSave(error ? 'error' : 'saved'))
    }, 1200)
    return () => clearTimeout(timer.current)
  }, [units, params, off, token])

  const touch = () => { dirty.current = true }
  const setP = (patch: Partial<SimParams>) => { touch(); setParams(p => p ? { ...p, ...patch } : p) }
  const patchUnit = (key: string, patch: Partial<SimUnit>) => { touch(); setUnits(us => us.map(u => u.key === key ? { ...u, ...patch } : u)) }
  const reset = () => { if (!base) return; touch(); setUnits(base.units); setParams(base.params); setOff([]) }

  const calcUnits = useMemo(() => activeUnits(units, off), [units, off])
  // Rechnen hinter der Eingabe her: Regler bleiben flüssig, die Auswertung folgt
  const dUnits = useDeferredValue(calcUnits)
  const dParams = useDeferredValue(params)

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-[#f4f3f1] text-gray-500">{t('strategie.loading', 'Lädt…')}</div>
  if (err || !params) return <div className="min-h-screen flex items-center justify-center bg-[#f4f3f1] text-gray-600 px-6 text-center">{err}</div>

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300'
  const lbl = 'block text-[11.5px] text-gray-500 mb-0.5'
  const seg = (on: boolean) => `flex-1 px-2 py-1.5 text-xs font-medium ${on ? 'bg-[#1a2332] text-white' : 'bg-white text-gray-600'}`
  const growthKey: keyof SimParams = params.reinvestEnabled ? 'reinvestAppreciationPct' : 'growth'
  const slider = (key: keyof SimParams, label: string, min: number, max: number, step: number, unit: string) => (
    <div>
      <label className={lbl}>{label} <strong className="text-[#1a2332]">{num(params[key] as number)}{unit}</strong></label>
      <input type="range" min={min} max={max} step={step} className="w-full accent-[#ff795d]"
        value={params[key] as number} onChange={e => setP({ [key]: +e.target.value } as Partial<SimParams>)} />
    </div>
  )

  const controls = (
    <div className="bg-white rounded-2xl shadow-sm p-4 sm:p-5 mb-8 space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[#1a2332]" style={{ fontFamily: "'Playfair Display',Georgia,serif" }}>
          {t('strategie.ksTitle', 'Spiel deine Strategie selbst durch')}
        </h2>
        <p className="text-[13px] text-gray-600 mt-1 leading-relaxed">
          {t('strategie.ksIntro', 'Verändere die Annahmen, die Auswertung darunter rechnet sofort neu. Deine Eingaben werden gespeichert und sind für Happy Property sichtbar, damit wir sie mit dir besprechen können.')}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
        <div>
          <label className={lbl}>{t('strategie.ksEk', 'Eigenkapital zum Start (€)')}</label>
          <input type="number" step={10000} min={0} className={inputCls} value={params.ek}
            onChange={e => setP({ ek: Math.max(0, +e.target.value || 0) })} />
        </div>
        {slider(growthKey, t('strategie.ksGrowth', 'Wertsteigerung p.a.'), 0, 10, 0.5, ' %')}
        {slider('rentGrowth', t('strategie.ksRentGrowth', 'Mietsteigerung p.a.'), 0, 6, 0.5, ' %')}
        {slider('interest', t('strategie.ksInterest', 'Darlehenszins p.a.'), 1, 8, 0.1, ' %')}
        {slider('termYears', t('strategie.ksTerm', 'Laufzeit Darlehen'), 5, 30, 1, ' J.')}
        {!params.reinvestEnabled && (
          <div>
            <label className={lbl}>{t('strategie.ksExit', 'Verkauf')} <strong className="text-[#1a2332]">
              {params.exitAfterYears ? t('strategie.ksExitYears', 'nach {{n}} Jahren', { n: params.exitAfterYears }) : t('strategie.ksExitNone', 'kein Verkauf')}
            </strong></label>
            <input type="range" min={0} max={10} step={1} className="w-full accent-[#ff795d]" value={params.exitAfterYears}
              onChange={e => setP({ exitAfterYears: +e.target.value })} />
          </div>
        )}
        {params.holder === 'privat' && (
          <div>
            <label className={lbl}>{t('strategie.ksRes', 'Steuersitz')}</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-200">
              <button type="button" className={seg(params.res === 'de')} onClick={() => setP({ res: 'de', divTaxPct: defaultDivTaxPct('de') })}>{t('strategie.ksResDe', 'Deutschland')}</button>
              <button type="button" className={seg(params.res === 'cy')} onClick={() => setP({ res: 'cy', divTaxPct: defaultDivTaxPct('cy') })}>{t('strategie.ksResCy', 'Zypern')}</button>
            </div>
          </div>
        )}
        {params.holder === 'privat' && (
          <div>
            <label className={lbl}>{t('strategie.ksBuyer', 'Käufer')}</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-200">
              <button type="button" className={seg(params.buyerStructure === 'single')} onClick={() => setP({ buyerStructure: 'single' })}>{t('strategie.ksSingle', 'Einzelperson')}</button>
              <button type="button" className={seg(params.buyerStructure === 'couple')} onClick={() => setP({ buyerStructure: 'couple' })}>{t('strategie.ksCouple', 'Paar')}</button>
            </div>
          </div>
        )}
      </div>

      <div className="pt-3 border-t border-gray-100">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">{t('strategie.ksEinTitle', 'Weitere Einlagen')}</p>
        <p className="text-[12px] text-gray-500 mb-2">
          {params.reinvestEnabled
            ? t('strategie.ksEinHintRe', 'Geld, das du später zuschießt. Es fließt im Jahr des Eingangs in die Kasse und steht für weitere Käufe bereit.')
            : t('strategie.ksEinHint', 'Geld, das du später zuschießt, zum Beispiel aus einem Verkauf oder einer Auszahlung. Es zahlt zuerst offene Kaufraten und tilgt dann Darlehen vorzeitig.')}
        </p>
        <div className="max-w-md">
          <EinlagenEditor value={params.einlagen ?? []} inputClass={inputCls} labelClass={lbl} onChange={next => setP({ einlagen: next })} />
        </div>
      </div>

      <div className="pt-3 border-t border-gray-100">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-gray-500 mb-2">{t('strategie.ksUnits', 'Wohnungen')}</p>
        <div className="space-y-2">
          {units.map(u => {
            const on = !off.includes(u.key)
            return (
              <div key={u.key} className={`rounded-xl border p-2.5 ${on ? 'border-gray-200' : 'border-dashed border-gray-200 opacity-60'}`}>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 accent-[#ff795d]" checked={on}
                    onChange={e => { touch(); setOff(o => e.target.checked ? o.filter(k => k !== u.key) : [...o, u.key]) }} />
                  <span className="text-sm font-semibold text-[#1a2332]">{u.name}</span>
                  <span className="text-xs text-gray-500">{eur(u.priceNet)} {t('strategie.ksNet', 'netto')}</span>
                </label>
                {on && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                    <div>
                      <label className={lbl}>{t('strategie.ksFin', 'Finanzierung')}</label>
                      <div className="flex rounded-lg overflow-hidden border border-gray-200">
                        <button type="button" className={seg(u.fin)} onClick={() => patchUnit(u.key, { fin: true })}>{t('strategie.ksFinBank', 'Bank')}</button>
                        <button type="button" className={seg(!u.fin)} onClick={() => patchUnit(u.key, { fin: false })}>{t('strategie.ksFinCash', 'Bar')}</button>
                      </div>
                    </div>
                    <div>
                      <label className={lbl}>{t('strategie.ksRent', 'Miete/Monat (€)')}</label>
                      <input type="number" step={50} min={0} className={inputCls} value={Math.round(u.rent)}
                        onChange={e => patchUnit(u.key, { rent: Math.max(0, +e.target.value || 0), calc: { ...(u.calc ?? {}), season: null } })} />
                    </div>
                    <div className="col-span-2">
                      <label className={lbl}>{t('strategie.ksBuy', 'Kauf (Monat/Jahr)')}</label>
                      <div className="flex gap-1">
                        <CustomSelect value={String(u.buyM)} onChange={v => patchUnit(u.key, { buyM: +v })} options={MONTHS} className="w-1/2" />
                        <CustomSelect value={String(u.buyY)} onChange={v => patchUnit(u.key, { buyY: +v })}
                          options={YEARS.some(y => y.value === String(u.buyY)) ? YEARS : [{ value: String(u.buyY), label: String(u.buyY) }, ...YEARS]} className="w-1/2" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className={`text-xs ${save === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
          {save === 'saving' ? t('strategie.ksSaving', 'Wird gespeichert…')
            : save === 'saved' ? `✓ ${t('strategie.ksSaved', 'Gespeichert')}`
              : save === 'error' ? t('strategie.ksSaveErr', 'Speichern fehlgeschlagen, bitte Seite neu laden.')
                : ''}
        </span>
        <button type="button" onClick={reset} className="text-xs font-medium text-[#ff795d] hover:underline">
          ↺ {t('strategie.ksReset', 'Auf den Vorschlag von Happy Property zurücksetzen')}
        </button>
      </div>
    </div>
  )

  if (!calcUnits.length) {
    return (
      <div className="min-h-screen bg-[#f4f3f1] px-3 py-6">
        <div className="max-w-[1080px] mx-auto">{controls}
          <p className="text-sm text-gray-600 text-center">{t('strategie.ksNoUnits', 'Wähle mindestens eine Wohnung aus.')}</p>
        </div>
      </div>
    )
  }
  // Beim ersten Bild nach dem Laden ist der zurückgestellte Wert noch leer
  return <StrategieView units={dUnits.length ? dUnits : calcUnits} params={dParams ?? params} recipientName={recipient} top={controls} />
}
