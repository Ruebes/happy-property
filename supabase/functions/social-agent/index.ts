// social-agent — Motor des Social-Media-Tools (Facebook/Instagram/LinkedIn, organisch).
//
// Aktionen:
//   chat        { post_id, message }   → hochwertiger Post-Chat (Claude, volles Firmen-
//               wissen). Der Agent ANTWORTET und kann den Post-Text direkt setzen
//               (Tool set_post) — das Textfeld im Studio aktualisiert sich live.
//   image       { post_id, prompt? }   → Bild via Higgsfield (Soul Location,
//               fotorealistisch, Svens Abo) → Bucket ad-creatives/social/…
//               (public) → social_posts.image_url. NUR Higgsfield, kein OpenAI.
//   news_scan   {}                     → Websuche nach aktuellen Immobilien-News
//               (Zypern + Deutschland) → Aufgabe für Sven (Startseite) mit den
//               Fundstücken + Post-Winkeln. Läuft auch per Cron (Mo+Do).
//   publish     { post_id }            → auf die gewählten Plattformen posten.
//               Facebook/Instagram über META_ACCESS_TOKEN (Seiten-Token via
//               /me/accounts), LinkedIn über LINKEDIN_ACCESS_TOKEN (optional —
//               fehlt der, wird es sauber gemeldet, der Rest läuft weiter).
//
// Secrets: ANTHROPIC_API_KEY, META_ACCESS_TOKEN,
//          LINKEDIN_ACCESS_TOKEN? (optional), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//          Higgsfield-Tokens liegen ÄNDERBAR in connector_secrets (rotieren!):
//          HIGGSFIELD_ACCESS_TOKEN/_REFRESH_TOKEN/_EXPIRES_AT/_WORKSPACE_ID
//          Bild-KI = AUSSCHLIESSLICH Higgsfield (Sven 11.8.26), kein OpenAI mehr.
// Zugriff: läuft ohne Gateway-JWT-Prüfung, deshalb prüft authorize() jede Anfrage selbst:
//          x-cron-secret = connector_secrets.CRON_SECRET_SOCIAL (pg_cron), Bearer =
//          SUPABASE_SERVICE_ROLE_KEY (yt-center) oder Nutzer-JWT eines Admins/Verwalters
//          bzw. Mitarbeiters mit passendem Recht (funnel / thumbnails / youtube).
//          Der Publishable Key allein reicht NICHT (steht im Frontend-Bundle).
// Deploy:  supabase functions deploy social-agent --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { Image } from '../_vendor/imagescript/ImageScript.js'
import { initWasm, Resvg } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2'
import { hfGenerateBytes as hfGen, hfUploadImage as hfUp, type HfStore } from '../_shared/higgsfield.ts'
import { CI, CI_FONT, loadCiFonts } from '../_shared/brand.ts'
import { slideSvg, coverOverlaySvg, composeCover, normalizeSlides } from './carousel.ts'

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Stärkstes verfügbares Modell zuerst — Sven will das Chatfenster „auf gleicher Stufe".
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-5']

const BRAND = `Du arbeitest für Happy Property Cyprus (Sven Rüprich, Paphos/Zypern) —
Vermittlung von Neubau-Kapitalanlagen auf Zypern an deutschsprachige Investoren.
Kernbotschaft: 11–14 % Gesamtertrag p.a. (Mieteinnahmen + Wertsteigerung), nur 19 %
MwSt-Modelle/keine Grunderwerbsteuer-Nachteile wie in DE, freier Markt statt deutscher
Regulierung (Mietendeckel, Mieterschutzgesetz), EU-Rechtsraum, Title Deeds.
Kanäle: Facebook „Immobilien in Zypern", Instagram @happy_property_cyprus, LinkedIn.
Ton: locker, direkt, DU-Form, deutsch, gern mit Haltung und einem Augenzwinkern —
aber seriös in den Zahlen. Emojis sparsam und gezielt. Keine erfundenen Fakten/Zahlen.
„Weisheit der Woche" postet Lotte (Svens Hündin & Büro-Chefin 🐾): humorvoll,
tierisch-weise, mit Immobilien-Dreh, Absender Lotte.
Bild-Personas: Lotte und Sven können fotorealistisch ECHT ins Bild (Referenzfotos
aus dem Drive sorgen für Ähnlichkeit) — beim Tool make_image include:['lotte'] und/oder
['sven'] setzen, wenn es zum Post passt oder gewünscht wird. Bei Lottes „Weisheit der
Woche" gehört Lotte selbst ins Bild (include:['lotte']).

SCHREIBREGELN (gelten für JEDEN Text: Captions, LinkedIn, Blog, YouTube, Kommentare):
1. NIEMALS Gedankenstrich/Halbgeviertstrich (—) oder Bis-Strich (–) verwenden. Immer
   den normalen Bindestrich "-" nehmen, oder besser: den Satz einfach teilen (Punkt,
   Komma, Doppelpunkt). Auch bei Zahlenspannen: "11-14 %", nicht "11–14 %".
2. Natürlich schreiben, nicht nach KI klingen. Verboten sind die typischen KI-Muster:
   "Es ist nicht nur ..., sondern auch ...", "In der heutigen Zeit", "Lass uns
   eintauchen", "Fazit:", "Das Beste daran?", rhetorische Ein-Wort-Fragen als
   Absatz, Dreier-Aufzählungen mit gleichem Satzbau, aufgeblasene Adjektive
   ("revolutionär", "bahnbrechend", "nahtlos"), Emoji-Listen als Bulletpoints.
3. Lieber wie ein Mensch reden: unterschiedlich lange Sätze, mal ein
   unvollständiger Satz, konkrete Zahlen und Beispiele statt Marketing-Sprech,
   eigene Meinung statt neutraler Zusammenfassung. Kein Text darf glattgebügelt
   und austauschbar wirken.`

async function claude(apiKey: string, opts: { system: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number }): Promise<Record<string, unknown>> {
  let lastErr = ''
  for (const model of MODELS) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: opts.max_tokens ?? 2048, system: opts.system, messages: opts.messages, ...(opts.tools ? { tools: opts.tools } : {}), ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}) }),
    })
    const d = await res.json()
    if (res.ok) return d as Record<string, unknown>
    lastErr = JSON.stringify(d).slice(0, 300)
    // Nächstes Modell probieren bei: unbekanntem Modell, Überlastung, Rate-Limit
    if (!/model|not_found|overloaded|rate.?limit|529|429/i.test(lastErr) && res.status < 500) break
  }
  throw new Error(`Claude: ${lastErr}`)
}

// ── Higgsfield (Bild-KI) — zentral in _shared/higgsfield.ts ─────────────────
// Die rotierende OAuth-Session (Clerk, Tokens in connector_secrets) und der
// Job-Flow liegen jetzt gebündelt im Shared-Modul, damit studio + social-agent
// EINE Quelle nutzen. Hier nur der Store-Adapter (liest/schreibt Secrets über
// den vorhandenen sb-Client) + zwei Wrapper mit den bisherigen Signaturen.
function hfStoreFrom(sb: SupabaseClient): HfStore {
  return {
    get: async (key) => (((await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()).data as { value?: string } | null)?.value ?? '').trim(),
    set: async (rows) => {
      const stamp = new Date().toISOString()
      for (const r of rows) {
        const { error } = await sb.from('connector_secrets').upsert({ ...r, updated_at: stamp }, { onConflict: 'key' })
        if (error) console.error('[social-agent] Higgsfield-Secret speichern:', error.message)
      }
    },
  }
}
// jobType 'soul_location' = Orte/Objekte/Umgebungen (keine Personen),
// 'text2image_soul_v2' = trainierte Persona (params.custom_reference_id),
// 'flux_kontext' = Bild bearbeiten (behält Vorlage), 'nano_banana' = Multi-Referenz.
// Referenzbilder vorher mit hfUploadImage hochladen → params.image_references=[{id}].
const hfGenerateBytes = (sb: SupabaseClient, jobType: string, params: Record<string, unknown>): Promise<Uint8Array> => hfGen(hfStoreFrom(sb), jobType, params)
const hfUploadImage = (sb: SupabaseClient, bytes: Uint8Array, contentType?: string): Promise<string> => hfUp(hfStoreFrom(sb), bytes, contentType)

// Kompakter Projekt-Kontext (Namen, Orte, Preisspannen) für fundierte Objekt-Posts.
async function projectContext(sb: SupabaseClient): Promise<string> {
  const { data } = await sb.from('crm_projects').select('id, name, location, status').limit(30)
  const rows = (data ?? []) as Array<{ id: string; name: string; location: string | null; status: string | null }>
  const { data: units } = await sb.from('crm_project_units').select('project_id, price_net, bedrooms').limit(500)
  const us = (units ?? []) as Array<{ project_id: string; price_net: number | null; bedrooms: number | null }>
  return rows.map(p => {
    const pu = us.filter(u => u.project_id === p.id && u.price_net)
    const min = pu.length ? Math.min(...pu.map(u => u.price_net!)) : null
    const max = pu.length ? Math.max(...pu.map(u => u.price_net!)) : null
    return `- ${p.name} (${p.location ?? 'Zypern'}, ${p.status ?? ''})${min ? ` ab ${Math.round(min / 1000)}k€${max && max !== min ? ` bis ${Math.round(max / 1000)}k€` : ''} netto` : ''}`
  }).join('\n')
}

// Nächstes von flux_kontext unterstütztes Seitenverhältnis zur Vorlage finden.
const FLUX_AR: Array<[string, number]> = [['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]]
function nearestFluxAspect(w: number, h: number): string {
  if (!w || !h) return '1:1'
  const r = w / h
  return FLUX_AR.reduce((best, cur) => Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best)[0]
}
// Bestehendes Bild per KI BEARBEITEN (z.B. spielende Kinder ergänzen): Quelle laden
// → Higgsfield flux_kontext (Bild rein + Prompt, behält die Vorlage) → hochladen
// + an image_urls anhängen. NUR Higgsfield, kein OpenAI.
async function editPostImage(sb: SupabaseClient, postId: string, sourceUrl: string, prompt: string): Promise<string> {
  const src = await fetch(sourceUrl)
  if (!src.ok) throw new Error('Quellbild nicht ladbar.')
  const srcBytes = new Uint8Array(await src.arrayBuffer())
  const ct = src.headers.get('content-type') || 'image/png'
  // Seitenverhältnis der Vorlage möglichst beibehalten.
  let aspect = '1:1'
  try { const im = await Image.decode(srcBytes); aspect = nearestFluxAspect(im.width, im.height) } catch { /* Default 1:1 */ }
  const refId = await hfUploadImage(sb, srcBytes, ct)
  const bytes = await hfGenerateBytes(sb, 'flux_kontext', {
    prompt: `Edit the reference image: ${prompt}. Keep the existing scene, people and composition intact unless the instruction changes them. Photorealistic, natural light, no text, no watermark.`,
    aspect_ratio: aspect,
    image_references: [{ id: refId }],
  })
  const path = `social/${postId}-edit-${Date.now()}.png`
  const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
  if (upErr) throw new Error(`Upload: ${upErr.message}`)
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
  const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
  const list = Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls) ? (cur as { image_urls: string[] }).image_urls : []
  await sb.from('social_posts').update({ image_urls: [...list, url], image_url: list[0] ?? url, updated_at: new Date().toISOString() }).eq('id', postId)
  return url
}

// Bild erzeugen: Higgsfield Soul Location (fotorealistisch, Svens Abo). In
// ad-creatives/social hochladen, an image_urls anhängen. Genutzt von image-
// Aktion + Chat-Tool make_image. NUR Higgsfield, kein OpenAI-Fallback.
// ── Echt wirkende Bilder statt KI-Hochglanz (Svens Feedback 26.9.2026) ─────
// Test mit 5 Higgsfield-Modellen: Der KI-Look kam vor allem vom Prompt
// („photorealistic, golden hour, shallow depth of field, high detail"). Als
// gewöhnliches Handyfoto beschrieben (harte Schatten, Staub, Stromleitungen,
// Solarboiler) wirken selbst günstige Modelle echt. Am echtesten: Nano Banana 2
// (Dev-API-Jobtyp nano_banana_flash) und Seedream 5 Pro.
// Modell kommt aus crm_settings social_image_cfg (mit Zeitplan, z. B. ab 1.10.
// höchste Qualität, wenn neue Credits da sind) und fällt bei Fehlern auf das
// günstige soul_location zurück.
const CANDID_SUFFIX = 'Casual but well-composed smartphone photo of a real place on a nice day, natural daylight with real shadows, true-to-life colors, authentic textures and small real-world imperfections. No hands, arms or feet in the frame, no bokeh, no HDR, no cinematic color grading, no lens flare, no text, no watermark, no logos.'
const AI_LOOK_WORDS = /\b(photo-?realistic|hyper-?realistic|ultra-?realistic|realistic|cinematic|golden[- ]hour|dramatic (lighting|light|sky)|moody|stunning|breathtaking|gorgeous|beautiful|professional( real estate)?( photo(graph)?| photography)?|crisp|high(ly)? detail(ed)?|8k|4k|uhd|shallow depth of field|depth of field|bokeh|award[- ]winning|masterpiece|studio lighting|drone shot|aerial( drone)?( shot| view)?|glossy|pristine|immaculate)\b,?/gi
function candidPrompt(scene: string): string {
  const clean = scene.replace(AI_LOOK_WORDS, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').replace(/^[,.;\s]+/, '').trim()
  return `${clean}${/[.!]$/.test(clean) ? '' : '.'} ${CANDID_SUFFIX}`
}
// Bildidee → alltägliche, fotografierbare Szene (Blickwinkel, Tageszeit, echte Details).
async function toCandidScene(idea: string): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  if (!key) return idea
  try {
    const r = await claude(key, {
      system: 'You turn an image idea for a real-estate social media post into ONE paragraph (max 90 words, English) that describes an ORDINARY real-life photo someone could take with a phone: concrete vantage point (street level, balcony, window, table), time of day, what is visible, authentic local details (on Cyprus: flat roofs with solar water heaters and white water tanks, white render with dust, power lines, parked small cars, bougainvillea, construction cranes; in Germany: grey Altbau facades, Kopfsteinpflaster, bikes, overcast light). It must still be a photo a proud owner or local would happily post: clear subject, pleasant weather and light, tidy composition, attractive but real (no plastic garden chairs, no clutter, no hands or body parts in frame). Keep the meaning of the idea. Never use: drone/aerial, golden hour, cinematic, dramatic, stunning, photorealistic, bokeh, depth of field, professional. No people in focus, no text, no signs, no logos. Output only the paragraph.',
      messages: [{ role: 'user', content: idea }], max_tokens: 400,
    })
    const t = (((r.content ?? []) as Array<{ type: string; text?: string }>).find(b => b.type === 'text')?.text ?? '').trim()
    return t.length > 40 ? t : idea
  } catch { return idea }
}
interface ImgModel { model: string; params?: Record<string, unknown> }
interface ImgCfg extends ImgModel { schedule?: Array<ImgModel & { from: string }>; fallback?: ImgModel }
async function imageModels(sb: SupabaseClient): Promise<{ primary: ImgModel; fallback: ImgModel }> {
  const cheap: ImgModel = { model: 'soul_location', params: { aspect_ratio: '1:1' } }
  const { data } = await sb.from('crm_settings').select('value').eq('key', 'social_image_cfg').maybeSingle()
  let cfg: ImgCfg = cheap
  try { cfg = { ...cheap, ...JSON.parse((data as { value?: string } | null)?.value ?? '{}') as ImgCfg } } catch { /* Standard */ }
  let primary: ImgModel = { model: cfg.model, params: cfg.params }
  for (const s of (cfg.schedule ?? []).filter(x => x?.from && Date.parse(x.from) <= Date.now()).sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) primary = { model: s.model, params: s.params }
  return { primary, fallback: cfg.fallback ?? cheap }
}
async function candidImageBytes(sb: SupabaseClient, prompt: string): Promise<{ bytes: Uint8Array; scene: string }> {
  const scene = await toCandidScene(prompt)
  const { primary, fallback } = await imageModels(sb)
  try {
    return { bytes: await hfGenerateBytes(sb, primary.model, { ...(primary.params ?? {}), prompt: candidPrompt(scene) }), scene }
  } catch (e) {
    if (primary.model === fallback.model) throw e
    console.warn(`[social-agent] Bildmodell ${primary.model} fehlgeschlagen, Rückfall auf ${fallback.model}:`, e instanceof Error ? e.message : String(e))
    return { bytes: await hfGenerateBytes(sb, fallback.model, { ...(fallback.params ?? {}), prompt: candidPrompt(scene) }), scene }
  }
}
async function generatePostImage(sb: SupabaseClient, postId: string, prompt: string): Promise<string> {
  const { bytes, scene } = await candidImageBytes(sb, prompt)
  const path = `social/${postId}-${Date.now()}.png`
  const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
  if (upErr) throw new Error(`Upload: ${upErr.message}`)
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
  const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
  const list = Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls) ? (cur as { image_urls: string[] }).image_urls : []
  await sb.from('social_posts').update({ image_urls: [...list, url], image_url: list[0] ?? url, image_prompt: scene, updated_at: new Date().toISOString() }).eq('id', postId)
  return url
}

