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
