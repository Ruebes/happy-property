// Edge Function: send-email
// Sendet E-Mails via Ionos SMTP (denomailer) und loggt sie als CRM-Aktivität.
// Optional: PDF-Anhang aus Supabase Storage (workflow_documents) via category.
//
// ── Secrets (Supabase Dashboard → Settings → Edge Functions → Secrets) ──
//   SMTP_USER  = sven@happy-property.com
//   SMTP_PASS  = [Ionos E-Mail Passwort]
//
// ── Deployment ──
//   supabase functions deploy send-email --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SMTPClient }   from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Platzhalter ersetzen ─────────────────────────────────────────────────────
function replacePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

// ── HTML → Plaintext ──────────────────────────────────────────────────────────
// HTML → saubere Text-Alternative (multipart/alternative für Empfänger ohne HTML).
// WICHTIG: Link-URLs aus <a href> bewahren, sonst hätte die Textversion keine Links.
function stripHtml(html: string): string {
  return html
    // <a href="URL">Label</a> → "Label: URL" (mailto/tel ohne Doppelung)
    .replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, url, label) => {
      const text = String(label).replace(/<[^>]+>/g, '').trim()
      if (/^(mailto:|tel:)/i.test(url)) return text || url.replace(/^(mailto:|tel:)/i, '')
      return text ? `${text}: ${url}` : url
    })
    .replace(/<img\b[^>]*>/gi, '')                    // Bilder raus (inkl. Tracking-Pixel)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|h1|h2|h3|div|li)>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&middot;|·/g, '·')
    .replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── PDF von URL als Uint8Array herunterladen ──────────────────────────────────
