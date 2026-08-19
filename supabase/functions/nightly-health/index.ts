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
      // Test-Konten (Name/E-Mail enthält „test") sind kein echter Fehler → überspringen.
      const label = `${o.full_name ?? ''} ${o.email ?? ''}`.toLowerCase()
      if (/\btest\b|test tester|@example\./.test(label)) continue
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
      // internal raus: bei internen Terminen gibt es kein "Ergebnis" (kein No-Show,
      // keine Lead-Bewertung) - sie waeren jede Nacht ein Fehlalarm im Morgenbericht.
      .eq('internal', false)
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

// ── Prüfung 7: Automatik verweist auf eine gelöschte/inaktive Vorlage ───────
// Verlinkungs-Check: eine aktive Regel ohne existierende Vorlage sendet still nichts.
const checkBrokenAutomationLinks: Check = {
  key: 'automatik_vorlage_fehlt',
  title: 'Automatik verweist auf eine fehlende Vorlage',
  run: async (sb) => {
    const { data: rules } = await sb.from('automation_rules')
      .select('id, name, message_type, email_template_id, whatsapp_event_type').eq('is_active', true)
    const out: Finding[] = []
    for (const r of (rules ?? []) as Array<Record<string, unknown>>) {
      const mt = String(r.message_type ?? '')
      if ((mt === 'email' || mt === 'both') && r.email_template_id) {
        const { data: tpl } = await sb.from('email_templates').select('id').eq('id', r.email_template_id as string).maybeSingle()
        if (!tpl) out.push({
          check_key: 'automatik_vorlage_fehlt', severity: 'hoch', entity_kind: 'automatik', entity_id: String(r.id), entity_label: String(r.name ?? ''),
          what_plain: `Die Automatik „${r.name}" soll eine E-Mail verschicken, aber die hinterlegte Mail-Vorlage gibt es nicht mehr — die Mail geht dadurch nicht raus.`,
          action: 'proposed', fix_plain: 'Im Nachrichten-Editor eine gültige Vorlage zuweisen, dann läuft die Automatik wieder.',
        })
      }
      if ((mt === 'whatsapp' || mt === 'both') && r.whatsapp_event_type) {
        const { data: tpl } = await sb.from('whatsapp_templates').select('id').eq('event_type', r.whatsapp_event_type as string).eq('active', true).maybeSingle()
        if (!tpl) out.push({
          check_key: 'automatik_vorlage_fehlt', severity: 'hoch', entity_kind: 'automatik', entity_id: String(r.id), entity_label: String(r.name ?? ''),
          what_plain: `Die Automatik „${r.name}" soll eine WhatsApp verschicken, aber die passende WhatsApp-Vorlage fehlt oder ist ausgeschaltet — die Nachricht geht nicht raus.`,
          action: 'proposed', fix_plain: 'Die passende WhatsApp-Vorlage anlegen bzw. aktivieren.',
        })
      }
    }
    return out
  },
}

// ── Prüfung 8: Persönlicher Buchungslink zeigt ins Leere ────────────────────
const checkBookingInviteTargets: Check = {
  key: 'buchungslink_ziel_fehlt',
  title: 'Persönlicher Buchungslink zeigt ins Leere',
  run: async (sb) => {
    const { data: inv } = await sb.from('booking_invites').select('token, guest_name, slug')
    const out: Finding[] = []
    for (const i of (inv ?? []) as Array<Record<string, unknown>>) {
      const { data: link } = await sb.from('personal_booking_links').select('slug, active').eq('slug', i.slug as string).maybeSingle()
      if (link && (link as { active?: boolean }).active) continue
      out.push({
        check_key: 'buchungslink_ziel_fehlt', severity: 'mittel', entity_kind: 'buchungslink', entity_id: String(i.token), entity_label: String(i.guest_name ?? i.token),
        what_plain: `Der persönliche Buchungslink für ${i.guest_name ?? i.token} zeigt auf den Kalender „${i.slug}" — den gibt es nicht (mehr) oder er ist deaktiviert. Wer den Link öffnet, kann nicht buchen.`,
        action: 'proposed', fix_plain: `Den Kalender „${i.slug}" wieder aktivieren oder den Link auf einen gültigen umstellen.`,
      })
    }
    return out
  },
}

