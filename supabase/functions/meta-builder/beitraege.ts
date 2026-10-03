// meta-builder: vorhandene Beiträge und teilbare Vorschau (nur Lesen).
//
//   posts_list        Beiträge der Facebook-Seite (GET /{page}/posts, Seiten-Token) bzw. Medien des
//                     Instagram-Kontos (GET /{ig}/media, Seiten-Token) für „Vorhandenen Beitrag
//                     verwenden“. Bewerbbar-Kennzeichen tolerant: kennt Meta das Feld nicht, ein
//                     zweiter Versuch ohne es (bewerbbar = null).
//   ad_vorschau_link  Feld preview_shareable_link einer bestehenden Anzeige (eigenes Werbekonto).
//
// Seiten-Token nur im Speicher, nie in Logs oder Antworten (pages.ts).

import { graphGet, MetaApiError } from '../_shared/metaGraph.ts'
import type {
  AdVorschauLinkRequest, AdVorschauLinkResponse, BeitragQuelle, PostsListItem, PostsListRequest, PostsListResponse,
} from '../_shared/metaSpec.ts'
import { pageInstagram } from './catalog.ts'
import { arr, BuilderError, digits, fromMetaError, metaId, num, obj, str, type Ctx, type Raw } from './common.ts'
import { pageAccessToken, pageFetch } from './pages.ts'

const TEXT_MAX = 280
const FB_FELDER = 'id,message,created_time,permalink_url,full_picture,status_type,is_eligible_for_promotion'
const FB_FELDER_MIN = 'id,message,created_time,permalink_url,full_picture,status_type'
// boost_eligibility_info: Instagram-Feld „kann beworben werden“ (API-Pfad ungeprüft, sonst ohne)
const IG_FELDER = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,boost_eligibility_info'
const IG_FELDER_MIN = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp'

