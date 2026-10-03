import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import type { CropBox } from '../../../../lib/metaSpec'
import { SEITEN_ZAHL, type SlotSeiten } from './r23Typen'

// ── Zuschneiden (Metas image_crops) ──────────────────────────────────────────
// Rahmen im festen Seitenverhältnis über dem Originalbild: ziehen zum
// Verschieben, Ecke oder Regler zum Vergrößern. Ergebnis in Pixeln des
// Originals [[links, oben], [rechts, unten]]. Meta schneidet beim Ausspielen
// zu, das Original bleibt unverändert in der Bibliothek.

interface Rahmen { x: number; y: number; w: number }

// Ganze Pixel nach unten runden: so ragt der Ausschnitt nie über den Bildrand (Meta lehnt das ab)
const groesster = (bw: number, bh: number, r: number): Rahmen => {
  const w = Math.floor(Math.min(bw, bh * r))
  return { x: Math.floor((bw - w) / 2), y: Math.floor((bh - w / r) / 2), w }
}

export function rahmenAus(z: CropBox | undefined, bw: number, bh: number, r: number): Rahmen {
  if (!z) return groesster(bw, bh, r)
  const [[x1, y1], [x2]] = z
  const w = Math.floor(Math.max(10, Math.min(x2 - x1, bw, bh * r)))
  return { x: Math.floor(Math.max(0, Math.min(x1, bw - w))), y: Math.floor(Math.max(0, Math.min(y1, bh - w / r))), w }
}

/** CSS für eine Vorschau des Ausschnitts (Hintergrundbild im Rahmen) */
export function ausschnittStil(url: string, z: CropBox, bw: number, bh: number): { backgroundImage: string; backgroundSize: string; backgroundPosition: string } {
  const [[x1, y1], [x2, y2]] = z
  const w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1)
  const px = bw - w > 0 ? (x1 / (bw - w)) * 100 : 0
  const py = bh - h > 0 ? (y1 / (bh - h)) * 100 : 0
  return {
    backgroundImage: `url("${url.replace(/"/g, '%22')}")`,
    backgroundSize: `${(bw / w) * 100}% ${(bh / h) * 100}%`,
    backgroundPosition: `${px}% ${py}%`,
  }
}

