// Edge Function: meta-konto
// Werbemanager, Reiter „Messung & Konto“ und „Kommentare“: Werbekonto lesen
// (Status, Ausgaben, Ausgabenlimit, Zahlungsquelle verkürzt, DSA, kontoweite
// Einschränkungen, Markenschutz, Blocklisten), Ausgabenlimit des Kontos ändern
// (nur Admin), Kommentare unter Anzeigen-Beiträgen (Facebook + Instagram) lesen,
// beantworten und aus-/einblenden. Löscht nie etwas bei Meta (Svens Regel).
// Typen: ./typen.ts (identisch zu src/lib/werbeKonto.ts).
//
// Anfrage: POST { mode, ...felder } (KontoRequestMap in typen.ts)
// Fehler:  { error, hint?, code?, data?, meta? } (code aus KONTO_ERROR_CODES)
//
// ── Lese-Modi (Werbe-Recht reicht, requireAdsAccess) ──
//   { mode: 'konto' }   Konto-Übersicht inkl. darf_limit_aendern / darf_kommentare mit Grund
//   { mode: 'kommentare_list', ad_ids?, since?, nur_unbeantwortet?, plattform?, max_beitraege? }
//       Kommentare unter den Beiträgen der Anzeigen (aktive zuerst, höchstens 60 Beiträge,
//       Abbruch über 75 % Meta-Auslastung). Von Kommentierenden nur der Name.
//
// ── Schreib-Modi (zusätzlich: admin/verwalter oder Recht „werbung“,
//    ad_settings.builder_enabled = true, Secret META_WRITES_DISABLED != 1) ──
//   { mode: 'konto_ausgabenlimit', spend_cap_cents | entfernen: true, confirm: true, vorschau? }
//       NUR Admin. Höchstens 10 Änderungen in 24 h (Meta-Grenze, gezählt in meta_write_log).
//       Prüft danach per Lesen, ob Meta das Limit wie gewollt übernommen hat.
//   { mode: 'kommentar_antworten', comment_id, plattform, text, confirm: true, beitrag_id? }
//       Nur per Klick (kein System-Aufruf). Text-Prüfung mit metaLint: Gedankenstriche,
//       ae/oe/ue-Ersatz, Projekt-/Bauträgernamen, Rendite-Prozente, Finanzierungs- und
//       Garantieversprechen blockieren; Doppelklick-Schutz 2 Minuten (Reservierung im
//       meta_write_log vor dem Senden).
//   { mode: 'kommentar_ausblenden', comment_id, plattform, hide: boolean, beitrag_id? }
//
// Jeder Meta-POST landet in meta_write_log (fn 'meta-konto'). Tokens (System-User
// und Seite) stehen nur im Authorization-Header und erscheinen nie in Logs oder
// Antworten. Kommentartexte und Namen erscheinen nie in Logs.
//
// ── Secrets (Supabase Dashboard -> Settings -> Edge Functions -> Secrets) ──
//   META_ACCESS_TOKEN     System-User-Token (ads_read, ads_management, business_management,
//                         pages_show_list, pages_read_engagement, pages_manage_engagement,
//                         instagram_basic, instagram_manage_comments)
//   META_AD_ACCOUNT_ID    Standard 4065490590399677
//   META_PAGE_ID          Standard 556440087559971 (ad_settings.default_page_id hat Vorrang)
//   META_GRAPH_VERSION    optional (vNN.0), Standard v25.0
//   META_WRITES_DISABLED  1 = globaler Not-Aus für alle Schreibzugriffe an Meta
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (automatisch)
//
// ── Deployment ──
//   supabase functions deploy meta-konto --no-verify-jwt
//   (config.toml: [functions.meta-konto] verify_jwt = false; Guard requireAdsAccess im Code)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess } from '../_shared/adsAuth.ts'
import { KontoError, makeCtx, toErrorResponse, writeGate, type Ctx } from './common.ts'
import { modeKommentarAntworten, modeKommentarAusblenden, modeKommentareList } from './kommentare.ts'
import { modeKonto, modeKontoAusgabenlimit } from './konto.ts'
import {
  KONTO_MODES, KONTO_WRITE_MODES,
  type KommentarAntwortenRequest, type KommentarAusblendenRequest, type KommentareListRequest,
  type KontoAbrufRequest, type KontoAusgabenlimitRequest, type KontoMode,
} from './typen.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const isMode = (m: string): m is KontoMode => (KONTO_MODES as readonly string[]).indexOf(m) >= 0

async function dispatch(ctx: Ctx, mode: KontoMode, body: Record<string, unknown>): Promise<unknown> {
  const b = body as unknown
  switch (mode) {
    case 'konto': return await modeKonto(ctx, b as KontoAbrufRequest)
    case 'konto_ausgabenlimit': return await modeKontoAusgabenlimit(ctx, b as KontoAusgabenlimitRequest)
    case 'kommentare_list': return await modeKommentareList(ctx, b as KommentareListRequest)
    case 'kommentar_antworten': return await modeKommentarAntworten(ctx, b as KommentarAntwortenRequest)
    case 'kommentar_ausblenden': return await modeKommentarAusblenden(ctx, b as KommentarAusblendenRequest)
  }
  throw new KontoError(400, 'invalid_request', `Unbekannter Modus "${String(mode)}".`)
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KontoError(400, 'invalid_request', 'Anfrage ohne JSON-Body.')
    mode = String(body.mode ?? '')
    if (!isMode(mode)) {
      throw new KontoError(400, 'invalid_request', `Unbekannter Modus "${mode.slice(0, 40)}".`, `Erlaubt: ${KONTO_MODES.join(', ')}`)
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const ctx = makeCtx(sb, caller, mode)
    if (KONTO_WRITE_MODES.indexOf(mode) >= 0) {
      // Ausgabenlimit mit vorschau: true sendet nichts; Admin-Prüfung folgt im Modus
      const nurVorschau = mode === 'konto_ausgabenlimit' && body.vorschau === true
      if (!nurVorschau) {
        const gate = await writeGate(ctx)
        if (gate) throw gate
      }
    }
    const result = await dispatch(ctx, mode, body)
    console.log(`[meta-konto] ${mode} ok in ${Date.now() - started} ms`)
    return json(result, 200)
  } catch (err) {
    const { status, body } = toErrorResponse(err)
    console.error(`[meta-konto] ${mode || '-'} ${status} ${body.code ?? ''}: ${body.error.slice(0, 300)}`)
    return json(body, status)
  }
})
