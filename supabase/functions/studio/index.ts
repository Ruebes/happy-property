// Edge Function: studio  (früher „ad-studio")
// KI-Anzeigen-Studio des Werbemanagers: Sven beschreibt, was er will
// („Erstelle mir ein Karussell vom Projekt Luma") — die Function baut daraus
// einen Anzeigen-Entwurf (Copy + Bild/Karten), lässt ihn per Chat verfeinern
// und legt ihn auf Wunsch als PAUSIERTE Anzeige in der System-Kampagne an.
//
// WARUM DER NAME „studio" UND NICHT „ad-studio": Werbeblocker filtern URLs
// mit „ad-"-Mustern — der Aufruf von /functions/v1/ad-studio kam bei Sven
// nie am Server an („Failed to send a request", 22.7.). Der alte Slug bleibt
// als Shim deployt (ad-studio/index.ts importiert diese Datei), damit alte
// gecachte Frontends weiterlaufen. NIE wieder Functions mit „ad-" benennen!
//
//   { mode: 'generate', brief }                  → Entwurf (single | carousel)
//   { mode: 'refine',   draft, instruction }     → Chat-Änderung (Caption ODER Bild)
//   { mode: 'publish',  draft }                  → Creative + Ad (PAUSED) in der System-Kampagne
//
// Karussell nutzt ECHTE Projektfotos: crm_projects.images + die Drive-
// synchronisierte Galerie aus deck_assets.gallery (keine KI-Bilder).
// Einzelbild nutzt Svens Basisfoto + gpt-image-1 (input_fidelity=high) und
// beachtet die gelernten Creative-Regeln aus ads_ai_rules (kind='creative').
//
// ── Secrets ──  META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, ANTHROPIC_API_KEY, OPENAI_API_KEY
// ── Deployment ──  supabase functions deploy studio --no-verify-jwt
//                   supabase functions deploy ad-studio --no-verify-jwt   (Shim)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess, AdsAuthError } from '../_shared/adsAuth.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GRAPH = 'https://graph.facebook.com/v21.0'
const PAGE_ID = '556440087559971'
const SVEN_PHOTO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg'
const URL_TAGS = 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}'
const LINK = 'https://portal.happy-property.com/termin'

interface Card { title: string; description: string; image_url: string }
interface Draft {
  format: 'single' | 'carousel'
  headline: string
  message: string
  image_url?: string
  cards?: Card[]
}

async function claude(prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1600, messages: [{ role: 'user', content: prompt }] }),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`Claude ${res.status}: ${JSON.stringify(j).slice(0, 200)}`)
  return (j.content?.[0]?.text ?? '') as string
}

const parseJson = <T>(text: string): T => JSON.parse(text.replace(/^```json?\s*|```\s*$/g, '').trim()) as T

