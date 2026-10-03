import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AudienceCreateResponse } from '../../../../lib/werbeWerkzeuge'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { Hinweis, MetaAenderungDialog, SchreibSperre, type AenderungPunkt } from './Bausteine'
import { werkzeugFehlerText } from './werkzeugeApi'

// ── Rahmen eines Zielgruppen-Assistenten ─────────────────────────────────────
// Dialog mit Inhalt, Fußzeile (Zurück, Abbrechen, Prüfen und anlegen), der
// Pflichtangaben-Liste und der Zusammenfassung „Das ändert sich bei Meta".
// Beim Öffnen der Zusammenfassung prüft der Server den Auftrag (vorschau: true,
// nichts geht an Meta); erst nach Bestätigung läuft ausfuehren().

export interface AenderungInfo {
  punkte: AenderungPunkt[]
  lernphase: string
  warnungen?: string[]
}

export interface VorschauErgebnis {
  hinweise: string[]
  punkte?: AenderungPunkt[]
}

/** Prüfung durch den Server (vorschau: true) in der Zusammenfassung */
export function useServerVorschau(vorschau?: () => Promise<VorschauErgebnis>) {
  const { t } = useTranslation()
  const [laeuft, setLaeuft] = useState(false)
  const [ergebnis, setErgebnis] = useState<VorschauErgebnis | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const starten = async () => {
    if (!vorschau) return
    setLaeuft(true)
    setErgebnis(null)
    setFehler(null)
    try {
      setErgebnis(await vorschau())
    } catch (err) {
      setFehler(werkzeugFehlerText(err, t))
    } finally {
      setLaeuft(false)
    }
  }
  const box: ReactNode = !vorschau ? null : (
    <div className="rounded-lg border border-gray-200 px-3 py-2 text-xs">
      <p className="font-semibold text-gray-700">{t('crm.werbung.zielgruppen.vorschau.titel', 'Prüfung durch den Server (noch nichts an Meta gesendet)')}</p>
      {laeuft && <p className="mt-1 flex items-center gap-2 text-gray-500"><Spinner size="sm" />{t('crm.werbung.zielgruppen.vorschau.laeuft', 'Wird geprüft …')}</p>}
      {fehler && (
        <div className="mt-1 space-y-1">
          <p className="text-red-700">{fehler}</p>
          <button type="button" onClick={() => void starten()} className="font-semibold text-hp-navy underline">{t('crm.werbung.zielgruppen.vorschau.nochmal', 'Nochmal prüfen')}</button>
        </div>
      )}
      {ergebnis && (
        <ul className="mt-1 space-y-0.5 text-gray-600">
          {ergebnis.hinweise.length === 0 && <li className="text-emerald-700">✓ {t('crm.werbung.zielgruppen.vorschau.ok', 'Keine Einwände.')}</li>}
          {ergebnis.hinweise.map((h, i) => <li key={i}>• {h}</li>)}
        </ul>
      )}
    </div>
  )
  const sperre = !vorschau ? null
    : laeuft ? t('crm.werbung.zielgruppen.vorschau.warten', 'Die Prüfung läuft noch.')
      : fehler ? t('crm.werbung.zielgruppen.vorschau.gescheitert', 'Die Prüfung durch den Server ist gescheitert. Erst den Fehler beheben.')
        : null
  return { starten, box, sperre, punkte: ergebnis?.punkte ?? [] }
}

