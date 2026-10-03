import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '../../../lib/supabase'
import { cpteQuantil } from '../../../lib/werbeMathe'
import type { WerbeEvGewichte, WerbeQualitaetZeile } from '../../../lib/werbungTypes'
import Badge from '../../ui/Badge'
import DataTable, { type DataTableColumn } from '../../ui/DataTable'
import EmptyState from '../../ui/EmptyState'
import Spinner from '../../ui/Spinner'
import { useToast } from '../../ui/Toast'
import { useWerbeKontext } from './useWerbeDaten'
import { useWerbeFormat } from './format'
import StufenWahl from './autopilot/StufenWahl'
import TeErklaerung from './autopilot/TeErklaerung'
import { datumKurz, dbFehlerText, fehltSchema, zahl } from './autopilot/werbeTexte'

// ── Reiter „Qualität" des Werbemanagers ───────────────────────────────────────
// Kosten pro Termin-Äquivalent (TE) je Werbemittel (Kennung), Anzeigengruppe
// oder Kampagne aus ad_quality_daily (jüngster Stichtag, rechnet
// werbe_qualitaet_berechnen jede Nacht). Fenster 7/14/30 Tage oder Lebenszeit.
// Standard-Export ohne Props (lazyWithReload). Lädt erst, wenn der Reiter offen
// ist, und nur nacheinander (Micro-Instanz): Stichtag, Ziel, Wertleiter,
// Zeilen, Zähler „gehaltene Termine ohne Bewertung".

type Fenster = 0 | 7 | 14 | 30
type Ebene = 'kennung' | 'adset' | 'campaign'

const ZEILEN_FELDER =
  'stichtag, fenster, entity_level, entity_id, parent_id, campaign_id, name, spend_eur, impressions, link_clicks, lpv, ' +
  'meta_schedules, leads, leads_kap_ja, leads_mit_anzeige, booked, booked_kap_ja, held, no_show, rated_gut, rated_schlecht, ' +
  'sales, te_capped, te_full, prior_cpte, alpha, beta, cpte_hat, p_bad, p_good, kap_ja_share_booked, attribution_coverage, ' +
  'ev_version, berechnet_at'

/** „Gesamt (davon Kapitalbasis Ja)" */
const paar = (a: number | null, b: number | null) => `${zahl(a) ?? 0} (${zahl(b) ?? 0})`

const ZIEL_ERSATZ = 145
const ABDECKUNG_MIN = 0.8
const BEWERTEN_TAGE = 60

