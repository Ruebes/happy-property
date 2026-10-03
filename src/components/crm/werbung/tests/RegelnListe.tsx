import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RegelUebersicht, RulesListResponse, VorlagenResponse } from '../../../../lib/werbeSteuerung'
import Badge from '../../../ui/Badge'
import DataTable, { type DataTableColumn } from '../../../ui/DataTable'
import EmptyState from '../../../ui/EmptyState'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { Empfohlen, Hinweis, MetaAenderungDialog } from '../zielgruppen/Bausteine'
import RegelEditor, { type RegelStartwerte } from './RegelEditor'
import RegelVerlauf from './RegelVerlauf'
import { steuerungCall, steuerungFehlerText } from './steuerungApi'
import {
  aktionLabel, bedingungText, budgetText, geltungText, regelStatusEtikett, zeitplanLabel, zeitraumLabel,
} from './texte'
import { usePruefung } from './usePruefung'

// ── Automatisierte Regeln von Meta: Vorlagen, Liste, Editor, Verlauf ─────────
// Liste über rules_list (adrules_library des Werbekontos), Vorlagen, Felder
// und Empfänger über den Modus vorlagen. Ein- und Ausschalten über
// rule_status, immer mit „Das ändert sich bei Meta" und vorheriger Prüfung
// durch den Server (vorschau: true). Riskante Regeln
// (Aktivieren, Budget erhöhen) schaltet nur ein Admin ein. Löschen gibt es
// nicht (Svens Regel: nie löschen, ausschalten reicht).

