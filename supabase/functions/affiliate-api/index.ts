// affiliate-api — Tippgeber-Programm: Uebersicht, Provisions-Scan und Abrechnung.
//
//   POST { action:'list' }                    → Tippgeber + geworbene Kunden + Auszahlungen (nur eingeloggt)
//   POST { action:'commission_scan', secret } → Cron (alle 30 Min): Deals geworbener Kunden in
//        Phase provision_erhalten → Auszahlung anlegen + Abrechnungs-PDF + Mail an den Tippgeber
//   POST { action:'payout_link', payout_id }  → Revolut-Payout-Link erzeugen und dem
//        Tippgeber per Mail/WhatsApp schicken (nur eingeloggt — Sven klickt bewusst)
//   POST { action:'mark_paid', payout_id }    → Auszahlung als bezahlt markieren (nur eingeloggt)
//   POST { action:'resend', payout_id }       → Abrechnung erneut mailen (nur eingeloggt)
//
// Abrechnung = Gutschrift (Self-Billing) der sveru ltd an eine PRIVATPERSON in
// Deutschland: kein Umsatzsteuer-Ausweis (Tippgeber ist kein Unternehmer
// i.S.d. § 2 UStG). Hinweis auf § 22 Nr. 3 EStG steht im Dokument.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy affiliate-api --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PORTAL = 'https://portal.happy-property.com'
const CRON_SECRET = 'hp-affiliate-cron-2026'
const BUCKET = 'invoice-documents'
const AMOUNT = 1000

// CI (aus _shared/brand.ts — hier als rgb fuer pdf-lib)
const CORAL = rgb(1, 0x79 / 255, 0x5d / 255)
const NAVY  = rgb(0x1a / 255, 0x23 / 255, 0x32 / 255)
const GREY  = rgb(0.40, 0.43, 0.49)
const LINE  = rgb(0.86, 0.86, 0.88)

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
const dDate = (d: string | Date) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
const firstOnly = (full: string) => {
  const p = full.trim().split(/\s+/)
  return p.length < 2 ? (p[0] ?? '') : `${p[0]} ${p[p.length - 1][0]}.`
}

interface Affiliate { id: string; lead_id: string | null; name: string; email: string | null; whatsapp: string | null; code: string; active: boolean; created_at: string }
interface Payout { id: string; affiliate_id: string; referred_lead_id: string | null; amount: number; status: string; doc_no: string | null; doc_path: string | null; payout_link: string | null; emailed_at: string | null; paid_at: string | null; created_at: string }

async function callerAllowed(sb: SupabaseClient, req: Request): Promise<boolean> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return false
  const { data } = await sb.auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return false
  const { data: prof } = await sb.from('profiles').select('role').eq('id', uid).maybeSingle()
  const role = (prof as { role?: string } | null)?.role
  return role === 'admin' || role === 'verwalter'
}

