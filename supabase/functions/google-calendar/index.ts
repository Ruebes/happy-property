// Supabase Edge Function: google-calendar
// DAUERHAFTE Google-Calendar-Anbindung über den Service-Account — exakt dasselbe
// Muster wie google-drive (das stabil läuft). Kein OAuth-Popup, kein Refresh-Token,
// kein Browser-Storage: Sven gibt seinen Kalender (happypropertycyprus@gmail.com)
// einmal für die SA-E-Mail frei ("Änderungen an Terminen vornehmen"), danach kann
// nichts mehr ablaufen. Ersetzt den fragilen GIS-Browser-Flow UND den nie
// angeschlossenen OAuth-Refresh-Token-Flow der Vorversion.
//
// WICHTIG (Google-Limitierung): Service-Accounts dürfen ohne Workspace-Domain
// KEINE attendees/Einladungen setzen → Kunden-Einladungen laufen über unsere
// eigene Infrastruktur (send-email mit ICS-Anhang + send-whatsapp).
//
// Actions (POST, JSON):
//   check         → Verbindung prüfen; liefert sa_email + konkreten Grund bei Fehler
//                   (not_shared = Kalender nicht freigegeben, api_disabled = Calendar
//                   API im GCP-Projekt nicht aktiviert)
//   list_events   → Events aller konfigurierten Kalender (timeMin..timeMax)
//   create_event  → Termin anlegen  (title, start, end, description?, location?)
//   update_event  → Termin ändern   (event_id + geänderte Felder)
//   delete_event  → Termin löschen  (event_id)
//
// Kalender-IDs: crm_settings key 'google_calendar_ids' (kommagetrennt),
// Default happypropertycyprus@gmail.com. Der ERSTE Eintrag ist der Schreib-Kalender.
//
// Secrets: GOOGLE_SERVICE_ACCOUNT_JSON (wie google-drive)
//
// Deployment:
//   supabase functions deploy google-calendar --no-verify-jwt
//   (Zugriff ist intern über den Rollen-Check admin/verwalter abgesichert)

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const DEFAULT_CALENDAR = 'happypropertycyprus@gmail.com'
const SETTINGS_KEY     = 'google_calendar_ids'

// ── Service-Account-Token (Muster aus google-drive) ──────────────────────────
function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\\n/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(b), c => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
function saEmail(): string {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) return ''
  try { return (JSON.parse(raw) as { client_email?: string }).client_email ?? '' } catch { return '' }
}
async function getServiceAccountToken(scope = 'https://www.googleapis.com/auth/calendar'): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const key = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const data = await res.json() as { access_token?: string; error?: string; error_description?: string }
  if (!data.access_token) throw new Error(`Service-Account-Token fehlgeschlagen: ${data.error_description ?? data.error ?? JSON.stringify(data)}`)
  return data.access_token
}

