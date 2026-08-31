// owner-content — Benachrichtigung der Eigentümer über neue Portal-Inhalte.
// Sven lädt Videos/Dokumente für das Eigentümerportal hoch (owner_documents);
// diese Function schickt dazu Lottes Mail + WhatsApp an die betroffenen
// Eigentümer: property_id gesetzt → nur der Eigentümer dieser Wohnung,
// sonst ALLE Eigentümer (role=eigentuemer).
//
//   POST { action: 'notify', doc_id, test?: true }
//     test:true → alles nur an Sven (sven@… / +35795096409), Label „TEST · ".
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy owner-content --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const SITE = 'https://portal.happy-property.com'
const TEST_MAIL = 'sven@happy-property.com'
const TEST_PHONE = '+35795096409'
// Eigenes Motiv fuer Upload-Meldungen: Lotte am Laptop beim Hochladen
// (Svens Drive „Lotte Upload", gespiegelt nach Assets/wa).
const LOTTE_UPLOAD = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/lotte-upload.jpg'

interface Recipient { name: string; email: string | null; phone: string | null; lang: 'de' | 'en' }

// Läuft --no-verify-jwt → Zugriff serverseitig prüfen. notify/compose/bug_done
// sind Massen-Versand bzw. kosten KI-Tokens und dürfen NUR von Staff (Admin/
// Verwalter/Mitarbeiter) oder intern (Service-Role-Bearer) ausgelöst werden.
async function isStaffOrService(req: Request): Promise<boolean> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return false
  if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return true
  const { data } = await createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!).auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return false
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: prof } = await svc.from('profiles').select('role').eq('id', uid).maybeSingle()
  return ['admin', 'verwalter', 'mitarbeiter'].includes((prof as { role?: string } | null)?.role ?? '')
}

