// evolution-webhook — Empfang von WhatsApp-Ereignissen vom eigenen Server
// (Evolution API, https://wa.happy-property.com, Instanz `happy-property`).
// Gegenstueck zu timelines-webhook; die Fachlogik liegt in _shared/waInbound.ts.
//
// Absicherung: Evolution schickt den Header `x-webhook-secret` mit (beim Setzen des
// Webhooks hinterlegt). Stimmt er nicht mit EVOLUTION_WEBHOOK_SECRET ueberein → 401.
// Zusaetzlich wird ?token= akzeptiert (gleicher Wert), falls Header mal wegfallen.
//
// Ereignisse (webhook_by_events=false, alles an diese URL):
//   messages.upsert    eingehende UND eigene Nachrichten (fromMe)
//   messages.update    Zustell-/Lesestatus (derzeit nur Log)
//   connection.update  open/close/connecting → Merker in crm_settings
//
// Umschalter crm_settings.wa_provider: steht er auf 'timelines', wird hier NICHTS
// verarbeitet (nur bestaetigt) - sonst kommt jede Nachricht doppelt.
//
// Achtung: Evolution haengt seinen globalen API-Key an jedes Payload (`apikey`).
// Deshalb NIE das rohe Payload loggen oder speichern.
//
// Deploy: supabase functions deploy evolution-webhook --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { markProcessed, processWaEvent } from '../_shared/waInbound.ts'
import { getWaProvider, jidToPhone } from '../_shared/waProvider.ts'

const TAG = 'evolution-webhook'
const EVO_STATE_KEY = 'wa_evo_state'          // 'open' | 'close' | 'connecting' + Zeit
const ok = (s: string) => new Response(s, { status: 200 })

type EvoMessage = {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string }
  pushName?: string
  messageType?: string
  message?: Record<string, { caption?: string; fileName?: string; text?: string } | string | undefined>
  source?: string
}

