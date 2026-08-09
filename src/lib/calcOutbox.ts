import { supabase } from './supabase'

// ── Postausgang-Entwurf für Berechnungen ────────────────────────────────────
// Legt für frisch erstellte Berechnungen einen deck_outbox-Entwurf an — gleiche
// Mechanik wie bei Sales-Decks (Sven 9.8.26: „Berechnungen sollen wie Decks im
// Ausgangskorb liegen"). Der Body enthält die /rechnung/<token>-Links; der
// WhatsApp-Versand im Postausgang erkennt die Berechnungen genau an diesen
// Links im Body. deck_tokens bleibt leer (reiner Rechnungs-Eintrag).
export async function createCalcOutboxDraft(opts: {
  leadId: string
  firstName: string
  email?: string | null
  calcs: Array<{ token: string; title: string }>
}): Promise<void> {
  if (!opts.calcs.length) return
  let email = opts.email ?? null
  if (!email) {
    const { data } = await supabase.from('leads').select('email').eq('id', opts.leadId).maybeSingle()
    email = (data as { email?: string | null } | null)?.email ?? null
  }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const origin = window.location.origin
  const linksHtml = opts.calcs.map(c =>
    `<p style="margin:0 0 10px 0"><a href="${origin}/rechnung/${c.token}" style="color:#2f6b4f;font-weight:700;font-size:15px;text-decoration:none">📊 ${esc(c.title)} →</a></p>`
  ).join('')
  const multi = opts.calcs.length > 1
  const subject = multi
    ? 'Deine Rendite-Berechnungen'
    : `Deine Rendite-Berechnung - ${opts.calcs[0].title.replace(/^Rechnung\s+/i, '')}`
  const body = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:#2b2b2b;max-width:600px;margin:0 auto">`
    + `<p style="margin:0 0 16px">Hallo ${esc(opts.firstName)},</p>`
    + `<p style="margin:0 0 16px">wie besprochen habe ich dir ${multi ? 'die Berechnungen' : 'deine Berechnung'} fertig gemacht. Alle Zahlen kannst du hier in Ruhe online durchgehen:</p>`
    + linksHtml
    + `<p style="margin:16px 0 16px">Wenn du Fragen zu den Zahlen hast, melde dich einfach. Wir gehen das gern gemeinsam durch.</p>`
    + `<p style="margin:24px 0 4px">Ich freue mich von dir zu hören.</p>`
    + `<p style="margin:0">Liebe Grüße,<br><strong>Sven · Happy Property Cyprus</strong></p></div>`
  const { error } = await supabase.from('deck_outbox').insert({
    lead_id: opts.leadId, recipient_email: email, subject, body, deck_tokens: [], status: 'draft',
  })
  if (error) console.error('[calcOutbox] Postausgang-Entwurf anlegen:', error.message)
}
