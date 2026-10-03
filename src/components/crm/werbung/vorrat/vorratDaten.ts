import { supabase } from '../../../../lib/supabase'
import { useAuth } from '../../../../lib/auth'
import { slugify } from '../../../../lib/metaLint'
import type {
  VorratEinstellungen, VorratEintrag, VorratFormWerte, VorratQa, VorratStatistik, VorratTexte,
} from './types'

// ── Daten des Werbemittel-Vorrats ────────────────────────────────────────────
// Micro-Instanz: alle Abfragen einzeln und nacheinander, mit Limit. Die Tabellen
// kommen aus 20261003110000_werbe_autopilot.sql; solange die Migration fehlt,
// liefert ladeVorrat fehlt=true und die Oberfläche zeigt einen Hinweis.

/** Sollmaße (wie werbe-autopilot vorrat.ts FEED_SOLL / STORY_SOLL) */
export const FEED_SOLL = { w: 1080, h: 1350 }
export const STORY_SOLL = { w: 1080, h: 1920 }
const MAX_BILD_BYTES = 30 * 1024 * 1024
export const BILD_TYPEN = ['image/jpeg', 'image/png']

const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const zahl = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Tabelle oder Spalte fehlt (Migration noch nicht eingespielt) */
function fehltSchema(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  return err.code === '42P01' || err.code === 'PGRST205' || err.code === '42703' || err.code === 'PGRST204'
    || /does not exist|schema cache/i.test(err.message ?? '')
}

export async function ladeVorrat(): Promise<{ zeilen: VorratEintrag[]; fehler: string | null; fehlt: boolean }> {
  const { data, error } = await supabase.from('ad_creative_pool')
    .select('*').order('updated_at', { ascending: false }).limit(500)
  if (error) {
    console.error('[WerbeVorrat] ad_creative_pool:', error)
    return { zeilen: [], fehler: error.message, fehlt: fehltSchema(error) }
  }
  return { zeilen: (data ?? []) as VorratEintrag[], fehler: null, fehlt: false }
}

export async function ladeEinstellungen(): Promise<VorratEinstellungen> {
  const leer: VorratEinstellungen = { builderEnabled: false, autoStufe: 0, schwelle: 0.9 }
  const { data, error } = await supabase.from('ad_settings')
    .select('builder_enabled, pool_auto_release_level, pool_auto_release_threshold')
    .eq('id', 'default').maybeSingle()
  if (error || !data) {
    if (error) console.warn('[WerbeVorrat] ad_settings:', error.message)
    return leer
  }
  const r = data as Record<string, unknown>
  return {
    builderEnabled: r.builder_enabled === true,
    autoStufe: zahl(r.pool_auto_release_level) ?? 0,
    schwelle: zahl(r.pool_auto_release_threshold) ?? 0.9,
  }
}

/**
 * Steht die Meta-App noch im Entwicklungsmodus? Aus meta_write_log der letzten
 * 30 Tage: der jüngste Eintrag mit Fehler 1885183 (kind dev_mode) bzw. das
 * jüngste erfolgreiche Anlegen eines Creatives entscheidet. null = unbekannt.
 */
export async function ladeEntwicklungsmodus(): Promise<boolean | null> {
  const seit = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data, error } = await supabase.from('meta_write_log')
    .select('ts, ok, validate_only, path, meta_error')
    .gte('ts', seit).order('ts', { ascending: false }).limit(40)
  if (error) {
    console.warn('[WerbeVorrat] meta_write_log:', error.message)
    return null
  }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const me = istObjekt(r.meta_error) ? r.meta_error : null
    if (me && (me.kind === 'dev_mode' || zahl(me.subcode) === 1885183)) return true
    if (r.ok === true && r.validate_only !== true && /adcreatives/.test(String(r.path ?? ''))) return false
  }
  return null
}

// Projekt- und Bauträgernamen für die Live-Prüfung (einmal je Sitzung)
let namenCache: Promise<string[]> | null = null
export function ladeVerboteneNamen(): Promise<string[]> {
  if (!namenCache) {
    namenCache = (async () => {
      const { data, error } = await supabase.from('crm_projects').select('name, developer').limit(2000)
      if (error) {
        // Ohne Leserecht auf Projekte: der Server prüft beim Prüfen und Hochladen noch einmal
        console.warn('[WerbeVorrat] crm_projects:', error.message)
        namenCache = null
        return []
      }
      const out: string[] = []
      for (const r of (data ?? []) as Array<{ name?: string | null; developer?: string | null }>) {
        for (const n of [r.name, r.developer]) {
          const s = (n ?? '').trim()
          if (s.length >= 3 && !out.includes(s)) out.push(s)
        }
      }
      return out
    })()
  }
  return namenCache
}

