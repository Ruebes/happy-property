// Supabase Edge Function: send-booking-confirmation
// Sendet eine Buchungsbestätigungs-E-Mail an den Gast.
//
// Benötigte Umgebungsvariablen (Supabase Dashboard → Settings → Edge Functions):
//   RESEND_API_KEY   = re_xxxx...   (https://resend.com – kostenlos bis 3.000/Monat)
//   FROM_EMAIL       = noreply@yourdomain.com
//
// Aufruf: supabase.functions.invoke('send-booking-confirmation', { body: { booking_id } })

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { booking_id } = await req.json()
    if (!booking_id) {
      return new Response(JSON.stringify({ error: 'booking_id required' }), { status: 400, headers: corsHeaders })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Buchung + Immobilie + Gast laden
    const { data: booking, error: fetchErr } = await supabase
      .from('bookings')
      .select(`
        *,
        property:properties(project_name, unit_number, street, house_number, city, zip),
        guest:profiles!bookings_guest_id_fkey(full_name, email, language)
      `)
      .eq('id', booking_id)
      .single()

    if (fetchErr || !booking) {
      console.error('[send-booking-confirmation] Booking not found:', fetchErr)
      return new Response(JSON.stringify({ error: 'Booking not found' }), { status: 404, headers: corsHeaders })
    }

    const guest    = booking.guest    as { full_name: string; email: string; language: string } | null
    const property = booking.property as { project_name: string; unit_number: string | null; street: string | null; house_number: string | null; city: string | null; zip: string | null } | null

    if (!guest?.email) {
      console.warn('[send-booking-confirmation] No guest email for booking', booking_id)
      return new Response(JSON.stringify({ ok: true, skipped: 'no_email' }), { headers: corsHeaders })
    }

    const isDE      = (guest.language ?? 'de') !== 'en'
    const guestName = guest.full_name?.split(' ')[0] ?? guest.full_name ?? (isDE ? 'Gast' : 'Guest')
    const propName  = [property?.project_name, property?.unit_number].filter(Boolean).join(' · ') || '–'
    const address   = [
      [property?.street, property?.house_number].filter(Boolean).join(' '),
      [property?.zip, property?.city].filter(Boolean).join(' '),
    ].filter(Boolean).join(', ') || '–'

    const checkIn  = formatDate(booking.check_in,  isDE ? 'de-DE' : 'en-GB')
    const checkOut = formatDate(booking.check_out, isDE ? 'de-DE' : 'en-GB')
    const nights   = nightsBetween(booking.check_in, booking.check_out)
    const price    = booking.total_price_gross ?? booking.total_price ?? 0
    const isOwner  = booking.is_owner_stay === true

    const subject = isDE
      ? `Buchungsbestätigung – ${propName}`
      : `Booking Confirmation – ${propName}`

    const html = buildHtml({ isDE, guestName, propName, address, checkIn, checkOut, nights, price, isOwner, bookingNumber: booking.booking_number })

    // E-Mail senden via Resend
    const resendKey = Deno.env.get('RESEND_API_KEY')
    const fromEmail = Deno.env.get('FROM_EMAIL') ?? 'noreply@happyproperty.app'

    if (!resendKey) {
      console.warn('[send-booking-confirmation] RESEND_API_KEY not set – email not sent')
      return new Response(JSON.stringify({ ok: true, skipped: 'no_resend_key' }), { headers: corsHeaders })
    }

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from:    fromEmail,
        to:      guest.email,
        subject: subject,
        html:    html,
      }),
    })

    if (!sendRes.ok) {
      const errBody = await sendRes.text()
      console.error('[send-booking-confirmation] Resend error:', errBody)
      return new Response(JSON.stringify({ error: 'Email send failed', detail: errBody }), { status: 500, headers: corsHeaders })
    }

    console.log('[send-booking-confirmation] Email sent to', guest.email, 'for booking', booking_id)
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })

  } catch (err) {
    console.error('[send-booking-confirmation]', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders })
  }
})

// ── Helpers ───────────────────────────────────────────────────

