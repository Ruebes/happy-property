// Supabase Edge Function: track-engagement
// Loggt Kunden-Engagement in engagement_events:
//   - GET  ?type=email_open&token=<deck-token>   → Mail-Öffnungs-Pixel (1x1 gif)
//   - POST { type, token }                       → Deck/Berechnung-Aufruf (Beacon)
// type: 'deck_view' | 'calc_view' | 'email_open'. Lead + Label werden aus
// sales_decks / property_calculations aufgelöst. Dedupe: gleiches (lead,type,token)
// innerhalb von 2 h wird nicht doppelt gezählt.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { bookingUrl, PORTAL_URL } from '../_shared/bookingLink.ts'
import { lotteBild } from '../_shared/lotte.ts'
import { cyDate } from '../_shared/notifyToday.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
// 1x1 transparentes GIF (für den Mail-Öffnungs-Pixel)
const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0))
const pixelResponse = () => new Response(PIXEL, { headers: { ...CORS, 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } })


// Sendezeit in Bürozeiten (8–21 Uhr Asia/Nicosia) schieben — nie nachts.
function toBusinessHours(d: Date): Date {
  const hourIn = (dt: Date) =>
    Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', hour: '2-digit', hour12: false }).format(dt)) % 24
  let out = new Date(d)
  for (let i = 0; i < 48; i++) {
    const h = hourIn(out)
    if (h >= 8 && h < 21) break
    out = new Date(out.getTime() + 60 * 60 * 1000)  // +1 h bis im Fenster
  }
  return out
}

// Deck-Follow-up planen: EINE WhatsApp X Min nach dem ERSTEN Deck-Aufruf.
// Gated auf die aktive Regel (deck_viewed_followup, Standard AUS). Einmal pro Lead,
// nicht bei Opt-Out, nur mit Telefonnummer. Gesendet wird später vom 5-Min-Cron.
async function scheduleDeckFollowup(
  supabase: ReturnType<typeof createClient>,
  leadId: string,
): Promise<void> {
  try {
    // 1) Regel aktiv? (Standard AUS → nichts planen)
    const { data: rule } = await supabase.from('automation_rules')
      .select('id, is_active, delay_minutes, appointment_condition')
      .eq('event_type', 'deck_viewed_followup').maybeSingle()
    const r = rule as { id: string; is_active: boolean; delay_minutes: number; appointment_condition: string | null } | null
    if (!r || !r.is_active) return

    // 2) Einmal pro Lead — schon geplant/gesendet?
    const { data: existing } = await supabase.from('scheduled_messages')
      .select('id').eq('lead_id', leadId).eq('event_type', 'deck_viewed_followup').limit(1)
    if (existing && existing.length) return

    // 3) Opt-Out? → nicht planen
    const { data: opt } = await supabase.from('communication_optouts')
      .select('id').eq('lead_id', leadId).limit(1)
    if (opt && opt.length) return

    // 4) Lead + Nummer laden (WhatsApp braucht eine Nummer)
    const { data: lead } = await supabase.from('leads')
      .select('first_name, whatsapp, phone, booking_token').eq('id', leadId).maybeSingle()
    const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null; booking_token: string | null } | null
    if (!l || !(l.whatsapp || l.phone)) return

    const first = (l.first_name ?? '').trim()
    const greet = first ? `Hey ${first}` : 'Hallo'
    const msg =
      `${greet}, hier ist Lotte, Svens persönliche Assistentin 🐾 Ich wollte kurz nachhören: Konntest du schon in Ruhe über die Objekte schauen? Welches spricht dich am meisten an?\n\n` +
      `Wenn du magst, nehmt ihr euch 15 Minuten und Sven beantwortet dir alle offenen Fragen — hier kannst du dir direkt einen Termin aussuchen: ${bookingUrl(l.booking_token)}\n\n` +
      // Lotte, nicht Sven: diese Nachricht tippt niemand, sie geht automatisch nach
      // einer Deck-Ansicht raus. Als "Sven" signiert wäre sie eine Verwechslung —
      // und ein Hundefoto unter Svens Namen erst recht.
      `Liebe Grüße, Lotte 🐾`

    const delay  = (r.delay_minutes ?? 45) * 60 * 1000
    const sendAt = toBusinessHours(new Date(Date.now() + delay))

    await supabase.from('scheduled_messages').insert({
      lead_id:               leadId,
      type:                  'whatsapp',
      event_type:            'deck_viewed_followup',
      status:                'pending',
      scheduled_at:          sendAt.toISOString(),
      whatsapp_text:         msg,
      // Lotte-Bild mitgeben, damit die Nachricht wie alle Bot-Nachrichten aussieht.
      whatsapp_image_url:    lotteBild(),
      recipient:             'client',
      rule_id:               r.id,
      appointment_condition: r.appointment_condition ?? 'no_appointment',
    })
    console.log(`[track-engagement] Deck-Follow-up geplant für Lead ${leadId} um ${sendAt.toISOString()}`)
  } catch (err) {
    console.warn('[track-engagement] scheduleDeckFollowup fehlgeschlagen:', err)
  }
}


