import type { TFunction } from 'i18next'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail } from '../../../../lib/fnError'
import { BuilderFehler, builderCall, fehlerCode, fehlerText, ladeKatalog } from '../kampagnen/builderApi'
import { WERKZEUG_WRITE_MODES } from '../../../../lib/werbeWerkzeuge'
import type {
  LeadformGetResponse, WerkzeugMode, WerkzeugRequestMap, WerkzeugResponseMap, Zielgruppe, ZielgruppenArt,
} from '../../../../lib/werbeWerkzeuge'

// ── Aufrufe der Edge Function meta-werkzeuge + Einstellungen ─────────────────
// Zielgruppen und Sofortformulare. Typen aus src/lib/werbeWerkzeuge.ts (gleiche
// Datei wie im Server). Gleiches Fehlerbild wie der Assistent (BuilderFehler,
// ein zweiter Versuch bei Netz-Wacklern, aber nie bei Schreib-Modi ohne
// vorschau: ob der erste Aufruf bei Meta schon gewirkt hat, ist dann unklar,
// ein zweiter legte Zielgruppe oder Formular doppelt an). Fehlt die Function noch (nicht
// deployt), fallen die Listen auf den Katalog des Assistenten zurück (nur
// lesen, Metas Rohfelder werden tolerant gelesen).

const FN = 'meta-werkzeuge'
/** Fehlercode, wenn meta-werkzeuge noch nicht live ist (404 ohne eigenen Fehlertext) */
export const FUNKTION_FEHLT = 'function_missing'

const NETZ_FEHLER = /Failed to send|Failed to fetch|NetworkError|Load failed/i
const warte = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

type Roh = Record<string, unknown>
const istObj = (v: unknown): v is Roh => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const zahl = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const wahr = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null)
const erstes = (r: Roh, keys: string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k]
  return undefined
}
async function istFunktionFehlt(error: unknown): Promise<boolean> {
  if (!(error instanceof FunctionsHttpError)) return false
  const res = error.context as Response
  if (!res || res.status !== 404) return false
  const body = await res.clone().json().catch(() => null) as { error?: unknown } | null
  return !(body && typeof body.error === 'string' && body.error)
}

/** Ein Modus von meta-werkzeuge. 200-Antworten mit { error } gelten als Fehler. */
export async function werkzeugCall<M extends WerkzeugMode>(mode: M, req: WerkzeugRequestMap[M], retried = false): Promise<WerkzeugResponseMap[M]> {
  const { data, error } = await supabase.functions.invoke(FN, { body: { mode, ...req } })
  if (error) {
    const wiederholbar = !WERKZEUG_WRITE_MODES.includes(mode) || (req as { vorschau?: boolean }).vorschau === true
    if (!retried && wiederholbar && NETZ_FEHLER.test(error.message ?? '')) {
      await warte(1500)
      return werkzeugCall(mode, req, true)
    }
    if (await istFunktionFehlt(error)) {
      throw new BuilderFehler({ message: 'meta-werkzeuge ist noch nicht live.', code: FUNKTION_FEHLT })
    }
    throw new BuilderFehler(await fnErrorDetail(error))
  }
  if (istObj(data) && typeof data.error === 'string' && data.error) {
    throw new BuilderFehler({
      message: data.error,
      ...(typeof data.hint === 'string' && data.hint ? { hint: data.hint } : {}),
      ...(typeof data.code === 'string' || typeof data.code === 'number' ? { code: String(data.code) } : {}),
      ...(data.data !== undefined ? { data: data.data } : {}),
    })
  }
  if (!istObj(data)) throw new BuilderFehler({ message: 'Leere Antwort vom Server.' })
  return data as unknown as WerkzeugResponseMap[M]
}

/** Verständlicher Fehlertext (bekannte Codes des Assistenten + fehlende Function). */
export function werkzeugFehlerText(e: unknown, t: TFunction): string {
  if (fehlerCode(e) === FUNKTION_FEHLT) {
    return t('crm.werbung.zielgruppen.fehler.funktionFehlt', 'Die Server-Funktion für Zielgruppen und Formulare ist noch nicht live. Nach dem nächsten Deploy geht es hier weiter.')
  }
  const code = fehlerCode(e)
  const eigene: Record<string, string> = {
    housing_forbidden: t('crm.werbung.zielgruppen.fehler.housing_forbidden', 'Unter der Sonderkategorie Wohnen nicht erlaubt.'),
    kundenliste_gesperrt: t('crm.werbung.zielgruppen.fehler.kundenliste_gesperrt', 'Kundenlisten sind gesperrt, bis Sven sie freigibt.'),
    limit_reached: t('crm.werbung.zielgruppen.fehler.limit_reached', 'Meta-Grenze erreicht (z. B. höchstens 100 Formulare oder 500 Zielgruppen).'),
  }
  if (code && eigene[code] && e instanceof BuilderFehler) {
    const detail = e.hint || e.message
    return detail && detail !== eigene[code] ? `${eigene[code]} ${detail}` : eigene[code]
  }
  return fehlerText(e, t)
}