// gpt-image-1: Basisbild + Prompt → PNG-Bytes (hohe Gesichtstreue)
async function generateImage(baseUrl: string, prompt: string): Promise<Uint8Array> {
  const baseRes = await fetch(baseUrl)
  if (!baseRes.ok) throw new Error(`Basisbild ${baseRes.status}`)
  const baseBytes = new Uint8Array(await baseRes.arrayBuffer())
  const form = new FormData()
  form.append('model', 'gpt-image-1')
  form.append('image[]', new Blob([baseBytes], { type: 'image/jpeg' }), 'base.jpg')
  form.append('prompt', prompt)
  form.append('size', '1024x1024')
  form.append('quality', 'high')
  form.append('input_fidelity', 'high')
  form.append('n', '1')
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')!}` }, body: form,
  })
  const j = await res.json()
  if (!res.ok || !j.data?.[0]?.b64_json) throw new Error(`OpenAI: ${JSON.stringify(j.error ?? j).slice(0, 200)}`)
  return Uint8Array.from(atob(j.data[0].b64_json), c => c.charCodeAt(0))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  const json = (obj: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  try {
    // Rechte-Guard: läuft mit --no-verify-jwt, kann aber Anzeigen anlegen und
    // KI-Bilder erzeugen (kostet Geld) — deshalb Login + 'werbung'-Recht Pflicht.
    await requireAdsAccess(req)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = Deno.env.get('META_ACCESS_TOKEN')!
    const account = Deno.env.get('META_AD_ACCOUNT_ID') ?? '4065490590399677'
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const mode = String(body.mode ?? '')

    // Gelernte Creative-Regeln (Svens Feedback, z.B. Fotorealismus-Regel)
    const { data: ruleRows } = await supabase.from('ads_ai_rules')
      .select('rule').eq('kind', 'creative').eq('active', true)
      .order('created_at', { ascending: false }).limit(15)
    const creativeRules = ((ruleRows ?? []) as { rule: string }[]).map(r => `- ${r.rule}`).join('\n')

    const storeImage = async (bytes: Uint8Array): Promise<string> => {
      const path = `studio/${crypto.randomUUID()}.png`
      const { error } = await supabase.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png' })
      if (error) throw new Error(`Storage: ${error.message}`)
      return `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
    }

    // ── Entwurf erzeugen ─────────────────────────────────────────────────────
    if (mode === 'generate') {
      const brief = String(body.brief ?? '').trim().slice(0, 2000)
      if (!brief) throw new Error('brief fehlt')

      // Projekte mit echten Fotos als Material für Karussells.
      // Fotoquellen: crm_projects.images (manuell gepflegt) + deck_assets.gallery
      // (aus dem Google Drive synchronisiert) — zusammen, dedupliziert, max. 12
      // je Projekt, damit der Prompt nicht explodiert. Bauträger steht mit dabei,
      // weil Sven Projekte oft über den Bauträger benennt („MITO" = Mamba etc.).
      const { data: projects } = await supabase.from('crm_projects')
        .select('name, developer, images, deck_assets')
      const projectInfo = ((projects ?? []) as Array<{
        name: string; developer: string | null
        images: string[] | null
        deck_assets: { gallery?: string[] } | null
      }>)
        .map(p => {
          const photos = [...new Set([...(p.images ?? []), ...(p.deck_assets?.gallery ?? [])])].slice(0, 12)
          return { ...p, photos }
        })
        .filter(p => p.photos.length)
        .map(p => `- ${p.name}${p.developer ? ` (Bauträger: ${p.developer})` : ''}: ${p.photos.length} Fotos [${p.photos.join(' | ')}]`)
        .join('\n')

      const plan = parseJson<{
        format: 'single' | 'carousel'
        headline: string
        message: string
        image_prompt?: string
        cards?: Array<{ title: string; description: string; image_url: string }>
      }>(await claude(`Du bist der Anzeigen-Texter von Happy Property (Immobilien-Investment Zypern, Zielgruppe deutschsprachige Kapitalanleger, Du-Ansprache, Stil der bisherigen Gewinner-Ads: emotionaler Einstieg über Schmerzpunkte wie Steuern/Bürokratie/Wetter, dann Zypern-Vorteile mit ✅-Aufzählung, klare Aufforderung zum kostenlosen Beratungsgespräch über den Online-Terminkalender).

AUFTRAG von Sven:
"""${brief}"""

Verfügbare Projekte mit ECHTEN Fotos (für Karussells IMMER diese echten Foto-URLs verwenden). Sven nennt Projekte oft über den BAUTRÄGER oder mit Tippfehlern — ordne selbstständig dem passenden Projekt aus der Liste zu (z.B. „Luma" = Bauträger von Genesis/Emerald Park/Skala, „MITO"/„Mito Mama" = Bauträger Mito, gemeint ist meist Mamba). Findest du kein passendes Projekt, wähle format=carousel NICHT mit erfundenen URLs, sondern liefere cards=[] — der Fehler sagt Sven dann, dass Fotos fehlen:
${projectInfo || '(keine Projektfotos vorhanden)'}
${creativeRules ? `\nGELERNTE REGELN für Bilder (bei image_prompt beachten):\n${creativeRules}` : ''}
Antworte NUR mit JSON:
{
  "format": "single" | "carousel"  (Karussell wenn der Auftrag Projekte/mehrere Karten nahelegt),
  "headline": "max. 40 Zeichen",
  "message": "die komplette Caption (Hauptext) im Gewinner-Stil, mit Absätzen und ✅",
  "image_prompt": "NUR bei single: deutscher Prompt für ein Bild mit Sven — Original-Pose beibehalten, nur Umgebung passend zum Auftrag ändern, fotorealistisch-dokumentarisch",
  "cards": [NUR bei carousel, 2-6 Karten: {"title": "max. 35 Zeichen", "description": "max. 60 Zeichen", "image_url": "eine der echten Projekt-Foto-URLs"}]
}`))

      const draft: Draft = { format: plan.format, headline: plan.headline, message: plan.message }
      if (plan.format === 'single') {
        const bytes = await generateImage(SVEN_PHOTO, plan.image_prompt ?? 'Fotorealistische Szene mit dem Mann aus dem Foto, Umgebung modernes Neubauprojekt am Mittelmeer, Original-Pose beibehalten, neutrales Tageslicht, kein Text')
        draft.image_url = await storeImage(bytes)
      } else {
        draft.cards = (plan.cards ?? []).slice(0, 6)
        if (!draft.cards.length) throw new Error('Zum genannten Projekt habe ich keine Fotos — bitte Fotos im Projekt hinterlegen (oder Drive-Sync abwarten) und nochmal versuchen')
      }
      return json({ success: true, draft })
    }

    // ── Chat-Verfeinerung (Caption ODER Bild) ────────────────────────────────
    if (mode === 'refine') {
      const draft = body.draft as Draft | undefined
      const instruction = String(body.instruction ?? '').trim().slice(0, 1000)
      if (!draft || !instruction) throw new Error('draft/instruction fehlt')

      const decision = parseJson<{ target: 'caption' | 'image' | 'cards'; headline?: string; message?: string; image_prompt?: string; cards?: Card[] }>(
        await claude(`Sven bearbeitet einen Anzeigen-Entwurf per Chat. Entscheide, was er ändern will, und liefere die Änderung.

AKTUELLER ENTWURF:
${JSON.stringify(draft)}

SVENS ANWEISUNG:
"""${instruction}"""
${creativeRules ? `\nGELERNTE BILD-REGELN (bei image_prompt beachten):\n${creativeRules}` : ''}
Antworte NUR mit JSON:
- Text-/Caption-Änderung: {"target":"caption","headline":"...","message":"..."} (beides vollständig, mit der Änderung umgesetzt)
- Bild-Änderung (nur bei format=single): {"target":"image","image_prompt":"deutscher Prompt: Original-Pose des Mannes beibehalten, Änderung laut Anweisung, fotorealistisch-dokumentarisch, kein Text im Bild"}
- Karten-Änderung (nur bei format=carousel): {"target":"cards","cards":[...komplette aktualisierte Kartenliste, image_url beibehalten...]}
Betrifft die Anweisung MEHRERES (z.B. Karten UND Headline), liefere target für den Haupt-Teil und lege headline/message ZUSÄTZLICH bei — sie werden immer übernommen, wenn vorhanden.`))

      const updated: Draft = { ...draft }
      // headline/message werden IMMER übernommen, wenn geliefert (kombinierte Anweisungen)
      if (decision.headline) updated.headline = decision.headline
      if (decision.message) updated.message = decision.message
      if (decision.target === 'caption') {
        updated.headline = decision.headline ?? draft.headline
        updated.message = decision.message ?? draft.message
      } else if (decision.target === 'image' && draft.format === 'single') {
        const bytes = await generateImage(draft.image_url ?? SVEN_PHOTO, decision.image_prompt ?? instruction)
        updated.image_url = await storeImage(bytes)
      } else if (decision.target === 'cards' && draft.format === 'carousel') {
        updated.cards = (decision.cards ?? draft.cards ?? []).slice(0, 6)
      }
      return json({ success: true, draft: updated, changed: decision.target })
    }

    // ── Als pausierte Anzeige in der System-Kampagne anlegen ─────────────────
    if (mode === 'publish') {
      const draft = body.draft as Draft | undefined
      if (!draft?.headline || !draft?.message) throw new Error('draft unvollständig')

      const { data: st } = await supabase.from('ad_settings').select('system_campaign_id').eq('id', 'default').maybeSingle()
      const sysCampaign = (st as { system_campaign_id?: string } | null)?.system_campaign_id
      if (!sysCampaign) throw new Error('Keine System-Kampagne konfiguriert')
      const adsetsRes = await fetch(`${GRAPH}/${sysCampaign}/adsets?fields=id&limit=5`, { headers: { Authorization: `Bearer ${token}` } })
      const adsetsJson = await adsetsRes.json()
      const adsetId = adsetsJson.data?.[0]?.id
      if (!adsetId) throw new Error('Kein Adset in der System-Kampagne')

      const uploadToMeta = async (url: string): Promise<string> => {
        const imgRes = await fetch(url)
        if (!imgRes.ok) throw new Error(`Bild laden ${imgRes.status}`)
        const form = new FormData()
        form.append('filename', new Blob([new Uint8Array(await imgRes.arrayBuffer())], { type: 'image/png' }), `studio-${Date.now()}.png`)
        const up = await fetch(`${GRAPH}/act_${account}/adimages`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
        const upJson = await up.json()
        if (!up.ok) throw new Error(`Meta-Upload: ${JSON.stringify(upJson.error ?? upJson).slice(0, 150)}`)
        return (Object.values(upJson.images)[0] as { hash: string }).hash
      }

      const linkData: Record<string, unknown> = { link: LINK, message: draft.message, call_to_action: { type: 'BOOK_NOW' } }
      if (draft.format === 'single') {
        if (!draft.image_url) throw new Error('Bild fehlt')
        linkData.name = draft.headline
        linkData.image_hash = await uploadToMeta(draft.image_url)
      } else {
        linkData.name = draft.headline
        linkData.child_attachments = await Promise.all((draft.cards ?? []).map(async c => ({
          link: LINK, name: c.title.slice(0, 40), description: c.description.slice(0, 80),
          image_hash: await uploadToMeta(c.image_url),
        })))
        linkData.multi_share_optimized = true
        linkData.multi_share_end_card = false
      }
      const creativeRes = await fetch(`${GRAPH}/act_${account}/adcreatives`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Studio – ${draft.headline}`.slice(0, 100),
          url_tags: URL_TAGS,
          object_story_spec: { page_id: PAGE_ID, link_data: linkData },
        }),
      })
      const creativeJson = await creativeRes.json()
      if (!creativeRes.ok) {
        const sub = creativeJson?.error?.error_subcode
        if (sub === 1885183) return json({ error: 'app_dev_mode', hint: 'Die Meta-App „appy Property Analytics" (ID 1645131469886027) steht noch im Entwicklungsmodus — auf developers.facebook.com auf „Live" schalten, dann klappt das Anlegen aus dem Studio.' }, 500)
        throw new Error(`Creative: ${JSON.stringify(creativeJson.error?.error_user_msg ?? creativeJson.error?.message ?? creativeJson).slice(0, 250)}`)
      }
      const adRes = await fetch(`${GRAPH}/act_${account}/ads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Studio – ${draft.headline}`.slice(0, 100),
          adset_id: adsetId,
          creative: { creative_id: creativeJson.id },
          status: 'PAUSED',
        }),
      })
      const adJson = await adRes.json()
      if (!adRes.ok) throw new Error(`Ad: ${JSON.stringify(adJson.error?.message ?? adJson).slice(0, 200)}`)
      console.log(`[ad-studio] Anzeige angelegt (PAUSED): ${adJson.id}`)
      return json({ success: true, ad_id: adJson.id, creative_id: creativeJson.id })
    }

    throw new Error(`Unbekannter mode "${mode}"`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AdsAuthError ? err.status : 500
    console.error('[studio]', status, msg)
    return json({ error: msg }, status)
  }
})
