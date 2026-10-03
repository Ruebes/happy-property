import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../../lib/supabase'
import {
  DESTINATION_OPTIONS, HP_DEFAULT_LINK, HP_PAGE_ID, HP_PIXEL_ID, HOUSING_AGE_MAX, HOUSING_AGE_MIN, LIMITS, META_SPEC_VERSION,
  PLAN_B_LP_KURZ, PLAN_B_LP_LANG,
  adsetByKey, applyHousing, attributionFor, billingFor, cleanName, destinationsFor, editDiff, editLocks, emptyAd, goalsFor,
  promotedAllowed, promotedRuleFor, validateDraft, validateEditFields,
  type ActivateDraftResponse, type AdDraft, type EditApplyResponse, type EditDiffResponse, type EditDiffResult, type AdsetDraft, type CatalogResponse, type CreateResponse, type Destination,
  type DraftIssue, type DraftKind, type DraftLastError, type DraftMetaIds, type DraftSpec, type DraftStatus,
  type DraftValidation, type HousingResult, type MediaRef, type MetaMediaRow, type Objective, type PromotedObject,
  type SprachVariante,
} from '../../../../lib/metaSpec'
import { lintDraft, type LintIssue, type LintMediaInfo } from '../../../../lib/metaLint'
import { ladeUsdProEur } from '../useWerbeDaten'
import { USD_PRO_EUR_FALLBACK } from '../felder'
import { builderCall, type BuilderVorgaben } from './builderApi'
import { hpVon, istGesperrt, mitHp, oberflaechenSperren, zielAusMetaIds, type EditZiel } from './bearbeitenTypen'

// ── Ein Entwurf des Kampagnen-Assistenten (meta_drafts) ──────────────────────
// Lädt bzw. legt den Entwurf an, speichert 1,5 s nach der letzten Änderung
// (nur die erlaubten Inhaltsspalten), prüft sofort lokal (validateDraft +
// lintDraft) und kapselt die meta-builder-Aufrufe: validate, create/resume
// (Schleife mit Fortschritt), activate_draft, discard.
// Sonderkategorie Wohnen wird bei jeder Änderung über applyHousing erzwungen
// (idempotent), Plan B hält Paare (_lang/_kurz) und Budgets synchron.
// Bearbeiten-Modus (kind 'edit', aus meta-builder edit_load): bestehende
// Objekte sind änderbar, gesperrte Felder kommen als locks; gespeichert
// werden nur name und spec; edit_diff zeigt, was sich bei Meta ändert,
// edit_apply schreibt es (nur nach Bestätigung).

export type AssistentStart =
  | { art: 'laden'; id: string }
  | { art: 'neu'; spec: DraftSpec; templateKey: string | null; hinweise?: string[] }
  | { art: 'bearbeiten'; id: string; spec: DraftSpec; locks: string[]; ziel: EditZiel; hinweise?: string[] }

export type AssistentModus = 'neu' | 'bearbeiten'

export type SpeicherStand = 'ruhig' | 'wartet' | 'laeuft' | 'gespeichert' | 'fehler'

export interface Fortschritt {
  laeuft: boolean
  erledigt: string[]
  naechster: string | null
  gesamt: number
  fehler: string | null
}

/** Neue Entwürfe ohne Vorlage: Vorgaben aus ad_settings / Werbekonto */
export interface EntwurfVorgaben {
  pageId?: string | null
  igUserId?: string | null
  pixelId?: string | null
  link?: string | null
  dsaBeneficiary?: string
  dsaPayor?: string
}

const SPEICHER_MS = 1500
/** Meta-Prüfung gilt so lange (Server verlangt dasselbe für create) */
export const PRUEF_GUELTIG_MS = 30 * 60_000
const NUR_LESEN: readonly string[] = ['creating', 'created', 'discarded']

// ── reine Helfer (auch von den Formularen genutzt) ───────────────────────────

/** Nächster freier interner Schlüssel (as1, as2 … / ad1, ad2 …) */
export function neuerKey(prefix: string, vorhanden: readonly string[]): string {
  let n = vorhanden.length + 1
  while (vorhanden.indexOf(`${prefix}${n}`) >= 0) n++
  return `${prefix}${n}`
}

// Knoten, die dieser Entwurf schon bei Meta angelegt hat (meta_ids), sind wie
// bestehende gesperrt: nicht entfernen, nicht ändern. Fortsetzen überspringt
// sie, und ihre Schlüssel dürfen nie neu vergeben werden.

/** Anzeigengruppe schon von diesem Entwurf bei Meta angelegt */
export const gruppeAngelegt = (ids: DraftMetaIds, key: string): boolean => !!ids.adsets?.[key]

/** Werbeanzeige oder ihr Werbemittel schon von diesem Entwurf bei Meta angelegt */
export const anzeigeAngelegt = (ids: DraftMetaIds, key: string): boolean => !!(ids.ads?.[key] || ids.creatives?.[key])

/** Alle belegten Schlüssel einer Ebene: im Entwurf plus in meta_ids */
export function belegteKeys(d: DraftSpec, ids: DraftMetaIds, ebene: 'adsets' | 'ads'): string[] {
  const out = (ebene === 'adsets' ? d.adsets : d.ads).map(x => x.key)
  const extra = ebene === 'adsets'
    ? Object.keys(ids.adsets ?? {})
    : [...Object.keys(ids.ads ?? {}), ...Object.keys(ids.creatives ?? {})]
  for (const k of extra) if (out.indexOf(k) < 0) out.push(k)
  return out
}

export function neueAnzeigengruppe(key: string, name: string, v: EntwurfVorgaben, countries: string[] = ['DE']): AdsetDraft {
  return {
    key,
    name,
    destination: 'WEBSITE',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    billing_event: 'IMPRESSIONS',
    promoted_object: { pixel_id: v.pixelId || HP_PIXEL_ID, custom_event_type: 'SCHEDULE' },
    attribution: 'click_7d_view_1d',
    daily_budget_cents: 3500,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: {
      geo_locations: { countries: countries.slice(), location_types: ['home', 'recent'] },
      age_min: HOUSING_AGE_MIN,
      age_max: HOUSING_AGE_MAX,
      targeting_automation: { advantage_audience: 1 },
    },
    placements: { mode: 'advantage' },
    dsa_beneficiary: v.dsaBeneficiary ?? '',
    dsa_payor: v.dsaPayor ?? '',
  }
}

