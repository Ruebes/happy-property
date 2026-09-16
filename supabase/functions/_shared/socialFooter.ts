// Gemeinsamer Abschluss für alle Kundenmails: USP-Kasten „Warum Happy Property"
// + „Folge uns"-Footer. withSocialFooter hängt beides an (bzw. fügt es vor </body>
// ein). Der Footer entfällt, wenn die Mail schon Social-Links enthält (Deck-/
// Newsletter-Mails); der Kasten entfällt, wenn er schon drin ist (Marker hp-usp-box).
// Deck-Mails setzen den Kasten selbst an passender Stelle (compose-deck-mail).
// URLs = deckTypes SOCIALS.
const SOCIALS: { label: string; url: string }[] = [
  { label: 'YouTube',   url: 'https://www.youtube.com/@HappyPropertyCyprus' },
  { label: 'Instagram', url: 'https://www.instagram.com/happy_property_cyprus' },
  { label: 'Facebook',  url: 'https://www.facebook.com/profile.php?id=61573780546599' },
  { label: 'LinkedIn',  url: 'https://www.linkedin.com/in/sven-r%C3%BCprich/' },
]

// Ausführliche Seite zu den USPs (WordPress, neben der App-Seite).
export const WARUM_URL = 'https://steuervorteil-zypern-immobilien.com/warum-happy-property/'

const USP_DE: { k: string; t: string }[] = [
  { k: 'Geprüfte Bauträger.',        t: 'Eigenkapitalfinanziert, mit fertigen Referenzprojekten auf Zypern, deren Qualität wir kennen.' },
  { k: 'Lastenfreie Grundstücke.',   t: 'Keine Hypotheken auf dem Boden, alle Genehmigungen liegen vor.' },
  { k: 'Key ready.',                 t: 'Bezugsfertig übergeben, von den Möbeln bis zur Bettwäsche.' },
  { k: 'Lage für 12 Monate im Jahr.', t: 'Ganzjährig hohe Auslastung in der Kurzzeitvermietung, Langzeitvermietung jederzeit möglich.' },
  { k: 'Happy Property App.',        t: 'Zahlungsplan, Baufortschritt, Einnahmen und Verträge an einem Ort.' },
]
const USP_EN: { k: string; t: string }[] = [
  { k: 'Vetted developers.',         t: 'Equity-financed, with completed reference projects in Cyprus whose quality we know first-hand.' },
  { k: 'Unencumbered land.',         t: 'No mortgages on the plot, all permits already granted.' },
  { k: 'Key ready.',                 t: 'Handed over fully furnished, from the furniture down to the bed linen.' },
  { k: 'Locations that rent 12 months a year.', t: 'High short-term occupancy all year round, long-term letting possible at any time.' },
  { k: 'Happy Property App.',        t: 'Payment schedule, construction progress, income and contracts in one place.' },
]

// USP-Kasten (tabellenbasiert, Inline-Styles, Outlook-fest). Farben = CI
// (Creme/Navy/Korall). Erste-Person-Zitat ist Sven zugeordnet, damit es auch in
// Lotte-Mails stimmt.
export function uspBoxHtml(lang = 'de'): string {
  const en = lang === 'en'
  const items = en ? USP_EN : USP_DE
  const rows = items.map((u, i) => `<tr><td width="22" valign="top" style="padding:0 0 ${i === items.length - 1 ? 0 : 8}px;color:#ff795d;font-weight:bold;">✓</td><td style="padding:0 0 ${i === items.length - 1 ? 0 : 8}px;"><b style="color:#1a2332;">${u.k}</b> ${u.t}</td></tr>`).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="hp-usp-box" style="margin:24px 0 0;border-collapse:separate;">
  <tr><td style="background:#fffcf6;border:1px solid #e6dfd0;border-radius:10px;padding:22px 24px;font-family:Arial,Helvetica,sans-serif;">
    <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#ff795d;font-weight:bold;">${en ? 'Why Happy Property' : 'Warum Happy Property'}</p>
    <p style="margin:0 0 4px;font-size:18px;font-weight:bold;color:#1a2332;font-family:Georgia,'Times New Roman',serif;line-height:1.3;">${en ? '„I only offer properties I would invest in myself.“' : '„Ich biete nur Objekte an, in die ich selbst investieren würde.“'}</p>
    <p style="margin:0 0 14px;font-size:12px;color:#7d7d86;">Sven Rüprich, Happy Property Cyprus</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#2a2a2a;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">${rows}</table>
    <p style="margin:16px 0 0;font-size:13px;"><a href="${WARUM_URL}" style="color:#ff795d;font-weight:bold;text-decoration:none;">${en ? 'Why we select so strictly →' : 'Warum wir so streng auswählen →'}</a></p>
  </td></tr>
</table>`
}

// Sprachabhängiger Footer: nur die Intro-Zeile unterscheidet sich. So bekommt eine
// übersetzte EN-Mail nicht mehr den deutschen „Folge uns"-Absatz.
export function socialFooterHtml(lang = 'de'): string {
  const intro = lang === 'en' ? 'Follow us for news from Cyprus:' : 'Folge uns für Neues aus Zypern:'
  return `<div style="margin-top:28px;padding-top:18px;border-top:1px solid #ececec;text-align:center;font-family:Arial,Helvetica,sans-serif;">
  <p style="font-size:13px;color:#6b7280;margin:0 0 10px;">${intro}</p>
  <p style="margin:0;font-size:13px;">${SOCIALS.map(s => `<a href="${s.url}" style="color:#ff795d;text-decoration:none;font-weight:600;margin:0 7px;">${s.label}</a>`).join('<span style="color:#d1d5db;">·</span>')}</p>
  <p style="font-size:11px;color:#9ca3af;margin:12px 0 0;">Happy Property Cyprus · Pallados 1, 8046 Paphos · <a href="https://happy-property.com" style="color:#9ca3af;text-decoration:none;">happy-property.com</a></p>
</div>`
}

// Rückwärtskompatibel: der alte Export bleibt (deutsch).
export const SOCIAL_FOOTER_HTML = socialFooterHtml('de')

export function withSocialFooter(html: string, lang = 'de'): string {
  const hasSocials = /instagram\.com|folge uns|follow us/i.test(html)
  const hasUsp     = /hp-usp-box/.test(html)
  // Mails mit eigenem Social-Block (Deck/Newsletter) bleiben komplett unangetastet.
  if (hasSocials) return html
  const tail = (hasUsp ? '' : uspBoxHtml(lang)) + socialFooterHtml(lang)
  if (html.includes('</body>')) return html.replace('</body>', `${tail}</body>`)
  return html + tail
}
