// meta-werkzeuge: pixel_diagnose (Karte „Datensatz-Gesundheit“, „Ereignisse aus dem CRM“,
// „Conversion-Leads-Stufen“ im Reiter Messung & Konto).
//
// Meta-Teil (jede Teilabfrage darf scheitern, dann Hinweis in warnings):
//   1 Pixel-Grunddaten (letzter Empfang, verfügbar). Nicht lesbar -> meta_fehler, CRM-Teil läuft weiter.
//   2 Pixel-Statistik 7 Tage (GET /{pixel}/stats aggregation=event, stundenweise Blöcke):
//     je Ereignis Anzahl 24 h / 7 Tage und Beginn der letzten Stunde mit Empfang.
//   3 Datensatzqualität (GET /dataset_quality?dataset_id=…): Event Match Quality, Merkmale,
//     Diagnosen; wenn Meta sie liefert auch Datenfrische, Abdeckung, ACR, Potenzial.
//     NICHT VERIFIZIERT: die Zusatzfelder event_coverage, data_freshness, acr,
//     event_potential_aly_acr_increase (Meta-Doku Dataset Quality API). Fehlt eins, fällt die
//     Abfrage auf die bewährten Felder zurück.
//   Über 75 % Meta-Auslastung entfallen 2 und 3.
// CRM-Teil (nur eigene DB, seriell, Zeitfilter 30 Tage, höchstens 5.000 Zeilen je Tabelle):
//   capi_log (gesendet, inkl. Tageslauf) + capi_outbox (offen, Fehler, übersprungen, Test) je
//   Ereignis; Conversion-Leads-Stufen (event_id crm-…); Sofortformular-Leads mit Meta-Lead-ID in
//   30 Tagen; auf Wunsch Test-Kandidaten (Ausgang-Ereignisse interner Kontakte, noch nicht
//   gesendet, höchstens 7 Tage alt, nur Meta-Leads wie in werbe-signal) für werbe-signal
//   { aktion: 'test', event_id }.
//   Gehen die CRM-Stufen an einen eigenen Datensatz (META_CRM_DATASET_ID), liest die Diagnose
//   ihn nicht (spart Meta-Abfragen) und sagt das als Hinweis.
// Personendaten: keine. Test-Kandidaten tragen nur event_id, Ereignis, Zeit und Status.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { graphAll, graphGet } from '../_shared/metaGraph.ts'
import { crmDatensatzId, istCrmStufenEventId, istMetaLead } from '../_shared/werbeCapi.ts'
import {
  arr, auslastungHoch, HP_PIXEL_ID, isoZeit, kontoPixel, metaId, num, obj, softMsg, str, WerkzeugError, type Ctx, type Raw,
} from './common.ts'
import {
  CAPI_EREIGNIS_LABEL, CAPI_GRUND_LABEL, CAPI_STANDARD_EREIGNISSE, CRM_LEAD_EVENT_SOURCE, CRM_LEADS_EMPFEHLUNG_MONAT,
  CRM_STUFEN,
  type CapiEreignisArt, type CapiEreignisStatistik, type CapiTestKandidat, type CrmStufeStatus, type DiagnoseAmpel,
  type PixelDiagnoseCrm, type PixelDiagnoseRequest, type PixelDiagnoseResponse, type PixelEmq, type PixelEreignisStatus,
} from './typen.ts'

const STUNDE_MS = 3_600_000
const TAG_MS = 86_400_000
const STATS_MAX_SEITEN = 8
const CRM_MAX_ZEILEN = 5000
const TEST_MAX_LEADS = 20
/** so viele Leads werden in EINER Abfrage auf Meta-Herkunft geprüft, bevor die Intern-Prüfung läuft */
const TEST_MAX_LEADS_LESEN = 100
const TEST_MAX_INTERN = 5
const TEST_MAX_KANDIDATEN = 10

