import { useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS, type CardDraft, type KarussellOptionen } from '../../../../lib/metaSpec'
import { DESCRIPTION_MAX, HEADLINE_MAX } from '../../../../lib/metaLint'
import { INPUT_CLS } from '../felder'
import { FeldHinweise } from './PruefPanel'
import { RadioReihe, Schalter, feldId, feldLabel } from './Bausteine'
import MedienSlot from './MedienSlot'
import { useAssistent } from './useEntwurf'
import { EmpfohlenBadge } from './bearbeitenHelfer'
import type { KarussellSeiten } from './r23Typen'

// ── Karussell (2 bis 10 Karten) ──────────────────────────────────────────────
// Je Karte Bild oder Video im gemeinsamen Seitenverhältnis (1:1 oder 4:5),
// Überschrift, Beschreibung und eigener Link. Reihenfolge per Ziehen (Maus)
// oder Pfeilknöpfen (Tastatur, Telefon). Unter „Alle Einstellungen" die
// Schalter Endkarte (multi_share_end_card) und „Beste Karten zuerst"
// (multi_share_optimized). Instagram zeigt höchstens 5 Karten.

let zaehler = 0
const neueId = (): string => `k${Date.now().toString(36)}${(zaehler++).toString(36)}`

/** Stabile Schlüssel je Karte (Upload-Zustand wandert beim Umsortieren mit) */
function useKartenIds(n: number): [string[], (fn: (ids: string[]) => string[]) => void] {
  const ref = useRef<string[]>([])
  const [, neu] = useState(0)
  if (ref.current.length < n) ref.current = [...ref.current, ...Array.from({ length: n - ref.current.length }, neueId)]
  else if (ref.current.length > n) ref.current = ref.current.slice(0, n)
  const setze = (fn: (ids: string[]) => string[]) => { ref.current = fn(ref.current); neu(x => x + 1) }
  return [ref.current, setze]
}

const verschiebe = <T,>(arr: readonly T[], von: number, nach: number): T[] => {
  const out = arr.slice()
  const [x] = out.splice(von, 1)
  out.splice(nach, 0, x)
  return out
}

