// Maschinenlesbare Zone von Ausweisen (ICAO 9303) auswerten. Die Prüfziffern sind der härteste
// Beweis, dass eine Ausweisnummer richtig gelesen wurde: ein falsch gelesenes Zeichen fällt auf,
// ohne dass eine KI noch einmal urteilen muss. Reine Rechnung, kein Netz.

export interface Mrz {
  format: 'TD1' | 'TD2' | 'TD3'
  number: string; numberOk: boolean
  dob: string; dobOk: boolean              // YYYY-MM-DD
  expiry: string; expiryOk: boolean        // YYYY-MM-DD
  nationality: string                      // Länderkürzel, z. B. D, AUT
  surname: string; given: string
}

const VALUE = (c: string): number => {
  if (c === '<') return 0
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55
  return -1
}

/** Prüfziffer nach ICAO 9303 (Gewichte 7, 3, 1). -1 bei einem Zeichen, das es dort nicht gibt. */
export function checkDigit(s: string): number {
  const weights = [7, 3, 1]
  let sum = 0
  for (let i = 0; i < s.length; i++) {
    const v = VALUE(s[i])
    if (v < 0) return -1
    sum += v * weights[i % 3]
  }
  return sum % 10
}
const digitOk = (data: string, digit: string) => /^[0-9]$/.test(digit) && checkDigit(data) === Number(digit)

function isoDate(yymmdd: string, kind: 'dob' | 'expiry', now = new Date()): string {
  if (!/^\d{6}$/.test(yymmdd)) return ''
  const yy = Number(yymmdd.slice(0, 2))
  const cur = now.getUTCFullYear() % 100
  // Geburtstag liegt nie in der Zukunft, Ablaufdatum ist bei gültigen Ausweisen immer dieses Jahrhundert
  const century = kind === 'dob' ? (yy > cur ? 19 : 20) : 20
  return `${century}${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
}

const clean = (l: string) => l.toUpperCase().replace(/\s+/g, '')
const filler = (s: string) => s.replace(/<+$/g, '').replace(/</g, ' ').trim()

function names(field: string): { surname: string; given: string } {
  const [sur, ...rest] = field.split('<<')
  return { surname: filler(sur ?? ''), given: filler(rest.join(' ')) }
}

/** Zeilen so, wie sie auf dem Ausweis stehen. Null, wenn sie keiner bekannten Form entsprechen. */
export function parseMrz(raw: string[], now = new Date()): Mrz | null {
  const lines = raw.map(clean).filter(Boolean)
  if (lines.length === 3) {
    const [a, b, c] = [lines[0].padEnd(30, '<'), lines[1].padEnd(30, '<'), lines[2].padEnd(30, '<')]
    if (a.length !== 30 || b.length !== 30) return null
    const n = names(c)
    return {
      format: 'TD1',
      number: filler(a.slice(5, 14)), numberOk: digitOk(a.slice(5, 14), a[14]),
      dob: isoDate(b.slice(0, 6), 'dob', now), dobOk: digitOk(b.slice(0, 6), b[6]),
      expiry: isoDate(b.slice(8, 14), 'expiry', now), expiryOk: digitOk(b.slice(8, 14), b[14]),
      nationality: filler(b.slice(15, 18)), surname: n.surname, given: n.given,
    }
  }
  if (lines.length === 2) {
    const len = lines[1].length > 38 ? 44 : 36
    const [a, b] = [lines[0].padEnd(len, '<'), lines[1].padEnd(len, '<')]
    if (a.length !== len || b.length !== len) return null
    const n = names(a.slice(5))
    return {
      format: len === 44 ? 'TD3' : 'TD2',
      number: filler(b.slice(0, 9)), numberOk: digitOk(b.slice(0, 9), b[9]),
      dob: isoDate(b.slice(13, 19), 'dob', now), dobOk: digitOk(b.slice(13, 19), b[19]),
      expiry: isoDate(b.slice(21, 27), 'expiry', now), expiryOk: digitOk(b.slice(21, 27), b[27]),
      nationality: filler(b.slice(10, 13)), surname: n.surname, given: n.given,
    }
  }
  return null
}