// ── Zeilen lesen ─────────────────────────────────────────────────────────────

/** texte-Spalte lesen (gleiche Schlüssel wie werbe-ausfuehren / werbe-autopilot) */
export function texteAus(texte: unknown): VorratTexte {
  const o = istObjekt(texte) ? texte : {}
  const liste = (keys: string[]): string[] => {
    for (const k of keys) {
      const v = o[k]
      if (Array.isArray(v)) return v.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 5)
      if (typeof v === 'string' && v.trim()) return [v.trim()]
    }
    return []
  }
  return {
    primaer: liste(['primaer', 'primary_texts', 'bodies']),
    ueberschriften: liste(['ueberschriften', 'headlines', 'titles']),
    beschreibungen: liste(['beschreibungen', 'descriptions']),
  }
}

export function qaAus(qa: unknown): VorratQa | null {
  return istObjekt(qa) ? (qa as VorratQa) : null
}

/** Prognose zum Zeitpunkt der Entscheidung (Stempel in merkmale), sonst aktuelle Spalte */
function prognoseBeiEntscheidung(z: VorratEintrag): number | null {
  const m = istObjekt(z.merkmale) ? z.merkmale : null
  return zahl(m?.prognose)
}

/**
 * Menschliche Entscheidungen und Übereinstimmung der Prognose. Gleiche Rechnung
 * wie werbe-autopilot (uebereinstimmung): Anteil Freigaben unter den Entscheidungen,
 * deren Prognose bei der Entscheidung >= Schwelle lag.
 */
export function statistik(zeilen: VorratEintrag[], schwelle: number): VorratStatistik {
  const menschen = zeilen.filter(z => z.entschieden_von != null && (z.entscheidung === 'freigegeben' || z.entscheidung === 'abgelehnt'))
  const freigaben = menschen.filter(z => z.entscheidung === 'freigegeben').length
  const faelle = menschen.filter(z => { const p = prognoseBeiEntscheidung(z); return p != null && p >= schwelle })
  return {
    entscheidungen: menschen.length,
    freigaben,
    ablehnungen: menschen.length - freigaben,
    faelle: faelle.length,
    quote: faelle.length ? faelle.filter(z => z.entscheidung === 'freigegeben').length / faelle.length : null,
  }
}

// ── Kennung ──────────────────────────────────────────────────────────────────

/** ASCII-Slug: klein, Umlaute ausgeschrieben, nur a-z 0-9 _ - */
export function kennungNormalisieren(s: string): string {
  return s.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)
}

/** Fehlercode der Kennung (für die Anzeige übersetzt), null = in Ordnung */
export function kennungFehler(k: string, verboteneNamen: string[]): 'leer' | 'format' | 'endung' | 'projektname' | null {
  if (!k) return 'leer'
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(k)) return 'format'
  if (/_(lang|kurz)$/.test(k)) return 'endung'
  const slug = `-${slugify(k)}-`
  if (verboteneNamen.some(n => { const s = slugify(n); return !!s && slug.includes(`-${s}-`) })) return 'projektname'
  return null
}

// ── Bilder ───────────────────────────────────────────────────────────────────

