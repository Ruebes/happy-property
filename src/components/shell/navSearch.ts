// Seitensuche über die Navigations-Registry: reine Funktionen, genutzt vom
// Mehr-Blatt (Filterfeld) und von der CommandPalette.
import { NAV_ENTRIES, NAV_GROUPS, canSee, type NavEntry } from '../../lib/navigation'
import type { Profile } from '../../lib/permissions'

// Klein, ohne Akzente, ß als ss: "Eigentümer" findet man auch mit "eigentumer".
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .trim()
}

export function tokenize(query: string): string[] {
  return normalizeText(query).split(/\s+/).filter(Boolean)
}

// Seiten, die dieses Profil per Suche öffnen darf. Detailseiten (':id') und
// Aliasse fallen weg; alte Seiten (hidden 'legacy') sind nur über die Suche
// erreichbar und deshalb dabei.
export function searchableEntries(profile: Profile): NavEntry[] {
  return NAV_ENTRIES.filter(e =>
    canSee(profile, e) && !e.path.includes(':') && e.hidden !== 'alias' && e.hidden !== 'detail')
}

export function groupLabelKey(entry: NavEntry): string {
  return NAV_GROUPS.find(g => g.id === entry.group)?.labelKey ?? ''
}

function groupOrder(entry: NavEntry): number {
  return NAV_GROUPS.find(g => g.id === entry.group)?.order ?? 99
}

// Treffer-Güte eines Eintrags: 0 = kein Treffer, höher = besser. Jedes Suchwort
// muss irgendwo vorkommen (Name, Gruppe, Stichwörter, Pfad).
export function scoreEntry(tokens: readonly string[], label: string, groupLabel: string, entry: NavEntry): number {
  if (tokens.length === 0) return 1
  const name = normalizeText(label)
  const nameWords = name.split(/[\s-]+/)
  const extras = [groupLabel, ...(entry.keywords ?? []), entry.path.replace(/[/:-]/g, ' ')].map(normalizeText)
  const extraWords = extras.flatMap(x => x.split(/\s+/))
  let score = 0
  for (const token of tokens) {
    if (name.startsWith(token)) score += 100
    else if (nameWords.some(w => w.startsWith(token))) score += 60
    else if (name.includes(token)) score += 40
    else if (extraWords.some(w => w.startsWith(token))) score += 20
    else if (extras.some(x => x.includes(token))) score += 10
    else return 0
  }
  return score
}

export interface PageHit {
  entry: NavEntry
  label: string
  groupLabel: string
  score: number
}

// Gefilterte und sortierte Seitenliste. Ohne Suchwort: alle Menüseiten in
// Menü-Reihenfolge (ohne die alten Seiten).
export function searchPages(profile: Profile, query: string, translate: (key: string) => string): PageHit[] {
  const tokens = tokenize(query)
  const hits: PageHit[] = []
  for (const entry of searchableEntries(profile)) {
    if (tokens.length === 0 && entry.hidden) continue
    const label = translate(entry.labelKey)
    const groupLabel = translate(groupLabelKey(entry))
    const score = scoreEntry(tokens, label, groupLabel, entry)
    if (score > 0) hits.push({ entry, label, groupLabel, score })
  }
  return hits.sort((a, b) =>
    b.score - a.score ||
    groupOrder(a.entry) - groupOrder(b.entry) ||
    a.entry.order - b.entry.order)
}
