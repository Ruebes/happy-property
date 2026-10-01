// Supabase Edge Function: invite-co-owner
// Lädt eine weitere Person als MIT-EIGENTÜMER in eine bestehende Wohnung ein.
// Sie sieht und darf danach dasselbe wie der Eigentümer (Vorgabe Sven 31.08.2026:
// "Wer eingeladen wird, gilt als Eigentümer"). Typischer Fall: der Käufer kauft
// für seine Kinder und schaltet sie frei.
//
// Bewusst NICHT create-eigentuemer-access wiederverwendet: die setzt bei einem
// bestehenden Konto ein neues Passwort und schreibt die Rolle auf 'eigentuemer'.
// Über eine Einladung ließe sich damit ein Admin- oder Mitarbeiter-Konto
// übernehmen. Diese Function fasst bestehende Konten weder im Passwort noch in
// der Rolle an.
//
// ── Deployment ──
//   supabase functions deploy invite-co-owner --no-verify-jwt
//
// Request body:
//   { property_id: string, email: string, full_name?: string }
//
// Antwort:
//   { ok: true, status: 'neu' | 'bestand', profile_id }

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SOCIAL_FOOTER_HTML, uspBoxHtml } from '../_shared/socialFooter.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const APP_URL = Deno.env.get('APP_URL') ?? 'https://portal.happy-property.com'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Profil = { id: string; email: string; full_name: string | null; role: string; language: string | null }
type Admin = ReturnType<typeof createClient>

// Profil zur Adresse suchen (Groß/Klein egal). '_' ist in ILIKE ein Platzhalter
// und wird maskiert; bei ZWEI Treffern ist die Zuordnung mehrdeutig (profiles.email
// kann der Nutzer selbst ändern) → der Aufrufer bricht ab statt zu raten.
async function profilesByEmail(admin: Admin, email: string): Promise<Profil[]> {
  const { data } = await admin.from('profiles')
    .select('id, email, full_name, role, language').ilike('email', email.replace(/_/g, '\\_')).limit(2)
  return (data ?? []) as Profil[]
}

