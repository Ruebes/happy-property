// Edge Function: developer-briefing — Kunden-Briefing für den Bauträger-Mitarbeiter.
//
// Sven 27.10.2026: Wenn ein Termin mit einem Kunden UND einem Bauträger-Kontakt
// angelegt wird, bekommt der Bauträger zusätzlich zur normalen Einladung eine
// WhatsApp: wer kommt (Kundenname) + Link auf eine Briefing-Seite mit allem, was
// wir über den Kunden wissen und ihm gesagt haben. Layout = das freigegebene
// Briefing Aaron/Eva Hahn (template.ts), Sprache = crm_developer_contacts.language.
//
// Aufruf: POST { appointment_id, dry_run? }
//   → antwortet sofort { ok, queued }, die Arbeit (KI ca. 1-2 Min) läuft per
//     EdgeRuntime.waitUntil weiter. dry_run: Seite bauen, nichts senden.
// Je Termin + Bauträger-Kontakt genau EINE Seite (shared_pages.note =
// "developer_briefing:<appt>:<kontakt>"). Erneuter Aufruf (Termin bearbeitet)
// aktualisiert die Seite, schickt aber keine zweite WhatsApp.
//
// Secrets: ANTHROPIC_API_KEY
// Deployment: supabase functions deploy developer-briefing --no-verify-jwt
// Aufrufer: AppointmentModal (Nutzer-JWT, Recht pipeline/contacts wie personalize-invite).

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'
import { BRIEFING_CSS } from './template.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const PORTAL = 'https://portal.happy-property.com'
const LOGO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
const SVEN_TEL = '+35795096409'
const SVEN_TEL_DISP = '+357 95 09 64 09'
const MODELL = 'claude-sonnet-5-5'
const FALLBACK = ['claude-opus-5-5', 'claude-sonnet-4-6']

type Lang = 'de' | 'en'
type Row = Record<string, unknown>

// ── Feste Texte je Sprache (der Rest kommt von der KI in Zielsprache) ─────────
const L = {
  de: {
    title: 'Kunden-Briefing', for: 'Für', from: 'Von', when: 'Termin',
    short: 'Kurzfassung', shortSub: '2 Minuten', full: 'Ausführlich', fullSub: 'alles, was wir wissen und gesagt haben',
    call: 'Sven anrufen', callSub: 'bei Fragen vor dem Termin',
    whoComes: 'Wer kommt', glance: 'Auf einen Blick', whatWeSee: 'Was wir uns ansehen', props: 'Die Objekte',
    before: 'Bevor der Kunde kommt', good: 'Gut zu wissen', howTalk: 'Wie der Kunde tickt', knows: 'Was der Kunde schon hat',
    s1: 'Kunde', s2: 'Objekte', s3: 'Verkaufsaussagen', s3h: 'Was dem Kunden gesagt wurde', s4: 'Berechnung',
    s5: 'Unterlagen', s5h: 'Was der Kunde bekommen hat', s6: 'Verlauf', s6h: 'Unser Kontakt bisher', s7: 'Nächste Schritte', s7h: 'Offene Punkte',
    thUnit: 'Objekt', thType: 'Typ und Lage', thSize: 'Fläche', thList: 'Listenpreis', thPrice: 'Preis', thCalc: 'Berechnung', view: 'ansehen →',
    thAssume: 'Annahme', thValue: 'Wert', openDeck: 'Unterlagen öffnen →', event: 'Ereignis',
    conf: (dev: string) => `<b>Vertraulich.</b> Von Happy Property für ${dev}, nur für diesen Termin. Bitte nicht weiterleiten.`,
    questions: 'Fragen', version: 'Version',
  },
  en: {
    title: 'Client briefing', for: 'For', from: 'From', when: 'Appointment',
    short: 'Short version', shortSub: '2 minutes', full: 'Full briefing', fullSub: 'everything we know and said',
    call: 'Call Sven', callSub: 'questions before the meeting',
    whoComes: 'Who is coming', glance: 'At a glance', whatWeSee: 'What we look at', props: 'The properties',
    before: 'Before the client arrives', good: 'Good to know', howTalk: 'How to talk to the client', knows: 'What the client already has',
    s1: 'Client', s2: 'Properties', s3: 'Sales messages', s3h: 'What the client has been told', s4: 'Calculation',
    s5: 'Documents', s5h: 'What the client received', s6: 'Conversation', s6h: 'Our conversation so far', s7: 'Next steps', s7h: 'Open points',
    thUnit: 'Unit', thType: 'Type and floor', thSize: 'Size', thList: 'List price', thPrice: 'Price', thCalc: 'Calculation', view: 'view →',
    thAssume: 'Assumption', thValue: 'Value', openDeck: 'Open documents →', event: 'Event',
    conf: (dev: string) => `<b>Confidential.</b> Prepared by Happy Property for ${dev} for this appointment only. Please do not forward.`,
    questions: 'Questions', version: 'Version',
  },
} as const

