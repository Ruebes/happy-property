import type { TFunction } from 'i18next'
import type { BadgeTone } from '../../../ui/Badge'
import {
  REGEL_FELDER, REGEL_VERLAUF_AKTION_LABEL,
  type GewinnerEinstufung, type RegelAktion, type RegelBedingung, type RegelBudgetAenderung, type RegelEinheit,
  type RegelFilter, type RegelZeitplan, type RegelZeitraum, type SteuerungEbene, type TestKennzahl, type TestStatus, type TestTyp,
} from '../../../../lib/werbeSteuerung'

// ── Beschriftungen für Tests & Regeln (deutsche Meta-Begriffe) ───────────────
// Jede Beschriftung als eigener t()-Aufruf mit festem Schlüssel und deutschem
// Text (gleich den Konstanten in werbeSteuerung.ts), damit die Übersetzungs-
// Fragmente sie finden. Unbekannte Werte erscheinen mit Metas Label oder roh.

export function typLabel(t: TFunction, typ: TestTyp | string | null): string {
  const m: Record<string, string> = {
    anzeigengestaltung: t('crm.werbung.tests.typ.anzeigengestaltung', 'Anzeigengestaltung'),
    zielgruppe: t('crm.werbung.tests.typ.zielgruppe', 'Zielgruppe'),
    platzierung: t('crm.werbung.tests.typ.platzierung', 'Platzierungen'),
    frei: t('crm.werbung.tests.typ.frei', 'Selbstdefiniert'),
  }
  return typ ? m[typ] ?? typ : t('crm.werbung.tests.typ.unbekannt', 'Aus Meta')
}

export function typErklaerung(t: TFunction, typ: TestTyp): string {
  const m: Record<TestTyp, string> = {
    anzeigengestaltung: t('crm.werbung.tests.typText.anzeigengestaltung', 'Welches Bild, Video oder welcher Text bringt günstiger Leads? 2 bis 5 Werbeanzeigen treten gegeneinander an.'),
    zielgruppe: t('crm.werbung.tests.typText.zielgruppe', 'Gleiche Anzeigen, verschiedene Zielgruppen (je Variante eine Anzeigengruppe), z. B. eigene Zielgruppe gegen breites Targeting.'),
    platzierung: t('crm.werbung.tests.typText.platzierung', 'Gleiche Anzeigen, verschiedene Platzierungen (je Variante eine Anzeigengruppe), z. B. nur Reels gegen alle Platzierungen.'),
    frei: t('crm.werbung.tests.typText.frei', 'Beliebiger Unterschied zwischen Kampagnen oder Anzeigengruppen. Für ein klares Ergebnis nur eine Sache ändern.'),
  }
  return m[typ]
}

export function kennzahlLabel(t: TFunction, k: TestKennzahl | string | null): string {
  const m: Record<string, string> = {
    kosten_pro_lead: t('crm.werbung.tests.kennzahl.kosten_pro_lead', 'Kosten pro Lead'),
    kosten_pro_termin: t('crm.werbung.tests.kennzahl.kosten_pro_termin', 'Kosten pro Termin'),
    kosten_pro_link_klick: t('crm.werbung.tests.kennzahl.kosten_pro_link_klick', 'Kosten pro Link-Klick'),
    ctr: t('crm.werbung.tests.kennzahl.ctr', 'Link-Klickrate (CTR)'),
    cpm: t('crm.werbung.tests.kennzahl.cpm', 'Kosten pro 1.000 Impressionen (CPM)'),
  }
  return k ? m[k] ?? k : '-'
}

