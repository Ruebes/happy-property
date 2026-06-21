// Supabase Edge Function: compose-deck-mail
// Schreibt aus Kunden-Briefing + ECHTEN Projekt-Fakten die persönliche Begleit-Mail
// (Claude) — verkaufsorientiert, locker-herzlich, KEIN Slang, mit konkreten Argumenten
// pro Objekt + Pflicht-CTA (neuer Zoom-Termin / Feedback per Mail/WhatsApp). Liefert
// subject + fertiges HTML. Es wird NICHTS gesendet — Entwurf landet im Postausgang.
//
// Body: { recipient_name, first_name?, briefing?, angle?,
//   items: [{ label, link, project?, unit?, bedrooms?, size_sqm?, terrace_sqm?, floor?,
//             price?, facts?, available_count?, total_count? }] }
// Antwort: { subject, html }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CALENDLY = 'https://calendly.com/sven-happy-property/30min'
const SVEN_EMAIL = 'sven@happy-property.com'
const WA_NUMBER = (Deno.env.get('TIMELINES_WA_SENDER') ?? '').replace(/[^\d]/g, '')   // wa.me-Link
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM = `Du bist Sven von Happy Property Cyprus — Brokerage für deutschsprachige Kapitalanleger, die auf Zypern (Paphos) in Immobilien investieren. Du schreibst die persönliche Begleit-Mail, mit der du einem Kunden seine individuell zusammengestellten Sales-Decks (Wohnungs-Vorschläge mit je einem Link) schickst.

ZIEL DER MAIL: Der Kunde soll die Decks öffnen, sich für ein Objekt begeistern und HANDELN — einen neuen Termin buchen oder dir Feedback geben. Die Mail verkauft. Nicht marktschreierisch, aber überzeugend: Du bist der Profi, der genau weiß, warum diese Objekte zu ihm passen.

TONFALL: locker und herzlich, per DU, wie an einen Menschen, mit dem du schon gesprochen hast. Sympathisch, kompetent, selbstbewusst — NIEMALS Straßenslang, keine flapsigen Sprüche, kein Werbe-Geschrei.

DAS WICHTIGSTE — KONKRETE ARGUMENTE PRO OBJEKT:
Zu jedem Objekt bekommst du echte FAKTEN (Bauträger, Lage, Amenities, Einheiten, Verfügbarkeit). Schreib pro Objekt 2 bis 4 Sätze, die die STÄRKSTEN Verkaufsargunmente aus genau diesen Fakten herausziehen — so wie ein guter Makler, der weiß, was zählt:
- konkrete Amenities, die Miete/Wert treiben (Pool, Gym, Dachterrasse, Concierge, Strandnähe …)
- Lagevorteile (Meerblick, Entfernung zu Marina/Strand/Zentrum, Bauträger-Qualität)
- Knappheit, WENN echt (z.B. 'von X Einheiten nur noch Y frei' — nur wenn die Zahlen im Input stehen)
- was die konkrete Wohnung besonders macht (Etage, Terrasse, Ausstattung)
Schreib BILDHAFT und konkret, nicht generisch. 'Pool, Gym und Dachterrasse mit Meerblick' schlägt 'hochwertige Ausstattung'.

PERSÖNLICHE EMPFEHLUNG: Wenn sich aus Briefing + Fakten eine klare Empfehlung ergibt (welches Objekt für genau diesen Kunden am besten passt und warum), gib sie als 'recommendation' ab — ehrlich begründet. Wenn nicht eindeutig, lass 'recommendation' leer.

HARTE REGELN:
- Nutze NUR Fakten aus dem Input. Erfinde NIEMALS Zahlen, Renditen, Cashflow, Fertigstellungs-Daten, Entfernungen oder Eigenschaften. Steht ein Fakt nicht da, behaupte ihn nicht.
- Nimm das Kunden-Briefing auf (Situation, Motiv, Budget-Hinweise) und spiegele es — schreib es nicht 1:1 ab.
- Durchgehend Deutsch, Du-Form.
- deck_lines MUSS exakt so viele Einträge haben wie Objekte im Input (gleiche Reihenfolge).
- Schreib die Links/Buttons NICHT selbst — die werden automatisch eingefügt.
- KRITISCH für gültiges JSON: in ALLEN Texten NIEMALS doppelte Anführungszeichen — nutze einfache 'so' oder gar keine.

Du rufst das Tool emit_mail auf:
- subject: persönliche, neugierig machende Betreffzeile (kein Spam-Sprech, keine Emojis)
- greeting: Anrede, z.B. 'Hallo Nico,'
- body_paragraphs: 1 bis 2 Absätze VOR der Objekt-Liste (warmer Einstieg, Briefing-Bezug, warum genau diese Auswahl)
- deck_lines: pro Objekt 2 bis 4 Sätze mit konkreten Verkaufsargumenten (gleiche Reihenfolge wie Input)
- recommendation: optionale klare Empfehlung mit Begründung (sonst leer)
- cta_paragraph: 1 Absatz, der zum nächsten Schritt einlädt — neuen Termin buchen ODER kurzes Feedback per Mail/WhatsApp; verbindlich, aber ohne Druck (die Buttons kommen automatisch darunter)
- signoff: z.B. 'Bis bald,'
- signName: 'Sven · Happy Property Cyprus'`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface MailItem {
  label?: string; link?: string; calc_link?: string; image?: string; project?: string; unit?: string
  bedrooms?: number | null; size_sqm?: number | null; terrace_sqm?: number | null
  floor?: number | null; price?: string; facts?: string
  available_count?: number | null; total_count?: number | null
}

