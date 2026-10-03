// IDENTISCH zu src/lib/metaLint.ts (bzw. supabase/functions/_shared/metaLint.ts). Änderungen immer in beiden Dateien; npm run verify:meta prüft das.
//
// HP-Compliance-Prüfung für Werbetexte und Werbemittel - live im Assistenten
// (Frontend) und noch einmal serverseitig in meta-builder (validate/create) und
// im Werbemittel-Vorrat. Rein, ohne Imports (Strukturtypen statt metaSpec-Import,
// damit auch Vorrat-Einträge geprüft werden können).
//
// Schweregrade:
//   blocker = darf so nicht zu Meta (Admin kann mit Begründung übergehen, wird geloggt)
//   warn    = sollte besser werden
//   manual  = muss ein Mensch bestätigen (EU-Band ab Sekunde 1, KI-Kennzeichnung)
//
// Regeln (Sven): keine Gedankenstriche (U+2012-U+2015), echte Umlaute statt ae/oe/ue,
// keine Rendite-/Wertzuwachs-Prozente, keine Finanzierungsversprechen, nie Projekt-
// oder Bauträgernamen (auch nicht in Dateinamen), Überschrift <= 40, Beschreibung <= 30,
// AfA „5 %" nur mit Pflichtsatz, kein DE-Bashing, Links nur auf eigene Domains.
// Kompiliert unter src/tsconfig (strict, ES2020) und Deno: kein Lookbehind, kein .at().

/** Verbotene Versprechen - Meta-Ablehnung und rechtliches Risiko (aus adCopy.ts hierher verschoben). */
export const FORBIDDEN: readonly RegExp[] = [
  /\bgarantiert\w*\b/i, /\bgarantie\b/i, /\brisikolos\b/i, /\bohne\s+risiko\b/i,
  /\bsichere\s+(rendite|gewinne?)\b/i, /\b100\s*%\s*sicher\b/i, /\btodsicher\b/i,
  /\bkein\s+risiko\b/i, /\bverdopp(le|elt|eln)\s+dein\b/i,
]

/** Metas Regel zu persönlichen Eigenschaften: nicht unterstellen, wer jemand ist (aus adCopy.ts). */
export const PERSONAL_ATTRIBUTE: readonly RegExp[] = [
  /\b(als|du\s+als)\s+(arzt|ärztin|zahnarzt|zahnärztin|apotheker\w*|unternehmer\w*|beamt\w+|rentner\w*|selbstständig\w*|anwalt|anwältin|steuerberater\w*)\b/i,
  /\bleidest\s+du\b/i, /\bhast\s+du\s+(probleme|angst|sorgen)\b/i,
  /\bdu\s+bist\s+(arzt|ärztin|unternehmer\w*|beamt\w+|rentner\w*)\b/i,
]

/** Figure Dash, En Dash, Em Dash, Horizontal Bar */
export const DASH_CHARS = /[\u2012-\u2015]/

/** Pflichtsatz, sobald eine Anzeige „5 % AfA" nennt (Neubau-AfA gilt auch in Deutschland). */
export const AFA_PFLICHTSATZ = 'Neubauten in Deutschland bekommen ebenfalls 5 % AfA, sind dort aber kaum bezahlbar.'

/** Eigene Ziel-Domains (Links woanders hin = Hinweis). */
export const LINT_ALLOWED_HOSTS: readonly string[] = [
  'portal.happy-property.com', 'happy-property.de', 'www.happy-property.de',
  'steuervorteil-zypern-immobilien.com', 'www.steuervorteil-zypern-immobilien.com',
]

export const HEADLINE_MAX = 40
export const DESCRIPTION_MAX = 30
export const PRIMARY_VISIBLE = 125

export type LintSeverity = 'blocker' | 'warn' | 'manual'
export const LINT_RULES = [
  'gedankenstrich', 'umlaut', 'rendite_prozent', 'finanzierung', 'projektname', 'garantie',
  'persoenlich', 'ueberschrift_lang', 'beschreibung_lang', 'primaertext_satz', 'afa_pflichtsatz',
  'de_bashing', 'url_host', 'eu_band', 'ki_label',
] as const
export type LintRule = typeof LINT_RULES[number]
export const lintMessageKey = (rule: LintRule): string => `crm.werbung.lint.${rule}`
export const LINT_SEVERITY_KEYS: Readonly<Record<LintSeverity, string>> = {
  blocker: 'crm.werbung.lint.severity.blocker',
  warn: 'crm.werbung.lint.severity.warn',
  manual: 'crm.werbung.lint.severity.manual',
}
export function allLintKeys(): string[] {
  const out = LINT_RULES.map(lintMessageKey)
  for (const k of Object.keys(LINT_SEVERITY_KEYS)) out.push(LINT_SEVERITY_KEYS[k as LintSeverity])
  return out
}

