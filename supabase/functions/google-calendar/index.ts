// Supabase Edge Function: google-calendar
// Server-seitige, DAUERHAFTE Google-Calendar-Anbindung über denselben
// Refresh-Token-Mechanismus wie google-drive (Konto happypropertycyprus@gmail.com).
// Dadurch ist der Kalender permanent verbunden – unabhängig von Browser, Cache
// oder Gerät. Ersetzt den fragilen Browser-Token-Flow (GIS) im Frontend.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// Der wirksame Refresh-Token wird DB-first gelesen (crm_settings →
// 'google_refresh_token'), Fallback auf das Env-Secret GOOGLE_REFRESH_TOKEN.
// So kann die einmalige Neu-Verbindung (mit Calendar-Scope) den Token ohne
// Redeploy/Secret-Setzen persistieren.
//
// ── Einmalige Verbindung (GET) ───────────────────────────────────────────────
//   GET ?action=connect → leitet zu Google weiter (Consent: Drive + Calendar,
//                         access_type=offline, prompt=consent → Refresh-Token)
//   GET ?code=…          → Google-Redirect: tauscht Code → Refresh-Token,
//                         speichert ihn in crm_settings, zeigt Erfolgsseite
//
// ── API (POST, JSON) ─────────────────────────────────────────────────────────
//   check         → prüft, ob wirksamer Token gültig ist UND Calendar-Scope hat
//   list_events   → Events aus ALLEN Kalendern des Kontos (timeMin..timeMax)
//   create_event  → Termin anlegen (optional attendee_email → Einladung an Kunden)
//   delete_event  → Termin löschen (event_id, optional calendar_id)

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const html = (markup: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${markup}`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })

// Nur Calendar-Scope – dieser Client dient ausschließlich dem Kalender.
const OAUTH_SCOPES = 'https://www.googleapis.com/auth/calendar'

// Eigener Settings-Key, damit der Kalender-Token NICHT mit dem Drive-Token
// (anderer Client / anderes Projekt) kollidiert.
const SETTINGS_KEY = 'google_calendar_refresh_token'

// ── Eigener OAuth-Client NUR für den Kalender ────────────────────────────────
// Projekt "My First Project", Client "n8n Google Drive OAuth". Bewusst getrennt
// vom Drive-Client (GOOGLE_CLIENT_ID liegt in einem anderen Projekt, auf das
// kein Console-Zugriff besteht) – so bleibt Google Drive komplett unberührt.
// Die Client-ID ist öffentlich (steht in jeder OAuth-URL) → fix im Code ok.
// Das Secret kommt aus dem Supabase-Secret GOOGLE_CALENDAR_CLIENT_SECRET.
const CAL_CLIENT_ID =
  Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ??
  '160017437982-so2l79di9taeh0tk29s6hrjp2ktoeec3.apps.googleusercontent.com'

function calClientSecret(): string | undefined {
  return Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')
}

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

// Redirect-URI = diese Funktion (muss exakt als Authorized redirect URI in der
// Google Cloud Console eingetragen sein).
function redirectUri(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar`
}

// Wirksamen Refresh-Token holen: erst DB (crm_settings), dann Env-Fallback.
async function getRefreshToken(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('crm_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
    if (data?.value) return data.value as string
  } catch { /* ignore – Env-Fallback */ }
  return Deno.env.get('GOOGLE_CALENDAR_REFRESH_TOKEN') ?? null
}

// ── OAuth: kurzlebigen Access-Token aus Refresh-Token holen ────────────────────
async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CAL_CLIENT_ID,
      client_secret: calClientSecret()!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })
  const data = await res.json() as { access_token?: string; error?: string; error_description?: string }
  if (!data.access_token) {
    throw new Error(`Google OAuth fehlgeschlagen: ${data.error_description ?? data.error ?? JSON.stringify(data)}`)
  }
  return data.access_token
}

