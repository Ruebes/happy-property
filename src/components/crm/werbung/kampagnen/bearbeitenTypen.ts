import {
  EDIT_BLOCK_TEXT, EDIT_CREATIVE_FIELDS, LIMITS,
  type AdsetScheduleBlock, type BudgetScheduleSpec, type BulkPatch, type BulkRequest, type BulkResponse, type BulkResult,
  type CreativeTausch, type DraftMetaIds, type DraftSpec, type DuplicateRequest, type DuplicateResponse, type DuplicateZiel,
  type DuplicateZielArt, type EditableStatus, type EditBaseline, type EditChange, type Level,
} from '../../../../lib/metaSpec'

// ── Bearbeiten laufender Kampagnen: Typen und Helfer (Paket A, fe-bearbeiten) ─
// Die Anfrage-/Antwort-Typen der meta-builder-Modi edit_load, edit_diff,
// edit_apply, duplicate und bulk stehen in metaSpec.ts (be-edit); hier nur
// Kurznamen für die Oberfläche, die Sperr-Logik der Formulare (Server-Locks
// auf Feldschlüssel abbilden, Grund als Text) und kleine Helfer.

export type ObjektStatus = EditableStatus
export type { CreativeTausch }
export type BudgetPlanung = BudgetScheduleSpec
export type ZeitplanBlock = AdsetScheduleBlock
export type EditAenderung = EditChange
export type DuplizierZiel = DuplicateZiel
export type DuplizierZielArt = DuplicateZielArt
export type DuplicateMehrRequest = DuplicateRequest
export type DuplicateMehrResponse = DuplicateResponse
export type MassenPatch = BulkPatch
export type MassenRequest = BulkRequest
export type MassenResponse = BulkResponse
export type MassenErgebnis = BulkResult

export const MASSEN_MAX: number = LIMITS.bulkMaxItems
export const KOPIEN_MAX: number = LIMITS.duplicateMaxCopies
/** Kopien insgesamt je Aufruf (Objekte x Kopien) */
export const KOPIEN_GESAMT_MAX: number = LIMITS.duplicateMaxTotal

/** Was im Bearbeiten-Modus geöffnet wurde (beim Wiederöffnen aus meta_ids.edit level/id) */
export type EditZiel = Pick<EditBaseline, 'level' | 'id'>

/** HP-Bedienhilfen am Entwurf (gehen nicht an Meta), Typ aus metaSpec (DraftSpec.hp) */
export type HpB = NonNullable<DraftSpec['hp']>

export const hpVon = (d: DraftSpec): HpB => d.hp ?? {}

/** Entwurf mit geänderten HP-Bedienhilfen */
export function mitHp(d: DraftSpec, patch: Partial<HpB>): DraftSpec {
  return { ...d, hp: { ...hpVon(d), ...patch } }
}

/** Bearbeiten-Ziel eines gespeicherten Entwurfs (meta_ids.edit, schreibt nur meta-builder) */
export function zielAusMetaIds(ids: DraftMetaIds | null | undefined): EditZiel | null {
  const eb = ids?.edit
  return eb && typeof eb.id === 'string' && eb.id && (eb.level === 'campaign' || eb.level === 'adset' || eb.level === 'ad')
    ? { level: eb.level, id: eb.id }
    : null
}

// ── Gesperrte Felder ─────────────────────────────────────────────────────────
// Server-Locks (edit_load, editLocks) sind FieldSpec-Schlüssel; zur Sicherheit
// werden auch API-Namen (destination_type) und Knoten-Präfixe (as1:adset.x)
// verstanden. Präfix-Locks sperren Unterfelder mit (adset.promoted_object).

const LOCK_ALIAS: Readonly<Record<string, string>> = {
  objective: 'campaign.objective',
  special_ad_categories: 'campaign.special_ad_categories',
  special_ad_category_country: 'campaign.special_ad_category_country',
  buying_type: 'campaign.buying_type',
  budget_level: 'campaign.budget_level',
  is_adset_budget_sharing_enabled: 'campaign.is_adset_budget_sharing_enabled',
  billing_event: 'adset.billing_event',
  destination_type: 'adset.destination',
  destination: 'adset.destination',
  optimization_goal: 'adset.optimization_goal',
  'promoted_object.page_id': 'adset.promoted_object.page_id',
  'promoted_object.pixel_id': 'adset.promoted_object.pixel_id',
  'promoted_object.custom_event_type': 'adset.promoted_object.custom_event_type',
  'adset.destination_type': 'adset.destination',
}

