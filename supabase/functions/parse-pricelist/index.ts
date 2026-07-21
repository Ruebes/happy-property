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
- terrace_sqm: Außen-/Terrassen-/Balkonfläche in m² als Zahl falls angegeben. WICHTIG: Hat die Liste MEHRERE Außenflächen-Spalten (z.B. "Covered Veranda" UND "Uncovered Veranda/Roof garden"), dann ist terrace_sqm die SUMME aller Außenflächen-Spalten — nicht nur eine davon. Lagerraum (Storage) zählt NICHT dazu.
- price_net: Nettopreis (ohne MwSt) als reine Zahl ohne Punkte/Währung
- price_gross: Bruttopreis (inkl. MwSt) als reine Zahl, falls angegeben
- vat_rate: MwSt-Satz als Zahl (z.B. 19), falls erkennbar
- availability: available, reserved oder sold — falls die Liste den Status markiert, sonst weglassen

ZUSAMMENGEFASSTE / COMPOSITE-EINHEITEN: Manche Listen fassen mehrere Teile (z.B. A1a + A1b, oft als „Composite room type") zu EINER Einheit mit EINEM gemeinsamen Preis zusammen — erkennbar an einer über beide Zeilen verbundenen Preis-Zelle. Dann gib EINE Einheit aus (z.B. unit_number A1), NICHT zwei. Den gemeinsamen Preis NICHT auf beide Teile duplizieren. Flächen der Teile zur Gesamt-Wohnfläche summieren; Schlafzimmer = Summe der Teile.

PREIS-EINORDNUNG: Ein einzelner Preis OHNE ausdrücklichen MwSt-/VAT-Hinweis ist der NETTOPREIS → price_net. Nur wenn die Liste „inkl. MwSt/VAT" o.ä. ausweist → price_gross.

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
    const body = await req.json() as { project_id?: string; url?: string; create?: boolean; background?: boolean }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    let url = body.url
    let projectName = '', developer = ''
    if (body.project_id) {
      const { data } = await supabase.from('crm_projects').select('name, developer, deck_assets').eq('id', body.project_id).maybeSingle()
      projectName = (data?.name as string) ?? ''
      developer   = (data?.developer as string) ?? ''
      if (!url) url = (data?.deck_assets as { doc_urls?: { pricelist?: string } } | null)?.doc_urls?.pricelist
    }
    if (!url) return json({ error: 'Keine Preislisten-URL (url oder project_id mit importierter Preisliste nötig)' }, 400)

    // Viele Developer führen EINE Sammel-Preisliste über ALLE Projekte (z.B. Medousa:
    // 13 Projekte in einer PDF). Ohne Fokus extrahiert Claude nichts/das Falsche →
    // hier hart auf den Projekt-Abschnitt einschränken.
    const focus = projectName
      ? `\n\nWICHTIG — PROJEKT-FOKUS: Diese Datei kann eine SAMMEL-Preisliste mit MEHREREN Projekten sein (Developer-Gesamtliste). Extrahiere AUSSCHLIESSLICH die Einheiten des Projekts „${projectName}"${developer ? ` (Bauträger ${developer})` : ''}. Suche die Abschnitts-Überschrift „${projectName}" und nimm NUR die Einheiten darunter bis zur nächsten Projekt-Überschrift. Alle anderen Projekte/Abschnitte vollständig ignorieren. Enthält die Liste nur dieses eine Projekt, nimm alle Einheiten.`
      : ''
    const availRule = `\n\nVERFÜGBARKEIT bestimmen — maßgeblich ist die PREIS-Spalte JEDER EINZELNEN Zeile:
- Steht dort „SOLD"/„VERKAUFT" → availability sold.
- Steht dort „RESERVED"/„RESERVIERT" → availability reserved.
- Steht dort ein KONKRETER Zeilen-Preis (Zahl) → availability available, und übernimm GENAU diesen Zeilen-Preis.
NIEMALS den „starting from"/„ab €…"-Richtpreis aus der Abschnitts-Überschrift als Preis einer Einheit verwenden. Zeigt die Preis-Spalte einer Zeile „RESERVED" oder „SOLD", ist die Einheit reserved/sold — niemals available, auch wenn die Überschrift einen Richtpreis nennt. Im Zweifel availability=reserved und KEINEN Preis erfinden.`

    const ext = url.toLowerCase().split('?')[0]
    const isPdf  = ext.endsWith('.pdf')
    const isXlsx = ext.endsWith('.xlsx') || ext.endsWith('.xls')

    // Viele Developer (z.B. Olias) führen die Gesamt-Preisliste als EXCEL, nicht PDF.
    // Claude kann xlsx nicht direkt lesen → hier per SheetJS in CSV-Text wandeln und
    // als Text-Block schicken. Pro Blatt eine Tabelle; „"-Anführungszeichen raus.
    let xlsxText = ''
    if (isXlsx) {
      const xr = await fetch(url)
      if (!xr.ok) throw new Error(`Preislisten-Download ${xr.status}`)
      const bytes = new Uint8Array(await xr.arrayBuffer())
      const XLSX = await import('https://esm.sh/xlsx@0.18.5')
      const wb = XLSX.read(bytes, { type: 'array' })
      xlsxText = wb.SheetNames
        .map(s => `--- Blatt: ${s} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`)
        .join('\n\n').replace(/"/g, '').slice(0, 60000)
    }
    const docBlock = isPdf
      ? { type: 'document', source: { type: 'url', url } }
      : { type: 'image',    source: { type: 'url', url } }
    const content = isXlsx
      ? [{ type: 'text', text: `${PROMPT}${focus}${availRule}\n\n=== PREISLISTE (Excel als CSV) ===\n${xlsxText}` }]
      : [docBlock, { type: 'text', text: PROMPT + focus + availRule }]

    // Die Generierung (Claude liest Preisliste ~25s + Insert). Sync oder im Hintergrund.
    const runParse = async (): Promise<{ count: number; created: number; units: Unit[] }> => {
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
        messages:    [{ role: 'user', content }],
      }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`Anthropic ${res.status}: ${e.error?.message ?? res.statusText}`)
    }
    const data = await res.json() as { content?: Array<{ type?: string; input?: { units?: unknown } }> }
    const tu = (data.content ?? []).find(c => c.type === 'tool_use')
    let raw = tu?.input?.units
    if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = [] } }
    const units = (Array.isArray(raw) ? raw : []) as Unit[]
    if (!units.length) throw new Error('Keine Einheiten erkannt')

    let created = 0, deleted = 0, updated = 0
    if (body.create && body.project_id) {
      // Namens-Normalisierung: Penthouse-Suffix „(P)" und Sonderzeichen ignorieren,
      // sonst matcht „C-301 (P)" (Liste) nicht auf „C-301" (Bestand) → Duplikate.
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s*\(p\)\s*$/, '').replace(/[^a-z0-9]/g, '')
      const { data: existing } = await supabase.from('crm_project_units').select('id, unit_number, source, price_net, price_gross, status').eq('project_id', body.project_id)
      const have = new Set((existing ?? []).map(r => norm((r as { unit_number: string }).unit_number)))
      // An eigene Deals gebundene Units NIE anfassen
      const { data: dealUnits } = await supabase.from('deals').select('unit_id').not('unit_id', 'is', null)
      const dealLinked = new Set((dealUnits ?? []).map(d => (d as { unit_id: string }).unit_id))
      // Verfügbarkeit + Preis aus der aktuellen Preisliste je Unit-Nummer
      const avail = new Map<string, string>()
      const listByNum = new Map<string, Unit>()
      for (const u of units) if (u.unit_number) { const k = norm(u.unit_number); avail.set(k, (u.availability as string) || 'available'); listByNum.set(k, u) }

      type ExRow = { id: string; unit_number: string; source: string | null; price_net: number | null; price_gross: number | null; status: string | null }
      const driveAll  = (existing ?? []).filter(r => (r as ExRow).source === 'drive_import') as ExRow[]
      const driveFree = driveAll.filter(r => !dealLinked.has(r.id))   // löschbar (Deal-Units bleiben)
      // Developer liefern oft BLOCK-Teillisten (Luma: „A&B" und „C&D" getrennt).
      // „Verschwunden = verkauft" darf nur für Units gelten, deren Block in DIESER
      // Liste überhaupt vorkommt — sonst löscht der A&B-Lauf alle C/D-Units und
      // umgekehrt. Block = Buchstaben-Präfix der Unit-Nummer (fehlt er, Scope '').
      const blockOf = (n: unknown) => (String(n ?? '').trim().match(/^([A-Za-z]+)[-\s]?\d/)?.[1] ?? '').toLowerCase()
      const listBlocks = new Set(units.map(u => blockOf(u.unit_number)))
      const inScope = (r: ExRow) => listBlocks.has(blockOf(r.unit_number))
      // „Vollständige" Liste? Mind. so viele Einträge wie unsere Drive-Units IM SCOPE →
      // dann ist sicher, dass verschwundene Scope-Units verkauft sind (schützt vor Parse-Aussetzern).
      const listComplete = units.length >= driveAll.filter(inScope).length
      const isUnavail = (r: ExRow) => {
        const av = avail.get(norm(r.unit_number))
        return av === 'sold' || av === 'reserved' || (!av && listComplete && inScope(r))
      }

      // (1) LÖSCHEN: freie Drive-Units, die jetzt sold/reserved oder (bei vollständiger Liste)
      // ganz verschwunden sind. Manuelle + Deal-Units bleiben unangetastet.
      const toDelete = driveFree.filter(isUnavail).map(r => r.id)
      if (toDelete.length) {
        const { error } = await supabase.from('crm_project_units').delete().in('id', toDelete)
        if (!error) deleted = toDelete.length
      }

      // Hinweis: Units an AKTIVEN Deals (driveDeal) werden NICHT gelöscht und NICHT im Status
      // geändert (Unit-Status ist nur under_construction|active, „reserved" würde per Trigger
      // eh überschrieben). Sie werden in den Angebots-Ansichten über die Deal-Bindung ausgeblendet.

      // (2) AKTUALISIEREN: bestehende, verfügbar gebliebene freie Drive-Units — Preis nachziehen.
      const delSet = new Set(toDelete)
      for (const r of driveFree) {
        if (delSet.has(r.id) || isUnavail(r)) continue
        const lu = listByNum.get(norm(r.unit_number))
        if (!lu) continue
        const newNet = num(lu.price_net), newGross = num(lu.price_gross)
        const patch: Record<string, number | string> = {}
        if (newNet != null && Number(newNet) !== Number(r.price_net)) patch.price_net = newNet
        if (newGross != null && Number(newGross) !== Number(r.price_gross)) patch.price_gross = newGross
        // REAKTIVIERUNG: Der Bauträger führt die Unit wieder mit Preis (available),
        // bei uns steht sie noch sold/reserved (z.B. freigegebene Reservierung oder
        // wieder eröffneter Block) → zurück in den anbietbaren Zustand.
        if (r.status === 'sold' || r.status === 'reserved') patch.status = 'proposal'
        if (Object.keys(patch).length) {
          const { error } = await supabase.from('crm_project_units').update(patch).eq('id', r.id)
          if (!error) updated++
        }
      }

      // Neue VERFÜGBARE Units anlegen (sold/reserved aus der Liste nicht aufnehmen).
      // Intra-Batch-Dedup: KI/Liste liefern gelegentlich dieselbe Unit-Nummer doppelt
      // (z.B. zwei „102"-Zeilen). `have` schützt NUR gegen DB-Bestand, nicht gegen
      // Dubletten IM selben Batch → sonst landen beide in der DB (exakt der Infinity-102-
      // Bug: eine korrekte + eine mit fremdem Preis). Nur die erste je Nummer behalten.
      const seenInBatch = new Set<string>()
      const dupSkipped: string[] = []
      const rows = units
        .filter(u => {
          if (!u.unit_number || have.has(norm(u.unit_number))) return false
          if (u.availability === 'sold' || u.availability === 'reserved') return false
          const k = norm(u.unit_number)
          if (seenInBatch.has(k)) { dupSkipped.push(String(u.unit_number)); return false }
          seenInBatch.add(k)
          return true
        })
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
          status:      'proposal',   // nur verfügbare Units → im Wizard vorschlagbar
          source:      'drive_import',
          sort_order:  i,
        }))
      if (dupSkipped.length) console.warn(`[parse-pricelist] Dubletten in Liste übersprungen (nur erste je Nummer behalten): ${dupSkipped.join(', ')}`)
      if (rows.length) {
        const { error, count } = await supabase.from('crm_project_units').insert(rows, { count: 'exact' })
        if (error) throw new Error(`Insert: ${error.message}`)
        created = count ?? rows.length
      }
    }

      return { count: units.length, created, deleted, updated, units }
    }   // ── Ende runParse ──

    // Preisliste lesen (~25s): bei create im HINTERGRUND, damit der Browser nicht
    // am Verbindungs-Timeout abbricht. Die Wohnungen erscheinen kurz danach.
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
    if (body.background && body.create && er?.waitUntil) {
      er.waitUntil(runParse().catch(() => {}))
      return json({ ok: true, background: true })
    }
    const out = await runParse()
    return json({ ok: true, count: out.count, created: out.created, deleted: out.deleted, updated: out.updated, units: out.units })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
