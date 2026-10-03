import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import AdStudio from '../../AdStudio'
import Badge from '../../../ui/Badge'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import {
  CREATIVE_FEATURES, CREATIVE_FEATURE_INFO, CREATIVE_FEATURE_OPTIONS, CTA_TYPES,
  HP_DEFAULT_LINK, LIMITS, aspectOf, ctaFor, hatSprachen, usesPlacementFeed,
  type AdDraft, type BeitragRef, type CardDraft, type CtaType, type MediaRef,
} from '../../../../lib/metaSpec'
import { DESCRIPTION_MAX, HEADLINE_MAX, PRIMARY_VISIBLE, lintText } from '../../../../lib/metaLint'
import { INPUT_CLS, LockedField } from '../felder'
import { FeldHinweise } from './PruefPanel'
import { Abschnitt, FeldRahmen, Schalter, StatusFeld, TextFeld, feldId, feldLabel } from './Bausteine'
import MedienSlot, { refMitSeiten, storagePfadAus } from './MedienSlot'
import WerbemittelWahl, { type WerbemittelAuswahl } from './WerbemittelWahl'
import FormatWahl, { type FormatWahlWert } from './FormatWahl'
import BeitragWahl from './BeitragWahl'
import { KarussellKarten, KarussellSchalter, KarussellSeitenFeld } from './KarussellEditor'
import TextListe from './TextListe'
import AnzeigeZiel from './AnzeigeZiel'
import SprachenAbschnitt from './SprachenAbschnitt'
import PartnerAbschnitt from './PartnerAbschnitt'
import TrackingAbschnitt from './TrackingAbschnitt'
import { builderCall, fehlerText } from './builderApi'
import { anzeigeAngelegt, creativeGeaendert, paarPartner, setzeAnzeige, useAssistent } from './useEntwurf'
import { EmpfohlenBadge, LernphaseBadge } from './bearbeitenHelfer'
import { hpVon, mitHp, type CreativeTausch } from './bearbeitenTypen'
import { useWerbeKontext } from '../useWerbeDaten'
import { CTA_STANDARD, karussellVon, zielArtenFuer, zielUmstellen, type KarussellSeiten } from './r23Typen'

type Medien = AdDraft['media']

// ── Werbeanzeige (Reihenfolge wie bei Meta) ──────────────────────────────────
// Name, Identität (Seite + Instagram-Konto), Werbemittel (Format: Einzelbild,
// Einzelvideo, Karussell, vorhandener Beitrag, Sammlung folgt; vorhandenes
// Werbemittel übernehmen; KI-Studio), Medien je Seitenverhältnis (4:5, 9:16,
// unter „Alle Einstellungen" 1:1 und 1,91:1) mit Zuschnitt, Video-
// Vorschaubild und Untertiteln, Karussell (2 bis 10 Karten, Reihenfolge,
// 1:1 oder 4:5, Endkarte), Texte (bis 5 Varianten je Feld, Zähler), Ziel und
// Call-to-Action (Website, Sofortformular, beides, WhatsApp, Anruf), Sprachen,
// Partnerschaftswerbung, Tracking, Advantage+ Creative (alles aus).
// Plan B: Änderungen gelten für beide Anzeigen des Paares (_lang und _kurz).
// Bearbeiten-Modus: laufende Anzeigen sind änderbar (Status, Name, Werbemittel).
// Ein geändertes Werbemittel geht als neues Creative an Meta: entweder an die
// bestehende Anzeige („ersetzen") oder als neue Anzeige, die alte wird pausiert
// („neue_anzeige", HP-Empfehlung); beides startet die Lernphase neu.
// Typen der neuen Felder: src/lib/metaSpec.ts (Runde 2, be-anzeige); Helfer: ./r23Typen.

const VORRAT_FORMAT: Record<string, AdDraft['format']> = { bild: 'single_image', video: 'single_video', karussell: 'carousel' }

/** Übergabe aus dem KI-Studio (AdStudio mode 'toDraft') */
interface StudioUebergabe { headline: string; message: string; imageUrl: string | null }

const bildMasse = (url: string): Promise<{ w: number; h: number }> => new Promise((resolve, reject) => {
  const img = new Image()
  img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
  img.onerror = () => reject(new Error('image'))
  img.src = url
})

