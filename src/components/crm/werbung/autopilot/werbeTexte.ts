import type { TFunction } from 'i18next'
import type { BadgeTone } from '../../../ui/Badge'
import { WERBE_AUTOPILOT_MODI, type WerbeAutopilotModus, type WerbeEvidenz } from '../../../../lib/werbungTypes'

// ── Autopilot und Qualität: Etiketten, Fehlertexte, kleine Helfer ────────────
// Alle Spalten mit festen Werten (Modus, Aktion, Log-Art, Ebene, Freigabe)
// werden als string gelesen. Unbekannte Werte erscheinen roh und neutral grau,
// nie als ein bekannter Zustand (Lehre 26.9., Live-Bundle-Enum-Crash).

/** Zahl aus numeric/bigint (PostgREST liefert teils Strings), null bleibt null */
export const zahl = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Stufe eines Modus (0 = aus ... 4 = autonom), unbekannt = -1 */
export const modusStufe = (m: string | null | undefined): number =>
  WERBE_AUTOPILOT_MODI.indexOf((m ?? '') as WerbeAutopilotModus)

export function modusLabel(t: TFunction, m: string | null | undefined): string {
  switch (m) {
    case 'aus': return t('crm.werbung.autopilot.modus.aus', 'Aus')
    case 'schatten': return t('crm.werbung.autopilot.modus.schatten', 'Schatten')
    case 'vorschlag': return t('crm.werbung.autopilot.modus.vorschlag', 'Vorschlag')
    case 'ein_klick': return t('crm.werbung.autopilot.modus.ein_klick', 'Ein-Klick')
    case 'autonom': return t('crm.werbung.autopilot.modus.autonom', 'Autonom')
    default: return m || '-'
  }
}

export function modusText(t: TFunction, m: string): string {
  switch (m) {
    case 'aus': return t('crm.werbung.autopilot.modusText.aus', 'Rechnet nichts, schlägt nichts vor, ändert nichts bei Meta.')
    case 'schatten': return t('crm.werbung.autopilot.modusText.schatten', 'Rechnet jede Nacht und schreibt ins Schatten-Log, was er tun würde. Ändert nichts bei Meta.')
    case 'vorschlag': return t('crm.werbung.autopilot.modusText.vorschlag', 'Legt Vorschläge an. Ohne Freigabe von Sven oder Giona passiert nichts. Vorschläge gelten bis zum nächsten Lauf.')
    case 'ein_klick': return t('crm.werbung.autopilot.modusText.ein_klick', 'Wie Vorschlag, Vorschläge bleiben 24 Stunden offen. Ein Klick gibt frei und führt aus.')
    case 'autonom': return t('crm.werbung.autopilot.modusText.autonom', 'Regeln auf Stufe 3 führen selbst aus, nur innerhalb der Leitplanken und im Änderungsfenster. Alles andere bleibt Vorschlag.')
    default: return ''
  }
}

/** Aktion (ad_actions.action, ad_autopilot_rules.aktion, Log-Aktion) */
export function aktionLabel(t: TFunction, a: string | null | undefined): string {
  switch (a) {
    case 'pause': return t('crm.werbung.autopilot.aktion.pause', 'Pausieren')
    case 'activate': return t('crm.werbung.autopilot.aktion.activate', 'Aktivieren')
    case 'budget_set': return t('crm.werbung.autopilot.aktion.budget_set', 'Budget ändern')
    case 'ersatz_hochladen': return t('crm.werbung.autopilot.aktion.ersatz_hochladen', 'Ersatz hochladen')
    case 'ersatz_aktivieren': return t('crm.werbung.autopilot.aktion.ersatz_aktivieren', 'Ersatz aktivieren')
    case 'meldung': return t('crm.werbung.autopilot.aktion.meldung', 'Meldung')
    default: return a || '-'
  }
}

/** Ebene eines Objekts (Anzeige, Anzeigengruppe, ...) */
export function ebeneLabel(t: TFunction, e: string | null | undefined): string {
  switch (e) {
    case 'ad': return t('crm.werbung.autopilot.ebene.ad', 'Anzeige')
    case 'adset': return t('crm.werbung.autopilot.ebene.adset', 'Anzeigengruppe')
    case 'campaign': return t('crm.werbung.autopilot.ebene.campaign', 'Kampagne')
    case 'kennung': return t('crm.werbung.autopilot.ebene.kennung', 'Werbemittel')
    case 'account': return t('crm.werbung.autopilot.ebene.account', 'Werbekonto')
    case 'einstellungen': return t('crm.werbung.autopilot.ebene.einstellungen', 'Einstellungen')
    case 'vorrat': return t('crm.werbung.autopilot.ebene.vorrat', 'Vorrat')
    default: return e || '-'
  }
}

