// partner-review — Partner melden den Bearbeitungsstand ihrer Leads zurück.
// Öffentliche, token-geschützte Seite (/partner/:token) ruft diese Function:
//   POST { action:'list', token }  → Partner-Label + alle Leads seiner Phase
//        (deals.phase == token.phase) inkl. bisheriger Rückmeldung.
//   POST { action:'save', token, lead_id, status, next_contact_at?, note? }
//        → Rückmeldung speichern (partner_reviews, upsert je lead+contact),
//          als Aktivität am Lead loggen; bei 'nicht_qualifiziert' zusätzlich eine
//          Aufgabe für Sven anlegen (erscheint auf seiner Startseite).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy partner-review --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const STATUS = new Set(['in_bearbeitung', 'nicht_qualifiziert', 'nicht_erreicht'])
const STATUS_LABEL: Record<string, string> = {
  in_bearbeitung: 'In Bearbeitung', nicht_qualifiziert: 'Kontakt nicht qualifiziert', nicht_erreicht: 'Noch nicht erreicht',
}

async function resolveToken(sb: SupabaseClient, token: string) {
  const { data } = await sb.from('partner_review_tokens').select('contact_id, phase, label, active').eq('token', token).maybeSingle()
  const t = data as { contact_id: string; phase: string; label: string | null; active: boolean } | null
  if (!t || !t.active) return null
  const { data: c } = await sb.from('crm_business_contacts').select('first_name, last_name').eq('id', t.contact_id).maybeSingle()
  const cc = c as { first_name: string | null; last_name: string | null } | null
  const partnerName = `${cc?.first_name ?? ''} ${cc?.last_name ?? ''}`.trim() || 'Partner'
  // Peers: andere aktive Partner DERSELBEN Phase (Burkhard ↔ Ioulia teilen sich
  // den Pool „Kontakt übergeben"). Wer zuerst antwortet, dessen Antwort gilt.
  const { data: peerToks } = await sb.from('partner_review_tokens')
    .select('contact_id, contact:crm_business_contacts(first_name, last_name)')
    .eq('phase', t.phase).eq('active', true).neq('contact_id', t.contact_id)
  const peers = ((peerToks ?? []) as Array<{ contact_id: string; contact: { first_name: string | null; last_name: string | null } | null }>).map(p => ({
    contact_id: p.contact_id,
    name: `${p.contact?.first_name ?? ''} ${p.contact?.last_name ?? ''}`.trim() || 'Partner',
  }))
  return { ...t, partnerName, peers }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; token?: string; lead_id?: string; status?: string; next_contact_at?: string; note?: string }
    const tok = await resolveToken(sb, (body.token ?? '').trim())
    if (!tok) return json({ error: 'Ungültiger oder abgelaufener Link.' }, 404)

    // ── Liste der Leads dieser Phase + bisherige Rückmeldung ──────────────────
    if (body.action === 'list') {
      const { data: deals } = await sb.from('deals').select('lead_id').eq('phase', tok.phase)
      const leadIds = [...new Set(((deals ?? []) as { lead_id: string | null }[]).map(d => d.lead_id).filter((x): x is string => !!x))]
      if (!leadIds.length) return json({ ok: true, label: tok.label, partner: tok.partnerName, leads: [] })
      // Antworten des GANZEN Teams dieser Phase laden (eigene + Peers) — wer zuerst
      // geantwortet hat, dessen Antwort gilt; der andere sieht sie nur noch.
      const poolIds = [tok.contact_id, ...tok.peers.map(p => p.contact_id)]
      const peerName = new Map(tok.peers.map(p => [p.contact_id, p.name]))
      const [{ data: leads }, { data: reviews }] = await Promise.all([
        sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp').in('id', leadIds),
        sb.from('partner_reviews').select('lead_id, contact_id, status, next_contact_at, note, updated_at')
          .in('lead_id', leadIds).in('contact_id', poolIds).order('updated_at', { ascending: true }),
      ])
      // Erste (älteste) Antwort je Lead gewinnt.
      const rev = new Map<string, { contact_id: string; status: string | null; next_contact_at: string | null; note: string | null }>()
      for (const r of (reviews ?? []) as Array<{ lead_id: string; contact_id: string; status: string | null; next_contact_at: string | null; note: string | null }>) {
        if (!rev.has(r.lead_id)) rev.set(r.lead_id, r)
      }
      const out = ((leads ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null }>).map(l => {
        const r = rev.get(l.id) ?? null
        return {
          lead_id: l.id,
          name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || (l.email ?? 'Kontakt'),
          email: l.email, phone: l.whatsapp || l.phone,
          review: r ? {
            status: r.status, next_contact_at: r.next_contact_at, note: r.note,
            mine: r.contact_id === tok.contact_id,
            by: r.contact_id === tok.contact_id ? tok.partnerName : (peerName.get(r.contact_id) ?? 'Partner'),
          } : null,
        }
      })
      out.sort((a, b) => a.name.localeCompare(b.name))
      return json({ ok: true, label: tok.label, partner: tok.partnerName, leads: out })
    }

    // ── Rückmeldung speichern ─────────────────────────────────────────────────
    if (body.action === 'save') {
      const leadId = (body.lead_id ?? '').trim()
      const status = (body.status ?? '').trim()
      if (!leadId || !STATUS.has(status)) return json({ error: 'Ungültige Eingabe.' }, 400)
      const nextAt = status === 'nicht_erreicht' && body.next_contact_at ? new Date(body.next_contact_at).toISOString() : null
      const note = (body.note ?? '').trim().slice(0, 2000) || null

      // Zuerst-gewinnt: Hat ein Peer (z.B. Burkhard vor Ioulia) diesen Lead schon
      // beantwortet, gilt dessen Antwort — der Zweite bekommt einen Hinweis.
      if (tok.peers.length) {
        const { data: peerRev } = await sb.from('partner_reviews')
          .select('contact_id, status')
          .eq('lead_id', leadId).in('contact_id', tok.peers.map(p => p.contact_id)).limit(1)
        const pr = (peerRev as Array<{ contact_id: string; status: string | null }> | null)?.[0]
        if (pr) {
          const byName = tok.peers.find(p => p.contact_id === pr.contact_id)?.name ?? 'Partner'
          return json({ error: 'already_reviewed', by: byName, status: pr.status }, 409)
        }
      }

      const { error: ue } = await sb.from('partner_reviews').upsert({
        lead_id: leadId, contact_id: tok.contact_id, status, next_contact_at: nextAt, note, updated_at: new Date().toISOString(),
      }, { onConflict: 'lead_id,contact_id' })
      if (ue) return json({ error: ue.message }, 500)

      // Am Lead als eingehende Notiz loggen (taucht im Verlauf/Filter „vom Kunden"? nein →
      // als Notiz mit auto:false, damit Sven es im Aktivitäten-Tab sieht).
      const parts = [`${tok.partnerName}: ${STATUS_LABEL[status] ?? status}`]
      if (nextAt) parts.push(`Nächste Kontaktaufnahme: ${new Date(nextAt).toLocaleDateString('de-DE')}`)
      if (note) parts.push(`Bemerkung: ${note}`)
      await sb.from('activities').insert({
        lead_id: leadId, type: 'note', direction: 'inbound', auto: false,
        subject: 'Partner-Rückmeldung', content: parts.join('\n'), completed_at: new Date().toISOString(),
      }).then(({ error }) => { if (error) console.warn('[partner-review] activity:', error.message) })

      // „nicht qualifiziert" → Aufgabe für Sven (erscheint auf seiner Startseite)
      if (status === 'nicht_qualifiziert') {
        const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
        const adminId = (admin as { id: string } | null)?.id ?? null
        const { data: lead } = await sb.from('leads').select('first_name, last_name').eq('id', leadId).maybeSingle()
        const ll = lead as { first_name: string | null; last_name: string | null } | null
        const leadName = `${ll?.first_name ?? ''} ${ll?.last_name ?? ''}`.trim() || 'Kontakt'
        const { data: task } = await sb.from('crm_tasks').insert({
          title: `⚠️ ${leadName}: von ${tok.partnerName} als „nicht qualifiziert" gemeldet`,
          description: `${tok.partnerName} hat diesen Kontakt als nicht qualifiziert markiert.${note ? `\nBemerkung: ${note}` : ''}\nEntscheide: auf „verloren" schieben oder nochmal kontaktieren.`,
          created_by: adminId, status: 'offen',
        }).select('id').single()
        const taskId = (task as { id: string } | null)?.id
        if (taskId) {
          if (adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
          await sb.from('crm_task_leads').insert({ task_id: taskId, lead_id: leadId })
        }
      }
      return json({ ok: true })
    }

    return json({ error: 'Unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[partner-review]', msg)
    return json({ error: msg }, 500)
  }
})
