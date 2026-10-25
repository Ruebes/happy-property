import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { baueChatAnweisung, chatBehebbar } from '../../lib/deckFixAnweisung'
import DeckReviewSection from './DeckReviewSection'

// ── Prüfpanel eines Decks ────────────────────────────────────────────────────
// Zeigt, WARUM ein Deck rot ist: Problem, betroffener Wert, die beiden Quellen,
// der betroffene Block und der Vorschlag zur Lösung. Das Quality-Gate versteckt
// nichts — es macht sichtbar, was es gefunden hat.
//
// Zusätzlich sichtbar: was die deterministische Normalisierung geändert hat und
// welche Sätze der Scrubber entfernt hat. Ohne diese Liste ließ sich nie
// beurteilen, welche Regel überhaupt greift.

interface Finding {
  key: string
  severity: 'kritisch' | 'hoch' | 'mittel' | 'niedrig'
  what: string
  block?: number
  evidence?: string
  sourceA?: string
  sourceB?: string
  fix?: string
  /** Behauptungen: Aussage im Wortlaut; Gate-Befunde: Feld und Fundstelle. */
  claim?: string
  loc?: { field?: string; match?: string; index?: number }
}
interface ScrubEvent { rule: string; block: number; blockType: string; field: string; removed: string }
// Abschnitt der Autobereinigung (supabase/functions/_shared/deckAutofix.ts). Alle
// Felder optional: alte Berichte haben ihn nicht.
interface AutofixChange { finding_key: string; severity?: string; what?: string; block: number; block_type?: string; field?: string; action: string; before?: string; after?: string; hint?: string }
interface Autofix {
  mode?: string
  status?: string
  rollback_reason?: string
  /** Fester Code zum Grund (deckAutofix.ts RollbackCode), fehlt in alten Berichten. */
  rollback_code?: string
  error?: string
  changes?: AutofixChange[]
  skipped?: Array<{ key: string; block?: number; what?: string; reason: string }>
  superseded_at?: string
  undone_at?: string
}
interface Report {
  status?: string
  checked_blocks?: number
  findings?: Finding[]
  normalization?: string[]
  scrub_events?: ScrubEvent[]
  facts_snapshot?: Array<Record<string, unknown>>
  source?: string
  generated_at?: string
  coverage?: { deck_type?: string | null; usable?: number; used?: number; excluded_wrong_type?: number; review?: number; by_type?: Record<string, { usable: number; used: number }> }
  autofix?: Autofix | null
}

const SEV_STYLE: Record<string, string> = {
  kritisch: 'bg-red-100 text-red-700 border-red-200',
  hoch:     'bg-orange-100 text-orange-700 border-orange-200',
  mittel:   'bg-amber-50 text-amber-700 border-amber-200',
  niedrig:  'bg-gray-100 text-gray-600 border-gray-200',
}

