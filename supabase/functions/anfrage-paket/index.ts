// Supabase Edge Function: anfrage-paket
// Sven 13.10.26 (Maximilian Kracke, Wohnung 103): „Wenn so eine Message kommt, soll
// das gleich fertig sein, dass ich es nur noch kontrollieren und verschicken muss."
//
// Fragt ein Kunde Infos zu einer bestimmten Wohnung an, bereitet das System alles
// vor und legt es als ENTWURF in den Postausgang. Verschickt wird NICHTS - Sven
// prüft und sendet per Mail oder WhatsApp.
//   1. ein eigenes, vollständiges Deck zur Wohnung (alle freigegebenen Bilder,
//      Grundriss, Baubeschreibung, Ausstattung, Lage, Zahlungsplan), ohne Projekt-
//      und Bauträgernamen (Kunde vor dem Erstgespräch)
//   2. zwei Rechnungen (finanziert / ohne Kredit) mit den Markt-Annahmen aus Svens
//      eigenen Rechnungen zu dieser Wohnung bzw. gleich großen im Projekt
//   3. Datenblatt- und Zahlungsplan-PDF, Guide, saubere Baustellenfotos
//   4. Mailtext + WhatsApp-Text im Postausgang, Aufgabe an Sven
//
// Auslöser:
//   quelle 'formular'  track-engagement nach „Mehr Infos" auf einer Wohnungsseite (token)
//   quelle 'whatsapp'  waInbound bei eingehender WhatsApp eines Leads (text)
//   quelle 'mail'      imap-poll bei eingehender Kundenmail (text)
//   quelle 'manuell'   Aufruf mit unit_id (Skript / später Knopf im CRM)
// Bei text erkennt die KI, ob es eine Anfrage zu einer bestimmten Wohnung ist und
// zu welcher. Nur bei eindeutigem Treffer entsteht ein Paket.
//
// Ablauf: start legt Zeile in anfrage_pakete an und startet generate-deck im
// Hintergrund. abschluss (im selben Lauf per waitUntil, sonst Cron hp-anfrage-paket
// alle 2 Min) baut Rechnungen, PDFs und Postausgang-Entwurf, sobald das Deck steht.
//
// Schalter crm_settings.anfrage_paket_mode: on | off (fehlende Zeile = off).
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { bookingUrl, PORTAL_URL } from '../_shared/bookingLink.ts'
import { resolveLang } from '../_shared/recipientLang.ts'
import { CI } from '../_shared/brand.ts'
import { callAnthropic, textOf } from '../_shared/anthropic.ts'
import { cyDate } from '../_shared/notifyToday.ts'
import { baueDatenblatt, zahlungsUebersicht, type DeckBlockLite } from '../info-paket/datenblatt.ts'
import {
  GUIDE_URL, LOGO, PHOTO_SQ, SERIF, SANS, CALC_STANDARD, type CalcStandard, type Markt, marktAnnahmen, calcParams,
  esc, kundenFotos, karte, rechnungKarte, zahlungKarte, ratenplan, ratenplanKarte,
} from '../info-paket/bausteine.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const SB_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type EdgeRt = { waitUntil: (p: Promise<unknown>) => void }
const edgeRt = (globalThis as { EdgeRuntime?: EdgeRt }).EdgeRuntime

type Quelle = 'formular' | 'whatsapp' | 'mail' | 'manuell'
interface Person {
  kind: 'lead' | 'sub' | 'frei'; id: string | null; first: string; name: string
  email: string | null; phone: string | null; lang: 'de' | 'en'; bookingToken: string | null
}
interface UnitRow {
  id: string; project_id: string; unit_number: string; status: string | null; property_id: string | null; parent_unit_id: string | null
  bedrooms: number | null; size_sqm: number | null; terrace_sqm: number | null; floor: number | null
  price_net: number | null; price_net_furnished: number | null
}
interface ProjektRow {
  id: string; name: string; developer: string | null; location: string | null; latitude: number | null; longitude: number | null
  furniture_included: boolean | null; completion_date: string | null; payment_schedule?: unknown
  deck_assets: {
    completion_label?: string
    facts?: string; renders?: string[]; gallery?: Array<{ url: string; category: string; label: string }>
    floorplans?: Array<{ floor: number; label: string; url: string }> | Record<string, string>
    map?: string; mapUrl?: string; mapMarker?: { x: number; y: number }
  } | null
}
type CtxUnit = { unitId?: string; unitNumber?: string; netProperty?: number; netFurniture?: number; bedrooms?: number | null }
type DeckCtx = { units?: CtxUnit[]; furnitureMode?: string; vatMode?: string; completion?: string | null }
type Block = DeckBlockLite & { mapLabel?: string }

// ── Grundlagen ──────────────────────────────────────────────────────────────
async function modus(sb: SupabaseClient): Promise<'on' | 'off'> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', 'anfrage_paket_mode').maybeSingle()
  return String((data as { value?: string } | null)?.value ?? 'off').trim() === 'on' ? 'on' : 'off'
}

