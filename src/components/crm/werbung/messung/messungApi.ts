import type { TFunction } from 'i18next'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail } from '../../../../lib/fnError'
import {
  CAPI_EREIGNIS_LABEL, CAPI_GRUND_LABEL, CAPI_STANDARD_EREIGNISSE, CRM_LEAD_EVENT_SOURCE, CRM_LEADS_EMPFEHLUNG_MONAT, CRM_STUFEN,
  type CapiEreignisStatistik, type CrmStufeKey, type CrmStufeStatus, type DiagnoseAmpel, type PixelDiagnoseCrm,
  type PixelDiagnoseResponse, type PixelEmq, type PixelEreignisStatus,
} from '../../../../lib/werbeWerkzeuge'
import { BuilderFehler, fehlerCode } from '../kampagnen/builderApi'
import { werkzeugCall, werkzeugFehlerText, FUNKTION_FEHLT } from '../zielgruppen/werkzeugeApi'
import {
  KONTO_SPERRGRUND_LABEL, KONTO_STATUS_LABEL, KONTO_WRITE_MODES,
  type KontoMode, type KontoRequestMap, type KontoResponse, type KontoResponseMap, type KontoStatusKey,
} from '../../../../lib/werbeKonto'
import type { CrmEreignisseErgebnis, MessEinstellungen, OutboxZeile } from './typen'

// ── Aufrufe für den Reiter „Messung & Konto" ─────────────────────────────────
// Quellen:
//   meta-werkzeuge  pixel_diagnose (Datensatz + CRM-Ereignisse + Stufen + Test-
//                   Kandidaten in EINEM Aufruf), custom_conversions_list/_create
//                   (Typen aus src/lib/werbeWerkzeuge.ts, Aufruf über werkzeugCall)
//   meta-konto      konto, konto_ausgabenlimit, kommentare_* (Typen aus
//                   src/lib/werbeKonto.ts, Aufruf über kontoCall)
//   werbe-signal    aktion 'test' mit dry_run (nur Admin, nur interne Kontakte)
//   capi_outbox     nur Ersatz, wenn die deployte pixel_diagnose noch kein `crm`
//                   liefert: direkt per Supabase (RLS: Recht werbung/werbung_meta),
//                   EINE Abfrage mit Zeitfilter und Limit (Micro-Instanz)
// Alle Lade-Aufrufe des Reiters laufen über nacheinander(): nie parallel, weder
// gegen die Datenbank noch gegen Meta (Konto steht auf „Limited access").

