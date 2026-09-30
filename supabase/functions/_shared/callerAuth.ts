// Gemeinsamer Aufrufer-Guard für Edge Functions.
//
// WARUM: verify_jwt=true am Gateway ist KEIN Schutz, der öffentliche
// publishable Key (steckt im Frontend-Bundle) gilt dort als gültiger "JWT".
// Jede Function, die etwas Schreibendes oder Kostenpflichtiges tut, prüft den
// Aufrufer deshalb selbst. Muster wie authorize() in social-agent.
//
// Erlaubte Aufrufer, je Function per CallerRule freigeschaltet:
//   cron     x-cron-secret == connector_secrets[cronKey] (Standard 'CRON_SECRET')
//   service  Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (Function-zu-Function,
//            auch pg_cron-Jobs, die den sb_secret-Key inline schicken), ODER ein
//            vom Gateway daraus erzeugter service_role-JWT ("minted", nur bei
//            verify_jwt=true), aber nur mit GEPRÜFTER Signatur (isSignedServiceJwt)
//   roles    eingeloggter Nutzer mit einer dieser Rollen (explizit aufzählen,
//            admin/verwalter sind NICHT automatisch dabei)
//   perms    Rolle mitarbeiter mit mindestens einem dieser Rechte (spiegelt
//            hasPerm aus src/lib/auth.tsx, inkl. werbung_<segment> für 'werbung')
//   anyUser  jeder eingeloggte Nutzer mit gültigem JWT (z.B. Eigentümerportal)
// Nutzer mit profiles.is_active === false werden immer abgewiesen.
//
// Nie Header-Werte loggen. Secrets werden bei jedem Aufruf frisch gelesen.
//
// Nutzung (nach dem OPTIONS-Zweig):
//   const caller = await authorizeCaller(req, { cron: true, service: true, roles: ['admin'] }, CORS)
//   if (caller instanceof Response) return caller

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type Caller =
  | { kind: 'cron' }
  | { kind: 'service' }
  | { kind: 'user'; userId: string; role: string; permissions: Record<string, boolean> }

export interface CallerRule {
  /** x-cron-secret == connector_secrets[cronKey] akzeptieren */
  cron?: boolean
  /** Schlüssel in connector_secrets, Standard 'CRON_SECRET' */
  cronKey?: string
  /** Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> akzeptieren */
  service?: boolean
  /** Nutzer-Rollen, die ohne weitere Rechte durchdürfen (explizit aufzählen) */
  roles?: string[]
  /** Rolle mitarbeiter: mindestens eines dieser Rechte (wie hasPerm) */
  perms?: string[]
  /** jeder eingeloggte Nutzer (gültiger JWT) */
  anyUser?: boolean
}

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

/** Vergleich in konstanter Zeit (keine frühe Rückkehr beim ersten Unterschied). */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  const n = Math.max(ea.length, eb.length)
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

function decodeJwtPart(part: string): Record<string, unknown> | null {
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const v = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)))
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch { return null }
}

/**
 * Vom Gateway ausgestellter service_role-JWT. Bei verify_jwt=true kann das
 * Gateway einen sb_secret-Key durch einen selbst erzeugten JWT ersetzen (Log:
 * sb_api_key_compatibility=minted). Der zählt nur mit GEPRÜFTER Signatur:
 * asymmetrisch (ES256/RS256 mit kid, Projekt nutzt ES256), verifiziert über
 * auth.getClaims gegen /auth/v1/.well-known/jwks.json, nicht abgelaufen,
 * role=service_role. Nie nur den Payload lesen (das war die Lücke in adsAuth,
 * E3-12). Dadurch unabhängig davon, ob verify_jwt an ist. HS256-Tokens werden
 * nicht angenommen (getClaims würde getUser fragen, das für service_role scheitert).
 */
