// Werbemittel-Vorrat (ad_creative_pool): automatische Prüfung entwurf -> geprueft,
// Freigabe-Prognose (lernt aus Svens/Gionas Entscheidungen), optionale automatische
// Freigabe nach ad_settings.pool_auto_release_level, Bestandsprüfung und
// wöchentliche Briefs per Thompson Sampling über die Winkel.
//
// Schreibt nur in ad_creative_pool (als Service-Role, der Guard werbe_pool_guard
// erlaubt dem System qa/prognose/review/Status entwurf->geprueft) und ins
// ad_autopilot_log. Freigeben geht ausschließlich über die RPC
// werbe_pool_entscheiden; der Guard prüft Stufe, Schwelle, 30 menschliche
// Entscheidungen und fakten_pruefung noch einmal selbst.
//
// Bildmaße: nur Dateien aus dem eigenen Supabase-Storage werden geladen (kein
// Abruf beliebiger URLs), höchstens 256 KB je Datei.

import { lintAd, lintCounts, slugify, type LintIssue } from '../_shared/metaLint.ts'
import { freigabePrognose, thompsonAnteile, type ThompsonArm } from '../_shared/werbeMathe.ts'
import { type Sb, alleZeilen, dbFehler, errMsg, isoWoche, toNum, toStr } from './gemeinsam.ts'

export const FEED_SOLL = { w: 1080, h: 1350 }
export const STORY_SOLL = { w: 1080, h: 1920 }
export const MIN_REVIEW_SCORE = 80
const MAX_BYTES = 262_144

/** Startliste der Winkel (05-automation-design §4.6), ergänzt um Winkel aus dem Vorrat. */
export const WINKEL_STANDARD = [
  'Miete zuerst', 'Kosten und Nebenkosten', 'Transparenz und echte Preise', 'Sven persönlich',
  'Neubau statt Bestand', 'EU-Sicherheit Südzypern', 'Zahlungsplan',
]

/** Preise, Beträge, Flächen, Prozente im Text = Fakten (nie automatisch freigeben). */
const FAKTEN_TEXT = /\d[\d.,]*\s?(?:€|eur\b|euro\b|%|prozent\b|m²|qm\b|quadratmeter)|(?:€|\beur)\s?\d/i
/** Echte Projektfotos/Visualisierungen/Baustelle = Fakten (Svens Freigabe). */
const FAKTEN_VISUAL = /baustelle|visualisierung|rendering|grundriss|projektfoto|objektfoto/i

interface PoolZeile {
  id: string
  kennung: string
  status: string
  winkel: string | null
  hook_typ: string | null
  format: string | null
  visual_typ: string | null
  lp_url: string | null
  texte: Record<string, unknown>
  asset_feed_url: string | null
  asset_story_url: string | null
  video_feed_id: string | null
  video_story_id: string | null
  ki_generiert: boolean
  ki_label: boolean
  eu_band: boolean
  fakten_pruefung: boolean
  qa: Record<string, unknown> | null
  review_score: number | null
  prognose: number | null
  quelle: string | null
}

const POOL_SPALTEN = 'id, kennung, status, winkel, hook_typ, format, visual_typ, lp_url, texte, asset_feed_url, asset_story_url, ' +
  'video_feed_id, video_story_id, ki_generiert, ki_label, eu_band, fakten_pruefung, qa, review_score, prognose, quelle'

function poolAus(r: Record<string, unknown>): PoolZeile {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
  return {
    id: String(r.id ?? ''),
    kennung: String(r.kennung ?? ''),
    status: String(r.status ?? ''),
    winkel: toStr(r.winkel),
    hook_typ: toStr(r.hook_typ),
    format: toStr(r.format),
    visual_typ: toStr(r.visual_typ),
    lp_url: toStr(r.lp_url),
    texte: obj(r.texte) ?? {},
    asset_feed_url: toStr(r.asset_feed_url),
    asset_story_url: toStr(r.asset_story_url),
    video_feed_id: toStr(r.video_feed_id),
    video_story_id: toStr(r.video_story_id),
    ki_generiert: r.ki_generiert === true,
    ki_label: r.ki_label === true,
    eu_band: r.eu_band === true,
    fakten_pruefung: r.fakten_pruefung === true,
    qa: obj(r.qa),
    review_score: toNum(r.review_score),
    prognose: toNum(r.prognose),
    quelle: toStr(r.quelle),
  }
}

