// Edge Function: meta-werkzeuge
// Werkzeuge des Werbemanagers neben dem Kampagnen-Assistenten: Zielgruppen
// (Custom Audiences), Sofortformulare, benutzerdefinierte Conversions und
// Pixel-Diagnose. Legt bei Meta nur AN, ändert, archiviert oder löscht nie
// etwas (Svens Regel). Typen: ./typen.ts (identisch zu src/lib/werbeWerkzeuge.ts).
//
// Anfrage: POST { mode, ...felder } (WerkzeugRequestMap in typen.ts)
// Fehler:  { error, hint?, code?, data?, meta? } (code aus WERKZEUG_ERROR_CODES)
//
// ── Lese-Modi (Werbe-Recht reicht, requireAdsAccess) ──
//   { mode: 'audiences_list', sac_pruefen?, sac_land? }  Zielgruppen mit Größe, Verweildauer,
//       Regel in Deutsch, Housing-Eignung (höchstens 25 je Aufruf, Abbruch über 75 % Auslastung)
//   { mode: 'leadforms_list', page_id? }                Sofortformulare der Seite (Seiten-Token)
//   { mode: 'leadform_get', id, page_id? }              ein Formular als LeadFormSpecErweitert
//   { mode: 'custom_conversions_list', mit_archivierten? }
//   { mode: 'pixel_diagnose', pixel_id? }               letzter Empfang, Ereignisse 24 h, EMQ, Ampel
//
// ── Schreib-Modi (zusätzlich: admin/verwalter oder Recht „werbung“,
//    ad_settings.builder_enabled = true, Secret META_WRITES_DISABLED != 1;
//    mit vorschau: true nur Recht „werbung“, es geht nichts an Meta) ──
//   { mode: 'audience_create_website', name, pixel_id?, regeln[], verknuepfung?, tage 1-180, ausschluss_regeln?, ausschluss_tage? }
//   { mode: 'audience_create_engagement', name, quelle page|instagram|video|leadform, objekt_ids?, art, tage }
//   { mode: 'audience_create_lookalike', name, source_id, land, ratio 0.01-0.10, kontext? }
//       kontext fehlt oder 'housing' -> 422 housing_forbidden (Lookalikes unter Wohnen verboten)
//   { mode: 'audience_create_customer_list', name, quelle: 'crm', filter, confirm: true, label? }
//       NUR Admin UND ad_settings.kundenliste_freigegeben = true (Migration 20261004100000);
//       E-Mail/Telefon serverseitig normalisiert + SHA-256, nie im Log; ohne interne Kontakte
//       und ohne Widerspruch (communication_optouts, newsletter_optout_at); höchstens 10.000
//   { mode: 'leadform_create', page_id?, spec: LeadFormSpecErweitert }   Seiten-Token, Lint, Wohnen-Prüfung
//   { mode: 'leadform_duplicate', id, name, page_id?, wohnen? }          lesen + neu anlegen
//   { mode: 'custom_conversion_create', name, pixel_id?, ereignis? (Alias event), url_regeln?, kategorie, standardwert? }
//
// Jeder Meta-POST landet in meta_write_log (fn 'meta-werkzeuge'). Der Token steht
// nur im Authorization-Header und erscheint nie in Logs oder Antworten.
// validate_only nutzt diese Function bewusst nicht: Meta garantiert es für
// customaudiences, customconversions und leadgen_forms nicht (Gefahr echter
// Anlage). Geprüft wird lokal; vorschau: true zeigt den genauen Payload.
//
// ── Secrets (Supabase Dashboard -> Settings -> Edge Functions -> Secrets) ──
//   META_ACCESS_TOKEN     System-User-Token (ads_management, ads_read, pages_show_list,
//                         pages_manage_ads, pages_read_engagement, leads_retrieval)
//   META_AD_ACCOUNT_ID    Standard 4065490590399677
//   META_PAGE_ID          Standard 556440087559971
//   META_PIXEL_ID         Standard 1083578343946189
//   META_GRAPH_VERSION    optional (vNN.0), Standard v25.0
//   META_WRITES_DISABLED  1 = globaler Not-Aus für alle Schreibzugriffe an Meta
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (automatisch)
//
// ── Deployment ──
//   supabase functions deploy meta-werkzeuge --no-verify-jwt
//   (config.toml: [functions.meta-werkzeuge] verify_jwt = false; Guard requireAdsAccess im Code)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess } from '../_shared/adsAuth.ts'
import { makeCtx, schreibRecht, toErrorResponse, WerkzeugError, writeGate, type Ctx } from './common.ts'
import { modeCustomConversionCreate, modeCustomConversionsList, modePixelDiagnose } from './conversions.ts'
import { modeLeadformCreate, modeLeadformDuplicate, modeLeadformGet, modeLeadformsList } from './formulare.ts'
import { modeAudienceCreateCustomerList } from './kundenliste.ts'
import {
  WERKZEUG_MODES, WERKZEUG_WRITE_MODES,
  type AudienceCreateCustomerListRequest, type AudienceCreateEngagementRequest, type AudienceCreateLookalikeRequest,
  type AudienceCreateWebsiteRequest, type AudiencesListRequest, type CustomConversionCreateRequest,
  type CustomConversionsListRequest, type LeadformCreateWerkzeugRequest, type LeadformDuplicateRequest,
  type LeadformGetRequest, type LeadformsListRequest, type PixelDiagnoseRequest, type WerkzeugMode,
} from './typen.ts'
import {
  modeAudienceCreateEngagement, modeAudienceCreateLookalike, modeAudienceCreateWebsite, modeAudiencesList,
} from './zielgruppen.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const isMode = (m: string): m is WerkzeugMode => (WERKZEUG_MODES as readonly string[]).indexOf(m) >= 0

