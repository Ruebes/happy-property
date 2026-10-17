// Persönliche Rechnung zum Eigenkapital (Plan-B-Seite „Guide + Rechnung“, seit 17.10.2026).
// Grundlage ist die Beispielrechnung aus dem Fact-Sheet unserer Steuerkanzlei (300.000 €
// inkl. MwSt, 70 % finanziert zu 4,1 %, 5 % Miete langfristig, 5 % degressive AfA auf den
// Gebäudeanteil 252.100 €, 42 % Grenzsteuersatz bei 80.000 € Gehalt). Alle Werte werden
// linear auf den Kaufpreis skaliert, der zum Eigenkapital passt (30 % + ca. 1 % Anwalt).

export const EK_BETRAG: Record<string, number> = {
  '50-100k': 75000, '100-200k': 150000, '200-500k': 300000, 'ueber-500k': 500000,
}
const EK_TEXT: Record<string, string> = {
  'unter-50k': 'unter 50.000 €', '50-100k': '50.000 bis 100.000 €', '100-200k': '100.000 bis 200.000 €',
  '200-500k': '200.000 bis 500.000 €', 'ueber-500k': 'über 500.000 €',
}

const eur = (n: number) => `${Math.round(n).toLocaleString('de-DE')} €`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

export interface Rechnung { preis: number; eigenkapital: number; finanzierung: number; miete: number; zinsen: number; afa: number; verlust: number; steuer: number; mieteMinusZins: number }

export function rechne(ekSpanne: string): Rechnung | null {
  const ek = EK_BETRAG[ekSpanne]
  if (!ek) return null
  const preis = Math.round(ek / 0.31 / 10000) * 10000
  const miete = preis * 0.05
  const zinsen = preis * 0.7 * 0.041
  const afa = preis * (252100 / 300000) * 0.05
  const verlust = miete - zinsen - afa
  return {
    preis, eigenkapital: preis * 0.31, finanzierung: preis * 0.7, miete, zinsen, afa, verlust,
    steuer: verlust < 0 ? -verlust * 0.42 : 0, mieteMinusZins: miete - zinsen,
  }
}

const zeile = (l: string, r: string, fett = false) =>
  `<tr><td style="padding:7px 0;border-bottom:1px solid #eee7da;color:#4a4740">${l}</td><td style="padding:7px 0;border-bottom:1px solid #eee7da;text-align:right;white-space:nowrap;padding-left:12px;color:#1a2332;${fett ? 'font-weight:700' : ''}">${r}</td></tr>`

