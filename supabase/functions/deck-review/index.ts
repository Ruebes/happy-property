// deck-review: Prüfteam für ein fertiges Sales Deck, mit Endscore 0-100.
//
// Sven 25.10.26: "Unsere Sales-Decks haben oft keinen guten Standard. Mal fehlt
// der Grundriss, mal sind falsche Bilder drin, mal fehlt die Marina." Vorbild ist
// der Blog-Autopilot (mehrere Prüfer, am Ende Chefredaktion mit Punktzahl).
//
// Geprüft wird, was der KUNDE sieht: Deck-Blöcke plus Projektseite im
// Website-Stil (get_deck_page), so zusammengesetzt wie webBlocks() in
// src/pages/deckWeb.tsx. Ändert sich dort die Reihenfolge oder kommt ein
// Abschnitt dazu, hier in sichtbareAbschnitte() nachziehen.
//
// Prüfer (laufen parallel):
//   1. Vollständigkeit (Code)  Pflichtteile da? Grundriss je Wohnung im HP-Stil,
//                              Karte, Marina, Zahlungsplan, Abschluss, Wohnung
//                              noch verfügbar, Preis noch aktuell.
//   2. Bilder (Vision)         jedes sichtbare Foto: passt es, falscher
//                              Wohnungstyp, Werbung/Collage, hässlich?
//   3. Fakten (KI)             Texte gegen CRM-Fakten.
//   4. Regeln (KI)             Svens feste Regeln + Projektregeln (deck_ai_rules).
//   5. Kundensicht (KI)        Wirkung, roter Faden, Personalisierung.
//   6. Chef (KI)               Teilnoten, Endscore, die wichtigsten Korrekturen.
//
// Der Endscore wird hart gedeckelt: ein kritischer Befund -> höchstens 69, ein
// hoher -> höchstens 84. Versandbereit ab 85 (wie Chefredaktion im Blog).
//
// Die Funktion ÄNDERT das Deck nicht. Sie schreibt nur sales_decks.review,
// review_score und reviewed_at.
//
// Aufruf: POST { token, force? } (Sven im CRM, Knopf "Neu prüfen") oder
// POST { action: 'faellige' } (Cron alle 10 Min: Decks der letzten 14 Tage mit
// Lead, deren Inhalt sich seit der letzten Prüfung geändert hat, max. 3 je Lauf).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'
import { gateCaller } from '../_shared/callerGate.ts'

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const PRUEFER_MODELL = 'claude-sonnet-5-5'
const CHEF_MODELL = 'claude-opus-5-5'
const FALLBACK = ['claude-sonnet-4-6']
const VERSION = 1
const SCHWELLE = 85
const MAX_BILDER = 28

type Sev = 'kritisch' | 'hoch' | 'mittel' | 'niedrig'
interface Befund { pruefer: string; key: string; severity: Sev; what: string; where?: string; evidence?: string; fix?: string }
type Block = Record<string, unknown>
// deno-lint-ignore no-explicit-any
type Sb = ReturnType<typeof createClient<any>>

const SEV_RANG: Record<Sev, number> = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 }
const SEV_ENUM = ['kritisch', 'hoch', 'mittel', 'niedrig']

// ── Daten laden ────────────────────────────────────────────────────────────────

interface Lage {
  deck: Record<string, any>
  blocks: Block[]
  page: Record<string, any> | null
  ctx: Record<string, any> | null
  projekt: Record<string, any> | null
  units: Array<Record<string, any>>
  lead: Record<string, any> | null
  regeln: string[]
  hash: string
}

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24)
}

async function lade(sb: Sb, token: string): Promise<Lage> {
  const { data: deck, error } = await sb.from('sales_decks')
    .select('id, token, lead_id, project_id, unit_id, angle, recipient_name, content, deck_context, quality_status, quality_report, review, created_at, updated_at')
    .eq('token', token).maybeSingle()
  if (error) throw new Error(`DB: ${error.message}`)
  if (!deck) throw new Error('Deck nicht gefunden')
  const d = deck as Record<string, any>
  const blocks = (Array.isArray(d.content?.blocks) ? d.content.blocks : []) as Block[]
  const { data: page } = await sb.rpc('get_deck_page', { p_token: token })
  const ctx = (d.deck_context ?? null) as Record<string, any> | null

  let projekt: Record<string, any> | null = null
  let units: Array<Record<string, any>> = []
  let regeln: string[] = []
  if (d.project_id) {
    const { data: p } = await sb.from('crm_projects')
      .select('id, name, developer, location, latitude, longitude, video_url, own_video_url, deck_assets')
      .eq('id', d.project_id).maybeSingle()
    projekt = (p ?? null) as Record<string, any> | null
    const { data: u } = await sb.from('crm_project_units')
      .select('id, unit_number, unit_key, type, status, property_id, price_net, price_net_furnished, hp_floorplan_url, bedrooms, bathrooms, size_sqm, terrace_sqm, plot_sqm, floor')
      .eq('project_id', d.project_id)
    units = (u ?? []) as Array<Record<string, any>>
  }
  let rq = sb.from('deck_ai_rules').select('rule').eq('active', true).eq('kind', 'deck')
  rq = d.project_id ? rq.or(`project_id.is.null,project_id.eq.${d.project_id}`) : rq.is('project_id', null)
  const { data: r } = await rq
  regeln = ((r ?? []) as Array<{ rule: string }>).map(x => x.rule)

  let lead: Record<string, any> | null = null
  if (d.lead_id) {
    const { data: l } = await sb.from('leads').select('first_name, last_name, language, notes').eq('id', d.lead_id).maybeSingle()
    lead = (l ?? null) as Record<string, any> | null
  }
  // Nur der Deck-Inhalt: Projektseiten-Änderungen lösen keine Neuprüfung aus
  // (sie betreffen alle Decks des Projekts gleichzeitig, Neu prüfen per Knopf).
  const hash = await sha(JSON.stringify(d.content ?? null))
  return { deck: d, blocks, page: (page ?? null) as Record<string, any> | null, ctx, projekt, units, lead, regeln, hash }
}

// ── Was der Kunde sieht ─────────────────────────────────────────────────────────

/** quelle: deck = gehört nur zu diesem Deck · seite = Projektseite der Website
 *  (gilt für alle Decks des Projekts) · system = fester Systemtext (Marina). */
interface Abschnitt { name: string; text: string; bilder: Array<{ url: string; label: string }>; quelle: 'deck' | 'seite' | 'system' }