function formatDate(d: string, locale: string): string {
  try { return new Date(d).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }) }
  catch { return d }
}

function nightsBetween(ci: string, co: string): number {
  try { return Math.round((new Date(co).getTime() - new Date(ci).getTime()) / 86400000) }
  catch { return 0 }
}

function buildHtml(p: {
  isDE: boolean; guestName: string; propName: string; address: string
  checkIn: string; checkOut: string; nights: number; price: number
  isOwner: boolean; bookingNumber: string | null
}): string {
  const { isDE, guestName, propName, address, checkIn, checkOut, nights, price, isOwner, bookingNumber } = p

  const t = (de: string, en: string) => isDE ? de : en

  return `<!DOCTYPE html>
<html lang="${isDE ? 'de' : 'en'}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; margin: 0; padding: 24px; color: #111; }
  .card { background: #fff; border-radius: 16px; padding: 32px; max-width: 520px; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .logo { font-size: 20px; font-weight: 800; color: #ff795d; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 700; margin: 0 0 8px; }
  .badge { display: inline-block; background: #fff0ec; color: #ff795d; font-weight: 600; font-size: 13px; padding: 4px 12px; border-radius: 100px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
  td:first-child { color: #6b7280; width: 45%; }
  td:last-child { font-weight: 600; }
  .total { font-size: 16px; font-weight: 700; color: #ff795d; }
  .footer { margin-top: 28px; font-size: 13px; color: #9ca3af; border-top: 1px solid #f0f0f0; padding-top: 20px; }
  .btn { display: inline-block; background: #ff795d; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 12px; font-weight: 600; font-size: 14px; margin-top: 20px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🏠 Happy Property</div>
  <span class="badge">✓ ${t('Buchung bestätigt', 'Booking confirmed')}</span>
  <h1>${t('Hallo', 'Hello')} ${guestName},</h1>
  <p style="color:#6b7280;font-size:15px;margin:0 0 8px">
    ${isOwner
      ? t('deine Eigennutzung wurde erfolgreich eingetragen.', 'your owner stay has been successfully registered.')
      : t('deine Buchung ist bestätigt!', 'your booking is confirmed!')}
  </p>
  ${bookingNumber ? `<p style="font-size:13px;color:#9ca3af">${t('Buchungsnummer', 'Booking number')}: <strong>${bookingNumber}</strong></p>` : ''}

  <table>
    <tr><td>${t('Immobilie', 'Property')}</td><td>${propName}</td></tr>
    <tr><td>${t('Adresse', 'Address')}</td><td>${address}</td></tr>
    <tr><td>${t('Check-in', 'Check-in')}</td><td>${checkIn}</td></tr>
    <tr><td>${t('Check-out', 'Check-out')}</td><td>${checkOut}</td></tr>
    <tr><td>${t('Nächte', 'Nights')}</td><td>${nights}</td></tr>
    ${isOwner
      ? `<tr><td>${t('Preis', 'Price')}</td><td>${t('Eigennutzung – kostenfrei', 'Owner stay – no charge')}</td></tr>`
      : `<tr><td class="total">${t('Gesamtpreis', 'Total')}</td><td class="total">${price.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}</td></tr>`
    }
  </table>

  <p style="font-size:14px;color:#374151">
    ${t(
      'Alle weiteren Details (Check-in Infos, Hausregeln, Dokumente) findest du in deinem persönlichen Portal.',
      'All further details (check-in info, house rules, documents) can be found in your personal portal.'
    )}
  </p>

  <a href="${Deno.env.get('APP_URL') ?? 'https://happyproperty.app'}/feriengast/dashboard" class="btn">
    ${t('Zum Portal', 'Open portal')}
  </a>

  <div class="footer">
    ${t(
      'Bei Fragen wende dich direkt an deinen Verwalter über die Nachrichten-Funktion im Portal.',
      'For questions, contact your property manager via the messaging feature in the portal.'
    )}<br>
    Happy Property · ${new Date().getFullYear()}
  </div>
</div>
</body>
</html>`
}
