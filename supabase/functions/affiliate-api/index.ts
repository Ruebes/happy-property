// affiliate-api — Tippgeber-Programm: Uebersicht, Zuweisung, Provisions-Scan und Abrechnung.
//
//   POST { action:'list' }                    → Tippgeber + geworbene Kunden + Auszahlungen (nur eingeloggt)
//   POST { action:'ensure', lead_id }         → eindeutigen Empfehlungs-Link fuer einen Lead anlegen/holen
//   POST { action:'set_active', affiliate_id, active } → Link aktiv/inaktiv schalten
//
//   Empfehlungsgeber im Kunden (LeadDetail → LeadReferrer):
//   POST { action:'referrer_get', lead_id }   → zugewiesener Tippgeber, Provision, Abrechnung
//   POST { action:'referrer_search', lead_id, q } → Tippgeber + CRM-Kunden zum Zuweisen
//   POST { action:'referrer_set', lead_id, affiliate_id | referrer_lead_id | new_referrer, commission? }
//   POST { action:'referrer_remove', lead_id } → Zuweisung loesen (nur solange nicht abgerechnet)
//   POST { action:'commission_set', lead_id, amount|null } → Provision fuer diesen Kunden (null = 1.000 €)
//   POST { action:'affiliate_update', affiliate_id, ... } → Kontakt/Adresse/Steuerstatus des Tippgebers
//   POST { action:'preview_pdf', is_business? } → Muster-Abrechnung als base64 (Vorlage ansehen)
//
//   POST { action:'commission_scan' }         → Cron (alle 30 Min): Deals geworbener Kunden in
//        Phase provision_erhalten (auch danach archiviert) → Auszahlung anlegen + Abrechnungs-PDF
//        + Revolut-Payout-Link, beides per Mail/WhatsApp an den Tippgeber. Danach Zustand offener
//        Payout-Links nachhalten (Freigabe in der App → Link nachsenden, eingeloest → bezahlt).
//        Auth: Header x-cron-secret = connector_secrets CRON_SECRET (zur Laufzeit gelesen)
//        oder eingeloggter admin/verwalter. Übergang: der alte Body-Wert `secret`
//        (steht öffentlich im Repo) gilt noch, bis hp-affiliate-scan umgestellt ist.
//   POST { action:'payout_link', payout_id }  → Payout-Link (neu) erzeugen bzw. vorhandenen
//        aktiven Link erneut an den Tippgeber schicken
//   POST { action:'mark_paid', payout_id }    → Auszahlung als bezahlt markieren (nur eingeloggt)
//   POST { action:'resend', payout_id }       → Abrechnung erneut mailen (nur eingeloggt)
//
// Abrechnung: Privatperson → „Provisionsabrechnung" ohne Umsatzsteuer (kein Unternehmer
// i.S.d. § 2 UStG, Hinweis § 22 Nr. 3 EStG). Unternehmer mit USt-IdNr. → „Gutschrift"
// (Self-billing) mit Reverse Charge, Leistungsort Zypern (Art. 44/196 MwStSystRL).
//
// Geld: Der Payout-Link geht seit 17.10.2026 automatisch mit der Abrechnung raus (Svens
// Vorgabe). Revolut-Grenze je Link: 2.500 £ → ueber LINK_MAX nur manuelle Ueberweisung.
// Verlangt das Revolut-Konto eine Freigabe, steht der Link auf 'awaiting', bis Sven in der
// App freigibt; der Scan schickt ihn dann nach.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy affiliate-api --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { PDFDocument, PDFFont, PDFImage, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1'
import fontkit from 'npm:@pdf-lib/fontkit@1.1.1'
import { authorizeCaller, safeEqual } from '../_shared/callerAuth.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PORTAL = 'https://portal.happy-property.com'
// ÜBERGANG, danach entfernen: alter Cron-Wert im Body (öffentlich in
// migrations/20260827_affiliates.sql). Neu ist x-cron-secret aus connector_secrets.
const LEGACY_CRON_SECRET = 'hp-affiliate-cron-2026'
const BUCKET = 'invoice-documents'
const AMOUNT = 1000          // Standard-Provision, je Kunde ueberschreibbar (leads.referral_commission)
const LINK_MAX = 2500        // Revolut-Payout-Links gehen bis 2.500 £ → in EUR mit Puffer
const LINK_DEAD = ['expired', 'cancelled', 'failed']
const LINK_OPEN = ['created', 'awaiting', 'active', 'processing']

// CI (wie generate-invoice)
const CORAL = rgb(1, 0x79 / 255, 0x5d / 255)     // #ff795d
const DARK  = rgb(0x1b / 255, 0x1b / 255, 0x22 / 255)
const GOLD  = rgb(0xc2 / 255, 0xa1 / 255, 0x5e / 255)
const GREY  = rgb(0.40, 0.43, 0.49)
const LINE  = rgb(0.86, 0.86, 0.88)
const WHITE = rgb(1, 1, 1)

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
const dDate = (d: string | Date) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Nicosia' })
const firstOnly = (full: string) => {
  const p = full.trim().split(/\s+/)
  return p.length < 2 ? (p[0] ?? '') : `${p[0]} ${p[p.length - 1][0]}.`
}
const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? ''
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

interface Affiliate {
  id: string; lead_id: string | null; subscriber_id?: string | null; name: string; email: string | null; whatsapp: string | null
  code: string; source?: string | null; active: boolean; created_at: string
  street?: string | null; postal_code?: string | null; city?: string | null; country?: string | null
  is_business?: boolean; vat_id?: string | null
}
interface Payout {
  id: string; affiliate_id: string; referred_lead_id: string | null; amount: number; status: string
  doc_no: string | null; doc_path: string | null; payout_link: string | null; emailed_at: string | null
  paid_at: string | null; created_at: string; service_date?: string | null
  payout_link_id?: string | null; payout_link_state?: string | null; payout_link_expires_at?: string | null
  payout_link_sent_at?: string | null; payout_link_error?: string | null; payout_link_attempt?: number
}
type LinkResult = { url: string | null; state: string | null; expires: string | null; error?: string }

const docUrlOf = (p: { doc_path: string | null }) => p.doc_path ? `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p.doc_path}` : null
const affUrl = (a: { code: string }) => `${PORTAL}/termin?src=empfehlung&ref=${a.code}`

// ── Schriften (CI Montserrat + Playfair, Fallback Standard-Fonts) ─────────────
async function loadFonts(): Promise<{ mont?: Uint8Array; montSemi?: Uint8Array; playfair?: Uint8Array }> {
  const holen = async (u: string, headers?: Record<string, string>) => {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 8000)
    try {
      const r = await fetch(u, { signal: ctrl.signal, headers })
      if (!r.ok) throw new Error(String(r.status))
      return new Uint8Array(await r.arrayBuffer())
    } finally { clearTimeout(to) }
  }
  try {
    const css = new TextDecoder().decode(await holen('https://fonts.googleapis.com/css?family=Montserrat:400,600,700|Playfair+Display:700', { 'User-Agent': 'Mozilla/4.0' }))
    const url: Record<string, string> = {}
    for (const blk of css.split('@font-face').slice(1)) {
      const fam = blk.match(/font-family:\s*'([^']+)'/)?.[1], wt = blk.match(/font-weight:\s*(\d+)/)?.[1], u = blk.match(/url\((https:[^)]+\.ttf)\)/)?.[1]
      if (fam && wt && u) url[`${fam}:${wt}`] = u
    }
    const [a, b, c] = await Promise.all(['Montserrat:400', 'Montserrat:600', 'Playfair Display:700']
      .map((k) => url[k] ? holen(url[k]) : Promise.reject(new Error(`Schrift ${k} fehlt`))))
    return { mont: a, montSemi: b, playfair: c }
  } catch {
    return {}
  }
}

