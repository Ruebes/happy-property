import { useTranslation } from 'react-i18next'
import type { Destination, Objective } from '../../../../lib/metaSpec'
import { feldId, feldLabel } from './Bausteine'
import { FeldHinweise } from './PruefPanel'
import { EmpfohlenBadge } from './bearbeitenHelfer'
import { ortStatus, ortWahlenFuer } from './r23Typen'

// ── Conversion-Ort der Anzeigengruppe (Karten statt Liste) ───────────────────
// Karten je Kampagnenziel aus metaSpec (destinationsFor): bei Leads Website,
// Sofortformular, Website und Sofortformular, WhatsApp, Anrufe, Website und
// Anrufe; Instagram Direct und Messenger-Lead sichtbar, aber gesperrt mit Grund.
// Bei Traffic, Interaktion und Umsatz auch Messenger-Chat, bei Interaktion
// Beitrag und Video, bei Bekanntheit „Kein Conversion-Ort". Was metaSpec noch
// nicht freigibt, bleibt grau mit Grund und wird automatisch wählbar.

export default function ConversionOrtWahl({ node, objective, value, onChange, disabled, sperre, lernHinweis }: {
  node: string
  objective: Objective
  value: Destination
  onChange: (d: Destination) => void
  disabled?: boolean
  /** Bearbeiten: Conversion-Ort bei Meta nicht mehr änderbar */
  sperre?: string
  lernHinweis?: string
}) {
  const { t } = useTranslation()
  const label = feldLabel(t, 'adset.destination', 'Conversion-Ort')
  const aus = !!disabled || !!sperre
  // Ungewöhnlicher Wert (z. B. aus einem Import) erscheint als eigene Karte
  const wahlen = ortWahlenFuer(objective, value)
  return (
    <div id={feldId('adset.destination')} data-einstellung={label} className="scroll-mt-24 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-gray-500">{sperre ? '🔒 ' : ''}{label}</span>
      </div>
      <p className="text-[10px] leading-snug text-gray-500">
        {t('crm.werbung.builder.ort.hilfe', 'Wo die Conversion passiert. Davon hängen Performance-Ziel, Button und Ziel der Anzeigen ab.')}{lernHinweis ?? ''}
      </p>
      <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {wahlen.map(w => {
          const st = ortStatus(objective, w)
          const aktiv = value === w.wert
          const frei = st.frei || aktiv
          return (
            <button key={w.wert} type="button" role="radio" aria-checked={aktiv} aria-disabled={!frei || aus}
              disabled={!aktiv && (!st.frei || aus)}
              onClick={() => { if (st.frei && !aus && !aktiv) onChange(st.wert) }}
              className={`rounded-xl border px-3 py-2.5 text-left text-xs transition-colors ${!frei
                ? 'cursor-not-allowed border-dashed border-gray-200 bg-gray-50 opacity-70'
                : aktiv ? 'border-hp-navy bg-hp-navy/5 ring-1 ring-hp-navy' : 'border-gray-200 bg-white hover:border-hp-navy/40 disabled:opacity-60'}`}>
              <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-hp-navy">
                {!frei ? '🔒 ' : ''}{t(w.titelKey, w.titel)}
                {w.empfohlen && <EmpfohlenBadge />}
              </span>
              {w.textKey && <span className="mt-0.5 block leading-snug text-gray-600">{t(w.textKey, w.text)}</span>}
              {!st.frei && <span className="mt-1 block text-[10px] leading-snug text-hp-navy/80">{t(st.grundKey, st.grund)}</span>}
            </button>
          )
        })}
      </div>
      {sperre && <p className="text-[10px] leading-snug text-hp-navy/80">{sperre}</p>}
      <FeldHinweise node={node} felder="adset.destination" />
    </div>
  )
}
