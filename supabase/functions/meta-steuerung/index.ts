// Edge Function: meta-steuerung
// Werbemanager-Reiter „Tests & Regeln“: Metas A/B-Tests (Ad Studies) und Metas
// automatisierte Regeln (Ad Rules) lesen, anlegen, beenden bzw. ein-/ausschalten.
// Löscht bei Meta nie etwas (Svens Regel): Tests werden beendet, Regeln ausgeschaltet.
// Unser Autopilot bleibt die Hauptsteuerung, Meta-Regeln sind das Sicherheitsnetz.
// Typen: ./typen.ts (identisch zu src/lib/werbeSteuerung.ts).
//
// Anfrage: POST { mode, ...felder } (SteuerungRequestMap in typen.ts)
// Fehler:  { error, hint?, code?, data?, meta? } (code aus STEUERUNG_ERROR_CODES)
//
// ── Lese-Modi (Werbe-Recht reicht, requireAdsAccess) ──
//   { mode: 'studies_list', nur_hp? }            Tests aus act_X/ad_studies + {business}/ad_studies
//   { mode: 'study_get', id, kennzahl? }         Zellen mit Zahlen je Zelle (Insights), Gewinner mit
//                                                 Sicherheit (Meta, sonst HP-Schätzung Gamma-Poisson)
//   { mode: 'rules_list' }                       Regeln mit deutscher Zusammenfassung, Risiko, Kopier-Eingabe
//   { mode: 'rule_history', id?, objekt_id?, nur_mit_aenderungen?, limit? }
//   { mode: 'vorlagen' }                         HP-Vorlagen (wohnen-sicher), Felder, gesperrte Aktionen, Empfänger
//
// ── Schreib-Modi (zusätzlich: admin/verwalter oder Recht „werbung“,
//    ad_settings.builder_enabled = true, Secret META_WRITES_DISABLED != 1;
//    mit vorschau: true nur Recht „werbung“, es geht nichts an Meta) ──
//   { mode: 'study_create', typ, name, start?, ende, kennzahl, zellen[], testbudget?, beschreibung? }
//       POST {business}/ad_studies; SPLIT_TEST (Anzeigengruppen/Kampagnen) bzw. SPLIT_TEST_V2
//       (Anzeigen-Test, 2 bis 5 Werbeanzeigen); Objekte müssen zum Werbekonto gehören
//   { mode: 'study_beenden', id }                Ende auf jetzt + 60 s (nie löschen)
//   { mode: 'rule_create', name, ebene, filter?, bedingungen[], zeitraum, aktion, aktion_wert?, zeitplan, ... }
//       POST act_X/adrules_library; startet ausgeschaltet (außer aktivieren: true).
//       Aktivieren/Budget erhöhen: nur Admin, nur feste IDs, Obergrenze + Leitplanke (budgetHeadroom)
//   { mode: 'rule_status', id, status: 'ENABLED'|'DISABLED' }
//       Ausschalten darf jeder mit Schreibrecht; riskante Regel einschalten nur Admin (+ Leitplanke)
//
// Jeder Meta-POST landet in meta_write_log (fn 'meta-steuerung'). Der Token steht nur
// im Authorization-Header und erscheint nie in Logs oder Antworten. validate_only gibt
// es für ad_studies und adrules_library nicht: geprüft wird lokal, vorschau: true zeigt
// den genauen Payload.
//
// ── Secrets (Supabase Dashboard -> Settings -> Edge Functions -> Secrets) ──
//   META_ACCESS_TOKEN     System-User-Token (ads_management, ads_read, business_management)
//   META_AD_ACCOUNT_ID    Standard 4065490590399677
//   META_BUSINESS_ID      Standard 877580267476541 (Business für ad_studies)
//   META_GRAPH_VERSION    optional (vNN.0), Standard v25.0
//   META_WRITES_DISABLED  1 = globaler Not-Aus für alle Schreibzugriffe an Meta
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (automatisch)
//
// ── Deployment ──
//   supabase functions deploy meta-steuerung --no-verify-jwt
//   (config.toml: [functions.meta-steuerung] verify_jwt = false; Guard requireAdsAccess im Code)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess } from '../_shared/adsAuth.ts'
import { makeCtx, schreibRecht, SteuerungError, toErrorResponse, writeGate, type Ctx } from './common.ts'
import { modeRuleCreate, modeRuleHistory, modeRulesList, modeRuleStatus, modeVorlagen } from './regeln.ts'
import { modeStudiesList, modeStudyBeenden, modeStudyCreate, modeStudyGet } from './tests.ts'
import {
  STEUERUNG_MODES, STEUERUNG_WRITE_MODES,
  type RuleCreateRequest, type RuleHistoryRequest, type RulesListRequest, type RuleStatusRequest, type SteuerungMode,
  type StudiesListRequest, type StudyBeendenRequest, type StudyCreateRequest, type StudyGetRequest, type VorlagenRequest,
} from './typen.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const isMode = (m: string): m is SteuerungMode => (STEUERUNG_MODES as readonly string[]).indexOf(m) >= 0