interface CalendarEvent {
  id:             string
  summary?:       string
  start:          { dateTime?: string; date?: string }
  end:            { dateTime?: string; date?: string }
  htmlLink?:      string
  calendarColor?: string
  calendarName?:  string
}

// ── GET: einmalige Verbindung (Consent-Redirect + Callback) ────────────────────
async function handleGet(req: Request): Promise<Response> {
  const url    = new URL(req.url)
  const code   = url.searchParams.get('code')
  const action = url.searchParams.get('action')
  const oauthErr = url.searchParams.get('error')

  const clientId     = CAL_CLIENT_ID
  const clientSecret = calClientSecret()
  if (!clientId || !clientSecret) {
    return html('<h2>❌ Kalender nicht konfiguriert</h2><p>Das Supabase-Secret <code>GOOGLE_CALENDAR_CLIENT_SECRET</code> fehlt.</p>', 503)
  }

  // 1) Start: zu Google weiterleiten
  if (action === 'connect') {
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    auth.searchParams.set('client_id',     clientId)
    auth.searchParams.set('redirect_uri',  redirectUri())
    auth.searchParams.set('response_type', 'code')
    auth.searchParams.set('scope',         OAUTH_SCOPES)
    auth.searchParams.set('access_type',   'offline')
    // select_account → erzwingt IMMER den Konto-Auswahl-Dialog (verhindert,
    // dass Google still ein bereits eingeloggtes falsches Konto verwendet).
    // consent → erzwingt Refresh-Token.
    auth.searchParams.set('prompt',        'select_account consent')
    auth.searchParams.set('include_granted_scopes', 'true')
    // Optionaler Konto-Vorschlag: /?action=connect&hint=mail@example.com
    const hint = url.searchParams.get('hint')
    if (hint) auth.searchParams.set('login_hint', hint)
    return Response.redirect(auth.toString(), 302)
  }

  // 2) Google-Fehler
  if (oauthErr) {
    return html(`<h2>❌ Verbindung abgebrochen</h2><p>Google meldete: <code>${oauthErr}</code></p>`, 400)
  }

  // 3) Callback: Code → Refresh-Token tauschen und speichern
  if (code) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri(),
        grant_type:    'authorization_code',
      }),
    })
    const data = await res.json() as { refresh_token?: string; access_token?: string; error?: string; error_description?: string }
    if (!data.refresh_token) {
      return html(
        `<h2>⚠️ Kein Refresh-Token erhalten</h2><p>${data.error_description ?? data.error ?? 'Unbekannt'}.</p>` +
        `<p>Bitte den Zugriff in deinem Google-Konto einmal entfernen und erneut verbinden.</p>`, 400)
    }
    await svc().from('crm_settings').upsert({ key: SETTINGS_KEY, value: data.refresh_token })
    return html(
      '<div style="font-family:system-ui;max-width:520px;margin:64px auto;text-align:center">' +
      '<div style="font-size:48px">✅</div>' +
      '<h2>Google-Kalender dauerhaft verbunden</h2>' +
      '<p style="color:#555">Die Verbindung ist jetzt server-seitig gespeichert und bleibt bestehen – ' +
      'unabhängig von Browser, Cache oder Gerät. Du kannst dieses Fenster schließen.</p></div>')
  }

  // 4) Default-Info
  return html(
    '<div style="font-family:system-ui;max-width:520px;margin:64px auto;text-align:center">' +
    '<h2>Google-Kalender verbinden</h2>' +
    '<p><a href="?action=connect">Hier klicken, um zu verbinden →</a></p></div>')
}