// Text bzw. Platzhalter aus dem Baileys-Nachrichtenobjekt ziehen.
function extractText(m: EvoMessage): { text: string; mediaOnly: boolean; skip: boolean } {
  const msg = m.message ?? {}
  const type = m.messageType ?? ''
  const conv = typeof msg.conversation === 'string' ? msg.conversation : ''
  if (conv) return { text: conv, mediaOnly: false, skip: false }
  const cap = (k: string) => (typeof msg[k] === 'object' && msg[k] ? (msg[k] as { caption?: string }).caption ?? '' : '')
  if (msg.imageMessage)    return { text: cap('imageMessage')    || '[Bild]', mediaOnly: !cap('imageMessage'), skip: false }
  if (msg.videoMessage)    return { text: cap('videoMessage')    || '[Video]', mediaOnly: !cap('videoMessage'), skip: false }
  if (msg.documentMessage) {
    const fn = (msg.documentMessage as { fileName?: string }).fileName ?? ''
    return { text: cap('documentMessage') || `[Dokument${fn ? ': ' + fn : ''}]`, mediaOnly: !cap('documentMessage'), skip: false }
  }
  if (msg.audioMessage)    return { text: '[Sprachnachricht]', mediaOnly: true, skip: false }
  if (msg.locationMessage) return { text: '[Standort]', mediaOnly: true, skip: false }
  if (msg.contactMessage || msg.contactsArrayMessage) return { text: '[Kontakt]', mediaOnly: true, skip: false }
  // Reaktionen, Protokoll-Nachrichten (Loeschen, Verlaufs-Sync), Sticker, Umfragen:
  // kein Inhalt fuer den Verlauf.
  if (/reaction|protocol|sticker|poll|edited|senderKeyDistribution/i.test(type)) return { text: '', mediaOnly: true, skip: true }
  return { text: '', mediaOnly: true, skip: true }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  // ── Absicherung ──────────────────────────────────────────────────────────
  const secret = Deno.env.get('EVOLUTION_WEBHOOK_SECRET') ?? ''
  const given = req.headers.get('x-webhook-secret') ?? new URL(req.url).searchParams.get('token') ?? ''
  if (!secret || given !== secret) {
    console.warn(`[${TAG}] abgelehnt: falsches oder fehlendes Secret`)
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const payload = await req.json() as { event?: string; instance?: string; data?: unknown }
    const event = String(payload.event ?? '').toLowerCase().replace(/_/g, '.')
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── Verbindungsstatus: immer merken (auch wenn Timelines aktiv ist) ─────
    if (event === 'connection.update') {
      const st = String((payload.data as { state?: string } | undefined)?.state ?? 'unknown')
      console.log(`[${TAG}] connection.update → ${st}`)
      await supabase.from('crm_settings').upsert(
        { key: EVO_STATE_KEY, value: `${st}|${new Date().toISOString()}`, updated_at: new Date().toISOString() },
        { onConflict: 'key' })
      return ok('OK (connection)')
    }

    if (event === 'messages.update') {
      // Zustell-/Lesestatus. Noch keine Auswertung (Schritt "Lesebestaetigung als
      // Signal" kommt spaeter); nur Log, damit man im Zweifel sieht, dass es ankommt.
      const d = payload.data as { keyId?: string; status?: string; fromMe?: boolean } | undefined
      console.log(`[${TAG}] messages.update ${d?.keyId ?? '?'} → ${d?.status ?? '?'}`)
      return ok('OK (update)')
    }

    if (event !== 'messages.upsert') return ok(`OK (ignored ${event || 'unknown'})`)

    const m = payload.data as EvoMessage | undefined
    const jid = m?.key?.remoteJid ?? ''
    const uid = m?.key?.id ? String(m.key.id) : null
    const fromMe = m?.key?.fromMe === true

    // Gruppen, Status-Broadcasts, Newsletter: nie verarbeiten.
    if (!jid || jid.includes('@g.us') || jid.includes('@broadcast') || jid.includes('@newsletter')) return ok('OK (skip jid)')

    // ── Dedupe ───────────────────────────────────────────────────────────────
    // Eigene Nachrichten: send-whatsapp traegt die ID der API-Nachricht sofort nach
    // dem Senden in wa_processed ein. Das Echo hier kann trotzdem einen Tick frueher
    // eintreffen - kurze Pause, dann greift der Konflikt zuverlaessig.
    if (fromMe) await new Promise(r => setTimeout(r, 1500))
    if (!(await markProcessed(supabase, uid))) return ok('OK (dupe)')

    // ── Anbieter-Gate ────────────────────────────────────────────────────────
    if ((await getWaProvider(supabase)) !== 'evolution') {
      console.log(`[${TAG}] ignoriert (aktiver Anbieter ist TimelinesAI)`)
      return ok('OK (inactive provider)')
    }

    const phone = jidToPhone(jid)
    if (!phone) return ok('OK (no phone)')          // LID ohne Aufloesung → nichts zuzuordnen
    const { text, mediaOnly, skip } = extractText(m!)
    if (skip) return ok('OK (no content)')

    console.log(`[${TAG}] ${fromMe ? 'eigene' : 'eingehende'} Nachricht von ${phone} (${m?.messageType ?? '?'}${mediaOnly ? ', nur Medien' : ''})`)

    const r = await processWaEvent(supabase, {
      uid, phone, text, fromMe,
      // Echos unserer API-Nachrichten sind oben per Dedupe schon raus; was hier
      // als fromMe ankommt, hat Sven selbst am Handy getippt.
      viaApi: false,
      mediaOnly,
      pushName: m?.pushName ?? null,
    }, TAG)
    if (r.outcome === 'error') return new Response(JSON.stringify({ error: r.error }), { status: 500 })
    return ok(`OK (${r.outcome})`)
  } catch (error) {
    console.error(`[${TAG}]`, error instanceof Error ? error.message : String(error))
    return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500 })
  }
})
