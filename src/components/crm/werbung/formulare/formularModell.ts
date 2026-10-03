import i18next, { type TFunction } from 'i18next'
import { lintText, type LintIssue } from '../../../../lib/metaLint'
import {
  LEADFORM_MAX_EIGENE_FRAGEN, LEADFORM_MAX_EINWILLIGUNGEN, LEADFORM_WOHNEN_GRUND, LEADFORM_WOHNEN_VERBOTEN,
  type LeadFormEigeneArt, type LeadFormFrageTyp, type LeadFormLocale, type LeadFormSpecErweitert, type LeadFormTyp,
} from '../../../../lib/werbeWerkzeuge'

// ── Sofortformular: Editor-Zustand, HP-Vorgabe, Prüfung, Umwandlung ──────────
// Der Editor arbeitet auf FormularEntwurf (mit lokalen ids für Listen) und
// schickt LeadFormSpecErweitert (src/lib/werbeWerkzeuge.ts) an meta-werkzeuge.
// Bedingte Logik kann Meta per API nicht anlegen (LEADFORM_BEDINGTE_LOGIK_PER_API):
// der Editor zeigt sie gesperrt, sie wird nie gesendet.

export interface OptionEntwurf { id: number; value: string; key: string }

export interface FrageEntwurf {
  id: number
  type: LeadFormFrageTyp
  /** nur CUSTOM / DATE_TIME */
  key: string
  label: string
  custom_art: LeadFormEigeneArt
  optionen: OptionEntwurf[]
  inline_context: string
}

export interface EinwilligungEntwurf { id: number; key: string; text: string; pflicht: boolean }
export interface TrackingEntwurf { id: number; key: string; value: string }

export interface FormularEntwurf {
  name: string
  locale: LeadFormLocale
  typ: LeadFormTyp
  /** Facebook-Seite; leer = Standard-Seite aus den Werbe-Einstellungen */
  page_id: string
  intro_aktiv: boolean
  intro_headline: string
  intro_stil: 'PARAGRAPH' | 'LIST'
  intro_text: string
  intro_punkte: string[]
  fragen_ueberschrift: string
  fragen: FrageEntwurf[]
  einwilligung_aktiv: boolean
  einwilligung_titel: string
  einwilligung_text: string
  einwilligungen: EinwilligungEntwurf[]
  privacy_url: string
  privacy_text: string
  danke_titel: string
  danke_text: string
  danke_button: 'VIEW_WEBSITE' | 'NONE'
  danke_button_text: string
  danke_url: string
  sms_bestaetigung: boolean
  nur_beworbene_leads: boolean
  tracking: TrackingEntwurf[]
}

let laufendeId = 1
export const neueId = (): number => laufendeId++

/** Limits (wie Meta bzw. meta-werkzeuge, supabase/functions/meta-werkzeuge/formulare.ts:
 *  der Server kürzt längere Texte sonst stillschweigend) */
export const GRENZE = {
  name: 200, introTitel: 60, introText: 600, introPunkt: 80, frage: 200, option: 100, erklaerung: 120,
  dankeTitel: 60, dankeText: 600, buttonText: 30, linkText: 70, einwilligung: 300, einwilligungTitel: 60, fragenTitel: 60,
  trackingAnzahl: 20, trackingWert: 100,
} as const

export const istEigene = (q: Pick<FrageEntwurf, 'type'>): boolean => q.type === 'CUSTOM' || q.type === 'DATE_TIME'
export const istWohnenVerboten = (type: LeadFormFrageTyp): boolean => LEADFORM_WOHNEN_VERBOTEN.indexOf(type) >= 0

export const vordefiniert = (type: LeadFormFrageTyp): FrageEntwurf => ({
  id: neueId(), type, key: '', label: '', custom_art: 'SHORT_ANSWER', optionen: [], inline_context: '',
})

