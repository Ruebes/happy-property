import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { compute, type CalcContent, type CalcItem, type CalcResult } from '../lib/rechner'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Öffentliche Rendite-Rechnung / Immobilienvergleich (HTML-Microsite) ───────
// /rechnung/:token — Einzelobjekt = detaillierte Auswertung (8 Abschnitte, exakt
// nach dem Original-Rechner-Export), oder Vergleich mehrerer Objekte. Rechnet live
// aus den gespeicherten Parametern mit der verifizierten Engine.

const CORAL = '#ff795d', DARK = '#2e3c47', GREEN = '#2d8a5e', RED = '#c03030'
const BLUE = '#2563eb', RENTG = '#10b981', PURPLE = '#7c3aed'
const PALETTE = ['#2f6b4f', '#226f8f', '#ff795d', '#7a5a9e', '#b8860b']
const SERIF = "'Playfair Display',Georgia,serif"
const SANS = "'Montserrat','Helvetica Neue',Arial,sans-serif"

const eur = (n: number | null | undefined) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(n))
const pct = (n: number | null | undefined, d = 1) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n) + ' %'
// Einrichtung inkl. MwSt: 19% außer im Share-Deal (sdMode, netto ausgewiesen).
const furnGrossOf = (pa: { furnCost?: number | null; furnFree?: boolean; dealType?: string }): number => {
  const c = pa.furnFree ? 0 : (pa.furnCost ?? 0)
  return pa.dealType === 'share' ? c : Math.round(c * 1.19)
}
const short = (v: number) => v >= 1e6 ? (v / 1e6).toFixed(2).replace('.', ',') + ' M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : Math.round(v).toString()

interface Row { item: CalcItem; color: string; res: CalcResult | null }

// ── Responsive-Helfer ────────────────────────────────────────────────────────
// Die ganze Seite ist inline-gestylt; Tailwind-Breakpoints können Inline-Styles
// nicht überschreiben. Deshalb schalten wir die Layout-Werte über matchMedia
// (iPhone ≈ 375px) um. Desktop-Werte bleiben unverändert.
const MOBILE_QUERY = '(max-width: 640px)'
function useIsMobile(): boolean {
  const get = () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  const [isMobile, setIsMobile] = useState<boolean>(get)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

export default function Rechnung() {
  const { t } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const [content, setContent] = useState<CalcContent | null>(null)
  const [meta, setMeta] = useState<{ recipient_name?: string; title?: string; with_calc?: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const isMobile = useIsMobile()

  useEffect(() => { void (async () => {
    if (!token) return
    const { data, error } = await supabase.rpc('get_calculation_by_token', { p_token: token })
    const row = Array.isArray(data) ? data[0] : data
    if (error || !row) { setErr(t('rechnung.notFound', 'Diese Rechnung wurde nicht gefunden.')); setLoading(false); return }
    setContent(row.content as CalcContent)
    setMeta({ recipient_name: row.recipient_name, title: row.title, with_calc: row.with_calc })
    setLoading(false)
  })() }, [token])

  // Engagement-Tracking (fire-and-forget): loggt den Berechnungs-Aufruf fürs CRM-Dashboard.
  // Interne Kontroll-Aufrufe zählen nicht: eingeloggter Nutzer (Team) oder ?preview=1.
  useEffect(() => {
    if (!token) return
    if (new URLSearchParams(window.location.search).get('preview') === '1') return
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) return
      supabase.functions.invoke('track-engagement', { body: { type: 'calc_view', token } }).catch(() => { /* egal */ })
    })()
  }, [token])

  const rows: Row[] = useMemo(() => {
    if (!content?.items) return []
    return content.items.map((item, i) => ({
      item, color: item.color || PALETTE[i % PALETTE.length],
      res: item.params ? compute(item.params) : null,
    }))
  }, [content])

  if (loading) return <Centered>{t('rechnung.loading', 'Lädt…')}</Centered>
  if (err || !content) return <Centered>{err || t('rechnung.genericNotFound', 'Nicht gefunden.')}</Centered>

  const name = meta?.recipient_name || content.recipient_name || ''
  const withCalc = (meta?.with_calc ?? content.with_calc) && rows.some(r => r.res)
  const isCompare = rows.length > 1
  const today = new Date().toLocaleDateString('de-DE')
  const projLabel = rows[0]?.item.label || rows[0]?.item.project || ''

  return (
    <div style={{ background: '#f4f3f1', minHeight: '100vh', fontFamily: SANS, color: '#1a1a1a' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: isMobile ? '18px 14px 48px' : '28px 22px 64px' }}>
        {/* Kopf wie im Original-Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 14, marginBottom: 6 }}>
          <img src={DECK_LOGO} alt="Happy Property Cyprus" style={{ height: isMobile ? 38 : 46, width: 'auto', borderRadius: 8, flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: SERIF, fontSize: isMobile ? 20 : 26, fontWeight: 800, color: DARK, lineHeight: 1.15 }}>
              {isCompare ? t('rechnung.titleCompare', 'Immobilienvergleich') : t('rechnung.titleSingle', 'Rendite & Cashflow – Übersicht')}
            </div>
            <div style={{ fontSize: 12.5, color: '#666', marginTop: 2 }}>
              {name && <>{t('rechnung.customerLabel', 'Kunde')}: <b>{name}</b></>}{name && projLabel ? ' · ' : ''}{projLabel && <>{t('rechnung.projectLabel', 'Projekt')}: <b>{projLabel}</b></>}
            </div>
            <div style={{ fontSize: 11, color: '#aaa' }}>{t('rechnung.generatedOn', 'Generiert am {{date}}', { date: today })}</div>
          </div>
        </div>
        <div style={{ height: 3, background: `linear-gradient(90deg,${CORAL},#ffb89d)`, borderRadius: 2, marginBottom: 22 }} />

        {content.intro && <p style={{ fontSize: isMobile ? 13.5 : 14.5, lineHeight: 1.7, color: '#444', whiteSpace: 'pre-wrap', margin: '0 0 24px', maxWidth: 760 }}>{content.intro}</p>}

        {/* ── EINZEL-ANSICHT: detaillierte Auswertung ─────────────── */}
        {!isCompare && withCalc && rows[0]?.res && <Single row={rows[0]} today={today} isMobile={isMobile} />}

        {/* ── VERGLEICH ──────────────────────────────────────────── */}
        {isCompare && (
          <>
            <CompareCards rows={rows} withCalc={withCalc} isMobile={isMobile} />
            {rows.some(r => r.item.strategy_title || r.item.strategy_text) && <StrategyCards rows={rows} isMobile={isMobile} />}
            {withCalc && <CompareTable rows={rows} />}
            {withCalc && <Bars rows={rows} isMobile={isMobile} />}
            {withCalc && <CashflowTable rows={rows} />}
          </>
        )}

        {!withCalc && <SpecsCard rows={rows} />}

        <p style={{ fontSize: 10.5, color: '#aaa', marginTop: 36, lineHeight: 1.6 }}>
          <b>{t('rechnung.disclaimerLabel', 'Haftungsausschluss')}:</b> {t('rechnung.disclaimerText', 'Unverbindliche Information, keine steuerliche/rechtliche/finanzielle Beratung. Alle Angaben ohne Gewähr. IRR = interne Kapitalrendite auf das eingesetzte Eigenkapital (jährlich). Stand: {{date}}.', { date: today })}
        </p>
      </div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontFamily: SANS, background: '#f4f3f1' }}>{children}</div>
}

