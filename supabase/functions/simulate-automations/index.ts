// Supabase Edge Function: simulate-automations
// TROCKENLAUF: rendert für ALLE aktiven automation_rules die Nachricht (Mail +
// WhatsApp), die gesendet WÜRDE — mit Beispiel-/echten Lead-Daten. Es wird NICHTS
// versendet und NICHTS in scheduled_messages geschrieben. Liefert pro Regel eine
// Vorschau + Diagnose (Empfänger aufgelöst? Vorlage da? Telefon/Mail vorhanden?).
//
// Body: { lead_id?: string }  — optional ein echter Lead für realistische Daten.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

function substitute(template: string, data: Record<string, string>): string {
  let r = template || ''
  for (const [k, v] of Object.entries(data)) {
    r = r.split(`{{${k}}}`).join(v || '–')
    r = r.split(`{{${k.replace('lead_', '')}}}`).join(v || '–')
  }
  return r.replace(/\{\{[^}]+\}\}/g, '–')
}
const dlay = (m: number) => m === 0 ? 'sofort' : m < 60 ? `${m} Min` : m < 1440 ? `${m / 60} Std` : `${m / 1440} Tg`

type Contact = { first_name?: string; last_name?: string; company?: string; email?: string | null; phone?: string | null; whatsapp?: string | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const { lead_id } = await req.json().catch(() => ({})) as { lead_id?: string }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Lead-Daten: echter Lead falls übergeben, sonst Beispielkunde.
    let lead = { first_name: 'Beispiel', last_name: 'Kunde', email: 'kunde@beispiel.de', phone: '+49 170 1234567', whatsapp: '' as string | null, notes: '' }
    if (lead_id) {
      const { data } = await supabase.from('leads').select('first_name, last_name, email, phone, whatsapp, notes').eq('id', lead_id).maybeSingle()
      if (data) lead = data as typeof lead
    }
    const ph: Record<string, string> = {
      lead_name: `${lead.first_name} ${lead.last_name}`.trim(), vorname: lead.first_name, nachname: lead.last_name,
      lead_phone: lead.phone ?? '', phone: lead.phone ?? '', lead_email: lead.email ?? '', email: lead.email ?? '',
      lead_whatsapp: lead.whatsapp ?? '', notiz: lead.notes ?? '', bemerkung: '(Beispiel-Bemerkung)', bemerkungen: '(Beispiel-Bemerkung)',
      objekt: 'Mamba · A2', projekt: 'Mamba', unit: 'A2', wohnung: 'A2', kaufpreis: '688.800 €', preis: '688.800 €',
      developer: 'Mito', developers: 'Mito', zoom_link: 'https://zoom.us/j/000', drive_link: 'https://drive.google.com/…',
      commission_amount: '15.000 €', termin: 'Mo, 24.06. 14:00',
    }

    const [{ data: rules }, { data: emailTpls }, { data: waTpls }, { data: bcs }] = await Promise.all([
      supabase.from('automation_rules').select('*').eq('is_active', true).order('event_type').order('delay_minutes'),
      supabase.from('email_templates').select('id, subject, body, html_body'),
      supabase.from('whatsapp_templates').select('event_type, message_template, active'),
      supabase.from('crm_business_contacts').select('id, first_name, last_name, company, email, phone, whatsapp'),
    ])
    const emailById = new Map((emailTpls ?? []).map((t: { id: string }) => [t.id, t]))
    const waByEvent = new Map((waTpls ?? []).map((t: { event_type: string }) => [t.event_type, t]))
    const bcById = new Map((bcs ?? []).map((c: { id: string }) => [c.id, c as Contact & { id: string }]))

    const out = (rules ?? []).map((r: Record<string, unknown>) => {
      const mtype = r.message_type as string
      const recipient = (r.recipient as string) ?? 'client'
      // Empfänger auflösen (Telefon fällt auf phone zurück, wie im echten Versand)
      let rcptLabel = 'Kunde', rcptEmail: string | null = lead.email, rcptPhone: string | null = lead.whatsapp || lead.phone
      if (recipient.startsWith('bc:')) {
        const c = bcById.get(recipient.slice(3))
        rcptLabel = c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() + (c.company ? ` (${c.company})` : '') : 'Kontakt?'
        rcptEmail = c?.email ?? null; rcptPhone = (c?.whatsapp || c?.phone) ?? null
      } else if (recipient === 'unit_developer') { rcptLabel = 'Developer (zur Wohnung)'; rcptEmail = null; rcptPhone = null }

      const issues: string[] = []
      let subject: string | null = null, mailBody: string | null = null, waText: string | null = null
      if (mtype === 'email' || mtype === 'both') {
        const t = r.email_template_id ? emailById.get(r.email_template_id as string) as { subject?: string; body?: string } | undefined : undefined
        if (!t) issues.push('Mail-Vorlage fehlt')
        else { subject = substitute(t.subject ?? '', ph); mailBody = substitute(t.body ?? '', ph) }
        if (!rcptEmail) issues.push('kein E-Mail-Empfänger')
      }
      if (mtype === 'whatsapp' || mtype === 'both') {
        const t = r.whatsapp_event_type ? waByEvent.get(r.whatsapp_event_type as string) as { message_template?: string; active?: boolean } | undefined : undefined
        if (!t) issues.push(`WhatsApp-Vorlage fehlt (${r.whatsapp_event_type})`)
        else if (!t.active) issues.push('WhatsApp-Vorlage inaktiv')
        else waText = substitute(t.message_template ?? '', ph)
        if (!rcptPhone) issues.push('keine Telefonnummer')
      }
      return {
        id: r.id, name: r.name, event_type: r.event_type, message_type: mtype,
        timing: dlay(r.delay_minutes as number), recipient_label: rcptLabel,
        recipient_email: rcptEmail, recipient_phone: rcptPhone,
        subject, mail_body: mailBody, whatsapp_text: waText,
        ok: issues.length === 0, issues,
      }
    })

    return json({
      lead_used: `${lead.first_name} ${lead.last_name}`.trim(),
      total: out.length,
      ready: out.filter(o => o.ok).length,
      problems: out.filter(o => !o.ok).length,
      rules: out,
    })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
