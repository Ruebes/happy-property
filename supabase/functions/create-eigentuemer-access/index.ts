// Edge Function: create-eigentuemer-access
// Erstellt einen neuen Eigentümer-Account und sendet die Zugangsdaten per E-Mail.
//
// Request body:
//   { email: string, full_name: string, unit_id?: string }
//
// ── Deployment ──
//   supabase functions deploy create-eigentuemer-access --no-verify-jwt
//
// ── Secrets ──
//   SMTP_USER  = sven@happy-property.com
//   SMTP_PASS  = [Ionos Passwort]
//   APP_URL    = https://portal.happy-property.com  (Produktions-Portal; NIEMALS happy-property.app — tote Domain)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SMTPClient }   from 'https://deno.land/x/denomailer@1.6.0/mod.ts'
import { encodeMimeSubject } from '../_shared/mimeSubject.ts'
import { buildMimeContent } from '../_shared/mimeBody.ts'
import { SOCIAL_FOOTER_HTML } from '../_shared/socialFooter.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Zufälliges Passwort (12 Zeichen, alphanumerisch + Sonderzeichen) ──────────
function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  const arr   = new Uint8Array(12)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => chars[b % chars.length]).join('')
}

// ── Platzhalter ersetzen ─────────────────────────────────────────────────────
function replacePlaceholders(text: string, vars: Record<string, string>): string {
  return text
    .replace(/\{\{vorname\}\}/g,   vars.vorname   ?? '')
    .replace(/\{\{name\}\}/g,      vars.name      ?? '')
    .replace(/\{\{email\}\}/g,     vars.email     ?? '')
    .replace(/\{\{password\}\}/g,  vars.password  ?? '')
    .replace(/\{\{login_url\}\}/g, vars.login_url ?? '')
}

// Plaintext → HTML-Absätze
function textToHtml(text: string): string {
  return text
    .split('\n')
    .map(line =>
      line.trim() === ''
        ? '<br>'
        : `<p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6;">${
            line
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
          }</p>`
    )
    .join('\n')
}

