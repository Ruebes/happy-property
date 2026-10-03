import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import AdStudio from '../../AdStudio'
import Badge from '../../../ui/Badge'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import {
  AD_FORMAT_OPTIONS, CREATIVE_FEATURES, CREATIVE_FEATURE_INFO, CREATIVE_FEATURE_OPTIONS, CTA_OPTIONS, CTA_TYPES,
  HP_DEFAULT_LINK, LIMITS, URL_TAGS_STANDARD, aspectOf, ctaFor,
  type AdDestinationKind, type AdDraft, type AdFormat, type CardDraft, type CtaType, type EnumOption, type MediaRef,
} from '../../../../lib/metaSpec'
import { DESCRIPTION_MAX, HEADLINE_MAX, PRIMARY_VISIBLE } from '../../../../lib/metaLint'
import { INPUT_CLS, LockedField } from '../felder'
import { FeldHinweise } from './PruefPanel'
import { Abschnitt, AuswahlFeld, FeldRahmen, Schalter, TextFeld, feldId, feldLabel } from './KampagnenFormular'
import MedienSlot, { refAus, storagePfadAus } from './MedienSlot'
import WerbemittelWahl, { type WerbemittelAuswahl } from './WerbemittelWahl'
import { builderCall, fehlerText } from './builderApi'
import { anzeigeAngelegt, paarPartner, setzeAnzeige, useAssistent } from './useEntwurf'
import { useWerbeKontext } from '../useWerbeDaten'

// ── Werbeanzeige (Reihenfolge wie bei Meta) ──────────────────────────────────
// Identität (Seite + Instagram-Konto), Werbemittel (vorhandenes übernehmen,
// Format), Medien je Platzierung (4:5 Feed, 9:16 Stories/Reels) bzw.
// Karussellkarten, bis zu 5 Primärtexte / Überschriften / Beschreibungen mit
// Zählern (HP-Grenzen 40 / 30, 125 sichtbar), Call-to-Action, Ziel (Website
// oder Sofortformular), fester UTM-Standard, Advantage+ Creative (alles aus),
// Werbeanzeigen mit mehreren Werbetreibenden (aus). Plan B: Änderungen
// gelten für beide Anzeigen des Paares (_lang und _kurz).

const nurWerte = <V extends string>(alle: readonly EnumOption<V>[], werte: readonly V[]): EnumOption<V>[] =>
  werte.map(v => alle.find(o => o.value === v) ?? { value: v, labelKey: 'crm.werbung.meta.unknown' })

const VORRAT_FORMAT: Record<string, AdFormat> = { bild: 'single_image', video: 'single_video', karussell: 'carousel' }

/** Übergabe aus dem KI-Studio (AdStudio mode 'toDraft') */
interface StudioUebergabe { headline: string; message: string; imageUrl: string | null }

const bildMasse = (url: string): Promise<{ w: number; h: number }> => new Promise((resolve, reject) => {
  const img = new Image()
  img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
  img.onerror = () => reject(new Error('image'))
  img.src = url
})

