// partner-akte — Kunden-Akte für Partner (z.B. Burkhard): öffentliche, token-
// geschützte Verlaufsseite + automatische WhatsApp-Kurzmeldungen bei neuen
// Vorgängen.
//
//   POST { action:'status', lead_id }              → Share-Status (nur eingeloggt)
//   POST { action:'create', lead_id, whatsapp?, partner_name? }
//        → Share anlegen/reaktivieren, Intro-WhatsApp mit Link an den Partner
//   POST { action:'deactivate', lead_id }          → Share pausieren
//   POST { action:'view', token }                  → komplette Akte (öffentlich):
//        Stammdaten + Aktivitäten (Mails/WhatsApps/Notizen) + Berechnungen +
//        Decks + Termine, chronologisch
//   POST { action:'notify_scan' }                  → Cron (alle 10 Min): neue
//        AUSGEHENDE Vorgänge seit last_notified_at je aktivem Share einsammeln
//        → EINE kurze WhatsApp (Stammdaten + Zusammenfassung + Akten-Link)
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// Deploy:  supabase functions deploy partner-akte --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const PORTAL = 'https://portal.happy-property.com'

interface Share { id: string; lead_id: string; token: string; partner_name: string; whatsapp: string; active: boolean; last_notified_at: string }
interface LeadRow { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null; country: string | null; source: string | null; status: string | null; language: string | null }

