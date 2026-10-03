// meta-builder: Medien (media_upload, media_status) und „Medium bereit machen“
// für create/preview.
//
// Bilder: nur aus dem eigenen öffentlichen Bucket ad-creatives (SSRF-Schutz:
// der Server lädt nie fremde URLs), sha256 gegen Doppel-Uploads, Seitenverhältnis
// aus dem Dateikopf, dann POST act_X/adimages -> image_hash.
// Videos: POST act_X/advideos mit file_url (Meta holt die Datei selbst), danach
// Status-Abfrage bis ready; Vorschaubild = bevorzugtes Meta-Thumbnail, als Bild
// hochgeladen -> thumbnail_hash. Videos werden NICHT in die Function geladen
// (zu groß), deshalb ist ihr sha256 ein Fingerabdruck aus Pfad und Größe.
//
// Runde 2: video_vorschaubilder (Metas Vorschläge lesen), video_vorschaubild (Vorschlag als Bild
// in die Bibliothek laden -> thumbnail_hash für MediaRef bzw. als Standard des Videos),
// video_untertitel (SRT aus dem Bucket an POST /{video_id}/captions; API-Pfad für
// Werbekonto-Videos ungeprüft, Fehler kommen mit Hinweis zurück).

import { GRAPH, graphGet, metaEnv, metaErrorFromBody, MetaApiError, metaWritesDisabled, uploadImage } from '../_shared/metaGraph.ts'
import {
  aspectOf, UNTERTITEL_SPRACHEN, type MediaAspect, type MediaStatusRequest, type MediaStatusResponse, type MediaUploadRequest,
  type MediaUploadResponse, type MetaMediaRow, type UntertitelSprache, type VideoThumbnail, type VideoUntertitelRequest,
  type VideoUntertitelResponse, type VideoVorschaubilderRequest, type VideoVorschaubilderResponse, type VideoVorschaubildRequest,
  type VideoVorschaubildResponse,
} from '../_shared/metaSpec.ts'
import {
  arr, BUCKET, BuilderError, errText, fromMetaError, isUuid, logWrite, metaPost, num, obj, publicUrl, sha256Hex,
  str, uuidParam, writeGate, type Ctx,
} from './common.ts'

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_THUMB_BYTES = 8 * 1024 * 1024
/** So lange nach „Video fertig“ auf Metas Vorschaubild warten, danach Fehler statt Pause */
const THUMB_WAIT_MS = 15 * 60_000
const ASPECTS: readonly MediaAspect[] = ['4:5', '9:16', '1:1', '1.91:1', 'other']
/** Mindestbreite je Format laut Ads Guide (Feed 600 x 750, Stories 500 breit) */
const MIN_WIDTH: Partial<Record<MediaAspect, number>> = { '4:5': 600, '1:1': 600, '9:16': 500, '1.91:1': 600 }

// ── Bildgröße aus dem Dateikopf ──────────────────────────────────────────────

export interface ImageInfo { width: number; height: number; type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }

export function imageSize(b: Uint8Array): ImageInfo | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1]
  const u16le = (i: number) => b[i] | (b[i + 1] << 8)
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(16), height: u32be(20), type: 'image/png' }
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: u16le(6), height: u16le(8), type: 'image/gif' }
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1, type: 'image/webp' }
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'image/webp' }
    }
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff, type: 'image/webp' }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]
      if (marker === 0xff) { i++; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      if (marker === 0xd9 || marker === 0xda) break
      const len = u16be(i + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return { width: u16be(i + 7), height: u16be(i + 5), type: 'image/jpeg' }
      if (len < 2) break
      i += 2 + len
    }
    return null
  }
  return null
}

// ── Speicher ─────────────────────────────────────────────────────────────────

/** Pfad im Bucket ad-creatives (ohne Bucket-Präfix), sonst BuilderError 400. */
export function cleanStoragePath(v: unknown): string {
  let p = str(v).trim().replace(/^\/+/, '')
  if (p.startsWith(`${BUCKET}/`)) p = p.slice(BUCKET.length + 1)
  if (!p || p.length > 300 || p.includes('..') || p.includes('//') || !/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(p)) {
    throw new BuilderError(400, 'invalid_request', 'Ungültiger Speicherpfad. Erlaubt sind nur Dateien im Bucket ad-creatives (z. B. builder/<uuid>.jpg).')
  }
  return p
}

