import type {
  Kommentar, KommentarAnzeigeRef, KommentarAntwortenResponse, KommentarAusblendenResponse, KommentareListResponse,
  KommentarPlattform,
} from '../../../../lib/werbeKonto'
import { kontoCall } from '../messung/messungApi'

// ── Kommentare unter Anzeigen (meta-konto) ───────────────────────────────────
// Lesen: kommentare_list (alle Plattformen, ab einem Zeitpunkt; gefiltert wird
// im Browser, damit ein Filterwechsel keinen neuen Meta-Abruf kostet).
// Schreiben: kommentar_antworten (nur nach Klick und Bestätigung, confirm: true)
// und kommentar_ausblenden. Nie löschen. Typen aus src/lib/werbeKonto.ts.

export type Zeitraum = 7 | 30 | 90

export function ladeKommentare(tage: Zeitraum, maxBeitraege?: number): Promise<KommentareListResponse> {
  const since = new Date(Date.now() - tage * 86_400_000).toISOString()
  return kontoCall('kommentare_list', { since, ...(maxBeitraege ? { max_beitraege: maxBeitraege } : {}) })
}

export function antworten(k: Kommentar, text: string): Promise<KommentarAntwortenResponse> {
  return kontoCall('kommentar_antworten', { comment_id: k.id, plattform: k.plattform, text, confirm: true, beitrag_id: k.beitrag_id })
}

export function ausblenden(k: Kommentar, hide: boolean): Promise<KommentarAusblendenResponse> {
  return kontoCall('kommentar_ausblenden', { comment_id: k.id, plattform: k.plattform, hide, beitrag_id: k.beitrag_id })
}

// ── Gruppen je Beitrag (eine oder mehrere Anzeigen mit demselben Beitrag) ────

export interface BeitragGruppe {
  beitragId: string
  plattform: KommentarPlattform
  link: string | null
  anzeigen: KommentarAnzeigeRef[]
  kommentare: Kommentar[]
  /** unbeantwortet und nicht ausgeblendet */
  offen: number
  neuester: string | null
  gekuerzt: boolean
  fehler: string | null
}

export const istOffen = (k: Kommentar): boolean => !k.beantwortet && !k.ausgeblendet

export interface KommentarFilter {
  nurOffen: boolean
  plattform: 'alle' | KommentarPlattform
  suche: string
  mitAusgeblendeten: boolean
}

export function filtere(liste: Kommentar[], f: KommentarFilter): Kommentar[] {
  const q = f.suche.trim().toLowerCase()
  return liste.filter(k => (!f.nurOffen || istOffen(k))
    && (f.mitAusgeblendeten || !k.ausgeblendet)
    && (f.plattform === 'alle' || k.plattform === f.plattform)
    && (!q || k.text.toLowerCase().includes(q) || (k.autor ?? '').toLowerCase().includes(q)
      || k.ad_name.toLowerCase().includes(q) || k.weitere_anzeigen.some(a => a.name.toLowerCase().includes(q))))
}

/** Kommentare nach Beitrag gruppieren; Gruppen mit offenen Kommentaren zuerst, dann die neuesten. */
export function gruppiere(liste: Kommentar[], antwort: KommentareListResponse | null): BeitragGruppe[] {
  const map = new Map<string, BeitragGruppe>()
  for (const k of liste) {
    const key = `${k.plattform}:${k.beitrag_id}`
    let g = map.get(key)
    if (!g) {
      const meta = antwort?.beitraege.find(b => b.beitrag_id === k.beitrag_id && b.plattform === k.plattform)
      const anzeigen: KommentarAnzeigeRef[] = meta?.anzeigen.length ? meta.anzeigen : [{ id: k.ad_id, name: k.ad_name, status: null }, ...k.weitere_anzeigen]
      g = {
        beitragId: k.beitrag_id, plattform: k.plattform, link: meta?.link ?? k.beitrag_link, anzeigen, kommentare: [],
        offen: 0, neuester: null, gekuerzt: meta?.gekuerzt ?? false, fehler: meta?.fehler ?? null,
      }
      map.set(key, g)
    }
    g.kommentare.push(k)
    if (istOffen(k)) g.offen++
    if (k.zeit && (!g.neuester || k.zeit > g.neuester)) g.neuester = k.zeit
  }
  const gruppen = [...map.values()]
  for (const g of gruppen) g.kommentare.sort((a, b) => (b.zeit ?? '').localeCompare(a.zeit ?? ''))
  return gruppen.sort((a, b) => (b.offen > 0 ? 1 : 0) - (a.offen > 0 ? 1 : 0) || (b.neuester ?? '').localeCompare(a.neuester ?? ''))
}
