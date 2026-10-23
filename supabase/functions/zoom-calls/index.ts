// Zoom-Gespräche: Kundenprofil aus der Zoom-Abschrift (Sven 22.10.26).
//
// Ablauf: Zoom nimmt den Call als Audio in der Cloud auf und erstellt die
// Abschrift. Zoom meldet "recording.transcript_completed" hierher. Wir ordnen
// den Call einem CRM-Termin zu, lassen Claude NUR die verkaufsrelevanten
// Kundenfakten herausziehen (Privates fällt raus) und schreiben:
//   - Notiz beim Kunden (activities type note, Reiter „Notizen")
//   - call_summaries.briefing (der Deck-Wizard belegt damit den Freitext vor)
// Die Abschrift wird nicht gespeichert, die Aufnahme danach in den
// Zoom-Papierkorb gelegt (30 Tage wiederherstellbar).
//
// Nicht zuordenbare Calls (kein passender Termin) und Gruppen-Calls
// (Masterclass) bleiben unangetastet: keine Notiz, nichts gelöscht.
//
// WhatsApp-Calls (Sven 23.10.26): Die Mac-App „HP Gesprächsnotiz" nimmt den Call
// auf, schreibt die Abschrift lokal (whisper) und schickt nur den Text hierher
// (Aktion upload). Audio verlässt den Mac nie.
//
// Aufrufer:
//   Zoom-Webhook  Header x-zm-signature, geprüft mit ZOOM_WEBHOOK_SECRET
//                 (connector_secrets, im CRM unter Einstellungen > Connectoren)
//   Mac-App       Aktion upload, Header x-cron-secret == connector_secrets CALL_UPLOAD_SECRET
//   Service-Key   Admin-Aktionen: scopes | list | trash_all | test

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, corsHeaders as CORS, safeEqual } from '../_shared/callerAuth.ts'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const sbAdmin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

async function secretOf(sb: SupabaseClient, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return (data as { value: string } | null)?.value ?? Deno.env.get(key) ?? ''
}

// ── Zoom-API ────────────────────────────────────────────────────────────────

async function zoomToken(): Promise<{ token: string; scope: string }> {
  const accountId = Deno.env.get('ZOOM_ACCOUNT_ID') ?? ''
  const clientId = Deno.env.get('ZOOM_CLIENT_ID') ?? ''
  const clientSecret = Deno.env.get('ZOOM_CLIENT_SECRET') ?? ''
  if (!accountId || !clientId || !clientSecret) throw new Error('Zoom nicht konfiguriert')
  const r = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    { method: 'POST', headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` } },
  )
  if (!r.ok) throw new Error(`Zoom Token Fehler (${r.status}): ${await r.text()}`)
  const j = await r.json() as { access_token: string; scope?: string }
  return { token: j.access_token, scope: j.scope ?? '' }
}

/** Meeting-UUIDs mit "/" am Anfang oder "//" müssen doppelt kodiert werden. */
function encUuid(uuid: string): string {
  return uuid.startsWith('/') || uuid.includes('//')
    ? encodeURIComponent(encodeURIComponent(uuid))
    : encodeURIComponent(uuid)
}

async function trashRecording(token: string, uuid: string): Promise<{ ok: boolean; detail: string }> {
  const r = await fetch(`https://api.zoom.us/v2/meetings/${encUuid(uuid)}/recordings?action=trash`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  })
  return { ok: r.ok || r.status === 204, detail: r.ok ? '' : `${r.status} ${await r.text()}` }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)

interface ZoomMeetingRec { uuid: string; id: number; topic: string; start_time: string; total_size?: number }

async function listRecordings(token: string, months: number, trash = false): Promise<{ meetings: ZoomMeetingRec[]; errors: string[] }> {
  const seen = new Map<string, ZoomMeetingRec>()
  const errors: string[] = []
  const now = new Date()
  for (let m = 0; m < months; m++) {
    const to = new Date(now.getTime() - m * 30 * 86400000)
    const from = new Date(to.getTime() - 30 * 86400000)
    let next = ''
    do {
      const url = `https://api.zoom.us/v2/users/me/recordings?page_size=300&from=${ymd(from)}&to=${ymd(to)}${trash ? '&trash=true' : ''}` +
        (next ? `&next_page_token=${encodeURIComponent(next)}` : '')
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) { errors.push(`${ymd(from)}..${ymd(to)}: ${r.status} ${await r.text()}`); break }
      const j = await r.json() as { meetings?: ZoomMeetingRec[]; next_page_token?: string }
      for (const mt of j.meetings ?? []) seen.set(mt.uuid, mt)
      next = j.next_page_token ?? ''
    } while (next)
    if (errors.length >= 3) break
  }
  return { meetings: [...seen.values()], errors }
}

