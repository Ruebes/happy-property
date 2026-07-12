// Edge Function: newsletter-campaign
// Individueller „Newsletter": KEINE Massenmail — jeder Empfänger bekommt eine
// persönliche Einzel-Mail (Anrede, eigene Deck-Klone mit eigenem Token) zeitlich
// gestaffelt über scheduled_messages (event_type 'newsletter').
//
// Aktionen:
//   draft_text {project_name, units:[{unit_number,price_net,extras?}], bullets}
//              → KI macht aus Svens Stichpunkten einen Mail-Absatz (DU-Form)
//   test_mail  {campaign_id, to} → EINE Beispiel-Mail sofort (Master-Deck-Links)
//   launch     {campaign_id} → Hintergrund: je Empfänger Decks klonen + Mail planen
//              (alle 3 Min + Jitter, nur 08:00–20:00 Europe/Berlin)
//   status     {campaign_id} → Fortschritt fürs Wizard-Polling
//
// Zielgruppe: alle Leads MIT E-Mail, OHNE aktiven Pipeline-Deal (Phase nicht
// deal_verloren/archiviert, nicht archiviert), OHNE Opt-out.
//
// Secrets: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deployment: supabase functions deploy newsletter-campaign --no-verify-jwt

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SITE = 'https://portal.happy-property.com'
// Happy-Property-CI (= compose-deck-mail): Playfair/Montserrat, Creme/Navy/Coral,
// Logo-Header, Objekt-Karten, Signatur mit Foto, dunkler Social-Footer.
const LOGO  = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
const PHOTO_SQ = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/render/image/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg?width=112&height=112&resize=cover&quality=80'
const CI = { cream: '#fffcf6', navy: '#1a2332', coral: '#ff795d', ink: '#2a2a2a', line: '#e6dfd0', mute: '#999' }
const DARK = '#1b1b22', GOLD = '#C2A15E'
const SERIF = "'Playfair Display',Georgia,serif", SANS = "'Montserrat',Helvetica,Arial,sans-serif"
const SOCIALS = [
  { icon: '▶',  platform: 'YouTube',   handle: 'HappyPropertyCyprus',   url: 'https://www.youtube.com/@HappyPropertyCyprus' },
  { icon: '◎',  platform: 'Instagram', handle: 'happy_property_cyprus', url: 'https://www.instagram.com/happy_property_cyprus' },
  { icon: 'f',  platform: 'Facebook',  handle: 'Immobilien in Zypern',  url: 'https://www.facebook.com/profile.php?id=61573780546599' },
  { icon: 'in', platform: 'LinkedIn',  handle: 'Sven Rüprich',          url: 'https://www.linkedin.com/in/sven-r%C3%BCprich/' },
]
const TZ = 'Europe/Berlin'
const SEND_START_H = 8, SEND_END_H = 20
const STEP_SEC = 180            // Grundabstand 3 Min
const JITTER_SEC = 60           // + Zufall bis 60s

interface CampaignProperty {
  project_id: string; project_name: string
  unit_numbers: string[]
  units?: Array<{ unit_number?: string; price_net?: number | null }>
  bullets: string; ai_text: string
  master_deck_token: string | null
  calc_token: string | null
}

function randToken(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

function berlinHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d))
}
// Nächster gültiger Sendezeitpunkt im Fenster 08–20 Uhr (Berlin)
function clampToWindow(d: Date): Date {
  let t = new Date(d)
  for (let i = 0; i < 3; i++) {
    const h = berlinHour(t)
    if (h >= SEND_START_H && h < SEND_END_H) return t
    if (h >= SEND_END_H) { t = new Date(t.getTime() + (24 - h + SEND_START_H) * 3600e3); continue }
    t = new Date(t.getTime() + (SEND_START_H - h) * 3600e3)
  }
  return t
}

function firstNameOf(l: { first_name: string | null }): string {
  return (l.first_name ?? '').trim() || 'zusammen'
}

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;') }

