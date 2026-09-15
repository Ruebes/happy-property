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

/** Absender-Konto nicht gefunden: Alarm-Mail, wenn keine offen oder Cooldown vorbei. */
export async function waAccountGone(sb: Sb, sender: string, detail: string): Promise<'mailed' | 'cooldown'> {
  const last = await readMarker(sb)
  if (last && Date.now() - new Date(last).getTime() < ALERT_COOLDOWN_H * 3600_000) return 'cooldown'
  const html = `
    <p>Hallo Sven,</p>
    <p>TimelinesAI kennt das WhatsApp-Konto <b>${sender}</b> gerade nicht mehr
       (Antwort: <code>${detail}</code>). Das Handy ist in TimelinesAI abgemeldet.
       Solange das so ist, geht <b>keine WhatsApp</b> raus und es kommt keine rein.</p>
    <p><b>So behebst du es:</b></p>
    <ol>
      <li><a href="https://app.timelines.ai/">app.timelines.ai</a> öffnen, in der Kontenliste auf die Nummer ${sender} klicken. Es erscheint ein QR-Code.</li>
      <li>Auf dem Handy WhatsApp öffnen: Einstellungen, „Verknüpfte Geräte“, „Gerät hinzufügen“.</li>
      <li>QR-Code scannen, bis der Status auf grün „Verbunden“ springt.</li>
    </ol>
    <p>Nichts weiter tun: liegengebliebene WhatsApps aus der Automatik gehen danach von selbst raus
       (der Planer versucht es 24 Stunden lang alle 30 Minuten). Du bekommst eine Entwarnung, sobald wieder etwas rausging.</p>
    <p>Diese Mail kommt frühestens in ${ALERT_COOLDOWN_H} Stunden erneut, falls das Konto dann immer noch getrennt ist.</p>
    <p style="color:#888">Erkannt am ${zeit()} (Zypern-Zeit) durch send-whatsapp.</p>`
  await mail(sb, `⚠️ WhatsApp getrennt: TimelinesAI kennt ${sender} nicht mehr`, html)
  await writeMarker(sb, new Date().toISOString())
  return 'mailed'
}

/** Versand wieder erfolgreich: offenen Alarm schließen und Entwarnung schicken. */
export async function waAccountRecovered(sb: Sb, sender: string): Promise<'mailed' | 'noop'> {
  const last = await readMarker(sb)
  if (!last) return 'noop'
  await writeMarker(sb, '')
  const html = `
    <p>Hallo Sven,</p>
    <p>Entwarnung: das WhatsApp-Konto <b>${sender}</b> ist in TimelinesAI wieder verbunden,
       um ${zeit()} (Zypern-Zeit) ging die erste WhatsApp wieder raus.</p>
    <p>Getrennt war es seit dem Alarm vom ${zeit(new Date(last))}. Nachrichten aus der Automatik,
       die in dieser Zeit liegengeblieben sind, holt der Planer jetzt von selbst nach.</p>`
  await mail(sb, `✅ WhatsApp wieder verbunden: ${sender}`, html)
  return 'mailed'
}
