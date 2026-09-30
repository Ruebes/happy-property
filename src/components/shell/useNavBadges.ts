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

// Offene Aufgaben, die MIR zugewiesen sind (crm_tasks.assigned_to).
async function countOpenTasks(myId: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('crm_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', myId)
      .eq('archived', false)
      .in('status', ['offen', 'in_arbeit'])
    if (error) return 0
    return count ?? 0
  } catch { return 0 }
}

// Ungelesene eingehende Nachrichten im Posteingang (activities.read_at,
// Migration 20260722_inbox_read.sql). Gleiche Auswahl wie die Seite Posteingang:
// E-Mail und WhatsApp mit Kundenbezug. Fehlt die Spalte oder das Recht, zählt 0.
async function countInboxUnread(): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('activities')
      .select('id', { count: 'exact', head: true })
      .in('type', ['email', 'whatsapp'])
      .eq('direction', 'inbound')
      .is('read_at', null)
      .not('lead_id', 'is', null)
    if (error) return 0
    return count ?? 0
  } catch { return 0 }
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
    const [tasksOpen, inboxUnread] = await Promise.all([
      wantTasks ? countOpenTasks(myId) : Promise.resolve(0),
      wantInbox ? countInboxUnread() : Promise.resolve(0),
    ])
    if (run !== runRef.current) return   // neuerer Abruf oder abgemeldet
    setBadges(prev =>
      prev.tasksOpen === tasksOpen && prev.inboxUnread === inboxUnread ? prev : { tasksOpen, inboxUnread })
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
