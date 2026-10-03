import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { supabase } from '../../../../lib/supabase'
import {
  aspectOf, type CropBox, type MediaAspect, type MediaKind, type MediaRef, type MetaMediaRow,
} from '../../../../lib/metaSpec'
import { lintText as pruefeText } from '../../../../lib/metaLint'
import { FeldHinweise } from './PruefPanel'
import { feldId } from './KampagnenFormular'
import { builderCall, fehlerText } from './builderApi'
import { useAssistent } from './useEntwurf'
import VideoExtras from './VideoExtras'
import ZuschnittDialog, { ausschnittStil } from './ZuschnittDialog'
import { CROP_KEY_FUER, type SlotSeiten } from './r23Typen'

// ── Medium je Platzierung (4:5 Feed, 9:16 Stories/Reels, 1:1, 1,91:1) ────────
// Datei wählen -> Seitenverhältnis prüfen -> zwei Pflicht-Bestätigungen
// (EU-Band ab Sekunde 1, KI-Kennzeichnung) -> Upload in den Bucket
// ad-creatives unter builder/<uuid>.<ext> (Muster AdStudio) -> meta-builder
// media_upload (legt meta_media an und lädt zu Meta). Dateiname wird nie an
// Meta gegeben (Projektnamen-Regel). Ohne Freischaltung: gesperrt mit Hinweis.
// Zuschneiden (Metas image_crops): Bild mit anderem Format hochladen und den
// Ausschnitt wählen, oder ein anderes Bild dieser Anzeige zuschneiden. Videos:
// 1,91:1-Slot nimmt auch 16:9; darunter Vorschaubild und Untertitel.

export const refAus = (row: MetaMediaRow): MediaRef => ({
  media_id: row.id,
  ...(row.meta_image_hash ? { image_hash: row.meta_image_hash } : {}),
  ...(row.meta_video_id ? { video_id: row.meta_video_id } : {}),
  ...(row.thumbnail_hash ? { thumbnail_hash: row.thumbnail_hash } : {}),
})

/** Verweis mit Seitenverhältnis (für Karussell- und Platzierungs-Prüfung in metaSpec) */
export const refMitSeiten = (row: MetaMediaRow, soll?: SlotSeiten): MediaRef => {
  const aspect = row.aspect !== 'other' ? row.aspect : soll && row.kind === 'video' ? soll : undefined
  return { ...refAus(row), ...(aspect ? { aspect } : {}) }
}

const masse = (url: string, kind: MediaKind): Promise<{ w: number; h: number }> => new Promise((resolve, reject) => {
  if (kind === 'image') {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => reject(new Error('image'))
    img.src = url
  } else {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight })
    v.onerror = () => reject(new Error('video'))
    v.src = url
  }
})