// ── Inhalt, den die KI liefert ─────────────────────────────────────────────────
interface Briefing {
  hero_eyebrow: string
  hero_lead: string
  chips: Array<{ text: string; positive?: boolean }>
  glance: Array<{ label: string; value: string; text: string }>
  cards: Array<{ tag: string; eyebrow: string; title: string; specs: string[]; bullets: string[]; price_label: string; price: string; price_compare?: string; price_note?: string; image_index?: number }>
  keys: Array<{ title: string; text: string }>
  how_to_talk: string
  already_has: string
  profile_heading: string
  profile: string[]
  units_heading?: string
  units_intro?: string
  units?: Array<{ name: string; type: string; size: string; list_price?: string; price: string; calc_token?: string }>
  units_note?: string
  told: Array<{ eyebrow: string; title: string; bullets: string[] }>
  calc?: { heading: string; kpis: Array<{ value: string; label: string }>; rows: Array<{ label: string; value: string }>; note?: string }
  decks: Array<{ date: string; title: string; text: string; token: string }>
  chat_intro: string
  chat: Array<{ day?: string; kind: 'customer' | 'sven' | 'event'; who?: string; channel?: string; text: string; more?: string }>
  next: Array<{ who: string; mine?: boolean; text: string }>
}

const TOOL = {
  name: 'emit_briefing',
  description: 'Das fertige Briefing in der Zielsprache.',
  input_schema: {
    type: 'object',
    required: ['hero_eyebrow', 'hero_lead', 'chips', 'glance', 'cards', 'keys', 'how_to_talk', 'already_has', 'profile_heading', 'profile', 'told', 'decks', 'chat_intro', 'chat', 'next'],
    properties: {
      hero_eyebrow: { type: 'string', description: 'z.B. "Kunden-Briefing · Besichtigung Flora Panorama, Chloraka"' },
      hero_lead: { type: 'string', description: '1-2 Sätze: wer der Kunde ist und was er will' },
      chips: { type: 'array', maxItems: 3, items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, positive: { type: 'boolean', description: 'true = grüner Punkt (gutes Signal)' } } } },
      glance: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'object', required: ['label', 'value', 'text'], properties: { label: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' } } } },
      cards: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', required: ['tag', 'eyebrow', 'title', 'specs', 'bullets', 'price_label', 'price'], properties: {
        tag: { type: 'string' }, eyebrow: { type: 'string' }, title: { type: 'string' },
        specs: { type: 'array', items: { type: 'string' } }, bullets: { type: 'array', items: { type: 'string' } },
        price_label: { type: 'string' }, price: { type: 'string' }, price_compare: { type: 'string' }, price_note: { type: 'string' },
        image_index: { type: 'integer', description: 'Nummer aus BILDER' } } } },
      keys: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'object', required: ['title', 'text'], properties: { title: { type: 'string' }, text: { type: 'string' } } } },
      how_to_talk: { type: 'string' }, already_has: { type: 'string' },
      profile_heading: { type: 'string', description: 'z.B. "Wer Eva ist"' },
      profile: { type: 'array', minItems: 2, items: { type: 'string' } },
      units_heading: { type: 'string' }, units_intro: { type: 'string' }, units_note: { type: 'string' },
      units: { type: 'array', items: { type: 'object', required: ['name', 'type', 'size', 'price'], properties: {
        name: { type: 'string' }, type: { type: 'string' }, size: { type: 'string' }, list_price: { type: 'string' }, price: { type: 'string' },
        calc_token: { type: 'string', description: 'Token einer Berechnung aus den Daten, sonst weglassen' } } } },
      told: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['eyebrow', 'title', 'bullets'], properties: { eyebrow: { type: 'string' }, title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } } } },
      calc: { type: 'object', required: ['heading', 'kpis', 'rows'], properties: {
        heading: { type: 'string' }, note: { type: 'string' },
        kpis: { type: 'array', maxItems: 4, items: { type: 'object', required: ['value', 'label'], properties: { value: { type: 'string' }, label: { type: 'string' } } } },
        rows: { type: 'array', items: { type: 'object', required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } } } } },
      decks: { type: 'array', items: { type: 'object', required: ['date', 'title', 'text', 'token'], properties: { date: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, token: { type: 'string' } } } },
      chat_intro: { type: 'string' },
      chat: { type: 'array', items: { type: 'object', required: ['kind', 'text'], properties: {
        day: { type: 'string', description: 'nur beim ersten Eintrag eines neuen Tages, z.B. "24. Oktober"' },
        kind: { type: 'string', enum: ['customer', 'sven', 'event'] }, who: { type: 'string' }, channel: { type: 'string' },
        text: { type: 'string', description: 'Absätze mit Leerzeile trennen' }, more: { type: 'string', description: 'Rest einer langen Mail (aufklappbar)' } } } },
      next: { type: 'array', items: { type: 'object', required: ['who', 'text'], properties: { who: { type: 'string' }, mine: { type: 'boolean', description: 'true = Aufgabe von Sven oder Kunde (grau), false = Bauträger/vor Ort (korall)' }, text: { type: 'string' } } } },
    },
  },
}

// ── Hilfen ─────────────────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
const paras = (s: string) => s.split(/\n{2,}/).map(p => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('')
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '')
const clip = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + ' …' : t }