const URL_KEYS = new Set(['image', 'video', 'videoUrl', 'embedUrl', 'poster', 'link', 'mapUrl', 'url', 'src', 'href', 'img', 'clip', 'yt', 'mapEmbed', 'imageIntent'])
function texte(v: unknown, out: string[] = [], key = ''): string[] {
  if (typeof v === 'string') { if (!URL_KEYS.has(key) && !/^https?:\/\//.test(v) && v.trim()) out.push(v.trim()) }
  else if (typeof v === 'number' && !/^map|lat|lng|pct$/i.test(key)) { /* Zahlen stehen auch als Text */ }
  else if (Array.isArray(v)) v.forEach(x => texte(x, out, key))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) texte(x, out, k)
  return out
}
function blockBilder(b: Block, name: string): Array<{ url: string; label: string }> {
  const out: Array<{ url: string; label: string }> = []
  const titel = [b.kicker, b.headline, b.title, b.number].filter(x => typeof x === 'string').join(' - ')
  if (typeof b.image === 'string' && b.image) out.push({ url: b.image, label: `${name}: ${titel}` })
  for (const key of ['items', 'images', 'cards', 'cols']) {
    const arr = b[key]
    if (!Array.isArray(arr)) continue
    for (const it of arr as Array<Record<string, unknown>>) {
      const u = (it?.image ?? it?.url ?? it?.src) as unknown
      if (typeof u === 'string' && /^https?:\/\//.test(u)) out.push({ url: u, label: `${name}: ${String(it.caption ?? it.label ?? it.title ?? titel)}` })
    }
  }
  return out
}
function mediaBilder(m: any, label: string): Array<{ url: string; label: string }> {
  const out: Array<{ url: string; label: string }> = []
  if (m?.img) out.push({ url: m.img, label })
  return out
}
function photos(arr: any, label: string): Array<{ url: string; label: string }> {
  return Array.isArray(arr) ? arr.filter((p: any) => p?.url).map((p: any) => ({ url: p.url, label: `${label}: ${p.label ?? ''}` })) : []
}

/** Spiegel von webBlocks() (src/pages/deckWeb.tsx): Website-Stil nur bei
 *  deutschen Decks mit Projektseite, sonst klassische Blockfolge. */
function sichtbareAbschnitte(l: Lage): { web: boolean; abschnitte: Abschnitt[] } {
  const en = l.ctx?.lang === 'en' || l.lead?.language === 'en'
  const page = l.page
  const of = (t: string) => l.blocks.filter(b => b.type === t)
  const blk = (b: Block, name: string): Abschnitt => ({ name, text: texte(b).join(' | '), bilder: blockBilder(b, name), quelle: b.type === 'marina' ? 'system' : 'deck' })
  if (!page || en) {
    return { web: false, abschnitte: l.blocks.map((b, i) => {
      const a = blk(b, `Block ${i} (${String(b.type)})`)
      return b.type === 'marina' ? { ...a, bilder: [] } : a   // Marina-Modell ist Systembild
    }) }
  }
  const a: Abschnitt[] = []
  a.push({ quelle: 'seite', name: 'Titel', text: [page.kicker, page.h1, page.lead, page.usp_v, page.usp_k, of('cover')[0]?.forLine].filter(Boolean).join(' | '),
    bilder: page.hero?.img ? [{ url: page.hero.img, label: 'Titelbild' }] : [] })
  if (page.facts?.length) a.push({ quelle: 'seite', name: 'Kennzahlen', text: page.facts.map((f: string[]) => f.join(': ')).join(' | '), bilder: [] })
  of('letter').forEach(b => a.push(blk(b, 'Anschreiben')))
  of('unit').forEach(b => a.push(blk({ ...b, specs: (b.specs as string[] | undefined)?.filter(x => !/^\s*Bauträger\b/i.test(x)) }, `Wohnung ${String(b.number ?? '')}`)))
  of('floorplan').forEach(b => a.push(blk(b, 'Grundriss')))
  of('masterplan').forEach(b => a.push(blk(b, 'Lageplan')))
  of('video').filter(v => v.web).forEach(b => a.push(blk(b, 'Video')))
  if (page.day?.cards?.length) a.push({ quelle: 'seite', name: 'Tagesablauf', text: [page.day.title, page.day.intro, ...page.day.cards.map((c: any) => `${c.time} ${c.title}: ${c.text}`), page.day.film ? '⟪System: hier läuft der Lebensfilm des Projekts⟫' : ''].filter(Boolean).join(' | '), bilder: [] })
  if (page.home) a.push({ quelle: 'seite', name: page.home_label ? `Abschnitt ${page.home_label}` : 'Zuhause', text: texte(page.home).join(' | '), bilder: [...mediaBilder(page.home.media, 'Zuhause'), ...photos(page.home.photos, 'Zuhause')] })
  if (page.amen) a.push({ quelle: 'seite', name: 'Anlage', text: texte(page.amen).join(' | '), bilder: [...mediaBilder(page.amen.media, 'Anlage'), ...photos(page.amen.photos, 'Anlage')] })
  ;(page.more ?? []).forEach((m: any, i: number) => a.push({ quelle: 'seite', name: `Weiterer Abschnitt ${i + 1}`, text: texte(m).join(' | '), bilder: [...mediaBilder(m.media, m.title ?? 'Abschnitt'), ...photos(m.photos, m.title ?? 'Abschnitt')] }))
  if (page.options) a.push({ quelle: 'seite', name: 'Optionen', text: texte(page.options).join(' | '), bilder: [] })
  if (page.reasons?.length) a.push({ quelle: 'seite', name: 'Anleger-Gründe', text: [page.reasons_title, ...page.reasons.map((r: string[]) => r.join(': '))].filter(Boolean).join(' | '), bilder: [] })
  const f0 = of('facts')[0]
  if (page.loc) a.push({ quelle: 'seite', name: 'Lage', text: texte(page.loc).join(' | '), bilder: mediaBilder(page.loc.media, 'Lage') })
  else if (f0) a.push(blk(f0, 'Lage'))
  if (f0 && f0.mapLat != null && f0.mapLng != null) a.push({ quelle: 'deck', name: 'Karte', text: '⟪System: Karte mit Pin wird angezeigt⟫', bilder: [] })
  of('marina').forEach(b => a.push({ ...blk(b, 'Marina'), bilder: [], quelle: 'system' }))
  of('payment').forEach(b => a.push(blk(b, 'Zahlungsplan')))
  if (page.gallery?.length) a.push({ quelle: 'seite', name: 'Galerie', text: '', bilder: photos(page.gallery, 'Galerie') })
  if (page.spec?.length) a.push({ quelle: 'seite', name: 'Ausstattung', text: [page.spec_title, ...page.spec.map((s: string[]) => s.join(': '))].filter(Boolean).join(' | '), bilder: [] })
  of('inventory').forEach(b => a.push(blk(b, 'Inventar')))
  of('cta').forEach(b => a.push(blk(b, 'Abschluss')))
  return { web: true, abschnitte: a }
}

// ── Prüfer 1: Vollständigkeit (Code) ───────────────────────────────────────────

const istSvgHp = (u: string) => /\/deck-assets\/floorplans\/.+\.svg$/i.test(u.split('?')[0]) || /\/deck-assets\/floorplans\/hp\//i.test(u)
const normNr = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Wohnungen des Decks: aus deck_context, sonst (Pakete ohne Kontext) aus den
 *  Wohnungsblöcken, abgeglichen mit dem CRM. */
function deckUnits(l: Lage): Array<Record<string, any>> {
  const ctxU = (Array.isArray(l.ctx?.units) ? l.ctx!.units : []) as Array<Record<string, any>>
  if (ctxU.length) return ctxU
  const out: Array<Record<string, any>> = []
  for (const b of l.blocks.filter(x => x.type === 'unit')) {
    const nr = String(b.number ?? '').replace(/^(wohnung|apartment|villa|unit|nr\.?)\s*/i, '').trim()
    const u = l.units.find(x => normNr(x.unit_number) === normNr(nr)) ?? (l.deck.unit_id ? l.units.find(x => x.id === l.deck.unit_id) : undefined)
    if (u && !out.some(o => o.unitNumber === u.unit_number)) out.push({ unitNumber: u.unit_number, unitType: u.type, bedrooms: u.bedrooms, bathrooms: u.bathrooms, sizeSqm: u.size_sqm, terraceSqm: u.terrace_sqm, plotSqm: u.plot_sqm, floor: u.floor, netProperty: null, priceLines: [] })
  }
  return out
}

function pruefeVollstaendigkeit(l: Lage, sicht: { web: boolean; abschnitte: Abschnitt[] }): { befunde: Befund[]; checks: Array<{ label: string; ok: boolean }>; todo: string[] } {
  const B: Befund[] = []
  const checks: Array<{ label: string; ok: boolean }> = []
  const todo: string[] = []
  const of = (t: string) => l.blocks.filter(b => b.type === t)
  const add = (label: string, ok: boolean, f?: Omit<Befund, 'pruefer'>) => { checks.push({ label, ok }); if (!ok && f) B.push({ pruefer: 'vollstaendigkeit', ...f }) }
  const ctxUnits = deckUnits(l)
  const mitLead = !!l.deck.lead_id

  if (mitLead) {
    const letter = of('letter')[0]
    add('Persönliches Anschreiben', !!letter, { key: 'anschreiben_fehlt', severity: 'hoch', what: 'Das Deck hat kein persönliches Anschreiben.', fix: 'Im Deck-Chat ein kurzes Anschreiben an den Kunden ergänzen lassen.' })
    const vorname = String(l.deck.recipient_name || l.lead?.first_name || '').trim().split(/\s+/)[0]
    if (letter && vorname.length > 1) {
      const t = texte(letter).join(' ').toLowerCase()
      add('Kunde im Anschreiben mit Namen angesprochen', t.includes(vorname.toLowerCase()), { key: 'anschreiben_ohne_namen', severity: 'niedrig', what: `Das Anschreiben nennt den Kunden (${vorname}) nicht beim Namen.` })
    }
  }

  const unitBlocks = of('unit')
  add('Wohnungsseite vorhanden', unitBlocks.length > 0 || !ctxUnits.length, { key: 'wohnung_fehlt', severity: 'hoch', what: 'Es gibt keinen Abschnitt zur Wohnung selbst.' })
  const floorplans = of('floorplan')
  for (const cu of ctxUnits) {
    const nr = String(cu.unitNumber ?? '')
    const ub = unitBlocks.find(b => normNr(b.number).includes(normNr(nr)) || texte(b).join(' ').includes(nr)) ?? (unitBlocks.length === 1 && ctxUnits.length === 1 ? unitBlocks[0] : undefined)
    if (ub) add(`Preis für ${nr}`, Array.isArray(ub.priceLines) && ub.priceLines.length > 0 || !!l.deck.content?.page, { key: 'preis_fehlt', severity: 'hoch', where: `Wohnung ${nr}`, what: `Bei Wohnung ${nr} steht kein Preis.` })
    // Grundriss: Bild im Grundriss-Block, das zu dieser Wohnung gehört
    const fp = floorplans.find(b => normNr(texte(b).join(' ')).includes(normNr(nr))) ?? (floorplans.length === 1 && ctxUnits.length === 1 ? floorplans[0] : undefined)
    const fpUrl = typeof fp?.image === 'string' ? fp.image : (typeof cu.floorplanUrl === 'string' && fp ? cu.floorplanUrl : '')
    const crmU = l.units.find(u => normNr(u.unit_number) === normNr(nr))
    if (!fp || !fpUrl) {
      add(`Grundriss ${nr}`, false, { key: 'grundriss_fehlt', severity: 'kritisch', where: `Wohnung ${nr}`, what: `Für Wohnung ${nr} fehlt der Grundriss.`,
        fix: crmU?.hp_floorplan_url ? 'HP-Grundriss liegt im CRM. Deck neu erzeugen oder Grundriss im Deck-Chat einsetzen lassen.' : 'Erst HP-Grundriss zeichnen lassen (CI-SVG), dann Deck neu erzeugen.' })
      if (!crmU?.hp_floorplan_url) todo.push(`HP-Grundriss für Wohnung ${nr} zeichnen lassen`)
    } else {
      const hp = istSvgHp(fpUrl) || (!!crmU?.hp_floorplan_url && fpUrl === crmU.hp_floorplan_url)
      add(`Grundriss ${nr} im HP-Design`, hp, { key: 'grundriss_kein_hp', severity: 'kritisch', where: `Wohnung ${nr}`, what: `Der Grundriss von ${nr} ist kein HP-Grundriss (Bauträgerplan oder Übersicht).`, evidence: fpUrl.slice(-90), fix: 'Grundriss im HP-Design zeichnen lassen und einsetzen.' })
      if (!hp) todo.push(`HP-Grundriss für Wohnung ${nr} zeichnen lassen`)
    }
    // Aktualität gegen CRM
    if (crmU) {
      const weg = crmU.status === 'sold' || crmU.status === 'reserved' || crmU.property_id
      add(`Wohnung ${nr} noch verfügbar`, !weg, { key: 'wohnung_nicht_verfuegbar', severity: 'kritisch', where: `Wohnung ${nr}`, what: `Wohnung ${nr} ist laut CRM ${crmU.status === 'sold' ? 'verkauft' : 'reserviert/vergeben'}.`, fix: 'Nicht senden, andere Wohnung anbieten.' })
      const jetzt = Number(l.ctx?.furnitureMode === 'included' ? (crmU.price_net_furnished ?? crmU.price_net) : crmU.price_net)
      const damals = Number(cu.netProperty)
      if (jetzt > 0 && damals > 0 && !l.deck.content?.page) {
        const abw = Math.abs(jetzt - damals) / damals
        add(`Preis ${nr} aktuell`, abw < 0.005, { key: 'preis_veraltet', severity: 'hoch', where: `Wohnung ${nr}`, what: `Preis im Deck (${damals.toLocaleString('de-DE')} € netto) weicht vom CRM ab (${jetzt.toLocaleString('de-DE')} € netto).`, fix: 'Deck neu erzeugen, damit der aktuelle Preis drinsteht.' })
      }
    }
  }

  const f0 = of('facts')[0]
  const hatKoord = l.projekt?.latitude != null && l.projekt?.longitude != null
  const hatKarte = !!f0 && f0.mapLat != null && f0.mapLng != null
  add('Karte mit Lage', hatKarte, hatKoord
    ? { key: 'karte_fehlt', severity: 'hoch', what: 'Das Deck zeigt keine Karte, obwohl das Projekt Koordinaten hat.', fix: 'Deck neu erzeugen.' }
    : { key: 'karte_fehlt', severity: 'hoch', what: 'Keine Karte: Das Projekt hat im CRM keine Koordinaten.', fix: 'Koordinaten im Projekt eintragen, dann Deck neu erzeugen.' })
  if (!hatKoord) todo.push('Koordinaten im Projekt eintragen')
  add('Marina-Abschnitt', of('marina').length > 0, { key: 'marina_fehlt', severity: 'hoch', what: 'Der Marina-Abschnitt fehlt.', fix: 'Deck neu erzeugen (Marina setzt das System ein).' })

  const pay = of('payment')[0]
  const rows = (ph: unknown) => Array.isArray((ph as { rows?: unknown[] } | undefined)?.rows) ? (ph as { rows: unknown[] }).rows.length : 0
  const stufen = pay ? rows(pay.phase1) + rows(pay.phase2) : 0
  add('Zahlungsplan', !!pay && stufen >= 2, { key: 'zahlungsplan_fehlt', severity: 'hoch', what: 'Zahlungsplan fehlt oder ist leer.', fix: 'Zahlungsplan im Projekt hinterlegen, dann Deck neu erzeugen.' })
  if (pay && l.ctx?.completion) {
    const t = texte(pay).join(' ')
    add('Fertigstellung genannt', t.includes(String(l.ctx.completion)) || /fertigstell|completion|übergabe/i.test(t), { key: 'fertigstellung_fehlt', severity: 'mittel', what: `Die geplante Fertigstellung (${l.ctx.completion}) steht nicht im Zahlungsplan.` })
  }
  add('Abschluss mit nächstem Schritt', of('cta').length > 0, { key: 'abschluss_fehlt', severity: 'hoch', what: 'Es fehlt der Abschluss mit nächstem Schritt.' })

  const fotos = new Set(sicht.abschnitte.flatMap(a => a.bilder.map(b => b.url)).filter(u => !/\.svg(\?|$)/i.test(u)))
  add('Titelbild', sicht.abschnitte[0]?.bilder.length > 0 || !!of('cover')[0]?.image, { key: 'titelbild_fehlt', severity: 'hoch', what: 'Das Deck hat kein Titelbild.' })
  add('Genug Bilder (mind. 8)', fotos.size >= 8, { key: 'zu_wenig_bilder', severity: 'mittel', what: `Nur ${fotos.size} Fotos im Deck.`, fix: 'Mehr Projektbilder im Medien-Tab freigeben.' })
  const zaehl = new Map<string, number>()
  for (const a of sicht.abschnitte) for (const b of a.bilder) if (a.name !== 'Galerie' && !a.name.startsWith('Wohnung')) zaehl.set(b.url, (zaehl.get(b.url) ?? 0) + 1)
  const doppelt = [...zaehl.values()].filter(n => n > 1).length
  add('Keine doppelten Bilder', doppelt === 0, { key: 'bild_doppelt', severity: 'niedrig', what: `${doppelt} Bild(er) erscheinen mehrfach außerhalb der Galerie.` })

  const film = l.projekt?.deck_assets?.lebensfilm?.url || l.projekt?.own_video_url
  if (film) {
    const da = sicht.web ? !!l.page?.day?.film || of('video').some(v => v.web) : of('video').length > 0
    add('Video/Lebensfilm', da, { key: 'video_fehlt', severity: 'mittel', what: 'Das Projekt hat einen Film, das Deck zeigt ihn nicht.', fix: sicht.web ? 'Film in der Projektseite (page.day.film) hinterlegen.' : 'Deck neu erzeugen.' })
  }
  add('Website-Stil', sicht.web || l.ctx?.lang === 'en', { key: 'kein_website_stil', severity: 'mittel', what: 'Das Deck läuft im alten Stil, für das Projekt gibt es keine Projektseite (deck_assets.page).' })
  if (!sicht.web && l.ctx?.lang !== 'en') todo.push('Projektseite (Website-Stil) für das Projekt ablegen')
  if (l.ctx?.furnitureMode && l.ctx.furnitureMode !== 'none') {
    add('Ausstattung/Inventar', of('inventory').length > 0 || !!l.page?.spec?.length, { key: 'ausstattung_fehlt', severity: 'mittel', what: 'Möbelpaket gehört zum Angebot, aber das Deck zeigt keine Ausstattung.' })
  }
  return { befunde: B, checks, todo }
}

// ── Prüfer 2: Bilder (Vision) ────────────────────────────────────────────────────

const OBJ = '/storage/v1/object/public/'
function thumb(u: string): string {
  if (!u.includes(OBJ) || !/\.(jpe?g|png|webp)$/i.test(u.split('?')[0])) return u
  return u.split('?')[0].replace(OBJ, '/storage/v1/render/image/public/') + '?width=640&height=640&resize=contain&quality=70'
}
async function ladeBild(u: string): Promise<{ mime: string; b64: string } | null> {
  try {
    const r = await fetch(thumb(u), { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    const mime = (r.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes.length > 4_500_000) return null
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { mime, b64: btoa(bin) }
  } catch { return null }
}

const BEFUND_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'kurzer Schlüssel in snake_case' },
      severity: { type: 'string', enum: SEV_ENUM },
      what: { type: 'string', description: 'Ein Satz auf Deutsch: was ist falsch.' },
      where: { type: 'string', description: 'Abschnitt im Deck' },
      evidence: { type: 'string', description: 'Wörtliches Zitat aus dem Deck bzw. Bildbeschreibung' },
      fix: { type: 'string', description: 'Konkrete Korrektur als Anweisung, die man so in den Deck-Chat geben kann.' },
    },
    required: ['key', 'severity', 'what'],
  },
}
const PRUEFER_TOOL = (beschreibung: string) => ({
  name: 'emit_pruefung',
  description: beschreibung,
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100, description: 'Teilnote dieses Prüfbereichs' },
      befunde: BEFUND_SCHEMA,
      kurz: { type: 'string', description: 'Ein bis zwei Sätze Gesamteindruck.' },
    },
    required: ['score', 'befunde'],
  },
})
interface PrueferErgebnis { score: number | null; befunde: Befund[]; kurz?: string; fehler?: string }

