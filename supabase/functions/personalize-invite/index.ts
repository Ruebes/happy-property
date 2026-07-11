// Edge Function: personalize-invite — macht aus Svens Termin-Beschreibung je
// Empfänger einen individuell zugeschnittenen Einladungs-Absatz (Mail + WhatsApp).
// Lead = Kunde (warm, Du), Partner = kollegial (Du; language 'en' → Englisch).
//
// Aufruf: POST {
//   briefing: string,
//   appointment: { title, dateStr, von, bis, type, location? },
//   recipients: [{ key, firstName, role: 'lead'|'partner', company?, language? }]
// } → { ok, texts: { [key]: string } }
//
// Secrets: ANTHROPIC_API_KEY
// Deployment: supabase functions deploy personalize-invite --no-verify-jwt

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  try {
    const key = Deno.env.get('ANTHROPIC_API_KEY')
    if (!key) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)
    const body = await req.json() as {
      briefing?: string
      appointment?: { title?: string; dateStr?: string; von?: string; bis?: string; type?: string; location?: string }
      recipients?: Array<{ key: string; firstName: string; role: 'lead' | 'partner'; company?: string | null; language?: string | null }>
    }
    const briefing = (body.briefing ?? '').trim()
    const recipients = body.recipients ?? []
    if (!briefing || !recipients.length) return json({ ok: true, texts: {} })
    const a = body.appointment ?? {}

    const sys = `Du schreibst für Sven (Happy Property — Zypern-Immobilien für deutsche Kapitalanleger) je Empfänger EINEN kurzen persönlichen Absatz (1–3 Sätze) für eine Termin-Einladung. Grundlage sind Svens interne Stichpunkte zum Termin.
REGELN:
- Rolle 'lead' = Kunde/Interessent: warm, persönlich, Du-Form — worum es IM GESPRÄCH FÜR IHN geht.
- Rolle 'partner' = Geschäftspartner (Anwalt, Finanzierer, Developer, Verwalter): kollegial-professionell, Du-Form — was SEIN Part im Termin ist.
- language 'en' → Absatz auf ENGLISCH (professionell, Vorname bleibt).
- NICHTS erfinden: keine Preise, Zusagen, Objekt-Details, die nicht in den Stichpunkten stehen. Stichpunkte natürlich ausformulieren und pro Rolle zuschneiden.
- KEINE Anrede ("Hallo X"), KEIN Gruß, KEINE Termin-Daten wiederholen (Datum/Uhrzeit/Ort stehen separat in der Einladung).
- Interna aus den Stichpunkten, die der jeweilige Empfänger nicht sehen soll (z.B. Verhandlungsspielraum), weglassen.
Gib NUR das Tool emit_texts zurück.`
    const usr = `TERMIN: ${a.title ?? ''} · ${a.dateStr ?? ''} · ${a.von ?? ''}–${a.bis ?? ''} Uhr · Art: ${a.type ?? ''}${a.location ? ` · Ort: ${a.location}` : ''}
SVENS STICHPUNKTE:
${briefing}

EMPFÄNGER:
${recipients.map(r => `- key=${r.key} | ${r.firstName} | Rolle: ${r.role}${r.company ? ` | Firma: ${r.company}` : ''}${r.language === 'en' ? ' | Sprache: EN' : ''}`).join('\n')}`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1200,
        system: sys,
        tool_choice: { type: 'tool', name: 'emit_texts' },
        tools: [{
          name: 'emit_texts', description: 'Personalisierte Absätze je Empfänger',
          input_schema: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object', properties: {
                key: { type: 'string' }, text: { type: 'string' },
              }, required: ['key', 'text'] } },
            }, required: ['items'],
          },
        }],
        messages: [{ role: 'user', content: usr }],
      }),
    })
    if (!res.ok) return json({ error: `KI-Fehler ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502)
    const d = await res.json() as { content?: Array<{ type: string; input?: { items?: Array<{ key: string; text: string }> } }> }
    const items = d.content?.find(c => c.type === 'tool_use')?.input?.items ?? []
    const texts: Record<string, string> = {}
    for (const it of items) if (it.key && it.text) texts[it.key] = it.text.trim()
    return json({ ok: true, texts })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[personalize-invite]', msg)
    return json({ error: msg }, 500)
  }
})
