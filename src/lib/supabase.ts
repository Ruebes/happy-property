import { createClient } from '@supabase/supabase-js'

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

// Globales 15s-Timeout für alle Supabase-Requests (Auth + Data).
// Verhindert endlose Ladezustände bei instabiler Verbindung.
function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
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
