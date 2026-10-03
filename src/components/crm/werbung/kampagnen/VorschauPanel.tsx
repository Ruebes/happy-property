import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { hatSprachen, type AdDraft, type AdSprache, type MediaRef, type PreviewAlleRequest, type PreviewFormat } from '../../../../lib/metaSpec'
import { builderCall, fehlerText } from './builderApi'
import { useAssistent } from './useEntwurf'
import { ausschnittStil } from './ZuschnittDialog'
import { CROP_KEY_FUER, PLATZ_LABEL, type SlotSeiten } from './r23Typen'

// ── Vorschau einer Anzeige im Assistenten ────────────────────────────────────
// Lokal und sofort: Feed 4:5 und Story/Reel 9:16 mit den Sicherheitszonen
// (oben 14 %, unten 35 %: dort liegen bei Stories und Reels Profil, Text und
// Knopf von Meta), Karussell als Kartenreihe, vorhandener Beitrag mit Bild
// und Text. Auf Wunsch die echte Vorschau von Meta für ALLE Platzierungen
// (meta-builder preview_alle; Entwurf nur mit Freischaltung, laufende Anzeige
// direkt): es wird nur die iframe-Adresse von facebook.com übernommen, kein
// fremdes HTML eingesetzt. Laufende Anzeigen: „Vorschau-Link teilen"
// (preview_shareable_link, meta-builder ad_vorschau_link).

type Ansicht = '4:5' | '9:16'

interface MetaRahmen { format: PreviewFormat; labelKey: string; src: string | null; breite: number; hoehe: number; fehler?: string }

/** iframe-Adresse aus Metas Vorschau-Snippet (nur facebook.com) */
export function iframeAus(body: string | null): { src: string; breite: number; hoehe: number } | null {
  if (!body) return null
  const m = /src="([^"]+)"/i.exec(body)
  if (!m) return null
  const src = m[1].replace(/&amp;/g, '&')
  if (!/^https:\/\/(www\.)?facebook\.com\//i.test(src)) return null
  const b = Number(/width="(\d+)"/i.exec(body)?.[1] ?? 320)
  const h = Number(/height="(\d+)"/i.exec(body)?.[1] ?? 560)
  return { src, breite: b > 0 ? b : 320, hoehe: h > 0 ? h : 560 }
}

