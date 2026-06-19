// Supabase Edge Function: compose-deck-mail
// Schreibt aus Kunden-Briefing + Wohnungs-Auswahl die persönliche Begleit-Mail
// (Claude) — ausführlich, locker-herzlich, KEIN Straßenslang. Liefert subject +
// fertiges HTML (Deck-Links werden serverseitig sauber eingebaut). Es wird NICHTS
// gesendet — die Mail landet als Entwurf im Postausgang (Freigabe durch Sven).
//
// Body: { recipient_name, first_name?, briefing?, angle?,
//         items: [{ label, link, project?, unit?, bedrooms?, size_sqm?, terrace_sqm?, floor?, price? }] }
// Antwort: { subject, html }

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM = `Du bist Sven von Happy Property Cyprus — einer Brokerage, die deutschsprachigen Kapitalanlegern hochwertige Immobilien auf Zypern (Paphos) vermittelt. Du schreibst die persönliche Begleit-Mail, mit der du einem Kunden seine individuell zusammengestellten Sales-Decks (Wohnungs-Vorschläge mit je einem Link) schickst.

TONFALL: locker und herzlich, per DU, wie an einen Menschen, mit dem du schon gesprochen hast. Sympathisch, kompetent, nahbar — aber NIEMALS Straßenslang, keine flapsigen Sprüche, kein 'Hey Digga', kein übertriebener Werbe-Schaum. Du klingst wie ein guter Berater, der sich wirklich Zeit nimmt.

LÄNGE: AUSFÜHRLICH. Keine dürren Stichworte, keine Telegramm-Sätze. Schreib echte, runde Absätze, sodass der Kunde merkt, dass du dir Gedanken gemacht hast. Aber kein Geschwafel — jeder Satz trägt etwas bei.

INHALT:
- Nimm das Kunden-Briefing direkt auf (seine Situation, sein Motiv, was ihm wichtig ist) und spiegele es in eigenen Worten wider — schreib es nicht 1:1 ab.
- Erkläre kurz und glaubwürdig, warum du genau diese Wohnung(en) für ihn herausgesucht hast.
- Mach Lust, die Decks in Ruhe anzuschauen, ohne zu drängen.
- Lade entspannt zum nächsten Schritt ein (Fragen, kurze Rückmeldung, gemeinsamer Call).

Du rufst das Tool emit_mail auf:
- subject: persönliche, ruhige Betreffzeile (kein Spam-Sprech, keine Großbuchstaben-Schreierei, keine Emojis im Betreff)
- greeting: die Anrede, z.B. 'Hallo Nico,'
- body_paragraphs: 2 bis 4 Absätze VOR der Wohnungs-Liste (warmer Einstieg, Bezug aufs Briefing, warum diese Auswahl)
- deck_lines: GENAU EINE Zeile pro Wohnung, in derselben Reihenfolge wie die Wohnungen im Input — ein warmer, konkreter Satz, warum genau dieses Apartment zu ihm passt
- closing_paragraphs: 1 bis 2 Absätze NACH der Liste (in Ruhe anschauen, jederzeit melden, lockerer Hinweis auf den nächsten Schritt)
- signoff: z.B. 'Bis bald,' oder 'Liebe Grüße,'
- signName: 'Sven · Happy Property Cyprus'

REGELN:
- Nutze NUR Fakten aus dem Input. Erfinde KEINE Preise, Zahlen, Lagen oder Eigenschaften.
- Durchgehend Deutsch und Du-Form.
- deck_lines MUSS exakt so viele Einträge haben wie Wohnungen im Input — gleiche Reihenfolge.
- Schreib die Links NICHT selbst in den Text; die Buttons werden automatisch eingefügt.
- KRITISCH für gültiges JSON: Verwende in ALLEN Texten NIEMALS doppelte Anführungszeichen — nutze einfache 'so' oder gar keine.`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface MailItem {
  label?: string; link?: string; project?: string; unit?: string
  bedrooms?: number | null; size_sqm?: number | null; terrace_sqm?: number | null
  floor?: number | null; price?: string
}

function itemFacts(it: MailItem, i: number): string {
  const label = it.label || [it.project, it.unit].filter(Boolean).join(' · ') || `Wohnung ${i + 1}`
  const parts: string[] = []
  if (it.bedrooms != null) parts.push(`${it.bedrooms} Schlafzimmer`)
  if (it.size_sqm != null) parts.push(`${it.size_sqm} m² Wohnfläche`)
  if (it.terrace_sqm) parts.push(`${it.terrace_sqm} m² Terrasse`)
  if (it.floor != null) parts.push(`${it.floor}. Etage`)
  if (it.price) parts.push(it.price)
  return `${i + 1}. ${label}${parts.length ? ' — ' + parts.join(', ') : ''}`
}