// ── Kalender-IDs aus crm_settings (kommagetrennt), Default Gmail-Konto ────────
async function getCalendarIds(admin: SupabaseClient): Promise<string[]> {
  try {
    const { data } = await admin
      .from('crm_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
    const raw = (data as { value?: string } | null)?.value
    if (raw) {
      const ids = raw.split(',').map(s => s.trim()).filter(Boolean)
      if (ids.length) return ids
    }
  } catch { /* Default */ }
  return [DEFAULT_CALENDAR]
}

// ── Google-Fehler klassifizieren (für verständliche UI-Hinweise) ──────────────
interface GoogleErr { error?: { code?: number; message?: string; errors?: { reason?: string }[]; status?: string } }
function classifyGoogleError(status: number, body: GoogleErr): { reason: string; error: string } {
  const msg     = body?.error?.message ?? `HTTP ${status}`
  const reasons = (body?.error?.errors ?? []).map(e => e.reason ?? '')
  if (status === 403 && (reasons.includes('accessNotConfigured') || /has not been used|is disabled/i.test(msg))) {
    return { reason: 'api_disabled', error: msg }
  }
  if (status === 404) return { reason: 'not_shared', error: msg }
  if (status === 403) return { reason: 'no_permission', error: msg }
  return { reason: 'error', error: msg }
}

// ── Event-Felder für das Frontend zuschneiden ─────────────────────────────────
interface GEvent {
  id: string
  summary?: string
  description?: string
  location?: string
  start: { dateTime?: string; date?: string }
  end:   { dateTime?: string; date?: string }
  htmlLink?: string
  status?: string
}
function trimEvent(e: GEvent, calendarId: string) {
  return {
    id:          e.id,
    summary:     e.summary ?? '',
    description: e.description ?? '',
    location:    e.location ?? '',
    start:       e.start,
    end:         e.end,
    htmlLink:    e.htmlLink,
    calendarId,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── Rollen-Check: nur Admin/Verwalter (Muster aus admin-user-ops) ────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    const caller = jwt
      ? (await createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '').auth.getUser(jwt)).data.user
      : null
    if (!caller) return json({ error: 'Nicht angemeldet.' }, 401)
    const { data: callerProfile } = await admin.from('profiles').select('role').eq('id', caller.id).maybeSingle()
    const callerRole = (callerProfile as { role?: string } | null)?.role ?? ''
    if (!['admin', 'verwalter'].includes(callerRole)) {
      return json({ error: 'Keine Berechtigung.' }, 403)
    }

    const body = await req.json() as {
      action:       'check' | 'list_events' | 'create_event' | 'update_event' | 'delete_event'
      timeMin?:     string
      timeMax?:     string
      title?:       string
      description?: string
      location?:    string
      start?:       string
      end?:         string
      timezone?:    string
      event_id?:    string
      calendar_id?: string
    }

    if (!Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')) {
      // Status 200: der Client soll reason 'no_sa' anzeigen können (kein Transportfehler).
      return json({ success: true, connected: false, reason: 'no_sa', sa_email: '', error_detail: 'GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt.' })
    }

    const calendarIds = await getCalendarIds(admin)
    const primaryCal  = calendarIds[0]

    // Härtung: Client darf nur Kalender aus der konfigurierten Liste ansprechen.
    if (body.calendar_id && !calendarIds.includes(body.calendar_id)) {
      return json({ error: 'Unbekannter Kalender.' }, 400)
    }
    const token       = await getServiceAccountToken()
    const tz          = body.timezone || 'Asia/Nicosia'
    const gHeaders    = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const calUrl      = (calId: string, path = '') =>
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events${path}`

    // ── check ────────────────────────────────────────────────────────────────
    // WICHTIG: check antwortet IMMER mit 200 und ohne `error`-Feld (Detail heißt
    // error_detail), damit der Client sa_email + reason für die Setup-UI bekommt.
    if (body.action === 'check') {
      const r = await fetch(calUrl(primaryCal) + '?maxResults=1', { headers: gHeaders })
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({})) as GoogleErr
        const cls = classifyGoogleError(r.status, errBody)
        console.warn('[google-calendar] check fehlgeschlagen:', r.status, cls.reason, cls.error)
        return json({ success: true, connected: false, sa_email: saEmail(), calendar_id: primaryCal, reason: cls.reason, error_detail: cls.error })
      }

      // Lesen geht — jetzt SCHREIBRECHT prüfen: Google bietet 4 Freigabestufen an,
      // die read-only-Stufe ist die Voreinstellung. Ohne 'writer' würde jeder
      // Termin-Sync später still mit 403 scheitern, obwohl alles "verbunden" aussieht.
      let accessRole = ''
      try {
        const ins = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
          method: 'POST', headers: gHeaders, body: JSON.stringify({ id: primaryCal }),
        })
        if (ins.ok) {
          accessRole = ((await ins.json()) as { accessRole?: string }).accessRole ?? ''
        } else {
          const g = await fetch(`https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(primaryCal)}`, { headers: gHeaders })
          if (g.ok) accessRole = ((await g.json()) as { accessRole?: string }).accessRole ?? ''
        }
      } catch { /* accessRole unbestimmt → nicht blockieren, Lesen funktionierte */ }

      if (accessRole && !['writer', 'owner'].includes(accessRole)) {
        console.warn('[google-calendar] check: nur Lese-Freigabe (accessRole=' + accessRole + ')')
        return json({
          success: true, connected: false, sa_email: saEmail(), calendar_id: primaryCal,
          reason: 'read_only',
          error_detail: `Freigabestufe ist '${accessRole}' — es fehlt „Änderungen an Terminen vornehmen".`,
        })
      }
      return json({ success: true, connected: true, sa_email: saEmail(), calendar_id: primaryCal, calendar_ids: calendarIds })
    }

    // ── list_events ──────────────────────────────────────────────────────────
    if (body.action === 'list_events') {
      const { timeMin, timeMax } = body
      if (!timeMin || !timeMax) return json({ error: 'timeMin und timeMax sind Pflicht.' }, 400)

      // Fehler pro Kalender werden NICHT verschluckt, sondern als errors[] mitgegeben —
      // sonst verschwinden Google-Termine kommentarlos (Doppelbuchungs-Risiko).
      const listErrors: { calendarId: string; reason: string }[] = []
      const results = await Promise.all(
        calendarIds.map(async (calId) => {
          try {
            const u = calUrl(calId) + '?' + new URLSearchParams({
              timeMin, timeMax,
              singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
            }).toString()
            const r = await fetch(u, { headers: gHeaders })
            if (!r.ok) {
              const errBody = await r.json().catch(() => ({})) as GoogleErr
              const cls = classifyGoogleError(r.status, errBody)
              console.warn('[google-calendar] list_events Kalender-Fehler:', calId, r.status, cls.reason)
              listErrors.push({ calendarId: calId, reason: cls.reason })
              return []
            }
            const data = await r.json() as { items?: GEvent[] }
            return (data.items ?? [])
              .filter(e => e.status !== 'cancelled')
              .map(e => trimEvent(e, calId))
          } catch (err) {
            console.warn('[google-calendar] list_events Fehler:', calId, err)
            listErrors.push({ calendarId: calId, reason: 'network' })
            return []
          }
        }),
      )
      return json({ success: true, events: results.flat(), errors: listErrors })
    }

    // ── create_event ─────────────────────────────────────────────────────────
    if (body.action === 'create_event') {
      const { title, description, location, start, end } = body
      if (!title || !start || !end) return json({ error: 'title, start und end sind Pflicht.' }, 400)

      const r = await fetch(calUrl(body.calendar_id || primaryCal), {
        method:  'POST',
        headers: gHeaders,
        body: JSON.stringify({
          summary:     title,
          description: description ?? '',
          location:    location ?? '',
          start: { dateTime: start, timeZone: tz },
          end:   { dateTime: end,   timeZone: tz },
        }),
      })
      const data = await r.json() as { id?: string; htmlLink?: string } & GoogleErr
      if (!r.ok || !data.id) {
        const cls = classifyGoogleError(r.status, data)
        console.error('[google-calendar] create_event Fehler:', r.status, cls.error)
        return json({ error: cls.error, reason: cls.reason }, r.ok ? 500 : r.status)
      }
      return json({ success: true, id: data.id, htmlLink: data.htmlLink, calendar_id: body.calendar_id || primaryCal })
    }

    // ── update_event ─────────────────────────────────────────────────────────
    if (body.action === 'update_event') {
      const { event_id } = body
      if (!event_id) return json({ error: 'event_id fehlt.' }, 400)

      const patch: Record<string, unknown> = {}
      if (body.title       !== undefined) patch.summary     = body.title
      if (body.description !== undefined) patch.description = body.description
      if (body.location    !== undefined) patch.location    = body.location
      if (body.start) patch.start = { dateTime: body.start, timeZone: tz }
      if (body.end)   patch.end   = { dateTime: body.end,   timeZone: tz }
      if (Object.keys(patch).length === 0) return json({ error: 'Keine Änderungen übergeben.' }, 400)

      const r = await fetch(calUrl(body.calendar_id || primaryCal, `/${encodeURIComponent(event_id)}`), {
        method:  'PATCH',
        headers: gHeaders,
        body:    JSON.stringify(patch),
      })
      const data = await r.json().catch(() => ({})) as { id?: string; htmlLink?: string } & GoogleErr
      if (!r.ok) {
        const cls = classifyGoogleError(r.status, data)
        console.error('[google-calendar] update_event Fehler:', r.status, cls.error)
        return json({ error: cls.error, reason: cls.reason }, r.status)
      }
      return json({ success: true, id: data.id, htmlLink: data.htmlLink })
    }

    // ── delete_event ─────────────────────────────────────────────────────────
    if (body.action === 'delete_event') {
      const { event_id } = body
      if (!event_id) return json({ error: 'event_id fehlt.' }, 400)
      const r = await fetch(calUrl(body.calendar_id || primaryCal, `/${encodeURIComponent(event_id)}`), {
        method: 'DELETE', headers: gHeaders,
      })
      if (r.ok || r.status === 410) return json({ success: true })   // 410 = bereits gelöscht
      const errBody = await r.json().catch(() => ({})) as GoogleErr
      const cls = classifyGoogleError(r.status, errBody)
      console.error('[google-calendar] delete_event Fehler:', r.status, cls.error)
      return json({ error: cls.error, reason: cls.reason }, r.status)
    }

    return json({ error: `Unbekannte action: ${body.action}` }, 400)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[google-calendar] Fehler:', msg)
    return json({ error: msg }, 500)
  }
})
