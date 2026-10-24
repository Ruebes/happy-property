// Blog-Autopilot: Schnittstelle zwischen dem GitHub-Autopiloten (Ruebes/hp-blog-autopilot) und
// der Prüfwarteschlange im Hub (Tabelle blog_artikel, Seite /admin/crm/blog). Sven 24.10.26.
//
// Ablauf:
//   1. Der Autopilot fragt `vorrat` ab und schreibt nach, bis 4 ungeprüfte Artikel bereitliegen
//      (im Autobetrieb: bis 4 Wochen im Voraus eingeplant sind).
//   2. Jeder bestandene Artikel kommt per `einliefern` (WordPress-Entwurf liegt schon an),
//      das Social-Bild vorher per `bild` in ad-creatives/social/blog/.
//   3. Sven gibt im Hub frei (RPC blog_freigeben, nächster Montag 07:00 Zypern).
//      Im Autobetrieb (crm_settings.blog_autopilot.enabled) passiert das hier automatisch.
//   4. Der tägliche Lauf holt `faellig`, plant den Beitrag in WordPress ein und meldet
//      `markieren` status geplant. Dabei entstehen die Social-Posts (status geplant, social-agent
//      postet sie): LinkedIn 08:30, Facebook und Instagram 18:30 am Erscheinungstag (Zypern).
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

/** Uhrzeit am Kalendertag (Zypern) eines Zeitpunkts, als ISO mit richtigem Offset. */
function amSelbenTag(iso: string, hhmm: string): string {
  const d = new Date(iso)
  const teile = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const off = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'longOffset' })
    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00'
  return new Date(`${teile}T${hhmm}:00${off === '' ? '+00:00' : off}`).toISOString()
}

interface Artikel {
  id: string; status: string; titel: string; slug: string; wp_post_id: number | null; wp_link: string | null
  geplant_fuer: string | null; social: { facebook?: string; instagram?: string; linkedin?: string; bild_url?: string }
  social_post_ids: string[]
}

async function socialPlanen(sb: SupabaseClient, a: Artikel, link: string): Promise<string[]> {
  if (!a.geplant_fuer || a.social_post_ids?.length) return a.social_post_ids ?? []
  const s = a.social ?? {}
  const bild = s.bild_url ?? null
  const fb = (s.facebook ?? '').includes(link) ? s.facebook! : `${s.facebook ?? a.titel}\n\n${link}`
  const zeilen = [
    { platforms: ['linkedin'], content: s.linkedin, scheduled_for: amSelbenTag(a.geplant_fuer, '08:30'),
      image_url: bild, image_urls: bild ? [bild] : [], news_source: link, label: 'LinkedIn' },
    { platforms: ['facebook'], content: fb, scheduled_for: amSelbenTag(a.geplant_fuer, '18:30'),
      image_url: null, image_urls: [], news_source: null, label: 'Facebook' },
    { platforms: ['instagram'], content: s.instagram, scheduled_for: amSelbenTag(a.geplant_fuer, '18:30'),
      image_url: bild, image_urls: bild ? [bild] : [], news_source: null, label: 'Instagram' },
  ].filter(z => (z.content ?? '').trim() && (z.platforms[0] !== 'instagram' || bild))
  const ids: string[] = []
  for (const z of zeilen) {
    const { data, error } = await sb.from('social_posts').insert({
      topic: 'blog', title: `📰 Blog · ${z.label} · ${a.titel}`.slice(0, 200), content: z.content,
      platforms: z.platforms, image_url: z.image_url, image_urls: z.image_urls, format: 'single',
      status: 'geplant', scheduled_for: z.scheduled_for, news_source: z.news_source,
    }).select('id').single()
    if (error) {
      // halbe Sachen vermeiden: schon angelegte Posts dieses Artikels wieder entfernen
      if (ids.length) await sb.from('social_posts').delete().in('id', ids)
      throw new Error(`Social-Post ${z.label}: ${error.message}`)
    }
    ids.push((data as { id: string }).id)
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
      if (cfg.enabled === true) {
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
