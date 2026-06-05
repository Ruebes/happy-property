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
      action:           'create_folder' | 'share_folder' | 'ensure_root' | 'create_deal_folder'
      folder_name?:     string
      parent_folder_id?: string
      file_id?:         string
      share_with?:      string | string[]   // eine oder mehrere E-Mails
      role?:            'reader' | 'writer'
      deal_id?:         string              // für create_deal_folder
    }

    const token = await getAccessToken()

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
