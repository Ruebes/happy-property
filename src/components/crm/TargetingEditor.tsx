/**
 * TargetingEditor - Meta-Zielgruppe einer Anzeigengruppe bearbeiten.
 *
 * Arbeitet direkt auf Metas targeting-Objekt, damit das Speichern eine reine
 * Durchreiche ist. WICHTIG: Beim Speichern werden die Original-Felder gespreadet
 * und nur die hier verwalteten überschrieben - Meta-Targeting enthält Felder,
 * die wir bewusst nicht anzeigen (locales, device_platforms, …), und die dürfen
 * durch eine Bearbeitung nicht verloren gehen.
 *
 * Mehrere flexible_spec-Gruppen (verschachteltes UND/ODER) kann Meta abbilden,
 * dieser Editor bearbeitet nur die erste. Weitere Gruppen bleiben unangetastet
 * und werden als Hinweis angezeigt, statt sie stillschweigend zu verschlucken.
 *
 * Zusätze für den Kampagnen-Assistenten (alle optional, ohne sie bleibt alles
 * wie bisher):
 *   housing        Sonderkategorie Wohnen: Alter fest 18 bis 65+, kein Geschlecht,
 *                  keine Ortsausschlüsse, Umkreis um Städte mindestens 17 km, kein
 *                  Verhalten/Jobtitel/Arbeitgeber, keine Ausschlüsse, keine
 *                  Lookalikes, Advantage+ Zielgruppe als ausdrücklicher Schalter.
 *                  Jede Änderung wird dabei bereinigt (gleiche Regeln wie
 *                  applyHousing in lib/metaSpec.ts, der Server prüft noch einmal).
 *   onLocks        meldet die gesperrten Bereiche als kurze, übersetzte Texte
 *                  ([] ohne housing); nur bei echter Änderung, nicht je Render.
 *   showLocales    Abschnitt Sprachen (targeting.locales).
 *   showPositions  einzelne Positionen je Plattform (facebook_positions, …) und
 *                  Threads als Plattform. Positionen stehen wie bei Meta im
 *                  targeting-Objekt; leere Liste = alle Positionen der Plattform.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'
import { supabase } from '../../lib/supabase'
import {
  HOUSING_AGE_MAX, HOUSING_AGE_MIN, HOUSING_FORBIDDEN_DETAILED_KEYS, HOUSING_FORBIDDEN_GEO_KEYS, HOUSING_MIN_RADIUS_KM,
  POSITION_FIELD_BY_PLATFORM, POSITION_OPTIONS, PUBLISHER_PLATFORMS, type PublisherPlatform,
} from '../../lib/metaSpec'

export interface TargetingSpec { [k: string]: unknown }
interface NamedId { id: string; name: string; subtype?: string }
interface GeoEntry { key: string; name: string; radius?: number; distance_unit?: string }
type SearchKind = 'interest' | 'job' | 'behavior' | 'employer' | 'geo'
interface SearchHit {
  id: string; name: string; type?: string; country_code?: string
  region?: string; path?: string; audience?: number
}

export interface TargetingEditorProps {
  value: TargetingSpec | null | undefined
  onChange: (next: TargetingSpec) => void
  disabled?: boolean
  /** Sonderkategorie Wohnen (HOUSING): Sperren wie oben beschrieben */
  housing?: boolean
  /** Gesperrte Bereiche als übersetzte Kurztexte (für Banner/Hinweise der Hülle) */
  onLocks?: (locks: string[]) => void
  /** Sprachen (locales) bearbeiten */
  showLocales?: boolean
  /** Einzelne Platzierungs-Positionen bearbeiten (nur bei manueller Plattform-Wahl) */
  showPositions?: boolean
}

const PLATFORMS = [
  { key: 'facebook',         label: 'Facebook' },
  { key: 'instagram',        label: 'Instagram' },
  { key: 'audience_network', label: 'Audience Network' },
  { key: 'messenger',        label: 'Messenger' },
]
// Mit Positionen: alle Plattformen aus metaSpec (inkl. Threads), Markennamen unübersetzt
const PLATFORM_LABEL: Record<PublisherPlatform, string> = {
  facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', messenger: 'Messenger', audience_network: 'Audience Network',
}
const PLATFORMS_ALLE = PUBLISHER_PLATFORMS.map(p => ({ key: p as string, label: PLATFORM_LABEL[p] }))

/**
 * Kleinster Umkreis um eine Stadt laut Meta: 17 km (10 Meilen), Bereich 17 bis 80 km.
 * Das Wohnen-Minimum von 15 km gilt zusätzlich und nur für Adressen und Pins.
 */
const STADT_MIN_RADIUS_KM = 17

/** Umkreis-Stufen um Städte (km); die Liste beginnt bei Metas Städte-Minimum von 17 km */
const RADIUS_KM = [17, 20, 25, 30, 40, 50, 80]

