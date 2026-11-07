// owner-drive — Google-Drive-Kundenordner im Eigentümerportal + Lotte-Meldung
// bei neuen Dateien.
//
// Portal (User-JWT, Rolle eigentuemer; Staff darf lead_id mitgeben):
//   POST { action:'list' }                    → Ordner + Dateien des Kunden
//   POST multipart/form-data action=upload    → Datei(en) in den Kundenordner
//   POST { action:'download', file_id }       → Datei-Stream (Binärantwort)
//   POST { action:'upload_link', lead_id, ...} → Upload-Link für eine Person (nur Staff)
//
// Upload-Seite /sign/u/:token (kein Login, Header x-upload-token, siehe uploadSeite()):
//   POST JSON                                 → Ansicht: Vorname, Sprache, offen oder zu
//   POST multipart/form-data file=...         → eine Datei in den Kundenordner, nie lesen
//
// Intern (Service-Role-Bearer, Cron alle 5 Minuten):
//   POST { action:'sweep' }                   → neue Dateien in ALLEN Kundenordnern
//                                               erkennen (auch direkt in Drive
//                                               hochgeladene) und Lotte-WhatsApp an
//                                               alle mit Ordnerzugriff schicken;
//                                               danach offene „Zugriff anfordern“-
//                                               Anfragen bearbeiten (accessRequests)
//   POST { action:'test_notify' }             → Beispiel-Meldung NUR an Svens Nummer
//   POST { action:'status' }                  → ist der Upload-Zugang verbunden?
//
// Warum zwei Google-Zugänge:
//   LESEN läuft über den Service-Account (dauerhaft, sieht alle Kundenordner).
//   HOCHLADEN kann der Service-Account nicht („Service Accounts do not have
//   storage quota", bestätigt 13.8. + 8.9.2026). Deshalb lädt das Portal im Namen
//   von Svens Google-Konto hoch: Refresh-Token GOOGLE_DRIVE_REFRESH_TOKEN in
//   connector_secrets, einmalig per yt-oauth?target=drive geholt (gleicher
//   OAuth-Client wie YouTube). Fehlt er, meldet das Portal das ehrlich.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
//          GOOGLE_SERVICE_ACCOUNT_JSON
// Deploy:  supabase functions deploy owner-drive --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'
import { resolveLang, type Lang } from '../_shared/recipientLang.ts'
import { isCronCall, safeEqual } from '../_shared/callerAuth.ts'
import { ladeGesperrte, leadGesperrt, mailGesperrt, normMail, type GesperrteKonten } from '../_shared/kontoSperre.ts'
import { entscheideAnfrage, meldeSvenEinmal, SUBJECT_ANFRAGE, SUBJECT_FREIGESCHALTET } from '../_shared/driveZugang.ts'
import { UPLOAD_EMPFAENGER, uploadLinkHolen, type UploadEmpfaenger } from '../_shared/uploadLink.ts'
import { dateiName, dateiTyp, linkOffen, MAX_DATEI_MB, MAX_DATEIEN_JE_TAG, UPLOAD_TOKEN_RE } from './uploadSeite.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-upload-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const TEST_PHONE = '+35795096409'          // Sven — Tests gehen NIE an Kunden
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const MAX_DEPTH = 3                        // Unterordner-Tiefe beim Auflisten
const MAX_FOLDERS = 60                     // Schutz gegen ausufernde Ordnerbäume
const BASELINE_HOURS = 24                  // älter beim ersten Sehen → nur merken, nicht melden
const SETTLE_MINUTES = 2                   // jünger → nächste Runde (Portal-Upload trägt sich selbst ein)
const MAX_FILES_IN_MESSAGE = 8
const REQUEST_BUDGET_MS = 60_000           // so lange je Sweep offene Zugriffsanfragen lesen
const DEAD_PHASES = '(deal_verloren,archiviert)'

type Client = SupabaseClient
type DriveUser = { displayName?: string; emailAddress?: string }
interface DriveFile {
  id: string; name: string; mimeType: string; size?: string
  createdTime?: string; modifiedTime?: string; webViewLink?: string; iconLink?: string
  owners?: DriveUser[]; lastModifyingUser?: DriveUser
}
interface ListedFile extends DriveFile { path: string }
interface LeadRow { id: string; profile_id: string | null; first_name: string | null; last_name: string | null; email: string | null; alt_emails: string[] | null; phone: string | null; whatsapp: string | null; drive_folder_id: string | null; drive_folder_url: string | null }
interface Profile { id: string; role: string | null; full_name: string | null; email: string | null; phone: string | null; language: string | null }
interface NewFile { file_id: string; name: string; web_view_link: string | null; uploader_name: string; uploader_email: string | null }
interface Recipient { name: string; phone: string; email: string | null; lang: Lang }

const leadName = (l: LeadRow) => [l.first_name, l.last_name].map(x => (x ?? '').trim()).filter(Boolean).join(' ') || l.email || 'Kunde'
const tail = (p: string) => p.replace(/\D/g, '').slice(-9)
const lower = (e: unknown) => String(e ?? '').trim().toLowerCase()
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,iconLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)'

