// Gemeinsame Helfer von werbe-autopilot (Antworten, DB-Seiten, Fehlerklassen,
// Berlin-Kalender, deterministische Gruppen-IDs, Stopp-Mail). Nur von
// werbe-autopilot/*.ts importiert.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { CI, CI_FONT } from '../_shared/brand.ts'
import { berlinTag, datumPlus } from '../_shared/werbeMathe.ts'

export type Sb = SupabaseClient

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
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

/** Kurzer Fehlertext aus einem PostgREST-/Supabase-Fehlerobjekt (ohne Werte aus Headern). */
export function dbFehler(error: unknown): string {
  const e = error as { code?: string; message?: string; details?: string } | null
  if (!e) return 'unbekannter DB-Fehler'
  return `${e.code ? `${e.code}: ` : ''}${String(e.message ?? e).slice(0, 300)}`
}

export function dbCode(error: unknown): string {
  return String((error as { code?: string } | null)?.code ?? '')
}

export function tabelleFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(String(e?.message ?? ''))
}

export function spalteFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42703' || e?.code === 'PGRST204' || /column .* does not exist|could not find the .* column/i.test(String(e?.message ?? ''))
}

export function funktionFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === 'PGRST202' || e?.code === '42883' || /could not find the function/i.test(String(e?.message ?? ''))
}

export const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
export const toStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
export const digits = (v: unknown): string => String(v ?? '').replace(/[^0-9]/g, '')

export type Abfrage = (von: number, bis: number) => Promise<{ data: unknown; error: unknown }>

/**
 * Liest eine Abfrage seitenweise (PostgREST liefert höchstens 1000 Zeilen je Aufruf).
 * Seriell, mit Obergrenze `max` (Micro-DB). Wirft bei DB-Fehlern mit Tabellenname.
 */
export async function alleZeilen<T>(abfrage: Abfrage, name: string, max = 5000, seite = 1000): Promise<T[]> {
  const out: T[] = []
  for (let von = 0; von < max; von += seite) {
    const bis = Math.min(von + seite, max) - 1
    const { data, error } = await abfrage(von, bis)
    if (error) {
      const err = new Error(`${name}: ${dbFehler(error)}`) as Error & { db?: unknown }
      err.db = error
      throw err
    }
    const rows = Array.isArray(data) ? (data as T[]) : []
    out.push(...rows)
    if (rows.length < bis - von + 1) break
  }
  return out
}

/** Teilt eine Liste in Stücke (für .in()-Filter). */
export function stuecke<T>(liste: T[], n = 150): T[][] {
  const out: T[][] = []
  for (let i = 0; i < liste.length; i += n) out.push(liste.slice(i, i + n))
  return out
}

// ── Kalender Europe/Berlin ──────────────────────────────────────────────────

/** Heute und gestern als Berlin-Kalendertag. */
export function berlinHeute(now: Date): { heute: string; gestern: string; wochentag: number } {
  const b = berlinTag(now.getTime())
  return { heute: b.datum, gestern: datumPlus(b.datum, -1), wochentag: b.wochentag }
}

/** UTC-Zeitpunkt (ms) von 00:00 Uhr Berlin an einem Kalendertag (sommerzeitsicher). */
export function berlinMitternacht(datum: string): number {
  const basis = Date.parse(`${datum.slice(0, 10)}T00:00:00Z`)
  for (const off of [2, 1]) {
    const t = basis - off * 3600000
    if (berlinTag(t).datum === datum && berlinTag(t - 1).datum !== datum) return t
  }
  return basis - 3600000
}

/** Letzte Millisekunde eines Berlin-Kalendertags (UTC-ms). */
export function berlinTagesende(datum: string): number {
  return berlinMitternacht(datumPlus(datum, 1)) - 1
}

