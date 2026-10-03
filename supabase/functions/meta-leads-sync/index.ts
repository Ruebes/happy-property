// Edge Function: meta-leads-sync
// Holt Leads aus Meta-Instant-Formularen (Lead Ads) ins CRM. Ohne diese Funktion
// bleiben sie im Werbeanzeigenmanager liegen und niemand erfährt davon — genau das
// passierte bei der Kampagne „13.08.2026 - A/B Test Landing Page" (Formular
// LF21/07/25V4kapital): 12 Leads bei Meta, 0 im CRM (Sven 21.8.26).
//
// Zwei Wege, gleiche Verarbeitung:
//   { action: 'sync', days?: number, form_id?: string }
//        Graph API. Sucht über alle aktiven Lead-Anzeigen des Kontos die
//        Formulare und liest deren Leads. BRAUCHT ein Token mit
//        leads_retrieval + pages_manage_ads (siehe Secrets).
//   { action: 'import_csv', csv: string, form_name?: string }
//        Der CSV-Export aus dem Werbeanzeigenmanager. Funktioniert IMMER, auch
//        ohne erweiterte Token-Rechte — der Weg für den Sofortfall.
//
// Beide legen Leads mit source='meta' an, mit denselben Dubletten-Regeln wie der
// eigene Funnel (Mail, alt_emails, Telefon, alt_phones) und schreiben die
// Formular-Antworten als Notiz + Aktivität an den Lead.
//
// ── Secrets ──
//   META_ACCESS_TOKEN  = System-User-Token. Stand 21.8.26 hat er nur ads_read +
//                        ads_management; für 'sync' muss leads_retrieval und
//                        pages_manage_ads ergänzt werden (Meta Business
//                        Einstellungen → Systembenutzer → Token generieren, dabei
//                        die Seite Happy Property mit auswählen).
//   META_AD_ACCOUNT_ID = 4065490590399677 (Sveru Marketing LLC)
//   META_GRAPH_VERSION = optional (Form vNN.0), sonst v25.0 aus _shared/metaGraph.ts.
//                        Rückweg ohne Neu-Deploy: Secret auf v21.0 setzen.
//
// ── Zuordnung Lead -> Anzeige (Okt 2026) ──
//   Port aus dem Live-Stand v18: utm_term = ad_id beim Anlegen, fehlende Herkunft
//   (utm_*) bei Wiederkehrern nachtragen. Neu: Graph liefert zusätzlich adset_id,
//   campaign_id, form_id; geschrieben nach leads.meta_ad_id/meta_adset_id/
//   meta_campaign_id/meta_form_id/meta_leadgen_id (+ meta_attr_quelle 'leadgen',
//   meta_attr_at). Die Spalten kommen mit 20261003101000_leads_meta_zuordnung.sql;
//   fehlen sie (Deploy vor der Migration), werden sie einfach weggelassen. Ein
//   Lauf prüft das genau einmal (select meta_ad_id limit 1).
//   Token nur im Authorization-Header, nie in der URL (Logs, Fehlertexte).
//
// ── Deployment ──
//   supabase functions deploy meta-leads-sync   (verify_jwt = true, so ist sie live)
//
// ── Aufrufer (Guard am Handler-Anfang, Befund E3-11) ──
//   pg_cron meta-leads-sync-15min → x-cron-secret (connector_secrets CRON_SECRET);
//     wegen verify_jwt=true schickt der Job weiterhin den publishable Key als
//     Authorization, der allein zählt aber NICHT (steht im Frontend-Bundle)
//   manuell (CSV-Import, Sofortfall) → Service-Role-Key oder Login admin/verwalter
//   Kein Aufruf aus App oder anderen Functions.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { GRAPH, metaEnv } from '../_shared/metaGraph.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

interface FieldEntry { name: string; values: string[] }
interface RawLead {
  id: string
  created_time?: string
  field_data?: FieldEntry[]
  ad_id?: string
  ad_name?: string
  adset_id?: string
  campaign_id?: string
  campaign_name?: string
  form_id?: string
  form_name?: string
}

