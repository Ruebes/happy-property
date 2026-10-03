// meta-steuerung: Metas automatisierte Regeln (Ad Rules Engine).
//
// Meta-Pfade (Referenz ad-account/adrules_library, ad-rule, Leitfäden evaluation-spec,
// execution-spec, change-spec, scheduled-based-rules, advanced-scheduling, api-calls):
//   GET  act_{konto}/adrules_library?fields=...   Regeln des Werbekontos
//   POST act_{konto}/adrules_library             anlegen {name, evaluation_spec, execution_spec, schedule_spec, status}
//   POST {regel} { status }                      ein-/ausschalten („Updating a rule's status requires no spec changes“)
//   GET  {regel}/history                         Verlauf einer Regel (Filter object_id, action, hide_no_changes)
//   GET  act_{konto}/adrules_history             Verlauf aller Regeln
//   GET  act_{konto}/users?fields=id,name        Empfänger für Benachrichtigungen (UNGEPRÜFT, ob diese IDs als user_ids gelten)
// NIE: DELETE /{regel}. Ausschalten statt löschen (Svens Regel).
//
// Das CRM legt nur Zeitplan-Regeln (SCHEDULE) mit vier Aktionen an: PAUSE, UNPAUSE,
// CHANGE_BUDGET/CHANGE_CAMPAIGN_BUDGET, NOTIFICATION. Geld geht in Cent der
// Kontowährung an Meta („for USD, the base unit is the cent“). Regeln, die Ausgaben
// erhöhen können, nur Admin, nur feste IDs, mit Obergrenze und Leitplanken-Prüfung.
//
// UNGEPRÜFT (nur Doku; adrules_library kennt kein validate_only):
//   - Fehler 2703 „Rules that turn off ads can't have cost conditions“: welche Felder als
//     Kosten zählen, ist offen; das CRM warnt bei cost_per_*, cpc, cpm und Ausschalten.
//   - Ob NOTIFICATION ohne user_ids beim System-User landet (dann sieht es niemand).

import { budgetHeadroom, graphAll, graphGet, MetaApiError, type GraphParams } from '../_shared/metaGraph.ts'
import {
  adminNoetig, arr, auslastungHoch, cleanText, type Ctx, eigeneAnlagen, eurText, eurZuKontoCent, gruppenDerKampagnen, istAdmin,
  isoZeit, kontoCentZuEur, type KontoObjekt, kontoObjekte, metaId, metaIds, metaPost, num, obj, pruefeKontoObjekte, type Raw,
  type Settings, softMsg, spiegelNamen, SteuerungError, str, tagesCent, uniq, usageInfo, zahlText,
} from './common.ts'
import {
  REGEL_AKTION_LABEL, REGEL_AKTIONEN, REGEL_FELDER, REGEL_GESPERRTE_AKTIONEN, REGEL_GRENZEN, REGEL_OPERATOR_LABEL,
  REGEL_STATUS_LABEL, REGEL_VERLAUF_AKTION_LABEL, REGEL_ZEITPLAN_LABEL, REGEL_ZEITRAEUME, REGEL_ZEITRAUM_EMPFOHLEN, REGEL_ZEITRAUM_LABEL,
  STEUERUNG_EBENE_LABEL, STEUERUNG_HINWEIS_AUTOPILOT,
  type RegelAktion, type RegelBedingung, type RegelBudgetAenderung, type RegelFeldInfo, type RegelFilter,
  type RegelOperator, type RegelStatus, type RegelUebersicht, type RegelVerlaufEintrag, type RegelVorlage, type RegelZeitfenster,
  type RegelZeitplan, type RegelZeitraum, type RuleCreateRequest, type RuleCreateResponse, type RuleHistoryRequest,
  type RuleHistoryResponse, type RulesListRequest, type RulesListResponse, type RuleStatusRequest, type RuleStatusResponse,
  type SteuerungEbene, type SteuerungGeld, type VorlagenRequest, type VorlagenResponse,
} from './typen.ts'

const RULE_FIELDS = 'id,name,status,evaluation_spec,execution_spec,schedule_spec,created_time,updated_time,created_by,disable_error_code'

const EBENE_META: Record<SteuerungEbene, string> = { campaign: 'CAMPAIGN', adset: 'ADSET', ad: 'AD' }
const META_EBENE: Record<string, SteuerungEbene> = { CAMPAIGN: 'campaign', ADSET: 'adset', AD: 'ad' }
const EBENE_PLURAL: Record<SteuerungEbene, string> = { campaign: 'Kampagnen', adset: 'Anzeigengruppen', ad: 'Werbeanzeigen' }

const OP_META: Record<RegelOperator, string> = { groesser: 'GREATER_THAN', kleiner: 'LESS_THAN', zwischen: 'IN_RANGE', nicht_zwischen: 'NOT_IN_RANGE' }
const META_OP: Record<string, RegelOperator> = { GREATER_THAN: 'groesser', LESS_THAN: 'kleiner', IN_RANGE: 'zwischen', NOT_IN_RANGE: 'nicht_zwischen' }
const META_OP_TEXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(META_OP).map(([k, v]) => [k, REGEL_OPERATOR_LABEL[v]])),
  EQUAL: 'gleich', NOT_EQUAL: 'ungleich', IN: 'ist eins von', NOT_IN: 'ist keins von', CONTAIN: 'enthält', NOT_CONTAIN: 'enthält nicht',
  ANY: 'irgendeins von', ALL: 'alle von', NONE: 'keins von',
}

const FELD_INFO = new Map<string, RegelFeldInfo>(REGEL_FELDER.map(f => [f.feld, f]))

/** Metas execution_type -> gesperrte Option (REGEL_GESPERRTE_AKTIONEN) */
const META_GESPERRT: Record<string, string> = {
  CHANGE_BID: 'gebot_anpassen', INCREASE_RADIUS: 'umkreis_erweitern', ADD_INTEREST_RELAXATION: 'interessen_lockern',
  REBALANCE_BUDGET: 'budget_umverteilen', ROTATE: 'anzeigen_rotieren',
}

const ZEITPLAN_TEXT: Record<string, string> = {
  SEMI_HOURLY: 'Fortlaufend (etwa alle 30 Minuten)',
  HOURLY: 'Stündlich',
  DAILY: 'Täglich um Mitternacht (Zeitzone des Werbekontos)',
}
const TAGE_KURZ = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

const istZeitraum = (v: string): v is RegelZeitraum => (REGEL_ZEITRAEUME as readonly string[]).indexOf(v) >= 0