async function person(sb: SupabaseClient, b: Record<string, unknown>): Promise<Person | null> {
  const leadId = typeof b.lead_id === 'string' ? b.lead_id : null
  const subId = typeof b.subscriber_id === 'string' ? b.subscriber_id : null
  if (leadId) {
    const { data } = await sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp, language, booking_token').eq('id', leadId).maybeSingle()
    const l = data as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null; language: string | null; booking_token: string | null } | null
    if (!l) return null
    return { kind: 'lead', id: l.id, first: (l.first_name ?? '').trim(), name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(),
      email: l.email, phone: l.whatsapp || l.phone, lang: l.language === 'en' ? 'en' : 'de', bookingToken: l.booking_token }
  }
  if (subId) {
    const { data } = await sb.from('newsletter_subscribers').select('id, first_name, last_name, email, phone').eq('id', subId).maybeSingle()
    const s = data as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null } | null
    if (!s) return null
    return { kind: 'sub', id: s.id, first: (s.first_name ?? '').trim(), name: `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(),
      email: s.email, phone: s.phone, lang: 'de', bookingToken: null }
  }
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!email) return null
  return { kind: 'frei', id: null, first: name.split(' ')[0] ?? '', name, email, phone: typeof b.phone === 'string' ? b.phone : null, lang: 'de', bookingToken: null }
}

const UNIT_COLS = 'id, project_id, unit_number, status, property_id, parent_unit_id, bedrooms, size_sqm, terrace_sqm, floor, price_net, price_net_furnished'

/** Anbietbar = nicht verkauft/reserviert, keinem Eigentümer zugewiesen, kein Teil eines
 *  Doppelapartments, kein aktiver Deal eines ANDEREN Kunden. */
async function anbietbar(sb: SupabaseClient, u: UnitRow, leadId: string | null): Promise<string | null> {
  if (u.property_id || ['sold', 'reserved'].includes(String(u.status ?? ''))) return 'wohnung_vergeben'
  if (u.parent_unit_id) return 'teil_einheit'
  const { data: deals } = await sb.from('deals').select('id, lead_id').eq('unit_id', u.id).is('archived_from_phase', null).neq('phase', 'deal_verloren').limit(5)
  const fremd = ((deals ?? []) as { lead_id: string | null }[]).filter(d => !leadId || d.lead_id !== leadId)
  return fremd.length ? 'wohnung_vergeben' : null
}

// Lage + Objekttyp statt Projektname (Sven 30.9.26). Bevorzugt das Label, das ein
// früheres Deck derselben Wohnung schon ohne Namen trägt (Newsletter-Decks).
function lageAusDeck(blocks: Block[], namen: string[]): string | null {
  const roh = blocks.find(x => x.type === 'facts' && x.mapLabel)?.mapLabel
    ?? blocks.find(x => x.type === 'cover' && x.kicker)?.kicker?.replace(/\s*·\s*/g, ' ')
  const l = String(roh ?? '').trim()
  if (!l || l.length > 60) return null
  if (namen.some(n => n.length >= 3 && l.toLowerCase().includes(n.toLowerCase()))) return null
  return l
}
function lageAusProjekt(p: ProjektRow): string {
  const ort = String(p.location ?? '').split(',').map(x => x.trim()).filter(Boolean)
  const stadt = ort.find(x => /paphos|pafos|geroskipou|chlorak|peyia|kissonerga|tsada|limassol|larnaca|emba|konia|tala|polis/i.test(x))
  const name = (stadt ?? 'Paphos').replace(/^\d{4,5}\s+/, '').replace(/,?\s*Zypern$/i, '').trim()
  return `Neubau in ${name}`
}

// ── Anfrage in WhatsApp/Mail erkennen ───────────────────────────────────────
interface Kandidat { unit: UnitRow; projekt: string; lage: string; herkunft: string[] }
const UNIT_TOKEN = /\b([a-z]{0,2}-?\d{1,3}[a-z]?)\b/gi
const unitKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

async function kandidaten(sb: SupabaseClient, leadId: string | null, text: string): Promise<Kandidat[]> {
  const map = new Map<string, Kandidat>()
  const { data: projs } = await sb.from('crm_projects').select('id, name, location')
  const projekte = (projs ?? []) as Array<{ id: string; name: string; location: string | null }>
  const pName = (id: string) => projekte.find(p => p.id === id)?.name ?? ''
  const pLage = (id: string) => String(projekte.find(p => p.id === id)?.location ?? '').split(',').slice(-2).join(',').trim()
  const add = (u: UnitRow, herkunft: string) => {
    const k = map.get(u.id)
    if (k) { if (!k.herkunft.includes(herkunft)) k.herkunft.push(herkunft); return }
    map.set(u.id, { unit: u, projekt: pName(u.project_id), lage: pLage(u.project_id), herkunft: [herkunft] })
  }
  const holeUnits = async (ids: string[], herkunft: string) => {
    if (!ids.length) return
    const { data } = await sb.from('crm_project_units').select(UNIT_COLS).in('id', [...new Set(ids)].slice(0, 40))
    for (const u of (data ?? []) as UnitRow[]) add(u, herkunft)
  }
  // a) Wohnungen aus Decks, die der Kunde bekommen oder angesehen hat
  if (leadId) {
    const seit = new Date(Date.now() - 180 * 864e5).toISOString()
    const { data: eigene } = await sb.from('sales_decks').select('token, deck_context, created_at')
      .eq('lead_id', leadId).gte('created_at', seit).order('created_at', { ascending: false }).limit(10)
    const { data: ev } = await sb.from('engagement_events').select('token, type')
      .eq('lead_id', leadId).in('type', ['deck_view', 'newsletter_click', 'info_request']).gte('occurred_at', seit)
      .order('occurred_at', { ascending: false }).limit(30)
    const tokens = [...new Set(((ev ?? []) as { token: string | null }[]).map(e => e.token).filter(Boolean) as string[])]
    const { data: gesehen } = tokens.length
      ? await sb.from('sales_decks').select('token, deck_context').in('token', tokens.slice(0, 20))
      : { data: [] }
    const ids = (rows: unknown) => ((rows ?? []) as { deck_context: DeckCtx | null }[])
      .flatMap(r => (r.deck_context?.units ?? []).map(u => u.unitId).filter(Boolean) as string[])
    await holeUnits(ids(eigene), 'bekam ein Deck dazu')
    await holeUnits(ids(gesehen), 'hat sich die Wohnung angesehen')
  }
  // b) Projektname im Text
  const lower = text.toLowerCase()
  const genannt = projekte.filter(p => p.name.length >= 4 && new RegExp(`(^|[^\\p{L}])${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(lower))
  if (genannt.length) {
    const { data } = await sb.from('crm_project_units').select(UNIT_COLS).in('project_id', genannt.map(p => p.id)).limit(60)
    for (const u of (data ?? []) as UnitRow[]) add(u, 'Projektname in der Nachricht')
  }
  // c) Wohnungsnummer im Text (nur Nummern mit Ziffer, die es als Wohnung gibt)
  const nummern = [...new Set([...text.matchAll(UNIT_TOKEN)].map(m => unitKey(m[1])).filter(k => /\d/.test(k) && k.length >= 2))]
  if (nummern.length) {
    const { data } = await sb.from('crm_project_units').select(UNIT_COLS).in('unit_key', nummern.slice(0, 10)).limit(60)
    for (const u of (data ?? []) as UnitRow[]) add(u, 'Wohnungsnummer in der Nachricht')
  }
  const kontext = (k: Kandidat) => k.herkunft.some(h => h.startsWith('bekam') || h.startsWith('hat sich')) ? 0 : 1
  return [...map.values()].sort((x, y) => kontext(x) - kontext(y)).slice(0, 60)
}