export function kennzahlErklaerung(t: TFunction, k: TestKennzahl): string {
  const m: Record<TestKennzahl, string> = {
    kosten_pro_lead: t('crm.werbung.tests.kennzahlText.kosten_pro_lead', 'Was ein Lead in jeder Variante kostet. Liefert bei uns am schnellsten ein belastbares Ergebnis.'),
    kosten_pro_termin: t('crm.werbung.tests.kennzahlText.kosten_pro_termin', 'Was ein bei Meta gemeldeter Termin kostet. Am nächsten am Ziel, braucht aber viel Laufzeit.'),
    kosten_pro_link_klick: t('crm.werbung.tests.kennzahlText.kosten_pro_link_klick', 'Was ein Klick auf den Link kostet. Gut für frühe Hinweise, sagt wenig über Lead-Qualität.'),
    ctr: t('crm.werbung.tests.kennzahlText.ctr', 'Wie viele Menschen nach dem Sehen klicken. Zeigt, welches Werbemittel mehr Aufmerksamkeit holt.'),
    cpm: t('crm.werbung.tests.kennzahlText.cpm', 'Was 1.000 Einblendungen kosten. Nur für Platzierungs-Tests interessant.'),
  }
  return m[k]
}

export function testStatusEtikett(t: TFunction, s: TestStatus | string): { ton: BadgeTone; text: string } {
  switch (s) {
    case 'laeuft': return { ton: 'success', text: t('crm.werbung.tests.status.laeuft', 'Läuft') }
    case 'geplant': return { ton: 'info', text: t('crm.werbung.tests.status.geplant', 'Geplant') }
    case 'beendet': return { ton: 'neutral', text: t('crm.werbung.tests.status.beendet', 'Beendet') }
    case 'abgebrochen': return { ton: 'warning', text: t('crm.werbung.tests.status.abgebrochen', 'Abgebrochen') }
    default: return { ton: 'neutral', text: s }
  }
}

export function einstufungEtikett(t: TFunction, e: GewinnerEinstufung): { ton: BadgeTone; text: string } {
  switch (e) {
    case 'klar': return { ton: 'success', text: t('crm.werbung.tests.einstufung.klar', 'Klarer Gewinner') }
    case 'tendenz': return { ton: 'info', text: t('crm.werbung.tests.einstufung.tendenz', 'Tendenz') }
    case 'offen': return { ton: 'warning', text: t('crm.werbung.tests.einstufung.offen', 'Noch offen') }
    default: return { ton: 'neutral', text: t('crm.werbung.tests.einstufung.zu_wenig_daten', 'Zu wenig Daten') }
  }
}

export function ebeneLabel(t: TFunction, e: SteuerungEbene | string | null, mehrzahl = true): string {
  const m: Record<string, string> = mehrzahl
    ? {
      campaign: t('crm.werbung.regeln.ebene.campaign', 'Kampagnen'),
      adset: t('crm.werbung.regeln.ebene.adset', 'Anzeigengruppen'),
      ad: t('crm.werbung.regeln.ebene.ad', 'Werbeanzeigen'),
    }
    : {
      campaign: t('crm.werbung.regeln.ebeneEinzahl.campaign', 'Kampagne'),
      adset: t('crm.werbung.regeln.ebeneEinzahl.adset', 'Anzeigengruppe'),
      ad: t('crm.werbung.regeln.ebeneEinzahl.ad', 'Werbeanzeige'),
    }
  return e ? m[e] ?? e : '-'
}

/** Feld-Info aus werbeSteuerung (Einheit, Ebenen, Kosten-Feld) */
export const feldInfo = (f: string) => REGEL_FELDER.find(x => x.feld === f) ?? null
export const feldEinheit = (f: string): RegelEinheit => feldInfo(f)?.einheit ?? 'anzahl'

