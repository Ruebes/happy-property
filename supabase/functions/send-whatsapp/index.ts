import { createClient } from 'jsr:@supabase/supabase-js@2'
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Recipient = { name: string; phone: string }

// Supabase-Storage-Bild in WhatsApp-tauglicher Größe ausliefern lassen.
// Die Original-Renders sind 3–7 MB und würden das 2-MB-Limit von TimelinesAI
// sprengen. Der /render/image/-Pfad liefert dieselbe Datei verkleinert aus
// (gemessen: 6.078 KB → 284 KB). Fremde URLs bleiben unverändert.
// Kurzer, stabiler Hash des normalisierten Textes für den Doppel-Schutz.
const DEDUP_HOURS = 6
function bodyHash(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase()
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0
  return h.toString(36) + ':' + t.length
}
function waSize(url: string): string {
  if (!url.includes('/storage/v1/object/public/')) return url
  // Nur Bilder durch den Verkleinerer schicken: /render/image/ wandelt eine PDF/
  // Doc-URL in einen 400er. Endungen ohne Bild-Typ (pdf/doc/...) unveraendert lassen.
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase()
  if (ext && !['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return url
  const u = url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
  // 1080 statt 1280: Bei 1280 liefert Supabase PNG-Quellen unverändert gross zurück
  // (gemessen 2.402 KB → über dem 2-MB-Limit), bei 1080 greift die WebP-Umwandlung
  // (94 KB). Für WhatsApp ist 1080 px ohnehin mehr als ausreichend.
  return u + (u.includes('?') ? '&' : '?') + 'width=1080&quality=75'
}

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
      persona_image, // NACHRANGIGES Absenderbild (Lotte). Greift nur, wenn weder ein
                     // ausdruecklicher Anhang noch ein inhaltliches Motiv da ist —
                     // ein Wohnungsbild schlaegt das Hundefoto immer.
      auto,          // true = von einer Automatik erzeugt → im Posteingang ausgeblendet.
                     // Default false: eine vergessene Markierung zeigt eine Nachricht
                     // zu viel; eine echte Kundennachricht zu verstecken waere schlimmer.
      allow_duplicate, // true = Doppel-Schutz umgehen (bewusst gleicher Text erneut)
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
    let attachError:  string | null = null
    // waSize auch fuer EXPLIZITE Anhaenge: ein Vorlagenbild aus dem Storage kommt
    // sonst in Originalgroesse (gemessen 8,4 MB Deck-Render) und scheitert still an
    // der 2-MB-Grenze — die Nachricht ging dann als nackter Text raus, obwohl der
    // Scheduler "sent" meldete. Fremde URLs laesst waSize unveraendert.
    // Unfertige Vorlagen niemals rausschicken. Fuenf aktive Vorlagen enthielten
    // Platzhalter wie [TERMIN-LINK] und das Wort ENTWURF — Nimet Guerses bekam so
    // eine WhatsApp, die sie siezte, einen kaputten Platzhalter zeigte und sich
    // selbst als Entwurf bezeichnete. Lieber gar nicht senden als das.
    if (typeof message === 'string') {
      const rest = message.match(/\[[A-ZÄÖÜ][A-ZÄÖÜ _-]{2,}\]/)?.[0]
      if (rest || /\bENTWURF\b/.test(message)) {
        const grund = rest ? `Platzhalter ${rest} nicht ersetzt` : 'Text ist als ENTWURF markiert'
        console.error(`[send-whatsapp] ABGEBROCHEN — ${grund}:`, message.slice(0, 120))
        return new Response(
          JSON.stringify({ success: false, error: `Nachricht nicht gesendet: ${grund}.` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    let attachUrl:  string | null = file_url  ? waSize(String(file_url))  : null
    let attachName: string | null = file_name ? String(file_name) : null
    const results = []
    for (const recipient of recipients) {
      // ── Universeller Doppel-Schutz ────────────────────────────────
      // Ging GENAU dieser Text an DIESE Nummer schon in den letzten Stunden raus?
      // Dann nicht nochmal. Faengt Re-Trigger, ueberlappende Automatiken und Cron-
      // Races quellenuebergreifend ab. Verschiedene Empfaenger / verschiedene Texte
      // sind nicht betroffen (Key = Nummer + Text-Hash).
      const bh = typeof message === 'string' ? bodyHash(message) : ''
      if (!allow_duplicate && bh) {
        const win = new Date(Date.now() - DEDUP_HOURS * 3600_000).toISOString()
        const { data: dup } = await supabase.from('wa_sent').select('id')
          .eq('phone', recipient.phone).eq('body_hash', bh).gt('sent_at', win).limit(1)
        if (dup && dup.length) {
          console.warn(`[send-whatsapp] Doppel unterdrueckt an ${recipient.phone} (event=${event_type})`)
          results.push({ phone: recipient.phone, ok: true, status: 200, data: { skipped: 'duplicate' } })
          continue
        }
      }
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
        // Deck-Link im Text? Dann das Titelbild des Angebots anhängen — der Kunde
        // sieht die Immobilie, statt nur eine kryptische URL. Quelle ist das Deck
        // selbst (cover-Block, sonst der erste Block mit Bild), also immer das
        // Motiv, das er beim Öffnen auch wirklich sieht.
        if (!attachUrl) {
          const deckTok = message.match(/\/deck\/([A-Za-z0-9_-]{6,})/)?.[1]
          if (deckTok) {
            try {
              const { data: dk } = await supabase.from('sales_decks').select('content').eq('token', deckTok).maybeSingle()
              const blocks = ((dk as { content?: { blocks?: Array<Record<string, unknown>> } } | null)?.content?.blocks) ?? []
              const cover = blocks.find(b => b.type === 'cover' && typeof b.image === 'string')
                         ?? blocks.find(b => typeof b.image === 'string')
              const img = cover?.image as string | undefined
              if (img) { attachUrl = waSize(img); attachName = 'angebot.jpg' }
            } catch (e) { console.warn('[send-whatsapp] Deck-Titelbild:', e) }
          }
        }
      }
      // Erst jetzt das Absenderbild: Anhang, YouTube-Vorschau und Deck-Titelbild
      // hatten Vorrang. Ohne diese Reihenfolge haette der Bot bei jedem Angebot ein
      // Hundefoto statt der Immobilie geschickt.
      if (!attachUrl && !fileUidCache && persona_image) {
        attachUrl = waSize(String(persona_image)); attachName = 'lotte.jpg'
      }
      if (attachUrl && !fileUidCache) {
        try {
          // KEIN Accept: image/webp mehr — WhatsApp zeigt WebP-Dateien nicht als
          // Bild an (Sven: „es kommt ein Bild, kann es aber nicht laden"). PNG holen
          // und selbst nach JPEG wandeln: der Supabase-Verkleinerer kann kein JPEG
          // erzeugen, und die PNG-Renders bleiben auch verkleinert bei 3–5 MB.
          const fileRes = await fetch(String(attachUrl), { headers: { Accept: 'image/*,*/*' } })
          if (!fileRes.ok) throw new Error(`Datei nicht ladbar (${fileRes.status})`)
          let bytes = new Uint8Array(await fileRes.arrayBuffer())
          let ctype = (fileRes.headers.get('content-type') ?? '').split(';')[0].trim()
          if (ctype === 'image/png' || ctype === 'image/webp') {
            try {
              const img = await Image.decode(bytes)
              bytes = await img.encodeJPEG(82)
              ctype = 'image/jpeg'
              console.log(`[send-whatsapp] → JPEG ${Math.round(bytes.length / 1024)} KB`)
            } catch (e) { console.warn('[send-whatsapp] JPEG-Umwandlung fehlgeschlagen, sende Original:', e) }
          }
          // TimelinesAI nimmt im aktuellen Tarif max. 2 MB. Ist der Anhang groesser
          // und ein BILD, verkleinern wir ihn, bis er passt (Sven: „die musst du,
          // wenn sie groesser sind, direkt verkleinern, so dass es passt") — erst
          // ueber die Qualitaet, dann ueber die Abmessungen. Nicht-Bilder (PDF) lassen
          // sich nicht schrumpfen → dann sauberer Fehler statt kaputter Zustellung.
          if (bytes.length > 2_000_000) {
            const isImg = /^image\//.test(ctype) || ctype === ''
            if (isImg) {
              try {
                let img = await Image.decode(bytes)
                let q = 70
                let out = await img.encodeJPEG(q)
                while (out.length > 2_000_000 && (q > 30 || img.width > 600)) {
                  if (q > 30) { q -= 15 } else { img = img.resize(Math.round(img.width * 0.75), Math.round(img.height * 0.75)) }
                  out = await img.encodeJPEG(q)
                }
                bytes = out; ctype = 'image/jpeg'
                console.log(`[send-whatsapp] Anhang auf ${Math.round(bytes.length / 1024)} KB verkleinert`)
              } catch (e) { console.warn('[send-whatsapp] Verkleinern fehlgeschlagen:', e) }
            }
            if (bytes.length > 2_000_000) throw new Error(`Anhang zu groß (${Math.round(bytes.length / 1024)} KB) — konnte nicht klein genug komprimiert werden`)
          }
          const ext = ctype === 'image/jpeg' ? 'jpg' : ctype === 'image/png' ? 'png'
                    : ctype === 'application/pdf' ? 'pdf' : ctype === 'image/webp' ? 'webp' : ''
          let name = attachName || String(attachUrl).split('/').pop() || 'anhang'
          if (ext) name = name.replace(/\.[A-Za-z0-9]+$/, '') + '.' + ext
          const form = new FormData()
          form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: ctype || 'application/octet-stream' }), name)
          form.append('filename', name)
          if (ctype) form.append('content_type', ctype)
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
          // Nicht nur loggen: der Aufrufer (und jeder Test) muss sehen koennen, dass
          // das Bild fehlt — genau dieser stille Ausfall hat den 2-MB-Fall verdeckt.
          attachError = e instanceof Error ? e.message : String(e)
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
      // Erfolgreich raus → merken, damit derselbe Text nicht erneut an diese Nummer geht.
      if (res.ok && bh) { try { await supabase.from('wa_sent').insert({ phone: recipient.phone, body_hash: bh }) } catch { /* egal */ } }
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
        auto:         auto === true,
      })
    }

    return new Response(
      JSON.stringify({ success: true, sent: results.length, results,
        // attached sagt, ob wirklich ein Bild dran war — "sent" allein reicht nicht,
        // ein gescheiterter Anhang faellt sonst nie auf.
        attached: !!fileUidCache, ...(attachError ? { attach_error: attachError } : {}) }),
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