const EXT_TYPE: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

async function downloadImage(ctx: Ctx, path: string): Promise<{ bytes: Uint8Array; type: string; info: ImageInfo }> {
  const { data, error } = await ctx.sb.storage.from(BUCKET).download(path)
  if (error || !data) {
    throw new BuilderError(404, 'not_found', `Datei ${path} im Speicher nicht gefunden.`, 'Erst hochladen (Bucket ad-creatives), dann erneut versuchen.')
  }
  const blob = data as Blob
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.length > MAX_IMAGE_BYTES) throw new BuilderError(400, 'invalid_request', 'Bild größer als 30 MB.')
  const info = imageSize(bytes)
  if (!info) throw new BuilderError(400, 'invalid_request', 'Kein unterstütztes Bildformat (JPG, PNG, GIF, WebP).')
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const type = (blob.type || '').startsWith('image/') ? blob.type : (EXT_TYPE[ext] ?? info.type)
  return { bytes, type, info }
}

async function videoSize(ctx: Ctx, path: string): Promise<number | null> {
  try {
    const i = path.lastIndexOf('/')
    const dir = i >= 0 ? path.slice(0, i) : ''
    const file = i >= 0 ? path.slice(i + 1) : path
    const { data } = await ctx.sb.storage.from(BUCKET).list(dir, { search: file, limit: 10 })
    const hit = arr<{ name?: string; metadata?: { size?: number } }>(data).find(x => x?.name === file)
    const size = hit?.metadata?.size
    return typeof size === 'number' && size > 0 ? size : null
  } catch {
    return null
  }
}

async function mediaBySha(ctx: Ctx, sha: string): Promise<MetaMediaRow | null> {
  const { data, error } = await ctx.sb.from('meta_media').select('*').eq('sha256', sha).maybeSingle()
  if (error) throw new BuilderError(500, 'internal', `meta_media lesen: ${String(error.message ?? error).slice(0, 200)}`)
  return (data as MetaMediaRow | null) ?? null
}

async function mediaById(ctx: Ctx, id: string): Promise<MetaMediaRow> {
  const { data, error } = await ctx.sb.from('meta_media').select('*').eq('id', id).maybeSingle()
  if (error) throw new BuilderError(500, 'internal', `meta_media lesen: ${String(error.message ?? error).slice(0, 200)}`)
  if (!data) throw new BuilderError(404, 'not_found', 'Medium nicht gefunden.')
  return data as MetaMediaRow
}

async function updateMedia(ctx: Ctx, id: string, patch: Record<string, unknown>): Promise<MetaMediaRow> {
  const { data, error } = await ctx.sb.from('meta_media').update(patch).eq('id', id).select('*').maybeSingle()
  if (error) throw new BuilderError(500, 'internal', `meta_media speichern: ${String(error.message ?? error).slice(0, 200)}`)
  return data as MetaMediaRow
}

async function insertMedia(ctx: Ctx, row: Record<string, unknown>, sha: string): Promise<MetaMediaRow> {
  const { data, error } = await ctx.sb.from('meta_media').insert(row).select('*').maybeSingle()
  if (!error && data) return data as MetaMediaRow
  // gleichzeitiger Upload derselben Datei: Zeile des anderen Aufrufs nehmen
  if (error && String(error.code ?? '') === '23505') {
    const again = await mediaBySha(ctx, sha)
    if (again) return again
  }
  throw new BuilderError(500, 'internal', `meta_media anlegen: ${String(error?.message ?? error).slice(0, 200)}`)
}

/** Bild-Upload mit Protokoll; gibt den image_hash zurück. */
async function uploadLogged(ctx: Ctx, bytes: Uint8Array, type: string, name: string, draftId?: string | null): Promise<string> {
  const path = `act_${ctx.env.account}/adimages`
  try {
    const hash = await uploadImage(ctx.env.account, bytes, type, name)
    await logWrite(ctx, { level: 'media', path, entityId: hash, draftId, request: { name, content_type: type, bytes: bytes.length }, after: { hash } })
    return hash
  } catch (err) {
    await logWrite(ctx, { level: 'media', path, draftId, request: { name, content_type: type, bytes: bytes.length }, err })
    throw err
  }
}

