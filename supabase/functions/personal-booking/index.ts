// personal-booking — öffentlicher persönlicher Kalender-Link (z.B. /buchen/sven360).
// Wer den Link hat, sieht Svens freie Zeiten und bucht selbst: Betreff + Dauer +
// Art (Vor Ort mit Adress-Autocomplete / WhatsApp / Zoom) + Kontaktdaten → Termin
// im Google-Kalender + CRM, Bestätigung per Mail (mit .ics) und WhatsApp.
// Fenster Mo–So 8–21 (Berlin); Bot-Zeiten (Mo–Fr 11–19, Sa/So 17–20) bevorzugt,
// andere als „ungern" markiert. Belegte Zeiten (Google + CRM) sind raus.
//
// Actions: config | slots | places | book
// Secrets: SUPABASE_URL, SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_API_KEY, ZOOM_*
// Deploy: supabase functions deploy personal-booking --no-verify-jwt
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'
import { isInternalContact } from '../_shared/internalContact.ts'
import { notifyIfToday, cyTime } from '../_shared/notifyToday.ts'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const TZ = 'Europe/Berlin'
const CALENDAR_ID = 'primary-fallback'
const DAY_START = 8, DAY_END = 21, STEP = 30   // Fenster + Slot-Raster (Min)
const MIN_LEAD_MIN = 30, DAYS_AHEAD = 30

// ── Zeit/Berlin ──────────────────────────────────────────────────────────────
function berlinOffsetMin(date: Date): number {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date)) m[p.type] = p.value
  return (Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second) - date.getTime()) / 60000
}
function berlinToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi))
  return new Date(guess.getTime() - berlinOffsetMin(guess) * 60000)
}
function berlinParts(date: Date): { y: number; mo: number; d: number; wd: number; h: number } {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(date)) m[p.type] = p.value
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { y: +m.year, mo: +m.month, d: +m.day, wd: wd[m.weekday] ?? 1, h: +m.hour === 24 ? 0 : +m.hour }
}
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('de-DE', { timeZone: TZ, ...o }).format(new Date(iso))
// Bot-Zeiten = bevorzugt: Mo–Fr 11–19, Sa/So 17–20 (nach Start-Stunde)
const isPreferred = (wd: number, h: number) => (wd >= 1 && wd <= 5) ? (h >= 11 && h < 19) : (h >= 17 && h < 20)

// ── Google Service-Account ───────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function toB64(s: string): string { return btoa(unescape(encodeURIComponent(s))) }
async function importKey(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\\n/g, '').replace(/\s+/g, '')
  return crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(b), c => c.charCodeAt(0)).buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
