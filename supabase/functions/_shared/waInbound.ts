// Gemeinsame Verarbeitung eingehender WhatsApp-Ereignisse, unabhaengig vom
// Anbieter. timelines-webhook und evolution-webhook bilden ihr jeweiliges
// Payload auf WaEvent ab und rufen processWaEvent auf. Die Fachlogik (Lead-
// Zuordnung, Verlauf, Nachfass-Stopp, Abmeldung, Termin-Bot, Aufgaben-Antwort)
// lebt NUR hier - vorher stand sie komplett im timelines-webhook.
//
// Regeln aus dem Hub: KI antwortet nur ueber den Termin-Bot (Entwurfsprinzip
// dort), eigene Nachrichten (fromMe) werden NIE als Kundennachricht behandelt,
// Duplikate ueber wa_processed (message_uid) abgefangen.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { maybeUpdateEmailFromWa } from './waMailUpdate.ts'
import { anfragePaketAnstossen } from './anfragePaket.ts'
import { maybeTippgeberAdresse } from './waTippgeberAdresse.ts'

export type WaEvent = {
  uid:    string | null      // Message-ID des Anbieters (Dedupe)
  phone:  string             // Kunden-Nummer (Gegenseite), beliebiges Format
  text:   string             // Nachrichtentext (leer bei reinen Medien)
  fromMe: boolean            // von unserer Nummer gesendet (Handy oder API)
  viaApi: boolean            // durch send-whatsapp gesendet -> bereits geloggt
  pushName?: string | null   // Anzeigename des Absenders (nur Log)
  mediaOnly?: boolean        // Bild/Sprachnachricht/Dokument ohne Text: in den Verlauf
                             // und Nachfass stoppen, aber weder Abmeldung noch Bot
}

