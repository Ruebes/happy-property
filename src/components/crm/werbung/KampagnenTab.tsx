import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import DataTable, { type DataTableColumn } from '../../ui/DataTable'
import type { ActionItem } from '../../ui/ActionMenu'
import EmptyState from '../../ui/EmptyState'
import Modal from '../../ui/Modal'
import Spinner from '../../ui/Spinner'
import { useToast } from '../../ui/Toast'
import { useConfirm } from '../../ui/ConfirmDialog'
import { supabase } from '../../../lib/supabase'
import { TEMPLATES, type BuilderSettings, type CatalogResponse, type DraftKind, type DraftLastError } from '../../../lib/metaSpec'
import { INPUT_CLS } from './felder'
import { AD_STATUS_BADGE, useWerbeFormat } from './format'
import { useWerbeKontext } from './useWerbeDaten'
import KampagnenAssistent from './kampagnen/KampagnenAssistent'
import DuplizierenDialog from './kampagnen/DuplizierenDialog'
import { StatusBadge } from './kampagnen/EntwurfBaum'
import { builderCall, fehlerText, ladeBuilderEinstellungen, ladeKatalog, vorgabenAus } from './kampagnen/builderApi'
import { zielAusParam, type EditZiel } from './kampagnen/bearbeitenTypen'
import { leererEntwurf, type AssistentStart } from './kampagnen/useEntwurf'

// ── Reiter „Kampagnen" des Werbemanagers ─────────────────────────────────────
// Entwürfe des Kampagnen-Assistenten (meta_drafts, ohne spec, höchstens 50,
// zuletzt geändert zuerst) und die Einstiege: neue Kampagne, Vorlage Plan B,
// bestehende Kampagne bearbeiten (edit_load), ergänzen (Import über
// meta-builder) oder bei Meta duplizieren. Der Assistent selbst liegt in
// ./kampagnen/. Lädt erst, wenn der Reiter offen ist, seriell (Micro-Instanz):
// Entwürfe, dann Autorennamen, dann ad_settings.
// Von überall bearbeiten: ?tab=kampagnen&bearbeiten=<campaign|adset|ad>:<id>
// öffnet den Assistenten im Bearbeiten-Modus (nach dem Laden der Liste);
// beim Schließen verschwindet der Parameter wieder.

interface EntwurfZeile {
  id: string
  name: string
  kind: DraftKind | string
  template_key: string | null
  status: string
  target_campaign_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  last_error: DraftLastError | null
}

interface KampagneWahl { id: string; name: string; anzeigen: number; aktiv: number }

/** Warnung von edit_load (meta-builder edit.ts), wenn offene Änderungen wieder aufgenommen wurden */
const WIEDER_GELADEN = /noch nicht übernommene Änderungen wieder geladen/