/** Deck-Inhalt ohne Bild-/Technikfelder, für den Prompt. */
function deckText(content: unknown): string {
  const drop = new Set(['image', 'images', 'video', 'videoUrl', 'poster', 'imageIntent', 'icon', 'mapUrl', 'mapLat', 'mapLng', 'src', 'svg', 'url', 'drive'])
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (v && typeof v === 'object') {
      const o: Row = {}
      for (const [k, x] of Object.entries(v as Row)) if (!drop.has(k)) o[k] = strip(x)
      return o
    }
    return typeof v === 'string' ? v.replace(/<[^>]+>/g, '') : v
  }
  return JSON.stringify(strip(content))
}

function deckImages(content: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (/^https:\/\/\S+\.(jpe?g|png|webp)$/i.test(v) && !/brand\/|floorplan|grundriss/i.test(v)) out.push(v); return }
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') Object.values(v as Row).forEach(walk)
  }
  walk(content)
  return [...new Set(out)]
}

function fmtWhen(iso: string, tz: string, lang: Lang): string {
  const d = new Date(iso)
  const loc = lang === 'en' ? 'en-GB' : 'de-DE'
  const day = new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(d)
  const hm = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d)
  return lang === 'en' ? `${day}, ${hm}` : `${day}, ${hm} Uhr`
}

// ── Daten sammeln ──────────────────────────────────────────────────────────────
async function sammeln(sb: SupabaseClient, leadId: string) {
  const [lead, acts, calls, decks, deals, ai] = await Promise.all([
    sb.from('leads').select('*').eq('id', leadId).maybeSingle(),
    sb.from('activities').select('created_at, type, direction, subject, content, auto').eq('lead_id', leadId).order('created_at', { ascending: true }).limit(300),
    sb.from('call_summaries').select('started_at, source, notiz, fakten, briefing').eq('lead_id', leadId).order('started_at', { ascending: true }).limit(20),
    sb.from('sales_decks').select('token, created_at, angle, project_id, content, deck_context').eq('lead_id', leadId).order('created_at', { ascending: true }).limit(8),
    sb.from('deals').select('phase, developer, registration_notes, finanzierung_de_notes, finanzierung_cy_notes, immobilien_notes, kaufvertrag_notes, reservation_notes').eq('lead_id', leadId).limit(5),
    sb.from('lead_ai_summaries').select('summary').eq('lead_id', leadId).maybeSingle(),
  ])
  const deckRows = (decks.data ?? []) as Row[]
  const calcTokens = new Set<string>()
  for (const d of deckRows) for (const m of JSON.stringify(d.content ?? {}).matchAll(/rechnung\/([0-9a-f]{12,})/g)) calcTokens.add(m[1])
  const calcs = calcTokens.size
    ? ((await sb.from('property_calculations').select('token, title, content').in('token', [...calcTokens])).data ?? []) as Row[]
    : []
  const projIds = [...new Set(deckRows.map(d => d.project_id).filter(Boolean))] as string[]
  const projects = projIds.length ? ((await sb.from('crm_projects').select('id, name, location').in('id', projIds)).data ?? []) as Row[] : []
  const units = projIds.length
    ? ((await sb.from('crm_project_units').select('id, project_id, unit_number, property_id').in('project_id', projIds).limit(500)).data ?? []) as Row[]
    : []
  const { data: soldDeals } = units.length ? await sb.from('deals').select('unit_id').not('unit_id', 'is', null).limit(2000) : { data: [] }
  return { lead: lead.data as Row | null, acts: (acts.data ?? []) as Row[], calls: (calls.data ?? []) as Row[], decks: deckRows, deals: (deals.data ?? []) as Row[], ai: (ai.data as Row | null)?.summary ?? null, calcs, projects, units, soldDeals: (soldDeals ?? []) as Row[] }
}

