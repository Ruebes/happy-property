import { useTranslation } from 'react-i18next'
import { feldId } from './Bausteine'
import { FeldHinweise } from './PruefPanel'

/** Auswahl im Formular: Format bzw. „Vorhandenen Beitrag verwenden" (ad.beitrag) */
export type FormatWahlWert = 'single_image' | 'single_video' | 'carousel' | 'beitrag' | 'collection'

// ── Format der Werbeanzeige (wie bei Meta: Anzeigeneinrichtung + Format) ─────
// Einzelbild, Einzelvideo, Karussell, Vorhandenen Beitrag verwenden und
// Sammlung (Instant Experience). Je Karte ein Satz Erklärung. Sammlung ist
// sichtbar, aber gesperrt („folgt"): der Weg über die Schnittstelle braucht
// eine Instant-Experience-Seite (canvas) und ist für Leads nicht belegt.

interface Wahl { wert: FormatWahlWert; titel: string; text: string; sperre?: string }

export default function FormatWahl({ node, value, onChange, disabled, sperre }: {
  node: string
  value: FormatWahlWert
  onChange: (f: FormatWahlWert) => void
  disabled?: boolean
  /** Sperrgrund (Bearbeiten: Format bei Meta nicht änderbar) */
  sperre?: string
}) {
  const { t } = useTranslation()
  const label = t('crm.werbung.builder.format.titel', 'Format')
  const wahlen: Wahl[] = [
    { wert: 'single_image', titel: t('crm.werbung.meta.format.single_image', 'Einzelbild'), text: t('crm.werbung.builder.format.bildText', 'Ein Bild je Platzierung (4:5, 9:16, 1:1, 1,91:1).') },
    { wert: 'single_video', titel: t('crm.werbung.meta.format.single_video', 'Einzelvideo'), text: t('crm.werbung.builder.format.videoText', 'Ein Video je Platzierung, mit Vorschaubild und Untertiteln.') },
    { wert: 'carousel', titel: t('crm.werbung.meta.format.carousel', 'Karussell'), text: t('crm.werbung.builder.format.karussellText', '2 bis 10 Karten zum Wischen, jede mit eigenem Bild oder Video und Link.') },
    { wert: 'beitrag', titel: t('crm.werbung.builder.format.beitrag', 'Vorhandenen Beitrag verwenden'), text: t('crm.werbung.builder.format.beitragText', 'Einen Facebook- oder Instagram-Beitrag oder ein Reel bewerben, mit allen Likes und Kommentaren.') },
    {
      wert: 'collection', titel: t('crm.werbung.builder.format.sammlung', 'Sammlung'), text: t('crm.werbung.builder.format.sammlungText', 'Titelbild oder -video mit Vollbild-Erlebnis (Instant Experience).'),
      sperre: t('crm.werbung.builder.format.sammlungSperre', 'Folgt: braucht ein Instant Experience und ist bei Meta für Lead-Kampagnen nicht als Ziel vorgesehen.'),
    },
  ]
  const aus = !!disabled || !!sperre
  return (
    <div id={feldId('ad.format')} data-einstellung={label} className="scroll-mt-24 space-y-1.5">
      <p className="text-[11px] text-gray-500">{sperre ? '🔒 ' : ''}{label}</p>
      <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {wahlen.map(w => {
          const aktiv = value === w.wert
          const gesperrt = !!w.sperre
          return (
            <button key={w.wert} type="button" role="radio" aria-checked={aktiv} aria-disabled={gesperrt || aus}
              disabled={gesperrt || (aus && !aktiv)} onClick={() => { if (!gesperrt && !aus && !aktiv) onChange(w.wert) }}
              className={`rounded-xl border px-3 py-2.5 text-left text-xs transition-colors ${gesperrt
                ? 'cursor-not-allowed border-dashed border-gray-200 bg-gray-50 opacity-70'
                : aktiv ? 'border-hp-navy bg-hp-navy/5 ring-1 ring-hp-navy' : 'border-gray-200 bg-white hover:border-hp-navy/40 disabled:opacity-60'}`}>
              <span className="block text-sm font-semibold text-hp-navy">{gesperrt ? '🔒 ' : ''}{w.titel}</span>
              <span className="mt-0.5 block leading-snug text-gray-600">{w.text}</span>
              {w.sperre && <span className="mt-1 block text-[10px] leading-snug text-hp-navy/80">{w.sperre}</span>}
            </button>
          )
        })}
      </div>
      {sperre && <p className="text-[10px] leading-snug text-hp-navy/80">{sperre}</p>}
      <FeldHinweise node={node} felder={['ad.format', 'ad.setup', 'ad.beitrag']} />
    </div>
  )
}