// ── Lotte/Sven-Referenzen: LIVE aus Google Drive (Service-Account) ──────────
// Ordner stehen in crm_settings key social_persona_refs (JSON):
//   {"lotte_folder":"…","sven_folder":"…","sven_min_bytes":500000}
// Neue Fotos im Drive-Ordner „Lotte Original" wirken damit sofort — kein Sync nötig.
function pb64url(bytes: Uint8Array): string { let x = ''; for (const b of bytes) x += String.fromCharCode(b); return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
async function driveToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON'); if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON fehlt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\\n/g, '').replace(/\s+/g, '')
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)).buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => pb64url(new TextEncoder().encode(JSON.stringify(o)))
  // Domainweite Delegierung: ist GOOGLE_IMPERSONATE_SUBJECT gesetzt, sieht der
  // Service-Account den kompletten Drive dieses Kontos, ohne Ordner-Freigaben.
  const sub = Deno.env.get('GOOGLE_IMPERSONATE_SUBJECT') || undefined
  // Bei Delegierung den in der Workspace-Verwaltung freigegebenen Bereich
  // anfragen (.../auth/drive), sonst weist Google das Token ab.
  const scope = sub ? 'https://www.googleapis.com/auth/drive' : 'https://www.googleapis.com/auth/drive.readonly'
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600, ...(sub ? { sub } : {}) })}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${pb64url(new Uint8Array(sig))}` }) })
  const d = await r.json() as { access_token?: string }
  if (!d.access_token) throw new Error('Drive-SA-Token fehlgeschlagen')
  return d.access_token
}
interface PersonaCfg { lotte_folder?: string; lotte_fallback_folder?: string; sven_folder?: string; sven_min_bytes?: number; sven_soul_id?: string; lotte_soul_id?: string }
async function personaCfg(sb: SupabaseClient): Promise<PersonaCfg> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', 'social_persona_refs').maybeSingle()
  try { return JSON.parse((data as { value?: string } | null)?.value ?? '{}') as PersonaCfg } catch { return {} }
}
async function driveImages(token: string, folderId: string, minBytes = 0, max = 3): Promise<Array<{ id: string; name: string }>> {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`)
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=25`, { headers: { Authorization: `Bearer ${token}` } })
  const d = await r.json() as { files?: Array<{ id: string; name: string; size?: string }> }
  return (d.files ?? []).filter(f => Number(f.size ?? 0) >= minBytes).slice(0, max)
}
async function driveDownload(token: string, fileId: string): Promise<Blob> {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`Drive-Download ${fileId}: ${r.status}`)
  return await r.blob()
}
// Persona-Bild. BESTER Weg: trainierte Higgsfield-Soul-ID (fotorealistisch,
// crm_settings social_persona_refs → sven_soul_id/lotte_soul_id) — geht nur für
// EINE Persona pro Bild. Sonst (beide Personas, keine Soul-ID, HF-Fehler):
// echte Drive-Referenzfotos → Higgsfield nano_banana (Multi-Referenz). Kein OpenAI.
async function generatePersonaImage(sb: SupabaseClient, postId: string, prompt: string, include: string[]): Promise<string> {
  const cfg = await personaCfg(sb)
  const wantSven = include.includes('sven'), wantLotte = include.includes('lotte')
  const soulId = wantSven && !wantLotte ? cfg.sven_soul_id : (wantLotte && !wantSven ? cfg.lotte_soul_id : undefined)
  if (soulId) {
    try {
      const who = wantSven ? 'Sven Rüprich, founder of Happy Property (the trained character)' : "Lotte, Sven's chocolate labrador and office boss (the trained character)"
      const bytes = await hfGenerateBytes(sb, 'text2image_soul_v2', {
        prompt: `${prompt}. The image shows ${who}. Photorealistic, natural lighting, realistic materials, no text, no watermark.`,
        aspect_ratio: '1:1', quality: '2k', custom_reference_id: soulId,
      })
      const path = `social/${postId}-persona-${Date.now()}.png`
      const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
      if (upErr) throw new Error(`Upload: ${upErr.message}`)
      const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
      const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
      const list = Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls) ? (cur as { image_urls: string[] }).image_urls : []
      await sb.from('social_posts').update({ image_urls: [...list, url], image_url: list[0] ?? url, image_prompt: prompt, updated_at: new Date().toISOString() }).eq('id', postId)
      return url
    } catch (e) {
      console.warn('[social-agent] Soul-ID-Bild fehlgeschlagen — Referenzfoto-Fallback:', e instanceof Error ? e.message : String(e))
    }
  }
  const token = await driveToken()
  // Referenz-Fotos aus dem Drive einsammeln (Bytes + Typ + Persona-Label).
  // Je Persona höchstens 2 ziehen — nano_banana nimmt insgesamt MAX 3 Referenzen.
  const files: Array<{ bytes: Uint8Array; type: string; who: 'lotte' | 'sven' }> = []
  if (include.includes('lotte') && cfg.lotte_folder) {
    let refs = await driveImages(token, cfg.lotte_folder, 0, 2)
    if (!refs.length && cfg.lotte_fallback_folder) refs = await driveImages(token, cfg.lotte_fallback_folder, 0, 2)
    for (const f of refs) { const b = await driveDownload(token, f.id); files.push({ bytes: new Uint8Array(await b.arrayBuffer()), type: b.type || 'image/jpeg', who: 'lotte' }) }
  }
  if (include.includes('sven') && cfg.sven_folder) {
    const refs = await driveImages(token, cfg.sven_folder, cfg.sven_min_bytes ?? 500000, 2)
    for (const f of refs) { const b = await driveDownload(token, f.id); files.push({ bytes: new Uint8Array(await b.arrayBuffer()), type: b.type || 'image/jpeg', who: 'sven' }) }
  }
  if (!files.length) return await generatePostImage(sb, postId, prompt)
  // Referenzfotos ROH hochladen — Higgsfield resized serverseitig selbst
  // (→ _resize.jpg). Bewusst KEIN lokales Decode/Transkodieren: das mehrfache
  // imagescript-Decode grosser iPhone-Fotos sprengte den Worker-Speicher.
  // Einzelne kaputte Referenz überspringen statt hart abbrechen.
  const uploaded: Array<{ id: string; who: 'lotte' | 'sven' }> = []
  for (const f of files) {
    try { uploaded.push({ id: await hfUploadImage(sb, f.bytes, f.type), who: f.who }) }
    catch (e) { console.warn('[social-agent] Referenz-Upload übersprungen:', e instanceof Error ? e.message : String(e)) }
  }
  if (!uploaded.length) return await generatePostImage(sb, postId, prompt)
  // Ausgewogen auf MAX 3 deckeln (nano_banana-Limit): abwechselnd je Persona,
  // damit bei „Sven + Lotte" beide sicher im Bild landen.
  const pools = [uploaded.filter(u => u.who === 'lotte'), uploaded.filter(u => u.who === 'sven')].filter(p => p.length)
  const picked: Array<{ id: string; who: 'lotte' | 'sven' }> = []
  for (let i = 0; picked.length < 3 && pools.some(p => p.length); i++) {
    const pool = pools[i % pools.length]
    const next = pool.shift()
    if (next) picked.push(next)
  }
  const refIds = picked.map(p => ({ id: p.id }))
  const parts: string[] = []
  if (picked.some(p => p.who === 'lotte')) parts.push("One reference shows Lotte, a real dog (Sven's chocolate labrador and office boss at Happy Property). Lotte must match the reference exactly: same breed, same coat color, same face.")
  if (picked.some(p => p.who === 'sven')) parts.push('One reference shows Sven Rüprich (real person, founder of Happy Property). Sven must match the reference exactly: same face, same build.')
  // Bei nano_banana-Fehler NICHT hart scheitern — Netz: normales Objektbild.
  let bytes: Uint8Array
  try {
    bytes = await hfGenerateBytes(sb, 'nano_banana', {
      prompt: `${parts.join(' ')} Create a new photorealistic image: ${prompt}. Keep the likeness of the referenced dog/person absolutely true to the reference photos. Natural light, no text, no watermark.`,
      aspect_ratio: '1:1',
      image_references: refIds,
    })
  } catch (e) {
    console.warn('[social-agent] nano_banana Persona fehlgeschlagen — soul_location als Netz:', e instanceof Error ? e.message : String(e))
    return await generatePostImage(sb, postId, prompt)
  }
  const path = `social/${postId}-persona-${Date.now()}.png`
  const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
  if (upErr) throw new Error(`Upload: ${upErr.message}`)
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
  const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
  const list = Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls) ? (cur as { image_urls: string[] }).image_urls : []
  await sb.from('social_posts').update({ image_urls: [...list, url], image_url: list[0] ?? url, image_prompt: prompt, updated_at: new Date().toISOString() }).eq('id', postId)
  return url
}

// ── Autopilot: Zypern-Zeit, Wochenplan, Drive-Warteschlangen ─────────────────
// Der Autopilot plant Reels, Lotte-Posts und News selbst ein (Wochenplan in
// crm_settings social_autopilot) und legt sie 1 bis 3 Tage vorher als fertige,
// freigegebene Posts in den Redaktionsplan. auto_publish postet sie zur Uhrzeit.
function cyOffsetMinutes(d: Date): number {
  const m: Record<string, string> = {}
  for (const pt of new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Nicosia', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d)) m[pt.type] = pt.value
  return (Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second) - d.getTime()) / 60000
}
// UTC-Zeitpunkt zu Zypern-Datum (YYYY-MM-DD) + Uhrzeit (HH:MM)
function cyAt(ymd: string, hm: string): Date {
  const [y, mo, d] = ymd.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi))
  return new Date(guess.getTime() - cyOffsetMinutes(guess) * 60000)
}
const cyYmd = (d: Date) => new Date(d.getTime() + cyOffsetMinutes(d) * 60000).toISOString().slice(0, 10)
const WEEKDAY_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

type ApKind = 'reel' | 'news' | 'lotte' | 'linkedin'
interface ApSlot { dow: number; kind: ApKind; time: string; li_time?: string; format?: 'single' | 'carousel' }
// li_slots getrennt von slots: ältere Studio-Versionen im Browser-Cache kennen die Art
// 'linkedin' nicht und stürzten daran ab (weiße Seite, 26.9.2026).
interface ApCfg { enabled?: boolean; reels_folder?: string; lotte_folder?: string; social_folder?: string; reel_platforms?: string[]; slots?: ApSlot[]; li_slots?: ApSlot[] }
interface ApState { state?: 'pending' | 'ready' | 'failed'; attempts?: number; error?: string; task?: boolean }
interface ApWant { key: string; kind: ApKind; ymd: string; when: Date; liWhen: Date | null; format?: 'single' | 'carousel' }
async function autopilotCfg(sb: SupabaseClient): Promise<ApCfg> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', 'social_autopilot').maybeSingle()
  try { return JSON.parse((data as { value?: string } | null)?.value ?? '{}') as ApCfg } catch { return {} }
}
// Stichwort-Automatik (Function social-keywords): Wer das Stichwort kommentiert,
// bekommt den Zypern-Report per Nachricht. NUR wenn sie eingeschaltet ist UND der
// Scan wirklich läuft, enden die News-Posts am Di, Fr und So (Zypern-Wochentag des
// Slots) mit dieser Aufforderung, und Lottes Samstags-Post bekommt eine Zeile dazu.
// "Läuft" = letzter Lauf (crm_settings social_keywords_last_run.at, Cron alle 3 Min.)
// jünger als 20 Minuten. Sonst verspräche der Post etwas, das niemand verschickt.
const KW_NEWS_DOWS = [2, 5, 0]
const KW_RUN_MAX_AGE_MS = 20 * 60 * 1000
// kw = eingestelltes Stichwort in Großbuchstaben (auch wenn ausgeschaltet),
// cta = Stichwort nur, wenn eingeschaltet und der Scan läuft, sonst null.
async function keywordState(sb: SupabaseClient): Promise<{ kw: string | null; cta: string | null }> {
  const { data } = await sb.from('crm_settings').select('key, value').in('key', ['social_keywords', 'social_keywords_last_run'])
  const rows = (data ?? []) as Array<{ key: string; value: string | null }>
  const parse = (key: string): Record<string, unknown> => {
    try { const v = JSON.parse(rows.find(r => r.key === key)?.value ?? '{}'); return v && typeof v === 'object' ? v as Record<string, unknown> : {} } catch { return {} }
  }
  const c = parse('social_keywords') as { enabled?: boolean; keywords?: unknown }
  const last = parse('social_keywords_last_run') as { at?: unknown }
  const list = Array.isArray(c.keywords) ? c.keywords : []
  const kw = list.map(k => (typeof k === 'string' ? k.trim().replace(/^#+/, '') : '')).find(Boolean)?.toUpperCase() ?? null
  const lastAt = Date.parse(typeof last.at === 'string' ? last.at : '')
  const running = Number.isFinite(lastAt) && Date.now() - lastAt < KW_RUN_MAX_AGE_MS
  return { kw, cta: c.enabled === true && kw && running ? kw : null }
}
async function keywordCta(sb: SupabaseClient): Promise<string | null> {
  try { return (await keywordState(sb)).cta } catch { return null }
}
// Ohne Stichwort-Aufforderung (anderer Tag, ausgeschaltet oder Scan steht) darf die
// KI kein eigenes Kommentar-Stichwort erfinden, das dann niemand beantwortet.
const KW_AVOID_INSTRUCTION = 'Keine Kommentar-Stichwörter als Handlungsaufforderung verwenden (nicht "kommentiere X"), stattdessen eine Frage an die Community oder den Hinweis auf den Termin-Link in der Bio.'
const kwNewsInstruction = (kw: string) => `Die Handlungsaufforderung am Ende ist diesmal NUR das Stichwort (keine Frage, kein Termin-Link): Wer ${kw} kommentiert, bekommt unseren aktuellen Zypern-Report als PDF per Nachricht. Formuliere das natürlich und jedes Mal etwas anders, zum Beispiel "Kommentiere ${kw} und du bekommst unseren aktuellen Zypern-Report als PDF per Nachricht." Das Stichwort ${kw} steht wörtlich in Großbuchstaben im Text, vor den Hashtags. Nichts versprechen, was nicht im Report steht.`
const kwLotteInstruction = (kw: string) => `ZUSATZ FÜR HEUTE: Baue vor der Unterschrift diese Zeile ein, gern leicht abgewandelt, das Stichwort ${kw} wörtlich in Großbuchstaben: "Kommentier ${kw}, dann schickt dir mein Chef den Zypern-Report. Ich hab ihn schon gelesen. Also die Bilder." Dafür keine zusätzliche Frage am Ende.`
// Sicherheitsnetz: fehlt das Stichwort im fertigen Text, die Aufforderung vor der
// Unterschrift bzw. den Hashtags einfügen (sonst wüsste niemand, was zu tun ist).
function ensureKeywordCta(caption: string, kw: string, line: string): string {
  const k = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(?<![\\p{L}\\p{N}_])${k}(?![\\p{L}\\p{N}_])`, 'u').test(caption)) return caption
  const lines = caption.trimEnd().split('\n')
  let i = lines.length
  while (i > 0 && (!lines[i - 1].trim() || /^\s*(#[^\s#]+\s*)+$/.test(lines[i - 1]) || /^\s*🐾/.test(lines[i - 1]))) i--
  const head = lines.slice(0, i).join('\n').trimEnd()
  const tail = lines.slice(i).join('\n').trim()
  return tail ? `${head}\n\n${line}\n\n${tail}` : `${head}\n\n${line}`
}
// ── Facebook-Caption ohne Kommentar-Köder ─────────────────────────────────────
// Facebook stuft "Comment Baiting" (Aufforderung, ein bestimmtes Wort zu
// kommentieren) herab. Für Facebook ersetzen wir deshalb jede Zeile mit so einer
// Aufforderung durch einen Nachrichten-Hinweis und kappen die Hashtags auf 5.
// Instagram bekommt weiter die Original-Caption (dort läuft die Stichwort-Automatik).
const FB_BAIT_LINE = 'Schreib uns eine Nachricht, wir schicken dir alle Infos.'
const FB_MAX_HASHTAGS = 5
const FB_Q = `"'„“”‚‘’«»‹›`
// Stichwort = ein GROSS geschriebenes Wort (mind. 2 Zeichen, optional mit #) oder EIN Wort
// in Anführungszeichen. Zitate mit Leerzeichen („Zypern ist zu teuer") und Wortenden
// (iOS) zählen nicht als Stichwort.
const FB_WORD = `(?:(?<![\\p{L}\\p{N}_#])#?[A-ZÄÖÜ][A-ZÄÖÜ0-9]+(?![\\p{L}\\p{N}_])|[${FB_Q}][^${FB_Q}\\s]{1,30}[${FB_Q}])`
const FB_FILL = '(?:(?:einfach|gern|gerne|jetzt|kurz|hier|unten|uns|mir|mal|doch|nur)\\s+){0,3}'
const FB_BAIT_RES = [
  // Kommentier PAPHOS / Kommentiere „PAPHOS" / Kommentiere einfach mit dem Wort PAPHOS
  new RegExp(`(?<!\\p{L})[Kk]ommentier(?:e)?\\s+${FB_FILL}(?:mit\\s+)?(?:(?:dem|das)\\s+(?:Wort|Stichwort)\\s+)?${FB_WORD}`, 'u'),
  // Ein Kommentar mit PAPHOS / Kommentar: „PAPHOS"
  new RegExp(`(?<!\\p{L})[Kk]ommentar(?:\\s*:|\\s+mit)?\\s+(?:(?:dem|das)\\s+(?:Wort|Stichwort)\\s+)?${FB_WORD}`, 'u'),
  // Schreib PAPHOS in die Kommentare / Schreibe uns „PAPHOS" unten in die Kommentare / als Kommentar
  new RegExp(`(?<!\\p{L})[Ss]chreib(?:e|t)?\\s+${FB_FILL}(?:(?:das|dem)\\s+(?:Wort|Stichwort)\\s+)?${FB_WORD}\\s+${FB_FILL}(?:in\\s+(?:die|den)\\s+Kommentar|als\\s+Kommentar|unter\\s+(?:den|diesen)\\s+(?:Post|Beitrag))`, 'u'),
  // Wer PAPHOS kommentiert, ... / Einfach PAPHOS kommentieren
  new RegExp(`(?<!\\p{L})(?:[Ww]er|[Ee]infach|[Gg]erne?)\\s+${FB_WORD}\\s+(?:in\\s+die\\s+Kommentare\\s+schreib|kommentier)`, 'u'),
  // ... PAPHOS in die Kommentare
  new RegExp(`${FB_WORD}\\s+${FB_FILL}in\\s+die\\s+Kommentare`, 'u'),
]
const FB_TAG_RE = /(^|[^\p{L}\p{N}_&/])#([\p{L}_][\p{L}\p{N}_]*)/gu
const FB_HAS_TAG = /(^|[^\p{L}\p{N}_&/])#[\p{L}_]/u
function isCommentBaitLine(line: string): boolean {
  return FB_BAIT_RES.some(re => re.test(line))
}
function fbCaption(text: string | null | undefined): string {
  const src = String(text ?? '')
  if (!src.trim()) return src
  // 1) Köder-Zeilen ersetzen (der Hinweis steht nur einmal, weitere Köder-Zeilen entfallen)
  let hinted = src.includes(FB_BAIT_LINE)
  const lines: string[] = []
  for (const line of src.split(/\r?\n/)) {
    if (!isCommentBaitLine(line)) { lines.push(line); continue }
    if (!hinted) { lines.push(FB_BAIT_LINE); hinted = true }
  }
  // 2) Hashtags auf 5 kappen. Hashtags im Fließtext zählen zuerst und bleiben als
  //    Wort stehen (nur das # fällt weg), reine Hashtag-Zeilen werden gekürzt.
  const isTagLine = (l: string) => FB_HAS_TAG.test(l) && /^[\s·•|,.\p{Extended_Pictographic}\uFE0F\u200D]*$/u.test(l.replace(FB_TAG_RE, '$1'))
  let budget = FB_MAX_HASHTAGS
  const take = () => (budget > 0 ? (budget--, true) : false)
  const inText = lines.map(l => (isTagLine(l) ? l : l.replace(FB_TAG_RE, (m, pre: string, tag: string) => (take() ? m : `${pre}${tag}`))))
  const out: string[] = []
  for (const l of inText) {
    if (!isTagLine(l)) { out.push(l); continue }
    const kept = l.replace(FB_TAG_RE, (m, pre: string) => (take() ? m : pre)).replace(/[ \t]{2,}/g, ' ').trim()
    if (kept && !/^[\s·•|,.]*$/.test(kept)) out.push(kept)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}
// Zugangsdaten nie speichern oder zurückgeben (Fehlertexte können die URL enthalten)
function redactToken(s: unknown): string {
  return String(s ?? '').replace(/access_token=[^&\s)"\\]+/g, 'access_token=[entfernt]').replace(/\bEAA[A-Za-z0-9]{30,}/g, '[entfernt]')
}
// Wie weit im Voraus je Art erzeugt wird. Reels (Inhalt steht ja fest) so weit
// die Warteschlange reicht, Lotte eine Woche, News + LinkedIn 3 Tage (aktuell
// genug, und Sven sieht die nächsten Tage immer fertig in der Vorschau).
const AP_LEAD_H: Record<ApKind, number> = { reel: 14 * 24, lotte: 7 * 24, news: 72, linkedin: 72 }
// Alle Plan-Slots (Zypern-Datum/-Zeit) von heute an für `days` Tage.
function autopilotSlots(cfg: ApCfg, nowMs: number, days: number): ApWant[] {
  const out: ApWant[] = []
  const todayCy = cyYmd(new Date(nowMs))
  for (let i = 0; i <= days; i++) {
    const base = new Date(`${todayCy}T12:00:00Z`)
    base.setUTCDate(base.getUTCDate() + i)
    const ymd = base.toISOString().slice(0, 10)
    const dow = base.getUTCDay()
    for (const s of [...(cfg.slots ?? []), ...(cfg.li_slots ?? [])].filter(x => x.dow === dow)) {
      const when = cyAt(ymd, s.time)
      const lead = when.getTime() - nowMs
      if (lead < 15 * 60000) continue                                   // zu knapp oder vorbei
      const liWhen = s.li_time ? cyAt(ymd, s.li_time) : null
      out.push({ key: `${ymd}|${s.kind}`, kind: s.kind, ymd, when, liWhen: liWhen && liWhen.getTime() - nowMs > 15 * 60000 ? liWhen : null, format: s.format })
    }
  }
  return out.sort((a, b) => a.when.getTime() - b.when.getTime())
}
// Slots, die der Autopilot JETZT befüllen soll (innerhalb der Vorlaufzeit je Art)
const autopilotWanted = (cfg: ApCfg, nowMs: number): ApWant[] =>
  autopilotSlots(cfg, nowMs, 14).filter(w => w.when.getTime() - nowMs <= AP_LEAD_H[w.kind] * 3600000)

interface DriveFile { id: string; name: string; mimeType: string; size?: string; createdTime?: string; thumbnailLink?: string }
async function driveChildren(token: string, folderId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
  const out: DriveFile[] = []
  let pageToken = ''
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,createdTime,thumbnailLink)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } })
    const d = await r.json() as { files?: DriveFile[]; nextPageToken?: string; error?: { message?: string } }
    if (!r.ok) throw new Error(`Drive-Ordner ${folderId}: ${d.error?.message ?? r.status}`)
    out.push(...(d.files ?? []))
    if (!d.nextPageToken) break
    pageToken = d.nextPageToken
  }
  return out
}
// Kein KI-Gedankenstrich in Kundentexten (Svens Regel): — und – werden zu "-"
const noDash = (t: string) => t.replace(/\s*[—–]\s*/g, (m) => /^\s|\s$/.test(m) ? ' - ' : '-')
const baseName = (n: string) => n.replace(/\.[^.]+$/, '').trim().toLowerCase()
// Reel-Warteschlange: alle Videos im Reels-Ordner (eine Unterordner-Ebene mit),
// ältestes zuerst, ohne die schon verplanten (news_source = drive:<id>).
// Textdatei mit gleichem Namen = fertiger Posting-Text.
async function reelQueue(sb: SupabaseClient, token: string, folderId: string): Promise<{ queue: DriveFile[]; texts: Map<string, string>; total: number }> {
  const top = await driveChildren(token, folderId)
  const all = [...top]
  for (const f of top.filter(x => x.mimeType === 'application/vnd.google-apps.folder')) all.push(...await driveChildren(token, f.id))
  const texts = new Map<string, string>()
  for (const f of all) if (f.mimeType === 'text/plain' || /\.txt$/i.test(f.name)) texts.set(baseName(f.name), f.id)
  const videos = all.filter(f => f.mimeType.startsWith('video/'))
    .sort((a, b) => (a.createdTime ?? '').slice(0, 16).localeCompare((b.createdTime ?? '').slice(0, 16)) || a.name.localeCompare(b.name, 'de', { numeric: true }))
  const { data: used } = await sb.from('social_posts').select('news_source').like('news_source', 'drive:%')
  const usedIds = new Set(((used ?? []) as Array<{ news_source: string }>).map(u => u.news_source.slice(6)))
  return { queue: videos.filter(v => !usedIds.has(v.id)), texts, total: videos.length }
}
// Video aus Drive direkt in den Storage streamen (kein Komplett-Puffer im Worker).
async function driveVideoToStorage(token: string, file: DriveFile, path: string): Promise<string> {
  const size = Number(file.size ?? 0)
  if (size > 300 * 1048576) throw new Error(`Reel „${file.name}" ist zu groß (${Math.round(size / 1048576)} MB, max. 300 MB).`)
  const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
  if (!dl.ok || !dl.body) throw new Error(`Drive-Download ${file.name}: ${dl.status}`)
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const up = await fetch(`${Deno.env.get('SUPABASE_URL')}/storage/v1/object/ad-creatives/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': file.mimeType || 'video/mp4', 'x-upsert': 'true', 'cache-control': '3600' },
    body: dl.body,
  })
  if (!up.ok) throw new Error(`Storage-Upload ${file.name}: ${up.status} ${(await up.text()).slice(0, 200)}`)
  return `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
}

// Lotte-Bild: trainierte Soul-ID + bis zu 2 zufällige echte Fotos aus dem Ordner
// „Lotte Bilder" als Referenz (Sven legt dort laufend Fotos ab). Scheitert das,
// Soul-ID allein, danach die bisherige Persona-Kette.
async function generateLotteImage(sb: SupabaseClient, postId: string, prompt: string): Promise<string> {
  const cfg = await personaCfg(sb)
  const soul = cfg.lotte_soul_id
  const refs: Array<{ id: string }> = []
  if (cfg.lotte_folder) {
    try {
      const token = await driveToken()
      const pics = (await driveChildren(token, cfg.lotte_folder)).filter(f => f.mimeType.startsWith('image/'))
      for (const f of pics.sort(() => Math.random() - 0.5).slice(0, 2)) {
        try {
          // Große Handyfotos NICHT im Worker dekodieren (Speicherlimit): Drive liefert
          // eine verkleinerte Vorschau (1280 px), nur kleine Dateien kommen im Original.
          let bytes: Uint8Array | null = null, type = 'image/jpeg'
          if (f.thumbnailLink) {
            const tr = await fetch(f.thumbnailLink.replace(/=s\d+(-[a-z])?$/, '=s1280'), { headers: { Authorization: `Bearer ${token}` } })
            if (tr.ok) { bytes = new Uint8Array(await tr.arrayBuffer()); type = tr.headers.get('content-type') || 'image/jpeg' }
          }
          if (!bytes) {
            if (Number(f.size ?? 0) > 2 * 1048576) throw new Error(`${f.name}: keine Vorschau, Original zu groß`)
            const b = await driveDownload(token, f.id); bytes = new Uint8Array(await b.arrayBuffer()); type = b.type || 'image/jpeg'
          }
          refs.push({ id: await hfUploadImage(sb, bytes, type) })
        }
        catch (e) { console.warn('[social-agent] Lotte-Referenz übersprungen:', e instanceof Error ? e.message : String(e)) }
      }
    } catch (e) { console.warn('[social-agent] Lotte-Ordner nicht lesbar:', e instanceof Error ? e.message : String(e)) }
  }
  const full = `${prompt.replace(AI_LOOK_WORDS, '').replace(/\s{2,}/g, ' ').trim()}. The dog is Lotte, a chocolate brown labrador retriever (the trained character), she must look exactly like the reference photos: same coat color, same face, same build. Candid smartphone photo taken by her owner, natural daylight with real shadows, true-to-life colors, real fur texture, slightly imperfect framing. No bokeh, no HDR, no cinematic grading, no text, no watermark.`
  const tries: Array<[string, Record<string, unknown>]> = []
  if (soul && refs.length) tries.push(['text2image_soul_v2', { prompt: full, aspect_ratio: '1:1', quality: '2k', custom_reference_id: soul, image_references: refs }])
  if (soul) tries.push(['text2image_soul_v2', { prompt: full, aspect_ratio: '1:1', quality: '2k', custom_reference_id: soul }])
  if (!soul && refs.length) tries.push(['nano_banana', { prompt: `Create a new photorealistic image: ${full}`, aspect_ratio: '1:1', image_references: refs }])
  for (const [job, params] of tries) {
    try {
      const bytes = await hfGenerateBytes(sb, job, params)
      const path = `social/${postId}-lotte-${Date.now()}.png`
      const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
      if (upErr) throw new Error(`Upload: ${upErr.message}`)
      const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
      await sb.from('social_posts').update({ image_urls: [url], image_url: url, image_prompt: prompt, updated_at: new Date().toISOString() }).eq('id', postId)
      return url
    } catch (e) { console.warn(`[social-agent] Lotte-Bild via ${job} fehlgeschlagen:`, e instanceof Error ? e.message : String(e)) }
  }
  return await generatePersonaImage(sb, postId, prompt, ['lotte'])
}

// News-Recherche → Ideen (social_ideas). avoid = Themen, die schon liefen.
async function newsScan(sb: SupabaseClient, anthropicKey: string, avoid: string[] = []): Promise<Array<{ id: string; headline: string; core: string; source_url: string | null; angle: string }>> {
  const system = `${BRAND}

Du recherchierst AKTUELLE Nachrichten (letzte ~14 Tage), die sich für Social-Media-
Posts von Happy Property eignen. Zwei Blickwinkel:
1) ZYPERN — besonders RECHTLICHES & PRAKTISCHES für Investoren UND Auswanderer:
   Gesetzes-/Steueränderungen (MwSt, Non-Dom, IP-Box, Rente), Aufenthalts-/Visa-Regeln,
   Title-Deeds-Reformen, Kaufprozess, dazu Markt/Preise/Infrastruktur (Paphos/Limassol).
2) DEUTSCHLAND — alles, was sich MEDIAL AUSSCHLACHTEN lässt: Mietrecht/Mieterschutz,
   Mietendeckel, Enteignungsdebatten, Steuererhöhungen, Grundsteuer-Chaos, Heizungsgesetz,
   Wirtschafts-/Standortfrust — als Kontrast-Aufhänger („echte Rendite & freier Markt in
   Zypern statt Gängelung in DE").
Suche gezielt, wähle die 3 besten Fundstücke und liefere je: Schlagzeile, 1-Satz-Kern,
Quelle (URL), und eine konkrete Post-Idee (1–2 Sätze) im Happy-Property-Ton.${avoid.length ? `\n\nDIESE THEMEN HATTEN WIR SCHON (nicht wiederholen, auch nicht leicht abgewandelt):\n${avoid.map(a => `- ${a}`).join('\n')}` : ''}`
  const resp = await claude(anthropicKey, {
    system,
    messages: [{ role: 'user', content: 'Bitte recherchiere jetzt und liefere die 3 besten aktuellen Fundstücke mit Post-Ideen (deutsch, kompakt).' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    max_tokens: 3000,
  })
  const blocks = (resp.content ?? []) as Array<{ type: string; text?: string }>
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
  if (!text) throw new Error('Recherche lieferte kein Ergebnis.')
  // Fundstücke strukturieren → Ideensammlung (social_ideas)
  const ideasTool = {
    name: 'save_ideas', description: 'Speichert die Fundstücke als Ideen.',
    input_schema: { type: 'object', properties: { ideas: { type: 'array', items: { type: 'object', properties: {
      headline: { type: 'string' }, core: { type: 'string', description: '1-Satz-Kern' },
      url: { type: 'string' }, post_idea: { type: 'string', description: 'konkrete Post-Idee im Happy-Property-Ton' },
    }, required: ['headline', 'core', 'post_idea'] } } }, required: ['ideas'] },
  }
  const structured = await claude(anthropicKey, {
    system: 'Du überträgst Recherche-Fundstücke 1:1 in save_ideas — nichts erfinden, nichts weglassen.',
    messages: [{ role: 'user', content: `Übertrage diese Fundstücke in save_ideas:\n\n${text}` }],
    tools: [ideasTool], tool_choice: { type: 'tool', name: 'save_ideas' }, max_tokens: 3000,
  })
  const tuIdeas = ((structured.content ?? []) as Array<{ type: string; name?: string; input?: { ideas?: Array<{ headline?: string; core?: string; url?: string; post_idea?: string }> } }>).find(b => b.type === 'tool_use' && b.name === 'save_ideas')
  const list = (tuIdeas?.input?.ideas ?? []).filter(i => i.headline)
  if (!list.length) throw new Error('Fundstücke konnten nicht strukturiert werden.')
  const rows = list.map(i => ({ headline: i.headline!.slice(0, 300), core: (i.core ?? '').slice(0, 600), source_url: i.url || null, angle: (i.post_idea ?? '').slice(0, 800) }))
  const { data, error } = await sb.from('social_ideas').insert(rows).select('id, headline, core, source_url, angle')
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<{ id: string; headline: string; core: string; source_url: string | null; angle: string }>
}

// Idee → fertige Texte (Meta/LinkedIn/optional Newsletter) + Bilder. Wirft bei
// Fehlern — der Aufrufer entscheidet, wie das sichtbar wird.
async function ideaContent(sb: SupabaseClient, anthropicKey: string, idea: { headline: string; core: string; source_url: string | null; angle: string }, o: { metaPostId: string; liPostId: string; wantNewsletter: boolean; imgCount: number; ctaKeyword?: string | null }): Promise<void> {
  const stamp = () => new Date().toISOString()
  const outTool = {
    name: 'set_outputs', description: 'Liefert die fertigen Texte für alle gewünschten Ziele.',
    input_schema: { type: 'object', properties: {
      meta_caption: { type: 'string', description: 'Caption für Facebook + Instagram' },
      linkedin_caption: { type: 'string', description: 'Caption für LinkedIn' },
      newsletter_subject: { type: 'string', description: 'Betreff für den Newsletter' },
      newsletter_html: { type: 'string', description: 'Ausführlicher Newsletter als HTML' },
      image_prompt: { type: 'string', description: 'Englisch: eine ALLTÄGLICHE, echte Szene, wie sie jemand mit dem Handy fotografieren würde (Ort, Blickwinkel, Tageszeit, konkrete Details). Keine Drohnenaufnahme, kein goldenes Licht, keine Wörter wie photorealistic/cinematic. Kein Text im Bild.' },
    }, required: ['image_prompt'] },
  }
  const wants: string[] = []
  // Stichwort-Tag: feste Report-Aufforderung. Sonst, sobald ein Stichwort eingestellt
  // ist: keine selbst erfundenen Kommentar-Stichwörter.
  let kwAvoid = false
  if (o.metaPostId && !o.ctaKeyword) { try { kwAvoid = !!(await keywordState(sb)).kw } catch { kwAvoid = false } }
  if (o.metaPostId) wants.push(`- meta_caption: locker & direkt, Hook in Zeile 1, kurze Absätze, 3–6 passende Hashtags, klare Handlungsaufforderung. Max ~1200 Zeichen.${o.ctaKeyword ? ` ${kwNewsInstruction(o.ctaKeyword)}` : kwAvoid ? ` ${KW_AVOID_INSTRUCTION}` : ''}`)
  if (o.liPostId) wants.push('- linkedin_caption: professioneller, persönlicher Ton (Ich-Perspektive Sven), mehr Substanz und Einordnung, Absätze mit Luft, genau 3 dezente Hashtags. 1200–2000 Zeichen.')
  if (o.wantNewsletter) wants.push('- newsletter_subject + newsletter_html: AUSFÜHRLICH (300–500 Wörter), sauberes HTML (h2/p/ul/strong, KEINE Bilder), Anrede „Hallo {{vorname}}", Thema für Investoren/Auswanderer einordnen, Quelle als Link, am Ende Einladung zum Gespräch mit Link https://portal.happy-property.com/termin .')
  const resp2 = await claude(anthropicKey, {
    system: `${BRAND}\n\nDu machst aus einer News-Idee fertige, sofort nutzbare Inhalte. Erfinde keine Zahlen; nutze nur, was die Idee hergibt, und ordne ein. Nenne keine Parteien, Politiker, Kandidaten oder Wahlen: politische Vorgänge nur als Sachthema (Gesetz, Beschluss, Behörde), sonst zeigt Meta den Beitrag kaum Nicht-Followern. Rufe am Ende GENAU EINMAL set_outputs auf.`,
    messages: [{ role: 'user', content: `NEWS-IDEE\nSchlagzeile: ${idea.headline}\nKern: ${idea.core}\nQuelle: ${idea.source_url ?? '—'}\nPost-Winkel: ${idea.angle}\n\nERSTELLE:\n${wants.join('\n')}\n- image_prompt: passend zum Thema (immer).` }],
    tools: [outTool], tool_choice: { type: 'tool', name: 'set_outputs' }, max_tokens: 4000,
  })
  const tu = ((resp2.content ?? []) as Array<{ type: string; name?: string; input?: Record<string, string> }>).find(b => b.type === 'tool_use' && b.name === 'set_outputs')
  const out = tu?.input
  if (!out) throw new Error('Texterstellung lieferte kein Ergebnis.')
  if (o.metaPostId && !out.meta_caption) throw new Error('Meta-Text fehlt.')
  if (o.liPostId && !out.linkedin_caption) throw new Error('LinkedIn-Text fehlt.')

  const metaCaption = out.meta_caption && o.ctaKeyword ? ensureKeywordCta(out.meta_caption, o.ctaKeyword, `Kommentiere ${o.ctaKeyword} und du bekommst unseren aktuellen Zypern-Report als PDF per Nachricht. 📩`) : out.meta_caption
  if (o.metaPostId && metaCaption) await sb.from('social_posts').update({ content: noDash(metaCaption), updated_at: stamp() }).eq('id', o.metaPostId)
  if (o.liPostId && out.linkedin_caption) await sb.from('social_posts').update({ content: noDash(out.linkedin_caption), updated_at: stamp() }).eq('id', o.liPostId)
  if (o.wantNewsletter && out.newsletter_html) {
    await sb.from('newsletter_campaigns').insert({
      title: `📰 ${idea.headline}`.slice(0, 200), subject: (out.newsletter_subject || idea.headline).slice(0, 200),
      content_mode: 'html', html_body: out.newsletter_html, status: 'draft',
    })
  }
  // Bilder: erst an den Meta-Post, dann dieselben an LinkedIn kopieren
  const primary = o.metaPostId || o.liPostId
  if (primary && out.image_prompt) {
    for (let i = 1; i <= o.imgCount; i++) {
      const vary = o.imgCount > 1 ? ` — image ${i} of ${o.imgCount} of a carousel: vary subject, angle and lighting, keep one consistent photorealistic style.` : ''
      await generatePostImage(sb, primary, `${out.image_prompt}${vary}`)
    }
    if (o.liPostId && o.metaPostId) {
      const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', o.metaPostId).maybeSingle()
      const urls = ((cur as { image_urls?: string[] } | null)?.image_urls ?? [])
      if (urls.length) await sb.from('social_posts').update({ image_urls: urls, image_url: urls[0], updated_at: stamp() }).eq('id', o.liPostId)
    }
  }
}

// ── News-Karussell: 6 bis 8 gestaltete Slides statt Einzelbild (Sven 26.9.2026) ──
// Titel-Slide mit echtem Handyfoto-Look (Higgsfield), danach Zahlen/Erklärung/
// Checkliste auf Creme, Schluss-Slide Navy mit Aufruf. Texte kommen von Claude,
// nur aus der News-Idee (keine erfundenen Zahlen).
async function buildNewsCarousel(sb: SupabaseClient, anthropicKey: string, idea: { headline: string; core: string; source_url: string | null; angle: string }, postId: string, ctaKeyword: string | null): Promise<void> {
  const stamp = () => new Date().toISOString()
  const tool = {
    name: 'set_carousel', description: 'Fertiges Karussell.',
    input_schema: { type: 'object', properties: {
      caption: { type: 'string', description: 'Caption für Instagram + Facebook' },
      cover_image_prompt: { type: 'string', description: 'Englisch: alltägliche, echte Szene passend zum Thema, wie ein Handyfoto (Ort, Blickwinkel, Tageszeit). Kein Text im Bild.' },
      slides: { type: 'array', items: { type: 'object', properties: {
        type: { type: 'string', enum: ['cover', 'fact', 'point', 'list', 'cta'] },
        kicker: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' },
        value: { type: 'string' }, label: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' },
        body: { type: 'string' }, items: { type: 'array', items: { type: 'string' } }, button: { type: 'string' },
      }, required: ['type'] } },
    }, required: ['caption', 'cover_image_prompt', 'slides'] },
  }
  const ctaRule = ctaKeyword
    ? `Letzte Slide (cta): title z. B. "Den ganzen Report willst du?", body ein Satz, button genau "Kommentiere ${ctaKeyword}". Die Caption endet mit: Kommentiere ${ctaKeyword} und du bekommst unseren aktuellen Zypern-Report als PDF per Nachricht.`
    : 'Letzte Slide (cta): title z. B. "Speicher dir das für später", body ein Satz, button genau "Beitrag speichern". Keine Kommentar-Stichwörter als Aufforderung, stattdessen in der Caption eine echte Frage an die Community.'
  const resp = await claude(anthropicKey, {
    system: `${BRAND}\n\nDu baust aus einer News ein Instagram-Karussell (6 bis 8 Slides), das man speichern will: klare Zahlen, verständlich eingeordnet, was es für Käufer und Kapitalanleger bedeutet. NUR Fakten aus der Idee, keine erfundenen Zahlen, keine Renditeprognosen. KEINE Parteien, Politiker, Kandidaten oder Wahlen nennen: politische Vorgänge nur als Sachthema (Gesetz, Beschluss, Volksentscheid, Behörde), sonst stuft Meta den Beitrag als politisch ein und zeigt ihn kaum Nicht-Followern. ECHTE UMLAUTE (ä, ö, ü, ß) in jeder Slide, nie ae/oe/ue/ss als Ersatz. Zeichenlimits strikt einhalten (sonst wird gekürzt): cover title max. 45, subtitle max. 70, kicker max. 28; fact value max. 9 Zeichen (z. B. "1.241" oder "+8,9 %"), label max. 60, text max. 170, source nur Name der Quelle; point title max. 55, body max. 320; list title max. 55, 3 bis 4 items je max. 65; cta title max. 45, body max. 140. Reihenfolge: cover, dann 3 bis 6 Slides aus fact/point/list, dann cta. Caption: Zeile 1 = Such-Satz mit Stichwort (z. B. "Immobilien in Paphos: ..."), dann 2 bis 3 kurze Absätze, dann Aufruf, dann 3 bis 5 Hashtags. Rufe GENAU EINMAL set_carousel auf.`,
    messages: [{ role: 'user', content: `NEWS-IDEE\nSchlagzeile: ${idea.headline}\nKern: ${idea.core}\nQuelle: ${idea.source_url ?? '-'}\nWinkel: ${idea.angle}\n\n${ctaRule}` }],
    tools: [tool], tool_choice: { type: 'tool', name: 'set_carousel' }, max_tokens: 4000,
  })
  const out = (((resp.content ?? []) as Array<{ type: string; name?: string; input?: { caption?: string; cover_image_prompt?: string; slides?: unknown[] } }>).find(b => b.type === 'tool_use' && b.name === 'set_carousel')?.input ?? {})
  if (!out.caption || !out.slides) throw new Error('Karussell-Text konnte nicht erstellt werden.')
  const clean = (v: unknown): unknown => typeof v === 'string' ? noDash(v) : Array.isArray(v) ? v.map(clean) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clean(x)])) : v
  let rawSlides: unknown = clean(out.slides)
  // Transliterationen (fuer, Waehrend, heisst) sind ein Tell: einmal reparieren lassen
  const TRANSLIT = /\b(fuer|ueber|koennen|koennte|muessen|waehrend|haelt|zurueck|naechste|spaeter|heisst|groesser|groesste|laeuft|Eigentuemer|Kaeufer|Waehrung|Laender|haeufig|moeglich|natuerlich|wuerde|fuehrt|gegenueber|Gruenen?|aendern|Aenderung|Loesung|oeffentlich|Buero|Steuererklaerung)\b/i
  if (TRANSLIT.test(JSON.stringify(rawSlides))) {
    const fix = await claude(anthropicKey, {
      system: 'Du korrigierst deutsche Texte: ersetze ae/oe/ue/ss-Umschreibungen durch echte Umlaute und ß, wo das Wort sie verlangt (fuer→für, Waehrend→Während, heisst→heißt). Sonst nichts ändern. Gib das JSON-Array unverändert in der Struktur zurück, nur als JSON.',
      messages: [{ role: 'user', content: JSON.stringify(rawSlides) }], max_tokens: 4000,
    })
    const txt = (((fix.content ?? []) as Array<{ type: string; text?: string }>).find(b => b.type === 'text')?.text ?? '').trim().replace(/^```(json)?|```$/g, '').trim()
    try { rawSlides = clean(JSON.parse(txt)) } catch { /* unten prüfen */ }
    if (TRANSLIT.test(JSON.stringify(rawSlides))) throw new Error('Karussell-Texte ohne echte Umlaute, wird neu erstellt.')
  }
  const slides = normalizeSlides(rawSlides)
  const n = slides.length
  const base = Deno.env.get('SUPABASE_URL')
  const ts = Date.now()
  const urls: string[] = []
  let scene = ''
  for (let i = 0; i < n; i++) {
    const s = slides[i]
    let bytes: Uint8Array, ct = 'image/png', ext = 'png'
    if (i === 0 && s.type === 'cover') {
      try {
        const img = await candidImageBytes(sb, out.cover_image_prompt || idea.headline)
        scene = img.scene
        bytes = await composeCover(img.bytes, await svgToPng(coverOverlaySvg(s, n)))
        ct = 'image/jpeg'; ext = 'jpg'
      } catch (e) {
        console.warn('[social-agent] Karussell-Titelfoto fehlgeschlagen, Titel ohne Foto:', e instanceof Error ? e.message : String(e))
        bytes = await svgToPng(slideSvg(s, i, n))
      }
    } else bytes = await svgToPng(slideSvg(s, i, n))
    const path = `social/${postId}-car-${ts}-${i + 1}.${ext}`
    const { error } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: ct, upsert: true })
    if (error) throw new Error(`Upload Slide ${i + 1}: ${error.message}`)
    urls.push(`${base}/storage/v1/object/public/ad-creatives/${path}`)
  }
  let caption = noDash(out.caption)
  if (ctaKeyword) caption = ensureKeywordCta(caption, ctaKeyword, `Kommentiere ${ctaKeyword} und du bekommst unseren aktuellen Zypern-Report als PDF per Nachricht. 📩`)
  await sb.from('social_posts').update({ content: caption, image_urls: urls, image_url: urls[0], format: 'carousel', image_prompt: scene || out.cover_image_prompt || null, updated_at: stamp() }).eq('id', postId)
}

