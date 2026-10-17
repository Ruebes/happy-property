// Newsletter-Abmeldungen ueber Personen-Datensaetze hinweg (Bug 17.10.26).
//
// Dieselbe Person steht oft zweimal im System: als CRM-Lead UND als Listen-
// Abonnent (newsletter_subscribers), gleiche Mailadresse oder gleiche Nummer.
// Meldet sie sich an einer Stelle ab, darf sie auch ueber die andere keinen
// Newsletter mehr bekommen. Im Preflight von Kampagne 27e51afb haetten sonst
// 5 Leute, die sich als Lead abgemeldet hatten, den Newsletter ueber ihre
// Abonnenten-Zeile trotzdem bekommen.
//
// Gesperrt sind Mail und Nummer von:
//   - Leads mit newsletter_optout_at (inkl. alt_emails, phone und whatsapp)
//   - Leads in communication_optouts (gar keine Kommunikation)
//   - Abonnenten mit optout_at
// Ausnahme: Hat ein Abonnent NACH der Abmeldung per Double-Opt-in neu
// zugestimmt (properties.doi_confirmed_at, gesetzt von subscriber-optin und
// masterclass-register), zaehlt die neuere Einwilligung.
// Genutzt von newsletter-campaign (Zielgruppe, Nachtraege) und
// process-scheduled-messages (Pruefung zum Versandzeitpunkt).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// Gleiche Normalisierung wie die Entdopplung im Newsletter (newsletter-campaign).
export function optoutMailKey(m: string | null | undefined): string {
  const e = (m ?? '').trim().toLowerCase()
  return e.includes('@') ? e.replace(/@googlemail\.com$/, '@gmail.com') : ''
}
// Letzte 10 Ziffern; fuehrende 0 = deutsche Nummer (wie telKey in newsletter-campaign).
export function optoutTelKey(t: string | null | undefined): string {
  let d = (t ?? '').replace(/\D/g, '').replace(/^00/, '')
  if (d.startsWith('0')) d = '49' + d.slice(1)
  return d.length >= 8 ? d.slice(-10) : ''
}

// Schluessel -> Zeitpunkt der juengsten Abmeldung (ms; unbekannt = Infinity, sperrt immer).
export interface OptoutKeys { mail: Map<string, number>; tel: Map<string, number> }

type LeadRow = { email: string | null; alt_emails: string[] | null; phone: string | null; whatsapp: string | null }
const LEAD_COLS = 'email, alt_emails, phone, whatsapp'

const ms = (at: string | null | undefined) => { const t = Date.parse(at ?? ''); return isNaN(t) ? Infinity : t }
const put = (m: Map<string, number>, k: string, t: number) => { if (k && !(t <= (m.get(k) ?? -Infinity))) m.set(k, t) }

// Wirft bei einem Lesefehler: lieber kein Versand als einer an Abgemeldete.
export async function loadNewsletterOptoutKeys(sb: SupabaseClient): Promise<OptoutKeys> {
  const mail = new Map<string, number>(), tel = new Map<string, number>()
  const addLead = (r: LeadRow, t: number) => {
    for (const m of [r.email, ...(r.alt_emails ?? [])]) put(mail, optoutMailKey(m), t)
    for (const x of [r.phone, r.whatsapp]) put(tel, optoutTelKey(x), t)
  }
  const { data: nl, error: e1 } = await sb.from('leads').select(`${LEAD_COLS}, newsletter_optout_at`).not('newsletter_optout_at', 'is', null).limit(5000)
  if (e1) throw new Error(`Abmeldungen (Leads): ${e1.message}`)
  for (const r of (nl ?? []) as Array<LeadRow & { newsletter_optout_at: string | null }>) addLead(r, ms(r.newsletter_optout_at))

  const { data: co, error: e2 } = await sb.from('communication_optouts').select('lead_id, opted_out_at').limit(5000)
  if (e2) throw new Error(`Abmeldungen (communication_optouts): ${e2.message}`)
  const coAt = new Map<string, number>()
  for (const o of (co ?? []) as Array<{ lead_id: string | null; opted_out_at: string | null }>) if (o.lead_id) put(coAt, o.lead_id, ms(o.opted_out_at))
  const coIds = [...coAt.keys()]
  for (let i = 0; i < coIds.length; i += 200) {
    const { data, error } = await sb.from('leads').select(`id, ${LEAD_COLS}`).in('id', coIds.slice(i, i + 200))
    if (error) throw new Error(`Abmeldungen (communication_optouts-Leads): ${error.message}`)
    for (const r of (data ?? []) as Array<LeadRow & { id: string }>) addLead(r, coAt.get(r.id) ?? Infinity)
  }

  const { data: subs, error: e3 } = await sb.from('newsletter_subscribers').select('email, phone, optout_at').not('optout_at', 'is', null).limit(5000)
  if (e3) throw new Error(`Abmeldungen (Abonnenten): ${e3.message}`)
  for (const s of (subs ?? []) as Array<{ email: string | null; phone: string | null; optout_at: string | null }>) {
    put(mail, optoutMailKey(s.email), ms(s.optout_at))
    put(tel, optoutTelKey(s.phone), ms(s.optout_at))
  }
  return { mail, tel }
}

// consentAt = doi_confirmed_at des Abonnenten (Leads: weglassen). Gesperrt ist,
// wer ueber Mail oder Nummer eine Abmeldung hat, die juenger als diese
// Einwilligung ist (ohne Einwilligung: jede Abmeldung).
export function isOptedOut(
  keys: OptoutKeys, mails: Array<string | null | undefined>, tels: Array<string | null | undefined> = [], consentAt?: string | null,
): boolean {
  const c = consentAt ? Date.parse(consentAt) : NaN
  const hit = (m: Map<string, number>, k: string) => { const t = k ? m.get(k) : undefined; return t !== undefined && (isNaN(c) || t > c) }
  return mails.some(m => hit(keys.mail, optoutMailKey(m))) || tels.some(t => hit(keys.tel, optoutTelKey(t)))
}

// Varianten einer Adresse fuer exakte .in()-Abfragen (gmail/googlemail, Schreibweise).
export function mailVariants(m: string | null | undefined): string[] {
  const raw = (m ?? '').trim()
  const k = optoutMailKey(raw)
  if (!k) return []
  const out = new Set([raw, raw.toLowerCase(), k])
  if (k.endsWith('@gmail.com')) out.add(k.replace(/@gmail\.com$/, '@googlemail.com'))
  return [...out]
}
