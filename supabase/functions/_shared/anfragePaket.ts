// Anstoß für anfrage-paket aus den Eingängen (WhatsApp: waInbound, Mail: imap-poll).
// Sven 13.10.26: Fragt ein Kunde nach Infos zu einer Wohnung, liegt das Paket
// (Deck, Rechnungen, Mail/WhatsApp-Text) fertig im Postausgang. Ob es wirklich eine
// Anfrage zu einer bestimmten Wohnung ist, entscheidet anfrage-paket (KI + Kandidaten
// aus den Decks des Kunden). Hier nur ein billiger Vorfilter, damit „ok"/„danke"
// keinen KI-Aufruf kosten. Läuft im Hintergrund und darf den Eingang nie stören.

const INFO_HINT = /info|unterlag|expos|grundriss|detail|preis|kosten|zahlungsplan|rechnung|berechnung|rendite|interess|zuschick|schick|send|wohnung|apartment|objekt|einheit|verf[üu]gbar|noch frei|\b[a-z]?-?\d{2,3}[a-z]?\b/i

export function koennteAnfrageSein(text: string): boolean {
  const t = text.trim()
  return t.length >= 6 && INFO_HINT.test(t)
}

/** Nur die neue Nachricht: zitierte Vorgänger („> …", „Am … schrieb", „On … wrote") weg. */
export function ohneZitat(text: string): string {
  const cut = text.search(/^(-{2,}\s*Original|Am .{3,80}schrieb|On .{3,80}wrote|Von:\s|From:\s)/im)
  const neu = cut > 0 ? text.slice(0, cut) : text
  return neu.split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim()
}

export async function anfragePaketAnstossen(leadId: string, text: string, quelle: 'whatsapp' | 'mail', tag: string): Promise<void> {
  if (!koennteAnfrageSein(text)) return
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const p = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/anfrage-paket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${svc}`, apikey: svc, 'Content-Type': 'application/json' },
    body: JSON.stringify({ quelle, lead_id: leadId, text: text.slice(0, 3000) }),
  }).then(r => r.text()).catch(e => console.warn(`[${tag}] anfrage-paket:`, e))
  const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
  if (er) er.waitUntil(p); else await p
}
