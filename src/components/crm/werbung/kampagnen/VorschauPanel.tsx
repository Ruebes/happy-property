import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { type AdDraft, type MediaRef, type PreviewFormat } from '../../../../lib/metaSpec'
import { builderCall, fehlerText } from './builderApi'
import { useAssistent } from './useEntwurf'

// ── Vorschau einer Anzeige im Assistenten ────────────────────────────────────
// Lokal und sofort: Feed 4:5 und Story/Reel 9:16 mit den Sicherheitszonen
// (oben 14 %, unten 35 %: dort liegen bei Stories und Reels Profil, Text und
// Knopf von Meta). Auf Wunsch die echte Vorschau von Meta (meta-builder
// preview, nur mit Freischaltung): es wird nur die iframe-Adresse von
// facebook.com übernommen, kein fremdes HTML eingesetzt.

type Ansicht = '4:5' | '9:16'
const META_FORMATE: PreviewFormat[] = ['MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_STORY', 'INSTAGRAM_REELS']

interface MetaRahmen { format: PreviewFormat; src: string | null; breite: number; hoehe: number; fehler?: string }

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
  const [laeuft, setLaeuft] = useState(false)

  if (!ad) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-500">
        {t('crm.werbung.builder.vorschau.waehleAnzeige', 'Wähle links eine Anzeige, um ihre Vorschau zu sehen.')}
      </div>
    )
  }

  const url = (r: MediaRef | undefined): string | null => (r?.media_id ? e.medien[r.media_id]?.public_url ?? null : null)
  const istVideo = ad.format === 'single_video'
  const cardBild = ad.format === 'carousel' ? url(ad.media?.cards?.[0]?.media) : null
  const feedBild = cardBild ?? url(ad.media?.feed_4x5) ?? url(ad.media?.square_1x1) ?? url(ad.media?.story_9x16)
  const storyBild = cardBild ?? url(ad.media?.story_9x16) ?? url(ad.media?.feed_4x5)
  const seite = katalog?.pages?.find(p => p.id === ad.identity?.page_id)?.name ?? 'Happy Property'
  const text = (ad.primary_texts ?? []).find(x => (x ?? '').trim()) ?? ''
  const titel = (ad.format === 'carousel' ? ad.media?.cards?.[0]?.headline : undefined) ?? (ad.headlines ?? []).find(x => (x ?? '').trim()) ?? ''
  const beschreibung = (ad.descriptions ?? []).find(x => (x ?? '').trim()) ?? ''
  const cta = t(`crm.werbung.meta.cta.${ad.cta_type}`, ad.cta_type)
  const link = ad.destination?.kind === 'website' ? (ad.destination.display_link || hostAus(ad.destination.url)) : ''

  const medium = (src: string | null, cls: string) => (src
    ? (istVideo ? <video src={src} muted playsInline loop autoPlay className={cls} /> : <img src={src} alt="" className={cls} />)
    : <span className={`${cls} flex items-center justify-center bg-gray-100 text-[10px] text-gray-400`}>{t('crm.werbung.builder.vorschau.keinMedium', 'Noch kein Medium')}</span>)

  const ladeMeta = async () => {
    setLaeuft(true)
    try {
      const id = await e.sichern()
      if (!id) throw new Error(t('crm.werbung.builder.vorschau.erstSpeichern', 'Der Entwurf ist noch nicht gespeichert.'))
      const res = await builderCall('preview', { draft_id: id, ad_key: ad.key, formats: META_FORMATE })
      setMeta(res.previews.map(p => {
        const f = iframeAus(p.body)
        return { format: p.format, src: f?.src ?? null, breite: f?.breite ?? 320, hoehe: f?.hoehe ?? 560, ...(p.error ? { fehler: p.error } : {}) }
      }))
      setMetaFuer(ad.key)
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setLaeuft(false)
    }
  }

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
                <span className="block truncate font-semibold text-gray-900">{seite}</span>
                <span className="block text-[10px] text-gray-500">{t('crm.werbung.builder.vorschau.gesponsert', 'Gesponsert')}</span>
              </span>
            </div>
            {text && (
              <p className="whitespace-pre-wrap px-3 pb-2 text-gray-800">
                {kuerze(text, 125)}
                {text.length > 125 && <span className="text-gray-500"> {t('crm.werbung.builder.vorschau.mehr', 'Mehr anzeigen')}</span>}
              </p>
            )}
            <div className="aspect-[4/5] w-full bg-gray-100">{medium(feedBild, 'h-full w-full object-cover')}</div>
            <div className="flex items-center gap-2 bg-gray-50 px-3 py-2">
              <span className="min-w-0 flex-1">
                {link && <span className="block truncate text-[10px] uppercase text-gray-500">{link}</span>}
                <span className="block truncate font-semibold text-gray-900">{titel || t('crm.werbung.builder.vorschau.ohneTitel', 'Überschrift')}</span>
                {beschreibung && <span className="block truncate text-gray-500">{beschreibung}</span>}
              </span>
              <span className="shrink-0 rounded-md bg-gray-200 px-2 py-1 font-semibold text-gray-800">{cta}</span>
            </div>
          </div>
        ) : (
          <div className="relative aspect-[9/16] w-full max-w-[13rem] overflow-hidden rounded-xl bg-gray-900 text-[10px] text-white shadow-sm">
            <div className="absolute inset-0">{medium(storyBild, 'h-full w-full object-cover')}</div>
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

      <div className="rounded-lg border border-gray-200 p-3">
        <button type="button" onClick={() => void ladeMeta()} disabled={laeuft || !!schreibSperre}
          title={schreibSperre ?? undefined}
          className="hp-btn hp-btn-ghost min-h-0 w-full px-3 py-1.5 text-xs disabled:opacity-50">
          {laeuft && <Spinner size="sm" />}
          {t('crm.werbung.builder.vorschau.echt', 'Echte Vorschau von Meta laden')}
        </button>
        {schreibSperre && <p className="mt-1 text-center text-[10px] text-gray-500">{schreibSperre}</p>}
        {meta && metaFuer === ad.key && (
          <div className="mt-3 space-y-3">
            {meta.map(m => (
              <div key={m.format}>
                <p className="mb-1 text-[11px] font-semibold text-gray-600">{t(`crm.werbung.meta.preview.${m.format}`, m.format)}</p>
                {m.src ? (
                  <div className="flex justify-center overflow-x-auto">
                    <iframe src={m.src} width={m.breite} height={m.hoehe} title={t(`crm.werbung.meta.preview.${m.format}`, m.format)}
                      className="max-w-full rounded-lg border border-gray-100" loading="lazy" />
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-500">{m.fehler ?? t('crm.werbung.builder.vorschau.keineMeta', 'Für dieses Format liefert Meta keine Vorschau.')}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
