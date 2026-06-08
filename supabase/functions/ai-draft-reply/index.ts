// Supabase Edge Function: ai-draft-reply
// Erzeugt einen ANTWORT-ENTWURF auf eine eingehende Kundennachricht.
// Gibt ausschließlich Text zurück – sendet NICHTS und schreibt keinen Versand an.
// Lernen: freigegebene (ggf. korrigierte) Beispiele aus ai_reply_examples werden
// als Few-Shot-Kontext mitgegeben, damit der Stil mit der Zeit besser passt.
//
// Deploy: supabase functions deploy ai-draft-reply   (erst auf Svens Go)
// Secret:  ANTHROPIC_API_KEY (bereits gesetzt, von analyze-invoice genutzt)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

interface ReqBody {
  lead_id?:      string
  inbound_text?: string
  channel?:      'whatsapp' | 'email'
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  if (!ANTHROPIC_API_KEY)       return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500)

  let body: ReqBody
  try {
    body = await req.json() as ReqBody
  } catch {
    return json({ error: 'Ungültiger Request-Body' }, 400)
  }
  const { lead_id, inbound_text } = body
  const channel = body.channel ?? 'whatsapp'
  if (!lead_id || !inbound_text) return json({ error: 'lead_id und inbound_text sind Pflicht' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── Kontext laden ──────────────────────────────────────────────────────────
  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, last_name, language, status, notes')
    .eq('id', lead_id)
    .maybeSingle()

  const { data: recent } = await supabase
    .from('activities')
    .select('direction, content, created_at')
    .eq('lead_id', lead_id)
    .in('type', ['whatsapp', 'email', 'note'])
    .order('created_at', { ascending: false })
    .limit(10)

  // Freigegebene Beispiele als Few-Shot (jüngste zuerst, dann chronologisch)
  const { data: examples } = await supabase
    .from('ai_reply_examples')
    .select('inbound_text, final_text')
    .in('status', ['approved', 'edited', 'auto_sent'])
    .eq('is_learning', true)
    .not('final_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(8)

  const lang = (lead?.language === 'en') ? 'Englisch' : 'Deutsch'
  const leadName = lead ? `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() : ''

  const history = (recent ?? [])
    .slice()
    .reverse()
    .map((a) => `${a.direction === 'inbound' ? 'Kunde' : 'Wir'}: ${a.content ?? ''}`)
    .join('\n')

  const systemPrompt = [
    'Du bist der freundliche Kommunikations-Assistent von Happy Property,',
    'einer Brokerage für Immobilien-Investments auf Zypern (Zielgruppe: deutschsprachige Kapitalanleger).',
    `Antworte auf ${lang}, höflich, kurz und natürlich – wie in den Beispielen.`,
    'WICHTIG:',
    '- Erfinde NIEMALS Fakten, Preise, Renditen, Termine oder Zusagen. Nenne nur, was im Verlauf belegt ist.',
    '- Gib keine rechtliche oder steuerliche Beratung und keine personalisierte Anlageberatung.',
    '- Bei konkreten Zusagen, Preisen, Terminen oder Unsicherheit: biete an, dass sich ein:e Kolleg:in persönlich meldet.',
    '- Schreibe nur den reinen Nachrichtentext, ohne Anrede-Platzhalter wie {{...}} und ohne Signatur.',
  ].join('\n')

  // Few-Shot als abwechselnde user/assistant-Turns
  const fewShot = (examples ?? [])
    .slice()
    .reverse()
    .flatMap((ex) => ([
      { role: 'user' as const, content: `Eingehende Nachricht des Kunden:\n${ex.inbound_text ?? ''}` },
      { role: 'assistant' as const, content: ex.final_text ?? '' },
    ]))

  const finalUser = [
    leadName ? `Kunde: ${leadName}` : '',
    history ? `Bisheriger Verlauf:\n${history}` : '',
    `Neue eingehende Nachricht des Kunden (${channel}):\n${inbound_text}`,
    'Formuliere einen passenden Antwort-Entwurf.',
  ].filter(Boolean).join('\n\n')

  // ── Anthropic ────────────────────────────────────────────────────────────────
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 600,
      system:     systemPrompt,
      messages: [
        ...fewShot,
        { role: 'user', content: finalUser },
      ],
    }),
  })

  if (!anthropicRes.ok) {
    const errBody = await anthropicRes.json().catch(() => ({})) as { error?: { message?: string } }
    return json({ error: `Anthropic API ${anthropicRes.status}: ${errBody.error?.message ?? anthropicRes.statusText}` }, anthropicRes.status)
  }

  const data = await anthropicRes.json() as { content?: { text?: string }[] }
  const draft = (data.content ?? []).map((c) => c.text ?? '').join('').trim()

  // Nur Entwurf zurückgeben – Persistenz/Versand entscheidet der Aufrufer.
  return json({ draft, examples_used: (examples ?? []).length })
})
