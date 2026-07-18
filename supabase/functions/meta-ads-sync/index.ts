// Edge Function: meta-ads-sync
// Synct Meta-Ads-Insights (Graph API, direkt — kein Claude nötig) in die
// Werbemanager-Tabellen ad_insights_daily + ad_catalog und führt bestätigte
// Aktionen aus der Warteschlange ad_actions bei Meta aus (pause/activate).
// Läuft täglich per pg_cron und on-demand aus dem CRM („Aktualisieren"-Button,
// Sofort-Ausführung nach dem Vormerken einer Aktion).
//
// Body (alles optional):
//   { days?: number }              — wie viele Tage rückwirkend (Default 3, max 90)
//   { mode?: 'actions_only' }      — nur die Aktions-Queue ausführen (schnell)
//
// Zusätzlich: Conversions-API-Rückspielung ans aktive Pixel — Termin gebucht
// (Schedule), Termin stattgefunden (AppointmentHeld), 👍-Lead (QualifiedLead),
// Sale (Purchase mit Provisionswert). Dedupe über capi_log, Fenster 7 Tage.
//
// ── Secrets (Supabase Dashboard → Settings → Edge Functions → Secrets) ──
//   META_ACCESS_TOKEN   = System-User-Token „Analytics Sync" (ads_read + ads_management, Ablauf: nie)
//   META_AD_ACCOUNT_ID  = 4065490590399677 (Sveru Marketing LLC, USD)
//   META_PIXEL_ID       = 1083578343946189 (Sveru Marketing LLC's Pixel — das aktive)
//
// ── Deployment ──
//   supabase functions deploy meta-ads-sync --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GRAPH = 'https://graph.facebook.com/v21.0'

interface InsightRow {
  ad_id: string
  ad_name?: string
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  adset_name?: string
  spend?: string
  impressions?: string
  reach?: string
  frequency?: string
  inline_link_clicks?: string
  actions?: Array<{ action_type: string; value: string }>
  video_continuous_2_sec_watched_actions?: Array<{ action_type: string; value: string }>
  date_start: string
}

// Graph-API-Liste mit Paging komplett einsammeln
async function graphAll(url: string, token: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let next: string | null = url
  let guard = 0
  while (next && guard < 30) {
    guard++
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
    const json = await res.json()
    if (!res.ok) throw new Error(`Graph ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`)
    out.push(...((json.data ?? []) as Record<string, unknown>[]))
    next = (json.paging?.next as string | undefined) ?? null
  }
  return out
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'))
  return Number.isFinite(n) ? n : 0
}
const actionValue = (arr: InsightRow['actions'], type: string): number =>
  num(arr?.find(a => a.action_type === type)?.value)

// ── Conversions API: Hashing + Event-Bau ─────────────────────────────────────
async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

interface CapiCandidate {
  event_id: string
  event_name: string
  event_time: number            // Unix-Sekunden, max. 7 Tage alt
  lead_id: string | null
  email: string | null
  phone: string | null
  value?: number                // nur Purchase (EUR)
}