// ── Texte ───────────────────────────────────────────────────────────────────

function liste(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v] : []
  if (!Array.isArray(v)) return []
  return v.map(x => (typeof x === 'string' ? x : String((x as { text?: unknown } | null)?.text ?? ''))).filter(x => x.trim())
}

/** texte-jsonb in die drei Listen (mehrere Schreibweisen toleriert). */
export function texteAus(t: Record<string, unknown>): { primaer: string[]; ueberschriften: string[]; beschreibungen: string[] } {
  const erst = (...keys: string[]) => { for (const k of keys) { const l = liste(t[k]); if (l.length) return l } return [] }
  return {
    primaer: erst('primaer', 'primaertexte', 'primary_texts', 'primary', 'bodies'),
    ueberschriften: erst('ueberschriften', 'headlines', 'titel', 'titles'),
    beschreibungen: erst('beschreibungen', 'descriptions'),
  }
}

// ── Bildmaße ────────────────────────────────────────────────────────────────

/** Breite/Höhe aus den ersten Bytes (PNG, JPEG, WebP, GIF). */
export function bildGroesse(b: Uint8Array): { w: number; h: number; typ: string } | null {
  const be16 = (i: number) => (b[i] << 8) | b[i + 1]
  const le16 = (i: number) => b[i] | (b[i + 1] << 8)
  const be32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n))
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return { w: be32(16), h: be32(20), typ: 'png' }
  if (b.length >= 10 && ascii(0, 4) === 'GIF8') return { w: le16(6), h: le16(8), typ: 'gif' }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4)
    if (chunk === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff, typ: 'webp' }
    if (chunk === 'VP8L') {
      const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24]
      return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), typ: 'webp' }
    }
    if (chunk === 'VP8X') return { w: 1 + le24(24), h: 1 + le24(27), typ: 'webp' }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue }
      const len = be16(i + 2)
      const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
      if (sof) return { w: be16(i + 7), h: be16(i + 5), typ: 'jpeg' }
      if (len < 2) return null
      i += 2 + len
    }
  }
  return null
}

/** Lädt höchstens 256 KB einer Datei aus dem eigenen Storage und liest die Maße. */
export async function bildMasse(url: string): Promise<{ w: number; h: number; typ: string } | { fehler: string }> {
  let u: URL
  try { u = new URL(url) } catch { return { fehler: 'ungueltige_url' } }
  let eigen = ''
  try { eigen = new URL(Deno.env.get('SUPABASE_URL') ?? '').host } catch { /* leer */ }
  if (u.protocol !== 'https:' || !eigen || u.host !== eigen || !u.pathname.startsWith('/storage/v1/object/')) {
    return { fehler: 'fremder_host' }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(u.toString(), { headers: { Range: `bytes=0-${MAX_BYTES - 1}` }, signal: ctrl.signal })
    if (!res.ok && res.status !== 206) return { fehler: `http_${res.status}` }
    const reader = res.body?.getReader()
    if (!reader) return { fehler: 'kein_inhalt' }
    const teile: Uint8Array[] = []
    let n = 0
    while (n < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      teile.push(value)
      n += value.length
    }
    try { await reader.cancel() } catch { /* schon zu */ }
    const alles = new Uint8Array(Math.min(n, MAX_BYTES))
    let o = 0
    for (const t of teile) {
      const rest = alles.length - o
      if (rest <= 0) break
      alles.set(t.subarray(0, rest), o)
      o += Math.min(t.length, rest)
    }
    return bildGroesse(alles) ?? { fehler: 'format_unbekannt' }
  } catch (err) {
    return { fehler: err instanceof Error && err.name === 'AbortError' ? 'zeitueberschreitung' : errMsg(err).slice(0, 80) }
  } finally {
    clearTimeout(timer)
  }
}

/** Maße gegen Soll: Seitenverhältnis ±1 %, Breite mindestens Soll. */
function masseOk(m: { w: number; h: number }, soll: { w: number; h: number }): { ok: boolean; exakt: boolean } {
  const ratio = m.w / m.h
  const sollRatio = soll.w / soll.h
  const ok = m.w >= soll.w && Math.abs(ratio - sollRatio) / sollRatio <= 0.01
  return { ok, exakt: m.w === soll.w && m.h === soll.h }
}