function itemBrief(it: MailItem, i: number): string {
  const label = it.label || [it.project, it.unit].filter(Boolean).join(' · ') || `Objekt ${i + 1}`
  const specs: string[] = []
  if (it.bedrooms != null) specs.push(`${it.bedrooms} Schlafzimmer`)
  if (it.size_sqm != null) specs.push(`${it.size_sqm} m² Wohnfläche`)
  if (it.terrace_sqm) specs.push(`${it.terrace_sqm} m² Terrasse`)
  if (it.floor != null) specs.push(`${it.floor}. Etage`)
  if (it.price) specs.push(`Preis ${it.price}`)
  const avail = (it.available_count != null && it.total_count != null && it.total_count > 0)
    ? `\nVERFÜGBARKEIT: von ${it.total_count} Einheiten im Projekt aktuell ${it.available_count} frei.`
    : ''
  const facts = it.facts?.trim() ? `\nPROJEKT-FAKTEN (nur diese verwenden):\n${it.facts.trim()}` : ''
  return `OBJEKT ${i + 1}: ${label}\nDiese Wohnung: ${specs.join(', ') || '–'}.${avail}${facts}`
}

const P = (s: string) => `<p style="margin:0 0 16px">${esc(s)}</p>`
const btn = (href: string, label: string, bg: string, color: string, border = 'none') =>
  `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${color};text-decoration:none;font-weight:600;font-size:15px;padding:11px 22px;border-radius:10px;border:${border};margin:0 8px 8px 0">${esc(label)}</a>`

