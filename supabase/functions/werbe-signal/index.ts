// Edge Function: werbe-signal
// Leert den CAPI-Ausgang (capi_outbox) und meldet die Ereignisse über die Conversions API
// an das Meta-Pixel: Termin gebucht (Schedule), Termin stattgefunden (AppointmentHeld),
// Daumen hoch (QualifiedLead), Abschluss (Purchase mit Provision), Lead.
// Die Zeilen legen Trigger in der DB an (Migration 20261003112000_capi_outbox.sql);
// ist ad_settings.capi_echtzeit an, stößt pg_net diese Function sofort an.
// meta-ads-sync bleibt das Nachhol-Netz mit denselben event_ids (Dedupe über capi_log).
//
// Body (JSON):
//   { aktion: 'outbox', anlass?: <event_id>, limit?: 1..1000 (Standard 500),
//     test_event_code?: string, dry_run?: true }
//   dry_run: nichts beanspruchen, nichts senden, nichts schreiben; zeigt nur, was passieren würde.
// Antwort: { success, aktion, anlass, runden, geclaimt, gesendet, uebersprungen: {grund: n},
//            wiederholen, fehler, test, warnungen }
//
// Ablauf je Runde (höchstens 4 Runden, ca. 45 s):
//   1 Claim per RPC werbe_capi_claimen(p_limit) (5-Minuten-Lease, versuche + 1, nur System)
//   2 Überspringen (status 'uebersprungen', grund): zu_alt (> 7 Tage, Meta verwirft sonst den
//     ganzen Sammel-POST), bereits_gesendet (event_id schon in capi_log), ohne_lead,
//     lead_fehlt, kein_meta_lead (istMetaLead aus _shared/werbeCapi.ts), keine_merkmale
//   3 Events bauen (kandidatAusLead + buildCapiEvent): Schedule als Website-Ereignis mit
//     content_category kap_ja/kap_nein (Antwort „Kapitalbasis“ im Funnel) und Wert
//     = Gewicht gebucht x ev_ref_eur aus ad_ev_weights (aktiv), nur wenn ev_ref_eur gesetzt;
//     Purchase mit commission_amount (aus der Zeile, sonst aus deals)
//   4 EIN POST an /{pixel}/events (sendCapiEvents, graphPost: respektiert META_WRITES_DISABLED)
//   5 Erfolg: capi_log (event_id, event_name, lead_id) schreiben, damit meta-ads-sync nie doppelt
//     sendet; Zeilen 'gesendet' mit antwort. Mit test_event_code KEIN capi_log-Eintrag (Test-
//     Ereignisse zählen bei Meta nicht; der Tageslauf meldet das echte Ereignis nach).
//   6 Fehler: Validierungsfehler im Sammel-POST -> einzeln senden, um die kaputte Zeile zu
//     finden ('fehler'); sonst Zeile bleibt 'offen' (Claim gelöst, fehler-Text), nach 5
//     Versuchen 'fehler'.
// META_WRITES_DISABLED=1: nichts beanspruchen, Ausgang bleibt offen.
//
// Aufrufer (gateCaller): pg_cron/pg_net mit x-cron-secret, andere Functions mit Service-Key,
// eingeloggte Admins.
//
// ── Secrets (Supabase Dashboard -> Settings -> Edge Functions -> Secrets) ──
//   META_ACCESS_TOKEN   = System-User-Token „Analytics Sync"
//   META_PIXEL_ID       = 1083578343946189 (Standard im Code, gleiches Pixel wie meta-ads-sync)
//   META_GRAPH_VERSION  = optional, Form vNN.0 (Standard v25.0)
//   META_WRITES_DISABLED = 1 sperrt den Versand
//
// ── Deployment ──
//   supabase functions deploy werbe-signal --no-verify-jwt
//   (config.toml: [functions.werbe-signal] verify_jwt = false; Schutz im Code)

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { MetaApiError, metaWritesDisabled } from '../_shared/metaGraph.ts'
import {
  buildCapiEvent, CAPI_LEAD_FIELDS, CAPI_LEAD_FIELDS_ALT, CAPI_MAX_ALTER_SEK, type CapiEvent, type CapiLead,
  istMetaLead, kandidatAusLead, sendCapiEvents,
} from '../_shared/werbeCapi.ts'

