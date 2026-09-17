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
}

export interface DetachResult {
  label: string
  unitIds: string[]
  dealIds: string[]
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
