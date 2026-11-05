// Datei-Erkennung im Kundenordner: Ausweis (Reisepass / Personalausweis, mit
// Name + Nummer je Person) oder vom Bauträger unterschriebener Reservierungs-
// vertrag (mit Wohnungsnummer)? Eine Datei kann mehrere Ausweise enthalten
// (z. B. beide Pässe eines Ehepaars in einem PDF).
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'

export interface IdPerson {
  surname: string
  given_names: string
  document_number: string
  document_type: 'passport' | 'id_card' | 'other'
  nationality: string
  date_of_birth: string     // YYYY-MM-DD oder ''
  expiry_date: string       // YYYY-MM-DD oder ''
}
export interface FileCheck {
  kind: 'identity_document' | 'reservation_agreement' | 'other'
  persons: IdPerson[]
  /** Nur bei reservation_agreement: trägt der Vertrag eine Unterschrift oder einen Stempel des Verkäufers? */
  seller_signed: boolean
  /** Nur bei reservation_agreement: Wohnungsnummer laut Vertrag */
  unit_number: string
  note: string
}

const TOOL = {
  name: 'record_file_check',
  description: 'Record what kind of document the file is and the data needed from it.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'persons', 'seller_signed', 'unit_number', 'note'],
    properties: {
      kind: {
        type: 'string', enum: ['identity_document', 'reservation_agreement', 'other'],
        description: 'identity_document: the file itself is a photo or scan of a passport data page or a national identity card (front or back). '
          + 'reservation_agreement: a property reservation agreement / reservation form between a developer and buyers. '
          + 'other: anything else (purchase contracts, bank statements, letters, brochures). A document that merely mentions an ID number is NOT an identity document.',
      },
      persons: {
        type: 'array',
        description: 'Only for identity_document: one entry per identity document visible in the file. Empty otherwise.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['surname', 'given_names', 'document_number', 'document_type', 'nationality', 'date_of_birth', 'expiry_date'],
          properties: {
            surname: { type: 'string', description: 'Surname in Latin letters exactly as printed (prefer the machine readable zone spelling if the visual zone uses special characters).' },
            given_names: { type: 'string', description: 'All given names in Latin letters as printed.' },
            document_number: { type: 'string', description: 'Passport or ID card number exactly as printed, without spaces. Empty string if not readable. Never guess: if a character is unclear, return an empty string.' },
            document_type: { type: 'string', enum: ['passport', 'id_card', 'other'] },
            nationality: { type: 'string', description: 'Nationality as printed, e.g. DEUTSCH, GERMAN, SRB.' },
            date_of_birth: { type: 'string', description: 'YYYY-MM-DD or empty string.' },
            expiry_date: { type: 'string', description: 'Date of expiry YYYY-MM-DD or empty string.' },
          },
        },
      },
      seller_signed: { type: 'boolean', description: 'Only for reservation_agreement: true if the seller/developer side carries a handwritten signature or a company seal. false for an empty, unsigned form and for every other kind.' },
      unit_number: { type: 'string', description: 'Only for reservation_agreement: the property unit number written on it, e.g. A1. Empty string otherwise.' },
      note: { type: 'string', description: 'Short remark, e.g. what kind of document it is, or which field was hard to read.' },
    },
  },
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(bin)
}

// ── Zweite, unabhängige Lesung (Flora-Automatik) ─────────────────────────────
// Bekommt bewusst nichts aus der ersten Lesung zu sehen, sonst bestätigt sie nur, was sie erwartet.
export interface IdReread {
  surname: string
  given_names: string
  visual_document_number: string
  mrz_lines: string[]
  nationality: string
  date_of_birth: string
  expiry_date: string
}

const REREAD_TOOL = {
  name: 'record_id_reading',
  description: 'Record exactly what is printed on each identity document in the file.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['documents'],
    properties: {
      documents: {
        type: 'array',
        description: 'One entry per identity document side visible in the file. Empty if the file shows no identity document.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['surname', 'given_names', 'visual_document_number', 'mrz_lines', 'nationality', 'date_of_birth', 'expiry_date'],
          properties: {
            surname: { type: 'string', description: 'Surname in Latin letters as printed in the visual zone. Empty string if this side does not show it.' },
            given_names: { type: 'string', description: 'All given names in Latin letters as printed. Empty string if this side does not show them.' },
            visual_document_number: { type: 'string', description: 'Document number as printed in the visual zone, without spaces. Empty string if this side does not show it or a character is unclear.' },
            mrz_lines: {
              type: 'array', items: { type: 'string' },
              description: 'The machine readable zone (the OCR lines with < characters), one string per line, copied character by character including every <. Do not correct anything. Empty array if no machine readable zone is visible or it is not fully readable.',
            },
            nationality: { type: 'string', description: 'Nationality as printed. Empty string if not shown.' },
            date_of_birth: { type: 'string', description: 'YYYY-MM-DD or empty string.' },
            expiry_date: { type: 'string', description: 'YYYY-MM-DD or empty string.' },
          },
        },
      },
    },
  },
}

/** Liest den Ausweis ein zweites Mal Zeichen für Zeichen. null = Prüfung nicht möglich, später erneut. */
export async function rereadId(bytes: Uint8Array, mime: string, fileName: string): Promise<IdReread[] | null> {
  const block = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64(bytes) } }
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-opus-5-5',
    fallbackModels: ['claude-sonnet-4-6'],
    max_tokens: 8000,
    label: 'reservation-zweitlesung',
    system: 'You transcribe identity documents for a legal contract. Copy what is printed, character by character. '
      + 'Never guess, never correct and never complete anything: if a character is not clearly readable, leave that field empty. '
      + 'Always answer by calling the tool record_id_reading exactly once.',
    messages: [{ role: 'user', content: [block, { type: 'text', text: `File name: ${fileName}\nCall record_id_reading with the result.` }] }],
    tools: [REREAD_TOOL],
    tool_choice: { type: 'auto' },
  })
  if (!res.ok) { console.error('[reservation-agreement] Zweitlesung', fileName, res.error); return null }
  const out = toolInput<{ documents: IdReread[] }>(res)
  return Array.isArray(out?.documents) ? out.documents : null
}

/** Prüft eine Datei. Rückgabe null = Prüfung nicht möglich (nächste Runde erneut versuchen). */
export async function checkFile(bytes: Uint8Array, mime: string, fileName: string): Promise<FileCheck | null> {
  const isPdf = mime === 'application/pdf'
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64(bytes) } }
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-opus-5-5',
    fallbackModels: ['claude-sonnet-4-6'],
    max_tokens: 16000,
    label: 'reservation-datei',
    system: 'You check files in a real-estate buyer\'s shared folder during a property reservation. '
      + 'Decide whether a file is an identity document (passport or national ID card), a reservation agreement, or something else. '
      + 'For identity documents read the data of each person exactly; the document number goes into a legal reservation agreement, so accuracy matters most. '
      + 'Always answer by calling the tool record_file_check exactly once.',
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: `File name: ${fileName}\nCall record_file_check with the result.` }],
    }],
    tools: [TOOL],
    tool_choice: { type: 'auto' },
  })
  if (!res.ok) { console.error('[reservation-agreement] KI-Prüfung', fileName, res.error); return null }
  const out = toolInput<FileCheck>(res)
  if (!out || !['identity_document', 'reservation_agreement', 'other'].includes(out.kind) || !Array.isArray(out.persons)) {
    console.warn('[reservation-agreement] KI ohne Tool-Ergebnis', fileName, res.stop_reason)
    return null
  }
  return out
}
