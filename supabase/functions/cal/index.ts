// cal — kurzer „Termin speichern"-Link. GET /functions/v1/cal?a=<appointment_id>
// liefert die .ics-Datei des Termins (Content-Type text/calendar) → beim Antippen
// öffnet sich auf iPhone/Android der Kalender mit dem Termin. Gedacht als kurzer,
// gebrandeter Link in WhatsApp (via Vercel-Rewrite /cal/:id), statt eines langen
// dreizeiligen Google-Kalender-Links.
//
// Öffentlich (kein Login): die Termin-ID ist eine UUID und nur der Empfänger hat
// den Link; ausgeliefert werden nur die Termindaten selbst.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy cal --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildIcs } from '../_shared/ics.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const a = new URL(req.url).searchParams.get('a')?.trim() ?? ''
    if (!a) return new Response('Termin-ID fehlt', { status: 400, headers: CORS })
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data } = await sb.from('crm_appointments')
      .select('id, title, start_time, end_time, description, location, location_url')
      .eq('id', a).maybeSingle()
    const appt = data as { id: string; title: string; start_time: string; end_time: string; description: string | null; location: string | null; location_url: string | null } | null
    if (!appt) return new Response('Termin nicht gefunden', { status: 404, headers: CORS })
    const ics = buildIcs({
      uid: appt.id, title: appt.title, startIso: appt.start_time, endIso: appt.end_time,
      description: appt.description ?? undefined, location: appt.location ?? undefined, url: appt.location_url ?? undefined,
    })
    return new Response(ics, { headers: {
      ...CORS,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="termin.ics"',
      'Cache-Control': 'public, max-age=300',
    } })
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 500, headers: CORS })
  }
})
