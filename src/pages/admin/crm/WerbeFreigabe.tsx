import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import EmptyState from '../../../components/ui/EmptyState'
import PageHeader from '../../../components/ui/PageHeader'
import Spinner from '../../../components/ui/Spinner'
import { ConfirmProvider } from '../../../components/ui/ConfirmDialog'
import { ToastProvider, useToast } from '../../../components/ui/Toast'
import { freigabenGesperrt, ladeEinstellungen, ladeGruppe, ladeRegeln } from '../../../components/crm/werbung/autopilot/abfragen'
import { useWerbeRechte } from '../../../components/crm/werbung/autopilot/useWerbeRechte'
import VorschlagKarte from '../../../components/crm/werbung/autopilot/VorschlagKarte'
import { dbFehlerText, fehltSchema, modusLabel } from '../../../components/crm/werbung/autopilot/werbeTexte'
import type { WerbeAktion, WerbeAutopilotEinstellungen, WerbeRegel } from '../../../lib/werbungTypes'

// ── Freigabe einer Autopilot-Vorschlagsgruppe (/admin/crm/werbung/freigabe/:gruppeId) ──
// Ziel der Links aus der Morgenmail: eine Gruppe mit Begründung, Vorher ->
// Nachher und Freigeben/Ablehnen (dieselben Aufrufe wie im Reiter Autopilot:
// RPC werbe_vorschlag_entscheiden, danach werbe-ausfuehren modus freigabe).
// Schon entschiedene Gruppen erscheinen nur lesend mit ihrem Ergebnis.
// Recht: werbung (Route), Entscheiden: Admin oder Recht werbung (Datenbank).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function WerbeFreigabe() {
  return (
    <DashboardLayout basePath="/admin/crm">
      <ToastProvider>
        <ConfirmProvider>
          <Freigabe />
        </ConfirmProvider>
      </ToastProvider>
    </DashboardLayout>
  )
}

function Freigabe() {
  const { t } = useTranslation()
  const toast = useToast()
  const rechte = useWerbeRechte()
  const { gruppeId = '' } = useParams<{ gruppeId: string }>()
  const gueltig = UUID.test(gruppeId)

  const [loading, setLoading] = useState(true)
  const [fehler, setFehler] = useState<string | null>(null)
  const [gruppe, setGruppe] = useState<WerbeAktion[]>([])
  const [regeln, setRegeln] = useState<WerbeRegel[]>([])
  const [einstellungen, setEinstellungen] = useState<WerbeAutopilotEinstellungen | null>(null)

  const laden = useCallback(async () => {
    if (!gueltig) { setLoading(false); return }
    setLoading(true)
    try {
      // Nacheinander (Micro-Instanz): Gruppe, dann die Regeln dazu, dann der Modus
      const rows = await ladeGruppe(gruppeId)
      setGruppe(rows)
      const keys = [...new Set(rows.map(r => r.rule_key).filter((k): k is string => !!k))]
      setRegeln(await ladeRegeln(keys))
      setEinstellungen(await ladeEinstellungen())
      setFehler(null)
    } catch (err) {
      console.error('[WerbeFreigabe] laden:', err)
      setFehler(fehltSchema(err)
        ? t('crm.werbung.autopilot.nichtFreigeschaltetText', 'Die Datenbank-Erweiterung für den Autopiloten ist noch nicht eingespielt.')
        : dbFehlerText(t, err))
      if (!fehltSchema(err)) toast.error(dbFehlerText(t, err))
    } finally {
      setLoading(false)
    }
  }, [gruppeId, gueltig, t, toast])

  useEffect(() => { void laden() }, [laden])

  const regelMap = useMemo(() => new Map(regeln.map(r => [r.rule_key, r])), [regeln])
  const offen = gruppe.some(a => a.status == null && a.freigabe === 'vorgeschlagen')

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title={t('crm.werbung.autopilot.seite.titel', 'Vorschlag des Autopiloten')}
        subtitle={einstellungen
          ? t('crm.werbung.autopilot.seite.modus', 'Betriebsart: {{modus}}', { modus: modusLabel(t, einstellungen.autopilot_mode) })
          : undefined}
        back={{ to: '/admin/crm/ads?tab=autopilot', label: t('crm.werbung.autopilot.seite.zurueck', 'Zum Autopiloten'), preferHistory: true }}
      />

      {loading ? (
        <div className="flex justify-center py-24"><Spinner size="lg" /></div>
      ) : !gueltig || (!fehler && !gruppe.length) ? (
        <div className="hp-card">
          <EmptyState
            icon="rules"
            title={t('crm.werbung.autopilot.seite.nichtGefunden', 'Vorschlag nicht gefunden')}
            text={t('crm.werbung.autopilot.seite.nichtGefundenText', 'Der Link ist ungültig oder der Vorschlag gehört nicht zu deinem Zugang.')}
          />
        </div>
      ) : fehler ? (
        <div className="hp-card">
          <EmptyState icon="alert" title={t('crm.werbung.autopilot.seite.fehler', 'Konnte nicht geladen werden')} text={fehler}
            action={<button type="button" className="hp-btn hp-btn-ghost" onClick={() => void laden()}>{t('crm.werbung.autopilot.neuLaden', 'Neu laden')}</button>} />
        </div>
      ) : (
        <>
          {!offen && (
            <p className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700">
              {t('crm.werbung.autopilot.seite.entschieden', 'Dieser Vorschlag ist schon entschieden. Hier steht nur noch das Ergebnis.')}
            </p>
          )}
          <VorschlagKarte
            gruppe={gruppe}
            regeln={regelMap}
            rechte={rechte}
            gesperrt={freigabenGesperrt(einstellungen)}
            onEntschieden={() => void laden()}
          />
        </>
      )}
    </div>
  )
}