const leereKarte = (): CardDraft => ({ headline: '', media: { media_id: '' } })
/** erste ausgefüllte Variante (Karussell: je Feld nur ein Text über allen Karten) */
const ersteVariante = (arr: string[] | undefined): string | undefined => (arr ?? []).find(x => (x ?? '').trim())
/** Karussell: Primärtext und Überschrift auf eine Variante kürzen, Beschreibung (je Karte) auf höchstens eine */
const textFuerKarussell = (quelle: Partial<Pick<AdDraft, 'primary_texts' | 'headlines' | 'descriptions'>>): Pick<AdDraft, 'primary_texts' | 'headlines' | 'descriptions'> => {
  const b = ersteVariante(quelle.descriptions)
  return { primary_texts: [ersteVariante(quelle.primary_texts) ?? ''], headlines: [ersteVariante(quelle.headlines) ?? ''], descriptions: b ? [b] : [] }
}
const SLOTS = ['feed_4x5', 'story_9x16', 'square_1x1', 'landscape_191x1'] as const

export default function AnzeigenFormular({ adKey }: { adKey: string }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { e, katalog, vorgaben, schreibSperre, gepaart, bearbeiten, sperre } = useAssistent()
  const [wahlOffen, setWahlOffen] = useState(false)
  const [beitragOffen, setBeitragOffen] = useState(false)
  const [uebernimmt, setUebernimmt] = useState(false)
  const [studioOffen, setStudioOffen] = useState(false)
  const [studioBild, setStudioBild] = useState<{ url: string; slot: 'feed_4x5' | 'story_9x16' } | null>(null)
  /** bewusst gewähltes Karussell-Format je Anzeige (gilt vor dem Format der hochgeladenen Karten) */
  const [kartenSeitenWahl, setKartenSeitenWahl] = useState<Record<string, KarussellSeiten>>({})
  const { showToast } = useWerbeKontext()
  const { spec, nurLesen } = e
  const ad0 = spec.ads.find(x => x.key === adKey)
  if (!ad0) return null
  const ad: AdDraft = ad0
  const node = ad.key
  const bestehend = !!ad.existing_id
  // Von diesem Entwurf schon bei Meta angelegt (Anzeige oder Werbemittel): Fortsetzen übernimmt keine Änderungen mehr
  const angelegt = !ad.existing_id && anzeigeAngelegt(e.metaIds, node)
  const gesperrt = nurLesen || angelegt
  const sp = (feld: string): string | undefined => (bearbeiten && bestehend ? sperre(node, feld) : undefined)
  // Anzeige aus einem bestehenden Beitrag (Bearbeiten): Texte und Medien bleiben fest
  const beitragSperre = sp('ad.primary_texts')
  const gesperrtWm = gesperrt || !!beitragSperre
  const set = (patch: Partial<AdDraft>) => e.update(d => setzeAnzeige(d, node, patch, gepaart, e.metaIds))
  const adset = spec.adsets.find(a => a.key === ad.adset_key)
  const partner = gepaart ? paarPartner(spec, node) : undefined

  if (bestehend && !bearbeiten) {
    return (
      <div className="space-y-3">
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.anzeige.bestehend', 'Diese Werbeanzeige besteht schon bei Meta (ID {{id}}) und bleibt unverändert.', { id: ad.existing_id })}
        </div>
        <div className="hp-card p-4"><LockedField label={feldLabel(t, 'ad.name', 'Name der Werbeanzeige')} value={ad.name} /></div>
      </div>
    )
  }

  const standardUrl = vorgaben.link || HP_DEFAULT_LINK
  const beitrag: BeitragRef | undefined = ad.beitrag
  const verboteneNamen = katalog?.lint_context?.forbidden_names ?? []
  // Der Beitragstext läuft unverändert als Anzeige: Projekt-/Bauträgernamen, Gedankenstriche usw. als Hinweis zeigen
  const beitragPruefung = beitrag?.text ? lintText(beitrag.text, 'ad.beitrag', { forbiddenNames: verboteneNamen }, node) : []
  const istKarussell = !beitrag && ad.format === 'carousel'
  const istVideo = ad.format === 'single_video'
  const medienArt = istVideo ? 'video' : 'image'
  const mitSprachen = hatSprachen(ad)
  const textMax = istKarussell || mitSprachen ? 1 : LIMITS.textsPerKind
  // Medien je Platzierung (asset_feed mit Regeln): Meta erlaubt dann nur eine Beschreibung (validateDraft descriptions_single)
  const platzMedien = usesPlacementFeed(ad, adset?.placements)

  // Medien immer vom aktuellen Stand aus ändern (Uploads dauern, inzwischen kann sich anderes geändert haben)
  const aendereMedien = (fn: (m: Medien) => Medien) => e.update(d => {
    const cur = d.ads.find(x => x.key === node)
    return cur ? setzeAnzeige(d, node, { media: fn({ ...(cur.media ?? {}) }) }, gepaart, e.metaIds) : d
  })
  type SlotKey = typeof SLOTS[number]
  const setMedia = (slot: SlotKey, ref: MediaRef | undefined) => aendereMedien(m => {
    if (ref) m[slot] = ref
    else delete m[slot]
    return m
  })
  const cards: CardDraft[] = ad.media?.cards ?? []
  const aendereKarten = (fn: (c: CardDraft[]) => CardDraft[]) => aendereMedien(m => ({ ...m, cards: fn(m.cards ?? []) }))
  // Ohne eigene Wahl (z. B. nach dem Laden) aus den Medien der Karten ableiten
  const kartenSeiten: KarussellSeiten = kartenSeitenWahl[node]
    ?? (cards.some(c => c.media?.aspect === '4:5') ? '4:5' : '1:1')
  const setzeKartenSeiten = (s: KarussellSeiten) => {
    setKartenSeitenWahl(w => ({ ...w, [node]: s }))
    if (cards.some(c => c.media?.media_id && c.media.aspect && c.media.aspect !== s)) {
      toast.info(t('crm.werbung.builder.karussell.neuHochladen', 'Karten im anderen Format bitte neu hochladen oder zuschneiden.'))
    }
  }

  // Quellen zum Zuschneiden: alle Bilder dieser Anzeige
  const slotLabel: Record<SlotKey, string> = {
    feed_4x5: feldLabel(t, 'ad.media.feed_4x5', 'Medien für Feeds (4:5)'),
    story_9x16: feldLabel(t, 'ad.media.story_9x16', 'Medien für Stories und Reels (9:16)'),
    square_1x1: feldLabel(t, 'ad.media.square_1x1', 'Quadratisch (1:1)'),
    landscape_191x1: feldLabel(t, 'ad.media.landscape_191x1', istVideo ? 'Querformat (16:9)' : 'Querformat (1,91:1)'),
  }
  const quellenFuer = (slot: SlotKey) => {
    const out: Array<{ label: string; ref: MediaRef }> = []
    for (const k of SLOTS) {
      const ref = ad.media?.[k]
      if (k !== slot && ref?.media_id) out.push({ label: slotLabel[k], ref })
    }
    return out
  }

  const seiten: SelectOption[] = (katalog?.pages ?? []).map(p => ({ value: p.id, label: p.name }))
  const igKonten: SelectOption[] = (katalog?.instagram_accounts ?? []).map(x => ({ value: x.id, label: x.username ? `@${x.username}` : (x.name ?? x.id) }))
  const formulare: SelectOption[] = (katalog?.lead_forms ?? [])
    .filter(f => !f.page_id || f.page_id === ad.identity?.page_id)
    .map(f => ({ value: f.id, label: f.name, hint: f.status }))

  const ctaPasst = (c: string): boolean => ctaFor(ad.destination?.kind ?? 'website').some(x => x === c)

  // ── Format / vorhandener Beitrag ────────────────────────────────────────
  const formatWert: FormatWahlWert = beitrag ? 'beitrag' : ad.format
  const setzeFormat = (f: FormatWahlWert) => {
    if (f === 'beitrag') { setBeitragOffen(true); return }
    if (f === 'collection') return
    const p: Partial<AdDraft> = { format: f, beitrag: undefined }
    if (f === 'carousel') {
      if (!cards.length) p.media = { ...(ad.media ?? {}), cards: [leereKarte(), leereKarte()] }
      // Karussell: ein Primärtext und eine Überschrift über allen Karten (sonst Fehler ohne sichtbares Feld)
      Object.assign(p, textFuerKarussell(ad))
    }
    set(p)
  }
  const beitragGewaehlt = (b: BeitragRef, typ: string | null) => {
    const video = /video|reel/i.test(typ ?? '')
    // Texte kommen aus dem Beitrag: eigene Texte leeren (sonst prüft die Kontrolle unsichtbare Felder)
    const p: Partial<AdDraft> = { beitrag: b, format: video ? 'single_video' : 'single_image', primary_texts: [''], headlines: [''], descriptions: [] }
    // Beiträge: Facebook nur Website, Instagram Website oder WhatsApp
    const kind = ad.destination?.kind
    const ok = kind === 'website' || (b.quelle === 'instagram' && kind === 'whatsapp')
    if (!ok) {
      p.destination = zielUmstellen(ad.destination, 'website', standardUrl)
      if (ctaFor('website').indexOf(ad.cta_type) < 0) p.cta_type = CTA_STANDARD.website
    }
    set(p)
    toast.success(t('crm.werbung.builder.beitrag.gewaehlt', 'Beitrag übernommen'))
    if (zielArtenFuer(adset?.destination).indexOf('website') < 0 && !(b.quelle === 'instagram' && zielArtenFuer(adset?.destination).indexOf('whatsapp') >= 0)) {
      toast.info(t('crm.werbung.builder.beitrag.ortPasstNicht', 'Beiträge laufen nur mit dem Conversion-Ort Website (Instagram auch WhatsApp). Bitte den Conversion-Ort der Anzeigengruppe anpassen.'))
    }
  }

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
            beitrag: src.beitrag,
            karussell: src.karussell,
            // Advantage+ Creative nie mitnehmen: bei HP alles aus, bis jemand bewusst einschaltet
            creative_features: {},
            source: { catalog_ad_id: w.adId },
          }
          if (ctaPasst(src.cta_type)) patch.cta_type = src.cta_type
          if (src.format === 'carousel' && !src.beitrag) Object.assign(patch, textFuerKarussell(patch))
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
      const format: AdDraft['format'] = (w.format && VORRAT_FORMAT[w.format]) || (ad.format === 'collection' ? 'single_image' : ad.format)
      const patch: Partial<AdDraft> = {
        format,
        beitrag: undefined,
        primary_texts: w.texte.primaer.slice(0, LIMITS.textsPerKind),
        headlines: w.texte.ueberschriften.slice(0, LIMITS.textsPerKind),
        descriptions: w.texte.beschreibungen.slice(0, LIMITS.textsPerKind),
        source: { pool_id: w.poolId },
        name: partner ? `${w.kennung}_${/_kurz$/.test(node) ? 'kurz' : 'lang'}` : w.kennung,
      }
      const cta = w.cta && (CTA_TYPES as readonly string[]).indexOf(w.cta) >= 0 ? (w.cta as CtaType) : null
      if (cta && ctaPasst(cta)) patch.cta_type = cta
      if (w.lpUrl && ad.destination?.kind === 'website' && !partner) patch.destination = { kind: 'website', url: w.lpUrl }
      const media: Medien = {}
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
            media[slot] = refMitSeiten(res.media, aspect)
          } catch (err) {
            toast.error(t('crm.werbung.builder.anzeige.medienFehler', 'Medium {{slot}} nicht übernommen: {{fehler}}', { slot: aspect, fehler: fehlerText(err, t) }))
          }
        }
      }
      if (Object.keys(media).length) patch.media = { ...(ad.media ?? {}), ...media }
      if (format === 'carousel') Object.assign(patch, textFuerKarussell(patch))
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
      format: ad.format === 'carousel' || ad.format === 'collection' || beitrag ? 'single_image' : ad.format,
      beitrag: undefined,
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

  // Bearbeiten: Werbemittel tauschen (neues Creative an dieselbe Anzeige oder neue Anzeige)
  const tauschZeigen = bearbeiten && bestehend
  const tausch: CreativeTausch = hpVon(spec).creative_tausch ?? 'neue_anzeige'
  const geaendert = tauschZeigen ? creativeGeaendert(e.original, spec, node) : null
  const setzeTausch = (v: CreativeTausch) => e.update(d => mitHp(d, { creative_tausch: v }))

  const medienSlot = (slot: SlotKey, aspect: '4:5' | '9:16' | '1:1' | '1.91:1', hilfe?: string) => (
    <MedienSlot node={node} feld={`ad.media.${slot}`} label={slotLabel[slot]} hilfe={hilfe}
      aspect={aspect} kind={medienArt} value={ad.media?.[slot]} onChange={x => setMedia(slot, x)} disabled={gesperrtWm}
      quellen={quellenFuer(slot)}
      vorlage={(slot === 'feed_4x5' || slot === 'story_9x16') && studioBild?.slot === slot && !istVideo ? studioBild.url : null}
      vorlageKi onVorlageErledigt={() => setStudioBild(null)} />
  )

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

      {tauschZeigen && (
        <Abschnitt titel={t('crm.werbung.bearbeiten.tausch.titel', 'Werbemittel tauschen')}
          hilfe={t('crm.werbung.bearbeiten.tausch.hilfe', 'Gilt, sobald du Texte, Medien, Link, Button oder Identität änderst. Name und Status ändern nichts am Werbemittel.')}
          aktion={geaendert ? <LernphaseBadge /> : undefined}>
          {geaendert === true && (
            <p className="text-[11px] font-semibold text-amber-800">{t('crm.werbung.bearbeiten.tausch.geaendert', 'Das Werbemittel ist geändert: bei Meta entsteht ein neues Werbemittel.')}</p>
          )}
          <div id={feldId('ad.creative_tausch')} data-einstellung={t('crm.werbung.bearbeiten.tausch.titel', 'Werbemittel tauschen')}
            role="radiogroup" aria-label={t('crm.werbung.bearbeiten.tausch.titel', 'Werbemittel tauschen')} className="grid gap-2 sm:grid-cols-2">
            {([
              ['neue_anzeige', t('crm.werbung.bearbeiten.tausch.neu', 'Neue Anzeige, alte pausieren'), t('crm.werbung.bearbeiten.tausch.neuText', 'Die neue Anzeige startet ohne Verlauf, die alte wird pausiert (nicht gelöscht). Die Zahlen bleiben je Werbemittel sauber getrennt, so rechnet auch der Qualitäts-Autopilot.')],
              ['ersetzen', t('crm.werbung.bearbeiten.tausch.ersetzen', 'In der bestehenden Anzeige ersetzen'), t('crm.werbung.bearbeiten.tausch.ersetzenText', 'Anzeige-ID und Berichtsverlauf bleiben, Meta prüft die Anzeige neu. Alte und neue Zahlen mischen sich, Reaktionen am alten Beitrag gehen nicht mit.')],
            ] as const).map(([v, titel, text]) => {
              const aktiv = tausch === v
              return (
                <button key={v} type="button" role="radio" aria-checked={aktiv} disabled={gesperrt} onClick={() => setzeTausch(v)}
                  className={`rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:opacity-60 ${aktiv ? 'border-hp-navy bg-hp-navy/5 ring-1 ring-hp-navy' : 'border-gray-200 bg-white hover:border-hp-navy/40'}`}>
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-hp-navy">{titel}{v === 'neue_anzeige' && <EmpfohlenBadge />}</span>
                  <span className="mt-0.5 block leading-snug text-gray-600">{text}</span>
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-amber-800">{t('crm.werbung.bearbeiten.tausch.lernphase', 'In beiden Fällen startet die Lernphase der Anzeigengruppe neu (etwa 50 Ergebnisse pro Woche nötig).')}</p>
        </Abschnitt>
      )}

      <Abschnitt titel={t('crm.werbung.builder.anzeige.name', 'Name der Werbeanzeige')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextFeld node={node} feld="ad.name" label={feldLabel(t, 'ad.name', 'Name der Werbeanzeige')}
              hilfe={t('crm.werbung.bearbeiten.hilfe.anzeigeName', 'Nur intern sichtbar. Die Kennung (z. B. werbemittel3_lang) hilft beim Zuordnen der Leads.')}
              value={ad.name ?? ''} onChange={v => set({ name: v })} maxLen={400} disabled={gesperrt} />
          </div>
          {bearbeiten && bestehend && (
            <StatusFeld node={node} feld="ad.status" value={ad.status} disabled={gesperrt} onChange={v => set({ status: v })} />
          )}
        </div>
      </Abschnitt>

      {beitragSperre && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-xs text-hp-navy">🔒 {beitragSperre}</div>
      )}

      <Abschnitt titel={t('crm.werbung.builder.anzeige.identitaet', 'Identität')}
        hilfe={t('crm.werbung.builder.anzeige.identitaetHilfe', 'Unter diesem Namen erscheint die Anzeige auf Facebook und Instagram.')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FeldRahmen node={node} feld="ad.identity.page_id" label={feldLabel(t, 'ad.identity.page_id', 'Facebook-Seite')} sperre={sp('ad.identity.page_id')}>
            {seiten.length ? (
              <div className="mt-0.5"><CustomSelect value={ad.identity?.page_id ?? ''} options={seiten} disabled={gesperrtWm || !!sp('ad.identity.page_id')}
                onChange={v => set({ identity: { ...ad.identity, page_id: v } })} /></div>
            ) : (
              <input value={ad.identity?.page_id ?? ''} disabled={gesperrtWm || !!sp('ad.identity.page_id')} className={INPUT_CLS} aria-label={feldLabel(t, 'ad.identity.page_id', 'Facebook-Seite')}
                onChange={ev => set({ identity: { ...ad.identity, page_id: ev.target.value.trim() } })} />
            )}
          </FeldRahmen>
          <FeldRahmen node={node} feld="ad.identity.instagram_user_id" label={feldLabel(t, 'ad.identity.instagram_user_id', 'Instagram-Konto')}>
            {igKonten.length ? (
              <div className="mt-0.5"><CustomSelect value={ad.identity?.instagram_user_id ?? ''} options={igKonten} disabled={gesperrtWm}
                onChange={v => set({ identity: { ...ad.identity, instagram_user_id: v } })} /></div>
            ) : (
              <input value={ad.identity?.instagram_user_id ?? ''} disabled={gesperrtWm} className={INPUT_CLS}
                placeholder={t('crm.werbung.builder.anzeige.igId', 'Instagram-Konto-ID')}
                onChange={ev => set({ identity: { ...ad.identity, instagram_user_id: ev.target.value.trim() } })} />
            )}
          </FeldRahmen>
        </div>
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.anzeige.werbemittel', 'Werbemittel')}
        hilfe={t('crm.werbung.builder.anzeige.werbemittelHilfe', 'Neue Anzeige gestalten oder einen vorhandenen Beitrag bewerben.')}
        aktion={!gesperrtWm && (
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
        <FormatWahl node={node} value={formatWert} onChange={setzeFormat} disabled={gesperrtWm} sperre={sp('ad.format')} />
        {beitrag && (
          <div id={feldId('ad.beitrag')} className="flex scroll-mt-24 flex-wrap items-start gap-3 rounded-lg border border-gray-200 p-3">
            <span className="h-20 w-16 shrink-0 overflow-hidden rounded bg-gray-100">
              {beitrag.vorschau_url && <img src={beitrag.vorschau_url} alt="" className="h-full w-full object-cover" />}
            </span>
            <span className="min-w-0 flex-1 space-y-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone="info">{beitrag.quelle === 'instagram' ? 'Instagram' : 'Facebook'}</Badge>
                <span className="text-[10px] text-gray-500">{t('crm.werbung.builder.beitrag.id', 'Beitrag {{id}}', { id: beitrag.id })}</span>
              </span>
              <span className="line-clamp-3 block text-[11px] leading-snug text-gray-700">{beitrag.text ?? t('crm.werbung.builder.beitrag.ohneText', 'Ohne Text')}</span>
              {beitragPruefung.length > 0 && (
                <span role="note" className="block space-y-0.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-900">
                  <span className="block font-semibold">{t('crm.werbung.builder.beitrag.pruefTitel', 'Der Beitragstext läuft unverändert als Anzeige. Bitte prüfen:')}</span>
                  {beitragPruefung.map((l, i) => (
                    <span key={`${l.rule}-${i}`} className="block">{t(l.messageKey, l.rule, { ...(l.params ?? {}), match: l.match ?? '' })}</span>
                  ))}
                </span>
              )}
              <span className="flex flex-wrap gap-3 text-[11px]">
                {beitrag.permalink && (
                  <a href={beitrag.permalink} target="_blank" rel="noopener noreferrer" className="font-semibold text-hp-navy underline">
                    {t('crm.werbung.builder.vorschau.beitragAnsehen', 'Beitrag ansehen')}
                  </a>
                )}
                {!gesperrtWm && (
                  <button type="button" onClick={() => setBeitragOffen(true)} className="font-semibold text-hp-navy underline">
                    {t('crm.werbung.builder.beitrag.anderer', 'Anderen Beitrag wählen')}
                  </button>
                )}
              </span>
            </span>
          </div>
        )}
        <FeldHinweise node={node} felder="ad.beitrag" />
      </Abschnitt>

      {!beitrag && ad.format !== 'collection' && (
        istKarussell ? (
          <Abschnitt id={feldId('ad.karussell')} titel={t('crm.werbung.builder.anzeige.medien', 'Medien')}
            hilfe={t('crm.werbung.builder.karussell.hilfe', '2 bis 10 Karten, alle im gleichen Format. Instagram zeigt höchstens 5 Karten.')}
            alleOffen={e.issues.some(i => i.node === node && (i.field === 'ad.karussell.endkarte' || i.field === 'ad.karussell.reihenfolge_automatisch'))}
            alle={<KarussellSchalter optionen={karussellVon(ad)} disabled={gesperrtWm} onChange={o => set({ karussell: o })} />}>
            <KarussellSeitenFeld seiten={kartenSeiten} onChange={setzeKartenSeiten} disabled={gesperrtWm} />
            <KarussellKarten node={node} cards={cards} seiten={kartenSeiten} onCards={aendereKarten} disabled={gesperrtWm} />
            <FeldHinweise node={node} felder={['ad.media.crops', 'ad.karussell.endkarte', 'ad.karussell.reihenfolge_automatisch']} />
          </Abschnitt>
        ) : (
          <Abschnitt id={feldId('ad.media.crops')} titel={t('crm.werbung.builder.anzeige.medien', 'Medien')}
            hilfe={t('crm.werbung.builder.anzeige.medienHilfe', '4:5 für Feeds, 9:16 für Stories und Reels. Ohne 9:16 nimmt Meta das 4:5-Medium überall.')}
            alleOffen={!!ad.media?.square_1x1 || !!ad.media?.landscape_191x1}
            alle={(
              <div className="grid gap-3 lg:grid-cols-2">
                {medienSlot('square_1x1', '1:1', t('crm.werbung.builder.medien.quadratHilfe', 'Für rechte Spalte, Marketplace und Suche. Ohne eigenes Medium nimmt Meta das Feed-Medium.'))}
                {medienSlot('landscape_191x1', '1.91:1', istVideo
                  ? t('crm.werbung.builder.medien.querVideoHilfe', 'Für In-Stream und Audience Network. Optional.')
                  : t('crm.werbung.builder.medien.querHilfe', 'Für Suche, rechte Spalte und Audience Network. Optional.'))}
              </div>
            )}>
            <div className="grid gap-3 lg:grid-cols-2">
              {medienSlot('feed_4x5', '4:5')}
              {medienSlot('story_9x16', '9:16')}
            </div>
            <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.medien.zuschnittHilfe', 'Bild in anderem Format? Hochladen und den Ausschnitt wählen, oder ein anderes Bild dieser Anzeige zuschneiden.')}</p>
            <FeldHinweise node={node} felder={['ad.media.crops', 'ad.media.thumbnail', 'ad.media.untertitel']} />
          </Abschnitt>
        )
      )}

      {beitrag ? (
        <Abschnitt titel={t('crm.werbung.builder.anzeige.texte', 'Texte')}>
          <p className="text-[11px] text-gray-600">{t('crm.werbung.builder.beitrag.texte', 'Texte und Medien kommen aus dem Beitrag. Ändern geht nur am Beitrag selbst.')}</p>
        </Abschnitt>
      ) : (
        <Abschnitt titel={t('crm.werbung.builder.anzeige.texte', 'Texte')}
          hilfe={istKarussell
            ? t('crm.werbung.builder.anzeige.texteKarussell', 'Ein Primärtext und eine Überschrift über allen Karten. Jede Karte hat zusätzlich eigene Überschrift und Beschreibung.')
            : mitSprachen
              ? t('crm.werbung.builder.anzeige.texteSprachen', 'Mit mehreren Sprachen gilt je Sprache ein Text. Englisch steht unter „Sprachen“.')
              : platzMedien
                ? t('crm.werbung.builder.anzeige.texteHilfePlatz', 'Bis zu 5 Primärtexte und Überschriften. Mit eigenen Medien je Platzierung erlaubt Meta nur eine Beschreibung. Überschrift höchstens 40, Beschreibung höchstens 30 Zeichen (HP-Regel).')
                : t('crm.werbung.builder.anzeige.texteHilfe2', 'Bis zu 5 Varianten je Feld, Meta zeigt jeder Person die passende Kombination. Überschrift höchstens 40, Beschreibung höchstens 30 Zeichen (HP-Regel).')}>
          <TextListe node={node} feld="ad.primary_texts" label={feldLabel(t, 'ad.primary_texts', 'Primärer Text')}
            werte={ad.primary_texts ?? []} onChange={w => set({ primary_texts: w })} zaehler={PRIMARY_VISIBLE} mehrzeilig
            max={textMax} disabled={gesperrtWm}
            hilfe={t('crm.werbung.builder.anzeige.primaerHilfe', 'Die ersten 125 Zeichen sind ohne „Mehr anzeigen“ sichtbar: dort einen fertigen Gedanken liefern.')} />
          <TextListe node={node} feld="ad.headlines" label={feldLabel(t, 'ad.headlines', 'Überschrift')}
            werte={ad.headlines ?? []} onChange={w => set({ headlines: w })} zaehler={HEADLINE_MAX}
            max={textMax} disabled={gesperrtWm}
            hilfe={istKarussell
              ? t('crm.werbung.builder.anzeige.ueberschriftKarussell', 'Überschrift des Karussells als Ganzes, höchstens 40 Zeichen (HP-Regel). Die Karten haben eigene Überschriften.')
              : t('crm.werbung.bearbeiten.hilfe.ueberschrift', 'Kurz und konkret, höchstens 40 Zeichen (HP-Regel).')} />
          {!istKarussell && (
            <TextListe node={node} feld="ad.descriptions" label={feldLabel(t, 'ad.descriptions', 'Beschreibung')}
              werte={ad.descriptions ?? []} onChange={w => set({ descriptions: w.length === 1 && !w[0].trim() ? [] : w })}
              hilfe={t('crm.werbung.bearbeiten.hilfe.beschreibung', 'Kleine Zeile unter der Überschrift, nur in manchen Platzierungen sichtbar. Optional.')}
              zaehler={DESCRIPTION_MAX} max={platzMedien ? 1 : textMax} disabled={gesperrtWm} />
          )}
        </Abschnitt>
      )}

      <AnzeigeZiel ad={ad} node={node} adsetDestination={adset?.destination} adsetWhatsapp={adset?.promoted_object?.whatsapp_phone_number}
        setze={set} disabled={gesperrtWm} formulare={formulare} standardUrl={standardUrl} />

      <SprachenAbschnitt ad={ad} node={node} setze={set} disabled={gesperrtWm} />

      <PartnerAbschnitt ad={ad} node={node} setze={set} disabled={gesperrtWm} />

      <TrackingAbschnitt ad={ad} node={node} setze={set} disabled={gesperrt} adsetPixel={adset?.promoted_object?.pixel_id} />

      <Abschnitt titel={feldLabel(t, 'ad.creative_features', 'Advantage+ Creative')}
        hilfe={t('crm.werbung.meta.help.ad_creative_features', 'Metas automatische Anpassungen (KI-Bildbearbeitung, Textvarianten, Overlays). Bei Happy Property standardmäßig alle aus: Fotos bleiben echt, Texte bleiben unsere.')}
        aktion={<Badge tone={anzahlAn ? 'warning' : 'success'}>{anzahlAn
          ? t('crm.werbung.builder.anzeige.funktionenAn', '{{n}} an', { n: anzahlAn })
          : t('crm.werbung.builder.anzeige.alleAus', 'Alle aus')}</Badge>}
        alleOffen={anzahlAn > 0 || e.lint.some(l => l.node === node && l.field === 'ad.creative_features')}
        alle={(
          <div className="space-y-2">
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100">
            {CREATIVE_FEATURE_OPTIONS.map(o => {
              const info = CREATIVE_FEATURE_INFO[o.value]
              return (
                <li key={o.value} className="flex items-center gap-2 px-3 py-1.5">
                  <Schalter checked={features[o.value] === 'OPT_IN'} disabled={gesperrtWm}
                    onChange={v => set({ creative_features: { ...features, [o.value]: v ? 'OPT_IN' : 'OPT_OUT' } })}
                    label={t(o.labelKey, o.value)} />
                  {info.ai && <Badge tone="warning">{t('crm.werbung.builder.anzeige.ki', 'KI')}</Badge>}
                  {!info.documented && <span className="text-[10px] text-gray-400">{t('crm.werbung.builder.anzeige.unbelegt', 'nicht offiziell dokumentiert')}</span>}
                </li>
              )
            })}
          </ul>
          <Schalter checked={ad.multi_advertiser === 'OPT_IN'} disabled={gesperrtWm} empfohlen={ad.multi_advertiser !== 'OPT_IN'}
            onChange={v => set({ multi_advertiser: v ? 'OPT_IN' : 'OPT_OUT' })}
            label={feldLabel(t, 'ad.multi_advertiser', 'Werbeanzeigen mit mehreren Werbetreibenden')}
            hilfe={t('crm.werbung.meta.help.ad_multi_advertiser', 'An: die Werbeanzeige kann zusammen mit Anzeigen anderer Werbetreibender gezeigt werden, auch der Konkurrenz. Standard aus.')} />
          <FeldHinweise node={node} felder="ad.multi_advertiser" />
          </div>
        )}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-700" data-einstellung={feldLabel(t, 'ad.creative_features', 'Advantage+ Creative')}>
          {anzahlAn === 0
            ? <><span>{t('crm.werbung.bearbeiten.creativeAus', 'Alle automatischen Anpassungen sind aus.')}</span><EmpfohlenBadge /></>
            : <span className="text-amber-800">{t('crm.werbung.bearbeiten.creativeAn', '{{n}} automatische Anpassungen sind an. Meta verändert dann Bilder oder Texte selbst.', { n: anzahlAn })}</span>}
          {anzahlAn > 0 && !gesperrtWm && (
            <button type="button" onClick={() => set({ creative_features: {} })} className="font-semibold text-hp-navy underline">
              {t('crm.werbung.builder.anzeige.allesAus', 'Alle ausschalten')}
            </button>
          )}
        </div>
        <FeldHinweise node={node} felder="ad.creative_features" />
      </Abschnitt>

      <WerbemittelWahl open={wahlOffen} onClose={() => setWahlOffen(false)} onPick={w => void uebernehmen(w)} />
      <BeitragWahl open={beitragOffen} onClose={() => setBeitragOffen(false)} onPick={beitragGewaehlt}
        pageId={ad.identity?.page_id ?? ''} igUserId={ad.identity?.instagram_user_id ?? ''} verboteneNamen={verboteneNamen} />
      <Modal open={studioOffen} onClose={() => setStudioOffen(false)} size="xl" title={t('crm.werbung.builder.anzeige.studioTitel', 'KI-Studio: Entwurf für diese Anzeige')}>
        <p className="mb-3 text-xs text-gray-600">
          {t('crm.werbung.builder.anzeige.studioText', 'Im Studio entsteht nichts bei Meta. „Übernehmen“ setzt Überschrift, Text und Bild in diese Anzeige; das Bild braucht danach die beiden Bestätigungen.')}
        </p>
        <AdStudio showToast={showToast} onPublished={() => setStudioOffen(false)} {...studioZusatz} />
      </Modal>
    </div>
  )
}