// ── Prüfung 9: Abgemeldeter Kontakt hat noch geplante Nachrichten ───────────
// AUTO-FIX: geplante Nachrichten an Abgemeldete stoppen (rechtlich + korrekt, umkehrbar).
const checkOptoutStillScheduled: Check = {
  key: 'abgemeldet_aber_geplant',
  title: 'Abgemeldeter Kontakt hat noch geplante Nachrichten',
  run: async (sb, dryRun) => {
    const { data: outs } = await sb.from('communication_optouts').select('lead_id')
    const ids = [...new Set(((outs ?? []) as Array<{ lead_id?: string }>).map(o => o.lead_id).filter(Boolean))] as string[]
    const out: Finding[] = []
    for (const lid of ids) {
      const { data: pend } = await sb.from('scheduled_messages').select('id').eq('lead_id', lid).eq('status', 'pending')
      const n = (pend ?? []).length
      if (!n) continue
      const { data: lead } = await sb.from('leads').select('first_name, last_name').eq('id', lid).maybeSingle()
      const l = lead as { first_name?: string; last_name?: string } | null
      const nm = l ? `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || lid.slice(0, 8) : lid.slice(0, 8)
      if (!dryRun) await sb.from('scheduled_messages').update({ status: 'cancelled', error_message: 'Kontakt abgemeldet — Nachtcheck hat gestoppt' }).eq('lead_id', lid).eq('status', 'pending')
      out.push({
        check_key: 'abgemeldet_aber_geplant', severity: 'hoch', entity_kind: 'lead', entity_id: lid, entity_label: nm,
        what_plain: `${nm} hat sich abgemeldet, es waren aber noch ${n} Nachricht(en) geplant — die hätten trotz Abmeldung rausgehen können.`,
        action: dryRun ? 'proposed' : 'auto_fixed',
        fix_plain: dryRun ? `Die ${n} geplante(n) Nachricht(en) würden gestoppt.` : `Die ${n} geplante(n) Nachricht(en) wurden gestoppt — der Kontakt bekommt nichts mehr.`,
      })
    }
    return out
  },
}

// ── Prüfung 10: Lead ohne jede Kontaktmöglichkeit ──────────────────────────
const checkLeadsNoContact: Check = {
  key: 'lead_ohne_kontakt',
  title: 'Lead ohne jede Kontaktmöglichkeit',
  run: async (sb) => {
    const { data: leads } = await sb.from('leads').select('id, first_name, last_name, email').is('phone', null).is('whatsapp', null).limit(50)
    const out: Finding[] = []
    for (const l of (leads ?? []) as Array<Record<string, unknown>>) {
      if (String(l.email ?? '').trim()) continue
      const nm = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || String(l.id).slice(0, 8)
      out.push({
        check_key: 'lead_ohne_kontakt', severity: 'niedrig', entity_kind: 'lead', entity_id: String(l.id), entity_label: nm,
        what_plain: `Der Lead ${nm} hat weder E-Mail noch Telefon/WhatsApp — er kann von uns gar nicht erreicht werden.`,
        action: 'proposed', fix_plain: 'Kontaktdaten nachtragen oder den Lead archivieren.',
      })
    }
    return out
  },
}

// ── Prüfung 11: Deck-Bearbeitung hängt fest ────────────────────────────────
// AUTO-FIX: hängenden refining-Zustand lösen (Edge-Abbruch ließ den Spinner ewig drehen).
const checkStuckRefining: Check = {
  key: 'deck_haengt_im_refine',
  title: 'Deck-Bearbeitung hängt fest',
  run: async (sb, dryRun) => {
    const grenze = new Date(Date.now() - 30 * 60e3).toISOString()
    const { data: decks } = await sb.from('sales_decks').select('token, recipient_name, updated_at').eq('refining', true).lt('updated_at', grenze).limit(20)
    const out: Finding[] = []
    for (const d of (decks ?? []) as Array<Record<string, unknown>>) {
      if (!dryRun) await sb.from('sales_decks').update({ refining: false, refine_error: 'Nachtcheck: hängende Bearbeitung gelöst' }).eq('token', d.token as string)
      out.push({
        check_key: 'deck_haengt_im_refine', severity: 'mittel', entity_kind: 'deck', entity_id: String(d.token), entity_label: String(d.recipient_name ?? d.token),
        what_plain: `Eine Deck-Bearbeitung für ${d.recipient_name ?? 'ein Deck'} hängt seit über 30 Minuten (der Bearbeiten-Spinner drehte endlos).`,
        action: dryRun ? 'proposed' : 'auto_fixed',
        fix_plain: dryRun ? 'Der hängende Zustand würde gelöst.' : 'Der hängende Zustand wurde gelöst — du kannst das Deck wieder bearbeiten.',
      })
    }
    return out
  },
}

// ── Prüfung 12: Zu viele globale Deck-Chat-Regeln (Poison-Akkumulation) ─────
const checkDeckRuleBloat: Check = {
  key: 'deck_regeln_zu_viele',
  title: 'Zu viele globale Deck-Chat-Regeln',
  run: async (sb) => {
    const { count } = await sb.from('deck_ai_rules').select('id', { count: 'exact', head: true }).eq('scope', 'global').eq('active', true).eq('kind', 'deck')
    const n = count ?? 0
    if (n <= 25) return []
    return [{
      check_key: 'deck_regeln_zu_viele', severity: 'mittel', entity_kind: 'system', entity_label: 'Deck-Chat-Regeln',
      what_plain: `Es haben sich ${n} globale Regeln für den Deck-Chat angesammelt. Zu viele (teils widersprüchliche) Regeln fließen in JEDES neue Deck ein und können Fehler verursachen.`,
      action: 'proposed', fix_plain: 'Die Regel-Liste einmal durchsehen und veraltete/widersprüchliche entfernen — dann werden neue Decks wieder sauberer.',
    }]
  },
}

// ── Prüfung 13: Grundriss-Garantie ──────────────────────────────────────────
// Sven 14.8.: Grundrisse sollen IMMER im Deck sein, wenn sie irgendwo verfügbar
// sind. Zwei Luecken werden gemeldet: (a) junge Decks mit Grundriss-Abschnitt
// ohne Zeichnung, (b) Projekte, deren Drive-Ordner Grundriss-Dateien hat
// (drive_sync.floorplans_newest vom Nacht-Sync), aber ohne unit_floorplans-Mapping.
const checkFloorplanCoverage: Check = {
  key: 'grundriss_fehlt',
  title: 'Grundrisse fehlen in Decks',
  run: async (sb) => {
    const out: Finding[] = []
    const seit = new Date(Date.now() - 14 * 86400e3).toISOString()
    const { data: decks } = await sb.from('sales_decks').select('token, recipient_name, content, created_at').gt('created_at', seit).limit(400)
    for (const d of (decks ?? []) as Array<{ token: string; recipient_name?: string | null; content?: { blocks?: Array<Record<string, unknown>> } | null }>) {
      const leer = (d.content?.blocks ?? []).some(b => b.type === 'floorplan' && !b.image)
      if (leer) {
        out.push({
          check_key: 'grundriss_fehlt', severity: 'mittel', entity_kind: 'deck', entity_id: String(d.token), entity_label: String(d.recipient_name ?? d.token),
          what_plain: 'Ein aktuelles Deck hat einen Grundriss-Abschnitt ohne Zeichnung — für die Wohnung ist kein HP-Grundriss hinterlegt.',
          action: 'proposed',
          fix_plain: 'Grundriss im HP-Stil anlegen und in deck_assets.unit_floorplans des Projekts eintragen — neue Decks bekommen ihn dann automatisch.',
        })
      }
    }
    const { data: projs } = await sb.from('crm_projects').select('id, name, deck_assets').not('drive_folder_id', 'is', null)
    for (const p of (projs ?? []) as Array<{ id: string; name: string; deck_assets?: Record<string, unknown> | null }>) {
      const da = p.deck_assets ?? {}
      const hatDrivePlaene = !!(da.drive_sync as { floorplans_newest?: string } | undefined)?.floorplans_newest
      const ufp = da.unit_floorplans as Record<string, unknown> | undefined
      const hatMapping = !!ufp && Object.keys(ufp).length > 0
      if (!hatDrivePlaene || hatMapping) continue
      const { count } = await sb.from('sales_decks').select('id', { count: 'exact', head: true }).eq('project_id', p.id)
      if ((count ?? 0) > 0) {
        out.push({
          check_key: 'grundriss_fehlt', severity: 'niedrig', entity_kind: 'projekt', entity_id: p.id, entity_label: p.name,
          what_plain: `Im Drive-Ordner von ${p.name} liegen Grundriss-Zeichnungen, aber im CRM ist kein HP-Grundriss je Wohnung hinterlegt — Decks dieses Projekts erscheinen ohne Grundriss.`,
          action: 'proposed',
          fix_plain: 'Grundrisse im HP-Stil nachzeichnen (wie Emerald/Skala) und als unit_floorplans hinterlegen.',
        })
      }
    }
    return out
  },
}

// ── Prüfung: Telefonnummern mit unsichtbaren Zeichen ─────────────────────────
// iPhone-Kontakte bringen oft Bidi-Steuerzeichen (U+202A/U+202C) und geschützte
// Leerzeichen mit - TimelinesAI lehnt solche Nummern ab ("Cannot message this
// group", Michael Decker 14.8.). AUTO-FIX: Normalisierung (nur führendes + und
// Ziffern) ist beweisbar eindeutig.
const checkDirtyPhones: Check = {
  key: 'telefonnummern_unsauber',
  title: 'Telefonnummern mit unsichtbaren Zeichen',
  run: async (sb, dryRun) => {
    const out: Finding[] = []
    const clean = (raw: string): string => {
      const digits = raw.replace(/[^0-9]/g, '')
      return digits ? (raw.includes('+') ? '+' : '') + digits : ''
    }
    const isDirty = (v: unknown): v is string => typeof v === 'string' && v !== '' && !/^\+?[0-9]+$/.test(v)
    const TARGETS: Array<{ table: string; cols: string[]; label: string }> = [
      { table: 'leads', cols: ['phone', 'whatsapp'], label: 'Kunde' },
      { table: 'verwaltungen', cols: ['phone', 'ansprechpartner_phone'], label: 'Verwaltung' },
      { table: 'crm_business_contacts', cols: ['phone', 'whatsapp'], label: 'Geschäftskontakt' },
      { table: 'crm_developer_contacts', cols: ['phone', 'whatsapp'], label: 'Developer-Kontakt' },
    ]
    for (const tgt of TARGETS) {
      const { data, error } = await sb.from(tgt.table).select(['id', ...tgt.cols].join(','))
      if (error) { console.warn(`[nightly-health] dirtyPhones ${tgt.table}:`, error.message); continue }
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const patch: Record<string, string | null> = {}
        for (const c of tgt.cols) if (isDirty(row[c])) patch[c] = clean(row[c] as string) || null
        if (!Object.keys(patch).length) continue
        if (!dryRun) {
          const { error: ue } = await sb.from(tgt.table).update(patch).eq('id', row.id as string)
          if (ue) { console.warn(`[nightly-health] dirtyPhones fix ${tgt.table}/${row.id}:`, ue.message); continue }
        }
        out.push({
          check_key: 'telefonnummern_unsauber', severity: 'mittel', entity_kind: tgt.table,
          entity_id: String(row.id), entity_label: tgt.label,
          what_plain: 'Eine Telefonnummer enthielt unsichtbare Formatierungszeichen (typisch iPhone-Kontakt) - WhatsApp-Versand an diese Nummer schlägt damit fehl.',
          action: dryRun ? 'proposed' : 'auto_fixed',
          fix_plain: dryRun ? 'Nummer auf +Ziffern normalisieren.' : 'Nummer auf +Ziffern normalisiert.',
        })
      }
    }
    return out
  },
}

// ── Pruefung 15: Einrichtungspaket gepflegt? ────────────────────────────────
// Sven 18.8.: "Es kann nicht sein, dass ploetzlich ein Preis fuer Moebel
// auftaucht, den wir vorher nie definiert haben. Ich moechte solche Sachen
// eigentlich nicht mehr kontrollieren muessen." Die Rechner nehmen den Wert seit
// dem nur noch aus dem Projekt - fehlt er dort, rechnet die Wohnung mit 0 statt
// mit einer erfundenen Zahl. Diese Pruefung meldet genau diese Luecken, damit
// Angebote nicht still zu guenstig werden.
const checkFurnitureData: Check = {
  key: 'einrichtung_fehlt',
  title: 'Einrichtungspaket im Projekt nicht hinterlegt',
  run: async (sb) => {
    const out: Finding[] = []
    const { data: projs } = await sb.from('crm_projects')
      .select('id, name, developer, furniture_cost, furniture_included')
      .is('furniture_cost', null)
    for (const p of (projs ?? []) as Array<{ id: string; name: string; developer: string | null; furniture_included: boolean | null }>) {
      if (p.furniture_included) continue          // im Kaufpreis enthalten = gepflegt
      const { count } = await sb.from('crm_project_units').select('id', { count: 'exact', head: true }).eq('project_id', p.id)
      if (!count) continue                         // Projekt ohne Wohnungen: egal
      out.push({
        check_key: 'einrichtung_fehlt', severity: 'mittel', entity_kind: 'projekt', entity_id: p.id, entity_label: p.name,
        what_plain: `Bei ${p.name} (${p.developer ?? 'ohne Bautraeger'}) ist weder ein Preis fuer das Einrichtungspaket hinterlegt noch "im Kaufpreis enthalten" gesetzt. Jede Berechnung zu diesem Projekt rechnet die Einrichtung deshalb mit 0 Euro.`,
        action: 'proposed',
        fix_plain: 'Im Projekt entweder den Netto-Preis des Einrichtungspakets eintragen oder "Einrichtung im Kaufpreis enthalten" setzen.',
      })
    }
    return out
  },
}

// ── Pruefung 16: Standort und Bautraeger am Projekt ────────────────────────
// Sven 18.8.: "Auch bei Mamba kennst du den Standort und den Developer. Trag das
// nach und baue es so stabil, dass wir das immer stehen haben." Decks, Rechnungen
// und Vergleiche ziehen Lage und Bautraeger aus dem Projekt - fehlt dort etwas,
// steht beim Kunden ein Strich. Wo Koordinaten vorhanden sind, traegt der
// Nachtlauf den Ort SELBST nach (Reverse-Geocoding), sonst meldet er die Luecke.
const checkProjectBasics: Check = {
  key: 'projekt_stammdaten',
  title: 'Projekt ohne Standort oder Bautraeger',
  run: async (sb, dryRun) => {
    const out: Finding[] = []
    const { data: projs } = await sb.from('crm_projects')
      .select('id, name, developer, location, latitude, longitude')
    for (const p of (projs ?? []) as Array<{ id: string; name: string; developer: string | null; location: string | null; latitude: number | null; longitude: number | null }>) {
      const fehltOrt = !p.location || !String(p.location).trim()
      const fehltDev = !p.developer || !String(p.developer).trim()
      if (!fehltOrt && !fehltDev) continue
      // Ort aus den Koordinaten selbst nachtragen, wenn welche da sind.
      if (fehltOrt && p.latitude != null && p.longitude != null) {
        try {
          const r = await fetch(`https://photon.komoot.io/reverse?lat=${p.latitude}&lon=${p.longitude}&lang=en`)
          const j = await r.json()
          const pr = (j?.features ?? [])[0]?.properties ?? {}
          const ort = pr.city || pr.district || pr.locality || pr.county
          if (ort) {
            const loc = /paphos/i.test(String(ort)) ? `${ort}, Zypern` : `${ort}, Paphos, Zypern`
            if (!dryRun) await sb.from('crm_projects').update({ location: loc }).eq('id', p.id)
            out.push({
              check_key: 'projekt_stammdaten', severity: 'niedrig', entity_kind: 'projekt', entity_id: p.id, entity_label: p.name,
              what_plain: `${p.name} hatte keine Ortsangabe, obwohl die Karte gepflegt ist.`,
              action: dryRun ? 'proposed' : 'fixed',
              fix_plain: `Ort aus den Koordinaten uebernommen: ${loc}.`,
            })
            continue
          }
        } catch { /* Geocoder nicht erreichbar: dann normal melden */ }
      }
      const fehlt = [fehltOrt ? 'Standort' : null, fehltDev ? 'Bautraeger' : null].filter(Boolean).join(' und ')
      out.push({
        check_key: 'projekt_stammdaten', severity: 'mittel', entity_kind: 'projekt', entity_id: p.id, entity_label: p.name,
        what_plain: `Bei ${p.name} fehlt ${fehlt}. In Decks, Rechnungen und Vergleichen bleibt dieses Feld beim Kunden leer.`,
        action: 'proposed',
        fix_plain: 'Im Projekt Lage (Ort, Paphos, Zypern) und Bautraeger eintragen - oder den Google-Maps-Link setzen, dann traegt der Nachtlauf den Ort selbst nach.',
      })
    }
    return out
  },
}