// ── KI ─────────────────────────────────────────────────────────────────────────
async function erzeugen(key: string, d: Awaited<ReturnType<typeof sammeln>>, ctx: { lang: Lang; devName: string; contactName: string; apptTitle: string; when: string; location: string; images: string[] }): Promise<Briefing> {
  const lead = d.lead ?? {}
  const kunde = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim()
  const verlauf = d.acts.map(a => `[${String(a.created_at).slice(0, 16)}] ${a.type}/${a.direction}${a.auto ? '/automatisch' : ''} · ${clip(a.subject, 120)}\n${clip(a.content, 1800)}`).join('\n\n').slice(-60000)
  const gespraeche = d.calls.map(c => `[${String(c.started_at).slice(0, 16)}] ${c.source}\nNotiz: ${clip(c.notiz, 2500)}\nFakten: ${clip(JSON.stringify(c.fakten ?? ''), 2500)}`).join('\n\n')
  const decks = d.decks.map(x => `DECK token=${x.token} vom ${String(x.created_at).slice(0, 10)} (angle ${x.angle}):\n${clip(deckText(x.content), 14000)}`).join('\n\n')
  const calcs = d.calcs.map(c => `BERECHNUNG token=${c.token} "${c.title}": ${clip(JSON.stringify((c.content as Row)?.items ?? c.content), 2500)}`).join('\n')
  const soldIds = new Set(d.soldDeals.map(s => s.unit_id))
  const frei = d.units.filter(u => !u.property_id && !soldIds.has(u.id)).map(u => u.unit_number)
  const deals = d.deals.map(x => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([, v]) => v != null && v !== '')))).join('\n')
  const leadInfo = Object.fromEntries(Object.entries(lead).filter(([k, v]) => v != null && v !== '' && !/^(fbc|fbp|client_|booking_token|meta_|utm_term|id$|created_by)/.test(k)))

  const sys = `Du schreibst für Sven (Happy Property, Immobilienvermittlung auf Zypern für deutschsprachige Käufer) ein Kunden-Briefing für einen Mitarbeiter des Bauträgers vor einem gemeinsamen Termin. Der Bauträger kennt vom Kunden bisher nur den Namen. Nach dem Briefing soll er wissen: wer kommt, was der Kunde will, was wir ihm gezeigt und gesagt haben, und worauf er achten muss.

SPRACHE: Alles auf ${ctx.lang === 'en' ? 'ENGLISCH (Zahlen im englischen Format, z.B. €150,000; Chat-Nachrichten übersetzen)' : 'DEUTSCH, echte Umlaute (ä ö ü ß), nie ae/oe/ue'}. Den Bauträger-Mitarbeiter ${ctx.lang === 'en' ? 'neutral ansprechen' : 'duzen ("eure Preisliste"), sparsam ansprechen'}.

REGELN:
- NICHTS erfinden. Nur was in den Daten steht.
- Was der Kunde WILL (Kapitalanlage oder eigene Nutzung, Budget, Finanzierung, Zeitplan), kommt NUR aus seinen eigenen Nachrichten, Gesprächsnotizen, Fragebogen-Antworten oder Svens Notizen. Inhalt und Ausrichtung der Unterlagen zeigen, was WIR geschickt haben, nicht was der Kunde will. Steht dazu nichts da: "noch nicht besprochen".
- Widersprüche in unseren Unterlagen (z.B. zwei verschiedene Entfernungen) im Abschnitt keys benennen, nicht still eine Zahl wählen.
- Kurz und klar wie ein Kollege, der in 2 Minuten brieft: glance.value höchstens 4 Wörter, glance.text 1 Satz, cards.bullets höchstens 3 kurze Punkte (keine Wohnungsliste, die steht in units), keys je 1-2 Sätze, profile 2-4 Absätze. Unbekanntes klar als offen benennen ("noch nicht besprochen"). Selbstauskünfte als solche kennzeichnen ("Selbstauskunft, noch nicht geprüft").
- Zahlen (Preise, Flächen) exakt aus den Daten übernehmen, nie runden oder rechnen.
- Weglassen: interne Nachrichten an Mitarbeiter (Burkhard, Ioulia, "Intern an", "Kontakt übergeben"), Registrierungs-Aufgaben, Lotte-Interna, automatische Erinnerungen und Bot-Nachfass, Ausweis/Lohn/Steuerbescheide, Drive-Uploads, Tracking-Daten.
- Keine Kontaktdaten des Kunden (Telefon, E-Mail, Adresse) ins Briefing.
- Konkurrenz-Bauträger oder andere Projekte anderer Bauträger nur anonym ("ein anderer Bauträger").
- Keine Gedankenstriche (— oder –) im Text. Spannen mit \"bis\" (150.000 bis 165.000 €), sonst normaler Bindestrich.
- Chat: alle PERSÖNLICHEN Nachrichten zwischen Kunde und Sven chronologisch (WhatsApp, Mail), kurze Ereignis-Zeilen (kind=event) für Unterlagen-Versand, Termine, Gespräche. Lange Mails: Anfang in text, Rest in more. Kurz aufeinanderfolgende Nachrichten derselben Person dürfen in einen Eintrag.
- cards: 1-2 Karten zu den Objekten, um die es im Termin geht (bei vielen Wohnungen sinnvoll gruppieren). image_index aus BILDER wählen.
- units: wenn der Kunde mehrere konkrete Einheiten bekommen hat, alle als Tabelle (calc_token nur aus den Daten). Verfügbarkeit nur nennen, wenn sie aus FREIE EINHEITEN hervorgeht.
- keys: was der Bauträger vor dem Termin wissen muss (Erwartungen des Kunden, Zusagen, Konditionen, Widersprüche in den Unterlagen, Preis-/Rabattfragen an Sven verweisen).
- next: offene Punkte, wer was tut.
- calc nur, wenn es Berechnungen gibt: Annahmen (Nachtpreis, Auslastung, Verwaltung, MwSt, Steuer, Steigerungen), keine selbst gerechneten Ergebnisse.
- decks: jede Unterlage mit token aus den Daten.
Gib NUR das Tool emit_briefing zurück.`

  const usr = `TERMIN: ${ctx.apptTitle} · ${ctx.when}${ctx.location ? ` · ${ctx.location}` : ''}
FÜR: ${ctx.contactName}, ${ctx.devName} (Bauträger)
KUNDE: ${kunde}

KUNDENDATEN (CRM):
${JSON.stringify(leadInfo)}
${d.ai ? `\nKI-ZUSAMMENFASSUNG:\n${clip(d.ai, 3000)}\n` : ''}
DEALS:
${deals || 'keine'}

PROJEKTE: ${d.projects.map(p => `${p.name} (${p.location ?? ''})`).join(', ') || 'keine'}
FREIE EINHEITEN laut CRM: ${frei.join(', ') || 'unbekannt'}

GESPRÄCHE (Zoom/Telefon):
${gespraeche || 'keine'}

VERLAUF (Aktivitäten, chronologisch):
${verlauf || 'keiner'}

UNTERLAGEN:
${decks || 'keine'}

${calcs}

BILDER:
${ctx.images.map((u, i) => `${i}: ${u.split('/').pop()}`).join('\n') || 'keine'}`

  const res = await callAnthropic(key, {
    model: MODELL, fallbackModels: FALLBACK, max_tokens: 16000, system: sys,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'emit_briefing' },
    messages: [{ role: 'user', content: usr }], label: 'developer-briefing', attempts: 2,
  })
  const out = res.ok ? toolInput<Briefing>(res) : null
  if (!out) throw new Error(`KI: ${res.error ?? 'kein Ergebnis'}`)
  // Das Modell liefert verschachtelte Felder gelegentlich als JSON-String
  // (Testlauf 27.10.: glance kam so, die Kacheln blieben leer).
  for (const [k, v] of Object.entries(out as unknown as Row)) {
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      try { (out as unknown as Row)[k] = JSON.parse(v) } catch { console.warn(`[developer-briefing] Feld ${k} kein gültiges JSON`) }
    }
  }
  return ohneGedankenstrich(out, ctx.lang)
}

