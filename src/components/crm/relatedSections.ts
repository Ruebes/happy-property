// Macht aus der Antwort von hp_lead_related die Gruppen der Karte "Gehört dazu":
// je Gruppe die Zahl und die Chips (Art, Id, Text, Link-Angaben). Reine Funktion
// ohne React, damit die Karte selbst nur noch zeichnet.
import type { TFunction } from 'i18next'
import type { EntityKind, EntityLinkOpts } from '../../lib/entityLinks'
import { RELATED_GROUPS, type LeadRelated, type RelatedGroupKey } from '../../lib/relatedTypes'
import type { IconId } from '../shell/Icon'

export interface RelatedChip {
  key: string
  kind: EntityKind
  // null: reiner Text (Zusammenfassung oder kein Ziel)
  id: string | null
  label: string
  opts?: EntityLinkOpts
  icon?: IconId
}

export interface RelatedSection {
  key: RelatedGroupKey
  count: number
  chips: RelatedChip[]
  // true: je Eintrag ein Chip (dann gilt "alle N anzeigen"); false: Zusammenfassung
  listed: boolean
}

export interface RelatedFormatters {
  date: (value: string) => string
  dateTime: (value: string) => string
  money: (amount: number, currency: string | null) => string
}

type Part = string | null | undefined | false
const filled = (parts: Part[]): string[] =>
  parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '')
// Angaben mit Mittelpunkt trennen ("Titel · bis 02.10.")
const join = (...parts: Part[]): string => filled(parts).join(' · ')
// Namensteile mit Leerzeichen ("Olive Garden A-204")
const name = (...parts: Part[]): string => filled(parts).join(' ')