export function feldLabel(t: TFunction, f: string): string {
  const m: Record<string, string> = {
    spent: t('crm.werbung.regeln.feld.spent', 'Ausgaben'),
    results: t('crm.werbung.regeln.feld.results', 'Ergebnisse'),
    frequency: t('crm.werbung.regeln.feld.frequency', 'Frequenz'),
    leadgen: t('crm.werbung.regeln.feld.leadgen', 'Leads (Sofortformular)'),
    'offsite_conversion.fb_pixel_lead': t('crm.werbung.regeln.feld.pixel_lead', 'Leads (Website)'),
    cost_per_lead_fb: t('crm.werbung.regeln.feld.cost_per_lead_fb', 'Kosten pro Website-Lead'),
    impressions: t('crm.werbung.regeln.feld.impressions', 'Impressionen'),
    reach: t('crm.werbung.regeln.feld.reach', 'Reichweite'),
    link_click: t('crm.werbung.regeln.feld.link_click', 'Link-Klicks'),
    link_ctr: t('crm.werbung.regeln.feld.link_ctr', 'Link-Klickrate (CTR)'),
    ctr: t('crm.werbung.regeln.feld.ctr', 'CTR (alle Klicks)'),
    cost_per_link_click: t('crm.werbung.regeln.feld.cost_per_link_click', 'Kosten pro Link-Klick'),
    cpc: t('crm.werbung.regeln.feld.cpc', 'CPC (alle Klicks)'),
    cpm: t('crm.werbung.regeln.feld.cpm', 'CPM'),
    daily_budget: t('crm.werbung.regeln.feld.daily_budget', 'Tagesbudget'),
    hours_since_creation: t('crm.werbung.regeln.feld.hours_since_creation', 'Stunden seit Erstellung'),
  }
  return m[f] ?? feldInfo(f)?.label ?? f
}

/** Ein Satz Erklärung je Feld (einfaches Deutsch) */
export function feldErklaerung(t: TFunction, f: string): string {
  const m: Record<string, string> = {
    spent: t('crm.werbung.regeln.feldText.spent', 'Was im Zeitraum ausgegeben wurde.'),
    results: t('crm.werbung.regeln.feldText.results', 'Ergebnisse nach dem Leistungsziel der Anzeigengruppe, bei uns meist Leads.'),
    frequency: t('crm.werbung.regeln.feldText.frequency', 'Wie oft eine Person die Anzeige im Schnitt gesehen hat. Über 3 wird es oft lästig.'),
    leadgen: t('crm.werbung.regeln.feldText.leadgen', 'Leads aus Metas Sofortformularen.'),
    'offsite_conversion.fb_pixel_lead': t('crm.werbung.regeln.feldText.pixel_lead', 'Leads, die der Pixel auf der Website gemeldet hat.'),
    cost_per_lead_fb: t('crm.werbung.regeln.feldText.cost_per_lead_fb', 'Ausgaben geteilt durch Website-Leads.'),
    impressions: t('crm.werbung.regeln.feldText.impressions', 'Wie oft die Anzeige eingeblendet wurde.'),
    reach: t('crm.werbung.regeln.feldText.reach', 'Wie viele verschiedene Menschen die Anzeige gesehen haben.'),
    link_click: t('crm.werbung.regeln.feldText.link_click', 'Klicks auf den Link zur Website oder zum Formular.'),
    link_ctr: t('crm.werbung.regeln.feldText.link_ctr', 'Anteil der Einblendungen mit Link-Klick, in Prozent.'),
    ctr: t('crm.werbung.regeln.feldText.ctr', 'Anteil der Einblendungen mit irgendeinem Klick, in Prozent.'),
    cost_per_link_click: t('crm.werbung.regeln.feldText.cost_per_link_click', 'Ausgaben geteilt durch Link-Klicks.'),
    cpc: t('crm.werbung.regeln.feldText.cpc', 'Ausgaben geteilt durch alle Klicks.'),
    cpm: t('crm.werbung.regeln.feldText.cpm', 'Kosten für 1.000 Einblendungen.'),
    daily_budget: t('crm.werbung.regeln.feldText.daily_budget', 'Aktuelles Tagesbudget der Anzeigengruppe.'),
    hours_since_creation: t('crm.werbung.regeln.feldText.hours_since_creation', 'Schützt junge Objekte in der Lernphase, z. B. erst ab 72 Stunden.'),
  }
  return m[f] ?? feldInfo(f)?.erklaerung ?? ''
}

export function operatorLabel(t: TFunction, op: string): string {
  const m: Record<string, string> = {
    groesser: t('crm.werbung.regeln.operator.groesser', 'größer als'),
    kleiner: t('crm.werbung.regeln.operator.kleiner', 'kleiner als'),
    zwischen: t('crm.werbung.regeln.operator.zwischen', 'zwischen'),
    nicht_zwischen: t('crm.werbung.regeln.operator.nicht_zwischen', 'nicht zwischen'),
  }
  return m[op] ?? op
}