// Auth-User per E-Mail über ALLE Seiten suchen (wie create-eigentuemer-access).
async function findAuthUserByEmail(admin: Admin, email: string): Promise<{ id: string } | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    // Fehler nicht als "kein Login" deuten (sonst falsche Zuordnung/409), abbrechen.
    if (error) throw new Error(error.message)
    const users = (data?.users ?? []) as Array<{ id: string; email?: string | null }>
    const hit = users.find(u => (u.email ?? '').trim().toLowerCase() === email)
    if (hit) return { id: hit.id }
    if (users.length < 1000) break
  }
  return null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })

  try {
    const { property_id, email: rawEmail, full_name } = await req.json() as
      { property_id?: string; email?: string; full_name?: string }
    const email = (rawEmail ?? '').trim().toLowerCase()
    if (!property_id || !email) return json({ error: 'property_id und email sind Pflichtfelder' }, 400)
    // Keine Platzhalter/Filter-Zeichen: '%' oder '*' hätten in der Konto-Suche
    // beliebige fremde Konten getroffen.
    if (/[%*,()"{}\\\s]/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      return json({ error: 'Bitte eine gültige E-Mail-Adresse angeben' }, 400)
    }

    const url     = Deno.env.get('SUPABASE_URL')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin   = createClient(url, service)

    // ── Guard ────────────────────────────────────────────────────────────────
    // Diese Function läuft mit Service-Role und geht damit an JEDER Datenbank-
    // Regel vorbei. Die property_id darf deshalb niemals ungeprüft aus dem
    // Request übernommen werden: sonst könnte sich jeder eingeloggte Nutzer per
    // direktem Aufruf in eine fremde Wohnung eintragen.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    let callerId: string | null = null
    if (jwt !== service) {
      const caller = jwt
        ? (await createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '').auth.getUser(jwt)).data.user
        : null
      if (!caller) return json({ error: 'Nicht autorisiert' }, 401)
      callerId = caller.id
      const { data: cProf } = await admin.from('profiles').select('role').eq('id', caller.id).maybeSingle()
      const rolle = (cProf as { role?: string } | null)?.role
      const { data: prop } = await admin.from('properties').select('owner_id').eq('id', property_id).maybeSingle()
      const istEigentuemer = (prop as { owner_id?: string } | null)?.owner_id === caller.id
      const istStaff = rolle === 'admin' || rolle === 'verwalter'
      // Nur der eingetragene Eigentümer dieser Wohnung oder Sven/Verwalter.
      // Ein Mit-Eigentümer darf NICHT weitere Personen hereinholen, sonst wächst
      // der Kreis als Kette und niemand hat mehr den Überblick.
      if (!istEigentuemer && !istStaff) return json({ error: 'Keine Berechtigung für diese Wohnung' }, 403)
    }

    // ── Wohnung + Eigentümer laden (für Mailtext und Info an den Eigentümer) ──
    const { data: propRow } = await admin.from('properties')
      .select('id, project_name, unit_number, owner_id').eq('id', property_id).maybeSingle()
    const prop = propRow as { id: string; project_name: string | null; unit_number: string | null; owner_id: string | null } | null
    if (!prop) return json({ error: 'Wohnung nicht gefunden' }, 404)
    const wohnung = [prop.project_name, prop.unit_number].filter(Boolean).join(' · ') || 'deine Wohnung'

    // ── Konto der eingeladenen Person ────────────────────────────────────────
    // Zuerst über die verifizierte Login-Adresse (auth.users), das Profil dann per id
    // (Review S1, E2-5/E2-6). profiles.email konnte der Nutzer selbst ändern: wer sich
    // dort eine fremde Adresse eintrug, wäre sonst als Mit-Eigentümer der fremden
    // Wohnung eingetragen worden.
    let profil: Profil | null = null
    const authUser = await findAuthUserByEmail(admin, email)
    if (authUser) {
      const { data: byId } = await admin.from('profiles')
        .select('id, email, full_name, role, language').eq('id', authUser.id).maybeSingle()
      const p = byId as Profil | null
      if (p) profil = { ...p, email }   // Einladung geht an die eingegebene (Login-)Adresse
    } else {
      // Kein Login mit dieser Adresse. Trägt trotzdem ein Profil sie, gehört es zu
      // einem Login mit ANDERER Adresse: nicht raten, nichts anfassen.
      const treffer = await profilesByEmail(admin, email)
      if (treffer.length > 1) {
        return json({ error: `Zu ${email} gibt es mehrere Konten. Bitte Happy Property kontaktieren.`, code: 'MEHRDEUTIG' }, 409)
      }
      if (treffer.length === 1) {
        return json({ error: `Zu ${email} gibt es ein Konto mit abweichender Login-Adresse. Bitte Happy Property kontaktieren.`, code: 'ADRESSE_ABWEICHEND' }, 409)
      }
    }

    let status: 'neu' | 'bestand' = 'bestand'

    if (!profil) {
      // Kein Konto vorhanden → Portal-Zugang über die bestehende Function anlegen
      // (Auth-User, Profil mit Rolle eigentuemer, Passwort, Zugangsmail).
      const res = await fetch(`${url}/functions/v1/create-eigentuemer-access`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${service}`, apikey: service, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, full_name: (full_name ?? '').trim() || email }),
      })
      const out = await res.json().catch(() => ({})) as { error?: string; userId?: string }
      if (!res.ok) return json({ error: `Zugang konnte nicht angelegt werden: ${out.error ?? res.status}` }, 502)
      const { data: neu } = out.userId
        ? await admin.from('profiles').select('id, email, full_name, role, language').eq('id', out.userId).maybeSingle()
        : { data: (await profilesByEmail(admin, email))[0] ?? null }
      profil = neu as Profil | null
      if (!profil) return json({ error: 'Konto wurde angelegt, konnte aber nicht gefunden werden' }, 500)
      status = 'neu'
    } else if (profil.role !== 'eigentuemer') {
      // Bestehendes Konto mit anderer Rolle (admin, verwalter, mitarbeiter, kunde):
      // NICHT anfassen. Eine Einladung würde Rolle und Passwort überschreiben und
      // die Person aus ihrem eigentlichen Zugang aussperren.
      return json({
        error: `Für ${email} existiert bereits ein Konto mit der Rolle ${profil.role}. Bitte eine andere Adresse verwenden.`,
        code: 'ROLLE_BELEGT',
      }, 409)
    }

    // ── Freischalten ─────────────────────────────────────────────────────────
    const { error: insErr } = await admin.from('property_co_owners').insert({
      property_id,
      profile_id: profil.id,
      invited_by: callerId,
    })
    if (insErr) {
      // 23505 = existiert bereits → für den Aufrufer kein Fehler
      if (!String(insErr.code).startsWith('23505')) return json({ error: insErr.message }, 400)
    }

    // ── Mails ────────────────────────────────────────────────────────────────
    const sendMail = async (to: string, subject: string, html: string) => {
      try {
        await fetch(`${url}/functions/v1/send-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${service}`, apikey: service, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, subject, html }),
        })
      } catch (e) { console.warn('[invite-co-owner] Mail fehlgeschlagen:', e) }
    }

    const vorname = (profil.full_name ?? '').split(' ')[0] || ''
    // Bei einem NEUEN Konto verschickt create-eigentuemer-access bereits die
    // Zugangsdaten — dann folgt hier nur der Hinweis, wofür der Zugang gilt.
    await sendMail(
      profil.email,
      status === 'neu' ? `Dein Zugang zu ${wohnung}` : `Du wurdest für ${wohnung} freigeschaltet`,
      `<p style="font-size:15px;color:#374151;">Hallo ${esc(vorname)},</p>
       <p style="font-size:15px;color:#374151;line-height:1.6;">du wurdest für die Wohnung <strong>${esc(wohnung)}</strong>
       im Happy Property Portal freigeschaltet und siehst dort ab sofort alle Unterlagen,
       Zahlungen und Baufortschritte.</p>
       ${status === 'neu'
         ? `<p style="font-size:15px;color:#374151;">Deine Zugangsdaten hast du in einer separaten E-Mail bekommen.</p>`
         : `<p style="font-size:15px;color:#374151;">Melde dich einfach wie gewohnt an: <a href="${APP_URL}/login">${APP_URL}/login</a></p>`}
       <p style="font-size:15px;color:#374151;">Viele Grüße<br>Happy Property</p>
       ${uspBoxHtml('de')}${SOCIAL_FOOTER_HTML}`,
    )

    // Hat Sven freigeschaltet, erfährt der Eigentümer davon: er soll wissen, wer
    // Zugriff auf seine Unterlagen hat.
    if (prop.owner_id && prop.owner_id !== callerId) {
      const { data: ownerProf } = await admin.from('profiles').select('email, full_name').eq('id', prop.owner_id).maybeSingle()
      const op = ownerProf as { email?: string; full_name?: string } | null
      if (op?.email) {
        await sendMail(
          op.email,
          `Neuer Zugriff auf ${wohnung}`,
          `<p style="font-size:15px;color:#374151;">Hallo ${esc((op.full_name ?? '').split(' ')[0])},</p>
           <p style="font-size:15px;color:#374151;line-height:1.6;">für deine Wohnung <strong>${esc(wohnung)}</strong>
           wurde <strong>${esc(profil.full_name ?? profil.email)}</strong> freigeschaltet und sieht dort dieselben
           Unterlagen wie du. Du kannst den Zugriff jederzeit im Portal wieder entfernen.</p>
           <p style="font-size:15px;color:#374151;">Viele Grüße<br>Happy Property</p>
           ${uspBoxHtml('de')}${SOCIAL_FOOTER_HTML}`,
        )
      }
    }

    return json({ ok: true, status, profile_id: profil.id })
  } catch (err) {
    console.error('[invite-co-owner] Fehler:', err)
    return json({ error: (err as Error).message }, 500)
  }
})
