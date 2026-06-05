import { createClient } from '@supabase/supabase-js'

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

// Timeout für Supabase-Requests.
//
// WICHTIG (Spinner-Bug-Fix): Auch Auth-Endpunkte (Token-Refresh) bekommen einen
// Timeout — nur eben einen großzügigeren. Grund: supabase-js serialisiert den
// Token-Refresh über die Web-Locks-API (navigator.locks). Hängt der Refresh-
// Fetch OHNE Timeout (z.B. Tab war im Hintergrund, Verbindung eingeschlafen),
// bleibt der Lock für immer gehalten. Jede nachfolgende DB-Query ruft intern
// auth.getSession() auf → wartet ewig auf denselben Lock → die Seite hängt im
// Spinner und nur ein Reload hilft. Ein endlicher Auth-Timeout bricht den
// hängenden Refresh ab, gibt den Lock frei und das System erholt sich selbst.
// Ein AbortError ≠ 401: supabase-js verwirft die Session NICHT, sondern wieder-
// holt den Refresh später → keine Zwangs-Abmeldung.
const DATA_TIMEOUT_MS = 20_000
const AUTH_TIMEOUT_MS = 15_000   // gesunder Refresh <3s → 15s fängt nur echte Hänger ab

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : (input as Request).url ?? ''

  const timeout = url.includes('/auth/v1/') ? AUTH_TIMEOUT_MS : DATA_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // Ein evtl. vom Aufrufer mitgegebenes Abort-Signal respektieren (mit unserem
  // Timeout-Signal verketten), statt es zu überschreiben.
  const callerSignal = init?.signal
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

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