export async function isSignedServiceJwt(sb: SupabaseClient, jwt: string): Promise<boolean> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return false
  const header = decodeJwtPart(parts[0])
  const payload = decodeJwtPart(parts[1])
  // Vorprüfung ohne Netz: alles andere geht gar nicht erst zur JWKS-Prüfung.
  if (payload?.role !== 'service_role') return false
  if (typeof header?.kid !== 'string' || !['ES256', 'RS256'].includes(String(header?.alg))) return false
  try {
    const auth = sb.auth as unknown as {
      getClaims?: (t: string) => Promise<{ data: { claims?: { role?: unknown } } | null; error: unknown }>
    }
    if (typeof auth.getClaims !== 'function') return false
    const { data, error } = await auth.getClaims(jwt)
    return !error && data?.claims?.role === 'service_role'
  } catch { return false }
}

const AD_SEGMENTS = ['meta', 'youtube', 'google']

/** Spiegel von hasPerm() für die Rolle mitarbeiter. */
function hasAnyPerm(perms: Record<string, boolean>, wanted: string[]): boolean {
  return wanted.some(k =>
    perms[k] === true ||
    (k === 'werbung' && AD_SEGMENTS.some(s => perms[`werbung_${s}`] === true)))
}

function deny(status: 401 | 403 | 503, cors: Record<string, string>): Response {
  const error = status === 401 ? 'Nicht angemeldet'
    : status === 403 ? 'Keine Berechtigung'
    : 'Rechteprüfung fehlgeschlagen'
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

/**
 * Prüft den Aufrufer gegen die Regel. Gibt den Aufrufer zurück oder eine
 * fertige 401/403-Antwort (503 wenn profiles nicht lesbar ist), jeweils mit
 * den CORS-Headern der aufrufenden Function.
 */
export async function authorizeCaller(
  req: Request,
  rule: CallerRule,
  cors: Record<string, string> = corsHeaders,
): Promise<Caller | Response> {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const sb = createClient(url, serviceKey)

  // 1) pg_cron mit x-cron-secret. Passt das Secret nicht, geht es unten weiter
  //    (ein Job, der zusätzlich den Service-Key schickt, bleibt so erlaubt).
  const cronSecret = req.headers.get('x-cron-secret') ?? ''
  if (rule.cron && cronSecret) {
    const { data } = await sb.from('connector_secrets')
      .select('value').eq('key', rule.cronKey ?? 'CRON_SECRET').maybeSingle()
    const stored = (data as { value?: string | null } | null)?.value ?? ''
    if (safeEqual(cronSecret, stored)) return { kind: 'cron' }
  }

  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return deny(401, cors)

  // 2) System-Aufruf mit dem Service-Role-Key (exakter Vergleich, kein Payload-Lesen),
  //    oder der daraus vom Gateway erzeugte service_role-JWT mit geprüfter Signatur.
  if (rule.service && safeEqual(jwt, serviceKey)) return { kind: 'service' }
  if (rule.service && await isSignedServiceJwt(sb, jwt)) return { kind: 'service' }

  // 3) Eingeloggter Nutzer. Der publishable Key besteht getUser nicht.
  const roles = rule.roles ?? []
  const perms = rule.perms ?? []
  if (!rule.anyUser && roles.length === 0 && perms.length === 0) return deny(401, cors)

  let userId = ''
  try {
    const { data } = await sb.auth.getUser(jwt)
    userId = (data?.user?.id as string | undefined) ?? ''
  } catch { /* ungültiger Token */ }
  if (!userId) return deny(401, cors)

  const { data: prof, error } = await sb.from('profiles')
    .select('role, permissions, is_active').eq('id', userId).maybeSingle()
  if (error) return deny(503, cors)
  const p = prof as { role?: string | null; permissions?: Record<string, boolean> | null; is_active?: boolean | null } | null
  if (p?.is_active === false) return deny(403, cors)

  const role = p?.role ?? ''
  const permissions = p?.permissions ?? {}
  const ok = rule.anyUser === true ||
    roles.includes(role) ||
    (role === 'mitarbeiter' && perms.length > 0 && hasAnyPerm(permissions, perms))
  if (!ok) return deny(403, cors)
  return { kind: 'user', userId, role, permissions }
}
