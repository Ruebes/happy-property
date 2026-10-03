// Edge Function: meta-builder
// Kampagnen-Assistent des Werbemanagers: baut Meta-Kampagnen, Anzeigengruppen
// und Anzeigen aus einem Entwurf (meta_drafts.spec = DraftSpec aus
// _shared/metaSpec.ts), prüft sie vorher bei Meta (validate_only) und legt sie
// wiederaufnehmbar an. ALLES wird PAUSED angelegt, nichts wird bei Meta gelöscht
// oder archiviert. Aktivieren ist ein eigener Modus mit Budget-Leitplanke.
//
// Anfrage: POST { mode, ...felder } (Typen: BuilderRequestMap in metaSpec.ts)
// Fehler:  { error, hint?, code?, data?, meta? } (code aus BUILDER_ERROR_CODES)
//
// ── Lese-Modi (Werbe-Recht reicht) ──
//   { mode: 'catalog' }                  Werbekonto (Währung, Zeitzone, DSA-Standard),
//       Pixel, benutzerdefinierte Conversions, Custom Audiences, Seiten, IG-Konten
//       (Standard: Seite 556440087559971 + ihr IG-Konto), Sofortformulare,
//       DSA-Vorschläge, Token-Rechte, Projekt-/Bauträgernamen für den Lint, Einstellungen
//   { mode: 'audience_eligibility', ids[<=10], countries? }  Housing-Eignung je Custom Audience
//   { mode: 'estimate', objective, adset }                    Reichweiten-Schätzung
//   { mode: 'creative_details', ad_ids[<=50] }               url_tags, Link, CTA + UTM-Prüfung
//   { mode: 'pixel_status', pixel_id }                        letzter Pixel-Empfang
//   { mode: 'leadgen_lookup', ids[<=100] }                    Lead -> Anzeige/Gruppe/Kampagne (ohne Personendaten)
//   { mode: 'usage' }                                         Meta-Rate-Limit-Auslastung
//   { mode: 'import', level, id }                             bestehendes Objekt als Entwurf
//   { mode: 'validate', draft_id, levels? }                   lokal + Lint + Meta validate_only
//       (Anzeigengruppen gegen Platzhalter-Kampagne, Anzeigen mit synchronous_ad_review;
//       höchstens 15 Meta-Aufrufe, Abbruch über 70 % Auslastung) -> meta_drafts.validation
//   { mode: 'media_status', id }                              Video-Verarbeitung bei Meta
//   { mode: 'discard', draft_id }                             Entwurf verwerfen (nur CRM)
//   { mode: 'edit_load', level, id, neu_laden? }              bestehendes Objekt zum Bearbeiten laden:
//       Entwurf kind 'edit' anlegen bzw. offenen wieder aufnehmen (Ausgangsstand in meta_ids.edit),
//       Antwort { draft_id, spec, locks, warnings, baseline_at, reused }
//   { mode: 'edit_diff', draft_id }                           „Das ändert sich bei Meta“: Änderungen je Feld
//       (Lernphase, gesperrt, Konflikt mit dem Live-Stand), Prüfung, Lint, Leitplanke. Schreibt nichts.
//
// ── Schreib-Modi (zusätzlich: admin/verwalter oder Recht „werbung“,
//    ad_settings.builder_enabled = true, Secret META_WRITES_DISABLED != 1) ──
//   { mode: 'media_upload', storage_path, kind, aspect, ai_generated, eu_band_confirmed, ki_label_confirmed }
//       Bild aus Bucket ad-creatives -> adimages (sha256-Dublettenschutz); Video -> advideos file_url
//   { mode: 'preview', draft_id, ad_key, formats[] }          generatepreviews (lädt fehlende Medien hoch)
//   { mode: 'create' | 'resume', draft_id, force_lint_reason?, housing_override_reason? }
//       Schritt-Läufer (~50 s je Aufruf; Client ruft resume, solange next != null):
//       Kampagne -> Anzeigengruppen -> Medien -> Creatives -> Anzeigen -> Rücklesen.
//       Voraussetzung: Prüfung (validate) jünger als 30 min und Inhalt unverändert.
//       Lint-Blocker darf nur ein Admin mit Begründung übergehen (force_lint_reason,
//       bei jedem resume erneut mitschicken; steht in jedem meta_write_log-Eintrag).
//       Neues in einer bestehenden Kampagne ohne HOUSING: 409 housing_required, außer
//       Admin mit housing_override_reason (mindestens 10 Zeichen, bei jedem resume erneut).
//       Schon Angelegtes im Entwurf entfernt/geändert (Fingerabdruck meta_ids.hashes):
//       409 created_changed. Fehler 1885183 (Meta-App im Entwicklungsmodus) -> Status partial.
//   { mode: 'activate_draft', draft_id, levels[], confirm: true }
//       nur Personen, nur Status created; Anzeigen -> Gruppen -> Kampagne, vorher budgetHeadroom;
//       nur Knoten, die noch im Entwurf stehen (Rest in skipped, bleibt pausiert)
//   { mode: 'duplicate', level, ids[], ziel: { art: original|vorhanden|neu, campaign_id?, adset_id? }, kopien 1-5, deep?,
//       housing_override_reason? }
//       POST /{id}/copies, alles PAUSED, Name + " - Kopie"; über 3 Anzeigen Ebene für Ebene (gedeckelt);
//       Kopie in Kampagne ohne HOUSING = 409 (Admin mit Begründung); Ziel neu nur aus einem Elternobjekt
//   { mode: 'edit_apply', draft_id, confirm: true, force_lint_reason?, housing_override_reason? }
//       nur Personen; nur geänderte, änderbare Felder an Meta (Targeting zusammengeführt + Wohnen-Regeln,
//       Werbemittel: hp.creative_tausch 'ersetzen' = neues Creative an die Anzeige, 'neue_anzeige' = neue
//       Anzeige + alte pausieren; ohne HOUSING nur Admin mit Begründung), Leitplanke einmal für alle
//       Erhöhungen, Budget max. 4x/Stunde je Objekt; nicht Übernommenes bleibt im Entwurf
//   { mode: 'bulk', items[{level,id}] (max. 50), patch: { status?, daily_budget_cents?, budget_prozent?,
//       end_time?, name_suffix? }, confirm: true }  Massenbearbeitung, Leitplanke einmal für alles
//   { mode: 'leadform_create', page_id?, spec }               Sofortformular (Seiten-Token, Höhere Absicht)
//
// Jeder Meta-POST (auch validate_only) landet in meta_write_log. Der Token steht
// nur im Authorization-Header und erscheint nie in Logs oder Antworten.
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
//   supabase functions deploy meta-builder --no-verify-jwt
//   (config.toml: [functions.meta-builder] verify_jwt = false; Guard requireAdsAccess im Code)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess } from '../_shared/adsAuth.ts'
import {
  BUILDER_MODES, BUILDER_WRITE_MODES,
  type ActivateDraftRequest, type AudienceEligibilityRequest, type BuilderMode, type BulkRequest, type CatalogRequest,
  type CreateRequest, type CreativeDetailsRequest, type DiscardRequest, type DuplicateRequest, type EditApplyRequest,
  type EditDiffRequest, type EditLoadRequest, type EstimateRequest,
  type ImportRequest, type LeadformCreateRequest, type LeadgenLookupRequest, type MediaStatusRequest,
  type MediaUploadRequest, type PixelStatusRequest, type PreviewRequest, type UsageRequest, type ValidateRequest,
} from '../_shared/metaSpec.ts'
import { BuilderError, makeCtx, toErrorResponse, writeGate, type Ctx } from './common.ts'
import {
  modeAudienceEligibility, modeCatalog, modeCreativeDetails, modeEstimate, modeLeadgenLookup, modePixelStatus, modeUsage,
} from './catalog.ts'
import { modeBulk } from './bulk.ts'
import { modeEditApply, modeEditDiff, modeEditLoad } from './edit.ts'
import { modeImport } from './importer.ts'
import { modeMediaStatus, modeMediaUpload } from './media.ts'
import { modeLeadformCreate } from './pages.ts'
import {
  modeActivateDraft, modeCreate, modeDiscard, modeDuplicate, modePreview, modeResume, modeValidate,
} from './steps.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const isMode = (m: string): m is BuilderMode => (BUILDER_MODES as readonly string[]).indexOf(m) >= 0

