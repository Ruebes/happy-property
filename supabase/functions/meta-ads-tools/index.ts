// Edge Function: meta-ads-tools
// Werkzeuge für den CRM-Werbemanager (Meta Graph API, Token server-seitig):
//   { mode: 'preview', ad_id }            → FB/IG-Vorschau-iframes + Caption
//   { mode: 'settings', campaign_id }     → ALLE Einstellungen einer Kampagne
//       (Kampagne + Anzeigengruppen inkl. komplettem Targeting + Anzeigen)
//   { mode: 'update_entity', entity_id, entity_type, patch: {...} }
//       → ändert ALLE bei Meta änderbaren Felder von Kampagne/Adset/Ad.
//       Guard: Entität muss zu unserem Werbekonto gehören; je Ebene gilt eine
//       Feld-Allowlist (siehe EDITABLE_FIELDS unten).
//   { mode: 'targeting_apply', adset_id, targeting }
//       → schreibt ein komplettes Targeting-Objekt auf EINE Anzeigengruppe
//       (Guard: Adset muss zu unserem Konto gehören)
//   { mode: 'targeting_search', kind, q }
//       → Autocomplete für den Zielgruppen-Editor (Interessen, Jobtitel,
//       Verhalten, Orte) — proxyt Metas /search
//   { mode: 'custom_audiences' } → Custom Audiences unseres Kontos (für Auswahl)
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
import { requireAdsAccess, AdsAuthError } from '../_shared/adsAuth.ts'

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

// ── Welche Felder dürfen auf welcher Ebene geschrieben werden ────────────────
// Bewusst als Allowlist: alles, was Meta zwar zurückliefert, aber nach dem
// Anlegen NICHT mehr ändert (objective, buying_type, billing_event,
// special_ad_categories), bleibt draußen — sonst quittiert Meta die Änderung
// scheinbar erfolgreich und das Feld bleibt trotzdem stehen.
const EDITABLE_FIELDS: Record<string, string[]> = {
  campaign: ['name', 'status', 'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_strategy', 'start_time', 'stop_time'],
  adset:    ['name', 'status', 'daily_budget', 'lifetime_budget', 'bid_amount', 'bid_strategy', 'optimization_goal', 'start_time', 'end_time', 'targeting'],
  ad:       ['name', 'status'],
}

const BID_STRATEGIES = new Set(['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'])
const OPTIMIZATION_GOALS = new Set([
  'OFFSITE_CONVERSIONS', 'LINK_CLICKS', 'LEAD_GENERATION', 'REACH', 'IMPRESSIONS',
  'LANDING_PAGE_VIEWS', 'THRUPLAY', 'QUALITY_LEAD', 'QUALITY_CALL', 'VALUE', 'APP_INSTALLS',
])
// Geldbeträge kommen in Cent der Konto-Währung (USD). 1 $ … 5.000 $ ist der
// plausible Rahmen für dieses Konto — schützt vor Tippfehlern wie 5000 statt 50.
const MONEY_MIN = 100
const MONEY_MAX = 500_000

function money(value: unknown, label: string): number {
  const cents = Math.round(Number(value))
  if (!Number.isFinite(cents) || cents < MONEY_MIN || cents > MONEY_MAX) {
    throw new Error(`${label} unplausibel (Cent, ${MONEY_MIN}–${MONEY_MAX})`)
  }
  return cents
}

function isoTime(value: unknown, label: string): string {
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) throw new Error(`${label} ist kein gültiges Datum`)
  return d.toISOString()
}

