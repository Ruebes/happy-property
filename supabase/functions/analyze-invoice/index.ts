// Supabase Edge Function: analyze-invoice
// Proxy für die Anthropic API – vermeidet CORS-Probleme beim direkten Browser-Aufruf.
// Liest eine Rechnung als Base64-PDF und gibt strukturierte JSON-Daten zurück.
//
// Deploy: supabase functions deploy analyze-invoice
// Secret:  supabase secrets set ANTHROPIC_API_KEY=<key>

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  let pdfBase64: string
  try {
    const body = await req.json() as { pdfBase64?: string }
    if (!body.pdfBase64) throw new Error('pdfBase64 fehlt')
    pdfBase64 = body.pdfBase64
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Ungültiger Request-Body: ${(e as Error).message}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'pdfs-2024-09-25',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type:   'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: `Lies diese Rechnung und extrahiere folgende Daten als JSON:
{"kreditor":"Name des Rechnungsstellers","rechnungsnummer":"Rechnungsnummer","rechnungsdatum":"YYYY-MM-DD","faelligkeitsdatum":"YYYY-MM-DD","betrag_brutto":0.00,"betrag_netto":0.00,"mwst_satz":19,"beschreibung":"Leistungsbeschreibung","kreditor_iban":"IBAN falls vorhanden"}
Antworte NUR mit dem JSON-Objekt, ohne weitere Erklärungen oder Markdown. Falls ein Wert nicht gefunden wird, setze null.`,
          },
        ],
      }],
    }),
  })

  if (!anthropicRes.ok) {
    const errBody = await anthropicRes.json().catch(() => ({})) as { error?: { message?: string } }
    return new Response(
      JSON.stringify({ error: `Anthropic API ${anthropicRes.status}: ${errBody.error?.message ?? anthropicRes.statusText}` }),
      { status: anthropicRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const data = await anthropicRes.json()
  const text: string = (data as { content?: { text?: string }[] }).content?.[0]?.text ?? ''

  // Äußerstes JSON-Objekt extrahieren (falls Modell Präambel hinzufügt)
  const start = text.indexOf('{')
  const end   = text.lastIndexOf('}')
  if (start === -1 || end === -1) {
    return new Response(
      JSON.stringify({ error: 'Kein JSON in der Antwort gefunden', raw: text }),
      { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return new Response(
      JSON.stringify({ error: 'JSON-Parsing fehlgeschlagen', raw: text }),
      { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  return new Response(
    JSON.stringify(parsed),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