export default function DeckQualityPanel({ token, label, onClose, onFixInChat }: {
  token: string; label?: string; onClose: () => void
  /** Öffnet den Deck-Chat mit vorbefüllter Anweisung (sendet nicht selbst). */
  onFixInChat?: (instruction: string) => void
}) {
  const { t } = useTranslation()
  const [report, setReport] = useState<Report | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data } = await supabase.from('sales_decks')
        .select('quality_status, quality_report, quality_checked_at').eq('token', token).maybeSingle()
      if (cancelled) return
      const d = data as { quality_status: string | null; quality_report: Report | null; quality_checked_at: string | null } | null
      setStatus(d?.quality_status ?? null)
      setReport(d?.quality_report ?? null)
      setCheckedAt(d?.quality_checked_at ?? null)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [token])

  const findings = report?.findings ?? []
  // Offene Befunde, die die KI im Deck-Chat per Text beheben kann (Anweisung immer deutsch).
  const chatFixes = chatBehebbar(findings)
  const scrub = report?.scrub_events ?? []
  const norm = report?.normalization ?? []
  const af = report?.autofix ?? null
  const afChanges = af?.changes ?? []
  const afSkipped = af?.skipped ?? []
  const afSichtbar = !!af?.status && (af.status !== 'nothing_to_fix' || afSkipped.length > 0)
  // Nur bei 'applied' stehen die Änderungen im Deck. Probelauf, Rücknahme und
  // Rückgängig: Liste zeigt, was bereinigt worden WÄRE, das Deck ist unverändert.
  const afNichtUebernommen = af?.status === 'dry_run' || af?.status === 'rolled_back' || af?.status === 'undone'
  // Grund der Rücknahme übersetzt; ohne Code (alte Berichte) der deutsche Text aus dem Bericht.
  const afRueckGrund = (a: Autofix): string => a.rollback_code
    ? t(`deckQuality.autofix.rollback.${a.rollback_code}`, a.rollback_reason ?? '')
    : a.rollback_reason ?? ''
  const afTitel = (a: Autofix): string => {
    const n = afChanges.length
    switch (a.status) {
      case 'applied': return t('deckQuality.autofix.applied', 'Automatisch bereinigt ({{n}})', { n })
      case 'dry_run': return t('deckQuality.autofix.dryRun', 'Probelauf: würde bereinigen ({{n}})', { n })
      case 'rolled_back': return a.mode === 'dry_run'
        ? t('deckQuality.autofix.dryRunRolledBack', 'Probelauf: Bereinigung würde zurückgenommen ({{reason}})', { reason: afRueckGrund(a) })
        : t('deckQuality.autofix.rolledBack', 'Bereinigung zurückgenommen ({{reason}})', { reason: afRueckGrund(a) })
      case 'undone': return t('deckQuality.autofix.undone', 'Automatische Bereinigung von Hand rückgängig gemacht')
      case 'error': return t('deckQuality.autofix.error', 'Automatische Bereinigung ausgefallen: {{e}}', { e: a.error ?? '' })
      default: return t('deckQuality.autofix.nothing', 'Nichts automatisch bereinigt')
    }
  }
  const afAktion = (a: string): string => ({
    satz_entfernt: t('deckQuality.autofix.action.satz_entfernt', 'Satz gestrichen'),
    punkt_entfernt: t('deckQuality.autofix.action.punkt_entfernt', 'Listenpunkt gestrichen'),
    karte_entfernt: t('deckQuality.autofix.action.karte_entfernt', 'Karte gestrichen'),
    feld_geleert: t('deckQuality.autofix.action.feld_geleert', 'Feld geleert'),
    wert_gesetzt: t('deckQuality.autofix.action.wert_gesetzt', 'Wert aus dem CRM gesetzt'),
  } as Record<string, string>)[a] ?? a
  const afGrund = (r: string): string => ({
    systemblock: t('deckQuality.autofix.reason.systemblock', 'Systemblock aus dem CRM, wird nie automatisch geändert'),
    gesperrtes_feld: t('deckQuality.autofix.reason.gesperrtes_feld', 'Überschrift, Titel oder festes Feld'),
    html_feld: t('deckQuality.autofix.reason.html_feld', 'Feld mit Formatierung (HTML, Zeichen-Code oder **)'),
    nicht_lokalisierbar: t('deckQuality.autofix.reason.nicht_lokalisierbar', 'Stelle nicht wörtlich gefunden oder Satzgrenze unsicher (Abkürzung)'),
    mehrdeutig: t('deckQuality.autofix.reason.mehrdeutig', 'Stelle kommt mehrfach vor'),
    pflichtfeld: t('deckQuality.autofix.reason.pflichtfeld', 'Pflichttext wäre leer geworden oder die Anrede wäre weggefallen'),
    zu_wenige_karten: t('deckQuality.autofix.reason.zu_wenige_karten', 'Es blieben weniger als 3 Key Facts'),
    neuer_befund: t('deckQuality.autofix.reason.neuer_befund', 'Korrektur hätte einen neuen Befund erzeugt'),
    ziel_nicht_behoben: t('deckQuality.autofix.reason.ziel_nicht_behoben', 'Befund wäre danach nicht behoben gewesen'),
    limit: t('deckQuality.autofix.reason.limit', 'Grenze erreicht (Anzahl oder Textmenge)'),
    kontext: t('deckQuality.autofix.reason.kontext', 'Nachbartext hängt an der Stelle (Verweis, Zitat oder Doppelpunkt)'),
    fliesstext: t('deckQuality.autofix.reason.fliesstext', 'Steht mitten im Fließtext - bitte selbst umformulieren oder im Deck-Chat ändern'),
  } as Record<string, string>)[r] ?? r

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-6" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-3xl max-h-[88vh] rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
          <span className={`text-xs font-semibold px-2 py-1 rounded-full ${status === 'red' ? 'bg-red-100 text-red-700' : status === 'green' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
            {status === 'red' ? t('deckQuality.red', 'Prüfen') : status === 'green' ? t('deckQuality.green', 'Validiert') : t('deckQuality.none', 'Ungeprüft')}
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-800 truncate">{t('deckQuality.title', 'Deck-Prüfung')}{label ? ` · ${label}` : ''}</h3>
            {checkedAt && <p className="text-[11px] text-gray-400">{new Date(checkedAt).toLocaleString('de-DE')}{report?.checked_blocks ? ` · ${report.checked_blocks} ${t('deckQuality.blocks', 'Blöcke')}` : ''}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none px-2">×</button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {loading && <p className="text-sm text-gray-400">{t('deckQuality.loading', 'Lade Bericht…')}</p>}

          <DeckReviewSection token={token} onFixInChat={onFixInChat} />

          {!loading && onFixInChat && chatFixes.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => onFixInChat(baueChatAnweisung(findings))}
                title={t('deckQuality.fixInChatTitle', 'Öffnet den Deck-Chat mit einer vorbereiteten Anweisung. Gesendet wird erst, wenn du auf Senden klickst.')}
                className="text-sm font-medium px-3 py-1.5 rounded-lg text-white hover:opacity-90" style={{ backgroundColor: '#ff795d' }}>
                ✏️ {t('deckQuality.fixInChat', 'Im Deck-Chat beheben ({{n}})', { n: chatFixes.length })}
              </button>
              <span className="text-[11px] text-gray-500">{t('deckQuality.fixInChatHint', 'Die Anweisung steht danach im Eingabefeld, du kannst sie vor dem Senden anpassen.')}</span>
            </div>
          )}

          {!loading && !report && (
            <p className="text-sm text-gray-500">
              {t('deckQuality.noReport', 'Für dieses Deck gibt es keinen Prüfbericht. Es wurde vor der Einführung des Quality-Gates erstellt oder stammt aus einem anderen Erzeugungsweg (z.B. Newsletter).')}
            </p>
          )}

          {!loading && af && afSichtbar && (
            <section className="border border-sky-100 bg-sky-50/50 rounded-lg px-3 py-3">
              <h4 className="text-xs font-semibold text-sky-800 uppercase tracking-wide">🧹 {afTitel(af)}</h4>
              {af.superseded_at && (
                <p className="text-[11px] text-gray-500 mt-0.5">{t('deckQuality.autofix.superseded', 'Danach im Deck-Chat bearbeitet. Die Liste zeigt den Stand der Erzeugung.')}</p>
              )}
              {af.status === 'dry_run' && (
                <p className="text-[11px] text-gray-500 mt-0.5">{t('deckQuality.autofix.dryRunHint', 'Im Probelauf bleibt das Deck unverändert.')}</p>
              )}
              {(af.status === 'rolled_back' || af.status === 'undone') && !af.superseded_at && afChanges.length > 0 && (
                <p className="text-[11px] text-gray-600 mt-0.5">{t('deckQuality.autofix.notApplied', 'Diese Änderungen sind NICHT im Deck. Es enthält den Text, wie die KI ihn geschrieben hat.')}</p>
              )}
              {afChanges.length > 0 && (
                <ul className="space-y-2 mt-2">
                  {afChanges.map((c, i) => (
                    <li key={i} className={`text-[12px] bg-white border border-gray-100 rounded px-2 py-1.5${afNichtUebernommen ? ' opacity-70' : ''}`}>
                      <p className="text-gray-500">
                        {t('deckQuality.block', 'Block')} {c.block}{c.block_type ? ` (${c.block_type}${c.field ? `/${c.field}` : ''})` : ''} · <span className="font-medium text-gray-700">{afAktion(c.action)}</span>
                      </p>
                      {c.what && <p className="text-gray-600 mt-0.5 break-words">{c.what}</p>}
                      {c.before && <p className={`mt-0.5 break-words ${afNichtUebernommen ? 'text-gray-600' : 'text-gray-400 line-through'}`}>{c.before}</p>}
                      <p className={`mt-0.5 break-words ${afNichtUebernommen ? 'text-gray-400 italic' : 'text-gray-800'}`}>
                        {afNichtUebernommen && c.after ? `${t('deckQuality.autofix.wouldBe', 'wäre:')} ` : ''}
                        {c.after ? c.after : afNichtUebernommen ? t('deckQuality.autofix.wouldRemove', '(wäre gestrichen)') : t('deckQuality.autofix.removed', '(gestrichen)')}
                      </p>
                      {c.hint === 'fakt_hinterlegen' && af.status === 'applied' && (
                        <p className="text-[11px] text-sky-800 mt-1">{t('deckQuality.autofix.hintFact', 'Stimmt die Aussage? Dann als Fakt im Projekt hinterlegen, sonst fällt sie in jedem Deck wieder raus.')}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {afSkipped.length > 0 && (
                <details className="mt-2">
                  <summary className="text-[12px] text-gray-600 cursor-pointer">{t('deckQuality.autofix.skipped', 'Nicht automatisch bereinigt ({{n}})', { n: afSkipped.length })}</summary>
                  <ul className="mt-1 space-y-1">
                    {afSkipped.map((x, i) => (
                      <li key={i} className="text-[12px] text-gray-600 break-words">
                        {x.block != null ? `${t('deckQuality.block', 'Block')} ${x.block} · ` : ''}{x.what || x.key}: <span className="text-gray-500">{afGrund(x.reason)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {af.status === 'applied' && !af.superseded_at && (
                <p className="text-[11px] text-gray-500 mt-2">{t('deckQuality.autofix.undoHint', '„↶ Letzte Änderung rückgängig“ im Deck-Chat stellt die unbereinigte Fassung samt Ampel wieder her.')}</p>
              )}
            </section>
          )}

          {!loading && report && findings.length === 0 && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
              {t('deckQuality.allClear', 'Keine Beanstandungen. Preise, Wohnungsdaten, Zahlungsplan, Grundriss und Bilder stimmen mit den hinterlegten Fakten überein.')}
            </p>
          )}

          {!loading && report?.coverage && typeof report.coverage.usable === 'number' && (
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              {t('deckQuality.coverage', 'Bilder: {{used}} von {{usable}} verwendbaren Projektbildern im Deck', { used: report.coverage.used ?? 0, usable: report.coverage.usable })}
              {report.coverage.deck_type ? ` · ${t('deckQuality.coverageType', 'Wohnungstyp {{type}}', { type: report.coverage.deck_type })}` : ''}
              {report.coverage.excluded_wrong_type ? ` · ${t('deckQuality.coverageExcluded', '{{n}} Bilder anderer Typen ausgeschlossen', { n: report.coverage.excluded_wrong_type })}` : ''}
              {report.coverage.review ? ` · ${t('deckQuality.coverageReview', '{{n}} zur Prüfung', { n: report.coverage.review })}` : ''}
            </p>
          )}

          {findings.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {t('deckQuality.findings', 'Befunde')} ({findings.length})
              </h4>
              <ul className="space-y-2">
                {findings.map((f, i) => (
                  <li key={i} className={`border rounded-lg px-3 py-2 ${SEV_STYLE[f.severity] ?? SEV_STYLE.niedrig}`}>
                    <div className="flex items-start gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wide shrink-0 mt-0.5">{f.severity}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{f.what}</p>
                        {f.block != null && (
                          <p className="text-[11px] opacity-70 mt-0.5">{t('deckQuality.block', 'Block')} {f.block}</p>
                        )}
                        {f.evidence && <p className="text-[12px] mt-1 opacity-90 break-words">{f.evidence}</p>}
                        {(f.sourceA || f.sourceB) && (
                          <div className="text-[12px] mt-1 space-y-0.5">
                            {f.sourceA && <p className="break-words"><span className="opacity-60">A:</span> {f.sourceA}</p>}
                            {f.sourceB && <p className="break-words"><span className="opacity-60">B:</span> {f.sourceB}</p>}
                          </div>
                        )}
                        {f.fix && <p className="text-[12px] mt-1 font-medium">→ {f.fix}</p>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {norm.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {t('deckQuality.normalization', 'Automatisch gesetzt')}
              </h4>
              <ul className="text-[13px] text-gray-600 space-y-1 list-disc pl-5">
                {norm.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </section>
          )}

          {scrub.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {t('deckQuality.scrub', 'Vom Filter entfernte Sätze')} ({scrub.length})
              </h4>
              <ul className="space-y-1">
                {scrub.map((s, i) => (
                  <li key={i} className="text-[12px] bg-gray-50 border border-gray-100 rounded px-2 py-1.5">
                    <span className="font-mono text-[10px] text-gray-400">{s.rule}</span>
                    <span className="text-gray-400"> · {t('deckQuality.block', 'Block')} {s.block} ({s.blockType}/{s.field})</span>
                    <p className="text-gray-700 mt-0.5 break-words">„{s.removed}"</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(report?.facts_snapshot?.length ?? 0) > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {t('deckQuality.facts', 'Geprüfte Fakten')}
              </h4>
              <div className="overflow-x-auto">
                <pre className="text-[11px] text-gray-600 bg-gray-50 border border-gray-100 rounded p-2">
                  {JSON.stringify(report!.facts_snapshot, null, 1)}
                </pre>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
