// Sales-Deck-Inhalt: eine geordnete Liste typisierter Blöcke. Die KI wählt/ordnet
// die Blöcke pro Kunde & Wohnung; die Render-Seite zeichnet sie der Reihe nach.

export interface DeckPaymentRow { label: string; sub?: string; value: string }
export interface DeckPaymentPhase {
  label?: string
  title?: string
  rows?: DeckPaymentRow[]
  sumLabel?: string
  sumValue?: string
  advantage?: string
}

export type DeckBlock =
  | { type: 'cover';   kicker?: string; title: string; tagline?: string; forLine?: string; image?: string }
  | { type: 'letter';  kicker?: string; headline?: string; paragraphs: string[]; signoff?: string; signName?: string }
  | { type: 'unit';    kicker?: string; number?: string; nickname?: string; specs?: string[]; priceMain?: string; priceSub?: string; note?: string; image?: string }
  | { type: 'facts';   kicker?: string; headline?: string; items?: { min: string; label: string }[]; image?: string; mapUrl?: string; mapLabel?: string }
  | { type: 'columns'; kicker?: string; headline?: string; image?: string; cols?: { title: string; sub?: string; text: string }[] }
  | { type: 'feature'; kicker?: string; headline?: string; image?: string; text?: string; quote?: string }
  | { type: 'gallery'; kicker?: string; headline?: string; items?: { image?: string; title?: string; caption?: string }[]; note?: string }
  | { type: 'benefits';kicker?: string; headline?: string; cards?: { icon?: string; title: string; text: string }[] }
  | { type: 'inventory';kicker?: string; headline?: string; intro?: string; image?: string; groups?: { title: string; icon?: string; items: string[] }[]; note?: string }
  | { type: 'floorplan';kicker?: string; headline?: string; image?: string; stats?: { value: string; unit?: string; label: string }[]; bullets?: { strong?: string; text: string }[] }
  | { type: 'payment'; kicker?: string; headline?: string; intro?: string; phase1?: DeckPaymentPhase; phase2?: DeckPaymentPhase; note?: string }
  | { type: 'cta';     kicker?: string; headline?: string; text?: string; steps?: { n: string; title: string; text: string }[] }

export interface DeckContent {
  theme?:  'auto'            // reserviert für spätere Varianten
  blocks:  DeckBlock[]
}

// Happy-Property-Logo (dunkle Variante, passt zur Deck-Optik) + Svens Foto.
export const DECK_LOGO  = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
export const DECK_PHOTO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg'

// Statischer Kontaktblock (Happy Property / Sven) — erscheint im CTA-Footer.
export const DECK_CONTACT = {
  name:    'Sven Rüprich',
  company: 'Happy Property Cyprus',
  phone:   '+357 95 09 64 09',
  email:   'sven@happy-property.com',
  web:     'happy-property.com',
  address: 'Pallados 1, 8046 Paphos',
  socials: [
    { icon: '▶',  platform: 'YouTube',   handle: 'HappyPropertyCyprus',  url: 'https://www.youtube.com/@HappyPropertyCyprus' },
    { icon: '◎',  platform: 'Instagram', handle: 'happy_property_cyprus', url: 'https://www.instagram.com/happy_property_cyprus' },
    { icon: 'f',  platform: 'Facebook',  handle: 'Immobilien in Zypern',  url: '' },
    { icon: 'in', platform: 'LinkedIn',  handle: 'Sven Rüprich',          url: '' },
  ],
} as const
