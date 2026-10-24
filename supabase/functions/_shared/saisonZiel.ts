// Deno-Zwilling von seasonBreakdown() in src/lib/rechner.ts (ohne Kalender, gleiche
// Rundung). Damit legt das Anfrage-Paket den Hochsaisonpreis so fest, dass die Rechnung
// die Ziel-Bruttorendite des Projekts zeigt (crm_projects.calc_defaults.saison).
// Geprüft mit scripts/verify-saison-ziel.mjs gegen die Engine.
const SAISON = [
  { days: 137, baseOcc: 27.5, adrFactor: 0.45 }, { days: 61, baseOcc: 55, adrFactor: 0.65 },
  { days: 92, baseOcc: 87.5, adrFactor: 1 }, { days: 75, baseOcc: 70, adrFactor: 0.75 },
]
export function saisonMiete(totalOcc: number, adrHigh: number): number {
  const baseAvg = SAISON.reduce((a, x) => a + x.baseOcc * x.days, 0) / 365
  const f = Math.max(0, totalOcc) / baseAvg
  return SAISON.reduce((a, x) => {
    const occ = Math.min(98, Math.round(x.baseOcc * f * 10) / 10)
    return a + Math.round(x.days * occ / 100) * Math.round(adrHigh * x.adrFactor)
  }, 0)
}
// Kleinster ganzer Hochsaisonpreis, bei dem die Bruttorendite (Miete / Bruttopreis, wie
// applySeason) mindestens zielPct erreicht.
export function saisonPreisFuer(zielPct: number, totalOcc: number, bruttoPreis: number): number {
  for (let adr = 20; adr <= 3000; adr++) {
    if (Math.round(saisonMiete(totalOcc, adr) / bruttoPreis * 10000) / 100 >= zielPct) return adr
  }
  return 3000
}