// ── Webhook-Signatur ────────────────────────────────────────────────────────

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Abschrift ───────────────────────────────────────────────────────────────

/** Zoom-VTT in „Sprecher: Text"-Zeilen, aufeinanderfolgende Sätze desselben Sprechers zusammengefasst. */
export function vttToText(vtt: string): { text: string; speakers: string[] } {
  const out: { who: string; said: string }[] = []
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line) || line.includes('-->')) continue
    const m = line.match(/^([^:]{1,60}):\s*(.*)$/)
    const who = m ? m[1].trim() : (out.at(-1)?.who ?? '?')
    const said = m ? m[2] : line
    if (out.length && out.at(-1)!.who === who) out.at(-1)!.said += ' ' + said
    else out.push({ who, said })
  }
  return {
    text: out.map(o => `${o.who}: ${o.said}`).join('\n'),
    speakers: [...new Set(out.map(o => o.who))].filter(s => s !== '?'),
  }
}

// ── Claude: Kundenprofil ────────────────────────────────────────────────────

interface Profil {
  kundengespraech: boolean
  briefing: string
  notiz: string
  termine?: { datum: string; was: string }[]
  kunde_name?: string
}

const PROFIL_TOOL = {
  name: 'kundenprofil',
  description: 'Verkaufsrelevante Fakten über den Kunden aus dem Gespräch.',
  input_schema: {
    type: 'object',
    properties: {
      kundengespraech: { type: 'boolean', description: 'true, wenn es ein Gespräch mit einem (möglichen) Käufer/Investor war. false bei internen Calls, Tests, Bauträgern, Partnern.' },
      kunde_name: { type: 'string', description: 'Name des Kunden, wie im Gespräch genannt (leer, wenn unklar).' },
      briefing: { type: 'string', description: 'Kurzprofil in 2-5 Sätzen, dritte Person, sachlich, nur Fakten. Beispiel: „Unternehmer, 50 Jahre, besitzt 20 Wohnungen in Deutschland. Will auf Zypern investieren und selbst 3 Monate im Jahr hier sein. War noch nie auf Zypern, kommt am 30.10. Budget rund 500.000 € Eigenkapital, keine Finanzierung."' },
      notiz: { type: 'string', description: 'Stichpunkte unter diesen Überschriften (nur Überschriften mit Inhalt): „Person", „Vermögen & Finanzierung", „Ziel & Strategie", „Zypern & Termine", „Interesse an Objekten", „Fragen & Bedenken", „Vereinbart / nächste Schritte". Überschrift allein in einer Zeile mit Doppelpunkt, OHNE Strich davor; darunter jeder Stichpunkt mit „- "; Leerzeile zwischen den Abschnitten.' },
      termine: {
        type: 'array', description: 'Konkrete Daten aus dem Gespräch (Anreise, Besichtigung, Rückmeldung bis ...), als Datum aufgelöst.',
        items: { type: 'object', properties: { datum: { type: 'string', description: 'YYYY-MM-DD' }, was: { type: 'string' } }, required: ['datum', 'was'] },
      },
    },
    required: ['kundengespraech', 'briefing', 'notiz'],
  },
}