async function getSaToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON'); if (!raw) throw new Error('SA JSON fehlt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(sa.private_key), new TextEncoder().encode(unsigned))
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(new Uint8Array(sig))}` }) })
  const d = await res.json() as { access_token?: string }
  if (!d.access_token) throw new Error('SA-Token fehlgeschlagen')
  return d.access_token
}
async function getCalendarId(admin: SupabaseClient): Promise<string> {
  const { data } = await admin.from('crm_settings').select('value').eq('key', 'google_calendar_ids').maybeSingle()
  const raw = (data as { value?: string } | null)?.value
  return raw ? raw.split(',')[0].trim() : CALENDAR_ID
}
interface Busy { start: number; end: number }
async function getBusy(admin: SupabaseClient, fromUtc: Date, toUtc: Date): Promise<Busy[]> {
  const busy: Busy[] = []
  try {
    // Echte Ueberlappung statt Fenster-auf-Startzeit: .gte('start_time', from) uebersieht
  // jeden Termin, der VOR dem Fenster beginnt und hineinragt. Ein 3-Stunden-Termin ab
  // 10:00 war so um 11:00 unsichtbar - ein Kunde konnte mitten hineinbuchen. Genauso
  // waere eine Tagessperre Minuten nach dem Setzen wieder wirkungslos geworden.
    const { data } = await admin.from('crm_appointments').select('start_time, end_time').lt('start_time', toUtc.toISOString()).gt('end_time', fromUtc.toISOString())
    for (const a of (data ?? []) as { start_time: string; end_time: string }[]) busy.push({ start: new Date(a.start_time).getTime(), end: new Date(a.end_time).getTime() })
  } catch { /* ignore */ }
  try {
    const calId = await getCalendarId(admin), token = await getSaToken()
    const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeMin: fromUtc.toISOString(), timeMax: toUtc.toISOString(), items: [{ id: calId }] }) })
    const jr = await r.json() as { calendars?: Record<string, { busy?: { start: string; end: string }[] }> }
    for (const b of jr.calendars?.[calId]?.busy ?? []) busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() })
  } catch (e) { console.warn('[personal-booking] freeBusy n/v:', e) }
  return busy
}
async function createCalendarEvent(admin: SupabaseClient, ev: { title: string; startIso: string; endIso: string; description: string; location?: string }): Promise<{ id: string; calId: string } | null> {
  try {
    const calId = await getCalendarId(admin), token = await getSaToken()
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: ev.title, description: ev.description, location: ev.location || undefined, start: { dateTime: ev.startIso, timeZone: TZ }, end: { dateTime: ev.endIso, timeZone: TZ } }),
    })
    const d = await r.json() as { id?: string }
    return d.id ? { id: d.id, calId } : null
  } catch (e) { console.warn('[personal-booking] Event fehlgeschlagen:', e); return null }
}
function buildIcs(o: { uid: string; title: string; startIso: string; endIso: string; description?: string; location?: string }): string {
  const dt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Happy Property//CRM//DE', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${o.uid}@happy-property.com`, `DTSTAMP:${dt(new Date().toISOString())}`, `DTSTART:${dt(o.startIso)}`, `DTEND:${dt(o.endIso)}`,
    `SUMMARY:${esc(o.title)}`, ...(o.description ? [`DESCRIPTION:${esc(o.description)}`] : []), ...(o.location ? [`LOCATION:${esc(o.location)}`] : []),
    'ORGANIZER;CN=Sven Rüprich:mailto:sven@happy-property.com', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}