export function zeitraumLabel(t: TFunction, z: RegelZeitraum | string | null): string {
  const m: Record<string, string> = {
    TODAY: t('crm.werbung.regeln.zeitraum.TODAY', 'Heute'),
    YESTERDAY: t('crm.werbung.regeln.zeitraum.YESTERDAY', 'Gestern'),
    LAST_2_DAYS: t('crm.werbung.regeln.zeitraum.LAST_2_DAYS', 'Letzte 2 Tage (mit heute)'),
    LAST_3_DAYS: t('crm.werbung.regeln.zeitraum.LAST_3_DAYS', 'Letzte 3 Tage (mit heute)'),
    LAST_7_DAYS: t('crm.werbung.regeln.zeitraum.LAST_7_DAYS', 'Letzte 7 Tage (mit heute)'),
    LAST_14_DAYS: t('crm.werbung.regeln.zeitraum.LAST_14_DAYS', 'Letzte 14 Tage (mit heute)'),
    LAST_30_DAYS: t('crm.werbung.regeln.zeitraum.LAST_30_DAYS', 'Letzte 30 Tage (mit heute)'),
    LIFETIME: t('crm.werbung.regeln.zeitraum.LIFETIME', 'Gesamte Laufzeit'),
  }
  return z ? m[z] ?? z : '-'
}

export function aktionLabel(t: TFunction, a: RegelAktion | string | null, ebene: SteuerungEbene | null = null): string {
  const objekte = ebeneLabel(t, ebene)
  const m: Record<string, string> = {
    pause: ebene ? t('crm.werbung.regeln.aktion.pauseObjekte', '{{objekte}} deaktivieren', { objekte }) : t('crm.werbung.regeln.aktion.pause', 'Deaktivieren'),
    unpause: ebene ? t('crm.werbung.regeln.aktion.unpauseObjekte', '{{objekte}} aktivieren', { objekte }) : t('crm.werbung.regeln.aktion.unpause', 'Aktivieren'),
    budget_aendern: t('crm.werbung.regeln.aktion.budget_aendern', 'Budget anpassen'),
    nur_benachrichtigen: t('crm.werbung.regeln.aktion.nur_benachrichtigen', 'Nur Benachrichtigung senden'),
  }
  return a ? m[a] ?? a : '-'
}

export function aktionErklaerung(t: TFunction, a: RegelAktion): string {
  const m: Record<RegelAktion, string> = {
    pause: t('crm.werbung.regeln.aktionText.pause', 'Meta schaltet die passenden Objekte aus. Gut als Notbremse.'),
    unpause: t('crm.werbung.regeln.aktionText.unpause', 'Meta schaltet die Objekte wieder ein. Erhöht Ausgaben, daher nur Admin, nur feste Objekte und mit Leitplanken-Prüfung.'),
    budget_aendern: t('crm.werbung.regeln.aktionText.budget_aendern', 'Meta ändert das Tagesbudget der Anzeigengruppe oder Kampagne. Erhöhen nur Admin, immer mit Obergrenze.'),
    nur_benachrichtigen: t('crm.werbung.regeln.aktionText.nur_benachrichtigen', 'Meta ändert nichts und meldet nur. Die Meldungen stehen auch im Verlauf.'),
  }
  return m[a]
}

export function zeitplanLabel(t: TFunction, z: RegelZeitplan | string | null): string {
  const m: Record<string, string> = {
    laufend: t('crm.werbung.regeln.zeitplan.laufend', 'Fortlaufend'),
    taeglich: t('crm.werbung.regeln.zeitplan.taeglich', 'Täglich'),
    eigen: t('crm.werbung.regeln.zeitplan.eigen', 'Benutzerdefiniert'),
  }
  return z ? m[z] ?? z : '-'
}