const leadName = (l: LeadRow) => `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.email || 'Kunde'
// Zeiten für Burkhard in Zypern-Zeit (sein Anschluss ist +357).
const fmtCy = (iso: string) => {
  const d = new Date(iso)
  const date = d.toLocaleDateString('de-DE', { timeZone: 'Asia/Nicosia', day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = d.toLocaleTimeString('de-DE', { timeZone: 'Asia/Nicosia', hour: '2-digit', minute: '2-digit' })
  return `${date} ${time} Uhr`
}

// Kompakte Beschreibung eines Vorgangs für die WhatsApp-Zusammenfassung.
function describeActivity(a: { type: string | null; direction: string | null; subject: string | null }): string | null {
  const subj = (a.subject ?? '').trim()
  const t = (a.type ?? '').toLowerCase()
  if (a.direction !== 'outbound') return null
  if (t === 'email' || t === 'mail') return `E-Mail${subj ? ` „${subj.slice(0, 60)}"` : ''} gesendet`
  if (t === 'whatsapp') return `WhatsApp${subj ? ` „${subj.slice(0, 60)}"` : ''} gesendet`
  if (t === 'call' || t === 'phone') return `Telefonat${subj ? ` „${subj.slice(0, 60)}"` : ''}`
  if (t === 'note') return null // interne Notizen nicht als Update melden (stehen in der Akte)
  return subj ? `${subj.slice(0, 70)}` : null
}

async function shareByLead(sb: SupabaseClient, leadId: string): Promise<Share | null> {
  const { data } = await sb.from('lead_partner_shares').select('*').eq('lead_id', leadId).maybeSingle()
  return data as Share | null
}

// Aufrufer muss eingeloggter Admin/Verwalter/Mitarbeiter sein (Verwaltungs-Aktionen).
async function callerAllowed(sb: SupabaseClient, req: Request): Promise<boolean> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return false
  const { data } = await sb.auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return false
  const { data: prof } = await sb.from('profiles').select('role').eq('id', uid).maybeSingle()
  const role = (prof as { role?: string } | null)?.role
  return role === 'admin' || role === 'verwalter' || role === 'mitarbeiter'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; lead_id?: string; token?: string; whatsapp?: string; partner_name?: string }

    // ── Verwaltung (nur eingeloggt) ──────────────────────────────────────────
    if (body.action === 'status' || body.action === 'create' || body.action === 'deactivate') {
      if (!(await callerAllowed(sb, req))) return json({ error: 'Nicht berechtigt.' }, 403)
      const leadId = (body.lead_id ?? '').trim()
      if (!leadId) return json({ error: 'lead_id fehlt.' }, 400)

      if (body.action === 'status') {
        const s = await shareByLead(sb, leadId)
        return json({ ok: true, share: s ? { active: s.active, partner_name: s.partner_name, whatsapp: s.whatsapp, url: `${PORTAL}/akte/${s.token}`, created_at: (s as unknown as { created_at?: string }).created_at } : null })
      }

      if (body.action === 'deactivate') {
        await sb.from('lead_partner_shares').update({ active: false }).eq('lead_id', leadId)
        return json({ ok: true })
      }

      // create / reaktivieren
      const wa = (body.whatsapp ?? '').trim().replace(/[‎‏‪-‮]/g, '')
      if (!/^\+\d{7,15}$/.test(wa)) return json({ error: 'WhatsApp-Nummer bitte im Format +357… angeben.' }, 400)
      const partnerName = (body.partner_name ?? '').trim() || 'Burkhard'
      const { data: leadRow } = await sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp, country, source, status, language').eq('id', leadId).maybeSingle()
      if (!leadRow) return json({ error: 'Kunde nicht gefunden.' }, 404)
      const lead = leadRow as LeadRow

      let share = await shareByLead(sb, leadId)
      if (share) {
        await sb.from('lead_partner_shares').update({ active: true, whatsapp: wa, partner_name: partnerName, last_notified_at: new Date().toISOString() }).eq('id', share.id)
        share = { ...share, active: true, whatsapp: wa, partner_name: partnerName }
      } else {
        const { data: ins, error: insErr } = await sb.from('lead_partner_shares')
          .insert({ lead_id: leadId, whatsapp: wa, partner_name: partnerName })
          .select('*').single()
        if (insErr) return json({ error: insErr.message }, 500)
        share = ins as Share
      }
      const url = `${PORTAL}/akte/${share.token}`

      // Intro-WhatsApp an den Partner: Stammdaten + fester Akten-Link.
      const intro = [
        `Hallo ${partnerName}, ab sofort bekommst du hier alle Vorgänge zu diesem Kunden:`,
        ``,
        `👤 ${leadName(lead)}`,
        lead.phone || lead.whatsapp ? `📞 ${lead.phone ?? lead.whatsapp}` : '',
        lead.email ? `✉️ ${lead.email}` : '',
        ``,
        `📁 Komplette Akte (Mails, Berechnungen, WhatsApps, Termine):`,
        url,
        ``,
        `Bei jedem neuen Vorgang bekommst du automatisch eine kurze Nachricht. Viele Grüße, Sven`,
      ].filter(l => l !== '').join('\n')
      const { data: waRes, error: waErr } = await sb.functions.invoke('send-whatsapp', { body: {
        event_type: 'partner_akte_intro',
        override_text: intro,
        lead_data: { lead_name: partnerName, lead_phone: wa },
      } })
      const waOk = !waErr && (waRes as { success?: boolean } | null)?.success !== false
      if (!waOk) console.warn('[partner-akte] Intro-WhatsApp fehlgeschlagen:', waErr ?? waRes)

      // In der Kundenakte festhalten
      await sb.from('activities').insert({
        lead_id: leadId, type: 'note', direction: 'outbound', auto: true,
        subject: `Partner-Akte für ${partnerName} aktiviert`,
        content: `Akten-Link an ${partnerName} (${wa}) geschickt: ${url}`,
        completed_at: new Date().toISOString(),
      }).then(({ error }) => { if (error) console.warn('[partner-akte] activity log:', error.message) })

      return json({ ok: true, url, wa_sent: waOk })
    }

    // ── Öffentliche Akte per Token ───────────────────────────────────────────
    if (body.action === 'view') {
      const token = (body.token ?? '').trim()
      if (!token) return json({ error: 'Token fehlt.' }, 400)
      const { data: sh } = await sb.from('lead_partner_shares').select('*').eq('token', token).maybeSingle()
      const share = sh as Share | null
      if (!share || !share.active) return json({ error: 'Ungültiger oder deaktivierter Link.' }, 404)

      const [{ data: leadRow }, { data: acts }, { data: calcs }, { data: decks }, { data: appts }, { data: deals }] = await Promise.all([
        sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp, country, source, status, language').eq('id', share.lead_id).maybeSingle(),
        sb.from('activities').select('type, direction, subject, content, completed_at, created_at, auto').eq('lead_id', share.lead_id).order('created_at', { ascending: true }).limit(400),
        sb.from('property_calculations').select('token, title, recipient_name, created_at').eq('lead_id', share.lead_id).order('created_at', { ascending: true }),
        sb.from('sales_decks').select('token, status, created_at').eq('lead_id', share.lead_id).order('created_at', { ascending: true }),
        sb.from('crm_appointments').select('title, type, start_time, end_time, outcome, internal').eq('lead_id', share.lead_id).eq('internal', false).order('start_time', { ascending: true }),
        sb.from('deals').select('phase, created_at, project:crm_projects(name)').eq('lead_id', share.lead_id),
      ])
      if (!leadRow) return json({ error: 'Kunde nicht gefunden.' }, 404)
      const lead = leadRow as LeadRow

      return json({
        ok: true,
        partner: share.partner_name,
        lead: {
          name: leadName(lead), email: lead.email, phone: lead.phone ?? lead.whatsapp,
          country: lead.country, source: lead.source, status: lead.status,
        },
        deals: ((deals ?? []) as Array<{ phase: string | null; created_at: string; project: { name: string } | null }>)
          .map(d => ({ phase: d.phase, project: d.project?.name ?? null, created_at: d.created_at })),
        activities: ((acts ?? []) as Array<{ type: string | null; direction: string | null; subject: string | null; content: string | null; completed_at: string | null; created_at: string; auto: boolean | null }>)
          .map(a => ({ type: a.type, direction: a.direction, subject: a.subject, content: (a.content ?? '').slice(0, 4000), at: a.completed_at ?? a.created_at, auto: !!a.auto })),
        calculations: ((calcs ?? []) as Array<{ token: string; title: string | null; recipient_name: string | null; created_at: string }>)
          .map(c => ({ title: c.title || 'Berechnung', url: `${PORTAL}/rechnung/${c.token}`, created_at: c.created_at })),
        decks: ((decks ?? []) as Array<{ token: string; status: string | null; created_at: string }>)
          .map(d => ({ url: `${PORTAL}/deck/${d.token}`, status: d.status, created_at: d.created_at })),
        appointments: ((appts ?? []) as Array<{ title: string | null; type: string | null; start_time: string; end_time: string | null; outcome: string | null }>)
          .map(a => ({ title: a.title, type: a.type, start_time: a.start_time, end_time: a.end_time, outcome: a.outcome })),
      })
    }

    // ── Cron: neue Vorgänge je Share → kurze WhatsApp ────────────────────────
    if (body.action === 'notify_scan') {
      const { data: shs } = await sb.from('lead_partner_shares').select('*').eq('active', true)
      const shares = (shs ?? []) as Share[]
      const results: Array<Record<string, unknown>> = []
      for (const share of shares) {
        try {
          const since = share.last_notified_at
          const nowIso = new Date().toISOString()
          // Drossel (Sven 22.8.: "da soll nichts alle 10 Minuten in den Versand
          // gehen"): Der Scan laeuft alle 10 Minuten, GESENDET wird aber
          // fruehestens 4 Stunden nach der letzten Meldung - neue Ereignisse
          // sammeln sich bis dahin zu EINER Sammelnachricht.
          if (since && Date.now() - new Date(since).getTime() < 4 * 3600e3) {
            results.push({ share: share.id, throttled: true }); continue
          }
          const [{ data: acts }, { data: calcs }, { data: decks }, { data: appts }] = await Promise.all([
            sb.from('activities').select('type, direction, subject, created_at, auto').eq('lead_id', share.lead_id).gt('created_at', since).order('created_at', { ascending: true }).limit(20),
            sb.from('property_calculations').select('title, token, created_at').eq('lead_id', share.lead_id).gt('created_at', since),
            sb.from('sales_decks').select('token, created_at').eq('lead_id', share.lead_id).gt('created_at', since),
            sb.from('crm_appointments').select('title, start_time, created_at, internal').eq('lead_id', share.lead_id).gt('created_at', since).eq('internal', false),
          ])
          const lines: string[] = []
          for (const c of (calcs ?? []) as Array<{ title: string | null; token: string; created_at: string }>) {
            lines.push(`📊 Berechnung „${(c.title || 'Berechnung').slice(0, 60)}" erstellt (${fmtCy(c.created_at)})\n${PORTAL}/rechnung/${c.token}`)
          }
          for (const d of (decks ?? []) as Array<{ token: string; created_at: string }>) {
            lines.push(`📑 Angebots-Deck erstellt (${fmtCy(d.created_at)})\n${PORTAL}/deck/${d.token}`)
          }
          for (const a of (appts ?? []) as Array<{ title: string | null; start_time: string; created_at: string }>) {
            lines.push(`📅 Termin „${(a.title || 'Termin').slice(0, 50)}" am ${fmtCy(a.start_time)}`)
          }
          for (const a of (acts ?? []) as Array<{ type: string | null; direction: string | null; subject: string | null; created_at: string; auto: boolean | null }>) {
            // Die eigene Aktivierungs-Notiz nicht als Update melden
            if ((a.subject ?? '').startsWith('Partner-Akte für')) continue
            const desc = describeActivity(a)
            const icon = a.type === 'whatsapp' ? '💬' : (a.type === 'email' || a.type === 'mail') ? '✉️' : '📌'
            if (desc) lines.push(`${icon} ${desc} (${fmtCy(a.created_at)})`)
          }
          if (!lines.length) { results.push({ share: share.id, updates: 0 }); continue }

          const { data: leadRow } = await sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp, country, source, status, language').eq('id', share.lead_id).maybeSingle()
          const lead = leadRow as LeadRow | null
          if (!lead) { results.push({ share: share.id, error: 'lead fehlt' }); continue }

          // Absenderin ist Lotte (Svens Wunsch 9.8.26) — mit echtem Strandfoto von ihr.
          const msg = [
            `🐾 Hallo ${share.partner_name}, während ich mir eine Pause am Strand gönne, hier etwas für dich zum Lesen:`,
            ``,
            `📁 Update zu ${leadName(lead)}${lead.phone || lead.whatsapp ? ` (${lead.phone ?? lead.whatsapp})` : ''}:`,
            ``,
            ...lines,
            ``,
            `Komplette Akte: ${PORTAL}/akte/${share.token}`,
            ``,
            `Deine Lotte 🐾`,
          ].join('\n')

          const { data: waRes, error: waErr } = await sb.functions.invoke('send-whatsapp', { body: {
            event_type: 'partner_akte_update',
            override_text: msg,
            lead_data: { lead_name: share.partner_name, lead_phone: share.whatsapp },
            persona_image: `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/Assets/wa/lotte-strand.jpg`,
          } })
          const waOk = !waErr && (waRes as { success?: boolean } | null)?.success !== false
          if (waOk) {
            await sb.from('lead_partner_shares').update({ last_notified_at: nowIso }).eq('id', share.id)
            results.push({ share: share.id, updates: lines.length, sent: true })
          } else {
            // last_notified_at NICHT vorrücken → nächster Lauf versucht es erneut
            console.error('[partner-akte] WhatsApp fehlgeschlagen:', JSON.stringify(waErr ?? waRes).slice(0, 200))
            results.push({ share: share.id, updates: lines.length, sent: false })
          }
        } catch (e) {
          console.error('[partner-akte] Scan-Fehler Share', share.id, (e as Error).message)
          results.push({ share: share.id, error: (e as Error).message })
        }
      }
      return json({ ok: true, shares: shares.length, results })
    }

    return json({ error: 'Unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[partner-akte]', msg)
    return json({ error: msg }, 500)
  }
})
