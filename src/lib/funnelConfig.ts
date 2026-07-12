import { supabase } from './supabase'
import { DECK_PHOTO, DECK_CONTACT } from './deckTypes'

// ── Editierbare Funnel-Konfiguration (Tabelle funnel_config, id='default') ────
// Gepflegt im Editor /admin/crm/funnel-editor (Rollen admin + funnel).
// DEFAULT_FUNNEL_CONFIG ist zugleich Seed und Offline-Fallback: der öffentliche
// Funnel muss auch rendern, wenn die Config nicht ladbar ist.

export interface FunnelOption {
  key: string
  label: string
  icon?: string       // Piktogramm aus dem festen Set (FUNNEL_ICONS)
  emoji?: string      // Alternative: Emoji statt Piktogramm
  image_url?: string  // Alternative: eigenes Bild (hat Vorrang)
}

export interface FunnelQuestion {
  key: string
  title: string
  sub?: string
  tiles?: boolean     // Kachel-Layout mit Icons statt Button-Liste
  options: FunnelOption[]
}

export interface FunnelSocial { icon: string; label: string; url: string }

// Zusätzlicher Fragebogen (Variante): erreichbar über /termin?f=<slug>.
// Reservierter Slug 'none' = ganz ohne Fragebogen (nur Kontakt + Termin).
export interface FunnelQuestionnaire { slug: string; name: string; questions: FunnelQuestion[] }

// Kampagnen-/Quellen-Link (Funnel-Editor → „Links & Quellen"): ein teilbarer
// /termin-Link, der eine Buchung einer Quelle zuordnet (deals.source →
// Kachel-Badge in der Pipeline) und über utm_campaign=<code> für die spätere
// Statistik eindeutig zählbar ist.
//   source        = Kanal, der als Badge erscheint (youtube/instagram/… oder frei)
//   questionnaire = welcher Einstieg: 'standard' | '<variant-slug>' | 'none' (nur
//                   Termin) | 'buchen' (Schnellbuchung, direkt Terminart)
export interface FunnelLink {
  code: string
  name: string
  source: string
  questionnaire: string
  created_at?: string
}

export interface FunnelConfig {
  welcome: { title: string; subtitle: string; cta: string; footnote: string; hero_url: string }
  questions: FunnelQuestion[]
  questionnaires: FunnelQuestionnaire[]
  links: FunnelLink[]
  contact: { title: string; subtitle: string; cta: string; privacy: string }
  done: {
    emoji: string          // Symbol oben (wird von image_url ersetzt, falls gesetzt)
    image_url: string      // optionales Bild statt Emoji
    title: string
    note: string           // Hinweistext unter dem Termin
    cta: string            // Haupt-Button-Text
    thanks_url: string     // Haupt-Button-Link
    socials: FunnelSocial[]
    youtube_url?: string   // Altfeld (vor der Social-Liste) — wird nicht mehr gerendert
  }
}

export const FUNNEL_ICONS = ['steuern', 'kapital', 'auswandern', 'langfristig', 'unsicher'] as const

export const FUNNEL_HERO_DEFAULT = DECK_PHOTO.replace('/object/public/', '/render/image/public/') + '?width=1100&height=620&resize=cover&quality=78'

export const SITE_URL = 'https://portal.happy-property.com'

// Aus einem Kampagnen-Link die teilbare /termin-URL bauen. `src` setzt im Funnel
// die utm_source (= Kanal/Badge), `utm_campaign` trägt den eindeutigen Link-Code
// für die spätere Auswertung. Der Fragebogen-Modus hängt zusätzliche Parameter an.
export function buildFunnelLinkUrl(link: Pick<FunnelLink, 'code' | 'source' | 'questionnaire'>): string {
  const p = new URLSearchParams()
  if (link.source) p.set('src', link.source)
  if (link.code) p.set('utm_campaign', link.code)
  if (link.questionnaire === 'none') p.set('f', 'none')
  else if (link.questionnaire === 'buchen') p.set('buchen', '1')
  // 'direkt' = direkt zum Kalender OHNE Kontaktabfrage — nur mit persönlichem Token
  // (…&d=<deck-token>, wie beim Newsletter). Zusätzliches buchen=1 sorgt dafür,
  // dass ein Klick OHNE Token sauber auf die Terminart fällt (Kontakt danach),
  // statt in den Fragebogen.
  else if (link.questionnaire === 'direkt') { p.set('direkt', '1'); p.set('buchen', '1') }
  else if (link.questionnaire && link.questionnaire !== 'standard') p.set('f', link.questionnaire)
  const qs = p.toString()
  return qs ? `${SITE_URL}/termin?${qs}` : `${SITE_URL}/termin`
}