// ── Entscheidungen + Prognose ───────────────────────────────────────────────

export interface Entscheidung {
  ja: boolean
  mensch: boolean
  winkel: string | null
  format: string | null
  /** Prognose zum Zeitpunkt der Entscheidung (merkmale.prognose) */
  prognose: number | null
}

export async function ladeEntscheidungen(sb: Sb): Promise<Entscheidung[]> {
  const rows = await alleZeilen<Record<string, unknown>>(
    async (a, b) => await sb.from('ad_creative_pool')
      .select('entscheidung, entschieden_von, merkmale, winkel, format, prognose')
      .not('entscheidung', 'is', null).order('entschieden_at', { ascending: false }).order('id').range(a, b),
    'ad_creative_pool (Entscheidungen)', 3000)
  return rows.map(r => {
    const m = (r.merkmale && typeof r.merkmale === 'object') ? r.merkmale as Record<string, unknown> : {}
    return {
      ja: r.entscheidung === 'freigegeben',
      mensch: r.entschieden_von != null,
      winkel: toStr(m.winkel) ?? toStr(r.winkel),
      format: toStr(m.format) ?? toStr(r.format),
      prognose: toNum(m.prognose),
    }
  })
}

export interface Prognose { wert: number; basis: Record<string, unknown> }

/** Wahrscheinlichkeit, dass Sven/Giona freigeben (Beta-Posterior je Merkmal, geglättet, mit Prüfnote gemischt). */
export function prognoseFuer(item: { winkel: string | null; format: string | null }, ents: Entscheidung[], score: number | null): Prognose {
  const menschen = ents.filter(e => e.mensch)
  const jaAlle = menschen.filter(e => e.ja).length
  const global = menschen.length ? jaAlle / menschen.length : 0.5
  const stufen: Array<{ name: string; passt: (e: Entscheidung) => boolean; moeglich: boolean }> = [
    { name: 'winkel+format', passt: e => e.winkel === item.winkel && e.format === item.format, moeglich: !!item.winkel && !!item.format },
    { name: 'winkel', passt: e => e.winkel === item.winkel, moeglich: !!item.winkel },
    { name: 'format', passt: e => e.format === item.format, moeglich: !!item.format },
  ]
  let ja = 0, n = 0, merkmal = 'global'
  for (const s of stufen) {
    if (!s.moeglich) continue
    const treffer = menschen.filter(s.passt)
    if (treffer.length >= 3) {
      ja = treffer.filter(e => e.ja).length
      n = treffer.length
      merkmal = s.name
      break
    }
  }
  const wert = freigabePrognose({ ja, n, globale_quote: global, review_score: score })
  return {
    wert: Math.round(wert * 10000) / 10000,
    basis: { merkmal, ja, n, globale_quote: Math.round(global * 1000) / 1000, entscheidungen_mensch: menschen.length, note: score },
  }
}

/** Trefferquote der Prognose: Anteil Freigaben unter menschlichen Entscheidungen mit Prognose >= Schwelle. */
export function uebereinstimmung(ents: Entscheidung[], schwelle: number): { faelle: number; quote: number | null } {
  const f = ents.filter(e => e.mensch && e.prognose != null && (e.prognose as number) >= schwelle)
  return { faelle: f.length, quote: f.length ? f.filter(e => e.ja).length / f.length : null }
}

async function verboteneNamen(sb: Sb): Promise<string[]> {
  const { data, error } = await sb.from('crm_projects').select('name, developer').limit(2000)
  if (error) {
    console.warn('[werbe-autopilot] crm_projects:', dbFehler(error))
    return []
  }
  const out = new Set<string>()
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    for (const v of [r.name, r.developer]) {
      const s = toStr(v)
      if (s && s.trim().length >= 3) out.add(s.trim())
    }
  }
  return [...out]
}

// ── QA-Gate ─────────────────────────────────────────────────────────────────

export interface QaErgebnis {
  bestanden: boolean
  fehlend: string[]
  pruefnote: number
  note: number | null
  note_quelle: 'studio' | 'automatisch'
  lint: Array<Pick<LintIssue, 'severity' | 'rule' | 'field' | 'match'>>
  lint_zaehlung: Record<string, number>
  medien: Record<string, unknown>
  fakten: string[]
}