export const eigeneFrage = (art: LeadFormEigeneArt | 'DATE_TIME', label = '', optionen: string[] = [], key = '', optionKeys: string[] = []): FrageEntwurf => ({
  id: neueId(),
  type: art === 'DATE_TIME' ? 'DATE_TIME' : 'CUSTOM',
  key,
  label,
  custom_art: art === 'MULTIPLE_CHOICE' ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER',
  optionen: optionen.map((v, i) => ({ id: neueId(), value: v, key: optionKeys[i] || schluessel(v) || `a${i + 1}` })),
  inline_context: '',
})

/** Schlüssel aus einem Text (a-z, 0-9, _), höchstens 40 Zeichen */
export function schluessel(text: string): string {
  return text.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

// utm_source=meta: der Funnel zählt die Buchung als Meta-Lead (META-Badge,
// Conversions API, Kundenliste „nur Meta“). Eine eigene Quelle wie
// ?src=metaformular kennt keine der Meta-Listen (META_SOURCES, META_UTM_SOURCES).
export const TERMIN_LINK = 'https://portal.happy-property.com/termin?utm_source=meta&utm_medium=sofortformular'
export const DATENSCHUTZ_LINK = 'https://happy-property.de/datenschutz/'

/** Sprache der Kundentexte eines Formulars (nie die Sprache der CRM-Oberfläche) */
const textSprache = (locale: LeadFormLocale): 'de' | 'en' => (locale === 'de_DE' ? 'de' : 'en')

/** Kundentexte der HP-Vorgabe in der Formularsprache (Empfängersprache) */
function standardTexte(locale: LeadFormLocale) {
  const k = i18next.getFixedT(textSprache(locale))
  return {
    introTitel: k('crm.werbung.formulare.std.introTitel', 'Immobilien auf Zypern (EU)'),
    punkte: [
      k('crm.werbung.formulare.std.punkt1', 'Kostenloses Erstgespräch mit Sven'),
      k('crm.werbung.formulare.std.punkt2', 'Per Zoom oder WhatsApp-Call'),
      k('crm.werbung.formulare.std.punkt3', 'Ausfüllen dauert 1 Minute'),
    ],
    kapital: k('crm.werbung.formulare.std.kapital', 'Besitzt du eine abbezahlte Immobilie, 100.000 € Eigenkapital oder Depots in vergleichbarer Höhe?'),
    ja: k('crm.werbung.formulare.std.ja', 'Ja'),
    nein: k('crm.werbung.formulare.std.nein', 'Nein'),
    timing: k('crm.werbung.formulare.std.timing', 'Wann planst du den Kauf?'),
    asap: k('crm.werbung.formulare.std.asap', 'So schnell wie möglich'),
    monate: k('crm.werbung.formulare.std.monate', 'In 3 bis 6 Monaten'),
    spaeter: k('crm.werbung.formulare.std.spaeter', 'Später'),
    einwTitel: k('crm.werbung.formulare.std.einwTitel', 'Kontakt'),
    einwText: k('crm.werbung.formulare.std.einwText', 'Ich bin einverstanden, dass Happy Property mich per E-Mail, Telefon und WhatsApp zu meiner Anfrage kontaktiert.'),
    datenschutz: k('crm.werbung.formulare.std.datenschutz', 'Datenschutzerklärung'),
    dankeTitel: k('crm.werbung.formulare.std.dankeTitel', 'Danke!'),
    dankeText: k('crm.werbung.formulare.std.dankeText', 'Im nächsten Schritt suchst du dir direkt deinen Wunschtermin mit Sven aus.'),
    dankeButton: k('crm.werbung.formulare.std.dankeButton', 'Termin wählen'),
  }
}

/** HP-Vorgabe: Höhere Absicht, Name, E-Mail, Telefon, Kapitalbasis und Zeitpunkt
 *  (Fragen wie im Termin-Funnel, src/lib/funnelConfig.ts; Antwort-Schlüssel nur aus
 *  a-z, 0-9 und _, weil Meta keine Bindestriche nimmt: daher 3_6m statt 3-6m),
 *  Einwilligung, Danke-Seite mit Knopf zur Terminbuchung. Kundentexte in der
 *  Formularsprache (locale), nur der interne Formularname in der CRM-Sprache (t). */
export function hpStandard(t: TFunction, locale: LeadFormLocale = 'de_DE'): FormularEntwurf {
  const datum = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
  const x = standardTexte(locale)
  return {
    name: t('crm.werbung.formulare.std.name', 'HP Erstgespräch {{datum}}', { datum }),
    locale,
    typ: 'HIGHER_INTENT',
    page_id: '',
    intro_aktiv: true,
    intro_headline: x.introTitel,
    intro_stil: 'LIST',
    intro_text: '',
    intro_punkte: [...x.punkte],
    fragen_ueberschrift: '',
    fragen: [
      vordefiniert('FULL_NAME'),
      vordefiniert('EMAIL'),
      vordefiniert('PHONE'),
      eigeneFrage('MULTIPLE_CHOICE', x.kapital, [x.ja, x.nein], 'kapitalbasis', ['ja', 'nein']),
      eigeneFrage('MULTIPLE_CHOICE', x.timing, [x.asap, x.monate, x.spaeter], 'timing', ['asap', '3_6m', 'spaeter']),
    ],
    einwilligung_aktiv: true,
    einwilligung_titel: x.einwTitel,
    einwilligung_text: '',
    einwilligungen: [{ id: neueId(), key: 'kontakt', pflicht: true, text: x.einwText }],
    privacy_url: DATENSCHUTZ_LINK,
    privacy_text: x.datenschutz,
    danke_titel: x.dankeTitel,
    danke_text: x.dankeText,
    danke_button: 'VIEW_WEBSITE',
    danke_button_text: x.dankeButton,
    danke_url: TERMIN_LINK,
    sms_bestaetigung: false,
    nur_beworbene_leads: true,
    tracking: [],
  }
}

/** Sprache gewechselt: Texte, die noch unverändert der HP-Vorgabe der alten
 *  Sprache entsprechen, in die neue Sprache tauschen. Eigene Texte bleiben. */
export function spracheWechseln(e: FormularEntwurf, neu: LeadFormLocale): FormularEntwurf {
  if (textSprache(e.locale) === textSprache(neu)) return { ...e, locale: neu }
  const alt = standardTexte(e.locale)
  const ziel = standardTexte(neu)
  const paare = new Map<string, string>()
  const merke = (a: string, b: string) => { if (a && !paare.has(a)) paare.set(a, b) }
  for (const k of Object.keys(alt) as Array<keyof typeof alt>) {
    const a = alt[k]
    const b = ziel[k]
    if (Array.isArray(a) && Array.isArray(b)) a.forEach((v, i) => merke(v, b[i] ?? v))
    else if (typeof a === 'string' && typeof b === 'string') merke(a, b)
  }
  const tausch = (v: string): string => paare.get(v) ?? v
  return {
    ...e,
    locale: neu,
    intro_headline: tausch(e.intro_headline),
    intro_punkte: e.intro_punkte.map(tausch),
    fragen: e.fragen.map(q => (istEigene(q)
      ? { ...q, label: tausch(q.label), optionen: q.optionen.map(o => ({ ...o, value: tausch(o.value) })) }
      : q)),
    einwilligung_titel: tausch(e.einwilligung_titel),
    einwilligungen: e.einwilligungen.map(c => ({ ...c, text: tausch(c.text) })),
    privacy_text: tausch(e.privacy_text),
    danke_titel: tausch(e.danke_titel),
    danke_text: tausch(e.danke_text),
    danke_button_text: tausch(e.danke_button_text),
  }
}

/** Editor-Zustand -> Spezifikation für leadform_create */
export function zuSpec(e: FormularEntwurf): LeadFormSpecErweitert {
  const s = (v: string) => v.trim()
  const fragen = e.fragen.map(q => {
    if (!istEigene(q)) return { type: q.type }
    const base = { type: q.type, key: s(q.key) || schluessel(q.label) || `frage_${q.id}`, label: s(q.label) }
    const ctx = s(q.inline_context) ? { inline_context: s(q.inline_context) } : {}
    if (q.type === 'DATE_TIME') return { ...base, ...ctx }
    if (q.custom_art === 'MULTIPLE_CHOICE') {
      return {
        ...base, ...ctx, custom_art: 'MULTIPLE_CHOICE' as const,
        options: q.optionen.filter(o => s(o.value)).map((o, i) => ({ value: s(o.value), key: s(o.key) || schluessel(o.value) || `a${i + 1}` })),
      }
    }
    return { ...base, ...ctx, custom_art: 'SHORT_ANSWER' as const }
  })
  const tracking: Record<string, string> = {}
  for (const tp of e.tracking) if (s(tp.key) && s(tp.value)) tracking[s(tp.key)] = s(tp.value)
  const punkte = e.intro_punkte.map(s).filter(Boolean)
  return {
    name: s(e.name),
    locale: e.locale,
    typ: e.typ,
    higher_intent: e.typ === 'HIGHER_INTENT',
    privacy_policy_url: s(e.privacy_url),
    ...(s(e.privacy_text) ? { privacy_link_text: s(e.privacy_text) } : {}),
    questions: fragen,
    ...(s(e.fragen_ueberschrift) ? { fragen_ueberschrift: s(e.fragen_ueberschrift) } : {}),
    ...(e.intro_aktiv ? {
      ...(s(e.intro_headline) ? { intro_headline: s(e.intro_headline) } : {}),
      intro_stil: e.intro_stil,
      ...(e.intro_stil === 'LIST' ? { intro_punkte: punkte } : s(e.intro_text) ? { intro_text: s(e.intro_text) } : {}),
    } : {}),
    ...(e.einwilligung_aktiv && e.einwilligungen.some(c => s(c.text)) ? {
      einwilligungen: {
        ...(s(e.einwilligung_titel) ? { titel: s(e.einwilligung_titel) } : {}),
        ...(s(e.einwilligung_text) ? { text: s(e.einwilligung_text) } : {}),
        checkboxen: e.einwilligungen.filter(c => s(c.text)).map((c, i) => ({ key: s(c.key) || `einwilligung_${i + 1}`, text: s(c.text), pflicht: c.pflicht })),
      },
    } : {}),
    thank_you_title: s(e.danke_titel),
    ...(s(e.danke_text) ? { thank_you_body: s(e.danke_text) } : {}),
    thank_you_button: e.danke_button,
    ...(e.danke_button === 'VIEW_WEBSITE' ? { thank_you_button_text: s(e.danke_button_text), thank_you_url: s(e.danke_url) } : {}),
    sms_bestaetigung: e.sms_bestaetigung,
    nur_beworbene_leads: e.nur_beworbene_leads,
    ...(Object.keys(tracking).length ? { tracking_parameter: tracking } : {}),
    wohnen: true,
  }
}

/** Spezifikation (leadform_get) -> Editor-Zustand */
export function ausSpec(spec: LeadFormSpecErweitert, pageId?: string | null): FormularEntwurf {
  const s = (v: string | undefined | null) => (v ?? '').trim()
  const typ: LeadFormTyp = spec.typ ?? (spec.higher_intent === false ? 'MORE_VOLUME' : 'HIGHER_INTENT')
  const ew = spec.einwilligungen
  return {
    name: s(spec.name),
    locale: spec.locale ?? 'de_DE',
    typ,
    page_id: pageId ?? '',
    intro_aktiv: !!(s(spec.intro_headline) || s(spec.intro_text) || (spec.intro_punkte ?? []).length),
    intro_headline: s(spec.intro_headline),
    intro_stil: spec.intro_stil === 'LIST' ? 'LIST' : 'PARAGRAPH',
    intro_text: s(spec.intro_text),
    intro_punkte: (spec.intro_punkte ?? []).map(p => s(p)),
    fragen_ueberschrift: s(spec.fragen_ueberschrift),
    fragen: (spec.questions ?? []).map(q => ({
      id: neueId(),
      type: q.type,
      key: s(q.key),
      label: s(q.label),
      custom_art: q.custom_art ?? ((q.options ?? []).length ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER'),
      optionen: (q.options ?? []).map((o, i) => ({ id: neueId(), value: s(o.value), key: s(o.key) || `a${i + 1}` })),
      inline_context: s(q.inline_context),
    })),
    einwilligung_aktiv: !!ew && ew.checkboxen.length > 0,
    einwilligung_titel: s(ew?.titel),
    einwilligung_text: s(ew?.text),
    einwilligungen: (ew?.checkboxen ?? []).map((c, i) => ({ id: neueId(), key: s(c.key) || `einwilligung_${i + 1}`, text: s(c.text), pflicht: c.pflicht !== false })),
    privacy_url: s(spec.privacy_policy_url),
    privacy_text: s(spec.privacy_link_text),
    danke_titel: s(spec.thank_you_title),
    danke_text: s(spec.thank_you_body),
    danke_button: spec.thank_you_button ?? (s(spec.thank_you_url) ? 'VIEW_WEBSITE' : 'NONE'),
    danke_button_text: s(spec.thank_you_button_text),
    danke_url: s(spec.thank_you_url),
    sms_bestaetigung: spec.sms_bestaetigung === true,
    nur_beworbene_leads: spec.nur_beworbene_leads !== false,
    tracking: Object.entries(spec.tracking_parameter ?? {}).map(([key, value]) => ({ id: neueId(), key, value })),
  }
}

// Eigene Fragen, die nach Alter, Geschlecht, Familienstand oder Wohnort klingen
const WOHNEN_WOERTER = /\b(wie alt|alter|jahrgang|geburts\w*|geschlecht|männlich|weiblich|familienstand|verheiratet|ledig|beziehung\w*|wohnort|wohnst du|postleitzahl|plz|stadt|bundesland|herkunft|nationalität|religion)\b/i

export interface FormularPruefung {
  /** Pflichtangaben und harte Fehler */
  fehler: string[]
  /** Hinweise, die das Anlegen nicht verhindern */
  warnungen: string[]
  /** Text-Prüfung (Gedankenstriche, Umlaute, Versprechen, Projektnamen) */
  lint: LintIssue[]
}

const HTTPS = /^https:\/\/[^\s/?#]+\.[^\s]+$/i

export function pruefeFormular(e: FormularEntwurf, t: TFunction, verboteneNamen: string[]): FormularPruefung {
  const fehler: string[] = []
  const warnungen: string[] = []
  const lint: LintIssue[] = []
  const ctx = { forbiddenNames: verboteneNamen }
  const pruef = (text: string, feld: string) => { lint.push(...lintText(text, feld, ctx, 'leadform')) }
  const lang = (text: string, max: number, feld: string) => {
    if (text.trim().length > max) fehler.push(t('crm.werbung.formulare.pruef.zuLang', '{{feld}}: höchstens {{max}} Zeichen', { feld, max }))
  }

  const fName = t('crm.werbung.formulare.feld.name', 'Formularname')
  if (!e.name.trim()) fehler.push(fName)
  lang(e.name, GRENZE.name, fName)
  pruef(e.name, fName)

  if (!HTTPS.test(e.privacy_url.trim())) fehler.push(t('crm.werbung.formulare.pruef.datenschutz', 'Datenschutz-Link mit https://'))
  lang(e.privacy_text, GRENZE.linkText, t('crm.werbung.formulare.feld.linkText', 'Link-Text'))

  if (e.intro_aktiv) {
    const fT = t('crm.werbung.formulare.feld.introTitel', 'Intro-Überschrift')
    lang(e.intro_headline, GRENZE.introTitel, fT)
    pruef(e.intro_headline, fT)
    if (e.intro_stil === 'LIST') {
      const fP = t('crm.werbung.formulare.feld.introPunkt', 'Intro-Stichpunkt')
      for (const p of e.intro_punkte) { lang(p, GRENZE.introPunkt, fP); pruef(p, fP) }
    } else {
      const fX = t('crm.werbung.formulare.feld.introText', 'Intro-Text')
      lang(e.intro_text, GRENZE.introText, fX)
      pruef(e.intro_text, fX)
    }
  }

  lang(e.fragen_ueberschrift, GRENZE.fragenTitel, t('crm.werbung.formulare.fragenTitel', 'Überschrift über den Fragen'))
  if (!e.fragen.length) fehler.push(t('crm.werbung.formulare.pruef.keineFrage', 'Mindestens eine Frage'))
  const eigene = e.fragen.filter(istEigene)
  if (eigene.length > LEADFORM_MAX_EIGENE_FRAGEN) fehler.push(t('crm.werbung.formulare.pruef.zuVieleFragen', 'Höchstens {{n}} eigene Fragen', { n: LEADFORM_MAX_EIGENE_FRAGEN }))
  const typen = new Set<string>()
  const keys = new Set<string>()
  e.fragen.forEach((q, i) => {
    const nr = i + 1
    if (istWohnenVerboten(q.type)) fehler.push(t('crm.werbung.formulare.pruef.wohnen', 'Frage {{nr}}: {{grund}}', { nr, grund: t('crm.werbung.formulare.wohnenGrund', LEADFORM_WOHNEN_GRUND) }))
    if (!istEigene(q)) {
      if (typen.has(q.type)) fehler.push(t('crm.werbung.formulare.pruef.doppelt', 'Frage {{nr}} steht doppelt im Formular', { nr }))
      typen.add(q.type)
      return
    }
    const fQ = t('crm.werbung.formulare.feld.frageNr', 'Frage {{nr}}', { nr })
    if (!q.label.trim()) fehler.push(t('crm.werbung.formulare.pruef.frageText', 'Frage {{nr}}: Fragetext fehlt', { nr }))
    lang(q.label, GRENZE.frage, fQ)
    pruef(q.label, fQ)
    if (q.inline_context.trim()) { lang(q.inline_context, GRENZE.erklaerung, fQ); pruef(q.inline_context, fQ) }
    if (WOHNEN_WOERTER.test(q.label)) warnungen.push(t('crm.werbung.formulare.pruef.wohnenWort', 'Frage {{nr}} klingt nach Alter, Geschlecht oder Wohnort. Das ist unter Wohnen nicht erlaubt.', { nr }))
    const key = q.key.trim() || schluessel(q.label)
    if (key && keys.has(key)) fehler.push(t('crm.werbung.formulare.pruef.schluessel', 'Frage {{nr}}: Schlüssel „{{key}}“ doppelt', { nr, key }))
    if (key) keys.add(key)
    if (q.key.trim() && !/^[a-z0-9_]+$/.test(q.key.trim())) fehler.push(t('crm.werbung.formulare.pruef.schluesselZeichen', 'Frage {{nr}}: Schlüssel nur aus a-z, 0-9 und _', { nr }))
    if (q.type === 'CUSTOM' && q.custom_art === 'MULTIPLE_CHOICE') {
      const opts = q.optionen.filter(o => o.value.trim())
      if (opts.length < 2) fehler.push(t('crm.werbung.formulare.pruef.antworten', 'Frage {{nr}}: mindestens zwei Antworten', { nr }))
      for (const o of opts) { lang(o.value, GRENZE.option, fQ); pruef(o.value, fQ) }
      const oKeys = opts.map(o => o.key.trim() || schluessel(o.value))
      if (new Set(oKeys).size !== oKeys.length) fehler.push(t('crm.werbung.formulare.pruef.antwortDoppelt', 'Frage {{nr}}: zwei Antworten sind gleich', { nr }))
    }
  })
  if (!e.fragen.some(q => q.type === 'EMAIL' || q.type === 'PHONE' || q.type === 'WHATSAPP_NUMBER' || q.type === 'WORK_EMAIL')) {
    warnungen.push(t('crm.werbung.formulare.pruef.keinKontakt', 'Ohne E-Mail oder Telefonnummer kann niemand den Lead erreichen.'))
  }
  if (e.sms_bestaetigung && !e.fragen.some(q => q.type === 'PHONE')) fehler.push(t('crm.werbung.formulare.pruef.sms', 'SMS-Bestätigung braucht die Frage Telefonnummer'))

  if (e.einwilligung_aktiv) {
    const aktiv = e.einwilligungen.filter(c => c.text.trim())
    if (!aktiv.length) fehler.push(t('crm.werbung.formulare.pruef.einwilligung', 'Einwilligung: mindestens ein Kästchen mit Text'))
    if (aktiv.length > LEADFORM_MAX_EINWILLIGUNGEN) fehler.push(t('crm.werbung.formulare.pruef.einwilligungMax', 'Höchstens {{n}} Einwilligungen', { n: LEADFORM_MAX_EINWILLIGUNGEN }))
    const fE = t('crm.werbung.formulare.feld.einwilligung', 'Einwilligung')
    for (const c of aktiv) { lang(c.text, GRENZE.einwilligung, fE); pruef(c.text, fE) }
    lang(e.einwilligung_titel, GRENZE.einwilligungTitel, t('crm.werbung.formulare.einwTitel', 'Überschrift des Haftungsausschlusses'))
    pruef(e.einwilligung_titel, fE)
    pruef(e.einwilligung_text, fE)
  }

  const fD = t('crm.werbung.formulare.feld.danke', 'Abschluss-Seite')
  if (!e.danke_titel.trim()) fehler.push(t('crm.werbung.formulare.pruef.dankeTitel', 'Überschrift der Abschluss-Seite'))
  lang(e.danke_titel, GRENZE.dankeTitel, fD)
  lang(e.danke_text, GRENZE.dankeText, fD)
  pruef(e.danke_titel, fD)
  pruef(e.danke_text, fD)
  if (e.danke_button === 'VIEW_WEBSITE') {
    if (!e.danke_button_text.trim()) fehler.push(t('crm.werbung.formulare.pruef.buttonText', 'Text des Buttons auf der Abschluss-Seite'))
    lang(e.danke_button_text, GRENZE.buttonText, fD)
    pruef(e.danke_button_text, fD)
    if (!HTTPS.test(e.danke_url.trim())) fehler.push(t('crm.werbung.formulare.pruef.buttonLink', 'Link des Buttons mit https://'))
  }
  for (const tp of e.tracking) {
    if ((tp.key.trim() || tp.value.trim()) && !/^[A-Za-z0-9_]{1,40}$/.test(tp.key.trim())) {
      fehler.push(t('crm.werbung.formulare.pruef.tracking', 'Tracking-Parameter: Name nur aus Buchstaben, Ziffern und _'))
      break
    }
  }
  const fTp = t('crm.werbung.formulare.tracking', 'Tracking-Parameter')
  const tpGefuellt = e.tracking.filter(tp => tp.key.trim() && tp.value.trim())
  if (tpGefuellt.length > GRENZE.trackingAnzahl) fehler.push(t('crm.werbung.formulare.pruef.trackingMax', 'Höchstens {{n}} Tracking-Parameter', { n: GRENZE.trackingAnzahl }))
  const zuLang = tpGefuellt.find(tp => tp.value.trim().length > GRENZE.trackingWert)
  if (zuLang) lang(zuLang.value, GRENZE.trackingWert, fTp)
  return { fehler, warnungen, lint }
}

/** Anzahl eigener Fragen (für Zähler im Editor) */
export const eigeneZahl = (e: FormularEntwurf): number => e.fragen.filter(istEigene).length

/** Frische lokale ids (nach dem Laden eines gemerkten Entwurfs) */
export function neuNummerieren(e: FormularEntwurf): FormularEntwurf {
  return {
    ...e,
    fragen: e.fragen.map(q => ({ ...q, id: neueId(), optionen: q.optionen.map(o => ({ ...o, id: neueId() })) })),
    einwilligungen: e.einwilligungen.map(c => ({ ...c, id: neueId() })),
    tracking: e.tracking.map(tp => ({ ...tp, id: neueId() })),
  }
}

/** Gemerkter Entwurf aus dem Browser: grob prüfen, sonst null */
export function entwurfAusSpeicher(roh: string | null): FormularEntwurf | null {
  if (!roh) return null
  try {
    const v = JSON.parse(roh) as Partial<FormularEntwurf> | null
    if (!v || typeof v.name !== 'string' || !Array.isArray(v.fragen) || !Array.isArray(v.einwilligungen) || !Array.isArray(v.intro_punkte)) return null
    return neuNummerieren({ tracking: [], ...v } as FormularEntwurf)
  } catch {
    return null
  }
}
