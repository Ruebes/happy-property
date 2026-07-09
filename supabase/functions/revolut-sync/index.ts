// Edge Function: revolut-sync
// Gleicht Zahlungseingänge auf dem Revolut-Business-Konto (Sveru Ltd) mit
// offenen CRM-Rechnungen (crm_invoices, status='sent') ab und setzt sie bei
// Zahlungseingang auf 'paid' (+ Aktivität am Lead + Info-Mail an Sven).
//
// Aktionen:
//   { action: 'exchange_code', code }  einmalig: Consent-Code → refresh_token
//                                      (Ergebnis als Secret REVOLUT_REFRESH_TOKEN setzen)
//   { action: 'sync' }                 täglicher Abgleich (pg_cron 01:00 UTC = 04:00 Zypern)
//
// Match-Logik (konservativ, keine falschen „bezahlt"):
//   1. Verwendungszweck/Referenz enthält die Rechnungsnummer (z.B. INV-108)
//   2. sonst: Betrag == total_gross UND der Betrag ist unter den offenen
//      Rechnungen EINDEUTIG — sonst nur Hinweis-Mail an Sven, kein Auto-Update.
//
// Secrets: REVOLUT_CLIENT_ID     (aus dem Revolut-Zertifikats-Dialog)
//          REVOLUT_PRIVATE_KEY   (PEM, Gegenstück zum hochgeladenen X509-Cert)
//          REVOLUT_ISS           (Domain der OAuth-Redirect-URI, portal.happy-property.com)
//          REVOLUT_REFRESH_TOKEN (aus exchange_code)
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (Standard)
//
// Deployment: supabase functions deploy revolut-sync --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const API = 'https://b2b.revolut.com/api/1.0'

// ── JWT client_assertion (RS256) — gleiche Signatur-Mechanik wie funnel-api/SA ──
function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function importKey(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\\n/g, '').replace(/\s+/g, '')
  return crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(b), c => c.charCodeAt(0)).buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
