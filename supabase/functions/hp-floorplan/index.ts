// Supabase Edge Function: hp-floorplan
// Erzeugt aus dem ORIGINAL-Bauträgerplan einer Wohnung einen standardisierten
// Grundriss im Happy-Property-Stil (Creme/Navy/Koralle) — automatisch statt
// Handzeichnung (Sven 28.8.26: „Grundrisse muss ich fast immer nacharbeiten").
//
// Harte Regeln (Svens Grundriss-Standard, siehe deck_ai_rules/Memory):
//   - Wände/Türen/Fenster EXAKT wie im Original — nichts erfinden, nichts weglassen.
//   - KEINE Maßketten im generierten Bild: Higgsfield (nano banana) hält die
//     GEOMETRIE zuverlässig, halluziniert aber ZAHLEN (verifiziert 28.8.26 am
//     BAIA-Plan: 7.800 statt 7.600). Erfundene Maße sind schlimmer als keine —
//     echte Flächen kommen deterministisch als Text UNTER den Plan (planNote).
//   - Vision-Verifikation gegen das Original (Claude); bei Abweichung 1 Retry
//     mit konkreten Korrekturen, sonst als „unverifiziert" markiert.
//
// Ablauf: Quelle finden (deck_assets: unit_floorplans-Quelle, floorplans-Etagen,
// gallery grundriss) → Claude-Analyse (welcher Plan auf dem Blatt, Raumliste,
// deutsche Labels) → Higgsfield nano banana Restyle → Claude-Verify → Storage +
// deck_assets.unit_floorplans[unit] + unit_floorplan_notes[unit] + Status.
//
// Body: { project_id, unit_number, source_url?, floor_hint?, sync?, force? }
// Status/Poll: crm_projects.deck_assets.hp_floorplans[unitNorm] =
//   { status: 'running'|'done'|'error', url?, verified?, issues?, note?, at }
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { hfUploadImage, hfGenerateBytes, type HfStore } from '../_shared/higgsfield.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

type SB = ReturnType<typeof createClient>
function hfStoreFrom(sb: SB): HfStore {
  return {
    get: async (key) => (((await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()).data as { value?: string } | null)?.value ?? '').trim(),
    set: async (rows) => {
      const stamp = new Date().toISOString()
      for (const r of rows) {
        const { error } = await sb.from('connector_secrets').upsert({ ...r, updated_at: stamp }, { onConflict: 'key' })
        if (error) console.error('[hp-floorplan] Higgsfield-Secret speichern:', error.message)
      }
    },
  }
}

const normU = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

