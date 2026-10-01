// Abmelde-Erkennung für Antwort-Mails („bitte aus dem Verteiler nehmen").
//
// Konservativ: nur eindeutige Bitten im EIGENEN Text des Kunden. Zitierte Mails
// werden vorher abgeschnitten, denn unser Newsletter-Footer enthält selbst
// „Abmelden" und manche Mail-Apps zitieren ohne „>" (Fall Kabert 18.9.:
// „Am 18.09.26 um 20:35 schrieb Sven …" mitten in der Zeile, danach der ganze
// Newsletter inkl. Footer). Lieber eine Abmeldung übersehen als jemanden
// fälschlich austragen.

// Ab hier beginnt Zitat, Signatur oder unser eigener Footer → alles danach ignorieren.
const CUT_MARKERS: RegExp[] = [
  /\b(am|on)\s[^\n]{0,80}?\b(schrieb|wrote)\b/i,             // „Am 18.09.26 um 20:35 schrieb …", „On … wrote"
  /^\s*(von|from|gesendet|sent|datum|date|an|to|betreff|subject)\s*:/im,
  /-{2,}\s*(ursprüngliche|original|weitergeleitete|forwarded)/i,
  /\b(gesendet|versendet)\s+(mit|von|vom)\s/i,             // „Gesendet mit der WEB.DE Mail App"
  /\bsent\s+from\s+my\b/i,
  /(info|sven)@happy-property\./i,                         // unsere Adressen = zitierter Kopf/Footer
  /du erhältst diese e-?mail|you('| a)re receiving this/i,  // unser Footer
]

export function ownText(body: string): string {
  let cut = body.length
  for (const re of CUT_MARKERS) {
    const m = re.exec(body)
    if (m && m.index < cut) cut = m.index
  }
  return body.slice(0, cut).slice(0, 800)
}

const OPTOUT_PATTERNS: RegExp[] = [
  // „nimm mich aus deinem Email- Verteiler", „entferne mich aus dem Verteiler", „aus dem Verteiler streichen"
  /\b(nimm|nehmt|nehmen|entfern\w*|streich\w*|lösch\w*|trag\w*)\b[^.!?\n]{0,40}verteiler/i,
  /verteiler[^.!?\n]{0,40}\b(nehmen|entfernen|streichen|löschen|austragen|raus|heraus)\b/i,
  // „Newsletter abbestellen", „bitte vom Newsletter abmelden"
  /(newsletter|mailing|e-?mails?\b|\bmails\b|werbung|zusendungen)[^.!?\n]{0,40}(abbestell|abmeld|austrag)/i,
  /(abbestell|abmeld|austrag)\w*[^.!?\n]{0,40}(newsletter|mailing|verteiler|e-?mails?\b|\bmails\b|werbung|liste)/i,
  // „melde mich bitte ab.", „tragt mich aus!", „nehmen Sie mich raus" (Satzende, damit
  // „ich melde mich ab Montag wieder" nicht greift)
  /\b(melde|meldet|melden|trag|trage|tragt|tragen|nimm|nehmt|nehmen)\s+(sie\s+)?mich\s+(\S+\s+){0,4}?(ab|aus|raus|heraus)\s*([.!,;]|$)/im,
  // „Bitte keine Mails mehr", „Ich möchte keine weiteren E-Mails erhalten"
  /\b(bitte|möchte|möchten|will|wollen|wünsche)\b[^.!?\n]{0,40}\bkeine\s+(weiteren\s+)?(e-?mails?|mails|newsletter|nachrichten|werbung|zusendungen)\b/i,
  /\bkeine\s+(weiteren\s+)?(e-?mails?|mails|newsletter|nachrichten|werbung|zusendungen)\s+(mehr\s+)?bitte\b/i,
  // „bitte nicht mehr anschreiben", „schreiben Sie mich nicht mehr an", „kontaktiert mich nicht mehr"
  /nicht\s+mehr\s+(an(zu)?schreiben|kontaktieren|anmailen|zuschicken|zusenden|zumailen)\b/i,
  /\b(schreib|schreibt|schreiben|kontaktier\w*|mail\w*)\s+(sie\s+)?(mich|mir)\s+(bitte\s+)?nicht\s+mehr\b/i,
  // Englisch
  /\bunsubscribe\b/i,
  /\b(remove|take)\s+me\s+(off|from)\b/i,
  /\bstop\s+(sending|emailing|e-mailing|mailing|contacting)\b/i,
  /\b(no|don'?t\s+send(\s+me)?)\s+(more|further|any\s+more)\s+(e-?mails|messages|newsletters)\b/i,
]

// Einwort-Antworten: „STOPP", „Abmelden", „unsubscribe" (als eigene Zeile, auch nach „Hallo,")
const ONE_WORD = /^\s*(stop|stopp|abmelden|abbestellen|austragen|unsubscribe)\s*[.!]*\s*$/i

export function wantsNewsletterOptout(body: string): boolean {
  const own = ownText(body)
  const lines = own.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 3)
  if (lines.some(l => ONE_WORD.test(l))) return true
  return OPTOUT_PATTERNS.some(re => re.test(own))
}
