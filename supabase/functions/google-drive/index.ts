// Supabase Edge Function: google-drive
// Erstellt Google Drive Ordner für Deals und gibt URL zurück.
// Alle Ordner gehören dem authentifizierten User (happypropertycyprus@gmail.com).
//
// Actions:
//   create_folder  → Ordner anlegen (optional: unter parent_folder_id)
//   share_folder   → Ordner mit E-Mail teilen
//   ensure_root    → Root-Ordner "Happy Property – Deals" sicherstellen (einmalig)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── OAuth: Access Token via Refresh Token holen ───────────────────────────────
async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      refresh_token: Deno.env.get('GOOGLE_REFRESH_TOKEN')!,
      grant_type:    'refresh_token',
    }),
  })
  const data = await res.json() as { access_token?: string; error?: string }
  if (!data.access_token) {
    throw new Error(`Google OAuth fehlgeschlagen: ${data.error ?? JSON.stringify(data)}`)
  }
  return data.access_token
}

// ── Service-Account: dauerhafter Lesezugriff auf geteilte Drive-Ordner ────────
// Signiert ein JWT mit dem SA-Private-Key und tauscht es gegen ein Access-Token.
// Läuft nie ab (kein Refresh-Token nötig). Secret: GOOGLE_SERVICE_ACCOUNT_JSON.
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
async function getServiceAccountToken(scope = 'https://www.googleapis.com/auth/drive.readonly'): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const key = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const data = await res.json() as { access_token?: string; error?: string; error_description?: string }
  if (!data.access_token) throw new Error(`Service-Account-Token fehlgeschlagen: ${data.error_description ?? data.error ?? JSON.stringify(data)}`)
  return data.access_token
}
// Lese-Token: Service-Account bevorzugt (dauerhaft), sonst OAuth-Fallback.
async function getReadToken(): Promise<string> {
  if (Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')) return getServiceAccountToken()
  return getAccessToken()
}

// ── Drive API Helpers ─────────────────────────────────────────────────────────
async function createFolder(token: string, name: string, parentId?: string): Promise<{ id: string; url: string }> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  }
  if (parentId) metadata.parents = [parentId]

  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  })
  const data = await res.json() as { id?: string; webViewLink?: string; error?: unknown }
  if (!data.id) throw new Error(`Ordner-Erstellung fehlgeschlagen: ${JSON.stringify(data.error)}`)
  return { id: data.id, url: data.webViewLink ?? `https://drive.google.com/drive/folders/${data.id}` }
}

async function shareFolder(token: string, fileId: string, email: string, role: 'reader' | 'writer' = 'writer'): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'user', role, emailAddress: email }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Share fehlgeschlagen: ${JSON.stringify(err)}`)
  }
}

// Dateien/Ordner auflisten — Kinder eines Ordners und/oder Namensfilter.
async function listFiles(token: string, opts: { parentId?: string; nameQuery?: string; foldersOnly?: boolean }): Promise<Array<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }>> {
  const clauses = ['trashed=false']
  if (opts.parentId)   clauses.push(`'${opts.parentId}' in parents`)
  if (opts.nameQuery)  clauses.push(`name contains '${opts.nameQuery.replace(/'/g, "\\'")}'`)
  if (opts.foldersOnly) clauses.push(`mimeType='application/vnd.google-apps.folder'`)
  const q = encodeURIComponent(clauses.join(' and '))
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime),incompleteSearch&pageSize=300&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as { files?: Array<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }>; error?: unknown }
  if (data.error) throw new Error(`Drive-Liste fehlgeschlagen: ${JSON.stringify(data.error)}`)
  return data.files ?? []
}

