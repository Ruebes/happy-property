import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { AUSGABENLIMIT_MAX_AENDERUNGEN, type KontoAusgabenlimitResponse, type KontoResponse } from '../../../../lib/werbeKonto'
import { UsdEurHinweis } from '../felder'
import { useWerbeFormat } from '../format'
import { EINGABE_KLEIN, Einstellung, Hinweis, Kacheln, MetaAenderungDialog, type AenderungPunkt } from '../zielgruppen/Bausteine'
import { geld, messFehlerText, setzeAusgabenlimit } from './messungApi'

// ── Ausgabenlimit des Werbekontos ändern (nur Admin) ─────────────────────────
// Wenn das Konto insgesamt so viel ausgegeben hat, stoppt Meta alle Anzeigen.
// Eingabe in der Kontowährung (USD) mit EUR-Gegenwert. Ein Limit unter oder
// gleich den bisherigen Ausgaben würde sofort alles stoppen: gesperrt (dafür
// gibt es den Stopp-Knopf im Autopiloten). Meta erlaubt höchstens 10
// Änderungen pro Tag. Ablauf: Weiter -> Server-Vorschau (vorschau: true, nichts
// geht an Meta) -> „Das ändert sich bei Meta" -> Bestätigen (confirm: true).

/**
 * Betrag in Dollar, deutsch oder englisch geschrieben: „5000", „5000,50",
 * „5.000", „5.000,50", „5,000.50". Punkt oder Komma vor genau drei Ziffern gilt
 * als Tausendertrenner (Cent haben höchstens zwei Stellen). Mehrdeutiges -> null.
 */
function parseLimitBetrag(eingabe: string): number | null {
  const s = eingabe.replace(/[\s$\u00a0]/g, '').replace(/^US/i, '')
  if (!s) return null
  let norm: string | null = null
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) norm = s.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) norm = s.replace(/,/g, '')
  else if (/^\d+([.,]\d{1,2})?$/.test(s)) norm = s.replace(',', '.')
  if (norm == null) return null
  const v = Number(norm)
  return Number.isFinite(v) ? v : null
}

