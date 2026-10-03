import { supabase } from '../../../../lib/supabase'
import type { AdAction } from '../../../../lib/crmTypes'
import { fnErrorDetail } from '../../../../lib/fnError'
import { LIMITS } from '../../../../lib/metaSpec'
import { BuilderFehler, builderCall, fehlerCode, ladeBuilderEinstellungen } from '../kampagnen/builderApi'
import type { Ebene } from './typen'

// ── Pausieren / Aktivieren aus der Zentrale ──────────────────────────────────
// Anzeigen: bewährter Weg über die Aktions-Warteschlange (ad_actions, der
// Sync-Lauf führt bei Meta aus), alle Zeilen in EINEM Insert, danach EIN
// Anstoß von meta-ads-sync. Kampagnen und Anzeigengruppen: meta-builder
// Modus bulk (Leitplanke, Schreibprotokoll und Spiegel auf dem Server), in
// Paketen zu höchstens LIMITS.bulkMaxItems. Ist der Kampagnen-Assistent
// (builder_enabled) aus oder kennt der Server bulk noch nicht, läuft es wie
// bisher einzeln über meta-ads-tools update_entity (mit Leitplanke).

export type Schaltziel = 'pause' | 'activate'

export interface AnzeigeVormerken {
  ad_id: string
  ad_name: string | null
  campaign_name: string | null
}

/** Anzeigen in die Warteschlange (ein Insert). Gibt die neuen Zeilen zurück. */
export async function anzeigenVormerken(
  ads: AnzeigeVormerken[], ziel: Schaltziel, grund: string, segment: string, profilId: string | null,
): Promise<AdAction[]> {
  if (!ads.length) return []
  const { data, error } = await supabase.from('ad_actions').insert(ads.map(a => ({
    platform: segment, ad_id: a.ad_id, ad_name: a.ad_name, campaign_name: a.campaign_name,
    action: ziel, reason: grund, created_by: profilId,
  }))).select('id, ad_id, ad_name, campaign_name, action, reason, status, created_at, executed_at, result')
  if (error) throw error
  return (data as unknown as AdAction[] | null) ?? []
}

/** Warteschlange sofort ausführen lassen (wie bisher, ohne auf das Ergebnis zu warten) */
export function warteschlangeAnstossen(danach: () => void): void {
  supabase.functions.invoke('meta-ads-sync', { body: { mode: 'actions_only' } })
    .then(() => danach())
    .catch(e => console.warn('[Zentrale] Sofort-Ausführung:', e))
}

export interface BulkErgebnis { level: Ebene; id: string; ok: boolean; error: string | null }

export interface SchaltErgebnis {
  ergebnisse: BulkErgebnis[]
  /** true = über meta-builder bulk (Spiegeltabellen sind schon nachgezogen) */
  ueberBulk: boolean
}

type EbenenItem = { level: Exclude<Ebene, 'ad'>; id: string }

/** Reihenfolge wie bulk: Pausieren Kampagne zuerst (stoppt sofort), Einschalten Kampagne zuletzt */
const sortiert = (items: EbenenItem[], ziel: Schaltziel): EbenenItem[] => {
  const rang = (l: EbenenItem['level']) => (l === 'campaign' ? (ziel === 'pause' ? 0 : 1) : (ziel === 'pause' ? 1 : 0))
  return [...items].sort((a, b) => rang(a.level) - rang(b.level))
}

/** Fehler, bei denen bulk (noch) nicht nutzbar ist: Assistent aus, Modus unbekannt, Funktion fehlt */
function bulkNichtNutzbar(err: unknown): boolean {
  const code = fehlerCode(err)
  if (code === 'builder_disabled' || code === 'unsupported' || code === 'NOT_FOUND') return true
  return code === 'invalid_request' && err instanceof BuilderFehler && /Unbekannter Modus/i.test(err.message)
}

/** Einzeln über meta-ads-tools update_entity (bisheriger Live-Weg, Leitplanke je Objekt) */
async function einzelnSchalten(items: EbenenItem[], ziel: Schaltziel): Promise<BulkErgebnis[]> {
  const status = ziel === 'pause' ? 'PAUSED' : 'ACTIVE'
  const out: BulkErgebnis[] = []
  for (const it of items) {
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-tools', {
        body: { mode: 'update_entity', entity_id: it.id, entity_type: it.level, patch: { status } },
      })
      if (error) throw new Error((await fnErrorDetail(error)).message)
      const d = data as { error?: unknown } | null
      if (d && typeof d.error === 'string' && d.error) throw new Error(d.error)
      out.push({ level: it.level, id: it.id, ok: true, error: null })
    } catch (err) {
      out.push({ level: it.level, id: it.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/** Kampagnen/Anzeigengruppen an- oder ausschalten. Wirft nur, wenn schon das
 *  erste Paket komplett scheitert (dann ist nichts geändert); spätere Pakete
 *  melden ihren Fehler je Zeile. zuText macht aus einem Fehler deutschen Text. */
export async function ebenenSchalten(
  eingabe: EbenenItem[], ziel: Schaltziel, zuText: (e: unknown) => string,
): Promise<SchaltErgebnis> {
  const items = sortiert(eingabe, ziel)
  if (!items.length) return { ergebnisse: [], ueberBulk: true }
  const st = await ladeBuilderEinstellungen()
  if (st?.builder_enabled !== true) return { ergebnisse: await einzelnSchalten(items, ziel), ueberBulk: false }
  const out: BulkErgebnis[] = []
  for (let i = 0; i < items.length; i += LIMITS.bulkMaxItems) {
    const teil = items.slice(i, i + LIMITS.bulkMaxItems)
    try {
      const r = await builderCall('bulk', { items: teil, patch: { status: ziel === 'pause' ? 'PAUSED' : 'ACTIVE' }, confirm: true })
      for (const x of r.results ?? []) out.push({ level: x.level, id: x.id, ok: x.ok === true, error: x.error ?? null })
    } catch (err) {
      if (i === 0 && bulkNichtNutzbar(err)) return { ergebnisse: await einzelnSchalten(items, ziel), ueberBulk: false }
      if (i === 0) throw err
      const text = zuText(err)
      for (const x of teil) out.push({ level: x.level, id: x.id, ok: false, error: text })
    }
  }
  return { ergebnisse: out, ueberBulk: true }
}