const kuerze = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()} …` : s)
const hostAus = (url: string) => /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]?.replace(/^www\./, '') ?? ''

export default function VorschauPanel({ ad }: { ad: AdDraft | undefined }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { e, katalog, schreibSperre } = useAssistent()
  const [ansicht, setAnsicht] = useState<Ansicht>('4:5')
  const [zonen, setZonen] = useState(true)
  const [meta, setMeta] = useState<MetaRahmen[] | null>(null)
  const [metaFuer, setMetaFuer] = useState<string | null>(null)
  const [platz, setPlatz] = useState<PreviewFormat | null>(null)
  const [laeuft, setLaeuft] = useState<null | 'vorschau' | 'link'>(null)
  const [link, setLink] = useState<{ fuer: string; url: string; hinweis: string } | null>(null)
  const [ausgelassen, setAusgelassen] = useState<Array<{ format: PreviewFormat; labelKey: string; grund: string }>>([])
  const [sprache, setSprache] = useState<AdSprache>('de')

  if (!ad) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-500">
        {t('crm.werbung.builder.vorschau.waehleAnzeige', 'Wähle links eine Anzeige, um ihre Vorschau zu sehen.')}
      </div>
    )
  }

  const row = (r: MediaRef | undefined) => (r?.media_id ? e.medien[r.media_id] : undefined)
  const url = (r: MediaRef | undefined): string | null => row(r)?.public_url ?? null
  const istVideo = ad.format === 'single_video'
  const beitrag = ad.beitrag
  const karten = beitrag ? [] : ad.format === 'carousel' ? (ad.media?.cards ?? []) : []
  const kartenSeiten: SlotSeiten = karten.some(k => k.media?.aspect === '4:5') ? '4:5' : '1:1'
  const feedRef = ad.media?.feed_4x5 ?? ad.media?.square_1x1 ?? ad.media?.landscape_191x1 ?? ad.media?.story_9x16
  const storyRef = ad.media?.story_9x16 ?? ad.media?.feed_4x5
  const seite = katalog?.pages?.find(p => p.id === ad.identity?.page_id)?.name ?? 'Happy Property'
  const text = beitrag ? (beitrag.text ?? '') : (ad.primary_texts ?? []).find(x => (x ?? '').trim()) ?? ''
  const titel = (ad.format === 'carousel' ? karten[0]?.headline : undefined) ?? (ad.headlines ?? []).find(x => (x ?? '').trim()) ?? ''
  const beschreibung = (ad.descriptions ?? []).find(x => (x ?? '').trim()) ?? ''
  const cta = t(`crm.werbung.meta.cta.${ad.cta_type}`, ad.cta_type)
  const ziel = ad.destination
  const link0 = ziel && (ziel.kind === 'website' || ziel.kind === 'website_lead_form') && ziel.url ? (ziel.display_link || hostAus(ziel.url)) : ''
  const live = !!ad.existing_id
  const mehrsprachig = hatSprachen(ad)

  /** Medium im Rahmen, mit Ausschnitt (crops = Metas image_crops), falls gesetzt */
  const medium = (r: MediaRef | undefined, seiten: SlotSeiten, cls: string, video = istVideo) => {
    const m = row(r)
    const z = r?.crops?.[CROP_KEY_FUER[seiten]]
    if (m?.public_url && z && m.width && m.height && !video) {
      return <div aria-hidden="true" className={`${cls} bg-no-repeat`} style={ausschnittStil(m.public_url, z, m.width, m.height)} />
    }
    const src = url(r)
    return src
      ? (video ? <video src={src} muted playsInline loop autoPlay className={cls} /> : <img src={src} alt="" className={cls} />)
      : <span className={`${cls} flex items-center justify-center bg-gray-100 text-[10px] text-gray-400`}>{t('crm.werbung.builder.vorschau.keinMedium', 'Noch kein Medium')}</span>
  }
  const beitragBild = (cls: string) => (beitrag?.vorschau_url
    ? <img src={beitrag.vorschau_url} alt="" className={cls} />
    : <span className={`${cls} flex items-center justify-center bg-gray-100 text-[10px] text-gray-400`}>{t('crm.werbung.builder.vorschau.beitrag', 'Vorhandener Beitrag')}</span>)


  const ladeMeta = async () => {
    setLaeuft('vorschau')
    try {
      // Formate wählt der Server passend zu Platzierungen und Format (previewFormatsFor)
      // Mit Entwurf (auch Bearbeiten): Stand des Formulars; ohne gespeicherten Entwurf die laufende Anzeige
      const anfrage: PreviewAlleRequest = {}
      const id = await e.sichern()
      if (id) { anfrage.draft_id = id; anfrage.ad_key = ad.key }
      else if (live && ad.existing_id) anfrage.ad_id = ad.existing_id
      else throw new Error(t('crm.werbung.builder.vorschau.erstSpeichern', 'Der Entwurf ist noch nicht gespeichert.'))
      if (mehrsprachig && sprache !== 'de') anfrage.sprache = sprache
      const res = await builderCall('preview_alle', anfrage)
      const rahmen: MetaRahmen[] = (res.previews ?? []).map(p => {
        const f = iframeAus(p.body)
        return { format: p.format, labelKey: p.label_key, src: f?.src ?? null, breite: f?.breite ?? 320, hoehe: f?.hoehe ?? 560, ...(p.error ? { fehler: p.error } : {}) }
      })
      setAusgelassen((res.uebersprungen ?? []).map(u => ({ format: u.format, labelKey: u.label_key, grund: u.grund })))
      setMeta(rahmen)
      setMetaFuer(ad.key)
      setPlatz(rahmen.find(r => r.src)?.format ?? rahmen[0]?.format ?? null)
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setLaeuft(null)
    }
  }

  const teilen = async () => {
    if (!ad.existing_id) return
    setLaeuft('link')
    try {
      const res = await builderCall('ad_vorschau_link', { ad_id: ad.existing_id })
      const l = res.link && /^https:\/\//i.test(res.link) ? res.link : null
      if (!l) throw new Error(res.hinweis || t('crm.werbung.builder.vorschau.keinLink', 'Meta hat keinen Vorschau-Link geliefert.'))
      setLink({ fuer: ad.key, url: l, hinweis: res.hinweis ?? '' })
      try {
        await navigator.clipboard.writeText(l)
        toast.success(t('crm.werbung.builder.vorschau.linkKopiert', 'Vorschau-Link kopiert'))
      } catch {
        toast.info(t('crm.werbung.builder.vorschau.linkDa', 'Vorschau-Link erstellt, bitte unten kopieren.'))
      }
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setLaeuft(null)
    }
  }

  const label = (format: PreviewFormat, labelKey?: string) => t(labelKey || `crm.werbung.meta.preview.${format}`, PLATZ_LABEL[format] ?? format)
  const gewaehlt = meta && metaFuer === ad.key ? meta.find(m => m.format === platz) ?? null : null
  // preview_alle zählt bei meta-builder zu den Schreib-Modi (lädt fehlende Medien hoch): braucht die Freischaltung
  const sperre = schreibSperre

  return (
    <section aria-labelledby="vorschau-titel" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="vorschau-titel" className="mr-auto font-heading text-base text-hp-navy">{t('crm.werbung.builder.vorschau.titel', 'Vorschau')}</h3>
        <div className="flex overflow-hidden rounded-lg border border-gray-200 text-xs" role="group" aria-label={t('crm.werbung.builder.vorschau.format', 'Format')}>
          {(['4:5', '9:16'] as const).map(a => (
            <button key={a} type="button" aria-pressed={ansicht === a} onClick={() => setAnsicht(a)}
              className={`px-2.5 py-1 font-medium ${ansicht === a ? 'bg-hp-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {a === '4:5' ? t('crm.werbung.builder.vorschau.feed', 'Feed 4:5') : t('crm.werbung.builder.vorschau.story', 'Story 9:16')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-center">
        {ansicht === '4:5' ? (
          <div className="w-full max-w-[18rem] overflow-hidden rounded-xl border border-gray-200 bg-white text-[11px] shadow-sm">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="h-7 w-7 shrink-0 rounded-full bg-hp-navy/80" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate font-semibold text-gray-900">
                  {seite}{ad.partnerschaft ? ` ${t('crm.werbung.builder.vorschau.mitPartner', 'mit Partner')}` : ''}
                </span>
                <span className="block text-[10px] text-gray-500">{ad.partnerschaft ? t('crm.werbung.builder.vorschau.partnerschaft', 'Bezahlte Partnerschaft') : t('crm.werbung.builder.vorschau.gesponsert', 'Gesponsert')}</span>
              </span>
            </div>
            {text && (
              <p className="whitespace-pre-wrap px-3 pb-2 text-gray-800">
                {kuerze(text, 125)}
                {text.length > 125 && <span className="text-gray-500"> {t('crm.werbung.builder.vorschau.mehr', 'Mehr anzeigen')}</span>}
              </p>
            )}
            {beitrag ? (
              <div className="aspect-[4/5] w-full bg-gray-100">{beitragBild('h-full w-full object-cover')}</div>
            ) : karten.length ? (
              <div className="flex snap-x gap-1.5 overflow-x-auto px-3 pb-2">
                {karten.map((k, i) => (
                  <div key={i} className="w-[78%] shrink-0 snap-start overflow-hidden rounded-lg border border-gray-200">
                    <div className={`${kartenSeiten === '4:5' ? 'aspect-[4/5]' : 'aspect-square'} w-full bg-gray-100`}>
                      {medium(k.media, kartenSeiten, 'h-full w-full object-cover', !!k.media?.video_id)}
                    </div>
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate font-semibold text-gray-900">{k.headline || t('crm.werbung.builder.vorschau.ohneTitel', 'Überschrift')}</span>
                      <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-800">{cta}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="aspect-[4/5] w-full bg-gray-100">{medium(feedRef, ad.media?.feed_4x5 ? '4:5' : ad.media?.square_1x1 ? '1:1' : '1.91:1', 'h-full w-full object-cover')}</div>
            )}
            {!karten.length && (
              <div className="flex items-center gap-2 bg-gray-50 px-3 py-2">
                <span className="min-w-0 flex-1">
                  {link0 && <span className="block truncate text-[10px] uppercase text-gray-500">{link0}</span>}
                  {!beitrag && <span className="block truncate font-semibold text-gray-900">{titel || t('crm.werbung.builder.vorschau.ohneTitel', 'Überschrift')}</span>}
                  {beschreibung && !beitrag && <span className="block truncate text-gray-500">{beschreibung}</span>}
                </span>
                <span className="shrink-0 rounded-md bg-gray-200 px-2 py-1 font-semibold text-gray-800">{cta}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="relative aspect-[9/16] w-full max-w-[13rem] overflow-hidden rounded-xl bg-gray-900 text-[10px] text-white shadow-sm">
            <div className="absolute inset-0">
              {beitrag ? beitragBild('h-full w-full object-cover')
                : karten.length ? medium(karten[0]?.media, kartenSeiten, 'h-full w-full object-contain', !!karten[0]?.media?.video_id)
                  : medium(storyRef, ad.media?.story_9x16 ? '9:16' : '4:5', 'h-full w-full object-cover')}
            </div>
            {zonen && (
              <>
                <div className="absolute inset-x-0 top-0 h-[14%] border-b border-dashed border-white/70 bg-hp-navy/45">
                  <span className="absolute bottom-0.5 right-1 text-[9px] text-white/90">{t('crm.werbung.builder.vorschau.zoneOben', 'Sicherheitszone 14 %')}</span>
                </div>
                <div className="absolute inset-x-0 bottom-0 h-[35%] border-t border-dashed border-white/70 bg-hp-navy/45">
                  <span className="absolute right-1 top-0.5 text-[9px] text-white/90">{t('crm.werbung.builder.vorschau.zoneUnten', 'Sicherheitszone 35 %')}</span>
                </div>
              </>
            )}
            <div className="absolute left-2 right-2 top-2 flex items-center gap-1.5">
              <span className="h-5 w-5 shrink-0 rounded-full bg-white/80" aria-hidden="true" />
              <span className="truncate font-semibold drop-shadow">{seite}</span>
            </div>
            <div className="absolute bottom-2 left-2 right-2 space-y-1.5">
              {text && <p className="line-clamp-2 drop-shadow">{text}</p>}
              <span className="block rounded-full bg-white py-1 text-center font-semibold text-gray-900">{cta}</span>
            </div>
          </div>
        )}
      </div>

      {ansicht === '9:16' && (
        <label className="flex items-center justify-center gap-1.5 text-[11px] text-gray-600">
          <input type="checkbox" checked={zonen} onChange={ev => setZonen(ev.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300" />
          {t('crm.werbung.builder.vorschau.zonenZeigen', 'Sicherheitszonen zeigen (dort keine Schrift und kein Logo)')}
        </label>
      )}
      {beitrag?.permalink && (
        <a href={beitrag.permalink} target="_blank" rel="noopener noreferrer" className="block text-center text-[11px] font-semibold text-hp-navy underline">
          {t('crm.werbung.builder.vorschau.beitragAnsehen', 'Beitrag ansehen')}
        </a>
      )}

      <div className="space-y-2 rounded-lg border border-gray-200 p-3">
        {mehrsprachig && (
          <div className="flex items-center justify-center gap-3 text-[11px] text-gray-600" role="radiogroup" aria-label={t('crm.werbung.builder.vorschau.sprache', 'Sprache der Vorschau')}>
            {(['de', 'en'] as const).map(s => (
              <label key={s} className="flex items-center gap-1">
                <input type="radio" name={`vorschau-sprache-${ad.key}`} checked={sprache === s} onChange={() => setSprache(s)} />
                {s === 'de' ? t('crm.werbung.builder.vorschau.deutsch', 'Deutsch') : t('crm.werbung.builder.vorschau.englisch', 'Englisch')}
              </label>
            ))}
          </div>
        )}
        <button type="button" onClick={() => void ladeMeta()} disabled={!!laeuft || !!sperre}
          title={sperre ?? undefined}
          className="hp-btn hp-btn-ghost min-h-0 w-full px-3 py-1.5 text-xs disabled:opacity-50">
          {laeuft === 'vorschau' && <Spinner size="sm" />}
          {t('crm.werbung.builder.vorschau.alle', 'Vorschau aller Platzierungen von Meta laden')}
        </button>
        {sperre && <p className="text-center text-[10px] text-gray-500">{sperre}</p>}
        {live && (
          <>
            <button type="button" onClick={() => void teilen()} disabled={!!laeuft}
              className="hp-btn hp-btn-ghost min-h-0 w-full px-3 py-1.5 text-xs disabled:opacity-50">
              {laeuft === 'link' && <Spinner size="sm" />}
              {t('crm.werbung.builder.vorschau.teilen', 'Vorschau-Link teilen')}
            </button>
            {link && link.fuer === ad.key && (
              <div className="space-y-1">
                <input readOnly value={link.url} onFocus={ev => ev.currentTarget.select()} aria-label={t('crm.werbung.builder.vorschau.teilen', 'Vorschau-Link teilen')}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] text-gray-700" />
                <p className="text-[10px] leading-snug text-gray-500">{link.hinweis || t('crm.werbung.builder.vorschau.linkHilfe', 'Jeder mit dem Link sieht die Anzeige auf Facebook, auch ohne Werbekonto. Meta lässt veröffentlichte Vorschauen nach etwa 24 Stunden ablaufen.')}</p>
              </div>
            )}
          </>
        )}
        {meta && metaFuer === ad.key && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('crm.werbung.builder.vorschau.platzierungen', 'Platzierungen')}>
              {meta.map(m => (
                <button key={m.format} type="button" role="tab" aria-selected={platz === m.format} onClick={() => setPlatz(m.format)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${platz === m.format ? 'border-hp-navy bg-hp-navy text-white' : m.src ? 'border-gray-200 bg-white text-gray-700 hover:border-hp-navy/40' : 'border-dashed border-gray-200 bg-gray-50 text-gray-400'}`}>
                  {label(m.format, m.labelKey)}
                </button>
              ))}
            </div>
            {ausgelassen.length > 0 && (
              <ul className="space-y-0.5 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-2 py-1.5" aria-label={t('crm.werbung.builder.vorschau.ausgelassen', 'Ohne Vorschau')}>
                {ausgelassen.map(u => (
                  <li key={u.format} className="text-[10px] leading-snug text-gray-500">
                    🔒 <span className="font-semibold">{label(u.format, u.labelKey)}</span>: {u.grund}
                  </li>
                ))}
              </ul>
            )}
            {gewaehlt && (
              gewaehlt.src ? (
                <div className="flex justify-center overflow-x-auto">
                  <iframe src={gewaehlt.src} width={gewaehlt.breite} height={gewaehlt.hoehe} title={label(gewaehlt.format, gewaehlt.labelKey)}
                    className="max-w-full rounded-lg border border-gray-100" loading="lazy" />
                </div>
              ) : (
                <p className="text-[11px] text-gray-500">{gewaehlt.fehler ?? t('crm.werbung.builder.vorschau.keineMeta', 'Für dieses Format liefert Meta keine Vorschau.')}</p>
              )
            )}
          </div>
        )}
      </div>
    </section>
  )
}