// ── Google-Token: Service-Account (lesen) ─────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\\n/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(b), c => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
let saCache: { token: string; exp: number; email: string } | null = null
let saWriteCache: { token: string; exp: number; email: string } | null = null
async function saToken(): Promise<{ token: string; email: string }> {
  if (saCache && saCache.exp > Date.now() + 60_000) return saCache
  saCache = await mintSaToken('https://www.googleapis.com/auth/drive.readonly')
  return saCache
}
/** Nur zum Freischalten offener Zugriffsanfragen. Alles andere liest. */
async function saWriteToken(): Promise<{ token: string; email: string }> {
  if (saWriteCache && saWriteCache.exp > Date.now() + 60_000) return saWriteCache
  saWriteCache = await mintSaToken('https://www.googleapis.com/auth/drive')
  return saWriteCache
}
async function mintSaToken(scope: string): Promise<{ token: string; exp: number; email: string }> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const key = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(new Uint8Array(sig))}` }),
  })
  const data = await res.json() as { access_token?: string; error_description?: string }
  if (!data.access_token) throw new Error(`SA-Token: ${data.error_description ?? 'unbekannt'}`)
  return { token: data.access_token, exp: Date.now() + 3500_000, email: sa.client_email }
}

// ── Google-Token: Svens Konto (hochladen) ─────────────────────────────────────
async function secret(sb: Client, key: string): Promise<string> {
  const { data } = await sb.from('connector_secrets').select('value').eq('key', key).maybeSingle()
  return ((data as { value?: string } | null)?.value ?? '').trim()
}
async function uploadToken(sb: Client): Promise<{ token: string; account: string } | null> {
  const [cid, csec, rtok, account] = await Promise.all([
    secret(sb, 'YOUTUBE_CLIENT_ID'), secret(sb, 'YOUTUBE_CLIENT_SECRET'), secret(sb, 'GOOGLE_DRIVE_REFRESH_TOKEN'), secret(sb, 'GOOGLE_DRIVE_ACCOUNT'),
  ])
  if (!cid || !csec || !rtok) return null
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' }),
  })
  const td = await tr.json() as { access_token?: string; error?: string }
  if (!td.access_token) { console.error('[owner-drive] Upload-Token:', td.error); return null }
  return { token: td.access_token, account }
}

// ── Drive-Helfer ──────────────────────────────────────────────────────────────
async function driveGet<T>(token: string, url: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const d = await r.json() as T & { error?: { message?: string } }
  if (!r.ok) throw new Error(`Drive ${r.status}: ${d.error?.message ?? 'Fehler'}`)
  return d
}
async function listChildren(token: string, folderId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = []
  let pageToken = ''
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=200&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`
    const d = await driveGet<{ files?: DriveFile[]; nextPageToken?: string }>(token, url)
    out.push(...(d.files ?? []))
    pageToken = d.nextPageToken ?? ''
  } while (pageToken)
  return out
}
/** Alle Dateien eines Kundenordners inkl. Unterordner (bis MAX_DEPTH), mit Pfad. */
async function listTree(token: string, rootId: string): Promise<ListedFile[]> {
  const files: ListedFile[] = []
  const queue: Array<{ id: string; path: string; depth: number }> = [{ id: rootId, path: '', depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_FOLDERS) {
    const cur = queue.shift()!
    visited++
    for (const f of await listChildren(token, cur.id)) {
      if (f.mimeType === FOLDER_MIME) {
        if (cur.depth < MAX_DEPTH) queue.push({ id: f.id, path: cur.path ? `${cur.path}/${f.name}` : f.name, depth: cur.depth + 1 })
      } else files.push({ ...f, path: cur.path })
    }
  }
  return files
}
/** Liegt die Datei (über höchstens 5 Elternstufen) im Kundenordner? */
async function fileInFolder(token: string, fileId: string, folderId: string): Promise<DriveFile | null> {
  const f = await driveGet<DriveFile & { parents?: string[] }>(token, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=${FILE_FIELDS},parents&supportsAllDrives=true`)
  let parents = f.parents ?? []
  for (let hop = 0; hop < 5 && parents.length; hop++) {
    if (parents.includes(folderId)) return f
    const p = await driveGet<{ parents?: string[] }>(token, `https://www.googleapis.com/drive/v3/files/${parents[0]}?fields=parents&supportsAllDrives=true`)
    parents = p.parents ?? []
  }
  return null
}
async function folderPermissions(token: string, folderId: string): Promise<Array<{ emailAddress?: string; role?: string; type?: string; displayName?: string }>> {
  const d = await driveGet<{ permissions?: Array<{ emailAddress?: string; role?: string; type?: string; displayName?: string }> }>(
    token, `https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=permissions(emailAddress,role,type,displayName)&pageSize=100&supportsAllDrives=true`)
  return d.permissions ?? []
}
/** Resumable-Upload (kein 5-MB-Limit wie bei multipart). */
async function uploadFile(token: string, folderId: string, name: string, mime: string, bytes: Uint8Array): Promise<DriveFile> {
  const init = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime || 'application/octet-stream', 'X-Upload-Content-Length': String(bytes.byteLength) },
    body: JSON.stringify({ name, parents: [folderId] }),
  })
  if (!init.ok) {
    const e = await init.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(`Upload-Start ${init.status}: ${e.error?.message ?? 'Fehler'}`)
  }
  const loc = init.headers.get('location')
  if (!loc) throw new Error('Upload-Start ohne Location-Header')
  const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: bytes })
  const d = await put.json() as DriveFile & { error?: { message?: string } }
  if (!put.ok || !d.id) throw new Error(`Upload ${put.status}: ${d.error?.message ?? 'Fehler'}`)
  return d
}

// ── Aufrufer + Kunde ──────────────────────────────────────────────────────────
// authEmail = die im Login-Token bestätigte Adresse (auth.users). profiles.email
// kann der Nutzer selbst ändern und taugt deshalb NICHT zur Kunden-Zuordnung.
async function caller(req: Request, sb: Client): Promise<{ service: boolean; profile: Profile | null; authEmail: string }> {
  if (await isCronCall(req)) return { service: true, profile: null, authEmail: '' }   // pg_cron hp-owner-drive-sweep
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return { service: false, profile: null, authEmail: '' }
  if (safeEqual(jwt, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) return { service: true, profile: null, authEmail: '' }   // konstante Zeit (Review S1)
  const { data } = await createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!).auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return { service: false, profile: null, authEmail: '' }
  const { data: prof } = await sb.from('profiles').select('id, role, full_name, email, phone, language').eq('id', uid).maybeSingle()
  return { service: false, profile: (prof as Profile | null), authEmail: lower(data?.user?.email) }
}
const isStaff = (p: Profile | null) => ['admin', 'verwalter', 'mitarbeiter'].includes(p?.role ?? '')
const LEAD_COLS = 'id, profile_id, first_name, last_name, email, alt_emails, phone, whatsapp, drive_folder_id, drive_folder_url'

/** Lead des eingeloggten Eigentümers: zuerst über profile_id, sonst über die
 *  im Login bestätigte E-Mail (authEmail, NICHT profiles.email). */