const mediaErrorText = (err: unknown): string =>
  err instanceof MetaApiError ? (err.userMsg || err.message).slice(0, 300) : errText(err).slice(0, 300)

// ── media_upload ─────────────────────────────────────────────────────────────

export async function modeMediaUpload(ctx: Ctx, req: MediaUploadRequest): Promise<MediaUploadResponse> {
  const path = cleanStoragePath(req.storage_path)
  const kind = req.kind === 'video' ? 'video' : req.kind === 'image' ? 'image' : null
  if (!kind) throw new BuilderError(400, 'invalid_request', 'kind muss "image" oder "video" sein.')
  const wanted: MediaAspect = (ASPECTS as readonly string[]).indexOf(str(req.aspect)) >= 0 ? req.aspect : 'other'
  const flags = {
    ai_generated: req.ai_generated === true,
    eu_band_confirmed: req.eu_band_confirmed === true,
    ki_label_confirmed: req.ki_label_confirmed === true,
  }
  const url = publicUrl(path)

  if (kind === 'image') {
    const { bytes, type, info } = await downloadImage(ctx, path)
    const actual = aspectOf(info.width, info.height)
    if (wanted !== 'other' && actual !== wanted) {
      throw new BuilderError(400, 'invalid_request',
        `Seitenverhältnis passt nicht: erwartet ${wanted}, die Datei hat ${info.width} x ${info.height} (${actual === 'other' ? 'anderes Format' : actual}).`,
        'Für Feeds 4:5 (1440 x 1800), für Stories und Reels 9:16 (1440 x 2560).')
    }
    const minW = MIN_WIDTH[actual]
    if (minW && info.width < minW) {
      throw new BuilderError(400, 'invalid_request', `Bild zu klein: ${info.width} Pixel breit, Meta verlangt mindestens ${minW}.`,
        'Empfohlen: 1440 x 1800 (4:5) bzw. 1440 x 2560 (9:16).')
    }
    const sha = await sha256Hex(bytes)
    let row = await mediaBySha(ctx, sha)
    if (row) {
      const upgrade: Record<string, unknown> = {}
      if (flags.eu_band_confirmed && !row.eu_band_confirmed) upgrade.eu_band_confirmed = true
      if (flags.ki_label_confirmed && !row.ki_label_confirmed) upgrade.ki_label_confirmed = true
      if (flags.ai_generated && !row.ai_generated) upgrade.ai_generated = true
      if (Object.keys(upgrade).length) row = await updateMedia(ctx, row.id, upgrade)
      if (row.meta_image_hash && row.meta_status === 'ready') return { media: row, deduplicated: true }
    } else {
      row = await insertMedia(ctx, {
        kind: 'image', storage_path: path, public_url: url, aspect: actual, width: info.width, height: info.height,
        bytes: bytes.length, sha256: sha, meta_status: 'uploading', ...flags, source: 'builder', created_by: ctx.caller.userId,
      }, sha)
      if (row.meta_image_hash && row.meta_status === 'ready') return { media: row, deduplicated: true }
    }
    try {
      // neutraler Dateiname bei Meta (nie Projekt- oder Bauträgernamen)
      const hash = await uploadLogged(ctx, bytes, type, `hp-${sha.slice(0, 16)}`)
      return { media: await updateMedia(ctx, row.id, { meta_image_hash: hash, meta_status: 'ready', meta_error: null }) }
    } catch (err) {
      await updateMedia(ctx, row.id, { meta_status: 'error', meta_error: mediaErrorText(err) })
      throw err instanceof MetaApiError ? fromMetaError(err, 'Bild-Upload zu Meta') : err
    }
  }

  // Video
  const size = await videoSize(ctx, path)
  const sha = await sha256Hex(`video:${path}:${size ?? ''}`)
  let row = await mediaBySha(ctx, sha)
  if (row?.meta_video_id) return { media: row, deduplicated: true }
  if (!row) {
    row = await insertMedia(ctx, {
      kind: 'video', storage_path: path, public_url: url, aspect: wanted, bytes: size, sha256: sha,
      meta_status: 'uploading', ...flags, source: 'builder', created_by: ctx.caller.userId,
    }, sha)
  }
  const started = await startVideoUpload(ctx, row)
  return { media: started }
}

