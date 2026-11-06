// Drive-Kundenordner: Wer kommt rein, und wann erfährt Sven davon?
//
// Google teilt einen Ordner nur mit Adressen, hinter denen ein Google-Konto steht. Eine Einladungsmail
// hilft nicht: Service-Account und Svens Konto bekommen auch damit 403 (geprüft 6.11.2026). Kunden ohne
// Google-Konto unter ihrer CRM-Adresse können den Ordner-Link also nicht öffnen. Klicken sie mit einem
// anderen Konto auf „Zugriff anfordern“, geht die Anfrage an den Service-Account, dem die Ordner gehören,
// also an niemanden. Beides lief still, Frank Roeding wartete am 6.11.2026 deshalb stundenlang.
//
// Importeure: create-client-drive-folder, owner-drive. Änderung hier heißt beide neu ausrollen.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { CI } from './brand.ts'
import { normMail } from './kontoSperre.ts'

const SVEN_PHONE = '+35795096409'
const SVEN_MAIL = 'sven@happy-property.com'
const CRM_LEAD = 'https://portal.happy-property.com/admin/crm/leads/'

export const SUBJECT_ZUGANG_FEHLT = 'Drive-Zugang fehlt'
export const SUBJECT_ANFRAGE = 'Drive-Zugriffsanfrage'
export const SUBJECT_FREIGESCHALTET = 'Drive-Zugang freigeschaltet'

export type AnfrageEntscheidung = 'freischalten' | 'unbekannt' | 'gesperrt' | 'deal_zu'

/**
 * Was passiert mit einer offenen Anfrage? Automatisch frei nur, wenn die Adresse genau zum Kunden
 * gehört (Haupt- oder Zweit-Adresse im CRM), er nicht gesperrt ist und einen lebenden Deal hat.
 * In den Ordnern liegen Ausweise, alles andere entscheidet Sven.
 */
export function entscheideAnfrage(a: {
  anfrage: string | null | undefined
  email: string | null | undefined
  altEmails: string[] | null | undefined
  gesperrt: boolean
  lebenderDeal: boolean
}): AnfrageEntscheidung {
  if (a.gesperrt) return 'gesperrt'
  const von = normMail(a.anfrage)
  const kunde = [a.email, ...(a.altEmails ?? [])].map(normMail).filter(Boolean)
  if (!von || !kunde.includes(von)) return 'unbekannt'
  return a.lebenderDeal ? 'freischalten' : 'deal_zu'
}

/** Text für Sven, wenn der Kunde keinen Zugang bekommen hat. Schlüssel = Adressen, siehe meldeSvenEinmal. */
export function textZugangFehlt(name: string, adressen: string[], fehler: Record<string, string>): { key: string; text: string } {
  const liste = [...new Set(adressen.map(a => a.trim().toLowerCase()).filter(Boolean))].sort()
  if (!liste.length) {
    const key = 'keine E-Mail-Adresse'
    return { key, text: `⚠️ Drive-Zugang fehlt: ${name}\n\nIm CRM steht ${key}, deshalb konnte der Kundenordner nicht mit dem Kunden geteilt werden.\n\nSo kommt er rein: Google-Adresse erfragen und im CRM eintragen, die Freigabe läuft dann von selbst. Oder die Unterlagen per WhatsApp nehmen.` }
  }
  const key = liste.join(', ')
  const andere = Object.entries(fehler)
    .filter(([m, f]) => liste.includes(m.trim().toLowerCase()) && !/Google[- ]?(Account|Konto)/i.test(f))
    .map(([m, f]) => `${m}: ${f}`)
  const grund = andere.length
    ? `Die Freigabe für ${key} ist fehlgeschlagen (${andere.join('; ')}).`
    : `Unter ${key} gibt es kein Google-Konto, deshalb lässt Google die Freigabe nicht zu.`
  return { key, text: `⚠️ Drive-Zugang fehlt: ${name}\n\n${grund} Der Ordner-Link geht beim Kunden nicht auf.\n\nSo kommt er rein: Google-Adresse erfragen und im CRM unter „Weitere E-Mails“ eintragen, die Freigabe läuft dann von selbst. Oder die Unterlagen per WhatsApp nehmen.` }
}

/**
 * Einmal je Kunde und Schlüssel: Notiz in die Akte, WhatsApp an Sven, bei Fehler Mail.
 * `key` muss wörtlich in `text` stehen, daran erkennt der nächste Lauf die Meldung.
 * Scheitert etwas, bleibt der eigentliche Vorgang (Freigabe, Sweep) davon unberührt.
 */
export async function meldeSvenEinmal(sb: SupabaseClient, m: { leadId: string; subject: string; key: string; text: string }): Promise<boolean> {
  const { data, error } = await sb.from('activities').select('content').eq('lead_id', m.leadId).eq('subject', m.subject).limit(100)
  if (error) { console.error('[driveZugang] Akte lesen', error.message); return false }
  if (((data ?? []) as Array<{ content: string | null }>).some(a => (a.content ?? '').includes(m.key))) return false
  // Notiz zuerst: Ohne sie käme die Meldung bei jedem Lauf neu
  const { error: noteErr } = await sb.from('activities').insert({
    lead_id: m.leadId, type: 'note', direction: 'inbound', auto: true, subject: m.subject, content: m.text,
    completed_at: new Date().toISOString(),
  })
  if (noteErr) { console.error('[driveZugang] Notiz', noteErr.message); return false }

  const link = `${CRM_LEAD}${m.leadId}`
  let fehler: string | null = null
  try {
    const { data: wa, error: waErr } = await sb.functions.invoke('send-whatsapp', { body: {
      event_type: 'drive_zugang', override_text: `${m.text}\n\n${link}`, auto: true, lang: 'de', already_translated: true,
      lead_data: { lead_name: 'Sven', lead_phone: SVEN_PHONE },
    } })
    const d = wa as { error?: string; success?: boolean } | null
    fehler = waErr?.message || d?.error || (d?.success === false ? 'success=false' : null)
  } catch (e) { fehler = (e as Error).message }
  if (fehler) {
    console.error('[driveZugang] WhatsApp an Sven', fehler)
    const html = m.text.split('\n\n').map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')
      + `<p><a href="${link}" style="display:inline-block;background:${CI.navy};color:${CI.white};padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Kunde öffnen</a></p>`
    await sb.functions.invoke('send-email', { body: { to: SVEN_MAIL, subject: m.subject, html, auto: true, lang: 'de', already_translated: true } })
      .catch(e => console.error('[driveZugang] Mail an Sven', (e as Error).message))
  }
  return true
}
