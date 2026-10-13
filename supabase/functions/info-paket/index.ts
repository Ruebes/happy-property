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
import { encodeBase64 } from 'jsr:@std/encoding@1/base64'
import { baueDatenblatt, zahlungsUebersicht, type DeckBlockLite } from './datenblatt.ts'
import {
  GUIDE_URL, LOGO, PHOTO_SQ, SERIF, SANS, CALC_STANDARD, type CalcStandard, type Markt, marktAnnahmen, calcParams,
  esc, kundenFotos, karte, rechnungKarte, zahlungKarte,
} from './bausteine.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const INTERN_ADRESSEN = ['sven@happy-property.com']

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

type Block = { type?: string; number?: string; kicker?: string; mapLabel?: string }
type CtxUnit = { unitId?: string; unitNumber?: string; netProperty?: number; netFurniture?: number; bedrooms?: number | null }

async function handle(sb: SupabaseClient, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Nur Fotos eines Projekts prüfen (intern): { mode: 'fotos', project_id }
  if (b.mode === 'fotos' && typeof b.project_id === 'string') {
    const r = await kundenFotos(sb, b.project_id)
    return { ok: true, fotos: r.fotos.length, stand: r.fotoStand }
  }
  // 0) Schalter. Gezielter Versand durch Sven (erzwingen, z.B. an Newsletter-Klicker
  //    nach seiner Freigabe 11.10.26) übergeht ihn; alle übrigen Prüfungen bleiben.
  const erzwingen = b.erzwingen === true
  const ungefragt = b.quelle === 'newsletter_klick'
  const { data: modeRow } = await sb.from('crm_settings').select('value').eq('key', 'info_paket_mode').maybeSingle()
  const mode = erzwingen ? 'on' : String((modeRow as { value?: string } | null)?.value ?? 'off').trim()
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
  // Ungefragt (nur geklickt, nichts angefordert): Newsletter-Abmeldung gilt.
  if (ungefragt) {
    const { data: ab } = p.kind === 'lead'
      ? await sb.from('leads').select('newsletter_optout_at').eq('id', p.id).maybeSingle()
      : p.kind === 'sub' ? await sb.from('newsletter_subscribers').select('optout_at').eq('id', p.id).maybeSingle() : { data: null }
    const r = ab as { newsletter_optout_at?: string | null; optout_at?: string | null } | null
    if (r?.newsletter_optout_at || r?.optout_at) return { ok: true, sent: false, reason: 'abgemeldet' }
  }
  // Dasselbe Paket nie zweimal an dieselbe Person (Svens eigene Testadresse ausgenommen).
  if (p.kind !== 'frei' && !INTERN_ADRESSEN.includes(p.email.toLowerCase())) {
    let dq = sb.from('engagement_events').select('id').eq('type', 'info_paket').eq('token', token).limit(1)
    dq = p.kind === 'lead' ? dq.eq('lead_id', p.id) : dq.eq('subscriber_id', p.id)
    const { data: schon } = await dq
    if (schon && schon.length) return { ok: true, sent: false, reason: 'schon_verschickt' }
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

  // 7b) Datenblatt-PDF (Grundriss, Eckdaten, Zahlungsplan, Ausstattung, Bilder).
  //     Liegt der Mail bei und zusätzlich öffentlich im Storage (Link in der Mail).
  //     Scheitert es, geht die Mail ohne PDF raus - mit der Druckansicht als Ersatz.
  let pdfB64: string | null = null
  let pdfUrl: string | null = null
  let zahlplanUrl: string | null = null
  const pdfName = `${nr ? `Wohnung-${nr.replace(/[^\w-]/g, '')}` : 'Wohnung'}-Datenblatt.pdf`
  // Übergabe: wie im Deck (deck_context.completion), sonst Projekt-Fertigstellung.
  let uebergabe = typeof ctx.completion === 'string' ? ctx.completion : null
  if (!uebergabe && d.project_id) {
    const { data: pc } = await sb.from('crm_projects').select('completion_date').eq('id', d.project_id).maybeSingle()
    uebergabe = ((pc as { completion_date?: string } | null)?.completion_date) ?? null
  }
  const deckBlocks = (d.content?.blocks ?? []) as DeckBlockLite[]
  const hochladen = async (bytes: Uint8Array): Promise<string | null> => {
    const pfad = `datenblatt/${crypto.randomUUID()}.pdf`
    const { error: upErr } = await sb.storage.from('deck-assets').upload(pfad, bytes, { contentType: 'application/pdf', upsert: false })
    if (upErr) { console.warn('[info-paket] PDF-Upload:', upErr.message); return null }
    return `${PORTAL_URL}/unterlagen/${pfad.split('/').pop()}`
  }
  try {
    const bytes = await baueDatenblatt({ blocks: deckBlocks, lage, nr, stand: new Date(), uebergabe })
    pdfB64 = encodeBase64(bytes)
    pdfUrl = await hochladen(bytes)
  } catch (e) { console.error('[info-paket] Datenblatt:', e) }
  // Eigener Zahlungsplan (nur diese Seite) für den Link in der Zahlungsplan-Karte.
  const zahlung = zahlungsUebersicht(deckBlocks, uebergabe)
  if (zahlung) {
    try { zahlplanUrl = await hochladen(await baueDatenblatt({ blocks: deckBlocks, lage, nr, stand: new Date(), uebergabe, nurZahlungsplan: true })) }
    catch (e) { console.error('[info-paket] Zahlungsplan:', e) }
  }

  // 8) Mail bauen
  const lang = await resolveLang(sb, { email: p.email, lead_id: p.kind === 'lead' ? p.id : null })
  const ref = p.kind === 'lead' ? `l:${p.id}` : p.kind === 'sub' ? `s:${p.id}` : ''
  const deckUrl = `${PORTAL_URL}/deck/${d.token}${ref ? `?hpr=${encodeURIComponent(ref)}` : ''}`
  const printUrl = `${PORTAL_URL}/deck/${d.token}/print`
  const terminUrl = p.kind === 'lead' ? bookingUrl(p.bookingToken) : `${PORTAL_URL}/termin?f=none&src=infopaket`
  const frage = typeof b.question === 'string' ? b.question.trim().slice(0, 500) : ''
  const html = mailHtml({
    first: p.first, objekt, lage, gross: grossGesamt, calcUrl, calcUrlCash, deckUrl, printUrl, terminUrl, fotos, fotoStand, frage,
    guide: lang !== 'en', std, markt, pdfUrl, pdfAnhang: !!pdfB64, zahlung, zahlplanUrl,
  })
  const subject = `${p.first ? `${p.first}, d` : 'D'}eine Unterlagen zur ${objekt}`
  const { data: sent, error: sErr } = await sb.functions.invoke('send-email', { body: {
    to: p.email, subject, html, lead_id: p.kind === 'lead' ? p.id : null, auto: true, lang,
    attachments: pdfB64 ? [{ filename: pdfName, content_base64: pdfB64, content_type: 'application/pdf' }] : null,
  } })
  if (sErr || !(sent as { success?: boolean } | null)?.success) {
    console.error('[info-paket] Versand fehlgeschlagen:', sErr)
    return { ok: false, sent: false, reason: 'versand_fehler', calc_url: calcUrl, calc_url_cash: calcUrlCash }
  }
  // Merken, dass das Paket raus ist (Doppel-Schutz, Dashboard „hat das Infopaket bekommen").
  await sb.from('engagement_events').insert({
    type: 'info_paket', token, label: `Wohnung ${nr}`.trim(),
    lead_id: p.kind === 'lead' ? p.id : null, subscriber_id: p.kind === 'sub' ? p.id : null,
    meta: { calc_url: calcUrl, calc_url_cash: calcUrlCash, pdf_url: pdfUrl, quelle: ungefragt ? 'newsletter_klick' : 'anfrage', test: !!INTERN_ADRESSEN.includes(p.email.toLowerCase()) },
  }).then(({ error }) => { if (error) console.warn('[info-paket] Merker:', error.message) })
  return { ok: true, sent: true, calc_url: calcUrl, calc_url_cash: calcUrlCash, deck_url: deckUrl, pdf_url: pdfUrl, to: p.email, annahmen: markt.quelle }
}

function mailHtml(m: {
  first: string; objekt: string; lage: string; gross: number; calcUrl: string; calcUrlCash: string; deckUrl: string; printUrl: string
  terminUrl: string; fotos: string[]; fotoStand: string; frage: string; guide: boolean; std: CalcStandard; markt: Markt
  pdfUrl: string | null; pdfAnhang: boolean
  zahlung: ReturnType<typeof zahlungsUebersicht>; zahlplanUrl: string | null
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
    ${zahlungKarte(m.zahlung, m.zahlplanUrl)}
    ${m.pdfUrl || m.pdfAnhang
      ? karte('📎', 'Datenblatt zur Wohnung', `Grundriss, Eckdaten, Ausstattung, Bilder und der Zahlungsplan: wann wird wie viel fällig. ${m.pdfAnhang ? 'Liegt dieser Mail als PDF bei, ideal' : 'Ideal'} zum Weiterleiten, zum Beispiel an deinen Partner oder Steuerberater.`, 'Datenblatt öffnen', m.pdfUrl ?? m.printUrl)
      : karte('📄', 'Die Wohnung zum Weiterleiten', 'Grundriss, Ausstattung und Zahlungsplan auf einen Blick. Öffne die Druckansicht und speichere sie als PDF, zum Beispiel für deinen Partner oder Steuerberater.', 'Als PDF speichern', m.printUrl)}
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
