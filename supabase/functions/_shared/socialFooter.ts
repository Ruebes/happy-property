// Gemeinsamer „Folge uns"-Footer für alle Kundenmails. withSocialFooter hängt ihn
// an (bzw. fügt ihn vor </body> ein), FALLS die Mail nicht schon Social-Links
// enthält — verhindert Doppel bei Deck-/Newsletter-Mails. URLs = deckTypes SOCIALS.
const SOCIALS: { label: string; url: string }[] = [
  { label: 'YouTube',   url: 'https://www.youtube.com/@HappyPropertyCyprus' },
  { label: 'Instagram', url: 'https://www.instagram.com/happy_property_cyprus' },
  { label: 'Facebook',  url: 'https://www.facebook.com/profile.php?id=61573780546599' },
  { label: 'LinkedIn',  url: 'https://www.linkedin.com/in/sven-r%C3%BCprich/' },
]

export const SOCIAL_FOOTER_HTML = `<div style="margin-top:28px;padding-top:18px;border-top:1px solid #ececec;text-align:center;font-family:Arial,Helvetica,sans-serif;">
  <p style="font-size:13px;color:#6b7280;margin:0 0 10px;">Folge uns für Neues aus Zypern:</p>
  <p style="margin:0;font-size:13px;">${SOCIALS.map(s => `<a href="${s.url}" style="color:#ff795d;text-decoration:none;font-weight:600;margin:0 7px;">${s.label}</a>`).join('<span style="color:#d1d5db;">·</span>')}</p>
  <p style="font-size:11px;color:#9ca3af;margin:12px 0 0;">Happy Property Cyprus · Pallados 1, 8046 Paphos · <a href="https://happy-property.com" style="color:#9ca3af;text-decoration:none;">happy-property.com</a></p>
</div>`

export function withSocialFooter(html: string): string {
  if (/instagram\.com|folge uns|follow us/i.test(html)) return html   // schon vorhanden → kein Doppel
  if (html.includes('</body>')) return html.replace('</body>', `${SOCIAL_FOOTER_HTML}</body>`)
  return html + SOCIAL_FOOTER_HTML
}
