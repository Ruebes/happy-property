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
// 2) Beobachtungsmodus ohne Neu-Deploy, zeitlich begrenzt: steht in der
//    Umgebungsvariable CALLER_GUARD_OBSERVE (Komma-Liste) ein Eintrag
//    "<function>@<ISO-Ende>", z.B. send-email@2026-10-03T00:00Z, wird eine
//    Abweisung bis zu diesem Zeitpunkt nur geloggt ("[caller-guard] would_block
//    ...") und der Aufruf läuft weiter wie bisher. Danach weist der Guard von
//    selbst ab, auch wenn die Variable vergessen wird. Einträge ohne Ende, mit
//    Ende mehr als 7 Tage in der Zukunft oder '*' gelten nicht (Warnung im Log).
//    Ohne gültigen Eintrag wird abgewiesen.
//    Geloggt werden nur: Function, Status, ob Header vorhanden sind, User-Agent-
//    Anfang. Nie Header-Werte.
//
// Nutzung direkt nach dem OPTIONS-Zweig:
//   const denied = await gateCaller(req, 'send-email', { service: true, anyUser: true }, CORS)
//   if (denied) return denied

import { authorizeCaller, safeEqual, type CallerRule } from './callerAuth.ts'

const OBSERVE_MAX_MS = 7 * 864e5
let warnedBadObserve = false

function observed(fn: string): boolean {
  const list = (Deno.env.get('CALLER_GUARD_OBSERVE') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const now = Date.now()
  let hit = false
  let bad = false
  for (const entry of list) {
    const at = entry.lastIndexOf('@')
    const slug = at > 0 ? entry.slice(0, at).trim() : ''
    const until = at > 0 ? Date.parse(entry.slice(at + 1).trim()) : NaN
    if (!slug || slug === '*' || !Number.isFinite(until) || until - now > OBSERVE_MAX_MS) { bad = true; continue }
    if (slug === fn && until > now) hit = true
  }
  if (bad && !warnedBadObserve) {
    warnedBadObserve = true
    console.warn('[caller-guard] CALLER_GUARD_OBSERVE enthält ungültige Einträge (Format <function>@<ISO-Ende>, höchstens 7 Tage); sie werden ignoriert, der Guard weist ab')
  }
  return hit
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