/** Modelle liefern Arrays manchmal als JSON-Text statt als Array. */
function alsListe<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[]
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p as T[] : [] } catch { return [] } }
  return []
}

function deckTyp(l: Lage): string {
  const typen = new Set(deckUnits(l).map(u => String(u.unitType ?? '').toLowerCase()).filter(Boolean))
  return [...typen].join('/') || 'unbekannt'
}

async function pruefeBilder(l: Lage, sicht: { abschnitte: Abschnitt[] }): Promise<PrueferErgebnis> {
  const gesehen = new Set<string>()
  const liste: Array<{ url: string; label: string }> = []
  for (const a of sicht.abschnitte) for (const b of a.bilder) {
    if (gesehen.has(b.url) || /\.svg(\?|$)/i.test(b.url)) continue
    gesehen.add(b.url); liste.push(b)
  }
  const auswahl = liste.slice(0, MAX_BILDER)
  const geladen = await Promise.all(auswahl.map(b => ladeBild(b.url)))
  const content: Array<Record<string, unknown>> = []
  const befunde: Befund[] = []
  let n = 0
  auswahl.forEach((b, i) => {
    const im = geladen[i]
    if (!im) { befunde.push({ pruefer: 'bilder', key: 'bild_nicht_ladbar', severity: 'hoch', where: b.label, what: 'Ein Bild lädt nicht (Kunde sieht eine Lücke).', evidence: b.url.slice(-100) }); return }
    content.push({ type: 'text', text: `BILD ${n} – ${b.label}` })
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } })
    n++
  })
  if (!n) return { score: befunde.length ? 40 : null, befunde, kurz: 'Keine prüfbaren Fotos.' }
  content.push({ type: 'text', text: `Du prüfst die Fotos eines Verkaufsdecks für eine Immobilie auf Zypern (Wohnungstyp im Deck: ${deckTyp(l)}). Der Kunde ist ein deutscher Kapitalanleger. Melde je Bild NUR echte Probleme:
- falscher Wohnungstyp (Villa mit Privatpool in einem Apartment-Deck, Apartmentblock in einem Villa-Deck) = kritisch
- Werbegrafik mit Logo/Slogan/Text, Collage aus mehreren Fotos, Handy-Screenshot, Preisliste, Bauträgerplan als Foto = hoch
- Bild passt klar nicht zur Überschrift seines Abschnitts (Küche unter "Pool") = mittel
- unscharf, verzerrt, dunkel, Baustellenchaos, hässlich oder offensichtlich KI-generierter Innenraum = mittel
- dasselbe Motiv mehrfach fast identisch = niedrig
Reine Stimmungsbilder (Meer, Sonnenuntergang, Paphos) sind in Ordnung. Fehlende Innenbilder sind KEIN Befund (gibt es oft nicht, KI-Innenbilder sind verboten). Ein Außenrendering der Anlage bei einer Wohnung ist in Ordnung. Im Abschnitt Lageplan/Masterplan ist ein Plan richtig, melde dort nur Unlesbarkeit (mittel). Gib als score die Gesamtnote der Bildauswahl 0-100 (100 = jedes Bild stimmt und wirkt hochwertig). Nenne im Feld where die BILD-Nummer und den Abschnitt.` })
  const res = await callAnthropic(ANTHROPIC_API_KEY, {
    model: PRUEFER_MODELL, fallbackModels: FALLBACK, max_tokens: 2500,
    tools: [PRUEFER_TOOL('Ergebnis der Bildprüfung')], tool_choice: { type: 'tool', name: 'emit_pruefung' },
    messages: [{ role: 'user', content }], label: 'deck-review:bilder', attempts: 2,
  })
  if (!res.ok) return { score: null, befunde, fehler: res.error }
  const out = toolInput<{ score?: number; befunde?: Befund[]; kurz?: string }>(res)
  return { score: Number.isFinite(Number(out?.score)) && out?.score != null ? Number(out.score) : null, befunde: [...befunde, ...alsListe<Befund>(out?.befunde).map(b => ({ ...b, pruefer: 'bilder' }))], kurz: out?.kurz }
}