async function startVideoUpload(ctx: Ctx, row: MetaMediaRow, draftId?: string | null): Promise<MetaMediaRow> {
  const fileUrl = row.public_url || publicUrl(row.storage_path)
  try {
    const res = await metaPost<{ id?: string }>(ctx, `act_${ctx.env.account}/advideos`,
      { file_url: fileUrl, name: `hp-video-${row.sha256.slice(0, 12)}` },
      { level: 'media', draftId, timeoutMs: 90_000 })
    const vid = str(res?.id)
    if (!vid) throw new BuilderError(502, 'meta_error', 'Meta hat keine Video-ID zurückgegeben.')
    return await updateMedia(ctx, row.id, { meta_video_id: vid, meta_status: 'processing', meta_error: null })
  } catch (err) {
    await updateMedia(ctx, row.id, { meta_status: 'error', meta_error: mediaErrorText(err) })
    throw err instanceof MetaApiError ? fromMetaError(err, 'Video-Upload zu Meta') : err
  }
}

// ── Video-Status + Vorschaubild ──────────────────────────────────────────────

async function pollVideo(ctx: Ctx, row: MetaMediaRow): Promise<MetaMediaRow> {
  if (!row.meta_video_id) return row
  const j = await graphGet<Record<string, unknown>>(row.meta_video_id, { fields: 'status' })
  const st = obj(j.status)
  const vs = str(st.video_status)
  if (vs === 'ready') {
    return row.meta_status === 'ready' ? row : await updateMedia(ctx, row.id, { meta_status: 'ready', meta_error: null })
  }
  if (vs === 'error') {
    const detail = str(obj(st.processing_phase).status) || 'Meta meldet einen Verarbeitungsfehler'
    return await updateMedia(ctx, row.id, { meta_status: 'error', meta_error: detail.slice(0, 300) })
  }
  return row.meta_status === 'processing' ? row : await updateMedia(ctx, row.id, { meta_status: 'processing' })
}

const THUMB_HOST = /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com)$/i

/** Nur Metas eigene Bild-Server (SSRF-Schutz: nie fremde Adressen laden). */
function metaBildUri(uri: string): boolean {
  let host = ''
  try { host = new URL(uri).hostname } catch { host = '' }
  return uri.startsWith('https://') && THUMB_HOST.test(host)
}

/** Metas Vorschaubild-Vorschläge eines Videos (GET /{video_id}/thumbnails). */
async function videoThumbnails(videoId: string): Promise<VideoThumbnail[]> {
  const j = await graphGet<{ data?: Array<Record<string, unknown>> }>(`${videoId}/thumbnails`, { fields: 'uri,is_preferred,width,height' })
  return arr<Record<string, unknown>>(j?.data)
    .map(t => ({ uri: str(t.uri), width: num(t.width), height: num(t.height), is_preferred: t.is_preferred === true }))
    .filter(t => metaBildUri(t.uri))
}

