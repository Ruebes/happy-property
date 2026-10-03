import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Spinner from '../../../ui/Spinner'
import { steuerungFehlerText } from './steuerungApi'

// ── Prüfung durch den Server vor dem Senden (vorschau: true) ─────────────────
// Sobald der Bestätigungs-Dialog „Das ändert sich bei Meta" aufgeht, schickt
// der Reiter denselben Auftrag mit vorschau: true: der Server prüft alles
// (Rechte, Leitplanke, Objekte im Konto, Wohnen), sendet aber nichts an Meta.
// Seine Hinweise und Zusammenfassung stehen im Dialog; solange die Prüfung
// läuft oder gescheitert ist, bleibt „Bestätigen" gesperrt.

export interface PruefErgebnis {
  /** Zeilen der Zusammenfassung (z. B. rule_create.zusammenfassung) */
  zeilen: string[]
  hinweise: string[]
}

export function usePruefung(offen: boolean, pruefen: () => Promise<PruefErgebnis>) {
  const { t } = useTranslation()
  const [laeuft, setLaeuft] = useState(false)
  const [ergebnis, setErgebnis] = useState<PruefErgebnis | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const fn = useRef(pruefen)
  useEffect(() => { fn.current = pruefen })

  const starten = useCallback(async () => {
    setLaeuft(true)
    setErgebnis(null)
    setFehler(null)
    try {
      setErgebnis(await fn.current())
    } catch (err) {
      setFehler(steuerungFehlerText(err, t))
    } finally {
      setLaeuft(false)
    }
  }, [t])

  useEffect(() => {
    if (offen) void starten()
    else { setErgebnis(null); setFehler(null) }
  }, [offen, starten])

  const box: ReactNode = (
    <div className="rounded-lg border border-gray-200 px-3 py-2 text-xs">
      <p className="font-semibold text-gray-700">{t('crm.werbung.tests.pruefung.titel', 'Prüfung durch den Server (noch nichts an Meta gesendet)')}</p>
      {laeuft && <p className="mt-1 flex items-center gap-2 text-gray-500"><Spinner size="sm" />{t('crm.werbung.tests.pruefung.laeuft', 'Wird geprüft …')}</p>}
      {fehler && (
        <div className="mt-1 space-y-1">
          <p className="break-words text-red-700">{fehler}</p>
          <button type="button" onClick={() => void starten()} className="font-semibold text-hp-navy underline">{t('crm.werbung.tests.pruefung.nochmal', 'Nochmal prüfen')}</button>
        </div>
      )}
      {ergebnis && (
        <ul className="mt-1 space-y-0.5 text-gray-600">
          {ergebnis.zeilen.map((z, i) => <li key={`z${i}`}>• {z}</li>)}
          {ergebnis.hinweise.map((h, i) => <li key={`h${i}`} className="text-amber-800">⚠ {h}</li>)}
          {ergebnis.zeilen.length === 0 && ergebnis.hinweise.length === 0 && (
            <li className="text-emerald-700">✓ {t('crm.werbung.tests.pruefung.ok', 'Keine Einwände.')}</li>
          )}
        </ul>
      )}
    </div>
  )

  const sperre: string | null = laeuft
    ? t('crm.werbung.tests.pruefung.warten', 'Die Prüfung läuft noch.')
    : fehler
      ? t('crm.werbung.tests.pruefung.gescheitert', 'Die Prüfung durch den Server ist gescheitert. Erst den Fehler beheben.')
      : null

  return { box, sperre }
}
