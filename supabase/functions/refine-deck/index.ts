// Supabase Edge Function: refine-deck
// Feinschliff eines bestehenden Decks per Freitext-Anweisung (Claude bearbeitet die
// Block-Liste in-place). Nutzt gelernte Vorgaben (deck_ai_rules), die in JEDES Deck
// einfließen. Undo via sales_decks.prev_content. Optional 'learn' → Anweisung als Regel.
//
// Body: { token, instruction, learn?, action?: 'refine'|'undo', background? }
// background:true → sofortige Antwort, Claude-Arbeit läuft detached (EdgeRuntime.waitUntil);
// Status über sales_decks.refining (true während Lauf) + revision (++ bei Fertig) + refine_error.
import { createClient } from 'jsr:@supabase/supabase-js@2'

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SYSTEM = `Du bist ein hochpräziser Redakteur für ein bestehendes Sales-Deck (geordnete Block-Liste) von Happy Property Cyprus. Du führst die ANWEISUNG des Nutzers aus und gibst über das Tool emit_deck die KOMPLETTE Block-Liste zurück.

OBERSTES PRINZIP — CHIRURGISCH ARBEITEN (das ist die wichtigste Regel):
- Ändere AUSSCHLIESSLICH das, was die Anweisung ausdrücklich verlangt. Jeder andere Block und jedes nicht betroffene Feld wird 1:1 UNVERÄNDERT zurückgegeben — Wort für Wort, gleiche Zeichensetzung, gleiche Reihenfolge, gleiche Bilder.
- „Verbessere", glätte, straffe oder formuliere NICHTS um, was nicht ausdrücklich beanstandet wurde. Kein eigenmächtiges Umschreiben, kein „schöner machen". Wenn unklar ist, ob etwas gemeint ist: NICHT anfassen.
- Betrifft die Anweisung nur einen Block oder ein Feld, bleibt der komplette Rest des Decks exakt identisch (byte-genau). Der Nutzer erwartet, dass sich NUR das Angesprochene ändert.
- Erfinde keine neuen Aussagen — keine Historie („schon immer", „wie besprochen" nur wenn wahr), keine Zahlen, keine Zusagen, die nicht in der Anweisung oder im bestehenden Deck stehen.

Wenn die Anweisung eine UMFORMULIERUNG/Kürzung verlangt: bearbeite NUR den genannten Teil, im vorhandenen Ton (Sven, du-Form, sachlich, hochwertig; keine Werbe-Floskeln, keine erfundene Nähe zum Kunden).

WAHRHEIT & KONSISTENZ (immer, auch ungefragt beibehalten):
- Keine garantierten Renditen/Mieten; keine erfundenen Käufer-Schutz- oder Zahlungs-Narrative.
- Steuer nur sachlich: DBA-Anrechnungsmethode; 5 % degressive AfA für EU-Immobilien senkt das in Deutschland zu versteuernde Vermietungsergebnis. NIEMALS behaupten, Zyperns niedrigere Steuersätze seien der Vorteil.
- Preis und Fließtext müssen konsistent bleiben (ist ein Möbelpaket im Preis, muss es auch im Text stehen — und umgekehrt).

Technik:
- Block-Typen + Felder beibehalten: cover/letter/unit/facts/columns/feature/gallery/benefits/inventory/floorplan/payment/cta. Beginne mit cover, dann letter; ende mit cta.
- Bilder NUR aus der Liste VERFÜGBARE BILDER setzen (Feld image bzw. items[].image = eine dieser URLs). Keine erfundenen URLs. Der Lage/facts-Block: image = das Kartenbild (map), mapUrl = der Google-Maps-Link.
- KRITISCH: in ALLEN Texten NIEMALS doppelte Anführungszeichen — nutze 'einfache' oder keine.
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
    const { token, instruction, learn, action, background } = await req.json() as { token?: string; instruction?: string; learn?: boolean; action?: string; background?: boolean }
    if (!token) return json({ error: 'token fehlt' }, 400)
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: deck } = await supabase.from('sales_decks').select('content, prev_content, project_id, revision').eq('token', token).maybeSingle()
    if (!deck) return json({ error: 'Deck nicht gefunden' }, 404)

    // ── Undo (immer synchron — schnell, kein Claude-Call) ──
    if (action === 'undo') {
      if (!deck.prev_content) return json({ error: 'Kein Schritt zum Rückgängigmachen' }, 400)
      await supabase.from('sales_decks').update({ content: deck.prev_content, prev_content: null }).eq('token', token)
      return json({ ok: true, undone: true })
    }

    if (!instruction?.trim()) return json({ error: 'instruction fehlt' }, 400)
    if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY nicht gesetzt' }, 503)

    // Die eigentliche KI-Arbeit (langsam, ~16k Tokens) — als Closure, damit sie
    // wahlweise synchron oder im Hintergrund (waitUntil) laufen kann.
    const runRefine = async (): Promise<{ blocks?: number; error?: string }> => {
      try {
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
          `ANWEISUNG DES NUTZERS:`, instruction!.trim(),
        ].join('\n')

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-opus-4-8', max_tokens: 16000, system: SYSTEM,
            tools: [{ name: 'emit_deck', description: 'Gibt die komplette, geänderte Block-Liste zurück.', input_schema: { type: 'object', properties: { blocks: { type: 'array', items: BLOCK_ITEM } }, required: ['blocks'] } }],
            tool_choice: { type: 'tool', name: 'emit_deck' },
            messages: [{ role: 'user', content: userMsg }],
          }),
        })
        const data = await res.json() as { content?: Array<{ type: string; input?: { blocks?: unknown[] } }>; error?: { message?: string } }
        if (data.error) throw new Error(`Claude: ${data.error.message}`)
        const tool = (data.content ?? []).find(c => c.type === 'tool_use')
        const newBlocks = tool?.input?.blocks
        if (!Array.isArray(newBlocks) || !newBlocks.length || !newBlocks.every(b => b && typeof (b as { type?: string }).type === 'string')) {
          throw new Error('KI lieferte keine gültige Block-Liste')
        }
        // Fertig: Content tauschen, revision hochzählen (Farbwechsel im CRM), refining aus.
        await supabase.from('sales_decks').update({
          prev_content: deck.content, content: { blocks: newBlocks },
          revision: ((deck.revision as number) ?? 0) + 1, refining: false, refine_error: null,
        }).eq('token', token)
        if (learn && instruction!.trim()) {
          // Korrektur auf das PROJEKT dieses Decks scopen — eine Deck-Chat-Korrektur betrifft
          // fast immer nur dieses Projekt. Sonst landet jede Korrektur global und verseucht
          // ALLE Decks (widersprüchliche Vorgaben). Nur ohne Projekt-Bezug → global.
          await supabase.from('deck_ai_rules').insert({
            kind: 'deck',
            scope: deck.project_id ? 'project' : 'global',
            project_id: deck.project_id ?? null,
            rule: instruction!.trim(),
          })
        }
        return { blocks: newBlocks.length }
      } catch (e) {
        // Fehler festhalten + refining lösen, damit das CRM den Spinner beendet + Fehler zeigt.
        await supabase.from('sales_decks').update({ refining: false, refine_error: (e as Error).message }).eq('token', token)
        return { error: (e as Error).message }
      }
    }

    // ── Hintergrund: sofort antworten, Arbeit detached ──
    if (background) {
      await supabase.from('sales_decks').update({ refining: true, refine_error: null }).eq('token', token)
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(runRefine())
      else void runRefine()
      return json({ ok: true, background: true })
    }

    // ── Synchron (Fallback/kurze Calls) ──
    const out = await runRefine()
    if (out.error) return json({ error: out.error }, 502)
    return json({ ok: true, blocks: out.blocks, learned: !!learn })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