const Card = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => {
  const isMobile = useIsMobile()
  return (
    <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.05)', padding: isMobile ? 16 : 22, ...style }}>{children}</div>
  )
}
const H2 = ({ children }: { children: ReactNode }) => (
  <h2 style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 12px', borderBottom: '2px solid #f0e8d8', paddingBottom: 6 }}>{children}</h2>
)
const Note = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize: 12, color: '#666', lineHeight: 1.55, background: '#f5f2ec', borderRadius: 8, padding: '10px 13px', marginTop: 14, borderLeft: `3px solid ${CORAL}` }}>{children}</div>
)
function KV({ k, v, color, strong }: { k: ReactNode; v: ReactNode; color?: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: strong ? '2px solid #1a1a1a' : '1px solid #eee', padding: strong ? '9px 0' : '7px 0', fontSize: strong ? 15 : 13 }}>
      <span style={{ color: strong ? '#1a1a1a' : '#888', fontWeight: strong ? 700 : 400 }}>{k}</span>
      <span style={{ fontWeight: strong ? 800 : 700, color: color || '#1a1a1a', textAlign: 'right' }}>{v}</span>
    </div>
  )
}

// ── Detaillierte Einzel-Auswertung (8 Abschnitte, exakt nach Original) ────────
function Single({ row, isMobile }: { row: Row; today: string; isMobile: boolean }) {
  const { t } = useTranslation()
  const r = row.res!
  const p = row.item.params!
  const yl = (i: number) => i === 0 ? `${r.yN[0]} (${r.mF} Mon.)` : String(r.yN[i])
  // abgeleitete Reihen (Formeln 1:1 aus dem Original-Export)
  const cumRent: number[] = []; { let a = 0; r.rents.forEach(x => { a += x; cumRent.push(a) }) }
  const ekYear = r.propV.map((v, i) => v - r.restL[i])
  const gesamtkap = r.propV.map((v, i) => v - r.restL[i] + cumRent[i])
  const mietrend = r.rents.map(x => x / r.pNet * 100)
  const gesamtrend = r.rents.map((x, i) => { const rA = x * 0.81; const ap = r.propV[i] - (i === 0 ? r.pGross : r.propV[i - 1]); return (rA + ap) / r.pNet * 100 })
  const td: CSSProperties = { padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #eee', fontSize: 12.5, whiteSpace: 'nowrap' }
  const th: CSSProperties = { background: DARK, color: '#fff', padding: '8px 10px', textAlign: 'right', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 700, whiteSpace: 'nowrap' }

  return (
    <>
      {/* 1. Übersicht: Investitionsdaten + Summen & Kennzahlen */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
        <Card>
          <H2>{t('rechnung.investmentDataTitle', 'Investitionsdaten')}</H2>
          {p.discountPct > 0 ? (<>
            <KV k={t('rechnung.listPriceNet', 'Listenpreis netto')} v={eur(r.pNetList)} />
            <KV k={t('rechnung.discountPct', 'Rabatt {{pct}}', { pct: pct(r.discountPct) })} v={`−${eur(r.discountAmt)}`} color={GREEN} />
            <KV k={t('rechnung.purchasePriceNetAfterDiscount', 'Kaufpreis netto (nach Rabatt)')} v={eur(r.pNet)} />
          </>) : <KV k={t('rechnung.purchasePriceNet', 'Kaufpreis netto')} v={eur(r.pNet)} />}
          <KV k={t('rechnung.vat19', 'Umsatzsteuer (19%)')} v={eur(r.vatAmt)} />
          <KV k={t('rechnung.purchasePriceGross', 'Kaufpreis brutto')} v={eur(r.pGross)} />
          {/* Transparente Gesamtkosten: Kaufpreis brutto + Einrichtung (netto + MwSt)
              = Gesamtpreis brutto. Bei inkludierter Einrichtung (z.B. Infinity)
              „inklusive". furnGross = Einrichtung inkl. MwSt (19%, im sdMode netto). */}
          {(r.furnFree || r.furnCost > 0) && <KV k={r.furnFree ? t('rechnung.furnishing', 'Einrichtung') : t('rechnung.furnishingNet', 'Einrichtung (netto)')} v={r.furnFree ? t('rechnung.included', 'inklusive') : `+ ${eur(r.furnCost)}`} color={r.furnFree ? GREEN : CORAL} />}
          {r.furnVat > 0 && <KV k={t('rechnung.furnishingVat', 'MwSt auf Einrichtung (19%)')} v={`+ ${eur(r.furnVat)}`} color={CORAL} />}
          {(r.furnFree || r.furnCost > 0) && <KV k={t('rechnung.totalPrice', 'Gesamtpreis')} v={eur(r.pGross + r.furnGross)} strong />}
          <KV k={t('rechnung.legalFees1pct', 'Anwaltskosten (1%)')} v={eur(r.costs)} />
          <KV k={t('rechnung.equityStart', 'Eigenkapital (Start)')} v={eur(r.ekStart)} />
          <KV k={t('rechnung.financing', 'Fremdfinanzierung')} v={eur(r.loan)} />
          <KV k={t('rechnung.bedrooms', 'Schlafzimmer')} v={String(r.bedrooms)} />
        </Card>
        <Card>
          <H2>{t('rechnung.totalsMetricsTitle', 'Summen & Kennzahlen (10 Jahre)')}</H2>
          <KV k={t('rechnung.totalGrossRent', 'Bruttomiete gesamt')} v={eur(r.sumR)} color={CORAL} />
          <KV k={t('rechnung.totalCosts', 'Kosten gesamt')} v={eur(r.sumC)} />
          <KV k={t('rechnung.totalTaxes', 'Steuern gesamt')} v={eur(r.sumT)} />
          <KV k={t('rechnung.afterTaxIncome', 'Ertrag nach Steuern')} v={eur(r.sumCF)} />
          <KV k={t('rechnung.propertyValueY10', 'Immobilienwert J10')} v={eur(r.propV[9])} color={CORAL} />
          <KV k={t('rechnung.equityEndY10', 'EK Ende J10')} v={eur(r.ek10)} color={GREEN} />
          <KV k={t('rechnung.totalReturn', 'Gesamtertrag')} v={eur(r.totRet)} color={GREEN} />
          <KV k={t('rechnung.equityReturnCum10y', 'EK-Rendite kum. (10J)')} v={pct(r.roe10)} color={CORAL} />
          <KV k={t('rechnung.equityIrrAnnual', 'EK-IRR (jährlich)')} v={pct(r.irrV * 100, 2)} color={CORAL} />
        </Card>
      </div>

      {/* 2. Annahmen & Parameter */}
      <Card style={{ marginTop: 18 }}>
        <H2>{t('rechnung.assumptionsParamsTitle', 'Annahmen & Parameter')}</H2>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 26px' }}>
          <div>
            <KV k={t('rechnung.financingLabel', 'Finanzierung')} v={r.fin === 'yes' ? t('rechnung.financed', 'finanziert') : t('rechnung.cashPurchase', 'Barkauf')} />
            <KV k={t('rechnung.taxResidence', 'Steuersitz')} v={r.resCY ? t('rechnung.cyprus', 'Zypern') : t('rechnung.germany', 'Deutschland')} />
            <KV k={t('rechnung.purchasePriceGross', 'Kaufpreis brutto')} v={eur(r.pGross)} />
            <KV k={t('rechnung.equityStart', 'Eigenkapital (Start)')} v={eur(r.ekStart)} />
            <KV k={t('rechnung.bedrooms', 'Schlafzimmer')} v={String(r.bedrooms)} />
            <KV k={t('rechnung.grossYieldY1', 'Bruttorendite J1')} v={pct(r.yPct) + (r.discountPct > 0 ? ` → ${pct(r.effYield)}` : '')} />
            <KV k={r.letT === 'short' ? t('rechnung.holidayMgmtCommission', 'Ferienverwaltung & Buchungsprovision') : t('rechnung.ongoingCosts', 'Laufende Kosten')}
              v={t('rechnung.pctPlusAnnual', '{{pct}} (+2% p.a.){{hotel}}', { pct: pct(r.mgP), hotel: r.letT === 'short' && r.hotelConcept ? ` · 🏨 ${t('rechnung.hotelConceptShort', 'Hotelkonzept')}` : '' })} />
            <KV k={t('rechnung.loanTerm', 'Laufzeit Kredit')} v={t('rechnung.years', '{{n}} Jahre', { n: r.termY })} />
            <KV k={t('rechnung.depreciationDE', 'AfA (DE)')} v={t('rechnung.depreciationDEValue', '5% degr. auf 80% brutto')} />
          </div>
          <div>
            <KV k={t('rechnung.letType', 'Vermietungsart')} v={r.letT === 'short' ? t('rechnung.shortTermVatRefund', 'Kurzzeit (USt.-Erstattung ~24 Mon.)') : t('rechnung.longTerm', 'Langzeit')} />
            <KV k={t('rechnung.handover', 'Schlüsselübergabe')} v={`${String(r.km).padStart(2, '0')}/${r.ky} – ${t('rechnung.y1MonthsShort', 'J1: {{n}} Mon.', { n: r.mF })}`} />
            <KV k={t('rechnung.vat19', 'Umsatzsteuer (19%)')} v={eur(r.vatAmt)} />
            <KV k={t('rechnung.legalFees1pct', 'Anwaltskosten (1%)')} v={eur(r.costs)} />
            <KV k={t('rechnung.financing', 'Fremdfinanzierung')} v={eur(r.loan)} />
            <KV k={t('rechnung.rentGrowthAnnual', 'Mietsteigerung p.a.')} v={pct(r.rG)} />
            <KV k={t('rechnung.interestRate', 'Zinssatz')} v={pct(r.iP)} />
            <KV k={t('rechnung.appreciationAnnual', 'Wertsteigerung p.a.')} v={pct(r.appP)} />
            <KV k={t('rechnung.depreciationCY', 'AfA (CY)')} v={t('rechnung.depreciationCYValue', '3% lin. auf 80% brutto')} />
          </div>
        </div>
      </Card>

      {/* 3. Tabelle A – Cashflow */}
      <H2Section>{t('rechnung.tableACashflow', 'Tabelle A – Cashflow (10 Jahre)')}</H2Section>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>{t('rechnung.yearCol', 'Jahr')}</th><th style={th}>{t('rechnung.grossRentCol', 'Bruttomiete')}</th>
              <th style={th}>{r.letT === 'short' ? t('rechnung.holidayMgmtCol', 'Ferienverw.') : t('rechnung.ongoingCol', 'Laufend')}</th><th style={th}>{t('rechnung.interestCol', 'Zinsen')}</th>
              <th style={th}>{t('rechnung.repaymentCol', 'Tilgung')}</th><th style={th}>{t('rechnung.loanRateCol', 'Kreditrate')}</th><th style={th}>{t('rechnung.vatRefundCol', 'USt.-Erst.')}</th><th style={th}>{t('rechnung.taxCol', 'Steuer')}</th><th style={th}>{t('rechnung.netCfCol', 'CF netto')}</th>
            </tr></thead>
            <tbody>
              {r.yN.map((_, i) => {
                const tx = r.resCY ? r.taxCY[i] : r.taxDE[i]
                const cfN = r.cfA[i] - (r.vatA[i] || 0)
                return (
                  <tr key={i} style={{ background: i % 2 ? '#fafaf8' : '#fff' }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{yl(i)}</td>
                    <td style={td}>{eur(r.rents[i])}</td><td style={td}>{eur(r.mgmt[i])}</td>
                    <td style={td}>{eur(r.intC[i])}</td><td style={td}>{eur(r.princC[i])}</td><td style={td}>{eur(r.rateC[i])}</td>
                    <td style={{ ...td, color: GREEN, fontWeight: 700 }}>{r.vatA[i] > 0 ? eur(r.vatA[i]) : '–'}</td>
                    <td style={{ ...td, color: tx < 0 ? GREEN : '#1a1a1a', fontWeight: tx < 0 ? 700 : 400 }}>{tx < 0 ? eur(-tx) : eur(tx)}</td>
                    <td style={{ ...td, color: cfN >= 0 ? GREEN : RED, fontWeight: 700 }}>{eur(cfN)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {r.letT === 'short' && r.hotelConcept && <Note>🏨 <b>{t('rechnung.hotelConceptLabel', 'Hotelkonzept')}:</b> {t('rechnung.hotelConceptNote', 'Verwaltung übernimmt komplettes Hotelservice inkl. Reinigung, Check-in, Marketing & 24/7 Gästebetreuung.')}</Note>}
      <Note>{t('rechnung.cashflowNote', 'Der Cashflow zeigt die tatsächlichen Einnahmen nach allen Kosten, Kreditraten und Steuern. Positive Werte bedeuten Überschuss aus der Immobilie. Die einmalige USt.-Erstattung ist separat ausgewiesen.')}</Note>

      {/* 4. Tabelle B – Darlehen / EK / Werte */}
      <H2Section>{t('rechnung.tableBLoanEquity', 'Tabelle B – Darlehen / EK / Werte (10 Jahre)')}</H2Section>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>{t('rechnung.yearCol', 'Jahr')}</th><th style={th}>{t('rechnung.repaymentCol', 'Tilgung')}</th><th style={th}>{t('rechnung.specialRepaymentCol', 'Sondertilg.')}</th>
              <th style={th}>{t('rechnung.remainingDebtCol', 'Restschuld')}</th><th style={th}>{t('rechnung.propertyValueCol', 'Immobilienwert')}</th><th style={th}>{t('rechnung.equityCol', 'Eigenkapital')}</th>
            </tr></thead>
            <tbody>
              {r.yN.map((_, j) => (
                <tr key={j} style={{ background: j % 2 ? '#fafaf8' : '#fff' }}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{yl(j)}</td>
                  <td style={td}>{eur(r.princC[j])}</td><td style={td}>{r.prepayC[j] > 0 ? eur(r.prepayC[j]) : t('rechnung.zeroEuro', '0 €')}</td>
                  <td style={td}>{eur(r.restL[j])}</td>
                  <td style={{ ...td, color: CORAL, fontWeight: 700 }}>{eur(r.propV[j])}</td>
                  <td style={{ ...td, color: GREEN, fontWeight: 700 }}>{eur(ekYear[j])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Note>{t('rechnung.equityNote', 'Das Eigenkapital ergibt sich aus Immobilienwert minus Restschuld. Durch Wertsteigerung und Tilgung wächst das EK erheblich über die Zeit.')}</Note>

      {/* 5. Chart EK-Entwicklung */}
      <H2Section>{t('rechnung.equityDevelopmentTitle', 'Entwicklung des Eigenkapitals (Wert − Restschuld)')}</H2Section>
      <Card><BarChart labels={r.yN} series={[{ data: ekYear, color: BLUE }]} /></Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>{t('rechnung.equityAfter10y', 'Nach 10 Jahren beträgt das Eigenkapital')}: <b>{eur(r.ek10)}</b> ({t('rechnung.valueMinusDebt', 'Wert {{value}} − Restschuld {{debt}}', { value: eur(r.propV[9]), debt: eur(r.restL[9]) })})</div>

      {/* 6. Chart Mieteinnahmen & Gesamtkapital */}
      <H2Section>{t('rechnung.rentIncomeCapitalTitle', 'Mieteinnahmen & Gesamtkapital (10 Jahre)')}</H2Section>
      <Card>
        <Legend items={[[t('rechnung.annualRent', 'Jahresmiete'), RENTG], [t('rechnung.cumulativeRent', 'Kumulierte Miete'), BLUE], [t('rechnung.totalCapital', 'Gesamtkapital'), PURPLE]]} />
        <BarChart labels={r.yN} series={[{ data: r.rents, color: RENTG }, { data: cumRent, color: BLUE }, { data: gesamtkap, color: PURPLE }]} />
      </Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>{t('rechnung.cumulativeRent10y', 'Kumulierte Miete über 10 Jahre')}: <b>{eur(cumRent[9])}</b> · {t('rechnung.totalCapitalEndY10', 'Gesamtkapital Ende J10')}: <b>{eur(r.ek10 + cumRent[9])}</b></div>

      {/* 7. Chart Mietrendite % */}
      <H2Section>{t('rechnung.rentYieldTitle', 'Mietrendite (%) – Basis: Nettokaufpreis')}</H2Section>
      <Card><BarChart labels={r.yN} series={[{ data: mietrend, color: BLUE }]} pct /></Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>{t('rechnung.rentYieldY1', 'Mietrendite J1')}: <b>{pct(mietrend[0])}</b> · {t('rechnung.rentYieldY10', 'Mietrendite J10')}: <b>{pct(mietrend[9])}</b></div>

      {/* 8. Chart Gesamtrendite % */}
      <H2Section>{t('rechnung.totalYieldTitle', 'Rendite (%) – Miete + nicht realisierte Wertsteigerung')}</H2Section>
      <Card><BarChart labels={r.yN} series={[{ data: gesamtrend, color: PURPLE }]} pct /></Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>{t('rechnung.totalYieldY1', 'Gesamtrendite J1')}: <b>{pct(gesamtrend[0])}</b> · {t('rechnung.totalYieldY10', 'Gesamtrendite J10')}: <b>{pct(gesamtrend[9])}</b></div>
    </>
  )
}

const H2Section = ({ children }: { children: ReactNode }) => {
  const isMobile = useIsMobile()
  return (
    <h2 style={{ fontFamily: SERIF, fontSize: isMobile ? 17 : 21, fontWeight: 700, color: DARK, margin: isMobile ? '26px 0 12px' : '32px 0 14px', display: 'flex', alignItems: 'center', gap: isMobile ? 9 : 12 }}>
      <span style={{ width: 6, height: isMobile ? 19 : 22, background: CORAL, borderRadius: 3, display: 'inline-block', flexShrink: 0 }} />{children}
    </h2>
  )
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 8, fontSize: 12, color: '#555' }}>
      {items.map(([label, c]) => <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 11, height: 11, background: c, borderRadius: 2 }} />{label}</span>)}
    </div>
  )
}

// ── SVG-Balkendiagramm (eine oder mehrere Reihen) ─────────────────────────────
function BarChart({ labels, series, pct: isPct }: { labels: (string | number)[]; series: { data: number[]; color: string }[]; pct?: boolean }) {
  const W = 960, H = 300, pL = 8, pR = 8, pT = 26, pB = 26
  const plotW = W - pL - pR, plotH = H - pT - pB
  const n = labels.length
  const max = Math.max(...series.flatMap(s => s.data).map(Math.abs), 1)
  const step = plotW / n
  const groups = series.length
  const bw = step * (groups > 1 ? 0.22 : 0.52)
  const totalBarW = bw * groups
  const fmt = (v: number) => isPct ? v.toFixed(1).replace('.', ',') + '%' : short(v)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {[0, 1, 2, 3, 4].map(g => { const y = pT + plotH * g / 4; return <line key={g} x1={pL} y1={y} x2={W - pR} y2={y} stroke="#eee" strokeWidth={1} /> })}
      {labels.map((lab, i) => {
        const xBase = pL + i * step + (step - totalBarW) / 2
        return (
          <g key={i}>
            {series.map((s, di) => {
              const v = s.data[i]
              const bh = Math.max(2, Math.abs(v) / max * plotH)
              const x = xBase + di * bw
              const y = pT + plotH - bh
              return (
                <g key={di}>
                  <rect x={x} y={y} width={Math.max(2, bw - 2)} height={bh} rx={2} fill={s.color} />
                  <text x={x + (bw - 2) / 2} y={y - 4} textAnchor="middle" fontSize={groups > 1 ? 9 : 11} fontWeight={700} fill="#444">{fmt(v)}</text>
                </g>
              )
            })}
            <text x={pL + i * step + step / 2} y={H - 7} textAnchor="middle" fontSize={11} fill="#888">{lab}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Vergleich (mehrere Objekte) ───────────────────────────────────────────────
function CompareCards({ rows, withCalc, isMobile }: { rows: Row[]; withCalc: boolean; isMobile: boolean }) {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(rows.length, 3)},1fr)`, gap: 16 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ background: r.color, color: '#fff', borderRadius: 16, padding: isMobile ? 18 : 22, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}>
          <div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, marginBottom: 4 }}>{r.item.label || r.item.project}</div>
          <div style={{ fontSize: 12.5, opacity: 0.9, marginBottom: 14 }}>
            {[r.item.bedrooms != null ? t('rechnung.nBedrooms', '{{n}}-Schlafzimmer', { n: r.item.bedrooms }) : '', r.item.size_sqm != null ? `${r.item.size_sqm} m²` : ''].filter(Boolean).join(' · ')}
          </div>
          {r.item.tagline && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>{r.item.tagline}</div>}
          {r.res && withCalc ? (<>
            <div style={{ fontSize: 12.5, opacity: 0.9 }}>{t('rechnung.equityAndLoan', 'EK {{ek}} · Kredit {{loan}}', { ek: eur(r.res.ekStart), loan: eur(r.res.loan) })}</div>
            <div style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 800, margin: '10px 0 2px' }}>{pct(r.res.irrV * 100, 2)}</div>
            <div style={{ fontSize: 12.5, opacity: 0.9, marginBottom: 12 }}>{t('rechnung.yieldPaIrr', 'Rendite p.a. (IRR)')}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderTop: '1px solid rgba(255,255,255,0.25)', paddingTop: 10 }}>
              <span style={{ opacity: 0.9 }}>{t('rechnung.equityIn10y', 'EK in 10 J.')}</span><strong>{eur(r.res.ek10)}</strong>
            </div>
          </>) : (
            <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 800, marginTop: 8 }}>{eur(r.item.price_gross ?? r.item.price_net)}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function StrategyCards({ rows, isMobile }: { rows: Row[]; isMobile: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(rows.length, 3)},1fr)`, gap: 16, marginTop: 18 }}>
      {rows.map((r, i) => (
        <Card key={i} style={{ borderTop: `4px solid ${r.color}`, padding: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: r.color, marginBottom: 8 }}>{(r.item.label || r.item.project).toUpperCase()}</div>
          {r.item.strategy_title && <div style={{ fontFamily: SERIF, fontSize: 18, marginBottom: 8 }}>{r.item.strategy_title}</div>}
          {r.item.strategy_text && <div style={{ fontSize: 13, lineHeight: 1.6, color: '#555' }}>{r.item.strategy_text}</div>}
        </Card>
      ))}
    </div>
  )
}

function CompareTable({ rows }: { rows: Row[] }) {
  const { t } = useTranslation()
  const td: CSSProperties = { padding: '11px 14px', fontSize: 13.5, borderBottom: '1px solid #f0f0f0', textAlign: 'right' }
  const lbl: CSSProperties = { ...td, textAlign: 'left', color: '#777' }
  const best = (vals: number[]) => { const v = Math.max(...vals); return vals.map(x => x === v) }
  const irrBest = best(rows.map(r => r.res?.irrV ?? -1))
  const ekBest = best(rows.map(r => r.res?.ek10 ?? -1))
  const row = (label: string, fn: (r: Row) => string, bold?: boolean[]) => (
    <tr><td style={lbl}>{label}</td>{rows.map((r, i) => <td key={i} style={{ ...td, fontWeight: bold?.[i] ? 800 : 500, color: bold?.[i] ? r.color : '#1a1a1a' }}>{fn(r)}</td>)}</tr>
  )
  const sect = (txt: string) => <tr><td colSpan={rows.length + 1} style={{ padding: 0 }}><div style={{ background: '#fbe9e3', color: '#c2410c', fontWeight: 700, fontSize: 11.5, letterSpacing: 0.5, padding: '8px 14px' }}>{txt}</div></td></tr>
  return (
    <>
      <H2Section>{t('rechnung.comparisonTitle', 'Der Vergleich')}</H2Section>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
            <thead><tr>
              <th style={{ background: DARK, padding: '12px 14px' }}></th>
              {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '12px 14px', fontSize: 13.5, textAlign: 'center' }}>{r.item.label || r.item.project}</th>)}
            </tr></thead>
            <tbody>
              {sect(t('rechnung.sectionObject', 'OBJEKT'))}
              {rows.some(r => r.item.location) && row(t('rechnung.location', 'Lage'), r => r.item.location || '–')}
              {rows.some(r => r.item.developer) && row(t('rechnung.developer', 'Bauträger'), r => r.item.developer || '–')}
              {row(t('rechnung.appreciationAnnual', 'Wertsteigerung p.a.'), r => pct(r.res?.appP ?? null))}
              {row(t('rechnung.grossYield', 'Bruttorendite'), r => pct(r.res?.yPct ?? null))}
              {sect(t('rechnung.sectionFinancing', 'FINANZIERUNG'))}
              {row(t('rechnung.purchasePriceGross', 'Kaufpreis brutto'), r => eur(r.res?.pGross))}
              {rows.some(r => r.res && (r.res.furnFree || r.res.furnCost > 0)) && row(t('rechnung.furnishingGross', 'Einrichtung (inkl. MwSt)'), r => r.res ? (r.res.furnFree ? t('rechnung.included', 'inklusive') : (r.res.furnCost > 0 ? `+ ${eur(r.res.furnGross)}` : '–')) : '–')}
              {rows.some(r => r.res && (r.res.furnFree || r.res.furnCost > 0)) && row(t('rechnung.totalPrice', 'Gesamtpreis'), r => eur(r.res ? r.res.pGross + r.res.furnGross : null), rows.map(() => true))}
              {row(t('rechnung.equityPlusExtras', 'Eigenkapital + NK'), r => eur(r.res?.ekStart))}
              {row(t('rechnung.financingLabel', 'Finanzierung'), r => r.res && r.res.loan > 0 ? eur(r.res.loan) : t('rechnung.cash', 'Cash'))}
              {row(t('rechnung.cashflowYear1', 'Cashflow Jahr 1'), r => eur(r.res ? r.res.cfA[0] - (r.res.vatA[0] || 0) : null))}
              {sect(t('rechnung.sectionAfter10y', 'NACH 10 JAHREN'))}
              {row(t('rechnung.totalReturn', 'Gesamtertrag'), r => eur(r.res?.totRet))}
              {row(t('rechnung.propertyValue', 'Immobilienwert'), r => eur(r.res?.propV[9]))}
              {row(t('rechnung.remainingDebt', 'Restschuld'), r => eur(r.res?.restL[9]))}
              {row(t('rechnung.equity', 'Eigenkapital'), r => eur(r.res?.ek10), ekBest)}
              {row(t('rechnung.yieldPaIrr', 'Rendite p.a. (IRR)'), r => pct((r.res?.irrV ?? 0) * 100, 2), irrBest)}
              {row(t('rechnung.equityReturnCum', 'EK-Rendite kum.'), r => pct(r.res?.roe10))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}

function Bars({ rows, isMobile }: { rows: Row[]; isMobile: boolean }) {
  const { t } = useTranslation()
  const block = (title: string, fn: (r: Row) => number, fmt: (n: number) => string) => {
    const vals = rows.map(fn); const max = Math.max(...vals.map(Math.abs), 1)
    return (
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 12 }}>{title}</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, marginBottom: 8 }}>
            <div style={{ width: isMobile ? 96 : 180, fontSize: 12.5, color: '#555', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.item.label || r.item.project}</div>
            <div style={{ flex: 1, background: '#f1f0ee', borderRadius: 6, height: 28 }}>
              <div style={{ width: `${Math.max(3, Math.abs(vals[i]) / max * 100)}%`, background: r.color, height: 28, borderRadius: 6 }} />
            </div>
            <div style={{ width: isMobile ? 80 : 120, textAlign: 'right', fontWeight: 700, fontSize: isMobile ? 12 : 13.5, flexShrink: 0 }}>{fmt(vals[i])}</div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <>
      <H2Section>{t('rechnung.yieldDevelopmentTitle', 'Rendite & Wertentwicklung')}</H2Section>
      <Card>
        {block(t('rechnung.equityAfter10yBlock', 'Eigenkapital nach 10 Jahren'), r => r.res?.ek10 ?? 0, eur)}
        {block(t('rechnung.propertyValueAfter10yBlock', 'Immobilienwert nach 10 Jahren'), r => r.res?.propV[9] ?? 0, eur)}
        {block(t('rechnung.annualYieldIrrBlock', 'Jährliche Rendite (IRR)'), r => (r.res?.irrV ?? 0) * 100, n => pct(n, 2))}
      </Card>
    </>
  )
}

function CashflowTable({ rows }: { rows: Row[] }) {
  const { t } = useTranslation()
  const years = rows[0]?.res?.yN ?? []
  return (
    <>
      <H2Section>{t('rechnung.cashflowAfterTaxTitle', 'Cashflow nach Steuern & Kreditrate')}</H2Section>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead><tr>
              <th style={{ background: DARK, color: '#fff', padding: '11px 16px', fontSize: 13.5, textAlign: 'left' }}>{t('rechnung.yearCol', 'Jahr')}</th>
              {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '11px 16px', fontSize: 13.5 }}>{r.item.label || r.item.project}</th>)}
            </tr></thead>
            <tbody>
              {years.map((y, yi) => (
                <tr key={y} style={{ background: yi % 2 ? '#fafafa' : '#fff' }}>
                  <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 13.5 }}>{y}</td>
                  {rows.map((r, i) => {
                    const v = r.res ? r.res.cfA[yi] - (r.res.vatA[yi] || 0) : 0
                    return <td key={i} style={{ padding: '10px 16px', fontSize: 13.5, fontWeight: 600, textAlign: 'center', color: v < 0 ? RED : GREEN }}>{eur(v)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}

function SpecsCard({ rows }: { rows: Row[] }) {
  const { t } = useTranslation()
  const td: CSSProperties = { padding: '11px 14px', fontSize: 13.5, borderBottom: '1px solid #f0f0f0', textAlign: 'right' }
  const lbl: CSSProperties = { ...td, textAlign: 'left', color: '#777' }
  const row = (label: string, fn: (r: Row) => string) => (
    <tr><td style={lbl}>{label}</td>{rows.map((r, i) => <td key={i} style={td}>{fn(r)}</td>)}</tr>
  )
  return (
    <Card style={{ padding: 0, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
          <thead><tr>
            <th style={{ background: DARK, padding: '12px 14px' }}></th>
            {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '12px 14px', fontSize: 13.5 }}>{r.item.label || r.item.project}</th>)}
          </tr></thead>
          <tbody>
            {rows.some(r => r.item.location) && row(t('rechnung.location', 'Lage'), r => r.item.location || '–')}
            {rows.some(r => r.item.developer) && row(t('rechnung.developer', 'Bauträger'), r => r.item.developer || '–')}
            {row(t('rechnung.bedrooms', 'Schlafzimmer'), r => r.item.bedrooms != null ? String(r.item.bedrooms) : '–')}
            {row(t('rechnung.livingArea', 'Wohnfläche'), r => r.item.size_sqm != null ? `${r.item.size_sqm} m²` : '–')}
            {row(t('rechnung.terrace', 'Terrasse'), r => r.item.terrace_sqm ? `${r.item.terrace_sqm} m²` : '–')}
            {row(t('rechnung.floor', 'Etage'), r => r.item.floor != null ? `${r.item.floor}` : '–')}
            {row(t('rechnung.purchasePrice', 'Kaufpreis'), r => eur(r.item.price_gross ?? r.item.price_net))}
            {rows.some(r => r.item.params && (r.item.params.furnFree || (r.item.params.furnCost ?? 0) > 0)) && row(t('rechnung.furnishingGross', 'Einrichtung (inkl. MwSt)'), r => { const pa = r.item.params; return pa ? (pa.furnFree ? t('rechnung.included', 'inklusive') : ((pa.furnCost ?? 0) > 0 ? `+ ${eur(furnGrossOf(pa))}` : '–')) : '–' })}
            {rows.some(r => r.item.params && (r.item.params.furnFree || (r.item.params.furnCost ?? 0) > 0)) && row(t('rechnung.totalPrice', 'Gesamtpreis'), r => { const base = r.item.price_gross ?? r.item.price_net ?? 0; const pa = r.item.params; const f = pa && !pa.furnFree ? furnGrossOf(pa) : 0; return eur(base + f) })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
