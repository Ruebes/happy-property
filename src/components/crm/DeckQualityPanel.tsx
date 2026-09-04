import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

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
}
interface ScrubEvent { rule: string; block: number; blockType: string; field: string; removed: string }
interface Report {
  status?: string
  checked_blocks?: number
  findings?: Finding[]
  normalization?: string[]
  scrub_events?: ScrubEvent[]
  facts_snapshot?: Array<Record<string, unknown>>
  source?: string
  generated_at?: string
}

const SEV_STYLE: Record<string, string> = {
  kritisch: 'bg-red-100 text-red-700 border-red-200',
  hoch:     'bg-orange-100 text-orange-700 border-orange-200',
  mittel:   'bg-amber-50 text-amber-700 border-amber-200',
  niedrig:  'bg-gray-100 text-gray-600 border-gray-200',
}

export default function DeckQualityPanel({ token, label, onClose }: { token: string; label?: string; onClose: () => void }) {
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
  const scrub = report?.scrub_events ?? []
  const norm = report?.normalization ?? []

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

          {!loading && !report && (
            <p className="text-sm text-gray-500">
              {t('deckQuality.noReport', 'Für dieses Deck gibt es keinen Prüfbericht. Es wurde vor der Einführung des Quality-Gates erstellt oder stammt aus einem anderen Erzeugungsweg (z.B. Newsletter).')}
            </p>
          )}

          {!loading && report && findings.length === 0 && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
              {t('deckQuality.allClear', 'Keine Beanstandungen. Preise, Wohnungsdaten, Zahlungsplan, Grundriss und Bilder stimmen mit den hinterlegten Fakten überein.')}
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