// ── Zielgruppen lesen ────────────────────────────────────────────────────────

export interface ZielgruppeZeile {
  id: string
  name: string
  art: ZielgruppenArt
  /** Metas subtype (WEBSITE, ENGAGEMENT, LOOKALIKE, CUSTOM …) */
  subtype: string
  /** null = unbekannt bzw. zu klein, als dass Meta eine Zahl nennt */
  groesseMin: number | null
  groesseMax: number | null
  aufbewahrungTage: number | null
  regelText: string | null
  /** Eignung für Kampagnen mit Sonderkategorie Wohnen (DE): null = nicht geprüft */
  wohnenTauglich: boolean | null
  wohnenGrund: string | null
  /** Lookalike oder von Meta für Wohnen abgelehnt */
  gesperrtFuerWohnen: boolean
  status: string | null
  erstellt: string | null
  beschreibung: string | null
  /** Lookalike: Ursprungs-Zielgruppe */
  quelleId: string | null
  quelleName: string | null
}

const zeitText = (v: unknown): string | null => {
  const n = zahl(v)
  if (n != null && n > 1_000_000_000 && n < 10_000_000_000) return new Date(n * 1000).toISOString()
  const s = text(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Art aus Metas subtype (für den Katalog, der keine Art liefert) */
export function artAusSubtype(subtype: string): ZielgruppenArt {
  switch (subtype) {
    case 'WEBSITE': return 'website'
    case 'ENGAGEMENT': return 'interaktion'
    case 'VIDEO': return 'video'
    case 'CUSTOM': return 'kundenliste'
    case 'LOOKALIKE': return 'lookalike'
    default: return 'sonstige'
  }
}

/** Zeile aus der Antwort von audiences_list */
export function zielgruppeAusServer(z: Zielgruppe): ZielgruppeZeile {
  const status = [z.auslieferung?.text, z.bearbeitung?.code === 471 ? z.bearbeitung.text : null].filter(Boolean).join(' · ')
  return {
    id: z.id,
    name: z.name || z.id,
    art: z.art,
    subtype: (z.subtype ?? '').toUpperCase(),
    groesseMin: z.groesse_min,
    groesseMax: z.groesse_max,
    aufbewahrungTage: z.aufbewahrung_tage,
    regelText: z.regel_zusammenfassung || null,
    wohnenTauglich: z.sac_eligible,
    wohnenGrund: z.sac_grund ?? null,
    gesperrtFuerWohnen: z.gesperrt_fuer_wohnen || z.art === 'lookalike',
    status: status || null,
    erstellt: zeitText(z.erstellt),
    beschreibung: z.beschreibung,
    quelleId: z.lookalike?.quelle_id ?? null,
    quelleName: z.lookalike?.quelle_name ?? null,
  }
}

/** Zeile aus dem Katalog des Assistenten (Metas Rohfelder, weniger Angaben) */
function zielgruppeAusKatalog(r: Roh): ZielgruppeZeile | null {
  const id = text(r.id)
  if (!id) return null
  const subtype = (text(r.subtype) ?? 'CUSTOM').toUpperCase()
  const lo = zahl(r.approximate_count_lower_bound)
  const hi = zahl(r.approximate_count_upper_bound)
  const art = artAusSubtype(subtype)
  const tauglich = wahr(r.sac_eligible)
  return {
    id, name: text(r.name) ?? id, art, subtype,
    groesseMin: lo != null && lo >= 0 ? lo : null,
    groesseMax: hi != null && hi >= 0 ? hi : null,
    aufbewahrungTage: zahl(r.retention_days),
    regelText: null,
    wohnenTauglich: tauglich,
    wohnenGrund: null,
    gesperrtFuerWohnen: art === 'lookalike' || tauglich === false,
    status: null, erstellt: zeitText(r.time_created), beschreibung: text(r.description),
    quelleId: null, quelleName: null,
  }
}

export interface ListenErgebnis<T> {
  zeilen: T[]
  /** 'katalog' = meta-werkzeuge fehlt, Liste kommt aus dem Katalog des Assistenten */
  quelle: 'werkzeuge' | 'katalog'
  warnungen: string[]
  /** Wohnen-Prüfung beim Laden: noch offen (über 25 je Aufruf) */
  offen?: number
}

let zielgruppenCache: Promise<ListenErgebnis<ZielgruppeZeile>> | null = null

export function ladeZielgruppen(refresh = false): Promise<ListenErgebnis<ZielgruppeZeile>> {
  if (!zielgruppenCache || refresh) {
    zielgruppenCache = (async () => {
      try {
        const data = await werkzeugCall('audiences_list', { sac_land: 'DE' })
        return {
          zeilen: (data.items ?? []).map(zielgruppeAusServer),
          quelle: 'werkzeuge' as const,
          warnungen: data.warnings ?? [],
          offen: data.sac?.offen ?? 0,
        }
      } catch (err) {
        if (fehlerCode(err) !== FUNKTION_FEHLT) throw err
        const k = await ladeKatalog(refresh)
        const zeilen = (k.custom_audiences ?? []).map(a => zielgruppeAusKatalog(a as unknown as Roh)).filter((z): z is ZielgruppeZeile => !!z)
        return { zeilen, quelle: 'katalog' as const, warnungen: [] }
      }
    })().catch(err => {
      zielgruppenCache = null
      throw err
    })
  }
  return zielgruppenCache
}

/** Höchstens so viele IDs je audience_eligibility-Aufruf (Grenze von meta-builder) */
const ELIGIBILITY_PAKET = 10

export interface EignungErgebnis {
  treffer: Map<string, { ok: boolean | null; grund: string | null }>
  /** Fehler eines späteren Pakets; die Treffer der Pakete davor bleiben gültig */
  fehler: unknown | null
}

/** Wohnen-Eignung (DE) über den Lese-Modus audience_eligibility von meta-builder, in Paketen zu 10 */
export async function pruefeWohnenEignung(ids: string[], laender: string[] = ['DE']): Promise<EignungErgebnis> {
  const treffer = new Map<string, { ok: boolean | null; grund: string | null }>()
  for (let i = 0; i < ids.length; i += ELIGIBILITY_PAKET) {
    try {
      const res = await builderCall('audience_eligibility', { ids: ids.slice(i, i + ELIGIBILITY_PAKET), countries: laender })
      for (const it of res.items ?? []) treffer.set(it.id, { ok: it.sac_eligible ?? null, grund: it.reason ?? null })
    } catch (err) {
      return { treffer, fehler: err }
    }
  }
  return { treffer, fehler: null }
}

// ── Sofortformulare lesen ────────────────────────────────────────────────────

export interface FormularZeile {
  id: string
  name: string
  status: string | null
  locale: string | null
  leads: number | null
  erstellt: string | null
  /** true = Höhere Absicht, false = Höheres Volumen, null = unbekannt */
  hoehereAbsicht: boolean | null
}

function formularZeileAus(r: Roh): FormularZeile | null {
  const id = text(r.id)
  if (!id) return null
  const typ = text(r.typ)
  return {
    id,
    name: text(r.name) ?? id,
    status: text(r.status),
    locale: text(r.locale),
    leads: zahl(erstes(r, ['leads_count', 'leads'])),
    erstellt: zeitText(erstes(r, ['erstellt', 'created_time'])),
    hoehereAbsicht: typ === 'HIGHER_INTENT' ? true : typ === 'MORE_VOLUME' ? false : wahr(r.is_optimized_for_quality),
  }
}

let formularCache: Promise<ListenErgebnis<FormularZeile>> | null = null

export function ladeFormulare(refresh = false): Promise<ListenErgebnis<FormularZeile>> {
  if (!formularCache || refresh) {
    formularCache = (async () => {
      try {
        const data = await werkzeugCall('leadforms_list', {})
        const zeilen = (data.items ?? []).map(f => formularZeileAus(f as unknown as Roh)).filter((z): z is FormularZeile => !!z)
        return { zeilen, quelle: 'werkzeuge' as const, warnungen: data.warnings ?? [] }
      } catch (err) {
        if (fehlerCode(err) !== FUNKTION_FEHLT) throw err
        const k = await ladeKatalog(refresh)
        const zeilen = (k.lead_forms ?? []).map(f => formularZeileAus(f as unknown as Roh)).filter((z): z is FormularZeile => !!z)
        return { zeilen, quelle: 'katalog' as const, warnungen: [] }
      }
    })().catch(err => {
      formularCache = null
      throw err
    })
  }
  return formularCache
}

/** Ein Formular mit allen Feldern als Editor-Vorlage */
export function ladeFormular(id: string): Promise<LeadformGetResponse> {
  return werkzeugCall('leadform_get', { id })
}

// ── Einstellungen (ad_settings, ohne Meta-Aufruf) ────────────────────────────

export interface WerkzeugEinstellungen {
  /** Anlegen bei Meta freigeschaltet; null = unbekannt (Spalte oder Zeile fehlt) */
  builderEnabled: boolean | null
  /** Kundenlisten von Sven freigegeben; null = Spalte fehlt (Migration noch nicht eingespielt) */
  kundenlisteFreigegeben: boolean | null
  pageId: string | null
  pixelId: string | null
  igUserId: string | null
  /** true = ad_settings nicht lesbar (Netz, Rechte); dann sagt null oben nichts über die Migration */
  fehler?: boolean
}

const OHNE: WerkzeugEinstellungen = { builderEnabled: null, kundenlisteFreigegeben: null, pageId: null, pixelId: null, igUserId: null }
const NICHT_LESBAR: WerkzeugEinstellungen = { ...OHNE, fehler: true }
const BASIS_FELDER = 'builder_enabled, default_page_id, default_pixel_id, default_ig_user_id'

const einstellungAus = (r: Roh, mitKundenliste: boolean): WerkzeugEinstellungen => ({
  builderEnabled: r.builder_enabled === true,
  kundenlisteFreigegeben: mitKundenliste ? r.kundenliste_freigegeben === true : null,
  pageId: text(r.default_page_id),
  pixelId: text(r.default_pixel_id),
  igUserId: text(r.default_ig_user_id),
})

let einstellungenCache: Promise<WerkzeugEinstellungen> | null = null

/** Eine Zeile ad_settings. Fehlt kundenliste_freigegeben noch, ein zweiter Versuch ohne.
 *  Lesefehler (Netz, Rechte) kommen als { fehler: true } und bleiben nicht im Speicher. */
export function ladeWerkzeugEinstellungen(refresh = false): Promise<WerkzeugEinstellungen> {
  if (!einstellungenCache || refresh) {
    const laden: Promise<WerkzeugEinstellungen> = (async () => {
      try {
        const voll = await supabase.from('ad_settings').select(`${BASIS_FELDER}, kundenliste_freigegeben`).eq('id', 'default').maybeSingle()
        // Keine Zeile: nichts freigeschaltet (der Server sieht es genauso)
        if (!voll.error) return voll.data ? einstellungAus(voll.data as Roh, true) : { ...OHNE, kundenlisteFreigegeben: false }
        const basis = await supabase.from('ad_settings').select(BASIS_FELDER).eq('id', 'default').maybeSingle()
        if (basis.error) {
          console.warn('[Werkzeuge] ad_settings nicht lesbar:', basis.error)
          return NICHT_LESBAR
        }
        // Mit Spalte scheitert die Abfrage, ohne nicht: die Spalte fehlt (Migration ausstehend)
        return basis.data ? einstellungAus(basis.data as Roh, false) : OHNE
      } catch (err) {
        console.warn('[Werkzeuge] ad_settings nicht lesbar:', err)
        return NICHT_LESBAR
      }
    })()
    einstellungenCache = laden
    void laden.then(e => { if (e.fehler && einstellungenCache === laden) einstellungenCache = null })
  }
  return einstellungenCache
}

/** Kundenlisten freigeben oder sperren (nur Admin; der Schutz-Trigger prüft das selbst). */
export async function setzeKundenlisteFreigabe(an: boolean): Promise<WerkzeugEinstellungen> {
  const { data, error } = await supabase.from('ad_settings')
    .update({ kundenliste_freigegeben: an, updated_at: new Date().toISOString() })
    .eq('id', 'default')
    .select(`${BASIS_FELDER}, kundenliste_freigegeben`)
    .single()
  if (error) throw error
  const neu = einstellungAus(data as Roh, true)
  einstellungenCache = Promise.resolve(neu)
  return neu
}

/** Lesbarer Text zu einem Datenbankfehler (Rechte, fehlende Spalte) */
export function dbFehlerText(t: TFunction, err: unknown): string {
  const e = (err ?? {}) as { code?: string; message?: string }
  if (e.code === '42501') return t('crm.werbung.zielgruppen.fehler.keinRecht', 'Das darf nur ein Admin (Sven).')
  if (e.code === '42703' || e.code === 'PGRST204') return t('crm.werbung.zielgruppen.fehler.spalteFehlt', 'Die Einstellung gibt es in der Datenbank noch nicht (Migration ausstehend).')
  return e.message || String(err)
}
