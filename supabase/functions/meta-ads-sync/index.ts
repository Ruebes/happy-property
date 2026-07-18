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
// ── Secrets (Supabase Dashboard → Settings → Edge Functions → Secrets) ──
//   META_ACCESS_TOKEN   = System-User-Token „Analytics Sync" (ads_read + ads_management, Ablauf: nie)
//   META_AD_ACCOUNT_ID  = 4065490590399677 (Sveru Marketing LLC, USD)
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
      // Thumbnails auch für Ads OHNE frische Insights auffrischen (CDN-URLs laufen ab)
      for (const [adId, meta] of adMeta) {
        if (seen.has(adId)) continue
        const creative = (meta.creative ?? null) as { id?: string; thumbnail_url?: string } | null
        if (!creative?.thumbnail_url) continue
        const { error } = await supabase.from('ad_catalog')
          .update({ status: (meta.status as string) ?? null, thumbnail_url: creative.thumbnail_url, creative_id: creative.id ?? null, updated_at: new Date().toISOString() })
          .eq('ad_id', adId)
        if (error) console.warn('[meta-ads-sync] Thumbnail-Update:', error.message)
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