async function buildCapiEvent(c: CapiCandidate): Promise<Record<string, unknown> | null> {
  const user_data: Record<string, string[]> = {}
  const email = c.email?.trim().toLowerCase()
  if (email) user_data.em = [await sha256(email)]
  const phone = c.phone?.replace(/[^0-9]/g, '')
  if (phone && phone.length >= 8) user_data.ph = [await sha256(phone)]
  if (!user_data.em && !user_data.ph) return null   // ohne Matching-Daten sinnlos
  const ev: Record<string, unknown> = {
    event_name: c.event_name,
    event_time: c.event_time,
    event_id: c.event_id,
    action_source: 'system_generated',
    user_data,
  }
  if (c.value && c.value > 0) ev.custom_data = { currency: 'EUR', value: c.value }
  return ev
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const token   = Deno.env.get('META_ACCESS_TOKEN')!
    const account = Deno.env.get('META_AD_ACCOUNT_ID') ?? '4065490590399677'
    if (!token) throw new Error('META_ACCESS_TOKEN fehlt (Supabase Secrets)')

    const body = await req.json().catch(() => ({})) as { days?: number; mode?: string }
    const days = Math.min(Math.max(Math.trunc(body.days ?? 3), 1), 90)
    const actionsOnly = body.mode === 'actions_only'

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const summary: Record<string, unknown> = {}

    // ── 1. Insights der letzten N Tage (tagesgenau je Ad) ────────────────────
    if (!actionsOnly) {
      const until = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)   // gestern
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

      // EUR-Kurs (Fallback: letzter bekannter Näherungswert)
      let usdPerEur = 1.14
      try {
        const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD')
        const j = await r.json()
        if (j?.rates?.USD) usdPerEur = j.rates.USD
      } catch { console.warn('[meta-ads-sync] Kurs-API nicht erreichbar, Fallback', usdPerEur) }

      const fields = 'ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,impressions,reach,frequency,inline_link_clicks,actions,video_continuous_2_sec_watched_actions'
      const insightsUrl = `${GRAPH}/act_${account}/insights?level=ad&time_increment=1&fields=${fields}` +
        `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=500`
      const rows = (await graphAll(insightsUrl, token)) as unknown as InsightRow[]

      // Ad-Stammdaten (Status + Creative fürs Thumbnail) — eine Abfrage fürs ganze Konto
      const adsUrl = `${GRAPH}/act_${account}/ads?fields=id,name,status,adset_id,campaign_id,creative{id,thumbnail_url}&limit=500`
      const ads = await graphAll(adsUrl, token)
      const adMeta = new Map(ads.map(a => [String(a.id), a as Record<string, unknown>]))

      // Kampagnen-/Adset-Namen fürs Katalog-Upsert (auch für Ads ohne Insights)
      const campaignNames = new Map((await graphAll(`${GRAPH}/act_${account}/campaigns?fields=id,name&limit=200`, token)).map(c => [String(c.id), String(c.name ?? '')]))
      const adsetNames = new Map((await graphAll(`${GRAPH}/act_${account}/adsets?fields=id,name&limit=500`, token)).map(a => [String(a.id), String(a.name ?? '')]))

      // Insights-Upsert
      const insightRows = rows
        .filter(r => r.ad_id && r.date_start && (num(r.spend) > 0 || num(r.impressions) > 0))
        .map(r => {
          const spend = num(r.spend)
          return {
            day: r.date_start,
            ad_id: r.ad_id,
            platform: 'meta',
            spend,
            currency: 'USD',
            spend_eur: Math.round((spend / usdPerEur) * 100) / 100,
            impressions: Math.trunc(num(r.impressions)),
            reach: Math.trunc(num(r.reach)),
            frequency: num(r.frequency),
            link_clicks: Math.trunc(num(r.inline_link_clicks) || actionValue(r.actions, 'link_click')),
            platform_leads: Math.trunc(actionValue(r.actions, 'lead')),
            video_3s: Math.trunc(num(r.video_continuous_2_sec_watched_actions?.[0]?.value)),
            synced_at: new Date().toISOString(),
          }
        })
      for (let i = 0; i < insightRows.length; i += 300) {
        const { error } = await supabase.from('ad_insights_daily')
          .upsert(insightRows.slice(i, i + 300), { onConflict: 'day,ad_id' })
        if (error) throw new Error(`Insights-Upsert: ${error.message}`)
      }

      // Katalog-Upsert (Namen aus Insights, Status + Thumbnail aus /ads)
      const seen = new Set<string>()
      const catalogRows = []
      for (const r of rows) {
        if (!r.ad_id || seen.has(r.ad_id)) continue
        seen.add(r.ad_id)
        const meta = adMeta.get(r.ad_id)
        const creative = (meta?.creative ?? null) as { id?: string; thumbnail_url?: string } | null
        catalogRows.push({
          ad_id: r.ad_id,
          platform: 'meta',
          account_id: account,
          campaign_id: r.campaign_id ?? '',
          campaign_name: r.campaign_name ?? null,
          adset_id: r.adset_id ?? null,
          adset_name: r.adset_name ?? null,
          ad_name: r.ad_name ?? (meta?.name as string | undefined) ?? null,
          status: (meta?.status as string | undefined) ?? null,
          creative_id: creative?.id ?? null,
          thumbnail_url: creative?.thumbnail_url ?? null,
          updated_at: new Date().toISOString(),
        })
      }
      // Ads OHNE frische Insights (z.B. neu angelegte, pausierte) trotzdem in den
      // Katalog aufnehmen/aktualisieren — sonst fehlen sie im Werbemanager und
      // haben keinen Aktivieren-Button. Thumbnails immer auffrischen (CDN läuft ab).
      for (const [adId, meta] of adMeta) {
        if (seen.has(adId)) continue
        seen.add(adId)
        const creative = (meta.creative ?? null) as { id?: string; thumbnail_url?: string } | null
        catalogRows.push({
          ad_id: adId,
          platform: 'meta',
          account_id: account,
          campaign_id: String(meta.campaign_id ?? ''),
          campaign_name: campaignNames.get(String(meta.campaign_id ?? '')) ?? null,
          adset_id: (meta.adset_id as string | undefined) ?? null,
          adset_name: adsetNames.get(String(meta.adset_id ?? '')) ?? null,
          ad_name: (meta.name as string | undefined) ?? null,
          status: (meta.status as string | undefined) ?? null,
          creative_id: creative?.id ?? null,
          thumbnail_url: creative?.thumbnail_url ?? null,
          updated_at: new Date().toISOString(),
        })
      }
      if (catalogRows.length) {
        const { error } = await supabase.from('ad_catalog').upsert(catalogRows, { onConflict: 'ad_id' })
        if (error) throw new Error(`Katalog-Upsert: ${error.message}`)
      }
      summary.insight_rows = insightRows.length
      summary.catalog_rows = catalogRows.length
      summary.since = since
      summary.until = until
      console.log(`[meta-ads-sync] ${insightRows.length} Insight-Zeilen (${since}–${until}), ${catalogRows.length} Katalog-Zeilen`)
    }

    // ── 1b. Conversions API: CRM-Qualität an Meta zurückspielen ──────────────
    // Meta lernt daraus, WER bucht/erscheint/gut ist — und liefert die Anzeigen
    // an ähnliche Leute aus. Dedupe über capi_log; Events max. 7 Tage alt.
    if (!actionsOnly) {
      const pixelId = Deno.env.get('META_PIXEL_ID') ?? ''
      if (pixelId) {
        try {
          const winStart = new Date(Date.now() - 7 * 86_400_000).toISOString()
          const clampTime = (iso: string) => Math.trunc(new Date(iso).getTime() / 1000)
          const candidates: CapiCandidate[] = []

          // Termin gebucht → Schedule
          const { data: appts } = await supabase
            .from('crm_appointments')
            .select('id, lead_id, created_at, start_time, outcome, updated_at, lead:leads(id, email, phone, whatsapp)')
            .gte('created_at', winStart)
            .not('lead_id', 'is', null)
          for (const a of (appts ?? []) as unknown as Array<{ id: string; lead_id: string; created_at: string; lead: { email: string | null; phone: string | null; whatsapp: string | null } | null }>) {
            if (!a.lead) continue
            candidates.push({ event_id: `appt-${a.id}`, event_name: 'Schedule', event_time: clampTime(a.created_at), lead_id: a.lead_id, email: a.lead.email, phone: a.lead.whatsapp ?? a.lead.phone })
          }

          // Termin stattgefunden → AppointmentHeld (Bewertungszeitpunkt = updated_at)
          const { data: held } = await supabase
            .from('crm_appointments')
            .select('id, lead_id, updated_at, lead:leads(id, email, phone, whatsapp)')
            .eq('outcome', 'completed')
            .gte('updated_at', winStart)
            .not('lead_id', 'is', null)
          for (const a of (held ?? []) as unknown as Array<{ id: string; lead_id: string; updated_at: string; lead: { email: string | null; phone: string | null; whatsapp: string | null } | null }>) {
            if (!a.lead) continue
            candidates.push({ event_id: `held-${a.id}`, event_name: 'AppointmentHeld', event_time: clampTime(a.updated_at), lead_id: a.lead_id, email: a.lead.email, phone: a.lead.whatsapp ?? a.lead.phone })
          }

          // 👍-Bewertung → QualifiedLead
          const { data: rated } = await supabase
            .from('leads')
            .select('id, email, phone, whatsapp, quality_rated_at')
            .eq('quality_rating', 'gut')
            .gte('quality_rated_at', winStart)
          for (const l of (rated ?? []) as Array<{ id: string; email: string | null; phone: string | null; whatsapp: string | null; quality_rated_at: string }>) {
            candidates.push({ event_id: `goodlead-${l.id}`, event_name: 'QualifiedLead', event_time: clampTime(l.quality_rated_at), lead_id: l.id, email: l.email, phone: l.whatsapp ?? l.phone })
          }

          // Sale (Anzahlung/Provision) → Purchase mit Provisionswert
          const { data: sales } = await supabase
            .from('deals')
            .select('id, lead_id, phase, commission_amount, updated_at, lead:leads(id, email, phone, whatsapp)')
            .in('phase', ['anzahlung', 'provision_erhalten'])
            .gte('updated_at', winStart)
          for (const d of (sales ?? []) as unknown as Array<{ id: string; lead_id: string; commission_amount: number | null; updated_at: string; lead: { email: string | null; phone: string | null; whatsapp: string | null } | null }>) {
            if (!d.lead) continue
            candidates.push({ event_id: `sale-${d.id}`, event_name: 'Purchase', event_time: clampTime(d.updated_at), lead_id: d.lead_id, email: d.lead.email, phone: d.lead.whatsapp ?? d.lead.phone, value: d.commission_amount ?? 0 })
          }

          // Bereits gesendete rausfiltern
          const ids = candidates.map(c => c.event_id)
          const sent = new Set<string>()
          for (let i = 0; i < ids.length; i += 200) {
            const { data: logRows } = await supabase.from('capi_log').select('event_id').in('event_id', ids.slice(i, i + 200))
            for (const r of (logRows ?? []) as { event_id: string }[]) sent.add(r.event_id)
          }
          const fresh = candidates.filter(c => !sent.has(c.event_id))

          const events: Record<string, unknown>[] = []
          const freshUsed: CapiCandidate[] = []
          for (const c of fresh) {
            const ev = await buildCapiEvent(c)
            if (ev) { events.push(ev); freshUsed.push(c) }
          }
          if (events.length) {
            const res = await fetch(`${GRAPH}/${pixelId}/events`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ data: events }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(`CAPI ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`)
            await supabase.from('capi_log').insert(freshUsed.map(c => ({ event_id: c.event_id, event_name: c.event_name, lead_id: c.lead_id })))
            summary.capi_sent = json?.events_received ?? events.length
            console.log(`[meta-ads-sync] CAPI: ${events.length} Events gesendet (${freshUsed.map(c => c.event_name).join(', ')})`)
          } else {
            summary.capi_sent = 0
          }
        } catch (err) {
          // Rückspielung darf den Sync nie scheitern lassen
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[meta-ads-sync] CAPI-Fehler:', msg)
          summary.capi_error = msg
        }
      }
    }

    // ── 2. Bestätigte Aktionen ausführen (pause/activate — sonst NICHTS) ─────
    const { data: pending, error: qErr } = await supabase
      .from('ad_actions')
      .select('id, ad_id, ad_name, action')
      .eq('status', 'bestätigt')
      .order('created_at')
    if (qErr) throw new Error(`Queue lesen: ${qErr.message}`)

    let executed = 0, failed = 0
    for (const a of (pending ?? []) as { id: string; ad_id: string; ad_name: string | null; action: string }[]) {
      try {
        if (a.action !== 'pause' && a.action !== 'activate') throw new Error(`Unbekannte Aktion "${a.action}"`)
        // Sicherheitscheck: Ad muss zu unserem Konto gehören
        const { data: cat } = await supabase.from('ad_catalog')
          .select('ad_id').eq('ad_id', a.ad_id).eq('account_id', account).maybeSingle()
        if (!cat) throw new Error('Ad nicht im Konto-Katalog')

        const newStatus = a.action === 'pause' ? 'PAUSED' : 'ACTIVE'
        const res = await fetch(`${GRAPH}/${a.ad_id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        })
        const json = await res.json()
        if (!res.ok || json?.success === false) {
          throw new Error(JSON.stringify(json?.error?.message ?? json).slice(0, 200))
        }
        await supabase.from('ad_actions').update({
          status: 'ausgeführt', executed_at: new Date().toISOString(),
          result: `Status → ${newStatus}`,
        }).eq('id', a.id)
        await supabase.from('ad_catalog').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('ad_id', a.ad_id)
        executed++
        console.log(`[meta-ads-sync] Aktion ausgeführt: ${a.action} ${a.ad_name ?? a.ad_id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failed++
        console.error(`[meta-ads-sync] Aktion fehlgeschlagen (${a.ad_name ?? a.ad_id}):`, msg)
        await supabase.from('ad_actions').update({
          status: 'fehlgeschlagen', executed_at: new Date().toISOString(), result: msg.slice(0, 200),
        }).eq('id', a.id)
      }
    }
    summary.actions_executed = executed
    summary.actions_failed = failed

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[meta-ads-sync]', msg)
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
