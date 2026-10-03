import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import { KOMMENTAR_PLATTFORM_LABEL, type Kommentar } from '../../../../lib/werbeKonto'
import { useWerbeFormat } from '../format'
import KommentarEintrag from './KommentarEintrag'
import type { BeitragGruppe } from './kommentareApi'

// ── Kommentare einer Anzeige (bzw. eines Beitrags, den mehrere Anzeigen teilen)
// Kopf: Anzeigenname(n), Plattform, offene Kommentare, Link zum Beitrag.
// Ab 5 Kommentaren eingeklappt bis auf die neuesten drei.

const SICHTBAR = 3

export default function BeitragKarte({ g, schreibSperre, onAenderung }: {
  g: BeitragGruppe
  schreibSperre: string | null
  onAenderung: (neu: Kommentar) => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [alle, setAlle] = useState(false)
  const erste = g.anzeigen[0]
  const weitere = g.anzeigen.length - 1
  const zeigen = alle || g.kommentare.length <= SICHTBAR + 1 ? g.kommentare : g.kommentare.slice(0, SICHTBAR)

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <header className="flex flex-col gap-1.5 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-start">
        <div className="min-w-0 sm:mr-auto">
          <h3 className="truncate font-heading text-base text-hp-navy" title={g.anzeigen.map(a => a.name).join(', ')}>
            {erste?.name ?? t('crm.werbung.kommentare.ohneName', 'Anzeige ohne Namen')}
          </h3>
          <p className="text-xs text-gray-500">
            {weitere > 0
              ? t('crm.werbung.kommentare.weitereAnzeigen', 'Beitrag wird auch von {{n}} weiteren Anzeigen genutzt: {{namen}}', { n: weitere, namen: g.anzeigen.slice(1, 4).map(a => a.name).join(', ') })
              : t('crm.werbung.kommentare.kommentareN', '{{n}} Kommentare', { n: fmt.int(g.kommentare.length) })}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone={g.plattform === 'instagram' ? 'info' : 'neutral'}>{KOMMENTAR_PLATTFORM_LABEL[g.plattform]}</Badge>
          {g.offen > 0
            ? <Badge tone="warning" dot>{t('crm.werbung.kommentare.offenN', '{{n}} offen', { n: g.offen })}</Badge>
            : <Badge tone="success">{t('crm.werbung.kommentare.alleBeantwortet', 'Alles beantwortet')}</Badge>}
          {g.link && (
            <a href={g.link} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-hp-navy underline-offset-2 hover:underline">
              {t('crm.werbung.kommentare.beitragOeffnen', 'Beitrag öffnen')} ↗
            </a>
          )}
        </div>
      </header>
      {g.fehler && <p className="border-b border-gray-100 bg-amber-50 px-4 py-2 text-xs text-amber-900">{g.fehler}</p>}
      <ul className="divide-y divide-gray-100 px-4">
        {zeigen.map(k => <KommentarEintrag key={k.id} k={k} schreibSperre={schreibSperre} onAenderung={onAenderung} />)}
      </ul>
      {(zeigen.length < g.kommentare.length || g.gekuerzt) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-2">
          {zeigen.length < g.kommentare.length && (
            <button type="button" onClick={() => setAlle(true)} className="text-xs font-semibold text-hp-navy underline-offset-2 hover:underline">
              {t('crm.werbung.kommentare.alleZeigen', 'Alle {{n}} Kommentare zeigen', { n: g.kommentare.length })}
            </button>
          )}
          {g.gekuerzt && <span className="text-[11px] text-gray-500">{t('crm.werbung.kommentare.gekuerztBeitrag', 'Bei Meta gibt es noch ältere Kommentare.')}</span>}
        </div>
      )}
    </section>
  )
}