export function neueAnzeige(key: string, adsetKey: string, v: EntwurfVorgaben, name = ''): AdDraft {
  const ad = emptyAd(key, adsetKey, {
    page_id: v.pageId || HP_PAGE_ID,
    instagram_user_id: v.igUserId ?? '',
    url: v.link || HP_DEFAULT_LINK,
  })
  return { ...ad, name }
}

/** Leere neue Kampagne (Sonderkategorie Wohnen, eine Anzeigengruppe, eine Anzeige) */
export function leererEntwurf(v: EntwurfVorgaben, name: string): DraftSpec {
  return {
    v: META_SPEC_VERSION,
    campaign: {
      name,
      objective: 'OUTCOME_LEADS',
      buying_type: 'AUCTION',
      special_ad_categories: ['HOUSING'],
      special_ad_category_country: ['DE'],
      budget_level: 'adset',
      is_adset_budget_sharing_enabled: false,
    },
    adsets: [neueAnzeigengruppe('as1', 'Anzeigengruppe 1', v)],
    ads: [neueAnzeige('ad1', 'as1', v, 'Anzeige 1')],
  }
}

/** Gespeicherte spec robust lesen (alte/leere Zeilen) */
export function specAus(raw: unknown, ersatz: DraftSpec): DraftSpec {
  if (!raw || typeof raw !== 'object') return ersatz
  const r = raw as Partial<DraftSpec>
  if (!r.campaign || typeof r.campaign !== 'object') return ersatz
  return {
    ...r,
    v: META_SPEC_VERSION,
    campaign: r.campaign,
    adsets: Array.isArray(r.adsets) ? r.adsets : [],
    ads: Array.isArray(r.ads) ? r.ads : [],
  }
}

/**
 * Wohnen erzwingen (neue Kampagnen bekommen HOUSING, bestehende behalten ihre Kategorien).
 * Knoten, die dieser Entwurf schon bei Meta angelegt hat, bleiben unverändert: sonst
 * änderte eine fremde Bearbeitung ihren Inhalt, und Fortsetzen meldete 409.
 */
export function normalisiere(d: DraftSpec, ids: DraftMetaIds = {}): DraftSpec {
  const n = applyHousing(d).spec
  const altGruppe = new Map(d.adsets.map(a => [a.key, a]))
  const altAnzeige = new Map(d.ads.map(a => [a.key, a]))
  return {
    ...n,
    adsets: n.adsets.map(a => (gruppeAngelegt(ids, a.key) && altGruppe.has(a.key) ? altGruppe.get(a.key)! : a)),
    ads: n.ads.map(a => (anzeigeAngelegt(ids, a.key) && altAnzeige.has(a.key) ? altAnzeige.get(a.key)! : a)),
  }
}

/** Art des Entwurfs + Ziel-IDs aus dem Inhalt ableiten */
export function artFuer(d: DraftSpec): { kind: DraftKind; target_campaign_id: string | null; target_adset_id: string | null } {
  const cid = d.campaign?.existing_id ?? null
  if (!cid) return { kind: 'new_campaign', target_campaign_id: null, target_adset_id: null }
  if (d.adsets.some(a => !a.existing_id)) return { kind: 'add_adsets', target_campaign_id: cid, target_adset_id: null }
  const ziele: string[] = []
  for (const ad of d.ads) {
    if (ad.existing_id) continue
    const as = adsetByKey(d, ad.adset_key)?.existing_id
    if (as && ziele.indexOf(as) < 0) ziele.push(as)
  }
  return { kind: 'add_ads', target_campaign_id: cid, target_adset_id: ziele.length === 1 ? ziele[0] : null }
}

export const entwurfName = (d: DraftSpec, ersatz: string): string =>
  (cleanName(d.campaign?.name, 200) || ersatz).slice(0, 200)

/** Partner einer Plan-B-Anzeige (<kennung>_lang <-> <kennung>_kurz) */
export function paarPartner(d: DraftSpec, key: string): AdDraft | undefined {
  const m = /^(.*)_(lang|kurz)$/.exec(key)
  if (!m) return undefined
  const other = `${m[1]}_${m[2] === 'lang' ? 'kurz' : 'lang'}`
  return d.ads.find(a => a.key === other)
}

const PAAR_FELDER: ReadonlyArray<keyof AdDraft> = [
  'format', 'identity', 'primary_texts', 'headlines', 'descriptions', 'cta_type', 'media',
  'creative_features', 'multi_advertiser', 'source',
  // Runde 2: vorhandener Beitrag, Karussell-Schalter, Sprachen, Partnerschaft, Tracking
  'beitrag', 'karussell', 'sprachen', 'partnerschaft', 'tracking',
]