const PIXEL_FELDER = [
  'id,name,last_fired_time,is_unavailable,creation_time,automatic_matching_fields,enable_automatic_matching,first_party_cookie_status',
  'id,name,last_fired_time,is_unavailable',
]
const EMQ_TEIL = 'event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage}},diagnostics{name,description,solution,percentage}}'
const DQ_FELDER = [
  `web{event_name,${EMQ_TEIL},event_coverage{percentage,goal_percentage},data_freshness{upload_frequency},acr{percentage},event_potential_aly_acr_increase{percentage}}`,
  `web{event_name,${EMQ_TEIL}}`,
  'web{event_name,event_match_quality}',
]
const MERKMAL_LABEL: Record<string, string> = {
  email: 'E-Mail', phone: 'Telefon', external_id: 'Externe ID', ip_address: 'IP-Adresse', user_agent: 'Browser',
  fbc: 'Klick-ID (fbc)', fbp: 'Browser-ID (fbp)', first_name: 'Vorname', last_name: 'Nachname', country: 'Land',
  city: 'Stadt', zip: 'PLZ', lead_id: 'Lead-ID',
}

const zahlDe = (n: number): string => n.toLocaleString('de-DE', { maximumFractionDigits: 1 })
const stufeLabel = new Map<string, string>(CRM_STUFEN.map(s => [s.ereignis, s.label] as [string, string]))

/** Bezeichnung in der CRM-Statistik (Website-Lead und CRM-Stufe „Lead aus Sofortformular“ heißen beide „Lead“) */
function ereignisLabel(name: string, art: CapiEreignisArt = 'standard'): string {
  if (art === 'crm_stufe') return stufeLabel.get(name) ?? name
  if (name === 'Lead') return 'Lead (Website-Funnel)'
  return CAPI_EREIGNIS_LABEL[name] ?? name
}

/** Bezeichnung im Datensatz. CRM-Stufen mit Zusatz, sonst stünden z. B. Schedule und die Stufe „Termin gebucht“ gleich da */
function datensatzLabel(name: string): string {
  const standard = CAPI_EREIGNIS_LABEL[name]
  if (standard) return standard
  const stufe = stufeLabel.get(name)
  return stufe ? `${stufe} (CRM-Stufe)` : name
}

// ── Meta: Empfang je Ereignis (Pixel-Statistik) ──────────────────────────────

interface Empfang { n24: number; n7: number; zuletzt: number | null }

async function pixelStatistik(pixelId: string, warnings: string[]): Promise<Map<string, Empfang> | null> {
  if (auslastungHoch()) {
    warnings.push('Pixel-Statistik übersprungen (Meta-Auslastung hoch).')
    return null
  }
  const jetzt = Date.now()
  try {
    // strict: bricht Meta das Paging ab (Seitengrenze, Auslastung über 90 %), lieber keine Zahlen
    // mit Hinweis als still zu niedrige
    const bloecke = await graphAll<Raw>(`${pixelId}/stats`, {
      aggregation: 'event', start_time: Math.floor((jetzt - 7 * TAG_MS) / 1000),
    }, { maxPages: STATS_MAX_SEITEN, strict: true })
    const out = new Map<string, Empfang>()
    for (const b of bloecke) {
      const t = isoZeit(obj(b).start_time)
      const ms = t ? Date.parse(t) : null
      for (const d of arr<Raw>(obj(b).data)) {
        const name = str(obj(d).value)
        const n = num(obj(d).count) ?? 0
        if (!name || n <= 0) continue
        const e = out.get(name) ?? { n24: 0, n7: 0, zuletzt: null }
        e.n7 += n
        // stundenweise Blöcke: alles, was in den letzten 24 Stunden begonnen hat
        if (ms !== null && ms >= jetzt - TAG_MS) e.n24 += n
        if (ms !== null && (e.zuletzt === null || ms > e.zuletzt)) e.zuletzt = ms
        out.set(name, e)
      }
    }
    return out
  } catch (e) {
    const msg = softMsg(e)
    warnings.push(/unvollständig|abgebrochen/i.test(msg)
      ? `Pixel-Statistik unvollständig, deshalb ohne Zahlen: ${msg}`
      : `Pixel-Statistik nicht lesbar: ${msg}`)
    return null
  }
}

// ── Meta: Datensatzqualität (Dataset Quality API) ────────────────────────────

interface Qualitaet {
  emq: PixelEmq
  datenfrische: string | null
  abdeckung_pct: number | null
  acr_pct: number | null
  potenzial_pct: number | null
}

