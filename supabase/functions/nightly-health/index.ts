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
// ── Zugriff (Sicherheits-Audit 30.9.2026) ──
//   pg_cron mit Header x-cron-secret (Wert zur LAUFZEIT per Subquery aus
//   connector_secrets, key CRON_SECRET), System-Aufrufe mit dem Service-Key oder
//   ein eingeloggter Admin. Vorher konnte jeder ohne Login dry_run:false setzen.
//   Reihenfolge beim Umstellen: erst den Cron-Job um x-cron-secret ergänzen,
//   dann diese Version deployen.
//
// ── Deployment ──
//   supabase functions deploy nightly-health --no-verify-jwt
//
// ── Secrets ──
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (Standard)
//   HEALTH_REPORT_TO = Empfänger des Morgenberichts (Standard: sven@happy-property.com)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getWaProvider, evoConnectionState } from '../_shared/waProvider.ts'
import { authorizeCaller, safeEqual } from '../_shared/callerAuth.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
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
      .select('id, unit_number, project_id, block, size_sqm, price_gross, project:crm_projects(name)')
    const seen = new Map<string, Array<Record<string, unknown>>>()
    for (const u of (units ?? []) as Array<Record<string, unknown>>) {
      // Baugebiet/Block gehoert zum Schluessel: Developer wie Motive Point (Venara)
      // fuehren mehrere Gebiete mit je eigener Nummer 1..n - "Villa 1" in DIAMOND
      // und "Villa 1" in SEA CAVES sind ZWEI Wohnungen, keine Dublette. Genau so
      // kommen die Daten vom Developer (Sven 22.8.), der Check meldete das
      // faelschlich jede Nacht als Fehler.
      const key = `${u.project_id}|${String(u.block ?? '').toLowerCase().trim()}|${String(u.unit_number ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key)!.push(u)
    }
    const out: Finding[] = []
    for (const [, list] of seen) {
      if (list.length < 2) continue
      const proj = (list[0].project as { name?: string } | null)?.name ?? '?'
      const blk  = String(list[0].block ?? '').trim()
      const num  = `${list[0].unit_number}${blk ? ` (${blk})` : ''}`
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
      // Eingeladene Mit-Eigentuemer besitzen keine eigene Wohnung, sehen aber eine
      // fremde — sie sind kein Fehlerfall.
      const { count: mitCount } = await sb.from('property_co_owners')
        .select('id', { count: 'exact', head: true }).eq('profile_id', o.id as string)
      if ((mitCount ?? 0) > 0) continue
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

// ── Prüfung 6b: Nachricht ist endgültig fehlgeschlagen ──────────────────────
// Ein Fehlschlag stoppt weder die anderen Kanäle noch die anderen Nachrichten —
// deshalb sieht ihn hinterher niemand mehr, sobald die Live-Meldung im Pipeline-
// Fenster weg ist. Diese Prüfung holt ihn in den Morgenbericht.
const checkFailedMessages: Check = {
  key: 'nachricht_fehlgeschlagen',
  title: 'Nachricht konnte nicht zugestellt werden',
  run: async (sb) => {
    const grenze = new Date(Date.now() - 24 * 3600e3).toISOString()
    const { data: msgs } = await sb.from('scheduled_messages')
      .select('id, type, event_type, recipient, error_message, sent_at, lead:leads(first_name, last_name)')
      .eq('status', 'failed').gte('sent_at', grenze).limit(50)
    return ((msgs ?? []) as Array<Record<string, unknown>>).map(m => {
      const err   = String(m.error_message ?? '')
      const l     = m.lead as { first_name?: string; last_name?: string } | null
      const name  = `${l?.first_name ?? ''} ${l?.last_name ?? ''}`.trim()
      const rec   = String(m.recipient ?? 'client')
      const anWen = rec === 'client' ? (name || 'den Kunden')
        : rec === 'unit_developer' ? 'den Bauträger'
        : rec.startsWith('vw:') ? 'die Verwaltung' : 'einen Partner'
      // Welche Kanäle sind wirklich gescheitert? Der Fehlertext trägt das Präfix
      // 'email:' bzw. 'whatsapp:' je Kanal — bei type='both' ging der andere raus.
      const mailWeg = err.includes('email:')
      const waWeg   = err.includes('whatsapp:')
      const kanal   = mailWeg && waWeg ? 'E-Mail und WhatsApp'
        : mailWeg ? 'Die E-Mail' : waWeg ? 'Die WhatsApp' : 'Die Nachricht'
      const rest    = m.type === 'both' && (mailWeg !== waWeg)
        ? ` ${mailWeg ? 'Die WhatsApp' : 'Die E-Mail'} ist raus.` : ''
      return {
        check_key: 'nachricht_fehlgeschlagen', severity: 'hoch' as const,
        entity_kind: 'nachricht', entity_id: String(m.id), entity_label: name || String(m.event_type ?? ''),
        what_plain: `${kanal} an ${anWen} („${m.event_type}") kam nicht an: ${plainSendError(err)}.${rest}`,
        action: 'proposed' as const,
        fix_plain: mailWeg && /556|550|does not accept mail|no such user|unknown|invalid/i.test(err)
          ? 'Sieht nach einer falschen E-Mail-Adresse aus — Adresse im Lead prüfen und korrigieren, dann die Nachricht neu auslösen.'
          : 'Sag Bescheid, dann schicke ich sie erneut raus.',
      }
    })
  },
}

