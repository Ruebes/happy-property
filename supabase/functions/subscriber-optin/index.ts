// subscriber-optin — öffentliche Anmelde-Strecke (Lead-Magnet / Webinar / Newsletter).
// Sammelt Adressen selbst (bisher kamen alle nur aus dem Klaviyo-Import) und schreibt
// sie DSGVO-konform per Double-Opt-In in newsletter_subscribers + newsletter_list_members.
//
// Aktionen:
//   POST { email, first_name?, last_name?, phone?, list, source?, lang? }
//        → Abonnent anlegen/finden, Bestätigungs-Mail (DOI) verschicken.
//          Bereits bestätigte (z.B. Klaviyo-Import) werden ohne DOI direkt zur Liste
//          hinzugefügt.
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
const html = (b: string, s = 200) => new Response(b, { status: s, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } })
const esc = (s: string) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
const normEmail = (e: string) => e.trim().toLowerCase().replace('googlemail.com', 'gmail.com')

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
  try {
    const { data: seqs } = await sb.from('list_sequences').select('id').eq('list_id', listId).eq('active', true)
    const sequences = (seqs as { id: string }[] | null) ?? []
    if (!sequences.length) return
    // Abonnent für Personalisierung ({{vorname}}) einmal laden.
    const { data: subRow } = await sb.from('newsletter_subscribers').select('first_name').eq('id', subscriberId).maybeSingle()
    const first = ((subRow as { first_name: string | null } | null)?.first_name ?? '').trim()
    const fill = (s: string | null | undefined) => (s ?? '')
      .replace(/\{\{\s*(vorname|first_name|name)\s*\}\}/gi, first || (/* neutral */ ''))
    const now = Date.now()
    for (const seq of sequences) {
      // schon eingeschrieben? (unique verhindert Doppelversand)
      const { data: existing } = await sb.from('sequence_enrollments').select('id').eq('sequence_id', seq.id).eq('subscriber_id', subscriberId).maybeSingle()
      if (existing) continue
      const { error: enErr } = await sb.from('sequence_enrollments').insert({ sequence_id: seq.id, subscriber_id: subscriberId })
      if (enErr) { console.warn('[subscriber-optin] enroll:', enErr.message); continue }
      const { data: steps } = await sb.from('sequence_steps').select('*').eq('sequence_id', seq.id).eq('active', true).order('step_order', { ascending: true })
      const rows = ((steps as Record<string, unknown>[] | null) ?? []).map(st => ({
        subscriber_id: subscriberId,
        type: String(st.channel ?? 'email'),
        event_type: 'newsletter',
        status: 'pending',
        scheduled_at: new Date(now + Number(st.delay_minutes ?? 0) * 60_000).toISOString(),
        email_subject: fill(st.email_subject as string),
        email_body: fill(st.email_body as string),
        whatsapp_text: fill(st.whatsapp_text as string),
        whatsapp_image_url: (st.whatsapp_image_url as string) || null,
      }))
      if (rows.length) {
        const { error: schErr } = await sb.from('scheduled_messages').insert(rows)
        if (schErr) console.warn('[subscriber-optin] schedule steps:', schErr.message)
      }
    }
  } catch (e) { console.warn('[subscriber-optin] enrollInListSequences:', e) }
}

