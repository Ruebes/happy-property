import { useTranslation } from 'react-i18next'
import { INPUT_CLS, parseDollar, toLocalInput } from '../felder'
import { useWerbeFormat } from '../format'
import { FeldRahmen, type Empfehlung } from './Bausteine'
import { WOCHENTAGE_META, isoAusZeit, type BudgetPlanung, type ZeitplanBlock } from './bearbeitenTypen'
import { geldText } from './bearbeitenHelfer'

// ── Budgetplanung und Zeitplan nach Uhrzeit ──────────────────────────────────
// Budgetplanung (Meta: „Budget für Zeiträume mit hoher Nachfrage planen"): nur
// mit Tagesbudget, bis 50 Zeiträume, mindestens 3 Stunden, höchstens das
// 8-fache des Tagesbudgets, danach automatisch zurück. Zeitplan (Meta:
// „Anzeigen nach einem Zeitplan schalten"): nur mit Laufzeitbudget, volle
// Stunden, mindestens eine Stunde.

const MAX_PLAN = 50
const MIN_STUNDEN = 3

interface PlanProps {
  node: string
  feld: string
  label: string
  hilfe?: string
  werte: BudgetPlanung[] | undefined
  onChange: (w: BudgetPlanung[] | undefined) => void
  kurs: number
  /** Tagesbudget in USD-Cent (für die 8-fach-Grenze), null = unbekannt */
  tagesbudgetCents: number | null
  disabled?: boolean
  sperre?: string
  empfehlung?: Empfehlung
}

