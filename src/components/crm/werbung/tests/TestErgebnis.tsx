import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  TEST_KENNZAHLEN, TEST_KENNZAHL_NIEDRIGER_BESSER,
  type StudyGetResponse, type TestGewinner, type TestKennzahl, type TestZelle,
} from '../../../../lib/werbeSteuerung'
import Badge from '../../../ui/Badge'
import EmptyState from '../../../ui/EmptyState'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { EINGABE_KLEIN, Hinweis, MetaAenderungDialog, SchreibSperre } from '../zielgruppen/Bausteine'
import { steuerungCall, steuerungFehlerText } from './steuerungApi'
import { einstufungEtikett, eur, kennzahlLabel, testStatusEtikett, typLabel, zeitKurz } from './texte'
import { usePruefung } from './usePruefung'

// ── Ergebnis eines A/B-Tests (study_get) ─────────────────────────────────────
// Je Variante die Gewinner-Kennzahl als Balken, darunter Ausgaben, Leads,
// Termine, Kosten pro Lead und Termin, CTR und die Chance, die beste zu sein.
// Gewinner mit Einstufung (klar, Tendenz, offen, zu wenig Daten) und Quelle
// (Metas Konfidenz oder Schätzung von Happy Property). Die Kennzahl lässt sich
// zum Nachsehen umschalten (der Server rechnet neu). „Test jetzt beenden"
// setzt das Ende auf jetzt (study_beenden, vorher Prüfung mit vorschau: true);
// nichts wird gelöscht.

/** Gewinner in einem Satz (übersetzbar, aus den strukturierten Feldern) */
function gewinnerSatz(t: TFunction, g: TestGewinner): string {
  const p = g.sicherheit != null ? Math.round(g.sicherheit * 100) : null
  const k = kennzahlLabel(t, g.kennzahl)
  const name = g.zelle_name ?? ''
  switch (g.einstufung) {
    case 'klar':
      return t('crm.werbung.tests.ergebnis.satzKlar', '„{{name}}“ gewinnt bei {{k}} mit {{p}} % Sicherheit.', { name, k, p: p ?? '?' })
    case 'tendenz':
      return t('crm.werbung.tests.ergebnis.satzTendenz', '„{{name}}“ liegt bei {{k}} vorn, aber nur als Tendenz ({{p}} %). Noch etwas laufen lassen.', { name, k, p: p ?? '?' })
    case 'offen':
      return name
        ? t('crm.werbung.tests.ergebnis.satzOffen', 'Noch kein klarer Gewinner (höchstens {{p}} % für „{{name}}“). Test weiterlaufen lassen.', { name, p: p ?? '?' })
        : t('crm.werbung.tests.ergebnis.satzOffenLeer', 'Noch kein klarer Gewinner. Test weiterlaufen lassen.')
    default:
      return t('crm.werbung.tests.ergebnis.satzWenig', 'Noch zu wenig Daten für {{k}}. Meta braucht erst genug Ereignisse je Variante.', { k })
  }
}