// ── Willkommens-E-Mail HTML ───────────────────────────────────────────────────
function buildWelcomeEmail(params: {
  fullName:      string
  email:         string
  password:      string
  appUrl:        string
  customSubject?: string
  customMessage?: string
}): { subject: string; html: string } {
  const { fullName, email, password, appUrl, customSubject, customMessage } = params
  const firstName = fullName.split(' ')[0]
  const subject   = customSubject?.trim() || 'Dein Zugang zum Happy Property Portal'

  // Benutzerdefinierter oder Standard-Nachrichtentext
  let bodyHtml: string
  if (customMessage?.trim()) {
    const vars = { vorname: firstName, name: fullName, email, password, login_url: `${appUrl}/login` }
    bodyHtml = textToHtml(replacePlaceholders(customMessage, vars))
  } else {
    bodyHtml = `
      <p style="margin:0 0 16px;font-size:16px;color:#374151;">
        Hallo <strong>${firstName}</strong>,
      </p>
      <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
        dein Zugang zum Happy Property Eigentümer-Portal ist jetzt eingerichtet.
        Du kannst dich ab sofort mit folgenden Zugangsdaten anmelden:
      </p>`
  }

  const html = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#ff795d;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
              Happy Property
            </h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">
              Ihr persönliches Eigentümer-Portal
            </p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 32px;">
            ${bodyHtml}

            <!-- Credentials box -->
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="background:#f3f4f6;border-radius:12px;padding:24px;margin-bottom:24px;">
              <tr>
                <td>
                  <p style="margin:0 0 12px;font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">
                    Ihre Zugangsdaten
                  </p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:4px 0;font-size:14px;color:#6b7280;width:110px;">Benutzername:</td>
                      <td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${email}</td>
                    </tr>
                    <tr>
                      <td style="padding:4px 0;font-size:14px;color:#6b7280;">Passwort:</td>
                      <td style="padding:4px 8px;font-size:15px;color:#111827;font-weight:700;
                                 background:#fff;border-radius:6px;letter-spacing:0.5px;font-family:monospace;">
                        ${password}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 24px;font-size:14px;color:#ef4444;font-weight:500;">
              ⚠️ Bitte ändern Sie Ihr Passwort direkt nach dem ersten Login.
            </p>

            <!-- CTA Button -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center">
                  <a href="${appUrl}/login"
                     style="display:inline-block;background:#ff795d;color:#ffffff;
                            font-size:15px;font-weight:600;padding:14px 36px;
                            border-radius:12px;text-decoration:none;letter-spacing:-0.2px;">
                    Jetzt anmelden →
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:32px 0 0;font-size:13px;color:#9ca3af;line-height:1.5;">
              Im Portal haben Sie Zugriff auf Ihre Immobiliendaten, Kaufunterlagen
              und Zahlungsübersichten.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:24px 40px;border-top:1px solid #f3f4f6;text-align:center;">
            <p style="margin:0;font-size:12px;color:#d1d5db;">
              © ${new Date().getFullYear()} Happy Property · Bei Fragen antworten Sie einfach auf diese E-Mail.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
  ${SOCIAL_FOOTER_HTML}
</body>
</html>`
  return { subject, html }
}

// Auth-User per E-Mail über ALLE Seiten suchen (listUsers ist paginiert; ohne
// Schleife wird ab dem 51. Nutzer keiner gefunden → Resend/Reset schlug fehl).
async function findAuthUserByEmail(admin: ReturnType<typeof createClient>, email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    const users = data?.users ?? []
    const hit = users.find(u => (u.email ?? '').trim().toLowerCase() === email)
    if (hit) return hit
    if (users.length < 1000) break
  }
  return null
}

// ── Main ──────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  try {
    const { email: rawEmail, full_name, custom_subject, custom_message } = await req.json() as {
      email:           string
      full_name:       string
      custom_subject?: string   // optionaler Betreff (aus Template)
      custom_message?: string   // optionaler E-Mail-Text mit Platzhaltern
    }
    // E-Mail konsequent normalisieren — sonst führen " Foo@X.de" vs. "foo@x.de" zu
    // profiles↔auth-Mismatch und „Nutzer nicht gefunden".
    const email = (rawEmail ?? '').trim().toLowerCase()

    if (!email || !full_name) {
      return new Response(
        JSON.stringify({ error: 'email und full_name sind Pflichtfelder' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // ── Auth-Guard ──────────────────────────────────────────────────────────────
    // Läuft mit --no-verify-jwt; daher Rolle server-seitig prüfen. Diese Function legt
    // Konten an / setzt Passwörter zurück — NUR eingeloggte Admins dürfen sie aufrufen
    // (sonst Account-Übernahme/Spam über den öffentlichen anon-Key möglich).
    {
      const guardUrl  = Deno.env.get('SUPABASE_URL')!
      const authHeader = req.headers.get('Authorization') ?? ''
      const jwt = authHeader.replace(/^Bearer\s+/i, '')
      const caller = jwt
        ? (await createClient(guardUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '').auth.getUser(jwt)).data.user
        : null
      const respHdr = { ...CORS, 'Content-Type': 'application/json' }
      if (!caller) return new Response(JSON.stringify({ error: 'Nicht autorisiert' }), { status: 401, headers: respHdr })
      const guardAdmin = createClient(guardUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: cProf } = await guardAdmin.from('profiles').select('role').eq('id', caller.id).maybeSingle()
      if ((cProf as { role?: string } | null)?.role !== 'admin') {
        return new Response(JSON.stringify({ error: 'Keine Berechtigung' }), { status: 403, headers: respHdr })
      }
    }

    const supabaseUrl        = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const smtpUser           = Deno.env.get('SMTP_USER') ?? ''
    const smtpPass           = Deno.env.get('SMTP_PASS') ?? ''
    const appUrl             = Deno.env.get('APP_URL') ?? 'https://portal.happy-property.com'

    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    // ── 1. Passwort generieren ─────────────────────────────────────────────────
    const password = generatePassword()
    console.log(`[create-eigentuemer-access] Erstelle Account für: ${email}`)

    // ── 2. Auth-User erstellen (oder vorhandenen wiederverwenden) ─────────────
    let userId: string

    // Prüfen ob User bereits existiert (paginiert — findet auch Nutzer > Seite 1)
    const existingUser = await findAuthUserByEmail(adminClient, email)

    if (existingUser) {
      // Passwort aktualisieren + needs_password_setup setzen
      const { error: updateErr } = await adminClient.auth.admin.updateUserById(
        existingUser.id,
        {
          password,
          user_metadata: {
            ...existingUser.user_metadata,
            full_name,
            needs_password_setup: true,
          },
        }
      )
      if (updateErr) throw updateErr
      userId = existingUser.id
      console.log(`[create-eigentuemer-access] Bestehenden User aktualisiert: ${userId}`)
    } else {
      // Neuen User anlegen
      const { data: newUserData, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name,
          needs_password_setup: true,
        },
      })
      if (createErr) throw createErr
      userId = newUserData.user.id
      console.log(`[create-eigentuemer-access] Neuer User erstellt: ${userId}`)
    }

    // ── 3. Profil anlegen / aktualisieren ─────────────────────────────────────
    const { error: profileErr } = await adminClient.from('profiles').upsert({
      id:                   userId,
      email,
      full_name,
      role:                 'eigentuemer',
      is_active:            true,
      language:             'de',
    }, { onConflict: 'id' })

    if (profileErr) {
      console.warn('[create-eigentuemer-access] Profil-Upsert Fehler:', profileErr.message)
      // Nicht fatal – User existiert, Profil kann manuell angelegt werden
    }

    // ── 3b. Lead↔Profil verknüpfen + Portal-Objekte nachziehen ────────────────
    // Wird eine Wohnung VOR dem Portalzugang zugewiesen (Normalfall), existiert kein
    // Eigentümer-Profil → handleUnitAssign legt keine `properties`-Zeile an, und der
    // Eigentümer sieht im Portal NICHTS. Hier holen wir das beim Zugang-Anlegen nach:
    // Lead per E-Mail finden, profile_id setzen und für jede zugewiesene Deal-Wohnung
    // eine Property (owner_id = neuer User) erzeugen/zuordnen. Idempotent.
    try {
      // Lead über Haupt- ODER Zweit-Mail finden; bei mehreren Treffern den ältesten
      // nehmen (maybeSingle brach bei Dubletten → Backfill wurde still übersprungen).
      let leadRow: { id: string } | null = null
      const { data: byMain } = await adminClient.from('leads')
        .select('id, created_at').ilike('email', email).order('created_at', { ascending: true }).limit(1)
      leadRow = (byMain?.[0] as { id: string } | undefined) ?? null
      if (!leadRow) {
        const { data: byAlt } = await adminClient.from('leads')
          .select('id, created_at').contains('alt_emails', [email]).order('created_at', { ascending: true }).limit(1)
        leadRow = (byAlt?.[0] as { id: string } | undefined) ?? null
      }
      if (leadRow) {
        const leadId = leadRow.id
        await adminClient.from('leads').update({ profile_id: userId }).eq('id', leadId).is('profile_id', null)
        const { data: deals } = await adminClient.from('deals')
          .select('id, unit_id, property_id').eq('lead_id', leadId).not('unit_id', 'is', null)
        for (const d of (deals ?? []) as Array<{ id: string; unit_id: string; property_id: string | null }>) {
          const { data: unit } = await adminClient.from('crm_project_units')
            .select('id, unit_number, bedrooms, size_sqm, terrace_sqm, floor, type, rental_type, is_furnished, price_net, price_gross, status, block, property_id, project:crm_projects(name, location)')
            .eq('id', d.unit_id).maybeSingle()
          if (!unit) continue
          const u = unit as Record<string, unknown> & { property_id?: string | null; project?: { name?: string; location?: string } | null }
          if (u.property_id) {
            // Property existiert schon → Eigentümer auf den aktuellen Zugang setzen.
            // KEIN .is('owner_id', null)-Guard mehr: die Property gehört zur Deal-Unit
            // GENAU dieses Leads; ein zweiter/abweichender Account (andere Mail) bekam
            // die Wohnung sonst nie zu sehen (owner_id blieb am alten/verwaisten Konto).
            await adminClient.from('properties').update({ owner_id: userId }).eq('id', u.property_id as string)
            continue
          }
          const loc = u.project?.location ?? null
          const { data: newProp } = await adminClient.from('properties').insert({
            project_name:         u.project?.name ?? '',
            unit_number:          (u.unit_number as string) ?? null,
            type:                 (u.type as string) ?? 'apartment',
            bedrooms:             (u.bedrooms as number) ?? 0,
            size_sqm:             u.size_sqm ?? null,
            terrace_sqm:          u.terrace_sqm ?? null,
            floor:                u.floor ?? null,
            block:                (u.block as string) ?? null,
            is_furnished:         (u.is_furnished as boolean) ?? false,
            rental_type:          u.rental_type === 'short' ? 'shortterm' : 'longterm',
            city:                 (typeof loc === 'string' && !loc.startsWith('http')) ? loc : null,
            purchase_price_net:   u.price_net ?? null,
            purchase_price_gross: u.price_gross ?? null,
            property_status:      u.status === 'under_construction' ? 'under_construction' : 'active',
            owner_id:             userId,
            created_by:           userId,
            images:               [],
          }).select('id').single()
          if (newProp) {
            const pid = (newProp as { id: string }).id
            await adminClient.from('crm_project_units').update({ property_id: pid }).eq('id', u.id as string)
            await adminClient.from('deals').update({ property_id: pid }).eq('id', d.id)
          }
        }
      }
    } catch (linkErr) {
      console.warn('[create-eigentuemer-access] Property-Backfill Fehler:', (linkErr as Error).message)
    }

    // ── 4. Willkommens-E-Mail bauen ───────────────────────────────────────────
    // Vorrang: per-Send-Customizing (custom_message). Sonst die editierbare
    // DB-Vorlage „Portal-Zugang". Sicherheitsnetz: enthält das gerenderte
    // Ergebnis das Passwort nicht (Platzhalter entfernt), bleibt der fest
    // eingebaute Fallback — die Zugangsdaten gehen NIE verloren.
    let mail = buildWelcomeEmail({
      fullName:      full_name,
      email,
      password,
      appUrl,
      customSubject: custom_subject,
      customMessage: custom_message,
    })
    if (!custom_message?.trim()) {
      try {
        const { data: tpl } = await adminClient.from('email_templates')
          .select('subject, html_body').eq('id', '37b1724c-f71c-4e8b-9116-b92d18f03915').maybeSingle()
        const raw = (tpl?.html_body as string | null | undefined)?.trim()
        if (raw) {
          const firstName = full_name.split(' ')[0]
          const vars: Record<string, string> = { vorname: firstName, name: full_name, email, password, login_url: `${appUrl}/login` }
          let h = raw, s = (tpl?.subject as string | undefined)?.trim() || mail.subject
          for (const [k, v] of Object.entries(vars)) { h = h.split(`{{${k}}}`).join(v); s = s.split(`{{${k}}}`).join(v) }
          if (h.includes(password)) mail = { subject: s, html: h }
        }
      } catch { /* Vorlage nicht ladbar → Fallback bleibt */ }
    }
    const { subject, html } = mail

    // Mailversand darf die Funktion NICHT zum Scheitern bringen: das Passwort ist
    // oben bereits gesetzt — würde ein SMTP-Fehler hier zu 500 führen, wäre der Kunde
    // ausgesperrt ohne Zugangsdaten. Stattdessen `emailed`-Flag + Passwort zurückgeben,
    // damit der Admin die Daten im UI sieht und gezielt handeln kann.
    let emailed = false
    if (smtpUser && smtpPass) {
      const client = new SMTPClient({
        connection: {
          hostname: 'smtp.ionos.de',
          port:     465,
          tls:      true,
          auth: { username: smtpUser, password: smtpPass },
        },
      })
      try {
        await client.send({
          from:    `Sven von Happy Property Cyprus <${smtpUser}>`,
          to:      email,
          subject: encodeMimeSubject(subject),
          // Base64-mimeContent statt html/content — umgeht denomailers kaputten QP-Encoder (mimeBody.ts).
          mimeContent: buildMimeContent(
            html,
            `Hallo ${full_name.split(' ')[0]},\n\ndeine Zugangsdaten:\nE-Mail: ${email}\nPasswort: ${password}\n\nBitte ändere dein Passwort nach dem ersten Login.\n\nPortal: ${appUrl}/login`,
          ),
        })
        emailed = true
        console.log(`[create-eigentuemer-access] ✓ E-Mail gesendet an: ${email}`)
      } catch (mailErr) {
        console.error('[create-eigentuemer-access] E-Mail-Versand fehlgeschlagen:', mailErr instanceof Error ? mailErr.message : String(mailErr))
      } finally {
        await client.close()
      }
    } else {
      console.warn(`[create-eigentuemer-access] SMTP nicht konfiguriert – simulierter Versand an: ${email}`)
      console.log(`[create-eigentuemer-access] Passwort (dev): ${password}`)
    }

    return new Response(
      JSON.stringify({ success: true, userId, password, emailed }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[create-eigentuemer-access] Fehler:', msg)
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
