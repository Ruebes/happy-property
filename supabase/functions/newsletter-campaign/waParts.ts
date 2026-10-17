// Newsletter-WhatsApp als mehrere Nachrichten (Sven 17.10.26): "eine mit dem
// Content, eine mit der Immo der Woche und eine mit der Empfehlung". Jede
// Nachricht ist eine eigene scheduled_messages-Zeile mit eigenem Bild.
//
// whatsapp_body trennt die Nachrichten mit einer Zeile, die nur aus --- besteht.
// newsletter_campaigns.whatsapp_images = Bild-URL je Nachricht (Index = Teil).
// scheduled_messages.wa_part = Nummer des Teils (0, 1, 2 ...).
//
// Reine String-Logik ohne Imports, damit sie sich lokal mit node pruefen laesst.
// Der Editor (src/lib/htmlDerive.ts splitWhatsappParts) trennt mit derselben Regel.

// Svens Portraet: Bild jeder Nachricht ohne eigenes Bild und ohne Exposé-Link.
// Ohne Bild haengt process-scheduled-messages (alsLotte bei recipient 'client')
// ein Lotte-Hundefoto an, und das wirkt unter Svens Gruss falsch.
export const SVEN_WA_IMAGE = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/render/image/public/deck-assets/brand/1781605724861-pczb70gulqa.jpg?width=900&height=900&resize=cover&quality=80'
// = TEXT_LIMIT in send-whatsapp. Laengere Teile teilt send-whatsapp selbst, dann
// werden aus einem Teil zwei Nachrichten (mit Bild schon ab 950 Zeichen).
export const WA_PART_LIMIT = 1900
// Abstand der Teile: claim_scheduled_messages sortiert nach scheduled_at und der
// Scheduler arbeitet der Reihe nach, so gehen alle Teile im selben Lauf in
// Reihenfolge raus.
export const WA_PART_STEP_MS = 1000

const TRENNER = /^[ \t]*-{3,}[ \t]*$/m

export function splitWaParts(body: string | null | undefined): string[] {
  return String(body ?? '').replace(/\r\n?/g, '\n').split(TRENNER).map(p => p.trim()).filter(Boolean)
}

// Tippgeber-Block in die letzte Nachricht: bei mehreren an deren Anfang (danach
// folgen Bitte um die Mailadresse, Gruss und Abmeldelink), bei nur einer vor den
// Absatz mit dem Abmeldelink statt dahinter.
export function withAffiliateBlock(parts: string[], block: string, unsubUrl: string): string[] {
  if (!parts.length) return [block]
  const out = [...parts]
  const last = out.length - 1
  if (out.length > 1) { out[last] = `${block}\n\n${out[last]}`; return out }
  const text = out[last]
  const i = text.indexOf(unsubUrl)
  if (i < 0) { out[last] = `${text}\n\n${block}`; return out }
  const absatz = text.lastIndexOf('\n\n', i)
  out[last] = absatz < 0 ? `${block}\n\n${text}` : `${text.slice(0, absatz)}\n\n${block}${text.slice(absatz)}`
  return out
}

// Bild eines Teils: eigenes Bild aus whatsapp_images, sonst das Titelbild des
// Exposés, auf das der Teil verlinkt, sonst Svens Portraet. Nie leer.
export function ownImage(explicit: unknown): string | null {
  const u = typeof explicit === 'string' ? explicit.trim() : ''
  return /^https:\/\/\S+$/i.test(u) ? u : null
}
export function partImage(explicit: unknown, deckCover: string | null | undefined): string {
  return ownImage(explicit) ?? (deckCover || SVEN_WA_IMAGE)
}

export function deckTokenIn(text: string): string | null {
  return text.match(/\/deck\/([A-Za-z0-9_-]{6,})/)?.[1] ?? null
}

// ── rebuild_pending: vorhandene WhatsApp-Zeilen eines Empfaengers den neuen
// Teilen zuordnen, ohne etwas doppelt zu planen ─────────────────────────────
export interface WaRow { id: string; status: string; scheduled_at: string; wa_part: number | null }
export interface WaPlan {
  update: Array<{ id: string; part: number; at?: string }>
  cancel: string[]
  insert: Array<{ part: number; at: string }>
}
// Index eines Teils = wa_part; aeltere Zeilen ohne (Kampagne 27e51afb wurde von
// Hand geteilt) zaehlen in der Reihenfolge von scheduled_at. Stornierte und
// uebersprungene Zeilen zaehlen nicht mit.
// Wartet noch alles: Zeilen bekommen den neuen Text, fehlende Teile kommen dazu,
// ueberzaehlige werden storniert, und alle stehen danach im Sekundenabstand ab
// dem fruehesten Termin. Ist schon etwas raus (oder gescheitert), werden nur
// noch wartende Zeilen mit ihrem Teil neu befuellt; nachgeschoben wird nichts,
// sonst kaemen Teile ohne Zusammenhang hinterher.
export function planWaRebuild(rows: WaRow[], parts: number): WaPlan {
  const plan: WaPlan = { update: [], cancel: [], insert: [] }
  const live = rows.filter(r => r.status !== 'cancelled' && r.status !== 'skipped')
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at) || a.id.localeCompare(b.id))
  if (!live.length) return plan
  const allNumbered = live.every(r => r.wa_part !== null && r.wa_part !== undefined)
  const idx = (r: WaRow, pos: number) => allNumbered ? Number(r.wa_part) : pos
  const allPending = live.every(r => r.status === 'pending')
  const taken = new Set<number>()
  if (allPending) {
    const base = Date.parse(live[0].scheduled_at)
    const at = (p: number) => new Date(base + p * WA_PART_STEP_MS).toISOString()
    live.forEach((r, pos) => {
      const p = idx(r, pos)
      if (p >= parts || taken.has(p)) { plan.cancel.push(r.id); return }
      taken.add(p)
      plan.update.push({ id: r.id, part: p, at: at(p) })
    })
    for (let p = 0; p < parts; p++) if (!taken.has(p)) plan.insert.push({ part: p, at: at(p) })
    return plan
  }
  live.forEach((r, pos) => {
    const p = idx(r, pos)
    if (r.status !== 'pending') { taken.add(p); return }
    if (p >= parts || taken.has(p)) { plan.cancel.push(r.id); return }
    taken.add(p)
    plan.update.push({ id: r.id, part: p })
  })
  return plan
}
