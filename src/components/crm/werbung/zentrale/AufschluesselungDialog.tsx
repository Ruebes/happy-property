import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import EmptyState from '../../../ui/EmptyState'
import Badge from '../../../ui/Badge'
import { useWerbeFormat } from '../format'
import { BalkenSenkrecht, BalkenWaagerecht, type BalkenDatum } from './Balken'
import { berichteFehlerText, ladeInsights } from './berichteApi'
import { baueCsv, csvEinheit, csvZahl, ladeCsvHerunter } from './csv'
import { ebeneLabel, formatWert, schluesselLabel } from './darstellung'
import { addiere, SPALTE, spaltenWert, ergebnisseVon, type Etikett } from './spalten'
import type { Aufschluesselung, Ebene, InsightsAnfrage, Werte } from './typen'
import { zeitraumText } from './zeitraum'

// ── Aufschlüsselung einer Zeile + „Welche Variante gewinnt" ──────────────────
// Ein Abruf je Auswahl bei meta-berichte (insights mit breakdowns bzw.
// time_increment), Tabelle + Balkendiagramm, CSV. Varianten-Auswertung über die
// Asset-Aufschlüsselungen (Text, Überschrift, Bild, Video).

type ArtId = 'zeit_tag' | 'zeit_woche' | 'zeit_monat' | Aufschluesselung

const ARTEN: Array<{ gruppe: Etikett; arten: Array<{ id: ArtId; label: Etikett }> }> = [
  {
    gruppe: { k: 'crm.werbung.zentrale.auf.gruppeZeit', d: 'Nach Zeit' },
    arten: [
      { id: 'zeit_tag', label: { k: 'crm.werbung.zentrale.auf.tag', d: 'Tag' } },
      { id: 'zeit_woche', label: { k: 'crm.werbung.zentrale.auf.woche', d: 'Woche' } },
      { id: 'zeit_monat', label: { k: 'crm.werbung.zentrale.auf.monat', d: 'Monat' } },
      { id: 'hourly_stats_aggregated_by_advertiser_time_zone', label: { k: 'crm.werbung.zentrale.auf.tageszeit', d: 'Tageszeit (Stunde)' } },
    ],
  },
  {
    gruppe: { k: 'crm.werbung.zentrale.auf.gruppeAuslieferung', d: 'Nach Auslieferung' },
    arten: [
      { id: 'age', label: { k: 'crm.werbung.zentrale.auf.alter', d: 'Alter' } },
      { id: 'gender', label: { k: 'crm.werbung.zentrale.auf.geschlecht', d: 'Geschlecht' } },
      { id: 'country', label: { k: 'crm.werbung.zentrale.auf.land', d: 'Land' } },
      { id: 'region', label: { k: 'crm.werbung.zentrale.auf.region', d: 'Region' } },
      { id: 'publisher_platform', label: { k: 'crm.werbung.zentrale.auf.plattform', d: 'Plattform' } },
      { id: 'platform_position', label: { k: 'crm.werbung.zentrale.auf.platzierung', d: 'Platzierung' } },
      { id: 'impression_device', label: { k: 'crm.werbung.zentrale.auf.geraet', d: 'Gerät der Impression' } },
    ],
  },
]

const VARIANTEN_ARTEN: Array<{ id: Aufschluesselung; label: Etikett }> = [
  { id: 'body_asset', label: { k: 'crm.werbung.zentrale.var.text', d: 'Text' } },
  { id: 'title_asset', label: { k: 'crm.werbung.zentrale.var.ueberschrift', d: 'Überschrift' } },
  { id: 'image_asset', label: { k: 'crm.werbung.zentrale.var.bild', d: 'Bild' } },
  { id: 'video_asset', label: { k: 'crm.werbung.zentrale.var.video', d: 'Video' } },
]

