// Supabase Edge Function: compose-deck-mail
// Schreibt aus Kunden-Briefing + ECHTEN Projekt-Fakten die persönliche Begleit-Mail
// (Claude) im Happy-Property-CI — pro Objekt eine eigene POSITIONIERUNG (Kicker +
// 2-4 Sätze: stärkstes Argument, Zahlungsplan falls vorhanden, für-wen, Lage), eine
// Cashflow/IRR-Zusage und ein Abschluss, der das Kundenprofil aufgreift. Liefert
// subject + fertiges, E-Mail-sicheres HTML (Playfair/Montserrat, Creme/Navy/Coral).
// Es wird NICHTS gesendet — Entwurf landet im Postausgang.
//
// Body: { recipient_name, first_name?, briefing?, angle?,
//   items: [{ label, link, image?, project?, unit?, bedrooms?, size_sqm?, terrace_sqm?, floor?,
//             price?, facts?, available_count?, total_count? }] }
// Antwort: { subject, html }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CALENDLY = 'https://calendly.com/sven-happy-property/30min'
// Marke / Kontakt (= deckTypes DECK_LOGO/DECK_PHOTO/DECK_CONTACT)
const LOGO  = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
const PHOTO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg'
// Foto ist nicht quadratisch (5672×3781) → server-seitig quadratisch zuschneiden,
// sonst quetscht width=height=56 das Bild. Supabase-Transform resize=cover (2x für Retina).
const PHOTO_SQ = PHOTO.replace('/object/public/', '/render/image/public/') + '?width=112&height=112&resize=cover&quality=80'
const C = { cream: '#fffcf6', navy: '#1a2332', coral: '#ff795d', ink: '#2a2a2a', line: '#e6dfd0', mute: '#999' }
// Social-Footer im Deck-Stil (dunkler Block, Gold-Akzent) — = Deck.tsx DARK/GOLD.
const DARK = '#1b1b22', GOLD = '#C2A15E'
const SOCIALS = [
  { icon: '▶',  platform: 'YouTube',   handle: 'HappyPropertyCyprus',  url: 'https://www.youtube.com/@HappyPropertyCyprus' },
  { icon: '◎',  platform: 'Instagram', handle: 'happy_property_cyprus', url: 'https://www.instagram.com/happy_property_cyprus' },
  { icon: 'f',  platform: 'Facebook',  handle: 'Immobilien in Zypern',  url: '' },
  { icon: 'in', platform: 'LinkedIn',  handle: 'Sven Rüprich',          url: '' },
]
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SYSTEM = `Du bist Sven von Happy Property Cyprus — Brokerage für deutschsprachige Kapitalanleger, die auf Zypern (Paphos) investieren. Du schreibst die persönliche Begleit-Mail zu individuell zusammengestellten Sales-Decks (je ein Objekt pro Deck-Link).

ZIEL: Der Kunde soll die Objekte VERGLEICHEN können. Positioniere die Objekte bewusst UNTERSCHIEDLICH und in RELATION zueinander — wie ein guter Makler, der die Auswahl kuratiert hat. Beispiel-Logik bei drei Objekten: das exklusivste/kapitalintensivste, die solide Brot-und-Butter-Anlage, der Mittelweg dazwischen. Bei zwei: z.B. das stärkere Renditeobjekt vs. das sichere Einstiegsobjekt.

TONFALL: locker und herzlich, per DU, wie an einen Menschen, mit dem du schon gesprochen hast. Kompetent, klar, selbstbewusst — NIEMALS Straßenslang, keine Floskeln, kein Werbe-Geschrei. Kurze, konkrete Sätze.

PRO OBJEKT lieferst du:
- kicker: eine sehr kurze Einordnung in 2-4 Wörtern (z.B. „Das exklusivste der drei", „Solide Kapitalanlage", „Der Mittelweg", „Stärkste Rendite", „Sicherer Einstieg").
- text: 2-4 Sätze, die dieses Objekt positionieren. Nutze die STÄRKSTEN echten Argumente aus den Fakten (Lage/Strandnähe/Marina/Amenities/Bauträger), nenne — WENN in den Fakten vorhanden — den Zahlungsplan in einem Halbsatz, und ordne ein, FÜR WEN es passt (Kapitalbedarf, Finanzierung, Strategie). Hebe 1-2 Schlüsselbegriffe mit <b>...</b> hervor.

Außerdem:
- headline: kurze Überschrift, z.B. „Deine drei Paphos-Optionen." (Zahl an die Objektanzahl anpassen).
- greeting: „Hallo <Vorname>," (locker, per DU; NICHT „Liebe/Lieber").
- intro: das persönliche ANSCHREIBEN in 3-4 kurzen Sätzen, GENAU in dieser Reihenfolge, jeder Satz als eigener Absatz (echter Zeilenumbruch zwischen den Sätzen):
  1) Dank fürs Gespräch — z.B. „vielen Dank für das sympathische Gespräch."
  2) „Du möchtest …" — fasse in EINEM Satz die WÜNSCHE/SITUATION DES KUNDEN aus dem Briefing zusammen (z.B. verfügbares Eigenkapital, was er sucht, wie er es nutzen will, Strategie). NUR das Kundenprofil — NIEMALS objekt-spezifische Verkaufsnotizen aus dem Briefing und KEINE Gewinn-/Rendite-/Wertsteigerungs-Versprechen (z.B. „20-30% Gewinn") in den Intro übernehmen.
  3) „Ich habe dir ein paar Objekte herausgesucht und hoffe, dass das ein oder andere deinen Vorstellungen entspricht."
  4) „Gib mir bitte zeitnah Feedback, da der Markt hier sehr dynamisch ist und ich dir eine Immobilie nicht reservieren kann."
  Schreibe diese Sätze natürlich aus (nicht als Liste), aber halte Reihenfolge und Inhalt ein.
- closing: GENAU ein Satz, eine freundliche Feedback-Einladung — „Ich freue mich von dir zu hören." (NICHT das Kundenprofil wiederholen, KEINE Decks-Aufforderung mehr).

HARTE REGELN (Wahrheit vor Verkauf — das ist NICHT verhandelbar):
- Nutze NUR Fakten, die WÖRTLICH in den Objekt-Fakten stehen. Erfinde KEINE Zahlen/Preise/Renditen/Entfernungen/Garantien.
- Werte Begriffe NICHT auf und KOMBINIERE keine zwei Fakten zu einer stärkeren Aussage. Beispiele für VERBOTENES: aus '5 Jahre Garantie' wird NICHT 'Mietgarantie' oder 'Rendite-Garantie'; aus 'Hotelkonzept' wird NICHT 'garantierte Miete' oder 'gesicherte Auslastung'; aus 'nahe Marina' wird KEINE konkrete Wertsteigerungs-Prozentzahl. Steht 'Garantie' ohne Zusatz da, schreib genau 'Garantie' — NIE was es garantiert dazudichten.
- Ein Hotelkonzept ist eine Vermietungs-OPTION, KEINE Garantie auf Miete/Auslastung/Rendite. Formuliere es nie als Zusicherung — auch NICHT 'sorgt ab dem ersten Tag für Auslastung'/'immer vermietet'/'der Betreiber kümmert sich um die Vermietung'.
- ZAHLUNGSPLAN: Erfinde KEINE Aussage über das zeitliche Verhältnis der Zahlungen zum Bau. VERBOTEN: 'du zahlst erst nach Fertigstellung', 'erst wenn gebaut wurde', 'Großteil/Löwenanteil bei oder nach Übergabe', 'du finanzierst keinen Baufortschritt', 'nicht auf Kredit des Bauträgers', 'schützt deine Liquidität', 'Planungssicherheit'. Zypern-Neubau wird baufortschritts-begleitend und front-lastig gezahlt — solche Schutz-Narrative sind faktisch falsch. Zahlungsplan nur sachlich/neutral erwähnen, wenn überhaupt.
- Zahlen aus dem Briefing (z.B. Eigenkapital des Kunden) gehören NICHT als Objekt-Fakt in den Text.
- BRIEFING ≠ OBJEKT-FAKT: Das Briefing beschreibt den KUNDEN, nie das Objekt. Erwähnt es ein Konzept/Feature/eine Garantie (z.B. 'Hotelkonzept interessiert', 'will Mietgarantie'), behaupte das NICHT als Objekt-Merkmal — es sei denn, es steht GENAU so in den Objekt-Fakten. Kundeninteresse höchstens als Wunsch spiegeln, nie als Tatsache des Objekts.
- KEINE erfundene Verknappung ('nur noch wenige', 'eine der letzten') ohne konkrete Verfügbarkeitszahl in den Fakten. KEINE erfundenen Markt-/Nachfrage-/Wertsteigerungs-/Lage-Aussagen, die nicht wörtlich belegt sind.
- Im Zweifel WEGLASSEN. Eine schwächere, wahre Aussage ist besser als eine starke erfundene.
- In ALLEN Texten NIEMALS doppelte Anführungszeichen — nutze 'einfache' oder keine. Außer den <b>-Tags KEINE weiteren HTML-Tags.
- deck_lines MUSS exakt so viele Einträge haben wie Objekte im Input (gleiche Reihenfolge).`

