// construction-update — Neue Baustellenfotos für ein Projekt hochgeladen →
// Lotte meldet sich bei den Kunden des Projekts (Eigentümer + laufende Deals +
// aktive Interessenten) per E-Mail UND WhatsApp mit den frischen Fotos.
// Absenderin ist Lotte (Bild „Lotte_photographer" aus dem Drive).
//
//   POST { project_id }              → SCHARF. Läuft nur wenn crm_settings
//        construction_update_enabled = 'true'. Claimt atomar die NEUEN Fotos
//        (notified_at IS NULL), sendet einmal je Kunde, stempelt sie als gemeldet.
//   POST { project_id, test: true }  → NUR an Sven (sven@… / +35795096409), nimmt
//        die neuesten Fotos als Muster, claimt NICHT, ignoriert das Flag.
//
// Schutz: sendet nur bei eingeschaltetem Flag; nur NEUE Fotos (atomar geclaimt,
// keine Doppelsendung); Opt-out (leads.newsletter_optout_at) respektiert; Dedup
// je Kontakt (Eigentümer, der auch Lead ist, bekommt es nur einmal).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON
// Deploy:  supabase functions deploy construction-update --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const SUPA = Deno.env.get('SUPABASE_URL')!
const TEST_MAIL = 'sven@happy-property.com'
const TEST_PHONE = '+35795096409'
const MAX_MAIL_PHOTOS = 6

// Lotte als Fotografin — Bild liegt im Drive, wird EINMAL in den öffentlichen
// Assets-Bucket gespiegelt und danach von dort referenziert.
const LOTTE_PHOTO_PATH = 'wa/lotte-photographer.jpg'
// Kopie im FREIGEGEBENEN Lotte-Ordner (Service-Account kann sie lesen); das
// Original lag in einem nicht geteilten Ordner.
const LOTTE_PHOTO_DRIVE_ID = '1I7DpDQkEJSBCyGlfvrusbawnDB-e13P0'

interface Recipient { name: string; email: string | null; phone: string | null; lang: 'de' | 'en' }
interface ConPhoto { id: string; file_path: string; file_name: string }

const firstOf = (full?: string | null): string => (full ?? '').trim().split(/\s+/)[0] ?? ''