/** Baut aus dem Roh-Patch das validierte Graph-Patch für die jeweilige Ebene. */
function buildPatch(entityType: string, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = EDITABLE_FIELDS[entityType]
  if (!allowed) throw new Error(`Unbekannter entity_type "${entityType}"`)

  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value == null || value === '') continue
    if (!allowed.includes(key)) {
      throw new Error(`Feld "${key}" ist auf Ebene "${entityType}" nicht änderbar`)
    }
    switch (key) {
      case 'name': {
        const n = String(value).trim()
        if (!n) throw new Error('Name darf nicht leer sein')
        patch.name = n.slice(0, 400)
        break
      }
      case 'status': {
        const s = String(value)
        if (s !== 'ACTIVE' && s !== 'PAUSED') throw new Error('status muss ACTIVE oder PAUSED sein')
        patch.status = s
        break
      }
      case 'daily_budget':    patch.daily_budget    = money(value, 'Tagesbudget');    break
      case 'lifetime_budget': patch.lifetime_budget = money(value, 'Laufzeitbudget'); break
      case 'spend_cap':       patch.spend_cap       = money(value, 'Ausgabenlimit');  break
      case 'bid_amount':      patch.bid_amount      = money(value, 'Gebot');          break
      case 'bid_strategy': {
        const s = String(value)
        if (!BID_STRATEGIES.has(s)) throw new Error(`Unbekannte Gebotsstrategie "${s}"`)
        patch.bid_strategy = s
        break
      }
      case 'optimization_goal': {
        const s = String(value)
        if (!OPTIMIZATION_GOALS.has(s)) throw new Error(`Unbekanntes Optimierungsziel "${s}"`)
        patch.optimization_goal = s
        break
      }
      case 'start_time': patch.start_time = isoTime(value, 'Startzeit'); break
      case 'stop_time':  patch.stop_time  = isoTime(value, 'Endzeit');   break
      case 'end_time':   patch.end_time   = isoTime(value, 'Endzeit');   break
      case 'targeting': {
        if (typeof value !== 'object' || Array.isArray(value)) throw new Error('targeting muss ein Objekt sein')
        const tg = value as Record<string, unknown>
        const geo = tg.geo_locations as Record<string, unknown> | undefined
        const hasGeo = geo && Object.values(geo).some(v => Array.isArray(v) && v.length)
        // Ohne Ort liefert Meta einen unverständlichen Fehler — hier klar abfangen.
        if (!hasGeo) throw new Error('Zielgruppe braucht mindestens ein Land, eine Region oder eine Stadt')
        patch.targeting = tg
        break
      }
    }
  }
  if (!Object.keys(patch).length) throw new Error('Nichts zu ändern übergeben')
  // daily_budget und lifetime_budget schließen sich bei Meta gegenseitig aus.
  if (patch.daily_budget && patch.lifetime_budget) {
    throw new Error('Tagesbudget und Laufzeitbudget können nicht gleichzeitig gesetzt werden')
  }
  return patch
}

