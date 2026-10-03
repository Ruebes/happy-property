import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import type { CapiEreignisStatistik, PixelDiagnoseCrm } from '../../../../lib/werbeWerkzeuge'
import { useWerbeFormat } from '../format'
import { Hinweis } from '../zielgruppen/Bausteine'
import Karte, { AktualisierenKnopf, KartenFehler, Kennzahl } from './Karte'
import { ereignisLabel, grundLabel, messFehlerText, relativeZeit, type DiagnoseSicht } from './messungApi'
import type { Ampel, MessEinstellungen } from './typen'
import type { Lader } from './useLader'

// ── Karte „Ereignisse aus dem CRM" ───────────────────────────────────────────
// Was das CRM über die Conversions API an Meta meldet: Termin gebucht, Termin
// stattgefunden, guter Lead, Abschluss (Lead nur, wenn vorhanden). Je Ereignis
// gesendet in 7 und 30 Tagen (capi_log, inkl. Tageslauf), offen, übersprungen
// mit Grund und Fehler (30 Tage). Quelle: pixel_diagnose.crm; die
// Conversion-Leads-Stufen stehen in einer eigenen Karte.

/** Tabellenkopf für Ereignis- und Stufen-Zahlen */
export function ZahlenKopf({ erste }: { erste: string }) {
  const { t } = useTranslation()
  return (
    <thead>
      <tr className="border-b border-gray-100 text-left text-[11px] text-gray-500">
        <th scope="col" className="px-2 py-1.5 font-medium">{erste}</th>
        <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('crm.werbung.messung.crm.gesendet7', 'Gesendet 7 T.')}</th>
        <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('crm.werbung.messung.crm.gesendet30', 'Gesendet 30 T.')}</th>
        <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('crm.werbung.messung.crm.offen', 'Offen')}</th>
        <th scope="col" className="hidden px-2 py-1.5 text-right font-medium sm:table-cell">{t('crm.werbung.messung.crm.uebersprungen', 'Übersprungen')}</th>
        <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('crm.werbung.messung.crm.fehler', 'Fehler')}</th>
        <th scope="col" className="hidden px-2 py-1.5 text-right font-medium md:table-cell">{t('crm.werbung.messung.crm.zuletzt', 'Zuletzt gesendet')}</th>
      </tr>
    </thead>
  )
}