interface MailItem {
  label?: string; link?: string; calc_link?: string; image?: string; project?: string; unit?: string
  bedrooms?: number | null; size_sqm?: number | null; terrace_sqm?: number | null
  floor?: number | null; price?: string; facts?: string
  available_count?: number | null; total_count?: number | null
}
interface Compare { link?: string; label?: string }
type Mail = { subject?: string; headline?: string; greeting?: string; intro?: string; deck_lines?: Array<{ kicker?: string; text?: string }>; closing?: string }

function itemBrief(it: MailItem, i: number): string {
  const label = it.label || [it.project, it.unit].filter(Boolean).join(' · ') || `Objekt ${i + 1}`
  const specs: string[] = []
  if (it.bedrooms != null) specs.push(`${it.bedrooms} Schlafzimmer`)
  if (it.size_sqm != null) specs.push(`${it.size_sqm} m² Wohnfläche`)
  if (it.terrace_sqm) specs.push(`${it.terrace_sqm} m² Terrasse`)
  if (it.floor != null) specs.push(`${it.floor}. Etage`)
  if (it.price) specs.push(`Preis ${it.price}`)
  const avail = (it.available_count != null && it.total_count != null && it.total_count > 0)
    ? `\nVERFÜGBARKEIT: von ${it.total_count} Einheiten aktuell ${it.available_count} frei.` : ''
  const facts = it.facts?.trim() ? `\nPROJEKT-FAKTEN (nur diese verwenden):\n${it.facts.trim()}` : ''
  return `OBJEKT ${i + 1}: ${label}\nEckdaten: ${specs.join(', ') || '–'}.${avail}${facts}`
}

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// erlaubt nur <b>…</b> im KI-Text, alles andere wird neutralisiert
const richText = (s: string) => esc(s).replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
const SANS = `'Montserrat', Arial, Helvetica, sans-serif`
const SERIF = `'Playfair Display', Georgia, 'Times New Roman', serif`