export function rechnungMail(vorname: string | null, ekSpanne: string): { subject: string; html: string } | null {
  const spanne = EK_TEXT[ekSpanne]
  if (!spanne) return null
  const hallo = vorname?.trim() ? `Hallo ${esc(vorname.trim())},` : 'Hallo,'
  const termin = 'https://portal.happy-property.com/termin?src=rechnung-mail'
  const seite = 'https://steuervorteil-zypern-immobilien.com/vermoegen-absichern-zypern/'
  const knopf = `<p style="text-align:center;margin:26px 0 8px"><a href="${termin}" style="background:#e0785f;color:#fff;text-decoration:none;padding:14px 26px;border-radius:10px;font-weight:700;display:inline-block">Kostenloses Gespräch mit Sven buchen</a></p>`
  const fuss = `<p style="margin:26px 0 0;font-size:12px;line-height:1.55;color:#8a857b">Beispielrechnung nach dem Fact-Sheet unserer Steuerkanzlei, auf deinen Kaufpreis hochgerechnet. Annahmen: 70 % Finanzierung zu 4,1 %, 5 % Jahresmiete bei Langzeitvermietung, 5 % degressive Abschreibung auf den Gebäudeanteil (gilt bei Langzeitvermietung auch für Neubau in Deutschland, der Unterschied ist der Preis), 42 % Grenzsteuersatz. Vor Verwaltung, Instandhaltung und Tilgung. Keine Garantie, keine Steuer- oder Finanzierungsberatung. Was es bei dir ausmacht, hängt von deinem Einkommen und deiner Situation ab.</p>`
  const rahmen = (inhalt: string) => `<div style="background:#faf6f0;padding:28px 14px;font-family:Montserrat,Helvetica,Arial,sans-serif;color:#2a2a2a;line-height:1.6"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e6dfd0;border-radius:12px;padding:30px 26px">${inhalt}<p style="margin:26px 0 0">Viele Grüße aus Paphos<br><strong>Sven Rüprich</strong><br><span style="color:#8a857b">Happy Property</span></p></div></div>`

  const r = rechne(ekSpanne)
  if (!r) {
    // unter 50.000 €: ehrlich sagen, was der Einstieg braucht, statt eine Rechnung zu erfinden
    const html = rahmen(`<h1 style="margin:0 0 14px;font-family:'Playfair Display',Georgia,serif;font-size:24px;line-height:1.25;color:#1a2332">Deine Rechnung zu Zypern</h1>
<p style="margin:0 0 12px">${hallo}</p>
<p style="margin:0 0 12px">du hast angegeben, dass dir aktuell <strong>${spanne}</strong> Eigenkapital zur Verfügung stehen. Ehrlich vorab: Die kleinsten Neubauwohnungen in Paphos beginnen bei rund 210.000 € netto. Mit Mehrwertsteuer und Anwalt brauchst du dafür üblicherweise rund 75.000 bis 80.000 € Eigenkapital, wenn eine Bank den Rest finanziert.</p>
<p style="margin:0 0 12px">Zwei Wege, die viele unserer Käufer gehen:</p>
<ul style="margin:0 0 12px;padding-left:20px"><li>Vorhandene Werte nutzen: Eine abbezahlte oder teilweise abbezahlte Immobilie kann eine Bank beleihen. Auf Wunsch nennen wir dir Banken.</li><li>Noch etwas ansparen und den Einstieg planen, damit du beim richtigen Projekt bereit bist.</li></ul>
<p style="margin:0 0 12px">Wie die Zahlen für eine Wohnung mit 300.000 € aussehen, siehst du in der Beispielrechnung: <a href="${seite}" style="color:#c4573e">Beispielrechnung ansehen</a>. Welcher Weg für dich passt, klären wir am besten in einem kurzen Gespräch.</p>
${knopf}${fuss}`)
    return { subject: 'Deine Rechnung zu Zypern', html }
  }

  const mehrere = r.preis > 600000 ? ` Das entspricht zum Beispiel ${r.preis >= 1200000 ? 'drei bis vier' : 'zwei bis drei'} Wohnungen, verteilt auf verschiedene Projekte.` : ''
  const html = rahmen(`<h1 style="margin:0 0 14px;font-family:'Playfair Display',Georgia,serif;font-size:24px;line-height:1.25;color:#1a2332">Deine persönliche Rechnung</h1>
<p style="margin:0 0 12px">${hallo}</p>
<p style="margin:0 0 12px">du hast angegeben, dass dir aktuell <strong>${spanne}</strong> Eigenkapital zur Verfügung stehen. Gerechnet mit <strong>${eur(EK_BETRAG[ekSpanne])}</strong> reicht das bei 70 % Finanzierung für Neubau auf Zypern (EU) im Wert von rund <strong>${eur(r.preis)}</strong> inklusive MwSt.${mehrere}</p>
<p style="margin:18px 0 6px;font-weight:700;color:#1a2332">Das setzt du ein</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">${zeile('Kaufpreis inkl. MwSt', eur(r.preis))}${zeile('Eigenkapital (30 % + ca. 1 % Anwalt)', eur(r.eigenkapital))}${zeile('Finanzierung (70 %)', eur(r.finanzierung))}</table>
<p style="margin:18px 0 6px;font-weight:700;color:#1a2332">Das Ergebnis im ersten vollen Jahr</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">${zeile('Mieteinnahmen (5 %, langfristig vermietet)', '+' + eur(r.miete))}${zeile('Schuldzinsen (4,1 %)', '-' + eur(r.zinsen))}${zeile('Abschreibung (5 % degressiv, kostet kein Geld)', '-' + eur(r.afa))}${zeile('Steuerlicher Verlust in Deutschland', '-' + eur(-r.verlust))}${zeile('Miete minus Zinsen', '+' + eur(r.mieteMinusZins), true)}${zeile('Steuerersparnis in Deutschland (bei 42 %)', '+' + eur(r.steuer), true)}${zeile('Steuer in Zypern in den ersten Jahren', 'meist 0 €')}</table>
<p style="margin:16px 0 12px">Im Beispiel kommen im ersten Jahr also rund <strong>${eur(r.mieteMinusZins + r.steuer)}</strong> zusammen, vor Verwaltung, Instandhaltung und Tilgung. Die ausführliche Rechnung mit allen Schritten steht auf unserer Seite: <a href="${seite}" style="color:#c4573e">Beispielrechnung ansehen</a>.</p>
<p style="margin:0 0 12px">Welche Projekte zu deinem Budget passen und wie sich die Zahlen mit deinem Einkommen genau verändern, rechne ich gern mit dir zusammen durch.</p>
${knopf}${fuss}`)
  return { subject: `Deine Rechnung: Neubau auf Zypern für rund ${eur(r.preis)}`, html }
}
