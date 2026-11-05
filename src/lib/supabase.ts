import { createClient } from '@supabase/supabase-js'
import { isPreviewActive, previewAllows } from './preview'

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
// Ausnahme für die wenigen Edge Functions, die im Browser synchron laufen und
// nachweislich länger als 20 s brauchen (Edge-Log 9/2026): compose-deck-mail
// 23-27 s (zwei Claude-Aufrufe), generate-deck ohne background 80-128 s
// (Newsletter-Master-Deck). Mit 20 s brach der Browser ab und die KI-Begleitmail
// kam nie an. Für sie gilt das Gateway-Limit von 150 s; alle übrigen Functions,
// REST, Storage und Auth behalten ihre Limits.
const LONG_FUNCTION_TIMEOUT_MS = 150_000
const LONG_FUNCTION_URL = /\/functions\/v1\/(compose-deck-mail|generate-deck)(?:[/?]|$)/

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : (input as Request).url ?? ''

  const timeout = url.includes('/auth/v1/') ? AUTH_TIMEOUT_MS
    : LONG_FUNCTION_URL.test(url) ? LONG_FUNCTION_TIMEOUT_MS
    : DATA_TIMEOUT_MS

  // Portal-Vorschau des Admins: nur lesen, nie schreiben (siehe lib/preview.ts)
  if (isPreviewActive()) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!previewAllows(url, method)) {
      return Promise.resolve(new Response(
        JSON.stringify({ message: 'Vorschau: nur ansehen, hier wird nichts gespeichert.', error: 'Vorschau: nur ansehen, hier wird nichts gespeichert.', code: 'preview_readonly' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ))
    }
  }

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

const AUTH_STORAGE_KEY = 'happy-property-auth'

// Umzug auf den eigenen Server: Sitzungen aus der Cloud tragen ein ES256-Token, das
// der eigene Server nicht prüfen kann (er signiert mit HS256). Die Refresh-Tokens
// ziehen mit um. Darum das Token als abgelaufen markieren: supabase-js holt dann beim
// Start ein neues, bevor die erste Abfrage läuft, und niemand wird abgemeldet.
// Solange das Frontend auf die Cloud zeigt, macht dieser Block nichts.
export function markForeignSessionExpired(url: string, storage: Storage): void {
  if (url.includes('.supabase.co')) return
  try {
    const raw = storage.getItem(AUTH_STORAGE_KEY)
    const session = raw ? JSON.parse(raw) as { access_token?: string; expires_at?: number } : null
    if (!session?.access_token || session.expires_at === 0) return
    const header = JSON.parse(atob(session.access_token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))) as { alg?: string }
    if (header.alg === 'HS256') return
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ ...session, expires_at: 0 }))
  } catch {
    // Unlesbare Sitzung: supabase-js entscheidet wie bisher selbst.
  }
}

markForeignSessionExpired(supabaseUrl, window.localStorage)

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: true,
    storageKey:         AUTH_STORAGE_KEY,
    storage:            window.localStorage,
  },
  global: {
    fetch: fetchWithTimeout,
  },
})