/** Freigabestufe einer Regel (0-3) */
export function stufeLabel(t: TFunction, s: number): string {
  switch (s) {
    case 0: return t('crm.werbung.autopilot.stufe.0', 'Aus')
    case 1: return t('crm.werbung.autopilot.stufe.1', 'Vorschlag')
    case 2: return t('crm.werbung.autopilot.stufe.2', 'Ein-Klick')
    case 3: return t('crm.werbung.autopilot.stufe.3', 'Autonom')
    default: return String(s)
  }
}

/** Art eines Log-Eintrags */
export function logArtLabel(t: TFunction, art: string | null | undefined): string {
  switch (art) {
    case 'schatten': return t('crm.werbung.autopilot.logArt.schatten', 'Schatten')
    case 'vorschlag': return t('crm.werbung.autopilot.logArt.vorschlag', 'Vorschlag')
    case 'freigabe': return t('crm.werbung.autopilot.logArt.freigabe', 'Freigabe')
    case 'ablehnung': return t('crm.werbung.autopilot.logArt.ablehnung', 'Ablehnung')
    case 'ausfuehrung': return t('crm.werbung.autopilot.logArt.ausfuehrung', 'Ausführung')
    case 'ruecklesen': return t('crm.werbung.autopilot.logArt.ruecklesen', 'Rücklesen')
    case 'stopp': return t('crm.werbung.autopilot.logArt.stopp', 'Stopp')
    case 'einstellung': return t('crm.werbung.autopilot.logArt.einstellung', 'Einstellung')
    case 'regel_aenderung': return t('crm.werbung.autopilot.logArt.regel_aenderung', 'Regeländerung')
    case 'kalibrierung': return t('crm.werbung.autopilot.logArt.kalibrierung', 'Kalibrierung')
    case 'vorrat': return t('crm.werbung.autopilot.logArt.vorrat', 'Vorrat')
    case 'manuell_erkannt': return t('crm.werbung.autopilot.logArt.manuell_erkannt', 'Handänderung erkannt')
    case 'bewertung': return t('crm.werbung.autopilot.logArt.bewertung', 'Bewertung')
    case 'fehler': return t('crm.werbung.autopilot.logArt.fehler', 'Fehler')
    case 'replay': return t('crm.werbung.autopilot.logArt.replay', 'Rückblick')
    default: return art || '-'
  }
}

export function logArtTon(art: string | null | undefined, ergebnis: string | null | undefined): BadgeTone {
  if (art === 'fehler' || art === 'stopp') return 'danger'
  if (art === 'ausfuehrung') return ergebnis === 'ok' ? 'success' : 'warning'
  if (art === 'freigabe') return 'info'
  if (art === 'ablehnung' || art === 'manuell_erkannt') return 'warning'
  return 'neutral'
}

/** Lebenslauf eines Vorschlags (ad_actions.freigabe) */
export function freigabeLabel(t: TFunction, f: string | null | undefined): string {
  switch (f) {
    case 'vorgeschlagen': return t('crm.werbung.autopilot.freigabe.vorgeschlagen', 'Offen')
    case 'freigegeben': return t('crm.werbung.autopilot.freigabe.freigegeben', 'Freigegeben')
    case 'autonom': return t('crm.werbung.autopilot.freigabe.autonom', 'Autonom')
    case 'verworfen': return t('crm.werbung.autopilot.freigabe.verworfen', 'Abgelehnt')
    case 'abgelaufen': return t('crm.werbung.autopilot.freigabe.abgelaufen', 'Abgelaufen')
    case 'veraltet': return t('crm.werbung.autopilot.freigabe.veraltet', 'Veraltet')
    default: return f || '-'
  }
}

export function freigabeTon(f: string | null | undefined): BadgeTone {
  if (f === 'vorgeschlagen') return 'info'
  if (f === 'freigegeben' || f === 'autonom') return 'success'
  if (f === 'verworfen' || f === 'abgelaufen' || f === 'veraltet') return 'warning'
  return 'neutral'
}