const kopie = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** Anzeige ändern; bei Plan B wandern Texte, Medien, Format und Identität mit zum Partner. */
export function setzeAnzeige(d: DraftSpec, key: string, patch: Partial<AdDraft>, gepaart: boolean, ids: DraftMetaIds = {}): DraftSpec {
  if (anzeigeAngelegt(ids, key)) return d
  const ads = d.ads.map(a => (a.key === key ? { ...a, ...patch } : a))
  let next: DraftSpec = { ...d, ads }
  if (!gepaart) return next
  const partner = paarPartner(next, key)
  if (!partner || partner.existing_id || anzeigeAngelegt(ids, partner.key)) return next
  const p: Partial<AdDraft> = {}
  for (const f of PAAR_FELDER) {
    if (f in patch) (p as Record<string, unknown>)[f] = kopie((patch as Record<string, unknown>)[f])
  }
  // Sprachen: Texte für beide, die Landingpage je Sprache bleibt die des Partners (wie bei destination)
  if (p.sprachen && Array.isArray(p.sprachen.varianten)) {
    const eigene = partner.sprachen?.varianten ?? []
    p.sprachen = {
      ...p.sprachen,
      varianten: p.sprachen.varianten.map(v => {
        const neu: SprachVariante = { ...v }
        delete neu.url
        const url = eigene.find(x => x.sprache === v.sprache)?.url
        if (url) neu.url = url
        return neu
      }),
    }
  }
  if (typeof patch.name === 'string') {
    const suffix = /_(lang|kurz)$/.exec(partner.key)?.[1] ?? ''
    p.name = `${patch.name.replace(/_(lang|kurz)$/, '')}_${suffix}`
  }
  // Ziel: alles ohne eigene Landingpage gilt für beide (Formular, WhatsApp, Anruf, Messenger);
  // Website behält je Partner die eigene Landingpage
  const lp = /_kurz$/.test(partner.key) ? PLAN_B_LP_KURZ : PLAN_B_LP_LANG
  if (patch.destination && patch.destination.kind !== 'website' && patch.destination.kind !== 'website_lead_form') {
    p.destination = { ...patch.destination }
  } else if (patch.destination?.kind === 'website' && partner.destination.kind !== 'website') {
    p.destination = { kind: 'website', url: partner.destination.kind === 'website_lead_form' ? partner.destination.url : lp }
  } else if (patch.destination?.kind === 'website_lead_form') {
    const url = partner.destination.kind === 'website' || partner.destination.kind === 'website_lead_form' ? partner.destination.url : lp
    p.destination = { ...patch.destination, url }
  }
  if (Object.keys(p).length) next = { ...next, ads: next.ads.map(a => (a.key === partner.key ? { ...a, ...p } : a)) }
  return next
}

/** Anzeigengruppe ändern; „Budgets synchron" überträgt Budgets auf alle neuen Gruppen. */
export function setzeAnzeigengruppe(d: DraftSpec, key: string, patch: Partial<AdsetDraft>, ids: DraftMetaIds = {}): DraftSpec {
  if (gruppeAngelegt(ids, key)) return d
  const sync = d.hp?.budgets_synchron === true
  const budget = 'daily_budget_cents' in patch || 'lifetime_budget_cents' in patch
  const adsets = d.adsets.map(a => {
    if (a.key === key) return { ...a, ...patch }
    if (sync && budget && !a.existing_id && !gruppeAngelegt(ids, a.key)) {
      const p: Partial<AdsetDraft> = {}
      if ('daily_budget_cents' in patch) p.daily_budget_cents = patch.daily_budget_cents
      if ('lifetime_budget_cents' in patch) p.lifetime_budget_cents = patch.lifetime_budget_cents
      return { ...a, ...p }
    }
    return a
  })
  return { ...d, adsets }
}

/** Werbemittel-Felder einer Anzeige (Änderung = neues Creative bei Meta) */
const CREATIVE_FELDER: ReadonlyArray<keyof AdDraft> = [
  'format', 'identity', 'primary_texts', 'headlines', 'descriptions', 'cta_type', 'destination', 'media',
  'creative_features', 'multi_advertiser',
  // Runde 2 (Werbemittel): Beitrag, Karussell-Schalter, Sprachen, Partnerschaft; Tracking gehört zur Anzeige
  'beitrag', 'karussell', 'sprachen', 'partnerschaft',
]

/** Hat sich das Werbemittel einer Anzeige gegenüber dem Stand beim Öffnen geändert? null = unbekannt */
export function creativeGeaendert(original: DraftSpec | null, d: DraftSpec, key: string): boolean | null {
  if (!original) return null
  const vorher = original.ads.find(a => a.key === key)
  const jetzt = d.ads.find(a => a.key === key)
  if (!vorher || !jetzt) return null
  return CREATIVE_FELDER.some(f => JSON.stringify(vorher[f] ?? null) !== JSON.stringify(jetzt[f] ?? null))
}

/** Alle Medien-IDs eines Entwurfs */
export function medienIds(d: DraftSpec): string[] {
  const out: string[] = []
  const add = (r?: MediaRef) => { if (r?.media_id && out.indexOf(r.media_id) < 0) out.push(r.media_id) }
  const addMitBild = (r?: MediaRef) => {
    add(r)
    if (r?.thumbnail_media_id && out.indexOf(r.thumbnail_media_id) < 0) out.push(r.thumbnail_media_id)
  }
  for (const ad of d.ads) {
    addMitBild(ad.media?.feed_4x5); addMitBild(ad.media?.story_9x16); addMitBild(ad.media?.square_1x1); addMitBild(ad.media?.landscape_191x1)
    for (const c of ad.media?.cards ?? []) addMitBild(c.media)
  }
  return out
}

/** Neues Tagesbudget dieses Entwurfs in USD-Cent (Laufzeitbudget anteilig je Tag) */
export function entwurfTagesbudgetCents(d: DraftSpec): number {
  const proTag = (daily?: number, lifetime?: number, start?: string, end?: string): number => {
    if ((daily ?? 0) > 0) return daily ?? 0
    if ((lifetime ?? 0) > 0) {
      const von = start ? Date.parse(start) : Date.now()
      const bis = end ? Date.parse(end) : NaN
      const tage = Number.isFinite(bis) ? Math.max(1, Math.ceil((bis - Math.max(von, Date.now())) / 86_400_000)) : 30
      return (lifetime ?? 0) / tage
    }
    return 0
  }
  const c = d.campaign
  if (c.budget_level === 'campaign') {
    return c.existing_id ? 0 : proTag(c.daily_budget_cents, c.lifetime_budget_cents, c.start_time, c.stop_time)
  }
  let sum = 0
  for (const a of d.adsets) {
    if (a.existing_id) continue
    sum += proTag(a.daily_budget_cents, a.lifetime_budget_cents, a.start_time, a.end_time)
  }
  return sum
}

// ── der Hook ──────────────────────────────────────────────────────────────────