function TextListe({ node, feld, label, werte, onChange, zaehler, mehrzeilig, max, disabled, hilfe }: {
  node: string; feld: string; label: string; werte: string[]; onChange: (w: string[]) => void
  zaehler?: number; mehrzeilig?: boolean; max: number; disabled: boolean; hilfe?: string
}) {
  const { t } = useTranslation()
  const liste = werte.length ? werte : ['']
  const setze = (i: number, v: string) => onChange(liste.map((x, j) => (j === i ? v : x)))
  return (
    <div id={feldId(feld)} className="scroll-mt-24 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-gray-500">{label}</span>
        <span className="text-[10px] text-gray-400">{t('crm.werbung.builder.anzeige.varianten', '{{n}} von {{max}}', { n: liste.length, max })}</span>
      </div>
      {hilfe && <p className="-mt-1 text-[10px] text-gray-400">{hilfe}</p>}
      {liste.map((w, i) => {
        const len = w.trim().length
        const zuLang = zaehler !== undefined && len > zaehler
        return (
          <div key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {mehrzeilig ? (
                <textarea value={w} rows={4} disabled={disabled} onChange={ev => setze(i, ev.target.value)}
                  aria-label={`${label} ${i + 1}`} className={`${INPUT_CLS} resize-y`} />
              ) : (
                <input value={w} disabled={disabled} onChange={ev => setze(i, ev.target.value)}
                  aria-label={`${label} ${i + 1}`} className={INPUT_CLS} />
              )}
              {zaehler !== undefined && (
                <span className={`mt-0.5 block text-right text-[10px] tabular-nums ${zuLang && !mehrzeilig ? 'font-semibold text-red-600' : 'text-gray-400'}`}>
                  {mehrzeilig
                    ? t('crm.werbung.builder.anzeige.sichtbar', '{{len}} Zeichen, sichtbar bis {{max}}', { len, max: zaehler })
                    : `${len} / ${zaehler}`}
                </span>
              )}
            </div>
            {liste.length > 1 && !disabled && (
              <button type="button" onClick={() => onChange(liste.filter((_, j) => j !== i))}
                aria-label={t('crm.werbung.builder.anzeige.varianteEntfernen', 'Variante {{n}} entfernen', { n: i + 1 })}
                className="mt-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">✕</button>
            )}
          </div>
        )
      })}
      {liste.length < max && !disabled && (
        <button type="button" onClick={() => onChange([...liste, ''])} className="text-xs font-semibold text-hp-navy hover:underline">
          + {t('crm.werbung.builder.anzeige.variante', 'Variante hinzufügen')}
        </button>
      )}
      <FeldHinweise node={node} felder={feld} />
    </div>
  )
}

