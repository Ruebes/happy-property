// Blog-Autopilot: Schnittstelle zwischen dem GitHub-Autopiloten (Ruebes/hp-blog-autopilot) und
// der Prüfwarteschlange im Hub (Tabelle blog_artikel, Seite /admin/crm/blog). Sven 24.10.26.
//
// Ablauf:
//   1. Der Autopilot fragt `vorrat` ab und schreibt nach, bis 4 ungeprüfte Artikel bereitliegen
//      (im Autobetrieb: bis 4 Wochen im Voraus eingeplant sind).
//   2. Jeder bestandene Artikel kommt per `einliefern` (WordPress-Entwurf liegt schon an),
//      das Social-Bild vorher per `bild` in ad-creatives/social/blog/.
//   3. Sven gibt im Hub frei (RPC blog_freigeben, nächster Dienstag 07:00 Zypern).
//      Im Autobetrieb (crm_settings.blog_autopilot.enabled) passiert das hier automatisch.
//   4. Der tägliche Lauf holt `faellig`, plant den Beitrag in WordPress ein und meldet
//      `markieren` status geplant. Dabei entstehen die Social-Posts (status geplant, social-agent
//      postet sie) am Erscheinungstag (Dienstag, Zypern): LinkedIn auf dem Autopilot-Platz 08:30,
//      Facebook und Instagram 12:30, immer mit mindestens 3 Stunden Abstand zu anderen Posts.
//      Nach dem Termin meldet er `veroeffentlicht`.
//
// Aufrufer: nur der Autopilot, Header x-cron-secret == connector_secrets BLOG_AUTOPILOT_SECRET,
// oder der Service-Key. Deploy:
//   supabase functions deploy blog-autopilot --project-ref vjlwgajmtqlwjjreowbu --no-verify-jwt

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { authorizeCaller, corsHeaders as CORS } from '../_shared/callerAuth.ts'

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const sbAdmin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const ZONE = 'Asia/Nicosia'
const BUCKET = 'ad-creatives'

interface Einstellung { enabled?: boolean; vorrat?: number }

async function einstellung(sb: SupabaseClient): Promise<Einstellung> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', 'blog_autopilot').maybeSingle()
  try { return JSON.parse((data as { value: string } | null)?.value ?? '{}') as Einstellung } catch { return {} }
}

/** Kalendertag (Zypern) eines Zeitpunkts als YYYY-MM-DD. */
function zyTag(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/** Uhrzeit HH:MM an einem Zypern-Kalendertag als Date (richtiger Offset, auch bei Zeitumstellung). */
function zyZeit(tag: string, hhmm: string): Date {
  const probe = new Date(`${tag}T12:00:00Z`)
  const off = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'longOffset' })
    .formatToParts(probe).find(p => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00'
  return new Date(`${tag}T${hhmm}:00${off}`)
}

interface Artikel {
  id: string; status: string; titel: string; slug: string; wp_post_id: number | null; wp_link: string | null
  geplant_fuer: string | null; social: { facebook?: string; instagram?: string; linkedin?: string; bild_url?: string }
  social_post_ids: string[]
}

interface ApSlot { dow: number; kind: string; time: string }
interface ApCfg { enabled?: boolean; slots?: ApSlot[]; li_slots?: ApSlot[]; reel_platforms?: string[] }

const ABSTAND_MS = 3 * 3600_000  // Sven 24.10.26: immer ein paar Stunden zu anderen Posts
const KANDIDATEN_META = ['12:30', '15:30', '09:30', '20:30']
const KANDIDATEN_LI = ['08:30', '11:30', '14:30']

