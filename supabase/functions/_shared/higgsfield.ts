import { Image } from '../_vendor/imagescript/ImageScript.js'
// Zentrale Higgsfield-Anbindung (Bild-KI) für ALLE Edge Functions.
//
// Sven-Entscheidung (11.8.26): Higgsfield ist die EINZIGE Bild- und Video-KI.
// KEIN OpenAI mehr — auch nicht als Fallback.
//
// Läuft über Svens bezahltes Higgsfield-Abo. Auth = OAuth-Session (Clerk) mit
// ROTIERENDEM Refresh-Token; die Tokens liegen änderbar in connector_secrets
// (HIGGSFIELD_ACCESS_TOKEN/_REFRESH_TOKEN/_EXPIRES_AT/_WORKSPACE_ID) und werden
// hier bei Ablauf erneuert + zurückgeschrieben. Diese Session gehört EXKLUSIV
// dem Server; das lokale CLI hat eine eigene.
//
// Damit dieses Modul UNABHÄNGIG von der supabase-js-Version der aufrufenden
// Function bleibt, bekommt es einen kleinen Secret-Store (get/set) übergeben —
// KEINEN konkreten Supabase-Client. Jede Function baut sich den Store aus ihrem
// eigenen Client (siehe hfStore-Adapter in social-agent / studio).
//
// Wichtig für die Dev-API (v2alpha):
//   - Header MUSS 'hf-workspace-id' heissen (NICHT X-Fnf-Workspace-Id).
//   - Referenzbilder ERST hochladen (hfUploadImage) → dann per
//     params.image_references = [{ id }] referenzieren. Rohe URLs gehen nicht.
//   - Bild-Jobtypen u.a.: 'soul_location' (Orte/Objekte, kein Ref),
//     'text2image_soul_v2' (trainierte Persona via custom_reference_id),
//     'flux_kontext' (Bild bearbeiten, behält Vorlage), 'nano_banana'
//     (Multi-Referenz, Gemini).

export interface HfStore {
  get(key: string): Promise<string>
  set(rows: Array<{ key: string; value: string }>): Promise<void>
}

const HF_BASE = 'https://fnf-api-gw.higgsfield.ai/fnf/developer/v2alpha'
const HF_TOKEN_URL = 'https://clerk.higgsfield.ai/oauth/token'
const HF_CLIENT_ID = 'sRGCQJvvJkPrrtRj'

async function hfAuth(store: HfStore): Promise<{ token: string; ws: string }> {
  const ws = await store.get('HIGGSFIELD_WORKSPACE_ID')
  const rt = await store.get('HIGGSFIELD_REFRESH_TOKEN')
  if (!ws || !rt) throw new Error('Higgsfield nicht verbunden (connector_secrets fehlen).')
  const at = await store.get('HIGGSFIELD_ACCESS_TOKEN')
  const exp = Number(await store.get('HIGGSFIELD_EXPIRES_AT') || 0)
  const now = Math.floor(Date.now() / 1000)
  if (at && exp - now > 600) return { token: at, ws }
  // Access-Token (fast) abgelaufen → Refresh. ACHTUNG: rotiert den Refresh-Token,
  // das neue Paar MUSS zurück in connector_secrets.
  const r = await fetch(HF_TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: HF_CLIENT_ID }),
  })
  const td = await r.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!r.ok || !td.access_token) {
    // Eine parallele Instanz kann schon rotiert haben → Secrets neu lesen und
    // deren frisches Token nutzen, statt hart zu scheitern.
    const at2 = await store.get('HIGGSFIELD_ACCESS_TOKEN')
    const exp2 = Number(await store.get('HIGGSFIELD_EXPIRES_AT') || 0)
    if (at2 && at2 !== at && exp2 - now > 60) return { token: at2, ws }
    throw new Error(`Higgsfield-Token-Refresh fehlgeschlagen: ${JSON.stringify(td).slice(0, 150)}`)
  }
  await store.set([
    { key: 'HIGGSFIELD_ACCESS_TOKEN', value: td.access_token },
    { key: 'HIGGSFIELD_REFRESH_TOKEN', value: td.refresh_token ?? rt },
    { key: 'HIGGSFIELD_EXPIRES_AT', value: String(now + (td.expires_in ?? 86400)) },
  ])
  return { token: td.access_token, ws }
}

function hdrs(token: string, ws: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'hf-workspace-id': ws, 'Content-Type': 'application/json' }
}