// ── Abrechnungs-PDF (Gutschrift, ohne USt) ───────────────────────────────────
async function buildAbrechnungPdf(opts: {
  docNo: string; issuer: Record<string, unknown>; tippgeber: Affiliate
  kundeName: string; amount: number
}): Promise<Uint8Array> {
  const { docNo, issuer, tippgeber, kundeName, amount } = opts
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89]) // A4
  const body = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const head = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const W = 595.28
  const M = 56
  let y = 780

  const t = (s: string, x: number, yy: number, size = 10, f = body, color = NAVY) =>
    page.drawText(s, { x, y: yy, size, font: f, color })

  // Kopf
  t(String(issuer.brand_name ?? 'Happy Property'), M, y, 22, head, NAVY)
  t('GUTSCHRIFT', W - M - bold.widthOfTextAtSize('GUTSCHRIFT', 13), y + 4, 13, bold, CORAL)
  y -= 18
  t('Abrechnung Tippgeber-Provision', M, y, 10, body, GREY)
  y -= 30
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: LINE })
  y -= 24

  // Aussteller / Empfaenger
  const issuerLines = [
    String(issuer.legal_name ?? ''),
    String(issuer.address_line1 ?? ''),
    `${issuer.postal_code ?? ''} ${issuer.city ?? ''}`.trim(),
    String(issuer.country ?? ''),
    issuer.vat_number ? `VAT: ${issuer.vat_number}` : '',
    issuer.reg_number ? `Reg.-Nr.: ${issuer.reg_number}` : '',
  ].filter(Boolean)
  t('Aussteller (Leistungsempfänger):', M, y, 8.5, bold, GREY)
  t('Empfänger (Tippgeber / leistende Person):', 320, y, 8.5, bold, GREY)
  y -= 14
  const yStart = y
  for (const l of issuerLines) { t(l, M, y, 9.5); y -= 13 }
  let y2 = yStart
  t(tippgeber.name, 320, y2, 9.5, bold); y2 -= 13
  if (tippgeber.email) { t(String(tippgeber.email), 320, y2, 9.5); y2 -= 13 }
  t('(Privatperson, Deutschland)', 320, y2, 9, body, GREY)
  y = Math.min(y, y2) - 24

  // Meta
  t(`Gutschrift-Nr.: ${docNo}`, M, y, 10, bold); t(`Datum: ${dDate(new Date())}`, 320, y, 10)
  y -= 30

  // Position
  page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 22, color: rgb(1, 0.94, 0.92) })
  t('Leistung', M + 8, y, 9.5, bold)
  t('Betrag', W - M - 60, y, 9.5, bold)
  y -= 24
  t(`Tippgeber-Provision für die erfolgreiche Vermittlung`, M + 8, y, 10)
  y -= 14
  t(`eines Immobilienkäufers (${kundeName})`, M + 8, y, 10)
  t(eur(amount), W - M - body.widthOfTextAtSize(eur(amount), 10) - 8, y + 7, 10, bold)
  y -= 20
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINE })
  y -= 20
  const totalX = W - M - bold.widthOfTextAtSize(eur(amount), 11) - 8
  t('Gesamtbetrag (keine Umsatzsteuer):', totalX - bold.widthOfTextAtSize('Gesamtbetrag (keine Umsatzsteuer):', 10.5) - 14, y, 10.5, bold)
  t(eur(amount), totalX, y, 11, bold, CORAL)
  y -= 40

  // Rechtliche Hinweise
  const notes = [
    'Abrechnung im Gutschriftsverfahren (§ 14 Abs. 2 Satz 2 UStG). Kein Ausweis von Umsatzsteuer,',
    'da die leistende Person als Privatperson kein Unternehmer im Sinne des § 2 UStG ist.',
    '',
    'Hinweis für den Empfänger: Die Provision kann als sonstige Einkünfte gemäß § 22 Nr. 3 EStG',
    'einkommensteuerpflichtig sein. Bitte kläre die Angabe in deiner Steuererklärung selbst.',
    '',
    'Widerspruch gegen diese Gutschrift ist innerhalb von 14 Tagen möglich; danach gilt sie als anerkannt.',
  ]
  for (const l of notes) { t(l, M, y, 8.5, body, GREY); y -= 12 }
  y -= 20
  t('Vielen Dank für deine Empfehlung! – Lotte & Sven, Happy Property', M, y, 10, bold, NAVY)

  // Fusszeile
  page.drawLine({ start: { x: M, y: 70 }, end: { x: W - M, y: 70 }, thickness: 0.5, color: LINE })
  t(`${issuer.legal_name ?? ''} · ${issuer.email ?? ''} · ${issuer.bank_name ?? ''} ${issuer.iban ? '· IBAN ' + issuer.iban : ''}`, M, 56, 7.5, body, GREY)
  return await pdf.save()
}