// Bild als base64 fuer Claude-Vision laden. Storage-URLs ueber die Bild-Transformation
// verkleinern (grosse Plaene sprengen sonst das Anthropic-Limit), fremde URLs roh.
function shrink(url: string, max = 1400): string {
  const marker = '/storage/v1/object/public/'
  const i = url.indexOf(marker)
  if (i < 0 || url.includes('?')) return url
  return `${url.slice(0, i)}/storage/v1/render/image/public/${url.slice(i + marker.length)}?width=${max}&height=${max}&resize=contain`
}
async function fetchB64(url: string): Promise<{ b64: string; mime: string }> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Bild nicht ladbar (${r.status}): ${url.slice(0, 120)}`)
  const mime = (r.headers.get('content-type') ?? 'image/png').split(';')[0]
  const bytes = new Uint8Array(await r.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return { b64: btoa(bin), mime: mime.startsWith('image/') ? mime : 'image/png' }
}

async function claude(tools: unknown[], toolName: string, content: unknown[]): Promise<Record<string, unknown>> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 3000, tools, tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(`Anthropic ${res.status}: ${e.error?.message ?? res.statusText}`)
  }
  const data = await res.json() as { content?: Array<{ type?: string; input?: Record<string, unknown> }> }
  return (data.content ?? []).find(c => c.type === 'tool_use')?.input ?? {}
}

const ANALYZE_TOOL = {
  name: 'emit_analysis',
  description: 'Analyse eines Bautraeger-Grundrissplans fuer eine bestimmte Wohnung.',
  input_schema: {
    type: 'object',
    properties: {
      source_index:  { type: 'integer', description: '0-basierter Index des Kandidatenbilds, das den Plan der Wohnung enthaelt. -1 wenn KEINES passt.' },
      plan_locator:  { type: 'string', description: 'Wo auf dem Blatt der richtige Plan liegt, mit Original-Beschriftung, z.B. "GROUND FLOOR PLAN, oben links". Leer wenn das Bild nur diesen einen Plan zeigt.' },
      floors:        { type: 'array', items: { type: 'object', properties: { locator: { type: 'string', description: 'Plan-Beschriftung + Lage auf dem Blatt, z.B. "TYPE A - GROUND FLOOR PLAN, oben links".' }, label: { type: 'string', description: 'Deutsches Geschoss-Label: ERDGESCHOSS, OBERGESCHOSS, DACHGESCHOSS …' } }, required: ['locator', 'label'] }, description: 'ALLE Wohn-Geschosse dieser Einheit (Villa/Maisonette = mehrere!). Reine Dach-/Roof-Plaene ohne Wohnraeume weglassen. Bei einer eingeschossigen Wohnung genau 1 Eintrag.' },
      rooms:         { type: 'array', items: { type: 'object', properties: { original: { type: 'string' }, german: { type: 'string' } }, required: ['german'] }, description: 'Alle Raeume dieses Plans mit deutschem Label (WOHNBEREICH, KUECHE, SCHLAFZIMMER 1, BAD, EN-SUITE, WC, HWR, UEBERDACHTE VERANDA, DACHTERRASSE ...).' },
      outdoor:       { type: 'array', items: { type: 'string' }, description: 'Deutsche Labels der Aussenflaechen (Veranda/Terrasse/Innenhof/Dachgarten), die koralle eingefaerbt werden sollen.' },
      dims:          { type: 'array', items: { type: 'string' }, description: 'Bis zu 8 reale Raummasse EXAKT aus dem Plan abgelesen, Format "Wohnbereich 6,70 x 3,80 m". NUR was wirklich lesbar dasteht, nichts schaetzen. Leer wenn keine Masse im Plan.' },
      floor_label:   { type: 'string', description: 'Deutsches Geschoss-Label fuer den Titel, z.B. ERDGESCHOSS, OBERGESCHOSS, 2. OBERGESCHOSS, DACHGESCHOSS. Leer wenn unklar.' },
      confidence:    { type: 'string', enum: ['high', 'medium', 'low'] },
      note:          { type: 'string', description: 'Kurzer Hinweis, falls etwas unklar ist.' },
    },
    required: ['source_index', 'rooms', 'confidence'],
  },
}

const VERIFY_TOOL = {
  name: 'emit_verdict',
  description: 'Vergleich Original-Bauplan vs. neu gezeichneter Marketing-Grundriss.',
  input_schema: {
    type: 'object',
    properties: {
      geometry_ok: { type: 'boolean', description: 'true wenn ALLE Waende, Tueren, Fenster, Treppen und Raumproportionen dem Original entsprechen (kleine Stilabweichungen ok).' },
      issues:      { type: 'array', items: { type: 'string' }, description: 'Konkrete Abweichungen, je 1 Satz, praezise verortet ("Wand zwischen Kueche und WC fehlt", "Tuer des Bads oeffnet in den falschen Raum").' },
      severity:    { type: 'string', enum: ['none', 'minor', 'major'], description: 'major = Raumaufteilung falsch/erfunden; minor = Detail (Moebel, Fensterbreite); none = passt.' },
    },
    required: ['geometry_ok', 'severity'],
  },
}

function stylePrompt(title: string, rooms: string[], outdoor: string[], floors: Array<{ locator: string; label: string }>, planLocator: string, issues?: string[]): string {
  // Mehrgeschossige Einheiten (Villa/Maisonette): ALLE Wohn-Geschosse als Panels
  // nebeneinander in EINEM Bild — sonst wuerfelt das Modell sich ein Geschoss aus
  // (28.8.26: Lauf 1 nahm das OG, Lauf 2 das EG derselben Villa).
  const loc = floors.length > 1
    ? `The reference sheet contains several plans and a title block. Draw ALL of these plans as separate panels side by side in ONE image, each panel with its German floor label above it: ${floors.map(f => `${f.label} (source: ${f.locator})`).join('; ')}. Ignore everything else on the sheet (roof plans, title block, notes).`
    : (floors[0]?.locator || planLocator)
      ? `The reference sheet may contain several plans and a title block. Use ONLY this plan: ${floors[0]?.locator || planLocator}. Ignore everything else on the sheet.`
      : 'The reference shows one floor plan.'
  return [
    `Redraw this architectural floor plan as a clean, premium real-estate marketing floor plan. ${loc}`,
    'STRICT GEOMETRY RULES: Keep the wall geometry EXACTLY as in the reference — every wall, wall opening, door position, door swing direction, window and staircase must stay in exactly the same position and proportion. Do not invent, move, add or remove any walls or rooms. An open-plan living/kitchen/dining area stays ONE open room — never draw walls that are not in the reference.',
    'NO DIMENSIONS: Do not write any dimension numbers, measurement chains, grid bubbles, section markers or architect annotations. Only room labels.',
    `Style: cream background (#fffcf6), walls filled in dark navy (#1a2332), thin interior hairlines in navy, outdoor areas (${outdoor.join(', ') || 'veranda/terrace'}) tinted soft coral (#ff795d, low opacity), furniture as minimal light-grey line icons exactly where the reference shows them.`,
    `Room labels in German, uppercase, small elegant sans-serif: ${rooms.join(', ')}.`,
    `Elegant serif title at the top: '${title}'. Flat 2D top-down vector look, no 3D, no shadows, no photorealism, generous cream margins.`,
  ].join(' ')
}

