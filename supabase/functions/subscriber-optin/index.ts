// subscriber-optin — öffentliche Anmelde-Strecke (Lead-Magnet / Webinar / Newsletter).
// Sammelt Adressen selbst (bisher kamen alle nur aus dem Klaviyo-Import) und schreibt
// sie DSGVO-konform per Double-Opt-In in newsletter_subscribers + newsletter_list_members.
//
// Aktionen:
//   POST { email?, phone?, contact?, first_name?, last_name?, list, source?, lang? }
//        → Abonnent anlegen/finden, Bestätigung (DOI) verschicken.
//          Bereits bestätigte (z.B. Klaviyo-Import) werden ohne DOI direkt zur Liste
//          hinzugefügt.
//          `contact` ist das EINE Feld der Landingpage: enthält es ein "@", ist es eine
//          E-Mail (→ Bestätigungsmail), sonst eine Telefonnummer (→ Bestätigung per
//          WhatsApp). Damit entscheidet der Abonnent selbst, auf welchem Kanal er den
//          Newsletter bekommt — ohne ihn nach einem Kanal zu fragen.
//   GET  ?confirm=<token>  → Bestätigung, Liste zuordnen, Danke-Seite (HTML).
//
// Double-Opt-In-Status liegt in newsletter_subscribers.properties (jsonb):
//   { doi_token, doi_pending_list, doi_confirmed:true, doi_confirmed_at }
// — bewusst KEIN Schema-Zwang (Management-API-DDL aktuell geblockt).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy subscriber-optin --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const normEmail = (e: string) => e.trim().toLowerCase().replace('googlemail.com', 'gmail.com')