/** Svens Regel: nie — oder –. Zahlenspannen werden "bis"/"to", sonst Komma. */
function ohneGedankenstrich<T>(v: T, lang: Lang): T {
  const bis = lang === 'en' ? ' to ' : ' bis '
  const fix = (s: string) => s.replace(/(\d)\s*[–—]\s*(\d)/g, `$1${bis}$2`).replace(/\s*[–—]\s*/g, ', ')
  const walk = (x: unknown): unknown => typeof x === 'string' ? fix(x) : Array.isArray(x) ? x.map(walk)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Row).map(([k, y]) => [k, walk(y)])) : x
  return walk(v) as T
}

// ── HTML ───────────────────────────────────────────────────────────────────────
function rendern(b: Briefing, x: { lang: Lang; kunde: string; contactName: string; devName: string; when: string; images: string[]; tokens: { decks: Set<string>; calcs: Set<string> } }): string {
  const t = L[x.lang]
  const img = (i?: number) => x.images[i ?? 0] ?? x.images[0] ?? ''
  const today = new Intl.DateTimeFormat(x.lang === 'en' ? 'en-GB' : 'de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Nicosia' }).format(new Date())
  const arr = <T,>(a: T[] | undefined) => Array.isArray(a) ? a : []

  const glance = arr(b.glance).map(g => `<div class="tile"><div class="eyebrow">${esc(g.label)}</div><div class="v">${esc(g.value)}</div><p>${esc(g.text)}</p></div>`).join('\n      ')
  const cards = arr(b.cards).map(c => `<article class="proj">
        <div class="img" style="background-image:url('${esc(img(c.image_index))}')"><span class="tag">${esc(c.tag)}</span></div>
        <div class="body">
          <div><div class="eyebrow">${esc(c.eyebrow)}</div><h3>${esc(c.title)}</h3></div>
          <div class="specs">${arr(c.specs).map(s => `<span>${esc(s)}</span>`).join('')}</div>
          <ul>${arr(c.bullets).map(s => `<li>${esc(s)}</li>`).join('')}</ul>
          <div class="price">
            <div><div class="lbl">${esc(c.price_label)}</div><div class="big">${esc(c.price)}</div></div>
            <div style="text-align:right">${c.price_compare ? `<s>${esc(c.price_compare)}</s>` : ''}${c.price_note ? `<div class="muted" style="font-size:12px">${esc(c.price_note)}</div>` : ''}</div>
          </div>
        </div>
      </article>`).join('\n      ')
  const keys = arr(b.keys).map(k => `<div class="key"><b>${esc(k.title)}</b> ${esc(k.text)}</div>`).join('\n      ')
  const units = arr(b.units)
  const unitsHtml = units.length ? `<section class="block">
    <div class="eyebrow">2 · ${t.s2}</div>
    <h2>${esc(b.units_heading ?? t.props)}</h2>
    ${b.units_intro ? `<p class="muted" style="margin:-8px 0 14px;font-size:13px">${esc(b.units_intro)}</p>` : ''}
    <table class="stack">
      <tr class="h"><th>${t.thUnit}</th><th>${t.thType}</th><th>${t.thSize}</th><th>${t.thList}</th><th>${t.thPrice}</th><th>${t.thCalc}</th></tr>
${units.map(u => `      <tr><td class="n">${esc(u.name)}</td><td data-label="${t.thType}">${esc(u.type)}</td><td data-label="${t.thSize}">${esc(u.size)}</td><td data-label="${t.thList}">${u.list_price ? `<s>${esc(u.list_price)}</s>` : '-'}</td><td data-label="${t.thPrice}"><b>${esc(u.price)}</b></td><td data-label="${t.thCalc}">${u.calc_token && x.tokens.calcs.has(u.calc_token) ? `<a href="${PORTAL}/rechnung/${u.calc_token}?preview=1" target="_blank" rel="noopener">${t.view}</a>` : '-'}</td></tr>`).join('\n')}
    </table>
    ${b.units_note ? `<p class="muted" style="font-size:12.5px;margin:10px 2px 0">${esc(b.units_note)}</p>` : ''}
  </section>` : ''
  const told = arr(b.told).map(o => `<div class="tile"><div class="eyebrow">${esc(o.eyebrow)}</div><h3>${esc(o.title)}</h3><ul>${arr(o.bullets).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`).join('\n      ')
  const calc = b.calc && arr(b.calc.rows).length ? `<section class="block">
    <div class="eyebrow">4 · ${t.s4}</div>
    <h2>${esc(b.calc.heading)}</h2>
    ${arr(b.calc.kpis).length ? `<div class="kpis">${arr(b.calc.kpis).map(k => `<div class="kpi"><div class="v">${esc(k.value)}</div><div class="l">${esc(k.label)}</div></div>`).join('')}</div>` : ''}
    <table>
      <tr><th style="width:45%">${t.thAssume}</th><th>${t.thValue}</th></tr>
${arr(b.calc.rows).map(r => `      <tr><td class="n">${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`).join('\n')}
    </table>
    ${b.calc.note ? `<p class="muted" style="font-size:12.5px;margin:10px 2px 0">${esc(b.calc.note)}</p>` : ''}
  </section>` : ''
  const decks = arr(b.decks).filter(d => x.tokens.decks.has(d.token)).map(d => `<div class="deck"><div class="d">${esc(d.date)}</div><div><h3>${esc(d.title)}</h3><p>${esc(d.text)}</p><a href="${PORTAL}/deck/${d.token}?preview=1" target="_blank" rel="noopener">${t.openDeck}</a></div></div>`).join('\n      ')
  const chat = arr(b.chat).map(m => {
    const day = m.day ? `<div class="day"><span>${esc(m.day)}</span></div>\n      ` : ''
    const cls = m.kind === 'customer' ? 'c' : m.kind === 'sven' ? 's' : 'e'
    const who = m.kind === 'event' ? esc(m.who || t.event) : `${esc(m.who ?? '')}${m.channel ? ` <span class="ch">· ${esc(m.channel)}</span>` : ''}`
    const more = m.more ? `<details><summary>${x.lang === 'en' ? 'Read more' : 'Weiterlesen'}</summary>${paras(m.more)}</details>` : ''
    return `${day}<div class="msg ${cls}"><div class="who">${who}</div>${m.kind === 'event' ? esc(m.text) : paras(m.text)}${more}</div>`
  }).join('\n      ')
  const next = arr(b.next).map(n => `<div class="row"><span class="pill ${n.mine ? 'alt' : 'open'}">${esc(n.who)}</span><div>${esc(n.text)}</div></div>`).join('\n      ')
  const chips = arr(b.chips).map(c => `<span class="chip${c.positive ? ' g' : ''}"><i></i>${esc(c.text)}</span>`).join('\n      ')
  const n = (k: number) => (units.length ? k : k - 1)

  return `<!doctype html>
<html lang="${x.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title} · ${esc(x.kunde)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Playfair+Display:wght@500;600;700&display=swap" rel="stylesheet">
<style>${BRIEFING_CSS}</style>
</head>
<body>

<div class="brand"><img src="${LOGO}" alt="Happy Property"></div>

<header class="hero" style="background-image:url('${esc(img(arr(b.cards)[0]?.image_index))}')">
  <div class="wrap">
    <div class="eyebrow">${esc(b.hero_eyebrow)}</div>
    <h1>${esc(x.kunde)}</h1>
    <p class="lead">${esc(b.hero_lead)}</p>
    <div class="meta">
      <span>${t.for} <b>${esc(x.contactName)}, ${esc(x.devName)}</b></span>
      <span>${t.from} <b>Sven Rüprich, Happy Property</b></span>
      <span>${t.when} <b>${esc(x.when)}</b></span>
    </div>
    <div class="chips">
      ${chips}
    </div>
  </div>
</header>

<div id="tabs-top"></div>
<nav class="tabs">
  <div class="wrap">
    <button class="tab on" data-p="short">${t.short}<small>${t.shortSub}</small></button>
    <button class="tab" data-p="full">${t.full}<small>${t.fullSub}</small></button>
    <a class="hbtn" href="tel:${SVEN_TEL}">${t.call}<small>${t.callSub}</small></a>
  </div>
</nav>

<main class="wrap">

<div class="panel on" id="p-short">
  <section class="block">
    <div class="eyebrow">${t.whoComes}</div>
    <h2>${t.glance}</h2>
    <div class="grid">
      ${glance}
    </div>
  </section>

  <section class="block">
    <div class="eyebrow">${t.whatWeSee}</div>
    <h2>${t.props}</h2>
    <div class="projects">
      ${cards}
    </div>
  </section>

  <section class="block">
    <div class="eyebrow">${t.before}</div>
    <h2>${t.good}</h2>
    <div class="keys">
      ${keys}
    </div>
  </section>

  <section class="block">
    <div class="note">
      <div><h3>${t.howTalk}</h3><p>${esc(b.how_to_talk)}</p></div>
      <div><h3>${t.knows}</h3><p>${esc(b.already_has)}</p></div>
    </div>
  </section>
</div>

<div class="panel" id="p-full">
  <section class="block">
    <div class="eyebrow">1 · ${t.s1}</div>
    <h2>${esc(b.profile_heading)}</h2>
    <div class="prose">
      ${arr(b.profile).map(p => `<p>${esc(p)}</p>`).join('\n      ')}
    </div>
  </section>

  ${unitsHtml}

  <section class="block">
    <div class="eyebrow">${n(3)} · ${t.s3}</div>
    <h2>${t.s3h}</h2>
    <div class="told">
      ${told}
    </div>
  </section>

  ${calc.replace('4 · ', `${n(4)} · `)}

  ${decks ? `<section class="block">
    <div class="eyebrow">${n(calc ? 5 : 4)} · ${t.s5}</div>
    <h2>${t.s5h}</h2>
    <div class="decks">
      ${decks}
    </div>
  </section>` : ''}

  <section class="block">
    <div class="eyebrow">${t.s6}</div>
    <h2>${t.s6h}</h2>
    <p class="muted" style="margin:-8px 0 14px;font-size:13px">${esc(b.chat_intro)}</p>
    <div class="chat">
      ${chat}
    </div>
  </section>

  <section class="block">
    <div class="eyebrow">${t.s7}</div>
    <h2>${t.s7h}</h2>
    <div class="next">
      ${next}
    </div>
  </section>
</div>

<footer>
  ${t.conf(esc(x.devName))} ${t.questions}: Sven Rüprich, ${SVEN_TEL_DISP}, <a href="mailto:sven@happy-property.com">sven@happy-property.com</a>.<br>
  ${t.version} 1 · ${today}
</footer>
</main>

<script>
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('on', x === b) })
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + b.dataset.p) })
      var a = document.getElementById('tabs-top')
      var top = a.getBoundingClientRect().top + window.scrollY
      if (window.scrollY > top) window.scrollTo({ top: top, behavior: 'smooth' })
    })
  })
</script>
</body>
</html>
`
}