function minuteText(m: number): string {
  const h = Math.floor(m / 60)
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Wert eines Felds lesbar (Geld in EUR) */
function wertText(info: RegelFeldInfo | undefined, wert: number): string {
  if (!info) return zahlText(wert)
  switch (info.einheit) {
    case 'eur': return eurText(wert)
    case 'prozent': return `${zahlText(wert)} %`
    case 'stunden': return `${zahlText(wert)} Stunden`
    default: return zahlText(wert)
  }
}

// ── Regel bauen (rein, ohne Meta) ────────────────────────────────────────────

export interface RegelBau {
  payload: Raw
  ebene: SteuerungEbene
  aktion: RegelAktion
  ids: string[]
  kampagnenIds: string[]
  gruppenIds: string[]
  riskant: boolean
  /** Budget-Erhöhung: Obergrenze je Objekt in Cent der Kontowährung */
  grenzeCent: number | null
  /** Budget senken: Untergrenze in Cent der Kontowährung (sonst null) */
  untergrenzeCent: number | null
  hinweise: string[]
}

function zahlOderFehler(v: unknown, label: string): number {
  const n = num(v)
  if (n === null) throw new SteuerungError(400, 'invalid_request', `${label}: bitte eine Zahl.`)
  return n
}

/** Bedingungswert in Metas Einheit (Geld: Cent der Kontowährung) */
function metaWert(info: RegelFeldInfo, w: number, geld: SteuerungGeld): number {
  if (info.einheit === 'eur') return eurZuKontoCent(w, geld)
  if (info.einheit === 'stunden') return Math.round(w)
  return Math.round(w * 10000) / 10000
}

export function regelBauen(req: RuleCreateRequest, geld: SteuerungGeld, st: Settings): RegelBau {
  const hinweise: string[] = []
  const name = cleanText(req.name, 200)
  if (!name) throw new SteuerungError(400, 'invalid_request', 'Name der Regel fehlt.')
  const ebene = String(req.ebene ?? '') as SteuerungEbene
  if (!EBENE_META[ebene]) throw new SteuerungError(400, 'invalid_request', 'Ebene fehlt (campaign, adset oder ad).')

  const aktionRoh = String(req.aktion ?? '')
  const gesperrt = REGEL_GESPERRTE_AKTIONEN.find(g => g.key === aktionRoh)
  if (gesperrt) throw new SteuerungError(422, 'housing_forbidden', `„${gesperrt.label}“ ist hier gesperrt.`, gesperrt.grund)
  if ((REGEL_AKTIONEN as readonly string[]).indexOf(aktionRoh) < 0) throw new SteuerungError(400, 'invalid_request', `Aktion fehlt (${REGEL_AKTIONEN.join(', ')}).`)
  const aktion = aktionRoh as RegelAktion

  // Geltung
  const f = obj(req.filter) as RegelFilter
  let ids = metaIds(f.ids, 'Objekt-IDs', REGEL_GRENZEN.max_ids)
  let kampagnenIds = metaIds(f.kampagnen_ids, 'Kampagnen-IDs', REGEL_GRENZEN.max_ids)
  const gruppenIds = metaIds(f.anzeigengruppen_ids, 'Anzeigengruppen-IDs', REGEL_GRENZEN.max_ids)
  if (ebene === 'campaign' && kampagnenIds.length) { ids = uniq([...ids, ...kampagnenIds]); kampagnenIds = [] }
  if (gruppenIds.length && ebene !== 'ad') throw new SteuerungError(400, 'invalid_request', 'Einschränkung auf Anzeigengruppen geht nur bei der Ebene Werbeanzeige; sonst feste IDs nutzen.')
  const nameEnth = cleanText(f.name_enthaelt, 100)
  const kampNameEnth = cleanText(f.kampagnenname_enthaelt, 100)

  const filters: Raw[] = [{ field: 'entity_type', value: EBENE_META[ebene], operator: 'EQUAL' }]
  if (ids.length) filters.push({ field: 'id', value: ids, operator: 'IN' })
  if (kampagnenIds.length) filters.push({ field: 'campaign.id', value: kampagnenIds, operator: 'IN' })
  if (gruppenIds.length) filters.push({ field: 'adset.id', value: gruppenIds, operator: 'IN' })
  if (nameEnth) filters.push({ field: 'name', value: nameEnth, operator: 'CONTAIN' })
  if (kampNameEnth) filters.push({ field: 'campaign.name', value: kampNameEnth, operator: 'CONTAIN' })

  // Bedingungen
  const bed = Array.isArray(req.bedingungen) ? req.bedingungen : []
  if (!bed.length) throw new SteuerungError(400, 'invalid_request', 'Mindestens eine Bedingung angeben, sonst träfe die Regel jedes Objekt.')
  if (bed.length > REGEL_GRENZEN.max_bedingungen) throw new SteuerungError(400, 'invalid_request', `Höchstens ${REGEL_GRENZEN.max_bedingungen} Bedingungen.`)
  let insights = false
  let kostenBedingung = false
  const gesehen = new Set<string>()
  for (const b0 of bed) {
    const b = obj(b0)
    const info = FELD_INFO.get(str(b.feld))
    if (!info) throw new SteuerungError(400, 'invalid_request', `Unbekanntes Feld „${str(b.feld).slice(0, 40)}“.`)
    if (info.ebenen.indexOf(ebene) < 0) throw new SteuerungError(400, 'invalid_request', `„${info.label}“ gibt es nur für ${info.ebenen.map(e => STEUERUNG_EBENE_LABEL[e]).join(', ')}.`)
    const op = str(b.operator) as RegelOperator
    if (!OP_META[op]) throw new SteuerungError(400, 'invalid_request', `Unbekannter Vergleich „${str(b.operator).slice(0, 20)}“.`)
    const schluessel = `${info.feld}|${op}`
    if (gesehen.has(schluessel)) throw new SteuerungError(400, 'invalid_request', `„${info.label} ${REGEL_OPERATOR_LABEL[op]}“ steht doppelt.`)
    gesehen.add(schluessel)
    let wert: number | [number, number]
    if (op === 'zwischen' || op === 'nicht_zwischen') {
      const paar = Array.isArray(b.wert) ? b.wert : []
      if (paar.length !== 2) throw new SteuerungError(400, 'invalid_request', `„${info.label} ${REGEL_OPERATOR_LABEL[op]}“ braucht zwei Werte (von, bis).`)
      const von = zahlOderFehler(paar[0], info.label)
      const bis = zahlOderFehler(paar[1], info.label)
      if (von < 0 || bis <= von) throw new SteuerungError(400, 'invalid_request', `${info.label}: „bis“ muss größer als „von“ sein, beide ab 0.`)
      wert = [metaWert(info, von, geld), metaWert(info, bis, geld)]
    } else {
      const w = zahlOderFehler(b.wert, info.label)
      if (w < 0) throw new SteuerungError(400, 'invalid_request', `${info.label}: Wert ab 0.`)
      if (op === 'kleiner' && w === 0) throw new SteuerungError(400, 'invalid_request', `${info.label} kleiner als 0 trifft nie zu. Für „keine“ bitte „kleiner als 1“.`)
      wert = metaWert(info, w, geld)
    }
    if (info.art === 'insights') insights = true
    if (info.kosten) kostenBedingung = true
    filters.push({ field: info.feld, value: wert, operator: OP_META[op] })
  }
  if (insights) {
    const z = String(req.zeitraum ?? '')
    if (!istZeitraum(z)) throw new SteuerungError(400, 'invalid_request', 'Zeitraum fehlt (z. B. LAST_7_DAYS).')
    filters.push({ field: 'time_preset', value: z, operator: 'EQUAL' })
  }
  if (kostenBedingung && (aktion === 'pause' || aktion === 'unpause')) {
    hinweise.push('Meta lehnt Kosten-Bedingungen bei Regeln, die ein- oder ausschalten, teils ab (Fehler 2703). Sicherer: Ausgaben plus Ergebnisse.')
  }

  // Aktion
  const execOptions: Raw[] = []
  let executionType: string
  let riskant = false
  let grenzeCent: number | null = null
  let untergrenzeCent: number | null = null
  switch (aktion) {
    case 'pause': executionType = 'PAUSE'; break
    case 'nur_benachrichtigen': executionType = 'NOTIFICATION'; break
    case 'unpause': {
      executionType = 'UNPAUSE'
      riskant = true
      if (!ids.length) throw new SteuerungError(422, 'guardrail', 'Eine Regel zum Aktivieren gilt nur für feste Objekte (IDs), nie für alle im Konto.')
      hinweise.push('Meta-Regeln kennen die CRM-Leitplanke nicht. Geprüft wird beim Anlegen und beim Einschalten.')
      break
    }
    case 'budget_aendern': {
      if (ebene === 'ad') throw new SteuerungError(400, 'invalid_request', 'Werbeanzeigen haben kein Budget. Ebene Anzeigengruppe oder Kampagne wählen.')
      executionType = ebene === 'campaign' ? 'CHANGE_CAMPAIGN_BUDGET' : 'CHANGE_BUDGET'
      const a = obj(req.aktion_wert) as unknown as RegelBudgetAenderung
      if (a.art !== 'prozent' && a.art !== 'betrag') throw new SteuerungError(400, 'invalid_request', 'Budget anpassen: Art „prozent“ oder „betrag“ angeben.')
      const wert = zahlOderFehler(a.wert, 'Budget-Änderung')
      if (wert === 0) throw new SteuerungError(400, 'invalid_request', 'Budget-Änderung darf nicht 0 sein.')
      const erhoehen = wert > 0
      if (a.art === 'prozent') {
        if (erhoehen && wert > REGEL_GRENZEN.max_erhoehung_prozent) throw new SteuerungError(422, 'guardrail', `Höchstens +${REGEL_GRENZEN.max_erhoehung_prozent} % je Schritt.`)
        if (!erhoehen && wert < -REGEL_GRENZEN.max_senkung_prozent) throw new SteuerungError(400, 'invalid_request', `Höchstens -${REGEL_GRENZEN.max_senkung_prozent} % je Schritt.`)
        if (Math.abs(wert) > REGEL_GRENZEN.lernphase_prozent) hinweise.push(`Änderungen über ${REGEL_GRENZEN.lernphase_prozent} % können die Lernphase neu starten.`)
      } else if (erhoehen && wert > REGEL_GRENZEN.max_erhoehung_eur) {
        throw new SteuerungError(422, 'guardrail', `Höchstens +${eurText(REGEL_GRENZEN.max_erhoehung_eur)} je Schritt.`)
      }
      const grenzeEin = a.grenze_eur === undefined || a.grenze_eur === null ? null : zahlOderFehler(a.grenze_eur, 'Grenze')
      let grenzeEur: number
      if (erhoehen) {
        riskant = true
        if (!ids.length) throw new SteuerungError(422, 'guardrail', 'Budget erhöhen geht nur für feste Objekte (IDs), nie für alle im Konto.')
        if (grenzeEin === null || !(grenzeEin > 0)) throw new SteuerungError(422, 'guardrail', 'Beim Erhöhen ist eine Obergrenze (Tagesbudget in EUR) Pflicht.')
        if (grenzeEin > st.max_account_daily_budget) {
          throw new SteuerungError(422, 'guardrail', `Obergrenze höchstens ${eurText(st.max_account_daily_budget)} (Leitplanke des Kontos).`)
        }
        grenzeEur = grenzeEin
      } else {
        grenzeEur = grenzeEin ?? REGEL_GRENZEN.budget_untergrenze_eur
        if (!(grenzeEur > 0)) throw new SteuerungError(400, 'invalid_request', 'Untergrenze muss über 0 liegen.')
        // Ob Meta ein Budget unter der Untergrenze darauf anhebt, ist ungeprüft: Untergrenze nie über dem Standard,
        // außer bei festen Objekten (dann höchstens deren kleinstes Tagesbudget, geprüft in untergrenzePruefen)
        if (grenzeEur > st.max_account_daily_budget) {
          throw new SteuerungError(422, 'guardrail', `Untergrenze höchstens ${eurText(st.max_account_daily_budget)} (Leitplanke des Kontos).`)
        }
        if (!ids.length && grenzeEur > REGEL_GRENZEN.budget_untergrenze_eur) {
          throw new SteuerungError(422, 'guardrail', `Ohne feste Objekte ist die Untergrenze höchstens ${eurText(REGEL_GRENZEN.budget_untergrenze_eur)}.`,
            'Eine höhere Untergrenze könnte niedrigere Budgets anheben. Dafür die Objekte fest auswählen; sie darf nicht über deren Tagesbudget liegen.')
        }
        if (grenzeEin === null) hinweise.push(`Untergrenze ${eurText(grenzeEur)} gesetzt (Standard).`)
      }
      grenzeCent = eurZuKontoCent(grenzeEur, geld)
      if (!erhoehen) untergrenzeCent = grenzeCent
      const changeSpec: Raw = a.art === 'prozent'
        ? { amount: Math.round(wert * 100) / 100, unit: 'PERCENTAGE', limit: grenzeCent }
        : { amount: eurZuKontoCent(wert, geld), unit: 'ACCOUNT_CURRENCY', limit: grenzeCent }
      execOptions.push({ field: 'change_spec', value: changeSpec, operator: 'EQUAL' })
      const maxAusf = a.max_ausfuehrungen === undefined || a.max_ausfuehrungen === null ? null : zahlOderFehler(a.max_ausfuehrungen, 'Höchstzahl')
      if (maxAusf !== null && (!Number.isInteger(maxAusf) || maxAusf < 1 || maxAusf > REGEL_GRENZEN.max_ausfuehrungen)) {
        throw new SteuerungError(400, 'invalid_request', `Höchstzahl je Objekt: 1 bis ${REGEL_GRENZEN.max_ausfuehrungen}.`)
      }
      if (erhoehen && maxAusf === null) throw new SteuerungError(422, 'guardrail', 'Beim Erhöhen ist eine Höchstzahl je Objekt Pflicht.')
      if (maxAusf !== null) execOptions.push({ field: 'execution_count_limit', value: maxAusf, operator: 'EQUAL' })
      const abstand = a.mindestabstand_stunden === undefined || a.mindestabstand_stunden === null
        ? REGEL_GRENZEN.standard_mindestabstand_stunden : zahlOderFehler(a.mindestabstand_stunden, 'Mindestabstand')
      const minAbstand = erhoehen ? REGEL_GRENZEN.min_mindestabstand_erhoehen_stunden : 1
      if (!Number.isInteger(abstand) || abstand < minAbstand || abstand > 720) {
        throw new SteuerungError(400, 'invalid_request', `Mindestabstand: ${minAbstand} bis 720 Stunden.`)
      }
      execOptions.push({ field: 'action_frequency', value: abstand * 60, operator: 'EQUAL' })
      if (ebene === 'adset') hinweise.push('Bei Kampagnenbudget (Advantage+ Budget) hat die Anzeigengruppe kein eigenes Budget; dann Ebene Kampagne wählen.')
      break
    }
  }

  // Empfänger
  const empf = metaIds(req.empfaenger_ids, 'Empfänger', 10)
  if (empf.length) execOptions.push({ field: 'user_ids', value: empf, operator: 'EQUAL' })
  else if (aktion === 'nur_benachrichtigen') {
    hinweise.push('Ohne Empfänger meldet Meta nur dem Ersteller (System-Nutzer des CRM). Die Treffer stehen trotzdem im Verlauf hier.')
  }

  // Zeitplan
  const zp = String(req.zeitplan ?? '') as RegelZeitplan
  let scheduleSpec: Raw
  if (zp === 'laufend') scheduleSpec = { schedule_type: 'SEMI_HOURLY' }
  else if (zp === 'taeglich') scheduleSpec = { schedule_type: 'DAILY' }
  else if (zp === 'eigen') {
    const fenster = Array.isArray(req.zeitplan_eigen) ? req.zeitplan_eigen : []
    if (!fenster.length || fenster.length > 14) throw new SteuerungError(400, 'invalid_request', 'Benutzerdefinierter Zeitplan: 1 bis 14 Zeitfenster.')
    scheduleSpec = { schedule_type: 'CUSTOM', schedule: fenster.map(zeitfensterMeta) }
  } else throw new SteuerungError(400, 'invalid_request', 'Zeitplan fehlt (laufend, taeglich oder eigen).')
  if (aktion === 'budget_aendern' && zp === 'laufend') hinweise.push('Budget-Regeln besser täglich prüfen lassen; der Mindestabstand schützt trotzdem.')

  const executionSpec: Raw = { execution_type: executionType }
  if (execOptions.length) executionSpec.execution_options = execOptions
  const payload: Raw = {
    name,
    evaluation_spec: { evaluation_type: 'SCHEDULE', filters },
    execution_spec: executionSpec,
    schedule_spec: scheduleSpec,
    status: req.aktivieren === true ? 'ENABLED' : 'DISABLED',
  }
  return { payload, ebene, aktion, ids, kampagnenIds, gruppenIds, riskant, grenzeCent, untergrenzeCent, hinweise }
}

function zeitfensterMeta(z0: RegelZeitfenster): Raw {
  const z = obj(z0)
  const out: Raw = {}
  const tage = Array.isArray(z.tage) ? uniq(z.tage.map(t => num(t))) : []
  if (tage.some(t => t === null || !Number.isInteger(t) || t < 0 || t > 6)) {
    throw new SteuerungError(400, 'invalid_request', 'Wochentage als Zahlen 0 (Sonntag) bis 6 (Samstag).')
  }
  if (tage.length) out.days = (tage as number[]).sort((a, b) => a - b)
  const minute = (v: unknown, label: string): number | null => {
    if (v === undefined || v === null) return null
    const n = num(v)
    if (n === null || !Number.isInteger(n) || n < 0 || n > 1440 || n % 30 !== 0) {
      throw new SteuerungError(400, 'invalid_request', `${label}: Minuten nach Mitternacht in 30er-Schritten (0 bis 1440).`)
    }
    return n
  }
  const von = minute(z.von_minute, 'Von')
  const bis = minute(z.bis_minute, 'Bis')
  if (bis !== null && von === null) throw new SteuerungError(400, 'invalid_request', '„Bis“ geht nur zusammen mit „Von“.')
  if (von !== null && bis !== null && bis < von) throw new SteuerungError(400, 'invalid_request', '„Bis“ muss nach „Von“ liegen.')
  if (von !== null) out.start_minute = von
  if (bis !== null) out.end_minute = bis
  if (out.days === undefined && out.start_minute === undefined) throw new SteuerungError(400, 'invalid_request', 'Jedes Zeitfenster braucht Wochentage oder eine Uhrzeit.')
  return out
}

// ── Regel lesen (Meta-Spezifikation -> Deutsch + Eingabe) ────────────────────

export interface RegelGelesen {
  ebene: SteuerungEbene | null
  aktion: RegelAktion | null
  aktion_meta: string | null
  bewertung: 'SCHEDULE' | 'TRIGGER' | null
  zeitraum: RegelZeitraum | null
  geltung_text: string
  bedingungen_text: string[]
  aktion_text: string
  zeitplan_text: string
  riskant: boolean
  /** feste IDs (Filter id) */
  ids: string[]
  /** Obergrenze bei Budget-Erhöhung (Cent der Kontowährung) */
  grenzeCent: number | null
  /** Untergrenze beim Senken (Cent der Kontowährung), sonst null */
  untergrenzeCent: number | null
  eingabe: RuleCreateRequest | null
}

function rohWertText(v: unknown): string {
  if (Array.isArray(v)) return v.map(x => str(x) || JSON.stringify(x)).join(', ').slice(0, 200)
  if (v && typeof v === 'object') return JSON.stringify(v).slice(0, 200)
  return str(v) || String(v)
}

export function regelLesen(r: Raw, geld: SteuerungGeld | null): RegelGelesen {
  const ev = obj(r.evaluation_spec)
  const ex = obj(r.execution_spec)
  const sc = obj(r.schedule_spec)
  let abbildbar = true
  const bewertungRoh = str(ev.evaluation_type)
  const bewertung = bewertungRoh === 'SCHEDULE' || bewertungRoh === 'TRIGGER' ? bewertungRoh : null
  if (bewertung !== 'SCHEDULE') abbildbar = false

  let ebene: SteuerungEbene | null = null
  let zeitraum: RegelZeitraum | null = null
  let zeitraumText = ''
  const ids: string[] = []
  const filter: RegelFilter = {}
  const geltungZusatz: string[] = []
  const bedingungen: RegelBedingung[] = []
  const bedText: string[] = []
  for (const f0 of arr<Raw>(ev.filters)) {
    const field = str(f0.field)
    const op = str(f0.operator)
    const v = f0.value
    if (field === 'entity_type') { ebene = META_EBENE[str(v)] ?? null; continue }
    if (field === 'id' && (op === 'IN' || op === 'EQUAL')) { ids.push(...(Array.isArray(v) ? v : [v]).map(str).filter(Boolean)); continue }
    if (field === 'campaign.id' && op === 'IN') { filter.kampagnen_ids = arr<unknown>(v).map(str); geltungZusatz.push(`in ${filter.kampagnen_ids.length} Kampagne(n)`); continue }
    if (field === 'adset.id' && op === 'IN') { filter.anzeigengruppen_ids = arr<unknown>(v).map(str); geltungZusatz.push(`in ${filter.anzeigengruppen_ids.length} Anzeigengruppe(n)`); continue }
    if (field === 'name' && op === 'CONTAIN') { filter.name_enthaelt = str(v); geltungZusatz.push(`Name enthält „${str(v)}“`); continue }
    if (field === 'campaign.name' && op === 'CONTAIN') { filter.kampagnenname_enthaelt = str(v); geltungZusatz.push(`Kampagnenname enthält „${str(v)}“`); continue }
    if (field === 'time_preset') {
      const z = str(v)
      if (istZeitraum(z)) zeitraum = z
      else abbildbar = false
      zeitraumText = istZeitraum(z) ? REGEL_ZEITRAUM_LABEL[z] : z
      continue
    }
    if (field === 'attribution_window' && str(v) === 'ACCOUNT_DEFAULT') continue
    const info = FELD_INFO.get(field)
    const ourOp = META_OP[op]
    if (info && ourOp) {
      const conv = (x: unknown): number => {
        const n = num(x) ?? 0
        return info.einheit === 'eur' && geld ? Math.round(kontoCentZuEur(n, geld) * 100) / 100 : n
      }
      if ((ourOp === 'zwischen' || ourOp === 'nicht_zwischen') && Array.isArray(v) && v.length === 2) {
        const paar: [number, number] = [conv(v[0]), conv(v[1])]
        bedingungen.push({ feld: info.feld, operator: ourOp, wert: paar })
        bedText.push(`${info.label} ${REGEL_OPERATOR_LABEL[ourOp]} ${geld || info.einheit !== 'eur' ? `${wertText(info, paar[0])} und ${wertText(info, paar[1])}` : rohWertText(v)}`)
      } else {
        const w = conv(v)
        bedingungen.push({ feld: info.feld, operator: ourOp, wert: w })
        bedText.push(`${info.label} ${REGEL_OPERATOR_LABEL[ourOp]} ${geld || info.einheit !== 'eur' ? wertText(info, w) : rohWertText(v)}`)
      }
      if (info.einheit === 'eur' && !geld) abbildbar = false
      continue
    }
    abbildbar = false
    bedText.push(`${field} ${META_OP_TEXT[op] ?? op.toLowerCase()} ${rohWertText(v)}`)
  }
  if (ids.length) filter.ids = ids
  if (zeitraumText) bedText.push(`Zeitraum: ${zeitraumText}`)
  if (!ebene && !ids.length) abbildbar = false

  const ebeneText = ebene ? EBENE_PLURAL[ebene] : 'Objekte'
  const geltung_text = (ids.length ? `${ids.length} feste ${ebeneText}` : `alle aktiven ${ebeneText} im Werbekonto`) +
    (geltungZusatz.length ? `, ${geltungZusatz.join(', ')}` : '')

  // Aktion
  const typ = str(ex.execution_type)
  const opts = arr<Raw>(ex.execution_options)
  const opt = (name: string): unknown => opts.find(o => str(o.field) === name)?.value
  let aktion: RegelAktion | null = null
  let aktionWert: RegelBudgetAenderung | undefined
  let riskant = false
  let grenzeCent: number | null = null
  let untergrenzeCent: number | null = null
  let aktion_text = ''
  switch (typ) {
    case 'PAUSE': aktion = 'pause'; aktion_text = REGEL_AKTION_LABEL.pause; break
    case 'NOTIFICATION': aktion = 'nur_benachrichtigen'; aktion_text = REGEL_AKTION_LABEL.nur_benachrichtigen; break
    case 'UNPAUSE': aktion = 'unpause'; riskant = true; aktion_text = REGEL_AKTION_LABEL.unpause; break
    case 'CHANGE_BUDGET':
    case 'CHANGE_CAMPAIGN_BUDGET': {
      aktion = 'budget_aendern'
      const cs = obj(opt('change_spec'))
      const amount = num(cs.amount) ?? 0
      const unit = str(cs.unit)
      const limit = num(cs.limit)
      const zielfeld = str(cs.target_field)
      grenzeCent = limit
      if (amount < 0 && limit !== null) untergrenzeCent = limit
      riskant = amount > 0 || !!zielfeld || Array.isArray(cs.limit)
      const anzahl = num(opt('execution_count_limit'))
      const freq = num(opt('action_frequency'))
      if (zielfeld || Array.isArray(cs.limit) || (unit !== 'PERCENTAGE' && unit !== 'ACCOUNT_CURRENCY') || (unit === 'ACCOUNT_CURRENCY' && !geld)) {
        abbildbar = false
        aktion_text = `${REGEL_AKTION_LABEL.budget_aendern} (${zielfeld ? `Ziel ${zielfeld}` : rohWertText(cs)})`
      } else {
        const wert = unit === 'PERCENTAGE' ? amount : Math.round(kontoCentZuEur(amount, geld as SteuerungGeld) * 100) / 100
        const grenzeEur = limit !== null && geld ? Math.round(kontoCentZuEur(limit, geld) * 100) / 100 : undefined
        aktionWert = {
          art: unit === 'PERCENTAGE' ? 'prozent' : 'betrag', wert,
          ...(grenzeEur !== undefined ? { grenze_eur: grenzeEur } : {}),
          ...(anzahl !== null ? { max_ausfuehrungen: anzahl } : {}),
          ...(freq !== null ? { mindestabstand_stunden: Math.round(freq / 60) } : {}),
        }
        const teile = [`${REGEL_AKTION_LABEL.budget_aendern}: ${wert > 0 ? '+' : ''}${unit === 'PERCENTAGE' ? `${zahlText(wert)} %` : eurText(wert)}`]
        if (grenzeEur !== undefined) teile.push(`${wert > 0 ? 'Obergrenze' : 'Untergrenze'} ${eurText(grenzeEur)}`)
        if (anzahl !== null) teile.push(`höchstens ${anzahl}-mal je Objekt`)
        if (freq !== null) teile.push(`frühestens alle ${zahlText(Math.round(freq / 60))} Stunden`)
        aktion_text = teile.join(', ')
      }
      break
    }
    case 'PING_ENDPOINT': abbildbar = false; aktion_text = 'Webhook auslösen'; break
    default: {
      abbildbar = false
      riskant = true
      const gesperrt: Record<string, string> = {
        CHANGE_BID: 'Manuelles Gebot anpassen', ROTATE: 'Werbeanzeigen rotieren', REBALANCE_BUDGET: 'Budget umverteilen',
        INCREASE_RADIUS: 'Umkreis erweitern', ADD_INTEREST_RELAXATION: 'Interessen lockern',
      }
      aktion_text = gesperrt[typ] ?? (typ || 'Unbekannte Aktion')
    }
  }
  const empf = arr<unknown>(opt('user_ids')).map(str).filter(Boolean)
  if (empf.length) aktion_text += ` (Meldung an ${empf.length} Person${empf.length === 1 ? '' : 'en'})`

  // Zeitplan
  const st = str(sc.schedule_type)
  let zeitplan: RegelZeitplan | null = null
  let zeitplanEigen: RegelZeitfenster[] | undefined
  let zeitplan_text = ZEITPLAN_TEXT[st] ?? (bewertung === 'TRIGGER' ? 'Sofort bei Änderung (nur per API)' : st || 'unbekannt')
  if (st === 'SEMI_HOURLY') zeitplan = 'laufend'
  else if (st === 'DAILY') zeitplan = 'taeglich'
  else if (st === 'CUSTOM') {
    zeitplan = 'eigen'
    zeitplanEigen = arr<Raw>(sc.schedule).map(s => {
      const tage = arr<unknown>(s.days).map(d => num(d)).filter((d): d is number => d !== null)
      const von = num(s.start_minute)
      const bis = num(s.end_minute)
      return { tage, ...(von !== null ? { von_minute: von } : {}), ...(bis !== null ? { bis_minute: bis } : {}) }
    })
    zeitplan_text = `${REGEL_ZEITPLAN_LABEL.eigen}: ` + zeitplanEigen.map(z => {
      const tage = z.tage.length ? z.tage.map(t => TAGE_KURZ[t] ?? String(t)).join(', ') : 'täglich'
      const zeit = z.von_minute !== undefined ? (z.bis_minute !== undefined && z.bis_minute !== z.von_minute ? ` ${minuteText(z.von_minute)} bis ${minuteText(z.bis_minute)}` : ` um ${minuteText(z.von_minute)}`) : ' halbstündlich'
      return `${tage}${zeit}`
    }).join('; ')
  } else abbildbar = false

  let eingabe: RuleCreateRequest | null = null
  if (abbildbar && ebene && aktion && zeitplan && bedingungen.length) {
    eingabe = {
      name: str(r.name),
      ebene,
      ...(Object.keys(filter).length ? { filter } : {}),
      bedingungen,
      zeitraum: zeitraum ?? REGEL_ZEITRAUM_EMPFOHLEN,
      aktion,
      ...(aktionWert ? { aktion_wert: aktionWert } : {}),
      zeitplan,
      ...(zeitplanEigen ? { zeitplan_eigen: zeitplanEigen } : {}),
      ...(empf.length ? { empfaenger_ids: empf } : {}),
    }
  }
  return {
    ebene, aktion, aktion_meta: typ || null, bewertung, zeitraum, geltung_text, bedingungen_text: bedText,
    aktion_text, zeitplan_text, riskant, ids, grenzeCent, untergrenzeCent, eingabe,
  }
}

export function zusammenfassung(g: RegelGelesen, status: string): string[] {
  return [
    `Gilt für: ${g.geltung_text}`,
    `Wenn: ${g.bedingungen_text.length ? g.bedingungen_text.join(' und ') : 'keine Bedingung'}`,
    `Dann: ${g.aktion_text}`,
    `Prüfung: ${g.zeitplan_text}`,
    `Status: ${status === 'ENABLED' ? 'aktiv' : 'startet ausgeschaltet'}`,
  ]
}

// ── Leitplanke für Regeln, die Ausgaben erhöhen können ───────────────────────

/** effective_status einer Anzeigengruppe, die beim Einschalten ihrer Kampagne ausliefert */
const GRUPPE_LIEFERT_MIT_KAMPAGNE = ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED']


async function leitplanke(ctx: Ctx, g: { ebene: SteuerungEbene | null; aktion: RegelAktion | null; ids: string[]; grenzeCent: number | null },
  objekte: Map<string, KontoObjekt> | null, hinweise: string[]): Promise<void> {
  const geld = await ctx.geld()
  if (geld.waehrung !== 'USD') {
    throw new SteuerungError(409, 'unsupported', 'Die Leitplanken-Prüfung kennt nur USD-Werbekonten.', 'Regel ohne Erhöhung anlegen oder Sven fragen.')
  }
  if (!g.ids.length || !g.ebene) {
    throw new SteuerungError(422, 'guardrail', 'Diese Regel gilt nicht für feste Objekte; die Leitplanke ist nicht prüfbar.',
      'Regel hier mit festen IDs neu anlegen.')
  }
  let addCent = 0
  const ersetzt: string[] = [...g.ids]
  if (g.aktion === 'budget_aendern') {
    if (g.grenzeCent === null || !(g.grenzeCent > 0)) {
      throw new SteuerungError(422, 'guardrail', 'Budget-Erhöhung ohne Obergrenze: die Leitplanke ist nicht prüfbar.', 'Regel hier mit Obergrenze neu anlegen.')
    }
    addCent = g.ids.length * g.grenzeCent
  } else if (g.aktion === 'unpause') {
    if (g.ebene === 'ad') {
      hinweise.push('Werbeanzeigen haben kein eigenes Budget; die Leitplanke greift über die Anzeigengruppe.')
      return
    }
    const obj2 = objekte ?? await pruefeKontoObjekte(ctx, g.ebene, g.ids, 'Objekte der Regel')
    const jetzt = Date.now()
    // Tagesbudget, sonst Laufzeitbudget als Rest je verbleibendem Tag (wie budgetHeadroom)
    const ohneBudget: string[] = []
    for (const id of g.ids) {
      const o = obj2.get(id)
      const c = o ? tagesCent(o, jetzt) : 0
      if (c > 0) addCent += c
      else if (g.ebene === 'campaign') ohneBudget.push(id)
    }
    // Kampagne ohne Kampagnenbudget: es zählen ihre Anzeigengruppen, die mit der Kampagne wieder ausliefern
    if (ohneBudget.length) {
      let gruppen: KontoObjekt[]
      try {
        gruppen = await gruppenDerKampagnen(ctx, ohneBudget)
      } catch (e) {
        throw new SteuerungError(503, 'guardrail', 'Die Budgets der Anzeigengruppen ließen sich nicht lesen, deshalb wird nichts geändert.', softMsg(e))
      }
      for (const a of gruppen) {
        if (GRUPPE_LIEFERT_MIT_KAMPAGNE.indexOf(a.status ?? '') < 0) continue
        const c = tagesCent(a, jetzt)
        if (c > 0) { addCent += c; ersetzt.push(a.id) }
      }
    }
  } else return
  let h
  try {
    h = await budgetHeadroom(ctx.sb, { addDailyUsdCents: addCent, replaceEntityIds: ersetzt })
  } catch (e) {
    throw new SteuerungError(503, 'guardrail', 'Die Leitplanke ließ sich nicht prüfen, deshalb wird nichts geändert.', softMsg(e))
  }
  if (!h.ok) {
    throw new SteuerungError(422, 'guardrail',
      `Leitplanke: im schlimmsten Fall ${eurText(h.afterEur)} pro Tag, erlaubt sind ${eurText(h.limitEur)}.`,
      'Obergrenze senken, weniger Objekte wählen oder das Tageslimit in den Einstellungen anpassen (nur Admin).',
      { aktiv_eur: h.activeEur, danach_eur: h.afterEur, limit_eur: h.limitEur })
  }
  hinweise.push(`Leitplanke geprüft: im schlimmsten Fall ${eurText(h.afterEur)} von ${eurText(h.limitEur)} pro Tag.`)
}

/**
 * Budget senken mit Untergrenze: ob Meta ein Budget, das schon unter der Untergrenze liegt,
 * darauf anhebt, ist ungeprüft. Deshalb nie über einem aktuellen Tagesbudget: bei festen
 * Objekten höchstens deren kleinstes Tagesbudget, sonst höchstens der Standard (30 EUR,
 * beim Einschalten 10 % Spielraum für Kursschwankungen).
 */
async function untergrenzePruefen(ctx: Ctx, g: { ebene: SteuerungEbene | null; ids: string[]; untergrenzeCent: number | null },
  objekte: Map<string, KontoObjekt> | null, geld: SteuerungGeld | null): Promise<void> {
  if (g.untergrenzeCent === null) return
  if (g.ids.length && g.ebene) {
    let m: Map<string, KontoObjekt>
    try {
      m = objekte ?? await kontoObjekte(ctx, g.ebene, g.ids)
    } catch (e) {
      throw new SteuerungError(503, 'guardrail', 'Die Tagesbudgets ließen sich nicht lesen, deshalb wird nichts geändert.', softMsg(e))
    }
    const budgets = g.ids.map(id => m.get(id)?.daily_budget ?? null).filter((b): b is number => b !== null && b > 0)
    if (!budgets.length) return
    const kleinstes = Math.min(...budgets)
    if (g.untergrenzeCent > kleinstes) {
      const text = geld ? eurText(Math.round(kontoCentZuEur(kleinstes, geld) * 100) / 100) : `${kleinstes} Cent`
      throw new SteuerungError(422, 'guardrail', `Die Untergrenze liegt über dem kleinsten aktuellen Tagesbudget (${text}).`,
        'Meta könnte das Budget sonst auf die Untergrenze anheben. Untergrenze senken oder dieses Objekt herausnehmen.')
    }
    return
  }
  if (!geld) {
    throw new SteuerungError(503, 'guardrail', 'Die Untergrenze ließ sich nicht prüfen (Kontowährung nicht lesbar), deshalb wird nichts geändert.')
  }
  const erlaubt = Math.round(eurZuKontoCent(REGEL_GRENZEN.budget_untergrenze_eur, geld) * 1.1)
  if (g.untergrenzeCent > erlaubt) {
    throw new SteuerungError(422, 'guardrail', `Ohne feste Objekte ist die Untergrenze höchstens ${eurText(REGEL_GRENZEN.budget_untergrenze_eur)}.`,
      'Eine höhere Untergrenze könnte niedrigere Budgets anheben. Regel hier mit festen Objekten neu anlegen.')
  }
}

// ── rules_list ───────────────────────────────────────────────────────────────

function fehlerText(code: number | null): string | null {
  if (code === null) return null
  if (code === 2703) return 'Kosten-Bedingung bei einer Regel, die ausschaltet (von Meta nicht erlaubt).'
  return `Meta-Fehlercode ${code}`
}

export function regelUebersicht(r: Raw, geld: SteuerungGeld | null, eigene: Set<string>): RegelUebersicht {
  const g = regelLesen(r, geld)
  const status = str(r.status)
  const code = num(r.disable_error_code)
  return {
    id: str(r.id),
    name: str(r.name) || '(ohne Namen)',
    status,
    status_label: REGEL_STATUS_LABEL[status as RegelStatus] ?? status,
    aktiv: status === 'ENABLED',
    ebene: g.ebene,
    aktion: g.aktion,
    aktion_meta: g.aktion_meta,
    bewertung: g.bewertung,
    zeitraum: g.zeitraum,
    geltung_text: g.geltung_text,
    bedingungen_text: g.bedingungen_text,
    aktion_text: g.aktion_text,
    zeitplan_text: g.zeitplan_text,
    riskant: g.riskant,
    von_hp: eigene.has(str(r.id)),
    eingabe: g.eingabe,
    fehler: status === 'HAS_ISSUES' || code !== null ? { code, text: fehlerText(code) } : null,
    erstellt: isoZeit(r.created_time),
    aktualisiert: isoZeit(r.updated_time),
    ersteller: str(obj(r.created_by).name) || null,
  }
}

export async function modeRulesList(ctx: Ctx, _req: RulesListRequest): Promise<RulesListResponse> {
  const warnings: string[] = []
  const list = await graphAll<Raw>(`act_${ctx.env.account}/adrules_library`, { fields: RULE_FIELDS, limit: 100 }, { maxPages: 5 })
  const geld = await ctx.geld()
  const eigene = await eigeneAnlagen(ctx.sb, 'rule_create')
  const items = list.map(r => regelUebersicht(r, geld, eigene)).filter(r => r.status !== 'DELETED')
  items.sort((a, b) => Number(b.aktiv) - Number(a.aktiv) || a.name.localeCompare(b.name, 'de'))
  if (items.some(r => r.bewertung === 'TRIGGER')) warnings.push('Sofort-Regeln (TRIGGER) gibt es nur per API; im Werbeanzeigenmanager sind sie unsichtbar.')
  return { items, geld, warnings, usage: usageInfo() }
}

// ── rule_create ──────────────────────────────────────────────────────────────

export async function modeRuleCreate(ctx: Ctx, req: RuleCreateRequest): Promise<RuleCreateResponse> {
  const st = await ctx.settings()
  const geld = await ctx.geld()
  const bau = regelBauen(req, geld, st)
  const hinweise = [...bau.hinweise]

  if (bau.riskant && !istAdmin(ctx)) throw adminNoetig('Regeln, die aktivieren oder Budgets erhöhen, anlegen')

  // Objekte gehören zum Werbekonto? (je Art ein Aufruf)
  let objekte: Map<string, KontoObjekt> | null = null
  if (bau.ids.length) objekte = await pruefeKontoObjekte(ctx, bau.ebene, bau.ids, 'Objekte der Regel')
  if (bau.kampagnenIds.length) await pruefeKontoObjekte(ctx, 'campaign', bau.kampagnenIds, 'Kampagnen der Regel')
  if (bau.gruppenIds.length) await pruefeKontoObjekte(ctx, 'adset', bau.gruppenIds, 'Anzeigengruppen der Regel')
  if (!bau.ids.length && !bau.kampagnenIds.length && !bau.gruppenIds.length) {
    hinweise.push(`Gilt für alle aktiven ${EBENE_PLURAL[bau.ebene]} im Werbekonto, auch für neue.`)
  }
  if (bau.riskant) {
    await leitplanke(ctx, { ebene: bau.ebene, aktion: bau.aktion, ids: bau.ids, grenzeCent: bau.grenzeCent }, objekte, hinweise)
  }
  if (bau.untergrenzeCent !== null) await untergrenzePruefen(ctx, bau, objekte, geld)
  if (bau.aktion === 'pause') hinweise.push(STEUERUNG_HINWEIS_AUTOPILOT)

  // Doppelklick-Schutz: Regel gleichen Namens
  const name = String(bau.payload.name)
  try {
    const vorhanden = await graphAll<Raw>(`act_${ctx.env.account}/adrules_library`, { fields: 'id,name,status', limit: 100 }, { maxPages: 5, strict: true })
    const gleich = vorhanden.find(r => str(r.status) !== 'DELETED' && str(r.name).trim().toLowerCase() === name.toLowerCase())
    if (gleich) {
      throw new SteuerungError(409, 'conflict', `Es gibt schon eine Regel „${name}“.`, 'Anderen Namen wählen oder die vorhandene Regel einschalten.', { id: str(gleich.id) })
    }
  } catch (e) {
    if (e instanceof SteuerungError) throw e
    hinweise.push(`Vorhandene Regeln nicht geprüft (${softMsg(e)}).`)
  }

  const gelesen = regelLesen({ ...bau.payload }, geld)
  const status = bau.payload.status as 'ENABLED' | 'DISABLED'
  const basis = { payload: bau.payload, hinweise, status, riskant: bau.riskant, zusammenfassung: zusammenfassung(gelesen, status) }
  if (req.vorschau === true) return { ...basis, vorschau: true, id: null, usage: usageInfo() }

  const res = await metaPost(ctx, `act_${ctx.env.account}/adrules_library`, bau.payload, { level: 'rule' })
  const id = str(res.id)
  if (!id) throw new SteuerungError(502, 'meta_error', 'Meta hat die Regel angenommen, aber keine ID geliefert.', 'In der Regelliste nachsehen, bevor du es erneut versuchst.')
  return { ...basis, vorschau: false, id, usage: usageInfo() }
}

// ── rule_status ──────────────────────────────────────────────────────────────

function nichtGefunden(err: unknown): SteuerungError | null {
  if (err instanceof MetaApiError && (err.subcode === 33 || /does not exist|nonexisting|Unsupported get request/i.test(err.userMsg ?? err.message))) {
    return new SteuerungError(404, 'not_found', 'Regel nicht gefunden oder kein Zugriff.')
  }
  return null
}

async function regelHolen(ctx: Ctx, id: string, felder: string): Promise<Raw> {
  let r: Raw
  try {
    r = await graphGet<Raw>(id, { fields: felder })
  } catch (e) {
    throw nichtGefunden(e) ?? e
  }
  const konto = str(r.account_id).replace(/^act_/, '')
  if (!konto) throw new SteuerungError(403, 'forbidden', 'Meta nennt für diese Regel kein Werbekonto; sie wird hier nicht geändert.')
  if (konto !== ctx.env.account) throw new SteuerungError(403, 'forbidden', 'Diese Regel gehört zu einem anderen Werbekonto.')
  return r
}

export async function modeRuleStatus(ctx: Ctx, req: RuleStatusRequest): Promise<RuleStatusResponse> {
  const id = metaId(req.id, 'Regel-ID')
  const neu = str(req.status)
  if (neu !== 'ENABLED' && neu !== 'DISABLED') throw new SteuerungError(400, 'invalid_request', 'Status ENABLED oder DISABLED angeben. Löschen gibt es nicht.')
  const r = await regelHolen(ctx, id, 'id,name,status,account_id,evaluation_spec,execution_spec,schedule_spec')
  const vorher = str(r.status) || null
  const hinweise: string[] = []
  const payload: Raw = { status: neu }
  if (vorher === 'DELETED') throw new SteuerungError(409, 'conflict', 'Die Regel ist bei Meta gelöscht und lässt sich nicht mehr schalten.')
  if (neu === 'ENABLED') {
    let geld: SteuerungGeld | null = null
    try { geld = await ctx.geld() } catch (e) { hinweise.push(`Kontowährung nicht lesbar (${softMsg(e)}).`) }
    const g = regelLesen(r, geld)
    // Nur die vier Aktionen, die das CRM selbst anlegt und prüfen kann (nie Gebot, Rotation, Zielgruppe ...)
    if (g.aktion === null) {
      const gesperrt = REGEL_GESPERRTE_AKTIONEN.find(o => o.key === META_GESPERRT[g.aktion_meta ?? ''])
      if (gesperrt) throw new SteuerungError(422, 'housing_forbidden', `„${gesperrt.label}“ ist hier gesperrt; die Regel bleibt aus.`, gesperrt.grund)
      throw new SteuerungError(422, 'guardrail', `„${g.aktion_text}“ legt das CRM nicht an und kann sie nicht prüfen; die Regel bleibt aus.`,
        'Einschalten nur dort, wo die Regel angelegt wurde, oder hier eine neue Regel mit einer erlaubten Aktion anlegen.')
    }
    if (g.riskant) {
      if (!istAdmin(ctx)) throw adminNoetig('Regeln, die aktivieren oder Budgets erhöhen, einschalten')
      await leitplanke(ctx, { ebene: g.ebene, aktion: g.aktion, ids: g.ids, grenzeCent: g.grenzeCent }, null, hinweise)
    }
    if (g.untergrenzeCent !== null) await untergrenzePruefen(ctx, g, null, geld)
    if (vorher === 'HAS_ISSUES') hinweise.push('Die Regel hatte einen Fehler bei Meta. Nach dem Einschalten den Verlauf prüfen.')
  }
  const basis = { id, status_vorher: vorher, status_neu: neu as 'ENABLED' | 'DISABLED', payload, hinweise }
  if (vorher === neu) {
    return { ...basis, vorschau: req.vorschau === true, hinweise: [...hinweise, 'Die Regel hat diesen Status schon; nichts geändert.'], usage: usageInfo() }
  }
  if (req.vorschau === true) return { ...basis, vorschau: true, usage: usageInfo() }
  await metaPost(ctx, id, payload, { level: 'rule', entityId: id, before: { status: vorher }, idempotent: true })
  return { ...basis, vorschau: false, usage: usageInfo() }
}

// ── rule_history ─────────────────────────────────────────────────────────────

function budgetWertText(feld: string, wert: string | null, geld: SteuerungGeld | null): string | null {
  if (wert === null) return null
  const n = num(wert)
  if (geld && n !== null && /budget|bid/i.test(feld)) return eurText(Math.round(kontoCentZuEur(n, geld) * 100) / 100)
  return wert
}

export async function modeRuleHistory(ctx: Ctx, req: RuleHistoryRequest): Promise<RuleHistoryResponse> {
  const warnings: string[] = []
  const limit = Math.max(1, Math.min(100, Math.floor(num(req.limit) ?? 50)))
  const objektId = req.objekt_id === undefined || req.objekt_id === null || req.objekt_id === '' ? null : metaId(req.objekt_id, 'Objekt-ID')
  const params: GraphParams = { limit, hide_no_changes: req.nur_mit_aenderungen !== false }
  if (objektId) params.object_id = objektId

  const regelNamen = new Map<string, string>()
  let pfad: string
  if (req.id !== undefined && req.id !== null && req.id !== '') {
    const id = metaId(req.id, 'Regel-ID')
    const r = await regelHolen(ctx, id, 'id,name,account_id')
    regelNamen.set(id, str(r.name))
    pfad = `${id}/history`
  } else {
    pfad = `act_${ctx.env.account}/adrules_history`
    if (!auslastungHoch()) {
      try {
        const regeln = await graphAll<Raw>(`act_${ctx.env.account}/adrules_library`, { fields: 'id,name', limit: 100 }, { maxPages: 3 })
        for (const r of regeln) regelNamen.set(str(r.id), str(r.name))
      } catch (e) {
        warnings.push(`Regelnamen nicht lesbar (${softMsg(e)}).`)
      }
    }
  }
  const seite = await graphGet<{ data?: Raw[] }>(pfad, params)
  const roh = arr<Raw>(seite?.data).slice(0, limit)

  let geld: SteuerungGeld | null = null
  if (roh.some(e => arr<Raw>(e.results).some(x => arr<Raw>(x.actions).some(a => /budget|bid/i.test(str(a.field)))))) {
    try { geld = await ctx.geld() } catch (e) { warnings.push(`Beträge nicht umrechenbar (${softMsg(e)}).`) }
  }
  const objektIds = uniq(roh.flatMap(e => arr<Raw>(e.results).map(x => str(x.object_id)).filter(Boolean)))
  const namen = objektIds.length ? await spiegelNamen(ctx.sb, objektIds) : new Map()

  const items: RegelVerlaufEintrag[] = roh.map(e => {
    const regelId = str(e.rule_id) || (req.id ? String(req.id) : '') || null
    const code = num(e.exception_code)
    const meldung = str(e.exception_message)
    return {
      zeit: isoZeit(e.timestamp),
      regel_id: regelId,
      regel_name: regelId ? (regelNamen.get(regelId) || null) : null,
      manuell: e.is_manual === true,
      fehler: code !== null || meldung ? { code, text: meldung || null } : null,
      objekte: arr<Raw>(e.results).map(x => {
        const oid = str(x.object_id)
        return {
          objekt_id: oid,
          objekt_typ: META_EBENE[str(x.object_type)] ?? null,
          objekt_name: namen.get(oid)?.name ?? null,
          aktionen: arr<Raw>(x.actions).map(a => {
            const aktion = str(a.action)
            const feld = str(a.field) || null
            return {
              aktion,
              aktion_label: REGEL_VERLAUF_AKTION_LABEL[aktion] ?? aktion,
              feld,
              alt: budgetWertText(feld ?? '', str(a.old_value) || null, geld),
              neu: budgetWertText(feld ?? '', str(a.new_value) || null, geld),
            }
          }),
        }
      }),
    }
  })
  return { items, warnings, usage: usageInfo() }
}

// ── vorlagen ─────────────────────────────────────────────────────────────────

const WOHNEN_SICHER_GRUND = 'Ändert keine Zielgruppe, sondern schaltet nur aus oder meldet. Unter Wohnen erlaubt.'

/** i18n-Schlüssel der Vorlagentexte (Fragment be-steuerung, crm.werbung.steuerung.vorlage.*); Geld in text_params in EUR */
function vorlageKeys(key: string, text_params: Record<string, number>, budget = false) {
  const basis = `crm.werbung.steuerung.vorlage.${key}`
  return {
    titel_key: `${basis}.titel`,
    erklaerung_key: `${basis}.erklaerung`,
    wohnen_grund_key: budget ? 'crm.werbung.steuerung.vorlage.wohnenSicherBudget' : 'crm.werbung.steuerung.vorlage.wohnenSicher',
    text_params,
  }
}

/** HP-Vorlagen (Geld in EUR); Schwellen aus ad_settings (Autopilot K1/K2, Leitplanke). */
export function vorlagenBauen(st: Settings): RegelVorlage[] {
  const k1 = 150
  const k2 = 300
  const tagesHinweis = Math.round(st.max_account_daily_budget * 0.8)
  const senkenAb = Math.round(st.target_cpte_eur * 2)
  return [
    {
      key: 'notbremse', ...vorlageKeys('notbremse', { betrag: k1 }),
      empfohlen: true, wohnen_sicher: true, wohnen_grund: WOHNEN_SICHER_GRUND,
      titel: 'Notbremse: Anzeige ohne Ergebnis ausschalten',
      erklaerung: `Schaltet eine Werbeanzeige aus, die in 7 Tagen mehr als ${eurText(k1)} ausgegeben und kein Ergebnis gebracht hat.`,
      anfrage: {
        name: 'HP Notbremse: Anzeige ohne Ergebnis', ebene: 'ad',
        bedingungen: [{ feld: 'spent', operator: 'groesser', wert: k1 }, { feld: 'results', operator: 'kleiner', wert: 1 }],
        zeitraum: 'LAST_7_DAYS', aktion: 'pause', zeitplan: 'laufend', aktivieren: true, vorlage: 'notbremse',
      },
    },
    {
      key: 'frequenz', ...vorlageKeys('frequenz', {}),
      empfohlen: true, wohnen_sicher: true, wohnen_grund: WOHNEN_SICHER_GRUND,
      titel: 'Hinweis bei Frequenz über 3',
      erklaerung: 'Meldet Anzeigengruppen, deren Anzeigen eine Person im Schnitt öfter als dreimal in 7 Tagen sieht.',
      anfrage: {
        name: 'HP Hinweis: Frequenz über 3', ebene: 'adset',
        bedingungen: [{ feld: 'frequency', operator: 'groesser', wert: 3 }],
        zeitraum: 'LAST_7_DAYS', aktion: 'nur_benachrichtigen', zeitplan: 'taeglich', aktivieren: true, vorlage: 'frequenz',
      },
    },
    {
      key: 'teure_gruppe', ...vorlageKeys('teure_gruppe', { betrag: k2 }),
      empfohlen: true, wohnen_sicher: true, wohnen_grund: WOHNEN_SICHER_GRUND,
      titel: 'Teure Anzeigengruppe melden',
      erklaerung: `Meldet Anzeigengruppen mit mehr als ${eurText(k2)} Ausgaben und weniger als 3 Ergebnissen in 14 Tagen.`,
      anfrage: {
        name: 'HP Hinweis: teure Anzeigengruppe', ebene: 'adset',
        bedingungen: [{ feld: 'spent', operator: 'groesser', wert: k2 }, { feld: 'results', operator: 'kleiner', wert: 3 }],
        zeitraum: 'LAST_14_DAYS', aktion: 'nur_benachrichtigen', zeitplan: 'taeglich', aktivieren: true, vorlage: 'teure_gruppe',
      },
    },
    {
      key: 'tagesausgaben', ...vorlageKeys('tagesausgaben', { betrag: tagesHinweis }),
      empfohlen: false, wohnen_sicher: true, wohnen_grund: WOHNEN_SICHER_GRUND,
      titel: 'Hohe Tagesausgaben melden',
      erklaerung: `Meldet eine Kampagne, sobald sie heute mehr als ${eurText(tagesHinweis)} ausgegeben hat (80 % der Leitplanke).`,
      anfrage: {
        name: 'HP Hinweis: hohe Tagesausgaben', ebene: 'campaign',
        bedingungen: [{ feld: 'spent', operator: 'groesser', wert: tagesHinweis }],
        zeitraum: 'TODAY', aktion: 'nur_benachrichtigen', zeitplan: 'laufend', aktivieren: true, vorlage: 'tagesausgaben',
      },
    },
    {
      key: 'ermuedung', ...vorlageKeys('ermuedung', {}),
      empfohlen: false, wohnen_sicher: true, wohnen_grund: WOHNEN_SICHER_GRUND,
      titel: 'Ermüdetes Werbemittel melden',
      erklaerung: 'Meldet Werbeanzeigen mit Frequenz über 2,5 und Link-Klickrate unter 0,5 % (ab 2.000 Einblendungen in 7 Tagen).',
      anfrage: {
        name: 'HP Hinweis: Werbemittel ermüdet', ebene: 'ad',
        bedingungen: [
          { feld: 'frequency', operator: 'groesser', wert: 2.5 },
          { feld: 'link_ctr', operator: 'kleiner', wert: 0.5 },
          { feld: 'impressions', operator: 'groesser', wert: 2000 },
        ],
        zeitraum: 'LAST_7_DAYS', aktion: 'nur_benachrichtigen', zeitplan: 'taeglich', aktivieren: true, vorlage: 'ermuedung',
      },
    },
    {
      key: 'budget_senken', ...vorlageKeys('budget_senken', { untergrenze: REGEL_GRENZEN.budget_untergrenze_eur, betrag: senkenAb }, true),
      empfohlen: false, wohnen_sicher: true,
      wohnen_grund: 'Senkt nur Budgets, ändert keine Zielgruppe. Unter Wohnen erlaubt.',
      titel: 'Budget senken bei teuren Gruppen',
      erklaerung: `Senkt das Tagesbudget um 20 % (nie unter ${eurText(REGEL_GRENZEN.budget_untergrenze_eur)}), wenn eine Anzeigengruppe in 7 Tagen über ${eurText(senkenAb)} ausgibt und kein Ergebnis bringt. Startet ausgeschaltet.`,
      anfrage: {
        name: 'HP Budget senken: teure Anzeigengruppe', ebene: 'adset',
        bedingungen: [{ feld: 'spent', operator: 'groesser', wert: senkenAb }, { feld: 'results', operator: 'kleiner', wert: 1 }],
        zeitraum: 'LAST_7_DAYS', aktion: 'budget_aendern',
        aktion_wert: { art: 'prozent', wert: -20, grenze_eur: REGEL_GRENZEN.budget_untergrenze_eur, mindestabstand_stunden: 72 },
        zeitplan: 'taeglich', aktivieren: false, vorlage: 'budget_senken',
      },
    },
  ]
}

export async function modeVorlagen(ctx: Ctx, _req: VorlagenRequest): Promise<VorlagenResponse> {
  const warnings: string[] = []
  const st = await ctx.settings()
  let geld: SteuerungGeld | null = null
  try { geld = await ctx.geld() } catch (e) { warnings.push(`Kontowährung nicht lesbar (${softMsg(e)}).`) }
  const empfaenger: Array<{ id: string; name: string }> = []
  if (!auslastungHoch()) {
    try {
      // UNGEPRÜFT: ob diese IDs als user_ids für Regel-Benachrichtigungen gelten
      const users = await graphAll<Raw>(`act_${ctx.env.account}/users`, { fields: 'id,name', limit: 50 }, { maxPages: 1 })
      for (const u of users) {
        const id = str(u.id)
        if (/^[0-9]{6,25}$/.test(id)) empfaenger.push({ id, name: str(u.name) || id })
      }
    } catch (e) {
      warnings.push(`Nutzer des Werbekontos nicht lesbar (${softMsg(e)}); Benachrichtigungen gehen dann nur an den System-Nutzer.`)
    }
  }
  return {
    vorlagen: vorlagenBauen(st),
    gesperrte_aktionen: REGEL_GESPERRTE_AKTIONEN,
    felder: REGEL_FELDER,
    empfaenger,
    hinweis_autopilot: STEUERUNG_HINWEIS_AUTOPILOT,
    geld,
    warnings,
    usage: usageInfo(),
  }
}
