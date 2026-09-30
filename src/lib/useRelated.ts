// Lädt "Gehört dazu" für einen Kunden über public.hp_lead_related.
// Wirft nie: jeder Fehler endet in einem Zustand. Gibt es die Funktion in der
// Datenbank noch nicht (Migration nicht eingespielt), ist der Zustand
// 'unavailable' und die Oberfläche zeigt nichts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import type { LeadRelated } from './relatedTypes'

export type RelatedStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
export type RelatedSubject = { kind: 'lead'; id: string }

export interface RelatedOptions {
  enabled?: boolean
  // Einträge je Gruppe (Standard 5, die Funktion deckelt bei 50)
  limit?: number
}

export interface RelatedState {
  status: RelatedStatus
  // null bei 'ready' heißt: der Kunde ist für den Betrachter nicht sichtbar
  data: LeadRelated | null
  reload: () => void
}

type FetchResult =
  | { kind: 'ready'; data: LeadRelated | null }
  | { kind: 'unavailable' }
  | { kind: 'error' }

const CACHE_MS = 60_000
const UNAVAILABLE_MS = 10 * 60_000
const DEFAULT_LIMIT = 5

// Zwischenspeicher je Kunde. Ein Eintrag mit größerem limit bedient auch
// Anfragen mit kleinerem.
const cache = new Map<string, { at: number; limit: number; data: LeadRelated | null }>()
const inflight = new Map<string, Promise<FetchResult>>()
let unavailableAt = 0

export function relatedUnavailable(): boolean {
  return unavailableAt > 0 && Date.now() - unavailableAt < UNAVAILABLE_MS
}

function cached(leadId: string, limit: number): { data: LeadRelated | null } | null {
  const hit = cache.get(leadId)
  if (!hit || hit.limit < limit || Date.now() - hit.at > CACHE_MS) return null
  return { data: hit.data }
}

function isLeadRelated(value: unknown): value is LeadRelated {
  return typeof value === 'object' && value !== null && 'viewer' in value && 'portal' in value
}

function load(leadId: string, limit: number): Promise<FetchResult> {
  const key = `${leadId}:${limit}`
  const running = inflight.get(key)
  if (running) return running
  const request = (async (): Promise<FetchResult> => {
    try {
      const { data, error, status } = await supabase.rpc('hp_lead_related', { p_lead_id: leadId, p_limit: limit })
      if (error) {
        // PGRST202: PostgREST kennt die Funktion nicht; 42883: Postgres kennt sie nicht
        if (error.code === 'PGRST202' || error.code === '42883' || status === 404) {
          unavailableAt = Date.now()
          return { kind: 'unavailable' }
        }
        return { kind: 'error' }
      }
      const payload: unknown = data
      const related = isLeadRelated(payload) ? payload : null
      cache.set(leadId, { at: Date.now(), limit, data: related })
      return { kind: 'ready', data: related }
    } catch {
      return { kind: 'error' }
    }
  })()
  inflight.set(key, request)
  void request.finally(() => { inflight.delete(key) })
  return request
}

export function useRelated(subject: RelatedSubject | null, opts?: RelatedOptions): RelatedState {
  const leadId = subject?.kind === 'lead' && subject.id ? subject.id : null
  const enabled = opts?.enabled ?? true
  const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_LIMIT, 50))
  const [state, setState] = useState<{ status: RelatedStatus; data: LeadRelated | null }>({ status: 'idle', data: null })
  // Zähler für "neu laden": erhöht, damit der Effekt trotz gleicher Id erneut läuft
  const [reloadTick, setReloadTick] = useState(0)
  const forceRef = useRef(false)

  useEffect(() => {
    if (!leadId || !enabled) {
      setState({ status: 'idle', data: null })
      return
    }
    if (relatedUnavailable()) {
      setState({ status: 'unavailable', data: null })
      return
    }
    const force = forceRef.current
    forceRef.current = false
    if (force) cache.delete(leadId)
    const hit = force ? null : cached(leadId, limit)
    if (hit) {
      setState({ status: 'ready', data: hit.data })
      return
    }
    let cancelled = false
    // Beim Nachladen (mehr Einträge, neu laden) bleiben die alten Daten stehen
    setState(prev => ({ status: 'loading', data: prev.data && prev.data.lead_id === leadId ? prev.data : null }))
    void load(leadId, limit).then(result => {
      if (cancelled) return
      if (result.kind === 'ready') setState({ status: 'ready', data: result.data })
      else setState({ status: result.kind, data: null })
    })
    return () => { cancelled = true }
  }, [leadId, enabled, limit, reloadTick])

  const reload = useCallback(() => {
    forceRef.current = true
    setReloadTick(tick => tick + 1)
  }, [])

  return { status: state.status, data: state.data, reload }
}