export async function pruefeEintrag(p: PoolZeile, namen: string[], defaultLink: string, minScore: number): Promise<QaErgebnis> {
  const t = texteAus(p.texte)
  const fehlend: string[] = []
  const medien: Record<string, unknown> = {}
  if (!t.primaer.length) fehlend.push('texte_primaer')
  if (!t.ueberschriften.length) fehlend.push('texte_ueberschrift')

  const mediaInfo = (url: string | null) => ({
    name: p.kennung, public_url: url,
    eu_band_confirmed: p.eu_band, ki_label_confirmed: !p.ki_generiert || p.ki_label,
  })
  const media: Record<string, ReturnType<typeof mediaInfo>> = {}
  const refs: { feed_4x5?: { media_id: string }; story_9x16?: { media_id: string } } = {}
  if (p.asset_feed_url || p.video_feed_id) { media.feed = mediaInfo(p.asset_feed_url); refs.feed_4x5 = { media_id: 'feed' } }
  if (p.asset_story_url || p.video_story_id) { media.story = mediaInfo(p.asset_story_url); refs.story_9x16 = { media_id: 'story' } }
  const issues = lintAd({
    key: p.kennung, name: p.kennung,
    primary_texts: t.primaer, headlines: t.ueberschriften, descriptions: t.beschreibungen,
    destination: { kind: 'website', url: p.lp_url ?? defaultLink },
    media: refs,
  }, { forbiddenNames: namen, media })
  // Kennung wird Anzeigenname: Projekt-/Bauträgername auch dort verboten (ASCII-Slug-Vergleich)
  const kSlug = `-${slugify(p.kennung)}-`
  const kTreffer = namen.find(n => { const s = slugify(n); return !!s && kSlug.includes(`-${s}-`) })
  if (kTreffer) issues.push({ severity: 'blocker', rule: 'projektname', field: 'ad.name', messageKey: 'crm.werbung.lint.projektname', match: kTreffer })

  const zaehlung = lintCounts(issues)
  if (zaehlung.blocker > 0) fehlend.push('lint_blocker')
  if (issues.some(i => i.rule === 'eu_band')) fehlend.push('eu_band')
  if (issues.some(i => i.rule === 'ki_label')) fehlend.push('ki_label')

  const format = p.format ?? 'bild'
  if (format === 'karussell') {
    fehlend.push('karussell_manuell')
  } else if (format === 'video') {
    if (!p.video_feed_id && !p.asset_feed_url) fehlend.push('feed_fehlt')
    if (!p.video_story_id && !p.asset_story_url) fehlend.push('story_fehlt')
    medien.hinweis = 'Video: Maße werden nicht automatisch geprüft'
  } else {
    for (const [slot, url, soll] of [['feed', p.asset_feed_url, FEED_SOLL], ['story', p.asset_story_url, STORY_SOLL]] as const) {
      if (!url) { fehlend.push(`${slot}_fehlt`); continue }
      const m = await bildMasse(url)
      if ('fehler' in m) {
        medien[slot] = { fehler: m.fehler }
        fehlend.push(`${slot}_nicht_pruefbar`)
        continue
      }
      const c = masseOk(m, soll)
      medien[slot] = { w: m.w, h: m.h, typ: m.typ, soll: `${soll.w}x${soll.h}`, ok: c.ok, exakt: c.exakt }
      if (!c.ok) fehlend.push(`${slot}_format`)
    }
  }

  const fakten: string[] = []
  for (const s of [...t.primaer, ...t.ueberschriften, ...t.beschreibungen]) {
    const m = FAKTEN_TEXT.exec(s)
    if (m) { fakten.push(`text: ${m[0].trim()}`); break }
  }
  if (p.visual_typ && FAKTEN_VISUAL.test(p.visual_typ)) fakten.push(`visual: ${p.visual_typ}`)

  const pruefnote = zaehlung.blocker > 0 ? 0 : Math.max(0, 100 - 10 * zaehlung.warn)
  const note = p.review_score ?? pruefnote
  if (note < minScore) fehlend.push('review_score')
  return {
    bestanden: fehlend.length === 0,
    fehlend,
    pruefnote,
    note,
    note_quelle: p.review_score != null ? 'studio' : 'automatisch',
    lint: issues.map(i => ({ severity: i.severity, rule: i.rule, field: i.field, ...(i.match ? { match: i.match } : {}) })),
    lint_zaehlung: zaehlung,
    medien,
    fakten,
  }
}