// Newsletter-Mail im Happy-Property-CI (Sven 2026-07-11: "im HTML im Happy
// Property Template"). E-Mail-sicher: Tabellen-Layout, nowrap-Buttons, Bilder
// über Supabase-Transform verkleinert + feste width/height (Apple-Mail-Gotcha),
// p{margin:0}. Der Plaintext-Fallback entsteht zentral via htmlToText (send-email/
// process-scheduled-messages) — Links bleiben dort als URLs erhalten.
function buildEmailHtml(c: {
  subject?: string; intro_text: string; outro_text: string; properties: CampaignProperty[]
}, firstName: string, deckTokens: Record<string, string>, opts?: { campaignId?: string; directBooking?: boolean; projectImages?: Record<string, string | undefined>; bookingToken?: string }): string {
  const paras = (t: string) => t.replace(/\\n/g, '\n').split(/\n+/).map(x => x.trim()).filter(Boolean).map(esc).join('<br><br>')
  // H1 aus dem Betreff ableiten (Teil vor ":" bzw. "—"), Fallback generisch
  const rawH = (c.subject ?? '').split(/[:—]/)[0].trim()
  const headline = rawH.length >= 6 && rawH.length <= 60 ? rawH : 'Deine Paphos-Auswahl.'

  const utmQs = `utm_source=newsletter&utm_medium=email${opts?.campaignId ? `&utm_campaign=${opts.campaignId}` : ''}`
  const firstTok = c.properties.map(p => deckTokens[p.project_id]).find(Boolean)
  // Termin-Button: Direkteinstieg über ein LEAD-gebundenes Deck. Im echten Versand
  // ist das der Klon des Empfängers (firstTok); Test/Vorschau reichen stattdessen
  // bookingToken (ein Deck des Test-Empfängers) — Master-Decks haben keinen Lead
  // und würden im Fragebogen landen.
  const bookTok = opts?.bookingToken ?? (opts?.directBooking !== false ? firstTok : undefined)
  const terminUrl = bookTok
    ? `${SITE}/termin?direkt=1&d=${bookTok}&${utmQs}`
    : `${SITE}/termin?${utmQs}`

  const cards = c.properties.map(p => {
    const deckTok = deckTokens[p.project_id]
    const deckLink = deckTok ? `${SITE}/deck/${deckTok}` : ''
    const calcLink = p.calc_token ? `${SITE}/rechnung/${p.calc_token}` : ''
    const label = `${p.project_name}${p.unit_numbers.length ? ` · ${p.unit_numbers.join(' & ')}` : ''}`
    const raw = opts?.projectImages?.[p.project_id]
    const imgSrc = raw && raw.includes('/storage/v1/object/public/')
      ? raw.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + '?width=560&height=300&resize=cover&quality=72'
      : raw
    const img = imgSrc
      ? `<tr><td style="padding:0 40px;"><a href="${esc(deckLink || '#')}" target="_blank"><img src="${esc(imgSrc)}" width="520" height="279" alt="${esc(label)}" style="width:100%;max-width:520px;height:auto;display:block;border-radius:8px;"></a></td></tr>`
      : ''
    const fmt = (n: number) => n.toLocaleString('de-DE')
    const priceRows = (p.units ?? []).filter(u => u.price_net != null && u.price_net > 0)
    const priceBlock = priceRows.length ? `<tr><td style="padding:14px 40px 0 40px;">${priceRows.map(u => {
      const net = u.price_net as number, vat = Math.round(net * 0.19), gross = net + vat
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border:1px solid ${CI.line};border-radius:6px;"><tr>
        ${priceRows.length > 1 ? `<td style="padding:12px 0 12px 18px;font-family:${SANS};font-size:12px;font-weight:700;color:${CI.navy};white-space:nowrap;">${esc(u.unit_number ?? '')}</td>` : ''}
        <td style="padding:12px 8px 12px 18px;font-family:${SANS};"><div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${CI.mute};white-space:nowrap;">Netto</div><div style="font-size:15px;font-weight:700;color:${CI.navy};white-space:nowrap;">${fmt(net)} €</div></td>
        <td style="padding:12px 8px;font-family:${SANS};"><div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${CI.mute};white-space:nowrap;">MwSt 19 %</div><div style="font-size:15px;font-weight:700;color:${CI.navy};white-space:nowrap;">${fmt(vat)} €</div></td>
        <td style="padding:12px 18px 12px 8px;font-family:${SANS};"><div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${CI.coral};white-space:nowrap;">Brutto</div><div style="font-size:15px;font-weight:700;color:${CI.coral};white-space:nowrap;">${fmt(gross)} €</div></td>
      </tr></table>`
    }).join('<div style="height:8px;"></div>')}</td></tr>` : ''
    return `<tr><td style="padding:36px 0 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${img}
        ${priceBlock}
        <tr><td style="padding:24px 40px 0 40px;">
          <div style="font-family:${SANS};font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${CI.coral};font-weight:700;">Dein persönliches Exposé</div>
          <h2 style="margin:6px 0 0 0;font-family:${SERIF};font-size:26px;line-height:1.2;font-weight:700;color:${CI.navy};">${esc(label)}</h2>
          ${p.ai_text?.trim() ? `<p style="margin:14px 0 0 0;font-family:${SANS};font-size:14px;line-height:1.65;color:${CI.ink};">${paras(p.ai_text)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:22px 40px 0 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            ${deckLink ? `<td bgcolor="${CI.navy}" style="border-radius:2px;">
              <a href="${esc(deckLink)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:12px;letter-spacing:0.15em;text-transform:uppercase;font-weight:700;color:#ffffff;text-decoration:none;white-space:nowrap;">Exposé ansehen →</a>
            </td>` : ''}
            ${calcLink ? `<td style="width:10px;font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="border:1px solid ${CI.navy};border-radius:2px;">
              <a href="${esc(calcLink)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:${CI.navy};text-decoration:none;white-space:nowrap;">Beispielrechnung</a>
            </td>` : ''}
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:40px 40px 0 40px;"><div style="height:1px;background-color:${CI.line};"></div></td></tr>`
  }).join('')

  const socialCard = (so: typeof SOCIALS[number]) => {
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#2a2a33;border-radius:10px;"><tr>
      <td width="52" valign="middle" style="padding:11px 0 11px 12px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;background-color:${GOLD};border-radius:17px;font-family:${SANS};font-size:14px;font-weight:700;color:${DARK};">${so.icon}</td></tr></table></td>
      <td valign="middle" style="padding:11px 12px 11px 10px;"><div style="font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${GOLD};">${so.platform}</div><div style="font-family:${SANS};font-size:13px;color:#ffffff;">${esc(so.handle)}</div></td>
    </tr></table>`
    return `<a href="${esc(so.url)}" target="_blank" style="text-decoration:none;">${inner}</a>`
  }
  const socialRow = (a: typeof SOCIALS[number], b: typeof SOCIALS[number]) =>
    `<tr><td width="50%" valign="top" style="padding:0 5px 10px 0;">${socialCard(a)}</td><td width="50%" valign="top" style="padding:0 0 10px 5px;">${socialCard(b)}</td></tr>`

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Montserrat:wght@400;500;600;700&display=swap');body{margin:0;padding:0;background:${CI.cream};}table{border-collapse:collapse;}img{display:block;border:0;}a{text-decoration:none;}p{margin:0;}@media only screen and (max-width:620px){.container{width:100%!important;max-width:100%!important;}}</style></head>
<body style="margin:0;padding:0;background-color:${CI.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CI.cream};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${CI.cream};">
  <tr><td style="padding:8px 40px 28px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" valign="middle"><img src="${LOGO}" width="120" height="37" alt="Happy Property Cyprus" style="display:block;width:120px;height:37px;"></td>
      <td align="right" valign="middle" style="font-family:${SANS};font-size:11px;color:${CI.mute};letter-spacing:0.12em;text-transform:uppercase;">Paphos · Zypern</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0 40px;"><div style="height:2px;width:48px;background-color:${CI.coral};"></div></td></tr>
  <tr><td style="padding:24px 40px 8px 40px;"><h1 style="margin:0;font-family:${SERIF};font-size:30px;line-height:1.15;font-weight:700;color:${CI.navy};">${esc(headline)}</h1></td></tr>
  <tr><td style="padding:18px 40px 0 40px;font-family:${SANS};font-size:15px;line-height:1.7;color:${CI.ink};">Hallo ${esc(firstName)},<br><br>${paras(c.intro_text)}</td></tr>
  ${cards}
  ${c.outro_text?.trim() ? `<tr><td style="padding:28px 40px 0 40px;font-family:${SANS};font-size:14px;line-height:1.7;color:${CI.ink};">${paras(c.outro_text)}</td></tr>` : ''}
  <tr><td style="padding:28px 40px 0 40px;font-family:${SANS};font-size:14px;line-height:1.7;color:${CI.ink};">Wenn dich eines der Objekte anspricht, lass uns am besten kurz persönlich sprechen — unverbindlich und ohne Umwege. Such dir hier direkt einen Termin aus, der dir passt:</td></tr>
  <tr><td style="padding:20px 40px 0 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${CI.coral}" style="border-radius:2px;">
      <a href="${terminUrl}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:#ffffff;text-decoration:none;white-space:nowrap;">📅 Termin aussuchen →</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:24px 40px 0 40px;"><p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};">Liebe Grüße</p></td></tr>
  <tr><td style="padding:14px 40px 0 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="64"><img src="${PHOTO_SQ}" width="56" height="56" alt="Sven" style="width:56px;height:56px;border-radius:50%;display:block;"></td>
      <td valign="middle" style="padding-left:14px;"><div style="font-family:${SERIF};font-size:18px;color:${CI.navy};">Sven</div><div style="font-family:${SANS};font-size:12px;color:#888;margin-top:2px;">Happy Property Cyprus</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:18px 40px 0 40px;"><p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${CI.ink};"><a href="mailto:sven@happy-property.com" style="color:${CI.navy};text-decoration:none;">sven@happy-property.com</a><br>+357 95 09 64 09<br><a href="https://happy-property.com" target="_blank" style="color:#888;text-decoration:none;">happy-property.com</a></p></td></tr>
  <tr><td style="padding:36px 0 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${DARK};"><tr><td style="padding:32px 36px;">
      <div style="font-family:${SERIF};font-size:23px;font-weight:700;line-height:1.2;color:#ffffff;">Folge mir — ich nehme dich mit nach Zypern.</div>
      <div style="font-family:${SANS};font-size:13px;color:#9a9aa3;margin-top:6px;">Projekte, Baufortschritt, Markt-Insights — schau rein und folge:</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
        ${socialRow(SOCIALS[0], SOCIALS[1])}
        ${socialRow(SOCIALS[2], SOCIALS[3])}
      </table>
      <div style="font-family:${SANS};font-size:10px;color:#6b6b74;margin-top:22px;">Sveru Ltd. &nbsp;·&nbsp; Pallados 1, 8046 Paphos, Zypern</div>
    </td></tr></table>
  </td></tr>
  ${firstTok ? `<tr><td align="center" style="padding:18px 40px 0 40px;font-family:${SANS};font-size:11px;line-height:1.6;color:#9a9aa3;">Du möchtest keine Objekt-Empfehlungen mehr per E-Mail erhalten? <a href="${SITE}/abmelden?d=${firstTok}" style="color:#9a9aa3;text-decoration:underline;">Hier abmelden</a> — dann nehmen wir dich aus künftigen Aussendungen heraus.</td></tr>` : ''}
</table></td></tr></table>${firstTok ? `<img src="${Deno.env.get('SUPABASE_URL')}/functions/v1/track-engagement?type=email_open&token=${firstTok}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">` : ''}</body></html>`
}