async function clientAssertion(): Promise<string> {
  const pem = Deno.env.get('REVOLUT_PRIVATE_KEY')!
  const clientId = Deno.env.get('REVOLUT_CLIENT_ID')!
  const iss = Deno.env.get('REVOLUT_ISS') ?? 'portal.happy-property.com'
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss, sub: clientId, aud: 'https://revolut.com', iat: now, exp: now + 300 })}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(pem), new TextEncoder().encode(unsigned))
  return `${unsigned}.${b64url(new Uint8Array(sig))}`
}
async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    ...params,
    client_id: Deno.env.get('REVOLUT_CLIENT_ID')!,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await clientAssertion(),
  })
  const r = await fetch(`${API}/auth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  const d = await r.json().catch(() => ({})) as Record<string, unknown>
  if (!r.ok) throw new Error(`Revolut auth ${r.status}: ${JSON.stringify(d).slice(0, 300)}`)
  return d
}

interface RevolutLeg { amount: number; currency: string; description?: string }
interface RevolutTx {
  id: string; type: string; state: string; created_at: string
  reference?: string; legs?: RevolutLeg[]
}
interface OpenInvoice {
  id: string; invoice_number: string; total_gross: number; currency: string
  lead_id: string | null; deal_id: string | null; token: string | null
  customer_snapshot: { company_name?: string; contact_name?: string; email?: string } | null
}

const BRAND_LOGO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
const eur = (n: number, c: string) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: c || 'EUR' }).format(n)
const dDe = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })

// Zahlungsbestätigung an den Bezahler — CI-Template (Cream/Coral, Logo, Karte)
function paymentConfirmationHtml(inv: OpenInvoice, paidIso: string): string {
  const greet = inv.customer_snapshot?.contact_name ? `Hallo ${inv.customer_snapshot.contact_name},` : 'Guten Tag,'
  const publicUrl = inv.token ? `https://portal.happy-property.com/re/${inv.token}` : null
  return `
  <div style="background:#FAF6EC;padding:32px 16px;font-family:Montserrat,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:36px 32px">
      <img src="${BRAND_LOGO}" alt="Happy Property" style="height:34px;margin-bottom:24px" />
      <div style="font-size:15px;color:#1b1b22;line-height:1.65">
        <p style="margin:0 0 14px">${greet}</p>
        <p style="margin:0 0 20px">vielen Dank — deine Zahlung ist bei uns eingegangen. Die Rechnung ist damit vollständig beglichen.</p>
      </div>
      <div style="background:#FAF6EC;border-radius:12px;padding:20px 24px;margin:0 0 20px">
        <table style="width:100%;font-size:14px;color:#1b1b22;border-collapse:collapse">
          <tr><td style="padding:4px 0;color:#6b7280">Rechnung</td><td style="padding:4px 0;text-align:right;font-weight:600">${inv.invoice_number}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280">Betrag</td><td style="padding:4px 0;text-align:right;font-weight:700;color:#ff795d;font-size:17px">${eur(inv.total_gross, inv.currency)}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280">Eingegangen am</td><td style="padding:4px 0;text-align:right">${dDe(paidIso)}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280">Status</td><td style="padding:4px 0;text-align:right;color:#15803d;font-weight:600">✓ Bezahlt</td></tr>
        </table>
      </div>
      ${publicUrl ? `<p style="font-size:13px;color:#6b7280;margin:0 0 20px">Rechnung online ansehen: <a href="${publicUrl}" style="color:#ff795d">${publicUrl}</a></p>` : ''}
      <p style="font-size:15px;color:#1b1b22;margin:0">Beste Grüße<br/>Happy Property</p>
    </div>
    <p style="max-width:560px;margin:14px auto 0;font-size:11px;color:#9ca3af;text-align:center">sveru ltd · Tepeleniou 13, Tepelenio Court, 8010 Paphos · Diese Bestätigung wurde automatisch erstellt.</p>
  </div>`
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; code?: string }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (!Deno.env.get('REVOLUT_CLIENT_ID') || !Deno.env.get('REVOLUT_PRIVATE_KEY')) {
      return json({ error: 'Revolut nicht konfiguriert (REVOLUT_CLIENT_ID/REVOLUT_PRIVATE_KEY fehlen)' }, 400)
    }

    // ── Einmalig: Consent-Code gegen refresh_token tauschen ──────────────────
    // Wird von der öffentlichen Seite /revolut aufgerufen (fängt den OAuth-Redirect).
    // Der refresh_token wird NUR serverseitig gespeichert (integration_secrets,
    // RLS ohne Policies = nur service_role) und nie an den Browser zurückgegeben.
    if (body.action === 'exchange_code') {
      if (!body.code) return json({ error: 'code fehlt' }, 400)
      const d = await tokenRequest({ grant_type: 'authorization_code', code: body.code })
      if (!d.refresh_token) return json({ error: 'Revolut hat keinen refresh_token geliefert' }, 500)
      const { error: se } = await supabase.from('integration_secrets')
        .upsert({ key: 'revolut_refresh_token', value: d.refresh_token as string, updated_at: new Date().toISOString() })
      if (se) throw se
      console.log('[revolut-sync] Code getauscht, refresh_token gespeichert')
      return json({ success: true })
    }

    // ── Täglicher Sync ────────────────────────────────────────────────────────
    const { data: tokRow } = await supabase.from('integration_secrets')
      .select('value').eq('key', 'revolut_refresh_token').maybeSingle()
    const refreshToken = (tokRow as { value?: string } | null)?.value || Deno.env.get('REVOLUT_REFRESH_TOKEN')
    if (!refreshToken) return json({ error: 'Kein refresh_token — erst die Verbindung über /revolut abschließen' }, 400)

    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    const accessToken = tok.access_token as string

    // Offene Rechnungen
    const { data: openInv, error: invErr } = await supabase
      .from('crm_invoices')
      .select('id, invoice_number, total_gross, currency, lead_id, deal_id, token, customer_snapshot')
      .eq('status', 'sent')
    if (invErr) throw invErr
    const open = (openInv ?? []) as OpenInvoice[]
    if (!open.length) {
      console.log('[revolut-sync] Keine offenen Rechnungen')
      return json({ success: true, matched: [], open: 0 })
    }

    // Transaktionen der letzten 14 Tage (eingehend, abgeschlossen)
    const from = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10)
    const txRes = await fetch(`${API}/transactions?from=${from}&count=500`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!txRes.ok) throw new Error(`Revolut transactions ${txRes.status}: ${(await txRes.text()).slice(0, 300)}`)
    const txs = await txRes.json() as RevolutTx[]
    const incoming = txs.filter(t =>
      t.state === 'completed' && (t.legs ?? []).some(l => l.amount > 0),
    )
    console.log(`[revolut-sync] ${open.length} offene Rechnung(en), ${incoming.length} Zahlungseingänge seit ${from}`)

    const cents = (n: number) => Math.round(n * 100)
    const matched: Array<{ invoice: string; tx: string; via: string }> = []
    const ambiguous: string[] = []

    for (const inv of open) {
      const invCents = cents(inv.total_gross)
      // 1) Referenz enthält Rechnungsnummer — Betrag muss trotzdem stimmen,
      //    sonst würde eine TEILZAHLUNG die Rechnung fälschlich voll schließen.
      const refTx = incoming.find(t => {
        const txt = `${t.reference ?? ''} ${(t.legs ?? []).map(l => l.description ?? '').join(' ')}`.toLowerCase()
        return txt.includes(inv.invoice_number.toLowerCase())
      })
      let tx = refTx
      let via = 'referenz'
      if (refTx && !(refTx.legs ?? []).some(l => l.amount > 0 && cents(l.amount) === invCents)) {
        const got = (refTx.legs ?? []).find(l => l.amount > 0)
        ambiguous.push(`${inv.invoice_number}: Zahlung mit passender Referenz, aber abweichendem Betrag (${got?.amount ?? '?'} statt ${inv.total_gross} ${inv.currency}) — Teilzahlung? Bitte manuell prüfen.`)
        continue
      }
      // 2) Betrag exakt + eindeutig
      if (!tx) {
        const sameAmountInvoices = open.filter(o => cents(o.total_gross) === invCents && o.currency === inv.currency)
        const amountTxs = incoming.filter(t => (t.legs ?? []).some(l => l.amount > 0 && cents(l.amount) === invCents && l.currency === inv.currency))
        if (amountTxs.length >= 1 && sameAmountInvoices.length === 1) { tx = amountTxs[0]; via = 'betrag' }
        else if (amountTxs.length >= 1 && sameAmountInvoices.length > 1) {
          ambiguous.push(`${inv.invoice_number} (${inv.total_gross} ${inv.currency}: ${sameAmountInvoices.length} offene Rechnungen mit gleichem Betrag)`)
          continue
        }
      }
      if (!tx) continue

      const { error: updErr } = await supabase.from('crm_invoices')
        .update({ status: 'paid', paid_at: tx.created_at })
        .eq('id', inv.id).eq('status', 'sent')
      if (updErr) { console.error(`[revolut-sync] Update ${inv.invoice_number}:`, updErr.message); continue }
      matched.push({ invoice: inv.invoice_number, tx: tx.id, via })
      console.log(`[revolut-sync] ✓ ${inv.invoice_number} bezahlt (${via}, tx ${tx.id})`)

      if (inv.lead_id) {
        try {
          await supabase.from('activities').insert({
            lead_id: inv.lead_id, deal_id: inv.deal_id, type: 'note', direction: 'inbound',
            subject: `💶 Zahlungseingang ${inv.invoice_number}`,
            content: `Revolut: ${inv.total_gross} ${inv.currency} eingegangen am ${tx.created_at.slice(0, 10)} (Match: ${via}). Rechnung automatisch auf „bezahlt" gesetzt.`,
            completed_at: new Date().toISOString(),
          })
        } catch (e) { console.warn('[revolut-sync] Aktivität fehlgeschlagen:', e) }
      }
      // Zahlungsbestätigung an den BEZAHLER (Sven will keine eigene Info-Mail —
      // er sieht den Eingang als Aktivität und am Rechnungsstatus)
      const payerEmail = (inv.customer_snapshot?.email ?? '').trim()
      if (payerEmail) {
        try {
          await supabase.functions.invoke('send-email', { body: {
            to: payerEmail, lead_id: inv.lead_id, deal_id: inv.deal_id,
            subject: `Zahlungseingang bestätigt — Rechnung ${inv.invoice_number}`,
            html: paymentConfirmationHtml(inv, tx.created_at),
          } })
          console.log(`[revolut-sync] Zahlungsbestätigung an ${payerEmail} gesendet`)
        } catch (e) { console.warn('[revolut-sync] Zahlungsbestätigung fehlgeschlagen:', e) }
      } else {
        console.warn(`[revolut-sync] Keine Kunden-E-Mail an ${inv.invoice_number} — Bestätigung übersprungen`)
      }
    }

    if (ambiguous.length) {
      try {
        await supabase.functions.invoke('send-email', { body: {
          to: 'sven@happy-property.com',
          subject: '⚠️ Revolut-Abgleich: Zahlung passt auf mehrere Rechnungen',
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#374151">Ein Zahlungseingang passt vom Betrag her auf mehrere offene Rechnungen — bitte manuell zuordnen (Rechnungen → Status setzen):<br><br>${ambiguous.join('<br>')}</div>`,
        } })
      } catch (e) { console.warn('[revolut-sync] Hinweis-Mail fehlgeschlagen:', e) }
    }

    return json({ success: true, matched, ambiguous, open: open.length, incoming: incoming.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[revolut-sync] Fehler:', msg)
    return json({ error: msg }, 500)
  }
})
