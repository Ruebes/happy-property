import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { Hinweis } from './Bausteine'
import { artLabel, groesseText, wohnenEtikett } from './useWerkzeugStatus'
import type { ZielgruppeZeile } from './werkzeugeApi'

// ── Details einer Zielgruppe ─────────────────────────────────────────────────
// Nur lesen. Löschen gibt es bewusst nicht (Svens Regel: bei Meta nie löschen).

function Zeile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-xs font-semibold text-gray-500">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-gray-800">{children}</dd>
    </div>
  )
}

export default function ZielgruppeDetail({ zielgruppe, onClose, onLookalike, onPruefen, prueft, quelleName }: {
  zielgruppe: ZielgruppeZeile | null
  onClose: () => void
  onLookalike: (z: ZielgruppeZeile) => void
  onPruefen: (z: ZielgruppeZeile) => void
  prueft: boolean
  quelleName: string | null
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const z = zielgruppe
  if (!z) return null
  const wohnen = wohnenEtikett(t, z)
  const istLookalike = z.art === 'lookalike'

  const kopieren = async () => {
    try {
      await navigator.clipboard.writeText(z.id)
      toast.success(t('crm.werbung.zielgruppen.detail.kopiert', 'ID kopiert'))
    } catch {
      toast.info(z.id)
    }
  }

  return (
    <Modal open onClose={onClose} size="md" title={z.name}
      footer={(
        <>
          <button type="button" onClick={() => void kopieren()} className="hp-btn hp-btn-ghost sm:mr-auto">{t('crm.werbung.zielgruppen.detail.idKopieren', 'ID kopieren')}</button>
          {!istLookalike && (
            <button type="button" onClick={() => onLookalike(z)} className="hp-btn hp-btn-ghost">
              {t('crm.werbung.zielgruppen.detail.lookalike', 'Lookalike daraus')}
            </button>
          )}
          <button type="button" onClick={onClose} className="hp-btn hp-btn-primary">{t('crm.werbung.zielgruppen.schliessen', 'Schließen')}</button>
        </>
      )}>
      <dl className="divide-y divide-gray-100">
        <Zeile label={t('crm.werbung.zielgruppen.spalte.art', 'Art')}>{artLabel(t, z.art)}{z.subtype ? <span className="ml-1 text-xs text-gray-400">({z.subtype})</span> : null}</Zeile>
        <Zeile label={t('crm.werbung.zielgruppen.spalte.groesse', 'Größe')}>{groesseText(t, fmt.locale, z)}</Zeile>
        <Zeile label={t('crm.werbung.zielgruppen.spalte.aufbewahrung', 'Aufbewahrung')}>
          {z.aufbewahrungTage != null ? t('crm.werbung.zielgruppen.tageN', '{{n}} Tage', { n: z.aufbewahrungTage }) : '-'}
        </Zeile>
        {z.regelText && <Zeile label={t('crm.werbung.zielgruppen.detail.regel', 'Regel')}>{z.regelText}</Zeile>}
        {istLookalike && <Zeile label={t('crm.werbung.zielgruppen.detail.ursprung', 'Ursprung')}>{quelleName ?? z.quelleId ?? '-'}</Zeile>}
        <Zeile label={t('crm.werbung.zielgruppen.spalte.wohnen', 'Wohnen')}>
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={wohnen.ton} dot>{wohnen.text}</Badge>
            {!istLookalike && (
              <button type="button" onClick={() => onPruefen(z)} disabled={prueft} className="text-xs font-semibold text-hp-navy underline disabled:opacity-60">
                {prueft && <Spinner size="sm" />} {t('crm.werbung.zielgruppen.detail.pruefen', 'Jetzt prüfen')}
              </button>
            )}
          </span>
          {z.wohnenGrund && <span className="mt-1 block text-xs text-gray-500">{z.wohnenGrund}</span>}
        </Zeile>
        {z.status && <Zeile label={t('crm.werbung.zielgruppen.detail.status', 'Status bei Meta')}>{z.status}</Zeile>}
        {z.erstellt && <Zeile label={t('crm.werbung.zielgruppen.detail.erstellt', 'Angelegt')}>{new Date(z.erstellt).toLocaleString(fmt.locale)}</Zeile>}
        {z.beschreibung && <Zeile label={t('crm.werbung.zielgruppen.detail.beschreibung', 'Beschreibung')}>{z.beschreibung}</Zeile>}
        <Zeile label="ID"><span className="font-mono text-xs">{z.id}</span></Zeile>
      </dl>
      <div className="mt-3 space-y-2">
        {istLookalike ? (
          <Hinweis ton="sperre">{t('crm.werbung.zielgruppen.detail.lookalikeWohnen', 'Lookalikes lassen sich in Wohnen-Kampagnen weder einschließen noch ausschließen.')}</Hinweis>
        ) : (
          <Hinweis>{t('crm.werbung.zielgruppen.detail.einsetzen', 'Einsetzen: im Kampagnen-Assistenten unter Anzeigengruppe, Zielgruppe (einschließen oder ausschließen).')}</Hinweis>
        )}
        <p className="text-[11px] text-gray-400">{t('crm.werbung.zielgruppen.detail.nieLoeschen', 'Zielgruppen werden hier nie gelöscht. Nicht mehr gebrauchte einfach nicht mehr einsetzen.')}</p>
      </div>
    </Modal>
  )
}
