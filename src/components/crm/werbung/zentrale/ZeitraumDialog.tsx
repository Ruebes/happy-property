import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import type { Vergleich, ZeitraumWahl } from './typen'
import { isoTag, kopfZeitraum, vorgabeZeitraum, vorherigerZeitraum, zeitraumOk, ZEITRAUM_VORGABEN } from './zeitraum'

// ── Datumsbereich + „Vergleichen" (wie das Datums-Menü bei Meta) ─────────────
// „Wie oben" nutzt die Zahlen aus der Datenbank (Zeitraum im Kopf des
// Werbemanagers). Jeder andere Zeitraum und jeder Vergleich holt die Zahlen
// nach „Aktualisieren" direkt bei Meta.

interface Props {
  offen: boolean
  tage: number
  zeitraum: ZeitraumWahl
  vergleich: Vergleich
  onClose: () => void
  onAktualisieren: (z: ZeitraumWahl, v: Vergleich) => void
}

export default function ZeitraumDialog({ offen, tage, zeitraum, vergleich, onClose, onAktualisieren }: Props) {
  const { t } = useTranslation()
  const [wahl, setWahl] = useState<string>('kopf')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [vgl, setVgl] = useState<Vergleich>(vergleich)

  useEffect(() => {
    if (!offen) return
    if (zeitraum.art === 'kopf') {
      const k = kopfZeitraum(tage)
      setWahl('kopf'); setSince(k.since); setUntil(k.until)
    } else {
      setWahl(zeitraum.vorgabe); setSince(zeitraum.since); setUntil(zeitraum.until)
    }
    setVgl(vergleich)
  }, [offen, zeitraum, vergleich, tage])

  const waehle = (id: string) => {
    setWahl(id)
    const z = id === 'kopf' ? kopfZeitraum(tage) : vorgabeZeitraum(id)
    if (z) { setSince(z.since); setUntil(z.until) }
  }

  const ok = zeitraumOk(since, until)
  const vglAuto = ok ? vorherigerZeitraum(since, until) : null
  const vglSince = vgl.automatisch ? vglAuto?.since ?? '' : vgl.since
  const vglUntil = vgl.automatisch ? vglAuto?.until ?? '' : vgl.until
  const vglOk = !vgl.an || zeitraumOk(vglSince, vglUntil)

  const anwenden = () => {
    if (!ok || !vglOk) return
    const z: ZeitraumWahl = wahl === 'kopf' ? { art: 'kopf' } : { art: 'frei', vorgabe: wahl, since, until }
    onAktualisieren(z, vgl.an ? { an: true, automatisch: vgl.automatisch, since: vglSince, until: vglUntil } : { ...vgl, an: false })
  }

  const heute = isoTag(new Date())
  const datumCls = 'border border-gray-200 rounded-lg px-2 py-1.5 text-sm w-full'

  return (
    <Modal open={offen} onClose={onClose} size="md" title={t('crm.werbung.zentrale.zeit.titel', 'Zeitraum')}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="hp-btn hp-btn-ghost" onClick={onClose}>{t('common.cancel', 'Abbrechen')}</button>
          <button type="button" className="hp-btn hp-btn-primary" disabled={!ok || !vglOk} onClick={anwenden}>
            {t('crm.werbung.zentrale.zeit.aktualisieren', 'Aktualisieren')}
          </button>
        </div>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" onClick={() => waehle('kopf')} aria-pressed={wahl === 'kopf'}
            className={`col-span-2 text-left px-3 py-2 rounded-lg border text-sm ${wahl === 'kopf' ? 'border-orange-300 bg-orange-50 text-orange-900 font-semibold' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
            {t('crm.werbung.zentrale.zeit.wieOben', 'Wie oben: {{n}} Tage (Zahlen aus der Datenbank)', { n: tage })}
          </button>
          {ZEITRAUM_VORGABEN.map(v => (
            <button key={v.id} type="button" onClick={() => waehle(v.id)} aria-pressed={wahl === v.id}
              className={`text-left px-3 py-2 rounded-lg border text-sm ${wahl === v.id ? 'border-orange-300 bg-orange-50 text-orange-900 font-semibold' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
              {t(v.label.k, v.label.d)}
            </button>
          ))}
        </div>

        {wahl !== 'kopf' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-gray-500 flex flex-col gap-0.5">
              {t('crm.werbung.zentrale.zeit.von', 'Von')}
              <input type="date" value={since} max={heute} onChange={e => { setSince(e.target.value); setWahl('eigen') }} className={datumCls} />
            </label>
            <label className="text-[11px] text-gray-500 flex flex-col gap-0.5">
              {t('crm.werbung.zentrale.zeit.bis', 'Bis')}
              <input type="date" value={until} max={heute} onChange={e => { setUntil(e.target.value); setWahl('eigen') }} className={datumCls} />
            </label>
            {!ok && <p className="col-span-2 text-[11px] text-red-600">{t('crm.werbung.zentrale.zeit.ungueltig', 'Bitte einen gültigen Zeitraum wählen (Von vor Bis, nicht in der Zukunft).')}</p>}
          </div>
        )}

        <div className="rounded-xl border border-gray-200 p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
            <input type="checkbox" checked={vgl.an} onChange={e => setVgl(v => ({ ...v, an: e.target.checked }))} />
            {t('crm.werbung.zentrale.zeit.vergleichen', 'Vergleichen')}
          </label>
          {vgl.an && (
            <>
              <div className="flex flex-wrap gap-3 text-sm text-gray-700">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={vgl.automatisch} onChange={() => setVgl(v => ({ ...v, automatisch: true }))} />
                  {t('crm.werbung.zentrale.zeit.vorheriger', 'Vorheriger Zeitraum')}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={!vgl.automatisch}
                    onChange={() => setVgl(v => ({ ...v, automatisch: false, since: v.since || vglAuto?.since || '', until: v.until || vglAuto?.until || '' }))} />
                  {t('crm.werbung.zentrale.zeit.eigenerVergleich', 'Benutzerdefiniert')}
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="date" value={vglSince} max={heute} disabled={vgl.automatisch} aria-label={t('crm.werbung.zentrale.zeit.vergleichVon', 'Vergleich von')}
                  onChange={e => setVgl(v => ({ ...v, since: e.target.value }))} className={`${datumCls} disabled:bg-gray-50`} />
                <input type="date" value={vglUntil} max={heute} disabled={vgl.automatisch} aria-label={t('crm.werbung.zentrale.zeit.vergleichBis', 'Vergleich bis')}
                  onChange={e => setVgl(v => ({ ...v, until: e.target.value }))} className={`${datumCls} disabled:bg-gray-50`} />
              </div>
              {!vglOk && <p className="text-[11px] text-red-600">{t('crm.werbung.zentrale.zeit.vergleichUngueltig', 'Der Vergleichszeitraum ist ungültig.')}</p>}
            </>
          )}
        </div>

        {(wahl !== 'kopf' || vgl.an) && (
          <p className="text-[11px] text-gray-500">
            {t('crm.werbung.zentrale.zeit.metaHinweis', 'Diese Zahlen kommen direkt von Meta (drei Abrufe nacheinander, danach zwischengespeichert). CRM-Spalten bleiben beim Zeitraum oben.')}
          </p>
        )}
      </div>
    </Modal>
  )
}
