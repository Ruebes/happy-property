// Edge Function: schedule-message
// Wird aufgerufen wenn ein CRM-Ereignis eintritt (Lead erstellt, Phase wechselt).
// Liest aktive Automationsregeln für den event_type, prüft Opt-Out,
// rendert Templates mit Lead-/Deal-/Unit-/Termin-Daten und schreibt scheduled_messages.
//
// Unterstützt: Vor-Termin-Timing (timing_type=before_appointment), Termin-Bedingung
// (appointment_condition, beim Senden erneut geprüft), Drive-Trigger (drive_trigger).
//
// Aufruf: supabase.functions.invoke('schedule-message', { body: { lead_id, deal_id?, event_type } })

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const eur = (n: number | null | undefined): string =>
  n != null ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n) : ''

// Platzhalter ersetzen; unbekannte/leere → '–'
function substitute(template: string, data: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(data)) {
    result = result.split(`{{${key}}}`).join(value || '–')
    result = result.split(`{{${key.replace('lead_', '')}}}`).join(value || '–')
  }
  return result.replace(/\{\{[^}]+\}\}/g, '–')
}

// Finanzierung-DE-Dokumente → langlebige Signed-URLs (Bucket privat, 10 Jahre gültig)
async function finDocs(supabase: ReturnType<typeof createClient>): Promise<{ doc_vollmacht: string; doc_unterlagen: string }> {
  try {
    const { data: files } = await supabase.storage.from('workflow-documents').list('finanzierung_de', { limit: 100 })
    const sign = async (re: RegExp): Promise<string> => {
      const f = (files ?? []).find((x: { name: string }) => re.test(x.name))
      if (!f) return ''
      const { data } = await supabase.storage.from('workflow-documents').createSignedUrl(`finanzierung_de/${f.name}`, 315360000)
      return data?.signedUrl ?? ''
    }
    return { doc_vollmacht: await sign(/vollmacht/i), doc_unterlagen: await sign(/kapitalbeschaffung/i) }
  } catch { return { doc_vollmacht: '', doc_unterlagen: '' } }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })

  try {
    // only_timing='before_appointment': nur Vor-Termin-Regeln (neu) planen — für die
    // Erinnerungs-Neuplanung nach Terminverschiebung, OHNE die Bestätigung erneut zu senden.
    const { lead_id, deal_id, event_type, probe_docs, only_timing } = await req.json() as { lead_id?: string; deal_id?: string | null; event_type?: string; probe_docs?: boolean; only_timing?: string }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
    if (probe_docs) return new Response(JSON.stringify(await finDocs(supabase)), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    if (!lead_id || !event_type) {
      return new Response(JSON.stringify({ error: 'lead_id und event_type sind Pflichtfelder' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // 1. Opt-Out
    const { data: optOut } = await supabase.from('communication_optouts').select('id').eq('lead_id', lead_id).maybeSingle()
    if (optOut) {
      return new Response(JSON.stringify({ ok: true, skipped: 'opted_out', scheduled: 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Termin gebucht → offene Termin-Bot-Gespräche schließen (egal über welchen Weg
    // gebucht wurde: Funnel, Kalender, manuelle Phase). Sonst blockiert das verwaiste
    // Gespräch spätere Bot-Auslöser (z.B. das Deck-Ansicht-Follow-up in track-engagement).
    if (event_type === 'termin_gebucht') {
      try {
        const { error: convErr } = await supabase.from('booking_conversations')
          .update({ state: 'booked', last_message: 'Termin gebucht — Gespräch automatisch geschlossen.' })
          .eq('lead_id', lead_id)
          .not('state', 'in', '(booked,handoff,expired)')
        if (convErr) console.warn('[schedule-message] booking_conversations schließen fehlgeschlagen:', convErr.message)
      } catch (e) {
        console.warn('[schedule-message] booking_conversations schließen fehlgeschlagen:', e)
      }
    }

    // 2. Aktive Regeln
    let rulesQuery = supabase.from('automation_rules').select('*').eq('event_type', event_type).eq('is_active', true)
    if (only_timing) rulesQuery = rulesQuery.eq('timing_type', only_timing)
    const { data: rules, error: rulesErr } = await rulesQuery
    if (rulesErr) throw rulesErr
    // Bot-Auslöser (no_show/erstkontakt/immobilienauswahl) planen ihre WhatsApps
    // unten selbst — auch OHNE aktive Regeln nicht früh aussteigen.
    const isBotTrigger = event_type === 'no_show' || event_type === 'erstkontakt' || event_type === 'immobilienauswahl'
    if ((!rules || rules.length === 0) && !isBotTrigger) {
      return new Response(JSON.stringify({ ok: true, scheduled: 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // 3. Lead
    const { data: lead, error: leadErr } = await supabase
      .from('leads').select('id, first_name, last_name, email, phone, whatsapp, language, notes, drive_folder_url').eq('id', lead_id).single()
    if (leadErr || !lead) throw new Error(`Lead ${lead_id} nicht gefunden: ${leadErr?.message}`)

    // Deal (+ verknüpfte Unit für objekt/unit/kaufpreis)
    let dealData: { developer: string | null; commission_amount: number | null; unit_id: string | null; registration_notes: string | null; finanzierung_de_notes: string | null } | null = null
    if (deal_id) {
      const { data } = await supabase.from('deals').select('developer, commission_amount, unit_id, registration_notes, finanzierung_de_notes').eq('id', deal_id).maybeSingle()
      dealData = data as typeof dealData
    }
    let unitNumber = '', objektName = '', kaufpreis = '', unitDevEmail = '', unitDevPhone = ''
    if (dealData?.unit_id) {
      const { data: unit } = await supabase.from('crm_project_units')
        .select('unit_number, price_net, price_gross, project_id, crm_projects(name, developer)').eq('id', dealData.unit_id).maybeSingle()
      const u = unit as { unit_number?: string; price_net?: number; price_gross?: number; crm_projects?: { name?: string; developer?: string } } | null
      if (u) {
        unitNumber = u.unit_number ?? ''
        objektName = u.crm_projects?.name ?? ''
        kaufpreis  = eur(u.price_gross ?? u.price_net)
        // Developer-Kontakt der gewählten Unit (für dynamischen Empfänger 'unit_developer')
        const devName = u.crm_projects?.developer ?? ''
        if (devName) {
          const { data: dev } = await supabase.from('crm_developers').select('id').ilike('name', devName).maybeSingle()
          const devId = (dev as { id?: string } | null)?.id
          if (devId) {
            const { data: c } = await supabase.from('crm_developer_contacts')
              .select('email, phone, whatsapp').eq('developer_id', devId).order('is_primary', { ascending: false }).limit(1).maybeSingle()
            const cc = c as { email?: string; phone?: string; whatsapp?: string } | null
            unitDevEmail = cc?.email ?? ''
            unitDevPhone = (cc?.whatsapp || cc?.phone) ?? ''
          }
        }
      }
    }

    // P4: Finanzierung-DE-Dokumente (langlebige Signed-URLs) nur für diese Stage
    const { doc_vollmacht: docVollmacht, doc_unterlagen: docUnterlagen } =
      event_type === 'finanzierung_de' ? await finDocs(supabase) : { doc_vollmacht: '', doc_unterlagen: '' }

    // Registrierung: Developer + Bemerkung stehen evtl. nur in der Phasenwechsel-Aktivität,
    // falls das Frontend deal.developer noch nicht gesetzt hat (robust gegen alten PWA-Cache).
    let regDevelopers = dealData?.developer ?? ''
    let regNotes = dealData?.registration_notes ?? ''
    // Finanzierung-DE: deal-spezifische Bemerkung zum Kunden (aus dem Pipeline-Popup) → geht an Christof
    const finNotes = (dealData?.finanzierung_de_notes ?? '').trim()
    if (event_type === 'registrierung' && (!regDevelopers || !regNotes)) {
      let aq = supabase.from('activities').select('content').eq('type', 'note').ilike('content', '%Registrierung gesendet an:%')
      aq = deal_id ? aq.eq('deal_id', deal_id) : aq.eq('lead_id', lead_id)
      const { data: act } = await aq.order('created_at', { ascending: false }).limit(1).maybeSingle()
      const c = (act as { content?: string } | null)?.content ?? ''
      if (!regDevelopers) { const m = c.match(/Registrierung gesendet an:\s*([^.]+)/i); if (m) regDevelopers = m[1].trim() }
      if (!regNotes)      { const m = c.match(/Bemerkung:\s*([\s\S]+)$/i);          if (m) regNotes = m[1].trim() }
    }

    // Termine: nächster (zukünftig) für Timing/Bedingung, sonst letzter für zoom_link
    const nowIso = new Date().toISOString()
    // internal ausgeschlossen: sonst kann ein interner Termin, der zeitlich vor dem
    // echten Beratungstermin liegt, {{termin_datum}}/{{zoom_link}}/{{termin_link}} in
    // einer Kundennachricht ueberschreiben.
    const { data: nextAppt } = await supabase.from('crm_appointments')
      .select('start_time, zoom_link, manage_token').eq('lead_id', lead_id).eq('internal', false).gte('start_time', nowIso).order('start_time', { ascending: true }).limit(1).maybeSingle()
    const { data: lastAppt } = await supabase.from('crm_appointments')
      .select('zoom_link, start_time, manage_token').eq('lead_id', lead_id).eq('internal', false).order('start_time', { ascending: false }).limit(1).maybeSingle()
    const apptStart = (nextAppt as { start_time?: string } | null)?.start_time ?? null
    const zoomLink  = ((nextAppt as { zoom_link?: string } | null)?.zoom_link) || ((lastAppt as { zoom_link?: string } | null)?.zoom_link) || ''
    // Öffentlicher „Termin verwalten"-Link (verschieben/absagen ohne Login)
    const manageToken = ((nextAppt as { manage_token?: string } | null)?.manage_token) || ((lastAppt as { manage_token?: string } | null)?.manage_token) || ''
    const terminLink  = manageToken ? `https://portal.happy-property.com/termin/verwalten/${manageToken}` : ''

    // Termin für die Anzeige in DEUTSCHER Zeit (der Kunde sitzt in DE, nicht auf Zypern).
    // Tag + volles Datum + Uhrzeit + Zeitzonen-Kürzel (MEZ/MESZ). Fällt auf den letzten
    // Termin zurück (apptStart ist nur der ZUKÜNFTIGE — für before_appointment-Timing).
    const apptDisplayStart = apptStart ?? (lastAppt as { start_time?: string } | null)?.start_time ?? null
    const terminDatum = apptDisplayStart ? (() => {
      const d = new Date(apptDisplayStart), TZ = 'Europe/Berlin'
      const day  = new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: TZ }).format(d)
      const date = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d)
      const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(d)
      const tz   = new Intl.DateTimeFormat('de-DE', { timeZoneName: 'short', hour: '2-digit', timeZone: TZ })
        .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || 'MEZ'
      return `${day}, ${date} um ${time} Uhr (${tz})`
    })() : ''

    const basePlaceholders: Record<string, string> = {
      lead_name:    `${lead.first_name} ${lead.last_name}`.trim(),
      lead_phone:   lead.phone ?? '',
      lead_email:   lead.email ?? '',
      lead_whatsapp: lead.whatsapp ?? '',
      vorname:      lead.first_name,
      nachname:     lead.last_name,
      email:        lead.email,
      phone:        lead.phone ?? '',
      developers:   regDevelopers,
      developer:    regDevelopers,
      bemerkung:    regNotes,
      bemerkungen:  regNotes,
      finanzierung_bemerkung: finNotes,   // nur für die Partner-Mail (Christof), nie an den Kunden
      commission_amount: eur(dealData?.commission_amount),
      // NEU (A):
      notiz:        lead.notes ?? '',
      zoom_link:    zoomLink,
      termin_datum: terminDatum,   // Tag + Datum + Uhrzeit in deutscher Zeit (MEZ/MESZ)
      termin:       terminDatum,   // Alias
      termin_link:  terminLink,    // öffentlicher Verwalten-Link (verschieben/absagen)
      objekt:       objektName,
      projekt:      objektName,
      unit:         unitNumber,
      wohnung:      unitNumber,
      kaufpreis:    kaufpreis,
      preis:        kaufpreis,
      drive_link:   lead.drive_folder_url ?? '',
      doc_vollmacht:  docVollmacht,
      doc_unterlagen: docUnterlagen,
    }

    // Empfänger-Tokens → E-Mails (für Drive-Schreibzugriff)
    const resolveEmails = async (tokens: string[] | null): Promise<string[]> => {
      const out: string[] = []
      for (const tk of tokens ?? []) {
        if (!tk) continue
        if (tk === 'client') { if (lead.email) out.push(lead.email) }
        else if (tk === 'unit_developer') { if (unitDevEmail) out.push(unitDevEmail) }
        else if (tk.startsWith('bc:') || tk.startsWith('dc:')) {
          const table = tk.startsWith('bc:') ? 'crm_business_contacts' : 'crm_developer_contacts'
          const { data } = await supabase.from(table).select('email').eq('id', tk.slice(3)).maybeSingle()
          const e = (data as { email?: string } | null)?.email; if (e) out.push(e)
        } else if (tk.includes('@')) out.push(tk)
      }
      return out
    }

    let scheduled = 0, skipped = 0
    for (const rule of rules as Array<{
      id: string; message_type: string; delay_minutes: number; email_template_id: string | null
      whatsapp_event_type: string | null; recipient: string | null
      appointment_condition: string | null; timing_type: string | null; drive_trigger: boolean | null; drive_share: string[] | null
    }>) {
      // C) Timing
      let scheduledAt: Date
      if (rule.timing_type === 'before_appointment') {
        if (!apptStart) { skipped++; continue }   // kein Termin → vor-Termin-Nachricht nicht planbar
        scheduledAt = new Date(new Date(apptStart).getTime() - rule.delay_minutes * 60 * 1000)
        // Termin zu nah (Erinnerungszeitpunkt schon vorbei / in <30 Min): NICHT nachträglich
        // senden — der Kunde hat gerade erst die Bestätigung bekommen, das wäre Spam.
        if (scheduledAt.getTime() < Date.now() + 30 * 60 * 1000) { skipped++; continue }
      } else {
        scheduledAt = new Date(Date.now() + rule.delay_minutes * 60 * 1000)
      }

      // F) Drive-Trigger: Kundenordner sicherstellen + teilen, drive_link für DIESE Regel füllen
      const ph = { ...basePlaceholders }
      if (rule.drive_trigger) {
        try {
          const extra = await resolveEmails(rule.drive_share)
          const dr = await fetch(`${SUPABASE_URL}/functions/v1/create-client-drive-folder`, {
            method: 'POST', headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead_id, extra_emails: extra }),
          }).then(r => r.json()).catch(() => null) as { folder_url?: string } | null
          if (dr?.folder_url) ph.drive_link = dr.folder_url
        } catch { /* Drive-Trigger fehlgeschlagen → drive_link bleibt wie gehabt */ }
      }

      let emailSubject: string | null = null, emailBody: string | null = null, waText: string | null = null, waImage: string | null = null
      if ((rule.message_type === 'email' || rule.message_type === 'both') && rule.email_template_id) {
        const { data: tpl } = await supabase.from('email_templates').select('subject, body, html_body').eq('id', rule.email_template_id).maybeSingle()
        if (tpl) {
          emailSubject = substitute(tpl.subject, ph)
          // HTML-Vorlage bevorzugen (gestylt); nur Plain-body → in pre-wrap-HTML kapseln,
          // damit Zeilenumbrüche erhalten bleiben (sonst geht der Text als Roh-HTML mit
          // verschluckten Umbrüchen raus — gleiche Falle wie der Portalzugang-Bug).
          emailBody = tpl.html_body
            ? substitute(tpl.html_body, ph)
            : `<div style="font-family:Arial,sans-serif;font-size:15px;color:#374151;white-space:pre-wrap">${substitute(tpl.body ?? '', ph).replace(/</g, '&lt;')}</div>`
        }
      }
      if ((rule.message_type === 'whatsapp' || rule.message_type === 'both') && rule.whatsapp_event_type) {
        const { data: tpl } = await supabase.from('whatsapp_templates').select('message_template, image_url').eq('event_type', rule.whatsapp_event_type).eq('active', true).single()
        if (tpl) {
          waText = substitute(tpl.message_template as string, ph)
          // Bild der Vorlage mitnehmen — es muss den Weg durch die Warteschlange
          // ueberstehen, genau wie der Text.
          waImage = (tpl as { image_url?: string | null }).image_url ?? null
        }
      }
      // Finanzierung DE: Bemerkung zum Kunden an die PARTNER-Mail (Christof) anhängen —
      // auch ohne {{...}}-Platzhalter. NICHT an die Kunden-Mail (recipient 'client'),
      // sonst gingen interne Notizen an den Kunden.
      if (event_type === 'finanzierung_de' && finNotes && rule.recipient !== 'client') {
        if (emailBody && !emailBody.includes(finNotes)) {
          emailBody += `<div style="font-family:Arial,sans-serif;font-size:15px;color:#374151;margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;white-space:pre-wrap"><strong>Bemerkung zum Kunden:</strong><br>${finNotes.replace(/</g, '&lt;')}</div>`
        }
        if (waText && !waText.includes(finNotes)) waText += `\n\nBemerkung zum Kunden:\n${finNotes}`
      }
      const hasEmail = !!(emailSubject && emailBody), hasWa = !!waText
      if (!hasEmail && !hasWa) { skipped++; continue }
      const effectiveType = hasEmail && hasWa ? 'both' : hasEmail ? 'email' : 'whatsapp'

      const { error: insertErr } = await supabase.from('scheduled_messages').insert({
        lead_id, deal_id: deal_id ?? null, type: effectiveType, event_type, status: 'pending',
        scheduled_at: scheduledAt.toISOString(), email_subject: emailSubject, email_body: emailBody, whatsapp_text: waText,
        whatsapp_image_url: waImage,
        rule_id: rule.id, recipient: rule.recipient ?? 'client',
        appointment_condition: rule.appointment_condition ?? 'none',
      })
      if (insertErr) console.error(`[schedule-message] Insert Fehler Regel ${rule.id}:`, insertErr.message)
      else scheduled++
    }

    // Sofort-Versand anstoßen: fällige (delay-0) Nachrichten gehen in Sekunden raus,
    // statt bis zu 5 Min auf den Cron zu warten. Verzögerte bleiben liegen (Cron).
    if (scheduled > 0) {
      const trigger = fetch(`${SUPABASE_URL}/functions/v1/process-scheduled-messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => {})
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      if (er?.waitUntil) er.waitUntil(trigger); else await trigger
    }
    // ── Termin-Bot-Auslöser ──
    // No-Show/Erstkontakt: Stage-0-Start +20 Min (Kunde soll erst selbst buchen), handleStart
    // plant bei No-Show die 5 Nudges. Immobilienauswahl: 6 Nudges (24h/3/5/10/14/30 Tage),
    // jede Sendezeit ins 9–20-Uhr-Fenster (Berlin) geklemmt. process-scheduled-messages ruft
    // dann booking-bot; der Bot prüft Opt-Out/Termin/aktives Gespräch selbst.
    if (event_type === 'no_show' || event_type === 'erstkontakt' || event_type === 'immobilienauswahl') {
      const { data: bot } = await supabase.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
      if ((bot as { value?: string } | null)?.value === 'true') {
        const TZ = 'Europe/Berlin'
        const berlinOffMin = (d: Date): number => {
          const m: Record<string, string> = {}
          for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d)) m[p.type] = p.value
          return (Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second) - d.getTime()) / 60000
        }
        // Sendezeit ins Fenster 9–20 Uhr (Berlin): ≥20 → 20:00 (vorgezogen), <9 → 9:00.
        const clampBiz = (d: Date): Date => {
          const m: Record<string, string> = {}
          for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(d)) m[p.type] = p.value
          const h = +m.hour === 24 ? 0 : +m.hour
          if (h >= 9 && h < 20) return d
          const guess = new Date(Date.UTC(+m.year, +m.month - 1, +m.day, h >= 20 ? 20 : 9, 0))
          return new Date(guess.getTime() - berlinOffMin(guess) * 60000)
        }
        if (event_type === 'immobilienauswahl') {
          const delaysMin = [1440, 4320, 7200, 14400, 20160, 43200]   // 1/3/5/10/14/30 Tage
          const rows = delaysMin.map((dm, i) => ({
            lead_id, deal_id: deal_id ?? null, type: 'whatsapp', event_type: 'bot_nudge',
            bot_nudge_stage: i, bot_nudge_source: 'immobilienauswahl', status: 'pending',
            scheduled_at: clampBiz(new Date(Date.now() + dm * 60000)).toISOString(),
          }))
          await supabase.from('scheduled_messages').insert(rows)
        } else {
          await supabase.from('scheduled_messages').insert({
            lead_id, deal_id: deal_id ?? null, type: 'whatsapp', event_type: 'bot_nudge',
            bot_nudge_stage: 0, bot_nudge_source: event_type, status: 'pending',
            scheduled_at: new Date(Date.now() + 20 * 60000).toISOString(),
          })
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, scheduled, skipped }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[schedule-message] Fehler:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
