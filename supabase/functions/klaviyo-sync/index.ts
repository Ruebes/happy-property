// klaviyo-sync — holt Listen und Abonnenten aus Klaviyo ins CRM.
//
// Sven hat die Adressen aus Webinar-Anmeldungen, Leadmagneten und Newsletter
// jahrelang in Klaviyo gesammelt. Die sollen hier nutzbar sein, ohne sie in die
// Kundenliste zu kippen: Abonnenten landen in newsletter_subscribers, NICHT in
// leads (eine Webinar-Anmeldung ist kein Vertriebs-Lead).
//
// Actions:
//   { action: 'lists' }                    → Listen aus Klaviyo holen + in newsletter_lists spiegeln
//   { action: 'sync', list_id? }           → Abonnenten einer Liste (oder aller) nachziehen
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KLAVIYO_API_KEY (Private Key, pk_…)
// Deploy: supabase functions deploy klaviyo-sync --no-verify-jwt
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const API = 'https://a.klaviyo.com/api'
// Klaviyo verlangt eine feste Versionsangabe; ohne revision-Header antwortet es 400.
const REVISION = '2024-10-15'

interface KlaviyoList { id: string; attributes?: { name?: string } }
interface KlaviyoProfile {
  id: string
  attributes?: {
    email?: string; first_name?: string; last_name?: string; phone_number?: string
    organization?: string; title?: string; created?: string
    location?: { city?: string; region?: string; country?: string }
    properties?: Record<string, unknown>
    subscriptions?: Record<string, unknown>
  }
}

async function kFetch(path: string, key: string): Promise<Record<string, unknown>> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: REVISION, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Klaviyo ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return await res.json() as Record<string, unknown>
}

/** Listen holen und in newsletter_lists spiegeln (Name aktualisieren, neue anlegen). */
async function syncLists(sb: SupabaseClient, key: string) {
  const d = await kFetch('/lists/', key)
  const lists = (d.data ?? []) as KlaviyoList[]
  let neu = 0, aktualisiert = 0
  for (const l of lists) {
    const name = l.attributes?.name ?? l.id
    const { data: ex } = await sb.from('newsletter_lists').select('id').eq('klaviyo_list_id', l.id).maybeSingle()
    if (ex) {
      await sb.from('newsletter_lists').update({ name }).eq('klaviyo_list_id', l.id); aktualisiert++
    } else {
      // Neue Listen kommen INAKTIV rein: erst wenn Sven sie freigibt, zaehlen sie
      // fuer den Newsletter. Sonst wuerde eine frisch angelegte Klaviyo-Liste beim
      // naechsten Versand ungefragt mitgeschickt.
      await sb.from('newsletter_lists').insert({ name, source: 'klaviyo', klaviyo_list_id: l.id, active: false }); neu++
    }
  }
  return { gefunden: lists.length, neu, aktualisiert }
}

/** Abonnenten einer Klaviyo-Liste nachziehen (paginiert). */
async function syncMembers(sb: SupabaseClient, key: string, row: { id: string; klaviyo_list_id: string; name: string }) {
  // additional-fields[profile]=predictive_analytics waere Extra-Last; die
  // Standardantwort enthaelt bereits location, properties, organization, title.
  let url = `/lists/${row.klaviyo_list_id}/profiles/?page[size]=100`
  let gesehen = 0, neu = 0, verknuepft = 0, seiten = 0
  while (url && seiten < 100) {                       // Sicherung gegen Endlosschleife
    const d = await kFetch(url, key)
    const profiles = (d.data ?? []) as KlaviyoProfile[]
    // Ganze Seite in EINEM Aufruf uebernehmen. Vorher waren es drei Roundtrips je
    // Adresse (pruefen, schreiben, verknuepfen) — damit lief der Import bei 10 Listen
    // in die Zeitgrenze der Edge Function. Die Merge-Logik (nichts Vorhandenes mit
    // NULL ueberschreiben) sitzt jetzt in hp_klaviyo_upsert.
    const rows = profiles.map(p => {
      const a = p.attributes ?? {}
      return {
        email: (a.email ?? '').trim().toLowerCase(),
        first_name: a.first_name ?? null, last_name: a.last_name ?? null,
        phone: a.phone_number ?? null, organization: a.organization ?? null,
        title: a.title ?? null,
        city: a.location?.city ?? null, region: a.location?.region ?? null, country: a.location?.country ?? null,
        klaviyo_id: p.id, properties: a.properties ?? null, klaviyo_created_at: a.created ?? null,
      }
    }).filter(r => r.email)
    gesehen += rows.length
    if (rows.length) {
      const { data: res, error } = await sb.rpc('hp_klaviyo_upsert', { p_list_id: row.id, p_rows: rows })
      if (error) throw new Error(`Uebernahme: ${error.message}`)
      const r0 = (res as Array<{ neu: number; gesamt: number }> | null)?.[0]
      neu += r0?.neu ?? 0
      verknuepft += r0?.gesamt ?? 0
    }
    url = ((d.links as Record<string, string> | undefined)?.next) ?? ''
    seiten++
  }
  await sb.from('newsletter_lists').update({ synced_at: new Date().toISOString() }).eq('id', row.id)
  return { liste: row.name, gesehen, neu, verknuepft }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    // Beide Schreibweisen akzeptieren: Sven hat das Secret als „Klaviyo" angelegt.
    // Lieber hier nachgeben als ihn den Schluessel ein zweites Mal eintragen lassen.
    const key = (Deno.env.get('KLAVIYO_API_KEY') || Deno.env.get('Klaviyo') || Deno.env.get('KLAVIYO') || '').trim()
    if (!key) return json({ error: 'Kein Klaviyo-Schluessel hinterlegt (KLAVIYO_API_KEY oder Klaviyo).' }, 400)
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as { action?: string; list_id?: string }

    if (body.action === 'lists') return json({ ok: true, ...(await syncLists(sb, key)) })

    if (body.action === 'sync') {
      let qy = sb.from('newsletter_lists').select('id, klaviyo_list_id, name').not('klaviyo_list_id', 'is', null)
      if (body.list_id) qy = qy.eq('id', body.list_id)
      const { data: rows } = await qy
      const out = []
      for (const r of (rows ?? []) as Array<{ id: string; klaviyo_list_id: string; name: string }>) {
        try { out.push(await syncMembers(sb, key, r)) }
        catch (e) { out.push({ liste: r.name, fehler: e instanceof Error ? e.message : String(e) }) }
      }
      return json({ ok: true, listen: out })
    }

    return json({ error: 'unbekannte action' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[klaviyo-sync]', msg)
    return json({ error: msg }, 500)
  }
})
