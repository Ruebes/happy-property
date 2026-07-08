// Edge Function: funnel-api — öffentliche API für den eigenen Termin-Funnel
// (ersetzt Typeform + Calendly). Drei Aktionen:
//   track → Session anlegen / Schritt-Event loggen (Drop-off-Analyse)
//   slots → freie Termine: 4h Vorlauf, 12:00–20:00 Zypern-Zeit (Europe/Nicosia),
//           30-Min-Raster, gegen den Google-Kalender (Service-Account, freeBusy)
//   book  → Konflikt-Check + Lead-Upsert + Termin (CRM + Google) + Zoom-Meeting +
//           Bestätigung über die „Termin gebucht"-Pipeline-Vorlagen (Mail + WhatsApp)
//
// Deployment: supabase functions deploy funnel-api --no-verify-jwt

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const TZ_CY = 'Asia/Nicosia'          // Buchungsfenster läuft in Zypern-Zeit
const SLOT_MIN = 30                    // Termindauer
const OPEN_H = 12, CLOSE_H = 20        // 12:00–20:00 Zypern-Zeit
const LEAD_HOURS = 4                   // Vorlauf
const DAYS_AHEAD = 14                  // Buchungsfenster

// ── Google Service-Account (Muster aus booking-bot) ─────────────────────────
function b64url(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
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
  return raw ? raw.split(',')[0].trim() : 'primary'
}
async function getBusy(admin: SupabaseClient, from: Date, to: Date): Promise<Array<{ start: number; end: number }>> {
  try {
    const calId = await getCalendarId(admin)
    const token = await getSaToken()
    const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calId }] }),
    })
    const d = await r.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }
    const busy = Object.values(d.calendars ?? {}).flatMap(c => c.busy ?? [])
    return busy.map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
  } catch (e) { console.warn('[funnel-api] freeBusy fehlgeschlagen:', e); return [] }
}
// CRM-Termine zusätzlich blocken (falls Google mal hakt)
async function getCrmBusy(admin: SupabaseClient, from: Date, to: Date): Promise<Array<{ start: number; end: number }>> {
  const { data } = await admin.from('crm_appointments').select('start_time, end_time')
    .gte('start_time', from.toISOString()).lte('start_time', to.toISOString())
  return ((data ?? []) as Array<{ start_time: string; end_time: string | null }>).map(a => ({
    start: new Date(a.start_time).getTime(),
    end: a.end_time ? new Date(a.end_time).getTime() : new Date(a.start_time).getTime() + SLOT_MIN * 60000,
  }))
}

// Zypern-Lokalzeit einer UTC-Instanz (Stunden/Minuten/Datumsteile)
function cyParts(d: Date): { y: number; mo: number; day: number; h: number; mi: number } {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_CY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0)
  return { y: g('year'), mo: g('month'), day: g('day'), h: g('hour'), mi: g('minute') }
}
// UTC-Zeitpunkt für eine Zypern-Lokalzeit (Offset-Probe, DST-sicher)
function cyToUtc(y: number, mo: number, day: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, day, h, mi)
  for (const offH of [3, 2]) {   // EEST +3 (Sommer) / EET +2 (Winter)
    const d = new Date(guess - offH * 3600e3)
    const p = cyParts(d)
    if (p.h === h && p.mi === mi && p.day === day) return d
  }
  return new Date(guess - 3 * 3600e3)
}