/** Balken 0..1 mit Prozent daneben (Farbe trägt nie allein die Bedeutung) */
function Balken({ wert, ton, label }: { wert: number | null; ton: 'gut' | 'schlecht'; label: string }) {
  const fmt = useWerbeFormat()
  if (wert == null) return <span className="text-gray-400">-</span>
  const breite = Math.max(0, Math.min(1, wert)) * 100
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${fmt.pct(wert)}`}>
      <span className="w-12 shrink-0 text-[11px] text-gray-500">{label}</span>
      <span className="h-2 w-16 shrink-0 overflow-hidden rounded-full bg-gray-100">
        <span className={`block h-full rounded-full ${ton === 'gut' ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${breite}%` }} />
      </span>
      <span className="text-xs tabular-nums text-gray-700">{fmt.pct(wert)}</span>
    </div>
  )
}

function AbdeckungBadge({ wert }: { wert: number | null }) {
  const fmt = useWerbeFormat()
  if (wert == null) return <Badge>-</Badge>
  return <Badge tone={wert < ABDECKUNG_MIN ? 'danger' : 'success'} dot>{fmt.pct(wert)}</Badge>
}

export default function QualitaetTab() {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const { campaignName, loading: seiteLaedt } = useWerbeKontext()
  // Erst nach den Seitendaten starten (nie parallel zu fetchAll), nur einmal
  const gestartet = useRef(false)
  const lebt = useRef(true)
  useEffect(() => { lebt.current = true; return () => { lebt.current = false } }, [])

  const [fenster, setFenster] = useState<Fenster>(30)
  const [ebene, setEbene] = useState<Ebene>('kennung')
  const [start, setStart] = useState(true)
  const [loading, setLoading] = useState(false)
  const [fehlt, setFehlt] = useState(false)
  const [stichtag, setStichtag] = useState<string | null>(null)
  const [ziel, setZiel] = useState(ZIEL_ERSATZ)
  const [leiter, setLeiter] = useState<WerbeEvGewichte | null>(null)
  const [zeilen, setZeilen] = useState<WerbeQualitaetZeile[]>([])
  const [konto, setKonto] = useState<WerbeQualitaetZeile | null>(null)
  const [ohneBewertung, setOhneBewertung] = useState(0)

  // ── Einmal beim Öffnen: Stichtag, Ziel, Wertleiter, Zähler ────────────────
  useEffect(() => {
    if (seiteLaedt || gestartet.current) return
    gestartet.current = true
    const aktiv = () => lebt.current
    void (async () => {
      try {
        const { data: st, error: e1 } = await supabase.from('ad_quality_daily')
          .select('stichtag').order('stichtag', { ascending: false }).limit(1)
        if (e1) throw e1
        const tag = ((st as Array<{ stichtag: string }> | null) ?? [])[0]?.stichtag ?? null
        if (!aktiv()) return

        const { data: s } = await supabase.from('ad_settings').select('target_cpte_eur').eq('id', 'default').maybeSingle()
        const z = zahl((s as { target_cpte_eur?: unknown } | null)?.target_cpte_eur)
        if (aktiv() && z && z > 0) setZiel(z)

        const { data: ev } = await supabase.from('ad_ev_weights')
          .select('version, status, weights, ev_ref_eur, te_cap_per_lead, quelle, gueltig_ab, created_at')
          .eq('status', 'aktiv').order('version', { ascending: false }).limit(1)
        if (aktiv()) setLeiter(((ev as unknown as WerbeEvGewichte[] | null) ?? [])[0] ?? null)

        // Kunden mit vergangenem Termin (letzte 60 Tage) ohne Daumen, gleiche
        // Lesart wie der Filter „zu bewerten" in der Kundenliste (jeder vergangene
        // Kundentermin, unabhängig vom Ausgang: wer bewertet, setzt auch
        // outcome='completed', daher hier kein Filter darauf). Ohne Leserecht auf
        // Leads/Termine kommt 0 zurück, dann bleibt der Link weg.
        if (tag) {
          const seit = new Date(Date.now() - BEWERTEN_TAGE * 86_400_000).toISOString()
          const { data: ap, error: eAp } = await supabase.from('crm_appointments')
            .select('lead_id, leads!inner(quality_rating)')
            .eq('internal', false).not('lead_id', 'is', null)
            .lt('start_time', new Date().toISOString()).gte('start_time', seit)
            .is('leads.quality_rating', null).limit(500)
          if (eAp) console.warn('[Qualität] Zähler ohne Bewertung:', eAp)
          else if (aktiv()) setOhneBewertung(new Set(((ap as Array<{ lead_id: string | null }> | null) ?? []).map(r => r.lead_id).filter(Boolean)).size)
        }
        // Erst jetzt: der Stichtag startet das Laden der Zeilen (nie parallel zu den Abfragen oben)
        if (aktiv()) setStichtag(tag)
      } catch (err) {
        if (!aktiv()) return
        if (fehltSchema(err)) setFehlt(true)
        else {
          console.error('[Qualität] Start:', err)
          toast.error(dbFehlerText(t, err))
        }
      } finally {
        if (aktiv()) setStart(false)
      }
    })()
  }, [seiteLaedt, t, toast])

  // ── Zeilen je Fenster und Ebene (plus Konto-Zeile) ────────────────────────
  const ladeZeilen = useCallback(async (tag: string, f: Fenster, e: Ebene) => {
    setLoading(true)
    try {
      const { data, error } = await supabase.from('ad_quality_daily').select(ZEILEN_FELDER)
        .eq('stichtag', tag).eq('fenster', f).in('entity_level', [e, 'account'])
        .order('spend_eur', { ascending: false }).limit(400)
      if (error) throw error
      const rows = (data as unknown as WerbeQualitaetZeile[] | null) ?? []
      setKonto(rows.find(r => r.entity_level === 'account') ?? null)
      setZeilen(rows.filter(r => r.entity_level === e))
    } catch (err) {
      console.error('[Qualität] Zeilen:', err)
      toast.error(dbFehlerText(t, err))
      setZeilen([]); setKonto(null)
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => { if (stichtag) void ladeZeilen(stichtag, fenster, ebene) }, [stichtag, fenster, ebene, ladeZeilen])

  const te = useCallback((v: number | null) => (v == null ? '-' : v.toLocaleString(fmt.locale, { maximumFractionDigits: 1 })), [fmt])

  const columns: DataTableColumn<WerbeQualitaetZeile>[] = useMemo(() => [
    {
      id: 'name',
      header: ebene === 'kennung'
        ? t('crm.werbung.qualitaet.ebene.kennung', 'Werbemittel')
        : ebene === 'adset' ? t('crm.werbung.qualitaet.ebene.adset', 'Anzeigengruppe') : t('crm.werbung.qualitaet.ebene.campaign', 'Kampagne'),
      primary: true,
      cell: r => (
        <span className="block min-w-[10rem] max-w-[22rem]">
          <span className="block truncate" title={r.entity_id}>{r.name || r.entity_id}</span>
          {ebene !== 'campaign' && r.campaign_id && (
            <span className="block truncate text-xs font-normal text-gray-500">{campaignName(r.campaign_id)}</span>
          )}
        </span>
      ),
    },
    { id: 'spend', header: t('crm.werbung.qualitaet.spalte.ausgaben', 'Ausgaben'), align: 'right', cell: r => <span className="tabular-nums">{fmt.eur(zahl(r.spend_eur) ?? 0)}</span> },
    { id: 'leads', header: t('crm.werbung.qualitaet.spalte.leads', 'Leads (Kap. Ja)'), align: 'right', cell: r => <span className="tabular-nums">{paar(r.leads, r.leads_kap_ja)}</span> },
    { id: 'termine', header: t('crm.werbung.qualitaet.spalte.termine', 'Termine (Kap. Ja)'), align: 'right', cell: r => <span className="tabular-nums">{paar(r.booked, r.booked_kap_ja)}</span> },
    {
      id: 'held',
      header: t('crm.werbung.qualitaet.spalte.stattgefunden', 'Stattgefunden'),
      align: 'right',
      hideBelow: 'sm',
      cell: r => (
        <span className="tabular-nums" title={t('crm.werbung.qualitaet.noShowTitel', 'Nicht erschienen: {{n}}', { n: zahl(r.no_show) ?? 0 })}>
          {zahl(r.held) ?? 0}
        </span>
      ),
    },
    {
      id: 'daumen',
      header: t('crm.werbung.qualitaet.spalte.daumen', 'Daumen hoch/runter'),
      align: 'right',
      hideBelow: 'md',
      cell: r => <span className="whitespace-nowrap tabular-nums">👍 {zahl(r.rated_gut) ?? 0} / 👎 {zahl(r.rated_schlecht) ?? 0}</span>,
    },
    {
      id: 'te',
      header: t('crm.werbung.qualitaet.spalte.te', 'TE'),
      align: 'right',
      cell: r => {
        const c = zahl(r.te_capped)
        const f = zahl(r.te_full)
        return (
          <span className="tabular-nums" title={f != null && c != null && Math.abs(f - c) > 0.05
            ? t('crm.werbung.qualitaet.teVoll', 'Ohne Deckel: {{te}}', { te: te(f) }) : undefined}>
            {te(c)}
          </span>
        )
      },
    },
    {
      id: 'cpte',
      header: t('crm.werbung.qualitaet.spalte.cpte', 'Kosten pro TE'),
      align: 'right',
      cell: r => {
        const a = zahl(r.alpha)
        const b = zahl(r.beta)
        const hat = zahl(r.cpte_hat) ?? (a && b ? b / a : null)
        if (hat == null) return <span className="text-gray-400">-</span>
        const von = a && b ? cpteQuantil(a, b, 0.1) : NaN
        const bis = a && b ? cpteQuantil(a, b, 0.9) : NaN
        const ueberZiel = hat > ziel
        return (
          <span className="block whitespace-nowrap text-right">
            <span className={`font-semibold tabular-nums ${ueberZiel ? 'text-red-700' : 'text-emerald-700'}`}>{fmt.eur(hat)}</span>
            {Number.isFinite(von) && Number.isFinite(bis) && (
              <span className="block text-[11px] tabular-nums text-gray-500">
                {t('crm.werbung.qualitaet.bereich', '80 %: {{von}} bis {{bis}}', { von: fmt.eur(von), bis: fmt.eur(bis) })}
              </span>
            )}
          </span>
        )
      },
    },
    {
      id: 'chancen',
      header: t('crm.werbung.qualitaet.spalte.chancen', 'Gut / schlecht'),
      hideBelow: 'sm',
      cell: r => (
        <div className="space-y-1">
          <Balken wert={zahl(r.p_good)} ton="gut" label={t('crm.werbung.qualitaet.gut', 'gut')} />
          <Balken wert={zahl(r.p_bad)} ton="schlecht" label={t('crm.werbung.qualitaet.schlecht', 'schlecht')} />
        </div>
      ),
    },
    {
      id: 'sched',
      header: t('crm.werbung.qualitaet.spalte.schedules', 'Meta-Termine'),
      align: 'right',
      hideBelow: 'lg',
      cell: r => (
        <span className="tabular-nums" title={t('crm.werbung.qualitaet.schedulesTitel', 'Termine laut Meta (Schedule-Ereignis), zum Abgleich mit dem CRM')}>
          {zahl(r.meta_schedules) ?? 0}
        </span>
      ),
    },
    {
      id: 'abdeckung',
      header: t('crm.werbung.qualitaet.spalte.abdeckung', 'Zuordnung'),
      align: 'center',
      hideBelow: 'md',
      cell: r => <AbdeckungBadge wert={zahl(r.attribution_coverage)} />,
    },
  ], [ebene, t, fmt, te, ziel, campaignName])

  if (start) return <div className="flex justify-center py-24"><Spinner size="lg" /></div>

  if (fehlt || !stichtag) {
    return (
      <div className="space-y-4">
        <div className="hp-card">
          <EmptyState
            icon="reviews"
            title={t('crm.werbung.qualitaet.leer', 'Noch keine Berechnung - läuft nach Freischaltung jede Nacht')}
            text={t('crm.werbung.qualitaet.leerText', 'Sobald der Autopilot freigeschaltet ist, rechnet er jede Nacht die Kosten pro Termin-Äquivalent je Werbemittel, Anzeigengruppe und Kampagne.')}
          />
        </div>
        <TeErklaerung gewichte={leiter?.weights ?? null} ziel={ziel} version={leiter?.version ?? null} />
      </div>
    )
  }

  const kontoSpend = zahl(konto?.spend_eur)
  const kontoTe = zahl(konto?.te_capped)
  const kontoCpte = zahl(konto?.cpte_hat)
  const fensterStufen = [
    { wert: 7 as Fenster, label: t('crm.werbung.qualitaet.fenster.7', '7 Tage') },
    { wert: 14 as Fenster, label: t('crm.werbung.qualitaet.fenster.14', '14 Tage') },
    { wert: 30 as Fenster, label: t('crm.werbung.qualitaet.fenster.30', '30 Tage') },
    { wert: 0 as Fenster, label: t('crm.werbung.qualitaet.fenster.0', 'Lebenszeit') },
  ]
  const ebenenStufen = [
    { wert: 'kennung' as Ebene, label: t('crm.werbung.qualitaet.ebene.kennung', 'Werbemittel') },
    { wert: 'adset' as Ebene, label: t('crm.werbung.qualitaet.ebene.adset', 'Anzeigengruppe') },
    { wert: 'campaign' as Ebene, label: t('crm.werbung.qualitaet.ebene.campaign', 'Kampagne') },
  ]

  return (
    <div className="space-y-4">
      <section className="hp-card p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg text-hp-navy">{t('crm.werbung.qualitaet.titel', 'Kosten pro Termin-Äquivalent')}</h2>
            <p className="text-sm text-gray-600">
              {t('crm.werbung.qualitaet.stand', 'Stand {{datum}}, Ziel {{ziel}} pro TE', { datum: datumKurz(stichtag, fmt.locale), ziel: fmt.eur(ziel) })}
            </p>
          </div>
          {ohneBewertung > 0 && (
            <Link to="/admin/crm/leads?bewerten=1" className="hp-btn hp-btn-accent">
              {t('crm.werbung.qualitaet.ohneBewertung', '{{n}} Kunden nach Termin ohne Bewertung', { n: ohneBewertung })}
            </Link>
          )}
        </div>

        {konto && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-gray-500">{t('crm.werbung.qualitaet.konto.ausgaben', 'Ausgaben gesamt')}</dt>
              <dd className="text-lg font-semibold tabular-nums text-hp-navy">{kontoSpend != null ? fmt.eur(kontoSpend) : '-'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">{t('crm.werbung.qualitaet.konto.te', 'TE gesamt')}</dt>
              <dd className="text-lg font-semibold tabular-nums text-hp-navy">{te(kontoTe)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">{t('crm.werbung.qualitaet.konto.cpte', 'Kosten pro TE gesamt')}</dt>
              <dd className={`text-lg font-semibold tabular-nums ${kontoCpte != null && kontoCpte > ziel ? 'text-red-700' : 'text-hp-navy'}`}>
                {kontoCpte != null ? fmt.eur(kontoCpte) : '-'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">{t('crm.werbung.qualitaet.konto.abdeckung', 'Zuordnung der Leads')}</dt>
              <dd className="mt-1"><AbdeckungBadge wert={zahl(konto.attribution_coverage)} /></dd>
            </div>
          </dl>
        )}
        {konto && (zahl(konto.attribution_coverage) ?? 1) < ABDECKUNG_MIN && (
          <p className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-800">
            {t('crm.werbung.qualitaet.abdeckungNiedrig', 'Weniger als 80 % der Leads sind einer Anzeige zugeordnet. Die Zahlen je Werbemittel sind unsicher, der Autopilot schaltet nichts selbst ab.')}
          </p>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">{t('crm.werbung.qualitaet.fensterLabel', 'Zeitraum')}</p>
            <StufenWahl stufen={fensterStufen} wert={fenster} onWahl={setFenster} ariaLabel={t('crm.werbung.qualitaet.fensterLabel', 'Zeitraum')} busy={loading} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">{t('crm.werbung.qualitaet.ebeneLabel', 'Ebene')}</p>
            <StufenWahl stufen={ebenenStufen} wert={ebene} onWahl={setEbene} ariaLabel={t('crm.werbung.qualitaet.ebeneLabel', 'Ebene')} busy={loading} />
          </div>
        </div>
      </section>

      <DataTable
        columns={columns}
        rows={zeilen}
        rowKey={r => `${r.entity_level}:${r.entity_id}`}
        loading={loading}
        empty={<EmptyState compact icon="reviews" title={t('crm.werbung.qualitaet.keineZeilen', 'Keine Zahlen für diesen Zeitraum')} />}
      />

      <TeErklaerung gewichte={leiter?.weights ?? null} ziel={ziel} version={leiter?.version ?? null} />
    </div>
  )
}
