import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge, { type BadgeTone } from '../../ui/Badge'
import DataTable, { type DataTableColumn } from '../../ui/DataTable'
import type { ActionItem } from '../../ui/ActionMenu'
import { useConfirm } from '../../ui/ConfirmDialog'
import EmptyState from '../../ui/EmptyState'
import Spinner from '../../ui/Spinner'
import { LEADFORM_TYP_LABEL, LEADFORM_WOHNEN_GRUND } from '../../../lib/werbeWerkzeuge'
import { useWerbeFormat } from './format'
import { useWerbeKontext } from './useWerbeDaten'
import FormularEditor, { type EditorStart } from './formulare/FormularEditor'
import KopierenDialog from './formulare/KopierenDialog'
import { entwurfAusSpeicher, hpStandard, type FormularEntwurf } from './formulare/formularModell'
import { EINGABE_KLEIN, Hinweis, SchreibSperre } from './zielgruppen/Bausteine'
import { useWerkzeugStatus } from './zielgruppen/useWerkzeugStatus'
import { ladeFormulare, werkzeugFehlerText, type FormularZeile, type ListenErgebnis } from './zielgruppen/werkzeugeApi'

// ── Reiter „Sofortformulare" des Werbemanagers ───────────────────────────────
// Formulare der Facebook-Seite (meta-werkzeuge leadforms_list; solange die
// Function nicht live ist, aus dem Katalog des Assistenten), Editor mit
// Live-Vorschau, Kopieren. Bei Meta wird nichts geändert, archiviert oder
// gelöscht: bestehende Formulare sind unveränderlich, Neues entsteht als Kopie.
// Ein angefangenes neues Formular merkt sich der Browser (nur dieser Nutzer).

const SPEICHER = 'hp.werbung.formularEntwurf.v1'

const liesEntwurf = (): FormularEntwurf | null => {
  try { return entwurfAusSpeicher(window.localStorage.getItem(SPEICHER)) } catch { return null }
}
const schreibEntwurf = (e: FormularEntwurf | null) => {
  try {
    if (e) window.localStorage.setItem(SPEICHER, JSON.stringify(e))
    else window.localStorage.removeItem(SPEICHER)
  } catch { /* ohne Speicher: Entwurf nur bis zum Schließen */ }
}