// Bilder aus einem Ordner (+ 1 Unterordner-Ebene) nach Supabase-Storage importieren.
// Gibt öffentliche URLs + Quell-Unterordner (für Kategorisierung) zurück.
async function importImages(
  token: string,
  supabase: ReturnType<typeof createClient>,
  parentId: string,
  prefix: string,
  limit: number,
): Promise<Array<{ name: string; url: string; folder: string }>> {
  const MAX_BYTES = 12_000_000
  const top = await listFiles(token, { parentId })
  const imgs: Array<{ id: string; name: string; mimeType: string; folder: string; size: number }> = []
  const add = (f: { id: string; name: string; mimeType: string; size?: string }, folder: string) => {
    if (!f.mimeType.startsWith('image/')) return
    const size = f.size ? parseInt(f.size, 10) : 0
    if (size && size > MAX_BYTES) return            // große Renders vorab überspringen
    imgs.push({ id: f.id, name: f.name, mimeType: f.mimeType, folder, size })
  }
  for (const f of top) add(f, '')
  for (const sub of top.filter(f => f.mimeType === 'application/vnd.google-apps.folder')) {
    const kids = await listFiles(token, { parentId: sub.id })
    for (const k of kids) add(k, sub.name)
  }
  const out: Array<{ name: string; url: string; folder: string }> = []
  for (const im of imgs.slice(0, limit)) {
    try {
      // Bytes DIREKT laden (kein Base64 — RAM-schonend)
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${im.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) continue
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length > MAX_BYTES) continue
      const ext  = (im.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
      const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('deck-assets').upload(path, bytes, { contentType: im.mimeType, upsert: false })
      if (error) continue
      const { data } = supabase.storage.from('deck-assets').getPublicUrl(path)
      out.push({ name: im.name, url: data.publicUrl, folder: im.folder })
    } catch { /* einzelne überspringen */ }
  }
  return out
}

// Datei-Inhalt als Base64 holen (Bilder → Storage, PDFs → Claude).
async function downloadFile(token: string, fileId: string): Promise<{ base64: string; mimeType: string; name: string }> {
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
  const meta = await metaRes.json() as { name?: string; mimeType?: string }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`)
  const buf = new Uint8Array(await res.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode(...buf.subarray(i, i + chunk))
  return { base64: btoa(binary), mimeType: meta.mimeType ?? 'application/octet-stream', name: meta.name ?? 'file' }
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const parentQuery = parentId ? ` and '${parentId}' in parents` : " and 'root' in parents"
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQuery}`)
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json() as { files?: Array<{ id: string }> }
  return data.files?.[0]?.id ?? null
}

