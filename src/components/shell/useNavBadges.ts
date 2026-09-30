import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { NAV_ENTRIES, canSee, type NavEntry } from '../../lib/navigation'
import type { Profile } from '../../lib/permissions'
import { ZERO_BADGES, type NavBadges } from './ShellContext'

const POLL_MS = 60_000
// Beim Zurückkehren in den Tab nur neu laden, wenn der letzte Abruf älter ist
const REFOCUS_MIN_AGE_MS = 15_000

// Braucht dieses Profil den Zähler überhaupt? Nur wenn es einen sichtbaren
// Menüeintrag mit diesem Badge hat (spart Abfragen, z.B. beim Eigentümer).
function wantsBadge(profile: Profile, badge: NonNullable<NavEntry['badge']>): boolean {
  return NAV_ENTRIES.some(e => e.badge === badge && !e.hidden && canSee(profile, e))
}

const OPEN_STATUSES = ['offen', 'in_arbeit']

interface AssigneeTaskRow {
  crm_tasks: { id: string; archived: boolean; status: string } | { id: string; archived: boolean; status: string }[] | null
}

// Offene Aufgaben, die MIR gehören. Gleiche Regel wie die Startseite
// (StaffHome.isMine): crm_tasks.assigned_to = ich ODER ich stehe in
// crm_task_assignees. assigned_to trägt seit dem Mehrfach-Modell nur die erste
// zuständige Person, weitere Zuständige stehen nur in crm_task_assignees.
// Rückgabe null = Abruf fehlgeschlagen (der alte Wert bleibt stehen).
async function countOpenTasks(myId: string): Promise<number | null> {
  try {
    const [direct, shared] = await Promise.all([
      supabase
        .from('crm_tasks')
        .select('id')
        .eq('assigned_to', myId)
        .eq('archived', false)
        .in('status', OPEN_STATUSES)
        .limit(1000),
      supabase
        .from('crm_task_assignees')
        .select('task_id, crm_tasks!inner(id, archived, status)')
        .eq('profile_id', myId)
        .eq('crm_tasks.archived', false)
        .in('crm_tasks.status', OPEN_STATUSES)
        .limit(1000),
    ])
    if (direct.error) return null
    const ids = new Set<string>()
    for (const row of (direct.data ?? []) as { id: string }[]) ids.add(row.id)
    // Scheitert nur die zweite Abfrage, zählt wenigstens assigned_to
    if (!shared.error) {
      for (const row of (shared.data ?? []) as unknown as AssigneeTaskRow[]) {
        const task = Array.isArray(row.crm_tasks) ? row.crm_tasks[0] : row.crm_tasks
        if (task && !task.archived && OPEN_STATUSES.includes(task.status)) ids.add(task.id)
      }
    }
    return ids.size
  } catch { return null }
}

// Die Seite Posteingang lädt die neuesten 1000 Nachrichten (Inbox.tsx)
const INBOX_WINDOW = 1000
const INBOX_TYPES = ['email', 'whatsapp']

// Unterhaltungen mit ungelesenen eingehenden Nachrichten, genau so gezählt wie
// auf der Seite Posteingang (activities.read_at, Migration
// 20260722_inbox_read.sql): E-Mail und WhatsApp mit sichtbarem Kunden, nur
// innerhalb der neuesten 1000 Nachrichten, je Kunde einmal. Ältere ungelesene
// Zeilen tauchen auf der Seite nicht auf, ließen sich dort also nie als gelesen
// markieren; sie zählen deshalb nicht mit.
// Rückgabe null = Abruf fehlgeschlagen (der alte Wert bleibt stehen). Das gilt
// auch, wenn die Spalte oder das Recht fehlt: dann bleibt es bei 0.
async function countInboxUnread(): Promise<number | null> {
  try {
    const since = await inboxWindowStart()
    if (since === undefined) return null

    // Ungelesene eingehende Nachrichten im Fenster, je Kunde einmal gezählt
    let query = supabase
      .from('activities')
      .select('lead_id, lead:leads!inner(id)')
      .in('type', INBOX_TYPES)
      .eq('direction', 'inbound')
      .is('read_at', null)
      .not('lead_id', 'is', null)
    if (since) query = query.gte('created_at', since)
    const { data, error } = await query.order('created_at', { ascending: false }).limit(INBOX_WINDOW)
    if (error) return null
    return new Set(((data ?? []) as { lead_id: string }[]).map(row => row.lead_id)).size
  } catch { return null }
}

