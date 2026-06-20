// Supabase Edge Function: learn-mail
// Vergleicht die ORIGINAL-Begleit-Mail (KI-Entwurf) mit Svens BEARBEITETER Version und
// destilliert daraus VERALLGEMEINERBARE Stil-/Inhalts-Vorgaben für KÜNFTIGE Mails.
// Speichert sie in deck_ai_rules (kind='mail') → compose-deck-mail liest sie und wird
// über die Zeit besser. Einmalige Sachen (Namen, Fakten, Tippfehler) werden ignoriert.
//
// Body: { before, after, save?=true }
// Antwort: { ok, rules: [string] }  (gespeichert, wenn save !== false und etwas Generalisierbares da war)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const stripHtml = (s: string) => s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const SYSTEM = `Du beobachtest, wie Sven von Happy Property Cyprus die KI-Entwürfe seiner Verkaufs-Begleit-Mails von Hand nachbessert, und lernst seinen Stil.

Du bekommst die ORIGINAL-Mail (KI-Entwurf) und Svens BEARBEITETE Fassung. Leite daraus VERALLGEMEINERBARE Vorgaben ab, die KÜNFTIGE Mails von Anfang an richtig machen sollen — als kurze, klare Anweisungen in der DU-Form an die schreibende KI.

Worauf achten (nur was sich WIEDERHOLEN lässt):
- Tonfall/Ansprache (lockerer/förmlicher, kürzer/ausführlicher, mehr/weniger Emojis)
- Struktur (Reihenfolge, Länge, Betreff-Stil, Grußformel/Signatur)
- Inhaltliche Vorlieben (was immer rein/raus soll — z.B. konkrete Zahlen, Knappheit, bestimmte Formulierungen, kein bestimmtes Wort)
- Standard-Wendungen, die Sven offensichtlich bevorzugt

IGNORIEREN (NICHT als Regel ausgeben):
- Einmalige Fakten, Namen, Preise, kunden-/objektspezifische Inhalte
- Reine Tippfehler-/Grammatik-Korrekturen ohne Stil-Aussage
- Änderungen, die nur für genau diese eine Mail gelten

Gib 0 bis 3 Regeln aus. Wenn die Änderung KEINE verallgemeinerbare Vorliebe zeigt (nur Tippfehler/Einmaliges), gib ein LEERES Array zurück. Lieber nichts als eine schlechte Regel. Jede Regel ein knapper Satz.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const body = await req.json() as { before?: string; after?: string; save?: boolean }
    const before = stripHtml(body.before ?? '').slice(0, 6000)
    const after  = stripHtml(body.after ?? '').slice(0, 6000)
    if (!before || !after) return json({ error: 'before/after fehlt' }, 400)
    if (before === after) return json({ ok: true, rules: [], note: 'keine Änderung' })
    if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY nicht gesetzt' }, 503)

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1000, system: SYSTEM,
        tools: [{ name: 'emit_rules', description: 'Verallgemeinerbare Stil-Regeln für künftige Mails.', input_schema: { type: 'object', properties: { rules: { type: 'array', items: { type: 'string' } } }, required: ['rules'] } }],
        tool_choice: { type: 'tool', name: 'emit_rules' },
        messages: [{ role: 'user', content: `ORIGINAL (KI-Entwurf):\n${before}\n\n---\n\nSVENS BEARBEITETE FASSUNG:\n${after}` }],
      }),
    })
    const data = await res.json() as { content?: Array<{ type: string; input?: { rules?: unknown } }>; error?: { message?: string } }
    if (data.error) return json({ error: `Claude: ${data.error.message}` }, 502)
    let rules = (data.content ?? []).find(c => c.type === 'tool_use')?.input?.rules
    if (!Array.isArray(rules)) rules = []
    const clean = (rules as unknown[]).map(r => String(r).trim()).filter(r => r.length > 4 && r.length < 280).slice(0, 3)

    if (clean.length && body.save !== false) {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      await supabase.from('deck_ai_rules').insert(clean.map(rule => ({ kind: 'mail', scope: 'global', rule, active: true })))
    }
    return json({ ok: true, rules: clean })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