type Sb = SupabaseClient

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const STANDARD_LIMIT = 500
const MAX_RUNDEN = 4
const ZEITBUDGET_MS = 45_000
const MAX_VERSUCHE = 5
const MAX_EINZELN = 100
const CHUNK = 200
const WEBSITE_EVENTS = ['Schedule', 'Lead']

interface OutboxZeile {
  id: number
  event_id: string
  event_name: string
  lead_id: string | null
  quelle: string
  quelle_id: string | null
  event_time: string
  daten: Record<string, unknown> | null
  versuche: number
}

interface Kontext {
  sb: Sb
  testCode: string | null
  evRef: number | null
  gewichte: Record<string, unknown>
  warnungen: string[]
}

interface Summe {
  geclaimt: number
  gesendet: number
  uebersprungen: Record<string, number>
  wiederholen: number
  fehler: number
}

interface Geplant { zeile: OutboxZeile; ev: CapiEvent }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const chunks = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n))
  return out
}
const spalteFehlt = (e: unknown) => /column .* does not exist|could not find .* column|42703|PGRST204/i.test(String((e as { message?: string; code?: string })?.message ?? '') + ' ' + String((e as { code?: string })?.code ?? ''))
const funktionFehlt = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null
  return x?.code === 'PGRST202' || x?.code === '42883' || /could not find the function/i.test(String(x?.message ?? ''))
}

// ── Ausgang-Zeilen setzen (nur eigene, noch offene) ─────────────────────────

async function setze(ctx: Kontext, ids: number[], patch: Record<string, unknown>): Promise<void> {
  if (!ids.length) return
  for (const teil of chunks(ids, CHUNK)) {
    const { error } = await ctx.sb.from('capi_outbox')
      .update({ ...patch, updated_at: new Date().toISOString() }).in('id', teil).eq('status', 'offen')
    if (error) {
      const msg = `capi_outbox setzen: ${String(error.message ?? error)}`.slice(0, 200)
      console.error('[werbe-signal]', msg)
      ctx.warnungen.push(msg)
    }
  }
}

async function ueberspringen(ctx: Kontext, summe: Summe, nachGrund: Map<string, OutboxZeile[]>, schreiben: boolean): Promise<void> {
  for (const [grund, zeilen] of nachGrund) {
    if (!zeilen.length) continue
    summe.uebersprungen[grund] = (summe.uebersprungen[grund] ?? 0) + zeilen.length
    if (schreiben) await setze(ctx, zeilen.map(z => z.id), { status: 'uebersprungen', grund, claimed_at: null })
  }
}

/** Fehlversuch: offen lassen (Claim lösen) oder nach MAX_VERSUCHE endgültig 'fehler'. */
async function fehlversuch(ctx: Kontext, summe: Summe, zeilen: OutboxZeile[], msg: string, endgueltig: boolean): Promise<void> {
  const text = msg.slice(0, 500)
  const ende = zeilen.filter(z => endgueltig || z.versuche >= MAX_VERSUCHE)
  const nochmal = zeilen.filter(z => !ende.includes(z))
  await setze(ctx, ende.map(z => z.id), { status: 'fehler', fehler: text, claimed_at: null })
  await setze(ctx, nochmal.map(z => z.id), { fehler: text, claimed_at: null })
  summe.fehler += ende.length
  summe.wiederholen += nochmal.length
}

// ── Planen: filtern + Events bauen ──────────────────────────────────────────