/** Belegte Zeiten je Plattform an einem Tag: geplante/gepostete Posts, Autopilot-Plan, YouTube-Wochenpost. */
async function belegung(sb: SupabaseClient, tag: string): Promise<{ zeiten: Record<string, number[]>; liSlot: boolean; liAutopilot: { id: string; status: string } | null }> {
  const start = zyZeit(tag, '00:00').getTime() - 3600_000, ende = zyZeit(tag, '23:59').getTime() + 3600_000
  const zeiten: Record<string, number[]> = { facebook: [], instagram: [], linkedin: [] }
  const { data: posts } = await sb.from('social_posts').select('id, platforms, scheduled_for, status, autopilot_slot')
    .in('status', ['entwurf', 'geplant', 'gepostet']).gte('scheduled_for', new Date(start).toISOString())
    .lte('scheduled_for', new Date(ende).toISOString())
  let liAutopilot: { id: string; status: string } | null = null
  for (const p of (posts ?? []) as Array<{ id: string; platforms: string[]; scheduled_for: string; status: string; autopilot_slot: string | null }>) {
    if (p.autopilot_slot === `${tag}|linkedin`) { liAutopilot = { id: p.id, status: p.status }; continue }
    for (const pl of p.platforms ?? []) (zeiten[pl] ??= []).push(new Date(p.scheduled_for).getTime())
  }
  const { data: s } = await sb.from('crm_settings').select('value').eq('key', 'social_autopilot').maybeSingle()
  let cfg: ApCfg = {}
  try { cfg = JSON.parse((s as { value: string } | null)?.value ?? '{}') as ApCfg } catch { cfg = {} }
  const dow = new Date(`${tag}T12:00:00Z`).getUTCDay()
  let liSlot = false
  if (cfg.enabled === true) {
    for (const sl of (cfg.slots ?? []).filter(x => x.dow === dow)) {
      const pls = sl.kind === 'reel' ? (cfg.reel_platforms ?? ['facebook', 'instagram']) : ['facebook', 'instagram']
      for (const pl of pls) (zeiten[pl] ??= []).push(zyZeit(tag, sl.time).getTime())
    }
    // Der LinkedIn-Platz des Autopiloten zählt nicht als belegt: der Blog-Post übernimmt ihn.
    liSlot = (cfg.li_slots ?? []).some(x => x.dow === dow)
  }
  if (dow === 1) {  // YouTube-Wochenpost (social-agent youtube_post): LinkedIn 08:30, Facebook/Instagram 18:30
    zeiten.linkedin.push(zyZeit(tag, '08:30').getTime())
    zeiten.facebook.push(zyZeit(tag, '18:30').getTime())
    zeiten.instagram.push(zyZeit(tag, '18:30').getTime())
  }
  return { zeiten, liSlot, liAutopilot }
}

function freieZeit(tag: string, kandidaten: string[], plattformen: string[], zeiten: Record<string, number[]>, nicht_vor: number): Date | null {
  for (const k of kandidaten) {
    const t = zyZeit(tag, k).getTime()
    if (t < nicht_vor) continue
    if (plattformen.every(pl => (zeiten[pl] ?? []).every(x => Math.abs(x - t) >= ABSTAND_MS))) return new Date(t)
  }
  return null
}

