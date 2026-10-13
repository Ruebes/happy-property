import { channelBadgeFor, type ChannelBadge } from './crmTypes'

// ── Herkunft von Anmeldungen (Newsletter, Immobilienguide, Masterclass) ───────
// Die Edge Functions subscriber-optin + masterclass-register schreiben seit
// 14.10.2026 je Anmeldung den Kanal nach newsletter_subscribers.properties
// (herkunft + herkunft_log, siehe supabase/functions/_shared/herkunft.ts).
// Ältere Einträge haben das nicht: Klaviyo-Import → „Klaviyo-Import", die
// Guide-Seite trug den Kanal schon im source-Text (website-guide:<kanal>/…),
// alles andere → „Vor der Erfassung".
// ACHTUNG: properties.channel ist der Zustell-Kanal (email/whatsapp/both).

export interface HerkunftLog {
  liste_id: string | null; liste: string; kanal: string; via: string; at: string; bestaetigt?: string
}
export interface SubHerkunftQuelle {
  source: string | null
  klaviyo_id: string | null
  created_at?: string | null
  properties: Record<string, unknown> | null
}

const GRAU: Omit<ChannelBadge, 'label' | 'icon'> = {
  badge: { backgroundColor: '#f1f5f9', color: '#475569' },
  card: 'bg-slate-50 border-slate-300 ring-1 ring-slate-200',
  pill: '#64748b',
}
const EXTRA: Record<string, { label: string; icon: string }> = {
  direkt:    { label: 'Direkt / unbekannt', icon: '↗' },
  website:   { label: 'Eigene Website', icon: '🌐' },
  email:     { label: 'E-Mail-Programm', icon: '✉' },
  suche:     { label: 'Suchmaschine', icon: '🔎' },
  ki:        { label: 'KI-Chat (ChatGPT & Co.)', icon: '✦' },
  whatsapp:  { label: 'WhatsApp', icon: '💬' },
  x:         { label: 'X (Twitter)', icon: '𝕏' },
  klaviyo:   { label: 'Klaviyo-Import', icon: '⇩' },
  alt:       { label: 'Vor der Erfassung', icon: '·' },
}

export function herkunftBadge(kanal: string): ChannelBadge {
  const extra = EXTRA[kanal]
  if (extra) return { ...GRAU, ...extra }
  const b = channelBadgeFor(kanal)
  if (!b) return { ...GRAU, label: kanal, icon: '🔗' }
  // Instagram und Facebook laufen als META zusammen; die Plattform trotzdem zeigen.
  if (kanal === 'instagram' || kanal === 'facebook') return { ...b, label: `${b.label} · ${kanal === 'instagram' ? 'Instagram' : 'Facebook'}` }
  return b
}

// Gruppen-Schlüssel für Auswertungen: Instagram + Facebook = META (wie bei den Terminen).
export function herkunftGruppe(kanal: string): string {
  return kanal === 'instagram' || kanal === 'facebook' || kanal === 'ig' || kanal === 'fb' ? 'meta' : kanal
}

function ausAltemSource(source: string | null, klaviyoId: string | null): string {
  const s = (source ?? '').trim()
  if (klaviyoId || s.startsWith('klaviyo')) return 'klaviyo'
  const nachDoppelpunkt = s.includes(':') ? s.split(':')[1].split('/')[0].trim().toLowerCase() : ''
  return nachDoppelpunkt || 'alt'
}

const logVon = (p: Record<string, unknown> | null): HerkunftLog[] =>
  (Array.isArray(p?.herkunft_log) ? p!.herkunft_log : []) as HerkunftLog[]

/** Kanal einer Person — für eine bestimmte Liste (Anmeldung dazu), sonst die erste Herkunft. */
export function herkunftFuer(sub: SubHerkunftQuelle, listId?: string): string {
  const log = logVon(sub.properties)
  if (listId) {
    const e = [...log].reverse().find(x => x.liste_id === listId)
    if (e?.kanal) return e.kanal
  }
  const h = sub.properties?.herkunft as { kanal?: string } | undefined
  if (h?.kanal) return h.kanal
  if (log[0]?.kanal) return log[0].kanal
  return ausAltemSource(sub.source, sub.klaviyo_id)
}

/** Formular, über das die Anmeldung kam (aus dem source-Text bzw. der Liste). */
export function formularVon(source: string | null, liste?: string | null): string {
  const s = (source ?? '').split(':')[0].trim().toLowerCase()
  const l = (liste ?? '').toLowerCase()
  if (/guide/.test(l) || s === 'website-guide') return 'Immobilienguide'
  if (/masterclass|webinar/.test(l) || s === 'masterclass') return 'Masterclass'
  if (/^newsletter$/.test(l) || s === 'website-newsletter') return 'Newsletter'
  if (liste) return liste
  return s === 'signup' ? 'Anmelde-Link' : 'Sonstige'
}

export interface Anmeldung {
  subId: string
  name: string
  email: string | null
  formular: string
  kanal: string
  at: string
  bestaetigt: boolean
}

/** Alle einzelnen Anmeldungen ab `seit` (eine Person kann mehrere haben: Newsletter + Guide). */
export function anmeldungenAus(
  subs: Array<SubHerkunftQuelle & { id: string; email: string | null; first_name: string | null; last_name: string | null }>,
  seit: Date | null,
): Anmeldung[] {
  const out: Anmeldung[] = []
  for (const s of subs) {
    const name = [s.first_name, s.last_name].filter(Boolean).join(' ') || s.email || '–'
    const log = logVon(s.properties)
    if (log.length) {
      for (const e of log) {
        if (seit && new Date(e.at) < seit) continue
        out.push({ subId: s.id, name, email: s.email, formular: formularVon(s.source, e.liste), kanal: e.kanal, at: e.at, bestaetigt: !!e.bestaetigt })
      }
      continue
    }
    // Alt-Eintrag ohne Log: eine Anmeldung zum Anlege-Zeitpunkt.
    if (s.klaviyo_id || !s.created_at || (seit && new Date(s.created_at) < seit)) continue
    out.push({
      subId: s.id, name, email: s.email, formular: formularVon(s.source), kanal: herkunftFuer(s), at: s.created_at,
      bestaetigt: s.properties?.doi_confirmed === true,
    })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}