export interface EntwurfApi {
  /** 'bearbeiten': laufende Objekte bei Meta ändern (kind 'edit') */
  modus: AssistentModus
  /** Bearbeiten: gesperrte Feldschlüssel (edit_load bzw. editLocks, dazu Sperren der Oberfläche) */
  locks: string[]
  /** Bearbeiten: Ausgangsstand bei Meta (meta_ids.edit.baseline), sonst der Stand beim Öffnen; null wenn unbekannt */
  original: DraftSpec | null
  /** Bearbeiten: lokaler Vergleich Ausgangsstand gegen Entwurf (editDiff), null ohne Ausgangsstand */
  lokalDiff: EditDiffResult | null
  /** Bearbeiten: was geöffnet wurde */
  ziel: EditZiel | null
  laden: boolean
  ladeFehler: string | null
  id: string | null
  status: DraftStatus | null
  templateKey: string | null
  spec: DraftSpec
  metaIds: DraftMetaIds
  validation: DraftValidation | null
  lastError: DraftLastError | null
  speichern: SpeicherStand
  speicherFehler: string | null
  nurLesen: boolean
  /** Meta-Prüfung fehlt, ist älter als 30 Minuten oder der Entwurf hat sich seitdem geändert */
  pruefungVeraltet: boolean
  issues: DraftIssue[]
  lint: LintIssue[]
  housing: HousingResult
  medien: Record<string, MetaMediaRow>
  fortschritt: Fortschritt
  update: (fn: (d: DraftSpec) => DraftSpec) => void
  setzeMedium: (row: MetaMediaRow) => void
  sichern: () => Promise<string | null>
  pruefen: () => Promise<DraftValidation>
  anlegen: (forceGrund?: string) => Promise<CreateResponse | null>
  aktivieren: () => Promise<ActivateDraftResponse>
  verwerfen: () => Promise<void>
  neuLadenMeta: () => Promise<void>
  /** Bearbeiten: speichern, dann edit_diff (schreibt nichts bei Meta) */
  aenderungenLaden: () => Promise<EditDiffResponse>
  /** Bearbeiten: edit_apply mit confirm (schreibt bei Meta); Admin kann Lint-Blocker bzw. fehlendes Wohnen begründet übergehen */
  aenderungenUebernehmen: (gruende?: UebernehmenGruende) => Promise<EditApplyResponse>
  /** Bearbeiten: Entwurf und Ausgangsstand neu aus meta_drafts lesen (nach edit_apply); false = nicht lesbar */
  neuLaden: () => Promise<boolean>
  /**
   * Vor „Neu von Meta laden“: Speichern stoppen, laufende Speicherung abwarten und den
   * Entwurf schreibgeschützt machen, damit der alte Stand die frisch geladene Zeile nicht
   * überschreibt. Gibt eine Funktion zurück, die das rückgängig macht (Laden fehlgeschlagen).
   */
  einfrieren: () => Promise<() => void>
}

/** Admin-Begründungen für edit_apply (je mindestens 10 Zeichen, sonst lehnt der Server ab) */
export interface UebernehmenGruende {
  force_lint_reason?: string
  housing_override_reason?: string
}

interface Optionen {
  /** Projekt- und Bauträgernamen (Katalog lint_context) */
  verboteneNamen: string[]
  /** Name, wenn die Kampagne noch keinen hat */
  ersatzName: string
  /** Platzhalter-Entwurf, bis eine gespeicherte Zeile geladen ist */
  leer: DraftSpec
}

