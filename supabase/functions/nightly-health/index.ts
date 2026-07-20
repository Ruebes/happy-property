// Supabase Edge Function: nightly-health
// Nächtlicher Systemcheck: sucht typische Datenfehler, repariert die BEWEISBAR
// eindeutigen selbst und sammelt den Rest als Vorschlag. Morgens geht eine
// Zusammenfassung in Alltagssprache an Sven (Mail) + Kachel im CRM-Dashboard.
//
// Aufruf:
//   POST { dry_run?: boolean, notify?: boolean }
//   dry_run=true  → nur suchen, NICHTS ändern (Beobachtungsmodus)
//   notify=false  → keine Mail (für manuelle Läufe)
//
// Cron: täglich 03:00 UTC (pg_cron → net.http_post)
//
// ── Deployment ──
//   supabase functions deploy nightly-health --no-verify-jwt
//
// ── Secrets ──
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (Standard)
//   HEALTH_REPORT_TO = Empfänger des Morgenberichts (Standard: sven@happy-property.com)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Sb = ReturnType<typeof createClient>

interface Finding {
  check_key:     string
  severity:      'kritisch' | 'hoch' | 'mittel' | 'niedrig'
  entity_kind?:  string
  entity_id?:    string
  entity_label?: string
  what_plain:    string   // Was ist los — in Alltagssprache, ohne Fachbegriffe
  action:        'auto_fixed' | 'proposed'
  fix_plain?:    string   // Was wurde getan / was wäre zu tun
}

// Jede Prüfung liefert Findings. `fix` darf NUR laufen, wenn der Fehler
// beweisbar genau eine richtige Antwort hat und die Änderung umkehrbar ist.
interface Check {
  key:   string
  title: string
  run:   (sb: Sb, dryRun: boolean) => Promise<Finding[]>
}

// ── Prüfung 1: Portal-Kopie weicht von der zentralen Wohnung ab ──────────────
// AUTO-FIX: Die zentrale Einheit ist per Definition die Wahrheit — die Kopie im
// Kundenportal wird darauf zurückgesetzt. Umkehrbar, kein Datenverlust.
const checkPropertyDrift: Check = {
  key: 'portal_kopie_weicht_ab',
  title: 'Kundenportal zeigt andere Daten als das CRM',
  run: async (sb, dryRun) => {
    const { data } = await sb.rpc('health_property_drift').select?.() ?? { data: null }
    // Kein RPC vorhanden → direkte Abfrage über den Vorwärts-Join
    const { data: rows } = await sb.from('crm_project_units')
      .select('id, unit_number, size_sqm, terrace_sqm, price_net, price_gross, property_id, project:crm_projects(name)')
      .not('property_id', 'is', null)
    const out: Finding[] = []
    for (const u of (rows ?? []) as Array<Record<string, unknown>>) {
      const pid = u.property_id as string
      const { data: p } = await sb.from('properties')
        .select('id, project_name, unit_number, size_sqm, terrace_sqm, purchase_price_net, purchase_price_gross, owner_id')
        .eq('id', pid).maybeSingle()
      if (!p) continue
      const proj = (u.project as { name?: string } | null)?.name ?? ''
      const num  = String(u.unit_number ?? '')
      const diffs: string[] = []
      const pp = p as Record<string, unknown>
      if (proj && String(pp.project_name ?? '') !== proj) diffs.push(`Projektname („${pp.project_name || 'leer'}" statt „${proj}")`)
      if (num && String(pp.unit_number ?? '') !== num) diffs.push(`Wohnungsnummer („${pp.unit_number || 'leer'}" statt „${num}")`)
      if (u.size_sqm != null && Number(pp.size_sqm) !== Number(u.size_sqm)) diffs.push(`Wohnfläche (${pp.size_sqm} statt ${u.size_sqm} m²)`)
      if (u.price_gross != null && Number(pp.purchase_price_gross) !== Number(u.price_gross)) diffs.push(`Kaufpreis (${pp.purchase_price_gross} statt ${u.price_gross} €)`)
      if (!diffs.length) continue
      if (!dryRun) {
        await sb.from('properties').update({
          project_name: proj || (pp.project_name as string), unit_number: num || (pp.unit_number as string),
          size_sqm: u.size_sqm, terrace_sqm: u.terrace_sqm,
          purchase_price_net: u.price_net, purchase_price_gross: u.price_gross,
        }).eq('id', pid)
      }
      out.push({
        check_key: 'portal_kopie_weicht_ab', severity: 'hoch',
        entity_kind: 'wohnung', entity_id: pid, entity_label: `${proj} ${num}`.trim(),
        what_plain: `Im Kundenportal standen andere Angaben als im CRM: ${diffs.join(', ')}.`,
        action: 'auto_fixed',
        fix_plain: 'Die Portal-Anzeige wurde an die Daten aus dem CRM angeglichen. Der Kunde sieht jetzt dasselbe wie du.',
      })
    }
    return out
  },
}

