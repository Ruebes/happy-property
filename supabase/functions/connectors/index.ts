// connectors — Status, Test und Pflege aller Anbindungen (Einstellungen → Connectoren).
// Secrets verlassen NIE den Server: getestet wird hier, das Frontend bekommt nur ok/detail.
// Änderbare Tokens (z.B. LinkedIn) liegen in connector_secrets (RLS deny-all).
// Zugriff nur für eingeloggte Admins/Verwalter (JWT wird gegen profiles geprüft).
//
//   POST { action:'status' }                → alle Connectoren mit ok + Detail
//   POST { action:'set', key, value }       → änderbaren Token speichern (EDITABLE)
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ die getesteten Keys)
// Deploy:  supabase functions deploy connectors --no-verify-jwt
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Im CRM änderbare Tokens (Ablage in connector_secrets, Env als Fallback).
const EDITABLE = new Set(['LINKEDIN_ACCESS_TOKEN', 'META_ACCESS_TOKEN'])

async function secretOf(sb: SupabaseClient, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return (data as { value: string } | null)?.value ?? Deno.env.get(key) ?? ''
}

type Check = { key: string; label: string; editable?: boolean; run: (sb: SupabaseClient) => Promise<{ ok: boolean; detail: string }> }
const timeout = (ms: number) => ({ signal: AbortSignal.timeout(ms) })

