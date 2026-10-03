// Edge Function: meta-berichte
// Berichte für die Kampagnen-Zentrale des Werbemanagers (SPEC2 Vertrag 2): Kennzahlen
// mit Aufschlüsselungen und Zeitvergleich, Aktivitätenverlauf, Live-Status mit
// Lernphase, Metas Empfehlungen. NUR LESEND gegenüber Meta (ausschließlich GET über
// _shared/metaGraph.ts); schreibt nur in den eigenen Zwischenspeicher meta_report_cache.
//
// Anfrage: POST { mode, ...felder } (Typen: ./types.ts, fürs Frontend spiegelbar)
// Fehler:  { error, hint?, code?, meta? } (code aus BERICHTE_ERROR_CODES)
//
// ── Modi (Guard requireAdsAccess, dazu Recht werbung oder werbung_meta: pruefeMetaRecht) ──
//   { mode: 'insights', level, ids?, campaign_id?, since, until, compare?: {since, until},
//     breakdowns?: [...], time_increment?: 1|7|'monthly'|'all_days',
//     felder?: 'standard'|'video'|'gebote', ergebnis?: 'leads'|'schedule'|..., frisch? }
//       -> { rows, compare_rows?, totals, compare_totals?, vergleich?, cached, fetched_at, ... }
//       Zahlen normalisiert (Strings -> Zahlen), actions -> leads, schedule,
//       landing_page_view, video_view, thruplay, link_click, outbound_click; CTR, CPM,
//       Frequenz, Kosten pro Ergebnis; spend in USD + spend_eur (wechselkurs).
//   { mode: 'activities', since, until, object_id?, frisch? }
//       -> { items: [{ ts, actor, object_type, object_id, object_name, event, extra, ... }] }
//       act_X/activities + meta_write_log zusammengeführt.
//   { mode: 'status', ids[<=100], level?, frisch? }
//       -> { items: [{ id, effective_status, configured_status, auslieferung,
//            learning: { status, conversions, last_sig_edit_ts }, issues, review_feedback }] }
//   { mode: 'empfehlungen', object_ids?, frisch? }
//       -> { opportunity_score, items: [...] }  (leer, wenn die API nichts liefert)
//
// Zwischenspeicher meta_report_cache (Migration 20261004100000_werbe_paritaet_r1.sql):
// 1 h für vergangene Zeiträume, 15 min wenn der Zeitraum heute enthält, 5 min für
// Status. Fehlt die Tabelle, läuft alles ohne Zwischenspeicher. Rate-Limit: über 75 %
// Meta-Auslastung keine weiteren Abrufe (Paging-Stopp, Drossel-Marke für folgende
// Aufrufe); dann ältere Stände (veraltet: true) oder Spiegel-Daten statt eines Fehlers.
//
// ── Secrets (Supabase Dashboard -> Settings -> Edge Functions -> Secrets) ──
//   META_ACCESS_TOKEN     System-User-Token (ads_read reicht)
//   META_AD_ACCOUNT_ID    Standard 4065490590399677
//   META_GRAPH_VERSION    optional (vNN.0), Standard v25.0
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (automatisch)
//   META_WRITES_DISABLED  ohne Wirkung (diese Function schreibt nie an Meta)
//
// ── Deployment ──
//   supabase functions deploy meta-berichte --no-verify-jwt
//   (config.toml: [functions.meta-berichte] verify_jwt = false; Guard requireAdsAccess im Code)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess } from '../_shared/adsAuth.ts'
import { BerichtError, FN, makeCtx, pruefeMetaRecht, toErrorResponse, type Ctx } from './common.ts'
import { modeActivities } from './activities.ts'
import { modeEmpfehlungen } from './empfehlungen.ts'
import { modeInsights } from './insights.ts'
import { modeStatus } from './status.ts'
import { BERICHTE_MODES, type BerichteMode } from './types.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const isMode = (m: string): m is BerichteMode => (BERICHTE_MODES as readonly string[]).indexOf(m) >= 0

async function dispatch(ctx: Ctx, body: Record<string, unknown>): Promise<unknown> {
  switch (ctx.mode) {
    case 'insights': return await modeInsights(ctx, body)
    case 'activities': return await modeActivities(ctx, body)
    case 'status': return await modeStatus(ctx, body)
    case 'empfehlungen': return await modeEmpfehlungen(ctx, body)
  }
  throw new BerichtError(400, 'invalid_request', `Unbekannter Modus "${String(ctx.mode)}".`)
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BerichtError(400, 'invalid_request', 'Anfrage ohne JSON-Body.')
    mode = String(body.mode ?? '')
    if (!isMode(mode)) {
      throw new BerichtError(400, 'invalid_request', `Unbekannter Modus "${mode.slice(0, 40)}".`, `Erlaubt: ${BERICHTE_MODES.join(', ')}`)
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Werbe-Recht allein reicht nicht: Meta-Daten nur mit werbung oder werbung_meta
    await pruefeMetaRecht(sb, caller)
    const result = await dispatch(makeCtx(sb, caller, mode), body)
    console.log(`[${FN}] ${mode} ok in ${Date.now() - started} ms`)
    return json(result, 200)
  } catch (err) {
    const { status, body } = toErrorResponse(err)
    console.error(`[${FN}] ${mode || '-'} ${status} ${body.code ?? ''}: ${body.error.slice(0, 300)}`)
    return json(body, status)
  }
})