// ── Drive (Service-Account) — nur zum Spiegeln des Lotte-Fotos ──────────────
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
// Öffentliche URL des Lotte-Fotografin-Bilds sicherstellen (einmal aus Drive spiegeln).
// Fällt bei Problemen sauber auf ein normales Lotte-Foto zurück.
async function ensureLottePhoto(sb: SupabaseClient): Promise<string> {
  const url = `${SUPA}/storage/v1/object/public/Assets/${LOTTE_PHOTO_PATH}`
  try { const h = await fetch(url, { method: 'HEAD' }); if (h.ok) return url } catch { /* mirror below */ }
  try {
    const token = await driveToken()
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${LOTTE_PHOTO_DRIVE_ID}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`Drive-Download ${r.status}`)
    const bytes = new Uint8Array(await r.arrayBuffer())
    const { error } = await sb.storage.from('Assets').upload(LOTTE_PHOTO_PATH, bytes, { contentType: 'image/jpeg', upsert: true })
    if (error) throw new Error(error.message)
    return url
  } catch (e) { console.warn('[construction-update] Lotte_photographer spiegeln fehlgeschlagen:', e instanceof Error ? e.message : String(e)); return lotteBild() }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(SUPA, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const body = await req.json().catch(() => ({})) as { project_id?: string; test?: boolean; force?: boolean; buyers_only?: boolean; all_photos?: boolean }
    const projectId = String(body.project_id ?? '').trim()
    const test = body.test === true
    const force = body.force === true        // Schalter überspringen (gezielter Einmal-Versand)
    const buyersOnly = body.buyers_only === true  // nur Käufer (Eigentümer + Deals), keine Interessenten
    const allPhotos = body.all_photos === true    // ALLE Projektfotos senden (nicht nur die neuen)
    if (!projectId) return json({ error: 'project_id fehlt' }, 400)

    // Ein/Aus-Schalter (Standard AUS) — scharf nur wenn aktiviert ODER force.
    if (!test && !force) {
      const { data: flag } = await sb.from('crm_settings').select('value').eq('key', 'construction_update_enabled').maybeSingle()
      if ((flag as { value?: string } | null)?.value !== 'true') {
        const { count } = await sb.from('construction_photos').select('id', { count: 'exact', head: true }).eq('project_id', projectId).is('notified_at', null)
        return json({ skipped: 'disabled', new_photos: count ?? 0 })
      }
    }

    // Projekt
    const { data: proj } = await sb.from('crm_projects').select('name, location').eq('id', projectId).maybeSingle()
    const project = proj as { name: string; location: string | null } | null
    if (!project) return json({ error: 'Projekt nicht gefunden' }, 404)
    const projName = project.name

    // Fotos bestimmen: test/all_photos → alle (bis Deckel); scharf-normal → NUR
    // NEUE atomar claimen. Bei all_photos-Scharfversand alle als gemeldet stempeln.
    let photos: ConPhoto[] = []
    if (test || allPhotos) {
      const { data } = await sb.from('construction_photos').select('id, file_path, file_name')
        .eq('project_id', projectId).order('created_at', { ascending: false }).limit(MAX_MAIL_PHOTOS)
      photos = (data ?? []) as ConPhoto[]
      if (!test && photos.length) {
        await sb.from('construction_photos').update({ notified_at: new Date().toISOString() })
          .eq('project_id', projectId).is('notified_at', null)
      }
    } else {
      const { data } = await sb.from('construction_photos').update({ notified_at: new Date().toISOString() })
        .eq('project_id', projectId).is('notified_at', null).select('id, file_path, file_name')
      photos = (data ?? []) as ConPhoto[]
    }
    if (!photos.length) return json({ skipped: test ? 'keine_fotos' : 'keine_neuen_fotos' })

    // Nur Bilder (keine Videos) als Vorschau/Anhang.
    const isImg = (n: string) => !/\.(mp4|mov|webm|mpeg|m4v|avi)$/i.test(n)
    const imgPaths = photos.filter(p => isImg(p.file_name)).map(p => p.file_path)
    const usePaths = (imgPaths.length ? imgPaths : photos.map(p => p.file_path)).slice(0, MAX_MAIL_PHOTOS)
    const { data: signed } = await sb.storage.from('construction-photos').createSignedUrls(usePaths, 60 * 60 * 24 * 7)
    const photoUrls = (signed ?? []).map(s => s.signedUrl).filter(Boolean) as string[]
    if (!photoUrls.length) return json({ error: 'Signierte Foto-URLs fehlgeschlagen' }, 500)

    const lottePhoto = await ensureLottePhoto(sb)

    // ── Empfänger auflösen: (a) Eigentümer (b) laufende Deals (c) Interessenten ─
    const { data: units } = await sb.from('crm_project_units').select('id, property_id').eq('project_id', projectId)
    const unitIds = ((units ?? []) as Array<{ id: string; property_id: string | null }>).map(u => u.id)
    const propIds = ((units ?? []) as Array<{ id: string; property_id: string | null }>).map(u => u.property_id).filter((x): x is string => !!x)

    // (a) Eigentümer über properties.owner_id → profiles
    const ownerProfiles: Array<{ full_name: string | null; email: string | null; phone: string | null; language: string | null }> = []
    if (propIds.length) {
      const { data: props } = await sb.from('properties').select('owner_id').in('id', propIds).not('owner_id', 'is', null)
      const ownerIds = [...new Set(((props ?? []) as Array<{ owner_id: string }>).map(p => p.owner_id))]
      if (ownerIds.length) {
        const { data: profs } = await sb.from('profiles').select('full_name, email, phone, language').in('id', ownerIds)
        ownerProfiles.push(...((profs ?? []) as typeof ownerProfiles))
      }
    }

    // (b) laufende Deals: über unit_id UND über deal_projects, phase != archiviert
    const leadIds = new Set<string>()
    if (unitIds.length) {
      const { data: d1 } = await sb.from('deals').select('lead_id').in('unit_id', unitIds).neq('phase', 'archiviert')
      for (const d of (d1 ?? []) as Array<{ lead_id: string | null }>) if (d.lead_id) leadIds.add(d.lead_id)
    }
    const { data: dp } = await sb.from('deal_projects').select('deal_id').eq('project_id', projectId)
    const dealIds = [...new Set(((dp ?? []) as Array<{ deal_id: string | null }>).map(x => x.deal_id).filter((x): x is string => !!x))]
    if (dealIds.length) {
      const { data: d2 } = await sb.from('deals').select('lead_id').in('id', dealIds).neq('phase', 'archiviert')
      for (const d of (d2 ?? []) as Array<{ lead_id: string | null }>) if (d.lead_id) leadIds.add(d.lead_id)
    }
    // (c) Interessenten: Deck zum Projekt verschickt — bei buyers_only weglassen.
    if (!buyersOnly) {
      const { data: decks } = await sb.from('sales_decks').select('lead_id').eq('project_id', projectId)
      for (const d of (decks ?? []) as Array<{ lead_id: string | null }>) if (d.lead_id) leadIds.add(d.lead_id)
    }

    let leadRows: Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; whatsapp: string | null; language: string | null; newsletter_optout_at: string | null }> = []
    if (leadIds.size) {
      const { data: ls } = await sb.from('leads').select('id, first_name, last_name, email, phone, whatsapp, language, newsletter_optout_at').in('id', [...leadIds])
      leadRows = (ls ?? []) as typeof leadRows
    }

    // Dedup je Kontakt (E-Mail bevorzugt, sonst Telefon). Eigentümer zuerst.
    const recips = new Map<string, Recipient>()
    const keyOf = (email?: string | null, phone?: string | null) => (email?.trim().toLowerCase() || (phone ?? '').replace(/\D/g, '') || '')
    for (const o of ownerProfiles) {
      let phone = (o.phone ?? '').trim()
      if (!phone && o.email) {
        const { data: ld } = await sb.from('leads').select('phone, whatsapp').ilike('email', o.email).order('created_at', { ascending: true }).limit(1)
        const l0 = ld?.[0] as { phone?: string | null; whatsapp?: string | null } | undefined
        phone = ((l0?.whatsapp ?? '').trim() || (l0?.phone ?? '').trim())
      }
      const email = (o.email ?? '').trim() || null
      const k = keyOf(email, phone); if (!k || recips.has(k)) continue
      recips.set(k, { name: firstOf(o.full_name) || 'Investor', email, phone: phone || null, lang: o.language === 'en' ? 'en' : 'de' })
    }
    for (const l of leadRows) {
      if (l.newsletter_optout_at) continue   // Opt-out respektieren
      const email = (l.email ?? '').trim() || null
      const phone = ((l.whatsapp ?? '').trim() || (l.phone ?? '').trim()) || null
      const k = keyOf(email, phone); if (!k || recips.has(k)) continue
      recips.set(k, { name: firstOf(l.first_name) || firstOf(`${l.first_name ?? ''} ${l.last_name ?? ''}`) || 'Investor', email, phone, lang: l.language === 'en' ? 'en' : 'de' })
    }

    const recipients = test
      ? [{ name: 'Sven', email: TEST_MAIL, phone: TEST_PHONE, lang: 'de' as const }]
      : [...recips.values()]
    if (!recipients.length) return json({ success: true, recipients: 0, note: 'Keine Kunden für dieses Projekt' })

    // ── Senden ────────────────────────────────────────────────────────────────
    const imgTags = photoUrls.map(u => `<img src="${u}" alt="Baustelle" style="width:100%;max-width:520px;border-radius:12px;margin:8px 0;display:block;" />`).join('\n')
    const results: Array<{ name: string; mail: boolean; whatsapp: boolean; error?: string }> = []
    for (const r of recipients) {
      const de = r.lang === 'de'
      const prefix = test ? 'TEST · ' : ''
      const subject = `${prefix}${de ? `📸 Baustellen-Update: ${projName}` : `📸 Construction update: ${projName}`}`
      const intro = de
        ? `hier ist Lotte 🐾. Ich war heute auf der Baustelle von <b>${projName}</b> und habe ein paar frische Fotos für dich geschossen. Es geht sichtbar voran, deine Immobilie am Mittelmeer wächst Stück für Stück.`
        : `it's Lotte 🐾. I stopped by the construction site of <b>${projName}</b> today and took a few fresh photos for you. Things are visibly moving, your property by the Mediterranean is coming along step by step.`
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;">
        <div style="text-align:center;margin-bottom:12px;">
          <img src="${lottePhoto}" alt="Lotte auf der Baustelle" style="width:100%;max-width:560px;border-radius:14px;display:block;margin:0 auto;" />
          <p style="font-size:12px;color:#6b7280;margin:8px 0 0;">Lotte · ${de ? 'persönliche Assistentin von Sven' : "Sven's personal assistant"} 🐾</p>
        </div>
        <p>${de ? `Hallo ${r.name},` : `Hi ${r.name},`}</p>
        <p>${intro}</p>
        ${imgTags}
        <p style="font-size:13px;color:#6b7280;margin-top:18px;">${de ? 'Viel Freude beim Anschauen und liebe Grüße' : 'Enjoy the view and best regards'}<br/>Lotte 🐾</p>
      </div>`
      const waText = de
        ? `${prefix}Hallo ${r.name} 🐾\n\nhier ist Lotte von Happy Property. Ich war heute auf der Baustelle von *${projName}* und hab ein paar frische Fotos für dich gemacht. Es geht voran, deine Immobilie am Mittelmeer wächst! 🌊\n\nLiebe Grüße, Lotte`
        : `${prefix}Hi ${r.name} 🐾\n\nLotte from Happy Property here. I visited the construction site of *${projName}* today and took a few fresh photos for you. It's moving forward, your property by the Mediterranean is growing! 🌊\n\nBest, Lotte`

      const res = { name: r.name, mail: false, whatsapp: false } as typeof results[number]
      try {
        if (r.email) {
          const { error } = await sb.functions.invoke('send-email', { body: {
            to: r.email, subject, html, from_name: 'Lotte · Happy Property', auto: true, lang: r.lang,
          } })
          if (error) throw new Error(error.message)
          res.mail = true
        }
        if (r.phone) {
          // WhatsApp hat nur EINEN Bild-Slot je Nachricht → mehrere Nachrichten:
          // (1) Lotte meldet sich mit IHREM Bild, dann (2..N) je ein frisches Foto.
          // allow_duplicate ÜBERALL: sonst greift der 6h-Text-Doppelschutz bei
          // gleichlautenden Foto-Captions und unterdrückt Fotos (bzw. die
          // Lotte-Nachricht, wenn derselbe Text kurz zuvor schon rausging).
          const r1 = await sb.functions.invoke('send-whatsapp', { body: {
            event_type: 'construction_update', override_text: waText,
            lead_data: { lead_name: r.name, lead_phone: r.phone },
            persona_image: lottePhoto, allow_duplicate: true,
          } })
          if (r1.error) throw new Error(r1.error.message)
          for (let i = 0; i < photoUrls.length; i++) {
            const cap = i === 0
              ? (de ? `📸 Frisch von der Baustelle: ${projName}` : `📸 Fresh from the site: ${projName}`)
              : `📸 ${projName} (${i + 1}/${photoUrls.length})`
            await sb.functions.invoke('send-whatsapp', { body: {
              event_type: 'construction_update', override_text: cap,
              lead_data: { lead_name: r.name, lead_phone: r.phone },
              file_url: photoUrls[i], file_name: `${projName}-${i + 1}.jpg`, allow_duplicate: true,
            } }).catch((e2: unknown) => console.warn('[construction-update] WA-Foto:', e2))
          }
          res.whatsapp = true
        }
      } catch (err) {
        res.error = err instanceof Error ? err.message : String(err)
        console.error('[construction-update] send:', r.name, res.error)
      }
      results.push(res)
    }

    return json({ success: true, project: projName, photos: photoUrls.length, recipients: results.length, test, results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[construction-update]', msg)
    return json({ error: msg }, 500)
  }
})
