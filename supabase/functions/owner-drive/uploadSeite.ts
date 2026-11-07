// Regeln der Upload-Seite /sign/u/:token, ohne Datenbank und ohne Google, damit sie testbar bleiben.
export const MAX_DATEI_MB = 20
export const MAX_DATEIEN_JE_TAG = 30
export const UPLOAD_TOKEN_RE = /^[0-9a-f]{48}$/
const TOTE_PHASEN = ['deal_verloren', 'archiviert']

export interface LinkLage {
  expires_at: string
  revoked_at: string | null
  phasen: string[]        // alle Deals des Kunden
  gesperrt: boolean
  jetzt?: number
}

/** Ohne Deal offen (Bestandskunde, Link von Hand). Nur tote Deals: zu. Ein lebender Deal reicht. */
export function linkOffen(l: LinkLage): boolean {
  if (l.revoked_at || l.gesperrt) return false
  if (new Date(l.expires_at).getTime() <= (l.jetzt ?? Date.now())) return false
  return !l.phasen.length || l.phasen.some(p => !TOTE_PHASEN.includes(p))
}

const beginnt = (b: Uint8Array, ...x: number[]) => x.every((v, i) => b[i] === v)
const ascii = (b: Uint8Array, von: number, bis: number) => String.fromCharCode(...b.slice(von, bis))
const BÜRO: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** Dateityp aus dem Inhalt, nicht aus der Angabe des Browsers. Null = nicht erlaubt. */
export function dateiTyp(b: Uint8Array, name: string): string | null {
  if (beginnt(b, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (beginnt(b, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (beginnt(b, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp'
  if (ascii(b, 4, 8) === 'ftyp') {
    const marke = ascii(b, 8, 12)
    if (['heic', 'heix', 'hevc', 'heim', 'heis'].includes(marke)) return 'image/heic'
    if (['mif1', 'msf1'].includes(marke)) return 'image/heif'
  }
  // Office-Dateien sind Zip-Archive, Zip allein reicht nicht
  if (beginnt(b, 0x50, 0x4b, 0x03, 0x04)) return BÜRO[name.split('.').pop()?.toLowerCase() ?? ''] ?? null
  return null
}

/** Nur der Dateiname: keine Pfade, keine Steuerzeichen, begrenzte Länge. */
export function dateiName(roh: string): string {
  // deno-lint-ignore no-control-regex
  const n = roh.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  if (!n) return 'Datei'
  if (n.length <= 150) return n
  const punkt = n.lastIndexOf('.')
  const endung = punkt > 0 && n.length - punkt <= 8 ? n.slice(punkt) : ''
  return n.slice(0, 150 - endung.length) + endung
}
