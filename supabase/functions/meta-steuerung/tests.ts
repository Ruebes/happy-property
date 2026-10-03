// meta-steuerung: A/B-Tests (Metas Ad Studies).
//
// Meta-Pfade (Referenz ad-study, Leitfaden split-testing, SDK-Spezifikation AdStudy/AdStudyCell):
//   GET  act_{konto}/ad_studies            Tests des Werbekontos (SDK: AdAccount.ad_studies)
//   GET  {business}/ad_studies             Tests des Business (Ergänzung, Business-ID aus META_BUSINESS_ID)
//   GET  {study}?fields=...                ein Test
//   GET  {study}/cells?fields=...          Zellen (Felder ad_ids, treatment_percentage; Kanten adsets, campaigns)
//   GET  {study}/objectives?fields=...     Metas Auswertung (results ist laut SDK list<string>, Format offen)
//   POST {business}/ad_studies             anlegen (Pflicht: name, start_time, end_time, cells; Unix-Sekunden)
//   POST {study} { end_time }              beenden: Ende auf jetzt (+60 s) setzen. NIE löschen.
//
// UNGEPRÜFT (nur Doku, noch nicht gegen das echte Konto getestet; ad_studies kennt kein validate_only):
//   - type SPLIT_TEST_V2 + creative_test_config + cooldown_start_time/observation_end_time steht nur im
//     Leitfaden „Creative testing“, nicht im SDK-Enum (dort nur SPLIT_TEST, LIFT ...).
//   - end_time auf „jetzt“ setzen: Doku erlaubt nur ein Ende in der Zukunft, daher jetzt + 60 s.
//   - Feld-Erweiterung adsets.limit(50){...} auf /cells; bei Fehler Rückfall auf einzelne Kanten.
//   - Format von objectives.results (Konfidenz/Gewinner); ohne lesbare Konfidenz rechnet das CRM selbst.

import { thompsonAnteile, type ThompsonArm } from '../_shared/werbeMathe.ts'
import { budgetHeadroom, graphAll, graphGet, MetaApiError } from '../_shared/metaGraph.ts'
import {
  arr, auslastungHoch, cleanText, type Ctx, eurText, eurZuKontoCent, isoZeit, kontoDatum, kontoObjekte, kontoZuEur, metaId,
  metaIds, metaPost, num, obj, pruefeKontoObjekte, type Raw, softMsg, spiegelNamen, SteuerungError, str, uniq, usageInfo, zahlText,
} from './common.ts'
import {
  TEST_GRENZEN, TEST_KENNZAHL_EMPFOHLEN, TEST_KENNZAHL_LABEL, TEST_KENNZAHL_NIEDRIGER_BESSER, TEST_KENNZAHLEN, TEST_TYP_LABEL,
  TEST_TYPEN, type GewinnerEinstufung, type MetaTestErgebnis, type SteuerungEbene, type SteuerungGeld,
  type StudiesListRequest, type StudiesListResponse, type StudyBeendenRequest, type StudyBeendenResponse,
  type StudyCreateRequest, type StudyCreateResponse, type StudyGetRequest, type StudyGetResponse, type TestGewinner,
  type TestKennzahl, type TestObjekt, type TestStatus, type TestTyp, type TestUebersicht, type TestZelle,
  type TestZellenWerte,
} from './typen.ts'

const STUDY_FIELDS = 'id,name,description,type,start_time,end_time,observation_end_time,created_time,canceled_time,results_first_available_date,business'
const CELL_FIELDS_ERWEITERT =
  'id,name,treatment_percentage,ad_ids,adsets.limit(50){id,name,effective_status},campaigns.limit(50){id,name,effective_status}'
const CELL_FIELDS_EINFACH = 'id,name,treatment_percentage,ad_ids'

// ── HP-Kennung in der Beschreibung ───────────────────────────────────────────
// Meta speichert weder Testvariable noch Gewinner-Kennzahl. Damit beides ohne
// eigene Tabelle erhalten bleibt, steht es als erste Zeile in der Beschreibung.

const KENNUNG_RE = /^\[HP-Test typ=([a-z_]+) kennzahl=([a-z_]+)\]\s*/

export function kennungBauen(typ: TestTyp, kennzahl: TestKennzahl, text: string): string {
  const k = `[HP-Test typ=${typ} kennzahl=${kennzahl}]`
  return text ? `${k}\n${text}` : k
}

export function kennungLesen(beschreibung: string): { typ: TestTyp | null; kennzahl: TestKennzahl | null; text: string } {
  const m = KENNUNG_RE.exec(beschreibung)
  if (!m) return { typ: null, kennzahl: null, text: beschreibung.trim() }
  const typ = (TEST_TYPEN as readonly string[]).indexOf(m[1]) >= 0 ? m[1] as TestTyp : null
  const kennzahl = (TEST_KENNZAHLEN as readonly string[]).indexOf(m[2]) >= 0 ? m[2] as TestKennzahl : null
  return { typ, kennzahl, text: beschreibung.slice(m[0].length).trim() }
}

function testStatus(r: Raw, jetzt: number): TestStatus {
  if (isoZeit(r.canceled_time)) return 'abgebrochen'
  const start = Date.parse(isoZeit(r.start_time) ?? '')
  const ende = Date.parse(isoZeit(r.end_time) ?? '')
  if (Number.isFinite(start) && jetzt < start) return 'geplant'
  if (Number.isFinite(ende) && jetzt >= ende) return 'beendet'
  return 'laeuft'
}

export function testNormalisieren(r: Raw, quelle: 'konto' | 'business', jetzt = Date.now()): TestUebersicht {
  const k = kennungLesen(str(r.description))
  return {
    id: str(r.id),
    name: str(r.name) || '(ohne Namen)',
    beschreibung: k.text || null,
    typ: k.typ,
    kennzahl: k.kennzahl,
    meta_typ: str(r.type) || null,
    status: testStatus(r, jetzt),
    start: isoZeit(r.start_time),
    ende: isoZeit(r.end_time),
    erstellt: isoZeit(r.created_time),
    abgebrochen_am: isoZeit(r.canceled_time),
    ergebnisse_ab: str(r.results_first_available_date) || null,
    von_hp: k.typ !== null,
    quelle,
  }
}