function profilPrompt(text: string, startedAt: string): string {
  const datum = new Date(startedAt).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Nicosia' })
  return `Abschrift eines Gesprächs von Sven (Happy Property, verkauft Neubau-Immobilien auf Zypern an deutschsprachige Investoren) mit einem Interessenten. Gesprächsdatum: ${datum}.

Zieh NUR die Fakten über den Kunden heraus, die Sven für Beratung und Verkauf braucht:
Beruf/Unternehmer, Alter, Familienstand nur wenn kaufrelevant (z.B. „mit Frau und 2 Kindern, braucht 3 Schlafzimmer"), Wohnort, Immobilienbestand, Vermögen/Eigenkapital/Budget, Finanzierung, Ziel (Investment, Vermietung kurz/lang, Eigennutzung, Auswandern, Steuern), wie lange/oft er auf Zypern sein will, ob er Zypern schon kennt, Reise- und Besichtigungstermine, Wünsche (Lage, Zimmer, Meerblick, Pool ...), Projekte/Wohnungen, die ihn interessieren, Zeitrahmen für den Kauf, Bedenken und offene Fragen, was vereinbart wurde.

Regeln:
- Privates ohne Kaufbezug komplett weglassen: Gesundheit, Beziehungen, Klatsch, Politik, Religion, Geschichten über Dritte, alles Private von Sven.
- Nur was im Gespräch wirklich gesagt wurde. Nichts ergänzen, nichts schätzen. Zahlen und Daten exakt übernehmen. Unklares weglassen.
- Relative Daten („nächsten Donnerstag", „Ende des Monats") mit dem Gesprächsdatum in ein echtes Datum umrechnen.
- Die Abschrift ist automatisch erstellt und kann Hörfehler enthalten (Projektnamen, Zahlen). Offensichtliche Hörfehler sinnvoll lesen, bei Zweifel weglassen.
- Auch die Sprecherangaben können vereinzelt falsch sein. Entscheide nach dem Inhalt, ob Sven oder der Kunde etwas über sich sagt. Was Sven über Objekte, Zypern oder seine Leistungen erzählt, ist kein Kundenfakt.
- Deutsch mit echten Umlauten. Keine Gedankenstriche (— oder –), stattdessen Komma, Punkt oder Doppelpunkt.
- Ruf das Werkzeug kundenprofil auf.

ABSCHRIFT:
${text.slice(0, 120000)}`
}

async function extractProfil(text: string, startedAt: string): Promise<Profil | null> {
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-opus-5-5', fallbackModels: ['claude-sonnet-4-6'], max_tokens: 4000, label: 'zoom-calls-profil',
    messages: [{ role: 'user', content: profilPrompt(text, startedAt) }],
    tools: [PROFIL_TOOL], tool_choice: { type: 'tool', name: 'kundenprofil' },
  })
  if (!res.ok) return null
  const p = toolInput<Profil>(res)
  if (!p || typeof p.briefing !== 'string' || typeof p.notiz !== 'string') return null
  const clean = (s: string) => s.replace(/\s*[—–]\s*/g, ', ').trim()
  return { ...p, briefing: clean(p.briefing), notiz: clean(p.notiz) }
}

// ── Zuordnung Call → CRM-Termin ─────────────────────────────────────────────

interface Appt { id: string; lead_id: string | null; deal_id: string | null; type: string | null; zoom_link: string | null; zoom_meeting_id: string | null; start_time: string; internal: boolean | null }

/**
 * Termin im Fenster ±90 Min um den Call-Start. Vorrang: Zoom-Link/ID enthält
 * die Meeting-Nummer, dann Termin vom Typ zoom. Nur bei genau einem Treffer.
 * (Persönlicher Meetingraum = gleiche Nummer für alle Termine, deshalb immer
 * mit Zeitfenster.)
 */