async function ladeLeads(ctx: Kontext, ids: string[]): Promise<Map<string, CapiLead>> {
  const out = new Map<string, CapiLead>()
  let felder = CAPI_LEAD_FIELDS
  for (const teil of chunks(ids, CHUNK)) {
    let res = await ctx.sb.from('leads').select(felder).in('id', teil)
    if (res.error && felder === CAPI_LEAD_FIELDS && spalteFehlt(res.error)) {
      // vor Migration 20261003101000 gibt es leads.meta_leadgen_id noch nicht
      felder = CAPI_LEAD_FIELDS_ALT
      res = await ctx.sb.from('leads').select(felder).in('id', teil)
    }
    if (res.error) throw new Error(`leads lesen: ${String(res.error.message ?? res.error)}`)
    for (const l of (res.data ?? []) as CapiLead[]) out.set(String(l.id), l)
  }
  return out
}

/** Letzte Antwort auf „Kapitalbasis“ je Lead: 'ja' | 'nein' (fehlt = unbekannt). */
async function ladeKap(ctx: Kontext, leadIds: string[]): Promise<Map<string, 'ja' | 'nein'>> {
  const out = new Map<string, 'ja' | 'nein'>()
  if (!leadIds.length) return out
  try {
    const sessionZuLead = new Map<string, string>()
    for (const teil of chunks(leadIds, CHUNK)) {
      const { data, error } = await ctx.sb.from('funnel_sessions').select('id, lead_id').in('lead_id', teil).limit(2000)
      if (error) throw new Error(String(error.message ?? error))
      for (const s of (data ?? []) as Array<{ id: string; lead_id: string }>) sessionZuLead.set(String(s.id), String(s.lead_id))
    }
    const letzte = new Map<string, { at: string; ans: string }>()
    for (const teil of chunks([...sessionZuLead.keys()], CHUNK)) {
      const { data, error } = await ctx.sb.from('funnel_events').select('session_id, answer, created_at')
        .in('session_id', teil).eq('question_key', 'kapitalbasis').limit(2000)
      if (error) throw new Error(String(error.message ?? error))
      for (const e of (data ?? []) as Array<{ session_id: string; answer: string | null; created_at: string }>) {
        const ans = String(e.answer ?? '').trim().toLowerCase()
        const lead = sessionZuLead.get(String(e.session_id))
        if (!ans || !lead) continue
        const alt = letzte.get(lead)
        if (!alt || String(e.created_at) > alt.at) letzte.set(lead, { at: String(e.created_at), ans })
      }
    }
    for (const [lead, v] of letzte) out.set(lead, v.ans === 'ja' || v.ans === 'yes' ? 'ja' : 'nein')
  } catch (err) {
    // Kapitalbasis ist nur ein Zusatzmerkmal: ohne sie wird trotzdem gesendet
    ctx.warnungen.push(`Kapitalbasis lesen: ${errMsg(err)}`.slice(0, 200))
  }
  return out
}

async function ladeProvisionen(ctx: Kontext, dealIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const teil of chunks(dealIds, CHUNK)) {
    const { data, error } = await ctx.sb.from('deals').select('id, commission_amount').in('id', teil)
    if (error) { ctx.warnungen.push(`deals lesen: ${String(error.message ?? error)}`.slice(0, 200)); return out }
    for (const d of (data ?? []) as Array<{ id: string; commission_amount: unknown }>) {
      const v = toNum(d.commission_amount)
      if (v !== null && v > 0) out.set(String(d.id), v)
    }
  }
  return out
}

