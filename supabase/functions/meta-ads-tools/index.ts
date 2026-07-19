// Edge Function: meta-ads-tools
// Werkzeuge für den CRM-Werbemanager (Meta Graph API, Token server-seitig):
//   { mode: 'preview', ad_id }            → FB/IG-Vorschau-iframes + Caption
//   { mode: 'settings', campaign_id }     → ALLE Einstellungen einer Kampagne
//       (Kampagne + Anzeigengruppen inkl. komplettem Targeting + Anzeigen)
//   { mode: 'update_entity', entity_id, daily_budget?, status?, name? }
//       → ändert Budget/Status/Name von Kampagne/Adset/Ad — Guard: Entität muss
//       zu unserem Werbekonto gehören
//   { mode: 'audience_suggest', description, feedback?, previous_draft? }
//       → Freitext → Claude (mit GELERNTEN Regeln + Beispielen aus ads_ai_rules/
//       ads_ai_examples) → Graph-Suche löst echte Targeting-IDs auf → Vorschlag.
//       Mit feedback: Korrektur wird als dauerhafte Regel gespeichert (Lernen!)
//   { mode: 'audience_apply', targeting_draft, description? } → wendet Vorschlag
//       auf die Anzeigengruppe der SYSTEM-Kampagne an (Guard!) und speichert
//       Beschreibung→Targeting als Lern-Beispiel
//
// ── Secrets (Supabase Dashboard → Settings → Edge Functions → Secrets) ──
//   META_ACCESS_TOKEN   = System-User-Token „Analytics Sync"
//   META_AD_ACCOUNT_ID  = 4065490590399677
//   ANTHROPIC_API_KEY   = für die Zielgruppen-Extraktion (bestehendes Secret)
//
// ── Deployment ──
//   supabase functions deploy meta-ads-tools --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GRAPH = 'https://graph.facebook.com/v21.0'

async function graphGet(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const json = await res.json()
  if (!res.ok) throw new Error(`Graph ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 250)}`)
  return json
}

interface AudienceCriteria {
  age_min?: number
  age_max?: number
  genders?: 'alle' | 'maenner' | 'frauen'
  countries?: string[]           // ISO-Codes, z.B. ["DE","AT","CH"]
  interest_keywords?: string[]   // Suchbegriffe für Meta-Interessen
  job_keywords?: string[]        // Suchbegriffe für Jobtitel
  summary?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const token   = Deno.env.get('META_ACCESS_TOKEN')!
    const account = Deno.env.get('META_AD_ACCOUNT_ID') ?? '4065490590399677'
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const mode = String(body.mode ?? '')

    // ── Vorschau: FB Feed / IG Feed / IG Story + Caption ─────────────────────
    if (mode === 'preview') {
      const adId = String(body.ad_id ?? '').replace(/[^0-9]/g, '')
      if (!adId) throw new Error('ad_id fehlt')
      const formats: Record<string, string> = {
        facebook: 'MOBILE_FEED_STANDARD',
        instagram: 'INSTAGRAM_STANDARD',
        story: 'INSTAGRAM_STORY',
      }
      const previews: Record<string, string> = {}
      for (const [key, fmt] of Object.entries(formats)) {
        try {
          const j = await graphGet(`${adId}/previews?ad_format=${fmt}`, token)
          previews[key] = ((j.data as Array<{ body?: string }> | undefined)?.[0]?.body) ?? ''
        } catch (err) {
          console.warn(`[meta-ads-tools] Vorschau ${fmt}:`, err instanceof Error ? err.message : err)
          previews[key] = ''
        }
      }
      const ad = await graphGet(`${adId}?fields=name,status,creative{body,title,thumbnail_url,object_story_spec}`, token)
      const creative = (ad.creative ?? {}) as { body?: string; title?: string; object_story_spec?: { link_data?: { message?: string; name?: string } } }
      const caption = {
        message: creative.object_story_spec?.link_data?.message ?? creative.body ?? '',
        headline: creative.object_story_spec?.link_data?.name ?? creative.title ?? '',
      }
      return json({ success: true, previews, caption, ad_name: ad.name, status: ad.status })
    }