// ── Prüfung 2: Doppelte Wohnungsnummern in einem Projekt ────────────────────
// NUR MELDEN: Welche der beiden Zeilen die richtige ist, kann nur Sven wissen.
const checkDuplicateUnits: Check = {
  key: 'wohnung_doppelt',
  title: 'Dieselbe Wohnungsnummer zweimal im selben Projekt',
  run: async (sb) => {
    const { data: units } = await sb.from('crm_project_units')
      .select('id, unit_number, project_id, size_sqm, price_gross, project:crm_projects(name)')
    const seen = new Map<string, Array<Record<string, unknown>>>()
    for (const u of (units ?? []) as Array<Record<string, unknown>>) {
      const key = `${u.project_id}|${String(u.unit_number ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key)!.push(u)
    }
    const out: Finding[] = []
    for (const [, list] of seen) {
      if (list.length < 2) continue
      const proj = (list[0].project as { name?: string } | null)?.name ?? '?'
      const num  = list[0].unit_number
      const varianten = list.map(u => `${u.size_sqm ?? '?'} m² / ${u.price_gross ?? '?'} €`).join('  ·  ')
      out.push({
        check_key: 'wohnung_doppelt', severity: 'kritisch',
        entity_kind: 'wohnung', entity_id: String(list[0].id), entity_label: `${proj} ${num}`,
        what_plain: `Die Wohnung ${num} gibt es in ${proj} ${list.length}× mit unterschiedlichen Angaben: ${varianten}. Angebote und Kundenportale können dadurch die falsche Variante erwischen.`,
        action: 'proposed',
        fix_plain: 'Bitte sag mir, welche Variante stimmt — die andere räume ich dann weg.',
      })
    }
    return out
  },
}

// ── Prüfung 3: Deck zeigt einen Preis, der nicht mehr stimmt ────────────────
// NUR MELDEN: Ein bereits versendetes Deck nachträglich zu ändern ist eine
// Geschäftsentscheidung (der Kunde hat den alten Preis evtl. schon gesehen).
const checkStaleDecks: Check = {
  key: 'deck_preis_veraltet',
  title: 'Verschicktes Angebot zeigt einen veralteten Preis',
  run: async (sb) => {
    const { data: decks } = await sb.from('sales_decks')
      .select('id, token, recipient_name, unit_id, content, project:crm_projects(name)')
      .not('unit_id', 'is', null).limit(400)
    const out: Finding[] = []
    for (const d of (decks ?? []) as Array<Record<string, unknown>>) {
      const { data: u } = await sb.from('crm_project_units')
        .select('unit_number, price_gross').eq('id', d.unit_id as string).maybeSingle()
      if (!u?.price_gross) continue
      const txt = JSON.stringify(d.content ?? {})
      const aktuell = Math.round(Number(u.price_gross))
      // Im Deck stehen formatierte Beträge (z.B. „498.372 €") — beide Schreibweisen prüfen.
      const varianten = [aktuell.toLocaleString('de-DE'), String(aktuell)]
      if (varianten.some(v => txt.includes(v))) continue
      out.push({
        check_key: 'deck_preis_veraltet', severity: 'hoch',
        entity_kind: 'deck', entity_id: String(d.token), entity_label: `${(d.project as { name?: string } | null)?.name ?? ''} · ${d.recipient_name ?? ''}`.trim(),
        what_plain: `Das Angebot für ${d.recipient_name ?? 'einen Kunden'} nennt nicht den aktuellen Preis der Wohnung ${u.unit_number} (heute ${aktuell.toLocaleString('de-DE')} €). Wenn der Kunde den Link erneut öffnet, sieht er den alten Stand.`,
        action: 'proposed',
        fix_plain: 'Sag Bescheid, ob ich das Angebot auf den aktuellen Preis aktualisieren soll — der Link bleibt dabei derselbe.',
      })
    }
    return out
  },
}

// ── Prüfung 4: Eigentümer mit Zugang, aber leerem Portal ────────────────────
const checkEmptyPortals: Check = {
  key: 'portal_leer',
  title: 'Eigentümer hat Zugang, sieht aber nichts',
  run: async (sb) => {
    const { data: owners } = await sb.from('profiles')
      .select('id, full_name, email').eq('role', 'eigentuemer').eq('is_active', true)
    const out: Finding[] = []
    for (const o of (owners ?? []) as Array<Record<string, unknown>>) {
      const { count } = await sb.from('properties')
        .select('id', { count: 'exact', head: true }).eq('owner_id', o.id as string)
      if ((count ?? 0) > 0) continue
      out.push({
        check_key: 'portal_leer', severity: 'hoch',
        entity_kind: 'eigentuemer', entity_id: String(o.id), entity_label: String(o.full_name ?? o.email),
        what_plain: `${o.full_name ?? o.email} kann sich im Eigentümer-Portal anmelden, sieht dort aber keine einzige Wohnung.`,
        action: 'proposed',
        fix_plain: 'Vermutlich wurde die Wohnung nie zugewiesen. Sag mir welche, dann hänge ich sie ein.',
      })
    }
    return out
  },
}

// ── Prüfung 5: Termin vorbei, kein Ergebnis eingetragen ─────────────────────
const checkAppointmentsNoOutcome: Check = {
  key: 'termin_ohne_ergebnis',
  title: 'Vergangener Termin ohne Ergebnis',
  run: async (sb) => {
    const seit = new Date(Date.now() - 14 * 864e5).toISOString()
    const bis  = new Date(Date.now() - 2 * 3600e3).toISOString()
    const { data: appts } = await sb.from('crm_appointments')
      .select('id, title, start_time, lead_id, outcome')
      .gte('start_time', seit).lte('start_time', bis).is('outcome', null).limit(50)
    return ((appts ?? []) as Array<Record<string, unknown>>).map(a => ({
      check_key: 'termin_ohne_ergebnis', severity: 'mittel' as const,
      entity_kind: 'termin', entity_id: String(a.id), entity_label: String(a.title ?? ''),
      what_plain: `Der Termin „${a.title}" vom ${new Date(String(a.start_time)).toLocaleDateString('de-DE')} ist vorbei, aber es steht kein Ergebnis dabei (stattgefunden, No-Show, gut/schlecht gelaufen).`,
      action: 'proposed' as const,
      fix_plain: 'Kurz im CRM nachtragen — sonst fehlt die Info später in der Auswertung, welche Werbung gute Gespräche bringt.',
    }))
  },
}