export async function bildMasse(file: File): Promise<{ w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file)
      const m = { w: bmp.width, h: bmp.height }
      bmp.close()
      return m
    } catch { /* Fallback unten */ }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => reject(new Error('bild_unlesbar'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Gleiche Regel wie die automatische Prüfung: Breite >= Soll, Seitenverhältnis +-1 % */
export function masseOk(m: { w: number; h: number }, soll: { w: number; h: number }): { ok: boolean; exakt: boolean } {
  const ratio = m.w / m.h
  const sollRatio = soll.w / soll.h
  return {
    ok: m.w >= soll.w && Math.abs(ratio - sollRatio) / sollRatio <= 0.01,
    exakt: m.w === soll.w && m.h === soll.h,
  }
}

export type BildFehler = 'typ' | 'gross' | 'masse' | 'unlesbar' | 'upload'
export interface BildErgebnis { url: string; w: number; h: number; exakt: boolean }

/** Prüft Typ, Größe und Maße und lädt nach ad-creatives/vorrat/<uuid>.<ext> hoch. */
export async function bildHochladen(
  file: File, soll: { w: number; h: number },
): Promise<{ ok: true; bild: BildErgebnis } | { ok: false; fehler: BildFehler; w?: number; h?: number; detail?: string }> {
  if (!BILD_TYPEN.includes(file.type)) return { ok: false, fehler: 'typ' }
  if (file.size > MAX_BILD_BYTES) return { ok: false, fehler: 'gross' }
  let m: { w: number; h: number }
  try {
    m = await bildMasse(file)
  } catch {
    return { ok: false, fehler: 'unlesbar' }
  }
  const c = masseOk(m, soll)
  if (!c.ok) return { ok: false, fehler: 'masse', w: m.w, h: m.h }
  const ext = file.type === 'image/png' ? 'png' : 'jpg'
  // Dateiname nur aus der UUID: nie Projektnamen in Dateinamen
  const path = `vorrat/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('ad-creatives').upload(path, file, { upsert: false, contentType: file.type })
  if (error) {
    console.error('[WerbeVorrat] upload:', error)
    return { ok: false, fehler: 'upload', detail: error.message }
  }
  const { data } = supabase.storage.from('ad-creatives').getPublicUrl(path)
  return { ok: true, bild: { url: data.publicUrl, w: m.w, h: m.h, exakt: c.exakt } }
}

// ── Speichern ────────────────────────────────────────────────────────────────

const ohneLeere = (l: string[]) => l.map(x => x.trim()).filter(Boolean).slice(0, 5)

/** Inhaltsfelder für insert/update (Systemfelder setzt nur der Server bzw. der Guard) */
export function inhaltAusWerten(w: VorratFormWerte): Record<string, unknown> {
  return {
    kennung: w.kennung,
    winkel: w.winkel.trim() || null,
    hook_typ: w.hook_typ.trim() || null,
    format: w.format,
    visual_typ: w.visual_typ.trim() || null,
    lp_url: w.lp_url.trim() || null,
    texte: {
      primaer: ohneLeere(w.primaer),
      ueberschriften: ohneLeere(w.ueberschriften),
      beschreibungen: ohneLeere(w.beschreibungen),
    },
    asset_feed_url: w.asset_feed_url,
    asset_story_url: w.asset_story_url,
    eu_band: w.eu_band,
    ki_generiert: w.ki_generiert,
    ki_label: w.ki_generiert ? w.ki_label : false,
    fakten_pruefung: w.fakten_pruefung,
    ziel_adset_ids: w.ziel_adset_ids.length ? w.ziel_adset_ids.slice(0, 2) : null,
  }
}

export function werteAusZeile(z: VorratEintrag | null): VorratFormWerte {
  const tx = texteAus(z?.texte)
  return {
    kennung: z?.kennung ?? '',
    winkel: z?.winkel ?? '',
    hook_typ: z?.hook_typ ?? '',
    format: z?.format === 'video' || z?.format === 'karussell' ? z.format : 'bild',
    visual_typ: z?.visual_typ ?? '',
    lp_url: z?.lp_url ?? '',
    primaer: tx.primaer.length ? tx.primaer : [''],
    ueberschriften: tx.ueberschriften.length ? tx.ueberschriften : [''],
    beschreibungen: tx.beschreibungen.length ? tx.beschreibungen : [''],
    asset_feed_url: z?.asset_feed_url ?? null,
    asset_story_url: z?.asset_story_url ?? null,
    eu_band: z?.eu_band ?? false,
    ki_generiert: z?.ki_generiert ?? false,
    ki_label: z?.ki_label ?? false,
    fakten_pruefung: z?.fakten_pruefung ?? false,
    ziel_adset_ids: (z?.ziel_adset_ids ?? []).slice(0, 2),
  }
}

// ── Rechte (Anzeige; die Datenbank prüft selbst) ─────────────────────────────
// Spiegel von current_user_has_perm('werbung') und werbe_ist_admin():
//   darfEntscheiden  Admin, Verwalter oder Mitarbeiter mit Recht werbung (Sven, Giona):
//                    anlegen, bearbeiten, freigeben, ablehnen, hochladen
//   istAdmin         Fakten-Prüfung wieder abschalten
export function useVorratRechte(): { darfEntscheiden: boolean; istAdmin: boolean } {
  const { profile } = useAuth()
  const rolle = profile?.role
  const perms = (profile?.permissions ?? {}) as Record<string, unknown>
  return {
    darfEntscheiden: rolle === 'admin' || rolle === 'verwalter' || (rolle === 'mitarbeiter' && perms.werbung === true),
    istAdmin: rolle === 'admin',
  }
}
