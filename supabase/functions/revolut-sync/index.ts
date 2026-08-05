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

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

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
  id: string; invoice_number: string; subtotal_net: number | null; total_gross: number; currency: string
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
      <img src="${BRAND_LOGO}" alt="Happy Property" style="height:34px;margin-bottom:20px" />
      <div style="text-align:center;margin:0 0 18px;">
        <img src="https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte-kasse.jpg" alt="Lotte" width="240" style="width:240px;max-width:100%;border-radius:14px;" />
        <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · persönliche Assistentin von Sven 🐾</p>
      </div>
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
      <p style="font-size:15px;color:#1b1b22;margin:0">Liebe Grüße<br/>Lotte 🐾<br/><span style="color:#6b7280;font-size:12px">Happy Property</span></p>
    </div>
    <p style="max-width:560px;margin:14px auto 0;font-size:11px;color:#9ca3af;text-align:center">sveru ltd · Tepeleniou 13, Tepelenio Court, 8010 Paphos · Diese Bestätigung wurde automatisch erstellt.</p>
  </div>`
}

// ── Kontobewegungen → fin_transactions (Buchhaltung) ─────────────────────────
// Idempotent über revolut_id (leg-genau); Kategorien aus fin_rules (Substring
// auf Gegenpartei+Verwendungszweck), Eingänge ohne Regel = kundenzahlung.
// Danach: offene Ausgangskorb-Posten gegen neue Abbuchungen matchen.
async function syncTransactions(supabase: SupabaseClient, accessToken: string, days: number, fromOverride?: string) {
  const from = fromOverride ?? new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10)
  // Pagination: liefert die API 1000 Stück, rückwärts weiterblättern (to=ältestes Datum)
  let txs: RevolutTx[] = []
  let to: string | null = null
  for (let page = 0; page < 6; page++) {
    const url = `${API}/transactions?from=${from}&count=1000${to ? `&to=${to}` : ''}`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!r.ok) throw new Error(`Revolut transactions ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const batch = await r.json() as RevolutTx[]
    txs = txs.concat(batch)
    if (batch.length < 1000) break
    to = (batch[batch.length - 1] as { created_at: string }).created_at
  }
  const { data: rulesRaw } = await supabase.from('fin_rules').select('match, category')
  const rules = (rulesRaw ?? []) as { match: string; category: string }[]
  let imported = 0
  for (const t of txs) {
    if (t.state !== 'completed') continue
    const legs = (t.legs ?? []) as Array<{ leg_id?: string; amount: number; currency: string; description?: string; counterparty?: { name?: string } }>
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i]
      const rid = l.leg_id ?? `${t.id}-${i}`
      const counterparty = (l.counterparty?.name ?? l.description ?? '').slice(0, 200)
      const reference = ((t as { reference?: string }).reference ?? l.description ?? '').slice(0, 300)
      const hay = `${counterparty} ${reference}`.toLowerCase()
      const rule = rules.find(x => hay.includes(x.match.toLowerCase()))
      const cat = rule ? rule.category : (l.amount > 0 ? 'kundenzahlung' : null)
      const { data: ins, error } = await supabase.from('fin_transactions').upsert({
        revolut_id: rid, booked_at: (t as { completed_at?: string }).completed_at ?? t.created_at,
        amount: l.amount, currency: l.currency, counterparty, reference,
        ...(cat ? { category: cat, category_source: 'regel' } : {}),
      }, { onConflict: 'revolut_id', ignoreDuplicates: true }).select('id')
      if (error) console.warn('[revolut-sync] tx upsert:', error.message)
      else if (ins && ins.length) imported++
    }
  }
  const { data: openP } = await supabase.from('fin_payables').select('id, amount, doc_url, doc_name').eq('status', 'offen').not('amount', 'is', null)
  let payablesMatched = 0
  for (const p of ((openP ?? []) as Array<{ id: string; amount: number; doc_url: string | null; doc_name: string | null }>)) {
    const { data: cand } = await supabase.from('fin_transactions').select('id').lt('amount', 0)
      .gte('amount', -(p.amount * 1.005)).lte('amount', -(p.amount * 0.995)).is('doc_url', null)
      .order('booked_at', { ascending: false }).limit(1)
    const tx = cand?.[0] as { id: string } | undefined
    if (!tx) continue
    await supabase.from('fin_payables').update({ status: 'bezahlt', paid_at: new Date().toISOString(), matched_tx: tx.id }).eq('id', p.id)
    if (p.doc_url) await supabase.from('fin_transactions').update({ doc_url: p.doc_url, doc_name: p.doc_name }).eq('id', tx.id)
    payablesMatched++
  }
  return { scanned: txs.length, imported, payables_matched: payablesMatched }
}