const LOTTE_SYSTEM = `Du bist Lotte: Svens schokobraune Labrador-Hündin und die heimliche Chefin im Büro
von Happy Property in Paphos. Du postest selbst, in Ich-Form, frech, trocken, witzig und
provokant. Dein Leben: Sonne in Paphos, Meer, Terrasse, Leckerlis, Mittagsschlaf und ein
Chef, der den ganzen Tag über Rendite redet. Du schaust mit mildem Mitleid nach Deutschland:
Formulare, Grundsteuer-Bescheide, Heizungsgesetz, Mietendeckel, Tagesgeld-Zinsen, Nieselregen,
Handwerker-Termine in 8 Wochen, Leute, die seit 10 Jahren "bald mal investieren" wollen.

DU BIST KEINE NACHRICHTENSPRECHERIN: keine Studien, keine Gutachten, keine Statistiken,
keine Nachrichten nacherzählen. EINE Beobachtung, EINE Pointe. Kurz und knackig.
PROVOKANT heißt: zugespitzte Meinung, Seitenhieb, Augenzwinkern, ein Satz, über den man
stolpert und den man kommentieren oder teilen will. Frech, nie gemein.
GRENZEN (hart): keine Parteien und keine Politiker nennen (auch nicht CDU, CSU, Union, SPD,
Grüne, FDP, AfD, Linke, BSW, Regierung XY), keine Gruppen von Menschen herabsetzen, keine
Beleidigungen, keine Themen wie Krieg, Religion, Migration, Tod. Keine Zahlen erfinden,
keine Renditeversprechen, kein "garantiert".
FORMAT: Zeile 1 = Hook (max. 10 Wörter, darf provozieren). Dann 2 bis 3 sehr kurze Absätze.
Unterschrift "🐾 Lotte". Danach 3 bis 5 Hashtags (#zypern #paphos plus passende).
Gesamt 250 bis 600 Zeichen. Echte Umlaute (ä, ö, ü, ß). Kein Gedankenstrich (— oder –),
nur normale Bindestriche. Gern am Ende eine kurze Frage, die zum Kommentieren reizt.`

// Themen-Würfel für Lotte: sorgt für Abwechslung, ohne auf Nachrichten angewiesen zu sein.
const LOTTE_THEMES = [
  'Formulare und Behördenpost in Deutschland', 'Tagesgeld-Zinsen vs. Mieteinnahmen', 'Wetter in Deutschland vs. Paphos',
  'Nebenkostenabrechnung', 'Leute, die seit Jahren "bald mal" investieren wollen', 'Heizungsgesetz und Wärmepumpen-Frust',
  'Grundsteuer-Bescheid', 'Bausparvertrag von Oma', 'Sven redet schon wieder über Rendite', 'Siesta und Mittagsschlaf auf der Terrasse',
  'Handwerker-Termine in Deutschland', 'Feriengäste in unseren Wohnungen', 'Pool statt Balkon im Nieselregen', 'Montagmorgen',
  'Steuererklärung', 'Makler-Floskeln wie "gepflegt" und "ruhige Lage"', 'Baustellenbesuch mit Sven', 'Mietendeckel und Vermieterfrust',
  'Leckerli-Inflation', 'Neujahrsvorsätze, die nie umgesetzt werden', 'Kunden, die nach dem ersten Besuch nicht mehr heim wollen',
]


// LinkedIn (Sven, 2x pro Woche): eigene Posts, nicht die News-Captions. Politisch
// angehaucht, streitbar, aber seriös (Svens Vorgabe 26.9.2026).
const LINKEDIN_SYSTEM = `Du schreibst LinkedIn-Posts für Sven Rüprich: Deutscher Unternehmer, lebt in Paphos,
Gründer von Happy Property (Neubau-Kapitalanlagen auf Zypern für deutschsprachige Investoren).
Ich-Perspektive, Sven spricht selbst. Leser: Unternehmer, Selbstständige, Kapitalanleger, Vermieter.

ZIEL: Diskussion auslösen. Politisch angehaucht und streitbar, aber seriös. Eine klare,
pointierte These zu einer AKTUELLEN politischen oder wirtschaftlichen Entwicklung in
Deutschland (oder der EU), die Vermögen, Vermieter, Unternehmer oder Sparer betrifft.
Belegt mit 1 bis 2 konkreten Fakten (Gesetz, Zahl, Beschluss) aus einer echten Quelle.
Sachlicher Ton, klare Kante in der Aussage.

AUFBAU: Zeile 1 = These, die zum Widerspruch reizt (max. 15 Wörter). Dann Kontext mit den
belegten Fakten. Dann Svens Einordnung aus Sicht von jemandem, der Kapital anlegt und im
EU-Ausland lebt. Zypern nur als kurzer Vergleich, wenn es sich natürlich ergibt, KEINE
Werbung, kein Verkaufsaufruf, kein Termin-Link. Schluss: eine offene Frage an die Leser,
die zum Kommentieren und Widersprechen einlädt. Letzte Zeile: "Quelle: <URL>".
Danach genau 3 dezente Hashtags. Länge 1.000 bis 1.800 Zeichen, Absätze mit Leerzeile.

GRENZEN (hart): Politik und Entscheidungen kritisieren, nie Menschen. Parteien und
Politiker nur sachlich nennen, wenn es für den Fakt nötig ist, keine Parteienschelte, kein
Spott über Personen, keine Beleidigungen, kein Populismus ("die da oben"), keine
Verschwörungserzählungen. Keine Themen Migration, Religion, Krieg, Gender. Keine Zahlen
erfinden, nur was die Quelle hergibt. Keine Renditeversprechen.`

const LINKEDIN_THEMES = [
  'Mietrecht, Mietpreisbremse, Mietendeckel-Debatte', 'Grundsteuer-Reform und Hebesätze der Kommunen',
  'Erbschaftsteuer und Vermögensteuer-Debatte', 'Rente, Rentenniveau und private Altersvorsorge',
  'Bürokratie, Genehmigungsdauer, Digitalisierung der Verwaltung', 'Wohnungsbau-Krise, Baugenehmigungen, Neubauzahlen',
  'Heizungsgesetz und Energiepolitik für Eigentümer', 'Steuer- und Abgabenlast für Selbstständige und Mittelstand',
  'Standort Deutschland, Unternehmer wandern ab', 'Sparer, Inflation und Zinsen', 'Wegzugsbesteuerung und Kapitalverkehr in der EU',
  'Kommunale Zweckentfremdungsverbote und Ferienwohnungen',
]

// Reel-Text ohne Textdatei: aus dem Dateinamen (Titel) einen Posting-Text bauen.
async function reelCaption(anthropicKey: string, title: string): Promise<string> {
  const resp = await claude(anthropicKey, {
    system: `${BRAND}\n\nDu schreibst den Posting-Text zu einem kurzen Reel (Sven spricht in die Kamera). Du kennst nur den Titel. Erfinde keine Zahlen oder Details, die nicht im Titel stehen. Rufe GENAU EINMAL set_caption auf.`,
    messages: [{ role: 'user', content: `REEL-TITEL: ${title}\n\nCaption für Instagram + Facebook: Hook in Zeile 1, 2 bis 3 kurze Absätze, die neugierig aufs Reel machen, Hinweis "Termin über den Link in der Bio", 3 bis 5 Hashtags. Max. 700 Zeichen.` }],
    tools: [{ name: 'set_caption', description: 'Fertige Caption.', input_schema: { type: 'object', properties: { caption: { type: 'string' } }, required: ['caption'] } }],
    tool_choice: { type: 'tool', name: 'set_caption' }, max_tokens: 1200,
  })
  const cap = (((resp.content ?? []) as Array<{ type: string; input?: { caption?: string } }>).find(b => b.type === 'tool_use')?.input?.caption ?? '').trim()
  if (!cap) throw new Error('Reel-Text konnte nicht erstellt werden.')
  return cap
}