// ── Newsletter-Tracking (Sven 2.10.26) ──────────────────────────────────────
// Der Newsletter laeuft im Eigenes-HTML-Modus ohne Deck-Klone, deshalb gab es
// bisher weder Oeffnungen noch Klicks. Jetzt traegt jede Kampagnen-Mail:
//   GET ?type=nl_open&c=<campaign>&r=<l|s>:<id>            → 1x1-Pixel
//   GET ?type=nl_click&c=<campaign>&r=<...>&l=<label>&u=<ziel>  → 302 aufs Ziel
// Gespeichert wird in engagement_events mit token = Kampagnen-ID und label =
// Name des Links (guide, affiliate, termin, immo, berechnung ...), damit sich
// auswerten laesst, WAS geklickt wurde, nicht nur DASS geklickt wurde.
const NL_HOSTS = [
  'happy-property.com', 'happy-property.de', 'portal.happy-property.com',
  'steuervorteil-zypern-immobilien.com', 'vjlwgajmtqlwjjreowbu.supabase.co', 'wa.me',
]
// Offener Redirect waere ein Phishing-Werkzeug: nur eigene Ziele weiterleiten.
export function nlZielErlaubt(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    const ok = NL_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))
    return ok ? u.toString() : null
  } catch { return null }
}
// Persoenliche Deck-Links (Sven 11.10.26): Newsletter verlinken ein gemeinsames
// Deck. Ohne Kennung wusste das CRM nicht, WER sich die Wohnung ansieht. Die
// Weiterleitung haengt deshalb den Empfaenger an (hpr = l:<lead> | s:<abonnent>,
// hpc = Kampagne). Deck.tsx meldet ihn beim Aufruf mit, wa-track ordnet die
// Sitzung zu. Wirkt auch fuer schon versendete Mails, weil jeder Klick hier durchlaeuft.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_RE = /^[ls]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function mitEmpfaenger(ziel: string, campaign: string | null, ref: string | null): string {
  if (!ref || !REF_RE.test(ref)) return ziel
  try {
    const u = new URL(ziel)
    if (u.hostname !== 'portal.happy-property.com' || !u.pathname.startsWith('/deck/')) return ziel
    u.searchParams.set('hpr', ref.toLowerCase())
    if (campaign && UUID_RE.test(campaign)) u.searchParams.set('hpc', campaign)
    return u.toString()
  } catch { return ziel }
}

async function logNewsletter(
  type: 'newsletter_open' | 'newsletter_click',
  campaign: string | null, ref: string | null, label: string | null,
): Promise<void> {
  if (!campaign || !ref) return
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const [art, id] = ref.split(':')
  if (!id) return
  const row: Record<string, unknown> = {
    type, token: campaign, label: (label ?? '').slice(0, 60) || null,
    lead_id: art === 'l' ? id : null, subscriber_id: art === 's' ? id : null,
  }
  // Entprellen: dieselbe Kombination innerhalb von 2 h nur einmal. Mail-Clients
  // laden den Pixel beim Scrollen mehrfach, das waere sonst eine Phantomzahl.
  const seit = new Date(Date.now() - 2 * 3600e3).toISOString()
  let q = sb.from('engagement_events').select('id')
    .eq('type', type).eq('token', campaign).gte('occurred_at', seit).limit(1)
  q = art === 'l' ? q.eq('lead_id', id) : q.eq('subscriber_id', id)
  if (label) q = q.eq('label', label)
  const { data: da } = await q
  if (da && da.length) return
  await sb.from('engagement_events').insert(row)
}