// ── Stop-Intent-Erkennung ───────────────────────────────────────────────────
// Konservativ: nur bei eindeutigen Abmelde-Signalen. Erkennt der Kunde, dass er
// nicht mehr kontaktiert werden will, wird ein communication_optouts-Eintrag
// angelegt. Der DB-Trigger trg_hp_cancel_on_optout storniert daraufhin alle noch
// offenen geplanten Nachrichten dieses Leads. Sendet NICHTS – stoppt nur.
const STOP_PATTERNS: RegExp[] = [
  /\bstop\b/i,                                        // engl./Konvention: „STOP"
  /\bstopp/i,                                         // dt.: stopp, stoppen, stoppt, …
  /abmeld/i,                                          // abmelden, abmeldung
  /austragen/i,
  /\bunsubscribe\b/i,
  /kein(e|en)?\s+interesse/i,
  /nicht\s+mehr\s+(kontakt|schreib|anschreib|melden|nachricht|anruf)/i,
  /keine\s+(nachricht|werbung|mails?|e-?mails?|whatsapp|anrufe?)/i,
  /bitte\s+nicht\s+mehr/i,
  /löscht?\s+mich/i,
  /remove\s+me/i,
  /leave\s+me\s+alone/i,
  /do\s*n('|o)?t\s+contact/i,
  /stop\s+contacting/i,
]
export function detectsStopIntent(text: string): boolean {
  return STOP_PATTERNS.some((re) => re.test(text))
}

// Günstiger Vorfilter: könnte die Nachricht überhaupt um einen Termin gehen? Nur
// dann fragt der Bot die KI (spart KI-Aufrufe bei „danke"/„ok"/Produktfragen).
const APPT_HINT = /termin|telefon|anruf|\bruf|\bcall\b|zoom|video|sprechen|besprech|treffen|meeting|\bzeit\b|\bwann\b|uhrzeit|quatschen|kennenlern|kennen lern|persönlich|vorbei|\bmeet\b/i

async function callBot(action: 'engage' | 'reply' | 'engage_unknown' | 'answer', lead_id: string | null, text: string, tag: string, extra: Record<string, unknown> = {}): Promise<void> {
  const p = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-bot`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action, lead_id, text, ...extra }),
  }).then(r => r.text()).catch(e => console.error(`[${tag}] booking-bot ${action} Fehler:`, e))
  const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
  if (er) er.waitUntil(p); else await p
}

/** message_uid einmalig verbuchen. false = schon gesehen (Duplikat). */
export async function markProcessed(sb: SupabaseClient, uid: string | null): Promise<boolean> {
  if (!uid) return true
  const { error } = await sb.from('wa_processed').insert({ message_uid: String(uid) })
  return !error
}

/** Nachricht einer Nummer ohne Kontakt fuer den Posteingang festhalten. */
async function logUnknown(sb: SupabaseClient, ev: WaEvent, direction: 'inbound' | 'outbound', tag: string): Promise<void> {
  const digits = String(ev.phone).replace(/\D/g, '')
  if (digits.length < 7 || !ev.text) return
  const { error } = await sb.from('wa_unknown_messages').insert({
    phone: '+' + digits, push_name: direction === 'inbound' ? (ev.pushName ?? null) : null,
    direction, content: ev.text.slice(0, 20000),
    whatsapp_message_id: ev.uid ? String(ev.uid) : null,
  })
  if (error && error.code !== '23505') console.warn(`[${tag}] unbekannte Nummer:`, error.message)
}

export type WaOutcome = 'dupe' | 'outbound' | 'ignored' | 'no-lead' | 'processed' | 'error'

export async function processWaEvent(sb: SupabaseClient, ev: WaEvent, tag: string): Promise<{ outcome: WaOutcome; error?: string }> {
  // ── Richtung: eigene Nachrichten (auch das Echo unserer Bot-/API-Nachrichten!)
  // dürfen NIE als Kundennachricht verarbeitet werden — sonst antwortet der Bot
  // auf sich selbst (Endlosschleife).
  if (ev.fromMe) {
    // Sven tippt SELBST im Chat (nicht der Bot / nicht die CRM-API). Zwei Dinge:
    // (1) die Nachricht in den Verlauf/Posteingang schreiben, damit Sven auch SEINE
    // eigenen Antworten sieht; (2) wenn er mit einem Termin anfängt, übernimmt der
    // Bot die Terminlogistik. API-Echos sind bereits über send-whatsapp geloggt.
    if (!ev.viaApi && ev.text && ev.phone) {
      const digits = String(ev.phone).replace(/\D/g, '')
      if (digits.length >= 7) {
        try {
          const { data: rows } = await sb.rpc('find_leads_by_phone_suffix', { suffix: digits.slice(-8) })
          const lead = ((rows ?? []) as { id: string }[])[0]
          if (!lead) {
            // Sven schreibt einer Nummer ohne Kontakt: in den Posteingang (unbekannte Nummern).
            await logUnknown(sb, ev, 'outbound', tag)
          } else {
            const { error: le } = await sb.from('activities').insert({
              lead_id: lead.id, type: 'whatsapp', direction: 'outbound', auto: false,
              subject: 'WhatsApp gesendet', content: ev.text,
              completed_at: new Date().toISOString(),
              whatsapp_message_id: ev.uid ? String(ev.uid) : null,
            })
            if (le) console.warn(`[${tag}] outbound-log:`, le.message)
            if (APPT_HINT.test(ev.text)) await callBot('engage', lead.id, ev.text, tag)
          }
        } catch (e) { console.warn(`[${tag}] Sven-outbound:`, e) }
      }
    }
    return { outcome: 'outbound' }
  }

  // Ab hier: nur echte EINGEHENDE Kundennachrichten. Kunden-Nummer = Absender.
  const text = ev.text
  if (!ev.phone || !text) return { outcome: 'ignored' }

  // Lead robust über die Telefonnummer finden: NUR Ziffern vergleichen und per
  // Endung (letzte 8 Ziffern) matchen — unabhängig davon, ob der Anbieter mit/ohne
  // „+", Leerzeichen oder Länderformat schickt. Suffix ist reine Ziffern → keine
  // Filter-Injection. Bei mehreren Leads mit gleicher Nummer den neuesten nehmen.
  const digits = String(ev.phone).replace(/\D/g, '')

  // ── Aufgaben-Antwort ────────────────────────────────────────────────────
  // Gehört die Nummer zu einem/einer Zuständigen einer offenen Aufgabe, wird die
  // Nachricht als Bemerkung in die Aufgabe geschrieben (additiv, stört den Lead-/
  // Bot-Fluss nicht). Auf „erledigt" setzt man NUR über den Link.
  if (digits.length >= 7) {
    try {
      const { data: hit } = await sb.rpc('find_task_by_assignee_phone', { suffix: digits.slice(-8) })
      const row = Array.isArray(hit) ? hit[0] : hit
      if (row?.task_id) {
        await sb.from('crm_task_messages').insert({
          task_id: row.task_id, sender_id: null, sender_label: row.label ?? 'Extern',
          recipient_id: row.created_by, body: String(text).slice(0, 4000),
        })
        console.log(`[${tag}] Task-Antwort → Bemerkung (task ${row.task_id})`)
      }
    } catch (e) { console.warn(`[${tag}] Task-Reply:`, e) }
  }

  // ── Tippgeber-Adresse ───────────────────────────────────────────────────
  // Antwort eines Empfehlungsgebers auf Lottes Adress-Frage → affiliate-api trägt
  // die Adresse ein (additiv, im Hintergrund, auch wenn er kein Lead ist).
  if (digits.length >= 8 && !ev.mediaOnly && !detectsStopIntent(text)) await maybeTippgeberAdresse(sb, digits, text, tag)

  let lead: { id: string } | null = null
  if (digits.length >= 7) {
    const suffix = digits.slice(-8)
    // Normalisierter Match via RPC: vergleicht NUR die Ziffern der gespeicherten Nummer
    // (regexp_replace \D). Der alte ilike-Match scheiterte an Formatierung — z.B. bei
    // "+49 1515 8415620" ist die Endung "58415620" wegen des Leerzeichens KEIN Substring,
    // wodurch eingehende Antworten still verworfen wurden (Thomas' Terminbestätigung).
    const { data: rows, error: lErr } = await sb.rpc('find_leads_by_phone_suffix', { suffix })
    if (lErr) {
      // DB-Fehler NICHT verschlucken — sonst ginge eine eingehende „STOPP"-Abmeldung
      // verloren (Function meldete 200, Provider würde nicht erneut zustellen).
      console.error(`[${tag}] Lead-Lookup Fehler:`, lErr.message)
      return { outcome: 'error', error: lErr.message }
    }
    const matches = (rows ?? []) as { id: string }[]
    // Mehrere Leads mit DERSELBEN Nummer (Dubletten): den mit einem AKTIVEN
    // Bot-Gespräch bevorzugen — sonst würde die Antwort am falschen Lead landen
    // (ohne Gespräch → Bot reagiert nicht). Sonst der neueste.
    if (matches.length > 1) {
      const { data: convs } = await sb
        .from('booking_conversations')
        .select('lead_id')
        .in('lead_id', matches.map(m => m.id))
        .not('state', 'in', '(booked,handoff,expired)')
        .gt('expires_at', new Date().toISOString())
        .limit(1)
      const convLead = (convs as { lead_id: string }[] | null)?.[0]?.lead_id
      lead = convLead ? { id: convLead } : matches[0]
    } else {
      lead = matches[0] ?? null
    }
  }

  if (!lead) {
    // Kein Lead, vielleicht ein Newsletter-Abonnent, der auf die WhatsApp-Fassung
    // mit seiner neuen Mailadresse antwortet (waMailUpdate.ts).
    if (digits.length >= 7 && !ev.mediaOnly && !detectsStopIntent(text)) {
      const { data: subs } = await sb.from('newsletter_subscribers').select('id')
        .ilike('phone', `%${digits.slice(-8)}`).order('created_at').limit(1)
      const sub = (subs as { id: string }[] | null)?.[0]
      if (sub) await maybeUpdateEmailFromWa(sb, { subscriber_id: sub.id }, ev.phone, text, tag)
    }
    // Trotzdem in den Posteingang: Sven will ALLE WhatsApps der Geschaeftsnummer sehen,
    // nicht nur die von bekannten Kunden. Kein Bot, keine Automatik fuer diese Nummern.
    await logUnknown(sb, ev, 'inbound', tag)
    // Will die Person Sven einfach kennenlernen? Dann bietet Lotte das Café an und
    // legt erst dabei den Kontakt an (booking-bot entscheidet, im Hintergrund).
    if (!ev.mediaOnly && !detectsStopIntent(text) && APPT_HINT.test(text)) {
      await callBot('engage_unknown', null, text, tag, { phone: ev.phone, push_name: ev.pushName ?? null })
    }
    return { outcome: 'no-lead' }
  }

  await sb.from('activities').insert({
    lead_id:              lead.id,
    type:                 'whatsapp',
    direction:            'inbound',
    subject:              'WhatsApp erhalten',
    content:              text,
    completed_at:         new Date().toISOString(),
    whatsapp_message_id:  ev.uid ? String(ev.uid) : null,
  })

  // KI-Zusammenfassung löschen damit sie neu generiert wird
  await sb.from('lead_ai_summaries').delete().eq('lead_id', lead.id)

  // Kunde hat GEANTWORTET → Nachfass-Sequenzen stoppen. Die Drips sind für
  // Nicht-Reagierer; wer im Dialog ist, darf nicht weiter automatisch
  // angeschrieben werden (Norbert-Fall: „Hatte ich Dir doch geschrieben!").
  // Newsletter & Termin-Nachrichten bleiben unberührt.
  const { error: seqErr } = await sb
    .from('scheduled_messages')
    .update({ status: 'cancelled', error_message: 'Kunde hat geantwortet — Nachfass-Sequenz gestoppt' })
    .eq('lead_id', lead.id).eq('status', 'pending')
    .in('event_type', ['erstkontakt', 'no_show', 'immobilienauswahl', 'deck_viewed_followup', 'bot_nudge'])
  if (seqErr) console.warn(`[${tag}] Sequenz-Stopp fehlgeschlagen:`, seqErr.message)

  // Reine Medien (Platzhaltertext wie "[Sprachnachricht]") sind fuer den Verlauf
  // und den Nachfass-Stopp eine Antwort, aber kein Text fuer Abmeldung oder Bot.
  if (ev.mediaOnly) return { outcome: 'processed' }

  // Eingehende Abmeldung erkennen → Opt-Out anlegen (idempotent).
  // Der DB-Trigger storniert dann offene geplante Nachrichten.
  const stop = detectsStopIntent(text)
  if (stop) {
    const { data: existing } = await sb.from('communication_optouts').select('id').eq('lead_id', lead.id).limit(1)
    if (!existing || existing.length === 0) {
      await sb.from('communication_optouts').insert({
        lead_id:      lead.id,
        reason:       `Inbound-WhatsApp (Auto-Erkennung): ${text.slice(0, 200)}`,
        opted_out_at: new Date().toISOString(),
      })
    }
  }

  // Antwort auf die Newsletter-WhatsApp mit neuer Mailadresse → am Lead speichern
  // und Danke-WhatsApp (waMailUpdate.ts, greift nur in diesem engen Fall).
  if (!stop) await maybeUpdateEmailFromWa(sb, { lead_id: lead.id }, ev.phone, text, tag)

  // ── Termin-Bot: eingehende Antwort in ein laufendes Bot-Gespräch geben ──
  // Nur wenn KEINE Abmeldung (die schließt das Gespräch bereits) und ein aktives
  // Gespräch existiert. Läuft im Hintergrund (KI + WhatsApp dauert Sekunden), damit
  // der Webhook sofort 200 antwortet.
  if (!stop) {
    const { data: conv } = await sb
      .from('booking_conversations')
      .select('id')
      .eq('lead_id', lead.id)
      .not('state', 'in', '(booked,handoff,expired)')
      .gt('expires_at', new Date().toISOString())
      .limit(1)
    // Aktives Gespräch → normale Antwortverarbeitung (immer). Sonst → nur bei
    // plausiblem Termin-Bezug prüft der Bot, ob der Kunde einen (Remote-)Termin will
    // und klinkt sich ein (engage). Beides im Hintergrund.
    const hasConv = !!(conv && conv.length)
    // Sonst eine Sachfrage? Lotte antwortet nur, wenn die CRM-Fakten reichen (answer).
    await callBot(hasConv ? 'reply' : APPT_HINT.test(text) ? 'engage' : 'answer', lead.id, text, tag)
    // Infos zu einer Wohnung angefragt? Dann Paket im Postausgang vorbereiten
    // (anfrage-paket entscheidet selbst, im Hintergrund).
    await anfragePaketAnstossen(lead.id, text, 'whatsapp', tag)
  }

  return { outcome: 'processed' }
}