// ── Ablauf je Termin ───────────────────────────────────────────────────────────
interface DevTarget { contactId: string | null; name: string; phone: string; email: string; lang: Lang; devName: string }

/** Bauträger-Kontakte unter den Teilnehmern: Abgleich per Telefon/Mail mit crm_developer_contacts. */
async function bautraeger(sb: SupabaseClient, attendees: Row[]): Promise<DevTarget[]> {
  if (!attendees.length) return []
  const { data } = await sb.from('crm_developer_contacts').select('id, name, email, phone, whatsapp, language, developer:crm_developers(name)')
  const contacts = (data ?? []) as Row[]
  const out: DevTarget[] = []
  for (const a of attendees) {
    const ph = digits(a.phone)
    const em = String(a.email ?? '').trim().toLowerCase()
    const c = contacts.find(c => (ph && (digits(c.phone) === ph || digits(c.whatsapp) === ph)) || (em && String(c.email ?? '').trim().toLowerCase() === em))
    const isDev = !!c || /\(Developer\)/i.test(String(a.company ?? ''))
    if (!isDev) continue
    const dev = c ? (Array.isArray(c.developer) ? (c.developer as Row[])[0] : c.developer as Row | null) : null
    const devName = String(dev?.name ?? String(a.company ?? '').replace(/\s*\(Developer\)\s*/i, '') ?? '').trim() || 'Developer'
    const lang: Lang = (c?.language ?? a.language) === 'en' ? 'en' : 'de'
    out.push({ contactId: (c?.id as string) ?? null, name: String(c?.name ?? a.name ?? ''), phone: String(c?.whatsapp || c?.phone || a.phone || ''), email: String(c?.email || a.email || ''), lang, devName })
  }
  return out
}

