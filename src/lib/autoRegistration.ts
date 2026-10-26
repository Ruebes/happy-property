import { supabase } from './supabase'
import type { DealPhase } from './crmTypes'

// ── Automatische Registrierung beim Deck-Versand ────────────────────────────
// Sven 26.10.26 (Flora Panorama): Geht ein Deck zu einem Projekt mit
// crm_projects.auto_register raus, ist der Kunde beim Bauträger zu registrieren -
// wie das Registrierungs-Fenster der Pipeline, nur ohne Klick:
//  1. lead_registrations (Provisionsschutz-Karte am Kunden)
//  2. Deal auf „registrierung" (nur aus frühen Phasen; ohne laufenden Deal neu)
//  3. Aktivität „Registrierung gesendet an: …" - daraus liest schedule-message
//     Bauträger + Bemerkung
//  4. schedule-message 'registrierung' → Stufen-Regeln (Lotte-WhatsApp an
//     Burkhard + Ioulia)
// Bereits registrierte Bauträger werden übersprungen, ein zweiter Versand löst
// also nichts mehr aus.

// Nur diese Phasen werden nach vorn geschoben; spätere (Reservierung, Kaufvertrag,
// Finanzierung, Übergabe, Hold …) bleiben stehen, die Registrierung läuft trotzdem.
const EARLY_PHASES: DealPhase[] = ['erstkontakt', 'termin_gebucht', 'no_show', 'immobilienauswahl']
const CLOSED_PHASES = ['archiviert', 'deal_verloren']

type ProjRow = { id: string; name: string; developer: string | null }

// Bauträger der Decks, die automatisch registrieren und bei denen der Kunde noch fehlt.
export async function pendingAutoRegistrations(leadId: string | null | undefined, deckTokens: string[]): Promise<{ developers: string[]; projects: string[] }> {
  const none = { developers: [], projects: [] }
  if (!leadId || !deckTokens.length) return none
  const { data: decks } = await supabase.from('sales_decks').select('project_id').in('token', deckTokens)
  const pids = Array.from(new Set((decks ?? []).map(d => (d as { project_id: string | null }).project_id).filter(Boolean))) as string[]
  if (!pids.length) return none
  const { data: projs } = await supabase.from('crm_projects').select('id, name, developer').in('id', pids).eq('auto_register', true)
  const rows = ((projs ?? []) as ProjRow[]).filter(p => p.developer?.trim())
  if (!rows.length) return none
  const { data: regs } = await supabase.from('lead_registrations').select('developer').eq('lead_id', leadId)
  const regSet = new Set(((regs ?? []) as { developer: string }[]).map(r => r.developer.toLowerCase().trim()))
  const open = rows.filter(p => !regSet.has((p.developer ?? '').toLowerCase().trim()))
  return {
    developers: Array.from(new Set(open.map(p => (p.developer ?? '').trim()))),
    projects: Array.from(new Set(open.map(p => p.name))),
  }
}

export async function autoRegisterForDecks(leadId: string | null | undefined, deckTokens: string[], profileId: string | null): Promise<string[]> {
  const { developers, projects } = await pendingAutoRegistrations(leadId, deckTokens)
  if (!leadId || !developers.length) return []
  const notes = `${projects.join(', ')}, automatisch beim Deck-Versand`

  const { error: regErr } = await supabase.from('lead_registrations').upsert(
    developers.map(dev => ({ lead_id: leadId, developer: dev })),
    { onConflict: 'lead_id,developer' },
  )
  if (regErr) throw regErr

  const { data: deals } = await supabase.from('deals').select('id, phase').eq('lead_id', leadId).order('created_at', { ascending: false })
  const open = ((deals ?? []) as { id: string; phase: string }[]).find(d => !CLOSED_PHASES.includes(d.phase))
  let dealId: string | null = open?.id ?? null
  let fromPhase = open?.phase ?? ''
  if (!open) {
    const { data: nd, error: ne } = await supabase.from('deals').insert({ lead_id: leadId, phase: 'registrierung', registration_notes: notes }).select('id').single()
    if (ne) throw ne
    dealId = (nd as { id: string }).id
    fromPhase = '–'
  } else if ((EARLY_PHASES as string[]).includes(open.phase)) {
    const { error: upErr } = await supabase.from('deals').update({ phase: 'registrierung', registration_notes: notes }).eq('id', open.id)
    if (upErr) throw upErr
  }

  const moved = !open || (EARLY_PHASES as string[]).includes(open.phase)
  await supabase.from('activities').insert({
    lead_id:    leadId,
    deal_id:    dealId,
    type:       'note',
    direction:  'outbound',
    content:    `${moved ? `Phase geändert: ${fromPhase} → registrierung. ` : ''}Registrierung gesendet an: ${developers.join(', ')}. Bemerkung: ${notes}`,
    created_by: profileId,
  })

  // Ohne deal_id: schedule-message nimmt Bauträger + Bemerkung dann aus der Aktivität
  // oben. deals.developer kann von einem früheren Projekt stammen und stünde sonst in
  // der Nachricht an Burkhard/Ioulia.
  const { error: smErr } = await supabase.functions.invoke('schedule-message', { body: { lead_id: leadId, event_type: 'registrierung' } })
  if (smErr) throw new Error(smErr.message)
  return developers
}