async function leadForProfile(sb: Client, p: Profile, authEmail: string): Promise<LeadRow | null> {
  const pick = (rows: LeadRow[]) => rows.find(r => r.drive_folder_id) ?? rows[0] ?? null
  const { data: byId } = await sb.from('leads').select(LEAD_COLS).eq('profile_id', p.id).order('created_at', { ascending: true })
  if (byId?.length) return pick(byId as LeadRow[])
  const em = lower(authEmail)
  if (!em) return null
  // Keine Platzhalter/Filter-Syntax in der Adresse zulassen ('%' traf sonst jeden
  // Lead, ',' hängte eigene Filter an). '_' ist in ILIKE ein Platzhalter → maskieren.
  if (/[%*,()"{}\\\s]/.test(em)) return null
  // Zwei getrennte, parametrisierte Abfragen statt eines zusammengesetzten .or()-Strings;
  // Ergebnis wie bisher nach created_at (ältester zuerst).
  type Row = LeadRow & { created_at?: string | null }
  const { data: byMain } = await sb.from('leads').select(`${LEAD_COLS}, created_at`).ilike('email', em.replace(/_/g, '\\_'))
  const { data: byAlt } = await sb.from('leads').select(`${LEAD_COLS}, created_at`).contains('alt_emails', [em])
  const seen = new Set<string>()
  const rows = [...((byMain ?? []) as Row[]), ...((byAlt ?? []) as Row[])]
    .filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true })
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
  return pick(rows)
}
/** Kundenordner sicherstellen (legt ihn über create-client-drive-folder an, teilt mit Kunde + Sven). */
async function ensureFolder(sb: Client, lead: LeadRow): Promise<LeadRow> {
  if (lead.drive_folder_id) return lead
  const { data, error } = await sb.functions.invoke('create-client-drive-folder', {
    body: { lead_id: lead.id, extra_emails: [], no_warn: true },   // Portal-Kunden laden über „Meine Dateien“ hoch
    headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
  })
  const d = (data ?? {}) as { ok?: boolean; folder_id?: string; folder_url?: string; error?: string }
  if (error || d.error || !d.folder_id) throw new Error(d.error || error?.message || 'Kundenordner konnte nicht angelegt werden')
  return { ...lead, drive_folder_id: d.folder_id, drive_folder_url: d.folder_url ?? `https://drive.google.com/drive/folders/${d.folder_id}` }
}

// ── Empfänger: wer hat Zugriff auf den Ordner, und wie erreichen wir ihn? ─────
interface Contact { name: string; phone: string | null }
async function lookupContact(sb: Client, email: string, extra: Record<string, { phone?: string; name?: string }>): Promise<Contact | null> {
  const x = extra[email]
  if (x?.phone) return { name: x.name ?? email, phone: x.phone }
  const { data: pr } = await sb.from('profiles').select('full_name, phone').ilike('email', email).limit(1)
  const p = (pr ?? [])[0] as { full_name?: string | null; phone?: string | null } | undefined
  if (p) return { name: p.full_name || email, phone: p.phone ?? null }
  const { data: ld } = await sb.from('leads').select(LEAD_COLS).or(`email.ilike.${email},alt_emails.cs.{"${email}"}`).order('created_at', { ascending: true }).limit(1)
  const l = (ld ?? [])[0] as LeadRow | undefined
  if (l) return { name: leadName(l), phone: l.whatsapp || l.phone || null }
  const { data: bc } = await sb.from('crm_business_contacts').select('first_name, last_name, phone, whatsapp').ilike('email', email).limit(1)
  const b = (bc ?? [])[0] as { first_name?: string | null; last_name?: string | null; phone?: string | null; whatsapp?: string | null } | undefined
  if (b) return { name: [b.first_name, b.last_name].filter(Boolean).join(' ') || email, phone: b.whatsapp || b.phone || null }
  const { data: dc } = await sb.from('crm_developer_contacts').select('name, phone, whatsapp').ilike('email', email).limit(1)
  const d = (dc ?? [])[0] as { name?: string | null; phone?: string | null; whatsapp?: string | null } | undefined
  if (d) return { name: d.name || email, phone: d.whatsapp || d.phone || null }
  const { data: vw } = await sb.from('verwaltungen').select('name, ansprechpartner, phone, ansprechpartner_phone').or(`email.ilike.${email},ansprechpartner_email.ilike.${email}`).limit(1)
  const v = (vw ?? [])[0] as { name?: string | null; ansprechpartner?: string | null; phone?: string | null; ansprechpartner_phone?: string | null } | undefined
  if (v) return { name: v.ansprechpartner || v.name || email, phone: v.ansprechpartner_phone || v.phone || null }
  return null
}

async function recipientsFor(sb: Client, lead: LeadRow, excludeEmails: string[]): Promise<{ list: Recipient[]; unresolved: string[] }> {
  const { token, email: saMail } = await saToken()
  const { data: s } = await sb.from('crm_settings').select('value').eq('key', 'drive_notify_contacts').maybeSingle()
  let extra: Record<string, { phone?: string; name?: string }> = {}
  try { extra = JSON.parse(((s as { value?: string } | null)?.value) || '{}') } catch { /* leer */ }
  extra = Object.fromEntries(Object.entries(extra).map(([k, v]) => [lower(k), v]))

  const emails = new Set<string>()
  try {
    for (const p of await folderPermissions(token, lead.drive_folder_id!)) {
      const e = lower(p.emailAddress)
      if (p.type === 'user' && e && e !== lower(saMail)) emails.add(e)
    }
  } catch (e) { console.warn('[owner-drive] Berechtigungen nicht lesbar:', (e as Error).message) }
  // Der Kunde selbst hat über das Portal immer Zugriff, auch wenn seine Mail kein
  // Google-Konto ist (dann fehlt er in den Drive-Berechtigungen).
  if (lower(lead.email)) emails.add(lower(lead.email))
  for (const e of excludeEmails.map(lower).filter(Boolean)) emails.delete(e)

  // Gesperrte Konten bekommen keine Meldung, auch wenn ihre Drive-Freigabe noch besteht.
  // Ist die Sperrliste nicht lesbar, fällt der Kunde aus dieser Runde; der Lauf darf daran
  // nicht scheitern und andere Empfänger bekommen ihre Meldung.
  let gesperrte: GesperrteKonten | null = null
  try { gesperrte = await ladeGesperrte(sb) } catch (e) { console.warn('[owner-drive]', (e as Error).message) }
  const kundenMails = [lead.email, ...(lead.alt_emails ?? [])].map(normMail)
  for (const e of [...emails]) {
    if (gesperrte ? mailGesperrt(gesperrte, e, lead) : kundenMails.includes(normMail(e))) emails.delete(e)
  }

  const list: Recipient[] = []
  const unresolved: string[] = []
  const seenPhones = new Set<string>()
  // Auch über eine dritte Adresse derselben Person darf nichts an die Nummer des Kunden gehen.
  if (!gesperrte || leadGesperrt(gesperrte, lead)) {
    for (const p of [lead.whatsapp, lead.phone]) if (p) seenPhones.add(tail(p))
  }
  for (const email of emails) {
    const c = email === lower(lead.email)
      ? { name: leadName(lead), phone: lead.whatsapp || lead.phone || null }
      : await lookupContact(sb, email, extra)
    if (!c?.phone) { unresolved.push(email); continue }
    const key = tail(c.phone)
    if (!key || seenPhones.has(key)) continue
    seenPhones.add(key)
    list.push({ name: c.name, phone: c.phone, email, lang: await resolveLang(sb, { email, phone: c.phone }) })
  }
  return { list, unresolved }
}