async function datensatzQualitaet(pixelId: string, warnings: string[]): Promise<Map<string, Qualitaet>> {
  const out = new Map<string, Qualitaet>()
  if (auslastungHoch()) {
    warnings.push('Datensatzqualität übersprungen (Meta-Auslastung hoch).')
    return out
  }
  let dq: Raw | null = null
  let fehler: unknown = null
  for (const fields of DQ_FELDER) {
    try { dq = await graphGet<Raw>('dataset_quality', { dataset_id: pixelId, fields }, { retry: false }); break } catch (e) { fehler = e }
  }
  if (!dq) {
    warnings.push(`Datensatzqualität nicht lesbar: ${softMsg(fehler)}`)
    return out
  }
  for (const w0 of arr<Raw>(dq.web)) {
    const w = obj(w0)
    const name = str(w.event_name)
    if (!name) continue
    const q = obj(w.event_match_quality)
    out.set(name, {
      emq: {
        ereignis: name,
        score: num(q.composite_score),
        merkmale: arr<Raw>(q.match_key_feedback).map(m => ({
          merkmal: MERKMAL_LABEL[str(obj(m).identifier)] ?? str(obj(m).identifier),
          abdeckung_pct: num(obj(obj(m).coverage).percentage),
        })),
        diagnosen: arr<Raw>(q.diagnostics).map(d => ({
          name: str(obj(d).name),
          beschreibung: str(obj(d).description) || null,
          loesung: str(obj(d).solution) || null,
          anteil_pct: num(obj(d).percentage),
        })),
      },
      datenfrische: str(obj(w.data_freshness).upload_frequency).toUpperCase() || null,
      abdeckung_pct: num(obj(w.event_coverage).percentage),
      acr_pct: num(obj(w.acr).percentage),
      potenzial_pct: num(obj(w.event_potential_aly_acr_increase).percentage),
    })
  }
  return out
}

/** Ampel + ein Satz je Ereignis */
function bewerteEreignis(e: Omit<PixelEreignisStatus, 'ampel' | 'hinweis'>, diagnosen: number): { ampel: DiagnoseAmpel; hinweis: string | null } {
  if (e.emq !== null && e.emq < 4) {
    return { ampel: 'rot', hinweis: `Event Match Quality nur ${zahlDe(e.emq)}/10: E-Mail, Telefon und externe ID über die Conversions API mitsenden.` }
  }
  if (e.emq !== null && e.emq < 6) {
    return { ampel: 'gelb', hinweis: `Event Match Quality ${zahlDe(e.emq)}/10: mehr Merkmale mitsenden, dann ordnet Meta mehr Ereignisse zu.` }
  }
  if (diagnosen > 0) return { ampel: 'gelb', hinweis: 'Meta meldet Hinweise zu diesem Ereignis (siehe Diagnosen).' }
  if (e.datenfrische && /DAILY|WEEKLY/.test(e.datenfrische)) {
    return { ampel: 'gelb', hinweis: 'Meta bekommt dieses Ereignis nur täglich. Mit dem Echtzeit-Versand lernt Meta schneller.' }
  }
  if (!e.anzahl_7d && e.emq === null) {
    return { ampel: 'grau', hinweis: e.anzahl_7d === null ? 'Keine Angaben von Meta.' : 'In den letzten 7 Tagen nicht empfangen.' }
  }
  return { ampel: 'gruen', hinweis: null }
}

// ── CRM: Ereignisse aus capi_log + capi_outbox ───────────────────────────────

const tabelleFehlt = (e: unknown): boolean => {
  const x = e as { code?: string; message?: string } | null
  return x?.code === '42P01' || x?.code === 'PGRST205' || /does not exist|could not find the table/i.test(String(x?.message ?? ''))
}
const dbText = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e).slice(0, 160)

interface Zaehler {
  ereignis: string
  art: CapiEreignisArt
  gesendet_7d: number
  gesendet_30d: number
  zuletzt: number | null
  offen: number
  fehler_30d: number
  uebersprungen_30d: number
  test_30d: number
  gruende: Map<string, number>
}

