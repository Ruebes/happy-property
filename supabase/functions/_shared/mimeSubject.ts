// RFC-2047-konforme Betreff-Kodierung für E-Mail-Header.
//
// Warum: denomailer@1.6.0 (= aktuellste Version, unmaintained) kodiert Betreffs mit
// Umlauten/Sonderzeichen KAPUTT: sein Q-Encoder lässt Leerzeichen literal (code 32
// wird unverändert zurückgegeben) und faltet lange Werte mit „=\r\n" MITTEN im
// Encoded-Word — beides ungültig, Clients zeigen dann den Rohtext
// „=?utf-8?Q?Dein Termin ist best=c3=a4tigt …". Zusätzlich re-wrappt denomailer JEDEN
// Betreff, der Sonderzeichen hat ODER mit „=?" beginnt.
//
// Lösung: Wir kodieren SELBST korrekt als Base64-Encoded-Words (Base64-Alphabet
// enthält NIE Leerzeichen; an Codepoint-Grenzen gesplittet, jedes Word ≤ 75 Zeichen).
// Damit denomailer unseren fertigen String NICHT ein zweites Mal anfasst, stellen wir
// EIN LEERZEICHEN voran: dann ist der String reines ASCII UND beginnt nicht mit „=?"
// → denomailers Bedingung (hasNonAscii || startsWith("=?")) ist false → unverändert
// durchgereicht. Der Mailclient ignoriert das führende Header-Leerzeichen (RFC 2047)
// und dekodiert die Encoded-Words zu echten Umlauten.
//
// - Reiner ASCII-Betreff → unverändert (denomailer fasst ihn ohnehin nicht an).

export function encodeMimeSubject(subject: string): string {
  if (!subject) return ''
  // Nur ASCII (0x00–0x7F) → nichts zu tun.
  if (!/[^\x00-\x7F]/.test(subject)) return subject

  const enc = new TextEncoder()
  const b64 = (s: string): string => {
    const bytes = enc.encode(s)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }

  // In Wörter gruppieren: je Encoded-Word max 75 Zeichen. Overhead "=?UTF-8?B?"(10)
  // + "?="(2) = 12 → Base64 ≤ 63 → UTF-8-Bytes ≤ 45. An CODEPOINT-Grenzen splitten
  // (for…of iteriert über Codepoints, auch Emoji/Surrogatpaare bleiben intakt).
  const words: string[] = []
  let cur = ''
  for (const ch of subject) {
    if (enc.encode(cur + ch).length > 45 && cur) { words.push(cur); cur = ch }
    else cur += ch
  }
  if (cur) words.push(cur)

  // Führendes Leerzeichen: verhindert denomailers Doppel-Kodierung (s.o.).
  return ' ' + words.map(w => `=?UTF-8?B?${b64(w)}?=`).join(' ')
}