// SMTP-/API-Fehlertexte in einen Satz übersetzen, den man ohne Technikwissen versteht.
function plainSendError(err: string): string {
  if (/does not accept mail|invalid DNS|MX/i.test(err))       return 'die E-Mail-Adresse gibt es so nicht (die Domain nimmt gar keine Mails an)'
  if (/no such user|550|recipient (address )?rejected/i.test(err)) return 'das Postfach existiert nicht'
  if (/mailbox full|quota/i.test(err))                        return 'das Postfach des Empfängers ist voll'
  if (/spam|blocked|blacklist/i.test(err))                    return 'der Empfänger-Server hat die Mail als Werbung abgewiesen'
  if (/kein Empfänger/i.test(err))                            return 'es ist gar keine Adresse hinterlegt'
  if (/kein Telefon/i.test(err))                              return 'es ist keine Telefonnummer hinterlegt'
  if (/timeout|ETIMEDOUT|network|fetch failed/i.test(err))    return 'die Verbindung zum Versand-Dienst hat nicht geklappt'
  return err.slice(0, 160)
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

// ── Pruefung 17: Lage/Bautraeger in Kundendokumenten ────────────────────────
// Lage und Bautraeger sind KOPIEN im Dokument. Wird das Projekt erst nach dem
// Erstellen gepflegt, zeigt die Kundenseite einen Strich (Fall Mamba, 18.8.).
// Der Nachtlauf zieht die Luecken selbst aus dem Projekt nach - still, jede Nacht.
const checkCalcItemBasics: Check = {
  key: 'rechnung_stammdaten',
  title: 'Berechnungen ohne Lage/Bautraeger nachgezogen',
  run: async (sb, dryRun) => {
    const out: Finding[] = []
    const { data: projs } = await sb.from('crm_projects').select('name, developer, location')
    const byName = new Map((projs ?? []).map((p: { name: string; developer: string | null; location: string | null }) => [p.name, p]))
    const { data: calcs } = await sb.from('property_calculations').select('token, title, content').order('created_at', { ascending: false }).limit(400)
    for (const c of (calcs ?? []) as Array<{ token: string; title: string | null; content: { items?: Array<Record<string, unknown>> } | null }>) {
      const items = c.content?.items ?? []
      let changed = false
      for (const it of items) {
        const pr = byName.get(String(it.project ?? '')) as { developer: string | null; location: string | null } | undefined
        if (!pr) continue
        if (!it.location && pr.location) { it.location = pr.location; changed = true }
        if (!it.developer && pr.developer) { it.developer = pr.developer; changed = true }
      }
      if (!changed) continue
      if (!dryRun) await sb.from('property_calculations').update({ content: c.content }).eq('token', c.token)
      out.push({
        check_key: 'rechnung_stammdaten', severity: 'niedrig', entity_kind: 'rechnung', entity_id: c.token, entity_label: String(c.title ?? c.token),
        what_plain: `In "${c.title ?? c.token}" fehlten Lage oder Bautraeger, obwohl das Projekt sie inzwischen kennt.`,
        action: dryRun ? 'proposed' : 'fixed',
        fix_plain: 'Aus dem Projekt nachgetragen - der Kundenlink zeigt die Daten jetzt an.',
      })
    }
    return out
  },
}

// ── Pruefung 17: Zeitplan-Jobs, die still scheitern ─────────────────────────
// hp-partner-akte lief tagelang bei JEDEM Start auf einen Fehler (kaputte
// Anfuehrungszeichen im Job-Kommando) - 1008 Fehllaeufe, ohne dass es irgendwo
// auftauchte (Sven 22.8.). Diese Pruefung meldet jeden Job, dessen letzte
// Laeufe mehrheitlich scheitern.
const checkCronHealth: Check = {
  key: 'zeitplan_kaputt',
  title: 'Automatischer Zeitplan-Job scheitert',
  run: async (sb) => {
    const out: Finding[] = []
    const { data } = await sb.rpc('health_cron_failures')
    for (const r of ((data ?? []) as Array<{ jobname: string; fails: number; total: number; last_error: string | null }>)) {
      if (r.fails === 0 || r.total === 0) continue
      if (r.fails / r.total < 0.5) continue          // vereinzelte Wackler nicht melden
      out.push({
        check_key: 'zeitplan_kaputt', severity: 'kritisch', entity_kind: 'system', entity_id: r.jobname, entity_label: r.jobname,
        what_plain: `Der Zeitplan-Job "${r.jobname}" ist in den letzten 24 Stunden ${r.fails} von ${r.total} Mal gescheitert. Was er erledigen soll, bleibt seitdem liegen. Letzter Fehler: ${(r.last_error ?? '?').slice(0, 160)}`,
        action: 'proposed',
        fix_plain: 'Job-Kommando pruefen (haeufigste Ursache: kaputte Anfuehrungszeichen beim Anlegen - mit Dollar-Quoting neu planen).',
      })
    }
    return out
  },
}

// ── Pruefung 18: WhatsApp-Kontingent ────────────────────────────────────────
// TimelinesAI zaehlt JEDE per API gesendete Nachricht gegen ein Monatslimit
// (aktueller Tarif: 50 verschiedene Empfaenger). Ist es alle, scheitert jeder
// automatische Versand still - Sven merkte es erst, als eine Antwort an eine
// Kundin nicht rausging (24.8.).
const checkWaQuota: Check = {
  key: 'whatsapp_kontingent',
  title: 'WhatsApp-Monatskontingent fast aufgebraucht',
  run: async (sb) => {
    // Nur bei TimelinesAI relevant - der eigene Server hat kein Monatskontingent.
    if ((await getWaProvider(sb)) === 'evolution') return []
    const monatsStart = new Date(); monatsStart.setDate(1); monatsStart.setHours(0, 0, 0, 0)
    const { data } = await sb.from('wa_sent').select('phone').gt('sent_at', monatsStart.toISOString())
    const distinct = new Set(((data ?? []) as Array<{ phone: string }>).map(r => r.phone)).size
    const LIMIT = 50
    if (distinct < LIMIT * 0.8) return []
    const { count: wartend } = await sb.from('scheduled_messages')
      .select('id', { count: 'exact', head: true }).eq('status', 'pending').in('type', ['whatsapp', 'both'])
    return [{
      check_key: 'whatsapp_kontingent', severity: distinct >= LIMIT ? 'kritisch' : 'mittel',
      entity_kind: 'system', entity_id: 'timelines_quota', entity_label: 'WhatsApp-Versand',
      what_plain: distinct >= LIMIT
        ? `Das WhatsApp-Monatskontingent ist aufgebraucht (${distinct} von ${LIMIT} Empfaengern). Es geht KEINE automatische WhatsApp mehr raus - aktuell warten ${wartend ?? 0} Nachrichten.`
        : `Vom WhatsApp-Monatskontingent sind ${distinct} von ${LIMIT} Empfaengern verbraucht. Bei diesem Tempo ist es vor Monatsende alle.`,
      action: 'proposed',
      fix_plain: 'Tarif bei TimelinesAI hochstufen (app.timelines.ai/account/subscription) - oder bis zum Monatswechsel warten, dann setzt das Kontingent zurueck.',
    }]
  },
}

// ── Pruefung 19: eigener WhatsApp-Server verbunden? ─────────────────────────
// Seit 17.9.2026 laeuft WhatsApp ueber die Evolution API auf hp-server. Reisst die
// Verbindung zum Handy ab (Baileys-Protokoll, passiert gelegentlich), geht still
// nichts mehr raus und rein. Deshalb jeden Morgen den Live-Status abfragen.
const checkWaConnection: Check = {
  key: 'whatsapp_verbindung',
  title: 'WhatsApp-Nummer auf dem eigenen Server nicht verbunden',
  run: async (sb) => {
    if ((await getWaProvider(sb)) !== 'evolution') return []
    const st = await evoConnectionState()
    if (st === 'open') return []
    const { count: wartend } = await sb.from('scheduled_messages')
      .select('id', { count: 'exact', head: true }).eq('status', 'pending').in('type', ['whatsapp', 'both'])
    return [{
      check_key: 'whatsapp_verbindung', severity: 'kritisch',
      entity_kind: 'system', entity_id: 'evolution_connection', entity_label: 'WhatsApp-Versand',
      what_plain: st === 'unknown'
        ? 'Der eigene WhatsApp-Server (wa.happy-property.com) antwortet nicht. Solange geht KEINE WhatsApp raus und keine kommt rein.'
        : `Die WhatsApp-Nummer ist auf dem eigenen Server nicht verbunden (Status: ${st}). Es geht KEINE WhatsApp raus und keine kommt rein - aktuell warten ${wartend ?? 0} Nachrichten.`,
      action: 'proposed',
      fix_plain: st === 'unknown'
        ? 'Server pruefen (Coolify → evolution-api laeuft?). Bis dahin im CRM unter Einstellungen → Connectoren auf TimelinesAI zurueckschalten.'
        : 'Im CRM unter Einstellungen → Connectoren bei „WhatsApp (eigener Server)" auf „Neu verbinden" klicken und den Code am Handy eingeben (WhatsApp → Verknüpfte Geräte → Gerät hinzufügen → mit Telefonnummer verknüpfen).',
    }]
  },
}

// ── Pruefung 20: Werbung (Meta) - Daten, Freigaben, Pixel ───────────────────
// Werbemanager + Autopilot (Okt 2026) brauchen frische Zahlen, eine fertige
// Nachtkette und saubere Zuordnung. Faellt davon etwas aus, entscheidet der
// Autopilot blind oder gar nicht, und niemand merkt es (Ausfall 01.10.: alle
// Nacht-Jobs "job startup timeout", erst der Folgelauf fuellte die Daten).
// Jede Abfrage ist tolerant: fehlt eine Tabelle oder Spalte (Migration noch
// nicht eingespielt), entfaellt nur dieser Teil.
const WERBE_PIXEL_ID = '1083578343946189'   // Pixel, das /termin und die Landing Pages feuern
const WERBE_LINK = 'https://portal.happy-property.com/admin/crm/ads'
const AUTOPILOT_LINK = 'https://portal.happy-property.com/admin/crm/ads?tab=autopilot'
const META_QUELLEN = ['meta', 'facebook', 'fb', 'instagram', 'ig']
const KETTE: Array<[string, string]> = [['sync', 'Abgleich mit Meta'], ['qualitaet', 'Qualitätsrechnung'], ['regeln', 'Regelprüfung']]

type Zeile = Record<string, unknown>
const stunden = (iso: unknown): number => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? (Date.now() - t) / 36e5 : Infinity
}
const utcDatum = (d: Date) => d.toISOString().slice(0, 10)
const berlinDatum = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const euro = (v: number) => `${Math.round(v).toLocaleString('de-DE')} €`
const kurz = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t }

