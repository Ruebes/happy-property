import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Badge, { type BadgeTone } from '../../../ui/Badge'
import type { DiagnoseAmpel, PixelEmq, PixelEreignisStatus } from '../../../../lib/werbeWerkzeuge'
import { useWerbeFormat } from '../format'
import { EINGABE_KLEIN, Hinweis } from '../zielgruppen/Bausteine'
import Karte, { AktualisierenKnopf, KartenFehler, Kennzahl } from './Karte'
import { ereignisLabel, merkmalLabel, messFehlerText, relativeZeit, type DiagnoseSicht } from './messungApi'
import type { Lader } from './useLader'

// ── Karte „Datensatz-Gesundheit" ─────────────────────────────────────────────
// Pixel/Datensatz laut Meta: zuletzt empfangen je Ereignis, Anzahl 24 Stunden
// und 7 Tage, Ereignis-Abgleichqualität (EMQ) mit den Merkmalen, die Meta zum
// Abgleich nutzt, Datenfrische und Metas eigene Hinweise. Quelle: meta-werkzeuge
// pixel_diagnose (ein Aufruf für den ganzen Reiter, lädt MessungTab). Ein
// anderer Datensatz (z. B. der Pixel der Plan-B-Kampagne) lässt sich unter
// „Alle Einstellungen" prüfen.

const TON: Record<DiagnoseAmpel, BadgeTone> = { gruen: 'success', gelb: 'warning', rot: 'danger', grau: 'neutral' }
const BALKEN: Record<DiagnoseAmpel, string> = { gruen: 'bg-emerald-500', gelb: 'bg-amber-500', rot: 'bg-red-500', grau: 'bg-gray-300' }

/** Metas EMQ-Stufen: ab 8 sehr gut, ab 6 gut, ab 4 OK, darunter schwach */
function emqStufe(t: TFunction, score: number | null): { ampel: DiagnoseAmpel; text: string } {
  if (score == null) return { ampel: 'grau', text: t('crm.werbung.messung.datensatz.emqStufe.keine', 'keine Angabe') }
  if (score >= 8) return { ampel: 'gruen', text: t('crm.werbung.messung.datensatz.emqStufe.sehrGut', 'sehr gut') }
  if (score >= 6) return { ampel: 'gruen', text: t('crm.werbung.messung.datensatz.emqStufe.gut', 'gut') }
  if (score >= 4) return { ampel: 'gelb', text: t('crm.werbung.messung.datensatz.emqStufe.ok', 'OK') }
  return { ampel: 'rot', text: t('crm.werbung.messung.datensatz.emqStufe.schwach', 'schwach') }
}

function frische(t: TFunction, v: string | null): string | null {
  if (!v) return null
  switch (v.toUpperCase()) {
    case 'REAL_TIME': return t('crm.werbung.messung.datensatz.frische.REAL_TIME', 'in Echtzeit')
    case 'HOURLY': return t('crm.werbung.messung.datensatz.frische.HOURLY', 'stündlich')
    case 'DAILY': return t('crm.werbung.messung.datensatz.frische.DAILY', 'täglich')
    default: return v
  }
}

