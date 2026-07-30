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

async function claude(apiKey: string, opts: { system: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; max_tokens?: number }): Promise<Record<string, unknown>> {
  let lastErr = ''
  for (const model of MODELS) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: opts.max_tokens ?? 2048, system: opts.system, messages: opts.messages, ...(opts.tools ? { tools: opts.tools } : {}) }),
    })
    const d = await res.json()
    if (res.ok) return d as Record<string, unknown>
    lastErr = JSON.stringify(d).slice(0, 300)
    // Modell existiert (noch) nicht → nächstes probieren; andere Fehler → abbrechen
    if (!/model|not_found/i.test(lastErr)) break
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

      const system = `${BRAND}

Du bist der Social-Media-Redakteur im Happy-Property-CRM. Sven (oder ein Mitarbeiter)
bespricht mit dir EINEN Post. Aktueller Stand:
- Thema: ${p.topic} ${p.topic === 'weisheit' ? '(Absender ist LOTTE — Hunde-Perspektive, humorvoll!)' : ''}
- Plattformen: ${(p.platforms as string[] ?? []).join(', ')}
- Aktueller Text: ${p.content ? `"""${p.content}"""` : '(noch leer)'}
${p.news_source ? `- News-Bezug: ${p.news_source}` : ''}

Projekte (echte Daten, NUR diese verwenden):
${projects}

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
      }]
      const resp = await claude(anthropicKey, { system, messages, tools })
      const blocks = (resp.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: { content?: string; image_prompt?: string } }>
      const reply = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      const toolUse = blocks.find(b => b.type === 'tool_use' && b.name === 'set_post')
      let newContent: string | null = null
      if (toolUse?.input?.content) {
        newContent = toolUse.input.content
        const patch: Record<string, unknown> = { content: newContent, updated_at: new Date().toISOString() }
        if (toolUse.input.image_prompt) patch.image_prompt = toolUse.input.image_prompt
        await sb.from('social_posts').update(patch).eq('id', body.post_id)
      }
      // Verlauf speichern
      await sb.from('social_post_messages').insert([
        { post_id: body.post_id, role: 'user', content: body.message.trim() },
        { post_id: body.post_id, role: 'assistant', content: reply || (newContent ? 'Post aktualisiert ✓' : '…') },
      ])
      return json({ ok: true, reply: reply || (newContent ? 'Ich habe den Post-Text aktualisiert. ✓' : ''), content: newContent, image_prompt: toolUse?.input?.image_prompt ?? null })
    }

    // ── Bild via OpenAI (gpt-image-1) → ad-creatives/social/… ─────────────────
    if (body.action === 'image') {
      if (!body.post_id) return json({ error: 'post_id fehlt' }, 400)
      const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
      if (!openaiKey) return json({ error: 'OPENAI_API_KEY fehlt in den Secrets.' }, 500)
      const { data: post } = await sb.from('social_posts').select('image_prompt, topic, content').eq('id', body.post_id).maybeSingle()
      const p = post as { image_prompt: string | null; topic: string; content: string | null } | null
      const prompt = (body.prompt ?? p?.image_prompt ?? '').trim()
        || `Photorealistic lifestyle image for a social media post about premium new-build real estate investment in Cyprus (Paphos), Mediterranean light, modern architecture, no text, no watermarks.`
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', quality: 'medium', n: 1 }),
      })
      const d = await res.json()
      if (!res.ok) return json({ error: `OpenAI: ${JSON.stringify(d?.error ?? d).slice(0, 200)}` }, 502)
      const b64 = d?.data?.[0]?.b64_json as string | undefined
      if (!b64) return json({ error: 'OpenAI lieferte kein Bild.' }, 502)
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      const path = `social/${body.post_id}-${Date.now()}.png`
      const { error: upErr } = await sb.storage.from('ad-creatives').upload(path, bytes, { contentType: 'image/png', upsert: true })
      if (upErr) return json({ error: `Upload: ${upErr.message}` }, 500)
      const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/ad-creatives/${path}`
      await sb.from('social_posts').update({ image_url: url, image_prompt: prompt, updated_at: new Date().toISOString() }).eq('id', body.post_id)
      return json({ ok: true, image_url: url, prompt })
    }

    // ── News-Recherche → Aufgabe für Sven ─────────────────────────────────────
    if (body.action === 'news_scan') {
      const system = `${BRAND}

Du recherchierst AKTUELLE Nachrichten (letzte ~14 Tage) rund um Immobilien, die sich
für Social-Media-Posts von Happy Property eignen. Zwei Blickwinkel:
1) Zypern: Immobilienmarkt, Preise, Tourismus, Infrastruktur, Steuern, Paphos/Limassol.
2) Deutschland: Regulierung/Steuern/Mietrecht (z.B. Mieterschutzgesetze, Mietendeckel,
   Grunderwerbsteuer) — als Kontrast-Aufhänger („freier Markt Zypern vs. DE-Gängelung").
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
      // Aufgabe für Sven (Startseite „Meine Aufgaben")
      const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
      const adminId = (admin as { id: string } | null)?.id ?? null
      const { data: task, error: te } = await sb.from('crm_tasks').insert({
        title: `📰 Social-Media: ${new Date().toLocaleDateString('de-DE')} — 3 News-Fundstücke mit Post-Ideen`,
        description: `${text.slice(0, 3800)}\n\n→ Post daraus machen: Tools → Social Media → „Neuer Post" (Thema: Aktuelles).`,
        created_by: adminId, status: 'offen',
      }).select('id').single()
      if (te) return json({ error: te.message }, 500)
      const taskId = (task as { id: string }).id
      if (adminId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
      return json({ ok: true, task_id: taskId, findings: text })
    }

    // ── Veröffentlichen ───────────────────────────────────────────────────────
    if (body.action === 'publish') {
      if (!body.post_id) return json({ error: 'post_id fehlt' }, 400)
      const { data: post } = await sb.from('social_posts').select('*').eq('id', body.post_id).maybeSingle()
      const p = post as { content: string | null; image_url: string | null; platforms: string[]; status: string } | null
      if (!p?.content?.trim()) return json({ error: 'Der Post hat noch keinen Text.' }, 400)
      const metaToken = Deno.env.get('META_ACCESS_TOKEN') ?? ''
      const liToken = Deno.env.get('LINKEDIN_ACCESS_TOKEN') ?? ''
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
      // Facebook: Foto-Post (mit Bild) oder Text-Post
      if (p.platforms.includes('facebook') && pageId && !results.facebook) {
        try {
          const url = p.image_url
            ? `https://graph.facebook.com/v21.0/${pageId}/photos`
            : `https://graph.facebook.com/v21.0/${pageId}/feed`
          const params = new URLSearchParams(p.image_url
            ? { url: p.image_url, caption: p.content, access_token: pageToken }
            : { message: p.content, access_token: pageToken })
          const r = await fetch(url, { method: 'POST', body: params }).then(x => x.json())
          if (r.error) throw new Error(r.error.message)
          results.facebook = { ok: true, id: r.post_id ?? r.id }
        } catch (e) { results.facebook = { ok: false, error: (e as Error).message } }
      }
      // Instagram: braucht ein Bild (Container → publish)
      if (p.platforms.includes('instagram') && !results.instagram) {
        try {
          if (!igId) throw new Error('Kein Instagram-Business-Konto mit der Seite verknüpft.')
          if (!p.image_url) throw new Error('Instagram braucht ein Bild — erst „Bild erstellen".')
          const c = await fetch(`https://graph.facebook.com/v21.0/${igId}/media`, { method: 'POST', body: new URLSearchParams({ image_url: p.image_url, caption: p.content, access_token: pageToken }) }).then(x => x.json())
          if (c.error) throw new Error(c.error.message)
          const pub = await fetch(`https://graph.facebook.com/v21.0/${igId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: c.id, access_token: pageToken }) }).then(x => x.json())
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
