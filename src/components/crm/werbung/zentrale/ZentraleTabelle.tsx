import { useTranslation } from 'react-i18next'
import type { AdAction } from '../../../../lib/crmTypes'
import ActionMenu, { type ActionItem } from '../../../ui/ActionMenu'
import Badge from '../../../ui/Badge'
import EmptyState from '../../../ui/EmptyState'
import { aktionIcon, useWerbeFormat, type WerbeFormat } from '../format'
import type { Sortierung, ZentraleEbene } from './ansichten'
import { budgetText, ebeneLabel, formatWert, problemeTitel, textWert, veraenderung } from './darstellung'
import { EIGEN_PREFIX, SPALTE, formatVon, wertVon, type EigeneSpalte } from './spalten'
import { auslieferungVon, istAn } from './status'
import type { Knoten, Werte } from './typen'

// ── Tabelle der Kampagnen-Zentrale ───────────────────────────────────────────
// Erste Spalte (Auswahl, An/Aus, Name) bleibt beim waagerechten Scrollen
// stehen; nur der Tabellen-Container scrollt, nie die Seite.

export interface Zeile {
  k: Knoten
  tiefe: number
  /** Anzahl sichtbarer Kinder */
  kinder: number
  offen: boolean
  /** Nur als Pfad zu Treffern sichtbar (Filter aktiv, selbst kein Treffer) */
  gedimmt: boolean
}

interface Props {
  zeilen: Zeile[]
  ebene: ZentraleEbene
  spalten: string[]
  eigene: Map<string, EigeneSpalte>
  /** Vergleichswerte je knotenKey (null = kein Vergleich) */
  vergleich: Map<string, Werte> | null
  summe: { werte: Werte; vergleich: Werte | null; anzahl: number }
  /** Spalten, die auf Meta-Zahlen warten (Kopf markieren) */
  wartetAufMeta: Set<string>
  kurs: number
  sort: Sortierung | null
  onSort: (key: string) => void
  auswahl: Set<string>
  /** Zeilen, die „Alle auswählen" nimmt (Treffer ohne graue Wegzeilen, im Baum nur oberste Ebene) */
  auswahlbar: string[]
  onAuswahl: (key: string) => void
  onAlleAuswahl: (an: boolean) => void
  onAufklappen: (key: string) => void
  pendingByAd: Map<string, AdAction>
  onSchalten: (k: Knoten) => void
  aktionen: (k: Knoten) => ActionItem[]
  onVorschau: (k: Knoten) => void
  /** Herkunft in flachen Listen („Kampagne › Anzeigengruppe") */
  herkunft: (k: Knoten) => string
}

const TIEFE_CLS = ['', 'pl-3 sm:pl-5', 'pl-6 sm:pl-10']
const STICKY_BG: Record<Knoten['level'], string> = { campaign: 'bg-white', adset: 'bg-slate-50', ad: 'bg-gray-50' }

function Delta({ d, besser, fmt }: { d: number | null; besser: boolean | null; fmt: WerbeFormat }) {
  if (d == null) return <span className="block text-[10px] text-gray-300">-</span>
  const hoch = d > 0
  const gut = besser == null || d === 0 ? null : hoch === besser
  const cls = gut == null ? 'text-gray-400' : gut ? 'text-emerald-700' : 'text-red-600'
  return <span className={`block text-[10px] ${cls}`}>{d === 0 ? '±0 %' : `${hoch ? '▲' : '▼'} ${fmt.pct(Math.abs(d))}`}</span>
}