export function regelStatusEtikett(t: TFunction, s: string, fallback?: string): { ton: BadgeTone; text: string } {
  switch (s) {
    case 'ENABLED': return { ton: 'success', text: t('crm.werbung.regeln.status.ENABLED', 'Aktiv') }
    case 'DISABLED': return { ton: 'neutral', text: t('crm.werbung.regeln.status.DISABLED', 'Aus') }
    case 'HAS_ISSUES': return { ton: 'danger', text: t('crm.werbung.regeln.status.HAS_ISSUES', 'Fehler') }
    case 'DELETED': return { ton: 'neutral', text: t('crm.werbung.regeln.status.DELETED', 'Gelöscht') }
    default: return { ton: 'neutral', text: fallback || s }
  }
}

export function verlaufAktionLabel(t: TFunction, a: string, fallback?: string): string {
  const m: Record<string, string> = {
    PAUSED: t('crm.werbung.regeln.verlaufAktion.PAUSED', 'Ausgeschaltet'),
    UNPAUSED: t('crm.werbung.regeln.verlaufAktion.UNPAUSED', 'Eingeschaltet'),
    CHANGED_BUDGET: t('crm.werbung.regeln.verlaufAktion.CHANGED_BUDGET', 'Budget geändert'),
    CHANGED_BID: t('crm.werbung.regeln.verlaufAktion.CHANGED_BID', 'Gebot geändert'),
    FACEBOOK_NOTIFICATION_SENT: t('crm.werbung.regeln.verlaufAktion.FACEBOOK_NOTIFICATION_SENT', 'Benachrichtigung gesendet'),
    EMAIL: t('crm.werbung.regeln.verlaufAktion.EMAIL', 'E-Mail gesendet'),
    MESSAGE_SENT: t('crm.werbung.regeln.verlaufAktion.MESSAGE_SENT', 'Nachricht gesendet'),
    ENDPOINT_PINGED: t('crm.werbung.regeln.verlaufAktion.ENDPOINT_PINGED', 'Webhook ausgelöst'),
    NOT_CHANGED: t('crm.werbung.regeln.verlaufAktion.NOT_CHANGED', 'Keine Änderung'),
    BUDGET_NOT_REDISTRIBUTED: t('crm.werbung.regeln.verlaufAktion.BUDGET_NOT_REDISTRIBUTED', 'Budget nicht umverteilt'),
    ERROR: t('crm.werbung.regeln.verlaufAktion.ERROR', 'Fehler'),
  }
  return m[a] ?? fallback ?? REGEL_VERLAUF_AKTION_LABEL[a] ?? a
}

/** Zahl in der Einheit eines Felds (EUR, Prozent, Stunden ...) */
export function einheitWert(locale: string, einheit: RegelEinheit, n: number): string {
  switch (einheit) {
    case 'eur': return n.toLocaleString(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 })
    case 'prozent': return `${n.toLocaleString(locale, { maximumFractionDigits: 2 })} %`
    case 'stunden': return `${n.toLocaleString(locale, { maximumFractionDigits: 0 })} h`
    default: return n.toLocaleString(locale, { maximumFractionDigits: 2 })
  }
}

/** Eine Bedingung als Satz: „Ausgaben größer als 150,00 €“ */
export function bedingungText(t: TFunction, locale: string, b: RegelBedingung): string {
  const e = feldEinheit(b.feld)
  const wert = Array.isArray(b.wert)
    ? t('crm.werbung.regeln.bereich', '{{von}} und {{bis}}', { von: einheitWert(locale, e, b.wert[0]), bis: einheitWert(locale, e, b.wert[1]) })
    : einheitWert(locale, e, b.wert)
  return `${feldLabel(t, b.feld)} ${operatorLabel(t, b.operator)} ${wert}`
}