/** Zahlenzellen einer Zeile (Gründe fürs Überspringen als Tooltip) */
export function ZahlenZellen({ z }: { z: CapiEreignisStatistik }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const gruende = z.gruende.map(g => `${grundLabel(t, g.grund)}: ${g.anzahl}`).join('\n')
  return (
    <>
      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700">{fmt.int(z.gesendet_7d)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700">{fmt.int(z.gesendet_30d)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{z.offen ? fmt.int(z.offen) : '-'}</td>
      <td className="hidden px-2 py-1.5 text-right tabular-nums text-gray-500 sm:table-cell" title={gruende || undefined}>
        {z.uebersprungen_30d ? fmt.int(z.uebersprungen_30d) : '-'}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums ${z.fehler_30d ? 'font-semibold text-red-700' : 'text-gray-500'}`}>{z.fehler_30d ? fmt.int(z.fehler_30d) : '-'}</td>
      <td className="hidden px-2 py-1.5 text-right text-gray-500 md:table-cell">{relativeZeit(z.zuletzt_gesendet, fmt.locale)}</td>
    </>
  )
}

/** Summen über mehrere Zeilen */
export function summen(zeilen: CapiEreignisStatistik[]) {
  const s = { gesendet7: 0, gesendet30: 0, offen: 0, uebersprungen: 0, fehler: 0, test: 0, gruende: new Map<string, number>() }
  for (const z of zeilen) {
    s.gesendet7 += z.gesendet_7d; s.gesendet30 += z.gesendet_30d; s.offen += z.offen
    s.uebersprungen += z.uebersprungen_30d; s.fehler += z.fehler_30d; s.test += z.test_30d
    for (const g of z.gruende) s.gruende.set(g.grund, (s.gruende.get(g.grund) ?? 0) + g.anzahl)
  }
  return s
}

/** Echtzeit-Schalter als Hinweis (ändern kann nur Sven) */
export function EchtzeitHinweis({ echtzeit, stufen }: { echtzeit: boolean | null; stufen?: boolean }) {
  const { t } = useTranslation()
  if (echtzeit == null) return null
  if (echtzeit) {
    return (
      <Hinweis ton="info" titel={t('crm.werbung.messung.crm.echtzeitAn', 'Echtzeit-Versand ist an')}>
        {t('crm.werbung.messung.crm.echtzeitAnText', 'Ereignisse gehen Sekunden nach dem Eintrag im CRM an Meta. Der Nachtlauf holt Verpasstes nach.')}
      </Hinweis>
    )
  }
  return (
    <Hinweis ton="warnung" titel={t('crm.werbung.messung.crm.echtzeitAus', 'Echtzeit-Versand ist aus')}>
      {stufen
        ? t('crm.werbung.messung.stufen.echtzeitAusText', 'Die Stufen gehen erst an Meta, wenn der Echtzeit-Versand an ist. Einschalten kann nur Sven als Admin.')
        : t('crm.werbung.messung.crm.echtzeitAusText', 'Ereignisse sammeln sich und gehen mit dem Nachtlauf an Meta. Einschalten kann nur Sven als Admin.')}
    </Hinweis>
  )
}

export default function CrmEreignisseKarte({ lader, einstellungen }: { lader: Lader<DiagnoseSicht>; einstellungen: MessEinstellungen | null }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const crm: PixelDiagnoseCrm | null = lader.daten?.crm ?? null
  const zeilen = useMemo(() => (crm?.ereignisse ?? []).filter(z => z.art !== 'crm_stufe'), [crm])
  const s = useMemo(() => summen(zeilen), [zeilen])
  const echtzeit = crm?.echtzeit ?? einstellungen?.capiEchtzeit ?? null

  const ampel: { ampel: Ampel; label: string } | null = !crm || !crm.verfuegbar ? null
    : s.fehler > 0 ? { ampel: 'rot', label: t('crm.werbung.messung.crm.ampel.fehler', 'Fehler beim Senden') }
      : s.offen > 20 ? { ampel: 'gelb', label: t('crm.werbung.messung.crm.ampel.stau', 'Viele offen') }
        : s.gesendet30 > 0 ? { ampel: 'gruen', label: t('crm.werbung.messung.crm.ampel.laeuft', 'Läuft') }
          : { ampel: 'grau', label: t('crm.werbung.messung.crm.ampel.still', 'Noch nichts gesendet') }

  return (
    <Karte id="messung-crm"
      titel={t('crm.werbung.messung.crm.titel', 'Ereignisse aus dem CRM')}
      erklaerung={t('crm.werbung.messung.crm.erklaerung', 'Was im CRM passiert (Termin gebucht, Termin stattgefunden, Daumen hoch, Abschluss), meldet das CRM an Meta. So lernt Meta, welche Anzeigen echte Termine bringen.')}
      ampel={ampel}
      laedt={lader.laedt}
      aktionen={<AktualisierenKnopf onClick={() => void lader.neu()} laedt={lader.laedt} />}
      alle={(
        <div className="space-y-2 text-xs leading-snug text-gray-600">
          <p>{t('crm.werbung.messung.crm.regelMeta', 'Gemeldet werden nur Meta-Leads (aus Anzeigen oder mit Meta-Klick-ID). Interne Kontakte (Sven, Team) gehen nur bei gesetztem Test-Code als Test an Meta, sonst wie jeder andere Meta-Lead.')}</p>
          <p>{t('crm.werbung.messung.crm.regelAlt', 'Ereignisse, die älter als 7 Tage sind, nimmt Meta nicht mehr an. Sie werden übersprungen.')}</p>
          <p>{t('crm.werbung.messung.crm.regelDoppelt', 'Jedes Ereignis hat eine feste Kennung. Meta zählt es nie doppelt, auch wenn der Nachtlauf es noch einmal sendet.')}</p>
          {s.test > 0 && <p>{t('crm.werbung.messung.crm.tests', 'Als Test gesendet (30 Tage, zählt nicht): {{n}}', { n: fmt.int(s.test) })}</p>}
          {s.gruende.size > 0 && (
            <div>
              <p className="font-semibold text-gray-700">{t('crm.werbung.messung.crm.gruende', 'Warum übersprungen (30 Tage)')}</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {[...s.gruende.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => (
                  <li key={g}><Badge tone="neutral">{grundLabel(t, g)}: {fmt.int(n)}</Badge></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}>
      {lader.fehler != null && !lader.daten ? (
        <KartenFehler text={messFehlerText(lader.fehler, t, 'werkzeuge')} onNochmal={() => void lader.neu()} />
      ) : !lader.daten ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map(i => <div key={i} className="h-7 animate-pulse rounded-lg bg-gray-100" />)}
        </div>
      ) : !crm ? (
        <Hinweis ton="info">{t('crm.werbung.messung.crm.keineDaten', 'Keine Zahlen verfügbar. Bitte später noch einmal laden.')}</Hinweis>
      ) : !crm.verfuegbar ? (
        <Hinweis ton="info">{t('crm.werbung.messung.crm.nichtLive', 'Der CAPI-Ausgang ist noch nicht eingerichtet (Datenbank-Änderung steht aus). Bis dahin meldet der Nachtlauf die Ereignisse.')}</Hinweis>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kennzahl label={t('crm.werbung.messung.crm.gesendet7lang', 'Gesendet (7 Tage)')} wert={fmt.int(s.gesendet7)} ton={s.gesendet7 > 0 ? 'gut' : undefined} />
            <Kennzahl label={t('crm.werbung.messung.crm.gesendet30lang', 'Gesendet (30 Tage)')} wert={fmt.int(s.gesendet30)} />
            <Kennzahl label={t('crm.werbung.messung.crm.offen', 'Offen')} wert={fmt.int(s.offen)} ton={s.offen > 20 ? 'warnung' : undefined} />
            <Kennzahl label={t('crm.werbung.messung.crm.fehler30', 'Fehler (30 Tage)')} wert={fmt.int(s.fehler)} ton={s.fehler > 0 ? 'schlecht' : undefined} />
          </div>
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full text-xs">
              <ZahlenKopf erste={t('crm.werbung.messung.crm.ereignis', 'Ereignis')} />
              <tbody className="divide-y divide-gray-50">
                {zeilen.map(z => (
                  <tr key={z.ereignis}>
                    <th scope="row" className="px-2 py-1.5 text-left font-medium text-gray-800">{ereignisLabel(t, z.ereignis)}</th>
                    <ZahlenZellen z={z} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <EchtzeitHinweis echtzeit={echtzeit} />
          {lader.daten.crmErsatz && (
            <p className="text-[11px] text-gray-500">{t('crm.werbung.messung.crm.ersatz', 'Vorläufige Zahlen aus dem CRM-Ausgang: was der Nachtlauf direkt gesendet hat, fehlt, bis die neue Server-Funktion live ist.')}</p>
          )}
          {crm.abgeschnitten && <p className="text-[11px] text-gray-500">{t('crm.werbung.messung.crm.gekappt', 'Sehr viele Einträge: die Zahlen sind unvollständig.')}</p>}
          {crm.hinweise.map((h, i) => <Hinweis key={i} ton="info">{h}</Hinweis>)}
        </>
      )}
    </Karte>
  )
}