const STATUS_REIHENFOLGE: Record<TestStatus, number> = { laeuft: 0, geplant: 1, beendet: 2, abgebrochen: 3 }

function nichtGefunden(err: unknown, was: string): SteuerungError | null {
  if (err instanceof MetaApiError && (err.subcode === 33 || /does not exist|nonexisting|Unsupported get request/i.test(err.userMsg ?? err.message))) {
    return new SteuerungError(404, 'not_found', `${was} nicht gefunden oder kein Zugriff.`)
  }
  return null
}

// ── studies_list ─────────────────────────────────────────────────────────────

export async function modeStudiesList(ctx: Ctx, req: StudiesListRequest): Promise<StudiesListResponse> {
  const warnings: string[] = []
  const items = new Map<string, TestUebersicht>()
  let ersterFehler: unknown = null
  let erfolg = false
  const quellen: Array<['konto' | 'business', string]> = [
    ['konto', `act_${ctx.env.account}/ad_studies`],
    ['business', `${ctx.businessId}/ad_studies`],
  ]
  for (const [quelle, pfad] of quellen) {
    if (quelle === 'business' && erfolg && auslastungHoch()) {
      warnings.push('Meta ist stark ausgelastet: Tests des Business wurden nicht zusätzlich gelesen.')
      continue
    }
    try {
      const list = await graphAll<Raw>(pfad, { fields: STUDY_FIELDS, limit: 50 }, { maxPages: 3 })
      erfolg = true
      for (const r of list) {
        const id = str(r.id)
        if (id && !items.has(id)) items.set(id, testNormalisieren(r, quelle))
      }
    } catch (e) {
      ersterFehler = ersterFehler ?? e
      warnings.push(`${quelle === 'konto' ? 'Tests des Werbekontos' : 'Tests des Business'} nicht lesbar: ${softMsg(e)}`)
    }
  }
  if (!erfolg && ersterFehler) throw ersterFehler
  let list = Array.from(items.values())
  if (req.nur_hp === true) list = list.filter(t => t.von_hp)
  list.sort((a, b) => STATUS_REIHENFOLGE[a.status] - STATUS_REIHENFOLGE[b.status] || String(b.start ?? '').localeCompare(String(a.start ?? '')))
  return { items: list, warnings, usage: usageInfo() }
}

// ── study_get ────────────────────────────────────────────────────────────────

interface ZelleRoh { id: string; name: string; anteil: number | null; ebene: SteuerungEbene | null; objekte: TestObjekt[] }

function objekteAusKante(v: unknown): TestObjekt[] {
  return arr<Raw>(obj(v).data).map(o => ({ id: str(o.id), name: str(o.name) || null, status: str(o.effective_status) || null })).filter(o => o.id)
}

function zelleRoh(r: Raw): ZelleRoh {
  const ads = arr<unknown>(r.ad_ids).map(str).filter(Boolean)
  const adsets = objekteAusKante(r.adsets)
  const campaigns = objekteAusKante(r.campaigns)
  let ebene: SteuerungEbene | null = null
  let objekte: TestObjekt[] = []
  if (ads.length) { ebene = 'ad'; objekte = ads.map(id => ({ id, name: null, status: null })) } else if (adsets.length) { ebene = 'adset'; objekte = adsets } else if (campaigns.length) { ebene = 'campaign'; objekte = campaigns }
  return { id: str(r.id), name: str(r.name) || 'Zelle', anteil: num(r.treatment_percentage), ebene, objekte }
}

async function zellenLesen(id: string, warnings: string[]): Promise<ZelleRoh[]> {
  try {
    const list = await graphAll<Raw>(`${id}/cells`, { fields: CELL_FIELDS_ERWEITERT, limit: 50 }, { maxPages: 2 })
    return list.map(zelleRoh)
  } catch (e) {
    // nur bei abgelehnten Feldern (100 / validation) auf einzelne Kanten ausweichen
    const feldFehler = e instanceof MetaApiError && (e.kind === 'validation' || e.code === 100)
    if (!feldFehler) throw e
    warnings.push('Zellen nur einzeln lesbar (Meta lehnt die Feld-Erweiterung ab).')
  }
  const basis = await graphAll<Raw>(`${id}/cells`, { fields: CELL_FIELDS_EINFACH, limit: 50 }, { maxPages: 2 })
  const out: ZelleRoh[] = []
  for (const r of basis.slice(0, TEST_GRENZEN.max_zellen * 2)) {
    const z = zelleRoh(r)
    if (!z.ebene && !auslastungHoch()) {
      for (const [kante, ebene] of [['adsets', 'adset'], ['campaigns', 'campaign']] as Array<[string, SteuerungEbene]>) {
        try {
          const objs = await graphAll<Raw>(`${z.id}/${kante}`, { fields: 'id,name,effective_status', limit: 50 }, { maxPages: 1 })
          if (objs.length) {
            z.ebene = ebene
            z.objekte = objs.map(o => ({ id: str(o.id), name: str(o.name) || null, status: str(o.effective_status) || null }))
            break
          }
        } catch (e2) {
          warnings.push(`Zelle ${z.name}: ${kante} nicht lesbar (${softMsg(e2)}).`)
        }
      }
    }
    out.push(z)
  }
  return out
}

interface Zahlen { spend: number; impressions: number; reach: number; linkKlicks: number; leads: number; termine: number; objekte: number }

const LEAD_GESAMT = 'lead'
const LEAD_TEILE = ['onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']
/** erster vorhandener Wert zählt (nicht summieren: schedule_total enthält die anderen) */
const TERMIN_REIHE = ['schedule_total', 'offsite_conversion.fb_pixel_schedule', 'schedule_website', 'onsite_web_schedule']

