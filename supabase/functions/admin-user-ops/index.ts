// Edge Function: admin-user-ops
// Führt privilegierte Nutzer-Operationen server-seitig aus.
// Kein Service-Role-Key im Browser nötig.
//
// Aktionen:
//   create         → Auth-User + Profil anlegen, Passwort zurückgeben
//   delete_user    → Auth-User + Profil löschen
//   reset_password → Neues Passwort setzen, zurückgeben
//   list_auth_ids  → Liste aller Auth-User-IDs (für Orphan-Cleanup)
//
// Deployment:
//   supabase functions deploy admin-user-ops --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'

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
      const { userId } = body
      if (!userId) return json({ error: 'userId erforderlich' }, 400)

      const password = generatePassword()
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password,
        user_metadata: { needs_password_setup: true },
      })
      if (error) throw new Error(error.message)

      return json({ success: true, password })
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

    return json({ error: `Unbekannte Aktion: ${action}` }, 400)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[admin-user-ops]', msg)
    return json({ error: msg }, 500)
  }
})
