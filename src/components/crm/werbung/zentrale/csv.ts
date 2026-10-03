import type { SpaltenFormat } from './spalten'

// ── CSV-Export für deutsches Excel ───────────────────────────────────────────
// UTF-8 mit BOM (Umlaute), Semikolon als Trenner, Dezimalkomma, keine
// Tausenderpunkte. Prozente als Zahl mit Spaltenkopf „(%)", Geld mit „(€)".

/** Meta-ID als Text für Excel (sonst 1,20249E+17 und verlorene Stellen) */
export interface CsvId { id: string }
export type CsvZelle = string | number | null | undefined | CsvId

export const csvId = (id: string): CsvId => ({ id })

/** Zahl im CSV-Format (auch negativ, Dezimalkomma) oder Platzhalter „-": nie eine Formel */
const ZAHL = /^(?:[-+]?\d+(?:,\d+)?|-)$/
/** Text, den Excel als Formel ausführen würde (=, +, -, @, Tab, Zeilenumbruch am Anfang) */
const FORMEL = /^[=+\-@\t\r]/

const sicher = (v: string): string => (FORMEL.test(v) && !ZAHL.test(v) ? `'${v}` : v)

const zelle = (v: CsvZelle): string => {
  if (v == null) return ''
  let s: string
  if (typeof v === 'number') s = String(v)
  else if (typeof v === 'object') s = /^\d+$/.test(v.id) ? `="${v.id}"` : sicher(v.id)
  else s = sicher(v)
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Zahl für Excel-DE: Komma als Dezimaltrenner, ohne Tausenderpunkte */
export function csvZahl(v: number | null | undefined, format: SpaltenFormat): string {
  if (v == null || !Number.isFinite(v)) return ''
  const x = format === 'prozent' ? v * 100 : v
  const stellen = format === 'zahl' ? 0 : 2
  return x.toFixed(stellen).replace('.', ',')
}

/** Kopfzeilen-Zusatz je Format */
export const csvEinheit = (format: SpaltenFormat): string =>
  format === 'eur' ? ' (€)' : format === 'prozent' ? ' (%)' : ''

export function baueCsv(kopf: string[], zeilen: CsvZelle[][]): string {
  return '﻿' + [kopf, ...zeilen].map(z => z.map(zelle).join(';')).join('\r\n') + '\r\n'
}

/** Datei im Browser speichern (Blob + Download-Link) */
export function ladeCsvHerunter(inhalt: string, dateiname: string): void {
  const blob = new Blob([inhalt], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
