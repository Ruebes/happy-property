import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { supabase } from '../../../../lib/supabase'
import { UNTERTITEL_SPRACHEN, type MediaRef, type UntertitelSprache, type VideoThumbnail } from '../../../../lib/metaSpec'
import { builderCall, fehlerText } from './builderApi'
import { useAssistent } from './useEntwurf'

// ── Video: Vorschaubild und Untertitel ───────────────────────────────────────
// Vorschaubild: aus Metas Vorschlägen für das Video wählen (meta-builder
// video_vorschaubilder / video_vorschaubild, thumbnail_quelle 'meta_liste')
// oder ein eigenes Bild hochladen (normaler Medien-Upload mit EU-Band- und
// KI-Bestätigung; thumbnail_media_id, thumbnail_quelle 'upload').
// Untertitel: SRT-Datei in den Speicher ad-creatives, meta-builder
// video_untertitel hängt sie an das Video bei Meta (POST /{video_id}/captions;
// Weg für Werbekonto-Videos per validate_only noch zu bestätigen). Die
// Untertitel gehören zum Video, nicht zum Werbemittel: hier nur der Stand
// dieser Sitzung.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SPRACH_NAME: Readonly<Record<UntertitelSprache, string>> = { de_DE: 'Deutsch', en_US: 'Englisch (USA)', en_GB: 'Englisch (UK)' }

