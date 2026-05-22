import { createClient } from '@supabase/supabase-js'

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

// Timeout für Supabase-Requests — nur für Datenabfragen, NICHT für Auth.
// Auth-Operationen (Token-Refresh, Sign-in) bekommen kein Timeout, da ein
// abgebrochener Token-Refresh alle nachfolgenden Anfragen mit 401 scheitern
// lässt und eine Zwangs-Abmeldung auslöst.
function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : (input as Request).url ?? ''

  // Auth-Endpunkte ohne Timeout durchlassen
  if (url.includes('/auth/v1/')) {
    return fetch(input, init)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  return fetch(input, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: true,
    storageKey:         'happy-property-auth',
    storage:            window.localStorage,
  },
  global: {
    fetch: fetchWithTimeout,
  },
})
