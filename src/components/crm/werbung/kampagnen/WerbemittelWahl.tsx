import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Badge from '../../../ui/Badge'
import DataTable, { type DataTableColumn } from '../../../ui/DataTable'
import EmptyState from '../../../ui/EmptyState'
import { supabase } from '../../../../lib/supabase'
import { emptyAdAgg, type AdAgg } from '../../../../lib/crmTypes'
import { INPUT_CLS } from '../felder'
import { useWerbeFormat } from '../format'
import { useWerbeKontext } from '../useWerbeDaten'

// ── Vorhandenes Werbemittel für eine Anzeige übernehmen ──────────────────────
// Quellen: Anzeigen aus ad_catalog (inkl. vorbereitete Studio-Anzeigen) und
// freigegebene Einträge aus dem Vorrat (ad_creative_pool). Daneben die
// CRM-Qualität aus dem Werbemanager (byAd: Ausgaben, gehaltene Termine,
// Leads, gute Leads), sortiert nach Kosten je gehaltenem Termin. Der Vorrat
// wird erst beim Öffnen geladen (eine Abfrage, höchstens 100 Zeilen).

export interface VorratTexte { primaer: string[]; ueberschriften: string[]; beschreibungen: string[] }

export type WerbemittelAuswahl =
  | { quelle: 'anzeige'; adId: string; name: string; bild: string | null }
  | {
    quelle: 'vorrat'; poolId: string; kennung: string; format: string | null; texte: VorratTexte
    feedUrl: string | null; storyUrl: string | null; kiGeneriert: boolean; kiLabel: boolean; euBand: boolean
    cta: string | null; lpUrl: string | null
  }

interface Kandidat {
  id: string
  quelle: 'anzeige' | 'vorbereitet' | 'vorrat'
  name: string
  bild: string | null
  kontext: string | null
  agg: AdAgg | null
  auswahl: WerbemittelAuswahl
}

interface VorratZeile {
  id: string
  kennung: string
  status: string
  format: string | null
  texte: Partial<VorratTexte> | null
  asset_feed_url: string | null
  asset_story_url: string | null
  cta: string | null
  lp_url: string | null
  ki_generiert: boolean | null
  ki_label: boolean | null
  eu_band: boolean | null
  meta_ad_ids: unknown
  review_score: number | null
}

const liste = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Meta-Anzeigen-IDs eines Vorrat-Eintrags ({lang: id, kurz: id} oder Liste) */
const adIdsAus = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String)
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).map(String)
  return []
}

const addiere = (ziel: AdAgg, a: AdAgg) => {
  ziel.spendEur += a.spendEur; ziel.crmLeads += a.crmLeads; ziel.termine += a.termine
  ziel.stattgefunden += a.stattgefunden; ziel.gut += a.gut; ziel.schlecht += a.schlecht; ziel.platformLeads += a.platformLeads
}

type Filter = 'alle' | 'anzeigen' | 'vorrat'