export default function AssistentRahmen({
  offen, titel, untertitel, onClose, onZurueck, fehler, schreibSperre, pruefSperre, zusatzSperre, aenderung,
  anlegenText, erfolgText, ausfuehren, vorschau, onFertig, children,
}: {
  offen: boolean
  titel: string
  untertitel?: string
  onClose: () => void
  onZurueck?: () => void
  /** Offene Pflichtangaben (leer = bereit) */
  fehler: string[]
  schreibSperre: string | null
  /** Sperrt schon „Prüfen“ (fehlendes Recht). Ohne Angabe gilt schreibSperre.
   *  Ist nur das Anlegen gesperrt, läuft die Prüfung durch den Server, Bestätigen bleibt grau. */
  pruefSperre?: string | null
  /** Weitere Sperre dieses Assistenten (z. B. Lookalike ohne Bestätigung) */
  zusatzSperre?: string | null
  aenderung: () => AenderungInfo
  anlegenText: string
  /** Erfolgsmeldung; bekommt die Antwort (z. B. für die Wohnen-Eignung) */
  erfolgText: (data: unknown) => string
  ausfuehren: () => Promise<unknown>
  /** Gleicher Auftrag mit vorschau: true */
  vorschau?: () => Promise<VorschauErgebnis>
  onFertig: (data: unknown) => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [pruefen, setPruefen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [zeigeFehler, setZeigeFehler] = useState(false)
  const [serverFehler, setServerFehler] = useState<string | null>(null)
  const sv = useServerVorschau(vorschau)

  const sperre = schreibSperre ?? zusatzSperre ?? null
  const knopfSperre = (pruefSperre === undefined ? schreibSperre : pruefSperre) ?? zusatzSperre ?? null
  const info = pruefen ? aenderung() : null

  const weiter = () => {
    setServerFehler(null)
    if (fehler.length) { setZeigeFehler(true); return }
    setPruefen(true)
    void sv.starten()
  }

  const bestaetigen = async () => {
    setBusy(true)
    try {
      const data = await ausfuehren()
      toast.success(erfolgText(data))
      setPruefen(false)
      onFertig(data)
    } catch (err) {
      console.error('[Zielgruppen] Anlegen:', err)
      const text = werkzeugFehlerText(err, t)
      setServerFehler(text)
      setPruefen(false)
      toast.error(text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal open={offen} onClose={onClose} size="lg" title={titel}
        footer={(
          <>
            {onZurueck && (
              <button type="button" onClick={onZurueck} className="hp-btn hp-btn-ghost sm:mr-auto">
                {t('crm.werbung.zielgruppen.zurueck', 'Zurück')}
              </button>
            )}
            <button type="button" onClick={onClose} className="hp-btn hp-btn-ghost">{t('crm.werbung.zielgruppen.abbrechen', 'Abbrechen')}</button>
            <button type="button" onClick={weiter} disabled={!!knopfSperre} title={knopfSperre ?? undefined} className="hp-btn hp-btn-primary">
              {t('crm.werbung.zielgruppen.pruefenAnlegen', 'Prüfen und anlegen')}
            </button>
          </>
        )}>
        <div className="space-y-4">
          {untertitel && <p className="text-sm text-gray-600">{untertitel}</p>}
          <SchreibSperre grund={schreibSperre} />
          {serverFehler && <Hinweis ton="fehler" titel={t('crm.werbung.zielgruppen.serverFehler', 'Meta hat abgelehnt')}>{serverFehler}</Hinweis>}
          {zeigeFehler && fehler.length > 0 && (
            <Hinweis ton="warnung" titel={t('crm.werbung.zielgruppen.fehlt', 'Bitte noch ergänzen:')}>
              <ul className="list-disc pl-4">{fehler.map(f => <li key={f}>{f}</li>)}</ul>
            </Hinweis>
          )}
          {children}
        </div>
      </Modal>
      {info && (
        <MetaAenderungDialog offen={pruefen} punkte={[...info.punkte.filter(p => p.art !== 'gleich'), ...sv.punkte, ...info.punkte.filter(p => p.art === 'gleich')]} lernphase={info.lernphase} warnungen={info.warnungen}
          bestaetigen={anlegenText} busy={busy} gesperrt={sperre ?? sv.sperre} zusatz={sv.box}
          onBestaetigen={() => void bestaetigen()} onClose={() => setPruefen(false)} />
      )}
    </>
  )
}

/** Erfolgsmeldung nach dem Anlegen einer Zielgruppe, mit Metas Wohnen-Eignung */
export function zielgruppeErfolg(t: TFunction, name: string): (data: unknown) => string {
  return (data: unknown) => {
    const sac = (data as Partial<AudienceCreateResponse> | null)?.sac_eligible
    const basis = t('crm.werbung.zielgruppen.angelegt', 'Zielgruppe „{{name}}“ angelegt', { name })
    if (sac === true) return `${basis}. ${t('crm.werbung.zielgruppen.angelegtWohnenJa', 'Meta: für Wohnen geeignet.')}`
    if (sac === false) return `${basis}. ${t('crm.werbung.zielgruppen.angelegtWohnenNein', 'Meta: nicht für Wohnen geeignet.')}`
    return basis
  }
}
