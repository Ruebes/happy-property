import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RegelUebersicht, RuleHistoryResponse } from '../../../../lib/werbeSteuerung'
import Badge from '../../../ui/Badge'
import EmptyState from '../../../ui/EmptyState'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useWerbeFormat } from '../format'
import { useWerbeKontext } from '../useWerbeDaten'
import { Haken, Hinweis } from '../zielgruppen/Bausteine'
import { steuerungCall, steuerungFehlerText } from './steuerungApi'
import { ebeneLabel, verlaufAktionLabel, zeitKurz } from './texte'

// ── Verlauf der Meta-Regeln (rule_history) ───────────────────────────────────
// Wann eine Regel (oder alle Regeln des Werbekontos) gegriffen hat, bei
// welchem Objekt und was sie getan hat (alt → neu). Objektnamen aus dem
// Anzeigen-Katalog der Seite, wenn Meta nur die ID nennt. Standard: nur Läufe
// mit Änderung; der Haken zeigt auch Läufe ohne Änderung.

export default function RegelVerlauf({ regel, onClose }: { regel: RegelUebersicht | 'alle' | null; onClose: () => void }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const { catalog } = useWerbeKontext()
  const [daten, setDaten] = useState<RuleHistoryResponse | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [laden, setLaden] = useState(false)
  const [alleLaeufe, setAlleLaeufe] = useState(false)
  const id = regel === 'alle' ? 'alle' : regel?.id ?? null

  useEffect(() => {
    if (!id) return
    let lebt = true
    setDaten(null)
    setFehler(null)
    setLaden(true)
    steuerungCall('rule_history', {
      ...(id !== 'alle' ? { id } : {}),
      nur_mit_aenderungen: !alleLaeufe,
      limit: 100,
    })
      .then(r => { if (lebt) setDaten(r) })
      .catch(err => { if (lebt) setFehler(steuerungFehlerText(err, t)) })
      .finally(() => { if (lebt) setLaden(false) })
    return () => { lebt = false }
  }, [id, alleLaeufe, t])

  useEffect(() => { if (!regel) setAlleLaeufe(false) }, [regel])

  const nameVon = (objektId: string, name: string | null): string => {
    if (name) return name
    const a = catalog.find(c => c.ad_id === objektId || c.adset_id === objektId || c.campaign_id === objektId)
    if (!a) return objektId
    return (a.ad_id === objektId ? a.ad_name : a.adset_id === objektId ? a.adset_name : a.campaign_name) ?? objektId
  }

  const eintraege = daten?.items ?? []
  const titel = regel === 'alle'
    ? t('crm.werbung.regeln.verlauf.titelAlle', 'Verlauf aller Regeln')
    : t('crm.werbung.regeln.verlauf.titel', 'Verlauf: {{name}}', { name: regel?.name ?? '' })

  return (
    <Modal open={!!regel} onClose={onClose} size="lg" title={titel}
      footer={<button type="button" onClick={onClose} className="hp-btn hp-btn-primary">{t('crm.werbung.tests.schliessen', 'Schließen')}</button>}>
      <div className="space-y-3">
        <Haken checked={alleLaeufe} onChange={setAlleLaeufe} label={t('crm.werbung.regeln.verlauf.ohneAenderung', 'Auch Läufe ohne Änderung zeigen')} />
        {laden ? (
          <div className="flex justify-center py-10"><Spinner size="lg" /></div>
        ) : fehler ? (
          <EmptyState icon="alert" title={t('crm.werbung.regeln.verlauf.fehler', 'Verlauf konnte nicht geladen werden')} text={<span className="break-words">{fehler}</span>} />
        ) : eintraege.length === 0 ? (
          <EmptyState icon="clock" title={t('crm.werbung.regeln.verlauf.leer', 'Noch nichts passiert')}
            text={t('crm.werbung.regeln.verlauf.leerText', 'Sobald eine Regel greift, steht hier, was Meta getan hat.')} />
        ) : (
          <>
            {(daten?.warnings ?? []).map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}
            <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
              {eintraege.map((e, i) => (
                <li key={i} className="space-y-1 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs tabular-nums text-gray-500">{zeitKurz(fmt.locale, e.zeit)}</span>
                    {regel === 'alle' && e.regel_name && <span className="truncate text-xs font-semibold text-gray-700">{e.regel_name}</span>}
                    {e.manuell && <Badge tone="neutral">{t('crm.werbung.regeln.verlauf.manuell', 'Von Hand ausgelöst')}</Badge>}
                    {e.fehler && <Badge tone="danger">{t('crm.werbung.regeln.verlauf.fehlerBadge', 'Fehler')}</Badge>}
                  </div>
                  {e.fehler?.text && <p className="text-xs text-red-700">{e.fehler.text}</p>}
                  {e.objekte.length === 0 && !e.fehler && (
                    <p className="text-xs text-gray-500">{t('crm.werbung.regeln.verlauf.keinObjekt', 'Kein Objekt betroffen.')}</p>
                  )}
                  {e.objekte.map(o => (
                    <div key={o.objekt_id} className="min-w-0">
                      <span className="block truncate font-medium text-gray-800">
                        {nameVon(o.objekt_id, o.objekt_name)}
                        {o.objekt_typ && <span className="ml-1 text-[11px] font-normal text-gray-400">{ebeneLabel(t, o.objekt_typ, false)}</span>}
                      </span>
                      <ul className="text-xs text-gray-600">
                        {o.aktionen.map((a, j) => (
                          <li key={j}>
                            {verlaufAktionLabel(t, a.aktion, a.aktion_label)}
                            {(a.alt != null || a.neu != null) && <span className="tabular-nums text-gray-500">: {a.alt ?? '-'} → {a.neu ?? '-'}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
