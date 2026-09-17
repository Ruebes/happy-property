// WhatsApp-Provider: TimelinesAI (Fremddienst) oder Evolution API (eigener Server
// hp-server, https://wa.happy-property.com). Umschaltbar ueber crm_settings, Key
// `wa_provider` = 'timelines' | 'evolution'. Fehlt der Eintrag, gilt TimelinesAI,
// damit ein vergessener Schalter nie den Versand kippt. Beide Wege haengen an
// DERSELBEN Nummer (+357 95 154722); es darf immer nur EINER senden und nur
// EINER eingehende Nachrichten verarbeiten - sonst kommt alles doppelt.
//
// Secrets (Supabase Edge Function Secrets, nie im Frontend):
//   EVOLUTION_URL             https://wa.happy-property.com
//   EVOLUTION_API_KEY         globaler Key (AUTHENTICATION_API_KEY in Coolify)
//   EVOLUTION_INSTANCE        happy-property
//   EVOLUTION_WEBHOOK_SECRET  wird als Header x-webhook-secret mitgeschickt

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type WaProvider = 'timelines' | 'evolution'
export const WA_PROVIDER_KEY = 'wa_provider'

export async function getWaProvider(sb: SupabaseClient): Promise<WaProvider> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', WA_PROVIDER_KEY).maybeSingle()
  const v = ((data as { value?: string } | null)?.value ?? '').trim().toLowerCase()
  return v === 'evolution' ? 'evolution' : 'timelines'
}

export async function setWaProvider(sb: SupabaseClient, p: WaProvider): Promise<void> {
  const { error } = await sb.from('crm_settings')
    .upsert({ key: WA_PROVIDER_KEY, value: p, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) throw error
}

export function evoConfig() {
  const url      = (Deno.env.get('EVOLUTION_URL') ?? '').replace(/\/+$/, '')
  const key      = Deno.env.get('EVOLUTION_API_KEY') ?? ''
  const instance = Deno.env.get('EVOLUTION_INSTANCE') ?? 'happy-property'
  return { url, key, instance, ok: !!(url && key) }
}

// Evolution will die Nummer als reine Ziffern mit Landesvorwahl ("4917..."),
// ohne "+", Leerzeichen oder Bidi-Zeichen.
export function evoNumber(phone: string): string {
  return String(phone ?? '').replace(/[^0-9]/g, '')
}

// JID "4917...@s.whatsapp.net" -> "+4917...". Gruppen (@g.us) und LIDs (@lid)
// liefern keine Telefonnummer -> leer.
export function jidToPhone(jid: string | null | undefined): string {
  const s = String(jid ?? '')
  if (!s || s.includes('@g.us') || s.includes('@lid') || s.includes('@broadcast')) return ''
  const digits = s.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
  return digits ? '+' + digits : ''
}

type EvoResult = { ok: boolean; status: number; data: unknown; messageId?: string }

async function evoCall(path: string, body: unknown, timeoutMs = 25_000): Promise<EvoResult> {
  const { url, key, ok } = evoConfig()
  if (!ok) return { ok: false, status: 0, data: { error: 'EVOLUTION_URL / EVOLUTION_API_KEY fehlt' } }
  let res: Response
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { ok: false, status: 0, data: { error: `Evolution nicht erreichbar: ${e instanceof Error ? e.message : String(e)}` } }
  }
  let data: unknown = null
  try { data = await res.json() } catch { data = { raw: await res.text().catch(() => '') } }
  const messageId = (data as { key?: { id?: string } } | null)?.key?.id
  return { ok: res.ok, status: res.status, data, messageId }
}

export async function evoConnectionState(): Promise<'open' | 'close' | 'connecting' | 'unknown'> {
  const { url, key, instance, ok } = evoConfig()
  if (!ok) return 'unknown'
  try {
    const r = await fetch(`${url}/instance/connectionState/${instance}`, { headers: { apikey: key }, signal: AbortSignal.timeout(8000) })
    const j = await r.json() as { instance?: { state?: string } }
    const s = j?.instance?.state
    return s === 'open' || s === 'close' || s === 'connecting' ? s : 'unknown'
  } catch { return 'unknown' }
}

export function evoSendText(phone: string, text: string): Promise<EvoResult> {
  const { instance } = evoConfig()
  return evoCall(`/message/sendText/${instance}`, { number: evoNumber(phone), text, linkPreview: true })
}

// Medien als Base64 (Bytes haben wir ohnehin schon geladen und ggf. verkleinert);
// so muss Evolution die Datei nicht selbst aus dem Storage ziehen.
export function evoSendMedia(phone: string, opts: {
  bytes: Uint8Array; mimetype: string; fileName: string; caption?: string
}): Promise<EvoResult> {
  const { instance } = evoConfig()
  const mediatype = /^image\//.test(opts.mimetype) ? 'image'
                  : /^video\//.test(opts.mimetype) ? 'video'
                  : /^audio\//.test(opts.mimetype) ? 'audio' : 'document'
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < opts.bytes.length; i += chunk) bin += String.fromCharCode(...opts.bytes.subarray(i, i + chunk))
  return evoCall(`/message/sendMedia/${instance}`, {
    number: evoNumber(phone), mediatype, mimetype: opts.mimetype,
    fileName: opts.fileName, caption: opts.caption ?? '', media: btoa(bin),
  }, 60_000)
}

// Klartext fuer Evolution-Fehler (statt Roh-JSON im CRM).
export function evoErrorText(status: number, data: unknown): string {
  const s = JSON.stringify(data ?? '')
  if (status === 0) return `Eigener WhatsApp-Server nicht erreichbar: ${s.slice(0, 160)}`
  if (status === 401) return 'Evolution API: Schluessel abgelehnt (EVOLUTION_API_KEY pruefen).'
  if (/not connected|connection closed|instance .*(closed|not found)|state.*close/i.test(s))
    return 'WhatsApp-Nummer ist auf dem eigenen Server nicht verbunden (Instanz getrennt). Pairing-Code neu eingeben.'
  if (/exists.*false|number.*not.*whatsapp|not.*on whatsapp/i.test(s))
    return 'Diese Nummer hat kein WhatsApp.'
  return `WhatsApp-Versand fehlgeschlagen (HTTP ${status}): ${s.slice(0, 180)}`
}

// Erkennungsmuster fuer "Konto/Instanz nicht verbunden" - gleiche Rolle wie
// TimelinesAIs "Whatsapp account not found" (Retry im Scheduler + Alarm-Mail).
export const EVO_DISCONNECTED_RE = /nicht verbunden|not connected|connection closed|instanz getrennt/i