const overlaps = (s: number, e: number, busy: Busy[]) => busy.some(b => s < b.end && e > b.start)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json().catch(() => ({}))
    const action = body.action as string
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── Adress-Vorschläge (Google Places Autocomplete) ─────────────────────
    if (action === 'places') {
      const q = String(body.q ?? '').trim()
      if (q.length < 3) return json({ ok: true, predictions: [] })
      // Photon (OpenStreetMap, keyless) — serverseitiger Proxy, kein Google-Key nötig.
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=de&limit=6`)
        const d = await r.json() as { features?: { properties: Record<string, string> }[] }
        const preds = (d.features ?? []).map(f => {
          const p = f.properties
          const line1 = p.name || [p.street, p.housenumber].filter(Boolean).join(' ')
          const line2 = [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' ')
          return [line1, line2, p.country].filter(Boolean).join(', ')
        }).filter((s, i, a) => s && a.indexOf(s) === i).slice(0, 6)
        return json({ ok: true, predictions: preds })
      } catch (e) { console.warn('[personal-booking] places:', e); return json({ ok: true, predictions: [] }) }
    }

    // Optionale Einladung (vorbelegte Kontaktdaten + Bild + Sprache je Gast)
    let inv: { slug: string; guest_name: string | null; guest_email: string | null; guest_phone: string | null; subject: string | null; image_url: string | null; image_focus: string | null; lang: string; internal: boolean } | null = null
    if (body.invite) {
      const { data } = await admin.from('booking_invites').select('slug, guest_name, guest_email, guest_phone, subject, image_url, image_focus, lang, internal').eq('token', String(body.invite)).maybeSingle()
      inv = data as typeof inv
    }
    // Link laden (Slug aus Einladung oder direkt)
    const slug = (inv?.slug ?? String(body.slug ?? '')).trim()
    const { data: link } = await admin.from('personal_booking_links').select('slug, title, active, owner_id').eq('slug', slug).maybeSingle()
    const lk = link as { slug: string; title: string | null; active: boolean; owner_id: string | null } | null
    if (!lk || !lk.active) return json({ error: 'Link nicht gefunden' }, 404)

    if (action === 'config') return json({ ok: true, title: lk.title ?? 'Termin', owner: 'Sven Rüprich',
      guest: inv ? { name: inv.guest_name, email: inv.guest_email, phone: inv.guest_phone, subject: inv.subject } : null,
      image_url: inv?.image_url ?? null, image_focus: inv?.image_focus ?? null, lang: inv?.lang ?? 'de' })

    // ── Freie Slots für die gewählte Dauer ─────────────────────────────────
    if (action === 'slots') {
      const dur = Math.max(15, Math.min(360, Number(body.duration) || 30))
      const now = Date.now(), minStart = now + MIN_LEAD_MIN * 60000
      const busy = await getBusy(admin, new Date(now), new Date(now + DAYS_AHEAD * 864e5))
      const days: { date: string; label: string; times: { iso: string; label: string; preferred: boolean }[] }[] = []
      for (let off = 0; off < DAYS_AHEAD; off++) {
        const bp = berlinParts(new Date(now + off * 864e5))
        const times: { iso: string; label: string; preferred: boolean }[] = []
        for (let mins = DAY_START * 60; mins + dur <= DAY_END * 60; mins += STEP) {
          const h = Math.floor(mins / 60), mi = mins % 60
          const start = berlinToUtc(bp.y, bp.mo, bp.d, h, mi)
          const s = start.getTime(), e = s + dur * 60000
          if (s < minStart) continue
          if (overlaps(s, e, busy)) continue
          times.push({ iso: start.toISOString(), label: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, preferred: isPreferred(bp.wd, h) })
        }
        if (times.length) days.push({ date: `${bp.y}-${String(bp.mo).padStart(2, '0')}-${String(bp.d).padStart(2, '0')}`, label: fmt(new Date(now + off * 864e5).toISOString(), { weekday: 'long', day: '2-digit', month: 'long' }), times })
      }
      return json({ ok: true, duration: dur, days })
    }

    // ── Buchen ─────────────────────────────────────────────────────────────
    if (action === 'book') {
      const { startIso, subject, type, address, name, email, phone } = body as { startIso?: string; subject?: string; type?: string; address?: string; name?: string; email?: string; phone?: string }
      const dur = Math.max(15, Math.min(360, Number(body.duration) || 30))
      if (!startIso || !subject?.trim() || !name?.trim() || !['onsite', 'whatsapp', 'zoom'].includes(type ?? '')) return json({ error: 'Bitte alle Pflichtfelder ausfüllen.' }, 400)
      if (!email?.trim() && !phone?.trim()) return json({ error: 'Bitte E-Mail oder Telefon angeben.' }, 400)
      const start = new Date(startIso), end = new Date(start.getTime() + dur * 60000)
      if (start.getTime() < Date.now() + MIN_LEAD_MIN * 60000) return json({ error: 'Zeitpunkt liegt zu kurzfristig.' }, 400)
      // Slot noch frei? (Doppelbuchung vermeiden)
      const busy = await getBusy(admin, new Date(start.getTime() - 60000), new Date(end.getTime() + 60000))
      if (overlaps(start.getTime(), end.getTime(), busy)) return json({ error: 'Der Zeitpunkt ist gerade belegt worden — bitte einen anderen wählen.' }, 409)

      const lang = body.lang === 'en' ? 'en' : 'de'
      const loc = lang === 'en' ? 'en-GB' : 'de-DE'
      const fmtL = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: TZ, ...opts }).format(new Date(iso))
      const apptType = type === 'onsite' ? 'inperson' : type   // whatsapp|zoom bleiben
      const dateStr = lang === 'en'
        ? `${fmtL(startIso, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}, ${fmtL(startIso, { hour: '2-digit', minute: '2-digit', hour12: false })}`
        : `${fmtL(startIso, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}, ${fmtL(startIso, { hour: '2-digit', minute: '2-digit' })} Uhr`
      let zoomLink: string | null = null
      if (type === 'zoom') {
        try { const { data: z } = await admin.functions.invoke('create-zoom-meeting', { body: { title: subject, start_time: startIso, duration_minutes: dur } }); zoomLink = (z as { join_url?: string } | null)?.join_url ?? null } catch (e) { console.warn('[personal-booking] zoom:', e) }
      }
      const location = type === 'onsite' ? (address ?? '') : null
      const locUrl = type === 'zoom' ? zoomLink : (type === 'onsite' && address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null)
      const T = lang === 'en'
        ? { onsite: 'In person', zoom: 'Zoom video call', wa: 'WhatsApp call', with: 'With', kind: 'Type',
            greet: (n: string) => `Hi ${n},`, confirmed: 'your appointment with Sven is confirmed:',
            gcalBtn: 'Add to Google Calendar', icsNote: 'The calendar file (.ics) for Apple/Outlook is attached to this email. See you soon!',
            zoomLinkLbl: 'Zoom link', mailSubj: (s: string, d: string) => `Appointment confirmation: ${s} on ${d}`,
            waMsg: (s: string, ds: string, tl: string, z: string | null) => `✅ Your appointment with Sven is confirmed:\n\n*${s}*\n📅 ${ds}\n📍 ${tl}${z ? `\n🔗 ${z}` : ''}\n\nSee you soon!\nHappy Property` }
        : { onsite: 'Vor Ort', zoom: 'Zoom-Videocall', wa: 'WhatsApp-Anruf', with: 'Mit', kind: 'Art',
            greet: (n: string) => `Hallo ${n},`, confirmed: 'dein Termin mit Sven ist bestätigt:',
            gcalBtn: 'Zum Google Kalender hinzufügen', icsNote: 'Die Kalender-Datei (.ics) für Apple/Outlook hängt an dieser Mail. Bis bald!',
            zoomLinkLbl: 'Zoom-Link', mailSubj: (s: string, d: string) => `Terminbestätigung: ${s} am ${d}`,
            waMsg: (s: string, ds: string, tl: string, z: string | null) => `✅ Dein Termin mit Sven ist bestätigt:\n\n*${s}*\n📅 ${ds}\n📍 ${tl}${z ? `\n🔗 ${z}` : ''}\n\nBis bald!\nHappy Property` }
      const typeLabel = type === 'onsite' ? `${T.onsite}${address ? ` · ${address}` : ''}` : type === 'zoom' ? T.zoom : T.wa
      const desc = `Gebucht über Sven360.\n${T.with}: ${name}${email ? ` · ${email}` : ''}${phone ? ` · ${phone}` : ''}\n${T.kind}: ${typeLabel}${zoomLink ? `\nZoom: ${zoomLink}` : ''}`

      const ev = await createCalendarEvent(admin, { title: subject, startIso, endIso: end.toISOString(), description: desc, location: location ?? undefined })
      // INTERNE Termine (Mitarbeitende, die selbst einen Slot bei Sven buchen) duerfen
      // NICHT wie ein Kundentermin behandelt werden. Sonst haengt der Termin am Lead
      // gleichen Namens und loest die komplette Kundenautomatik aus - genau das ist am
      // 20.7. passiert: Gionas Buchung traf ihren alten HubSpot-Lead, worauf zwei
      // "termin_gebucht"-WhatsApps an sie geplant wurden.
      // Erkennung liegt in _shared/internalContact.ts, damit /buchen und /termin
      // dieselbe Entscheidung treffen — sonst umgeht man den Riegel durch die andere Tuer.
      const isInternal = await isInternalContact(admin, { email, phone, inviteInternal: inv?.internal === true })
      // an bestehenden Lead per E-Mail haengen (nur bei echten Kundenterminen)
      let leadId: string | null = null
      if (email && !isInternal) { const { data: l } = await admin.from('leads').select('id').ilike('email', email.trim()).limit(1).maybeSingle(); leadId = (l as { id?: string } | null)?.id ?? null }

      const { data: appt } = await admin.from('crm_appointments').insert({
        lead_id: leadId, title: subject, type: apptType, start_time: startIso, end_time: end.toISOString(),
        location, location_url: locUrl, description: desc, source: 'sven360', internal: isInternal,
        google_event_id: ev?.id ?? null, google_calendar_id: ev?.calId ?? null,
        attendees: [{ name, email: email ?? null, phone: phone ?? null }], created_by: lk.owner_id,
      }).select('id').single()

      // Betrifft die Buchung den HEUTIGEN Tag? Dann Sven sofort Bescheid geben.
      void notifyIfToday(admin, [startIso],
        `📅 Neuer Termin HEUTE um ${cyTime(startIso)}\n\n${name}\n${typeLabel}${phone ? `\n${phone}` : ''}\n\n(über deinen persönlichen Link)`)

      const first = (name || '').split(' ')[0] || name
      const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(subject)}&dates=${startIso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}/${end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}&details=${encodeURIComponent(desc)}${location ? `&location=${encodeURIComponent(location)}` : ''}`
      // Bestätigung per E-Mail (+ .ics)
      if (email) {
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
          <p>${T.greet(first)}</p><p>${T.confirmed}</p>
          <div style="background:#faf7f4;border-radius:14px;padding:16px 18px;margin:14px 0;">
            <p style="font-size:16px;font-weight:600;margin:0 0 6px;color:#111827;">${subject}</p>
            <p style="margin:0;color:#374151;">📅 ${dateStr}</p>
            <p style="margin:6px 0 0;color:#374151;">📍 ${typeLabel}</p>
            ${zoomLink ? `<p style="margin:6px 0 0;"><a href="${zoomLink}" style="color:#ff795d;">${T.zoomLinkLbl}</a></p>` : ''}
          </div>
          <p style="text-align:center;margin:20px 0;"><a href="${gcal}" style="background:#ff795d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block;">${T.gcalBtn}</a></p>
          <p style="font-size:13px;color:#6b7280;">${T.icsNote}</p></div>`
        const ics = buildIcs({ uid: appt?.id ?? crypto.randomUUID(), title: subject, startIso, endIso: end.toISOString(), description: desc, location: location ?? undefined })
        await admin.functions.invoke('send-email', { body: { to: email, subject: T.mailSubj(subject, fmtL(startIso, { day: '2-digit', month: '2-digit' })), html, lead_id: leadId, auto: true, attachment: { filename: 'termin.ics', content_base64: toB64(ics), content_type: 'text/calendar' } } }).catch((e: unknown) => console.warn('[personal-booking] mail:', e))
      }
      // Bestätigung per WhatsApp
      if (phone) {
        const wa = T.waMsg(subject, dateStr, typeLabel, zoomLink)
        await admin.functions.invoke('send-whatsapp', { body: { event_type: 'personal_booking', override_text: wa, lead_data: { lead_name: name, lead_phone: phone } } }).catch((e: unknown) => console.warn('[personal-booking] wa:', e))
      }
      return json({ ok: true, appointment: appt?.id, dateStr, typeLabel, zoomLink })
    }

    return json({ error: 'unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[personal-booking]', msg)
    return json({ error: msg }, 500)
  }
})
