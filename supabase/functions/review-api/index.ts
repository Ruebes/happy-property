// review-api — Kundenbewertungen: Fragebogen-Link per WhatsApp (Lotte),
// oeffentliche Abgabe mit optionalem Foto + Einwilligung (jederzeit widerrufbar),
// Freigabe fuer das Website-Widget.
//
//   POST { action:'list' }                          → alle Anfragen (nur eingeloggt)
//   POST { action:'create', lead_id }               → Anfrage anlegen + Lotte-WhatsApp mit Link
//   POST { action:'publish', id, published }        → Website-Freigabe an/aus (nur eingeloggt)
//   POST { action:'delete', id }                    → Anfrage loeschen (nur eingeloggt, nie fuer eingegangene)
//   POST { action:'view', token }                   → Fragebogen-Status (oeffentlich)
//   POST { action:'submit', token, answers, rating, review_text,
//          consent, photo_base64?, photo_mime? }    → Abgabe speichern (oeffentlich)
//   POST { action:'revoke', token }                 → Kunde entzieht Foto-/Nutzungs-Erlaubnis
//   GET  ?action=public_list                        → freigegebene Bewertungen (Website-Widget)
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy:  supabase functions deploy review-api --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } })

const PORTAL = 'https://portal.happy-property.com'
const BUCKET = 'review-photos'
const LOTTE_BEWERTUNG = 'Assets/wa/Lotte_Bewertung.jpg' // Wunschbild von Sven; Fallback: lotte1.jpg
const HAPPY_LOTTE     = 'Assets/wa/Happy_Lotte.jpg'     // Absenderbild der Affiliate-Nachricht

interface ReviewRow {
  id: string; lead_id: string | null; token: string; recipient_name: string
  language: string; status: string; answers: Record<string, string>
  rating: number | null; review_text: string | null; photo_path: string | null
  consent_given_at: string | null; consent_revoked_at: string | null
  published: boolean; sent_at: string | null; submitted_at: string | null; created_at: string
  recommend: boolean | null; affiliate_id: string | null
}

// Aufrufer muss eingeloggter Admin/Verwalter/Mitarbeiter sein (Verwaltungs-Aktionen).
async function callerAllowed(sb: SupabaseClient, req: Request): Promise<boolean> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return false
  const { data } = await sb.auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return false
  const { data: prof } = await sb.from('profiles').select('role').eq('id', uid).maybeSingle()
  const role = (prof as { role?: string } | null)?.role
  return role === 'admin' || role === 'verwalter' || role === 'mitarbeiter'
}

function publicPhotoUrl(path: string | null): string | null {
  if (!path) return null
  return `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/${BUCKET}/${path}`
}

// Nur der Vorname erscheint auf der Website (Svens Vorgabe 27.8.).
function displayName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? ''
}