export interface LintIssue {
  severity: LintSeverity
  rule: LintRule
  /** key der Anzeige (oder 'campaign' / Anzeigengruppen-key) */
  node?: string
  /** FieldSpec.key aus metaSpec, z. B. 'ad.headlines' */
  field: string
  messageKey: string
  /** gefundene Stelle */
  match?: string
  params?: Record<string, string | number>
}

export interface LintMediaInfo {
  name?: string | null
  file_name?: string | null
  storage_path?: string | null
  public_url?: string | null
  ai_generated?: boolean | null
  eu_band_confirmed?: boolean | null
  ki_label_confirmed?: boolean | null
}
export interface LintContext {
  /** Projekt- und Bauträgernamen (crm_projects.name, developers.name) */
  forbiddenNames: string[]
  /** meta_media-Zeilen nach id (Dateiname, Bestätigungen) */
  media?: Record<string, LintMediaInfo>
  allowedHosts?: readonly string[]
}
export interface LintMediaRef { media_id?: string }
/** Strukturell kompatibel zu metaSpec AdDraft (und zu Vorrat-Einträgen). */
export interface LintAdInput {
  key?: string
  name?: string
  primary_texts?: string[]
  headlines?: string[]
  descriptions?: string[]
  destination?: { kind: string; url?: string; display_link?: string }
  media?: {
    feed_4x5?: LintMediaRef
    story_9x16?: LintMediaRef
    square_1x1?: LintMediaRef
    cards?: Array<{ headline?: string; description?: string; url?: string; media?: LintMediaRef }>
  }
}
/** Strukturell kompatibel zu metaSpec DraftSpec. */
export interface LintDraftInput {
  campaign?: { name?: string }
  adsets?: Array<{ key?: string; name?: string }>
  ads?: LintAdInput[]
}

// ── Muster ──────────────────────────────────────────────────────────────────

const LETTER = 'A-Za-zÄÖÜäöüß'
/** ae/oe/ue-Ersatz am Wortanfang */
const UMLAUT_START = new RegExp(`(^|[^${LETTER}])(fuer|sued|waere|haett|ueb|oeff|aelter|aerger|aender|aehnlich|oesterreich|uebrig)`, 'i')
/** ae/oe/ue-Ersatz irgendwo im Wort (nur eindeutige Stämme; nicht Steuer, neue, Feuer, teuer, Dauer, Bauer, Euer) */
const UMLAUT_ANY = new RegExp('(' + [
  'ueber', 'moeglich', 'koenn', 'grundstueck', 'haeuser', 'gebaeude', 'waehr', 'muess', 'wuerd', 'zurueck',
  'frueh', 'spaet', 'groess', 'fuehr', 'fuehl', 'naech', 'naehe', 'taeglich', 'jaehr', 'moecht', 'erklaer',
  'oeffentlich', 'ueblich', 'pruef', 'gruend', 'kuend', 'buero', 'staedt', 'laender', 'europaeisch',
  'guenst', 'gueltig', 'verguet', 'zuschuess', 'loesung', 'schluess', 'maerz', 'koerper', 'moebel', 'moebl',
  'kuech', 'baeder', 'unterstuetz', 'saetz', 'traeg', 'faellig', 'haelfte', 'praemie', 'itaet', 'gebuehr',
  'fuenf', 'zwoelf', 'muench', 'duesseldorf', 'koeln', 'hoeh', 'schoen', 'duerf', 'kaeuf', 'raeum', 'maenn',
  'faehig', 'gaeng', 'staerk', 'waerm', 'boerse', 'geraet', 'stueck', 'glueck', 'gruen', 'tuer',
  'aender', 'aehnlich', 'aelter',
].join('|') + ')', 'i')

/** Prozentzahl (8 %, 8%, 8,5 Prozent) */
const PERCENT = /\d+(?:[.,]\d+)?\s?(?:%|prozent\b)/gi
/** Rendite-/Wertzuwachs-Wörter im Umfeld einer Prozentzahl (Vertrag ausgenommen) */
const YIELD_WORDS = /rendite|(?:^|[^v])ertr(?:a|ä|ae)g|wertsteigerung|wertzuwachs|zins|\broi\b|\breturn/i
const YIELD_WINDOW = 40

