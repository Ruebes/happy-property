import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../../lib/supabase'
import type { WerbeAktion, WerbeAutopilotEinstellungen, WerbeLauf, WerbeRegel } from '../../../lib/werbungTypes'
import Badge, { type BadgeTone } from '../../ui/Badge'
import EmptyState from '../../ui/EmptyState'
import Spinner from '../../ui/Spinner'
import Tabs, { tabPanelProps } from '../../ui/Tabs'
import { useToast } from '../../ui/Toast'
import { useWerbeKontext } from './useWerbeDaten'
import { useWerbeFormat } from './format'
import { freigabenGesperrt, ladeEinstellungen, ladeRegeln, ladeVorschlaege, nachGruppe } from './autopilot/abfragen'
import LeitplankenKarte from './autopilot/LeitplankenKarte'
import ModusKarte from './autopilot/ModusKarte'
import RegelnTabelle from './autopilot/RegelnTabelle'
import SchattenLog from './autopilot/SchattenLog'
import { useWerbeRechte } from './autopilot/useWerbeRechte'
import Verlauf from './autopilot/Verlauf'
import VorschlagKarte from './autopilot/VorschlagKarte'
import { dbFehlerText, fehltSchema, zahl, zeitKurz } from './autopilot/werbeTexte'

// ── Reiter „Autopilot" des Werbemanagers ──────────────────────────────────────
// Betriebsart + roter Stopp-Knopf, offene Vorschläge (Freigeben/Ablehnen),
// Leitplanken, darunter Regeln, Schatten-Log und Verlauf.
// Standard-Export ohne Props (lazyWithReload). Lädt erst, wenn der Reiter offen
// ist, und nur nacheinander (Micro-Instanz): Einstellungen, Läufe, Regeln,
// Vorschläge; Schatten-Log und Verlauf erst beim Öffnen ihres Unterreiters.
// Die Datenbank prüft alle Rechte selbst (Schutz-Trigger, RPCs); die Knöpfe
// folgen nur denselben Regeln (useWerbeRechte).

type Unterreiter = 'regeln' | 'schatten' | 'verlauf'

const LAUF_SCHRITTE = ['sync', 'qualitaet', 'regeln', 'fenster'] as const

