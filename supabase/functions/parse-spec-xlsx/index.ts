// Supabase Edge Function: parse-spec-xlsx
// Liest die Ausstattungs-/Spezifikations-XLSX eines Projekts (deck_assets.doc_urls.spec_xlsx)
// und extrahiert sie als Text → deck_assets.spec_text + crm_projects.equipment_list.
//
// Bewusst SCHLANK gehalten (nur supabase-js + xlsx): die XLSX-Library ist memory-schwer
// und trieb prepare-project-assets/docs ins „Memory limit exceeded". In dieser eigenen,
// minimalen Funktion hat sie genug Headroom.
//
// Body: { project_id }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const { project_id } = await req.json() as { project_id?: string }
    if (!project_id) return json({ error: 'project_id fehlt' }, 400)
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data } = await supabase.from('crm_projects').select('deck_assets').eq('id', project_id).maybeSingle()
    const assets = (data?.deck_assets as Record<string, unknown> | null) ?? {}
    const url = (assets.doc_urls as { spec_xlsx?: string } | undefined)?.spec_xlsx
    if (!url) return json({ ok: true, skipped: true, note: 'keine spec_xlsx' })

    const res = await fetch(url)
    if (!res.ok) return json({ error: `Download ${res.status}` }, 500)
    const bytes = new Uint8Array(await res.arrayBuffer())

    const XLSX = await import('https://esm.sh/xlsx@0.18.5')
    const wb = XLSX.read(bytes, { type: 'array' })
    const spec_text = wb.SheetNames.map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n').replace(/"/g, '').slice(0, 8000)
    if (!spec_text) return json({ ok: true, spec_chars: 0, note: 'leer' })

    const merged = { ...assets, spec_text, updated_at: new Date().toISOString() }
    await supabase.from('crm_projects').update({ deck_assets: merged, equipment_list: spec_text }).eq('id', project_id)
    return json({ ok: true, spec_chars: spec_text.length })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
