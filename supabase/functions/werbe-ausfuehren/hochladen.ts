// werbe-ausfuehren, Modus 'hochladen': ein freigegebenes Werbemittel aus dem Vorrat
// (ad_creative_pool) als PAUSIERTE Anzeige(n) bei Meta anlegen.
//
// Ablauf (PLAN-B §3/§4 Schritt 5):
//   1 Recht (darfSchreiben), META_WRITES_DISABLED, Vorrat-Zeile mit status 'freigegeben'
//     (bereits 'hochgeladen' -> vorhandene IDs zurück, nichts doppelt).
//   2 Inhalt: nur Format 'bild', 1 oder 2 Ziel-Anzeigengruppen (ziel_adset_ids), Texte aus
//     texte {primaer[], ueberschriften[], beschreibungen[]}, CTA (Standard BOOK_NOW, nur
//     Website-CTAs), letzte Text-Prüfung mit metaLint (Blocker -> abbrechen).
//   3 Ziele live bei Meta: Anzeigengruppe + Kampagne gehören zu unserem Konto, Kampagne hat
//     special_ad_categories HOUSING, nichts gelöscht/archiviert. Platzierungen der Gruppe
//     bestimmen die Medien-Regeln (asset_feed_spec PLACEMENT: 4:5 Feeds, 9:16 Stories/Reels).
//   4 Bilder NUR aus unserem öffentlichen Supabase-Storage laden (asset_feed_url,
//     asset_story_url), per uploadImage in die Bildbibliothek; Hashes sofort am Vorrat
//     speichern (ein zweiter Versuch lädt nicht doppelt hoch).
//   5 Creative mit metaSpec.buildCreativePayload (url_tags Standard, alle Advantage+-
//     Funktionen OPT_OUT, contextual_multi_ads OPT_OUT, instagram_user_id, CTA mit
//     value.link) und Anzeige mit buildAdPayload (immer PAUSED).
//   6 ZUERST validate_only für Creative und Anzeige je Gruppe. Fehler 1885183 ->
//     { error: 'app_dev_mode', hint: 'Meta-App muss Live sein' }. Mit nur_validieren: true
//     endet der Lauf hier (die Bilder liegen dann schon in der Bildbibliothek, harmlos).
//   7 Anlegen je Gruppe: Creative, Anzeige (PAUSED), Rücklesen. Fortschritt nach jeder
//     Anzeige am Vorrat (meta_ad_ids {adset_id: ad_id}), damit ein erneuter Aufruf nur die
//     fehlenden Gruppen anlegt. Danach Vorrat -> 'hochgeladen', ad_catalog (PAUSED),
//     studio_prepared_ads, ad_autopilot_log. Jeder Meta-Aufruf steht in meta_write_log.
//
// Namen: eine Gruppe -> <kennung>; zwei Gruppen -> <kennung>_lang / <kennung>_kurz (aus dem
// Gruppennamen „Lang"/„Kurz", sonst Reihenfolge der ziel_adset_ids).
// Ziel-Link: lp_url des Vorrats (sonst ad_settings.default_link). Ist lp_url eine der beiden
// Plan-B-Seiten, bekommt _lang die lange und _kurz die kompakte Seite (wie TEMPLATES.plan_b).
// meta_creative_id = Creative der ersten Anzeige; das Creative jeder Anzeige steht in
// ad_catalog.creative_id.
// Nie: löschen, archivieren, aktivieren. Aktivieren macht der Autopilot (R1/R2) bzw. ein Mensch.

import type { Caller } from '../_shared/callerAuth.ts'
import {
  getLastUsage, graphGet, graphPost, logMetaWrite, metaEnv, metaErrorLogFelder, metaWritesDisabled,
  MetaApiError, uploadImage, URL_TAGS_STANDARD, type MetaWriteLogRow,
} from '../_shared/metaGraph.ts'
import {
  type AdDraft, buildAdPayload, buildCreativePayload, CTA_WEBSITE, type CtaType, FACEBOOK_POSITIONS,
  type FacebookPosition, HP_DEFAULT_LINK, HP_PAGE_ID, INSTAGRAM_POSITIONS, type InstagramPosition,
  PLAN_B_LP_KURZ, PLAN_B_LP_LANG, type Placements, PUBLISHER_PLATFORMS, type PublisherPlatform, cleanName,
} from '../_shared/metaSpec.ts'
import { type LintIssue, lintAd, lintHasBlockers } from '../_shared/metaLint.ts'
import { akteurVon, darfSchreiben, digits, errMsg, fehler, json, type Sb } from './gemeinsam.ts'