type Roh = Record<string, unknown>
const istObj = (v: unknown): v is Roh => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const zahl = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const wahr = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null)
const erstes = (r: Roh, keys: string[]): unknown => {
  for (const k of keys) {
    const v = k.includes('.') ? k.split('.').reduce<unknown>((o, p) => (istObj(o) ? o[p] : undefined), r) : r[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}
const textListe = (v: unknown): string[] => {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : []
  const out: string[] = []
  for (const x of v) {
    const s = istObj(x) ? text(erstes(x, ['name', 'label', 'text', 'wert', 'value', 'id'])) : text(x)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

// ── Reihenfolge: ein Aufruf nach dem anderen ─────────────────────────────────

let kette: Promise<unknown> = Promise.resolve()
/** Führt fn erst aus, wenn alle vorher eingereihten Aufrufe fertig sind. */
export function nacheinander<T>(fn: () => Promise<T>): Promise<T> {
  const p = kette.then(fn, fn)
  kette = p.then(() => undefined, () => undefined)
  return p
}

// ── meta-konto ───────────────────────────────────────────────────────────────

const KONTO_FN = 'meta-konto'
const NETZ_FEHLER = /Failed to send|Failed to fetch|NetworkError|Load failed/i
const warte = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function istFunktionFehlt(error: unknown): Promise<boolean> {
  if (!(error instanceof FunctionsHttpError)) return false
  const res = error.context as Response
  if (!res || res.status !== 404) return false
  const body = await res.clone().json().catch(() => null) as { error?: unknown } | null
  return !(body && typeof body.error === 'string' && body.error)
}

/**
 * Ein Modus von meta-konto. Lese-Modi bekommen bei Netz-Wacklern einen zweiten
 * Versuch, Schreib-Modi nie (ob Meta schon geändert hat, wäre unklar; Ausnahme:
 * vorschau: true). 200-Antworten mit { error } gelten als Fehler.
 */
export async function kontoCall<M extends KontoMode>(mode: M, req: KontoRequestMap[M], retried = false): Promise<KontoResponseMap[M]> {
  const { data, error } = await supabase.functions.invoke(KONTO_FN, { body: { mode, ...req } })
  if (error) {
    const wiederholbar = !KONTO_WRITE_MODES.includes(mode) || (req as { vorschau?: boolean }).vorschau === true
    if (!retried && wiederholbar && NETZ_FEHLER.test(error.message ?? '')) {
      await warte(1500)
      return kontoCall(mode, req, true)
    }
    if (await istFunktionFehlt(error)) throw new BuilderFehler({ message: 'meta-konto ist noch nicht live.', code: FUNKTION_FEHLT })
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
  return data as unknown as KontoResponseMap[M]
}

/** Fehlertext für den Reiter (fehlende Function je nach Quelle, sonst wie Zielgruppen). */
export function messFehlerText(e: unknown, t: TFunction, quelle: 'konto' | 'werkzeuge' | 'signal' = 'werkzeuge'): string {
  if (fehlerCode(e) === FUNKTION_FEHLT) {
    if (quelle === 'konto') return t('crm.werbung.messung.fehler.kontoFehlt', 'Die Server-Funktion für Konto und Kommentare ist noch nicht live. Nach dem nächsten Deploy geht es hier weiter.')
    if (quelle === 'signal') return t('crm.werbung.messung.fehler.signalFehlt', 'Die Server-Funktion für den CAPI-Versand ist noch nicht live.')
    return t('crm.werbung.messung.fehler.werkzeugeFehlt', 'Die Server-Funktion für Datensatz und Conversions ist noch nicht live. Nach dem nächsten Deploy geht es hier weiter.')
  }
  const code = fehlerCode(e)
  // werbe-signal hat das Test-Ereignis übersprungen (HTTP 422 mit { uebersprungen: <grund> })
  if (code === TEST_UEBERSPRUNGEN && e instanceof BuilderFehler) {
    const satz = t('crm.werbung.messung.fehler.uebersprungen', 'Nicht gesendet: {{grund}}.', { grund: grundLabel(t, e.message) })
    return e.message === 'kein_meta_lead'
      ? `${satz} ${t('crm.werbung.messung.fehler.uebersprungenMetaLead', 'Der Kontakt kam nicht über Meta-Werbung (keine Meta-Quelle, keine Meta-Klick-ID). Solche Ereignisse gehen nie an Meta, auch nicht als Test.')}`
      : satz
  }
  const eigene: Record<string, string> = {
    limit_reached: quelle === 'konto'
      ? t('crm.werbung.messung.fehler.limitTag', 'Meta-Grenze erreicht: beim Ausgabenlimit sind höchstens 10 Änderungen pro Tag erlaubt.')
      : t('crm.werbung.messung.fehler.limit', 'Meta-Grenze erreicht.'),
    doppelt: t('crm.werbung.messung.fehler.doppelt', 'Das wurde gerade schon gesendet.'),
    unveraendert: t('crm.werbung.messung.fehler.unveraendert', 'Keine Änderung: der Wert ist schon so gesetzt.'),
    lint_blocked: t('crm.werbung.messung.fehler.lint', 'Der Text verstößt gegen eine Schreibregel (z. B. Gedankenstrich, ae statt ä oder ein Projektname).'),
  }
  if (code && eigene[code] && e instanceof BuilderFehler) {
    const detail = e.hint || e.message
    return detail && detail !== eigene[code] ? `${eigene[code]} ${detail}` : eigene[code]
  }
  return werkzeugFehlerText(e, t)
}

// ── Einstellungen (ad_settings, ohne Meta) ───────────────────────────────────

let einstellungenCache: Promise<MessEinstellungen> | null = null

/** builder_enabled und capi_echtzeit. Fehlt eine Spalte, kommt null (der Server prüft ohnehin selbst). */
export function ladeMessEinstellungen(refresh = false): Promise<MessEinstellungen> {
  if (!einstellungenCache || refresh) {
    einstellungenCache = (async () => {
      const voll = await supabase.from('ad_settings').select('builder_enabled, capi_echtzeit').eq('id', 'default').maybeSingle()
      if (!voll.error) {
        const r = (voll.data ?? {}) as Roh
        return { builderEnabled: wahr(r.builder_enabled) ?? false, capiEchtzeit: wahr(r.capi_echtzeit) ?? false }
      }
      // capi_echtzeit fehlt noch (Migration nicht eingespielt): ohne versuchen
      const basis = await supabase.from('ad_settings').select('builder_enabled').eq('id', 'default').maybeSingle()
      const r = (basis.data ?? {}) as Roh
      return { builderEnabled: basis.error ? null : wahr(r.builder_enabled) ?? false, capiEchtzeit: null }
    })().catch(err => {
      console.warn('[Messung] ad_settings nicht lesbar:', err)
      einstellungenCache = null
      return { builderEnabled: null, capiEchtzeit: null }
    })
  }
  return einstellungenCache
}

// ── CRM-Ereignisse: Ersatz aus capi_outbox ───────────────────────────────────

const TABELLE_FEHLT = /relation .* does not exist|could not find the table|42P01|PGRST205/i
const OUTBOX_LIMIT = 3000

/** Ausgang der letzten 30 Tage (eine Abfrage, nur nötige Spalten, Limit 3.000). */
export async function ladeOutbox(): Promise<CrmEreignisseErgebnis> {
  const seit = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data, error } = await supabase.from('capi_outbox')
    .select('event_id, event_name, status, grund, created_at, gesendet_at')
    .gte('created_at', seit)
    .order('created_at', { ascending: false })
    .limit(OUTBOX_LIMIT)
  if (error) {
    if (TABELLE_FEHLT.test(`${error.message ?? ''} ${(error as { code?: string }).code ?? ''}`)) return { verfuegbar: false, zeilen: [], gekappt: false }
    throw new Error(error.message)
  }
  const zeilen = (data ?? []) as OutboxZeile[]
  return { verfuegbar: true, zeilen, gekappt: zeilen.length >= OUTBOX_LIMIT }
}

const norm = (s: string): string => s.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]/g, '')

/** Conversion-Leads-Stufe einer Ausgangszeile (event_id crm-<leadgen_id>-<stufe>) oder null */
export function stufeVon(z: Pick<OutboxZeile, 'event_id' | 'event_name'>): CrmStufeKey | null {
  if (!z.event_id?.startsWith('crm-')) return null
  const teil = /^crm-[^-]+-(.+)$/.exec(z.event_id)?.[1] ?? ''
  const kandidaten = [norm(z.event_name ?? ''), norm(teil)].filter(Boolean)
  for (const s of CRM_STUFEN) {
    const n = [norm(s.key), norm(s.ereignis)]
    if (kandidaten.some(k => n.includes(k))) return s.key
  }
  return null
}

const leereStatistik = (ereignis: string, art: 'standard' | 'crm_stufe'): CapiEreignisStatistik => ({
  ereignis, label: CAPI_EREIGNIS_LABEL[ereignis] ?? ereignis, art,
  gesendet_7d: 0, gesendet_30d: 0, zuletzt_gesendet: null, offen: 0, fehler_30d: 0, uebersprungen_30d: 0, test_30d: 0, gruende: [],
})

/**
 * Ersatz für pixel_diagnose.crm aus den Ausgangszeilen (ohne capi_log: was der
 * Tageslauf direkt gesendet hat, fehlt hier). Gleiche Form wie die Server-Antwort.
 */
export function crmAusOutbox(e: CrmEreignisseErgebnis, echtzeit: boolean | null): PixelDiagnoseCrm {
  const grenze7 = Date.now() - 7 * 86_400_000
  const std = new Map<string, CapiEreignisStatistik>()
  for (const n of CAPI_STANDARD_EREIGNISSE) std.set(n, leereStatistik(n, 'standard'))
  const stufen = new Map<CrmStufeKey, CapiEreignisStatistik>()
  for (const s of CRM_STUFEN) stufen.set(s.key, { ...leereStatistik(s.ereignis, 'crm_stufe'), label: s.label })
  const gruende = new Map<CapiEreignisStatistik, Map<string, number>>()
  for (const z of e.zeilen) {
    const stufe = stufeVon(z)
    let ziel = stufe ? stufen.get(stufe) : std.get(z.event_name)
    if (!ziel) { ziel = leereStatistik(z.event_name, 'standard'); std.set(z.event_name, ziel) }
    if (z.status === 'gesendet') {
      ziel.gesendet_30d++
      const zeit = z.gesendet_at ?? z.created_at
      if (Date.parse(zeit) >= grenze7) ziel.gesendet_7d++
      if (zeit && (!ziel.zuletzt_gesendet || zeit > ziel.zuletzt_gesendet)) ziel.zuletzt_gesendet = zeit
    } else if (z.status === 'offen') ziel.offen++
    else if (z.status === 'fehler') ziel.fehler_30d++
    else if (z.grund === 'test') ziel.test_30d++
    else {
      ziel.uebersprungen_30d++
      const m = gruende.get(ziel) ?? new Map<string, number>()
      const g = z.grund || 'unbekannt'
      m.set(g, (m.get(g) ?? 0) + 1)
      gruende.set(ziel, m)
    }
  }
  for (const [ziel, m] of gruende) {
    ziel.gruende = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([grund, anzahl]) => ({ grund, label: CAPI_GRUND_LABEL[grund] ?? grund, anzahl }))
  }
  const stufenListe: CrmStufeStatus[] = CRM_STUFEN.map((s, i) => ({
    ...(stufen.get(s.key) ?? leereStatistik(s.ereignis, 'crm_stufe')), key: s.key, erklaerung: s.erklaerung, reihenfolge: i + 1,
  }))
  return {
    verfuegbar: e.verfuegbar,
    echtzeit,
    test_code_gesetzt: null,
    crm_datensatz_id: '',
    lead_event_source: CRM_LEAD_EVENT_SOURCE,
    ereignisse: [...std.values()],
    stufen: stufenListe,
    leadgen_leads_30d: null,
    leadgen_empfehlung_monat: CRM_LEADS_EMPFEHLUNG_MONAT,
    test_kandidaten: [],
    abgeschnitten: e.gekappt,
    hinweise: [],
  }
}

// ── Test-Ereignis über werbe-signal ──────────────────────────────────────────

export interface TestErgebnis {
  ok: boolean
  /** dry_run: würde als Test gesendet */
  wuerdeSenden: boolean
  eventName: string | null
  /** Meta: events_received */
  empfangen: number | null
  fbtraceId: string | null
  meldung: string | null
  warnungen: string[]
}

/** Fehlercode: werbe-signal hat das Ereignis übersprungen, message = Grund (zu_alt, kein_meta_lead …) */
const TEST_UEBERSPRUNGEN = 'test_uebersprungen'
/** { success: false, uebersprungen: <grund> } ohne error -> BuilderFehler mit dem Grund, sonst null */
function uebersprungenFehler(b: unknown): BuilderFehler | null {
  if (!istObj(b) || text(b.error)) return null
  const grund = text(b.uebersprungen)
  return grund ? new BuilderFehler({ message: grund, code: TEST_UEBERSPRUNGEN }) : null
}

/** Prüfen (dryRun) oder wirklich als Test senden. Der Server prüft „interner Kontakt" selbst (sonst 403). */
export async function testEreignis(eventId: string, testCode: string | null, dryRun: boolean): Promise<TestErgebnis> {
  const body: Roh = { aktion: 'test', event_id: eventId, ...(testCode ? { test_event_code: testCode } : {}), ...(dryRun ? { dry_run: true } : {}) }
  const { data, error } = await supabase.functions.invoke('werbe-signal', { body })
  if (error) {
    if (await istFunktionFehlt(error)) throw new BuilderFehler({ message: 'werbe-signal ist noch nicht live.', code: FUNKTION_FEHLT })
    // Übersprungen meldet werbe-signal mit 422 und { uebersprungen } ohne error: Grund statt Generik zeigen
    if (error instanceof FunctionsHttpError) {
      const fehlerBody = await (error.context as Response).clone().json().catch(() => null)
      const u = uebersprungenFehler(fehlerBody)
      if (u) throw u
    }
    throw new BuilderFehler(await fnErrorDetail(error))
  }
  const r = istObj(data) ? data : {}
  if (r.success === false) throw uebersprungenFehler(r) ?? new BuilderFehler({ message: text(r.error) ?? 'Nicht gesendet.' })
  if (text(r.gesperrt) === 'META_WRITES_DISABLED') throw new BuilderFehler({ message: 'Schreibzugriffe auf Meta sind gerade zentral gesperrt.', code: 'writes_disabled' })
  return {
    ok: r.success === true,
    wuerdeSenden: r.wuerde_test_senden === true,
    eventName: text(r.event_name),
    empfangen: zahl(r.events_received),
    fbtraceId: text(r.fbtrace_id),
    meldung: Array.isArray(r.messages) ? r.messages.map(m => text(m)).filter(Boolean).join(' ') || null : null,
    warnungen: textListe(r.warnungen),
  }
}

// ── Datensatz + CRM (pixel_diagnose) ─────────────────────────────────────────

export interface DiagnoseSicht {
  antwort: PixelDiagnoseResponse
  /** je Ereignis (aus antwort.ereignisse, bei älterer Function aus ereignisse_24h + emq gebaut) */
  ereignisse: PixelEreignisStatus[]
  /** EMQ-Details (Merkmale, Metas Hinweise) je Ereignisname */
  emqDetails: Record<string, PixelEmq>
  crm: PixelDiagnoseCrm | null
  /** CRM-Zahlen kommen aus dem Ersatz-Weg (capi_outbox, ohne Tageslauf) */
  crmErsatz: boolean
}

const AMPELN: readonly DiagnoseAmpel[] = ['gruen', 'gelb', 'rot', 'grau']
const ampelAus = (v: unknown): DiagnoseAmpel => (AMPELN.includes(v as DiagnoseAmpel) ? v as DiagnoseAmpel : 'grau')
const emqAmpel = (s: number | null): DiagnoseAmpel => (s == null ? 'grau' : s >= 6 ? 'gruen' : s >= 4 ? 'gelb' : 'rot')

/** Ereignisliste aus einer Antwort ohne `ereignisse` (Function aus Runde 1) */
function ereignisseAlt(d: PixelDiagnoseResponse): PixelEreignisStatus[] {
  const map = new Map<string, PixelEreignisStatus>()
  const hole = (name: string): PixelEreignisStatus => {
    let e = map.get(name)
    if (!e) {
      e = {
        ereignis: name, label: CAPI_EREIGNIS_LABEL[name] ?? name, anzahl_24h: null, anzahl_7d: null, zuletzt_empfangen: null,
        emq: null, datenfrische: null, abdeckung_pct: null, zusaetzliche_conversions_pct: null, potenzial_pct: null, ampel: 'grau', hinweis: null,
      }
      map.set(name, e)
    }
    return e
  }
  for (const e of d.ereignisse_24h ?? []) hole(e.ereignis).anzahl_24h = e.anzahl
  for (const q of d.emq ?? []) {
    const e = hole(q.ereignis)
    e.emq = q.score
    e.ampel = emqAmpel(q.score)
  }
  return [...map.values()]
}

const REIHENFOLGE = ['Lead', 'Schedule', 'QualifiedLead', 'AppointmentHeld', 'Purchase', 'CompleteRegistration', 'Contact', 'ViewContent', 'PageView']

export function diagnoseAus(d: PixelDiagnoseResponse): Omit<DiagnoseSicht, 'crmErsatz'> {
  const roh = (Array.isArray(d.ereignisse) ? d.ereignisse : ereignisseAlt(d)).map(e => ({ ...e, ampel: ampelAus(e.ampel) }))
  const ereignisse = roh.sort((a, b) => {
    const ia = REIHENFOLGE.indexOf(a.ereignis)
    const ib = REIHENFOLGE.indexOf(b.ereignis)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.ereignis.localeCompare(b.ereignis)
  })
  const emqDetails: Record<string, PixelEmq> = {}
  for (const q of d.emq ?? []) emqDetails[q.ereignis] = q
  return { antwort: d, ereignisse, emqDetails, crm: d.crm ?? null }
}

/**
 * EIN Aufruf für Datensatz, CRM-Ereignisse, Stufen und (nur Admin) Test-Kandidaten.
 * Kennt die deployte Function `crm` noch nicht, zählt der Reiter den Ausgang selbst.
 */
export async function ladeDiagnose(pixelId: string | null, mitTest: boolean, echtzeit: boolean | null): Promise<DiagnoseSicht> {
  const antwort = await werkzeugCall('pixel_diagnose', { ...(pixelId ? { pixel_id: pixelId } : {}), crm: true, test_kandidaten: mitTest })
  const sicht = diagnoseAus(antwort)
  if (sicht.crm || 'crm' in (antwort as object)) return { ...sicht, crmErsatz: false }
  try {
    return { ...sicht, crm: crmAusOutbox(await ladeOutbox(), echtzeit), crmErsatz: true }
  } catch (err) {
    console.warn('[Messung] capi_outbox:', err)
    return { ...sicht, crmErsatz: true }
  }
}

// ── Konto (meta-konto) ───────────────────────────────────────────────────────

export function ladeKonto(): Promise<KontoResponse> {
  return kontoCall('konto', {})
}

/** Ausgabenlimit setzen (Cent der Kontowährung) oder entfernen. vorschau: nichts senden. Nur Admin. */
export function setzeAusgabenlimit(wahl: { cents: number } | { entfernen: true }, vorschau: boolean) {
  return kontoCall('konto_ausgabenlimit', {
    ...('entfernen' in wahl ? { entfernen: true } : { spend_cap_cents: Math.round(wahl.cents) }),
    ...(vorschau ? { vorschau: true } : { confirm: true }),
  })
}

// ── Etiketten ────────────────────────────────────────────────────────────────

/** Ereignisname -> Klartext (Pixel-/CAPI-Namen bleiben in Klammern sichtbar) */
export function ereignisLabel(t: TFunction, name: string): string {
  switch (name) {
    case 'Lead': return t('crm.werbung.messung.ereignis.Lead', 'Lead')
    case 'Schedule': return t('crm.werbung.messung.ereignis.Schedule', 'Termin gebucht (Schedule)')
    case 'AppointmentHeld': return t('crm.werbung.messung.ereignis.AppointmentHeld', 'Termin stattgefunden (AppointmentHeld)')
    case 'QualifiedLead': return t('crm.werbung.messung.ereignis.QualifiedLead', 'Guter Lead (QualifiedLead)')
    case 'Purchase': return t('crm.werbung.messung.ereignis.Purchase', 'Abschluss (Purchase)')
    case 'CompleteRegistration': return t('crm.werbung.messung.ereignis.CompleteRegistration', 'Registrierung (CompleteRegistration)')
    case 'Contact': return t('crm.werbung.messung.ereignis.Contact', 'Kontakt (Contact)')
    case 'ViewContent': return t('crm.werbung.messung.ereignis.ViewContent', 'Inhalt angesehen (ViewContent)')
    case 'PageView': return t('crm.werbung.messung.ereignis.PageView', 'Seitenaufruf (PageView)')
    default: return CAPI_EREIGNIS_LABEL[name] ?? name
  }
}

/** Grund für übersprungene Ereignisse */
export function grundLabel(t: TFunction, grund: string): string {
  switch (grund) {
    case 'zu_alt': return t('crm.werbung.messung.grund.zu_alt', 'älter als 7 Tage')
    case 'bereits_gesendet': return t('crm.werbung.messung.grund.bereits_gesendet', 'schon gesendet')
    case 'ohne_lead': return t('crm.werbung.messung.grund.ohne_lead', 'ohne Lead')
    case 'lead_fehlt': return t('crm.werbung.messung.grund.lead_fehlt', 'Lead gelöscht')
    case 'kein_meta_lead': return t('crm.werbung.messung.grund.kein_meta_lead', 'kein Meta-Lead')
    case 'keine_merkmale': return t('crm.werbung.messung.grund.keine_merkmale', 'keine Kontaktdaten')
    case 'test': return t('crm.werbung.messung.grund.test', 'als Test gesendet')
    case 'ohne_leadgen_id': return t('crm.werbung.messung.grund.ohne_leadgen_id', 'ohne Meta-Lead-ID')
    case 'echtzeit_aus': return t('crm.werbung.messung.grund.echtzeit_aus', 'Echtzeit-Versand war aus')
    case 'rueckbau': return t('crm.werbung.messung.grund.rueckbau', 'beim Rückbau der Stufen angehalten')
    default: return CAPI_GRUND_LABEL[grund] ?? grund
  }
}

/** Datenmerkmal der Abgleichqualität (em, ph, fbc …) -> Klartext */
export function merkmalLabel(t: TFunction, m: string): string {
  const k = m.toLowerCase()
  const bekannt: Record<string, string> = {
    em: t('crm.werbung.messung.merkmal.em', 'E-Mail'),
    email: t('crm.werbung.messung.merkmal.em', 'E-Mail'),
    ph: t('crm.werbung.messung.merkmal.ph', 'Telefon'),
    phone: t('crm.werbung.messung.merkmal.ph', 'Telefon'),
    fn: t('crm.werbung.messung.merkmal.fn', 'Vorname'),
    ln: t('crm.werbung.messung.merkmal.ln', 'Nachname'),
    ct: t('crm.werbung.messung.merkmal.ct', 'Ort'),
    st: t('crm.werbung.messung.merkmal.st', 'Bundesland'),
    zp: t('crm.werbung.messung.merkmal.zp', 'Postleitzahl'),
    country: t('crm.werbung.messung.merkmal.country', 'Land'),
    external_id: t('crm.werbung.messung.merkmal.external_id', 'Externe ID'),
    fbc: t('crm.werbung.messung.merkmal.fbc', 'Klick-ID (fbc)'),
    fbp: t('crm.werbung.messung.merkmal.fbp', 'Browser-ID (fbp)'),
    client_ip_address: t('crm.werbung.messung.merkmal.ip', 'IP-Adresse'),
    client_user_agent: t('crm.werbung.messung.merkmal.ua', 'Browser-Kennung'),
    lead_id: t('crm.werbung.messung.merkmal.lead_id', 'Meta-Lead-ID'),
  }
  return bekannt[k] ?? m
}

/** Kontostatus mit Ton für Badge und Ampel */
export function kontoStatus(t: TFunction, key: KontoStatusKey, text: string | null): { text: string; ton: 'success' | 'warning' | 'danger' | 'neutral' } {
  const label = t(`crm.werbung.konto.status.${key}`, KONTO_STATUS_LABEL[key] ?? text ?? key)
  switch (key) {
    case 'aktiv': return { text: label, ton: 'success' }
    case 'risikopruefung': case 'abrechnung_ausstehend': case 'kulanzzeit': return { text: label, ton: 'warning' }
    case 'deaktiviert': case 'zahlung_offen': case 'schliessung_beantragt': case 'geschlossen': return { text: label, ton: 'danger' }
    default: return { text: label, ton: 'neutral' }
  }
}

/** Sperrgrund (Metas disable_reason), null = keiner */
export function sperrgrund(t: TFunction, code: number | null, text: string | null): string | null {
  if (code == null || code === 0) return text || null
  return t(`crm.werbung.messung.konto.sperre.${code}`, KONTO_SPERRGRUND_LABEL[code] ?? text ?? String(code))
}

/** Betrag in Cent der Kontowährung lesbar */
export function geld(cents: number | null, waehrung: string | null, locale: string): string {
  if (cents == null) return '-'
  const v = cents / 100
  try {
    return v.toLocaleString(locale, { style: 'currency', currency: waehrung || 'USD', maximumFractionDigits: v >= 100 ? 0 : 2 })
  } catch {
    return `${v.toLocaleString(locale)} ${waehrung ?? ''}`.trim()
  }
}

/** Zeitpunkt relativ („vor 3 Stunden"), ab 7 Tagen als Datum */
export function relativeZeit(iso: string | null, locale: string): string {
  if (!iso) return '-'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '-'
  const sek = Math.round((t - Date.now()) / 1000)
  const abs = Math.abs(sek)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (abs < 60) return rtf.format(sek, 'second')
  if (abs < 3600) return rtf.format(Math.round(sek / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(sek / 3600), 'hour')
  if (abs < 7 * 86_400) return rtf.format(Math.round(sek / 86_400), 'day')
  return new Date(t).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}
