// Ausgehende CRM-Nachrichten von Deutsch in die Empfängersprache übersetzen.
//
// EIN Ort für die Übersetzung, damit jeder Sendeweg (Drip, Reaktivierung,
// Portal-Zugang, Bot, Footer) denselben Weg nutzt. Bei Ziel 'de' oder fehlendem
// ANTHROPIC_API_KEY wird das Original unverändert zurückgegeben (fail-open:
// lieber Deutsch senden als gar nichts).
//
// Übersetzt wird NUR menschenlesbarer Text — HTML-Struktur, Links, Adressen,
// Zahlen, Preise, Daten und Eigennamen bleiben exakt erhalten.

const MODEL = 'claude-sonnet-4-6'

function langName(target: string): string {
  return target === 'en' ? 'English' : target
}

/** Betreff + HTML-Body + WhatsApp-Text in EINEM Aufruf übersetzen. */
export async function translateOutbound(
  fields: { subject: string | null; body: string | null; whatsapp: string | null },
  targetLang: string,
): Promise<{ subject: string | null; body: string | null; whatsapp: string | null }> {
  if (!targetLang || targetLang === 'de') return fields
  if (!fields.subject && !fields.body && !fields.whatsapp) return fields
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) { console.warn('[translate] ANTHROPIC_API_KEY fehlt – sende Original (DE)'); return fields }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: `You translate outbound real-estate CRM messages from German into ${langName(targetLang)}. Translate ONLY human-readable text. Preserve EXACTLY (do not translate or alter): all HTML tags/attributes/inline styles/structure, URLs and href links, email addresses, phone numbers, dates, times, amounts/prices/currencies, and proper/brand names (Happy Property, Sveru Ltd, Zoom, Lotte). Do not add, drop, or reorder content. Keep the professional, concise tone. Return ONLY a raw JSON object {"subject":...,"body":...,"whatsapp":...} — each the translated value, or null where the input was null. No markdown, no code fences.`,
        messages: [{ role: 'user', content: JSON.stringify({ subject: fields.subject, body: fields.body, whatsapp: fields.whatsapp }) }],
      }),
    })
    if (!res.ok) { console.warn('[translate] API', res.status, (await res.text()).slice(0, 300)); return fields }
    const data = await res.json()
    let text = String(data?.content?.[0]?.text ?? '').trim()
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const out = JSON.parse(text)
    return {
      subject:  typeof out.subject  === 'string' ? out.subject  : fields.subject,
      body:     typeof out.body     === 'string' ? out.body     : fields.body,
      whatsapp: typeof out.whatsapp === 'string' ? out.whatsapp : fields.whatsapp,
    }
  } catch (e) {
    console.warn('[translate] fehlgeschlagen – sende Original (DE):', e instanceof Error ? e.message : String(e))
    return fields
  }
}

/** Einen einzelnen Text (z.B. eine WhatsApp oder einen Mail-Body) übersetzen. */
export async function translateText(text: string | null, targetLang: string): Promise<string | null> {
  if (!text || !targetLang || targetLang === 'de') return text
  const out = await translateOutbound({ subject: null, body: text, whatsapp: null }, targetLang)
  return out.body
}