const FN = 'werbe-ausfuehren'
const MAX_BILD_BYTES = 30 * 1024 * 1024
const BILD_TIMEOUT_MS = 60_000

interface PoolZeile {
  id: string
  kennung: string
  status: string
  format: string | null
  cta: string | null
  lp_url: string | null
  texte: Record<string, unknown> | null
  asset_feed_url: string | null
  asset_story_url: string | null
  ki_generiert: boolean | null
  ki_label: boolean | null
  eu_band: boolean | null
  housing_ok: boolean | null
  qa: Record<string, unknown> | null
  ziel_adset_ids: string[] | null
  meta_image_hashes: Record<string, unknown> | null
  meta_creative_id: string | null
  meta_ad_ids: Record<string, unknown> | null
}

interface Ziel {
  adsetId: string
  adsetName: string
  campaignId: string
  campaignName: string
  placements: Placements | undefined
  suffix: 'lang' | 'kurz' | null
  name: string
  link: string
}

interface Angelegt { adset_id: string; ad_id: string; creative_id: string; name: string; link: string; effective_status: string | null }

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** texte-Feld robust lesen (Array, einzelner String oder alternative Schlüssel). */
function textListe(t: Record<string, unknown> | null, keys: string[]): string[] {
  for (const k of keys) {
    const v = t?.[k]
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
    const out = arr.map(x => String(x ?? '').trim()).filter(Boolean)
    if (out.length) return out.slice(0, 5)
  }
  return []
}

const ohneSlash = (u: string) => u.trim().replace(/\/+$/, '')
const istPlanBLp = (u: string) => [PLAN_B_LP_LANG, PLAN_B_LP_KURZ].map(ohneSlash).includes(ohneSlash(u))

function suffixAusName(name: string): 'lang' | 'kurz' | null {
  const n = name.toLowerCase()
  if (/(^|[^a-zäöü])lang([^a-zäöü]|$)/.test(n)) return 'lang'
  if (/(^|[^a-zäöü])kurz([^a-zäöü]|$)/.test(n)) return 'kurz'
  return null
}

function placementsAus(t: Record<string, unknown> | null): Placements | undefined {
  const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  const pp = liste(t?.publisher_platforms)
  if (!pp.length) return undefined // Advantage+-Platzierungen
  const plattformen = pp.filter((p): p is PublisherPlatform => (PUBLISHER_PLATFORMS as readonly string[]).includes(p))
  const fb = liste(t?.facebook_positions).filter((p): p is FacebookPosition => (FACEBOOK_POSITIONS as readonly string[]).includes(p))
  const ig = liste(t?.instagram_positions).filter((p): p is InstagramPosition => (INSTAGRAM_POSITIONS as readonly string[]).includes(p))
  return { mode: 'manual', publisher_platforms: plattformen, facebook_positions: fb, instagram_positions: ig }
}

/** Nur https-Dateien aus dem öffentlichen Storage DIESES Projekts (kein fremder Server, kein Redirect). */
async function ladeBild(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  const basis = new URL(Deno.env.get('SUPABASE_URL') ?? 'https://invalid.local')
  let u: URL
  try { u = new URL(url) } catch { throw new Error('Bild-URL ungültig') }
  if (u.protocol !== 'https:' || u.host !== basis.host || !u.pathname.startsWith('/storage/v1/object/public/')) {
    throw new Error('Bilder werden nur aus dem eigenen öffentlichen Supabase-Storage geladen')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), BILD_TIMEOUT_MS)
  try {
    const r = await fetch(u.toString(), { redirect: 'error', signal: ctrl.signal })
    if (!r.ok) throw new Error(`Bild laden: HTTP ${r.status}`)
    const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!type.startsWith('image/')) throw new Error(`Bild laden: kein Bild (${type || 'ohne Content-Type'})`)
    const len = Number(r.headers.get('content-length') ?? '0')
    if (len > MAX_BILD_BYTES) throw new Error('Bild größer als 30 MB')
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (!bytes.byteLength) throw new Error('Bild ist leer')
    if (bytes.byteLength > MAX_BILD_BYTES) throw new Error('Bild größer als 30 MB')
    return { bytes, type }
  } finally {
    clearTimeout(timer)
  }
}

