import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Badge from '../../../ui/Badge'
import Spinner from '../../../ui/Spinner'
import { fieldSpec, type DraftIssue, type DraftSpec, type MetaLevelResult } from '../../../../lib/metaSpec'
import { lintCounts, type LintIssue } from '../../../../lib/metaLint'
import { useWerbeFormat } from '../format'
import { useAssistent, type Leitplanke } from './useEntwurf'

// ── Prüfung im Kampagnen-Assistenten ─────────────────────────────────────────
// Rechte Spalte unten: lokale Prüfung (validateDraft) und Compliance (lintDraft)
// live, „Prüfen bei Meta" (meta-builder validate, Fehler je Formularfeld) und
// die Leitplanke „heute aktiv + diese Kampagne <= Limit". FeldHinweise zeigt
// dieselben Meldungen direkt unter dem betroffenen Formularfeld.

export interface MetaFeldFehler { node: string; field: string | null; text: string }

/** Meta-Fehler der letzten Prüfung, auf Knoten + Formularfeld abgebildet */
export function metaFehlerAus(meta: readonly MetaLevelResult[] | undefined): MetaFeldFehler[] {
  const out: MetaFeldFehler[] = []
  for (const r of meta ?? []) {
    for (const i of r.issues ?? []) out.push({ node: r.key, field: i.field_key, text: i.user_msg || i.title })
  }
  return out
}

export const issueText = (t: TFunction, i: DraftIssue): string =>
  t(i.messageKey, i.code, { ...(i.params ?? {}) })

export const lintText = (t: TFunction, l: LintIssue): string =>
  t(l.messageKey, l.rule, { ...(l.params ?? {}), match: l.match ?? '' })

/** Name eines Knotens (Kampagne / Anzeigengruppe / Anzeige) für Listen */
export function knotenName(t: TFunction, spec: DraftSpec, node: string | undefined): string {
  if (!node || node === 'campaign') return t('crm.werbung.meta.level.campaign', 'Kampagne')
  const as = spec.adsets.find(a => a.key === node)
  if (as) return `${t('crm.werbung.meta.level.adset', 'Anzeigengruppe')} „${as.name || as.key}“`
  const ad = spec.ads.find(a => a.key === node)
  if (ad) return `${t('crm.werbung.meta.level.ad', 'Werbeanzeige')} „${ad.name || ad.key}“`
  return node
}

const feldLabel = (t: TFunction, key: string | null): string => {
  if (!key) return t('crm.werbung.builder.pruef.ohneFeld', 'Allgemein')
  const f = fieldSpec(key)
  return f ? t(f.labelKey, key) : key
}