// ── Lottes Nachricht ──────────────────────────────────────────────────────────
function buildText(r: Recipient, lead: LeadRow, files: NewFile[], isCustomer: boolean): string {
  const first = (r.name ?? '').split(' ')[0] || r.name
  const de = r.lang !== 'en'
  const shown = files.slice(0, MAX_FILES_IN_MESSAGE)
  // Direktlink je Datei (Sven 19.10.: Partner fanden die Datei im Ordner nicht,
  // weil sie nur in ihrem Unterordner suchten)
  const lines = shown.map(f => `📄 *${f.name}*\n${de ? 'hochgeladen von' : 'uploaded by'} ${f.uploader_name}${f.web_view_link ? `\n👉 ${f.web_view_link}` : ''}`).join('\n\n')
  const more = files.length > shown.length
    ? (de ? `\n\n… und ${files.length - shown.length} weitere` : `\n\n… and ${files.length - shown.length} more`)
    : ''
  const where = isCustomer
    ? (de ? 'In deinem Google-Drive-Ordner' : 'In your Google Drive folder')
    : (de ? `Im Google-Drive-Ordner von ${leadName(lead)}` : `In the Google Drive folder of ${leadName(lead)}`)
  const one = files.length === 1
  const intro = de
    ? `${where} ${one ? 'ist eine neue Datei angekommen' : `sind ${files.length} neue Dateien angekommen`}:`
    : `${where} ${one ? 'a new file has arrived' : `${files.length} new files have arrived`}:`
  const folderUrl = lead.drive_folder_url ?? `https://drive.google.com/drive/folders/${lead.drive_folder_id}`
  const link = shown.some(f => f.web_view_link) ? `${de ? 'Ganzer Ordner' : 'Whole folder'}:\n${folderUrl}` : folderUrl
  return de
    ? `Hallo ${first} 🐾\n\nhier ist Lotte von Happy Property. ${intro}\n\n${lines}${more}\n\n${link}\n\nLiebe Grüße, Lotte`
    : `Hi ${first} 🐾\n\nLotte from Happy Property here. ${intro}\n\n${lines}${more}\n\n${link}\n\nBest, Lotte`
}

async function notify(sb: Client, lead: LeadRow, files: NewFile[], opts: { test?: boolean; excludePhones?: Array<string | null | undefined> } = {}): Promise<Record<string, unknown>> {
  // Wer hochgeladen hat, bekommt keine Meldung über die eigene Datei — Ausschluss
  // über E-Mail UND Telefonnummer (Portal-Mail und Lead-Mail können abweichen).
  const excl = files.map(f => f.uploader_email ?? '').filter(Boolean)
  const { list, unresolved } = await recipientsFor(sb, lead, excl)
  const customerTail = tail(lead.whatsapp || lead.phone || '')
  const uploaderTails = new Set((opts.excludePhones ?? []).map(x => tail(String(x ?? ''))).filter(x => x.length === 9))
  const results: Array<{ name: string; phone: string; ok: boolean; error?: string }> = []
  const targets = opts.test
    ? [{ name: 'Sven', phone: TEST_PHONE, email: null, lang: 'de' as Lang }]
    : list.filter(r => !uploaderTails.has(tail(r.phone)))
  for (const r of targets) {
    const isCustomer = !opts.test && !!customerTail && tail(r.phone) === customerTail
    const text = (opts.test ? 'TEST · ' : '') + buildText(r, lead, files, isCustomer)
    try {
      const { data, error } = await sb.functions.invoke('send-whatsapp', { body: {
        event_type: 'drive_upload', override_text: text, auto: true,
        lead_data: { lead_name: r.name, lead_phone: r.phone },
        lead_id: opts.test ? undefined : lead.id,
        persona_image: lotteBild(),
      } })
      const d = data as { error?: string; success?: boolean } | null
      const fail = error?.message || d?.error || (d?.success === false ? 'success=false' : null)
      if (fail) throw new Error(fail)
      results.push({ name: r.name, phone: r.phone, ok: true })
    } catch (e) {
      results.push({ name: r.name, phone: r.phone, ok: false, error: (e as Error).message })
      console.error('[owner-drive] notify', r.name, (e as Error).message)
    }
  }
  return { sent: results.filter(r => r.ok).length, results, unresolved }
}

// ── Uploader-Name aus Drive-Metadaten ─────────────────────────────────────────
async function uploaderOf(sb: Client, f: DriveFile, extra: Record<string, { phone?: string; name?: string }>): Promise<{ name: string; email: string | null }> {
  const u = f.owners?.[0] ?? f.lastModifyingUser
  const email = lower(u?.emailAddress) || null
  if (email) {
    const c = await lookupContact(sb, email, extra)
    if (c?.name && c.name !== email) return { name: c.name, email }
  }
  return { name: u?.displayName || email || 'Unbekannt', email }
}