const FINANZIERUNG: readonly RegExp[] = [
  /finanzierung\w*(?:\s+\S+){0,2}?\s+(?:garantiert|gesichert|zugesagt|sicher)\b/i,
  /(?:garantierte|gesicherte|zugesagte|sichere)\s+(?:\S+\s+)?finanzierung/i,
  /100\s?%\s?(?:finanzier|fremdfinanzier)/i,
  /ohne\s+eigenkapital/i,
  /ohne\s+schufa/i,
  /kredit\w*(?:\s+\S+){0,2}?\s+(?:garantiert|zugesagt)\b/i,
  /finanzierung\s+f(?:ü|ue)r\s+(?:jeden|alle)\b/i,
]

const DE_BASHING: readonly RegExp[] = [
  /raus\s+aus\s+deutschland/i,
  /deutschland\s+ist\s+(?:am\s+ende|verloren|kaputt|pleite|erledigt)/i,
  /deutschland\s+(?:geht\s+)?(?:den\s+bach\s+runter|vor\s+die\s+hunde|zugrunde)/i,
  /flucht\s+aus\s+deutschland/i,
  /deutschland\s+(?:endlich\s+)?verlassen/i,
  /steuerh(?:ö|oe)lle/i,
  /abzocke\s+(?:durch\s+den\s+staat|in\s+deutschland)/i,
]

const AFA_MENTION = /\b(?:afa|abschreibung\w*)\b/i
const FIVE_PERCENT = /(?:^|[^\d,.])5\s?(?:%|prozent\b)/i
const AFA_SATZ = /neubau\w*[^.!?\n]{0,80}deutschland[^.!?\n]{0,80}(?:ebenfalls|auch)[^.!?\n]{0,40}5\s?(?:%|prozent)|(?:auch|ebenfalls)[^.!?\n]{0,40}deutschland[^.!?\n]{0,80}5\s?(?:%|prozent)/i