// ── Prüfer 3-5: Text ───────────────────────────────────────────────────────────

function deckText(sicht: { abschnitte: Abschnitt[] }): string {
  const q = { deck: 'nur dieses Deck', seite: 'Projektseite, gilt für alle Decks des Projekts', system: 'fester Systemtext, NICHT prüfen' }
  return sicht.abschnitte.map(a => `## ${a.name} [${q[a.quelle]}]\n${a.quelle === 'system' ? '(ausgelassen)' : a.text}`).join('\n\n').slice(0, 30000)
}
function faktenText(l: Lage): string {
  const units = deckUnits(l).map(u =>
    `Wohnung ${u.unitNumber}: Typ ${u.unitType ?? '?'}, ${u.bedrooms ?? '?'} Schlafzimmer, ${u.bathrooms || '?'} Bäder, ${u.sizeSqm ?? '?'} m² innen, Terrasse ${u.terraceSqm ?? '-'} m², Grundstück ${u.plotSqm ?? '-'} m², Etage ${u.floor ?? '?'}, Preis: ${(u.priceLines ?? []).map((p: any) => `${p.label} ${p.value}`).join('; ')}`).join('\n')
  const crm = deckUnits(l).map(u => l.units.find(x => normNr(x.unit_number) === normNr(u.unitNumber))).filter(Boolean)
    .map(u => `Wohnung ${u!.unit_number}: Typ ${u!.type ?? '?'}, ${u!.bedrooms ?? '?'} Schlafzimmer (0 = Studio), ${u!.bathrooms || '?'} Bäder, ${u!.size_sqm ?? '?'} m², Terrasse ${u!.terrace_sqm ?? '-'} m², Grundstück ${u!.plot_sqm ?? '-'} m², Nettopreis ${u!.price_net ?? '?'} €`).join('\n')
  const pay = l.ctx?.paymentSchedule ? JSON.stringify(l.ctx.paymentSchedule) : 'keiner hinterlegt'
  const facts = typeof l.projekt?.deck_assets?.facts === 'string' ? l.projekt.deck_assets.facts.slice(0, 14000) : ''
  return `PROJEKT: ${l.projekt?.name ?? l.ctx?.projectName ?? '?'} (${l.projekt?.location ?? ''}), Bauträger ${l.projekt?.developer ?? '?'}
FERTIGSTELLUNG: ${l.ctx?.completion ?? 'keine Angabe'}
MWST-MODUS: ${l.ctx?.vatMode ?? '?'} · MÖBEL: ${l.ctx?.furnitureMode ?? '?'} · AUSRICHTUNG (angle): ${l.deck.angle ?? '?'}
WOHNUNGEN IM DECK (Deck-Kontext beim Erzeugen):
${units || 'keine'}
WOHNUNGEN IM DECK (CRM aktuell, gilt vor den Projektfakten):
${crm || 'keine'}
ZAHLUNGSPLAN: ${pay}

PROJEKTFAKTEN (Import aus Bauträgerunterlagen; beschreiben das GANZE Projekt, Zahlen zu einzelnen Wohnungen können eine andere Wohnung meinen, dann gelten die Wohnungsdaten oben):
${facts}`
}