// Branded, E-Mail-sicheres HTML (Inline-Styles, Coral-Buttons) aus den Claude-Texten bauen.
function buildHtml(
  m: { greeting?: string; body_paragraphs?: string[]; deck_lines?: string[]; closing_paragraphs?: string[]; signoff?: string; signName?: string },
  items: MailItem[],
): string {
  const P = (s: string) => `<p style="margin:0 0 16px">${esc(s)}</p>`
  const greeting = m.greeting ? P(m.greeting) : ''
  const intro = (m.body_paragraphs ?? []).map(P).join('')
  const cards = items.map((it, i) => {
    const label = it.label || [it.project, it.unit].filter(Boolean).join(' · ') || `Wohnung ${i + 1}`
    const line = (m.deck_lines ?? [])[i]
    const href = it.link || '#'
    return `<div style="border:1px solid #eeeeee;border-radius:14px;padding:18px 20px;margin:0 0 14px;background:#fafafa">`
      + `<div style="font-weight:700;font-size:17px;color:#1a1a1a;margin:0 0 4px">${esc(label)}</div>`
      + (line ? `<div style="color:#555555;margin:0 0 14px;line-height:1.55">${esc(line)}</div>` : '<div style="margin:0 0 14px"></div>')
      + `<a href="${esc(href)}" style="display:inline-block;background:#ff795d;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:10px 20px;border-radius:10px">Dein Sales Deck ansehen →</a>`
      + `</div>`
  }).join('')
  const closing = (m.closing_paragraphs ?? []).map(P).join('')
  const sign = `<p style="margin:24px 0 0">${esc(m.signoff || 'Bis bald,')}<br><strong>${esc(m.signName || 'Sven · Happy Property Cyprus')}</strong></p>`
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:#2b2b2b;max-width:600px;margin:0 auto">`
    + greeting + intro
    + `<div style="margin:24px 0">${cards}</div>`
    + closing + sign
    + `</div>`
}

// Schlanker Fallback, falls Claude/Key mal nicht greift — nie ohne Mail dastehen.
function fallback(firstName: string, items: MailItem[]): { subject: string; html: string } {
  const m = {
    greeting: `Hallo ${firstName || 'zusammen'},`,
    body_paragraphs: ['wie besprochen habe ich dir deine persönlichen Wohnungs-Vorschläge zusammengestellt. Schau sie dir in Ruhe an — ich freue mich auf deine Rückmeldung.'],
    deck_lines: items.map(() => ''),
    closing_paragraphs: ['Melde dich jederzeit, wenn du Fragen hast oder wir die Optionen gemeinsam durchgehen sollen.'],
    signoff: 'Bis bald,',
    signName: 'Sven · Happy Property Cyprus',
  }
  const subject = items.length > 1 ? 'Deine Wohnungs-Vorschläge von Happy Property' : `Dein Vorschlag: ${items[0]?.label ?? ''}`.trim()
  return { subject, html: buildHtml(m, items) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const body = await req.json() as {
      recipient_name?: string; first_name?: string; briefing?: string; angle?: string
      items?: MailItem[]
    }
    const items = (body.items ?? []).filter(it => it && it.link)
    if (!items.length) return json({ error: 'items fehlt' }, 400)
    const firstName = body.first_name?.trim() || (body.recipient_name?.trim().split(' ')[0] ?? '')

    if (!ANTHROPIC_API_KEY) return json(fallback(firstName, items))

    const angle = body.angle === 'investment' ? 'investment' : 'lifestyle'
    const userMsg = [
      `KUNDE: ${body.recipient_name?.trim() || firstName || 'der Kunde'}`,
      `WINKEL: ${angle} (${angle === 'investment' ? 'Rendite, Vermietung, Wertentwicklung' : 'Wohnen, Lebensgefühl, selbst nutzen'})`,
      ``,
      `KUNDEN-BRIEFING (Svens Notizen zum Kunden — als Grundlage fürs Anschreiben):`,
      body.briefing?.trim() || '(kein Briefing — halte die Mail allgemein, aber persönlich und warm)',
      ``,
      `DIESE WOHNUNGEN HAST DU FÜR IHN ZUSAMMENGESTELLT (Reihenfolge = Reihenfolge der deck_lines):`,
      ...items.map((it, i) => itemFacts(it, i)),
    ].join('\n')

    const reqBody = JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 2000,
      system:     SYSTEM,
      tools: [{
        name:        'emit_mail',
        description: 'Gibt die fertige Begleit-Mail in Bausteinen zurück.',
        input_schema: {
          type: 'object',
          properties: {
            subject:            { type: 'string' },
            greeting:           { type: 'string' },
            body_paragraphs:    { type: 'array', items: { type: 'string' } },
            deck_lines:         { type: 'array', items: { type: 'string' } },
            closing_paragraphs: { type: 'array', items: { type: 'string' } },
            signoff:            { type: 'string' },
            signName:           { type: 'string' },
          },
          required: ['subject', 'greeting', 'body_paragraphs', 'deck_lines', 'closing_paragraphs', 'signoff', 'signName'],
        },
      }],
      tool_choice: { type: 'tool', name: 'emit_mail' },
      messages: [{ role: 'user', content: userMsg }],
    })

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: reqBody,
    })
    if (!res.ok) return json(fallback(firstName, items))   // bei API-Fehler nie ohne Mail dastehen

    const data = await res.json() as { content?: Array<{ type?: string; input?: Record<string, unknown> }> }
    const tu = (data.content ?? []).find(c => c.type === 'tool_use')
    const m = (tu?.input ?? null) as null | {
      subject?: string; greeting?: string; body_paragraphs?: string[]; deck_lines?: string[]
      closing_paragraphs?: string[]; signoff?: string; signName?: string
    }
    if (!m || !m.subject) return json(fallback(firstName, items))

    return json({ subject: m.subject, html: buildHtml(m, items) })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