export function KarussellKarten({ node, cards, seiten, onCards, disabled }: {
  node: string
  cards: CardDraft[]
  seiten: KarussellSeiten
  onCards: (fn: (cards: CardDraft[]) => CardDraft[]) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const { e } = useAssistent()
  const [ids, setIds] = useKartenIds(cards.length)
  const [art, setArt] = useState<Record<string, 'image' | 'video'>>({})
  const [zieht, setZieht] = useState<number | null>(null)
  const [ueber, setUeber] = useState<number | null>(null)
  // Ziehen nur über den Griff (sonst stört es das Markieren in den Eingabefeldern)
  const [griff, setGriff] = useState<number | null>(null)

  const bewege = (von: number, nach: number) => {
    if (nach < 0 || nach >= cards.length || von === nach) return
    setIds(x => verschiebe(x, von, nach))
    onCards(c => verschiebe(c, von, nach))
  }
  const entferne = (i: number) => {
    setIds(x => x.filter((_, j) => j !== i))
    onCards(c => c.filter((_, j) => j !== i))
  }
  const neu = () => {
    setIds(x => [...x, neueId()])
    onCards(c => [...c, { headline: '', media: { media_id: '' } }])
  }
  const setzeKarte = (i: number, patch: Partial<CardDraft>) => onCards(c => c.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  const drop = (ev: DragEvent<HTMLLIElement>, i: number) => {
    ev.preventDefault()
    if (zieht !== null) bewege(zieht, i)
    setZieht(null); setUeber(null)
  }

  return (
    <div id={feldId('ad.media.cards')} className="space-y-3">
      <ol className="space-y-3" aria-label={t('crm.werbung.builder.karussell.karten', 'Karten')}>
        {cards.map((cd, i) => {
          const id = ids[i] ?? String(i)
          const row = cd.media?.media_id ? e.medien[cd.media.media_id] : undefined
          const kind: 'image' | 'video' = cd.media?.video_id || row?.kind === 'video' ? 'video' : (art[id] ?? 'image')
          const hatMedium = !!cd.media?.media_id
          const falschesFormat = !!row && !!row.width && !!row.height && !cd.media.crops && row.aspect !== seiten && row.kind === 'image'
          return (
            <li key={id} draggable={!disabled && griff === i}
              onDragStart={ev => { setZieht(i); ev.dataTransfer.effectAllowed = 'move' }}
              onDragOver={ev => { if (zieht !== null) { ev.preventDefault(); setUeber(i) } }}
              onDragLeave={() => setUeber(u => (u === i ? null : u))}
              onDrop={ev => drop(ev, i)} onDragEnd={() => { setZieht(null); setUeber(null); setGriff(null) }}
              className={`space-y-2 rounded-lg border p-3 transition-colors ${ueber === i && zieht !== i ? 'border-hp-navy bg-hp-navy/5' : 'border-gray-200'} ${zieht === i ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                {!disabled && (
                  <span aria-hidden="true" onPointerDown={() => setGriff(i)} onPointerUp={() => setGriff(null)}
                    className="cursor-grab select-none px-1 text-gray-400" title={t('crm.werbung.builder.karussell.ziehen', 'Zum Umsortieren ziehen')}>⋮⋮</span>
                )}
                <span className="mr-auto text-xs font-semibold text-gray-700">
                  {t('crm.werbung.builder.anzeige.karte', 'Karte {{n}}', { n: i + 1 })}
                  {i >= 5 && <span className="ml-1.5 font-normal text-gray-500">{t('crm.werbung.builder.karussell.nichtInstagram', '(nicht auf Instagram)')}</span>}
                </span>
                {!disabled && (
                  <>
                    <button type="button" onClick={() => bewege(i, i - 1)} disabled={i === 0}
                      aria-label={t('crm.werbung.builder.karussell.hoch', 'Karte {{n}} nach vorn', { n: i + 1 })}
                      className="rounded px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => bewege(i, i + 1)} disabled={i === cards.length - 1}
                      aria-label={t('crm.werbung.builder.karussell.runter', 'Karte {{n}} nach hinten', { n: i + 1 })}
                      className="rounded px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => entferne(i)} className="text-[11px] text-gray-500 hover:text-red-700">
                      {t('crm.werbung.builder.anzeige.karteEntfernen', 'Karte entfernen')}
                    </button>
                  </>
                )}
              </div>
              {!hatMedium && !disabled && (
                <RadioReihe name={`karte-art-${node}-${id}`} value={kind} disabled={disabled}
                  label={t('crm.werbung.builder.karussell.art', 'Bild oder Video')}
                  optionen={[['image', t('crm.werbung.builder.karussell.bild', 'Bild')], ['video', t('crm.werbung.builder.karussell.video', 'Video')]]}
                  onChange={v => setArt(a => ({ ...a, [id]: v }))} />
              )}
              <MedienSlot node={node} feld="ad.media.cards" index={i}
                label={kind === 'video'
                  ? t('crm.werbung.builder.karussell.videoLabel', 'Video ({{seiten}})', { seiten })
                  : t('crm.werbung.builder.karussell.bildLabel', 'Bild ({{seiten}})', { seiten })}
                aspect={seiten} kind={kind} value={hatMedium ? cd.media : undefined}
                quellen={cards.filter((_, j) => j !== i).map((x, j) => ({ label: t('crm.werbung.builder.anzeige.karte', 'Karte {{n}}', { n: j < i ? j + 1 : j + 2 }), ref: x.media }))}
                onChange={r => setzeKarte(i, { media: r ?? { media_id: '' } })} disabled={disabled} />
              {falschesFormat && (
                <p className="text-[11px] text-amber-800">{t('crm.werbung.builder.karussell.formatAnders', 'Diese Karte hat ein anderes Seitenverhältnis als {{seiten}}. Alle Karten brauchen dasselbe Format: neu hochladen oder zuschneiden.', { seiten })}</p>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-[11px] text-gray-500">{feldLabel(t, 'ad.headlines', 'Überschrift')}
                  <input value={cd.headline ?? ''} disabled={disabled} onChange={ev => setzeKarte(i, { headline: ev.target.value })} className={INPUT_CLS} />
                  <span className={`block text-right text-[10px] tabular-nums ${(cd.headline ?? '').trim().length > HEADLINE_MAX ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{(cd.headline ?? '').trim().length} / {HEADLINE_MAX}</span>
                </label>
                <label className="block text-[11px] text-gray-500">{feldLabel(t, 'ad.descriptions', 'Beschreibung')}
                  <input value={cd.description ?? ''} disabled={disabled} onChange={ev => setzeKarte(i, { description: ev.target.value })} className={INPUT_CLS} />
                  <span className={`block text-right text-[10px] tabular-nums ${(cd.description ?? '').trim().length > DESCRIPTION_MAX ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{(cd.description ?? '').trim().length} / {DESCRIPTION_MAX}</span>
                </label>
                <label className="block text-[11px] text-gray-500 sm:col-span-2">{t('crm.werbung.builder.anzeige.karteUrl', 'Link der Karte (leer = Website-URL der Anzeige)')}
                  <input value={cd.url ?? ''} disabled={disabled} onChange={ev => setzeKarte(i, { url: ev.target.value.trim() || undefined })} className={INPUT_CLS} />
                </label>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        {cards.length < LIMITS.carouselMax && !disabled && (
          <button type="button" onClick={neu} className="text-xs font-semibold text-hp-navy hover:underline">
            + {t('crm.werbung.builder.anzeige.karteNeu', 'Karte hinzufügen')}
          </button>
        )}
        <span className={`text-[11px] tabular-nums ${cards.length < LIMITS.carouselMin ? 'font-semibold text-red-600' : 'text-gray-500'}`}>
          {t('crm.werbung.builder.karussell.anzahl', '{{n}} von 2 bis 10 Karten', { n: cards.length })}
        </span>
      </div>
      <FeldHinweise node={node} felder="ad.media.cards" />
    </div>
  )
}

/** Seitenverhältnis aller Karten (Das Wichtigste) */
export function KarussellSeitenFeld({ seiten, onChange, disabled }: {
  seiten: KarussellSeiten
  onChange: (s: KarussellSeiten) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const label = t('crm.werbung.builder.karussell.seiten', 'Seitenverhältnis der Karten')
  return (
    <div data-einstellung={label}>
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-[11px] text-gray-500">{label}</p>
        {seiten === '1:1' && <EmpfohlenBadge />}
      </div>
      <div className="mt-1">
        <RadioReihe<KarussellSeiten> name="karussell-seiten" value={seiten} disabled={disabled} label={label}
          optionen={[['1:1', t('crm.werbung.builder.karussell.quadrat', 'Quadratisch 1:1')], ['4:5', t('crm.werbung.builder.karussell.hoch45', 'Hochformat 4:5')]]}
          onChange={onChange} />
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.karussell.seitenHilfe', '1:1 passt in allen Platzierungen, 4:5 nimmt im Feed mehr Platz ein. Alle Karten brauchen dasselbe Format.')}</p>
    </div>
  )
}

/** Schalter Endkarte und Reihenfolge (Alle Einstellungen) */
export function KarussellSchalter({ optionen, onChange, disabled }: {
  optionen: KarussellOptionen
  onChange: (o: KarussellOptionen) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <span id={feldId('ad.karussell.reihenfolge_automatisch')} className="block scroll-mt-24" />
      <Schalter checked={optionen.reihenfolge_automatisch !== false} disabled={disabled} empfohlen={optionen.reihenfolge_automatisch !== false}
        onChange={v => onChange({ ...optionen, reihenfolge_automatisch: v })}
        label={t('crm.werbung.builder.karussell.optimiert', 'Beste Karten automatisch zuerst zeigen')}
        hilfe={t('crm.werbung.builder.karussell.optimiertHilfe', 'Meta stellt die Karten nach vorn, die am besten laufen. Aus, wenn die Karten eine Geschichte in fester Reihenfolge erzählen.')} />
      <span id={feldId('ad.karussell.endkarte')} className="block scroll-mt-24" />
      <Schalter checked={optionen.endkarte === true} disabled={disabled} empfohlen={optionen.endkarte !== true}
        onChange={v => onChange({ ...optionen, endkarte: v })}
        label={t('crm.werbung.builder.karussell.endkarte', 'Endkarte mit Profilbild hinzufügen')}
        hilfe={t('crm.werbung.builder.karussell.endkarteHilfe', 'Zusätzliche letzte Karte mit Profilbild und Link der Seite. Für HP aus: der Klick soll auf die Landingpage gehen.')} />
    </div>
  )
}