// Grosse Bilder NIE roh in die Edge Function laden: ein 5672x3781-Foto wird beim
// Dekodieren zu ~86 MB RGBA und reisst das Speicherlimit ("Memory limit exceeded"
// killt die Instanz, der Bild-Job bleibt dann fuer immer haengen — 26.8.26).
// Eigene Storage-URLs deshalb ueber die Supabase-Bildtransformation ziehen, die
// serverseitig auf Kantenlaenge MAX_EDGE verkleinert (Pro-Tarif, seit 19.7.).
export const MAX_EDGE = 1536
export function hfShrinkUrl(url: string, max = MAX_EDGE): string {
  const marker = '/storage/v1/object/public/'
  const i = url.indexOf(marker)
  if (i < 0) return url
  const path = url.slice(i + marker.length)
  if (path.includes('?')) return url
  return `${url.slice(0, i)}/storage/v1/render/image/public/${path}?width=${max}&height=${max}&resize=contain`
}

// Rohbild-Bytes zu Higgsfield hochladen → Media-ID (UUID), nutzbar als
// params.image_references = [{ id }]. Flow: POST /media?type=image liefert eine
// presignte S3-PUT-URL, dann die Bytes hochladen. Content-Type flexibel (jpeg/png).
export async function hfUploadImage(store: HfStore, bytes: Uint8Array, contentType = 'image/png'): Promise<string> {
  const { token, ws } = await hfAuth(store)
  const mk = await fetch(`${HF_BASE}/media?type=image`, { method: 'POST', headers: hdrs(token, ws), body: '{}' })
  const md = await mk.json() as { id?: string; upload_url?: string }
  if (!mk.ok || !md.id || !md.upload_url) throw new Error(`Higgsfield media create: ${JSON.stringify(md).slice(0, 200)}`)
  // Die Presigned-URL ist auf image/png signiert - JEDER andere Content-Type
  // bekommt ein S3-403 (gemessen 21.8.: image/jpeg 403, image/png 200).
  // Nicht-PNG-Bytes deshalb vor dem Upload nach PNG wandeln.
  let put_bytes = bytes
  if (contentType !== 'image/png') {
    const img = await Image.decode(bytes)
    // Vor dem PNG-Encode verkleinern: als Referenzbild reichen 1536 px, und ein
    // ungebremster Encode einer Handy-Aufnahme sprengt den Edge-Speicher.
    if (img.width > MAX_EDGE || img.height > MAX_EDGE) {
      if (img.width >= img.height) img.resize(MAX_EDGE, Image.RESIZE_AUTO)
      else img.resize(Image.RESIZE_AUTO, MAX_EDGE)
    }
    put_bytes = await img.encode()
  }
  const put = await fetch(md.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: put_bytes as BodyInit })
  if (!put.ok) {
    // S3 sagt im Body, WAS nicht stimmt (SignatureDoesNotMatch / AccessDenied /
    // Request has expired). Ohne den Body ist ein 403 nicht diagnostizierbar.
    const why = (await put.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
    throw new Error(`Higgsfield media upload (${put.status}) ct=${contentType} bytes=${put_bytes.length}: ${why}`)
  }
  return md.id
}

// Bild über Higgsfield erzeugen: Job anlegen → pollen → Bild-Bytes zurück.
// Referenzbilder vorher mit hfUploadImage hochladen und als
// params.image_references = [{ id }] übergeben.
export async function hfGenerateBytes(store: HfStore, jobType: string, params: Record<string, unknown>): Promise<Uint8Array> {
  const { token, ws } = await hfAuth(store)
  const hdr = hdrs(token, ws)
  const sub = await fetch(`${HF_BASE}/images/${jobType}/generations`, { method: 'POST', headers: hdr, body: JSON.stringify({ params }) })
  const sd = await sub.json() as { id?: string }
  if (!sub.ok || !sd.id) throw new Error(`Higgsfield submit: ${JSON.stringify(sd).slice(0, 200)}`)
  // Typisch ~15-40 s; Deckel 150 s, damit die Edge-Wallclock nicht reisst.
  for (let i = 0; i < 30; i++) {
    await new Promise(res => setTimeout(res, 5000))
    const jr = await fetch(`${HF_BASE}/jobs/${sd.id}`, { headers: hdr })
    const j = await jr.json() as { status?: string; result_url?: string }
    if (j.status === 'completed' && j.result_url) {
      const img = await fetch(j.result_url)
      if (!img.ok) throw new Error(`Higgsfield-Bild nicht ladbar (${img.status}).`)
      return new Uint8Array(await img.arrayBuffer())
    }
    if (j.status === 'failed' || j.status === 'canceled') throw new Error(`Higgsfield-Job ${j.status}.`)
  }
  throw new Error('Higgsfield-Timeout (150 s).')
}