function wrap(s: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of s.split(/\s+/)) {
    const test = cur ? cur + ' ' + w : w
    if (font.widthOfTextAtSize(test, size) > maxW && cur) { out.push(cur); cur = w }
    else cur = test
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}

// ── Abrechnungs-PDF ──────────────────────────────────────────────────────────
// Pflichtangaben (§ 14 Abs. 4 UStG / Art. 226 MwStSystRL, bei Privatpersonen sinngemaess
// als Beleg fuer die Betriebsausgabe): Name + Anschrift beider Seiten, Steuernummern,
// Ausstellungsdatum, fortlaufende Nummer, Art der Leistung, Leistungszeitpunkt, Betrag,
// Steuerhinweis; bei Self-billing das Wort „Gutschrift".
async function buildAbrechnungPdf(opts: {
  docNo: string; issueDate: string | Date; serviceDate: string | Date
  issuer: Record<string, unknown>; tippgeber: Affiliate; kundeName: string; amount: number
  linkHint: boolean
}): Promise<Uint8Array> {
  const { docNo, issuer: I, tippgeber: T, kundeName, amount } = opts
  const business = !!T.is_business
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const fonts = await loadFonts()
  let body: PDFFont, bold: PDFFont, head: PDFFont
  if (fonts.mont && fonts.montSemi && fonts.playfair) {
    body = await pdf.embedFont(fonts.mont, { subset: true })
    bold = await pdf.embedFont(fonts.montSemi, { subset: true })
    head = await pdf.embedFont(fonts.playfair, { subset: true })
  } else {
    body = await pdf.embedFont(StandardFonts.Helvetica)
    bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    head = await pdf.embedFont(StandardFonts.TimesRomanBold)
  }

  const page = pdf.addPage([595.28, 841.89]) // A4
  const W = 595.28, M = 50
  const right = W - M
  let y = 841.89 - M
  const text = (s: string, x: number, yy: number, size: number, font: PDFFont, color = DARK, spacing = 0) =>
    page.drawText(s, { x, y: yy, size, font, color, ...(spacing ? { characterSpacing: spacing } : {}) })
  const tRight = (s: string, xr: number, yy: number, size: number, font: PDFFont, color = DARK) =>
    page.drawText(s, { x: xr - font.widthOfTextAtSize(s, size), y: yy, size, font, color })
  const hr = (yy: number, color = LINE, thickness = 0.8, x0 = M, x1 = right) =>
    page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness, color })

  // Kopf: Logo + Titel
  let logo: PDFImage | null = null
  try {
    const logoUrl = String(I.logo_url ?? '')
    if (logoUrl) {
      const lr = await fetch(logoUrl)
      if (lr.ok) {
        const bytes = new Uint8Array(await lr.arrayBuffer())
        logo = logoUrl.toLowerCase().endsWith('.png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
      }
    }
  } catch { /* Logo optional */ }
  if (logo) {
    const scale = Math.min(150 / logo.width, 60 / logo.height)
    page.drawImage(logo, { x: M, y: y - logo.height * scale + 6, width: logo.width * scale, height: logo.height * scale })
  } else {
    text(String(I.brand_name ?? 'Happy Property'), M, y - 12, 20, head)
  }
  const title = business ? 'GUTSCHRIFT' : 'PROVISIONSABRECHNUNG'
  const titleSize = business ? 26 : 20
  text(title, right - head.widthOfTextAtSize(title, titleSize), y - 8, titleSize, head)
  tRight(business ? 'Self-billing invoice · Tippgeber-Provision' : 'Tippgeber-Provision', right, y - 24, 9, bold, GREY)
  y -= 56
  hr(y, CORAL, 2)
  y -= 26

  // Aussteller = Leistungsempfaenger (links) + Meta (rechts)
  const colR = 330
  let yL = y, yR = y
  text('AUSSTELLER (LEISTUNGSEMPFÄNGER)', M, yL, 7.5, bold, GOLD, 1.2); yL -= 15
  text(String(I.brand_name ?? ''), M, yL, 12, head); yL -= 15
  text(String(I.legal_name ?? ''), M, yL, 9.5, bold); yL -= 13
  for (const ln of [String(I.address_line1 ?? ''), `${I.postal_code ?? ''} ${I.city ?? ''}, ${I.country ?? ''}`.trim()]) {
    if (ln.trim() && ln.trim() !== ',') { text(ln, M, yL, 9, body, GREY); yL -= 12 }
  }
  if (I.vat_number) { text(`VAT: ${I.vat_number}`, M, yL, 9, body, GREY); yL -= 12 }
  if (I.reg_number) { text(`Reg.-Nr.: ${I.reg_number}`, M, yL, 9, body, GREY); yL -= 12 }

  yR -= 15
  const meta: Array<[string, string]> = [
    [business ? 'Gutschrift-Nr.' : 'Abrechnungs-Nr.', docNo],
    ['Ausstellungsdatum', dDate(opts.issueDate)],
    ['Leistungsdatum', dDate(opts.serviceDate)],
    ['Fällig', 'sofort'],
  ]
  for (const [k, v] of meta) {
    text(k, colR, yR, 9, body, GREY)
    tRight(v, right, yR, 9.5, bold)
    yR -= 15
  }
  y = Math.min(yL, yR) - 18

  // Empfaenger = Tippgeber (leistende Person)
  text(business ? 'GUTSCHRIFT AN (LEISTENDER UNTERNEHMER)' : 'AUSZAHLUNG AN (TIPPGEBER)', M, y, 8.5, bold, GOLD, 1.5); y -= 16
  text(T.name, M, y, 11, bold); y -= 14
  const tLines = [
    String(T.street ?? ''),
    `${T.postal_code ?? ''} ${T.city ?? ''}`.trim(),
    String(T.country ?? ''),
    business ? (T.vat_id ? `USt-IdNr.: ${T.vat_id}` : 'USt-IdNr.: bitte nachreichen') : 'Privatperson',
  ].filter(s => s && s.trim())
  for (const ln of tLines) { text(ln, M, y, 9, body, GREY); y -= 12 }
  y -= 16

  // Position
  page.drawRectangle({ x: M, y: y - 6, width: right - M, height: 22, color: DARK })
  text('LEISTUNG', M + 8, y, 8.5, bold, WHITE, 0.5)
  tRight('BETRAG', right - 8, y, 8.5, bold, WHITE)
  y -= 24
  const desc = `Tippgeber-Provision für die erfolgreiche Empfehlung eines Immobilienkäufers an Happy Property (Kunde: ${kundeName}). Kauf abgeschlossen, Provision bei Happy Property eingegangen am ${dDate(opts.serviceDate)}.`
  const dl = wrap(desc, body, 9.5, right - M - 130)
  for (let i = 0; i < dl.length; i++) {
    text(dl[i], M + 8, y, 9.5, body)
    if (i === 0) tRight(eur(amount), right - 8, y, 9.5, bold)
    y -= 14
  }
  y -= 4
  hr(y + 6)
  y -= 12

  // Summen
  const sumL = 330
  const sumRow = (k: string, v: string) => {
    text(k, sumL, y, 9.5, body, GREY)
    tRight(v, right, y, 9.5, body)
    y -= 16
  }
  sumRow(business ? 'Nettobetrag' : 'Provision', eur(amount))
  sumRow(business ? 'USt (Reverse Charge)' : 'Umsatzsteuer', eur(0))
  hr(y + 6, DARK, 1, sumL, right)
  y -= 12
  page.drawRectangle({ x: sumL - 6, y: y - 6, width: right - sumL + 6, height: 24, color: rgb(1, 0.96, 0.94) })
  text('Auszahlungsbetrag', sumL, y, 11, bold)
  tRight(eur(amount), right, y, 12, bold, CORAL)
  y -= 34

  // Steuer- und Rechtshinweise
  const notes = business ? [
    'Gutschrift im Gutschriftsverfahren (Self-billing, Art. 224 MwStSystRL): Happy Property rechnet die Leistung des Tippgebers in dessen Namen ab.',
    `Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge, Art. 44 und 196 MwStSystRL). Leistungsort ist Zypern; die Umsatzsteuer schuldet der Leistungsempfänger ${String(I.legal_name ?? '')}${I.vat_number ? ` (VAT ${I.vat_number})` : ''}.`,
    'Weicht dein Steuerstatus ab (z.B. Kleinunternehmer oder keine USt-IdNr.), gib uns bitte vor der Auszahlung Bescheid, dann korrigieren wir die Gutschrift.',
  ] : [
    'Keine Umsatzsteuer: Die Provision wird an eine Privatperson gezahlt, die mit der Empfehlung nicht als Unternehmer im Sinne des § 2 UStG tätig ist.',
    'Steuerhinweis für den Empfänger: Die Provision kann als sonstige Einkünfte nach § 22 Nr. 3 EStG einkommensteuerpflichtig sein. Bitte kläre die Angabe in deiner Steuererklärung selbst; wir beraten nicht steuerlich.',
  ]
  notes.push(
    'Bitte prüfe diese Abrechnung. Stimmt etwas nicht, widersprich innerhalb von 14 Tagen; danach gilt sie als anerkannt.',
    'Grundlage ist das Tippgeber-Programm von Happy Property. Den Namen des geworbenen Kunden kürzen wir aus Datenschutzgründen ab.',
  )
  text('HINWEISE', M, y, 8.5, bold, GOLD, 1.2); y -= 14
  for (const n of notes) {
    for (const ln of wrap(n, body, 8.5, right - M)) { text(ln, M, y, 8.5, body, GREY); y -= 11 }
    y -= 5
  }
  y -= 8

  // Auszahlungsblock
  const payLines: Array<[string, string]> = [
    ['Betrag', eur(amount)],
    ['Weg', opts.linkHint ? 'Persönlicher Revolut-Auszahlungslink (per WhatsApp/E-Mail)' : 'Überweisung auf dein Konto'],
    ['So geht es', opts.linkHint ? 'Link öffnen, Bankverbindung eintragen, fertig' : 'Wir melden uns wegen deiner Bankverbindung'],
    ['Verwendungszweck', `Tippgeber-Provision ${docNo}`],
  ]
  const boxTop = y
  const boxH = 22 + payLines.length * 14
  page.drawRectangle({ x: M, y: boxTop - boxH + 14, width: right - M, height: boxH, borderColor: LINE, borderWidth: 1, color: rgb(0.985, 0.985, 0.99) })
  text('AUSZAHLUNG', M + 12, boxTop, 8.5, bold, GOLD, 1.2)
  let py = boxTop - 18
  for (const [k, v] of payLines) {
    text(k, M + 12, py, 9, body, GREY)
    text(v, M + 130, py, 9, bold)
    py -= 14
  }
  y = boxTop - boxH - 16
  if (y > 90) text('Vielen Dank für deine Empfehlung! Lotte & Sven, Happy Property', M, y, 10, bold)

  // Fusszeile
  const footY = 54
  hr(footY + 16, LINE, 0.8)
  const footLine = [I.legal_name, I.address_line1, `${I.postal_code ?? ''} ${I.city ?? ''}`, I.vat_number ? `VAT ${I.vat_number}` : '', I.reg_number ? `Reg. ${I.reg_number}` : '', I.email]
    .filter(s => s && String(s).trim()).join('  ·  ')
  const fs = Math.min(7.5, 7.5 * (right - M) / Math.max(1, body.widthOfTextAtSize(footLine, 7.5)))
  text(footLine, (W - body.widthOfTextAtSize(footLine, fs)) / 2, footY, fs, body, GREY)
  return await pdf.save()
}

