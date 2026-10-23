// Antwort eines Tippgebers auf Lottes Adress-Frage erkennen (Sven 23.10.2026).
//
// affiliate-api fragt den Empfehlungsgeber per WhatsApp nach seiner Postanschrift,
// sobald ein geworbener Kunde auf Reservierung steht (affiliates.address_requested_at).
// Schreibt genau diese Nummer zurück, solange die Adresse fehlt, geht der Text an
// affiliate-api (address_reply): dort liest die KI die Adresse, trägt sie ein und
// Lotte bedankt sich. Läuft im Hintergrund und darf den Webhook nie stören.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export async function maybeTippgeberAdresse(sb: SupabaseClient, digits: string, text: string, tag: string): Promise<void> {
  try {
    const suffix = digits.slice(-8)
    if (suffix.length < 8) return
    const { data } = await sb.from('affiliates').select('id, whatsapp, street, postal_code, city')
      .not('address_requested_at', 'is', null).not('whatsapp', 'is', null)
      .or('street.is.null,postal_code.is.null,city.is.null').limit(100)
    const hit = ((data ?? []) as Array<{ id: string; whatsapp: string; street: string | null; postal_code: string | null; city: string | null }>)
      .find(a => !(a.street?.trim() && a.postal_code?.trim() && a.city?.trim()) && a.whatsapp.replace(/\D/g, '').endsWith(suffix))
    if (!hit) return
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const p = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/affiliate-api`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'address_reply', affiliate_id: hit.id, text: text.slice(0, 1500) }),
    }).then(async r => console.log(`[${tag}] Tippgeber-Adresse (${hit.id}):`, r.status, (await r.text()).slice(0, 200)))
      .catch(e => console.warn(`[${tag}] Tippgeber-Adresse:`, e))
    const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
    if (er) er.waitUntil(p); else await p
  } catch (e) {
    console.warn(`[${tag}] Tippgeber-Adresse:`, e)
  }
}