const SVENS_REGELN = `1. Keine Rendite im Deck: keine Mietrendite-Prozente, keine Rendite-/Wertsteigerungsversprechen für DIESES Objekt, keine erzielbaren Mieten als Zahl. Eine als Annahme gekennzeichnete Auslastung ist keine Rendite.
2. Kein Gedankenstrich (— oder –) im Fließtext. Normaler Bindestrich ist ok.
3. Echte Umlaute, nie "ue/oe/ae/ss" als Ersatz (Fehler: "fuer", "Kueche", "Groesse").
4. Kunde wird durchgängig geduzt (du/dein), nie gesiezt, kein Mischmasch.
5. Anlageobjekt zur Kurzzeitvermietung (Ausrichtung invest/kurzzeit) nicht als "Dein Zuhause" verkaufen, sondern als "Dein Investment"/Anlage, der Tag der Feriengäste statt "dein Tag".
6. Keine PR-Antragsgebühren / Permanent-Residency-Gebühren erwähnen.
7. "covered" heißt "überdacht", nie "gedeckt".
8. Happy Property bezeichnet sich nie als "Makler" oder "Maklerbüro".
9. Keine Druck-Verknappung ("nur noch wenige", "eine der letzten", "bevor sie jemand anderes nimmt", "ist sie weg"); die sachliche Gesamtzahl der Einheiten ("10 Villen", "Sonderkontingent von 10 Wohnungen") ist erlaubt, keine Garantien auf Miete/Auslastung, kein Weiterverkauf-/Exit-Narrativ, keine Schutz-Story beim Zahlungsplan ("du zahlst erst nach Fertigstellung").
10. Meer-/Strandnähe nur, wenn belegt: "direkt am Meer", "Meer vor der Tür" nur bei wenigen hundert Metern laut Fakten.
11. Ohne Möbel im Preis nie "schlüsselfertig", "voll möbliert", "im Kaufpreis enthalten".
12. Kein Hinweis auf KI, keine Platzhalter wie [Name], XXX, TODO, lorem. (Texte in ⟪…⟫ sind Hinweise des Prüfsystems, kein Deckinhalt.)
13. Wenn das Portfolio erwähnt wird: "gut 200 Objekte".

BEWUSST ERLAUBT (von Sven freigegeben, kein Verstoß):
- Hinweis auf beigefügte/verlinkte Berechnungen (ohne Kredit, mit Finanzierung, Saison, Verwaltungsgebühr in %, Steuersatz-Annahme). Die Zahlen stehen in der Berechnung, nicht im Deck.
- Vergleich mit dem Listenpreis einer vergleichbaren Wohnung derselben Anlage ("Du sparst X €").
- Anzahlung in % und als Betrag, "den Rest und die Fälligkeiten klären wir gemeinsam" (das ist keine Schutz-Story).
- Einbauküche, Einbauschränke, Klimaanlage, KNX sind feste Ausstattung, kein Möbel-/Einrichtungspaket; dafür braucht es keinen Inventar-Abschnitt.
- Bei Vorlagen (Empfänger "Vorlage ...") ist der allgemeine erste Absatz Platzhalter für den persönlichen Text.
Im Zweifel ist es KEIN Verstoß. Melde nur, was im Wortlaut klar gegen eine Regel verstößt.`

