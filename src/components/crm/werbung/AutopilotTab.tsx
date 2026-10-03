import { useTranslation } from 'react-i18next'
import EmptyState from '../../ui/EmptyState'

// ── Reiter „Autopilot" des Werbemanagers (Platzhalter) ──────────────────────────
// Wird vom Baustein „Autopilot" ersetzt. Standard-Export ohne Props
// (lazyWithReload); Daten und Aktionen der Seite gibt es über useWerbeKontext()
// aus ./useWerbeDaten. Eigene Daten lädt der Reiter selbst, erst wenn er offen
// ist, seriell und mit Zeitfilter (Micro-Instanz).
export default function AutopilotTab() {
  const { t } = useTranslation()
  return (
    <div className="hp-card">
      <EmptyState
        icon="rules"
        title={t('crm.werbung.common.wirdGebaut', 'Wird gebaut')}
        text={t('crm.werbung.common.wirdGebautText', 'Dieser Bereich entsteht gerade. Statistik und Werbemittel laufen wie gewohnt weiter.')}
      />
    </div>
  )
}
