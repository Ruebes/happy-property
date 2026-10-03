import type { BasisFeld, Knoten, Werte } from './typen'
import { berechneFormel, parseFormel, type FormelFehler, type FormelKnoten } from './formel'

// ── Spalten der Kampagnen-Zentrale ───────────────────────────────────────────
// Bezeichnungen wie im Meta-Werbeanzeigenmanager (DE). quelle:
//   basis   - liegt in der Datenbank (täglicher Sync), sofort da
//   meta    - nur direkt von Meta (meta-berichte insights, auf Knopfdruck)
//   crm     - CRM-Kette (Leads, Termine, Qualität, Sales), nur mit Recht sichtbar
//   spiegel - Einstellung/Status aus den Spiegeltabellen (Text)
// Prozentwerte rechnen als Anteil (0,05 = 5 %), Geld in EUR.

export type SpaltenFormat = 'eur' | 'zahl' | 'dezimal' | 'prozent' | 'faktor' | 'text'
export type SpaltenQuelle = 'basis' | 'meta' | 'crm' | 'spiegel'

export interface Etikett { k: string; d: string }

export interface SpaltenDef {
  key: string
  label: Etikett
  /** Ein Satz Erklärung in einfachem Deutsch (Tooltip, Spalten anpassen) */
  hilfe: Etikett
  format: SpaltenFormat
  quelle: SpaltenQuelle
  /** Höher ist besser (Vergleich grün), false = niedriger ist besser, null = neutral */
  hoeherBesser: boolean | null
  /** Zahlenwert aus den Basiswerten (Textspalten: undefined) */
  wert?: (w: Werte) => number | null
  /** Kategorie in „Spalten anpassen" */
  gruppe: SpaltenGruppe
}

export type SpaltenGruppe = 'einstellungen' | 'leistung' | 'interaktion' | 'video' | 'conversions' | 'crm'

export const SPALTEN_GRUPPEN: Array<{ id: SpaltenGruppe; label: Etikett }> = [
  { id: 'einstellungen', label: { k: 'crm.werbung.zentrale.gruppe.einstellungen', d: 'Einstellungen' } },
  { id: 'leistung', label: { k: 'crm.werbung.zentrale.gruppe.leistung', d: 'Performance' } },
  { id: 'interaktion', label: { k: 'crm.werbung.zentrale.gruppe.interaktion', d: 'Interaktion' } },
  { id: 'video', label: { k: 'crm.werbung.zentrale.gruppe.video', d: 'Videointeraktion' } },
  { id: 'conversions', label: { k: 'crm.werbung.zentrale.gruppe.conversions', d: 'Conversions' } },
  { id: 'crm', label: { k: 'crm.werbung.zentrale.gruppe.crm', d: 'CRM-Qualität' } },
]

const n = (w: Werte, f: BasisFeld): number => w[f] ?? 0
const hat = (w: Werte, f: BasisFeld): boolean => typeof w[f] === 'number'
/** Summe oder null, wenn das Feld gar nicht geliefert wurde */
const feld = (f: BasisFeld) => (w: Werte): number | null => (hat(w, f) ? n(w, f) : null)
/** a / b, null bei b = 0 oder fehlenden Werten */
const quote = (a: BasisFeld, b: BasisFeld, faktor = 1) => (w: Werte): number | null =>
  (hat(w, a) && n(w, b) > 0 ? (n(w, a) / n(w, b)) * faktor : null)

/** Ergebnisse: Metas eigene Zahl, sonst die Meta-Leads */
export const ergebnisseVon = (w: Werte): number | null =>
  hat(w, 'ergebnisse') ? n(w, 'ergebnisse') : hat(w, 'meta_leads') ? n(w, 'meta_leads') : null

const s = (key: string, d: string): Etikett => ({ k: `crm.werbung.zentrale.spalte.${key}`, d })
const h = (key: string, d: string): Etikett => ({ k: `crm.werbung.zentrale.hilfe.${key}`, d })