// ── Sweep: neue Dateien in allen Kundenordnern ────────────────────────────────
async function sweep(sb: Client): Promise<Record<string, unknown>> {
  const { token } = await saToken()
  const { data: leads } = await sb.from('leads').select(LEAD_COLS).not('drive_folder_id', 'is', null)
  const { data: s } = await sb.from('crm_settings').select('value').eq('key', 'drive_notify_contacts').maybeSingle()
  let extra: Record<string, { phone?: string; name?: string }> = {}
  try { extra = JSON.parse(((s as { value?: string } | null)?.value) || '{}') } catch { /* leer */ }
  const summary: Array<Record<string, unknown>> = []
  let scanned = 0, baseline = 0, fresh = 0
  for (const lead of (leads ?? []) as LeadRow[]) {
    try {
      const files = await listTree(token, lead.drive_folder_id!)
      scanned += files.length
      if (!files.length) continue
      const { data: known } = await sb.from('drive_folder_files').select('file_id').in('file_id', files.map(f => f.id))
      const knownIds = new Set(((known ?? []) as Array<{ file_id: string }>).map(k => k.file_id))
      const now = Date.now()
      const toNotify: NewFile[] = []
      for (const f of files) {
        if (knownIds.has(f.id)) continue
        const created = f.createdTime ? new Date(f.createdTime).getTime() : now
        const ageMin = (now - created) / 60_000
        if (ageMin < SETTLE_MINUTES) continue                       // Portal-Upload trägt sich gleich selbst ein
        const isBaseline = ageMin > BASELINE_HOURS * 60
        const up = await uploaderOf(sb, f, extra)
        const row = {
          file_id: f.id, lead_id: lead.id, folder_id: lead.drive_folder_id, name: f.name, mime_type: f.mimeType,
          size_bytes: f.size ? Number(f.size) : null, web_view_link: f.webViewLink ?? null, path: f.path,
          uploader_name: up.name, uploader_email: up.email, source: isBaseline ? 'baseline' : 'drive',
          created_time: f.createdTime ?? null,
        }
        const { data: ins } = await sb.from('drive_folder_files').upsert(row, { onConflict: 'file_id', ignoreDuplicates: true }).select('file_id')
        if (!ins?.length) continue                                  // jemand anders war schneller (Portal-Upload)
        if (isBaseline) { baseline++; continue }
        fresh++
        toNotify.push({ file_id: f.id, name: f.name, web_view_link: f.webViewLink ?? null, uploader_name: up.name, uploader_email: up.email })
      }
      if (toNotify.length) {
        const res = await notify(sb, lead, toNotify)
        await sb.from('drive_folder_files').update({ notified_at: new Date().toISOString(), notify_result: res }).in('file_id', toNotify.map(f => f.file_id))
        summary.push({ lead: leadName(lead), files: toNotify.map(f => f.name), ...res })
      }
    } catch (e) {
      console.error('[owner-drive] sweep', leadName(lead), (e as Error).message)
      summary.push({ lead: leadName(lead), error: (e as Error).message })
    }
  }
  // Eigene Schritte: Ein Fehler hier darf die Datei-Meldungen oben nicht beeinflussen
  const seite = await seitenUploadsMelden(sb)
    .catch(e => { console.error('[owner-drive] Upload-Seite', (e as Error).message); return { error: (e as Error).message } })
  const access = await accessRequests(sb, (leads ?? []) as LeadRow[])
    .catch(e => { console.error('[owner-drive] Zugriffsanfragen', (e as Error).message); return { error: (e as Error).message } })
  return { ok: true, leads: (leads ?? []).length, scanned, baseline, fresh, summary, seite, access }
}

// ── Upload-Seite /sign/u/:token ───────────────────────────────────────────────
// Hochladen ohne Google-Konto, für jeden mit Link. Google sieht als Besitzer nur Svens Konto, deshalb
// trägt die Seite jede Datei mit dem Namen aus dem Link ein. Die Meldung schickt der Sweep, gesammelt
// für alle Dateien einer Person, sobald sie 2 Minuten liegen. Der Hochladende bekommt keine.
interface UploadLink { id: string; token: string; lead_id: string; empfaenger: UploadEmpfaenger; name: string; email: string | null; phone: string | null; expires_at: string; revoked_at: string | null }

async function seitenUploadsMelden(sb: Client): Promise<Record<string, unknown>> {
  const grenze = new Date(Date.now() - SETTLE_MINUTES * 60_000).toISOString()
  const { data, error } = await sb.from('drive_folder_files').select('file_id, name, web_view_link, uploader_name, uploader_email, upload_link_id')
    .not('upload_link_id', 'is', null).is('notified_at', null).lt('seen_at', grenze).limit(200)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<NewFile & { upload_link_id: string }>
  const gruppen = new Map<string, Array<NewFile & { upload_link_id: string }>>()
  for (const r of rows) gruppen.set(r.upload_link_id, [...(gruppen.get(r.upload_link_id) ?? []), r])
  let gemeldet = 0
  for (const [linkId, files] of gruppen) {
    try {
      const { data: l } = await sb.from('upload_links').select('*').eq('id', linkId).maybeSingle()
      const link = l as UploadLink | null
      if (!link) continue
      const { data: ld } = await sb.from('leads').select(LEAD_COLS).eq('id', link.lead_id).maybeSingle()
      const lead = ld as LeadRow | null
      if (!lead?.drive_folder_id) continue
      // Erst belegen, dann senden: Laufen zwei Sweeps gleichzeitig, meldet nur einer
      const { data: belegt } = await sb.from('drive_folder_files').update({ notified_at: new Date().toISOString() })
        .in('file_id', files.map(f => f.file_id)).is('notified_at', null).select('file_id')
      const ids = new Set(((belegt ?? []) as Array<{ file_id: string }>).map(b => b.file_id))
      const meine = files.filter(f => ids.has(f.file_id))
      if (!meine.length) continue
      const excludePhones = link.empfaenger === 'kunde' ? [link.phone, lead.whatsapp, lead.phone] : [link.phone]
      const res = await notify(sb, lead, meine, { excludePhones })
      await sb.from('drive_folder_files').update({ notify_result: res }).in('file_id', meine.map(f => f.file_id))
      gemeldet += meine.length
      const { error: actErr } = await sb.from('activities').insert({
        lead_id: lead.id, type: 'note', direction: 'inbound', auto: true, subject: 'Drive-Upload über die Upload-Seite',
        content: `${link.name} hat über die Upload-Seite hochgeladen: ${meine.map(f => f.name).join(', ')}`,
        completed_at: new Date().toISOString(),
      })
      if (actErr) console.warn('[owner-drive] activity:', actErr.message)
    } catch (e) { console.error('[owner-drive] Upload-Seite melden', (e as Error).message) }
  }
  return { offen: rows.length, gemeldet }
}