const httpsOrNull = (v: unknown): string | null => {
  const s = str(v).trim()
  return /^https:\/\//i.test(s) ? s : null
}
const kurz = (v: unknown): string => {
  const s = str(v).replace(/\s+/g, ' ').trim()
  return s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 3)}...` : s
}

/** Liste mit Feldern; lehnt Meta ein Zusatzfeld ab (#100), noch einmal mit den Grundfeldern. */
async function liste(path: string, token: string, felder: string, felderMin: string, extra: Raw, warnings: string[]): Promise<{ data: Raw[]; next: string | null; voll: boolean }> {
  const run = async (fields: string) => {
    const j = await pageFetch<Raw>('GET', path, token, { fields, ...extra }, 25_000)
    const cursor = str(obj(obj(j.paging).cursors).after)
    const hatNext = !!str(obj(j.paging).next)
    return { data: arr<Raw>(j.data), next: hatNext && cursor ? cursor : null }
  }
  try {
    return { ...(await run(felder)), voll: true }
  } catch (err) {
    if (!(err instanceof MetaApiError) || err.kind !== 'validation') throw err
    warnings.push('Meta kennt das Feld „bewerbbar“ hier nicht; ob ein Beitrag beworben werden kann, zeigt erst die Prüfung.')
    return { ...(await run(felderMin)), voll: false }
  }
}

export async function modePostsList(ctx: Ctx, req: PostsListRequest): Promise<PostsListResponse> {
  if (req.quelle !== 'facebook' && req.quelle !== 'instagram') throw new BuilderError(400, 'invalid_request', 'quelle muss "facebook" oder "instagram" sein.')
  const quelle: BeitragQuelle = req.quelle
  const st = await ctx.settings()
  const pageId = req.page_id ? metaId(req.page_id, 'page_id') : (st.default_page_id || ctx.env.pageId)
  const limit = Math.max(1, Math.min(50, Math.round(num(req.limit) ?? 25)))
  const after = str(req.after).trim()
  if (after && !/^[A-Za-z0-9_=-]{1,500}$/.test(after)) throw new BuilderError(400, 'invalid_request', 'Ungültiger Blätter-Cursor (after).')
  const warnings: string[] = []
  let token: string | null
  try {
    token = await pageAccessToken(pageId)
  } catch (err) {
    throw err instanceof MetaApiError ? fromMetaError(err, 'Seiten-Zugang') : err
  }
  if (!token) {
    throw new BuilderError(409, 'forbidden', 'Für diese Seite gibt es keinen Seiten-Zugang am System-User.',
      'Im Business Manager dem System-User die Seite zuweisen (Recht pages_show_list und pages_read_engagement).')
  }
  const extra: Raw = { limit, ...(after ? { after } : {}) }
  try {
    if (quelle === 'facebook') {
      const r = await liste(`${pageId}/posts`, token, FB_FELDER, FB_FELDER_MIN, extra, warnings)
      const items: PostsListItem[] = r.data.filter(p => /^[0-9]+_[0-9]+$/.test(str(p.id))).map(p => ({
        id: str(p.id),
        quelle,
        text: kurz(p.message),
        erstellt: str(p.created_time) || null,
        permalink: httpsOrNull(p.permalink_url),
        bild_url: httpsOrNull(p.full_picture),
        typ: str(p.status_type) || null,
        bewerbbar: r.voll && typeof p.is_eligible_for_promotion === 'boolean' ? p.is_eligible_for_promotion : null,
      }))
      return { quelle, page_id: pageId, instagram_user_id: null, items, next: r.next, warnings }
    }
    let ig = req.instagram_user_id ? metaId(req.instagram_user_id, 'instagram_user_id') : (st.default_ig_user_id ?? '')
    if (!ig) ig = (await pageInstagram(pageId))?.id ?? ''
    if (!ig) {
      throw new BuilderError(409, 'not_found', 'Mit dieser Seite ist kein Instagram-Konto verbunden.',
        'Instagram-Konto im Business Manager mit der Facebook-Seite verbinden.')
    }
    const r = await liste(`${digits(ig)}/media`, token, IG_FELDER, IG_FELDER_MIN, extra, warnings)
    const items: PostsListItem[] = r.data.filter(m => /^[0-9]+$/.test(str(m.id))).map(m => {
      const be = obj(m.boost_eligibility_info)
      const typ = str(m.media_product_type) === 'REELS' ? 'REELS' : str(m.media_type)
      return {
        id: str(m.id),
        quelle,
        text: kurz(m.caption),
        erstellt: str(m.timestamp) || null,
        permalink: httpsOrNull(m.permalink),
        // Videos/Reels: Vorschaubild, Bilder: das Bild selbst
        bild_url: httpsOrNull(m.thumbnail_url) ?? (str(m.media_type) === 'VIDEO' ? null : httpsOrNull(m.media_url)),
        typ: typ || null,
        bewerbbar: r.voll && typeof be.eligible_to_boost === 'boolean' ? be.eligible_to_boost : null,
      }
    })
    return { quelle, page_id: pageId, instagram_user_id: digits(ig), items, next: r.next, warnings }
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.kind === 'permission') {
        throw new BuilderError(403, 'forbidden', quelle === 'instagram'
          ? 'Meta erlaubt das Lesen der Instagram-Beiträge nicht (Recht instagram_basic fehlt dem Zugang).'
          : 'Meta erlaubt das Lesen der Seiten-Beiträge nicht (Recht pages_read_engagement fehlt dem Zugang).',
        'Recht beim System-User im Business Manager ergänzen und den Token neu erzeugen.')
      }
      throw fromMetaError(err, 'Beiträge laden')
    }
    throw err
  }
}

export async function modeAdVorschauLink(ctx: Ctx, req: AdVorschauLinkRequest): Promise<AdVorschauLinkResponse> {
  const adId = metaId(req.ad_id, 'ad_id')
  let j: Raw
  try {
    j = await graphGet<Raw>(adId, { fields: 'id,name,account_id,preview_shareable_link' })
  } catch (err) {
    throw err instanceof MetaApiError ? fromMetaError(err, 'Vorschaulink') : err
  }
  if (digits(j.account_id) !== ctx.env.account) throw new BuilderError(403, 'forbidden', 'Die Anzeige gehört nicht zu unserem Werbekonto.')
  const link = httpsOrNull(j.preview_shareable_link)
  return {
    ad_id: adId,
    name: str(j.name) || null,
    link,
    hinweis: link
      ? 'Link von Meta: zeigt die Anzeige allen, die ihn haben, auch ohne Login. Nur an Kollegen oder Partner weitergeben.'
      : 'Meta liefert für diese Anzeige keinen teilbaren Vorschaulink.',
  }
}