export default function VideoExtras({ value, onChange, disabled, eigenesBild }: {
  value: MediaRef
  onChange: (ref: MediaRef) => void
  disabled: boolean
  /** Upload-Feld für ein eigenes Vorschaubild (MedienSlot, Bild im Seitenverhältnis des Videos) */
  eigenesBild: ReactNode
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const { e, schreibSperre } = useAssistent()
  const [bilder, setBilder] = useState<VideoThumbnail[] | null>(null)
  const [laedt, setLaedt] = useState<null | 'liste' | 'setzen' | 'untertitel'>(null)
  const [eigenesOffen, setEigenesOffen] = useState(false)
  const [sprache, setSprache] = useState<UntertitelSprache>('de_DE')
  const [untertitel, setUntertitel] = useState<Array<{ sprache: UntertitelSprache; hinweis?: string }>>([])

  const eigeneId = UUID.test(value.media_id)
  const gesperrt = disabled || !!schreibSperre || !eigeneId
  const eigenesBildRow = value.thumbnail_media_id ? e.medien[value.thumbnail_media_id] : undefined
  const bildUrl = eigenesBildRow?.public_url ?? value.thumbnail_url ?? null
  const sprachName = (s: UntertitelSprache) => t(`crm.werbung.builder.video.sprache.${s}`, SPRACH_NAME[s])

  const ladeBilder = async () => {
    setLaedt('liste')
    try {
      const res = await builderCall('video_vorschaubilder', { media_id: value.media_id })
      const liste = (res.vorschaubilder ?? []).filter(b => /^https:\/\//i.test(b.uri))
      setBilder(liste)
      if (!liste.length) toast.info(t('crm.werbung.builder.video.keineBilder', 'Meta hat für dieses Video noch keine Vorschaubilder. Bitte später noch einmal.'))
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setLaedt(null)
    }
  }

  const waehleBild = async (b: VideoThumbnail) => {
    setLaedt('setzen')
    try {
      const res = await builderCall('video_vorschaubild', { media_id: value.media_id, uri: b.uri })
      if (!res.thumbnail_hash) throw new Error(t('crm.werbung.builder.video.bildFehlt', 'Meta hat das Vorschaubild nicht bestätigt.'))
      const { thumbnail_media_id: _alt, ...rest } = value
      onChange({ ...rest, thumbnail_hash: res.thumbnail_hash, thumbnail_quelle: 'meta_liste', thumbnail_url: res.uri || b.uri })
      setBilder(null)
      toast.success(t('crm.werbung.builder.video.bildGesetzt', 'Vorschaubild gesetzt'))
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setLaedt(null)
    }
  }

  const ladeUntertitel = async (f: File) => {
    if (!/\.srt$/i.test(f.name)) {
      toast.error(t('crm.werbung.builder.video.nurSrt', 'Bitte eine Untertitel-Datei im SRT-Format wählen (.srt).'))
      return
    }
    setLaedt('untertitel')
    try {
      const pfad = `builder/untertitel/${crypto.randomUUID()}.srt`
      const { error } = await supabase.storage.from('ad-creatives').upload(pfad, f, { upsert: false, contentType: 'text/plain' })
      if (error) throw error
      const res = await builderCall('video_untertitel', { media_id: value.media_id, storage_path: pfad, sprache, standard: sprache === 'de_DE' })
      if (!res.ok) throw new Error(res.hinweis || t('crm.werbung.builder.video.untertitelFehler', 'Meta hat die Untertitel nicht angenommen.'))
      setUntertitel(u => [...u.filter(x => x.sprache !== sprache), { sprache, ...(res.hinweis ? { hinweis: res.hinweis } : {}) }])
      toast.success(t('crm.werbung.builder.video.untertitelFertig', 'Untertitel hochgeladen'))
    } catch (err) {
      console.error('[Kampagnen] Untertitel:', err)
      toast.error(fehlerText(err, t))
    } finally {
      setLaedt(null)
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
      {!eigeneId && (
        <p className="text-[10px] text-gray-500">{t('crm.werbung.builder.video.nurEigene', 'Vorschaubild und Untertitel lassen sich nur für hier hochgeladene Videos setzen.')}</p>
      )}

      {/* Vorschaubild */}
      <div className="space-y-1.5" data-einstellung={t('crm.werbung.builder.video.vorschaubild', 'Vorschaubild')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-700">{t('crm.werbung.builder.video.vorschaubild', 'Vorschaubild')}</span>
          <span className="text-[10px] text-gray-500">
            {value.thumbnail_quelle === 'upload' || eigenesBildRow
              ? t('crm.werbung.builder.video.eigenes', 'eigenes Bild')
              : value.thumbnail_quelle === 'meta_liste'
                ? t('crm.werbung.builder.video.ausListe', 'aus Metas Vorschlägen')
                : t('crm.werbung.builder.video.automatisch', 'wählt Meta automatisch')}
          </span>
        </div>
        <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.video.vorschaubildHilfe', 'Das Bild, das vor dem Abspielen zu sehen ist. Auch hier gehört das EU-Band ins Bild.')}</p>
        {bildUrl && (
          <img src={bildUrl} alt="" className="h-20 w-auto rounded border border-gray-200 object-cover" />
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void ladeBilder()} disabled={gesperrt || !!laedt}
            className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs disabled:opacity-50">
            {laedt === 'liste' && <Spinner size="sm" />}
            {t('crm.werbung.builder.video.ausVideo', 'Aus dem Video wählen')}
          </button>
          <button type="button" onClick={() => setEigenesOffen(o => !o)} disabled={disabled || !!schreibSperre}
            aria-expanded={eigenesOffen} className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs disabled:opacity-50">
            {t('crm.werbung.builder.video.eigenesHochladen', 'Eigenes Bild hochladen')}
          </button>
        </div>
        {bilder && bilder.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label={t('crm.werbung.builder.video.bilderListe', 'Vorschaubilder von Meta')}>
            {bilder.map(b => (
              <li key={b.uri}>
                <button type="button" onClick={() => void waehleBild(b)} disabled={!!laedt}
                  className="relative block overflow-hidden rounded border border-gray-200 hover:border-hp-navy disabled:opacity-50">
                  <img src={b.uri} alt="" loading="lazy" className="h-20 w-auto object-cover" />
                  {b.is_preferred && <span className="absolute left-0.5 top-0.5 rounded bg-white/90 px-1 text-[9px] font-semibold text-hp-navy">{t('crm.werbung.builder.video.metaWahl', 'Metas Wahl')}</span>}
                </button>
              </li>
            ))}
            {laedt === 'setzen' && <li className="self-center"><Spinner size="sm" /></li>}
          </ul>
        )}
        {eigenesOffen && <div>{eigenesBild}</div>}
      </div>

      {/* Untertitel */}
      <div className="space-y-1.5" data-einstellung={t('crm.werbung.builder.video.untertitel', 'Untertitel')}>
        <span className="text-[11px] font-semibold text-gray-700">{t('crm.werbung.builder.video.untertitel', 'Untertitel')}</span>
        <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.video.untertitelHilfe', 'SRT-Datei je Sprache. Meta zeigt sie, wenn der Ton aus ist (die meisten schauen ohne Ton). Sie hängen am Video, nicht an der Anzeige.')}</p>
        {untertitel.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {untertitel.map(u => (
              <li key={u.sprache} title={u.hinweis} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-800">
                ✓ {sprachName(u.sprache)}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select value={sprache} onChange={ev => { const s = UNTERTITEL_SPRACHEN.find(x => x === ev.target.value); if (s) setSprache(s) }} disabled={gesperrt}
            aria-label={t('crm.werbung.builder.video.untertitelSprache', 'Sprache der Untertitel')}
            className="rounded-lg border border-gray-200 px-2 py-1 text-xs">
            {UNTERTITEL_SPRACHEN.map(s => <option key={s} value={s}>{sprachName(s)}</option>)}
          </select>
          <label className={`hp-btn hp-btn-ghost min-h-0 cursor-pointer px-2.5 py-1 text-xs ${gesperrt || laedt ? 'pointer-events-none opacity-50' : ''}`}>
            {laedt === 'untertitel' && <Spinner size="sm" />}
            {t('crm.werbung.builder.video.untertitelWaehlen', 'SRT-Datei wählen')}
            <input type="file" accept=".srt,application/x-subrip,text/plain" className="sr-only" disabled={gesperrt || !!laedt}
              onChange={ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) void ladeUntertitel(f) }} />
          </label>
        </div>
      </div>
    </div>
  )
}