export function normLock(roh: string): { node: string | null; feld: string } {
  let node: string | null = null
  let feld = roh.trim()
  const i = feld.indexOf(':')
  if (i > 0) { node = feld.slice(0, i); feld = feld.slice(i + 1) }
  feld = LOCK_ALIAS[feld] ?? feld
  return { node, feld }
}

/** Ist das Feld (FieldSpec-Schlüssel) dieses Knotens gesperrt? */
export function istGesperrt(locks: readonly string[], node: string, feld: string): boolean {
  for (const l of locks) {
    const n = normLock(l)
    if (n.node && n.node !== node) continue
    if (n.feld === feld || feld.indexOf(`${n.feld}.`) === 0) return true
  }
  return false
}

/**
 * Sperren der Oberfläche zusätzlich zu den Server-Locks: Budgetart (Tag/Laufzeit)
 * ist nachträglich fest, Budget teilen nur ausschaltbar, bestehende Beiträge
 * (aus_beitrag) ohne änderbares Werbemittel.
 */
export function oberflaechenSperren(baseline: DraftSpec | null, d: DraftSpec): string[] {
  const basis = baseline ?? d
  const out = ['campaign.budget_art', 'adset.budget_art']
  if (basis.campaign.is_adset_budget_sharing_enabled !== true) out.push('campaign.is_adset_budget_sharing_enabled')
  for (const ad of basis.ads) {
    if (ad.source?.aus_beitrag) for (const f of EDIT_CREATIVE_FIELDS) out.push(`${ad.key}:${f}`)
  }
  return out
}

const SPERR_GRUND: Readonly<Record<string, [string, string]>> = {
  'campaign.objective': ['crm.werbung.bearbeiten.sperre.objective', 'Das Kampagnenziel legt Meta beim Anlegen fest.'],
  'campaign.buying_type': ['crm.werbung.bearbeiten.sperre.buying_type', 'Die Buchungsart steht nach dem Anlegen fest.'],
  'campaign.special_ad_categories': ['crm.werbung.bearbeiten.sperre.special_ad_categories', 'Die spezielle Anzeigenkategorie lässt Meta nach dem Anlegen nicht mehr ändern.'],
  'campaign.special_ad_category_country': ['crm.werbung.bearbeiten.sperre.special_ad_categories', 'Die spezielle Anzeigenkategorie lässt Meta nach dem Anlegen nicht mehr ändern.'],
  'campaign.budget_level': ['crm.werbung.bearbeiten.sperre.budget_level', 'Zwischen Kampagnen- und Anzeigengruppenbudget lässt sich nachträglich nicht wechseln.'],
  'campaign.budget_art': ['crm.werbung.bearbeiten.sperre.budget_art', EDIT_BLOCK_TEXT.budgetart],
  'adset.budget_art': ['crm.werbung.bearbeiten.sperre.budget_art', EDIT_BLOCK_TEXT.budgetart],
  'campaign.daily_budget_cents': ['crm.werbung.bearbeiten.sperre.budget_art', EDIT_BLOCK_TEXT.budgetart],
  'campaign.lifetime_budget_cents': ['crm.werbung.bearbeiten.sperre.budget_art', EDIT_BLOCK_TEXT.budgetart],
  'adset.daily_budget_cents': ['crm.werbung.bearbeiten.sperre.budget_art', EDIT_BLOCK_TEXT.budgetart],
  'adset.lifetime_budget_cents': ['crm.werbung.bearbeiten.sperre.budget_art', EDIT_BLOCK_TEXT.budgetart],
  'campaign.bid_strategy': ['crm.werbung.bearbeiten.sperre.roas', EDIT_BLOCK_TEXT.roasFest],
  'adset.bid_strategy': ['crm.werbung.bearbeiten.sperre.roas', EDIT_BLOCK_TEXT.roasFest],
  'campaign.is_adset_budget_sharing_enabled': ['crm.werbung.bearbeiten.sperre.budget_sharing', EDIT_BLOCK_TEXT.teilenEin],
  'adset.billing_event': ['crm.werbung.bearbeiten.sperre.billing_event', 'Die Abrechnung legt Meta beim Anlegen fest.'],
  'adset.destination': ['crm.werbung.bearbeiten.sperre.destination', 'Den Conversion-Ort lässt Meta nach dem Anlegen nicht mehr ändern.'],
  'adset.optimization_goal': ['crm.werbung.bearbeiten.sperre.optimization_goal', 'Das Performance-Ziel lässt Meta nach Beginn der Auslieferung nicht mehr ändern.'],
  'adset.promoted_object.page_id': ['crm.werbung.bearbeiten.sperre.page_id', 'Die Seite des Conversion-Ziels steht nach dem Anlegen fest.'],
  'adset.promoted_object.custom_conversion_id': ['crm.werbung.bearbeiten.sperre.custom_conversion', EDIT_BLOCK_TEXT.customConversion],
  'adset.promoted_object.pixel_id': ['crm.werbung.bearbeiten.sperre.pixel', EDIT_BLOCK_TEXT.conversionNurWebsite],
  'adset.promoted_object.custom_event_type': ['crm.werbung.bearbeiten.sperre.pixel', EDIT_BLOCK_TEXT.conversionNurWebsite],
  'ad.identity.page_id': ['crm.werbung.bearbeiten.sperre.ad_page', 'Die Facebook-Seite einer Anzeige steht nach dem Anlegen fest.'],
}
const SPERR_STANDARD: [string, string] = ['crm.werbung.bearbeiten.sperre.standard', EDIT_BLOCK_TEXT.lock]
const SPERR_BEITRAG: [string, string] = ['crm.werbung.bearbeiten.sperre.beitrag', EDIT_BLOCK_TEXT.beitrag]

