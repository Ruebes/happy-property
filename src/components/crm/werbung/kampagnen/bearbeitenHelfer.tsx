import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Badge from '../../../ui/Badge'
import type { Level } from '../../../../lib/metaSpec'
import type { WerbeFormat } from '../format'
import { ladeBuilderEinstellungen } from './builderApi'
import { istGeldFeld } from './bearbeitenTypen'

// ── Gemeinsame Bausteine für Bearbeiten, Duplizieren und Massenbearbeitung ───
// Schreib-Freischaltung (ad_settings.builder_enabled), Ebenen-Namen,
// lesbare Vorher/Nachher-Werte und das Lernphasen-Etikett.

/** Schreibsperre für Meta (Freischaltung durch Sven). Lädt ad_settings beim Öffnen, eine kleine Abfrage. */
export function useSchreibSperre(offen: boolean): { geladen: boolean; sperre: string | null } {
  const { t } = useTranslation()
  const [stand, setStand] = useState<{ geladen: boolean; aus: boolean }>({ geladen: false, aus: false })
  useEffect(() => {
    if (!offen) return
    let abbruch = false
    void ladeBuilderEinstellungen().then(s => {
      // null = Spalte fehlt oder nicht lesbar: der Server entscheidet
      if (!abbruch) setStand({ geladen: true, aus: s ? s.builder_enabled === false : false })
    })
    return () => { abbruch = true }
  }, [offen])
  return {
    geladen: stand.geladen,
    sperre: stand.aus ? t('crm.werbung.bearbeiten.gesperrt', 'Schreiben bei Meta ist noch nicht freigeschaltet (Freischaltung durch Sven ausstehend).') : null,
  }
}

export function ebeneName(t: TFunction, level: Level, mehrzahl = false): string {
  if (level === 'campaign') return mehrzahl ? t('crm.werbung.bearbeiten.ebene.kampagnen', 'Kampagnen') : t('crm.werbung.meta.level.campaign', 'Kampagne')
  if (level === 'adset') return mehrzahl ? t('crm.werbung.bearbeiten.ebene.gruppen', 'Anzeigengruppen') : t('crm.werbung.meta.level.adset', 'Anzeigengruppe')
  return mehrzahl ? t('crm.werbung.bearbeiten.ebene.anzeigen', 'Werbeanzeigen') : t('crm.werbung.meta.level.ad', 'Werbeanzeige')
}

const STATUS_TEXT: Record<string, [string, string]> = {
  ACTIVE: ['crm.werbung.bearbeiten.status.ACTIVE', 'Aktiv'],
  PAUSED: ['crm.werbung.bearbeiten.status.PAUSED', 'Pausiert'],
  ARCHIVED: ['crm.werbung.bearbeiten.status.ARCHIVED', 'Archiviert'],
  DELETED: ['crm.werbung.bearbeiten.status.DELETED', 'Gelöscht'],
}

export function statusText(t: TFunction, s: string | null | undefined): string {
  if (!s) return '-'
  const k = STATUS_TEXT[s.toUpperCase()]
  return k ? t(k[0], k[1]) : s
}

/** USD-Cent als „$ 40,00 (≈ 35 €)" */
export function geldText(fmt: WerbeFormat, cents: number, kurs: number): string {
  const usd = cents / 100
  const usdTxt = usd.toLocaleString(fmt.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `$ ${usdTxt} (≈ ${fmt.eur(usd / (kurs > 0 ? kurs : 1.14))})`
}

/** Ein Vorher- oder Nachher-Wert aus edit_diff / bulk lesbar (Geld in $ mit EUR, Zeit lokal, Listen mit Komma). */
export function wertText(t: TFunction, fmt: WerbeFormat, kurs: number, field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return t('crm.werbung.bearbeiten.wert.leer', 'nicht gesetzt')
  if (typeof v === 'boolean') return v ? t('crm.werbung.bearbeiten.wert.an', 'an') : t('crm.werbung.bearbeiten.wert.aus', 'aus')
  if (typeof v === 'number') {
    if (istGeldFeld(field)) return geldText(fmt, v, kurs)
    return v.toLocaleString(fmt.locale)
  }
  if (typeof v === 'string') {
    if (/status$/.test(field)) return statusText(t, v)
    if (/(_time|^time_)/.test(field) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) return d.toLocaleString(fmt.locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    }
    if (istGeldFeld(field) && /^\d+$/.test(v)) return geldText(fmt, Number(v), kurs)
    return v.length > 160 ? `${v.slice(0, 157)}...` : v
  }
  if (Array.isArray(v)) {
    if (!v.length) return t('crm.werbung.bearbeiten.wert.leer', 'nicht gesetzt')
    const teile = v.map(x => (typeof x === 'string' || typeof x === 'number' ? String(x) : kurzJson(x)))
    const txt = teile.join(', ')
    return txt.length > 160 ? `${txt.slice(0, 157)}...` : txt
  }
  return kurzJson(v)
}

function kurzJson(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s.length > 160 ? `${s.slice(0, 157)}...` : s
  } catch {
    return String(v)
  }
}

export function LernphaseBadge({ text }: { text?: string }) {
  const { t } = useTranslation()
  return <Badge tone="warning" dot>{text ?? t('crm.werbung.bearbeiten.lernphase', 'Lernphase startet neu')}</Badge>
}

export function EmpfohlenBadge() {
  const { t } = useTranslation()
  return <Badge tone="success">{t('crm.werbung.bearbeiten.empfohlen', 'Empfohlen für Happy Property')}</Badge>
}