function Schalter({ an, label, disabled, onClick }: { an: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={an} aria-label={label} title={label} disabled={disabled}
      onClick={e => { e.stopPropagation(); onClick() }}
      className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/60 disabled:opacity-40 ${an ? 'bg-hp-navy' : 'bg-gray-300'}`}>
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${an ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </button>
  )
}

export default function ZentraleTabelle(p: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const { zeilen, spalten, eigene, vergleich } = p

  const label = (key: string): string => {
    if (key.startsWith(EIGEN_PREFIX)) return eigene.get(key)?.def.name ?? key
    const d = SPALTE.get(key)
    return d ? t(d.label.k, d.label.d) : key
  }
  const hilfe = (key: string): string | undefined => {
    if (key.startsWith(EIGEN_PREFIX)) {
      const e = eigene.get(key)
      return e ? `${e.def.formel}${e.fehler ? ` (${t('crm.werbung.zentrale.spalten.formelFehler', 'Formel fehlerhaft')})` : ''}` : undefined
    }
    const d = SPALTE.get(key)
    return d ? t(d.hilfe.k, d.hilfe.d) : undefined
  }
  const istText = (key: string) => formatVon(key, eigene) === 'text'

  const alleGewaehlt = p.auswahlbar.length > 0 && p.auswahlbar.every(k => p.auswahl.has(k))
  const teilweise = !alleGewaehlt && zeilen.some(z => p.auswahl.has(z.k.key))

  const sortZeichen = (key: string) => (p.sort?.key === key ? (p.sort.ab ? ' ↓' : ' ↑') : '')

  const zelle = (k: Knoten, key: string) => {
    if (istText(key)) {
      if (key === 'auslieferung') {
        const a = auslieferungVon(k)
        return (
          <span title={problemeTitel(k)} className="inline-flex items-center gap-1">
            <Badge tone={a.ton}>{a.label.k ? t(a.label.k, a.label.d) : a.label.d}</Badge>
            {problemeTitel(k) && <span className="text-amber-600 text-xs" aria-hidden="true">⚠</span>}
          </span>
        )
      }
      if (key === 'budget') {
        const b = budgetText(k, p.kurs, t, fmt)
        return (
          <span className="block leading-tight">
            <span className="text-xs text-gray-700">{b.haupt}</span>
            {b.sub && <span className="block text-[10px] text-gray-400">{b.sub}</span>}
          </span>
        )
      }
      return <span className="text-xs text-gray-600">{textWert(k, key, p.kurs, t, fmt)}</span>
    }
    const v = wertVon(key, k.werte, eigene)
    const def = SPALTE.get(key)
    const vw = vergleich ? vergleich.get(k.key) ?? {} : null
    return (
      <>
        {formatWert(v, formatVon(key, eigene), fmt)}
        {vw && <Delta d={veraenderung(v, wertVon(key, vw, eigene))} besser={def?.hoeherBesser ?? null} fmt={fmt} />}
      </>
    )
  }

  const kopfName = p.ebene === 'baum'
    ? t('crm.werbung.zentrale.kopfBaum', 'Kampagne / Anzeigengruppe / Werbeanzeige')
    : ebeneLabel(p.ebene, t, true)

  return (
    // relative: absolut positionierte Kinder (sr-only, Schalter) bleiben im Scroll-Container
    <div className="relative overflow-x-auto max-w-full">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] text-gray-500 border-b border-gray-200 align-bottom">
            <th className="sticky left-0 z-[2] bg-white px-3 py-2 font-semibold min-w-[170px] sm:min-w-[300px]">
              <span className="inline-flex items-center gap-2">
                <input type="checkbox" checked={alleGewaehlt} disabled={p.auswahlbar.length === 0}
                  ref={el => { if (el) el.indeterminate = teilweise }}
                  onChange={e => p.onAlleAuswahl(e.target.checked)}
                  title={t('crm.werbung.zentrale.alleAuswaehlen', 'Alle Treffer auswählen (ohne graue Zeilen, im Baum nur die oberste Ebene)')}
                  aria-label={t('crm.werbung.zentrale.alleAuswaehlen', 'Alle Treffer auswählen (ohne graue Zeilen, im Baum nur die oberste Ebene)')} />
                <button type="button" onClick={() => p.onSort('name')} className="font-semibold hover:text-gray-800 text-left">
                  {p.ebene === 'baum'
                    ? <><span className="sm:hidden">{t('crm.werbung.zentrale.kopfKurz', 'Name')}</span><span className="hidden sm:inline">{kopfName}</span></>
                    : kopfName}
                  {sortZeichen('name')}
                </button>
              </span>
            </th>
            {spalten.map(key => (
              <th key={key} title={hilfe(key)}
                className={`px-2 py-2 font-semibold min-w-[84px] max-w-[150px] leading-tight ${istText(key) ? 'text-left' : 'text-right'}`}>
                <button type="button" onClick={() => p.onSort(key)} className={`hover:text-gray-800 ${istText(key) ? 'text-left' : 'text-right'}`}>
                  {label(key)}{sortZeichen(key)}
                  {p.wartetAufMeta.has(key) && <span className="block text-[9px] font-normal text-amber-600">{t('crm.werbung.zentrale.wartetMeta', 'von Meta laden')}</span>}
                </button>
              </th>
            ))}
            <th className="px-1 py-2 w-10"><span className="sr-only">{t('crm.werbung.zentrale.aktionenSpalte', 'Aktionen')}</span></th>
          </tr>
        </thead>
        <tbody>
          {zeilen.map(z => {
            const { k } = z
            const pending = k.level === 'ad' ? p.pendingByAd.get(k.id) : undefined
            const an = istAn(k)
            const bg = STICKY_BG[k.level]
            return (
              <tr key={k.key} className={`group border-b border-gray-100 ${bg} ${z.gedimmt ? 'text-gray-400' : ''}`}>
                <td className={`sticky left-0 z-[1] ${bg} group-hover:bg-orange-50 px-3 py-2`}>
                  <div className={`flex items-center gap-1.5 sm:gap-2 min-w-0 ${TIEFE_CLS[Math.min(z.tiefe, 2)]}`}>
                    <input type="checkbox" checked={p.auswahl.has(k.key)} onChange={() => p.onAuswahl(k.key)}
                      aria-label={t('crm.werbung.zentrale.zeileAuswaehlen', '{{name}} auswählen', { name: k.name })} />
                    {pending ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 whitespace-nowrap"
                        title={t('crm.ads.actQueued', 'vorgemerkt')}>
                        {aktionIcon(pending.action)}
                      </span>
                    ) : (
                      <Schalter an={an} onClick={() => p.onSchalten(k)}
                        label={an
                          ? t('crm.werbung.zentrale.schalterAus', '{{name}} pausieren', { name: k.name })
                          : t('crm.werbung.zentrale.schalterAn', '{{name}} aktivieren', { name: k.name })} />
                    )}
                    {z.kinder > 0 ? (
                      <button type="button" onClick={() => p.onAufklappen(k.key)} aria-expanded={z.offen}
                        aria-label={z.offen ? t('crm.werbung.zentrale.zuklappen', 'Zuklappen') : t('crm.werbung.zentrale.aufklappen', 'Aufklappen')}
                        className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-800 shrink-0">
                        {z.offen ? '▾' : '▸'}
                      </button>
                    ) : <span className="w-5 shrink-0" />}
                    {k.level === 'ad' && (k.thumbnail
                      ? <img src={k.thumbnail} alt="" className="hidden sm:block w-7 h-7 rounded object-cover shrink-0" loading="lazy" />
                      : <span className="hidden sm:block w-7 h-7 rounded bg-gray-200 shrink-0" aria-hidden="true" />)}
                    <span className="min-w-0">
                      <span className={`block truncate max-w-[110px] sm:max-w-[280px] ${k.level === 'campaign' ? 'font-semibold text-gray-900' : 'text-gray-700'} ${z.gedimmt ? 'opacity-60' : ''}`}
                        title={k.name}>
                        {k.name}
                      </span>
                      {p.ebene !== 'baum' && k.level !== 'campaign' && (
                        <span className="block text-[10px] text-gray-400 truncate max-w-[110px] sm:max-w-[280px]" title={p.herkunft(k)}>{p.herkunft(k)}</span>
                      )}
                    </span>
                    {k.level === 'ad' && (
                      <button type="button" onClick={() => p.onVorschau(k)} title={t('crm.ads.previewTitle', 'Vorschau ansehen (Facebook & Instagram)')}
                        className="hidden sm:inline-flex px-1.5 py-0.5 rounded border border-gray-200 text-[11px] text-gray-500 hover:border-blue-400 hover:text-blue-600 shrink-0">
                        👁
                      </button>
                    )}
                  </div>
                </td>
                {spalten.map(key => (
                  <td key={key} className={`px-2 py-2 whitespace-nowrap ${istText(key) ? 'text-left' : 'text-right tabular-nums'}`}>
                    {zelle(k, key)}
                  </td>
                ))}
                <td className="px-1 py-1 text-right">
                  <ActionMenu items={p.aktionen(k)} label={t('crm.werbung.zentrale.zeilenMenue', 'Aktionen für {{name}}', { name: k.name })} />
                </td>
              </tr>
            )
          })}
          {zeilen.length === 0 && (
            <tr>
              <td colSpan={spalten.length + 2}>
                <EmptyState compact icon="ads" title={t('crm.werbung.zentrale.leer', 'Keine Zeilen')}
                  text={t('crm.werbung.zentrale.leerText', 'Im Zeitraum oder mit diesem Filter gibt es nichts anzuzeigen.')} />
              </td>
            </tr>
          )}
        </tbody>
        {zeilen.length > 0 && (
          <tfoot>
            <tr className="border-t border-gray-200 bg-white font-semibold text-gray-900">
              <td className="sticky left-0 z-[1] bg-white px-3 py-2 text-xs">
                {t('crm.werbung.zentrale.summe', 'Gesamt ({{n}})', { n: p.summe.anzahl })}
              </td>
              {spalten.map(key => {
                if (istText(key)) return <td key={key} className="px-2 py-2" />
                const v = wertVon(key, p.summe.werte, eigene)
                return (
                  <td key={key} className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatWert(v, formatVon(key, eigene), fmt)}
                    {p.summe.vergleich && (
                      <Delta d={veraenderung(v, wertVon(key, p.summe.vergleich, eigene))} besser={SPALTE.get(key)?.hoeherBesser ?? null} fmt={fmt} />
                    )}
                  </td>
                )
              })}
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