export const SPALTEN: SpaltenDef[] = [
  // Einstellungen / Status (Text)
  { key: 'auslieferung', label: s('auslieferung', 'Auslieferung'), hilfe: h('auslieferung', 'Ob Meta gerade ausliefert, inklusive Lernphase, Prüfung und Ablehnung.'), format: 'text', quelle: 'spiegel', hoeherBesser: null, gruppe: 'einstellungen' },
  { key: 'lernphase', label: s('lernphase', 'Lernphase'), hilfe: h('lernphase', 'Meta braucht rund 50 Ergebnisse pro Woche, um die Auslieferung stabil zu optimieren.'), format: 'text', quelle: 'spiegel', hoeherBesser: null, gruppe: 'einstellungen' },
  { key: 'letzte_aenderung', label: s('letzte_aenderung', 'Letzte wesentliche Änderung'), hilfe: h('letzte_aenderung', 'Seit dieser Änderung läuft die Lernphase. Neue Änderungen setzen sie zurück.'), format: 'text', quelle: 'spiegel', hoeherBesser: null, gruppe: 'einstellungen' },
  { key: 'budget', label: s('budget', 'Budget'), hilfe: h('budget', 'Tages- oder Laufzeitbudget in der Kontowährung (USD), daneben grob in Euro.'), format: 'text', quelle: 'spiegel', hoeherBesser: null, gruppe: 'einstellungen' },
  { key: 'gebotsstrategie', label: s('gebotsstrategie', 'Gebotsstrategie'), hilfe: h('gebotsstrategie', 'Wie Meta in der Auktion bietet, z. B. höchstes Volumen oder Kostenobergrenze.'), format: 'text', quelle: 'spiegel', hoeherBesser: null, gruppe: 'einstellungen' },
  { key: 'leistungsziel', label: s('leistungsziel', 'Performance-Ziel'), hilfe: h('leistungsziel', 'Worauf Meta die Anzeigengruppe optimiert, z. B. Conversions auf der Website.'), format: 'text', quelle: 'spiegel', hoeherBesser: null, gruppe: 'einstellungen' },

  // Performance
  { key: 'ergebnisse', label: s('ergebnisse', 'Ergebnisse'), hilfe: h('ergebnisse', 'Ergebnisse laut Meta passend zum Performance-Ziel, bei uns meist Leads.'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: ergebnisseVon, gruppe: 'leistung' },
  { key: 'kosten_pro_ergebnis', label: s('kosten_pro_ergebnis', 'Kosten pro Ergebnis'), hilfe: h('kosten_pro_ergebnis', 'Ausgegebener Betrag geteilt durch die Ergebnisse laut Meta.'), format: 'eur', quelle: 'basis', hoeherBesser: false, wert: w => { const e = ergebnisseVon(w); return e && e > 0 && hat(w, 'ausgaben') ? n(w, 'ausgaben') / e : null }, gruppe: 'leistung' },
  { key: 'ausgaben', label: s('ausgaben', 'Ausgegebener Betrag'), hilfe: h('ausgaben', 'Was im Zeitraum ausgegeben wurde, aus USD in Euro umgerechnet.'), format: 'eur', quelle: 'basis', hoeherBesser: null, wert: feld('ausgaben'), gruppe: 'leistung' },
  { key: 'reichweite', label: s('reichweite', 'Reichweite'), hilfe: h('reichweite', 'Wie viele Personen die Werbung mindestens einmal gesehen haben (geschätzt).'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: feld('reichweite'), gruppe: 'leistung' },
  { key: 'impressionen', label: s('impressionen', 'Impressionen'), hilfe: h('impressionen', 'Wie oft die Werbung insgesamt angezeigt wurde.'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: feld('impressionen'), gruppe: 'leistung' },
  { key: 'frequenz', label: s('frequenz', 'Frequenz'), hilfe: h('frequenz', 'Wie oft dieselbe Person die Werbung im Schnitt gesehen hat. Über 3 wird es oft teurer.'), format: 'dezimal', quelle: 'basis', hoeherBesser: null, wert: quote('impressionen', 'reichweite'), gruppe: 'leistung' },
  { key: 'cpm', label: s('cpm', 'CPM (Kosten pro 1.000 Impressionen)'), hilfe: h('cpm', 'Was 1.000 Einblendungen kosten. Steigt, wenn die Zielgruppe umkämpft ist.'), format: 'eur', quelle: 'basis', hoeherBesser: false, wert: quote('ausgaben', 'impressionen', 1000), gruppe: 'leistung' },
  { key: 'link_klicks', label: s('link_klicks', 'Link-Klicks'), hilfe: h('link_klicks', 'Klicks auf den Link der Anzeige (zur Website oder zum Formular).'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: feld('link_klicks'), gruppe: 'leistung' },
  { key: 'ctr', label: s('ctr', 'CTR (Link-Klickrate)'), hilfe: h('ctr', 'Anteil der Impressionen, die zu einem Link-Klick geführt haben.'), format: 'prozent', quelle: 'basis', hoeherBesser: true, wert: quote('link_klicks', 'impressionen'), gruppe: 'leistung' },
  { key: 'cpc', label: s('cpc', 'CPC (Kosten pro Link-Klick)'), hilfe: h('cpc', 'Ausgegebener Betrag geteilt durch die Link-Klicks.'), format: 'eur', quelle: 'basis', hoeherBesser: false, wert: quote('ausgaben', 'link_klicks'), gruppe: 'leistung' },
  { key: 'ausgehende_klicks', label: s('ausgehende_klicks', 'Ausgehende Klicks'), hilfe: h('ausgehende_klicks', 'Klicks, die Facebook oder Instagram verlassen und auf unsere Seite führen.'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: feld('ausgehende_klicks'), gruppe: 'leistung' },
  { key: 'lpv', label: s('lpv', 'Aufrufe der Landingpage'), hilfe: h('lpv', 'Wie oft unsere Seite nach dem Klick wirklich geladen wurde.'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: feld('lpv'), gruppe: 'leistung' },
  { key: 'kosten_pro_lpv', label: s('kosten_pro_lpv', 'Kosten pro Aufruf der Landingpage'), hilfe: h('kosten_pro_lpv', 'Ausgegebener Betrag geteilt durch die Aufrufe der Landingpage.'), format: 'eur', quelle: 'basis', hoeherBesser: false, wert: quote('ausgaben', 'lpv'), gruppe: 'leistung' },

  // Interaktion (nur von Meta)
  { key: 'klicks_alle', label: s('klicks_alle', 'Klicks (alle)'), hilfe: h('klicks_alle', 'Alle Klicks auf die Anzeige, auch auf Profil, Bild oder „Mehr ansehen".'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('klicks_alle'), gruppe: 'interaktion' },
  { key: 'beitrags_interaktionen', label: s('beitrags_interaktionen', 'Beitragsinteraktionen'), hilfe: h('beitrags_interaktionen', 'Alle Handlungen am Beitrag: Reaktionen, Kommentare, Teilen, Klicks.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('beitrags_interaktionen'), gruppe: 'interaktion' },
  { key: 'reaktionen', label: s('reaktionen', 'Beitragsreaktionen'), hilfe: h('reaktionen', 'Gefällt mir und andere Reaktionen auf die Anzeige.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('reaktionen'), gruppe: 'interaktion' },
  { key: 'kommentare', label: s('kommentare', 'Beitragskommentare'), hilfe: h('kommentare', 'Kommentare unter der Anzeige.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('kommentare'), gruppe: 'interaktion' },
  { key: 'geteilt', label: s('geteilt', 'Geteilte Beiträge'), hilfe: h('geteilt', 'Wie oft die Anzeige geteilt wurde.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('geteilt'), gruppe: 'interaktion' },
  { key: 'gespeichert', label: s('gespeichert', 'Beitragsspeicherungen'), hilfe: h('gespeichert', 'Wie oft die Anzeige gespeichert wurde.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('gespeichert'), gruppe: 'interaktion' },

  // Video
  { key: 'video_3s', label: s('video_3s', '3-Sekunden-Videowiedergaben'), hilfe: h('video_3s', 'Wie oft ein Video mindestens 3 Sekunden lief.'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: feld('video_3s'), gruppe: 'video' },
  { key: 'hook_rate', label: s('hook_rate', 'Hook-Rate'), hilfe: h('hook_rate', '3-Sekunden-Wiedergaben geteilt durch Impressionen: hält der Anfang die Leute fest?'), format: 'prozent', quelle: 'basis', hoeherBesser: true, wert: quote('video_3s', 'impressionen'), gruppe: 'video' },
  { key: 'thruplays', label: s('thruplays', 'ThruPlays'), hilfe: h('thruplays', 'Videos, die zu Ende oder mindestens 15 Sekunden angesehen wurden.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('thruplays'), gruppe: 'video' },
  { key: 'kosten_pro_thruplay', label: s('kosten_pro_thruplay', 'Kosten pro ThruPlay'), hilfe: h('kosten_pro_thruplay', 'Ausgegebener Betrag geteilt durch die ThruPlays.'), format: 'eur', quelle: 'meta', hoeherBesser: false, wert: quote('ausgaben', 'thruplays'), gruppe: 'video' },
  { key: 'video_25', label: s('video_25', 'Videowiedergaben zu 25 %'), hilfe: h('video_25', 'Wie oft ein Viertel des Videos angesehen wurde.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('video_25'), gruppe: 'video' },
  { key: 'video_50', label: s('video_50', 'Videowiedergaben zu 50 %'), hilfe: h('video_50', 'Wie oft die Hälfte des Videos angesehen wurde.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('video_50'), gruppe: 'video' },
  { key: 'video_75', label: s('video_75', 'Videowiedergaben zu 75 %'), hilfe: h('video_75', 'Wie oft drei Viertel des Videos angesehen wurden.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('video_75'), gruppe: 'video' },
  { key: 'video_95', label: s('video_95', 'Videowiedergaben zu 95 %'), hilfe: h('video_95', 'Wie oft das Video fast ganz angesehen wurde.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('video_95'), gruppe: 'video' },
  { key: 'video_100', label: s('video_100', 'Videowiedergaben zu 100 %'), hilfe: h('video_100', 'Wie oft das Video bis zum Ende angesehen wurde.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('video_100'), gruppe: 'video' },

  // Conversions laut Meta
  { key: 'meta_leads', label: s('meta_leads', 'Leads (Meta)'), hilfe: h('meta_leads', 'Leads, die Meta selbst zählt (Pixel oder Sofortformular).'), format: 'zahl', quelle: 'basis', hoeherBesser: true, wert: feld('meta_leads'), gruppe: 'conversions' },
  { key: 'termine_meta', label: s('termine_meta', 'Terminbuchungen (Meta)'), hilfe: h('termine_meta', 'Terminbuchungen, die das Meta-Pixel gemeldet hat.'), format: 'zahl', quelle: 'meta', hoeherBesser: true, wert: feld('termine_meta'), gruppe: 'conversions' },

  // CRM-Qualität
  { key: 'crm_leads', label: s('crm_leads', 'Leads (CRM)'), hilfe: h('crm_leads', 'Leads, die im CRM dieser Anzeige zugeordnet sind.'), format: 'zahl', quelle: 'crm', hoeherBesser: true, wert: feld('crm_leads'), gruppe: 'crm' },
  { key: 'leadpreis_crm', label: s('leadpreis_crm', 'Leadpreis (CRM)'), hilfe: h('leadpreis_crm', 'Ausgegebener Betrag geteilt durch die Leads im CRM.'), format: 'eur', quelle: 'crm', hoeherBesser: false, wert: quote('ausgaben', 'crm_leads'), gruppe: 'crm' },
  { key: 'termine', label: s('termine', 'Termine'), hilfe: h('termine', 'Leads mit mindestens einem gebuchten Termin.'), format: 'zahl', quelle: 'crm', hoeherBesser: true, wert: feld('termine'), gruppe: 'crm' },
  { key: 'kosten_pro_termin', label: s('kosten_pro_termin', 'Kosten pro Termin'), hilfe: h('kosten_pro_termin', 'Ausgegebener Betrag geteilt durch die gebuchten Termine.'), format: 'eur', quelle: 'crm', hoeherBesser: false, wert: quote('ausgaben', 'termine'), gruppe: 'crm' },
  { key: 'stattgefunden', label: s('stattgefunden', 'Stattgefunden'), hilfe: h('stattgefunden', 'Termine, die wirklich stattgefunden haben.'), format: 'zahl', quelle: 'crm', hoeherBesser: true, wert: feld('stattgefunden'), gruppe: 'crm' },
  { key: 'kosten_pro_stattgefunden', label: s('kosten_pro_stattgefunden', 'Kosten pro stattgef. Termin'), hilfe: h('kosten_pro_stattgefunden', 'Ausgegebener Betrag geteilt durch die stattgefundenen Termine.'), format: 'eur', quelle: 'crm', hoeherBesser: false, wert: quote('ausgaben', 'stattgefunden'), gruppe: 'crm' },
  { key: 'no_shows', label: s('no_shows', 'No-Shows'), hilfe: h('no_shows', 'Gebuchte Termine, zu denen niemand erschienen ist.'), format: 'zahl', quelle: 'crm', hoeherBesser: false, wert: feld('no_shows'), gruppe: 'crm' },
  { key: 'gut', label: s('gut', 'Gut bewertet'), hilfe: h('gut', 'Leads, die im CRM mit „gut" bewertet wurden.'), format: 'zahl', quelle: 'crm', hoeherBesser: true, wert: feld('gut'), gruppe: 'crm' },
  { key: 'schlecht', label: s('schlecht', 'Schlecht bewertet'), hilfe: h('schlecht', 'Leads, die im CRM mit „schlecht" bewertet wurden.'), format: 'zahl', quelle: 'crm', hoeherBesser: false, wert: feld('schlecht'), gruppe: 'crm' },
  { key: 'qualitaetsquote', label: s('qualitaetsquote', 'Qualitätsquote'), hilfe: h('qualitaetsquote', 'Anteil „gut" unter allen bewerteten Leads.'), format: 'prozent', quelle: 'crm', hoeherBesser: true, wert: w => { const b = n(w, 'gut') + n(w, 'schlecht'); return b > 0 ? n(w, 'gut') / b : null }, gruppe: 'crm' },
  { key: 'kosten_pro_gutem_lead', label: s('kosten_pro_gutem_lead', 'Kosten pro gutem Lead'), hilfe: h('kosten_pro_gutem_lead', 'Ausgegebener Betrag geteilt durch die gut bewerteten Leads.'), format: 'eur', quelle: 'crm', hoeherBesser: false, wert: quote('ausgaben', 'gut'), gruppe: 'crm' },
  { key: 'sales', label: s('sales', 'Sales'), hilfe: h('sales', 'Abschlüsse (Anzahlung oder Provision erhalten) aus diesen Leads.'), format: 'zahl', quelle: 'crm', hoeherBesser: true, wert: feld('sales'), gruppe: 'crm' },
  { key: 'umsatz', label: s('umsatz', 'Umsatz'), hilfe: h('umsatz', 'Provision aus den Abschlüssen.'), format: 'eur', quelle: 'crm', hoeherBesser: true, wert: feld('umsatz'), gruppe: 'crm' },
  { key: 'roas', label: s('roas', 'ROAS'), hilfe: h('roas', 'Umsatz geteilt durch den ausgegebenen Betrag.'), format: 'faktor', quelle: 'crm', hoeherBesser: true, wert: quote('umsatz', 'ausgaben'), gruppe: 'crm' },
]

export const SPALTE = new Map(SPALTEN.map(c => [c.key, c]))

// ── Spalten-Voreinstellungen (wie „Spalten: Performance" bei Meta) ────────────
export type PresetId = 'leistung' | 'auslieferung' | 'interaktion' | 'video' | 'gebote' | 'crm'

export const PRESETS: Array<{ id: PresetId; label: Etikett; spalten: string[] }> = [
  { id: 'leistung', label: { k: 'crm.werbung.zentrale.preset.leistung', d: 'Leistung' },
    spalten: ['auslieferung', 'budget', 'ergebnisse', 'kosten_pro_ergebnis', 'ausgaben', 'reichweite', 'impressionen', 'frequenz', 'link_klicks', 'ctr', 'cpm', 'termine', 'kosten_pro_termin'] },
  { id: 'auslieferung', label: { k: 'crm.werbung.zentrale.preset.auslieferung', d: 'Auslieferung' },
    spalten: ['auslieferung', 'lernphase', 'letzte_aenderung', 'budget', 'ausgaben', 'reichweite', 'impressionen', 'frequenz', 'cpm'] },
  { id: 'interaktion', label: { k: 'crm.werbung.zentrale.preset.interaktion', d: 'Interaktion' },
    spalten: ['ausgaben', 'beitrags_interaktionen', 'reaktionen', 'kommentare', 'geteilt', 'gespeichert', 'klicks_alle', 'link_klicks', 'ctr', 'cpc', 'ausgehende_klicks', 'lpv', 'kosten_pro_lpv'] },
  { id: 'video', label: { k: 'crm.werbung.zentrale.preset.video', d: 'Video' },
    spalten: ['ausgaben', 'impressionen', 'video_3s', 'hook_rate', 'thruplays', 'kosten_pro_thruplay', 'video_25', 'video_50', 'video_75', 'video_95', 'video_100'] },
  { id: 'gebote', label: { k: 'crm.werbung.zentrale.preset.gebote', d: 'Gebote' },
    spalten: ['auslieferung', 'gebotsstrategie', 'leistungsziel', 'budget', 'ausgaben', 'ergebnisse', 'kosten_pro_ergebnis', 'cpm', 'letzte_aenderung'] },
  { id: 'crm', label: { k: 'crm.werbung.zentrale.preset.crm', d: 'CRM-Qualität' },
    spalten: ['ausgaben', 'meta_leads', 'crm_leads', 'leadpreis_crm', 'termine', 'kosten_pro_termin', 'stattgefunden', 'kosten_pro_stattgefunden', 'no_shows', 'gut', 'schlecht', 'qualitaetsquote', 'kosten_pro_gutem_lead', 'sales', 'umsatz', 'roas'] },
]

export const PRESET = new Map(PRESETS.map(p => [p.id, p]))

/** Voreinstellung zu einer beliebigen ID (gespeicherte Ansichten liefern string) */
export const presetVon = (id: string) => PRESETS.find(p => p.id === id)

// ── Eigene Kennzahlen (Formel über vorhandene Spalten) ───────────────────────
export interface EigeneKennzahl {
  id: string
  name: string
  formel: string
  format: 'zahl' | 'eur' | 'prozent'
}

export const EIGEN_PREFIX = 'eigen:'

/** Spalten, die in Formeln benutzt werden dürfen (alle Zahlenspalten) */
export const FORMEL_SPALTEN = SPALTEN.filter(c => c.format !== 'text').map(c => c.key)

/** Zahlenwert einer eingebauten Spalte */
export function spaltenWert(key: string, w: Werte): number | null {
  const def = SPALTE.get(key)
  return def?.wert ? def.wert(w) : null
}

/** Kompilierte eigene Kennzahl (Formel einmal geparst) */
export interface EigeneSpalte { def: EigeneKennzahl; ast: FormelKnoten | null; fehler: FormelFehler | null }

export function kompiliereEigene(liste: EigeneKennzahl[]): Map<string, EigeneSpalte> {
  const m = new Map<string, EigeneSpalte>()
  for (const def of liste) {
    const r = parseFormel(def.formel, new Set(FORMEL_SPALTEN))
    m.set(EIGEN_PREFIX + def.id, r.ok ? { def, ast: r.ast, fehler: null } : { def, ast: null, fehler: r.fehler })
  }
  return m
}

/** Wert einer beliebigen Spalte (eingebaut oder eigen) */
export function wertVon(key: string, w: Werte, eigene: Map<string, EigeneSpalte>): number | null {
  if (key.startsWith(EIGEN_PREFIX)) {
    const e = eigene.get(key)
    if (!e?.ast) return null
    return berechneFormel(e.ast, name => spaltenWert(name, w))
  }
  return spaltenWert(key, w)
}

export function formatVon(key: string, eigene: Map<string, EigeneSpalte>): SpaltenFormat {
  if (key.startsWith(EIGEN_PREFIX)) return eigene.get(key)?.def.format ?? 'zahl'
  return SPALTE.get(key)?.format ?? 'zahl'
}

/** Braucht die Spalte Zahlen direkt von Meta? */
export function brauchtMeta(key: string, eigene: Map<string, EigeneSpalte>): boolean {
  if (key.startsWith(EIGEN_PREFIX)) {
    const f = eigene.get(key)?.def.formel ?? ''
    return SPALTEN.some(c => c.quelle === 'meta' && new RegExp(`(^|[^a-z0-9_])${c.key}($|[^a-z0-9_])`, 'i').test(f))
  }
  return SPALTE.get(key)?.quelle === 'meta'
}

/** Welche Feldgruppe meta-berichte liefern soll. 'gebote' (unique_clicks,
 *  attribution_setting) nutzt keine Spalte, deshalb nie angefordert. */
export function felderFuer(spalten: string[], preset: string): 'standard' | 'video' {
  if (preset === 'video' || spalten.some(k => SPALTE.get(k)?.gruppe === 'video' && SPALTE.get(k)?.quelle === 'meta')) return 'video'
  return 'standard'
}

/** Basiswerte zweier Zeilen addieren (für Summen und Zusammenfassen) */
export function addiere(ziel: Werte, quelle: Werte): Werte {
  for (const [k, v] of Object.entries(quelle) as Array<[BasisFeld, number | undefined]>) {
    if (typeof v === 'number' && Number.isFinite(v)) ziel[k] = (ziel[k] ?? 0) + v
  }
  return ziel
}

/** Summe über Knoten (nur deren eigene Werte, keine Kinder) */
export function summe(knoten: Knoten[]): Werte {
  const w: Werte = {}
  for (const k of knoten) addiere(w, k.werte)
  return w
}
