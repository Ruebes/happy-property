import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import {
  CUSTOM_CONVERSIONS_MAX, CUSTOM_EVENT_TYPE_LABEL, type CustomConversionsListResponse, type CustomConversionVorschlag, type CustomEventType,
} from '../../../../lib/werbeWerkzeuge'
import { useWerbeFormat } from '../format'
import { Hinweis, SchreibSperre } from '../zielgruppen/Bausteine'
import Karte, { AktualisierenKnopf, KartenFehler } from './Karte'
import { ereignisLabel, messFehlerText, relativeZeit } from './messungApi'
import NeueConversionDialog from './NeueConversionDialog'
import type { Lader } from './useLader'

// ── Karte „Eigene Conversions" ───────────────────────────────────────────────
// Benutzerdefinierte Conversions des Werbekontos (Liste aus meta-werkzeuge
// custom_conversions_list) mit HP-Vorschlägen, die es noch nicht gibt, und
// „Neu anlegen" (Prüfen, dann „Das ändert sich bei Meta"). Nie löschen.

const kategorieText = (k: string | null): string => (k && k in CUSTOM_EVENT_TYPE_LABEL ? CUSTOM_EVENT_TYPE_LABEL[k as CustomEventType] : k ?? '-')

export default function EigeneConversionsKarte({ lader, schreibSperre, pruefSperre }: {
  lader: Lader<CustomConversionsListResponse>
  schreibSperre: string | null
  pruefSperre: string | null
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [dialog, setDialog] = useState<{ vorschlag: CustomConversionVorschlag | null } | null>(null)
  const [mitArchiv, setMitArchiv] = useState(false)
  const d = lader.daten
  const max = d?.max ?? CUSTOM_CONVERSIONS_MAX
  const zeilen = (d?.items ?? []).filter(c => mitArchiv || !c.archiviert)
  const archiviert = (d?.items ?? []).filter(c => c.archiviert).length
  const vorschlaege = d?.vorschlaege ?? []

  return (
    <Karte id="messung-conversions"
      titel={t('crm.werbung.messung.conv.titel', 'Eigene Conversions')}
      erklaerung={t('crm.werbung.messung.conv.erklaerung', 'Eigene Ziele für die Optimierung, z. B. nur Termine oder nur gute Leads. Wählbar in der Anzeigengruppe unter Conversion-Ereignis.')}
      laedt={lader.laedt}
      aktionen={(
        <>
          <AktualisierenKnopf onClick={() => void lader.neu()} laedt={lader.laedt} />
          <button type="button" onClick={() => setDialog({ vorschlag: null })} disabled={!!pruefSperre} className="hp-btn hp-btn-primary min-h-0 px-3 py-1 text-xs">
            + {t('crm.werbung.messung.conv.neu', 'Neue Conversion')}
          </button>
        </>
      )}
      alle={(
        <div className="space-y-2 text-xs leading-snug text-gray-600">
          <p>{t('crm.werbung.messung.conv.regel', 'Meta erlaubt höchstens {{max}} eigene Conversions je Werbekonto. Die Regel lässt sich nach dem Anlegen nicht mehr ändern, nur Name und Wert.', { max })}</p>
          <p>{t('crm.werbung.messung.conv.capi', 'Ereignisse wie „Termin stattgefunden" oder „guter Lead" kommen nur über die Conversions API aus dem CRM (Karte „Ereignisse aus dem CRM").')}</p>
          {archiviert > 0 && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={mitArchiv} onChange={e => setMitArchiv(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-hp-navy" />
              {t('crm.werbung.messung.conv.archivZeigen', 'Archivierte zeigen ({{n}})', { n: archiviert })}
            </label>
          )}
        </div>
      )}>
      <SchreibSperre grund={schreibSperre} />
      {lader.fehler != null && !d ? (
        <KartenFehler text={messFehlerText(lader.fehler, t)} onNochmal={() => void lader.neu()} />
      ) : !d ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1].map(i => <div key={i} className="h-10 animate-pulse rounded-lg bg-gray-100" />)}
        </div>
      ) : (
        <>
          {vorschlaege.length > 0 && (
            <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2">
              <p className="text-xs font-semibold text-emerald-900">{t('crm.werbung.messung.conv.vorschlaege', 'Empfohlen für Happy Property, fehlt noch:')}</p>
              <ul className="mt-1.5 space-y-1.5">
                {vorschlaege.map(v => (
                  <li key={v.name} className="flex flex-col gap-1 sm:flex-row sm:items-center">
                    <span className="min-w-0 flex-1 text-xs text-gray-700">
                      <span className="font-semibold text-gray-800">{v.name}</span>
                      <span className="block text-gray-600">{t(`crm.werbung.messung.conv.vorschlag.${v.ereignis}`, v.erklaerung)}</span>
                    </span>
                    <button type="button" onClick={() => setDialog({ vorschlag: v })} disabled={!!pruefSperre}
                      className="hp-btn hp-btn-ghost min-h-0 shrink-0 px-3 py-1 text-xs">
                      {t('crm.werbung.messung.conv.uebernehmen', 'Übernehmen')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {zeilen.length === 0 ? (
            <p className="text-xs text-gray-500">{t('crm.werbung.messung.conv.leer', 'Noch keine eigenen Conversions im Werbekonto.')}</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {zeilen.map(c => (
                <li key={c.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-800">{c.name}</p>
                    <p className="truncate text-[11px] text-gray-500">
                      {c.ereignis ? ereignisLabel(t, c.ereignis) : c.regel_zusammenfassung}
                      {c.ereignis && c.regel_zusammenfassung ? ` · ${c.regel_zusammenfassung}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                    <Badge tone="neutral">{t(`crm.werbung.messung.conv.kategorie.${c.kategorie ?? 'OTHER'}`, kategorieText(c.kategorie))}</Badge>
                    {c.standardwert != null && <span className="tabular-nums">{t('crm.werbung.messung.conv.wertKurz', 'Wert {{wert}}', { wert: c.standardwert.toLocaleString(fmt.locale) })}</span>}
                    <span>{c.letzte_aktivitaet
                      ? t('crm.werbung.messung.conv.zuletzt', 'zuletzt {{zeit}}', { zeit: relativeZeit(c.letzte_aktivitaet, fmt.locale) })
                      : t('crm.werbung.messung.conv.nieAktiv', 'noch nie ausgelöst')}</span>
                    {c.archiviert && <Badge tone="neutral">{t('crm.werbung.messung.conv.archiviert', 'Archiviert')}</Badge>}
                    {c.nicht_verfuegbar && <Badge tone="danger">{t('crm.werbung.messung.conv.nichtVerfuegbar', 'Nicht verfügbar')}</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-gray-500">{t('crm.werbung.messung.conv.zaehler', '{{n}} von {{max}} möglichen Conversions belegt.', { n: d.anzahl_aktiv, max })}</p>
          {d.warnings.map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}
        </>
      )}
      <NeueConversionDialog offen={!!dialog} vorschlag={dialog?.vorschlag ?? null} schreibSperre={schreibSperre} pruefSperre={pruefSperre}
        anzahlAktiv={d?.anzahl_aktiv ?? null} max={max} onClose={() => setDialog(null)} onFertig={() => void lader.neu()} />
    </Karte>
  )
}
