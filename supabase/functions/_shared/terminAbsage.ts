// Absage- und Verschiebe-Meldungen zu einem anstehenden Kundentermin.
//
// Eva Hahn (29.10.2026) schrieb "Ich möchte den Termin absagen". Niemand hat das
// erkannt: der Termin blieb aktiv, die 1-h-Erinnerung ging raus, und Aaron
// (Bauträger) wusste von nichts. Jetzt: waInbound prüft mit dem Vorfilter unten,
// ob die Nachricht eine Absage sein KÖNNTE, und nur dann (und nur bei einem
// anstehenden Termin) entscheidet booking-bot per KI. Der Vorfilter darf deshalb
// großzügig sein, er soll nur das "danke"/"ok" vom KI-Aufruf fernhalten.
//
// Hier liegen nur reine Funktionen (kein DB-Zugriff), damit
// scripts/verify-absage.mjs sie ohne Deno testen kann.

export type AbsageArt = 'absage' | 'verschieben'

const ABSAGE_MUSTER: RegExp[] = [
  // absagen, Absage, abgesagt, "ich sage den Termin ab"
  /absag|abgesagt|\bsag(e|en|t|st)?\b[^.!?\n]{0,40}\bab\b/i,
  /verschieb|verschoben|verleg|umleg|umplan|umbuch|storn/i,
  /dazwischen\s*gekommen|verhindert|krank|notfall|erkältet|ausfall|f[äa]llt\b[^.!?\n]{0,25}\baus\b|entf[äa]llt/i,
  // "ich kann morgen leider nicht", "schaffe es nicht", "klappt doch nicht"
  /\b(kann|kannst|können|könnte|koennen|schaff\w*|klappt|klappen|geht|passt|wird|brauch\w*|möchte|will)\b[^.!?\n]{0,40}\bnicht\b/i,
  /\bnicht\b[^.!?\n]{0,25}\b(kommen|teilnehmen|dabei|wahrnehmen|erscheinen|schaffen|klappen)\b/i,
  /\banderen?\s+(termin|tag|zeitpunkt|uhrzeit|zeit)\b|\bneue[nr]?\s+termin|ein\s*andermal|\bspäter\b|\bfrüher\b|\bstatt\b/i,
  // "können wir das auf Dienstag legen?", "Termin ändern"
  /\bauf\b[^.!?\n]{0,40}\b(legen|schieben)\b|\btermin\b[^.!?\n]{0,40}\b(ändern|tauschen)\b/i,
  /cancel|reschedul|postpone|unable to|can'?t (make it|come)|cannot (make it|come)|won'?t (make it|be able)|not able to|not coming|another (day|time)|different (day|time)|\bmove (the|our) (meeting|appointment|call)/i,
]

/** Könnte die Nachricht einen Termin absagen oder verschieben? (nur Vorfilter) */
export function koennteAbsageSein(text: string): boolean {
  const t = String(text ?? '')
  return t.trim().length >= 4 && ABSAGE_MUSTER.some(re => re.test(t))
}

/** Zeitzone, in der der Kunde den Termin kennt: vor Ort Zypern, sonst deutsche Zeit. */
export function terminZone(timezone: string | null | undefined, type: string | null | undefined): string {
  if (timezone === 'Asia/Nicosia' || timezone === 'Europe/Berlin') return timezone
  return type === 'inperson' ? 'Asia/Nicosia' : 'Europe/Berlin'
}

/** "Donnerstag, 29.10., 14:30 Uhr" (en: "Thursday 29 October at 14:30") in der Zone des Termins. */
export function terminLabel(startIso: string, tz: string, lang: 'de' | 'en' = 'de'): string {
  if (lang === 'en') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      .format(new Date(startIso))
  }
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date(startIso)) + ' Uhr'
}

const mitName = (vorname: string) => vorname.trim() ? `, ${vorname.trim()}` : ''

/** Lottes Antwort auf eine Absage. */
export function lotteAbsageText(vorname: string, wann: string): string {
  return `Alles klar${mitName(vorname)}, danke dir für die Info! Ich gebe Sven Bescheid, dass du den Termin am ${wann} nicht wahrnehmen kannst. Wenn du später doch noch mit ihm sprechen möchtest, melde dich einfach. 🙂`
}

/** Einleitung, wenn Lotte zum Verschieben gleich neue Zeiten anbietet. */
export function lotteVerschiebenIntro(vorname: string, wann: string): string {
  return `Kein Problem${mitName(vorname)}! Dann suchen wir einen neuen Termin statt ${wann}. Wie wäre:`
}

/** Verschieben ohne eigene Vorschläge (Besichtigung mit Bauträger, nichts frei). */
export function lotteVerschiebenSven(vorname: string, wann: string): string {
  return `Kein Problem${mitName(vorname)}! Ich gebe Sven Bescheid, dass dir der Termin am ${wann} nicht passt. Er stimmt einen neuen Termin ab und meldet sich bei dir. 🙂`
}

/** Vorbereiteter Text an den Bauträger-Kontakt (Sven schickt ihn per Klick). */
export function bautraegerAbsageText(o: { lang: 'de' | 'en'; vorname: string; kunde: string; wann: string; art: AbsageArt }): string {
  const hallo = o.vorname.trim()
  if (o.lang === 'en') {
    return o.art === 'absage'
      ? `Hi ${hallo}, quick note: ${o.kunde} has cancelled our appointment on ${o.wann}. No need to come, sorry for the trouble! Best regards, Sven`
      : `Hi ${hallo}, quick note: ${o.kunde} can't make our appointment on ${o.wann} and would like to reschedule. No need to come, I'll get back to you with a new date. Best regards, Sven`
  }
  return o.art === 'absage'
    ? `Hallo ${hallo}, kurze Info: ${o.kunde} hat unseren Termin am ${o.wann} abgesagt. Bitte nicht extra hinfahren, sorry für die Umstände! Liebe Grüße, Sven`
    : `Hallo ${hallo}, kurze Info: ${o.kunde} kann unseren Termin am ${o.wann} leider nicht wahrnehmen und möchte verschieben. Bitte nicht extra hinfahren, ich melde mich mit einem neuen Termin. Liebe Grüße, Sven`
}

/** wa.me-Link mit vorbereitetem Text (öffnet Svens WhatsApp, sendet nichts). */
export function waMeLink(phone: string, text: string): string | null {
  let d = String(phone ?? '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length < 8) return null
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`
}