    // ── Voll-Einstellungen einer Kampagne (lesen) ────────────────────────────
    if (mode === 'settings') {
      const campaignId = String(body.campaign_id ?? '').replace(/[^0-9]/g, '')
      if (!campaignId) throw new Error('campaign_id fehlt')
      const campaign = await graphGet(`${campaignId}?fields=name,objective,status,effective_status,special_ad_categories,bid_strategy,daily_budget,lifetime_budget,spend_cap,start_time,stop_time,created_time,buying_type,account_id`, token)
      if (String(campaign.account_id) !== account) throw new Error('Kampagne gehört nicht zu unserem Werbekonto')
      const adsets = await graphGet(`${campaignId}/adsets?fields=id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,optimization_goal,billing_event,promoted_object,destination_type,attribution_spec,start_time,end_time,targeting&limit=25`, token)
      const ads = await graphGet(`${campaignId}/ads?fields=id,name,status,effective_status,adset_id,creative{id,url_tags,object_story_spec{link_data{link,name,call_to_action},page_id}}&limit=50`, token)
      return json({ success: true, campaign, adsets: adsets.data ?? [], ads: ads.data ?? [] })
    }

    // ── Budget/Status/Name direkt ändern (Kampagne, Adset oder Ad) ──────────
    if (mode === 'update_entity') {
      const entityId = String(body.entity_id ?? '').replace(/[^0-9]/g, '')
      if (!entityId) throw new Error('entity_id fehlt')
      // Guard: Entität muss zu unserem Konto gehören
      const check = await graphGet(`${entityId}?fields=account_id`, token)
      if (String(check.account_id) !== account) throw new Error('Entität gehört nicht zu unserem Werbekonto')
      const patch: Record<string, unknown> = {}
      if (body.daily_budget != null) {
        const cents = Math.round(Number(body.daily_budget))
        if (!Number.isFinite(cents) || cents < 100 || cents > 100_000) throw new Error('daily_budget unplausibel (Cent, 100–100000)')
        patch.daily_budget = cents
      }
      if (body.status != null) {
        const s = String(body.status)
        if (s !== 'ACTIVE' && s !== 'PAUSED') throw new Error('status muss ACTIVE oder PAUSED sein')
        patch.status = s
      }
      if (body.name != null && String(body.name).trim()) patch.name = String(body.name).trim().slice(0, 120)
      if (!Object.keys(patch).length) throw new Error('Nichts zu ändern übergeben')
      const res = await fetch(`${GRAPH}/${entityId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const j = await res.json()
      if (!res.ok || j?.success === false) throw new Error(`Update: ${JSON.stringify(j?.error?.error_user_msg ?? j?.error?.message ?? j).slice(0, 250)}`)
      console.log(`[meta-ads-tools] update_entity ${entityId}:`, JSON.stringify(patch))
      return json({ success: true, entity_id: entityId, applied: patch })
    }

    // ── Zielgruppen-Vorschlag aus Freitext ───────────────────────────────────
    if (mode === 'audience_suggest') {
      const description = String(body.description ?? '').trim().slice(0, 2000)
      if (!description) throw new Error('description fehlt')
      const feedback = String(body.feedback ?? '').trim().slice(0, 500)

      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

      // Lernen Teil 1: Feedback wird dauerhafte Regel für ALLE künftigen Vorschläge
      if (feedback) {
        const { error } = await supabase.from('ads_ai_rules').insert({ kind: 'audience', rule: feedback })
        if (error) console.warn('[meta-ads-tools] Regel speichern:', error.message)
        else console.log('[meta-ads-tools] Neue Regel gelernt:', feedback)
      }

      // Lernen Teil 2: gespeicherte Regeln + die letzten bestätigten Beispiele in den Prompt
      const { data: ruleRows } = await supabase.from('ads_ai_rules')
        .select('rule').eq('kind', 'audience').eq('active', true)
        .order('created_at', { ascending: false }).limit(20)
      const rules = ((ruleRows ?? []) as { rule: string }[]).map(r => `- ${r.rule}`).join('\n')
      const { data: exampleRows } = await supabase.from('ads_ai_examples')
        .select('description, applied_draft')
        .order('created_at', { ascending: false }).limit(5)
      const examples = ((exampleRows ?? []) as { description: string; applied_draft: unknown }[])
        .map(e => `Beschreibung: "${e.description}"\nÜbernommenes Targeting: ${JSON.stringify(e.applied_draft)}`)
        .join('\n\n')

      // 1) Claude: Freitext → strukturierte Kriterien (mit Gelerntem)
      const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 700,
          messages: [{
            role: 'user',
            content: `Du übersetzt eine Zielgruppen-Beschreibung in Meta-Ads-Targeting-Kriterien für einen deutschen Immobilien-Investment-Anbieter (Neubau Zypern, Kunden = deutschsprachige Kapitalanleger).
${rules ? `\nVom Werbetreibenden GELERNTE REGELN (immer beachten, überstimmen Defaults):\n${rules}\n` : ''}${examples ? `\nFrühere BESTÄTIGTE Beispiele (so versteht der Werbetreibende seine Beschreibungen):\n${examples}\n` : ''}${body.previous_draft ? `\nVorheriger Vorschlag (der Werbetreibende will ihn korrigiert haben):\n${JSON.stringify(body.previous_draft)}\n` : ''}${feedback ? `\nAKTUELLE KORREKTUR des Werbetreibenden (unbedingt umsetzen):\n"${feedback}"\n` : ''}
Beschreibung des Werbetreibenden:
"""${description}"""

Antworte NUR mit einem JSON-Objekt (kein Markdown, keine Erklärung):
{
  "age_min": Zahl (18-65, Default 25),
  "age_max": Zahl (18-65, Default 65),
  "genders": "alle" | "maenner" | "frauen",
  "countries": ["DE", ...] (ISO-Codes; Default ["DE"]; DACH = DE,AT,CH),
  "interest_keywords": [3-8 deutsche Suchbegriffe für Meta-Interessen, konkret und einzeln, z.B. "Immobilienanlagen", "Vermögensverwaltung", "Auswandern"],
  "job_keywords": [0-5 englische Jobtitel-Suchbegriffe falls die Beschreibung Berufe/Positionen nennt, z.B. "CEO", "Business Owner"],
  "summary": "1 Satz auf Deutsch, wen das Targeting erreicht"
}`,
          }],
        }),
      })
      const aiJson = await aiRes.json()
      if (!aiRes.ok) throw new Error(`Claude ${aiRes.status}: ${JSON.stringify(aiJson).slice(0, 200)}`)
      const text = (aiJson.content?.[0]?.text ?? '{}') as string
      const criteria = JSON.parse(text.replace(/^```json?\s*|```\s*$/g, '')) as AudienceCriteria

      // 2) Graph-Suche: Begriffe → echte IDs (Top-Treffer je Begriff)
      const interests: Array<{ id: string; name: string; audience?: number }> = []
      for (const kw of (criteria.interest_keywords ?? []).slice(0, 8)) {
        try {
          const j = await graphGet(`search?type=adinterest&q=${encodeURIComponent(kw)}&limit=2`, token)
          for (const hit of ((j.data ?? []) as Array<{ id: string; name: string; audience_size_upper_bound?: number }>).slice(0, 1)) {
            if (!interests.some(x => x.id === hit.id)) interests.push({ id: hit.id, name: hit.name, audience: hit.audience_size_upper_bound })
          }
        } catch { /* einzelner Begriff darf scheitern */ }
      }
      const jobs: Array<{ id: string; name: string }> = []
      for (const kw of (criteria.job_keywords ?? []).slice(0, 5)) {
        try {
          const j = await graphGet(`search?type=adworkposition&q=${encodeURIComponent(kw)}&limit=2`, token)
          for (const hit of ((j.data ?? []) as Array<{ id: string; name: string }>).slice(0, 1)) {
            if (!jobs.some(x => x.id === hit.id)) jobs.push({ id: hit.id, name: hit.name })
          }
        } catch { /* einzelner Begriff darf scheitern */ }
      }

      return json({
        success: true,
        draft: {
          age_min: Math.min(Math.max(criteria.age_min ?? 25, 18), 65),
          age_max: Math.min(Math.max(criteria.age_max ?? 65, 18), 65),
          genders: criteria.genders ?? 'alle',
          countries: (criteria.countries?.length ? criteria.countries : ['DE']).map(c => c.toUpperCase()).slice(0, 5),
          interests,
          jobs,
          summary: criteria.summary ?? '',
        },
      })
    }

    // ── Vorschlag anwenden (NUR System-Kampagne) ─────────────────────────────
    if (mode === 'audience_apply') {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: st } = await supabase.from('ad_settings').select('system_campaign_id').eq('id', 'default').maybeSingle()
      const sysCampaign = (st as { system_campaign_id?: string } | null)?.system_campaign_id
      if (!sysCampaign) throw new Error('Keine System-Kampagne konfiguriert')

      const d = body.targeting_draft as {
        age_min: number; age_max: number; genders: string; countries: string[]
        interests: Array<{ id: string; name: string }>
        jobs: Array<{ id: string; name: string }>
      } | undefined
      if (!d || !Array.isArray(d.interests)) throw new Error('targeting_draft fehlt')

      // Adset(s) der System-Kampagne finden
      const adsets = await graphGet(`${sysCampaign}/adsets?fields=id,name&limit=10`, token)
      const adsetId = ((adsets.data ?? []) as Array<{ id: string }>)[0]?.id
      if (!adsetId) throw new Error('Kein Adset in der System-Kampagne gefunden')

      const flexible: Array<Record<string, unknown>> = []
      if (d.interests.length) flexible.push({ interests: d.interests.map(x => ({ id: x.id, name: x.name })) })
      if (d.jobs?.length) flexible.push({ work_positions: d.jobs.map(x => ({ id: x.id, name: x.name })) })
      const targeting: Record<string, unknown> = {
        age_min: d.age_min, age_max: d.age_max,
        geo_locations: { countries: d.countries },
        ...(d.genders === 'maenner' ? { genders: [1] } : d.genders === 'frauen' ? { genders: [2] } : {}),
        ...(flexible.length ? { flexible_spec: flexible } : {}),
      }
      const res = await fetch(`${GRAPH}/${adsetId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targeting }),
      })
      const j = await res.json()
      if (!res.ok || j?.success === false) throw new Error(`Adset-Update: ${JSON.stringify(j?.error?.error_user_msg ?? j?.error?.message ?? j).slice(0, 250)}`)
      console.log(`[meta-ads-tools] Targeting angewendet auf Adset ${adsetId} (Kampagne ${sysCampaign})`)

      // Lernen: bestätigte Beschreibung→Targeting-Paare sind die besten Beispiele
      const description = String(body.description ?? '').trim().slice(0, 2000)
      if (description) {
        const { error } = await supabase.from('ads_ai_examples').insert({ description, applied_draft: d })
        if (error) console.warn('[meta-ads-tools] Beispiel speichern:', error.message)
      }
      return json({ success: true, adset_id: adsetId })
    }

    throw new Error(`Unbekannter mode "${mode}"`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[meta-ads-tools]', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  function json(obj: Record<string, unknown>) {
    return new Response(JSON.stringify(obj), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
