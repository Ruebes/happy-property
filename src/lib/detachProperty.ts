import { supabase } from './supabase'

/**
 * Trennt ein Portal-Objekt (properties) vom Kunden. Eine Stelle für alle drei
 * Einstiege (Kundenakte im CRM, Eigentümer-Verwaltung, Immobilien-Detail):
 *
 *  1. Wohnung im Projekt freigeben (crm_project_units.property_id = NULL)
 *     → sie ist wieder „anbietbar" (siehe project_unit_availability).
 *  2. Deal-Zuordnungen aufheben (deals.unit_id + property_id = NULL), sonst legt
 *     create-eigentuemer-access beim nächsten Zugangs-/Passwort-Versand das Objekt
 *     still wieder an.
 *  3. Portal-Objekt löschen. Per Cascade fallen Portal-Dokumente, Mietverträge,
 *     Einnahmen, Buchungen und Mit-Eigentümer. Unit-Dokumente (Kaufvertrag etc.)
 *     hängen an der Wohnung im Projekt und bleiben erhalten.
 *  4. Vermerk in der Kundenhistorie.
 */
export interface DetachOptions {
  /** Wer trennt (profiles.id) – für den Aktivitätseintrag. */
  actorId?: string | null
  /** Zusätzliche Unit, die sicher freigegeben werden soll (z.B. deal.unit_id). */
  unitId?: string | null
  /** Bekannter Lead, falls kein Deal auf das Objekt zeigt. */
  leadId?: string | null
  /** Deal des Leads, von dem getrennt wird (für die Fremd-Eigentümer-Prüfung). */
  dealId?: string | null
}

export interface DetachResult {
  label: string
  unitIds: string[]
  dealIds: string[]
  /** true = Objekt gehört einem anderen Kunden: nur die Zuordnung dieses Leads wurde gelöst. */
  keptForeignOwner?: boolean
}

// ── Regeln der Kette CRM → Eigentümer-Portal ──────────────────────────────────

/**
 * Entscheidung Sven 29.9.2026: Eine Wohnung erscheint im Eigentümer-Portal erst ab
 * Deal-Phase Reservierung (Reservierung, Kaufvertrag, Anzahlung, Provision erhalten;
 * archiviert nur, wenn aus „Provision erhalten" archiviert). Gleiche Regel wie
 * hp_deal_in_portal() in der Datenbank.
 */
export const PORTAL_PHASES: readonly string[] = ['reservierung', 'kaufvertrag', 'anzahlung', 'provision_erhalten']

export function dealInPortal(d: { phase?: string | null; archived_from_phase?: string | null } | null | undefined): boolean {
  if (!d?.phase) return false
  if (PORTAL_PHASES.includes(d.phase)) return true
  return d.phase === 'archiviert' && d.archived_from_phase === 'provision_erhalten'
}

/**
 * property_id einer Wohnung frisch aus der DB. Der DB-Trigger legt beim Deal-Update
 * evtl. schon ein Portal-Objekt an; ein veraltetes Objekt im Speicher würde sonst
 * ein zweites anlegen. Bei Lesefehler: Wert aus dem Speicher.
 */
export async function fetchUnitPropertyId(unitId: string, fallback: string | null | undefined): Promise<string | null> {
  const { data, error } = await supabase
    .from('crm_project_units')
    .select('property_id')
    .eq('id', unitId)
    .maybeSingle()
  if (error || !data) return fallback ?? null
  return (data as { property_id: string | null }).property_id ?? null
}

/**
 * Alle Profile, die zu einem Lead gehören: leads.profile_id plus Profil mit gleicher E-Mail.
 * includeAltEmails: auch Profile zu leads.alt_emails (Kunde schreibt/hat sein Konto unter
 * einer zweiten Adresse, z.B. Lead rw@…, Konto rainer.wallmeyer@…) — wie create-eigentuemer-access.
 */
export async function leadProfileIds(leadId: string, opts: { includeAltEmails?: boolean } = {}): Promise<string[]> {
  const { data: lead } = await supabase
    .from('leads')
    .select(opts.includeAltEmails ? 'profile_id, email, alt_emails' : 'profile_id, email')
    .eq('id', leadId)
    .maybeSingle()
  const l = lead as { profile_id: string | null; email: string | null; alt_emails?: string[] | null } | null
  const ids = new Set<string>()
  if (l?.profile_id) ids.add(l.profile_id)
  const emails = new Set<string>()
  for (const raw of [l?.email, ...(opts.includeAltEmails ? (l?.alt_emails ?? []) : [])]) {
    const email = raw?.trim()
    if (email) { emails.add(email); emails.add(email.toLowerCase()) }
  }
  if (emails.size) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('id')
      .in('email', Array.from(emails))
    for (const r of (profs ?? []) as Array<{ id: string }>) ids.add(r.id)
  }
  return Array.from(ids)
}

/**
 * Gehört das Portal-Objekt einem anderen Kunden? Nein, wenn kein Eigentümer gesetzt
 * ist, der Eigentümer eines der Profile ist oder eines davon Mit-Eigentümer ist.
 */
export async function isForeignOwnedProperty(propertyId: string, profileIds: string[]): Promise<boolean> {
  const { data, error } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .maybeSingle()
  if (error) throw error
  const ownerId = (data as { owner_id: string | null } | null)?.owner_id ?? null
  if (!ownerId || profileIds.includes(ownerId)) return false
  if (profileIds.length > 0) {
    const { data: co } = await supabase
      .from('property_co_owners')
      .select('profile_id')
      .eq('property_id', propertyId)
      .in('profile_id', profileIds)
      .limit(1)
    if (co && co.length > 0) return false
  }
  return true
}

