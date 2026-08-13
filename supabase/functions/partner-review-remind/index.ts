// partner-review-remind — Lottes wöchentliche Rückfrage an die Partner.
// Für jeden aktiven partner_review_token: Anzahl der Leads seiner Phase zählen
// und die Bitte um Rückmeldung schicken — freundlich, von Lotte, mit Link zur
// Partner-Seite (/partner/<token>), wo je Lead der Stand angeklickt wird.
//
//   POST { channel: 'email' }              → Mail (Christof, Mo 10:00 DE)
//   POST { channel: 'whatsapp' }           → WhatsApp (Burkhard + Ioulia, Mo 8:00 CY)
//   POST { ..., test: true }               → ALLES nur an Sven (Mail an sven@…,
//                                            WhatsApp an +35795096409), mit [TEST]-Label.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy partner-review-remind --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const SITE = 'https://portal.happy-property.com'
const TEST_MAIL = 'sven@happy-property.com'
const TEST_PHONE = '+35795096409'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const body = await req.json().catch(() => ({})) as { channel?: string; test?: boolean }
    const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'email'
    const test = body.test === true

    const { data: toks } = await sb.from('partner_review_tokens')
      .select('token, phase, label, channel, contact:crm_business_contacts(first_name, last_name, email, phone, whatsapp)')
      .eq('active', true).eq('channel', channel)
    const tokens = (toks ?? []) as Array<{ token: string; phase: string; label: string | null; channel: string; contact: { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null } | null }>
    const results: Array<{ partner: string; leads: number; sent: boolean; error?: string }> = []

    for (const tk of tokens) {
      const first = (tk.contact?.first_name ?? 'Partner').trim()
      const { data: deals } = await sb.from('deals').select('lead_id').eq('phase', tk.phase)
      const n = new Set(((deals ?? []) as { lead_id: string | null }[]).map(d => d.lead_id).filter(Boolean)).size
      const link = `${SITE}/partner/${tk.token}`
      const label = tk.label ?? tk.phase
      const prefix = test ? '[TEST] ' : ''

      try {
        if (n === 0) { results.push({ partner: first, leads: 0, sent: false }); continue }
        if (channel === 'email') {
          const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
            <div style="text-align:center;margin-bottom:6px;">
              <img src="${lotteBild()}" alt="Lotte" width="80" height="80" style="width:80px;height:80px;border-radius:50%;object-fit:cover;" />
              <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · persönliche Assistentin von Sven 🐾</p>
            </div>
            <p>Hallo ${first},</p>
            <p>ich hoffe, du hattest ein schönes Wochenende! Kurze Rückfrage von meiner Seite: Bei uns liegen aktuell <b>${n} Kontakte</b> in <b>„${label}"</b> — wir würden gern wissen, wie dort jeweils der Bearbeitungsstand ist.</p>
            <p>Ein Klick pro Kontakt genügt (In Bearbeitung / Nicht qualifiziert / Noch nicht erreicht), alles landet direkt in unserem System:</p>
            <p style="text-align:center;margin:24px 0;">
              <a href="${link}" style="background:#ff795d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block;">Bearbeitungsstand melden →</a>
            </p>
            <p>Vielen Dank dir — und einen guten Start in die Woche! 🐾</p>
            <p style="font-size:13px;color:#6b7280;">Liebe Grüße<br/>Lotte</p>
          </div>`
          const to = test ? TEST_MAIL : (tk.contact?.email ?? '')
          if (!to) throw new Error('keine E-Mail am Kontakt')
          const { error } = await sb.functions.invoke('send-email', { body: {
            to, subject: `${prefix}Kurze Rückfrage: Bearbeitungsstand deiner ${n} Kontakte (${label})`,
            html, from_name: 'Lotte · Assistentin von Sven', auto: true,
          } })
          if (error) throw new Error(error.message)
        } else {
          // Kein "[TEST]" mit eckigen Klammern — send-whatsapp blockt [..]-Muster
          // als "nicht ersetzten Platzhalter".
          const text = `${test ? 'TEST · ' : ''}Hallo ${first} 🐾\n\nhier ist Lotte, die persönliche Assistentin von Sven. Ich hoffe, du hattest ein schönes Wochenende!\n\nKurze Rückfrage: Bei uns liegen aktuell *${n} Kontakte* in „${label}" — magst du uns kurz den Bearbeitungsstand je Kontakt durchgeben? Ein Klick pro Kontakt genügt:\n\n${link}\n\nVielen Dank dir und einen guten Start in die Woche!\nLiebe Grüße, Lotte`
          const phone = test ? TEST_PHONE : (tk.contact?.whatsapp || tk.contact?.phone || '')
          if (!phone) throw new Error('keine Nummer am Kontakt')
          const { data: wa, error } = await sb.functions.invoke('send-whatsapp', { body: {
            event_type: 'partner_review', override_text: text,
            lead_data: { lead_name: first, lead_phone: phone },
            persona_image: lotteBild(), allow_duplicate: true,
          } })
          const w = wa as { success?: boolean; error?: string } | null
          if (error || w?.error || w?.success === false) throw new Error(w?.error ?? error?.message ?? 'send-whatsapp fehlgeschlagen')
        }
        results.push({ partner: first, leads: n, sent: true })
      } catch (e) {
        results.push({ partner: first, leads: n, sent: false, error: (e as Error).message })
        console.error(`[partner-review-remind] ${first}:`, e)
      }
    }
    return json({ ok: true, test, channel, results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[partner-review-remind]', msg)
    return json({ error: msg }, 500)
  }
})
