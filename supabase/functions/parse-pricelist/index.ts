// Supabase Edge Function: parse-pricelist
// Liest die Preisliste eines Projekts (PDF oder Bild) mit Claude und extrahiert ALLE
// Wohnungen als strukturierte Liste. Optional werden sie als 'proposal'-Units angelegt
// (nur im Deck-Wizard sichtbar, nicht in der echten Auswahl).
//
// Body: { project_id?, url?, create? }
//   - url fehlt → nimmt crm_projects.deck_assets.doc_urls.pricelist
//   - create=true + project_id → legt neue Units (status 'proposal', source 'drive_import') an
// Antwort: { ok, units, created? }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const PROMPT = `Du bekommst die PREISLISTE eines Immobilien-Projekts auf Zypern (Tabelle mit allen Einheiten). Extrahiere ALLE Einheiten/Wohnungen — vollständig, keine auslassen.

Pro Einheit:
- unit_number: die Einheiten-Nummer/Bezeichnung (z.B. 101, 203, A12)
- block: Block/Gebäude falls angegeben, sonst weglassen
- floor: Etage als Zahl (Erdgeschoss=0), falls aus Nummer oder Spalte erkennbar
- type: einer von apartment, studio, villa (Shop/Gewerbe ebenfalls als apartment, im Hinweis vermerken)
- bedrooms: Anzahl Schlafzimmer als Zahl (Studio=0)
- bathrooms: Anzahl Bäder als Zahl falls angegeben
- size_sqm: Innen-/Wohnfläche in m² als Zahl
- terrace_sqm: Außen-/Terrassen-/Balkonfläche in m² als Zahl falls angegeben
- price_net: Nettopreis (ohne MwSt) als reine Zahl ohne Punkte/Währung
- price_gross: Bruttopreis (inkl. MwSt) als reine Zahl, falls angegeben
- vat_rate: MwSt-Satz als Zahl (z.B. 19), falls erkennbar
- availability: available, reserved oder sold — falls die Liste den Status markiert, sonst weglassen

WICHTIG: Nur Werte aus der Liste, nichts erfinden/schätzen. Fehlende Felder weglassen. Zahlen ohne Tausenderpunkte und ohne Währungssymbol. Rufe das Tool emit_units mit dem Array auf.`

const TOOL = {
  name: 'emit_units',
  description: 'Gibt alle Einheiten der Preisliste als strukturierte Liste zurück.',
  input_schema: {
    type: 'object',
    properties: {
      units: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            unit_number: { type: 'string' },
            block:       { type: 'string' },
            floor:       { type: 'number' },
            type:        { type: 'string', enum: ['apartment', 'studio', 'villa'] },
            bedrooms:    { type: 'number' },
            bathrooms:   { type: 'number' },
            size_sqm:    { type: 'number' },
            terrace_sqm: { type: 'number' },
            price_net:   { type: 'number' },
            price_gross: { type: 'number' },
            vat_rate:    { type: 'number' },
            availability:{ type: 'string', enum: ['available', 'reserved', 'sold'] },
            note:        { type: 'string' },
          },
          required: ['unit_number'],
        },
      },
    },
    required: ['units'],
  },
}

type Unit = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v)) ? v : null
const int = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.round(n) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)

  try {
    const body = await req.json() as { project_id?: string; url?: string; create?: boolean }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    let url = body.url
    if (!url && body.project_id) {
      const { data } = await supabase.from('crm_projects').select('deck_assets').eq('id', body.project_id).maybeSingle()
      url = (data?.deck_assets as { doc_urls?: { pricelist?: string } } | null)?.doc_urls?.pricelist
    }
    if (!url) return json({ error: 'Keine Preislisten-URL (url oder project_id mit importierter Preisliste nötig)' }, 400)

    const isPdf = url.toLowerCase().split('?')[0].endsWith('.pdf')
    const docBlock = isPdf
      ? { type: 'document', source: { type: 'url', url } }
      : { type: 'image',    source: { type: 'url', url } }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'pdfs-2024-09-25',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:       'claude-sonnet-4-6',
        max_tokens:  8000,
        tools:       [TOOL],
        tool_choice: { type: 'tool', name: 'emit_units' },
        messages:    [{ role: 'user', content: [docBlock, { type: 'text', text: PROMPT }] }],
      }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return json({ error: `Anthropic ${res.status}: ${e.error?.message ?? res.statusText}` }, 502)
    }
    const data = await res.json() as { content?: Array<{ type?: string; input?: { units?: unknown } }> }
    const tu = (data.content ?? []).find(c => c.type === 'tool_use')
    let raw = tu?.input?.units
    if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = [] } }
    const units = (Array.isArray(raw) ? raw : []) as Unit[]
    if (!units.length) return json({ error: 'Keine Einheiten erkannt' }, 502)

    let created = 0
    if (body.create && body.project_id) {
      const { data: existing } = await supabase.from('crm_project_units').select('unit_number').eq('project_id', body.project_id)
      const have = new Set((existing ?? []).map(r => String((r as { unit_number: string }).unit_number).trim().toLowerCase()))
      const rows = units
        .filter(u => u.unit_number && !have.has(String(u.unit_number).trim().toLowerCase()))
        .map((u, i) => ({
          project_id:  body.project_id,
          unit_number: String(u.unit_number).trim(),
          block:       (u.block as string) ?? null,
          floor:       int(u.floor),
          type:        (['apartment', 'studio', 'villa'].includes(u.type as string) ? u.type : 'apartment') as string,
          bedrooms:    int(u.bedrooms) ?? 0,
          bathrooms:   int(u.bathrooms) ?? 1,
          size_sqm:    num(u.size_sqm),
          terrace_sqm: num(u.terrace_sqm),
          price_net:   num(u.price_net),
          price_gross: num(u.price_gross),
          vat_rate:    num(u.vat_rate) ?? 19,
          // Verfügbarkeit → Status: frei wird 'proposal' (nur im Wizard vorschlagbar),
          // verkauft/reserviert behalten ihren echten Status (nicht vorschlagbar).
          status:      u.availability === 'sold' ? 'sold' : u.availability === 'reserved' ? 'reserved' : 'proposal',
          source:      'drive_import',
          sort_order:  i,
        }))
      if (rows.length) {
        const { error, count } = await supabase.from('crm_project_units').insert(rows, { count: 'exact' })
        if (error) return json({ error: `Insert: ${error.message}`, units }, 500)
        created = count ?? rows.length
      }
    }

    return json({ ok: true, count: units.length, created, units })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
