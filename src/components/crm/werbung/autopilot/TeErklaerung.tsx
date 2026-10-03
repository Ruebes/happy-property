import { useTranslation } from 'react-i18next'
import { useWerbeFormat } from '../format'

// ── Was ist ein Termin-Äquivalent? (Erklärkasten im Reiter Qualität) ─────────
// Werte aus der aktiven Wertleiter (ad_ev_weights), sonst die Startwerte v1.

/** Wertleiter v1 (SPEC §3), falls keine aktive Version geladen werden kann */
const LEITER_V1: Record<string, number> = {
  lead_kap_nein: 0.05, lead_kap_ja: 0.2, lead_ohne: 0.08, alt_faktor: 0.25, gebucht: 0.8, gebucht_kap_ja: 1.2,
  no_show: 0.3, gehalten: 1.6, schlecht_mit_termin: 0.2, schlecht_ohne_termin: 0.02, gut: 4.0, te_cap: 6,
}

export default function TeErklaerung({ gewichte, ziel, version }: { gewichte: Record<string, number> | null; ziel: number; version: number | null }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const w = (k: string) => {
    const v = Number(gewichte?.[k] ?? LEITER_V1[k])
    return Number.isFinite(v) ? v.toLocaleString(fmt.locale, { maximumFractionDigits: 2 }) : '-'
  }
  const zeilen: Array<[string, string]> = [
    [t('crm.werbung.qualitaet.leiter.leadNein', 'Lead, Kapitalbasis Nein'), w('lead_kap_nein')],
    [t('crm.werbung.qualitaet.leiter.leadJa', 'Lead, Kapitalbasis Ja'), w('lead_kap_ja')],
    [t('crm.werbung.qualitaet.leiter.leadOhne', 'Lead ohne Antworten'), t('crm.werbung.qualitaet.leiter.leadOhneWert', '{{w}} (nach 7 Tagen ohne Termin mal {{f}})', { w: w('lead_ohne'), f: w('alt_faktor') })],
    [t('crm.werbung.qualitaet.leiter.gebucht', 'Termin gebucht'), t('crm.werbung.qualitaet.leiter.gebuchtWert', '{{w}} (mit Kapitalbasis Ja {{ja}})', { w: w('gebucht'), ja: w('gebucht_kap_ja') })],
    [t('crm.werbung.qualitaet.leiter.noShow', 'Nicht erschienen'), w('no_show')],
    [t('crm.werbung.qualitaet.leiter.gehalten', 'Termin stattgefunden'), w('gehalten')],
    [t('crm.werbung.qualitaet.leiter.schlecht', 'Daumen runter'), t('crm.werbung.qualitaet.leiter.schlechtWert', '{{w}} (ohne Termin {{o}})', { w: w('schlecht_mit_termin'), o: w('schlecht_ohne_termin') })],
    [t('crm.werbung.qualitaet.leiter.gut', 'Daumen hoch'), w('gut')],
    [t('crm.werbung.qualitaet.leiter.sale', 'Verkauf'), t('crm.werbung.qualitaet.leiter.saleWert', 'Provision geteilt durch den Referenzwert, für Entscheidungen höchstens {{cap}}', { cap: w('te_cap') })],
  ]
  return (
    <details className="hp-card group p-4 sm:p-5">
      <summary className="cursor-pointer list-none font-heading text-base text-hp-navy">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90" aria-hidden="true">›</span>
        {t('crm.werbung.qualitaet.erklaerTitel', 'Was ist ein Termin-Äquivalent (TE)?')}
      </summary>
      <div className="mt-3 space-y-3 text-sm text-gray-700">
        <p>
          {t('crm.werbung.qualitaet.erklaer1', 'Ein TE misst, was ein Lead wert ist, in gebuchten Terminen. Jeder Lead zählt mit dem Wert seines weitesten Schritts. Ein gehaltener Termin zählt also mehr als ein Lead, der nur das Formular ausgefüllt hat, und ein Daumen hoch zählt am meisten.')}
        </p>
        <table className="w-full max-w-xl text-sm">
          <tbody className="divide-y divide-gray-100">
            {zeilen.map(([label, wert]) => (
              <tr key={label}>
                <td className="py-1.5 pr-4 text-gray-600">{label}</td>
                <td className="py-1.5 font-semibold tabular-nums text-hp-navy">{wert}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          {t('crm.werbung.qualitaet.erklaer2', 'Kosten pro TE = Ausgaben geteilt durch TE. Ziel: {{ziel}}. Bei wenigen Daten zieht die Schätzung zur nächsthöheren Ebene (Anzeige, Werbemittel, Anzeigengruppe, Kampagne, Konto), deshalb steht daneben ein Bereich, in dem der wahre Wert mit 80 % Wahrscheinlichkeit liegt.', { ziel: fmt.eur(ziel) })}
        </p>
        <p>
          {t('crm.werbung.qualitaet.erklaer3', 'Chance gut = Wahrscheinlichkeit, dass die Kosten pro TE unter dem Ziel liegen. Risiko schlecht = Wahrscheinlichkeit, dass sie über dem Doppelten des Ziels liegen. Zuordnung = Anteil der Leads, die einer Anzeige zugeordnet sind; unter 80 % schaltet der Autopilot nichts selbst ab.')}
        </p>
        <p className="text-xs text-gray-500">
          {version != null
            ? t('crm.werbung.qualitaet.leiterVersion', 'Wertleiter Version {{v}}', { v: version })
            : t('crm.werbung.qualitaet.leiterStart', 'Startwerte der Wertleiter')}
        </p>
      </div>
    </details>
  )
}
