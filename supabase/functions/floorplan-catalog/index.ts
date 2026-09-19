// Supabase Edge Function: floorplan-catalog
// Loest Bautraeger-Grundrissblaetter (PDF/Bild) in Plaene je WOHNUNG auf und legt
// sie als Katalog-Eintraege ab (deck_assets_catalog, source_type floorplan,
// unit_key, floor_labels, source_page, crop_rect, dimensions_present).
//
// Warum: Ein Blatt wie "P-BA-03-01 - Block A - Ground Floor Plan, First Floor
// Plan, Roof Plan.pdf" enthaelt A1a/A1b/A2a/A2b/A3a/A3b ueber zwei Geschosse.
// Der Dateiname nennt keine Wohnung, also fand bisher keine Wohnung ihren Plan
// (Mamba A1: "Grundriss fehlt", Sven 19.9.26). Jetzt:
//
//   Blatt laden → Seiten rastern + Textpositionen (mupdf) → Claude nennt je Plan
//   Wohnung(en), Geschoss, Rahmen (Anteile 0..1), Masse vorhanden → Rahmen
//   gegen die Textpositionen der Wohnungsnummer geprueft → Zuschnitt in
//   Arbeitsaufloesung → Storage → Katalog. Mehrere Geschosse einer Wohnung
//   werden zusaetzlich zu EINEM Bild nebeneinander gesetzt (Panels mit Label).
//
// Der Original-Bautraegerplan bleibt die geometrische Wahrheit: es wird nur
// zugeschnitten, nichts neu gezeichnet. Ergebnis = status 'classified' - im Deck
// nutzbar, aber mit Hinweis, bis Sven im Projekt freigibt (approved).
//
// Body: { project_id, asset_id?, force?, sync? }
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { Image } from '../_vendor/imagescript/ImageScript.js'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'
import { loadCiFonts } from '../_shared/brand.ts'
import { unitKey } from '../_shared/deckVat.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

type Unit = { id: string; unit_number: string; unit_key: string; type: string | null; bedrooms: number | null; floor: number | null; block: string | null; parent_unit_id: string | null }
type Source = { id: string; storage_url: string; label: string | null; is_vector: boolean | null; meta: Record<string, unknown> | null }
type TextHit = { text: string; cx: number; cy: number; units: string[] }
type Plan = { units: string[]; floor_label: string; bbox: { x0: number; y0: number; x1: number; y1: number }; dimensions_present: boolean; confidence: 'high' | 'medium' | 'low'; note?: string }

const toB64 = (bytes: Uint8Array) => {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Wohnungsnummern im Text einer Zeile finden (Token-Grenzen, normalisiert). */
function unitsInText(text: string, units: Unit[]): string[] {
  const t = text.toLowerCase().replace(/[\s_\-–—.]+/g, '')
  const out: string[] = []
  for (const u of [...units].sort((a, b) => b.unit_key.length - a.unit_key.length)) {
    const k = u.unit_key
    if (!k || k.length < 2 && !/^\d+$/.test(k)) continue
    let i = t.indexOf(k)
    while (i !== -1) {
      const davor = t[i - 1], danach = t[i + k.length]
      const grenze = (c: string | undefined) => c === undefined || !/[a-z0-9]/.test(c)
      if (grenze(davor) && grenze(danach)) { out.push(u.unit_number); break }
      i = t.indexOf(k, i + 1)
    }
  }
  return out
}

const ANALYZE_TOOL = {
  name: 'emit_plans',
  description: 'Alle Wohnungsgrundrisse auf diesem Blatt mit Rahmen.',
  input_schema: {
    type: 'object',
    properties: {
      plans: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            units:  { type: 'array', items: { type: 'string' }, description: 'Wohnungsnummern GENAU wie in der Liste der CRM-Wohnungen, die dieser Plan zeigt. Ein Plan, der laut Blatt fuer mehrere Wohnungen gilt (z.B. "Type A - Villas 01-04"), nennt alle.' },
            floor_label: { type: 'string', description: 'Deutsches Geschoss-Label: ERDGESCHOSS, OBERGESCHOSS, 2. OBERGESCHOSS, DACHGESCHOSS, oder leer.' },
            bbox: { type: 'object', properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } }, required: ['x0', 'y0', 'x1', 'y1'],
              description: 'Rahmen des Plans als Anteile der Seite (0..1, x nach rechts, y nach unten), GROSSZUEGIG: alle Waende, Terrassen/Veranden/Balkone, Garten- und Stellplatzflaechen der Wohnung UND die aeusseren Massketten vollstaendig einschliessen (lieber 10 % zu viel als ein abgeschnittener Raum), aber ohne Titelblock und Legende.' },
            dimensions_present: { type: 'boolean', description: 'Stehen Massketten/Raummasse im Plan?' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            note: { type: 'string' },
          },
          required: ['units', 'bbox', 'dimensions_present', 'confidence'],
        },
      },
      sheet_note: { type: 'string', description: 'Was das Blatt insgesamt zeigt (z.B. Masterplan, Schnitte, Dachplan) - falls KEIN Wohnungsgrundriss darauf ist.' },
    },
    required: ['plans'],
  },
}

