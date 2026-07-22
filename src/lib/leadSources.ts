import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabase'

// ── Deal-/Lead-Quellen ────────────────────────────────────────────────────────
// Eingebaute Quellen stehen im Code (mit ihren Marken-Badges in crmTypes). Sven
// kann im Anlege-Menü zusätzlich eigene Quellen anlegen — die landen in der
// Tabelle crm_lead_sources und erscheinen danach überall im Dropdown. Ihr Badge
// kommt generisch aus channelBadgeFor().

export const ADD_SOURCE_VALUE = '__add_source__'

export const BUILTIN_SOURCES: { value: string; i18nKey: string; fallback: string }[] = [
  { value: 'meta',       i18nKey: 'crm.sources.meta',       fallback: 'META Werbung' },
  { value: 'google',     i18nKey: 'crm.sources.google',     fallback: 'Google' },
  { value: 'youtube',    i18nKey: 'crm.sources.youtube',    fallback: 'YouTube' },
  { value: 'empfehlung', i18nKey: 'crm.sources.empfehlung', fallback: 'Empfehlung' },
  { value: 'sonstiges',  i18nKey: 'crm.sources.sonstiges',  fallback: 'Sonstiges' },
]

export interface CustomSource { value: string; label: string }
type TFn = (key: string, fallback: string) => string

export function useLeadSources() {
  const [custom, setCustom] = useState<CustomSource[]>([])

  const reloadSources = useCallback(async () => {
    const { data, error } = await supabase.from('crm_lead_sources').select('key, label').order('label')
    if (error) { console.warn('[leadSources] load:', error.message); return }
    setCustom(((data ?? []) as { key: string; label: string }[]).map(r => ({ value: r.key, label: r.label })))
  }, [])
  useEffect(() => { void reloadSources() }, [reloadSources])

  // Neue Quelle anlegen → key (slug) zurückgeben. Idempotent über den key.
  const addSource = useCallback(async (label: string): Promise<string | null> => {
    const l = label.trim()
    if (!l) return null
    const key = l.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `q${Date.now()}`
    const { error } = await supabase.from('crm_lead_sources').upsert({ key, label: l }, { onConflict: 'key' })
    if (error) { console.warn('[leadSources] add:', error.message); return null }
    await reloadSources()
    return key
  }, [reloadSources])

  return { custom, addSource, reloadSources }
}

/** Options für CustomSelect: eingebaute + eigene (+ optional „Neue Quelle …"). */
export function buildSourceOptions(t: TFn, custom: CustomSource[], withAdd = false): { value: string; label: string }[] {
  const builtin = BUILTIN_SOURCES.map(s => ({ value: s.value, label: t(s.i18nKey, s.fallback) }))
  const extra = custom.filter(c => !BUILTIN_SOURCES.some(b => b.value === c.value))
  const base = [...builtin, ...extra]
  return withAdd ? [...base, { value: ADD_SOURCE_VALUE, label: `➕ ${t('crm.sources.addNew', 'Neue Quelle …')}` }] : base
}

/** Anzeige-Label einer Quelle (eingebaut → i18n, eigen → gespeichertes Label,
 *  sonst Slug lesbar gemacht). */
export function sourceDisplayLabel(t: TFn, value: string, custom?: CustomSource[]): string {
  const b = BUILTIN_SOURCES.find(x => x.value === value)
  if (b) return t(b.i18nKey, b.fallback)
  const c = custom?.find(x => x.value === value)
  if (c) return c.label
  return value.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
