// Appendix-Dateien einer Wohnung zuordnen (Flora Panorama, Sven 6.11.2026).
// Rein rechnerisch, ohne Netz und ohne Deno-Importe, damit scripts/verify-appendix.mjs es prüfen kann.
//
// Regel: Eine Datei gehört zur Wohnung, wenn ihr Name genau diese Wohnungsnummer enthält und keine
// andere. "FLORA_PANORAMA_B107_Appendices.pdf" gehört zu B107. "B107 B106 Appendix.pdf" ist
// mehrdeutig und wird nie angehängt: Der Appendix muss immer zur richtigen Wohnung gehören.

export interface AppendixCandidate { id: string; name: string; mimeType: string }
export interface AppendixMatch {
  /** Gehören sicher zur Wohnung, nach Name sortiert */
  matched: AppendixCandidate[]
  /** Nennen mehrere Wohnungen, werden nicht angehängt */
  ambiguous: AppendixCandidate[]
  /** Nennen die Wohnung, sind aber kein PDF und kein Google-Dokument */
  unsupported: AppendixCandidate[]
}

/** Flora-Wohnungsnummern in einem Text: Block A bis D, drei Ziffern. "b 107" und "B-107" zählen als B107. */
export function unitCodes(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.toUpperCase().matchAll(/(?<![A-Z0-9])([ABCD])[\s-]?(\d{3})(?![0-9])/g)) out.add(`${m[1]}${m[2]}`)
  return [...out]
}

const isReadable = (mime: string) => mime === 'application/pdf' || mime === 'application/vnd.google-apps.document'

export function matchAppendix(files: AppendixCandidate[], unit: string): AppendixMatch {
  const want = unit.trim().toUpperCase()
  const res: AppendixMatch = { matched: [], ambiguous: [], unsupported: [] }
  for (const f of files) {
    const codes = unitCodes(f.name)
    if (!codes.includes(want)) continue
    if (codes.length > 1) res.ambiguous.push(f)
    else if (!isReadable(f.mimeType)) res.unsupported.push(f)
    else res.matched.push(f)
  }
  res.matched.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  return res
}

/**
 * Stimmt der Inhalt zur Wohnung? Nennt der Text andere Flora-Wohnungen, aber nicht diese,
 * ist die Datei falsch benannt. Ein Text ohne jede Wohnungsnummer (Scan) bleibt unbeanstandet.
 */
export function contentProblem(text: string, unit: string): string | null {
  const want = unit.trim().toUpperCase()
  const codes = unitCodes(text)
  if (!codes.length || codes.includes(want)) return null
  return `Der Inhalt nennt ${codes.slice(0, 4).join(', ')}, aber nicht ${want}`
}
