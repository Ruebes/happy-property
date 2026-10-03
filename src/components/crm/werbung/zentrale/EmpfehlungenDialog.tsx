import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import EmptyState from '../../../ui/EmptyState'
import Badge from '../../../ui/Badge'
import { useWerbeFormat } from '../format'
import { berichteFehlerText, ladeEmpfehlungen } from './berichteApi'
import type { EmpfehlungenAntwort } from './typen'

// ── Empfehlungen von Meta (Potenzialbewertung, nur lesen) ────────────────────
// Ein Abruf beim Öffnen (meta-berichte empfehlungen, Zwischenspeicher auf dem
// Server). Das CRM wendet nichts an: jede Empfehlung zeigt Metas Text, die
// Einordnung nach Happy-Property-Regeln und den Link in den Werbeanzeigenmanager.

interface Props {
  offen: boolean
  onClose: () => void
  /** Name einer Kampagne/Anzeigengruppe/Anzeige zur ID (null = unbekannt) */
  nameVon: (id: string) => string | null
}

export default function EmpfehlungenDialog({ offen, onClose, nameVon }: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [daten, setDaten] = useState<EmpfehlungenAntwort | null>(null)
  const [laedt, setLaedt] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const lauf = useRef(0)

  const laden = useCallback(async (frisch = false) => {
    const nr = ++lauf.current
    setLaedt(true)
    setFehler(null)
    try {
      const d = await ladeEmpfehlungen(frisch)
      if (nr === lauf.current) setDaten(d)
    } catch (err) {
      if (nr === lauf.current) setFehler(berichteFehlerText(err, t))
    } finally {
      if (nr === lauf.current) setLaedt(false)
    }
  }, [t])

  useEffect(() => { if (offen) void laden() }, [offen, laden])
  useEffect(() => { if (!offen) { lauf.current++; setLaedt(false) } }, [offen])

  // Nach Kategorie der Potenzialbewertung gruppiert, meiste Punkte zuerst
  const gruppen = useMemo(() => {
    const m = new Map<string, EmpfehlungenAntwort['items']>()
    for (const e of daten?.items ?? []) {
      const arr = m.get(e.kategorie) ?? []
      arr.push(e)
      m.set(e.kategorie, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => (b.punkte ?? 0) - (a.punkte ?? 0))
    return [...m.entries()]
  }, [daten])

  const objekte = (ids: string[]): string => {
    const namen = ids.slice(0, 3).map(id => nameVon(id) ?? id)
    return ids.length > 3 ? `${namen.join(', ')} ${t('crm.werbung.zentrale.schalten.weitere', 'und {{n}} weitere', { n: ids.length - 3 })}` : namen.join(', ')
  }

  return (
    <Modal open={offen} onClose={onClose} size="lg" title={t('crm.werbung.zentrale.empfehlungen.titel', 'Empfehlungen von Meta')}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          {t('crm.werbung.zentrale.empfehlungen.intro', 'Metas Vorschläge und die Potenzialbewertung des Kontos. Das CRM ändert hier nichts; umsetzen nur nach eigener Prüfung.')}
          {daten && !laedt && (
            <>
              {daten.fetched_at && <> · {t('crm.werbung.zentrale.stand', 'Stand {{zeit}}', { zeit: new Date(daten.fetched_at).toLocaleString(fmt.locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })}</>}
              {daten.cached && <> · {t('crm.werbung.zentrale.zwischenspeicher', 'aus dem Zwischenspeicher')}</>}
              {' · '}<button type="button" className="underline" onClick={() => void laden(true)}>{t('crm.werbung.zentrale.meta.neu', 'Neu laden')}</button>
            </>
          )}
        </p>

        {laedt && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
            <Spinner size="sm" /> {t('crm.werbung.zentrale.empfehlungen.laedt', 'Hole die Empfehlungen …')}
          </div>
        )}
        {fehler && !laedt && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex flex-wrap items-center gap-2">
            <span className="flex-1 min-w-0">{fehler}</span>
            <button type="button" className="hp-btn hp-btn-ghost text-xs" onClick={() => void laden()}>
              {t('crm.werbung.zentrale.nochmal', 'Erneut versuchen')}
            </button>
          </div>
        )}

        {daten && !laedt && !fehler && (
          <>
            <div className="flex flex-wrap items-baseline gap-2 rounded-xl border border-gray-200 px-3 py-2">
              <span className="text-xs text-gray-500">{t('crm.werbung.zentrale.empfehlungen.score', 'Potenzialbewertung')}</span>
              <span className="text-lg font-bold text-gray-900 tabular-nums">
                {daten.opportunity_score == null ? '-' : `${fmt.int(daten.opportunity_score)} / 100`}
              </span>
              {daten.opportunity_score == null && (
                <span className="text-[11px] text-gray-400">{t('crm.werbung.zentrale.empfehlungen.keinScore', 'Meta liefert für dieses Konto gerade keine Bewertung.')}</span>
              )}
            </div>
            {(daten.veraltet || daten.hinweise.length > 0) && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 space-y-0.5">
                {daten.veraltet && <p>{t('crm.werbung.zentrale.meta.veraltet', 'Meta bremst gerade, angezeigt wird ein älterer Stand aus dem Zwischenspeicher.')}</p>}
                {daten.hinweise.slice(0, 5).map(h => <p key={h}>{h}</p>)}
              </div>
            )}
            {gruppen.length === 0 && (
              <EmptyState compact icon="check" title={t('crm.werbung.zentrale.empfehlungen.leer', 'Keine Empfehlungen von Meta')} />
            )}
            {gruppen.map(([kategorie, liste]) => (
              <section key={kategorie} className="space-y-2">
                <h3 className="text-xs font-semibold text-gray-600">{kategorie}</h3>
                <ul className="space-y-2">
                  {liste.map((e, i) => (
                    <li key={e.signatur ?? `${e.typ}-${i}`} className="rounded-xl border border-gray-200 px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-semibold text-gray-800">{e.titel}</span>
                        {e.punkte != null && <Badge tone="info">{t('crm.werbung.zentrale.empfehlungen.punkte', '+{{n}} Punkte', { n: fmt.int(e.punkte) })}</Badge>}
                        {e.lift_estimate && <span className="text-[11px] text-gray-500">{e.lift_estimate}</span>}
                      </div>
                      {e.text && <p className="text-xs text-gray-600 break-words mt-0.5">{e.text}</p>}
                      {e.object_ids.length > 0 && (
                        <p className="text-[11px] text-gray-400 break-words mt-0.5">
                          {t('crm.werbung.zentrale.empfehlungen.betrifft', 'Betrifft: {{was}}', { was: objekte(e.object_ids) })}
                        </p>
                      )}
                      {e.hp_hinweis && (
                        <p className="mt-1 rounded-lg bg-amber-50 border border-amber-200 px-2 py-1 text-[11px] text-amber-900">
                          {t('crm.werbung.zentrale.empfehlungen.hp', 'Happy Property:')} {e.hp_hinweis}
                        </p>
                      )}
                      {e.url && (
                        <a href={e.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-hp-navy underline">
                          {t('crm.werbung.zentrale.empfehlungen.oeffnen', 'Im Werbeanzeigenmanager ansehen')}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </Modal>
  )
}