async function logEvent(type: string, token: string | null, ref: string | null = null, campaign: string | null = null) {
  if (!type || !token) return
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let leadId: string | null = null
  let subscriberId: string | null = null
  let viaRef = false
  let label = ''
  let isCampaignClone = false
  try {
    if (type === 'deck_view' || type === 'email_open') {
      const { data: d } = await supabase.from('sales_decks').select('lead_id, project_id, recipient_name, batch_id').eq('token', token).maybeSingle()
      if (d) {
        leadId = (d.lead_id as string) ?? null
        isCampaignClone = !!(d as { batch_id?: string | null }).batch_id && !!leadId
        if (d.project_id) {
          const { data: p } = await supabase.from('crm_projects').select('name').eq('id', d.project_id).maybeSingle()
          label = (p?.name as string) ?? ''
        }
      }
    } else if (type === 'calc_view') {
      const { data: c } = await supabase.from('property_calculations').select('lead_id, title').eq('token', token).maybeSingle()
      if (c) { leadId = (c.lead_id as string) ?? null; label = (c.title as string) ?? '' }
    } else if (type === 'strategy_view') {
      // Investitions-Fahrplan (Strategie-Simulator, /strategie/<token>)
      const { data: s } = await supabase.from('crm_strategy_scenarios').select('lead_id, title').eq('token', token).maybeSingle()
      if (s) { leadId = (s.lead_id as string) ?? null; label = (s.title as string) ?? '' }
    }
  } catch { /* Auflösung best-effort */ }

  // Gemeinsames Deck aus dem Newsletter: Person kommt aus der Kennung im Link.
  // Persoenliche Decks bleiben beim Besitzer, die Kennung zaehlt dort nicht.
  if (type === 'deck_view' && !leadId && ref && REF_RE.test(ref)) {
    try {
      const p = await personAusRef(supabase, ref)
      if (p?.kind === 'lead') { leadId = p.id; viaRef = true }
      if (p?.kind === 'sub') { subscriberId = p.id; viaRef = true }
    } catch { /* ohne Zuordnung weiter */ }
  }

  // Mail-Öffnung NUR loggen, wenn die Mail mit diesem Deck-Token auch WIRKLICH an
  // den Kunden gesendet wurde (deck_outbox.email_sent_at). Sonst stammt die Öffnung
  // aus einer Vorschau/internen Mail (z.B. Test an die eigene Adresse) → kein echtes
  // Kundenverhalten, nicht zählen.
  // Newsletter-Kampagnen-Klone (batch_id + lead_id) tragen den Öffnungs-Pixel
  // direkt in der Kampagnen-Mail — sie brauchen keinen deck_outbox-Nachweis.
  if (type === 'email_open' && !isCampaignClone) {
    try {
      const { data: sent } = await supabase.from('deck_outbox')
        .select('id').contains('deck_tokens', [token]).not('email_sent_at', 'is', null).limit(1)
      if (!sent || !sent.length) return
    } catch { return }
  }

  // Deck-Aufruf NUR als Kundenbesuch zählen, wenn das Deck den Kunden auch
  // erreicht haben KANN. Liegt zu diesem Token ein Postausgang-Eintrag, der noch
  // nicht raus ist (Entwurf), hat der Kunde den Link nachweislich nicht — jeder
  // Aufruf ist dann intern (Kontrolle im CRM, Link kopiert, anderes Gerät, andere
  // Browser-Session). Das darf weder im Dashboard als „Deck angesehen" erscheinen
  // NOCH die Follow-up-/Bot-Automatik auslösen (sonst bekommt ein Kunde „Konntest
  // du schon schauen?" für Unterlagen, die er nie erhalten hat).
  // Newsletter-Klone (batch_id) laufen nicht über die Outbox → ausgenommen.
  if (type === 'deck_view' && !isCampaignClone) {
    try {
      const { data: ob } = await supabase.from('deck_outbox')
        .select('sent_at').contains('deck_tokens', [token])
        .order('created_at', { ascending: false }).limit(1)
      const row = (ob ?? [])[0] as { sent_at: string | null } | undefined
      if (row && !row.sent_at) return
    } catch { /* Outbox nicht lesbar → im Zweifel weiter loggen */ }
  }

  // Dedupe: gleiches Ereignis innerhalb von 2 h nicht doppelt loggen.
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    let dupQ = supabase.from('engagement_events').select('id').eq('type', type).eq('token', token).gte('occurred_at', since).limit(1)
    dupQ = leadId ? dupQ.eq('lead_id', leadId)
      : subscriberId ? dupQ.eq('subscriber_id', subscriberId)
      : dupQ.is('lead_id', null).is('subscriber_id', null)
    const { data: dup } = await dupQ
    if (dup && dup.length) return
  } catch { /* im Zweifel loggen */ }

  await supabase.from('engagement_events').insert({
    type, token, lead_id: leadId, subscriber_id: subscriberId, label: label || null,
    meta: viaRef ? { via: 'newsletter', campaign: campaign && UUID_RE.test(campaign) ? campaign : null } : null,
  })

  // Nach dem ERSTEN Deck-Aufruf: Follow-up auslösen. Wenn der Termin-Bot aktiv ist,
  // startet er den Buchungs-Dialog (schlägt Termine vor + bucht) — das ist die
  // stärkere Variante und hat Vorrang. Sonst greift das statische WhatsApp-Follow-up.
  // Läuft nur hier, wenn das Event NICHT dedupliziert wurde (= erster Aufruf im 2-h-Fenster).
  // NICHT bei Newsletter-Klicks (viaRef): der Newsletter geht nur per Mail, ein
  // WhatsApp-Nachfassen darauf hat Sven nie freigegeben.
  if (type === 'deck_view' && leadId && !viaRef) {
    const { data: bot } = await supabase.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
    if ((bot as { value?: string } | null)?.value === 'true') {
      // Bot-Start +40 Min planen (nicht sofort — Kunde soll erst selbst buchen können).
      // DEDUP gegen Doppel-Trigger: nur wenn weder IRGENDEIN offener Bot-Nudge ansteht
      // noch ein aktives Gespräch läuft. Quellenübergreifend (nicht nur deck_viewed) —
      // sonst plant ein Deck-View einen deck_viewed-Start, obwohl schon ein
      // immobilienauswahl/no_show-Nudge pending ist (Andreas-Fall: zwei fast identische
      // Lotte-Vorstellungen 5 Min auseinander).
      const { data: pend } = await supabase.from('scheduled_messages').select('id, bot_nudge_source, bot_nudge_stage, scheduled_at')
        .eq('lead_id', leadId).eq('event_type', 'bot_nudge').in('status', ['pending', 'processing']).limit(10)
      const { data: activeConv } = await supabase.from('booking_conversations').select('id')
        .eq('lead_id', leadId).not('state', 'in', '(booked,handoff,expired)').gt('expires_at', new Date().toISOString()).limit(1)
      // Läuft schon die Immobilienauswahl-Kette (Stufe 0 = „Hattest du schon Zeit …?"
      // in 24 h), wird diese Stufe auf +40 Min VORGEZOGEN statt den Deck-View-Start zu
      // verschlucken: Der Kunde hat gerade geschaut, jetzt ist der Moment (Nazih 16.9.:
      // Deck um 12:08 angesehen, keine WhatsApp, weil die Kette „schon pending" war).
      // Kein Doppel, weil dieselbe Zeile nur früher dran ist.
      const kette0 = (pend ?? []).find((p) => (p as { bot_nudge_source?: string; bot_nudge_stage?: number }).bot_nudge_source === 'immobilienauswahl' && (p as { bot_nudge_stage?: number }).bot_nudge_stage === 0) as { id: string; scheduled_at: string } | undefined
      const in40 = new Date(Date.now() + 40 * 60000).toISOString()
      if (kette0 && kette0.scheduled_at > in40) {
        await supabase.from('scheduled_messages').update({ scheduled_at: in40 }).eq('id', kette0.id)
      } else if (!(pend && pend.length) && !(activeConv && activeConv.length)) {
        await supabase.from('scheduled_messages').insert({
          lead_id: leadId, type: 'whatsapp', event_type: 'bot_nudge',
          bot_nudge_stage: 0, bot_nudge_source: 'deck_viewed', status: 'pending',
          scheduled_at: new Date(Date.now() + 40 * 60000).toISOString(),
        })
      }
    } else {
      await scheduleDeckFollowup(supabase, leadId)
    }
  }
}