async function findAppointment(sb: SupabaseClient, meetingId: string, startIso: string): Promise<Appt | null> {
  const t = new Date(startIso).getTime()
  const { data } = await sb.from('crm_appointments')
    .select('id, lead_id, deal_id, type, zoom_link, zoom_meeting_id, start_time, internal')
    .gte('start_time', new Date(t - 90 * 60000).toISOString())
    .lte('start_time', new Date(t + 90 * 60000).toISOString())
    .not('lead_id', 'is', null)
  const rows = ((data ?? []) as Appt[]).filter(a => a.internal !== true)
  const id = meetingId.replace(/\D/g, '')
  const byId = rows.filter(a => id && (`${a.zoom_link ?? ''} ${a.zoom_meeting_id ?? ''}`).replace(/\s/g, '').includes(id))
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) {
    // mehrere Termine mit demselben (persönlichen) Raum: der zeitlich nächste
    byId.sort((a, b) => Math.abs(new Date(a.start_time).getTime() - t) - Math.abs(new Date(b.start_time).getTime() - t))
    return byId[0]
  }
  const zoom = rows.filter(a => a.type === 'zoom')
  return zoom.length === 1 ? zoom[0] : null
}

// ── Notiz beim Kunden ───────────────────────────────────────────────────────

async function schreibeNotiz(sb: SupabaseClient, leadId: string, dealId: string | null, startedAt: string, kanal: string, profil: Profil) {
  const tag = new Date(startedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Nicosia' })
  const { data, error } = await sb.from('activities').insert({
    lead_id: leadId, deal_id: dealId, type: 'note', direction: 'outbound', auto: true,
    subject: `📞 Gespräch ${tag} (${kanal}): Kundenprofil`,
    content: `${profil.briefing}\n\n${profil.notiz}`,
    completed_at: startedAt,
  }).select('id').single()
  return { act: data as { id: string } | null, actErr: error }
}

// ── Verarbeitung eines Calls ────────────────────────────────────────────────

interface ZoomObject {
  uuid: string; id: number | string; topic?: string; start_time: string; duration?: number
  recording_files?: { file_type?: string; download_url?: string; recording_type?: string }[]
}

async function processTranscript(obj: ZoomObject, downloadToken: string): Promise<Record<string, unknown>> {
  const sb = sbAdmin()
  const ext = obj.uuid

  // Doppelte Zustellung (Zoom wiederholt Webhooks): nur einmal verarbeiten.
  const { data: vorhanden } = await sb.from('call_summaries').select('id, status').eq('source', 'zoom').eq('external_id', ext).maybeSingle()
  if (vorhanden && (vorhanden as { status: string }).status !== 'fehler') return { skipped: 'schon_verarbeitet' }

  const protokoll = async (status: 'fertig' | 'uebersprungen' | 'fehler', felder: Record<string, unknown>) => {
    await sb.from('call_summaries').upsert({
      source: 'zoom', external_id: ext, started_at: obj.start_time, duration_min: obj.duration ?? null, status, ...felder,
    }, { onConflict: 'source,external_id' })
  }

  if (/masterclass|webinar/i.test(obj.topic ?? '')) {
    await protokoll('uebersprungen', { grund: 'Gruppen-Call (Masterclass/Webinar), Aufnahme bleibt' })
    return { skipped: 'gruppe' }
  }

  const appt = await findAppointment(sb, String(obj.id), obj.start_time)
  if (!appt) {
    await protokoll('uebersprungen', { grund: 'kein passender CRM-Termin, Aufnahme bleibt' })
    return { skipped: 'kein_termin' }
  }

  const file = (obj.recording_files ?? []).find(f => f.file_type === 'TRANSCRIPT' && f.download_url)
  if (!file?.download_url) {
    await protokoll('fehler', { lead_id: appt.lead_id, appointment_id: appt.id, grund: 'keine Abschrift in der Meldung' })
    return { error: 'keine_abschrift' }
  }
  let dl = await fetch(file.download_url, { headers: { Authorization: `Bearer ${downloadToken}` } })
  if (!dl.ok) {
    const sep = file.download_url.includes('?') ? '&' : '?'
    dl = await fetch(`${file.download_url}${sep}access_token=${encodeURIComponent(downloadToken)}`)
  }
  if (!dl.ok) {
    await protokoll('fehler', { lead_id: appt.lead_id, appointment_id: appt.id, grund: `Abschrift-Download ${dl.status}` })
    return { error: 'download' }
  }
  const { text, speakers } = vttToText(await dl.text())

  if (speakers.length > 4) {
    await protokoll('uebersprungen', { lead_id: appt.lead_id, appointment_id: appt.id, grund: `${speakers.length} Sprecher (Gruppe), Aufnahme bleibt` })
    return { skipped: 'gruppe' }
  }
  if (text.length < 200) {
    await protokoll('uebersprungen', { lead_id: appt.lead_id, appointment_id: appt.id, grund: 'Abschrift zu kurz' })
    return { skipped: 'zu_kurz' }
  }

  const profil = await extractProfil(text, obj.start_time)
  if (!profil) {
    await protokoll('fehler', { lead_id: appt.lead_id, appointment_id: appt.id, grund: 'KI-Auswertung fehlgeschlagen, Aufnahme bleibt' })
    return { error: 'ki' }
  }
  if (!profil.kundengespraech) {
    await protokoll('uebersprungen', { lead_id: appt.lead_id, appointment_id: appt.id, grund: 'kein Kundengespräch laut KI, Aufnahme bleibt' })
    return { skipped: 'kein_kunde' }
  }

  const { act, actErr } = await schreibeNotiz(sb, appt.lead_id!, appt.deal_id, obj.start_time, 'Zoom', profil)
  if (actErr) {
    await protokoll('fehler', { lead_id: appt.lead_id, appointment_id: appt.id, grund: `Notiz: ${actErr.message}` })
    return { error: 'notiz' }
  }

  // Erst wenn die Notiz sicher steht: Aufnahme in den Zoom-Papierkorb.
  let geloescht = false
  let loeschGrund = ''
  try {
    const { token } = await zoomToken()
    const t = await trashRecording(token, obj.uuid)
    geloescht = t.ok
    loeschGrund = t.detail
  } catch (e) { loeschGrund = String((e as Error).message ?? e) }

  await protokoll('fertig', {
    lead_id: appt.lead_id, deal_id: appt.deal_id, appointment_id: appt.id,
    briefing: profil.briefing, notiz: profil.notiz,
    fakten: { termine: profil.termine ?? [], kunde_name: profil.kunde_name ?? null },
    activity_id: act?.id ?? null, aufnahme_geloescht: geloescht,
    grund: geloescht ? null : `Aufnahme nicht gelöscht: ${loeschGrund}`.slice(0, 300),
  })
  return { ok: true, lead_id: appt.lead_id, geloescht }
}

// ── WhatsApp-Call von der Mac-App ───────────────────────────────────────────

interface UploadBody {
  id?: string; lead_id?: string | null; appointment_id?: string | null; phone?: string | null
  started_at?: string; duration_min?: number; text?: string
  /** Probelauf der Mac-App: nur auswerten, nichts schreiben */
  test?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lead zur Nummer: letzte 9 Ziffern vorfiltern, dann exakt auf Ziffern vergleichen. Nur bei genau einem Treffer. */
async function leadByPhone(sb: SupabaseClient, phone: string): Promise<string | null> {
  const d = phone.replace(/\D/g, '').replace(/^00/, '')
  if (d.length < 8) return null
  const tail = d.slice(-9)
  const { data } = await sb.from('leads').select('id, phone, whatsapp')
    .or(`whatsapp.ilike.%${tail}%,phone.ilike.%${tail}%`).limit(10)
  const norm = (v: string | null) => (v ?? '').replace(/\D/g, '').replace(/^00/, '').replace(/^0/, '')
  const hits = ((data ?? []) as { id: string; phone: string | null; whatsapp: string | null }[])
    .filter(l => [norm(l.whatsapp), norm(l.phone)].some(n => n.length >= 8 && (d.endsWith(n) || n.endsWith(d.slice(-n.length)))))
  return hits.length === 1 ? hits[0].id : null
}

async function processUpload(b: UploadBody): Promise<Record<string, unknown>> {
  const sb = sbAdmin()
  const ext = String(b.id ?? '').slice(0, 80)
  const text = typeof b.text === 'string' ? b.text : ''
  const startedAt = b.started_at && !isNaN(Date.parse(b.started_at)) ? b.started_at : new Date().toISOString()
  if (!ext) return { error: 'id fehlt' }
  if (b.test === true) {
    const profil = text.length >= 40 ? await extractProfil(text, startedAt) : null
    return { ok: true, test: true, zeichen: text.length, profil }
  }

  const { data: vorhanden } = await sb.from('call_summaries').select('status, lead_id').eq('source', 'whatsapp').eq('external_id', ext).maybeSingle()
  if (vorhanden && (vorhanden as { status: string }).status === 'fertig') return { ok: true, schon_verarbeitet: true }

  const protokoll = async (status: 'fertig' | 'uebersprungen' | 'fehler', felder: Record<string, unknown>) => {
    await sb.from('call_summaries').upsert({
      source: 'whatsapp', external_id: ext, started_at: startedAt, duration_min: b.duration_min ?? null, status, ...felder,
    }, { onConflict: 'source,external_id' })
  }

  let leadId: string | null = null
  if (b.lead_id && UUID.test(b.lead_id)) {
    const { data } = await sb.from('leads').select('id').eq('id', b.lead_id).maybeSingle()
    leadId = (data as { id: string } | null)?.id ?? null
  }
  if (!leadId && b.phone) leadId = await leadByPhone(sb, b.phone)
  if (!leadId) {
    await protokoll('uebersprungen', { grund: 'kein Kunde zur Nummer gefunden' })
    return { skipped: 'kein_kunde' }
  }

  let apptId: string | null = null
  let dealId: string | null = null
  if (b.appointment_id && UUID.test(b.appointment_id)) {
    const { data } = await sb.from('crm_appointments').select('id, deal_id').eq('id', b.appointment_id).eq('lead_id', leadId).maybeSingle()
    apptId = (data as { id: string } | null)?.id ?? null
    dealId = (data as { deal_id: string | null } | null)?.deal_id ?? null
  }
  if (!dealId) {
    const { data } = await sb.from('deals').select('id').eq('lead_id', leadId).order('updated_at', { ascending: false }).limit(1).maybeSingle()
    dealId = (data as { id: string } | null)?.id ?? null
  }

  if (text.length < 200) {
    await protokoll('uebersprungen', { lead_id: leadId, appointment_id: apptId, grund: 'Abschrift zu kurz' })
    return { skipped: 'zu_kurz' }
  }
  const profil = await extractProfil(text, startedAt)
  if (!profil) {
    await protokoll('fehler', { lead_id: leadId, appointment_id: apptId, grund: 'KI-Auswertung fehlgeschlagen' })
    return { error: 'ki' }
  }
  if (!profil.kundengespraech) {
    await protokoll('uebersprungen', { lead_id: leadId, appointment_id: apptId, grund: 'kein Kundengespräch laut KI' })
    return { skipped: 'kein_kundengespraech' }
  }
  const { act, actErr } = await schreibeNotiz(sb, leadId, dealId, startedAt, 'WhatsApp', profil)
  if (actErr) {
    await protokoll('fehler', { lead_id: leadId, appointment_id: apptId, grund: `Notiz: ${actErr.message}` })
    return { error: 'notiz' }
  }
  await protokoll('fertig', {
    lead_id: leadId, deal_id: dealId, appointment_id: apptId,
    briefing: profil.briefing, notiz: profil.notiz,
    fakten: { termine: profil.termine ?? [], kunde_name: profil.kunde_name ?? null },
    activity_id: act?.id ?? null,
  })
  const { data: lead } = await sb.from('leads').select('first_name, last_name').eq('id', leadId).maybeSingle()
  const l = lead as { first_name: string | null; last_name: string | null } | null
  return { ok: true, kunde: `${l?.first_name ?? ''} ${l?.last_name ?? ''}`.trim() }
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // Zoom-Webhook
  if (req.headers.get('x-zm-signature') || req.headers.get('x-zm-request-timestamp')) {
    const raw = await req.text()
    const secret = await secretOf(sbAdmin(), 'ZOOM_WEBHOOK_SECRET')
    if (!secret) return json({ error: 'nicht eingerichtet' }, 503)
    const ts = req.headers.get('x-zm-request-timestamp') ?? ''
    const sig = req.headers.get('x-zm-signature') ?? ''
    if (!safeEqual(sig, `v0=${await hmacHex(secret, `v0:${ts}:${raw}`)}`)) return json({ error: 'Signatur ungültig' }, 401)
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: 'zu alt' }, 401)

    const ev = JSON.parse(raw) as { event?: string; payload?: { plainToken?: string; object?: ZoomObject }; download_token?: string }
    if (ev.event === 'endpoint.url_validation' && ev.payload?.plainToken) {
      return json({ plainToken: ev.payload.plainToken, encryptedToken: await hmacHex(secret, ev.payload.plainToken) })
    }
    if (ev.event === 'recording.transcript_completed' && ev.payload?.object) {
      // Zoom will binnen 3 s eine Antwort, die Auswertung läuft danach weiter.
      const job = processTranscript(ev.payload.object, ev.download_token ?? '')
        .then(r => console.log('[zoom-calls]', JSON.stringify(r)))
        .catch(e => console.error('[zoom-calls] Fehler', e))
      // deno-lint-ignore no-explicit-any
      ;(globalThis as any).EdgeRuntime?.waitUntil?.(job)
    }
    return json({ ok: true })
  }

  const body = await req.clone().json().catch(() => ({})) as { action?: string; months?: number; vtt?: string; started_at?: string; trash?: boolean }

  // Mac-App: eigener Schlüssel, darf nur hochladen
  if (body.action === 'upload') {
    const caller = await authorizeCaller(req, { cron: true, cronKey: 'CALL_UPLOAD_SECRET', service: true }, CORS)
    if (caller instanceof Response) return caller
    try {
      return json(await processUpload(body as UploadBody))
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 500)
    }
  }

  const caller = await authorizeCaller(req, { service: true }, CORS)
  if (caller instanceof Response) return caller

  try {

    // Probelauf der KI-Auswertung ohne Schreiben (nur Service-Key)
    if (body.action === 'test') {
      const { text, speakers } = vttToText(body.vtt ?? '')
      const profil = await extractProfil(text, body.started_at ?? new Date().toISOString())
      return json({ speakers, profil })
    }

    const { token, scope } = await zoomToken()
    if (body.action === 'scopes') return json({ scope: scope.split(' ').sort() })

    if (body.action === 'list' || body.action === 'trash_all') {
      const { meetings, errors } = await listRecordings(token, Math.min(60, body.months ?? 36), body.action === 'list' && body.trash === true)
      const totalMb = Math.round(meetings.reduce((s, m) => s + (m.total_size ?? 0), 0) / 1048576)
      if (body.action === 'list') {
        return json({
          count: meetings.length, total_mb: totalMb, errors,
          meetings: meetings.map(m => ({ topic: m.topic, start: m.start_time, mb: Math.round((m.total_size ?? 0) / 1048576) })),
        })
      }
      const failed: string[] = []
      let trashed = 0
      for (const m of meetings) {
        const t = await trashRecording(token, m.uuid)
        if (t.ok) trashed++
        else failed.push(`${m.topic} ${m.start_time}: ${t.detail}`)
      }
      return json({ found: meetings.length, total_mb: totalMb, trashed, failed, list_errors: errors })
    }

    return json({ error: 'unbekannte Aktion' }, 400)
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500)
  }
})
