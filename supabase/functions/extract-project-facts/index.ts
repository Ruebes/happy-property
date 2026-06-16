// Supabase Edge Function: extract-project-facts
// Liest Developer-Broschüre + Einrichtungspaket + Preisliste (PDFs per URL) mit
// Claude und extrahiert kompakte Projekt-Fakten als Text (für die Deck-Generierung).
//
// Body: { docs: [{ url, label }], project_name? }
// Antwort: { ok, facts }

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const PROMPT = `Du bekommst PDFs zu einem Immobilien-Projekt auf Zypern (z.B. Developer-Broschüre, Einrichtungspaket, Preisliste). Extrahiere die wichtigsten FAKTEN für ein Verkaufs-Deck — auf Deutsch, kompakt, in klaren Stichpunkten. Struktur:

PROJEKT: Developer/Bauträger, Lage, Konzept, Anzahl Einheiten, Architektur/Stil, Fertigstellung, Garantie.
AMENITIES & BESONDERHEITEN: gemeinschaftliche Anlagen (Pool, Gym, Dachterrasse …), Bauqualität, Nachhaltigkeit (PV o.ä.), Sicherheit.
EINRICHTUNGSPAKET: was ist enthalten (Möbel, Geräte, Küche, Marken), für welche Wohnungsgrößen.
HIGHLIGHTS: 3–5 stärkste Verkaufsargumente.

WICHTIG: NUR Fakten aus den Dokumenten, NICHTS erfinden. Wenn etwas nicht drinsteht, weglassen. Keine doppelten Anführungszeichen verwenden. Antworte als reiner Text (kein JSON).`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)

  try {
    const { docs } = await req.json() as { docs?: Array<{ url: string; label?: string }> }
    if (!docs?.length) return json({ error: 'docs fehlt' }, 400)

    const content: unknown[] = docs.slice(0, 4).map(d => ({
      type:   'document',
      source: { type: 'url', url: d.url },
      title:  d.label ?? 'Dokument',
    }))
    content.push({ type: 'text', text: PROMPT })

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'pdfs-2024-09-25',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 3000,
        messages:   [{ role: 'user', content }],
      }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return json({ error: `Anthropic ${res.status}: ${e.error?.message ?? res.statusText}` }, 502)
    }
    const data = await res.json() as { content?: { text?: string }[] }
    const facts = (data.content ?? []).map(c => c.text ?? '').join('\n').trim()
    return json({ ok: true, facts })

  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
