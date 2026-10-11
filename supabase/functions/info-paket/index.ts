// Supabase Edge Function: info-paket
// „Mehr Infos"-Paket zu einer Wohnung (Sven 11.10.26). Wer auf der Wohnungs-Seite
// Infos anfordert, bekommt automatisch EINE Mail von Sven mit:
//   1. persönlicher Kosten- und Mietrechnung (property_calculations, Standardannahmen)
//   2. der Wohnung zum Ausdrucken bzw. als PDF (/deck/<token>/print)
//   3. dem Immobilienguide Paphos 2026 (PDF, nur deutsch)
//   4. den neuesten Baustellenfotos des Projekts (falls vorhanden)
//
// Aufruf nur intern (Service-Role) aus track-engagement nach einer Info-Anfrage:
//   POST { token, lead_id?, subscriber_id?, email?, name?, question? }
//   → { ok, sent, reason?, calc_url?, deck_url? }
//
// Schalter crm_settings.info_paket_mode: off (Standard) | test | on.
//   test = nur an Svens eigene Adresse (Muster zur Abnahme), on = an alle.
// Nicht verschickt wird, wenn die Wohnung nicht mehr frei ist, der Preis sich seit
// dem Deck geändert hat, das Deck mehrere Wohnungen zeigt oder eine Kontaktsperre
// besteht. Dann bleibt es bei der Aufgabe für Sven (Grund steht in der Antwort).
//
// Keine Projekt- oder Bauträgernamen: Lage + Objekttyp aus dem Deck (Sven 30.9.).
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { bookingUrl, PORTAL_URL } from '../_shared/bookingLink.ts'
import { resolveLang } from '../_shared/recipientLang.ts'
import { CI } from '../_shared/brand.ts'
import { callAnthropic, textOf } from '../_shared/anthropic.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const INTERN_ADRESSEN = ['sven@happy-property.com']
const GUIDE_URL = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/web-reports/immobilienguide/immobilienguide-paphos-2026.pdf'
const LOGO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
const PHOTO_SQ = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/render/image/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg?width=112&height=112&resize=cover&quality=80'
const SERIF = "'Playfair Display',Georgia,serif", SANS = "'Montserrat',Helvetica,Arial,sans-serif"

// Standardannahmen der Rechnung = Svens Wizard-Stand vom Oktober 2026
// (Kurzzeitvermietung, Zins 3,8 %, 5,5 % Bruttomietrendite). Eigenkapital als
// Anteil vom Bruttopreis: mit 0 € (Svens Wizard-Wert) zeigte die Rechnung eine
// Eigenkapitalrendite von über 10.000 %, das wirkt bei einem Erstkontakt unseriös.
// Überschreibbar ohne Deploy über crm_settings.info_paket_calc (JSON, nur diese Felder).
const CALC_STANDARD = {
  letType: 'short', fin: 'yes', equityPct: 30, interestPct: 3.8, termYears: 20, amortPct: 2,
  yieldPct: 5.5, mgmtPct: 20, rentGrowth: 5, appreciationPct: 5, deTaxPct: 45, res: 'de',
}
type CalcStandard = typeof CALC_STANDARD