const CHECKS: Check[] = [
  checkPropertyDrift, checkDuplicateUnits, checkStaleDecks,
  checkEmptyPortals, checkAppointmentsNoOutcome, checkStuckMessages,
  checkBrokenAutomationLinks, checkBookingInviteTargets, checkOptoutStillScheduled,
  checkLeadsNoContact, checkStuckRefining, checkDeckRuleBloat, checkFloorplanCoverage,
  checkDirtyPhones, checkFurnitureData, checkProjectBasics,
]

// ── Morgenbericht in Alltagssprache ─────────────────────────────────────────
function buildReport(fixed: Finding[], open: Finding[], datum: string, dryRun: boolean): { subject: string; html: string } {
  const li = (f: Finding) => `
    <tr><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">
      <strong style="color:#111827;">${f.entity_label || ''}</strong><br>
      ${f.what_plain}
      ${f.fix_plain ? `<br><span style="color:#6b7280;">→ ${f.fix_plain}</span>` : ''}
    </td></tr>`
  const total = fixed.length + open.length
  const subject = dryRun
    ? (total ? `Systemcheck ${datum}: ${total} Dinge gefunden (Beobachtungsmodus)` : `Systemcheck ${datum}: alles in Ordnung`)
    : open.length
      ? `Systemcheck ${datum}: ${fixed.length} automatisch behoben, ${open.length} zur Ansicht`
      : `Systemcheck ${datum}: alles in Ordnung${fixed.length ? ` (${fixed.length} automatisch behoben)` : ''}`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;">
    <p style="font-size:15px;">Guten Morgen Sven,</p>
    <p style="font-size:15px;">hier der nächtliche Systemcheck (Daten, Verlinkungen, Automatiken und hängende Vorgänge) vom ${datum}.</p>
    ${dryRun ? `<p style="font-size:13px;color:#6b7280;background:#f3f4f6;border-radius:10px;padding:10px 12px;">ℹ️ Ich laufe noch im <strong>Beobachtungsmodus</strong>: Ich verändere nichts von allein, sondern zeige dir nur, was mir auffällt. Sobald du mir grünes Licht gibst, behebe ich die eindeutigen Dinge selbst.</p>` : ''}
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
  // Sicherheits-Default: Beobachtungsmodus. Nur ein EXPLIZITES dry_run:false schärft
  // die Auto-Fixes scharf (Svens Go). Fehlt das Flag, wird NICHTS verändert.
  const dryRun = body.dry_run !== false
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

  // Morgenmail geht IMMER raus (auch im Beobachtungsmodus) — Sven will jeden Morgen
  // sehen, was gefunden wurde. Im dry_run steht alles unter „ansehen", nichts verändert.
  if (notify) {
    const datum = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
    const { subject, html } = buildReport(fixed, open, datum, dryRun)
    await sb.functions.invoke('send-email', {
      body: { to: Deno.env.get('HEALTH_REPORT_TO') ?? 'sven@happy-property.com', subject, html },
    }).catch((e: unknown) => console.warn('[nightly-health] Mail:', e))
  }

  return json({ success: true, run_id: runId, dry_run: dryRun, gefunden: all.length, repariert: fixed.length, offen: open.length, fehler })
})
