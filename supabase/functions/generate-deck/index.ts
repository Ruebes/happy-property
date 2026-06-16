// Supabase Edge Function: generate-deck
// Schreibt aus Fakten + Kunden-Briefing ein personalisiertes Sales-Deck (Claude)
// und legt es als sales_decks-Zeile an. Gibt token + url zurück.
//
// Body: { recipient_name, angle, briefing, facts, month_label?,
//         lead_id?, deal_id?, project_id?, unit_id?, batch_id?, created_by? }
// Bilder werden NICHT hier gesetzt — die hängt der Import/Generator später an die
// Bild-Slots (Stufe 1: Platzhalter zum Beurteilen der Texte/Struktur).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM = `Du bist der Deck-Texter von Happy Property Cyprus — einer Brokerage für deutschsprachige Kapitalanleger, die Immobilien auf Zypern (Paphos) kaufen.

Du schreibst ein PERSÖNLICHES, hochwertiges Verkaufs-Deck für genau EINEN Kunden und EIN Apartment. Stil: editorial, warm, „du"-Form, sinnlich und konkret, kurze prägnante Schlagzeilen (wie ein Magazin), kein Werbe-Blabla. Deutsch.

Du rufst das Tool emit_deck auf — Feld "blocks" = die geordnete Liste der Deck-Blöcke.

Jeder Block hat ein "type" und passende Felder. Verfügbare Block-Typen (Bilder NICHT setzen — die werden später eingehängt):

- cover:    { type, kicker, title, tagline, forLine }   // forLine = "Für <Name> — <Monat Jahr>"
- letter:   { type, kicker, headline, paragraphs:[string], signoff, signName }  // das persönliche Anschreiben
- unit:     { type, kicker, number, nickname, specs:[string], priceMain, priceSub, note }
- facts:    { type, kicker, headline, items:[{min,label}] }   // Lage/Entfernungen, min z.B. "5 min"
- columns:  { type, kicker, headline, cols:[{title,sub,text}] } // 3 Spalten (Terrassen, „ein Tag", o.ä.)
- feature:  { type, kicker, headline, text, quote }    // ein Highlight (Pool, Dachterrasse…)
- gallery:  { type, kicker, headline, items:[{title,caption}], note }
- benefits: { type, kicker, headline, cards:[{icon,title,text}] }  // icon = ein Emoji
- floorplan:{ type, kicker, headline, stats:[{value,unit,label}], bullets:[{strong,text}] }
- payment:  { type, kicker, headline, intro, phase1:{label,title,rows:[{label,sub,value}],sumLabel,sumValue}, phase2:{label,title,rows:[{label,sub,value}],advantage}, note }
- cta:      { type, kicker, headline, text, steps:[{n,title,text}] }  // n = "01"/"02"/"03"

REGELN:
1. Beginne IMMER mit "cover", dann "letter". Ende IMMER mit "cta".
2. Das "letter"-Anschreiben nimmt das Kunden-Briefing direkt auf (Situation, Motiv, Wünsche) — persönlich, als käme es von Sven. signoff "Bis bald, Sven", signName "Sven · Happy Property Cyprus".
3. Webe das Briefing auch in andere Blöcke ein, WO es inhaltlich passt (z.B. Investor → betone Vermietung/ROI/Zahlungsplan; will selbst herziehen → Lifestyle/„ein Tag"/Terrassen; Sonnenuntergang → West-Terrasse/Feature). Nicht erzwingen.
4. Wähle 9–13 Blöcke passend zum Winkel (angle): "lifestyle" = Erlebnis/Terrassen/„ein Tag"/Pool; "investment" = ROI/Vermietung/Zahlungsplan/Wertsteigerung. Mische sinnvoll.
5. Nutze NUR Fakten aus dem Input. Erfinde KEINE Zahlen/Preise/Entfernungen. Wenn ein Faktum fehlt, lass den Block/das Feld weg statt zu raten.
6. Preise/Beträge exakt aus den Fakten übernehmen (Format wie gegeben).`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Platzhalter-Bilder in die Bild-Slots hängen (Stufe 1). Stufe 2 ersetzt durch Drive-Bilder.
function injectPlaceholderImages(blocks: Array<Record<string, unknown>>): void {
  let n = 0
  const img = () => `https://picsum.photos/seed/deck${++n}/1600/1000`
  for (const b of blocks) {
    const t = b.type
    if (t === 'cover' || t === 'unit' || t === 'facts' || t === 'columns' || t === 'feature' || t === 'floorplan') {
      if (!b.image) b.image = img()
    }
    if (t === 'gallery' && Array.isArray(b.items)) {
      for (const it of b.items as Array<Record<string, unknown>>) if (!it.image) it.image = img()
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)

  try {
    const body = await req.json() as {
      recipient_name?: string; angle?: string; briefing?: string; facts?: string
      month_label?: string
      lead_id?: string; deal_id?: string; project_id?: string; unit_id?: string; batch_id?: string; created_by?: string
    }
    const recipient = body.recipient_name?.trim() || 'den Kunden'
    const angle     = body.angle || 'lifestyle'
    if (!body.facts?.trim()) return json({ error: 'facts fehlt' }, 400)

    const userMsg = [
      `KUNDE: ${recipient}`,
      `MONAT: ${body.month_label || ''}`,
      `WINKEL (angle): ${angle}`,
      ``,
      `KUNDEN-BRIEFING (für Anschreiben + passende Stellen einweben):`,
      body.briefing?.trim() || '(kein Briefing — halte das Anschreiben allgemein, aber persönlich)',
      ``,
      `FAKTEN ZUM PROJEKT & APARTMENT (nur diese verwenden):`,
      body.facts.trim(),
    ].join('\n')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:       'claude-sonnet-4-6',
        max_tokens:  16000,
        system:      SYSTEM,
        tools:       [{
          name:        'emit_deck',
          description: 'Gibt das fertige, personalisierte Sales-Deck als geordnete Block-Liste zurück.',
          input_schema: {
            type: 'object',
            properties: { blocks: { type: 'array', items: { type: 'object' } } },
            required: ['blocks'],
          },
        }],
        tool_choice: { type: 'tool', name: 'emit_deck' },
        messages:    [{ role: 'user', content: userMsg }],
      }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return json({ error: `Anthropic ${res.status}: ${e.error?.message ?? res.statusText}` }, 502)
    }
    const data = await res.json() as {
      content?: Array<{ type?: string; input?: { blocks?: Array<Record<string, unknown>> } }>
      stop_reason?: string
    }
    const tu = (data.content ?? []).find(c => c.type === 'tool_use')
    const blocks = tu?.input?.blocks ?? []
    if (blocks.length === 0) return json({ error: 'Keine Blöcke generiert', stop_reason: data.stop_reason }, 502)
    injectPlaceholderImages(blocks)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: row, error } = await supabase.from('sales_decks').insert({
      recipient_name: body.recipient_name ?? null,
      angle,
      status:     'ready',
      content:    { blocks },
      lead_id:    body.lead_id ?? null,
      deal_id:    body.deal_id ?? null,
      project_id: body.project_id ?? null,
      unit_id:    body.unit_id ?? null,
      batch_id:   body.batch_id ?? null,
      created_by: body.created_by ?? null,
    }).select('token').single()
    if (error) return json({ error: `DB: ${error.message}` }, 500)

    const token = (row as { token: string }).token
    return json({ ok: true, token, url: `/deck/${token}`, blocks: blocks.length })

  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