export function useEntwurf(start: AssistentStart, opt: Optionen): EntwurfApi {
  const [anfangsSpec] = useState<DraftSpec>(() => (
    start.art === 'neu' ? normalisiere(start.spec)
      : start.art === 'bearbeiten'
        ? normalisiere(mitHp(start.spec, { creative_tausch: hpVon(start.spec).creative_tausch ?? 'neue_anzeige' }))
        : opt.leer))
  const [modus, setModus] = useState<AssistentModus>(start.art === 'bearbeiten' ? 'bearbeiten' : 'neu')
  const modusRef = useRef<AssistentModus>(modus)
  modusRef.current = modus
  const [serverLocks, setServerLocks] = useState<string[] | null>(() => (start.art === 'bearbeiten' ? start.locks.slice() : null))
  const [stand] = useState<DraftSpec | null>(() => (start.art === 'bearbeiten' ? anfangsSpec : null))
  const [ziel, setZiel] = useState<EditZiel | null>(start.art === 'bearbeiten' ? start.ziel : null)
  const [laden, setLaden] = useState(start.art === 'laden')
  const [ladeFehler, setLadeFehler] = useState<string | null>(null)
  const [id, setId] = useState<string | null>(start.art === 'neu' ? null : start.id)
  const [status, setStatus] = useState<DraftStatus | null>(start.art === 'bearbeiten' ? 'draft' : null)
  const [templateKey, setTemplateKey] = useState<string | null>(start.art === 'neu' ? start.templateKey : null)
  const [spec, setSpec] = useState<DraftSpec>(anfangsSpec)
  const [metaIds, setMetaIds] = useState<DraftMetaIds>({})
  const metaIdsRef = useRef<DraftMetaIds>({})
  metaIdsRef.current = metaIds
  const [validation, setValidation] = useState<DraftValidation | null>(null)
  const [lastError, setLastError] = useState<DraftLastError | null>(null)
  const [speichern, setSpeichern] = useState<SpeicherStand>('ruhig')
  const [speicherFehler, setSpeicherFehler] = useState<string | null>(null)
  const [medien, setMedien] = useState<Record<string, MetaMediaRow>>({})
  const [fortschritt, setFortschritt] = useState<Fortschritt>({ laeuft: false, erledigt: [], naechster: null, gesamt: 0, fehler: null })
  // Änderungszähler: Prüfung ist veraltet, sobald nach ihr editiert wurde
  const [aenderung, setAenderung] = useState(0)
  const [geprueftBei, setGeprueftBei] = useState<number | null>(null)
  const [jetzt, setJetzt] = useState(() => Date.now())

  const idRef = useRef<string | null>(id)
  const specRef = useRef<DraftSpec>(anfangsSpec)
  const templateRef = useRef<string | null>(templateKey)
  // Vorlage/Import sofort speichern (Inhalt da), leere neue Kampagne erst bei der ersten Änderung
  // Bearbeiten: die Zeile hat der Server mit dieser spec angelegt, erst die erste Änderung speichert
  const dirtyRef = useRef(start.art === 'neu' && (start.templateKey !== null || !!start.spec.campaign.existing_id))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ketteRef = useRef<Promise<string | null>>(Promise.resolve(id))
  const angefragtRef = useRef<Set<string>>(new Set())
  const ersatzNameRef = useRef(opt.ersatzName)
  ersatzNameRef.current = opt.ersatzName
  // „Neu von Meta laden“ läuft: nichts mehr speichern (sonst überschriebe der alte Stand die frische Zeile)
  const eingefrorenRef = useRef(false)
  const [eingefroren, setEingefroren] = useState(false)

  // Uhr für „älter als 30 Minuten"
  useEffect(() => {
    const iv = setInterval(() => setJetzt(Date.now()), 60_000)
    return () => clearInterval(iv)
  }, [])

  // ── Speichern ─────────────────────────────────────────────────────────────
  const speichereEinmal = useCallback(async (): Promise<string | null> => {
    if (!dirtyRef.current || eingefrorenRef.current) return idRef.current
    dirtyRef.current = false
    const d = specRef.current
    const art = artFuer(d)
    // Bearbeiten: Art und Ziel-IDs setzt der Server (edit_load), hier nur Name und Inhalt
    const zeile = modusRef.current === 'bearbeiten'
      ? { name: entwurfName(d, ersatzNameRef.current), spec: d }
      : {
        name: entwurfName(d, ersatzNameRef.current),
        kind: art.kind,
        template_key: templateRef.current,
        spec: d,
        target_campaign_id: art.target_campaign_id,
        target_adset_id: art.target_adset_id,
      }
    setSpeichern('laeuft')
    try {
      if (!idRef.current) {
        const { data, error } = await supabase.from('meta_drafts').insert(zeile).select('id, status').single()
        if (error) throw error
        const r = data as { id: string; status: DraftStatus }
        idRef.current = r.id
        setId(r.id)
        setStatus(r.status)
      } else {
        const { error } = await supabase.from('meta_drafts').update(zeile).eq('id', idRef.current)
        if (error) throw error
      }
      setSpeichern(dirtyRef.current ? 'wartet' : 'gespeichert')
      setSpeicherFehler(null)
      return idRef.current
    } catch (err) {
      dirtyRef.current = true
      const msg = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err)
      console.error('[Kampagnen] Speichern:', err)
      setSpeichern('fehler')
      setSpeicherFehler(msg)
      return idRef.current
    }
  }, [])

  /** Sofort speichern (wartet auf laufende Speicherungen), gibt die Entwurfs-ID zurück */
  const sichern = useCallback((): Promise<string | null> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    const p = ketteRef.current.then(() => speichereEinmal(), () => speichereEinmal())
    ketteRef.current = p
    return p
  }, [speichereEinmal])

  const planeSpeichern = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setSpeichern('wartet')
    timerRef.current = setTimeout(() => { timerRef.current = null; void sichern() }, SPEICHER_MS)
  }, [sichern])

  // Beim Schließen nichts verlieren
  useEffect(() => () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (dirtyRef.current) void ketteRef.current.then(() => speichereEinmal(), () => speichereEinmal())
  }, [speichereEinmal])

  // ── Laden ─────────────────────────────────────────────────────────────────
  const uebernehmeMeta = useCallback((r: Record<string, unknown>) => {
    if (typeof r.status === 'string') setStatus(r.status as DraftStatus)
    setMetaIds((r.meta_ids as DraftMetaIds | null) ?? {})
    // Bearbeiten-Ziel steht in meta_ids.edit (schreibt meta-builder bei edit_load und edit_apply)
    const z = zielAusMetaIds(r.meta_ids as DraftMetaIds | null)
    if (z) setZiel(prev => prev ?? z)
    setValidation((r.validation as DraftValidation | null) ?? null)
    setLastError((r.last_error as DraftLastError | null) ?? null)
  }, [])

  useEffect(() => {
    if (start.art !== 'laden') {
      if (dirtyRef.current) void sichern()
      // Bearbeiten: Ausgangsstand (meta_ids.edit.baseline) für den lokalen Vergleich holen
      if (start.art === 'bearbeiten') void neuLadenMetaRef.current()
      return
    }
    let abbruch = false
    void (async () => {
      try {
        const { data, error } = await supabase.from('meta_drafts')
          .select('id, name, kind, template_key, spec, status, validation, meta_ids, last_error, target_campaign_id, target_adset_id, updated_at')
          .eq('id', start.id).single()
        if (error) throw error
        if (abbruch) return
        const r = data as Record<string, unknown>
        const s = specAus(r.spec, opt.leer)
        if (r.kind === 'edit') {
          modusRef.current = 'bearbeiten'
          setModus('bearbeiten')
          // Sperren ohne edit_load: aus dem Ausgangsstand (oder dem Entwurf) ableiten
          const basis = (r.meta_ids as DraftMetaIds | null)?.edit?.baseline
          setServerLocks(editLocks(basis ?? s))
        }
        specRef.current = s
        setSpec(s)
        const tk = typeof r.template_key === 'string' ? r.template_key : null
        templateRef.current = tk
        setTemplateKey(tk)
        uebernehmeMeta(r)
        setGeprueftBei(r.validation ? 0 : null)
      } catch (err) {
        console.error('[Kampagnen] Entwurf laden:', err)
        if (!abbruch) setLadeFehler(err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err))
      } finally {
        if (!abbruch) setLaden(false)
      }
    })()
    return () => { abbruch = true }
    // nur beim Öffnen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const neuLadenMeta = useCallback(async () => {
    const eid = idRef.current
    if (!eid) return
    const { data, error } = await supabase.from('meta_drafts')
      .select('status, validation, meta_ids, last_error, updated_at').eq('id', eid).maybeSingle()
    if (error) { console.warn('[Kampagnen] Status laden:', error); return }
    if (data) uebernehmeMeta(data as Record<string, unknown>)
  }, [uebernehmeMeta])
  const neuLadenMetaRef = useRef(neuLadenMeta)
  neuLadenMetaRef.current = neuLadenMeta

  /** Bearbeiten: Entwurf und Ausgangsstand neu lesen (offene lokale Änderungen gehen verloren) */
  const neuLaden = useCallback(async (): Promise<boolean> => {
    const eid = idRef.current
    if (!eid) return false
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    await ketteRef.current.catch(() => null)
    const { data, error } = await supabase.from('meta_drafts')
      .select('spec, status, validation, meta_ids, last_error, updated_at').eq('id', eid).maybeSingle()
    if (error || !data) {
      console.warn('[Kampagnen] Entwurf neu laden:', error)
      // edit_apply ist fertig (der Server hat seine Sperre gelöst): nicht schreibgeschützt hängen bleiben
      setStatus(s => (s === 'creating' ? 'draft' : s))
      return false
    }
    const r = data as Record<string, unknown>
    const s = specAus(r.spec, specRef.current)
    dirtyRef.current = false
    specRef.current = s
    setSpec(s)
    uebernehmeMeta(r)
    const basis = (r.meta_ids as DraftMetaIds | null)?.edit?.baseline
    setServerLocks(editLocks(basis ?? s))
    setSpeichern('ruhig')
    return true
  }, [uebernehmeMeta])

  // ── Ändern ────────────────────────────────────────────────────────────────
  // Bearbeiten: gesperrt nur, solange edit_apply läuft oder wenn verworfen
  const nurLesen = eingefroren || (modus === 'bearbeiten'
    ? status === 'discarded' || status === 'creating'
    : !!status && NUR_LESEN.indexOf(status) >= 0)

  const update = useCallback((fn: (d: DraftSpec) => DraftSpec) => {
    if (nurLesen || eingefrorenRef.current) return
    const next = normalisiere(fn(specRef.current), metaIdsRef.current)
    specRef.current = next
    setSpec(next)
    dirtyRef.current = true
    setAenderung(n => n + 1)
    planeSpeichern()
  }, [nurLesen, planeSpeichern])

  // ── Medien (Dateinamen + Bestätigungen für die Prüfung, Vorschau-URLs) ──────
  const idsKey = medienIds(spec).join(',')
  useEffect(() => {
    // Nur echte meta_media-IDs (uuid); importierte Medien tragen „meta:img:<hash>" und stehen nicht in der Tabelle
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const fehlend = idsKey ? idsKey.split(',').filter(x => UUID.test(x) && !angefragtRef.current.has(x)) : []
    if (!fehlend.length) return
    for (const x of fehlend) angefragtRef.current.add(x)
    void (async () => {
      const { data, error } = await supabase.from('meta_media')
        .select('id, kind, storage_path, public_url, aspect, width, height, bytes, sha256, meta_image_hash, meta_video_id, thumbnail_hash, meta_status, meta_error, ai_generated, eu_band_confirmed, ki_label_confirmed, source, created_by, created_at, updated_at')
        .in('id', fehlend).limit(100)
      if (error) { console.warn('[Kampagnen] Medien laden:', error); for (const x of fehlend) angefragtRef.current.delete(x); return }
      const rows = (data as MetaMediaRow[] | null) ?? []
      if (rows.length) setMedien(prev => { const n = { ...prev }; for (const r of rows) n[r.id] = r; return n })
    })()
  }, [idsKey])

  const setzeMedium = useCallback((row: MetaMediaRow) => {
    angefragtRef.current.add(row.id)
    setMedien(prev => ({ ...prev, [row.id]: row }))
  }, [])

  // ── Prüfen (lokal, sofort) ─────────────────────────────────────────────────
  // Bearbeiten: validateDraft prüft bestehende Objekte nicht. Darum ein Probelauf
  // ohne existing_id, ohne gesperrte Felder, alles nur als Hinweis (entscheiden
  // tut edit_diff auf dem Server).
  const baseline = metaIds.edit?.baseline ?? null
  const original = baseline ?? stand
  const locks = useMemo(() => {
    if (modus !== 'bearbeiten') return []
    const out = (serverLocks ?? editLocks(baseline ?? spec)).slice()
    for (const l of oberflaechenSperren(baseline, spec)) if (out.indexOf(l) < 0) out.push(l)
    return out
  }, [modus, serverLocks, baseline, spec])
  const issues = useMemo(() => {
    if (modus !== 'bearbeiten') return validateDraft(spec)
    const probe: DraftSpec = {
      ...spec,
      campaign: { ...spec.campaign, existing_id: undefined },
      adsets: spec.adsets.map(a => ({ ...a, existing_id: undefined })),
      ads: spec.ads.map(a => ({ ...a, existing_id: undefined })),
    }
    const hinweise = validateDraft(probe)
      .filter(i => !istGesperrt(locks, i.node, i.field) && i.code !== 'unsupported' && i.code !== 'legacy_objective')
      .map(i => ({ ...i, severity: 'warn' as const }))
    return [...validateEditFields(spec), ...hinweise]
  }, [spec, modus, locks])
  const lokalDiff = useMemo(() => (modus === 'bearbeiten' && baseline ? editDiff(baseline, spec) : null), [modus, baseline, spec])
  const lintMedien = useMemo(() => {
    const m: Record<string, LintMediaInfo> = {}
    for (const k of Object.keys(medien)) m[k] = medien[k]
    return m
  }, [medien])
  const lint = useMemo(() => lintDraft(spec, { forbiddenNames: opt.verboteneNamen, media: lintMedien }), [spec, opt.verboteneNamen, lintMedien])
  const housing = useMemo(() => applyHousing(spec), [spec])

  const validiertAt = validation?.validated_at ? Date.parse(validation.validated_at) : NaN
  const pruefungVeraltet = !validation || geprueftBei === null || geprueftBei !== aenderung
    || !Number.isFinite(validiertAt) || jetzt - validiertAt > PRUEF_GUELTIG_MS

  // ── Meta-Aufrufe ──────────────────────────────────────────────────────────
  const brauchtId = async (): Promise<string> => {
    dirtyRef.current = dirtyRef.current || !idRef.current
    const eid = await sichern()
    if (!eid) throw new Error('not_saved')
    return eid
  }

  const pruefen = async (): Promise<DraftValidation> => {
    const eid = await brauchtId()
    const stand = aenderung
    const v = await builderCall('validate', { draft_id: eid })
    setValidation(v)
    setGeprueftBei(stand)
    setJetzt(Date.now())
    await neuLadenMeta()
    setValidation(v)
    return v
  }

  const anlegen = async (forceGrund?: string): Promise<CreateResponse | null> => {
    const eid = await brauchtId()
    const d = specRef.current
    const gesamt = (d.campaign.existing_id ? 0 : 1) + d.adsets.filter(a => !a.existing_id).length + 2 * d.ads.filter(a => !a.existing_id).length
    setFortschritt({ laeuft: true, erledigt: [], naechster: null, gesamt, fehler: null })
    let letzte: CreateResponse | null = null
    try {
      const req = { draft_id: eid, ...(forceGrund ? { force_lint_reason: forceGrund } : {}) }
      const fortsetzen = status === 'partial' || status === 'failed' || status === 'creating'
      letzte = await builderCall(fortsetzen ? 'resume' : 'create', req)
      for (let i = 0; i < 60; i++) {
        const r: CreateResponse = letzte
        setMetaIds(r.meta_ids ?? {})
        setStatus(r.status)
        setFortschritt(f => ({ ...f, erledigt: r.done_steps ?? [], naechster: r.next, gesamt: Math.max(f.gesamt, (r.done_steps ?? []).length + (r.next ? 1 : 0)) }))
        if (r.error) {
          setFortschritt(f => ({ ...f, fehler: r.error?.hint || r.error?.error || null }))
          break
        }
        if (!r.next) break
        letzte = await builderCall('resume', req)
      }
      return letzte
    } finally {
      setFortschritt(f => ({ ...f, laeuft: false }))
      await neuLadenMeta()
    }
  }

  const aktivieren = async (): Promise<ActivateDraftResponse> => {
    const eid = await brauchtId()
    try {
      return await builderCall('activate_draft', { draft_id: eid, levels: ['ad', 'adset', 'campaign'], confirm: true })
    } finally {
      await neuLadenMeta()
    }
  }

  const aenderungenLaden = async (): Promise<EditDiffResponse> => {
    const eid = await brauchtId()
    // Speichern fehlgeschlagen: sonst verglich der Server einen alten Stand
    if (dirtyRef.current) throw new Error('nicht_gespeichert')
    return builderCall('edit_diff', { draft_id: eid })
  }

  const aenderungenUebernehmen = async (gruende: UebernehmenGruende = {}): Promise<EditApplyResponse> => {
    const eid = await brauchtId()
    if (dirtyRef.current) throw new Error('nicht_gespeichert')
    setStatus('creating')
    try {
      return await builderCall('edit_apply', {
        draft_id: eid, confirm: true,
        ...(gruende.force_lint_reason ? { force_lint_reason: gruende.force_lint_reason } : {}),
        ...(gruende.housing_override_reason ? { housing_override_reason: gruende.housing_override_reason } : {}),
      })
    } finally {
      await neuLaden()
    }
  }

  const einfrieren = async (): Promise<() => void> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    const warOffen = dirtyRef.current
    dirtyRef.current = false
    eingefrorenRef.current = true
    setEingefroren(true)
    await ketteRef.current.catch(() => null)
    return () => {
      eingefrorenRef.current = false
      setEingefroren(false)
      if (warOffen) { dirtyRef.current = true; planeSpeichern() }
    }
  }

  const verwerfen = async (): Promise<void> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    dirtyRef.current = false
    const eid = idRef.current
    if (!eid) return
    await ketteRef.current.catch(() => null)
    await builderCall('discard', { draft_id: eid })
    setStatus('discarded')
  }

  return {
    modus, locks, original, ziel, lokalDiff,
    laden, ladeFehler, id, status, templateKey, spec, metaIds, validation, lastError, speichern, speicherFehler,
    nurLesen, pruefungVeraltet, issues, lint, housing, medien, fortschritt,
    update, setzeMedium, sichern, pruefen, anlegen, aktivieren, verwerfen, neuLadenMeta,
    aenderungenLaden, aenderungenUebernehmen, neuLaden, einfrieren,
  }
}