/** POST auf die Graph-API mit einheitlicher Fehlermeldung (Metas Klartext bevorzugt). */
async function graphPost(id: string, patch: Record<string, unknown>, token: string): Promise<void> {
  const res = await fetch(`${GRAPH}/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const j = await res.json()
  if (!res.ok || j?.success === false) {
    const err = j?.error ?? {}
    throw new Error(String(err.error_user_msg ?? err.message ?? JSON.stringify(j)).slice(0, 300))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    // Rechte-Guard: die Function läuft mit --no-verify-jwt, deshalb hier prüfen.
    await requireAdsAccess(req)

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

    // ── Einstellungen ändern (Kampagne, Adset oder Ad) ──────────────────────
    if (mode === 'update_entity') {
      const entityId = String(body.entity_id ?? '').replace(/[^0-9]/g, '')
      if (!entityId) throw new Error('entity_id fehlt')
      const entityType = String(body.entity_type ?? '')
      // Guard: Entität muss zu unserem Konto gehören
      const check = await graphGet(`${entityId}?fields=account_id`, token)
      if (String(check.account_id) !== account) throw new Error('Entität gehört nicht zu unserem Werbekonto')

      const raw = (body.patch ?? {}) as Record<string, unknown>
      const patch = buildPatch(entityType, raw)
      await graphPost(entityId, patch, token)
      console.log(`[meta-ads-tools] update_entity ${entityType} ${entityId}:`, JSON.stringify(patch))

      // Spiegel mitziehen: sonst zeigt die Tabelle bis zum nächsten Sync den
      // alten Status/Namen, obwohl bei Meta längst geändert wurde.
      if (entityType === 'ad' && (patch.status || patch.name)) {
        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        const mirror: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (patch.status) mirror.status = patch.status
        if (patch.name)   mirror.ad_name = patch.name
        const { error } = await supabase.from('ad_catalog').update(mirror).eq('ad_id', entityId)
        if (error) console.warn('[meta-ads-tools] ad_catalog-Spiegel:', error.message)
      }
      return json({ success: true, entity_id: entityId, applied: patch })
    }

    // ── Komplettes Targeting auf EINE Anzeigengruppe schreiben ──────────────
    // Anders als audience_apply (nur System-Kampagne, KI-Entwurf) schreibt das
    // hier den handgebauten Entwurf aus dem Zielgruppen-Editor auf ein
    // beliebiges Adset unseres Kontos.
    if (mode === 'targeting_apply') {
      const adsetId = String(body.adset_id ?? '').replace(/[^0-9]/g, '')
      if (!adsetId) throw new Error('adset_id fehlt')
      const check = await graphGet(`${adsetId}?fields=account_id`, token)
      if (String(check.account_id) !== account) throw new Error('Anzeigengruppe gehört nicht zu unserem Werbekonto')

      const patch = buildPatch('adset', { targeting: body.targeting })
      await graphPost(adsetId, patch, token)
      console.log(`[meta-ads-tools] targeting_apply ${adsetId}`)
      return json({ success: true, adset_id: adsetId })
    }

    // ── Autocomplete für den Zielgruppen-Editor ─────────────────────────────
    if (mode === 'targeting_search') {
      const kind = String(body.kind ?? '')
      const q = String(body.q ?? '').trim().slice(0, 100)
      // Verhalten ist bei Meta KEINE Freitextsuche, sondern eine feste Kategorie-
      // Liste (type=adTargetingCategory&class=behaviors). Wir holen die ganze
      // Liste und filtern serverseitig nach dem Suchbegriff.
      let params: string
      if (kind === 'behavior') {
        params = `search?type=adTargetingCategory&class=behaviors&limit=400`
      } else {
        const kinds: Record<string, string> = {
          interest: 'adinterest',
          job:      'adworkposition',
          employer: 'adworkemployer',
          geo:      'adgeolocation',
        }
        const type = kinds[kind]
        if (!type) throw new Error(`Unbekannte Suchart "${kind}"`)
        if (!q) throw new Error('Suchbegriff fehlt')
        params = `search?type=${type}&q=${encodeURIComponent(q)}&limit=25`
      }
      const res = await graphGet(params, token)
      let rows = (res.data ?? []) as Array<Record<string, unknown>>
      // Verhalten kommt als Gesamtliste — hier nach dem Suchbegriff filtern
      if (kind === 'behavior' && q) {
        const needle = q.toLowerCase()
        rows = rows.filter(r => String(r.name ?? '').toLowerCase().includes(needle)).slice(0, 25)
      }
      const results = rows.map(r => ({
        id: String(r.id ?? r.key ?? ''),
        name: String(r.name ?? ''),
        // Ortssuche liefert Typ (country/region/city) + Land zur Unterscheidung
        type: r.type ? String(r.type) : undefined,
        country_code: r.country_code ? String(r.country_code) : undefined,
        region: r.region ? String(r.region) : undefined,
        path: Array.isArray(r.path) ? (r.path as string[]).join(' › ') : undefined,
        audience: typeof r.audience_size_upper_bound === 'number' ? r.audience_size_upper_bound : undefined,
      })).filter(r => r.id && r.name)
      return json({ success: true, results })
    }

    // ── Custom Audiences unseres Kontos (Auswahlliste im Editor) ────────────
    if (mode === 'custom_audiences') {
      const res = await graphGet(`act_${account}/customaudiences?fields=id,name,approximate_count_lower_bound,subtype&limit=200`, token)
      const rows = (res.data ?? []) as Array<Record<string, unknown>>
      return json({
        success: true,
        audiences: rows.map(r => ({
          id: String(r.id), name: String(r.name ?? ''),
          size: typeof r.approximate_count_lower_bound === 'number' ? r.approximate_count_lower_bound : undefined,
          subtype: r.subtype ? String(r.subtype) : undefined,
        })),
      })
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
    const status = err instanceof AdsAuthError ? err.status : 500
    console.error('[meta-ads-tools]', status, msg)
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  function json(obj: Record<string, unknown>) {
    return new Response(JSON.stringify(obj), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