export interface VorratErgebnis {
  geprueft: number
  bleibt_entwurf: number
  auto_freigegeben: number
  prognosen: number
  fehler: string[]
  details: Array<Record<string, unknown>>
  auto_freigabe: Record<string, unknown>
}

/**
 * QA-Gate für Entwürfe (optional nur `ids`), Prognose setzen, danach automatische
 * Freigabe geprüfter Einträge nach pool_auto_release_level (Standard 0 = nie).
 */
export async function vorratPruefen(sb: Sb, opts: { ids?: string[]; now: Date }): Promise<VorratErgebnis> {
  const erg: VorratErgebnis = { geprueft: 0, bleibt_entwurf: 0, auto_freigegeben: 0, prognosen: 0, fehler: [], details: [], auto_freigabe: {} }
  const { data: st, error: stErr } = await sb.from('ad_settings').select('*').eq('id', 'default').maybeSingle()
  if (stErr) throw new Error(`ad_settings: ${dbFehler(stErr)}`)
  const s = (st ?? {}) as Record<string, unknown>
  const level = toNum(s.pool_auto_release_level) ?? 0
  const schwelle = toNum(s.pool_auto_release_threshold) ?? 0.9
  const defaultLink = toStr(s.default_link) ?? 'https://portal.happy-property.com/termin'
  const minScore = await minReviewScore(sb)

  const ents = await ladeEntscheidungen(sb)
  const namen = await verboteneNamen(sb)

  let q = sb.from('ad_creative_pool').select(POOL_SPALTEN).eq('status', 'entwurf')
  if (opts.ids?.length) q = q.in('id', opts.ids.slice(0, 50))
  const { data, error } = await q.order('created_at').limit(50)
  if (error) throw new Error(`ad_creative_pool: ${dbFehler(error)}`)
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const p = poolAus(r)
    try {
      const qa = await pruefeEintrag(p, namen, defaultLink, minScore)
      const prog = prognoseFuer(p, ents, qa.note)
      const patch: Record<string, unknown> = {
        qa: {
          ...qa,
          geprueft_at: opts.now.toISOString(),
          min_review_score: minScore,
          prognose_basis: prog.basis,
        },
        prognose: prog.wert,
      }
      if (qa.fakten.length && !p.fakten_pruefung) patch.fakten_pruefung = true
      if (qa.bestanden) patch.status = 'geprueft'
      const { data: upd, error: uErr } = await sb.from('ad_creative_pool').update(patch).eq('id', p.id).eq('status', 'entwurf').select('id')
      if (uErr) throw new Error(dbFehler(uErr))
      if (!Array.isArray(upd) || !upd.length) { erg.fehler.push(`${p.kennung}: inzwischen geändert, nicht geprüft`); continue }
      if (qa.bestanden) erg.geprueft++
      else erg.bleibt_entwurf++
      erg.prognosen++
      erg.details.push({
        id: p.id, kennung: p.kennung, ergebnis: qa.bestanden ? 'geprueft' : 'entwurf',
        fehlend: qa.fehlend, note: qa.note, prognose: prog.wert, fakten: qa.fakten,
      })
    } catch (err) {
      erg.fehler.push(`${p.kennung}: ${errMsg(err).slice(0, 200)}`)
    }
  }

  erg.auto_freigabe = await autoFreigabe(sb, { level, schwelle, ents })
  erg.auto_freigegeben = Number(erg.auto_freigabe.freigegeben ?? 0)
  return erg
}

async function minReviewScore(sb: Sb): Promise<number> {
  const { data } = await sb.from('ad_autopilot_rules').select('params').eq('rule_key', 'POOL_UPLOAD').maybeSingle()
  const p = ((data as { params?: Record<string, unknown> } | null)?.params ?? {}) as Record<string, unknown>
  return toNum(p.min_review_score) ?? MIN_REVIEW_SCORE
}