interface Erkennung { anfrage: boolean; kandidat: number | null; sicher: boolean; grund: string; modell?: string }
async function erkennen(sb: SupabaseClient, leadId: string | null, text: string, ks: Kandidat[]): Promise<Erkennung> {
  let verlauf = ''
  if (leadId) {
    const { data } = await sb.from('activities').select('direction, type, content, created_at')
      .eq('lead_id', leadId).in('type', ['whatsapp', 'email']).order('created_at', { ascending: false }).limit(7)
    verlauf = ((data ?? []) as Array<{ direction: string; type: string; content: string | null; created_at: string }>).reverse()
      .map(a => `[${a.created_at.slice(0, 16).replace('T', ' ')} ${a.direction === 'inbound' ? 'Kunde' : 'Sven/System'} per ${a.type}] ${String(a.content ?? '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
  }
  const liste = ks.map((k, i) => `${i + 1}. Projekt ${k.projekt} (${k.lage}) · Wohnung ${k.unit.unit_number} · ${k.unit.bedrooms ?? '?'} SZ · ${k.unit.size_sqm ?? '?'} m² · ${k.unit.price_net ? `${Math.round(Number(k.unit.price_net)).toLocaleString('de-DE')} € netto` : 'ohne Preis'} · ${k.herkunft.join(', ')}`).join('\n')
  const prompt = `Du sortierst eingehende Kundennachrichten für einen Immobilienmakler (Sven, Neubauwohnungen auf Zypern).
Frage: Bittet der Kunde in seiner NEUESTEN Nachricht um Informationen, Unterlagen, Details, Preise, Grundriss, eine Berechnung oder ein Exposé zu EINER bestimmten Wohnung? Auch „Ist die 103 noch frei?" oder „Schick mir bitte mehr zur Wohnung im Zentrum" zählen. Keine Anfrage sind: Terminabsprachen, Danke, Smalltalk, allgemeine Fragen ohne bestimmte Wohnung, Absagen, Abmeldungen, Fragen zu einer Wohnung, die er schon gekauft hat.
Welche Wohnung aus der Kandidatenliste meint er? Nutze den Verlauf: „die Wohnung" meint meist die zuletzt gezeigte.
Eindeutig ist es auch, wenn die genannte Nummer oder Beschreibung zu genau EINER Wohnung passt, die der Kunde schon gesehen oder als Deck bekommen hat - gleiche Nummern in Projekten, die er nie gesehen hat, spielen dann keine Rolle.
sicher=true nur, wenn genau ein Kandidat eindeutig passt.

NEUESTE NACHRICHT DES KUNDEN:
${text.slice(0, 1500)}

VERLAUF (älteste zuerst):
${verlauf || '(keiner)'}

KANDIDATEN:
${liste || '(keine)'}

Antworte nur mit JSON: {"anfrage": true|false, "kandidat": <Nummer oder null>, "sicher": true|false, "grund": "max. 15 Wörter"}`
  const res = await callAnthropic(ANTHROPIC_API_KEY, {
    model: 'claude-opus-5-5', fallbackModels: ['claude-sonnet-4-6'], max_tokens: 2000, label: 'anfrage-erkennen',
    messages: [{ role: 'user', content: prompt }],
  })
  if (!res.ok) return { anfrage: false, kandidat: null, sicher: false, grund: `KI nicht erreichbar: ${res.error ?? ''}`.slice(0, 120) }
  const m = textOf(res).match(/\{[\s\S]*\}/)
  try {
    const j = JSON.parse(m?.[0] ?? '{}') as { anfrage?: boolean; kandidat?: number | null; sicher?: boolean; grund?: string }
    const k = Number(j.kandidat)
    return { anfrage: j.anfrage === true, kandidat: Number.isInteger(k) && k >= 1 && k <= ks.length ? k : null,
      sicher: j.sicher === true, grund: String(j.grund ?? '').slice(0, 160) }
  } catch { return { anfrage: false, kandidat: null, sicher: false, grund: 'Antwort nicht lesbar' } }
}

// ── start ───────────────────────────────────────────────────────────────────
async function start(sb: SupabaseClient, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (await modus(sb) !== 'on') return { ok: true, started: false, reason: 'automatik_aus' }
  const quelle: Quelle = (['formular', 'whatsapp', 'mail', 'manuell'] as const).includes(b.quelle as Quelle) ? b.quelle as Quelle : 'manuell'
  const p = await person(sb, b)
  if (!p) return { ok: true, started: false, reason: 'kein_empfaenger' }
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 3000) : ''
  const frage = typeof b.frage === 'string' ? b.frage.trim().slice(0, 1000) : ''
  const wuensche = (Array.isArray(b.wuensche) ? b.wuensche : []).map(String).slice(0, 6)
  const taskId = typeof b.task_id === 'string' ? b.task_id : null
  const leadId = p.kind === 'lead' ? p.id : null

  // Protokollzeile für alles, was nicht zum Paket wird (nachvollziehbar, kein Rauschen).
  const notiere = async (status: 'uebersprungen' | 'fehler', grund: string, extra: Record<string, unknown> = {}) => {
    await sb.from('anfrage_pakete').insert({
      quelle, lead_id: leadId, subscriber_id: p.kind === 'sub' ? p.id : null, empfaenger_email: p.email, empfaenger_name: p.name,
      nachricht: (text || frage).slice(0, 3000) || null, status, grund, task_id: taskId, ...extra,
    })
    return { ok: true, started: false, reason: grund, ...extra }
  }

  if (leadId) {
    const { data: opt } = await sb.from('communication_optouts').select('id').eq('lead_id', leadId).limit(1)
    if (opt && opt.length) return await notiere('uebersprungen', 'kontaktsperre')
  }

  // 1) Wohnung bestimmen
  let unit: UnitRow | null = null
  let quellToken: string | null = null
  let quellDeck: { blocks: Block[]; ctx: DeckCtx } | null = null
  let erkennung: (Erkennung & { kandidaten?: string[] }) | null = null
  if (typeof b.token === 'string' && b.token) {
    quellToken = b.token
    const { data: d } = await sb.from('sales_decks').select('content, deck_context').eq('token', b.token).maybeSingle()
    const dd = d as { content: { blocks?: Block[] } | null; deck_context: DeckCtx | null } | null
    if (!dd) return await notiere('uebersprungen', 'deck_fehlt', { quell_token: quellToken })
    quellDeck = { blocks: dd.content?.blocks ?? [], ctx: dd.deck_context ?? {} }
    const us = (quellDeck.ctx.units ?? []).filter(u => u.unitId)
    if (us.length !== 1) return await notiere('uebersprungen', 'mehrere_wohnungen', { quell_token: quellToken })
    const { data: u } = await sb.from('crm_project_units').select(UNIT_COLS).eq('id', us[0].unitId!).maybeSingle()
    unit = u as UnitRow | null
  } else if (typeof b.unit_id === 'string' && b.unit_id) {
    const { data: u } = await sb.from('crm_project_units').select(UNIT_COLS).eq('id', b.unit_id).maybeSingle()
    unit = u as UnitRow | null
  } else if (text) {
    const ks = await kandidaten(sb, leadId, text)
    if (!ks.length) return { ok: true, started: false, reason: 'keine_kandidaten' }
    const e = await erkennen(sb, leadId, text, ks)
    erkennung = { ...e, kandidaten: ks.map(k => `${k.projekt} ${k.unit.unit_number}`) }
    if (!e.anfrage) return { ok: true, started: false, reason: 'keine_anfrage', grund: e.grund }
    if (!e.sicher || !e.kandidat) return await notiere('uebersprungen', 'wohnung_unklar', { erkennung })
    unit = ks[e.kandidat - 1].unit
  }
  if (!unit) return await notiere('uebersprungen', 'wohnung_fehlt', { quell_token: quellToken, erkennung })
  const vergeben = await anbietbar(sb, unit, leadId)
  if (vergeben) return await notiere('uebersprungen', vergeben, { unit_id: unit.id, project_id: unit.project_id, quell_token: quellToken, erkennung })

  // 2) Doppel-Schutz: dieselbe Person, dieselbe Wohnung, 14 Tage
  {
    const seit = new Date(Date.now() - 14 * 864e5).toISOString()
    let q = sb.from('anfrage_pakete').select('id, status, outbox_id').eq('unit_id', unit.id).in('status', ['deck', 'fertig']).gte('created_at', seit).limit(1)
    q = p.kind === 'lead' ? q.eq('lead_id', p.id) : p.kind === 'sub' ? q.eq('subscriber_id', p.id) : q.eq('empfaenger_email', p.email ?? '')
    const { data: schon } = await q
    if (schon && schon.length) return { ok: true, started: false, reason: 'schon_vorbereitet', id: (schon[0] as { id: string }).id }
  }

  // 3) Projekt + Fakten
  const { data: pr } = await sb.from('crm_projects')
    .select('id, name, developer, location, latitude, longitude, furniture_included, completion_date, payment_schedule, deck_assets').eq('id', unit.project_id).maybeSingle()
  const projekt = pr as ProjektRow | null
  if (!projekt) return await notiere('uebersprungen', 'projekt_fehlt', { unit_id: unit.id })
  const a = projekt.deck_assets ?? {}
  if (!a.facts?.trim()) return await notiere('uebersprungen', 'keine_fakten', { unit_id: unit.id, project_id: projekt.id })

  // Früheres Deck dieser Wohnung (Quelle oder jüngstes): Möbel-Modus und Lage-Label
  // übernehmen, damit der Kunde denselben Preis sieht wie zuvor.
  if (!quellDeck) {
    const { data: fr } = await sb.from('sales_decks').select('content, deck_context')
      .filter('deck_context->units', 'cs', JSON.stringify([{ unitId: unit.id }]))
      .order('created_at', { ascending: false }).limit(1)
    const f = ((fr ?? []) as Array<{ content: { blocks?: Block[] } | null; deck_context: DeckCtx | null }>)[0]
    if (f) quellDeck = { blocks: f.content?.blocks ?? [], ctx: f.deck_context ?? {} }
  }
  const namen = [projekt.name, projekt.developer ?? '', String(projekt.developer ?? '').split(/\s+/)[0] ?? ''].filter(x => x.length >= 3)
  const lage = (quellDeck && lageAusDeck(quellDeck.blocks, namen)) || lageAusProjekt(projekt)
  const quellMode = String(quellDeck?.ctx.furnitureMode ?? '')
  const furnitureMode: 'none' | 'included' | 'optional' | undefined =
    quellMode === 'none' || quellMode === 'included' || quellMode === 'optional' ? quellMode : undefined
  const quellUnit = (quellDeck?.ctx.units ?? []).find(u => u.unitId === unit!.id)
  const furnitureNet = furnitureMode === 'optional' && quellUnit?.netFurniture != null ? Number(quellUnit.netFurniture) : null

  // 4) Zeile anlegen, dann Deck starten
  const { data: row, error: rErr } = await sb.from('anfrage_pakete').insert({
    quelle, lead_id: leadId, subscriber_id: p.kind === 'sub' ? p.id : null, empfaenger_email: p.email, empfaenger_name: p.name,
    project_id: projekt.id, unit_id: unit.id, quell_token: quellToken, nachricht: (text || frage).slice(0, 3000) || null,
    status: 'deck', erkennung, task_id: taskId,
  }).select('id').single()
  if (rErr || !row) return { ok: false, started: false, reason: 'db_fehler', error: rErr?.message }
  const id = (row as { id: string }).id

  const fpList = Array.isArray(a.floorplans) ? a.floorplans : []
  const fpEtage = fpList.find(f => f.floor === unit!.floor && !/\.pdf($|\?)/i.test(f.url))?.url
  const images = {
    renders: a.renders ?? [], gallery: a.gallery ?? [], floorplan: fpEtage, floorplans: fpEtage ? [fpEtage] : [],
    map: a.map ?? undefined, mapUrl: a.mapUrl ?? undefined, mapMarker: a.mapMarker ?? undefined,
    mapLat: projekt.latitude ?? undefined, mapLng: projekt.longitude ?? undefined,
  }
  const unitFacts = `\n\n=== WOHNUNG: ${unit.unit_number} ===\n${unit.bedrooms ?? '?'} Schlafzimmer · ${unit.size_sqm ?? '?'} m² Innenfläche${unit.terrace_sqm ? ` + ${unit.terrace_sqm} m² Außenfläche` : ''}${unit.floor != null ? ` · ${unit.floor}. Etage` : ''}.`
  const herkunftTxt = quelle === 'formular' ? 'über das Formular „Mehr Infos" auf der Wohnungsseite'
    : quelle === 'whatsapp' ? 'per WhatsApp' : quelle === 'mail' ? 'per E-Mail' : 'bei Sven'
  const briefing = [
    `${p.first || 'Der Kunde'} hat ${herkunftTxt} Informationen zu Wohnung ${unit.unit_number} angefordert. Es gab noch KEIN Gespräch.`,
    wuensche.length ? `Gewünscht: ${wuensche.join(', ')}.` : '',
    frage ? `Seine Frage: ${frage}` : '',
    text ? `Seine Nachricht: ${text.slice(0, 600)}` : '',
    'Das Deck ist sein vollständiges Informationspaket. Anschreiben kurz und freundlich: danke für das Interesse, hier ist alles zur Wohnung.',
    'Seine persönliche Kosten- und Mietrechnung (mit Finanzierung und ohne Kredit) bekommt er zusammen mit diesem Deck per Mail. Schreibe nie, sie fehle oder komme später. Erlaubt: genauer wird sie mit seinem Eigenkapital, das rechnet Sven gern im Gespräch durch.',
  ].filter(Boolean).join('\n')
  const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
  const adminId = (admin as { id: string } | null)?.id ?? null
  const genBody = {
    background: true, recipient_name: p.name || p.first || 'den Kunden', angle: 'investment', briefing,
    facts: a.facts + unitFacts, images, lead_id: leadId, project_id: projekt.id, unit_id: unit.id,
    units: [{ unit_number: unit.unit_number, ...(furnitureNet != null ? { furniture_net: furnitureNet } : {}) }],
    ...(furnitureMode ? { furniture_mode: furnitureMode } : {}),
    lang: p.lang, created_by: adminId,
    month_label: new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
    vollstaendig: true, ohne_namen: true, lage_label: lage,
  }
  let jobId: string | null = null
  let genFehler = ''
  try {
    const r = await fetch(`${SB_URL}/functions/v1/generate-deck`, {
      method: 'POST', headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, 'Content-Type': 'application/json' },
      body: JSON.stringify(genBody),
    })
    const j = await r.json().catch(() => ({})) as { job_id?: string; error?: string }
    jobId = j.job_id ?? null
    if (!jobId) genFehler = `generate-deck ${r.status}: ${j.error ?? 'kein Job'}`
  } catch (e) { genFehler = e instanceof Error ? e.message : String(e) }
  if (!jobId) {
    await sb.from('anfrage_pakete').update({ status: 'fehler', grund: genFehler.slice(0, 300) }).eq('id', id)
    await svenAufgabe(sb, { id, p, unitNr: unit.unit_number, projektName: projekt.name, quelle, text, frage, taskId, fehler: genFehler })
    return { ok: false, started: false, reason: 'deck_start_fehler', error: genFehler }
  }
  // Das Postausgang-Netz in process-scheduled-messages soll für dieses Deck KEINEN
  // eigenen Entwurf bauen - den baut abschluss() mit Rechnungen und PDFs.
  await sb.from('deck_generation_jobs').update({ outbox_at: new Date().toISOString() }).eq('id', jobId)
  await sb.from('anfrage_pakete').update({ job_id: jobId }).eq('id', id)

  // Im selben Lauf auf das Deck warten (meist 2-4 Min). Reicht die Zeit nicht,
  // übernimmt der Cron.
  // Nur solange genug Laufzeit für Rechnungen, Fotos und PDFs bleibt (Edge-Limit
  // ca. 400 s, 13.10.26: ein Abschluss nach 270 s wurde abgeschnitten).
  const t0 = Date.now()
  const warten = (async () => {
    while (Date.now() - t0 < 200_000) {
      await sleep(10_000)
      const r = await abschliessen(sb, id).catch(e => ({ fertig: false, fehler: String(e) }))
      if (r.fertig) return
    }
  })()
  if (edgeRt) edgeRt.waitUntil(warten)
  return { ok: true, started: true, id, job_id: jobId, unit: unit.unit_number, lage }
}

// ── abschluss ───────────────────────────────────────────────────────────────
interface PaketRow {
  id: string; quelle: Quelle; lead_id: string | null; subscriber_id: string | null; empfaenger_email: string | null; empfaenger_name: string | null
  project_id: string; unit_id: string; nachricht: string | null; status: string; job_id: string | null; task_id: string | null
  versuche: number; abschluss_at: string | null; created_at: string
}

async function abschliessen(sb: SupabaseClient, id: string): Promise<{ fertig: boolean; status?: string; fehler?: string }> {
  const { data: r0 } = await sb.from('anfrage_pakete').select('*').eq('id', id).maybeSingle()
  const row = r0 as PaketRow | null
  if (!row) return { fertig: true, status: 'fehlt' }
  if (row.status !== 'deck') return { fertig: true, status: row.status }
  if (!row.job_id) return { fertig: false }
  const { data: j } = await sb.from('deck_generation_jobs').select('status, deck_token, error').eq('id', row.job_id).maybeSingle()
  const job = j as { status: string; deck_token: string | null; error: string | null } | null
  const p = await person(sb, { lead_id: row.lead_id, subscriber_id: row.subscriber_id, email: row.empfaenger_email, name: row.empfaenger_name })
  const { data: u } = await sb.from('crm_project_units').select(UNIT_COLS).eq('id', row.unit_id).maybeSingle()
  const unit = u as UnitRow | null
  const { data: pr } = await sb.from('crm_projects').select('id, name, developer, location, latitude, longitude, furniture_included, completion_date, payment_schedule, deck_assets').eq('id', row.project_id).maybeSingle()
  const projekt = pr as ProjektRow | null
  if (!job || job.status === 'failed' || !p || !unit || !projekt) {
    const grund = !job ? 'Deck-Job fehlt' : job.status === 'failed' ? `Deck fehlgeschlagen: ${job.error ?? ''}` : 'Daten fehlen'
    const { data: c } = await sb.from('anfrage_pakete').update({ status: 'fehler', grund: grund.slice(0, 300) }).eq('id', id).eq('status', 'deck').select('id')
    if (c?.length && p && unit && projekt) await svenAufgabe(sb, { id, p, unitNr: unit.unit_number, projektName: projekt.name, quelle: row.quelle, text: row.nachricht ?? '', frage: '', taskId: row.task_id, fehler: grund })
    return { fertig: true, status: 'fehler', fehler: grund }
  }
  if (!['ready', 'review_required'].includes(job.status) || !job.deck_token) return { fertig: false }

  // Claim: genau ein Lauf baut den Entwurf (waitUntil und Cron können sich treffen).
  const { data: claim } = await sb.from('anfrage_pakete').update({ abschluss_at: new Date().toISOString(), versuche: (row.versuche ?? 0) + 1 })
    .eq('id', id).eq('status', 'deck').is('abschluss_at', null).select('id')
  if (!claim?.length) return { fertig: false }
  try {
    const out = await baueEntwurf(sb, row, p, unit, projekt, job.deck_token)
    await sb.from('anfrage_pakete').update({
      status: 'fertig', deck_token: job.deck_token, calc_tokens: out.calcTokens, outbox_id: out.outboxId, fertig_at: new Date().toISOString(),
      grund: out.hinweis,
    }).eq('id', id)
    await svenAufgabe(sb, { id, p, unitNr: unit.unit_number, projektName: projekt.name, quelle: row.quelle, text: row.nachricht ?? '', frage: '',
      taskId: row.task_id, fertig: { deckUrl: `${PORTAL_URL}/deck/${job.deck_token}?preview=1`, ampel: out.ampel, befunde: out.befunde, calcUrls: out.calcUrls } })
    return { fertig: true, status: 'fertig' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[anfrage-paket] Entwurf:', msg)
    // Freigeben für den nächsten Versuch; nach 3 Versuchen Fehler an Sven.
    if ((row.versuche ?? 0) + 1 >= 3) {
      await sb.from('anfrage_pakete').update({ status: 'fehler', grund: msg.slice(0, 300) }).eq('id', id)
      await svenAufgabe(sb, { id, p, unitNr: unit.unit_number, projektName: projekt.name, quelle: row.quelle, text: row.nachricht ?? '', frage: '', taskId: row.task_id, fehler: msg })
    } else {
      await sb.from('anfrage_pakete').update({ abschluss_at: null }).eq('id', id)
    }
    return { fertig: false, fehler: msg }
  }
}

// vorhanden: Mail eines fertigen Pakets neu bauen (gleiche Rechnungen, gleicher
// Postausgang-Eintrag), z.B. nach einer Textänderung. Deck bleibt unverändert.
async function baueEntwurf(sb: SupabaseClient, row: PaketRow, p: Person, unit: UnitRow, projekt: ProjektRow, token: string,
  vorhanden?: { calcTokens: string[]; outboxId: string }): Promise<{
  calcTokens: string[]; calcUrls: string[]; outboxId: string; ampel: string; befunde: string[]; hinweis: string | null
}> {
  const { data: d } = await sb.from('sales_decks').select('content, deck_context, quality_status, quality_report').eq('token', token).maybeSingle()
  const deck = d as { content: { blocks?: Block[] } | null; deck_context: DeckCtx | null; quality_status: string | null; quality_report: { findings?: Array<{ severity?: string; what?: string }> } | null } | null
  if (!deck) throw new Error('Deck nicht gefunden')
  const blocks = (deck.content?.blocks ?? []) as Block[]
  const ctx = deck.deck_context ?? {}
  const cu = (ctx.units ?? [])[0] ?? {}
  const namen = [projekt.name, projekt.developer ?? '', String(projekt.developer ?? '').split(/\s+/)[0] ?? ''].filter(x => x.length >= 3)
  const lage = lageAusDeck(blocks, namen) || lageAusProjekt(projekt)
  const nr = (blocks.find(x => x.type === 'unit')?.number ?? unit.unit_number ?? '').trim()
  const objekt = nr ? `Wohnung ${nr}` : 'Wohnung'
  const label = nr ? `${lage} · ${nr}` : lage
  const furnMode = String(ctx.furnitureMode ?? 'optional')
  const netJetzt = Number(cu.netProperty ?? 0)
  if (!netJetzt) throw new Error('Deck ohne Preis')
  const furnCost = furnMode === 'optional' ? Number(cu.netFurniture ?? 0) : 0
  const furnFree = furnMode === 'included'

  // Rechnungen: Svens Annahmen (gleiche Wohnung > gleiche Größe im Projekt > Standard)
  let std: CalcStandard = { ...CALC_STANDARD }
  try {
    const { data: ov } = await sb.from('crm_settings').select('value').eq('key', 'info_paket_calc').maybeSingle()
    const raw = (ov as { value?: string } | null)?.value
    if (raw) {
      const o = JSON.parse(raw) as Partial<CalcStandard>
      for (const k of Object.keys(CALC_STANDARD) as (keyof CalcStandard)[]) if (o[k] !== undefined) (std as Record<string, unknown>)[k] = o[k]
    }
  } catch { /* Standard bleibt */ }
  const markt: Markt = await marktAnnahmen(sb, projekt.name, nr, unit.bedrooms, std)
  const gross = Math.round(netJetzt * 1.19)
  const grossGesamt = Math.round((netJetzt + furnCost) * 1.19)
  const empfName = p.name || p.first || ''
  const calcTokens: string[] = []
  const rechnung = async (fin: 'yes' | 'no', zusatz: string): Promise<string> => {
    const item = {
      label: `${label} · ${zusatz}`, project: lage, unit: nr, bedrooms: unit.bedrooms, size_sqm: unit.size_sqm, terrace_sqm: unit.terrace_sqm, floor: unit.floor,
      price_net: netJetzt, price_gross: gross, params: calcParams(std, markt, fin, netJetzt, furnCost, furnFree, unit.bedrooms),
    }
    const { data: c, error } = await sb.from('property_calculations').insert({
      lead_id: p.kind === 'lead' ? p.id : null, recipient_name: empfName, title: `Rechnung ${label} (${zusatz})`, with_calc: true,
      content: { with_calc: true, recipient_name: empfName, items: [item], source: 'anfrage_paket', annahmen_quelle: markt.quelle, anfrage_id: row.id },
    }).select('token').single()
    if (error || !c) throw new Error(`Rechnung: ${error?.message ?? 'kein Token'}`)
    const tok = (c as { token: string }).token
    calcTokens.push(tok)
    return `${PORTAL_URL}/rechnung/${tok}`
  }
  const calcUrl = vorhanden?.calcTokens[0] ? `${PORTAL_URL}/rechnung/${vorhanden.calcTokens[0]}` : await rechnung('yes', 'finanziert')
  const calcUrlCash = vorhanden?.calcTokens[1] ? `${PORTAL_URL}/rechnung/${vorhanden.calcTokens[1]}` : await rechnung('no', 'ohne Kredit')
  if (vorhanden) calcTokens.push(...vorhanden.calcTokens.slice(0, 2))

  // Baustellenfotos (nur saubere, Svens feste Regel) + Datenblatt/Zahlungsplan-PDF
  const { fotos, fotoStand } = await kundenFotos(sb, projekt.id).catch(() => ({ fotos: [] as string[], fotoStand: '' }))
  const uebergabe = (typeof ctx.completion === 'string' ? ctx.completion : null) ?? projekt.completion_date ?? null
  const hochladen = async (bytes: Uint8Array): Promise<string | null> => {
    const pfad = `datenblatt/${crypto.randomUUID()}.pdf`
    const { error } = await sb.storage.from('deck-assets').upload(pfad, bytes, { contentType: 'application/pdf', upsert: false })
    if (error) { console.warn('[anfrage-paket] PDF-Upload:', error.message); return null }
    return `${PORTAL_URL}/unterlagen/${pfad.split('/').pop()}`
  }
  let pdfUrl: string | null = null
  let zahlplanUrl: string | null = null
  try { pdfUrl = await hochladen(await baueDatenblatt({ blocks, lage, nr, stand: new Date(), uebergabe })) }
  catch (e) { console.error('[anfrage-paket] Datenblatt:', e) }
  const zahlung = zahlungsUebersicht(blocks, uebergabe)
  if (zahlung) {
    try { zahlplanUrl = await hochladen(await baueDatenblatt({ blocks, lage, nr, stand: new Date(), uebergabe, nurZahlungsplan: true })) }
    catch (e) { console.error('[anfrage-paket] Zahlungsplan:', e) }
  }

  // Ratenplan aus dem CRM-Zahlungsplan (jede Rate mit Termin, Sven 13.10.26).
  const plan = ratenplan({ schedule: projekt.payment_schedule, brutto: grossGesamt, netto: netJetzt + furnCost,
    uebergabe: projekt.completion_date, uebergabeLabel: projekt.deck_assets?.completion_label ?? null })
  const lang = await resolveLang(sb, { email: p.email, lead_id: p.kind === 'lead' ? p.id : null })
  const deckUrl = `${PORTAL_URL}/deck/${token}`
  const terminUrl = p.kind === 'lead' ? bookingUrl(p.bookingToken) : `${PORTAL_URL}/termin?f=none&src=infopaket`
  const html = mailHtml({
    first: p.first, objekt, lage, gross: grossGesamt, calcUrl, calcUrlCash, deckUrl, terminUrl, fotos, fotoStand,
    quelle: row.quelle, guide: lang !== 'en', std, markt, pdfUrl, zahlung, zahlplanUrl, plan,
  })
  const subject = `${p.first ? `${p.first}, d` : 'D'}eine Unterlagen zur ${objekt}`
  const waText = [
    `Hallo${p.first ? ` ${p.first}` : ''},`,
    '',
    `danke für dein Interesse an der ${objekt}. Hier ist alles, was du dir in Ruhe ansehen kannst:`,
    '',
    `🏡 Die Wohnung mit allen Bildern, Grundriss und Baubeschreibung: ${deckUrl}`,
    `📊 Deine Rechnung mit Finanzierung: ${calcUrl}`,
    `📊 Deine Rechnung ohne Kredit: ${calcUrlCash}`,
    ...(pdfUrl ? [`📄 Datenblatt als PDF: ${pdfUrl}`] : []),
    `🔑 Was wir nach dem Kauf alles für dich übernehmen: ${NACH_DEM_KAUF_URL}`,
    '',
    `Am einfachsten gehen wir alles in 20 Minuten gemeinsam durch. Hier kannst du dir einen Termin aussuchen: ${terminUrl}`,
    '',
    'Viele Grüße',
    'Sven',
  ].join('\n')
  const { data: ob, error: oErr } = vorhanden
    ? await sb.from('deck_outbox').update({ subject, body: html, wa_text: waText }).eq('id', vorhanden.outboxId).eq('status', 'draft').select('id').single()
    : await sb.from('deck_outbox').insert({
      lead_id: p.kind === 'lead' ? p.id : null, recipient_email: p.email, subject, body: html, deck_tokens: [token], status: 'draft', wa_text: waText,
    }).select('id').single()
  if (oErr || !ob) throw new Error(`Postausgang: ${oErr?.message ?? 'kein Eintrag'}`)

  const hart = (deck.quality_report?.findings ?? []).filter(f => f.severity === 'kritisch' || f.severity === 'hoch').map(f => String(f.what ?? '')).slice(0, 5)
  return {
    calcTokens, calcUrls: [calcUrl, calcUrlCash], outboxId: (ob as { id: string }).id,
    ampel: deck.quality_status ?? 'unbekannt', befunde: hart,
    hinweis: pdfUrl ? null : 'Datenblatt-PDF fehlt',
  }
}

// ── Aufgabe/Notiz für Sven ──────────────────────────────────────────────────
async function svenAufgabe(sb: SupabaseClient, o: {
  id: string; p: Person; unitNr: string; projektName: string; quelle: Quelle; text: string; frage: string; taskId: string | null
  fertig?: { deckUrl: string; ampel: string; befunde: string[]; calcUrls: string[] }; fehler?: string
}): Promise<void> {
  const objekt = `Wohnung ${o.unitNr} (${o.projektName})`
  const wo = o.quelle === 'whatsapp' ? 'per WhatsApp' : o.quelle === 'mail' ? 'per Mail' : o.quelle === 'formular' ? 'über „Mehr Infos"' : ''
  const zeilen = o.fertig ? [
    `📦 Infopaket liegt im Postausgang (Mail + WhatsApp), bitte prüfen und senden.`,
    `Deck: ${o.fertig.deckUrl} · Prüfung: ${o.fertig.ampel === 'green' ? 'grün' : o.fertig.ampel === 'red' ? 'ROT, bitte Befunde ansehen' : o.fertig.ampel}`,
    ...(o.fertig.befunde.length ? [`Befunde: ${o.fertig.befunde.join(' | ').slice(0, 600)}`] : []),
    `Rechnungen: ${o.fertig.calcUrls.join(' · ')}`,
    `Postausgang: ${PORTAL_URL}/admin/crm/postausgang`,
  ] : [`⚠️ Infopaket konnte nicht vorbereitet werden: ${String(o.fehler ?? '').slice(0, 300)}. Bitte selbst über den Deck-Wizard erstellen.`]

  // Formular: die Aufgabe aus track-engagement gibt es schon, sie bekommt den Stand.
  if (o.taskId) {
    const { data: t } = await sb.from('crm_tasks').select('title, description').eq('id', o.taskId).maybeSingle()
    const tt = t as { title: string; description: string | null } | null
    if (tt) {
      await sb.from('crm_tasks').update({
        title: o.fertig ? `📩 ${o.p.name || o.p.first}: Infopaket zu ${objekt} liegt im Postausgang, prüfen und senden`.slice(0, 200) : tt.title,
        description: `${tt.description ?? ''}\n\n${zeilen.join('\n')}`.trim(),
      }).eq('id', o.taskId)
    }
  } else {
    const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
    const adminId = (admin as { id: string } | null)?.id ?? null
    const beschreibung = [
      `Wer: ${[o.p.name, o.p.email, o.p.phone].filter(Boolean).join(' · ')}`,
      `Anfrage ${wo}: „${o.text.replace(/\s+/g, ' ').slice(0, 500)}“`,
      ...zeilen,
    ].join('\n')
    const { data: task, error } = await sb.from('crm_tasks').insert({
      title: (o.fertig ? `📩 ${o.p.name || o.p.first}: Infopaket zu ${objekt} liegt im Postausgang, prüfen und senden` : `📩 ${o.p.name || o.p.first} möchte Infos zu ${objekt}`).slice(0, 200),
      description: beschreibung, created_by: adminId, assigned_to: adminId, status: 'offen', due_date: cyDate(new Date()),
      assigned_notified_at: new Date().toISOString(),
    }).select('id').single()
    if (error || !task) { console.error('[anfrage-paket] Aufgabe:', error?.message); return }
    const taskId = (task as { id: string }).id
    await sb.from('anfrage_pakete').update({ task_id: taskId }).eq('id', o.id)
    if (adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
    if (o.p.kind === 'lead' && o.p.id) await sb.from('crm_task_leads').insert({ task_id: taskId, lead_id: o.p.id })
    await sb.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: taskId }, headers: { Authorization: `Bearer ${SERVICE}` } })
      .catch((e: unknown) => console.warn('[anfrage-paket] dispatch:', e))
  }
  if (o.p.kind === 'lead' && o.p.id) {
    await sb.from('activities').insert({
      lead_id: o.p.id, type: 'note', direction: 'outbound', auto: true,
      subject: o.fertig ? `📦 Infopaket vorbereitet: ${objekt}` : `⚠️ Infopaket nicht vorbereitet: ${objekt}`,
      content: zeilen.join('\n'), completed_at: new Date().toISOString(),
    }).then(({ error }) => { if (error) console.warn('[anfrage-paket] Notiz:', error.message) })
  }
}

// ── Mail ────────────────────────────────────────────────────────────────────
// After-Sale (Sven 13.10.26): was wir nach dem Kauf übernehmen, mit Link auf die
// ausführliche Seite (auch aus anderen Mails verlinkbar).
const NACH_DEM_KAUF_URL = `${PORTAL_URL}/service/nach-dem-kauf.html`
const APP_BILD = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/render/image/public/landing-assets/app/as_einnahmen.jpg?width=1040&quality=80'
function nachDemKaufKarte(): string {
  const punkte = [
    ['Komplette Verwaltung', 'deiner Wohnung, du musst nicht vor Ort sein.'],
    ['Vermietung, wie du willst:', 'komplette Ferienvermietung über Airbnb, Booking.com und Direktbuchungen oder ein fester Langzeitmieter, den wir für dich suchen.'],
    ['Alle Rechnungen', 'für deine Wohnung bezahlen wir, zum Beispiel Reinigung oder Versicherung.'],
    ['Nur deine Bankverbindung', 'brauchen wir. Dein Geld überweisen wir dir regelmäßig.'],
    ['Alles im Blick', 'in der Happy Property App: Einnahmen, Ausgaben, Buchungen und Unterlagen.'],
  ]
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.navy};border-radius:12px;">
    <tr><td class="px" style="padding:22px 22px 6px;">
      <p style="margin:0 0 6px;font-family:${SERIF};font-size:20px;font-weight:700;color:#ffffff;">🔑 Nach dem Kauf: Wir kümmern uns um alles</p>
      <p style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:#d6dbe4;">Mit dem Kauf fängt unsere Arbeit erst richtig an. Das übernehmen wir für dich:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${punkte.map(([b, t]) => `<tr><td width="22" style="vertical-align:top;padding:3px 0 8px;font-family:${SANS};font-size:15px;color:${CI.coral};font-weight:700;">✓</td><td style="padding:3px 0 8px;font-family:${SANS};font-size:14px;line-height:1.55;color:#ffffff;"><strong>${esc(b)}</strong> ${esc(t)}</td></tr>`).join('')}
      </table>
    </td></tr>
    <tr><td class="px" style="padding:6px 22px 0;"><img src="${APP_BILD}" width="512" alt="Happy Property App: Einnahmen und Ausgaben deiner Wohnung" style="display:block;width:100%;height:auto;border-radius:8px;"></td></tr>
    <tr><td class="px" style="padding:16px 22px 22px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${CI.coral};border-radius:999px;padding:11px 20px;">
        <a href="${esc(NACH_DEM_KAUF_URL)}" style="font-family:${SANS};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">So betreuen wir deine Wohnung &rarr;</a>
      </td></tr></table>
    </td></tr>
  </table>
</td></tr>`
}

function mailHtml(m: {
  first: string; objekt: string; lage: string; gross: number; calcUrl: string; calcUrlCash: string; deckUrl: string
  terminUrl: string; fotos: string[]; fotoStand: string; quelle: Quelle; guide: boolean; std: CalcStandard; markt: Markt
  pdfUrl: string | null; zahlung: ReturnType<typeof zahlungsUebersicht>; zahlplanUrl: string | null
  plan: ReturnType<typeof ratenplan>
}): string {
  const fotosHtml = m.fotos.length ? `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.white};border:1px solid ${CI.line};border-radius:12px;">
    <tr><td class="px" style="padding:20px 22px 8px;">
      <p style="margin:0 0 6px;font-family:${SERIF};font-size:19px;font-weight:700;color:${CI.navy};">🏗 So weit ist der Bau</p>
      <p style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};">Fotos von der Baustelle${m.fotoStand ? `, Stand ${esc(m.fotoStand)}` : ''}.</p>
    </td></tr>
    <tr><td class="px" style="padding:0 22px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        ${m.fotos.map((f, i) => `<td class="stack" width="${m.fotos.length > 1 ? '50%' : '100%'}" style="padding:${i ? '0 0 0 6px' : '0 6px 0 0'};"><img src="${esc(f)}" width="${m.fotos.length > 1 ? 250 : 512}" alt="Baustelle" style="display:block;width:100%;height:auto;border-radius:8px;"></td>`).join('')}
      </tr></table>
    </td></tr>
  </table>
</td></tr>` : ''
  const dank = m.quelle === 'whatsapp' || m.quelle === 'mail' ? 'danke für deine Nachricht und dein Interesse' : 'danke für dein Interesse'
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>@media (max-width:620px){.px{padding-left:18px!important;padding-right:18px!important}.stack{display:block!important;width:100%!important;padding:0 0 10px!important}}</style></head>
<body style="margin:0;padding:0;background:${CI.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.cream};"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
  <tr><td style="background:${CI.navy};border-radius:14px 14px 0 0;padding:22px 26px;"><img src="${LOGO}" width="150" alt="Happy Property" style="display:block;height:auto;border:0;"></td></tr>
  <tr><td class="px" style="background:${CI.cream};padding:28px 26px 8px;">
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${CI.ink};">Hallo${m.first ? ` ${esc(m.first)}` : ''},</p>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${CI.ink};">${dank} an der ${esc(m.objekt)} (${esc(m.lage)}). Hier sind alle Unterlagen, damit du dir alles in Ruhe ansehen kannst.</p>
  </td></tr>
  <tr><td class="px" style="padding:6px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${karte('🏡', 'Deine Wohnung im Detail', 'Alle Bilder, der Grundriss, die Baubeschreibung, die Ausstattung, die Lage und der Zahlungsplan: alles zur Wohnung auf einer Seite.', 'Wohnung ansehen', m.deckUrl)}
    ${rechnungKarte({ gross: m.gross, calcUrl: m.calcUrl, calcUrlCash: m.calcUrlCash, terminUrl: m.terminUrl, std: m.std, markt: m.markt })}
    ${m.plan ? ratenplanKarte(m.plan, m.zahlplanUrl) : zahlungKarte(m.zahlung, m.zahlplanUrl)}
    ${m.pdfUrl ? karte('📎', 'Datenblatt zur Wohnung', 'Grundriss, Eckdaten, Ausstattung, Bilder und der Zahlungsplan als PDF. Ideal zum Weiterleiten, zum Beispiel an deinen Partner oder Steuerberater.', 'Datenblatt öffnen', m.pdfUrl) : ''}
    ${nachDemKaufKarte()}
    ${m.guide ? karte('📘', 'Immobilienguide Paphos 2026', 'Ablauf beim Kauf, Kaufnebenkosten und Steuern, kompakt erklärt.', 'Guide herunterladen', GUIDE_URL) : ''}
    ${fotosHtml}
  </table></td></tr>
  <tr><td class="px" style="padding:10px 26px 26px;">
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${CI.ink};">Am einfachsten gehen wir alles in 20 Minuten gemeinsam durch: dein Eigenkapital, deine Fragen und die Rechnung, die wirklich zu dir passt. Such dir einfach einen Termin aus:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${CI.navy};border-radius:999px;padding:13px 24px;">
      <a href="${esc(m.terminUrl)}" style="font-family:${SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Termin mit Sven aussuchen &rarr;</a>
    </td></tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;"><tr>
      <td style="padding-right:14px;"><img src="${PHOTO_SQ}" width="56" height="56" alt="Sven Rüprich" style="display:block;border-radius:50%;"></td>
      <td><p style="margin:0;font-family:${SANS};font-size:15px;color:${CI.ink};">Liebe Grüße</p><p style="margin:2px 0 0;font-family:${SERIF};font-size:18px;font-weight:700;color:${CI.navy};">Sven</p></td>
    </tr></table>
  </td></tr>
</table></td></tr></table>
</body></html>`
}

// ── Cron: offene Pakete einsammeln ──────────────────────────────────────────
async function sweep(sb: SupabaseClient): Promise<Record<string, unknown>> {
  // Hängende Claims (Lauf abgestürzt) nach 10 Min freigeben.
  await sb.from('anfrage_pakete').update({ abschluss_at: null }).eq('status', 'deck')
    .lt('abschluss_at', new Date(Date.now() - 7 * 60_000).toISOString())
  const { data } = await sb.from('anfrage_pakete').select('id, created_at').eq('status', 'deck').order('created_at').limit(10)
  const out: Record<string, string> = {}
  for (const r of (data ?? []) as { id: string; created_at: string }[]) {
    const res: { fertig: boolean; status?: string; fehler?: string } = await abschliessen(sb, r.id).catch(e => ({ fertig: false, fehler: String(e) }))
    out[r.id] = res.fertig ? (res.status ?? 'fertig') : (res.fehler ? `fehler: ${res.fehler}` : 'wartet')
    // Deck nach 60 Min immer noch nicht fertig: aufgeben und Sven Bescheid geben.
    if (!res.fertig && Date.now() - new Date(r.created_at).getTime() > 60 * 60_000) {
      const { data: c } = await sb.from('anfrage_pakete').update({ status: 'fehler', grund: 'Deck nach 60 Min nicht fertig' })
        .eq('id', r.id).eq('status', 'deck').select('*')
      const row = ((c ?? []) as PaketRow[])[0]
      if (row) {
        const p = await person(sb, { lead_id: row.lead_id, subscriber_id: row.subscriber_id, email: row.empfaenger_email, name: row.empfaenger_name })
        const { data: u } = await sb.from('crm_project_units').select('unit_number').eq('id', row.unit_id).maybeSingle()
        const { data: pr } = await sb.from('crm_projects').select('name').eq('id', row.project_id).maybeSingle()
        if (p) await svenAufgabe(sb, { id: row.id, p, unitNr: (u as { unit_number?: string } | null)?.unit_number ?? '?', projektName: (pr as { name?: string } | null)?.name ?? '', quelle: row.quelle, text: row.nachricht ?? '', frage: '', taskId: row.task_id, fehler: 'Deck nach 60 Min nicht fertig' })
      }
    }
  }
  return { ok: true, offen: Object.keys(out).length, out }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const denied = await gateCaller(req, 'anfrage-paket', { service: true, roles: ['admin'] }, CORS)
  if (denied) return denied
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const sb = createClient(SB_URL, SERVICE)
    // Cron (pg_net bricht nach wenigen Sekunden ab): Arbeit im Hintergrund, sofort antworten.
    if (body.action === 'abschluss') {
      const lauf = sweep(sb).then(r => console.log('[anfrage-paket] sweep', JSON.stringify(r))).catch(e => console.error('[anfrage-paket] sweep', e))
      if (edgeRt) { edgeRt.waitUntil(lauf); return json({ ok: true, gestartet: true }) }
      await lauf
      return json({ ok: true })
    }
    // Trockenlauf der Erkennung (keine Zeile, kein Deck): { action: 'test_erkennung', lead_id, text }
    if (body.action === 'test_erkennung' && typeof body.text === 'string') {
      const leadId = typeof body.lead_id === 'string' ? body.lead_id : null
      const ks = await kandidaten(sb, leadId, body.text)
      const e = ks.length ? await erkennen(sb, leadId, body.text, ks) : null
      const k = e?.kandidat ? ks[e.kandidat - 1] : null
      return json({ ok: true, kandidaten: ks.map(x => `${x.projekt} ${x.unit.unit_number} (${x.herkunft.join(', ')})`), erkennung: e,
        treffer: k ? { projekt: k.projekt, wohnung: k.unit.unit_number, unit_id: k.unit.id, vergeben: await anbietbar(sb, k.unit, leadId) } : null })
    }
    // Mail eines fertigen Pakets neu bauen: { action: 'mail_neu', id }
    if (body.action === 'mail_neu' && typeof body.id === 'string') {
      const { data: r0 } = await sb.from('anfrage_pakete').select('*').eq('id', body.id).maybeSingle()
      const row = r0 as (PaketRow & { deck_token: string | null; calc_tokens: string[] | null; outbox_id: string | null }) | null
      if (!row || row.status !== 'fertig' || !row.deck_token || !row.outbox_id) return json({ ok: false, reason: 'paket_nicht_fertig' }, 400)
      const p = await person(sb, { lead_id: row.lead_id, subscriber_id: row.subscriber_id, email: row.empfaenger_email, name: row.empfaenger_name })
      const { data: u } = await sb.from('crm_project_units').select(UNIT_COLS).eq('id', row.unit_id).maybeSingle()
      const { data: pr } = await sb.from('crm_projects').select('id, name, developer, location, latitude, longitude, furniture_included, completion_date, payment_schedule, deck_assets').eq('id', row.project_id).maybeSingle()
      if (!p || !u || !pr) return json({ ok: false, reason: 'daten_fehlen' }, 400)
      const out = await baueEntwurf(sb, row, p, u as UnitRow, pr as ProjektRow, row.deck_token, { calcTokens: row.calc_tokens ?? [], outboxId: row.outbox_id })
      return json({ ok: true, outbox_id: out.outboxId })
    }
    if (body.action === 'status' && typeof body.id === 'string') {
      const { data } = await sb.from('anfrage_pakete').select('*').eq('id', body.id).maybeSingle()
      return json({ ok: true, row: data })
    }
    return json(await start(sb, body))
  } catch (err) {
    console.error('[anfrage-paket]', err)
    return json({ ok: false, reason: 'fehler', error: (err as Error).message }, 500)
  }
})
