import type { TFunction } from 'i18next'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail, type FnErrorDetail } from '../../../../lib/fnError'
import type {
  BuilderMode, BuilderRequestMap, BuilderResponseMap, BuilderSettings, CatalogResponse,
} from '../../../../lib/metaSpec'

// ── Aufrufe der Edge Function meta-builder (Kampagnen-Assistent) ─────────────
// Typisiert über die Anfrage-/Antwort-Typen aus metaSpec.ts (gleiche Typen wie
// im Server). Netz-Wackler („Failed to send"): EIN automatischer zweiter
// Versuch. Fehler kommen als BuilderFehler mit message, hint, code und data
// (fnErrorDetail), damit das UI Metas eigene Meldung und den Hinweis zeigt.

const FN = 'meta-builder'

export class BuilderFehler extends Error {
  code?: string
  hint?: string
  data?: unknown
  meta?: unknown
  constructor(d: FnErrorDetail) {
    super(d.message)
    this.name = 'BuilderFehler'
    this.code = d.code
    this.hint = d.hint
    this.data = d.data
    this.meta = d.meta
  }
}

const NETZ_FEHLER = /Failed to send|Failed to fetch|NetworkError|Load failed/i
const warte = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Ein Modus von meta-builder. 200-Antworten mit { error: string } gelten als Fehler
 *  (create/resume melden Schrittfehler als Objekt in error und bleiben Antworten). */
export async function builderCall<M extends BuilderMode>(
  mode: M, req: BuilderRequestMap[M], retried = false,
): Promise<BuilderResponseMap[M]> {
  const { data, error } = await supabase.functions.invoke(FN, { body: { mode, ...req } })
  if (error) {
    if (!retried && NETZ_FEHLER.test(error.message ?? '')) {
      await warte(1500)
      return builderCall(mode, req, true)
    }
    throw new BuilderFehler(await fnErrorDetail(error))
  }
  const d = data as Record<string, unknown> | null
  if (d && typeof d === 'object' && typeof d.error === 'string' && d.error) {
    throw new BuilderFehler({
      message: d.error,
      ...(typeof d.hint === 'string' && d.hint ? { hint: d.hint } : {}),
      ...(typeof d.code === 'string' || typeof d.code === 'number' ? { code: String(d.code) } : {}),
      ...(d.data !== undefined ? { data: d.data } : {}),
    })
  }
  return data as BuilderResponseMap[M]
}

/** Fehlercode eines Aufrufs (BuilderFehler.code), sonst undefined */
export const fehlerCode = (e: unknown): string | undefined => (e instanceof BuilderFehler ? e.code : undefined)

