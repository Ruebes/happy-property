// meta-konto: Werbekonto lesen (Status, Ausgaben, Limit, Zahlung, DSA, kontoweite
// Einschränkungen, Markenschutz, Blocklisten) und Ausgabenlimit des Kontos setzen
// oder entfernen (nur Admin, confirm: true, höchstens 10 Änderungen in 24 h).

import { graphAll, graphGet, graphPost, MetaApiError, wechselkurs } from '../_shared/metaGraph.ts'
import {
  adminRecht, arr, auslastungHoch, isoZeit, KontoError, logWrite, num, obj, protokollZaehlen, type Ctx, type Raw,
  schreibRecht, schreibSperre, softMsg, str, usageInfo,
} from './common.ts'
import {
  AUSGABENLIMIT_MAX_AENDERUNGEN, KONTO_ERKLAERUNG, KONTO_SPERRGRUND_LABEL, KONTO_STATUS_CODE, KONTO_STATUS_LABEL,
  PLATZIERUNG_AUSSCHLUSS_LABEL, ZAHLUNGSQUELLE_LABEL,
  type KontoAbrufRequest, type KontoAusgabenlimitRequest, type KontoAusgabenlimitResponse, type KontoBlockliste,
  type KontoMarkenschutz, type KontoResponse, type KontoZahlungsquelle,
} from './typen.ts'

const FELDER_VOLL = [
  'id', 'account_id', 'name', 'account_status', 'disable_reason', 'currency', 'timezone_name',
  'timezone_offset_hours_utc', 'amount_spent', 'spend_cap', 'balance', 'funding_source_details',
  'is_prepay_account', 'business{id,name}', 'default_dsa_beneficiary', 'default_dsa_payor', 'min_daily_budget',
  'brand_safety_content_filter_levels',
].join(',')
/** Rückfall, falls Meta ein Feld (Zahlung, Markenschutz) wegen Rechten oder Version ablehnt */
const FELDER_BASIS = [
  'id', 'account_id', 'name', 'account_status', 'disable_reason', 'currency', 'timezone_name',
  'timezone_offset_hours_utc', 'amount_spent', 'spend_cap', 'balance', 'default_dsa_beneficiary', 'default_dsa_payor',
].join(',')

const ZEITRAUM_24H_MS = 24 * 3600_000

// ── Umrechnung ───────────────────────────────────────────────────────────────

