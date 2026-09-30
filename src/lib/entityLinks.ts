// Querverweise zwischen Datensätzen: wohin führt ein Klick auf einen Kunden,
// eine Wohnung, eine Aufgabe ...? Reines TypeScript ohne React und ohne
// Supabase, damit scripts/verify-entity-links.mjs die Datei in Node laden kann.
//
// entityPath() liefert das Ziel oder null, wenn der Betrachter das Ziel nicht
// öffnen darf (dann zeigt der Aufrufer reinen Text statt eines Links). Die
// Regeln spiegeln die Routen-Guards in src/App.tsx und hasPerm aus
// permissions.ts; `npm run verify:links` hält beides deckungsgleich.
import { hasPerm, type PermissionArea, type Profile } from './permissions'

export type EntityKind =
  | 'lead' | 'deal' | 'project' | 'unit' | 'property' | 'owner' | 'task' | 'appointment'
  | 'invoice' | 'deck' | 'calculation' | 'strategy' | 'review' | 'affiliate' | 'newsletter'
  | 'document' | 'booking' | 'inbox'

export const ENTITY_KINDS: readonly EntityKind[] = [
  'lead', 'deal', 'project', 'unit', 'property', 'owner', 'task', 'appointment',
  'invoice', 'deck', 'calculation', 'strategy', 'review', 'affiliate', 'newsletter',
  'document', 'booking', 'inbox',
]

export interface EntityLinkOpts {
  leadId?: string | null
  projectId?: string | null
  unitId?: string | null
  // Öffentlicher Token für deck, calculation, strategy
  token?: string | null
  // Nur für deal: archivierte Vorgänge öffnen im Archiv
  archived?: boolean
  // Reiter der Zielseite (?tab=), nur wenn das Ziel die eigene Seite der Art ist
  tab?: string
}

export interface EntityTarget {
  to: string
  // Öffentliche Token-Seite: in neuem Tab öffnen
  external?: boolean
  // Gesetzt, wenn das Ziel die Seite einer ANDEREN Art ist (Ausweichziel),
  // z.B. eine Wohnung, die auf der Projektseite geöffnet wird
  via?: EntityKind
}

export type EntityViewer = Pick<Profile, 'role' | 'permissions'> | null

// hasPerm liest nur role und permissions; die übrigen Felder sind Platzhalter,
// damit die eine Rechte-Regel aus permissions.ts ohne Typ-Trick gilt.
function can(viewer: EntityViewer, area: PermissionArea): boolean {
  if (!viewer) return false
  return hasPerm({
    id: '', email: '', full_name: '', phone: null, language: 'de', verwaltung_id: null,
    role: viewer.role, permissions: viewer.permissions ?? {},
  }, area)
}

const seg = (value: string): string => encodeURIComponent(value)

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
  return query ? `${path}?${query}` : path
}

// Kundenseite. Die Route ließe Mitarbeiter auch mit dem Recht 'contacts' durch
// (anyPermission pipeline/contacts), die Tabelle leads gibt per RLS aber nur
// mit 'pipeline' Zeilen her: mit 'contacts' allein bliebe die Seite leer.
// Deshalb verlinken wir nur bei 'pipeline'.
function leadTarget(leadId: string | null | undefined, viewer: EntityViewer, tab?: string): EntityTarget | null {
  if (!leadId || !can(viewer, 'pipeline')) return null
  return { to: withQuery(`/admin/crm/leads/${seg(leadId)}`, { tab }) }
}

function projectTarget(projectId: string | null | undefined, viewer: EntityViewer, tab?: string): EntityTarget | null {
  if (!projectId || !can(viewer, 'pipeline')) return null
  return { to: withQuery(`/admin/crm/projects/${seg(projectId)}`, { tab }) }
}

// Eine Wohnung hat keine eigene Seite: sie öffnet auf der Projektseite (?unit=).
// Ohne Wohnungs-Id bleibt die Projektseite, ohne Projekt gibt es kein Ziel.
function unitTarget(unitId: string | null | undefined, projectId: string | null | undefined, viewer: EntityViewer, tab?: string): EntityTarget | null {
  if (!projectId || !can(viewer, 'pipeline')) return null
  return { to: withQuery(`/admin/crm/projects/${seg(projectId)}`, { unit: unitId || null, tab }), via: 'project' }
}

