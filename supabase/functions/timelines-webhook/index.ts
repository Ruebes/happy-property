import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
function detectsStopIntent(text: string): boolean {
  return STOP_PATTERNS.some((re) => re.test(text))
}

// Günstiger Vorfilter: könnte die Nachricht überhaupt um einen Termin gehen? Nur
// dann fragt der Bot die KI (spart KI-Aufrufe bei „danke"/„ok"/Produktfragen).
const APPT_HINT = /termin|telefon|anruf|\bruf|\bcall\b|zoom|video|sprechen|besprech|treffen|meeting|\bzeit\b|\bwann\b|uhrzeit|quatschen/i

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const payload = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── Dedupe: Timelines schickt DIESELBE Nachricht mehrfach (verschiedene
    // event_types wie message:new + message:received:new, dazu Retries). Jede
    // message_uid nur EINMAL verarbeiten — race-sicher über den UNIQUE-Primary-Key
    // (Insert-Konflikt = bereits gesehen → still bestätigen).
    const uid = payload.message?.message_uid ?? payload.message?.id
    if (uid) {
      const { error: dupErr } = await supabase.from('wa_processed').insert({ message_uid: String(uid) })
      if (dupErr) return new Response('OK (dupe)', { headers: corsHeaders })
    }

    // ── Richtung: Timelines nutzt message.direction ('received'|'sent'), NICHT fromMe.
    // AUSGEHENDE/eigene Nachrichten (auch das Echo unserer Bot-Nachrichten!) dürfen
    // NIE verarbeitet werden — sonst antwortet der Bot auf sich selbst (Endlosschleife).
    const acctPhone = payload.whatsapp_account?.phone
    const viaApi = payload.message?.origin === 'Public API'
    const isOutbound = payload.message?.direction === 'sent'
      || viaApi
      || (payload.message?.sender?.phone && acctPhone && payload.message.sender.phone === acctPhone)
    if (isOutbound) {
      // Sven tippt SELBST im Chat (nicht der Bot / nicht die CRM-API: origin 'Public API')
      // und fängt mit einem Termin an → der Bot übernimmt die Terminlogistik. Kunde = Chat-
      // Nummer (Empfänger). engage entscheidet remote vs. Vor-Ort (Vor-Ort macht Sven selbst).
      const outText = payload.message?.text ?? payload.message?.body
      const custPhone = payload.chat?.phone ?? payload.contact?.phone
      if (!viaApi && outText && custPhone && APPT_HINT.test(outText)) {
        const digits = String(custPhone).replace(/\D/g, '')
        if (digits.length >= 7) {
          try {
            const { data: rows } = await supabase.rpc('find_leads_by_phone_suffix', { suffix: digits.slice(-8) })
            const lead = ((rows ?? []) as { id: string }[])[0]
            if (lead) {
              const p = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-bot`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'engage', lead_id: lead.id, text: outText }),
              }).then(r => r.text()).catch(e => console.error('[timelines-webhook] engage (Sven-outbound):', e))
              const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
              if (er) er.waitUntil(p); else await p
            }
          } catch (e) { console.warn('[timelines-webhook] Sven-outbound engage:', e) }
        }
      }
      return new Response('OK (outbound)', { headers: corsHeaders })
    }

    // Ab hier: nur echte EINGEHENDE Kundennachrichten. Kunden-Nummer = Absender.
    const rawPhone = payload.message?.sender?.phone ?? payload.chat?.phone ?? payload.contact?.phone
    const text     = payload.message?.text ?? payload.message?.body ?? payload.text
    const fromMe   = false

    if (!rawPhone || !text) {
      return new Response('OK', { headers: corsHeaders })
    }

    // Lead robust über die Telefonnummer finden: NUR Ziffern vergleichen und per
    // Endung (letzte 8 Ziffern) matchen — unabhängig davon, ob Timelines mit/ohne
    // „+", Leerzeichen oder Länderformat schickt. Suffix ist reine Ziffern → keine
    // Filter-Injection. Bei mehreren Leads mit gleicher Nummer den neuesten nehmen.
    const digits = String(rawPhone).replace(/\D/g, '')

    // ── Aufgaben-Antwort ────────────────────────────────────────────────────
    // Gehört die Nummer zu einem/einer Zuständigen einer offenen Aufgabe, wird die
    // Nachricht als Bemerkung in die Aufgabe geschrieben (additiv, stört den Lead-/
    // Bot-Fluss nicht). Auf „erledigt" setzt man NUR über den Link.
    if (digits.length >= 7) {
      try {
        const { data: hit } = await supabase.rpc('find_task_by_assignee_phone', { suffix: digits.slice(-8) })
        const row = Array.isArray(hit) ? hit[0] : hit
        if (row?.task_id) {
          await supabase.from('crm_task_messages').insert({
            task_id: row.task_id, sender_id: null, sender_label: row.label ?? 'Extern',
            recipient_id: row.created_by, body: String(text).slice(0, 4000),
          })
          console.log(`[timelines-webhook] Task-Antwort → Bemerkung (task ${row.task_id})`)
        }
      } catch (e) { console.warn('[timelines-webhook] Task-Reply:', e) }
    }

    let lead: { id: string } | null = null
    if (digits.length >= 7) {
      const suffix = digits.slice(-8)
      // Normalisierter Match via RPC: vergleicht NUR die Ziffern der gespeicherten Nummer
      // (regexp_replace \D). Der alte ilike-Match scheiterte an Formatierung — z.B. bei
      // "+49 1515 8415620" ist die Endung "58415620" wegen des Leerzeichens KEIN Substring,
      // wodurch eingehende Antworten still verworfen wurden (Thomas' Terminbestätigung).
      const { data: rows, error: lErr } = await supabase
        .rpc('find_leads_by_phone_suffix', { suffix })
      if (lErr) {
        // DB-Fehler NICHT verschlucken — sonst ginge eine eingehende „STOPP"-Abmeldung
        // verloren (Function meldete 200, Provider würde nicht erneut zustellen).
        console.error('[timelines-webhook] Lead-Lookup Fehler:', lErr.message)
        return new Response(JSON.stringify({ error: lErr.message }), { status: 500, headers: corsHeaders })
      }
      const matches = (rows ?? []) as { id: string }[]
      // Mehrere Leads mit DERSELBEN Nummer (Dubletten): den mit einem AKTIVEN
      // Bot-Gespräch bevorzugen — sonst würde die Antwort am falschen Lead landen
      // (ohne Gespräch → Bot reagiert nicht). Sonst der neueste.
      if (matches.length > 1) {
        const { data: convs } = await supabase
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

    if (lead) {
      await supabase
        .from('activities')
        .insert({
          lead_id:              lead.id,
          type:                 'whatsapp',
          direction:            fromMe ? 'outbound' : 'inbound',
          subject:              fromMe ? 'WhatsApp gesendet' : 'WhatsApp erhalten',
          content:              text,
          completed_at:         new Date().toISOString(),
          whatsapp_message_id:  uid ? String(uid) : null,
        })

      // KI-Zusammenfassung löschen damit sie neu generiert wird
      await supabase
        .from('lead_ai_summaries')
        .delete()
        .eq('lead_id', lead.id)

      // Kunde hat GEANTWORTET → Nachfass-Sequenzen stoppen. Die Drips sind für
      // Nicht-Reagierer; wer im Dialog ist, darf nicht weiter automatisch
      // angeschrieben werden (Norbert-Fall: „Hatte ich Dir doch geschrieben!").
      // Newsletter & Termin-Nachrichten bleiben unberührt.
      if (!fromMe) {
        const { error: seqErr } = await supabase
          .from('scheduled_messages')
          .update({ status: 'cancelled', error_message: 'Kunde hat geantwortet — Nachfass-Sequenz gestoppt' })
          .eq('lead_id', lead.id).eq('status', 'pending')
          .in('event_type', ['erstkontakt', 'no_show', 'immobilienauswahl', 'deck_viewed_followup', 'bot_nudge'])
        if (seqErr) console.warn('[timelines-webhook] Sequenz-Stopp fehlgeschlagen:', seqErr.message)
      }

      // Eingehende Abmeldung erkennen → Opt-Out anlegen (idempotent).
      // Der DB-Trigger storniert dann offene geplante Nachrichten.
      if (!fromMe && detectsStopIntent(text)) {
        const { data: existing } = await supabase
          .from('communication_optouts')
          .select('id')
          .eq('lead_id', lead.id)
          .limit(1)

        if (!existing || existing.length === 0) {
          await supabase
            .from('communication_optouts')
            .insert({
              lead_id:      lead.id,
              reason:       `Inbound-WhatsApp (Auto-Erkennung): ${text.slice(0, 200)}`,
              opted_out_at: new Date().toISOString(),
            })
        }
      }

      // ── Termin-Bot: eingehende Antwort in ein laufendes Bot-Gespräch geben ──
      // Nur wenn KEINE Abmeldung (die schließt das Gespräch bereits) und ein aktives
      // Gespräch existiert. Läuft im Hintergrund (KI + WhatsApp dauert Sekunden), damit
      // der Webhook sofort 200 antwortet.
      if (!fromMe && !detectsStopIntent(text)) {
        const { data: conv } = await supabase
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
        if (hasConv || APPT_HINT.test(text)) {
          const botAction = hasConv ? 'reply' : 'engage'
          const p = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-bot`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ action: botAction, lead_id: lead.id, text }),
          }).then(r => r.text()).catch(e => console.error(`[timelines-webhook] booking-bot ${botAction} Fehler:`, e))
          const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
          if (er) er.waitUntil(p); else await p
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    console.error(error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: corsHeaders },
    )
  }
})