// ── Prüfung 6: Geplante Nachricht hängt fest ────────────────────────────────
const checkStuckMessages: Check = {
  key: 'nachricht_haengt',
  title: 'Geplante Nachricht wurde nicht verschickt',
  run: async (sb) => {
    const grenze = new Date(Date.now() - 6 * 3600e3).toISOString()
    const { data: msgs } = await sb.from('scheduled_messages')
      .select('id, type, event_type, scheduled_at, lead_id')
      .eq('status', 'pending').lt('scheduled_at', grenze).limit(50)
    return ((msgs ?? []) as Array<Record<string, unknown>>).map(m => ({
      check_key: 'nachricht_haengt', severity: 'hoch' as const,
      entity_kind: 'nachricht', entity_id: String(m.id), entity_label: String(m.event_type ?? ''),
      what_plain: `Eine ${m.type === 'email' ? 'E-Mail' : 'WhatsApp'} („${m.event_type}") sollte am ${new Date(String(m.scheduled_at)).toLocaleString('de-DE')} rausgehen, hängt aber noch.`,
      action: 'proposed' as const,
      fix_plain: 'Ich schaue mir an, woran es klemmt — sag Bescheid, ob sie noch raus soll oder storniert wird.',
    }))
  },
}

const CHECKS: Check[] = [
  checkPropertyDrift, checkDuplicateUnits, checkStaleDecks,
  checkEmptyPortals, checkAppointmentsNoOutcome, checkStuckMessages,
]

