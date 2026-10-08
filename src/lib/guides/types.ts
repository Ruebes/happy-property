// Erklaertexte unter den Tabellen der Kundenseite (Sven 8.10.26: „unter jede
// Tabelle einen ausfuehrlichen Text, was die Tabelle zeigt und was es
// bedeutet, so dass jeder versteht, was das ist").
//
// Feste Texte stehen in den Sprachdateien unter strategie.guide.<id>, die
// Beispiele und Bedeutungs-Saetze rechnet der Code aus den Zahlen DIESER
// Kundenseite (dieselben gerundeten Werte, die in der Tabelle stehen).
import type { TFunction } from 'i18next'
import type { CustomerAnalytics } from '../analytics'
import type { SimParams } from '../strategy'

export interface GuideItem { label: string; text: string }

export interface Guide {
  heading: string
  intro: string
  items: GuideItem[]
  example: string | null
  meaning: string[]
  pitfalls: string[]
}

export interface GuideCtx {
  a: CustomerAnalytics
  params: SimParams
  t: TFunction
}

// Gleiche Formatierung wie auf der Seite (Strategie.tsx)
export const eur = (n: number | null | undefined) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(n))
export const num = (n: number) => String(n).replace('.', ',')
export const mmYYYY = (ym: number) => `${String(ym % 12 + 1).padStart(2, '0')}/${Math.floor(ym / 12)}`

// Liest die festen Texte eines Erklaerblocks. items: Schluessel in der
// gewuenschten Reihenfolge (nur die, die auf der Seite gerade sichtbar sind).
export function staticGuide(ctx: GuideCtx, id: string, items: string[], pitfalls: string[]): Omit<Guide, 'example' | 'meaning'> {
  const { t } = ctx
  const base = `strategie.guide.${id}`
  return {
    heading: t(`${base}.heading`),
    intro: t(`${base}.intro`),
    items: items.map(k => ({ label: t(`${base}.items.${k}.label`), text: t(`${base}.items.${k}.text`) })),
    pitfalls: pitfalls.map(k => t(`${base}.pitfalls.${k}`)),
  }
}
