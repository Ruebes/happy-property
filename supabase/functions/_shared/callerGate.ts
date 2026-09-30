// Dünne Hülle um authorizeCaller (callerAuth.ts) mit zwei Ergänzungen.
//
// 1) apikey-Header == SUPABASE_SERVICE_ROLE_KEY zählt als System-Aufruf
//    (nur wenn rule.service). WARUM: supabase-js ab ca. 2.11x (die Edge-Runtime
//    lädt jsr:@supabase/supabase-js@2 = jeweils aktuell, laut Logs 2.112-2.117)
//    schickt bei functions.invoke mit einem sb_secret-Key KEINEN
//    Authorization-Header mehr, nur `apikey` (omitApiKeyAsBearer). callerAuth
//    prüft nur Authorization und würde jeden functions.invoke-Aufruf aus einer
//    anderen Function mit 401 abweisen - also fast alle automatischen Mails und
//    WhatsApps. Aufrufe per fetch mit `Authorization: Bearer <Service-Key>`
//    deckt callerAuth selbst ab.
//
// 2) Beobachtungsmodus ohne Neu-Deploy: steht der Function-Name in der
//    Umgebungsvariable CALLER_GUARD_OBSERVE (Komma-Liste oder '*'), wird eine
//    Abweisung nur geloggt ("[caller-guard] would_block ...") und der Aufruf
//    läuft weiter wie bisher. Ohne die Variable wird abgewiesen.
//    Geloggt werden nur: Function, Status, ob Header vorhanden sind, User-Agent-
//    Anfang. Nie Header-Werte.
//
// Nutzung direkt nach dem OPTIONS-Zweig:
//   const denied = await gateCaller(req, 'send-email', { service: true, anyUser: true }, CORS)
//   if (denied) return denied

import { authorizeCaller, safeEqual, type CallerRule } from './callerAuth.ts'

function observed(fn: string): boolean {
  const list = (Deno.env.get('CALLER_GUARD_OBSERVE') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return list.includes('*') || list.includes(fn)
}

/** null = Aufrufer erlaubt (oder Beobachtungsmodus), sonst fertige 401/403-Antwort. */
export async function gateCaller(
  req: Request,
  fn: string,
  rule: CallerRule,
  cors: Record<string, string>,
): Promise<Response | null> {
  if (rule.service && safeEqual(req.headers.get('apikey') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) {
    return null
  }
  const caller = await authorizeCaller(req, rule, cors)
  if (!(caller instanceof Response)) return null
  if (observed(fn)) {
    console.warn('[caller-guard] would_block', JSON.stringify({
      fn,
      status: caller.status,
      auth: req.headers.has('authorization'),
      apikey: req.headers.has('apikey'),
      cron: req.headers.has('x-cron-secret'),
      ua: (req.headers.get('user-agent') ?? '').slice(0, 40),
    }))
    return null
  }
  return caller
}