export default function KampagnenTab() {
  const { t } = useTranslation()
  const toast = useToast()
  const confirm = useConfirm()
  const fmt = useWerbeFormat()
  const { catalog, loading: seiteLaedt } = useWerbeKontext()

  const [zeilen, setZeilen] = useState<EntwurfZeile[]>([])
  const [laden, setLaden] = useState(true)
  const [ladeFehler, setLadeFehler] = useState<string | null>(null)
  const [autoren, setAutoren] = useState<Record<string, string>>({})
  const [einstellungen, setEinstellungen] = useState<BuilderSettings | null>(null)
  const [offen, setOffen] = useState<AssistentStart | null>(null)
  const [startLaeuft, setStartLaeuft] = useState<null | 'neu' | 'plan_b'>(null)
  const [importOffen, setImportOffen] = useState(false)
  const [importLaeuft, setImportLaeuft] = useState<string | null>(null)
  const [suche, setSuche] = useState('')
  const [bearbeitenLaeuft, setBearbeitenLaeuft] = useState<string | null>(null)
  const [assistentNr, setAssistentNr] = useState(0)
  const [dupItems, setDupItems] = useState<Array<{ level: 'campaign' | 'adset' | 'ad'; id: string; name: string }>>([])
  const [search, setSearch] = useSearchParams()
  const bearbeitenParam = search.get('bearbeiten')

  const ladeListe = useCallback(async () => {
    setLaden(true)
    try {
      const { data, error } = await supabase.from('meta_drafts')
        .select('id, name, kind, template_key, status, target_campaign_id, created_by, created_at, updated_at, last_error')
        .neq('status', 'discarded')
        .order('updated_at', { ascending: false })
        .limit(50)
      if (error) throw error
      const rows = (data as EntwurfZeile[] | null) ?? []
      setZeilen(rows)
      setLadeFehler(null)
      // Autorennamen (still, ohne Fehler: Profile sind nicht für alle lesbar)
      const ids = rows.map(r => r.created_by).filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i)
      if (ids.length) {
        const { data: pr } = await supabase.from('profiles').select('id, full_name').in('id', ids)
        const m: Record<string, string> = {}
        for (const p of (pr as Array<{ id: string; full_name: string | null }> | null) ?? []) if (p.full_name) m[p.id] = p.full_name
        setAutoren(m)
      }
    } catch (err) {
      console.error('[Kampagnen] Entwürfe laden:', err)
      setLadeFehler(err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err))
      setZeilen([])
    } finally {
      setLaden(false)
    }
  }, [])

  // Erst nach den Seitendaten laden, nie parallel dazu (Micro-Instanz), danach seriell
  const gestartet = useRef(false)
  useEffect(() => {
    if (seiteLaedt || gestartet.current) return
    gestartet.current = true
    void (async () => {
      await ladeListe()
      setEinstellungen(await ladeBuilderEinstellungen())
    })()
  }, [seiteLaedt, ladeListe])

  // ── Einstiege ─────────────────────────────────────────────────────────────
  /** Katalog (DSA-Standard des Kontos, Instagram-Konto) für neue Entwürfe; ohne ihn mit ad_settings */
  const holeKatalog = async (): Promise<CatalogResponse | null> => {
    try {
      return await ladeKatalog()
    } catch (err) {
      toast.info(t('crm.werbung.builder.tab.ohneKatalog', 'Meta-Katalog nicht erreichbar ({{fehler}}). Begünstigte/Zahlende Person bitte selbst prüfen.', { fehler: fehlerText(err, t) }))
      return null
    }
  }

  const neueKampagne = async () => {
    setStartLaeuft('neu')
    try {
      const v = vorgabenAus(einstellungen, await holeKatalog())
      const spec = leererEntwurf({
        pageId: v.pageId, igUserId: v.igUserId, pixelId: v.pixelId, link: v.link,
        dsaBeneficiary: v.dsaBeneficiary, dsaPayor: v.dsaPayor,
      }, t('crm.werbung.builder.neueKampagne', 'Neue Kampagne'))
      setOffen({ art: 'neu', spec, templateKey: null })
    } finally {
      setStartLaeuft(null)
    }
  }

  const planB = async () => {
    setStartLaeuft('plan_b')
    try {
      const v = vorgabenAus(einstellungen, await holeKatalog())
      const spec = TEMPLATES.plan_b.build({
        ...(v.pageId ? { page_id: v.pageId } : {}),
        ...(v.igUserId ? { instagram_user_id: v.igUserId } : {}),
        ...(v.pixelId ? { pixel_id: v.pixelId } : {}),
        dsa_beneficiary: v.dsaBeneficiary,
        dsa_payor: v.dsaPayor,
        name: t('crm.werbung.builder.tab.planBName', 'Plan B Kapitalanleger {{datum}}', { datum: new Date().toLocaleDateString(fmt.locale) }),
      })
      // gleich das erste Werbemittel-Paar (eine Anzeige in Lang, eine in Kurz)
      spec.ads = TEMPLATES.plan_b.pair({
        kennung: 'werbemittel1', primary_texts: [''], headlines: [''], media: {},
        ...(v.pageId ? { page_id: v.pageId } : {}),
        ...(v.igUserId ? { instagram_user_id: v.igUserId } : {}),
      })
      setOffen({ art: 'neu', spec, templateKey: 'plan_b' })
    } finally {
      setStartLaeuft(null)
    }
  }

  const kampagnen = useMemo<KampagneWahl[]>(() => {
    const m = new Map<string, KampagneWahl>()
    for (const c of catalog) {
      if (!c.campaign_id) continue
      const k = m.get(c.campaign_id) ?? { id: c.campaign_id, name: c.campaign_name || c.campaign_id, anzeigen: 0, aktiv: 0 }
      k.anzeigen += 1
      if ((c.status ?? '').toUpperCase() === 'ACTIVE') k.aktiv += 1
      m.set(c.campaign_id, k)
    }
    const q = suche.trim().toLowerCase()
    return [...m.values()]
      .filter(k => !q || k.name.toLowerCase().indexOf(q) >= 0 || k.id.indexOf(q) >= 0)
      .sort((a, b) => b.aktiv - a.aktiv || a.name.localeCompare(b.name))
  }, [catalog, suche])

  // ── Bearbeiten (edit_load) ────────────────────────────────────────────────
  const entferneParam = useCallback(() => {
    const next = new URLSearchParams(window.location.search)
    if (!next.has('bearbeiten')) return
    next.delete('bearbeiten')
    setSearch(next, { replace: true })
  }, [setSearch])

  /** edit_load und Assistent öffnen; true = geladen */
  const oeffneBearbeiten = useCallback(async (ziel: EditZiel, neuLaden = false): Promise<boolean> => {
    setBearbeitenLaeuft(`${ziel.level}:${ziel.id}`)
    try {
      const r = await builderCall('edit_load', { level: ziel.level, id: ziel.id, ...(neuLaden ? { neu_laden: true } : {}) })
      setImportOffen(false)
      setAssistentNr(n => n + 1)
      setOffen({ art: 'bearbeiten', id: r.draft_id, spec: r.spec, locks: r.locks ?? [], ziel, hinweise: r.warnings ?? [] })
      // reused heißt nur „Zeile wiederverwendet“; offene Änderungen meldet der Server als Warnung
      if (!neuLaden && (r.warnings ?? []).some(w => WIEDER_GELADEN.test(w))) {
        toast.info(t('crm.werbung.bearbeiten.wiederverwendet', 'Offene Änderungen von vorher sind wieder geladen. „Neu laden“ holt den frischen Stand von Meta.'))
      }
      return true
    } catch (err) {
      toast.error(t('crm.werbung.bearbeiten.ladeFehler', 'Bearbeiten nicht möglich: {{fehler}}', { fehler: fehlerText(err, t) }))
      entferneParam()
      return false
    } finally {
      setBearbeitenLaeuft(null)
    }
  }, [entferneParam, t, toast])

  // ?bearbeiten=<level>:<id> aus der Adresse (z. B. aus der Übersicht oder dem Einstellungsfenster)
  const behandelt = useRef<string | null>(null)
  useEffect(() => {
    if (!bearbeitenParam) { behandelt.current = null; return }
    // erst nach den Seitendaten und der Entwurfsliste (nie parallel, Micro-Instanz)
    if (seiteLaedt || laden) return
    if (behandelt.current === bearbeitenParam) return
    behandelt.current = bearbeitenParam
    const ziel = zielAusParam(bearbeitenParam)
    if (!ziel) {
      toast.error(t('crm.werbung.bearbeiten.paramUngueltig', 'Der Bearbeiten-Link ist ungültig.'))
      entferneParam()
      return
    }
    void oeffneBearbeiten(ziel)
  }, [bearbeitenParam, seiteLaedt, laden, oeffneBearbeiten, entferneParam, toast, t])

  const uebernehmen = async (k: KampagneWahl) => {
    setImportLaeuft(k.id)
    try {
      const res = await builderCall('import', { level: 'campaign', id: k.id })
      setImportOffen(false)
      setOffen({ art: 'neu', spec: res.spec, templateKey: null, hinweise: res.warnings ?? [] })
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setImportLaeuft(null)
    }
  }

  // ── Zeilen-Aktionen ───────────────────────────────────────────────────────
  const duplizieren = async (z: EntwurfZeile) => {
    try {
      const { data, error } = await supabase.from('meta_drafts')
        .select('name, kind, template_key, spec, target_campaign_id, target_adset_id').eq('id', z.id).single()
      if (error) throw error
      const r = data as { name: string; kind: string; template_key: string | null; spec: unknown; target_campaign_id: string | null; target_adset_id: string | null }
      const name = `${r.name} ${t('crm.werbung.builder.baum.kopie', 'Kopie')}`.slice(0, 200)
      const { error: e2 } = await supabase.from('meta_drafts').insert({
        name, kind: r.kind, template_key: r.template_key, spec: r.spec,
        target_campaign_id: r.target_campaign_id, target_adset_id: r.target_adset_id,
      })
      if (e2) throw e2
      toast.success(t('crm.werbung.builder.tab.dupliziert', 'Entwurf dupliziert'))
      void ladeListe()
    } catch (err) {
      console.error('[Kampagnen] Duplizieren:', err)
      toast.error(t('crm.werbung.builder.tab.duplizierenFehler', 'Duplizieren fehlgeschlagen'))
    }
  }

  const verwerfen = async (z: EntwurfZeile) => {
    const ok = await confirm({
      title: t('crm.werbung.builder.verwerfenTitel', 'Entwurf verwerfen?'),
      message: t('crm.werbung.builder.verwerfenText', 'Der Entwurf verschwindet aus der Liste. Bei Meta wird nichts gelöscht.'),
      confirmLabel: t('crm.werbung.builder.verwerfen', 'Verwerfen'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await builderCall('discard', { draft_id: z.id })
      toast.success(t('crm.werbung.builder.verworfen', 'Entwurf verworfen'))
      void ladeListe()
    } catch (err) {
      toast.error(fehlerText(err, t))
    }
  }

  const schliessen = () => {
    setOffen(null)
    entferneParam()
    void ladeListe()
  }

  // ── Darstellung ───────────────────────────────────────────────────────────
  const ART: Record<string, string> = {
    new_campaign: t('crm.werbung.builder.tab.art.new_campaign', 'Neue Kampagne'),
    add_adsets: t('crm.werbung.builder.tab.art.add_adsets', 'Neue Anzeigengruppen'),
    add_ads: t('crm.werbung.builder.tab.art.add_ads', 'Neue Anzeigen'),
    edit: t('crm.werbung.builder.tab.art.edit', 'Änderung'),
  }
  const vorlage = (k: string | null) => (k === 'plan_b'
    ? t('crm.werbung.builder.planB', 'Plan B')
    : k ? k : t('crm.werbung.builder.tab.ohneVorlage', 'Ohne Vorlage'))
  const datum = (iso: string) => new Date(iso).toLocaleString(fmt.locale, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

  const spalten: DataTableColumn<EntwurfZeile>[] = [
    {
      id: 'name', header: t('crm.werbung.builder.tab.name', 'Entwurf'), primary: true,
      cell: z => (
        <span className="block min-w-0">
          <span className="block truncate">{z.name}</span>
          <span className="block truncate text-[11px] font-normal text-gray-500">
            {ART[z.kind] ?? z.kind}{z.target_campaign_id ? ` · ${z.target_campaign_id}` : ''}
          </span>
        </span>
      ),
    },
    { id: 'vorlage', header: t('crm.werbung.builder.tab.vorlage', 'Vorlage'), hideBelow: 'sm', cell: z => vorlage(z.template_key) },
    {
      id: 'status', header: t('crm.werbung.builder.tab.status', 'Status'),
      cell: z => (
        <span className="inline-flex flex-col items-start gap-0.5">
          <StatusBadge status={z.status} />
          {z.last_error && (z.status === 'failed' || z.status === 'partial') && (
            <span className="max-w-[16rem] truncate text-[10px] text-red-700" title={z.last_error.user_msg ?? undefined}>{z.last_error.user_msg ?? z.last_error.step}</span>
          )}
        </span>
      ),
    },
    { id: 'autor', header: t('crm.werbung.builder.tab.autor', 'Erstellt von'), hideBelow: 'md', cell: z => (z.created_by ? autoren[z.created_by] ?? '-' : '-') },
    { id: 'geaendert', header: t('crm.werbung.builder.tab.geaendert', 'Geändert'), align: 'right', cell: z => <span className="tabular-nums">{datum(z.updated_at)}</span> },
  ]

  const gesperrt = einstellungen?.builder_enabled === false

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 sm:mr-auto">
          <h2 className="font-heading text-xl text-hp-navy">{t('crm.werbung.builder.tab.titel', 'Kampagnen-Assistent')}</h2>
          <p className="mt-0.5 text-sm text-gray-600">
            {t('crm.werbung.builder.tab.text', 'Kampagnen wie im Meta-Werbeanzeigenmanager bauen, mit HP-Regeln geprüft. Alles wird pausiert angelegt, aktiviert wird getrennt.')}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <button type="button" onClick={() => setImportOffen(true)} disabled={!!startLaeuft || !!bearbeitenLaeuft} className="hp-btn hp-btn-ghost">
            {bearbeitenLaeuft && <Spinner size="sm" />}
            {t('crm.werbung.bearbeiten.bestehende', 'Bestehende Kampagne bearbeiten oder ergänzen')}
          </button>
          <button type="button" onClick={() => void planB()} disabled={!!startLaeuft} className="hp-btn hp-btn-accent">
            {startLaeuft === 'plan_b' && <Spinner size="sm" />}
            {t('crm.werbung.builder.tab.vorlagePlanB', 'Vorlage: Plan B')}
          </button>
          <button type="button" onClick={() => void neueKampagne()} disabled={!!startLaeuft} className="hp-btn hp-btn-primary">
            {startLaeuft === 'neu' && <Spinner size="sm" />}
            {t('crm.werbung.builder.tab.neu', 'Neue Kampagne')}
          </button>
        </div>
      </div>

      {gesperrt && (
        <div role="note" className="rounded-xl border border-hp-navy/15 bg-hp-cream px-4 py-3 text-sm text-hp-navy">
          <span className="font-semibold">{t('crm.werbung.builder.tab.gesperrtTitel', 'Anlegen bei Meta ist noch gesperrt:')}</span>{' '}
          {t('crm.werbung.builder.tab.gesperrtText', 'Freischaltung durch Sven ausstehend. Entwürfe lassen sich schon bauen und lokal prüfen.')}
        </div>
      )}

      {ladeFehler ? (
        <div className="hp-card">
          <EmptyState icon="alert" title={t('crm.werbung.builder.tab.ladeFehler', 'Entwürfe konnten nicht geladen werden')}
            text={<span className="break-words">{ladeFehler}</span>}
            action={<button type="button" onClick={() => void ladeListe()} className="hp-btn hp-btn-ghost">{t('crm.werbung.builder.tab.nochmal', 'Nochmal laden')}</button>} />
        </div>
      ) : (
        <DataTable
          columns={spalten}
          rows={zeilen}
          rowKey={z => z.id}
          loading={laden}
          onRowClick={z => setOffen({ art: 'laden', id: z.id })}
          rowActionsLabel={z => t('crm.werbung.builder.tab.aktionenFuer', 'Aktionen für {{name}}', { name: z.name })}
          rowActions={(z): ActionItem[] => [
            { id: 'open', label: t('crm.werbung.builder.tab.oeffnen', 'Öffnen'), icon: 'edit', onClick: () => setOffen({ art: 'laden', id: z.id }) },
            { id: 'dup', label: t('crm.werbung.builder.tab.duplizieren', 'Duplizieren'), icon: 'plus', hidden: z.kind === 'edit', onClick: () => void duplizieren(z) },
            {
              id: 'discard', label: t('crm.werbung.builder.verwerfen', 'Verwerfen'), icon: 'trash', tone: 'danger',
              hidden: z.status === 'created' || z.status === 'creating', onClick: () => void verwerfen(z),
            },
          ]}
          empty={(
            <EmptyState icon="ads" title={t('crm.werbung.builder.tab.leer', 'Noch keine Entwürfe')}
              text={t('crm.werbung.builder.tab.leerText', 'Starte mit „Vorlage: Plan B“ oder einer neuen Kampagne.')} />
          )}
        />
      )}

      {/* Bestehende Kampagne übernehmen */}
      <Modal open={importOffen} onClose={() => setImportOffen(false)} size="lg"
        title={t('crm.werbung.bearbeiten.bestehende', 'Bestehende Kampagne bearbeiten oder ergänzen')}>
        <ul className="space-y-1 text-xs text-gray-600">
          <li><span className="font-semibold text-hp-navy">{t('crm.werbung.bearbeiten.knopfBearbeiten', 'Bearbeiten')}:</span> {t('crm.werbung.bearbeiten.bearbeitenText', 'laufende Einstellungen ändern (Budget, Zielgruppe, Texte …). Vor dem Schreiben zeigt der Assistent, was sich bei Meta ändert.')}</li>
          <li><span className="font-semibold text-hp-navy">{t('crm.werbung.bearbeiten.knopfErgaenzen', 'Ergänzen')}:</span> {t('crm.werbung.builder.tab.importText', 'Die Kampagne wird mit ihren Anzeigengruppen und Anzeigen in einen Entwurf geladen. Dort kommen neue Anzeigengruppen oder Anzeigen dazu, Bestehendes bleibt bei Meta unverändert.')}</li>
          <li><span className="font-semibold text-hp-navy">{t('crm.werbung.bearbeiten.knopfDuplizieren', 'Duplizieren')}:</span> {t('crm.werbung.bearbeiten.duplizierenText', 'pausierte Kopie bei Meta anlegen.')}</li>
        </ul>
        <input value={suche} onChange={ev => setSuche(ev.target.value)} placeholder={t('crm.werbung.builder.wahl.suche', 'Suchen …')}
          aria-label={t('crm.werbung.builder.wahl.suche', 'Suchen …')} className={`${INPUT_CLS} mt-3`} />
        <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200">
          {kampagnen.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-gray-500">{t('crm.werbung.builder.tab.keineKampagnen', 'Keine Kampagnen im Abgleich gefunden.')}</li>
          )}
          {kampagnen.map(k => {
            const badge = AD_STATUS_BADGE(k.aktiv > 0 ? 'ACTIVE' : 'PAUSED')
            const laeuftHier = importLaeuft === k.id || bearbeitenLaeuft === `campaign:${k.id}`
            return (
              <li key={k.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-hp-navy">{k.name}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.k ? t(badge.k, badge.d) : badge.d}</span>
                    {laeuftHier && <Spinner size="sm" />}
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    {t('crm.werbung.builder.tab.anzeigenZahl', '{{n}} Anzeigen, {{aktiv}} aktiv', { n: k.anzeigen, aktiv: k.aktiv })} · {k.id}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap gap-1.5">
                  <button type="button" onClick={() => void oeffneBearbeiten({ level: 'campaign', id: k.id })} disabled={!!importLaeuft || !!bearbeitenLaeuft}
                    className="hp-btn hp-btn-primary min-h-0 px-3 py-1 text-xs disabled:opacity-60">{t('crm.werbung.bearbeiten.knopfBearbeiten', 'Bearbeiten')}</button>
                  <button type="button" onClick={() => void uebernehmen(k)} disabled={!!importLaeuft || !!bearbeitenLaeuft}
                    className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs disabled:opacity-60">{t('crm.werbung.bearbeiten.knopfErgaenzen', 'Ergänzen')}</button>
                  <button type="button" onClick={() => { setImportOffen(false); setDupItems([{ level: 'campaign', id: k.id, name: k.name }]) }} disabled={!!importLaeuft || !!bearbeitenLaeuft}
                    className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs disabled:opacity-60">{t('crm.werbung.bearbeiten.knopfDuplizieren', 'Duplizieren')}</button>
                </span>
              </li>
            )
          })}
        </ul>
      </Modal>

      {offen && (
        <KampagnenAssistent key={offen.art === 'neu' ? `neu-${assistentNr}` : `${offen.id}-${assistentNr}`} start={offen} einstellungen={einstellungen}
          onClose={schliessen} onNeuVonMeta={ziel => oeffneBearbeiten(ziel, true)} />
      )}
      <DuplizierenDialog offen={dupItems.length > 0} items={dupItems} onClose={() => setDupItems([])} />
    </div>
  )
}
