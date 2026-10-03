import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../ui/Badge'
import DataTable, { type DataTableColumn } from '../../ui/DataTable'
import type { ActionItem } from '../../ui/ActionMenu'
import EmptyState from '../../ui/EmptyState'
import Spinner from '../../ui/Spinner'
import { useToast } from '../../ui/Toast'
import { useWerbeFormat } from './format'
import { useWerbeKontext } from './useWerbeDaten'
import { EINGABE_KLEIN, Hinweis, SchreibSperre } from './zielgruppen/Bausteine'
import KundenlisteFreigabe from './zielgruppen/KundenlisteFreigabe'
import NeueZielgruppe, { type ZielgruppenSchritt } from './zielgruppen/NeueZielgruppe'
import ZielgruppeDetail from './zielgruppen/ZielgruppeDetail'
import { artLabel, groesseText, useWerkzeugStatus, wohnenEtikett, type ArtFilter } from './zielgruppen/useWerkzeugStatus'
import {
  ladeZielgruppen, pruefeWohnenEignung, werkzeugFehlerText, type ListenErgebnis, type ZielgruppeZeile,
} from './zielgruppen/werkzeugeApi'

// ── Reiter „Zielgruppen" des Werbemanagers ───────────────────────────────────
// Eigene Zielgruppen des Werbekontos (Custom Audiences) mit Art, Größe,
// Aufbewahrung und Eignung für die Sonderkategorie Wohnen. Neu anlegen über
// Assistenten (Website-Besucher, Interaktion, Kundenliste nur Admin, Lookalike
// gesperrt für Wohnen). Die Freigabe für Kundenlisten (nur Admin) steht unten
// getrennt vom Assistenten. Liste über meta-werkzeuge audiences_list; solange die
// Function nicht live ist, aus dem Katalog des Kampagnen-Assistenten. Lädt
// erst, wenn der Reiter offen ist und die Seitendaten fertig sind.

