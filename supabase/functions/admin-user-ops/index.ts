// Edge Function: admin-user-ops
// Führt privilegierte Nutzer-Operationen server-seitig aus.
// Kein Service-Role-Key im Browser nötig.
//
// Aktionen:
//   create         → Auth-User + Profil anlegen, Passwort zurückgeben
//   delete_user    → Auth-User + Profil löschen
//   reset_password → Neues Passwort setzen, zurückgeben
//                    (optional sendEmail:true → Zugangsdaten per E-Mail an den Nutzer)
//   list_auth_ids  → Liste aller Auth-User-IDs (für Orphan-Cleanup)
//
// Deployment:
//   supabase functions deploy admin-user-ops --no-verify-jwt
//
// ── Secrets (für sendEmail) ──
//   SMTP_USER  = sven@happy-property.com
//   SMTP_PASS  = [Ionos Passwort]
//   APP_URL    = https://portal.happy-property.com

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SMTPClient }   from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  const arr   = new Uint8Array(14)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => chars[b % chars.length]).join('')
}

// ── Zugangsdaten-E-Mail (neues Passwort) ──────────────────────────────────────
function buildAccessEmail(fullName: string, email: string, password: string, appUrl: string): string {
  const firstName = (fullName?.split(' ')[0]) || 'Hallo'
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background:#ff795d;padding:32px 40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;">Happy Property</h1>
          <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Dein persönliches Portal</p>
        </td></tr>
        <tr><td style="padding:40px 40px 32px;">
          <p style="margin:0 0 16px;font-size:16px;color:#374151;">Hallo <strong>${firstName}</strong>,</p>
          <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
            dein Passwort wurde zurückgesetzt. Du kannst dich ab sofort mit folgenden Zugangsdaten anmelden:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;border-radius:12px;padding:24px;margin-bottom:24px;">
            <tr><td>
              <p style="margin:0 0 12px;font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Deine Zugangsdaten</p>
              <table cellpadding="0" cellspacing="0">
                <tr><td style="padding:4px 0;font-size:14px;color:#6b7280;width:110px;">Benutzername:</td>
                    <td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${email}</td></tr>
                <tr><td style="padding:4px 0;font-size:14px;color:#6b7280;">Passwort:</td>
                    <td style="padding:4px 8px;font-size:15px;color:#111827;font-weight:700;background:#fff;border-radius:6px;font-family:monospace;">${password}</td></tr>
              </table>
            </td></tr>
          </table>
          <p style="margin:0 0 24px;font-size:14px;color:#ef4444;font-weight:500;">⚠️ Bitte ändere dein Passwort direkt nach dem ersten Login.</p>
          <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
            <a href="${appUrl}/login" style="display:inline-block;background:#ff795d;color:#fff;font-size:15px;font-weight:600;padding:14px 36px;border-radius:12px;text-decoration:none;">Jetzt anmelden →</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:24px 40px;border-top:1px solid #f3f4f6;text-align:center;">
          <p style="margin:0;font-size:12px;color:#d1d5db;">© ${new Date().getFullYear()} Happy Property · Bei Fragen antworte einfach auf diese E-Mail.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

async function sendAccessEmail(fullName: string, email: string, password: string): Promise<boolean> {
  const smtpUser = Deno.env.get('SMTP_USER') ?? ''
  const smtpPass = Deno.env.get('SMTP_PASS') ?? ''
  const appUrl   = Deno.env.get('APP_URL') ?? 'https://portal.happy-property.com'
  if (!smtpUser || !smtpPass) {
    console.warn('[admin-user-ops] SMTP nicht konfiguriert – E-Mail simuliert an:', email)
    return false
  }
  const client = new SMTPClient({
    connection: { hostname: 'smtp.ionos.de', port: 465, tls: true, auth: { username: smtpUser, password: smtpPass } },
  })
  try {
    await client.send({
      from:    `Sven von Happy Property Cyprus <${smtpUser}>`,
      to:      email,
      subject: 'Deine neuen Zugangsdaten – Happy Property Portal',
      html:    buildAccessEmail(fullName, email, password, appUrl),
      content: `Hallo ${(fullName?.split(' ')[0]) || ''},\n\ndein Passwort wurde zurückgesetzt.\nE-Mail: ${email}\nPasswort: ${password}\n\nBitte ändere dein Passwort nach dem ersten Login.\nPortal: ${appUrl}/login`,
    })
    console.log('[admin-user-ops] ✓ Zugangsdaten-E-Mail gesendet an:', email)
    return true
  } finally {
    await client.close()
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin          = createClient(supabaseUrl, serviceRoleKey)

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    const body   = await req.json()
    const action = body.action as string

    // ── Auth-Guard ──────────────────────────────────────────────────────────────
    // Diese Function läuft mit --no-verify-jwt; daher MUSS die Rolle hier server-seitig
    // geprüft werden — sonst könnte jeder mit dem öffentlichen anon-Key Accounts anlegen,
    // fremde Passwörter zurücksetzen oder Nutzer löschen. Nur eingeloggte Admins dürfen;
    // Feriengast-Einladung darf zusätzlich ein Verwalter auslösen (Buchungs-Flow).
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    const caller = jwt
      ? (await createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '').auth.getUser(jwt)).data.user
      : null
    if (!caller) return json({ error: 'Nicht autorisiert' }, 401)
    const { data: callerProfile } = await admin.from('profiles').select('role').eq('id', caller.id).maybeSingle()
    const callerRole = (callerProfile as { role?: string } | null)?.role ?? ''
    const allowed = callerRole === 'admin' || (action === 'invite_feriengast' && callerRole === 'verwalter')
    if (!allowed) return json({ error: 'Keine Berechtigung für diese Aktion' }, 403)

    // ── CREATE ──────────────────────────────────────────────────────────────────
    if (action === 'create') {
      const {
        email, full_name, role = 'eigentuemer', language = 'de',
        phone, address_street, address_zip, address_city, address_country,
        iban, bic, bank_account_holder,
      } = body

      if (!email || !full_name) {
        return json({ error: 'email und full_name sind Pflichtfelder' }, 400)
      }

      const password = generatePassword()

      // Schnelle Prüfung per profiles-Tabelle statt listUsers
      const { data: existingProfile } = await admin
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle()

      let userId: string

      if (existingProfile) {
        // User existiert → Passwort aktualisieren
        const { error } = await admin.auth.admin.updateUserById(
          (existingProfile as { id: string }).id,
          { password, user_metadata: { full_name, needs_password_setup: true } },
        )
        if (error) throw error
        userId = (existingProfile as { id: string }).id
      } else {
        // Neuen User anlegen
        const { data: created, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name, needs_password_setup: true },
        })
        if (error) throw error
        userId = created.user.id
      }

      // Profil anlegen / aktualisieren
      const { error: profileErr } = await admin.from('profiles').upsert({
        id:                  userId,
        email,
        full_name,
        role,
        language,
        phone:               phone               || null,
        address_street:      address_street      || null,
        address_zip:         address_zip         || null,
        address_city:        address_city        || null,
        address_country:     address_country     || null,
        iban:                iban                || null,
        bic:                 bic                 || null,
        bank_account_holder: bank_account_holder || null,
        is_active:           true,
      }, { onConflict: 'id' })

      if (profileErr) throw new Error(profileErr.message)

      return json({ success: true, userId, password })
    }

    // ── DELETE USER ─────────────────────────────────────────────────────────────
    if (action === 'delete_user') {
      const { userId } = body
      if (!userId) return json({ error: 'userId erforderlich' }, 400)

      const { error: authErr } = await admin.auth.admin.deleteUser(userId)
      if (authErr) throw new Error(authErr.message)

      // Profil explizit löschen (Fallback falls kein CASCADE)
      await admin.from('profiles').delete().eq('id', userId)

      return json({ success: true })
    }

    // ── RESET PASSWORD ──────────────────────────────────────────────────────────
    if (action === 'reset_password') {
      const { userId, sendEmail } = body
      if (!userId) return json({ error: 'userId erforderlich' }, 400)

      const password = generatePassword()
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password,
        user_metadata: { needs_password_setup: true },
      })
      if (error) throw new Error(error.message)

      // Optional: Zugangsdaten dem Nutzer per E-Mail schicken (Rolle bleibt unangetastet)
      let emailed = false
      if (sendEmail) {
        const { data: prof } = await admin
          .from('profiles').select('email, full_name').eq('id', userId).maybeSingle()
        const p = prof as { email: string | null; full_name: string | null } | null
        if (p?.email) {
          try {
            emailed = await sendAccessEmail(p.full_name ?? '', p.email, password)
          } catch (mailErr) {
            console.error('[admin-user-ops] E-Mail-Versand fehlgeschlagen:', mailErr)
          }
        }
      }

      return json({ success: true, password, emailed })
    }

    // ── LIST AUTH IDS (für Orphan-Cleanup) ──────────────────────────────────────
    if (action === 'list_auth_ids') {
      const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 })
      if (error) throw new Error(error.message)
      return json({ ids: data.users.map((u: { id: string }) => u.id) })
    }

    // ── DELETE PROFILE ONLY (Orphan-Cleanup) ────────────────────────────────────
    if (action === 'delete_profile') {
      const { profileId } = body
      if (!profileId) return json({ error: 'profileId erforderlich' }, 400)
      await admin.from('profiles').delete().eq('id', profileId)
      return json({ success: true })
    }

    // ── INVITE FERIENGAST ────────────────────────────────────────────────────────
    if (action === 'invite_feriengast') {
      const { email, full_name, phone, language, nationality, redirectTo } = body
      if (!email || !full_name) {
        return json({ error: 'email und full_name sind Pflichtfelder' }, 400)
      }

      // Check if user already exists
      const { data: existingProfile } = await admin
        .from('profiles')
        .select('id')
        .eq('email', email.trim().toLowerCase())
        .maybeSingle()

      if (existingProfile) {
        return json({ success: true, userId: (existingProfile as { id: string }).id, existing: true })
      }

      const { data: authData, error: authErr } = await admin.auth.admin.inviteUserByEmail(
        email.trim().toLowerCase(),
        {
          data: { full_name, needs_password_setup: true },
          redirectTo: redirectTo ?? `${Deno.env.get('SITE_URL') ?? ''}/set-password`,
        }
      )
      if (authErr) throw new Error(authErr.message)

      const userId = authData.user.id
      const { error: profileErr } = await admin.from('profiles').upsert({
        id:          userId,
        email:       email.trim().toLowerCase(),
        full_name,
        phone:       phone        || null,
        language:    language     || 'de',
        nationality: nationality  || null,
        role:        'feriengast',
        is_active:   true,
      }, { onConflict: 'id' })
      if (profileErr) throw new Error(profileErr.message)

      return json({ success: true, userId, existing: false })
    }

    return json({ error: `Unbekannte Aktion: ${action}` }, 400)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[admin-user-ops]', msg)
    return json({ error: msg }, 500)
  }
})