// Markt-Annahmen aus Svens eigenen Rechnungen (Sven 11.10.26: „die Zahlen zu Rate
// ziehen, die wir für diese Projekte und Wohnungen genutzt haben"). Reihenfolge:
// dieselbe Wohnung, sonst gleiches Projekt mit gleicher Zimmerzahl, sonst Standard.
// Übernommen wird nur, was an der Wohnung hängt (Vermietungsart, Rendite, Saison,
// Hotelkonzept, Wertsteigerung, Mietsteigerung). Finanzierung und Steuer hängen
// am Kunden und bleiben Standard. Verwaltung immer 20 % (Svens Agentur, 11.10.26). Rechnungen aus dem Infopaket
// selbst zählen nicht, sonst bestätigt sich der Standard immer wieder selbst.
interface Markt {
  letType: 'short' | 'long'; yieldPct: number; season: Record<string, unknown> | null; hotelConcept: boolean
  appreciationPct: number; rentGrowth: number; mgmtPct: number; quelle: 'wohnung' | 'projekt' | 'standard'; datum: string | null
}
type CalcItemRow = { project?: string; unit?: string; bedrooms?: number | string | null; params?: Record<string, unknown> }
async function marktAnnahmen(sb: SupabaseClient, projekt: string, nr: string, bedrooms: number | null, std: CalcStandard): Promise<Markt> {
  const standard: Markt = {
    letType: std.letType === 'long' ? 'long' : 'short', yieldPct: std.yieldPct, season: null, hotelConcept: false,
    appreciationPct: std.appreciationPct, rentGrowth: std.rentGrowth, mgmtPct: std.mgmtPct, quelle: 'standard', datum: null,
  }
  if (!projekt) return standard
  const seit = new Date(Date.now() - 180 * 86400e3).toISOString()
  const { data } = await sb.from('property_calculations').select('content, created_at')
    .filter('content->items', 'cs', JSON.stringify([{ project: projekt }]))
    .gte('created_at', seit).order('created_at', { ascending: false }).limit(60)
  const rows = (data ?? []) as { content: { source?: string; items?: CalcItemRow[] } | null; created_at: string }[]
  const alle = rows.filter(r => r.content?.source !== 'info_paket')
    .flatMap(r => (r.content?.items ?? []).filter(i => i.project === projekt && i.params).map(i => ({ i, datum: r.created_at })))
  const norm = (x: unknown) => String(x ?? '').trim().toLowerCase()
  const gleicheWohnung = nr ? alle.find(k => norm(k.i.unit) === norm(nr)) : undefined
  const gleicheGroesse = bedrooms != null ? alle.find(k => Number(k.i.bedrooms) === bedrooms) : undefined
  const t = gleicheWohnung ?? gleicheGroesse
  if (!t) return standard
  const p = t.i.params ?? {}
  const letType: 'short' | 'long' = p.letType === 'long' ? 'long' : 'short'
  const hotel = letType === 'short' && p.hotelConcept === true
  const zahl = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
  // Verwaltung immer der Standard (20 %, Svens Agentur), nie aus alten Rechnungen.
  const mgmtPct = std.mgmtPct
  const season = letType === 'short' && p.season && typeof p.season === 'object' ? p.season as Record<string, unknown> : null
  return {
    letType, yieldPct: zahl(p.yieldPct, std.yieldPct), season, hotelConcept: hotel,
    appreciationPct: zahl(p.appreciationPct, std.appreciationPct), rentGrowth: zahl(p.rentGrowth, std.rentGrowth), mgmtPct,
    quelle: gleicheWohnung ? 'wohnung' : 'projekt', datum: t.datum,
  }
}