async function planen(ctx: Kontext, zeilen: OutboxZeile[]): Promise<{ skip: Map<string, OutboxZeile[]>; geplant: Geplant[] }> {
  const skip = new Map<string, OutboxZeile[]>()
  const weg = (grund: string, z: OutboxZeile) => {
    if (!skip.has(grund)) skip.set(grund, [])
    skip.get(grund)!.push(z)
  }
  const jetzt = Math.trunc(Date.now() / 1000)
  const zeitVon = (z: OutboxZeile) => Math.trunc(Date.parse(z.event_time) / 1000)

  // 1 zu alt / ohne Lead
  let rest: OutboxZeile[] = []
  for (const z of zeilen) {
    const t = zeitVon(z)
    if (!Number.isFinite(t) || t < jetzt - CAPI_MAX_ALTER_SEK) weg('zu_alt', z)
    else if (!z.lead_id) weg('ohne_lead', z)
    else rest.push(z)
  }

  // 2 schon gesendet (meta-ads-sync oder früherer Lauf)
  const gesendet = new Set<string>()
  for (const teil of chunks(rest.map(z => z.event_id), CHUNK)) {
    const { data, error } = await ctx.sb.from('capi_log').select('event_id').in('event_id', teil)
    if (error) throw new Error(`capi_log lesen: ${String(error.message ?? error)}`)
    for (const r of (data ?? []) as Array<{ event_id: string }>) gesendet.add(String(r.event_id))
  }
  rest = rest.filter(z => {
    if (!gesendet.has(z.event_id)) return true
    weg('bereits_gesendet', z)
    return false
  })

  // 3 Leads + Meta-Filter
  const leads = await ladeLeads(ctx, [...new Set(rest.map(z => String(z.lead_id)))])
  rest = rest.filter(z => {
    const l = leads.get(String(z.lead_id))
    if (!l) { weg('lead_fehlt', z); return false }
    if (!istMetaLead(l)) { weg('kein_meta_lead', z); return false }
    return true
  })

  // 4 Zusatzwerte
  const kap = await ladeKap(ctx, [...new Set(rest.filter(z => z.event_name === 'Schedule').map(z => String(z.lead_id)))])
  const ohneProvision = rest.filter(z => z.event_name === 'Purchase' && !(toNum(z.daten?.commission_amount) ?? 0) && z.quelle_id)
  const provisionen = await ladeProvisionen(ctx, [...new Set(ohneProvision.map(z => String(z.quelle_id)))])

  // 5 Events
  const geplant: Geplant[] = []
  for (const z of rest) {
    const lead = leads.get(String(z.lead_id))!
    let value: number | undefined
    let contentCategory: string | null = null
    if (z.event_name === 'Schedule') {
      const k = kap.get(String(z.lead_id))
      if (k) contentCategory = k === 'ja' ? 'kap_ja' : 'kap_nein'
      if (ctx.evRef && ctx.evRef > 0) {
        const w = toNum(k === 'ja' ? ctx.gewichte.gebucht_kap_ja : ctx.gewichte.gebucht) ?? (k === 'ja' ? 1.2 : 0.8)
        value = Math.round(w * ctx.evRef * 100) / 100
      }
    } else if (z.event_name === 'Purchase') {
      const v = toNum(z.daten?.commission_amount) ?? (z.quelle_id ? provisionen.get(String(z.quelle_id)) ?? null : null)
      if (v !== null && v > 0) value = v
    }
    const ev = await buildCapiEvent(kandidatAusLead(lead, {
      event_id: z.event_id,
      event_name: z.event_name,
      event_time: zeitVon(z),
      from_website: WEBSITE_EVENTS.includes(z.event_name),
      ...(value !== undefined ? { value, currency: 'EUR' } : {}),
      ...(contentCategory ? { content_category: contentCategory } : {}),
    }), jetzt)
    if (!ev) weg('keine_merkmale', z)
    else geplant.push({ zeile: z, ev })
  }
  return { skip, geplant }
}

// ── Senden ──────────────────────────────────────────────────────────────────

