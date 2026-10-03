import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../../ui/Toast'
import { useServerVorschau } from '../zielgruppen/AssistentRahmen'
import { EINGABE_KLEIN, MetaAenderungDialog } from '../zielgruppen/Bausteine'
import { werkzeugCall, werkzeugFehlerText } from '../zielgruppen/werkzeugeApi'
import { GRENZE } from './formularModell'

// ── Sofortformular bei Meta kopieren (leadform_duplicate) ────────────────────
// Gleiches Formular unter neuem Namen, mit Wohnen-Prüfung der Fragen.
// Zusammenfassung „Das ändert sich bei Meta“ samt Server-Prüfung vorab.

export default function KopierenDialog({ quelle, schreibSperre, onClose, onFertig }: {
  quelle: { id: string; name: string } | null
  schreibSperre: string | null
  onClose: () => void
  onFertig: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const sv = useServerVorschau(async () => {
    if (!quelle) return { hinweise: [] }
    const r = await werkzeugCall('leadform_duplicate', { id: quelle.id, name: name.trim() || quelle.name, wohnen: true, vorschau: true })
    return { hinweise: r.hinweise ?? [] }
  })

  useEffect(() => {
    if (!quelle) return
    setName(`${quelle.name} - ${t('crm.werbung.formulare.kopie', 'Kopie')}`.slice(0, GRENZE.name))
    // Prüfung beim Öffnen (nichts geht an Meta)
    void sv.starten()
    // nur beim Öffnen für ein neues Formular
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quelle])

  if (!quelle) return null

  const kopieren = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await werkzeugCall('leadform_duplicate', { id: quelle.id, name: name.trim(), wohnen: true })
      toast.success(t('crm.werbung.formulare.kopiert', 'Kopie „{{name}}“ bei Meta angelegt', { name: name.trim() }))
      onFertig()
    } catch (err) {
      toast.error(werkzeugFehlerText(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <MetaAenderungDialog offen
      titel={t('crm.werbung.formulare.kopierenTitel', 'Formular bei Meta kopieren')}
      punkte={[
        { art: 'neu', text: t('crm.werbung.formulare.kopierenNeu', 'Neues Sofortformular als Kopie von „{{name}}“', { name: quelle.name }) },
        { art: 'gleich', text: t('crm.werbung.formulare.kopierenGleich', 'Das Original und alle Anzeigen bleiben unverändert.') },
      ]}
      lernphase={t('crm.werbung.formulare.aenderung.lernphase', 'Startet nicht neu. Erst wenn du das Formular in einer Anzeige verwendest (neue Anzeige oder Tausch), beginnt die Lernphase der Anzeigengruppe neu.')}
      bestaetigen={t('crm.werbung.formulare.kopierenKnopf', 'Kopie anlegen')}
      busy={busy}
      gesperrt={schreibSperre ?? sv.sperre ?? (name.trim() ? null : t('crm.werbung.formulare.kopierenName', 'Bitte einen Namen eingeben.'))}
      onBestaetigen={() => void kopieren()}
      onClose={onClose}
      zusatz={(
        <>
          <label className="block">
            <span className="text-xs font-semibold text-gray-700">{t('crm.werbung.formulare.kopierenNameLabel', 'Name der Kopie')}</span>
            <input value={name} maxLength={GRENZE.name} onChange={ev => setName(ev.target.value)} className={`${EINGABE_KLEIN} mt-1`} />
          </label>
          {sv.box}
        </>
      )} />
  )
}
