import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TargetingEditor from '../../TargetingEditor'
import {
  LOCATION_TYPE_OPTIONS, applyHousing, draftIsHec,
  type AdsetDraft, type HousingChange, type ManualPlacements, type Placements, type PublisherPlatform, type TargetingSpec,
} from '../../../../lib/metaSpec'
import { FeldHinweise } from './PruefPanel'
import { Schalter, SperrBanner, feldId, feldLabel } from './KampagnenFormular'
import { setzeAnzeigengruppe, useAssistent } from './useEntwurf'

// ── Zielgruppe einer Anzeigengruppe mit Sonderkategorie Wohnen ───────────────
// Hülle um den bestehenden TargetingEditor: zeigt die Wohnen-Sperren (Banner,
// Alter 18 bis 65+ und Geschlecht fest), erzwingt sie nach jeder Änderung über
// applyHousing und meldet, was dabei entfernt wurde. Plattform-Haken des
// Editors landen in placements (der Entwurf führt Platzierungen getrennt vom
// targeting). housing/onLocks reicht die Hülle an den Editor weiter, sobald
// er sie kennt (Adapter per Spread, kompiliert auch ohne die neuen Props).

const PLATZ_KEYS = [
  'publisher_platforms', 'facebook_positions', 'instagram_positions', 'threads_positions',
  'messenger_positions', 'audience_network_positions', 'device_platforms',
] as const

// Entfernt: Hinweis zeigen. Gesetzt (Alter, Advantage+): still, das zeigt die Sperre.
const LAUTE_AENDERUNGEN: ReadonlyArray<HousingChange['code']> = [
  'genders_removed', 'geo_type_removed', 'radius_raised', 'excluded_geo_removed', 'detailed_removed',
  'exclusions_removed', 'lookalike_removed', 'individual_setting_removed', 'age_range_removed',
]

