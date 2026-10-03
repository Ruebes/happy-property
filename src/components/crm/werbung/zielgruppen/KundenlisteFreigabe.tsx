import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import { useConfirm } from '../../../ui/ConfirmDialog'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { dsgvoText } from './Kundenliste'
import type { WerkzeugStatus } from './useWerkzeugStatus'
import { dbFehlerText, setzeKundenlisteFreigabe } from './werkzeugeApi'

// ── Werbe-Einstellung „Kundenlisten an Meta erlaubt" ─────────────────────────
// Svens eigene Freigabe, bewusst getrennt vom Upload-Assistenten (Kundenliste.tsx):
// einschalten nur Admin (der Schutz-Trigger in ad_settings prüft das selbst),
// wieder sperren jeder mit Recht Werbemanager. Ohne Spalte (Migration fehlt)
// oder bei Lesefehler erscheint nichts; der Assistent sagt dann, warum.

export default function KundenlisteFreigabe({ status }: { status: WerkzeugStatus }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const toast = useToast()
  const [schaltet, setSchaltet] = useState(false)

  const e = status.einstellungen
  if (!e || e.fehler || e.kundenlisteFreigegeben === null) return null
  const frei = e.kundenlisteFreigegeben
  const istAdmin = status.rechte.istAdmin
  const darfSperren = istAdmin || status.rechte.darfEntscheiden
  if (frei ? !darfSperren : !istAdmin) return null

  const schalten = async (an: boolean) => {
    const ok = await confirm({
      title: an
        ? t('crm.werbung.zielgruppen.kl.freigebenFrage', 'Kundenlisten freigeben?')
        : t('crm.werbung.zielgruppen.kl.sperrenFrage', 'Kundenlisten wieder sperren?'),
      message: an ? dsgvoText(t) : t('crm.werbung.zielgruppen.kl.sperrenText', 'Neue Kundenlisten lassen sich dann nicht mehr anlegen. Vorhandene bleiben bei Meta bestehen.'),
      confirmLabel: an ? t('crm.werbung.zielgruppen.kl.freigeben', 'Freigeben') : t('crm.werbung.zielgruppen.kl.sperren', 'Sperren'),
      tone: an ? 'danger' : 'default',
    })
    if (!ok) return
    setSchaltet(true)
    try {
      status.setEinstellungen(await setzeKundenlisteFreigabe(an))
      toast.success(an
        ? t('crm.werbung.zielgruppen.kl.freigegeben', 'Kundenlisten freigegeben')
        : t('crm.werbung.zielgruppen.kl.gesperrtOk', 'Kundenlisten gesperrt'))
    } catch (err) {
      console.error('[Zielgruppen] Kundenliste freigeben:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setSchaltet(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 sm:mr-auto">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-800">
          {t('crm.werbung.zielgruppen.kl.freigabeTitel', 'Kundenlisten an Meta erlaubt')}
          <Badge tone={frei ? 'success' : 'neutral'} dot>{frei ? t('crm.werbung.zielgruppen.kl.an', 'An') : t('crm.werbung.zielgruppen.kl.aus', 'Aus')}</Badge>
        </p>
        <p className="mt-0.5 text-xs leading-snug text-gray-600">
          {t('crm.werbung.zielgruppen.kl.freigabeText', 'Werbe-Einstellung für das ganze Werbekonto. Einschalten nur Admin (Sven), sperren jeder mit Recht Werbemanager. Vorhandene Listen bleiben bei Meta bestehen.')}
        </p>
      </div>
      <button type="button" onClick={() => void schalten(!frei)} disabled={schaltet}
        className={`hp-btn ${frei ? 'hp-btn-ghost' : 'hp-btn-accent'} shrink-0 whitespace-nowrap`}>
        {schaltet && <Spinner size="sm" />}
        {frei
          ? t('crm.werbung.zielgruppen.kl.wiederSperren', 'Wieder sperren')
          : t('crm.werbung.zielgruppen.kl.freigebenKnopf', 'Kundenlisten freigeben (Admin)')}
      </button>
    </div>
  )
}