async function dispatch(ctx: Ctx, mode: BuilderMode, body: Record<string, unknown>): Promise<unknown> {
  const b = body as unknown
  switch (mode) {
    case 'catalog': return await modeCatalog(ctx, b as CatalogRequest)
    case 'audience_eligibility': return await modeAudienceEligibility(ctx, b as AudienceEligibilityRequest)
    case 'estimate': return await modeEstimate(ctx, b as EstimateRequest)
    case 'creative_details': return await modeCreativeDetails(ctx, b as CreativeDetailsRequest)
    case 'pixel_status': return await modePixelStatus(ctx, b as PixelStatusRequest)
    case 'leadgen_lookup': return await modeLeadgenLookup(ctx, b as LeadgenLookupRequest)
    case 'usage': return await modeUsage(ctx, b as UsageRequest)
    case 'validate': return await modeValidate(ctx, b as ValidateRequest)
    case 'import': return await modeImport(ctx, b as ImportRequest)
    case 'media_status': return await modeMediaStatus(ctx, b as MediaStatusRequest)
    case 'discard': return await modeDiscard(ctx, b as DiscardRequest)
    case 'preview': return await modePreview(ctx, b as PreviewRequest)
    case 'media_upload': return await modeMediaUpload(ctx, b as MediaUploadRequest)
    case 'create': return await modeCreate(ctx, b as CreateRequest)
    case 'resume': return await modeResume(ctx, b as CreateRequest)
    case 'activate_draft': return await modeActivateDraft(ctx, b as ActivateDraftRequest)
    case 'duplicate': return await modeDuplicate(ctx, b as DuplicateRequest)
    case 'leadform_create': return await modeLeadformCreate(ctx, b as LeadformCreateRequest)
    case 'edit_load': return await modeEditLoad(ctx, b as EditLoadRequest)
    case 'edit_diff': return await modeEditDiff(ctx, b as EditDiffRequest)
    case 'edit_apply': return await modeEditApply(ctx, b as EditApplyRequest)
    case 'bulk': return await modeBulk(ctx, b as BulkRequest)
  }
  throw new BuilderError(400, 'invalid_request', `Unbekannter Modus "${String(mode)}".`)
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BuilderError(400, 'invalid_request', 'Anfrage ohne JSON-Body.')
    mode = String(body.mode ?? '')
    if (!isMode(mode)) {
      throw new BuilderError(400, 'invalid_request', `Unbekannter Modus "${mode.slice(0, 40)}".`, `Erlaubt: ${BUILDER_MODES.join(', ')}`)
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const ctx = makeCtx(sb, caller, mode)
    if (BUILDER_WRITE_MODES.indexOf(mode) >= 0) {
      const gate = await writeGate(ctx)
      if (gate) throw gate
    }
    const result = await dispatch(ctx, mode, body)
    console.log(`[meta-builder] ${mode} ok in ${Date.now() - started} ms`)
    return json(result, 200)
  } catch (err) {
    const { status, body } = toErrorResponse(err)
    console.error(`[meta-builder] ${mode || '-'} ${status} ${body.code ?? ''}: ${body.error.slice(0, 300)}`)
    return json(body, status)
  }
})