export default function ZielgruppeHousing({ adset, disabled }: { adset: AdsetDraft; disabled: boolean }) {
  const { t } = useTranslation()
  const { e } = useAssistent()
  const hec = draftIsHec(e.spec)
  const node = adset.key
  const [entfernt, setEntfernt] = useState<HousingChange[]>([])
  const [editorSperren, setEditorSperren] = useState<string[]>([])

  const sperrHinweise = useMemo(() => {
    const keys: string[] = []
    for (const l of e.housing.locks) if (l.node === node && keys.indexOf(l.noteKey) < 0) keys.push(l.noteKey)
    return keys
  }, [e.housing.locks, node])

  // Editor sieht Platzierungen wie früher im targeting
  const wert = useMemo(() => {
    const v: Record<string, unknown> = { ...adset.targeting }
    if (adset.placements.mode === 'manual') v.publisher_platforms = adset.placements.publisher_platforms.slice()
    return v
  }, [adset.targeting, adset.placements])

  const aendern = (next: Record<string, unknown>) => {
    const rest: Record<string, unknown> = { ...next }
    for (const k of PLATZ_KEYS) delete rest[k]
    const targeting = { ...rest, geo_locations: (rest.geo_locations as TargetingSpec['geo_locations'] | undefined) ?? {} } as TargetingSpec

    let placements: Placements = adset.placements
    const pp = next.publisher_platforms
    if (Array.isArray(pp)) {
      const plats = pp.filter((x): x is PublisherPlatform => typeof x === 'string') as PublisherPlatform[]
      const alt: ManualPlacements | null = adset.placements.mode === 'manual' ? adset.placements : null
      const m: ManualPlacements = { mode: 'manual', publisher_platforms: plats }
      if (alt) {
        if (alt.facebook_positions && plats.indexOf('facebook') >= 0) m.facebook_positions = alt.facebook_positions
        if (alt.instagram_positions && plats.indexOf('instagram') >= 0) m.instagram_positions = alt.instagram_positions
        if (alt.threads_positions && plats.indexOf('threads') >= 0) m.threads_positions = alt.threads_positions
        if (alt.messenger_positions && plats.indexOf('messenger') >= 0) m.messenger_positions = alt.messenger_positions
        if (alt.audience_network_positions && plats.indexOf('audience_network') >= 0) m.audience_network_positions = alt.audience_network_positions
        if (alt.device_platforms) m.device_platforms = alt.device_platforms
      }
      placements = m
    } else if ('publisher_platforms' in next && pp === undefined && adset.placements.mode === 'manual') {
      placements = { mode: 'advantage' }
    }

    // Was würde Wohnen entfernen? (gleiche Regel wie beim Speichern)
    if (hec) {
      const probe = applyHousing({ ...e.spec, adsets: [{ ...adset, targeting }], ads: [] })
      const laut = probe.changes.filter(ch => LAUTE_AENDERUNGEN.indexOf(ch.code) >= 0)
      setEntfernt(laut)
    }
    e.update(d => setzeAnzeigengruppe(d, node, { targeting, placements }))
  }

  const ortTypen = adset.targeting?.geo_locations?.location_types ?? []
  const setzeOrtTyp = (typ: string, an: boolean) => {
    const neu = an ? [...ortTypen.filter(x => x !== typ), typ] : ortTypen.filter(x => x !== typ)
    e.update(d => setzeAnzeigengruppe(d, node, {
      targeting: { ...adset.targeting, geo_locations: { ...(adset.targeting?.geo_locations ?? {}), location_types: neu.length ? neu : ['home', 'recent'] } },
    }))
  }

  // Adapter: neue Props des TargetingEditors (housing, onLocks) per Spread
  const editorZusatz = { housing: hec, onLocks: (l: string[]) => setEditorSperren(l), showLocales: true }

  return (
    <div className="space-y-3">
      {hec && (
        <SperrBanner>
          <p className="font-semibold">{t('crm.werbung.meta.housing.banner', 'Sonderkategorie Wohnen: Meta erlaubt nur breite Zielgruppen. Alter, Geschlecht, PLZ, Ortsausschlüsse und Lookalikes sind gesperrt.')}</p>
          {/* Liste: was der Editor selbst sperrt (seine Texte), sonst die Hinweise aus metaSpec */}
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {editorSperren.length > 0
              ? editorSperren.map(x => <li key={x}>{x}</li>)
              : sperrHinweise.map(k => <li key={k}>{t(k, k)}</li>)}
          </ul>
        </SperrBanner>
      )}

      {entfernt.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <p className="font-semibold">{t('crm.werbung.builder.zielgruppe.entfernt', 'Wegen Wohnen automatisch angepasst:')}</p>
          <ul className="mt-0.5 list-disc pl-4">
            {entfernt.map((ch, i) => <li key={`${ch.code}-${i}`}>{t(ch.messageKey, ch.code)}</li>)}
          </ul>
        </div>
      )}

      {/* Alter und Geschlecht zeigt der Editor im Wohnen-Modus gesperrt an; die Ids sind Sprungziele der Prüfliste */}
      <div id={feldId('adset.targeting.age')}>
        <div id={feldId('adset.targeting.genders')}>
          <div id={feldId('adset.targeting.geo_locations')}>
            <TargetingEditor value={wert} onChange={aendern} disabled={disabled} {...editorZusatz} />
          </div>
        </div>
      </div>

      <div id={feldId('adset.targeting.location_types')}>
        <p className="mb-1 text-[11px] text-gray-500">{feldLabel(t, 'adset.targeting.location_types', 'Standort-Typ')}</p>
        <div className="flex flex-wrap gap-4">
          {LOCATION_TYPE_OPTIONS.map(o => (
            <Schalter key={o.value} checked={ortTypen.indexOf(o.value) >= 0} disabled={disabled}
              onChange={v => setzeOrtTyp(o.value, v)} label={t(o.labelKey, o.value)} />
          ))}
        </div>
      </div>

      <FeldHinweise node={node} felder={[
        'adset.targeting', 'adset.targeting.geo_locations', 'adset.targeting.age', 'adset.targeting.genders',
        'adset.targeting.locales', 'adset.targeting.detailed', 'adset.targeting.custom_audiences',
        'adset.targeting.excluded_custom_audiences', 'adset.targeting.excluded_geo_locations',
        'adset.targeting.advantage_audience', 'adset.targeting.location_types',
      ]} />
    </div>
  )
}