async function analyzePage(png: Uint8Array, units: Unit[], hits: TextHit[], projName: string, fileLabel: string, pageNo: number): Promise<{ plans: Plan[]; sheetNote?: string }> {
  const unitList = units.map(u => `${u.unit_number}${u.type ? ` (${u.type}${u.bedrooms != null ? `, ${u.bedrooms} SZ` : ''})` : ''}`).join(', ')
  const hitTxt = hits.length
    ? hits.slice(0, 40).map(h => `- "${h.text}" bei x=${h.cx.toFixed(2)} y=${h.cy.toFixed(2)}${h.units.length ? ` → ${h.units.join('/')}` : ''}`).join('\n')
    : '(keine Textpositionen - Rasterbild)'
  const res = await callAnthropic(ANTHROPIC_API_KEY, {
    model: 'claude-sonnet-4-6', max_tokens: 3000,
    tools: [ANALYZE_TOOL], tool_choice: { type: 'tool', name: 'emit_plans' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: toB64(png) } },
      { type: 'text', text: `Projekt „${projName}", Datei „${fileLabel}", Seite ${pageNo}.
CRM-Wohnungen dieses Projekts: ${unitList}.
Textpositionen auf dem Blatt (Anteile der Seite, 0..1):
${hitTxt}

Finde JEDEN Wohnungsgrundriss auf diesem Blatt. Ein Wohnungsgrundriss ist die Linienzeichnung EINER Wohnung (oder eines Doppelhauses) mit Raumbezeichnungen (Living, Kitchen, Bedroom …) in einem Massstab, in dem Tueren und Moebel erkennbar sind. NICHT gemeint: Masterplan/Lageplan (mehrere Gebaeude, Strassen, Grundstuecksgrenzen), Dachplan, Schnitte, Ansichten, Flaechenschemata mit farbigen Rechtecken. Zeigt das Blatt nur eine Uebersicht, ist plans LEER. Gib JE WOHNUNG einen eigenen Rahmen zurueck, auch wenn mehrere Wohnungen auf demselben Geschossplan nebeneinander liegen (dann drei Plaene mit je einer Nummer; der Rahmen darf die Nachbarwohnung leicht anschneiden). Der Rahmen muss die Beschriftung der Wohnung (siehe Textpositionen) einschliessen. Mehrere Nummern in EINEM Plan nur, wenn das Blatt den Plan ausdruecklich fuer mehrere Wohnungen ausweist (z.B. "Type A - Villas 01-04"). Nichts erfinden: gibt es keinen Wohnungsgrundriss, plans leer lassen und sheet_note fuellen.` },
    ] }],
    label: 'floorplan_catalog',
  })
  if (!res.ok) throw new Error(`Analyse: ${res.error}`)
  const out = toolInput<{ plans?: Plan[]; sheet_note?: string }>(res)
  return { plans: (out?.plans ?? []).filter(p => p && p.bbox && Array.isArray(p.units)), sheetNote: out?.sheet_note }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)
  try {
    const body = await req.json() as { project_id?: string; asset_id?: string; force?: boolean; sync?: boolean; chained?: boolean }
    if (!body.project_id) return json({ error: 'project_id fehlt' }, 400)
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE)
    const { data: proj } = await sb.from('crm_projects').select('id, name').eq('id', body.project_id).maybeSingle()
    if (!proj) return json({ error: 'Projekt nicht gefunden' }, 404)
    const projName = String((proj as { name?: string }).name ?? '')
    const { data: unitRows } = await sb.from('crm_project_units')
      .select('id, unit_number, unit_key, type, bedrooms, floor, block, parent_unit_id').eq('project_id', body.project_id)
    const units = (unitRows ?? []) as Unit[]
    if (!units.length) return json({ error: 'Projekt hat keine Wohnungen' }, 400)

    let q = sb.from('deck_assets_catalog').select('id, storage_url, label, is_vector, meta')
      .eq('project_id', body.project_id).eq('source_type', 'floorplan').eq('active', true)
      .is('generated_from_asset_id', null).is('unit_key', null)
    if (body.asset_id) q = q.eq('id', body.asset_id)
    const { data: srcRows } = await q
    // Blaetter, die per Definition keine Wohnungsgrundrisse sind (Masterplan,
    // Lageplan, Schnitte, Ansichten, Dachplan), gar nicht erst analysieren: das
    // Modell "fand" auf dem Masterplan sonst alle 25 Wohnungen als Grundriss.
    const KEIN_GRUNDRISS = /master\s*plan|lageplan|site\s*plan|section|schnitt|elevation|ansicht|roof\s*plan|dachplan|3d|render|perspective/i
    const sources = ((srcRows ?? []) as Source[])
      .filter(s => body.asset_id || !KEIN_GRUNDRISS.test(s.label ?? '') || /floor\s*plan|grundriss|geschoss|etage|\btyp/i.test(s.label ?? ''))
      .filter(s => body.force || !(s.meta?.analyzed_at))
      .map(s => body.force && !body.chained ? { ...s, meta: { ...(s.meta ?? {}), jobs: undefined, analyzed_at: undefined } } : s)
    if (!sources.length) return json({ ok: true, analyzed: 0, note: 'keine unbearbeiteten Grundriss-Blaetter' })

    // ── Etappenlauf ─────────────────────────────────────────────────────────
    // Der Worker hat ein hartes CPU-/Speicherbudget (WORKER_RESOURCE_LIMIT nach
    // ~6 Zuschnitten eines A1-Blatts). Deshalb arbeitet jeder Aufruf nur EINE
    // Etappe und ruft sich dann selbst wieder auf:
    //   Etappe A  Blatt analysieren (Vorschau + Textpositionen + Claude) → Auftrags-
    //             liste in meta.jobs
    //   Etappe B  bis zu 2 Zuschnitte rastern + ablegen
    //   Etappe C  je Wohnung mit mehreren Geschossen ein Kombi-Bild
    //   fertig    meta.analyzed_at
    type Rect = [number, number, number, number]
    type Job =
      | { kind: 'crop'; page: number; units: string[]; floor: string; rect: Rect; dims: boolean; conf: string; status: 'classified' | 'review'; note?: string; labelCheck: string; done?: boolean; url?: string; assetId?: string }
      | { kind: 'combo'; unitKey: string; parts: number[]; done?: boolean }
    type Meta = Record<string, unknown> & { jobs?: Job[]; report?: { plans: number; units: string[]; skipped: string[] }; analyzed_at?: string }
    const marker = '/storage/v1/object/public/deck-assets/'
    const CROPS_PER_CALL = 2

    const run = async (): Promise<Record<string, unknown>> => {
      const src = sources[0]
      const meta: Meta = { ...(src.meta ?? {}) } as Meta
      const entry: Record<string, unknown> = { asset: src.label ?? src.storage_url.slice(-40) }
      const mupdf = await import('npm:mupdf@1.26.4')
      let doc: any = null
      let rawImg: Uint8Array | null = null
      const raw = new Uint8Array(await (await fetch(src.storage_url)).arrayBuffer())
      if (raw.length > 30_000_000) throw new Error('Datei zu gross (>30 MB)')
      const istPdf = /\.pdf(\?|$)/i.test(src.storage_url) || (raw[0] === 0x25 && raw[1] === 0x50 && raw[2] === 0x44 && raw[3] === 0x46)
      if (istPdf) doc = mupdf.Document.openDocument(raw, 'application/pdf')
      else rawImg = raw

      const pageDims = (no: number): { b: number[]; w: number; h: number } => {
        if (doc) { const page = doc.loadPage(no - 1); const b = page.getBounds(); return { b, w: b[2] - b[0], h: b[3] - b[1] } }
        return { b: [0, 0, 0, 0], w: 0, h: 0 }
      }
      // Nur den Ausschnitt rastern (DrawDevice auf ein Pixmap der Ausschnittgroesse).
      const renderRegion = async (no: number, r: Rect, targetW: number): Promise<Uint8Array> => {
        const [x0, y0, x1, y1] = r
        if (!doc) {
          const im = await Image.decode(rawImg!)
          return await im.crop(Math.round(x0 * im.width), Math.round(y0 * im.height), Math.round((x1 - x0) * im.width), Math.round((y1 - y0) * im.height)).encode()
        }
        const page = doc.loadPage(no - 1)
        const { b, w, h } = pageDims(no)
        const rx0 = b[0] + x0 * w, ry0 = b[1] + y0 * h, rx1 = b[0] + x1 * w, ry1 = b[1] + y1 * h
        const scale = Math.max(1, Math.min(5, targetW / Math.max(1, rx1 - rx0)))
        const bbox = [Math.floor(rx0 * scale), Math.floor(ry0 * scale), Math.ceil(rx1 * scale), Math.ceil(ry1 * scale)]
        const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false)
        pm.clear(255)
        const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pm)
        page.run(dev, mupdf.Matrix.identity)
        dev.close()
        const png = pm.asPNG()
        try { pm.destroy?.() } catch { /* egal */ }
        try { dev.destroy?.() } catch { /* egal */ }
        try { page.destroy?.() } catch { /* egal */ }
        return png
      }
      const typ = (t: string | null) => t === 'studio' ? 'apartment' : (t === 'apartment' || t === 'villa' || t === 'townhouse') ? t : 'unknown'
      const saveMeta = async (patch: Partial<Meta>) => {
        Object.assign(meta, patch)
        await sb.from('deck_assets_catalog').update({ meta }).eq('id', src.id)
      }

      // ── Etappe A: Analyse ────────────────────────────────────────────────
      if (!meta.jobs) {
        // Fruehere Zuschnitte dieses Blatts verwerfen (idempotent); Freigaben bleiben.
        await sb.from('deck_assets_catalog').delete().eq('generated_from_asset_id', src.id).neq('status', 'approved')
        const jobs: Job[] = []
        const skipped: string[] = []
        const seiten = doc ? Math.min(doc.countPages(), 6) : 1
        for (let no = 1; no <= seiten; no++) {
          let preview: Uint8Array
          const hits: TextHit[] = []
          if (doc) {
            const page = doc.loadPage(no - 1)
            const { b, w, h } = pageDims(no)
            try {
              const st = page.toStructuredText('preserve-whitespace')
              const j = JSON.parse(st.asJSON()) as { blocks?: Array<{ lines?: Array<{ bbox?: { x: number; y: number; w: number; h: number }; text?: string }> }> }
              for (const bl of j.blocks ?? []) for (const ln of bl.lines ?? []) {
                const text = String(ln.text ?? '').trim()
                if (!text || !ln.bbox) continue
                const found = unitsInText(text, units)
                if (found.length || /floor|plan|geschoss|type|typ|villa|maison|apartment|block|ground|first|second|erdgeschoss|obergeschoss/i.test(text)) {
                  hits.push({ text: text.slice(0, 60), cx: (ln.bbox.x + ln.bbox.w / 2 - b[0]) / w, cy: (ln.bbox.y + ln.bbox.h / 2 - b[1]) / h, units: found })
                }
              }
              try { st.destroy?.() } catch { /* egal */ }
            } catch (e) { console.warn('[floorplan-catalog] Text:', e instanceof Error ? e.message : String(e)) }
            const pScale = Math.min(1.2, 1100 / Math.max(1, w))
            const pix = page.toPixmap(mupdf.Matrix.scale(pScale, pScale), mupdf.ColorSpace.DeviceRGB, false, true)
            preview = pix.asPNG()
            try { pix.destroy?.() } catch { /* egal */ }
            try { page.destroy?.() } catch { /* egal */ }
          } else {
            const img = await Image.decode(rawImg!)
            const sc = Math.min(1, 1100 / img.width)
            preview = await (sc < 1 ? img.resize(Math.round(img.width * sc), Math.round(img.height * sc)) : img).encode()
          }
          const { plans, sheetNote } = await analyzePage(preview, units, hits, projName, src.label ?? '', no)
          if (!plans.length) { if (sheetNote) skipped.push(`S.${no}: ${sheetNote.slice(0, 80)}`); continue }
          // Ein Wohnungsgrundriss zeigt hoechstens ein Doppelhaus; mehr = Uebersicht.
          const echte = plans.filter(pl => pl.units.length <= 3)
          if (echte.length < plans.length) skipped.push(`S.${no}: ${plans.length - echte.length} Uebersichtsplan/-plaene verworfen`)
          // Geschoss deterministisch aus dem naechsten Plan-Titel auf dem Blatt
          // ("Ground Floor Plan", "First Floor Plan") - das Modell vertauschte es.
          const titel = hits.filter(h => /ground|erdgeschoss|first|second|third|\d(st|nd|rd|th)\s*floor|obergeschoss|dachgeschoss/i.test(h.text) && /floor|geschoss|plan/i.test(h.text))
          const geschossAus = (t: string): string => {
            const x = t.toLowerCase()
            if (/ground|erdgeschoss/.test(x)) return 'ERDGESCHOSS'
            if (/first|1st|\bog\b|obergeschoss/.test(x) && !/2|second/.test(x)) return 'OBERGESCHOSS'
            if (/second|2nd/.test(x)) return '2. OBERGESCHOSS'
            if (/third|3rd/.test(x)) return '3. OBERGESCHOSS'
            if (/roof|dach/.test(x)) return 'DACHGESCHOSS'
            return ''
          }
          for (const pl of echte) {
            const matched = pl.units.map(n => units.find(u => u.unit_key === unitKey(n))).filter((u): u is Unit => !!u)
            if (!matched.length) { skipped.push(`S.${no}: ${pl.units.join('/')} nicht im CRM`); continue }
            const clamp = (v: number) => Math.max(0, Math.min(1, Number(v) || 0))
            let x0 = clamp(pl.bbox.x0), y0 = clamp(pl.bbox.y0), x1 = clamp(pl.bbox.x1), y1 = clamp(pl.bbox.y1)
            if (x1 - x0 < 0.06 || y1 - y0 < 0.06) { skipped.push(`S.${no}: Rahmen zu klein fuer ${pl.units.join('/')}`); continue }
            const labelHits = hits.filter(h => h.units.some(n => matched.some(u => u.unit_number === n)))
            const contains = labelHits.some(h => h.cx >= x0 && h.cx <= x1 && h.cy >= y0 && h.cy <= y1)
            let status: 'classified' | 'review' = pl.confidence === 'low' ? 'review' : 'classified'
            if (labelHits.length && !contains) {
              for (const h of labelHits) { x0 = Math.min(x0, h.cx - 0.02); y0 = Math.min(y0, h.cy - 0.02); x1 = Math.max(x1, h.cx + 0.02); y1 = Math.max(y1, h.cy + 0.02) }
              status = 'review'
            }
            // Das Modell setzt den Rahmen eng (Wohnzimmer abgeschnitten, Sichtpruefung
            // 19.9.26) - grosszuegiger Rand, lieber ein Stueck Nachbarplan als ein
            // fehlender Raum.
            const mx = 0.05, my = 0.045
            x0 = clamp(x0 - mx); y0 = clamp(y0 - my); x1 = clamp(x1 + mx); y1 = clamp(y1 + my)
            let floor = pl.floor_label || ''
            if (titel.length) {
              const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
              const nah = [...titel].sort((a, b) => Math.hypot(a.cx - cx, a.cy - cy) - Math.hypot(b.cx - cx, b.cy - cy))[0]
              const g = geschossAus(nah.text)
              if (g) floor = g
            }
            jobs.push({ kind: 'crop', page: no, units: matched.map(u => u.unit_number), floor, rect: [x0, y0, x1, y1], dims: !!pl.dimensions_present, conf: pl.confidence, status, note: pl.note, labelCheck: labelHits.length ? (contains ? 'ok' : 'erweitert') : 'keine_textposition' })
          }
        }
        // Dieselbe Wohnung + dasselbe Geschoss mehrfach (Rasterblaetter ohne
        // Textpositionen, Emerald 20.9.26) → beide zur Pruefung, keiner automatisch.
        // Ebenso: ohne Textposition und nur mittlere Sicherheit → Pruefung.
        const seenKey = new Map<string, number>()
        jobs.forEach(j => { if (j.kind === 'crop') { const k = `${j.units.join('/')}|${j.floor}`; seenKey.set(k, (seenKey.get(k) ?? 0) + 1) } })
        for (const j of jobs) {
          if (j.kind !== 'crop') continue
          if ((seenKey.get(`${j.units.join('/')}|${j.floor}`) ?? 0) > 1) j.status = 'review'
          if (j.labelCheck === 'keine_textposition' && j.conf !== 'high') j.status = 'review'
        }
        // Kombi-Auftraege: je Wohnung (und je Eltern-Einheit) mit >1 Zuschnitt.
        const perUnit = new Map<string, number[]>()
        jobs.forEach((j, i) => {
          if (j.kind !== 'crop') return
          for (const n of j.units) {
            const u = units.find(x => x.unit_number === n)!
            perUnit.set(u.unit_key, [...(perUnit.get(u.unit_key) ?? []), i])
            const parent = u.parent_unit_id ? units.find(x => x.id === u.parent_unit_id) : null
            if (parent) perUnit.set(parent.unit_key, [...(perUnit.get(parent.unit_key) ?? []), i])
          }
        })
        for (const [uk, parts] of perUnit) if (parts.length > 1) jobs.push({ kind: 'combo', unitKey: uk, parts })
        await saveMeta({ jobs, report: { plans: jobs.filter(j => j.kind === 'crop').length, units: [], skipped } })
        entry.stage = 'analyse'; entry.jobs = jobs.length
        return entry
      }

      // ── Etappe B: Zuschnitte ────────────────────────────────────────────
      const jobs = meta.jobs
      const offene = jobs.map((j, i) => ({ j, i })).filter(x => x.j.kind === 'crop' && !x.j.done).slice(0, CROPS_PER_CALL)
      if (offene.length) {
        for (const { j, i } of offene) {
          if (j.kind !== 'crop') continue
          const matched = j.units.map(n => units.find(u => u.unit_number === n)).filter((u): u is Unit => !!u)
          const primary = matched[0]
          const png = await renderRegion(j.page, j.rect, 1400)
          const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
          const cropW = dv.getUint32(16), cropH = dv.getUint32(20)
          const floorSlug = (j.floor || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          const path = `floorplans/crop/${body.project_id}/${primary.unit_key}-${floorSlug}-${Date.now()}.png`
          const { error: upErr } = await sb.storage.from('deck-assets').upload(path, png, { contentType: 'image/png', upsert: true })
          if (upErr) throw new Error(`Storage: ${upErr.message}`)
          const url = `${SUPABASE_URL}${marker}${path}`
          const { data: row, error: insErr } = await sb.from('deck_assets_catalog').insert({
            project_id: body.project_id, source: 'drive', source_type: 'floorplan', primary_category: 'grundriss',
            storage_bucket: 'deck-assets', storage_path: path, storage_url: url,
            label: `${matched.map(u => u.unit_number).join('/')}${j.floor ? ` · ${j.floor}` : ''}`,
            property_type: typ(primary.type), unit_key: primary.unit_key, unit_id: primary.id, same_layout_as: matched.slice(1).map(u => u.unit_key),
            status: j.status, confidence: j.conf === 'high' ? 0.9 : j.conf === 'medium' ? 0.6 : 0.3,
            generated_from_asset_id: src.id, source_page: j.page, crop_rect: { x0: j.rect[0], y0: j.rect[1], x1: j.rect[2], y1: j.rect[3] },
            dimensions_present: j.dims, is_vector: false, floor_labels: j.floor ? [j.floor] : [],
            width: cropW, height: cropH, bytes: png.length,
            meta: { note: j.note ?? null, label_check: j.labelCheck },
          }).select('id').maybeSingle()
          if (insErr) throw new Error(`Katalog: ${insErr.message}`)
          jobs[i] = { ...j, done: true, url, assetId: String((row as { id?: string } | null)?.id ?? '') }
          meta.report!.units.push(`${matched.map(u => u.unit_number).join('/')}${j.floor ? ` (${j.floor})` : ''}`)
        }
        await saveMeta({ jobs, report: meta.report })
        entry.stage = 'zuschnitt'; entry.done = jobs.filter(j => j.done).length; entry.total = jobs.length
        return entry
      }

      // ── Etappe C: Kombi-Bilder (ein Aufruf = ein Bild) ───────────────────
      const combo = jobs.map((j, i) => ({ j, i })).find(x => x.j.kind === 'combo' && !x.j.done)
      if (combo && combo.j.kind === 'combo') {
        const u = units.find(x => x.unit_key === combo.j.unitKey)!
        const parts = combo.j.parts.map(i => jobs[i]).filter((j): j is Extract<Job, { kind: 'crop' }> => j.kind === 'crop' && !!j.done)
        if (parts.length > 1) {
          let fonts: Uint8Array[] = []
          try { fonts = await loadCiFonts() } catch { /* ohne Beschriftung */ }
          const H = 600
          const scaled: Image[] = []
          for (const p of parts) {
            const { w, h } = pageDims(p.page)
            const ratio = doc ? ((p.rect[2] - p.rect[0]) * w) / Math.max(1, (p.rect[3] - p.rect[1]) * h) : 1
            scaled.push(await Image.decode(await renderRegion(p.page, p.rect, Math.min(800, Math.max(300, Math.round(H * ratio))))))
          }
          const pad = 36, labelH = fonts.length ? 64 : 0
          const W = scaled.reduce((s, i) => s + i.width, 0) + pad * (scaled.length + 1)
          const canvas = new Image(W, Math.max(...scaled.map(i => i.height)) + labelH + pad * 2)
          canvas.fill(0xfffcf6ff)
          let x = pad
          scaled.forEach((im, k) => {
            const p = parts[k]
            const uk = (combo.j as { unitKey: string }).unitKey
            const isChild = !p.units.some(n => units.find(z => z.unit_number === n)?.unit_key === uk)
            const lab = (isChild ? `${p.units.join('/')}${p.floor ? ` · ${p.floor}` : ''}` : (p.floor || `Plan ${k + 1}`)).toUpperCase()
            if (fonts.length) {
              try { const txt = Image.renderText(fonts[0], 30, lab, 0x1a2332ff); canvas.composite(txt, x + Math.max(0, (im.width - txt.width) / 2), pad) } catch { /* ohne */ }
            }
            canvas.composite(im, x, pad + labelH)
            x += im.width + pad
          })
          const png = await canvas.encode()
          const path = `floorplans/crop/${body.project_id}/${u.unit_key}-alle-geschosse-${Date.now()}.png`
          const { error: upErr } = await sb.storage.from('deck-assets').upload(path, png, { contentType: 'image/png', upsert: true })
          if (upErr) throw new Error(`Storage: ${upErr.message}`)
          const url = `${SUPABASE_URL}${marker}${path}`
          await sb.from('deck_assets_catalog').insert({
            project_id: body.project_id, source: 'drive', source_type: 'floorplan', primary_category: 'grundriss',
            storage_bucket: 'deck-assets', storage_path: path, storage_url: url,
            label: `${u.unit_number} · ${parts.map(p => p.floor || 'Plan').join(' + ')}`,
            property_type: typ(u.type), unit_key: u.unit_key, unit_id: u.id, same_layout_as: [],
            status: parts.some(p => p.status === 'review') ? 'review' : 'classified', confidence: 0.8,
            generated_from_asset_id: src.id, dimensions_present: parts.every(p => p.dims), is_vector: false,
            floor_labels: parts.map(p => p.floor).filter(Boolean),
            width: canvas.width, height: canvas.height, bytes: png.length,
            meta: { combined_from: parts.map(p => p.assetId) },
          })
        }
        jobs[combo.i] = { ...combo.j, done: true }
        await saveMeta({ jobs })
        entry.stage = 'kombi'; entry.unit = u.unit_number
        return entry
      }

      // ── fertig ────────────────────────────────────────────────────────────
      await saveMeta({ analyzed_at: new Date().toISOString(), plans_found: meta.report?.plans ?? 0, skipped: meta.report?.skipped ?? [] })
      const { data: fresh } = await sb.from('crm_projects').select('deck_assets').eq('id', body.project_id).maybeSingle()
      const da = ((fresh as { deck_assets?: Record<string, unknown> } | null)?.deck_assets ?? {}) as Record<string, unknown>
      const prev = (da.floorplan_catalog ?? {}) as { at?: string; report?: unknown[] }
      const rep = { asset: entry.asset, plans: meta.report?.plans ?? 0, units: meta.report?.units ?? [], skipped: meta.report?.skipped ?? [] }
      const merged = body.chained && Array.isArray(prev.report) ? [...prev.report, rep] : [rep]
      await sb.from('crm_projects').update({ deck_assets: { ...da, floorplan_catalog: { at: new Date().toISOString(), report: merged } } }).eq('id', body.project_id)
      entry.stage = 'fertig'; entry.plans = rep.plans; entry.units = rep.units; entry.skipped = rep.skipped
      return entry
    }

    // Naechste Etappe (oder das naechste Blatt) im frischen Worker anstossen.
    const weiter = async () => {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/floorplan-catalog`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
          body: JSON.stringify({ project_id: body.project_id, asset_id: body.asset_id, force: false, chained: true }),
        })
      } catch (e) { console.warn('[floorplan-catalog] Verkettung:', e instanceof Error ? e.message : String(e)) }
    }

    if (body.sync === true) {
      // Synchron: Etappen nacheinander im selben Aufruf (nur fuer kleine Tests).
      const out: unknown[] = []
      for (let i = 0; i < 40; i++) {
        const e = await run()
        out.push(e)
        if (e.stage === 'fertig') break
        // Quelle neu laden (meta hat sich geaendert)
        const { data: s2 } = await sb.from('deck_assets_catalog').select('id, storage_url, label, is_vector, meta').eq('id', sources[0].id).maybeSingle()
        if (s2) sources[0] = s2 as Source
      }
      return json({ ok: true, background: false, report: out })
    }
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
    const lauf = run().then(async e => { if (e.stage !== 'fertig' || sources.length > 1) await weiter() }).catch(e => console.error('[floorplan-catalog]', e))
    if (er?.waitUntil) { er.waitUntil(lauf); return json({ ok: true, background: true, sources: sources.length }) }
    await lauf
    return json({ ok: true, background: false })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
