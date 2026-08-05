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
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'
import { lotteBild } from '../_shared/lotte.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const normEmail = (e: string) => e.trim().toLowerCase().replace('googlemail.com', 'gmail.com')

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
  const clean = name.trim()
  if (!clean) return null
  // Robust gegen doppelte Namen: älteste passende Liste nehmen (maybeSingle würde
  // bei Mehrdeutigkeit fehlschlagen und fälschlich eine neue Liste anlegen).
  const { data: matches } = await sb.from('newsletter_lists').select('id, name').ilike('name', clean).order('created_at', { ascending: true }).limit(1)
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
        try { await sb.from('engagement_events').insert({ type: 'email_open', subscriber_id: openSub, label: 'sequence' }) }
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
    let ex: { id: string; properties: Record<string, unknown> | null; optout_at: string | null; klaviyo_id: string | null } | null = null
    if (email) {
      const { data } = await sb.from('newsletter_subscribers').select('id, properties, optout_at, klaviyo_id').ilike('email', email).maybeSingle()
      ex = data as typeof ex
    } else {
      const { data } = await sb.from('newsletter_subscribers').select('id, properties, optout_at, klaviyo_id')
        .eq('phone', phone).order('created_at', { ascending: true }).limit(1)
      ex = ((data as Array<NonNullable<typeof ex>> | null) ?? [])[0] ?? null
    }
    const alreadyConfirmed = !!(ex && (ex.properties?.doi_confirmed === true || ex.klaviyo_id))

    // Schon bestätigt (DOI früher ODER aus Klaviyo importiert) → direkt zur Liste, keine neue DOI-Mail.
    if (ex && alreadyConfirmed && !ex.optout_at) {
      await sb.from('newsletter_list_members').upsert({ list_id: list.id, subscriber_id: ex.id }, { onConflict: 'list_id,subscriber_id' })
      await enrollInListSequences(sb, ex.id, list.id)
      return json({ ok: true, already_confirmed: true, added: true, channel })
    }

    // Neu oder unbestätigt → DOI-Token setzen + Bestätigung auf dem gewählten Kanal
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    let subId = ex?.id
    const baseProps = {
      ...(ex?.properties ?? {}), lang, channel,
      doi_token: token, doi_pending_list: list.id, doi_confirmed: false,
      doi_redirect: erlaubtesZiel(body.confirm_redirect),
    }
    if (ex) {
      await sb.from('newsletter_subscribers').update({
        first_name: body.first_name?.trim() || undefined, last_name: body.last_name?.trim() || undefined,
        phone: phone || undefined, properties: baseProps,
      }).eq('id', ex.id)
    } else {
      const { data: created, error: insErr } = await sb.from('newsletter_subscribers').insert({
        email: email || null, first_name: body.first_name?.trim() || null, last_name: body.last_name?.trim() || null,
        phone: phone || null, source: body.source?.trim() || 'signup',
        properties: baseProps,
      }).select('id').single()
      if (insErr) console.error('[subscriber-optin] insert:', insErr.message)
      subId = (created as { id: string } | null)?.id
    }
    if (!subId) return json({ error: 'Abonnent konnte nicht angelegt werden' }, 500)

    const confirmUrl = `${base}/functions/v1/subscriber-optin?confirm=${token}`
    const first = (body.first_name ?? '').trim()

    // ── Kanal WhatsApp: Bestätigung als Nachricht statt als Mail ──────────────
    if (channel === 'whatsapp') {
      const waText = lang === 'en'
        ? `${first ? `Hi ${first}! ` : 'Hi! '}Thanks for signing up for the Happy Property newsletter 🇨🇾\n\nOne last step — please confirm here:\n${confirmUrl}\n\nDidn't request this? Just ignore this message.`
        : `${first ? `Hallo ${first}! ` : 'Hallo! '}Danke für deine Anmeldung zum Happy-Property-Newsletter 🇨🇾\n\nEin letzter Schritt — bitte bestätige hier:\n${confirmUrl}\n\nDu warst das nicht? Dann ignoriere diese Nachricht einfach.`
      const { error: waErr } = await sb.functions.invoke('send-whatsapp', { body: {
        event_type: 'scheduled', override_text: waText, auto: true,
        lead_data: { lead_name: first || 'Newsletter-Abonnent', lead_phone: phone },
        persona_image: lotteBild(),
      } })
      if (waErr) console.warn('[subscriber-optin] DOI-WhatsApp:', waErr)
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
      <p>${T.greet}</p><p>${T.intro}</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${confirmUrl}" style="background:#ff795d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block;">${T.btn}</a>
      </p>
      <p style="font-size:12px;color:#9ca3af;">${T.foot}</p>
    </div>`
    await sb.functions.invoke('send-email', { body: {
      to: email, subject: T.subj, html: mailHtml, from_name: lang === 'en' ? "Lotte · Sven's personal assistant" : 'Lotte · Assistentin von Sven', lang, auto: true,
    } }).catch((e: unknown) => console.warn('[subscriber-optin] DOI-Mail:', e))

    return json({ ok: true, pending: true, list: list.name, channel })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[subscriber-optin]', msg)
    return json({ error: msg }, 500)
  }
})