// Branded, E-Mail-sicheres HTML aus den Claude-Texten + Objekt-Karten + CTA bauen.
function buildHtml(
  m: { greeting?: string; body_paragraphs?: string[]; deck_lines?: string[]; recommendation?: string; cta_paragraph?: string; signoff?: string; signName?: string },
  items: MailItem[],
  calc?: { link: string; label: string } | null,
): string {
  const greeting = m.greeting ? P(m.greeting) : ''
  const intro = (m.body_paragraphs ?? []).map(P).join('')
  const cards = items.map((it, i) => {
    const label = it.label || [it.project, it.unit].filter(Boolean).join(' · ') || `Objekt ${i + 1}`
    const line = (m.deck_lines ?? [])[i]
    const photo = it.image ? `<a href="${esc(it.link || '#')}" style="display:block;text-decoration:none"><img src="${esc(it.image)}" alt="${esc(label)}" width="100%" style="width:100%;max-height:200px;object-fit:cover;border-radius:10px;margin:0 0 14px;display:block" /></a>` : ''
    return `<div style="border:1px solid #eeeeee;border-radius:14px;padding:18px;margin:0 0 14px;background:#fafafa">`
      + photo
      + `<div style="font-weight:700;font-size:18px;color:#1a1a1a;margin:0 0 8px">${esc(label)}</div>`
      + (line ? `<div style="color:#444444;margin:0 0 16px;line-height:1.6">${esc(line)}</div>` : '<div style="margin:0 0 16px"></div>')
      + btn(it.link || '#', 'Dein Sales Deck ansehen →', '#ff795d', '#ffffff')
      + (it.calc_link ? btn(it.calc_link, '📊 Rendite-Berechnung →', '#2f6b4f', '#ffffff') : '')
      + `</div>`
  }).join('')
  const reco = m.recommendation?.trim()
    ? `<div style="margin:0 0 20px;padding:16px 18px;border-radius:12px;background:#fff5f2;border-left:4px solid #ff795d"><strong style="color:#c2410c">Meine Empfehlung:</strong> <span style="color:#444">${esc(m.recommendation)}</span></div>`
    : ''
  // CTA-Block (Pflicht): neuer Termin + Feedback per WhatsApp/Mail
  const waBtn = WA_NUMBER ? btn(`https://wa.me/${WA_NUMBER}`, '💬 Per WhatsApp', '#25D366', '#ffffff') : ''
  const cta = `<div style="margin:26px 0 8px;padding:22px;border-radius:14px;background:#1a1a1a">`
    + `<div style="font-weight:700;font-size:17px;color:#ffffff;margin:0 0 8px">Wie geht es weiter?</div>`
    + `<div style="color:#d4d4d4;line-height:1.6;margin:0 0 16px">${esc(m.cta_paragraph || 'Lass uns die Optionen gemeinsam durchgehen — buch dir einfach einen neuen Termin oder gib mir kurz Feedback.')}</div>`
    + btn(CALENDLY, '📅 Neuen Termin buchen', '#ff795d', '#ffffff')
    + waBtn
    + btn(`mailto:${SVEN_EMAIL}`, '✉️ Per E-Mail', 'transparent', '#ffffff', '1px solid #555')
    + `</div>`
  // Abschließender Gesamt-Vergleich aller Wohnungen (die einzelnen Berechnungen je
  // Wohnung hängen bereits an der jeweiligen Objekt-Karte).
  const calcBlock = calc?.link
    ? `<div style="margin:0 0 20px;padding:18px 20px;border-radius:14px;background:#f0f7f4;border:1px solid #d4e9df">`
      + `<div style="font-weight:700;font-size:16px;color:#1a1a1a;margin:0 0 6px">📊 ${esc(calc.label || 'Dein Immobilienvergleich')}</div>`
      + `<div style="color:#555;margin:0 0 14px;line-height:1.55">Und damit du die Wohnungen direkt nebeneinander hast: hier der komplette Vergleich — Eigenkapital, Cashflow, Rendite und Wertentwicklung über 10 Jahre, schwarz auf weiß.</div>`
      + btn(calc.link, 'Immobilienvergleich ansehen →', '#2f6b4f', '#ffffff')
      + `</div>`
    : ''
  const sign = `<p style="margin:24px 0 0">${esc(m.signoff || 'Bis bald,')}<br><strong>${esc(m.signName || 'Sven · Happy Property Cyprus')}</strong></p>`
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:#2b2b2b;max-width:600px;margin:0 auto">`
    + greeting + intro
    + `<div style="margin:24px 0">${cards}</div>`
    + reco + calcBlock + cta + sign
    + `</div>`
}