/** Automatische Freigabe geprüfter Einträge (Stufe 2: Schwelle + 30 Entscheidungen + Trefferquote 90 %; Stufe 3: immer). */
async function autoFreigabe(sb: Sb, o: { level: number; schwelle: number; ents: Entscheidung[] }): Promise<Record<string, unknown>> {
  const menschen = o.ents.filter(e => e.mensch).length
  const ueb = uebereinstimmung(o.ents, o.schwelle)
  const info: Record<string, unknown> = {
    stufe: o.level, schwelle: o.schwelle, entscheidungen_mensch: menschen,
    trefferquote: ueb.quote, trefferquote_faelle: ueb.faelle, freigegeben: 0, uebersprungen: [] as unknown[],
  }
  if (o.level < 2) { info.grund = 'Stufe unter 2: nur manuelle Freigabe'; return info }
  if (o.level === 2 && (menschen < 30 || ueb.faelle < 10 || (ueb.quote ?? 0) < 0.9)) {
    info.grund = 'Stufe 2: noch nicht genug Entscheidungen oder Trefferquote unter 90 %'
    return info
  }
  const { data, error } = await sb.from('ad_creative_pool').select('id, kennung, prognose, fakten_pruefung')
    .eq('status', 'geprueft').order('created_at').limit(20)
  if (error) { info.fehler = dbFehler(error); return info }
  const ueber = info.uebersprungen as unknown[]
  let n = 0
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const prog = toNum(r.prognose)
    if (r.fakten_pruefung === true) { ueber.push({ kennung: r.kennung, grund: 'fakten_pruefung' }); continue }
    if (o.level === 2 && (prog == null || prog < o.schwelle)) { ueber.push({ kennung: r.kennung, grund: 'prognose_unter_schwelle', prognose: prog }); continue }
    const grund = `automatisch (Stufe ${o.level}, Prognose ${prog == null ? '-' : prog.toFixed(2)})`
    const { error: rErr } = await sb.rpc('werbe_pool_entscheiden', { p_pool_id: r.id, p_entscheidung: 'freigeben', p_grund: grund })
    if (rErr) { ueber.push({ kennung: r.kennung, grund: dbFehler(rErr) }); continue }
    n++
  }
  info.freigegeben = n
  return info
}

/** Prognose für offene Einträge (entwurf/geprueft) neu berechnen. */
export async function prognosenAuffrischen(sb: Sb): Promise<{ aktualisiert: number; geprueft: number }> {
  const ents = await ladeEntscheidungen(sb)
  const { data, error } = await sb.from('ad_creative_pool').select('id, winkel, format, review_score, qa, prognose')
    .in('status', ['entwurf', 'geprueft']).order('created_at').limit(300)
  if (error) throw new Error(`ad_creative_pool: ${dbFehler(error)}`)
  let n = 0, g = 0
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    g++
    const qa = (r.qa && typeof r.qa === 'object') ? r.qa as Record<string, unknown> : {}
    const score = toNum(r.review_score) ?? toNum(qa.pruefnote)
    const prog = prognoseFuer({ winkel: toStr(r.winkel), format: toStr(r.format) }, ents, score)
    const alt = toNum(r.prognose)
    if (alt != null && Math.abs(alt - prog.wert) < 0.005) continue
    const { error: uErr } = await sb.from('ad_creative_pool')
      .update({ prognose: prog.wert, qa: { ...qa, prognose_basis: prog.basis } }).eq('id', r.id)
    if (uErr) { console.warn('[werbe-autopilot] Prognose:', dbFehler(uErr)); continue }
    n++
  }
  return { aktualisiert: n, geprueft: g }
}

// ── Bestand + Briefs (wöchentlich) ──────────────────────────────────────────

function poolParams(regeln: Array<{ rule_key: string; params?: Record<string, unknown> | null }>): Record<string, unknown> {
  return regeln.find(r => r.rule_key === 'POOL_UPLOAD')?.params ?? {}
}