export const DEFAULT_FUNNEL_CONFIG: FunnelConfig = {
  questionnaires: [],
  links: [],
  welcome: {
    title: 'Dein kostenloses Beratungsgespräch mit Sven',
    subtitle: 'Beantworte 6 kurze Fragen und such dir direkt deinen Wunschtermin aus — per Zoom oder WhatsApp-Call. Dauer: 1 Minute.',
    cta: 'Los geht’s →',
    footnote: 'Kostenlos & unverbindlich · ca. 15–30 Minuten Gespräch',
    hero_url: '',   // leer = Standard-Foto (FUNNEL_HERO_DEFAULT)
  },
  questions: [
    {
      key: 'erfahrung',
      title: 'Hast du bereits Erfahrung mit Immobilieninvestitionen?',
      sub: 'Fülle den kurzen Fragebogen aus & buche dir anschließend dein kostenloses Beratungsgespräch mit Sven. Dauer: 1 Minute.',
      options: [
        { key: 'keine', label: 'Keine Erfahrung' },
        { key: 'wenig', label: 'Wenig Erfahrung (1–2 Investitionen)' },
        { key: 'erfahren', label: 'Erfahren (3+ Projekte oder Immobilien)' },
      ],
    },
    {
      key: 'motiv',
      title: 'Warum interessierst du dich für eine Immobilie in Zypern?',
      tiles: true,
      options: [
        { key: 'steuern', label: 'Steuerliche Vorteile', icon: 'steuern' },
        { key: 'kapital', label: 'Kapitalanlage', icon: 'kapital' },
        { key: 'auswandern', label: 'Auswandern & Lebensqualität', icon: 'auswandern' },
        { key: 'langfristig', label: 'Langfristige Immobilien-Investition', icon: 'langfristig' },
        { key: 'unsicher', label: 'Noch nicht sicher', icon: 'unsicher' },
      ],
    },
    {
      key: 'timing',
      title: 'Wann planst du den Kauf?',
      options: [
        { key: 'asap', label: 'So schnell wie möglich' },
        { key: '3-6m', label: 'In 3–6 Monaten' },
        { key: 'spaeter', label: 'Später' },
      ],
    },
    {
      key: 'kapitalbasis',
      title: 'Besitzt du eine abbezahlte Immobilie in Deutschland, 100.000 € Eigenkapital oder Portfolios/Sachwerte in vergleichbarer Höhe?',
      options: [
        { key: 'ja', label: 'Ja' },
        { key: 'nein', label: 'Nein' },
      ],
    },
    {
      key: 'beschaeftigung',
      title: 'Was ist dein Beschäftigungsverhältnis?',
      options: [
        { key: 'angestellt', label: 'Angestellter' },
        { key: 'privatier', label: 'Privatier' },
        { key: 'selbststaendig', label: 'Selbstständig' },
        { key: 'andere', label: 'Andere' },
      ],
    },
    {
      key: 'alter',
      title: 'Wie alt bist du?',
      options: [
        { key: 'u30', label: 'Unter 30' },
        { key: '30-45', label: '30–45 Jahre' },
        { key: 'ue45', label: 'Über 45 Jahre' },
      ],
    },
  ],
  contact: {
    title: 'Verrate uns kurz, wie du heißt und wie wir dich erreichen.',
    subtitle: 'Im Anschluss kannst du dir deinen Wunschtermin buchen!',
    cta: 'Weiter zum Wunschtermin →',
    privacy: 'Mit dem Absenden stimmst du zu, dass wir dich zur Terminabstimmung per E-Mail und WhatsApp kontaktieren. Kostenlos & unverbindlich.',
  },
  done: {
    emoji: '🎉',
    image_url: '',
    title: 'Dein Termin steht!',
    note: 'Die Bestätigung ist per E-Mail und WhatsApp unterwegs — inklusive Kalender-Datei.',
    cta: 'Bis dahin: Tipps, Blog & Videos →',
    thanks_url: 'https://steuervorteil-zypern-immobilien.com/termin-wurde-bestaetigt/',
    socials: [
      ...DECK_CONTACT.socials.map(s => ({ icon: s.icon, label: s.platform, url: s.url })),
      { icon: '✍', label: 'Blog', url: 'https://steuervorteil-zypern-immobilien.com/blog/' },
    ],
  },
}