export default function ZuschnittDialog({ open, onClose, onFertig, bildUrl, breite, hoehe, seiten, start, titel }: {
  open: boolean
  onClose: () => void
  onFertig: (z: CropBox) => void
  bildUrl: string
  /** Originalmaße in Pixeln */
  breite: number
  hoehe: number
  seiten: SlotSeiten
  start?: CropBox
  titel?: string
}) {
  const { t } = useTranslation()
  const r = SEITEN_ZAHL[seiten]
  const [rahmen, setRahmen] = useState<Rahmen>(() => rahmenAus(start, breite, hoehe, r))
  const [anzeige, setAnzeige] = useState(0)
  const bildRef = useRef<HTMLImageElement>(null)
  const zug = useRef<{ art: 'bewegen' | 'groesse'; px: number; py: number; ausgang: Rahmen } | null>(null)

  useEffect(() => { if (open) setRahmen(rahmenAus(start, breite, hoehe, r)) }, [open, start, breite, hoehe, r])

  // Anzeigebreite messen (Fenster, Telefon quer/hoch)
  useEffect(() => {
    if (!open) return
    const el = bildRef.current
    if (!el) return
    const messen = () => setAnzeige(el.clientWidth)
    messen()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(messen) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [open, bildUrl])

  const massstab = anzeige > 0 && breite > 0 ? anzeige / breite : 0
  const maxW = Math.min(breite, hoehe * r)
  const minW = Math.max(20, Math.round(maxW * 0.2))
  const begrenze = (x: number, y: number, w: number): Rahmen => {
    const ww = Math.floor(Math.max(minW, Math.min(maxW, w)))
    const hh = ww / r
    return { x: Math.floor(Math.max(0, Math.min(x, breite - ww))), y: Math.floor(Math.max(0, Math.min(y, hoehe - hh))), w: ww }
  }

  const runter = (art: 'bewegen' | 'groesse') => (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault()
    ev.stopPropagation()
    ev.currentTarget.setPointerCapture(ev.pointerId)
    zug.current = { art, px: ev.clientX, py: ev.clientY, ausgang: rahmen }
  }
  const bewegen = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const z = zug.current
    if (!z || !massstab) return
    const dx = (ev.clientX - z.px) / massstab
    const dy = (ev.clientY - z.py) / massstab
    if (z.art === 'bewegen') setRahmen(begrenze(z.ausgang.x + dx, z.ausgang.y + dy, z.ausgang.w))
    else setRahmen(begrenze(z.ausgang.x, z.ausgang.y, z.ausgang.w + Math.max(dx, dy * r)))
  }
  const hoch = () => { zug.current = null }

  const h = rahmen.w / r
  // nie über den Bildrand (Rundung bei halben Pixeln)
  const ergebnis: CropBox = [[rahmen.x, rahmen.y], [Math.min(breite, Math.round(rahmen.x + rahmen.w)), Math.min(hoehe, Math.round(rahmen.y + h))]]

  return (
    <Modal open={open} onClose={onClose} size="lg" title={titel ?? t('crm.werbung.builder.zuschnitt.titel', 'Zuschneiden ({{seiten}})', { seiten })}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1.5 text-xs">{t('crm.werbung.builder.abbrechen', 'Abbrechen')}</button>
          <button type="button" onClick={() => { onFertig(ergebnis); onClose() }} className="hp-btn hp-btn-primary min-h-0 px-3 py-1.5 text-xs">
            {t('crm.werbung.builder.zuschnitt.uebernehmen', 'Ausschnitt übernehmen')}
          </button>
        </div>
      )}>
      <div className="space-y-3">
        <p className="text-xs text-gray-600">{t('crm.werbung.builder.zuschnitt.text', 'Rahmen verschieben und über die Ecke oder den Regler vergrößern. Meta zeigt in dieser Platzierung nur den Ausschnitt, das Original bleibt unverändert.')}</p>
        <div className="flex justify-center">
          <div className="relative inline-block touch-none select-none" onPointerMove={bewegen} onPointerUp={hoch} onPointerCancel={hoch}>
            <img ref={bildRef} src={bildUrl} alt="" draggable={false} onLoad={() => setAnzeige(bildRef.current?.clientWidth ?? 0)}
              className="block max-h-[55vh] max-w-full" />
            {massstab > 0 && (
              <>
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/45"
                  style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rahmen.x * massstab}px ${rahmen.y * massstab}px, ${rahmen.x * massstab}px ${(rahmen.y + h) * massstab}px, ${(rahmen.x + rahmen.w) * massstab}px ${(rahmen.y + h) * massstab}px, ${(rahmen.x + rahmen.w) * massstab}px ${rahmen.y * massstab}px, ${rahmen.x * massstab}px ${rahmen.y * massstab}px)` }} />
                <div role="presentation" onPointerDown={runter('bewegen')}
                  className="absolute cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
                  style={{ left: rahmen.x * massstab, top: rahmen.y * massstab, width: rahmen.w * massstab, height: h * massstab }}>
                  <div role="presentation" onPointerDown={runter('groesse')}
                    className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-hp-navy" />
                </div>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-700">
          <label className="flex min-w-[12rem] flex-1 items-center gap-2">
            <span>{t('crm.werbung.builder.zuschnitt.groesse', 'Größe')}</span>
            <input type="range" min={minW} max={Math.max(minW, Math.round(maxW))} value={Math.round(rahmen.w)}
              onChange={ev => {
                const w = Number(ev.target.value)
                const cx = rahmen.x + rahmen.w / 2, cy = rahmen.y + h / 2
                setRahmen(begrenze(cx - w / 2, cy - w / r / 2, w))
              }}
              aria-label={t('crm.werbung.builder.zuschnitt.groesse', 'Größe')} className="flex-1" />
          </label>
          <button type="button" onClick={() => setRahmen(groesster(breite, hoehe, r))} className="font-semibold text-hp-navy underline">
            {t('crm.werbung.builder.zuschnitt.maximal', 'Größter Ausschnitt, mittig')}
          </button>
          <span className="tabular-nums text-gray-500">{Math.round(rahmen.w)} × {Math.round(h)} px</span>
        </div>
        {rahmen.w < 600 && (
          <p className="text-[11px] text-amber-800">{t('crm.werbung.builder.zuschnitt.klein', 'Der Ausschnitt ist schmaler als 600 Pixel. Meta kann ihn als zu klein ablehnen.')}</p>
        )}
      </div>
    </Modal>
  )
}
