// RFC-2047-konforme Betreff-Kodierung für E-Mail-Header.
//
// Warum: denomailer@1.6.0 kodiert Betreffs mit Umlauten/Sonderzeichen fehlerhaft
// (Q-Encoding mit LITERALEN Leerzeichen im Encoded-Word → ungültig, viele Clients
// zeigen dann den Rohtext „=?utf-8?Q?Dein Termin ist best=c3=a4tigt …"). Wir
// kodieren den Betreff daher SELBST als Base64-Encoded-Words und übergeben denomailer
// eine reine ASCII-Zeichenkette, die es unverändert durchreicht.
//
// - Reiner ASCII-Betreff → unverändert (keine Kodierung nötig).
// - Sonst → ein oder mehrere „=?UTF-8?B?…?=" (Base64 enthält NIE Leerzeichen).
//   An Zeichen-Grenzen gesplittet (nie mitten in einem UTF-8-Zeichen), jedes
//   Encoded-Word ≤ 75 Zeichen (RFC-2047-Limit).

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

  return words.map(w => `=?UTF-8?B?${b64(w)}?=`).join(' ')
}