// Fortlaufende Nummer je Jahr: TG-<Jahr>-<lfd>, sofort am Datensatz reserviert
// (doc_no ist unique → bei parallelem Lauf einfach naechste Nummer).
async function reserveDocNo(sb: SupabaseClient, payoutId: string): Promise<string> {
  const year = new Date().getFullYear()
  for (let tries = 0; tries < 5; tries++) {
    const { data } = await sb.from('affiliate_payouts').select('doc_no').like('doc_no', `TG-${year}-%`)
    const max = ((data ?? []) as Array<{ doc_no: string }>).reduce((m, r) => Math.max(m, Number(r.doc_no.split('-')[2]) || 0), 0)
    const docNo = `TG-${year}-${String(max + 1).padStart(3, '0')}`
    const { error } = await sb.from('affiliate_payouts').update({ doc_no: docNo }).eq('id', payoutId).is('doc_no', null)
    if (!error) {
      const { data: row } = await sb.from('affiliate_payouts').select('doc_no').eq('id', payoutId).maybeSingle()
      return (row as { doc_no: string } | null)?.doc_no ?? docNo
    }
    if ((error as { code?: string }).code !== '23505') throw error
  }
  throw new Error('Keine freie Abrechnungsnummer gefunden')
}

async function sendWhatsApp(sb: SupabaseClient, aff: Affiliate, eventType: string, text: string): Promise<boolean> {
  if (!aff.whatsapp) return false
  const { error } = await sb.functions.invoke('send-whatsapp', {
    body: { event_type: eventType, override_text: text, already_translated: true, lang: 'de', lead_data: { lead_name: aff.name, lead_phone: aff.whatsapp } },
    headers: { Authorization: `Bearer ${SERVICE_ROLE}` },
  })
  return !error
}

async function sendMail(to: string, subject: string, html: string, attachment?: { filename: string; content_base64: string; content_type: string }): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, html, from_name: 'Lotte · Happy Property', ...(attachment ? { attachment } : {}) }),
  })
  return r.ok
}