async function dispatch(ctx: Ctx, mode: SteuerungMode, body: Record<string, unknown>): Promise<unknown> {
  const b = body as unknown
  switch (mode) {
    case 'studies_list': return await modeStudiesList(ctx, b as StudiesListRequest)
    case 'study_get': return await modeStudyGet(ctx, b as StudyGetRequest)
    case 'study_create': return await modeStudyCreate(ctx, b as StudyCreateRequest)
    case 'study_beenden': return await modeStudyBeenden(ctx, b as StudyBeendenRequest)
    case 'rules_list': return await modeRulesList(ctx, b as RulesListRequest)
    case 'rule_create': return await modeRuleCreate(ctx, b as RuleCreateRequest)
    case 'rule_status': return await modeRuleStatus(ctx, b as RuleStatusRequest)
    case 'rule_history': return await modeRuleHistory(ctx, b as RuleHistoryRequest)
    case 'vorlagen': return await modeVorlagen(ctx, b as VorlagenRequest)
  }
  throw new SteuerungError(400, 'invalid_request', `Unbekannter Modus "${String(mode)}".`)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt.', code: 'invalid_request' }, 405)
  let mode = ''
  const started = Date.now()
  try {
    // Läuft mit --no-verify-jwt: Rechte IMMER hier prüfen (Login + Werbe-Recht)
    const caller = await requireAdsAccess(req)
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SteuerungError(400, 'invalid_request', 'Anfrage ohne JSON-Body.')
    mode = String(body.mode ?? '')
    if (!isMode(mode)) {
      throw new SteuerungError(400, 'invalid_request', `Unbekannter Modus "${mode.slice(0, 40)}".`, `Erlaubt: ${STEUERUNG_MODES.join(', ')}`)
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const ctx = makeCtx(sb, caller, mode)
    // vorschau nur als echtes true/false: "true" oder 1 wären sonst ein echter Schreibzugriff
    if (body.vorschau !== undefined && body.vorschau !== null && typeof body.vorschau !== 'boolean') {
      throw new SteuerungError(400, 'invalid_request', 'vorschau muss true oder false sein.')
    }
    const vorschau = body.vorschau === true
    if (body.vorschau !== undefined) body.vorschau = vorschau
    if (STEUERUNG_WRITE_MODES.indexOf(mode) >= 0) {
      // vorschau sendet nichts an Meta: dann reicht das Schreibrecht
      const gate = vorschau ? await schreibRecht(ctx) : await writeGate(ctx)
      if (gate) throw gate
    }
    const result = await dispatch(ctx, mode, body)
    console.log(`[meta-steuerung] ${mode}${vorschau ? ' (vorschau)' : ''} ok in ${Date.now() - started} ms`)
    return json(result, 200)
  } catch (err) {
    const { status, body } = toErrorResponse(err)
    console.error(`[meta-steuerung] ${mode || '-'} ${status} ${body.code ?? ''}: ${body.error.slice(0, 300)}`)
    return json(body, status)
  }
})