async function alsGesendet(ctx: Kontext, summe: Summe, teil: Geplant[], antwort: Record<string, unknown>): Promise<void> {
  if (!ctx.testCode) {
    const rows = teil.map(g => ({ event_id: g.zeile.event_id, event_name: g.zeile.event_name, lead_id: g.zeile.lead_id }))
    const { error } = await ctx.sb.from('capi_log').upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true })
    if (error) {
      // Kein Datenverlust: Meta entdoppelt über event_name + event_id, der Tageslauf sendet höchstens erneut
      const msg = `capi_log schreiben: ${String(error.message ?? error)}`.slice(0, 200)
      console.error('[werbe-signal]', msg)
      ctx.warnungen.push(msg)
    }
  }
  await setze(ctx, teil.map(g => g.zeile.id), {
    status: 'gesendet', gesendet_at: new Date().toISOString(), antwort, fehler: null, claimed_at: null,
    grund: ctx.testCode ? 'test_event_code' : null,
  })
  summe.gesendet += teil.length
}

const endgueltigerFehler = (err: unknown) => err instanceof MetaApiError && err.kind === 'validation'

async function senden(ctx: Kontext, summe: Summe, geplant: Geplant[]): Promise<void> {
  if (!geplant.length) return
  try {
    const r = await sendCapiEvents(geplant.map(g => g.ev), { testEventCode: ctx.testCode })
    const verworfen = new Set(r.verworfen)
    const alt = geplant.filter(g => verworfen.has(g.zeile.event_id))
    const ok = geplant.filter(g => !verworfen.has(g.zeile.event_id))
    if (alt.length) await ueberspringen(ctx, summe, new Map([['zu_alt', alt.map(g => g.zeile)]]), true)
    await alsGesendet(ctx, summe, ok, {
      events_received: r.events_received, fbtrace_id: r.fbtrace_id, messages: r.messages.slice(0, 5), test: !!ctx.testCode,
    })
  } catch (err) {
    const msg = err instanceof MetaApiError ? `${err.kind}: ${err.userMsg ?? err.message}` : errMsg(err)
    console.error('[werbe-signal] CAPI-Versand:', msg)
    if (endgueltigerFehler(err) && geplant.length > 1) {
      // Ein kaputtes Event kippt den ganzen Sammel-POST: einzeln senden
      const einzeln = geplant.slice(0, MAX_EINZELN)
      for (const g of einzeln) await senden(ctx, summe, [g])
      await fehlversuch(ctx, summe, geplant.slice(MAX_EINZELN).map(g => g.zeile), msg, false)
      return
    }
    await fehlversuch(ctx, summe, geplant.map(g => g.zeile), msg, endgueltigerFehler(err))
  }
}