/** Vorschaubild von Metas Server laden (nur fbcdn/facebook, höchstens 8 MB); null = nicht ladbar. */
async function ladeMetaBild(uri: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (!metaBildUri(uri)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(uri, { signal: ctrl.signal })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim() || 'image/jpeg'
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_THUMB_BYTES || !type.startsWith('image/')) return null
    return { bytes, type }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Bevorzugtes Meta-Thumbnail als Bild hochladen -> thumbnail_hash (Schreibzugriff). */
async function ensureVideoThumbnail(ctx: Ctx, row: MetaMediaRow, draftId?: string | null): Promise<MetaMediaRow> {
  if (row.thumbnail_hash || !row.meta_video_id) return row
  const list = await videoThumbnails(row.meta_video_id)
  const pick = list.find(t => t.is_preferred) ?? list[0]
  if (!pick) return row
  const bild = await ladeMetaBild(pick.uri)
  if (!bild) return row
  const hash = await uploadLogged(ctx, bild.bytes, bild.type, `hp-thumb-${row.meta_video_id}`, draftId)
  return await updateMedia(ctx, row.id, { thumbnail_hash: hash })
}

// ── media_status ─────────────────────────────────────────────────────────────

export async function modeMediaStatus(ctx: Ctx, req: MediaStatusRequest): Promise<MediaStatusResponse> {
  const id = uuidParam(req.id, 'id')
  let row = await mediaById(ctx, id)
  if (row.kind === 'video' && row.meta_video_id && row.meta_status !== 'error') {
    row = await pollVideo(ctx, row)
    // Vorschaubild hochladen ist ein Schreibzugriff: nur wenn der Schreibweg offen ist
    if (row.meta_status === 'ready' && !row.thumbnail_hash && (await writeGate(ctx)) === null) {
      try { row = await ensureVideoThumbnail(ctx, row) } catch (err) { console.warn('[meta-builder] Vorschaubild:', mediaErrorText(err)) }
    }
  }
  return { media: row }
}

// ── Medium für create/preview bereit machen ──────────────────────────────────

export interface MediaReadiness { row: MetaMediaRow; ready: boolean; reason?: 'processing' | 'error' | 'missing' | 'thumbnail' }

/**
 * Fertige Videos ohne Vorschaubild: Thumbnail nachholen (für validate/preview/create).
 * Schreibzugriff, deshalb nur bei offenem Schreibweg; best effort, höchstens 4 je Aufruf.
 * Aktualisiert rows an Ort und Stelle.
 */
export async function retryVideoThumbnails(ctx: Ctx, rows: Record<string, MetaMediaRow>, draftId?: string | null): Promise<void> {
  const todo = Object.keys(rows).map(k => rows[k])
    .filter(r => r.kind === 'video' && !!r.meta_video_id && r.meta_status === 'ready' && !r.thumbnail_hash).slice(0, 4)
  if (!todo.length || (await writeGate(ctx)) !== null) return
  for (const r of todo) {
    try { rows[r.id] = await ensureVideoThumbnail(ctx, r, draftId) } catch (err) { console.warn('[meta-builder] Vorschaubild:', mediaErrorText(err)) }
  }
}

/**
 * Bild ohne Hash -> jetzt hochladen; Video ohne ID -> Upload starten; Video in
 * Verarbeitung -> Status abfragen; fertiges Video ohne Vorschaubild -> Thumbnail.
 * Nur aus Schreib-Modi aufrufen (lädt bei Bedarf zu Meta hoch).
 */
/**
 * Medium bei Meta fertig machen. eigenesVorschaubild = jede Verwendung des Videos hat ein eigenes
 * Vorschaubild (Upload oder gewählter Meta-Vorschlag): dann nicht auf Metas Standardbild warten.
 */
export async function ensureMediaReady(ctx: Ctx, mediaId: string, draftId?: string | null, eigenesVorschaubild = false): Promise<MediaReadiness> {
  if (!isUuid(mediaId)) throw new BuilderError(400, 'invalid_request', `Ungültige Medien-ID ${mediaId}.`)
  let row = await mediaById(ctx, mediaId)
  if (row.kind === 'image') {
    if (row.meta_image_hash) return { row, ready: true }
    const { bytes, type } = await downloadImage(ctx, row.storage_path)
    try {
      const hash = await uploadLogged(ctx, bytes, type, `hp-${row.sha256.slice(0, 16)}`, draftId)
      row = await updateMedia(ctx, row.id, { meta_image_hash: hash, meta_status: 'ready', meta_error: null })
      return { row, ready: true }
    } catch (err) {
      await updateMedia(ctx, row.id, { meta_status: 'error', meta_error: mediaErrorText(err) })
      throw err
    }
  }
  if (!row.meta_video_id) {
    row = await startVideoUpload(ctx, row, draftId)
    return { row, ready: false, reason: 'processing' }
  }
  if (row.meta_status !== 'ready') row = await pollVideo(ctx, row)
  if (row.meta_status === 'error') return { row, ready: false, reason: 'error' }
  if (row.meta_status !== 'ready') return { row, ready: false, reason: 'processing' }
  if (!row.thumbnail_hash && !eigenesVorschaubild) {
    try { row = await ensureVideoThumbnail(ctx, row, draftId) } catch (err) { console.warn('[meta-builder] Vorschaubild:', mediaErrorText(err)) }
    // Ohne Vorschaubild kein Creative (Meta verlangt es): erst warten, nach THUMB_WAIT_MS Fehler
    if (!row.thumbnail_hash) {
      const since = Date.parse(str(row.updated_at))
      const waitedTooLong = Number.isFinite(since) && Date.now() - since > THUMB_WAIT_MS
      return { row, ready: false, reason: waitedTooLong ? 'thumbnail' : 'processing' }
    }
  }
  return { row, ready: true }
}

// ── Video: Vorschaubild wählen, Untertitel ───────────────────────────────────

async function videoRow(ctx: Ctx, mediaId: unknown): Promise<MetaMediaRow & { meta_video_id: string }> {
  const row = await mediaById(ctx, uuidParam(mediaId, 'media_id'))
  if (row.kind !== 'video') throw new BuilderError(400, 'invalid_request', 'Das Medium ist kein Video.')
  if (!row.meta_video_id) {
    throw new BuilderError(409, 'media_not_ready', 'Das Video ist noch nicht bei Meta.', 'Erst hochladen (media_upload), dann erneut versuchen.')
  }
  return row as MetaMediaRow & { meta_video_id: string }
}

/** video_vorschaubilder: Metas Vorschläge (nur Lesen). */
export async function modeVideoVorschaubilder(ctx: Ctx, req: VideoVorschaubilderRequest): Promise<VideoVorschaubilderResponse> {
  const row = await mediaById(ctx, uuidParam(req.media_id, 'media_id'))
  if (row.kind !== 'video') throw new BuilderError(400, 'invalid_request', 'Das Medium ist kein Video.')
  if (!row.meta_video_id) return { media_id: row.id, video_id: null, vorschaubilder: [] }
  try {
    return { media_id: row.id, video_id: row.meta_video_id, vorschaubilder: await videoThumbnails(row.meta_video_id) }
  } catch (err) {
    throw err instanceof MetaApiError ? fromMetaError(err, 'Vorschaubilder laden') : err
  }
}

/**
 * video_vorschaubild: einen Vorschlag als Bild in die Bildbibliothek laden. Die uri muss in Metas
 * aktueller Liste des Videos stehen (keine beliebigen Adressen). Ergebnis: thumbnail_hash für die
 * MediaRef (thumbnail_quelle 'meta_liste'), mit als_standard auch für das Video in meta_media.
 */
export async function modeVideoVorschaubild(ctx: Ctx, req: VideoVorschaubildRequest): Promise<VideoVorschaubildResponse> {
  const row = await videoRow(ctx, req.media_id)
  const uri = str(req.uri).trim()
  let list: VideoThumbnail[]
  try { list = await videoThumbnails(row.meta_video_id) } catch (err) {
    throw err instanceof MetaApiError ? fromMetaError(err, 'Vorschaubilder laden') : err
  }
  if (!uri || !list.some(t => t.uri === uri)) {
    throw new BuilderError(400, 'invalid_request', 'Dieses Vorschaubild gehört nicht (mehr) zum Video.', 'Vorschaubilder neu laden und erneut wählen (Meta-Adressen gelten nur kurz).')
  }
  const bild = await ladeMetaBild(uri)
  if (!bild) throw new BuilderError(502, 'meta_error', 'Das Vorschaubild ließ sich bei Meta nicht laden.', 'In einer Minute erneut versuchen.')
  let hash: string
  try {
    hash = await uploadLogged(ctx, bild.bytes, bild.type, `hp-thumb-${row.meta_video_id}-wahl`)
  } catch (err) {
    throw err instanceof MetaApiError ? fromMetaError(err, 'Vorschaubild-Upload zu Meta') : err
  }
  const alsStandard = req.als_standard === true
  if (alsStandard) await updateMedia(ctx, row.id, { thumbnail_hash: hash })
  return { media_id: row.id, thumbnail_hash: hash, uri, als_standard: alsStandard }
}

const MAX_SRT_BYTES = 1024 * 1024
const SRT_ZEIT = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/

/**
 * video_untertitel: SRT-Datei aus dem Bucket ad-creatives an POST /{video_id}/captions
 * (Graph API Video, Felder captions_file mit Dateiname „name.de_DE.srt“ und default_locale).
 * API-Pfad für Werbekonto-Videos nicht bestätigt: lehnt Meta ab, kommt ein Hinweis zurück
 * (Untertitel dann im Werbeanzeigenmanager hochladen oder ins Video brennen).
 */
export async function modeVideoUntertitel(ctx: Ctx, req: VideoUntertitelRequest): Promise<VideoUntertitelResponse> {
  const row = await videoRow(ctx, req.media_id)
  const sprache = str(req.sprache) as UntertitelSprache
  if ((UNTERTITEL_SPRACHEN as readonly string[]).indexOf(sprache) < 0) {
    throw new BuilderError(400, 'invalid_request', `sprache muss ${UNTERTITEL_SPRACHEN.join(', ')} sein.`)
  }
  const path = cleanStoragePath(req.storage_path)
  if (!/\.srt$/i.test(path)) throw new BuilderError(400, 'invalid_request', 'Untertitel bitte als SRT-Datei hochladen (Endung .srt).')
  const { data, error } = await ctx.sb.storage.from(BUCKET).download(path)
  if (error || !data) throw new BuilderError(404, 'not_found', `Datei ${path} im Speicher nicht gefunden.`)
  const bytes = new Uint8Array(await (data as Blob).arrayBuffer())
  if (!bytes.length || bytes.length > MAX_SRT_BYTES) throw new BuilderError(400, 'invalid_request', 'Die SRT-Datei ist leer oder größer als 1 MB.')
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!SRT_ZEIT.test(text)) throw new BuilderError(400, 'invalid_request', 'Das ist keine gültige SRT-Datei (Zeitangaben wie 00:00:01,000 --> 00:00:03,500 fehlen).')
  if (metaWritesDisabled()) {
    throw new BuilderError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).')
  }
  const { token } = metaEnv()
  if (!token) throw new BuilderError(503, 'meta_error', 'Der Meta-Zugang fehlt (Secret META_ACCESS_TOKEN).')
  const videoId = row.meta_video_id
  const ziel = `${videoId}/captions`
  const form = new FormData()
  form.append('captions_file', new Blob([bytes], { type: 'application/x-subrip' }), `hp.${sprache}.srt`)
  if (req.standard === true) form.append('default_locale', sprache)
  const logReq = { sprache, bytes: bytes.length, standard: req.standard === true, storage_path: path }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    let res: Response
    try {
      // Token nur im Authorization-Header (nie in URL oder Log)
      res = await fetch(`${GRAPH}/${ziel}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: ctrl.signal })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      throw new MetaApiError({ status: 0, kind: 'transient', message: aborted ? 'Zeitüberschreitung beim Untertitel-Upload' : 'Netzwerkfehler beim Untertitel-Upload' })
    }
    const raw = await res.text()
    let json: unknown = null
    try { json = raw ? JSON.parse(raw) : null } catch { json = { raw: raw.slice(0, 200) } }
    if (!res.ok || obj(json).error || obj(json).success === false) throw metaErrorFromBody(res.status, json, `HTTP ${res.status}`)
    await logWrite(ctx, { level: 'media', path: ziel, entityId: videoId, request: logReq, after: json })
    return { media_id: row.id, video_id: videoId, sprache, ok: true }
  } catch (err) {
    await logWrite(ctx, { level: 'media', path: ziel, entityId: videoId, request: logReq, err })
    if (err instanceof MetaApiError) {
      if (err.kind === 'permission' || err.kind === 'validation' || err.kind === 'unknown') {
        return {
          media_id: row.id, video_id: videoId, sprache, ok: false,
          hinweis: `Meta hat die Untertitel nicht angenommen (${(err.userMsg || err.message).slice(0, 200)}). Untertitel im Werbeanzeigenmanager hochladen oder ins Video brennen.`,
        }
      }
      throw fromMetaError(err, 'Untertitel-Upload')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