async function textPruefer(name: string, system: string, user: string, beschreibung: string): Promise<PrueferErgebnis> {
  const res = await callAnthropic(ANTHROPIC_API_KEY, {
    model: PRUEFER_MODELL, fallbackModels: FALLBACK, max_tokens: 3000, system,
    tools: [PRUEFER_TOOL(beschreibung)], tool_choice: { type: 'tool', name: 'emit_pruefung' },
    messages: [{ role: 'user', content: user }], label: `deck-review:${name}`, attempts: 2,
  })
  if (!res.ok) return { score: null, befunde: [], fehler: res.error }
  const out = toolInput<{ score?: number; befunde?: Befund[]; kurz?: string }>(res)
  return { score: Number.isFinite(Number(out?.score)) && out?.score != null ? Number(out.score) : null, befunde: alsListe<Befund>(out?.befunde).map(b => ({ ...b, pruefer: name })), kurz: out?.kurz }
}

function pruefeFakten(l: Lage, text: string): Promise<PrueferErgebnis> {
  return textPruefer('fakten',
    'Du bist Faktenprüfer für Immobilien-Verkaufsdecks von Happy Property (Zypern). Du vergleichst jede überprüfbare Aussage im Deck mit den Fakten aus dem CRM. Melde nur echte Widersprüche oder Behauptungen ohne Beleg (Zahlen, Flächen, Zimmer, Bäder, Etage, Preise, Raten, Fertigstellung, Entfernungen, Ausstattung, Pool/Gym/Spa, Garantien). Stil und Ton sind nicht dein Thema. Allgemeine Paphos-/Zypern-Aussagen und der Marina-Abschnitt sind kein Fehler. Fehlende Info ist kein Widerspruch. Lieber wenige sichere Befunde als viele vage. Preise, MwSt und Bruttopreise im Deck rechnet das System aus den Wohnungsdaten, sie sind richtig, solange sie zu den Wohnungsdaten oben passen. Unterscheide streng: WIDERSPRUCH zu den Fakten (kritisch = falscher Preis, falsche Fläche/Zimmerzahl, erfundene Garantie; hoch = andere falsche Zahl, falsches Ausstattungsmerkmal) gegenüber NICHT BELEGT (steht nirgends in den Fakten, widerspricht aber nichts): höchstens mittel. Abschnitte mit [fester Systemtext] nicht prüfen. Steht eine Zahl zu einer anderen Wohnung (Vergleichswohnung), prüfe sie gegen die Projektfakten nur, wenn dort genau diese Wohnung steht; sonst nicht melden.',
    `FAKTEN AUS DEM CRM:\n${faktenText(l)}\n\n=== DECK, WIE DER KUNDE ES SIEHT ===\n${text}`,
    'Ergebnis der Faktenprüfung. score: 100 = alles belegt und richtig.')
}

function pruefeRegeln(l: Lage, text: string): Promise<PrueferErgebnis> {
  const projekt = l.regeln.length ? `\n\nPROJEKT- UND DECK-REGELN AUS DEM CRM (ebenfalls verbindlich):\n${l.regeln.map(r => `- ${r}`).join('\n')}` : ''
  return textPruefer('regeln',
    `Du prüfst ein Verkaufsdeck von Happy Property gegen Svens feste Regeln. Melde jeden Verstoß mit wörtlichem Zitat (evidence). Nur echte Verstöße, keine Geschmacksfragen. Schwere: Regel 1, 9, 11 = kritisch; 5, 6, 8, 10, 12 und Projektregeln = hoch; 2, 3, 4, 7, 13 = mittel. Verstöße in Abschnitten [Projektseite] höchstens hoch und im Feld where mit \"Projektseite\" beginnen (wird dort für alle Decks korrigiert). Abschnitte mit [fester Systemtext] nicht prüfen.\n\nSVENS REGELN:\n${SVENS_REGELN}${projekt}`,
    `Ausrichtung des Decks (angle): ${l.deck.angle ?? 'unbekannt'}\n\n=== DECK ===\n${text}`,
    'Ergebnis der Regelprüfung. score: 100 = kein Verstoß.')
}