export default function TestErgebnis({ id, onClose, onGeaendert, schreibSperre }: {
  id: string | null
  onClose: () => void
  onGeaendert: () => void
  schreibSperre: string | null
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const [detail, setDetail] = useState<StudyGetResponse | null>(null)
  const [kennzahlWahl, setKennzahlWahl] = useState<TestKennzahl | null>(null)
  const [laden, setLaden] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [beenden, setBeenden] = useState(false)
  const [busy, setBusy] = useState(false)

  const lade = useCallback(async (sid: string, kennzahl: TestKennzahl | null) => {
    setLaden(true)
    setFehler(null)
    try {
      setDetail(await steuerungCall('study_get', kennzahl ? { id: sid, kennzahl } : { id: sid }))
    } catch (err) {
      setFehler(steuerungFehlerText(err, t))
    } finally {
      setLaden(false)
    }
  }, [t])

  useEffect(() => {
    setDetail(null)
    setBeenden(false)
    setKennzahlWahl(null)
    if (id) void lade(id, null)
  }, [id, lade])

  const test = detail?.test
  const kennzahl = detail?.kennzahl ?? null
  const zellen = detail?.zellen ?? []
  const gewinner = detail?.gewinner ?? null
  const werte = zellen.map(z => z.kennzahl_wert ?? 0)
  const maxWert = Math.max(0, ...werte)
  const laeuft = test?.status === 'laeuft'

  const kennzahlText = (z: TestZelle): string => {
    const v = z.kennzahl_wert
    if (v == null) return '-'
    if (kennzahl === 'ctr') return `${v.toLocaleString(fmt.locale, { maximumFractionDigits: 2 })} %`
    return eur(fmt.locale, v)
  }

  // Prüfung durch den Server, sobald „Test beenden" offen ist
  const pruefung = usePruefung(!!id && beenden, async () => {
    if (!id) return { zeilen: [], hinweise: [] }
    const r = await steuerungCall('study_beenden', { id, vorschau: true })
    return { zeilen: [], hinweise: r.hinweise ?? [] }
  })

  const beendenAusfuehren = async () => {
    if (!id || busy || schreibSperre || pruefung.sperre) return
    setBusy(true)
    try {
      await steuerungCall('study_beenden', { id })
      toast.success(t('crm.werbung.tests.ergebnis.beendet', 'Test beendet. Die Anzeigen laufen ohne Aufteilung weiter.'))
      setBeenden(false)
      onGeaendert()
      void lade(id, kennzahlWahl)
    } catch (err) {
      toast.error(steuerungFehlerText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const status = test ? testStatusEtikett(t, test.status) : null
  const etikett = gewinner ? einstufungEtikett(t, gewinner.einstufung) : null

  return (
    <>
      <Modal open={!!id && !beenden} onClose={onClose} size="xl"
        title={test?.name ?? t('crm.werbung.tests.ergebnis.titel', 'Ergebnis des A/B-Tests')}
        footer={(
          <>
            {laeuft && (
              <button type="button" onClick={() => setBeenden(true)} disabled={!!schreibSperre || busy} className="hp-btn hp-btn-ghost sm:mr-auto">
                {t('crm.werbung.tests.ergebnis.beenden', 'Test jetzt beenden')}
              </button>
            )}
            <button type="button" onClick={() => id && void lade(id, kennzahlWahl)} disabled={laden} className="hp-btn hp-btn-ghost">
              {laden && <Spinner size="sm" />}
              {t('crm.werbung.tests.aktualisieren', 'Aktualisieren')}
            </button>
            <button type="button" onClick={onClose} className="hp-btn hp-btn-primary">{t('crm.werbung.tests.schliessen', 'Schließen')}</button>
          </>
        )}>
        {laden && !detail ? (
          <div className="flex justify-center py-12"><Spinner size="lg" /></div>
        ) : fehler && !detail ? (
          <EmptyState icon="alert" title={t('crm.werbung.tests.ergebnis.ladeFehler', 'Ergebnis konnte nicht geladen werden')} text={<span className="break-words">{fehler}</span>} />
        ) : detail && test ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
              {status && <Badge tone={status.ton} dot>{status.text}</Badge>}
              {!test.von_hp && <Badge tone="neutral">{t('crm.werbung.tests.ausMeta', 'In Meta angelegt')}</Badge>}
              <span>{typLabel(t, test.typ)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{zeitKurz(fmt.locale, test.start)} - {zeitKurz(fmt.locale, test.ende)}</span>
            </div>
            {test.beschreibung && <p className="text-sm text-gray-600">{test.beschreibung}</p>}
            {fehler && <Hinweis ton="fehler">{fehler}</Hinweis>}

            {/* Kennzahl umschalten */}
            <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
              {t('crm.werbung.tests.ergebnis.kennzahlWahl', 'Gewinner nach')}
              <select value={kennzahl ?? ''} disabled={laden}
                onChange={e => { const k = e.target.value as TestKennzahl; setKennzahlWahl(k); if (id) void lade(id, k) }}
                className={`${EINGABE_KLEIN} w-auto`}>
                {TEST_KENNZAHLEN.map(k => <option key={k} value={k}>{kennzahlLabel(t, k)}</option>)}
              </select>
              {kennzahl && (
                <span className="text-gray-500">
                  {TEST_KENNZAHL_NIEDRIGER_BESSER[kennzahl]
                    ? t('crm.werbung.tests.ergebnis.niedriger', 'Niedriger ist besser.')
                    : t('crm.werbung.tests.ergebnis.hoeher', 'Höher ist besser.')}
                </span>
              )}
              {laden && <Spinner size="sm" />}
            </label>

            {/* Gewinner */}
            {gewinner && etikett && (
              <Hinweis ton={gewinner.einstufung === 'klar' ? 'info' : 'warnung'}
                titel={gewinner.zelle_name && gewinner.einstufung !== 'zu_wenig_daten'
                  ? `${etikett.text}: ${gewinner.zelle_name}`
                  : etikett.text}>
                {gewinnerSatz(t, gewinner)}
                {gewinner.quelle && (
                  <span className="block pt-1 text-[11px] opacity-80">
                    {gewinner.quelle === 'meta'
                      ? t('crm.werbung.tests.ergebnis.quelleMeta', 'Sicherheit laut Meta.')
                      : t('crm.werbung.tests.ergebnis.quelleHp', 'Schätzung von Happy Property aus den Zahlen (Meta hat noch keine eigene Aussage).')}
                  </span>
                )}
              </Hinweis>
            )}

            {/* Varianten */}
            <ul className="space-y-2">
              {zellen.map(z => {
                const v = z.kennzahl_wert ?? 0
                const breite = maxWert > 0 ? Math.max(2, Math.round((v / maxWert) * 100)) : 0
                const vorn = z.ist_gewinner || (gewinner?.zelle_id === z.id && gewinner.einstufung !== 'zu_wenig_daten')
                const w = z.werte
                return (
                  <li key={z.id} className={`rounded-xl border p-3 ${vorn ? 'border-emerald-300 bg-emerald-50/40' : 'border-gray-200 bg-white'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-semibold text-gray-800">{z.name}</span>
                      {vorn && <Badge tone="success">{z.ist_gewinner ? t('crm.werbung.tests.ergebnis.gewinner', 'Gewinner') : t('crm.werbung.tests.ergebnis.vorn', 'Vorn')}</Badge>}
                      {z.anteil != null && <span className="text-xs text-gray-500">{t('crm.werbung.tests.ergebnis.anteil', '{{p}} % der Zielgruppe', { p: z.anteil })}</span>}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                        {/* Breite ist ein berechneter Wert: Inline-Stil unvermeidbar */}
                        <div className={`h-full rounded-full ${vorn ? 'bg-emerald-500' : 'bg-hp-navy/60'}`} style={{ width: `${breite}%` }} />
                      </div>
                      <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-800">{kennzahlText(z)}</span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-4 lg:grid-cols-7">
                      <div><dt className="text-gray-400">{t('crm.werbung.tests.ergebnis.ausgaben', 'Ausgaben')}</dt><dd className="tabular-nums">{eur(fmt.locale, w?.ausgaben_eur)}</dd></div>
                      <div><dt className="text-gray-400">{t('crm.werbung.tests.ergebnis.leads', 'Leads')}</dt><dd className="tabular-nums">{w ? fmt.int(w.leads) : '-'}</dd></div>
                      <div><dt className="text-gray-400">{t('crm.werbung.tests.ergebnis.kpl', 'Kosten pro Lead')}</dt><dd className="tabular-nums">{eur(fmt.locale, w?.kosten_pro_lead_eur)}</dd></div>
                      <div><dt className="text-gray-400">{t('crm.werbung.tests.ergebnis.termine', 'Termine (Meta)')}</dt><dd className="tabular-nums">{w ? fmt.int(w.termine) : '-'}</dd></div>
                      <div><dt className="text-gray-400">{t('crm.werbung.tests.ergebnis.impressionen', 'Impressionen')}</dt><dd className="tabular-nums">{w ? fmt.int(w.impressionen) : '-'}</dd></div>
                      <div><dt className="text-gray-400">{t('crm.werbung.tests.ergebnis.ctr', 'CTR')}</dt><dd className="tabular-nums">{w?.ctr != null ? `${w.ctr.toLocaleString(fmt.locale, { maximumFractionDigits: 2 })} %` : '-'}</dd></div>
                      <div>
                        <dt className="text-gray-400">{t('crm.werbung.tests.ergebnis.pBeste', 'Chance, die beste zu sein')}</dt>
                        <dd className="tabular-nums">{z.p_beste != null ? `${Math.round(z.p_beste * 100)} %` : '-'}</dd>
                      </div>
                    </dl>
                    {z.objekte.length > 0 && (
                      <p className="mt-1 truncate text-[11px] text-gray-400">{z.objekte.map(o => o.name ?? o.id).join(', ')}</p>
                    )}
                  </li>
                )
              })}
            </ul>
            {zellen.length === 0 && <EmptyState compact title={t('crm.werbung.tests.ergebnis.keineZellen', 'Meta liefert noch keine Varianten-Zahlen.')} />}

            <p className="text-xs text-gray-500">
              {detail.zeitraum
                ? t('crm.werbung.tests.ergebnis.zeitraum', 'Zahlen vom {{von}} bis {{bis}}.', { von: detail.zeitraum.since, bis: detail.zeitraum.until })
                : t('crm.werbung.tests.ergebnis.nochNicht', 'Der Test hat noch nicht begonnen.')}
              {' '}{t('crm.werbung.tests.ergebnis.qualitaet', 'Ob aus den Leads auch Termine im CRM werden, zeigt der Reiter Qualität.')}
            </p>
            {(detail.warnings ?? []).map((h, i) => <Hinweis key={i} ton="warnung">{h}</Hinweis>)}
            {laeuft && <SchreibSperre grund={schreibSperre} />}
          </div>
        ) : null}
      </Modal>

      <MetaAenderungDialog offen={!!id && beenden} onClose={() => setBeenden(false)} busy={busy} gesperrt={schreibSperre ?? pruefung.sperre}
        titel={t('crm.werbung.tests.ergebnis.beendenTitel', 'Test beenden: das ändert sich bei Meta')}
        punkte={[
          { art: 'achtung', text: t('crm.werbung.tests.ergebnis.pEnde', 'Der Test „{{name}}“ endet jetzt statt am {{ende}}.', { name: test?.name ?? '', ende: zeitKurz(fmt.locale, test?.ende) }) },
          { art: 'gleich', text: t('crm.werbung.tests.ergebnis.pWeiter', 'Die Anzeigen bleiben, wie sie sind, und laufen ohne Aufteilung weiter. Nichts wird gelöscht.') },
        ]}
        lernphase={t('crm.werbung.tests.ergebnis.lernphase', 'Startet nicht neu: an den Anzeigen ändert sich nichts.')}
        warnungen={gewinner && gewinner.einstufung !== 'klar' ? [t('crm.werbung.tests.ergebnis.warnOhne', 'Es gibt noch keinen klaren Gewinner. Ein früh beendeter Test sagt wenig aus.')] : []}
        bestaetigen={t('crm.werbung.tests.ergebnis.beendenJa', 'Test beenden')}
        onBestaetigen={() => void beendenAusfuehren()}
        zusatz={pruefung.box} />
    </>
  )
}