// ── Graph-Aufrufe: Token nur im Header ───────────────────────────────────────
interface GraphAntwort {
  data?: unknown[]
  paging?: { next?: string }
  error?: { message?: string }
}
async function graphJson(url: string, token: string): Promise<GraphAntwort> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  try { return await res.json() as GraphAntwort }
  catch { return { error: { message: `HTTP ${res.status}, keine JSON-Antwort` } } }
}
// Paging-Link von Meta: nur graph.facebook.com, ein eventuell angehängter Token fliegt raus.
function naechsteSeite(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.hostname !== 'graph.facebook.com') return ''
    u.searchParams.delete('access_token')
    return u.toString()
  } catch { return '' }
}

// ── Feste Zuordnung Lead -> Anzeige (leads.meta_*) ───────────────────────────
const META_SPALTEN = ['meta_ad_id', 'meta_adset_id', 'meta_campaign_id', 'meta_form_id', 'meta_leadgen_id', 'meta_attr_quelle', 'meta_attr_at'] as const

// Gibt es die Spalten schon? Einmal je Lauf prüfen, damit ein Deploy vor der
// Migration keinen einzigen Lead verliert.
async function metaSpaltenVorhanden(admin: SupabaseClient): Promise<boolean> {
  try {
    const { error } = await admin.from('leads').select('meta_ad_id').limit(1)
    if (error) console.warn('[meta-leads-sync] leads.meta_* fehlen noch, Zuordnung wird nicht geschrieben')
    return !error
  } catch { return false }
}

const nurId = (v: unknown): string | null => {
  const s = String(v ?? '').trim().replace(/^l:/i, '')
  return /^\d{6,25}$/.test(s) ? s : null
}

function metaZuordnung(raw: RawLead): Record<string, string | null> {
  const ad = nurId(raw.ad_id), adset = nurId(raw.adset_id), kampagne = nurId(raw.campaign_id)
  const leadgen = nurId(raw.id)   // CSV ohne ID-Spalte: "csv-…" -> null
  if (!ad && !adset && !kampagne && !leadgen) return {}
  return {
    meta_ad_id: ad, meta_adset_id: adset, meta_campaign_id: kampagne,
    meta_form_id: nurId(raw.form_id), meta_leadgen_id: leadgen,
    meta_attr_quelle: 'leadgen', meta_attr_at: new Date().toISOString(),
  }
}

const ohneMeta = (row: Record<string, unknown>): Record<string, unknown> => {
  const r = { ...row }
  for (const k of META_SPALTEN) delete r[k]
  return r
}
const hatMeta = (row: Record<string, unknown>) => META_SPALTEN.some(k => k in row)

// Meta liefert Feldnamen je nach Formular unterschiedlich („email", „e-mail",
// „email_address", deutsche Beschriftungen …). Deshalb nach Bedeutung suchen,
// nicht nach exaktem Namen.
const FIELD_MAP: Record<string, RegExp> = {
  email:      /^(e[-_ ]?mail|email_address|mail)$/i,
  phone:      /(phone|telefon|mobil|handy|rufnummer)/i,
  first_name: /(first[-_ ]?name|vorname)/i,
  last_name:  /(last[-_ ]?name|nachname|surname|familienname)/i,
  full_name:  /(full[-_ ]?name|^name$|vollst)/i,
}

function pick(fields: FieldEntry[], key: keyof typeof FIELD_MAP): string {
  const hit = fields.find(f => FIELD_MAP[key].test((f.name ?? '').trim()))
  return (hit?.values ?? [])[0]?.trim() ?? ''
}

const normPhone = (v: string) => v.replace(/[^0-9+]/g, '')