async function dispatch(ctx: Ctx, mode: WerkzeugMode, body: Record<string, unknown>): Promise<unknown> {
  const b = body as unknown
  switch (mode) {
    case 'audiences_list': return await modeAudiencesList(ctx, b as AudiencesListRequest)
    case 'audience_create_website': return await modeAudienceCreateWebsite(ctx, b as AudienceCreateWebsiteRequest)
    case 'audience_create_engagement': return await modeAudienceCreateEngagement(ctx, b as AudienceCreateEngagementRequest)
    case 'audience_create_lookalike': return await modeAudienceCreateLookalike(ctx, b as AudienceCreateLookalikeRequest)
    case 'audience_create_customer_list': return await modeAudienceCreateCustomerList(ctx, b as AudienceCreateCustomerListRequest)
    case 'leadforms_list': return await modeLeadformsList(ctx, b as LeadformsListRequest)
    case 'leadform_get': return await modeLeadformGet(ctx, b as LeadformGetRequest)
    case 'leadform_create': return await modeLeadformCreate(ctx, b as LeadformCreateWerkzeugRequest)
    case 'leadform_duplicate': return await modeLeadformDuplicate(ctx, b as LeadformDuplicateRequest)
    case 'custom_conversions_list': return await modeCustomConversionsList(ctx, b as CustomConversionsListRequest)
    case 'custom_conversion_create': return await modeCustomConversionCreate(ctx, b as CustomConversionCreateRequest)
    case 'pixel_diagnose': return await modePixelDiagnose(ctx, b as PixelDiagnoseRequest)
  }
  throw new WerkzeugError(400, 'invalid_request', `Unbekannter Modus "${String(mode)}".`)
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WerkzeugError(400, 'invalid_request', 'Anfrage ohne JSON-Body.')
    mode = String(body.mode ?? '')
    if (!isMode(mode)) {
      throw new WerkzeugError(400, 'invalid_request', `Unbekannter Modus "${mode.slice(0, 40)}".`, `Erlaubt: ${WERKZEUG_MODES.join(', ')}`)
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const ctx = makeCtx(sb, caller, mode)
    // vorschau nur bei genau true (einmal hier, damit Weiche und Modi gleich entscheiden:
    // {vorschau: 1} ist ein echter Aufruf mit allen Prüfungen)
    const vorschau = body.vorschau === true
    if (body.vorschau !== undefined) body.vorschau = vorschau
    if (WERKZEUG_WRITE_MODES.indexOf(mode) >= 0) {
      // vorschau sendet nichts an Meta: dann reicht das Schreibrecht
      const gate = vorschau ? await schreibRecht(ctx) : await writeGate(ctx)
      if (gate) throw gate
    }
    const result = await dispatch(ctx, mode, body)
    console.log(`[meta-werkzeuge] ${mode}${vorschau ? ' (vorschau)' : ''} ok in ${Date.now() - started} ms`)
    return json(result, 200)
  } catch (err) {
    const { status, body } = toErrorResponse(err)
    console.error(`[meta-werkzeuge] ${mode || '-'} ${status} ${body.code ?? ''}: ${body.error.slice(0, 300)}`)
    return json(body, status)
  }
})