const neuerZaehler = (ereignis: string, art: CapiEreignisArt): Zaehler => ({
  ereignis, art, gesendet_7d: 0, gesendet_30d: 0, zuletzt: null, offen: 0, fehler_30d: 0, uebersprungen_30d: 0, test_30d: 0, gruende: new Map(),
})

function alsStatistik(z: Zaehler): CapiEreignisStatistik {
  return {
    ereignis: z.ereignis,
    label: ereignisLabel(z.ereignis, z.art),
    art: z.art,
    gesendet_7d: z.gesendet_7d,
    gesendet_30d: z.gesendet_30d,
    zuletzt_gesendet: z.zuletzt !== null ? new Date(z.zuletzt).toISOString() : null,
    offen: z.offen,
    fehler_30d: z.fehler_30d,
    uebersprungen_30d: z.uebersprungen_30d,
    test_30d: z.test_30d,
    gruende: Array.from(z.gruende.entries())
      .map(([grund, anzahl]) => ({ grund, label: CAPI_GRUND_LABEL[grund] ?? grund, anzahl }))
      .sort((a, b) => b.anzahl - a.anzahl),
  }
}

interface OutboxZeile {
  event_id: string
  event_name: string
  status: string
  grund: string | null
  created_at: string
  /** Ereigniszeit (werbe-signal prüft das Alter daran) */
  event_time?: string | null
  gesendet_at: string | null
  lead_id: string | null
}

/**
 * Interne Kontakte unter den Leads (Sven, Verwaltung, Mitarbeitende), die werbe-signal auch
 * sendet: Meta-Lead (istMetaLead) oder mit CRM-Stufe (Meta-Lead-ID steht in der event_id).
 * Eine Abfrage für die Leads, dann seriell höchstens TEST_MAX_LEADS Intern-Prüfungen.
 */
async function interneLeads(sb: SupabaseClient, leadIds: string[], mitCrmStufe: Set<string>, hinweise: string[]): Promise<{ intern: Set<string>; meta: Set<string> }> {
  const out = new Set<string>()
  const meta = new Set<string>()
  if (!leadIds.length) return { intern: out, meta }
  let res = await sb.from('leads').select('id, email, phone, whatsapp, utm_source, source, fbc, meta_leadgen_id').in('id', leadIds)
  if (res.error && /meta_leadgen_id/.test(dbText(res.error))) {
    // vor Migration 20261003101000 gibt es leads.meta_leadgen_id noch nicht
    res = await sb.from('leads').select('id, email, phone, whatsapp, utm_source, source, fbc').in('id', leadIds)
  }
  if (res.error) {
    hinweise.push(`Test-Kandidaten nicht lesbar: ${dbText(res.error)}`)
    return { intern: out, meta }
  }
  const nachId = new Map(arr<Raw>(res.data).map(l => [str(obj(l).id), obj(l)] as [string, Raw]))
  let geprueft = 0
  for (const id of leadIds) {
    const l = nachId.get(id)
    if (!l || (!str(l.email) && !str(l.phone) && !str(l.whatsapp))) continue
    // werbe-signal lehnt Nicht-Meta-Leads ab (kein_meta_lead): solche nie als Test anbieten
    if (istMetaLead({ utm_source: str(l.utm_source), source: str(l.source), fbc: str(l.fbc), meta_leadgen_id: str(l.meta_leadgen_id) })) meta.add(id)
    else if (!mitCrmStufe.has(id)) continue
    if (geprueft >= TEST_MAX_LEADS) break
    geprueft++
    const r = await sb.rpc('werbe_ist_intern_kontakt', { p_email: str(l.email) || null, p_phone: str(l.phone) || null, p_whatsapp: str(l.whatsapp) || null })
    if (r.error) {
      hinweise.push(`Interne Kontakte nicht prüfbar: ${dbText(r.error)}`)
      return { intern: new Set<string>(), meta }
    }
    if (r.data === true) out.add(id)
    if (out.size >= TEST_MAX_INTERN) break
  }
  return { intern: out, meta }
}