// ── Einstieg ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  if (req.method !== 'POST') return json({ success: false, error: 'Nur POST' }, 405)

  const denied = await gateCaller(req, 'werbe-signal', { cron: true, service: true, roles: ['admin'] }, CORS)
  if (denied) return denied

  let body: Record<string, unknown> = {}
  try {
    const raw = await req.json()
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) body = raw as Record<string, unknown>
  } catch { /* leerer Body = outbox */ }
  const aktion = String(body.aktion ?? 'outbox')
  if (aktion !== 'outbox') return json({ success: false, error: `Unbekannte aktion "${aktion}" (erlaubt: outbox)` }, 400)
  const anlass = String(body.anlass ?? '').slice(0, 120) || null
  const dryRun = body.dry_run === true
  const limit = Math.min(1000, Math.max(1, Math.trunc(toNum(body.limit) ?? STANDARD_LIMIT)))
  const start = Date.now()

  if (!dryRun && metaWritesDisabled()) {
    console.warn('[werbe-signal] META_WRITES_DISABLED: Ausgang bleibt offen')
    return json({ success: true, aktion, anlass, gesperrt: 'META_WRITES_DISABLED', gesendet: 0, hinweis: 'Ausgang bleibt offen' })
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const ctx: Kontext = { sb, testCode: null, evRef: null, gewichte: {}, warnungen: [] }
  const summe: Summe = { geclaimt: 0, gesendet: 0, uebersprungen: {}, wiederholen: 0, fehler: 0 }

  try {
    // Test-Code (nur für Tests mit Svens eigenen Daten) + Wertleiter
    const { data: st, error: sErr } = await sb.from('ad_settings').select('capi_test_event_code').eq('id', 'default').maybeSingle()
    if (sErr && !spalteFehlt(sErr)) throw new Error(`ad_settings lesen: ${String(sErr.message ?? sErr)}`)
    const bodyCode = typeof body.test_event_code === 'string' ? body.test_event_code.trim() : ''
    const dbCode = String((st as { capi_test_event_code?: string | null } | null)?.capi_test_event_code ?? '').trim()
    ctx.testCode = (bodyCode || dbCode || null)?.slice(0, 64) ?? null
    if (ctx.testCode) ctx.warnungen.push('test_event_code aktiv: Ereignisse gehen als Test an Meta und landen nicht in capi_log')

    const { data: ev, error: eErr } = await sb.from('ad_ev_weights').select('weights, ev_ref_eur').eq('status', 'aktiv').maybeSingle()
    if (eErr) ctx.warnungen.push(`ad_ev_weights lesen: ${String(eErr.message ?? eErr)}`.slice(0, 200))
    const evRow = (ev ?? null) as { weights?: Record<string, unknown> | null; ev_ref_eur?: unknown } | null
    ctx.gewichte = evRow?.weights ?? {}
    ctx.evRef = toNum(evRow?.ev_ref_eur)

    if (dryRun) {
      const { data, error } = await sb.from('capi_outbox').select('*').eq('status', 'offen').order('id', { ascending: true }).limit(limit)
      if (error) throw new Error(`capi_outbox lesen: ${String(error.message ?? error)}`)
      const zeilen = (data ?? []) as OutboxZeile[]
      const { skip, geplant } = await planen(ctx, zeilen)
      await ueberspringen(ctx, summe, skip, false)
      return json({
        success: true, aktion, anlass, dry_run: true, offen: zeilen.length, wuerde_senden: geplant.length,
        uebersprungen: summe.uebersprungen, test: !!ctx.testCode,
        beispiel: geplant.slice(0, 20).map(g => ({ event_id: g.zeile.event_id, event_name: g.zeile.event_name, custom_data: g.ev.custom_data ?? null, action_source: g.ev.action_source })),
        warnungen: ctx.warnungen,
      })
    }

    let runden = 0
    while (runden < MAX_RUNDEN && Date.now() - start < ZEITBUDGET_MS) {
      const { data, error } = await sb.rpc('werbe_capi_claimen', { p_limit: limit })
      if (error) {
        if (funktionFehlt(error)) return json({ success: false, error: 'werbe_capi_claimen fehlt (Migration 20261003112000 nicht eingespielt)' }, 503)
        throw new Error(`Claim: ${String(error.message ?? error)}`)
      }
      const zeilen = (data ?? []) as OutboxZeile[]
      runden++
      if (!zeilen.length) break
      summe.geclaimt += zeilen.length
      try {
        const { skip, geplant } = await planen(ctx, zeilen)
        await ueberspringen(ctx, summe, skip, true)
        await senden(ctx, summe, geplant)
      } catch (err) {
        // DB-Fehler beim Planen: Claims lösen, später erneut
        await fehlversuch(ctx, summe, zeilen, `intern: ${errMsg(err)}`, false)
        throw err
      }
      if (zeilen.length < limit) break
    }
    console.log(`[werbe-signal] ${anlass ?? 'ohne Anlass'}: geclaimt ${summe.geclaimt}, gesendet ${summe.gesendet}, übersprungen ${JSON.stringify(summe.uebersprungen)}, wiederholen ${summe.wiederholen}, fehler ${summe.fehler}`)
    return json({ success: true, aktion, anlass, runden, ...summe, test: !!ctx.testCode, warnungen: ctx.warnungen, dauer_ms: Date.now() - start })
  } catch (err) {
    const msg = errMsg(err)
    console.error('[werbe-signal]', msg)
    return json({ success: false, error: msg.slice(0, 400), ...summe, warnungen: ctx.warnungen }, 500)
  }
})
