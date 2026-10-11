// Neue Mailadresse per WhatsApp-Antwort übernehmen (Sven 11.10.26).
//
// Wessen Mailadresse unzustellbar ist, bekommt den Newsletter per WhatsApp, mit
// der Bitte „Schick mir gern deine aktuelle Mailadresse". Schreibt so jemand
// eine Adresse zurück, wird sie am Kontakt gespeichert (Lead oder Abonnent) und
// es geht automatisch eine Danke-WhatsApp raus.
//
// Bewusst eng gefasst, damit keine fremde Adresse aus einem normalen Chat am
// Kontakt landet: nur wenn
//   - der Kontakt in den letzten 60 Tagen einen Newsletter per WhatsApp bekam,
//   - seine bisherige Mail unzustellbar ist (email_bounces) oder fehlt,
//   - die Nachricht genau EINE neue, nicht selbst unzustellbare Adresse enthält.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { bounceKey, loadBouncedKeys } from './emailBounce.ts'

const MAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const OWN = /@(happy-property\.(com|de)|weblift\.pro)$/i

export type MailUpdateTarget = { lead_id?: string | null; subscriber_id?: string | null }

export async function maybeUpdateEmailFromWa(
  sb: SupabaseClient, who: MailUpdateTarget, phone: string, text: string, tag: string,
): Promise<boolean> {
  try {
    const found = [...new Set((text.match(MAIL_RE) ?? []).map(m => m.toLowerCase().replace(/\.+$/, '')))]
      .filter(m => !OWN.test(m))
    if (found.length !== 1) return false
    const neu = found[0]

    // Bekam der Kontakt kürzlich einen Newsletter per WhatsApp?
    const seit = new Date(Date.now() - 60 * 864e5).toISOString()
    let q = sb.from('scheduled_messages').select('id').eq('event_type', 'newsletter').eq('type', 'whatsapp')
      .eq('status', 'sent').gte('sent_at', seit).limit(1)
    q = who.lead_id ? q.eq('lead_id', who.lead_id) : q.eq('subscriber_id', who.subscriber_id ?? '')
    const { data: nl } = await q
    if (!nl || !nl.length) return false

    const tabelle = who.lead_id ? 'leads' : 'newsletter_subscribers'
    const id = who.lead_id ?? who.subscriber_id
    if (!id) return false
    const { data: row } = await sb.from(tabelle).select('email, first_name').eq('id', id).maybeSingle()
    const k = row as { email: string | null; first_name: string | null } | null
    if (!k) return false
    const alt = (k.email ?? '').trim()
    const bounced = await loadBouncedKeys(sb)
    if (alt && !bounced.has(bounceKey(alt))) return false        // alte Adresse funktioniert
    if (bounceKey(alt) === bounceKey(neu) || bounced.has(bounceKey(neu))) return false

    const { error: ue } = await sb.from(tabelle).update({ email: neu }).eq('id', id)
    if (ue) { console.warn(`[${tag}] Mailadresse speichern:`, ue.message); return false }
    if (who.lead_id) {
      await sb.from('activities').insert({
        lead_id: who.lead_id, type: 'note', direction: 'inbound', auto: true,
        subject: 'Mailadresse per WhatsApp aktualisiert',
        content: `Neue Mailadresse aus der WhatsApp-Antwort übernommen: ${neu}${alt ? ` (vorher ${alt}, unzustellbar)` : ''}.`,
        completed_at: new Date().toISOString(),
      })
    }

    const vorname = (k.first_name ?? '').trim()
    const danke = `Danke dir${vorname ? `, ${vorname}` : ''}! Ich habe deine neue Mailadresse gespeichert: ${neu}\n\nDer nächste Newsletter kommt dann wieder per Mail.\n\nLiebe Grüße aus Paphos\nSven`
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-whatsapp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'scheduled', override_text: danke, auto: true,
        lead_id: who.lead_id ?? undefined,
        lead_data: { lead_name: vorname || 'Kontakt', lead_phone: phone },
      }),
    })
    if (!res.ok) console.warn(`[${tag}] Danke-WhatsApp:`, res.status, (await res.text()).slice(0, 200))
    console.log(`[${tag}] Mailadresse aktualisiert (${tabelle} ${id})`)
    return true
  } catch (e) {
    console.warn(`[${tag}] Mail-Update:`, e)
    return false
  }
}
