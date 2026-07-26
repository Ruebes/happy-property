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

const SYSTEM = `Du bist ein hochpräziser Redakteur für ein bestehendes Sales-Deck (geordnete, INDIZIERTE Block-Liste, Index ab 0) von Happy Property Cyprus. Du führst die ANWEISUNG des Nutzers aus und gibst über das Tool emit_edits NUR die ÄNDERUNGEN zurück — NIEMALS das ganze Deck.

OBERSTES PRINZIP — NUR DAS GEÄNDERTE AUSGEBEN (wichtigste Regel):
- Gib in \`edits\` NUR die Blöcke zurück, die sich durch die Anweisung TATSÄCHLICH ändern — je mit ihrem \`index\` (Position im aktuellen Deck) und dem KOMPLETTEN neuen Block-Objekt. Alle anderen Blöcke übernimmt das System automatisch 1:1 unverändert — du darfst sie NICHT ausgeben.
- An einem geänderten Block änderst du AUSSCHLIESSLICH die Felder, die die Anweisung verlangt; alle übrigen Felder dieses Blocks übernimmst du WORTGLEICH aus dem aktuellen Block (gleiche Bilder, gleiche URLs, gleiche Zeichensetzung).
- „Verbessere"/glätte/straffe/formuliere NICHTS um, was nicht ausdrücklich beanstandet wurde. Im Zweifel: den Block NICHT in \`edits\` aufnehmen. Wenn die Anweisung nichts Konkretes ändert, gib leere \`edits\` zurück.
- Strukturänderungen NUR wenn verlangt: \`remove\` = Indizes zu löschender Blöcke; \`insertAfter\` = neue Blöcke nach einem Index; \`append\` = neue Blöcke am Ende.
- \`summary\`: EIN kurzer Satz, was du geändert hast (für die Anzeige an den Nutzer).
- Erfinde keine neuen Aussagen — keine Historie, keine Zahlen, keine Zusagen, die nicht in der Anweisung oder im bestehenden Deck stehen.

WAHRHEIT & KONSISTENZ (immer beibehalten):
- Keine garantierten Renditen/Mieten; keine erfundenen Käufer-Schutz- oder Zahlungs-Narrative.
- Steuer nur sachlich: DBA-Anrechnungsmethode; 5 % degressive AfA für EU-Immobilien senkt das in Deutschland zu versteuernde Vermietungsergebnis. NIEMALS behaupten, Zyperns niedrigere Steuersätze seien der Vorteil.
- Preis und Fließtext müssen konsistent bleiben (ist ein Möbelpaket im Preis, muss es auch im Text stehen — und umgekehrt).

Technik:
- Bilder/Videos NUR aus der Liste VERFÜGBARE BILDER oder aus den bereits im Deck vorhandenen URLs. Erfinde NIEMALS eine URL — das System bricht sonst hart ab. embedUrl/videoUrl/poster/mapUrl unverändert lassen, außer die Anweisung verlangt ausdrücklich einen Tausch (dann eine erlaubte URL).
- Block-Typen beibehalten (cover/letter/unit/facts/columns/feature/gallery/benefits/inventory/floorplan/payment/cta/video/marina).
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
    embedUrl: { type: 'string' }, videoUrl: { type: 'string' }, poster: { type: 'string' }, caption: { type: 'string' },
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
    const runRefine = async (): Promise<{ blocks?: number; summary?: string; error?: string }> => {
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
          `AKTUELLES DECK (indizierte Block-Liste als JSON, Index = Position ab 0):`, JSON.stringify(blocks), ``,
          `ANWEISUNG DES NUTZERS:`, instruction!.trim(),
        ].join('\n')

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-opus-4-8', max_tokens: 16000, system: SYSTEM,
            tools: [{ name: 'emit_edits', description: 'Gibt NUR die geänderten Blöcke (mit Index) + optionale Struktur-Operationen zurück. Unveränderte Blöcke NICHT ausgeben.', input_schema: { type: 'object', properties: {
              edits: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, block: BLOCK_ITEM }, required: ['index', 'block'] } },
              remove: { type: 'array', items: { type: 'integer' } },
              insertAfter: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, block: BLOCK_ITEM }, required: ['index', 'block'] } },
              append: { type: 'array', items: BLOCK_ITEM },
              summary: { type: 'string' },
            }, required: [] } }],
            tool_choice: { type: 'tool', name: 'emit_edits' },
            messages: [{ role: 'user', content: userMsg }],
          }),
        })
        type Blk = Record<string, unknown>
        const data = await res.json() as { content?: Array<{ type: string; input?: unknown }>; error?: { message?: string } }
        if (data.error) throw new Error(`Claude: ${data.error.message}`)
        const patch = (data.content ?? []).find(c => c.type === 'tool_use')?.input as {
          edits?: Array<{ index: number; block: Blk }>; remove?: number[]
          insertAfter?: Array<{ index: number; block: Blk }>; append?: Blk[]; summary?: string
        } | undefined
        if (!patch) throw new Error('KI lieferte keine Änderungen')
        const edits = patch.edits ?? [], insAfter = patch.insertAfter ?? [], append = patch.append ?? [], remove = patch.remove ?? []
        if (!edits.length && !insAfter.length && !append.length && !remove.length) {
          throw new Error('Keine Änderung erkannt — bitte die Anweisung präziser formulieren.')
        }
        // Jeder neu/geänderte Block braucht einen type-String.
        const changed = [...edits.map(e => e.block), ...insAfter.map(x => x.block), ...append]
        if (!changed.every(b => b && typeof (b as { type?: string }).type === 'string')) throw new Error('KI lieferte einen ungültigen Block')
        // VERIFIKATION: keine erfundenen URLs. Jede URL in einem geänderten Block muss
        // schon im alten Deck oder in den Projekt-Assets vorkommen — sonst harter Abbruch.
        const urlRe = /https?:\/\/[^\s"'<>)\]]+/g
        const allowed = new Set<string>([...(JSON.stringify(blocks).match(urlRe) ?? []), ...(assetsTxt.match(urlRe) ?? [])])
        for (const b of changed) for (const u of (JSON.stringify(b).match(urlRe) ?? [])) {
          if (!allowed.has(u)) throw new Error(`KI hat eine unbekannte Bild-/Video-URL verwendet (abgebrochen): ${u.slice(0, 90)}`)
        }
        // MERGE: unbeteiligte Blöcke bleiben BYTE-IDENTISCH (aus dem alten Content).
        const oldBlocks = blocks as Blk[]
        const removeSet = new Set(remove.filter(Number.isInteger))
        const editMap = new Map<number, Blk>(); for (const e of edits) if (Number.isInteger(e.index)) editMap.set(e.index, e.block)
        const insMap = new Map<number, Blk[]>(); for (const ia of insAfter) { if (!Number.isInteger(ia.index)) continue; const a = insMap.get(ia.index) ?? []; a.push(ia.block); insMap.set(ia.index, a) }
        const newBlocks: Blk[] = []
        for (let i = 0; i < oldBlocks.length; i++) {
          if (removeSet.has(i)) continue
          newBlocks.push(editMap.has(i) ? editMap.get(i)! : oldBlocks[i])
          if (insMap.has(i)) newBlocks.push(...insMap.get(i)!)
        }
        for (const b of append) newBlocks.push(b)
        if (!newBlocks.length) throw new Error('Ergebnis wäre leer — abgebrochen')
        // Marina-Sicherheitsnetz: falls die Marina-Sektion versehentlich entfernt wurde
        // (nur bei Struktur-Ops möglich) und die Anweisung nicht um die Marina geht → zurückholen.
        if (!/marina/i.test(instruction!)) {
          const isMarinaFeature = (b: Blk) => b.type !== 'marina' && /paphos-marina|marina/i.test(String(b.kicker ?? '') + ' ' + String(b.headline ?? ''))
          const anchor = () => { const fi = newBlocks.findIndex(b => b.type === 'facts'); return fi >= 0 ? fi + 1 : Math.max(newBlocks.length - 1, 0) }
          if (!newBlocks.some(isMarinaFeature)) { const f = oldBlocks.find(isMarinaFeature); if (f) newBlocks.splice(anchor(), 0, f) }
          if (!newBlocks.some(b => b.type === 'marina')) { const s = oldBlocks.find(b => b.type === 'marina'); if (s) newBlocks.splice(anchor(), 0, s) }
        }
        // Fertig: Content tauschen, revision hochzählen (Farbwechsel im CRM), refining aus.
        await supabase.from('sales_decks').update({
          prev_content: deck.content, content: { blocks: newBlocks },
          revision: ((deck.revision as number) ?? 0) + 1, refining: false, refine_error: null,
          // Natürlichsprachige Antwort für das Chat-Fenster (was wurde geändert).
          refine_summary: patch.summary ?? null,
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
        return { blocks: newBlocks.length, summary: patch.summary }
      } catch (e) {
        // Fehler festhalten + refining lösen, damit das CRM den Spinner beendet + Fehler zeigt.
        await supabase.from('sales_decks').update({ refining: false, refine_error: (e as Error).message }).eq('token', token)
        return { error: (e as Error).message }
      }
    }

    // ── Hintergrund: sofort antworten, Arbeit detached ──
    if (background) {
      // refine_summary vor dem Lauf leeren, damit der Chat nicht die vorige Antwort liest.
      await supabase.from('sales_decks').update({ refining: true, refine_error: null, refine_summary: null }).eq('token', token)
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(runRefine())
      else void runRefine()
      return json({ ok: true, background: true })
    }

    // ── Synchron (Fallback/kurze Calls) ──
    const out = await runRefine()
    if (out.error) return json({ error: out.error }, 502)
    return json({ ok: true, blocks: out.blocks, summary: out.summary, learned: !!learn })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
