import type { BadgeTone } from '../../../ui/Badge'
import type { Knoten, Lernphase } from './typen'
import type { Etikett } from './spalten'

// ── Auslieferung (Spalte wie bei Meta) ───────────────────────────────────────
// effective_status + Lernphase -> deutsches Etikett nach Metas Liste
// (Aktiv, Lernphase, Lernphase beeinträchtigt, Wird überprüft, In Bearbeitung,
// Abgelehnt, Aus ...). Unbekannte Werte erscheinen neutral mit dem Rohwert.

export type StatusKategorie = 'aktiv' | 'lernphase' | 'aus' | 'pruefung' | 'probleme' | 'sonst'

export interface Auslieferung {
  label: Etikett
  ton: BadgeTone
  kategorie: StatusKategorie
}

const e = (key: string, d: string): Etikett => ({ k: `crm.werbung.zentrale.status.${key}`, d })

/** Lernphasen-Status von Meta: LEARNING, SUCCESS, FAIL (= beeinträchtigt) */
export const lernStatus = (l: Lernphase | null | undefined): string => (l?.status ?? '').toUpperCase()

const an = (k: Knoten) => (k.status ?? '').toUpperCase() === 'ACTIVE'

export function auslieferungVon(k: Knoten): Auslieferung {
  const eff = (k.effectiveStatus ?? k.status ?? '').toUpperCase()
  const lern = lernStatus(k.lernphase)
  switch (eff) {
    case 'ACTIVE': {
      // Meta meldet nach dem Ende weiter ACTIVE: Ende aus dem Spiegel prüfen
      const endeMs = k.ende ? Date.parse(k.ende) : NaN
      if (Number.isFinite(endeMs) && endeMs <= Date.now()) return { label: e('abgeschlossen', 'Abgeschlossen'), ton: 'neutral', kategorie: 'aus' }
      // Ohne laufende Kinder liefert Meta nichts aus (Kinder = Anzeigen bzw. Anzeigengruppen im Baum)
      if (k.level === 'adset' && k.kinder.length === 0 && k.ausSpiegel) return { label: e('keineAnzeigen', 'Keine Werbeanzeigen'), ton: 'neutral', kategorie: 'aus' }
      if (k.level === 'adset' && k.kinder.length > 0 && !k.kinder.some(an)) return { label: e('anzeigenInaktiv', 'Anzeigen inaktiv'), ton: 'neutral', kategorie: 'aus' }
      const gruppen = k.kinder.filter(x => x.level === 'adset')
      if (k.level === 'campaign' && gruppen.length > 0 && !gruppen.some(an)) return { label: e('gruppenInaktiv', 'Anzeigengruppen inaktiv'), ton: 'neutral', kategorie: 'aus' }
      if (lern === 'LEARNING') return { label: e('lernphase', 'Lernphase'), ton: 'info', kategorie: 'lernphase' }
      if (lern === 'FAIL') return { label: e('lernBeeintraechtigt', 'Lernphase beeinträchtigt'), ton: 'warning', kategorie: 'lernphase' }
      return { label: e('aktiv', 'Aktiv'), ton: 'success', kategorie: 'aktiv' }
    }
    case 'PAUSED': return { label: e('aus', 'Aus'), ton: 'neutral', kategorie: 'aus' }
    case 'CAMPAIGN_PAUSED': return { label: e('kampagneAus', 'Kampagne aus'), ton: 'neutral', kategorie: 'aus' }
    case 'ADSET_PAUSED': return { label: e('gruppeAus', 'Anzeigengruppe aus'), ton: 'neutral', kategorie: 'aus' }
    case 'IN_PROCESS': return { label: e('inBearbeitung', 'In Bearbeitung'), ton: 'warning', kategorie: 'pruefung' }
    case 'PENDING_REVIEW':
    case 'PREAPPROVED': return { label: e('wirdUeberprueft', 'Wird überprüft'), ton: 'warning', kategorie: 'pruefung' }
    case 'DISAPPROVED': return { label: e('abgelehnt', 'Abgelehnt'), ton: 'danger', kategorie: 'probleme' }
    case 'WITH_ISSUES': return { label: e('eingeschraenkt', 'Mit Problemen'), ton: 'danger', kategorie: 'probleme' }
    case 'PENDING_BILLING_INFO': return { label: e('zahlung', 'Zahlungsdaten fehlen'), ton: 'danger', kategorie: 'probleme' }
    case 'ARCHIVED': return { label: e('archiviert', 'Archiviert'), ton: 'neutral', kategorie: 'aus' }
    case 'DELETED': return { label: e('geloescht', 'Gelöscht'), ton: 'neutral', kategorie: 'aus' }
    case '': return { label: e('unbekannt', 'Unbekannt'), ton: 'neutral', kategorie: 'sonst' }
    default: return { label: { k: '', d: eff }, ton: 'neutral', kategorie: 'sonst' }
  }
}

/** Ist der An/Aus-Schalter an? (konfigurierter Status) */
export const istAn = (k: Knoten): boolean => an(k)

/** Probleme/Ablehnungsgründe als kurzer Text (Tooltip). Meta liefert issues_info
 *  als Liste [{error_summary, error_message}] und review_feedback als Objekt. */
export function problemText(probleme: unknown): string {
  const teile: string[] = []
  const nimm = (v: unknown) => {
    if (v == null) return
    if (typeof v === 'string') { if (v.trim()) teile.push(v.trim()); return }
    if (Array.isArray(v)) { v.forEach(nimm); return }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.bereich === 'string' && typeof o.text === 'string' && o.text.trim()) { teile.push(`${o.bereich}: ${o.text.trim()}`); return }
      const text = o.error_summary ?? o.error_message ?? o.message ?? o.summary ?? o.text
      if (typeof text === 'string' && text.trim()) { teile.push(text.trim()); return }
      for (const x of Object.values(o)) {
        if (typeof x === 'string' && x.trim()) teile.push(x.trim())
        else if (x && typeof x === 'object') nimm(x)
      }
    }
  }
  nimm(probleme)
  return [...new Set(teile)].join(' · ').slice(0, 400)
}