// ── Main ───────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method === 'GET')     return handleGet(req)

  const supabase     = svc()
  const refreshToken = await getRefreshToken(supabase)

  if (!CAL_CLIENT_ID || !calClientSecret() || !refreshToken) {
    return json({ error: 'Kalender nicht konfiguriert. Supabase-Secret GOOGLE_CALENDAR_CLIENT_SECRET setzen und /functions/v1/google-calendar?action=connect aufrufen.' }, 503)
  }

  try {
    const body = await req.json() as {
      action:          'check' | 'list_events' | 'create_event' | 'delete_event'
      timeMin?:        string
      timeMax?:        string
      title?:          string
      description?:    string
      location?:       string
      start?:          string
      end?:            string
      timezone?:       string
      attendee_email?: string
      event_id?:       string
      calendar_id?:    string
    }

    const token = await getAccessToken(refreshToken)

    // ── check ─────────────────────────────────────────────────────────────────
    if (body.action === 'check') {
      const r = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (r.ok) return json({ configured: true })
      const err = await r.json().catch(() => ({})) as { error?: { message?: string } }
      return json({
        configured: false,
        reason:     r.status === 403 ? 'scope' : 'error',
        status:     r.status,
        error:      err?.error?.message ?? `HTTP ${r.status}`,
      })
    }

    // ── list_events ───────────────────────────────────────────────────────────
    if (body.action === 'list_events') {
      const { timeMin, timeMax } = body
      if (!timeMin || !timeMax) return json({ error: 'timeMin und timeMax sind Pflicht.' }, 400)

      const calListResp = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const calList = await calListResp.json() as {
        items?: { id: string; summary: string; backgroundColor?: string }[]
      }
      const calendars = calList.items ?? []

      const results = await Promise.all(
        calendars.map(async (cal) => {
          try {
            const u =
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
              new URLSearchParams({
                timeMin, timeMax,
                singleEvents: 'true', orderBy: 'startTime', maxResults: '100',
              }).toString()
            const evResp = await fetch(u, { headers: { Authorization: `Bearer ${token}` } })
            const evData = await evResp.json() as { items?: CalendarEvent[] }
            return (evData.items ?? []).map(e => ({
              ...e,
              calendarColor: cal.backgroundColor ?? '#4285f4',
              calendarName:  cal.summary,
            }))
          } catch { return [] }
        }),
      )
      return json({ events: results.flat() })
    }

    // ── create_event ──────────────────────────────────────────────────────────
    if (body.action === 'create_event') {
      const { title, description, location, start, end, timezone, attendee_email } = body
      if (!title || !start || !end) return json({ error: 'title, start und end sind Pflicht.' }, 400)
      const tz = timezone || 'Europe/Berlin'

      const event: Record<string, unknown> = {
        summary:     title,
        description: description ?? '',
        location:    location ?? '',
        start: { dateTime: start, timeZone: tz },
        end:   { dateTime: end,   timeZone: tz },
      }
      if (attendee_email) event.attendees = [{ email: attendee_email }]

      const u =
        'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
        (attendee_email ? '?sendUpdates=all' : '')   // Kunde erhält Einladung

      const r = await fetch(u, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(event),
      })
      const data = await r.json() as { id?: string; htmlLink?: string; error?: { message?: string } }
      if (!r.ok || !data.id) {
        return json({ error: data?.error?.message ?? `HTTP ${r.status}` }, r.ok ? 500 : r.status)
      }
      return json({ ok: true, id: data.id, htmlLink: data.htmlLink })
    }

    // ── delete_event ──────────────────────────────────────────────────────────
    if (body.action === 'delete_event') {
      const { event_id, calendar_id } = body
      if (!event_id) return json({ error: 'event_id fehlt.' }, 400)
      const cal = calendar_id || 'primary'
      const r = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(event_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      )
      if (r.ok || r.status === 410) return json({ ok: true })   // 410 = bereits gelöscht
      const err = await r.json().catch(() => ({})) as { error?: { message?: string } }
      return json({ error: err?.error?.message ?? `HTTP ${r.status}` }, r.status)
    }

    return json({ error: `Unbekannte action: ${body.action}` }, 400)

  } catch (err) {
    console.error('[google-calendar] Fehler:', err)
    return json({ error: String(err) }, 500)
  }
})