// Markiert ein Ausweichziel mit der Art, über die es erreicht wird.
function via(target: EntityTarget | null, kind: EntityKind): EntityTarget | null {
  return target ? { ...target, via: kind } : null
}

const TOKEN_PREFIX: Record<'deck' | 'calculation' | 'strategy', string> = {
  deck: '/deck/',
  calculation: '/rechnung/',
  strategy: '/strategie/',
}

export function entityPath(
  kind: EntityKind,
  id: string,
  opts: EntityLinkOpts | undefined,
  viewer: EntityViewer,
): EntityTarget | null {
  if (!viewer) return null
  const o = opts ?? {}
  const role = viewer.role
  const isStaff = role === 'admin' || role === 'verwalter' || role === 'mitarbeiter'
  const leadFallback = () => via(leadTarget(o.leadId, viewer), 'lead')

  switch (kind) {
    case 'lead':
      return id ? leadTarget(id, viewer, o.tab) : null

    case 'deal':
      // Aktive Vorgänge haben keine eigene Seite: sie leben auf der Kundenseite.
      if (!can(viewer, 'pipeline')) return null
      if (o.archived && id) return { to: withQuery('/admin/crm/archived', { open: id }) }
      return leadFallback()

    case 'project':
      return id ? projectTarget(id, viewer, o.tab) : null

    case 'unit':
      return unitTarget(id, o.projectId, viewer, o.tab)

    case 'property':
      if (id && role === 'admin') return { to: withQuery(`/admin/properties/${seg(id)}`, { tab: o.tab }) }
      if (id && role === 'verwalter') return { to: withQuery(`/verwalter/properties/${seg(id)}`, { tab: o.tab }) }
      if (id && role === 'eigentuemer') return { to: withQuery(`/eigentuemer/properties/${seg(id)}`, { tab: o.tab }) }
      // Mitarbeiter haben keine Objektseite: Wohnung im Projekt, sonst der Kunde
      if (role === 'mitarbeiter') {
        const unit = o.unitId ? unitTarget(o.unitId, o.projectId, viewer) : null
        return unit ? { ...unit, via: 'unit' } : leadFallback()
      }
      return null

    case 'owner':
      if (id && role === 'admin') return { to: withQuery('/admin/users', { open: id }) }
      return leadFallback()

    case 'task':
      return id && isStaff ? { to: withQuery('/admin/crm/tasks', { task: id }) } : null

    case 'appointment':
      if (id && can(viewer, 'pipeline')) return { to: withQuery('/admin/crm/calendar', { open: id }) }
      return leadFallback()

    case 'invoice':
      return id && can(viewer, 'invoices') ? { to: withQuery('/admin/crm/invoices', { open: id }) } : null

    case 'deck':
    case 'calculation':
    case 'strategy':
      // Öffentliche Token-Seiten; verlinkt wird nur für Mitarbeitende, und nur
      // mit Token (die Zeilen-Id allein öffnet nichts).
      return isStaff && o.token ? { to: `${TOKEN_PREFIX[kind]}${seg(o.token)}`, external: true } : null

    case 'review':
      if (id && role === 'admin') return { to: withQuery('/admin/crm/reviews', { open: id }) }
      return leadFallback()

    case 'affiliate':
      if (id && role === 'admin') return { to: withQuery('/admin/crm/affiliates', { open: id }) }
      return leadFallback()

    case 'newsletter':
      // Wie der Routen-Guard: Rolle 'funnel' immer, Mitarbeiter mit Recht 'funnel'
      return role === 'funnel' || can(viewer, 'funnel') ? { to: '/admin/crm/newsletter' } : null

    case 'inbox':
      return id && can(viewer, 'pipeline') ? { to: withQuery('/admin/crm/inbox', { lead: id }) } : null

    case 'document':
    case 'booking':
      // Noch keine Detailseite
      return null
  }
}
