// E-Mail-Body als Base64-MIME-Parts — umgeht den kaputten Quoted-Printable-Encoder
// von denomailer@1.6.0 (aktuellste, unmaintained Version). Dessen QP-Zeilenumbruch
// (Soft-Break alle 74 Zeichen) zerhackt Multibyte-UTF-8-Sequenzen, die auf der
// Zeilengrenze liegen → aus „persönlich" wird „pers�6nlic", und zwar in HTML UND Text
// (beide laufen durch denselben Encoder). Ergebnis beim Empfänger: weder brauchbares
// HTML noch lesbare Textversion.
//
// Fix: Wir liefern die Parts SELBST als Base64 (transferEncoding: "base64") über
// SendConfig.mimeContent. denomailer schreibt mimeContent-Parts VERBATIM (kein zweites
// Encoding, kein Zeilenumbruch) — der buggy QP-Pfad (nur bei html/content aktiv) wird
// komplett umgangen. Base64 kodiert die rohen UTF-8-Bytes am Stück; Zeilen sauber bei
// 76 (RFC 2045). Analog zu encodeMimeSubject, das denselben Bug für den Betreff löst.

export interface MimePart { mimeType: string; content: string; transferEncoding: string }

const enc = new TextEncoder()

function base64Body(s: string): string {
  const bytes = enc.encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const b64 = btoa(bin)
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64
}

// text/plain zuerst, text/html zuletzt: bei multipart/alternative bevorzugt der Client
// das letzte darstellbare Part → HTML gewinnt, Text bleibt Fallback ohne HTML-Fähigkeit.
export function buildMimeContent(html: string, text: string): MimePart[] {
  const parts: MimePart[] = []
  if (text) parts.push({ mimeType: 'text/plain; charset="utf-8"', content: base64Body(text), transferEncoding: 'base64' })
  if (html) parts.push({ mimeType: 'text/html; charset="utf-8"',  content: base64Body(html), transferEncoding: 'base64' })
  return parts
}
