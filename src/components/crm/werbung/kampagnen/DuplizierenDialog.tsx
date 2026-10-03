import { useContext, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import Badge from '../../../ui/Badge'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import type { Level } from '../../../../lib/metaSpec'
import { WerbeKontext } from '../useWerbeDaten'
import { builderCall, fehlerText } from './builderApi'
import {
  KOPIEN_GESAMT_MAX, KOPIEN_MAX, MASSEN_MAX,
  type DuplicateMehrRequest, type DuplizierZiel, type DuplizierZielArt,
} from './bearbeitenTypen'
import { ebeneName, useSchreibSperre } from './bearbeitenHelfer'

// ── Duplizieren bei Meta (wie „Duplizieren" im Werbeanzeigenmanager) ─────────
// Ziel: ursprüngliche, vorhandene oder neue Kampagne bzw. Anzeigengruppe,
// 1 bis 5 Kopien. Kopien entstehen pausiert mit „ - Kopie" im Namen, nichts
// wird gelöscht. Gemischte Auswahl wird je Ebene getrennt kopiert (dann nur in
// das ursprüngliche Ziel). Ruft meta-builder mode 'duplicate' je Ebene auf.

export interface DuplizierenDialogProps {
  offen: boolean
  items: Array<{ level: 'campaign' | 'adset' | 'ad'; id: string; name: string }>
  onClose: () => void
  onFertig?: () => void
}

interface Ergebnis {
  level: Level
  kopien: Array<{ source_id: string; copied_id: string }>
  fehler: string[]
  hinweise: string[]
  neuesZiel: string | null
}

const EBENEN: readonly Level[] = ['campaign', 'adset', 'ad']

export default function DuplizierenDialog({ offen, items, onClose, onFertig }: DuplizierenDialogProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const kontext = useContext(WerbeKontext)
  const { sperre } = useSchreibSperre(offen)

  const [art, setArt] = useState<DuplizierZielArt>('original')
  const [zielId, setZielId] = useState('')
  const [kopien, setKopien] = useState(1)
  const [laeuft, setLaeuft] = useState(false)
  const [ergebnis, setErgebnis] = useState<Ergebnis[] | null>(null)

  // Beim Öffnen zurücksetzen
  useEffect(() => {
    if (!offen) return
    setArt('original'); setZielId(''); setKopien(1); setErgebnis(null); setLaeuft(false)
  }, [offen])

  const ebenen = useMemo(() => EBENEN.filter(l => items.some(i => i.level === l)), [items])
  const gemischt = ebenen.length > 1
  const ebene: Level | null = ebenen.length === 1 ? ebenen[0] : null
  const zuViele = items.length > MASSEN_MAX
  // Kampagnen und gemischte Auswahl: nur in das ursprüngliche Ziel
  const zielWahl = !!ebene && ebene !== 'campaign'

  // Vorhandene Ziele aus dem Abgleich (ad_catalog), ohne Meta-Aufruf
  const ziele = useMemo<SelectOption[]>(() => {
    const katalog = kontext?.catalog ?? []
    if (ebene === 'adset') {
      const m = new Map<string, SelectOption>()
      for (const c of katalog) {
        if (!c.campaign_id || m.has(c.campaign_id)) continue
        m.set(c.campaign_id, { value: c.campaign_id, label: c.campaign_name || c.campaign_id, hint: c.campaign_id })
      }
      return [...m.values()].sort((a, b) => a.label.localeCompare(b.label))
    }
    if (ebene === 'ad') {
      const m = new Map<string, SelectOption>()
      for (const c of katalog) {
        if (!c.adset_id || m.has(c.adset_id)) continue
        m.set(c.adset_id, { value: c.adset_id, label: c.adset_name || c.adset_id, hint: c.campaign_name ?? c.campaign_id })
      }
      return [...m.values()].sort((a, b) => a.label.localeCompare(b.label))
    }
    return []
  }, [kontext?.catalog, ebene])

  const zielTexte: Record<DuplizierZielArt, string> = ebene === 'ad'
    ? {
      original: t('crm.werbung.bearbeiten.dup.zielGruppeOriginal', 'Ursprüngliche Anzeigengruppe'),
      vorhanden: t('crm.werbung.bearbeiten.dup.zielGruppeVorhanden', 'Vorhandene Anzeigengruppe'),
      neu: t('crm.werbung.bearbeiten.dup.zielGruppeNeu', 'Neue Anzeigengruppe (Kopie der ursprünglichen)'),
    }
    : {
      original: t('crm.werbung.bearbeiten.dup.zielKampagneOriginal', 'Ursprüngliche Kampagne'),
      vorhanden: t('crm.werbung.bearbeiten.dup.zielKampagneVorhanden', 'Vorhandene Kampagne'),
      neu: t('crm.werbung.bearbeiten.dup.zielKampagneNeu', 'Neue Kampagne (Kopie der ursprünglichen)'),
    }

  const anzahl = items.length * kopien
  const gruende: string[] = []
  if (sperre) gruende.push(sperre)
  if (!items.length) gruende.push(t('crm.werbung.bearbeiten.dup.nichtsGewaehlt', 'Nichts ausgewählt.'))
  if (zuViele) gruende.push(t('crm.werbung.bearbeiten.zuViele', 'Höchstens {{max}} Objekte auf einmal.', { max: MASSEN_MAX }))
  else if (anzahl > KOPIEN_GESAMT_MAX) gruende.push(t('crm.werbung.bearbeiten.dup.zuVieleKopien', 'Höchstens {{max}} Kopien auf einmal (Objekte mal Anzahl).', { max: KOPIEN_GESAMT_MAX }))
  if (zielWahl && art === 'vorhanden' && !zielId) gruende.push(t('crm.werbung.bearbeiten.dup.zielFehlt', 'Bitte das Ziel auswählen.'))

  const duplizieren = async () => {
    setLaeuft(true)
    const out: Ergebnis[] = []
    try {
      for (const l of ebenen) {
        const ids = items.filter(i => i.level === l).map(i => i.id)
        const ziel: DuplizierZiel = !zielWahl || art === 'original'
          ? { art: 'original' }
          : art === 'vorhanden'
            ? (l === 'adset' ? { art: 'vorhanden', campaign_id: zielId } : { art: 'vorhanden', adset_id: zielId })
            : { art: 'neu' }
        const req: DuplicateMehrRequest = { level: l, ids, ziel, kopien }
        try {
          const r = await builderCall('duplicate', req)
          out.push({
            level: l,
            kopien: Array.isArray(r?.copies) ? r.copies : [],
            fehler: [
              ...(r?.failed ?? []).map(f => `${items.find(i => i.id === f.source_id)?.name ?? f.source_id}: ${f.error ?? ''}`.trim()),
            ],
            hinweise: r?.warnings ?? [],
            neuesZiel: r?.neue_kampagne_id ?? r?.neue_anzeigengruppe_id ?? null,
          })
        } catch (err) {
          out.push({ level: l, kopien: [], fehler: [fehlerText(err, t)], hinweise: [], neuesZiel: null })
        }
      }
      setErgebnis(out)
      const ok = out.reduce((s, e) => s + e.kopien.length, 0)
      const fehler = out.reduce((s, e) => s + e.fehler.length, 0)
      if (ok && !fehler) toast.success(t('crm.werbung.bearbeiten.dup.fertig', '{{n}} Kopien angelegt (pausiert).', { n: ok }))
      else if (ok) toast.info(t('crm.werbung.bearbeiten.dup.teilweise', '{{n}} Kopien angelegt, {{f}} Fehler. Details im Fenster.', { n: ok, f: fehler }))
      else toast.error(t('crm.werbung.bearbeiten.dup.fehlgeschlagen', 'Duplizieren fehlgeschlagen. Details im Fenster.'))
    } finally {
      setLaeuft(false)
    }
  }

  const schliessen = () => {
    if (laeuft) return
    if (ergebnis && ergebnis.some(e => e.kopien.length > 0)) onFertig?.()
    onClose()
  }

  const name = (id: string) => items.find(i => i.id === id)?.name ?? id

  const footer = ergebnis ? (
    <div className="flex w-full justify-end">
      <button type="button" onClick={schliessen} className="hp-btn hp-btn-primary">{t('crm.werbung.bearbeiten.schliessen', 'Schließen')}</button>
    </div>
  ) : (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <p className="min-w-0 text-[11px] text-gray-500 sm:mr-auto">{gruende.join(' ')}</p>
      <div className="flex gap-2">
        <button type="button" onClick={schliessen} disabled={laeuft} className="hp-btn hp-btn-ghost">{t('crm.werbung.bearbeiten.abbrechen', 'Abbrechen')}</button>
        <button type="button" onClick={() => void duplizieren()} disabled={laeuft || gruende.length > 0} className="hp-btn hp-btn-primary disabled:opacity-50">
          {laeuft && <Spinner size="sm" />}
          {t('crm.werbung.bearbeiten.dup.knopf', '{{n}} Kopien anlegen (pausiert)', { n: anzahl })}
        </button>
      </div>
    </div>
  )

  return (
    <Modal open={offen} onClose={schliessen} size="lg" closeOnBackdrop={!laeuft} footer={footer}
      title={t('crm.werbung.bearbeiten.dup.titel', 'Duplizieren')}>
      {ergebnis ? (
        <div className="space-y-3 text-sm">
          {ergebnis.map(e => (
            <div key={e.level} className="rounded-lg border border-gray-200 p-3">
              <p className="text-xs font-semibold text-hp-navy">{ebeneName(t, e.level, true)}</p>
              {e.kopien.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {e.kopien.map((k, i) => (
                    <li key={`${k.source_id}-${k.copied_id}-${i}`} className="flex flex-wrap gap-x-2">
                      <span className="text-emerald-700" aria-hidden="true">✓</span>
                      <span className="min-w-0 truncate text-gray-700">{name(k.source_id)}</span>
                      <span className="text-gray-400">→ {k.copied_id}</span>
                    </li>
                  ))}
                </ul>
              )}
              {e.neuesZiel && (
                <p className="mt-1 text-xs text-gray-600">{t('crm.werbung.bearbeiten.dup.neuesZiel', 'Neu angelegt als Ziel: {{id}}', { id: e.neuesZiel })}</p>
              )}
              {e.hinweise.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[11px] text-amber-800">
                  {e.hinweise.map((h, i) => <li key={i}>{h}</li>)}
                </ul>
              )}
              {e.fehler.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-red-700">
                  {e.fehler.map((f, i) => <li key={i}><span aria-hidden="true">✕ </span>{f}</li>)}
                </ul>
              )}
              {!e.kopien.length && !e.fehler.length && (
                <p className="mt-1 text-xs text-gray-500">{t('crm.werbung.bearbeiten.dup.keineAntwort', 'Meta hat keine Kopien gemeldet.')}</p>
              )}
            </div>
          ))}
          <p className="text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.dup.nachher', 'Die Kopien sind pausiert und erscheinen nach dem nächsten Abgleich in der Übersicht.')}</p>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.dup.auswahl', 'Ausgewählt: {{n}}', { n: items.length })}</p>
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-gray-100 p-2">
              {items.map(i => (
                <li key={`${i.level}-${i.id}`} className="flex items-center gap-2 text-xs">
                  <Badge tone="neutral">{ebeneName(t, i.level)}</Badge>
                  <span className="min-w-0 truncate text-gray-800" title={i.id}>{i.name || i.id}</span>
                </li>
              ))}
            </ul>
            {gemischt && (
              <p className="mt-1 text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.dup.gemischt', 'Gemischte Auswahl: jede Ebene wird für sich in ihr ursprüngliches Ziel kopiert.')}</p>
            )}
          </div>

          {zielWahl && (
            <fieldset className="space-y-1.5">
              <legend className="text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.dup.ziel', 'Kopieren in')}</legend>
              {(['original', 'vorhanden', 'neu'] as const).map(a => (
                <label key={a} className="flex items-start gap-2 text-xs text-gray-700">
                  <input type="radio" name="dup-ziel" checked={art === a} onChange={() => setArt(a)} className="mt-0.5" />
                  <span>{zielTexte[a]}</span>
                </label>
              ))}
              {art === 'vorhanden' && (
                <div className="pl-6">
                  {ziele.length ? (
                    <CustomSelect value={zielId} onChange={setZielId} options={ziele}
                      placeholder={ebene === 'ad'
                        ? t('crm.werbung.bearbeiten.dup.gruppeWaehlen', 'Anzeigengruppe wählen …')
                        : t('crm.werbung.bearbeiten.dup.kampagneWaehlen', 'Kampagne wählen …')} />
                  ) : (
                    <input value={zielId} onChange={ev => setZielId(ev.target.value.replace(/\D/g, ''))} inputMode="numeric"
                      placeholder={t('crm.werbung.bearbeiten.dup.idEingeben', 'Meta-ID eingeben')}
                      className="w-full rounded-lg border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-200" />
                  )}
                </div>
              )}
            </fieldset>
          )}
          {ebene === 'campaign' && (
            <p className="text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.dup.kampagneHinweis', 'Kampagnen werden im selben Werbekonto kopiert.')}</p>
          )}

          <div>
            <p className="text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.dup.anzahl', 'Anzahl Kopien je Objekt')}</p>
            <div role="radiogroup" aria-label={t('crm.werbung.bearbeiten.dup.anzahl', 'Anzahl Kopien je Objekt')}
              className="mt-1 inline-flex overflow-hidden rounded-lg border border-gray-200">
              {Array.from({ length: KOPIEN_MAX }, (_, i) => i + 1).map(n => (
                <button key={n} type="button" role="radio" aria-checked={kopien === n} onClick={() => setKopien(n)}
                  className={`min-w-[2.75rem] px-3 py-1.5 text-sm tabular-nums ${kopien === n ? 'bg-hp-navy text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div role="note" className="space-y-1 rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-xs text-hp-navy">
            <p className="font-semibold">{t('crm.werbung.bearbeiten.dup.zusammenfassung', 'Es entstehen {{n}} Kopien, alle pausiert.', { n: anzahl })}</p>
            <p>{t('crm.werbung.bearbeiten.dup.regeln', 'Der Name bekommt „ - Kopie“ angehängt. Die Originale bleiben unverändert, gelöscht wird nichts.')}</p>
            <p>{t('crm.werbung.bearbeiten.dup.lernphase', 'Kopien starten ohne den Verlauf der Originale und durchlaufen eine eigene Lernphase.')}</p>
          </div>
        </div>
      )}
    </Modal>
  )
}