async function crmStatistik(ctx: Ctx, mitTest: boolean, pixelId: string): Promise<PixelDiagnoseCrm> {
  const sb = ctx.sb
  const hinweise: string[] = []
  const jetzt = Date.now()
  const seit30 = new Date(jetzt - 30 * TAG_MS).toISOString()
  const grenze7 = jetzt - 7 * TAG_MS
  const crm: PixelDiagnoseCrm = {
    verfuegbar: false, echtzeit: null, test_code_gesetzt: null, crm_datensatz_id: crmDatensatzId(),
    lead_event_source: CRM_LEAD_EVENT_SOURCE, ereignisse: [], stufen: [], leadgen_leads_30d: null,
    leadgen_empfehlung_monat: CRM_LEADS_EMPFEHLUNG_MONAT, test_kandidaten: [], abgeschnitten: false, hinweise,
  }

  // 1 Einstellungen (der Test-Code selbst wird nie ausgeliefert)
  const st = await sb.from('ad_settings').select('capi_echtzeit, capi_test_event_code').eq('id', 'default').maybeSingle()
  if (st.error) hinweise.push(`Werbe-Einstellungen nicht lesbar: ${dbText(st.error)}`)
  else {
    crm.echtzeit = obj(st.data).capi_echtzeit === true
    crm.test_code_gesetzt = str(obj(st.data).capi_test_event_code).trim() !== ''
  }

  // 2 Ausgang (30 Tage)
  let outbox: OutboxZeile[] = []
  const ob = await sb.from('capi_outbox').select('event_id, event_name, status, grund, created_at, event_time, gesendet_at, lead_id')
    .gte('created_at', seit30).order('id', { ascending: false }).limit(CRM_MAX_ZEILEN)
  if (ob.error) {
    hinweise.push(tabelleFehlt(ob.error)
      ? 'Der CAPI-Ausgang fehlt noch (Migration 20261003112000_capi_outbox.sql nicht eingespielt).'
      : `CAPI-Ausgang nicht lesbar: ${dbText(ob.error)}`)
  } else {
    crm.verfuegbar = true
    outbox = arr<OutboxZeile>(ob.data)
    if (outbox.length >= CRM_MAX_ZEILEN) crm.abgeschnitten = true
  }

  // 3 Gesendet: capi_log (auch Tageslauf) + Ausgang status gesendet, je event_id einmal
  const gesendet = new Map<string, { name: string; ms: number | null }>()
  const lg = await sb.from('capi_log').select('event_id, event_name, sent_at')
    .gte('sent_at', seit30).order('sent_at', { ascending: false }).limit(CRM_MAX_ZEILEN)
  if (lg.error) hinweise.push(`Versandprotokoll (capi_log) nicht lesbar: ${dbText(lg.error)}`)
  else {
    const zeilen = arr<Raw>(lg.data)
    if (zeilen.length >= CRM_MAX_ZEILEN) crm.abgeschnitten = true
    for (const r of zeilen) {
      const id = str(r.event_id)
      if (!id) continue
      const t = isoZeit(r.sent_at)
      gesendet.set(id, { name: str(r.event_name), ms: t ? Date.parse(t) : null })
    }
  }
  for (const z of outbox) {
    if (z.status !== 'gesendet' || gesendet.has(z.event_id)) continue
    const t = isoZeit(z.gesendet_at) ?? isoZeit(z.created_at)
    gesendet.set(z.event_id, { name: z.event_name, ms: t ? Date.parse(t) : null })
  }

  // 4 Zählen
  const zaehler = new Map<string, Zaehler>()
  const holen = (name: string, art: CapiEreignisArt): Zaehler => {
    const k = `${art}|${name}`
    let z = zaehler.get(k)
    if (!z) { z = neuerZaehler(name, art); zaehler.set(k, z) }
    return z
  }
  for (const n of CAPI_STANDARD_EREIGNISSE) holen(n, 'standard')
  for (const s of CRM_STUFEN) holen(s.ereignis, 'crm_stufe')
  const artVon = (eventId: string): CapiEreignisArt => (istCrmStufenEventId(eventId) ? 'crm_stufe' : 'standard')
  for (const [id, g] of gesendet) {
    if (!g.name) continue
    const z = holen(g.name, artVon(id))
    z.gesendet_30d++
    if (g.ms !== null && g.ms >= grenze7) z.gesendet_7d++
    if (g.ms !== null && (z.zuletzt === null || g.ms > z.zuletzt)) z.zuletzt = g.ms
  }
  let offenAlt = 0
  let fehlerGesamt = 0
  for (const r of outbox) {
    if (!r.event_name) continue
    const z = holen(r.event_name, artVon(r.event_id))
    if (r.status === 'offen') {
      z.offen++
      if (Date.parse(r.created_at) < jetzt - STUNDE_MS) offenAlt++
    } else if (r.status === 'fehler') {
      z.fehler_30d++
      fehlerGesamt++
    } else if (r.status === 'uebersprungen') {
      if (r.grund === 'test') z.test_30d++
      else {
        z.uebersprungen_30d++
        const g = r.grund || 'unbekannt'
        z.gruende.set(g, (z.gruende.get(g) ?? 0) + 1)
      }
    }
  }
  const alle = Array.from(zaehler.values())
  const standardReihenfolge = CAPI_STANDARD_EREIGNISSE as readonly string[]
  crm.ereignisse = alle.filter(z => z.art === 'standard')
    .sort((a, b) => {
      const ia = standardReihenfolge.indexOf(a.ereignis)
      const ib = standardReihenfolge.indexOf(b.ereignis)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.gesendet_30d - a.gesendet_30d
    })
    .map(alsStatistik)
  crm.stufen = CRM_STUFEN.map((s, i): CrmStufeStatus => ({
    ...alsStatistik(holen(s.ereignis, 'crm_stufe')),
    key: s.key,
    label: s.label,
    erklaerung: s.erklaerung,
    reihenfolge: i + 1,
  }))

  // 5 Sofortformular-Leads mit Meta-Lead-ID (30 Tage)
  const lc = await sb.from('leads').select('id', { count: 'exact', head: true })
    .not('meta_leadgen_id', 'is', null).gte('created_at', seit30)
  if (lc.error) {
    hinweise.push(/meta_leadgen_id/.test(dbText(lc.error))
      ? 'Leads haben noch keine Spalte für die Meta-Lead-ID (Migration 20261003101000 nicht eingespielt).'
      : `Sofortformular-Leads nicht zählbar: ${dbText(lc.error)}`)
  } else crm.leadgen_leads_30d = typeof lc.count === 'number' ? lc.count : null

  // 6 Hinweise in einfachem Deutsch
  if (crm.echtzeit === false) {
    hinweise.push('Echtzeit-Versand ist aus: die Conversion-Leads-Stufen gehen nicht an Meta. Einschalten kann nur ein Admin in den Werbe-Einstellungen.')
  }
  if (crm.leadgen_leads_30d !== null && crm.leadgen_leads_30d < CRM_LEADS_EMPFEHLUNG_MONAT) {
    hinweise.push(`In den letzten 30 Tagen ${crm.leadgen_leads_30d} Sofortformular-Leads. Meta empfiehlt für „Anzahl qualifizierter Leads maximieren“ rund ${CRM_LEADS_EMPFEHLUNG_MONAT} im Monat.`)
  }
  if (crm.echtzeit === true && (crm.leadgen_leads_30d ?? 0) > 0 && crm.stufen[0] && crm.stufen[0].gesendet_30d === 0) {
    hinweise.push('Es gibt Sofortformular-Leads, aber die Einstiegsstufe „Lead“ wurde in 30 Tagen nie gemeldet. Ausgang und werbe-signal prüfen.')
  }
  if (fehlerGesamt > 0) hinweise.push(`${fehlerGesamt} Ereignisse konnten in 30 Tagen nicht an Meta gesendet werden.`)
  if (offenAlt > 0 && crm.echtzeit === true) hinweise.push(`${offenAlt} Ereignisse warten seit über einer Stunde im Ausgang. werbe-signal prüfen.`)
  if (crm.abgeschnitten) hinweise.push('Mehr als 5.000 Zeilen in 30 Tagen: die Zahlen sind unvollständig.')
  if (crm.crm_datensatz_id && crm.crm_datensatz_id !== pixelId) {
    hinweise.push(`Die CRM-Stufen gehen an den Datensatz ${crm.crm_datensatz_id}, diese Diagnose liest aber den Pixel ${pixelId}. Ob Meta die Stufen empfängt, zeigt der Events Manager beim Datensatz ${crm.crm_datensatz_id}.`)
  }

  // 7 Test-Kandidaten: interne Kontakte, frisch, noch nicht gesendet
  if (mitTest && outbox.length) {
    const testbar = outbox.filter(r => {
      if (!r.lead_id || gesendet.has(r.event_id)) return false
      // werbe-signal prüft das Alter an der Ereigniszeit
      const t = Date.parse(r.event_time || r.created_at)
      if (!Number.isFinite(t) || t < grenze7) return false
      return r.status === 'offen' || r.status === 'fehler' || (r.status === 'uebersprungen' && (r.grund === 'test' || r.grund === 'echtzeit_aus'))
    })
    const leadIds: string[] = []
    const mitCrmStufe = new Set<string>()
    for (const r of testbar) {
      const id = String(r.lead_id)
      if (artVon(r.event_id) === 'crm_stufe') mitCrmStufe.add(id)
      if (leadIds.indexOf(id) < 0) {
        if (leadIds.length >= TEST_MAX_LEADS_LESEN) continue
        leadIds.push(id)
      }
    }
    const { intern, meta } = await interneLeads(sb, leadIds, mitCrmStufe, hinweise)
    crm.test_kandidaten = testbar
      // Standard-Ereignisse nur von Meta-Leads; CRM-Stufen tragen die Meta-Lead-ID selbst (event_id)
      .filter(r => intern.has(String(r.lead_id)) && (artVon(r.event_id) === 'crm_stufe' || meta.has(String(r.lead_id))))
      .slice(0, TEST_MAX_KANDIDATEN)
      .map((r): CapiTestKandidat => {
        const art = artVon(r.event_id)
        return { event_id: r.event_id, ereignis: r.event_name, label: ereignisLabel(r.event_name, art), art, erstellt: r.created_at, status: r.status }
      })
    if (!crm.test_kandidaten.length) {
      hinweise.push('Kein Testereignis verfügbar: dafür mit Svens eigener Mail oder Nummer ein Test-Sofortformular ausfüllen (Testtool für Lead-Anzeigen bei Meta) oder über eine eigene Meta-Anzeige einen Termin buchen. Hier erscheinen nur Meta-Leads interner Kontakte.')
    }
  }
  return crm
}