// Untere Grenze des Posteingang-Fensters: Zeitpunkt der 1000. neuesten
// Nachricht in der Auswahl der Seite. null = weniger als 1000 Nachrichten,
// keine Grenze. undefined = Abruf fehlgeschlagen.
// Die Grenze wandert langsam, darum wird sie einige Minuten gemerkt (eine
// Abfrage weniger je Takt).
const EDGE_MAX_AGE_MS = 10 * 60_000
let edgeCache: { at: number; since: string | null } | null = null

async function inboxWindowStart(): Promise<string | null | undefined> {
  if (edgeCache && Date.now() - edgeCache.at < EDGE_MAX_AGE_MS) return edgeCache.since
  const { data, error } = await supabase
    .from('activities')
    .select('created_at, lead:leads!inner(id)')
    .in('type', INBOX_TYPES)
    .or('auto.eq.false,direction.eq.inbound')
    .not('lead_id', 'is', null)
    .order('created_at', { ascending: false })
    .range(INBOX_WINDOW - 1, INBOX_WINDOW - 1)
  // PGRST103 = Bereich liegt hinter dem letzten Datensatz: weniger als 1000
  if (error && error.code !== 'PGRST103') return undefined
  const rows = (error ? [] : data ?? []) as { created_at: string }[]
  const since = rows[0]?.created_at ?? null
  edgeCache = { at: Date.now(), since }
  return since
}

// EIN Hook für alle Menü-Zähler. Wird einmal in der AppShell aufgerufen und
// über den ShellContext verteilt, damit Sidebar und Telefon-Leiste dieselben
// Zahlen zeigen. Alle 60 s neu, pausiert solange der Tab im Hintergrund ist.
export function useNavBadges(profile: Profile | null | undefined): { badges: NavBadges; refresh: () => void } {
  const [badges, setBadges] = useState<NavBadges>(ZERO_BADGES)
  const lastFetchRef = useRef(0)
  const runRef = useRef(0)

  const myId = profile?.id ?? null
  const wantTasks = !!profile && wantsBadge(profile, 'tasksOpen')
  const wantInbox = !!profile && wantsBadge(profile, 'inboxUnread')

  const load = useCallback(async () => {
    if (!myId || (!wantTasks && !wantInbox)) {
      setBadges(ZERO_BADGES)
      return
    }
    const run = ++runRef.current
    lastFetchRef.current = Date.now()
    const [tasks, inbox] = await Promise.all([
      wantTasks ? countOpenTasks(myId) : Promise.resolve(0),
      wantInbox ? countInboxUnread() : Promise.resolve(0),
    ])
    if (run !== runRef.current) return   // neuerer Abruf oder abgemeldet
    // null = Abruf fehlgeschlagen (Netz, Timeout): alten Wert behalten, statt
    // fälschlich "nichts offen" zu zeigen
    setBadges(prev => {
      const tasksOpen = tasks ?? prev.tasksOpen
      const inboxUnread = inbox ?? prev.inboxUnread
      return prev.tasksOpen === tasksOpen && prev.inboxUnread === inboxUnread ? prev : { tasksOpen, inboxUnread }
    })
  }, [myId, wantTasks, wantInbox])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastFetchRef.current > REFOCUS_MIN_AGE_MS) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      runRef.current++   // laufende Antwort verwerfen
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const refresh = useCallback(() => { void load() }, [load])

  return { badges, refresh }
}
