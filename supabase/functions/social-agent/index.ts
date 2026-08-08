// social-agent — Motor des Social-Media-Tools (Facebook/Instagram/LinkedIn, organisch).
//
// Aktionen:
//   chat        { post_id, message }   → hochwertiger Post-Chat (Claude, volles Firmen-
//               wissen). Der Agent ANTWORTET und kann den Post-Text direkt setzen
//               (Tool set_post) — das Textfeld im Studio aktualisiert sich live.
//   image       { post_id, prompt? }   → Bild via OpenAI (gpt-image-1) → Bucket
//               ad-creatives/social/… (public) → social_posts.image_url.
//   news_scan   {}                     → Websuche nach aktuellen Immobilien-News
//               (Zypern + Deutschland) → Aufgabe für Sven (Startseite) mit den
//               Fundstücken + Post-Winkeln. Läuft auch per Cron (Mo+Do).
//   publish     { post_id }            → auf die gewählten Plattformen posten.
//               Facebook/Instagram über META_ACCESS_TOKEN (Seiten-Token via
//               /me/accounts), LinkedIn über LINKEDIN_ACCESS_TOKEN (optional —
//               fehlt der, wird es sauber gemeldet, der Rest läuft weiter).
//
// Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, META_ACCESS_TOKEN,
//          LINKEDIN_ACCESS_TOKEN? (optional), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy social-agent --no-verify-jwt
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts'

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