/** Kennzahlen in Tabelle und Diagramm */
const KENNZAHLEN = ['ausgaben', 'impressionen', 'reichweite', 'link_klicks', 'ctr', 'ergebnisse', 'kosten_pro_ergebnis', 'cpm']
const DIAGRAMM_KENNZAHLEN = ['ausgaben', 'impressionen', 'link_klicks', 'ctr', 'ergebnisse', 'kosten_pro_ergebnis', 'cpm']

/** Mindestmenge, ab der Varianten verglichen werden */
const MIN_IMPRESSIONEN = 1000
const MIN_ERGEBNISSE_GESAMT = 10

interface Gruppe { key: string; label: string; bild: string | null; werte: Werte; sortier: string }

export interface AufschluesselungZiel { level: Ebene; id: string; name: string }

interface Props {
  ziel: AufschluesselungZiel | null
  since: string
  until: string
  kurs: number
  onClose: () => void
}

export default function AufschluesselungDialog({ ziel, since, until, kurs, onClose }: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [modus, setModus] = useState<'auf' | 'var'>('auf')
  const [art, setArt] = useState<ArtId>('zeit_tag')
  const [varArt, setVarArt] = useState<Aufschluesselung>('body_asset')
  const [kennzahl, setKennzahl] = useState('ausgaben')
  const [gruppen, setGruppen] = useState<Gruppe[]>([])
  const [laedt, setLaedt] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [stand, setStand] = useState<{ fetched_at: string | null; cached: boolean } | null>(null)
  const lauf = useRef(0)

  const aktiveArt: ArtId = modus === 'var' ? varArt : art
  const istZeit = aktiveArt === 'zeit_tag' || aktiveArt === 'zeit_woche' || aktiveArt === 'zeit_monat'

  // Varianten (Asset-Aufschlüsselung) liefert Meta nur je Anzeigengruppe oder Anzeige
  const variantenGesperrt = modus === 'var' && ziel?.level === 'campaign'

  const laden = useCallback(async (frisch = false) => {
    if (!ziel) return
    const nr = ++lauf.current
    if (variantenGesperrt) { setGruppen([]); setFehler(null); setLaedt(false); return }
    setLaedt(true)
    setFehler(null)
    try {
      const req: InsightsAnfrage = { level: ziel.level, ids: [ziel.id], since, until, felder: 'standard', ...(frisch ? { frisch: true } : {}) }
      if (aktiveArt === 'zeit_tag') req.time_increment = 1
      else if (aktiveArt === 'zeit_woche') req.time_increment = 7
      else if (aktiveArt === 'zeit_monat') req.time_increment = 'monthly'
      else { req.breakdowns = [aktiveArt]; req.time_increment = 'all_days' }
      const r = await ladeInsights(req, kurs)
      if (nr !== lauf.current) return
      const m = new Map<string, Gruppe>()
      for (const z of r.rows) {
        const roh = istZeit ? (z.date_start ?? '') : (z.schluessel ?? '')
        const key = istZeit ? roh : `${z.plattform ?? ''}|${roh}`
        let g = m.get(key)
        if (!g) {
          let label: string
          if (istZeit) {
            const d = roh ? new Date(`${roh}T12:00:00`) : null
            label = !d || Number.isNaN(d.getTime()) ? roh
              : aktiveArt === 'zeit_monat' ? d.toLocaleDateString(fmt.locale, { month: 'long', year: 'numeric' })
              : aktiveArt === 'zeit_woche' ? t('crm.werbung.zentrale.auf.wocheAb', 'ab {{datum}}', { datum: d.toLocaleDateString(fmt.locale, { day: '2-digit', month: '2-digit' }) })
              : d.toLocaleDateString(fmt.locale, { day: '2-digit', month: '2-digit' })
          } else {
            label = z.schluessel == null && z.beschriftung
              ? z.beschriftung
              : schluesselLabel(aktiveArt, z.schluessel, z.plattform, t, fmt.locale)
          }
          g = { key, label, bild: z.bild, werte: {}, sortier: roh }
          m.set(key, g)
        }
        addiere(g.werte, z.werte)
      }
      setGruppen([...m.values()])
      setStand({ fetched_at: r.fetched_at, cached: r.cached })
    } catch (err) {
      if (nr !== lauf.current) return
      setGruppen([])
      setFehler(berichteFehlerText(err, t))
    } finally {
      if (nr === lauf.current) setLaedt(false)
    }
  }, [ziel, since, until, kurs, aktiveArt, istZeit, variantenGesperrt, fmt.locale, t])

  // Abruf beim Öffnen und bei jeder Auswahl (ein Aufruf je Wahl)
  useEffect(() => { if (ziel) void laden() }, [laden, ziel])
  // Beim Schließen zurücksetzen
  useEffect(() => { if (!ziel) { setGruppen([]); setFehler(null); setStand(null); lauf.current++ } }, [ziel])

  const wert = (g: Gruppe, key: string) => spaltenWert(key, g.werte)

  const sortiert = useMemo(() => {
    if (istZeit || aktiveArt === 'hourly_stats_aggregated_by_advertiser_time_zone') {
      return [...gruppen].sort((a, b) => a.sortier.localeCompare(b.sortier))
    }
    const k = modus === 'var' ? 'impressionen' : kennzahl
    return [...gruppen].sort((a, b) => (wert(b, k) ?? -Infinity) - (wert(a, k) ?? -Infinity))
  }, [gruppen, istZeit, aktiveArt, kennzahl, modus])

  // ── Welche Variante gewinnt ────────────────────────────────────────────────
  const gewinner = useMemo(() => {
    if (modus !== 'var' || !gruppen.length) return null
    const genug = gruppen.filter(g => (g.werte.impressionen ?? 0) >= MIN_IMPRESSIONEN)
    if (genug.length < 2) return { key: null as string | null, nach: 'zuWenig' as const }
    const ergebnisse = genug.reduce((s, g) => s + (ergebnisseVon(g.werte) ?? 0), 0)
    if (ergebnisse >= MIN_ERGEBNISSE_GESAMT) {
      const mitErg = genug.filter(g => (ergebnisseVon(g.werte) ?? 0) > 0)
      const best = mitErg.sort((a, b) => (wert(a, 'kosten_pro_ergebnis') ?? Infinity) - (wert(b, 'kosten_pro_ergebnis') ?? Infinity))[0]
      if (best) return { key: best.key, nach: 'kosten' as const }
    }
    const best = [...genug].sort((a, b) => (wert(b, 'ctr') ?? -1) - (wert(a, 'ctr') ?? -1))[0]
    return { key: best?.key ?? null, nach: 'ctr' as const }
  }, [modus, gruppen])

  const label = (e: Etikett) => t(e.k, e.d)
  const spaltenLabel = (key: string) => { const d = SPALTE.get(key); return d ? t(d.label.k, d.label.d) : key }

  const exportieren = () => {
    if (!ziel) return
    const kopf = [
      modus === 'var' ? t('crm.werbung.zentrale.var.variante', 'Variante') : t('crm.werbung.zentrale.auf.wert', 'Wert'),
      ...KENNZAHLEN.map(k => `${spaltenLabel(k)}${csvEinheit(SPALTE.get(k)?.format ?? 'zahl')}`),
    ]
    const zeilen = sortiert.map(g => [g.label, ...KENNZAHLEN.map(k => csvZahl(wert(g, k), SPALTE.get(k)?.format ?? 'zahl'))])
    const name = `aufschluesselung_${aktiveArt}_${ziel.id}_${since}_${until}.csv`
    ladeCsvHerunter(baueCsv(kopf, zeilen), name)
  }

  const diagramm: BalkenDatum[] = sortiert.slice(0, istZeit ? 120 : 25).map(g => {
    const k = modus === 'var' ? 'kosten_pro_ergebnis' : kennzahl
    const v = wert(g, k)
    return { label: g.label, wert: v, text: formatWert(v, SPALTE.get(k)?.format ?? 'zahl', fmt), hervor: gewinner?.key === g.key }
  })

  const titel = ziel
    ? t('crm.werbung.zentrale.auf.titel', 'Aufschlüsselung: {{name}}', { name: ziel.name })
    : ''

  return (
    <Modal open={!!ziel} onClose={onClose} size="xl" title={titel}>
      {ziel && (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            {ebeneLabel(ziel.level, t)} · {zeitraumText(since, until, fmt.locale)}
            {stand?.fetched_at && <> · {t('crm.werbung.zentrale.stand', 'Stand {{zeit}}', { zeit: new Date(stand.fetched_at).toLocaleTimeString(fmt.locale, { hour: '2-digit', minute: '2-digit' }) })}</>}
            {stand?.cached && <> · {t('crm.werbung.zentrale.zwischenspeicher', 'aus dem Zwischenspeicher')}</>}
            {stand && !laedt && (
              <> · <button type="button" className="underline" onClick={() => void laden(true)}>{t('crm.werbung.zentrale.meta.neu', 'Neu laden')}</button></>
            )}
          </p>

          <div className="flex flex-wrap gap-2" role="tablist">
            {(['auf', 'var'] as const).map(m => (
              <button key={m} type="button" role="tab" aria-selected={modus === m} onClick={() => setModus(m)}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold border ${modus === m ? 'bg-hp-navy text-white border-hp-navy' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                {m === 'auf' ? t('crm.werbung.zentrale.auf.reiter', 'Aufschlüsselung') : t('crm.werbung.zentrale.var.reiter', 'Welche Variante gewinnt')}
              </button>
            ))}
          </div>

          {modus === 'auf' ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-gray-500 flex flex-col gap-1 min-w-0">
                {t('crm.werbung.zentrale.auf.nach', 'Aufschlüsseln nach')}
                <select value={art} onChange={e => setArt(e.target.value as ArtId)}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 max-w-full">
                  {ARTEN.map(g => (
                    <optgroup key={g.gruppe.k} label={label(g.gruppe)}>
                      {g.arten.map(a => <option key={a.id} value={a.id}>{label(a.label)}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="text-xs text-gray-500 flex flex-col gap-1 min-w-0">
                {t('crm.werbung.zentrale.auf.diagramm', 'Diagramm zeigt')}
                <select value={kennzahl} onChange={e => setKennzahl(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 max-w-full">
                  {DIAGRAMM_KENNZAHLEN.map(k => <option key={k} value={k}>{spaltenLabel(k)}</option>)}
                </select>
              </label>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gray-600">
                {t('crm.werbung.zentrale.var.erklaerung', 'Bei Anzeigen mit mehreren Texten, Überschriften oder Medien verteilt Meta die Auslieferung selbst. Hier siehst du, welche Variante am günstigsten Ergebnisse bringt. Belastbar wird es ab rund 1.000 Impressionen je Variante.')}
              </p>
              <div className="flex flex-wrap gap-2">
                {VARIANTEN_ARTEN.map(v => (
                  <button key={v.id} type="button" onClick={() => setVarArt(v.id)} aria-pressed={varArt === v.id}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${varArt === v.id ? 'bg-orange-50 border-orange-300 text-orange-800' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                    {label(v.label)}
                  </button>
                ))}
              </div>
              {gewinner && !laedt && gruppen.length > 0 && (
                <p className="text-xs text-gray-700">
                  {gewinner.nach === 'zuWenig'
                    ? t('crm.werbung.zentrale.var.zuWenig', 'Noch zu wenig Daten: mindestens zwei Varianten brauchen je 1.000 Impressionen.')
                    : gewinner.nach === 'kosten'
                      ? t('crm.werbung.zentrale.var.nachKosten', 'Vorn liegt die grün markierte Variante (niedrigste Kosten pro Ergebnis).')
                      : t('crm.werbung.zentrale.var.nachCtr', 'Vorn liegt die grün markierte Variante (höchste Link-Klickrate, für Kosten pro Ergebnis gibt es noch zu wenige Ergebnisse).')}
                </p>
              )}
            </div>
          )}

          {laedt && (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
              <Spinner size="sm" /> {t('crm.werbung.zentrale.auf.laedt', 'Hole die Aufschlüsselung von Meta …')}
            </div>
          )}
          {fehler && !laedt && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex flex-wrap items-center gap-2">
              <span className="flex-1 min-w-0">{fehler}</span>
              <button type="button" className="hp-btn hp-btn-ghost text-xs" onClick={() => void laden()}>
                {t('crm.werbung.zentrale.nochmal', 'Erneut versuchen')}
              </button>
            </div>
          )}
          {variantenGesperrt && (
            <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              {t('crm.werbung.zentrale.var.nurGruppe', 'Varianten wertet Meta je Anzeigengruppe oder Werbeanzeige aus. Bitte eine Anzeigengruppe oder Anzeige wählen.')}
            </p>
          )}
          {!laedt && !fehler && !variantenGesperrt && gruppen.length === 0 && (
            <EmptyState compact icon="statistics"
              title={t('crm.werbung.zentrale.auf.leer', 'Keine Daten')}
              text={modus === 'var'
                ? t('crm.werbung.zentrale.var.leerText', 'Meta liefert für diese Anzeige keine Varianten-Zahlen. Das gibt es nur bei mehreren Texten, Überschriften oder Medien in einer Anzeige.')
                : t('crm.werbung.zentrale.auf.leerText', 'Meta liefert für diese Aufschlüsselung im Zeitraum keine Zahlen.')} />
          )}

          {!laedt && gruppen.length > 0 && (
            <>
              <div className="rounded-xl border border-gray-200 p-3">
                {istZeit ? <BalkenSenkrecht daten={diagramm} /> : <BalkenWaagerecht daten={diagramm} />}
                {modus === 'var' && (
                  <p className="mt-2 text-[11px] text-gray-400">{t('crm.werbung.zentrale.var.diagramm', 'Balken: Kosten pro Ergebnis (kürzer ist besser).')}</p>
                )}
              </div>
              <div className="overflow-x-auto max-w-full rounded-xl border border-gray-200">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                      <th className="px-3 py-2 font-semibold">{modus === 'var' ? t('crm.werbung.zentrale.var.variante', 'Variante') : t('crm.werbung.zentrale.auf.wert', 'Wert')}</th>
                      {KENNZAHLEN.map(k => <th key={k} className="px-2 py-2 font-semibold text-right whitespace-nowrap">{spaltenLabel(k)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {sortiert.map(g => (
                      <tr key={g.key} className={`border-b border-gray-50 ${gewinner?.key === g.key ? 'bg-emerald-50/70' : ''}`}>
                        <td className="px-3 py-2 text-gray-800">
                          <span className="inline-flex items-center gap-2 min-w-0">
                            {g.bild && <img src={g.bild} alt="" className="w-8 h-8 rounded object-cover shrink-0" loading="lazy" />}
                            <span className={`${modus === 'var' ? 'line-clamp-2 max-w-[320px]' : 'truncate max-w-[220px]'}`} title={g.label}>{g.label}</span>
                            {gewinner?.key === g.key && <Badge tone="success">{t('crm.werbung.zentrale.var.vorn', 'Vorn')}</Badge>}
                          </span>
                        </td>
                        {KENNZAHLEN.map(k => (
                          <td key={k} className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{formatWert(wert(g, k), SPALTE.get(k)?.format ?? 'zahl', fmt)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={exportieren} className="hp-btn hp-btn-ghost text-xs">
                  {t('crm.werbung.zentrale.csv', 'Als CSV exportieren')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