// ── Person hinter einem Deck-Aufruf ─────────────────────────────────────────
type Sb = ReturnType<typeof createClient>
interface Person {
  kind: 'lead' | 'sub'; id: string; first: string; name: string
  email: string | null; phone: string | null; bookingToken: string | null
}
async function personAusRef(sb: Sb, ref: string): Promise<Person | null> {
  if (!REF_RE.test(ref)) return null
  const [art, id] = ref.toLowerCase().split(':')
  return art === 'l' ? leadPerson(sb, id) : subPerson(sb, id)
}
async function leadPerson(sb: Sb, id: string): Promise<Person | null> {
  const { data } = await sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp, booking_token').eq('id', id).maybeSingle()
  const l = data as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null; booking_token: string | null } | null
  if (!l) return null
  return { kind: 'lead', id: l.id, first: (l.first_name ?? '').trim(), name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(),
    email: l.email, phone: l.whatsapp || l.phone, bookingToken: l.booking_token }
}
async function subPerson(sb: Sb, id: string): Promise<Person | null> {
  const { data } = await sb.from('newsletter_subscribers').select('id, first_name, last_name, email, phone').eq('id', id).maybeSingle()
  const s = data as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null } | null
  if (!s) return null
  return { kind: 'sub', id: s.id, first: (s.first_name ?? '').trim(), name: `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(),
    email: s.email, phone: s.phone, bookingToken: null }
}
// Persoenliches Deck gehoert seinem Lead; gemeinsames Deck: Kennung aus dem Link.
async function personFuerDeck(sb: Sb, deckLeadId: string | null, ref: string | null): Promise<Person | null> {
  if (deckLeadId) return leadPerson(sb, deckLeadId)
  return ref ? personAusRef(sb, ref) : null
}
const terminFuer = (p: Person | null): string =>
  p?.kind === 'lead' ? bookingUrl(p.bookingToken)
    : p?.kind === 'sub' ? `${PORTAL_URL}/termin?f=none&src=newsletter`
    : `${PORTAL_URL}/termin?src=deck`

// Deck-Seite fragt beim Laden: Kennen wir den Besucher? Liefert nur den Vornamen
// und den passenden Terminlink, keine Kontaktdaten.
async function deckPerson(token: string | null, ref: string | null): Promise<Record<string, unknown>> {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  if (!token) return { known: false, first_name: null, booking_url: terminFuer(null) }
  const { data: d } = await sb.from('sales_decks').select('lead_id').eq('token', token).maybeSingle()
  if (!d) return { known: false, first_name: null, booking_url: terminFuer(null) }
  const p = await personFuerDeck(sb, (d as { lead_id: string | null }).lead_id, ref)
  return { known: !!p, first_name: p?.first || null, booking_url: terminFuer(p) }
}

// ── „Mehr Infos zur Wohnung" (Sven 11.10.26) ────────────────────────────────
// Kleinere Huerde als ein Termin: Der Besucher fordert Unterlagen an, Sven bekommt
// eine Aufgabe (normaler Weg: Lotte per Mail + WhatsApp, taegliche Erinnerung bis
// erledigt). An den Kunden geht NICHTS automatisch raus, Sven antwortet persoenlich.
const WUNSCH: Record<string, string> = {
  grundriss: 'Grundriss und Ausstattungsliste',
  zahlungsplan: 'Zahlungsplan und Kaufnebenkosten',
  rechnung: 'Persönliche Kosten- und Mietrechnung',
  ablauf: 'Ablauf beim Kauf aus Deutschland',
}
const kurz = (v: unknown, n: number) => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, n)
async function infoRequest(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  // Honigtopf: Menschen sehen das Feld nicht, Bots fuellen es aus.
  if (kurz(body.website, 200)) return { status: 200, body: { ok: true } }
  const token = kurz(body.token, 64)
  if (!token) return { status: 400, body: { error: 'Deck fehlt.' } }
  const ref = kurz(body.ref, 80) || null
  const campaign = kurz(body.campaign, 40)
  const intern = body.internal === true
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: deck } = await sb.from('sales_decks').select('lead_id, project_id, content').eq('token', token).maybeSingle()
  const d = deck as { lead_id: string | null; project_id: string | null; content: { blocks?: Array<{ type?: string; number?: string }> } | null } | null
  if (!d) return { status: 404, body: { error: 'Deck nicht gefunden.' } }

  let person = await personFuerDeck(sb, d.lead_id, ref)
  let name = person?.name || person?.first || ''
  let email = person?.email ?? null
  let phone = person?.phone ?? null
  if (!person) {
    name = kurz(body.name, 120)
    email = kurz(body.email, 200).toLowerCase() || null
    phone = kurz(body.phone, 40) || null
    if (!name) return { status: 400, body: { error: 'Bitte gib deinen Namen an.' } }
    if (!email && !phone) return { status: 400, body: { error: 'Bitte gib eine E-Mail-Adresse oder Telefonnummer an.' } }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Bitte prüfe die E-Mail-Adresse.' } }
    // Schon als Lead bekannt? Dann die Aufgabe an den Lead haengen.
    if (email) {
      const { data: hit } = await sb.from('leads').select('id').ilike('email', email.replace(/[%_\\]/g, '\\$&')).limit(1)
      const id = ((hit ?? [])[0] as { id: string } | undefined)?.id
      if (id) person = await leadPerson(sb, id)
    }
  }
  const leadId = person?.kind === 'lead' ? person.id : null
  const subId = person?.kind === 'sub' ? person.id : null
  const wuensche = (Array.isArray(body.wants) ? body.wants : []).map(String).filter(k => k in WUNSCH)
  const frage = kurz(body.question, 1000)
  // Decks mit mehreren Wohnungen: das Formular schickt die gewählte Wohnung mit (unit).
  // Ohne gültige Wahl bleibt die Wohnung offen, statt still die erste anzunehmen.
  const deckNrs = (d.content?.blocks ?? []).flatMap(b => b?.type === 'unit' && b.number?.trim() ? [b.number.trim()] : [])
  const gewaehlt = kurz(body.unit, 30)
  const nr = deckNrs.includes(gewaehlt) ? gewaehlt : deckNrs.length === 1 ? deckNrs[0] : ''

  // Missbrauchsbremse: oeffentlicher Endpunkt, der Aufgaben anlegt.
  const vorStunde = new Date(Date.now() - 3600e3).toISOString()
  const { count } = await sb.from('engagement_events').select('id', { count: 'exact', head: true })
    .eq('type', 'info_request').gte('occurred_at', vorStunde)
  if ((count ?? 0) >= 30) return { status: 429, body: { error: 'Gerade zu viele Anfragen. Bitte versuche es später noch einmal.' } }
  // Doppelt abgeschickt: dieselbe Person zum selben Deck (bei mehreren Wohnungen: zur
  // selben Wohnung) binnen 12 h nur einmal.
  const vor12 = new Date(Date.now() - 12 * 3600e3).toISOString()
  let dq = sb.from('engagement_events').select('id').eq('type', 'info_request').eq('token', token).gte('occurred_at', vor12).limit(1)
  if (deckNrs.length > 1 && nr) dq = dq.eq('meta->>unit', nr)
  dq = leadId ? dq.eq('lead_id', leadId) : subId ? dq.eq('subscriber_id', subId)
    : email ? dq.eq('meta->>email', email) : dq.eq('meta->>phone', phone ?? '')
  const { data: dup } = await dq
  if (dup && dup.length) return { status: 200, body: { ok: true, duplicate: true } }

  // Objekt benennen: Projekt (intern) + Wohnungsnummer aus dem Deck.
  let projekt = ''
  if (d.project_id) {
    const { data: p } = await sb.from('crm_projects').select('name').eq('id', d.project_id).maybeSingle()
    projekt = ((p as { name?: string } | null)?.name) ?? ''
  }
  const objekt = nr ? `Wohnung ${nr}${projekt ? ` (${projekt})` : ''}`
    : deckNrs.length > 1 ? `${projekt || 'ein Projekt'}, Wohnung nicht gewählt` : (projekt || 'ein Objekt')

  let herkunft = d.lead_id ? 'persönliches Deck' : 'Deck-Link ohne Empfänger (weitergeleitet oder Website)'
  if (!d.lead_id && UUID_RE.test(campaign)) {
    const { data: c } = await sb.from('newsletter_campaigns').select('title').eq('id', campaign).maybeSingle()
    herkunft = `Newsletter „${((c as { title?: string } | null)?.title) ?? campaign.slice(0, 8)}“`
  } else if (!d.lead_id && person) herkunft = 'Newsletter'

  const wer = name || 'Unbekannt'

  // Infopaket automatisch per Mail (info-paket entscheidet selbst: Schalter
  // off | test | on, Wohnung frei, Preis wie im Deck, Kontaktsperre).
  let paket: { sent?: boolean; reason?: string; calc_url?: string; calc_url_cash?: string } = {}
  if (email) {
    try {
      const { data } = await sb.functions.invoke('info-paket', { body: {
        token, lead_id: leadId, subscriber_id: subId, email: person ? null : email, name: wer, question: frage,
      } })
      paket = (data ?? {}) as typeof paket
    } catch (e) { console.warn('[track-engagement] info-paket:', e) }
  }
  const PAKET_GRUND: Record<string, string> = {
    testmodus: 'Testmodus, geht nur an Sven', keine_mail: 'keine E-Mail-Adresse', kontaktsperre: 'Kontaktsperre am Lead',
    mehrere_wohnungen: 'Deck mit mehreren Wohnungen', wohnung_fehlt: 'Wohnung nicht gefunden', wohnung_vergeben: 'Wohnung nicht mehr frei',
    mwst_sonderfall: 'MwSt-Sonderfall', preis_geaendert: 'Preis hat sich seit dem Deck geändert', rechnung_fehler: 'Rechnung ließ sich nicht anlegen',
    versand_fehler: 'Mailversand fehlgeschlagen', deck_fehlt: 'Deck nicht gefunden', fehler: 'technischer Fehler',
  }
  // Anfrage-Paket (Sven 13.10.26): Ist das Infopaket nicht automatisch raus, bereitet
  // anfrage-paket Deck, Rechnungen und Mail als Entwurf im Postausgang vor.
  // Hat die Person zu dieser Wohnung schon ein Paket (14 Tage)? Dann kein zweites und
  // keine „wird vorbereitet“-Meldung, sondern „fragt erneut“ (Sven 24.10.26: Silvia
  // fragte nach dem Versand im eigenen Paket-Deck noch einmal, die Meldung kam doppelt).
  let schon: { status: string; datum: string | null } | null = null
  if (nr && d.project_id && (leadId || subId || email)) {
    const { data: u } = await sb.from('crm_project_units').select('id').eq('project_id', d.project_id).eq('unit_number', nr).limit(1).maybeSingle()
    const unitId = (u as { id: string } | null)?.id
    if (unitId) {
      let q = sb.from('anfrage_pakete').select('outbox_id').eq('unit_id', unitId).in('status', ['deck', 'fertig'])
        .gte('created_at', new Date(Date.now() - 14 * 864e5).toISOString()).order('created_at', { ascending: false }).limit(1)
      q = leadId ? q.eq('lead_id', leadId) : subId ? q.eq('subscriber_id', subId) : q.eq('empfaenger_email', email ?? '')
      const { data: ap } = await q
      const a = ((ap ?? []) as { outbox_id: string | null }[])[0]
      if (a) {
        const { data: ob } = a.outbox_id ? await sb.from('deck_outbox').select('status, sent_at').eq('id', a.outbox_id).maybeSingle() : { data: null }
        const o = ob as { status: string; sent_at: string | null } | null
        schon = { status: o?.status ?? 'deck', datum: o?.sent_at ?? null }
      }
    }
  }
  const { data: apRow } = await sb.from('crm_settings').select('value').eq('key', 'anfrage_paket_mode').maybeSingle()
  const anfragePaket = !paket.sent && !schon && String((apRow as { value?: string } | null)?.value ?? '').trim() === 'on'
  const schonZeile = schon
    ? `Infopaket zu dieser Wohnung hat ${wer} schon (${schon.status === 'sent' && schon.datum ? `verschickt am ${new Date(schon.datum).toLocaleDateString('de-DE', { timeZone: 'Asia/Nicosia' })}` : schon.status === 'draft' ? 'Entwurf liegt im Postausgang' : 'wird gerade vorbereitet'}). Kein neues Paket, bitte persönlich antworten.`
    : ''
  const paketZeile = schonZeile || paket.sent
    ? `Infopaket: automatisch per Mail verschickt (2 Rechnungen, Wohnung als PDF, Guide, Baufotos). Finanziert: ${paket.calc_url ?? ''} · Ohne Kredit: ${paket.calc_url_cash ?? ''}`
    : anfragePaket
      ? 'Infopaket: wird gerade vorbereitet (eigenes Deck mit Grundriss und Baubeschreibung, 2 Rechnungen, Datenblatt) und liegt in wenigen Minuten im Postausgang. Prüfen und senden.'
    : paket.reason && paket.reason !== 'automatik_aus'
      ? `Infopaket: NICHT automatisch verschickt (${PAKET_GRUND[paket.reason] ?? paket.reason}), bitte selbst schicken.`
      : ''

  const zeilen = [
    `Wer: ${[wer, email, phone].filter(Boolean).join(' · ')}${person ? '' : ' (selbst eingetragen)'}`,
    `Möchte: ${wuensche.length ? wuensche.map(k => WUNSCH[k]).join(', ') : 'mehr Infos (nichts Bestimmtes angekreuzt)'}`,
    ...(frage ? [`Frage: „${frage}“`] : []),
    `Herkunft: ${herkunft}`,
    `Deck: ${PORTAL_URL}/deck/${token}?preview=1`,
    ...(paketZeile ? [paketZeile] : []),
    paket.sent ? 'Nächster Schritt: anrufen oder schreiben, solange das Interesse frisch ist.'
      : 'Versprochen auf der Seite: persönliche Antwort von Sven, in der Regel innerhalb von 24 Stunden.',
    ...(wuensche.includes('rechnung') && leadId && !paket.sent && !schon ? ['Tipp: Rechnung im Lead über „📊 Rechnung erstellen“, der Mail-Entwurf liegt dann im Postausgang.'] : []),
  ]
  const beschreibung = zeilen.join('\n')

  await sb.from('engagement_events').insert({
    type: 'info_request', token, lead_id: leadId, subscriber_id: subId, label: objekt.slice(0, 120),
    meta: { unit: nr || null, wants: wuensche, question: frage || null, name: wer, email, phone, campaign: UUID_RE.test(campaign) ? campaign : null, internal: intern, paket: paket.sent ? "sent" : (paket.reason ?? null) },
  })

  const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
  const adminId = (admin as { id: string } | null)?.id ?? null
  const { data: task, error: tErr } = await sb.from('crm_tasks').insert({
    title: `${intern ? '[Test] ' : ''}📩 ${wer}: ${paket.sent ? `Infopaket zu ${objekt} verschickt, bitte nachfassen` : schon ? `fragt erneut zu ${objekt}` : `möchte mehr Infos zu ${objekt}`}`.slice(0, 200),
    description: beschreibung, created_by: adminId, assigned_to: adminId, status: 'offen',
    due_date: cyDate(new Date()),
    // Zustellung laeuft ueber die Zustaendigen-Zeile (wie Tasks.tsx), alten Pfad stumm.
    assigned_notified_at: new Date().toISOString(),
  }).select('id').single()
  if (tErr || !task) {
    console.error('[track-engagement] info_request Aufgabe:', tErr?.message)
    return { status: 500, body: { error: 'Anfrage konnte nicht gespeichert werden. Bitte schreib Sven direkt.' } }
  }
  const taskId = (task as { id: string }).id
  if (adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
  if (leadId) {
    await sb.from('crm_task_leads').insert({ task_id: taskId, lead_id: leadId })
    await sb.from('activities').insert({
      lead_id: leadId, type: 'note', direction: 'inbound', auto: false,
      subject: `📩 Mehr Infos angefordert: ${objekt}`, content: beschreibung, completed_at: new Date().toISOString(),
    }).then(({ error }) => { if (error) console.warn('[track-engagement] info_request Notiz:', error.message) })
  }
  // Interne Tests (Svens eigener Browser) legen nur die Aufgabe an, ohne Lotte-Meldung.
  if (!intern) {
    await sb.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: taskId } })
      .catch((e: unknown) => console.warn('[track-engagement] info_request dispatch:', e))
  }
  // Paket im Hintergrund vorbereiten (Deck-Erstellung dauert Minuten).
  if (anfragePaket && !intern) {
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const p = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/anfrage-paket`, {
      method: 'POST', headers: { Authorization: `Bearer ${svc}`, apikey: svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quelle: 'formular', token, wohnung: nr || null, lead_id: leadId, subscriber_id: subId, email: person ? null : email, name: wer, phone,
        wuensche: wuensche.map(k => WUNSCH[k]), frage, task_id: taskId,
      }),
    }).then(r => r.text()).catch((e: unknown) => console.warn('[track-engagement] anfrage-paket:', e))
    const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
    if (er) er.waitUntil(p); else await p
  }
  return { status: 200, body: { ok: true, sent: !!paket.sent } }
}