// Vollständiger Parametersatz wie ihn der Wizard speichert (Rechnung.tsx rechnet
// item.params direkt, ohne Defaults einzumischen - deshalb ALLE Felder).
function eigenkapital(s: CalcStandard, gross: number): number {
  return s.fin === 'yes' ? Math.round(gross * Math.max(0, Math.min(100, s.equityPct)) / 100 / 1000) * 1000 : gross
}
function calcParams(s: CalcStandard, m: Markt, fin: 'yes' | 'no', priceNet: number, furnCost: number, furnFree: boolean, bedrooms: number | null) {
  const brutto = Math.round((priceNet + (furnFree ? 0 : furnCost)) * 1.19)
  return {
    fin, res: s.res, cyBI: 0, gesy: true, mode: 'ann', year: new Date().getFullYear(), month: 6,
    sdNum: 3, sdSqm: 250, years: 10, equity: fin === 'yes' ? eigenkapital(s, brutto) : brutto, holder: 'privat', ppVals: Array(10).fill(0), sdTerr: 60,
    season: m.season, letType: m.letType, mgmtFix: 0, mgmtPct: m.mgmtPct, sdPrice: 1000000, sdUnits: [],
    vatMode: 'standard19', amortPct: s.amortPct, bedrooms: bedrooms ?? 2, deTaxPct: s.deTaxPct, dealType: 'single',
    furnCost, furnFree, maintPct: 0, mgmtMode: 'pct', priceNet, yieldPct: m.yieldPct, divTaxPct: 26.375,
    livingSqm: null, monthPlan: null, sdTaxRate: 15, socialIns: true, termYears: s.termYears, corpTaxPct: 15,
    rentGrowth: m.rentGrowth, sdDiscount: 0, sdVatDrawn: 0, sdVatYears: 0, discountPct: 0,
    interestPct: s.interestPct, opexMonthly: 0, sdInputMode: 'manual', divPayoutPct: 100,
    hotelConcept: m.hotelConcept, selfUseMonths: 0, appreciationPct: m.appreciationPct,
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const eur = (n: number) => `${Math.round(n).toLocaleString('de-DE')} €`

interface Empfaenger { kind: 'lead' | 'sub' | 'frei'; id: string | null; first: string; name: string; email: string | null; bookingToken: string | null }

async function empfaenger(sb: SupabaseClient, b: Record<string, unknown>): Promise<Empfaenger | null> {
  const leadId = typeof b.lead_id === 'string' ? b.lead_id : null
  const subId = typeof b.subscriber_id === 'string' ? b.subscriber_id : null
  if (leadId) {
    const { data } = await sb.from('leads').select('id, first_name, last_name, email, booking_token').eq('id', leadId).maybeSingle()
    const l = data as { id: string; first_name: string | null; last_name: string | null; email: string | null; booking_token: string | null } | null
    if (!l) return null
    return { kind: 'lead', id: l.id, first: (l.first_name ?? '').trim(), name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(), email: l.email, bookingToken: l.booking_token }
  }
  if (subId) {
    const { data } = await sb.from('newsletter_subscribers').select('id, first_name, last_name, email').eq('id', subId).maybeSingle()
    const s = data as { id: string; first_name: string | null; last_name: string | null; email: string | null } | null
    if (!s) return null
    return { kind: 'sub', id: s.id, first: (s.first_name ?? '').trim(), name: `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(), email: s.email, bookingToken: null }
  }
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!email) return null
  return { kind: 'frei', id: null, first: name.split(' ')[0] ?? '', name, email, bookingToken: null }
}

// ── Baustellenfotos für Interessenten (Sven 11.10.26, feste Regel) ──────────
// „Keine hässlichen Dinge auf Fotos an potentielle Kunden. Nimm ein Bild, auf dem
// das nicht zu sehen ist. IMMER." Nichts wird retuschiert: Ein Foto ist geeignet
// oder es fällt weg. Urteile stehen in crm_settings.kundenfotos
// ({ <file_path>: { ok, grund, von, am } }); von = 'sven' | 'claude' schlägt die KI.
// Neue Fotos prüft die KI einmal (im Zweifel ungeeignet), das Urteil bleibt stehen.
type FotoUrteil = { ok: boolean; grund?: string; von?: string; am?: string }
const FOTO_PROMPT = `Du prüfst ein Baustellenfoto, das an Interessenten für eine Neubauwohnung geht. Svens Regel: Auf dem Foto darf nichts Unschönes zu sehen sein.
Ungeeignet, sobald etwas davon erkennbar ist: alte, heruntergekommene oder unverputzte Nachbargebäude, Graffiti, Müll, Schutthaufen, Reifen, kaputte Zäune, Planen, fremde Werbeschilder groß im Bild, erkennbare Personen, dunkles, schiefes oder verwackeltes Bild.
In Ordnung sind normale Baustellenteile: Beton, Bewehrung, Schalung, Kran, Betonpumpe, Gerüst, ordentlich gelagertes Material, moderne oder gepflegte Nachbargebäude, Himmel.
Im Zweifel: ungeeignet.
Antworte nur mit JSON: {"geeignet": true oder false, "grund": "max. 12 Wörter"}`
async function fotoPruefen(url: string): Promise<FotoUrteil | null> {
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  const res = await callAnthropic(key, {
    model: 'claude-opus-5-5', fallbackModels: ['claude-sonnet-4-6'], max_tokens: 4000, label: 'info-paket-foto',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'url', url } },
      { type: 'text', text: FOTO_PROMPT },
    ] }],
  })
  if (!res.ok || res.stop_reason === 'refusal') return null
  const m = textOf(res).match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { geeignet?: boolean; grund?: string }
    return { ok: j.geeignet === true, grund: String(j.grund ?? '').slice(0, 120), von: 'ki', am: new Date().toISOString() }
  } catch { return null }
}
async function kundenFotos(sb: SupabaseClient, projectId: string): Promise<{ fotos: string[]; fotoStand: string }> {
  const { data: ph } = await sb.from('construction_photos').select('file_path, photo_date')
    .eq('project_id', projectId).order('photo_date', { ascending: false, nullsFirst: false }).limit(8)
  const rows = (ph ?? []) as { file_path: string; photo_date: string | null }[]
  if (!rows.length) return { fotos: [], fotoStand: '' }
  const { data: st } = await sb.from('crm_settings').select('value').eq('key', 'kundenfotos').maybeSingle()
  let urteile: Record<string, FotoUrteil> = {}
  try { urteile = JSON.parse((st as { value?: string } | null)?.value ?? '{}') } catch { urteile = {} }
  const signed = async (path: string, w: number, h: number) => (await sb.storage.from('construction-photos')
    .createSignedUrl(path, 180 * 86400, { transform: { width: w, height: h, resize: 'cover', quality: 75 } })).data?.signedUrl ?? null
  const gewaehlt: { url: string; datum: string | null }[] = []
  let neu = false, geprueft = 0
  for (const r of rows) {
    if (gewaehlt.length >= 2) break
    let u = urteile[r.file_path]
    // Höchstens 3 KI-Prüfungen je Anfrage, damit der Kunde nicht wartet.
    if (!u && geprueft < 3) {
      geprueft++
      const prev = await signed(r.file_path, 1000, 750)
      const k = prev ? await fotoPruefen(prev) : null
      if (k) { u = k; urteile[r.file_path] = k; neu = true }
    }
    if (!u?.ok) continue
    const url = await signed(r.file_path, 560, 420)
    if (url) gewaehlt.push({ url, datum: r.photo_date })
  }
  if (neu) {
    await sb.from('crm_settings').upsert({ key: 'kundenfotos', value: JSON.stringify(urteile), updated_at: new Date().toISOString() }, { onConflict: 'key' })
  }
  const dt = gewaehlt[0]?.datum
  const fotoStand = dt ? new Date(`${dt}T12:00:00`).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
  return { fotos: gewaehlt.map(g => g.url), fotoStand }
}

type Block = { type?: string; number?: string; kicker?: string; mapLabel?: string }
type CtxUnit = { unitId?: string; unitNumber?: string; netProperty?: number; netFurniture?: number; bedrooms?: number | null }

async function handle(sb: SupabaseClient, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Nur Fotos eines Projekts prüfen (intern): { mode: 'fotos', project_id }
  if (b.mode === 'fotos' && typeof b.project_id === 'string') {
    const r = await kundenFotos(sb, b.project_id)
    return { ok: true, fotos: r.fotos.length, stand: r.fotoStand }
  }
  // 0) Schalter
  const { data: modeRow } = await sb.from('crm_settings').select('value').eq('key', 'info_paket_mode').maybeSingle()
  const mode = String((modeRow as { value?: string } | null)?.value ?? 'off').trim()
  if (mode !== 'on' && mode !== 'test') return { ok: true, sent: false, reason: 'automatik_aus' }

  const token = typeof b.token === 'string' ? b.token : ''
  const { data: deck } = await sb.from('sales_decks').select('token, lead_id, project_id, content, deck_context').eq('token', token).maybeSingle()
  const d = deck as { token: string; lead_id: string | null; project_id: string | null; content: { blocks?: Block[] } | null; deck_context: Record<string, unknown> | null } | null
  if (!d) return { ok: false, sent: false, reason: 'deck_fehlt' }

  const p = await empfaenger(sb, b)
  if (!p?.email) return { ok: true, sent: false, reason: 'keine_mail' }
  if (mode === 'test' && !INTERN_ADRESSEN.includes(p.email.toLowerCase())) return { ok: true, sent: false, reason: 'testmodus' }

  // 1) Kontaktsperre (Kunde will gar nicht angeschrieben werden)
  if (p.kind === 'lead') {
    const { data: opt } = await sb.from('communication_optouts').select('id').eq('lead_id', p.id).limit(1)
    if (opt && opt.length) return { ok: true, sent: false, reason: 'kontaktsperre' }
  }

  // 2) Genau eine Wohnung im Deck
  const ctx = d.deck_context ?? {}
  const units = (Array.isArray(ctx.units) ? ctx.units : []) as CtxUnit[]
  if (units.length !== 1 || !units[0].unitId) return { ok: true, sent: false, reason: 'mehrere_wohnungen' }
  const cu = units[0]

  // 3) Wohnung noch frei? (kein aktiver Deal, kein Eigentümer, Status nicht verkauft)
  const { data: unitRow } = await sb.from('crm_project_units')
    .select('id, unit_number, status, property_id, price_net, price_net_furnished, vat_rate, bedrooms, size_sqm, terrace_sqm, floor')
    .eq('id', cu.unitId).maybeSingle()
  const u = unitRow as { id: string; unit_number: string; status: string | null; property_id: string | null; price_net: number | null; price_net_furnished: number | null; vat_rate: number | null; bedrooms: number | null; size_sqm: number | null; terrace_sqm: number | null; floor: number | null } | null
  if (!u) return { ok: true, sent: false, reason: 'wohnung_fehlt' }
  if (u.property_id || ['sold', 'reserved'].includes(String(u.status ?? ''))) return { ok: true, sent: false, reason: 'wohnung_vergeben' }
  const { data: deals } = await sb.from('deals').select('id').eq('unit_id', u.id).is('archived_from_phase', null).neq('phase', 'deal_verloren').limit(1)
  if (deals && deals.length) return { ok: true, sent: false, reason: 'wohnung_vergeben' }

  // 4) Preis wie im Deck? Gleiche Regel wie deckContext: bei „Möbel inklusive"
  //    gilt die Preisspalte mit Möbeln, sonst Netto + Möbelpaket getrennt.
  const furnMode = String(ctx.furnitureMode ?? 'optional')
  const vatMode = String(ctx.vatMode ?? 'standard19')
  if (vatMode !== 'standard19' || Number(u.vat_rate ?? 19) !== 19) return { ok: true, sent: false, reason: 'mwst_sonderfall' }
  const netJetzt = furnMode === 'included' ? Number(u.price_net_furnished ?? u.price_net ?? 0) : Number(u.price_net ?? 0)
  const netDeck = Number(cu.netProperty ?? 0)
  if (!netJetzt || Math.abs(netJetzt - netDeck) > 1) return { ok: true, sent: false, reason: 'preis_geaendert', deck: netDeck, jetzt: netJetzt }
  const furnCost = furnMode === 'optional' ? Number(cu.netFurniture ?? 0) : 0
  const furnFree = furnMode === 'included'

  // 5) Namen ohne Projekt: Lage aus dem Deck („Neubau Zentrum Paphos")
  const blocks = d.content?.blocks ?? []
  let lage = blocks.find(x => x.type === 'facts' && x.mapLabel)?.mapLabel
    ?? blocks.find(x => x.type === 'cover' && x.kicker)?.kicker?.replace(/\s*·\s*/g, ' ')
    ?? 'Neubau in Paphos'
  // Persönliche Decks können den Projektnamen tragen - dann neutral bleiben.
  let projektName = ''
  if (d.project_id) {
    const { data: pr } = await sb.from('crm_projects').select('name, developer').eq('id', d.project_id).maybeSingle()
    projektName = String((pr as { name?: string } | null)?.name ?? '').trim()
    const namen = [(pr as { name?: string } | null)?.name, (pr as { developer?: string } | null)?.developer]
      .map(x => String(x ?? '').trim().toLowerCase()).filter(x => x.length >= 3)
    if (namen.some(n => lage.toLowerCase().includes(n))) lage = 'Neubau in Paphos'
  }
  const nr = (blocks.find(x => x.type === 'unit')?.number ?? u.unit_number ?? '').trim()
  const objekt = nr ? `Wohnung ${nr}` : 'Wohnung'
  const label = nr ? `${lage} · ${nr}` : lage

  // 6) Rechnung anlegen (Standardannahmen, ggf. aus crm_settings überschrieben)
  let std: CalcStandard = { ...CALC_STANDARD }
  try {
    const { data: ov } = await sb.from('crm_settings').select('value').eq('key', 'info_paket_calc').maybeSingle()
    const raw = (ov as { value?: string } | null)?.value
    if (raw) {
      const o = JSON.parse(raw) as Partial<CalcStandard>
      for (const k of Object.keys(CALC_STANDARD) as (keyof CalcStandard)[]) if (o[k] !== undefined) (std as Record<string, unknown>)[k] = o[k]
    }
  } catch { /* Standard bleibt */ }
  const markt = await marktAnnahmen(sb, projektName, nr, u.bedrooms, std)
  const gross = Math.round(netJetzt * 1.19)
  const grossGesamt = Math.round((netJetzt + furnCost) * 1.19)
  const empfName = p.name || p.first || ''
  // Zwei Rechnungen (Sven 11.10.26): finanziert und ohne Kredit. Genau wird es
  // erst mit seinem Eigenkapital, darauf zielt der Termin.
  const rechnung = async (fin: 'yes' | 'no', zusatz: string): Promise<string | null> => {
    const item = {
      label: `${label} · ${zusatz}`, project: lage, unit: nr, bedrooms: u.bedrooms, size_sqm: u.size_sqm, terrace_sqm: u.terrace_sqm, floor: u.floor,
      price_net: netJetzt, price_gross: gross, params: calcParams(std, markt, fin, netJetzt, furnCost, furnFree, u.bedrooms),
    }
    const { data: row, error } = await sb.from('property_calculations').insert({
      lead_id: p.kind === 'lead' ? p.id : null, recipient_name: empfName, title: `Rechnung ${label} (${zusatz})`, with_calc: true,
      content: { with_calc: true, recipient_name: empfName, items: [item], source: 'info_paket', annahmen_quelle: markt.quelle },
    }).select('token').single()
    if (error) console.error('[info-paket] Rechnung:', error.message)
    const tok = (row as { token?: string } | null)?.token
    return tok ? `${PORTAL_URL}/rechnung/${tok}` : null
  }
  const calcUrl = await rechnung('yes', 'finanziert')
  const calcUrlCash = await rechnung('no', 'ohne Kredit')
  if (!calcUrl || !calcUrlCash) return { ok: false, sent: false, reason: 'rechnung_fehler' }

  // 7) Baustellenfotos: nur saubere Bilder (Svens feste Regel), höchstens 2
  const { fotos, fotoStand } = d.project_id ? await kundenFotos(sb, d.project_id) : { fotos: [], fotoStand: '' }

  // 8) Mail bauen
  const lang = await resolveLang(sb, { email: p.email, lead_id: p.kind === 'lead' ? p.id : null })
  const ref = p.kind === 'lead' ? `l:${p.id}` : p.kind === 'sub' ? `s:${p.id}` : ''
  const deckUrl = `${PORTAL_URL}/deck/${d.token}${ref ? `?hpr=${encodeURIComponent(ref)}` : ''}`
  const printUrl = `${PORTAL_URL}/deck/${d.token}/print`
  const terminUrl = p.kind === 'lead' ? bookingUrl(p.bookingToken) : `${PORTAL_URL}/termin?f=none&src=infopaket`
  const frage = typeof b.question === 'string' ? b.question.trim().slice(0, 500) : ''
  const html = mailHtml({
    first: p.first, objekt, lage, gross: grossGesamt, calcUrl, calcUrlCash, deckUrl, printUrl, terminUrl, fotos, fotoStand, frage,
    guide: lang !== 'en', std, markt,
  })
  const subject = `${p.first ? `${p.first}, d` : 'D'}eine Unterlagen zur ${objekt}`
  const { data: sent, error: sErr } = await sb.functions.invoke('send-email', { body: {
    to: p.email, subject, html, lead_id: p.kind === 'lead' ? p.id : null, auto: true, lang,
  } })
  if (sErr || !(sent as { success?: boolean } | null)?.success) {
    console.error('[info-paket] Versand fehlgeschlagen:', sErr)
    return { ok: false, sent: false, reason: 'versand_fehler', calc_url: calcUrl, calc_url_cash: calcUrlCash }
  }
  return { ok: true, sent: true, calc_url: calcUrl, calc_url_cash: calcUrlCash, deck_url: deckUrl, to: p.email, annahmen: markt.quelle }
}

function karte(icon: string, titel: string, text: string, knopf: string, url: string): string {
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.white};border:1px solid ${CI.line};border-radius:12px;">
    <tr><td class="px" style="padding:20px 22px;">
      <p style="margin:0 0 6px;font-family:${SERIF};font-size:19px;font-weight:700;color:${CI.navy};">${icon} ${esc(titel)}</p>
      <p style="margin:0 0 14px;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};">${text}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:${CI.coral};border-radius:999px;padding:11px 20px;">
          <a href="${esc(url)}" style="font-family:${SANS};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(knopf)} &rarr;</a>
        </td></tr></table>
    </td></tr>
  </table>
</td></tr>`
}

const pct = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')} %`
function knopf(text: string, url: string, farbe: string): string {
  return `<td style="background:${farbe};border-radius:999px;padding:11px 18px;"><a href="${esc(url)}" style="font-family:${SANS};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;white-space:nowrap;">${esc(text)} &rarr;</a></td>`
}
function rechnungKarte(m: { gross: number; calcUrl: string; calcUrlCash: string; terminUrl: string; std: CalcStandard; markt: Markt }): string {
  const k = m.markt
  const vermietung = k.letType === 'long' ? 'Langzeitvermietung' : k.hotelConcept ? 'Kurzzeitvermietung mit Hotelkonzept' : 'Kurzzeitvermietung'
  const rendite = k.season ? 'Mieteinnahmen nach Saisonmodell' : `${pct(k.yieldPct)} Bruttomietrendite`
  const annahmen = `Annahmen: ${vermietung}, ${rendite}, Verwaltung ${pct(k.mgmtPct)}, Wertsteigerung ${pct(k.appreciationPct)} pro Jahr. Variante mit Finanzierung: ${m.std.equityPct} % Eigenkapital, ${pct(m.std.interestPct)} Zins, ${m.std.termYears} Jahre.`
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.white};border:1px solid ${CI.line};border-radius:12px;">
    <tr><td class="px" style="padding:20px 22px;">
      <p style="margin:0 0 6px;font-family:${SERIF};font-size:19px;font-weight:700;color:${CI.navy};">📊 Deine persönliche Kosten- und Mietrechnung</p>
      <p style="margin:0 0 10px;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};">Bruttokaufpreis ${eur(m.gross)}. Ich habe dir zwei Varianten gerechnet: einmal finanziert, einmal ohne Kredit. Beide mit Nebenkosten, Mieteinnahmen${k.letType === 'short' ? ', MwSt-Erstattung' : ''} und Cashflow über 10 Jahre.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${knopf('Mit Finanzierung', m.calcUrl, CI.coral)}<td style="width:10px;font-size:0;">&nbsp;</td>${knopf('Ohne Kredit', m.calcUrlCash, CI.navy)}
      </tr></table>
      <p style="margin:14px 0 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${CI.mute};">${esc(annahmen)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>
        <td style="background:${CI.coralSoft};border-radius:10px;padding:14px 16px;">
          <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${CI.ink};"><strong>Genauere Zahlen bekommst du, sobald ich dein Eigenkapital und deine Steuersituation kenne.</strong> Das klären wir am besten in einem kurzen Gespräch, dann rechne ich dir deine Variante genau durch. <a href="${esc(m.terminUrl)}" style="color:${CI.navy};font-weight:700;">Termin aussuchen</a></p>
        </td></tr></table>
    </td></tr>
  </table>
</td></tr>`
}

function mailHtml(m: {
  first: string; objekt: string; lage: string; gross: number; calcUrl: string; calcUrlCash: string; deckUrl: string; printUrl: string
  terminUrl: string; fotos: string[]; fotoStand: string; frage: string; guide: boolean; std: CalcStandard; markt: Markt
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
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>@media (max-width:620px){.px{padding-left:18px!important;padding-right:18px!important}.stack{display:block!important;width:100%!important;padding:0 0 10px!important}}</style></head>
<body style="margin:0;padding:0;background:${CI.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CI.cream};"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
  <tr><td style="background:${CI.navy};border-radius:14px 14px 0 0;padding:22px 26px;"><img src="${LOGO}" width="150" alt="Happy Property" style="display:block;height:auto;border:0;"></td></tr>
  <tr><td class="px" style="background:${CI.cream};padding:28px 26px 8px;">
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${CI.ink};">Hallo${m.first ? ` ${esc(m.first)}` : ''},</p>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${CI.ink};">danke für dein Interesse an der ${esc(m.objekt)} (${esc(m.lage)}). Hier sind deine Unterlagen, damit du alles in Ruhe durchgehen kannst.</p>
    ${m.frage ? `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${CI.ink};">Deine Frage („${esc(m.frage)}“) beantworte ich dir persönlich.</p>` : ''}
  </td></tr>
  <tr><td class="px" style="padding:6px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${rechnungKarte(m)}
    ${karte('📄', 'Die Wohnung zum Weiterleiten', 'Grundriss, Ausstattung und Zahlungsplan auf einen Blick. Öffne die Druckansicht und speichere sie als PDF, zum Beispiel für deinen Partner oder Steuerberater.', 'Als PDF speichern', m.printUrl)}
    ${m.guide ? karte('📘', 'Immobilienguide Paphos 2026', 'Ablauf beim Kauf, Kaufnebenkosten und Steuern, kompakt erklärt.', 'Guide herunterladen', GUIDE_URL) : ''}
    ${fotosHtml}
  </table></td></tr>
  <tr><td class="px" style="padding:10px 26px 26px;">
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${CI.ink};">Am einfachsten gehen wir alles in 20 Minuten gemeinsam durch: dein Eigenkapital, deine Fragen und die Rechnung, die wirklich zu dir passt. Such dir einfach einen Termin aus:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${CI.navy};border-radius:999px;padding:13px 24px;">
      <a href="${esc(m.terminUrl)}" style="font-family:${SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Termin mit Sven aussuchen &rarr;</a>
    </td></tr></table>
    <p style="margin:18px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${CI.mute};">Die Wohnung kannst du dir jederzeit wieder ansehen: <a href="${esc(m.deckUrl)}" style="color:${CI.navy};">zur Wohnung</a></p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;"><tr>
      <td style="padding-right:14px;"><img src="${PHOTO_SQ}" width="56" height="56" alt="Sven Rüprich" style="display:block;border-radius:50%;"></td>
      <td><p style="margin:0;font-family:${SANS};font-size:15px;color:${CI.ink};">Liebe Grüße</p><p style="margin:2px 0 0;font-family:${SERIF};font-size:18px;font-weight:700;color:${CI.navy};">Sven</p></td>
    </tr></table>
  </td></tr>
</table></td></tr></table>
</body></html>`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const denied = await gateCaller(req, 'info-paket', { service: true, roles: ['admin'] }, CORS)
  if (denied) return denied
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    return json(await handle(sb, body))
  } catch (err) {
    console.error('[info-paket]', err)
    return json({ ok: false, sent: false, reason: 'fehler', error: (err as Error).message }, 500)
  }
})