const warte = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Pfad im Bucket ad-creatives aus einer öffentlichen Storage-URL (sonst null) */
export const storagePfadAus = (url: string | null | undefined): string | null => {
  const m = /\/storage\/v1\/object\/public\/ad-creatives\/([^?#]+)/.exec(url ?? '')
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

/** Passt die Datei in den Slot? Videos im Querformat (und ihre Vorschaubilder, breitQuer): 1,91:1 oder 16:9 */
const passt = (w: number, h: number, soll: SlotSeiten, kind: MediaKind, breitQuer = false): boolean => {
  if ((kind === 'video' || breitQuer) && soll === '1.91:1' && h > 0) { const r = w / h; return r >= 1.7 && r <= 2.0 }
  return aspectOf(w, h) === soll
}

/** Anzeigename eines Seitenverhältnisses (1,91:1 bei Videos als 16:9) */
export const seitenText = (s: SlotSeiten, kind: MediaKind): string => (s === '1.91:1' ? (kind === 'video' ? '16:9' : '1,91:1') : s)

interface Props {
  node: string
  feld: string
  label: string
  aspect: SlotSeiten
  kind: MediaKind
  value: MediaRef | undefined
  onChange: (ref: MediaRef | undefined) => void
  disabled: boolean
  /** Karussellkarte: Nummer für eindeutige Ids, Meldungen zeigt dann die Karte */
  index?: number
  /** Bild, das schon im Bucket ad-creatives liegt (z. B. aus dem KI-Studio): gleiche Prüfung, ohne Datei-Upload */
  vorlage?: string | null
  vorlageKi?: boolean
  onVorlageErledigt?: () => void
  /** andere Bilder dieser Anzeige, aus denen sich ein Ausschnitt wählen lässt */
  quellen?: ReadonlyArray<{ label: string; ref: MediaRef }>
  /** Video: Vorschaubild und Untertitel zeigen (Standard: ja) */
  videoExtras?: boolean
  /** kurzer Erklärsatz unter dem Titel */
  hilfe?: string
  /** kein Zuschneiden anbieten (z. B. Vorschaubild eines Videos) */
  ohneZuschnitt?: boolean
  /** Vorschaubild eines Videos: im Querformat-Platz wie das Video auch 16:9 annehmen */
  vorschaubild?: boolean
}

export default function MedienSlot({
  node, feld, label, aspect, kind, value, onChange, disabled, index, vorlage, vorlageKi, onVorlageErledigt, quellen, videoExtras = true, hilfe, ohneZuschnitt,
  vorschaubild,
}: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const { e, schreibSperre, katalog } = useAssistent()
  const inputRef = useRef<HTMLInputElement>(null)
  const [datei, setDatei] = useState<File | null>(null)
  const [quelleUrl, setQuelleUrl] = useState<string | null>(null)
  const [vorschau, setVorschau] = useState<string | null>(null)
  const [mass, setMass] = useState<{ w: number; h: number } | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  /** Seitenverhältnis passt nicht, Bild lässt sich aber zuschneiden */
  const [schneidbar, setSchneidbar] = useState(false)
  const [euBand, setEuBand] = useState(false)
  const [kiLabel, setKiLabel] = useState(false)
  const [kiGeneriert, setKiGeneriert] = useState(false)
  const [laeuft, setLaeuft] = useState<null | 'upload' | 'meta' | 'video'>(null)
  /** Zuschnitt-Dialog: Quelle (Medium) + Startwert */
  const [schnitt, setSchnitt] = useState<{ row: MetaMediaRow; start?: CropBox } | null>(null)
  const [quellWahl, setQuellWahl] = useState(false)
  const lebt = useRef(true)

  useEffect(() => () => { lebt.current = false }, [])
  useEffect(() => () => { if (vorschau?.startsWith('blob:')) URL.revokeObjectURL(vorschau) }, [vorschau])

  const row = value?.media_id ? e.medien[value.media_id] : undefined
  const domId = `${feldId(feld)}${index !== undefined ? `-${index}` : ''}`
  const gesperrt = disabled || !!schreibSperre
  const zKey = CROP_KEY_FUER[aspect]
  const schneiden = kind === 'image' && !ohneZuschnitt
  const zuschnitt = value?.crops?.[zKey]
  const sText = seitenText(aspect, kind)
  // Hochgeladenes Bild mit anderem Format und ohne Ausschnitt
  const formatOffen = schneiden && !!row && !zuschnitt && !!row.width && !!row.height && !passt(row.width, row.height, aspect, kind, vorschaubild)

  const zuruecksetzen = () => {
    if (quelleUrl) onVorlageErledigt?.()
    setDatei(null); setQuelleUrl(null); setVorschau(null); setMass(null); setFehler(null); setSchneidbar(false)
    setEuBand(false); setKiLabel(false); setKiGeneriert(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  /** Maße lesen und Seitenverhältnis prüfen */
  const pruefeMasse = async (url: string) => {
    try {
      const m = await masse(url, kind)
      if (!lebt.current) return
      setMass(m)
      if (!passt(m.w, m.h, aspect, kind, vorschaubild)) {
        const ist = aspectOf(m.w, m.h)
        setFehler(t('crm.werbung.builder.medien.seitenverhaeltnis', 'Seitenverhältnis passt nicht: {{breite}} × {{hoehe}} px ist {{ist}}, hier braucht es {{soll}}.', {
          breite: m.w, hoehe: m.h, ist: ist === 'other' ? t('crm.werbung.builder.medien.anderes', 'ein anderes Format') : ist, soll: sText,
        }))
        setSchneidbar(schneiden)
      }
    } catch {
      if (lebt.current) setFehler(t('crm.werbung.builder.medien.nichtLesbar', 'Die Datei lässt sich nicht lesen.'))
    }
  }

  // Vorlage aus dem KI-Studio: wie eine gewählte Datei behandeln
  useEffect(() => {
    if (!vorlage) return
    setDatei(null); setMass(null); setFehler(null); setSchneidbar(false); setEuBand(false); setKiLabel(false)
    setKiGeneriert(vorlageKi === true)
    setQuelleUrl(vorlage)
    setVorschau(vorlage)
    if (!storagePfadAus(vorlage)) setFehler(t('crm.werbung.builder.medien.fremdeUrl', 'Das Bild liegt nicht im eigenen Speicher und kann so nicht übernommen werden.'))
    else void pruefeMasse(vorlage)
    // nur bei neuer Vorlage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vorlage])

  const waehle = async (f: File) => {
    zuruecksetzen()
    const ok = kind === 'image' ? f.type.startsWith('image/') : f.type.startsWith('video/')
    if (!ok) {
      setFehler(kind === 'image'
        ? t('crm.werbung.builder.medien.nurBild', 'Hier bitte ein Bild wählen (JPG oder PNG).')
        : t('crm.werbung.builder.medien.nurVideo', 'Hier bitte ein Video wählen (MP4 oder MOV).'))
      return
    }
    const url = URL.createObjectURL(f)
    setDatei(f)
    setVorschau(url)
    // Dateiname mit Projekt- oder Bauträgernamen: nur Warnung (Meta bekommt ihn nie)
    const namen = katalog?.lint_context?.forbidden_names ?? []
    if (pruefeText(f.name.replace(/[_.-]+/g, ' '), feld, { forbiddenNames: namen }).some(i => i.rule === 'projektname')) {
      toast.info(t('crm.werbung.builder.medien.dateiname', 'Der Dateiname enthält einen Projekt- oder Bauträgernamen. Er wird nicht an Meta übergeben, bitte die Datei trotzdem umbenennen.'))
    }
    await pruefeMasse(url)
  }

  /** zuschneiden: Bild mit anderem Format hochladen (aspect 'other') und danach den Ausschnitt wählen */
  const hochladen = async (zuschneiden = false) => {
    if ((!datei && !quelleUrl) || (fehler && !zuschneiden) || !euBand || !kiLabel || gesperrt) return
    const uuid = crypto.randomUUID()
    try {
      let path: string
      if (datei) {
        const ext = (datei.name.split('.').pop() || (kind === 'image' ? 'jpg' : 'mp4')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
        path = `builder/${uuid}.${ext}`
        setLaeuft('upload')
        const { error } = await supabase.storage.from('ad-creatives').upload(path, datei, { upsert: false, contentType: datei.type || undefined })
        if (error) throw error
      } else {
        const p = storagePfadAus(quelleUrl)
        if (!p) throw new Error(t('crm.werbung.builder.medien.fremdeUrl', 'Das Bild liegt nicht im eigenen Speicher und kann so nicht übernommen werden.'))
        path = p
      }
      setLaeuft('meta')
      // Videos im 16:9-Querformat (und ihre 16:9-Vorschaubilder) und Bilder zum Zuschneiden laufen als „anderes Format"
      const wireAspect: MediaAspect = zuschneiden || ((kind === 'video' || vorschaubild) && mass && aspectOf(mass.w, mass.h) !== aspect) ? 'other' : aspect
      const res = await builderCall('media_upload', {
        storage_path: path, kind, aspect: wireAspect,
        ai_generated: kiGeneriert, eu_band_confirmed: euBand, ki_label_confirmed: kiLabel,
        name: `hp_${kind}_${aspect.replace(':', 'x').replace('.', '')}_${uuid.slice(0, 8)}`,
      })
      let m = res.media
      e.setzeMedium(m)
      // Video im 16:9-Format: als Seitenverhältnis des Slots führen (Meta nimmt 1,91:1 und 16:9)
      const seitenVon = (row: MetaMediaRow) => refMitSeiten(row, row.kind === 'video' && passt(row.width ?? 0, row.height ?? 0, aspect, 'video') ? aspect : undefined)
      onChange(seitenVon(m))
      // Videos verarbeitet Meta im Hintergrund: Status abfragen, bis fertig (höchstens 3 Minuten)
      if (m.kind === 'video' && m.meta_status !== 'ready' && m.meta_status !== 'error') {
        setLaeuft('video')
        for (let i = 0; i < 36 && lebt.current; i++) {
          await warte(5000)
          const s = await builderCall('media_status', { id: m.id })
          m = s.media
          e.setzeMedium(m)
          if (m.meta_status === 'ready' || m.meta_status === 'error') break
        }
        if (lebt.current) onChange(seitenVon(m))
      }
      if (m.meta_status === 'error') toast.error(t('crm.werbung.builder.medien.metaFehler', 'Meta konnte das Medium nicht verarbeiten.'))
      else toast.success(t('crm.werbung.builder.medien.fertig', 'Medium hochgeladen'))
      if (lebt.current) {
        zuruecksetzen()
        if (zuschneiden && m.kind === 'image' && m.public_url && m.width && m.height) setSchnitt({ row: m })
      }
    } catch (err) {
      console.error('[Kampagnen] Medien-Upload:', err)
      toast.error(fehlerText(err, t))
    } finally {
      if (lebt.current) setLaeuft(null)
    }
  }

  /** Ausschnitt übernehmen: Quelle (dieses oder ein anderes Bild der Anzeige) + image_crops */
  const setzeAusschnitt = (quelle: MetaMediaRow, z: CropBox) => {
    const basis: MediaRef = value?.media_id === quelle.id ? { ...value } : refMitSeiten(quelle)
    // Mit Ausschnitt hat das Medium im Slot das Seitenverhältnis des Slots
    onChange({ ...basis, aspect, crops: { ...(basis.crops ?? {}), [zKey]: z } })
  }
  const ohneAusschnitt = () => {
    if (!value) return
    const crops = { ...(value.crops ?? {}) }
    delete crops[zKey]
    const { crops: _alt, aspect: _a, ...rest } = value
    const ist = row && row.aspect !== 'other' ? row.aspect : undefined
    onChange({ ...rest, ...(ist ? { aspect: ist } : {}), ...(Object.keys(crops).length ? { crops } : {}) })
  }

  // Quellen zum Zuschneiden: andere hochgeladene Bilder dieser Anzeige (mit Maßen)
  const quellRows = (quellen ?? [])
    .map(q => ({ label: q.label, row: q.ref.media_id ? e.medien[q.ref.media_id] : undefined }))
    .filter((q): q is { label: string; row: MetaMediaRow } => !!q.row && q.row.kind === 'image' && !!q.row.public_url && !!q.row.width && !!q.row.height && q.row.id !== value?.media_id)
    .filter((q, i, arr) => arr.findIndex(x => x.row.id === q.row.id) === i)

  const bildUrl = vorschau ?? row?.public_url ?? null
  const rahmen = aspect === '9:16' ? 'aspect-[9/16] w-24' : aspect === '4:5' ? 'aspect-[4/5] w-28' : aspect === '1:1' ? 'aspect-square w-28' : 'aspect-[1.91/1] w-40'
  const zeigeAusschnitt = !vorschau && !!zuschnitt && !!row?.public_url && !!row.width && !!row.height

  return (
    <div id={domId} className="scroll-mt-24 rounded-lg border border-gray-200 p-3">
      <div className="flex items-start gap-3">
        <div className={`${rahmen} shrink-0 overflow-hidden rounded-md border border-dashed border-gray-300 bg-gray-50`}>
          {zeigeAusschnitt && row?.public_url && row.width && row.height && zuschnitt ? (
            <div role="img" aria-label={t('crm.werbung.builder.zuschnitt.ausschnitt', 'Ausschnitt')} className="h-full w-full bg-no-repeat"
              style={ausschnittStil(row.public_url, zuschnitt, row.width, row.height)} />
          ) : bildUrl ? (
            kind === 'video'
              ? <video src={bildUrl} muted playsInline className="h-full w-full object-cover" />
              : <img src={bildUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full items-center justify-center text-[10px] text-gray-400">{sText}</span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs font-semibold text-gray-700">{label}</p>
          {hilfe && <p className="text-[10px] leading-snug text-gray-500">{hilfe}</p>}
          {row && !datei && !quelleUrl && (
            <div className="flex flex-wrap gap-1 text-[10px]">
              <span className={`rounded-full px-1.5 py-0.5 ${row.meta_status === 'ready' ? 'bg-emerald-50 text-emerald-800' : row.meta_status === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
                {t(`crm.werbung.builder.medien.status.${row.meta_status}`, row.meta_status)}
              </span>
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-gray-700">{row.eu_band_confirmed ? '✓' : '✕'} {t('crm.werbung.builder.medien.euBandKurz', 'EU-Band')}</span>
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-gray-700">{row.ki_label_confirmed ? '✓' : '✕'} {t('crm.werbung.builder.medien.kiKurz', 'KI-Kennzeichnung')}</span>
              {zuschnitt && <span className="rounded-full bg-hp-navy/10 px-1.5 py-0.5 text-hp-navy">✂ {t('crm.werbung.builder.zuschnitt.zugeschnitten', 'zugeschnitten')}</span>}
            </div>
          )}
          {value && !row && !datei && !quelleUrl && (
            <p className="text-[10px] text-gray-500">{t('crm.werbung.builder.medien.verknuepft', 'Medium verknüpft ({{id}})', { id: value.media_id.slice(0, 8) })}</p>
          )}
          {formatOffen && (
            <p className="text-[10px] font-semibold text-amber-800">{t('crm.werbung.builder.zuschnitt.offen', 'Das Bild hat ein anderes Format. Bitte den Ausschnitt für {{soll}} wählen.', { soll: sText })}</p>
          )}

          <input ref={inputRef} type="file" accept={kind === 'image' ? 'image/jpeg,image/png' : 'video/mp4,video/quicktime'}
            disabled={gesperrt || !!laeuft} className="sr-only" id={`${domId}-${node}-datei`}
            onChange={ev => { const f = ev.target.files?.[0]; if (f) void waehle(f) }} />
          <div className="flex flex-wrap gap-2">
            <label htmlFor={`${domId}-${node}-datei`}
              className={`hp-btn hp-btn-ghost min-h-0 cursor-pointer px-2.5 py-1 text-xs ${gesperrt || laeuft ? 'pointer-events-none opacity-50' : ''}`}>
              {value ? t('crm.werbung.builder.medien.ersetzen', 'Ersetzen') : t('crm.werbung.builder.medien.waehlen', 'Datei wählen')}
            </label>
            {schneiden && row?.public_url && row.width && row.height && !disabled && !datei && !quelleUrl && (
              <button type="button" onClick={() => row && setSchnitt({ row, start: zuschnitt })} className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs">
                ✂ {t('crm.werbung.builder.zuschnitt.knopf', 'Zuschneiden')}
              </button>
            )}
            {schneiden && quellRows.length > 0 && !disabled && !datei && !quelleUrl && (
              <button type="button" onClick={() => setQuellWahl(o => !o)} aria-expanded={quellWahl} className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs">
                {t('crm.werbung.builder.zuschnitt.ausAnderem', 'Aus anderem Bild zuschneiden')}
              </button>
            )}
            {zuschnitt && !disabled && (
              <button type="button" onClick={ohneAusschnitt} className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs">
                {t('crm.werbung.builder.zuschnitt.entfernen', 'Ausschnitt entfernen')}
              </button>
            )}
            {value && !disabled && (
              <button type="button" onClick={() => onChange(undefined)} className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs">
                {t('crm.werbung.builder.medien.entfernen', 'Entfernen')}
              </button>
            )}
          </div>
          {quellWahl && quellRows.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label={t('crm.werbung.builder.zuschnitt.quelle', 'Bild als Quelle wählen')}>
              {quellRows.map(q => (
                <li key={q.row.id}>
                  <button type="button" onClick={() => { setQuellWahl(false); setSchnitt({ row: q.row }) }}
                    className="flex items-center gap-1.5 rounded-lg border border-gray-200 p-1 pr-2 text-[11px] text-gray-700 hover:border-hp-navy">
                    {q.row.public_url && <img src={q.row.public_url} alt="" className="h-10 w-10 rounded object-cover" />}
                    {q.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {schreibSperre && !disabled && (
            <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.medien.gesperrt', 'Hochladen zu Meta erst nach der Freischaltung durch Sven.')}</p>
          )}
        </div>
      </div>

      {(datei || quelleUrl) && (
        <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
          <p className="text-[11px] text-gray-600">
            {datei ? datei.name : t('crm.werbung.builder.medien.ausStudio', 'Bild aus dem KI-Studio')}{mass ? ` · ${mass.w} × ${mass.h} px` : ''}
          </p>
          {fehler && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-[11px] text-red-700">{fehler}</p>
              {!schneidbar && (
                <button type="button" onClick={zuruecksetzen} className="text-[11px] font-semibold text-gray-600 underline">
                  {t('crm.werbung.builder.abbrechen', 'Abbrechen')}
                </button>
              )}
            </div>
          )}
          {schneidbar && (
            <p className="text-[11px] text-gray-600">{t('crm.werbung.builder.zuschnitt.anbieten', 'Du kannst das Bild trotzdem hochladen und danach den Ausschnitt für {{soll}} wählen.', { soll: sText })}</p>
          )}
          {(!fehler || schneidbar) && (
            <>
              <label className="flex items-start gap-2 text-xs text-gray-700">
                <input type="checkbox" checked={euBand} onChange={ev => setEuBand(ev.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
                <span>{t('crm.werbung.builder.medien.euBand', 'Das Band „Immobilien auf Zypern · EU-Mitglied“ ist ab Sekunde 1 sichtbar.')}</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-gray-700">
                <input type="checkbox" checked={kiGeneriert} onChange={ev => setKiGeneriert(ev.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
                <span>{t('crm.werbung.builder.medien.kiGeneriert', 'Das Medium ist ganz oder teilweise KI-generiert.')}</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-gray-700">
                <input type="checkbox" checked={kiLabel} onChange={ev => setKiLabel(ev.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
                <span>{kiGeneriert
                  ? t('crm.werbung.builder.medien.kiLabelJa', 'Die KI-Kennzeichnung ist im Medium vorhanden.')
                  : t('crm.werbung.builder.medien.kiLabelNein', 'Geprüft: kein KI-Inhalt, keine Kennzeichnung nötig.')}</span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void hochladen(schneidbar)} disabled={!euBand || !kiLabel || !!laeuft || gesperrt}
                  className="hp-btn hp-btn-primary min-h-0 px-3 py-1.5 text-xs disabled:opacity-50">
                  {laeuft && <Spinner size="sm" />}
                  {laeuft === 'upload' ? t('crm.werbung.builder.medien.laedtHoch', 'Lädt hoch …')
                    : laeuft === 'meta' ? t('crm.werbung.builder.medien.zuMeta', 'Übergabe an Meta …')
                      : laeuft === 'video' ? t('crm.werbung.builder.medien.videoVerarbeitung', 'Meta verarbeitet das Video …')
                        : schneidbar ? t('crm.werbung.builder.zuschnitt.hochladen', 'Hochladen und zuschneiden')
                          : t('crm.werbung.builder.medien.hochladen', 'Hochladen')}
                </button>
                <button type="button" onClick={zuruecksetzen} disabled={!!laeuft} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1.5 text-xs">
                  {t('crm.werbung.builder.abbrechen', 'Abbrechen')}
                </button>
                {(!euBand || !kiLabel) && (
                  <span className="text-[10px] text-gray-500">{t('crm.werbung.builder.medien.erstBestaetigen', 'Erst beide Bestätigungen setzen.')}</span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {kind === 'video' && videoExtras && value?.video_id && !datei && (
        <VideoExtras value={value} onChange={r => onChange(r)} disabled={disabled}
          eigenesBild={(
            <MedienSlot node={node} feld={feld} index={(index ?? 0) + 100} label={t('crm.werbung.builder.video.eigenesLabel', 'Eigenes Vorschaubild ({{seiten}})', { seiten: sText })}
              aspect={aspect} kind="image" disabled={disabled} videoExtras={false} ohneZuschnitt vorschaubild
              value={value.thumbnail_media_id ? { media_id: value.thumbnail_media_id, ...(value.thumbnail_hash ? { image_hash: value.thumbnail_hash } : {}) } : undefined}
              onChange={r => {
                if (!r) {
                  const { thumbnail_media_id: _x, thumbnail_hash: _y, thumbnail_quelle: _q, thumbnail_url: _u, ...rest } = value
                  onChange(rest)
                  return
                }
                const bild = e.medien[r.media_id]
                onChange({
                  ...value, thumbnail_media_id: r.media_id, thumbnail_quelle: 'upload',
                  ...(r.image_hash ? { thumbnail_hash: r.image_hash } : {}),
                  ...(bild?.public_url ? { thumbnail_url: bild.public_url } : {}),
                })
              }} />
          )} />
      )}

      {schnitt && schnitt.row.public_url && schnitt.row.width && schnitt.row.height && (
        <ZuschnittDialog open onClose={() => setSchnitt(null)} bildUrl={schnitt.row.public_url} breite={schnitt.row.width} hoehe={schnitt.row.height}
          seiten={aspect} start={schnitt.start} onFertig={z => setzeAusschnitt(schnitt.row, z)}
          titel={t('crm.werbung.builder.zuschnitt.titelSlot', 'Ausschnitt für {{slot}}', { slot: label })} />
      )}
      {index === undefined && <FeldHinweise node={node} felder={feld} />}
    </div>
  )
}
