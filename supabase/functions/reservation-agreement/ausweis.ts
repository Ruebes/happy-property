// Ausweis-Erkennung: Ist die Datei ein Reisepass / Personalausweis, und wenn ja,
// wer steht drin? Eine Datei kann mehrere Ausweise enthalten (z. B. beide Pässe
// eines Ehepaars in einem PDF).
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
export interface IdCheck {
  is_identity_document: boolean
  persons: IdPerson[]
  note: string
}

const TOOL = {
  name: 'record_id_check',
  description: 'Record whether the file is an identity document and the data of every person shown on it.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['is_identity_document', 'persons', 'note'],
    properties: {
      is_identity_document: {
        type: 'boolean',
        description: 'true only if the file itself is a photo or scan of a passport data page or a national identity card (front or back). Contracts, reservation forms, bank statements or letters that merely mention an ID number are NOT identity documents.',
      },
      persons: {
        type: 'array',
        description: 'One entry per identity document visible in the file. Empty if is_identity_document is false.',
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
      note: { type: 'string', description: 'Short remark, e.g. what kind of document it is if not an ID, or which field was hard to read.' },
    },
  },
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(bin)
}

/** Prüft eine Datei. Rückgabe null = Prüfung nicht möglich (nächste Runde erneut versuchen). */
export async function checkId(bytes: Uint8Array, mime: string, fileName: string): Promise<IdCheck | null> {
  const isPdf = mime === 'application/pdf'
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64(bytes) } }
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-opus-5-5',
    fallbackModels: ['claude-sonnet-4-6'],
    max_tokens: 16000,
    label: 'reservation-ausweis',
    system: 'You check files that real-estate buyers uploaded to their own folder for a property reservation. '
      + 'Decide whether the file is an identity document (passport or national ID card) and, if so, read the data of each person exactly. '
      + 'Accuracy of the document number matters most: it goes into a legal reservation agreement. '
      + 'Always answer by calling the tool record_id_check exactly once.',
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: `File name: ${fileName}\nCall record_id_check with the result.` }],
    }],
    tools: [TOOL],
    tool_choice: { type: 'auto' },
  })
  if (!res.ok) { console.error('[reservation-agreement] KI-Prüfung', fileName, res.error); return null }
  const out = toolInput<IdCheck>(res)
  if (!out || typeof out.is_identity_document !== 'boolean' || !Array.isArray(out.persons)) {
    console.warn('[reservation-agreement] KI ohne Tool-Ergebnis', fileName, res.stop_reason)
    return null
  }
  return out
}
