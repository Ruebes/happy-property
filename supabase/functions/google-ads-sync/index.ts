// google-ads-sync — holt YouTube- und Google-Werbung aus Google Ads ins CRM.
//
// Schreibt in dieselben Tabellen wie meta-ads-sync, getrennt über `platform`:
//   ad_catalog         eine Zeile je Anzeige (ad_id = 'gads_<Anzeigen-ID>')
//   ad_insights_daily  Tag × Anzeige: Kosten, Impressionen, Klicks, Aufrufe
//                      (thruplays = TrueView-Aufrufe), neue Abos (yt_subscribers)
// Kampagnentyp VIDEO/DEMAND_GEN → platform 'youtube', alles andere → 'google'.
//
//   POST { action:'status' }   → verbunden? (ohne Google-Aufruf, für den Werbemanager)
//   POST { days?: 1..90 }      → Sync der letzten N Tage (Standard 7)
//
// Aufrufer: pg_cron (Service-Key) täglich, Admin/Verwalter oder Recht 'werbung'
// über den „Aktualisieren"-Knopf. Nur lesend gegenüber Google.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; Google-Zugang siehe _shared/googleAds.ts
// Deploy:  supabase functions deploy google-ads-sync --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, corsHeaders as CORS } from '../_shared/callerAuth.ts'
import { gadsContext, gadsCustomerInfo, gadsSearch, gadsSecret, cleanCustomerId, GADS_VERSION } from '../_shared/googleAds.ts'

const FN = 'google-ads-sync'
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const YOUTUBE_TYPES = new Set(['VIDEO', 'DEMAND_GEN', 'DISCOVERY'])
// Conversion-Aktion für Kanal-Abos heißt je nach Kontosprache „YouTube channel
// subscriptions" oder „YouTube-Kanal-Abos" / „Abonnements".
const ABO_RE = /subscri|abonn|\babos?\b|kanal-abo/i

type Row = Record<string, any>
const num = (v: unknown) => Number(v ?? 0) || 0
const ymd = (d: Date) => d.toISOString().slice(0, 10)

function platformOf(channelType: string): 'youtube' | 'google' {
  return YOUTUBE_TYPES.has(channelType) ? 'youtube' : 'google'
}
// Google-Status in die Meta-Schreibweise, die der Werbemanager schon kennt
function statusOf(s: string): string {
  return s === 'ENABLED' ? 'ACTIVE' : s === 'PAUSED' ? 'PAUSED' : s === 'REMOVED' ? 'DELETED' : s
}

