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
  // Tokens, deren OFFENE Entwuerfe dieser neue Entwurf ersetzt. Beim Ergaenzen
  // einer Berechnung enthaelt der neue Entwurf ohnehin alle Links - ohne das
  // Aufraeumen lagen zwei Entwuerfe fuer denselben Kunden im Postausgang, einer
  // mit beiden Wohnungen und einer nur mit der ersten (Sven 18.8.).
  // GESENDETE Eintraege bleiben immer unangetastet.
  replacesTokens?: string[]
}): Promise<void> {
  if (!opts.calcs.length) return
  if (opts.replacesTokens?.length) {
    const { data: olds } = await supabase.from('deck_outbox')
      .select('id, body').eq('lead_id', opts.leadId).eq('status', 'draft')
    const stale = ((olds ?? []) as Array<{ id: string; body: string | null }>)
      .filter(o => opts.replacesTokens!.some(tk => (o.body ?? '').includes(`/rechnung/${tk}`)))
      .map(o => o.id)
    if (stale.length) {
      const { error } = await supabase.from('deck_outbox').delete().in('id', stale)
      if (error) console.warn('[calcOutbox] alten Entwurf ersetzen:', error.message)
    }
  }
  let email = opts.email ?? null
  if (!email) {
    const { data } = await supabase.from('leads').select('email').eq('id', opts.leadId).maybeSingle()
    email = (data as { email?: string | null } | null)?.email ?? null
  }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const origin = window.location.origin
  // Der Vergleich ist bei mehreren Objekten das Hauptelement der Mail (Sven 18.8.,
  // Muster aus der Tobias-Mail): erst die Gegenüberstellung als Kasten, darunter die
  // Einzelrechnungen. Vorher standen alle Links gleichwertig untereinander.
  const compare = opts.calcs.find(c => /vergleich/i.test(c.title))
  const singles = opts.calcs.filter(c => c !== compare)
  const linksHtml = singles.map(c =>
    `<p style="margin:0 0 10px 0"><a href="${origin}/rechnung/${c.token}" style="color:#2f6b4f;font-weight:700;font-size:15px;text-decoration:none">📊 ${esc(c.title)} →</a></p>`
  ).join('')
  const compareHtml = compare
    ? `<div style="margin:0 0 18px;padding:16px 18px;border-radius:12px;background:#f0f7f4;border:1px solid #d4e9df">`
      + `<div style="font-weight:700;margin:0 0 10px">📊 Dein Immobilienvergleich – alle Wohnungen direkt gegenübergestellt</div>`
      + `<a href="${origin}/rechnung/${compare.token}" style="display:inline-block;background:#2f6b4f;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:10px 18px;border-radius:8px">Immobilienvergleich ansehen →</a></div>`
    : ''
  const multi = opts.calcs.length > 1
  const subject = multi
    ? 'Deine Rendite-Berechnungen'
    : `Deine Rendite-Berechnung - ${opts.calcs[0].title.replace(/^Rechnung\s+/i, '')}`
  const body = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:#2b2b2b;max-width:600px;margin:0 auto">`
    + `<p style="margin:0 0 16px">Hallo ${esc(opts.firstName)},</p>`
    + `<p style="margin:0 0 16px">wie besprochen habe ich dir ${multi ? 'die Berechnungen' : 'deine Berechnung'} fertig gemacht. Alle Zahlen kannst du hier in Ruhe online durchgehen:</p>`
    + compareHtml
    + (compare && linksHtml ? `<p style="margin:0 0 10px;font-size:14px;color:#666">Und hier jede Wohnung einzeln:</p>` : '')
    + linksHtml
    + `<p style="margin:16px 0 16px">Wenn du Fragen zu den Zahlen hast, melde dich einfach. Wir gehen das gern gemeinsam durch.</p>`
    + `<p style="margin:24px 0 4px">Ich freue mich von dir zu hören.</p>`
    + `<p style="margin:0">Liebe Grüße,<br><strong>Sven · Happy Property Cyprus</strong></p></div>`
  const { error } = await supabase.from('deck_outbox').insert({
    lead_id: opts.leadId, recipient_email: email, subject, body, deck_tokens: [], status: 'draft',
  })
  if (error) console.error('[calcOutbox] Postausgang-Entwurf anlegen:', error.message)
}

