import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useDateFormat } from '../../../lib/date'
import { CustomSelect } from '../../../components/CustomSelect'

/**
 * Verkaufs-Statistik.
 *
 * Ein Verkauf ist eine Wohnung, die einem Kunden gehoert: crm_project_units.property_id
 * zeigt auf ein properties-Objekt mit owner_id. Das ist dieselbe Quelle der Wahrheit wie
 * im Rest des CRM ("verkauft" ist kein Statusfeld, sondern die Zuordnung).
 *
 * Der Bautraeger kommt IMMER ueber die Wohnung -> Projekt -> crm_projects.developer.
 * deals.developer wird nur auf einem einzigen Pfad (Pipeline-Wohnungswahl) gesetzt und
 * ist deshalb fuer eine Auswertung unbrauchbar.
 *
 * Provision und Verkaufsdatum kommen aus der Provisionsrechnung (crm_invoices, ueber
 * deal_id verknuepft): das Rechnungsdatum IST das Verkaufsdatum (Vorgabe Sven 31.08.2026).
 * Ohne Rechnung greift die Reihenfolge Zahldatum -> Phasenwechsel -> Portal-Anlage, und
 * der Verkauf wird unten als Luecke gemeldet statt still zu verschwinden.
 */

// ── Types ──────────────────────────────────────────────────────
interface SaleRow {
  unitId:      string
  unitNumber:  string
  projectId:   string | null
  projectName: string
  developer:   string
  customer:    string | null
  date:        string | null   // Verkaufsdatum = Rechnungsdatum, sonst Ersatzdatum
  dateIsInvoice: boolean       // false = Ersatzdatum, weil keine Rechnung verknüpft ist
  invoiceNo:   string | null
  volume:      number          // Kaufpreis netto
  commission:  number
  paid:        number
  hasDeal:     boolean
  phase:       string | null   // Deal-Phase — zeigt, ob der Verkauf schon durch ist
}

interface DeveloperStat {
  developer:  string
  units:      number
  volume:     number
  commission: number
  paid:       number
  open:       number
  projects:   Set<string>
}

type Period = 'week' | 'month' | 'year' | 'lastyear' | 'all' | 'custom'

interface UnitRow {
  id:          string
  unit_number: string | null
  price_net:   number | null
  price_gross: number | null
  property_id: string | null
  project:     { id: string; name: string | null; developer: string | null } | null
}
interface PropRow  { id: string; owner_id: string | null; created_at: string }
interface InvoiceRow {
  invoice_number: string
  issue_date:     string
  subtotal_net:   number | null
  status:         string | null
  paid_at:        string | null
  deal_id:        string | null
}
interface DealRow  {
  id: string
  unit_id: string | null
  commission_amount: number | null
  commission_paid_at: string | null
  phase: string | null
  archived_from_phase: string | null
  phase_changed_at: string | null
  lead: { first_name: string | null; last_name: string | null } | null
}

// ── Zeitraum ───────────────────────────────────────────────────
function getPeriodRange(period: Period, customFrom: string, customTo: string): { from: string | null; to: string | null } {
  const now = new Date()
  if (period === 'all')    return { from: null, to: null }
  if (period === 'custom') return { from: customFrom || null, to: customTo || null }

  const to = now.toISOString().slice(0, 10)
  if (period === 'week') {
    const d = new Date(now)
    d.setDate(d.getDate() - 7)
    return { from: d.toISOString().slice(0, 10), to }
  }
  if (period === 'month')    return { from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, to }
  if (period === 'year')     return { from: `${now.getFullYear()}-01-01`, to }
  if (period === 'lastyear') { const y = now.getFullYear() - 1; return { from: `${y}-01-01`, to: `${y}-12-31` } }
  return { from: null, to: null }
}