// ── Modus ────────────────────────────────────────────────────────────────────

export async function modePixelDiagnose(ctx: Ctx, req: PixelDiagnoseRequest): Promise<PixelDiagnoseResponse> {
  const st = await ctx.settings()
  const pixelId = metaId(req.pixel_id ?? st.default_pixel_id, 'pixel_id')
  const warnings: string[] = []
  const hinweise: string[] = []

  const konto = await kontoPixel(ctx.env.account)
  if (konto && !konto.has(pixelId)) throw new WerkzeugError(403, 'forbidden', `Pixel ${pixelId} gehört nicht zum Werbekonto.`)
  if (!konto) warnings.push('Pixel-Liste des Werbekontos nicht lesbar.')

  // 1 Grunddaten: nicht lesbar -> meta_fehler, CRM-Teil kommt trotzdem
  let p: Raw | null = null
  let letzter: unknown = null
  for (const fields of PIXEL_FELDER) {
    try { p = await graphGet<Raw>(pixelId, { fields }); break } catch (e) { letzter = e }
  }
  const metaFehler = p ? null : `Pixel bei Meta nicht lesbar: ${softMsg(letzter)}`
  const letzterEmpfang = p ? isoZeit(p.last_fired_time) : null
  const stunden = letzterEmpfang ? Math.max(0, Math.round((Date.now() - Date.parse(letzterEmpfang)) / STUNDE_MS)) : null

  // 2 + 3 nur, wenn Meta grundsätzlich antwortet (spart Abfragen bei Token- oder Rechtefehlern)
  const empfang = p ? await pixelStatistik(pixelId, warnings) : null
  const qualitaet = p ? await datensatzQualitaet(pixelId, warnings) : new Map<string, Qualitaet>()
  const emq: PixelEmq[] = Array.from(qualitaet.values()).map(q => q.emq)

  // je Ereignis zusammenführen
  const namen = new Set<string>([...(empfang ? Array.from(empfang.keys()) : []), ...Array.from(qualitaet.keys())])
  const ereignisse: PixelEreignisStatus[] = Array.from(namen).map(name => {
    const e = empfang?.get(name) ?? null
    const q = qualitaet.get(name) ?? null
    const basis = {
      ereignis: name,
      label: datensatzLabel(name),
      anzahl_24h: empfang ? (e?.n24 ?? 0) : null,
      anzahl_7d: empfang ? (e?.n7 ?? 0) : null,
      zuletzt_empfangen: e && e.zuletzt !== null ? new Date(e.zuletzt).toISOString() : null,
      emq: q?.emq.score ?? null,
      datenfrische: q?.datenfrische ?? null,
      abdeckung_pct: q?.abdeckung_pct ?? null,
      zusaetzliche_conversions_pct: q?.acr_pct ?? null,
      potenzial_pct: q?.potenzial_pct ?? null,
    }
    return { ...basis, ...bewerteEreignis(basis, q?.emq.diagnosen.length ?? 0) }
  }).sort((a, b) => (b.anzahl_7d ?? 0) - (a.anzahl_7d ?? 0) || a.ereignis.localeCompare(b.ereignis))

  // Ampel gesamt
  let rot = false
  let gelb = false
  const nichtVerfuegbar = p?.is_unavailable === true
  if (metaFehler) { rot = true; hinweise.push(`${metaFehler}. Die Zahlen aus dem CRM sind trotzdem aktuell.`) }
  if (nichtVerfuegbar) { rot = true; hinweise.push('Meta markiert den Pixel als nicht verfügbar.') }
  if (p) {
    if (stunden === null) { rot = true; hinweise.push('Der Pixel hat noch nie Daten empfangen.') }
    else if (stunden > 48) { rot = true; hinweise.push(`Seit ${stunden} Stunden kein Ereignis empfangen: Website-Code und Consent-Banner prüfen.`) }
    else if (stunden > 24) { gelb = true; hinweise.push(`Seit ${stunden} Stunden kein Ereignis empfangen.`) }
  }
  for (const e of emq) {
    if (e.score !== null && e.score < 6) {
      gelb = true
      hinweise.push(`Event Match Quality „${e.ereignis}“ nur ${zahlDe(e.score)}/10: mehr Merkmale (E-Mail, Telefon, externe ID) per Conversions API senden.`)
    }
    if (e.diagnosen.length) {
      gelb = true
      for (const d of e.diagnosen.slice(0, 3)) hinweise.push(`${e.ereignis}: ${d.name}`)
    }
  }

  // CRM-Teil (nur eigene DB)
  let crm: PixelDiagnoseCrm | null = null
  if (req.crm !== false) {
    try {
      crm = await crmStatistik(ctx, req.test_kandidaten === true, pixelId)
      const fehler = crm.ereignisse.concat(crm.stufen).reduce((s, z) => s + z.fehler_30d, 0)
      if (fehler > 0) gelb = true
    } catch (e) {
      warnings.push(`CRM-Ereignisse nicht lesbar: ${e instanceof Error ? e.message.slice(0, 160) : 'unbekannter Fehler'}`)
    }
  }
  if (!rot && !gelb) hinweise.push('Pixel empfängt Daten, keine Auffälligkeiten.')

  return {
    id: pixelId,
    name: str(p?.name) || (konto?.get(pixelId) ?? null),
    im_konto: konto ? true : null,
    ist_hp_pixel: pixelId === (st.default_pixel_id || HP_PIXEL_ID),
    letzter_empfang: letzterEmpfang,
    stunden_seit_empfang: stunden,
    nicht_verfuegbar: nichtVerfuegbar,
    ereignisse_24h: ereignisse.filter(e => (e.anzahl_24h ?? 0) > 0)
      .map(e => ({ ereignis: e.ereignis, anzahl: e.anzahl_24h ?? 0 }))
      .sort((a, b) => b.anzahl - a.anzahl),
    emq,
    ereignisse,
    meta_fehler: metaFehler,
    ampel: rot ? 'rot' : gelb ? 'gelb' : 'gruen',
    hinweise,
    crm,
    stand: new Date().toISOString(),
    warnings,
  }
}