export function buildRelatedSections(
  data: LeadRelated,
  t: TFunction,
  fmt: RelatedFormatters,
  exclude: readonly string[] = [],
): RelatedSection[] {
  const leadId = data.lead_id
  const phase = (value: string | null): string =>
    value ? t(`crm.phases.${value}`, { defaultValue: value }) : t('related.deal.unknownPhase')
  const sections: Partial<Record<RelatedGroupKey, RelatedSection>> = {}
  const put = (key: RelatedGroupKey, count: number, chips: RelatedChip[], listed: boolean) => {
    if (count > 0 && chips.length > 0) sections[key] = { key, count, chips, listed }
  }

  if (data.deals) {
    put('deals', data.deals.count, data.deals.items.map(deal => ({
      key: deal.id,
      kind: 'deal',
      id: deal.id,
      label: deal.archived
        ? (deal.archived_from_phase ? t('related.deal.archived', { phase: phase(deal.archived_from_phase) }) : t('related.deal.archivedPlain'))
        : phase(deal.phase),
      opts: { leadId, archived: deal.archived === true },
    })), true)
  }

  const units = data.units?.items ?? []
  if (data.units) {
    put('units', data.units.count, units.map(unit => ({
      key: unit.id,
      kind: 'unit',
      id: unit.id,
      label: join(
        name(unit.project_name, unit.unit_number) || t('related.unit.unnamed'),
        unit.via.includes('owner') ? t('related.via.owner') : unit.via.includes('co_owner') ? t('related.via.co_owner') : null,
      ),
      opts: { projectId: unit.project_id, leadId },
    })), true)
  }

  if (data.properties) {
    put('properties', data.properties.count, data.properties.items.map(property => {
      // Für Mitarbeiter ohne Objektseite: Ausweichziel ist die Wohnung im Projekt
      const unit = units.find(item => item.property_id === property.id)
      return {
        key: property.id,
        kind: 'property',
        id: property.id,
        label: join(
          name(property.project_name, property.unit_number) || t('related.property.unnamed'),
          property.role === 'co_owner' ? t('related.via.co_owner') : null,
        ),
        opts: { unitId: unit?.id ?? null, projectId: unit?.project_id ?? null, leadId },
      }
    }), true)
  }

  if (data.tasks) {
    put('tasks', data.tasks.count, data.tasks.items.map(task => ({
      key: task.id,
      kind: 'task',
      id: task.id,
      label: join(
        task.title || t('related.task.untitled'),
        task.status === 'erledigt' ? t('related.task.done') : task.due_date ? t('related.task.due', { date: fmt.date(task.due_date) }) : null,
      ),
    })), true)
  }

  if (data.appointments) {
    put('appointments', data.appointments.count, data.appointments.items.map(appointment => ({
      key: appointment.id,
      kind: 'appointment',
      id: appointment.id,
      label: join(
        appointment.start_time ? fmt.dateTime(appointment.start_time) : null,
        appointment.title || t('related.appointment.untitled'),
        appointment.internal ? t('related.appointment.internal') : null,
      ),
      opts: { leadId },
    })), true)
  }

  if (data.decks) {
    put('decks', data.decks.count, data.decks.items.map(deck => ({
      key: deck.id,
      kind: 'deck',
      id: deck.id,
      label: join(deck.project_name || t('links.kind.deck'), fmt.date(deck.created_at)),
      opts: { token: deck.token },
    })), true)
  }

  if (data.calculations) {
    put('calculations', data.calculations.count, data.calculations.items.map(calculation => ({
      key: calculation.id,
      kind: 'calculation',
      id: calculation.id,
      label: join(calculation.title || t('links.kind.calculation'), fmt.date(calculation.created_at)),
      opts: { token: calculation.token },
    })), true)
  }

  if (data.strategy) {
    put('strategy', data.strategy.count, data.strategy.items.map(scenario => ({
      key: scenario.id,
      kind: 'strategy',
      id: scenario.id,
      label: join(scenario.title || t('links.kind.strategy'), scenario.updated_at ? fmt.date(scenario.updated_at) : null),
      opts: { token: scenario.token },
    })), true)
  }

  if (data.invoices) {
    put('invoices', data.invoices.count, data.invoices.items.map(invoice => ({
      key: invoice.id,
      kind: 'invoice',
      id: invoice.id,
      label: join(
        invoice.invoice_number || t('links.kind.invoice'),
        typeof invoice.total === 'number' ? fmt.money(invoice.total, invoice.currency) : null,
      ),
    })), true)
  }

  if (data.registrations) {
    put('registrations', data.registrations.count, data.registrations.items.map(registration => ({
      key: registration.id,
      kind: 'project',
      id: null,
      icon: 'developers',
      label: join(
        registration.developer || t('related.registration.unnamed'),
        fmt.date(registration.registered_at ?? registration.created_at),
      ),
    })), true)
  }

  // Ab hier Zusammenfassungen: ein Chip je Gruppe, nur Anzahlen und Status
  if (data.documents && data.documents.count > 0) {
    put('documents', data.documents.count, [{
      key: 'documents',
      kind: 'document',
      id: null,
      label: t('related.documents.summary', { count: data.documents.count }),
    }], false)
  }

  if (data.payments && data.payments.count > 0) {
    put('payments', data.payments.count, [{
      key: 'payments',
      kind: 'invoice',
      id: null,
      icon: 'finance',
      label: join(
        t('related.payments.summary', { count: data.payments.count }),
        data.payments.open > 0 ? t('related.payments.open', { count: data.payments.open }) : null,
      ),
    }], false)
  }

  if (data.newsletter) {
    const subscriber = data.newsletter.items[0]
    const optout = subscriber?.optout_at ?? data.newsletter.lead_optout_at
    const known = data.newsletter.count > 0 || data.newsletter.lead_optout_at !== null
    if (known) {
      put('newsletter', Math.max(1, data.newsletter.count), [{
        key: 'newsletter',
        kind: 'newsletter',
        id: subscriber?.id ?? null,
        label: optout ? t('related.newsletter.optout', { date: fmt.date(optout) }) : t('related.newsletter.subscribed'),
      }], false)
    }
  }

  const portal = data.portal
  if (portal.has_access) {
    put('portal', 1, [{
      key: 'portal',
      kind: 'owner',
      // Ohne leadId: für alle außer Admin bleibt es reiner Text (kein Link auf
      // die Kundenseite, auf der die Karte ohnehin steht)
      id: portal.profile_id,
      label: join(
        t('related.portal.active'),
        portal.last_login_at
          ? t('related.portal.lastLogin', { date: fmt.date(portal.last_login_at) })
          : portal.login_count === 0 ? t('related.portal.neverLoggedIn') : null,
      ),
    }], false)
  } else if (portal.access_sent_at) {
    put('portal', 1, [{
      key: 'portal',
      kind: 'owner',
      id: null,
      label: t('related.portal.sent', { date: fmt.date(portal.access_sent_at) }),
    }], false)
  }

  if (data.reviews && data.reviews.count > 0) {
    const status = data.reviews.last_status
    put('reviews', data.reviews.count, [{
      key: 'reviews',
      kind: 'review',
      id: null,
      label: join(
        t('related.reviews.summary', { count: data.reviews.count }),
        status ? t(`related.reviews.status.${status}`, { defaultValue: status }) : null,
      ),
    }], false)
  }

  if (data.affiliate?.is_affiliate) {
    put('affiliate', 1, [{
      key: 'affiliate',
      kind: 'affiliate',
      id: null,
      label: join(
        t('related.affiliate.isAffiliate'),
        data.affiliate.referred_count > 0 ? t('related.affiliate.referred', { count: data.affiliate.referred_count }) : null,
        data.affiliate.payout_count > 0 ? t('related.affiliate.payouts', { count: data.affiliate.payout_count }) : null,
      ),
    }], false)
  }

  if (data.drive && data.drive.count > 0) {
    put('drive', data.drive.count, [{
      key: 'drive',
      kind: 'document',
      id: null,
      icon: 'drive',
      label: t('related.drive.files', { count: data.drive.count }),
    }], false)
  }

  return RELATED_GROUPS
    .filter(key => !exclude.includes(key))
    .flatMap(key => {
      const section = sections[key]
      return section ? [section] : []
    })
}
