// ── Google Calendar integration ───────────────────────────────────────────────
// Uses the Google Identity Services (GIS) + Google Calendar API v3 via gapi.
// If VITE_GOOGLE_CLIENT_ID is not set the helpers gracefully do nothing.

declare global {
  interface Window {
    gapi: {
      load: (lib: string, cb: () => void) => void
      client: {
        init: (opts: { apiKey?: string; discoveryDocs?: string[] }) => Promise<void>
        calendar: {
          events: {
            insert: (params: {
              calendarId: string
              resource: unknown
            }) => Promise<{ result: { id: string; htmlLink: string } }>
            list: (params: {
              calendarId: string
              timeMin: string
              timeMax: string
              singleEvents: boolean
              orderBy: string
              maxResults?: number
            }) => Promise<{ result: { items: GoogleCalendarEvent[] } }>
          }
        }
      }
    }
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            prompt?: string
            callback: (response: { access_token?: string; error?: string }) => void
          }) => { requestAccessToken: () => void }
          revoke: (token: string, cb: () => void) => void
        }
      }
    }
  }
}

export interface GoogleCalendarEvent {
  id:             string
  summary:        string
  start:          { dateTime?: string; date?: string }
  end:            { dateTime?: string; date?: string }
  htmlLink?:      string
  calendarColor?: string
  calendarName?:  string
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ')
const DISCOVERY   = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'
const TOKEN_KEY   = 'google_calendar_token'

// ── Token helpers ─────────────────────────────────────────────────────────────

export function hasGoogleToken(): boolean {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { token: string; expires_at: number }
    return Date.now() < parsed.expires_at
  } catch {
    return false
  }
}

function saveToken(token: string) {
  const expires_at = Date.now() + 55 * 60 * 1000 // 55 minutes
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires_at }))
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleTokenRefresh(clientId: string) {
  if (refreshTimer) clearTimeout(refreshTimer)
  // Refresh nach 50 Minuten (5 Minuten vor Ablauf)
  refreshTimer = setTimeout(() => {
    const client = window.google?.accounts?.oauth2?.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      prompt: '',  // Kein Popup – silent refresh
      callback: (resp: { access_token?: string; error?: string }) => {
        if (resp.access_token) {
          saveToken(resp.access_token)
          scheduleTokenRefresh(clientId)
          if (gapiReady) {
            (window.gapi.client as unknown as { setToken: (t: { access_token: string }) => void })
              .setToken({ access_token: resp.access_token })
          }
        }
      },
    })
    client?.requestAccessToken()
  }, 50 * 60 * 1000)
}

function getToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { token: string; expires_at: number }
    if (Date.now() >= parsed.expires_at) return null
    return parsed.token
  } catch {
    return null
  }
}

// ── GAPI loader ───────────────────────────────────────────────────────────────

let gapiReady = false

export async function initGoogleAuth(): Promise<void> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
  if (!clientId) return

  await Promise.all([
    loadScript('https://apis.google.com/js/api.js'),
    loadScript('https://accounts.google.com/gsi/client'),
  ])

  await new Promise<void>((resolve, reject) => {
    window.gapi.load('client', {
      callback: () => resolve(),
      onerror: () => reject(new Error('gapi.load failed')),
    } as unknown as () => void)
  })

  // Kein API Key – OAuth Access Token reicht für Calendar API vollständig aus.
  // Ein falscher/nicht aktivierter API Key würde einen 400-Fehler bei der
  // Discovery-URL auslösen. Der Token wird nach signInGoogle() gesetzt.
  await window.gapi.client.init({
    discoveryDocs: [DISCOVERY],
  })

  gapiReady = true

  // Nach Reload: gespeicherten Token sofort in gapi.client einspielen,
  // damit Calendar-Calls ohne erneuten Login sofort funktionieren.
  const storedToken = getToken()
  if (storedToken) {
    ;(window.gapi.client as unknown as { setToken: (t: { access_token: string }) => void })
      .setToken({ access_token: storedToken })
    if (clientId) scheduleTokenRefresh(clientId)
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }
    const s = document.createElement('script')
    s.src   = src
    s.async = true
    s.onload  = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