// ── Leitplanke: heute aktiv + diese Kampagne <= Limit ─────────────────────────
// Bis zur Meta-Prüfung eine Schätzung aus den Spiegeltabellen (meta_adsets,
// meta_campaigns: aktive Tagesbudgets in USD-Cent) mit dem 7-Tage-Kurs; danach
// gilt der Wert des Servers (validation.guardrail).

export interface Leitplanke {
  limitEur: number | null
  aktivEur: number | null
  dieseEur: number
  nachherEur: number | null
  ok: boolean | null
  quelle: 'server' | 'schaetzung'
  kurs: number
}

export function useLeitplanke(spec: DraftSpec, validation: DraftValidation | null, limitEur: number | null): Leitplanke {
  const [kurs, setKurs] = useState<number>(USD_PRO_EUR_FALLBACK)
  const [aktivCents, setAktivCents] = useState<number | null>(null)

  useEffect(() => {
    let abbruch = false
    void (async () => {
      const k = (await ladeUsdProEur()) ?? USD_PRO_EUR_FALLBACK
      if (abbruch) return
      setKurs(k)
      // seriell: erst Anzeigengruppen, dann Kampagnen (Micro-Instanz)
      let summe = 0
      let gelesen = 0
      const tag = (daily: unknown, lifetime: unknown, ende: unknown): number => {
        const d = Number(daily) || 0
        if (d > 0) return d
        const l = Number(lifetime) || 0
        if (l <= 0) return 0
        const bis = typeof ende === 'string' ? Date.parse(ende) : NaN
        const tage = Number.isFinite(bis) ? Math.max(1, Math.ceil((bis - Date.now()) / 86_400_000)) : 30
        return l / tage
      }
      const as = await supabase.from('meta_adsets')
        .select('daily_budget_cents, lifetime_budget_cents, end_time').eq('effective_status', 'ACTIVE').limit(500)
      if (!as.error) {
        const rows = (as.data as Array<Record<string, unknown>> | null) ?? []
        gelesen += rows.length
        for (const r of rows) summe += tag(r.daily_budget_cents, r.lifetime_budget_cents, r.end_time)
      }
      if (abbruch) return
      const ca = await supabase.from('meta_campaigns')
        .select('daily_budget_cents, lifetime_budget_cents, stop_time').eq('effective_status', 'ACTIVE').limit(200)
      if (!ca.error) {
        const rows = (ca.data as Array<Record<string, unknown>> | null) ?? []
        gelesen += rows.length
        for (const r of rows) summe += tag(r.daily_budget_cents, r.lifetime_budget_cents, r.stop_time)
      }
      if (abbruch) return
      // Leerer Spiegel = unbekannt (nicht 0 €, sonst wirkt die Leitplanke falsch grün)
      setAktivCents(as.error && ca.error ? null : gelesen > 0 ? summe : null)
    })()
    return () => { abbruch = true }
  }, [])

  const g = validation?.guardrail ?? null
  const dieseEurLokal = entwurfTagesbudgetCents(spec) / 100 / kurs
  if (g) {
    return {
      limitEur: g.limitEur, aktivEur: g.activeEur, dieseEur: Math.max(0, g.afterEur - g.activeEur),
      nachherEur: g.afterEur, ok: g.ok, quelle: 'server', kurs: g.rateEurPerUsd > 0 ? 1 / g.rateEurPerUsd : kurs,
    }
  }
  const aktivEur = aktivCents === null ? null : aktivCents / 100 / kurs
  const nachherEur = aktivEur === null ? null : aktivEur + dieseEurLokal
  return {
    limitEur, aktivEur, dieseEur: dieseEurLokal, nachherEur,
    ok: nachherEur === null || limitEur === null ? null : nachherEur <= limitEur + 0.005,
    quelle: 'schaetzung', kurs,
  }
}

