// Werbetext-Handwerk fuer den Werbemanager — das "Agenturwissen" an EINER Stelle.
//
// Sven-Vorgabe (26.8.2026): Der Werbemanager soll arbeiten wie eine Agentur mit
// grossem Online-Marketing-Wissen, nicht wie ein Textgenerator. Zwei Bausteine:
//
//   1. STRUKTUR ERZWINGEN — die KI liefert keinen freien Fliesstext, sondern
//      benannte Bausteine (Hook, Schmerz, Mechanismus, Beweis, Vorteile, CTA).
//      Daraus baut composeMessage() die Caption in immer derselben, bewaehrten
//      Reihenfolge. Danach prueft checkAd() hart nach: Was durchfaellt, geht
//      zurueck an die KI, bevor Sven es ueberhaupt sieht.
//   2. PLAYBOOK — die Regeln, nach denen getextet und geprueft wird, stehen
//      hier als Klartext und gehen in JEDEN Prompt. Svens gelernte Regeln aus
//      ads_ai_rules kommen zusaetzlich obendrauf.
//
// ACHTUNG: Jede Edge Function buendelt ihre eigene Kopie der _shared-Dateien.
// Nach Aenderungen hier alle Importeure neu deployen.

/** Die benannten Bausteine einer Einzelbild-/Karussell-Anzeige. */
export interface AdCopy {
  /** Erste Zeile. Muss allein verkaufen — Meta kappt nach ~125 Zeichen. */
  hook: string
  /** Der Schmerzpunkt, in Svens Sprache. */
  problem: string
  /** Wie es funktioniert — der Weg, nicht das Versprechen. */
  mechanism: string
  /** Beweis mit Zahl (Steuersatz, Rendite, Anzahl Kunden, Zeitraum). */
  proof: string
  /** 3 Vorteile, je eine Zeile. */
  benefits: string[]
  /** Naechster Schritt inklusive Aufwand ("30 Minuten, unverbindlich"). */
  cta: string
}

export interface AdIssue {
  /** blocker = darf so nicht raus, hinweis = sollte besser werden */
  severity: 'blocker' | 'hinweis'
  field: string
  problem: string
  fix: string
}

// ── Playbook ────────────────────────────────────────────────────────────────
// Geht als Klartext in die Prompts. Kurz halten und nur, was messbar wirkt.
export const COPY_PLAYBOOK = `HANDWERKSREGELN (gelten IMMER):
1. Meta kappt den Text nach rund 125 Zeichen hinter "Mehr anzeigen". Der Hook muss allein verkaufen: Ergebnis oder Schmerz in der ERSTEN Zeile, kein Aufwärmen, keine Begrüßung.
2. Eine Anzeige, eine Idee. Nicht Steuer UND Rendite UND Verwaltung UND Aufenthaltstitel in einer Anzeige.
3. Konkret schlägt Adjektiv. "12,5 % statt 42 %" wirkt, "attraktive Rendite" nicht. Jede Behauptung braucht eine Zahl, einen Zeitraum oder ein Beispiel.
4. Zielgruppe ansprechen, aber NIE unterstellen. "Für Ärzte:" ist erlaubt, "Als Arzt zahlst du zu viel Steuern" verstößt gegen Metas Regel zu persönlichen Eigenschaften und wird abgelehnt.
5. Keine Garantien und keine Sicherheitsversprechen bei Geldanlagen. Kein "garantiert", "risikolos", "sichere Rendite". Das ist Ablehnungsgrund und rechtlich heikel.
6. Der CTA nennt den nächsten Schritt UND seinen Aufwand: "30 Minuten, unverbindlich, per Video". Nicht "Jetzt informieren".
7. Du-Ansprache, kurze Sätze, Absätze statt Textwand. Emojis sparsam und nur als Struktur (✅ 👉), nie als Dekoration.
8. Bild und erste Textzeile erzählen DIESELBE Sache. Wer das trennt, verliert die Aufmerksamkeit, die das Bild erzeugt hat.
9. Das Versprechen im Text muss auf der Landingpage wieder auftauchen (Terminseite). Kein Bruch zwischen Klick und Ziel.
10. NIEMALS Gedankenstrich (—) oder Bis-Strich (–), immer normaler Bindestrich.`

/** Verbotene Versprechen — Meta-Ablehnung und rechtliches Risiko. */
const FORBIDDEN = [
  /\bgarantiert\w*\b/i, /\bgarantie\b/i, /\brisikolos\b/i, /\bohne\s+risiko\b/i,
  /\bsichere\s+(rendite|gewinne?)\b/i, /\b100\s*%\s*sicher\b/i, /\btodsicher\b/i,
  /\bkein\s+risiko\b/i, /\bverdopp(le|elt|eln)\s+dein\b/i,
]