// ── Missbrauchsschutz (öffentliche Funktion) ─────────────────────────────────
// Freitext aus dem Formular landet in WhatsApp-Text und Mail-HTML. Gespeichert
// wird er ohne Tags/Steuerzeichen und gekürzt; in die Bestätigung kommt der
// Vorname nur, wenn er nicht nach Link/Adresse aussieht (sonst Anrede ohne Namen).
const cleanText = (s: unknown, max: number) =>
  String(s ?? '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max)
const greetName = (s: unknown) => {
  const n = cleanText(s, 40)
  return /https?:|www\.|@|[\w-]\.[a-z]{2,}/i.test(n) ? '' : n
}
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// ilike ohne Platzhalter: _, % und * (PostgREST-Joker) in Adresse/Listenname
// wären sonst Joker und träfen fremde Einträge.
const ilikeExact = (s: string) => s.replace(/([\\%_*])/g, '\\$1')
// Bestätigungen drosseln: je Kontakt frühestens nach 2 Min erneut und höchstens
// 5 pro 24 h (nur ERFOLGREICH verschickte zählen), insgesamt höchstens
// DOI_MAX_PER_HOUR pro Stunde (Schutz der WhatsApp-Nummer und des Mail-Kontingents).
const DOI_MIN_GAP_MS = 2 * 60_000
const DOI_MAX_PER_DAY = 5
const DOI_MAX_PER_HOUR = 60
// Pro Absender-Anschluss (Review S1): sonst füllt ein einzelner Absender mit
// Zufallsadressen das Stundenlimit und blockiert alle echten Anmeldungen.
const DOI_MAX_PER_IP_HOUR = 5

// Adress-Familie für die Drosselung: name+1@… und name+2@… landen im selben
// Postfach, bei Gmail zählen auch Punkte im Namen nicht (Review S1).
const familyKey = (e: string) => {
  const at = e.lastIndexOf('@')
  if (at < 1) return e
  const dom = e.slice(at + 1)
  let local = e.slice(0, at).split('+')[0]
  if (dom === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${dom}`
}

// Absender-Anschluss nur gehasht (HMAC, keine Klar-IP in der Datenbank).
// cf-connecting-ip (setzt Cloudflare selbst), sonst das erste x-forwarded-for-
// Element wie in wa-track (IP-Sperrliste für interne Besucher). Ein
// gefälschter x-forwarded-for-Wert kann das Limit nur umgehen, niemanden
// aussperren. Private/leere Adressen: keine Anschluss-Bremse (nie alle sperren).
async function clientIpHash(req: Request): Promise<string> {
  const ip = (req.headers.get('cf-connecting-ip') ?? (req.headers.get('x-forwarded-for') ?? '').split(',')[0] ?? '').trim()
  if (!ip || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i.test(ip)) return ''
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'subscriber-optin'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(ip)))
  return Array.from(mac.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('')
}

// Wohin es nach dem Bestätigungsklick geht. Jede Anmeldestrecke kann ihre eigene
// Danke-Seite mitgeben (`confirm_redirect`), sonst landet man hier.
const DEFAULT_REDIRECT = 'https://steuervorteil-zypern-immobilien.com/danke-fuer-deine-anmeldung/'
// Nur eigene Domains — sonst wäre die öffentliche Funktion eine Weiterleitung
// auf beliebige fremde Seiten (offener Redirect, klassisches Phishing-Werkzeug).
const ERLAUBTE_HOSTS = ['steuervorteil-zypern-immobilien.com', 'happy-property.com', 'happy-property.de']
function erlaubtesZiel(url: string | undefined): string {
  if (!url) return DEFAULT_REDIRECT
  try {
    const u = new URL(url)
    const ok = u.protocol === 'https:' && ERLAUBTE_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))
    return ok ? u.toString() : DEFAULT_REDIRECT
  } catch { return DEFAULT_REDIRECT }
}
// Weiterleitung mit Ergebnis-Merker, den die Danke-Seite ausliest.
function zurueck(ziel: string, status: 'ja' | 'abgelaufen'): Response {
  const u = new URL(ziel)
  u.searchParams.set('bestaetigt', status)
  return new Response(null, { status: 302, headers: { ...CORS, Location: u.toString() } })
}

// Telefonnummer auf E.164 bringen. Zielgruppe ist deutschsprachig, deshalb ist
// die Vorwahl für "0…" Deutschland; wer aus AT/CH/CY kommt, tippt ohnehin +43/+41/+357.
function normPhone(raw: string): string {
  let s = String(raw ?? '').replace(/[^\d+]/g, '')
  if (s.startsWith('00')) s = '+' + s.slice(2)
  else if (s.startsWith('0')) s = '+49' + s.slice(1)
  else if (!s.startsWith('+')) s = '+' + s
  return s
}
// Sieht der Wert nach einer anrufbaren Nummer aus? (Landesvorwahl + 6–14 Ziffern)
const looksLikePhone = (s: string) => /^\+\d{8,15}$/.test(normPhone(s))

// Liste per Name finden oder anlegen (Sven kann ein Formular auf jeden Listennamen zeigen).
async function resolveList(sb: SupabaseClient, name: string): Promise<{ id: string; name: string } | null> {
  const clean = name.trim().slice(0, 80)
  if (!clean) return null
  // Robust gegen doppelte Namen: älteste passende Liste nehmen (maybeSingle würde
  // bei Mehrdeutigkeit fehlschlagen und fälschlich eine neue Liste anlegen).
  const { data: matches } = await sb.from('newsletter_lists').select('id, name').ilike('name', ilikeExact(clean)).order('created_at', { ascending: true }).limit(1)
  const found = (matches as { id: string; name: string }[] | null)?.[0]
  if (found) return found
  // source ist per CHECK-Constraint auf 'manual' | 'klaviyo' beschränkt → 'manual'.
  const { data: created, error } = await sb.from('newsletter_lists').insert({ name: clean, source: 'manual', active: true }).select('id, name').single()
  if (error) { console.error('[subscriber-optin] list insert:', error.message); return null }
  return (created as { id: string; name: string }) ?? null
}

// Abonnent in die aktiven Automations-Sequenzen einer Liste einschreiben und die
// Schritte in scheduled_messages einplanen (der bestehende Scheduler versendet sie,
// resolveSubscriber liefert E-Mail + Telefon). Idempotent über sequence_enrollments.
async function enrollInListSequences(sb: SupabaseClient, subscriberId: string, listId: string): Promise<void> {
  // FLOW-BUILDER: Schritte bilden einen Baum — Delay-Blöcke addieren Zeit,
  // Splits (Wenn/Dann: E-Mail geöffnet?) verzweigen in Ja/Nein-Äste. Beide Äste
  // werden VORAUSGEPLANT; die Bedingung wird beim VERSAND geprüft (seq_condition
  // in process-scheduled-messages) — nur der zutreffende Ast feuert wirklich.
  try {
    const { data: seqs } = await sb.from('list_sequences').select('id').eq('list_id', listId).eq('active', true)
    const sequences = (seqs as { id: string }[] | null) ?? []
    if (!sequences.length) return
    const { data: subRow } = await sb.from('newsletter_subscribers').select('first_name, email, phone').eq('id', subscriberId).maybeSingle()
    const subInfo = subRow as { first_name: string | null; email: string | null; phone: string | null } | null
    const first = (subInfo?.first_name ?? '').trim()
    const subEmail = (subInfo?.email ?? '').trim()
    const subPhone = (subInfo?.phone ?? '').trim()
    const fill = (x: string | null | undefined) => (x ?? '')
      .replace(/\{\{\s*(vorname|first_name|name)\s*\}\}/gi, first || '')
      .replace(/\{\{\s*abmelden_link\s*\}\}/gi, `https://portal.happy-property.com/abmelden?s=${subscriberId}`)
      .replace(/(Hallo|Hi)\s+,/g, '$1,')
      .replace(/[ \t]+\n/g, '\n')
    const now = Date.now()
    for (const seq of sequences) {
      const { data: existing } = await sb.from('sequence_enrollments').select('id').eq('sequence_id', seq.id).eq('subscriber_id', subscriberId).maybeSingle()
      if (existing) continue
      const { error: enErr } = await sb.from('sequence_enrollments').insert({ sequence_id: seq.id, subscriber_id: subscriberId })
      if (enErr) { console.warn('[subscriber-optin] enroll:', enErr.message); continue }
      const { data: stepsRaw } = await sb.from('sequence_steps').select('*').eq('sequence_id', seq.id).eq('active', true).order('step_order', { ascending: true })
      const all = (stepsRaw as Array<Record<string, unknown>> | null) ?? []
      const rows: Array<Record<string, unknown>> = []
      const kids = (pid: string, br: string) => all.filter(x => x.parent_split_id === pid && x.branch === br)
      const walk = (list: Array<Record<string, unknown>>, startMin: number, cond: Record<string, unknown> | null) => {
        let tMin = startMin
        for (const st of list) {
          const type = String(st.step_type ?? st.channel ?? 'email')
          if (type === 'delay') { tMin += Number(st.delay_minutes ?? 0); continue }
          if (type === 'split') {
            const wait = (Number(st.split_wait_hours ?? 24)) * 60
            walk(kids(String(st.id), 'yes'), tMin + wait, { kind: 'email_opened' })
            walk(kids(String(st.id), 'no'),  tMin + wait, { kind: 'email_opened', negate: true })
            break // Split beendet die Ebene (Editor erzwingt das auch)
          }
          tMin += Number(st.delay_minutes ?? 0)
          if (type === 'list_update') {
            rows.push({ subscriber_id: subscriberId, type: 'list_update', event_type: 'newsletter', status: 'pending',
              scheduled_at: new Date(now + tMin * 60_000).toISOString(),
              seq_list_op: String(st.list_op ?? 'add'), seq_list_target: st.list_target ?? null,
              ...(cond ? { seq_condition: cond } : {}) })
            continue
          }
          // Nur Kanäle einplanen, die der Abonnent auch hat — sonst würde die
          // Zeile beim Versand als Fehler enden (z.B. WhatsApp-only-Abonnent).
          const wantsMail = type !== 'whatsapp' && !!subEmail && !!(st.email_body as string | null)
          const wantsWa   = type !== 'email' && !!subPhone && !!(st.whatsapp_text as string | null)
          if (!wantsMail && !wantsWa) continue
          rows.push({ subscriber_id: subscriberId, type: wantsMail && wantsWa ? 'both' : wantsMail ? 'email' : 'whatsapp',
            event_type: 'newsletter', status: 'pending',
            scheduled_at: new Date(now + tMin * 60_000).toISOString(),
            email_subject: wantsMail ? fill(st.email_subject as string) : null,
            email_body: wantsMail ? fill(st.email_body as string) : null,
            whatsapp_text: wantsWa ? fill(st.whatsapp_text as string) : null,
            whatsapp_image_url: wantsWa ? ((st.whatsapp_image_url as string) || null) : null,
            ...(cond ? { seq_condition: cond } : {}) })
        }
      }
      walk(all.filter(x => !x.parent_split_id), 0, null)
      if (rows.length) {
        const { error: schErr } = await sb.from('scheduled_messages').insert(rows)
        if (schErr) console.warn('[subscriber-optin] schedule steps:', schErr.message)
      }
    }
  } catch (e) { console.warn('[subscriber-optin] enrollInListSequences:', e) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const base = Deno.env.get('SUPABASE_URL')!

  try {
    // ── GET: Bestätigung (Double-Opt-In) ──────────────────────────────────────
    // Wir liefern hier bewusst KEIN eigenes HTML mehr aus: Supabase schickt
    // Edge-Function-Antworten mit `content-type: text/plain` + `nosniff` (Schutz
    // davor, dass jemand Phishing-Seiten auf *.supabase.co hostet). Der Browser
    // zeigte den Quelltext deshalb als Text an, inklusive kaputter Umlaute.
    // Stattdessen: zurück auf die eigene Website.
    if (req.method === 'GET') {
      // Öffnungs-Pixel für Sequenz-Mails an Abonnenten (Split „E-Mail geöffnet?")
      const openSub = new URL(req.url).searchParams.get('open') ?? ''
      if (openSub) {
        try {
          // Dedupe wie in track-engagement: Mail-Programme (Gmail-Proxy, Vorschau)
          // laden den Pixel mehrfach — dieselbe Öffnung nur einmal je 2 h zählen.
          const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
          const { data: dup } = await sb.from('engagement_events')
            .select('id').eq('type', 'email_open').eq('subscriber_id', openSub)
            .gte('occurred_at', since).limit(1)
          if (!dup || !dup.length) {
            // Abonnent, der auch als Lead im CRM steht: Lead-Bezug mitschreiben,
            // damit die Öffnung in der Lead-Akte auftaucht und das Dashboard den
            // Namen kennt (sonst stand dort „Jemand hat deine E-Mail geöffnet").
            const { data: sub } = await sb.from('newsletter_subscribers')
              .select('email').eq('id', openSub).maybeSingle()
            const mail = ((sub as { email?: string | null } | null)?.email ?? '').trim()
            let leadId: string | null = null
            if (mail) {
              // ilike statt eq (Groß-/Kleinschreibung egal), aber _ und % in der
              // Adresse sind Platzhalter und würden fremde Leads treffen → maskieren.
              const muster = mail.replace(/([\\%_])/g, '\\$1')
              const { data: lead } = await sb.from('leads')
                .select('id').ilike('email', muster).limit(1)
              leadId = ((lead ?? [])[0] as { id?: string } | undefined)?.id ?? null
            }
            await sb.from('engagement_events').insert({ type: 'email_open', subscriber_id: openSub, lead_id: leadId, label: 'sequence' })
          }
        }
        catch (e) { console.warn('[subscriber-optin] open-pixel:', e) }
        const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0))
        return new Response(gif, { headers: { ...CORS, 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } })
      }
      const token = new URL(req.url).searchParams.get('confirm') ?? ''
      if (!token) return zurueck(DEFAULT_REDIRECT, 'abgelaufen')
      const { data: sub } = await sb.from('newsletter_subscribers').select('id, first_name, email, phone, properties').eq('properties->>doi_token', token).maybeSingle()
      const s = sub as { id: string; first_name: string | null; email: string | null; phone: string | null; properties: Record<string, unknown> | null } | null
      if (!s) return zurueck(DEFAULT_REDIRECT, 'abgelaufen')
      const props = { ...(s.properties ?? {}) }
      const listId = props.doi_pending_list as string | undefined
      const ziel = erlaubtesZiel(props.doi_redirect as string | undefined)
      delete props.doi_token; delete props.doi_pending_list
      props.doi_confirmed = true; props.doi_confirmed_at = new Date().toISOString()
      // Willkommensnachricht nur EINMAL (Doppelklicks auf den Bestätigungslink)
      const sendWelcome = !props.welcome_sent_at
      if (sendWelcome) props.welcome_sent_at = new Date().toISOString()
      await sb.from('newsletter_subscribers').update({ properties: props, optout_at: null }).eq('id', s.id)
      if (listId) {
        await sb.from('newsletter_list_members').upsert({ list_id: listId, subscriber_id: s.id }, { onConflict: 'list_id,subscriber_id' })
        await enrollInListSequences(sb, s.id, listId)
      }
      // Willkommensnachricht kommt seit 4.8.26 aus dem WORKFLOW
      // „Willkommensnachricht (nach Anmeldung)" (Funnel → Workflows, Liste
      // Newsletter) — enrollInListSequences oben plant sie ein. Der frühere
      // hartkodierte Versand wurde entfernt; welcome_sent_at bleibt als Marker.
      return zurueck(ziel, 'ja')
    }

    // ── POST: Anmeldung (schickt Double-Opt-In-Mail) ─────────────────────────
    const body = await req.json().catch(() => ({})) as {
      email?: string; first_name?: string; last_name?: string; phone?: string; contact?: string
      list?: string; source?: string; lang?: string; confirm_redirect?: string
    }

    // E-Mail und Telefon sind BEIDE optional, aber eins von beiden ist Pflicht.
    // Wer beides angibt, abonniert bewusst auf beiden Kanälen.
    // "contact" bleibt als Einzelfeld erlaubt (ältere Formulare) und wird anhand
    // des "@" der passenden Seite zugeordnet.
    const raw = String(body.contact ?? '').trim()
    let email = normEmail(String(body.email ?? (raw.includes('@') ? raw : '')))
    let phone = String(body.phone ?? '').trim()
    if (!phone && raw && !raw.includes('@')) phone = raw
    if (phone) {
      if (!looksLikePhone(phone)) return json({ error: 'Bitte eine gültige Handynummer angeben.' }, 400)
      phone = normPhone(phone)
    }
    if (email && !email.includes('@')) email = ''
    if (!email && !phone) return json({ error: 'Bitte eine E-Mail-Adresse oder Handynummer angeben.' }, 400)
    // Kanal = worüber der Abonnent den Newsletter bekommt.
    const channel: 'email' | 'whatsapp' | 'both' = email && phone ? 'both' : email ? 'email' : 'whatsapp'
    if (!body.list?.trim()) return json({ error: 'list fehlt' }, 400)
    const lang = body.lang === 'en' ? 'en' : 'de'

    const list = await resolveList(sb, body.list)
    if (!list) return json({ error: 'Liste konnte nicht ermittelt werden' }, 500)

    // Abonnent finden oder anlegen — per E-Mail, sonst per Telefonnummer.
    // Achtung: phone ist NICHT unique (Klaviyo-Import enthält Dubletten), deshalb
    // die älteste Übereinstimmung nehmen statt maybeSingle() über alle Treffer.
    type SubRow = { id: string; properties: Record<string, unknown> | null; optout_at: string | null; klaviyo_id: string | null }
    let ex: SubRow | null = null
    if (email) {
      // Wie beim Telefon die älteste Übereinstimmung: email ist nicht unique, bei
      // Dubletten lieferte maybeSingle() null, legte jedes Mal eine weitere Zeile
      // an und die Drosselung (liegt je Zeile) griff nie (Review S1).
      const { data } = await sb.from('newsletter_subscribers').select('id, properties, optout_at, klaviyo_id')
        .ilike('email', ilikeExact(email)).order('created_at', { ascending: true }).limit(1)
      ex = ((data as SubRow[] | null) ?? [])[0] ?? null
    } else {
      const { data } = await sb.from('newsletter_subscribers').select('id, properties, optout_at, klaviyo_id')
        .eq('phone', phone).order('created_at', { ascending: true }).limit(1)
      ex = ((data as SubRow[] | null) ?? [])[0] ?? null
    }
    const alreadyConfirmed = !!(ex && (ex.properties?.doi_confirmed === true || ex.klaviyo_id))

    // Schon bestätigt (DOI früher ODER aus Klaviyo importiert) → direkt zur Liste, keine neue DOI-Mail.
    if (ex && alreadyConfirmed && !ex.optout_at) {
      await sb.from('newsletter_list_members').upsert({ list_id: list.id, subscriber_id: ex.id }, { onConflict: 'list_id,subscriber_id' })
      await enrollInListSequences(sb, ex.id, list.id)
      return json({ ok: true, already_confirmed: true, added: true, channel })
    }

    // ── Drosselung (DOI_*): gerade erst oder schon oft bestätigt → gleiche Antwort
    // wie sonst, aber keine weitere Nachricht. Zu viele Anmeldungen pro Stunde → 429.
    const exProps = ((ex as { properties?: Record<string, unknown> | null } | null)?.properties ?? {}) as Record<string, unknown>
    const jetzt = Date.now()
    const frueher = (Array.isArray(exProps.doi_sends) ? exProps.doi_sends : [])
      .map(x => Date.parse(String(x))).filter(t => Number.isFinite(t) && jetzt - t < 24 * 3600_000)
    if (frueher.length && (jetzt - Math.max(...frueher) < DOI_MIN_GAP_MS || frueher.length >= DOI_MAX_PER_DAY)) {
      console.warn('[subscriber-optin] Bestätigung gedrosselt (Kontakt hat gerade/oft eine bekommen)')
      return json({ ok: true, pending: true, list: list.name, channel })
    }
    // Bestätigungen der letzten 24 h (wenige Zeilen, höchstens DOI_MAX_PER_HOUR je
    // Stunde) für die Drosselung je Adress-Familie und je Anschluss.
    const ipHash = await clientIpHash(req)
    const { data: recentRaw } = await sb.from('newsletter_subscribers')
      .select('id, email, doi_ip:properties->>doi_ip, doi_sent_at:properties->>doi_sent_at, doi_sends:properties->doi_sends')
      .gte('properties->>doi_sent_at', new Date(jetzt - 24 * 3600_000).toISOString()).limit(1000)
    const recent = (recentRaw ?? []) as Array<{ id: string; email: string | null; doi_ip: string | null; doi_sent_at: string | null; doi_sends: unknown }>
    if (email) {
      // name+1@…, name+2@… (und bei Gmail Punkte) zählen zusammen mit der Adresse selbst.
      const fam = familyKey(email)
      const aliasSends = recent
        .filter(r => r.id !== ex?.id && !!r.email && familyKey(normEmail(r.email)) === fam)
        .flatMap(r => Array.isArray(r.doi_sends) ? r.doi_sends : [])
        .map(x => Date.parse(String(x))).filter(t => Number.isFinite(t) && jetzt - t < 24 * 3600_000)
      if (aliasSends.length && frueher.length + aliasSends.length >= DOI_MAX_PER_DAY) {
        console.warn('[subscriber-optin] Bestätigung gedrosselt (Adress-Familie hat heute schon oft eine bekommen)')
        return json({ ok: true, pending: true, list: list.name, channel })
      }
    }
    if (ipHash) {
      const vomAnschluss = recent.filter(r => r.doi_ip === ipHash && jetzt - Date.parse(r.doi_sent_at ?? '') < 3600_000).length
      if (vomAnschluss >= DOI_MAX_PER_IP_HOUR) {
        console.warn(`[subscriber-optin] Anschluss-Limit erreicht (${vomAnschluss} Bestätigungen in 60 Min) - Anmeldung abgewiesen`)
        return json({ error: lang === 'en'
          ? 'We are receiving a lot of sign-ups right now. Please try again in a few minutes.'
          : 'Gerade kommen sehr viele Anmeldungen an. Bitte versuch es in ein paar Minuten noch einmal.' }, 429)
      }
    }
    const { count: letzteStunde } = await sb.from('newsletter_subscribers')
      .select('id', { count: 'exact', head: true })
      .gte('properties->>doi_sent_at', new Date(jetzt - 3600_000).toISOString())
    if ((letzteStunde ?? 0) >= DOI_MAX_PER_HOUR) {
      console.error(`[subscriber-optin] Stundenlimit erreicht (${letzteStunde} Bestätigungen in 60 Min) - Anmeldung abgewiesen`)
      return json({ error: lang === 'en'
        ? 'We are receiving a lot of sign-ups right now. Please try again in a few minutes.'
        : 'Gerade kommen sehr viele Anmeldungen an. Bitte versuch es in ein paar Minuten noch einmal.' }, 429)
    }
    const jetztIso = new Date(jetzt).toISOString()
    const frueherIso = frueher.map(t => new Date(t).toISOString())

    // Neu oder unbestätigt → DOI-Token setzen + Bestätigung auf dem gewählten Kanal
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    let subId: string | undefined = ex?.id
    const baseProps = {
      ...(ex?.properties ?? {}), lang, channel,
      doi_token: token, doi_pending_list: list.id, doi_confirmed: false,
      doi_redirect: erlaubtesZiel(body.confirm_redirect),
      // Vorab als verschickt markiert; schlägt der Versand fehl, wird es unten zurückgesetzt.
      doi_sent_at: jetztIso, doi_sends: [...frueherIso, jetztIso].slice(-DOI_MAX_PER_DAY),
      doi_ip: ipHash || null,
    }
    if (ex) {
      await sb.from('newsletter_subscribers').update({
        first_name: cleanText(body.first_name, 80) || undefined, last_name: cleanText(body.last_name, 80) || undefined,
        phone: phone || undefined, properties: baseProps,
      }).eq('id', ex.id)
    } else {
      const { data: created, error: insErr } = await sb.from('newsletter_subscribers').insert({
        email: email || null, first_name: cleanText(body.first_name, 80) || null, last_name: cleanText(body.last_name, 80) || null,
        phone: phone || null, source: cleanText(body.source, 120) || 'signup',
        properties: baseProps,
      }).select('id').single()
      if (insErr) console.error('[subscriber-optin] insert:', insErr.message)
      subId = (created as { id: string } | null)?.id
    }
    if (!subId) return json({ error: 'Abonnent konnte nicht angelegt werden' }, 500)

    const confirmUrl = `${base}/functions/v1/subscriber-optin?confirm=${token}`
    const first = greetName(body.first_name)

    // Versand gescheitert: Markierung zurücknehmen (sonst greift die Drosselung beim
    // erneuten Versuch) und ehrlich einen Fehler melden statt "bitte bestätigen".
    const versandFehler = async (kanal: string, grund: string) => {
      console.error(`[subscriber-optin] DOI-${kanal} fehlgeschlagen:`, grund)
      await sb.from('newsletter_subscribers').update({
        properties: { ...baseProps, doi_sent_at: (exProps.doi_sent_at as string | undefined) ?? null, doi_sends: frueherIso },
      }).eq('id', subId)
      return json({ error: lang === 'en'
        ? 'We could not send the confirmation just now. Please try again in a moment.'
        : 'Die Bestätigung konnte gerade nicht verschickt werden. Bitte versuch es gleich noch einmal.' }, 502)
    }

    // ── Kanal WhatsApp: Bestätigung als Nachricht statt als Mail ──────────────
    if (channel === 'whatsapp') {
      const waText = lang === 'en'
        ? `${first ? `Hi ${first}! ` : 'Hi! '}Thanks for signing up for the Happy Property newsletter 🇨🇾\n\nOne last step — please confirm here:\n${confirmUrl}\n\nDidn't request this? Just ignore this message.`
        : `${first ? `Hallo ${first}! ` : 'Hallo! '}Danke für deine Anmeldung zum Happy-Property-Newsletter 🇨🇾\n\nEin letzter Schritt — bitte bestätige hier:\n${confirmUrl}\n\nDu warst das nicht? Dann ignoriere diese Nachricht einfach.`
      const { data: waData, error: waErr } = await sb.functions.invoke('send-whatsapp', { body: {
        event_type: 'scheduled', override_text: waText, auto: true,
        lead_data: { lead_name: first || 'Newsletter-Abonnent', lead_phone: phone },
        persona_image: lotteBild(),
      } })
      // send-whatsapp meldet "nichts rausgegangen" auch als 200 mit success:false.
      const waRes = waData as { success?: boolean; error?: string } | null
      if (waErr || waRes?.success === false) return await versandFehler('WhatsApp', waErr?.message ?? waRes?.error ?? 'success=false')
      return json({ ok: true, pending: true, list: list.name, channel })
    }

    // Wer E-Mail UND Handy angegeben hat, bestätigt beide Kanäle mit demselben Klick —
    // deshalb sagt der Text dann "Anmeldung" statt "E-Mail-Adresse".
    const T = lang === 'en'
      ? { subj: 'Please confirm your registration', greet: first ? `Hi ${first},` : 'Hi,', intro: channel === 'both' ? 'thanks for signing up! You will receive the newsletter by email and on WhatsApp. Please confirm with one click:' : 'thanks for signing up! Please confirm your email address with one click:', btn: 'Confirm registration', foot: 'If you didn’t request this, just ignore this email.' }
      : { subj: 'Bitte bestätige deine Anmeldung', greet: first ? `Hallo ${first},` : 'Hallo,', intro: channel === 'both' ? 'danke für deine Anmeldung! Du bekommst den Newsletter per E-Mail und per WhatsApp. Bitte bestätige das einmal mit einem Klick:' : 'danke für deine Anmeldung! Bitte bestätige deine E-Mail-Adresse mit einem Klick:', btn: 'Anmeldung bestätigen', foot: 'Falls du das nicht warst, ignoriere diese Mail einfach.' }
    const mailHtml = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
      <div style="text-align:center;margin-bottom:6px;">
        <img src="${lotteBild()}" alt="Lotte" width="80" height="80" style="width:80px;height:80px;border-radius:50%;object-fit:cover;" />
        <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">${lang === 'en' ? "Lotte · Sven's personal assistant 🐾" : 'Lotte · persönliche Assistentin von Sven 🐾'}</p>
      </div>
      <p>${escHtml(T.greet)}</p><p>${T.intro}</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${confirmUrl}" style="background:#ff795d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block;">${T.btn}</a>
      </p>
      <p style="font-size:12px;color:#9ca3af;">${T.foot}</p>
    </div>`
    // invoke wirft bei non-2xx nicht, sondern liefert { error } - das .catch allein
    // hat Fehlschläge nie gesehen (Antwort war trotzdem "bitte bestätigen").
    let mailFehler: string | null = null
    try {
      const { data: mData, error: mErr } = await sb.functions.invoke('send-email', { body: {
        to: email, subject: T.subj, html: mailHtml, from_name: lang === 'en' ? "Lotte · Sven's personal assistant" : 'Lotte · Assistentin von Sven', lang, auto: true,
      } })
      mailFehler = mErr ? (mErr.message ?? 'invoke error') : ((mData as { error?: string } | null)?.error ?? null)
    } catch (e) { mailFehler = e instanceof Error ? e.message : String(e) }
    if (mailFehler) return await versandFehler('Mail', mailFehler)

    return json({ ok: true, pending: true, list: list.name, channel })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[subscriber-optin]', msg)
    return json({ error: msg }, 500)
  }
})