// ── Abhängigkeiten Ziel -> Conversion-Ort -> Leistungsziel -> Abrechnung ─────

/** Anzeigengruppe an das Kampagnenziel anpassen (ungültige Werte auf den ersten erlaubten).
 *  zielStandard: beim Wechsel des Kampagnenziels das Standard-Leistungsziel nehmen (wie Meta).
 *  auchBestehend: im Bearbeiten-Modus auch bestehende Anzeigengruppen anpassen. */
export function passeAnzeigengruppeAn(a: AdsetDraft, objective: Objective, pixelStandard: string, zielStandard = false, auchBestehend = false): AdsetDraft {
  if (a.existing_id && !auchBestehend) return a
  const erlaubt = (v: Destination) => !DESTINATION_OPTIONS.some(o => o.value === v && o.unsupported)
  const orte = destinationsFor(objective).filter(erlaubt)
  const destination = orte.indexOf(a.destination) >= 0 ? a.destination : (orte[0] ?? a.destination)
  const ziele = goalsFor(objective, destination)
  const optimization_goal = !zielStandard && ziele.indexOf(a.optimization_goal) >= 0 ? a.optimization_goal : (ziele[0] ?? a.optimization_goal)
  const billings = billingFor(optimization_goal)
  const billing_event = billings.indexOf(a.billing_event) >= 0 ? a.billing_event : billings[0]
  const attrs = attributionFor(optimization_goal)
  const attribution = attrs.indexOf(a.attribution) >= 0 ? a.attribution : attrs[0]
  const rule = promotedRuleFor(objective, destination, optimization_goal)
  const promoted_object: PromotedObject = {}
  if (rule) {
    const keys = promotedAllowed(rule)
    for (const k of keys) {
      const v = a.promoted_object?.[k]
      if (v !== undefined && v !== '') (promoted_object as Record<string, unknown>)[k] = v
    }
    if (keys.indexOf('pixel_id') >= 0 && !promoted_object.pixel_id && !promoted_object.custom_conversion_id) {
      promoted_object.pixel_id = pixelStandard || HP_PIXEL_ID
    }
    if (keys.indexOf('custom_event_type') >= 0 && promoted_object.pixel_id && !promoted_object.custom_event_type) {
      promoted_object.custom_event_type = 'SCHEDULE'
    }
  }
  return { ...a, destination, optimization_goal, billing_event, attribution, promoted_object }
}