/** Metas Regel zu persönlichen Eigenschaften: nicht unterstellen, wer jemand ist. */
const PERSONAL_ATTRIBUTE = [
  /\b(als|du\s+als)\s+(arzt|ärztin|zahnarzt|zahnärztin|apotheker\w*|unternehmer\w*|beamt\w+|rentner\w*|selbstständig\w*|anwalt|anwältin|steuerberater\w*)\b/i,
  /\bleidest\s+du\b/i, /\bhast\s+du\s+(probleme|angst|sorgen)\b/i,
  /\bdu\s+bist\s+(arzt|ärztin|unternehmer\w*|beamt\w+|rentner\w*)\b/i,
]

const DASH = /[–—]/

const len = (s: string | undefined): number => (s ?? '').trim().length
const hasDigit = (s: string | undefined): boolean => /\d/.test(s ?? '')

/**
 * Baut die Caption aus den Bausteinen — immer dieselbe Reihenfolge, die in
 * unseren Gewinner-Anzeigen funktioniert hat: Hook, Schmerz, Mechanismus,
 * Vorteile als Haken, Beweis, Handlungsaufforderung.
 */
export function composeMessage(c: AdCopy): string {
  const blocks: string[] = []
  if (c.hook?.trim()) blocks.push(c.hook.trim())
  if (c.problem?.trim()) blocks.push(c.problem.trim())
  if (c.mechanism?.trim()) blocks.push(c.mechanism.trim())
  // Fuehrende Haken/Aufzaehlungszeichen abschneiden: die KI setzt sie gern
  // selbst, dann stuende "✅ ✅" in der Anzeige.
  const bens = (c.benefits ?? []).map(b => (b ?? '').replace(/^[\s✅✔️☑️•\-–—*]+/u, '').trim()).filter(Boolean)
  if (bens.length) blocks.push(bens.map(b => `✅ ${b}`).join('\n'))
  if (c.proof?.trim()) blocks.push(c.proof.trim())
  if (c.cta?.trim()) blocks.push(`👉 ${c.cta.trim()}`)
  return blocks.join('\n\n')
}

export interface AdCheckInput {
  headline?: string
  message?: string
  copy?: AdCopy | null
  overlay?: { badge?: string; subheadline?: string; checks?: string[] } | null
  cards?: Array<{ title?: string; description?: string }> | null
}

/**
 * Harte Qualitätsprüfung VOR der Anzeige. Blocker gehen einmal automatisch
 * zurück an die KI; was danach bleibt, sieht Sven im Studio.
 */
