import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import Spinner from '../../../ui/Spinner'
import { useConfirm } from '../../../ui/ConfirmDialog'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { EINGABE_KLEIN, Einstellung, Hinweis } from '../zielgruppen/Bausteine'
import Karte, { KartenFehler } from './Karte'
import type { TFunction } from 'i18next'
import type { CapiTestKandidat } from '../../../../lib/werbeWerkzeuge'
import { ereignisLabel, messFehlerText, relativeZeit, stufeVon, testEreignis, type DiagnoseSicht, type TestErgebnis } from './messungApi'
import type { Lader } from './useLader'

// ── Karte „Test-Ereignis" ────────────────────────────────────────────────────
// Ein Ereignis aus dem CRM-Ausgang als Test an Meta senden, damit es im Events
// Manager unter „Ereignisse testen" erscheint. NUR für interne Kontakte (Sven,
// Verwaltung, Team): die Liste kommt vom Server (pixel_diagnose test_kandidaten)
// und werbe-signal prüft beim Senden noch einmal selbst (sonst 403, nichts
// gesendet). Erst „Prüfen" (dry_run), dann „Test senden" mit Bestätigung.
// werbe-signal lässt nur Admins zu: für alle anderen ist die Karte grau.

/** Name eines Kandidaten in der UI-Sprache (der Server liefert das Etikett deutsch) */
function kandidatLabel(t: TFunction, k: CapiTestKandidat): string {
  if (k.art === 'crm_stufe') {
    const stufe = stufeVon({ event_id: k.event_id, event_name: k.ereignis })
    return stufe ? t(`crm.werbung.messung.stufen.${stufe}`, k.label || k.ereignis) : k.label || k.ereignis
  }
  return ereignisLabel(t, k.ereignis)
}