/** Vorrat freigegebener, noch nicht hochgeladener Werbemittel gegen min_pool_ready. */
export async function vorratBestand(sb: Sb, regeln: Array<{ rule_key: string; params?: Record<string, unknown> | null }>, laufId: string | null): Promise<{
  freigegeben: number; min_pool_ready: number; niedrig: boolean
}> {
  const min = toNum(poolParams(regeln).min_pool_ready) ?? 4
  const { data, error } = await sb.from('ad_creative_pool').select('id').eq('status', 'freigegeben').limit(500)
  if (error) throw new Error(`ad_creative_pool: ${dbFehler(error)}`)
  const n = Array.isArray(data) ? data.length : 0
  const niedrig = n < min
  if (niedrig) {
    const { error: lErr } = await sb.from('ad_autopilot_log').insert({
      lauf_id: laufId, art: 'vorrat', entity_level: 'vorrat', aktion: 'bestand', ergebnis: 'vorrat_niedrig',
      evidence: { freigegeben: n, min_pool_ready: min, text: `Nur ${n} freigegebene Werbemittel im Vorrat (Ziel ${min}).` },
      akteur_art: 'system',
    })
    if (lErr) console.warn('[werbe-autopilot] Vorrat-Log:', dbFehler(lErr))
  }
  return { freigegeben: n, min_pool_ready: min, niedrig }
}

/**
 * Wöchentliche Briefs: Thompson Sampling über Winkel (Posterior Gamma(1,5 + TE,
 * 1,5 x Ziel + Spend) aus der Lebenszeit-Qualität je Kennung), 70 % Gewinner-Winkel,
 * 30 % wenig getestete Winkel. Legt Vorrat-Einträge 'entwurf' mit brief an.
 */
