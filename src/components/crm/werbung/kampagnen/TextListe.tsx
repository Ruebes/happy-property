import { useTranslation } from 'react-i18next'
import { DASH_CHARS } from '../../../../lib/metaLint'
import { INPUT_CLS } from '../felder'
import { FeldHinweise } from './PruefPanel'
import { feldId } from './Bausteine'

// ── Textvarianten (Primärer Text, Überschrift, Beschreibung) ─────────────────
// Bis zu max Varianten je Feld, Zähler immer sichtbar (HP-Grenze bzw. sichtbare
// Zeichen ohne „Mehr anzeigen"), Gedankenstriche sofort rot markiert.

export default function TextListe({ node, feld, label, werte, onChange, zaehler, mehrzeilig, max, disabled, hilfe, idZusatz }: {
  node: string; feld: string; label: string; werte: string[]; onChange: (w: string[]) => void
  zaehler?: number; mehrzeilig?: boolean; max: number; disabled: boolean; hilfe?: string
  /** zweite Liste zum selben Feld (z. B. englische Sprachvariante): eigene DOM-Id, keine doppelten Meldungen */
  idZusatz?: string
}) {
  const { t } = useTranslation()
  const liste = werte.length ? werte : ['']
  const setze = (i: number, v: string) => onChange(liste.map((x, j) => (j === i ? v : x)))
  return (
    <div id={idZusatz ? `${feldId(feld)}-${idZusatz}` : feldId(feld)} data-einstellung={label} className="scroll-mt-24 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-gray-500">{label}</span>
        <span className="text-[10px] text-gray-400">{t('crm.werbung.builder.anzeige.varianten', '{{n}} von {{max}}', { n: liste.length, max })}</span>
      </div>
      {hilfe && <p className="-mt-1 text-[10px] text-gray-400">{hilfe}</p>}
      {liste.map((w, i) => {
        const len = w.trim().length
        const zuLang = zaehler !== undefined && len > zaehler
        const strich = DASH_CHARS.test(w)
        return (
          <div key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {mehrzeilig ? (
                <textarea value={w} rows={4} disabled={disabled} onChange={ev => setze(i, ev.target.value)}
                  aria-label={`${label} ${i + 1}`} className={`${INPUT_CLS} resize-y`} />
              ) : (
                <input value={w} disabled={disabled} onChange={ev => setze(i, ev.target.value)}
                  aria-label={`${label} ${i + 1}`} className={INPUT_CLS} />
              )}
              <span className="mt-0.5 flex items-start justify-between gap-2 text-[10px]">
                <span className="font-semibold text-red-600">
                  {strich ? t('crm.werbung.builder.anzeige.strich', 'Gedankenstrich gefunden: bitte normalen Bindestrich nehmen.') : ''}
                </span>
                {zaehler !== undefined && (
                  <span className={`shrink-0 tabular-nums ${zuLang && !mehrzeilig ? 'font-semibold text-red-600' : 'text-gray-400'}`}>
                    {mehrzeilig
                      ? t('crm.werbung.builder.anzeige.sichtbar', '{{len}} Zeichen, sichtbar bis {{max}}', { len, max: zaehler })
                      : `${len} / ${zaehler}`}
                  </span>
                )}
              </span>
            </div>
            {liste.length > 1 && !disabled && (
              <button type="button" onClick={() => onChange(liste.filter((_, j) => j !== i))}
                aria-label={t('crm.werbung.builder.anzeige.varianteEntfernen', 'Variante {{n}} entfernen', { n: i + 1 })}
                className="mt-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">✕</button>
            )}
          </div>
        )
      })}
      {liste.length < max && !disabled && (
        <button type="button" onClick={() => onChange([...liste, ''])} className="text-xs font-semibold text-hp-navy hover:underline">
          + {t('crm.werbung.builder.anzeige.variante', 'Variante hinzufügen')}
        </button>
      )}
      {!idZusatz && <FeldHinweise node={node} felder={feld} />}
    </div>
  )
}