// Ein Lead aus Meta ins CRM übernehmen. Gibt zurück, was passiert ist, damit der
// Aufrufer eine ehrliche Bilanz bekommt (angelegt / ergänzt / übersprungen).
async function upsertLead(admin: SupabaseClient, raw: RawLead, metaSpalten: boolean): Promise<{ status: 'created' | 'updated' | 'skipped'; leadId?: string }> {
  const fields = raw.field_data ?? []
  const email = (pick(fields, 'email') || '').toLowerCase()
  const phone = normPhone(pick(fields, 'phone'))
  if (!email && !phone) return { status: 'skipped' }          // ohne Kontaktweg wertlos

  let first = pick(fields, 'first_name')
  let last  = pick(fields, 'last_name')
  if (!first) {
    const full = pick(fields, 'full_name')
    if (full) { const parts = full.split(/\s+/); first = parts[0]; last = last || parts.slice(1).join(' ') }
  }
  if (!first) first = email ? email.split('@')[0] : 'Meta-Lead'

  // Alle übrigen Antworten als Notiz — die Qualifizierung steckt oft genau dort.
  const answers = fields
    .filter(f => !Object.values(FIELD_MAP).some(re => re.test((f.name ?? '').trim())))
    .map(f => `• ${f.name}: ${(f.values ?? []).join(', ')}`)
    .join('\n')
  const herkunft = [raw.campaign_name && `Kampagne: ${raw.campaign_name}`,
                    raw.form_name && `Formular: ${raw.form_name}`,
                    raw.created_time && `Eingegangen: ${new Date(raw.created_time).toLocaleString('de-DE')}`]
    .filter(Boolean).join('\n')
  const notiz = `Meta-Formular (Instant Form):\n${answers || '— keine weiteren Angaben —'}\n${herkunft}`

  // Dubletten: gleiche Regeln wie im eigenen Funnel.
  let leadId: string | null = null
  if (email) {
    const { data } = await admin.from('leads').select('id').ilike('email', email).limit(1)
    if (data?.length) leadId = (data[0] as { id: string }).id
    if (!leadId) {
      const { data: alt } = await admin.from('leads').select('id').contains('alt_emails', [email]).limit(1)
      if (alt?.length) leadId = (alt[0] as { id: string }).id
    }
  }
  if (!leadId && phone) {
    const { data } = await admin.from('leads').select('id').or(`phone.eq.${phone},whatsapp.eq.${phone}`).limit(1)
    if (data?.length) leadId = (data[0] as { id: string }).id
    if (!leadId) {
      const { data: alt } = await admin.from('leads').select('id').contains('alt_phones', [phone]).limit(1)
      if (alt?.length) leadId = (alt[0] as { id: string }).id
    }
    // Letzte 9 Ziffern vergleichen: gespeicherte Nummern haben oft eine doppelte
    // Laendervorwahl oder Leerzeichen ("+49491715260389"), der exakte Vergleich
    // uebersieht dieselbe Person dann komplett.
    if (!leadId) {
      const tail = phone.replace(/\D/g, '').slice(-9)
      if (tail.length === 9) {
        const { data: like } = await admin.from('leads').select('id')
          .or(`phone.like.%${tail},whatsapp.like.%${tail}`).limit(1)
        if (like?.length) leadId = (like[0] as { id: string }).id
      }
    }
  }

  let ergebnis: 'created' | 'updated'
  if (leadId) {
    const basis = 'notes, utm_source, utm_campaign, utm_content, utm_term'
    let { data: old, error: oldErr } = await admin.from('leads')
      .select(metaSpalten ? `${basis}, meta_ad_id, meta_adset_id, meta_campaign_id, meta_leadgen_id` : basis)
      .eq('id', leadId).maybeSingle()
    // Ohne gelesene Notiz würde die Dubletten-Sperre unten nicht greifen und
    // jeder Lauf hängt dieselbe Notiz erneut an: im Zweifel ohne meta_* lesen.
    if (oldErr && metaSpalten) ({ data: old, error: oldErr } = await admin.from('leads').select(basis).eq('id', leadId).maybeSingle())
    if (oldErr) { console.error('[meta-leads-sync] Lead lesen:', oldErr.message); return { status: 'skipped', leadId } }
    const prev = (old as { notes?: string } | null)?.notes ?? ''
    if (prev.includes(`Meta-Lead-ID: ${raw.id}`)) return { status: 'skipped', leadId }    // schon drin
    const patch: Record<string, unknown> = {
      notes: `${prev ? prev + '\n\n' : ''}${notiz}\nMeta-Lead-ID: ${raw.id}`,
    }
    // Herkunft nachtragen, wenn der bestehende Datensatz noch keine hat. Ohne das
    // verliert jeder Wiederkehrer seine Anzeigen-Zuordnung, und genau die brauchen
    // wir, um Kosten pro Termin je Werbemittel zu rechnen.
    const alt = (old ?? {}) as Record<string, string | null>
    if (!alt.utm_source) { patch.utm_source = 'meta'; patch.utm_medium = 'lead_ad' }
    if (!alt.utm_campaign && raw.campaign_name) patch.utm_campaign = raw.campaign_name
    if (!alt.utm_content && raw.ad_name) patch.utm_content = raw.ad_name
    if (!alt.utm_term && raw.ad_id) patch.utm_term = raw.ad_id
    // Feste Zuordnung nur, wenn der Lead noch gar keine hat: die erste Anzeige
    // bleibt stehen, genau wie bei den utm_*-Feldern oben.
    if (metaSpalten && 'meta_ad_id' in alt && !alt.meta_ad_id && !alt.meta_adset_id && !alt.meta_campaign_id && !alt.meta_leadgen_id) {
      Object.assign(patch, metaZuordnung(raw))
    }
    const { error: upErr } = await admin.from('leads').update(patch).eq('id', leadId)
    if (upErr && hatMeta(patch)) {
      console.warn('[meta-leads-sync] Update mit meta_* fehlgeschlagen, ohne:', upErr.message)
      await admin.from('leads').update(ohneMeta(patch)).eq('id', leadId)
    }
    ergebnis = 'updated'
  } else {
    const neu: Record<string, unknown> = {
      first_name: first, last_name: last || '',
      email: email || null, phone: phone || null, whatsapp: phone || null,
      source: 'meta',
      utm_source: 'meta', utm_medium: 'lead_ad',
      utm_campaign: raw.campaign_name ?? null, utm_content: raw.ad_name ?? null,
      // Anzeigen-ID ist der einzige stabile Schluessel zu ad_insights_daily -
      // Anzeigennamen werden umbenannt und doppelt vergeben.
      utm_term: raw.ad_id ?? null,
      ...(metaSpalten ? metaZuordnung(raw) : {}),
      notes: `${notiz}\nMeta-Lead-ID: ${raw.id}`,
    }
    let { data: nl, error } = await admin.from('leads').insert(neu).select('id').single()
    // Spaltenfehler bei meta_* (z.B. Migration zurückgerollt): Lead trotzdem anlegen.
    if (error && hatMeta(neu) && /meta_/.test(String(error.message ?? ''))) {
      console.warn('[meta-leads-sync] Insert mit meta_* fehlgeschlagen, ohne:', error.message)
      ;({ data: nl, error } = await admin.from('leads').insert(ohneMeta(neu)).select('id').single())
    }
    if (error) { console.error('[meta-leads-sync] Lead-Insert:', error.message); return { status: 'skipped' } }
    leadId = (nl as { id: string }).id
    ergebnis = 'created'
  }

  try {
    await admin.from('activities').insert({
      lead_id: leadId, type: 'note', direction: 'inbound',
      subject: `Meta-Formular${raw.form_name ? `: ${raw.form_name}` : ''}`,
      content: notiz.slice(0, 2000),
      completed_at: raw.created_time ?? new Date().toISOString(),
      auto: true,
    })
  } catch (e) { console.warn('[meta-leads-sync] Aktivität:', e) }
  return { status: ergebnis, leadId }
}

