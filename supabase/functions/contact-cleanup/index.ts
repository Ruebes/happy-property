// contact-cleanup — Kontakte ohne funktionierenden Kanal löschen (Sven 12.10.26).
//
// Sven: „Leute, deren Mailadresse falsch ist, bekommen WhatsApp. Wenn das auch
// falsch ist, Kontakt komplett löschen, wir müssen keinen Datenmüll sammeln."
//
// Ein Kontakt (Lead oder Newsletter-Abonnent) ist Datenmüll, wenn
//   - jede seiner Mailadressen gesperrt ist (email_bounces, _shared/emailBounce.ts)
//   - UND er keine glaubwürdige Nummer hat oder es unter jeder seiner Nummern
//     nachweislich kein WhatsApp gibt (wa_unreachable).
// Leads werden NIE gelöscht, wenn es einen Deal, einen Termin, eine eingehende
// Nachricht, eine Rechnung, einen Portal-Zugang oder einen Drive-Ordner gibt.
//
// Ablauf (täglich per Cron, dry=false): neue Fälle werden vorgemerkt und Sven
// bekommt EINE Mail mit Liste und Löschdatum. Nach WARTE_TAGEN wird gelöscht,
// wenn der Fall dann immer noch zutrifft. Wer bleiben soll: richtige Mailadresse
// oder WhatsApp-Nummer eintragen, dann fällt der Kontakt von selbst raus.
// Gelöscht wird endgültig (Lead: Deals/Verlauf/Nachrichten per Cascade), im
// Protokoll contact_cleanup bleibt nur „gelöscht" + Grund + Datum.
//
// Aufruf ohne dry:false = Probelauf (zeigt nur, was passieren würde).
// Deploy: supabase functions deploy contact-cleanup --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { bounceKey, loadBouncedKeys } from '../_shared/emailBounce.ts'
import { echteNummer, phoneKey } from '../_shared/phonePlausible.ts'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const WARTE_TAGE = 7
const SVEN_MAIL = 'sven@happy-property.com'
const SVEN_TEL = '35795096409'
const CRM = 'https://portal.happy-property.com/admin/crm/leads/'