// ── Sign in / out ─────────────────────────────────────────────────────────────

export function signInGoogle(): Promise<void> {
  return new Promise((resolve, reject) => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
    if (!clientId) { reject(new Error('No VITE_GOOGLE_CLIENT_ID')); return }

    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope:     SCOPES,
      callback:  (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return }
        if (resp.access_token) {
          saveToken(resp.access_token)
          // Set the token on gapi.client so calendar requests are authenticated
          if (gapiReady) {
            // gapi.client.setToken is not typed in our minimal declaration; cast via unknown
            ;(window.gapi.client as unknown as { setToken: (t: { access_token: string }) => void })
              .setToken({ access_token: resp.access_token })
          }
          const cId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string
          scheduleTokenRefresh(cId)
          resolve()
        } else {
          reject(new Error('No access_token in response'))
        }
      },
    })
    client.requestAccessToken()
  })
}

export function signOutGoogle(): void {
  const token = getToken()
  localStorage.removeItem(TOKEN_KEY)
  if (token && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(token, () => { /* noop */ })
  }
}

// ── Calendar operations ───────────────────────────────────────────────────────

export interface NewGoogleEvent {
  title:       string
  startIso:    string
  endIso:      string
  description?: string
  location?:   string
}

export async function createGoogleEvent(event: NewGoogleEvent): Promise<{ id: string; htmlLink: string }> {
  const token = getToken()
  if (!token) throw new Error('Not authenticated with Google')

  // Lokale Zeitzone für korrekte Darstellung im Google Kalender
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  console.log('[googleCalendar] createGoogleEvent:', {
    title:    event.title,
    startIso: event.startIso,
    endIso:   event.endIso,
    tz,
    tokenValid: !!token,
  })

  // Direkt via REST API – kein gapi.client.calendar nötig
  // (gapi.client.calendar ist nicht verfügbar ohne API Key für Discovery Doc)
  const resp = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary:     event.title,
        description: event.description ?? '',
        location:    event.location ?? '',
        start: { dateTime: event.startIso, timeZone: tz },
        end:   { dateTime: event.endIso,   timeZone: tz },
      }),
    },
  )

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({})) as { error?: { message?: string } }
    const msg = errBody?.error?.message ?? `HTTP ${resp.status}`
    console.error('[googleCalendar] createGoogleEvent Fehler:', resp.status, errBody)
    throw new Error(`Google Calendar: ${msg}`)
  }

  const result = await resp.json() as { id: string; htmlLink: string }
  console.log('[googleCalendar] Event erstellt:', result.id, result.htmlLink)
  return { id: result.id, htmlLink: result.htmlLink }
}

export async function listGoogleEvents(
  timeMin: string,
  timeMax: string,
): Promise<GoogleCalendarEvent[]> {
  const token = getToken()
  if (!token) return []

  try {
    // Schritt 1: Alle Kalender des Users laden
    const calListResp = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const calList = await calListResp.json() as { items?: { id: string; summary: string; backgroundColor?: string }[] }
    const calendars = calList.items ?? []

    // Schritt 2: Events aus ALLEN Kalendern parallel laden
    const results = await Promise.all(
      calendars.map(async (cal) => {
        try {
          const url =
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
            new URLSearchParams({
              timeMin,
              timeMax,
              singleEvents: 'true',
              orderBy:      'startTime',
              maxResults:   '100',
            }).toString()

          const eventsResp = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
          })
          const eventsData = await eventsResp.json() as { items?: GoogleCalendarEvent[] }
          const items = eventsData.items ?? []

          // Kalenderfarbe + Name zu jedem Event hinzufügen
          return items.map(e => ({
            ...e,
            calendarColor: cal.backgroundColor ?? '#4285f4',
            calendarName:  cal.summary,
          }))
        } catch (err) {
          console.error('[googleCalendar] Kalender Fehler:', cal.id, err)
          return []
        }
      }),
    )

    return results.flat()

  } catch (err) {
    console.error('[googleCalendar] CalendarList Fehler:', err)
    return []
  }
}