// Einmalige Aufgabe an Sven (Admin), dedupliziert über den Titel-Anfang.
async function taskForSven(sb: SupabaseClient, title: string, description: string, dedupe: string): Promise<void> {
  const { data: dup } = await sb.from('crm_tasks').select('id').ilike('title', `%${dedupe}%`).neq('status', 'erledigt').eq('archived', false).limit(1)
  if (dup && dup.length) return
  const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
  const adminId = (admin as { id: string } | null)?.id ?? null
  const { data: task } = await sb.from('crm_tasks').insert({ title, description, created_by: adminId, status: 'offen' }).select('id').single()
  const taskId = (task as { id: string } | null)?.id
  if (taskId && adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
}

// 16:9-Thumbnail → 1080×1350-Insta-Format: Hintergrund = unscharfe, abgedunkelte
// Cover-Version des Bilds selbst (bilinear aus stark verkleinerter Quelle = Blur),
// Original pixelgenau mittig. Deterministisch — kein KI-Risiko, keine Balken.
// ── Vergleichs-Karussell (gestaltete Slides mit SCHARFEM Text) ──────────────
// SVG → PNG via resvg-wasm. Text ist echt (kein KI-Gekrakel), 1080×1350 (4:5).
// Chat-editierbar: der Agent schickt die komplette Slide-Liste, wir ersetzen.
let _resvgReady: Promise<unknown> | null = null
function ensureResvg(): Promise<unknown> {
  if (!_resvgReady) _resvgReady = initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm'))
  return _resvgReady
}
async function svgToPng(svg: string): Promise<Uint8Array> {
  await ensureResvg()
  const fontBuffers = await loadCiFonts()
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 1080 }, font: { fontBuffers, defaultFontFamily: CI_FONT.body, loadSystemFonts: false } })
  return r.render().asPng()
}
// Referenzbild fuer ein reales Symbol im Netz finden (Wikimedia Commons):
// beste Quelle fuer Fahnen, Wappen, Wahrzeichen - lizenzfrei und korrekt.
async function wikimediaImage(term: string): Promise<string | null> {
  try {
    const q = encodeURIComponent(term)
    const r = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=5&prop=imageinfo&iiprop=url|mime&iiurlwidth=1200&format=json`,
      { headers: { 'User-Agent': 'HappyPropertyCRM/1.0 (thumbnail references)' } })
    const j = await r.json() as { query?: { pages?: Record<string, { imageinfo?: Array<{ thumburl?: string; url?: string; mime?: string }> }> } }
    const pages = Object.values(j.query?.pages ?? {})
    for (const p of pages) {
      const ii = p.imageinfo?.[0]
      const mime = ii?.mime ?? ''
      const url = ii?.thumburl || ii?.url
      if (url && (mime.startsWith('image/png') || mime.startsWith('image/jpeg') || mime.includes('svg'))) return url
    }
    return null
  } catch (e) { console.warn('[social-agent] wikimedia:', e); return null }
}

// Spruch als grosser, plakativer Text unten links aufs Thumbnail - gerendert
// statt KI-gemalt (Muster wie composeCreative im Anzeigen-Studio).
async function composeSlogan(photoBytes: Uint8Array, slogan: string): Promise<Uint8Array> {
  const img = await Image.decode(photoBytes)
  const W = img.width, H = img.height
  const words = slogan.trim().split(/\s+/)
  const lines: string[] = []; let cur = ''
  for (const w of words) { if ((`${cur} ${w}`).trim().length > 16 && cur) { lines.push(cur); cur = w } else cur = (`${cur} ${w}`).trim() }
  if (cur) lines.push(cur)
  const fs = Math.round(Math.min(W, H) * 0.11)
  const lh = Math.round(fs * 1.14)
  const padX = Math.round(W * 0.045), padY = Math.round(fs * 0.55)
  const boxH = lines.length * lh + padY * 2 - (lh - fs)
  const wMax = Math.max(...lines.map(l => l.length))
  const boxW = Math.min(W - padX, Math.round(wMax * fs * 0.60) + padX * 2)
  const y0 = H - boxH - Math.round(H * 0.06)
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect x="${padX / 2}" y="${y0}" width="${boxW}" height="${boxH}" rx="${Math.round(fs * 0.28)}" fill="${CI.coral}"/>
    <text font-family="${CI_FONT.heading}" font-size="${fs}" font-weight="700" fill="${CI.white}">${lines.map((l, i) =>
      `<tspan x="${padX / 2 + padX}" y="${y0 + padY + fs - Math.round(fs * 0.12) + i * lh}">${esc(l)}</tspan>`).join('')}</text>
  </svg>`
  await ensureResvg()
  const fontBuffers = await loadCiFonts()
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { fontBuffers, defaultFontFamily: CI_FONT.body, loadSystemFonts: false } }).render().asPng()
  img.composite(await Image.decode(png), 0, 0)
  return await img.encodeJPEG(92)
}

