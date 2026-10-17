// Persönliche Rechnung zum Eigenkapital (Plan-B-Seite „Guide + Rechnung“).
// Seit 17.10.2026 (Sven: „Rechnung in der Mail ist schlecht, baue eine ausführliche Seite“):
// Die Mail verlinkt auf drei Seiten des Rendite-Rechners (/rechnung/:token), die live mit der
// verifizierten Engine (src/lib/rechner.ts) rechnen: Langzeit, Kurzzeit und der Vergleich.
// Hier entstehen nur die Parameter; gerechnet wird beim Öffnen der Seite.
//
// Annahmen (mit Sven 17.10.2026 abgestimmt, auf der Seite sichtbar): Kaufpreis = Eigenkapital
// / 0,31 (30 % Eigenkapital + ca. 1 % Anwalt), 4,1 % Zins, 20 Jahre Annuität mit 2 % Tilgung,
// Langzeit 5 % Jahresmiete und 4 % Verwaltung, Kurzzeit Saisonmodell (56 % Auslastung) mit
// 25 % Verwaltung, Mietsteigerung 2,5 %, Wertsteigerung 3 %, 60 € Gemeinschaftskosten und
// Versicherung pro Monat, 0,5 % Instandhaltung, 42 % Grenzsteuersatz in Deutschland.

export const EK_BETRAG: Record<string, number> = {
  'unter-50k': 75000, '50-100k': 75000, '100-200k': 150000, '200-500k': 300000, 'ueber-500k': 500000,
}
const EK_TEXT: Record<string, string> = {
  'unter-50k': 'unter 50.000 €', '50-100k': '50.000 bis 100.000 €', '100-200k': '100.000 bis 200.000 €',
  '200-500k': '200.000 bis 500.000 €', 'ueber-500k': 'über 500.000 €',
}
// Summe aus Tagen × Basisauslastung × Preisfaktor des Paphos-Saisonprofils (SEASON_DEF in
// rechner.ts): Jahresmiete ≈ SEASON_SUM × Preis pro Nacht in der Hochsaison.
const SEASON_SUM = 137 * 0.275 * 0.45 + 61 * 0.55 * 0.65 + 92 * 0.875 * 1 + 75 * 0.7 * 0.75

const eur = (n: number) => `${Math.round(n).toLocaleString('de-DE')} €`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

export function kaufpreisBrutto(ekSpanne: string): number | null {
  const ek = EK_BETRAG[ekSpanne]
  return ek ? Math.round(ek / 0.31 / 10000) * 10000 : null
}

// Vollständige CalcParams (wie DEFAULT_PARAMS in rechner.ts), damit die Seite ohne Lücken rechnet.
function params(ek: number, gross: number, lang: boolean) {
  const now = new Date()
  const priceNet = Math.round(gross / 1.19 / 1000) * 1000
  return {
    month: now.getMonth() + 1, year: now.getFullYear(), dealType: 'single',
    priceNet, discountPct: 0, bedrooms: 2,
    sdInputMode: 'manual', sdUnits: [], sdPrice: 1000000, sdSqm: 250, sdTerr: 60, sdNum: 3,
    sdDiscount: 0, sdVatDrawn: 0, sdVatYears: 0, sdTaxRate: 15,
    fin: 'yes', letType: lang ? 'long' : 'short', mode: 'ann', res: 'de', hotelConcept: false,
    equity: ek, cyBI: 0, yieldPct: lang ? 5 : 7, rentGrowth: 2.5, mgmtPct: lang ? 4 : 25, interestPct: 4.1,
    termYears: 20, amortPct: 2, appreciationPct: 3, deTaxPct: 42, furnCost: 0, furnFree: false,
    ppVals: Array(10).fill(0),
    season: lang ? null : { totalOcc: 56, adrHigh: Math.round(gross * 0.07 / SEASON_SUM) },
    vatMode: 'standard19', livingSqm: null, selfUseMonths: 0,
    holder: 'privat', corpTaxPct: 15, divPayoutPct: 100, divTaxPct: 26.375, gesy: true,
    opexMonthly: 60, maintPct: 0.5, mgmtMode: 'pct', mgmtFix: 0, socialIns: true, years: 10,
  }
}

export function rechnungItems(ekSpanne: string): { lang: unknown; kurz: unknown } | null {
  const ek = EK_BETRAG[ekSpanne]; const gross = kaufpreisBrutto(ekSpanne)
  if (!ek || !gross) return null
  const basis = { project: 'Neubau in Paphos, Südzypern (EU)', bedrooms: 2, location: 'Region Paphos', price_gross: gross, price_net: Math.round(gross / 1.19 / 1000) * 1000 }
  return {
    lang: { ...basis, label: 'Langzeitvermietung', unit: 'Beispielwohnung', tagline: 'Langfristig vermietet, 5 % degressive Abschreibung in Deutschland', params: params(ek, gross, true) },
    kurz: { ...basis, label: 'Kurzzeitvermietung', unit: 'Beispielwohnung', tagline: 'Ferienvermietung mit Saisonmodell, 3 % lineare Abschreibung in Deutschland', params: params(ek, gross, false) },
  }
}

