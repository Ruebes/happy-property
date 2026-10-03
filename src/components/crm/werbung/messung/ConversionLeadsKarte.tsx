import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CRM_STUFEN, CRM_STUFEN_ANLEITUNG, type CrmStufeStatus } from '../../../../lib/werbeWerkzeuge'
import { useWerbeFormat } from '../format'
import { Empfohlen, Hinweis } from '../zielgruppen/Bausteine'
import { EchtzeitHinweis, summen, ZahlenKopf, ZahlenZellen } from './CrmEreignisseKarte'
import Karte, { KartenFehler, Kennzahl } from './Karte'
import { messFehlerText, type DiagnoseSicht } from './messungApi'
import type { Ampel, MessEinstellungen } from './typen'
import type { Lader } from './useLader'

// ── Karte „Conversion-Leads-Stufen" ──────────────────────────────────────────
// Metas Performance-Ziel „Anzahl qualifizierter Leads maximieren" braucht seit
// 2026 die Conversions API für CRM: für jeden Lead aus einem Sofortformular (mit
// Meta-Lead-ID) meldet das CRM, welche Stufe er erreicht hat (Lead, Termin
// gebucht, Termin stattgefunden, Qualifiziert, Kunde). Kennung
// crm-<Meta-Lead-ID>-<Stufe>, Quelle „Happy Property CRM". Die Stufen gehen nur
// bei eingeschaltetem Echtzeit-Versand raus. Quelle der Zahlen: pixel_diagnose.crm.