// ── Helfer ──────────────────────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Kleinbuchstaben, Umlaute ausgeschrieben, alles andere zu '-' (für Dateinamen/URLs) */
export function slugify(s: string): string {
  return (s ?? '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
const snippet = (s: string, i: number, len: number): string => s.slice(Math.max(0, i - 15), Math.min(s.length, i + len + 15)).trim()

interface NameMatcher { name: string; re: RegExp; slug: string }
function nameMatchers(names: readonly string[]): NameMatcher[] {
  const out: NameMatcher[] = []
  const seen: string[] = []
  for (const raw of names ?? []) {
    const n = (raw ?? '').trim()
    if (n.length < 3) continue
    const low = n.toLowerCase()
    if (seen.indexOf(low) >= 0) continue
    seen.push(low)
    out.push({
      name: n,
      re: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(n)}(?:$|[^\\p{L}\\p{N}])`, 'iu'),
      slug: slugify(n),
    })
  }
  return out
}

/** Prüft EINEN kundensichtbaren Text auf die textbezogenen Regeln. */
export function lintText(text: string, field: string, ctx: LintContext, node?: string): LintIssue[] {
  const out: LintIssue[] = []
  const s = text ?? ''
  if (!s.trim()) return out
  const add = (severity: LintSeverity, rule: LintRule, match?: string, params?: Record<string, string | number>) =>
    out.push({ severity, rule, field, messageKey: lintMessageKey(rule), ...(node ? { node } : {}), ...(match ? { match } : {}), ...(params ? { params } : {}) })

  const dash = DASH_CHARS.exec(s)
  if (dash) add('blocker', 'gedankenstrich', snippet(s, dash.index, 1))

  const us = UMLAUT_START.exec(s)
  const ua = UMLAUT_ANY.exec(s)
  if (us) add('blocker', 'umlaut', snippet(s, us.index + us[1].length, us[2].length))
  else if (ua) add('blocker', 'umlaut', snippet(s, ua.index, ua[1].length))

  PERCENT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PERCENT.exec(s)) !== null) {
    const from = Math.max(0, m.index - YIELD_WINDOW)
    const to = Math.min(s.length, m.index + m[0].length + YIELD_WINDOW)
    // ein Zeichen mehr nach links, damit ein angeschnittenes „Vertrag" nicht als „ertrag" zählt
    if (YIELD_WORDS.test(s.slice(Math.max(0, from - 1), to))) { add('blocker', 'rendite_prozent', s.slice(from, to).trim()); break }
  }
  PERCENT.lastIndex = 0

  for (const re of FINANZIERUNG) {
    const f = re.exec(s)
    if (f) { add('blocker', 'finanzierung', f[0].trim()); break }
  }
  for (const re of FORBIDDEN) {
    const f = s.match(re)
    if (f) { add('blocker', 'garantie', f[0]); break }
  }
  for (const re of PERSONAL_ATTRIBUTE) {
    const f = s.match(re)
    if (f) { add('blocker', 'persoenlich', f[0]); break }
  }
  for (const nm of nameMatchers(ctx.forbiddenNames)) {
    if (nm.re.test(s)) { add('blocker', 'projektname', nm.name); break }
  }
  for (const re of DE_BASHING) {
    const f = s.match(re)
    if (f) { add('warn', 'de_bashing', f[0]); break }
  }
  return out
}

const isAfaFive = (s: string): boolean => AFA_MENTION.test(s) && FIVE_PERCENT.test(s)
const hostOf = (url: string): string | null => {
  const m = /^https?:\/\/([^/?#:]+)/i.exec((url ?? '').trim())
  return m ? m[1].toLowerCase() : null
}

/** Prüft eine Anzeige (Texte, Längen, Ziel-URL, Medien). */
export function lintAd(ad: LintAdInput, ctx: LintContext): LintIssue[] {
  const out: LintIssue[] = []
  const node = ad.key
  const add = (severity: LintSeverity, rule: LintRule, field: string, match?: string, params?: Record<string, string | number>) =>
    out.push({ severity, rule, field, messageKey: lintMessageKey(rule), ...(node ? { node } : {}), ...(match ? { match } : {}), ...(params ? { params } : {}) })
  const texts = (list?: string[]) => (list ?? []).map(x => x ?? '').filter(x => x.trim())

  const primaries = texts(ad.primary_texts)
  const headlines = texts(ad.headlines)
  const descriptions = texts(ad.descriptions)
  const cards = ad.media?.cards ?? []

  // Name: nur Gedankenstrich (intern, aber taucht in Meta-Listen auf)
  const nameDash = DASH_CHARS.exec(ad.name ?? '')
  if (nameDash) add('blocker', 'gedankenstrich', 'ad.name', snippet(ad.name ?? '', nameDash.index, 1))

  primaries.forEach((t, i) => {
    for (const iss of lintText(t, 'ad.primary_texts', ctx, node)) out.push({ ...iss, params: { ...(iss.params ?? {}), index: i + 1 } })
    if (t.length >= PRIMARY_VISIBLE && !/[.!?:]/.test(t.slice(0, PRIMARY_VISIBLE)))
      add('warn', 'primaertext_satz', 'ad.primary_texts', undefined, { index: i + 1, max: PRIMARY_VISIBLE })
    if (isAfaFive(t) && !AFA_SATZ.test(t)) add('blocker', 'afa_pflichtsatz', 'ad.primary_texts', undefined, { index: i + 1 })
  })
  headlines.forEach((t, i) => {
    for (const iss of lintText(t, 'ad.headlines', ctx, node)) out.push({ ...iss, params: { ...(iss.params ?? {}), index: i + 1 } })
    if (t.trim().length > HEADLINE_MAX) add('blocker', 'ueberschrift_lang', 'ad.headlines', t.trim().slice(0, 50), { index: i + 1, len: t.trim().length, max: HEADLINE_MAX })
  })
  descriptions.forEach((t, i) => {
    for (const iss of lintText(t, 'ad.descriptions', ctx, node)) out.push({ ...iss, params: { ...(iss.params ?? {}), index: i + 1 } })
    if (t.trim().length > DESCRIPTION_MAX) add('blocker', 'beschreibung_lang', 'ad.descriptions', t.trim().slice(0, 40), { index: i + 1, len: t.trim().length, max: DESCRIPTION_MAX })
  })
  // AfA in Überschrift/Beschreibung: jede Textvariante braucht den Pflichtsatz
  if ([...headlines, ...descriptions].some(isAfaFive) && (!primaries.length || primaries.some(t => !AFA_SATZ.test(t))))
    add('blocker', 'afa_pflichtsatz', 'ad.headlines')

  cards.forEach((cd, i) => {
    const h = (cd?.headline ?? '').trim()
    const d = (cd?.description ?? '').trim()
    for (const iss of lintText(h, 'ad.media.cards', ctx, node)) out.push({ ...iss, params: { ...(iss.params ?? {}), index: i + 1 } })
    for (const iss of lintText(d, 'ad.media.cards', ctx, node)) out.push({ ...iss, params: { ...(iss.params ?? {}), index: i + 1 } })
    if (h.length > HEADLINE_MAX) add('blocker', 'ueberschrift_lang', 'ad.media.cards', h.slice(0, 50), { index: i + 1, len: h.length, max: HEADLINE_MAX })
    if (d.length > DESCRIPTION_MAX) add('blocker', 'beschreibung_lang', 'ad.media.cards', d.slice(0, 40), { index: i + 1, len: d.length, max: DESCRIPTION_MAX })
  })

  // Ziel-URLs + angezeigter Link
  const hosts = ctx.allowedHosts ?? LINT_ALLOWED_HOSTS
  const urls: Array<[string, string]> = []
  if (ad.destination?.kind === 'website') {
    if (ad.destination.url) urls.push(['ad.destination.url', ad.destination.url])
    for (const cd of cards) if (cd?.url) urls.push(['ad.media.cards', cd.url])
    if (ad.destination.display_link) {
      for (const iss of lintText(ad.destination.display_link, 'ad.destination.display_link', ctx, node)) out.push(iss)
    }
  }
  const names = nameMatchers(ctx.forbiddenNames)
  for (const [field, url] of urls) {
    const h = hostOf(url)
    if (h && hosts.indexOf(h) < 0) add('warn', 'url_host', field, h)
    const slug = `-${slugify(url)}-`
    for (const nm of names) if (nm.slug && slug.indexOf(`-${nm.slug}-`) >= 0) { add('blocker', 'projektname', field, nm.name); break }
    if (DASH_CHARS.test(url)) add('blocker', 'gedankenstrich', field, url.slice(0, 60))
  }

  // Medien: Dateinamen ohne Projektnamen, EU-Band + KI-Kennzeichnung bestätigt
  const refs: Array<[string, LintMediaRef | undefined]> = [
    ['ad.media.feed_4x5', ad.media?.feed_4x5],
    ['ad.media.story_9x16', ad.media?.story_9x16],
    ['ad.media.square_1x1', ad.media?.square_1x1],
    ...cards.map((cd): [string, LintMediaRef | undefined] => ['ad.media.cards', cd?.media]),
  ]
  const done: string[] = []
  for (const [field, ref] of refs) {
    const id = ref?.media_id
    if (!id || done.indexOf(id) >= 0) continue
    done.push(id)
    const info = ctx.media?.[id]
    const files = [info?.name, info?.file_name, info?.storage_path, info?.public_url].filter((x): x is string => !!x)
    for (const fname of files) {
      const slug = `-${slugify(fname)}-`
      const hit = names.find(nm => nm.slug && slug.indexOf(`-${nm.slug}-`) >= 0)
      if (hit) { add('blocker', 'projektname', field, hit.name, { media_id: id }); break }
    }
    if (info?.eu_band_confirmed !== true) add('manual', 'eu_band', field, undefined, { media_id: id })
    if (info?.ki_label_confirmed !== true) add('manual', 'ki_label', field, undefined, { media_id: id })
  }
  return out
}

/** Prüft den ganzen Entwurf: Namen (Gedankenstrich) + jede Anzeige. */
export function lintDraft(spec: LintDraftInput, ctx: LintContext): LintIssue[] {
  const out: LintIssue[] = []
  const cn = spec?.campaign?.name ?? ''
  const cd = DASH_CHARS.exec(cn)
  if (cd) out.push({ severity: 'blocker', rule: 'gedankenstrich', node: 'campaign', field: 'campaign.name', messageKey: lintMessageKey('gedankenstrich'), match: snippet(cn, cd.index, 1) })
  for (const a of spec?.adsets ?? []) {
    const n = a?.name ?? ''
    const ad = DASH_CHARS.exec(n)
    if (ad) out.push({ severity: 'blocker', rule: 'gedankenstrich', ...(a.key ? { node: a.key } : {}), field: 'adset.name', messageKey: lintMessageKey('gedankenstrich'), match: snippet(n, ad.index, 1) })
  }
  for (const ad of spec?.ads ?? []) for (const iss of lintAd(ad, ctx)) out.push(iss)
  return out
}

export const lintHasBlockers = (issues: readonly LintIssue[]): boolean => issues.some(i => i.severity === 'blocker')
export const lintCounts = (issues: readonly LintIssue[]): Record<LintSeverity, number> => {
  const c: Record<LintSeverity, number> = { blocker: 0, warn: 0, manual: 0 }
  for (const i of issues) c[i.severity]++
  return c
}