// Bestehendes Bild per KI BEARBEITEN (z.B. spielende Kinder ergänzen): Quelle laden
// → OpenAI images/edits (gpt-image-1) → Ergebnis hochladen + an image_urls anhängen.
async function editPostImage(sb: SupabaseClient, postId: string, sourceUrl: string, prompt: string): Promise<string> {
  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!openaiKey) throw new Error('OPENAI_API_KEY fehlt.')
  const src = await fetch(sourceUrl)
  if (!src.ok) throw new Error('Quellbild nicht ladbar.')
  const blob = await src.blob()
  const fd = new FormData()
  fd.append('model', 'gpt-image-1')
  fd.append('image', new File([blob], 'source.png', { type: blob.type || 'image/png' }))
  fd.append('prompt', prompt)
  fd.append('size', '1024x1024')
  const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${openaiKey}` }, body: fd })
  const d = await res.json()
  if (!res.ok) throw new Error(`OpenAI edit: ${JSON.stringify(d?.error ?? d).slice(0, 200)}`)
  const b64 = d?.data?.[0]?.b64_json as string | undefined
  if (!b64) throw new Error('OpenAI lieferte kein Bild.')
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const path = `social/${postId}-edit-${Date.now()}.png`
  const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
  if (upErr) throw new Error(`Upload: ${upErr.message}`)
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
  const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
  const list = Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls) ? (cur as { image_urls: string[] }).image_urls : []
  await sb.from('social_posts').update({ image_urls: [...list, url], image_url: list[0] ?? url, updated_at: new Date().toISOString() }).eq('id', postId)
  return url
}

// Bild via OpenAI erzeugen, in ad-creatives/social hochladen, an image_urls anhängen.
// Wird von der image-Aktion UND vom Chat-Tool make_image genutzt.
async function generatePostImage(sb: SupabaseClient, postId: string, prompt: string): Promise<string> {
  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!openaiKey) throw new Error('OPENAI_API_KEY fehlt in den Secrets.')
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      // Foto-Stil hart erzwingen — sonst driftet gpt-image-1 gern in Illustration/Comic.
      prompt: `Professional photograph: ${prompt}. Shot on a full-frame camera, 35mm lens, natural lighting, realistic textures and materials, subtle depth of field, true-to-life colors. Strictly photorealistic — NO cartoon, NO illustration, NO 3D render, NO painting, no text, no watermark.`,
      size: '1024x1024', quality: 'high', n: 1,
    }),
  })
  const d = await res.json()
  if (!res.ok) throw new Error(`OpenAI: ${JSON.stringify(d?.error ?? d).slice(0, 200)}`)
  const b64 = d?.data?.[0]?.b64_json as string | undefined
  if (!b64) throw new Error('OpenAI lieferte kein Bild.')
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const path = `social/${postId}-${Date.now()}.png`
  const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
  if (upErr) throw new Error(`Upload: ${upErr.message}`)
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
  const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
  const list = Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls) ? (cur as { image_urls: string[] }).image_urls : []
  await sb.from('social_posts').update({ image_urls: [...list, url], image_url: list[0] ?? url, image_prompt: prompt, updated_at: new Date().toISOString() }).eq('id', postId)
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
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${pb64url(new Uint8Array(sig))}` }) })
  const d = await r.json() as { access_token?: string }
  if (!d.access_token) throw new Error('Drive-SA-Token fehlgeschlagen')
  return d.access_token
}
interface PersonaCfg { lotte_folder?: string; lotte_fallback_folder?: string; sven_folder?: string; sven_min_bytes?: number }
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
// Persona-Bild: echte Referenzfotos (Lotte/Sven) + Szene → OpenAI images/edits.
// Ohne verfügbare Referenzen fällt es sauber auf die normale Generierung zurück.
async function generatePersonaImage(sb: SupabaseClient, postId: string, prompt: string, include: string[]): Promise<string> {
  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!openaiKey) throw new Error('OPENAI_API_KEY fehlt in den Secrets.')
  const cfg = await personaCfg(sb)
  const token = await driveToken()
  // Referenzen einsammeln, mit Persona-Label — Bild-Nummern vermeiden wir im
  // Prompt bewusst: einzelne Dateien können unten wieder rausfliegen.
  const files: Array<{ file: File; who: 'lotte' | 'sven' }> = []
  if (include.includes('lotte') && cfg.lotte_folder) {
    let refs = await driveImages(token, cfg.lotte_folder, 0, 3)
    if (!refs.length && cfg.lotte_fallback_folder) refs = await driveImages(token, cfg.lotte_fallback_folder, 0, 3)
    for (const f of refs) { const b = await driveDownload(token, f.id); files.push({ file: new File([b], f.name || 'lotte.jpg', { type: b.type || 'image/jpeg' }), who: 'lotte' }) }
  }
  if (include.includes('sven') && cfg.sven_folder) {
    const refs = await driveImages(token, cfg.sven_folder, cfg.sven_min_bytes ?? 500000, 2)
    for (const f of refs) { const b = await driveDownload(token, f.id); files.push({ file: new File([b], f.name || 'sven.jpg', { type: b.type || 'image/jpeg' }), who: 'sven' }) }
  }
  if (!files.length) return await generatePostImage(sb, postId, prompt)
  // OpenAI images/edits — lehnt OpenAI eine einzelne Referenz ab („Invalid image
  // file or mode for image N", z.B. iPhone-JPEGs), fliegt genau die raus und wir
  // versuchen es erneut, solange Referenzen übrig sind.
  let b64: string | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts: string[] = []
    if (files.some(f => f.who === 'lotte')) parts.push("The attached DOG photos show Lotte, a real dog (Sven's dog and office boss at Happy Property). Lotte must match these reference photos EXACTLY — same breed, same coat color, same face.")
    if (files.some(f => f.who === 'sven')) parts.push('The attached photos of a MAN show Sven Rüprich (real person, founder of Happy Property). Sven must match these reference photos EXACTLY — same face, same build.')
    const fd = new FormData()
    fd.append('model', 'gpt-image-1'); fd.append('size', '1024x1024'); fd.append('quality', 'medium'); fd.append('n', '1')
    for (const f of files) fd.append('image[]', f.file)
    fd.append('prompt', `${parts.join(' ')} Create a NEW photorealistic image: ${prompt}. Keep the likeness of the referenced dog/person absolutely true to the reference photos. Natural light, no text, no watermarks.`)
    const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${openaiKey}` }, body: fd })
    const d = await res.json()
    if (res.ok) { b64 = d?.data?.[0]?.b64_json as string | undefined; break }
    const msg = JSON.stringify(d?.error ?? d)
    const m = msg.match(/image (\d+)/i)
    if (m && files.length > 1) {
      const bad = Math.min(files.length - 1, parseInt(m[1], 10) - 1)
      console.warn(`[social-agent] Referenz ${files[bad].file.name} von OpenAI abgelehnt — fliegt raus, neuer Versuch.`)
      files.splice(bad, 1); continue
    }
    throw new Error(`OpenAI: ${msg.slice(0, 200)}`)
  }
  if (!b64) throw new Error('OpenAI lieferte kein Bild.')
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const path = `social/${postId}-persona-${Date.now()}.png`
  const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
  if (upErr) throw new Error(`Upload: ${upErr.message}`)
  const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
  const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', postId).maybeSingle()
  const list = Array.isArray((cur as { image_urls?: string[] } | null)?.image_urls) ? (cur as { image_urls: string[] }).image_urls : []
  await sb.from('social_posts').update({ image_urls: [...list, url], image_url: list[0] ?? url, image_prompt: prompt, updated_at: new Date().toISOString() }).eq('id', postId)
  return url
}

// 16:9-Thumbnail → 1080×1350-Insta-Rahmen: Bild ungeschnitten mittig, Hintergrund
// = stark abgedunkelter Durchschnittsfarbton des Bilds. Fällt bei Fehlern sauber
// auf das Original zurück.
// 16:9-Thumbnail → 1080×1350-Insta-Format OHNE Balken: gpt-image-1 verlängert
// die Szenerie nach oben/unten (KI-Hintergrund), das ORIGINAL bleibt pixelgenau
// mittig (Gesicht/Titel unverfälscht). Fallback: weicher Farbverlauf.
// 16:9-Thumbnail → 1080×1350-Insta-Format via ECHTEM Outpainting: Original fest
// mittig auf transparentem 1024×1536-Canvas, gpt-image-1 füllt NUR die leeren
// Flächen (Alpha = Maske) — danach Original nochmal exakt drüber (pixelgenau,
// gleiche Geometrie → keine Doppelungen). Fallback: weicher Farbverlauf.
// 16:9-Thumbnail → 1080×1350-Insta-Format: Hintergrund = unscharfe, abgedunkelte
// Cover-Version des Bilds selbst (bilinear aus stark verkleinerter Quelle = Blur),
// Original pixelgenau mittig. Deterministisch — kein KI-Risiko, keine Balken.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; post_id?: string; message?: string; prompt?: string }

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
        description: 'Erzeugt SOFORT ein neues Bild zum Post (OpenAI). Nutzen, wenn der Nutzer ein Bild will oder Änderungen am Bild wünscht — der Prompt muss zum aktuellen Post-Text passen.',
        input_schema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Englischer Bild-Prompt, passend zum Post-Text, ohne Text/Wasserzeichen im Bild' },
            include: { type: 'array', items: { type: 'string', enum: ['lotte', 'sven'] }, description: 'Echte Personas einbeziehen: lotte (Svens Hündin, echtes Aussehen) und/oder sven (Sven Rüprich, echtes Aussehen)' },
          },
          required: ['prompt'],
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
      const imgTool = blocks.find(b => b.type === 'tool_use' && b.name === 'make_image') as { input?: { prompt?: string; include?: string[] } } | undefined
      let imagePending = false
      if (!newImageUrl && imgTool?.input?.prompt) {
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

    // ── Bild via OpenAI (gpt-image-1) → ad-creatives/social/… ─────────────────
    if (body.action === 'image') {
      if (!body.post_id) return json({ error: 'post_id fehlt' }, 400)
      const { data: post } = await sb.from('social_posts').select('image_prompt, content, topic').eq('id', body.post_id).maybeSingle()
      const p = post as { image_prompt: string | null; content: string | null; topic: string | null } | null
      const prompt = (body.prompt ?? p?.image_prompt ?? '').trim()
        || `Photorealistic lifestyle image matching this social media post about premium new-build real estate investment in Cyprus (Paphos): "${(p?.content ?? '').slice(0, 300)}". Mediterranean light, modern architecture, no text, no watermarks.`
      // Im HINTERGRUND generieren: Persona-Bilder (Drive-Referenzen + OpenAI edits)
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

    // ── YouTube-Sonntagsvideo → Wochen-Posts (So 11:30 CY per Cron) ──────────
    // Neuestes Video vom Kanal holen, Thumbnail sichern, Meta- + LinkedIn-Post
    // texten und OHNE Freigabe für Montag einplanen (Meta 18:30 CY, LinkedIn
    // 08:30 CY). Idempotent über news_source = Video-URL.
    if (body.action === 'youtube_post') {
      const CHANNEL = 'UC7SGGkCGeiY8XQZGvdyNr9A'
      const feed = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`)).text()
      // Neuestes ECHTES Video suchen — Shorts aussortieren (Svens Vorgabe):
      // /shorts/<id> antwortet für Shorts mit 200, echte Videos leiten auf /watch um.
      let vid = '', title = '', desc = ''
      for (const entry of feed.split('<entry>').slice(1, 9)) {
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
      for (const q of ['maxresdefault', 'hqdefault']) {
        const r = await fetch(`https://i.ytimg.com/vi/${vid}/${q}.jpg`)
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
      const now = new Date()
      const cyNow = new Date(now.getTime() + cyOffsetMin(now) * 60000)
      const daysToMon = ((8 - cyNow.getUTCDay()) % 7) || 7
      const monday = new Date(Date.UTC(cyNow.getUTCFullYear(), cyNow.getUTCMonth(), cyNow.getUTCDate() + daysToMon))
      const atCy = (h: number, mi: number) => {
        const guess = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate(), h, mi))
        return new Date(guess.getTime() - cyOffsetMin(guess) * 60000).toISOString()
      }
      await sb.from('social_topics').upsert({ key: 'youtube', label: 'YouTube-Video', icon: '🎬', sort: 90 }, { onConflict: 'key', ignoreDuplicates: true })
      const metaImg = igUrl ?? thumbUrl
      const base = { topic: 'youtube', news_source: videoUrl, format: 'single', status: 'geplant', image_url: thumbUrl, image_urls: thumbUrl ? [thumbUrl] : [] }
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
          for (const post of posts.data ?? []) {
            const cs2 = await fetch(`${G}/${post.id}/comments?fields=id,from{name,id},message,created_time,comments.limit(10){from}&filter=stream&limit=50&access_token=${pageToken}`).then(r => r.json()) as { data?: Array<{ id: string; from?: { name?: string; id?: string }; message?: string; created_time?: string; comments?: { data?: Array<{ from?: { id?: string } }> } }> }
            for (const c of cs2.data ?? []) {
              if (!c.message || c.from?.id === pageId) continue
              // Schon von der Seite beantwortet (egal ob per App oder Portal) → überspringen
              if ((c.comments?.data ?? []).some(r2 => r2.from?.id === pageId)) continue
              await up({ _bucket: 'fb_comments', platform: 'facebook', kind: 'comment', external_id: c.id, thread_ref: post.id, post_preview: (post.message ?? '').slice(0, 120), author_name: c.from?.name ?? null, author_id: c.from?.id ?? null, text: c.message, happened_at: c.created_time ?? null, raw: c })
            }
          }
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
        // IG-Kommentare (letzte 25 Medien)
        if (igId) {
          try {
            const igMe = await fetch(`${G}/${igId}?fields=username&access_token=${pageToken}`).then(r => r.json()) as { username?: string }
            const igUser = igMe.username ?? 'happy_property_cyprus'
            const media = await fetch(`${G}/${igId}/media?fields=id,caption&limit=25&access_token=${pageToken}`).then(r => r.json()) as { data?: Array<{ id: string; caption?: string }>; error?: { message?: string } }
            if (media.error) throw new Error(media.error.message)
            for (const md of media.data ?? []) {
              const cs3 = await fetch(`${G}/${md.id}/comments?fields=id,username,text,timestamp,replies.limit(10){username}&limit=50&access_token=${pageToken}`).then(r => r.json()) as { data?: Array<{ id: string; username?: string; text?: string; timestamp?: string; replies?: { data?: Array<{ username?: string }> } }> }
              for (const c of cs3.data ?? []) {
                if (!c.text || c.username === igUser) continue
                if ((c.replies?.data ?? []).some(r2 => r2.username === igUser)) continue
                await up({ _bucket: 'ig_comments', platform: 'instagram', kind: 'comment', external_id: c.id, thread_ref: md.id, post_preview: (md.caption ?? '').slice(0, 120), author_name: c.username ?? null, author_id: null, text: c.text, happened_at: c.timestamp ?? null, raw: c })
              }
            }
          } catch (e) { errs.push(`ig_comments: ${(e as Error).message}`) }
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
      return json({ ok: true, ...out, errors: errs })
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
Quelle (URL), und eine konkrete Post-Idee (1–2 Sätze) im Happy-Property-Ton.`
      const resp = await claude(anthropicKey, {
        system,
        messages: [{ role: 'user', content: 'Bitte recherchiere jetzt und liefere die 3 besten aktuellen Fundstücke mit Post-Ideen (deutsch, kompakt).' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        max_tokens: 3000,
      })
      const blocks = (resp.content ?? []) as Array<{ type: string; text?: string }>
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (!text) return json({ error: 'Recherche lieferte kein Ergebnis.' }, 502)
      // Fundstücke strukturieren → Ideensammlung (social_ideas) statt Aufgabe/Mail
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
      if (!list.length) return json({ error: 'Fundstücke konnten nicht strukturiert werden.' }, 502)
      const rows = list.map(i => ({ headline: i.headline!.slice(0, 300), core: (i.core ?? '').slice(0, 600), source_url: i.url || null, angle: (i.post_idea ?? '').slice(0, 800) }))
      const { error: ie } = await sb.from('social_ideas').insert(rows)
      if (ie) return json({ error: ie.message }, 500)
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

      const outTool = {
        name: 'set_outputs', description: 'Liefert die fertigen Texte für alle gewünschten Ziele.',
        input_schema: { type: 'object', properties: {
          meta_caption: { type: 'string', description: 'Caption für Facebook + Instagram' },
          linkedin_caption: { type: 'string', description: 'Caption für LinkedIn' },
          newsletter_subject: { type: 'string', description: 'Betreff für den Newsletter' },
          newsletter_html: { type: 'string', description: 'Ausführlicher Newsletter als HTML' },
          image_prompt: { type: 'string', description: 'Englischer Bild-Prompt, fotorealistisch, OHNE Text im Bild' },
        }, required: ['image_prompt'] },
      }
      const wants: string[] = []
      if (wantMeta) wants.push('- meta_caption: locker & direkt, Hook in Zeile 1, kurze Absätze, 3–6 passende Hashtags, klare Handlungsaufforderung. Max ~1200 Zeichen.')
      if (wantLi) wants.push('- linkedin_caption: professioneller, persönlicher Ton (Ich-Perspektive Sven), mehr Substanz und Einordnung, Absätze mit Luft, genau 3 dezente Hashtags. 1200–2000 Zeichen.')
      if (wantNewsletter) wants.push('- newsletter_subject + newsletter_html: AUSFÜHRLICH (300–500 Wörter), sauberes HTML (h2/p/ul/strong, KEINE Bilder), Anrede „Hallo {{vorname}}", Thema für Investoren/Auswanderer einordnen, Quelle als Link, am Ende Einladung zum Gespräch mit Link https://portal.happy-property.com/termin .')
      const resp2 = await claude(anthropicKey, {
        system: `${BRAND}\n\nDu machst aus einer News-Idee fertige, sofort nutzbare Inhalte. Erfinde keine Zahlen; nutze nur, was die Idee hergibt, und ordne ein. Rufe am Ende GENAU EINMAL set_outputs auf.`,
        messages: [{ role: 'user', content: `NEWS-IDEE\nSchlagzeile: ${idea.headline}\nKern: ${idea.core}\nQuelle: ${idea.source_url ?? '—'}\nPost-Winkel: ${idea.angle}\n\nERSTELLE:\n${wants.join('\n')}\n- image_prompt: passend zum Thema (immer).` }],
        tools: [outTool], tool_choice: { type: 'tool', name: 'set_outputs' }, max_tokens: 4000,
      })
      const tu = ((resp2.content ?? []) as Array<{ type: string; name?: string; input?: Record<string, string> }>).find(b => b.type === 'tool_use' && b.name === 'set_outputs')
      if (!tu?.input) return json({ error: 'Texterstellung lieferte kein Ergebnis.' }, 502)
      const out = tu.input

      const postIds: string[] = []
      let metaPostId = ''
      if (wantMeta && out.meta_caption) {
        const { data: p1, error: e1 } = await sb.from('social_posts').insert({
          topic: 'news', title: `📰 ${idea.headline}`.slice(0, 200), content: out.meta_caption,
          platforms: sel.filter(p => p !== 'linkedin'), format, status: 'entwurf', news_source: idea.source_url,
        }).select('id').single()
        if (e1) return json({ error: e1.message }, 500)
        metaPostId = (p1 as { id: string }).id; postIds.push(metaPostId)
      }
      let liPostId = ''
      if (wantLi && out.linkedin_caption) {
        // LinkedIn: kein Karussell — bekommt das erste Bild
        const { data: p2, error: e2 } = await sb.from('social_posts').insert({
          topic: 'news', title: `📰 in · ${idea.headline}`.slice(0, 200), content: out.linkedin_caption,
          platforms: ['linkedin'], format: 'single', status: 'entwurf', news_source: idea.source_url,
        }).select('id').single()
        if (e2) return json({ error: e2.message }, 500)
        liPostId = (p2 as { id: string }).id; postIds.push(liPostId)
      }
      let campaignId = ''
      if (wantNewsletter && out.newsletter_html) {
        const { data: c, error: e3 } = await sb.from('newsletter_campaigns').insert({
          title: `📰 ${idea.headline}`.slice(0, 200), subject: (out.newsletter_subject || idea.headline).slice(0, 200),
          content_mode: 'html', html_body: out.newsletter_html, status: 'draft',
        }).select('id').single()
        if (e3) return json({ error: e3.message }, 500)
        campaignId = (c as { id: string }).id
      }
      await sb.from('social_ideas').update({ status: 'verwendet', used_post_ids: postIds }).eq('id', ideaId)

      // Bilder im Hintergrund: erst an den Meta-Post, dann dieselben an LinkedIn kopieren
      const primary = metaPostId || liPostId
      const imagesPending = primary ? imgCount : 0
      if (primary) {
        const job = (async () => {
          try {
            for (let i = 1; i <= imgCount; i++) {
              const vary = imgCount > 1 ? ` — image ${i} of ${imgCount} of a carousel: vary subject, angle and lighting, keep one consistent photorealistic style.` : ''
              await generatePostImage(sb, primary, `${out.image_prompt}${vary}`)
            }
            if (liPostId && metaPostId) {
              const { data: cur } = await sb.from('social_posts').select('image_urls').eq('id', metaPostId).maybeSingle()
              const urls = ((cur as { image_urls?: string[] } | null)?.image_urls ?? [])
              if (urls.length) await sb.from('social_posts').update({ image_urls: urls, image_url: urls[0], updated_at: new Date().toISOString() }).eq('id', liPostId)
            }
          } catch (e) { console.error('[social-agent] use_idea Bilder:', e) }
        })()
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job)
      }
      return json({ ok: true, post_ids: postIds, campaign_id: campaignId || null, images_pending: imagesPending })
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

    // ── Auto-Tagespost: EIN fälliger geplanter Post pro Tag (FB/Insta-Queue) ──
    if (body.action === 'auto_publish') {
      // Halbstündlicher Cron: postet zur GEPLANTEN Uhrzeit (fällig = Zeit erreicht).
      // Frequenz-Wächter je Kanal: FB/Insta max. 1 Post/Tag, LinkedIn max. 1 Post/Tag.
      const nowIso = new Date().toISOString()
      const today = nowIso.slice(0, 10)
      const { data: due } = await sb.from('social_posts').select('id, platforms')
        .eq('status', 'geplant').lte('scheduled_for', nowIso)
        .order('scheduled_for', { ascending: true }).limit(10)
      const dueList = (due as { id: string; platforms: string[] }[] | null) ?? []
      if (!dueList.length) return json({ ok: true, skipped: 'Kein fälliger freigegebener Post.' })
      const { data: doneToday } = await sb.from('social_posts').select('platforms').gte('posted_at', `${today}T00:00:00Z`)
      const posted = (doneToday as { platforms: string[] }[] | null) ?? []
      const metaDone = posted.some(p => (p.platforms ?? []).some(x => x === 'facebook' || x === 'instagram'))
      const liDone = posted.some(p => (p.platforms ?? []).includes('linkedin'))
      const ytDone = posted.some(p => (p.platforms ?? []).includes('youtube'))
      const next = dueList.find(p => {
        const isMeta = (p.platforms ?? []).some(x => x === 'facebook' || x === 'instagram')
        const isLi = (p.platforms ?? []).includes('linkedin')
        const isYt = (p.platforms ?? []).includes('youtube')
        return !(isMeta && metaDone) && !(isLi && liDone) && !(isYt && ytDone)
      })
      if (!next) return json({ ok: true, skipped: 'Tageslimit erreicht (max. 1 Post/Tag je Kanal).' })
      body.post_id = next.id
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
      const results: Record<string, { ok: boolean; id?: string; error?: string }> = {}

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
          if (p.platforms.includes('facebook')) results.facebook = { ok: false, error: msg }
          if (p.platforms.includes('instagram')) results.instagram = { ok: false, error: msg }
        }
      }
      // Facebook: Karussell (mehrere Fotos), Einzelfoto oder Text-Post
      if (p.platforms.includes('facebook') && pageId && !results.facebook) {
        try {
          if (videoUrl) {
            // Video/Reel: Facebook nimmt eine öffentliche Datei-URL direkt an
            const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}/videos`, { method: 'POST', body: new URLSearchParams({ file_url: videoUrl, description: p.content, access_token: pageToken }) }).then(x => x.json())
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
            const params = new URLSearchParams({ message: p.content, access_token: pageToken })
            mediaIds.forEach((id, i) => params.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })))
            const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, { method: 'POST', body: params }).then(x => x.json())
            if (r.error) throw new Error(r.error.message)
            results.facebook = { ok: true, id: r.id }
          } else {
            const url = p.image_url ? `https://graph.facebook.com/v21.0/${pageId}/photos` : `https://graph.facebook.com/v21.0/${pageId}/feed`
            const params = new URLSearchParams(p.image_url
              ? { url: p.image_url, caption: p.content, access_token: pageToken }
              : { message: p.content, access_token: pageToken })
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
            // Instagram-REEL: Container anlegen → Verarbeitung abwarten → publish
            const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption: p.content, share_to_feed: 'true', access_token: pageToken }) }).then(x => x.json())
            if (c.error) throw new Error(c.error.message)
            let stat = ''
            for (let i = 0; i < 12; i++) {
              await new Promise(res => setTimeout(res, 10000))
              const st = await fetch(`https://graph.facebook.com/v21.0/${c.id}?fields=status_code&access_token=${pageToken}`).then(x => x.json())
              stat = st.status_code ?? ''
              if (stat === 'FINISHED' || stat === 'ERROR') break
            }
            if (stat === 'ERROR') throw new Error('Instagram konnte das Video nicht verarbeiten (Format/Länge prüfen: MP4, 9:16, max. 15 Min).')
            if (stat !== 'FINISHED') throw new Error('Video-Verarbeitung dauert noch — bitte in 1–2 Minuten erneut „Jetzt posten" klicken.')
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
            const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ media_type: 'CAROUSEL', children: children.join(','), caption: p.content, access_token: pageToken }) }).then(x => x.json())
            if (c.error) throw new Error(c.error.message)
            creationId = c.id
          } else {
            const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ image_url: p.image_url, caption: p.content, access_token: pageToken }) }).then(x => x.json())
            if (c.error) throw new Error(c.error.message)
            creationId = c.id
          }
          const pub = await fetch(`https://graph.facebook.com/v21.0/${igId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: creationId, access_token: pageToken }) }).then(x => x.json())
          if (pub.error) throw new Error(pub.error.message)
          results.instagram = { ok: true, id: pub.id }
        } catch (e) { if (!(e as { __done?: boolean }).__done) results.instagram = { ok: false, error: (e as Error).message } }
      }
      // LinkedIn (optional — Token muss Sven einmalig hinterlegen)
      // ── YouTube: Video-Upload über die Data API (Svens Kanal) ────────────────
      if (p.platforms.includes('youtube')) {
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

      if (p.platforms.includes('linkedin')) {
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
      const allOk = Object.values(results).length > 0 && Object.values(results).every(r => r.ok)
      const anyOk = Object.values(results).some(r => r.ok)
      await sb.from('social_posts').update({
        status: allOk ? 'gepostet' : anyOk ? 'gepostet' : 'fehlgeschlagen',
        posted_at: anyOk ? new Date().toISOString() : null,
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
