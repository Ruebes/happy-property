import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import { EINGABE_KLEIN } from '../zielgruppen/Bausteine'
import { useWerbeFormat } from '../format'
import type { WahlObjekt } from './objekte'

// ── Auswahl von Kampagnen, Anzeigengruppen oder Anzeigen (Häkchen-Liste) ─────
// Suchfeld, Schalter „nur aktive", Höchstzahl. Auf dem Telefon eine Spalte,
// die Liste scrollt in sich (höchstens rund 18 Zeilen hoch).

export default function ObjektWahl({ objekte, gewaehlt, onChange, max, leerText }: {
  objekte: WahlObjekt[]
  gewaehlt: string[]
  onChange: (ids: string[]) => void
  /** Höchstzahl wählbarer Objekte */
  max?: number
  leerText?: string
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [suche, setSuche] = useState('')
  const [nurAktive, setNurAktive] = useState(true)

  const sichtbar = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return objekte
      .filter(o => !nurAktive || o.aktiv || gewaehlt.includes(o.id))
      .filter(o => !q || o.name.toLowerCase().includes(q) || o.id.includes(q) || (o.oben ?? '').toLowerCase().includes(q))
      .slice(0, 200)
  }, [objekte, suche, nurAktive, gewaehlt])

  const voll = max != null && gewaehlt.length >= max
  const umschalten = (id: string) => {
    if (gewaehlt.includes(id)) onChange(gewaehlt.filter(x => x !== id))
    else if (!voll) onChange([...gewaehlt, id])
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input value={suche} onChange={e => setSuche(e.target.value)} className={`${EINGABE_KLEIN} sm:max-w-xs`}
          placeholder={t('crm.werbung.tests.wahl.suche', 'Name oder ID suchen …')} aria-label={t('crm.werbung.tests.wahl.suche', 'Name oder ID suchen …')} />
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={nurAktive} onChange={e => setNurAktive(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-hp-navy" />
          {t('crm.werbung.tests.wahl.nurAktive', 'Nur aktive')}
        </label>
        <span className="text-xs text-gray-500 sm:ml-auto">
          {max != null
            ? t('crm.werbung.tests.wahl.gewaehltMax', '{{n}} von höchstens {{max}} gewählt', { n: gewaehlt.length, max })
            : t('crm.werbung.tests.wahl.gewaehlt', '{{n}} gewählt', { n: gewaehlt.length })}
        </span>
      </div>
      <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200 bg-white">
        {sichtbar.length === 0 && (
          <li className="px-3 py-4 text-center text-xs text-gray-500">{leerText ?? t('crm.werbung.tests.wahl.leer', 'Nichts gefunden. Schalte „Nur aktive“ aus oder ändere die Suche.')}</li>
        )}
        {sichtbar.map(o => {
          const an = gewaehlt.includes(o.id)
          const gesperrt = !an && voll
          return (
            <li key={o.id}>
              <label className={`flex items-start gap-2 px-3 py-2 text-sm ${gesperrt ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-hp-cream/60'}`}>
                <input type="checkbox" checked={an} disabled={gesperrt} onChange={() => umschalten(o.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-hp-navy focus:ring-hp-navy/40" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium text-gray-800">{o.name}</span>
                    {o.aktiv
                      ? <Badge tone="success" dot>{t('crm.werbung.tests.wahl.aktiv', 'Aktiv')}</Badge>
                      : <Badge tone="neutral">{t('crm.werbung.tests.wahl.aus', 'Aus')}</Badge>}
                  </span>
                  {o.oben && <span className="block truncate text-[11px] text-gray-500">{o.oben}</span>}
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-500">{fmt.eur(o.ausgabenEur)}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
