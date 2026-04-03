// Supabase Edge Function: notify-bank-change
// Versendet E-Mail an alle Verwalter wenn ein Eigentümer Bankdaten ändert.
// Nutzt Resend API (kostenlos bis 3.000 Mails/Monat).
//
// Deploy: supabase functions deploy notify-bank-change
// Env: RESEND_API_KEY, NOTIFY_FROM_EMAIL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') ?? ''
const FROM_EMAIL       = Deno.env.get('NOTIFY_FROM_EMAIL') ?? 'noreply@happyproperty.de'
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  try {
    const { owner_name, old_iban_masked, new_iban_masked, changed_at } = await req.json()

    // Fetch all verwalter emails
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: managers } = await admin
      .from('profiles')
      .select('email, full_name')
      .in('role', ['admin', 'verwalter'])
      .eq('is_active', true)

    if (!managers || managers.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 })
    }

    const date = new Date(changed_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })
    const subject = `Bankdaten geändert – ${owner_name}`

    const html = `
      <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="color: #ff795d; margin-bottom: 24px;">⚠️ Bankdaten-Änderung</h2>
        <table style="width: 100%; border-collapse: collapse; background: #f9fafb; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="padding: 12px 16px; font-size: 13px; color: #6b7280; width: 40%;">Eigentümer</td>
            <td style="padding: 12px 16px; font-size: 13px; font-weight: 600;">${owner_name}</td>
          </tr>
          <tr style="background: #fff;">
            <td style="padding: 12px 16px; font-size: 13px; color: #6b7280;">Datum</td>
            <td style="padding: 12px 16px; font-size: 13px; font-weight: 600;">${date}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; font-size: 13px; color: #6b7280;">Alte IBAN</td>
            <td style="padding: 12px 16px; font-size: 13px; font-family: monospace;">${old_iban_masked ?? '–'}</td>
          </tr>
          <tr style="background: #fff;">
            <td style="padding: 12px 16px; font-size: 13px; color: #6b7280;">Neue IBAN</td>
            <td style="padding: 12px 16px; font-size: 13px; font-family: monospace; font-weight: 700;">${new_iban_masked ?? '–'}</td>
          </tr>
        </table>
        <div style="margin-top: 24px; padding: 16px; background: #fef3c7; border-radius: 12px; border-left: 4px solid #f59e0b;">
          <p style="margin: 0; font-size: 13px; color: #92400e;">
            <strong>Bitte im Portal prüfen und bestätigen.</strong><br/>
            Melde dich im Happy Property Dashboard an, um die Änderung zu verifizieren.
          </p>
        </div>
        <p style="margin-top: 24px; font-size: 11px; color: #9ca3af;">
          Diese E-Mail wurde automatisch von Happy Property versandt.
        </p>
      </div>
    `

    // Send to all managers
    const sends = managers.map(m =>
      fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          from:    FROM_EMAIL,
          to:      [m.email],
          subject,
          html,
        }),
      })
    )
    await Promise.all(sends)

    return new Response(JSON.stringify({ sent: managers.length }), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status:  500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
