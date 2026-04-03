import { createClient } from '@supabase/supabase-js'

/**
 * Admin-Client mit service_role-Key.
 *
 * ⚠️  SICHERHEITSHINWEIS: Der service_role-Key umgeht alle RLS-Policies.
 * Er wird hier nur verwendet weil diese App kein Backend hat.
 * In einer Produktions-App MUSS dieser Key in einem Server-seitigen
 * Backend (Edge Function, API-Route o.ä.) liegen – niemals im Browser.
 *
 * Schutzmaßnahmen in dieser App:
 * - Seiten die supabaseAdmin verwenden sind durch ProtectedRoute(['admin','verwalter']) gesichert
 * - Der Key ist nur im .env und sollte NIEMALS in ein Public-Repo committed werden
 * - autoRefreshToken/persistSession disabled um Session-Konflikte zu vermeiden
 */
const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL as string
const serviceRoleKey  = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY as string

if (!serviceRoleKey) {
  throw new Error('[supabaseAdmin] VITE_SUPABASE_SERVICE_ROLE_KEY ist nicht gesetzt.')
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken:   false,
    persistSession:     false,
    detectSessionInUrl: false,
    // Eigener Storage-Key verhindert Kollision mit dem normalen Supabase-Client.
    // Ohne diesen Key überschreiben sich beide Clients gegenseitig die Session
    // → auth.getSession() hängt → Spinner dreht sich endlos.
    storageKey: 'hp-admin-client',
  },
})