// Einstellungen des Werbemanagers (eine Zeile). '*', damit fehlende neue Spalten nicht stören.
async function werbeEinstellungen(sb: Sb): Promise<Zeile | null> {
  try {
    const { data, error } = await sb.from('ad_settings').select('*').eq('id', 'default').maybeSingle()
    return error ? null : ((data ?? null) as Zeile | null)
  } catch { return null }
}

const checkWerbungDaten: Check = {
  key: 'werbung_daten',
  title: 'Werbung: Daten, Prüfung und Pixel',
  run: async (sb) => {
    const out: Finding[] = []
    const fund = (id: string, severity: Finding['severity'], what: string, fix: string) => out.push({
      check_key: 'werbung_daten', severity, entity_kind: 'system', entity_id: id, entity_label: 'Werbung (Meta)',
      what_plain: what, action: 'proposed', fix_plain: fix,
    })
    const settings = await werbeEinstellungen(sb)

    // 1. Abgleich mit Meta älter als 30 Stunden? Ist der Katalog frisch, läuft der
    //    Abgleich und Meta hat nur nichts ausgeliefert: dann kein Alarm.
    try {
      const { data: ins, error } = await sb.from('ad_insights_daily').select('synced_at').order('synced_at', { ascending: false }).limit(1)
      const insH = error ? -1 : stunden((ins as Zeile[] | null)?.[0]?.synced_at)
      if (insH > 30) {
        const { data: kat, error: katErr } = await sb.from('ad_catalog').select('updated_at').order('updated_at', { ascending: false }).limit(1)
        const katH = katErr ? Infinity : stunden((kat as Zeile[] | null)?.[0]?.updated_at)
        if (katH > 30 && Number.isFinite(insH)) {
          fund('werbe_sync', 'hoch',
            `Der Abgleich mit Meta ist seit ${Math.round(insH)} Stunden nicht gelaufen. Werbemanager und Autopilot arbeiten mit alten Zahlen.`,
            'Im Werbemanager oben "Jetzt abgleichen" klicken. Kommt ein Fehler, ist meist der Meta-Zugang (Token) abgelaufen.')
        }
      }
    } catch { /* Tabelle fehlt: kein Befund */ }

    // 2. Nachtkette (Abgleich -> Qualität -> Regeln) bis 05:30 UTC fertig? Nur prüfen,
    //    wenn die Kette überhaupt schon läuft (Einträge der letzten 7 Tage).
    try {
      const jetzt = new Date()
      const frist = Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate(), 5, 30)
      const soll = utcDatum(jetzt.getTime() >= frist ? jetzt : new Date(jetzt.getTime() - 864e5))
      const { data: runs, error } = await sb.from('ad_autopilot_runs').select('lauf_datum, schritt, status, fehler')
        .gte('lauf_datum', utcDatum(new Date(jetzt.getTime() - 7 * 864e5))).order('lauf_datum', { ascending: false }).limit(80)
      const rows = (error ? [] : (runs ?? [])) as Zeile[]
      if (rows.length) {
        const amTag = rows.filter(r => String(r.lauf_datum) === soll)
        const offen = KETTE.filter(([s]) => !['fertig', 'uebersprungen'].includes(String(amTag.find(r => r.schritt === s)?.status ?? '')))
        if (offen.length) {
          const fehler = amTag.map(r => r.fehler).find(f => typeof f === 'string' && f.trim())
          fund('werbe_kette', 'hoch',
            `Die nächtliche Werbe-Auswertung vom ${soll} ist nicht fertig geworden (offen: ${offen.map(([, l]) => l).join(', ')}).${fehler ? ` Letzter Fehler: ${kurz(fehler, 160)}` : ''} Bis dahin gibt es keine neuen Vorschläge.`,
            'Läuft der Nachholer (04:50 UTC) auch nicht durch, Claude den Fehler aus dieser Mail geben.')
        }
      }
    } catch { /* Tabelle fehlt */ }

    // 3. Conversions-API: Fehler in den letzten 24 Stunden, mit Echtzeit auch Stau.
    try {
      const seit = new Date(Date.now() - 24 * 36e5).toISOString()
      const { data: fe, error } = await sb.from('capi_outbox').select('event_name, fehler').eq('status', 'fehler').gte('updated_at', seit).limit(200)
      const fehlerRows = (error ? [] : (fe ?? [])) as Zeile[]
      if (fehlerRows.length) {
        fund('werbe_capi', 'mittel',
          `${fehlerRows.length} Rückmeldungen an Meta (Conversions-API) sind in den letzten 24 Stunden gescheitert. Meta lernt dann nicht, welche Anzeigen gute Termine bringen. Beispiel: ${kurz(fehlerRows[0].fehler ?? fehlerRows[0].event_name, 140)}`,
          'Claude den Fehlertext geben. Häufig: Meta-Zugang abgelaufen oder ein Ereignis älter als 7 Tage.')
      }
      if (!error && settings?.capi_echtzeit === true) {
        const { data: st, error: stErr } = await sb.from('capi_outbox').select('id').eq('status', 'offen')
          .lt('created_at', new Date(Date.now() - 2 * 36e5).toISOString()).gte('created_at', new Date(Date.now() - 7 * 864e5).toISOString()).limit(200)
        const stau = (stErr ? [] : (st ?? [])) as Zeile[]
        if (stau.length) {
          fund('werbe_capi_stau', 'mittel',
            `${stau.length} Rückmeldungen an Meta warten seit über 2 Stunden auf den Versand, obwohl Echtzeit eingeschaltet ist.`,
            'Echtzeit-Versand prüfen (werbe-signal). Der Tageslauf holt Termine nach, Lead-Ereignisse aber nicht.')
        }
      }
    } catch { /* Tabelle fehlt */ }

    // 4. Zuordnungsquote Lead -> Anzeige (Konto, 14 Tage, sonst 30/7) unter 80 %?
    try {
      const { data: q, error } = await sb.from('ad_quality_daily').select('stichtag, fenster, attribution_coverage, leads')
        .eq('entity_level', 'account').in('fenster', [7, 14, 30]).order('stichtag', { ascending: false }).limit(9)
      const rows = (error ? [] : (q ?? [])) as Zeile[]
      const neuester = rows[0]?.stichtag
      const zeile = [14, 30, 7].map(f => rows.find(r => r.stichtag === neuester && Number(r.fenster) === f && r.attribution_coverage != null)).find(Boolean)
      const cov = zeile ? Number(zeile.attribution_coverage) : NaN
      if (zeile && Number.isFinite(cov) && cov < 0.8 && Number(zeile.leads ?? 0) > 0) {
        fund('werbe_zuordnung', 'mittel',
          `Nur ${Math.round(cov * 100)} % der Meta-Leads (${zeile.fenster} Tage) lassen sich einer Anzeige zuordnen, Ziel sind mindestens 80 %. Kill-Regeln macht der Autopilot deshalb nur als Vorschlag.`,
          'Bei den betroffenen Anzeigen die URL-Parameter auf den Standard setzen (Werbemanager, Anzeige bearbeiten) - oder Giona bitten.')
      }
    } catch { /* Tabelle fehlt */ }

    // 5. Abgelehnte oder eingeschränkte Anzeigen, die eigentlich laufen sollen.
    try {
      const { data: ads, error } = await sb.from('ad_catalog').select('ad_id, ad_name, campaign_id, campaign_name, status, effective_status')
        .in('effective_status', ['DISAPPROVED', 'WITH_ISSUES']).limit(50)
      let rows = ((error ? [] : (ads ?? [])) as Zeile[]).filter(a => String(a.status ?? '').toUpperCase() === 'ACTIVE')
      const kampagnen = [...new Set(rows.map(a => String(a.campaign_id ?? '')).filter(Boolean))]
      if (rows.length && kampagnen.length) {
        const { data: ks, error: kErr } = await sb.from('meta_campaigns').select('campaign_id, status').in('campaign_id', kampagnen)
        if (!kErr) {
          const aus = new Set(((ks ?? []) as Zeile[]).filter(k => k.status && String(k.status).toUpperCase() !== 'ACTIVE').map(k => String(k.campaign_id)))
          rows = rows.filter(a => !aus.has(String(a.campaign_id ?? '')))
        }
      }
      if (rows.length) {
        const abgelehnt = rows.filter(a => a.effective_status === 'DISAPPROVED').length
        const namen = rows.slice(0, 4).map(a => `"${kurz(a.ad_name ?? a.ad_id, 50)}"`).join(', ')
        fund('werbe_pruefung', 'hoch',
          `${rows.length} eingeschaltete Anzeige(n) laufen nicht oder nur eingeschränkt (${abgelehnt} abgelehnt, ${rows.length - abgelehnt} mit Problemen): ${namen}${rows.length > 4 ? ' ...' : ''}.`,
          `Im Werbemanager (${WERBE_LINK}) den Ablehnungsgrund ansehen und die Anzeige ersetzen oder pausieren.`)
      }
    } catch { /* Spalte fehlt */ }

    // 6. Aktive Anzeigengruppen, die auf ein anderes Pixel optimieren als das,
    //    das /termin füttert (Plan-B 10/2026: Pixel 987745530157374 bekommt nichts).
    try {
      const { data: sets, error } = await sb.from('meta_adsets').select('adset_id, name, promoted_object').eq('effective_status', 'ACTIVE').limit(100)
      const falsch = ((error ? [] : (sets ?? [])) as Zeile[]).filter(s => {
        const pid = String(((s.promoted_object ?? {}) as Zeile).pixel_id ?? '').trim()
        return !!pid && pid !== WERBE_PIXEL_ID
      })
      if (falsch.length) {
        const pixel = String(((falsch[0].promoted_object ?? {}) as Zeile).pixel_id ?? '')
        fund('werbe_pixel', 'hoch',
          `${falsch.length} aktive Anzeigengruppe(n) optimieren auf das Pixel ${pixel}, der Termin-Funnel meldet aber an ${WERBE_PIXEL_ID}: ${falsch.slice(0, 3).map(s => `"${kurz(s.name ?? s.adset_id, 50)}"`).join(', ')}. Meta lernt dort nichts über Leads und Termine.`,
          'Mit Giona klären, welches Pixel gilt. Umstellen startet die Lernphase neu, deshalb an einem Montag oder Donnerstag.')
      }
    } catch { /* Tabelle fehlt */ }

    // 7. Vorrat an freigegebenen Werbemitteln (nur, wenn der Vorrat schon benutzt wird).
    try {
      const { data: pool, error } = await sb.from('ad_creative_pool').select('status').limit(1000)
      const rows = (error ? [] : (pool ?? [])) as Zeile[]
      const frei = rows.filter(p => p.status === 'freigegeben').length
      if (rows.length && frei < 4) {
        fund('werbe_vorrat', 'niedrig',
          `Im Vorrat liegen nur ${frei} freigegebene Werbemittel (Ziel mindestens 4). Ermüdet eine Anzeige, hat der Autopilot nichts zum Nachschieben.`,
          `Im Werbemanager unter Werbemittel (${WERBE_LINK}?tab=werbemittel) Entwürfe prüfen und freigeben.`)
      }
    } catch { /* Tabelle fehlt */ }

    // Autopilot vom System gestoppt? (werbe_autopilot_stopp setzt Modus 'aus' + Grund)
    if (settings && settings.autopilot_mode === 'aus' && typeof settings.autopilot_stop_grund === 'string' && settings.autopilot_stop_grund.trim()) {
      fund('werbe_autopilot_stopp', 'mittel',
        `Der Werbe-Autopilot ist gestoppt: ${kurz(settings.autopilot_stop_grund, 160)}`,
        `Grund prüfen und den Autopilot im Werbemanager (${AUTOPILOT_LINK}) wieder einschalten (nur Admin).`)
    }
    return out
  },
}

