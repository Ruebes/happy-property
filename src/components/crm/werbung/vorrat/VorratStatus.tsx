import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Badge, { type BadgeTone } from '../../../ui/Badge'

// ── Status des Vorrats: Bezeichnung und Farbe ────────────────────────────────
// Unbekannte Werte (künftige Status) neutral anzeigen, nie abstürzen
// (Lehre 26.9., Live-Bundle-Enum-Crash).

const TON: Record<string, BadgeTone> = {
  entwurf: 'neutral',
  geprueft: 'info',
  freigegeben: 'success',
  hochgeladen: 'info',
  aktiv: 'success',
  ermuedet: 'warning',
  gekillt: 'danger',
  pausiert: 'neutral',
  verworfen: 'danger',
}

const FALLBACK: Record<string, string> = {
  entwurf: 'Entwurf',
  geprueft: 'Geprüft',
  freigegeben: 'Freigegeben',
  hochgeladen: 'Hochgeladen (pausiert)',
  aktiv: 'Aktiv',
  ermuedet: 'Ermüdet',
  gekillt: 'Abgeschaltet',
  pausiert: 'Pausiert',
  verworfen: 'Verworfen',
}

export const statusTon = (status: string): BadgeTone => TON[status] ?? 'neutral'

export const statusName = (t: TFunction, status: string): string =>
  t(`crm.werbung.vorrat.status.${status}`, FALLBACK[status] ?? status)

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  return <Badge tone={statusTon(status)} dot>{statusName(t, status)}</Badge>
}