/** Verständlicher Fehlertext für Toasts (Hinweis vor Rohmeldung, gekürzt). */
export function fehlerText(e: unknown, t: TFunction): string {
  const code = fehlerCode(e)
  const bekannt: Record<string, string> = {
    builder_disabled: t('crm.werbung.builder.fehler.builder_disabled', 'Anlegen bei Meta ist noch gesperrt: Freischaltung durch Sven ausstehend.'),
    writes_disabled: t('crm.werbung.builder.fehler.writes_disabled', 'Schreibzugriffe auf Meta sind gerade zentral gesperrt.'),
    forbidden: t('crm.werbung.builder.fehler.forbidden', 'Dafür fehlt dir das Recht.'),
    app_dev_mode: t('crm.werbung.builder.fehler.app_dev_mode', 'Die Meta-App steht noch im Entwicklungsmodus. Anzeigen lassen sich erst anlegen, wenn sie live ist.'),
    rate_limited: t('crm.werbung.builder.fehler.rate_limited', 'Meta bremst gerade (zu viele Anfragen). Bitte in ein paar Minuten noch einmal.'),
    guardrail_exceeded: t('crm.werbung.builder.fehler.guardrail_exceeded', 'Das Tageslimit des Werbekontos würde überschritten.'),
    lint_blocked: t('crm.werbung.builder.fehler.lint_blocked', 'Die Compliance-Prüfung hat Blocker gefunden.'),
    stale_validation: t('crm.werbung.builder.fehler.stale_validation', 'Die Prüfung bei Meta ist veraltet. Bitte neu prüfen.'),
    lease_busy: t('crm.werbung.builder.fehler.lease_busy', 'Dieser Entwurf wird gerade schon angelegt. Bitte kurz warten.'),
    media_not_ready: t('crm.werbung.builder.fehler.media_not_ready', 'Ein Video wird bei Meta noch verarbeitet. Bitte kurz warten.'),
  }
  let text = code && bekannt[code] ? bekannt[code] : ''
  if (e instanceof BuilderFehler) {
    const detail = e.hint || e.message
    if (!text) text = detail
    else if (e.hint && e.hint !== text) text = `${text} ${e.hint}`
  } else if (!text) {
    text = e instanceof Error ? e.message : String(e)
  }
  if (/Failed to send/i.test(text)) {
    text = t('crm.werbung.builder.fehler.netz', 'Der Aufruf kam nicht am Server an. Internet prüfen und ggf. den Werbeblocker für diese Seite ausschalten.')
  }
  return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

// ── Katalog (Seiten, Pixel, Formulare, DSA-Standard, Freischaltung) ──────────
// ~8 Meta-Abfragen auf dem Server: einmal je Sitzung laden, danach aus dem
// Zwischenspeicher. Fehler leeren den Speicher (nächstes Öffnen versucht neu).
let katalogCache: Promise<CatalogResponse> | null = null

export function ladeKatalog(refresh = false): Promise<CatalogResponse> {
  if (!katalogCache || refresh) {
    katalogCache = builderCall('catalog', refresh ? { refresh: true } : {}).catch(err => {
      katalogCache = null
      throw err
    })
  }
  return katalogCache
}

// ── Einstellungen aus ad_settings (ohne Meta-Aufruf) ─────────────────────────
// Freischaltung, DSA-Vorgaben, Standard-Seite/-Pixel/-Link und Tageslimit.
// Fehlt eine Spalte noch (Migration nicht eingespielt), kommt null zurück.
export async function ladeBuilderEinstellungen(): Promise<BuilderSettings | null> {
  try {
    const { data, error } = await supabase.from('ad_settings')
      .select('builder_enabled, dsa_beneficiary, dsa_payor, default_page_id, default_ig_user_id, default_pixel_id, default_link, max_account_daily_budget')
      .eq('id', 'default').maybeSingle()
    if (error || !data) return null
    const r = data as Record<string, unknown>
    const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return {
      builder_enabled: r.builder_enabled === true,
      dsa_beneficiary: s(r.dsa_beneficiary),
      dsa_payor: s(r.dsa_payor),
      default_page_id: s(r.default_page_id),
      default_ig_user_id: s(r.default_ig_user_id),
      default_pixel_id: s(r.default_pixel_id),
      default_link: s(r.default_link),
      max_account_daily_budget: r.max_account_daily_budget == null ? null : Number(r.max_account_daily_budget),
    }
  } catch (err) {
    console.warn('[Kampagnen] ad_settings nicht lesbar:', err)
    return null
  }
}

/** Vorgaben für neue Entwürfe: ad_settings überschreibt den Kontostandard. */
export interface BuilderVorgaben {
  builderEnabled: boolean | null
  pageId: string | null
  igUserId: string | null
  pixelId: string | null
  link: string | null
  dsaBeneficiary: string
  dsaPayor: string
  limitEur: number | null
}

export function vorgabenAus(settings: BuilderSettings | null, katalog: CatalogResponse | null): BuilderVorgaben {
  const ks = katalog?.settings ?? null
  const pick = <K extends keyof BuilderSettings>(k: K): BuilderSettings[K] | null => (ks?.[k] ?? settings?.[k] ?? null)
  const builderEnabled = ks ? ks.builder_enabled === true : settings ? settings.builder_enabled === true : null
  return {
    builderEnabled,
    pageId: pick('default_page_id'),
    igUserId: pick('default_ig_user_id') ?? katalog?.instagram_accounts?.[0]?.id ?? null,
    pixelId: pick('default_pixel_id'),
    link: pick('default_link'),
    dsaBeneficiary: pick('dsa_beneficiary') ?? katalog?.account?.default_dsa_beneficiary ?? '',
    dsaPayor: pick('dsa_payor') ?? katalog?.account?.default_dsa_payor ?? '',
    limitEur: pick('max_account_daily_budget'),
  }
}