function actorKind(c: Caller): MetaWriteLogRow['actor_kind'] {
  return c.kind === 'user' ? 'user' : c.kind === 'service' ? 'autopilot' : 'system'
}

async function apLog(sb: Sb, z: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await sb.from('ad_autopilot_log').insert(z)
    if (error) console.warn('[werbe-ausfuehren] ad_autopilot_log:', String(error.message ?? error).slice(0, 200))
  } catch (err) {
    console.warn('[werbe-ausfuehren] ad_autopilot_log:', errMsg(err))
  }
}

async function poolSpeichern(sb: Sb, id: string, patch: Record<string, unknown>): Promise<string | null> {
  const { error } = await sb.from('ad_creative_pool').update(patch).eq('id', id)
  if (error) {
    const msg = String(error.message ?? error).slice(0, 300)
    console.error('[werbe-ausfuehren] Vorrat speichern:', msg)
    return msg
  }
  return null
}

/** Meta-Fehler als Antwort; Entwicklungsmodus der App mit eigenem Code. */
function metaFehlerAntwort(err: unknown, wobei: string, extra: Record<string, unknown> = {}): Response {
  if (err instanceof MetaApiError) {
    if (err.kind === 'dev_mode') {
      return json({ success: false, error: 'app_dev_mode', hint: 'Meta-App muss Live sein', code: 'app_dev_mode', wobei, meta: err.detail(), ...extra }, 409)
    }
    if (err.userMsg === 'META_WRITES_DISABLED') {
      return json({ success: false, error: 'Schreibzugriffe an Meta sind gesperrt (META_WRITES_DISABLED)', code: 'META_WRITES_DISABLED', wobei, ...extra }, 503)
    }
    const status = err.kind === 'validation' || err.kind === 'permission' ? 422 : err.kind === 'rate_limit' ? 429 : 502
    return json({
      success: false, error: `${wobei}: ${err.userMsg ?? err.message}`.slice(0, 400), code: err.kind === 'validation' ? 'meta_validierung' : `meta_${err.kind}`,
      blame: err.blame, meta: err.detail(), wobei, ...extra,
    }, status)
  }
  return json({ success: false, error: `${wobei}: ${errMsg(err)}`.slice(0, 400), wobei, ...extra }, 500)
}