async function addTask(sb: SupabaseClient, title: string, description: string) {
  try {
    const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
    const adminId = (admin as { id: string } | null)?.id
    if (!adminId) return
    const { data: task } = await sb.from('crm_tasks').insert({ title, description, status: 'offen', created_by: adminId, source: 'affiliate' }).select('id').single()
    const taskId = (task as { id: string } | null)?.id
    if (taskId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
  } catch { /* Aufgabe ist nice-to-have */ }
}

async function addNote(sb: SupabaseClient, leadId: string | null, subject: string, content: string, userId?: string) {
  if (!leadId) return
  try {
    await sb.from('activities').insert({
      lead_id: leadId, type: 'note', direction: 'outbound', subject, content,
      auto: !userId, created_by: userId ?? null, completed_at: new Date().toISOString(),
    })
  } catch { /* Notiz ist nice-to-have */ }
}

const linkText = (aff: Affiliate, amount: number, url: string, expires: string | null) =>
  `Hallo ${firstName(aff.name)} 🐾 hier kommt deine Auszahlung: Über diesen persönlichen Revolut-Link holst du dir deine ${eur(amount)} Tippgeber-Provision direkt auf dein Konto. Einfach öffnen und deine Bankverbindung eintragen, ein Revolut-Konto brauchst du dafür nicht.\n\n${url}\n\nDer Link ist ${expires ? `bis ${dDate(expires)}` : 'ein paar Tage'} gültig. Danke dir! Liebe Grüße, Lotte 🐾`

// Revolut-Payout-Link fuer eine Auszahlung sicherstellen. Idempotent: request_id =
// <payout>-<versuch>; der Versuchszaehler steigt nur, wenn der vorige Link nachweislich
// tot ist (abgelaufen/storniert/fehlgeschlagen). So entsteht nach einem Netzfehler kein
// zweiter einloesbarer Link.
async function ensurePayoutLink(sb: SupabaseClient, payout: Payout, aff: Affiliate, docNo: string | null): Promise<LinkResult> {
  const amount = Number(payout.amount) || AMOUNT
  const none: LinkResult = { url: null, state: null, expires: null }
  if (!aff.email && !aff.whatsapp) return { ...none, error: 'Tippgeber hat weder E-Mail noch WhatsApp' }
  if (amount > LINK_MAX) return { ...none, error: `Betrag über ${eur(LINK_MAX)}: Revolut-Links gehen nur bis 2.500 £, bitte manuell überweisen` }

  if (payout.payout_link_id && !LINK_DEAD.includes(payout.payout_link_state ?? '')) {
    const r = await refreshLink(sb, payout)
    if (!LINK_DEAD.includes(r.state ?? '')) return r
    payout = { ...payout, payout_link_state: r.state }
  }

  // Neuer Versuch nur nach totem Link; der tote Link wird dabei geloest, damit ein
  // Retry nach Netzfehler denselben request_id nimmt (kein zweiter einloesbarer Link).
  let attempt = payout.payout_link_attempt || 0
  const fresh = attempt === 0 || (!!payout.payout_link_id && LINK_DEAD.includes(payout.payout_link_state ?? ''))
  if (fresh) attempt += 1
  await sb.from('affiliate_payouts').update({
    payout_link_attempt: attempt,
    ...(fresh && payout.payout_link_id ? { payout_link_id: null, payout_link_state: null, payout_link: null, payout_link_sent_at: null } : {}),
  }).eq('id', payout.id)

  const { data: rv, error: rvErr } = await sb.functions.invoke('revolut-sync', {
    body: {
      action: 'payout_link', amount, counterparty_name: aff.name, request_id: `${payout.id}-${attempt}`,
      reference: (docNo ? `Tippgeber-Provision ${docNo}` : 'Tippgeber-Provision').slice(0, 100),
    },
    headers: { Authorization: `Bearer ${SERVICE_ROLE}` },
  })
  const d = rv as { success?: boolean; id?: string; url?: string | null; state?: string | null; expiry_date?: string | null; error?: string } | null
  if (rvErr || !d?.success || !d.id) {
    let msg = d?.error ?? ''
    if (!msg && rvErr) {
      try { msg = String((await (rvErr as { context?: Response }).context?.json())?.error ?? '') } catch { /* egal */ }
    }
    msg = (msg || String(rvErr ?? 'Payout-Link fehlgeschlagen')).slice(0, 300)
    await sb.from('affiliate_payouts').update({ payout_link_error: msg }).eq('id', payout.id)
    return { ...none, error: msg }
  }
  await sb.from('affiliate_payouts').update({
    payout_link_id: d.id, payout_link_state: d.state ?? null, payout_link: d.url ?? null,
    payout_link_expires_at: d.expiry_date ?? null, payout_link_error: null, payout_link_sent_at: null,
  }).eq('id', payout.id)
  return { url: d.url ?? null, state: d.state ?? null, expires: d.expiry_date ?? null }
}

async function refreshLink(sb: SupabaseClient, payout: Payout): Promise<LinkResult> {
  const { data: rv } = await sb.functions.invoke('revolut-sync', {
    body: { action: 'payout_link_get', id: payout.payout_link_id },
    headers: { Authorization: `Bearer ${SERVICE_ROLE}` },
  })
  const d = rv as { success?: boolean; url?: string | null; state?: string | null; expiry_date?: string | null; error?: string } | null
  if (!d?.success) return { url: payout.payout_link, state: payout.payout_link_state ?? null, expires: payout.payout_link_expires_at ?? null, error: d?.error ?? 'Status nicht lesbar' }
  await sb.from('affiliate_payouts').update({
    payout_link_state: d.state ?? null, payout_link: d.url ?? payout.payout_link,
    payout_link_expires_at: d.expiry_date ?? payout.payout_link_expires_at ?? null,
  }).eq('id', payout.id)
  return { url: d.url ?? payout.payout_link, state: d.state ?? null, expires: d.expiry_date ?? null }
}

// Abrechnung erzeugen + an den Tippgeber schicken; setzt Status auf 'abgerechnet'.
// createLink: Revolut-Link gleich mit erzeugen (Scan) - beim erneuten Senden nur einen
// schon vorhandenen aktiven Link mitschicken.
async function settle(sb: SupabaseClient, payout: Payout, createLink: boolean): Promise<{ ok: boolean; error?: string; link?: LinkResult; emailed?: boolean; whatsapp?: boolean }> {
  const { data: affRow } = await sb.from('affiliates').select('*').eq('id', payout.affiliate_id).maybeSingle()
  if (!affRow) return { ok: false, error: 'Tippgeber nicht gefunden' }
  const aff = affRow as Affiliate
  const amount = Number(payout.amount) || AMOUNT

  let kundeName = 'Kunde'
  let serviceDate = payout.service_date ?? null
  if (payout.referred_lead_id) {
    const { data: l } = await sb.from('leads').select('first_name, last_name').eq('id', payout.referred_lead_id).maybeSingle()
    const lr = l as { first_name: string | null; last_name: string | null } | null
    if (lr) kundeName = firstOnly(`${lr.first_name ?? ''} ${lr.last_name ?? ''}`)
    if (!serviceDate) {
      const { data: dl } = await sb.from('deals').select('commission_paid_at, phase_changed_at, updated_at')
        .eq('lead_id', payout.referred_lead_id)
        .or('phase.eq.provision_erhalten,and(phase.eq.archiviert,archived_from_phase.eq.provision_erhalten)')
        .order('updated_at', { ascending: false }).limit(1)
      const d0 = (dl?.[0] ?? null) as { commission_paid_at: string | null; phase_changed_at: string | null; updated_at: string } | null
      serviceDate = (d0?.commission_paid_at ?? d0?.phase_changed_at ?? payout.created_at).slice(0, 10)
    }
  }
  serviceDate = serviceDate ?? payout.created_at.slice(0, 10)

  const { data: issuer } = await sb.from('invoice_settings').select('*').eq('id', true).maybeSingle()
  if (!issuer) return { ok: false, error: 'invoice_settings fehlt' }

  const docNo = payout.doc_no ?? await reserveDocNo(sb, payout.id)

  // Link vor der Mail, damit beides in EINER Nachricht ankommt
  let link: LinkResult | undefined
  if (createLink) link = await ensurePayoutLink(sb, { ...payout, doc_no: docNo }, aff, docNo)
  else if (payout.payout_link_id && !LINK_DEAD.includes(payout.payout_link_state ?? '')) link = await refreshLink(sb, payout)
  const liveUrl = link?.state === 'active' && link.url ? link.url : null
  const linkPending = !!link && !link.error && !liveUrl && LINK_OPEN.includes(link.state ?? '')

  const pdfBytes = await buildAbrechnungPdf({
    docNo, issueDate: payout.created_at, serviceDate, issuer: issuer as Record<string, unknown>,
    tippgeber: aff, kundeName, amount, linkHint: amount <= LINK_MAX,
  })
  const docPath = `affiliate/${docNo}.pdf`
  const { error: upErr } = await sb.storage.from(BUCKET).upload(docPath, pdfBytes, { contentType: 'application/pdf', upsert: true })
  if (upErr) return { ok: false, error: 'PDF-Upload: ' + upErr.message }
  const docUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${docPath}`
  const kind = aff.is_business ? 'Gutschrift' : 'Abrechnung'

  const payoutHtml = liveUrl
    ? `<p><strong>Deine Auszahlung:</strong> Über diesen persönlichen Revolut-Link holst du dir das Geld direkt auf dein Konto. Einfach öffnen und deine Bankverbindung eintragen, ein Revolut-Konto brauchst du dafür nicht.</p>
       <p style="text-align:center;margin:18px 0;"><a href="${liveUrl}" style="background:#ff795d;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;display:inline-block">${eur(amount)} jetzt abholen</a></p>
       <p style="font-size:12px;color:#6b7280">Der Link ist ${link?.expires ? `bis ${dDate(link.expires)}` : 'ein paar Tage'} gültig.</p>`
    : linkPending
      ? `<p>Deinen persönlichen Auszahlungs-Link schicke ich dir in Kürze hinterher. Darüber trägst du nur noch deine Bankverbindung ein.</p>`
      : `<p>Die Auszahlung machen wir in den nächsten Tagen fertig. Du bekommst dann noch eine Nachricht von mir, wie das Geld zu dir kommt.</p>`

  let emailed = false
  if (aff.email) {
    const LOTTE_IMG = `${SUPABASE_URL}/storage/v1/object/public/Assets/wa/lotte-money.jpg`
    // Chunked, weil String.fromCharCode(...grosse Arrays) den Stack sprengt
    let bin = ''
    const u8 = new Uint8Array(pdfBytes)
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192))
    const html = `<div style="font-family:Montserrat,Arial,sans-serif;color:#1a2332;font-size:14px;line-height:1.6">
      <div style="text-align:center;margin-bottom:14px;">
        <img src="${LOTTE_IMG}" alt="Lotte" width="260" style="width:260px;max-width:100%;border-radius:14px;" />
        <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · persönliche Assistentin von Sven 🐾</p>
      </div>
      <p>Hallo ${firstName(aff.name)},</p>
      <p>großartige Nachrichten: Deine Empfehlung hat gekauft! 🎉</p>
      <p>Anbei bekommst du unsere ${kind} <strong>${docNo}</strong> über deine Tippgeber-Provision von <strong>${eur(amount)}</strong>.</p>
      ${payoutHtml}
      <p>${kind} online ansehen: <a href="${docUrl}" style="color:#ff795d">${docNo}.pdf</a></p>
      <p>Danke, dass du uns weiterempfiehlst!<br/>Liebe Grüße<br/>Lotte 🐾</p>
    </div>`
    emailed = await sendMail(aff.email, `Deine Tippgeber-Provision: ${kind} ${docNo}`, html,
      { filename: `${docNo}.pdf`, content_base64: btoa(bin), content_type: 'application/pdf' })
  }

  const waText = liveUrl
    ? `Hallo ${firstName(aff.name)} 🐾 tolle Nachrichten: Deine Empfehlung hat gekauft! Deine ${kind} ${docNo} über ${eur(amount)} ${aff.email ? 'habe ich dir gerade per Mail geschickt' : `findest du hier: ${docUrl}`}.\n\nÜber diesen persönlichen Revolut-Link holst du dir das Geld direkt auf dein Konto. Einfach öffnen und deine Bankverbindung eintragen, ein Revolut-Konto brauchst du dafür nicht:\n\n${liveUrl}\n\nDer Link ist ${link?.expires ? `bis ${dDate(link.expires)}` : 'ein paar Tage'} gültig. Liebe Grüße, Lotte 🐾`
    : `Hallo ${firstName(aff.name)} 🐾 tolle Nachrichten: Deine Empfehlung hat gekauft! Deine Tippgeber-Provision von ${eur(amount)} ist unterwegs. Die ${kind} ${docNo} ${aff.email ? 'habe ich dir gerade per Mail geschickt' : `findest du hier: ${docUrl}`}. ${linkPending ? 'Den Auszahlungs-Link schicke ich dir in Kürze hinterher.' : ''} Liebe Grüße, Lotte 🐾`
  const whatsapp = await sendWhatsApp(sb, aff, 'affiliate_abrechnung', waText.replace(/ {2,}/g, ' '))

  await sb.from('affiliate_payouts').update({
    status: 'abgerechnet', doc_no: docNo, doc_path: docPath, service_date: serviceDate,
    emailed_at: emailed ? new Date().toISOString() : payout.emailed_at,
    ...(liveUrl && (emailed || whatsapp) ? { payout_link_sent_at: new Date().toISOString() } : {}),
  }).eq('id', payout.id)
  return { ok: emailed || whatsapp, error: emailed || whatsapp ? undefined : 'Weder Mail noch WhatsApp zugestellt', link, emailed, whatsapp }
}

// Offene Payout-Links nachhalten: freigegeben → Link schicken, eingeloest → bezahlt,
// abgelaufen/storniert → Aufgabe fuer Sven (einmal).
async function pollLinks(sb: SupabaseClient): Promise<unknown[]> {
  const out: unknown[] = []
  const { data } = await sb.from('affiliate_payouts').select('*')
    .not('payout_link_id', 'is', null).neq('status', 'bezahlt').in('payout_link_state', LINK_OPEN).limit(25)
  for (const p of (data ?? []) as Payout[]) {
    const r = await refreshLink(sb, p)
    if (r.error) { out.push({ payout: p.id, error: r.error }); continue }
    const { data: affRow } = await sb.from('affiliates').select('*').eq('id', p.affiliate_id).maybeSingle()
    const aff = affRow as Affiliate | null
    const amount = Number(p.amount) || AMOUNT
    if (r.state === 'active' && r.url && !p.payout_link_sent_at && aff) {
      const text = linkText(aff, amount, r.url, r.expires)
      const wa = await sendWhatsApp(sb, aff, 'affiliate_payout', text)
      const mail = !wa && aff.email ? await sendMail(aff.email, 'Deine Tippgeber-Auszahlung 💶', `<p>${text.replaceAll('\n', '<br/>')}</p>`) : false
      if (wa || mail) await sb.from('affiliate_payouts').update({ payout_link_sent_at: new Date().toISOString() }).eq('id', p.id)
      out.push({ payout: p.id, state: r.state, sent: wa || mail })
    } else if (r.state === 'processed') {
      await sb.from('affiliate_payouts').update({ status: 'bezahlt', paid_at: new Date().toISOString() }).eq('id', p.id)
      await addNote(sb, p.referred_lead_id, '💶 Tippgeber-Provision ausgezahlt', `${aff?.name ?? 'Tippgeber'} hat ${eur(amount)} über den Revolut-Link abgeholt (${p.doc_no ?? ''}).`)
      out.push({ payout: p.id, state: r.state, paid: true })
    } else if (LINK_DEAD.includes(r.state ?? '')) {
      await addTask(sb, `💶 Tippgeber-Link ${r.state === 'expired' ? 'abgelaufen' : 'nicht eingelöst'}: ${aff?.name ?? ''}`,
        `Der Revolut-Auszahlungslink über ${eur(amount)} (${p.doc_no ?? ''}) ist ${r.state}. Neuen Link senden: ${PORTAL}/admin/crm/affiliates`)
      out.push({ payout: p.id, state: r.state })
    } else {
      out.push({ payout: p.id, state: r.state })
    }
  }
  return out
}

// Kunde gilt als „gekauft", wenn die Provision geflossen ist (Svens Definition):
// Deal in provision_erhalten oder von dort aus archiviert.
async function dealDone(sb: SupabaseClient, leadId: string): Promise<boolean> {
  const { data } = await sb.from('deals').select('id').eq('lead_id', leadId)
    .or('phase.eq.provision_erhalten,and(phase.eq.archiviert,archived_from_phase.eq.provision_erhalten)').limit(1)
  return !!data?.length
}

async function referrerState(sb: SupabaseClient, leadId: string) {
  const { data: l } = await sb.from('leads').select('id, first_name, last_name, referred_by_affiliate, referral_commission').eq('id', leadId).maybeSingle()
  const lead = l as { id: string; first_name: string | null; last_name: string | null; referred_by_affiliate: string | null; referral_commission: number | null } | null
  if (!lead) return null
  let referrer: (Affiliate & { url: string; referred_count: number }) | null = null
  if (lead.referred_by_affiliate) {
    const { data: a } = await sb.from('affiliates').select('*').eq('id', lead.referred_by_affiliate).maybeSingle()
    if (a) {
      const { count } = await sb.from('leads').select('id', { count: 'exact', head: true }).eq('referred_by_affiliate', (a as Affiliate).id)
      referrer = { ...(a as Affiliate), url: affUrl(a as Affiliate), referred_count: count ?? 0 }
    }
  }
  const { data: ps } = await sb.from('affiliate_payouts').select('*').eq('referred_lead_id', leadId).order('created_at').limit(1)
  const p = (ps?.[0] ?? null) as Payout | null
  const payout = p ? { ...p, doc_url: docUrlOf(p) } : null
  return {
    referrer,
    commission: lead.referral_commission != null ? Number(lead.referral_commission) : null,
    default_commission: AMOUNT,
    link_max: LINK_MAX,
    payout,
    deal_done: await dealDone(sb, leadId),
  }
}

const cleanQ = (q: unknown) => str(q, 60).replace(/[,()%*"\\]/g, ' ').replace(/\s+/g, ' ').trim()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE)
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action ?? '')

    // ── Cron: Provisions-Scan ────────────────────────────────────────────────
    if (action === 'commission_scan') {
      const legacyCron = typeof body.secret === 'string' && safeEqual(body.secret, LEGACY_CRON_SECRET)
      if (!legacyCron) {
        const caller = await authorizeCaller(req, { cron: true, roles: ['admin', 'verwalter'] }, CORS)
        if (caller instanceof Response) return caller
      }
      // Geworbene Leads, deren Deal Provision erhalten hat und fuer die es noch
      // keine Auszahlung gibt (pro geworbenem Kunden genau eine).
      const { data: leads } = await sb.from('leads')
        .select('id, first_name, last_name, referred_by_affiliate, referral_commission')
        .not('referred_by_affiliate', 'is', null)
      const results: unknown[] = []
      for (const l of (leads ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; referred_by_affiliate: string; referral_commission: number | null }>) {
        if (!(await dealDone(sb, l.id))) continue
        const { data: existing } = await sb.from('affiliate_payouts').select('id').eq('referred_lead_id', l.id).limit(1)
        if (existing?.length) continue
        const amount = l.referral_commission != null && Number(l.referral_commission) > 0 ? Number(l.referral_commission) : AMOUNT
        const { data: created, error: ce } = await sb.from('affiliate_payouts')
          .insert({ affiliate_id: l.referred_by_affiliate, referred_lead_id: l.id, amount, status: 'offen' })
          .select('*').single()
        if (ce) { results.push({ lead: l.id, error: ce.message }); continue }
        const payout = created as Payout
        const r = await settle(sb, payout, true)
        results.push({ lead: l.id, settled: r.ok, error: r.error, link: r.link?.state ?? r.link?.error ?? null })

        const { data: affRow } = await sb.from('affiliates').select('name').eq('id', l.referred_by_affiliate).maybeSingle()
        const affName = (affRow as { name: string } | null)?.name ?? 'Tippgeber'
        const kunde = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim()
        const liveLink = r.link?.state === 'active' && !!r.link.url
        await addNote(sb, l.id, '💶 Tippgeber-Provision abgerechnet',
          `${affName}: ${eur(amount)}. ${r.ok ? 'Abrechnung verschickt' : `Abrechnung NICHT zugestellt (${r.error})`}${liveLink ? ', Revolut-Auszahlungslink mitgeschickt' : ''}.`)
        // Aufgabe fuer Sven nur, wenn er etwas tun muss
        if (!r.ok) {
          await addTask(sb, `💶 Tippgeber-Abrechnung ${eur(amount)} prüfen: ${affName}`,
            `Geworbener Kunde ${kunde} hat gekauft (Provision erhalten), aber die Abrechnung ging nicht raus: ${r.error}.\n\n${PORTAL}/admin/crm/affiliates`)
        } else if (r.link?.state === 'awaiting') {
          await addTask(sb, `💶 Tippgeber-Auszahlung ${eur(amount)} in Revolut freigeben: ${affName}`,
            `Abrechnung ist raus. Der Revolut-Auszahlungslink wartet auf deine Freigabe in der Revolut-Business-App (Transfers → zur Freigabe). Nach der Freigabe schickt Lotte den Link automatisch an ${affName}.`)
        } else if (!liveLink && r.link?.state !== 'created' && r.link?.state !== 'processing') {
          await addTask(sb, `💶 Tippgeber-Auszahlung ${eur(amount)} manuell: ${affName}`,
            `Abrechnung ist raus, aber kein Revolut-Link: ${r.link?.error ?? 'unbekannt'}.\n\nNeu versuchen oder manuell überweisen: ${PORTAL}/admin/crm/affiliates`)
        }
      }
      const links = await pollLinks(sb)
      return json({ ok: true, processed: results, links })
    }

    // ── Verwaltung (nur eingeloggt bzw. Service-Key) ─────────────────────────
    const caller = await authorizeCaller(req, { service: true, roles: ['admin', 'verwalter'] }, CORS)
    if (caller instanceof Response) return caller
    const userId = caller.kind === 'user' ? caller.userId : undefined

    if (action === 'list') {
      const { data: affs } = await sb.from('affiliates').select('*').order('created_at', { ascending: false })
      const { data: pays } = await sb.from('affiliate_payouts').select('*').order('created_at', { ascending: false })
      const { data: referred } = await sb.from('leads')
        .select('id, first_name, last_name, email, referred_by_affiliate, created_at')
        .not('referred_by_affiliate', 'is', null)

      // Phasen der geworbenen Leads in EINER Abfrage (frueher: eine je Lead).
      const refList = (referred ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; referred_by_affiliate: string; created_at: string }>
      const phaseOf = new Map<string, string>()
      if (refList.length) {
        const { data: deals } = await sb.from('deals')
          .select('lead_id, phase, created_at').in('lead_id', refList.map(l => l.id))
          .order('created_at', { ascending: false })
        for (const d of (deals ?? []) as Array<{ lead_id: string; phase: string | null }>) {
          if (d.phase && !phaseOf.has(d.lead_id)) phaseOf.set(d.lead_id, d.phase)
        }
      }
      const referredWithPhase = refList.map(l => ({ ...l, phase: phaseOf.get(l.id) ?? null }))

      const rows = ((affs ?? []) as Affiliate[]).map(a => {
        const mine = referredWithPhase.filter(l => l.referred_by_affiliate === a.id)
        const myPayouts = ((pays ?? []) as Payout[]).filter(p => p.affiliate_id === a.id).map(p => ({ ...p, doc_url: docUrlOf(p) }))
        return {
          ...a,
          url: affUrl(a),
          referred: mine,
          payouts: myPayouts,
          referred_count: mine.length,
          payout_total: myPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
          open_total: myPayouts.filter(p => p.status !== 'bezahlt').reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
        }
      })
      // Wer wirklich empfiehlt, steht oben; danach alphabetisch.
      rows.sort((x, y) =>
        (y.payout_total - x.payout_total) ||
        (y.referred_count - x.referred_count) ||
        x.name.localeCompare(y.name, 'de'))
      return json({ ok: true, affiliates: rows })
    }

    // Eindeutigen Empfehlungs-Link fuer einen Lead anlegen (oder den
    // vorhandenen zurueckgeben) — Sven kann jeden Kunden zum Tippgeber machen.
    if (action === 'ensure') {
      const leadId = String(body.lead_id ?? '')
      if (!leadId) return json({ error: 'lead_id fehlt.' }, 400)
      const { data: l } = await sb.from('leads').select('first_name, last_name, email, phone, whatsapp').eq('id', leadId).maybeSingle()
      const lead = l as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null } | null
      if (!lead) return json({ error: 'Lead nicht gefunden.' }, 404)
      const { data: ensured, error: ensErr } = await sb.rpc('ensure_affiliate', {
        p_lead_id: leadId, p_subscriber_id: null,
        p_name: `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim(),
        p_email: lead.email, p_whatsapp: lead.whatsapp ?? lead.phone, p_source: 'manuell',
      })
      const aff = ensured as Affiliate | null
      if (ensErr || !aff) return json({ error: ensErr?.message ?? 'Anlage fehlgeschlagen.' }, 500)
      return json({ ok: true, affiliate: { ...aff, url: affUrl(aff) } })
    }

    if (action === 'set_active') {
      const affId = String(body.affiliate_id ?? '')
      if (!affId) return json({ error: 'affiliate_id fehlt.' }, 400)
      const { error: ue } = await sb.from('affiliates').update({ active: body.active !== false }).eq('id', affId)
      if (ue) return json({ error: ue.message }, 500)
      return json({ ok: true })
    }

    // ── Empfehlungsgeber im Kunden ───────────────────────────────────────────
    if (action === 'referrer_get') {
      const leadId = String(body.lead_id ?? '')
      if (!leadId) return json({ error: 'lead_id fehlt.' }, 400)
      const st = await referrerState(sb, leadId)
      if (!st) return json({ error: 'Kunde nicht gefunden.' }, 404)
      return json({ ok: true, ...st })
    }

    if (action === 'referrer_search') {
      const leadId = String(body.lead_id ?? '')
      const q = cleanQ(body.q)
      if (q.length < 2) return json({ ok: true, results: [] })
      const toks = q.split(' ')
      const { data: affs } = await sb.from('affiliates').select('id, name, email, lead_id, subscriber_id, source')
        .or(`name.ilike."%${q}%",email.ilike."%${q}%"`).limit(12)
      let lq = sb.from('leads').select('id, first_name, last_name, email').limit(12)
      lq = toks.length > 1
        ? lq.ilike('first_name', `%${toks[0]}%`).ilike('last_name', `%${toks[toks.length - 1]}%`)
        : lq.or(`first_name.ilike."%${q}%",last_name.ilike."%${q}%",email.ilike."%${q}%"`)
      const { data: leads } = await lq
      const affList = (affs ?? []) as Array<{ id: string; name: string; email: string | null; lead_id: string | null; subscriber_id: string | null; source: string | null }>
      const affLeadIds = new Set(affList.map(a => a.lead_id).filter(Boolean))
      // Leads, die schon Tippgeber sind, aber nicht ueber den Namen gefunden wurden
      const leadList = ((leads ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>)
        .filter(l => l.id !== leadId && !affLeadIds.has(l.id))
      if (leadList.length) {
        const { data: more } = await sb.from('affiliates').select('id, name, email, lead_id, subscriber_id, source').in('lead_id', leadList.map(l => l.id))
        for (const a of (more ?? []) as typeof affList) { affList.push(a); affLeadIds.add(a.lead_id) }
      }
      const results = [
        ...affList.filter(a => a.lead_id !== leadId).map(a => ({
          kind: 'affiliate' as const, id: a.id, name: a.name, email: a.email,
          hint: a.lead_id ? 'Kunde, hat schon Empfehlungs-Link' : a.subscriber_id ? 'Newsletter-Empfänger' : 'Tippgeber',
        })),
        ...leadList.filter(l => !affLeadIds.has(l.id)).map(l => ({
          kind: 'lead' as const, id: l.id, name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || (l.email ?? '?'), email: l.email,
          hint: 'Kunde aus dem CRM',
        })),
      ].slice(0, 15)
      return json({ ok: true, results })
    }

    if (['referrer_set', 'referrer_remove', 'commission_set'].includes(action)) {
      const leadId = String(body.lead_id ?? '')
      const { data: l } = await sb.from('leads').select('id, first_name, last_name, referred_by_affiliate').eq('id', leadId).maybeSingle()
      const lead = l as { id: string; first_name: string | null; last_name: string | null; referred_by_affiliate: string | null } | null
      if (!lead) return json({ error: 'Kunde nicht gefunden.' }, 404)
      const { data: paid } = await sb.from('affiliate_payouts').select('doc_no').eq('referred_lead_id', leadId).limit(1)
      if (paid?.length) return json({ error: `Die Provision ist schon abgerechnet (${(paid[0] as { doc_no: string | null }).doc_no ?? 'offen'}). Zuweisung und Betrag sind deshalb gesperrt.` }, 409)

      let commission: number | null | undefined
      if ('commission' in body || 'amount' in body) {
        const raw = body.commission ?? body.amount
        if (raw === null || raw === '' || raw === undefined) commission = null
        else {
          const s = String(raw).trim()  // auch deutsche Schreibweise „1.500,50"
          const n = Math.round(Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) * 100) / 100
          if (!Number.isFinite(n) || n <= 0 || n > 100000) return json({ error: 'Provision muss zwischen 0,01 € und 100.000 € liegen.' }, 400)
          commission = n === AMOUNT ? null : n
        }
      }

      if (action === 'commission_set') {
        if (commission === undefined) return json({ error: 'amount fehlt.' }, 400)
        const { error: ue } = await sb.from('leads').update({ referral_commission: commission }).eq('id', leadId)
        if (ue) return json({ error: ue.message }, 500)
        if (lead.referred_by_affiliate) await addNote(sb, leadId, '🤝 Tippgeber-Provision geändert', `Neue Provision: ${eur(commission ?? AMOUNT)}.`, userId)
        return json({ ok: true, ...(await referrerState(sb, leadId)) })
      }

      if (action === 'referrer_remove') {
        const { error: ue } = await sb.from('leads').update({ referred_by_affiliate: null, referral_commission: null }).eq('id', leadId)
        if (ue) return json({ error: ue.message }, 500)
        if (lead.referred_by_affiliate) await addNote(sb, leadId, '🤝 Empfehlungsgeber entfernt', 'Zuweisung des Tippgebers wurde gelöst.', userId)
        return json({ ok: true, ...(await referrerState(sb, leadId)) })
      }

      // referrer_set: bestehender Tippgeber, CRM-Kunde (bekommt seinen Link) oder neue Person
      let aff: Affiliate | null = null
      if (body.affiliate_id) {
        const { data: a } = await sb.from('affiliates').select('*').eq('id', String(body.affiliate_id)).maybeSingle()
        aff = a as Affiliate | null
      } else if (body.referrer_lead_id) {
        const rid = String(body.referrer_lead_id)
        const { data: rl } = await sb.from('leads').select('first_name, last_name, email, phone, whatsapp').eq('id', rid).maybeSingle()
        const r = rl as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null } | null
        if (!r) return json({ error: 'Empfehlungsgeber nicht gefunden.' }, 404)
        const { data: ensured, error: ensErr } = await sb.rpc('ensure_affiliate', {
          p_lead_id: rid, p_subscriber_id: null, p_name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
          p_email: r.email, p_whatsapp: r.whatsapp ?? r.phone, p_source: 'manuell',
        })
        if (ensErr) return json({ error: ensErr.message }, 500)
        aff = ensured as Affiliate | null
      } else if (body.new_referrer && typeof body.new_referrer === 'object') {
        const n = body.new_referrer as Record<string, unknown>
        const name = str(n.name, 120)
        if (name.length < 2) return json({ error: 'Name des Empfehlungsgebers fehlt.' }, 400)
        const email = str(n.email, 160).toLowerCase() || null
        const whatsapp = str(n.whatsapp, 40) || null
        if (!email && !whatsapp) return json({ error: 'Bitte E-Mail oder WhatsApp angeben, sonst kommt die Abrechnung nicht an.' }, 400)
        // Gleiche Person (Mail) schon als Tippgeber vorhanden? Dann den nehmen.
        if (email) {
          const { data: ex } = await sb.from('affiliates').select('*').ilike('email', email).limit(1)
          aff = (ex?.[0] as Affiliate | undefined) ?? null
        }
        if (!aff) {
          const { data: ins, error: ie } = await sb.from('affiliates').insert({
            name, email, whatsapp, source: 'manuell',
            code: Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(16).padStart(2, '0')).join(''),
          }).select('*').single()
          if (ie) return json({ error: ie.message }, 500)
          aff = ins as Affiliate
        }
      }
      if (!aff) return json({ error: 'Empfehlungsgeber nicht gefunden.' }, 404)
      if (aff.lead_id === leadId) return json({ error: 'Ein Kunde kann sich nicht selbst empfehlen.' }, 400)

      const patch: Record<string, unknown> = { referred_by_affiliate: aff.id }
      if (commission !== undefined) patch.referral_commission = commission
      const { error: ue } = await sb.from('leads').update(patch).eq('id', leadId)
      if (ue) return json({ error: ue.message }, 500)
      if (!aff.active) await sb.from('affiliates').update({ active: true }).eq('id', aff.id)
      const { data: lc } = await sb.from('leads').select('referral_commission').eq('id', leadId).maybeSingle()
      const amt = Number((lc as { referral_commission: number | null } | null)?.referral_commission ?? AMOUNT)
      await addNote(sb, leadId, '🤝 Empfehlungsgeber zugewiesen',
        `Empfohlen von ${aff.name} (manuell zugewiesen). Bei Provisionseingang: ${eur(amt)} Tippgeber-Provision.`, userId)
      return json({ ok: true, ...(await referrerState(sb, leadId)) })
    }

    if (action === 'affiliate_update') {
      const affId = String(body.affiliate_id ?? '')
      if (!affId) return json({ error: 'affiliate_id fehlt.' }, 400)
      const patch: Record<string, unknown> = {}
      if ('name' in body) {
        const name = str(body.name, 120)
        if (name.length < 2) return json({ error: 'Name fehlt.' }, 400)
        patch.name = name
      }
      if ('email' in body) patch.email = str(body.email, 160).toLowerCase() || null
      for (const k of ['whatsapp', 'street', 'postal_code', 'city', 'country', 'vat_id'] as const) {
        if (k in body) patch[k] = str(body[k], 160) || null
      }
      if ('is_business' in body) patch.is_business = body.is_business === true
      if (!Object.keys(patch).length) return json({ error: 'Nichts zu speichern.' }, 400)
      const { error: ue } = await sb.from('affiliates').update(patch).eq('id', affId)
      if (ue) return json({ error: ue.message }, 500)
      const leadId = String(body.lead_id ?? '')
      return json({ ok: true, ...(leadId ? await referrerState(sb, leadId) : {}) })
    }

    // Muster-Abrechnung mit echten Aussteller-Daten und Beispiel-Tippgeber
    if (action === 'preview_pdf') {
      const { data: issuer } = await sb.from('invoice_settings').select('*').eq('id', true).maybeSingle()
      if (!issuer) return json({ error: 'invoice_settings fehlt' }, 500)
      const business = body.is_business === true
      const sample: Affiliate = {
        id: 'muster', lead_id: null, code: 'muster', active: true, created_at: new Date().toISOString(),
        name: business ? 'Mustermann Consulting GmbH' : 'Max Mustermann', email: 'max@example.com', whatsapp: null,
        street: 'Musterstraße 12', postal_code: '10115', city: 'Berlin', country: 'Deutschland',
        is_business: business, vat_id: business ? 'DE123456789' : null,
      }
      const bytes = await buildAbrechnungPdf({
        docNo: `TG-${new Date().getFullYear()}-MUSTER`, issueDate: new Date(), serviceDate: new Date(),
        issuer: issuer as Record<string, unknown>, tippgeber: sample, kundeName: 'Erika M.', amount: Number(body.amount) > 0 ? Number(body.amount) : AMOUNT,
        linkHint: true,
      })
      let bin = ''
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
      return json({ ok: true, pdf_base64: btoa(bin) })
    }

    const payoutId = String(body.payout_id ?? '')
    if (!payoutId && ['payout_link', 'mark_paid', 'resend'].includes(action)) return json({ error: 'payout_id fehlt.' }, 400)

    if (action === 'resend') {
      const { data: p } = await sb.from('affiliate_payouts').select('*').eq('id', payoutId).maybeSingle()
      if (!p) return json({ error: 'Nicht gefunden.' }, 404)
      const r = await settle(sb, p as Payout, false)
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
      if (payout.status === 'bezahlt') return json({ error: 'Schon bezahlt.' }, 409)
      const { data: affRow } = await sb.from('affiliates').select('*').eq('id', payout.affiliate_id).maybeSingle()
      const aff = affRow as Affiliate | null
      if (!aff) return json({ error: 'Tippgeber nicht gefunden.' }, 404)

      const link = await ensurePayoutLink(sb, payout, aff, payout.doc_no)
      if (link.error) return json({ error: link.error }, 502)
      if (link.state !== 'active' || !link.url) {
        return json({ ok: true, state: link.state, message: link.state === 'awaiting'
          ? 'Link angelegt, wartet auf Freigabe in der Revolut-App. Nach der Freigabe schickt Lotte ihn automatisch.'
          : `Link angelegt (Status ${link.state}). Lotte schickt ihn, sobald er aktiv ist.` })
      }
      const text = linkText(aff, Number(payout.amount) || AMOUNT, link.url, link.expires)
      const wa = await sendWhatsApp(sb, aff, 'affiliate_payout', text)
      const mail = !wa && aff.email ? await sendMail(aff.email, 'Deine Tippgeber-Auszahlung 💶', `<p>${text.replaceAll('\n', '<br/>')}</p>`) : false
      if (wa || mail) await sb.from('affiliate_payouts').update({ payout_link_sent_at: new Date().toISOString() }).eq('id', payout.id)
      return json({ ok: true, url: link.url, state: link.state, sent: wa || mail })
    }

    return json({ error: 'Unbekannte Aktion.' }, 400)
  } catch (e) {
    console.error('[affiliate-api]', e)
    return json({ error: e instanceof Error ? e.message : 'Unbekannter Fehler' }, 500)
  }
})