export default function ZielgruppenTab() {
  const { t } = useTranslation()
  const toast = useToast()
  const fmt = useWerbeFormat()
  const { loading: seiteLaedt } = useWerbeKontext()
  const status = useWerkzeugStatus()

  const [ergebnis, setErgebnis] = useState<ListenErgebnis<ZielgruppeZeile> | null>(null)
  const [laden, setLaden] = useState(true)
  const [ladeFehler, setLadeFehler] = useState<string | null>(null)
  const [suche, setSuche] = useState('')
  const [filter, setFilter] = useState<ArtFilter>('alle')
  const [nurWohnen, setNurWohnen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [schritt, setSchritt] = useState<ZielgruppenSchritt | null>(null)
  const [lookalikeQuelle, setLookalikeQuelle] = useState<string | null>(null)
  const [prueft, setPrueft] = useState(false)

  const lade = useCallback(async (refresh: boolean) => {
    setLaden(true)
    try {
      setErgebnis(await ladeZielgruppen(refresh))
      setLadeFehler(null)
    } catch (err) {
      console.error('[Zielgruppen] Liste:', err)
      setLadeFehler(werkzeugFehlerText(err, t))
    } finally {
      setLaden(false)
    }
  }, [t])

  // Erst nach den Seitendaten (Micro-Instanz, nie parallel)
  const gestartet = useRef(false)
  useEffect(() => {
    if (seiteLaedt || gestartet.current) return
    gestartet.current = true
    void lade(false)
  }, [seiteLaedt, lade])

  const zeilen = useMemo(() => ergebnis?.zeilen ?? [], [ergebnis])
  const zaehler = useMemo(() => {
    const m: Record<ArtFilter, number> = { alle: zeilen.length, website: 0, interaktion: 0, video: 0, kundenliste: 0, lookalike: 0, sonstige: 0 }
    for (const z of zeilen) m[z.art] = (m[z.art] ?? 0) + 1
    return m
  }, [zeilen])

  const sichtbar = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return zeilen
      .filter(z => filter === 'alle' || z.art === filter)
      .filter(z => !nurWohnen || (z.wohnenTauglich === true && !z.gesperrtFuerWohnen))
      .filter(z => !q || z.name.toLowerCase().includes(q) || z.id.includes(q))
      .sort((a, b) => (b.erstellt ?? '').localeCompare(a.erstellt ?? '') || a.name.localeCompare(b.name))
  }, [zeilen, filter, nurWohnen, suche])

  const ungeprueft = useMemo(() => zeilen.filter(z => z.wohnenTauglich === null && z.art !== 'lookalike'), [zeilen])

  // Wohnen-Eignung bei Meta prüfen (Lese-Modus von meta-builder)
  const pruefen = async (liste: ZielgruppeZeile[]) => {
    if (!liste.length || prueft) return
    setPrueft(true)
    try {
      // Treffer früherer Pakete übernehmen, auch wenn ein späteres scheitert
      const { treffer, fehler } = await pruefeWohnenEignung(liste.map(z => z.id))
      if (treffer.size) {
        setErgebnis(prev => prev && ({
          ...prev,
          zeilen: prev.zeilen.map(z => {
            const r = treffer.get(z.id)
            if (!r) return z
            // Sperre folgt dem neuen Ergebnis (sonst blendet „Nur für Wohnen geeignete“ eine jetzt geeignete aus)
            const gesperrt = r.ok === null ? z.gesperrtFuerWohnen : z.art === 'lookalike' || r.ok === false
            return { ...z, wohnenTauglich: r.ok, wohnenGrund: r.grund ?? z.wohnenGrund, gesperrtFuerWohnen: gesperrt }
          }),
        }))
      }
      if (treffer.size || !fehler) toast.success(t('crm.werbung.zielgruppen.geprueft', 'Wohnen-Eignung geprüft: {{n}}', { n: treffer.size }))
      if (fehler) toast.error(werkzeugFehlerText(fehler, t))
    } catch (err) {
      toast.error(werkzeugFehlerText(err, t))
    } finally {
      setPrueft(false)
    }
  }

  const lookalikeAus = (z: ZielgruppeZeile) => {
    setDetailId(null)
    setLookalikeQuelle(z.id)
    setSchritt('lookalike')
  }

  const neu = () => { setLookalikeQuelle(null); setSchritt('wahl') }
  const detail = detailId ? zeilen.find(z => z.id === detailId) ?? null : null
  const nameVon = (id: string | null) => (id ? zeilen.find(z => z.id === id)?.name ?? null : null)

  const spalten: DataTableColumn<ZielgruppeZeile>[] = [
    {
      id: 'name', header: t('crm.werbung.zielgruppen.spalte.name', 'Name'), primary: true,
      cell: z => (
        <span className="block min-w-0">
          <span className="block truncate">{z.name}</span>
          {z.regelText && <span className="block truncate text-[11px] font-normal text-gray-500">{z.regelText}</span>}
        </span>
      ),
    },
    { id: 'art', header: t('crm.werbung.zielgruppen.spalte.art', 'Art'), cell: z => artLabel(t, z.art) },
    { id: 'groesse', header: t('crm.werbung.zielgruppen.spalte.groesse', 'Größe'), align: 'right', cell: z => <span className="whitespace-nowrap tabular-nums">{groesseText(t, fmt.locale, z)}</span> },
    {
      id: 'aufbewahrung', header: t('crm.werbung.zielgruppen.spalte.aufbewahrung', 'Aufbewahrung'), hideBelow: 'sm', align: 'right',
      cell: z => (z.aufbewahrungTage != null ? t('crm.werbung.zielgruppen.tageN', '{{n}} Tage', { n: z.aufbewahrungTage }) : '-'),
    },
    {
      id: 'wohnen', header: t('crm.werbung.zielgruppen.spalte.wohnen', 'Wohnen'),
      cell: z => { const w = wohnenEtikett(t, z); return <Badge tone={w.ton} dot>{w.text}</Badge> },
    },
  ]

  const filterKnoepfe: Array<{ id: ArtFilter; label: string }> = [
    { id: 'alle', label: t('crm.werbung.zielgruppen.filter.alle', 'Alle') },
    ...(['website', 'interaktion', 'video', 'kundenliste', 'lookalike', 'sonstige'] as const).map(a => ({ id: a, label: artLabel(t, a) })),
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 sm:mr-auto">
          <h2 className="font-heading text-xl text-hp-navy">{t('crm.werbung.zielgruppen.titel', 'Zielgruppen')}</h2>
          <p className="mt-0.5 text-sm text-gray-600">
            {t('crm.werbung.zielgruppen.text', 'Eigene Zielgruppen für Retargeting und zum Ausschließen. Unter Wohnen erlaubt: Website-Besucher, Interaktionen und Kundenlisten. Lookalikes sperrt Meta unter Wohnen.')}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 whitespace-nowrap sm:flex-row">
          <button type="button" onClick={() => void lade(true)} disabled={laden} className="hp-btn hp-btn-ghost">
            {laden && <Spinner size="sm" />}
            {t('crm.werbung.zielgruppen.aktualisieren', 'Aktualisieren')}
          </button>
          <button type="button" onClick={neu} className="hp-btn hp-btn-primary">
            + {t('crm.werbung.zielgruppen.neu', 'Neue Zielgruppe')}
          </button>
        </div>
      </div>

      <SchreibSperre grund={status.schreibSperre} />
      {ergebnis?.quelle === 'katalog' && (
        <Hinweis ton="info">{t('crm.werbung.zielgruppen.ausKatalog', 'Vorläufige Liste aus dem Katalog des Kampagnen-Assistenten: Aufbewahrung und Regeln fehlen, bis die neue Server-Funktion live ist.')}</Hinweis>
      )}
      {(ergebnis?.warnungen ?? []).map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}

      {/* Filter */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <input value={suche} onChange={e => setSuche(e.target.value)} placeholder={t('crm.werbung.zielgruppen.suche', 'Name oder ID suchen …')}
          aria-label={t('crm.werbung.zielgruppen.suche', 'Name oder ID suchen …')} className={`${EINGABE_KLEIN} lg:max-w-xs`} />
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="group" aria-label={t('crm.werbung.zielgruppen.filter.aria', 'Nach Art filtern')}>
          {filterKnoepfe.filter(f => f.id === 'alle' || zaehler[f.id] > 0).map(f => (
            <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === f.id ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f.label} <span className="tabular-nums opacity-70">{zaehler[f.id]}</span>
            </button>
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-gray-600">
          <input type="checkbox" checked={nurWohnen} onChange={e => setNurWohnen(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-hp-navy" />
          {t('crm.werbung.zielgruppen.nurWohnen', 'Nur für Wohnen geeignete')}
        </label>
        {ungeprueft.length > 0 && (
          <button type="button" onClick={() => void pruefen(ungeprueft)} disabled={prueft} className="hp-btn hp-btn-ghost min-h-0 shrink-0 whitespace-nowrap px-3 py-1 text-xs">
            {prueft && <Spinner size="sm" />}
            {t('crm.werbung.zielgruppen.eignungPruefen', 'Wohnen-Eignung prüfen ({{n}})', { n: ungeprueft.length })}
          </button>
        )}
      </div>

      {ladeFehler ? (
        <div className="hp-card">
          <EmptyState icon="alert" title={t('crm.werbung.zielgruppen.ladeFehler', 'Zielgruppen konnten nicht geladen werden')}
            text={<span className="break-words">{ladeFehler}</span>}
            action={<button type="button" onClick={() => void lade(true)} className="hp-btn hp-btn-ghost">{t('crm.werbung.zielgruppen.nochmal', 'Nochmal laden')}</button>} />
        </div>
      ) : (
        <DataTable
          columns={spalten}
          rows={sichtbar}
          rowKey={z => z.id}
          loading={laden && !ergebnis}
          onRowClick={z => setDetailId(z.id)}
          rowActionsLabel={z => t('crm.werbung.zielgruppen.aktionenFuer', 'Aktionen für {{name}}', { name: z.name })}
          rowActions={(z): ActionItem[] => [
            { id: 'details', label: t('crm.werbung.zielgruppen.details', 'Details'), icon: 'info', onClick: () => setDetailId(z.id) },
            { id: 'lookalike', label: t('crm.werbung.zielgruppen.detail.lookalike', 'Lookalike daraus'), icon: 'users', hidden: z.art === 'lookalike', onClick: () => lookalikeAus(z) },
            { id: 'pruefen', label: t('crm.werbung.zielgruppen.detail.pruefen', 'Jetzt prüfen'), icon: 'check', hidden: z.art === 'lookalike', disabled: prueft, onClick: () => void pruefen([z]) },
          ]}
          empty={(
            <EmptyState icon="users"
              title={zeilen.length ? t('crm.werbung.zielgruppen.keinTreffer', 'Keine Zielgruppe passt zum Filter') : t('crm.werbung.zielgruppen.leer', 'Noch keine eigenen Zielgruppen')}
              text={zeilen.length ? undefined : t('crm.werbung.zielgruppen.leerText', 'Starte mit „Website-Besucher ohne Termin“: das ist das wärmste Publikum für Retargeting.')}
              action={zeilen.length ? undefined : <button type="button" onClick={neu} className="hp-btn hp-btn-primary">+ {t('crm.werbung.zielgruppen.neu', 'Neue Zielgruppe')}</button>} />
          )}
        />
      )}

      {/* Svens Freigabe für Kundenlisten: getrennt vom Upload-Assistenten */}
      <KundenlisteFreigabe status={status} />

      <ZielgruppeDetail zielgruppe={detail} onClose={() => setDetailId(null)} onLookalike={lookalikeAus}
        onPruefen={z => void pruefen([z])} prueft={prueft} quelleName={detail?.quelleName ?? nameVon(detail?.quelleId ?? null)} />

      <NeueZielgruppe schritt={schritt} setSchritt={setSchritt} status={status} zielgruppen={zeilen}
        lookalikeQuelle={lookalikeQuelle} onFertig={() => void lade(true)} />
    </div>
  )
}
