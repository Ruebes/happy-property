import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Tabs, { tabPanelProps } from '../../ui/Tabs'
import { useWerbeKontext } from './useWerbeDaten'
import { Hinweis, SchreibSperre } from './zielgruppen/Bausteine'
import { useWerkzeugStatus } from './zielgruppen/useWerkzeugStatus'
import RegelnListe from './tests/RegelnListe'
import TestsListe from './tests/TestsListe'

// ── Reiter „Tests & Regeln" des Werbemanagers ────────────────────────────────
// A/B-Tests (Meta-Experimente: Variable, Varianten, Gewinner-Kennzahl,
// Laufzeit, Ergebnis) und Metas automatisierte Regeln (Liste, Vorlagen,
// Editor, Verlauf, ein/aus). Unser Autopilot bleibt die Hauptsteuerung, weil
// nur er die CRM-Qualität kennt; Metas Regeln sind das Sicherheitsnetz.
// Alles läuft über die Edge Function meta-steuerung (Rechte, Freischaltung
// builder_enabled, Schreibprotokoll prüft der Server). Standard-Export ohne
// Props (lazyWithReload). Lädt erst, wenn der Reiter offen ist und die
// Seitendaten fertig sind; Regeln erst beim Öffnen ihres Unterreiters.

type Unterreiter = 'tests' | 'regeln'

export default function TestsTab() {
  const { t } = useTranslation()
  const { loading: seiteLaedt } = useWerbeKontext()
  const status = useWerkzeugStatus()
  const [unten, setUnten] = useState<Unterreiter>('tests')
  const [besucht, setBesucht] = useState<ReadonlySet<Unterreiter>>(() => new Set<Unterreiter>(['tests']))

  const wechsle = (id: string) => {
    const u: Unterreiter = id === 'regeln' ? 'regeln' : 'tests'
    setUnten(u)
    setBesucht(prev => (prev.has(u) ? prev : new Set([...prev, u])))
  }

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <h2 className="font-heading text-xl text-hp-navy">{t('crm.werbung.tests.titel', 'Tests & Regeln')}</h2>
        <p className="mt-0.5 text-sm text-gray-600">
          {t('crm.werbung.tests.text', 'A/B-Tests zeigen sauber, welche Variante besser wirkt. Metas automatisierte Regeln sind die Notbremse für den Fall, dass bei uns etwas ausfällt.')}
        </p>
      </div>

      <Hinweis ton="info" titel={t('crm.werbung.tests.autopilotTitel', 'Der Autopilot bleibt die Hauptsteuerung')}>
        {t('crm.werbung.tests.autopilotText', 'Er bewertet Anzeigen nach Terminen und Lead-Qualität aus dem CRM. Metas Regeln sehen nur Metas Zahlen: nutze sie als Sicherheitsnetz, nicht zum Skalieren.')}
      </Hinweis>
      <SchreibSperre grund={status.schreibSperre} />

      <Tabs idBase="werbung-tests" value={unten} onChange={wechsle}
        ariaLabel={t('crm.werbung.tests.unterreiter', 'Tests oder Regeln')}
        tabs={[
          { id: 'tests', label: t('crm.werbung.tests.reiterTests', 'A/B-Tests') },
          { id: 'regeln', label: t('crm.werbung.tests.reiterRegeln', 'Automatisierte Regeln') },
        ]} />

      {!seiteLaedt && (
        <>
          <div {...tabPanelProps('werbung-tests', 'tests')} hidden={unten !== 'tests'}>
            <TestsListe schreibSperre={status.schreibSperre} pruefSperre={status.pruefSperre} aktiv={unten === 'tests'} />
          </div>
          {besucht.has('regeln') && (
            <div {...tabPanelProps('werbung-tests', 'regeln')} hidden={unten !== 'regeln'}>
              <RegelnListe schreibSperre={status.schreibSperre} pruefSperre={status.pruefSperre} istAdmin={status.rechte.istAdmin} aktiv={unten === 'regeln'} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
