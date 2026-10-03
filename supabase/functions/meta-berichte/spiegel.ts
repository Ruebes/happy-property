// meta-berichte: Lesen aus dem CRM-Spiegel (meta_campaigns, meta_adsets,
// ad_catalog; befüllt von meta-ads-sync). Dient zur Ebenen-Erkennung von IDs
// (spart Meta-Abrufe) und als Rückfall, wenn Meta gedrosselt oder nicht
// erreichbar ist. Abfragen seriell (Micro-Instanz), je höchstens 200 IDs.
// Fehlende Tabellen/Spalten (Migration nicht eingespielt) werden übersprungen.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { errText, FN, spalteFehlt, str, tabelleFehlt, type Raw } from './common.ts'
import { isoZeit, lernphase } from './normalize.ts'
import type { LernphaseInfo } from './types.ts'

export interface SpiegelObjekt {
  id: string
  level: 'campaign' | 'adset' | 'ad'
  name: string | null
  effective_status: string | null
  configured_status: string | null
  learning: LernphaseInfo | null
  issues: unknown
  review_feedback: unknown
  start: string | null
  ende: string | null
  adset_id: string | null
  synced_at: string | null
}

const BLOCK = 200

function warnen(tabelle: string, error: unknown): void {
  const msg = tabelleFehlt(error) ? 'Tabelle fehlt' : String((error as { message?: string } | null)?.message ?? error).slice(0, 200)
  console.warn(`[${FN}] Spiegel ${tabelle}: ${msg}`)
}

async function auswahl(sb: SupabaseClient, tabelle: string, spalten: string[], idSpalte: string, ids: string[]): Promise<Raw[]> {
  const out: Raw[] = []
  for (let i = 0; i < ids.length; i += BLOCK) {
    const block = ids.slice(i, i + BLOCK)
    try {
      let { data, error } = await sb.from(tabelle).select(spalten.join(', ')).in(idSpalte, block).limit(BLOCK)
      if (error && spalteFehlt(error)) {
        // ältere Spalten (vor 20261003100000): nur Grunddaten
        ;({ data, error } = await sb.from(tabelle).select([idSpalte, ...spalten.filter(s => s !== idSpalte && /^(name|ad_name|status|adset_id|campaign_id)$/.test(s))].join(', ')).in(idSpalte, block).limit(BLOCK))
      }
      if (error) {
        warnen(tabelle, error)
        return out
      }
      if (Array.isArray(data)) out.push(...(data as Raw[]))
    } catch (err) {
      console.warn(`[${FN}] Spiegel ${tabelle}:`, errText(err).slice(0, 200))
      return out
    }
  }
  return out
}

/** Spiegel-Lernphase aus Spalten oder learning_stage_info */
function spiegelLernphase(r: Raw): LernphaseInfo | null {
  const ausJson = lernphase(r.learning_stage_info)
  if (ausJson) return ausJson
  if (r.learning_status === undefined && r.learning_conversions === undefined) return null
  return lernphase({ status: r.learning_status, conversions: r.learning_conversions, last_sig_edit_ts: r.last_sig_edit_ts })
}