// ── Werbe-Block für die Morgenmail (max. 8 Zeilen) ──────────────────────────
interface WerbeZeile { text: string; link?: string }

async function buildWerbeBlock(sb: Sb, probleme: Finding[] = []): Promise<WerbeZeile[]> {
  const zeilen: WerbeZeile[] = []
  const settings = await werbeEinstellungen(sb)
  const ziel = Number(settings?.target_cpte_eur ?? 145) || 145

  // Ausgaben gestern / 7 Tage (spend_eur ist schon in EUR umgerechnet)
  let spend7: number | null = null
  try {
    const gestern = berlinDatum(new Date(Date.now() - 864e5))
    const ab = berlinDatum(new Date(Date.now() - 7 * 864e5))
    const { data, error } = await sb.from('ad_insights_daily').select('day, spend_eur').gte('day', ab).lte('day', gestern).limit(5000)
    if (!error) {
      const rows = (data ?? []) as Zeile[]
      spend7 = rows.reduce((s, r) => s + (Number(r.spend_eur) || 0), 0)
      const g = rows.filter(r => String(r.day) === gestern).reduce((s, r) => s + (Number(r.spend_eur) || 0), 0)
      zeilen.push({ text: `Ausgaben gestern: ${euro(g)}, letzte 7 Tage: ${euro(spend7)}` })
    }
  } catch { /* ohne Zahlen keine Zeile */ }

  // Termine + Kosten je Termin-Äquivalent (Konto, 7 Tage) aus der Qualitätsrechnung,
  // sonst Termine von Meta-Leads direkt aus dem Kalender.
  let terminZeile = false
  try {
    const { data, error } = await sb.from('ad_quality_daily').select('stichtag, spend_eur, booked, te_capped')
      .eq('entity_level', 'account').eq('fenster', 7).order('stichtag', { ascending: false }).limit(1)
    const q = (error ? null : ((data ?? []) as Zeile[])[0]) ?? null
    if (q) {
      const te = Number(q.te_capped) || 0
      const cpte = te > 0 ? Number(q.spend_eur) / te : null
      zeilen.push({ text: `Termine aus Meta (7 Tage): ${Number(q.booked) || 0}, Kosten je Termin-Äquivalent: ${cpte != null ? euro(cpte) : 'noch keins'} (Ziel ${euro(ziel)})` })
      terminZeile = true
    }
  } catch { /* Tabelle fehlt */ }
  if (!terminZeile) {
    try {
      const { data, error } = await sb.from('crm_appointments').select('id, leads!inner(utm_source)')
        .eq('internal', false).gte('created_at', new Date(Date.now() - 7 * 864e5).toISOString())
        .in('leads.utm_source', META_QUELLEN).limit(500)
      if (!error) {
        const n = ((data ?? []) as Zeile[]).length
        zeilen.push({ text: `Termine aus Meta (7 Tage): ${n}${n && spend7 != null ? `, Kosten je Termin: ${euro(spend7 / n)} (Ziel je Termin-Äquivalent ${euro(ziel)})` : ''}` })
      }
    } catch { /* ohne Zahl keine Zeile */ }
  }

  // Offene Vorschläge des Autopiloten
  let vorschlaege = 0
  try {
    const { data, error } = await sb.from('ad_actions').select('id, gruppe_id, expires_at')
      .eq('freigabe', 'vorgeschlagen').is('status', null).limit(500)
    if (!error) {
      const jetzt = Date.now()
      const gueltig = ((data ?? []) as Zeile[]).filter(r => !r.expires_at || Date.parse(String(r.expires_at)) > jetzt)
      vorschlaege = new Set(gueltig.map(r => String(r.gruppe_id ?? r.id))).size
      zeilen.push(vorschlaege
        ? { text: `Offene Vorschläge des Autopiloten: ${vorschlaege}`, link: AUTOPILOT_LINK }
        : { text: 'Offene Vorschläge des Autopiloten: keine' })
    }
  } catch { /* Spalten fehlen */ }

  // Probleme (aus Prüfung 20) und was Sven tun muss
  if (probleme.length) {
    zeilen.push({ text: `Probleme: ${probleme.length} (Details unten). Wichtigstes: ${kurz(probleme[0].what_plain, 140)}` })
  } else if (zeilen.length) {
    zeilen.push({ text: 'Probleme: keine' })
  }
  const tun: string[] = []
  if (vorschlaege) tun.push('Vorschläge prüfen und freigeben oder ablehnen')
  if (probleme[0]?.fix_plain) tun.push(kurz(probleme[0].fix_plain, 140))
  if (zeilen.length) zeilen.push({ text: `Für dich zu tun: ${tun.length ? tun.join('; ') : 'nichts'}`, link: vorschlaege ? AUTOPILOT_LINK : undefined })
  return zeilen.slice(0, 8)
}