export default function AusgabenlimitDialog({ offen, konto, onClose, onFertig }: {
  offen: boolean
  konto: KontoResponse
  onClose: () => void
  onFertig: () => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const [art, setArt] = useState<'setzen' | 'entfernen'>('setzen')
  const [betrag, setBetrag] = useState('')
  const [vorschau, setVorschau] = useState<KontoAusgabenlimitResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)

  useEffect(() => {
    if (!offen) return
    setArt('setzen')
    setBetrag(konto.limit_cents != null ? String(konto.limit_cents / 100) : '')
    setVorschau(null)
    setFehler(null)
  }, [offen, konto.limit_cents])

  const waehrung = konto.waehrung ?? 'USD'
  const dollar = parseLimitBetrag(betrag)
  const cents = dollar != null ? Math.round(dollar * 100) : null
  const ausgegeben = konto.ausgegeben_cents ?? 0
  const max = konto.limit_aenderungen_max || AUSGABENLIMIT_MAX_AENDERUNGEN
  const aenderungenVoll = konto.limit_aenderungen_24h != null && konto.limit_aenderungen_24h >= max

  let problem: string | null = null
  if (!konto.darf_limit_aendern) problem = konto.limit_sperrgrund || t('crm.werbung.messung.konto.limitNurAdmin', 'Das Ausgabenlimit ändert nur ein Admin (Sven).')
  else if (art === 'setzen') {
    if (cents == null && betrag.trim()) problem = t('crm.werbung.messung.limit.problemFormat', 'Den Betrag bitte als Zahl eingeben, z. B. 5000, 5.000 oder 5.000,50.')
    else if (cents == null || cents <= 0) problem = t('crm.werbung.messung.limit.problemBetrag', 'Bitte einen Betrag größer als 0 eingeben.')
    else if (cents <= ausgegeben) problem = t('crm.werbung.messung.limit.problemUnter', 'Das Limit muss über den bisherigen Ausgaben ({{wert}}) liegen, sonst stoppen sofort alle Anzeigen. Für einen Stopp nimm den Stopp-Knopf im Autopiloten.', { wert: geld(ausgegeben, waehrung, fmt.locale) })
    else if (konto.limit_cents != null && cents === konto.limit_cents) problem = t('crm.werbung.messung.limit.problemGleich', 'Das ist schon das aktuelle Limit.')
  } else if (konto.limit_cents == null) {
    problem = t('crm.werbung.messung.limit.problemKeins', 'Es ist gerade kein Limit gesetzt.')
  }
  if (!problem && aenderungenVoll) problem = t('crm.werbung.messung.limit.problemTag', 'In den letzten 24 Stunden wurde das Limit schon {{max}} Mal geändert. Meta lässt erst später wieder Änderungen zu.', { max })

  const wahl = art === 'entfernen' ? { entfernen: true as const } : { cents: cents ?? 0 }
  const vorher = konto.limit_cents != null ? geld(konto.limit_cents, waehrung, fmt.locale) : t('crm.werbung.messung.limit.keins', 'kein Limit')
  const nachherCents = vorschau ? vorschau.nachher_cents : art === 'entfernen' ? null : cents
  const nachher = nachherCents == null ? t('crm.werbung.messung.limit.keins', 'kein Limit') : geld(nachherCents, waehrung, fmt.locale)
  const rest = nachherCents != null ? nachherCents - ausgegeben : null

  const pruefen = async () => {
    if (problem) return
    setBusy(true)
    setFehler(null)
    try {
      setVorschau(await setzeAusgabenlimit(wahl, true))
    } catch (err) {
      setFehler(messFehlerText(err, t, 'konto'))
    } finally {
      setBusy(false)
    }
  }

  const ausfuehren = async () => {
    setBusy(true)
    setFehler(null)
    try {
      const r = await setzeAusgabenlimit(wahl, false)
      if (r.pruefung === 'abweichung') {
        toast.error(t('crm.werbung.messung.limit.abweichung', 'Gespeichert, aber Meta zeigt einen anderen Wert an. Bitte im Werbeanzeigenmanager prüfen.'))
      } else {
        toast.success(r.nachher_cents == null
          ? t('crm.werbung.messung.limit.entfernt', 'Ausgabenlimit entfernt.')
          : t('crm.werbung.messung.limit.gesetzt', 'Ausgabenlimit auf {{wert}} gesetzt.', { wert: geld(r.nachher_cents, waehrung, fmt.locale) }))
      }
      setVorschau(null)
      onFertig()
      onClose()
    } catch (err) {
      setFehler(messFehlerText(err, t, 'konto'))
    } finally {
      setBusy(false)
    }
  }

  const punkte: AenderungPunkt[] = [
    { text: t('crm.werbung.messung.limit.punkt', 'Ausgabenlimit des Werbekontos: {{vorher}} → {{nachher}}', { vorher, nachher }), art: 'neu' },
    ...(vorschau?.nachher_eur != null ? [{ text: t('crm.werbung.messung.limit.punktEur', 'Entspricht etwa {{eur}}', { eur: fmt.eur(vorschau.nachher_eur) }), art: 'gleich' as const }] : []),
    ...(rest != null ? [{ text: t('crm.werbung.messung.limit.punktRest', 'Bis zum Stopp noch {{wert}} Ausgaben möglich.', { wert: geld(rest, waehrung, fmt.locale) }), art: 'gleich' as const }] : []),
    ...(nachherCents == null ? [{ text: t('crm.werbung.messung.limit.punktOhne', 'Ohne Limit stoppt Meta das Konto nicht mehr von selbst. Tageslimit und Autopilot-Leitplanken gelten weiter.'), art: 'achtung' as const }] : []),
    { text: t('crm.werbung.messung.limit.punktTag', 'Meta erlaubt höchstens {{max}} Änderungen am Ausgabenlimit pro Tag.', { max }), art: 'achtung' },
  ]

  return (
    <>
      <Modal open={offen && !vorschau} onClose={busy ? () => undefined : onClose} size="md" closeOnBackdrop={!busy}
        title={t('crm.werbung.messung.limit.titel', 'Ausgabenlimit des Werbekontos')}
        footer={(
          <>
            <button type="button" onClick={onClose} disabled={busy} className="hp-btn hp-btn-ghost">{t('crm.werbung.messung.abbrechen', 'Abbrechen')}</button>
            <button type="button" onClick={() => void pruefen()} disabled={!!problem || busy} className="hp-btn hp-btn-primary">
              {busy && <Spinner size="sm" />}
              {t('crm.werbung.messung.limit.weiter', 'Weiter')}
            </button>
          </>
        )}>
        <div className="space-y-4">
          <p className="text-xs leading-snug text-gray-600">
            {t('crm.werbung.messung.limit.erklaerung', 'Wenn das Werbekonto insgesamt so viel ausgegeben hat, stoppt Meta alle Anzeigen, auch wenn das CRM ausfällt. Ein Sicherheitsnetz für den Notfall.')}
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-hp-cream/60 px-3 py-2">
              <p className="text-gray-500">{t('crm.werbung.messung.limit.aktuell', 'Aktuelles Limit')}</p>
              <p className="font-semibold text-hp-navy">{vorher}</p>
            </div>
            <div className="rounded-lg bg-hp-cream/60 px-3 py-2">
              <p className="text-gray-500">{t('crm.werbung.messung.limit.bisher', 'Bisher ausgegeben')}</p>
              <p className="font-semibold text-hp-navy">{geld(konto.ausgegeben_cents, waehrung, fmt.locale)}</p>
            </div>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{t('crm.werbung.messung.dasWichtigste', 'Das Wichtigste')}</p>
          <Kacheln name="limit-art" wert={art} onChange={setArt} spalten={2} optionen={[
            { wert: 'setzen', titel: t('crm.werbung.messung.limit.setzen', 'Limit setzen'), text: t('crm.werbung.messung.limit.setzenText', 'Neuer Gesamtbetrag, ab dem Meta stoppt.'), empfohlen: true },
            {
              wert: 'entfernen', titel: t('crm.werbung.messung.limit.entfernen', 'Limit entfernen'), text: t('crm.werbung.messung.limit.entfernenText', 'Meta stoppt nicht mehr von selbst.'),
              gesperrt: konto.limit_cents == null ? t('crm.werbung.messung.limit.problemKeins', 'Es ist gerade kein Limit gesetzt.') : null,
            },
          ]} />
          {art === 'setzen' && (
            <Einstellung label={t('crm.werbung.messung.limit.betrag', 'Neues Limit ({{waehrung}})', { waehrung })} fuer="limit-betrag"
              erklaerung={t('crm.werbung.messung.limit.betragHilfe', 'Gesamtbetrag, nicht pro Monat. Er muss über den bisherigen Ausgaben liegen.')}>
              <input id="limit-betrag" value={betrag} onChange={e => setBetrag(e.target.value)} inputMode="decimal" className={`${EINGABE_KLEIN} sm:max-w-[12rem]`} />
              {waehrung === 'USD' && <UsdEurHinweis usd={dollar != null ? String(dollar) : ''} kurs={konto.kurs_quelle === 'insights_7d' ? konto.usd_pro_eur : null} />}
            </Einstellung>
          )}
          {problem && <Hinweis ton="warnung">{problem}</Hinweis>}
          {fehler && <Hinweis ton="fehler">{fehler}</Hinweis>}
        </div>
      </Modal>
      <MetaAenderungDialog offen={offen && !!vorschau} busy={busy}
        punkte={punkte}
        lernphase={t('crm.werbung.messung.limit.lernphase', 'Keine Lernphase startet neu. Das Limit ändert nur, wann Meta das ganze Konto stoppt.')}
        warnungen={[...(vorschau?.hinweise ?? []), ...(fehler ? [fehler] : [])]}
        gesperrt={problem}
        bestaetigen={nachherCents == null ? t('crm.werbung.messung.limit.entfernenJetzt', 'Limit entfernen') : t('crm.werbung.messung.limit.setzenJetzt', 'Limit setzen')}
        onBestaetigen={() => void ausfuehren()}
        onClose={() => setVorschau(null)} />
    </>
  )
}