/** Öffentlich, nur das Token entscheidet. Zu = eine einzige Antwort, ohne Grund: Der Link kann bei Dritten liegen. */
async function uploadSeite(req: Request, sb: Client, token: string): Promise<Response> {
  const istDatei = (req.headers.get('content-type') ?? '').includes('multipart/form-data')
  // Vor dem Einlesen, die Anfrage kommt von außen. Formular-Rahmen dazugerechnet.
  if (Number(req.headers.get('content-length') ?? 0) > (MAX_DATEI_MB + 1) * 1024 * 1024) return json({ error: 'too_large' }, 413)
  if (!UPLOAD_TOKEN_RE.test(token)) return json({ error: 'closed' }, 404)
  const { data: l } = await sb.from('upload_links').select('*').eq('token', token).maybeSingle()
  const link = l as UploadLink | null
  if (!link) return json({ error: 'closed' }, 404)
  const { data: ld } = await sb.from('leads').select(LEAD_COLS).eq('id', link.lead_id).maybeSingle()
  let lead = ld as LeadRow | null
  if (!lead) return json({ error: 'closed' }, 404)
  const { data: deals, error: dealErr } = await sb.from('deals').select('phase').eq('lead_id', lead.id).limit(100)
  if (dealErr) throw new Error(`Deals: ${dealErr.message}`)
  // Wirft bei einem Lesefehler: Die Seite bleibt dann zu. Fremde (Bauträger, Anwalt) hängen nur an der eigenen Adresse.
  const g = await ladeGesperrte(sb)
  const gesperrt = link.empfaenger === 'kunde' ? leadGesperrt(g, lead) : mailGesperrt(g, link.email, lead)
  const offen = linkOffen({ expires_at: link.expires_at, revoked_at: link.revoked_at, phasen: ((deals ?? []) as Array<{ phase: string }>).map(d => d.phase), gesperrt })
  const lang = await resolveLang(sb, link.empfaenger === 'kunde'
    ? { email: lead.email, phone: lead.whatsapp || lead.phone, lead_id: lead.id }
    : { email: link.email, phone: link.phone })

  if (!istDatei) {
    if (!offen) return json({ ok: true, closed: true, lang })
    return json({
      ok: true, closed: false, lang, empfaenger: link.empfaenger, first_name: link.name.split(' ')[0],
      kunde: link.empfaenger === 'kunde' ? null : leadName(lead), max_mb: MAX_DATEI_MB,
    })
  }
  if (!offen) return json({ error: 'closed' }, 409)

  const form = await req.formData()
  const f = form.get('file')
  if (!(f instanceof File) || !f.size) return json({ error: 'no_file' }, 400)
  if (f.size > MAX_DATEI_MB * 1024 * 1024) return json({ error: 'too_large' }, 413)
  const seit = new Date(Date.now() - 86_400_000).toISOString()
  const { count, error: cntErr } = await sb.from('drive_folder_files').select('file_id', { count: 'exact', head: true }).eq('upload_link_id', link.id).gt('seen_at', seit)
  if (cntErr) throw new Error(`Zählen: ${cntErr.message}`)
  if ((count ?? 0) >= MAX_DATEIEN_JE_TAG) return json({ error: 'too_many' }, 429)
  const bytes = new Uint8Array(await f.arrayBuffer())
  const name = dateiName(f.name)
  const mime = dateiTyp(bytes, name)
  if (!mime) return json({ error: 'bad_type' }, 415)

  const t = await uploadToken(sb)
  if (!t) {
    await meldeSvenEinmal(sb, { leadId: lead.id, subject: 'Upload-Seite: Drive nicht verbunden', key: 'Google-Zugang fürs Hochladen fehlt', text: `⚠️ Google-Zugang fürs Hochladen fehlt\n\n${link.name} wollte etwas in den Ordner von ${leadName(lead)} hochladen. Bitte unter Einstellungen → Connectoren „Google Drive“ neu verbinden.` })
    return json({ error: 'drive_not_connected' }, 503)
  }
  lead = await ensureFolder(sb, lead)
  const d = await uploadFile(t.token, lead.drive_folder_id!, name, mime, bytes)
  const { error: rowErr } = await sb.from('drive_folder_files').upsert({
    file_id: d.id, lead_id: lead.id, folder_id: lead.drive_folder_id, name: d.name, mime_type: d.mimeType,
    size_bytes: d.size ? Number(d.size) : f.size, web_view_link: d.webViewLink ?? null, path: '',
    uploader_name: link.name, uploader_email: link.email ?? (link.empfaenger === 'kunde' ? lower(lead.email) || null : null),
    source: 'upload_seite', created_time: d.createdTime ?? new Date().toISOString(), upload_link_id: link.id,
  }, { onConflict: 'file_id' })
  if (rowErr) console.error('[owner-drive] Upload-Seite Eintrag', rowErr.message)
  return json({ ok: true, name: d.name })
}