const isoAus = (lokal: string): string | null => {
  if (!lokal) return null
  const d = new Date(lokal)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function BudgetPlanungFeld({ werte, onChange, kurs, tagesbudgetCents, ...b }: PlanProps) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const liste = werte ?? []
  const aus = !!b.disabled || !!b.sperre
  const setze = (i: number, patch: Partial<BudgetPlanung>) => onChange(liste.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const neu = () => {
    const start = new Date()
    start.setDate(start.getDate() + 1)
    start.setHours(9, 0, 0, 0)
    const ende = new Date(start.getTime() + 12 * 3_600_000)
    onChange([...liste, { time_start: start.toISOString(), time_end: ende.toISOString(), budget_value: 50, budget_value_type: 'MULTIPLIER' }])
  }

  const pruefe = (p: BudgetPlanung): string | null => {
    const s = Date.parse(isoAusZeit(p.time_start) ?? ''), e = Date.parse(isoAusZeit(p.time_end) ?? '')
    if (!Number.isFinite(s) || !Number.isFinite(e)) return t('crm.werbung.bearbeiten.plan.zeitFehlt', 'Start und Ende angeben.')
    if (e - s < MIN_STUNDEN * 3_600_000) return t('crm.werbung.bearbeiten.plan.zuKurz', 'Mindestens 3 Stunden.')
    if (!(p.budget_value > 0)) return t('crm.werbung.bearbeiten.plan.wertFehlt', 'Erhöhung angeben.')
    if (p.budget_value_type === 'MULTIPLIER' && p.budget_value > 700) return t('crm.werbung.bearbeiten.plan.zuHoch', 'Höchstens das 8-fache des Tagesbudgets.')
    if (p.budget_value_type === 'ABSOLUTE' && tagesbudgetCents && p.budget_value > 7 * tagesbudgetCents) return t('crm.werbung.bearbeiten.plan.zuHoch', 'Höchstens das 8-fache des Tagesbudgets.')
    return null
  }

  return (
    <FeldRahmen {...b}>
      <div className="mt-1 space-y-2">
        {liste.map((p, i) => {
          const fehler = pruefe(p)
          // Bestehender Zeitraum bei Meta (mit id): jede Änderung oder Entfernen sperrt beim Server
          // das ganze Feld (entfernteBudgetZeitraeume), darum hier komplett nur lesen
          const fest = aus || !!p.id
          return (
            <div key={i} className="space-y-1.5 rounded-lg border border-gray-200 p-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-[10px] text-gray-500">{t('crm.werbung.bearbeiten.plan.start', 'Beginn')}
                  <input type="datetime-local" value={toLocalInput(isoAusZeit(p.time_start))} disabled={fest} className={INPUT_CLS}
                    onChange={ev => { const v = isoAus(ev.target.value); if (v) setze(i, { time_start: v }) }} />
                </label>
                <label className="block text-[10px] text-gray-500">{t('crm.werbung.bearbeiten.plan.ende', 'Ende')}
                  <input type="datetime-local" value={toLocalInput(isoAusZeit(p.time_end))} disabled={fest} className={INPUT_CLS}
                    onChange={ev => { const v = isoAus(ev.target.value); if (v) setze(i, { time_end: v }) }} />
                </label>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="block text-[10px] text-gray-500">{t('crm.werbung.bearbeiten.plan.art', 'Erhöhung als')}
                  <select value={p.budget_value_type} disabled={fest} className={`${INPUT_CLS} w-auto`}
                    onChange={ev => setze(i, { budget_value_type: ev.target.value === 'ABSOLUTE' ? 'ABSOLUTE' : 'MULTIPLIER', budget_value: ev.target.value === 'ABSOLUTE' ? 1000 : 50 })}>
                    <option value="MULTIPLIER">{t('crm.werbung.bearbeiten.plan.prozent', 'Prozent')}</option>
                    <option value="ABSOLUTE">{t('crm.werbung.bearbeiten.plan.betrag', 'Betrag ($)')}</option>
                  </select>
                </label>
                <label className="block min-w-[7rem] flex-1 text-[10px] text-gray-500">
                  {p.budget_value_type === 'ABSOLUTE' ? t('crm.werbung.bearbeiten.plan.plusBetrag', 'Plus ($ pro Tag)') : t('crm.werbung.bearbeiten.plan.plusProzent', 'Plus (%)')}
                  <input inputMode="decimal" disabled={fest} className={`${INPUT_CLS} tabular-nums`}
                    defaultValue={p.budget_value_type === 'ABSOLUTE' ? String(p.budget_value / 100).replace('.', ',') : String(p.budget_value)}
                    key={`${p.budget_value_type}-${i}`}
                    onBlur={ev => {
                      const v = p.budget_value_type === 'ABSOLUTE' ? parseDollar(ev.target.value) : parseFloat(ev.target.value.replace(',', '.'))
                      if (v != null && Number.isFinite(v) && v > 0) setze(i, { budget_value: p.budget_value_type === 'ABSOLUTE' ? Math.round(v * 100) : Math.round(v) })
                    }} />
                </label>
                {!fest && (
                  <button type="button" onClick={() => { const n = liste.filter((_, j) => j !== i); onChange(n.length ? n : undefined) }}
                    className="rounded px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-red-700">
                    {t('crm.werbung.bearbeiten.plan.entfernen', 'Entfernen')}
                  </button>
                )}
              </div>
              {p.budget_value_type === 'ABSOLUTE' && p.budget_value > 0 && (
                <p className="text-[10px] text-gray-500 tabular-nums">+ {geldText(fmt, p.budget_value, kurs)}</p>
              )}
              {p.id && !aus && <p className="text-[10px] text-gray-500">🔒 {t('crm.werbung.bearbeiten.plan.bestehend', 'Schon bei Meta geplant: hier nicht änderbar und nicht entfernbar. Neue Zeiträume lassen sich hinzufügen.')}</p>}
              {fehler && <p className="text-[11px] text-red-700">{fehler}</p>}
            </div>
          )
        })}
        {!aus && liste.length < MAX_PLAN && (
          <button type="button" onClick={neu} className="text-xs font-semibold text-hp-navy hover:underline">
            + {t('crm.werbung.bearbeiten.plan.neu', 'Zeitraum hinzufügen')}
          </button>
        )}
        {!liste.length && aus && <p className="text-[11px] text-gray-400">{t('crm.werbung.bearbeiten.plan.keine', 'Keine Zeiträume geplant.')}</p>}
      </div>
    </FeldRahmen>
  )
}

// ── Zeitplan nach Uhrzeit (adset_schedule) ───────────────────────────────────

interface ZeitplanProps {
  node: string
  feld: string
  label: string
  hilfe?: string
  werte: ZeitplanBlock[] | undefined
  onChange: (w: ZeitplanBlock[] | undefined) => void
  disabled?: boolean
  sperre?: string
}

const STUNDEN = Array.from({ length: 25 }, (_, h) => h)

export function ZeitplanFeld({ werte, onChange, ...b }: ZeitplanProps) {
  const { t } = useTranslation()
  const liste = werte ?? []
  const aus = !!b.disabled || !!b.sperre
  const tagName: Record<number, string> = {
    1: t('crm.werbung.bearbeiten.tag.1', 'Mo'), 2: t('crm.werbung.bearbeiten.tag.2', 'Di'), 3: t('crm.werbung.bearbeiten.tag.3', 'Mi'),
    4: t('crm.werbung.bearbeiten.tag.4', 'Do'), 5: t('crm.werbung.bearbeiten.tag.5', 'Fr'), 6: t('crm.werbung.bearbeiten.tag.6', 'Sa'),
    0: t('crm.werbung.bearbeiten.tag.0', 'So'),
  }
  const setze = (i: number, patch: Partial<ZeitplanBlock>) => onChange(liste.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const neu = () => onChange([...liste, { start_minute: 8 * 60, end_minute: 20 * 60, days: [1, 2, 3, 4, 5], timezone_type: 'USER' }])

  return (
    <FeldRahmen {...b}>
      <div className="mt-1 space-y-2">
        {liste.map((z, i) => {
          const vonH = Math.floor(z.start_minute / 60)
          const bisH = Math.floor(z.end_minute / 60)
          const fehler = !z.days.length
            ? t('crm.werbung.bearbeiten.zeitplan.keinTag', 'Mindestens einen Tag wählen.')
            : bisH <= vonH ? t('crm.werbung.bearbeiten.zeitplan.ende', 'Das Ende muss nach dem Beginn liegen (mindestens 1 Stunde).') : null
          return (
            <div key={i} className="space-y-1.5 rounded-lg border border-gray-200 p-2">
              <div className="flex flex-wrap gap-1" role="group" aria-label={t('crm.werbung.bearbeiten.zeitplan.tage', 'Tage')}>
                {WOCHENTAGE_META.map(d => {
                  const an = z.days.indexOf(d) >= 0
                  return (
                    <button key={d} type="button" aria-pressed={an} disabled={aus}
                      onClick={() => setze(i, { days: an ? z.days.filter(x => x !== d) : [...z.days, d].sort((a, c) => a - c) })}
                      className={`min-w-[2.5rem] rounded-md border px-2 py-1 text-xs ${an ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-700'} disabled:opacity-60`}>
                      {tagName[d]}
                    </button>
                  )
                })}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="block text-[10px] text-gray-500">{t('crm.werbung.bearbeiten.zeitplan.von', 'Von')}
                  <select value={vonH} disabled={aus} className={`${INPUT_CLS} w-auto`} onChange={ev => setze(i, { start_minute: Number(ev.target.value) * 60 })}>
                    {STUNDEN.slice(0, 24).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                </label>
                <label className="block text-[10px] text-gray-500">{t('crm.werbung.bearbeiten.zeitplan.bis', 'Bis')}
                  <select value={bisH} disabled={aus} className={`${INPUT_CLS} w-auto`} onChange={ev => setze(i, { end_minute: Number(ev.target.value) * 60 })}>
                    {STUNDEN.slice(1).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                </label>
                <label className="block text-[10px] text-gray-500">{t('crm.werbung.bearbeiten.zeitplan.zeitzone', 'Zeitzone')}
                  <select value={z.timezone_type ?? 'USER'} disabled={aus} className={`${INPUT_CLS} w-auto`}
                    onChange={ev => setze(i, { timezone_type: ev.target.value === 'ADVERTISER' ? 'ADVERTISER' : 'USER' })}>
                    <option value="USER">{t('crm.werbung.bearbeiten.zeitplan.user', 'Zeitzone der Betrachter')}</option>
                    <option value="ADVERTISER">{t('crm.werbung.bearbeiten.zeitplan.konto', 'Zeitzone des Werbekontos')}</option>
                  </select>
                </label>
                {!aus && (
                  <button type="button" onClick={() => { const n = liste.filter((_, j) => j !== i); onChange(n.length ? n : undefined) }}
                    className="rounded px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-red-700">
                    {t('crm.werbung.bearbeiten.plan.entfernen', 'Entfernen')}
                  </button>
                )}
              </div>
              {fehler && <p className="text-[11px] text-red-700">{fehler}</p>}
            </div>
          )
        })}
        {!aus && (
          <button type="button" onClick={neu} className="text-xs font-semibold text-hp-navy hover:underline">
            + {t('crm.werbung.bearbeiten.zeitplan.neu', 'Zeitfenster hinzufügen')}
          </button>
        )}
        {!liste.length && (
          <p className="text-[11px] text-gray-400">{t('crm.werbung.bearbeiten.zeitplan.immer', 'Ohne Zeitfenster laufen die Anzeigen rund um die Uhr (empfohlen).')}</p>
        )}
      </div>
    </FeldRahmen>
  )
}