export function aktionenAuswerten(actions: unknown): { leads: number; termine: number } {
  const m = new Map<string, number>()
  for (const a of arr<Raw>(actions)) {
    const t = str(a.action_type)
    const v = num(a.value) ?? 0
    if (t) m.set(t, (m.get(t) ?? 0) + v)
  }
  const leads = m.has(LEAD_GESAMT) ? (m.get(LEAD_GESAMT) ?? 0) : LEAD_TEILE.reduce((s, t) => s + (m.get(t) ?? 0), 0)
  let termine = 0
  for (const t of TERMIN_REIHE) {
    if (m.has(t)) { termine = m.get(t) ?? 0; break }
  }
  return { leads, termine }
}

async function insightsJeObjekt(ctx: Ctx, ebene: SteuerungEbene, ids: string[], since: string, until: string): Promise<Map<string, Zahlen>> {
  const m = new Map<string, Zahlen>()
  if (!ids.length) return m
  const rows = await graphAll<Raw>(`act_${ctx.env.account}/insights`, {
    level: ebene,
    filtering: [{ field: `${ebene}.id`, operator: 'IN', value: ids }],
    time_range: { since, until },
    fields: `${ebene}_id,spend,impressions,reach,inline_link_clicks,actions`,
    limit: 500,
  }, { maxPages: 3 })
  for (const r of rows) {
    const id = str(r[`${ebene}_id`])
    if (!id) continue
    const a = aktionenAuswerten(r.actions)
    const vorher = m.get(id) ?? { spend: 0, impressions: 0, reach: 0, linkKlicks: 0, leads: 0, termine: 0, objekte: 1 }
    m.set(id, {
      spend: vorher.spend + (num(r.spend) ?? 0),
      impressions: vorher.impressions + (num(r.impressions) ?? 0),
      reach: vorher.reach + (num(r.reach) ?? 0),
      linkKlicks: vorher.linkKlicks + (num(r.inline_link_clicks) ?? 0),
      leads: vorher.leads + a.leads,
      termine: vorher.termine + a.termine,
      objekte: 1,
    })
  }
  return m
}

const rund2 = (n: number) => Math.round(n * 100) / 100
const quot = (a: number, b: number): number | null => (b > 0 ? rund2(a / b) : null)

export function zellenWerte(z: Zahlen, geld: SteuerungGeld): TestZellenWerte {
  const eur = kontoZuEur(z.spend, geld)
  return {
    ausgaben: rund2(z.spend),
    ausgaben_eur: rund2(eur),
    impressionen: z.impressions,
    reichweite: z.objekte === 1 ? z.reach : null,
    link_klicks: z.linkKlicks,
    leads: z.leads,
    termine: z.termine,
    kosten_pro_lead_eur: quot(eur, z.leads),
    kosten_pro_termin_eur: quot(eur, z.termine),
    kosten_pro_link_klick_eur: quot(eur, z.linkKlicks),
    ctr: z.impressions > 0 ? rund2(z.linkKlicks / z.impressions * 100) : null,
    cpm_eur: z.impressions > 0 ? rund2(eur / z.impressions * 1000) : null,
  }
}

export function kennzahlWert(w: TestZellenWerte, k: TestKennzahl): number | null {
  switch (k) {
    case 'kosten_pro_lead': return w.kosten_pro_lead_eur
    case 'kosten_pro_termin': return w.kosten_pro_termin_eur
    case 'kosten_pro_link_klick': return w.kosten_pro_link_klick_eur
    case 'ctr': return w.ctr
    case 'cpm': return w.cpm_eur
  }
}

/** Ereignisse und Bezugsgröße je Kennzahl: höhere Rate (Ereignisse je Bezug) ist immer besser. */
export function rateBasis(w: TestZellenWerte, k: TestKennzahl): { ereignisse: number; bezug: number } {
  switch (k) {
    case 'kosten_pro_lead': return { ereignisse: w.leads, bezug: w.ausgaben_eur }
    case 'kosten_pro_termin': return { ereignisse: w.termine, bezug: w.ausgaben_eur }
    case 'kosten_pro_link_klick': return { ereignisse: w.link_klicks, bezug: w.ausgaben_eur }
    case 'ctr': return { ereignisse: w.link_klicks, bezug: w.impressionen }
    // vorsichtig: je 1.000 Impressionen ein Ereignis
    case 'cpm': return { ereignisse: w.impressionen / 1000, bezug: w.ausgaben_eur }
  }
}

