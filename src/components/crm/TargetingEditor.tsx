/**
 * TargetingEditor — Meta-Zielgruppe einer Anzeigengruppe bearbeiten.
 *
 * Arbeitet direkt auf Metas targeting-Objekt, damit das Speichern eine reine
 * Durchreiche ist. WICHTIG: Beim Speichern werden die Original-Felder gespreadet
 * und nur die hier verwalteten überschrieben — Meta-Targeting enthält Felder,
 * die wir bewusst nicht anzeigen (locales, device_platforms, …), und die dürfen
 * durch eine Bearbeitung nicht verloren gehen.
 *
 * Mehrere flexible_spec-Gruppen (verschachteltes UND/ODER) kann Meta abbilden,
 * dieser Editor bearbeitet nur die erste. Weitere Gruppen bleiben unangetastet
 * und werden als Hinweis angezeigt, statt sie stillschweigend zu verschlucken.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'
import { supabase } from '../../lib/supabase'

export interface TargetingSpec { [k: string]: unknown }
interface NamedId { id: string; name: string }
interface GeoEntry { key: string; name: string }
type SearchKind = 'interest' | 'job' | 'behavior' | 'employer' | 'geo'
interface SearchHit {
  id: string; name: string; type?: string; country_code?: string
  region?: string; path?: string; audience?: number
}

const PLATFORMS = [
  { key: 'facebook',         label: 'Facebook' },
  { key: 'instagram',        label: 'Instagram' },
  { key: 'audience_network', label: 'Audience Network' },
  { key: 'messenger',        label: 'Messenger' },
]

// ── Chip mit Entfernen-Kreuz ────────────────────────────────────────────────
function Chip({ label, icon, tone, onRemove }: { label: string; icon: string; tone: string; onRemove: () => void }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${tone}`}>
      {icon} {label}
      <button type="button" onClick={onRemove} className="ml-0.5 opacity-50 hover:opacity-100 leading-none" aria-label="Entfernen">✕</button>
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
export default function TargetingEditor({ value, onChange, disabled }: {
  value: TargetingSpec | null | undefined
  onChange: (next: TargetingSpec) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const tg = (value ?? {}) as TargetingSpec
  const [audiences, setAudiences] = useState<Array<{ id: string; name: string }>>([])

  // Custom Audiences des Kontos einmalig laden (Auswahlliste unten)
  useEffect(() => {
    let cancelled = false
    supabase.functions.invoke('meta-ads-tools', { body: { mode: 'custom_audiences' } })
      .then(({ data, error }) => {
        if (error || cancelled) return
        setAudiences((data as { audiences?: Array<{ id: string; name: string }> })?.audiences ?? [])
      })
      .catch(err => console.error('[TargetingEditor] Custom Audiences:', err))
    return () => { cancelled = true }
  }, [])

  /** Setzt Felder auf dem Targeting-Objekt, ohne unbekannte Felder zu verlieren. */
  const patch = useCallback((fields: TargetingSpec) => onChange({ ...tg, ...fields }), [tg, onChange])

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
  const advantage = (tg.targeting_automation as { advantage_audience?: number } | undefined)?.advantage_audience === 1

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
      if (!cur.some(c => c.key === hit.id)) setGeo({ ...geo, cities: [...cur, { key: hit.id, name: hit.name }] })
    }
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

  const togglePlatform = (key: string) => {
    const cur = platforms ?? PLATFORMS.map(p => p.key)
    const next = cur.includes(key) ? cur.filter(p => p !== key) : [...cur, key]
    // Leere Auswahl wäre bei Meta ungültig — dann lieber zurück auf Automatisch
    patch({ publisher_platforms: next.length ? next : undefined })
  }

  const section = 'rounded-lg border border-gray-200 p-2.5'
  const label = 'text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5'

  return (
    <div className="space-y-2.5">
      {/* Alter + Geschlecht */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgDemographics', 'Alter & Geschlecht')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <NumberStepper value={ageMin} onChange={v => patch({ age_min: Math.min(v, ageMax) })} min={13} max={65} className="w-28" />
          <span className="text-gray-400 text-xs">–</span>
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
          {(geo.cities ?? []).map(c => (
            <Chip key={`ci-${c.key}`} icon="🏙" label={c.name} tone="bg-white border-gray-200"
              onRemove={() => setGeo({ ...geo, cities: (geo.cities ?? []).filter(x => x.key !== c.key) })} />
          ))}
          {!(geo.countries?.length || geo.regions?.length || geo.cities?.length) && (
            <span className="text-[11px] text-red-600">{t('crm.ads.tgNoGeo', 'Mindestens ein Ort ist Pflicht')}</span>
          )}
        </div>
        <SearchBox kind="geo" disabled={disabled} onPick={addGeo}
          placeholder={t('crm.ads.tgGeoSearch', 'Land, Region oder Stadt suchen …')} />
        {(excludedGeo.countries ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {(excludedGeo.countries ?? []).map(c => (
              <Chip key={`xc-${c}`} icon="🚫🌍" label={c} tone="bg-red-50 border-red-200 text-red-700"
                onRemove={() => patch({ excluded_geo_locations: { ...excludedGeo, countries: (excludedGeo.countries ?? []).filter(x => x !== c) } })} />
            ))}
          </div>
        )}
      </div>

      {/* Interessen / Jobs / Verhalten / Arbeitgeber */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgDetailed', 'Detaillierte Zielgruppe')}</p>
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {Object.entries(group0).map(([field, items]) =>
            (items ?? []).map(it => (
              <Chip key={`${field}-${it.id}`} label={it.name}
                icon={field === 'interests' ? '💡' : field === 'work_positions' ? '💼' : field === 'behaviors' ? '🧭' : '🏢'}
                tone="bg-blue-50 border-blue-200 text-blue-800"
                onRemove={() => removeFromGroup(field, it.id)} />
            )),
          )}
        </div>
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
        {extraGroups > 0 && (
          <p className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            {t('crm.ads.tgExtraGroups', 'Diese Zielgruppe hat {{count}} weitere Bedingungs-Gruppe(n) aus dem Meta-Werbeanzeigenmanager. Sie bleiben unverändert erhalten, sind hier aber nicht bearbeitbar.', { count: extraGroups })}
          </p>
        )}
      </div>

      {/* Ausschlüsse */}
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

      {/* Custom Audiences */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgCustomAudiences', 'Eigene Zielgruppen')}</p>
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {customAud.map(a => (
            <Chip key={`ca-${a.id}`} icon="👥" label={a.name} tone="bg-green-50 border-green-200 text-green-800"
              onRemove={() => patch({ custom_audiences: customAud.filter(x => x.id !== a.id).length ? customAud.filter(x => x.id !== a.id) : undefined })} />
          ))}
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
                options={audiences.filter(a => !customAud.some(x => x.id === a.id)).map(a => ({ value: a.id, label: a.name }))}
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
                options={audiences.filter(a => !excludedAud.some(x => x.id === a.id)).map(a => ({ value: a.id, label: a.name }))}
              />
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-gray-400">{t('crm.ads.tgNoAudiences', 'Keine eigenen Zielgruppen im Werbekonto vorhanden.')}</p>
        )}
      </div>

      {/* Platzierungen + Advantage+ */}
      <div className={section}>
        <p className={label}>{t('crm.ads.tgPlacements', 'Platzierungen')}</p>
        <div className="flex flex-wrap gap-3">
          {PLATFORMS.map(p => (
            <label key={p.key} className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" disabled={disabled}
                checked={platforms ? platforms.includes(p.key) : true}
                onChange={() => togglePlatform(p.key)}
                className="rounded border-gray-300 text-orange-500 focus:ring-orange-300" />
              {p.label}
            </label>
          ))}
        </div>
        {!platforms && <p className="mt-1 text-[11px] text-gray-400">{t('crm.ads.tgAutoPlacement', 'Automatisch — Meta verteilt auf alle Platzierungen.')}</p>}
        <label className="mt-2 flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
          <input type="checkbox" disabled={disabled} checked={advantage}
            onChange={e => patch({ targeting_automation: e.target.checked ? { advantage_audience: 1 } : { advantage_audience: 0 } })}
            className="rounded border-gray-300 text-orange-500 focus:ring-orange-300" />
          ✨ {t('crm.ads.tgAdvantage', 'Advantage+ Zielgruppe (Meta darf über die Auswahl hinaus ausspielen)')}
        </label>
      </div>
    </div>
  )
}
