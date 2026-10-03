import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import EmptyState from '../../../ui/EmptyState'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import type { DraftSpec, EditApplyResponse, EditChange, EditDiffResponse, Level } from '../../../../lib/metaSpec'
import { useWerbeFormat } from '../format'
import { issueText } from './PruefPanel'
import { LernphaseBadge, ebeneName, wertText } from './bearbeitenHelfer'
import { BUDGET_LERN_SCHWELLE, budgetProzent, istGeldFeld, objektName } from './bearbeitenTypen'
import type { UebernehmenGruende } from './useEntwurf'

// ── „Das ändert sich bei Meta" ───────────────────────────────────────────────
// Zusammenfassung aus meta-builder edit_diff vor dem Schreiben: je Objekt die
// geänderten Felder (vorher -> nachher), was Meta sperrt (wird nicht
// gesendet), Lernphasen-Hinweise (neu / kann neu starten), Werbemittel-Tausch,
// Konflikte (bei Meta seit dem Laden geändert), Fehler und Compliance-Blocker
// (blockieren), Kampagne ohne Wohnen bei neuer Anzeige (nur Admin mit
// Begründung), Leitplanke. „Bei Meta übernehmen" ruft edit_apply mit confirm.
// Danach: was übernommen wurde und was nicht, neue Anzeigen beim Tausch.

interface Props {
  offen: boolean
  laedt: boolean
  diff: EditDiffResponse | null
  fehler: string | null
  ergebnis: EditApplyResponse | null
  uebernimmt: boolean
  spec: DraftSpec
  kurs: number
  istAdmin: boolean
  schreibSperre: string | null
  /** edit_apply hat 409 housing_required gemeldet */
  housingVerlangt?: boolean
  onClose: () => void
  onUebernehmen: (gruende: UebernehmenGruende) => void
  onWeiter: () => void
  onFertig: () => void
  onSpringe: (node: string, field: string) => void
}

interface Gruppe { level: Level; id: string; node: string; name: string; changes: EditChange[] }

const LEVEL_ORDER: Record<Level, number> = { campaign: 0, adset: 1, ad: 2 }
/** Warnung von edit_diff (meta-builder edit.ts): neue Anzeige in einer Kampagne ohne Sonderkategorie Wohnen */
const HOUSING_WARNUNG = /Sonderkategorie Wohnen nicht/

