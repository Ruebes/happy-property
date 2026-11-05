// Bremse für automatische WhatsApp-Wellen (Sven, 5.11.2026: „Das sollten wir nicht
// wieder machen").
//
// Anlass: 49 fast gleiche Masterclass-Einladungen in 73 Minuten an Kontakte ohne
// bisherigen Chat, danach war die Nummer 24 Stunden gesperrt. Eine Sperre trifft das
// ganze Tagesgeschäft, auch Terminbestätigungen.
//
// Gilt für alle Zeilen in scheduled_messages mit event_type newsletter (Kampagnen,
// Einladungen, Listen-Sequenzen, Masterclass-Erinnerungen). Terminnachrichten, Nachfass
// und Einzelgespräche bleiben frei. Gezählt werden Empfänger, nicht Nachrichten: die
// weiteren Teile einer mehrteiligen Nachricht (wa_part ab 1) zählen nicht extra.
//
// Ist das Limit erreicht, entscheidet process-scheduled-messages: Mail statt WhatsApp,
// wenn eine zustellbare Adresse da ist, sonst später nochmal.
//
// Tageslimit ändern oder Not-Aus (0 = gar keine WhatsApp-Wellen):
//   crm_settings, key wa_wellen_limit_tag
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const WA_LIMIT_LAUF = 2     // je Scheduler-Lauf (alle 5 Minuten)
export const WA_LIMIT_STUNDE = 12  // je 60 Minuten
export const WA_LIMIT_TAG = 20     // je 24 Stunden
export const WA_LIMIT_SETTING = 'wa_wellen_limit_tag'

export type WaLimitGrund = 'lauf' | 'stunde' | 'tag'
export interface WaLimitStand { lauf: number; stunde: number; tag: number; limitTag: number }

export function waLimitGrund(s: WaLimitStand): WaLimitGrund | null {
  if (s.tag >= s.limitTag) return 'tag'
  if (s.stunde >= WA_LIMIT_STUNDE) return 'stunde'
  if (s.lauf >= WA_LIMIT_LAUF) return 'lauf'
  return null
}

// Wann eine Nachricht ohne Mail-Ersatz wieder dran ist. 4 Minuten = nächster Lauf.
// Der Teil-Versatz hält mehrteilige Nachrichten in ihrer Reihenfolge.
const WARTEN_MIN: Record<WaLimitGrund, number> = { lauf: 4, stunde: 15, tag: 180 }
export function waLimitNochmal(grund: WaLimitGrund, teil: number | null | undefined, jetzt = Date.now()): Date {
  return new Date(jetzt + WARTEN_MIN[grund] * 60_000 + (teil ?? 0) * 1000)
}

// Wert aus crm_settings. Leer oder unlesbar = Standard, 0 = Not-Aus.
export function limitTagAus(wert: unknown): number {
  if (wert === null || wert === undefined || String(wert).trim() === '') return WA_LIMIT_TAG
  const n = Number(wert)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : WA_LIMIT_TAG
}

// Stand aus der Datenbank. Bei einem Lesefehler gilt das Limit als erreicht:
// lieber eine Mail statt einer WhatsApp als eine Welle ohne Bremse.
export async function ladeWaLimitStand(sb: SupabaseClient): Promise<WaLimitStand> {
  const { data: s } = await sb.from('crm_settings').select('value').eq('key', WA_LIMIT_SETTING).maybeSingle()
  const limitTag = limitTagAus((s as { value?: unknown } | null)?.value)
  const zaehle = (stunden: number) => sb.from('scheduled_messages').select('id', { count: 'exact', head: true })
    .eq('event_type', 'newsletter').in('type', ['whatsapp', 'both']).eq('status', 'sent')
    .not('whatsapp_text', 'is', null).is('error_message', null).or('wa_part.is.null,wa_part.eq.0')
    .gte('sent_at', new Date(Date.now() - stunden * 3_600_000).toISOString())
  const [h, t] = await Promise.all([zaehle(1), zaehle(24)])
  if (h.error || t.error) {
    console.warn('[waLimit] Stand nicht lesbar:', (h.error ?? t.error)?.message)
    return { lauf: 0, stunde: 0, tag: Infinity, limitTag }
  }
  return { lauf: 0, stunde: h.count ?? 0, tag: t.count ?? 0, limitTag }
}