// Für Test-Mail/Vorschau: Deck-Token eines Leads mit dieser E-Mail (Direkteinstieg
// demonstrieren, ohne echte Kunden zu berühren — der Klick bucht auf den TEST-Lead).
async function bookingTokenFor(sb: SupabaseClient, email: string): Promise<string | undefined> {
  const { data: lead } = await sb.from('leads').select('id').eq('email', email.trim().toLowerCase()).maybeSingle()
  const leadId = (lead as { id?: string } | null)?.id
  if (!leadId) return undefined
  const { data: deck } = await sb.from('sales_decks').select('token').eq('lead_id', leadId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (deck as { token?: string } | null)?.token
}

// Titelbilder je Projekt (erste Render-URL) — für die Objekt-Karten der Mail
async function loadProjectImages(sb: SupabaseClient, projectIds: string[]): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {}
  if (!projectIds.length) return out
  const { data } = await sb.from('crm_projects').select('id, deck_assets').in('id', projectIds)
  for (const p of (data ?? []) as Array<{ id: string; deck_assets: { renders?: string[] } | null }>) {
    out[p.id] = p.deck_assets?.renders?.[0]
  }
  return out
}

// Zielgruppe: Leads ohne aktiven Deal, ohne Opt-out, mit E-Mail
async function loadAudience(sb: SupabaseClient): Promise<Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>> {
  const [{ data: leads }, { data: deals }, { data: optouts }] = await Promise.all([
    sb.from('leads').select('id, first_name, last_name, email').is('newsletter_optout_at', null),
    sb.from('deals').select('lead_id, phase, archived_from_phase'),
    sb.from('communication_optouts').select('lead_id'),
  ])
  const active = new Set((deals ?? []).filter((d: { phase: string; archived_from_phase: string | null }) =>
    d.phase !== 'deal_verloren' && d.phase !== 'archiviert' && !d.archived_from_phase,
  ).map((d: { lead_id: string }) => d.lead_id))
  const opt = new Set((optouts ?? []).map((o: { lead_id: string }) => o.lead_id))
  return ((leads ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>)
    .filter(l => l.email && l.email.includes('@') && !active.has(l.id) && !opt.has(l.id)) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  try {
    const body = await req.json() as {
      action: 'draft_text' | 'test_mail' | 'launch' | 'status' | 'audience' | 'preview' | 'unsubscribe' | 'add_recipient'
      lead_id?: string
      deck_token?: string
      campaign_id?: string; to?: string; start_at?: string
      project_name?: string; bullets?: string
      units?: Array<{ unit_number?: string; price_net?: number; extras?: string }>
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── Zielgruppen-Zähler (Wizard-Anzeige) ──────────────────────────────────
    if (body.action === 'audience') {
      const audience = await loadAudience(sb)
      return json({ ok: true, total: audience.length })
    }

    // ── KI-Text aus Stichpunkten ─────────────────────────────────────────────
    if (body.action === 'draft_text') {
      const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
      if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)
      const unitsTxt = (body.units ?? []).map(u => `- ${u.unit_number}: ${u.price_net ? `${u.price_net.toLocaleString('de-DE')} € netto` : ''} ${u.extras ?? ''}`).join('\n')
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 700,
          system: `Du schreibst für Happy Property (Zypern-Immobilien für deutsche Kapitalanleger, Absender Sven) einen kurzen Absatz für eine persönliche E-Mail an Bestandsinteressenten. DU-Form, warm, konkret, keine Superlative-Floskeln, kein Betreff, KEINE Anrede, KEIN Gruß, KEINE Links (kommen separat). 60–110 Wörter, Zahlen im Format 270.000 €. Der Absatz stellt das Objekt/die Objekte vor und macht Lust, das Exposé zu öffnen.`,
          messages: [{ role: 'user', content: `Projekt: ${body.project_name}\nWohnungen:\n${unitsTxt}\n\nSvens Stichpunkte:\n${body.bullets ?? ''}` }],
        }),
      })
      if (!res.ok) return json({ error: `KI-Fehler ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502)
      const d = await res.json() as { content?: Array<{ text?: string }> }
      return json({ ok: true, text: (d.content?.[0]?.text ?? '').trim() })
    }

    // ── Abmelden (öffentlich, per persönlichem Deck-Token aus der Mail) ─────
    // Setzt NUR leads.newsletter_optout_at — Termin-/Transaktionskommunikation
    // läuft weiter (dafür gibt es communication_optouts).
    if (body.action === 'unsubscribe') {
      const tok = (body.deck_token ?? '').trim()
      if (!tok) return json({ error: 'token fehlt' }, 400)
      const { data: deck } = await sb.from('sales_decks').select('lead_id').eq('token', tok).maybeSingle()
      const leadId = (deck as { lead_id?: string | null } | null)?.lead_id ?? null
      if (!leadId) return json({ error: 'not_found' }, 404)
      const { error: ue } = await sb.from('leads').update({ newsletter_optout_at: new Date().toISOString() }).eq('id', leadId)
      if (ue) return json({ error: ue.message }, 500)
      // Noch nicht versendete Newsletter-Mails (auch geplante Kampagnen) stoppen
      const { error: ce } = await sb.from('scheduled_messages').update({ status: 'cancelled' })
        .eq('lead_id', leadId).eq('event_type', 'newsletter').eq('status', 'pending')
      if (ce) console.warn('[newsletter] optout cancel:', ce.message)
      try {
        await sb.from('activities').insert({
          lead_id: leadId, type: 'note', direction: 'inbound',
          subject: 'Newsletter abbestellt',
          content: 'Der Kontakt hat sich über den Abmelde-Link im Newsletter von künftigen Aussendungen abgemeldet.',
          completed_at: new Date().toISOString(),
        })
      } catch (e) { console.warn('[newsletter] optout activity:', e) }
      console.log(`[newsletter] Abmeldung: Lead ${leadId}`)
      return json({ ok: true })
    }

    // Ab hier: Kampagne nötig
    if (!body.campaign_id) return json({ error: 'campaign_id fehlt' }, 400)
    const { data: camp, error: cErr } = await sb.from('newsletter_campaigns').select('*').eq('id', body.campaign_id).single()
    if (cErr || !camp) return json({ error: `Kampagne: ${cErr?.message ?? 'nicht gefunden'}` }, 404)
    const properties = (camp.properties ?? []) as CampaignProperty[]

    // ── Status ───────────────────────────────────────────────────────────────
    if (body.action === 'status') {
      return json({ ok: true, status: camp.status, total: camp.recipients_total, done: camp.recipients_done, error: camp.launch_error })
    }

    // ── Test-Mail (Master-Links, sofort, an Sven) ────────────────────────────
    // ── Vorschau: exakt das HTML, das auch versendet wird (ohne Versand) ─────
    if (body.action === 'preview') {
      const properties = (camp.properties ?? []) as CampaignProperty[]
      const deckTokens: Record<string, string> = {}
      for (const p of properties) if (p.master_deck_token) deckTokens[p.project_id] = p.master_deck_token
      const projectImages = await loadProjectImages(sb, properties.map(p => p.project_id))
      const bookingToken = await bookingTokenFor(sb, 'sven@happy-property.com')
      const html = buildEmailHtml(camp, 'Vorname', deckTokens, { campaignId: String(camp.id), directBooking: false, projectImages, bookingToken })
      return json({ ok: true, subject: String(camp.subject ?? ''), html })
    }

    // ── Einzelnen Empfänger NACHTRÄGLICH aufnehmen (gleiche Behandlung wie beim
    // Launch: eigene Deck-Klone, personalisierte Mail, Abmelde-Link, Pixel) ──
    if (body.action === 'add_recipient') {
      if (!body.lead_id) return json({ error: 'lead_id fehlt' }, 400)
      const { data: leadRow } = await sb.from('leads').select('id, first_name, last_name, email, newsletter_optout_at').eq('id', body.lead_id).maybeSingle()
      const lead = leadRow as { id: string; first_name: string | null; last_name: string | null; email: string | null; newsletter_optout_at: string | null } | null
      if (!lead?.email) return json({ error: 'Lead hat keine E-Mail' }, 400)
      if (lead.newsletter_optout_at) return json({ error: 'Lead hat den Newsletter abbestellt' }, 409)
      const { data: dup } = await sb.from('scheduled_messages').select('id').eq('lead_id', lead.id).eq('campaign_id', camp.id).limit(1)
      if (dup && dup.length) return json({ error: 'Lead hat diese Kampagne bereits erhalten' }, 409)
      const properties = (camp.properties ?? []) as CampaignProperty[]
      // Master-Decks laden
      const masters: Record<string, { project_id: string; angle: string | null; content: unknown }> = {}
      for (const p of properties) {
        if (!p.master_deck_token) return json({ error: `Master-Deck fehlt für ${p.project_name}` }, 400)
        const { data: m } = await sb.from('sales_decks').select('project_id, angle, content').eq('token', p.master_deck_token).maybeSingle()
        if (!m) return json({ error: `Master-Deck nicht gefunden für ${p.project_name}` }, 400)
        masters[p.project_id] = m as typeof masters[string]
      }
      const first = firstNameOf(lead)
      const firstJsonSafe = JSON.stringify(first).slice(1, -1)
      const fullName = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim()
      const deckTokens: Record<string, string> = {}
      for (const p of properties) {
        const master = masters[p.project_id]
        const token = randToken()
        const contentStr = JSON.stringify(master.content).split('{{vorname}}').join(firstJsonSafe)
        const { error: ie } = await sb.from('sales_decks').insert({
          token, lead_id: lead.id, project_id: master.project_id, angle: master.angle,
          status: 'ready', recipient_name: fullName || first, batch_id: camp.id,
          content: JSON.parse(contentStr),
        })
        if (ie) return json({ error: `Deck-Klon fehlgeschlagen: ${ie.message}` }, 500)
        deckTokens[p.project_id] = token
      }
      const projectImages = await loadProjectImages(sb, properties.map(p => p.project_id))
      const html = buildEmailHtml(camp, first, deckTokens, { campaignId: String(camp.id), directBooking: true, projectImages })
      const subject = String(camp.subject).split('{{vorname}}').join(first)
      const { error: se } = await sb.from('scheduled_messages').insert({
        lead_id: lead.id, type: 'email', event_type: 'newsletter', campaign_id: camp.id,
        status: 'pending', scheduled_at: clampToWindow(new Date()).toISOString(),
        email_subject: subject, email_body: html,
      })
      if (se) return json({ error: `Mail-Planung fehlgeschlagen: ${se.message}` }, 500)
      await sb.from('newsletter_campaigns').update({ recipients_total: (camp.recipients_total ?? 0) + 1, recipients_done: (camp.recipients_done ?? 0) + 1, updated_at: new Date().toISOString() }).eq('id', camp.id)
      return json({ ok: true, deck_tokens: deckTokens })
    }

    if (body.action === 'test_mail') {
      const to = (body.to ?? 'sven@happy-property.com').trim()
      const deckTokens: Record<string, string> = {}
      for (const p of properties) if (p.master_deck_token) deckTokens[p.project_id] = p.master_deck_token
      const projectImages = await loadProjectImages(sb, properties.map(p => p.project_id))
      const bookingToken = body.to ? await bookingTokenFor(sb, body.to) : undefined
      const html = buildEmailHtml(camp, 'Sven', deckTokens, { campaignId: String(camp.id), directBooking: false, projectImages, bookingToken })
      const { error: se } = await sb.functions.invoke('send-email', { body: { to, subject: `[TEST] ${camp.subject}`, html } })
      if (se) return json({ error: `Testversand: ${se.message}` }, 502)
      return json({ ok: true })
    }

    // ── Launch (Hintergrund) ─────────────────────────────────────────────────
    if (body.action === 'launch') {
      if (camp.status !== 'draft') return json({ error: `Kampagne ist bereits ${camp.status}` }, 409)
      if (!camp.subject?.trim()) return json({ error: 'Betreff fehlt' }, 400)
      if (!properties.length || properties.some(p => !p.master_deck_token)) return json({ error: 'Master-Decks fehlen' }, 400)

      const audience = await loadAudience(sb)
      if (!audience.length) return json({ error: 'Zielgruppe ist leer' }, 400)
      await sb.from('newsletter_campaigns').update({ status: 'launching', recipients_total: audience.length, recipients_done: 0, updated_at: new Date().toISOString() }).eq('id', camp.id)
      const projectImages = await loadProjectImages(sb, properties.map((p: CampaignProperty) => p.project_id))

      // Master-Decks einmal laden
      const masters: Record<string, { content: unknown; project_id: string | null; angle: string | null }> = {}
      for (const p of properties) {
        const { data: md, error: me } = await sb.from('sales_decks').select('content, project_id, angle').eq('token', p.master_deck_token!).single()
        if (me || !md) return json({ error: `Master-Deck ${p.project_name} nicht ladbar: ${me?.message}` }, 500)
        masters[p.project_id] = md as { content: unknown; project_id: string | null; angle: string | null }
      }

      const job = (async () => {
        try {
          // Geplanter Versandstart: Staffelung beginnt frühestens zum Wunschtermin
          const startAt = body.start_at ? new Date(body.start_at) : null
          const base = startAt && startAt.getTime() > Date.now() ? startAt.getTime() : Date.now() + 120e3
          let slot = clampToWindow(new Date(base))
          let done = 0, skipped = 0
          for (const lead of audience) {
            // Pro-Empfänger-Fehlerbehandlung: EIN problematischer Lead darf nie
            // die restliche Kampagne stoppen.
            try {
              const first = firstNameOf(lead)
              // JSON-sicher einsetzen (Namen können Anführungszeichen/Backslashes enthalten)
              const firstJsonSafe = JSON.stringify(first).slice(1, -1)
              const fullName = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim()
              const deckTokens: Record<string, string> = {}
              for (const p of properties) {
                const master = masters[p.project_id]
                const token = randToken()
                const contentStr = JSON.stringify(master.content).split('{{vorname}}').join(firstJsonSafe)
                const { error: ie } = await sb.from('sales_decks').insert({
                  token, lead_id: lead.id, project_id: master.project_id, angle: master.angle,
                  status: 'ready', recipient_name: fullName || first, batch_id: camp.id,
                  content: JSON.parse(contentStr),
                })
                if (ie) { console.error(`[newsletter] Deck-Klon ${lead.id}/${p.project_name}:`, ie.message); continue }
                deckTokens[p.project_id] = token
              }
              // Mail NUR planen, wenn ALLE Deck-Links da sind — lieber auslassen
              // als eine Mail ohne das versprochene Exposé verschicken.
              if (Object.keys(deckTokens).length !== properties.length) {
                skipped++
                console.error(`[newsletter] ${lead.id}: unvollständige Decks — Empfänger übersprungen`)
                continue
              }
              const html = buildEmailHtml(camp, first, deckTokens, { campaignId: String(camp.id), directBooking: true, projectImages })
              const subject = String(camp.subject).split('{{vorname}}').join(first)
              const { error: se } = await sb.from('scheduled_messages').insert({
                lead_id: lead.id, type: 'email', event_type: 'newsletter', campaign_id: camp.id,
                status: 'pending', scheduled_at: slot.toISOString(),
                email_subject: subject, email_body: html,
                recipient: 'client', appointment_condition: 'none',
              })
              if (se) { skipped++; console.error(`[newsletter] Mail-Planung ${lead.id}:`, se.message); continue }
              slot = clampToWindow(new Date(slot.getTime() + (STEP_SEC + Math.floor(Math.random() * JITTER_SEC)) * 1000))
              done++
              if (done % 10 === 0) await sb.from('newsletter_campaigns').update({ recipients_done: done }).eq('id', camp.id)
            } catch (leadErr) {
              skipped++
              console.error(`[newsletter] Empfänger ${lead.id} übersprungen:`, leadErr)
            }
          }
          await sb.from('newsletter_campaigns').update({
            status: 'sending', recipients_done: done, updated_at: new Date().toISOString(),
            launch_error: skipped > 0 ? `${skipped} Empfänger übersprungen (Details im Log)` : null,
          }).eq('id', camp.id)
          console.log(`[newsletter] Kampagne ${camp.id}: ${done} Mails geplant, ${skipped} übersprungen`)
        } catch (e) {
          console.error('[newsletter] Launch-Fehler:', e)
          await sb.from('newsletter_campaigns').update({ status: 'draft', launch_error: (e as Error).message }).eq('id', camp.id)
        }
      })()
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      if (er?.waitUntil) er.waitUntil(job); else await job
      return json({ ok: true, total: audience.length, background: true })
    }

    return json({ error: `Unbekannte action` }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[newsletter-campaign] Fehler:', msg)
    return json({ error: msg }, 500)
  }
})
