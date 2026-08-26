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

const PROMPT = `Du bekommst PDFs zu einem Immobilien-Projekt auf Zypern (z.B. Developer-Broschüre, Einrichtungspaket, Preisliste). Extrahiere die FAKTEN für ein Verkaufs-Deck — auf Deutsch, VOLLSTÄNDIG statt kompakt: lieber zu lang als zu kurz. Was du hier weglässt, kann später niemand mehr nachschlagen. Struktur:

PROJEKT: Developer/Bauträger, Lage, Konzept, Anzahl Einheiten, Architektur/Stil, Fertigstellung, Garantie.
AMENITIES & BESONDERHEITEN: gemeinschaftliche Anlagen (Pool, Gym, Dachterrasse …), Bauqualität, Nachhaltigkeit (PV o.ä.), Sicherheit.
EINRICHTUNGSPAKET: was gehört dazu (Möbel, Geräte, Küche, Marken), für welche Wohnungsgrößen — UND vor allem: kostet es Aufpreis oder ist es im Kaufpreis enthalten? Suche dafür gezielt nach Formulierungen wie "furniture package at ... + VAT", "all-inclusive price", "includes furniture and appliances", "fully furnished", "turn-key". Nenne den Betrag, wenn einer dasteht. Unterscheide strikt zwischen FEST VERBAUTER Ausstattung (Küche, Einbauschränke, Sanitär, Klimaanlage — meist im Preis) und BEWEGLICHEN Möbeln (meist Aufpreis). Steht dazu nichts, schreibe das ausdrücklich unter UNKLAR.
PREISE & ZUSATZKOSTEN: Hat die Preisliste MEHRERE Preisspalten je Wohnung (z.B. off-plan / all-inclusive / under construction / completed)? Dann jede Spalte benennen und erklären, was sie enthält — wörtlich nach der Legende/Fußnote. Ebenso: Anwaltskosten, PR-Antrag, Möbelpaket, Sonderausstattung.
HIGHLIGHTS: 3–5 stärkste Verkaufsargumente.

BELEGE (Pflicht): Liste am Ende zu JEDER Aussage über Ausstattung, Möblierung, Preise, Zusatzkosten, Fertigstellung und Garantie den wörtlichen Quellsatz mit Dokumentnamen, Format: [Preisliste] Furniture package at 30.000 EUR + 19% VAT. Ohne Beleg keine Aussage.

UNKLAR: Alles, was du nicht eindeutig belegen kannst, hier als Stichpunkt auflisten statt es wegzulassen oder zu raten. Prüfe dabei ausdrücklich: Sind Möbel im Preis? Gibt es mehrere Preisvarianten? Was genau ist fest verbaut?

WICHTIG: NUR Fakten aus den Dokumenten, NICHTS erfinden. Fasse NIE zu einer stärkeren Aussage zusammen, als der Text hergibt: aus "Küchen und Einbauschränke sind ausgestattet" wird NIEMALS "vollständig schlüsselfertig" oder "voll möbliert" — das sind verschiedene Dinge. Wenn etwas nicht drinsteht, gehört es unter UNKLAR, nicht weggelassen und erst recht nicht ergänzt. Keine doppelten Anführungszeichen verwenden. Antworte als reiner Text (kein JSON).

APARTMENT-SICHERHEIT: Wenn es um eine Apartment-Wohnanlage geht und eine Spezifikation projektweite oder reine Villen-Merkmale enthält (eigener Privatgarten, Keller/Basement, privater Pool im Boden, interne Wendeltreppe zwischen Etagen), übernimm diese NICHT — sie gelten nicht für eine Wohnung. Aus der Spezifikation NUR Dinge übernehmen, die in einer Wohnung Sinn ergeben: Möbel-/Geräte-Marken, Küche, Bäder, Böden, Klima/Heizung, Fenster, Material-/Bauqualität, Sicherheit, Energie.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)

  try {
    const { docs, spec_text, context } = await req.json() as { docs?: Array<{ url: string; label?: string }>; spec_text?: string; context?: string }
    if (!docs?.length && !spec_text?.trim()) return json({ error: 'docs oder spec_text fehlt' }, 400)

    // Vorher schnitt slice(0, 4) still Dokumente ab - der Zahlungsplan (letzter
    // Eintrag) fiel damit regelmaessig heraus, ohne dass es jemand sah.
    const alle = docs ?? []
    if (alle.length > 8) console.warn('[extract-project-facts] verworfen:', alle.slice(8).map(d => d.label ?? d.url).join(', '))
    const content: unknown[] = alle.slice(0, 8).map(d => ({
      type:   'document',
      source: { type: 'url', url: d.url },
      title:  d.label ?? 'Dokument',
    }))
    if (context?.trim())   content.push({ type: 'text', text: `KONTEXT: ${context.trim()}` })
    if (spec_text?.trim()) content.push({ type: 'text', text: `AUSSTATTUNGS-SPEZIFIKATION (Rohtext, ggf. projektweit — apartment-sicher filtern):\n${spec_text.trim().slice(0, 30000)}` })
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
        max_tokens: 12000,
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