// Freie Slots: 30-Min-Raster 12:00–19:30 (Start) Zypern-Zeit, nächste 14 Tage, 4h Vorlauf
async function computeSlots(admin: SupabaseClient): Promise<string[]> {
  const now = new Date()
  const earliest = now.getTime() + LEAD_HOURS * 3600e3
  const to = new Date(now.getTime() + (DAYS_AHEAD + 1) * 24 * 3600e3)
  const busy = [...await getBusy(admin, now, to), ...await getCrmBusy(admin, now, to)]
  const isFree = (t: number) => t >= earliest && !busy.some(b => t < b.end && t + SLOT_MIN * 60000 > b.start)
  const out: string[] = []
  for (let dOff = 0; dOff <= DAYS_AHEAD; dOff++) {
    const anchor = new Date(now.getTime() + dOff * 24 * 3600e3)
    const p = cyParts(anchor)
    for (let h = OPEN_H; h < CLOSE_H; h++) {
      for (const mi of [0, 30]) {
        if (h * 60 + mi + SLOT_MIN > CLOSE_H * 60) continue
        const start = cyToUtc(p.y, p.mo, p.day, h, mi)
        if (isFree(start.getTime())) out.push(start.toISOString())
      }
    }
  }
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json() as {
      action: 'track' | 'slots' | 'book'
      session_id?: string
      step?: number; question_key?: string; answer?: string
      utm?: Record<string, string>; referrer?: string
      slot_start_iso?: string
      meeting_type?: 'zoom' | 'whatsapp'
      contact?: { first_name?: string; last_name?: string; phone?: string; email?: string; website?: string }
      answers?: Array<{ question: string; answer: string }>
    }

    // ── track ────────────────────────────────────────────────────────────────
    if (body.action === 'track') {
      let sid = body.session_id ?? null
      if (!sid) {
        const { data } = await admin.from('funnel_sessions').insert({
          utm: body.utm ?? null, referrer: body.referrer ?? null,
          user_agent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
        }).select('id').single()
        sid = (data as { id: string } | null)?.id ?? null
      }
      if (sid && body.question_key) {
        await admin.from('funnel_events').insert({
          session_id: sid, step: body.step ?? 0,
          question_key: body.question_key.slice(0, 80), answer: (body.answer ?? '').slice(0, 500) || null,
        })
      }
      return json({ ok: true, session_id: sid })
    }

    // ── slots ────────────────────────────────────────────────────────────────
    if (body.action === 'slots') {
      const slots = await computeSlots(admin)
      return json({ ok: true, slots, duration_min: SLOT_MIN })
    }

    // ── book ─────────────────────────────────────────────────────────────────
    if (body.action === 'book') {
      const c = body.contact ?? {}
      if (c.website) return json({ ok: true })   // Honeypot: still schlucken
      if (!body.slot_start_iso || !c.first_name || !c.email || !c.phone) return json({ error: 'Pflichtfelder fehlen' }, 400)
      const start = new Date(body.slot_start_iso)
      if (isNaN(start.getTime()) || start.getTime() < Date.now() + (LEAD_HOURS - 0.25) * 3600e3) return json({ error: 'slot_invalid' }, 409)
      const end = new Date(start.getTime() + SLOT_MIN * 60000)
      // Konflikt-Check direkt vor der Buchung
      const busy = [...await getBusy(admin, start, end), ...await getCrmBusy(admin, new Date(start.getTime() - 3600e3), end)]
      if (busy.some(b => start.getTime() < b.end && end.getTime() > b.start)) return json({ error: 'slot_taken' }, 409)

      const type = body.meeting_type === 'whatsapp' ? 'whatsapp' : 'zoom'
      const phone = (c.phone ?? '').replace(/[^\d+]/g, '')
      const email = (c.email ?? '').trim().toLowerCase()

      // Lead upsert (Match per E-Mail, sonst Telefon, sonst neu)
      let leadId: string | null = null
      const { data: byMail } = await admin.from('leads').select('id').ilike('email', email).limit(1)
      if (byMail?.length) leadId = (byMail[0] as { id: string }).id
      if (!leadId && phone) {
        const { data: byPhone } = await admin.from('leads').select('id').or(`phone.eq.${phone},whatsapp.eq.${phone}`).limit(1)
        if (byPhone?.length) leadId = (byPhone[0] as { id: string }).id
      }
      const utmNote = body.utm && Object.keys(body.utm).length ? `\nKanal: ${JSON.stringify(body.utm)}` : ''
      const answersText = (body.answers ?? []).map(a => `• ${a.question}: ${a.answer}`).join('\n')
      if (!leadId) {
        const { data: nl } = await admin.from('leads').insert({
          first_name: c.first_name?.trim(), last_name: (c.last_name ?? '').trim(),
          email, phone, whatsapp: phone, source: 'website',
          notes: `Fragebogen (eigener Funnel):\n${answersText}${utmNote}`,
        }).select('id').single()
        leadId = (nl as { id: string } | null)?.id ?? null
      } else {
        const { data: old } = await admin.from('leads').select('notes').eq('id', leadId).single()
        const prev = (old as { notes?: string } | null)?.notes ?? ''
        await admin.from('leads').update({ notes: `${prev ? prev + '\n\n' : ''}Fragebogen (eigener Funnel, ${new Date().toLocaleDateString('de-DE')}):\n${answersText}${utmNote}` }).eq('id', leadId)
      }
      if (!leadId) return json({ error: 'lead_failed' }, 500)

      // Zoom-Meeting (nur bei Zoom-Terminart)
      let zoomLink: string | null = null
      if (type === 'zoom') {
        try {
          const { data: z } = await admin.functions.invoke('create-zoom-meeting', { body: { title: `Beratungsgespräch – ${c.first_name}`, start_time: start.toISOString(), duration_minutes: SLOT_MIN } })
          zoomLink = (z as { join_url?: string } | null)?.join_url ?? null
        } catch (e) { console.warn('[funnel-api] Zoom fehlgeschlagen:', e) }
      }

      // Google-Kalender-Event
      let gcal: { id: string; calId: string } | null = null
      try {
        const calId = await getCalendarId(admin)
        const token = await getSaToken()
        const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: `Beratungsgespräch – ${c.first_name} ${c.last_name ?? ''}`.trim(),
            description: `Über den Website-Funnel gebucht (${type === 'zoom' ? 'Zoom' : 'WhatsApp-Call'})${zoomLink ? `\nZoom: ${zoomLink}` : ''}\nTel: ${phone}\nMail: ${email}`,
            start: { dateTime: start.toISOString(), timeZone: TZ_CY }, end: { dateTime: end.toISOString(), timeZone: TZ_CY },
          }),
        })
        const d = await r.json() as { id?: string }
        if (d.id) gcal = { id: d.id, calId }
      } catch (e) { console.warn('[funnel-api] Kalender fehlgeschlagen:', e) }

      // CRM-Termin
      const { data: appt } = await admin.from('crm_appointments').insert({
        lead_id: leadId, title: `Beratungsgespräch – ${c.first_name}`,
        description: 'Über den Website-Funnel gebucht', type,
        start_time: start.toISOString(), end_time: end.toISOString(),
        zoom_link: zoomLink, phone_number: type === 'whatsapp' ? phone : null,
        google_event_id: gcal?.id ?? null, google_calendar_id: gcal?.calId ?? null,
      }).select('id').single()

      // Fragebogen als Aktivität
      try {
        await admin.from('activities').insert({
          lead_id: leadId, type: 'note', direction: 'inbound',
          subject: '📋 Fragebogen (Website-Funnel)',
          content: `${answersText}${utmNote}\nTermin: ${start.toISOString()} (${type})`,
          completed_at: new Date().toISOString(),
        })
      } catch { /* egal */ }

      // Bestätigung über die editierbaren „Termin gebucht"-Vorlagen (Mail + WhatsApp)
      try { await admin.functions.invoke('schedule-message', { body: { lead_id: leadId, event_type: 'termin_gebucht' } }) }
      catch (e) { console.warn('[funnel-api] termin_gebucht-Trigger fehlgeschlagen:', e) }

      // Session abschließen
      if (body.session_id) {
        await admin.from('funnel_sessions').update({ lead_id: leadId, completed_at: new Date().toISOString() }).eq('id', body.session_id)
      }
      return json({ ok: true, appointment_id: (appt as { id: string } | null)?.id ?? null, zoom: !!zoomLink })
    }

    return json({ error: `Unbekannte action` }, 400)
  } catch (err) {
    console.error('[funnel-api] Fehler:', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
