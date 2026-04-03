// Edge Function: send-email
// Sendet E-Mails via Ionos SMTP (denomailer) und loggt sie als CRM-Aktivität.
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  try {
    const { to, subject, html, lead_id, deal_id } = await req.json() as {
      to:       string
      subject:  string
      html:     string
      lead_id?: string | null
      deal_id?: string | null
    }

    if (!to || !subject || !html) {
      return new Response(
        JSON.stringify({ error: 'Pflichtfelder fehlen: to, subject, html' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const smtpUser = Deno.env.get('SMTP_USER') ?? ''
    const smtpPass = Deno.env.get('SMTP_PASS') ?? ''

    // ── SMTP-Versand via denomailer ───────────────────────────────────
    if (smtpUser && smtpPass) {
      const client = new SMTPClient({
        connection: {
          hostname: 'smtp.ionos.de',
          port:     465,
          tls:      true,          // SSL/TLS direkt – Port 465
          auth: {
            username: smtpUser,
            password: smtpPass,
          },
        },
      })

      try {
        await client.send({
          from:    `Sven Rüprich <sven@happy-property.com>`,
          to:      to,
          subject: subject,
          html:    html,
          content: stripHtml(html),   // Plaintext-Fallback
        })
        console.log('[send-email] ✓ Gesendet an:', to)
      } catch (smtpErr) {
        console.error('[send-email] SMTP Fehler (Port 465/TLS):', smtpErr)
        throw smtpErr
      } finally {
        await client.close()
      }
    } else {
      // Kein SMTP konfiguriert → simulieren (lokale Entwicklung)
      console.warn('[send-email] SMTP_USER/SMTP_PASS fehlen – simulierter Versand an:', to)
    }

    // ── Aktivität in CRM loggen ───────────────────────────────────────
    if (lead_id) {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )

      const { error: logErr } = await supabase.from('activities').insert({
        lead_id:      lead_id,
        deal_id:      deal_id ?? null,
        type:         'email',
        direction:    'outbound',
        subject:      subject,
        content:      stripHtml(html).slice(0, 2000),
        completed_at: new Date().toISOString(),
      })

      if (logErr) console.warn('[send-email] Aktivitäts-Log fehlgeschlagen:', logErr.message)
    }

    return new Response(
      JSON.stringify({ success: true }),
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

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