export function passeAnZiel(d: DraftSpec, pixelStandard: string): DraftSpec {
  return { ...d, adsets: d.adsets.map(a => passeAnzeigengruppeAn(a, d.campaign.objective, pixelStandard, true)) }
}

// ── Kontext für die Formulare des Assistenten ────────────────────────────────

export interface AssistentWerte {
  e: EntwurfApi
  katalog: CatalogResponse | null
  vorgaben: BuilderVorgaben
  /** USD je EUR */
  kurs: number
  /** null = Schreiben bei Meta erlaubt, sonst der Grund (Text) */
  schreibSperre: string | null
  /** Plan B: Anzeigen als Paar _lang/_kurz */
  gepaart: boolean
  /** Formularfeld anspringen (Prüfliste) */
  springeZu: (node: string, field?: string) => void
  /** Bearbeiten-Modus: bestehende Objekte sind änderbar */
  bearbeiten: boolean
  /** Sperrgrund (Text) eines Feldes im Bearbeiten-Modus, sonst undefined */
  sperre: (node: string, feld: string) => string | undefined
}

export const AssistentKontext = createContext<AssistentWerte | null>(null)

export function useAssistent(): AssistentWerte {
  const v = useContext(AssistentKontext)
  if (!v) throw new Error('useAssistent außerhalb des Kampagnen-Assistenten')
  return v
}

/** Text-Kürzel des Plan-B-Paares für eine neue Kennung (nie ein Schlüssel aus meta_ids) */
export function neueKennung(d: DraftSpec, ids: DraftMetaIds = {}): string {
  const basen = belegteKeys(d, ids, 'ads').map(k => k.replace(/_(lang|kurz)$/, ''))
  let n = 1
  while (basen.indexOf(`werbemittel${n}`) >= 0) n++
  return `werbemittel${n}`
}

export const MAX_TEXTE = LIMITS.textsPerKind
