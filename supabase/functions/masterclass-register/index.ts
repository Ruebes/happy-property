// masterclass-register — öffentliche Anmeldung zu einer Live-Masterclass (Zoom).
//
// Was passiert bei einer Anmeldung (POST { event, first_name, last_name, email, phone }):
//   1. Abonnent in newsletter_subscribers anlegen/aktualisieren (kein Double-Opt-In —
//      die Bestätigungsmail mit dem Zoom-Link IST die Bestätigung) und in die
//      Event-Liste eintragen (sichtbar unter Newsletter → Listen).
//   2. CRM-Lead anlegen/finden (source 'masterclass', OHNE Deal — die Erstkontakt-
//      Automatik darf nicht auf Webinar-Anmeldungen feuern) + Aktivität.
//   3. Sofort: Bestätigung per E-Mail (Zoom-Link, Kalender-Buttons, .ics-Anhang)
//      und per WhatsApp.
//   4. Erinnerungen als scheduled_messages am Abonnenten (feste Uhrzeiten, NICHT
//      relativ zur Anmeldung wie bei Listen-Sequenzen): 24 h vorher (Mail+WhatsApp),
//      1 h vorher (Mail+WhatsApp), 15 Min vorher (nur WhatsApp).
//
// GET ?ics=<event> liefert die Kalenderdatei (Apple/Outlook-Desktop).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy masterclass-register --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { buildIcs, toB64 } from '../_shared/ics.ts'
import { CI } from '../_shared/brand.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const normEmail = (e: string) => e.trim().toLowerCase().replace('googlemail.com', 'gmail.com')
function normPhone(raw: string): string {
  let s = String(raw ?? '').replace(/[^\d+]/g, '')
  if (s.startsWith('00')) s = '+' + s.slice(2)
  else if (s.startsWith('0')) s = '+49' + s.slice(1)
  else if (s && !s.startsWith('+')) s = '+' + s
  return s
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── Events ───────────────────────────────────────────────────────────────────
// Ein Eintrag je Masterclass. Zeiten in UTC (11:00 deutsche Sommerzeit = 09:00 UTC).
type Ev = {
  title: string; short: string; startIso: string; endIso: string
  dateLabel: string; timeLabel: string
  zoomUrl: string; zoomId: string; zoomPw: string
  list: string; thanksUrl: string; landingUrl: string
}
const EVENTS: Record<string, Ev> = {
  'aerzte-2026-10-11': {
    title: 'Masterclass für Ärzte & Apotheker: Immobilien auf Zypern & Steuern zurückholen',
    short: 'Masterclass für Ärzte & Apotheker',
    startIso: '2026-10-11T09:00:00Z', endIso: '2026-10-11T10:00:00Z',
    dateLabel: 'Sonntag, 11. Oktober 2026', timeLabel: '11:00 Uhr (deutsche Zeit)',
    zoomUrl: 'https://us06web.zoom.us/j/84711642809?pwd=uvj0nmrfjlt37KlWv2LBwyfpqa6E8P.1',
    zoomId: '847 1164 2809', zoomPw: '590189',
    list: 'Masterclass Ärzte 11.10.2026',
    thanksUrl: 'https://steuervorteil-zypern-immobilien.com/masterclass-fuer-aerzte-apotheker-danke/',
    landingUrl: 'https://steuervorteil-zypern-immobilien.com/masterclass-fuer-aerzte-apotheker-anmeldung/',
  },
}
const FN_URL = () => `${Deno.env.get('SUPABASE_URL')}/functions/v1/masterclass-register`

function icsFor(key: string, ev: Ev): string {
  return buildIcs({
    uid: `masterclass-${key}`, title: ev.title, startIso: ev.startIso, endIso: ev.endIso,
    description: `Live per Zoom mit Sven Rüprich.\nZoom-Link: ${ev.zoomUrl}\nMeeting-ID: ${ev.zoomId} · Kenncode: ${ev.zoomPw}\n\nBitte 5 Minuten vorher einwählen.`,
    location: 'Zoom (online)', url: ev.zoomUrl,
  })
}

// Kalender-Links für die Mail (Google / Outlook / Yahoo / .ics).
function calLinks(key: string, ev: Ev) {
  const dt = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const details = `Live per Zoom mit Sven Rüprich.\nZoom-Link: ${ev.zoomUrl}\nMeeting-ID: ${ev.zoomId} · Kenncode: ${ev.zoomPw}`
  const q = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return {
    google:  `https://calendar.google.com/calendar/render?${q({ action: 'TEMPLATE', text: ev.title, dates: `${dt(ev.startIso)}/${dt(ev.endIso)}`, details, location: 'Zoom (online)' })}`,
    outlook: `https://outlook.live.com/calendar/0/action/compose?${q({ rru: 'addevent', subject: ev.title, startdt: ev.startIso, enddt: ev.endIso, body: details, location: 'Zoom (online)' })}`,
    yahoo:   `https://calendar.yahoo.com/?${q({ v: '60', title: ev.title, st: dt(ev.startIso), et: dt(ev.endIso), desc: details, in_loc: 'Zoom (online)' })}`,
    ics:     `${FN_URL()}?ics=${key}`,
  }
}

// ── Mail-Vorlagen (CI: Creme, Navy, Korall) ──────────────────────────────────
function mailShell(inner: string): string {
  return `<div style="background:${CI.cream};padding:32px 16px;font-family:Montserrat,Helvetica,Arial,sans-serif;color:${CI.ink};line-height:1.6">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid ${CI.line};border-radius:12px;padding:32px 28px">${inner}
  <p style="margin:28px 0 0;color:${CI.mute};font-size:12px">Happy Property · Paphos, Zypern · <a href="https://happy-property.com" style="color:${CI.mute}">happy-property.com</a></p>
  </div></div>`
}
const btn = (href: string, label: string, ghost = false) =>
  `<a href="${href}" style="display:inline-block;margin:6px 8px 6px 0;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;${ghost ? `border:1.5px solid ${CI.navy};color:${CI.navy};background:#fff` : `background:${CI.coral};color:#fff`}">${label}</a>`

function zoomBox(ev: Ev): string {
  return `<div style="margin:20px 0;padding:18px 20px;border-radius:10px;background:${CI.coralSoft};border:1px solid ${CI.line}">
    <p style="margin:0 0 6px;font-weight:700;color:${CI.navy}">${esc(ev.dateLabel)}, ${esc(ev.timeLabel)}</p>
    <p style="margin:0 0 12px">Live per Zoom, ca. 60 Minuten plus Fragerunde.</p>
    ${btn(ev.zoomUrl, 'Zum Zoom-Raum')}
    <p style="margin:10px 0 0;font-size:13px;color:${CI.mute}">Meeting-ID: ${esc(ev.zoomId)} · Kenncode: ${esc(ev.zoomPw)}</p>
  </div>`
}

function confirmMail(first: string, key: string, ev: Ev) {
  const c = calLinks(key, ev)
  const html = mailShell(`
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${CI.coral};font-weight:600">Anmeldung bestätigt</p>
    <h1 style="margin:0 0 14px;font-family:'Playfair Display',Georgia,serif;font-size:26px;line-height:1.2;color:${CI.navy}">Du bist dabei, ${esc(first)}.</h1>
    <p style="margin:0">Danke für deine Anmeldung zur <strong>${esc(ev.short)}</strong>. Hier sind alle Daten, die du brauchst:</p>
    ${zoomBox(ev)}
    <p style="margin:0 0 8px;font-weight:700;color:${CI.navy}">Jetzt in den Kalender eintragen</p>
    <p style="margin:0 0 4px">${btn(c.google, 'Google Kalender', true)}${btn(c.ics, 'Apple / Outlook (.ics)', true)}${btn(c.outlook, 'Outlook.com', true)}${btn(c.yahoo, 'Yahoo', true)}</p>
    <p style="margin:18px 0 0">Du bekommst am Vortag und eine Stunde vorher noch eine Erinnerung mit dem Link. Bis Sonntag!</p>
    <p style="margin:18px 0 0">Liebe Grüße<br><strong>Sven Rüprich</strong><br><span style="color:${CI.mute}">Gründer Happy Property</span></p>`)
  const wa = `Hallo ${first}, du bist dabei! 🎉\n\n*${ev.short}*\n📅 ${ev.dateLabel}, ${ev.timeLabel}\n💻 Live per Zoom, ca. 60 Minuten plus Fragerunde\n\nZoom-Link: ${ev.zoomUrl}\nKenncode: ${ev.zoomPw}\n\nTrag dir den Termin am besten gleich in den Kalender ein: ${c.google}\n\nIch erinnere dich am Vortag und kurz vor Start noch einmal. Bis Sonntag!\nSven`
  return { subject: `Deine Anmeldung: ${ev.short}, ${ev.dateLabel}, ${ev.timeLabel}`, html, wa }
}

function reminderMails(first: string, key: string, ev: Ev) {
  const c = calLinks(key, ev)
  const day = {
    subject: `Morgen 11 Uhr: ${ev.short}`,
    html: mailShell(`
      <h1 style="margin:0 0 14px;font-family:'Playfair Display',Georgia,serif;font-size:24px;line-height:1.2;color:${CI.navy}">Morgen geht es los, ${esc(first)}.</h1>
      <p style="margin:0">Kurze Erinnerung: Die <strong>${esc(ev.short)}</strong> findet morgen statt. Ich zeige dir live, wie das Modell rechnet, welche Steuerhebel greifen und wie deine Immobilie später verwaltet wird.</p>
      ${zoomBox(ev)}
      <p style="margin:0">Noch nicht im Kalender? ${btn(c.google, 'Google Kalender', true)}${btn(c.ics, 'Apple / Outlook', true)}</p>
      <p style="margin:18px 0 0">Bis morgen!<br><strong>Sven</strong></p>`),
    wa: `Hallo ${first}, kurze Erinnerung: morgen um 11:00 Uhr (deutsche Zeit) startet die ${ev.short}. 📅\n\nZoom-Link: ${ev.zoomUrl}\nKenncode: ${ev.zoomPw}\n\nBis morgen!\nSven`,
  }
  const hour = {
    subject: `In einer Stunde: ${ev.short}`,
    html: mailShell(`
      <h1 style="margin:0 0 14px;font-family:'Playfair Display',Georgia,serif;font-size:24px;line-height:1.2;color:${CI.navy}">In einer Stunde geht es los.</h1>
      <p style="margin:0">${esc(first)}, um 11:00 Uhr (deutsche Zeit) starten wir. Der Zoom-Raum ist ab 10 Minuten vor Beginn offen.</p>
      ${zoomBox(ev)}
      <p style="margin:0">Bis gleich!<br><strong>Sven</strong></p>`),
    wa: `${first}, in einer Stunde geht es los! ⏰ Um 11:00 Uhr startet die ${ev.short}.\n\nZoom-Link: ${ev.zoomUrl}\nKenncode: ${ev.zoomPw}\n\nBis gleich!\nSven`,
  }
  const quarter = {
    wa: `Wir starten in 15 Minuten. 🚀 Hier geht es rein: ${ev.zoomUrl}\nKenncode: ${ev.zoomPw}\n\nBis gleich, Sven`,
  }
  return { day, hour, quarter }
}

// ── Lead im CRM anlegen/finden (ohne Deal) ───────────────────────────────────
async function upsertLead(sb: SupabaseClient, p: { first: string; last: string; email: string; phone: string; utm: Record<string, string>; ev: Ev; key: string }): Promise<string | null> {
  let leadId: string | null = null
  const { data: byMail } = await sb.from('leads').select('id').ilike('email', p.email).limit(1)
  if (byMail?.length) leadId = (byMail[0] as { id: string }).id
  if (!leadId && p.phone) {
    const { data: byPhone } = await sb.from('leads').select('id').or(`phone.eq.${p.phone},whatsapp.eq.${p.phone}`).limit(1)
    if (byPhone?.length) leadId = (byPhone[0] as { id: string }).id
  }
  if (!leadId) {
    const { data: nl, error } = await sb.from('leads').insert({
      first_name: p.first, last_name: p.last, email: p.email, phone: p.phone || null, whatsapp: p.phone || null,
      source: 'masterclass',
      utm_source: p.utm.utm_source ?? null, utm_medium: p.utm.utm_medium ?? null,
      utm_campaign: p.utm.utm_campaign ?? p.key, utm_content: p.utm.utm_content ?? null, utm_term: p.utm.utm_term ?? null,
      notes: `Masterclass-Anmeldung: ${p.ev.short} (${p.ev.dateLabel})`,
    }).select('id').single()
    if (error) { console.error('[masterclass-register] lead insert:', error.message); return null }
    leadId = (nl as { id: string }).id
  } else {
    const { data: old } = await sb.from('leads').select('notes, phone').eq('id', leadId).maybeSingle()
    const o = old as { notes?: string | null; phone?: string | null } | null
    const patch: Record<string, unknown> = { notes: `${o?.notes ? o.notes + '\n\n' : ''}Masterclass-Anmeldung: ${p.ev.short} (${p.ev.dateLabel})` }
    if (!o?.phone && p.phone) { patch.phone = p.phone; patch.whatsapp = p.phone }
    await sb.from('leads').update(patch).eq('id', leadId)
  }
  await sb.from('activities').insert({
    lead_id: leadId, type: 'note', direction: 'inbound', auto: true,
    subject: `🎓 Masterclass-Anmeldung: ${p.ev.short}`,
    content: `${p.first} ${p.last} hat sich für die ${p.ev.short} am ${p.ev.dateLabel} angemeldet (${p.email}${p.phone ? ', ' + p.phone : ''}).`,
  })
  return leadId
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const url = new URL(req.url)

  // ── .ics ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.searchParams.get('ics')) {
    const key = url.searchParams.get('ics')!
    const ev = EVENTS[key]
    if (!ev) return json({ error: 'unknown event' }, 404)
    return new Response(icsFor(key, ev), { headers: { ...CORS,
      'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="masterclass-${key}.ics"` } })
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405)

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let body: { event?: string; first_name?: string; last_name?: string; email?: string; phone?: string; website?: string; utm?: Record<string, string> }
  try { body = await req.json() } catch { return json({ error: 'bad json' }, 400) }

  // Honeypot: Bots füllen das unsichtbare Feld — stumm „ok" zurückgeben.
  if (body.website) return json({ ok: true })
  const key = String(body.event ?? '').trim()
  const ev = EVENTS[key]
  if (!ev) return json({ error: 'unknown event' }, 400)
  const first = String(body.first_name ?? '').trim()
  const last  = String(body.last_name ?? '').trim()
  const email = normEmail(String(body.email ?? ''))
  const phone = body.phone ? normPhone(String(body.phone)) : ''
  if (!first || !last) return json({ error: 'name' }, 400)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return json({ error: 'email' }, 400)
  if (phone && !/^\+\d{8,15}$/.test(phone)) return json({ error: 'phone' }, 400)
  const utm = body.utm ?? {}

  // ── 1. Abonnent + Liste ────────────────────────────────────────────────────
  let listId: string | null = null
  {
    const { data: lists } = await sb.from('newsletter_lists').select('id').ilike('name', ev.list).order('created_at', { ascending: true }).limit(1)
    listId = (lists as { id: string }[] | null)?.[0]?.id ?? null
    if (!listId) {
      const { data: created, error } = await sb.from('newsletter_lists').insert({ name: ev.list, source: 'manual', active: true }).select('id').single()
      if (error) console.error('[masterclass-register] list:', error.message)
      listId = (created as { id: string } | null)?.id ?? null
    }
  }
  let subId: string | null = null
  {
    const { data: ex } = await sb.from('newsletter_subscribers').select('id, properties').ilike('email', email).limit(1)
    const found = (ex as { id: string; properties: Record<string, unknown> | null }[] | null)?.[0]
    const props = { ...(found?.properties ?? {}), lang: 'de', doi_confirmed: true, doi_confirmed_at: new Date().toISOString(),
      masterclass: Array.from(new Set([...(((found?.properties ?? {}) as { masterclass?: string[] }).masterclass ?? []), key])) }
    if (found) {
      subId = found.id
      await sb.from('newsletter_subscribers').update({ first_name: first, last_name: last, phone: phone || undefined, properties: props, optout_at: null }).eq('id', subId)
    } else {
      const { data: created, error } = await sb.from('newsletter_subscribers').insert({
        email, first_name: first, last_name: last, phone: phone || null, source: 'masterclass', properties: props,
      }).select('id').single()
      if (error) console.error('[masterclass-register] subscriber:', error.message)
      subId = (created as { id: string } | null)?.id ?? null
    }
    if (subId && listId) await sb.from('newsletter_list_members').upsert({ list_id: listId, subscriber_id: subId }, { onConflict: 'list_id,subscriber_id' })
  }

  // ── 2. CRM-Lead ────────────────────────────────────────────────────────────
  const leadId = await upsertLead(sb, { first, last, email, phone, utm, ev, key })

  // ── 3. Sofort-Bestätigung ──────────────────────────────────────────────────
  const auth = { 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' }
  const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1`
  const conf = confirmMail(first, key, ev)
  const mailRes = await fetch(`${base}/send-email`, { method: 'POST', headers: auth, body: JSON.stringify({
    to: email, subject: conf.subject, html: conf.html, lead_id: leadId, auto: true, lang: 'de', already_translated: true,
    from_name: 'Sven Rüprich · Happy Property',
    attachment: { filename: `masterclass-${key}.ics`, content_base64: toB64(icsFor(key, ev)), content_type: 'text/calendar' },
  }) })
  if (!mailRes.ok) console.error('[masterclass-register] send-email:', mailRes.status, await mailRes.text())
  if (phone) {
    const waRes = await fetch(`${base}/send-whatsapp`, { method: 'POST', headers: auth, body: JSON.stringify({
      event_type: 'masterclass_confirmation', lead_id: leadId, auto: true, lang: 'de', already_translated: true,
      lead_data: { lead_name: `${first} ${last}`, lead_phone: phone, lead_email: email }, override_text: conf.wa,
    }) })
    if (!waRes.ok) console.error('[masterclass-register] send-whatsapp:', waRes.status, await waRes.text())
  }

  // ── 4. Erinnerungen (feste Zeiten) ─────────────────────────────────────────
  if (subId) {
    const start = new Date(ev.startIso).getTime()
    const at = (minBefore: number) => new Date(start - minBefore * 60_000).toISOString()
    const r = reminderMails(first, key, ev)
    const wantWa = !!phone
    const rows: Record<string, unknown>[] = []
    const now = Date.now()
    const push = (minBefore: number, row: Record<string, unknown>) => {
      // Späte Anmeldung: bereits verstrichene Erinnerungen nicht mehr planen.
      if (start - minBefore * 60_000 < now + 5 * 60_000) return
      rows.push({ subscriber_id: subId, event_type: 'newsletter', status: 'pending', scheduled_at: at(minBefore), ...row })
    }
    push(24 * 60, { type: wantWa ? 'both' : 'email', email_subject: r.day.subject, email_body: r.day.html, whatsapp_text: wantWa ? r.day.wa : null })
    push(60,      { type: wantWa ? 'both' : 'email', email_subject: r.hour.subject, email_body: r.hour.html, whatsapp_text: wantWa ? r.hour.wa : null })
    if (wantWa) push(15, { type: 'whatsapp', whatsapp_text: r.quarter.wa })
    if (rows.length) {
      // Doppelte Anmeldung: alte offene Erinnerungen dieses Abonnenten für das Event ersetzen.
      await sb.from('scheduled_messages').delete().eq('subscriber_id', subId).eq('status', 'pending').eq('event_type', 'newsletter')
        .gte('scheduled_at', at(25 * 60)).lte('scheduled_at', ev.startIso)
      const { error } = await sb.from('scheduled_messages').insert(rows)
      if (error) console.error('[masterclass-register] reminders:', error.message)
    }
  }

  const thanks = new URL(ev.thanksUrl)
  thanks.searchParams.set('v', first)
  return json({ ok: true, redirect: thanks.toString() })
})