export default function AnzeigenFormular({ adKey }: { adKey: string }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { e, katalog, vorgaben, schreibSperre, gepaart } = useAssistent()
  const [wahlOffen, setWahlOffen] = useState(false)
  const [uebernimmt, setUebernimmt] = useState(false)
  const [studioOffen, setStudioOffen] = useState(false)
  const [studioBild, setStudioBild] = useState<{ url: string; slot: 'feed_4x5' | 'story_9x16' } | null>(null)
  const { showToast } = useWerbeKontext()
  const { spec, nurLesen } = e
  const ad = spec.ads.find(x => x.key === adKey)
  if (!ad) return null
  const node = ad.key
  // Von diesem Entwurf schon bei Meta angelegt (Anzeige oder Werbemittel): Fortsetzen übernimmt keine Änderungen mehr
  const angelegt = !ad.existing_id && anzeigeAngelegt(e.metaIds, node)
  const gesperrt = nurLesen || angelegt
  const set = (patch: Partial<AdDraft>) => e.update(d => setzeAnzeige(d, node, patch, gepaart, e.metaIds))
  const adset = spec.adsets.find(a => a.key === ad.adset_key)
  const partner = gepaart ? paarPartner(spec, node) : undefined

  if (ad.existing_id) {
    return (
      <div className="space-y-3">
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.anzeige.bestehend', 'Diese Werbeanzeige besteht schon bei Meta (ID {{id}}) und bleibt unverändert.', { id: ad.existing_id })}
        </div>
        <div className="hp-card p-4"><LockedField label={feldLabel(t, 'ad.name', 'Name der Werbeanzeige')} value={ad.name} /></div>
      </div>
    )
  }

  const kindSoll: AdDestinationKind = adset?.destination === 'ON_AD' ? 'lead_form' : 'website'
  const kind: AdDestinationKind = ad.destination?.kind === 'lead_form' ? 'lead_form' : 'website'
  const ctas = ctaFor(kind)
  const istVideo = ad.format === 'single_video'
  const medienArt = istVideo ? 'video' : 'image'
  // Medien immer vom aktuellen Stand aus ändern (Uploads dauern, inzwischen kann sich anderes geändert haben)
  const aendereMedien = (fn: (m: AdDraft['media']) => AdDraft['media']) => e.update(d => {
    const cur = d.ads.find(x => x.key === node)
    return cur ? setzeAnzeige(d, node, { media: fn({ ...(cur.media ?? {}) }) }, gepaart, e.metaIds) : d
  })
  const setMedia = (slot: 'feed_4x5' | 'story_9x16' | 'square_1x1', ref: MediaRef | undefined) => aendereMedien(m => {
    if (ref) m[slot] = ref
    else delete m[slot]
    return m
  })
  const cards = ad.media?.cards ?? []
  const setCards = (next: CardDraft[]) => aendereMedien(m => ({ ...m, cards: next }))
  const setCardAt = (i: number, patch: Partial<CardDraft>) => aendereMedien(m => ({
    ...m, cards: (m.cards ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)),
  }))

  const setzeZielArt = (k: AdDestinationKind) => {
    const erlaubt = ctaFor(k)
    const cta: CtaType = erlaubt.indexOf(ad.cta_type) >= 0 ? ad.cta_type : (k === 'lead_form' ? 'SIGN_UP' : 'BOOK_NOW')
    set({
      destination: k === 'lead_form' ? { kind: 'lead_form', form_id: '' } : { kind: 'website', url: vorgaben.link || HP_DEFAULT_LINK },
      cta_type: cta,
    })
  }

  const seiten: SelectOption[] = (katalog?.pages ?? []).map(p => ({ value: p.id, label: p.name }))
  const igKonten: SelectOption[] = (katalog?.instagram_accounts ?? []).map(x => ({ value: x.id, label: x.username ? `@${x.username}` : (x.name ?? x.id) }))
  const formulare: SelectOption[] = (katalog?.lead_forms ?? [])
    .filter(f => !f.page_id || f.page_id === ad.identity?.page_id)
    .map(f => ({ value: f.id, label: f.name, hint: f.status }))

  // ── vorhandenes Werbemittel übernehmen ──────────────────────────────────
  const uebernehmen = async (w: WerbemittelAuswahl) => {
    setUebernimmt(true)
    try {
      if (w.quelle === 'anzeige') {
        try {
          const res = await builderCall('import', { level: 'ad', id: w.adId })
          const src = res.spec.ads[0]
          if (!src) throw new Error(t('crm.werbung.builder.anzeige.importLeer', 'Meta hat keine Anzeigendaten geliefert.'))
          const patch: Partial<AdDraft> = {
            format: src.format,
            primary_texts: (src.primary_texts ?? []).slice(0, LIMITS.textsPerKind),
            headlines: (src.headlines ?? []).slice(0, LIMITS.textsPerKind),
            descriptions: (src.descriptions ?? []).slice(0, LIMITS.textsPerKind),
            media: src.media ?? {},
            // Advantage+ Creative nie mitnehmen: bei HP alles aus, bis jemand bewusst einschaltet
            creative_features: {},
            source: { catalog_ad_id: w.adId },
          }
          if (ctaFor(kind).indexOf(src.cta_type) >= 0) patch.cta_type = src.cta_type
          set(patch)
          toast.success(t('crm.werbung.builder.anzeige.uebernommen', 'Werbemittel übernommen'))
          const quelleAn = CREATIVE_FEATURE_OPTIONS.filter(o => src.creative_features?.[o.value] === 'OPT_IN').map(o => t(o.labelKey, o.value))
          if (quelleAn.length) {
            toast.info(t('crm.werbung.builder.anzeige.funktionenNichtUebernommen', 'In der Vorlage waren diese Advantage+ Funktionen an und sind hier aus: {{liste}}. Bei Bedarf unter „Advantage+ Creative“ bewusst einschalten.', { liste: quelleAn.join(', ') }))
          }
          if (res.warnings?.length) toast.info(res.warnings.join(' '))
        } catch (err) {
          set({ source: { catalog_ad_id: w.adId } })
          toast.error(t('crm.werbung.builder.anzeige.importFehler', 'Texte und Medien konnten nicht übernommen werden: {{fehler}}', { fehler: fehlerText(err, t) }))
        }
        return
      }
      // Vorrat: Texte direkt, Medien über media_upload (nur mit Freischaltung)
      const format = (w.format && VORRAT_FORMAT[w.format]) || ad.format
      const patch: Partial<AdDraft> = {
        format,
        primary_texts: w.texte.primaer.slice(0, LIMITS.textsPerKind),
        headlines: w.texte.ueberschriften.slice(0, LIMITS.textsPerKind),
        descriptions: w.texte.beschreibungen.slice(0, LIMITS.textsPerKind),
        source: { pool_id: w.poolId },
        name: partner ? `${w.kennung}_${/_kurz$/.test(node) ? 'kurz' : 'lang'}` : w.kennung,
      }
      const cta = w.cta && (CTA_TYPES as readonly string[]).indexOf(w.cta) >= 0 ? (w.cta as CtaType) : null
      if (cta && ctaFor(kind).indexOf(cta) >= 0) patch.cta_type = cta
      if (w.lpUrl && kind === 'website' && !partner) patch.destination = { kind: 'website', url: w.lpUrl }
      const media: AdDraft['media'] = {}
      if (schreibSperre) {
        toast.info(t('crm.werbung.builder.anzeige.medienSpaeter', 'Texte übernommen. Die Medien lassen sich erst nach der Freischaltung durch Sven zu Meta laden.'))
      } else {
        const art = format === 'single_video' ? 'video' : 'image'
        const slots: Array<['feed_4x5' | 'story_9x16', string | null, '4:5' | '9:16']> = [['feed_4x5', w.feedUrl, '4:5'], ['story_9x16', w.storyUrl, '9:16']]
        for (const [slot, url, aspect] of slots) {
          const pfad = storagePfadAus(url)
          if (!pfad) continue
          try {
            const res = await builderCall('media_upload', {
              storage_path: pfad, kind: art, aspect, ai_generated: w.kiGeneriert,
              eu_band_confirmed: w.euBand, ki_label_confirmed: w.kiLabel,
            })
            e.setzeMedium(res.media)
            media[slot] = refAus(res.media)
          } catch (err) {
            toast.error(t('crm.werbung.builder.anzeige.medienFehler', 'Medium {{slot}} nicht übernommen: {{fehler}}', { slot: aspect, fehler: fehlerText(err, t) }))
          }
        }
      }
      if (Object.keys(media).length) patch.media = { ...(ad.media ?? {}), ...media }
      set(patch)
      toast.success(t('crm.werbung.builder.anzeige.uebernommen', 'Werbemittel übernommen'))
    } finally {
      setUebernimmt(false)
    }
  }

  // ── KI-Studio: Überschrift + Text in die erste Variante, Bild in den passenden Slot ──
  const vomStudio = async (d: StudioUebergabe) => {
    setStudioOffen(false)
    set({
      headlines: [d.headline, ...(ad.headlines ?? []).slice(1)],
      primary_texts: [d.message, ...(ad.primary_texts ?? []).slice(1)],
      format: ad.format === 'carousel' ? 'single_image' : ad.format,
      source: { studio: true },
    })
    toast.success(t('crm.werbung.builder.anzeige.studioUebernommen', 'Texte aus dem KI-Studio übernommen'))
    if (!d.imageUrl) return
    try {
      const m = await bildMasse(d.imageUrl)
      const asp = aspectOf(m.w, m.h)
      if (asp === '4:5' || asp === '9:16') setStudioBild({ url: d.imageUrl, slot: asp === '4:5' ? 'feed_4x5' : 'story_9x16' })
      else toast.info(t('crm.werbung.builder.anzeige.studioFormat', 'Das Studio-Bild ist {{format}}. Für die Anzeige im Studio 4:5 (Feed) oder 9:16 (Story) wählen.', { format: asp === 'other' ? `${m.w} × ${m.h}` : asp }))
    } catch {
      toast.error(t('crm.werbung.builder.medien.nichtLesbar', 'Die Datei lässt sich nicht lesen.'))
    }
  }
  // Adapter: Props des Studios für den Assistenten (mode 'toDraft')
  const studioZusatz = { mode: 'toDraft' as const, onDraft: (d: StudioUebergabe) => void vomStudio(d), aspectSelector: true }

  const features = ad.creative_features ?? {}
  const anzahlAn = CREATIVE_FEATURES.filter(f => features[f] === 'OPT_IN').length

  return (
    <div className="space-y-4">
      {angelegt && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.anzeige.angelegt', 'Diese Werbeanzeige ist schon bei Meta angelegt (ID {{id}}). Texte, Medien und Einstellungen lassen sich hier nicht mehr ändern.', { id: e.metaIds.ads?.[node] ?? e.metaIds.creatives?.[node] })}
        </div>
      )}
      {partner && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.anzeige.paar', 'Gekoppelt mit „{{partner}}“: Texte, Medien und Format gelten für beide. Nur die Landingpage unterscheidet sich.', { partner: partner.name || partner.key })}
        </div>
      )}

      <Abschnitt titel={t('crm.werbung.builder.anzeige.name', 'Name der Werbeanzeige')}>
        <TextFeld node={node} feld="ad.name" label={feldLabel(t, 'ad.name', 'Name der Werbeanzeige')}
          value={ad.name ?? ''} onChange={v => set({ name: v })} maxLen={400} disabled={gesperrt} />
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.anzeige.identitaet', 'Identität')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FeldRahmen node={node} feld="ad.identity.page_id" label={feldLabel(t, 'ad.identity.page_id', 'Facebook-Seite')}>
            {seiten.length ? (
              <div className="mt-0.5"><CustomSelect value={ad.identity?.page_id ?? ''} options={seiten} disabled={gesperrt}
                onChange={v => set({ identity: { ...ad.identity, page_id: v } })} /></div>
            ) : (
              <input value={ad.identity?.page_id ?? ''} disabled={gesperrt} className={INPUT_CLS}
                onChange={ev => set({ identity: { ...ad.identity, page_id: ev.target.value.trim() } })} />
            )}
          </FeldRahmen>
          <FeldRahmen node={node} feld="ad.identity.instagram_user_id" label={feldLabel(t, 'ad.identity.instagram_user_id', 'Instagram-Konto')}>
            {igKonten.length ? (
              <div className="mt-0.5"><CustomSelect value={ad.identity?.instagram_user_id ?? ''} options={igKonten} disabled={gesperrt}
                onChange={v => set({ identity: { ...ad.identity, instagram_user_id: v } })} /></div>
            ) : (
              <input value={ad.identity?.instagram_user_id ?? ''} disabled={gesperrt} className={INPUT_CLS}
                placeholder={t('crm.werbung.builder.anzeige.igId', 'Instagram-Konto-ID')}
                onChange={ev => set({ identity: { ...ad.identity, instagram_user_id: ev.target.value.trim() } })} />
            )}
          </FeldRahmen>
        </div>
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.anzeige.werbemittel', 'Werbemittel')}
        aktion={!gesperrt && (
          <span className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setStudioOffen(true)} disabled={uebernimmt}
              className="hp-btn hp-btn-ghost min-h-0 px-3 py-1.5 text-xs">
              {t('crm.werbung.builder.anzeige.studio', 'Mit KI-Studio entwerfen')}
            </button>
            <button type="button" onClick={() => setWahlOffen(true)} disabled={uebernimmt}
              className="hp-btn hp-btn-accent min-h-0 px-3 py-1.5 text-xs">
              {uebernimmt && <Spinner size="sm" />}
              {t('crm.werbung.builder.anzeige.vorhandenes', 'Vorhandenes übernehmen')}
            </button>
          </span>
        )}>
        {ad.source && (ad.source.catalog_ad_id || ad.source.pool_id) && (
          <p className="text-[11px] text-gray-500">
            {ad.source.pool_id
              ? t('crm.werbung.builder.anzeige.ausVorrat', 'Aus dem Vorrat übernommen.')
              : t('crm.werbung.builder.anzeige.ausAnzeige', 'Übernommen aus Anzeige {{id}}.', { id: ad.source.catalog_ad_id })}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <AuswahlFeld<AdFormat> node={node} feld="ad.format" label={feldLabel(t, 'ad.format', 'Format')}
            value={ad.format} optionen={AD_FORMAT_OPTIONS} disabled={gesperrt} onChange={v => v && set({ format: v })} />
        </div>
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.anzeige.medien', 'Medien')}
        hilfe={ad.format === 'carousel'
          ? t('crm.werbung.builder.anzeige.medienKarussell', '2 bis 10 Karten, quadratisch (1:1).')
          : t('crm.werbung.builder.anzeige.medienHilfe', '4:5 für Feeds, 9:16 für Stories und Reels. Ohne 9:16 nimmt Meta das 4:5-Medium überall.')}>
        {ad.format !== 'carousel' ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <MedienSlot node={node} feld="ad.media.feed_4x5" label={feldLabel(t, 'ad.media.feed_4x5', 'Medien für Feeds (4:5)')}
              aspect="4:5" kind={medienArt} value={ad.media?.feed_4x5} onChange={r => setMedia('feed_4x5', r)} disabled={gesperrt}
              vorlage={studioBild?.slot === 'feed_4x5' && !istVideo ? studioBild.url : null} vorlageKi onVorlageErledigt={() => setStudioBild(null)} />
            <MedienSlot node={node} feld="ad.media.story_9x16" label={feldLabel(t, 'ad.media.story_9x16', 'Medien für Stories und Reels (9:16)')}
              aspect="9:16" kind={medienArt} value={ad.media?.story_9x16} onChange={r => setMedia('story_9x16', r)} disabled={gesperrt}
              vorlage={studioBild?.slot === 'story_9x16' && !istVideo ? studioBild.url : null} vorlageKi onVorlageErledigt={() => setStudioBild(null)} />
          </div>
        ) : (
          <div id={feldId('ad.media.cards')} className="space-y-3">
            {cards.map((cd, i) => {
              const setCard = (patch: Partial<CardDraft>) => setCardAt(i, patch)
              return (
                <div key={i} className="space-y-2 rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="mr-auto text-xs font-semibold text-gray-700">{t('crm.werbung.builder.anzeige.karte', 'Karte {{n}}', { n: i + 1 })}</span>
                    {!gesperrt && (
                      <button type="button" onClick={() => setCards(cards.filter((_, j) => j !== i))} className="text-[11px] text-gray-500 hover:text-red-700">
                        {t('crm.werbung.builder.anzeige.karteEntfernen', 'Karte entfernen')}
                      </button>
                    )}
                  </div>
                  <MedienSlot node={node} feld="ad.media.cards" index={i} label={t('crm.werbung.builder.anzeige.karteMedium', 'Medium (1:1)')}
                    aspect="1:1" kind="image" value={cd.media?.media_id ? cd.media : undefined}
                    onChange={r => setCard({ media: r ?? { media_id: '' } })} disabled={gesperrt} />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="block text-[11px] text-gray-500">{feldLabel(t, 'ad.headlines', 'Überschrift')}
                      <input value={cd.headline ?? ''} disabled={gesperrt} onChange={ev => setCard({ headline: ev.target.value })} className={INPUT_CLS} />
                      <span className={`block text-right text-[10px] ${(cd.headline ?? '').trim().length > HEADLINE_MAX ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{(cd.headline ?? '').trim().length} / {HEADLINE_MAX}</span>
                    </label>
                    <label className="block text-[11px] text-gray-500">{feldLabel(t, 'ad.descriptions', 'Beschreibung')}
                      <input value={cd.description ?? ''} disabled={gesperrt} onChange={ev => setCard({ description: ev.target.value })} className={INPUT_CLS} />
                      <span className={`block text-right text-[10px] ${(cd.description ?? '').trim().length > DESCRIPTION_MAX ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{(cd.description ?? '').trim().length} / {DESCRIPTION_MAX}</span>
                    </label>
                    <label className="block text-[11px] text-gray-500 sm:col-span-2">{t('crm.werbung.builder.anzeige.karteUrl', 'Link der Karte (leer = Website-URL der Anzeige)')}
                      <input value={cd.url ?? ''} disabled={gesperrt} onChange={ev => setCard({ url: ev.target.value.trim() || undefined })} className={INPUT_CLS} />
                    </label>
                  </div>
                </div>
              )
            })}
            {cards.length < LIMITS.carouselMax && !gesperrt && (
              <button type="button" onClick={() => setCards([...cards, { headline: '', media: { media_id: '' } }])}
                className="text-xs font-semibold text-hp-navy hover:underline">+ {t('crm.werbung.builder.anzeige.karteNeu', 'Karte hinzufügen')}</button>
            )}
            <FeldHinweise node={node} felder="ad.media.cards" />
          </div>
        )}
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.anzeige.texte', 'Texte')}
        hilfe={t('crm.werbung.builder.anzeige.texteHilfe', 'Bis zu 5 Varianten je Feld, Meta kombiniert sie. Überschrift höchstens 40, Beschreibung höchstens 30 Zeichen (HP-Regel).')}>
        <TextListe node={node} feld="ad.primary_texts" label={feldLabel(t, 'ad.primary_texts', 'Primärer Text')}
          werte={ad.primary_texts ?? []} onChange={w => set({ primary_texts: w })} zaehler={PRIMARY_VISIBLE} mehrzeilig
          max={ad.format === 'carousel' ? 1 : LIMITS.textsPerKind} disabled={gesperrt}
          hilfe={t('crm.werbung.builder.anzeige.primaerHilfe', 'Die ersten 125 Zeichen sind ohne „Mehr anzeigen“ sichtbar: dort einen fertigen Gedanken liefern.')} />
        <TextListe node={node} feld="ad.headlines" label={feldLabel(t, 'ad.headlines', 'Überschrift')}
          werte={ad.headlines ?? []} onChange={w => set({ headlines: w })} zaehler={HEADLINE_MAX}
          max={ad.format === 'carousel' ? 1 : LIMITS.textsPerKind} disabled={gesperrt} />
        {ad.format !== 'carousel' && (
          <TextListe node={node} feld="ad.descriptions" label={feldLabel(t, 'ad.descriptions', 'Beschreibung')}
            werte={ad.descriptions ?? []} onChange={w => set({ descriptions: w.length === 1 && !w[0].trim() ? [] : w })}
            zaehler={DESCRIPTION_MAX} max={LIMITS.textsPerKind} disabled={gesperrt} />
        )}
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.anzeige.ziel', 'Ziel und Call-to-Action')}>
        <div id={feldId('ad.destination.kind')} className="flex flex-wrap gap-4 text-xs" role="radiogroup" aria-label={feldLabel(t, 'ad.destination.kind', 'Ziel')}>
          {(['website', 'lead_form'] as const).map(k => (
            <label key={k} className={`flex items-center gap-1.5 ${k !== kindSoll ? 'opacity-50' : ''}`}>
              <input type="radio" name={`ziel-${node}`} checked={kind === k} disabled={gesperrt || (k !== kindSoll && kind === kindSoll)}
                onChange={() => setzeZielArt(k)} />
              {t(`crm.werbung.meta.destination_kind.${k}`, k === 'website' ? 'Website' : 'Sofortformular')}
            </label>
          ))}
        </div>
        {kind !== kindSoll && (
          <p className="text-[11px] text-red-700">
            {t('crm.werbung.builder.anzeige.zielPasstNicht', 'Das Ziel passt nicht zum Conversion-Ort der Anzeigengruppe.')}
            {!gesperrt && (
              <button type="button" onClick={() => setzeZielArt(kindSoll)} className="ml-1 font-semibold underline">
                {t('crm.werbung.builder.anzeige.zielAnpassen', 'Anpassen')}
              </button>
            )}
          </p>
        )}
        <FeldHinweise node={node} felder="ad.destination.kind" />
        <div className="grid gap-3 sm:grid-cols-2">
          {ad.destination?.kind === 'website' ? (
            <>
              <TextFeld node={node} feld="ad.destination.url" label={feldLabel(t, 'ad.destination.url', 'Website-URL')}
                value={ad.destination.url ?? ''} disabled={gesperrt} maxLen={LIMITS.urlMax}
                onChange={v => set({ destination: { kind: 'website', url: v.trim(), ...(ad.destination.kind === 'website' && ad.destination.display_link ? { display_link: ad.destination.display_link } : {}) } })} />
              <TextFeld node={node} feld="ad.destination.display_link" label={feldLabel(t, 'ad.destination.display_link', 'Angezeigter Link')}
                value={ad.destination.display_link ?? ''} disabled={gesperrt}
                onChange={v => ad.destination.kind === 'website' && set({ destination: { ...ad.destination, display_link: v.trim() || undefined } })} />
            </>
          ) : (
            <FeldRahmen node={node} feld="ad.destination.form_id" label={feldLabel(t, 'ad.destination.form_id', 'Sofortformular')}>
              {formulare.length ? (
                <div className="mt-0.5"><CustomSelect value={ad.destination.kind === 'lead_form' ? ad.destination.form_id : ''} options={formulare} disabled={gesperrt}
                  onChange={v => set({ destination: { kind: 'lead_form', form_id: v } })} /></div>
              ) : (
                <input value={ad.destination.kind === 'lead_form' ? ad.destination.form_id : ''} disabled={gesperrt} className={INPUT_CLS}
                  placeholder={t('crm.werbung.builder.anzeige.formularId', 'Formular-ID')}
                  onChange={ev => set({ destination: { kind: 'lead_form', form_id: ev.target.value.trim() } })} />
              )}
            </FeldRahmen>
          )}
          <AuswahlFeld<CtaType> node={node} feld="ad.cta_type" label={feldLabel(t, 'ad.cta_type', 'Call-to-Action')}
            value={ad.cta_type} optionen={nurWerte(CTA_OPTIONS, ctas)} disabled={gesperrt} onChange={v => v && set({ cta_type: v })} />
        </div>
        <div id={feldId('ad.url_tags')}>
          <p className="text-[11px] text-gray-500">{feldLabel(t, 'ad.url_tags', 'URL-Parameter')}</p>
          <code className="mt-0.5 block break-all rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 text-[10px] text-gray-600">{URL_TAGS_STANDARD}</code>
          <p className="mt-0.5 text-[10px] text-gray-400">{t('crm.werbung.meta.help.ad_url_tags', 'Fester UTM-Standard, wird an jeden Link angehängt: Kampagne, Anzeigengruppe und Werbeanzeige als ID. Nicht änderbar.')}</p>
        </div>
      </Abschnitt>

      <Abschnitt titel={feldLabel(t, 'ad.creative_features', 'Advantage+ Creative')}
        hilfe={t('crm.werbung.meta.help.ad_creative_features', 'Metas automatische Anpassungen (KI-Bildbearbeitung, Textvarianten, Overlays). Bei Happy Property standardmäßig alle aus: Fotos bleiben echt, Texte bleiben unsere.')}
        aktion={<Badge tone={anzahlAn ? 'warning' : 'success'}>{anzahlAn
          ? t('crm.werbung.builder.anzeige.funktionenAn', '{{n}} an', { n: anzahlAn })
          : t('crm.werbung.builder.anzeige.alleAus', 'Alle aus')}</Badge>}>
        <details className="rounded-lg border border-gray-200">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-700">
            {t('crm.werbung.builder.anzeige.funktionenZeigen', 'Einzelne Funktionen anzeigen')}
          </summary>
          <ul className="divide-y divide-gray-100 border-t border-gray-100">
            {CREATIVE_FEATURE_OPTIONS.map(o => {
              const info = CREATIVE_FEATURE_INFO[o.value]
              return (
                <li key={o.value} className="flex items-center gap-2 px-3 py-1.5">
                  <Schalter checked={features[o.value] === 'OPT_IN'} disabled={gesperrt}
                    onChange={v => set({ creative_features: { ...features, [o.value]: v ? 'OPT_IN' : 'OPT_OUT' } })}
                    label={t(o.labelKey, o.value)} />
                  {info.ai && <Badge tone="warning">{t('crm.werbung.builder.anzeige.ki', 'KI')}</Badge>}
                  {!info.documented && <span className="text-[10px] text-gray-400">{t('crm.werbung.builder.anzeige.unbelegt', 'nicht offiziell dokumentiert')}</span>}
                </li>
              )
            })}
          </ul>
          {anzahlAn > 0 && !gesperrt && (
            <div className="border-t border-gray-100 px-3 py-2">
              <button type="button" onClick={() => set({ creative_features: {} })} className="text-xs font-semibold text-hp-navy hover:underline">
                {t('crm.werbung.builder.anzeige.allesAus', 'Alle ausschalten')}
              </button>
            </div>
          )}
        </details>
        <FeldHinweise node={node} felder="ad.creative_features" />
        <Schalter checked={ad.multi_advertiser === 'OPT_IN'} disabled={gesperrt}
          onChange={v => set({ multi_advertiser: v ? 'OPT_IN' : 'OPT_OUT' })}
          label={feldLabel(t, 'ad.multi_advertiser', 'Werbeanzeigen mit mehreren Werbetreibenden')}
          hilfe={t('crm.werbung.meta.help.ad_multi_advertiser', 'An: die Werbeanzeige kann zusammen mit Anzeigen anderer Werbetreibender gezeigt werden, auch der Konkurrenz. Standard aus.')} />
        <FeldHinweise node={node} felder="ad.multi_advertiser" />
      </Abschnitt>

      <WerbemittelWahl open={wahlOffen} onClose={() => setWahlOffen(false)} onPick={w => void uebernehmen(w)} />
      <Modal open={studioOffen} onClose={() => setStudioOffen(false)} size="xl" title={t('crm.werbung.builder.anzeige.studioTitel', 'KI-Studio: Entwurf für diese Anzeige')}>
        <p className="mb-3 text-xs text-gray-600">
          {t('crm.werbung.builder.anzeige.studioText', 'Im Studio entsteht nichts bei Meta. „Übernehmen“ setzt Überschrift, Text und Bild in diese Anzeige; das Bild braucht danach die beiden Bestätigungen.')}
        </p>
        <AdStudio showToast={showToast} onPublished={() => setStudioOffen(false)} {...studioZusatz} />
      </Modal>
    </div>
  )
}