/** ISO-Kalenderwoche (Jahr, Woche) eines Datums YYYY-MM-DD. */
export function isoWoche(datum: string): { jahr: number; woche: number } {
  const d = new Date(`${datum.slice(0, 10)}T00:00:00Z`)
  const tag = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - tag + 3)
  const jahr = d.getUTCFullYear()
  const erster = new Date(Date.UTC(jahr, 0, 4))
  const woche = 1 + Math.round(((d.getTime() - erster.getTime()) / 86400000 - 3 + ((erster.getUTCDay() + 6) % 7)) / 7)
  return { jahr, woche }
}

// ── Deterministische IDs ────────────────────────────────────────────────────

async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/**
 * UUID aus einem Text (gleicher Text = gleiche UUID). Damit bekommt eine
 * Vorschlagsgruppe (Plan-B-Paar, Kennung über A+B) bei einem Wiederholungslauf
 * dieselbe gruppe_id.
 */
export async function uuidAusText(s: string): Promise<string> {
  const b = (await sha256Bytes(`werbe-autopilot:${s}`)).slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ── Hintergrund ─────────────────────────────────────────────────────────────

/** Arbeit nach der Antwort weiterlaufen lassen (Supabase EdgeRuntime), sonst abwarten. */
export async function imHintergrund(arbeit: Promise<unknown>): Promise<boolean> {
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
  if (rt && typeof rt.waitUntil === 'function') {
    rt.waitUntil(arbeit)
    return true
  }
  await arbeit
  return false
}

// ── Function-zu-Function ────────────────────────────────────────────────────

/** POST an eine andere Edge Function mit dem Service-Key. Wirft nie. */
export async function funktionAufrufen(
  name: string,
  body: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; status: number; json: unknown; fehler?: string }> {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) return { ok: false, status: 0, json: null, fehler: 'SUPABASE_URL oder Service-Key fehlt' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await r.text()
    let j: unknown = null
    try { j = text ? JSON.parse(text) : null } catch { j = { raw: text.slice(0, 200) } }
    return { ok: r.ok, status: r.status, json: j }
  } catch (err) {
    const abgebrochen = err instanceof Error && err.name === 'AbortError'
    return { ok: false, status: 0, json: null, fehler: abgebrochen ? `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s` : errMsg(err).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

// ── Mail an Sven (nur an ihn, nie an Kunden) ────────────────────────────────

const MAIL_AN = 'sven@happy-property.com'
export const AUTOPILOT_LINK = 'https://portal.happy-property.com/admin/crm/ads?tab=autopilot'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Kurze Stopp-Mail an Sven über send-email (Service-Key). Wirft nie, höchstens 15 s. */
export async function stoppMail(gruende: string[], modusVorher: string, modusNachher: string): Promise<boolean> {
  const punkte = gruende.slice(0, 8).map(g => `<li>${esc(g.slice(0, 300))}</li>`).join('')
  const modusSatz = modusVorher !== modusNachher
    ? `Der Modus steht jetzt auf „${esc(modusNachher)}“ (vorher „${esc(modusVorher)}“). Es wird nichts mehr automatisch bei Meta geändert, bis du ihn nach der Prüfung wieder hochstellst.`
    : `Der Modus bleibt „${esc(modusNachher)}“. Solange der Grund besteht, entstehen keine automatischen Änderungen.`
  const html = `<div style="font-family:${CI_FONT.body},Arial,sans-serif;font-size:14px;line-height:1.5;color:${CI.navy}">
<p>Hallo Sven,</p>
<p>der Werbe-Autopilot hat heute Nacht angehalten:</p>
<ul>${punkte}</ul>
<p>${modusSatz}</p>
<p><a href="${AUTOPILOT_LINK}" style="color:${CI.coral}">Autopilot im Werbemanager öffnen</a></p>
</div>`
  const r = await funktionAufrufen('send-email', {
    to: MAIL_AN,
    subject: 'Werbe-Autopilot angehalten',
    html,
    auto: true,
    lang: 'de',
    already_translated: true,
    no_footer: true,
    from_name: 'Werbe-Autopilot',
  }, 15_000)
  if (!r.ok) console.warn('[werbe-autopilot] Stopp-Mail fehlgeschlagen:', r.status, r.fehler ?? '')
  return r.ok
}