export default function FormulareTab() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const fmt = useWerbeFormat()
  const { loading: seiteLaedt } = useWerbeKontext()
  const status = useWerkzeugStatus()

  const [ergebnis, setErgebnis] = useState<ListenErgebnis<FormularZeile> | null>(null)
  const [laden, setLaden] = useState(true)
  const [ladeFehler, setLadeFehler] = useState<string | null>(null)
  const [suche, setSuche] = useState('')
  const [editor, setEditor] = useState<EditorStart | null>(null)
  const [kopieren, setKopieren] = useState<{ id: string; name: string } | null>(null)
  const [gemerkt, setGemerkt] = useState<FormularEntwurf | null>(() => liesEntwurf())

  const lade = useCallback(async (refresh: boolean) => {
    setLaden(true)
    try {
      setErgebnis(await ladeFormulare(refresh))
      setLadeFehler(null)
    } catch (err) {
      console.error('[Formulare] Liste:', err)
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

  // Entwurf gebündelt merken (nicht bei jedem Tastendruck)
  const merkTimer = useRef<number | null>(null)
  const merke = useCallback((e: FormularEntwurf) => {
    if (merkTimer.current) window.clearTimeout(merkTimer.current)
    merkTimer.current = window.setTimeout(() => { schreibEntwurf(e); setGemerkt(e) }, 600)
  }, [])
  useEffect(() => () => { if (merkTimer.current) window.clearTimeout(merkTimer.current) }, [])

  const verwerfen = () => {
    if (merkTimer.current) window.clearTimeout(merkTimer.current)
    schreibEntwurf(null)
    setGemerkt(null)
  }
  // Ein angefangener Entwurf wird nie stillschweigend überschrieben
  const neu = async () => {
    if (gemerkt) {
      const ok = await confirm({
        title: t('crm.werbung.formulare.neuFrage', 'Angefangenen Entwurf verwerfen?'),
        message: t('crm.werbung.formulare.neuFrageText', 'In diesem Browser ist noch „{{name}}“ angefangen. Ein neues Formular ersetzt diesen Entwurf. Zum Weitermachen stattdessen „Entwurf fortsetzen“ wählen.', { name: gemerkt.name }),
        confirmLabel: t('crm.werbung.formulare.neuVerwerfen', 'Verwerfen und neu beginnen'),
        tone: 'danger',
      })
      if (!ok) return
      verwerfen()
    }
    setEditor({ art: 'neu', entwurf: hpStandard(t) })
  }
  const fortsetzen = () => { if (gemerkt) setEditor({ art: 'neu', entwurf: gemerkt }) }

  const angelegt = () => {
    if (merkTimer.current) window.clearTimeout(merkTimer.current)
    if (editor?.art === 'neu') verwerfen()
    setEditor(null)
    void lade(true)
  }

  const zeilen = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return (ergebnis?.zeilen ?? [])
      .filter(f => !q || f.name.toLowerCase().includes(q) || f.id.includes(q))
      .sort((a, b) => (b.erstellt ?? '').localeCompare(a.erstellt ?? '') || a.name.localeCompare(b.name))
  }, [ergebnis, suche])

  const statusEtikett = (s: string | null): { ton: BadgeTone; text: string } => {
    switch ((s ?? '').toUpperCase()) {
      case 'ACTIVE': return { ton: 'success', text: t('crm.werbung.formulare.status.ACTIVE', 'Aktiv') }
      case 'ARCHIVED': return { ton: 'neutral', text: t('crm.werbung.formulare.status.ARCHIVED', 'Archiviert') }
      case 'DRAFT': return { ton: 'info', text: t('crm.werbung.formulare.status.DRAFT', 'Entwurf') }
      case 'DELETED': return { ton: 'neutral', text: t('crm.werbung.formulare.status.DELETED', 'Gelöscht') }
      default: return { ton: 'neutral', text: s || '-' }
    }
  }
  const spracheText = (l: string | null) => {
    const v = (l ?? '').toLowerCase()
    if (v.startsWith('de')) return t('crm.werbung.formulare.sprache.de', 'Deutsch')
    if (v.startsWith('en')) return t('crm.werbung.formulare.sprache.en', 'Englisch')
    return l || '-'
  }

  const spalten: DataTableColumn<FormularZeile>[] = [
    {
      id: 'name', header: t('crm.werbung.formulare.spalte.name', 'Name'), primary: true,
      cell: f => (
        <span className="block min-w-0">
          <span className="block truncate">{f.name}</span>
          <span className="block truncate font-mono text-[11px] font-normal text-gray-500">{f.id}</span>
        </span>
      ),
    },
    {
      id: 'typ', header: t('crm.werbung.formulare.spalte.typ', 'Formulartyp'), hideBelow: 'sm',
      cell: f => (f.hoehereAbsicht == null ? '-' : f.hoehereAbsicht
        ? t('crm.werbung.formulare.typ.HIGHER_INTENT', LEADFORM_TYP_LABEL.HIGHER_INTENT)
        : t('crm.werbung.formulare.typ.MORE_VOLUME', LEADFORM_TYP_LABEL.MORE_VOLUME)),
    },
    { id: 'status', header: t('crm.werbung.formulare.spalte.status', 'Status'), cell: f => { const s = statusEtikett(f.status); return <Badge tone={s.ton} dot>{s.text}</Badge> } },
    { id: 'sprache', header: t('crm.werbung.formulare.spalte.sprache', 'Sprache'), hideBelow: 'md', cell: f => spracheText(f.locale) },
    { id: 'leads', header: t('crm.werbung.formulare.spalte.leads', 'Leads'), align: 'right', cell: f => <span className="tabular-nums">{f.leads != null ? fmt.int(f.leads) : '-'}</span> },
    {
      id: 'erstellt', header: t('crm.werbung.formulare.spalte.erstellt', 'Angelegt'), align: 'right', hideBelow: 'md',
      cell: f => <span className="tabular-nums">{f.erstellt ? new Date(f.erstellt).toLocaleDateString(fmt.locale) : '-'}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 sm:mr-auto">
          <h2 className="font-heading text-xl text-hp-navy">{t('crm.werbung.formulare.titel', 'Sofortformulare')}</h2>
          <p className="mt-0.5 text-sm text-gray-600">
            {t('crm.werbung.formulare.text', 'Formulare für Lead-Anzeigen direkt auf Facebook und Instagram. Neue Formulare starten mit der Happy-Property-Vorgabe, rechts siehst du live, wie es am Telefon aussieht.')}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 whitespace-nowrap sm:flex-row">
          <button type="button" onClick={() => void lade(true)} disabled={laden} className="hp-btn hp-btn-ghost">
            {laden && <Spinner size="sm" />}
            {t('crm.werbung.zielgruppen.aktualisieren', 'Aktualisieren')}
          </button>
          {gemerkt && (
            <button type="button" onClick={fortsetzen} className="hp-btn hp-btn-accent">
              {t('crm.werbung.formulare.fortsetzen', 'Entwurf fortsetzen')}
            </button>
          )}
          <button type="button" onClick={() => void neu()} className="hp-btn hp-btn-primary">+ {t('crm.werbung.formulare.neu', 'Neues Formular')}</button>
        </div>
      </div>

      {gemerkt && (
        <p className="text-xs text-gray-500">
          {t('crm.werbung.formulare.gemerkt', 'Angefangen in diesem Browser: „{{name}}“.', { name: gemerkt.name })}{' '}
          <button type="button" onClick={verwerfen} className="font-semibold text-hp-navy underline">{t('crm.werbung.formulare.entwurfVerwerfen', 'Entwurf verwerfen')}</button>
        </p>
      )}

      <div className="grid gap-2 md:grid-cols-2">
        <Hinweis ton="sperre" titel={t('crm.werbung.zielgruppen.wohnenTitel', 'Sonderkategorie Wohnen')}>
          {t('crm.werbung.formulare.wohnenGrund', LEADFORM_WOHNEN_GRUND)}
        </Hinweis>
        <Hinweis>{t('crm.werbung.formulare.leadsCrm', 'Leads aus Sofortformularen laufen wie bisher automatisch ins CRM (Abgleich alle 15 Minuten).')}</Hinweis>
      </div>
      <SchreibSperre grund={status.schreibSperre} />
      {ergebnis?.quelle === 'katalog' && (
        <Hinweis>{t('crm.werbung.formulare.ausKatalog', 'Vorläufige Liste aus dem Katalog des Kampagnen-Assistenten: Leads und Formulartyp fehlen, bis die neue Server-Funktion live ist.')}</Hinweis>
      )}
      {(ergebnis?.warnungen ?? []).map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}

      <input value={suche} onChange={ev => setSuche(ev.target.value)} placeholder={t('crm.werbung.zielgruppen.suche', 'Name oder ID suchen …')}
        aria-label={t('crm.werbung.zielgruppen.suche', 'Name oder ID suchen …')} className={`${EINGABE_KLEIN} sm:max-w-xs`} />

      {ladeFehler ? (
        <div className="hp-card">
          <EmptyState icon="alert" title={t('crm.werbung.formulare.ladeFehler', 'Sofortformulare konnten nicht geladen werden')}
            text={<span className="break-words">{ladeFehler}</span>}
            action={<button type="button" onClick={() => void lade(true)} className="hp-btn hp-btn-ghost">{t('crm.werbung.zielgruppen.nochmal', 'Nochmal laden')}</button>} />
        </div>
      ) : (
        <DataTable
          columns={spalten}
          rows={zeilen}
          rowKey={f => f.id}
          loading={laden && !ergebnis}
          onRowClick={f => setEditor({ art: 'ansehen', id: f.id, name: f.name })}
          rowActionsLabel={f => t('crm.werbung.zielgruppen.aktionenFuer', 'Aktionen für {{name}}', { name: f.name })}
          rowActions={(f): ActionItem[] => [
            { id: 'ansehen', label: t('crm.werbung.formulare.ansehen', 'Ansehen'), icon: 'info', onClick: () => setEditor({ art: 'ansehen', id: f.id, name: f.name }) },
            { id: 'kopie', label: t('crm.werbung.formulare.alsKopie', 'Als Kopie bearbeiten'), icon: 'edit', onClick: () => setEditor({ art: 'kopie', id: f.id, name: f.name }) },
            { id: 'meta', label: t('crm.werbung.formulare.direktKopieren', 'Bei Meta kopieren'), icon: 'plus', disabled: !!status.schreibSperre, onClick: () => setKopieren({ id: f.id, name: f.name }) },
          ]}
          empty={(
            <EmptyState icon="documents"
              title={(ergebnis?.zeilen.length ?? 0) ? t('crm.werbung.formulare.keinTreffer', 'Kein Formular passt zur Suche') : t('crm.werbung.formulare.leer', 'Noch keine Sofortformulare')}
              text={(ergebnis?.zeilen.length ?? 0) ? undefined : t('crm.werbung.formulare.leerText', 'Das erste Formular startet mit der Happy-Property-Vorgabe: Höhere Absicht, Kapitalfrage, Knopf zur Terminbuchung.')}
              action={(ergebnis?.zeilen.length ?? 0) ? undefined : <button type="button" onClick={() => void neu()} className="hp-btn hp-btn-primary">+ {t('crm.werbung.formulare.neu', 'Neues Formular')}</button>} />
          )}
        />
      )}

      {editor && (
        <FormularEditor key={editor.art === 'neu' ? 'neu' : `${editor.art}-${editor.id}`} start={editor} status={status}
          onClose={() => setEditor(null)} onAngelegt={angelegt}
          onKopieren={f => { setEditor(null); setKopieren(f) }}
          onEntwurf={editor.art === 'neu' ? merke : undefined} />
      )}
      <KopierenDialog quelle={kopieren} schreibSperre={status.schreibSperre}
        onClose={() => setKopieren(null)} onFertig={() => { setKopieren(null); void lade(true) }} />
    </div>
  )
}