const CMP_W = 1080, CMP_H = 1350
const xesc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function xwrap(s: string, max: number): string[] {
  const words = (s ?? '').trim().split(/\s+/).filter(Boolean); const lines: string[] = []; let cur = ''
  for (const w of words) { if ((`${cur} ${w}`).trim().length > max && cur) { lines.push(cur); cur = w } else cur = (`${cur} ${w}`).trim() }
  if (cur) lines.push(cur); return lines.length ? lines : ['']
}
function xtspan(lines: string[], x: number, y: number, lh: number): string {
  return lines.map((l, i) => `<tspan x="${x}" y="${y + i * lh}">${xesc(l)}</tspan>`).join('')
}
interface CmpSlide { kind?: string; kicker?: string; title?: string; subtitle?: string; metric?: string; de?: string; de_note?: string; cy?: string; cy_note?: string; cta?: string }
function cmpSlideSvg(s: CmpSlide): string {
  const F = `font-family="${CI_FONT.body}"`
  const FH = `font-family="${CI_FONT.heading}"`
  const brand = `<text ${F} x="540" y="1290" font-size="26" fill="${CI.mute}" text-anchor="middle" letter-spacing="2">happy-property.com</text>`
  if ((s.kind ?? 'compare') === 'cover') {
    const title = xwrap(s.title ?? 'Deutschland vs. Zypern', 16)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CMP_W}" height="${CMP_H}" viewBox="0 0 ${CMP_W} ${CMP_H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${CI.navyDeep}"/><stop offset="1" stop-color="${CI.navy}"/></linearGradient></defs>
      <rect width="${CMP_W}" height="${CMP_H}" fill="url(#g)"/>
      <text ${F} x="540" y="330" font-size="34" fill="${CI.coral}" font-weight="700" text-anchor="middle" letter-spacing="6">${xesc((s.kicker ?? 'STEUERVERGLEICH').toUpperCase())}</text>
      <text ${FH} font-size="94" fill="${CI.cream}" font-weight="700" text-anchor="middle">${xtspan(title, 540, 560, 108)}</text>
      <text ${F} font-size="38" fill="${CI.line}" text-anchor="middle">${xtspan(xwrap(s.subtitle ?? '', 34), 540, 560 + title.length * 108 + 60, 52)}</text>
      ${brand}</svg>`
  }
  if (s.kind === 'cta') {
    const title = xwrap(s.title ?? 'Weniger Steuern. Mehr Rendite.', 18)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CMP_W}" height="${CMP_H}" viewBox="0 0 ${CMP_W} ${CMP_H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${CI.navyDeep}"/><stop offset="1" stop-color="${CI.navySoft}"/></linearGradient></defs>
      <rect width="${CMP_W}" height="${CMP_H}" fill="url(#g)"/>
      <text ${FH} font-size="80" fill="${CI.cream}" font-weight="700" text-anchor="middle">${xtspan(title, 540, 470, 96)}</text>
      <text ${F} font-size="38" fill="${CI.line}" text-anchor="middle">${xtspan(xwrap(s.subtitle ?? '', 32), 540, 470 + title.length * 96 + 70, 52)}</text>
      <rect x="240" y="960" width="600" height="120" rx="60" fill="${CI.coral}"/>
      <text ${F} x="540" y="1038" font-size="40" fill="${CI.white}" font-weight="700" text-anchor="middle">${xesc(s.cta ?? 'Jetzt Termin sichern')}</text>
      ${brand}</svg>`
  }
  // compare
  const metric = xwrap(s.metric ?? '', 22)
  const deVal = xwrap(s.de ?? '', 12), cyVal = xwrap(s.cy ?? '', 12)
  const deNote = xwrap(s.de_note ?? '', 26), cyNote = xwrap(s.cy_note ?? '', 26)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CMP_W}" height="${CMP_H}" viewBox="0 0 ${CMP_W} ${CMP_H}">
    <rect width="${CMP_W}" height="${CMP_H}" fill="${CI.navyDeep}"/>
    <text ${F} x="540" y="150" font-size="30" fill="${CI.mute}" font-weight="700" text-anchor="middle" letter-spacing="6">DEUTSCHLAND  vs  ZYPERN</text>
    <text ${FH} font-size="72" fill="${CI.cream}" font-weight="700" text-anchor="middle">${xtspan(metric, 540, 268, 82)}</text>
    <rect x="70" y="392" width="440" height="720" rx="30" fill="${CI.navySoft}"/>
    <rect x="70" y="392" width="440" height="92" rx="30" fill="${CI.mute}"/><rect x="70" y="440" width="440" height="44" fill="${CI.mute}"/>
    <text ${F} x="290" y="453" font-size="34" fill="${CI.white}" font-weight="700" text-anchor="middle" letter-spacing="2">DEUTSCHLAND</text>
    <text ${FH} font-size="66" fill="${CI.cream}" font-weight="700" text-anchor="middle">${xtspan(deVal, 290, 640, 76)}</text>
    <text ${F} font-size="30" fill="${CI.line}" text-anchor="middle">${xtspan(deNote, 290, 640 + deVal.length * 76 + 40, 40)}</text>
    <rect x="570" y="392" width="440" height="720" rx="30" fill="${CI.navySoft}"/>
    <rect x="570" y="392" width="440" height="92" rx="30" fill="${CI.coral}"/><rect x="570" y="440" width="440" height="44" fill="${CI.coral}"/>
    <text ${F} x="790" y="453" font-size="34" fill="${CI.white}" font-weight="700" text-anchor="middle" letter-spacing="2">ZYPERN</text>
    <text ${FH} font-size="66" fill="${CI.cream}" font-weight="700" text-anchor="middle">${xtspan(cyVal, 790, 640, 76)}</text>
    <text ${F} font-size="30" fill="${CI.line}" text-anchor="middle">${xtspan(cyNote, 790, 640 + cyVal.length * 76 + 40, 40)}</text>
    <circle cx="540" cy="752" r="54" fill="${CI.cream}"/><text ${F} x="540" y="768" font-size="36" fill="${CI.navy}" font-weight="700" text-anchor="middle">vs</text>
    ${brand}</svg>`
}
async function renderComparison(sb: SupabaseClient, postId: string, slides: CmpSlide[], replace: boolean): Promise<string[]> {
  const base = Deno.env.get('SUPABASE_URL')
  const urls: string[] = []
  for (let i = 0; i < slides.length; i++) {
    const png = await svgToPng(cmpSlideSvg(slides[i]))
    const path = `social/${postId}-cmp-${Date.now()}-${i}.png`
    const { error } = await sb.storage.from('ad-creatives').upload(path, png, { contentType: 'image/png', upsert: true })
    if (error) throw new Error(`Upload Slide ${i + 1}: ${error.message}`)
    urls.push(`${base}/storage/v1/object/public/ad-creatives/${path}`)
  }
  const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
  const prev = (!replace && Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls)) ? (cur as { image_urls: string[] }).image_urls : []
  const all = [...prev, ...urls]
  await sb.from('social_posts').update({ image_urls: all, image_url: all[0], format: 'carousel', updated_at: new Date().toISOString() }).eq('id', postId)
  return urls
}

function bilinearCover(srcSmall: Image, W: number, H: number, dim: number): Image {
  const targetAR = W / H
  let cw = srcSmall.width, ch = srcSmall.height
  if (cw / ch > targetAR) cw = Math.max(2, Math.round(ch * targetAR))
  else ch = Math.max(2, Math.round(cw / targetAR))
  const c = srcSmall.clone().crop(Math.round((srcSmall.width - cw) / 2), Math.round((srcSmall.height - ch) / 2), cw, ch)
  const out = new Image(W, H)
  for (let y = 0; y < H; y++) {
    const gy = (y / (H - 1)) * (ch - 1), yA = Math.floor(gy), fy = gy - yA, yB = Math.min(ch - 1, yA + 1)
    for (let x = 0; x < W; x++) {
      const gx = (x / (W - 1)) * (cw - 1), xA = Math.floor(gx), fx = gx - xA, xB = Math.min(cw - 1, xA + 1)
      const [r00, g00, b00] = Image.colorToRGBA(c.getPixelAt(xA + 1, yA + 1))
      const [r10, g10, b10] = Image.colorToRGBA(c.getPixelAt(xB + 1, yA + 1))
      const [r01, g01, b01] = Image.colorToRGBA(c.getPixelAt(xA + 1, yB + 1))
      const [r11, g11, b11] = Image.colorToRGBA(c.getPixelAt(xB + 1, yB + 1))
      const r = (r00 * (1 - fx) + r10 * fx) * (1 - fy) + (r01 * (1 - fx) + r11 * fx) * fy
      const g = (g00 * (1 - fx) + g10 * fx) * (1 - fy) + (g01 * (1 - fx) + g11 * fx) * fy
      const b = (b00 * (1 - fx) + b10 * fx) * (1 - fy) + (b01 * (1 - fx) + b11 * fx) * fy
      out.setPixelAt(x + 1, y + 1, Image.rgbToColor(Math.round(r * dim), Math.round(g * dim), Math.round(b * dim)))
    }
  }
  return out
}
async function igFrame(jpgBytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const src = await Image.decode(jpgBytes)
    // Blur-Hintergrund: winzige Quelle (48px) bilinear auf halbe Zielgröße,
    // dann ×2 — schnell und butterweich.
    const tiny = src.clone().resize(20, Image.RESIZE_AUTO)
    const bgHalf = bilinearCover(tiny, 540, 675, 0.5)
    const bg = bgHalf.resize(1080, 1350)
    const thumb = src.resize(1080, Image.RESIZE_AUTO)
    bg.composite(thumb, 0, Math.round((1350 - thumb.height) / 2))
    return await bg.encodeJPEG(88)
  } catch (e) { console.warn('[social-agent] igFrame:', e); return null }
}

// ── Zugriffsschutz ────────────────────────────────────────────────────────────
// Welche Mitarbeiter-Rechte eine Aktion öffnen (Admin/Verwalter dürfen alles) -
// spiegelt die Routen im Frontend: Social-Studio = funnel, Thumbnail-Studio =
// thumbnails, YouTube-Center (lädt auch die Thumbnail-Liste) = youtube.
function permsFor(action: string): string[] {
  if (action.startsWith('thumbnail_')) return ['thumbnails', 'youtube']
  if (action === 'youtube_post' || action === 'yt_check') return ['youtube', 'funnel']
  return ['funnel']
}
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
/** null = erlaubt, sonst die fertige 401/403-Antwort. */
async function authorize(sb: SupabaseClient, req: Request, action: string): Promise<Response | null> {
  const cronSecret = req.headers.get('x-cron-secret') ?? ''
  if (cronSecret) {
    const { data } = await sb.from('connector_secrets').select('value').eq('key', 'CRON_SECRET_SOCIAL').maybeSingle()
    if (sameSecret(cronSecret, (data as { value?: string } | null)?.value ?? '')) return null
    return json({ error: 'Nicht angemeldet' }, 401)
  }
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return json({ error: 'Nicht angemeldet' }, 401)
  if (sameSecret(jwt, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) return null
  const { data: u } = await sb.auth.getUser(jwt)
  const uid = u?.user?.id
  if (!uid) return json({ error: 'Nicht angemeldet' }, 401)
  const { data: prof } = await sb.from('profiles').select('role, permissions').eq('id', uid).maybeSingle()
  const p = prof as { role?: string | null; permissions?: Record<string, boolean> | null } | null
  const perms = permsFor(action)
  const ok = p?.role === 'admin' || p?.role === 'verwalter'
    || (p?.role === 'mitarbeiter' && perms.some(k => !!p.permissions?.[k]))
    // Rolle 'funnel' kommt laut Routing ins Social-Studio, aber nicht in Thumbnails/YouTube
    || (p?.role === 'funnel' && perms[0] === 'funnel')
  return ok ? null : json({ error: 'Keine Berechtigung' }, 403)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; post_id?: string; message?: string; prompt?: string; platform?: string; persona?: string; user_id?: string; video_id?: string; url?: string; id?: string }
    const denied = await authorize(sb, req, body.action ?? '')
    if (denied) return denied

    // ── Chat: Post formulieren/verfeinern, Agent setzt den Text direkt ─────────
    if (body.action === 'chat') {
      if (!body.post_id || !body.message?.trim()) return json({ error: 'post_id/message fehlt' }, 400)
      const { data: post } = await sb.from('social_posts').select('*').eq('id', body.post_id).maybeSingle()
      if (!post) return json({ error: 'Post nicht gefunden' }, 404)
      const p = post as Record<string, unknown>
      const { data: hist } = await sb.from('social_post_messages').select('role, content').eq('post_id', body.post_id).order('created_at').limit(30)
      const projects = await projectContext(sb)

      // Vorhandene Bilder (nummeriert) — Basis für „bearbeite Bild 2"-Wünsche.
      const imgList = Array.isArray(p.image_urls) ? (p.image_urls as string[]) : []
      const imgCtx = imgList.length ? `\nVorhandene Bilder am Post (für edit_image per Nummer):\n${imgList.map((u, i) => `${i + 1}. ${u}`).join('\n')}` : ''

      // Gewähltes Projekt / gewählte Wohnung: echte Portal-Daten in den Kontext.
      let focus = ''
      if (p.project_id) {
        const { data: pr } = await sb.from('crm_projects').select('name, location, status, deck_assets').eq('id', p.project_id).maybeSingle()
        const prj = pr as { name: string; location: string | null; status: string | null; deck_assets: { facts?: string } | null } | null
        if (prj) {
          focus = `\nDIESER POST STELLT VOR: Projekt „${prj.name}" (${prj.location ?? 'Zypern'}${prj.status ? `, ${prj.status}` : ''}).`
          if (prj.deck_assets?.facts) focus += `\nProjekt-Fakten (echte Daten aus dem Portal, NUR diese verwenden):\n${String(prj.deck_assets.facts).slice(0, 2500)}`
        }
        if (p.unit_id) {
          const { data: un } = await sb.from('crm_project_units').select('unit_number, price_net, bedrooms, size_sqm, floor').eq('id', p.unit_id).maybeSingle()
          const u = un as { unit_number: string; price_net: number | null; bedrooms: number | null; size_sqm: number | null; floor: string | null } | null
          if (u) focus += `\nKonkret Wohnung ${u.unit_number}: ${u.bedrooms ?? '?'} Schlafzimmer, ${u.size_sqm ?? '?'} m²${u.floor ? `, Etage ${u.floor}` : ''}${u.price_net ? `, ${u.price_net.toLocaleString('de-DE')} € netto` : ''}.`
        }
      }

      const system = `${BRAND}

Du bist der Social-Media-Redakteur im Happy-Property-CRM. Sven (oder ein Mitarbeiter)
bespricht mit dir EINEN Post. Aktueller Stand:
- Thema: ${p.topic} ${p.topic === 'weisheit' ? '(Absender ist LOTTE — Hunde-Perspektive, humorvoll!)' : ''}
- Plattformen: ${(p.platforms as string[] ?? []).join(', ')}
- Aktueller Text: ${p.content ? `"""${p.content}"""` : '(noch leer)'}
${p.news_source ? `- News-Bezug: ${p.news_source}` : ''}
${focus}

Alle Projekte im Überblick (echte Daten, NUR diese verwenden):
${projects}

${imgCtx}

Regeln:
- Wenn du einen Post-Text erstellst oder änderst, rufe IMMER das Tool set_post auf
  (kompletter neuer Text). Antworte zusätzlich kurz im Chat, was du gemacht hast.
- Hashtags am Ende, 3–6 Stück. Instagram verträgt mehr Emojis als LinkedIn.
- image_prompt: nur setzen, wenn ein neues Bild sinnvoll ist — englisch, fotorealistisch
  bzw. passend zum Thema, OHNE Text im Bild.
- Für VERGLEICHE / Gegenüberstellungen / Infografiken / „Karussell mit Fakten"
  (z.B. Deutschland vs. Zypern) NICHT make_image nehmen (KI verhunzt Text),
  sondern make_comparison mit gestalteten Slides. Immer die komplette Slide-Liste
  übergeben. Nur echte Fakten, knappe Werte, keine Gedankenstriche.
- Erfinde keine Zahlen/Fakten. Bei Objekt-Posts nur die Projektdaten oben.`

      const messages = [
        ...((hist ?? []) as Array<{ role: string; content: string }>).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: body.message.trim() },
      ]
      const tools = [{
        name: 'set_post',
        description: 'Setzt den aktuellen Post-Text (und optional einen Bild-Prompt) im Editor.',
        input_schema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Der komplette Post-Text' },
            image_prompt: { type: 'string', description: 'Optional: englischer Bild-Prompt ohne Text im Bild' },
          },
          required: ['content'],
        },
      }, {
        name: 'make_image',
        description: 'Erzeugt SOFORT ein neues Bild zum Post (Higgsfield). Nutzen, wenn der Nutzer ein Bild will oder Änderungen am Bild wünscht — der Prompt muss zum aktuellen Post-Text passen.',
        input_schema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Englischer Bild-Prompt, passend zum Post-Text, ohne Text/Wasserzeichen im Bild' },
            include: { type: 'array', items: { type: 'string', enum: ['lotte', 'sven'] }, description: 'Echte Personas einbeziehen: lotte (Svens Hündin, echtes Aussehen) und/oder sven (Sven Rüprich, echtes Aussehen)' },
          },
          required: ['prompt'],
        },
      }, {
        name: 'make_comparison',
        description: 'Erzeugt/ERSETZT ein VERGLEICHS-KARUSSELL mit gestalteten Slides und SCHARFEM, korrektem Text (kein KI-Foto). Nutzen, wenn der Nutzer einen Vergleich, eine Gegenüberstellung (z.B. Deutschland vs. Zypern), eine Infografik oder ein Karussell mit Fakten will ODER Änderungen daran wünscht (Farbe, Text, Slide hinzufügen/ändern). WICHTIG: immer die KOMPLETTE, aktuelle Slide-Liste übergeben (auch unveränderte Slides), da das Karussell komplett ersetzt wird. Struktur: erste Slide kind=cover (kicker/title/subtitle), dann je Vergleichspunkt kind=compare (metric + de/de_note + cy/cy_note), am Ende kind=cta (title/subtitle/cta). Nur echte Fakten, kurze Werte (JA/NEIN, „0 %", „11-14 %"). Keine Gedankenstriche.',
        input_schema: {
          type: 'object',
          properties: {
            slides: {
              type: 'array', description: 'Alle Slides in Reihenfolge',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['cover', 'compare', 'cta'] },
                  kicker: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' },
                  metric: { type: 'string', description: 'Überschrift des Vergleichspunkts (nur compare)' },
                  de: { type: 'string', description: 'Großer Wert Deutschland-Spalte (nur compare)' },
                  de_note: { type: 'string', description: 'Kleiner Zusatz Deutschland (nur compare)' },
                  cy: { type: 'string', description: 'Großer Wert Zypern-Spalte (nur compare)' },
                  cy_note: { type: 'string', description: 'Kleiner Zusatz Zypern (nur compare)' },
                  cta: { type: 'string', description: 'Button-Text (nur cta)' },
                },
                required: ['kind'],
              },
            },
          },
          required: ['slides'],
        },
      }, {
        name: 'edit_image',
        description: 'BEARBEITET ein vorhandenes Bild des Posts per KI (z.B. spielende Kinder vor dem Haus ergänzen, Himmel ändern). image_number = Nummer aus der Bilderliste.',
        input_schema: {
          type: 'object',
          properties: {
            image_number: { type: 'integer', description: 'Nummer des zu bearbeitenden Bilds (1-basiert)' },
            prompt: { type: 'string', description: 'Englische Bearbeitungs-Anweisung (was ergänzt/geändert wird), fotorealistisch, ohne Text im Bild' },
          },
          required: ['image_number', 'prompt'],
        },
      }]
      const resp = await claude(anthropicKey, { system, messages, tools })
      const blocks = (resp.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: { content?: string; image_prompt?: string; prompt?: string } }>
      let reply = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      const toolUse = blocks.find(b => b.type === 'tool_use' && b.name === 'set_post')
      let newContent: string | null = null
      if (toolUse?.input?.content) {
        newContent = toolUse.input.content
        const patch: Record<string, unknown> = { content: newContent, updated_at: new Date().toISOString() }
        if (toolUse.input.image_prompt) patch.image_prompt = toolUse.input.image_prompt
        await sb.from('social_posts').update(patch).eq('id', body.post_id)
      }
      // Bild-Wunsch aus dem Chat: make_image → sofort generieren, passend zum Text.
      let newImageUrl: string | null = null
      const editTool = blocks.find(b => b.type === 'tool_use' && b.name === 'edit_image') as { input?: { image_number?: number; prompt?: string } } | undefined
      if (editTool?.input?.prompt && editTool.input.image_number) {
        const srcUrl = imgList[editTool.input.image_number - 1]
        if (srcUrl) {
          try {
            newImageUrl = await editPostImage(sb, body.post_id, srcUrl, editTool.input.prompt)
            reply = reply ? `${reply}\n\n🎨 Bearbeitetes Bild ist fertig.` : '🎨 Bearbeitetes Bild ist fertig — als neues Bild angehängt (Original bleibt).'
          } catch (e) { reply = `${reply}\n\n❌ Bild-Bearbeitung fehlgeschlagen: ${(e as Error).message}`.trim() }
        } else { reply = `${reply}\n\n❌ Bild ${editTool.input.image_number} gibt es nicht.`.trim() }
      }
      // Vergleichs-Karussell aus dem Chat: gestaltete Slides (scharfer Text) im Hintergrund rendern.
      const cmpTool = blocks.find(b => b.type === 'tool_use' && b.name === 'make_comparison') as { input?: { slides?: CmpSlide[] } } | undefined
      let imagePending = false
      if (cmpTool?.input?.slides && Array.isArray(cmpTool.input.slides) && cmpTool.input.slides.length) {
        const slides = cmpTool.input.slides
        const job = async () => { try { await renderComparison(sb, body.post_id!, slides, true) } catch (e) { console.error('[social-agent] chat comparison:', e) } }
        if (typeof EdgeRuntime !== 'undefined') { EdgeRuntime.waitUntil(job()); imagePending = true; reply = reply ? `${reply}\n\n🖼️ Vergleichs-Karussell wird erstellt (${slides.length} Slides) — erscheint gleich in der Bilderliste.` : `🖼️ Vergleichs-Karussell wird erstellt (${slides.length} Slides) — erscheint gleich in der Bilderliste.` }
        else { await job() }
      }
      const imgTool = blocks.find(b => b.type === 'tool_use' && b.name === 'make_image') as { input?: { prompt?: string; include?: string[] } } | undefined
      if (!imagePending && !newImageUrl && imgTool?.input?.prompt) {
        const inc = Array.isArray(imgTool.input.include) ? imgTool.input.include.filter(x => x === 'lotte' || x === 'sven') : []
        const mkPrompt = imgTool.input.prompt
        const job = async () => {
          try {
            if (inc.length) await generatePersonaImage(sb, body.post_id, mkPrompt, inc)
            else await generatePostImage(sb, body.post_id, mkPrompt)
          } catch (e) {
            console.error('[social-agent] chat image bg:', e)
            if (inc.length) { try { await generatePostImage(sb, body.post_id, mkPrompt) } catch (e2) { console.error('[social-agent] chat image fallback:', e2) } }
          }
        }
        if (typeof EdgeRuntime !== 'undefined') {
          EdgeRuntime.waitUntil(job()); imagePending = true
          const withWho = inc.length ? ` (mit ${inc.map(x => x === 'lotte' ? 'Lotte' : 'Sven').join(' + ')}, nach echten Referenzfotos)` : ''
          reply = reply ? `${reply}\n\n🎨 Bild wird erstellt${withWho} — es erscheint gleich in der Bilderliste.` : `🎨 Bild wird erstellt${withWho} — es erscheint gleich in der Bilderliste.`
        } else { await job() }
      }
      // Verlauf speichern
      await sb.from('social_post_messages').insert([
        { post_id: body.post_id, role: 'user', content: body.message.trim() },
        { post_id: body.post_id, role: 'assistant', content: reply || (newContent ? 'Post aktualisiert ✓' : '…') },
      ])
      return json({ ok: true, reply: reply || (newContent ? 'Ich habe den Post-Text aktualisiert. ✓' : ''), content: newContent, image_url: newImageUrl, image_pending: imagePending, image_prompt: toolUse?.input?.image_prompt ?? null })
    }

    // ── Vergleichs-Karussell direkt erzeugen (aus dem Studio) ─────────────────
    if (body.action === 'comparison_carousel') {
      const b = body as unknown as { post_id?: string; slides?: CmpSlide[]; replace?: boolean }
      if (!b.post_id || !Array.isArray(b.slides) || !b.slides.length) return json({ error: 'post_id und slides erforderlich' }, 400)
      try {
        const urls = await renderComparison(sb, b.post_id, b.slides, b.replace !== false)
        return json({ ok: true, urls, count: urls.length })
      } catch (e) { return json({ error: (e as Error).message }, 500) }
    }

    // ── Bild via Higgsfield → ad-creatives/social/… ──────────────────────────
    // ── Bild eines Posts ersetzen (neues Rezept/Modell), Text bleibt ────────────
    if (body.action === 'regen_image') {
      const { data: pr } = await sb.from('social_posts').select('id, status, image_prompt, title, content').eq('id', String(body.post_id ?? '')).maybeSingle()
      const post = pr as { id: string; status: string; image_prompt: string | null; title: string | null; content: string | null } | null
      if (!post) return json({ error: 'Post nicht gefunden' }, 404)
      if (post.status === 'gepostet') return json({ error: 'Post ist schon gelaufen' }, 400)
      const idea = String(body.prompt ?? '').trim() || post.image_prompt || `${post.title ?? ''}. ${(post.content ?? '').slice(0, 400)}`
      const job = (async () => {
        await sb.from('social_posts').update({ image_urls: [], image_url: null, updated_at: new Date().toISOString() }).eq('id', post.id)
        await generatePostImage(sb, post.id, idea)
      })()
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job.catch(e => console.error('[social-agent] regen_image:', e))); else await job
      return json({ ok: true, pending: true })
    }
    // ── Higgsfield-Jobtyp prüfen, ohne ein Bild zu erzeugen (ungültiges Format) ──
    if (body.action === 'hf_probe') {
      try { await hfGenerateBytes(sb, String(body.job_type ?? ''), { ...(((body as Record<string, unknown>).params as Record<string, unknown>) ?? {}), prompt: 'probe', aspect_ratio: 'zz' }); return json({ ok: false, note: 'unerwartet erzeugt' }) }
      catch (e) { return json({ ok: true, error: e instanceof Error ? e.message : String(e) }) }
    }

    if (body.action === 'image') {
      if (!body.post_id) return json({ error: 'post_id fehlt' }, 400)
      const { data: post } = await sb.from('social_posts').select('image_prompt, content, topic').eq('id', body.post_id).maybeSingle()
      const p = post as { image_prompt: string | null; content: string | null; topic: string | null } | null
      const prompt = (body.prompt ?? p?.image_prompt ?? '').trim()
        || `Photorealistic lifestyle image matching this social media post about premium new-build real estate investment in Cyprus (Paphos): "${(p?.content ?? '').slice(0, 300)}". Mediterranean light, modern architecture, no text, no watermarks.`
      // Im HINTERGRUND generieren: Higgsfield-Bilder (Job + Polling, ~15-40 s)
      // dauern zu lange für einen synchronen Klick — der Button bekäme sonst
      // einen Gateway-Abbruch („Failed to send a request to the Edge Function").
      const inc = p?.topic === 'weisheit' ? ['lotte'] : []
      const job = async () => {
        try {
          if (inc.length) await generatePersonaImage(sb, body.post_id, prompt, inc)
          else await generatePostImage(sb, body.post_id, prompt)
        } catch (e) {
          console.error('[social-agent] image bg:', e)
          // Sicherheitsnetz: Persona fehlgeschlagen → normales Bild versuchen
          if (inc.length) { try { await generatePostImage(sb, body.post_id, prompt) } catch (e2) { console.error('[social-agent] image fallback:', e2) } }
        }
      }
      if (typeof EdgeRuntime !== 'undefined') { EdgeRuntime.waitUntil(job()); return json({ ok: true, pending: true, prompt }) }
      await job()
      return json({ ok: true, pending: false, prompt })
    }

    // ── Persona-Testlauf (Debug): synchron, liefert URL oder ECHTEN Fehler ───
    if (body.action === 'persona_test') {
      try {
        const url = await generatePersonaImage(sb, String(body.post_id ?? ''), String(body.prompt ?? 'sitting relaxed on a Mediterranean terrace in Cyprus, sea view'), Array.isArray(body.include) ? (body.include as string[]) : ['lotte'])
        return json({ ok: true, url })
      } catch (e) { return json({ error: (e as Error).message }, 500) }
    }

    // ── Thumbnail-Studio: Prompt → Plattform-Bild (Soul-Charaktere) ──────────
    // Universell für YouTube/Instagram/Story/Facebook/LinkedIn — je Plattform
    // das passende Format. Verlauf in thumbnail_creations (RLS deny-all, Zugriff
    // nur über diese Aktionen). YouTube-Set lädt das Bild als 1280×720-JPEG hoch.
    if (body.action === 'thumbnail_generate') {
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) return json({ error: 'Prompt fehlt.' }, 400)
      const PLAT_ASPECT: Record<string, string> = { youtube: '16:9', instagram: '3:4', story: '9:16', facebook: '1:1', linkedin: '16:9' }
      const platform = Object.keys(PLAT_ASPECT).includes(String(body.platform)) ? String(body.platform) : 'youtube'
      const persona = ['sven', 'lotte', 'none'].includes(String(body.persona)) ? String(body.persona) : 'sven'
      // Im HINTERGRUND generieren: Soul-Bilder brauchen oft laenger als 60 s,
      // und Safari bricht jede Anfrage nach 60 s hart ab („Failed to send a
      // request to the Edge Function" — Sven/Leonard, 21.8.). Deshalb: Zeile
      // sofort anlegen, Job im Hintergrund, Frontend fragt thumbnail_status.
      const cfg = await personaCfg(sb)
      const soulId = persona === 'sven' ? cfg.sven_soul_id : persona === 'lotte' ? cfg.lotte_soul_id : undefined
      if (persona !== 'none' && !soulId) return json({ error: 'Soul-ID fehlt in den Einstellungen (social_persona_refs).' }, 500)
      const { data: row } = await sb.from('thumbnail_creations')
        .insert({ platform, prompt, persona, image_url: null, created_by: typeof body.user_id === 'string' && body.user_id ? body.user_id : null })
        .select('id').maybeSingle()
      const thumbId = (row as { id?: string } | null)?.id
      if (!thumbId) return json({ error: 'Konnte Auftrag nicht anlegen.' }, 500)
      const work = async () => {
        try {
          // 1) Wunsch in einen sauberen Bild-Prompt uebersetzen. Vorher ging der
          //    deutsche Satz („Ich hätte gern ein Thumbnail von …") ROH an die
          //    Bild-KI - halbe Anweisungen wie Fahne oder Spruch fielen unter den
          //    Tisch (Sven 21.8.). Ein Spruch wird ausserdem NIE von der KI gemalt
          //    (unleserliches Gekrakel), sondern anschliessend als echter Text
          //    aufs Bild gerendert.
          let scene = prompt, slogan = '', refSearch = ''
          try {
            const resp = await claude(anthropicKey, {
              system: 'You turn a German thumbnail wish into a compact ENGLISH image prompt (max 60 words) for a photorealistic generator. Context: "Lotte" is a chocolate labrador dog (never a person), "Sven" is the male founder of Happy Property; character reference images provide their look. Include EVERY requested visual element and refer to reference images where given (e.g. "the flag from the reference image"). NO text/typography in the scene. Separately extract: the exact slogan the user wants ON the image (empty string if none), and reference_search = a short English Wikimedia search term for any SPECIFIC real-world symbol/object the generator will hallucinate without a reference (a national flag, coat of arms, a specific landmark, a logo) - empty string if none. Reply ONLY as JSON {"scene":"...","slogan":"...","reference_search":""} with no other words.',
              messages: [{ role: 'user', content: prompt }], max_tokens: 1000,
            })
            const raw = ((resp.content as Array<{ type: string; text?: string }>) ?? []).find(b => b.type === 'text')?.text ?? ''
            const m = raw.match(/\{[\s\S]*\}/)
            if (m) { const j = JSON.parse(m[0]) as { scene?: string; slogan?: string; reference_search?: string }; if (j.scene) scene = j.scene; slogan = (j.slogan ?? '').trim(); refSearch = (j.reference_search ?? '').trim() }
          } catch (pe) { console.warn('[social-agent] thumbnail prompt rewrite:', pe) }

          const who = persona === 'sven' ? ' The image shows Sven Rüprich, founder of Happy Property (the trained character), as the main subject.'
            : persona === 'lotte' ? " The image shows Lotte, Sven's chocolate labrador and office boss (the trained character), as the main subject." : ''
          const params: Record<string, unknown> = {
            prompt: `${scene}.${who} Eye-catching social media thumbnail composition, expressive, photorealistic, natural lighting, crisp details, no text, no watermark.`,
            aspect_ratio: PLAT_ASPECT[platform], quality: '2k',
          }
          if (soulId) params.custom_reference_id = soulId
          // Exakte Symbole (Fahnen, Wappen, Logos, Wahrzeichen) kann KEIN
          // Bildmodell aus der Beschreibung treffen - es halluziniert (Sven 21.8.,
          // Zypernfahne). Deshalb: (a) selbst hochgeladene Referenzbilder
          // (body.ref_urls aus dem Studio-Upload) und (b) automatisch im Netz
          // recherchierte Referenzen (Wikimedia) gehen als ECHTE Referenzbilder an
          // nano_banana (Multi-Referenz). Ohne Referenzen bleibt es beim
          // Soul-Modell mit trainierter Persona.
          const refUrls: string[] = Array.isArray(body.ref_urls) ? (body.ref_urls as string[]).filter(u => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 3) : []
          let searchedRef: string | null = null
          if (refSearch) searchedRef = await wikimediaImage(refSearch)
          let bytes: Uint8Array
          if (refUrls.length || searchedRef) {
            const refs: Array<{ id: string }> = []
            const personaFoto = persona === 'sven'
              ? 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/sven-termin.jpg'
              : persona === 'lotte' ? 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte1.jpg' : null
            const pushRef = async (url: string) => {
              const b = new Uint8Array(await (await fetch(url)).arrayBuffer())
              refs.push({ id: await hfUploadImage(sb, b, 'image/auto') })   // Helfer wandelt nach PNG
            }
            if (personaFoto) await pushRef(personaFoto)
            for (const u of refUrls) await pushRef(u)
            if (searchedRef) await pushRef(searchedRef)
            const who2 = persona === 'sven' ? ' The man from the first reference image is the main subject (same face, same person).'
              : persona === 'lotte' ? ' The chocolate labrador from the first reference image is the main subject (same dog).' : ''
            bytes = await hfGenerateBytes(sb, 'nano_banana', {
              prompt: `${scene}.${who2} Objects and symbols shown in the other reference images must appear EXACTLY as depicted there (accurate shapes, colours and details - especially flags and emblems). Photorealistic, natural lighting, no text, no watermark.`,
              aspect_ratio: PLAT_ASPECT[platform], image_references: refs,
            })
          } else {
            bytes = await hfGenerateBytes(sb, 'text2image_soul_v2', params)
          }
          // 2) Spruch als gerenderter Text (gestochen scharf, korrekte Umlaute).
          if (slogan) {
            try { bytes = await composeSlogan(bytes, slogan) }
            catch (ce) { console.error('[social-agent] thumbnail slogan:', ce) /* Bild ohne Text statt gar nichts */ }
          }
          const ext = slogan ? 'jpg' : 'png'
          const path = `thumbnails/${Date.now()}-${platform}.${ext}`
          const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: slogan ? 'image/jpeg' : 'image/png', upsert: true })
          if (upErr) throw new Error(`Upload: ${upErr.message}`)
          const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
          await sb.from('thumbnail_creations').update({ image_url: url }).eq('id', thumbId)
        } catch (e) {
          console.error('[social-agent] thumbnail bg:', e)
          await sb.from('thumbnail_creations').update({ error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq('id', thumbId)
        }
      }
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work()); else await work()
      return json({ ok: true, pending: true, id: thumbId, platform })
    }

    // Debug: Prompt-Umschreibung isoliert testen (synchron, kein Bild).
    if (body.action === 'thumbnail_rewrite_test') {
      const resp = await claude(anthropicKey, {
        system: 'You turn a German thumbnail wish into a compact ENGLISH image prompt (max 60 words) for a photorealistic generator. Context: "Lotte" is a chocolate labrador dog (never a person), "Sven" is the male founder of Happy Property; character reference images provide their look. Include EVERY requested visual element and refer to reference images where given (e.g. "the flag from the reference image"). NO text/typography in the scene. Separately extract: the exact slogan the user wants ON the image (empty string if none), and reference_search = a short English Wikimedia search term for any SPECIFIC real-world symbol/object the generator will hallucinate without a reference (a national flag, coat of arms, a specific landmark, a logo) - empty string if none. Reply ONLY as JSON {"scene":"...","slogan":"...","reference_search":""} with no other words.',
        messages: [{ role: 'user', content: String(body.prompt ?? '') }], max_tokens: 1000,
      })
      return json({ ok: true, resp })
    }

    // Status eines Thumbnail-Jobs (Frontend-Polling alle paar Sekunden).
    if (body.action === 'thumbnail_status') {
      const { data } = await sb.from('thumbnail_creations').select('image_url, error').eq('id', String(body.id ?? '')).maybeSingle()
      const r = data as { image_url: string | null; error?: string | null } | null
      if (!r) return json({ status: 'unknown' })
      if (r.error) return json({ status: 'error', error: r.error })
      if (r.image_url) return json({ status: 'done', url: r.image_url })
      return json({ status: 'pending' })
    }

    if (body.action === 'thumbnail_list') {
      // Laufende/gescheiterte Jobs haben image_url null - nicht listen.
      const { data } = await sb.from('thumbnail_creations')
        .select('id, platform, prompt, persona, image_url, video_id, created_at')
        .not('image_url', 'is', null)
        .order('created_at', { ascending: true }).limit(50)
      return json({ ok: true, items: data ?? [] })
    }

    if (body.action === 'thumbnail_videos') {
      const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? ''
      const [cid, csec, rtok] = [await cs('YOUTUBE_CLIENT_ID'), await cs('YOUTUBE_CLIENT_SECRET'), await cs('YOUTUBE_REFRESH_TOKEN')]
      if (!cid || !csec || !rtok) return json({ error: 'YouTube nicht verbunden.' }, 400)
      try {
        const td = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }) }).then(r => r.json()) as { access_token?: string }
        if (!td.access_token) return json({ error: 'YouTube-OAuth fehlgeschlagen.' }, 502)
        const hdr = { Authorization: `Bearer ${td.access_token}` }
        const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', { headers: hdr }).then(r => r.json()) as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }
        const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
        if (!uploads) return json({ error: 'YouTube-Kanal nicht gefunden.' }, 502)
        const pl = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=15`, { headers: hdr }).then(r => r.json()) as { items?: Array<{ snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string }; thumbnails?: { default?: { url?: string } } } }> }
        const items = (pl.items ?? []).map(i => ({ video_id: i.snippet?.resourceId?.videoId ?? '', title: i.snippet?.title ?? '', published_at: i.snippet?.publishedAt ?? '', thumb: i.snippet?.thumbnails?.default?.url ?? '' })).filter(v => v.video_id)
        return json({ ok: true, items })
      } catch (e) { return json({ error: (e as Error).message }, 502) }
    }

    if (body.action === 'thumbnail_set') {
      const videoId = String(body.video_id ?? '').trim()
      const imgUrl = String(body.url ?? '').trim()
      if (!videoId || !imgUrl) return json({ error: 'video_id und url erforderlich.' }, 400)
      // Nur im Studio erzeugte Bilder (eigener Bucket) — kein beliebiger Fremd-Fetch.
      if (!imgUrl.startsWith(`${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/`)) {
        return json({ error: 'Nur im Studio erzeugte Bilder können gesetzt werden.' }, 400)
      }
      const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? ''
      const [cid, csec, rtok] = [await cs('YOUTUBE_CLIENT_ID'), await cs('YOUTUBE_CLIENT_SECRET'), await cs('YOUTUBE_REFRESH_TOKEN')]
      if (!cid || !csec || !rtok) return json({ error: 'YouTube nicht verbunden.' }, 400)
      try {
        const src = await fetch(imgUrl)
        if (!src.ok) return json({ error: 'Bild nicht ladbar.' }, 400)
        // YouTube-Limit 2 MB → auf 1280×720 cover-croppen und als JPEG hochladen.
        const img = await Image.decode(new Uint8Array(await src.arrayBuffer()))
        const W = 1280, H = 720
        let cw = img.width, chh = img.height
        if (cw / chh > W / H) cw = Math.round(chh * (W / H)); else chh = Math.round(cw / (W / H))
        const jpg = await img.clone().crop(Math.round((img.width - cw) / 2), Math.round((img.height - chh) / 2), cw, chh).resize(W, H).encodeJPEG(88)
        const td = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }) }).then(r => r.json()) as { access_token?: string }
        if (!td.access_token) return json({ error: 'YouTube-OAuth fehlgeschlagen.' }, 502)
        const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
          method: 'POST', headers: { Authorization: `Bearer ${td.access_token}`, 'Content-Type': 'image/jpeg' }, body: jpg,
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) return json({ error: `YouTube: ${JSON.stringify((d as { error?: { message?: string } })?.error?.message ?? d).slice(0, 200)}` }, 502)
        if (typeof body.id === 'string' && body.id) await sb.from('thumbnail_creations').update({ video_id: videoId }).eq('id', body.id)
        return json({ ok: true })
      } catch (e) { return json({ error: (e as Error).message }, 502) }
    }

    // ── YouTube-Sonntagsvideo → Wochen-Posts (So 11:30 CY per Cron) ──────────
    // Neuestes Video vom Kanal holen, Thumbnail sichern, Meta- + LinkedIn-Post
    // texten und OHNE Freigabe für Montag einplanen (Meta 18:30 CY, LinkedIn
    // 08:30 CY). Idempotent über news_source = Video-URL.
    if (body.action === 'youtube_post') {
      const CHANNEL = 'UC7SGGkCGeiY8XQZGvdyNr9A'
      const feed = typeof body.video_id === 'string' && body.video_id ? '' : await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`)).text()
      // Neuestes ECHTES Video suchen — Shorts aussortieren (Svens Vorgabe):
      // /shorts/<id> antwortet für Shorts mit 200, echte Videos leiten auf /watch um.
      let vid = '', title = '', desc = ''
      // Aus dem YouTube-Center: konkretes Video statt „neuestes im Feed".
      if (typeof body.video_id === 'string' && body.video_id) {
        vid = body.video_id
        title = String(body.title ?? '').trim()
        desc = String(body.description ?? '').trim().slice(0, 1500)
      }
      for (const entry of vid ? [] : feed.split('<entry>').slice(1, 9)) {
        const v = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
        if (!v) continue
        // GOTCHA: ohne Consent-Cookie leitet YouTube aus Rechenzentren ALLES auf die
        // Consent-Seite um — der Redirect-Test wird dann wertlos. Cookie + doppelte
        // Absicherung über die Videolänge (<4 Min = Short/Clip → überspringen).
        const ytHdr = { Cookie: 'CONSENT=YES+cb; SOCS=CAI', 'User-Agent': 'Mozilla/5.0' }
        const head = await fetch(`https://www.youtube.com/shorts/${v}`, { redirect: 'manual', headers: ytHdr })
        if (head.status === 200) continue   // Short → überspringen
        const watchHtml = await (await fetch(`https://www.youtube.com/watch?v=${v}`, { headers: ytHdr })).text()
        const secs = Number(watchHtml.match(/"lengthSeconds":"(\d+)"/)?.[1] ?? 0)
        if (secs > 0 && secs < 240) continue   // zu kurz → auch überspringen
        vid = v
        title = (entry.match(/<title>([^<]+)<\/title>/)?.[1] ?? '').trim()
        desc = (entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ?? '').trim().slice(0, 1500)
        break
      }
      if (!vid) return json({ error: 'Kein echtes Video (ohne Shorts) im Feed gefunden' }, 502)
      const videoUrl = `https://www.youtube.com/watch?v=${vid}`
      const { data: dup } = await sb.from('social_posts').select('id').eq('news_source', videoUrl).limit(1)
      if (dup && dup.length) return json({ success: true, skipped: 'Video bereits verarbeitet', video: videoUrl })

      // Thumbnail sichern (maxres, sonst hq)
      let thumbUrl: string | null = null
      let igUrl: string | null = null
      // thumb_url (YouTube-Center): eigenes/signiertes Bild zuerst - private Videos
      // liefern unter i.ytimg.com oft nur den grauen 404-Platzhalter.
      const thumbSrcs = [...(typeof body.thumb_url === 'string' && body.thumb_url ? [body.thumb_url] : []), `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`]
      for (const src of thumbSrcs) {
        const r = await fetch(src)
        if (r.ok && Number(r.headers.get('content-length') ?? 0) > 0 && Number(r.headers.get('content-length') ?? 0) < 1500) continue   // grauer Platzhalter (1097 Bytes)
        if (r.ok) {
          const bytes = new Uint8Array(await r.arrayBuffer())
          const path = `social/yt-${vid}.jpg`
          const { error } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/jpeg', upsert: true })
          if (!error) thumbUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
          // Insta-Rahmen (4:5) für FB/IG — 16:9-Original bleibt für LinkedIn
          const framed = await igFrame(bytes)
          if (framed) {
            const p2 = `social/yt-${vid}-ig.jpg`
            const { error: e2 } = await sb.storage.from('ad-creatives').upload(p2, framed, { contentType: 'image/jpeg', upsert: true })
            if (!e2) igUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${p2}`
          }
          break
        }
      }

      const resp = await claude(anthropicKey, {
        system: `${BRAND}\n\nDu textest die Wochen-Posts zum neuen YouTube-Video. Der Video-Link MUSS im Text stehen. Rufe GENAU EINMAL set_outputs auf.`,
        messages: [{ role: 'user', content: `NEUES VIDEO\nTitel: ${title}\nLink: ${videoUrl}\nBeschreibung: ${desc}\n\nERSTELLE:\n- meta_caption: locker & neugierig machend für FB+Instagram, Hook in Zeile 1, kurze Absätze, Video-Link im Text, 3-5 Hashtags, Hinweis "Link auch in der Bio".\n- linkedin_caption: professioneller für LinkedIn — was lernt man im Video, für wen ist es relevant, persönliche Note (Ich-Perspektive Sven), Video-Link, genau 3 Hashtags.` }],
        tools: [{ name: 'set_outputs', description: 'Fertige Texte.', input_schema: { type: 'object', properties: { meta_caption: { type: 'string' }, linkedin_caption: { type: 'string' } }, required: ['meta_caption', 'linkedin_caption'] } }],
        tool_choice: { type: 'tool', name: 'set_outputs' }, max_tokens: 2500,
      })
      const out = (((resp.content ?? []) as Array<{ type: string; input?: Record<string, string> }>).find(b => b.type === 'tool_use')?.input ?? {}) as { meta_caption?: string; linkedin_caption?: string }
      if (!out.meta_caption || !out.linkedin_caption) return json({ error: 'Texterstellung fehlgeschlagen' }, 502)

      // Nächsten Montag in Zypern-Zeit berechnen (UTC-Offset via Intl)
      const cyOffsetMin = (d: Date) => {
        const m: Record<string, string> = {}
        for (const pt of new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Nicosia', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d)) m[pt.type] = pt.value
        return (Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second) - d.getTime()) / 60000
      }
      // not_before (YouTube-Center): Posts erst NACH der geplanten Veröffentlichung
      const nb = typeof body.not_before === 'string' && body.not_before ? new Date(body.not_before) : null
      const now = nb && !isNaN(nb.getTime()) && nb.getTime() > Date.now() ? nb : new Date()
      const cyNow = new Date(now.getTime() + cyOffsetMin(now) * 60000)
      const daysToMon = ((8 - cyNow.getUTCDay()) % 7) || 7
      const monday = new Date(Date.UTC(cyNow.getUTCFullYear(), cyNow.getUTCMonth(), cyNow.getUTCDate() + daysToMon))
      const atCy = (h: number, mi: number) => {
        const guess = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate(), h, mi))
        return new Date(guess.getTime() - cyOffsetMin(guess) * 60000).toISOString()
      }
      await sb.from('social_topics').upsert({ key: 'youtube', label: 'YouTube-Video', icon: '🎬', sort: 90 }, { onConflict: 'key', ignoreDuplicates: true })
      const metaImg = igUrl ?? thumbUrl
      // as_draft (YouTube-Center): als Entwurf anlegen, Freigabe im Social Studio.
      const base = { topic: 'youtube', news_source: videoUrl, format: 'single', status: body.as_draft ? 'entwurf' : 'geplant', image_url: thumbUrl, image_urls: thumbUrl ? [thumbUrl] : [] }
      const { data: p1, error: e1 } = await sb.from('social_posts').insert({ ...base, image_url: metaImg, image_urls: metaImg ? [metaImg] : [], title: `🎬 ${title}`.slice(0, 200), content: out.meta_caption, platforms: ['facebook', 'instagram'], scheduled_for: atCy(18, 30) }).select('id').single()
      if (e1) return json({ error: e1.message }, 500)
      const { data: p2, error: e2 } = await sb.from('social_posts').insert({ ...base, title: `🎬 in · ${title}`.slice(0, 200), content: out.linkedin_caption, platforms: ['linkedin'], scheduled_for: atCy(8, 30) }).select('id').single()
      if (e2) return json({ error: e2.message }, 500)
      return json({ success: true, video: videoUrl, title, thumb: thumbUrl, meta_post: (p1 as { id: string }).id, linkedin_post: (p2 as { id: string }).id, meta_at: atCy(18, 30), linkedin_at: atCy(8, 30) })
    }

    // ── Insta-Rahmen für bestehenden Post nachziehen ─────────────────────────
    if (body.action === 'ig_frame') {
      const { data: pr } = await sb.from('social_posts').select('id, image_url').eq('id', String(body.post_id ?? '')).maybeSingle()
      const post = pr as { id: string; image_url: string | null } | null
      if (!post?.image_url) return json({ error: 'Post/Bild nicht gefunden' }, 404)
      const bytes = new Uint8Array(await (await fetch(post.image_url)).arrayBuffer())
      const framed = await igFrame(bytes)
      if (!framed) return json({ error: 'Rahmen fehlgeschlagen' }, 500)
      const path = `social/igframe-${post.id}-${Date.now()}.jpg`
      const { error } = await sb.storage.from('ad-creatives').upload(path, framed, { contentType: 'image/jpeg', upsert: true })
      if (error) return json({ error: error.message }, 500)
      const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
      await sb.from('social_posts').update({ image_url: url, image_urls: [url], updated_at: new Date().toISOString() }).eq('id', post.id)
      return json({ success: true, url })
    }

    // ── Meta-Token-Scopes prüfen (Debug für Publishing-Berechtigungen) ───────
    // ── Interaktionen: Kommentare + DMs von FB/IG/YouTube einsammeln ─────────
    if (body.action === 'interactions_sync') {
      const out: Record<string, unknown> = { fb_comments: 0, ig_comments: 0, fb_msgs: 0, ig_msgs: 0, yt_comments: 0 }
      const errs: string[] = []
      const up = async (row: Record<string, unknown>) => {
        const bucket = String(row._bucket)
        delete row._bucket   // Hilfsfeld — existiert nicht als Spalte
        const { error } = await sb.from('social_interactions').upsert(row, { onConflict: 'external_id', ignoreDuplicates: true })
        if (error) errs.push(`upsert: ${error.message}`)
        else out[bucket] = Number(out[bucket] ?? 0) + 1
      }
      const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? ''
      const metaToken = await cs('META_ACCESS_TOKEN')
      let pageId = '', pageToken = '', igId = ''
      if (metaToken) {
        try {
          const acc = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${metaToken}`).then(r => r.json()) as { data?: Array<{ id: string; access_token: string; instagram_business_account?: { id: string } }>; error?: { message?: string } }
          const page = acc.data?.[0]
          if (page) { pageId = page.id; pageToken = page.access_token; igId = page.instagram_business_account?.id ?? '' }
          else errs.push(`me/accounts: ${acc.error?.message ?? 'keine Seite'}`)
        } catch (e) { errs.push(`me/accounts: ${(e as Error).message}`) }
      } else errs.push('META_ACCESS_TOKEN fehlt')
      const G = 'https://graph.facebook.com/v21.0'
      if (pageId) {
        // FB-Kommentare (letzte 25 Posts)
        try {
          const posts = await fetch(`${G}/${pageId}/posts?fields=id,message&limit=25&access_token=${pageToken}`).then(r => r.json()) as { data?: Array<{ id: string; message?: string }>; error?: { message?: string } }
          if (posts.error) throw new Error(posts.error.message)
          let fbErrN = 0
          for (const post of posts.data ?? []) {
            const cs2 = await fetch(`${G}/${post.id}/comments?fields=id,from{name,id},message,created_time,comments.limit(10){from}&filter=stream&limit=50&access_token=${pageToken}`).then(r => r.json()) as { data?: Array<{ id: string; from?: { name?: string; id?: string }; message?: string; created_time?: string; comments?: { data?: Array<{ from?: { id?: string } }> } }>; error?: { message?: string; code?: number } }
            if (cs2.error) {
              // Graph-Fehler nicht mehr verschlucken (wie bei den IG-Kommentaren, max. 3 aufführen)
              if (++fbErrN <= 3) errs.push(`fb_comments ${post.id}: ${redactToken(`${cs2.error.message ?? 'unbekannter Fehler'}${cs2.error.code ? ` (#${cs2.error.code})` : ''}`).slice(0, 200)}`)
              continue
            }
            for (const c of cs2.data ?? []) {
              if (!c.message || c.from?.id === pageId) continue
              // Schon von der Seite beantwortet (egal ob per App oder Portal) → überspringen
              if ((c.comments?.data ?? []).some(r2 => r2.from?.id === pageId)) continue
              await up({ _bucket: 'fb_comments', platform: 'facebook', kind: 'comment', external_id: c.id, thread_ref: post.id, post_preview: (post.message ?? '').slice(0, 120), author_name: c.from?.name ?? null, author_id: c.from?.id ?? null, text: c.message, happened_at: c.created_time ?? null, raw: c })
            }
          }
          if (fbErrN > 3) errs.push(`fb_comments: ${fbErrN - 3} weitere Posts mit Fehler`)
        } catch (e) { errs.push(`fb_comments: ${(e as Error).message}`) }
        // FB- + IG-Direktnachrichten (Conversations)
        for (const plat of ['messenger', 'instagram'] as const) {
          try {
            const convs = await fetch(`${G}/${pageId}/conversations?platform=${plat}&fields=id,messages.limit(15){id,from,message,created_time}&limit=25&access_token=${pageToken}`).then(r => r.json()) as { data?: Array<{ id: string; messages?: { data?: Array<{ id: string; from?: { name?: string; id?: string }; message?: string; created_time?: string }> } }>; error?: { message?: string } }
            if (convs.error) throw new Error(convs.error.message)
            for (const conv of convs.data ?? []) {
              // Zeitpunkt UNSERER letzten Antwort in dieser Konversation — alles
              // davor gilt als erledigt (wurde per App/Portal schon beantwortet).
              const ours = (conv.messages?.data ?? []).filter(m => m.from?.id === pageId || m.from?.id === igId)
              const lastOurs = ours.length ? Math.max(...ours.map(m => new Date(m.created_time ?? 0).getTime())) : 0
              for (const m of conv.messages?.data ?? []) {
                if (!m.message || m.from?.id === pageId || m.from?.id === igId) continue
                if (lastOurs && new Date(m.created_time ?? 0).getTime() <= lastOurs) continue
                await up({ _bucket: plat === 'messenger' ? 'fb_msgs' : 'ig_msgs', platform: plat === 'messenger' ? 'facebook' : 'instagram', kind: 'message', external_id: m.id, thread_ref: conv.id, author_name: m.from?.name ?? null, author_id: m.from?.id ?? null, text: m.message, happened_at: m.created_time ?? null, raw: m })
              }
            }
          } catch (e) { errs.push(`${plat}_msgs: ${(e as Error).message}`) }
        }
        // IG-Kommentare (letzte 25 Medien). Token im Header, jeder Graph-Fehler landet
        // in errors (vorher wurde er lautlos verschluckt), author_id = from.id.
        if (igId) {
          type GErr = { error?: { message?: string; code?: number } }
          const igGet = async <T>(path: string, params: Record<string, string>): Promise<T & GErr> => {
            const u = new URL(`${G}/${path}`)
            for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
            try {
              const r = await fetch(u, { headers: { Authorization: `Bearer ${pageToken}` }, signal: AbortSignal.timeout(25000) })
              const d = await r.json().catch(() => null) as (T & GErr) | null
              return d ?? ({ error: { message: `HTTP ${r.status}` } } as T & GErr)
            } catch (e) { return { error: { message: (e as Error).message } } as T & GErr }
          }
          const gMsg = (e: GErr['error']) => redactToken(`${e?.message ?? 'unbekannter Fehler'}${e?.code ? ` (#${e.code})` : ''}`).slice(0, 200)
          try {
            const igMe = await igGet<{ username?: string }>(igId, { fields: 'username' })
            if (igMe.error) errs.push(`ig_me: ${gMsg(igMe.error)}`)
            const igUser = igMe.username ?? 'happy_property_cyprus'
            const media = await igGet<{ data?: Array<{ id: string; caption?: string }> }>(`${igId}/media`, { fields: 'id,caption', limit: '25' })
            if (media.error) throw new Error(gMsg(media.error))
            let igErrN = 0
            for (const md of media.data ?? []) {
              const cs3 = await igGet<{ data?: Array<{ id: string; from?: { id?: string; username?: string }; username?: string; text?: string; timestamp?: string; replies?: { data?: Array<{ username?: string }> } }> }>(`${md.id}/comments`, { fields: 'id,from,username,text,timestamp,replies.limit(10){username}', limit: '50' })
              if (cs3.error) {
                // je Medium ein Fehler ist meist derselbe (Rechte/Token) - nur die ersten 3 aufführen
                if (++igErrN <= 3) errs.push(`ig_comments ${md.id}: ${gMsg(cs3.error)}`)
                continue
              }
              for (const c of cs3.data ?? []) {
                const uname = c.username ?? c.from?.username
                if (!c.text || uname === igUser || c.from?.id === igId) continue
                if ((c.replies?.data ?? []).some(r2 => r2.username === igUser)) continue
                await up({ _bucket: 'ig_comments', platform: 'instagram', kind: 'comment', external_id: c.id, thread_ref: md.id, post_preview: (md.caption ?? '').slice(0, 120), author_name: uname ?? null, author_id: c.from?.id ?? null, text: c.text, happened_at: c.timestamp ?? null, raw: c })
              }
            }
            if (igErrN > 3) errs.push(`ig_comments: ${igErrN - 3} weitere Medien mit Fehler`)
          } catch (e) { errs.push(`ig_comments: ${redactToken((e as Error).message)}`) }
        }
      }
      // YouTube-Kommentare (wenn OAuth-Connector eingerichtet)
      const [ycid, ycsec, yrtok] = [await cs('YOUTUBE_CLIENT_ID'), await cs('YOUTUBE_CLIENT_SECRET'), await cs('YOUTUBE_REFRESH_TOKEN')]
      if (ycid && ycsec && yrtok) {
        try {
          const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: ycid, client_secret: ycsec, refresh_token: yrtok, grant_type: 'refresh_token' }) }).then(r => r.json()) as { access_token?: string }
          if (!tr.access_token) throw new Error('OAuth fehlgeschlagen')
          const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { headers: { Authorization: `Bearer ${tr.access_token}` } }).then(r => r.json()) as { items?: Array<{ id: string }> }
          const chId = ch.items?.[0]?.id
          if (chId) {
            const th = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&allThreadsRelatedToChannelId=${chId}&maxResults=50&order=time`, { headers: { Authorization: `Bearer ${tr.access_token}` } }).then(r => r.json()) as { items?: Array<{ id: string; snippet?: { videoId?: string; topLevelComment?: { id: string; snippet?: { authorDisplayName?: string; textDisplay?: string; publishedAt?: string; authorChannelId?: { value?: string } } } }; replies?: { comments?: Array<{ snippet?: { authorChannelId?: { value?: string } } }> } }> }
            for (const t2 of th.items ?? []) {
              const c = t2.snippet?.topLevelComment
              if (!c?.snippet?.textDisplay) continue
              if (c.snippet.authorChannelId?.value === chId) continue
              if ((t2.replies?.comments ?? []).some(r2 => r2.snippet?.authorChannelId?.value === chId)) continue
              await up({ _bucket: 'yt_comments', platform: 'youtube', kind: 'comment', external_id: c.id, thread_ref: t2.snippet?.videoId ?? null, author_name: c.snippet.authorDisplayName ?? null, author_id: c.snippet.authorChannelId?.value ?? null, text: c.snippet.textDisplay.replace(/<[^>]+>/g, ''), happened_at: c.snippet.publishedAt ?? null, raw: t2 })
            }
          }
        } catch (e) { errs.push(`yt: ${(e as Error).message}`) }
      }
      // Letzten Lauf merken (für die Anzeige im Studio), Fehlertexte ohne Zugangsdaten
      const errors = errs.map(e => redactToken(e).slice(0, 300))
      const { error: lrErr } = await sb.from('crm_settings').upsert({ key: 'social_interactions_last_run', value: JSON.stringify({ at: new Date().toISOString(), counts: out, errors }), updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (lrErr) console.error('[social-agent] interactions last_run:', lrErr.message)
      return json({ ok: true, ...out, errors })
    }

    // ── Interaktion beantworten (Kommentar-Reply / DM) ───────────────────────
    if (body.action === 'interactions_reply') {
      const b = body as unknown as { id?: string; text?: string }
      if (!b.id || !b.text?.trim()) return json({ error: 'id und text erforderlich' })
      const { data: rowRaw } = await sb.from('social_interactions').select('*').eq('id', b.id).maybeSingle()
      const row = rowRaw as { id: string; platform: string; kind: string; external_id: string; thread_ref: string | null; author_id: string | null; replied_at: string | null } | null
      if (!row) return json({ error: 'Interaktion nicht gefunden' })
      if (row.replied_at) return json({ error: 'Bereits beantwortet' })
      const text = b.text.trim()
      const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? ''
      const G = 'https://graph.facebook.com/v21.0'
      try {
        if (row.platform === 'youtube') {
          const [ycid, ycsec, yrtok] = [await cs('YOUTUBE_CLIENT_ID'), await cs('YOUTUBE_CLIENT_SECRET'), await cs('YOUTUBE_REFRESH_TOKEN')]
          if (!ycid) throw new Error('YouTube nicht verbunden')
          const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: ycid, client_secret: ycsec, refresh_token: yrtok, grant_type: 'refresh_token' }) }).then(r => r.json()) as { access_token?: string }
          const rr = await fetch('https://www.googleapis.com/youtube/v3/comments?part=snippet', { method: 'POST', headers: { Authorization: `Bearer ${tr.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ snippet: { parentId: row.external_id, textOriginal: text } }) })
          if (!rr.ok) throw new Error(`YouTube ${rr.status}: ${(await rr.text()).slice(0, 160)}`)
        } else {
          const metaToken = await cs('META_ACCESS_TOKEN')
          const acc = await fetch(`${G}/me/accounts?fields=id,access_token&access_token=${metaToken}`).then(r => r.json()) as { data?: Array<{ id: string; access_token: string }> }
          const page = acc.data?.[0]
          if (!page) throw new Error('Meta-Seite nicht erreichbar')
          if (row.kind === 'comment') {
            const ep = row.platform === 'instagram' ? `${G}/${row.external_id}/replies` : `${G}/${row.external_id}/comments`
            const rr = await fetch(ep, { method: 'POST', body: new URLSearchParams({ message: text, access_token: page.access_token }) })
            const rd = await rr.json() as { id?: string; error?: { message?: string } }
            if (!rr.ok || !rd.id) throw new Error(rd.error?.message ?? `Meta ${rr.status}`)
          } else {
            if (!row.author_id) throw new Error('Kein Absender zum Antworten')
            const rr = await fetch(`${G}/${page.id}/messages?access_token=${page.access_token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: row.author_id }, messaging_type: 'RESPONSE', message: { text } }) })
            const rd = await rr.json() as { message_id?: string; error?: { message?: string } }
            if (!rr.ok || !rd.message_id) throw new Error(rd.error?.message ?? `Meta ${rr.status}`)
          }
        }
        await sb.from('social_interactions').update({ replied_at: new Date().toISOString(), reply_text: text, ...(row.kind === 'comment' ? { archived_at: new Date().toISOString() } : {}) }).eq('id', row.id)
        return json({ ok: true })
      } catch (e) { return json({ error: (e as Error).message }) }
    }

    if (body.action === 'interactions_archive') {
      const b = body as unknown as { id?: string }
      if (!b.id) return json({ error: 'id fehlt' })
      await sb.from('social_interactions').update({ archived_at: new Date().toISOString() }).eq('id', b.id)
      return json({ ok: true })
    }

    if (body.action === 'yt_check') {
      const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? ''
      const [cid, csec, rtok] = [await cs('YOUTUBE_CLIENT_ID'), await cs('YOUTUBE_CLIENT_SECRET'), await cs('YOUTUBE_REFRESH_TOKEN')]
      const out: Record<string, unknown> = { cid_len: cid.length, cid_ends: cid.slice(-30), csec_len: csec.length, rtok_len: rtok.length, rtok_start: rtok.slice(0, 4) }
      const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cid.trim(), client_secret: csec.trim(), refresh_token: rtok.trim(), grant_type: 'refresh_token' }) })
      const td = await tr.json() as { access_token?: string; error?: string; error_description?: string }
      out.oauth = td.access_token ? 'OK' : `${td.error}: ${td.error_description}`
      if (td.access_token) {
        const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${td.access_token}` } }).then(r => r.json()) as { items?: Array<{ snippet?: { title?: string } }> }
        out.channel = ch.items?.[0]?.snippet?.title ?? 'kein Kanal'
      }
      return json(out)
    }

    if (body.action === 'meta_scopes') {
      const { data: mtRow } = await sb.from('connector_secrets').select('value').eq('key', 'META_ACCESS_TOKEN').maybeSingle()
      const tok = (mtRow as { value: string } | null)?.value ?? Deno.env.get('META_ACCESS_TOKEN') ?? ''
      if (!tok) return json({ error: 'Kein META_ACCESS_TOKEN' }, 400)
      const d = await fetch(`https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(tok)}&access_token=${encodeURIComponent(tok)}`).then(x => x.json())
      const perms = await fetch(`https://graph.facebook.com/v21.0/me/permissions?access_token=${encodeURIComponent(tok)}`).then(x => x.json())
      return json({ ok: true, debug: d?.data ?? d, permissions: perms?.data ?? perms })
    }

    // ── Drive-Bild in den Assets-Bucket kopieren (z.B. Lotte-Personas) ───────
    if (body.action === 'import_drive_asset') {
      const b = body as unknown as { file_id?: string; dest?: string }
      if (!b.file_id || !b.dest) return json({ error: 'file_id und dest erforderlich' }, 400)
      try {
        const token = await driveToken()
        const blob = await driveDownload(token, b.file_id)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const ct = b.dest.endsWith('.png') ? 'image/png' : 'image/jpeg'
        const { error: upErr } = await sb.storage.from('Assets').upload(b.dest, bytes, { contentType: ct, upsert: true })
        if (upErr) return json({ error: upErr.message }, 500)
        const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/Assets/${b.dest}`
        return json({ ok: true, url, bytes: bytes.length })
      } catch (e) { return json({ error: (e as Error).message }, 502) }
    }

    // ── Referenz-Check (Debug): welche Lotte/Sven-Fotos sieht der Agent? ─────
    if (body.action === 'persona_check') {
      try {
        const cfg = await personaCfg(sb); const token = await driveToken()
        let lotte = cfg.lotte_folder ? await driveImages(token, cfg.lotte_folder, 0, 10) : []
        if (!lotte.length && cfg.lotte_fallback_folder) lotte = await driveImages(token, cfg.lotte_fallback_folder, 0, 10)
        const sven = cfg.sven_folder ? await driveImages(token, cfg.sven_folder, cfg.sven_min_bytes ?? 500000, 10) : []
        return json({ ok: true, lotte: lotte.map(f => f.name), sven: sven.map(f => f.name) })
      } catch (e) { return json({ error: (e as Error).message }, 502) }
    }

    // ── News-Recherche → Aufgabe für Sven ─────────────────────────────────────
    if (body.action === 'news_scan') {
      const rows = await newsScan(sb, anthropicKey)
      return json({ ok: true, ideas: rows.length })
    }

    // ── Idee verwenden: Captions je Plattform + Bilder + optional Newsletter ──
    if (body.action === 'use_idea') {
      const ideaId = String(body.idea_id ?? '')
      const sel = Array.isArray(body.platforms) ? (body.platforms as string[]).filter(p => ['facebook', 'instagram', 'linkedin', 'youtube'].includes(p)) : []
      const wantNewsletter = body.newsletter === true
      const wantMeta = sel.includes('facebook') || sel.includes('instagram')
      const wantLi = sel.includes('linkedin')
      const format = body.format === 'carousel' ? 'carousel' : 'single'
      const imgCount = format === 'carousel' ? Math.max(2, Math.min(10, Number(body.image_count) || 3)) : 1
      if (!ideaId || (!wantMeta && !wantLi && !wantNewsletter)) return json({ error: 'Bitte Idee und mindestens ein Ziel wählen.' }, 400)
      const { data: ideaRow } = await sb.from('social_ideas').select('*').eq('id', ideaId).maybeSingle()
      if (!ideaRow) return json({ error: 'Idee nicht gefunden.' }, 404)
      const idea = ideaRow as { headline: string; core: string; source_url: string | null; angle: string }

      // Entwürfe SOFORT anlegen (noch ohne Text) und antworten — Texte und
      // Bilder entstehen danach im Hintergrund. So wartet der Browser nie
      // 30–120 s auf die KI (das lief in einen Netzwerk-Abbruch).
      const postIds: string[] = []
      let metaPostId = ''
      let liPostId = ''
      if (wantMeta) {
        const { data: p1, error: e1 } = await sb.from('social_posts').insert({
          topic: 'news', title: `📰 ${idea.headline}`.slice(0, 200),
          platforms: sel.filter(p => p !== 'linkedin'), format, status: 'entwurf', news_source: idea.source_url,
        }).select('id').single()
        if (e1) return json({ error: e1.message }, 500)
        metaPostId = (p1 as { id: string }).id; postIds.push(metaPostId)
      }
      if (wantLi) {
        // LinkedIn: kein Karussell — bekommt das erste Bild
        const { data: p2, error: e2 } = await sb.from('social_posts').insert({
          topic: 'news', title: `📰 in · ${idea.headline}`.slice(0, 200),
          platforms: ['linkedin'], format: 'single', status: 'entwurf', news_source: idea.source_url,
        }).select('id').single()
        if (e2) return json({ error: e2.message }, 500)
        liPostId = (p2 as { id: string }).id; postIds.push(liPostId)
      }
      await sb.from('social_ideas').update({ status: 'verwendet', used_post_ids: postIds }).eq('id', ideaId)

      const job = (async () => {
        const stamp = () => new Date().toISOString()
        try {
          await ideaContent(sb, anthropicKey, idea, { metaPostId, liPostId, wantNewsletter, imgCount })
        } catch (e) {
          console.error('[social-agent] use_idea Hintergrund:', e)
          // Entwürfe nicht stumm leer lassen — Hinweis in den Post schreiben.
          const hint = `⚠️ Die Textautomatik ist ausgefallen (${e instanceof Error ? e.message : 'Fehler'}).\nSchreib den Text hier im Chat neu — die Idee steht im Titel.`
          for (const id of [metaPostId, liPostId].filter(Boolean)) {
            const { data: cur } = await sb.from('social_posts').select('content').eq('id', id).maybeSingle()
            if (!((cur as { content?: string } | null)?.content ?? '').trim()) await sb.from('social_posts').update({ content: hint, updated_at: stamp() }).eq('id', id)
          }
        }
      })()
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job); else await job

      return json({ ok: true, post_ids: postIds, campaign_id: null, images_pending: postIds.length ? imgCount : 0, texts_pending: true, newsletter_pending: wantNewsletter })
    }

    // ── LinkedIn-Token-Wächter (Cron täglich): Aufgabe NUR wenn ein hinterlegter
    // Token abgelaufen/ungültig ist — mit direktem Erneuerungs-Link. ──
    if (body.action === 'linkedin_watchdog') {
      const { data: row } = await sb.from('connector_secrets').select('value').eq('key', 'LINKEDIN_ACCESS_TOKEN').maybeSingle()
      const tok = (row as { value: string } | null)?.value ?? ''
      if (!tok) return json({ ok: true, skipped: 'Kein Token hinterlegt (nie verbunden).' })
      const me = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.ok).catch(() => false)
      if (me) return json({ ok: true, valid: true })
      // Abgelaufen → EINE offene Aufgabe (keine Duplikate)
      const { data: dup } = await sb.from('crm_tasks').select('id').ilike('title', '%LinkedIn-Token%').neq('status', 'erledigt').eq('archived', false).limit(1)
      if (dup && dup.length) return json({ ok: true, valid: false, skipped: 'Aufgabe existiert schon.' })
      const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
      const adminId = (admin as { id: string } | null)?.id ?? null
      const { data: task } = await sb.from('crm_tasks').insert({
        title: '🔗 LinkedIn-Token abgelaufen — in 2 Minuten erneuern',
        description: 'Der LinkedIn-Zugang ist abgelaufen (hält ~60 Tage). So erneuerst du ihn:\n\n1. Token-Generator öffnen: https://www.linkedin.com/developers/tools/oauth (App „Happy Property" wählen → Create token)\n2. Häkchen: w_member_social + openid + profile → Request access token → mit deinem Profil bestätigen → Token kopieren\n3. Einfügen unter: https://portal.happy-property.com/admin/crm/settings/connectors (LinkedIn → ✏️ Ändern → Speichern)\n\nDanach ist der Haken wieder grün und LinkedIn-Posts laufen weiter.',
        created_by: adminId, status: 'offen',
      }).select('id').single()
      const taskId = (task as { id: string } | null)?.id
      if (taskId && adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
      return json({ ok: true, valid: false, task_id: taskId })
    }

    // ── Autopilot: Wochenplan selbst befüllen (Cron alle 20 Min) ──────────────
    // Je Lauf höchstens EIN neuer Job (Reel, Lotte oder News). Der Slot wird
    // zuerst als Entwurf mit autopilot_slot reserviert (eindeutiger Index), der
    // Inhalt entsteht im Hintergrund; erst wenn alles fertig ist, wird der Post
    // "geplant" (= freigegeben) und damit von auto_publish zur Uhrzeit gepostet.
    if (body.action === 'autopilot') {
      const force = (body as Record<string, unknown>).force === true
      const cfg = await autopilotCfg(sb)
      if (!cfg.enabled && !force) return json({ ok: true, skipped: 'Autopilot ist aus.' })
      const nowMs = Date.now()
      const stamp = () => new Date().toISOString()
      type ApRow = { id: string; autopilot_slot: string; status: string; news_source: string | null; post_results: { autopilot?: ApState } | null; updated_at: string; scheduled_for: string | null }
      const apOf = (r: ApRow): ApState => r.post_results?.autopilot ?? {}
      const setAp = (id: string, st: ApState) => sb.from('social_posts').update({ post_results: { autopilot: st }, updated_at: stamp() }).eq('id', id)

      // 1) Hängende Jobs (Worker beendet) als fehlgeschlagen werten
      const { data: openRows } = await sb.from('social_posts').select('id, autopilot_slot, status, news_source, post_results, updated_at, scheduled_for').not('autopilot_slot', 'is', null).eq('status', 'entwurf')
      let busy = false
      for (const r of (openRows ?? []) as ApRow[]) {
        const st = apOf(r)
        if (st.state !== 'pending') continue
        if (nowMs - Date.parse(r.updated_at) > 20 * 60000) await setAp(r.id, { ...st, state: 'failed', error: st.error ?? 'Zeitüberschreitung im Hintergrund-Job' })
        else busy = true
      }
      if (busy && !force) return json({ ok: true, skipped: 'Ein Autopilot-Job läuft noch.' })

      // 2) Soll-Slots + vorhandene Slots
      // slot_key (Studio: „Jetzt schon erstellen"): genau diesen Slot, auch außerhalb der Vorlaufzeit
      const slotKey = typeof (body as Record<string, unknown>).slot_key === 'string' ? String((body as Record<string, unknown>).slot_key) : ''
      const wanted = slotKey ? autopilotSlots(cfg, nowMs, 42).filter(w => w.key === slotKey) : autopilotWanted(cfg, nowMs)
      if (!wanted.length) return json({ ok: true, skipped: slotKey ? 'Diesen Termin gibt es im Plan nicht (mehr).' : 'Keine offenen Slots im Planungsfenster.' })
      const { data: haveRows } = await sb.from('social_posts').select('id, autopilot_slot, status, news_source, post_results, updated_at, scheduled_for').in('autopilot_slot', wanted.map(w => w.key))
      const have = new Map(((haveRows ?? []) as ApRow[]).map(r => [r.autopilot_slot, r]))

      // Reel-Warteschlange nur laden, wenn ein Reel-Slot offen ist
      let reels: Awaited<ReturnType<typeof reelQueue>> | null = null
      let dToken = ''
      const needsReel = wanted.some(w => w.kind === 'reel' && (!have.has(w.key) || apOf(have.get(w.key)!).state === 'failed'))
      let driveErr = ''
      if (needsReel && cfg.reels_folder) {
        try {
          dToken = await driveToken()
          reels = await reelQueue(sb, dToken, cfg.reels_folder)
        } catch (e) {
          // Drive nicht lesbar → Reels überspringen, News/Lotte/LinkedIn laufen weiter
          driveErr = e instanceof Error ? e.message : String(e)
          reels = null
          await taskForSven(sb, '🤖 Autopilot: Reels-Ordner im Drive nicht lesbar',
            `Der Autopilot kommt nicht an den Drive-Ordner mit den Reels (Happy Property Marke > Social Media > Reels). Fehler:\n${driveErr}\n\nNews-, Lotte- und LinkedIn-Posts laufen weiter, nur Reels werden nicht eingeplant. Bitte Claude Bescheid geben.`,
            'Reels-Ordner im Drive nicht lesbar')
        }
      }
      if (reels && cfg.reels_folder) {
        // Reichweite = schon eingeplante künftige Reels + noch nicht eingeplante im Ordner
        const { count: plannedReels } = await sb.from('social_posts').select('id', { count: 'exact', head: true })
          .like('autopilot_slot', '%|reel').in('status', ['entwurf', 'geplant']).gt('scheduled_for', new Date(nowMs).toISOString())
        const cover = (plannedReels ?? 0) + reels.queue.length
        if (cover < 3) {
          await taskForSven(sb, `🎞️ Reel-Warteschlange: nur noch ${cover} Reel${cover === 1 ? '' : 's'}`,
            `Der Social-Media-Autopilot postet Dienstag bis Sonntag jeden Tag ein Reel. Eingeplant bzw. im Ordner ${cover ? `sind nur noch ${cover}` : 'ist keins mehr'}.\n\nNeue fertige Reels (MP4, hochkant) einfach in den Drive-Ordner legen: https://drive.google.com/drive/folders/${cfg.reels_folder}\n(Google Drive > Happy Property Marke > Social Media > Reels)\n\nTipp: Claude schneidet dir aus jedem YouTube-Video 6 Reels, das ist genau eine Woche.`,
            'Reel-Warteschlange')
        }
      }

      // 3) Nächsten Slot wählen: fehlt ganz, oder fehlgeschlagen mit < 3 Versuchen
      let pick: ApWant | null = null
      let existing: ApRow | null = null
      for (const w of wanted) {
        const r = have.get(w.key)
        if (w.kind === 'reel' && !r && !(reels?.queue.length)) continue
        if (!r) { pick = w; break }
        const st = apOf(r)
        if (r.status !== 'entwurf' || st.state !== 'failed') continue
        if ((st.attempts ?? 0) >= 3) {
          if (!st.task) {
            const tTitle = `🤖 Autopilot: ${w.kind === 'reel' ? 'Reel' : w.kind === 'lotte' ? 'Lotte-Post' : w.kind === 'linkedin' ? 'LinkedIn-Post' : 'News-Post'} für ${WEEKDAY_DE[new Date(`${w.ymd}T12:00:00Z`).getUTCDay()]} ${w.ymd.slice(8, 10)}.${w.ymd.slice(5, 7)}. klappt nicht`
            await taskForSven(sb, tTitle,
              `Der Autopilot hat es dreimal versucht. Letzter Fehler:\n${st.error ?? 'unbekannt'}\n\nDer Entwurf liegt im Redaktionsplan (Tools > Social Media). Du kannst ihn dort fertig machen und freigeben oder löschen.`,
              tTitle)
            await setAp(r.id, { ...st, task: true })
          }
          continue
        }
        pick = w; existing = r; break
      }
      if (!pick) return json({ ok: true, skipped: 'Alles verplant.', slots: wanted.length })

      const attempts = (existing ? apOf(existing).attempts ?? 0 : 0) + 1
      const kind = pick.kind
      const TOPIC: Record<ApKind, string> = { reel: 'reel', news: 'news', lotte: 'weisheit', linkedin: 'linkedin' }
      // Reel schon beim Reservieren festlegen (news_source = drive:<id>), damit
      // zwei Slots nie dasselbe Video bekommen.
      let reelFile: DriveFile | null = null
      if (kind === 'reel') {
        const src = existing?.news_source?.startsWith('drive:') ? existing.news_source.slice(6) : ''
        if (src) {
          // Wiederholung: dasselbe Video wie beim ersten Versuch
          const r = await fetch(`https://www.googleapis.com/drive/v3/files/${src}?fields=id,name,mimeType,size,createdTime,trashed&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${dToken || (dToken = await driveToken())}` } })
          if (r.ok) reelFile = await r.json() as DriveFile
          if (!reelFile || (reelFile as DriveFile & { trashed?: boolean }).trashed) reelFile = reels?.queue[0] ?? null
        } else reelFile = reels?.queue[0] ?? null
        if (!reelFile) return json({ ok: true, skipped: 'Kein Reel verfügbar.' })
      }
      const pending: ApState = { state: 'pending', attempts }
      let postId = existing?.id ?? ''
      if (!postId) {
        const { data: ins, error: insErr } = await sb.from('social_posts').insert({
          topic: TOPIC[kind],
          title: kind === 'reel' ? `🎞️ ${reelFile!.name.replace(/\.[^.]+$/, '')}`.slice(0, 200) : kind === 'lotte' ? '🐾 Lotte · entsteht …' : kind === 'linkedin' ? '💼 LinkedIn · entsteht …' : '📰 News · entsteht …',
          platforms: kind === 'reel' ? (cfg.reel_platforms?.length ? cfg.reel_platforms : ['facebook', 'instagram']) : kind === 'linkedin' ? ['linkedin'] : ['facebook', 'instagram'],
          format: 'single', status: 'entwurf', scheduled_for: pick.when.toISOString(),
          autopilot_slot: pick.key, post_results: { autopilot: pending },
          news_source: reelFile ? `drive:${reelFile.id}` : null,
        }).select('id').single()
        if (insErr) return json({ ok: true, skipped: `Slot ${pick.key} schon reserviert (${insErr.message}).` })
        postId = (ins as { id: string }).id
      } else {
        await sb.from('social_posts').update({ post_results: { autopilot: pending }, scheduled_for: pick.when.toISOString(), ...(reelFile ? { news_source: `drive:${reelFile.id}` } : {}), updated_at: stamp() }).eq('id', postId)
      }

      const slot = pick
      const job = (async () => {
        const liKey = `${slot.ymd}|news-li`
        let liPostId = ''
        try {
          if (kind === 'reel') {
            const f = reelFile!
            const url = await driveVideoToStorage(dToken || await driveToken(), f, `social/reels/${f.id}.${/quicktime/.test(f.mimeType) ? 'mov' : 'mp4'}`)
            const txtId = reels?.texts.get(baseName(f.name))
            let caption = ''
            if (txtId) caption = (await (await driveDownload(dToken || await driveToken(), txtId)).text()).trim()
            if (!caption) caption = await reelCaption(anthropicKey, f.name.replace(/\.[^.]+$/, '').replace(/^reel\s*\d+\s*[-:]\s*/i, ''))
            caption = noDash(caption)
            await sb.from('social_posts').update({ video_url: url, content: caption, image_url: null, image_urls: [], status: 'geplant', post_results: { autopilot: { state: 'ready', attempts } }, updated_at: stamp() }).eq('id', postId)
          } else if (kind === 'lotte') {
            const { data: prev } = await sb.from('social_posts').select('content').eq('topic', 'weisheit').not('content', 'is', null).order('created_at', { ascending: false }).limit(12)
            const prevHooks = ((prev ?? []) as Array<{ content: string }>).map(x => x.content.split('\n').find(l => l.trim())?.trim() ?? '').filter(Boolean)
            const theme = LOTTE_THEMES[Math.floor(Math.random() * LOTTE_THEMES.length)]
            // Samstag + Stichwort-Automatik an: Lotte wirbt augenzwinkernd für den Report
            const lotteKw = new Date(`${slot.ymd}T12:00:00Z`).getUTCDay() === 6 ? await keywordCta(sb) : null
            const resp = await claude(anthropicKey, {
              system: `${BRAND}\n\n${LOTTE_SYSTEM}\n\nRufe GENAU EINMAL set_lotte auf.`,
              messages: [{ role: 'user', content: `Schreib Lottes nächsten Post für ${WEEKDAY_DE[new Date(`${slot.ymd}T12:00:00Z`).getUTCDay()]}.\n\n${prevHooks.length ? `SO HAT LOTTE ZULETZT ANGEFANGEN (neues Thema, anderer Witz, nichts wiederholen):\n${prevHooks.map(h => `- ${h}`).join('\n')}\n\n` : ''}THEMA HEUTE: ${theme}\n\nimage_prompt: englisch, eine WITZIGE Szene, die wie ein echtes Handyfoto von Lottes Besitzer aussieht, in der Lotte (chocolate brown labrador) etwas Menschliches tut und damit die Pointe sichtbar macht (z.B. mit Sonnenbrille auf der Poolliege, vor einem Stapel Papierkram mit genervtem Blick, mit Bauhelm auf der Baustelle). Ort meist Paphos/Zypern: Sonne, Terrasse, Pool, Meer, weiße Neubauten. Kein Text, keine Schrift, keine Schilder im Bild.${lotteKw ? `\n\n${kwLotteInstruction(lotteKw)}` : ''}` }],
              tools: [{ name: 'set_lotte', description: 'Fertiger Lotte-Post.', input_schema: { type: 'object', properties: {
                title: { type: 'string', description: 'Kurzer interner Titel (max. 60 Zeichen)' },
                caption: { type: 'string' }, image_prompt: { type: 'string' },
              }, required: ['title', 'caption', 'image_prompt'] } }],
              tool_choice: { type: 'tool', name: 'set_lotte' }, max_tokens: 2000,
            })
            const out = (((resp.content ?? []) as Array<{ type: string; input?: { title?: string; caption?: string; image_prompt?: string } }>).find(b => b.type === 'tool_use')?.input ?? {})
            if (!out.caption || !out.image_prompt) throw new Error('Lotte-Text konnte nicht erstellt werden.')
            if (lotteKw) out.caption = ensureKeywordCta(out.caption, lotteKw, `Kommentier ${lotteKw}, dann schickt dir mein Chef den Zypern-Report. Ich hab ihn schon gelesen. Also die Bilder.`)
            await sb.from('social_posts').update({ title: `🐾 ${out.title ?? 'Lotte'}`.slice(0, 200), content: noDash(out.caption), image_prompt: out.image_prompt, image_url: null, image_urls: [], updated_at: stamp() }).eq('id', postId)
            await generateLotteImage(sb, postId, out.image_prompt)
            await sb.from('social_posts').update({ status: 'geplant', post_results: { autopilot: { state: 'ready', attempts } }, updated_at: stamp() }).eq('id', postId)
          } else if (kind === 'linkedin') {
            const { data: prevLi } = await sb.from('social_posts').select('title').eq('topic', 'linkedin').order('created_at', { ascending: false }).limit(12)
            const prevTitles = ((prevLi ?? []) as Array<{ title: string | null }>).map(x => (x.title ?? '').replace(/^💼\s*/, '')).filter(t => t && !/entsteht/.test(t))
            const theme = LINKEDIN_THEMES[Math.floor(Math.random() * LINKEDIN_THEMES.length)]
            const research = await claude(anthropicKey, {
              system: `${BRAND}\n\n${LINKEDIN_SYSTEM}`,
              messages: [{ role: 'user', content: `Recherchiere eine AKTUELLE Entwicklung (letzte 14 Tage) in Deutschland oder der EU, die sich für Svens nächsten LinkedIn-Post eignet. Bevorzugtes Themenfeld heute: ${theme}. Wenn es dort nichts Aktuelles und Belastbares gibt, nimm ein anderes Feld aus dieser Liste: ${LINKEDIN_THEMES.join('; ')}.\n${prevTitles.length ? `\nDIESE THEMEN HATTE SVEN SCHON (nicht wiederholen):\n${prevTitles.map(x => `- ${x}`).join('\n')}\n` : ''}\nLiefere: das Thema, die Fakten mit Quelle (URL) und dann den fertigen Post-Text nach den Regeln.` }],
              tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
              max_tokens: 4000,
            })
            const draft = ((research.content ?? []) as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
            if (!draft) throw new Error('LinkedIn-Recherche lieferte kein Ergebnis.')
            const structured = await claude(anthropicKey, {
              system: `${BRAND}\n\n${LINKEDIN_SYSTEM}\n\nDu übernimmst den fertigen Entwurf in set_linkedin. Glätte nur Regelverstöße (Gedankenstriche, Werbung, Parteienschelte, fehlende Quelle), erfinde nichts dazu.`,
              messages: [{ role: 'user', content: `ENTWURF MIT RECHERCHE:\n\n${draft}` }],
              tools: [{ name: 'set_linkedin', description: 'Fertiger LinkedIn-Post.', input_schema: { type: 'object', properties: {
                title: { type: 'string', description: 'Kurzer interner Titel = Thema (max. 70 Zeichen)' },
                caption: { type: 'string', description: 'Der komplette Post-Text inkl. Quelle und 3 Hashtags' },
                source_url: { type: 'string' },
                image_prompt: { type: 'string', description: 'Englisch: eine ruhige, alltägliche Szene zum Thema, wie sie ein Fotograf der Lokalzeitung mit dem Handy aufnehmen würde (Ort, Blickwinkel, Tageszeit, echte Details). Keine Personen im Vordergrund, kein Text, keine Schilder, keine Flaggen, keine Wörter wie photorealistic/cinematic.' },
              }, required: ['title', 'caption', 'image_prompt'] } }],
              tool_choice: { type: 'tool', name: 'set_linkedin' }, max_tokens: 3000,
            })
            const out = (((structured.content ?? []) as Array<{ type: string; input?: { title?: string; caption?: string; source_url?: string; image_prompt?: string } }>).find(b => b.type === 'tool_use')?.input ?? {})
            if (!out.caption || !out.image_prompt) throw new Error('LinkedIn-Text konnte nicht erstellt werden.')
            if (!out.source_url && !/Quelle:\s*https?:\/\//.test(out.caption)) throw new Error('LinkedIn-Text ohne Quelle, wird neu erstellt.')
            await sb.from('social_posts').update({ title: `💼 ${out.title ?? 'LinkedIn'}`.slice(0, 200), content: noDash(out.caption), news_source: out.source_url || null, image_url: null, image_urls: [], updated_at: stamp() }).eq('id', postId)
            await generatePostImage(sb, postId, out.image_prompt)
            await sb.from('social_posts').update({ status: 'geplant', post_results: { autopilot: { state: 'ready', attempts } }, updated_at: stamp() }).eq('id', postId)
          } else {
            // News: frische, unbenutzte Idee (max. 4 Tage alt), sonst neu recherchieren
            const { data: recent } = await sb.from('social_posts').select('title').eq('topic', 'news').order('created_at', { ascending: false }).limit(25)
            const avoid = ((recent ?? []) as Array<{ title: string | null }>).map(x => (x.title ?? '').replace(/^📰\s*(in · )?/, '')).filter(t => t && !/entsteht/.test(t))
            const { data: ideaRows } = await sb.from('social_ideas').select('id, headline, core, source_url, angle').eq('status', 'neu').gte('created_at', new Date(nowMs - 4 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(10)
            let ideas = (ideaRows ?? []) as Array<{ id: string; headline: string; core: string; source_url: string | null; angle: string }>
            ideas = ideas.filter(i => !avoid.some(a => a.toLowerCase() === i.headline.toLowerCase()))
            if (!ideas.length) ideas = await newsScan(sb, anthropicKey, avoid)
            const idea = ideas[0]
            if (!idea) throw new Error('Keine aktuelle News gefunden.')
            if (slot.liWhen) {
              const { data: liRow } = await sb.from('social_posts').select('id').eq('autopilot_slot', liKey).maybeSingle()
              liPostId = (liRow as { id: string } | null)?.id ?? ''
              if (!liPostId) {
                const { data: li, error: liErr } = await sb.from('social_posts').insert({
                  topic: 'news', title: `📰 in · ${idea.headline}`.slice(0, 200), platforms: ['linkedin'], format: 'single', status: 'entwurf',
                  scheduled_for: slot.liWhen.toISOString(), autopilot_slot: liKey, post_results: { autopilot: pending }, news_source: idea.source_url,
                }).select('id').single()
                if (liErr) throw new Error(`LinkedIn-Entwurf: ${liErr.message}`)
                liPostId = (li as { id: string }).id
              } else {
                await sb.from('social_posts').update({ title: `📰 in · ${idea.headline}`.slice(0, 200), content: null, image_url: null, image_urls: [], news_source: idea.source_url, updated_at: stamp() }).eq('id', liPostId)
              }
            }
            await sb.from('social_posts').update({ title: `📰 ${idea.headline}`.slice(0, 200), news_source: idea.source_url, content: null, image_url: null, image_urls: [], updated_at: stamp() }).eq('id', postId)
            await sb.from('social_ideas').update({ status: 'verwendet', used_post_ids: [postId, liPostId].filter(Boolean) }).eq('id', idea.id)
            // Di, Fr, So: Stichwort-Aufforderung statt allgemeiner Handlungsaufforderung (nur wenn die Automatik an ist)
            const newsKw = KW_NEWS_DOWS.includes(new Date(`${slot.ymd}T12:00:00Z`).getUTCDay()) ? await keywordCta(sb) : null
            if (slot.format === 'carousel') await buildNewsCarousel(sb, anthropicKey, idea, postId, newsKw)
            else await ideaContent(sb, anthropicKey, idea, { metaPostId: postId, liPostId, wantNewsletter: false, imgCount: 1, ctaKeyword: newsKw })
            const { data: chk } = await sb.from('social_posts').select('image_url').eq('id', postId).maybeSingle()
            if (!(chk as { image_url?: string | null } | null)?.image_url) throw new Error('Bild konnte nicht erzeugt werden.')
            const ready = { status: 'geplant', post_results: { autopilot: { state: 'ready', attempts } }, updated_at: stamp() }
            await sb.from('social_posts').update(ready).eq('id', postId)
            if (liPostId) await sb.from('social_posts').update(ready).eq('id', liPostId)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error(`[social-agent] Autopilot ${slot.key}:`, msg)
          await setAp(postId, { state: 'failed', attempts, error: msg.slice(0, 500) })
          if (liPostId) await setAp(liPostId, { state: 'failed', attempts, error: msg.slice(0, 500) })
        }
      })()
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job); else await job
      return json({ ok: true, started: pick.key, kind, attempt: attempts, post_id: postId, reel: reelFile?.name ?? null })
    }

    // ── Autopilot-Status fürs Studio: Wochenplan, Reel-Warteschlange, Lotte-Fotos ──
    if (body.action === 'autopilot_status') {
      const cfg = await autopilotCfg(sb)
      let queue: string[] = [], total = 0, lotte = 0, until: string | null = null, err = ''
      try {
        const token = await driveToken()
        if (cfg.reels_folder) {
          const q = await reelQueue(sb, token, cfg.reels_folder)
          queue = q.queue.map(f => f.name.replace(/\.[^.]+$/, '')); total = q.total
          // Bis wann reicht die Warteschlange? Reel-Slots ab morgen abzählen, die
          // noch keinen Post haben.
          const { data: planned } = await sb.from('social_posts').select('autopilot_slot').like('autopilot_slot', '%|reel')
          const plannedSet = new Set(((planned ?? []) as Array<{ autopilot_slot: string }>).map(r => r.autopilot_slot))
          let left = queue.length
          const d = new Date(`${cyYmd(new Date())}T12:00:00Z`)
          const reelSlots = (cfg.slots ?? []).filter(s => s.kind === 'reel')
          let lastCovered: string | null = null
          for (let i = 0; i < 120 && reelSlots.length; i++) {
            const ymd = d.toISOString().slice(0, 10)
            const rs = reelSlots.find(s => s.dow === d.getUTCDay())
            if (rs && cyAt(ymd, rs.time).getTime() > Date.now()) {
              if (plannedSet.has(`${ymd}|reel`)) lastCovered = ymd
              else if (left > 0) { left--; lastCovered = ymd }
              else if (i > 0) break
            }
            d.setUTCDate(d.getUTCDate() + 1)
          }
          until = lastCovered
        }
        if (cfg.lotte_folder) lotte = (await driveChildren(token, cfg.lotte_folder)).filter(f => f.mimeType.startsWith('image/')).length
      } catch (e) { err = e instanceof Error ? e.message : String(e) }
      // Kommende Plan-Slots für den Kalender (auch noch nicht erzeugte), Zypern-Zeit → UTC.
      // Montag 18:30 = YouTube-Wochenpost (macht Leonard, Post entsteht automatisch).
      const nowMs2 = Date.now()
      const upcoming = autopilotSlots(cfg, nowMs2, 42).map(w => ({ key: w.key, kind: w.kind as string, when: w.when.toISOString(), ymd: w.ymd, lead_h: AP_LEAD_H[w.kind] }))
      for (let i = 0; i <= 42; i++) {
        const d = new Date(`${cyYmd(new Date(nowMs2))}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i)
        if (d.getUTCDay() !== 1) continue
        const ymd = d.toISOString().slice(0, 10)
        const when = cyAt(ymd, '18:30')
        if (when.getTime() > nowMs2) upcoming.push({ key: `${ymd}|youtube`, kind: 'youtube', when: when.toISOString(), ymd, lead_h: 36 })
      }
      upcoming.sort((a, b) => a.when.localeCompare(b.when))
      return json({ ok: true, enabled: cfg.enabled === true, slots: cfg.slots ?? [], li_slots: cfg.li_slots ?? [], upcoming, folders: { reels: cfg.reels_folder ?? null, lotte: cfg.lotte_folder ?? null, social: cfg.social_folder ?? null }, reels: { queued: queue.length, total, next: queue.slice(0, 5), until }, lotte_photos: lotte, error: err || null })
    }

    // ── Auto-Tagespost: EIN fälliger geplanter Post pro Tag (FB/Insta-Queue) ──
    if (body.action === 'auto_publish') {
      // Halbstündlicher Cron: postet zur GEPLANTEN Uhrzeit (fällig = Zeit erreicht).
      // Frequenz-Wächter je Kanal und ZYPERN-Tag: FB/Insta max. 3 (Autopilot braucht 2:
      // Bildpost 12:30 + Reel 18:30), LinkedIn max. 1, YouTube max. 1.
      const nowMs = Date.now()
      const nowIso = new Date(nowMs).toISOString()
      const dayStartIso = cyAt(cyYmd(new Date(nowMs)), '00:00').toISOString()
      const apCfg = await autopilotCfg(sb)
      const { data: due } = await sb.from('social_posts').select('id, platforms, content, scheduled_for, post_results, autopilot_slot')
        .eq('status', 'geplant').lte('scheduled_for', nowIso)
        .order('scheduled_for', { ascending: true }).limit(100)
      type DueRow = { id: string; platforms: string[]; content: string | null; scheduled_for: string; post_results: Record<string, { pending?: boolean }> | null; autopilot_slot: string | null }
      const isPending = (p: DueRow) => Object.values(p.post_results ?? {}).some(r => r && typeof r === 'object' && r.pending)
      const dueAll = (due as DueRow[] | null) ?? []
      // Autopilot-Posts, die mehr als 3 h überfällig sind (z. B. nach einer Pause),
      // NICHT nachholen, sondern verwerfen: sonst kommt nach dem Wiedereinschalten
      // eine Welle alter Posts. Angefangene Reels (Instagram verarbeitet) ausgenommen.
      for (const p of dueAll) {
        if (!p.autopilot_slot || isPending(p)) continue
        if (nowMs - Date.parse(p.scheduled_for) > 3 * 3600000) {
          // Reel-Video wieder freigeben (news_source leeren) → kommt an einem späteren Tag
          await sb.from('social_posts').update({ status: 'verworfen', ...(p.autopilot_slot.endsWith('|reel') ? { news_source: null } : {}), post_results: { ...(p.post_results ?? {}), skipped: { ok: false, error: 'Zu spät, nicht nachgeholt (Autopilot war pausiert oder das Tageslimit war erreicht).' } }, updated_at: nowIso }).eq('id', p.id)
        }
      }
      // Nur Posts mit Text und ohne Fehlerhinweis. Autopilot pausiert (oder Plan nicht
      // lesbar) → dessen Posts bleiben liegen.
      const dueList = dueAll.filter(p => {
        if (p.autopilot_slot && apCfg.enabled !== true) return false
        if (p.autopilot_slot && !isPending(p) && nowMs - Date.parse(p.scheduled_for) > 3 * 3600000) return false
        const c = (p.content ?? '').trim()
        return !!c && !c.startsWith('⚠️')
      })
      if (!dueList.length) return json({ ok: true, skipped: 'Kein fälliger freigegebener Post.' })
      // Angefangene Reels (Instagram hat noch verarbeitet) zuerst zu Ende bringen
      const resume = dueList.find(isPending)
      if (resume) {
        body.post_id = resume.id
      } else {
        const { data: doneToday } = await sb.from('social_posts').select('platforms').gte('posted_at', dayStartIso)
        const posted = (doneToday as { platforms: string[] }[] | null) ?? []
        const cnt = (f: (pl: string[]) => boolean) => posted.filter(p => f(p.platforms ?? [])).length
        const isMeta = (pl: string[]) => pl.some(x => x === 'facebook' || x === 'instagram')
        const metaFull = cnt(isMeta) >= 3
        const liFull = cnt(pl => pl.includes('linkedin')) >= 1
        const ytFull = cnt(pl => pl.includes('youtube')) >= 1
        const next = dueList.find(p => {
          const pl = p.platforms ?? []
          return !(isMeta(pl) && metaFull) && !(pl.includes('linkedin') && liFull) && !(pl.includes('youtube') && ytFull)
        })
        if (!next) return json({ ok: true, skipped: 'Tageslimit erreicht (FB/Insta 3, LinkedIn 1, YouTube 1 pro Tag).' })
        body.post_id = next.id
      }
      body.action = 'publish'   // unten normal veröffentlichen
    }

    // ── Veröffentlichen ───────────────────────────────────────────────────────
    if (body.action === 'publish') {
      if (!body.post_id) return json({ error: 'post_id fehlt' }, 400)
      const { data: post } = await sb.from('social_posts').select('*').eq('id', body.post_id).maybeSingle()
      const p0 = post as { content: string | null; image_url: string | null; image_urls: string[] | null; format: string | null; platforms: string[]; status: string } | null
      // Bilderliste: image_urls (Mehrfach) mit image_url als Fallback; Karussell nur mit >= 2.
      const imgs = (Array.isArray(p0?.image_urls) ? p0!.image_urls! : []).filter(Boolean)
      if (p0 && !imgs.length && p0.image_url) imgs.push(p0.image_url)
      const isCarousel = (p0?.format === 'carousel') && imgs.length >= 2
      const videoUrl = ((p0 as { video_url?: string | null } | null)?.video_url ?? '').trim()
      const p = p0 ? { ...p0, image_url: imgs[0] ?? p0.image_url } : null
      if (!p?.content?.trim()) return json({ error: 'Der Post hat noch keinen Text.' }, 400)
      // META-Token: zuerst die im CRM gepflegte Ablage (Einstellungen → Connectoren)
      const { data: mtRow } = await sb.from('connector_secrets').select('value').eq('key', 'META_ACCESS_TOKEN').maybeSingle()
      const metaToken = (mtRow as { value: string } | null)?.value ?? Deno.env.get('META_ACCESS_TOKEN') ?? ''
      // LinkedIn-Token: zuerst die im CRM gepflegte Ablage (Einstellungen →
      // Connectoren), sonst Env-Secret.
      const { data: liRow } = await sb.from('connector_secrets').select('value').eq('key', 'LINKEDIN_ACCESS_TOKEN').maybeSingle()
      const liToken = (liRow as { value: string } | null)?.value ?? Deno.env.get('LINKEDIN_ACCESS_TOKEN') ?? ''
      const results: Record<string, { ok: boolean; id?: string; error?: string; url?: string; pending?: boolean; container?: string; tries?: number }> = {}
      // Wiederaufnahme (Reel): was schon geklappt hat, NICHT doppelt posten;
      // ein Instagram-Container in Verarbeitung wird weiterverfolgt.
      const prevRes = ((post as { post_results?: Record<string, { ok?: boolean; id?: string; url?: string; pending?: boolean; container?: string; tries?: number }> | null } | null)?.post_results ?? {})
      for (const pf of p.platforms ?? []) { const r = prevRes[pf]; if (r && r.ok === true) results[pf] = { ok: true, id: r.id, url: r.url } }
      const igPrev = prevRes.instagram && prevRes.instagram.pending ? prevRes.instagram : null

      // Facebook-Seite + IG-Account einmal ermitteln
      let pageId = '', pageToken = '', igId = ''
      if (p.platforms.some(x => x === 'facebook' || x === 'instagram')) {
        try {
          const acc = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${metaToken}`).then(r => r.json())
          const page = (acc?.data ?? [])[0]
          if (!page) throw new Error(acc?.error?.message ?? 'Keine Facebook-Seite über den Meta-Token erreichbar (Berechtigung pages_manage_posts fehlt?)')
          pageId = page.id; pageToken = page.access_token
          igId = page.instagram_business_account?.id ?? ''
        } catch (e) {
          const msg = (e as Error).message
          if (p.platforms.includes('facebook') && !results.facebook) results.facebook = { ok: false, error: msg }
          if (p.platforms.includes('instagram') && !results.instagram) results.instagram = { ok: false, error: msg }
        }
      }
      // Facebook: Karussell (mehrere Fotos), Einzelfoto oder Text-Post
      if (p.platforms.includes('facebook') && pageId && !results.facebook) {
        // Facebook-Text ohne Kommentar-Köder und mit max. 5 Hashtags (Instagram behält das Original)
        const fbText = fbCaption(p.content)
        try {
          if (videoUrl) {
            // Video/Reel: Facebook nimmt eine öffentliche Datei-URL direkt an
            const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}/videos`, { method: 'POST', body: new URLSearchParams({ file_url: videoUrl, description: fbText, access_token: pageToken }) }).then(x => x.json())
            if (r.error) throw new Error(r.error.message)
            results.facebook = { ok: true, id: r.id }
          } else if (isCarousel) {
            // Fotos unveröffentlicht hochladen → als attached_media an einen Feed-Post hängen
            const mediaIds: string[] = []
            for (const u of imgs.slice(0, 10)) {
              const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, { method: 'POST', body: new URLSearchParams({ url: u, published: 'false', access_token: pageToken }) }).then(x => x.json())
              if (r.error) throw new Error(r.error.message)
              mediaIds.push(r.id)
            }
            const params = new URLSearchParams({ message: fbText, access_token: pageToken })
            mediaIds.forEach((id, i) => params.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })))
            const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, { method: 'POST', body: params }).then(x => x.json())
            if (r.error) throw new Error(r.error.message)
            results.facebook = { ok: true, id: r.id }
          } else {
            const url = p.image_url ? `https://graph.facebook.com/v21.0/${pageId}/photos` : `https://graph.facebook.com/v21.0/${pageId}/feed`
            const params = new URLSearchParams(p.image_url
              ? { url: p.image_url, caption: fbText, access_token: pageToken }
              : { message: fbText, access_token: pageToken })
            const r = await fetch(url, { method: 'POST', body: params }).then(x => x.json())
            if (r.error) throw new Error(r.error.message)
            results.facebook = { ok: true, id: r.post_id ?? r.id }
          }
        } catch (e) { results.facebook = { ok: false, error: (e as Error).message } }
      }
      // Instagram: Einzelbild oder Karussell (Kind-Container → CAROUSEL → publish)
      if (p.platforms.includes('instagram') && !results.instagram) {
        try {
          if (!igId) throw new Error('Kein Instagram-Business-Konto mit der Seite verknüpft.')
          if (videoUrl) {
            // Instagram-REEL: Container anlegen → Verarbeitung abwarten → publish.
            // Dauert die Verarbeitung länger, merken wir uns den Container und
            // auto_publish macht in 30 Min weiter (kein zweiter Facebook-Post).
            let cid = igPrev?.container ?? ''
            if (!cid) {
              const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption: p.content, share_to_feed: 'true', access_token: pageToken }) }).then(x => x.json())
              if (c.error) throw new Error(c.error.message)
              cid = c.id
            }
            let stat = ''
            for (let i = 0; i < 12; i++) {
              await new Promise(res => setTimeout(res, 10000))
              const st = await fetch(`https://graph.facebook.com/v21.0/${cid}?fields=status_code&access_token=${pageToken}`).then(x => x.json()).catch(() => ({}))
              stat = (st as { status_code?: string }).status_code ?? ''
              if (stat === 'FINISHED' || stat === 'ERROR' || stat === 'EXPIRED') break
            }
            if (stat === 'ERROR' || stat === 'EXPIRED') throw new Error('Instagram konnte das Video nicht verarbeiten (Format/Länge prüfen: MP4, 9:16, max. 15 Min).')
            if (stat !== 'FINISHED') {
              const tries = (igPrev?.tries ?? 0) + 1
              if (tries >= 8) throw new Error('Instagram verarbeitet das Reel seit über 3 Stunden nicht. Bitte manuell posten.')
              results.instagram = { ok: false, pending: true, container: cid, tries, error: 'Instagram verarbeitet das Reel noch, nächster Versuch automatisch in 30 Min.' }
              throw { __done: true }
            }
            const c = { id: cid }
            const pubV = await fetch(`https://graph.facebook.com/v21.0/${igId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: c.id, access_token: pageToken }) }).then(x => x.json())
            if (pubV.error) throw new Error(pubV.error.message)
            results.instagram = { ok: true, id: pubV.id }
            throw { __done: true }
          }
          if (!p.image_url) throw new Error('Instagram braucht mindestens ein Bild.')
          let creationId: string
          if (isCarousel) {
            const children: string[] = []
            for (const u of imgs.slice(0, 10)) {
              const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ image_url: u, is_carousel_item: 'true', access_token: pageToken }) }).then(x => x.json())
              if (c.error) throw new Error(c.error.message)
              children.push(c.id)
            }
            for (const cid of children) {                       // Kind-Container müssen fertig sein
              for (let i = 0; i < 8; i++) {
                const st = await fetch(`https://graph.facebook.com/v21.0/${cid}?fields=status_code&access_token=${pageToken}`).then(x => x.json()).catch(() => ({})) as { status_code?: string }
                if (st.status_code === 'FINISHED' || st.status_code === 'ERROR') break
                await new Promise(res => setTimeout(res, 2000))
              }
            }
            const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ media_type: 'CAROUSEL', children: children.join(','), caption: p.content, access_token: pageToken }) }).then(x => x.json())
            if (c.error) throw new Error(c.error.message)
            creationId = c.id
          } else {
            const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ image_url: p.image_url, caption: p.content, access_token: pageToken }) }).then(x => x.json())
            if (c.error) throw new Error(c.error.message)
            creationId = c.id
          }
          // Instagram braucht einen Moment, bis der Container fertig ist. Ohne Warten
          // scheiterten 4 von 10 Bild-Posts mit „Media ID is not available" (Analyse
          // 26.9.2026): erst status_code FINISHED abwarten, dann veröffentlichen.
          for (let i = 0; i < 12; i++) {
            const st = await fetch(`https://graph.facebook.com/v21.0/${creationId}?fields=status_code&access_token=${pageToken}`).then(x => x.json()).catch(() => ({})) as { status_code?: string }
            if (st.status_code === 'FINISHED') break
            if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('Instagram konnte das Bild nicht verarbeiten.')
            await new Promise(res => setTimeout(res, 3000))
          }
          let pub: { id?: string; error?: { message?: string } } = {}
          for (let i = 0; i < 3; i++) {
            pub = await fetch(`https://graph.facebook.com/v21.0/${igId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: creationId, access_token: pageToken }) }).then(x => x.json())
            if (!pub.error || !/not available|not ready|2207027/i.test(JSON.stringify(pub.error))) break
            await new Promise(res => setTimeout(res, 5000))
          }
          if (pub.error) throw new Error(pub.error.message)
          results.instagram = { ok: true, id: pub.id }
        } catch (e) { if (!(e as { __done?: boolean }).__done) results.instagram = { ok: false, error: (e as Error).message } }
      }
      // LinkedIn (optional — Token muss Sven einmalig hinterlegen)
      // ── YouTube: Video-Upload über die Data API (Svens Kanal) ────────────────
      if (p.platforms.includes('youtube') && !results.youtube) {
        const cs = async (k: string) => ((await sb.from('connector_secrets').select('value').eq('key', k).maybeSingle()).data as { value?: string } | null)?.value ?? Deno.env.get(k) ?? ''
        const [cid, csec, rtok] = [await cs('YOUTUBE_CLIENT_ID'), await cs('YOUTUBE_CLIENT_SECRET'), await cs('YOUTUBE_REFRESH_TOKEN')]
        if (!videoUrl) {
          results.youtube = { ok: false, error: 'YouTube braucht ein Video — bitte im Post ein Video hochladen.' }
        } else if (!cid || !csec || !rtok) {
          results.youtube = { ok: false, error: 'YouTube ist noch nicht verbunden (YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN in Einstellungen → Connectoren hinterlegen).' }
        } else {
          try {
            const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }) })
            const td = await tr.json() as { access_token?: string; error_description?: string }
            if (!td.access_token) throw new Error(`OAuth: ${td.error_description ?? tr.status}`)
            const head = await fetch(videoUrl, { method: 'HEAD' })
            const size = Number(head.headers.get('content-length') ?? 0)
            if (!size || size > 80 * 1048576) throw new Error(`Video zu groß für den Auto-Upload (${Math.round(size / 1048576)} MB, max. 80 MB)`) 
            const vres = await fetch(videoUrl)
            const bytes = new Uint8Array(await vres.arrayBuffer())
            const title = (p.title ?? '').replace(/^[^A-Za-z0-9ÄÖÜäöü]*/, '').slice(0, 95) || 'Happy Property'
            const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
              method: 'POST', headers: { Authorization: `Bearer ${td.access_token}`, 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes.length), 'X-Upload-Content-Type': 'video/mp4' },
              body: JSON.stringify({ snippet: { title, description: (p.content ?? '').slice(0, 4800), categoryId: '26' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }),
            })
            const loc = init.headers.get('location')
            if (!init.ok || !loc) throw new Error(`Upload-Init ${init.status}: ${(await init.text()).slice(0, 200)}`)
            const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'video/mp4' }, body: bytes })
            const ud = await up.json() as { id?: string; error?: { message?: string } }
            if (!up.ok || !ud.id) throw new Error(ud.error?.message ?? `Upload ${up.status}`)
            results.youtube = { ok: true, id: ud.id, url: `https://youtu.be/${ud.id}` }
          } catch (e) { results.youtube = { ok: false, error: (e as Error).message } }
        }
      }

      if (p.platforms.includes('linkedin') && !results.linkedin) {
        if (videoUrl) {
          results.linkedin = { ok: false, error: 'Video/Reel auf LinkedIn noch nicht angebunden — bitte dort manuell posten.' }
        } else if (!liToken) {
          results.linkedin = { ok: false, error: 'LINKEDIN_ACCESS_TOKEN fehlt — LinkedIn ist noch nicht verbunden.' }
        } else {
          try {
            const me = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${liToken}` } }).then(x => x.json())
            const author = `urn:li:person:${me.sub}`
            // Bild mitgeben: Asset registrieren → Binärdaten hochladen → im Post referenzieren
            let liMedia: { status: string; media: string } | null = null
            if (p.image_url) {
              try {
                const reg = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
                  method: 'POST', headers: { Authorization: `Bearer ${liToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
                  body: JSON.stringify({ registerUploadRequest: { recipes: ['urn:li:digitalmediaRecipe:feedshare-image'], owner: author, serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }] } }),
                }).then(x => x.json())
                const upUrl = reg?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl
                const asset = reg?.value?.asset
                if (upUrl && asset) {
                  const imgBytes = await (await fetch(p.image_url)).arrayBuffer()
                  const pu = await fetch(upUrl, { method: 'PUT', headers: { Authorization: `Bearer ${liToken}` }, body: imgBytes })
                  if (pu.ok) liMedia = { status: 'READY', media: asset }
                }
              } catch (e) { console.warn('[social-agent] LinkedIn-Bild:', e) }
            }
            const r = await fetch('https://api.linkedin.com/v2/ugcPosts', {
              method: 'POST',
              headers: { Authorization: `Bearer ${liToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
              body: JSON.stringify({
                author, lifecycleState: 'PUBLISHED',
                specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: p.content }, shareMediaCategory: liMedia ? 'IMAGE' : 'NONE', ...(liMedia ? { media: [liMedia] } : {}) } },
                visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
              }),
            })
            if (!r.ok) throw new Error((await r.text()).slice(0, 200))
            results.linkedin = { ok: true }
          } catch (e) { results.linkedin = { ok: false, error: (e as Error).message } }
        }
      }
      const anyOk = Object.values(results).some(r => r.ok)
      const anyPending = Object.values(results).some(r => r.pending)
      const prevPostedAt = (post as { posted_at?: string | null } | null)?.posted_at ?? null
      await sb.from('social_posts').update({
        // Instagram verarbeitet noch → bleibt "geplant", auto_publish macht weiter
        status: anyPending ? 'geplant' : anyOk ? 'gepostet' : 'fehlgeschlagen',
        posted_at: anyOk ? (prevPostedAt ?? new Date().toISOString()) : null,
        post_results: results, updated_at: new Date().toISOString(),
      }).eq('id', body.post_id)
      return json({ ok: anyOk, results })
    }

    return json({ error: 'Unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[social-agent]', msg)
    return json({ error: msg }, 500)
  }
})
