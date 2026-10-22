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
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { getWaProvider, setWaProvider, evoConfig, evoConnectionState, evoNumber } from '../_shared/waProvider.ts'
import { gadsAccessToken, gadsListAccessible, gadsCustomerInfo, cleanCustomerId } from '../_shared/googleAds.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Im CRM änderbare Tokens (Ablage in connector_secrets, Env als Fallback).
const EDITABLE = new Set(['LINKEDIN_ACCESS_TOKEN', 'META_ACCESS_TOKEN', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN', 'DROPBOX_APP_KEY', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'ZOOM_WEBHOOK_SECRET'])
// Google-Ads-Kontonummern: nur 10 Ziffern speichern (Bindestriche aus der Oberfläche entfernen)
const GADS_ID_KEYS = new Set(['GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'])
const fmtGadsId = (id: string) => id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')

async function secretOf(sb: SupabaseClient, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return (data as { value: string } | null)?.value ?? Deno.env.get(key) ?? ''
}

type Check = { key: string; label: string; editable?: boolean; run: (sb: SupabaseClient) => Promise<{ ok: boolean; detail: string }> }
const timeout = (ms: number) => ({ signal: AbortSignal.timeout(ms) })

const CHECKS: Check[] = [
  { key: 'META_ACCESS_TOKEN', label: 'Meta (Facebook & Instagram)', editable: true, run: async (sb) => {
    const tok = await secretOf(sb, 'META_ACCESS_TOKEN') || (Deno.env.get('META_ACCESS_TOKEN') ?? '')
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
  { key: 'YOUTUBE_CLIENT_ID', label: 'YouTube — Client-ID', editable: true, run: async (sb) => {
    const v = await secretOf(sb, 'YOUTUBE_CLIENT_ID')
    return v ? { ok: true, detail: 'Hinterlegt.' } : { ok: false, detail: 'Fehlt — für Video-Upload & Kommentare (Google-OAuth).' }
  } },
  { key: 'YOUTUBE_CLIENT_SECRET', label: 'YouTube — Client-Secret', editable: true, run: async (sb) => {
    const v = await secretOf(sb, 'YOUTUBE_CLIENT_SECRET')
    return v ? { ok: true, detail: 'Hinterlegt.' } : { ok: false, detail: 'Fehlt.' }
  } },
  { key: 'YOUTUBE_REFRESH_TOKEN', label: 'YouTube — Refresh-Token', editable: true, run: async (sb) => {
    const v = await secretOf(sb, 'YOUTUBE_REFRESH_TOKEN')
    return v ? { ok: true, detail: 'Hinterlegt.' } : { ok: false, detail: 'Fehlt.' }
  } },
  // Google Ads (YouTube- und Google-Werbung): verbunden über yt-oauth?target=gads.
  // Zugriffsstufe hängt am Cloud-Projekt des OAuth-Clients (kein Developer-Token mehr).
  { key: 'GOOGLE_ADS', label: 'Google Ads (YouTube- & Google-Werbung)', run: async (sb) => {
    const [rtok, account, cust, login] = await Promise.all([secretOf(sb, 'GOOGLE_ADS_REFRESH_TOKEN'), secretOf(sb, 'GOOGLE_ADS_ACCOUNT'), secretOf(sb, 'GOOGLE_ADS_CUSTOMER_ID'), secretOf(sb, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID')])
    if (!rtok) return { ok: false, detail: 'Nicht verbunden. „Verbinden" klicken und mit dem Google-Konto zustimmen, das in Google Ads Administrator ist.' }
    const at = await gadsAccessToken(sb)
    const wer = account ? `Verbunden als ${account}` : 'Verbunden'
    const customerId = cleanCustomerId(cust)
    try {
      if (!customerId) {
        const ids = await gadsListAccessible(at)
        return { ok: false, detail: `${wer}, aber kein Werbekonto eingestellt. Gefunden: ${ids.map(fmtGadsId).join(', ') || 'keins'}. Unten bei „Kunden-ID" eintragen.` }
      }
      const c = await gadsCustomerInfo({ accessToken: at, customerId, loginCustomerId: cleanCustomerId(login), developerToken: '' })
      if (c.manager) return { ok: false, detail: `${wer}, aber ${fmtGadsId(customerId)} ist ein Verwaltungskonto. Bei „Kunden-ID" das Werbekonto darunter eintragen, die Verwaltungskonto-ID gehört ins Feld darunter.` }
      return { ok: true, detail: `${wer} · Werbekonto ${c.name || 'ohne Name'} (${fmtGadsId(customerId)}, ${c.currency})${c.testAccount ? ' · TESTKONTO' : ''}` }
    } catch (e) {
      return { ok: false, detail: `${wer}, aber Google verweigert den Zugriff: ${(e as Error).message.slice(0, 160)}. Im Google-Cloud-Projekt die Google Ads API aktivieren und Zugriffsstufe „Explorer" beantragen.` }
    }
  } },
  { key: 'GOOGLE_ADS_CUSTOMER_ID', label: 'Google Ads, Kunden-ID (Werbekonto)', editable: true, run: async (sb) => {
    const v = cleanCustomerId(await secretOf(sb, 'GOOGLE_ADS_CUSTOMER_ID'))
    return v ? { ok: true, detail: fmtGadsId(v) } : { ok: false, detail: 'Fehlt. Steht in Google Ads oben rechts (Format 123-456-7890). Wird beim Verbinden automatisch gesetzt, wenn es nur ein Konto gibt.' }
  } },
  { key: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID', label: 'Google Ads, Verwaltungskonto-ID (nur bei Zugriff über MCC)', editable: true, run: async (sb) => {
    const v = cleanCustomerId(await secretOf(sb, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'))
    return { ok: true, detail: v ? fmtGadsId(v) : 'Nicht nötig (direkter Zugriff aufs Werbekonto).' }
  } },
  { key: 'HIGGSFIELD', label: 'Higgsfield (Bild-KI)', run: async (sb) => {
    // Bewusst OHNE Token-Refresh: das würde den rotierenden Refresh-Token
    // verbrauchen und mit dem social-agent kollidieren. Nur Status lesen.
    const ws = await secretOf(sb, 'HIGGSFIELD_WORKSPACE_ID')
    const rt = await secretOf(sb, 'HIGGSFIELD_REFRESH_TOKEN')
    if (!ws || !rt) return { ok: false, detail: 'Nicht verbunden — ohne Higgsfield können keine KI-Bilder erzeugt werden.' }
    const at = await secretOf(sb, 'HIGGSFIELD_ACCESS_TOKEN')
    const exp = Number(await secretOf(sb, 'HIGGSFIELD_EXPIRES_AT') || 0)
    if (at && exp - Math.floor(Date.now() / 1000) > 600) {
      const r = await fetch('https://fnf-api-gw.higgsfield.ai/fnf/developer/v2alpha/account/balance', { headers: { Authorization: `Bearer ${at}`, 'hf-workspace-id': ws }, ...timeout(8000) }).then(x => x.ok ? x.json() : null).catch(() => null)
      if (r?.credits != null) return { ok: true, detail: `Verbunden (${r.subscription_plan_type ?? 'Abo'}) · ${Math.round(r.credits)} Credits übrig` }
      return { ok: false, detail: 'Token abgelehnt — wird beim nächsten Bild automatisch erneuert.' }
    }
    return { ok: true, detail: 'Verbunden — Token wird beim nächsten Bild automatisch erneuert.' }
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
  // Zwei WhatsApp-Wege an derselben Nummer; aktiv ist nur einer (crm_settings.wa_provider).
  { key: 'TIMELINES', label: 'WhatsApp (TimelinesAI)', run: async (sb) => {
    const tok = Deno.env.get('TIMELINES_API_KEY') ?? ''
    const aktiv = (await getWaProvider(sb)) === 'timelines'
    if (!tok) return { ok: false, detail: 'TIMELINES_API_KEY fehlt.' }
    return { ok: true, detail: aktiv ? 'AKTIV — Versand und Empfang laufen über TimelinesAI.' : 'Rückfallweg (nicht aktiv). Schlüssel hinterlegt.' }
  } },
  { key: 'EVOLUTION', label: 'WhatsApp (eigener Server, wa.happy-property.com)', run: async (sb) => {
    const cfg = evoConfig()
    if (!cfg.ok) return { ok: false, detail: 'EVOLUTION_URL / EVOLUTION_API_KEY fehlen.' }
    const aktiv = (await getWaProvider(sb)) === 'evolution'
    const st = await evoConnectionState()
    const rolle = aktiv ? 'AKTIV — Versand und Empfang laufen über den eigenen Server.' : 'Rückfallweg (nicht aktiv).'
    if (st === 'open') return { ok: true, detail: `${rolle} Nummer verbunden.` }
    if (st === 'unknown') return { ok: false, detail: `${rolle} Server antwortet nicht.` }
    return { ok: false, detail: `${rolle} Nummer NICHT verbunden (${st}) — „Neu verbinden" klicken.` }
  } },
  { key: 'GOOGLE_DRIVE_UPLOAD', label: 'Google Drive — Upload aus dem Eigentümerportal', run: async (sb) => {
    // Der Service-Account kann nicht hochladen (kein Speicherplatz) — das Portal
    // lädt im Namen von Svens Google-Konto hoch (yt-oauth?target=drive).
    const [cid, csec, rtok] = await Promise.all([secretOf(sb, 'YOUTUBE_CLIENT_ID'), secretOf(sb, 'YOUTUBE_CLIENT_SECRET'), secretOf(sb, 'GOOGLE_DRIVE_REFRESH_TOKEN')])
    if (!rtok) return { ok: false, detail: 'Nicht verbunden — Kunden können im Portal noch nichts hochladen. „Verbinden" klicken (Google-Konto mit Zugriff auf „Happy Property Kunden").' }
    if (!cid || !csec) return { ok: false, detail: 'YouTube-Client-ID/-Secret fehlen (gleicher OAuth-Client).' }
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }), ...timeout(8000) }).then(r => r.json()).catch(() => ({})) as { access_token?: string; error?: string }
    if (!tr.access_token) return { ok: false, detail: `Token abgelehnt (${tr.error ?? 'unbekannt'}) — bitte neu verbinden.` }
    const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', { headers: { Authorization: `Bearer ${tr.access_token}` }, ...timeout(8000) }).then(r => r.json()).catch(() => ({})) as { user?: { emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }
    const gb = (x?: string) => x ? (Number(x) / 1073741824).toFixed(1) : '?'
    return { ok: !!about.user, detail: about.user ? `Verbunden als ${about.user.emailAddress} · ${gb(about.storageQuota?.usage)} / ${gb(about.storageQuota?.limit)} GB belegt` : 'Drive-API antwortet nicht.' }
  } },
  { key: 'DROPBOX_APP_KEY', label: 'Dropbox (Bauträger-Ordner per Link, z. B. Kuutio)', editable: true, run: async (sb) => {
    // Eigene Dropbox-App (geht auch im Gratis-Konto), verbunden per dropbox-oauth (PKCE).
    // Gelesen wird direkt am geteilten Link (crm_settings dropbox_shared_links).
    const [k, s, r, acc] = await Promise.all([secretOf(sb, 'DROPBOX_APP_KEY'), secretOf(sb, 'DROPBOX_APP_SECRET'), secretOf(sb, 'DROPBOX_REFRESH_TOKEN'), secretOf(sb, 'DROPBOX_ACCOUNT')])
    if (!k) return { ok: false, detail: 'App-Key fehlt — Dropbox-App anlegen, App-Key über „Ändern" eintragen, dann „Verbinden".' }
    if (!r) return { ok: false, detail: 'App-Key gespeichert, noch nicht verbunden — „Verbinden" klicken und bei Dropbox zustimmen.' }
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: r, client_id: k })
    if (s) body.set('client_secret', s)
    const tr = await fetch('https://api.dropbox.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, ...timeout(8000) })
      .then(x => x.json()).catch(() => ({})) as { access_token?: string; error?: string }
    if (!tr.access_token) return { ok: false, detail: `Token abgelehnt (${tr.error ?? 'unbekannt'}) — bitte neu verbinden.` }
    const { data: ls } = await sb.from('crm_settings').select('value').eq('key', 'dropbox_shared_links').maybeSingle()
    let links: string[] = []
    try { links = Object.values(JSON.parse((ls as { value?: string } | null)?.value || '{}') as Record<string, string>) } catch { links = [] }
    if (!links.length) return { ok: true, detail: `Verbunden${acc ? ` als ${acc}` : ''} · noch kein Bauträger-Link hinterlegt.` }
    const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST', headers: { Authorization: `Bearer ${tr.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '', shared_link: { url: links[0] } }), ...timeout(8000),
    })
    const d = await res.json().catch(() => ({})) as { entries?: unknown[]; error_summary?: string }
    if (!res.ok) return { ok: false, detail: `Verbunden, aber Bauträger-Ordner nicht lesbar (${d.error_summary ?? res.status}) — Berechtigungen der App prüfen.` }
    return { ok: true, detail: `Verbunden${acc ? ` als ${acc}` : ''} · ${links.length} Bauträger-Ordner, ${(d.entries ?? []).length} Einträge im ersten lesbar.` }
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
  // Zoom-Gesprächsnotizen (zoom-calls): Secret Token aus der Zoom-App (Event Subscriptions).
  { key: 'ZOOM_WEBHOOK_SECRET', label: 'Zoom, Gesprächsnotizen (Secret Token)', editable: true, run: async (sb) => {
    const v = await secretOf(sb, 'ZOOM_WEBHOOK_SECRET')
    return v ? { ok: true, detail: 'Hinterlegt. Nach Zoom-Calls entsteht automatisch eine Notiz beim Kunden.' } : { ok: false, detail: 'Fehlt. Secret Token aus der Zoom-App (Feature > Event Subscriptions) über „Ändern" eintragen.' }
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

    const body = await req.json().catch(() => ({})) as { action?: string; key?: string; value?: string; provider?: string }

    // ── WhatsApp-Weg umschalten (TimelinesAI ↔ eigener Server) ──────────────
    // Wirkt sofort fuer send-whatsapp, Scheduler, Bot und beide Webhooks.
    if (body.action === 'wa_provider') {
      const p = body.provider === 'evolution' ? 'evolution' : body.provider === 'timelines' ? 'timelines' : null
      if (!p) return json({ error: 'provider muss timelines oder evolution sein.' }, 400)
      if (p === 'evolution') {
        if (!evoConfig().ok) return json({ error: 'Evolution ist nicht konfiguriert (Secrets fehlen).' }, 400)
        const st = await evoConnectionState()
        if (st !== 'open') return json({ error: `Eigener Server ist nicht verbunden (Status: ${st}). Erst „Neu verbinden".` }, 400)
      }
      await setWaProvider(sb, p)
      console.log(`[connectors] WhatsApp-Weg umgeschaltet auf ${p} durch ${uid}`)
      return json({ ok: true, provider: p })
    }

    // ── Pairing-Code fuer den eigenen Server holen ─────────────────────────────
    // Der Code laeuft nach kurzer Zeit ab; vorher die Instanz neu starten, sonst
    // liefert Evolution manchmal einen toten Code (Erfahrung Mitja 17.9.2026).
    if (body.action === 'wa_pair') {
      const cfg = evoConfig()
      if (!cfg.ok) return json({ error: 'Evolution ist nicht konfiguriert (Secrets fehlen).' }, 400)
      const st = await evoConnectionState()
      if (st === 'open') return json({ ok: true, state: 'open', detail: 'Nummer ist bereits verbunden.' })
      const h = { apikey: cfg.key }
      await fetch(`${cfg.url}/instance/restart/${cfg.instance}`, { method: 'POST', headers: h, ...timeout(15000) }).catch(() => null)
      await new Promise(r => setTimeout(r, 2500))
      const number = evoNumber(Deno.env.get('TIMELINES_WA_SENDER') ?? '35795154722')
      const r = await fetch(`${cfg.url}/instance/connect/${cfg.instance}?number=${number}`, { headers: h, ...timeout(20000) })
        .then(x => x.json()).catch(e => ({ error: String(e) })) as { pairingCode?: string; code?: string; error?: string }
      if (!r.pairingCode) return json({ error: `Kein Pairing-Code erhalten: ${JSON.stringify(r).slice(0, 160)}` }, 502)
      return json({ ok: true, state: st, pairingCode: r.pairingCode })
    }

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
      let value = (body.value ?? '').trim()
      if (!value) return json({ error: 'Wert fehlt.' }, 400)
      if (GADS_ID_KEYS.has(key)) {
        value = cleanCustomerId(value)
        if (!value) return json({ error: 'Bitte die 10-stellige Kunden-ID eintragen (z. B. 123-456-7890).' }, 400)
      }
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