function gruppieren(changes: readonly EditChange[], spec: DraftSpec): Gruppe[] {
  const m = new Map<string, Gruppe>()
  for (const c of changes) {
    const k = `${c.level}:${c.id}`
    const g = m.get(k) ?? { level: c.level, id: c.id, node: c.node, name: objektName(spec, c.level, c.id) ?? c.id, changes: [] }
    g.changes.push(c)
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}

export default function AenderungenDialog(p: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [forceGrund, setForceGrund] = useState('')
  const [housingGrund, setHousingGrund] = useState('')
  useEffect(() => { if (p.offen) { setForceGrund(''); setHousingGrund('') } }, [p.offen])

  const d = p.diff
  const gruppen = useMemo(() => (d ? gruppieren(d.changes, p.spec) : []), [d, p.spec])
  const gesendet = d ? d.changes.filter(c => !c.blocked) : []
  const blockiert = d ? d.changes.filter(c => !!c.blocked) : []
  const fehlerListe = d ? d.issues.filter(i => i.severity === 'error') : []
  const lintBlocker = d ? d.lint.filter(l => l.severity === 'blocker') : []
  const lernNeu = gruppen.filter(g => g.changes.some(c => !c.blocked && c.learning_reset)).length
  const aktiviert = gesendet.some(c => /\.status$/.test(c.field) && c.after === 'ACTIVE')
  const creative = gesendet.some(c => c.creative)
  const g = d?.guardrail ?? null
  const forceOk = p.istAdmin && forceGrund.trim().length >= 10
  const housingNoetig = !!p.housingVerlangt || (!!d && d.warnings.some(w => HOUSING_WARNUNG.test(w)))
  const housingOk = p.istAdmin && housingGrund.trim().length >= 10

  const gruende: string[] = []
  if (p.schreibSperre) gruende.push(p.schreibSperre)
  if (d && !gesendet.length) gruende.push(t('crm.werbung.bearbeiten.diff.nichts', 'Nichts zu übernehmen.'))
  if (fehlerListe.length) gruende.push(t('crm.werbung.bearbeiten.diff.fehlerErst', 'Erst die Fehler beheben.'))
  if (lintBlocker.length && !forceOk) gruende.push(p.istAdmin
    ? t('crm.werbung.bearbeiten.diff.lintAdmin', 'Compliance-Blocker beheben oder unten begründen.')
    : t('crm.werbung.bearbeiten.diff.lint', 'Erst die Compliance-Blocker im Werbemittel beheben.'))
  if (housingNoetig && !housingOk) gruende.push(p.istAdmin
    ? t('crm.werbung.bearbeiten.diff.housingAdmin', 'Kampagne ohne Wohnen: Werbemittel-Änderungen nur mit Begründung (unten).')
    : t('crm.werbung.bearbeiten.diff.housing', 'Kampagne ohne Wohnen: Werbemittel-Änderungen kann nur ein Admin mit Begründung übernehmen.'))
  if (g && g.ok === false) gruende.push(t('crm.werbung.bearbeiten.diff.leitplanke', 'Die Leitplanke (Tageslimit des Werbekontos) wäre überschritten.'))
  const darf = !!d && !p.laedt && !p.uebernimmt && gruende.length === 0

  const zeile = (c: EditChange) => {
    const pct = istGeldFeld(c.field) ? budgetProzent(c.before, c.after) : null
    return (
      <li key={`${c.field}`}>
        <button type="button" onClick={() => p.onSpringe(c.node, c.field)}
          className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/50 ${c.blocked ? 'opacity-70' : ''}`}>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-gray-800">{t(c.label_key, c.field)}</span>
            {!c.blocked && c.learning_reset && <LernphaseBadge />}
            {!c.blocked && c.learning === 'moeglich' && <LernphaseBadge text={t('crm.werbung.bearbeiten.lernphaseKann', 'Lernphase kann neu starten')} />}
            {!c.blocked && pct !== null && Math.abs(pct) > BUDGET_LERN_SCHWELLE && c.learning !== 'moeglich' && !c.learning_reset && (
              <LernphaseBadge text={t('crm.werbung.bearbeiten.lernphaseKann', 'Lernphase kann neu starten')} />
            )}
            {!c.blocked && c.creative && <Badge tone="info">{t('crm.werbung.bearbeiten.diff.neuesWerbemittel', 'Neues Werbemittel')}</Badge>}
            {c.blocked && <Badge tone="neutral">{t('crm.werbung.bearbeiten.diff.nichtGesendet', 'wird nicht gesendet')}</Badge>}
          </span>
          <span className="mt-0.5 block break-words text-gray-600 tabular-nums">
            <span className="line-through decoration-gray-300">{wertText(t, fmt, p.kurs, c.field, c.before)}</span>
            {' → '}
            <span className="text-gray-900">{wertText(t, fmt, p.kurs, c.field, c.after)}</span>
            {pct !== null && <span className={`ml-1.5 ${pct > 0 ? 'text-emerald-700' : 'text-red-700'}`}>({pct > 0 ? '+' : ''}{pct} %)</span>}
          </span>
          {c.blocked && <span className="mt-0.5 block text-[11px] text-hp-navy/80">🔒 {c.blocked}</span>}
        </button>
      </li>
    )
  }

  const footer = p.ergebnis ? (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
      <button type="button" onClick={p.onWeiter} className="hp-btn hp-btn-ghost">{t('crm.werbung.bearbeiten.diff.weiter', 'Weiter bearbeiten')}</button>
      <button type="button" onClick={p.onFertig} className="hp-btn hp-btn-primary">{t('crm.werbung.bearbeiten.diff.fertig', 'Fertig')}</button>
    </div>
  ) : (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <p className="min-w-0 text-[11px] text-gray-500 sm:mr-auto">{gruende.join(' ')}</p>
      <div className="flex gap-2">
        <button type="button" onClick={p.onClose} disabled={p.uebernimmt} className="hp-btn hp-btn-ghost">{t('crm.werbung.bearbeiten.abbrechen', 'Abbrechen')}</button>
        <button type="button" disabled={!darf}
          onClick={() => p.onUebernehmen({
            ...(lintBlocker.length && forceOk ? { force_lint_reason: forceGrund.trim() } : {}),
            ...(housingNoetig && housingOk ? { housing_override_reason: housingGrund.trim() } : {}),
          })}
          className={`hp-btn ${aktiviert ? 'hp-btn-accent' : 'hp-btn-primary'} disabled:opacity-50`}>
          {p.uebernimmt && <Spinner size="sm" />}
          {t('crm.werbung.bearbeiten.diff.knopf', 'Bei Meta übernehmen ({{n}})', { n: gesendet.length })}
        </button>
      </div>
    </div>
  )

  return (
    <Modal open={p.offen} onClose={() => { if (!p.uebernimmt) p.onClose() }} size="lg" closeOnBackdrop={!p.uebernimmt} footer={footer}
      title={p.ergebnis ? t('crm.werbung.bearbeiten.diff.ergebnisTitel', 'Ergebnis bei Meta') : t('crm.werbung.bearbeiten.diff.titel', 'Das ändert sich bei Meta')}>
      {p.ergebnis ? (
        <Ergebnis ergebnis={p.ergebnis} spec={p.spec} kurs={p.kurs} />
      ) : p.laedt ? (
        <div className="flex flex-col items-center gap-2 py-12 text-xs text-gray-500"><Spinner size="lg" />{t('crm.werbung.bearbeiten.diff.laedt', 'Vergleiche mit dem Stand bei Meta …')}</div>
      ) : p.fehler ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{p.fehler}</div>
      ) : d && !d.changes.length ? (
        <EmptyState icon="check" title={t('crm.werbung.bearbeiten.diff.leer', 'Keine Änderungen')}
          text={t('crm.werbung.bearbeiten.diff.leerText', 'Der Entwurf entspricht dem Stand bei Meta. Es gibt nichts zu übernehmen.')} />
      ) : d ? (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="info">{t('crm.werbung.bearbeiten.diff.anzahl', '{{n}} Änderungen', { n: gesendet.length })}</Badge>
            {blockiert.length > 0 && <Badge tone="neutral">{t('crm.werbung.bearbeiten.diff.gesperrt', '{{n}} gesperrt', { n: blockiert.length })}</Badge>}
            {lernNeu > 0 && <LernphaseBadge text={t('crm.werbung.bearbeiten.diff.lernAnzahl', 'Lernphase startet neu ({{n}})', { n: lernNeu })} />}
            {aktiviert && <Badge tone="danger" dot>{t('crm.werbung.bearbeiten.diff.aktiviert', 'Schaltet etwas ein: es entstehen Kosten')}</Badge>}
          </div>

          {gruppen.map(gr => (
            <section key={`${gr.level}-${gr.id}`} className="rounded-lg border border-gray-200">
              <header className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2">
                <Badge tone="neutral">{ebeneName(t, gr.level)}</Badge>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-hp-navy" title={gr.id}>{gr.name}</span>
              </header>
              <ul className="divide-y divide-gray-50 p-1">{gr.changes.map(zeile)}</ul>
            </section>
          ))}

          {creative && (
            <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-xs text-hp-navy">
              <p className="font-semibold">{t('crm.werbung.bearbeiten.diff.tauschTitel', 'Werbemittel-Tausch')}</p>
              <p>{d.creative_tausch === 'ersetzen'
                ? t('crm.werbung.bearbeiten.tausch.ersetzenText', 'Anzeige-ID und Berichtsverlauf bleiben, Meta prüft die Anzeige neu. Alte und neue Zahlen mischen sich, Reaktionen am alten Beitrag gehen nicht mit.')
                : t('crm.werbung.bearbeiten.tausch.neuText', 'Die neue Anzeige startet ohne Verlauf, die alte wird pausiert (nicht gelöscht). Die Zahlen bleiben je Werbemittel sauber getrennt, so rechnet auch der Qualitäts-Autopilot.')}</p>
            </div>
          )}

          {d.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-semibold">{t('crm.werbung.bearbeiten.diff.hinweise', 'Hinweise')}</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}

          {d.conflicts.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-semibold">{t('crm.werbung.bearbeiten.diff.konflikte', 'Bei Meta seit dem Laden geändert (wird übersprungen)')}</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                {d.conflicts.map((k, i) => (
                  <li key={i}>{objektName(p.spec, k.level, k.id) ?? k.id}: {k.field} = {wertText(t, fmt, p.kurs, k.field, k.live)}</li>
                ))}
              </ul>
              <p className="mt-1">{t('crm.werbung.bearbeiten.diff.konflikteText', 'Tipp: „Neu von Meta laden“ holt den aktuellen Stand.')}</p>
            </div>
          )}

          {fehlerListe.length > 0 && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <p className="font-semibold">{t('crm.werbung.bearbeiten.diff.fehler', 'Fehler (blockieren das Übernehmen)')}</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">{fehlerListe.map((i, n) => <li key={n}>{issueText(t, i)}</li>)}</ul>
            </div>
          )}

          {lintBlocker.length > 0 && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <p className="font-semibold">{t('crm.werbung.bearbeiten.diff.compliance', 'Compliance-Blocker im neuen Werbemittel')}</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">{lintBlocker.map((l, n) => <li key={n}>{t(l.messageKey, l.rule, { ...(l.params ?? {}), match: l.match ?? '' })}</li>)}</ul>
              {p.istAdmin && (
                <div className="mt-2">
                  <label htmlFor="diff-force" className="block text-[11px] font-semibold">{t('crm.werbung.bearbeiten.diff.forceLabel', 'Trotzdem übernehmen (nur Admin, Begründung wird protokolliert)')}</label>
                  <textarea id="diff-force" value={forceGrund} onChange={ev => setForceGrund(ev.target.value)} rows={2}
                    className="mt-1 w-full rounded-lg border border-red-200 bg-white px-2 py-1 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-200" />
                </div>
              )}
            </div>
          )}

          {housingNoetig && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <p className="font-semibold">{t('crm.werbung.bearbeiten.diff.housingTitel', 'Kampagne ohne Sonderkategorie Wohnen')}</p>
              <p className="mt-0.5">{t('crm.werbung.bearbeiten.diff.housingText', 'Ein neues oder getauschtes Immobilien-Werbemittel ist nur in Kampagnen mit Sonderkategorie Wohnen erlaubt. Sonst kann nur ein Admin mit Begründung übernehmen.')}</p>
              {p.istAdmin && (
                <div className="mt-2">
                  <label htmlFor="diff-housing" className="block text-[11px] font-semibold">{t('crm.werbung.bearbeiten.diff.housingLabel', 'Trotzdem übernehmen (nur Admin, mindestens 10 Zeichen, Begründung wird protokolliert)')}</label>
                  <textarea id="diff-housing" value={housingGrund} onChange={ev => setHousingGrund(ev.target.value)} rows={2}
                    className="mt-1 w-full rounded-lg border border-red-200 bg-white px-2 py-1 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-200" />
                </div>
              )}
            </div>
          )}

          {g && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${g.ok === false ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
              <p className="font-semibold">{t('crm.werbung.builder.pruef.leitplanke', 'Leitplanke Tagesbudget')}</p>
              <p className="mt-0.5 tabular-nums">
                {t('crm.werbung.bearbeiten.diff.leitplankeZeile', 'heute aktiv {{aktiv}}, nach der Änderung {{nachher}}, Limit {{limit}}', {
                  aktiv: fmt.eur(g.activeEur), nachher: fmt.eur(g.afterEur), limit: fmt.eur(g.limitEur),
                })}
              </p>
            </div>
          )}

          <p className="text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.diff.fuss', 'Nur Felder ohne Sperre gehen an Meta. Gelöscht oder archiviert wird nie etwas.')}</p>
        </div>
      ) : null}
    </Modal>
  )
}

function Ergebnis({ ergebnis, spec, kurs }: { ergebnis: EditApplyResponse; spec: DraftSpec; kurs: number }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const rb = ergebnis.readback
  const name = (c: { level: Level; id: string }) => objektName(spec, c.level, c.id) ?? c.id
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="success" dot>{t('crm.werbung.bearbeiten.diff.uebernommen', '{{n}} übernommen', { n: ergebnis.applied.length })}</Badge>
        {ergebnis.failed.length > 0 && <Badge tone="danger" dot>{t('crm.werbung.bearbeiten.diff.fehlgeschlagen', '{{n}} fehlgeschlagen', { n: ergebnis.failed.length })}</Badge>}
      </div>
      {ergebnis.applied.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {ergebnis.applied.map((c, i) => (
            <li key={`a${i}`} className="px-3 py-1.5 text-xs">
              <span className="mr-1 text-emerald-700" aria-hidden="true">✓</span>
              <span className="font-medium text-gray-800">{name(c)}</span> · {t(c.label_key, c.field)}: {wertText(t, fmt, kurs, c.field, c.after)}
            </li>
          ))}
        </ul>
      )}
      {ergebnis.failed.length > 0 && (
        <ul className="divide-y divide-red-100 rounded-lg border border-red-200 bg-red-50">
          {ergebnis.failed.map((c, i) => (
            <li key={`f${i}`} className="px-3 py-1.5 text-xs text-red-800">
              <span className="mr-1" aria-hidden="true">✕</span>
              <span className="font-medium">{name(c)}</span> · {t(c.label_key, c.field)}: {c.error}
            </li>
          ))}
        </ul>
      )}
      {(rb?.neue_anzeigen ?? []).length > 0 && (
        <div className="rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-xs text-hp-navy">
          <p className="font-semibold">{t('crm.werbung.bearbeiten.diff.neueAnzeigen', 'Neue Anzeigen mit dem geänderten Werbemittel')}</p>
          <ul className="mt-0.5 space-y-0.5">
            {rb.neue_anzeigen.map(n => (
              <li key={n.neu_id}>
                {n.alt_id} → {n.neu_id} · {n.aktiv
                  ? t('crm.werbung.bearbeiten.diff.neuAktiv', 'neue aktiv, alte pausiert')
                  : t('crm.werbung.bearbeiten.diff.neuPausiert', 'neue pausiert')}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(rb?.warnings ?? []).length > 0 && (
        <ul className="list-disc space-y-0.5 rounded-lg border border-amber-200 bg-amber-50 py-2 pl-7 pr-3 text-xs text-amber-900">
          {rb.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <p className="text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.diff.nachher', 'Der Entwurf zeigt jetzt den frischen Stand von Meta. Die Übersicht aktualisiert sich mit dem nächsten Abgleich.')}</p>
    </div>
  )
}