/** Sprachen als Meta-adlocale-Schlüssel (Deutsch = 5 laut Meta-Doku). Weitere per ID. */
const SPRACHEN: ReadonlyArray<{ id: number; key: string; fallback: string }> = [
  { id: 5,    key: 'crm.ads.tgLangDe',    fallback: 'Deutsch' },
  { id: 1001, key: 'crm.ads.tgLangEnAll', fallback: 'Englisch (alle)' },
  { id: 24,   key: 'crm.ads.tgLangEnGb',  fallback: 'Englisch (UK)' },
  { id: 6,    key: 'crm.ads.tgLangEnUs',  fallback: 'Englisch (USA)' },
]
const MAX_LOCALES = 50

const DETAIL_VERBOTEN = new Set<string>(HOUSING_FORBIDDEN_DETAILED_KEYS)

const radiusKm = (radius: unknown, unit: unknown): number | null =>
  typeof radius === 'number' && Number.isFinite(radius) ? (unit === 'mile' ? radius * 1.609344 : radius) : null

const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Wohnen-Regeln auf ein targeting-Objekt anwenden (Spiegel von applyHousing für
 * eine einzelne Anzeigengruppe): Alter 18-65, ohne Geschlecht, Ortsausschlüsse,
 * Ausschlüsse, verbotenes Detail-Targeting, kleinräumige Orte und Lookalikes;
 * Umkreis mindestens 15 km (Städte 17 km); Advantage+ Zielgruppe ausdrücklich 0 oder 1.
 */
function wohnenBereinigen(t: TargetingSpec, istLookalike: (a: NamedId) => boolean): TargetingSpec {
  const n: TargetingSpec = { ...t, age_min: HOUSING_AGE_MIN, age_max: HOUSING_AGE_MAX }
  for (const k of ['age_range', 'genders', 'excluded_geo_locations', 'exclusions', ...HOUSING_FORBIDDEN_DETAILED_KEYS]) delete n[k]

  if (istObjekt(n.geo_locations)) {
    const g: Record<string, unknown> = { ...n.geo_locations }
    for (const k of HOUSING_FORBIDDEN_GEO_KEYS) delete g[k]
    for (const k of ['cities', 'places', 'custom_locations'] as const) {
      const list = g[k]
      if (!Array.isArray(list)) continue
      g[k] = list.map(it => {
        if (!istObjekt(it)) return it
        const km = radiusKm(it.radius, it.distance_unit)
        const min = k === 'cities' ? Math.max(STADT_MIN_RADIUS_KM, HOUSING_MIN_RADIUS_KM) : HOUSING_MIN_RADIUS_KM
        const zuKlein = km !== null && km < min - 0.01
        return zuKlein || (km === null && k === 'custom_locations')
          ? { ...it, radius: min, distance_unit: 'kilometer' }
          : it
      })
    }
    n.geo_locations = g
  }

  if (Array.isArray(n.flexible_spec)) {
    const gruppen = (n.flexible_spec as unknown[])
      .map(grp => {
        const ng: Record<string, unknown> = {}
        if (istObjekt(grp)) for (const [k, v] of Object.entries(grp)) if (!DETAIL_VERBOTEN.has(k)) ng[k] = v
        return ng
      })
      .filter(grp => Object.values(grp).some(v => (Array.isArray(v) ? v.length > 0 : v != null)))
    if (gruppen.length) n.flexible_spec = gruppen
    else delete n.flexible_spec
  }

  for (const k of ['custom_audiences', 'excluded_custom_audiences'] as const) {
    const list = n[k]
    if (!Array.isArray(list)) continue
    const kept = (list as NamedId[]).filter(a => !istLookalike(a))
    if (kept.length) n[k] = kept
    else delete n[k]
  }
  if (istObjekt(n.targeting_relaxation_types) && 'lookalike' in n.targeting_relaxation_types) {
    const r = { ...n.targeting_relaxation_types }
    delete r.lookalike
    if (Object.keys(r).length) n.targeting_relaxation_types = r
    else delete n.targeting_relaxation_types
  }

  const ta: Record<string, unknown> = istObjekt(n.targeting_automation) ? { ...n.targeting_automation } : {}
  delete ta.individual_setting
  if (ta.advantage_audience !== 0 && ta.advantage_audience !== 1) {
    // fehlt = 1 (HP-Standard wie applyHousing); false/'0' aus Altdaten = 0
    ta.advantage_audience = ta.advantage_audience === false || ta.advantage_audience === '0' ? 0 : 1
  }
  n.targeting_automation = ta
  return n
}