const CHECKS: Check[] = [
  { key: 'META', label: 'Meta (Facebook & Instagram)', run: async () => {
    const tok = Deno.env.get('META_ACCESS_TOKEN') ?? ''
    if (!tok) return { ok: false, detail: 'Kein Token hinterlegt.' }
    const me = await fetch(`https://graph.facebook.com/v21.0/me?fields=name&access_token=${tok}`, timeout(8000)).then(r => r.json()).catch(e => ({ error: { message: String(e) } }))
    if (me.error) return { ok: false, detail: me.error.message?.slice(0, 120) ?? 'Fehler' }
    const acc = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=name,instagram_business_account&access_token=${tok}`, timeout(8000)).then(r => r.json()).catch(() => null)
    const pages = acc?.data?.length ?? 0
    const ig = acc?.data?.some((p: { instagram_business_account?: unknown }) => p.instagram_business_account)
    return { ok: true, detail: `Verbunden als ${me.name}${pages ? ` · ${pages} Seite(n)${ig ? ' + Instagram' : ''}` : ' · KEINE Seite (Posten braucht Seiten-Zugriff)'}` }
  } },
  { key: 'LINKEDIN_ACCESS_TOKEN', label: 'LinkedIn', editable: true, run: async (sb) => {
    const tok = await secretOf(sb, 'LINKEDIN_ACCESS_TOKEN')
    if (!tok) return { ok: false, detail: 'Noch nicht verbunden — Token hier eintragen.' }
    const me = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tok}` }, ...timeout(8000) }).then(r => r.ok ? r.json() : null).catch(() => null)
    return me?.sub ? { ok: true, detail: `Verbunden als ${me.name ?? me.sub}` } : { ok: false, detail: 'Token ungültig oder abgelaufen.' }
  } },
  { key: 'OPENAI', label: 'OpenAI (Bilder)', run: async () => {
    const tok = Deno.env.get('OPENAI_API_KEY') ?? ''
    if (!tok) return { ok: false, detail: 'Kein Schlüssel hinterlegt.' }
    const r = await fetch('https://api.openai.com/v1/models?limit=1', { headers: { Authorization: `Bearer ${tok}` }, ...timeout(8000) }).catch(() => null)
    return r?.ok ? { ok: true, detail: 'Schlüssel gültig.' } : { ok: false, detail: `Schlüssel abgelehnt (HTTP ${r?.status ?? '—'}).` }
  } },
  { key: 'ANTHROPIC', label: 'Claude (KI-Texte & Recherche)', run: async () => {
    const tok = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!tok) return { ok: false, detail: 'Kein Schlüssel hinterlegt.' }
    const r = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': tok, 'anthropic-version': '2023-06-01' }, ...timeout(8000) }).catch(() => null)
    return r?.ok ? { ok: true, detail: 'Schlüssel gültig.' } : { ok: false, detail: `Schlüssel abgelehnt (HTTP ${r?.status ?? '—'}).` }
  } },
  { key: 'SMTP', label: 'E-Mail-Versand (IONOS)', run: async () => {
    const u = Deno.env.get('SMTP_USER') ?? ''
    return u ? { ok: true, detail: `Versand über ${u}` } : { ok: false, detail: 'SMTP_USER fehlt.' }
  } },
  { key: 'IMAP', label: 'Posteingang (IMAP info@)', run: async () => {
    const u = Deno.env.get('IMAP_USER') ?? ''
    return u ? { ok: true, detail: `Holt Mails von ${u}` } : { ok: false, detail: 'IMAP_USER fehlt.' }
  } },
  { key: 'TIMELINES', label: 'WhatsApp (TimelinesAI)', run: async () => {
    const tok = Deno.env.get('TIMELINES_API_KEY') ?? ''
    return tok ? { ok: true, detail: 'Schlüssel hinterlegt (Versand aktiv).' } : { ok: false, detail: 'TIMELINES_API_KEY fehlt.' }
  } },
  { key: 'GOOGLE_SA', label: 'Google Drive & Kalender (Service-Account)', run: async () => {
    const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? ''
    try { const j = JSON.parse(raw); return { ok: true, detail: `Aktiv als ${j.client_email}` } }
    catch { return { ok: false, detail: 'Service-Account-JSON fehlt/ungültig.' } }
  } },
  { key: 'KLAVIYO', label: 'Klaviyo (Alt-Import)', run: async () => {
    const tok = Deno.env.get('KLAVIYO_API_KEY') ?? Deno.env.get('Klaviyo') ?? ''
    return tok ? { ok: true, detail: 'Schlüssel hinterlegt.' } : { ok: false, detail: 'Kein Schlüssel — eigener Klaviyo-Ersatz läuft unabhängig.' }
  } },
  { key: 'REVOLUT', label: 'Revolut Business', run: async () => {
    const c = Deno.env.get('REVOLUT_CLIENT_ID') ?? ''
    return c ? { ok: true, detail: 'Zugang hinterlegt (täglicher Zahlungsabgleich).' } : { ok: false, detail: 'Zugang fehlt.' }
  } },
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    // Nur eingeloggte Admins/Verwalter (JWT des Aufrufers prüfen)
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: userData } = await sb.auth.getUser(jwt)
    const uid = userData?.user?.id
    if (!uid) return json({ error: 'Nicht angemeldet.' }, 401)
    const { data: prof } = await sb.from('profiles').select('role').eq('id', uid).maybeSingle()
    const role = (prof as { role?: string } | null)?.role
    if (role !== 'admin' && role !== 'verwalter') return json({ error: 'Keine Berechtigung.' }, 403)

    const body = await req.json().catch(() => ({})) as { action?: string; key?: string; value?: string }

    if (body.action === 'status') {
      const results = await Promise.all(CHECKS.map(async c => {
        try { const r = await c.run(sb); return { key: c.key, label: c.label, editable: !!c.editable, ...r } }
        catch (e) { return { key: c.key, label: c.label, editable: !!c.editable, ok: false, detail: (e as Error).message.slice(0, 120) } }
      }))
      return json({ ok: true, connectors: results })
    }

    if (body.action === 'set') {
      const key = (body.key ?? '').trim()
      if (!EDITABLE.has(key)) return json({ error: 'Dieser Connector ist hier nicht änderbar.' }, 400)
      const value = (body.value ?? '').trim()
      if (!value) return json({ error: 'Wert fehlt.' }, 400)
      const { error } = await sb.from('connector_secrets').upsert({ key, value, updated_at: new Date().toISOString() })
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true })
    }

    return json({ error: 'Unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[connectors]', msg)
    return json({ error: msg }, 500)
  }
})