const FIN_CATS = ['kundenzahlung', 'developer', 'werbung', 'software', 'gebuehren', 'buero', 'reise', 'steuern_abgaben', 'gehalt_privat', 'sonstiges']

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; code?: string; days?: number; partner_mail_id?: string }
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

    // ── KI-Kategorisierung offener Transaktionen ─────────────────────────────
    if (body.action === 'categorize_ai') {
      const { data: unc } = await supabase.from('fin_transactions').select('id, counterparty, reference, amount')
        .is('category', null).order('booked_at', { ascending: false }).limit(40)
      const list = (unc ?? []) as Array<{ id: string; counterparty: string; reference: string; amount: number }>
      if (!list.length) return json({ success: true, categorized: 0 })
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') ?? '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2000,
          system: `Kategorisiere Banktransaktionen einer Zypern-Immobilienvermittlung (sveru ltd / Happy Property). Erlaubte Kategorien: ${FIN_CATS.join(', ')}. Positive Beträge sind Eingänge. Rufe set_categories mit ALLEN Einträgen auf.`,
          messages: [{ role: 'user', content: JSON.stringify(list) }],
          tools: [{ name: 'set_categories', input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, category: { type: 'string', enum: FIN_CATS } }, required: ['id', 'category'] } } }, required: ['items'] } }],
          tool_choice: { type: 'tool', name: 'set_categories' } }),
      })
      const d = await resp.json()
      const tu = ((d.content ?? []) as Array<{ type: string; input?: { items?: Array<{ id: string; category: string }> } }>).find(b => b.type === 'tool_use')
      let n = 0
      for (const it of (tu?.input?.items ?? [])) {
        if (FIN_CATS.includes(it.category)) { await supabase.from('fin_transactions').update({ category: it.category, category_source: 'ki' }).eq('id', it.id).is('category', null); n++ }
      }
      return json({ success: true, categorized: n })
    }

    // ── Eingehende Partner-Rechnung analysieren (aus imap-poll) ──────────────
    // Empfänger enthält sven/sveru → Rechnung FÜR SVEN: passende Abbuchung
    // (Kreditkarte) → Beleg dranhängen, sonst Ausgangskorb. Andernfalls → für
    // einen Kunden (bleibt in den Developer-Mails zum Zuordnen).
    if (body.action === 'fin_analyze') {
      const { data: pmRow } = await supabase.from('partner_mails').select('id, subject, body, from_addr, attachments').eq('id', body.partner_mail_id ?? '').maybeSingle()
      if (!pmRow) return json({ error: 'Mail nicht gefunden' }, 404)
      const m = pmRow as { id: string; subject: string; body: string; from_addr: string; attachments: Array<{ name: string; url: string }> }
      const pdf = (m.attachments ?? []).find(a => /\.pdf$/i.test(a.name)) ?? null
      const content: unknown[] = []
      if (pdf) {
        try {
          const fb = await (await fetch(pdf.url)).arrayBuffer()
          if (fb.byteLength < 4_500_000) {
            let bin = ''; const u8 = new Uint8Array(fb)
            for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192))
            content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: btoa(bin) } })
          }
        } catch (e) { console.warn('[revolut-sync] PDF laden:', e) }
      }
      content.push({ type: 'text', text: `E-Mail von ${m.from_addr}\nBetreff: ${m.subject}\n\n${m.body.slice(0, 2000)}\n\nAnalysiere die Rechnung (PDF falls angehängt) und rufe set_invoice auf.` })
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') ?? '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1000,
          system: 'Du analysierst eingehende Rechnungen für Happy Property (Inhaber Sven Rüprich, Firma sveru ltd, Zypern). Bestimme Rechnungsempfänger, Aussteller, Brutto-Betrag, Währung, Fälligkeit und ob die Rechnung laut Dokument bereits bezahlt ist (paid, receipt, Kreditkartenbeleg).',
          messages: [{ role: 'user', content }],
          tools: [{ name: 'set_invoice', input_schema: { type: 'object', properties: {
            recipient: { type: 'string' }, vendor: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' },
            due_date: { type: 'string', description: 'YYYY-MM-DD oder leer' }, already_paid: { type: 'boolean' }, title: { type: 'string' },
          }, required: ['recipient', 'vendor'] } }],
          tool_choice: { type: 'tool', name: 'set_invoice' } }),
      })
      const d = await resp.json()
      const inv = (((d.content ?? []) as Array<{ type: string; input?: Record<string, unknown> }>).find(b => b.type === 'tool_use')?.input ?? {}) as { recipient?: string; vendor?: string; amount?: number; currency?: string; due_date?: string; already_paid?: boolean; title?: string }
      const forSven = /sven|sveru/i.test(inv.recipient ?? '')
      await supabase.from('partner_mails').update({ fin_class: forSven ? 'sven' : 'kunde', fin_vendor: inv.vendor ?? null, fin_amount: inv.amount ?? null }).eq('id', m.id)
      if (!forSven) return json({ success: true, fin_class: 'kunde' })
      let txId: string | null = null
      if (inv.amount && inv.amount > 0) {
        const { data: cand } = await supabase.from('fin_transactions').select('id').lt('amount', 0)
          .gte('amount', -(inv.amount * 1.005)).lte('amount', -(inv.amount * 0.995)).is('doc_url', null)
          .order('booked_at', { ascending: false }).limit(1)
        txId = (cand?.[0] as { id: string } | undefined)?.id ?? null
      }
      if (txId) {
        await supabase.from('fin_transactions').update({ doc_url: pdf?.url ?? null, doc_name: (pdf?.name ?? m.subject).slice(0, 200), partner_mail_id: m.id }).eq('id', txId)
        return json({ success: true, fin_class: 'sven', matched_tx: txId })
      }
      await supabase.from('fin_payables').insert({
        partner_mail_id: m.id, vendor: (inv.vendor ?? m.from_addr).slice(0, 200), title: ((inv.title ?? m.subject) || 'Rechnung').slice(0, 200),
        amount: inv.amount ?? null, currency: (inv.currency ?? 'EUR').slice(0, 3).toUpperCase(),
        due_at: /^\d{4}-\d{2}-\d{2}$/.test(inv.due_date ?? '') ? inv.due_date : null,
        doc_url: pdf?.url ?? null, doc_name: pdf?.name ?? null,
        status: inv.already_paid ? 'bezahlt' : 'offen',
      })
      return json({ success: true, fin_class: 'sven', payable: true })
    }

    // ── Täglicher Sync ────────────────────────────────────────────────────────
    const { data: tokRow } = await supabase.from('integration_secrets')
      .select('value').eq('key', 'revolut_refresh_token').maybeSingle()
    const refreshToken = (tokRow as { value?: string } | null)?.value || Deno.env.get('REVOLUT_REFRESH_TOKEN')
    if (!refreshToken) return json({ error: 'Kein refresh_token — erst die Verbindung über /revolut abschließen' }, 400)

    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    const accessToken = tok.access_token as string

    // ── Debug-Probe: Was liefert die API zu Belegen/Anhängen? ────────────────
    if (body.action === 'probe') {
      const out: Record<string, unknown> = {}
      const from = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10)
      const txr = await fetch(`${API}/transactions?from=${from}&count=20`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const txs = await txr.json() as Array<Record<string, unknown>>
      const card = txs.find(t => t.type === 'card_payment') ?? txs[0]
      out.list_keys = card ? Object.keys(card) : []
      if (card) {
        const det = await fetch(`${API}/transaction/${card.id}`, { headers: { Authorization: `Bearer ${accessToken}` } })
        const d = await det.json() as Record<string, unknown>
        out.detail_keys = Object.keys(d)
        out.detail_sample = JSON.stringify(d).slice(0, 600)
        for (const ep of [`/transaction/${card.id}/attachments`, `/expenses?from=${from}&count=5`, `/expenses`]) {
          const r2 = await fetch(`${API}${ep}`, { headers: { Authorization: `Bearer ${accessToken}` } })
          out[`ep ${ep.slice(0, 40)}`] = `${r2.status} ${(await r2.text()).slice(0, 300)}`
        }
      }
      return json(out)
    }
    if (body.action === 'probe2') {
      const r = await fetch(`${API}/expenses?from=2024-01-01&count=1000`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const exps = await r.json() as Array<Record<string, unknown>>
      const withRec = exps.filter(e => Array.isArray(e.receipt_ids) && (e.receipt_ids as string[]).length)
      const out: Record<string, unknown> = { total: exps.length, with_receipts: withRec.length, keys: exps[0] ? Object.keys(exps[0]) : [], sample: JSON.stringify(withRec[0] ?? exps[0]).slice(0, 500) }
      const e0 = withRec[0]
      if (e0) {
        const rid = (e0.receipt_ids as string[])[0]
        for (const ep of [`/expenses/${e0.id}/receipts/${rid}/content`, `/receipts/${rid}/content`, `/expenses/${e0.id}/receipt/${rid}`]) {
          const rr = await fetch(`${API}${ep}`, { headers: { Authorization: `Bearer ${accessToken}` } })
          out[`ep ${ep.slice(-30)}`] = `${rr.status} ct=${rr.headers.get('content-type')} len=${(await rr.arrayBuffer()).byteLength}`
        }
      }
      return json(out)
    }

    if (body.action === 'probe4') {
      const r = await fetch(`${API}/expenses?from=2024-01-01&count=1000`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const exps = await r.json() as Array<Record<string, unknown>>
      const e0 = exps.find(e => Array.isArray(e.receipt_ids) && (e.receipt_ids as string[]).length)!
      const rid = (e0.receipt_ids as string[])[0]
      const eps = [
        `/expenses/${e0.id}/receipts/${rid}/content`,
        `/expense/${e0.id}/receipts/${rid}/content`,
        `/receipts/${rid}/content`,
        `/expenses/${e0.id}/receipts/${rid}`,
        `/expenses/${e0.id}/receipts`,
      ]
      const out: Record<string, unknown> = {}
      for (let i = 0; i < eps.length; i++) {
        const rr = await fetch(`${API}${eps[i]}`, { headers: { Authorization: `Bearer ${accessToken}` } })
        const buf = await rr.arrayBuffer()
        out[`${i}: ${eps[i].slice(0, 26)}`] = `${rr.status} ct=${rr.headers.get('content-type')} len=${buf.byteLength} head=${new TextDecoder().decode(buf.slice(0, 100)).replace(/[^\x20-\x7e]/g, '.')}`
      }
      return json(out)
    }
    if (body.action === 'probe3') {
      const r = await fetch(`${API}/expenses?from=2024-01-01&count=1000`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const exps = await r.json() as Array<Record<string, unknown>>
      const e0 = exps.find(e => Array.isArray(e.receipt_ids) && (e.receipt_ids as string[]).length)!
      const rid = (e0.receipt_ids as string[])[0]
      const out: Record<string, unknown> = { expense: e0.id }
      for (const ep of [`/expense/${e0.id}`, `/expense/${e0.id}/receipts/${rid}/content`, `/expense/${e0.id}/receipt/${rid}/content`, `/expenses/${e0.id}`]) {
        const rr = await fetch(`${API}${ep}`, { headers: { Authorization: `Bearer ${accessToken}` } })
        const buf = await rr.arrayBuffer()
        out[`ep ${ep.slice(-34)}`] = `${rr.status} ct=${rr.headers.get('content-type')} len=${buf.byteLength} head=${new TextDecoder().decode(buf.slice(0, 120)).replace(/[^\x20-\x7e]/g, '.')}`
      }
      return json(out)
    }

    // ── Kontobewegungen einlesen (manuell/Backfill) ───────────────────────────
    if (body.action === 'tx_sync' || body.action === 'tx_backfill') {
      const days = body.action === 'tx_backfill' ? Math.min(1200, Number(body.days) || 365) : Math.min(60, Number(body.days) || 14)
      const fromOverride = body.action === 'tx_backfill' && typeof body.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.from) ? body.from : undefined
      const r = await syncTransactions(supabase, accessToken, days, fromOverride)
      return json({ success: true, days, from: fromOverride ?? null, ...r })
    }

    // ── Revolut-Belege (Expenses-App) den Buchungen zuordnen ─────────────────
    // GET /expenses liefert je Ausgabe receipt_ids + transaction_id; der Beleg
    // selbst kommt von /expenses/{id}/receipts/{rid}/content (PDF/Bild).
    // fin_transactions ist LEG-genau → Mapping tx.id→leg_ids über /transactions.
    if (body.action === 'receipts_sync') {
      const from = typeof body.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.from) ? body.from : '2024-01-01'
      const er = await fetch(`${API}/expenses?from=${from}&count=1000`, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (!er.ok) throw new Error(`Revolut expenses ${er.status}`)
      const exps = await er.json() as Array<{ id: string; receipt_ids?: string[]; transaction_id?: string; merchant?: { name?: string }; description?: string; expense_date?: string }>
      const withRec = exps.filter(e => (e.receipt_ids ?? []).length && e.transaction_id)
      // tx.id → leg_ids
      const tr = await fetch(`${API}/transactions?from=${from}&count=1000`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const txs = await tr.json() as Array<{ id: string; legs?: Array<{ leg_id?: string }> }>
      const legMap = new Map<string, string[]>()
      for (const t of txs) legMap.set(t.id, (t.legs ?? []).map((l, i) => l.leg_id ?? `${t.id}-${i}`))
      let attached = 0, skipped = 0, failed = 0
      for (const e of withRec) {
        const legIds = legMap.get(e.transaction_id!) ?? [e.transaction_id!]
        const { data: rows } = await supabase.from('fin_transactions').select('id, doc_url').in('revolut_id', legIds)
        const row = ((rows ?? []) as Array<{ id: string; doc_url: string | null }>).find(x => !x.doc_url)
        if (!row) { skipped++; continue }
        const rid = (e.receipt_ids as string[])[0]
        try {
          const rr = await fetch(`${API}/expenses/${e.id}/receipts/${rid}/content`, { headers: { Authorization: `Bearer ${accessToken}` } })
          if (!rr.ok) { failed++; continue }
          const ct = rr.headers.get('content-type') ?? 'application/pdf'
          const ext = ct.includes('pdf') ? 'pdf' : ct.includes('png') ? 'png' : 'jpg'
          const bytes = new Uint8Array(await rr.arrayBuffer())
          const path = `revolut/${e.id}.${ext}`
          const { error: upErr } = await supabase.storage.from('fin-receipts').upload(path, bytes, { contentType: ct, upsert: true })
          if (upErr) { failed++; continue }
          const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/fin-receipts/${path}`
          const name = `Beleg ${(e.merchant?.name ?? e.description ?? 'Revolut').slice(0, 80)}.${ext}`
          await supabase.from('fin_transactions').update({ doc_url: url, doc_name: name }).eq('id', row.id)
          attached++
        } catch { failed++ }
      }
      return json({ success: true, expenses: exps.length, with_receipts: withRec.length, attached, skipped_has_doc_or_no_tx: skipped, failed })
    }

    // ── Steuerberater-Export: CSV + alle Belege als ZIP + Mail ───────────────
    if (body.action === 'tax_export') {
      const from = typeof body.from === 'string' ? body.from : '2024-01-01'
      const to = typeof body.to === 'string' ? body.to : new Date().toISOString().slice(0, 10)
      let email = typeof body.email === 'string' && body.email.includes('@') ? body.email : ''
      if (!email) {
        const { data: stb } = await supabase.from('crm_business_contacts').select('email').ilike('role', '%steuerberater%').limit(1).maybeSingle()
        email = ((stb as { email?: string } | null)?.email ?? '').trim()
      }
      if (!email) return json({ error: 'Kein Steuerberater-Kontakt mit E-Mail gefunden' }, 400)
      const { zipSync, strToU8 } = await import('https://esm.sh/fflate@0.8.2')
      const { data: txRows } = await supabase.from('fin_transactions')
        .select('booked_at, amount, currency, counterparty, reference, category, doc_url, doc_name')
        .gte('booked_at', from).lte('booked_at', `${to}T23:59:59Z`).order('booked_at')
      const rows = (txRows ?? []) as Array<{ booked_at: string; amount: number; currency: string; counterparty: string | null; reference: string | null; category: string | null; doc_url: string | null; doc_name: string | null }>
      const clean = (x: string) => x.replace(/[^A-Za-z0-9äöüÄÖÜß .,-]/g, '_').slice(0, 60)
      const csvLines = ['Datum;Betrag;Währung;Gegenpartei;Referenz;Kategorie;Beleg']
      const files: Record<string, Uint8Array> = {}
      let recCount = 0
      for (const x of rows) {
        let recName = ''
        if (x.doc_url) {
          try {
            const rr = await fetch(x.doc_url)
            if (rr.ok) {
              const ext = (x.doc_url.split('.').pop() ?? 'pdf').slice(0, 4)
              recName = `belege/${x.booked_at.slice(0, 10)} ${clean(x.counterparty ?? 'Beleg')} ${String(x.amount).replace('.', ',')}${x.currency}.${ext}`
              files[recName] = new Uint8Array(await rr.arrayBuffer())
              recCount++
            }
          } catch { /* Beleg nicht ladbar → nur CSV-Zeile */ }
        }
        csvLines.push([x.booked_at.slice(0, 10), String(x.amount).replace('.', ','), x.currency, (x.counterparty ?? '').replaceAll(';', ','), (x.reference ?? '').replaceAll(';', ','), x.category ?? '', recName ? recName.slice(7) : ''].join(';'))
      }
      // Ausgangsrechnungen (sveru ltd) im Zeitraum
      const { data: invRows } = await supabase.from('crm_invoices')
        .select('invoice_number, total_gross, currency, pdf_path, created_at, status')
        .gte('created_at', from).lte('created_at', `${to}T23:59:59Z`).in('status', ['sent', 'paid'])
      let invCount = 0
      for (const inv of ((invRows ?? []) as Array<{ invoice_number: string; pdf_path: string | null; created_at: string }>)) {
        if (!inv.pdf_path) continue
        try {
          const rr = await fetch(`${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/invoice-documents/${inv.pdf_path}`)
          if (rr.ok) { files[`ausgangsrechnungen/${inv.invoice_number}.pdf`] = new Uint8Array(await rr.arrayBuffer()); invCount++ }
        } catch { /* weiter */ }
      }
      const csv = '\ufeff' + csvLines.join('\r\n')
      files['transaktionen.csv'] = strToU8(csv)
      const zip = zipSync(files, { level: 6 })
      const zipPath = `exports/steuer-${from}-bis-${to}-${Date.now()}.zip`
      const { error: zipErr } = await supabase.storage.from('fin-receipts').upload(zipPath, zip, { contentType: 'application/zip', upsert: true })
      if (zipErr) return json({ error: `ZIP-Upload: ${zipErr.message}` }, 500)
      const zipUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/fin-receipts/${zipPath}`
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;font-size:14px;line-height:1.6">
        <p>Dear Georgios,</p>
        ${typeof body.note === 'string' && body.note ? `<p>${body.note}</p>` : ''}
        <p>Please find attached the bookkeeping export for <b>sveru ltd</b> for the period <b>${from}</b> to <b>${to}</b>.</p>
        <ul>
          <li>${rows.length} bank transactions (CSV attached)</li>
          <li>${recCount} receipts</li>
          <li>${invCount} outgoing invoices</li>
        </ul>
        <p>All receipts and invoices in one ZIP file - just click to download:</p>
        <p style="text-align:center;margin:22px 0;"><a href="${zipUrl}" style="background:#ff795d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block;">Download ZIP (${Math.round(zip.length / 1048576 * 10) / 10} MB)</a></p>
        <p>Best regards<br/>Sven Rüprich · Happy Property (sveru ltd)</p>
      </div>`
      const b64 = ((): string => { let bin = ''; const u = strToU8(csv); for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]); return btoa(bin) })()
      const { error: mailErr } = await supabase.functions.invoke('send-email', { body: {
        to: email, subject: `sveru ltd - bookkeeping export ${from} to ${to}`, html,
        attachment: { filename: `transactions-${from}-${to}.csv`, content_base64: b64, content_type: 'text/csv' },
      } })
      return json({ success: true, sent_to: mailErr ? null : email, mail_error: mailErr ? String(mailErr) : null, transactions: rows.length, receipts: recCount, invoices: invCount, zip_url: zipUrl })
    }
    // Täglicher Lauf: erst Kontobewegungen (3 Tage), dann Rechnungsabgleich
    try { console.log('[revolut-sync] tx:', JSON.stringify(await syncTransactions(supabase, accessToken, 3))) }
    catch (e) { console.warn('[revolut-sync] tx-sync:', e) }

    // Offene Rechnungen
    const { data: openInv, error: invErr } = await supabase
      .from('crm_invoices')
      .select('id, invoice_number, subtotal_net, total_gross, currency, lead_id, deal_id, token, customer_snapshot')
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

      // Provision am Deal als erhalten markieren (Dashboard/Statistik)
      if (inv.deal_id) {
        try {
          const { data: dRow } = await supabase.from('deals').select('commission_amount').eq('id', inv.deal_id).maybeSingle()
          const patch: Record<string, unknown> = { commission_paid_at: tx.created_at }
          if (dRow && (dRow as { commission_amount: number | null }).commission_amount == null && inv.subtotal_net != null) {
            patch.commission_amount = inv.subtotal_net
          }
          const { error: cErr } = await supabase.from('deals').update(patch).eq('id', inv.deal_id)
          if (cErr) console.warn('[revolut-sync] commission_paid_at:', cErr.message)
        } catch (e) { console.warn('[revolut-sync] Deal-Provision:', e) }
      }
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
            from_name: 'Lotte · Happy Property',
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
