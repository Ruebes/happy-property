import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Recipient = { name: string; phone: string }

// Aus einer YouTube-URL das ECHTE Vorschaubild ermitteln.
// Achtung Falle: YouTube liefert für nicht existierende Größen (z.B. maxresdefault
// bei älteren Videos) HTTP 404 MIT einem grauen Platzhalter-Bild im Body. Wer nur
// auf "Antwort erhalten" prüft, verschickt am Ende dieses graue Kästchen.
// Deshalb: Status UND Mindestgröße prüfen, absteigend in der Qualität durchgehen.
async function youtubeThumb(url: string): Promise<string | null> {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/)
  if (!m) return null
  for (const v of ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault']) {
    const u = `https://i.ytimg.com/vi/${m[1]}/${v}.jpg`
    try {
      const r = await fetch(u, { method: 'HEAD' })
      const len = Number(r.headers.get('content-length') ?? 0)
      // Gemessen: der graue Platzhalter kommt IMMER mit HTTP 404 und exakt 1097 Bytes.
      // Echte Vorschaubilder starten bei ~6 KB (mqdefault). Schwelle 3 KB trennt beides
      // sicher, ohne kleine echte Bilder auszuschließen.
      if (r.ok && len > 3000) return u
    } catch { /* nächste Variante */ }
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const {
      event_type,    // z.B. 'registration', 'no_show', 'commission', 'booking'
      lead_data,     // { lead_name, lead_phone, lead_email, lead_whatsapp, … }
      extra_data,    // { developers, notes, project_name, commission_amount, … }
      lead_id,       // für Aktivitäts-Log (optional)
      override_text, // wenn gesetzt: überschreibt Template-Substitution (no_show preview)
      file_url,      // optionaler Bild-/Dokument-Anhang (DIREKTER Download-Link!)
      file_name,     // Dateiname des Anhangs (bei file_url Pflicht laut TimelinesAI)
    } = await req.json()

    const apiKey      = Deno.env.get('TIMELINES_API_KEY')     ?? ''
    const senderPhone = Deno.env.get('TIMELINES_WA_SENDER')   ?? ''

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── Template aus DB laden — NUR wenn kein override_text ───────
    // Direktsend-Aufrufer (Composer, Termin-Einladung, Postausgang) liefern den
    // fertigen Text mit; event_type ist dann nur ein Label fürs Activity-Log.
    // So hängt der Direktversand nicht an einem aktiven Template.
    let template: { message_template?: unknown; recipients?: unknown } | null = null
    if (!override_text) {
      const { data, error: tplErr } = await supabase
        .from('whatsapp_templates')
        .select('*')
        .eq('event_type', event_type)
        .eq('active', true)
        .single()
      if (tplErr || !data) {
        throw new Error(`Kein aktives Template für event_type="${event_type}" gefunden`)
      }
      template = data
    }

    // ── Nachricht zusammenbauen ───────────────────────────────────
    let message: string
    if (override_text) {
      message = override_text
    } else {
      message = template!.message_template as string
      const allData: Record<string, string> = {
        ...(lead_data  ?? {}),
        ...(extra_data ?? {}),
      }
      for (const [key, value] of Object.entries(allData)) {
        message = message.replaceAll(`{{${key}}}`, String(value ?? '–'))
      }
      // Übrige Platzhalter entfernen
      message = message.replace(/\{\{[^}]+\}\}/g, '–')
    }

    // ── Empfänger bestimmen ───────────────────────────────────────
    let recipients: Recipient[] = (template?.recipients as Recipient[]) ?? []

    const explicitPhone =
      (lead_data?.lead_whatsapp as string | undefined) ??
      (lead_data?.lead_phone   as string | undefined) ??
      null

    if (override_text && explicitPhone) {
      // Direktsend (Composer / interne Übergabe / Provision): die explizit übergebene
      // Nummer hat IMMER Vorrang vor template.recipients. Verhindert, dass ein Template
      // mit festen Empfängern den gewählten Empfänger überschreibt — und macht den
      // Versand deterministisch (das Template ist hier nur das Pflicht-Vehikel).
      recipients = [{ name: (lead_data?.lead_name as string) ?? 'Empfänger', phone: explicitPhone }]
    } else if (recipients.length === 0 && explicitPhone) {
      // Kein fester Empfänger im Template → direkt an die übergebene (Lead-)Nummer
      recipients = [{ name: (lead_data?.lead_name as string) ?? 'Lead', phone: explicitPhone }]
    }

    if (recipients.length === 0) {
      throw new Error('Keine Empfänger konfiguriert und keine Lead-Nummer vorhanden')
    }

    console.log(`[send-whatsapp] event_type="${event_type}" recipients=${recipients.length} sender="${senderPhone}"`)

    // ── An alle Empfänger senden ──────────────────────────────────
    // Anhang nur EINMAL hochladen und die UID für alle Empfänger wiederverwenden.
    let fileUidCache: string | null = null
    let attachUrl:  string | null = file_url  ? String(file_url)  : null
    let attachName: string | null = file_name ? String(file_name) : null
    const results = []
    for (const recipient of recipients) {
      const payload: Record<string, unknown> = {
        phone:                  recipient.phone,
        whatsapp_account_phone: senderPhone,
        text:                   message,
      }
      // Anhang (Bild/PDF) optional — ZWEI Schritte, weil TimelinesAI `file_url`
      // abgeschafft hat („no longer supported, use file_uid instead"):
      //   1. Datei laden und per multipart an POST /files_upload → liefert file_uid
      //   2. file_uid an die Nachricht hängen; der Text wird zur Bildunterschrift,
      //      der Link steht damit direkt unter dem Bild und bleibt antippbar.
      // Limit im aktuellen Tarif: 2 MB → Bilder vorher komprimieren (~250 KB reichen).
      // Schlägt der Upload fehl, geht die Nachricht als reiner Text raus statt gar nicht.
      // Kein Anhang übergeben, aber ein YouTube-Link im Text? Dann automatisch das
      // Video-Vorschaubild anhängen — so steht nie ein nackter Link im Chat.
      // (TimelinesAI erzeugt zwar eine Link-Vorschau, aber OHNE Bild und mit
      // fremdsprachiger Beschreibung — daher hängen wir das Bild selbst an.)
      if (!attachUrl && !fileUidCache && typeof message === 'string') {
        const ytUrl = message.match(/https?:\/\/\S*(?:youtube\.com|youtu\.be)\/\S*/)?.[0]
        if (ytUrl) {
          const thumb = await youtubeThumb(ytUrl)
          if (thumb) { attachUrl = thumb; attachName = 'video.jpg' }
        }
      }
      if (attachUrl && !fileUidCache) {
        try {
          const fileRes = await fetch(String(attachUrl))
          if (!fileRes.ok) throw new Error(`Datei nicht ladbar (${fileRes.status})`)
          const blob = await fileRes.blob()
          const name = attachName || String(attachUrl).split('/').pop() || 'anhang'
          const form = new FormData()
          form.append('file', blob, name)
          form.append('filename', name)
          const upRes = await fetch('https://app.timelines.ai/integrations/api/files_upload', {
            method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}` }, body: form,
          })
          const upJson = await upRes.json()
          // Antwort ist FileInfoResponse: { status, data: { uid, filename, size, … } }
          // Das Feld heisst `uid` (NICHT file_uid — das ist nur der Parametername
          // beim Senden). Fallbacks fuer den Fall, dass sich die Form aendert.
          fileUidCache = (upJson?.data?.uid ?? upJson?.uid ?? upJson?.data?.file_uid ?? null) as string | null
          console.log(`[send-whatsapp] Upload ${upRes.status}, uid=${fileUidCache ?? 'KEINE'}`, fileUidCache ? '' : JSON.stringify(upJson))
        } catch (e) {
          console.warn('[send-whatsapp] Anhang-Upload fehlgeschlagen, sende nur Text:', e)
        }
      }
      if (fileUidCache) payload.file_uid = fileUidCache
      console.log(`[send-whatsapp] Sende an ${recipient.phone}`, JSON.stringify(payload))

      const res = await fetch('https://app.timelines.ai/integrations/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      console.log(`[send-whatsapp] Antwort ${res.status} für ${recipient.phone}:`, JSON.stringify(json))
      if (!res.ok) console.error(`[send-whatsapp] FEHLER ${res.status} für ${recipient.phone}:`, JSON.stringify(json))
      results.push({ phone: recipient.phone, ok: res.ok, status: res.status, data: json })
    }

    // ── Aktivität in CRM loggen ───────────────────────────────────
    if (lead_id) {
      await supabase.from('activities').insert({
        lead_id,
        type:         'whatsapp',
        direction:    'outbound',
        subject:      `WhatsApp: ${event_type}`,
        content:      message,
        completed_at: new Date().toISOString(),
      })
    }

    return new Response(
      JSON.stringify({ success: true, sent: results.length, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    console.error('[send-whatsapp]', error)
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