export async function briefsErstellen(
  sb: Sb,
  o: { heute: string; zielCpte: number; regeln: Array<{ rule_key: string; params?: Record<string, unknown> | null }>; bestand: { freigegeben: number; min_pool_ready: number } },
): Promise<Record<string, unknown>> {
  const pp = poolParams(o.regeln)
  const proWoche = Math.max(0, Math.min(6, Math.floor(toNum(pp.variants_per_week) ?? 2)))
  const exploit = Math.max(0, Math.min(1, toNum(pp.exploit_share) ?? 0.7))
  if (!proWoche) return { angelegt: 0, grund: 'variants_per_week = 0' }

  const pool = await alleZeilen<Record<string, unknown>>(
    async (a, b) => await sb.from('ad_creative_pool').select('kennung, winkel, status, quelle, texte').order('created_at').order('id').range(a, b),
    'ad_creative_pool', 3000)
  const leereBriefs = pool.filter(p => p.status === 'entwurf' && p.quelle === 'autopilot_brief' &&
    !Object.keys((p.texte && typeof p.texte === 'object') ? p.texte as Record<string, unknown> : {}).length).length
  if (leereBriefs >= 2 * proWoche) {
    return { angelegt: 0, grund: `${leereBriefs} Briefs noch unbearbeitet, keine neuen` }
  }
  let anzahl = proWoche
  if (o.bestand.freigegeben < o.bestand.min_pool_ready) {
    anzahl = Math.max(anzahl, Math.min(4, o.bestand.min_pool_ready - o.bestand.freigegeben))
  }

  // Lebenszeit-Qualität je Kennung (jüngster Stichtag)
  const { data: sd } = await sb.from('ad_quality_daily').select('stichtag').eq('entity_level', 'kennung').eq('fenster', 0)
    .order('stichtag', { ascending: false }).limit(1)
  const stichtag = (Array.isArray(sd) && sd[0]) ? String((sd[0] as { stichtag?: string }).stichtag ?? '') : ''
  const qual = stichtag
    ? await alleZeilen<Record<string, unknown>>(
      async (a, b) => await sb.from('ad_quality_daily').select('entity_id, spend_eur, te_capped')
        .eq('stichtag', stichtag).eq('entity_level', 'kennung').eq('fenster', 0).order('entity_id').range(a, b),
      'ad_quality_daily (Kennung)', 3000)
    : []
  const winkelVon = new Map<string, string>()
  for (const p of pool) if (toStr(p.winkel)) winkelVon.set(String(p.kennung), String(p.winkel))

  const arme = new Map<string, ThompsonArm>()
  const winkelListe = Array.isArray(pp.winkel) ? (pp.winkel as unknown[]).map(String).filter(Boolean) : WINKEL_STANDARD
  for (const w of winkelListe) arme.set(w, { schluessel: w, te: 0, spend_eur: 0, getestet: 0 })
  for (const w of winkelVon.values()) if (!arme.has(w)) arme.set(w, { schluessel: w, te: 0, spend_eur: 0, getestet: 0 })
  let zugeordnet = 0
  for (const z of qual) {
    const id = String(z.entity_id ?? '')
    const basis = id.slice(id.indexOf(':') + 1)
    const w = winkelVon.get(basis)
    if (!w) continue
    const arm = arme.get(w) as ThompsonArm
    const spend = toNum(z.spend_eur) ?? 0
    arm.te += toNum(z.te_capped) ?? 0
    arm.spend_eur += spend
    if (spend > 0) arm.getestet = (arm.getestet ?? 0) + 1
    zugeordnet++
  }
  const liste = [...arme.values()].sort((a, b) => (a.schluessel < b.schluessel ? -1 : 1))
  if (!liste.length) return { angelegt: 0, grund: 'keine Winkel' }
  const kw = isoWoche(o.heute)
  const anteile = thompsonAnteile(liste, { draws: 4000, exploit, seed: kw.jahr * 100 + kw.woche, prior_cpte: o.zielCpte, min_getestet: 2 })

  // Plätze nach größtem Rest verteilen (deterministisch)
  const roh = anteile.map(a => ({ a, soll: a.anteil * anzahl }))
  const plaetze = new Map<string, number>(roh.map(r => [r.a.schluessel, Math.floor(r.soll)]))
  let rest = anzahl - [...plaetze.values()].reduce((x, y) => x + y, 0)
  for (const r of roh.slice().sort((x, y) => (y.soll - Math.floor(y.soll)) - (x.soll - Math.floor(x.soll)) || y.a.p_best - x.a.p_best || (x.a.schluessel < y.a.schluessel ? -1 : 1))) {
    if (rest <= 0) break
    plaetze.set(r.a.schluessel, (plaetze.get(r.a.schluessel) ?? 0) + 1)
    rest--
  }

  const kwText = `${kw.jahr}-KW${String(kw.woche).padStart(2, '0')}`
  let i = 0, angelegt = 0
  const ergebnisse: Array<Record<string, unknown>> = []
  for (const a of anteile) {
    const n = plaetze.get(a.schluessel) ?? 0
    for (let k = 0; k < n; k++) {
      i++
      const kennung = `brief-${kw.jahr}-kw${String(kw.woche).padStart(2, '0')}-${i}-${slugify(a.schluessel).slice(0, 40) || 'winkel'}`
      const arm = arme.get(a.schluessel) as ThompsonArm
      const { error } = await sb.from('ad_creative_pool').insert({
        kennung, status: 'entwurf', winkel: a.schluessel, format: 'bild', quelle: 'autopilot_brief',
        laender: ['DE'], cta: 'BOOK_NOW',
        brief: {
          art: 'thompson', woche: kwText, winkel: a.schluessel,
          p_best: Math.round(a.p_best * 1000) / 1000, anteil: Math.round(a.anteil * 1000) / 1000, exploration: a.exploration,
          basis: { te: Math.round(arm.te * 100) / 100, spend_eur: Math.round(arm.spend_eur), getestet: arm.getestet ?? 0, ziel_cpte_eur: o.zielCpte },
          formate: ['4:5 (1080 x 1350)', '9:16 (1080 x 1920)'],
          pflicht: [
            'Ab Sekunde 1 sichtbar: Immobilien auf Zypern · EU',
            'Keine Rendite- oder Wertzuwachs-Prozente, keine Finanzierungsversprechen',
            'Keine Projekt- oder Bauträgernamen, auch nicht in Dateinamen',
            'Echte Umlaute, keine Gedankenstriche',
          ],
        },
      })
      if (error) {
        ergebnisse.push({ kennung, fehler: dbFehler(error) })
        continue
      }
      angelegt++
      ergebnisse.push({ kennung, winkel: a.schluessel, exploration: a.exploration })
    }
  }
  return {
    angelegt, anzahl_ziel: anzahl, woche: kwText, stichtag: stichtag || null, kennungen_zugeordnet: zugeordnet,
    anteile: anteile.map(a => ({ winkel: a.schluessel, p_best: Math.round(a.p_best * 1000) / 1000, anteil: Math.round(a.anteil * 1000) / 1000, exploration: a.exploration })),
    briefs: ergebnisse,
  }
}