function EreignisZeile({ e, details }: { e: PixelEreignisStatus; details: PixelEmq | undefined }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [offen, setOffen] = useState(false)
  const stufe = emqStufe(t, e.emq)
  const merkmale = details?.merkmale ?? []
  const diagnosen = details?.diagnosen ?? []
  const fr = frische(t, e.datenfrische)
  const hatDetails = merkmale.length > 0 || diagnosen.length > 0 || e.abdeckung_pct != null || e.zusaetzliche_conversions_pct != null || e.potenzial_pct != null || !!fr
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${BALKEN[e.ampel]}`} />
        <span className="min-w-0 flex-1 text-sm font-medium text-gray-800">{ereignisLabel(t, e.ereignis)}</span>
        <span className="text-xs tabular-nums text-gray-500">
          {e.anzahl_24h != null ? t('crm.werbung.messung.datensatz.anzahl24h', '{{n}} in 24 Std.', { n: fmt.int(e.anzahl_24h) }) : ''}
          {e.anzahl_24h != null && e.anzahl_7d != null ? ' · ' : ''}
          {e.anzahl_7d != null ? t('crm.werbung.messung.datensatz.anzahl7d', '{{n}} in 7 Tagen', { n: fmt.int(e.anzahl_7d) }) : ''}
        </span>
        <span className="text-xs text-gray-500">
          {e.zuletzt_empfangen
            ? t('crm.werbung.messung.datensatz.zuletzt', 'zuletzt {{zeit}}', { zeit: relativeZeit(e.zuletzt_empfangen, fmt.locale) })
            : t('crm.werbung.messung.datensatz.nieEmpfangen', 'in 7 Tagen nicht empfangen')}
        </span>
        <span className="flex w-32 items-center gap-2" title={t('crm.werbung.messung.datensatz.emqTitel', 'Ereignis-Abgleichqualität (EMQ) von 0 bis 10')}>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
            <span className={`block h-full ${BALKEN[stufe.ampel]}`} style={{ width: `${Math.max(0, Math.min(10, e.emq ?? 0)) * 10}%` }} />
          </span>
          <span className="w-12 text-right text-xs tabular-nums text-gray-700">
            {e.emq != null ? `${e.emq.toLocaleString(fmt.locale, { maximumFractionDigits: 1 })}/10` : '-'}
          </span>
        </span>
        <Badge tone={TON[stufe.ampel]}>{stufe.text}</Badge>
        {hatDetails && (
          <button type="button" onClick={() => setOffen(o => !o)} aria-expanded={offen} className="text-xs font-semibold text-hp-navy underline-offset-2 hover:underline">
            {offen ? t('crm.werbung.messung.datensatz.weniger', 'Weniger') : t('crm.werbung.messung.datensatz.details', 'Details')}
          </button>
        )}
      </div>
      {e.hinweis && <p className="mt-1 pl-5 text-xs leading-snug text-gray-600">{e.hinweis}</p>}
      {offen && (
        <div className="mt-2 space-y-2 rounded-lg bg-gray-50 px-3 py-2">
          <dl className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
            {fr && (<><dt className="text-gray-500">{t('crm.werbung.messung.datensatz.frischeLabel', 'Datenfrische')}</dt><dd className="text-gray-800">{fr}</dd></>)}
            {e.abdeckung_pct != null && (<><dt className="text-gray-500">{t('crm.werbung.messung.datensatz.abdeckung', 'Abdeckung durch die Conversions API')}</dt><dd className="tabular-nums text-gray-800">{Math.round(e.abdeckung_pct)} %</dd></>)}
            {e.zusaetzliche_conversions_pct != null && (<><dt className="text-gray-500">{t('crm.werbung.messung.datensatz.zusaetzlich', 'Zusätzlich erfasste Conversions')}</dt><dd className="tabular-nums text-gray-800">+{Math.round(e.zusaetzliche_conversions_pct)} %</dd></>)}
            {e.potenzial_pct != null && (<><dt className="text-gray-500">{t('crm.werbung.messung.datensatz.potenzial', 'Möglicher Zuwachs mit besseren Daten')}</dt><dd className="tabular-nums text-gray-800">+{Math.round(e.potenzial_pct)} %</dd></>)}
          </dl>
          {merkmale.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-600">{t('crm.werbung.messung.datensatz.merkmale', 'Welche Daten Meta zum Abgleich bekommt')}</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {merkmale.map(m => (
                  <li key={m.merkmal}>
                    <Badge tone={m.abdeckung_pct == null ? 'neutral' : m.abdeckung_pct >= 50 ? 'success' : m.abdeckung_pct >= 10 ? 'warning' : 'danger'}>
                      {merkmalLabel(t, m.merkmal)}{m.abdeckung_pct != null ? ` ${Math.round(m.abdeckung_pct)} %` : ''}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {diagnosen.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-600">{t('crm.werbung.messung.datensatz.diagnosen', 'Metas Hinweise')}</p>
              <ul className="mt-1 space-y-1">
                {diagnosen.map((d, i) => (
                  <li key={`${d.name}-${i}`} className="text-xs leading-snug text-gray-700">
                    <span className="font-medium">{d.name}</span>
                    {d.anteil_pct != null && <span className="text-gray-500"> ({Math.round(d.anteil_pct)} %)</span>}
                    {d.beschreibung && <span className="block text-gray-600">{d.beschreibung}</span>}
                    {d.loesung && <span className="block text-gray-500">{t('crm.werbung.messung.datensatz.loesung', 'Lösung: {{text}}', { text: d.loesung })}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export default function DatensatzKarte({ lader, pixel, onPixel }: {
  lader: Lader<DiagnoseSicht>
  /** gewählter anderer Datensatz, null = Standard */
  pixel: string | null
  onPixel: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [eingabe, setEingabe] = useState('')
  const sicht = lader.daten
  const d = sicht?.antwort ?? null

  const ampelLabel = (a: DiagnoseAmpel): string => {
    switch (a) {
      case 'gruen': return t('crm.werbung.messung.datensatz.ampel.gruen', 'Empfängt Daten')
      case 'gelb': return t('crm.werbung.messung.datensatz.ampel.gelb', 'Prüfen')
      case 'rot': return t('crm.werbung.messung.datensatz.ampel.rot', 'Problem')
      default: return t('crm.werbung.messung.datensatz.ampel.grau', 'Unbekannt')
    }
  }
  const idOk = /^\d{6,20}$/.test(eingabe.trim())
  const schwach = (sicht?.ereignisse ?? []).filter(e => e.emq != null && e.emq < 6)

  return (
    <Karte id="messung-datensatz"
      titel={t('crm.werbung.messung.datensatz.titel', 'Datensatz-Gesundheit')}
      erklaerung={t('crm.werbung.messung.datensatz.erklaerung', 'Kommen die Ereignisse vom Pixel und aus dem CRM bei Meta an, und kann Meta sie Personen zuordnen? Je besser, desto günstiger die Leads.')}
      ampel={d ? { ampel: d.ampel, label: ampelLabel(d.ampel) } : null}
      laedt={lader.laedt}
      aktionen={<AktualisierenKnopf onClick={() => void lader.neu()} laedt={lader.laedt} />}
      alle={(
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold text-gray-800">{t('crm.werbung.messung.datensatz.andererTitel', 'Anderen Datensatz prüfen')}</p>
            <p className="text-xs leading-snug text-gray-500">{t('crm.werbung.messung.datensatz.andererText', 'Zum Beispiel den Pixel einer bestehenden Kampagne. Die ID steht im Events Manager.')}</p>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input value={eingabe} onChange={e => setEingabe(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                placeholder={t('crm.werbung.messung.datensatz.idPlatzhalter', 'Datensatz-ID')}
                aria-label={t('crm.werbung.messung.datensatz.idPlatzhalter', 'Datensatz-ID')} className={`${EINGABE_KLEIN} sm:max-w-xs`} />
              <button type="button" onClick={() => onPixel(eingabe.trim())} disabled={!idOk || lader.laedt} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
                {t('crm.werbung.messung.datensatz.pruefen', 'Prüfen')}
              </button>
              {pixel && (
                <button type="button" onClick={() => { setEingabe(''); onPixel(null) }} disabled={lader.laedt} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
                  {t('crm.werbung.messung.datensatz.zurueck', 'Zurück zum Standard')}
                </button>
              )}
            </div>
          </div>
          {d && (
            <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              <dt className="text-gray-500">{t('crm.werbung.messung.datensatz.id', 'Datensatz-ID')}</dt>
              <dd className="tabular-nums text-gray-800">{d.id}</dd>
              <dt className="text-gray-500">{t('crm.werbung.messung.datensatz.imKonto', 'Mit dem Werbekonto verbunden')}</dt>
              <dd className="text-gray-800">{d.im_konto == null ? t('crm.werbung.messung.unbekannt', 'unbekannt') : d.im_konto ? t('crm.werbung.messung.ja', 'ja') : t('crm.werbung.messung.nein', 'nein')}</dd>
              <dt className="text-gray-500">{t('crm.werbung.messung.datensatz.hpPixel', 'Pixel der Website (/termin)')}</dt>
              <dd className="text-gray-800">{d.ist_hp_pixel ? t('crm.werbung.messung.ja', 'ja') : t('crm.werbung.messung.nein', 'nein')}</dd>
              {d.stand && (<><dt className="text-gray-500">{t('crm.werbung.messung.datensatz.stand', 'Stand')}</dt><dd className="text-gray-800">{relativeZeit(d.stand, fmt.locale)}</dd></>)}
            </dl>
          )}
          <Hinweis ton="info">
            {t('crm.werbung.messung.datensatz.emqErklaerung', 'Ereignis-Abgleichqualität (EMQ): Meta bewertet von 0 bis 10, wie gut sich ein Ereignis einer Person zuordnen lässt. E-Mail, Telefon und Klick-ID bringen am meisten.')}
          </Hinweis>
        </div>
      )}>
      {lader.fehler != null && !d ? (
        <KartenFehler text={messFehlerText(lader.fehler, t, 'werkzeuge')} onNochmal={() => void lader.neu()} />
      ) : !d || !sicht ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map(i => <div key={i} className="h-8 animate-pulse rounded-lg bg-gray-100" />)}
        </div>
      ) : (
        <>
          {lader.fehler != null && <KartenFehler text={messFehlerText(lader.fehler, t, 'werkzeuge')} />}
          {pixel && <Hinweis ton="info">{t('crm.werbung.messung.datensatz.anderer', 'Du siehst gerade den Datensatz {{id}}, nicht den Standard.', { id: pixel })}</Hinweis>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Kennzahl label={t('crm.werbung.messung.datensatz.name', 'Datensatz')} wert={<span className="text-sm">{d.name ?? d.id}</span>} />
            <Kennzahl label={t('crm.werbung.messung.datensatz.letzter', 'Zuletzt empfangen')}
              wert={<span className="text-sm">{relativeZeit(d.letzter_empfang, fmt.locale)}</span>}
              ton={d.stunden_seit_empfang == null ? undefined : d.stunden_seit_empfang > 48 ? 'schlecht' : d.stunden_seit_empfang > 24 ? 'warnung' : 'gut'} />
            <Kennzahl label={t('crm.werbung.messung.datensatz.ereignisse', 'Ereignisarten')} wert={fmt.int(sicht.ereignisse.length)} />
          </div>
          {d.meta_fehler && (
            <Hinweis ton="warnung" titel={t('crm.werbung.messung.datensatz.metaFehler', 'Meta-Daten nicht lesbar')}>{d.meta_fehler}</Hinweis>
          )}
          {d.nicht_verfuegbar && (
            <Hinweis ton="warnung">{t('crm.werbung.messung.datensatz.nichtVerfuegbar', 'Meta meldet diesen Datensatz als nicht verfügbar. Bitte im Events Manager prüfen.')}</Hinweis>
          )}
          {schwach.length > 0 && (
            <Hinweis ton="warnung">
              {t('crm.werbung.messung.datensatz.schwach', 'Schwache Abgleichqualität bei: {{namen}}. Mehr Kontaktdaten (E-Mail, Telefon) mitsenden hilft.', { namen: schwach.map(e => ereignisLabel(t, e.ereignis)).join(', ') })}
            </Hinweis>
          )}
          {sicht.ereignisse.length > 0 ? (
            <ul className="divide-y divide-gray-100">
              {sicht.ereignisse.map(e => <EreignisZeile key={e.ereignis} e={e} details={sicht.emqDetails[e.ereignis]} />)}
            </ul>
          ) : (
            <p className="text-xs text-gray-500">{t('crm.werbung.messung.datensatz.keine', 'Meta liefert noch keine Ereignisse für diesen Datensatz.')}</p>
          )}
          {[...(d.hinweise ?? []), ...(d.warnings ?? [])].map((h, i) => <Hinweis key={i} ton="info">{h}</Hinweis>)}
        </>
      )}
    </Karte>
  )
}
