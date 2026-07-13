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
import { encodeMimeSubject } from '../_shared/mimeSubject.ts'
import { htmlToText as stripHtml } from '../_shared/htmlToText.ts'
import { buildMimeContent } from '../_shared/mimeBody.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Platzhalter ersetzen ─────────────────────────────────────────────────────
function replacePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
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
      // Direkter Anhang (z.B. generierte Rechnung) — Base64-kodiert, ohne Storage-Umweg.
      attachment?:      { filename: string; content_base64: string; content_type?: string } | null
      // Mehrere frei angehängte Dateien (z.B. aus dem Kunden-Mail-Composer).
      attachments?:     Array<{ filename: string; content_base64: string; content_type?: string }> | null
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
    let pdfAttachment: { filename: string; content: Uint8Array; contentType?: string } | null = null

    // Direkter Base64-Anhang (z.B. Rechnung aus generate-invoice) hat Vorrang.
    if (body.attachment?.content_base64) {
      try {
        const bin = atob(body.attachment.content_base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        pdfAttachment = {
          filename: body.attachment.filename || 'anhang.pdf',
          content: bytes,
          contentType: body.attachment.content_type || 'application/pdf',
        }
        console.log(`[send-email] Direkter Anhang: ${pdfAttachment.filename} (${bytes.byteLength} Bytes)`)
      } catch (e) {
        console.warn('[send-email] Anhang-Dekodierung fehlgeschlagen:', e)
      }
    }

    if (!pdfAttachment && attach_category) {
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

    // Mehrere frei angehängte Dateien (Kunden-Mail-Composer) — ergänzen den evtl.
    // schon gesetzten Einzel-Anhang (Rechnung/Kategorie).
    const extraAttachments: { filename: string; content: Uint8Array; contentType: string }[] = []
    if (Array.isArray(body.attachments)) {
      for (const a of body.attachments) {
        if (!a?.content_base64) continue
        try {
          const bin = atob(a.content_base64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          extraAttachments.push({ filename: a.filename || 'datei', content: bytes, contentType: a.content_type || 'application/octet-stream' })
        } catch (e) {
          console.warn('[send-email] Anhang-Dekodierung fehlgeschlagen:', e)
        }
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
          subject: encodeMimeSubject(subject),
          // Body als Base64-mimeContent statt html/content — umgeht denomailers kaputten
          // QP-Zeilenumbruch, der UTF-8-Umlaute an der Zeilengrenze zerstört (mimeBody.ts).
          mimeContent: buildMimeContent(html, stripHtml(html)),
        }

        const allAttach = [
          ...(pdfAttachment ? [{ filename: pdfAttachment.filename, content: pdfAttachment.content, contentType: pdfAttachment.contentType ?? 'application/pdf', encoding: 'base64' as const }] : []),
          ...extraAttachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType, encoding: 'base64' as const })),
        ]
        if (allAttach.length) mailPayload.attachments = allAttach

        await client.send(mailPayload)
        console.log('[send-email] ✓ Gesendet an:', to, allAttach.length ? `(mit ${allAttach.length} Anhang/Anhängen)` : '')
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
    const attachNames = [
      ...(pdfAttachment ? [pdfAttachment.filename] : []),
      ...extraAttachments.map(a => a.filename),
    ]
    if (lead_id) {
      const contentWithAttachInfo = attachNames.length
        ? `${stripHtml(html).slice(0, 1900)}\n\n📎 Anhang: ${attachNames.join(', ')}`
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
        attachmentSent:   attachNames.length > 0,
        attachmentFile:   attachNames[0] ?? null,
        attachmentCount:  attachNames.length,
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
