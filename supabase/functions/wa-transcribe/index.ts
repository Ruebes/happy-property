// wa-transcribe: schreibt eine eingehende WhatsApp-Sprachnachricht ab und ersetzt im
// Verlauf den Platzhalter "[Sprachnachricht]" durch den Text. So steht sie im
// Posteingang und im Kundenverlauf lesbar da.
//
// Aufruf: evolution-webhook im Hintergrund, von Hand auch nachträglich, immer mit
// Service-Role und { "uid": "<WhatsApp-Message-ID>" }.
//
// Bewusst nur für den Verlauf: Der Text löst keine Abmeldung und keine Lotte-Antwort
// aus. Eine falsch verstandene Sprachnachricht darf nichts automatisch anstoßen.
//
// Mehrfacher Aufruf ist unschädlich: Es wird nur ein Eintrag geändert, der noch den
// Platzhalter trägt. Scheitert etwas, bleibt der Platzhalter stehen, die Nachricht
// geht also nie verloren. Abschrift und Audio nie loggen.
//
// Deploy: supabase functions deploy wa-transcribe --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, corsHeaders } from '../_shared/callerAuth.ts'
import { evoConfig } from '../_shared/waProvider.ts'

const TAG = 'wa-transcribe'
const PLATZHALTER = '[Sprachnachricht]'
const MAX_BYTES = 25 * 1024 * 1024 // Grenze der OpenAI-Schnittstelle

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

async function audioHolen(uid: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const { url, key, instance, ok } = evoConfig()
  if (!ok) throw new Error('EVOLUTION_URL / EVOLUTION_API_KEY fehlt')
  const res = await fetch(`${url}/chat/getBase64FromMediaMessage/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key },
    body: JSON.stringify({ message: { key: { id: uid } }, convertToMp4: false }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Evolution ${res.status}`)
  const data = await res.json() as { base64?: string; mimetype?: string }
  if (!data.base64) throw new Error('Evolution lieferte kein Audio')
  const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0))
  return { bytes, mime: (data.mimetype ?? 'audio/ogg').split(';')[0].trim() }
}

async function abschreiben(bytes: Uint8Array, mime: string): Promise<string> {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) throw new Error('OPENAI_API_KEY fehlt')
  const endung = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : 'ogg'
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), `sprachnachricht.${endung}`)
  form.append('model', 'gpt-4o-transcribe')
  form.append('response_format', 'json')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json() as { text?: string }
  return (data.text ?? '').trim()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const caller = await authorizeCaller(req, { service: true }, corsHeaders)
  if (caller instanceof Response) return caller

  try {
    const { uid } = await req.json() as { uid?: string }
    if (!uid) return json({ error: 'uid fehlt' }, 400)
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Eingehende Nachricht eines Kontakts oder einer unbekannten Nummer.
    const { data: akt } = await sb.from('activities').select('id, lead_id')
      .eq('whatsapp_message_id', uid).eq('type', 'whatsapp').eq('direction', 'inbound')
      .eq('content', PLATZHALTER).limit(1).maybeSingle()
    const { data: unbekannt } = akt ? { data: null } : await sb.from('wa_unknown_messages').select('id')
      .eq('whatsapp_message_id', uid).eq('direction', 'inbound')
      .eq('content', PLATZHALTER).limit(1).maybeSingle()
    if (!akt && !unbekannt) return json({ ok: true, skipped: 'kein offener Platzhalter' })

    const { bytes, mime } = await audioHolen(uid)
    if (bytes.length > MAX_BYTES) return json({ error: 'Audio zu groß' }, 413)

    const text = await abschreiben(bytes, mime)
    if (!text) return json({ ok: true, skipped: 'keine Sprache erkannt' })
    const content = `🎤 Sprachnachricht (automatisch abgeschrieben):\n${text}`.slice(0, 20000)

    const { error } = akt
      ? await sb.from('activities').update({ content }).eq('id', akt.id).eq('content', PLATZHALTER)
      : await sb.from('wa_unknown_messages').update({ content }).eq('id', unbekannt!.id).eq('content', PLATZHALTER)
    if (error) throw new Error(error.message)

    // KI-Zusammenfassung des Kontakts neu erzeugen lassen, jetzt mit dem Inhalt.
    if (akt?.lead_id) await sb.from('lead_ai_summaries').delete().eq('lead_id', akt.lead_id)

    console.log(`[${TAG}] ${uid} abgeschrieben (${bytes.length} Bytes, ${text.length} Zeichen)`)
    return json({ ok: true, zeichen: text.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[${TAG}]`, msg)
    return json({ error: msg }, 502)
  }
})