async function fetchPdfBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[send-email] PDF fetch ${res.status} für ${url}`)
      return null
    }
    const buf = await res.arrayBuffer()
    return new Uint8Array(buf)
  } catch (err) {
    console.warn('[send-email] PDF fetch Fehler:', err)
    return null
  }
}

// ── PDF-Signierte URL für Kategorie laden ─────────────────────────────────────
async function getPdfForCategory(
  supabase: ReturnType<typeof createClient>,
  category: string,
): Promise<{ url: string; fileName: string } | null> {
  const { data, error } = await supabase
    .from('workflow_documents')
    .select('file_path, file_name')
    .eq('category', category)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  const { data: urlData, error: urlErr } = await supabase.storage
    .from('workflow-documents')
    .createSignedUrl(data.file_path, 300)  // 5 min reicht für Versand

  if (urlErr || !urlData?.signedUrl) return null
  return { url: urlData.signedUrl, fileName: data.file_name }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  try {
    const body = await req.json() as {
      to:               string
      subject?:         string
      html?:            string
      template_id?:     string | null    // ID aus email_templates → Platzhalter werden ersetzt
      template_vars?:   Record<string, string> | null  // { vorname, nachname, ... }
      lead_id?:         string | null
      deal_id?:         string | null
      attach_category?: string | null
      open_token?:      string | null   // Deck-Token → Mail-Öffnungs-Pixel (Engagement-Tracking)
    }

    const { to, lead_id, deal_id, attach_category, open_token } = body
    let { subject = '', html = '' } = body

    if (!to) {
      return new Response(
        JSON.stringify({ error: 'Pflichtfeld fehlt: to' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // ── Template aus DB laden und Platzhalter ersetzen ────────────────────────
    if (body.template_id) {
      const { data: tpl } = await supabase
        .from('email_templates')
        .select('subject, body, html_body')
        .eq('id', body.template_id)
        .single()

      if (tpl) {
        const vars = body.template_vars ?? {}
        subject = subject || replacePlaceholders(tpl.subject, vars)
        // Bevorzuge html_body wenn vorhanden, sonst text body als <pre>-Block
        if (tpl.html_body) {
          html = replacePlaceholders(tpl.html_body, vars)
        } else {
          const textBody = replacePlaceholders(tpl.body, vars)
          html = html || `<pre style="font-family:sans-serif;white-space:pre-wrap">${textBody}</pre>`
        }
      }
    }

    if (!subject || !html) {
      return new Response(
        JSON.stringify({ error: 'Pflichtfelder fehlen: subject + html (oder template_id)' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const smtpUser = Deno.env.get('SMTP_USER') ?? ''
    const smtpPass = Deno.env.get('SMTP_PASS') ?? ''

    // ── PDF-Anhang vorbereiten ────────────────────────────────────────────────
    let pdfAttachment: { filename: string; content: Uint8Array } | null = null

    if (attach_category) {
      const pdfInfo = await getPdfForCategory(supabase, attach_category)
      if (pdfInfo) {
        const bytes = await fetchPdfBytes(pdfInfo.url)
        if (bytes) {
          pdfAttachment = { filename: pdfInfo.fileName, content: bytes }
          console.log(`[send-email] PDF-Anhang: ${pdfInfo.fileName} (${bytes.byteLength} Bytes)`)
        } else {
          console.warn(`[send-email] PDF für Kategorie "${attach_category}" konnte nicht geladen werden – E-Mail wird ohne Anhang gesendet`)
        }
      } else {
        console.warn(`[send-email] Kein aktives Dokument für Kategorie "${attach_category}" gefunden`)
      }
    }

    // Mail-Öffnungs-Pixel (1x1) ans Ende des HTML hängen — meldet beim Öffnen an
    // track-engagement (Engagement-Tracking fürs CRM-Dashboard).
    if (open_token && html.includes('</body>')) {
      const px = `<img src="${Deno.env.get('SUPABASE_URL')}/functions/v1/track-engagement?type=email_open&token=${encodeURIComponent(open_token)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;">`
      html = html.replace('</body>', `${px}</body>`)
    }

    // ── SMTP-Versand via denomailer ───────────────────────────────────────────
    if (smtpUser && smtpPass) {
      const client = new SMTPClient({
        connection: {
          hostname: 'smtp.ionos.de',
          port:     465,
          tls:      true,
          auth: {
            username: smtpUser,
            password: smtpPass,
          },
        },
      })

      try {
        // denomailer erwartet attachments als Array von Objekten
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mailPayload: Record<string, any> = {
          // Absender = das konfigurierte SMTP-Postfach (smtpUser). Stellt Sven den SMTP-Login
          // auf info@ um, wird der Absender automatisch info@ — kein Code/Secret-Timing nötig,
          // und From passt immer zum authentifizierten Konto (sonst lehnt IONOS ab).
          from:    `Sven von Happy Property Cyprus <${smtpUser}>`,
          // Antworten laufen ins info@-Postfach (von dort liest sie künftig der CRM-Posteingang).
          replyTo: `info@happy-property.com`,
          to:      to,
          subject: subject,
          html:    html,
          content: stripHtml(html),
        }

        if (pdfAttachment) {
          mailPayload.attachments = [
            {
              filename:    pdfAttachment.filename,
              content:     pdfAttachment.content,
              contentType: 'application/pdf',
              encoding:    'base64',
            },
          ]
        }

        await client.send(mailPayload)
        console.log('[send-email] ✓ Gesendet an:', to, pdfAttachment ? `(mit Anhang: ${pdfAttachment.filename})` : '')
      } catch (smtpErr) {
        console.error('[send-email] SMTP Fehler (Port 465/TLS):', smtpErr)
        throw smtpErr
      } finally {
        await client.close()
      }
    } else {
      // Kein SMTP konfiguriert → simulieren (lokale Entwicklung)
      console.warn('[send-email] SMTP_USER/SMTP_PASS fehlen – simulierter Versand an:', to)
      if (pdfAttachment) {
        console.warn('[send-email] Anhang (simuliert):', pdfAttachment.filename)
      }
    }

    // ── Aktivität in CRM loggen ───────────────────────────────────────────────
    if (lead_id) {
      const contentWithAttachInfo = pdfAttachment
        ? `${stripHtml(html).slice(0, 1900)}\n\n📎 Anhang: ${pdfAttachment.filename}`
        : stripHtml(html).slice(0, 2000)

      const { error: logErr } = await supabase.from('activities').insert({
        lead_id:      lead_id,
        deal_id:      deal_id ?? null,
        type:         'email',
        direction:    'outbound',
        subject:      subject,
        content:      contentWithAttachInfo,
        completed_at: new Date().toISOString(),
      })

      if (logErr) console.warn('[send-email] Aktivitäts-Log fehlgeschlagen:', logErr.message)
    }

    return new Response(
      JSON.stringify({
        success:          true,
        attachmentSent:   !!pdfAttachment,
        attachmentFile:   pdfAttachment?.filename ?? null,
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[send-email] Fehler:', msg)
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