/** Cent-String von Meta -> ganze Zahl (null bei leer/ungültig) */
const cents = (v: unknown): number | null => {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

/** Cent der Kontowährung -> Euro (2 Stellen); nur USD und EUR umrechenbar */
function zuEur(c: number | null, waehrung: string | null, usdProEur: number): number | null {
  if (c === null) return null
  if (waehrung === 'EUR') return Math.round(c) / 100
  if (waehrung === 'USD' && usdProEur > 0) return Math.round(c / usdProEur) / 100
  return null
}

// ── Anzeige-Texte ────────────────────────────────────────────────────────────

/** Zahlungsmittel verkürzen: E-Mail-Adressen weg, lange Ziffernfolgen bis auf 4 Stellen verbergen. */
export function maskiereZahlung(s: string): string | null {
  const t = s
    .replace(/[^\s()<>,;]+@[^\s()<>,;]+/g, 'E-Mail verborgen')
    .replace(/\d[\d\s-]{6,}\d/g, m => `****${m.replace(/\D/g, '').slice(-4)}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return t || null
}

function zahlungsquelle(raw: unknown): KontoZahlungsquelle | null {
  const r = obj(raw)
  if (!Object.keys(r).length) return null
  const art = num(r.type)
  const artText = art !== null ? (ZAHLUNGSQUELLE_LABEL[art] ?? `Typ ${art}`) : 'Unbekannt'
  return { art, art_text: artText, anzeige: str(r.display_string) ? maskiereZahlung(str(r.display_string)) : null }
}

const MARKEN_BEREICH: Record<string, string> = {
  FACEBOOK: 'Facebook-Videos und Reels',
  AN: 'Audience Network',
  FEED: 'Feeds',
  IG: 'Instagram',
}
// [unverifiziert] Zuordnung RELAXED/STANDARD/STRICT zu den UI-Stufen „Erweitert/Moderat/Eingeschränkt“
const MARKEN_STUFE: Record<string, string> = {
  RELAXED: 'Erweitertes Inventar',
  STANDARD: 'Moderates Inventar',
  STRICT: 'Eingeschränktes Inventar',
}

export function markenschutz(list: unknown): KontoMarkenschutz[] {
  return arr(list).map(v => str(v).trim()).filter(Boolean).map(key => {
    const m = /^([A-Z]+)_([A-Z]+)$/.exec(key)
    const bereich = m ? MARKEN_BEREICH[m[1]] : undefined
    const stufe = m ? MARKEN_STUFE[m[2]] : undefined
    return { key, text: bereich && stufe ? `${bereich}: ${stufe}` : key }
  })
}

/** account_controls -> Platzierungs-Ausschlüsse + Zielgruppen-Sätze (tolerant) */
export function kontoEinschraenkungen(raw: unknown): { keys: string[]; texte: string[]; zielgruppe: string[] } {
  const r0 = obj(raw)
  const r = arr(r0.data).length ? obj(arr(r0.data)[0]) : r0
  const pc = obj(r.placement_controls)
  const keys = arr(pc.placement_exclusions).map(v => str(v).trim()).filter(Boolean)
  const texte = keys.map(k => PLATZIERUNG_AUSSCHLUSS_LABEL[k] ?? k)
  const ac = obj(r.audience_controls)
  const zielgruppe: string[] = []
  const alter = num(ac.age_min)
  if (alter !== null && alter > 18) zielgruppe.push(`Mindestalter ${alter} Jahre`)
  const laender = arr(obj(ac.geo_locations).countries).map(v => str(v)).filter(Boolean)
  if (laender.length) zielgruppe.push(`Nur in: ${laender.slice(0, 20).join(', ')}`)
  const aus = arr(obj(ac.excluded_geo_locations).countries).map(v => str(v)).filter(Boolean)
  if (aus.length) zielgruppe.push(`Ausgeschlossen: ${aus.slice(0, 20).join(', ')}`)
  if (arr(ac.excluded_custom_audiences).length) zielgruppe.push('Eigene Zielgruppen kontoweit ausgeschlossen')
  return { keys, texte, zielgruppe }
}

// ── Konto lesen ─────────────────────────────────────────────────────────────

async function kontoRoh(account: string, hinweise: string[]): Promise<Raw> {
  try {
    return await graphGet<Raw>(`act_${account}`, { fields: FELDER_VOLL })
  } catch (e) {
    if (!(e instanceof MetaApiError) || !['validation', 'permission'].includes(e.kind)) throw e
    hinweise.push(`Zahlungsquelle und Markenschutz nicht lesbar (${softMsg(e)}).`)
    return await graphGet<Raw>(`act_${account}`, { fields: FELDER_BASIS })
  }
}

export async function modeKonto(ctx: Ctx, _req: KontoAbrufRequest): Promise<KontoResponse> {
  const hinweise: string[] = []
  const account = ctx.env.account
  const r = await kontoRoh(account, hinweise)
  const kurs = await wechselkurs(ctx.sb)
  const waehrung = str(r.currency) || null
  if (waehrung && waehrung !== 'USD' && waehrung !== 'EUR') hinweise.push(`Kontowährung ${waehrung}: keine Euro-Umrechnung.`)

  const ausgegeben = cents(r.amount_spent)
  const limitRoh = cents(r.spend_cap)
  // Meta: spend_cap 0 (oder leer) = kein Limit
  const limit = limitRoh !== null && limitRoh > 0 ? limitRoh : null
  const rest = limit !== null && ausgegeben !== null ? Math.max(0, limit - ausgegeben) : null
  const saldo = cents(r.balance)
  const statusCode = num(r.account_status)
  const status = statusCode !== null ? (KONTO_STATUS_CODE[statusCode] ?? 'unbekannt') : 'unbekannt'
  const sperr = num(r.disable_reason)
  const biz = obj(r.business)

  // Optionale Abfragen (je eine): nicht bei hoher Meta-Auslastung
  let einschraenkungenLesbar = false
  let platzKeys: string[] = []
  let platzTexte: string[] = []
  let zielgruppe: string[] = []
  let blocklisten: KontoBlockliste[] = []
  let blocklistenLesbar = false
  if (auslastungHoch()) {
    hinweise.push('Meta-Auslastung hoch: kontoweite Einschränkungen und Blocklisten diesmal nicht geladen.')
  } else {
    try {
      const ac = await graphGet<Raw>(`act_${account}/account_controls`, { fields: 'audience_controls,placement_controls' }, { retry: false })
      const e = kontoEinschraenkungen(ac)
      platzKeys = e.keys
      platzTexte = e.texte
      zielgruppe = e.zielgruppe
      einschraenkungenLesbar = true
    } catch (e) {
      hinweise.push(`Kontoweite Einschränkungen nicht lesbar (${softMsg(e)}).`)
    }
    if (!auslastungHoch()) {
      try {
        const list = await graphAll<Raw>(`act_${account}/publisher_block_lists`, { fields: 'id,name,last_update_time', limit: 25 }, { maxPages: 1 })
        blocklisten = list.map(b => ({ id: str(b.id), name: str(b.name) || 'Ohne Namen', aktualisiert: isoZeit(b.last_update_time) })).filter(b => b.id)
        blocklistenLesbar = true
      } catch (e) {
        hinweise.push(`Blocklisten nicht lesbar (${softMsg(e)}).`)
      }
    }
  }

  // Wer darf was (für graue Schalter mit Grund)
  const limitAenderungen = await protokollZaehlen(ctx, 'konto_ausgabenlimit', new Date(Date.now() - ZEITRAUM_24H_MS).toISOString())
  const sperre = await schreibSperre(ctx)
  const admin = adminRecht(ctx)
  const recht = await schreibRecht(ctx)
  const limitGrund = admin?.message ?? sperre?.message
    ?? (limitAenderungen !== null && limitAenderungen >= AUSGABENLIMIT_MAX_AENDERUNGEN
      ? `Meta erlaubt höchstens ${AUSGABENLIMIT_MAX_AENDERUNGEN} Änderungen am Ausgabenlimit pro Tag.` : null)
  const kommentarGrund = recht?.message ?? sperre?.message ?? null

  if (status !== 'aktiv') hinweise.push(`Werbekonto-Status: ${KONTO_STATUS_LABEL[status]}. Anzeigen laufen eventuell nicht.`)
  if (limit !== null && rest !== null && limit > 0 && rest / limit < 0.1) {
    hinweise.push('Das Ausgabenlimit ist fast erreicht. Danach stoppt Meta alle Anzeigen.')
  }

  return {
    id: str(r.account_id) || account,
    name: str(r.name) || null,
    status,
    status_code: statusCode,
    status_text: KONTO_STATUS_LABEL[status],
    waehrung,
    zeitzone: str(r.timezone_name) || null,
    zeitzone_offset_h: num(r.timezone_offset_hours_utc),
    ausgegeben_cents: ausgegeben,
    ausgegeben_eur: zuEur(ausgegeben, waehrung, kurs.usdPerEur),
    limit_cents: limit,
    limit_eur: zuEur(limit, waehrung, kurs.usdPerEur),
    rest_cents: rest,
    rest_eur: zuEur(rest, waehrung, kurs.usdPerEur),
    limit_auslastung_pct: limit !== null && ausgegeben !== null ? Math.round((ausgegeben / limit) * 1000) / 10 : null,
    saldo_cents: saldo,
    saldo_eur: zuEur(saldo, waehrung, kurs.usdPerEur),
    usd_pro_eur: kurs.usdPerEur,
    kurs_quelle: kurs.quelle,
    zahlungsquelle: zahlungsquelle(r.funding_source_details),
    vorauszahlung: typeof r.is_prepay_account === 'boolean' ? r.is_prepay_account : null,
    sperrgrund_code: sperr !== null && sperr > 0 ? sperr : null,
    sperrgrund_text: sperr !== null && sperr > 0 ? (KONTO_SPERRGRUND_LABEL[sperr] ?? `Sperrgrund ${sperr}`) : null,
    unternehmen: str(biz.id) ? { id: str(biz.id), name: str(biz.name) || null } : null,
    dsa_beguenstigter: str(r.default_dsa_beneficiary) || null,
    dsa_zahler: str(r.default_dsa_payor) || null,
    mindest_tagesbudget_cents: cents(r.min_daily_budget),
    platzierungs_ausschluesse: platzTexte,
    platzierungs_ausschluesse_keys: platzKeys,
    zielgruppen_einschraenkungen: zielgruppe,
    einschraenkungen_lesbar: einschraenkungenLesbar,
    markenschutz: markenschutz(r.brand_safety_content_filter_levels),
    blocklisten,
    blocklisten_lesbar: blocklistenLesbar,
    wohnen_hinweis: KONTO_ERKLAERUNG.wohnen,
    limit_aenderungen_24h: limitAenderungen,
    limit_aenderungen_max: AUSGABENLIMIT_MAX_AENDERUNGEN,
    darf_limit_aendern: limitGrund === null,
    limit_sperrgrund: limitGrund,
    darf_kommentare: kommentarGrund === null,
    kommentare_sperrgrund: kommentarGrund,
    hinweise,
    geladen: new Date().toISOString(),
    usage: usageInfo(),
  }
}

// ── Ausgabenlimit setzen / entfernen ─────────────────────────────────────────

/** Höchstwert gegen Tippfehler: 1 Mio. Einheiten der Kontowährung */
const LIMIT_MAX_CENTS = 100_000_000
/** Unter diesem Wert warnt die Antwort (Metas Mindestwert laut Hilfe ca. 100 USD, unverifiziert) */
const LIMIT_WARN_CENTS = 10_000

export async function modeKontoAusgabenlimit(ctx: Ctx, req: KontoAusgabenlimitRequest): Promise<KontoAusgabenlimitResponse> {
  // Gate (Recht Werbung, builder_enabled, Not-Aus) hat index.ts geprüft; hier zusätzlich Admin
  const admin = adminRecht(ctx)
  if (admin) throw admin
  const vorschau = req.vorschau === true
  const entfernen = req.entfernen === true
  if (entfernen && req.spend_cap_cents !== undefined && req.spend_cap_cents !== null) {
    throw new KontoError(400, 'invalid_request', 'Entweder ein neues Limit oder „entfernen“, nicht beides.')
  }
  let neu: number | null = null
  if (!entfernen) {
    const n = num(req.spend_cap_cents)
    if (n === null || !Number.isInteger(n) || n <= 0 || n > LIMIT_MAX_CENTS) {
      throw new KontoError(400, 'invalid_request', `Neues Ausgabenlimit: bitte eine ganze Zahl in Cent von 1 bis ${LIMIT_MAX_CENTS}.`,
        'Beispiel: 500000 = 5.000,00 in der Kontowährung.')
    }
    neu = n
  }
  if (!vorschau && req.confirm !== true) {
    throw new KontoError(400, 'invalid_request', 'Bitte die Änderung des Ausgabenlimits ausdrücklich bestätigen (confirm: true).')
  }

  const hinweise: string[] = []
  const account = ctx.env.account
  const vorher = await graphGet<Raw>(`act_${account}`, { fields: 'spend_cap,amount_spent,currency' })
  const waehrung = str(vorher.currency) || null
  const capVorher = cents(vorher.spend_cap)
  const vorherCents = capVorher !== null && capVorher > 0 ? capVorher : null
  const ausgegeben = cents(vorher.amount_spent)

  if (neu === null && vorherCents === null) {
    throw new KontoError(409, 'unveraendert', 'Es ist kein Ausgabenlimit gesetzt, es gibt nichts zu entfernen.')
  }
  if (neu !== null && neu === vorherCents) {
    throw new KontoError(409, 'unveraendert', 'Das Ausgabenlimit hat bereits diesen Wert.')
  }
  // Ohne bisheriges Limit ist amount_spent die Gesamtausgabe des Kontos; ein neues Limit zählt
  // laut Meta nur Ausgaben ab dem Setzen. Der Vergleich gilt daher nur bei bestehendem Limit.
  if (neu !== null && vorherCents !== null && ausgegeben !== null && neu <= ausgegeben) {
    throw new KontoError(422, 'invalid_request',
      'Das neue Limit liegt nicht über dem bereits ausgegebenen Betrag. Meta würde sofort alle Anzeigen stoppen.',
      `Bereits ausgegeben seit dem letzten Zurücksetzen des Limits: ${(ausgegeben / 100).toFixed(2)} ${waehrung ?? ''}`.trim())
  }
  if (neu !== null && vorherCents === null) {
    hinweise.push('Bisher gab es kein Ausgabenlimit: das neue Limit zählt nur Ausgaben ab jetzt, nicht die bisherigen.')
  }
  if (neu !== null && neu < LIMIT_WARN_CENTS) hinweise.push('Sehr niedriges Limit: Meta verlangt eventuell einen Mindestwert (ca. 100 USD).')

  const seit = new Date(Date.now() - ZEITRAUM_24H_MS).toISOString()
  const bisher = await protokollZaehlen(ctx, 'konto_ausgabenlimit', seit)
  if (bisher === null) hinweise.push('Änderungsprotokoll nicht lesbar: Metas Grenze von 10 Änderungen pro Tag nicht vorab geprüft.')
  if (bisher !== null && bisher >= AUSGABENLIMIT_MAX_AENDERUNGEN) {
    throw new KontoError(429, 'limit_reached',
      `Das Ausgabenlimit wurde in den letzten 24 Stunden schon ${bisher} Mal geändert. Meta erlaubt höchstens ${AUSGABENLIMIT_MAX_AENDERUNGEN} Änderungen pro Tag.`,
      'Morgen erneut versuchen.')
  }

  // [unverifiziert] Meta liest spend_cap in Cent (Basiseinheit), dokumentiert beim Schreiben aber die
  // ganze Einheit (z. B. Dollar, Typ float). Wir senden ganze Einheiten und prüfen danach per Lesen.
  // 0 entfernt das Limit.
  const payload: Record<string, unknown> = { spend_cap: neu === null ? 0 : neu / 100 }
  const kurs = await wechselkurs(ctx.sb)
  const basis = {
    vorschau, waehrung, vorher_cents: vorherCents, nachher_cents: neu,
    nachher_eur: zuEur(neu, waehrung, kurs.usdPerEur), payload,
  }
  if (vorschau) {
    return { ok: true, ...basis, pruefung: 'vorschau', gelesen_cents: null, limit_aenderungen_24h: bisher, hinweise }
  }

  const path = `act_${account}`
  const request = { spend_cap: payload.spend_cap, entfernen, spend_cap_cents: neu }
  try {
    // Wert setzen ist wiederholbar (idempotent)
    await graphPost<Raw>(path, payload, { idempotent: true })
  } catch (err) {
    await logWrite(ctx, { level: 'account', path, entityId: account, request, before: { spend_cap_cents: vorherCents }, err })
    throw err
  }

  let gelesen: number | null = null
  let pruefung: KontoAusgabenlimitResponse['pruefung'] = 'nicht_gelesen'
  try {
    const nach = await graphGet<Raw>(path, { fields: 'spend_cap' })
    const c = cents(nach.spend_cap)
    gelesen = c !== null && c > 0 ? c : null
    pruefung = gelesen === neu ? 'ok' : 'abweichung'
  } catch (e) {
    hinweise.push(`Kontrolle nach dem Speichern nicht möglich (${softMsg(e)}). Bitte im Werbeanzeigenmanager prüfen.`)
  }
  if (pruefung === 'abweichung') {
    hinweise.push(`Meta zeigt das Limit anders als gewollt (gelesen: ${gelesen === null ? 'kein Limit' : (gelesen / 100).toFixed(2)}). Bitte sofort im Werbeanzeigenmanager unter Zahlungseinstellungen prüfen.`)
    console.warn(`[meta-konto] Ausgabenlimit-Abweichung: gewollt ${neu ?? 0}, gelesen ${gelesen ?? 0} (Cent)`)
  }
  await logWrite(ctx, {
    level: 'account', path, entityId: account, request,
    before: { spend_cap_cents: vorherCents, amount_spent_cents: ausgegeben },
    after: { spend_cap_cents: gelesen, pruefung },
  })
  return {
    ok: true, ...basis, pruefung, gelesen_cents: gelesen,
    limit_aenderungen_24h: bisher === null ? null : bisher + 1, hinweise,
  }
}