// Korrektur-Durchlauf: die (fast richtige) Vorversion als 2. Referenz mitgeben und
// NUR die von der Verifikation gefundenen Fehler beheben — Neuzeichnen von Null
// wuerfelt sonst neue Abweichungen (28.8.26 am BAIA-Test gesehen).
function fixPrompt(title: string, issues: string[]): string {
  return [
    'Reference image 1 is the authoritative ORIGINAL architect floor plan. Reference image 2 is a stylized marketing floor plan that is almost correct.',
    `Reproduce reference image 2 EXACTLY — identical style, colors, cream background, navy walls, room labels and the title '${title}' — but correct ONLY these errors so the geometry matches reference image 1:`,
    issues.map((s, i) => `(${i + 1}) ${s}`).join(' '),
    'Change nothing else. Do not add any dimension numbers or annotations.',
  ].join(' ')
}

// nano banana pro bevorzugt (beste Text-/Diagramm-Treue), Fallback-Kette falls der
// Dev-API-Jobtyp anders heisst (422 leakt die Enum, aber wir raten nicht zur Laufzeit).
const JOB_TYPES = ['nano_banana_pro', 'nano_banana_2', 'nano_banana']
async function generateStyled(store: HfStore, refIds: string[], prompt: string, aspect = '4:3'): Promise<Uint8Array> {
  let lastErr = ''
  for (const jt of JOB_TYPES) {
    try {
      return await hfGenerateBytes(store, jt, { prompt, aspect_ratio: aspect, image_references: refIds.map(id => ({ id })) })
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      // Unbekannter Jobtyp/Parameter → naechsten probieren; echte Jobfehler weiterreichen.
      if (!/422|submit/i.test(lastErr)) throw e
    }
  }
  throw new Error(`Higgsfield: kein nano-banana-Jobtyp akzeptiert (${lastErr.slice(0, 160)})`)
}