const jsonRes = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    if (req.method === 'GET') {
      const u = new URL(req.url)
      const type = u.searchParams.get('type') || 'email_open'
      const token = u.searchParams.get('token')

      // Newsletter-Oeffnung: Pixel, Logging best-effort.
      if (type === 'nl_open') {
        try { await logNewsletter('newsletter_open', u.searchParams.get('c'), u.searchParams.get('r'), null) } catch { /* egal */ }
        return pixelResponse()
      }
      // Newsletter-Klick: loggen, dann auf das echte Ziel weiterleiten. Faellt das
      // Logging aus, geht der Klick trotzdem durch - der Kunde darf nie haengen.
      if (type === 'nl_click') {
        const ziel = nlZielErlaubt(u.searchParams.get('u') ?? '')
        try { await logNewsletter('newsletter_click', u.searchParams.get('c'), u.searchParams.get('r'), u.searchParams.get('l')) } catch { /* egal */ }
        const wohin = ziel ? mitEmpfaenger(ziel, u.searchParams.get('c'), u.searchParams.get('r')) : 'https://happy-property.com'
        return new Response(null, { status: 302, headers: { ...CORS, Location: wohin, 'Cache-Control': 'no-store' } })
      }

      // Pixel: NIE blockieren, immer das gif zurückgeben (Logging best-effort).
      try { await logEvent(type, token) } catch { /* egal */ }
      return pixelResponse()
    }
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const type = typeof body.type === 'string' ? body.type : ''
      const token = typeof body.token === 'string' ? body.token : null
      const ref = typeof body.ref === 'string' && REF_RE.test(body.ref) ? body.ref : null
      const campaign = typeof body.campaign === 'string' && UUID_RE.test(body.campaign) ? body.campaign : null
      if (type === 'deck_person') return jsonRes(await deckPerson(token, ref))
      if (type === 'info_request') { const r = await infoRequest(body); return jsonRes(r.body, r.status) }
      await logEvent(type, token, ref, campaign)
      return jsonRes({ ok: true })
    }
    return new Response('Method Not Allowed', { status: 405, headers: CORS })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