// CSV aus dem Werbeanzeigenmanager. Meta exportiert je nach Sprache mit Komma
// oder Semikolon und schreibt die Feldnamen in die Kopfzeile.
function parseCsv(csv: string): RawLead[] {
  const text = csv.replace(/^﻿/, '').trim()
  if (!text) return []
  const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let cur: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === sep) { cur.push(field); field = '' }
    else if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field || cur.length) { cur.push(field); rows.push(cur) }
  if (rows.length < 2) return []
  const head = rows[0].map(h => h.trim())
  return rows.slice(1).filter(r => r.some(c => c.trim())).map((r, idx) => {
    const get = (re: RegExp) => { const i = head.findIndex(h => re.test(h)); return i >= 0 ? (r[i] ?? '').trim() : '' }
    const field_data: FieldEntry[] = head.map((h, i) => ({ name: h, values: [(r[i] ?? '').trim()] }))
      .filter(f => f.values[0])
    return {
      id: get(/^(id|lead[_ ]?id)$/i) || `csv-${Date.now()}-${idx}`,
      created_time: get(/(created|erstellt|zeit|date)/i) || undefined,
      campaign_name: get(/campaign|kampagne/i) || undefined,
      ad_name: get(/^ad[_ ]?name|anzeige/i) || undefined,
      form_name: get(/form[_ ]?name|formular/i) || undefined,
      field_data,
    }
  })
}


