// Ordner im Downloadbereich der Eigentümer (owner_documents.category).
// Reihenfolge = Anzeige-Reihenfolge im Portal. Die Werte stehen auch im
// Check-Constraint der Tabelle (Migration 20261003100000).
export interface OwnerDocFolder { key: string; icon: string; de: string; en: string; hintDe: string; hintEn: string }

export const OWNER_DOC_FOLDERS: OwnerDocFolder[] = [
  { key: 'monatsbericht', icon: '📊', de: 'Monatsberichte', en: 'Monthly reports', hintDe: 'Der Zypern-Report, jeden Monat neu', hintEn: 'The Cyprus report, new every month' },
  { key: 'wohnung', icon: '🏠', de: 'Deine Wohnung', en: 'Your apartment', hintDe: 'Baufortschritt, Verträge, Übergabe', hintEn: 'Construction progress, contracts, handover' },
  { key: 'steuer', icon: '🧾', de: 'Steuer', en: 'Tax', hintDe: 'Steuerguides und Unterlagen für deinen Steuerberater', hintEn: 'Tax guides and documents for your tax advisor' },
  { key: 'vermietung', icon: '🔑', de: 'Vermietung & Verwaltung', en: 'Rental & management', hintDe: 'Alles rund um Mieter, Verwaltung und Nebenkosten', hintEn: 'Tenants, management and running costs' },
  { key: 'ratgeber', icon: '📘', de: 'Ratgeber & Videos', en: 'Guides & videos', hintDe: 'Wissen rund um Zypern und deine Immobilie', hintEn: 'Know-how about Cyprus and your property' },
  { key: 'sonstiges', icon: '📁', de: 'Sonstiges', en: 'Other', hintDe: 'Alles andere', hintEn: 'Everything else' },
]

export const folderOf = (key: string | null | undefined): OwnerDocFolder =>
  OWNER_DOC_FOLDERS.find(f => f.key === key) ?? OWNER_DOC_FOLDERS[OWNER_DOC_FOLDERS.length - 1]
