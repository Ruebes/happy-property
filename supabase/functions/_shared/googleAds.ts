// googleAds — gemeinsamer Zugang zur Google Ads API (YouTube- und Google-Werbung).
//
// Zugang seit 16.10.2026: Sven verbindet unter Einstellungen → Connectoren sein
// Google-Konto (yt-oauth?target=gads, Scope adwords, gleicher OAuth-Client wie
// YouTube). Der Refresh-Token liegt als GOOGLE_ADS_REFRESH_TOKEN in
// connector_secrets.
//
// Seit 9.9.2026 gibt es keinen Developer-Token mehr: Die Zugriffsstufe (Test,
// Explorer, Basic, Standard) hängt am Google-Cloud-Projekt des OAuth-Clients.
// Explorer reicht für uns (2.880 Operationen/Tag auf echten Konten). Ein alter
// Token in GOOGLE_ADS_DEVELOPER_TOKEN wird noch mitgeschickt, Google ignoriert ihn.
//
// connector_secrets:
//   GOOGLE_ADS_REFRESH_TOKEN        Pflicht (über „Verbinden")
//   GOOGLE_ADS_CUSTOMER_ID          Werbekonto, 10 Ziffern (ohne Bindestriche)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID    nur nötig, wenn der Zugriff über ein Verwaltungskonto (MCC) läuft
//   GOOGLE_ADS_ACCOUNT              Google-Konto, das zugestimmt hat (Anzeige)
//   YOUTUBE_CLIENT_ID / _SECRET     OAuth-Client (geteilt mit YouTube und Drive)
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const GADS_VERSION = 'v25'
export const GADS_SCOPE = 'https://www.googleapis.com/auth/adwords'
const BASE = `https://googleads.googleapis.com/${GADS_VERSION}`

export async function gadsSecret(sb: SupabaseClient, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return ((data as { value?: string } | null)?.value ?? Deno.env.get(key) ?? '').trim()
}

/** Kunden-ID ohne Bindestriche/Leerzeichen; leer, wenn keine 10 Ziffern. */
export function cleanCustomerId(v: string): string {
  const d = (v ?? '').replace(/\D/g, '')
  return d.length === 10 ? d : ''
}

export interface GadsCtx {
  accessToken: string
  customerId: string
  loginCustomerId: string
  developerToken: string
}

/** Frischer Access-Token aus dem Refresh-Token. Wirft mit verständlicher Meldung. */
export async function gadsAccessToken(sb: SupabaseClient, refreshToken?: string): Promise<string> {
  const [cid, csec, stored] = await Promise.all([
    gadsSecret(sb, 'YOUTUBE_CLIENT_ID'), gadsSecret(sb, 'YOUTUBE_CLIENT_SECRET'),
    refreshToken ? Promise.resolve(refreshToken) : gadsSecret(sb, 'GOOGLE_ADS_REFRESH_TOKEN'),
  ])
  if (!stored) throw new Error('Google Ads ist nicht verbunden (Einstellungen → Connectoren → Google Ads → Verbinden).')
  if (!cid || !csec) throw new Error('OAuth-Client (YOUTUBE_CLIENT_ID/-SECRET) fehlt.')
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: stored, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.json()).catch(() => ({})) as { access_token?: string; error?: string; error_description?: string }
  if (!tr.access_token) throw new Error(`Google lehnt den Zugang ab (${tr.error ?? 'unbekannt'}${tr.error_description ? `: ${tr.error_description}` : ''}). Bitte neu verbinden.`)
  return tr.access_token
}

export async function gadsContext(sb: SupabaseClient): Promise<GadsCtx> {
  const [accessToken, cust, login, dev] = await Promise.all([
    gadsAccessToken(sb),
    gadsSecret(sb, 'GOOGLE_ADS_CUSTOMER_ID'),
    gadsSecret(sb, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'),
    gadsSecret(sb, 'GOOGLE_ADS_DEVELOPER_TOKEN'),
  ])
  const customerId = cleanCustomerId(cust)
  if (!customerId) throw new Error('Google-Ads-Kunden-ID fehlt (Connectoren → Google Ads — Kunden-ID → Ändern).')
  return { accessToken, customerId, loginCustomerId: cleanCustomerId(login), developerToken: dev }
}

function headers(ctx: Pick<GadsCtx, 'accessToken' | 'loginCustomerId' | 'developerToken'>): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${ctx.accessToken}`, 'Content-Type': 'application/json' }
  if (ctx.loginCustomerId) h['login-customer-id'] = ctx.loginCustomerId
  if (ctx.developerToken) h['developer-token'] = ctx.developerToken
  return h
}

/** Google-Fehler in einen lesbaren Satz übersetzen (erste Detailmeldung reicht). */
function gadsError(status: number, body: unknown): Error {
  const b = body as { error?: { message?: string; status?: string; details?: Array<{ errors?: Array<{ message?: string; errorCode?: Record<string, string> }> }> } }
  const first = b?.error?.details?.flatMap(d => d.errors ?? [])?.[0]
  const code = first?.errorCode ? Object.values(first.errorCode)[0] : b?.error?.status
  const msg = first?.message ?? b?.error?.message ?? `HTTP ${status}`
  const e = new Error(`Google Ads: ${msg}${code ? ` (${code})` : ''}`)
  ;(e as Error & { code?: string }).code = code
  return e
}

/** Alle Konten, auf die das verbundene Google-Konto direkt zugreifen darf. */
export async function gadsListAccessible(accessToken: string, developerToken = ''): Promise<string[]> {
  const r = await fetch(`${BASE}/customers:listAccessibleCustomers`, {
    headers: headers({ accessToken, loginCustomerId: '', developerToken }), signal: AbortSignal.timeout(15_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw gadsError(r.status, j)
  return ((j as { resourceNames?: string[] }).resourceNames ?? []).map(n => n.split('/')[1]).filter(Boolean)
}

/** GAQL-Abfrage mit Seitenweise-Abruf. Liefert die Zeilen im JSON-Format der REST-API. */
export async function gadsSearch<T = Record<string, unknown>>(
  ctx: Pick<GadsCtx, 'accessToken' | 'loginCustomerId' | 'developerToken'> & { customerId: string },
  query: string,
): Promise<T[]> {
  const rows: T[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${BASE}/customers/${ctx.customerId}/googleAds:search`, {
      method: 'POST', headers: headers(ctx),
      body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(30_000),
    })
    const j = await r.json().catch(() => ({})) as { results?: T[]; nextPageToken?: string }
    if (!r.ok) throw gadsError(r.status, j)
    rows.push(...(j.results ?? []))
    pageToken = j.nextPageToken
    if (!pageToken) break
  }
  return rows
}

export interface GadsCustomerInfo { id: string; name: string; manager: boolean; currency: string; testAccount: boolean }

export async function gadsCustomerInfo(
  ctx: Pick<GadsCtx, 'accessToken' | 'loginCustomerId' | 'developerToken'> & { customerId: string },
): Promise<GadsCustomerInfo> {
  const rows = await gadsSearch<{ customer?: { id?: string; descriptiveName?: string; manager?: boolean; currencyCode?: string; testAccount?: boolean } }>(
    ctx, 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.test_account FROM customer LIMIT 1')
  const c = rows[0]?.customer ?? {}
  return { id: String(c.id ?? ctx.customerId), name: c.descriptiveName ?? '', manager: !!c.manager, currency: c.currencyCode ?? '', testAccount: !!c.testAccount }
}