// ── Postausgang-Entwurf für den Strategie-Plan ──────────────────────────────
// Analog zu den Berechnungen (Sven 15.8.26: „ich kann die Daten nicht so
// herrichten, dass sie an den Kunden verschickt werden können"). Der Body
// enthält den /strategie/<token>-Link; Mail- und WhatsApp-Versand laufen wie
// gewohnt über den Postausgang.
//
// Sven 5.9.26: der Fahrplan geht entweder als weiterer Link mit dem Deck raus
// oder separat, auf jeden Fall über den Postausgang. Deshalb zwei Regeln:
//   1. Liegt für denselben Kunden schon ein OFFENER Entwurf mit Deck- oder
//      Rechnungslinks, wird der Fahrplan dort angehängt statt eine zweite Mail
//      zu erzeugen. Zwei Mails für denselben Vorgang waren bei den Berechnungen
//      schon einmal das Problem (siehe replacesTokens oben).
//   2. Ein älterer OFFENER Fahrplan-Entwurf desselben Kunden wird ersetzt.
//      Gesendete Einträge bleiben immer unangetastet.
const strategyLinkHtml = (origin: string, token: string, title: string, esc: (s: string) => string) =>
  `<p style="margin:0 0 10px 0"><a href="${origin}/strategie/${token}" style="color:#2f6b4f;font-weight:700;font-size:15px;text-decoration:none">📈 ${esc(title)} →</a></p>`

export async function createStrategyOutboxDraft(opts: {
  leadId: string
  firstName: string
  email?: string | null
  token: string
  title: string
  unitCount: number
  /** false hängt den Fahrplan nie an einen bestehenden Entwurf an. */
  mergeIntoOpenDraft?: boolean
}): Promise<{ merged: boolean }> {
  const escFn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const origin0 = window.location.origin

  // Offene Entwürfe desselben Kunden ansehen: einen alten Fahrplan ersetzen,
  // oder den Link an einen bestehenden Deck-Entwurf anhängen.
  const { data: openRows } = await supabase.from('deck_outbox')
    .select('id, body, deck_tokens').eq('lead_id', opts.leadId).eq('status', 'draft')
    .order('created_at', { ascending: false })
  const drafts = (openRows ?? []) as Array<{ id: string; body: string | null; deck_tokens: string[] | null }>

  const stale = drafts.filter(d => /\/strategie\/[a-f0-9]+/.test(d.body ?? ''))
  if (stale.length) {
    const { error } = await supabase.from('deck_outbox').delete().in('id', stale.map(d => d.id))
    if (error) console.warn('[strategyOutbox] alten Entwurf ersetzen:', error.message)
  }

  if (opts.mergeIntoOpenDraft !== false) {
    const host = drafts.find(d =>
      !stale.includes(d) && ((d.deck_tokens ?? []).length > 0 || (d.body ?? '').includes('/rechnung/')))
    if (host) {
      const block = `<div style="margin:20px 0 8px 0;padding-top:14px;border-top:1px solid #e5e5e5">`
        + `<p style="margin:0 0 8px;font-size:14px;color:#666">Und der Fahrplan, der zeigt, wie alles zusammenspielt:</p>`
        + strategyLinkHtml(origin0, opts.token, opts.title, escFn) + `</div>`
      const body = host.body ?? ''
      const merged = body.includes('</body>') ? body.replace('</body>', `${block}</body>`) : body + block
      const { error } = await supabase.from('deck_outbox').update({ body: merged }).eq('id', host.id)
      if (!error) return { merged: true }
      console.warn('[strategyOutbox] Anhängen fehlgeschlagen, lege eigenen Entwurf an:', error.message)
    }
  }

  let email = opts.email ?? null
  if (!email) {
    const { data } = await supabase.from('leads').select('email').eq('id', opts.leadId).maybeSingle()
    email = (data as { email?: string | null } | null)?.email ?? null
  }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const origin = window.location.origin
  const subject = 'Dein persönlicher Investitions-Fahrplan'
  const body = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:#2b2b2b;max-width:600px;margin:0 auto">`
    + `<p style="margin:0 0 16px">Hallo ${esc(opts.firstName)},</p>`
    + `<p style="margin:0 0 16px">wie besprochen habe ich deine Strategie einmal komplett durchgerechnet - ${opts.unitCount === 1 ? 'die Wohnung' : `alle ${opts.unitCount} Wohnungen`} auf einer Zeitachse, mit Finanzierung, Mieteinnahmen, Steuern und dem Vermögensaufbau Jahr für Jahr:</p>`
    + `<p style="margin:0 0 10px 0"><a href="${origin}/strategie/${opts.token}" style="color:#2f6b4f;font-weight:700;font-size:15px;text-decoration:none">📈 ${esc(opts.title)} →</a></p>`
    + `<p style="margin:16px 0 16px">Die Einzelrechnungen zu den Wohnungen findest du wie gewohnt in den Berechnungen, die ich dir geschickt habe. Der Fahrplan zeigt, wie alles zusammenspielt.</p>`
    + `<p style="margin:24px 0 4px">Melde dich einfach, wenn du etwas anders durchrechnen möchtest.</p>`
    + `<p style="margin:0">Liebe Grüße,<br><strong>Sven · Happy Property Cyprus</strong></p></div>`
  const { error } = await supabase.from('deck_outbox').insert({
    lead_id: opts.leadId, recipient_email: email, subject, body, deck_tokens: [], status: 'draft',
  })
  if (error) console.error('[strategyOutbox] Postausgang-Entwurf anlegen:', error.message)
  return { merged: false }
}