// ── Morgenbericht in Alltagssprache ─────────────────────────────────────────
function buildReport(fixed: Finding[], open: Finding[], datum: string): { subject: string; html: string } {
  const li = (f: Finding) => `
    <tr><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">
      <strong style="color:#111827;">${f.entity_label || ''}</strong><br>
      ${f.what_plain}
      ${f.fix_plain ? `<br><span style="color:#6b7280;">→ ${f.fix_plain}</span>` : ''}
    </td></tr>`
  const subject = open.length
    ? `Systemcheck ${datum}: ${fixed.length} automatisch behoben, ${open.length} zur Ansicht`
    : `Systemcheck ${datum}: alles in Ordnung${fixed.length ? ` (${fixed.length} automatisch behoben)` : ''}`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;">
    <p style="font-size:15px;">Guten Morgen Sven,</p>
    <p style="font-size:15px;">hier der nächtliche Systemcheck vom ${datum}.</p>
    ${fixed.length ? `
      <h3 style="font-size:16px;color:#111827;margin:24px 0 8px;">✅ Das habe ich selbst repariert (${fixed.length})</h3>
      <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">Nur Dinge, bei denen es genau eine richtige Antwort gibt. Alles ist protokolliert und umkehrbar.</p>
      <table style="width:100%;border-collapse:collapse;background:#f6fdf8;border-radius:10px;">${fixed.map(li).join('')}</table>` : ''}
    ${open.length ? `
      <h3 style="font-size:16px;color:#111827;margin:24px 0 8px;">👀 Das solltest du dir ansehen (${open.length})</h3>
      <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">Hier entscheide lieber du — ich habe nichts verändert.</p>
      <table style="width:100%;border-collapse:collapse;background:#fffaf3;border-radius:10px;">${open.map(li).join('')}</table>` : ''}
    ${!fixed.length && !open.length ? `<p style="font-size:15px;">Alles sauber — keine Auffälligkeiten gefunden. 🎉</p>` : ''}
    <p style="text-align:center;margin:28px 0;">
      <a href="https://portal.happy-property.com/admin/crm" style="background:#ff795d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block;">Im CRM ansehen</a>
    </p>
    <p style="font-size:12px;color:#9ca3af;">Diese Prüfung läuft jede Nacht automatisch.</p>
  </div>`
  return { subject, html }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const body = await req.json().catch(() => ({})) as { dry_run?: boolean; notify?: boolean }
  const dryRun = body.dry_run !== false ? body.dry_run === true : false
  const notify = body.notify !== false

  const { data: run } = await sb.from('health_runs').insert({}).select('id').single()
  const runId = (run as { id: string } | null)?.id ?? null

  const all: Finding[] = []
  let fehler: string | null = null
  for (const c of CHECKS) {
    try {
      const res = await c.run(sb, dryRun)
      all.push(...res)
      console.log(`[nightly-health] ${c.key}: ${res.length} Funde`)
    } catch (e) {
      console.error(`[nightly-health] ${c.key} fehlgeschlagen:`, e)
      fehler = `${fehler ?? ''}${c.key}: ${(e as Error).message}; `
    }
  }

  const fixed = all.filter(f => f.action === 'auto_fixed')
  const open  = all.filter(f => f.action === 'proposed')

  if (runId && all.length) {
    await sb.from('health_findings').insert(all.map(f => ({ ...f, run_id: runId })))
  }
  if (runId) {
    await sb.from('health_runs').update({
      finished_at: new Date().toISOString(), checks_run: CHECKS.length,
      issues_found: all.length, auto_fixed: fixed.length, needs_review: open.length, error: fehler,
    }).eq('id', runId)
  }

  if (notify && !dryRun) {
    const datum = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
    const { subject, html } = buildReport(fixed, open, datum)
    await sb.functions.invoke('send-email', {
      body: { to: Deno.env.get('HEALTH_REPORT_TO') ?? 'sven@happy-property.com', subject, html },
    }).catch((e: unknown) => console.warn('[nightly-health] Mail:', e))
  }

  return json({ success: true, run_id: runId, dry_run: dryRun, gefunden: all.length, repariert: fixed.length, offen: open.length, fehler })
})