const CHECKS: Check[] = [
  checkPropertyDrift, checkDuplicateUnits, checkStaleDecks,
  checkEmptyPortals, checkAppointmentsNoOutcome, checkStuckMessages, checkFailedMessages,
  checkBrokenAutomationLinks, checkBookingInviteTargets, checkOptoutStillScheduled,
  checkLeadsNoContact, checkStuckRefining, checkDeckRuleBloat, checkFloorplanCoverage,
  checkDirtyPhones, checkFurnitureData, checkProjectBasics, checkCalcItemBasics,
  // Pruefung 18 war bis 17.9.2026 definiert, aber nie registriert.
  checkWaQuota, checkWaConnection,
  // Pruefung 17 (Zeitplan-Jobs) war ebenfalls definiert, aber nie registriert (Okt 2026).
  checkCronHealth, checkWerbungDaten,
]

// ── Morgenbericht in Alltagssprache ─────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function buildReport(fixed: Finding[], open: Finding[], datum: string, dryRun: boolean, werbe: WerbeZeile[] = []): { subject: string; html: string } {
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
    ${werbe.length ? `
      <h3 style="font-size:16px;color:#111827;margin:24px 0 8px;">Werbung (Meta)</h3>
      <table style="width:100%;border-collapse:collapse;background:#f6f8fc;border-radius:10px;">${werbe.map(z => `
        <tr><td style="padding:8px 12px;border-bottom:1px solid #eef0f4;font-size:14px;color:#374151;">${esc(z.text)}${z.link ? ` <a href="${esc(z.link)}" style="color:#ff795d;">ansehen</a>` : ''}</td></tr>`).join('')}</table>` : ''}
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

  // Aufrufer prüfen, bevor health_runs geschrieben oder etwas repariert wird.
  // apikey == Service-Key zählt als System-Aufruf: supabase-js schickt einen
  // sb_secret-Key bei functions.invoke nur noch als apikey, nicht als Bearer.
  if (!safeEqual(req.headers.get('apikey') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) {
    const caller = await authorizeCaller(req, { cron: true, service: true, roles: ['admin'] }, CORS)
    if (caller instanceof Response) return caller
  }

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
    // Werbe-Block: Kennzahlen + Probleme aus Prüfung 20. Darf die Mail nie verhindern.
    let werbe: WerbeZeile[] = []
    try { werbe = await buildWerbeBlock(sb, all.filter(f => f.check_key === 'werbung_daten')) }
    catch (e) { console.warn('[nightly-health] Werbe-Block:', e) }
    const { subject, html } = buildReport(fixed, open, datum, dryRun, werbe)
    await sb.functions.invoke('send-email', {
      body: { to: Deno.env.get('HEALTH_REPORT_TO') ?? 'sven@happy-property.com', subject, html },
    }).catch((e: unknown) => console.warn('[nightly-health] Mail:', e))
  }

  return json({ success: true, run_id: runId, dry_run: dryRun, gefunden: all.length, repariert: fixed.length, offen: open.length, fehler })
})
