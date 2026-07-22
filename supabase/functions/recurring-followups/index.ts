// Supabase Edge Function: recurring-followups
// Nächtlich aufgerufen. Zwei wiederkehrende Strecken:
//  1) HOLD-Reaktivierung: alle 6 Wochen Mail + WhatsApp an den Kunden, solange der Deal
//     in phase='hold' steht, hold_contact=true ist und KEIN communication_optouts-Eintrag
//     existiert (Opt-Out aus Antwort greift automatisch). last_hold_msg_at trackt den Takt.
//  2) KONTAKT-ÜBERGEBEN-Nachfrage: alle 5 Wochen WhatsApp an Burkhard, solange der Deal in
//     phase='kontakt_uebergeben' steht. last_handover_ping_at trackt den Takt.
//
// Body: { dry_run?: boolean }
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'
import { translateOutbound } from '../_shared/translate.ts'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const HOLD_EMAIL_ID = '99862a76-e7f0-4498-b04b-4230bbcbf5fe'
const BURKHARD_ID   = '6c9da3ce-9826-4660-9a50-6ff9fc8e70b4'
const SIX_WEEKS  = 42 * 24 * 3600 * 1000
const FIVE_WEEKS = 35 * 24 * 3600 * 1000

const subst = (s: string, v: Record<string, string>): string =>
  Object.entries(v).reduce((acc, [k, val]) => acc.split(`{{${k}}}`).join(val || '–'), s).replace(/\{\{[^}]+\}\}/g, '–')
const textToHtml = (s: string) => `<div style="font-family:Arial,sans-serif;font-size:15px;color:#374151;white-space:pre-wrap">${s.replace(/</g, '&lt;')}</div>`

async function callFn(fn: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST', headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const { dry_run } = await req.json().catch(() => ({})) as { dry_run?: boolean }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
    const now = Date.now()
    let holdSent = 0, pingSent = 0

    // ── 1) HOLD-Reaktivierung (alle 6 Wochen, an Kunden) ──────────────────────────
    const { data: holds } = await supabase.from('deals')
      .select('id, lead_id, last_hold_msg_at').eq('phase', 'hold').eq('hold_contact', true)
    const { data: holdMail } = await supabase.from('email_templates').select('subject, body, html_body').eq('id', HOLD_EMAIL_ID).maybeSingle()
    const { data: holdWa } = await supabase.from('whatsapp_templates').select('message_template').eq('event_type', 'hold_reengagement').eq('active', true).maybeSingle()

    for (const d of (holds ?? []) as Array<{ id: string; lead_id: string; last_hold_msg_at: string | null }>) {
      if (d.last_hold_msg_at && now - Date.parse(d.last_hold_msg_at) < SIX_WEEKS) continue
      const { data: oo } = await supabase.from('communication_optouts').select('id').eq('lead_id', d.lead_id).maybeSingle()
      if (oo) continue   // Kunde will nicht mehr kontaktiert werden
      const { data: lead } = await supabase.from('leads').select('first_name, last_name, email, phone, whatsapp, language').eq('id', d.lead_id).maybeSingle()
      const l = lead as { first_name?: string; last_name?: string; email?: string; phone?: string; whatsapp?: string; language?: string } | null
      if (!l) continue
      const vars = { vorname: l.first_name ?? '', name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(), email: l.email ?? '' }
      if (dry_run) { holdSent++; continue }
      const mt = holdMail as { subject?: string; body?: string; html_body?: string | null } | null
      const wt = holdWa as { message_template?: string } | null
      const phone = l.whatsapp || l.phone
      // EN-Kunde bekommt Reaktivierung auf Englisch: gerenderten Text EINMAL übersetzen.
      const lang = (l.language ?? 'de')
      const tr = await translateOutbound({
        subject: mt ? subst(mt.subject ?? '', vars) : null,
        body:    mt ? (mt.html_body ? subst(mt.html_body, vars) : textToHtml(subst(mt.body ?? '', vars))) : null,
        whatsapp: wt ? subst(wt.message_template ?? '', vars) : null,
      }, lang)
      if (mt && l.email) {
        await callFn('send-email', { to: l.email, subject: tr.subject ?? '', html: tr.body ?? '', lead_id: d.lead_id, lang })
      }
      if (wt && phone && tr.whatsapp) {
        // Geht automatisch an einen Kunden (Deal in 'hold') → Lotte als Absenderin.
        await callFn('send-whatsapp', { event_type: 'hold_reengagement', override_text: tr.whatsapp, lead_id: d.lead_id, lead_data: { lead_name: vars.name, lead_phone: phone }, persona_image: lotteBild() })
      }
      await supabase.from('deals').update({ last_hold_msg_at: new Date(now).toISOString() }).eq('id', d.id)
      holdSent++
    }

    // ── 2) KONTAKT-ÜBERGEBEN-Nachfrage (alle 5 Wochen, an Burkhard) ───────────────
    const { data: bk } = await supabase.from('crm_business_contacts').select('whatsapp, phone').eq('id', BURKHARD_ID).maybeSingle()
    const bkPhone = (bk as { whatsapp?: string; phone?: string } | null)?.whatsapp || (bk as { whatsapp?: string; phone?: string } | null)?.phone
    if (bkPhone) {
      const { data: handovers } = await supabase.from('deals')
        .select('id, lead_id, handover_at, last_handover_ping_at').eq('phase', 'kontakt_uebergeben')
      for (const d of (handovers ?? []) as Array<{ id: string; lead_id: string; handover_at: string | null; last_handover_ping_at: string | null }>) {
        if (d.last_handover_ping_at && now - Date.parse(d.last_handover_ping_at) < FIVE_WEEKS) continue
        const { data: lead } = await supabase.from('leads').select('first_name, last_name').eq('id', d.lead_id).maybeSingle()
        const l = lead as { first_name?: string; last_name?: string } | null
        const ln = `${l?.first_name ?? ''} ${l?.last_name ?? ''}`.trim()
        const dateStr = d.handover_at ? new Date(d.handover_at).toLocaleDateString('de-DE') : ''
        const msg = `Hallo Burkhard, am ${dateStr} habe ich dir ${ln} uebergeben. Gib mir bitte mal den aktuellen Stand bei dem Kunden durch.`
        if (dry_run) { pingSent++; continue }
        await callFn('send-whatsapp', { event_type: 'handover_status', override_text: msg, lead_id: d.lead_id, lead_data: { lead_name: 'Burkhard', lead_phone: bkPhone } })
        await supabase.from('deals').update({ last_handover_ping_at: new Date(now).toISOString() }).eq('id', d.id)
        pingSent++
      }
    }

    return json({ ok: true, holdSent, pingSent, dry_run: !!dry_run })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
