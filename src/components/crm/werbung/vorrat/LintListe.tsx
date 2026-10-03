import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Badge, { type BadgeTone } from '../../../ui/Badge'

// ── Prüfhinweise (metaLint) als Liste ────────────────────────────────────────
// Für die Live-Prüfung im Formular (LintIssue) und für qa.lint der
// automatischen Prüfung (gleiche Felder ohne messageKey).

export interface LintZeile {
  severity: string
  rule: string
  field: string
  match?: string
  params?: Record<string, string | number>
}

const TON: Record<string, BadgeTone> = { blocker: 'danger', warn: 'warning', manual: 'info' }
const ORDNUNG: Record<string, number> = { blocker: 0, manual: 1, warn: 2 }

/** Feldname für Prüfhinweise und fehlende Punkte */
export function feldName(t: TFunction, field: string): string {
  switch (field) {
    case 'ad.primary_texts': return t('crm.werbung.vorrat.feld.primaer', 'Primärtext')
    case 'ad.headlines': return t('crm.werbung.vorrat.feld.ueberschrift', 'Überschrift')
    case 'ad.descriptions': return t('crm.werbung.vorrat.feld.beschreibung', 'Beschreibung')
    case 'ad.destination.url': return t('crm.werbung.vorrat.feld.lpUrl', 'Ziel-Link')
    case 'ad.name': return t('crm.werbung.vorrat.feld.kennung', 'Kennung')
    case 'ad.media.feed_4x5': return t('crm.werbung.vorrat.feld.feed', 'Feed-Bild 4:5')
    case 'ad.media.story_9x16': return t('crm.werbung.vorrat.feld.story', 'Story-Bild 9:16')
    default: return field
  }
}

export default function LintListe({ issues, leerText }: { issues: LintZeile[]; leerText?: string }) {
  const { t } = useTranslation()
  if (!issues.length) {
    return leerText ? <p className="text-xs text-emerald-700">✓ {leerText}</p> : null
  }
  const sortiert = [...issues].sort((a, b) => (ORDNUNG[a.severity] ?? 3) - (ORDNUNG[b.severity] ?? 3))
  return (
    <ul className="space-y-1.5">
      {sortiert.map((i, n) => {
        const nr = i.params?.index
        return (
          <li key={`${i.rule}-${i.field}-${n}`} className="flex flex-wrap items-start gap-1.5 text-xs leading-snug">
            <Badge tone={TON[i.severity] ?? 'neutral'}>
              {t(`crm.werbung.lint.severity.${i.severity}`, i.severity)}
            </Badge>
            <span className="font-semibold text-gray-700">
              {feldName(t, i.field)}{nr != null ? ` ${nr}` : ''}:
            </span>
            <span className="min-w-0 flex-1 text-gray-600">
              {t(`crm.werbung.lint.${i.rule}`, i.rule, { match: i.match ?? '', ...(i.params ?? {}) })}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
