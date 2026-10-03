import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { BadgeTone } from '../../../ui/Badge'
import type { CatalogResponse } from '../../../../lib/metaSpec'
import { ZIELGRUPPEN_ART_LABEL, type ZielgruppenArt } from '../../../../lib/werbeWerkzeuge'
import { useWerbeRechte, type WerbeRechte } from '../autopilot/useWerbeRechte'
import { ladeKatalog } from '../kampagnen/builderApi'
import { ladeWerkzeugEinstellungen, type WerkzeugEinstellungen, type ZielgruppeZeile } from './werkzeugeApi'

// ── Rechte + Freischaltung für Zielgruppen und Sofortformulare ───────────────
// Schreiben (anlegen, kopieren) geht nur mit Recht Werbemanager und wenn Sven
// das Anlegen bei Meta freigeschaltet hat (ad_settings.builder_enabled). Der
// Server prüft beides selbst; hier steht nur, warum ein Knopf grau ist. Die
// Prüfung durch den Server (vorschau: true) braucht nur das Recht, nicht die
// Freischaltung: „Prüfen“ geht also auch, solange Anlegen noch gesperrt ist.

export interface WerkzeugStatus {
  rechte: WerbeRechte
  einstellungen: WerkzeugEinstellungen | null
  setEinstellungen: (e: WerkzeugEinstellungen) => void
  /** Grund, warum Schreiben gesperrt ist, sonst null */
  schreibSperre: string | null
  /** Grund, warum auch die Prüfung durch den Server (vorschau) nicht geht (fehlendes Recht), sonst null */
  pruefSperre: string | null
  neuLaden: () => Promise<void>
}

const keinRechtText = (t: TFunction): string => t('crm.werbung.zielgruppen.sperre.keinRecht', 'Dafür fehlt dir das Recht Werbemanager. Ansehen geht, Anlegen nicht.')

export function schreibSperreText(t: TFunction, rechte: WerbeRechte, e: WerkzeugEinstellungen | null): string | null {
  if (!rechte.darfEntscheiden) return keinRechtText(t)
  if (e?.builderEnabled === false) return t('crm.werbung.zielgruppen.sperre.builder', 'Anlegen bei Meta ist noch gesperrt: Freischaltung durch Sven ausstehend. Entwürfe und Vorschau gehen schon.')
  return null
}

export function useWerkzeugStatus(): WerkzeugStatus {
  const { t } = useTranslation()
  const rechte = useWerbeRechte()
  const [einstellungen, setEinstellungen] = useState<WerkzeugEinstellungen | null>(null)
  const neuLaden = useCallback(async () => { setEinstellungen(await ladeWerkzeugEinstellungen(true)) }, [])
  useEffect(() => {
    let aktiv = true
    void ladeWerkzeugEinstellungen().then(e => { if (aktiv) setEinstellungen(e) })
    return () => { aktiv = false }
  }, [])
  return {
    rechte, einstellungen, setEinstellungen, neuLaden,
    schreibSperre: schreibSperreText(t, rechte, einstellungen),
    pruefSperre: rechte.darfEntscheiden ? null : keinRechtText(t),
  }
}

// ── Etiketten der Zielgruppen ────────────────────────────────────────────────

/** Art einer Zielgruppe (Website, Interaktion, Video, Kundenliste, Lookalike, Sonstige) */
export function artLabel(t: TFunction, art: ZielgruppenArt): string {
  return t(`crm.werbung.zielgruppen.art.${art}`, ZIELGRUPPEN_ART_LABEL[art] ?? art)
}

/** Filter der Liste: alle oder eine Art */
export type ArtFilter = 'alle' | ZielgruppenArt

/** Größe wie Meta: Spanne, „unter 1.000" oder „-" */
export function groesseText(t: TFunction, locale: string, z: Pick<ZielgruppeZeile, 'groesseMin' | 'groesseMax'>): string {
  const lo = z.groesseMin
  const hi = z.groesseMax
  const f = (n: number) => n.toLocaleString(locale)
  const klein = t('crm.werbung.zielgruppen.groesse.klein', 'unter 1.000')
  if (lo == null) return hi == null ? '-' : hi < 1000 ? klein : f(hi)
  if (lo < 1000) return hi != null && hi >= 1000 ? t('crm.werbung.zielgruppen.groesse.bis', 'bis {{hi}}', { hi: f(hi) }) : klein
  if (hi != null && hi > lo) return t('crm.werbung.zielgruppen.groesse.spanne', '{{lo}} bis {{hi}}', { lo: f(lo), hi: f(hi) })
  return f(lo)
}

/** Wohnen-Etikett einer Zielgruppe */
export function wohnenEtikett(t: TFunction, z: Pick<ZielgruppeZeile, 'art' | 'wohnenTauglich' | 'gesperrtFuerWohnen'>): { ton: BadgeTone; text: string } {
  if (z.art === 'lookalike') return { ton: 'danger', text: t('crm.werbung.zielgruppen.wohnen.lookalike', 'Unter Wohnen gesperrt') }
  if (z.wohnenTauglich === true) return { ton: 'success', text: t('crm.werbung.zielgruppen.wohnen.ja', 'Für Wohnen geeignet') }
  if (z.wohnenTauglich === false || z.gesperrtFuerWohnen) return { ton: 'danger', text: t('crm.werbung.zielgruppen.wohnen.nein', 'Nicht für Wohnen') }
  return { ton: 'neutral', text: t('crm.werbung.zielgruppen.wohnen.unbekannt', 'Noch nicht geprüft') }
}

// ── Katalog des Assistenten (Pixel, Seiten, Instagram-Konten, Formulare) ─────
// Wird nur geladen, wenn ein Assistent offen ist (rund 8 Meta-Abfragen auf dem
// Server, danach für die Sitzung im Speicher). Fehler: Felder bleiben mit den
// Vorgaben aus ad_settings bedienbar.
export function useKatalog(aktiv: boolean): { katalog: CatalogResponse | null; laedt: boolean } {
  const [katalog, setKatalog] = useState<CatalogResponse | null>(null)
  const [laedt, setLaedt] = useState(false)
  useEffect(() => {
    if (!aktiv || katalog) return
    let lebt = true
    setLaedt(true)
    ladeKatalog()
      .then(k => { if (lebt) setKatalog(k) })
      .catch(err => console.warn('[Zielgruppen] Katalog nicht erreichbar:', err))
      .finally(() => { if (lebt) setLaedt(false) })
    return () => { lebt = false }
  }, [aktiv, katalog])
  return { katalog, laedt }
}