function pageShell(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)}</title></head>
    <body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:linear-gradient(160deg,#fff5f2,#faf7f4);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;">
      <div style="max-width:440px;width:100%;background:#fff;border-radius:24px;box-shadow:0 10px 40px rgba(0,0,0,.08);padding:36px 28px;text-align:center;color:#1f2937;">
        ${body}
        <p style="margin-top:24px;font-size:12px;color:#9ca3af;">Happy Property Cyprus</p>
      </div>
    </body></html>`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const base = Deno.env.get('SUPABASE_URL')!

  try {
    // ── GET: Bestätigung (Double-Opt-In) ──────────────────────────────────────
    if (req.method === 'GET') {
      const token = new URL(req.url).searchParams.get('confirm') ?? ''
      if (!token) return html(pageShell('Ungültiger Link', `<p style="font-size:16px;">Dieser Bestätigungslink ist ungültig.</p>`), 400)
      const { data: sub } = await sb.from('newsletter_subscribers').select('id, first_name, properties').eq('properties->>doi_token', token).maybeSingle()
      const s = sub as { id: string; first_name: string | null; properties: Record<string, unknown> | null } | null
      if (!s) return html(pageShell('Link abgelaufen', `<div style="font-size:40px">⏳</div><p style="font-size:16px;">Dieser Bestätigungslink ist ungültig oder wurde schon benutzt.</p>`))
      const props = { ...(s.properties ?? {}) }
      const listId = props.doi_pending_list as string | undefined
      delete props.doi_token; delete props.doi_pending_list
      props.doi_confirmed = true; props.doi_confirmed_at = new Date().toISOString()
      await sb.from('newsletter_subscribers').update({ properties: props, optout_at: null }).eq('id', s.id)
      if (listId) {
        await sb.from('newsletter_list_members').upsert({ list_id: listId, subscriber_id: s.id }, { onConflict: 'list_id,subscriber_id' })
        await enrollInListSequences(sb, s.id, listId)
      }
      const first = (s.first_name ?? '').trim()
      return html(pageShell('Anmeldung bestätigt', `
        <div style="font-size:44px">✅</div>
        <h1 style="font-size:22px;margin:12px 0 6px;color:#111827;">${first ? `Danke, ${esc(first)}!` : 'Danke!'}</h1>
        <p style="font-size:16px;color:#374151;">Deine Anmeldung ist bestätigt. Du hörst bald von uns. 🐾</p>`))
    }

    // ── POST: Anmeldung (schickt Double-Opt-In-Mail) ─────────────────────────
    const body = await req.json().catch(() => ({})) as {
      email?: string; first_name?: string; last_name?: string; phone?: string; list?: string; source?: string; lang?: string
    }
    const email = normEmail(String(body.email ?? ''))
    if (!email.includes('@')) return json({ error: 'Bitte eine gültige E-Mail angeben.' }, 400)
    if (!body.list?.trim()) return json({ error: 'list fehlt' }, 400)
    const lang = body.lang === 'en' ? 'en' : 'de'

    const list = await resolveList(sb, body.list)
    if (!list) return json({ error: 'Liste konnte nicht ermittelt werden' }, 500)

    // Abonnent finden oder anlegen
    const { data: existing } = await sb.from('newsletter_subscribers').select('id, properties, optout_at, klaviyo_id').ilike('email', email).maybeSingle()
    const ex = existing as { id: string; properties: Record<string, unknown> | null; optout_at: string | null; klaviyo_id: string | null } | null
    const alreadyConfirmed = !!(ex && (ex.properties?.doi_confirmed === true || ex.klaviyo_id))

    // Schon bestätigt (DOI früher ODER aus Klaviyo importiert) → direkt zur Liste, keine neue DOI-Mail.
    if (ex && alreadyConfirmed && !ex.optout_at) {
      await sb.from('newsletter_list_members').upsert({ list_id: list.id, subscriber_id: ex.id }, { onConflict: 'list_id,subscriber_id' })
      await enrollInListSequences(sb, ex.id, list.id)
      return json({ ok: true, already_confirmed: true, added: true })
    }

    // Neu oder unbestätigt → DOI-Token setzen + Bestätigungsmail
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    let subId = ex?.id
    const baseProps = { ...(ex?.properties ?? {}), lang, doi_token: token, doi_pending_list: list.id, doi_confirmed: false }
    if (ex) {
      await sb.from('newsletter_subscribers').update({
        first_name: body.first_name?.trim() || undefined, last_name: body.last_name?.trim() || undefined,
        phone: body.phone?.trim() || undefined, properties: baseProps,
      }).eq('id', ex.id)
    } else {
      const { data: created } = await sb.from('newsletter_subscribers').insert({
        email, first_name: body.first_name?.trim() || null, last_name: body.last_name?.trim() || null,
        phone: body.phone?.trim() || null, source: body.source?.trim() || 'signup',
        properties: baseProps,
      }).select('id').single()
      subId = (created as { id: string } | null)?.id
    }
    if (!subId) return json({ error: 'Abonnent konnte nicht angelegt werden' }, 500)

    // Double-Opt-In-Mail (von Lotte, mit Office-Bild)
    const confirmUrl = `${base}/functions/v1/subscriber-optin?confirm=${token}`
    const first = (body.first_name ?? '').trim()
    const T = lang === 'en'
      ? { subj: 'Please confirm your registration', greet: first ? `Hi ${first},` : 'Hi,', intro: 'thanks for signing up! Please confirm your email address with one click:', btn: 'Confirm registration', foot: 'If you didn’t request this, just ignore this email.' }
      : { subj: 'Bitte bestätige deine Anmeldung', greet: first ? `Hallo ${first},` : 'Hallo,', intro: 'danke für deine Anmeldung! Bitte bestätige deine E-Mail-Adresse mit einem Klick:', btn: 'Anmeldung bestätigen', foot: 'Falls du das nicht warst, ignoriere diese Mail einfach.' }
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

    return json({ ok: true, pending: true, list: list.name })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[subscriber-optin]', msg)
    return json({ error: msg }, 500)
  }
})
