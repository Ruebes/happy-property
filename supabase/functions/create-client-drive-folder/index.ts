// Supabase Edge Function: create-client-drive-folder
// Legt pro Kunde (Lead) einen Google-Drive-Ordner unter "Happy Property Kunden" an
// und teilt ihn mit Kunde + Sven (+ optionale Mails). Ordner wird wiederverwendet,
// wenn der Lead schon einen hat (über mehrere Pipeline-Stages hinweg).
//
// Auth: Google Service Account (GOOGLE_SERVICE_ACCOUNT_JSON), Scope drive (Schreibrecht).
// Parent: GOOGLE_DRIVE_PARENT_FOLDER_ID (Secret) → sonst crm_settings → sonst Default.
// Der Service Account muss EDITOR auf dem Parent-Ordner sein.
//
// Body:   { lead_id, extra_emails?: string[] }
// Antwort:{ ok, folder_id, folder_url, existing }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Svens GOOGLE-Konto (nicht die CRM-Mail sven@happy-property.com — die ist kein
// Google-Konto, Teilen darauf schlägt fehl). Per Secret überschreibbar.
const OWNER_EMAIL    = Deno.env.get('GOOGLE_DRIVE_OWNER_EMAIL') || 'happypropertycyprus@gmail.com'
const PARENT_DEFAULT = '1IdozSH0SnMVSrQgaJXyQSlSJHoIWbri4'   // "Happy Property Kunden" (vom SA bestätigt)
const isEmail = (e: unknown): e is string => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim())

// ── Service-Account-Token (Scope drive = Schreibrecht) ───────────────────────────
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
async function getWriteToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string }
  const now = Math.floor(Date.now() / 1000)
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const key = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const data = await res.json() as { access_token?: string; error_description?: string }
  if (!data.access_token) throw new Error(`SA-Token: ${data.error_description ?? 'unbekannt'}`)
  return data.access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const { lead_id, extra_emails } = await req.json() as { lead_id?: string; extra_emails?: string[] }
    if (!lead_id) return json({ error: 'lead_id fehlt' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: lead, error: leadErr } = await supabase
      .from('leads').select('id, first_name, last_name, email, drive_folder_id, drive_folder_url').eq('id', lead_id).maybeSingle()
    if (leadErr) return json({ error: `Lead: ${leadErr.message}` }, 500)
    if (!lead) return json({ error: 'Lead nicht gefunden' }, 404)

    // Wiederverwendung: schon ein Ordner vorhanden → den zurückgeben.
    if (lead.drive_folder_id) {
      return json({ ok: true, folder_id: lead.drive_folder_id, folder_url: lead.drive_folder_url, existing: true })
    }

    // Parent-Ordner: Secret → crm_settings → Default.
    let parentId = Deno.env.get('GOOGLE_DRIVE_PARENT_FOLDER_ID') || ''
    if (!parentId) {
      const { data: s } = await supabase.from('crm_settings').select('value').eq('key', 'drive_clients_parent_folder_id').maybeSingle()
      parentId = (s?.value as string) || PARENT_DEFAULT
    }

    const token = await getWriteToken()
    const name = [lead.last_name, lead.first_name].map(x => (x ?? '').trim()).filter(Boolean).join(', ') || lead.email || `Kunde ${lead_id.slice(0, 8)}`

    // 1) Ordner anlegen
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink&supportsAllDrives=true', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    })
    const created = await createRes.json() as { id?: string; webViewLink?: string; error?: { message?: string } }
    if (!createRes.ok || !created.id) {
      return json({ error: `Ordner-Anlage fehlgeschlagen: ${created.error?.message ?? createRes.status}. Hat der Service Account Editor-Rechte auf dem Parent-Ordner?` }, 502)
    }
    const folderId  = created.id
    const folderUrl = created.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`

    // 2) Schreibrechte verteilen (ohne Benachrichtigungsmail — Sven entscheidet, wann der Kunde informiert wird)
    // Kunde + Google-Owner (happypropertycyprus@gmail.com) + Sven + zusätzliche Empfänger
    const emails = Array.from(new Set([lead.email, OWNER_EMAIL, 'sven@happy-property.com', ...(Array.isArray(extra_emails) ? extra_emails : [])]
      .map(e => (e ?? '').trim()).filter(isEmail)))
    const shared: string[] = []
    const shareErrors: Record<string, string> = {}
    for (const email of emails) {
      try {
        const pr = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
        })
        if (pr.ok) shared.push(email)
        else { const e = await pr.json().catch(() => ({})) as { error?: { message?: string } }; shareErrors[email] = e.error?.message ?? `HTTP ${pr.status}` }
      } catch (e) { shareErrors[email] = (e as Error).message }
    }

    // 3) Am Lead speichern
    const { error: upErr } = await supabase.from('leads').update({ drive_folder_id: folderId, drive_folder_url: folderUrl }).eq('id', lead_id)
    if (upErr) return json({ error: `Speichern am Lead fehlgeschlagen: ${upErr.message}`, folder_id: folderId, folder_url: folderUrl }, 500)

    return json({ ok: true, folder_id: folderId, folder_url: folderUrl, existing: false, name, shared, shareErrors })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