/** Meldungen zu einem Formularfeld (lokal, Compliance, Meta) direkt unter dem Feld */
export function FeldHinweise({ node, felder }: { node: string; felder: string | readonly string[] }) {
  const { t } = useTranslation()
  const { e } = useAssistent()
  const liste = typeof felder === 'string' ? [felder] : felder
  const passt = (f: string | null | undefined) => !!f && liste.indexOf(f) >= 0
  const lokal = e.issues.filter(i => i.node === node && passt(i.field))
  const lint = e.lint.filter(l => (l.node ?? 'campaign') === node && passt(l.field))
  const meta = metaFehlerAus(e.validation?.meta).filter(m => m.node === node && passt(m.field))
  if (!lokal.length && !lint.length && !meta.length) return null
  return (
    <ul className="mt-1 space-y-0.5 text-[11px] leading-snug">
      {lokal.map((i, n) => (
        <li key={`l${n}`} className={i.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>{issueText(t, i)}</li>
      ))}
      {lint.map((l, n) => (
        <li key={`c${n}`} className={l.severity === 'blocker' ? 'text-red-700' : l.severity === 'warn' ? 'text-amber-700' : 'text-hp-navy'}>
          {lintText(t, l)}
        </li>
      ))}
      {meta.map((m, n) => (
        <li key={`m${n}`} className="text-red-700">
          <span className="font-semibold">{t('crm.werbung.builder.pruef.metaSagt', 'Meta:')}</span> {m.text}
        </li>
      ))}
    </ul>
  )
}

const UEBERSPRUNGEN: Record<string, [string, string]> = {
  app_dev_mode: ['crm.werbung.builder.pruef.skip.app_dev_mode', 'Nicht prüfbar: die Meta-App ist im Entwicklungsmodus.'],
  no_proxy_campaign: ['crm.werbung.builder.pruef.skip.no_proxy_campaign', 'Nicht prüfbar: keine pausierte Prüf-Kampagne mit gleichem Ziel vorhanden.'],
  call_cap: ['crm.werbung.builder.pruef.skip.call_cap', 'Nicht geprüft: Höchstzahl an Prüfaufrufen erreicht.'],
  existing: ['crm.werbung.builder.pruef.skip.existing', 'Besteht schon bei Meta, wird nicht neu angelegt.'],
  rate_limited: ['crm.werbung.builder.pruef.skip.rate_limited', 'Nicht geprüft: Meta bremst gerade.'],
}

interface Props {
  leitplanke: Leitplanke
  onPruefen: () => void
  pruefLaeuft: boolean
  istAdmin: boolean
  forceGrund: string
  setForceGrund: (s: string) => void
}

export default function PruefPanel({ leitplanke, onPruefen, pruefLaeuft, istAdmin, forceGrund, setForceGrund }: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const { e, springeZu } = useAssistent()
  const { spec, issues, lint, validation } = e

  const fehler = issues.filter(i => i.severity === 'error')
  const warnungen = issues.filter(i => i.severity === 'warn')
  const lc = lintCounts(lint)
  const meta = useMemo(() => metaFehlerAus(validation?.meta), [validation])

  const zeit = validation?.validated_at
    ? new Date(validation.validated_at).toLocaleTimeString(fmt.locale, { hour: '2-digit', minute: '2-digit' })
    : null

  const lp = leitplanke
  const euro = (v: number | null) => (v === null ? '?' : fmt.eur(v))

  const eintrag = (key: string, node: string | undefined, field: string | null, text: string, ton: string) => (
    <li key={key}>
      <button type="button" onClick={() => springeZu(node ?? 'campaign', field ?? undefined)}
        className={`w-full rounded-md px-2 py-1 text-left text-xs hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/50 ${ton}`}>
        <span className="block text-[10px] uppercase tracking-wide text-gray-400">
          {knotenName(t, spec, node)} · {feldLabel(t, field)}
        </span>
        {text}
      </button>
    </li>
  )

  return (
    <section aria-labelledby="pruef-titel" className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 id="pruef-titel" className="mr-auto font-heading text-base text-hp-navy">{t('crm.werbung.builder.pruef.titel', 'Prüfung')}</h3>
        {fehler.length > 0 && <Badge tone="danger" dot>{t('crm.werbung.builder.pruef.fehler', '{{n}} Fehler', { n: fehler.length })}</Badge>}
        {lc.blocker > 0 && <Badge tone="danger" dot>{t('crm.werbung.builder.pruef.blocker', '{{n}} Compliance', { n: lc.blocker })}</Badge>}
        {warnungen.length + lc.warn > 0 && <Badge tone="warning" dot>{t('crm.werbung.builder.pruef.hinweise', '{{n}} Hinweise', { n: warnungen.length + lc.warn })}</Badge>}
        {lc.manual > 0 && <Badge tone="info" dot>{t('crm.werbung.builder.pruef.bestaetigen', '{{n}} bestätigen', { n: lc.manual })}</Badge>}
        {!fehler.length && !lc.blocker && !warnungen.length && !lc.warn && !lc.manual && (
          <Badge tone="success" dot>{t('crm.werbung.builder.pruef.allesOk', 'Lokal alles in Ordnung')}</Badge>
        )}
      </div>

      {/* Leitplanke */}
      <div className={`rounded-lg border px-3 py-2 text-xs ${lp.ok === false ? 'border-red-200 bg-red-50 text-red-800' : lp.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
        <p className="font-semibold">{t('crm.werbung.builder.pruef.leitplanke', 'Leitplanke Tagesbudget')}</p>
        <p className="mt-0.5 tabular-nums">
          {t('crm.werbung.builder.pruef.leitplankeZeile', 'heute aktiv {{aktiv}} + diese Kampagne {{diese}} ≤ Limit {{limit}}', {
            aktiv: euro(lp.aktivEur), diese: fmt.eur(lp.dieseEur), limit: euro(lp.limitEur),
          })}
        </p>
        <p className="mt-0.5 text-[10px] opacity-80">
          {lp.quelle === 'server'
            ? t('crm.werbung.builder.pruef.leitplankeServer', 'Stand der letzten Prüfung bei Meta.')
            : lp.aktivEur === null
              ? t('crm.werbung.builder.pruef.leitplankeUnbekannt', 'Aktive Budgets noch unbekannt (Spiegel leer). „Prüfen bei Meta“ rechnet live.')
              : t('crm.werbung.builder.pruef.leitplankeSchaetzung', 'Schätzung aus dem letzten Abgleich, Kurs 1 € = {{kurs}} $.', { kurs: lp.kurs.toLocaleString(fmt.locale, { maximumFractionDigits: 3 }) })}
          {lp.ok === false && ` ${t('crm.werbung.builder.pruef.leitplankeZuViel', 'Aktivieren wäre über dem Limit.')}`}
        </p>
      </div>

      {/* Prüfen bei Meta */}
      <div className="rounded-lg border border-gray-200 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onPruefen} disabled={pruefLaeuft || e.nurLesen}
            className="hp-btn hp-btn-accent min-h-0 px-3 py-1.5 text-xs disabled:opacity-50">
            {pruefLaeuft ? <Spinner size="sm" /> : null}
            {t('crm.werbung.builder.pruef.beiMeta', 'Prüfen bei Meta')}
          </button>
          <span className="text-[11px] text-gray-500">
            {!validation
              ? t('crm.werbung.builder.pruef.nochNicht', 'Noch nicht bei Meta geprüft.')
              : e.pruefungVeraltet
                ? t('crm.werbung.builder.pruef.veraltet', 'Geprüft um {{zeit}}, inzwischen veraltet.', { zeit })
                : validation.ok
                  ? t('crm.werbung.builder.pruef.ok', 'Geprüft um {{zeit}}: Meta hat nichts zu beanstanden.', { zeit })
                  : t('crm.werbung.builder.pruef.nichtOk', 'Geprüft um {{zeit}}: Meta meldet Fehler.', { zeit })}
          </span>
        </div>
        {validation && (
          <ul className="mt-2 space-y-1">
            {validation.meta.map(r => (
              <li key={`${r.level}-${r.key}`} className="text-xs">
                <span className={`mr-1 font-semibold ${r.ok ? 'text-emerald-700' : r.skipped ? 'text-gray-500' : 'text-red-700'}`}>
                  {r.ok ? '✓' : r.skipped ? '·' : '✕'}
                </span>
                <span className="text-gray-700">{knotenName(t, spec, r.key)}</span>
                {r.skipped && (
                  <span className="block pl-4 text-[11px] text-gray-500">
                    {UEBERSPRUNGEN[r.skipped] ? t(UEBERSPRUNGEN[r.skipped][0], UEBERSPRUNGEN[r.skipped][1]) : r.skipped}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {meta.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {meta.map((m, n) => eintrag(`m${n}`, m.node, m.field, m.text, 'text-red-700'))}
          </ul>
        )}
      </div>

      {/* Lokale Fehler und Hinweise */}
      {(fehler.length > 0 || warnungen.length > 0) && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{t('crm.werbung.builder.pruef.lokal', 'Einstellungen')}</p>
          <ul className="space-y-0.5">
            {fehler.map((i, n) => eintrag(`f${n}`, i.node, i.field, issueText(t, i), 'text-red-700'))}
            {warnungen.map((i, n) => eintrag(`w${n}`, i.node, i.field, issueText(t, i), 'text-amber-700'))}
          </ul>
        </div>
      )}

      {/* Compliance (HP-Regeln) */}
      {lint.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{t('crm.werbung.builder.pruef.compliance', 'Compliance')}</p>
          <ul className="space-y-0.5">
            {lint.map((l, n) => eintrag(`c${n}`, l.node, l.field, lintText(t, l),
              l.severity === 'blocker' ? 'text-red-700' : l.severity === 'warn' ? 'text-amber-700' : 'text-hp-navy'))}
          </ul>
        </div>
      )}

      {/* Admin: Blocker mit Begründung übergehen (wird protokolliert) */}
      {istAdmin && lc.blocker > 0 && !e.nurLesen && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <label className="block text-[11px] font-semibold text-amber-900" htmlFor="force-grund">
            {t('crm.werbung.builder.pruef.forceLabel', 'Trotz Compliance-Blockern anlegen (nur Admin)')}
          </label>
          <textarea id="force-grund" value={forceGrund} onChange={ev => setForceGrund(ev.target.value)} rows={2}
            placeholder={t('crm.werbung.builder.pruef.forcePh', 'Begründung, wird mit der Anlage protokolliert')}
            className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-amber-200" />
        </div>
      )}
    </section>
  )
}
