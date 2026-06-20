// Supabase Edge Function: refine-deck
// Feinschliff eines bestehenden Decks per Freitext-Anweisung (Claude bearbeitet die
// Block-Liste in-place). Nutzt gelernte Vorgaben (deck_ai_rules), die in JEDES Deck
// einfließen. Undo via sales_decks.prev_content. Optional 'learn' → Anweisung als Regel.
//
// Body: { token, instruction, learn?, action?: 'refine'|'undo' }
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SYSTEM = `Du bearbeitest ein bestehendes Sales-Deck (geordnete Block-Liste) von Happy Property Cyprus.
Wende die ANWEISUNG des Nutzers an und gib über das Tool emit_deck die KOMPLETTE, geänderte Block-Liste zurück.

Grundsätze:
- Ändere NUR, was die Anweisung verlangt; alles andere unverändert übernehmen (gleiche Reihenfolge, gleiche Texte/Bilder).
- Du darfst: Blöcke umsortieren, Texte umformulieren/kürzen, Bilder tauschen, Blöcke hinzufügen/entfernen.
- Bilder NUR aus der Liste VERFÜGBARE BILDER setzen (Feld image bzw. items[].image = eine dieser URLs). Keine erfundenen URLs.
- Der Lage/facts-Block: image = das Kartenbild (map), mapUrl = der Google-Maps-Link.
- Block-Typen + Felder beibehalten: cover/letter/unit/facts/columns/feature/gallery/benefits/inventory/floorplan/payment/cta.
- KRITISCH: in ALLEN Texten NIEMALS doppelte Anführungszeichen — nutze 'einfache' oder keine.
- Beginne mit cover, dann letter; ende mit cta.
- Beachte die GELERNTEN VORGABEN immer.`

const BLOCK_ITEM = {
  type: 'object',
  properties: {
    type: { type: 'string' }, kicker: { type: 'string' }, title: { type: 'string' }, tagline: { type: 'string' },
    forLine: { type: 'string' }, headline: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } },
    signoff: { type: 'string' }, signName: { type: 'string' }, number: { type: 'string' }, nickname: { type: 'string' },
    specs: { type: 'array', items: { type: 'string' } }, priceMain: { type: 'string' }, priceSub: { type: 'string' },
    note: { type: 'string' }, text: { type: 'string' }, quote: { type: 'string' }, intro: { type: 'string' },
    image: { type: 'string' }, mapUrl: { type: 'string' }, mapLabel: { type: 'string' },
    items: { type: 'array', items: { type: 'object' } }, cols: { type: 'array', items: { type: 'object' } },
    cards: { type: 'array', items: { type: 'object' } }, groups: { type: 'array', items: { type: 'object' } },
    stats: { type: 'array', items: { type: 'object' } }, bullets: { type: 'array', items: { type: 'object' } },
    steps: { type: 'array', items: { type: 'object' } }, phase1: { type: 'object' }, phase2: { type: 'object' },
  },
  required: ['type'],
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const { token, instruction, learn, action } = await req.json() as { token?: string; instruction?: string; learn?: boolean; action?: string }
    if (!token) return json({ error: 'token fehlt' }, 400)
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: deck } = await supabase.from('sales_decks').select('content, prev_content, project_id').eq('token', token).maybeSingle()
    if (!deck) return json({ error: 'Deck nicht gefunden' }, 404)

    // ── Undo ──
    if (action === 'undo') {
      if (!deck.prev_content) return json({ error: 'Kein Schritt zum Rückgängigmachen' }, 400)
      await supabase.from('sales_decks').update({ content: deck.prev_content, prev_content: null }).eq('token', token)
      return json({ ok: true, undone: true })
    }

    if (!instruction?.trim()) return json({ error: 'instruction fehlt' }, 400)
    if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY nicht gesetzt' }, 503)

    const blocks = (deck.content?.blocks) ?? deck.content ?? []

    // Verfügbare Bilder aus den Projekt-Assets (für Bild-Tausch)
    let assetsTxt = '(keine Projekt-Assets verfügbar)'
    if (deck.project_id) {
      const { data: pr } = await supabase.from('crm_projects').select('deck_assets').eq('id', deck.project_id).maybeSingle()
      const da = (pr?.deck_assets ?? {}) as { renders?: string[]; gallery?: Array<{ url: string; label?: string; category?: string }>; map?: string; mapUrl?: string; floorplans?: Array<{ url: string; label?: string }> }
      assetsTxt = JSON.stringify({
        renders: da.renders ?? [],
        gallery: (da.gallery ?? []).map(g => ({ url: g.url, was: g.label || g.category || '' })),
        map: da.map ?? null, mapUrl: da.mapUrl ?? null,
        floorplans: (da.floorplans ?? []).map(f => ({ url: f.url, was: f.label || '' })),
      })
    }

    // Gelernte Vorgaben (kind='deck'): global immer + projektspezifische dieses Decks
    let rulesQ = supabase.from('deck_ai_rules').select('rule').eq('active', true).eq('kind', 'deck')
    rulesQ = deck.project_id ? rulesQ.or(`project_id.is.null,project_id.eq.${deck.project_id}`) : rulesQ.is('project_id', null)
    const { data: rules } = await rulesQ
    const rulesTxt = (rules ?? []).map((r: { rule: string }) => `- ${r.rule}`).join('\n') || '(noch keine)'

    const userMsg = [
      `GELERNTE VORGABEN (immer beachten):`, rulesTxt, ``,
      `VERFÜGBARE BILDER (nur diese URLs für Bilder verwenden):`, assetsTxt, ``,
      `AKTUELLES DECK (Block-Liste als JSON):`, JSON.stringify(blocks), ``,
      `ANWEISUNG DES NUTZERS:`, instruction.trim(),
    ].join('\n')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 16000, system: SYSTEM,
        tools: [{ name: 'emit_deck', description: 'Gibt die komplette, geänderte Block-Liste zurück.', input_schema: { type: 'object', properties: { blocks: { type: 'array', items: BLOCK_ITEM } }, required: ['blocks'] } }],
        tool_choice: { type: 'tool', name: 'emit_deck' },
        messages: [{ role: 'user', content: userMsg }],
      }),
    })
    const data = await res.json() as { content?: Array<{ type: string; input?: { blocks?: unknown[] } }>; error?: { message?: string } }
    if (data.error) return json({ error: `Claude: ${data.error.message}` }, 502)
    const tool = (data.content ?? []).find(c => c.type === 'tool_use')
    const newBlocks = tool?.input?.blocks
    if (!Array.isArray(newBlocks) || !newBlocks.length || !newBlocks.every(b => b && typeof (b as { type?: string }).type === 'string')) {
      return json({ error: 'KI lieferte keine gültige Block-Liste' }, 502)
    }

    await supabase.from('sales_decks').update({ prev_content: deck.content, content: { blocks: newBlocks } }).eq('token', token)
    if (learn && instruction.trim()) {
      await supabase.from('deck_ai_rules').insert({ kind: 'deck', scope: 'global', rule: instruction.trim() })
    }
    return json({ ok: true, blocks: newBlocks.length, learned: !!learn })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
