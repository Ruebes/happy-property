// Gemeinsame Helfer von werbe-ausfuehren (Aufrufer, Antworten, Stopp-Mail).
// Nur von werbe-ausfuehren/*.ts importiert.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { Caller } from '../_shared/callerAuth.ts'
import { CI, CI_FONT } from '../_shared/brand.ts'

export type Sb = SupabaseClient

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

/** Fehlerantwort im Format, das fnErrorDetail (src/lib/fnError.ts) liest. */
export function fehler(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ success: false, error, ...extra }, status)
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export const digits = (v: unknown): string => String(v ?? '').replace(/[^0-9]/g, '')

/**
 * Darf der Aufrufer Meta-Schreibzugriffe auslösen (Freigabe ausführen, Rückgängig,
 * Hochladen)? Spiegelt current_user_has_perm('werbung') in der DB: admin/verwalter
 * immer, mitarbeiter nur mit permissions.werbung (nicht nur ein Segment-Recht).
 * System (Service-Role, pg_cron) immer.
 */
export function darfSchreiben(c: Caller): boolean {
  if (c.kind !== 'user') return true
  if (c.role === 'admin' || c.role === 'verwalter') return true
  return c.role === 'mitarbeiter' && c.permissions?.werbung === true
}

export const akteurVon = (c: Caller): string | null => (c.kind === 'user' ? c.userId : null)

/**
 * Supabase-Client mit dem JWT des eingeloggten Nutzers (anon-Key + Authorization),
 * damit RPCs wie werbe_vorschlag_entscheiden auth.uid() und die DB-Rechte sehen.
 * Nur für Nutzer-Aufrufer, nie für System.
 */
export function nutzerClient(req: Request): Sb {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const MAIL_AN = 'sven@happy-property.com'
const AUTOPILOT_LINK = 'https://portal.happy-property.com/admin/crm/ads?tab=autopilot'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Kurze Mail an Sven, wenn ein Lauf den Autopiloten gestoppt hat (nur an ihn,
 * nie an Kunden). Über send-email mit dem Service-Key; wirft nie, höchstens 15 s.
 */
export async function stoppMail(grund: string, ausloeser: string): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) return false
  const html = `<div style="font-family:${CI_FONT.body},Arial,sans-serif;font-size:14px;line-height:1.5;color:${CI.navy}">
<p>Hallo Sven,</p>
<p>der Werbe-Autopilot hat sich eben selbst gestoppt und führt nichts mehr automatisch aus.</p>
<p><strong>Grund:</strong> ${esc(grund.slice(0, 500))}<br/><strong>Auslöser:</strong> ${esc(ausloeser.slice(0, 200))}</p>
<p>Der Modus steht jetzt höchstens auf „Vorschlag“. Wieder hochstellen kannst nur du, nachdem du die Ursache geprüft hast.</p>
<p><a href="${AUTOPILOT_LINK}" style="color:${CI.coral}">Autopilot im Werbemanager öffnen</a></p>
</div>`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const r = await fetch(`${url}/functions/v1/send-email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: MAIL_AN,
        subject: 'Werbe-Autopilot gestoppt',
        html,
        auto: true,
        lang: 'de',
        already_translated: true,
        no_footer: true,
        from_name: 'Werbe-Autopilot',
      }),
      signal: ctrl.signal,
    })
    if (!r.ok) console.warn('[werbe-ausfuehren] Stopp-Mail: HTTP', r.status)
    return r.ok
  } catch (err) {
    console.warn('[werbe-ausfuehren] Stopp-Mail:', errMsg(err))
    return false
  } finally {
    clearTimeout(timer)
  }
}