// send-email/send-whatsapp liefern Fachfehler teils als 200 mit { error } bzw.
// success:false im Body — beides zählt als fehlgeschlagen.
function invokeFailed(error: { message?: string } | null, data: unknown): string | null {
  if (error) return error.message ?? 'invoke error'
  const d = data as { error?: string; success?: boolean } | null
  if (d?.error) return d.error
  if (d?.success === false) return 'success=false'
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const body = await req.json().catch(() => ({})) as { action?: string; doc_id?: string; test?: boolean; text?: string; attachments?: Array<{ name?: string; url?: string; path?: string }>; task_id?: string }

    // ── Bug-Meldung aus dem Eigentümerportal → Aufgabe für Sven ────────────
    if (body.action === 'bug_report') {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const { data: udata } = await createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!).auth.getUser(jwt)
      const uid = udata?.user?.id
      if (!uid) return json({ error: 'Nicht angemeldet' }, 401)
      const { data: prof } = await sb.from('profiles').select('id, full_name, role').eq('id', uid).maybeSingle()
      const reporter = prof as { id: string; full_name: string | null; role: string | null } | null
      if (!reporter) return json({ error: 'Profil nicht gefunden' }, 404)
      const text = String(body.text ?? '').trim()
      if (!text) return json({ error: 'Bitte beschreibe kurz das Problem.' }, 400)
      const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
      const adminId = (admin as { id: string } | null)?.id
      if (!adminId) return json({ error: 'Kein Admin gefunden' }, 500)
      const repName = reporter.full_name ?? 'Eigentümer'
      const { data: task, error: te } = await sb.from('crm_tasks').insert({
        title: `🐞 Portal-Bug von ${repName}`.slice(0, 200),
        description: `${text}\n\n— gemeldet über das Eigentümerportal von ${repName}`,
        status: 'offen', created_by: adminId, source: 'bug_report', reporter_profile_id: reporter.id,
      }).select('id').single()
      if (te) return json({ error: te.message }, 500)
      const taskId = (task as { id: string }).id
      await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
      const atts = Array.isArray(body.attachments) ? body.attachments.filter(a => a?.url && a?.path).slice(0, 10) : []
      if (atts.length) await sb.from('crm_task_attachments').insert(atts.map(a => ({ task_id: taskId, name: (a.name ?? 'Screenshot').slice(0, 200), url: a.url!, storage_path: a.path! })))
      // Lotte-Boss-Zustellung an Sven wie bei jeder neuen Aufgabe
      sb.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: taskId } }).catch(e => console.warn('[owner-content] dispatch:', e))
      return json({ success: true, task_id: taskId })
    }

    // ── Bug erledigt → Melder benachrichtigen (Portal-Push + Lotte Mail/WA) ──
    if (body.action === 'bug_done') {
      if (!(await isStaffOrService(req))) return json({ error: 'Nicht autorisiert' }, 401)
      if (!body.task_id) return json({ error: 'task_id fehlt' }, 400)
      const { data: t } = await sb.from('crm_tasks')
        .select('id, title, status, source, reporter_profile_id, bug_done_notified_at')
        .eq('id', body.task_id).maybeSingle()
      const task = t as { id: string; title: string; status: string; source: string | null; reporter_profile_id: string | null; bug_done_notified_at: string | null } | null
      if (!task || task.source !== 'bug_report' || !task.reporter_profile_id) return json({ skipped: 'kein_bug' })
      if (task.status !== 'erledigt') return json({ skipped: 'nicht_erledigt' })
      // Compare-and-swap gegen Doppelmeldung (Muster aus task-notify)
      const { data: claimed } = await sb.from('crm_tasks').update({ bug_done_notified_at: new Date().toISOString() })
        .eq('id', task.id).is('bug_done_notified_at', null).select('id')
      if (!claimed || !claimed.length) return json({ skipped: 'bereits_gemeldet' })
      const { data: rp } = await sb.from('profiles').select('full_name, email, phone, language').eq('id', task.reporter_profile_id).maybeSingle()
      const rep = rp as { full_name: string | null; email: string | null; phone: string | null; language: string | null } | null
      if (!rep) return json({ skipped: 'melder_fehlt' })
      const de_ = rep.language !== 'en'
      const first = (rep.full_name ?? '').split(' ')[0] || (de_ ? 'Hallo' : 'Hi')
      const cleanTitle = task.title.replace(/^🐞\s*/, '')
      const nTitle = de_ ? '✅ Deine Meldung ist erledigt' : '✅ Your report is done'
      const nBody = de_
        ? `Sven hat deine Aufgabe erledigt: „${cleanTitle}". Bitte prüfe, ob jetzt alles funktioniert. Danke für deine Mithilfe, unser Portal besser zu machen! 🐾`
        : `Sven has completed your task: “${cleanTitle}”. Please check that everything works now. Thank you for helping us improve the portal! 🐾`
      // Portal-Banner nur einmal je Aufgabe (Retry nach Sendefehler darf nicht doppeln)
      const { data: existingNotif } = await sb.from('owner_notifications').select('id').eq('task_id', task.id).limit(1)
      if (!existingNotif?.length) {
        const { error: nErr } = await sb.from('owner_notifications').insert({ profile_id: task.reporter_profile_id, task_id: task.id, title: nTitle, body: nBody })
        if (nErr) console.warn('[owner-content] bug_done Portal-Meldung:', nErr.message)
      }
      let phone = (rep.phone ?? '').trim()
      if (!phone && rep.email) {
        const { data: ld } = await sb.from('leads').select('phone').ilike('email', rep.email).limit(1)
        phone = ((ld?.[0] as { phone?: string | null } | undefined)?.phone ?? '').trim()
      }
      let sentAny = false
      let attempted = false
      try {
        if (rep.email) {
          const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
            <div style="text-align:center;margin-bottom:6px;">
              <img src="${lotteBild()}" alt="Lotte" width="80" height="80" style="width:80px;height:80px;border-radius:50%;object-fit:cover;" />
              <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · ${de_ ? 'persönliche Assistentin von Sven' : "Sven's personal assistant"} 🐾</p>
            </div>
            <p>${de_ ? `Hallo ${first},` : `Hi ${first},`}</p>
            <p>${nBody}</p>
            <p style="text-align:center;margin:24px 0;">
              <a href="${SITE}/eigentuemer/dashboard" style="background:#ff795d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block;">${de_ ? 'Zum Portal →' : 'Open portal →'}</a>
            </p>
            <p style="font-size:13px;color:#6b7280;">${de_ ? 'Liebe Grüße' : 'Best regards'}<br/>Lotte 🐾</p>
          </div>`
          attempted = true
          const { data: mData, error } = await sb.functions.invoke('send-email', { body: { to: rep.email, subject: nTitle, html, from_name: 'Lotte · Happy Property', auto: true, lang: de_ ? 'de' : 'en' } })
          const fail = invokeFailed(error, mData)
          if (fail) console.warn('[owner-content] bug_done Mail:', fail)
          else sentAny = true
        }
        if (phone) {
          attempted = true
          const { data: wData, error } = await sb.functions.invoke('send-whatsapp', { body: {
            event_type: 'bug_done', override_text: `${first} 🐾\n\n${nBody}\n\n${SITE}/eigentuemer/dashboard`,
            lead_data: { lead_name: first, lead_phone: phone }, persona_image: lotteBild(),
          } })
          const fail = invokeFailed(error, wData)
          if (fail) console.warn('[owner-content] bug_done WhatsApp:', fail)
          else sentAny = true
        }
      } catch (e) { console.warn('[owner-content] bug_done Versand:', e) }
      if (!sentAny && !rep.email && !phone) console.warn('[owner-content] bug_done: Melder ohne Mail/Telefon — nur Portal-Meldung')
      // Beide aktiven Kanäle fehlgeschlagen → Marker zurücksetzen, damit der
      // 5-Min-Sweep es erneut versucht (Portal-Banner ist dann ggf. doppelt-sicher
      // per upsert-artigem Insert nicht nötig — owner_notifications bleibt stehen).
      if (attempted && !sentAny) {
        await sb.from('crm_tasks').update({ bug_done_notified_at: null }).eq('id', task.id)
        return json({ success: false, retry: true })
      }
      return json({ success: true, notified: true, mail: !!rep.email, whatsapp: !!phone })
    }

    // ── compose: Stichpunkte → wohlklingende Lotte-Nachricht (DE + EN) ────────
    // Sven tippt ein paar Stichpunkte zum Upload; die KI formuliert daraus die
    // Nachricht, die Lotte an die Eigentümer schickt. Editierbar im Frontend.
    if (body.action === 'compose') {
      if (!(await isStaffOrService(req))) return json({ error: 'Nicht autorisiert' }, 401)
      const b = body as unknown as { title?: string; kind?: string; bullets?: string }
      if (!b.title || !b.bullets?.trim()) return json({ error: 'title + bullets nötig' }, 400)
      const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
      if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)
      const isVideo = b.kind === 'video'
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 900,
          messages: [{ role: 'user', content:
`Du schreibst als "Lotte", die Hündin und persönliche Assistentin von Sven bei Happy Property (Immobilien auf Zypern). Lotte informiert die Eigentümer, dass etwas Neues im Eigentümer-Portal liegt: ${isVideo ? 'ein Video' : 'ein Dokument'} mit dem Titel "${b.title}".

Svens Stichpunkte dazu (das steckt drin / darum lohnt es sich):
${b.bullets.trim()}

Schreibe die Benachrichtigung in ZWEI Sprachen. Regeln:
- Warm, persönlich, DU-Form, kurz (4 bis 7 Saetze), WhatsApp-tauglich. Sparsame Emojis (🐾 passt zu Lotte).
- Sag klar, WAS neu ist und was die Eigentümer davon haben (aus den Stichpunkten, nichts erfinden).
- KEINE Anrede am Anfang (die setzt das System je Empfänger) und KEINE Grußformel am Ende (kommt ebenfalls vom System).
- KEINE Links (der Portal-Link wird automatisch angehängt).
- Niemals Gedankenstriche (— oder –) verwenden, nur normale Bindestriche.
Antworte NUR als JSON: {"de": "...", "en": "..."}`
          }],
        }),
      })
      if (!res.ok) return json({ error: `KI-Fehler ${res.status}` }, 502)
      const data = await res.json() as { content?: Array<{ type?: string; text?: string }> }
      const raw = (data.content ?? []).find(c => c.type === 'text')?.text ?? ''
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) return json({ error: 'KI-Antwort unlesbar' }, 502)
      try {
        const out = JSON.parse(m[0]) as { de?: string; en?: string }
        if (!out.de) throw new Error('de fehlt')
        return json({ success: true, de: out.de.trim(), en: (out.en ?? out.de).trim() })
      } catch { return json({ error: 'KI-Antwort unlesbar' }, 502) }
    }

    if (body.action !== 'notify' || !body.doc_id) return json({ error: 'action=notify + doc_id nötig' }, 400)
    if (!(await isStaffOrService(req))) return json({ error: 'Nicht autorisiert' }, 401)
    const test = body.test === true
    // Von Sven freigegebene KI-Texte (Stichpunkte-Flow); ohne sie greift der Standardtext.
    const custom = body as unknown as { message_de?: string; message_en?: string }
    const customDe = (custom.message_de ?? '').trim()
    const customEn = (custom.message_en ?? '').trim() || customDe

    const { data: docRow, error: de } = await sb.from('owner_documents')
      .select('id, title, kind, property_id, file_url').eq('id', body.doc_id).maybeSingle()
    if (de || !docRow) return json({ error: 'Dokument nicht gefunden' }, 404)
    const doc = docRow as { id: string; title: string; kind: string; property_id: string | null; file_url: string }

    // Betroffene Eigentümer bestimmen
    let unitLabel = ''
    let owners: Array<{ id: string; full_name: string | null; email: string | null; phone: string | null; language: string | null }> = []
    if (doc.property_id) {
      const { data: prop } = await sb.from('properties').select('owner_id, project_name, unit_number').eq('id', doc.property_id).maybeSingle()
      const p = prop as { owner_id: string | null; project_name: string | null; unit_number: string | null } | null
      unitLabel = [p?.project_name, p?.unit_number].filter(Boolean).join(' ')
      // Eigentuemer UND eingeladene Mit-Eigentuemer. Service-Rolle, also greifen
      // die Datenbank-Regeln hier nicht — der Kreis muss von Hand gebildet werden.
      const { data: co } = await sb.from('property_co_owners').select('profile_id').eq('property_id', doc.property_id)
      const empfIds = [...new Set([
        ...(p?.owner_id ? [p.owner_id] : []),
        ...((co ?? []) as Array<{ profile_id: string }>).map(c => c.profile_id),
      ])]
      if (empfIds.length) {
        const { data: pr } = await sb.from('profiles').select('id, full_name, email, phone, language').in('id', empfIds)
        owners = (pr ?? []) as typeof owners
      }
    } else {
      const { data: prs } = await sb.from('profiles').select('id, full_name, email, phone, language').eq('role', 'eigentuemer')
      owners = (prs ?? []) as typeof owners
    }
    if (!owners.length) return json({ error: 'Keine Eigentümer gefunden (Wohnung ohne Portal-Zugang?)' }, 400)

    // Telefon-Fallback: Lead mit gleicher Mail
    const recipients: Recipient[] = []
    for (const o of owners) {
      let phone = (o.phone ?? '').trim()
      if (!phone && o.email) {
        const { data: ld } = await sb.from('leads').select('phone').ilike('email', o.email).order('created_at', { ascending: true }).limit(1)
        phone = ((ld?.[0] as { phone?: string | null } | undefined)?.phone ?? '').trim()
      }
      recipients.push({
        name: (o.full_name ?? '').split(' ')[0] || 'Eigentümer',
        email: o.email, phone: phone || null,
        lang: (o.language === 'en' ? 'en' : 'de'),
      })
    }

    const portal = `${SITE}/eigentuemer/dashboard`
    const results: Array<{ name: string; mail: boolean; whatsapp: boolean; error?: string }> = []
    for (const r of recipients) {
      const isVideo = doc.kind === 'video'
      const de_ = r.lang === 'de'
      const what = isVideo
        ? (de_ ? 'ein neues Video von Sven' : 'a new video from Sven')
        : (de_ ? 'ein neues Dokument' : 'a new document')
      const forUnit = unitLabel
        ? (de_ ? ` für deine Wohnung (${unitLabel})` : ` for your apartment (${unitLabel})`)
        : ''
      const prefix = test ? 'TEST · ' : ''
      const subject = `${prefix}${de_ ? `Neu im Eigentümer-Portal: ${doc.title}` : `New in your owner portal: ${doc.title}`}`
      // Kern der Nachricht: Svens KI-Text (aus Stichpunkten), sonst Standardsatz.
      const core = de_ ? customDe : customEn
      const coreHtml = core
        ? core.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('')
        : `<p>${de_
          ? `im Eigentümer-Portal liegt ${what}${forUnit} für dich bereit: <b>„${doc.title}"</b>.`
          : `there is ${what}${forUnit} waiting for you in your owner portal: <b>“${doc.title}”</b>.`}</p>`
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
        <div style="text-align:center;margin-bottom:6px;">
          <img src="${LOTTE_UPLOAD}" alt="Lotte" width="200" style="width:200px;max-width:80%;border-radius:14px;" />
          <p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Lotte · ${de_ ? 'persönliche Assistentin von Sven' : "Sven's personal assistant"} 🐾</p>
        </div>
        <p>${de_ ? `Hallo ${r.name},` : `Hi ${r.name},`}</p>
        ${coreHtml}
        <p style="text-align:center;margin:24px 0;">
          <a href="${portal}" style="background:#ff795d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block;">${de_ ? 'Zum Eigentümer-Portal →' : 'Open owner portal →'}</a>
        </p>
        <p style="font-size:13px;color:#6b7280;">${de_ ? 'Liebe Grüße' : 'Best regards'}<br/>Lotte 🐾</p>
      </div>`
      const waText = core
        ? (de_
          ? `${prefix}Hallo ${r.name} 🐾\n\n${core}\n\n*${doc.title}*\n${portal}\n\nLiebe Grüße, Lotte`
          : `${prefix}Hi ${r.name} 🐾\n\n${core}\n\n*${doc.title}*\n${portal}\n\nBest, Lotte`)
        : (de_
          ? `${prefix}Hallo ${r.name} 🐾\n\nhier ist Lotte von Happy Property. Im Eigentümer-Portal liegt ${what}${forUnit} für dich bereit:\n\n*${doc.title}*\n\n${portal}\n\nLiebe Grüße, Lotte`
          : `${prefix}Hi ${r.name} 🐾\n\nLotte from Happy Property here. There is ${what}${forUnit} waiting for you in your owner portal:\n\n*${doc.title}*\n\n${portal}\n\nBest, Lotte`)

      const res = { name: r.name, mail: false, whatsapp: false } as typeof results[number]
      try {
        const to = test ? TEST_MAIL : (r.email ?? '')
        if (to) {
          const { data: mData, error } = await sb.functions.invoke('send-email', { body: {
            to, subject, html, from_name: 'Lotte · Happy Property', auto: true, lang: r.lang,
          } })
          const fail = invokeFailed(error, mData)
          if (fail) throw new Error(fail)
          res.mail = true
        }
        const phone = test ? TEST_PHONE : (r.phone ?? '')
        if (phone) {
          const { data: wData, error } = await sb.functions.invoke('send-whatsapp', { body: {
            event_type: 'owner_document', override_text: waText,
            lead_data: { lead_name: r.name, lead_phone: phone },
            persona_image: LOTTE_UPLOAD,
          } })
          const fail = invokeFailed(error, wData)
          if (fail) throw new Error(fail)
          res.whatsapp = true
        }
      } catch (err) {
        res.error = err instanceof Error ? err.message : String(err)
        console.error('[owner-content] notify:', r.name, res.error)
      }
      results.push(res)
      if (test) break // Test: nur EIN Durchlauf an Sven
    }

    if (!test) {
      // KI-Text am Dokument festhalten - so nutzt ein spaeteres "Benachrichtigen"
      // aus der Liste denselben freigegebenen Text.
      const patch: Record<string, string> = { notified_at: new Date().toISOString() }
      if (customDe) patch.description = customDe
      await sb.from('owner_documents').update(patch).eq('id', doc.id)
    }
    return json({ success: true, recipients: results.length, results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[owner-content]', msg)
    return json({ error: msg }, 500)
  }
})