// Empfehlungs-Link + Lotte-WhatsApp fuer einen frischen Tippgeber.
async function ensureAffiliate(sb: SupabaseClient, row: ReviewRow): Promise<string | null> {
  try {
    let lead: { email: string | null; phone: string | null; whatsapp: string | null } | null = null
    if (row.lead_id) {
      const { data } = await sb.from('leads').select('email, phone, whatsapp').eq('id', row.lead_id).maybeSingle()
      lead = data as typeof lead
    }
    let aff: { id: string; code: string } | null = null
    if (row.lead_id) {
      const { data } = await sb.from('affiliates').select('id, code').eq('lead_id', row.lead_id).maybeSingle()
      aff = data as typeof aff
    }
    if (!aff) {
      const { data, error } = await sb.from('affiliates').insert({
        lead_id: row.lead_id, name: row.recipient_name,
        email: lead?.email ?? null, whatsapp: lead?.whatsapp ?? lead?.phone ?? null,
        source: 'review',
      }).select('id, code').single()
      if (error) { console.warn('[review-api] Affiliate-Anlage fehlgeschlagen:', error.message); return null }
      aff = data as { id: string; code: string }
    }
    await sb.from('review_requests').update({ affiliate_id: aff.id }).eq('id', row.id)

    const url = `${PORTAL}/termin?src=empfehlung&ref=${aff.code}`
    const phone = (lead?.whatsapp ?? lead?.phone ?? '').trim()
    if (phone) {
      const first = row.recipient_name.trim().split(/\s+/)[0]
      const text = row.language === 'en'
        ? `Hi ${first} 🐾 how wonderful that you'd recommend Happy Property!\n\n` +
          `Here is your personal referral link:\n${url}\n\n` +
          `How it works: share the link with friends. If someone books a call through it and ends up buying a property with us, you receive 1,000 € as a thank-you 💛\n\n` +
          `Thank you for spreading the word!\nYour Lotte 🐾`
        : `Hallo ${first} 🐾 wie schön, dass du Happy Property weiterempfehlen möchtest!\n\n` +
          `Hier ist dein persönlicher Empfehlungs-Link:\n${url}\n\n` +
          `So funktioniert's: Teile den Link mit Freunden. Bucht jemand darüber ein Gespräch und kauft am Ende eine Immobilie über uns, bekommst du 1.000 € als Dankeschön 💛\n\n` +
          `Danke, dass du uns weitersagst!\nDeine Lotte 🐾`
      const base = Deno.env.get('SUPABASE_URL')!
      let img = `${base}/storage/v1/object/public/${HAPPY_LOTTE}`
      const head = await fetch(img, { method: 'HEAD' }).catch(() => null)
      if (!head?.ok) img = `${base}/storage/v1/object/public/Assets/wa/lotte1.jpg`
      await sb.functions.invoke('send-whatsapp', { body: {
        event_type: 'affiliate_link',
        override_text: text, already_translated: true, lang: row.language,
        lead_id: row.lead_id ?? undefined,
        lead_data: { lead_name: row.recipient_name, lead_phone: phone },
        file_url: img, file_name: 'Happy_Lotte.jpg',
      } })
    }
    return url
  } catch (e) {
    console.warn('[review-api] ensureAffiliate:', e)
    return null
  }
}

