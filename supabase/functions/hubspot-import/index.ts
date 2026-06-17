// Supabase Edge Function: hubspot-import
// Importiert HubSpot-Kontakte als Leads (dedupliziert per E-Mail). Eine HubSpot-Seite
// (100 Kontakte) pro Aufruf; gibt nextAfter zurück → Caller ruft in Schleife bis null.
// Bestehende Leads werden NUR in leeren Feldern ergänzt (nichts überschrieben).
//
// Secret: HUBSPOT_TOKEN (Private App, Scope crm.objects.contacts.read)
// Body: { after?: string, dry_run?: boolean }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const rawTok = Deno.env.get('HUBSPOT_TOKEN') ?? Deno.env.get('Hubspot_Token') ?? Deno.env.get('hubspot_token')
    const token = rawTok ? rawTok.trim().replace(/^["']+|["']+$/g, '') : null
    if (!token) return json({ error: 'HUBSPOT_TOKEN nicht gesetzt (Supabase-Secret anlegen).' }, 503)
    const { after, dry_run, debug } = await req.json().catch(() => ({})) as { after?: string; dry_run?: boolean; debug?: boolean }
    if (debug) return json({ ok: true, prefix: token.slice(0, 4), len: token.length, looksPrivateApp: token.startsWith('pat-') })
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // 1) Eine HubSpot-Seite holen
    const props = 'email,firstname,lastname,phone,mobilephone,company,country'
    const url = `https://api.hubapi.com/crm/v3/objects/contacts?limit=100&archived=false&properties=${props}${after ? `&after=${encodeURIComponent(after)}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const e = await res.text().catch(() => '')
      return json({ error: `HubSpot ${res.status}: ${e.slice(0, 200)}` }, 502)
    }
    const data = await res.json() as { results?: Array<{ properties: Record<string, string> }>; paging?: { next?: { after?: string } } }
    const contacts = (data.results ?? []).map(r => r.properties)
    const nextAfter = data.paging?.next?.after ?? null

    // 2) Nur mit E-Mail (für Dedupe)
    const withEmail = contacts.map(c => ({
      email:        (clean(c.email) ?? '').toLowerCase(),
      first_name:   clean(c.firstname) ?? '',
      last_name:    clean(c.lastname) ?? '',
      phone:        clean(c.phone) ?? clean(c.mobilephone),
      whatsapp:     clean(c.mobilephone),
      company_name: clean(c.company),
      country:      clean(c.country),
    })).filter(c => c.email.includes('@'))
    const skippedNoEmail = contacts.length - withEmail.length

    let created = 0, updated = 0
    if (withEmail.length) {
      // Bestehende Leads dieser Seite laden
      const emails = [...new Set(withEmail.map(c => c.email))]
      const { data: existing } = await supabase.from('leads')
        .select('id, email, first_name, last_name, phone, whatsapp, company_name, country').in('email', emails)
      const byEmail = new Map<string, Record<string, unknown>>()
      for (const l of (existing ?? []) as Array<Record<string, unknown>>) byEmail.set(String(l.email).toLowerCase(), l)

      const toInsert: Record<string, unknown>[] = []
      const seen = new Set<string>()
      for (const c of withEmail) {
        if (seen.has(c.email)) continue   // Dedupe innerhalb der Seite
        seen.add(c.email)
        const ex = byEmail.get(c.email)
        if (ex) {
          // Nur leere Felder ergänzen — nichts überschreiben
          const patch: Record<string, unknown> = {}
          if (!ex.phone && c.phone)               patch.phone = c.phone
          if (!ex.whatsapp && c.whatsapp)         patch.whatsapp = c.whatsapp
          if (!ex.first_name && c.first_name)     patch.first_name = c.first_name
          if (!ex.last_name && c.last_name)       patch.last_name = c.last_name
          if (!ex.company_name && c.company_name) patch.company_name = c.company_name
          if (!ex.country && c.country)           patch.country = c.country
          if (Object.keys(patch).length && !dry_run) { await supabase.from('leads').update(patch).eq('id', ex.id as string); updated++ }
          else if (Object.keys(patch).length) updated++
        } else {
          toInsert.push({ first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, whatsapp: c.whatsapp, company_name: c.company_name, country: c.country, source: 'hubspot', status: 'new', language: 'de' })
        }
      }
      if (toInsert.length) {
        if (!dry_run) {
          const { error, count } = await supabase.from('leads').insert(toInsert, { count: 'exact' })
          if (error) return json({ error: `Insert: ${error.message}`, nextAfter }, 500)
          created = count ?? toInsert.length
        } else created = toInsert.length
      }
    }

    return json({ ok: true, page: contacts.length, created, updated, skippedNoEmail, nextAfter, dry_run: !!dry_run })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
