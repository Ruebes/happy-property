// Appendix zur Reservierungsvereinbarung (Flora Panorama, Sven 6.11.2026): Wegen der 40 % Anzahlung
// liegen die Anhänge schon bei der Reservierung dabei. Aaron lädt sie in den Drive-Ordner
// "Appendix Flora Panorama" (Vorlage: extra.appendix_folder_id), der Dateiname nennt die Wohnung.
// Beim Senden wird der Appendix der verkauften Wohnung gelesen, in den Speicher kopiert (Stand zum
// Zeitpunkt des Sendens, spätere Änderungen im Ordner berühren den Vertrag nicht) und hinten an den
// Vertrag gehängt. Alle Unterschriften gelten damit für Vertrag und Appendix zusammen.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { PDFDocument } from 'npm:pdf-lib@1.17.1'
import { saToken, listTree, download } from './drive.ts'
import { matchAppendix } from './appendixMatch.ts'
import type { Ctx } from './index.ts'

const BUCKET = 'unit-documents'
const MAX_TOTAL = 25 * 1024 * 1024

export interface AppendixResult {
  /** false = die Vorlage kennt keinen Appendix-Ordner, dann ist nichts zu tun */
  configured: boolean
  bytes: Uint8Array | null
  files: string[]
  pages: number
  /** Gründe, warum der Vertrag so nicht raus darf */
  problems: string[]
}

const none = (configured: boolean, problems: string[] = []): AppendixResult => ({ configured, bytes: null, files: [], pages: 0, problems })

/** Appendix der Wohnung aus dem Drive-Ordner holen und zu einem PDF zusammenführen. */
export async function fetchAppendix(ctx: Ctx): Promise<AppendixResult> {
  const folder = ctx.template.extra?.appendix_folder_id?.trim()
  if (!folder) return none(false)
  const unit = ctx.unit.unit_number
  try {
    const token = await saToken()
    const all = await listTree(token, folder)
    const m = matchAppendix(all.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType })), unit)
    const problems: string[] = []
    if (m.ambiguous.length) problems.push(`Appendix-Datei nennt mehrere Wohnungen und wird nicht angehängt: ${m.ambiguous.map(f => f.name).join(', ')}`)
    if (m.unsupported.length) problems.push(`Appendix-Datei für ${unit} ist kein PDF: ${m.unsupported.map(f => f.name).join(', ')}`)
    if (!m.matched.length) {
      problems.push(`Für ${unit} liegt noch kein Appendix im Drive-Ordner Appendix Flora Panorama (der Dateiname muss ${unit} enthalten)`)
      return none(true, problems)
    }
    const out = await PDFDocument.create()
    let only: { bytes: Uint8Array; pages: number } | null = null
    let total = 0
    for (const f of m.matched) {
      const src = all.find(x => x.id === f.id)!
      const { bytes } = await download(token, src)
      total += bytes.byteLength
      if (total > MAX_TOTAL) throw new Error('Appendix ist größer als 25 MB')
      // Der Inhalt wird nicht gelesen: Das Auslesen des Texts sprengte bei 13 Seiten die Rechenzeit der Function (6.11.2026). Es zählt der Dateiname.
      const doc = await PDFDocument.load(bytes)
      // Eine einzige Datei (der Normalfall) bleibt unverändert: Neu-Speichern kostet bei 6 MB viel Rechenzeit
      if (m.matched.length === 1) only = { bytes, pages: doc.getPageCount() }
      else for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page)
    }
    if (only) return { configured: true, bytes: only.bytes, files: m.matched.map(f => f.name), pages: only.pages, problems }
    const merged = await out.save()
    return { configured: true, bytes: merged, files: m.matched.map(f => f.name), pages: out.getPageCount(), problems }
  } catch (e) {
    return none(true, [`Appendix für ${unit} ließ sich nicht lesen: ${(e as Error).message}`])
  }
}

/** Appendix hinter den Vertrag setzen. */
export async function appendPdf(contract: Uint8Array, appendix: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(contract)
  const add = await PDFDocument.load(appendix)
  for (const page of await doc.copyPages(add, add.getPageIndices())) doc.addPage(page)
  return await doc.save()
}

/** Stand des Appendix zum Zeitpunkt des Sendens festhalten. */
export async function storeAppendix(sb: SupabaseClient, unitId: string, bytes: Uint8Array): Promise<string> {
  const path = `reservation-appendix/${unitId}/${Date.now()}.pdf`
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: false })
  if (error) throw new Error(`Appendix speichern: ${error.message}`)
  return path
}