async function verarbeiten(apptId: string, dryRun: boolean): Promise<Row> {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE)
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  const { data: appt } = await sb.from('crm_appointments').select('id, title, start_time, timezone, type, location, lead_id, attendees').eq('id', apptId).maybeSingle()
  if (!appt) return { ok: false, error: 'Termin nicht gefunden' }
  const a = appt as Row
  if (!a.lead_id) return { ok: true, skipped: 'kein Kunde am Termin' }
  const targets = await bautraeger(sb, Array.isArray(a.attendees) ? a.attendees as Row[] : [])
  if (!targets.length) return { ok: true, skipped: 'kein Bauträger-Kontakt am Termin' }

  const d = await sammeln(sb, a.lead_id as string)
  const kunde = `${d.lead?.first_name ?? ''} ${d.lead?.last_name ?? ''}`.trim() || 'Kunde'
  const images = [...new Set(d.decks.flatMap(x => deckImages(x.content)))].slice(0, 16)
  const tokens = { decks: new Set(d.decks.map(x => String(x.token))), calcs: new Set(d.calcs.map(c => String(c.token))) }
  const tz = String(a.timezone || 'Asia/Nicosia')
  const results: Row[] = []
  const cache = new Map<Lang, Briefing>()

  for (const tg of targets) {
    try {
      const when = fmtWhen(String(a.start_time), tz, tg.lang)
      let b = cache.get(tg.lang)
      if (!b) {
        b = await erzeugen(key, d, { lang: tg.lang, devName: tg.devName, contactName: tg.name, apptTitle: String(a.title ?? ''), when, location: String(a.location ?? ''), images })
        cache.set(tg.lang, b)
      }
      const html = rendern(b, { lang: tg.lang, kunde, contactName: tg.name, devName: tg.devName, when, images, tokens })
      const note = `developer_briefing:${apptId}:${tg.contactId ?? digits(tg.phone) ?? tg.name}`
      const { data: ex } = await sb.from('shared_pages').select('id, token').eq('note', note).maybeSingle()
      let token: string
      const neu = !ex
      if (ex) {
        token = String((ex as Row).token)
        await sb.from('shared_pages').update({ html, title: `${L[tg.lang].title} · ${kunde}` }).eq('id', (ex as Row).id)
      } else {
        token = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('')
        const expires = new Date(Date.now() + 92 * 864e5).toISOString()
        const { error } = await sb.from('shared_pages').insert({ token, title: `${L[tg.lang].title} · ${kunde}`, html, note, expires_at: expires })
        if (error) throw new Error(`shared_pages: ${error.message}`)
      }
      const link = `${PORTAL}/seite/${token}`
      let sent = false
      if (neu && !dryRun) sent = await senden(sb, tg, { kunde, title: String(a.title ?? ''), when, link, leadId: a.lead_id as string })
      results.push({ contact: tg.name, developer: tg.devName, lang: tg.lang, link, new: neu, sent })
      console.log(`[developer-briefing] ${apptId} → ${tg.name} (${tg.devName}, ${tg.lang}) ${neu ? 'neu' : 'aktualisiert'}${sent ? ', gesendet' : ''}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[developer-briefing] ${apptId} → ${tg.name}:`, msg)
      results.push({ contact: tg.name, error: msg })
    }
  }
  return { ok: true, results }
}