async function socialPlanen(sb: SupabaseClient, a: Artikel, link: string): Promise<string[]> {
  if (!a.geplant_fuer || a.social_post_ids?.length) return a.social_post_ids ?? []
  const s = a.social ?? {}
  const bild = s.bild_url ?? null
  const erscheint = new Date(a.geplant_fuer).getTime()
  const tag = zyTag(new Date(a.geplant_fuer))
  const { zeiten, liSlot, liAutopilot } = await belegung(sb, tag)
  const ids: string[] = []
  const anlegen = async (zeile: Record<string, unknown>, label: string) => {
    const { data, error } = await sb.from('social_posts').insert({
      topic: 'blog', title: `📰 Blog · ${label} · ${a.titel}`.slice(0, 200), format: 'single', status: 'geplant', ...zeile,
    }).select('id').single()
    if (error) {
      if (ids.length) await sb.from('social_posts').delete().in('id', ids)
      throw new Error(`Social-Post ${label}: ${error.message}`)
    }
    ids.push((data as { id: string }).id)
  }

  // LinkedIn: höchstens ein Post pro Tag (auto_publish). Hat der Tag einen Autopilot-LinkedIn-Platz,
  // übernimmt der Blog-Post genau diesen Platz (Schlüssel <tag>|linkedin, Zustand manual), sonst eine
  // freie Zeit mit Abstand. Ist schon ein fremder LinkedIn-Post am Tag, entfällt der Blog-Post dort.
  if ((s.linkedin ?? '').trim()) {
    const li = { platforms: ['linkedin'], content: s.linkedin, image_url: bild, image_urls: bild ? [bild] : [], news_source: link }
    if (liAutopilot && ['entwurf', 'geplant'].includes(liAutopilot.status)) {
      // Autopilot hat seinen Post für den Tag schon angelegt: der Blog-Post übernimmt ihn
      const { error } = await sb.from('social_posts').update({ ...li, topic: 'blog', title: `📰 Blog · LinkedIn · ${a.titel}`.slice(0, 200),
        status: 'geplant', scheduled_for: zyZeit(tag, '08:30').toISOString(), post_results: { autopilot: { state: 'manual' } },
        updated_at: new Date().toISOString() }).eq('id', liAutopilot.id)
      if (error) throw new Error(`LinkedIn übernehmen: ${error.message}`)
      ids.push(liAutopilot.id)
    } else if (liSlot && !liAutopilot) {
      await anlegen({ ...li, scheduled_for: zyZeit(tag, '08:30').toISOString(), autopilot_slot: `${tag}|linkedin`,
        post_results: { autopilot: { state: 'manual' } } }, 'LinkedIn')
    } else if (!liSlot && !(zeiten.linkedin ?? []).length) {
      const zeit = freieZeit(tag, KANDIDATEN_LI, ['linkedin'], zeiten, erscheint)
      if (zeit) await anlegen({ ...li, scheduled_for: zeit.toISOString() }, 'LinkedIn')
    }
    // sonst: an dem Tag ist LinkedIn schon belegt (höchstens ein Post pro Tag), der Blog-Post entfällt dort
  }
  // Facebook und Instagram zur selben freien Zeit, mindestens 3 Stunden Abstand zu allen anderen Posts
  const zeitMeta = freieZeit(tag, KANDIDATEN_META, ['facebook', 'instagram'], zeiten, erscheint)
  if (!zeitMeta) throw new Error(`Kein freier Facebook/Instagram-Termin mit 3 Stunden Abstand am ${tag}`)
  const fb = (s.facebook ?? '').includes(link) ? s.facebook! : `${s.facebook ?? a.titel}\n\n${link}`
  await anlegen({ platforms: ['facebook'], content: fb, scheduled_for: zeitMeta.toISOString(), image_url: null, image_urls: [], news_source: null }, 'Facebook')
  if ((s.instagram ?? '').trim() && bild) {
    await anlegen({ platforms: ['instagram'], content: s.instagram, scheduled_for: zeitMeta.toISOString(), image_url: bild, image_urls: [bild], news_source: null }, 'Instagram')
  }
  return ids
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const caller = await authorizeCaller(req, { cron: true, cronKey: 'BLOG_AUTOPILOT_SECRET', service: true }, CORS)
  if (caller instanceof Response) return caller

  const sb = sbAdmin()
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const aktion = String(body.aktion ?? '')

  try {
    if (aktion === 'vorrat') {
      const cfg = await einstellung(sb)
      const jetzt = new Date().toISOString()
      const { count: ungeprueft } = await sb.from('blog_artikel').select('id', { count: 'exact', head: true }).eq('status', 'ungeprueft')
      const { count: zukunft } = await sb.from('blog_artikel').select('id', { count: 'exact', head: true })
        .in('status', ['freigegeben', 'geplant']).gt('geplant_fuer', jetzt)
      const { data: slugs } = await sb.from('blog_artikel').select('slug, thema_id, status')
      return json({ ok: true, ungeprueft: ungeprueft ?? 0, zukunft: zukunft ?? 0, autobetrieb: cfg.enabled === true,
        ziel: cfg.vorrat ?? 4, vorhanden: slugs ?? [] })
    }

    if (aktion === 'bild') {
      const name = String(body.name ?? '').replace(/[^a-z0-9._-]/gi, '-').slice(0, 120)
      const typ = String(body.typ ?? 'image/jpeg')
      if (!name || !/^image\/(jpeg|png)$/.test(typ)) return json({ error: 'name oder typ ungültig' }, 400)
      const roh = Uint8Array.from(atob(String(body.base64 ?? '')), c => c.charCodeAt(0))
      if (roh.length < 1000 || roh.length > 5_000_000) return json({ error: 'Bildgröße ungültig' }, 400)
      const pfad = `social/blog/${name}`
      const { error } = await sb.storage.from(BUCKET).upload(pfad, roh, { contentType: typ, upsert: true, cacheControl: '31536000' })
      if (error) throw new Error(error.message)
      return json({ ok: true, url: `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/${BUCKET}/${pfad}` })
    }

    if (aktion === 'einliefern') {
      const a = (body.artikel ?? {}) as Record<string, unknown>
      if (!a.titel || !a.slug) return json({ error: 'titel und slug fehlen' }, 400)
      const { data: doppelt } = await sb.from('blog_artikel').select('id, status').eq('slug', a.slug as string)
        .neq('status', 'abgelehnt').maybeSingle()
      if (doppelt) return json({ ok: true, id: (doppelt as { id: string }).id, doppelt: true })
      const felder = {
        titel: a.titel, slug: a.slug, thema_id: a.thema_id ?? null, lauf: a.lauf ?? null, anriss: a.anriss ?? null,
        vorschau_html: a.vorschau_html ?? null, beitragsbild_url: a.beitragsbild_url ?? null,
        wp_post_id: a.wp_post_id ?? null, punkte: a.punkte ?? {}, bericht_md: a.bericht_md ?? null,
        social: a.social ?? {}, kosten_usd: a.kosten_usd ?? null,
      }
      const { data, error } = await sb.from('blog_artikel').insert(felder).select('id').single()
      if (error) throw new Error(error.message)
      const id = (data as { id: string }).id
      const cfg = await einstellung(sb)
      // Autobetrieb nur für Artikel mit voller Punktzahl der Chefredaktion (auto_ok); knappe
      // Artikel bleiben immer zur Prüfung liegen.
      if (cfg.enabled === true && a.auto_ok !== false) {
        const { data: termin } = await sb.rpc('blog_naechster_termin')
        await sb.from('blog_artikel').update({ status: 'freigegeben', geplant_fuer: termin, freigegeben_am: new Date().toISOString(),
          updated_at: new Date().toISOString() }).eq('id', id)
        return json({ ok: true, id, status: 'freigegeben', geplant_fuer: termin })
      }
      return json({ ok: true, id, status: 'ungeprueft' })
    }

    if (aktion === 'faellig') {
      const { data: einplanen } = await sb.from('blog_artikel')
        .select('id, titel, slug, wp_post_id, geplant_fuer').eq('status', 'freigegeben').order('geplant_fuer')
      const { data: pruefen } = await sb.from('blog_artikel')
        .select('id, titel, slug, wp_post_id, geplant_fuer').eq('status', 'geplant').lt('geplant_fuer', new Date().toISOString())
      return json({ ok: true, einplanen: einplanen ?? [], pruefen: pruefen ?? [] })
    }

    if (aktion === 'markieren') {
      const id = String(body.id ?? '')
      const status = String(body.status ?? '')
      if (!['geplant', 'veroeffentlicht', 'fehler'].includes(status)) return json({ error: 'status ungültig' }, 400)
      const { data: row } = await sb.from('blog_artikel').select('*').eq('id', id).maybeSingle()
      if (!row) return json({ error: 'nicht gefunden' }, 404)
      const a = row as Artikel
      const link = String(body.wp_link ?? a.wp_link ?? '')
      const upd: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
      if (link) upd.wp_link = link
      if (status === 'fehler') upd.fehler = String(body.fehler ?? '').slice(0, 2000)
      if (status === 'geplant') {
        if (a.status !== 'freigegeben' && a.status !== 'geplant') return json({ error: `Status ${a.status} kann nicht eingeplant werden` }, 409)
        upd.social_post_ids = await socialPlanen(sb, a, link)
      }
      const { error } = await sb.from('blog_artikel').update(upd).eq('id', id)
      if (error) throw new Error(error.message)
      return json({ ok: true, social_post_ids: upd.social_post_ids ?? a.social_post_ids })
    }

    return json({ error: 'unbekannte Aktion' }, 400)
  } catch (e) {
    console.error('[blog-autopilot]', aktion, e)
    return json({ error: String((e as Error).message ?? e) }, 500)
  }
})