export default function RegelnListe({ schreibSperre, pruefSperre, istAdmin, aktiv }: {
  schreibSperre: string | null
  pruefSperre: string | null
  istAdmin: boolean
  aktiv: boolean
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const [liste, setListe] = useState<RulesListResponse | null>(null)
  const [vorlagen, setVorlagen] = useState<VorlagenResponse | null>(null)
  const [vorlagenFehler, setVorlagenFehler] = useState<string | null>(null)
  const [laden, setLaden] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [gestartet, setGestartet] = useState(false)
  const [editorOffen, setEditorOffen] = useState(false)
  const [startwerte, setStartwerte] = useState<RegelStartwerte | null>(null)
  const [verlauf, setVerlauf] = useState<RegelUebersicht | 'alle' | null>(null)
  const [umschalten, setUmschalten] = useState<RegelUebersicht | null>(null)
  const [busy, setBusy] = useState(false)

  // Nacheinander: erst die Liste, dann Vorlagen (Meta-Last klein halten)
  const lade = useCallback(async (mitVorlagen: boolean) => {
    setLaden(true)
    try {
      setListe(await steuerungCall('rules_list', {}))
      setFehler(null)
    } catch (err) {
      console.error('[Regeln] Liste:', err)
      setFehler(steuerungFehlerText(err, t))
    } finally {
      setLaden(false)
    }
    if (!mitVorlagen) return
    try {
      setVorlagen(await steuerungCall('vorlagen', {}))
      setVorlagenFehler(null)
    } catch (err) {
      setVorlagenFehler(steuerungFehlerText(err, t))
    }
  }, [t])

  useEffect(() => {
    if (!aktiv || gestartet) return
    setGestartet(true)
    void lade(true)
  }, [aktiv, gestartet, lade])

  const zeilen = useMemo(() => (liste?.items ?? []).filter(r => r.status !== 'DELETED'), [liste])

  const info = useMemo(() => (vorlagen ? { felder: vorlagen.felder, gesperrte: vorlagen.gesperrte_aktionen, empfaenger: vorlagen.empfaenger } : null), [vorlagen])

  const oeffneEditor = (s: RegelStartwerte | null) => { setStartwerte(s); setEditorOffen(true) }

  // Texte aus der Eingabe (übersetzbar), sonst die Sätze des Servers
  const wennText = (r: RegelUebersicht): string => {
    const e = r.eingabe
    if (e) {
      const bed = e.bedingungen.map(b => bedingungText(t, fmt.locale, b)).join(t('crm.werbung.regeln.und', ' und '))
      return `${bed} (${zeitraumLabel(t, e.zeitraum)})`
    }
    const bed = r.bedingungen_text.join(t('crm.werbung.regeln.und', ' und '))
    return r.zeitraum ? `${bed} (${zeitraumLabel(t, r.zeitraum)})` : bed
  }
  const dannText = (r: RegelUebersicht): string => {
    const e = r.eingabe
    if (e) return e.aktion === 'budget_aendern' ? budgetText(t, fmt.locale, e.aktion_wert) : aktionLabel(t, e.aktion, e.ebene)
    return r.aktion_text || aktionLabel(t, r.aktion, r.ebene)
  }
  const fuerText = (r: RegelUebersicht): string => (r.eingabe ? geltungText(t, r.eingabe.ebene, r.eingabe.filter) : r.geltung_text)
  const planText = (r: RegelUebersicht): string => (r.eingabe ? zeitplanLabel(t, r.eingabe.zeitplan) : r.zeitplan_text || '-')

  // Prüfung durch den Server, sobald der Dialog offen ist (Leitplanke, Admin, Status bei Meta)
  const pruefung = usePruefung(!!umschalten, async () => {
    if (!umschalten) return { zeilen: [], hinweise: [] }
    const r = await steuerungCall('rule_status', { id: umschalten.id, status: umschalten.aktiv ? 'DISABLED' : 'ENABLED', vorschau: true })
    return { zeilen: [], hinweise: r.hinweise ?? [] }
  })

  const schalten = async () => {
    if (!umschalten || busy || schreibSperre || pruefung.sperre) return
    const ziel = umschalten.aktiv ? 'DISABLED' : 'ENABLED'
    setBusy(true)
    try {
      await steuerungCall('rule_status', { id: umschalten.id, status: ziel })
      toast.success(ziel === 'ENABLED'
        ? t('crm.werbung.regeln.eingeschaltet', 'Regel eingeschaltet.')
        : t('crm.werbung.regeln.ausgeschaltet', 'Regel ausgeschaltet.'))
      setUmschalten(null)
      void lade(false)
    } catch (err) {
      toast.error(steuerungFehlerText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const einschaltSperre = (r: RegelUebersicht): string | null => {
    if (schreibSperre) return schreibSperre
    if (!r.aktiv && r.riskant && !istAdmin) return t('crm.werbung.regeln.riskantAdmin', 'Diese Regel kann Ausgaben erhöhen. Einschalten nur durch einen Admin (Sven).')
    return null
  }

  const spalten: DataTableColumn<RegelUebersicht>[] = [
    {
      id: 'name', header: t('crm.werbung.regeln.spalte.name', 'Regel'), primary: true,
      cell: r => (
        <span className="block min-w-0">
          <span className="block truncate">{r.name}</span>
          {wennText(r) && <span className="block truncate text-[11px] font-normal text-gray-500">{t('crm.werbung.regeln.wenn', 'Wenn')} {wennText(r)}</span>}
        </span>
      ),
    },
    {
      id: 'aktion', header: t('crm.werbung.regeln.spalte.aktion', 'Aktion'),
      cell: r => (
        <span className="block min-w-0">
          <span className="block">{dannText(r)}</span>
          <span className="block truncate text-[11px] text-gray-500">{fuerText(r)}</span>
        </span>
      ),
    },
    { id: 'zeitplan', header: t('crm.werbung.regeln.spalte.zeitplan', 'Zeitplan'), hideBelow: 'md', cell: r => planText(r) },
    {
      id: 'status', header: t('crm.werbung.regeln.spalte.status', 'Status'),
      cell: r => {
        const e = regelStatusEtikett(t, r.status, r.status_label)
        return (
          <span className="flex flex-col items-start gap-0.5">
            <span className="flex flex-wrap gap-1">
              <Badge tone={e.ton} dot>{e.text}</Badge>
              {r.riskant && <Badge tone="warning">{t('crm.werbung.regeln.riskant', 'Erhöht Ausgaben')}</Badge>}
              {!r.von_hp && <Badge tone="neutral">{t('crm.werbung.regeln.ausMeta', 'In Meta angelegt')}</Badge>}
            </span>
            {r.fehler?.text && <span className="text-[11px] text-red-700">{r.fehler.text}</span>}
          </span>
        )
      },
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="min-w-0 text-sm text-gray-600 sm:mr-auto">
          {t('crm.werbung.regeln.text', 'Meta prüft diese Regeln selbst, auch wenn unser Abgleich ausfällt. Sie sehen nur Metas Zahlen, keine Termine oder Lead-Qualität.')}
        </p>
        <div className="flex shrink-0 flex-wrap gap-2 whitespace-nowrap">
          <button type="button" onClick={() => setVerlauf('alle')} className="hp-btn hp-btn-ghost">
            {t('crm.werbung.regeln.verlaufAlle', 'Verlauf aller Regeln')}
          </button>
          <button type="button" onClick={() => void lade(!vorlagen)} disabled={laden} className="hp-btn hp-btn-ghost">
            {laden && <Spinner size="sm" />}
            {t('crm.werbung.tests.aktualisieren', 'Aktualisieren')}
          </button>
          <button type="button" onClick={() => oeffneEditor(null)} className="hp-btn hp-btn-primary">
            + {t('crm.werbung.regeln.neu', 'Neue Regel')}
          </button>
        </div>
      </div>

      {[...(liste?.warnings ?? []), ...(vorlagen?.warnings ?? [])].map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}

      {/* Vorlagen */}
      <section className="rounded-xl border border-gray-200 bg-white">
        <header className="border-b border-gray-100 px-4 py-3">
          <h3 className="font-heading text-base text-hp-navy">{t('crm.werbung.regeln.vorlagen', 'Vorlagen von Happy Property')}</h3>
          <p className="text-xs text-gray-500">{t('crm.werbung.regeln.vorlagenText', 'Fertige Sicherheitsnetze. Übernehmen öffnet den Editor, du siehst alles vor dem Anlegen.')}</p>
        </header>
        {vorlagenFehler ? (
          <p className="px-4 py-3 text-xs text-red-700">{vorlagenFehler}</p>
        ) : !vorlagen ? (
          <p className="flex items-center gap-2 px-4 py-3 text-xs text-gray-500"><Spinner size="sm" />{t('crm.werbung.regeln.vorlagenLaden', 'Vorlagen werden geladen …')}</p>
        ) : (
          <ul className="grid gap-2 p-3 sm:grid-cols-2">
            {vorlagen.vorlagen.map(v => (
              <li key={v.key} className={`flex flex-col gap-2 rounded-lg border p-3 ${v.wohnen_sicher ? 'border-gray-200' : 'border-gray-200 bg-gray-50 opacity-70'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-gray-800">{v.wohnen_sicher ? '' : '🔒 '}{v.titel}</span>
                  {v.empfohlen && v.wohnen_sicher && <Empfohlen />}
                </div>
                <p className="flex-1 text-xs leading-snug text-gray-600">{v.erklaerung}</p>
                {!v.wohnen_sicher && <p className="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">{v.wohnen_grund}</p>}
                <div>
                  <button type="button" onClick={() => oeffneEditor({ key: v.key, titel: v.titel, anfrage: v.anfrage })} disabled={!v.wohnen_sicher}
                    className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
                    {t('crm.werbung.regeln.uebernehmen', 'Übernehmen')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {fehler ? (
        <div className="hp-card">
          <EmptyState icon="alert" title={t('crm.werbung.regeln.ladeFehler', 'Regeln konnten nicht geladen werden')}
            text={<span className="break-words">{fehler}</span>}
            action={<button type="button" onClick={() => void lade(!vorlagen)} className="hp-btn hp-btn-ghost">{t('crm.werbung.tests.nochmal', 'Nochmal laden')}</button>} />
        </div>
      ) : (
        <DataTable
          columns={spalten}
          rows={zeilen}
          rowKey={r => r.id}
          loading={laden && !liste}
          onRowClick={r => setVerlauf(r)}
          rowActionsLabel={r => t('crm.werbung.regeln.aktionenFuer', 'Aktionen für {{name}}', { name: r.name })}
          rowActions={r => [
            {
              id: 'schalten',
              label: r.aktiv ? t('crm.werbung.regeln.ausschalten', 'Ausschalten') : t('crm.werbung.regeln.einschalten', 'Einschalten'),
              icon: r.aktiv ? 'close' : 'check',
              disabled: !!(r.aktiv ? schreibSperre : einschaltSperre(r)),
              onClick: () => setUmschalten(r),
            },
            { id: 'verlauf', label: t('crm.werbung.regeln.verlaufZeigen', 'Verlauf'), icon: 'clock', onClick: () => setVerlauf(r) },
            {
              id: 'kopie', label: t('crm.werbung.regeln.kopieren', 'Als neue Regel kopieren'), icon: 'plus', hidden: !r.eingabe,
              onClick: () => r.eingabe && oeffneEditor({ anfrage: { ...r.eingabe, name: t('crm.werbung.regeln.kopieName', '{{name}} - Kopie', { name: r.name }) } }),
            },
          ]}
          empty={(
            <EmptyState icon="rules" title={t('crm.werbung.regeln.leer', 'Noch keine Meta-Regeln')}
              text={t('crm.werbung.regeln.leerText', 'Empfohlen: die Notbremse aus den Vorlagen oben.')} />
          )}
        />
      )}
      <p className="text-xs text-gray-500">{t('crm.werbung.regeln.nieLoeschen', 'Löschen gibt es hier bewusst nicht: ausschalten reicht, der Verlauf bleibt erhalten.')}</p>

      <RegelEditor offen={editorOffen} start={startwerte} info={info} onClose={() => setEditorOffen(false)} onFertig={() => void lade(false)}
        schreibSperre={schreibSperre} pruefSperre={pruefSperre} istAdmin={istAdmin} />
      <RegelVerlauf regel={verlauf} onClose={() => setVerlauf(null)} />
      <MetaAenderungDialog offen={!!umschalten} onClose={() => setUmschalten(null)} busy={busy}
        gesperrt={umschalten ? ((umschalten.aktiv ? schreibSperre : einschaltSperre(umschalten)) ?? pruefung.sperre) : null}
        punkte={umschalten ? [
          umschalten.aktiv
            ? { art: 'achtung', text: t('crm.werbung.regeln.pAus', 'Regel „{{name}}“ wird ausgeschaltet. Meta prüft sie nicht mehr.', { name: umschalten.name }) }
            : { art: 'neu', text: t('crm.werbung.regeln.pEin', 'Regel „{{name}}“ wird eingeschaltet. Ab dem nächsten Lauf: {{aktion}} für {{fuer}}.', { name: umschalten.name, aktion: dannText(umschalten), fuer: fuerText(umschalten) }) },
          { art: 'gleich', text: t('crm.werbung.regeln.pGleich', 'Kampagnen, Anzeigen und Budgets ändern sich durch das Schalten selbst nicht.') },
        ] : []}
        lernphase={t('crm.werbung.regeln.lernphaseSchalten', 'Startet durch das Schalten nicht neu. Erst wenn die Regel später etwas pausiert oder das Budget ändert, kann das passieren.')}
        warnungen={umschalten && !umschalten.aktiv && umschalten.riskant
          ? [t('crm.werbung.regeln.wRiskant', 'Diese Regel kann Ausgaben erhöhen. Der Server prüft dabei die Tages-Leitplanke des Werbekontos.')]
          : []}
        bestaetigen={umschalten?.aktiv ? t('crm.werbung.regeln.ausschalten', 'Ausschalten') : t('crm.werbung.regeln.einschalten', 'Einschalten')}
        onBestaetigen={() => void schalten()}
        zusatz={pruefung.box} />
    </div>
  )
}