export default function AutopilotTab() {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const rechte = useWerbeRechte()
  const { setSettings, loading: seiteLaedt } = useWerbeKontext()

  const [loading, setLoading] = useState(true)
  const [fehlt, setFehlt] = useState(false)
  const [einstellungen, setEinstellungen] = useState<WerbeAutopilotEinstellungen | null>(null)
  const [laeufe, setLaeufe] = useState<WerbeLauf[]>([])
  const [regeln, setRegeln] = useState<WerbeRegel[]>([])
  const [vorschlaege, setVorschlaege] = useState<WerbeAktion[]>([])
  const [ladeVorschlag, setLadeVorschlag] = useState(false)
  const [unten, setUnten] = useState<Unterreiter>('regeln')
  const [besucht, setBesucht] = useState<ReadonlySet<Unterreiter>>(() => new Set<Unterreiter>(['regeln']))

  const laden = useCallback(async () => {
    setLoading(true)
    try {
      const e = await ladeEinstellungen()
      setEinstellungen(e)
      // Letzte Läufe der Nachtkette (klein, tolerant: fehlt die Tabelle, bleibt die Zeile leer)
      const { data: lf, error: eLf } = await supabase.from('ad_autopilot_runs')
        .select('id, lauf_datum, schritt, status, started_at, finished_at, summary, fehler')
        .order('started_at', { ascending: false }).limit(12)
      if (eLf) throw eLf
      setLaeufe((lf as unknown as WerbeLauf[] | null) ?? [])
      setRegeln(await ladeRegeln())
      setVorschlaege(await ladeVorschlaege())
      setFehlt(false)
    } catch (err) {
      if (fehltSchema(err)) setFehlt(true)
      else {
        console.error('[Autopilot] laden:', err)
        toast.error(dbFehlerText(t, err))
      }
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  // Erst nach den Seitendaten (fetchAll) laden, nie parallel dazu, und nur einmal
  const gestartet = useRef(false)
  useEffect(() => {
    if (seiteLaedt || gestartet.current) return
    gestartet.current = true
    void laden()
  }, [seiteLaedt, laden])

  const vorschlaegeNeu = useCallback(async () => {
    setLadeVorschlag(true)
    try {
      setVorschlaege(await ladeVorschlaege())
    } catch (err) {
      console.error('[Autopilot] Vorschläge:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setLadeVorschlag(false)
    }
  }, [t, toast])

  // Einstellungen geändert: auch die Seiten-Leitplanken (Statistik) nachziehen
  const einstellungenGeaendert = useCallback((neu: WerbeAutopilotEinstellungen) => {
    setEinstellungen(neu)
    const max = zahl(neu.max_account_daily_budget)
    if (max != null && max > 0) setSettings(s => ({ ...s, max_account_daily_budget: max }))
  }, [setSettings])

  const regelMap = useMemo(() => new Map(regeln.map(r => [r.rule_key, r])), [regeln])
  const gruppen = useMemo(() => nachGruppe(vorschlaege), [vorschlaege])
  const gesperrt = freigabenGesperrt(einstellungen)

  // Letzter Stand je Schritt der Nachtkette
  const letzteLaeufe = useMemo(() => {
    const m = new Map<string, WerbeLauf>()
    for (const l of laeufe) if (!m.has(l.schritt)) m.set(l.schritt, l)
    return LAUF_SCHRITTE.map(s => m.get(s)).filter((x): x is WerbeLauf => !!x)
  }, [laeufe])

  const wechsleUnten = (id: string) => {
    const u = (['regeln', 'schatten', 'verlauf'] as const).find(x => x === id) ?? 'regeln'
    setUnten(u)
    setBesucht(prev => (prev.has(u) ? prev : new Set([...prev, u])))
  }

  if (loading) return <div className="flex justify-center py-24"><Spinner size="lg" /></div>

  if (fehlt || !einstellungen) {
    return (
      <div className="hp-card">
        <EmptyState
          icon="rules"
          title={t('crm.werbung.autopilot.nichtFreigeschaltet', 'Noch nicht freigeschaltet')}
          text={t('crm.werbung.autopilot.nichtFreigeschaltetText', 'Die Datenbank-Erweiterung für den Autopiloten ist noch nicht eingespielt.')}
          action={<button type="button" className="hp-btn hp-btn-ghost" onClick={() => void laden()}>{t('crm.werbung.autopilot.neuLaden', 'Neu laden')}</button>}
        />
      </div>
    )
  }

  const laufText = (s: string) => {
    switch (s) {
      case 'sync': return t('crm.werbung.autopilot.lauf.sync', 'Meta-Daten')
      case 'qualitaet': return t('crm.werbung.autopilot.lauf.qualitaet', 'Qualität')
      case 'regeln': return t('crm.werbung.autopilot.lauf.regeln', 'Regeln')
      case 'fenster': return t('crm.werbung.autopilot.lauf.fenster', 'Änderungsfenster')
      default: return s
    }
  }
  const laufTon = (s: string): BadgeTone =>
    s === 'fertig' ? 'success' : s === 'fehler' ? 'danger' : s === 'laeuft' ? 'info' : s === 'uebersprungen' ? 'warning' : 'neutral'
  const laufStatus = (s: string) => {
    switch (s) {
      case 'fertig': return t('crm.werbung.autopilot.lauf.fertig', 'fertig')
      case 'fehler': return t('crm.werbung.autopilot.lauf.fehler', 'Fehler')
      case 'laeuft': return t('crm.werbung.autopilot.lauf.laeuft', 'läuft')
      case 'uebersprungen': return t('crm.werbung.autopilot.lauf.uebersprungen', 'übersprungen')
      default: return s
    }
  }

  return (
    <div className="space-y-4">
      <ModusKarte einstellungen={einstellungen} rechte={rechte} onGeaendert={einstellungenGeaendert} />

      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-gray-500">
        <span>{t('crm.werbung.autopilot.lauf.titel', 'Letzte Nacht:')}</span>
        {letzteLaeufe.length ? letzteLaeufe.map(l => (
          <span key={l.id} title={l.fehler ?? zeitKurz(l.finished_at ?? l.started_at, fmt.locale)}>
            <Badge tone={laufTon(l.status)} dot>
              {laufText(l.schritt)} {laufStatus(l.status)} ({zeitKurz(l.finished_at ?? l.started_at, fmt.locale)})
            </Badge>
          </span>
        )) : <span>{t('crm.werbung.autopilot.lauf.keiner', 'noch kein Lauf')}</span>}
      </div>

      <section aria-labelledby="ap-vorschlaege-titel" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <h2 id="ap-vorschlaege-titel" className="font-heading text-lg text-hp-navy">
            {t('crm.werbung.autopilot.vorschlaege', 'Vorschläge')}
            {gruppen.length > 0 && <span className="ml-2 text-sm font-body text-gray-500">({gruppen.length})</span>}
          </h2>
          <button type="button" className="hp-btn hp-btn-ghost" disabled={ladeVorschlag} onClick={() => void vorschlaegeNeu()}>
            {ladeVorschlag ? t('crm.werbung.autopilot.vorschlag.laeuft', 'Läuft …') : t('crm.werbung.autopilot.aktualisieren', 'Aktualisieren')}
          </button>
        </div>
        {gruppen.length ? (
          gruppen.map(g => (
            <VorschlagKarte
              key={g[0].gruppe_id ?? g[0].id}
              gruppe={g}
              regeln={regelMap}
              rechte={rechte}
              gesperrt={gesperrt}
              onEntschieden={() => void vorschlaegeNeu()}
              mitLink
            />
          ))
        ) : (
          <div className="hp-card">
            <EmptyState
              compact
              icon="confirmation"
              title={t('crm.werbung.autopilot.keineVorschlaege', 'Keine offenen Vorschläge')}
              text={einstellungen.autopilot_mode === 'schatten'
                ? t('crm.werbung.autopilot.keineVorschlaegeSchatten', 'Im Modus Schatten legt der Autopilot keine Vorschläge an. Was er tun würde, steht im Schatten-Log.')
                : t('crm.werbung.autopilot.keineVorschlaegeText', 'Neue Vorschläge entstehen jede Nacht nach dem Abgleich mit Meta.')}
            />
          </div>
        )}
      </section>

      <LeitplankenKarte einstellungen={einstellungen} rechte={rechte} onGeaendert={einstellungenGeaendert} />

      <section className="hp-card p-2 sm:p-3">
        <Tabs
          tabs={[
            { id: 'regeln', label: t('crm.werbung.autopilot.unten.regeln', 'Regeln'), icon: 'rules', count: regeln.length },
            { id: 'schatten', label: t('crm.werbung.autopilot.unten.schatten', 'Schatten-Log') },
            { id: 'verlauf', label: t('crm.werbung.autopilot.unten.verlauf', 'Verlauf') },
          ]}
          value={unten}
          onChange={wechsleUnten}
          ariaLabel={t('crm.werbung.autopilot.unten.aria', 'Regeln, Schatten-Log und Verlauf')}
          idBase="ap-unten"
        />
        <div className="p-2 pt-4 sm:p-3">
          {besucht.has('regeln') && (
            <div {...tabPanelProps('ap-unten', 'regeln')} hidden={unten !== 'regeln'}>
              <RegelnTabelle
                regeln={regeln}
                rechte={rechte}
                budgetAutonomie={!!einstellungen.budget_autonomie_freigegeben_at}
                onGeaendert={r => setRegeln(prev => prev.map(x => (x.rule_key === r.rule_key ? r : x)))}
              />
            </div>
          )}
          {besucht.has('schatten') && (
            <div {...tabPanelProps('ap-unten', 'schatten')} hidden={unten !== 'schatten'}>
              <SchattenLog regeln={regelMap} rechte={rechte} />
            </div>
          )}
          {besucht.has('verlauf') && (
            <div {...tabPanelProps('ap-unten', 'verlauf')} hidden={unten !== 'verlauf'}>
              <Verlauf rechte={rechte} />
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
