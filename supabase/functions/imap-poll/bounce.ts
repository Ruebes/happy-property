// Rückläufer („Unzustellbar", Mailer-Daemon) im info@-Postfach erkennen.
//
// IONOS nimmt viele Mails erst an und meldet das Scheitern später per Rückläufer
// an den Absender (info@). Die betroffene Adresse kommt dann nach email_bounces
// (siehe _shared/emailBounce.ts) und bekommt den Newsletter nicht mehr per Mail.
//
// Nur Standard-Zustellberichte (RFC 3464, Final-Recipient + Status), nur 5.x.x:
//   hard   = Empfänger-Server sagt ausdrücklich „Adresse gibt es nicht" (5.1.x)
//            -> sofort gesperrt
//   soft   = alles andere Dauerhafte („mailbox unavailable", „unrouteable",
//            Postfach voll, nach Tagen aufgegeben, Grund unbekannt)
//            -> gesperrt erst ab der zweiten Meldung (email_bounces.bounce_count).
//            Fall Schäck 12.10.: EIN „mailbox unavailable" am 1.10., danach kamen
//            alle Mails an - eine Meldung allein reicht nicht.
//   ignore = Spam/Richtlinie (5.7.x): liegt an unserem Versand, nicht an der Adresse

export type Bounce = { email: string; status: string; diag: string; kind: 'hard' | 'soft' | 'ignore' }

export function looksLikeBounce(from: string, raw: string): boolean {
  return /report-type="?delivery-status/i.test(raw) || /(^|@)(mailer-daemon|postmaster)\b/i.test(from)
}

function field(para: string, name: string): string {
  // Kopfzeile inkl. eingerückter Folgezeilen
  const m = new RegExp('^' + name + ':[ \\t]*(.*(?:\\n[ \\t]+.*)*)', 'im').exec(para)
  return m ? m[1].replace(/\s+/g, ' ').trim() : ''
}

function kind(status: string, diag: string): Bounce['kind'] {
  if (!/^5\./.test(status)) return 'ignore'
  if (/^5\.7\./.test(status) || /spam|policy|blocked|blacklist|block ?list|reputation|dmarc|\bspf\b|dkim/i.test(diag)) return 'ignore'
  return /^5\.1\./.test(status) ? 'hard' : 'soft'
}

// Grund zur Adresse aus dem lesbaren Teil des Rückläufers. IONOS:
//   „- Error message for [x@y.de]\n    SMTP error … reason: 550-5.1.1 …"
// Exim klassisch: „x@y.de:\n    SMTP error …"
function reasonFromText(text: string, email: string): string {
  const low = text.toLowerCase()
  for (const marke of [`[${email}]`, `${email}:`]) {
    const i = low.indexOf(marke)
    if (i < 0) continue
    const block = text.slice(i + marke.length, i + marke.length + 900).split(/\n[ \t]*\n/)[0]
    const r = block.replace(/\s+/g, ' ').trim()
    if (r) return r
  }
  return ''
}

export function parseBounces(raw: string, isOwn: (addr: string) => boolean): Bounce[] {
  const out = new Map<string, Bounce>()
  const text = raw.replace(/\r\n/g, '\n')
  for (const para of text.split(/\n[ \t]*\n/)) {
    const rcptField = field(para, 'Final-Recipient') || field(para, 'Original-Recipient')
    const email = rcptField.match(/;\s*<?([^\s<>;]+@[^\s<>;]+?)>?\s*$/)?.[1]?.toLowerCase()
    if (!email || isOwn(email)) continue
    const action = field(para, 'Action').toLowerCase()
    if (action && action !== 'failed') continue          // delayed/delivered/relayed
    let status = field(para, 'Status').match(/\d\.\d{1,3}\.\d{1,3}/)?.[0] ?? ''
    // IONOS liefert nur „Status: 5.0.0" ohne Diagnostic-Code; der echte Grund steht
    // im Klartext-Teil: „<adresse>: … reason: 550-5.1.1 The email account … does not exist".
    const diag = (field(para, 'Diagnostic-Code').replace(/^smtp;\s*/i, '') || reasonFromText(text, email)).slice(0, 280)
    const enhanced = diag.match(/\b([245])[.]\d{1,3}[.]\d{1,3}\b/)?.[0]
    if (enhanced && (!status || /^\d\.0\.0$/.test(status))) status = enhanced
    const b: Bounce = { email, status, diag, kind: kind(status, diag) }
    const rang = { hard: 2, soft: 1, ignore: 0 }
    const prev = out.get(email)
    if (!prev || rang[b.kind] > rang[prev.kind]) out.set(email, b)
  }
  return [...out.values()]
}