// Sanfte Normalisierung: fehlende Teile aus den Defaults ergänzen, damit ein
// unvollständig gespeicherter Editor-Stand den öffentlichen Funnel nie bricht.
export function normalizeFunnelConfig(raw: unknown): FunnelConfig {
  const r = (raw ?? {}) as Partial<FunnelConfig>
  const d = DEFAULT_FUNNEL_CONFIG
  const cleanQuestions = (qs: unknown): FunnelQuestion[] => Array.isArray(qs)
    ? (qs as FunnelQuestion[])
        .filter(q => q && typeof q.key === 'string' && typeof q.title === 'string' && Array.isArray(q.options))
        .map(q => ({ ...q, options: q.options.filter(o => o && typeof o.key === 'string' && typeof o.label === 'string') }))
        .filter(q => q.options.length >= 2)
    : []
  const questions = cleanQuestions(r.questions)
  // Varianten-Fragebögen: leere Varianten (0 gültige Fragen) fliegen raus —
  // ein Link darauf fällt dann im Funnel auf den Standard zurück.
  const questionnaires = Array.isArray(r.questionnaires)
    ? r.questionnaires
        .filter(x => x && typeof x.slug === 'string' && x.slug.trim() && x.slug !== 'none' && typeof x.name === 'string')
        .map(x => ({ slug: x.slug.trim(), name: x.name, questions: cleanQuestions(x.questions) }))
        .filter(x => x.questions.length > 0)
    : []
  // Kampagnen-/Quellen-Links: code + name Pflicht, source/questionnaire tolerant.
  const cleanKey = (v: unknown, max: number) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max)
  const links = Array.isArray(r.links)
    ? r.links
        .filter(x => x && typeof x.code === 'string' && typeof x.name === 'string')
        .map(x => ({
          code: cleanKey(x.code, 40),
          name: String(x.name).trim().slice(0, 80),
          source: cleanKey(x.source, 40),
          questionnaire: typeof x.questionnaire === 'string' && x.questionnaire.trim() ? x.questionnaire.trim() : 'standard',
          created_at: typeof x.created_at === 'string' ? x.created_at : undefined,
        }))
        .filter(x => x.code && x.name)
    : []
  const doneRaw = (r.done ?? {}) as Partial<FunnelConfig['done']>
  const socials = Array.isArray(doneRaw.socials)
    ? doneRaw.socials.filter(s => s && typeof s.label === 'string' && typeof s.url === 'string' && s.label.trim() && s.url.trim())
    : d.done.socials
  return {
    welcome: { ...d.welcome, ...(r.welcome ?? {}) },
    questions: questions.length ? questions : d.questions,
    questionnaires,
    links,
    contact: { ...d.contact, ...(r.contact ?? {}) },
    done: { ...d.done, ...doneRaw, socials },
  }
}

export async function loadFunnelConfig(): Promise<FunnelConfig> {
  try {
    const { data, error } = await supabase.from('funnel_config').select('config').eq('id', 'default').maybeSingle()
    if (error) throw error
    return normalizeFunnelConfig((data as { config?: unknown } | null)?.config)
  } catch (err) {
    console.warn('[funnelConfig] Laden fehlgeschlagen — nutze Defaults:', err)
    return DEFAULT_FUNNEL_CONFIG
  }
}
