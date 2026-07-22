// Rechteprüfung für die Werbe-Edge-Functions (meta-ads-tools, meta-ads-sync).
//
// WARUM DIESE DATEI EXISTIERT:
// Beide Functions laufen mit --no-verify-jwt (der Zielgruppen-Assistent und der
// nächtliche pg_cron-Lauf brauchen das). Ohne eigene Prüfung könnte damit JEDER,
// der die Function-URL kennt, Kampagnen pausieren, Budgets hochsetzen oder
// Zielgruppen überschreiben — ohne Login. Deshalb MUSS die Rolle hier
// server-seitig geprüft werden, genau wie in admin-user-ops.
//
// Regel (spiegelt hasPerm() aus src/lib/auth.tsx):
//   admin, verwalter                → immer erlaubt
//   mitarbeiter                     → braucht permissions.werbung
//                                     ODER irgendein permissions.werbung_<segment>
//   alle anderen Rollen             → verboten
//
// Zusätzlich: ein Aufruf MIT dem Service-Role-Key gilt als System-Aufruf
// (pg_cron / interne Function-zu-Function-Aufrufe) und ist immer erlaubt.

import { createClient } from 'jsr:@supabase/supabase-js@2'

export interface AdsCaller {
  /** true wenn der Aufruf vom System kommt (pg_cron / Service-Role) */
  system: boolean
  /** Profil-ID des eingeloggten Nutzers, null bei System-Aufrufen */
  userId: string | null
  role: string
}

export class AdsAuthError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Prüft den Authorization-Header und wirft AdsAuthError (401/403) wenn der
 * Aufrufer keine Werbe-Rechte hat. Gibt bei Erfolg den Aufrufer zurück.
 */
export async function requireAdsAccess(req: Request): Promise<AdsCaller> {
  const supabaseUrl     = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey         = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) throw new AdsAuthError('Nicht angemeldet', 401)

  // System-Aufruf (pg_cron). Das Projekt nutzt die neuen sb_secret_-Keys, ältere
  // Supabase-Projekte den Legacy-JWT mit role=service_role — beides akzeptieren,
  // damit der Guard nicht am Key-Format hängt.
  // WICHTIG: der publishable/anon-Key zählt NICHT als System — der steckt im
  // öffentlichen Frontend-Bundle und wäre damit für jeden abgreifbar.
  if (serviceRoleKey && jwt === serviceRoleKey) {
    return { system: true, userId: null, role: 'service_role' }
  }
  if (jwt.startsWith('eyJ')) {
    try {
      const claims = JSON.parse(atob(jwt.split('.')[1] ?? ''))
      if (claims?.role === 'service_role') return { system: true, userId: null, role: 'service_role' }
    } catch { /* kein lesbarer JWT — dann eben normale Nutzerprüfung */ }
  }

  const { data: userData } = await createClient(supabaseUrl, anonKey).auth.getUser(jwt)
  const user = userData?.user
  if (!user) throw new AdsAuthError('Nicht angemeldet', 401)

  const admin = createClient(supabaseUrl, serviceRoleKey)
  const { data: prof } = await admin
    .from('profiles').select('role, permissions').eq('id', user.id).maybeSingle()
  const p = prof as { role?: string; permissions?: Record<string, boolean> | null } | null
  const role = p?.role ?? ''
  const perms = p?.permissions ?? {}

  const allowed =
    role === 'admin' ||
    role === 'verwalter' ||
    (role === 'mitarbeiter' && (
      perms.werbung === true ||
      Object.keys(perms).some(k => k.startsWith('werbung_') && perms[k] === true)
    ))

  if (!allowed) throw new AdsAuthError('Keine Berechtigung für den Werbemanager', 403)
  return { system: false, userId: user.id, role }
}