// Branded, E-Mail-sicheres HTML im CI bauen (Tabellen-Layout, wie Svens Vorlage).
function buildHtml(m: Mail, items: MailItem[], firstName = '', compare?: Compare): string {
  const lines = m.deck_lines ?? []
  const props = items.map((it, i) => {
    const label = it.label || [it.project, it.unit].filter(Boolean).join(' · ') || `Objekt ${i + 1}`
    const dl = lines[i] || {}
    const btnLabel = `${it.project || 'Objekt'} Deck ansehen →`
    // Render-Bilder sind riesig (bis 6 MB / 3240px / hochkant) → würden in Apple Mail
    // 1000-2350px hoch und blähen die Mail auf. Server-seitig auf feste 560×300
    // (cover-crop) zuschneiden + EXPLIZITE width/height → kompakt + Client kennt die Maße.
    const imgSrc = it.image && it.image.includes('/storage/v1/object/public/')
      ? it.image.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + '?width=560&height=300&resize=cover&quality=72'
      : it.image
    const img = it.image
      ? `<tr><td style="padding:0 40px;"><a href="${esc(it.link || '#')}" target="_blank"><img src="${esc(imgSrc)}" width="520" height="279" alt="${esc(label)}" style="width:100%;max-width:520px;height:auto;display:block;border-radius:8px;"></a></td></tr>`
      : ''
    return `<tr><td style="padding:36px 0 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${img}
        <tr><td style="padding:24px 40px 0 40px;">
          ${dl.kicker ? `<div style="font-family:${SANS};font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${C.coral};font-weight:700;">${esc(dl.kicker)}</div>` : ''}
          <h2 style="margin:6px 0 0 0;font-family:${SERIF};font-size:26px;line-height:1.2;font-weight:700;color:${C.navy};">${esc(label)}</h2>
          ${dl.text ? `<p style="margin:14px 0 0 0;font-family:${SANS};font-size:14px;line-height:1.65;color:${C.ink};">${richText(dl.text)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:22px 40px 0 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="${C.navy}" style="border-radius:2px;">
              <a href="${esc(it.link || '#')}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:12px;letter-spacing:0.15em;text-transform:uppercase;font-weight:700;color:#ffffff;text-decoration:none;white-space:nowrap;">${esc(btnLabel)}</a>
            </td>
            ${it.calc_link ? `<td style="width:10px;font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="border:1px solid ${C.navy};border-radius:2px;">
              <a href="${esc(it.calc_link)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:${C.navy};text-decoration:none;white-space:nowrap;">Berechnung ansehen</a>
            </td>` : ''}
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:40px 40px 0 40px;"><div style="height:1px;background-color:${C.line};"></div></td></tr>`
  }).join('')

  // Sätze in Absätze trennen — toleriert echte Zeilenumbrüche UND literales '\n'
  // (das Modell liefert manchmal die zwei Zeichen Backslash-n statt eines Umbruchs).
  const splitLines = (s: string) => s.replace(/\\n/g, '\n').split(/\n+/).map(x => x.trim()).filter(Boolean)
  // Bulletproof: KEINE <p>-Margins, KEINE Extra-Tabellenzeilen (beides bläht in
  // Outlook die Abstände auf). Anschreiben/Abschluss je als EIN Text-Block, Sätze
  // mit <br><br> getrennt — das rendert in JEDEM Client identisch.
  const introHtml = (m.intro ? splitLines(m.intro) : []).map(esc).join('<br><br>')
  const closingHtml = (m.closing ? splitLines(m.closing) : ['Ich freue mich von dir zu hören.']).map(esc).join('<br><br>')

  // Social-Kachel im Deck-Stil: Gold-Kreis (Icon) + Plattform (gold) + Handle (weiß), dunkle Karte.
  const socialCard = (s: typeof SOCIALS[number]) => {
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#2a2a33;border-radius:10px;"><tr>
      <td width="52" valign="middle" style="padding:11px 0 11px 12px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;background-color:${GOLD};border-radius:17px;font-family:${SANS};font-size:14px;font-weight:700;color:${DARK};">${s.icon}</td></tr></table></td>
      <td valign="middle" style="padding:11px 12px 11px 10px;"><div style="font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${GOLD};">${s.platform}</div><div style="font-family:${SANS};font-size:13px;color:#ffffff;">${esc(s.handle)}</div></td>
    </tr></table>`
    return s.url ? `<a href="${esc(s.url)}" target="_blank" style="text-decoration:none;">${inner}</a>` : inner
  }
  const socialRow = (a: typeof SOCIALS[number], b: typeof SOCIALS[number]) =>
    `<tr><td width="50%" valign="top" style="padding:0 5px 10px 0;">${socialCard(a)}</td><td width="50%" valign="top" style="padding:0 0 10px 5px;">${socialCard(b)}</td></tr>`
  const socialBlock = `
  <tr><td style="padding:36px 0 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${DARK};"><tr><td style="padding:32px 36px;">
      <div style="font-family:${SERIF};font-size:23px;font-weight:700;line-height:1.2;color:#ffffff;">Folge mir — ich nehme dich mit nach Zypern.</div>
      <div style="font-family:${SANS};font-size:13px;color:#9a9aa3;margin-top:6px;">Projekte, Baufortschritt, Markt-Insights — schau rein und folge:</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
        ${socialRow(SOCIALS[0], SOCIALS[1])}
        ${socialRow(SOCIALS[2], SOCIALS[3])}
      </table>
      <div style="font-family:${SANS};font-size:10px;color:#6b6b74;margin-top:22px;">Sveru Ltd. &nbsp;·&nbsp; Pallados 1, 8046 Paphos, Zypern</div>
    </td></tr></table>
  </td></tr>`
  // Gesamt-Vergleich (alle Objekte gegenübergestellt) — eigener Block unter den Karten.
  const compareBlock = compare?.link ? `
  <tr><td style="padding:32px 40px 0 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f7f4;border:1px solid #d4e9df;border-radius:6px;"><tr><td style="padding:20px 24px;">
      <div style="font-family:${SANS};font-size:14px;font-weight:700;color:${C.navy};margin-bottom:12px;">📊 ${esc(compare.label || 'Dein Immobilienvergleich — alle Wohnungen direkt gegenübergestellt')}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#2f6b4f" style="border-radius:2px;">
        <a href="${esc(compare.link)}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${SANS};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:#ffffff;text-decoration:none;white-space:nowrap;">Immobilienvergleich ansehen →</a>
      </td></tr></table>
    </td></tr></table>
  </td></tr>` : ''

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Montserrat:wght@400;500;600;700&display=swap');body{margin:0;padding:0;background:${C.cream};}table{border-collapse:collapse;}img{display:block;border:0;}a{text-decoration:none;}p{margin:0;}@media only screen and (max-width:620px){.container{width:100%!important;max-width:100%!important;}}</style></head>
<body style="margin:0;padding:0;background-color:${C.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.cream};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${C.cream};">
  <tr><td style="padding:8px 40px 28px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" valign="middle"><img src="${LOGO}" width="120" height="37" alt="Happy Property Cyprus" style="display:block;width:120px;height:37px;"></td>
      <td align="right" valign="middle" style="font-family:${SANS};font-size:11px;color:${C.mute};letter-spacing:0.12em;text-transform:uppercase;">Paphos · Zypern</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0 40px;"><div style="height:2px;width:48px;background-color:${C.coral};"></div></td></tr>
  <tr><td style="padding:24px 40px 8px 40px;"><h1 style="margin:0;font-family:${SERIF};font-size:30px;line-height:1.15;font-weight:700;color:${C.navy};">${esc(m.headline || 'Deine Paphos-Auswahl.')}</h1></td></tr>
  <tr><td style="padding:18px 40px 0 40px;font-family:${SANS};font-size:15px;line-height:1.7;color:${C.ink};">${esc(m.greeting || `Hallo ${firstName || ''},`.trim())}<br><br>${introHtml}</td></tr>
  ${props}
  ${compareBlock}
  <tr><td style="padding:32px 40px 0 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-left:3px solid ${C.coral};"><tr><td style="padding:22px 26px;">
      <div style="font-family:${SANS};font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${C.coral};font-weight:700;white-space:nowrap;">Cashflow &amp; IRR</div>
      <p style="margin:8px 0 0 0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.ink};">Sobald du eine Vorentscheidung hast, rechne ich dir <b>Cashflow, IRR und Finanzierungsbedarf</b> für dein Wunsch-Objekt konkret durch. Du bekommst saubere Zahlen — keine Marketing-Folien.</p>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:28px 40px 0 40px;font-family:${SANS};font-size:14px;line-height:1.7;color:${C.ink};">${closingHtml}</td></tr>
  <tr><td style="padding:22px 40px 0 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.coral}" style="border-radius:2px;">
      <a href="${CALENDLY}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:#ffffff;text-decoration:none;white-space:nowrap;">📅 Neuen Termin buchen</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:24px 40px 0 40px;"><p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.ink};">Liebe Grüße</p></td></tr>
  <tr><td style="padding:14px 40px 0 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="64"><img src="${esc(PHOTO_SQ)}" width="56" height="56" alt="Sven" style="width:56px;height:56px;border-radius:50%;display:block;"></td>
      <td valign="middle" style="padding-left:14px;"><div style="font-family:${SERIF};font-size:18px;color:${C.navy};">Sven</div><div style="font-family:${SANS};font-size:12px;color:#888;margin-top:2px;">Happy Property Cyprus</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:18px 40px 0 40px;"><p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.ink};"><a href="mailto:sven@happy-property.com" style="color:${C.navy};text-decoration:none;">sven@happy-property.com</a><br>+357 95 09 64 09<br><a href="https://happy-property.com" target="_blank" style="color:#888;text-decoration:none;">happy-property.com</a></p></td></tr>
  ${socialBlock}
</table></td></tr></table></body></html>`
}

// Fallback (ohne KI): gleiche Vorlage, neutrale Positionierung aus den Eckdaten.
function fallback(firstName: string, items: MailItem[], compare?: Compare): { subject: string; html: string } {
  const DEF = ['Das Premium-Objekt', 'Solide Kapitalanlage', 'Der Mittelweg', 'Weitere Option']
  const m: Mail = {
    subject: items.length > 1 ? `Deine ${items.length} Paphos-Optionen · Sales Decks` : `Dein Paphos-Vorschlag · ${items[0]?.label ?? ''}`.trim(),
    headline: items.length > 1 ? `Deine ${items.length} Paphos-Optionen.` : 'Dein Paphos-Vorschlag.',
    greeting: `Hallo ${firstName || ''},`.trim(),
    intro: [
      'vielen Dank für das sympathische Gespräch.',
      'Ich habe dir ein paar Objekte herausgesucht und hoffe, dass das ein oder andere deinen Vorstellungen entspricht.',
      'Gib mir bitte zeitnah Feedback, da der Markt hier sehr dynamisch ist und ich dir eine Immobilie nicht reservieren kann.',
    ].join('\n'),
    deck_lines: items.map((it, i) => ({
      kicker: DEF[Math.min(i, DEF.length - 1)],
      text: [it.bedrooms != null ? `${it.bedrooms} Schlafzimmer` : '', it.size_sqm != null ? `${it.size_sqm} m²` : '', it.price ? `Preis ${it.price}` : ''].filter(Boolean).join(' · ') + '.',
    })),
    closing: 'Ich freue mich von dir zu hören.',
  }
  return { subject: m.subject!, html: buildHtml(m, items, firstName, compare) }
}

// FAKTENCHECK: zweite KI-Stufe, die jeden Objekt-Text gegen die echten Fakten prüft und
// unbelegte/aufgewertete Behauptungen entfernt (Garantien, Renditen, kombinierte Aussagen).
// Belt-and-suspenders für die Automatisierung — bei Fehler bleibt der Originaltext.
async function verifyClaims(lines: Array<{ kicker?: string; text?: string }>, items: MailItem[]): Promise<typeof lines> {
  if (!lines.length) return lines
  try {
    const blocks = items.map((it, i) => `OBJEKT ${i + 1} (${it.label || it.project || ''}):\nTEXT: ${lines[i]?.text ?? ''}\nFAKTEN:\n${(it.facts || '(keine Fakten — dann darf der Text KEINE konkreten Behauptungen enthalten)').slice(0, 2200)}`).join('\n\n---\n\n')
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 2000,
        system: `Du bist Compliance-Prüfer für Immobilien-Marketing. Du bekommst je Objekt einen Verkaufstext und die ECHTEN Fakten. Streiche oder entschärfe JEDE Behauptung im Text, die NICHT eindeutig aus den Fakten hervorgeht — besonders: Garantien (Miet-/Rendite-/Auslastungsgarantie), konkrete Zahlen/Prozente/Renditen, Zusicherungen, sowie aus zwei Fakten zusammengebaute stärkere Aussagen. 'Hotelkonzept' ist eine Vermietungs-Option, KEINE garantierte Miete oder Auslastung ('sorgt ab dem ersten Tag für Auslastung' RAUS). '5 Jahre Garantie' ohne Zusatz bleibt 'Garantie' (NIE zu 'Mietgarantie' machen). ZAHLUNGSPLAN-NARRATIVE über das Timing der Zahlungen RAUS, wenn nicht wörtlich belegt: 'du zahlst erst nach Fertigstellung', 'erst wenn gebaut wurde', 'Großteil bei/nach Übergabe', 'finanzierst keinen Baufortschritt', 'nicht auf Kredit des Bauträgers', 'schützt deine Liquidität', 'Planungssicherheit' — alle streichen (Zypern-Neubau zahlt baufortschritts-begleitend, nicht nachgelagert). Gib pro Objekt den bereinigten Text zurück — gleiche Anzahl und Reihenfolge, Stil und Länge möglichst erhalten, nur Unbelegtes raus oder abschwächen. <b>...</b> darf bleiben, sonst keine HTML-Tags, keine doppelten Anführungszeichen.`,
        tools: [{ name: 'emit_checked', description: 'Bereinigte Texte je Objekt (gleiche Reihenfolge).', input_schema: { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' } } }, required: ['texts'] } }],
        tool_choice: { type: 'tool', name: 'emit_checked' },
        messages: [{ role: 'user', content: blocks }],
      }),
    })
    if (!res.ok) return lines
    const data = await res.json() as { content?: Array<{ type?: string; input?: { texts?: unknown } }> }
    const texts = (data.content ?? []).find(c => c.type === 'tool_use')?.input?.texts
    if (!Array.isArray(texts)) return lines
    return lines.map((l, i) => ({ ...l, text: (typeof texts[i] === 'string' && (texts[i] as string).trim()) ? texts[i] as string : l.text }))
  } catch { return lines }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const body = await req.json() as { recipient_name?: string; first_name?: string; briefing?: string; angle?: string; items?: MailItem[]; calc_link?: string; calc_label?: string }
    const items = (body.items ?? []).filter(it => it && it.link)
    const compare: Compare = { link: body.calc_link, label: body.calc_label }
    if (!items.length) return json({ error: 'items fehlt' }, 400)
    const firstName = body.first_name?.trim() || (body.recipient_name?.trim().split(' ')[0] ?? '')
    if (!ANTHROPIC_API_KEY) return json(fallback(firstName, items, compare))

    // GELERNTE VORGABEN aus Svens Mail-Korrekturen (deck_ai_rules kind='mail').
    let learnedBlock = ''
    try {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: rules } = await supabase.from('deck_ai_rules').select('rule').eq('kind', 'mail').eq('active', true).is('project_id', null)
      const txt = (rules ?? []).map((r: { rule: string }) => `- ${r.rule}`).join('\n')
      if (txt) learnedBlock = `GELERNTE VORGABEN (aus Svens früheren Korrekturen — IMMER beachten):\n${txt}\n\n`
    } catch { /* optional */ }

    const angle = body.angle === 'investment' ? 'investment' : 'lifestyle'
    const userMsg = learnedBlock + [
      `KUNDE: ${body.recipient_name?.trim() || firstName || 'der Kunde'}`,
      `WINKEL: ${angle}`,
      ``,
      `KUNDEN-BRIEFING (Svens Notizen — Grundlage für Anrede, Positionierung, Abschluss):`,
      body.briefing?.trim() || '(kein Briefing — halte es allgemein, aber persönlich)',
      ``,
      `DIESE OBJEKTE (gleiche Reihenfolge wie deck_lines):`, ``,
      ...items.map((it, i) => itemBrief(it, i)),
    ].join('\n')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 3000, system: SYSTEM,
        tools: [{
          name: 'emit_mail', description: 'Gibt die Begleit-Mail in Bausteinen zurück.',
          input_schema: { type: 'object', properties: {
            subject: { type: 'string' }, headline: { type: 'string' }, greeting: { type: 'string' }, intro: { type: 'string' },
            deck_lines: { type: 'array', items: { type: 'object', properties: { kicker: { type: 'string' }, text: { type: 'string' } }, required: ['kicker', 'text'] } },
            closing: { type: 'string' },
          }, required: ['subject', 'greeting', 'intro', 'deck_lines', 'closing'] },
        }],
        tool_choice: { type: 'tool', name: 'emit_mail' },
        messages: [{ role: 'user', content: userMsg }],
      }),
    })
    if (!res.ok) return json(fallback(firstName, items, compare))
    const data = await res.json() as { content?: Array<{ type?: string; input?: Mail }> }
    const m = (data.content ?? []).find(c => c.type === 'tool_use')?.input
    if (!m || !m.subject) return json(fallback(firstName, items, compare))
    // Faktencheck: unbelegte Behauptungen (z.B. erfundene 'Mietgarantie') rausfiltern.
    if (m.deck_lines) m.deck_lines = await verifyClaims(m.deck_lines, items)
    return json({ subject: m.subject, html: buildHtml(m, items, firstName, compare) })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
