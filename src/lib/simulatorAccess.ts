import { supabase } from './supabase'

// ── Simulator für den Kunden freischalten (Sven 23.10.26) ───────────────────
// „Simulator freischalten" im CRM gibt dem Kunden /simulator/:token. Den Link
// bekommt er per WhatsApp (Kurzlink, eine Zeile) und als HTML-Mail.

export const PORTAL = 'https://portal.happy-property.com'
export const simulatorUrl = (token: string) => `${PORTAL}/simulator/${token}`

const SHORT_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'

// Kurzlink portal.happy-property.com/s/<code> für ein Ziel. Gleiches Ziel =
// gleicher Code (wie in send-whatsapp). Liefert den Link ohne https://, damit er
// in WhatsApp sicher in eine Zeile passt; WhatsApp macht ihn trotzdem klickbar.
export async function shortLinkFor(target: string): Promise<{ code: string; short: string; full: string }> {
  const { data: found } = await supabase.from('short_links').select('code').eq('target', target).limit(1)
  let code = (found as Array<{ code: string }> | null)?.[0]?.code ?? null
  for (let i = 0; !code && i < 4; i++) {
    const c = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => SHORT_CHARS[b % SHORT_CHARS.length]).join('')
    const { error } = await supabase.from('short_links').insert({ code: c, target })
    if (!error) code = c
  }
  if (!code) throw new Error('Kurzlink konnte nicht angelegt werden')
  return { code, short: `portal.happy-property.com/s/${code}`, full: `${PORTAL}/s/${code}` }
}

type Lang = 'de' | 'en'
const L = (lang: string | null | undefined): Lang => (lang === 'en' ? 'en' : 'de')

export function simulatorWhatsappText(firstName: string, shortLink: string, lang?: string | null): string {
  const name = firstName.trim()
  if (L(lang) === 'en') {
    return `Hi ${name},\n\nI have unlocked your personal strategy simulator. You can try out yourself how equity, later top-ups, interest and the time of sale change your strategy:\n\n${shortLink}\n\nYour changes are saved, so we can go through your version together.\n\nBest regards\nSven`
  }
  return `Hallo ${name},\n\nich habe dir deinen persönlichen Strategie-Simulator freigeschaltet. Dort kannst du selbst durchspielen, wie sich Eigenkapital, spätere Einlagen, Zins und Verkaufszeitpunkt auf deine Strategie auswirken:\n\n${shortLink}\n\nDeine Änderungen werden gespeichert, so können wir deine Variante gemeinsam besprechen.\n\nViele Grüße\nSven`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// HTML-Mail im CI: Creme-Hintergrund, Navy-Schrift, Korall nur als Akzent (Knopf).
export function simulatorMail(firstName: string, link: string, lang?: string | null): { subject: string; html: string } {
  const en = L(lang) === 'en'
  const tx = en ? {
    subject: 'Your personal strategy simulator',
    hello: `Hi ${esc(firstName.trim())},`,
    intro: 'I have unlocked your personal strategy simulator. It runs on the same calculation as your investment plan, and you can change the key figures yourself:',
    points: ['Equity at the start and later top-ups', 'Interest, term and value growth', 'Time of sale and tax residence'],
    button: 'Open simulator',
    saved: 'Your changes are saved automatically, so we can go through your version together.',
    regards: 'Best regards',
    fallback: 'If the button does not work, copy this link into your browser:',
  } : {
    subject: 'Dein persönlicher Strategie-Simulator',
    hello: `Hallo ${esc(firstName.trim())},`,
    intro: 'ich habe dir deinen persönlichen Strategie-Simulator freigeschaltet. Er rechnet mit derselben Engine wie dein Investitions-Fahrplan, und du kannst die wichtigsten Stellschrauben selbst verändern:',
    points: ['Eigenkapital zum Start und spätere Einlagen', 'Zins, Laufzeit und Wertsteigerung', 'Verkaufszeitpunkt und Steuersitz'],
    button: 'Simulator öffnen',
    saved: 'Deine Änderungen werden automatisch gespeichert, so können wir deine Variante gemeinsam besprechen.',
    regards: 'Viele Grüße',
    fallback: 'Falls der Knopf nicht funktioniert, kopiere diesen Link in deinen Browser:',
  }
  const NAVY = '#1a2332', CORAL = '#ff795d', CREME = '#fffcf6'
  const SERIF = "'Playfair Display',Georgia,serif", SANS = "'Montserrat','Helvetica Neue',Arial,sans-serif"
  const html = `<!DOCTYPE html>
<html lang="${en ? 'en' : 'de'}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${tx.subject}</title></head>
<body style="margin:0;padding:0;background:${CREME};font-family:${SANS};color:${NAVY};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREME};padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #efe9df;">
<tr><td style="padding:28px 32px 8px;">
  <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${CORAL};font-weight:600;">Happy Property</p>
  <h1 style="margin:0;font-family:${SERIF};font-size:26px;line-height:1.25;color:${NAVY};font-weight:600;">${tx.subject}</h1>
</td></tr>
<tr><td style="padding:16px 32px 8px;font-size:15px;line-height:1.65;color:${NAVY};">
  <p style="margin:0 0 14px;">${tx.hello}</p>
  <p style="margin:0 0 12px;">${tx.intro}</p>
  <ul style="margin:0 0 20px;padding-left:20px;">${tx.points.map(p => `<li style="margin:0 0 4px;">${p}</li>`).join('')}</ul>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr><td style="background:${CORAL};border-radius:10px;">
    <a href="${esc(link)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${tx.button}</a>
  </td></tr></table>
  <p style="margin:0 0 18px;font-size:14px;color:#4a5563;">${tx.saved}</p>
  <p style="margin:0;">${tx.regards}<br>Sven Rüprich</p>
</td></tr>
<tr><td style="padding:18px 32px 26px;font-size:12px;line-height:1.6;color:#8a8f98;">
  ${tx.fallback}<br><a href="${esc(link)}" style="color:#8a8f98;">${esc(link)}</a>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`
  return { subject: tx.subject, html }
}