/** WhatsApp an den Bauträger: wer kommt + Link. Ohne Nummer per Mail. */
async function senden(sb: SupabaseClient, tg: DevTarget, x: { kunde: string; title: string; when: string; link: string; leadId: string }): Promise<boolean> {
  const first = tg.name.split(' ')[0] || tg.name
  const text = tg.lang === 'en'
    ? `Hello ${first}, for our appointment "${x.title}" on ${x.when}, ${x.kunde} is coming. Here is everything about the client, short and in full:\n${x.link}\n\nBest regards, Sven · Happy Property`
    : `Hallo ${first}, zu unserem Termin „${x.title}“ am ${x.when} kommt ${x.kunde}. Hier alles über den Kunden, kurz und ausführlich:\n${x.link}\n\nLiebe Grüße, Sven · Happy Property`
  const headers = { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' }
  let ok = false
  if (tg.phone) {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp`, {
      method: 'POST', headers,
      body: JSON.stringify({ event_type: 'developer_briefing', override_text: text, auto: true, lead_data: { lead_name: tg.name, lead_phone: tg.phone } }),
    })
    const body = await r.json().catch(() => null) as { results?: Array<{ ok?: boolean }> } | null
    ok = r.ok && (!Array.isArray(body?.results) || body!.results!.length === 0 || body!.results!.some(z => z.ok))
    if (!ok) console.warn('[developer-briefing] WhatsApp abgelehnt:', r.status, JSON.stringify(body).slice(0, 200))
  }
  if (!ok && tg.email) {
    const html = `<p>${esc(text.split('\n')[0])}</p><p><a href="${x.link}">${esc(x.link)}</a></p><p>${tg.lang === 'en' ? 'Best regards' : 'Liebe Grüße'}, Sven · Happy Property</p>`
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: 'POST', headers,
      body: JSON.stringify({ to: tg.email, subject: `${L[tg.lang].title} · ${x.kunde} · ${x.title}`, html, lang: tg.lang }),
    })
    ok = r.ok
    if (!ok) console.warn('[developer-briefing] Mail abgelehnt:', r.status, (await r.text()).slice(0, 200))
  }
  await sb.from('activities').insert({
    lead_id: x.leadId, type: 'note', direction: 'outbound', auto: true,
    subject: ok ? `Briefing an ${tg.name} (${tg.devName}) gesendet` : `Briefing an ${tg.name} (${tg.devName}) NICHT gesendet`,
    content: `Kunden-Briefing für den Termin „${x.title}“: ${x.link}`,
    completed_at: new Date().toISOString(),
  })
  return ok
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  const denied = await gateCaller(req, 'developer-briefing', { service: true, roles: ['admin', 'verwalter'], perms: ['pipeline', 'contacts'] }, CORS)
  if (denied) return denied
  let body: { appointment_id?: string; dry_run?: boolean; wait?: boolean }
  try { body = await req.json() } catch { return json({ error: 'JSON erwartet' }, 400) }
  const id = String(body.appointment_id ?? '')
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'appointment_id fehlt' }, 400)
  const job = verarbeiten(id, !!body.dry_run).catch(e => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  if (body.wait) return json(await job)
  // deno-lint-ignore no-explicit-any
  ;(globalThis as any).EdgeRuntime?.waitUntil?.(job)
  return json({ ok: true, queued: true })
})
