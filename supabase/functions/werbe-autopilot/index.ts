// Edge Function: werbe-autopilot
// Nachtkette und Wochenlauf des Werbe-Autopiloten (Qualitäts-Score, Regeln,
// Vorrat). Schreibt NIE bei Meta: Meta-Schreibzugriffe macht nur werbe-ausfuehren.
// Liest bei Meta nur: dataset_quality (EMQ, woche) und Lead-Objekte
// (zuordnung_nachtragen).
//
// Aktionen (Body { aktion: ... }):
//   { aktion: 'nacht' }        von meta-ads-sync nach erfolgreichem Sync (kette):
//                              qualitaet -> regeln -> fenster -> vorrat_pruefen
//                              fenster: bestätigte Autopilot-Zeilen mit abgelaufenem expires_at
//                              schließen (abgelehnt/abgelaufen), dann werbe-ausfuehren
//                              { modus: 'fenster' } anstoßen: im Modus autonom täglich, in den
//                              Modi vorschlag/ein_klick an Fenstertagen (change_window_dows), damit
//                              außerhalb des Fensters freigegebene Vorschläge im nächsten Fenster
//                              laufen; nie bei Pause (autopilot_paused_until) oder Modus aus/schatten
//                              vorrat_pruefen: QA-Gate entwurf -> geprueft jede Nacht, auch wenn
//                              ein früherer Schritt scheitert; Fehler brechen nichts ab (kein Ledger)
//   { aktion: 'nachholen' }    Cron 04:50 UTC: holt Schritte nach, deren Vorgänger heute
//                              fertig ist (sync -> qualitaet -> regeln -> fenster), Lease 30 Min.
//                              { erzwingen: true } ignoriert die Vorgänger-Prüfung
//   { aktion: 'woche' }        Cron Mo 05:20 UTC: werbe_ev_kalibrieren, EMQ, Vorrat-Bestand,
//                              Thompson-Briefs (Vorrat-Einträge 'entwurf'), Prognosen auffrischen
//   { aktion: 'vorrat_pruefen', ids? }   QA-Gate entwurf -> geprueft, Prognose,
//                              automatische Freigabe nur nach ad_settings.pool_auto_release_level
//   { aktion: 'zuordnung_nachtragen', schreiben?: false, limit?, seit_tage? }
//                              Meta-Zuordnung für Formular-Leads per Graph; Standard Probelauf
//   { aktion: 'replay', von, bis }      NUR LESEND: Regeln über gespeicherte Qualitätszeilen
//   nacht/nachholen/woche laufen im Hintergrund (Antwort 202), mit { synchron: true }
//   wartet die Antwort auf das Ergebnis.
//
// Ledger: ad_autopilot_runs (eindeutig lauf_datum + schritt, Lauftag = Berlin),
// Schritte qualitaet, regeln, fenster, kalibrieren, woche. 'laeuft' älter als 30 Min. wird
// übernommen, 'fertig' nie wiederholt, 'fehler'/'uebersprungen' beim Nachholen erneut.
//
// Regeln -> Ausgabe je wirksamer Freigabestufe (werbeRegeln.bewerteRegeln):
//   0 (Modus schatten)  ad_autopilot_log art 'schatten'
//   1/2                 ad_actions status NULL, freigabe 'vorgeschlagen', origin 'autopilot',
//                       gruppe_id (deterministisch), idempotency_key, pre_state_hash
//                       (werbeAusfuehren.preStateHash), expires_at; ältere offene Vorschläge
//                       derselben Regel/Entität/Aktion (ganze Gruppe) -> 'abgelaufen'
//   3 (nur Modus autonom) status 'bestätigt', freigabe 'autonom'
//   Stopp               werbeAusfuehren.autopilotStoppen + Mail an sven@happy-property.com
//                       (nur bei Modus-Absenkung oder neuem Stopp-Grund innerhalb 7 Tagen)
//   Aktionsarten, die ad_actions vor Migration 20261003119000 noch nicht kennt, landen
//   als 'schatten' im Log (evidence.nicht_anlegbar).
//
// Aufrufer: gateCaller { cron, service, roles: ['admin'] }.
//
// ── Secrets ──
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Standard), META_ACCESS_TOKEN (nur EMQ und
//   zuordnung_nachtragen), META_PIXEL_ID / META_PAGE_ID optional (Standardwerte in metaGraph.ts)
//
// ── Deployment ──
//   supabase functions deploy werbe-autopilot --no-verify-jwt
//   (config.toml: verify_jwt = false; Guard im Code. Erst nach SQL-A/SQL-B und Svens „jetzt live“.)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { MetaApiError, graphGet, metaEnv } from '../_shared/metaGraph.ts'
import { autopilotStoppen, preStateHash } from '../_shared/werbeAusfuehren.ts'
import { bewerteRegeln, istFenstertag, naechsterFenstertag, type AutopilotModus, type Vorschlag } from '../_shared/werbeRegeln.ts'
import { datumPlus } from '../_shared/werbeMathe.ts'
import {
  CORS, type Sb, berlinHeute, berlinTagesende, dbCode, dbFehler, errMsg, fehler, funktionAufrufen, imHintergrund, json,
  stoppMail, stuecke, toNum, toStr, uuidAusText,
} from './gemeinsam.ts'
import { ladeEinstellungen, ladeKontext, ladeRegeln } from './kontext.ts'
import { briefsErstellen, prognosenAuffrischen, vorratBestand, vorratPruefen } from './vorrat.ts'
import { zuordnungNachtragen } from './nachtrag.ts'
import { replay } from './replay.ts'

const FN = 'werbe-autopilot'
const LEASE_MS = 30 * 60_000
const AKTIONEN = ['nacht', 'nachholen', 'woche', 'vorrat_pruefen', 'zuordnung_nachtragen', 'replay'] as const
type Aktion = typeof AKTIONEN[number]
type Schritt = 'qualitaet' | 'regeln' | 'fenster' | 'kalibrieren' | 'woche'

/** Aktionen, die nur in Änderungsfenstern ausgeführt werden (expires_at muss das nächste Fenster erreichen). */
const FENSTER_AKTIONEN = new Set(['activate', 'ersatz_aktivieren', 'budget_set'])

// ── Ledger ──────────────────────────────────────────────────────────────────

interface Lauf { id: string; datum: string; schritt: Schritt }

async function claimen(sb: Sb, datum: string, schritt: Schritt, now: Date): Promise<Lauf | { skip: string }> {
  const nowIso = now.toISOString()
  const { data, error } = await sb.from('ad_autopilot_runs')
    .insert({ lauf_datum: datum, schritt, status: 'laeuft', started_at: nowIso }).select('id').maybeSingle()
  if (!error && data) return { id: String((data as { id: string }).id), datum, schritt }
  if (error && dbCode(error) !== '23505') throw new Error(`ad_autopilot_runs: ${dbFehler(error)}`)
  const { data: alt, error: aErr } = await sb.from('ad_autopilot_runs')
    .select('id, status, started_at').eq('lauf_datum', datum).eq('schritt', schritt).maybeSingle()
  if (aErr) throw new Error(`ad_autopilot_runs: ${dbFehler(aErr)}`)
  const a = alt as { id: string; status: string; started_at: string } | null
  if (!a) return { skip: 'unbekannt' }
  if (a.status === 'fertig') return { skip: 'schon_fertig' }
  if (a.status === 'laeuft' && now.getTime() - Date.parse(a.started_at) < LEASE_MS) return { skip: 'laeuft_noch' }
  const { data: upd, error: uErr } = await sb.from('ad_autopilot_runs')
    .update({ status: 'laeuft', started_at: nowIso, finished_at: null, fehler: null })
    .eq('id', a.id).eq('status', a.status).eq('started_at', a.started_at).select('id')
  if (uErr) throw new Error(`ad_autopilot_runs: ${dbFehler(uErr)}`)
  if (!Array.isArray(upd) || !upd.length) return { skip: 'parallel_uebernommen' }
  return { id: a.id, datum, schritt }
}

async function abschliessen(sb: Sb, lauf: Lauf, status: 'fertig' | 'fehler' | 'uebersprungen', summary: Record<string, unknown>, fehlerText?: string): Promise<void> {
  const { error } = await sb.from('ad_autopilot_runs').update({
    status, finished_at: new Date().toISOString(), summary, fehler: fehlerText ? fehlerText.slice(0, 1000) : null,
  }).eq('id', lauf.id)
  if (error) console.error(`[${FN}] Ledger ${lauf.schritt}:`, dbFehler(error))
}

async function schrittStatus(sb: Sb, datum: string, schritt: string): Promise<string | null> {
  const { data } = await sb.from('ad_autopilot_runs').select('status').eq('lauf_datum', datum).eq('schritt', schritt).maybeSingle()
  return toStr((data as { status?: string } | null)?.status)
}

/** Einen Schritt mit Ledger ausführen: claim -> arbeit -> fertig/uebersprungen/fehler. */
async function mitLedger(
  sb: Sb, datum: string, schritt: Schritt, now: Date,
  arbeit: (lauf: Lauf) => Promise<{ status: 'fertig' | 'uebersprungen' | 'fehler'; summary: Record<string, unknown>; fehler?: string }>,
): Promise<Record<string, unknown>> {
  const c = await claimen(sb, datum, schritt, now)
  if ('skip' in c) return { schritt, uebersprungen: c.skip }
  try {
    const r = await arbeit(c)
    await abschliessen(sb, c, r.status, r.summary, r.fehler)
    return { schritt, status: r.status, ...(r.fehler ? { fehler: r.fehler } : {}), summary: r.summary }
  } catch (err) {
    const text = errMsg(err)
    console.error(`[${FN}] ${schritt}:`, text)
    await abschliessen(sb, c, 'fehler', {}, text)
    return { schritt, status: 'fehler', fehler: text }
  }
}

// ── Schritt qualitaet ───────────────────────────────────────────────────────

async function schrittQualitaet(sb: Sb, gestern: string) {
  const { data, error } = await sb.rpc('werbe_qualitaet_berechnen', { p_stichtag: gestern })
  if (error) return { status: 'fehler' as const, summary: {}, fehler: `werbe_qualitaet_berechnen: ${dbFehler(error)}` }
  const r = (data ?? {}) as Record<string, unknown>
  if (r.uebersprungen === true) return { status: 'fehler' as const, summary: r, fehler: `werbe_qualitaet_berechnen: ${String(r.grund ?? 'uebersprungen')}` }
  return { status: 'fertig' as const, summary: r }
}

// ── Schritt regeln ──────────────────────────────────────────────────────────

/** Ablauf eines Vorschlags: L1 bis nach dem nächsten Lauf (30 h), L2 24 h; Fenster-Aktionen mindestens bis Ende des nächsten Fenstertags. */
function ablauf(v: Vorschlag, now: Date, dows: number[]): string {
  let t = now.getTime() + (v.stufe === 1 ? 30 : 24) * 3600_000
  if (FENSTER_AKTIONEN.has(v.aktion) || v.nur_im_fenster) {
    const naechstes = naechsterFenstertag(datumPlus(v.window_date, 1), dows)
    if (naechstes) t = Math.max(t, berlinTagesende(naechstes))
  }
  return new Date(t).toISOString()
}

interface LogZeileNeu { [k: string]: unknown }

async function logEinfuegen(sb: Sb, zeilen: LogZeileNeu[]): Promise<number> {
  let n = 0
  for (const teil of stuecke(zeilen, 200)) {
    const { error } = await sb.from('ad_autopilot_log').insert(teil)
    if (error) { console.error(`[${FN}] ad_autopilot_log:`, dbFehler(error)); continue }
    n += teil.length
  }
  return n
}

/** Offene Vorschläge mit abgelaufenem expires_at schließen (gruppenweise, wie die RPC). */
async function abgelaufeneSchliessen(sb: Sb, now: Date, laufId: string): Promise<number> {
  const { data, error } = await sb.from('ad_actions')
    .update({ status: 'abgelehnt', freigabe: 'abgelaufen', result: 'Vorschlag abgelaufen' })
    .eq('origin', 'autopilot').is('status', null).eq('freigabe', 'vorgeschlagen').lt('expires_at', now.toISOString())
    .select('id, gruppe_id, rule_key, rule_version, approval_level, entity_level, entity_id, ad_name, action, before, after, evidence, idempotency_key')
  if (error) { console.warn(`[${FN}] Ablauf:`, dbFehler(error)); return 0 }
  const rows = (data ?? []) as Array<Record<string, unknown>>
  await logEinfuegen(sb, rows.map(r => ablehnungsLog(r, 'abgelaufen', laufId)))
  return rows.length
}

function ablehnungsLog(r: Record<string, unknown>, ergebnis: string, laufId: string): LogZeileNeu {
  return {
    lauf_id: laufId, art: 'ablehnung', rule_key: r.rule_key ?? null, rule_version: r.rule_version ?? null,
    approval_level: r.approval_level ?? null, entity_level: r.entity_level ?? null, entity_id: r.entity_id ?? null,
    entity_name: r.ad_name ?? r.entity_id ?? null, aktion: r.action ?? null, before: r.before ?? null, after: r.after ?? null,
    evidence: r.evidence ?? null, ergebnis, action_id: r.id ?? null, gruppe_id: r.gruppe_id ?? null,
    idempotency_key: r.idempotency_key ?? null, akteur_art: 'system',
  }
}

/** Ältere offene Vorschläge derselben Regel/Entität/Aktion ersetzen, jeweils die ganze Gruppe. */
async function ersetzteSchliessen(sb: Sb, neu: Vorschlag[], laufId: string): Promise<number> {
  const gruppen = new Set<string>()
  for (const v of neu) {
    const { data, error } = await sb.from('ad_actions').select('gruppe_id')
      .eq('origin', 'autopilot').is('status', null).eq('freigabe', 'vorgeschlagen')
      .eq('rule_key', v.rule_key).eq('entity_id', v.entity_id).eq('action', v.aktion)
      .neq('idempotency_key', v.idempotency_key).limit(20)
    if (error) { console.warn(`[${FN}] Ersetzen:`, dbFehler(error)); continue }
    for (const r of (data ?? []) as Array<{ gruppe_id?: string | null }>) if (r.gruppe_id) gruppen.add(r.gruppe_id)
  }
  let n = 0
  for (const g of gruppen) {
    const { data, error } = await sb.from('ad_actions')
      .update({ status: 'abgelehnt', freigabe: 'abgelaufen', result: 'Durch neueren Vorschlag ersetzt' })
      .eq('origin', 'autopilot').is('status', null).eq('freigabe', 'vorgeschlagen').eq('gruppe_id', g)
      .select('id, gruppe_id, rule_key, rule_version, approval_level, entity_level, entity_id, ad_name, action, before, after, evidence, idempotency_key')
    if (error) { console.warn(`[${FN}] Ersetzen:`, dbFehler(error)); continue }
    const rows = (data ?? []) as Array<Record<string, unknown>>
    await logEinfuegen(sb, rows.map(r => ablehnungsLog(r, 'ersetzt', laufId)))
    n += rows.length
  }
  return n
}

/** Stopp-Codes, die in den letzten 7 Tagen schon gemeldet wurden (Mail-Drosselung). */
async function bekannteStopps(sb: Sb, now: Date): Promise<Set<string>> {
  const { data } = await sb.from('ad_autopilot_log').select('evidence')
    .eq('art', 'stopp').gte('ts', new Date(now.getTime() - 7 * 86400000).toISOString()).order('ts', { ascending: false }).limit(50)
  const out = new Set<string>()
  for (const r of (data ?? []) as Array<{ evidence?: Record<string, unknown> | null }>) {
    const codes = r.evidence?.codes
    if (Array.isArray(codes)) for (const c of codes) out.add(String(c))
  }
  return out
}

async function schrittRegeln(sb: Sb, lauf: Lauf, now: Date) {
  // Modus 'aus': nichts laden, nichts bewerten (Qualität läuft trotzdem für die Oberfläche)
  const vorab = await ladeEinstellungen(sb)
  if (vorab.modus === 'aus') {
    return { status: 'uebersprungen' as const, summary: { modus: 'aus', grund: 'Autopilot ist aus' } }
  }
  const { ctx, meta } = await ladeKontext(sb, now)
  const erg = bewerteRegeln(ctx)
  const modus = meta.modus
  const summary: Record<string, unknown> = {
    modus, stichtag: meta.stichtag, info: erg.info, kontext: meta.zaehler, warnungen: meta.warnungen,
    slots_quelle: meta.slots_quelle, vorschlaege: erg.vorschlaege.length,
  }
  if (modus === 'aus') {
    return { status: 'uebersprungen' as const, summary: { ...summary, grund: 'Autopilot ist aus' } }
  }

  const abgelaufen = await abgelaufeneSchliessen(sb, now, lauf.id)
  const zaehler = { schatten: 0, angelegt: 0, autonom: 0, vorhanden: 0, nicht_anlegbar: 0, fehler: 0 }
  const fehlerListe: string[] = []
  const pausiert = !!meta.settingsRoh.autopilot_paused_until && Date.parse(String(meta.settingsRoh.autopilot_paused_until)) > now.getTime()
  const budgetAutonom = !!toStr(meta.settingsRoh.budget_autonomie_freigegeben_at)
  const dows = ctx.settings.change_window_dows

  // Schatten-Einträge desselben Tages nicht doppelt schreiben (Wiederholungslauf)
  const schonGeloggt = new Set<string>()
  const schattenKeys = erg.vorschlaege.filter(v => v.stufe === 0).map(v => v.idempotency_key)
  for (const teil of stuecke(schattenKeys, 100)) {
    const { data } = await sb.from('ad_autopilot_log').select('idempotency_key').eq('art', 'schatten').in('idempotency_key', teil).limit(1000)
    for (const r of (data ?? []) as Array<{ idempotency_key?: string }>) if (r.idempotency_key) schonGeloggt.add(r.idempotency_key)
  }

  const schattenZeilen: LogZeileNeu[] = []
  const vorschlagLog: LogZeileNeu[] = []
  const neuAngelegt: Vorschlag[] = []
  const schattenZeile = async (v: Vorschlag, extra: Record<string, unknown> = {}): Promise<LogZeileNeu> => ({
    lauf_id: lauf.id, art: 'schatten', rule_key: v.rule_key, rule_version: v.rule_version, modus,
    approval_level: v.stufe, entity_level: v.entity_level, entity_id: v.entity_id, entity_name: v.entity_name,
    aktion: v.aktion, before: v.before, after: v.after,
    evidence: { ...v.evidence, grund: v.grund, payload: v.payload, gruppe: v.gruppe_schluessel, nur_im_fenster: v.nur_im_fenster, window_date: v.window_date, ...extra },
    ergebnis: 'wuerde', gruppe_id: await uuidAusText(v.gruppe_schluessel), idempotency_key: v.idempotency_key, akteur_art: 'system',
  })

  for (const v of erg.vorschlaege) {
    // Defensiv: Stufe 3 nur im Modus autonom, nicht pausiert, Budget nur mit Budget-Autonomie
    let stufe: number = v.stufe
    if (stufe === 3 && (modus !== 'autonom' || pausiert)) stufe = 2
    if (stufe === 3 && v.aktion === 'budget_set' && !budgetAutonom) stufe = 2
    if (stufe === 0) {
      if (!schonGeloggt.has(v.idempotency_key)) schattenZeilen.push(await schattenZeile(v))
      zaehler.schatten++
      continue
    }
    const snap = meta.snapAktuell.get(`${v.entity_level}|${v.entity_id}`)
    const hash = await preStateHash({
      status: snap?.status ?? null, effective_status: snap?.effective_status ?? null,
      daily_budget_cents: snap?.daily_budget_cents ?? null, updated_time: snap?.updated_time ?? null,
    })
    const gruppeId = await uuidAusText(v.gruppe_schluessel)
    const autonom = stufe === 3
    const kampagne = toStr(v.payload.campaign_id) ?? snap?.campaign_id ?? null
    const zeile: Record<string, unknown> = {
      platform: 'meta',
      ad_id: v.entity_level === 'ad' ? (v.ad_id ?? v.entity_id) : null,
      ad_name: v.entity_name,
      campaign_name: kampagne ? meta.kampagnenNamen.get(kampagne) ?? null : null,
      action: v.aktion,
      reason: v.grund.slice(0, 500),
      status: autonom ? 'bestätigt' : null,
      origin: 'autopilot',
      entity_level: v.entity_level,
      entity_id: v.entity_id,
      gruppe_id: gruppeId,
      payload: { ...v.payload, entity_name: v.entity_name, nur_im_fenster: v.nur_im_fenster, gruppe: v.gruppe_schluessel },
      before: v.before,
      after: v.after,
      rule_key: v.rule_key,
      rule_version: v.rule_version,
      evidence: { ...v.evidence, grund: v.grund },
      approval_level: stufe,
      freigabe: autonom ? 'autonom' : 'vorgeschlagen',
      expires_at: ablauf({ ...v, stufe: stufe as Vorschlag['stufe'] }, now, dows),
      window_date: v.window_date,
      idempotency_key: v.idempotency_key,
      pre_state_hash: hash,
    }
    const { data, error } = await sb.from('ad_actions').insert(zeile).select('id').maybeSingle()
    if (error) {
      const code = dbCode(error)
      if (code === '23505') { zaehler.vorhanden++; continue }
      if (code === '23514' && /ad_actions_action_check/.test(String((error as { message?: string }).message ?? ''))) {
        zaehler.nicht_anlegbar++
        if (!schonGeloggt.has(v.idempotency_key)) {
          schattenZeilen.push(await schattenZeile(v, { nicht_anlegbar: 'Aktionsart erst nach Migration 20261003119000 als Vorschlag möglich', stufe_soll: stufe }))
        }
        continue
      }
      zaehler.fehler++
      fehlerListe.push(`${v.rule_key} ${v.entity_id}: ${dbFehler(error)}`.slice(0, 300))
      continue
    }
    neuAngelegt.push(v)
    if (autonom) zaehler.autonom++
    else zaehler.angelegt++
    vorschlagLog.push({
      lauf_id: lauf.id, art: 'vorschlag', rule_key: v.rule_key, rule_version: v.rule_version, modus, approval_level: stufe,
      entity_level: v.entity_level, entity_id: v.entity_id, entity_name: v.entity_name, aktion: v.aktion,
      before: v.before, after: v.after, evidence: { ...v.evidence, grund: v.grund },
      ergebnis: autonom ? 'autonom' : 'vorgeschlagen', action_id: (data as { id?: string } | null)?.id ?? null,
      gruppe_id: gruppeId, idempotency_key: v.idempotency_key, akteur_art: 'system',
    })
  }

  // Erkannte Handänderungen (72-h-Sperre) einmal je updated_time protokollieren
  const manuell: LogZeileNeu[] = erg.hinweise
    .filter(h => h.code === 'manuell_erkannt' && h.details?.neu === true)
    .map(h => ({
      lauf_id: lauf.id, art: 'manuell_erkannt', modus, entity_level: h.entity_level ?? null, entity_id: h.entity_id ?? null,
      entity_name: h.entity_name ?? null, evidence: { updated_time: h.details?.updated_time ?? null, gesperrt_bis: h.details?.gesperrt_bis ?? null, text: h.text },
      ergebnis: 'gesperrt', akteur_art: 'system',
    }))

  await logEinfuegen(sb, schattenZeilen)
  await logEinfuegen(sb, vorschlagLog)
  await logEinfuegen(sb, manuell)
  const ersetzt = await ersetzteSchliessen(sb, neuAngelegt, lauf.id)

  // Stopps: Modus absenken (nur ein_klick/autonom), Log, Mail an Sven (gedrosselt)
  let stopp: Record<string, unknown> | null = null
  let modusNachher: AutopilotModus = modus
  if (erg.stopps.length) {
    const codes = erg.stopps.map(s => s.code)
    const bekannt = await bekannteStopps(sb, now)
    const gruende = erg.stopps.map(s => s.text)
    await autopilotStoppen(sb, gruende.join(' | '), { laufId: lauf.id, evidence: { codes, stopps: erg.stopps } })
    modusNachher = modus === 'ein_klick' || modus === 'autonom' ? 'vorschlag' : modus
    const neu = codes.filter(c => !bekannt.has(c))
    const mail = modusNachher !== modus || neu.length > 0
    const gesendet = mail ? await stoppMail(gruende, modus, modusNachher) : false
    stopp = { codes, neu, modus_vorher: modus, modus_nachher: modusNachher, mail: gesendet, mail_gedrosselt: !mail }
  }

  const hinweisCodes: Record<string, number> = {}
  for (const h of erg.hinweise) hinweisCodes[h.code] = (hinweisCodes[h.code] ?? 0) + 1
  return {
    status: 'fertig' as const,
    summary: {
      ...summary,
      ...zaehler,
      abgelaufen,
      ersetzt,
      fehler_liste: fehlerListe.slice(0, 20),
      stopp,
      hinweise_codes: hinweisCodes,
      hinweise: erg.hinweise.slice(0, 40).map(h => ({ code: h.code, rule_key: h.rule_key ?? null, entity_id: h.entity_id ?? null, text: h.text })),
    },
  }
}

// ── Schritt fenster ─────────────────────────────────────────────────────────

/** Lease von werbe_aktionen_claimen (10 Min.): frisch beanspruchte Zeilen nicht anfassen. */
const CLAIM_LEASE_MS = 10 * 60_000
const ABLAUF_SPALTEN = 'id, gruppe_id, rule_key, rule_version, approval_level, entity_level, entity_id, ad_name, action, before, after, evidence, idempotency_key'

/**
 * Bestätigte Autopilot-Zeilen (freigegeben oder autonom) mit abgelaufenem expires_at
 * gruppenweise schließen: status 'abgelehnt', freigabe 'abgelaufen' (wie der Ausführer).
 * Gruppen, an denen der Ausführer gerade arbeitet (frischer Claim), bleiben unberührt.
 */
async function bestaetigteAbgelaufenSchliessen(sb: Sb, now: Date, laufId: string): Promise<number> {
  const { data, error } = await sb.from('ad_actions').select('id, gruppe_id')
    .eq('origin', 'autopilot').eq('status', 'bestätigt').lt('expires_at', now.toISOString()).limit(200)
  if (error) { console.warn(`[${FN}] Ablauf bestätigt:`, dbFehler(error)); return 0 }
  const gruppen = new Set<string>()
  const einzeln: string[] = []
  for (const r of (data ?? []) as Array<{ id: string; gruppe_id?: string | null }>) {
    if (r.gruppe_id) gruppen.add(r.gruppe_id)
    else einzeln.push(r.id)
  }
  const leaseIso = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString()
  let n = 0
  const schliessen = async (feld: 'gruppe_id' | 'id', wert: string): Promise<void> => {
    if (feld === 'gruppe_id') {
      const { data: frisch, error: fErr } = await sb.from('ad_actions').select('id')
        .eq('gruppe_id', wert).eq('status', 'bestätigt').gte('claimed_at', leaseIso).limit(1)
      if (fErr) { console.warn(`[${FN}] Ablauf bestätigt:`, dbFehler(fErr)); return }
      if (Array.isArray(frisch) && frisch.length) return
    }
    const { data: zu, error: uErr } = await sb.from('ad_actions')
      .update({ status: 'abgelehnt', freigabe: 'abgelaufen', result: 'Freigabe abgelaufen' })
      .eq(feld, wert).eq('origin', 'autopilot').eq('status', 'bestätigt')
      .or(`claimed_at.is.null,claimed_at.lt."${leaseIso}"`)
      .select(ABLAUF_SPALTEN)
    if (uErr) { console.warn(`[${FN}] Ablauf bestätigt:`, dbFehler(uErr)); return }
    const rows = (zu ?? []) as Array<Record<string, unknown>>
    await logEinfuegen(sb, rows.map(r => ablehnungsLog(r, 'abgelaufen', laufId)))
    n += rows.length
  }
  for (const g of gruppen) await schliessen('gruppe_id', g)
  for (const id of einzeln) await schliessen('id', id)
  return n
}

/**
 * Abgelaufene Freigaben schließen, dann werbe-ausfuehren { modus: 'fenster' } anstoßen:
 * Modus autonom täglich (autonome K-Pausen laufen sofort), Modi vorschlag/ein_klick an
 * Fenstertagen (außerhalb des Fensters freigegebene Fenster-Aktionen). Nie bei Pause
 * oder Modus aus/schatten, erst nach der heutigen Regelprüfung (Stopps sind bewertet).
 */
async function schrittFenster(sb: Sb, lauf: Lauf, now: Date, opts: { erzwingen: boolean }) {
  const abgelaufen = await bestaetigteAbgelaufenSchliessen(sb, now, lauf.id)
  const { settings, modus } = await ladeEinstellungen(sb)
  const fenstertag = istFenstertag(berlinHeute(now).wochentag, settings.change_window_dows)
  const pauseBis = settings.autopilot_paused_until ? Date.parse(settings.autopilot_paused_until) : Number.NaN
  const pausiert = Number.isFinite(pauseBis) && pauseBis > now.getTime()
  const summary: Record<string, unknown> = { modus, fenstertag, pausiert, abgelaufen_bestaetigt: abgelaufen }
  const anstossen = !pausiert && (modus === 'autonom' || (fenstertag && (modus === 'vorschlag' || modus === 'ein_klick')))
  if (!anstossen) {
    const grund = pausiert ? 'Autopilot pausiert' : (modus === 'aus' || modus === 'schatten') ? `Modus ${modus}` : 'Kein Fenstertag'
    return { status: 'fertig' as const, summary: { ...summary, kick: null, grund } }
  }
  const regelnStatus = await schrittStatus(sb, lauf.datum, 'regeln')
  if (regelnStatus !== 'fertig' && !opts.erzwingen) {
    return { status: 'uebersprungen' as const, summary: { ...summary, kick: null, grund: `Regeln heute nicht fertig (${regelnStatus ?? 'kein Eintrag'})` } }
  }
  // Der Aufruf wird nie vorzeitig abgebrochen (ein abgebrochener Ausführer könnte eine
  // Plan-B-Gruppe halb ändern): nach 20 s läuft er im Hintergrund weiter.
  const aufruf = funktionAufrufen('werbe-ausfuehren', { modus: 'fenster' }, 300_000)
  const frueh = await Promise.race([aufruf, new Promise<null>(res => setTimeout(() => res(null), 20_000))])
  if (!frueh) {
    await imHintergrund(aufruf.then(r => { console.log(`[${FN}] werbe-ausfuehren fenster:`, r.status, JSON.stringify(r.json).slice(0, 500)) }))
    return { status: 'fertig' as const, summary: { ...summary, kick: { angestossen: true, hinweis: 'werbe-ausfuehren läuft weiter, Ergebnis in ad_autopilot_log' } } }
  }
  const kick = { ok: frueh.ok, status: frueh.status, ...(frueh.fehler ? { fehler: frueh.fehler } : {}), antwort: frueh.json }
  if (!frueh.ok) {
    return { status: 'fehler' as const, summary: { ...summary, kick }, fehler: `werbe-ausfuehren fenster: ${frueh.fehler ?? `HTTP ${frueh.status}`}`.slice(0, 300) }
  }
  return { status: 'fertig' as const, summary: { ...summary, kick } }
}

// ── Vorrat-Prüfung (ohne Ledger) ────────────────────────────────────────────

/** QA-Gate des Vorrats (entwurf -> geprueft, Prognose, Auto-Freigabe nach Stufe). Wirft nie. */
async function schrittVorrat(sb: Sb, now: Date): Promise<Record<string, unknown>> {
  try {
    const r = await vorratPruefen(sb, { now })
    return {
      schritt: 'vorrat_pruefen', status: 'fertig',
      summary: { geprueft: r.geprueft, bleibt_entwurf: r.bleibt_entwurf, auto_freigegeben: r.auto_freigegeben, prognosen: r.prognosen, fehler: r.fehler.slice(0, 10) },
    }
  } catch (err) {
    const text = errMsg(err).slice(0, 300)
    console.error(`[${FN}] vorrat_pruefen:`, text)
    return { schritt: 'vorrat_pruefen', status: 'fehler', fehler: text }
  }
}

// ── Kette ───────────────────────────────────────────────────────────────────

/** sync -> qualitaet -> regeln -> fenster; gibt den Abbruchgrund zurück (null = durchgelaufen). */
async function ketteSchritte(sb: Sb, now: Date, opts: { pruefeSync: boolean; erzwingen: boolean }, schritte: Record<string, unknown>[]): Promise<string | null> {
  const { heute, gestern } = berlinHeute(now)
  if (opts.pruefeSync && !opts.erzwingen) {
    const sync = await schrittStatus(sb, heute, 'sync')
    if (sync !== 'fertig') return `Sync heute nicht fertig (${sync ?? 'kein Eintrag'})`
  }
  schritte.push(await mitLedger(sb, heute, 'qualitaet', now, () => schrittQualitaet(sb, gestern)))
  const qStatus = await schrittStatus(sb, heute, 'qualitaet')
  if (qStatus !== 'fertig' && !opts.erzwingen) return `Qualität nicht fertig (${qStatus ?? 'kein Eintrag'})`
  schritte.push(await mitLedger(sb, heute, 'regeln', now, lauf => schrittRegeln(sb, lauf, now)))
  schritte.push(await mitLedger(sb, heute, 'fenster', now, lauf => schrittFenster(sb, lauf, now, { erzwingen: opts.erzwingen })))
  return null
}

async function kette(sb: Sb, now: Date, opts: { pruefeSync: boolean; erzwingen: boolean }): Promise<Record<string, unknown>> {
  const { heute } = berlinHeute(now)
  const schritte: Record<string, unknown>[] = []
  const grund = await ketteSchritte(sb, now, opts, schritte)
  // Vorrat jede Nacht prüfen, auch wenn ein Schritt davor scheitert (unabhängig von Meta-Daten)
  schritte.push(await schrittVorrat(sb, now))
  return { lauf_datum: heute, schritte, ...(grund ? { grund } : {}) }
}

// ── Woche ───────────────────────────────────────────────────────────────────

async function emqLesen(): Promise<Record<string, unknown>> {
  const { pixelId } = metaEnv()
  try {
    const j = await graphGet<{ web?: Array<Record<string, unknown>> }>('dataset_quality', {
      dataset_id: pixelId, fields: 'web{event_name,event_match_quality,data_freshness}',
    })
    const events = (j.web ?? []).map(e => {
      const emq = (e.event_match_quality && typeof e.event_match_quality === 'object') ? e.event_match_quality as Record<string, unknown> : {}
      const fr = (e.data_freshness && typeof e.data_freshness === 'object') ? e.data_freshness as Record<string, unknown> : {}
      return { event_name: toStr(e.event_name), emq: toNum(emq.composite_score), frische: toStr(fr.upload_frequency) }
    })
    const niedrig = events.filter(e => e.emq != null && (e.emq as number) < 6).map(e => e.event_name)
    return { ok: true, dataset_id: pixelId, events, emq_unter_6: niedrig }
  } catch (err) {
    const e = err instanceof MetaApiError ? `${err.kind}: ${(err.userMsg ?? err.message).slice(0, 200)}` : errMsg(err).slice(0, 200)
    return { ok: false, dataset_id: pixelId, fehler: e }
  }
}

async function woche(sb: Sb, now: Date): Promise<Record<string, unknown>> {
  const { heute } = berlinHeute(now)
  const kal = await mitLedger(sb, heute, 'kalibrieren', now, async () => {
    const { data, error } = await sb.rpc('werbe_ev_kalibrieren', {})
    if (error) return { status: 'fehler' as const, summary: {}, fehler: `werbe_ev_kalibrieren: ${dbFehler(error)}` }
    const r = (data ?? {}) as Record<string, unknown>
    if (r.uebersprungen === true) return { status: 'fehler' as const, summary: r, fehler: String(r.grund ?? 'uebersprungen') }
    return { status: 'fertig' as const, summary: r }
  })
  const wo = await mitLedger(sb, heute, 'woche', now, async lauf => {
    const summary: Record<string, unknown> = {}
    summary.emq = await emqLesen()
    const { data: st } = await sb.from('ad_settings').select('target_cpte_eur').eq('id', 'default').maybeSingle()
    const ziel = toNum((st as { target_cpte_eur?: unknown } | null)?.target_cpte_eur) ?? 145
    const { regeln } = await ladeRegeln(sb)
    const bestand = await vorratBestand(sb, regeln, lauf.id)
    summary.vorrat = bestand
    if (bestand.niedrig) summary.hinweis_vorrat = `Nur ${bestand.freigegeben} freigegebene Werbemittel im Vorrat (Ziel ${bestand.min_pool_ready}).`
    try {
      summary.briefs = await briefsErstellen(sb, { heute, zielCpte: ziel, regeln, bestand })
    } catch (err) {
      summary.briefs = { fehler: errMsg(err).slice(0, 300) }
    }
    try {
      summary.prognosen = await prognosenAuffrischen(sb)
    } catch (err) {
      summary.prognosen = { fehler: errMsg(err).slice(0, 300) }
    }
    return { status: 'fertig' as const, summary }
  })
  return { lauf_datum: heute, schritte: [kal, wo] }
}

// ── Server ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  if (req.method !== 'POST') return fehler(405, 'Nur POST')

  const denied = await gateCaller(req, FN, { cron: true, service: true, roles: ['admin'] }, CORS)
  if (denied) return denied

  let body: Record<string, unknown> = {}
  try {
    const t = await req.text()
    body = t ? JSON.parse(t) as Record<string, unknown> : {}
  } catch {
    return fehler(400, 'Ungültiges JSON')
  }
  const aktion = String(body.aktion ?? body.action ?? body.mode ?? '') as Aktion
  if (!(AKTIONEN as readonly string[]).includes(aktion)) {
    return fehler(400, `Unbekannte Aktion. Erlaubt: ${AKTIONEN.join(', ')}`)
  }

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) return fehler(500, 'Supabase-Umgebung fehlt')
  const sb: Sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const now = new Date()
  const synchron = body.synchron === true

  try {
    if (aktion === 'nacht' || aktion === 'nachholen' || aktion === 'woche') {
      const arbeit = (async () => {
        try {
          const r = aktion === 'woche'
            ? await woche(sb, now)
            : await kette(sb, now, { pruefeSync: aktion === 'nachholen', erzwingen: body.erzwingen === true })
          console.log(`[${FN}] ${aktion}:`, JSON.stringify(r).slice(0, 1500))
          return r
        } catch (err) {
          console.error(`[${FN}] ${aktion} abgebrochen:`, errMsg(err))
          return { fehler: errMsg(err) }
        }
      })()
      if (synchron) return json({ success: true, aktion, ergebnis: await arbeit })
      const hintergrund = await imHintergrund(arbeit)
      return json({ success: true, aktion, gestartet: true, hintergrund, hinweis: 'Ergebnis in ad_autopilot_runs' }, 202)
    }
    if (aktion === 'vorrat_pruefen') {
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String).filter(x => /^[0-9a-f-]{36}$/i.test(x)) : undefined
      return json({ success: true, aktion, ...(await vorratPruefen(sb, { ids, now })) })
    }
    if (aktion === 'zuordnung_nachtragen') {
      const r = await zuordnungNachtragen(sb, body, now)
      return json({ aktion, ...r }, r.success === false ? 409 : 200)
    }
    const r = await replay(sb, body, now)
    return json({ aktion, ...r }, r.success === false ? 400 : 200)
  } catch (err) {
    console.error(`[${FN}] ${aktion}:`, errMsg(err))
    return fehler(500, errMsg(err).slice(0, 500), { aktion })
  }
})

