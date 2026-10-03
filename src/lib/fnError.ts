// Fehlermeldungen aus Edge-Function-Aufrufen lesbar machen.
//
// `supabase.functions.invoke` liefert bei non-2xx nur die englische Generik
// "Edge Function returned a non-2xx status code". Der eigentliche Grund steht im
// Response-Body (`{ error: "..." }`) und ging bisher verloren — Sven sah nur
// "konnte NICHT gesendet werden" ohne Ursache.
import { FunctionsHttpError } from '@supabase/supabase-js'

/** Echten Fehlertext aus einem Invoke-Fehler ziehen (Body vor Generik). */
export async function fnErrorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = await (error.context as Response).json().catch(() => null) as { error?: string } | null
    if (body?.error) return body.error
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/** Fehler einer Edge Function mit allen Feldern aus dem Body. */
export interface FnErrorDetail {
  /** Klartext: body.error, sonst die Meldung des Fehlers */
  message: string
  /** Handlungshinweis für den Nutzer (body.hint) */
  hint?: string
  /** Maschinenlesbarer Fehlercode (body.code), z.B. 'quality_blocked' */
  code?: string
  /** Nutzdaten zum Fehler (body.data), z.B. eine Mängelliste */
  data?: unknown
  /** Rohdetails von Meta (body.meta), z.B. Code, Subcode, fbtrace_id */
  meta?: unknown
}

/** Wie fnErrorMessage, liefert aber zusätzlich hint, code, data und meta aus
 *  dem Body ({ error, hint, code, data, meta }). Liest eine Kopie der Antwort,
 *  der Body bleibt für andere Leser erhalten. */
export async function fnErrorDetail(error: unknown): Promise<FnErrorDetail> {
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response
    const body = await res.clone().json().catch(() => null) as
      { error?: unknown; hint?: unknown; code?: unknown; data?: unknown; meta?: unknown } | null
    if (body && typeof body === 'object') {
      const detail: FnErrorDetail = {
        message: typeof body.error === 'string' && body.error ? body.error : error.message,
      }
      if (typeof body.hint === 'string' && body.hint) detail.hint = body.hint
      if ((typeof body.code === 'string' && body.code) || typeof body.code === 'number') detail.code = String(body.code)
      if (body.data !== undefined) detail.data = body.data
      if (body.meta !== undefined) detail.meta = body.meta
      return detail
    }
  }
  if (error instanceof Error) return { message: error.message }
  return { message: String(error) }
}

/** Dauerhafte SMTP-Ablehnung (5xx): Adresse existiert nicht / Domain hat kein MX.
 *  Ein Wiederholen bringt hier nichts — die Adresse muss korrigiert werden. */
export function isPermanentMailRejection(msg: string): boolean {
  const m = msg.toLowerCase()
  return /(^|\D)5[45]\d(\D|$)/.test(m)
    || m.includes('mailbox unavailable')
    || m.includes('invalid dns')
    || m.includes('no such user')
    || m.includes('user unknown')
    || m.includes('recipient rejected')
    || m.includes('address rejected')
}