// ── Anschluss: Pipeline, Sequenz, Terminanfrage ─────────────────────────────
// Sven 23.8.: "Baue es so, dass du diese Leads im besten Fall immer sofort
// abholst und denen eine WhatsApp sendest, wenn WhatsApp nicht geht, dann per
// Mail. Ziel: Termin machen." Die Anfrage kommt von SVEN persoenlich (Quelle
// meta_formular im booking-bot), nicht von Lotte - die Leute kennen ihn nicht.
async function starteErstkontakt(admin: SupabaseClient, leadId: string): Promise<string> {
  // 1. Deal in der Pipeline (Phase Erstkontakt), falls noch keiner offen ist
  const { data: vorhanden } = await admin.from('deals').select('id')
    .eq('lead_id', leadId).not('phase', 'in', '(archiviert,deal_verloren)').limit(1)
  let dealId = (vorhanden?.[0] as { id: string } | undefined)?.id ?? null
  if (!dealId) {
    const { data: nd } = await admin.from('deals')
      .insert({ lead_id: leadId, phase: 'erstkontakt', source: 'meta_lead_form', phase_changed_at: new Date().toISOString() })
      .select('id').single()
    dealId = (nd as { id: string } | null)?.id ?? null
  }

  // 2. Erstkontakt-Sequenz planen (Tag 1/3/5/14) …
  try { await admin.functions.invoke('schedule-message', { body: { lead_id: leadId, deal_id: dealId, event_type: 'erstkontakt' } }) }
  catch (e) { console.warn('[meta-leads-sync] schedule-message:', e) }
  // … und die 20-Minuten-Stufe streichen: sie wuerde direkt neben Svens
  // persoenlicher Nachricht fast dasselbe von Lotte schicken.
  try {
    await admin.from('scheduled_messages')
      .update({ status: 'cancelled', error_message: 'Ersetzt durch persoenliche Erstkontakt-WhatsApp von Sven' })
      .eq('lead_id', leadId).eq('status', 'pending')
      .lt('scheduled_at', new Date(Date.now() + 90 * 60e3).toISOString())
  } catch (e) { console.warn('[meta-leads-sync] 20-Min-Stufe:', e) }

  // 3. Terminanfrage: zuerst WhatsApp ueber den Termin-Bot (echte freie Slots,
  //    Dialog laeuft danach automatisch weiter).
  const { data: lead } = await admin.from('leads').select('first_name, whatsapp, phone, email').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; whatsapp: string | null; phone: string | null; email: string | null } | null
  if (l?.whatsapp || l?.phone) {
    try {
      const { data } = await admin.functions.invoke('booking-bot', { body: { action: 'start', lead_id: leadId, deal_id: dealId, source: 'meta_formular' } })
      const r = data as { ok?: boolean; skipped?: string } | null
      if (r?.ok && !r.skipped) return 'whatsapp'
      console.warn('[meta-leads-sync] Bot uebersprungen:', r?.skipped)
    } catch (e) { console.warn('[meta-leads-sync] booking-bot:', e) }
  }

  // 4. Kein WhatsApp moeglich (keine Nummer, Nummer ungueltig, Bot blockiert)
  //    -> derselbe Inhalt per Mail, mit dem persoenlichen Buchungslink.
  if (l?.email) {
    const name = (l.first_name ?? '').trim()
    const link = 'https://portal.happy-property.com/buchen/sven360'
    const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:#2b2b2b;max-width:600px;margin:0 auto">`
      + `<p style="margin:0 0 16px">Moin${name ? ` ${name}` : ''},</p>`
      + `<p style="margin:0 0 16px">vielen Dank für das Ausfüllen unseres Fragebogens und dein Interesse an Immobilien auf der Insel, wo die Götter Urlaub machen.</p>`
      + `<p style="margin:0 0 16px">Ich bin Sven, ich lebe hier auf Zypern und begleite deutschsprachige Kapitalanleger und Auswanderer beim Immobilienkauf. Ich freue mich, deine persönliche Situation einmal in Ruhe mit dir zu besprechen - per WhatsApp-Anruf oder Zoom, ganz wie es dir lieber ist. Rechne mit etwa 15 Minuten, unverbindlich.</p>`
      + `<p style="margin:0 0 22px"><a href="${link}" style="display:inline-block;background:#ff795d;color:#ffffff;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:8px">Termin aussuchen →</a></p>`
      + `<p style="margin:0 0 6px">Viele Grüße</p><p style="margin:0"><strong>Sven · Happy Property Cyprus</strong></p></div>`
    try {
      await admin.functions.invoke('send-email', { body: {
        to: l.email, subject: 'Dein Fragebogen - lass uns kurz sprechen', html, lead_id: leadId,
      } })
      return 'email'
    } catch (e) { console.warn('[meta-leads-sync] Mail-Fallback:', e) }
  }
  return 'kein_kontaktweg'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  // Vorher reichte jeder gültige Gateway-Schlüssel: mit dem öffentlichen publishable
  // Key konnte jeder per import_csv beliebige Nummern anschreiben lassen (als Sven).
  const denied = await gateCaller(req, 'meta-leads-sync', { cron: true, service: true, roles: ['admin', 'verwalter'] }, CORS)
  if (denied) return denied
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as { action?: string; days?: number; csv?: string; form_name?: string; form_id?: string }
    const action = body.action ?? 'sync'

    // ── CSV-Import (immer möglich) ────────────────────────────────
    if (action === 'import_csv') {
      if (!body.csv) return json({ error: 'csv fehlt' }, 400)
      const leads = parseCsv(body.csv)
      if (!leads.length) return json({ error: 'CSV enthält keine Zeilen' }, 400)
      const metaSpalten = await metaSpaltenVorhanden(admin)
      let created = 0, updated = 0, skipped = 0
      const kontaktiert: string[] = []
      for (const l of leads) {
        if (body.form_name && !l.form_name) l.form_name = body.form_name
        const r = await upsertLead(admin, l, metaSpalten)
        if (r.status === 'created') { created++; if (r.leadId) kontaktiert.push(await starteErstkontakt(admin, r.leadId)) }
        else if (r.status === 'updated') updated++; else skipped++
      }
      console.log(`[meta-leads-sync] CSV: ${created} neu, ${updated} ergänzt, ${skipped} übersprungen`)
      return json({ success: true, gelesen: leads.length, angelegt: created, ergaenzt: updated, uebersprungen: skipped, kontaktiert })
    }

    // ── Graph-API-Abruf ───────────────────────────────────────────
    const { token, account, pageId } = metaEnv()
    if (!token) return json({ error: 'META_ACCESS_TOKEN fehlt' }, 500)
    const days = Math.min(90, Math.max(1, body.days ?? 30))
    const since = Math.floor((Date.now() - days * 86400e3) / 1000)

    // Formulare finden: entweder direkt übergeben, sonst über die Lead-Anzeigen
    // des Kontos (dort steht die Formular-ID im Creative).
    let formIds: string[] = body.form_id ? [body.form_id] : []
    if (!formIds.length) {
      // Die Formular-ID steckt je nach Anzeigentyp an zwei Stellen: klassisch im
      // object_story_spec, bei Advantage+/Dynamischen Anzeigen dagegen im
      // asset_feed_spec.call_to_actions — genau dort lag sie bei „Investment 12
      // Jahre abbezahlt 2" (Formular LF 21/07/25 V4 Kapital). Beide prüfen.
      const adsJson = await graphJson(`${GRAPH}/act_${account}/ads?fields=id,name,creative{object_story_spec,asset_feed_spec}&limit=200`, token)
      if (adsJson?.error) return json({ error: `Meta: ${adsJson.error.message}`, hinweis: 'Für den Abruf braucht der Token leads_retrieval + pages_manage_ads.' }, 502)
      type Cta = { value?: { lead_gen_form_id?: string } }
      for (const ad of (adsJson?.data ?? []) as Array<{ creative?: {
        object_story_spec?: { link_data?: { call_to_action?: Cta }; video_data?: { call_to_action?: Cta } }
        asset_feed_spec?: { call_to_actions?: Cta[] } } }>) {
        const spec = ad.creative?.object_story_spec
        const ids = [
          spec?.link_data?.call_to_action?.value?.lead_gen_form_id,
          spec?.video_data?.call_to_action?.value?.lead_gen_form_id,
          ...((ad.creative?.asset_feed_spec?.call_to_actions ?? []).map(c => c.value?.lead_gen_form_id)),
        ]
        for (const id of ids) if (id && !formIds.includes(id)) formIds.push(id)
      }
    }
    // Zusaetzlich ALLE Formulare der Seite: der Weg ueber die Anzeigen findet nur
    // Formulare AKTIVER Anzeigen - laeuft eine Kampagne aus, blieben die Leads der
    // letzten Tage unentdeckt liegen (gemessen 23.8.: der Anzeigen-Weg fand nur das
    // frische, leere Formular, waehrend im alten 14 Leads lagen).
    try {
      // leadgen_forms verlangt einen SEITEN-Token - den holt der System-User-Token
      // ueber /me/accounts (gemessen 23.8.: mit dem System-Token direkt kommt
      // "(#190) This method must be called with a Page Access Token").
      let pageToken = token
      try {
        const aj = await graphJson(`${GRAPH}/me/accounts?fields=id,access_token`, token) as { data?: Array<{ id: string; access_token?: string }> }
        const own = (aj.data ?? []).find(p => p.id === pageId) ?? (aj.data ?? [])[0]
        if (own?.access_token) pageToken = own.access_token
      } catch (e) { console.warn('[meta-leads-sync] Seiten-Token:', e) }
      const pj = await graphJson(`${GRAPH}/${pageId}/leadgen_forms?fields=id,name,leads_count&limit=100`, pageToken) as { data?: Array<{ id: string; leads_count?: number }>; error?: { message?: string } }
      if (pj.error) console.warn('[meta-leads-sync] Seiten-Formulare:', pj.error.message)
      for (const f of (pj.data ?? [])) {
        if ((f.leads_count ?? 0) > 0 && !formIds.includes(f.id)) formIds.push(f.id)
      }
    } catch (e) { console.warn('[meta-leads-sync] Seiten-Formulare:', e) }

    if (!formIds.length) return json({ success: true, hinweis: 'Keine Lead-Formulare gefunden.', angelegt: 0 })

    const metaSpalten = await metaSpaltenVorhanden(admin)
    let created = 0, updated = 0, skipped = 0
    const kontaktiert: string[] = []
    const fehler: string[] = []
    for (const fid of formIds) {
      let url = `${GRAPH}/${fid}/leads?fields=id,created_time,field_data,ad_id,ad_name,adset_id,campaign_id,campaign_name,form_id&filtering=[{"field":"time_created","operator":"GREATER_THAN","value":${since}}]&limit=100`
      for (let page = 0; page < 20 && url; page++) {
        const j = await graphJson(url, token)
        if (j?.error) { fehler.push(`Formular ${fid}: ${j.error.message}`); break }
        for (const l of (j?.data ?? []) as RawLead[]) {
          const r = await upsertLead(admin, l, metaSpalten)
          if (r.status === 'created') { created++; if (r.leadId) kontaktiert.push(await starteErstkontakt(admin, r.leadId)) }
          else if (r.status === 'updated') updated++; else skipped++
        }
        url = naechsteSeite(j?.paging?.next)
      }
    }
    console.log(`[meta-leads-sync] ${created} neu, ${updated} ergänzt, ${skipped} übersprungen, ${formIds.length} Formulare, kontaktiert: ${kontaktiert.join(',') || '-'}`)
    return json({ success: fehler.length === 0, formulare: formIds.length, angelegt: created, ergaenzt: updated, uebersprungen: skipped, kontaktiert,
      ...(fehler.length ? { fehler, hinweis: 'Fehlen Rechte, im Meta Business Manager einen System-User-Token mit leads_retrieval + pages_manage_ads erzeugen.' } : {}) })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[meta-leads-sync]', msg)
    return json({ error: msg }, 500)
  }
})