export function checkAd(ad: AdCheckInput): AdIssue[] {
  const out: AdIssue[] = []
  const add = (severity: AdIssue['severity'], field: string, problem: string, fix: string) =>
    out.push({ severity, field, problem, fix })

  const msg = (ad.message ?? '').trim()
  const c = ad.copy ?? null

  // ── Hook / Textanfang ─────────────────────────────────────────────────────
  const firstLine = msg.split('\n').find(l => l.trim())?.trim() ?? ''
  const hook = c?.hook?.trim() || firstLine
  if (!hook) add('blocker', 'hook', 'Der Text hat keine erste Zeile, die etwas verspricht.', 'Ergebnis oder Schmerzpunkt in die erste Zeile, max. 60 Zeichen.')
  else if (hook.length > 60) add('hinweis', 'hook', `Die erste Zeile ist ${hook.length} Zeichen lang.`, 'Auf 60 Zeichen kürzen, sonst wird sie im Feed abgeschnitten.')
  if (msg && msg.slice(0, 125).length === 125 && !/[.!?:]/.test(msg.slice(0, 125)))
    add('hinweis', 'message', 'In den ersten 125 Zeichen endet kein Satz.', 'Vor der "Mehr anzeigen"-Kante einen abgeschlossenen Gedanken liefern.')

  // ── Bausteine ─────────────────────────────────────────────────────────────
  if (c) {
    const bens = (c.benefits ?? []).map(b => (b ?? '').trim()).filter(Boolean)
    if (bens.length < 2) add('blocker', 'benefits', 'Weniger als zwei Vorteile.', 'Drei konkrete Vorteile liefern, je eine Zeile.')
    if (bens.length > 4) add('hinweis', 'benefits', 'Mehr als vier Vorteile.', 'Auf die drei stärksten kürzen.')
    for (const b of bens) {
      if (b.length > 60) add('hinweis', 'benefits', `Vorteil zu lang (${b.length} Zeichen): "${b.slice(0, 40)}…"`, 'Auf 60 Zeichen kürzen.')
    }
    if (bens.length && bens.filter(hasDigit).length < 2)
      add('hinweis', 'benefits', 'Kaum ein Vorteil nennt eine Zahl.', 'Mindestens zwei Vorteile mit Zahl, Prozentsatz oder Zeitraum belegen.')
    if (!c.proof?.trim()) add('hinweis', 'proof', 'Kein Beweis im Text.', 'Einen Beleg ergänzen: Steuersatz, Rendite, Anzahl Kunden, Zeitraum.')
    else if (!hasDigit(c.proof)) add('hinweis', 'proof', 'Der Beweis enthält keine Zahl.', 'Beweis mit einer konkreten Zahl belegen.')
    if (!c.cta?.trim()) add('blocker', 'cta', 'Keine Handlungsaufforderung.', 'Nächsten Schritt nennen, inklusive Aufwand ("30 Minuten, unverbindlich").')
    else if (len(c.cta) > 110) add('hinweis', 'cta', 'Die Handlungsaufforderung ist zu lang.', 'Auf einen Satz kürzen.')
    else if (!/\b(minute|termin|gespräch|call|video|anruf|kalender|unverbindlich)\b/i.test(c.cta))
      add('hinweis', 'cta', 'Die Handlungsaufforderung nennt weder den Schritt noch den Aufwand.', 'Konkret werden: "30 Minuten Videocall, unverbindlich".')
  }

  // ── Länge ─────────────────────────────────────────────────────────────────
  if (msg.length > 900) add('hinweis', 'message', `Der Text ist ${msg.length} Zeichen lang.`, 'Auf unter 900 Zeichen kürzen, im Feed liest das sonst niemand zu Ende.')
  if (msg && msg.length < 120) add('hinweis', 'message', 'Der Text ist sehr kurz.', 'Schmerzpunkt und Beweis ergänzen.')

  // ── Headline / Bildtexte ──────────────────────────────────────────────────
  if (len(ad.headline) > 40) add('hinweis', 'headline', `Die Überschrift ist ${len(ad.headline)} Zeichen lang.`, 'Auf 40 Zeichen kürzen, sonst kürzt Meta sie ab.')
  if (ad.overlay) {
    if (len(ad.overlay.badge) > 55) add('blocker', 'overlay.badge', 'Der Bild-Badge ist zu lang.', 'Auf 55 Zeichen kürzen, sonst deckt er das Motiv zu.')
    if (len(ad.overlay.subheadline) > 80) add('hinweis', 'overlay.subheadline', 'Die Bild-Subheadline ist zu lang.', 'Auf 80 Zeichen kürzen.')
    for (const ch of ad.overlay.checks ?? []) {
      if (len(ch) > 55) add('hinweis', 'overlay.checks', `Bild-Haken zu lang: "${(ch ?? '').slice(0, 40)}…"`, 'Auf 55 Zeichen kürzen.')
    }
  }
  for (const card of ad.cards ?? []) {
    if (len(card.title) > 35) add('hinweis', 'cards', `Kartentitel zu lang: "${(card.title ?? '').slice(0, 30)}…"`, 'Auf 35 Zeichen kürzen.')
    if (len(card.description) > 60) add('hinweis', 'cards', `Kartentext zu lang: "${(card.description ?? '').slice(0, 30)}…"`, 'Auf 60 Zeichen kürzen.')
  }

  // ── Regeln, die Anzeigen killen ───────────────────────────────────────────
  const all = [ad.headline, msg, ad.overlay?.badge, ad.overlay?.subheadline,
    ...(ad.overlay?.checks ?? []), ...(ad.cards ?? []).flatMap(c2 => [c2.title, c2.description])]
    .filter(Boolean).join('\n')
  for (const re of FORBIDDEN) {
    const m = all.match(re)
    if (m) { add('blocker', 'compliance', `"${m[0]}" ist ein Sicherheits-/Garantieversprechen.`, 'Streichen oder in eine belegbare Aussage umformulieren.'); break }
  }
  for (const re of PERSONAL_ATTRIBUTE) {
    const m = all.match(re)
    if (m) { add('blocker', 'compliance', `"${m[0]}" unterstellt dem Leser eine persönliche Eigenschaft — Meta lehnt das ab.`, 'Umformulieren: "Für Ärzte:" statt "Als Arzt …".'); break }
  }
  if (DASH.test(all)) add('blocker', 'stil', 'Im Text steht ein Gedankenstrich.', 'Normalen Bindestrich verwenden.')

  return out
}

/** Kurzfassung der Mängel für einen Korrektur-Prompt an die KI. */
export function issuesForPrompt(issues: AdIssue[]): string {
  return issues.map(i => `- [${i.severity}] ${i.field}: ${i.problem} → ${i.fix}`).join('\n')
}