function pruefeKunde(l: Lage, text: string): Promise<PrueferErgebnis> {
  const kunde = l.lead ? `Kunde: ${l.deck.recipient_name || [l.lead.first_name, l.lead.last_name].filter(Boolean).join(' ')} (so hat Sven das Deck adressiert, der Name ist richtig, auch wenn das CRM anders schreibt). Notizen aus dem CRM: ${String(l.lead.notes ?? '').slice(0, 1500) || 'keine'}` : `Allgemeines Deck ohne bestimmten Kunden (Empfänger: ${l.deck.recipient_name ?? '-'})`
  return textPruefer('kunde',
    'Du liest ein Verkaufsdeck mit den Augen eines deutschsprachigen Kapitalanlegers (45-65 Jahre), der überlegt, auf Zypern zu kaufen. Bewerte: Versteht man in 30 Sekunden, was angeboten wird und was es kostet? Gibt es einen roten Faden? Geht das Deck auf den Kunden und seine Wünsche ein? Wiederholt es sich? Wirkt es hochwertig und vertrauenswürdig oder nach Massenware? Ist der nächste Schritt klar? Sprache: korrektes, natürliches Deutsch ohne Floskeln. Bewusste Entscheidungen von Sven, NICHT bemängeln: bei Vorlagen (Empfänger "Vorlage ...") der allgemeine erste Absatz, Anzahlung bezogen auf den Bruttopreis, keine Rendite- oder Mietzahlen im Deck (die kommen in einer eigenen Berechnung), Lage oder Bauträgername manchmal erst im Gespräch, Name des Empfängers auf der Titelseite (setzt Sven selbst), Systemtexte wie die Marina. Melde konkrete, behebbare Schwächen mit Zitat und einer Anweisung zur Verbesserung. hoch = Kunde versteht Angebot/Preis/nächsten Schritt nicht oder Deck passt nicht zum Kundenwunsch; mittel = deutliche Schwäche; niedrig = Feinschliff.',
    `${kunde}\n\n=== DECK ===\n${text}`,
    'Ergebnis aus Kundensicht. score: 100 = überzeugt sofort.')
}

// ── Chef ───────────────────────────────────────────────────────────────────────

const GEWICHT = { vollstaendigkeit: 25, bilder: 20, fakten: 25, regeln: 15, kunde: 15 } as const
type Kat = keyof typeof GEWICHT
const KAT_LABEL: Record<Kat, string> = { vollstaendigkeit: 'Vollständigkeit', bilder: 'Bilder', fakten: 'Fakten', regeln: 'Regeln', kunde: 'Kundensicht' }

function scoreVollst(b: Befund[]): number {
  let s = 100
  for (const f of b) s -= f.severity === 'kritisch' ? 35 : f.severity === 'hoch' ? 18 : f.severity === 'mittel' ? 7 : 2
  return Math.max(0, s)
}

async function chef(l: Lage, teil: Record<Kat, PrueferErgebnis>, gate: Befund[]): Promise<{ scores: Partial<Record<Kat, number>>; urteil?: string; top?: Array<{ text: string; chat?: string }>; verworfen?: number[]; fehler?: string }> {
  const alle = (Object.keys(teil) as Kat[]).flatMap(k => teil[k].befunde.map(b => ({ ...b, kat: k })))
  const liste = [...alle, ...gate.map(g => ({ ...g, kat: 'gate' }))].map((b, i) => `#${i} [${b.kat}/${b.severity}] ${b.what}${b.evidence ? ` | Zitat: ${b.evidence.slice(0, 200)}` : ''}${b.where ? ` | ${b.where}` : ''}`).join('\n')
  const noten = (Object.keys(teil) as Kat[]).map(k => `${KAT_LABEL[k]}: ${teil[k].score ?? 'ausgefallen'}${teil[k].kurz ? ` (${teil[k].kurz})` : ''}`).join('\n')
  const res = await callAnthropic(ANTHROPIC_API_KEY, {
    model: CHEF_MODELL, fallbackModels: FALLBACK, max_tokens: 2500,
    system: 'Du bist Chefredakteur bei Happy Property und gibst Sales Decks frei. Dein Team hat geprüft. Du entscheidest final: welche Befunde sind echt (offensichtliche Fehlalarme verwirfst du mit Nummer), welche Teilnote jede Kategorie verdient (du darfst die Noten der Prüfer korrigieren, begründet durch die Befunde), und was die wichtigsten Korrekturen sind, damit das Deck versandbereit wird (ab 85 Punkten). Schreib kurz, auf Deutsch, Sven duzen, kein Gedankenstrich.',
    tools: [{
      name: 'emit_urteil',
      description: 'Endurteil',
      input_schema: {
        type: 'object',
        properties: {
          scores: { type: 'object', properties: Object.fromEntries((Object.keys(GEWICHT) as Kat[]).map(k => [k, { type: 'integer', minimum: 0, maximum: 100 }])), required: Object.keys(GEWICHT) },
          verworfen: { type: 'array', items: { type: 'integer' }, description: 'Nummern der Befunde, die Fehlalarme sind' },
          urteil: { type: 'string', description: 'Zwei Sätze an Sven: Wie gut ist das Deck, was ist das Hauptproblem.' },
          top: { type: 'array', maxItems: 5, items: { type: 'object', properties: {
            text: { type: 'string', description: 'Was zu tun ist, ein Satz' },
            chat: { type: 'string', description: 'Fertige Anweisung für den Deck-Chat, falls per Chat behebbar, sonst leer' },
          }, required: ['text'] } },
        },
        required: ['scores', 'urteil', 'top'],
      },
    }],
    tool_choice: { type: 'tool', name: 'emit_urteil' },
    messages: [{ role: 'user', content: `Deck für ${l.deck.recipient_name ?? 'allgemein'}, Projekt ${l.projekt?.name ?? '?'}.\n\nTEILNOTEN DER PRÜFER:\n${noten}\n\nBEFUNDE:\n${liste || 'keine'}` }],
    label: 'deck-review:chef', attempts: 2,
  })
  if (!res.ok) return { scores: {}, fehler: res.error }
  const out = toolInput<{ scores?: Partial<Record<Kat, number>>; urteil?: string; top?: Array<{ text: string; chat?: string }>; verworfen?: number[] }>(res)
  const scores = typeof out?.scores === 'string' ? (() => { try { return JSON.parse(out.scores as unknown as string) } catch { return {} } })() : out?.scores ?? {}
  return { scores, urteil: out?.urteil, top: alsListe<{ text: string; chat?: string }>(out?.top), verworfen: alsListe<number>(out?.verworfen) }
}

// ── Ablauf ─────────────────────────────────────────────────────────────────────