async function eurFactor(currency: string): Promise<number> {
  if (!currency || currency === 'EUR') return 1
  try {
    const j = await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${currency}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()) as { rates?: Record<string, number> }
    const perEur = j?.rates?.[currency]
    return perEur ? 1 / perEur : 0
  } catch { return 0 }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const caller = await authorizeCaller(req, { service: true, cron: true, roles: ['admin', 'verwalter'], perms: ['werbung'] }, CORS)
  if (caller instanceof Response) return caller

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const body = await req.json().catch(() => ({})) as { action?: string; days?: number }

  if (body.action === 'status') {
    const [rtok, cust] = await Promise.all([gadsSecret(sb, 'GOOGLE_ADS_REFRESH_TOKEN'), gadsSecret(sb, 'GOOGLE_ADS_CUSTOMER_ID')])
    return json({ ok: true, connected: !!rtok, customer: !!cleanCustomerId(cust) })
  }

  const warnings: string[] = []
  try {
    const days = Math.min(Math.max(Math.trunc(Number(body.days ?? 7)) || 7, 1), 90)
    const ctx = await gadsContext(sb)
    const info = await gadsCustomerInfo(ctx)
    if (info.manager) throw new Error('Die eingestellte Kunden-ID ist ein Verwaltungskonto. Bitte das Werbekonto darunter eintragen.')
    const until = ymd(new Date())
    const since = ymd(new Date(Date.now() - (days - 1) * 86_400_000))
    const jetzt = new Date().toISOString()

    // ── 1. Katalog: alle nicht gelöschten Anzeigen (auch ohne Auslieferung) ──
    const cat = await gadsSearch<Row>(ctx, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
             ad_group.id, ad_group.name, ad_group.status,
             ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status,
             ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.policy_topic_entries
      FROM ad_group_ad
      WHERE ad_group_ad.status != 'REMOVED'`)

    // Vorschaubilder: YouTube-Video je Anzeige (In-Stream, responsive Video- und Demand-Gen-Videoanzeigen).
    // Eigene Abfrage, damit ein Feldfehler den Sync nicht stoppt.
    const thumbs = new Map<string, string>()
    try {
      const assets = await gadsSearch<Row>(ctx, `
        SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id
        FROM asset WHERE asset.type = 'YOUTUBE_VIDEO'`)
      const ytOf = new Map(assets.map(a => [a.asset?.resourceName, a.asset?.youtubeVideoAsset?.youtubeVideoId]))
      const vids = await gadsSearch<Row>(ctx, `
        SELECT ad_group_ad.ad.id, ad_group_ad.ad.video_ad.video.asset,
               ad_group_ad.ad.video_responsive_ad.videos,
               ad_group_ad.ad.demand_gen_video_responsive_ad.videos
        FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'`)
      for (const v of vids) {
        const ad = v.adGroupAd?.ad ?? {}
        const res = ad.videoAd?.video?.asset ?? ad.videoResponsiveAd?.videos?.[0]?.asset ?? ad.demandGenVideoResponsiveAd?.videos?.[0]?.asset
        const yt = res ? ytOf.get(res) : undefined
        if (yt) thumbs.set(String(ad.id), `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`)
      }
    } catch (e) {
      warnings.push(`Vorschaubilder: ${(e as Error).message.slice(0, 140)}`)
    }

    const catalogRows = cat.map(r => {
      const adId = String(r.adGroupAd?.ad?.id ?? '')
      const campaignStatus = String(r.campaign?.status ?? '')
      const groupStatus = String(r.adGroup?.status ?? '')
      const adStatus = String(r.adGroupAd?.status ?? '')
      // Abgelehnte Anzeige liefert nie aus, auch wenn Kampagne und Anzeige eingeschaltet sind
      const policy = r.adGroupAd?.policySummary ?? {}
      const abgelehnt = policy.approvalStatus === 'DISAPPROVED'
      return {
        ad_id: `gads_${adId}`,
        platform: platformOf(String(r.campaign?.advertisingChannelType ?? '')),
        account_id: ctx.customerId,
        campaign_id: String(r.campaign?.id ?? ''),
        campaign_name: r.campaign?.name ?? null,
        adset_id: String(r.adGroup?.id ?? ''),
        adset_name: r.adGroup?.name ?? null,
        ad_name: r.adGroupAd?.ad?.name || r.adGroup?.name || null,
        status: statusOf(adStatus),
        configured_status: statusOf(adStatus),
        effective_status: campaignStatus !== 'ENABLED' ? 'CAMPAIGN_PAUSED' : groupStatus !== 'ENABLED' ? 'ADSET_PAUSED' : abgelehnt ? 'DISAPPROVED' : statusOf(adStatus),
        review_feedback: policy.approvalStatus ? {
          approval_status: policy.approvalStatus,
          topics: (policy.policyTopicEntries ?? []).map((t: Row) => t.topic).filter(Boolean),
        } : null,
        thumbnail_url: thumbs.get(adId) ?? null,
        updated_at: jetzt,
      }
    }).filter(r => r.ad_id !== 'gads_')
    const platformByAd = new Map(catalogRows.map(r => [r.ad_id, r.platform]))

    // ── 2. Tageswerte je Anzeige ─────────────────────────────────────────────
    const perf = await gadsSearch<Row>(ctx, `
      SELECT segments.date, campaign.id, campaign.advertising_channel_type, ad_group.id, ad_group_ad.ad.id,
             metrics.cost_micros, metrics.impressions, metrics.clicks,
             metrics.video_trueview_views
      FROM ad_group_ad
      WHERE segments.date BETWEEN '${since}' AND '${until}'`)

    // ── 3. Neue Kanal-Abos aus der Conversion-Aktion „YouTube-Kanal-Abos" ────
    const abos = new Map<string, number>()
    try {
      const conv = await gadsSearch<Row>(ctx, `
        SELECT segments.date, ad_group_ad.ad.id, segments.conversion_action_name, metrics.all_conversions
        FROM ad_group_ad
        WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.all_conversions > 0`)
      for (const c of conv) {
        if (!ABO_RE.test(String(c.segments?.conversionActionName ?? ''))) continue
        const k = `${c.segments?.date}|gads_${c.adGroupAd?.ad?.id}`
        abos.set(k, (abos.get(k) ?? 0) + num(c.metrics?.allConversions))
      }
    } catch (e) {
      warnings.push(`Abos: ${(e as Error).message.slice(0, 140)}`)
    }

    const faktor = await eurFactor(info.currency)
    if (!faktor) warnings.push(`Kein Wechselkurs für ${info.currency}, spend_eur bleibt 0.`)
    const insightRows = perf.map(r => {
      const adId = `gads_${r.adGroupAd?.ad?.id}`
      const day = String(r.segments?.date ?? '')
      const spend = num(r.metrics?.costMicros) / 1_000_000
      return {
        day, ad_id: adId,
        platform: platformByAd.get(adId) ?? platformOf(String(r.campaign?.advertisingChannelType ?? '')),
        spend: Math.round(spend * 100) / 100,
        currency: info.currency || 'EUR',
        spend_eur: Math.round(spend * faktor * 100) / 100,
        impressions: num(r.metrics?.impressions),
        link_clicks: num(r.metrics?.clicks),
        thruplays: num(r.metrics?.videoTrueviewViews),
        yt_subscribers: Math.round(abos.get(`${day}|${adId}`) ?? 0),
        campaign_id: String(r.campaign?.id ?? ''),
        adset_id: String(r.adGroup?.id ?? ''),
        synced_at: jetzt,
      }
    }).filter(r => r.day && r.ad_id !== 'gads_undefined')

    if (catalogRows.length) {
      const { error } = await sb.from('ad_catalog').upsert(catalogRows, { onConflict: 'ad_id' })
      if (error) throw new Error(`ad_catalog: ${error.message}`)
    }
    for (let i = 0; i < insightRows.length; i += 500) {
      const { error } = await sb.from('ad_insights_daily').upsert(insightRows.slice(i, i + 500), { onConflict: 'day,ad_id' })
      if (error) throw new Error(`ad_insights_daily: ${error.message}`)
    }

    const summe = insightRows.reduce((a, r) => ({ spend_eur: a.spend_eur + r.spend_eur, abos: a.abos + r.yt_subscribers }), { spend_eur: 0, abos: 0 })
    console.log(`[${FN}] ${info.name} ${ctx.customerId}: ${catalogRows.length} Anzeigen, ${insightRows.length} Tageszeilen, ${summe.spend_eur.toFixed(2)} €, ${summe.abos} Abos, ${warnings.length} Warnungen`)
    return json({
      ok: true, api_version: GADS_VERSION, account: { id: ctx.customerId, name: info.name, currency: info.currency },
      since, until, ads: catalogRows.length, rows: insightRows.length,
      spend_eur: Math.round(summe.spend_eur * 100) / 100, subscribers: summe.abos, warnings,
    })
  } catch (e) {
    const msg = (e as Error).message
    console.error(`[${FN}]`, msg)
    return json({ ok: false, error: msg, warnings }, 200)
  }
})