/** Budget-Aktion als Satz */
export function budgetText(t: TFunction, locale: string, a: RegelBudgetAenderung | undefined): string {
  if (!a) return aktionLabel(t, 'budget_aendern')
  const betrag = a.art === 'prozent' ? `${Math.abs(a.wert).toLocaleString(locale)} %` : einheitWert(locale, 'eur', Math.abs(a.wert))
  const grenze = a.grenze_eur != null ? einheitWert(locale, 'eur', a.grenze_eur) : null
  if (a.wert < 0) {
    return grenze
      ? t('crm.werbung.regeln.budget.senkenGrenze', 'Tagesbudget um {{b}} senken, nicht unter {{g}}', { b: betrag, g: grenze })
      : t('crm.werbung.regeln.budget.senken', 'Tagesbudget um {{b}} senken', { b: betrag })
  }
  return grenze
    ? t('crm.werbung.regeln.budget.erhoehenGrenze', 'Tagesbudget um {{b}} erhöhen, höchstens {{g}}', { b: betrag, g: grenze })
    : t('crm.werbung.regeln.budget.erhoehen', 'Tagesbudget um {{b}} erhöhen', { b: betrag })
}

/** Worauf eine Regel wirkt, als Satz */
/** Einschränkungen eines Filters außer den festen IDs (Name, Kampagnenname, Kampagnen, Anzeigengruppen) */
export function filterZusatz(t: TFunction, f: RegelFilter | undefined): string[] {
  const teile: string[] = []
  if (f?.name_enthaelt) teile.push(t('crm.werbung.regeln.geltung.name', 'Name enthält „{{text}}“', { text: f.name_enthaelt }))
  if (f?.kampagnenname_enthaelt) teile.push(t('crm.werbung.regeln.geltung.kampagnenname', 'Kampagnenname enthält „{{text}}“', { text: f.kampagnenname_enthaelt }))
  if (f?.kampagnen_ids?.length) teile.push(t('crm.werbung.regeln.geltung.kampagnen', 'in {{n}} Kampagnen', { n: f.kampagnen_ids.length }))
  if (f?.anzeigengruppen_ids?.length) teile.push(t('crm.werbung.regeln.geltung.gruppen', 'in {{n}} Anzeigengruppen', { n: f.anzeigengruppen_ids.length }))
  return teile
}

export function geltungText(t: TFunction, ebene: SteuerungEbene, f: RegelFilter | undefined): string {
  const objekte = ebeneLabel(t, ebene)
  const teile = filterZusatz(t, f)
  const basis = f?.ids?.length
    ? t('crm.werbung.regeln.geltung.ids', '{{n}} ausgewählte {{objekte}}', { n: f.ids.length, objekte })
    : t('crm.werbung.regeln.geltung.alle', 'alle aktiven {{objekte}}', { objekte })
  return teile.length ? `${basis}, ${teile.join(', ')}` : basis
}

/**
 * Zahl aus einem Eingabefeld. Deutsch: Punkt vor genau drei Ziffern trennt Tausender
 * („2.000“ = 2000), das Komma ist das Dezimalzeichen; Englisch umgekehrt („2,000“ = 2000).
 * Sonst gilt Punkt oder Komma als Dezimalzeichen („2.5“ und „2,5“ = 2,5). Ungültig: null.
 */
export function zahlAusEingabe(s: string, locale: string): number | null {
  const roh = s.trim().replace(/\s/g, '')
  if (!roh) return null
  const tausender = locale.startsWith('de') ? '.' : ','
  const dezimal = tausender === '.' ? ',' : '.'
  const gruppiert = new RegExp(`^-?[1-9]\\d{0,2}(\\${tausender}\\d{3})+(\\${dezimal}\\d*)?$`)
  const norm = gruppiert.test(roh) ? roh.split(tausender).join('').replace(dezimal, '.') : roh.replace(',', '.')
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(norm)) return null
  const n = Number(norm)
  return Number.isFinite(n) ? n : null
}

/** Zahl fürs Eingabefeld, ohne Tausendertrenner, so dass zahlAusEingabe sie gleich zurückliest */
export function zahlFuerEingabe(n: number, locale: string): string {
  return n.toLocaleString(locale, { useGrouping: false, maximumFractionDigits: 6 })
}

/** Datum + Uhrzeit kurz (Berlin) */
export function zeitKurz(locale: string, iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })
}

export function datumKurz(locale: string, iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' })
}

export const eur = (locale: string, n: number | null | undefined): string =>
  n == null ? '-' : n.toLocaleString(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: n >= 100 ? 0 : 2 })
