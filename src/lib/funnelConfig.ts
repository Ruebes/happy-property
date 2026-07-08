import { supabase } from './supabase'
import { DECK_PHOTO } from './deckTypes'

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

export interface FunnelConfig {
  welcome: { title: string; subtitle: string; cta: string; footnote: string; hero_url: string }
  questions: FunnelQuestion[]
  contact: { title: string; subtitle: string; cta: string; privacy: string }
  done: { title: string; thanks_url: string; youtube_url: string }
}

export const FUNNEL_ICONS = ['steuern', 'kapital', 'auswandern', 'langfristig', 'unsicher'] as const

export const FUNNEL_HERO_DEFAULT = DECK_PHOTO.replace('/object/public/', '/render/image/public/') + '?width=1100&height=620&resize=cover&quality=78'

export const DEFAULT_FUNNEL_CONFIG: FunnelConfig = {
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
    title: 'Dein Termin steht!',
    thanks_url: 'https://steuervorteil-zypern-immobilien.com/termin-wurde-bestaetigt/',
    youtube_url: 'https://www.youtube.com/@HappyPropertyCyprus',
  },
}

// Sanfte Normalisierung: fehlende Teile aus den Defaults ergänzen, damit ein
// unvollständig gespeicherter Editor-Stand den öffentlichen Funnel nie bricht.
export function normalizeFunnelConfig(raw: unknown): FunnelConfig {
  const r = (raw ?? {}) as Partial<FunnelConfig>
  const d = DEFAULT_FUNNEL_CONFIG
  const questions = Array.isArray(r.questions) && r.questions.length
    ? r.questions
        .filter(q => q && typeof q.key === 'string' && typeof q.title === 'string' && Array.isArray(q.options))
        .map(q => ({ ...q, options: q.options.filter(o => o && typeof o.key === 'string' && typeof o.label === 'string') }))
        .filter(q => q.options.length >= 2)
    : d.questions
  return {
    welcome: { ...d.welcome, ...(r.welcome ?? {}) },
    questions: questions.length ? questions : d.questions,
    contact: { ...d.contact, ...(r.contact ?? {}) },
    done: { ...d.done, ...(r.done ?? {}) },
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