/** i18n-Schlüssel + deutscher Text für den Sperrgrund, null = nicht gesperrt */
export function sperrGrund(locks: readonly string[], node: string, feld: string): [string, string] | null {
  if (!istGesperrt(locks, node, feld)) return null
  if (EDIT_CREATIVE_FIELDS.indexOf(feld) >= 0 && feld !== 'ad.identity.page_id') return SPERR_BEITRAG
  return SPERR_GRUND[feld] ?? SPERR_STANDARD
}

// ── Änderungen lesbar machen ─────────────────────────────────────────────────

const GELD = /(budget|spend_cap|spend_target|bid_amount|_cents$)/
/** Felder, deren Wert USD-Cent sind */
export const istGeldFeld = (field: string): boolean =>
  GELD.test(field) && !/budget_level|budget_sharing|budget_schedule|budget_prozent|budget_art/.test(field)

/** Budgetänderung in Prozent (null, wenn nicht berechenbar) */
export function budgetProzent(before: unknown, after: unknown): number | null {
  const b = typeof before === 'number' ? before : Number(before)
  const a = typeof after === 'number' ? after : Number(after)
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0) return null
  return Math.round(((a - b) / b) * 100)
}

/** Ab dieser Budgetänderung (Prozent, Betrag) kann die Lernphase neu starten */
export const BUDGET_LERN_SCHWELLE = 20

/** Knoten-Name zu einer Meta-ID aus dem Entwurf (für die Änderungsliste) */
export function objektName(d: DraftSpec, level: Level, id: string): string | null {
  if (level === 'campaign') return d.campaign.existing_id === id ? d.campaign.name : null
  if (level === 'adset') return d.adsets.find(a => a.existing_id === id)?.name ?? null
  return d.ads.find(a => a.existing_id === id)?.name ?? null
}

/** Ziel aus dem Adress-Parameter ?bearbeiten=<level>:<id> */
export function zielAusParam(v: string | null): EditZiel | null {
  if (!v) return null
  const m = /^(campaign|adset|ad):(\d{5,25})$/.exec(v.trim())
  return m ? { level: m[1] as Level, id: m[2] } : null
}

export const zielParam = (z: EditZiel): string => `${z.level}:${z.id}`

/** Wochentage in Metas Zählung (0 = Sonntag), Anzeige ab Montag */
export const WOCHENTAGE_META: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

/** Zeit aus Budgetplanung (ISO oder Unix-Sekunden) als ISO, null wenn ungültig */
export function isoAusZeit(v: string | number | undefined | null): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v * 1000).toISOString() : null
  if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000).toISOString()
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