function seedAus(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** HP-Schätzung: Wahrscheinlichkeit je Zelle, bei der Kennzahl die beste zu sein (Gamma-Poisson, Thompson). */
export function pBeste(zellen: Array<{ id: string; werte: TestZellenWerte }>, k: TestKennzahl, seed: string): Map<string, number> {
  const m = new Map<string, number>()
  // Zellen ohne Bezug (keine Ausgaben bzw. keine Impressionen) bekommen keinen Anteil: sonst
  // stammte ihre Schätzung nur aus dem Schnitt der anderen und könnte vorn liegen
  const basis = zellen.map(z => ({ id: z.id, ...rateBasis(z.werte, k) })).filter(b => b.bezug > 0)
  const ereignisse = basis.reduce((s, b) => s + b.ereignisse, 0)
  const bezug = basis.reduce((s, b) => s + b.bezug, 0)
  if (basis.length < 2 || !(ereignisse > 0) || !(bezug > 0)) return m
  const arms: ThompsonArm[] = basis.map(b => ({ schluessel: b.id, te: b.ereignisse, spend_eur: b.bezug, getestet: 1 }))
  // Prior = gemeinsamer Schnitt aller Zellen (neutral), schwach gewichtet
  const res = thompsonAnteile(arms, { draws: 4000, exploit: 1, min_getestet: 0, prior_cpte: bezug / ereignisse, a0: 1, seed: seedAus(seed) })
  for (const r of res) m.set(r.schluessel, Math.round(r.p_best * 1000) / 1000)
  return m
}

const prozent = (p: number) => `${Math.round(p * 100)} %`

export function gewinnerBestimmen(
  zellen: TestZelle[], k: TestKennzahl, status: TestStatus, meta: { zelleId: string; sicherheit: number } | null,
): TestGewinner {
  const label = TEST_KENNZAHL_LABEL[k]
  const basis: TestGewinner = { zelle_id: null, zelle_name: null, kennzahl: k, quelle: null, sicherheit: null, einstufung: 'zu_wenig_daten', text: '' }
  if (meta) {
    const z = zellen.find(c => c.id === meta.zelleId)
    if (z) {
      const einstufung: GewinnerEinstufung = meta.sicherheit >= TEST_GRENZEN.sicherheit_klar ? 'klar' : meta.sicherheit >= TEST_GRENZEN.sicherheit_tendenz ? 'tendenz' : 'offen'
      return {
        ...basis, zelle_id: z.id, zelle_name: z.name, quelle: 'meta', sicherheit: meta.sicherheit, einstufung,
        text: `Laut Meta liegt „${z.name}“ vorn (Sicherheit ${prozent(meta.sicherheit)}).`,
      }
    }
  }
  if (status === 'geplant') return { ...basis, text: 'Der Test hat noch nicht begonnen.' }
  const mitP = zellen.filter(z => z.p_beste !== null)
  if (!mitP.length) return { ...basis, text: `Noch keine Daten für ${label}.` }
  const best = mitP.reduce((a, b) => ((b.p_beste ?? 0) > (a.p_beste ?? 0) ? b : a))
  const p = best.p_beste ?? 0
  const ereignisse = rateBasis(best.werte, k).ereignisse
  if (ereignisse < TEST_GRENZEN.min_ereignisse_fuer_gewinner) {
    return {
      ...basis, zelle_id: best.id, zelle_name: best.name, quelle: 'hp_schaetzung', sicherheit: p,
      text: `Noch zu wenig Daten: die führende Variante hat weniger als ${TEST_GRENZEN.min_ereignisse_fuer_gewinner} Ereignisse für ${label}.`,
    }
  }
  const einstufung: GewinnerEinstufung = p >= TEST_GRENZEN.sicherheit_klar ? 'klar' : p >= TEST_GRENZEN.sicherheit_tendenz ? 'tendenz' : 'offen'
  const richtung = TEST_KENNZAHL_NIEDRIGER_BESSER[k] ? 'die niedrigsten' : 'die höchste'
  const text = einstufung === 'offen'
    ? `Noch kein klarer Gewinner (höchste Wahrscheinlichkeit ${prozent(p)} für „${best.name}“). Test weiterlaufen lassen.`
    : `„${best.name}“ hat mit ${prozent(p)} Wahrscheinlichkeit ${richtung} ${label} (HP-Schätzung${einstufung === 'tendenz' ? ', nur Tendenz' : ''}).`
  return { ...basis, zelle_id: best.id, zelle_name: best.name, quelle: 'hp_schaetzung', sicherheit: p, einstufung, text }
}

/** Sucht in Metas Ergebnis-Strings nach Konfidenz + Zelle (Format undokumentiert, tolerant). */
export function metaKonfidenz(ergebnisse: MetaTestErgebnis[], zellenIds: string[]): { zelleId: string; sicherheit: number } | null {
  let fund: { zelleId: string; sicherheit: number } | null = null
  const besuchen = (v: unknown, tiefe: number) => {
    if (fund || tiefe > 6 || !v || typeof v !== 'object') return
    const o = v as Raw
    let konf: number | null = null
    let zelle: string | null = null
    for (const [k, val] of Object.entries(o)) {
      if (/confidence/i.test(k)) { const n = num(val); if (n !== null) konf = n > 1 ? n / 100 : n }
      if (/^(winner|winning)?_?cell(_id)?$|winner/i.test(k)) { const s = str(val) || str(obj(val).id); if (zellenIds.indexOf(s) >= 0) zelle = s }
    }
    if (konf !== null && zelle && konf >= 0 && konf <= 1) { fund = { zelleId: zelle, sicherheit: konf }; return }
    for (const val of Object.values(o)) besuchen(val, tiefe + 1)
  }
  for (const e of ergebnisse) for (const r of e.ergebnisse) besuchen(r, 0)
  return fund
}

async function zieleLesen(id: string, warnings: string[]): Promise<MetaTestErgebnis[]> {
  if (auslastungHoch()) return []
  try {
    const list = await graphAll<Raw>(`${id}/objectives`, { fields: 'id,name,type,is_primary,results,last_updated_results', limit: 25 }, { maxPages: 1 })
    return list.map(o => ({
      ziel_id: str(o.id),
      name: str(o.name) || null,
      typ: str(o.type) || null,
      primaer: o.is_primary === true,
      ergebnisse: arr<unknown>(o.results).map(x => {
        if (typeof x !== 'string') return x
        try { return JSON.parse(x) } catch { return x.slice(0, 2000) }
      }),
      aktualisiert: str(o.last_updated_results) || null,
    }))
  } catch (e) {
    warnings.push(`Metas Auswertung nicht lesbar: ${softMsg(e)}`)
    return []
  }
}

export async function modeStudyGet(ctx: Ctx, req: StudyGetRequest): Promise<StudyGetResponse> {
  const id = metaId(req.id, 'Test-ID')
  const warnings: string[] = []
  let roh: Raw
  try {
    roh = await graphGet<Raw>(id, { fields: STUDY_FIELDS })
  } catch (e) {
    throw nichtGefunden(e, 'Test') ?? e
  }
  const jetzt = Date.now()
  const test = testNormalisieren(roh, str(obj(roh.business).id) === ctx.businessId ? 'business' : 'konto', jetzt)
  let kennzahl: TestKennzahl = test.kennzahl ?? TEST_KENNZAHL_EMPFOHLEN
  if (req.kennzahl !== undefined) {
    if ((TEST_KENNZAHLEN as readonly string[]).indexOf(String(req.kennzahl)) < 0) throw new SteuerungError(400, 'invalid_request', 'Unbekannte Kennzahl.')
    kennzahl = req.kennzahl
  }
  const geld = await ctx.geld()
  const roheZellen = await zellenLesen(id, warnings)

  // Namen für Anzeigen-Zellen (ad_ids ohne Namen): erst Spiegel, dann ein Meta-Aufruf
  const ohneName = roheZellen.flatMap(z => z.objekte.filter(o => !o.name).map(o => o.id))
  if (ohneName.length) {
    const spiegel = await spiegelNamen(ctx.sb, ohneName)
    for (const z of roheZellen) for (const o of z.objekte) if (!o.name) o.name = spiegel.get(o.id)?.name ?? null
    const rest = roheZellen.filter(z => z.ebene === 'ad').flatMap(z => z.objekte.filter(o => !o.name).map(o => o.id))
    if (rest.length && !auslastungHoch()) {
      try {
        const ko = await kontoObjekte(ctx, 'ad', uniq(rest).slice(0, 100))
        for (const z of roheZellen) for (const o of z.objekte) {
          const k = ko.get(o.id)
          if (k) { o.name = o.name ?? k.name; o.status = o.status ?? k.status }
        }
      } catch (e) {
        warnings.push(`Anzeigennamen nicht lesbar: ${softMsg(e)}`)
      }
    }
  }

  // Auswertungszeitraum: Start bis min(Ende, heute), Kalendertage in der Zeitzone des Werbekontos
  // (Meta liefert Tageswerte; der Starttag zählt ganz)
  const startMs = Date.parse(test.start ?? '')
  const endeMs = Date.parse(test.ende ?? '')
  let zeitraum: { since: string; until: string } | null = null
  if (Number.isFinite(startMs) && startMs <= jetzt) {
    const bis = Number.isFinite(endeMs) ? Math.min(endeMs, jetzt) : jetzt
    const tz = await ctx.zeitzone()
    zeitraum = { since: kontoDatum(startMs, tz), until: kontoDatum(Math.max(bis, startMs), tz) }
  }

  // Insights: ein Aufruf je Ebene für alle Objekte aller Zellen
  const zahlen = new Map<string, Zahlen>()
  if (zeitraum) {
    const ebenen = uniq(roheZellen.map(z => z.ebene).filter((e): e is SteuerungEbene => e !== null))
    for (const ebene of ebenen) {
      const ids = uniq(roheZellen.filter(z => z.ebene === ebene).flatMap(z => z.objekte.map(o => o.id))).slice(0, 200)
      try {
        const m = await insightsJeObjekt(ctx, ebene, ids, zeitraum.since, zeitraum.until)
        for (const [k, v] of m) zahlen.set(k, v)
      } catch (e) {
        warnings.push(`Zahlen der Testobjekte nicht lesbar: ${softMsg(e)}`)
      }
    }
  }

  const leer: Zahlen = { spend: 0, impressions: 0, reach: 0, linkKlicks: 0, leads: 0, termine: 0, objekte: 0 }
  const zellen: TestZelle[] = roheZellen.map(z => {
    const summe = z.objekte.reduce<Zahlen>((s, o) => {
      const v = zahlen.get(o.id)
      if (!v) return s
      return {
        spend: s.spend + v.spend, impressions: s.impressions + v.impressions, reach: s.reach + v.reach,
        linkKlicks: s.linkKlicks + v.linkKlicks, leads: s.leads + v.leads, termine: s.termine + v.termine, objekte: s.objekte,
      }
    }, { ...leer, objekte: z.objekte.length })
    const werte = zellenWerte(summe, geld)
    return { id: z.id, name: z.name, anteil: z.anteil, ebene: z.ebene, objekte: z.objekte, werte, kennzahl_wert: kennzahlWert(werte, kennzahl), p_beste: null, ist_gewinner: false }
  })
  const p = pBeste(zellen, kennzahl, id)
  for (const z of zellen) z.p_beste = p.has(z.id) ? (p.get(z.id) ?? null) : null

  const meta_ergebnisse = await zieleLesen(id, warnings)
  const gewinner = gewinnerBestimmen(zellen, kennzahl, test.status, metaKonfidenz(meta_ergebnisse, zellen.map(z => z.id)))
  if (gewinner.zelle_id && (gewinner.einstufung === 'klar')) {
    for (const z of zellen) z.ist_gewinner = z.id === gewinner.zelle_id
  }
  if (!roheZellen.length) warnings.push('Meta liefert für diesen Test keine Zellen.')
  return { test, kennzahl, zeitraum, zellen, gewinner, meta_ergebnisse, geld, warnings, usage: usageInfo() }
}

// ── study_create ─────────────────────────────────────────────────────────────

type ZellArt = 'campaign_ids' | 'adset_ids' | 'ad_ids'
const ART_EBENE: Record<ZellArt, SteuerungEbene> = { campaign_ids: 'campaign', adset_ids: 'adset', ad_ids: 'ad' }
const ART_META: Record<ZellArt, string> = { campaign_ids: 'campaigns', adset_ids: 'adsets', ad_ids: 'ads' }

/** Erlaubte Objektarten je Testvariable */
const TYP_ARTEN: Record<TestTyp, ZellArt[]> = {
  anzeigengestaltung: ['ad_ids', 'adset_ids'],
  zielgruppe: ['adset_ids'],
  platzierung: ['adset_ids'],
  frei: ['adset_ids', 'campaign_ids'],
}

/** Anteile: fehlende gleichmäßig auf den Rest verteilen (ganze Prozent). */
export function anteileVerteilen(eingabe: Array<number | undefined>, mussHundert: boolean): number[] {
  const n = eingabe.length
  const gegeben = eingabe.map(a => (a === undefined || a === null ? null : Number(a)))
  for (const a of gegeben) {
    if (a !== null && (!Number.isInteger(a) || a < TEST_GRENZEN.min_anteil || a > 100)) {
      throw new SteuerungError(400, 'invalid_request', `Anteil je Variante: ganze Zahl von ${TEST_GRENZEN.min_anteil} bis 100 Prozent.`)
    }
  }
  const summeGegeben = gegeben.reduce<number>((s, a) => s + (a ?? 0), 0)
  const offen = gegeben.filter(a => a === null).length
  const rest = 100 - summeGegeben
  const out = gegeben.map(a => a ?? 0)
  if (offen) {
    const je = Math.floor(rest / offen)
    let ueber = rest - je * offen
    for (let i = 0; i < n; i++) {
      if (gegeben[i] !== null) continue
      out[i] = je + (ueber > 0 ? 1 : 0)
      if (ueber > 0) ueber--
    }
    if (je < TEST_GRENZEN.min_anteil) {
      throw new SteuerungError(400, 'invalid_request', `Für die übrigen Varianten bleiben nur ${Math.max(0, rest)} Prozent; jede braucht mindestens ${TEST_GRENZEN.min_anteil}.`)
    }
  }
  const summe = out.reduce((s, a) => s + a, 0)
  if (summe > 100) throw new SteuerungError(400, 'invalid_request', `Die Anteile ergeben ${summe} Prozent, erlaubt sind höchstens 100.`)
  if (mussHundert && summe !== 100) throw new SteuerungError(400, 'invalid_request', `Beim Anzeigen-Test müssen die Anteile zusammen 100 Prozent ergeben (jetzt ${summe}).`)
  return out
}

function zeitpunkt(v: unknown, label: string): number {
  const s = str(v).trim()
  const t = Date.parse(s)
  if (!s || !Number.isFinite(t)) throw new SteuerungError(400, 'invalid_request', `${label} fehlt oder ist kein gültiger Zeitpunkt (ISO).`)
  return t
}

const sek = (ms: number) => Math.floor(ms / 1000)

export async function modeStudyCreate(ctx: Ctx, req: StudyCreateRequest): Promise<StudyCreateResponse> {
  const hinweise: string[] = []
  const typ = String(req.typ ?? '') as TestTyp
  if ((TEST_TYPEN as readonly string[]).indexOf(typ) < 0) throw new SteuerungError(400, 'invalid_request', `Testvariable fehlt (${TEST_TYPEN.join(', ')}).`)
  const kennzahl = String(req.kennzahl ?? '') as TestKennzahl
  if ((TEST_KENNZAHLEN as readonly string[]).indexOf(kennzahl) < 0) throw new SteuerungError(400, 'invalid_request', `Gewinner-Kennzahl fehlt (${TEST_KENNZAHLEN.join(', ')}).`)
  const name = cleanText(req.name, 200)
  if (!name) throw new SteuerungError(400, 'invalid_request', 'Testname fehlt.')
  const text = cleanText(req.beschreibung, 400)

  // Zeiten
  const jetzt = Date.now()
  const startMs = req.start === undefined || req.start === null || str(req.start).trim() === '' ? jetzt + 15 * 60_000 : zeitpunkt(req.start, 'Start')
  if (startMs < jetzt - 60_000) throw new SteuerungError(400, 'invalid_request', 'Der Start liegt in der Vergangenheit.')
  const endeMs = zeitpunkt(req.ende, 'Ende')
  const tage = (endeMs - startMs) / 86_400_000
  if (tage < TEST_GRENZEN.min_tage - 1 / 1440 || tage > TEST_GRENZEN.max_tage + 1 / 1440) {
    throw new SteuerungError(400, 'invalid_request', `Laufzeit: ${TEST_GRENZEN.min_tage} bis ${TEST_GRENZEN.max_tage} Tage (jetzt ${zahlText(Math.round(tage * 10) / 10)}).`)
  }
  if (tage < TEST_GRENZEN.empfohlen_tage) hinweise.push(`Meta empfiehlt mindestens ${TEST_GRENZEN.empfohlen_tage} Tage, sonst ist das Ergebnis oft nicht belastbar.`)

  // Zellen
  const zellenEin = Array.isArray(req.zellen) ? req.zellen : []
  if (zellenEin.length < TEST_GRENZEN.min_zellen || zellenEin.length > TEST_GRENZEN.max_zellen) {
    throw new SteuerungError(400, 'invalid_request', `Ein Test braucht ${TEST_GRENZEN.min_zellen} bis ${TEST_GRENZEN.max_zellen} Varianten.`)
  }
  let art: ZellArt | null = null
  const zellen: Array<{ name: string; ids: string[]; anteil?: number }> = []
  const alleIds: string[] = []
  for (const [i, z0] of zellenEin.entries()) {
    const z = obj(z0)
    const zname = cleanText(z.name, 100) || `Variante ${String.fromCharCode(65 + i)}`
    const arten = (['campaign_ids', 'adset_ids', 'ad_ids'] as ZellArt[]).filter(a => Array.isArray(z[a]) && arr(z[a]).length > 0)
    if (arten.length !== 1) throw new SteuerungError(400, 'invalid_request', `Variante „${zname}“: genau eine Objektart angeben (Kampagnen, Anzeigengruppen oder Werbeanzeigen).`)
    const a = arten[0]
    if (art && art !== a) throw new SteuerungError(400, 'invalid_request', 'Alle Varianten müssen dieselbe Objektart haben.')
    art = a
    const ids = metaIds(z[a], `Variante „${zname}“`, TEST_GRENZEN.max_objekte_je_zelle)
    for (const id of ids) {
      if (alleIds.indexOf(id) >= 0) throw new SteuerungError(400, 'invalid_request', `Objekt ${id} steckt in mehr als einer Variante.`)
      alleIds.push(id)
    }
    const anteil = z.anteil === undefined || z.anteil === null ? undefined : (num(z.anteil) ?? NaN)
    zellen.push({ name: zname, ids, anteil })
  }
  if (!art) throw new SteuerungError(400, 'invalid_request', 'Keine Testobjekte angegeben.')
  if (TYP_ARTEN[typ].indexOf(art) < 0) {
    const erlaubt = TYP_ARTEN[typ].map(a => ({ campaign_ids: 'Kampagnen', adset_ids: 'Anzeigengruppen', ad_ids: 'Werbeanzeigen' }[a])).join(' oder ')
    throw new SteuerungError(400, 'invalid_request', `Ein Test „${TEST_TYP_LABEL[typ]}“ vergleicht ${erlaubt}.`)
  }
  const creativeTest = art === 'ad_ids'
  if (creativeTest && zellen.some(z => z.ids.length !== 1)) {
    throw new SteuerungError(400, 'invalid_request', 'Beim Anzeigen-Test enthält jede Variante genau eine Werbeanzeige.')
  }
  const anteile = anteileVerteilen(zellen.map(z => z.anteil), creativeTest)
  const ebene = ART_EBENE[art]

  // Objekte gehören zum Konto? (ein Aufruf)
  const objekte = await pruefeKontoObjekte(ctx, ebene, alleIds, 'Testobjekte')
  const inaktiv = alleIds.filter(id => objekte.get(id)?.status !== 'ACTIVE')
  if (inaktiv.length) {
    hinweise.push(`${inaktiv.length} Testobjekt(e) sind nicht aktiv. Der Test liefert erst aus, wenn du sie im Werbemanager aktivierst (mit Leitplanken-Prüfung).`)
  }
  if (creativeTest && uniq(alleIds.map(id => objekte.get(id)?.adset_id ?? '')).length > 1) {
    hinweise.push('Die Werbeanzeigen liegen in verschiedenen Anzeigengruppen. Für einen sauberen Anzeigen-Test besser alle in dieselbe Anzeigengruppe legen.')
  }
  if ((typ === 'zielgruppe' || typ === 'platzierung') && uniq(alleIds.map(id => objekte.get(id)?.optimization_goal ?? '')).length > 1) {
    hinweise.push('Die Anzeigengruppen haben verschiedene Leistungsziele. Dann unterscheidet sich mehr als eine Sache und das Ergebnis ist schwer zu deuten.')
  }
  // Sonderkategorie Wohnen der beteiligten Kampagnen (nur Hinweis, der Test ändert sie nicht)
  const kampagnenIds = uniq(alleIds.map(id => objekte.get(id)?.campaign_id ?? '').filter(Boolean)).slice(0, 50)
  if (kampagnenIds.length && !auslastungHoch()) {
    try {
      const kamp = ebene === 'campaign' ? objekte : await kontoObjekte(ctx, 'campaign', kampagnenIds)
      const ohne = kampagnenIds.filter(id => kamp.has(id) && (kamp.get(id)?.special_ad_categories ?? []).indexOf('HOUSING') < 0)
      if (ohne.length) {
        hinweise.push(`${ohne.length} beteiligte Kampagne(n) ohne Sonderkategorie Wohnen. Immobilien-Anzeigen brauchen sie; bitte vor dem Start prüfen.`)
      }
    } catch (e) {
      hinweise.push(`Sonderkategorie der Kampagnen nicht geprüft (${softMsg(e)}).`)
    }
  }
  if (typ === 'zielgruppe') hinweise.push('Unter Wohnen dürfen sich die Zielgruppen nur bei Orten und eigenen Zielgruppen unterscheiden, nie bei Alter oder Geschlecht.')
  hinweise.push('Während des Tests die Testobjekte nicht von Hand oder per Autopilot ändern, sonst wird das Ergebnis verfälscht.')

  // Doppelklick-Schutz: laufender oder geplanter Test gleichen Namens (Werbekonto und Business,
  // neue Tests entstehen am Business)
  for (const [quelle, pfad] of [['Werbekonto', `act_${ctx.env.account}/ad_studies`], ['Business', `${ctx.businessId}/ad_studies`]]) {
    try {
      const vorhanden = await graphAll<Raw>(pfad, { fields: 'id,name,start_time,end_time,canceled_time', limit: 50 }, { maxPages: 2 })
      const gleich = vorhanden.find(r => str(r.name).trim().toLowerCase() === name.toLowerCase() && testStatus(r, jetzt) !== 'beendet' && testStatus(r, jetzt) !== 'abgebrochen')
      if (gleich) {
        throw new SteuerungError(409, 'conflict', `Es gibt schon einen laufenden oder geplanten Test „${name}“.`, 'Anderen Namen wählen oder den vorhandenen Test öffnen.', { id: str(gleich.id) })
      }
    } catch (e) {
      if (e instanceof SteuerungError) throw e
      hinweise.push(`Vorhandene Tests (${quelle}) nicht geprüft (${softMsg(e)}).`)
    }
  }

  const startS = sek(startMs)
  const endeS = sek(endeMs)
  const payload: Raw = {
    name,
    description: kennungBauen(typ, kennzahl, text),
    type: creativeTest ? 'SPLIT_TEST_V2' : 'SPLIT_TEST',
    start_time: startS,
    end_time: endeS,
    cells: zellen.map((z, i) => ({ name: z.name, treatment_percentage: anteile[i], [ART_META[art as ZellArt]]: z.ids })),
  }
  if (creativeTest) {
    // UNGEPRÜFT: creative_test_config laut Leitfaden „Creative testing“ (Business-Edge, 2 bis 5 Zellen, je 1 Anzeige)
    const tb = obj(req.testbudget)
    const tagesEur = tb.tagesbudget_eur === undefined || tb.tagesbudget_eur === null ? null : num(tb.tagesbudget_eur)
    const anteilP = tb.anteil_prozent === undefined || tb.anteil_prozent === null ? null : num(tb.anteil_prozent)
    if (tagesEur !== null && anteilP !== null) throw new SteuerungError(400, 'invalid_request', 'Testbudget: entweder Tagesbudget oder Anteil angeben, nicht beides.')
    if (tagesEur !== null) {
      const st = await ctx.settings()
      if (!(tagesEur > 0) || tagesEur > st.max_account_daily_budget) {
        throw new SteuerungError(422, 'guardrail', `Tagesbudget für den Test: mehr als 0 und höchstens ${eurText(st.max_account_daily_budget)} (Leitplanke).`)
      }
      const geld = await ctx.geld()
      if (geld.waehrung !== 'USD') {
        throw new SteuerungError(409, 'unsupported', 'Die Leitplanken-Prüfung kennt nur USD-Werbekonten.', 'Statt eines Tagesbudgets einen Anteil wählen.')
      }
      const tagesCent = eurZuKontoCent(tagesEur, geld)
      // UNGEPRÜFT, ob Meta das Testbudget aus dem vorhandenen Budget nimmt: im schlimmsten Fall zusätzlich
      let h
      try {
        h = await budgetHeadroom(ctx.sb, { addDailyUsdCents: tagesCent })
      } catch (e) {
        throw new SteuerungError(503, 'guardrail', 'Die Leitplanke ließ sich nicht prüfen, deshalb wird nichts angelegt.', softMsg(e))
      }
      if (!h.ok) {
        throw new SteuerungError(422, 'guardrail',
          `Leitplanke: mit dem Testbudget im schlimmsten Fall ${eurText(h.afterEur)} pro Tag, erlaubt sind ${eurText(h.limitEur)}.`,
          'Kleineres Tagesbudget oder einen Anteil am vorhandenen Budget wählen.',
          { aktiv_eur: h.activeEur, danach_eur: h.afterEur, limit_eur: h.limitEur })
      }
      payload.creative_test_config = { daily_budget: tagesCent }
      hinweise.push(`Testbudget ${eurText(tagesEur)} pro Tag. Ob Meta es aus dem vorhandenen Budget nimmt, ist ungeprüft; die Leitplanke zählt es als zusätzliche Ausgabe (im schlimmsten Fall ${eurText(h.afterEur)} von ${eurText(h.limitEur)} pro Tag).`)
    } else {
      const p = anteilP ?? 20
      if (!Number.isInteger(p) || p < 1 || p > 100) throw new SteuerungError(400, 'invalid_request', 'Testbudget-Anteil: ganze Zahl von 1 bis 100 Prozent.')
      payload.creative_test_config = { lifetime_budget_percentage: p }
      if (anteilP === null) hinweise.push('Kein Testbudget angegeben: Standard 20 Prozent des vorhandenen Budgets fließen in den Test.')
    }
    payload.cooldown_start_time = startS
    payload.observation_end_time = endeS
  }

  const antwortZellen = zellen.map((z, i) => ({
    name: z.name, anteil: anteile[i], ebene,
    objekte: z.ids.map(id => ({ id, name: objekte.get(id)?.name ?? null, status: objekte.get(id)?.status ?? null })),
  }))
  const basis = {
    meta_typ: payload.type as 'SPLIT_TEST' | 'SPLIT_TEST_V2',
    start: new Date(startS * 1000).toISOString(),
    ende: new Date(endeS * 1000).toISOString(),
    tage: Math.round(tage * 10) / 10,
    zellen: antwortZellen,
    payload, hinweise,
  }
  if (req.vorschau === true) return { ...basis, vorschau: true, id: null, usage: usageInfo() }

  const res = await metaPost(ctx, `${ctx.businessId}/ad_studies`, payload, { level: 'study' })
  const neueId = str(res.id)
  if (!neueId) throw new SteuerungError(502, 'meta_error', 'Meta hat den Test angenommen, aber keine ID geliefert.', 'In der Testliste nachsehen, bevor du es erneut versuchst.')
  return { ...basis, vorschau: false, id: neueId, usage: usageInfo() }
}

// ── study_beenden ────────────────────────────────────────────────────────────

/** true, wenn der Test Zellen hat und alle ihre Objekte zum Werbekonto gehören (Meta-Fehler werden weitergereicht). */
async function testObjekteImKonto(ctx: Ctx, id: string): Promise<boolean> {
  const zellen = await zellenLesen(id, [])
  const jeEbene = new Map<SteuerungEbene, string[]>()
  for (const z of zellen) {
    if (!z.ebene || !z.objekte.length) return false
    jeEbene.set(z.ebene, [...(jeEbene.get(z.ebene) ?? []), ...z.objekte.map(o => o.id)])
  }
  if (!jeEbene.size) return false
  for (const [ebene, ids0] of jeEbene) {
    const ids = uniq(ids0)
    const m = await kontoObjekte(ctx, ebene, ids)
    if (ids.some(i => !m.has(i))) return false
  }
  return true
}

export async function modeStudyBeenden(ctx: Ctx, req: StudyBeendenRequest): Promise<StudyBeendenResponse> {
  const id = metaId(req.id, 'Test-ID')
  let r: Raw
  try {
    r = await graphGet<Raw>(id, { fields: 'id,name,type,start_time,end_time,observation_end_time,canceled_time,business' })
  } catch (e) {
    throw nichtGefunden(e, 'Test') ?? e
  }
  const biz = str(obj(r.business).id)
  if (biz && biz !== ctx.businessId) {
    throw new SteuerungError(403, 'forbidden', 'Dieser Test gehört zu einem anderen Business und wird hier nicht geändert.')
  }
  // Ohne Business-Angabe: nur, wenn alle Testobjekte zu unserem Werbekonto gehören
  if (!biz && !(await testObjekteImKonto(ctx, id))) {
    throw new SteuerungError(403, 'forbidden', 'Dieser Test gehört nicht nachweisbar zu unserem Werbekonto und wird hier nicht geändert.')
  }
  const jetzt = Date.now()
  const status = testStatus(r, jetzt)
  if (status === 'beendet' || status === 'abgebrochen') throw new SteuerungError(409, 'conflict', 'Der Test ist schon beendet.')
  if (status === 'geplant') {
    throw new SteuerungError(409, 'conflict', 'Der Test hat noch nicht begonnen und lässt sich bei Meta erst nach dem Start beenden.',
      'Solange die Testobjekte pausiert sind, liefert der Test nichts aus. Gelöscht wird bei uns nie.')
  }
  const endeVorher = isoZeit(r.end_time)
  // UNGEPRÜFT: Doku erlaubt nur ein Ende in der Zukunft -> jetzt + 60 s
  const endeS = sek(jetzt) + 60
  const payload: Raw = { end_time: endeS }
  const obsVorher = isoZeit(r.observation_end_time)
  if (obsVorher && obsVorher === endeVorher) payload.observation_end_time = endeS
  const hinweise = [
    'Meta beendet den Test; die Testobjekte selbst bleiben bestehen. Gewinner übernehmen und Verlierer pausieren geht im Werbemanager.',
  ]
  const basis = { id, ende_vorher: endeVorher, ende_neu: new Date(endeS * 1000).toISOString(), payload, hinweise }
  if (req.vorschau === true) return { ...basis, vorschau: true, usage: usageInfo() }
  await metaPost(ctx, id, payload, { level: 'study', entityId: id, before: { end_time: endeVorher }, idempotent: true })
  return { ...basis, vorschau: false, usage: usageInfo() }
}