// Abrechnung erzeugen + mailen; setzt Status auf 'abgerechnet'.
async function settle(sb: SupabaseClient, payout: Payout): Promise<{ ok: boolean; error?: string }> {
  const { data: affRow } = await sb.from('affiliates').select('*').eq('id', payout.affiliate_id).maybeSingle()
  if (!affRow) return { ok: false, error: 'Tippgeber nicht gefunden' }
  const aff = affRow as Affiliate

  let kundeName = 'Kunde'
  if (payout.referred_lead_id) {
    const { data: l } = await sb.from('leads').select('first_name, last_name').eq('id', payout.referred_lead_id).maybeSingle()
    const lr = l as { first_name: string | null; last_name: string | null } | null
    if (lr) kundeName = firstOnly(`${lr.first_name ?? ''} ${lr.last_name ?? ''}`)
  }

  const { data: issuer } = await sb.from('invoice_settings').select('*').eq('id', true).maybeSingle()
  if (!issuer) return { ok: false, error: 'invoice_settings fehlt' }

  // Fortlaufende Nummer TG-<Jahr>-<lfd>
  let docNo = payout.doc_no
  if (!docNo) {
    const year = new Date().getFullYear()
    const { count } = await sb.from('affiliate_payouts').select('id', { count: 'exact', head: true }).not('doc_no', 'is', null)
    docNo = `TG-${year}-${String((count ?? 0) + 1).padStart(3, '0')}`
  }

  const pdfBytes = await buildAbrechnungPdf({ docNo, issuer: issuer as Record<string, unknown>, tippgeber: aff, kundeName, amount: Number(payout.amount) || AMOUNT })
  const docPath = `affiliate/${docNo}.pdf`
  const { error: upErr } = await sb.storage.from(BUCKET).upload(docPath, pdfBytes, { contentType: 'application/pdf', upsert: true })
  if (upErr) return { ok: false, error: 'PDF-Upload: ' + upErr.message }
  const docUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${docPath}`

  // Mail an den Tippgeber (Lotte-Ton, Muster generate-invoice)
  let emailed = false
  if (aff.email) {
    const first = aff.name.split(/\s+/)[0]
    const LOTTE_IMG = `${SUPABASE_URL}/storage/v1/object/public/Assets/wa/lotte-money.jpg`
    // Chunked, weil String.fromCharCode(...grosse Arrays) den Stack sprengt
    let bin = ''
    const u8 = new Uint8Array(pdfBytes)
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192))
    const b64 = btoa(bin)
    const html = `<div style="font-family:Montserrat,Arial,sans-serif;color:#1a2332;font-size:14px;line-height:1.6">
      <div style="text-align:center;margin-bottom:14px;">
        <img src="${LOTTE_IMG}" alt="Lotte" width="260" style="width:260px;max-width:100%;border-radius:14px;" />
        <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · persönliche Assistentin von Sven 🐾</p>
      </div>
      <p>Hallo ${first},</p>
      <p>großartige Nachrichten: Deine Empfehlung hat gekauft! 🎉</p>
      <p>Anbei bekommst du unsere Abrechnung <strong>${docNo}</strong> über deine Tippgeber-Provision von <strong>${eur(Number(payout.amount) || AMOUNT)}</strong>.</p>
      <p>Die Auszahlung machen wir in den nächsten Tagen fertig – du bekommst dann noch eine Nachricht von mir, wie das Geld zu dir kommt.</p>
      <p>Online ansehen: <a href="${docUrl}" style="color:#ff795d">${docNo}.pdf</a></p>
      <p>Danke, dass du uns weiterempfiehlst!<br/>Liebe Grüße<br/>Lotte 🐾</p>
    </div>`
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: aff.email, subject: `Deine Tippgeber-Provision — Abrechnung ${docNo}`, html,
        from_name: 'Lotte · Happy Property',
        attachment: { filename: `${docNo}.pdf`, content_base64: b64, content_type: 'application/pdf' },
      }),
    })
    emailed = r.ok
  }
  // Zusatz-WhatsApp von Lotte, wenn Nummer vorhanden
  if (aff.whatsapp) {
    const first = aff.name.split(/\s+/)[0]
    await sb.functions.invoke('send-whatsapp', { body: {
      event_type: 'affiliate_abrechnung',
      override_text: `Hallo ${first} 🐾 tolle Nachrichten: Deine Empfehlung hat gekauft! Deine Tippgeber-Provision von ${eur(Number(payout.amount) || AMOUNT)} ist unterwegs — die Abrechnung ${docNo} ${aff.email ? 'habe ich dir gerade per Mail geschickt' : `findest du hier: ${docUrl}`}. Liebe Grüße, Lotte 🐾`,
      already_translated: true, lang: 'de',
      lead_data: { lead_name: aff.name, lead_phone: aff.whatsapp },
    } })
  }

  await sb.from('affiliate_payouts').update({
    status: 'abgerechnet', doc_no: docNo, doc_path: docPath,
    emailed_at: emailed ? new Date().toISOString() : payout.emailed_at,
  }).eq('id', payout.id)
  return { ok: true }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE)
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action ?? '')

    // ── Cron: Provisions-Scan ────────────────────────────────────────────────
    if (action === 'commission_scan') {
      if (body.secret !== CRON_SECRET && !(await callerAllowed(sb, req))) return json({ error: 'Nicht berechtigt.' }, 403)
      // Geworbene Leads, deren Deal in provision_erhalten steht und fuer die
      // noch keine Auszahlung existiert.
      const { data: leads } = await sb.from('leads')
        .select('id, first_name, last_name, referred_by_affiliate')
        .not('referred_by_affiliate', 'is', null)
      const results: unknown[] = []
      for (const l of (leads ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; referred_by_affiliate: string }>) {
        const { data: deal } = await sb.from('deals').select('id, phase').eq('lead_id', l.id).eq('phase', 'provision_erhalten').limit(1)
        if (!deal?.length) continue
        const { data: existing } = await sb.from('affiliate_payouts').select('id').eq('affiliate_id', l.referred_by_affiliate).eq('referred_lead_id', l.id).maybeSingle()
        if (existing) continue
        const { data: created, error: ce } = await sb.from('affiliate_payouts')
          .insert({ affiliate_id: l.referred_by_affiliate, referred_lead_id: l.id, amount: AMOUNT, status: 'offen' })
          .select('*').single()
        if (ce) { results.push({ lead: l.id, error: ce.message }); continue }
        const r = await settle(sb, created as Payout)
        results.push({ lead: l.id, settled: r.ok, error: r.error })
        // Aufgabe fuer Sven: Auszahlung freigeben
        try {
          const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
          const adminId = (admin as { id: string } | null)?.id
          if (adminId) {
            const { data: task } = await sb.from('crm_tasks').insert({
              title: `💶 Tippgeber-Auszahlung 1.000 € freigeben`,
              description: `Geworbener Kunde hat gekauft (Provision erhalten). Abrechnung wurde automatisch verschickt.\n\nAuszahlung ausloesen: ${PORTAL}/admin/crm/affiliates`,
              status: 'offen', created_by: adminId, source: 'affiliate',
            }).select('id').single()
            const taskId = (task as { id: string } | null)?.id
            if (taskId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
          }
        } catch { /* Aufgabe ist nice-to-have */ }
      }
      return json({ ok: true, processed: results })
    }

    // ── Verwaltung (nur eingeloggt) ──────────────────────────────────────────
    if (!(await callerAllowed(sb, req))) return json({ error: 'Nicht berechtigt.' }, 403)

    if (action === 'list') {
      const { data: affs } = await sb.from('affiliates').select('*').order('created_at', { ascending: false })
      const { data: pays } = await sb.from('affiliate_payouts').select('*').order('created_at', { ascending: false })
      const { data: referred } = await sb.from('leads')
        .select('id, first_name, last_name, referred_by_affiliate, created_at')
        .not('referred_by_affiliate', 'is', null)
      const referredWithPhase: Array<Record<string, unknown>> = []
      for (const l of (referred ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; referred_by_affiliate: string; created_at: string }>) {
        const { data: deal } = await sb.from('deals').select('phase').eq('lead_id', l.id).order('created_at', { ascending: false }).limit(1)
        referredWithPhase.push({ ...l, phase: (deal?.[0] as { phase?: string } | undefined)?.phase ?? null })
      }
      const rows = ((affs ?? []) as Affiliate[]).map(a => ({
        ...a,
        url: `${PORTAL}/termin?src=empfehlung&ref=${a.code}`,
        referred: referredWithPhase.filter(l => l.referred_by_affiliate === a.id),
        payouts: ((pays ?? []) as Payout[]).filter(p => p.affiliate_id === a.id).map(p => ({
          ...p, doc_url: p.doc_path ? `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p.doc_path}` : null,
        })),
      }))
      return json({ ok: true, affiliates: rows })
    }

    const payoutId = String(body.payout_id ?? '')
    if (!payoutId && ['payout_link', 'mark_paid', 'resend'].includes(action)) return json({ error: 'payout_id fehlt.' }, 400)

    if (action === 'resend') {
      const { data: p } = await sb.from('affiliate_payouts').select('*').eq('id', payoutId).maybeSingle()
      if (!p) return json({ error: 'Nicht gefunden.' }, 404)
      const r = await settle(sb, p as Payout)
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 500)
    }

    if (action === 'mark_paid') {
      await sb.from('affiliate_payouts').update({ status: 'bezahlt', paid_at: new Date().toISOString() }).eq('id', payoutId)
      return json({ ok: true })
    }

    if (action === 'payout_link') {
      const { data: p } = await sb.from('affiliate_payouts').select('*').eq('id', payoutId).maybeSingle()
      if (!p) return json({ error: 'Nicht gefunden.' }, 404)
      const payout = p as Payout
      const { data: affRow } = await sb.from('affiliates').select('*').eq('id', payout.affiliate_id).maybeSingle()
      const aff = affRow as Affiliate | null
      if (!aff) return json({ error: 'Tippgeber nicht gefunden.' }, 404)

      const { data: rv, error: rvErr } = await sb.functions.invoke('revolut-sync', { body: {
        action: 'payout_link',
        amount: Number(payout.amount) || AMOUNT,
        counterparty_name: aff.name,
        request_id: payout.id,
        reference: (payout.doc_no ? `Tippgeber-Provision ${payout.doc_no}` : 'Tippgeber-Provision').slice(0, 100),
      } })
      const d = rv as { success?: boolean; url?: string | null; error?: string } | null
      if (rvErr || !d?.success || !d.url) return json({ error: d?.error ?? String(rvErr ?? 'Payout-Link fehlgeschlagen') }, 502)
      await sb.from('affiliate_payouts').update({ payout_link: d.url }).eq('id', payout.id)

      // Lotte schickt den Link (WhatsApp bevorzugt, sonst Mail)
      const first = aff.name.split(/\s+/)[0]
      const msg = `Hallo ${first} 🐾 hier kommt deine Auszahlung: Ueber diesen Revolut-Link kannst du dir deine ${eur(Number(payout.amount) || AMOUNT)} Tippgeber-Provision direkt auf dein Konto holen — einfach oeffnen und deine Bankverbindung eintragen:\n\n${d.url}\n\nDer Link ist ein paar Tage gueltig. Danke dir! Liebe Gruesse, Lotte 🐾`
      if (aff.whatsapp) {
        await sb.functions.invoke('send-whatsapp', { body: {
          event_type: 'affiliate_payout', override_text: msg, already_translated: true, lang: 'de',
          lead_data: { lead_name: aff.name, lead_phone: aff.whatsapp },
        } })
      } else if (aff.email) {
        await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
          method: 'POST', headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: aff.email, subject: 'Deine Tippgeber-Auszahlung 💶', html: `<p>${msg.replaceAll('\n', '<br/>')}</p>`, from_name: 'Lotte · Happy Property' }),
        })
      }
      return json({ ok: true, url: d.url })
    }

    return json({ error: 'Unbekannte Aktion.' }, 400)
  } catch (e) {
    console.error('[affiliate-api]', e)
    return json({ error: e instanceof Error ? e.message : 'Unbekannter Fehler' }, 500)
  }
})
