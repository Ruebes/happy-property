// Erkennt, ob hinter einer Buchung eine INTERNE Person steckt (Sven, Verwaltung,
// Mitarbeitende) statt eines Kunden. Interne Termine duerfen keinen Deal in der
// Pipeline erzeugen und keine Kundenautomatik ausloesen.
//
// Genutzt von personal-booking (/buchen/:slug) und funnel-api (/termin) — beide
// Buchungswege muessen dieselbe Entscheidung treffen, sonst laesst sich der Riegel
// einfach durch die andere Tuer umgehen.

// Minimale strukturelle Sicht auf den Supabase-Client. Bewusst kein Import des
// echten Typs: personal-booking laedt supabase-js ueber esm.sh, funnel-api ueber
// jsr — zwei verschiedene Modul-Identitaeten fuer denselben Typ.
type Rows = { data: Array<Record<string, unknown>> | null }
export interface Db {
  from(table: string): { select(columns: string): {
    in(column: string, values: string[]): PromiseLike<Rows>
    eq(column: string, value: boolean): PromiseLike<Rows>
  } }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Vergleichsform einer E-Mail. Wichtig: googlemail.com und gmail.com sind bei
 * Google dieselbe Mailbox. Gionas Profil steht auf googlemail.com, ihr Lead und
 * ihre Einladung auf gmail.com — ohne diese Angleichung erkennt die Pruefung sie
 * nicht als Mitarbeiterin.
 */
export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 0) return e
  const local = e.slice(0, at)
  const domain = e.slice(at + 1)
  return `${local}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`
}

const digits = (s: string) => s.replace(/\D/g, '')

export interface InternalCheck {
  email?: string | null
  phone?: string | null
  /** booking_invites.internal der verwendeten Einladung, falls vorhanden. */
  inviteInternal?: boolean
}

/**
 * Drei Wege, damit das Vergessen eines einzelnen nicht sofort zum Kundenvorgang fuehrt:
 *  1. Die Einladung ist ausdruecklich als intern markiert.
 *  2. Die E-Mail gehoert zu einem Profil mit interner Rolle.
 *  3. E-Mail oder Telefon stehen in einer als intern markierten Einladung — das
 *     greift auch, wenn jemand den blanken Link ohne ?g=<token> oeffnet und seine
 *     Daten selbst eintippt.
 */
export async function isInternalContact(admin: Db, opts: InternalCheck): Promise<boolean> {
  if (opts.inviteInternal) return true

  const email = opts.email ? normalizeEmail(opts.email) : ''
  const phone = opts.phone ? digits(opts.phone) : ''
  if (!email && !phone) return false

  try {
    if (email) {
      // Bewusst alle internen Profile laden und in JS vergleichen: der Abgleich muss
      // ueber die normalisierte Form laufen, das kann die Query nicht.
      const { data } = await admin.from('profiles').select('email').in('role', ['admin', 'verwalter', 'mitarbeiter'])
      for (const p of data ?? []) {
        const pe = str(p.email)
        if (pe && normalizeEmail(pe) === email) return true
      }
    }

    const { data: invites } = await admin.from('booking_invites').select('guest_email, guest_phone').eq('internal', true)
    for (const i of invites ?? []) {
      const ie = str(i.guest_email), ip = str(i.guest_phone)
      if (email && ie && normalizeEmail(ie) === email) return true
      if (phone && ip && digits(ip) === phone) return true
    }
  } catch (err) {
    // Im Zweifel NICHT als intern behandeln: ein faelschlich interner Termin wuerde
    // einem echten Kunden Deal und Bestaetigung wegnehmen — der teurere Fehler.
    console.warn('[internalContact] Pruefung fehlgeschlagen, behandle als Kunde:', err)
  }
  return false
}
