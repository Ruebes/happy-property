// ── Google Calendar integration ───────────────────────────────────────────────
// Läuft KOMPLETT server-seitig über die Edge Function `google-calendar`
// (Service-Account, gleiche dauerhafte Anbindung wie Google Drive).
// Kein Browser-Token, kein localStorage, kein Popup — die Verbindung kann
// nicht mehr ablaufen und gilt auf jedem Gerät (Mac, iPhone, PWA) gleich.
//
// Einmaliges Setup (in Einstellungen → Integrationen beschrieben):
// Google-Kalender für die Service-Account-E-Mail freigeben
// („Änderungen an Terminen vornehmen").

import { supabase } from './supabase'
import { FunctionsHttpError } from '@supabase/supabase-js'

export interface GoogleCalendarEvent {
  id:          string
  summary:     string
  description?: string
  location?:   string
  start:       { dateTime?: string; date?: string }
  end:         { dateTime?: string; date?: string }
  htmlLink?:   string
  calendarId?: string
}

export interface CalendarStatus {
  connected: boolean
  sa_email:  string
  calendar_id: string
  reason?:   'not_shared' | 'api_disabled' | 'no_permission' | 'read_only' | 'no_sa' | 'error'
  error?:    string
}

export interface CalendarListError { calendarId: string; reason: string }

export interface NewGoogleEvent {
  title:        string
  startIso:     string
  endIso:       string
  description?: string
  location?:    string
}

// Zentraler Invoke-Helper: wirft bei Transport- ODER API-Fehler mit klarer Meldung.
// Bei non-2xx wird der deutsche Fehlertext aus dem Response-Body durchgereicht
// (FunctionsHttpError.message wäre nur die englische Generik-Meldung).
async function callCalendar<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('google-calendar', { body })
  if (error) {
    let msg = error.message
    if (error instanceof FunctionsHttpError) {
      const errBody = await (error.context as Response).json().catch(() => null) as { error?: string } | null
      if (errBody?.error) msg = errBody.error
    }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error as string)
  return data as T
}

/** Verbindungsstatus prüfen (echter API-Check, kein lokaler Token-Check).
 *  WICHTIG: bewusst NICHT über callCalendar — die check-Antwort trägt bei
 *  connected=false ein error-Detail-Feld, das kein Fehler ist. Nur Transportfehler
 *  landen im catch; sa_email + reason bleiben so für die Setup-UI erhalten. */
export async function checkCalendarStatus(): Promise<CalendarStatus> {
  try {
    const { data, error } = await supabase.functions.invoke('google-calendar', { body: { action: 'check' } })
    if (error) throw new Error(error.message)
    return data as CalendarStatus
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { connected: false, sa_email: '', calendar_id: '', reason: 'error', error: msg }
  }
}

/** Events aller freigegebenen Kalender im Zeitraum laden. Wirft bei Total-Fehler;
 *  Teil-Fehler einzelner Kalender kommen als errors[] zurück. */
export async function listGoogleEvents(
  timeMin: string,
  timeMax: string,
): Promise<{ events: GoogleCalendarEvent[]; errors: CalendarListError[] }> {
  const data = await callCalendar<{ events?: GoogleCalendarEvent[]; errors?: CalendarListError[] }>({
    action: 'list_events', timeMin, timeMax,
  })
  return { events: data.events ?? [], errors: data.errors ?? [] }
}

/** Termin im (freigegebenen) Google-Kalender anlegen. */
export async function createGoogleEvent(event: NewGoogleEvent): Promise<{ id: string; htmlLink?: string; calendar_id?: string }> {
  return callCalendar<{ id: string; htmlLink?: string; calendar_id?: string }>({
    action:      'create_event',
    title:       event.title,
    start:       event.startIso,
    end:         event.endIso,
    description: event.description ?? '',
    location:    event.location ?? '',
    timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

/** Google-Event ändern — funktioniert auch für Termine, die am iPhone/in Google angelegt wurden. */
export async function updateGoogleEvent(
  eventId: string,
  changes: Partial<NewGoogleEvent>,
  calendarId?: string,
): Promise<void> {
  await callCalendar({
    action:      'update_event',
    event_id:    eventId,
    calendar_id: calendarId,
    ...(changes.title       !== undefined ? { title: changes.title } : {}),
    ...(changes.description !== undefined ? { description: changes.description } : {}),
    ...(changes.location    !== undefined ? { location: changes.location } : {}),
    ...(changes.startIso ? { start: changes.startIso } : {}),
    ...(changes.endIso   ? { end:   changes.endIso   } : {}),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

/** Google-Event löschen. */
export async function deleteGoogleEvent(eventId: string, calendarId?: string): Promise<void> {
  await callCalendar({ action: 'delete_event', event_id: eventId, calendar_id: calendarId })
}