export default function Statistics() {
  const { t } = useTranslation()
  const { fmtDate } = useDateFormat()

  const [period,     setPeriod]     = useState<Period>('year')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')
  const [sales,      setSales]      = useState<SaleRow[]>([])
  const [orphanDeals, setOrphanDeals] = useState(0)   // Provision kassiert, aber keine Wohnung verknuepft
  const [loading,    setLoading]    = useState(true)
  const [loadError,  setLoadError]  = useState<string | null>(null)
  const [devFilter,  setDevFilter]  = useState('')   // '' = alle Bauträger
  const [expanded,   setExpanded]   = useState<string | null>(null)

  // ── Laden ────────────────────────────────────────────────────
  const fetchSales = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      // 1. Alle Wohnungen, die im Kundenportal materialisiert sind
      const { data: unitData, error: unitErr } = await supabase
        .from('crm_project_units')
        .select('id, unit_number, price_net, price_gross, property_id, project:crm_projects(id, name, developer)')
        .not('property_id', 'is', null)
      if (unitErr) throw unitErr
      const units = (unitData ?? []) as unknown as UnitRow[]

      // 2. Portal-Objekte (Eigentuemer + Anlagedatum als Fallback-Verkaufsdatum)
      const propIds = units.map(u => u.property_id).filter((v): v is string => !!v)
      const { data: propData, error: propErr } = propIds.length
        ? await supabase.from('properties').select('id, owner_id, created_at').in('id', propIds)
        : { data: [], error: null }
      if (propErr) throw propErr
      const propById = new Map((propData ?? []).map(p => [(p as PropRow).id, p as PropRow]))

      // 3. Deals (Provision + Datum + Kundenname)
      const { data: dealData, error: dealErr } = await supabase
        .from('deals')
        .select('id, unit_id, commission_amount, commission_paid_at, phase, archived_from_phase, phase_changed_at, lead:leads(first_name, last_name)')
      if (dealErr) throw dealErr
      const deals = (dealData ?? []) as unknown as DealRow[]

      // Pro Wohnung den relevantesten Deal: erst der mit Provision, sonst der neueste
      const dealByUnit = new Map<string, DealRow>()
      for (const d of deals) {
        if (!d.unit_id) continue
        const cur = dealByUnit.get(d.unit_id)
        if (!cur) { dealByUnit.set(d.unit_id, d); continue }
        const better = (d.commission_amount ?? 0) > (cur.commission_amount ?? 0)
          || (!cur.commission_paid_at && !!d.commission_paid_at)
        if (better) dealByUnit.set(d.unit_id, d)
      }

      // Provision kassiert, aber keine Wohnung verknuepft → taucht in keiner Auswertung auf
      setOrphanDeals(deals.filter(d => !d.unit_id && (d.commission_amount ?? 0) > 0).length)

      // 4. Provisionsrechnungen — Rechnungsdatum ist das Verkaufsdatum
      const { data: invData, error: invErr } = await supabase
        .from('crm_invoices')
        .select('invoice_number, issue_date, subtotal_net, status, paid_at, deal_id')
        .not('deal_id', 'is', null)
        .neq('status', 'canceled')
      if (invErr) throw invErr
      // Bei mehreren Rechnungen je Deal zaehlt die aelteste (die den Verkauf ausloest);
      // Betraege werden addiert, damit Teilrechnungen nicht verlorengehen.
      const invByDeal = new Map<string, { first: InvoiceRow; net: number; paid: number }>()
      for (const raw of (invData ?? []) as unknown as InvoiceRow[]) {
        if (!raw.deal_id) continue
        const net  = Number(raw.subtotal_net ?? 0)
        const paid = raw.status === 'paid' || raw.paid_at ? net : 0
        const cur  = invByDeal.get(raw.deal_id)
        if (!cur) { invByDeal.set(raw.deal_id, { first: raw, net, paid }); continue }
        cur.net  += net
        cur.paid += paid
        if (raw.issue_date < cur.first.issue_date) cur.first = raw
      }

      const rows: SaleRow[] = []
      for (const u of units) {
        const prop = u.property_id ? propById.get(u.property_id) : undefined
        if (!prop?.owner_id) continue          // Portal-Objekt ohne Eigentuemer = kein Verkauf
        const d   = dealByUnit.get(u.id)
        const inv = d ? invByDeal.get(d.id) : undefined
        rows.push({
          unitId:      u.id,
          unitNumber:  u.unit_number ?? '—',
          projectId:   u.project?.id ?? null,
          projectName: u.project?.name ?? '—',
          developer:   (u.project?.developer ?? '').trim() || t('stats.noDeveloper', 'Ohne Bauträger'),
          customer:    d?.lead ? `${d.lead.first_name ?? ''} ${d.lead.last_name ?? ''}`.trim() : null,
          date:          inv?.first.issue_date
                      ?? d?.commission_paid_at ?? d?.phase_changed_at ?? prop.created_at ?? null,
          dateIsInvoice: !!inv,
          invoiceNo:     inv?.first.invoice_number ?? null,
          volume:      Number(u.price_net ?? u.price_gross ?? 0),
          commission:  inv ? inv.net  : Number(d?.commission_amount ?? 0),
          paid:        inv ? inv.paid : (d?.commission_paid_at ? Number(d?.commission_amount ?? 0) : 0),
          hasDeal:     !!d,
          phase:       d ? (d.archived_from_phase ?? d.phase) : null,
        })
      }
      setSales(rows)
    } catch (err) {
      console.error('[Statistics] fetchSales:', err)
      setLoadError(err instanceof Error ? err.message : String(err))
      setSales([])
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void fetchSales() }, [fetchSales])

  // ── Zeitraum-Filter ──────────────────────────────────────────
  const inPeriod = useMemo(() => {
    const { from, to } = getPeriodRange(period, customFrom, customTo)
    if (!from && !to) return sales
    return sales.filter(s => {
      if (!s.date) return false
      const day = s.date.slice(0, 10)
      if (from && day < from) return false
      if (to   && day > to)   return false
      return true
    })
  }, [sales, period, customFrom, customTo])

  // ── Bauträger-Filter ─────────────────────────────────────────
  // Die Auswahlliste kommt aus ALLEN Verkäufen, nicht nur aus dem Zeitraum —
  // sonst verschwindet der gerade gewählte Bauträger beim Umschalten der Periode.
  const developerOptions = useMemo(() => {
    const names = Array.from(new Set(sales.map(s => s.developer))).sort((a, b) => a.localeCompare(b))
    return [{ value: '', label: t('stats.allDevelopers', 'Alle Bauträger') },
            ...names.map(n => ({ value: n, label: n }))]
  }, [sales, t])

  const filtered = useMemo(
    () => devFilter ? inPeriod.filter(s => s.developer === devFilter) : inPeriod,
    [inPeriod, devFilter])

  // Bei gewähltem Bauträger die Einzelwohnungen direkt aufklappen
  useEffect(() => { setExpanded(devFilter || null) }, [devFilter])

  // ── Gruppierung nach Bauträger ───────────────────────────────
  const byDeveloper = useMemo(() => {
    const map = new Map<string, DeveloperStat>()
    for (const s of filtered) {
      const cur = map.get(s.developer) ?? {
        developer: s.developer, units: 0, volume: 0, commission: 0, paid: 0, open: 0, projects: new Set<string>(),
      }
      cur.units      += 1
      cur.volume     += s.volume
      cur.commission += s.commission
      cur.paid       += s.paid
      cur.open       += Math.max(0, s.commission - s.paid)
      if (s.projectName) cur.projects.add(s.projectName)
      map.set(s.developer, cur)
    }
    return Array.from(map.values()).sort((a, b) =>
      b.units - a.units || b.commission - a.commission || a.developer.localeCompare(b.developer))
  }, [filtered])

  const totals = useMemo(() => byDeveloper.reduce((a, s) => ({
    units:      a.units + s.units,
    volume:     a.volume + s.volume,
    commission: a.commission + s.commission,
    paid:       a.paid + s.paid,
    open:       a.open + s.open,
  }), { units: 0, volume: 0, commission: 0, paid: 0, open: 0 }), [byDeveloper])

  // ── Datenlücken (Zeitraum-unabhängig, sonst „verschwinden“ sie) ──
  const gaps = useMemo(() => ({
    withoutDeal:       sales.filter(s => !s.hasDeal).length,
    withoutInvoice:    sales.filter(s => !s.dateIsInvoice).length,
    orphanDeals,
  }), [sales, orphanDeals])

  // ── Formatierung ─────────────────────────────────────────────
  const fmtEur = (n: number) =>
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
  const fmtPct = (part: number, whole: number) =>
    whole > 0 ? `${(part / whole * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : '–'

  const PERIODS: { id: Period; label: string }[] = [
    { id: 'week',     label: t('stats.period.week', 'Diese Woche') },
    { id: 'month',    label: t('stats.period.month', 'Dieser Monat') },
    { id: 'year',     label: t('stats.period.year', 'Dieses Jahr') },
    { id: 'lastyear', label: t('stats.period.lastyear', 'Letztes Jahr') },
    { id: 'all',      label: t('stats.period.all', 'Alle Zeit') },
    { id: 'custom',   label: t('stats.period.custom', 'Benutzerdefiniert') },
  ]

  const maxUnits = byDeveloper[0]?.units ?? 0

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-heading font-bold text-hp-black">{t('stats.salesTitle', 'Verkäufe')}</h1>
          <p className="text-sm text-gray-500 font-body mt-1">
            {t('stats.salesSubtitle', 'Verkaufte Wohnungen und Provision je Bauträger. Verkaufsdatum ist das Datum der Provisionsrechnung.')}
          </p>
        </div>

        {/* Zeitraum */}
        <div className="flex gap-2 flex-wrap">
          {PERIODS.map(p => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium font-body border transition-colors ${
                period === p.id
                  ? 'bg-hp-slate text-white border-hp-slate'
                  : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {period === 'custom' && (
          <div className="flex gap-3 items-center">
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-body focus:outline-none focus:ring-2 focus:ring-hp-highlight/40" />
            <span className="text-gray-400">–</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-body focus:outline-none focus:ring-2 focus:ring-hp-highlight/40" />
          </div>
        )}

        {/* Bauträger */}
        {developerOptions.length > 1 && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-64">
              <CustomSelect value={devFilter} onChange={setDevFilter} options={developerOptions} />
            </div>
            {devFilter && (
              <button onClick={() => setDevFilter('')}
                className="text-sm font-body text-gray-500 hover:text-hp-black underline underline-offset-2">
                {t('stats.resetDeveloper', 'Filter zurücksetzen')}
              </button>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-gray-200 border-t-hp-highlight rounded-full animate-spin" />
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <p className="text-sm text-red-600 font-body">{t('stats.loadError', 'Daten konnten nicht geladen werden.')} {loadError}</p>
            <button onClick={() => void fetchSales()}
              className="mt-3 px-3 py-1.5 rounded-lg text-sm font-body border border-gray-200 hover:border-gray-300">
              {t('stats.retry', 'Erneut versuchen')}
            </button>
          </div>
        ) : (
          <>
            {/* Kennzahlen */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Kpi label={t('stats.unitsSold', 'Wohnungen verkauft')} value={String(totals.units)} />
              <Kpi label={t('stats.volume', 'Verkaufsvolumen')}       value={fmtEur(totals.volume)} />
              <Kpi label={t('stats.commissionTotal', 'Provision gesamt')} value={fmtEur(totals.commission)} />
              <Kpi label={t('stats.commissionPaid', 'davon erhalten')}    value={fmtEur(totals.paid)}
                   hint={totals.open > 0 ? t('stats.commissionOpen', '{{sum}} offen', { sum: fmtEur(totals.open) }) : undefined} />
            </div>

            {/* Tabelle je Bauträger */}
            {byDeveloper.length === 0 ? (
              <p className="text-gray-400 text-center py-16 font-body">{t('stats.noData', 'Keine Daten für diesen Zeitraum.')}</p>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px]">
                    <thead className="bg-gray-50 border-b border-gray-100">
                      <tr>
                        <th className="px-5 py-3 text-left  text-xs font-semibold text-gray-500 uppercase font-body">{t('stats.developer', 'Developer')}</th>
                        <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase font-body">{t('stats.units', 'Einheiten')}</th>
                        <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase font-body">{t('stats.volume', 'Verkaufsvolumen')}</th>
                        <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase font-body">{t('stats.commissionTotal', 'Provision gesamt')}</th>
                        <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase font-body">{t('stats.commissionPaid', 'davon erhalten')}</th>
                        <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase font-body">{t('stats.commissionRate', 'Provisionssatz')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {byDeveloper.map(s => (
                        <Fragment key={s.developer}>
                          <tr
                              onClick={() => setExpanded(expanded === s.developer ? null : s.developer)}
                              className="hover:bg-gray-50 cursor-pointer">
                            <td className="px-5 py-3">
                              <div className="font-medium text-hp-black font-body">{s.developer}</div>
                              <div className="mt-1 h-1 rounded-full bg-gray-100 overflow-hidden max-w-[160px]">
                                <div className="h-full bg-hp-highlight rounded-full"
                                     style={{ width: `${maxUnits > 0 ? (s.units / maxUnits) * 100 : 0}%` }} />
                              </div>
                              <div className="text-xs text-gray-400 font-body mt-1">
                                {t('stats.projectsCount', '{{count}} Projekte', { count: s.projects.size })}
                              </div>
                            </td>
                            <td className="px-5 py-3 text-right text-gray-800 font-body">{s.units}</td>
                            <td className="px-5 py-3 text-right text-gray-700 font-body">{s.volume > 0 ? fmtEur(s.volume) : '–'}</td>
                            <td className="px-5 py-3 text-right text-gray-800 font-body">{s.commission > 0 ? fmtEur(s.commission) : '–'}</td>
                            <td className="px-5 py-3 text-right font-body">
                              <span className={s.paid > 0 ? 'text-green-700 font-medium' : 'text-gray-400'}>
                                {s.paid > 0 ? fmtEur(s.paid) : '–'}
                              </span>
                              {s.open > 0 && (
                                <div className="text-xs text-amber-600">{t('stats.openShort', '{{sum}} offen', { sum: fmtEur(s.open) })}</div>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right text-gray-600 font-body">{fmtPct(s.commission, s.volume)}</td>
                          </tr>
                          {expanded === s.developer && (
                            <tr className="bg-gray-50/60">
                              <td colSpan={6} className="px-5 py-3">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {filtered.filter(x => x.developer === s.developer)
                                      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
                                      .map(x => (
                                        <tr key={x.unitId} className="border-b border-gray-100 last:border-0">
                                          <td className="py-2 pr-3 font-body text-gray-800">{x.projectName} · {x.unitNumber}</td>
                                          <td className="py-2 pr-3 font-body text-gray-500">{x.customer ?? t('stats.noCustomer', 'Kunde nicht verknüpft')}</td>
                                          <td className="py-2 pr-3 font-body text-gray-500">
                                            {fmtDate(x.date)}
                                            {x.dateIsInvoice
                                              ? <span className="text-gray-400"> · {x.invoiceNo}</span>
                                              : <span className="text-amber-600" title={t('stats.dateEstimatedHint', 'Keine Provisionsrechnung verknüpft — Ersatzdatum aus dem Deal.')}> · {t('stats.dateEstimated', 'ohne Rechnung')}</span>}
                                          </td>
                                          <td className="py-2 pr-3 font-body text-gray-400">
                                            {x.phase ? t(`crm.phases.${x.phase}`, x.phase) : '—'}
                                          </td>
                                          <td className="py-2 pr-3 font-body text-gray-700 text-right">{x.volume > 0 ? fmtEur(x.volume) : '–'}</td>
                                          <td className="py-2 font-body text-right">
                                            {x.commission > 0
                                              ? <span className={x.paid > 0 ? 'text-green-700' : 'text-amber-600'}>{fmtEur(x.commission)}</span>
                                              : <span className="text-gray-400">{t('stats.noCommission', 'keine Provision erfasst')}</span>}
                                          </td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                      <tr>
                        <td className="px-5 py-3 font-semibold text-hp-black font-body">{t('stats.total', 'Gesamt')}</td>
                        <td className="px-5 py-3 text-right font-semibold text-hp-black font-body">{totals.units}</td>
                        <td className="px-5 py-3 text-right font-semibold text-hp-black font-body">{totals.volume > 0 ? fmtEur(totals.volume) : '–'}</td>
                        <td className="px-5 py-3 text-right font-semibold text-hp-black font-body">{totals.commission > 0 ? fmtEur(totals.commission) : '–'}</td>
                        <td className="px-5 py-3 text-right font-semibold text-green-700 font-body">{totals.paid > 0 ? fmtEur(totals.paid) : '–'}</td>
                        <td className="px-5 py-3 text-right font-semibold text-gray-700 font-body">{fmtPct(totals.commission, totals.volume)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* Datenlücken */}
            {(gaps.withoutDeal > 0 || gaps.withoutInvoice > 0 || gaps.orphanDeals > 0) && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <p className="text-sm font-semibold text-amber-900 font-body mb-1">
                  {t('stats.gapsTitle', 'Diese Zahlen sind unvollständig')}
                </p>
                <ul className="text-sm text-amber-900/90 font-body list-disc pl-5 space-y-0.5">
                  {gaps.withoutDeal > 0 && (
                    <li>{t('stats.gapNoDeal', '{{count}} verkaufte Wohnungen haben keinen Deal — Kunde und Provision fehlen dort.', { count: gaps.withoutDeal })}</li>
                  )}
                  {gaps.withoutInvoice > 0 && (
                    <li>{t('stats.gapNoInvoice', '{{count}} Verkäufe haben keine Provisionsrechnung — dort steht ein Ersatzdatum, das den Zeitraumfilter verfälschen kann.', { count: gaps.withoutInvoice })}</li>
                  )}
                  {gaps.orphanDeals > 0 && (
                    <li>{t('stats.gapOrphanDeal', '{{count}} Deals mit Provision haben keine Wohnung verknüpft und fehlen deshalb beim Bauträger.', { count: gaps.orphanDeals })}</li>
                  )}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}

// ── Kennzahl-Kachel ────────────────────────────────────────────
function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4">
      <p className="text-xs uppercase tracking-wide text-gray-400 font-body">{label}</p>
      <p className="text-xl font-semibold text-hp-black font-body mt-1">{value}</p>
      {hint && <p className="text-xs text-amber-600 font-body mt-0.5">{hint}</p>}
    </div>
  )
}