export async function detachPropertyFromOwner(propertyId: string, opts: DetachOptions = {}): Promise<DetachResult> {
  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('id, project_name, unit_number, owner_id')
    .eq('id', propertyId)
    .maybeSingle()
  if (propErr) throw propErr
  if (!prop) throw new Error('Objekt nicht gefunden')
  const p = prop as { id: string; project_name: string | null; unit_number: string | null; owner_id: string | null }
  const label = [p.project_name, p.unit_number ? `Nr. ${p.unit_number}` : null].filter(Boolean).join(' · ') || 'Wohnung'

  // 0. Aufruf aus einer Kundenakte, das Objekt gehört aber einem ANDEREN Kunden
  //    (Fehlzuordnung): nur die Zuordnung dieses Leads lösen. Wohnung, andere Deals
  //    und das Portal-Objekt des echten Eigentümers bleiben unangetastet.
  if (opts.leadId && p.owner_id && await isForeignOwnedProperty(propertyId, await leadProfileIds(opts.leadId))) {
    let dealQuery = supabase.from('deals').update({ unit_id: null, property_id: null })
    dealQuery = opts.dealId
      ? dealQuery.eq('id', opts.dealId)
      : dealQuery.eq('lead_id', opts.leadId).eq('property_id', propertyId)
    const { data: freed, error: freeErr } = await dealQuery.select('id')
    if (freeErr) throw freeErr
    const dealIds = ((freed ?? []) as Array<{ id: string }>).map(d => d.id)
    await supabase.from('activities').insert({
      lead_id:      opts.leadId,
      deal_id:      dealIds[0] ?? opts.dealId ?? null,
      type:         'note',
      direction:    'outbound',
      subject:      'Wohnung getrennt',
      content:      `${label} wurde von diesem Kunden getrennt. Das Objekt im Eigentümer-Portal gehört einem anderen Kunden und bleibt erhalten.`,
      created_by:   opts.actorId ?? null,
      completed_at: new Date().toISOString(),
    })
    return { label, unitIds: [], dealIds, keptForeignOwner: true }
  }

  // 1. Wohnung(en) im Projekt freigeben
  const { data: unitRows, error: unitErr } = await supabase
    .from('crm_project_units')
    .select('id')
    .eq('property_id', propertyId)
  if (unitErr) throw unitErr
  const unitIds = new Set<string>((unitRows ?? []).map(r => (r as { id: string }).id))
  if (opts.unitId) unitIds.add(opts.unitId)
  if (unitIds.size > 0) {
    const { error } = await supabase
      .from('crm_project_units')
      .update({ property_id: null })
      .in('id', Array.from(unitIds))
    if (error) throw error
  }

  // 2. Deal-Zuordnungen aufheben (aktive UND archivierte – sonst Wiedergeburt
  //    des Portal-Objekts beim nächsten Zugangsversand)
  const orParts = [`property_id.eq.${propertyId}`]
  if (unitIds.size > 0) orParts.push(`unit_id.in.(${Array.from(unitIds).join(',')})`)
  const { data: dealRows, error: dealSelErr } = await supabase
    .from('deals')
    .select('id, lead_id')
    .or(orParts.join(','))
  if (dealSelErr) throw dealSelErr
  const deals = (dealRows ?? []) as Array<{ id: string; lead_id: string | null }>
  if (deals.length > 0) {
    const { error } = await supabase
      .from('deals')
      .update({ unit_id: null, property_id: null })
      .in('id', deals.map(d => d.id))
    if (error) throw error
  }

  // 3. Portal-Objekt löschen
  const { data: gone, error: delErr } = await supabase
    .from('properties')
    .delete()
    .eq('id', propertyId)
    .select('id')
  if (delErr) throw delErr
  if (!gone || gone.length === 0) throw new Error('Objekt konnte nicht gelöscht werden (Rechte?)')

  // 4. Historie: je betroffenem Lead ein Eintrag
  const leadIds = new Set<string>(deals.map(d => d.lead_id).filter((v): v is string => !!v))
  if (opts.leadId) leadIds.add(opts.leadId)
  if (leadIds.size === 0 && p.owner_id) {
    const { data: leadRows } = await supabase.from('leads').select('id').eq('profile_id', p.owner_id)
    for (const r of (leadRows ?? []) as Array<{ id: string }>) leadIds.add(r.id)
  }
  if (leadIds.size > 0) {
    const now = new Date().toISOString()
    await supabase.from('activities').insert(
      Array.from(leadIds).map(leadId => ({
        lead_id:      leadId,
        deal_id:      deals.find(d => d.lead_id === leadId)?.id ?? null,
        type:         'note',
        direction:    'outbound',
        subject:      'Wohnung getrennt',
        content:      `${label} wurde vom Kunden getrennt. Das Objekt im Eigentümer-Portal wurde gelöscht, die Wohnung im Projekt ist wieder frei.`,
        created_by:   opts.actorId ?? null,
        completed_at: now,
      })),
    )
  }

  return { label, unitIds: Array.from(unitIds), dealIds: deals.map(d => d.id) }
}

/** Einheitlicher Bestätigungstext für alle drei Einstiege. */
export function detachConfirmText(label: string): string {
  return `„${label}" wirklich vom Kunden trennen?\n\n` +
    '• Das Objekt im Eigentümer-Portal wird gelöscht (inkl. dort hochgeladener Dokumente, Mietverträge, Einnahmen).\n' +
    '• Die Wohnung im Projekt bleibt erhalten und ist wieder frei.\n' +
    '• Die Zuordnung im Deal wird aufgehoben.\n\n' +
    'Das lässt sich nicht rückgängig machen.'
}