/** Status einer Aktion (ad_actions.status) */
export function statusLabel(t: TFunction, s: string | null | undefined): string {
  switch (s) {
    case null: case undefined: return t('crm.werbung.autopilot.status.vorschlag', 'Vorschlag')
    case 'bestätigt': return t('crm.werbung.autopilot.status.bestaetigt', 'Wartet auf Ausführung')
    case 'ausgeführt': return t('crm.werbung.autopilot.status.ausgefuehrt', 'Ausgeführt')
    case 'fehlgeschlagen': return t('crm.werbung.autopilot.status.fehlgeschlagen', 'Fehlgeschlagen')
    case 'abgelehnt': return t('crm.werbung.autopilot.status.abgelehnt', 'Storniert')
    default: return s
  }
}

/** Wer etwas getan hat (ad_autopilot_log.akteur_art) */
export function akteurLabel(t: TFunction, a: string | null | undefined): string {
  if (a === 'system') return t('crm.werbung.autopilot.akteur.system', 'System')
  if (a === 'mensch') return t('crm.werbung.autopilot.akteur.mensch', 'Mensch')
  return a || '-'
}

// ── Fehler aus Datenbank und RPCs ───────────────────────────────────────────
// Die Schutz-Trigger antworten mit eigenen deutschen Texten und Codes:
// 42501 = fehlendes Recht (Hochstellen nur Admin), 55000 = Autopilot gestoppt,
// 23514 = unzulässiger Statuswechsel, 22023 = ungültige Eingabe.
// PGRST2xx/42P01/42883/42703 = Tabelle, Funktion oder Spalte fehlt (Migration noch nicht eingespielt).

export interface DbFehler { code?: string; message?: string; details?: string | null; hint?: string | null }

export const istDbFehler = (e: unknown): e is DbFehler =>
  typeof e === 'object' && e !== null && ('code' in e || 'message' in e)

/** Tabelle oder Funktion gibt es (noch) nicht */
export function fehltSchema(e: unknown): boolean {
  if (!istDbFehler(e)) return false
  return ['PGRST205', 'PGRST202', 'PGRST200', 'PGRST204', '42P01', '42883', '42703'].includes(e.code ?? '')
}

export function dbFehlerText(t: TFunction, e: unknown): string {
  const code = istDbFehler(e) ? e.code ?? '' : ''
  const msg = istDbFehler(e) ? (e.message ?? '') : e instanceof Error ? e.message : String(e ?? '')
  if (code === '42501') {
    return t('crm.werbung.autopilot.fehler.recht', 'Dafür fehlt dir das Recht. Hochstellen und Einschalten darf nur ein Admin.')
      + (msg ? ` (${msg})` : '')
  }
  if (code === '55000') return msg || t('crm.werbung.autopilot.fehler.gestoppt', 'Der Autopilot ist gestoppt, Freigaben sind gesperrt.')
  if (fehltSchema(e)) return t('crm.werbung.autopilot.fehler.schema', 'Diese Funktion ist noch nicht freigeschaltet (Datenbank-Erweiterung fehlt).')
  return msg || t('crm.werbung.autopilot.fehler.allgemein', 'Das hat nicht geklappt.')
}

// ── Begründung eines Vorschlags kurz zusammengefasst ────────────────────────
export interface EvidenzWerte {
  fenster: number | null
  spend: number | null
  te: number | null
  cpte: number | null
  pBad: number | null
  pGood: number | null
  freq: number | null
  coverage: number | null
  fx: number | null
}

export function evidenzWerte(ev: WerbeEvidenz | null | undefined): EvidenzWerte {
  const e = ev ?? {}
  const spend = zahl(e.spend_eur)
  const te = zahl(e.te)
  const alpha = zahl(e.alpha)
  const beta = zahl(e.beta)
  const cpte = alpha && beta && alpha > 0 ? beta / alpha : spend != null && te ? spend / te : null
  return {
    fenster: zahl(e.fenster),
    spend,
    te,
    cpte,
    pBad: zahl(e.p_bad),
    pGood: zahl(e.p_good),
    freq: zahl(e.frequency_7d),
    coverage: zahl(e.coverage),
    fx: zahl(e.fx),
  }
}

/** Datum + Uhrzeit kurz in der UI-Sprache */
export const zeitKurz = (iso: string | null | undefined, locale: string): string => {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export const datumKurz = (iso: string | null | undefined, locale: string): string => {
  if (!iso) return '-'
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Dollar-Betrag aus USD-Cent */
export const usdAusCents = (cents: number, locale: string): string =>
  (cents / 100).toLocaleString(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

/** Ersatzkurs USD je EUR, wenn der Vorschlag keinen mitbringt */
export const USD_JE_EUR_ERSATZ = 1.14