export async function hochladen(sb: Sb, caller: Caller, body: Record<string, unknown>): Promise<Response> {
  if (!darfSchreiben(caller)) return fehler(403, 'Hochladen dürfen nur Admin oder Nutzer mit dem Recht Werbung')
  const poolId = String(body.pool_id ?? '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(poolId)) return fehler(400, 'pool_id fehlt oder ist ungültig')
  const nurValidieren = body.nur_validieren === true
  if (metaWritesDisabled()) {
    return fehler(503, 'Schreibzugriffe an Meta sind gesperrt (META_WRITES_DISABLED)', { code: 'META_WRITES_DISABLED' })
  }
  const env = metaEnv()
  if (!env.token) return fehler(500, 'META_ACCESS_TOKEN fehlt (Supabase Secrets)')
  const akteur = akteurVon(caller)
  const kind = actorKind(caller)
  const laufId = crypto.randomUUID()

  // 1 Vorrat-Zeile
  const { data: p0, error: pErr } = await sb.from('ad_creative_pool').select('*').eq('id', poolId).maybeSingle()
  if (pErr) return fehler(500, `Vorrat lesen: ${String(pErr.message ?? pErr)}`)
  const pool = p0 as PoolZeile | null
  if (!pool) return fehler(404, 'Werbemittel nicht gefunden')
  if (pool.status === 'hochgeladen') {
    return json({ success: true, bereits_hochgeladen: true, pool_id: pool.id, meta_ad_ids: pool.meta_ad_ids ?? {}, meta_creative_id: pool.meta_creative_id })
  }
  if (pool.status !== 'freigegeben') return fehler(409, `Hochladen geht nur aus dem Status freigegeben (jetzt: ${pool.status})`)

  // 2 Inhalt
  if (pool.format && pool.format !== 'bild') return fehler(422, 'Automatisch hochladen geht bisher nur für Bild-Werbemittel')
  if (pool.housing_ok === false) return fehler(409, 'Die Prüfung „Sonderkategorie Wohnen“ ist für dieses Werbemittel fehlgeschlagen')
  const adsetIds = [...new Set((pool.ziel_adset_ids ?? []).map(digits).filter(Boolean))]
  if (adsetIds.length < 1 || adsetIds.length > 2) return fehler(422, 'Bitte 1 oder 2 Ziel-Anzeigengruppen angeben (ziel_adset_ids)')
  const texte = obj(pool.texte)
  const primaer = textListe(texte, ['primaer', 'primary_texts', 'bodies'])
  const ueberschriften = textListe(texte, ['ueberschriften', 'headlines', 'titles'])
  const beschreibungen = textListe(texte, ['beschreibungen', 'descriptions'])
  if (!primaer.length || !ueberschriften.length) return fehler(422, 'Primärtext und Überschrift fehlen im Werbemittel')
  const cta = String(pool.cta ?? 'BOOK_NOW').trim().toUpperCase() as CtaType
  if (!CTA_WEBSITE.includes(cta)) return fehler(422, `Button "${cta}" passt nicht zu einer Website-Anzeige`)
  if (!pool.asset_feed_url) return fehler(422, 'Feed-Bild (4:5) fehlt')
  const kennung = cleanName(pool.kennung, 80).replace(/\s+/g, '-')
  if (!kennung) return fehler(422, 'Kennung fehlt')
  const warnungen: string[] = []
  if (!pool.asset_story_url) warnungen.push('Kein Story-Bild (9:16): Stories und Reels zeigen das Feed-Bild')

  // Einstellungen
  const { data: s0, error: sErr } = await sb.from('ad_settings')
    .select('default_page_id, default_ig_user_id, default_link').eq('id', 'default').maybeSingle()
  if (sErr) return fehler(500, `ad_settings lesen: ${String(sErr.message ?? sErr)}`)
  const st = (s0 ?? {}) as { default_page_id?: string | null; default_ig_user_id?: string | null; default_link?: string | null }
  const pageId = digits(st.default_page_id) || env.pageId || HP_PAGE_ID
  const lpBasis = (pool.lp_url ?? '').trim() || (st.default_link ?? '').trim() || HP_DEFAULT_LINK
  if (!/^https:\/\//i.test(lpBasis)) return fehler(422, 'Ziel-Link muss mit https:// beginnen')

  // 3 Ziele live prüfen
  const ziele: Ziel[] = []
  const kampagnen = new Map<string, { name: string }>()
  try {
    for (const adsetId of adsetIds) {
      const a = await graphGet<Record<string, unknown>>(adsetId, { fields: 'account_id,name,campaign_id,effective_status,targeting' })
      if (digits(a.account_id) !== env.account) return fehler(403, `Anzeigengruppe ${adsetId} gehört nicht zu unserem Werbekonto`)
      const es = String(a.effective_status ?? '')
      if (['DELETED', 'ARCHIVED'].includes(es)) return fehler(409, `Anzeigengruppe ${adsetId} ist ${es}`)
      const campaignId = digits(a.campaign_id)
      if (!campaignId) return fehler(409, `Kampagne der Anzeigengruppe ${adsetId} unbekannt`)
      if (!kampagnen.has(campaignId)) {
        const c = await graphGet<Record<string, unknown>>(campaignId, { fields: 'account_id,name,special_ad_categories,effective_status' })
        if (digits(c.account_id) !== env.account) return fehler(403, `Kampagne ${campaignId} gehört nicht zu unserem Werbekonto`)
        const cats = Array.isArray(c.special_ad_categories) ? c.special_ad_categories.map(String) : []
        if (!cats.includes('HOUSING')) {
          return fehler(409, `Kampagne „${String(c.name ?? campaignId)}“ hat nicht die Sonderkategorie Wohnen (HOUSING)`, { code: 'kein_housing' })
        }
        const ces = String(c.effective_status ?? '')
        if (['DELETED', 'ARCHIVED'].includes(ces)) return fehler(409, `Kampagne ${campaignId} ist ${ces}`)
        kampagnen.set(campaignId, { name: String(c.name ?? '') })
      }
      ziele.push({
        adsetId, adsetName: String(a.name ?? ''), campaignId, campaignName: kampagnen.get(campaignId)!.name,
        placements: placementsAus(obj(a.targeting)), suffix: null, name: kennung, link: lpBasis,
      })
    }
  } catch (err) {
    return metaFehlerAntwort(err, 'Ziel-Anzeigengruppe prüfen')
  }

  // Namen + Links
  if (ziele.length === 2) {
    const s = ziele.map(z => suffixAusName(z.adsetName))
    const eindeutig = s[0] && s[1] && s[0] !== s[1]
    ziele[0].suffix = eindeutig ? s[0] : 'lang'
    ziele[1].suffix = eindeutig ? s[1] : 'kurz'
    if (!eindeutig) warnungen.push('Gruppennamen ohne eindeutiges „Lang“/„Kurz“: Reihenfolge der Ziel-Gruppen entscheidet')
    for (const z of ziele) {
      z.name = `${kennung}_${z.suffix}`
      if (istPlanBLp(lpBasis)) z.link = z.suffix === 'lang' ? PLAN_B_LP_LANG : PLAN_B_LP_KURZ
    }
  }

  // Letzte Text-Prüfung (Projektnamen, Gedankenstriche, Längen, AfA-Pflichtsatz)
  const namen: string[] = []
  {
    const { data: projs, error: prErr } = await sb.from('crm_projects').select('name, developer').limit(2000)
    if (prErr) return fehler(500, `Projektnamen lesen: ${String(prErr.message ?? prErr)}`)
    for (const r of (projs ?? []) as Array<{ name?: string | null; developer?: string | null }>) {
      for (const n of [r.name, r.developer]) if (n && n.trim().length >= 3 && !namen.includes(n.trim())) namen.push(n.trim())
    }
  }
  const feedMediaId = `pool:${pool.id}:feed`
  const storyMediaId = `pool:${pool.id}:story`
  const lintMedia = {
    ai_generated: pool.ki_generiert === true,
    eu_band_confirmed: pool.eu_band === true,
    ki_label_confirmed: pool.ki_label === true || pool.ki_generiert !== true,
  }
  const issues: LintIssue[] = []
  for (const z of ziele) {
    issues.push(...lintAd({
      key: z.name, name: z.name, primary_texts: primaer, headlines: ueberschriften, descriptions: beschreibungen,
      destination: { kind: 'website', url: z.link },
      media: {
        feed_4x5: { media_id: feedMediaId },
        ...(pool.asset_story_url ? { story_9x16: { media_id: storyMediaId } } : {}),
      },
    }, {
      forbiddenNames: namen,
      media: {
        [feedMediaId]: { ...lintMedia, public_url: pool.asset_feed_url },
        ...(pool.asset_story_url ? { [storyMediaId]: { ...lintMedia, public_url: pool.asset_story_url } } : {}),
      },
    }))
  }
  if (lintHasBlockers(issues)) {
    return fehler(422, 'Text-Prüfung hat Blocker gefunden, bitte das Werbemittel korrigieren', {
      code: 'lint_blocker', lint: issues.filter(i => i.severity === 'blocker'),
    })
  }

  // Instagram-Konto
  let igId = digits(st.default_ig_user_id)
  if (!igId) {
    try {
      const pg = await graphGet<{ instagram_business_account?: { id?: string } }>(pageId, { fields: 'instagram_business_account' })
      igId = digits(pg?.instagram_business_account?.id)
    } catch (err) {
      console.warn('[werbe-ausfuehren] Instagram-Konto der Seite:', errMsg(err))
    }
    if (!igId) warnungen.push('Kein Instagram-Konto gefunden (ad_settings.default_ig_user_id leer): Instagram zeigt die Facebook-Seite')
  }

  // 4 Bilder
  const hashes: Record<string, string> = {}
  const alt = obj(pool.meta_image_hashes)
  if (typeof alt?.feed === 'string' && alt.feed) hashes.feed = alt.feed
  if (typeof alt?.story === 'string' && alt.story) hashes.story = alt.story
  const bilder: Array<['feed' | 'story', string | null]> = [['feed', pool.asset_feed_url], ['story', pool.asset_story_url]]
  for (const [slot, url] of bilder) {
    if (!url || hashes[slot]) continue
    const path = `act_${env.account}/adimages`
    let bild: { bytes: Uint8Array; type: string }
    try {
      bild = await ladeBild(url)
    } catch (err) {
      return fehler(422, `${slot === 'feed' ? 'Feed' : 'Story'}-Bild: ${errMsg(err)}`)
    }
    try {
      hashes[slot] = await uploadImage(env.account, bild.bytes, bild.type, `${kennung}_${slot}`)
      await logMetaWrite(sb, {
        actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: 'image', entity_id: hashes[slot], path,
        request: { name: `${kennung}_${slot}`, content_type: bild.type, bytes: bild.bytes.byteLength, pool_id: pool.id },
        after: { hash: hashes[slot] }, ok: true, usage: getLastUsage(),
      })
    } catch (err) {
      await logMetaWrite(sb, {
        actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: 'image', path,
        request: { name: `${kennung}_${slot}`, content_type: bild.type, bytes: bild.bytes.byteLength, pool_id: pool.id },
        ok: false, ...metaErrorLogFelder(err), usage: getLastUsage(),
      })
      return metaFehlerAntwort(err, 'Bild hochladen')
    }
  }
  const hashFehler = await poolSpeichern(sb, pool.id, { meta_image_hashes: hashes })
  if (hashFehler) return fehler(500, `Bild-Hashes speichern: ${hashFehler}`)

  // 5 Anzeigen-Entwürfe je Ziel
  const entwurf = (z: Ziel): AdDraft => ({
    key: z.name,
    adset_key: z.suffix ?? 'ziel',
    name: z.name,
    format: 'single_image',
    identity: { page_id: pageId, instagram_user_id: igId },
    primary_texts: primaer,
    headlines: ueberschriften,
    descriptions: beschreibungen,
    cta_type: cta,
    destination: { kind: 'website', url: z.link },
    media: {
      feed_4x5: { media_id: feedMediaId, image_hash: hashes.feed },
      ...(hashes.story ? { story_9x16: { media_id: storyMediaId, image_hash: hashes.story } } : {}),
    },
    creative_features: {},
    multi_advertiser: 'OPT_OUT',
    source: { pool_id: pool.id },
  })
  const vorhanden = obj(pool.meta_ad_ids) ?? {}
  const offen = ziele.filter(z => !digits(vorhanden[z.adsetId]))

  // 6 validate_only (Creative + Anzeige mit Inline-Creative) für alle offenen Ziele
  for (const z of offen) {
    const ad = entwurf(z)
    let creative: Record<string, unknown>
    try {
      creative = buildCreativePayload(ad, { placements: z.placements }).payload
    } catch (err) {
      return fehler(422, `Creative bauen: ${errMsg(err)}`)
    }
    const schritte: Array<[string, string, Record<string, unknown>]> = [
      ['creative', `act_${env.account}/adcreatives`, creative],
      ['ad', `act_${env.account}/ads`, buildAdPayload(ad, z.adsetId, creative)],
    ]
    for (const [level, path, payload] of schritte) {
      try {
        await graphPost(path, payload, { validateOnly: true })
        await logMetaWrite(sb, {
          actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: level, entity_id: level === 'ad' ? z.adsetId : null,
          path, validate_only: true, request: payload, ok: true, usage: getLastUsage(),
        })
      } catch (err) {
        await logMetaWrite(sb, {
          actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: level, entity_id: level === 'ad' ? z.adsetId : null,
          path, validate_only: true, request: payload, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage(),
        })
        const text = err instanceof MetaApiError ? (err.userMsg ?? err.message) : errMsg(err)
        await poolSpeichern(sb, pool.id, { qa: { ...(pool.qa ?? {}), hochladen: { fehler: text.slice(0, 300), at: new Date().toISOString(), schritt: `validieren_${level}` } } })
        await apLog(sb, {
          lauf_id: laufId, art: 'fehler', modus: 'hochladen', entity_level: 'adset', entity_id: z.adsetId, entity_name: z.name,
          aktion: 'ersatz_hochladen', evidence: { pool_id: pool.id, kennung, schritt: `validieren_${level}` },
          meta_response: err instanceof MetaApiError ? err.detail() : { message: text }, ergebnis: `validierung_fehler: ${text}`.slice(0, 300),
          akteur, akteur_art: 'system',
        })
        return metaFehlerAntwort(err, level === 'creative' ? 'Creative prüfen' : 'Anzeige prüfen', { pool_id: pool.id })
      }
    }
  }
  if (nurValidieren) {
    return json({
      success: true, validiert: true, pool_id: pool.id, kennung,
      ziele: ziele.map(z => ({ adset_id: z.adsetId, name: z.name, link: z.link, schon_angelegt: !!digits(vorhanden[z.adsetId]) })),
      warnungen,
    })
  }

  // 7 Anlegen
  const adIds: Record<string, string> = {}
  for (const [k, v] of Object.entries(vorhanden)) if (digits(v)) adIds[k] = digits(v)
  let ersteCreative = pool.meta_creative_id ?? null
  const angelegt: Angelegt[] = []
  for (const z of offen) {
    const ad = entwurf(z)
    const creativePayload = buildCreativePayload(ad, { placements: z.placements }).payload
    const cPath = `act_${env.account}/adcreatives`
    let creativeId: string
    try {
      const r = await graphPost<{ id?: string }>(cPath, creativePayload)
      creativeId = digits(r?.id)
      if (!creativeId) throw new MetaApiError({ status: 200, kind: 'unknown', message: 'Meta lieferte keine Creative-ID' })
      await logMetaWrite(sb, {
        actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: 'creative', entity_id: creativeId,
        path: cPath, request: creativePayload, after: r, ok: true, usage: getLastUsage(),
      })
    } catch (err) {
      await logMetaWrite(sb, {
        actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: 'creative', path: cPath,
        request: creativePayload, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage(),
      })
      return await abbruch(sb, pool, laufId, z, kennung, akteur, adIds, ersteCreative, angelegt, err, 'Creative anlegen')
    }

    const adPayload = buildAdPayload(ad, z.adsetId, { creative_id: creativeId })
    const aPath = `act_${env.account}/ads`
    let adId: string
    try {
      const r = await graphPost<{ id?: string }>(aPath, adPayload)
      adId = digits(r?.id)
      if (!adId) throw new MetaApiError({ status: 200, kind: 'unknown', message: 'Meta lieferte keine Anzeigen-ID' })
      await logMetaWrite(sb, {
        actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: 'ad', entity_id: adId,
        path: aPath, request: adPayload, after: r, ok: true, usage: getLastUsage(),
      })
    } catch (err) {
      await logMetaWrite(sb, {
        actor: akteur, actor_kind: kind, fn: FN, mode: 'hochladen', entity_level: 'ad', entity_id: z.adsetId, path: aPath,
        request: adPayload, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage(),
      })
      return await abbruch(sb, pool, laufId, z, kennung, akteur, adIds, ersteCreative, angelegt, err, 'Anzeige anlegen', creativeId)
    }

    // Rücklesen (darf scheitern; die Anzeige ist angelegt)
    let effektiv: string | null = null
    let status = 'PAUSED'
    try {
      const rb = await graphGet<Record<string, unknown>>(adId, { fields: 'status,effective_status' })
      status = String(rb.status ?? 'PAUSED')
      effektiv = rb.effective_status ? String(rb.effective_status) : null
      if (status !== 'PAUSED') warnungen.push(`Anzeige ${adId} steht laut Meta auf ${status}`)
    } catch (err) {
      warnungen.push(`Rücklesen ${adId}: ${errMsg(err)}`.slice(0, 200))
    }

    adIds[z.adsetId] = adId
    ersteCreative = ersteCreative ?? creativeId
    angelegt.push({ adset_id: z.adsetId, ad_id: adId, creative_id: creativeId, name: z.name, link: z.link, effective_status: effektiv })
    // Fortschritt sofort sichern (erneuter Aufruf legt diese Gruppe nicht doppelt an)
    await poolSpeichern(sb, pool.id, { meta_ad_ids: adIds, meta_creative_id: ersteCreative })

    const jetzt = new Date().toISOString()
    const { error: cErr } = await sb.from('ad_catalog').upsert({
      ad_id: adId, platform: 'meta', account_id: env.account, campaign_id: z.campaignId, campaign_name: z.campaignName,
      adset_id: z.adsetId, adset_name: z.adsetName, ad_name: z.name, status, configured_status: status,
      effective_status: effektiv, creative_id: creativeId, creative_body: primaer[0] ?? null,
      thumbnail_url: pool.asset_feed_url, url_tags: URL_TAGS_STANDARD, created_time: jetzt, updated_time: jetzt, updated_at: jetzt,
    }, { onConflict: 'ad_id' })
    if (cErr) warnungen.push(`ad_catalog: ${String(cErr.message ?? cErr)}`.slice(0, 200))
    const { error: spErr } = await sb.from('studio_prepared_ads').upsert({ ad_id: adId, ad_name: z.name.slice(0, 100) }, { onConflict: 'ad_id' })
    if (spErr) warnungen.push(`studio_prepared_ads: ${String(spErr.message ?? spErr)}`.slice(0, 200))
    await apLog(sb, {
      lauf_id: laufId, art: 'ausfuehrung', modus: 'hochladen', entity_level: 'ad', entity_id: adId, entity_name: z.name,
      aktion: 'ersatz_hochladen', after: { status, adset_id: z.adsetId, creative_id: creativeId, link: z.link },
      readback: { status, effective_status: effektiv }, evidence: { pool_id: pool.id, kennung },
      ergebnis: 'ok', akteur, akteur_art: 'system',
    })
  }

  // Vorrat -> hochgeladen (Guard stempelt hochgeladen_at und schreibt den Vorrat-Log)
  const qa = { ...(pool.qa ?? {}) }
  delete qa.hochladen
  const endFehler = await poolSpeichern(sb, pool.id, {
    status: 'hochgeladen', meta_image_hashes: hashes, meta_ad_ids: adIds, meta_creative_id: ersteCreative, qa,
  })
  if (endFehler) warnungen.push(`Vorrat-Status: ${endFehler}`)
  return json({
    success: true, modus: 'hochladen', pool_id: pool.id, kennung, status: endFehler ? pool.status : 'hochgeladen',
    angelegt, meta_ad_ids: adIds, meta_creative_id: ersteCreative, warnungen,
  })
}

/** Abbruch mitten im Anlegen: Fortschritt sichern, Fehler loggen, Antwort bauen. */
async function abbruch(
  sb: Sb, pool: PoolZeile, laufId: string, z: Ziel, kennung: string, akteur: string | null,
  adIds: Record<string, string>, creativeId: string | null, angelegt: Angelegt[], err: unknown, wobei: string,
  verwaistesCreative: string | null = null,
): Promise<Response> {
  const text = err instanceof MetaApiError ? (err.userMsg ?? err.message) : errMsg(err)
  await poolSpeichern(sb, pool.id, {
    meta_ad_ids: adIds, meta_creative_id: creativeId,
    qa: { ...(pool.qa ?? {}), hochladen: { fehler: text.slice(0, 300), at: new Date().toISOString(), schritt: wobei } },
  })
  await apLog(sb, {
    lauf_id: laufId, art: 'fehler', modus: 'hochladen', entity_level: 'adset', entity_id: z.adsetId, entity_name: z.name,
    aktion: 'ersatz_hochladen', evidence: { pool_id: pool.id, kennung, schritt: wobei, schon_angelegt: angelegt.map(a => a.ad_id), creative_ohne_anzeige: verwaistesCreative },
    meta_response: err instanceof MetaApiError ? err.detail() : { message: text }, ergebnis: `fehler: ${text}`.slice(0, 300),
    akteur, akteur_art: 'system',
  })
  return metaFehlerAntwort(err, wobei, { pool_id: pool.id, teilweise: angelegt.length > 0, angelegt, meta_ad_ids: adIds })
}
