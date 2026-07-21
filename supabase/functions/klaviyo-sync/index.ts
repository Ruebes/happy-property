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
    for (const p of profiles) {
      const email = (p.attributes?.email ?? '').trim().toLowerCase()
      if (!email) continue
      gesehen++
      const a = p.attributes ?? {}
      // 1:1 uebernehmen: bekannte Felder in eigene Spalten, alles Uebrige roh in
      // properties. Klaviyo liefert je Person unterschiedlich viel — mal nur Name
      // und Mail, mal einen vollstaendigen Datensatz. Nichts soll verloren gehen.
      const felder = {
        first_name: a.first_name ?? null,
        last_name:  a.last_name ?? null,
        phone:      a.phone_number ?? null,
        organization: a.organization ?? null,
        title:      a.title ?? null,
        city:       a.location?.city ?? null,
        region:     a.location?.region ?? null,
        country:    a.location?.country ?? null,
        klaviyo_id: p.id,
        properties: a.properties ?? null,
        klaviyo_created_at: a.created ?? null,
      }
      const { data: ex } = await sb.from('newsletter_subscribers').select('id').eq('email', email).maybeSingle()
      let subId = (ex as { id?: string } | null)?.id ?? null
      if (subId) {
        // Bestehende Adresse aktualisieren: ein spaeterer Lauf darf Daten
        // ergaenzen, aber nichts Vorhandenes mit null ueberschreiben.
        const patch: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(felder)) if (v !== null && v !== undefined) patch[k] = v
        if (Object.keys(patch).length) await sb.from('newsletter_subscribers').update(patch).eq('id', subId)
      } else {
        const { data: ins } = await sb.from('newsletter_subscribers').insert({
          email, ...felder, source: `klaviyo:${row.name}`,
        }).select('id').single()
        subId = (ins as { id?: string } | null)?.id ?? null
        if (subId) neu++
      }
      if (!subId) continue
      // Doppelte Mitgliedschaft ist per Primaerschluessel ausgeschlossen; Konflikt
      // ignorieren statt vorher zu pruefen (spart einen Roundtrip je Adresse).
      const { error } = await sb.from('newsletter_list_members').insert({ list_id: row.id, subscriber_id: subId })
      if (!error) verknuepft++
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
    const key = Deno.env.get('KLAVIYO_API_KEY') ?? ''
    if (!key) return json({ error: 'KLAVIYO_API_KEY ist nicht hinterlegt. Bitte in den Supabase-Secrets eintragen.' }, 400)
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