function lotteText(name: string, lang: string, url: string): string {
  const first = name.trim().split(/\s+/)[0] || name
  if (lang === 'en') {
    return `Hi ${first}, Lotte from Happy Property here 🧡\n\n` +
      `We want to get better - and for that we need you. You've been through the whole journey with Sven and Lotte: how was it for you?\n\n` +
      `Here's our short questionnaire (2-3 minutes):\n${url}\n\n` +
      `At the end you can - if you like - write a short review for our website and upload a photo of yourself. Only with your permission, promised - and you can withdraw it anytime.\n\nThank you! 🙏`
  }
  return `Hallo ${first}, hier ist Lotte von Happy Property 🧡\n\n` +
    `Wir wollen besser werden - und dafür brauchen wir dich. Du hast den ganzen Weg mit Sven und Lotte erlebt: Wie war er für dich?\n\n` +
    `Hier geht's zu unserem kurzen Fragebogen (2-3 Minuten):\n${url}\n\n` +
    `Am Ende kannst du - wenn du magst - eine kleine Bewertung für unsere Website schreiben und ein Foto von dir hochladen. Nur mit deiner Erlaubnis, versprochen - und du kannst sie jederzeit wieder zurückziehen.\n\nDanke dir! 🙏`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const urlObj = new URL(req.url)
    const isGet = req.method === 'GET'
    const body = isGet ? {} : (await req.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(isGet ? (urlObj.searchParams.get('action') ?? '') : (body.action ?? ''))

    // ── Website-Widget: freigegebene Bewertungen (oeffentlich, cachebar) ─────
    if (action === 'public_list') {
      const { data } = await sb.from('review_requests')
        .select('recipient_name, rating, review_text, photo_path, submitted_at')
        .eq('published', true)
        .is('consent_revoked_at', null)
        .not('review_text', 'is', null)
        .order('submitted_at', { ascending: false })
        .limit(30)
      const reviews = ((data ?? []) as ReviewRow[]).map(r => ({
        name: displayName(r.recipient_name),
        rating: r.rating ?? 5,
        text: r.review_text,
        photo: publicPhotoUrl(r.photo_path),
        date: r.submitted_at,
      }))
      return json({ ok: true, reviews }, 200, { 'Cache-Control': 'public, max-age=300' })
    }

    // ── Verwaltung (nur eingeloggt) ──────────────────────────────────────────
    if (action === 'list' || action === 'create' || action === 'publish' || action === 'delete') {
      if (!(await callerAllowed(sb, req))) return json({ error: 'Nicht berechtigt.' }, 403)

      if (action === 'list') {
        const { data } = await sb.from('review_requests').select('*').order('created_at', { ascending: false })
        const rows = ((data ?? []) as ReviewRow[]).map(r => ({ ...r, photo_url: publicPhotoUrl(r.photo_path), url: `${PORTAL}/bewertung/${r.token}` }))
        return json({ ok: true, requests: rows })
      }

      if (action === 'create') {
        const leadId = String(body.lead_id ?? '').trim()
        if (!leadId) return json({ error: 'lead_id fehlt.' }, 400)
        const { data: lead } = await sb.from('leads')
          .select('id, first_name, last_name, email, phone, whatsapp, language')
          .eq('id', leadId).maybeSingle()
        if (!lead) return json({ error: 'Lead nicht gefunden.' }, 404)
        const l = lead as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null; language: string | null }
        const name = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.email || 'Kunde'
        const phone = (l.whatsapp || l.phone || '').trim()
        if (!phone) return json({ error: 'Lead hat keine WhatsApp-/Telefonnummer.' }, 400)
        const lang = l.language === 'en' ? 'en' : 'de'

        // Bestehende offene Anfrage wiederverwenden statt Duplikat anlegen
        let row: ReviewRow | null = null
        const { data: existing } = await sb.from('review_requests')
          .select('*').eq('lead_id', leadId).eq('status', 'sent').maybeSingle()
        if (existing) row = existing as ReviewRow
        if (!row) {
          const { data: created, error: ce } = await sb.from('review_requests')
            .insert({ lead_id: leadId, recipient_name: name, language: lang, status: 'sent', sent_at: new Date().toISOString() })
            .select('*').single()
          if (ce) return json({ error: ce.message }, 500)
          row = created as ReviewRow
        }

        const link = `${PORTAL}/bewertung/${row.token}`
        // Lotte_Bewertung-Bild, wenn vorhanden — sonst Standard-Lotte
        const base = Deno.env.get('SUPABASE_URL')!
        let img = `${base}/storage/v1/object/public/${LOTTE_BEWERTUNG}`
        const head = await fetch(img, { method: 'HEAD' }).catch(() => null)
        if (!head?.ok) img = `${base}/storage/v1/object/public/Assets/wa/lotte1.jpg`

        const { data: waRes, error: waErr } = await sb.functions.invoke('send-whatsapp', { body: {
          event_type: 'review_request',
          override_text: lotteText(name, lang, link),
          already_translated: true,
          lang,
          lead_id: leadId,
          lead_data: { lead_name: name, lead_phone: phone },
          file_url: img,
          file_name: 'Lotte_Bewertung.jpg',
        } })
        const waOk = !waErr && (waRes as { success?: boolean } | null)?.success !== false
        if (!waOk) return json({ error: 'WhatsApp-Versand fehlgeschlagen.', detail: waErr ?? waRes }, 500)

        await sb.from('review_requests').update({ sent_at: new Date().toISOString() }).eq('id', row.id)
        return json({ ok: true, url: link, id: row.id })
      }

      if (action === 'publish') {
        const id = String(body.id ?? '')
        const published = body.published === true
        const { data: r } = await sb.from('review_requests').select('*').eq('id', id).maybeSingle()
        if (!r) return json({ error: 'Nicht gefunden.' }, 404)
        const row = r as ReviewRow
        if (published && (row.consent_revoked_at || !row.consent_given_at))
          return json({ error: 'Keine (gültige) Einwilligung - kann nicht veröffentlicht werden.' }, 400)
        if (published && !row.review_text)
          return json({ error: 'Keine Bewertung vorhanden.' }, 400)
        if (published && row.rating !== 5)
          return json({ error: 'Nur 5-Snack-Bewertungen kommen auf die Website (Svens Vorgabe).' }, 400)
        await sb.from('review_requests').update({ published, updated_at: new Date().toISOString() }).eq('id', id)
        return json({ ok: true })
      }

      if (action === 'delete') {
        const id = String(body.id ?? '')
        const { data: r } = await sb.from('review_requests').select('status, photo_path').eq('id', id).maybeSingle()
        if (!r) return json({ error: 'Nicht gefunden.' }, 404)
        if ((r as { status: string }).status === 'submitted')
          return json({ error: 'Eingegangene Bewertungen werden nicht gelöscht.' }, 400)
        await sb.from('review_requests').delete().eq('id', id)
        return json({ ok: true })
      }
    }

    // ── Oeffentlich (token-basiert) ──────────────────────────────────────────
    const token = String(body.token ?? '').trim()
    if (!token) return json({ error: 'Token fehlt.' }, 400)
    const { data: reqRow } = await sb.from('review_requests').select('*').eq('token', token).maybeSingle()
    if (!reqRow) return json({ error: 'Link ungültig.' }, 404)
    const row = reqRow as ReviewRow

    if (action === 'view') {
      let affiliateUrl: string | null = null
      if (row.affiliate_id) {
        const { data: aff } = await sb.from('affiliates').select('code').eq('id', row.affiliate_id).maybeSingle()
        const code = (aff as { code?: string } | null)?.code
        if (code) affiliateUrl = `${PORTAL}/termin?src=empfehlung&ref=${code}`
      }
      return json({ ok: true, review: {
        recipient_name: row.recipient_name, language: row.language, status: row.status,
        answers: row.answers, rating: row.rating, review_text: row.review_text,
        photo_url: publicPhotoUrl(row.photo_path),
        consent: !!row.consent_given_at && !row.consent_revoked_at,
        recommend: row.recommend, affiliate_url: affiliateUrl,
      } })
    }

    if (action === 'submit') {
      const answers: Record<string, string> = {}
      const rawAnswers = (body.answers ?? {}) as Record<string, unknown>
      for (const k of ['q1', 'q2', 'q3', 'q4', 'q5']) {
        const v = String(rawAnswers[k] ?? '').trim()
        if (v) answers[k] = v.slice(0, 4000)
      }
      const reviewText = String(body.review_text ?? '').trim().slice(0, 2000) || null
      const rating = Number(body.rating)
      const consent = body.consent === true

      let photoPath: string | null = row.photo_path
      const b64 = typeof body.photo_base64 === 'string' ? body.photo_base64 : ''
      if (b64) {
        if (!consent) return json({ error: 'Foto nur mit Einwilligung.' }, 400)
        const mime = String(body.photo_mime ?? 'image/jpeg')
        const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
        const bytes = Uint8Array.from(atob(b64.replace(/^data:[^,]+,/, '')), c => c.charCodeAt(0))
        if (bytes.length > 5 * 1024 * 1024) return json({ error: 'Foto zu groß (max. 5 MB).' }, 400)
        photoPath = `${row.id}.${ext}`
        const { error: upErr } = await sb.storage.from(BUCKET).upload(photoPath, bytes, { contentType: mime, upsert: true })
        if (upErr) return json({ error: 'Foto-Upload fehlgeschlagen: ' + upErr.message }, 500)
      }

      const firstSubmit = row.status !== 'submitted'
      const recommend = typeof body.recommend === 'boolean' ? body.recommend : row.recommend
      const finalRating = rating >= 1 && rating <= 5 ? rating : null
      // Svens Regel: 5-Snack-Bewertungen mit Einwilligung gehen automatisch auf
      // die Website — alles darunter bleibt intern (nur Feedback fuer Lotte & Sven).
      const autoPublish = finalRating === 5 && consent && !!reviewText
      const { error: ue } = await sb.from('review_requests').update({
        answers, review_text: reviewText,
        rating: finalRating,
        photo_path: photoPath,
        recommend,
        consent_given_at: consent ? (row.consent_given_at ?? new Date().toISOString()) : null,
        consent_revoked_at: consent ? null : row.consent_revoked_at,
        published: autoPublish,
        status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', row.id)
      if (ue) return json({ error: ue.message }, 500)

      // Empfehlung = JA → Tippgeber anlegen + Lotte schickt den Empfehlungs-Link
      let affiliateUrl: string | null = null
      if (recommend === true) affiliateUrl = await ensureAffiliate(sb, row)

      // Sven Bescheid geben: Aufgabe + Aktivitaet in der Kundenakte (nur beim ersten Mal)
      if (firstSubmit) {
        try {
          const { data: admin } = await sb.from('profiles').select('id').eq('role', 'admin').order('created_at').limit(1).maybeSingle()
          const adminId = (admin as { id: string } | null)?.id
          if (adminId) {
            const { data: task } = await sb.from('crm_tasks').insert({
              title: `⭐ Bewertung von ${row.recipient_name} eingegangen`.slice(0, 200),
              description: `Fragebogen ausgefüllt${reviewText ? ' + Website-Bewertung geschrieben' : ''}${photoPath ? ' + Foto hochgeladen' : ''}.\n\nPrüfen & freigeben: ${PORTAL}/admin/crm/reviews`,
              status: 'offen', created_by: adminId, source: 'review',
            }).select('id').single()
            const taskId = (task as { id: string } | null)?.id
            if (taskId) await sb.from('crm_task_assignees').insert({ task_id: taskId, profile_id: adminId, channel: 'system' })
          }
          if (row.lead_id) {
            await sb.from('activities').insert({
              lead_id: row.lead_id, type: 'note', direction: 'inbound', auto: true,
              subject: 'Bewertungs-Fragebogen ausgefüllt',
              content: `Antworten eingegangen${reviewText ? `, Bewertung: „${reviewText.slice(0, 200)}"` : ''}${rating >= 1 ? `, ${rating}/5 Sterne` : ''}.`,
            })
          }
        } catch (e) { console.warn('[review-api] Benachrichtigung fehlgeschlagen:', e) }
      }
      return json({ ok: true, affiliate_url: affiliateUrl, published: autoPublish })
    }

    if (action === 'revoke') {
      await sb.from('review_requests').update({
        consent_revoked_at: new Date().toISOString(), published: false, updated_at: new Date().toISOString(),
      }).eq('id', row.id)
      if (row.lead_id) {
        try {
          await sb.from('activities').insert({
            lead_id: row.lead_id, type: 'note', direction: 'inbound', auto: true,
            subject: 'Bewertungs-Einwilligung entzogen',
            content: 'Kunde hat die Erlaubnis zur Nutzung von Bewertung/Foto auf der Website entzogen. Anzeige wurde automatisch gestoppt.',
          })
        } catch { /* Log-Eintrag ist nice-to-have */ }
      }
      return json({ ok: true })
    }

    return json({ error: 'Unbekannte Aktion.' }, 400)
  } catch (e) {
    console.error('[review-api]', e)
    return json({ error: e instanceof Error ? e.message : 'Unbekannter Fehler' }, 500)
  }
})
