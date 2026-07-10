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
const TZ = 'Europe/Berlin'
const SEND_START_H = 8, SEND_END_H = 20
const STEP_SEC = 180            // Grundabstand 3 Min
const JITTER_SEC = 60           // + Zufall bis 60s

interface CampaignProperty {
  project_id: string; project_name: string
  unit_numbers: string[]
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

// Mail wie Svens normale Mails: schlichter Text-Look, keine Marketing-Optik
function buildEmailHtml(c: {
  intro_text: string; outro_text: string; properties: CampaignProperty[]
}, firstName: string, deckTokens: Record<string, string>): string {
  const parts: string[] = []
  parts.push(`<p>Hallo ${esc(firstName)},</p>`)
  parts.push(`<p style="white-space:pre-wrap">${esc(c.intro_text.trim())}</p>`)
  for (const p of c.properties) {
    parts.push(`<p style="margin-top:18px"><strong>${esc(p.project_name)}${p.unit_numbers.length ? ` · ${esc(p.unit_numbers.join(' & '))}` : ''}</strong></p>`)
    if (p.ai_text?.trim()) parts.push(`<p style="white-space:pre-wrap">${esc(p.ai_text.trim())}</p>`)
    const deckTok = deckTokens[p.project_id]
    if (deckTok) parts.push(`<p>👉 Dein persönliches Exposé: <a href="${SITE}/deck/${deckTok}" style="color:#ff795d">${SITE}/deck/${deckTok}</a></p>`)
    if (p.calc_token) parts.push(`<p>📊 Beispielrechnung mit allen Zahlen: <a href="${SITE}/rechnung/${p.calc_token}" style="color:#ff795d">${SITE}/rechnung/${p.calc_token}</a></p>`)
  }
  if (c.outro_text?.trim()) parts.push(`<p style="white-space:pre-wrap;margin-top:18px">${esc(c.outro_text.trim())}</p>`)
  return `<div style="font-family:Montserrat,Arial,sans-serif;color:#1b1b22;font-size:14px;line-height:1.65">${parts.join('\n')}</div>`
}

// Zielgruppe: Leads ohne aktiven Deal, ohne Opt-out, mit E-Mail
async function loadAudience(sb: SupabaseClient): Promise<Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>> {
  const [{ data: leads }, { data: deals }, { data: optouts }] = await Promise.all([
    sb.from('leads').select('id, first_name, last_name, email'),
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
      action: 'draft_text' | 'test_mail' | 'launch' | 'status' | 'audience'
      campaign_id?: string; to?: string
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
    if (body.action === 'test_mail') {
      const to = (body.to ?? 'sven@happy-property.com').trim()
      const deckTokens: Record<string, string> = {}
      for (const p of properties) if (p.master_deck_token) deckTokens[p.project_id] = p.master_deck_token
      const html = buildEmailHtml(camp, 'Sven', deckTokens)
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

      // Master-Decks einmal laden
      const masters: Record<string, { content: unknown; project_id: string | null; angle: string | null }> = {}
      for (const p of properties) {
        const { data: md, error: me } = await sb.from('sales_decks').select('content, project_id, angle').eq('token', p.master_deck_token!).single()
        if (me || !md) return json({ error: `Master-Deck ${p.project_name} nicht ladbar: ${me?.message}` }, 500)
        masters[p.project_id] = md as { content: unknown; project_id: string | null; angle: string | null }
      }

      const job = (async () => {
        try {
          let slot = clampToWindow(new Date(Date.now() + 120e3))
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
              const html = buildEmailHtml(camp, first, deckTokens)
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