/** Objekte aus dem Spiegel zu den IDs (Kampagnen, Anzeigengruppen, Anzeigen gemischt). */
export async function spiegelLesen(sb: SupabaseClient, ids: string[]): Promise<Map<string, SpiegelObjekt>> {
  const m = new Map<string, SpiegelObjekt>()
  if (!ids.length) return m
  const kamp = await auswahl(sb, 'meta_campaigns',
    ['campaign_id', 'name', 'status', 'effective_status', 'issues', 'start_time', 'stop_time', 'synced_at'], 'campaign_id', ids)
  for (const r of kamp) {
    const id = str(r.campaign_id)
    if (!id) continue
    m.set(id, {
      id, level: 'campaign', name: str(r.name), effective_status: str(r.effective_status), configured_status: str(r.status),
      learning: null, issues: r.issues ?? null, review_feedback: null, start: isoZeit(r.start_time), ende: isoZeit(r.stop_time),
      adset_id: null, synced_at: str(r.synced_at),
    })
  }
  const rest1 = ids.filter(id => !m.has(id))
  const sets = rest1.length ? await auswahl(sb, 'meta_adsets',
    ['adset_id', 'name', 'status', 'effective_status', 'learning_status', 'learning_conversions', 'last_sig_edit_ts',
      'learning_stage_info', 'issues', 'start_time', 'end_time', 'synced_at'], 'adset_id', rest1) : []
  for (const r of sets) {
    const id = str(r.adset_id)
    if (!id) continue
    m.set(id, {
      id, level: 'adset', name: str(r.name), effective_status: str(r.effective_status), configured_status: str(r.status),
      learning: spiegelLernphase(r), issues: r.issues ?? null, review_feedback: null, start: isoZeit(r.start_time),
      ende: isoZeit(r.end_time), adset_id: id, synced_at: str(r.synced_at),
    })
  }
  const rest2 = ids.filter(id => !m.has(id))
  const ads = rest2.length ? await auswahl(sb, 'ad_catalog',
    ['ad_id', 'ad_name', 'adset_id', 'status', 'effective_status', 'configured_status', 'issues_info', 'review_feedback'], 'ad_id', rest2) : []
  for (const r of ads) {
    const id = str(r.ad_id)
    if (!id) continue
    m.set(id, {
      id, level: 'ad', name: str(r.ad_name), effective_status: str(r.effective_status) ?? str(r.status),
      configured_status: str(r.configured_status) ?? str(r.status), learning: null, issues: r.issues_info ?? null,
      review_feedback: r.review_feedback ?? null, start: null, ende: null, adset_id: str(r.adset_id), synced_at: null,
    })
  }
  return m
}

/**
 * IDs der untergeordneten Objekte (Anzeigengruppen und Anzeigen einer Kampagne,
 * Anzeigen einer Anzeigengruppe) aus dem Spiegel. Seriell, je höchstens 1.000.
 * Fehlt eine Tabelle oder Spalte, bleibt die Liste entsprechend kürzer.
 */
export async function spiegelKinder(sb: SupabaseClient, objectId: string): Promise<string[]> {
  const out: string[] = []
  const abfragen: Array<[string, string, string]> = [
    ['meta_adsets', 'adset_id', 'campaign_id'],
    ['ad_catalog', 'ad_id', 'campaign_id'],
    ['ad_catalog', 'ad_id', 'adset_id'],
  ]
  for (const [tabelle, idSpalte, elternSpalte] of abfragen) {
    try {
      const { data, error } = await sb.from(tabelle).select(idSpalte).eq(elternSpalte, objectId).limit(1000)
      if (error) {
        warnen(tabelle, error)
        continue
      }
      for (const r of (Array.isArray(data) ? data : []) as unknown as Raw[]) {
        const id = str(r[idSpalte])
        if (id && out.indexOf(id) < 0) out.push(id)
      }
    } catch (err) {
      console.warn(`[${FN}] Spiegel ${tabelle}:`, errText(err).slice(0, 200))
    }
  }
  return out
}

/** Lernphase je Anzeigengruppe aus dem Spiegel (für Anzeigen: Lernphase der Gruppe). */
export async function spiegelLernphasen(sb: SupabaseClient, adsetIds: string[]): Promise<Map<string, LernphaseInfo>> {
  const m = new Map<string, LernphaseInfo>()
  if (!adsetIds.length) return m
  const rows = await auswahl(sb, 'meta_adsets',
    ['adset_id', 'learning_status', 'learning_conversions', 'last_sig_edit_ts', 'learning_stage_info'], 'adset_id', adsetIds)
  for (const r of rows) {
    const id = str(r.adset_id)
    const l = spiegelLernphase(r)
    if (id && l) m.set(id, l)
  }
  return m
}