// ── Offene Zugriffsanfragen („Zugriff anfordern“ im Drive) ────────────────────
// Die Ordner gehören dem Service-Account, die Anfrage erreicht also niemanden (siehe _shared/driveZugang.ts).
// Adresse des Kunden mit lebendem Deal: freischalten, Google sagt dem Kunden Bescheid. Sonst fragt
// Sven, einmal je Adresse. Trägt er sie im CRM ein, schaltet der nächste Lauf sie frei.
async function accessRequests(sb: Client, leads: LeadRow[]): Promise<Record<string, unknown>> {
  const started = Date.now()
  const { token } = await saToken()
  const gesperrte: GesperrteKonten = await ladeGesperrte(sb)   // wirft bei Lesefehler: dann niemanden freischalten
  let open = 0, accepted = 0, asked = 0, skipped = 0
  for (const lead of leads) {
    if (Date.now() - started > REQUEST_BUDGET_MS) { skipped = leads.length - leads.indexOf(lead); break }
    try {
      const res = await driveGet<{ accessProposals?: Array<{ proposalId?: string; requesterEmailAddress?: string }> }>(token,
        `https://www.googleapis.com/drive/v3/files/${lead.drive_folder_id}/accessproposals?pageSize=20`)
      for (const p of res.accessProposals ?? []) {
        open++
        const von = (p.requesterEmailAddress ?? '').trim()
        if (!p.proposalId || !von) continue
        const { data: deals, error: dealErr } = await sb.from('deals').select('id').eq('lead_id', lead.id).not('phase', 'in', DEAD_PHASES).limit(1)
        if (dealErr) throw new Error(`Deals: ${dealErr.message}`)
        const entscheidung = entscheideAnfrage({
          anfrage: von, email: lead.email, altEmails: lead.alt_emails, lebenderDeal: (deals ?? []).length > 0,
          gesperrt: leadGesperrt(gesperrte, lead) || mailGesperrt(gesperrte, von, lead),
        })
        const name = leadName(lead)
        if (entscheidung === 'freischalten') {
          const { token: write } = await saWriteToken()
          const r = await fetch(`https://www.googleapis.com/drive/v3/files/${lead.drive_folder_id}/accessproposals/${encodeURIComponent(p.proposalId)}:resolve`, {
            method: 'POST', headers: { Authorization: `Bearer ${write}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ACCEPT', role: ['writer'], sendNotification: true }),
          })
          if (!r.ok) {
            const e = await r.json().catch(() => ({})) as { error?: { message?: string } }
            throw new Error(`Freischalten ${r.status}: ${e.error?.message ?? 'Fehler'}`)
          }
          accepted++
          const { error: actErr } = await sb.from('activities').insert({
            lead_id: lead.id, type: 'note', direction: 'inbound', auto: true, subject: SUBJECT_FREIGESCHALTET,
            content: `${von} hat im Drive „Zugriff anfordern“ geklickt. Die Adresse gehört zum Kunden, Schreibrecht auf den Kundenordner ist erteilt.`,
            completed_at: new Date().toISOString(),
          })
          if (actErr) console.warn('[owner-drive] activity:', actErr.message)
          continue
        }
        const hinweis = entscheidung === 'gesperrt'
          ? 'Der Kunde ist gesperrt, die Anfrage bleibt zu.'
          : entscheidung === 'deal_zu'
            ? 'Die Adresse gehört zum Kunden, sein Deal ist aber abgeschlossen oder verloren. Deshalb nicht automatisch freigeschaltet.'
            : 'Ist das der Kunde? Dann trag die Adresse im CRM unter „Weitere E-Mails“ ein, sie wird dann innerhalb von 5 Minuten freigeschaltet. Sonst nichts tun, die Anfrage bleibt einfach liegen.'
        const gemeldet = await meldeSvenEinmal(sb, {
          leadId: lead.id, subject: SUBJECT_ANFRAGE, key: von,
          text: `🔑 Zugriffsanfrage auf den Drive-Ordner von ${name}\n\nVon: ${von}\n\n${hinweis}`,
        })
        if (gemeldet) asked++
      }
    } catch (e) {
      console.warn('[owner-drive] Zugriffsanfragen', leadName(lead), (e as Error).message)
    }
  }
  return { open, accepted, asked, skipped }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const uploadTokenHeader = req.headers.get('x-upload-token')
    if (uploadTokenHeader !== null) return await uploadSeite(req, sb, uploadTokenHeader.trim().toLowerCase())
    const who = await caller(req, sb)
    const ct = req.headers.get('content-type') ?? ''
    let action = ''
    let body: Record<string, unknown> = {}
    let form: FormData | null = null
    if (ct.includes('multipart/form-data')) {
      form = await req.formData()
      action = String(form.get('action') ?? 'upload')
      body = { lead_id: form.get('lead_id') ?? undefined }
    } else {
      body = await req.json().catch(() => ({})) as Record<string, unknown>
      action = String(body.action ?? '')
    }

    // ── intern ──
    if (action === 'sweep' || action === 'test_notify' || action === 'status') {
      if (!who.service && !isStaff(who.profile)) return json({ error: 'Keine Berechtigung.' }, 403)
      if (action === 'sweep') return json(await sweep(sb))
      if (action === 'status') {
        const t = await uploadToken(sb)
        if (!t) return json({ ok: true, connected: false })
        const about = await driveGet<{ user?: { emailAddress?: string; displayName?: string } }>(t.token, 'https://www.googleapis.com/drive/v3/about?fields=user').catch(() => null)
        return json({ ok: true, connected: !!about?.user, account: about?.user?.emailAddress ?? t.account })
      }
      // test_notify: Beispiel-Meldung an Svens Nummer, mit einem echten Kundenordner als Kulisse
      const leadId = typeof body.lead_id === 'string' ? body.lead_id : null
      const q = sb.from('leads').select(LEAD_COLS).not('drive_folder_id', 'is', null).limit(1)
      const { data: ld } = leadId ? await sb.from('leads').select(LEAD_COLS).eq('id', leadId).limit(1) : await q
      const lead = (ld ?? [])[0] as LeadRow | undefined
      if (!lead?.drive_folder_id) return json({ error: 'Kein Lead mit Drive-Ordner gefunden.' }, 404)
      const res = await notify(sb, lead, [{ file_id: 'test', name: 'Kaufvertrag_Beispiel.pdf', web_view_link: lead.drive_folder_url ?? `https://drive.google.com/drive/folders/${lead.drive_folder_id}`, uploader_name: 'Timotheos Papadopoulos', uploader_email: null }], { test: true })
      return json({ ok: true, ...res })
    }

    // ── Portal ──
    if (!who.profile) return json({ error: 'Nicht angemeldet.' }, 401)
    const p = who.profile
    let lead: LeadRow | null = null
    if (isStaff(p) && typeof body.lead_id === 'string' && body.lead_id) {
      const { data } = await sb.from('leads').select(LEAD_COLS).eq('id', body.lead_id).maybeSingle()
      lead = data as LeadRow | null
    } else if (p.role === 'eigentuemer') {
      lead = await leadForProfile(sb, p, who.authEmail)
    } else return json({ error: 'Keine Berechtigung.' }, 403)
    if (!lead) return json({ ok: true, folder: null, reason: 'no_lead', files: [], can_upload: false })

    // Nur Staff mit ausdrücklicher lead_id. Verschickt nichts.
    if (action === 'upload_link') {
      if (!isStaff(p) || lead.id !== body.lead_id) return json({ error: 'Keine Berechtigung.' }, 403)
      const empfaenger = String(body.empfaenger ?? 'kunde') as UploadEmpfaenger
      if (!UPLOAD_EMPFAENGER.includes(empfaenger)) return json({ error: 'Empfänger unbekannt.' }, 400)
      const name = empfaenger === 'kunde' ? leadName(lead) : String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      if (!name) return json({ error: 'Name fehlt.' }, 400)
      if (empfaenger === 'kunde' && leadGesperrt(await ladeGesperrte(sb), lead)) return json({ error: 'Der Kunde ist gesperrt.', code: 'KONTO_GESPERRT' }, 409)
      return json({ ok: true, ...await uploadLinkHolen(sb, { lead_id: lead.id, empfaenger, name, email: empfaenger === 'kunde' ? lead.email : null, phone: empfaenger === 'kunde' ? lead.whatsapp || lead.phone : null }) })
    }

    if (action === 'list') {
      lead = await ensureFolder(sb, lead)
      const { token } = await saToken()
      const files = await listTree(token, lead.drive_folder_id!)
      // Uploader-Namen aus unserer Tabelle (Portal-Uploads tragen den Kunden ein,
      // in Drive stünde sonst Svens Konto).
      const { data: known } = await sb.from('drive_folder_files').select('file_id, uploader_name').in('file_id', files.map(f => f.id))
      const upl = new Map(((known ?? []) as Array<{ file_id: string; uploader_name: string | null }>).map(k => [k.file_id, k.uploader_name]))
      const canUpload = !!(await secret(sb, 'GOOGLE_DRIVE_REFRESH_TOKEN'))
      return json({
        ok: true, can_upload: canUpload,
        folder: { id: lead.drive_folder_id, url: lead.drive_folder_url ?? `https://drive.google.com/drive/folders/${lead.drive_folder_id}` },
        files: files.map(f => ({
          id: f.id, name: f.name, mime_type: f.mimeType, size: f.size ? Number(f.size) : null, path: f.path,
          created_time: f.createdTime ?? null, modified_time: f.modifiedTime ?? null, web_view_link: f.webViewLink ?? null, icon: f.iconLink ?? null,
          uploader: upl.get(f.id) ?? f.owners?.[0]?.displayName ?? f.lastModifyingUser?.displayName ?? null,
        })).sort((a, b) => (b.created_time ?? '').localeCompare(a.created_time ?? '')),
      })
    }

    if (action === 'download') {
      const fileId = String(body.file_id ?? '')
      if (!fileId || !lead.drive_folder_id) return json({ error: 'file_id fehlt' }, 400)
      const { token } = await saToken()
      const f = await fileInFolder(token, fileId, lead.drive_folder_id)
      if (!f) return json({ error: 'Datei nicht im Kundenordner.' }, 404)
      const native = f.mimeType.startsWith('application/vnd.google-apps.')
      const url = native
        ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf`
        : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) return json({ error: `Drive ${r.status}` }, 502)
      const name = native ? `${f.name}.pdf` : f.name
      return new Response(r.body, { headers: { ...CORS, 'Content-Type': native ? 'application/pdf' : (f.mimeType || 'application/octet-stream'), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } })
    }

    if (action === 'upload') {
      if (!form) return json({ error: 'Kein Formular.' }, 400)
      lead = await ensureFolder(sb, lead)
      const files = form.getAll('file').filter((x): x is File => x instanceof File && x.size > 0)
      if (!files.length) return json({ error: 'Keine Datei.' }, 400)
      const t = await uploadToken(sb)
      if (!t) return json({ error: 'drive_not_connected' }, 503)
      const uploaderName = (p.full_name ?? '').trim() || leadName(lead)
      const uploaderEmail = lower(p.email) || lower(lead.email) || null
      const done: NewFile[] = []
      const failed: Array<{ name: string; error: string }> = []
      for (const f of files) {
        try {
          const d = await uploadFile(t.token, lead.drive_folder_id!, f.name, f.type, new Uint8Array(await f.arrayBuffer()))
          await sb.from('drive_folder_files').upsert({
            file_id: d.id, lead_id: lead.id, folder_id: lead.drive_folder_id, name: d.name, mime_type: d.mimeType,
            size_bytes: d.size ? Number(d.size) : f.size, web_view_link: d.webViewLink ?? null, path: '',
            uploader_name: uploaderName, uploader_email: uploaderEmail, source: 'portal', created_time: d.createdTime ?? new Date().toISOString(),
          }, { onConflict: 'file_id' })
          done.push({ file_id: d.id, name: d.name, web_view_link: d.webViewLink ?? null, uploader_name: uploaderName, uploader_email: uploaderEmail })
        } catch (e) { failed.push({ name: f.name, error: (e as Error).message }) }
      }
      let notified: Record<string, unknown> | null = null
      if (done.length) {
        // Lädt der Kunde selbst hoch, bekommt er keine Meldung — sonst (Staff im
        // Namen eines Kunden) nur die Nummer des Hochladenden ausschließen.
        const excludePhones = p.role === 'eigentuemer' ? [p.phone, lead.whatsapp, lead.phone] : [p.phone]
        notified = await notify(sb, lead, done, { excludePhones })
        await sb.from('drive_folder_files').update({ notified_at: new Date().toISOString(), notify_result: notified }).in('file_id', done.map(f => f.file_id))
        const { error: actErr } = await sb.from('activities').insert({
          lead_id: lead.id, type: 'note', direction: 'inbound', subject: 'Drive-Upload über das Portal',
          content: `${uploaderName} hat über das Eigentümerportal hochgeladen: ${done.map(f => f.name).join(', ')}`,
          completed_at: new Date().toISOString(), auto: true,
        })
        if (actErr) console.warn('[owner-drive] activity:', actErr.message)
      }
      return json({ ok: true, uploaded: done.map(f => ({ id: f.file_id, name: f.name })), failed, notified })
    }

    return json({ error: 'Unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[owner-drive]', msg)
    return json({ error: msg }, 500)
  }
})