// ── Root-Ordner-ID aus DB holen oder anlegen ──────────────────────────────────
async function ensureRootFolder(token: string, supabase: ReturnType<typeof createClient>): Promise<string> {
  // In settings speichern damit wir ihn nicht immer neu suchen müssen
  const { data: setting } = await supabase
    .from('crm_settings')
    .select('value')
    .eq('key', 'google_drive_root_folder_id')
    .maybeSingle()

  if (setting?.value) return setting.value as string

  // In Drive suchen
  const ROOT_NAME = 'Happy Property – Deals'
  let rootId = await findFolder(token, ROOT_NAME)

  if (!rootId) {
    const { id } = await createFolder(token, ROOT_NAME)
    rootId = id
  }

  // In Settings speichern
  await supabase.from('crm_settings').upsert({ key: 'google_drive_root_folder_id', value: rootId })
  return rootId
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const body = await req.json() as {
      action:           'create_folder' | 'share_folder' | 'ensure_root' | 'create_deal_folder' | 'list_files' | 'download_file' | 'import_images'
      folder_name?:     string
      parent_folder_id?: string
      file_id?:         string
      name_query?:      string              // für list_files (Namensfilter)
      folders_only?:    boolean             // für list_files
      prefix?:          string              // für import_images (Storage-Pfad-Präfix)
      limit?:           number              // für import_images
      share_with?:      string | string[]   // eine oder mehrere E-Mails
      role?:            'reader' | 'writer'
      deal_id?:         string              // für create_deal_folder
    }

    // Lese-Aktionen über Service-Account (dauerhaft); Schreib-Aktionen über OAuth.
    const token = (body.action === 'list_files' || body.action === 'download_file' || body.action === 'import_images')
      ? await getReadToken()
      : await getAccessToken()

    // ── ensure_root ───────────────────────────────────────────────────────────
    if (body.action === 'ensure_root') {
      const rootId = await ensureRootFolder(token, supabase)
      return new Response(
        JSON.stringify({ ok: true, folder_id: rootId, url: `https://drive.google.com/drive/folders/${rootId}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── create_folder ─────────────────────────────────────────────────────────
    if (body.action === 'create_folder') {
      if (!body.folder_name) throw new Error('folder_name fehlt')
      const { id, url } = await createFolder(token, body.folder_name, body.parent_folder_id)
      return new Response(
        JSON.stringify({ ok: true, folder_id: id, url }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── share_folder ──────────────────────────────────────────────────────────
    if (body.action === 'share_folder') {
      if (!body.file_id) throw new Error('file_id fehlt')
      const emails = Array.isArray(body.share_with)
        ? body.share_with
        : body.share_with ? [body.share_with] : []
      for (const email of emails) {
        await shareFolder(token, body.file_id, email, body.role ?? 'writer')
      }
      return new Response(
        JSON.stringify({ ok: true, shared_with: emails }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── create_deal_folder ────────────────────────────────────────────────────
    // Komplett-Workflow: Root sicherstellen → Ordner anlegen → Deal updaten → optional teilen
    if (body.action === 'create_deal_folder') {
      if (!body.deal_id) throw new Error('deal_id fehlt')
      if (!body.folder_name) throw new Error('folder_name fehlt')

      // Prüfen ob Deal schon einen Drive-Ordner hat
      const { data: deal } = await supabase
        .from('deals')
        .select('id, google_drive_url, google_drive_folder_id')
        .eq('id', body.deal_id)
        .maybeSingle()

      if (deal?.google_drive_folder_id) {
        // Bereits vorhanden — einfach zurückgeben
        return new Response(
          JSON.stringify({
            ok: true,
            folder_id:  deal.google_drive_folder_id,
            url:        deal.google_drive_url,
            existing:   true,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Root-Ordner sicherstellen
      const rootId = await ensureRootFolder(token, supabase)

      // Deal-Ordner anlegen
      const { id: folderId, url } = await createFolder(token, body.folder_name, rootId)

      // Optional teilen
      const emails = Array.isArray(body.share_with)
        ? body.share_with
        : body.share_with ? [body.share_with] : []
      for (const email of emails) {
        await shareFolder(token, folderId, email, body.role ?? 'writer')
      }

      // Deal in DB updaten
      await supabase.from('deals').update({
        google_drive_url:       url,
        google_drive_folder_id: folderId,
      }).eq('id', body.deal_id)

      console.log('[google-drive] Ordner erstellt:', { folderId, url, deal_id: body.deal_id })

      return new Response(
        JSON.stringify({ ok: true, folder_id: folderId, url, existing: false }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── list_files ────────────────────────────────────────────────────────────
    if (body.action === 'list_files') {
      const files = await listFiles(token, {
        parentId:    body.parent_folder_id,
        nameQuery:   body.name_query,
        foldersOnly: body.folders_only,
      })
      return new Response(
        JSON.stringify({ ok: true, files }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── download_file ─────────────────────────────────────────────────────────
    if (body.action === 'download_file') {
      if (!body.file_id) throw new Error('file_id fehlt')
      const f = await downloadFile(token, body.file_id)
      return new Response(
        JSON.stringify({ ok: true, ...f }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── import_images ─────────────────────────────────────────────────────────
    if (body.action === 'import_images') {
      if (!body.parent_folder_id) throw new Error('parent_folder_id fehlt')
      const images = await importImages(token, supabase, body.parent_folder_id, body.prefix ?? body.parent_folder_id, body.limit ?? 14)
      return new Response(
        JSON.stringify({ ok: true, images }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ error: `Unbekannte action: ${body.action}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[google-drive] Fehler:', err)
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