export default function WerbemittelWahl({ open, onClose, onPick }: {
  open: boolean
  onClose: () => void
  onPick: (a: WerbemittelAuswahl) => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const { catalog, prepared, byAd, crmVisible } = useWerbeKontext()
  const [vorrat, setVorrat] = useState<VorratZeile[] | null>(null)
  const [vorratFehler, setVorratFehler] = useState(false)
  const [filter, setFilter] = useState<Filter>('alle')
  const [suche, setSuche] = useState('')

  useEffect(() => {
    if (!open || vorrat !== null) return
    let abbruch = false
    void (async () => {
      const { data, error } = await supabase.from('ad_creative_pool')
        .select('id, kennung, status, format, texte, asset_feed_url, asset_story_url, cta, lp_url, ki_generiert, ki_label, eu_band, meta_ad_ids, review_score')
        .or('entscheidung.eq.freigegeben,status.in.(freigegeben,hochgeladen,aktiv)')
        .order('updated_at', { ascending: false })
        .limit(100)
      if (abbruch) return
      if (error) {
        console.warn('[Kampagnen] Vorrat nicht lesbar:', error)
        setVorratFehler(true)
        setVorrat([])
      } else {
        setVorrat((data as VorratZeile[] | null) ?? [])
      }
    })()
    return () => { abbruch = true }
  }, [open, vorrat])

  const kandidaten = useMemo<Kandidat[]>(() => {
    const out: Kandidat[] = []
    const vorbereitetIds = new Set(prepared.map(p => p.ad_id))
    for (const c of [...catalog, ...prepared]) {
      if (out.some(k => k.id === `ad:${c.ad_id}`)) continue
      out.push({
        id: `ad:${c.ad_id}`,
        quelle: vorbereitetIds.has(c.ad_id) ? 'vorbereitet' : 'anzeige',
        name: c.ad_name || c.ad_id,
        bild: c.thumbnail_url,
        kontext: c.campaign_name,
        agg: byAd.get(c.ad_id) ?? null,
        auswahl: { quelle: 'anzeige', adId: c.ad_id, name: c.ad_name || c.ad_id, bild: c.thumbnail_url },
      })
    }
    for (const p of vorrat ?? []) {
      const ids = adIdsAus(p.meta_ad_ids)
      let agg: AdAgg | null = null
      for (const id of ids) {
        const a = byAd.get(id)
        if (a) { if (!agg) agg = emptyAdAgg(); addiere(agg, a) }
      }
      const tx = p.texte ?? {}
      out.push({
        id: `pool:${p.id}`,
        quelle: 'vorrat',
        name: p.kennung,
        bild: p.asset_feed_url ?? p.asset_story_url,
        kontext: p.status,
        agg,
        auswahl: {
          quelle: 'vorrat', poolId: p.id, kennung: p.kennung, format: p.format,
          texte: { primaer: liste(tx.primaer), ueberschriften: liste(tx.ueberschriften), beschreibungen: liste(tx.beschreibungen) },
          feedUrl: p.asset_feed_url, storyUrl: p.asset_story_url,
          kiGeneriert: p.ki_generiert === true, kiLabel: p.ki_label === true, euBand: p.eu_band === true,
          cta: p.cta, lpUrl: p.lp_url,
        },
      })
    }
    // Sortierung: mit gehaltenen Terminen nach Kosten je Termin, dann Unbenutzte, dann Ausgaben ohne Termin
    const rang = (k: Kandidat): [number, number] => {
      const a = k.agg
      if (a && a.stattgefunden > 0) return [0, a.spendEur / a.stattgefunden]
      if (!a || a.spendEur <= 0) return [1, 0]
      return [2, a.spendEur]
    }
    return out.sort((x, y) => {
      const rx = rang(x), ry = rang(y)
      return rx[0] - ry[0] || rx[1] - ry[1] || x.name.localeCompare(y.name)
    })
  }, [catalog, prepared, byAd, vorrat])

  const sichtbar = kandidaten.filter(k => {
    if (filter === 'anzeigen' && k.quelle === 'vorrat') return false
    if (filter === 'vorrat' && k.quelle !== 'vorrat') return false
    const q = suche.trim().toLowerCase()
    return !q || k.name.toLowerCase().indexOf(q) >= 0 || (k.kontext ?? '').toLowerCase().indexOf(q) >= 0
  })

  const QUELLE: Record<Kandidat['quelle'], string> = {
    anzeige: t('crm.werbung.builder.wahl.quelleAnzeige', 'Anzeige'),
    vorbereitet: t('crm.werbung.builder.wahl.quelleVorbereitet', 'Vorbereitet'),
    vorrat: t('crm.werbung.builder.wahl.quelleVorrat', 'Vorrat'),
  }

  const spalten: DataTableColumn<Kandidat>[] = [
    {
      id: 'name', header: t('crm.werbung.builder.wahl.werbemittel', 'Werbemittel'), primary: true,
      cell: k => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-10 w-8 shrink-0 overflow-hidden rounded bg-gray-100">
            {k.bild && <img src={k.bild} alt="" loading="lazy" className="h-full w-full object-cover" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{k.name}</span>
            <span className="block truncate text-[11px] font-normal text-gray-500">{k.kontext ?? ''}</span>
          </span>
        </span>
      ),
    },
    { id: 'quelle', header: t('crm.werbung.builder.wahl.quelle', 'Quelle'), cell: k => <Badge tone={k.quelle === 'vorrat' ? 'info' : 'neutral'}>{QUELLE[k.quelle]}</Badge>, hideBelow: 'sm' },
    { id: 'spend', header: t('crm.werbung.builder.wahl.ausgaben', 'Ausgaben'), align: 'right', cell: k => (k.agg ? fmt.eur(k.agg.spendEur) : '-') },
    { id: 'held', header: t('crm.werbung.builder.wahl.gehalten', 'Termine gehalten'), align: 'right', cell: k => (k.agg && crmVisible ? fmt.int(k.agg.stattgefunden) : '-') },
    {
      id: 'cpte', header: t('crm.werbung.builder.wahl.kostenJeTermin', 'Kosten je geh. Termin'), align: 'right',
      cell: k => (k.agg && crmVisible ? fmt.per(k.agg.spendEur, k.agg.stattgefunden) : '-'),
    },
    { id: 'leads', header: t('crm.werbung.builder.wahl.leads', 'Leads'), align: 'right', hideBelow: 'md', cell: k => (k.agg && crmVisible ? fmt.int(k.agg.crmLeads) : '-') },
    { id: 'gut', header: t('crm.werbung.builder.wahl.gut', 'Gute Leads'), align: 'right', hideBelow: 'lg', cell: k => (k.agg && crmVisible ? fmt.int(k.agg.gut) : '-') },
  ]

  const FILTER: Array<[Filter, string]> = [
    ['alle', t('crm.werbung.builder.wahl.alle', 'Alle')],
    ['anzeigen', t('crm.werbung.builder.wahl.anzeigen', 'Anzeigen')],
    ['vorrat', t('crm.werbung.builder.wahl.vorrat', 'Vorrat')],
  ]

  return (
    <Modal open={open} onClose={onClose} size="xl" title={t('crm.werbung.builder.wahl.titel', 'Vorhandenes Werbemittel übernehmen')}>
      <div className="space-y-3">
        <p className="text-xs text-gray-600">
          {t('crm.werbung.builder.wahl.text', 'Texte und Medien werden in die Anzeige übernommen. Sortiert nach Kosten je gehaltenem Termin (bestes zuerst), danach Unbenutzte.')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-gray-200 text-xs" role="group" aria-label={t('crm.werbung.builder.wahl.filter', 'Quelle filtern')}>
            {FILTER.map(([f, l]) => (
              <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
                className={`px-3 py-1.5 font-medium ${filter === f ? 'bg-hp-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{l}</button>
            ))}
          </div>
          <input value={suche} onChange={e => setSuche(e.target.value)} placeholder={t('crm.werbung.builder.wahl.suche', 'Suchen …')}
            className={`${INPUT_CLS} mt-0 w-full sm:w-56`} aria-label={t('crm.werbung.builder.wahl.suche', 'Suchen …')} />
        </div>
        {!crmVisible && (
          <p className="text-[11px] text-amber-700">{t('crm.werbung.builder.wahl.ohneCrm', 'CRM-Kennzahlen (Termine, Leads) sind nur mit Pipeline-Recht oder nach dem Abgleich sichtbar.')}</p>
        )}
        {vorratFehler && (
          <p className="text-[11px] text-gray-500">{t('crm.werbung.builder.wahl.vorratFehlt', 'Der Vorrat ist noch nicht verfügbar.')}</p>
        )}
        <DataTable
          columns={spalten}
          rows={sichtbar}
          rowKey={k => k.id}
          loading={vorrat === null && filter !== 'anzeigen'}
          onRowClick={k => { onPick(k.auswahl); onClose() }}
          empty={<EmptyState compact icon="ads" title={t('crm.werbung.builder.wahl.leer', 'Keine passenden Werbemittel')} />}
        />
      </div>
    </Modal>
  )
}