export function rechnungMail(vorname: string | null, ekSpanne: string, links: { vergleich: string; lang: string; kurz: string }): { subject: string; html: string } | null {
  const spanne = EK_TEXT[ekSpanne]; const gross = kaufpreisBrutto(ekSpanne)
  if (!spanne || !gross) return null
  const hallo = vorname?.trim() ? `Hallo ${esc(vorname.trim())},` : 'Hallo,'
  const unter = ekSpanne === 'unter-50k'
  const btn = (href: string, txt: string, primaer = false) => `<a href="${href}" style="display:block;margin:10px 0;text-align:center;text-decoration:none;font-weight:700;padding:14px 18px;border-radius:10px;${primaer ? 'background:#1a2332;color:#fff' : 'border:1.5px solid #1a2332;color:#1a2332;background:#fff'}">${txt}</a>`
  const intro = unter
    ? `du hast angegeben, dass dir aktuell <strong>${spanne}</strong> Eigenkapital zur Verfügung stehen. Ehrlich vorab: Die kleinsten Neubauwohnungen in Paphos beginnen bei rund 210.000 € netto, dafür brauchst du mit Mehrwertsteuer und Anwalt üblicherweise rund 75.000 € Eigenkapital. Vorhandene Werte wie eine abbezahlte Immobilie kann eine Bank beleihen, auf Wunsch nennen wir dir Banken. Damit du siehst, wie die Zahlen aussehen, haben wir dir ein Beispiel mit 75.000 € Eigenkapital durchgerechnet: eine Wohnung für rund <strong>${eur(gross)}</strong> inklusive MwSt.`
    : `du hast angegeben, dass dir aktuell <strong>${spanne}</strong> Eigenkapital zur Verfügung stehen. Damit ist Neubau in Paphos, Südzypern (EU), für rund <strong>${eur(gross)}</strong> inklusive MwSt möglich${gross > 600000 ? ', zum Beispiel verteilt auf mehrere Wohnungen' : ''}. Wir haben dir das ausführlich durchgerechnet, einmal mit Langzeit- und einmal mit Ferienvermietung.`
  const html = `<div style="background:#faf6f0;padding:28px 14px;font-family:Montserrat,Helvetica,Arial,sans-serif;color:#2a2a2a;line-height:1.6"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e6dfd0;border-radius:12px;padding:30px 26px">
<h1 style="margin:0 0 14px;font-family:'Playfair Display',Georgia,serif;font-size:24px;line-height:1.25;color:#1a2332">Deine persönliche Rechnung ist fertig</h1>
<p style="margin:0 0 12px">${hallo}</p>
<p style="margin:0 0 14px">${intro}</p>
<p style="margin:0 0 6px">Auf den Seiten siehst du alles über 10 Jahre: Kaufpreis und Nebenkosten, Finanzierung, Mieteinnahmen, Verwaltung und laufende Kosten, Steuer in Deutschland und Zypern, Restschuld, Wertentwicklung und dein Eigenkapital Jahr für Jahr.</p>
${btn(links.vergleich, 'Langzeit und Kurzzeit im Vergleich', true)}
${btn(links.lang, 'Ausführlich: Langzeitvermietung')}
${btn(links.kurz, 'Ausführlich: Kurzzeitvermietung')}
<p style="margin:18px 0 12px">Welche Projekte zu deinem Budget passen und wie sich die Zahlen mit deinem Einkommen genau verändern, rechne ich gern mit dir zusammen durch.</p>
<p style="text-align:center;margin:20px 0 6px"><a href="https://portal.happy-property.com/termin?src=rechnung-mail" style="background:#e0785f;color:#fff;text-decoration:none;padding:14px 26px;border-radius:10px;font-weight:700;display:inline-block">Kostenloses Gespräch mit Sven buchen</a></p>
<p style="margin:22px 0 0;font-size:12px;line-height:1.55;color:#8a857b">Beispielrechnung mit Annahmen, die du auf der Seite siehst. Keine Garantie, keine Steuer- oder Finanzierungsberatung. Was es bei dir ausmacht, hängt von deinem Einkommen und deiner Situation ab.</p>
<p style="margin:22px 0 0">Viele Grüße aus Paphos<br><strong>Sven Rüprich</strong><br><span style="color:#8a857b">Happy Property</span></p>
</div></div>`
  return { subject: unter ? 'Deine Rechnung zu Zypern' : `Deine Rechnung: Neubau auf Zypern für rund ${eur(gross)}`, html }
}
