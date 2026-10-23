// WhatsApp-Anruf aus dem CRM (Sven 23.10.26): Auf dem Mac geht der Knopf an die
// App „HP Gesprächsnotiz" (URL-Schema hpcall://). Die App öffnet den WhatsApp-Chat,
// zeichnet den Call auf, schreibt die Abschrift lokal und schickt nur den Text ans
// CRM (zoom-calls, Aktion upload). Überall sonst bleibt es beim wa.me-Link.

export function isMacDesktop(): boolean {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false
  return /Macintosh/.test(navigator.userAgent) && !('ontouchend' in document)
}

export interface CallCtx {
  leadId?: string | null
  appointmentId?: string | null
  name?: string | null
  language?: string | null
}

export function waCallHref(digits: string, ctx: CallCtx = {}): string {
  if (!isMacDesktop()) return `https://wa.me/${digits}`
  const q = new URLSearchParams({ phone: digits })
  if (ctx.leadId) q.set('lead', ctx.leadId)
  if (ctx.appointmentId) q.set('appt', ctx.appointmentId)
  if (ctx.name) q.set('name', ctx.name)
  if (ctx.language) q.set('lang', ctx.language)
  return `hpcall://whatsapp?${q.toString()}`
}

/** hpcall:// darf nicht in einem neuen Tab aufgehen (bliebe leer stehen). */
export function waCallTarget(href: string): { target?: string; rel?: string } {
  return href.startsWith('hpcall:') ? {} : { target: '_blank', rel: 'noreferrer' }
}