// ── Chip mit Entfernen-Kreuz ────────────────────────────────────────────────
function Chip({ label, icon, tone, onRemove, title }: { label: string; icon: string; tone: string; onRemove: () => void; title?: string }) {
  const { t } = useTranslation()
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${tone}`} title={title}>
      {icon} {label}
      <button type="button" onClick={onRemove} className="ml-0.5 opacity-50 hover:opacity-100 leading-none" aria-label={t('crm.ads.tgRemove', 'Entfernen')}>✕</button>
    </span>
  )
}

// ── Suchfeld mit Vorschlagsliste (Meta-Suche) ───────────────────────────────
function SearchBox({ kind, placeholder, onPick, disabled }: {
  kind: SearchKind; placeholder: string; onPick: (hit: SearchHit) => void; disabled?: boolean
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    // Entprellen: Meta-Suche erst 350 ms nach der letzten Eingabe
    const id = ++reqId.current
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
          body: { mode: 'targeting_search', kind, q: q.trim() },
        })
        if (error) throw error
        // Nur die Antwort der zuletzt getippten Anfrage darf gewinnen
        if (id !== reqId.current) return
        setHits(((data as { results?: SearchHit[] })?.results ?? []).slice(0, 25))
        setOpen(true)
      } catch (err) {
        console.error('[TargetingEditor] Suche:', err)
        if (id === reqId.current) setHits([])
      } finally {
        if (id === reqId.current) setBusy(false)
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [q, kind])

  return (
    <div className="relative" ref={boxRef}>
      <input
        value={q} disabled={disabled} placeholder={placeholder}
        onChange={e => setQ(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-gray-50"
      />
      {busy && <span className="absolute right-2.5 top-1.5 text-[11px] text-gray-400">…</span>}
      {open && hits.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {hits.map(h => (
            <button
              key={`${h.type ?? ''}-${h.id}`} type="button"
              onClick={() => { onPick(h); setQ(''); setHits([]); setOpen(false) }}
              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-orange-50 border-b border-gray-50 last:border-0"
            >
              <span className="text-gray-800">{h.name}</span>
              {h.path && <span className="text-gray-400"> · {h.path}</span>}
              {h.type && <span className="text-gray-400"> · {h.type}</span>}
              {h.region && <span className="text-gray-400"> · {h.region}</span>}
              {h.audience != null && (
                <span className="text-gray-400"> · ~{new Intl.NumberFormat('de-DE', { notation: 'compact' }).format(h.audience)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Editor ──────────────────────────────────────────────────────────────────
export default function TargetingEditor({ value, onChange, disabled, housing = false, onLocks, showLocales = false, showPositions = false }: TargetingEditorProps) {
  const { t } = useTranslation()
  const tg = (value ?? {}) as TargetingSpec
  const [audiences, setAudiences] = useState<NamedId[]>([])
  const [localeId, setLocaleId] = useState('')

  // Custom Audiences des Kontos einmalig laden (Auswahlliste unten)
  useEffect(() => {
    let cancelled = false
    supabase.functions.invoke('meta-ads-tools', { body: { mode: 'custom_audiences' } })
      .then(({ data, error }) => {
        if (error || cancelled) return
        setAudiences((data as { audiences?: NamedId[] })?.audiences ?? [])
      })
      .catch(err => console.error('[TargetingEditor] Custom Audiences:', err))
    return () => { cancelled = true }
  }, [])

  // Lookalike erkennen: subtype am Eintrag oder aus der Kontoliste
  const subtypeById = useMemo(() => new Map(audiences.map(a => [a.id, a.subtype ?? ''])), [audiences])
  const istLookalike = useCallback(
    (a: NamedId) => (a.subtype || subtypeById.get(a.id) || '').toUpperCase() === 'LOOKALIKE',
    [subtypeById],
  )

  /** Setzt Felder auf dem Targeting-Objekt, ohne unbekannte Felder zu verlieren. */
  const patch = useCallback((fields: TargetingSpec) => {
    const next = { ...tg, ...fields }
    onChange(housing ? wohnenBereinigen(next, istLookalike) : next)
  }, [tg, onChange, housing, istLookalike])

  // ── Gesperrte Bereiche melden (nur wenn sich die Liste ändert) ─────────────
  const onLocksRef = useRef(onLocks)
  onLocksRef.current = onLocks
  const locksKey = housing
    ? [
      t('crm.ads.tgLockAge', 'Alter 18 bis 65+'),
      t('crm.ads.tgLockGender', 'Geschlecht'),
      t('crm.ads.tgLockExcludedGeo', 'Ortsausschlüsse'),
      t('crm.ads.tgLockRadius', 'Umkreis um Städte mindestens 17 km, um Adressen 15 km'),
      t('crm.ads.tgLockDetailed', 'Verhalten, Jobtitel, Arbeitgeber'),
      t('crm.ads.tgLockExclusions', 'Ausschlüsse'),
      t('crm.ads.tgLockLookalike', 'Lookalike-Zielgruppen'),
    ].join('|')
    : ''
  useEffect(() => {
    onLocksRef.current?.(locksKey ? locksKey.split('|') : [])
  }, [locksKey])

  // ── abgeleitete Werte ─────────────────────────────────────────────────────
  const ageMin = Number(tg.age_min ?? 18)
  const ageMax = Number(tg.age_max ?? 65)
  const genders = (tg.genders as number[] | undefined) ?? []
  const gender = genders.length === 1 ? (genders[0] === 1 ? 'maenner' : 'frauen') : 'alle'

  const geo = (tg.geo_locations as { countries?: string[]; regions?: GeoEntry[]; cities?: GeoEntry[] } | undefined) ?? {}
  const excludedGeo = (tg.excluded_geo_locations as { countries?: string[] } | undefined) ?? {}

  const flex = (tg.flexible_spec as Array<Record<string, NamedId[]>> | undefined) ?? []
  const group0 = flex[0] ?? {}
  const extraGroups = flex.length > 1 ? flex.length - 1 : 0

  const exclusions = (tg.exclusions as Record<string, NamedId[]> | undefined) ?? {}
  const customAud = (tg.custom_audiences as NamedId[] | undefined) ?? []
  const excludedAud = (tg.excluded_custom_audiences as NamedId[] | undefined) ?? []
  const platforms = tg.publisher_platforms as string[] | undefined
  const automation = tg.targeting_automation as { advantage_audience?: unknown } | undefined
  const advantage = automation?.advantage_audience === 1
  const advantageWert: 0 | 1 | null = automation?.advantage_audience === 1 ? 1 : automation?.advantage_audience === 0 ? 0 : null
  const locales = Array.isArray(tg.locales) ? (tg.locales as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0) : []

  // ── Mutationen ────────────────────────────────────────────────────────────
  const setGeo = (next: typeof geo) => patch({ geo_locations: next })

  const addGeo = (hit: SearchHit) => {
    if (hit.type === 'country' && hit.country_code) {
      const cur = geo.countries ?? []
      if (!cur.includes(hit.country_code)) setGeo({ ...geo, countries: [...cur, hit.country_code] })
    } else if (hit.type === 'region') {
      const cur = geo.regions ?? []
      if (!cur.some(r => r.key === hit.id)) setGeo({ ...geo, regions: [...cur, { key: hit.id, name: hit.name }] })
    } else if (hit.type === 'city') {
      const cur = geo.cities ?? []
      // Wohnen: Städte immer mit Umkreis, mindestens 17 km (Metas Städte-Minimum)
      const city: GeoEntry = housing
        ? { key: hit.id, name: hit.name, radius: Math.max(STADT_MIN_RADIUS_KM, HOUSING_MIN_RADIUS_KM), distance_unit: 'kilometer' }
        : { key: hit.id, name: hit.name }
      if (!cur.some(c => c.key === hit.id)) setGeo({ ...geo, cities: [...cur, city] })
    }
  }

  const setCityRadius = (key: string, km: number | null) => {
    setGeo({
      ...geo,
      cities: (geo.cities ?? []).map(c => {
        if (c.key !== key) return c
        const rest: GeoEntry = { ...c }
        delete rest.radius
        delete rest.distance_unit
        return km == null ? rest : { ...rest, radius: km, distance_unit: 'kilometer' }
      }),
    })
  }

  /** Fügt einen Treffer in eine Liste der ersten flexible_spec-Gruppe ein. */
  const addToGroup = (field: string, hit: SearchHit) => {
    const cur = group0[field] ?? []
    if (cur.some(x => x.id === hit.id)) return
    const nextGroup = { ...group0, [field]: [...cur, { id: hit.id, name: hit.name }] }
    patch({ flexible_spec: [nextGroup, ...flex.slice(1)] })
  }
  const removeFromGroup = (field: string, id: string) => {
    const next = (group0[field] ?? []).filter(x => x.id !== id)
    const nextGroup = { ...group0 }
    if (next.length) nextGroup[field] = next
    else delete nextGroup[field]
    const rest = flex.slice(1)
    // Leere erste Gruppe komplett entfernen, sonst lehnt Meta das Targeting ab
    const groups = Object.keys(nextGroup).length ? [nextGroup, ...rest] : rest
    patch(groups.length ? { flexible_spec: groups } : { flexible_spec: undefined })
  }

  const addExclusion = (hit: SearchHit) => {
    const cur = exclusions.interests ?? []
    if (cur.some(x => x.id === hit.id)) return
    patch({ exclusions: { ...exclusions, interests: [...cur, { id: hit.id, name: hit.name }] } })
  }
  const removeExclusion = (id: string) => {
    const next = (exclusions.interests ?? []).filter(x => x.id !== id)
    const nextEx = { ...exclusions }
    if (next.length) nextEx.interests = next
    else delete nextEx.interests
    patch({ exclusions: Object.keys(nextEx).length ? nextEx : undefined })
  }

  const plattformListe = showPositions ? PLATFORMS_ALLE : PLATFORMS

  const togglePlatform = (key: string) => {
    const cur = platforms ?? plattformListe.map(p => p.key)
    const next = cur.includes(key) ? cur.filter(p => p !== key) : [...cur, key]
    if (!showPositions) {
      // Leere Auswahl wäre bei Meta ungültig - dann lieber zurück auf Automatisch
      patch({ publisher_platforms: next.length ? next : undefined })
      return
    }
    // Positionen nur für gewählte Plattformen behalten
    const fields: TargetingSpec = { publisher_platforms: next.length ? next : undefined }
    for (const pl of PUBLISHER_PLATFORMS) {
      if (!next.length || !next.includes(pl)) fields[POSITION_FIELD_BY_PLATFORM[pl]] = undefined
    }
    patch(fields)
  }

  const togglePosition = (pl: PublisherPlatform, pos: string) => {
    const field = POSITION_FIELD_BY_PLATFORM[pl]
    const alle = POSITION_OPTIONS[pl].map(o => o.value)
    const cur = Array.isArray(tg[field]) ? (tg[field] as string[]) : alle
    const next = cur.includes(pos) ? cur.filter(x => x !== pos) : [...cur, pos]
    const gueltig = alle.filter(x => next.includes(x))
    if (!gueltig.length) return
    // Alle gewählt = Feld weglassen (Meta nimmt dann alle Positionen der Plattform)
    patch({ [field]: gueltig.length === alle.length ? undefined : gueltig })
  }

  const setLocales = (next: number[]) => patch({ locales: next.length ? next : undefined })
  const addLocale = (id: number) => {
    if (!Number.isInteger(id) || id <= 0 || locales.includes(id) || locales.length >= MAX_LOCALES) return
    setLocales([...locales, id])
  }
  const sprachName = (id: number) => {
    const s = SPRACHEN.find(x => x.id === id)
    return s ? t(s.key, s.fallback) : t('crm.ads.tgLocaleUnknown', 'Sprache {{id}}', { id })
  }

  const setAdvantage = (v: 0 | 1) =>
    patch({ targeting_automation: { ...(istObjekt(tg.targeting_automation) ? tg.targeting_automation : {}), advantage_audience: v } })

  const section = 'rounded-lg border border-gray-200 p-2.5'
  const label = 'text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5'
  const hinweisWohnen = 'mt-1.5 text-[11px] text-hp-navy/70'

  // Wohnen: nur erlaubte Felder der ersten Gruppe zeigen (der Rest fällt beim nächsten Speichern weg)
  const gruppenFelder = Object.entries(group0).filter(([field]) => !housing || !DETAIL_VERBOTEN.has(field))
  const radiusOptionen = (aktuell: number | null) => {
    const r = aktuell != null ? Math.round(aktuell) : null
    return r != null && !RADIUS_KM.includes(r) ? [...RADIUS_KM, r].sort((a, b) => a - b) : RADIUS_KM
  }

  return (
    <div className="space-y-2.5">
      {/* Alter + Geschlecht */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgDemographics', 'Alter & Geschlecht')}</p>
        {housing ? (
          <p className="text-xs text-gray-700">
            🔒 {t('crm.ads.tgHousingAge', 'Alter 18 bis 65+, alle Geschlechter (Sonderkategorie Wohnen, nicht änderbar)')}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <NumberStepper value={ageMin} onChange={v => patch({ age_min: Math.min(v, ageMax) })} min={13} max={65} className="w-28" />
            <span className="text-gray-400 text-xs">-</span>
            <NumberStepper value={ageMax} onChange={v => patch({ age_max: Math.max(v, ageMin) })} min={13} max={65} className="w-28" />
            <div className="w-40">
              <CustomSelect
                value={gender} disabled={disabled}
                onChange={v => patch({ genders: v === 'maenner' ? [1] : v === 'frauen' ? [2] : undefined })}
                options={[
                  { value: 'alle',    label: t('crm.ads.tgAll', 'Alle Geschlechter') },
                  { value: 'maenner', label: t('crm.ads.tgMen', 'Männer') },
                  { value: 'frauen',  label: t('crm.ads.tgWomen', 'Frauen') },
                ]}
              />
            </div>
          </div>
        )}
      </div>

      {/* Orte */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgLocations', 'Orte')}</p>
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {(geo.countries ?? []).map(c => (
            <Chip key={`c-${c}`} icon="🌍" label={c} tone="bg-white border-gray-200"
              onRemove={() => setGeo({ ...geo, countries: (geo.countries ?? []).filter(x => x !== c) })} />
          ))}
          {(geo.regions ?? []).map(r => (
            <Chip key={`r-${r.key}`} icon="📍" label={r.name} tone="bg-white border-gray-200"
              onRemove={() => setGeo({ ...geo, regions: (geo.regions ?? []).filter(x => x.key !== r.key) })} />
          ))}
          {(geo.cities ?? []).map(c => {
            const km = radiusKm(c.radius, c.distance_unit)
            return (
              <span key={`ci-${c.key}`} className="inline-flex items-center gap-1">
                <Chip icon="🏙" label={c.name} tone="bg-white border-gray-200"
                  onRemove={() => setGeo({ ...geo, cities: (geo.cities ?? []).filter(x => x.key !== c.key) })} />
                {housing && (
                  <select
                    aria-label={t('crm.ads.tgRadius', 'Umkreis')} disabled={disabled}
                    value={km != null ? String(Math.round(km)) : ''}
                    onChange={e => setCityRadius(c.key, e.target.value ? Number(e.target.value) : null)}
                    className="rounded-md border border-gray-200 bg-white px-1 py-0.5 text-[11px] text-gray-700"
                  >
                    <option value="">{t('crm.ads.tgRadiusStandard', 'Standard (Meta)')}</option>
                    {radiusOptionen(km).map(r => (
                      <option key={r} value={String(r)} disabled={r < STADT_MIN_RADIUS_KM}>+{r} km</option>
                    ))}
                  </select>
                )}
              </span>
            )
          })}
          {!(geo.countries?.length || geo.regions?.length || geo.cities?.length) && (
            <span className="text-[11px] text-red-600">{t('crm.ads.tgNoGeo', 'Mindestens ein Ort ist Pflicht')}</span>
          )}
        </div>
        <SearchBox kind="geo" disabled={disabled} onPick={addGeo}
          placeholder={t('crm.ads.tgGeoSearch', 'Land, Region oder Stadt suchen …')} />
        {!housing && (excludedGeo.countries ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {(excludedGeo.countries ?? []).map(c => (
              <Chip key={`xc-${c}`} icon="🚫🌍" label={c} tone="bg-red-50 border-red-200 text-red-700"
                onRemove={() => patch({ excluded_geo_locations: { ...excludedGeo, countries: (excludedGeo.countries ?? []).filter(x => x !== c) } })} />
            ))}
          </div>
        )}
        {housing && (
          <p className={hinweisWohnen}>
            {t('crm.ads.tgHousingGeo', 'Wohnen: keine Ortsausschlüsse, keine PLZ, Umkreis um Städte mindestens 17 km.')}
          </p>
        )}
      </div>

      {/* Sprachen (optional) */}
      {showLocales && (
        <div className={section}>
          <p className={label}>{t('crm.ads.tgLocales', 'Sprachen')}</p>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {locales.map(id => (
              <Chip key={`lo-${id}`} icon="🗣" label={sprachName(id)} tone="bg-white border-gray-200"
                onRemove={() => setLocales(locales.filter(x => x !== id))} />
            ))}
            {!locales.length && <span className="text-[11px] text-gray-400">{t('crm.ads.tgLocalesAll', 'Alle Sprachen')}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="w-48">
              <CustomSelect
                value="" disabled={disabled || locales.length >= MAX_LOCALES}
                placeholder={t('crm.ads.tgLocaleAdd', 'Sprache hinzufügen …')}
                onChange={v => addLocale(Number(v))}
                options={SPRACHEN.filter(s => !locales.includes(s.id)).map(s => ({ value: String(s.id), label: t(s.key, s.fallback) }))}
              />
            </div>
            <input
              value={localeId} inputMode="numeric" disabled={disabled}
              onChange={e => setLocaleId(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => { if (e.key === 'Enter' && localeId) { e.preventDefault(); addLocale(Number(localeId)); setLocaleId('') } }}
              placeholder={t('crm.ads.tgLocaleId', 'Meta-Sprach-ID')}
              aria-label={t('crm.ads.tgLocaleId', 'Meta-Sprach-ID')}
              className="w-32 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-gray-50"
            />
            <button type="button" disabled={disabled || !localeId}
              onClick={() => { addLocale(Number(localeId)); setLocaleId('') }}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {t('crm.ads.tgLocaleIdAdd', 'Hinzufügen')}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            {t('crm.ads.tgLocalesHint', 'Leer = alle Sprachen. Deutsch hat bei Meta die ID 5.')}
          </p>
        </div>
      )}

      {/* Interessen / Jobs / Verhalten / Arbeitgeber */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgDetailed', 'Detaillierte Zielgruppe')}</p>
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {gruppenFelder.map(([field, items]) =>
            (items ?? []).map(it => (
              <Chip key={`${field}-${it.id}`} label={it.name}
                icon={field === 'interests' ? '💡' : field === 'work_positions' ? '💼' : field === 'behaviors' ? '🧭' : '🏢'}
                tone="bg-blue-50 border-blue-200 text-blue-800"
                onRemove={() => removeFromGroup(field, it.id)} />
            )),
          )}
        </div>
        {housing ? (
          <>
            <SearchBox kind="interest" disabled={disabled} onPick={h => addToGroup('interests', h)}
              placeholder={`💡 ${t('crm.ads.tgInterests', 'Interessen')}`} />
            <p className={hinweisWohnen}>
              {t('crm.ads.tgHousingDetailed', 'Wohnen: Verhalten, Jobtitel und Arbeitgeber sind nicht erlaubt. Interessen prüft Meta beim Prüfen.')}
            </p>
          </>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            <SearchBox kind="interest" disabled={disabled} onPick={h => addToGroup('interests', h)}
              placeholder={`💡 ${t('crm.ads.tgInterests', 'Interessen')}`} />
            <SearchBox kind="job" disabled={disabled} onPick={h => addToGroup('work_positions', h)}
              placeholder={`💼 ${t('crm.ads.tgJobs', 'Jobtitel')}`} />
            <SearchBox kind="behavior" disabled={disabled} onPick={h => addToGroup('behaviors', h)}
              placeholder={`🧭 ${t('crm.ads.tgBehaviors', 'Verhalten')}`} />
            <SearchBox kind="employer" disabled={disabled} onPick={h => addToGroup('work_employers', h)}
              placeholder={`🏢 ${t('crm.ads.tgEmployers', 'Arbeitgeber')}`} />
          </div>
        )}
        {extraGroups > 0 && (
          <p className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            {t('crm.ads.tgExtraGroups', 'Diese Zielgruppe hat {{count}} weitere Bedingungs-Gruppe(n) aus dem Meta-Werbeanzeigenmanager. Sie bleiben unverändert erhalten, sind hier aber nicht bearbeitbar.', { count: extraGroups })}
          </p>
        )}
      </div>

      {/* Ausschlüsse (unter Wohnen nicht erlaubt) */}
      {!housing && (
        <div className={section}>
          <p className={label}>{t('crm.ads.tgExclusions', 'Ausschließen')}</p>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {(exclusions.interests ?? []).map(it => (
              <Chip key={`ex-${it.id}`} icon="🚫" label={it.name} tone="bg-red-50 border-red-200 text-red-700"
                onRemove={() => removeExclusion(it.id)} />
            ))}
          </div>
          <SearchBox kind="interest" disabled={disabled} onPick={addExclusion}
            placeholder={t('crm.ads.tgExcludeSearch', 'Interesse zum Ausschließen suchen …')} />
        </div>
      )}

      {/* Custom Audiences */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgCustomAudiences', 'Eigene Zielgruppen')}</p>
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {customAud.map(a => {
            const verboten = housing && istLookalike(a)
            return (
              <Chip key={`ca-${a.id}`} icon="👥" label={a.name}
                tone={verboten ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-800'}
                title={verboten ? t('crm.ads.tgLookalikeHousing', 'Lookalike: unter Wohnen nicht erlaubt, wird beim Speichern entfernt') : undefined}
                onRemove={() => patch({ custom_audiences: customAud.filter(x => x.id !== a.id).length ? customAud.filter(x => x.id !== a.id) : undefined })} />
            )
          })}
          {excludedAud.map(a => (
            <Chip key={`cax-${a.id}`} icon="🚫👥" label={a.name} tone="bg-red-50 border-red-200 text-red-700"
              onRemove={() => patch({ excluded_custom_audiences: excludedAud.filter(x => x.id !== a.id).length ? excludedAud.filter(x => x.id !== a.id) : undefined })} />
          ))}
        </div>
        {audiences.length > 0 ? (
          <div className="flex gap-1.5">
            <div className="flex-1">
              <CustomSelect
                value="" disabled={disabled}
                placeholder={t('crm.ads.tgAddAudience', 'Zielgruppe hinzufügen …')}
                onChange={id => {
                  const a = audiences.find(x => x.id === id)
                  if (a && !customAud.some(x => x.id === a.id)) patch({ custom_audiences: [...customAud, { id: a.id, name: a.name }] })
                }}
                options={audiences
                  .filter(a => !customAud.some(x => x.id === a.id) && !(housing && istLookalike(a)))
                  .map(a => ({ value: a.id, label: a.name }))}
              />
            </div>
            <div className="flex-1">
              <CustomSelect
                value="" disabled={disabled}
                placeholder={t('crm.ads.tgExcludeAudience', 'Zielgruppe ausschließen …')}
                onChange={id => {
                  const a = audiences.find(x => x.id === id)
                  if (a && !excludedAud.some(x => x.id === a.id)) patch({ excluded_custom_audiences: [...excludedAud, { id: a.id, name: a.name }] })
                }}
                options={audiences
                  .filter(a => !excludedAud.some(x => x.id === a.id) && !(housing && istLookalike(a)))
                  .map(a => ({ value: a.id, label: a.name }))}
              />
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-gray-400">{t('crm.ads.tgNoAudiences', 'Keine eigenen Zielgruppen im Werbekonto vorhanden.')}</p>
        )}
        {housing && (
          <p className={hinweisWohnen}>{t('crm.ads.tgHousingLookalike', 'Wohnen: Lookalike-Zielgruppen werden nicht angeboten.')}</p>
        )}
      </div>

      {/* Platzierungen + Advantage+ */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgPlacements', 'Platzierungen')}</p>
        <div className="flex flex-wrap gap-3">
          {plattformListe.map(p => (
            <label key={p.key} className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" disabled={disabled}
                checked={platforms ? platforms.includes(p.key) : true}
                onChange={() => togglePlatform(p.key)}
                className="rounded border-gray-300 text-orange-500 focus:ring-orange-300" />
              {p.label}
            </label>
          ))}
        </div>
        {!platforms && <p className="mt-1 text-[11px] text-gray-400">{t('crm.ads.tgAutoPlacement', 'Automatisch - Meta verteilt auf alle Platzierungen.')}</p>}

        {/* Einzelne Positionen (optional, nur bei manueller Plattform-Wahl) */}
        {showPositions && platforms && platforms.length > 0 && (
          <div className="mt-2 space-y-2">
            {PUBLISHER_PLATFORMS.filter(pl => platforms.includes(pl)).map(pl => {
              const field = POSITION_FIELD_BY_PLATFORM[pl]
              const optionen = POSITION_OPTIONS[pl]
              const gewaehlt = Array.isArray(tg[field]) ? (tg[field] as string[]) : null
              const anzahl = gewaehlt ? optionen.filter(o => gewaehlt.includes(o.value)).length : optionen.length
              return (
                <div key={pl}>
                  <p className="text-[11px] text-gray-500">
                    {PLATFORM_LABEL[pl]}{!gewaehlt && ` · ${t('crm.ads.tgAllPositions', 'alle Positionen')}`}
                  </p>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
                    {optionen.map(o => {
                      const an = gewaehlt ? gewaehlt.includes(o.value) : true
                      return (
                        <label key={o.value} className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
                          <input type="checkbox" checked={an} disabled={disabled || (an && anzahl <= 1)}
                            onChange={() => togglePosition(pl, o.value)}
                            className="rounded border-gray-300 text-orange-500 focus:ring-orange-300" />
                          {t(o.labelKey, o.value)}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {showPositions && !platforms && (
          <p className="mt-1 text-[11px] text-gray-400">
            {t('crm.ads.tgPositionsAuto', 'Einzelne Positionen lassen sich wählen, sobald du Plattformen von Hand auswählst.')}
          </p>
        )}

        {housing ? (
          <div className="mt-2">
            <p className="text-xs text-gray-700">✨ {t('crm.ads.tgAdvantageTitle', 'Advantage+ Zielgruppe')}</p>
            <div role="radiogroup" aria-label={t('crm.ads.tgAdvantageTitle', 'Advantage+ Zielgruppe')}
              className="mt-1 inline-flex flex-wrap overflow-hidden rounded-lg border border-gray-200 text-xs">
              {([1, 0] as const).map(v => (
                <button key={v} type="button" role="radio" aria-checked={advantageWert === v} disabled={disabled}
                  onClick={() => setAdvantage(v)}
                  className={`px-3 py-1.5 ${advantageWert === v ? 'bg-hp-navy text-white' : 'bg-white text-gray-700 hover:bg-gray-50'} disabled:opacity-50`}>
                  {v === 1
                    ? t('crm.ads.tgAdvantageOn', 'An: Meta darf über die Auswahl hinaus ausspielen')
                    : t('crm.ads.tgAdvantageOff', 'Aus: nur die Auswahl')}
                </button>
              ))}
            </div>
            {advantageWert === null && (
              <p className="mt-1 text-[11px] text-amber-700">
                {t('crm.ads.tgAdvantageUnset', 'Noch nicht festgelegt: bei Wohnen muss es ausdrücklich an oder aus sein (Standard beim Speichern: an).')}
              </p>
            )}
          </div>
        ) : (
          <label className="mt-2 flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
            <input type="checkbox" disabled={disabled} checked={advantage}
              onChange={e => patch({ targeting_automation: e.target.checked ? { advantage_audience: 1 } : { advantage_audience: 0 } })}
              className="rounded border-gray-300 text-orange-500 focus:ring-orange-300" />
            ✨ {t('crm.ads.tgAdvantage', 'Advantage+ Zielgruppe (Meta darf über die Auswahl hinaus ausspielen)')}
          </label>
        )}
      </div>
    </div>
  )
}