type Fall = { lead_id: string | null; subscriber_id: string | null; name: string; email: string; phone: string; reason: string }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  const denied = await gateCaller(req, 'contact-cleanup', { cron: true, service: true, roles: ['admin'] }, CORS)
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { dry?: boolean }
  const dry = body.dry !== false
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const bounced = await loadBouncedKeys(sb)
    const { data: waRows } = await sb.from('wa_unreachable').select('phone').limit(10000)
    const waTot = new Set(((waRows ?? []) as Array<{ phone: string }>).map(r => r.phone))

    // Mail tot: mindestens eine Adresse, und JEDE ist gesperrt.
    const mailTot = (mails: Array<string | null | undefined>) => {
      const k = mails.map(bounceKey).filter(Boolean)
      return k.length > 0 && k.every(x => bounced.has(x))
    }
    // WhatsApp tot: keine glaubwürdige Nummer, oder jede hat nachweislich kein WhatsApp.
    const waTotFuer = (tels: Array<string | null | undefined>, vor: string | null, nach: string | null) => {
      const echte = [...new Set(tels.filter(t => echteNummer(t, vor, nach)).map(phoneKey))]
      if (echte.some(t => t.endsWith(SVEN_TEL))) return false
      return echte.length === 0 || echte.every(t => waTot.has(t))
    }
    const grund = (echte: number) => echte === 0 ? 'Mail kommt zurück, keine brauchbare Nummer' : 'Mail kommt zurück, Nummer hat kein WhatsApp'

    // ── Fälle suchen ──
    const faelle: Fall[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('leads')
        .select('id, first_name, last_name, email, alt_emails, phone, whatsapp, alt_phones, profile_id, portal_invited_at, drive_folder_id')
        .order('created_at').range(from, from + 999)
      if (error) throw new Error(`leads: ${error.message}`)
      for (const l of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; alt_emails: string[] | null; phone: string | null; whatsapp: string | null; alt_phones: string[] | null; profile_id: string | null; portal_invited_at: string | null; drive_folder_id: string | null }>) {
        if (!mailTot([l.email, ...(l.alt_emails ?? [])])) continue
        const tels = [l.whatsapp, l.phone, ...(l.alt_phones ?? [])]
        if (!waTotFuer(tels, l.first_name, l.last_name)) continue
        if (l.profile_id || l.portal_invited_at || l.drive_folder_id) continue
        const echte = tels.filter(t => echteNummer(t, l.first_name, l.last_name)).length
        faelle.push({ lead_id: l.id, subscriber_id: null, name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(), email: l.email ?? '', phone: l.whatsapp || l.phone || '', reason: grund(echte) })
      }
      if (!data || data.length < 1000) break
    }
    // Schutz: echte Geschäftsbeziehung → nie löschen (je Fall einzeln, seriell).
    const geschuetzt = new Set<string>()
    for (const f of faelle) {
      const id = f.lead_id!
      const checks = [
        sb.from('deals').select('id', { count: 'exact', head: true }).eq('lead_id', id),
        sb.from('crm_appointments').select('id', { count: 'exact', head: true }).eq('lead_id', id),
        sb.from('activities').select('id', { count: 'exact', head: true }).eq('lead_id', id).eq('direction', 'inbound').in('type', ['email', 'whatsapp']),
        sb.from('crm_invoices').select('id', { count: 'exact', head: true }).eq('lead_id', id),
      ]
      for (const c of checks) {
        const { count, error } = await c
        if (error || (count ?? 0) > 0) { geschuetzt.add(id); break }
      }
    }
    const leadFaelle = faelle.filter(f => !geschuetzt.has(f.lead_id!))

    const aboFaelle: Fall[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('newsletter_subscribers')
        .select('id, first_name, last_name, email, phone').order('created_at').range(from, from + 999)
      if (error) throw new Error(`abonnenten: ${error.message}`)
      for (const s of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>) {
        if (!mailTot([s.email]) || !waTotFuer([s.phone], s.first_name, s.last_name)) continue
        const echte = echteNummer(s.phone, s.first_name, s.last_name) ? 1 : 0
        aboFaelle.push({ lead_id: null, subscriber_id: s.id, name: `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(), email: s.email ?? '', phone: s.phone ?? '', reason: grund(echte) })
      }
      if (!data || data.length < 1000) break
    }
    const alle = [...leadFaelle, ...aboFaelle]
    const schluessel = (x: { lead_id: string | null; subscriber_id: string | null }) => x.lead_id ? `l:${x.lead_id}` : `s:${x.subscriber_id}`
    const aktuell = new Map(alle.map(f => [schluessel(f), f]))

    // ── Vorgemerkte abarbeiten ──
    const { data: offen } = await sb.from('contact_cleanup')
      .select('id, lead_id, subscriber_id, name, delete_after').is('deleted_at', null).is('kept_at', null)
    const vorgemerkt = new Set<string>()
    const geloescht: string[] = [], behalten: string[] = [], wartend: Array<{ name: string; am: string }> = []
    for (const m of (offen ?? []) as Array<{ id: string; lead_id: string | null; subscriber_id: string | null; name: string; delete_after: string }>) {
      const k = schluessel(m)
      vorgemerkt.add(k)
      if (!aktuell.has(k)) {
        // Inzwischen erreichbar (Adresse/Nummer korrigiert) oder geschützt → bleibt.
        behalten.push(m.name)
        if (!dry) await sb.from('contact_cleanup').update({ kept_at: new Date().toISOString() }).eq('id', m.id)
        continue
      }
      if (Date.parse(m.delete_after) > Date.now()) { wartend.push({ name: m.name, am: m.delete_after }); continue }
      geloescht.push(m.name)
      if (dry) continue
      const { error: de } = m.lead_id
        ? await sb.from('leads').delete().eq('id', m.lead_id)
        : await sb.from('newsletter_subscribers').delete().eq('id', m.subscriber_id!)
      if (de) { console.error('[contact-cleanup] löschen:', de.message); geloescht.pop(); continue }
      await sb.from('contact_cleanup').update({ deleted_at: new Date().toISOString(), name: 'gelöscht', email: null, phone: null }).eq('id', m.id)
    }

    // ── Neue Fälle vormerken + Sven informieren ──
    const neu = alle.filter(f => !vorgemerkt.has(schluessel(f)))
    const am = new Date(Date.now() + WARTE_TAGE * 864e5)
    if (!dry && neu.length) {
      const { error: ie } = await sb.from('contact_cleanup').insert(neu.map(f => ({ ...f, delete_after: am.toISOString() })))
      if (ie) throw new Error(`vormerken: ${ie.message}`)
      const datum = am.toLocaleDateString('de-DE', { timeZone: 'Europe/Nicosia', day: '2-digit', month: '2-digit' })
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      const zeilen = neu.map(f => `<li>${f.lead_id ? `<a href="${CRM}${f.lead_id}">${esc(f.name || f.email)}</a>` : `${esc(f.name || f.email)} (Newsletter-Abonnent)`} · ${esc(f.email)}${f.phone ? ` · ${esc(f.phone)}` : ''}<br><span style="color:#777">${esc(f.reason)}</span></li>`).join('')
      const html = `<p>Hallo Sven,</p><p>diese ${neu.length} Kontakte sind weder per Mail noch per WhatsApp erreichbar. Sie werden am <b>${datum}</b> automatisch komplett gelöscht:</p><ul>${zeilen}</ul><p>Soll jemand bleiben: im Kontakt die richtige Mailadresse oder WhatsApp-Nummer eintragen. Dann fällt er von selbst aus der Liste.</p><p>Nie gelöscht werden Kontakte mit Deal, Termin, eigener Nachricht an uns, Rechnung oder Portal-Zugang.</p>`
      const { error: me } = await sb.functions.invoke('send-email', { body: { to: SVEN_MAIL, subject: `Kontakt-Bereinigung: ${neu.length} Kontakte werden am ${datum} gelöscht`, html } })
      if (me) console.warn('[contact-cleanup] Mail an Sven:', me.message)
    }

    return json({
      ok: true, dry,
      neu: neu.map(f => ({ name: f.name, email: f.email, phone: f.phone, grund: f.reason, typ: f.lead_id ? 'lead' : 'abonnent' })),
      loeschen_am: neu.length ? am.toISOString() : null,
      geschuetzt: faelle.filter(f => geschuetzt.has(f.lead_id!)).map(f => f.name),
      geloescht, behalten, wartend,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[contact-cleanup]', msg)
    return json({ error: msg }, 500)
  }
})