async function pruefe(sb: Sb, token: string): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const l = await lade(sb, token)
  const sicht = sichtbareAbschnitte(l)
  const text = deckText(sicht)
  const voll = pruefeVollstaendigkeit(l, sicht)
  const [bilder, fakten, regeln, kunde] = await Promise.all([
    pruefeBilder(l, sicht), pruefeFakten(l, text), pruefeRegeln(l, text), pruefeKunde(l, text),
  ])
  const teil: Record<Kat, PrueferErgebnis> = {
    vollstaendigkeit: { score: scoreVollst(voll.befunde), befunde: voll.befunde },
    bilder, fakten, regeln, kunde,
  }
  // Offene rote Befunde des bestehenden Quality-Gates mitgeben (nur wenn das Gate lief)
  const qr = l.deck.quality_report as { findings?: Array<Record<string, any>> } | null
  const gate: Befund[] = l.deck.quality_status === 'red'
    ? (qr?.findings ?? []).filter(f => f.severity === 'kritisch' || f.severity === 'hoch').slice(0, 12)
        .map(f => ({ pruefer: 'gate', key: String(f.key), severity: f.severity as Sev, what: String(f.what ?? ''), evidence: f.evidence ? String(f.evidence) : undefined, fix: f.fix ? String(f.fix) : undefined }))
    : []

  const c = await chef(l, teil, gate)
  const alle = [...(Object.keys(teil) as Kat[]).flatMap(k => teil[k].befunde), ...gate]
  const verworfen = new Set(c.verworfen ?? [])
  // Vollständigkeit ist Code und nie ein Fehlalarm, der Chef darf sie nicht verwerfen.
  const gueltig = alle.filter((b, i) => !verworfen.has(i) || b.pruefer === 'vollstaendigkeit')
  gueltig.sort((a, b) => SEV_RANG[a.severity] - SEV_RANG[b.severity])

  const scores: Record<string, number | null> = {}
  let summe = 0, gew = 0
  for (const k of Object.keys(GEWICHT) as Kat[]) {
    const s = k === 'vollstaendigkeit' ? teil[k].score : (c.scores[k] ?? teil[k].score)
    scores[k] = s
    if (typeof s === 'number') { summe += s * GEWICHT[k]; gew += GEWICHT[k] }
  }
  let gesamt = gew ? Math.round(summe / gew) : 0
  const kritisch = gueltig.filter(b => b.severity === 'kritisch').length
  const hoch = gueltig.filter(b => b.severity === 'hoch').length
  if (kritisch) gesamt = Math.min(gesamt, 69)
  else if (hoch) gesamt = Math.min(gesamt, 84)
  const ausgefallen = (Object.keys(teil) as Kat[]).filter(k => teil[k].score == null && k !== 'vollstaendigkeit')
  if (ausgefallen.length) gesamt = Math.min(gesamt, 84)
  const verdict = kritisch ? 'nicht_senden' : gesamt >= SCHWELLE ? 'versandbereit' : 'nacharbeit'

  const review = {
    version: VERSION,
    score: gesamt,
    verdict,
    schwelle: SCHWELLE,
    urteil: c.urteil ?? null,
    scores,
    gewichte: GEWICHT,
    top: c.top ?? [],
    todo: voll.todo,
    checks: voll.checks,
    befunde: gueltig,
    verworfen: alle.filter((_, i) => verworfen.has(i) && alle[i].pruefer !== 'vollstaendigkeit').map(b => ({ pruefer: b.pruefer, what: b.what })),
    kurz: Object.fromEntries((Object.keys(teil) as Kat[]).map(k => [k, teil[k].kurz ?? null])),
    ausgefallen: [...ausgefallen, ...(c.fehler ? ['chef'] : [])],
    website_stil: sicht.web,
    content_hash: l.hash,
    dauer_ms: Date.now() - t0,
    reviewed_at: new Date().toISOString(),
  }
  const { error } = await sb.from('sales_decks').update({ review, review_score: gesamt, reviewed_at: review.reviewed_at }).eq('token', token)
  if (error) throw new Error(`DB: ${error.message}`)
  console.log(`[deck-review] ${token}: ${gesamt} (${verdict}), ${gueltig.length} Befunde, ${review.dauer_ms} ms`)
  return review
}

/** Decks der letzten 7 Tage mit Lead, deren Inhalt sich seit der letzten
 *  Prüfung geändert hat (oder nie geprüft). Höchstens 3 je Lauf. updated_at
 *  taugt dafür nicht (kein Trigger, Patches setzen es nicht), deshalb Hash. */
async function faellige(sb: Sb): Promise<string[]> {
  const seit = new Date(Date.now() - 7 * 864e5).toISOString()
  const { data } = await sb.from('sales_decks')
    .select('token, content, review')
    .not('lead_id', 'is', null).eq('status', 'ready').gte('created_at', seit)
    .order('created_at', { ascending: false }).limit(40)
  const out: string[] = []
  for (const d of (data ?? []) as Array<Record<string, any>>) {
    if (!Array.isArray(d.content?.blocks) || !d.content.blocks.length) continue
    if (d.review?.version === VERSION && d.review?.content_hash === await sha(JSON.stringify(d.content))) continue
    out.push(d.token)
    if (out.length >= 3) break
  }
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const denied = await gateCaller(req, 'deck-review', { service: true, roles: ['admin', 'verwalter', 'mitarbeiter'] }, CORS)
  if (denied) return denied
  try {
    const body = await req.json().catch(() => ({})) as { token?: string; action?: string; force?: boolean; wait?: boolean }
    const sb = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (body.action === 'faellige') {
      const tokens = await faellige(sb)
      const lauf = async () => {
        for (const t of tokens) {
          try { await pruefe(sb, t) } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.warn(`[deck-review] ${t} fehlgeschlagen:`, msg)
            // Fehlschlag merken, sonst greift der Cron dasselbe Deck alle 10 Min erneut
            const { data: d } = await sb.from('sales_decks').select('content').eq('token', t).maybeSingle()
            const hash = await sha(JSON.stringify((d as { content?: unknown } | null)?.content ?? null))
            const jetzt = new Date().toISOString()
            await sb.from('sales_decks').update({ review: { version: VERSION, content_hash: hash, fehler: msg.slice(0, 500), reviewed_at: jetzt }, review_score: null, reviewed_at: jetzt }).eq('token', t)
          }
        }
      }
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) { EdgeRuntime.waitUntil(lauf()); return json({ ok: true, background: true, tokens }) }
      await lauf()
      return json({ ok: true, tokens })
    }

    if (!body.token) return json({ error: 'token fehlt' }, 400)
    if (body.wait) return json({ ok: true, review: await pruefe(sb, body.token) })
    // Standard: im Hintergrund prüfen (dauert 40-90 s), CRM pollt reviewed_at
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(pruefe(sb, body.token).catch(e => console.error('[deck-review] fehlgeschlagen:', e instanceof Error ? e.message : String(e))))
      return json({ ok: true, background: true })
    }
    return json({ ok: true, review: await pruefe(sb, body.token) })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