// Schlanker, aber vollständiger Fallback (mit CTA), falls Claude/Key mal nicht greift.
function fallback(firstName: string, items: MailItem[], calc?: { link: string; label: string } | null): { subject: string; html: string } {
  const m = {
    greeting: `Hallo ${firstName || 'zusammen'},`,
    body_paragraphs: ['wie besprochen habe ich dir deine persönlichen Wohnungs-Vorschläge zusammengestellt. Schau sie dir in Ruhe an — ich bin gespannt, welches dich am meisten anspricht.'],
    deck_lines: items.map(() => ''),
    recommendation: '',
    cta_paragraph: 'Wenn du tiefer einsteigen willst, buch dir einfach einen neuen Termin — oder gib mir kurz per WhatsApp oder E-Mail Bescheid, was dir gefällt.',
    signoff: 'Bis bald,',
    signName: 'Sven · Happy Property Cyprus',
  }
  const subject = items.length > 1 ? 'Deine Wohnungs-Vorschläge von Happy Property' : `Dein Vorschlag: ${items[0]?.label ?? ''}`.trim()
  return { subject, html: buildHtml(m, items, calc) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const body = await req.json() as {
      recipient_name?: string; first_name?: string; briefing?: string; angle?: string
      items?: MailItem[]; calc_link?: string; calc_label?: string
    }
    const items = (body.items ?? []).filter(it => it && it.link)
    if (!items.length) return json({ error: 'items fehlt' }, 400)
    const firstName = body.first_name?.trim() || (body.recipient_name?.trim().split(' ')[0] ?? '')
    const calc = body.calc_link ? { link: body.calc_link, label: body.calc_label ?? '' } : null

    if (!ANTHROPIC_API_KEY) return json(fallback(firstName, items, calc))

    // GELERNTE VORGABEN: Stil-Regeln, die das System aus Svens Mail-Korrekturen gelernt hat
    // (deck_ai_rules kind='mail'). Fließen in JEDE neue Mail → wird über die Zeit besser.
    let learnedBlock = ''
    try {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: rules } = await supabase.from('deck_ai_rules').select('rule').eq('kind', 'mail').eq('active', true).is('project_id', null)
      const txt = (rules ?? []).map((r: { rule: string }) => `- ${r.rule}`).join('\n')
      if (txt) learnedBlock = `GELERNTE VORGABEN (aus Svens früheren Korrekturen — IMMER beachten):\n${txt}\n\n`
    } catch { /* Regeln optional */ }

    const angle = body.angle === 'investment' ? 'investment' : 'lifestyle'
    const userMsg = learnedBlock + [
      `KUNDE: ${body.recipient_name?.trim() || firstName || 'der Kunde'}`,
      `WINKEL: ${angle} (${angle === 'investment' ? 'Rendite, Vermietung, Wertentwicklung' : 'Wohnen, Lebensgefühl, selbst nutzen'})`,
      ``,
      `KUNDEN-BRIEFING (Svens Notizen — Grundlage fürs Anschreiben + Empfehlung):`,
      body.briefing?.trim() || '(kein Briefing — halte die Mail allgemein, aber persönlich und überzeugend)',
      ``,
      `DIESE OBJEKTE HAST DU FÜR IHN ZUSAMMENGESTELLT (Reihenfolge = Reihenfolge der deck_lines):`,
      ``,
      ...items.map((it, i) => itemBrief(it, i)),
    ].join('\n')

    const reqBody = JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 3000,
      system:     SYSTEM,
      tools: [{
        name:        'emit_mail',
        description: 'Gibt die fertige, verkaufsorientierte Begleit-Mail in Bausteinen zurück.',
        input_schema: {
          type: 'object',
          properties: {
            subject:            { type: 'string' },
            greeting:           { type: 'string' },
            body_paragraphs:    { type: 'array', items: { type: 'string' } },
            deck_lines:         { type: 'array', items: { type: 'string' } },
            recommendation:     { type: 'string' },
            cta_paragraph:      { type: 'string' },
            signoff:            { type: 'string' },
            signName:           { type: 'string' },
          },
          required: ['subject', 'greeting', 'body_paragraphs', 'deck_lines', 'cta_paragraph', 'signoff', 'signName'],
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
    if (!res.ok) return json(fallback(firstName, items))

    const data = await res.json() as { content?: Array<{ type?: string; input?: Record<string, unknown> }> }
    const tu = (data.content ?? []).find(c => c.type === 'tool_use')
    const m = (tu?.input ?? null) as null | {
      subject?: string; greeting?: string; body_paragraphs?: string[]; deck_lines?: string[]
      recommendation?: string; cta_paragraph?: string; signoff?: string; signName?: string
    }
    if (!m || !m.subject) return json(fallback(firstName, items, calc))

    return json({ subject: m.subject, html: buildHtml(m, items, calc) })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