export default function TestEreignisKarte({ lader, istAdmin }: { lader: Lader<DiagnoseSicht>; istAdmin: boolean }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const confirm = useConfirm()
  const crm = lader.daten?.crm ?? null
  const kandidaten = crm?.test_kandidaten ?? []
  const codeGesetzt = crm?.test_code_gesetzt ?? null

  const [auswahl, setAuswahl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'pruefen' | 'senden' | null>(null)
  const [geprueft, setGeprueft] = useState<{ eventId: string; ergebnis: TestErgebnis } | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)

  // Auswahl gültig halten, wenn die Liste neu kommt
  useEffect(() => {
    if (auswahl && !kandidaten.some(k => k.event_id === auswahl)) setAuswahl(null)
  }, [kandidaten, auswahl])

  const codeTrim = code.trim()
  const codeFehlt = !codeTrim && codeGesetzt !== true
  const sperre = !istAdmin
    ? t('crm.werbung.messung.test.nurAdmin', 'Test-Ereignisse kann nur ein Admin (Sven) senden.')
    : null

  const pruefen = async () => {
    if (!auswahl) return
    setBusy('pruefen')
    setFehler(null)
    setGeprueft(null)
    try {
      const r = await testEreignis(auswahl, codeTrim || null, true)
      setGeprueft({ eventId: auswahl, ergebnis: r })
    } catch (err) {
      setFehler(messFehlerText(err, t, 'signal'))
    } finally {
      setBusy(null)
    }
  }

  const senden = async () => {
    if (!auswahl || geprueft?.eventId !== auswahl) return
    const k = kandidaten.find(x => x.event_id === auswahl)
    const ok = await confirm({
      title: t('crm.werbung.messung.test.bestaetigenTitel', 'Test-Ereignis an Meta senden?'),
      message: t('crm.werbung.messung.test.bestaetigenText', '„{{name}}" geht mit dem Test-Code an Meta. Es zählt nicht als echtes Ereignis und erscheint nur unter „Ereignisse testen".', { name: k ? kandidatLabel(t, k) : auswahl }),
      confirmLabel: t('crm.werbung.messung.test.senden', 'Test senden'),
    })
    if (!ok) return
    setBusy('senden')
    setFehler(null)
    try {
      const r = await testEreignis(auswahl, codeTrim || null, false)
      toast.success(r.empfangen != null
        ? t('crm.werbung.messung.test.gesendet', 'Test gesendet: Meta hat {{n}} Ereignis(se) angenommen.', { n: r.empfangen })
        : t('crm.werbung.messung.test.gesendetOhne', 'Test gesendet.'))
      setGeprueft(null)
      void lader.neu()
    } catch (err) {
      setFehler(messFehlerText(err, t, 'signal'))
    } finally {
      setBusy(null)
    }
  }

  const geprueftKandidat = geprueft ? kandidaten.find(x => x.event_id === geprueft.eventId) : undefined
  const geprueftLabel = geprueftKandidat ? kandidatLabel(t, geprueftKandidat)
    : geprueft?.ergebnis.eventName ? ereignisLabel(t, geprueft.ergebnis.eventName) : auswahl

  return (
    <Karte id="messung-test"
      titel={t('crm.werbung.messung.test.titel', 'Test-Ereignis')}
      erklaerung={t('crm.werbung.messung.test.erklaerung', 'Prüft, ob ein Ereignis aus dem CRM bei Meta ankommt. Nur mit eigenen Kontakten (Sven, Team), nie mit echten Kunden.')}
      laedt={lader.laedt || busy != null}
      alle={(
        <div className="space-y-2 text-xs leading-snug text-gray-600">
          <p>{t('crm.werbung.messung.test.wo', 'Den Test-Code zeigt der Events Manager beim Datensatz unter „Ereignisse testen" (Server-Ereignisse).')}</p>
          <p>{t('crm.werbung.messung.test.kandidaten', 'Zur Auswahl stehen Ereignisse interner Kontakte aus den letzten 7 Tagen, die noch nicht gesendet wurden. Lege dafür z. B. einen Termin mit deiner eigenen E-Mail an.')}</p>
          <p>{t('crm.werbung.messung.test.sicher', 'Der Server prüft beim Senden noch einmal, ob es ein interner Kontakt ist. Echte Kunden werden nie als Test gesendet.')}</p>
        </div>
      )}>
      {sperre ? (
        <Einstellung label={t('crm.werbung.messung.test.label', 'Test-Ereignis senden')} gesperrt={sperre} />
      ) : lader.fehler != null && !lader.daten ? (
        <KartenFehler text={messFehlerText(lader.fehler, t, 'werkzeuge')} onNochmal={() => void lader.neu()} />
      ) : !lader.daten ? (
        <div className="h-16 animate-pulse rounded-lg bg-gray-100" aria-hidden="true" />
      ) : (
        <>
          {kandidaten.length === 0 ? (
            <Hinweis ton="info">
              {lader.daten.crmErsatz
                ? t('crm.werbung.messung.test.keineServer', 'Die Auswahl interner Ereignisse kommt mit der neuen Server-Funktion.')
                : t('crm.werbung.messung.test.keine', 'Kein offenes Ereignis eines internen Kontakts aus den letzten 7 Tagen. Lege z. B. einen Test-Termin mit deiner eigenen E-Mail an und lade neu.')}
            </Hinweis>
          ) : (
            <fieldset>
              <legend className="text-sm font-semibold text-gray-800">{t('crm.werbung.messung.test.waehlen', 'Ereignis wählen')}</legend>
              <ul className="mt-1.5 space-y-1.5">
                {kandidaten.map(k => (
                  <li key={k.event_id}>
                    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${auswahl === k.event_id ? 'border-hp-navy bg-hp-cream ring-1 ring-hp-navy' : 'border-gray-200 bg-white hover:border-hp-navy/40'}`}>
                      <input type="radio" name="messung-test" checked={auswahl === k.event_id}
                        onChange={() => { setAuswahl(k.event_id); setGeprueft(null); setFehler(null) }}
                        className="h-4 w-4 shrink-0 text-hp-navy focus:ring-hp-navy/40" />
                      <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{kandidatLabel(t, k)}</span>
                      {k.art === 'crm_stufe' && <Badge tone="info">{t('crm.werbung.messung.test.stufe', 'Stufe')}</Badge>}
                      <span className="shrink-0 text-xs text-gray-500">{relativeZeit(k.erstellt, fmt.locale)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <Einstellung label={t('crm.werbung.messung.test.code', 'Test-Code aus dem Events Manager')} fuer="messung-test-code"
            erklaerung={codeGesetzt
              ? t('crm.werbung.messung.test.codeGespeichert', 'Leer lassen, dann nimmt der Server den gespeicherten Test-Code.')
              : t('crm.werbung.messung.test.codeNoetig', 'Pflicht: ohne Test-Code sendet der Server nichts.')}>
            <input id="messung-test-code" value={code} onChange={e => setCode(e.target.value.replace(/\s/g, '').slice(0, 64))}
              placeholder="TEST12345" autoComplete="off" className={`${EINGABE_KLEIN} sm:max-w-xs`} />
          </Einstellung>
          {fehler && <Hinweis ton="fehler">{fehler}</Hinweis>}
          {geprueft && geprueft.eventId === auswahl && (
            <Hinweis ton="info" titel={t('crm.werbung.messung.test.geprueft', 'Geprüft: interner Kontakt')}>
              {t('crm.werbung.messung.test.wuerde', '„{{name}}" würde als Test gesendet.', { name: geprueftLabel })}
              {geprueft.ergebnis.warnungen.map((w, i) => <span key={i} className="block text-gray-600">{w}</span>)}
            </Hinweis>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => void pruefen()} disabled={!auswahl || codeFehlt || busy != null} className="hp-btn hp-btn-ghost">
              {busy === 'pruefen' && <Spinner size="sm" />}
              {t('crm.werbung.messung.test.pruefen', 'Prüfen')}
            </button>
            <button type="button" onClick={() => void senden()} disabled={!auswahl || codeFehlt || busy != null || geprueft?.eventId !== auswahl} className="hp-btn hp-btn-primary">
              {busy === 'senden' && <Spinner size="sm" />}
              {t('crm.werbung.messung.test.senden', 'Test senden')}
            </button>
          </div>
        </>
      )}
    </Karte>
  )
}
