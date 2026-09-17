// Alarm-Mail an Sven, wenn TimelinesAI das Absender-Handy nicht mehr kennt
// (404 "Whatsapp account not found"). Am 14.9.2026 war das Konto anderthalb Tage
// abgemeldet und niemand hat es gemerkt - 9 WhatsApps blieben liegen, darunter
// Terminbestätigungen. Der Zustand ist nur im TimelinesAI-Dashboard sichtbar,
// deshalb: einmal Mail beim ersten Fehler, dann frühestens nach ALERT_COOLDOWN_H
// erneut (der Scheduler versucht alle 30 Minuten - ohne Bremse kämen 48 Mails),
// und eine Entwarnung, sobald wieder etwas rausgeht.
//
// Merker liegt in crm_settings (key WA_ALERT_KEY, value = ISO-Zeit der letzten
// Alarm-Mail; leer = aktuell kein Alarm offen).

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const WA_ALERT_KEY   = 'wa_account_alert_sent_at'
const ALERT_COOLDOWN_H      = 6
const ALERT_TO              = 'sven@happy-property.com'

type Sb = SupabaseClient

async function readMarker(sb: Sb): Promise<string> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', WA_ALERT_KEY).maybeSingle()
  return (data as { value?: string | null } | null)?.value ?? ''
}

async function writeMarker(sb: Sb, value: string): Promise<void> {
  await sb.from('crm_settings').upsert({ key: WA_ALERT_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
}

async function mail(sb: Sb, subject: string, html: string): Promise<void> {
  const { error } = await sb.functions.invoke('send-email', { body: { to: ALERT_TO, subject, html } })
  if (error) throw error
}

const zeit = (d = new Date()) =>
  d.toLocaleString('de-DE', { timeZone: 'Europe/Nicosia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

// Seit 17.9.2026 gibt es zwei Versandwege (crm_settings.wa_provider): TimelinesAI
// oder die Evolution API auf dem eigenen Server. Die Anleitung zum Neuverbinden
// unterscheidet sich (QR-Code bei TimelinesAI, Pairing-Code bei Evolution).
export type WaProviderName = 'timelines' | 'evolution'

function fixSteps(provider: WaProviderName, sender: string): string {
  if (provider === 'evolution') return `
    <p>Der eigene WhatsApp-Server (wa.happy-property.com) hat die Verbindung zur Nummer <b>${sender}</b> verloren.</p>
    <p><b>So behebst du es:</b></p>
    <ol>
      <li>Im CRM unter <b>Einstellungen → Connectoren</b> bei „WhatsApp (eigener Server)" auf <b>„Neu verbinden"</b> klicken. Es erscheint ein 8-stelliger Code.</li>
      <li>Auf dem Handy WhatsApp öffnen: Einstellungen, „Verknüpfte Geräte", „Gerät hinzufügen", dann <b>„Stattdessen mit Telefonnummer verknüpfen"</b>.</li>
      <li>Den Code eingeben. Läuft er ab, im CRM einfach einen neuen holen.</li>
    </ol>`
  return `
    <p>TimelinesAI kennt das WhatsApp-Konto <b>${sender}</b> gerade nicht mehr. Das Handy ist in TimelinesAI abgemeldet.</p>
    <p><b>So behebst du es:</b></p>
    <ol>
      <li><a href="https://app.timelines.ai/">app.timelines.ai</a> öffnen, in der Kontenliste auf die Nummer ${sender} klicken. Es erscheint ein QR-Code.</li>
      <li>Auf dem Handy WhatsApp öffnen: Einstellungen, „Verknüpfte Geräte", „Gerät hinzufügen".</li>
      <li>QR-Code scannen, bis der Status auf grün „Verbunden" springt.</li>
    </ol>`
}

/** Absender-Konto nicht gefunden: Alarm-Mail, wenn keine offen oder Cooldown vorbei. */
export async function waAccountGone(sb: Sb, sender: string, detail: string, provider: WaProviderName = 'timelines'): Promise<'mailed' | 'cooldown'> {
  const last = await readMarker(sb)
  if (last && Date.now() - new Date(last).getTime() < ALERT_COOLDOWN_H * 3600_000) return 'cooldown'
  const wo = provider === 'evolution' ? 'auf dem eigenen Server' : 'in TimelinesAI'
  const html = `
    <p>Hallo Sven,</p>
    ${fixSteps(provider, sender)}
    <p>Solange die Nummer getrennt ist (Meldung: <code>${detail}</code>), geht <b>keine WhatsApp</b> raus und es kommt keine rein.</p>
    <p>Nichts weiter tun: liegengebliebene WhatsApps aus der Automatik gehen danach von selbst raus
       (der Planer versucht es 24 Stunden lang alle 30 Minuten). Du bekommst eine Entwarnung, sobald wieder etwas rausging.</p>
    <p>Diese Mail kommt frühestens in ${ALERT_COOLDOWN_H} Stunden erneut, falls das Konto dann immer noch getrennt ist.</p>
    <p style="color:#888">Erkannt am ${zeit()} (Zypern-Zeit).</p>`
  await mail(sb, `⚠️ WhatsApp getrennt: ${sender} ist ${wo} nicht mehr verbunden`, html)
  await writeMarker(sb, new Date().toISOString())
  return 'mailed'
}

/** Versand wieder erfolgreich: offenen Alarm schließen und Entwarnung schicken. */
export async function waAccountRecovered(sb: Sb, sender: string, provider: WaProviderName = 'timelines'): Promise<'mailed' | 'noop'> {
  const last = await readMarker(sb)
  if (!last) return 'noop'
  await writeMarker(sb, '')
  const wo = provider === 'evolution' ? 'auf dem eigenen Server' : 'in TimelinesAI'
  const html = `
    <p>Hallo Sven,</p>
    <p>Entwarnung: das WhatsApp-Konto <b>${sender}</b> ist ${wo} wieder verbunden,
       um ${zeit()} (Zypern-Zeit) ging die erste WhatsApp wieder raus.</p>
    <p>Getrennt war es seit dem Alarm vom ${zeit(new Date(last))}. Nachrichten aus der Automatik,
       die in dieser Zeit liegengeblieben sind, holt der Planer jetzt von selbst nach.</p>`
  await mail(sb, `✅ WhatsApp wieder verbunden: ${sender}`, html)
  return 'mailed'
}
