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
tierisch-weise, mit Immobilien-Dreh, Absender Lotte.`

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
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', quality: 'medium', n: 1 }),
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
          properties: { prompt: { type: 'string', description: 'Englischer Bild-Prompt, passend zum Post-Text, ohne Text/Wasserzeichen im Bild' } },
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
      const imgTool = blocks.find(b => b.type === 'tool_use' && b.name === 'make_image')
      if (!newImageUrl && imgTool?.input?.prompt) {
        try {
          newImageUrl = await generatePostImage(sb, body.post_id, imgTool.input.prompt)
          reply = reply ? `${reply}\n\n🎨 Neues Bild ist fertig.` : '🎨 Neues Bild ist fertig — passend zum Text.'
        } catch (e) { reply = `${reply}\n\n❌ Bild fehlgeschlagen: ${(e as Error).message}`.trim() }
      }
      // Verlauf speichern
      await sb.from('social_post_messages').insert([
        { post_id: body.post_id, role: 'user', content: body.message.trim() },
        { post_id: body.post_id, role: 'assistant', content: reply || (newContent ? 'Post aktualisiert ✓' : '…') },
      ])
      return json({ ok: true, reply: reply || (newContent ? 'Ich habe den Post-Text aktualisiert. ✓' : ''), content: newContent, image_url: newImageUrl, image_prompt: toolUse?.input?.image_prompt ?? null })
    }

    // ── Bild via OpenAI (gpt-image-1) → ad-creatives/social/… ─────────────────
    if (body.action === 'image') {
      if (!body.post_id) return json({ error: 'post_id fehlt' }, 400)
      const { data: post } = await sb.from('social_posts').select('image_prompt, content').eq('id', body.post_id).maybeSingle()
      const p = post as { image_prompt: string | null; content: string | null } | null
      const prompt = (body.prompt ?? p?.image_prompt ?? '').trim()
        || `Photorealistic lifestyle image matching this social media post about premium new-build real estate investment in Cyprus (Paphos): "${(p?.content ?? '').slice(0, 300)}". Mediterranean light, modern architecture, no text, no watermarks.`
      try {
        const url = await generatePostImage(sb, body.post_id, prompt)
        return json({ ok: true, image_url: url, prompt })
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
      const sel = Array.isArray(body.platforms) ? (body.platforms as string[]).filter(p => ['facebook', 'instagram', 'linkedin'].includes(p)) : []
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
      const next = dueList.find(p => {
        const isMeta = (p.platforms ?? []).some(x => x === 'facebook' || x === 'instagram')
        const isLi = (p.platforms ?? []).includes('linkedin')
        return !(isMeta && metaDone) && !(isLi && liDone)
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
      const p = p0 ? { ...p0, image_url: imgs[0] ?? p0.image_url } : null
      if (!p?.content?.trim()) return json({ error: 'Der Post hat noch keinen Text.' }, 400)
      const metaToken = Deno.env.get('META_ACCESS_TOKEN') ?? ''
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
          if (isCarousel) {
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
        } catch (e) { results.instagram = { ok: false, error: (e as Error).message } }
      }
      // LinkedIn (optional — Token muss Sven einmalig hinterlegen)
      if (p.platforms.includes('linkedin')) {
        if (!liToken) {
          results.linkedin = { ok: false, error: 'LINKEDIN_ACCESS_TOKEN fehlt — LinkedIn ist noch nicht verbunden.' }
        } else {
          try {
            const me = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${liToken}` } }).then(x => x.json())
            const author = `urn:li:person:${me.sub}`
            const r = await fetch('https://api.linkedin.com/v2/ugcPosts', {
              method: 'POST',
              headers: { Authorization: `Bearer ${liToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
              body: JSON.stringify({
                author, lifecycleState: 'PUBLISHED',
                specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: p.content }, shareMediaCategory: 'NONE' } },
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