async function setStatus(sb: SB, projectId: string, unitKey: string, patch: Record<string, unknown>): Promise<void> {
  const { data } = await sb.from('crm_projects').select('deck_assets').eq('id', projectId).maybeSingle()
  const da = ((data as { deck_assets?: Record<string, unknown> } | null)?.deck_assets ?? {}) as Record<string, unknown>
  const hp = (da.hp_floorplans ?? {}) as Record<string, unknown>
  hp[unitKey] = { ...(hp[unitKey] as Record<string, unknown> ?? {}), ...patch, at: new Date().toISOString() }
  await sb.from('crm_projects').update({ deck_assets: { ...da, hp_floorplans: hp } }).eq('id', projectId)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)
  try {
    const body = await req.json() as { project_id?: string; unit_number?: string; source_url?: string; floor_hint?: string; sync?: boolean; force?: boolean }
    if (!body.project_id || !body.unit_number) return json({ error: 'project_id + unit_number noetig' }, 400)
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE)
    const unitKey = normU(body.unit_number)

    const { data: proj } = await sb.from('crm_projects').select('id, name, deck_assets').eq('id', body.project_id).maybeSingle()
    if (!proj) return json({ error: 'Projekt nicht gefunden' }, 404)
    const projName = (proj as { name?: string }).name ?? ''
    const da = ((proj as { deck_assets?: Record<string, unknown> }).deck_assets ?? {}) as Record<string, unknown>

    const { data: unitRow } = await sb.from('crm_project_units')
      .select('id, unit_number, type, bedrooms, size_sqm, terrace_sqm, floor, block')
      .eq('project_id', body.project_id).ilike('unit_number', body.unit_number).maybeSingle()
    const unit = unitRow as { id?: string; unit_number?: string; type?: string | null; bedrooms?: number | null; size_sqm?: number | null; terrace_sqm?: number | null; floor?: number | null; block?: string | null } | null

    // ── Quell-Kandidaten einsammeln ─────────────────────────────────────────────
    // deck_assets.floorplans kommt in ZWEI Formen vor: Array (Drive-Import, Etagen)
    // ODER Record key→URL (z.B. Kuutio BAIA 'type-a'→PDF). Beim Record zuerst die
    // Keys, die zu Block/Typ der Wohnung passen (BAIA: Block A ↔ type-a).
    const candidates: string[] = []
    if (body.source_url) candidates.push(body.source_url)
    else {
      const fps = da.floorplans
      if (Array.isArray(fps)) {
        for (const f of fps) {
          const u = typeof f === 'string' ? f : (f as { url?: string })?.url
          if (u) candidates.push(u)
        }
      } else if (fps && typeof fps === 'object') {
        const entries = Object.entries(fps as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as Array<[string, string]>
        const hints = [unitKey, normU(unit?.block ?? ''), normU(unit?.type ?? '')].filter(Boolean)
        entries.sort((a, b) => {
          const score = (k: string) => hints.some(h => h && (normU(k).includes(h) || h.includes(normU(k)))) ? 0 : 1
          return score(a[0]) - score(b[0])
        })
        candidates.push(...entries.map(e => e[1]))
      }
      const ufp = (da.unit_floorplans ?? {}) as Record<string, unknown>
      const own = ufp[body.unit_number!] ?? ufp[unitKey]
      if (typeof own === 'string' && !/\/floorplans\/hp\//.test(own)) candidates.unshift(own)
      const gal = Array.isArray(da.gallery) ? da.gallery as Array<{ url?: string; category?: string }> : []
      for (const g of gal) if (g.category === 'grundriss' && g.url) candidates.push(g.url)
      // Bereits hinterlegter Roh-Plan der Einheit (Portal-Spalte) als letzter Kandidat.
      const { data: u2 } = await sb.from('crm_project_units').select('floorplan_url').eq('project_id', body.project_id).ilike('unit_number', body.unit_number).maybeSingle()
      const fu = (u2 as { floorplan_url?: string } | null)?.floorplan_url
      if (fu && !/\/floorplans\/hp\//.test(fu)) candidates.push(fu)
    }
    const cand = [...new Set(candidates)].slice(0, 4)
    if (!cand.length) return json({ error: 'Keine Grundriss-Quelle gefunden - source_url mitgeben oder Assets importieren (Aus Drive laden).' }, 422)

    await setStatus(sb, body.project_id, unitKey, { status: 'running', unit: body.unit_number })

    const run = async () => {
      try {
        // ── 0) Quellen laden. PDFs (Architekten-Plaene, z.B. Kuutio) per mupdf-wasm
        // rastern — bis zu 3 Seiten je PDF werden eigene Kandidaten.
        type Source = { png: Uint8Array; b64: string; mime: string; from: string }
        const sources: Source[] = []
        const toB64 = (bytes: Uint8Array) => {
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          return btoa(bin)
        }
        for (const u of cand) {
          if (sources.length >= 6) break
          try {
            if (/\.pdf(\?|$)/i.test(u)) {
              const pdfBytes = new Uint8Array(await (await fetch(u)).arrayBuffer())
              if (pdfBytes.length > 25_000_000) continue   // Edge-Speicher schuetzen
              const mupdf = await import('npm:mupdf@1.26.4')
              const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf')
              const n = Math.min(doc.countPages(), 3)
              for (let p = 0; p < n && sources.length < 6; p++) {
                const page = doc.loadPage(p)
                const b = page.getBounds()
                const scale = Math.min(3, 2000 / Math.max(1, b[2] - b[0]))
                const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
                const png = pix.asPNG()
                sources.push({ png, b64: toB64(png), mime: 'image/png', from: `${u}#page=${p + 1}` })
              }
            } else {
              const im = await fetchB64(shrink(u))
              const raw = new Uint8Array(await (await fetch(u)).arrayBuffer())
              sources.push({ png: raw, b64: im.b64, mime: im.mime, from: u })
            }
          } catch (e) {
            console.warn(`[hp-floorplan] Quelle uebersprungen (${u.slice(-40)}):`, e instanceof Error ? e.message : String(e))
          }
        }
        if (!sources.length) throw new Error('Keine Grundriss-Quelle ladbar (PDF/Bild).')

        // ── 1) Analyse: richtiges Blatt/Plan + Raeume + echte Masse ──────────────
        const imgs = sources.map(s => ({ b64: s.b64, mime: s.mime }))
        const unitDesc = [
          `Wohnung/Einheit: ${body.unit_number}`,
          unit?.type ? `Typ: ${unit.type}` : '',
          unit?.block ? `Block: ${unit.block}` : '',
          unit?.floor != null ? `Etage: ${unit.floor}` : '',
          unit?.bedrooms != null ? `Schlafzimmer: ${unit.bedrooms}` : '',
          body.floor_hint ? `Hinweis: ${body.floor_hint}` : '',
        ].filter(Boolean).join(' · ')
        const analysis = await claude([ANALYZE_TOOL], 'emit_analysis', [
          ...imgs.map((im, i) => [{ type: 'text', text: `Kandidat ${i}:` }, { type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } }]).flat(),
          { type: 'text', text: `Projekt „${projName}". ${unitDesc}.\nFinde das Kandidatenbild + den Plan darauf, der GENAU diese Wohnung (bzw. ihren Haustyp) zeigt. Liste in floors ALLE Wohn-Geschosse der Einheit (Villa/Maisonette hat mehrere; reine Dach-/Roof-Plaene weglassen). Lies Raumliste und — falls im Plan lesbar — reale Masse ab. Nichts schaetzen, nichts erfinden.` },
        ]) as { source_index?: number; plan_locator?: string; floors?: Array<{ locator?: string; label?: string }>; rooms?: Array<{ german?: string }>; outdoor?: string[]; dims?: string[]; floor_label?: string; confidence?: string; note?: string }

        const si = Number(analysis.source_index)
        if (!(si >= 0 && si < sources.length)) throw new Error(`Kein Kandidat zeigt den Plan von ${body.unit_number}${analysis.note ? ` (${analysis.note})` : ''}`)
        const srcUrl = sources[si].from
        const rooms = (analysis.rooms ?? []).map(r => r.german).filter((x): x is string => !!x)
        const outdoor = analysis.outdoor ?? []
        const floors = (analysis.floors ?? []).filter(f => f?.locator && f?.label).map(f => ({ locator: String(f.locator), label: String(f.label) }))
        if (!floors.length && (analysis.plan_locator || analysis.floor_label)) floors.push({ locator: analysis.plan_locator ?? '', label: analysis.floor_label ?? '' })
        const titleUnit = unit?.type && /villa|haus/i.test(unit.type) ? `${body.unit_number}` : `WOHNUNG ${body.unit_number}`
        // Kein Gedankenstrich in Kundenmaterial (Svens Regel) - Punkt-Trenner.
        // Geschoss nur im Titel, wenn es genau EINES ist (bei mehreren stehen die
        // Labels ueber den Panels im Bild).
        const floorSuffix = floors.length === 1 && floors[0].label ? ` · ${floors[0].label}` : ''
        const title = `${projName.toUpperCase()} · ${titleUnit}${floorSuffix}`
        const aspect = floors.length > 1 ? '16:9' : '4:3'

        // ── 2) Higgsfield-Restyle (max. 2 Versuche mit Vision-Verifikation) ─────
        const store = hfStoreFrom(sb)
        const refId = await hfUploadImage(store, sources[si].png, sources[si].mime)

        let outBytes: Uint8Array | null = null
        let verified = false
        let issues: string[] = []
        for (let attempt = 0; attempt < 2; attempt++) {
          const bytes = attempt === 0 || !outBytes
            ? await generateStyled(store, [refId], stylePrompt(title, rooms, outdoor, floors, analysis.plan_locator ?? ''), aspect)
            : await generateStyled(store, [refId, await hfUploadImage(store, outBytes, 'image/png')], fixPrompt(title, issues), aspect)
          // Verify: Original vs. Ergebnis (beide verkleinert als base64).
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          const orig = imgs[si]
          const verdict = await claude([VERIFY_TOOL], 'emit_verdict', [
            { type: 'text', text: 'BILD 1 = Original-Bauplan (massgeblich):' },
            { type: 'image', source: { type: 'base64', media_type: orig.mime, data: orig.b64 } },
            { type: 'text', text: 'BILD 2 = neu gezeichneter Marketing-Grundriss:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: btoa(bin) } },
            { type: 'text', text: `Pruefe ${floors.length > 1 ? `JEDES Panel in Bild 2 gegen seinen Quellplan (${floors.map(f => `${f.label} = ${f.locator}`).join('; ')})` : `NUR den Plan „${floors[0]?.locator || analysis.plan_locator || 'auf dem Original'}" gegen Bild 2`}: Stimmen Waende, Tueroeffnungen samt Schwenkrichtung, Fenster, Treppe und Raumproportionen ueberein? Wurde etwas erfunden oder weggelassen? Stil/Farben/fehlende Masse sind KEINE Fehler.` },
          ]) as { geometry_ok?: boolean; issues?: string[]; severity?: string }
          outBytes = bytes
          issues = verdict.issues ?? []
          if (verdict.geometry_ok || verdict.severity === 'none' || verdict.severity === 'minor') { verified = verdict.geometry_ok === true; break }
        }
        if (!outBytes) throw new Error('Keine Generierung erhalten')

        // ── 3) Speichern + Mapping + deterministische Flaechen-Note ─────────────
        const path = `floorplans/hp/${body.project_id}/${unitKey}-${Date.now()}.png`
        const { error: upErr } = await sb.storage.from('deck-assets').upload(path, outBytes, { contentType: 'image/png', upsert: true })
        if (upErr) throw new Error(`Storage: ${upErr.message}`)
        const url = sb.storage.from('deck-assets').getPublicUrl(path).data.publicUrl

        const fmt = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 })
        const noteParts = [
          'Grundriss schematisch im Happy-Property-Stil nach Originalplan des Bauträgers.',
          unit?.size_sqm ? `Wohnfläche ca. ${fmt(Number(unit.size_sqm))} m²` : '',
          unit?.terrace_sqm ? `Außenfläche ca. ${fmt(Number(unit.terrace_sqm))} m²` : '',
          (analysis.dims?.length ? `Maße lt. Plan: ${analysis.dims.slice(0, 6).join(' · ')}` : ''),
        ].filter(Boolean)
        // Kundentext: keine KI-Gedankenstriche (Svens Regel).
        const note = noteParts.join(' · ').replace(/\.\s·/g, ' ·').replace(/[–—]/g, '-')

        // deck_assets aktualisieren: unit_floorplans (liest generate-deck) + Notes + Status.
        const { data: fresh } = await sb.from('crm_projects').select('deck_assets').eq('id', body.project_id).maybeSingle()
        const daF = ((fresh as { deck_assets?: Record<string, unknown> } | null)?.deck_assets ?? {}) as Record<string, unknown>
        const ufp = (daF.unit_floorplans ?? {}) as Record<string, string>
        ufp[body.unit_number!] = url
        const ufn = (daF.unit_floorplan_notes ?? {}) as Record<string, string>
        ufn[body.unit_number!] = note
        const hp = (daF.hp_floorplans ?? {}) as Record<string, unknown>
        hp[unitKey] = { status: 'done', unit: body.unit_number, url, source: srcUrl, verified, issues, note, at: new Date().toISOString() }
        await sb.from('crm_projects').update({ deck_assets: { ...daF, unit_floorplans: ufp, unit_floorplan_notes: ufn, hp_floorplans: hp } }).eq('id', body.project_id)
        if (unit?.id) await sb.from('crm_project_units').update({ floorplan_url: url }).eq('id', unit.id)
        console.log(`[hp-floorplan] ${projName} ${body.unit_number}: ok (verified=${verified}${issues.length ? `, issues: ${issues.join('; ').slice(0, 200)}` : ''})`)
        return { url, verified, issues, note, source: srcUrl }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[hp-floorplan] ${body.unit_number}:`, msg)
        await setStatus(sb, body.project_id!, unitKey, { status: 'error', error: msg.slice(0, 300) })
        throw e
      }
    }

    // Voller Lauf (2 Claude-Calls + 1-2 Higgsfield-Jobs) dauert 1-4 Min → Standard
    // Hintergrund + Status-Polling ueber deck_assets.hp_floorplans (Muster nightly).
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
    if (body.sync !== true && er?.waitUntil) {
      er.waitUntil(run().catch(() => {}))
      return json({ ok: true, background: true, unit: body.unit_number })
    }
    const out = await run()
    return json({ ok: true, ...out })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