export default function ConversionLeadsKarte({ lader, einstellungen }: { lader: Lader<DiagnoseSicht>; einstellungen: MessEinstellungen | null }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const crm = lader.daten?.crm ?? null
  const echtzeit = crm?.echtzeit ?? einstellungen?.capiEchtzeit ?? null

  // Immer alle fünf Stufen in Funnel-Reihenfolge, auch wenn der Server eine auslässt
  const stufen: CrmStufeStatus[] = useMemo(() => CRM_STUFEN.map((s, i) => {
    const vom = crm?.stufen.find(x => x.key === s.key)
    return vom ?? {
      key: s.key, ereignis: s.ereignis, label: s.label, art: 'crm_stufe', erklaerung: s.erklaerung, reihenfolge: i + 1,
      gesendet_7d: 0, gesendet_30d: 0, zuletzt_gesendet: null, offen: 0, fehler_30d: 0, uebersprungen_30d: 0, test_30d: 0, gruende: [],
    }
  }), [crm])
  const s = useMemo(() => summen(stufen), [stufen])
  const leads30 = crm?.leadgen_leads_30d ?? null
  const empfehlung = crm?.leadgen_empfehlung_monat ?? 200

  const ampel: { ampel: Ampel; label: string } | null = !crm || !crm.verfuegbar ? null
    : s.fehler > 0 ? { ampel: 'rot', label: t('crm.werbung.messung.stufen.ampel.fehler', 'Fehler beim Senden') }
      : echtzeit === false ? { ampel: 'gelb', label: t('crm.werbung.messung.stufen.ampel.aus', 'Versand aus') }
        : s.gesendet30 > 0 ? { ampel: 'gruen', label: t('crm.werbung.messung.stufen.ampel.laeuft', 'Stufen kommen an') }
          : { ampel: 'grau', label: t('crm.werbung.messung.stufen.ampel.still', 'Noch keine Stufen') }

  return (
    <Karte id="messung-stufen"
      titel={t('crm.werbung.messung.stufen.titel', 'Conversion-Leads-Stufen')}
      erklaerung={t('crm.werbung.messung.stufen.erklaerung', 'Für Leads aus Sofortformularen meldet das CRM, wie weit jeder Lead gekommen ist. Damit kann Meta auf gute Leads optimieren statt auf viele.')}
      ampel={ampel}
      laedt={lader.laedt}
      alle={(
        <div className="space-y-3 text-xs leading-snug text-gray-600">
          <div>
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-800">
              {t('crm.werbung.messung.stufen.einrichtenTitel', 'So nutzt du die Stufen bei Meta')} <Empfohlen />
            </p>
            <ol className="mt-1 list-decimal space-y-1 pl-5">
              {CRM_STUFEN_ANLEITUNG.map((schritt, i) => (
                <li key={i}>{t(`crm.werbung.messung.stufen.schritt${i + 1}`, schritt)}</li>
              ))}
            </ol>
          </div>
          <p>{t('crm.werbung.messung.stufen.technik', 'Technik: Ereignisquelle „crm", Aktionsquelle „system_generated", Zuordnung über die Meta-Lead-ID. Dazu gehen E-Mail, Telefon, Vor- und Nachname, Land und die CRM-Kennung des Kontakts mit, jeweils nur als SHA-256-Hash, und, falls vorhanden, Metas Klick- und Browser-ID (fbc, fbp).')}</p>
          <p>{t('crm.werbung.messung.stufen.website', 'Leads über die Website (/termin) laufen weiter über die normalen Ereignisse (Karte „Ereignisse aus dem CRM"). Für sie gibt es keine Meta-Lead-ID.')}</p>
          {crm?.lead_event_source && <p>{t('crm.werbung.messung.stufen.quelle', 'Name der Quelle bei Meta: {{name}}', { name: crm.lead_event_source })}</p>}
          {crm?.crm_datensatz_id && <p>{t('crm.werbung.messung.stufen.datensatz', 'Datensatz für die Stufen: {{id}}', { id: crm.crm_datensatz_id })}</p>}
        </div>
      )}>
      {lader.fehler != null && !lader.daten ? (
        <KartenFehler text={messFehlerText(lader.fehler, t, 'werkzeuge')} onNochmal={() => void lader.neu()} />
      ) : !lader.daten ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-7 animate-pulse rounded-lg bg-gray-100" />)}
        </div>
      ) : (
        <>
          {crm && !crm.verfuegbar && (
            <Hinweis ton="info">{t('crm.werbung.messung.stufen.nichtLive', 'Noch nicht eingerichtet: Die Datenbank-Änderung für den CAPI-Ausgang steht aus.')}</Hinweis>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Kennzahl label={t('crm.werbung.messung.stufen.leads30', 'Sofortformular-Leads (30 Tage)')}
              wert={leads30 == null ? '-' : fmt.int(leads30)}
              ton={leads30 == null ? undefined : leads30 >= empfehlung ? 'gut' : 'warnung'}
              hilfe={t('crm.werbung.messung.stufen.empfehlung', 'Meta empfiehlt rund {{n}} im Monat', { n: fmt.int(empfehlung) })} />
            <Kennzahl label={t('crm.werbung.messung.stufen.gemeldet30', 'Gemeldete Stufen (30 Tage)')} wert={fmt.int(s.gesendet30)} ton={s.gesendet30 > 0 ? 'gut' : undefined} />
          </div>
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full text-xs">
              <ZahlenKopf erste={t('crm.werbung.messung.stufen.stufe', 'Stufe')} />
              <tbody className="divide-y divide-gray-50">
                {stufen.map((z, i) => (
                  <tr key={z.key}>
                    <th scope="row" className="px-2 py-1.5 text-left align-top font-normal">
                      <span className="flex items-start gap-2">
                        <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hp-navy text-[10px] font-semibold text-white">{i + 1}</span>
                        <span className="min-w-0">
                          <span className="block font-medium text-gray-800">{t(`crm.werbung.messung.stufen.${z.key}`, z.label)}</span>
                          <span className="block text-[11px] leading-snug text-gray-500">{t(`crm.werbung.messung.stufen.${z.key}Wann`, z.erklaerung)}</span>
                        </span>
                      </span>
                    </th>
                    <ZahlenZellen z={z} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <EchtzeitHinweis echtzeit={echtzeit} stufen />
          {crm?.verfuegbar && echtzeit !== false && s.gesendet30 === 0 && (
            <Hinweis ton="info">
              {t('crm.werbung.messung.stufen.leer', 'In den letzten 30 Tagen wurde noch keine Stufe gemeldet. Das ist normal, solange keine Kampagne mit Sofortformular läuft.')}
            </Hinweis>
          )}
          <p className="text-[11px] text-gray-500">{t('crm.werbung.messung.stufen.fuss', 'Nur Leads mit Meta-Lead-ID (Sofortformular).')}</p>
        </>
      )}
    </Karte>
  )
}
